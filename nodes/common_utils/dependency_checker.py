"""
GJJ 节点依赖检查工具

提供统一的依赖检查和错误提示机制，确保即使缺少依赖也不会导致整个节点包无法注册。

使用方法：
    from .common_utils.dependency_checker import check_dependencies, create_fallback_node, print_runtime_dependency_error

    # 在模块顶部检查依赖（启动时）
    DEPS_OK, DEPS_ERROR = check_dependencies(
        required_packages=["soundfile", "transformers"],
        node_name="GJJ_FishAudioS2Generator"
    )

    # 如果依赖缺失，创建 fallback 节点
    if not DEPS_OK:
        class GJJ_FishAudioS2Generator:
            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {}}

            RETURN_TYPES = ()
            FUNCTION = "error_handler"
            CATEGORY = "GJJ/Audio"
            DESCRIPTION = DEPS_ERROR

            def error_handler(self):
                raise RuntimeError(DEPS_ERROR)
    else:
        # 正常的节点实现
        class GJJ_FishAudioS2Generator:
            ...

    # 运行时依赖检查（执行节点时）
    def some_function():
        try:
            import some_module
        except ImportError as exc:
            from .common_utils.dependency_checker import get_pip_install_command_text
            install_cmd = get_pip_install_command_text("some_module")

            # 打印美观的控制台错误提示
            print_runtime_dependency_error(
                node_name="我的节点",
                dependency_name="some_module",
                install_command=install_cmd,
                description="该节点需要 some_module 才能运行",
                extra_info=f"原始导入错误：{exc}"
            )

            # 抛出简洁的错误信息（在前端显示）
            raise RuntimeError("运行时依赖缺失：some_module。详细信息请查看控制台。") from exc
"""

import sys
import traceback
from typing import List, Tuple, Optional


def check_dependencies(
    required_packages: List[str],
    node_name: str,
    optional_packages: Optional[List[str]] = None
) -> Tuple[bool, str]:
    """
    检查节点所需的依赖是否已安装。

    Args:
        required_packages: 必需的 Python 包列表
        node_name: 节点名称（用于错误提示）
        optional_packages: 可选的 Python 包列表（缺失时只警告，不阻止）

    Returns:
        (是否所有必需依赖都已安装, 错误信息或成功消息)
    """
    missing_required = []
    missing_optional = []

    # 检查必需依赖
    for package in required_packages:
        if not _is_package_installed(package):
            missing_required.append(package)

    # 检查可选依赖
    if optional_packages:
        for package in optional_packages:
            if not _is_package_installed(package):
                missing_optional.append(package)

    # 生成错误信息
    if missing_required:
        error_msg = _generate_error_message(node_name, missing_required, missing_optional)
        return False, error_msg

    # 生成警告信息（如果有可选依赖缺失）
    if missing_optional:
        warning_msg = _generate_warning_message(node_name, missing_optional)
        print(warning_msg)

    return True, f"✅ {node_name} 依赖检查通过"


def _is_package_installed(package_name: str) -> bool:
    """
    检查 Python 包是否已安装。

    Args:
        package_name: 包名（可以是导入名，如 "PIL" 对应 "pillow"）

    Returns:
        是否已安装
    """
    try:
        __import__(package_name)
        return True
    except ImportError:
        return False
    except Exception:
        # 其他异常也视为未安装
        return False


def _generate_error_message(
    node_name: str,
    missing_required: List[str],
    missing_optional: List[str]
) -> str:
    """
    生成友好的错误提示信息。

    Args:
        node_name: 节点名称
        missing_required: 缺失的必需依赖列表
        missing_optional: 缺失的可选依赖列表

    Returns:
        格式化的错误信息
    """
    lines = [
        f"❌ 节点 {node_name} 缺少必需的 Python 依赖：",
        "",
    ]

    # 列出缺失的必需依赖
    lines.append("📦 必需依赖（请安装）：")
    for pkg in missing_required:
        lines.append(f"  • {pkg}")

    # 提供安装命令建议
    lines.append("")
    lines.append("🔧 安装命令：")
    install_cmd =f"{sys.executable} -m pip install {missing_required} -i https://pypi.tuna.tsinghua.edu.cn/simple"
    lines.append(f"  {install_cmd}")

    # 如果有可选依赖缺失，也列出
    if missing_optional:
        lines.append("")
        lines.append("⚠️ 可选依赖（建议安装以获得完整功能）：")
        for pkg in missing_optional:
            lines.append(f"  • {pkg}")
        lines.append("")
        lines.append("  可选依赖安装命令：")
        install_cmd =f"{sys.executable} -m pip install {missing_optional} -i https://pypi.tuna.tsinghua.edu.cn/simple"
        lines.append(f"  {install_cmd}")

    lines.append("")
    lines.append("💡 提示：安装后请重启 ComfyUI 服务器。")

    return "\n".join(lines)


