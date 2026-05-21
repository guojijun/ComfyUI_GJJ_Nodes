import os
import sys
import gc
import time
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


def _clean_memory():
    """清理系统内存 / Python 垃圾回收。"""
    gc.collect()
    return {"status": "success", "message": "内存清理完成"}


def _clean_gpu_memory():
    """清理 GPU 显存缓存。"""
    try:
        import torch

        if torch.cuda.is_available():
            gc.collect()
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass
            return {"status": "success", "message": "GPU 显存清理完成"}
        return {"status": "warning", "message": "未检测到 CUDA 设备，跳过 GPU 清理"}
    except Exception as e:
        return {"status": "error", "message": f"GPU 清理失败: {str(e)}"}


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
        mem_result = _clean_memory()
        gpu_result = _clean_gpu_memory()
        return f"内存清理: {mem_result.get('message', '')}\nGPU 清理: {gpu_result.get('message', '')}"

    return "已更新"


def _build_stats_payload(node_id=None, action=ACTION_REFRESH, message="已更新"):
    return {
        "node": str(node_id or ""),
        "memory": _get_memory_info(),
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
        auto_clean_memory = _as_bool(props.get(AUTO_CLEAN_MEMORY_PROP, False), False)
        auto_clean_gpu = _as_bool(props.get(AUTO_CLEAN_GPU_PROP, False), False)

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
