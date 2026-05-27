import os
import sys
import gc
import time
import importlib
from typing import Any

from aiohttp import web
from server import PromptServer


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False

    def __eq__(self, __value: object) -> bool:
        return True


class FlexibleOptionalInputType(dict):
    """允许节点接收动态数量与动态类型的可选输入。"""

    def __init__(self, input_type, data=None):
        super().__init__()
        self.input_type = input_type
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        return (self.input_type,)

    def __contains__(self, key):
        return True


any_type = AnyType("*")

ACTION_PROP = "action"
AUTO_CLEAN_MEMORY_PROP = "auto_clean_memory"
AUTO_CLEAN_GPU_PROP = "auto_clean_gpu"

ACTION_REFRESH = "refresh"
ACTION_CLEAN_MEMORY = "clean_memory"
ACTION_CLEAN_GPU = "clean_gpu"
ACTION_CLEAN_ALL = "clean_all"

_SAFE_TENSOR_REPR_INSTALLED = False


def _install_safe_tensor_repr():
    """避免 OOM 后 ComfyUI 为了打印 CUDA Tensor 又触发二次显存申请。"""
    global _SAFE_TENSOR_REPR_INSTALLED
    if _SAFE_TENSOR_REPR_INSTALLED:
        return
    try:
        import torch

        old_repr = torch.Tensor.__repr__

        def safe_repr(self):
            try:
                if getattr(self, "is_cuda", False):
                    shape = tuple(self.shape)
                    return f"<CUDA Tensor shape={shape} dtype={self.dtype} device={self.device}>"
            except Exception:
                return "<CUDA Tensor>"
            return old_repr(self)

        torch.Tensor.__repr__ = safe_repr
        torch.Tensor.__str__ = safe_repr
        _SAFE_TENSOR_REPR_INSTALLED = True
    except Exception:
        pass


_install_safe_tensor_repr()


def _get_memory_info():
    """获取系统内存信息。"""
    try:
        if sys.platform.startswith("win"):
            import ctypes

            kernel32 = ctypes.windll.kernel32
            c_ulonglong = ctypes.c_ulonglong

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_uint),
                    ("dwMemoryLoad", ctypes.c_uint),
                    ("ullTotalPhys", c_ulonglong),
                    ("ullAvailPhys", c_ulonglong),
                    ("ullTotalPageFile", c_ulonglong),
                    ("ullAvailPageFile", c_ulonglong),
                    ("ullTotalVirtual", c_ulonglong),
                    ("ullAvailVirtual", c_ulonglong),
                    ("sullAvailExtendedVirtual", c_ulonglong),
                ]

            status = MEMORYSTATUSEX()
            status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            kernel32.GlobalMemoryStatusEx(ctypes.byref(status))

            total = status.ullTotalPhys / (1024**3)
            available = status.ullAvailPhys / (1024**3)
            used = total - available
            percent = (used / total) * 100 if total else 0

            return {
                "total": round(total, 2),
                "used": round(used, 2),
                "available": round(available, 2),
                "percent": round(percent, 1),
                "unit": "GB",
            }

        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            lines = f.readlines()

        mem_info = {}
        for line in lines:
            if line.startswith("MemTotal:"):
                mem_info["total"] = int(line.split()[1]) / 1024 / 1024
            elif line.startswith("MemAvailable:"):
                mem_info["available"] = int(line.split()[1]) / 1024 / 1024

        if "total" not in mem_info or "available" not in mem_info:
            return {"error": "无法读取 /proc/meminfo"}

        used = mem_info["total"] - mem_info["available"]
        percent = (used / mem_info["total"]) * 100 if mem_info["total"] else 0

        return {
            "total": round(mem_info["total"], 2),
            "used": round(used, 2),
            "available": round(mem_info["available"], 2),
            "percent": round(percent, 1),
            "unit": "GB",
        }
    except Exception as e:
        return {"error": f"获取内存信息失败: {str(e)}"}


