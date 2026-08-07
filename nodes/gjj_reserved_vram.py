from __future__ import annotations

import gc
import random
import time
from typing import Any

from server import PromptServer

# 复用 GJJ 内置的依赖检查与提示工具（pynvml 缺失时推送统一事件，由前端专职 JS 显示面板）
try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        send_dependency_model_notice,
    )
except Exception:
    try:
        from common_utils.dependency_checker import (
            build_dependency_model_report,
            send_dependency_model_notice,
        )
    except Exception:
        build_dependency_model_report = None  # type: ignore
        send_dependency_model_notice = None  # type: ignore


NODE_NAME = "GJJ_ReservedVRAM"


class AnyType(str):
    """始终可兼容任意 ComfyUI 插槽类型。"""

    def __ne__(self, __value: object) -> bool:
        return False

    def __eq__(self, __value: object) -> bool:
        return True


any_type = AnyType("*")


# ---------------- pynvml 可选依赖（懒加载） ----------------
_pynvml_module = None
_pynvml_initialized = False
_pynvml_available = False


def _load_pynvml():
    """懒加载 pynvml；未安装时返回 None，不抛异常。"""
    global _pynvml_module, _pynvml_initialized, _pynvml_available
    if _pynvml_initialized:
        return _pynvml_module if _pynvml_available else None
    _pynvml_initialized = True
    try:
        import pynvml as _mod  # type: ignore
        _mod.nvmlInit()
        _pynvml_module = _mod
        _pynvml_available = True
        return _mod
    except Exception:
        _pynvml_available = False
        return None


def _pynvml_is_available() -> bool:
    _load_pynvml()
    return _pynvml_available


def _get_gpu_memory_info():
    """获取 GPU 显存信息（总显存、已用显存，单位 GB）。未安装 pynvml 或读取失败时返回 (None, None)。"""
    pynvml = _load_pynvml()
    if pynvml is None:
        return None, None
    try:
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        memory_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
        total = memory_info.total / (1024 * 1024 * 1024)
        used = memory_info.used / (1024 * 1024 * 1024)
        return total, used
    except Exception as exc:
        print(f"[GJJ][预留显存] 获取 GPU 显存信息失败: {type(exc).__name__}: {exc}")
        return None, None


# ---------------- 独立随机状态（支持 seed=-1 随机） ----------------
_initial_random_state = random.getstate()
random.seed(time.time())
_reserved_vram_random_state = random.getstate()
random.setstate(_initial_random_state)


def _new_random_seed():
    """使用独立随机状态生成新种子，避免污染全局 random。"""
    global _reserved_vram_random_state
    prev_state = random.getstate()
    random.setstate(_reserved_vram_random_state)
    seed = random.randint(1, 1125899906842624)
    _reserved_vram_random_state = random.getstate()
    random.setstate(prev_state)
    return seed


def _build_pynvml_missing_report():
    """构建 pynvml 可选依赖缺失报告（仅提示，不阻断执行）。"""
    if send_dependency_model_notice is None or build_dependency_model_report is None:
        return None
    return build_dependency_model_report(
        node_name=NODE_NAME,
        optional_dependencies=[
            {
                "module_name": "pynvml",
                "package_name": "nvidia-ml-py",
                "display_name": "pynvml (nvidia-ml-py)",
                "description": "自动模式需要；未安装时自动回退到手动模式数值，节点仍可正常使用。",
            }
        ],
        optional_install_packages=["nvidia-ml-py"],
        description="自动模式需要 pynvml 模块（pip 包 nvidia-ml-py）。未安装时自动回退到手动模式数值。",
    )


def _notify_pynvml_missing(unique_id):
    """向前端推送 pynvml 缺失提示（可选依赖，不阻断执行）。"""
    if send_dependency_model_notice is None:
        return
    report = _build_pynvml_missing_report()
    if report is None:
        return
    try:
        send_dependency_model_notice(report, unique_id=unique_id)
    except Exception:
        pass


