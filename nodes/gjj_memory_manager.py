import os
import sys
import gc
from typing import Any
from server import PromptServer


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    """允许节点接收动态数量与动态类型的可选输入。"""

    def __init__(self, input_type, data: dict[str, Any] | None = None):
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


def _get_memory_info():
    """获取系统内存信息"""
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

            total = status.ullTotalPhys / (1024 ** 3)
            available = status.ullAvailPhys / (1024 ** 3)
            used = total - available
            percent = (used / total) * 100

            return {
                "total": round(total, 2),
                "used": round(used, 2),
                "available": round(available, 2),
                "percent": round(percent, 1),
                "unit": "GB"
            }
        else:
            with open("/proc/meminfo", "r") as f:
                lines = f.readlines()

            mem_info = {}
            for line in lines:
                if line.startswith("MemTotal:"):
                    mem_info["total"] = int(line.split()[1]) / 1024 / 1024
                elif line.startswith("MemAvailable:"):
                    mem_info["available"] = int(line.split()[1]) / 1024 / 1024

            used = mem_info["total"] - mem_info["available"]
            percent = (used / mem_info["total"]) * 100

            return {
                "total": round(mem_info["total"], 2),
                "used": round(used, 2),
                "available": round(mem_info["available"], 2),
                "percent": round(percent, 1),
                "unit": "GB"
            }
    except Exception as e:
        return {"error": f"获取内存信息失败: {str(e)}"}


def _get_gpu_info():
    """获取GPU显存信息"""
    gpu_info = []

    try:
        import torch
        if torch.cuda.is_available():
            for i in range(torch.cuda.device_count()):
                device = torch.device(f"cuda:{i}")
                total = torch.cuda.get_device_properties(device).total_memory / (1024 ** 3)
                allocated = torch.cuda.memory_allocated(device) / (1024 ** 3)
                cached = torch.cuda.memory_reserved(device) / (1024 ** 3)
                available = total - cached

                gpu_info.append({
                    "device": f"GPU {i}",
                    "name": torch.cuda.get_device_name(device),
                    "total": round(total, 2),
                    "allocated": round(allocated, 2),
                    "cached": round(cached, 2),
                    "available": round(available, 2),
                    "percent": round((cached / total) * 100, 1),
                    "unit": "GB"
                })
        else:
            gpu_info.append({"error": "未检测到CUDA设备"})
    except Exception as e:
        gpu_info.append({"error": f"获取GPU信息失败: {str(e)}"})

    return gpu_info


def _clean_memory():
    """清理内存"""
    gc.collect()
    return {"status": "success", "message": "内存清理完成"}


def _clean_gpu_memory():
    """清理GPU显存"""
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            return {"status": "success", "message": "GPU显存清理完成"}
        else:
            return {"status": "warning", "message": "未检测到CUDA设备，跳过GPU清理"}
    except Exception as e:
        return {"status": "error", "message": f"GPU清理失败: {str(e)}"}


def _send_stats(node_id):
    """发送统计信息给前端"""
    try:
        memory = _get_memory_info()
        gpu_info = _get_gpu_info()

        PromptServer.instance.send_sync("gjj_memory_manager_stats", {
            "node": node_id,
            "memory": memory,
            "gpu": gpu_info,
            "timestamp": __import__("time").time()
        })
    except Exception:
        pass


class GJJ_MemoryManager:
    CATEGORY = "GJJ/系统工具"
    FUNCTION = "execute"
    OUTPUT_NODE = True
    DESCRIPTION = "内存显存管理工具，支持接入任意类型数据并通过按钮清理内存/显存"

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("任意输出",)
    OUTPUT_TOOLTIPS = ("原样输出输入的数据，类型与输入相同",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "任意输入_01": FlexibleOptionalInputType(any_type),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def execute(self, unique_id=None, extra_pnginfo=None, **kwargs):
        props = {}
        try:
            workflow = (extra_pnginfo or {}).get("workflow", {})
            nodes = workflow.get("nodes", []) if isinstance(workflow, dict) else []
            for n in nodes:
                if isinstance(n, dict) and str(n.get("id")) == str(unique_id):
                    props = n.get("properties", {}) or {}
                    break
        except Exception:
            pass

        action = props.get("action", "refresh")

        result = ""

        if action == "clean_memory":
            clean_result = _clean_memory()
            result = f"内存清理: {clean_result['message']}"
        elif action == "clean_gpu":
            clean_result = _clean_gpu_memory()
            result = f"GPU清理: {clean_result['message']}"
        elif action == "clean_all":
            _clean_memory()
            clean_result = _clean_gpu_memory()
            result = f"内存清理完成\nGPU清理: {clean_result['message']}"
        else:
            result = "刷新状态"

        _send_stats(str(unique_id))

        output = kwargs.get("任意输入_01", None)
        return (output,)

NODE_CLASS_MAPPINGS = {"GJJ_MemoryManager": GJJ_MemoryManager}
NODE_DISPLAY_NAME_MAPPINGS = {"GJJ_MemoryManager": "GJJ · 🖥️ 内存显存管理"}