def _get_process_memory_info():
    """获取当前 ComfyUI/Python 进程的内存占用。"""
    try:
        if sys.platform.startswith("win"):
            import ctypes
            from ctypes import wintypes

            class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                    ("PrivateUsage", ctypes.c_size_t),
                ]

            counters = PROCESS_MEMORY_COUNTERS_EX()
            counters.cb = ctypes.sizeof(counters)
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            if not ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                return {"error": "GetProcessMemoryInfo 失败"}
            rss = counters.WorkingSetSize / (1024**3)
            private = counters.PrivateUsage / (1024**3)
            peak = counters.PeakWorkingSetSize / (1024**3)
            return {
                "rss": round(rss, 2),
                "private": round(private, 2),
                "peak": round(peak, 2),
                "unit": "GB",
            }

        try:
            import resource

            usage = resource.getrusage(resource.RUSAGE_SELF)
            rss = float(usage.ru_maxrss)
            # Linux ru_maxrss is KB; macOS is bytes. This node normally runs on Windows/Linux.
            rss_gb = rss / 1024 / 1024
            return {"rss": round(rss_gb, 2), "private": round(rss_gb, 2), "peak": round(rss_gb, 2), "unit": "GB"}
        except Exception as e:
            return {"error": f"获取进程内存失败: {e}"}
    except Exception as e:
        return {"error": f"获取进程内存失败: {e}"}


def _get_gpu_info():
    """获取 GPU 显存信息。"""
    gpu_info = []

    try:
        import torch

        if torch.cuda.is_available():
            for i in range(torch.cuda.device_count()):
                device = torch.device(f"cuda:{i}")
                total = torch.cuda.get_device_properties(device).total_memory / (
                    1024**3
                )
                allocated = torch.cuda.memory_allocated(device) / (1024**3)
                cached = torch.cuda.memory_reserved(device) / (1024**3)
                available = total - cached

                gpu_info.append(
                    {
                        "device": f"GPU {i}",
                        "name": torch.cuda.get_device_name(device),
                        "total": round(total, 2),
                        "allocated": round(allocated, 2),
                        "cached": round(cached, 2),
                        "available": round(available, 2),
                        "percent": round((cached / total) * 100, 1) if total else 0,
                        "unit": "GB",
                    }
                )
        else:
            gpu_info.append({"error": "未检测到 CUDA 设备"})
    except Exception as e:
        gpu_info.append({"error": f"获取 GPU 信息失败: {str(e)}"})

    return gpu_info


def _loaded_model_count(mm: Any = None) -> int:
    """读取 ComfyUI 模型管理器当前持有的已加载模型数量。"""
    try:
        if mm is None:
            from comfy import model_management as mm
        models = getattr(mm, "current_loaded_models", [])
        return len(models) if isinstance(models, list) else 0
    except Exception:
        return 0


def _call_soft_empty_cache(mm: Any) -> None:
    fn = getattr(mm, "soft_empty_cache", None)
    if not callable(fn):
        return
    try:
        fn(force=True)
    except TypeError:
        fn()


def _unload_comfy_models() -> dict:
    """尽量使用 ComfyUI 自身接口卸载模型，不杀进程、不重启服务。"""
    try:
        from comfy import model_management as mm

        before = _loaded_model_count(mm)
        errors = []

        for name in ("unload_all_models", "cleanup_models", "cleanup_models_gc"):
            fn = getattr(mm, name, None)
            if not callable(fn):
                continue
            try:
                fn()
            except Exception as e:
                errors.append(f"{name}: {e}")

        # 兼容某些模型没有被公共接口清掉的情况，按 ComfyUI loaded_model 协议逐个卸载。
        models = getattr(mm, "current_loaded_models", None)
        if isinstance(models, list):
            for loaded_model in list(models):
                try:
                    loaded_model.model_unload()
                except Exception as e:
                    errors.append(f"model_unload: {e}")
                try:
                    if loaded_model in models:
                        models.remove(loaded_model)
                except Exception:
                    pass

        try:
            _call_soft_empty_cache(mm)
        except Exception as e:
            errors.append(f"soft_empty_cache: {e}")

        after = _loaded_model_count(mm)
        return {
            "status": "success" if not errors else "warning",
            "before": before,
            "after": after,
            "unloaded": max(0, before - after),
            "message": f"已卸载 ComfyUI 已加载模型 {before} -> {after}",
            "errors": errors[:3],
        }
    except Exception as e:
        return {
            "status": "error",
            "before": 0,
            "after": 0,
            "unloaded": 0,
            "message": f"模型卸载失败: {e}",
            "errors": [str(e)],
        }


def _import_gjj_node_module(module_name: str):
    candidates = []
    if __package__:
        candidates.append(f"{__package__}.{module_name}")
    candidates.extend([
        f"custom_nodes.ComfyUI_GJJ_Nodes.nodes.{module_name}",
        f"ComfyUI_GJJ_Nodes.nodes.{module_name}",
        f"nodes.{module_name}",
    ])
    last_error = None
    for name in candidates:
        try:
            return importlib.import_module(name)
        except Exception as e:
            last_error = e
    raise last_error or ImportError(module_name)