class GJJ_ReservedVRAM:
    """
    设置 ComfyUI 的 model_management.EXTRA_RESERVED_VRAM（额外预留显存）。
    支持手动模式和自动模式；自动模式按当前 GPU 已用显存动态计算（需 pynvml）。
    零依赖单节点：pynvml 为可选依赖，缺失时自动回退到手动模式。
    """

    CATEGORY = "GJJ/🛠️ 工具/系统"
    FUNCTION = "set_vram"
    OUTPUT_NODE = True
    RETURN_TYPES = (any_type, "INT", "FLOAT")
    RETURN_NAMES = ("输出", "SEED", "预留显存(GB)")
    OUTPUT_TOOLTIPS = (
        "透传输入的任意类型数据；未连接“任意输入”时阻断后续节点执行。",
        "当前使用的种子值（设为 -1 时每次随机）。",
        "实际生效的预留显存大小（GB）。",
    )
    DESCRIPTION = (
        "设置 ComfyUI 的 EXTRA_RESERVED_VRAM（额外预留显存）。支持手动模式和自动模式："
        "手动模式直接使用设定值；自动模式读取 GPU 当前已用显存再加上增量作为预留值（需 pynvml，"
        "未安装时自动回退到手动值）。可在执行前清理 GPU 显存。零依赖单节点，不依赖任何第三方自定义节点包。"
    )
    SEARCH_ALIASES = [
        "reserved vram",
        "vram",
        "显存",
        "预留显存",
        "extra reserved vram",
        "set reserved vram",
        "设置预留显存",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "reserved": (
                    "FLOAT",
                    {
                        "default": 0.6,
                        "min": -2.0,
                        "step": 0.1,
                        "display_name": "预留显存(GB)",
                        "tooltip": (
                            "手动模式下直接作为预留显存值（GB）；自动模式下作为在已用显存基础上的增量，"
                            "可为负数（用于在已用显存基础上减去一定值）。该值会换算成字节写入 "
                            "model_management.EXTRA_RESERVED_VRAM。"
                        ),
                    },
                ),
                "mode": (
                    ["manual", "auto"],
                    {
                        "default": "auto",
                        "display_name": "模式",
                        "tooltip": (
                            "manual：手动模式，直接使用“预留显存(GB)”作为预留值。\n"
                            "auto：自动模式，读取 GPU 当前已用显存再加上“预留显存(GB)”作为预留值"
                            "（需 pynvml，未安装时自动回退到手动值）。"
                        ),
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": -1,
                        "max": 1125899906842624,
                        "display_name": "种子",
                        "tooltip": "固定种子可让节点每次执行结果一致；设为 -1 时每次随机生成新种子。",
                    },
                ),
                "auto_max_reserved": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "step": 0.1,
                        "display_name": "自动模式上限(GB)",
                        "tooltip": (
                            "仅在自动模式下生效。设为 0 表示不限制；大于 0 时，自动计算的预留值不会超过该上限。"
                            "手动模式忽略此参数。"
                        ),
                    },
                ),
                "clean_gpu_before": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "执行前清理显存",
                        "tooltip": (
                            "执行设置前先清理 GPU 显存：gc.collect() + 卸载所有模型 + soft_empty_cache()，"
                            "可释放被缓存占用的显存。"
                        ),
                    },
                ),
            },
            "optional": {
                "anything": (
                    any_type,
                    {
                        "display_name": "任意输入",
                        "tooltip": "可选的任意类型输入，会从“输出”口原样透传。未连接时，输出会阻断后续节点执行。",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @classmethod
    def IS_CHANGED(cls, seed=0, **kwargs):
        """当种子为 -1 时强制每次重新执行。"""
        if seed == -1:
            return _new_random_seed()
        return seed

    def _clean_gpu_force(self):
        """强制清理 GPU 显存：gc + 卸载所有模型 + soft_empty_cache。"""
        gc.collect()
        try:
            from comfy import model_management
            model_management.unload_all_models()
            model_management.soft_empty_cache()
        except Exception as exc:
            print(f"[GJJ][预留显存] 清理 GPU 显存时出错: {type(exc).__name__}: {exc}")

    def set_vram(self, reserved, mode="auto", seed=0, auto_max_reserved=0.0,
                 clean_gpu_before=True, anything=None, unique_id=None, extra_pnginfo=None):
        # 前置清理显存
        if clean_gpu_before:
            print("[GJJ][预留显存] 执行前置 GPU 显存清理...")
            self._clean_gpu_force()
            print("[GJJ][预留显存] GPU 显存清理完成")

        final_reserved_vram = 0.0

        try:
            from comfy import model_management
        except Exception as exc:
            msg = f"无法导入 comfy.model_management: {type(exc).__name__}: {exc}"
            print(f"[GJJ][预留显存] {msg}")
            from comfy_execution.graph import ExecutionBlocker
            output_value = anything if anything is not None else ExecutionBlocker(None)
            return (output_value, seed, final_reserved_vram)

        if mode == "auto":
            if _pynvml_is_available():
                total, used = _get_gpu_memory_info()
                if total and used:
                    auto_reserved = used + reserved
                    auto_reserved = max(0, auto_reserved)
                    if auto_max_reserved > 0:
                        auto_reserved = min(auto_reserved, auto_max_reserved)
                        print(f"[GJJ][预留显存] set EXTRA_RESERVED_VRAM={auto_reserved:.2f}GB "
                              f"(自动模式: 总显存={total:.2f}GB, 已用={used:.2f}GB, 上限={auto_max_reserved:.2f}GB)")
                    else:
                        print(f"[GJJ][预留显存] set EXTRA_RESERVED_VRAM={auto_reserved:.2f}GB "
                              f"(自动模式: 总显存={total:.2f}GB, 已用={used:.2f}GB)")
                    model_management.EXTRA_RESERVED_VRAM = int(auto_reserved * 1024 * 1024 * 1024)
                    final_reserved_vram = round(auto_reserved, 2)
                else:
                    # pynvml 可用但读取显存失败，回退到手动值
                    fallback = max(0, reserved)
                    model_management.EXTRA_RESERVED_VRAM = int(fallback * 1024 * 1024 * 1024)
                    print(f"[GJJ][预留显存] set EXTRA_RESERVED_VRAM={fallback}GB (自动模式读取显存失败，回退到手动值)")
                    final_reserved_vram = round(fallback, 2)
            else:
                # pynvml 未安装，降级到手动值，并推送前端提示
                fallback = max(0, reserved)
                model_management.EXTRA_RESERVED_VRAM = int(fallback * 1024 * 1024 * 1024)
                print(f"[GJJ][预留显存] set EXTRA_RESERVED_VRAM={fallback}GB "
                      f"(未安装 pynvml，自动模式不可用，回退到手动值)")
                final_reserved_vram = round(fallback, 2)
                _notify_pynvml_missing(unique_id)
        else:
            # 手动模式
            manual_reserved = max(0, reserved)
            model_management.EXTRA_RESERVED_VRAM = int(manual_reserved * 1024 * 1024 * 1024)
            print(f"[GJJ][预留显存] set EXTRA_RESERVED_VRAM={manual_reserved}GB (手动模式，忽略自动上限)")
            final_reserved_vram = round(manual_reserved, 2)

        # 未连接 anything 时阻断后续节点执行
        from comfy_execution.graph import ExecutionBlocker
        output_value = anything if anything is not None else ExecutionBlocker(None)

        return (output_value, seed, final_reserved_vram)

    GJJ_HELP = {
        "description": (
            "🎮 预留显存设置：写入 ComfyUI 的 model_management.EXTRA_RESERVED_VRAM（额外预留显存）。\n\n"
            "• 手动模式（manual）：直接使用“预留显存(GB)”作为预留值。\n"
            "• 自动模式（auto）：读取 GPU 当前已用显存，再加上“预留显存(GB)”作为预留值；"
            "可用“自动模式上限(GB)”限制最大值。\n"
            "• 执行前清理显存：先 gc.collect() + 卸载所有模型 + soft_empty_cache()，释放缓存显存。\n"
            "• 任意输入：可选，从“输出”口原样透传；未连接时阻断后续节点执行（ExecutionBlocker）。\n\n"
            "本节点为零依赖单节点，不依赖任何第三方自定义节点包。"
        ),
        "notice": (
            "可选依赖：自动模式需要 pynvml 模块（pip 包 nvidia-ml-py）。"
            "未安装时自动回退到手动模式数值，节点仍可正常使用，并在节点面板提示安装命令。\n"
            "设置只在当前 ComfyUI 进程内生效，重启后恢复默认。"
        ),
        "optional_dependencies": [
            {
                "module_name": "pynvml",
                "package_name": "nvidia-ml-py",
                "display_name": "pynvml (nvidia-ml-py)",
                "description": "自动模式需要；未安装时自动回退到手动模式数值。",
            },
        ],
        "notes": [
            "预留显存越大，模型可用显存越少，但可避免 OOM。",
            "自动模式适合显存占用波动大的场景；手动模式适合稳定可控的场景。",
            "“预留显存(GB)”在自动模式下可为负数，用于在已用显存基础上减去一定值。",
            "种子设为 -1 可每次随机；固定值则每次执行结果一致。",
        ],
    }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ReservedVRAM}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎮 预留显存设置(GB)"}