def _generate_warning_message(
    node_name: str,
    missing_optional: List[str]
) -> str:
    """
    生成可选依赖缺失的警告信息。

    Args:
        node_name: 节点名称
        missing_optional: 缺失的可选依赖列表

    Returns:
        格式化的警告信息
    """
    lines = [
        f"⚠️ 节点 {node_name} 缺少部分可选依赖（仍可运行，但部分功能可能受限）：",
        "",
    ]

    for pkg in missing_optional:
        lines.append(f"  • {pkg}")

    lines.append("")
    lines.append("  如需完整功能，请安装：")
    install_cmd =f"{sys.executable} -m pip install {missing_optional} -i https://pypi.tuna.tsinghua.edu.cn/simple"
    lines.append(f"  {install_cmd}")
    lines.append("")

    return "\n".join(lines)


def create_fallback_node_class(
    node_name: str,
    error_message: str,
    category: str = "GJJ/Disabled"
):
    """
    创建一个 fallback 节点类，用于在依赖缺失时占位。

    Args:
        node_name: 节点类名
        error_message: 显示的错误信息
        category: 节点分类

    Returns:
        fallback 节点类
    """
    class FallbackNode:
        DESCRIPTION = error_message

        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    "错误提示": ("STRING", {
                        "default": "该节点因缺少依赖而被禁用",
                        "multiline": True,
                        "readonly": True,
                    })
                }
            }

        RETURN_TYPES = ()
        FUNCTION = "error_handler"
        CATEGORY = category

        def error_handler(self, **kwargs):
            raise RuntimeError(error_message)

    # 设置类名
    FallbackNode.__name__ = node_name
    FallbackNode.__qualname__ = node_name

    return FallbackNode


def safe_import_with_fallback(
    module_name: str,
    node_name: str,
    required_packages: List[str],
    category: str = "GJJ/Disabled"
):
    """
    安全导入模块，如果失败则返回 fallback 节点。

    Args:
        module_name: 要导入的模块名
        node_name: 节点类名
        required_packages: 必需的依赖包列表
        category: fallback 节点的分类

    Returns:
        (节点类, 是否成功导入)
    """
    deps_ok, message = check_dependencies(required_packages, node_name)

    if not deps_ok:
        fallback_class = create_fallback_node_class(node_name, message, category)
        return fallback_class, False

    try:
        module = __import__(module_name, fromlist=[''])
        # 假设模块中有一个与模块名同名的类
        class_name = module_name.split('.')[-1]
        node_class = getattr(module, class_name, None)
        if node_class is None:
            # 尝试获取模块中的第一个类
            for name in dir(module):
                obj = getattr(module, name)
                if isinstance(obj, type) and hasattr(obj, 'INPUT_TYPES'):
                    node_class = obj
                    break

        if node_class is None:
            raise ImportError(f"模块 {module_name} 中没有找到有效的节点类")

        return node_class, True
    except Exception as e:
        error_msg = f"❌ 节点 {node_name} 导入失败：\n\n{str(e)}\n\n详细错误：\n{traceback.format_exc()}"
        fallback_class = create_fallback_node_class(node_name, error_msg, category)
        return fallback_class, False