def _release_cached_value(value: Any, depth: int = 0) -> None:
    if depth > 3:
        return
    try:
        if hasattr(value, "to"):
            value.to("cpu")
            return
    except Exception:
        pass
    if isinstance(value, dict):
        for item in list(value.values()):
            _release_cached_value(item, depth + 1)
    elif isinstance(value, (list, tuple, set)):
        for item in list(value):
            _release_cached_value(item, depth + 1)


def _clear_gjj_model_caches() -> dict:
    """清理 GJJ 节点自身的模型/结果缓存，这些不一定挂在 ComfyUI model_management。"""
    cleared = []
    errors = []

    unload_targets = [
        ("gjj_fish_audio_s2_model_cache", "unload_engine", "FishAudioS2"),
        ("gjj_longcat_audiodit_model_cache", "unload_model", "LongCatAudioDiT"),
        ("gjj_opus_mt_zh_en_translation", "unload_model", "Opus-MT翻译"),
    ]
    for module_name, func_name, label in unload_targets:
        try:
            module = _import_gjj_node_module(module_name)
            fn = getattr(module, func_name, None)
            if callable(fn):
                fn()
                cleared.append(label)
        except Exception as e:
            errors.append(f"{label}: {e}")

    clear_targets = [
        ("gjj_audio_separator", "_cached_models", "人声分离模型缓存"),
        ("gjj_audio_separator", "_SEPARATOR_RESULT_CACHE", "人声分离结果缓存"),
        ("gjj_audio_separator", "_SEPARATOR_LAST_OUTPUT_CACHE", "人声分离最近输出缓存"),
        ("gjj_sam2_point_mask_editor", "_MODEL_CACHE", "SAM2点选模型缓存"),
        ("gjj_comprehensive_matting", "_MODEL_CACHE", "综合抠图模型缓存"),
        ("gjj_comprehensive_matting", "_INSPYRENET_REMOVER_CACHE", "InSPyReNet缓存"),
        ("gjj_sdmatte_matting", "_MODEL_CACHE", "SDMatte模型缓存"),
        ("gjj_brushnet_inpaint", "_BRMODEL_CACHE", "BrushNet模型缓存"),
        ("gjj_brushnet_inpaint", "_PP_CLIP_CACHE", "BrushNet PP-CLIP缓存"),
        ("gjj_fantasytalking_wav2vec_embeds", "_WAV2VEC_CACHE", "FantasyTalking Wav2Vec缓存"),
        ("gjj_audio_timestamp_editor", "_RESULT_CACHE", "音频时间戳结果缓存"),
    ]
    for module_name, attr_name, label in clear_targets:
        try:
            module = _import_gjj_node_module(module_name)
            cache = getattr(module, attr_name, None)
            if hasattr(cache, "clear"):
                count = len(cache) if hasattr(cache, "__len__") else 0
                _release_cached_value(cache)
                cache.clear()
                if count:
                    cleared.append(f"{label}({count})")
        except Exception as e:
            errors.append(f"{label}: {e}")

    reset_targets = [
        ("gjj_face_analysis", "ANALYSIS_MODELS", {}, "人脸分析模型缓存"),
        ("gjj_face_analysis", "FS_MODEL", None, "FaceSwap模型缓存"),
        ("gjj_face_analysis", "CURRENT_FS_MODEL_PATH", None, "FaceSwap路径缓存"),
    ]
    for module_name, attr_name, value, label in reset_targets:
        try:
            module = _import_gjj_node_module(module_name)
            old_value = getattr(module, attr_name, None)
            if old_value:
                _release_cached_value(old_value)
                setattr(module, attr_name, value)
                cleared.append(label)
        except Exception as e:
            errors.append(f"{label}: {e}")

    return {
        "status": "success" if not errors else "warning",
        "cleared": cleared,
        "message": "；".join(cleared) if cleared else "未发现 GJJ 自有模型缓存",
        "errors": errors[:3],
    }


def _trim_process_working_set() -> str:
    """Windows 下提示系统回收当前进程工作集；失败时静默降级。"""
    if not sys.platform.startswith("win"):
        return ""
    try:
        import ctypes

        handle = ctypes.windll.kernel32.GetCurrentProcess()
        ok = ctypes.windll.psapi.EmptyWorkingSet(handle)
        return "，已请求系统回收工作集" if ok else ""
    except Exception:
        return ""


