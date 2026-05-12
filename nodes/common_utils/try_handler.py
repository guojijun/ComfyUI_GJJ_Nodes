"""GJJ 通用工具函数 - try-except 处理模块"""

import traceback
import sys


def gjj_try_except_handler(primary_func, fallback_func=None, node_name="Unknown", module_name=""):
    """通用的 try-except 处理函数。

    Args:
        primary_func: 主要执行的函数（不传入参数）
        fallback_func: 备用函数（如果主要函数失败则执行，也不传入参数）
        node_name: 节点名称，用于错误提示
        module_name: 模块名称

    Returns:
        primary_func() 的结果，如果失败则返回 fallback_func() 的结果

    Example:
        # 基础用法
        result = try_except_handler(
            lambda: some_function(),
            fallback_func=lambda: some_fallback(),
            node_name="FluxGuidance",
            module_name="flux1_fill"
        )
    """
    module_prefix = f"[{module_name}] " if module_name else ""

    try:
        result = primary_func()
        print(f"{module_prefix}✓ {node_name} 完成")
        return result
    except Exception as e:
        error_details = traceback.format_exc()

        print(f"\n{'='*70}", file=sys.stderr)
        print(f"  ⚠️  {node_name} 节点执行失败，使用内置实现", file=sys.stderr)
        print(f"{'='*70}", file=sys.stderr)
        print(f"  模块: {module_name}", file=sys.stderr)
        print(f"  错误: {str(e)}", file=sys.stderr)
        print(f"  详细:\n{error_details}", file=sys.stderr)
        print(f"{'='*70}\n", file=sys.stderr)

        if fallback_func is not None:
            try:
                result = fallback_func()
                print(f"{module_prefix}✓ {node_name} 使用内置实现成功")
                return result
            except Exception as fallback_error:
                print(f"{module_prefix}✗ {node_name} 内置实现也失败: {fallback_error}", file=sys.stderr)
                raise fallback_error
        else:
            raise


def gjj_try_import(class_name, module_name="nodes"):
    """尝试导入模块，如果失败返回 None。

    Args:
        class_name: 要导入的类名
        module_name: 模块名

    Returns:
        导入的类，如果失败返回 None
    """
    try:
        module = __import__(module_name, fromlist=[class_name])
        return getattr(module, class_name)
    except (ImportError, AttributeError) as e:
        print(f"\n{'='*70}")
        print(f"  ⚠️  导入 {class_name} 从 {module_name} 失败")
        print(f"  错误: {e}")
        print(f"  该节点将使用内置实现替代")
        print(f"{'='*70}\n")
        return None


def gjj_safe_execute(node_class, method_name, *args, fallback_func=None, node_name="Node", module_name="", **kwargs):
    """安全执行节点方法，带降级处理。

    Args:
        node_class: 节点类
        method_name: 方法名（字符串）
        *args: 位置参数
        fallback_func: 备用函数
        node_name: 节点名称
        module_name: 模块名称
        **kwargs: 关键字参数

    Returns:
        执行结果
    """
    module_prefix = f"[{module_name}] " if module_name else ""

    if node_class is None:
        if fallback_func is not None:
            return try_except_handler(
                fallback_func,
                node_name=node_name,
                module_name=module_name
            )
        raise RuntimeError(f"{node_name} 节点不可用，且没有提供备用实现")

    try:
        method = getattr(node_class, method_name)
        result = method(*args, **kwargs)
        print(f"{module_prefix}✓ {node_name} 完成")
        return result
    except Exception as e:
        error_details = traceback.format_exc()

        print(f"\n{'='*70}", file=sys.stderr)
        print(f"  ⚠️  {node_name} 节点执行失败，使用内置实现", file=sys.stderr)
        print(f"{'='*70}", file=sys.stderr)
        print(f"  模块: {module_name}", file=sys.stderr)
        print(f"  错误: {str(e)}", file=sys.stderr)
        print(f"  详细:\n{error_details}", file=sys.stderr)
        print(f"{'='*70}\n", file=sys.stderr)

        if fallback_func is not None:
            return try_except_handler(
                fallback_func,
                node_name=node_name,
                module_name=module_name
            )
        else:
            raise


__all__ = [
	"gjj_try_except_handler",
	"gjj_try_import",
	"gjj_safe_execute",
]
