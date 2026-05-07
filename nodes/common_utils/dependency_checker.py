"""
GJJ 节点依赖检查工具

提供统一的依赖检查和错误提示机制，确保即使缺少依赖也不会导致整个节点包无法注册。

使用方法：
    from .common_utils.dependency_checker import check_dependencies, create_fallback_node

    # 在模块顶部检查依赖
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