def _clean_memory():
    """强力清理系统内存：卸载 ComfyUI 已加载模型 + Python 垃圾回收。"""
    before_proc = _get_process_memory_info()
    model_result = _unload_comfy_models()
    gjj_result = _clear_gjj_model_caches()
    gc.collect()
    trim_msg = _trim_process_working_set()
    after_proc = _get_process_memory_info()
    proc_msg = _format_process_delta(before_proc, after_proc)
    message = f"{model_result.get('message', '模型卸载完成')}；{gjj_result.get('message', '')}；Python 内存清理完成{trim_msg}{proc_msg}"
    if model_result.get("errors"):
        message += f"；部分步骤提示：{' | '.join(model_result['errors'])}"
    if gjj_result.get("errors"):
        message += f"；GJJ缓存提示：{' | '.join(gjj_result['errors'])}"
    return {"status": model_result.get("status", "success"), "message": message}


def _clean_gpu_memory():
    """强力清理 GPU 显存：卸载 ComfyUI 已加载模型 + CUDA 缓存。"""
    try:
        import torch

        before_proc = _get_process_memory_info()
        model_result = _unload_comfy_models()
        gjj_result = _clear_gjj_model_caches()
        if torch.cuda.is_available():
            gc.collect()
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass
            try:
                torch.cuda.reset_peak_memory_stats()
            except Exception:
                pass
            after_proc = _get_process_memory_info()
            message = f"{model_result.get('message', '模型卸载完成')}；{gjj_result.get('message', '')}；GPU 显存缓存清理完成{_format_process_delta(before_proc, after_proc)}"
            if model_result.get("errors"):
                message += f"；部分步骤提示：{' | '.join(model_result['errors'])}"
            if gjj_result.get("errors"):
                message += f"；GJJ缓存提示：{' | '.join(gjj_result['errors'])}"
            return {"status": model_result.get("status", "success"), "message": message}
        return {
            "status": "warning",
            "message": f"{model_result.get('message', '模型卸载完成')}；{gjj_result.get('message', '')}；未检测到 CUDA 设备，跳过 GPU 缓存清理",
        }
    except Exception as e:
        return {"status": "error", "message": f"GPU 清理失败: {str(e)}"}


def _clean_all_resources():
    """一键强力清理：模型只卸载一次，再清 RAM / VRAM 缓存。"""
    before_proc = _get_process_memory_info()
    model_result = _unload_comfy_models()
    gjj_result = _clear_gjj_model_caches()
    gc.collect()
    trim_msg = _trim_process_working_set()
    gpu_message = "未检测到 CUDA 设备，跳过 GPU 缓存清理"
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass
            try:
                torch.cuda.reset_peak_memory_stats()
            except Exception:
                pass
            gpu_message = "GPU 显存缓存清理完成"
    except Exception as e:
        gpu_message = f"GPU 缓存清理失败: {e}"

    after_proc = _get_process_memory_info()
    message = f"{model_result.get('message', '模型卸载完成')}；{gjj_result.get('message', '')}；Python 内存清理完成{trim_msg}；{gpu_message}{_format_process_delta(before_proc, after_proc)}"
    if model_result.get("errors"):
        message += f"；部分步骤提示：{' | '.join(model_result['errors'])}"
    if gjj_result.get("errors"):
        message += f"；GJJ缓存提示：{' | '.join(gjj_result['errors'])}"
    return {"status": model_result.get("status", "success"), "message": message}


def _format_process_delta(before: dict, after: dict) -> str:
    if not before or not after or before.get("error") or after.get("error"):
        return ""
    try:
        b = float(before.get("private", before.get("rss", 0)))
        a = float(after.get("private", after.get("rss", 0)))
        return f"；ComfyUI进程内存 {b:.2f} -> {a:.2f}GB"
    except Exception:
        return ""


def _run_action(action: str) -> str:
    """执行一次手动动作，返回前端提示文字。"""
    action = str(action or ACTION_REFRESH)

    if action == ACTION_CLEAN_MEMORY:
        result = _clean_memory()
        return f"内存清理: {result.get('message', '')}"

    if action == ACTION_CLEAN_GPU:
        result = _clean_gpu_memory()
        return f"GPU 清理: {result.get('message', '')}"

    if action == ACTION_CLEAN_ALL:
        result = _clean_all_resources()
        return f"强力清理: {result.get('message', '')}"

    return "已更新"


