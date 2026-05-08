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
    install_cmd = "pip install " + " ".join(missing_required)
    lines.append(f"  {install_cmd}")

    # 如果有可选依赖缺失，也列出
    if missing_optional:
        lines.append("")
        lines.append("⚠️ 可选依赖（建议安装以获得完整功能）：")
        for pkg in missing_optional:
            lines.append(f"  • {pkg}")
        lines.append("")
        lines.append("  可选依赖安装命令：")
        install_cmd = "pip install " + " ".join(missing_optional)
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
    install_cmd = "pip install " + " ".join(missing_optional)
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
        install_command: 完整的安装命令（如 "python.exe -m pip install qwen-asr ..."）
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