def print_runtime_dependency_error(
    node_name: str,
    dependency_name: str,
    install_command: str,
    description: str = "",
    extra_info: str = ""
):
    """
    在控制台打印美观的运行时依赖缺失错误提示（带彩色输出）。

    这是一个公用函数，所有节点在运行时遇到依赖缺失时都可以调用此函数，
    以提供统一、美观的错误提示体验。

    Args:
        node_name: 节点名称（如 "语音识别四文本TTS(Qwen3)"）
        dependency_name: 缺失的依赖名称（如 "qwen-asr"）
        install_command: 完整的安装命令（如 f"{sys.executable} -m pip install qwen-asr -i https://pypi.tuna.tsinghua.edu.cn/simple" ）
        description: 依赖说明（如 "该节点需要 qwen-asr Python 包才能运行"）
        extra_info: 额外信息（可选，如原始错误信息）

    Example:
        >>> print_runtime_dependency_error(
        ...     node_name="语音识别四文本TTS(Qwen3)",
        ...     dependency_name="qwen-asr",
        ...     install_command=f"{sys.executable} -m pip install qwen-asr -i https://pypi.tuna.tsinghua.edu.cn/simple",
        ...     description="该节点需要 qwen-asr Python 包才能运行",
        ...     extra_info=f"原始导入错误：{exc}"
        ... )
    """
    import sys

    # ANSI 颜色代码（用于控制台彩色输出）
    RED = '\033[91m'
    YELLOW = '\033[93m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    RESET = '\033[0m'
    BOLD = '\033[1m'

    # 在控制台打印美观的错误提示
    print(f"\n{RED}{'=' * 80}{RESET}")
    print(f"{RED}{BOLD}  GJJ 节点运行时依赖缺失！{RESET}")
    print(f"{RED}{'=' * 80}{RESET}")
    print(f"{YELLOW}[GJJ] {BOLD}节点:{RESET} {CYAN}{node_name}{RESET}")

    if description:
        print(f"{YELLOW}[GJJ]{RESET} {description}")

    print(f"\n{YELLOW}[GJJ] {BOLD}快速安装命令:{RESET}")
    print(f"  {GREEN}{install_command}{RESET}")

    if extra_info:
        print(f"\n{YELLOW}[GJJ] {BOLD}详细信息:{RESET}")
        print(f"  {extra_info}")

    print(f"\n{YELLOW}[GJJ] {BOLD}提示:{RESET} 安装完成后请重启 ComfyUI 服务器")
    print(f"{RED}{'=' * 80}{RESET}\n")


def load_dependency_at_runtime(
    module_name: str,
    node_name: str,
    package_name: str = None,
    description: str = "",
    extra_packages: list = None
):
    """
    在运行时加载依赖模块，失败时提供友好的错误提示。

    这是一个通用的运行时依赖加载函数，所有节点都可以使用。
    如果模块已加载，直接返回缓存；否则尝试导入，失败时提供详细的安装命令。

    Args:
        module_name: 要导入的模块名（如 "cv2", "soundfile", "insightface"）
        node_name: 节点显示名称（如 "GJJ · 人脸分析"）
        package_name: pip 包名（可选，如果与 module_name 不同，如 module_name="cv2", package_name="opencv-python"）
        description: 依赖说明（可选）
        extra_packages: 额外需要安装的包列表（可选）

    Returns:
        导入的模块对象

    Raises:
        RuntimeError: 如果依赖缺失，抛出包含详细安装命令的错误

    Example:
        >>> import sys
        >>> cv2 = load_dependency_at_runtime(
        ...     module_name="cv2",
        ...     node_name="GJJ · 人脸分析",
        ...     package_name="opencv-python",
        ...     description="该节点需要 OpenCV 进行图像处理"
        ... )
    """
    import sys
    import importlib

    # 检查缓存
    cache_key = f"_gjj_runtime_{module_name}"
    if hasattr(sys, cache_key):
        return getattr(sys, cache_key)

    try:
        # 尝试导入模块
        module = importlib.import_module(module_name)
        # 缓存成功导入的模块
        setattr(sys, cache_key, module)
        return module

    except Exception as exc:
        python_executable = sys.executable

        # 确定 pip 包名
        pip_package = package_name or module_name

        # 构建安装命令 - 使用统一的命令生成函数
        packages = [pip_package] + (extra_packages or [])
        install_cmd = get_pip_install_command_text(" ".join(packages))

        # ANSI 颜色代码
        RED = '\033[91m'
        YELLOW = '\033[93m'
        CYAN = '\033[96m'
        GREEN = '\033[92m'
        RESET = '\033[0m'
        BOLD = '\033[1m'

        # 打印美观的错误提示
        print(f"\n{RED}{'=' * 80}{RESET}")
        print(f"{RED}{BOLD}  GJJ 节点运行时依赖缺失！{RESET}")
        print(f"{RED}{'=' * 80}{RESET}")
        print(f"{YELLOW}[GJJ] {BOLD}节点:{RESET} {CYAN}{node_name}{RESET}")
        print(f"{YELLOW}[GJJ] {BOLD}缺失依赖:{RESET} {RED}{BOLD}{module_name}{RESET}")

        if description:
            print(f"{YELLOW}[GJJ]{RESET} {description}")

        print(f"\n{YELLOW}[GJJ] {BOLD}快速安装命令:{RESET}")
        print(f"{GREEN}{BOLD}  {install_cmd}{RESET}\n")
        print(f"{YELLOW}[GJJ] {BOLD}提示:{RESET} 安装后请重启 ComfyUI 服务器")
        print(f"{RED}{'=' * 80}{RESET}\n")

        # 构建详细的错误信息
        error_detail = (
            f"\n 未找到 {module_name} 运行库。\n"
            f"\n"
            f"这个 GJJ 节点需要 {module_name} Python 包才能运行。\n"
            f"\n"
            f" 必需依赖（请安装）：\n"
            f"  • {pip_package} ({description or 'Python 包'})\n"
        )

        if extra_packages:
            error_detail += "\n 其他依赖：\n"
            for pkg in extra_packages:
                error_detail += f"  • {pkg}\n"

        error_detail += (
            f"\n"
            f"🔧 快速安装命令（使用实际 Python 路径）：\n"
            f"{install_cmd}\n"
            f"\n"
            f"原始导入错误：{exc}\n"
            f"\n"
            f" 提示：安装后请重启 ComfyUI 服务器。"
        )

        raise RuntimeError(error_detail) from exc


def get_pip_install_command_text(pkg: str) -> str:
    """生成依赖安装命令文本（使用用户指定的完整Python路径和清华源）。

    这是一个公用函数，所有节点在报告依赖缺失时都可以调用此函数，
    以提供统一、完整的安装命令。

    Args:
        pkg: 依赖包名（可以是单个包名，也可以是多个包名用空格分隔）

    Returns:
        完整的 pip 安装命令文本，使用 sys.executable 的实际 Python 路径
        并添加 --target 参数安装到 Lib/site-packages 目录

    Example:
        >>> get_pip_install_command_text("imageio")
        '& "C:\\AI\\CUI77\\python.exe" -m pip install imageio -i https://pypi.tuna.tsinghua.edu.cn/simple --ignore-installed --target "C:\\AI\\CUI77\\Lib\\site-packages"'

        >>> get_pip_install_command_text("imageio imageio-ffmpeg")
        '& "C:\\AI\\CUI77\\python.exe" -m pip install imageio imageio-ffmpeg -i https://pypi.tuna.tsinghua.edu.cn/simple --ignore-installed --target "C:\\AI\\CUI77\\Lib\\site-packages"'
    """
    import os
    import sys

    python_path = sys.executable
    site_packages = os.path.join(os.path.dirname(python_path), "Lib", "site-packages")

    return f'& "{python_path}" -m pip install {pkg} -i https://pypi.tuna.tsinghua.edu.cn/simple --ignore-installed --target "{site_packages}"'


# ============================================================================
# GJJ 统一依赖 / 模型缺失提示 V2
# ============================================================================

DEFAULT_PYPI_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple"
DEFAULT_MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d"


def _normalize_package_names(packages=None, pkg: str = "") -> List[str]:
    """把字符串 / 列表 / 元组统一成去重后的 pip 包名列表。"""
    raw = []
    if packages is not None:
        if isinstance(packages, str):
            raw.extend(packages.split())
        else:
            for item in packages:
                if isinstance(item, str):
                    raw.extend(item.split())
                elif item is not None:
                    raw.append(str(item))
    if pkg:
        raw.extend(str(pkg).split())

    result = []
    seen = set()
    for item in raw:
        name = str(item).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        result.append(name)
    return result


def get_python_site_packages_target(python_executable: Optional[str] = None) -> str:
    """根据当前 Python 解释器推导目标 site-packages 目录。"""
    import os
    import site

    python_path = python_executable or sys.executable
    python_dir = os.path.dirname(python_path)

    candidates = []
    try:
        candidates.extend(site.getsitepackages())
    except Exception:
        pass
    try:
        user_site = site.getusersitepackages()
        if user_site:
            candidates.append(user_site)
    except Exception:
        pass

    for path in candidates:
        text = str(path)
        if "site-packages" in text and (
            not python_dir or text.lower().startswith(python_dir.lower())
        ):
            return text

    return os.path.join(python_dir, "Lib", "site-packages")


def get_pip_install_command_text(
    pkg: str = "",
    *,
    packages=None,
    python_executable: Optional[str] = None,
    target_dir: Optional[str] = None,
    index_url: str = DEFAULT_PYPI_INDEX_URL,
    ignore_installed: bool = True,
) -> str:
    """生成 PowerShell 可直接粘贴执行的完整 pip 安装命令。

    保持旧接口兼容：`get_pip_install_command_text("numpy einops")` 仍可用。
    新接口可传 `packages=[...]`，由公共函数统一按当前用户环境生成命令。
    """
    package_names = _normalize_package_names(packages=packages, pkg=pkg)
    package_text = " ".join(package_names)
    python_path = python_executable or sys.executable
    target = target_dir or get_python_site_packages_target(python_path)
    ignore_flag = " --ignore-installed" if ignore_installed else ""
    return (
        f'& "{python_path}" -m pip install {package_text} '
        f'-i {index_url}{ignore_flag} --target "{target}"'
    ).strip()


def _normalize_missing_dependencies(missing_dependencies=None) -> List[dict]:
    result = []
    if not missing_dependencies:
        return result
    for item in missing_dependencies:
        if isinstance(item, dict):
            module_name = str(item.get("module_name") or item.get("name") or "").strip()
            package_name = str(
                item.get("package_name") or item.get("pip_name") or module_name
            ).strip()
            display_name = str(item.get("display_name") or module_name or package_name)
            description = str(item.get("description") or "")
        else:
            module_name = str(item).strip()
            package_name = module_name
            display_name = module_name
            description = ""
        if module_name or package_name:
            result.append(
                {
                    "module_name": module_name or package_name,
                    "package_name": package_name or module_name,
                    "display_name": display_name,
                    "description": description,
                }
            )
    return result


def _normalize_missing_models(missing_models=None) -> List[dict]:
    result = []
    if not missing_models:
        return result
    for item in missing_models:
        if isinstance(item, dict):
            label = str(item.get("label") or item.get("name") or "模型").strip()
            subdir = str(item.get("subdir") or item.get("model_subdir") or "").strip()
            filename = str(item.get("filename") or item.get("file_name") or "").strip()
            download_url = str(
                item.get("download_url") or DEFAULT_MODEL_DOWNLOAD_URL
            ).strip()
            description = str(item.get("description") or "")
        else:
            label = str(item).strip() or "模型"
            subdir = ""
            filename = str(item).strip()
            download_url = DEFAULT_MODEL_DOWNLOAD_URL
            description = ""
        result.append(
            {
                "label": label,
                "subdir": subdir,
                "filename": filename,
                "download_url": download_url,
                "description": description,
            }
        )
    return result


def _format_model_path(model: dict) -> str:
    subdir = str(model.get("subdir") or "").strip().strip("/\\")
    filename = str(model.get("filename") or "").strip()
    if subdir and filename:
        return f"{subdir}/{filename}".replace("\\", "/")
    return filename or subdir or str(model.get("label") or "模型")


def _generate_warning_message(
    node_name: str = "",
    missing_optional: Optional[List[str]] = None,
    *,
    dependencies_available: Optional[bool] = None,
    models_available: Optional[bool] = None,
    missing_dependencies=None,
    missing_models=None,
    mode: str = "description",
) -> str:
    """生成 DESCRIPTION / 面板可复用的一行清晰警告。

    兼容旧调用：`_generate_warning_message(node_name, ["pkg"])`。
    """
    missing_deps = _normalize_missing_dependencies(
        missing_dependencies if missing_dependencies is not None else missing_optional
    )
    missing_model_list = _normalize_missing_models(missing_models)

    if dependencies_available is False and not missing_deps:
        missing_deps = [{"module_name": "运行依赖", "package_name": "运行依赖", "display_name": "运行依赖", "description": ""}]
    if models_available is False and not missing_model_list:
        missing_model_list = [{"label": "模型", "subdir": "", "filename": "", "download_url": DEFAULT_MODEL_DOWNLOAD_URL, "description": ""}]

    parts = []
    if missing_deps:
        if len(missing_deps) == 1:
            parts.append(f"运行依赖 {missing_deps[0]['display_name']}")
        else:
            parts.append("运行依赖")
    if missing_model_list:
        if len(missing_model_list) == 1:
            parts.append(f"模型 {missing_model_list[0]['label']}")
        else:
            parts.append("模型")

    missing_text = "、".join(parts) if parts else "运行依赖/模型"
    return f"⚠️缺失{missing_text}，点击❓按钮了解详情。"


def build_dependency_model_report(
    *,
    node_name: str = "",
    missing_dependencies=None,
    missing_models=None,
    dependency_descriptions: Optional[dict] = None,
    install_packages=None,
    description: str = "",
    original_error: str = "",
    model_download_url: str = DEFAULT_MODEL_DOWNLOAD_URL,
) -> dict:
    """构建统一的依赖 / 模型缺失报告，供控制台、面板、DESCRIPTION、GJJ_HELP 复用。"""
    missing_deps = _normalize_missing_dependencies(missing_dependencies)
    missing_model_list = _normalize_missing_models(missing_models)
    dependency_descriptions = dependency_descriptions or {}

    for dep in missing_deps:
        if not dep.get("description"):
            dep["description"] = str(
                dependency_descriptions.get(dep["module_name"])
                or dependency_descriptions.get(dep["package_name"])
                or ""
            )
    for model in missing_model_list:
        if not model.get("download_url"):
            model["download_url"] = model_download_url

    packages = _normalize_package_names(packages=install_packages)
    if not packages:
        packages = _normalize_package_names(
            packages=[dep["package_name"] for dep in missing_deps]
        )
    install_cmd = get_pip_install_command_text(packages=packages) if packages else ""

    warning = _generate_warning_message(
        node_name=node_name,
        dependencies_available=not missing_deps,
        models_available=not missing_model_list,
        missing_dependencies=missing_deps,
        missing_models=missing_model_list,
    )
    description_message = warning
    if not missing_deps and not missing_model_list:
        description_message = "✅ 运行依赖正常，模型已就绪。"

    copy_text = ""
    copy_label = ""
    if install_cmd:
        copy_text = install_cmd
        copy_label = "📋 复制安装命令"
    elif missing_model_list:
        model_urls = [model.get("download_url") or model_download_url for model in missing_model_list]
        copy_text = next((url for url in model_urls if url), "")
        copy_label = "🌏 复制下载网址"

    panel_lines = [warning]
    if description:
        panel_lines.extend(["", description])

    if missing_deps:
        panel_lines.extend(["", "📦 必需依赖（请安装）："])
        for dep in missing_deps:
            desc = f"（{dep['description']}）" if dep.get("description") else ""
            panel_lines.append(f"• {dep['package_name']} {desc}".rstrip())
        if install_cmd:
            panel_lines.extend(["", "🔧 快速安装命令：", install_cmd])

    if missing_model_list:
        panel_lines.extend(["", "🌏 模型下载："])
        urls = []
        for model in missing_model_list:
            url = model.get("download_url") or model_download_url
            if url not in urls:
                urls.append(url)
        panel_lines.extend(urls)
        panel_lines.append("")
        panel_lines.append("📁 模型文件：")
        for model in missing_model_list:
            model_path = _format_model_path(model)
            desc = f"（{model['description']}）" if model.get("description") else ""
            panel_lines.append(f"• {model['label']}：{model_path} {desc}".rstrip())

    if original_error:
        panel_lines.extend(["", f"原始导入错误：{original_error}"])
    panel_lines.extend(["", "提示：安装或放入模型后请重启 ComfyUI 服务器。"])

    help_lines = [warning]
    if missing_deps:
        help_lines.extend(["", "📦 缺失运行依赖："])
        for dep in missing_deps:
            desc = f"：{dep['description']}" if dep.get("description") else ""
            help_lines.append(f"- {dep['package_name']}{desc}")
        if install_cmd:
            help_lines.extend(["", "🔧 复制安装命令：", install_cmd])
    if missing_model_list:
        help_lines.extend(["", "🌏 模型下载："])
        for url in urls if missing_model_list else []:
            help_lines.append(url)
        help_lines.extend(["", "📁 模型放置位置："])
        for model in missing_model_list:
            help_lines.append(f"- {_format_model_path(model)}")

    return {
        "available": not missing_deps and not missing_model_list,
        "dependencies_available": not missing_deps,
        "models_available": not missing_model_list,
        "missing_dependencies": missing_deps,
        "missing_models": missing_model_list,
        "warning_message": warning,
        "description_message": description_message,
        "panel_summary_message": warning,
        "panel_message": "\n".join(panel_lines).strip(),
        "help_message": "\n".join(help_lines).strip(),
        "console_message": "\n".join(panel_lines).strip(),
        "install_cmd": install_cmd,
        "copy_text": copy_text,
        "copy_label": copy_label,
    }


def print_dependency_model_report(report: Optional[dict] = None, *, title: str = "GJJ 节点运行环境缺失！"):
    """按 GJJ 彩色控制台规范打印结构化报告。"""
    report = report or {}
    red = "\033[91m"
    yellow = "\033[93m"
    cyan = "\033[96m"
    green = "\033[92m"
    reset = "\033[0m"
    bold = "\033[1m"
    line = "=" * 90

    node_name = str(report.get("node_name") or "")
    missing_deps = report.get("missing_dependencies") or []
    missing_models = report.get("missing_models") or []

    print(f"\n{red}{line}{reset}")
    print(f"{red}{bold}  {title}{reset}")
    print(f"{red}{line}{reset}")
    if node_name:
        print(f"{yellow}[GJJ] {bold}节点:{reset} {cyan}{node_name}{reset}")

    for dep in missing_deps:
        print(f"{yellow}[GJJ] {bold}缺失依赖:{reset} {red}{bold}{dep.get('module_name') or dep.get('package_name')}{reset}")
        if dep.get("description"):
            print(f"{yellow}[GJJ]{reset} {dep['description']}")

    for model in missing_models:
        print(f"{yellow}[GJJ] {bold}缺失模型:{reset} {red}{bold}{model.get('label')}{reset}")
        print(f"{yellow}[GJJ] {bold}模型目录:{reset} {cyan}{_format_model_path(model)}{reset}")
        print(f"{yellow}[GJJ] {bold}模型下载:{reset} {green}{model.get('download_url') or DEFAULT_MODEL_DOWNLOAD_URL}{reset}")

    install_cmd = report.get("install_cmd") or ""
    if install_cmd:
        print(f"\n{yellow}[GJJ] {bold}快速安装命令:{reset}")
        print(f"  {green}{install_cmd}{reset}")

    print(f"\n{yellow}[GJJ] {bold}提示:{reset} 安装依赖或放入模型后请重启 ComfyUI 服务器")
    print(f"{red}{line}{reset}\n")


def send_dependency_model_notice(
    report: Optional[dict] = None,
    *,
    unique_id=None,
    event_name: str = "gjj_dependency_model_notice",
    extra_payload: Optional[dict] = None,
) -> bool:
    """把统一依赖 / 模型报告发送给前端通用面板。

    节点运行时捕获到 `gjj_report` 后调用本函数即可；前端会用 `panel_message`
    更新节点面板，并把 `copy_text` 绑定到复制按钮。
    """
    if unique_id is None:
        return False
    report = report or {}
    try:
        from server import PromptServer

        payload = {
            "node": str(unique_id),
            "warning_message": report.get("warning_message", ""),
            "panel_message": report.get("panel_message", ""),
            "help_message": report.get("help_message", ""),
            "install_command": report.get("install_cmd", ""),
            "copy_text": report.get("copy_text", "") or report.get("install_cmd", ""),
            "copy_label": report.get("copy_label", ""),
            "missing_dependencies": report.get("missing_dependencies", []),
            "missing_models": report.get("missing_models", []),
        }
        if extra_payload:
            payload.update(extra_payload)
        PromptServer.instance.send_sync(event_name, payload)
        return True
    except Exception:
        return False


def print_runtime_dependency_error(
    node_name: str = "",
    dependency_name: str = "",
    install_command: str = "",
    description: str = "",
    extra_info: str = "",
    **kwargs,
):
    """运行时依赖缺失彩色控制台输出，兼容旧调用并支持新结构化参数。"""
    module_name = kwargs.get("module_name") or dependency_name
    package_name = kwargs.get("package_name") or dependency_name or module_name
    package_names = kwargs.get("package_names") or kwargs.get("packages") or [package_name]
    original_error = kwargs.get("original_error") or extra_info

    report = build_dependency_model_report(
        node_name=node_name,
        missing_dependencies=[
            {
                "module_name": module_name,
                "package_name": package_name,
                "display_name": module_name,
                "description": description,
            }
        ],
        install_packages=package_names,
        original_error=str(original_error or ""),
    )
    report["node_name"] = node_name
    if install_command:
        report["install_cmd"] = install_command
        report["panel_message"] = report["panel_message"].replace(
            get_pip_install_command_text(packages=package_names), install_command
        )
    print_dependency_model_report(report, title="GJJ 节点运行时依赖缺失！")
    return report.get("install_cmd", "")


def load_dependency_at_runtime(
    module_name: str = "",
    node_name: str = "",
    package_name: str = "",
    description: str = "",
    extra_packages: Optional[list] = None,
):
    """运行时加载依赖；失败时用统一报告、彩色控制台和可复制安装命令。"""
    import importlib

    cache_key = f"_gjj_runtime_{module_name}"
    if hasattr(sys, cache_key):
        return getattr(sys, cache_key)

    try:
        module = importlib.import_module(module_name)
        setattr(sys, cache_key, module)
        return module
    except Exception as exc:
        packages = [package_name or module_name.split(".")[0]] + (extra_packages or [])
        report = build_dependency_model_report(
            node_name=node_name,
            missing_dependencies=[
                {
                    "module_name": module_name,
                    "package_name": package_name or module_name.split(".")[0],
                    "display_name": module_name,
                    "description": description,
                }
            ],
            install_packages=packages,
            original_error=str(exc),
        )
        report["node_name"] = node_name
        print_dependency_model_report(report, title="GJJ 节点运行时依赖缺失！")
        err = RuntimeError(report.get("warning_message") or report.get("panel_message") or "运行时依赖缺失。")
        setattr(err, "gjj_report", report)
        raise err from exc


def _generate_error_message(
    node_name: str,
    missing_required: List[str],
    missing_optional: List[str],
) -> str:
    """兼容旧调用的完整缺失消息，内部走统一报告格式。"""
    report = build_dependency_model_report(
        node_name=node_name,
        missing_dependencies=[{"module_name": pkg, "package_name": pkg, "display_name": pkg} for pkg in missing_required],
        missing_models=[],
        install_packages=missing_required + missing_optional,
    )
    lines = [f"❌ {node_name} 缺少必需依赖。", "", report["panel_message"]]
    return "\n".join(line for line in lines if line)


def check_dependencies(
    required_packages: List[str],
    node_name: str,
    optional_packages: Optional[List[str]] = None,
) -> Tuple[bool, str]:
    """检查节点依赖，返回统一的简洁状态文本。"""
    required_packages = _normalize_package_names(packages=required_packages)
    optional_packages = _normalize_package_names(packages=optional_packages or [])

    missing_required = [pkg for pkg in required_packages if not _is_package_installed(pkg)]
    missing_optional = [pkg for pkg in optional_packages if not _is_package_installed(pkg)]

    if missing_required:
        report = build_dependency_model_report(
            node_name=node_name,
            missing_dependencies=[
                {
                    "module_name": pkg,
                    "package_name": pkg,
                    "display_name": pkg,
                }
                for pkg in missing_required
            ],
            install_packages=missing_required + missing_optional,
        )
        return False, report["panel_message"]

    if missing_optional:
        warning = _generate_warning_message(
            node_name,
            dependencies_available=True,
            models_available=True,
            missing_dependencies=missing_optional,
            missing_models=[],
        )
        print(warning)
        return True, warning

    return True, f"✅ {node_name} 依赖检查通过"