def _build_stats_payload(node_id=None, action=ACTION_REFRESH, message="已更新"):
    return {
        "node": str(node_id or ""),
        "memory": _get_memory_info(),
        "process_memory": _get_process_memory_info(),
        "gpu": _get_gpu_info(),
        "action": str(action or ACTION_REFRESH),
        "message": str(message or "已更新"),
        "timestamp": time.time(),
    }


def _send_stats(node_id=None, action=ACTION_REFRESH, message="已更新"):
    """发送统计信息给前端事件监听。"""
    try:
        PromptServer.instance.send_sync(
            "gjj_memory_manager_stats",
            _build_stats_payload(node_id=node_id, action=action, message=message),
        )
    except Exception:
        pass


def _find_node_properties(unique_id, extra_pnginfo):
    """从 workflow 里读取当前节点 properties。"""
    try:
        workflow = (extra_pnginfo or {}).get("workflow", {})
        nodes = workflow.get("nodes", []) if isinstance(workflow, dict) else []
        for n in nodes:
            if isinstance(n, dict) and str(n.get("id")) == str(unique_id):
                props = n.get("properties", {}) or {}
                return props if isinstance(props, dict) else {}
    except Exception:
        pass
    return {}


def _as_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "开启", "开", "是"}:
        return True
    if text in {"0", "false", "no", "off", "关闭", "关", "否"}:
        return False
    return default


def _register_routes_once():
    server = PromptServer.instance
    if getattr(server, "_gjj_memory_manager_routes_registered", False):
        return
    setattr(server, "_gjj_memory_manager_routes_registered", True)

    @server.routes.get("/gjj_memory_manager/stats")
    async def gjj_memory_manager_stats(request):
        node_id = request.query.get("node", "")
        return web.json_response(
            _build_stats_payload(
                node_id=node_id, action=ACTION_REFRESH, message="已更新"
            )
        )

    @server.routes.post("/gjj_memory_manager/action")
    async def gjj_memory_manager_action(request):
        try:
            data = await request.json()
        except Exception:
            data = {}

        node_id = data.get("node", "") if isinstance(data, dict) else ""
        action = (
            data.get("action", ACTION_REFRESH)
            if isinstance(data, dict)
            else ACTION_REFRESH
        )
        message = _run_action(action)
        payload = _build_stats_payload(node_id=node_id, action=action, message=message)

        try:
            PromptServer.instance.send_sync("gjj_memory_manager_stats", payload)
        except Exception:
            pass

        return web.json_response(payload)


_register_routes_once()


class GJJ_MemoryManager:
    CATEGORY = "GJJ/系统工具"
    FUNCTION = "execute"
    OUTPUT_NODE = True
    DESCRIPTION = "内存显存管理工具：顶部开关用于数据流经过节点时自动清理；下方按钮直接调用本节点后端动作，不会执行整个工作流。"

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("任意输出",)
    OUTPUT_TOOLTIPS = ("原样输出输入的数据，类型与输入相同",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": FlexibleOptionalInputType(
                any_type,
                {
                    "任意输入_01": (any_type,),
                },
            ),
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def execute(self, unique_id=None, extra_pnginfo=None, **kwargs):
        props = _find_node_properties(unique_id, extra_pnginfo)

        action = str(props.get(ACTION_PROP, ACTION_REFRESH) or ACTION_REFRESH)
        auto_clean_memory = _as_bool(props.get(AUTO_CLEAN_MEMORY_PROP, True), True)
        auto_clean_gpu = _as_bool(props.get(AUTO_CLEAN_GPU_PROP, True), True)

        messages = []

        # 兼容旧逻辑：如果用户通过队列执行当前节点，并且 properties.action 不是 refresh，也能执行一次手动动作。
        if action in {ACTION_CLEAN_MEMORY, ACTION_CLEAN_GPU, ACTION_CLEAN_ALL}:
            messages.append(_run_action(action))
        else:
            # 顶部两个开关：数据流过节点时是否自动清理。
            if auto_clean_memory:
                result = _clean_memory()
                messages.append(f"自动内存清理: {result.get('message', '')}")
            if auto_clean_gpu:
                result = _clean_gpu_memory()
                messages.append(f"自动 GPU 清理: {result.get('message', '')}")
            if not messages:
                messages.append("已更新")

        _send_stats(str(unique_id), action=action, message="\n".join(messages))

        output = kwargs.get("任意输入_01", None)
        return (output,)


NODE_CLASS_MAPPINGS = {"GJJ_MemoryManager": GJJ_MemoryManager}
NODE_DISPLAY_NAME_MAPPINGS = {"GJJ_MemoryManager": "GJJ · 🖥️ 内存显存管理"}
