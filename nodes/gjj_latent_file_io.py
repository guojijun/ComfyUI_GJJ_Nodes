from __future__ import annotations

import gc
import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any

import torch

import comfy.model_management
import comfy.utils
import folder_paths


SAVE_NODE_NAME = "GJJ_SaveLatentAbsolute"
LOAD_NODE_NAME = "GJJ_LoadLatentAbsolute"
SAVE_VRAM_NODE_NAME = "GJJ_SaveLatentVRAM"
LOAD_VRAM_NODE_NAME = "GJJ_LoadLatentVRAM"
SAVE_DISPLAY_NAME = "GJJ · 💾 Latent 保存到绝对路径"
LOAD_DISPLAY_NAME = "GJJ · 📂 Latent 从绝对路径读取"
SAVE_VRAM_DISPLAY_NAME = "GJJ · ⚡ Latent 智能保存"
LOAD_VRAM_DISPLAY_NAME = "GJJ · ⚡ Latent 智能读取"
LATENT_EXTENSION = ".latent"
_VRAM_LATENT_CACHE: dict[str, dict[str, Any]] = {}
_RAM_LATENT_CACHE: dict[str, dict[str, Any]] = {}
_VRAM_LATENT_CACHE_LOCK = threading.RLock()
_VRAM_LATENT_CACHE_VERSION = 0


def _default_latent_path() -> str:
    return str(Path(folder_paths.get_output_directory()) / "GJJ_latents" / "last.latent")


def _default_latent_cache_key() -> str:
    return "last_latent"


def _resolve_latent_path(path: Any, path_override: Any = None) -> str:
    raw = str(path_override or "").strip() or str(path or "").strip()
    if not raw:
        raw = _default_latent_path()
    expanded = os.path.expandvars(os.path.expanduser(raw)).replace("\\", os.sep)
    candidate = Path(expanded)
    if not candidate.is_absolute():
        candidate = Path(folder_paths.get_output_directory()) / "GJJ_latents" / candidate
    if candidate.suffix == "":
        candidate = candidate.with_suffix(LATENT_EXTENSION)
    return str(candidate.resolve())


def _latent_samples(latent: Any, label: str) -> torch.Tensor:
    if not isinstance(latent, dict) or "samples" not in latent:
        raise RuntimeError(f"{label}必须是 ComfyUI LATENT，且包含 samples。")
    samples = latent["samples"]
    if not isinstance(samples, torch.Tensor):
        raise RuntimeError(f"{label}的 samples 不是张量。")
    if samples.numel() <= 0:
        raise RuntimeError(f"{label}为空，无法保存。")
    return samples.contiguous()


def _load_safetensor_file(path: str) -> dict[str, torch.Tensor]:
    try:
        import safetensors.torch
    except Exception as exc:
        raise RuntimeError("当前 ComfyUI 环境缺少 safetensors，无法读取 .latent 文件。") from exc
    return safetensors.torch.load_file(path, device="cpu")


def _select_loaded_samples(data: dict[str, Any]) -> torch.Tensor:
    if "latent_tensor" in data:
        samples = data["latent_tensor"]
        multiplier = 1.0 if "latent_format_version_0" in data else 1.0 / 0.18215
        return samples.float() * multiplier
    for key in ("samples", "latent"):
        value = data.get(key)
        if isinstance(value, torch.Tensor):
            return value.float()
    for value in data.values():
        if isinstance(value, torch.Tensor) and value.ndim >= 4 and value.numel() > 0:
            return value.float()
    raise RuntimeError("文件中没有可识别的 latent 张量。")


def _file_signature(path: str) -> str:
    if not path or not os.path.isfile(path):
        return f"missing:{path}"
    stat = os.stat(path)
    return f"{path}:{stat.st_size}:{stat.st_mtime_ns}"


def _looks_like_latent_path(value: Any) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return True
    expanded = os.path.expandvars(os.path.expanduser(raw))
    if raw.lower().endswith(LATENT_EXTENSION):
        return True
    if "/" in raw or "\\" in raw:
        return True
    if raw.startswith((".", "~")):
        return True
    if len(expanded) >= 2 and expanded[1] == ":" and expanded[0].isalpha():
        return True
    try:
        return Path(expanded).is_absolute()
    except Exception:
        return False


def _resolve_latent_location(value: Any) -> tuple[str, str]:
    raw = str(value or "").strip()
    if _looks_like_latent_path(raw):
        return "path", _resolve_latent_path(raw)
    return "key", (raw or _default_latent_cache_key())


def _release_cached_latent_memory() -> None:
    global _VRAM_LATENT_CACHE_VERSION
    with _VRAM_LATENT_CACHE_LOCK:
        _VRAM_LATENT_CACHE.clear()
        _RAM_LATENT_CACHE.clear()
        _VRAM_LATENT_CACHE_VERSION += 1
    gc.collect()
    try:
        comfy.model_management.soft_empty_cache()
    except Exception:
        pass
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def clear_smart_latent_cache() -> dict[str, int]:
    with _VRAM_LATENT_CACHE_LOCK:
        vram_count = len(_VRAM_LATENT_CACHE)
        ram_count = len(_RAM_LATENT_CACHE)
    _release_cached_latent_memory()
    return {
        "vram": vram_count,
        "ram": ram_count,
        "total": vram_count + ram_count,
    }


def _vram_device() -> torch.device:
    try:
        device = comfy.model_management.get_torch_device()
        return torch.device(device)
    except Exception:
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _save_latent_file(
    latent: Any,
    final_path: str,
    prompt: Any = None,
    extra_pnginfo: Any = None,
) -> tuple[Any, str, bool]:
    samples = _latent_samples(latent, "Latent")
    target = Path(final_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    metadata = {}
    if prompt is not None:
        try:
            metadata["prompt"] = json.dumps(prompt)
        except Exception:
            metadata["prompt"] = str(prompt)
    if isinstance(extra_pnginfo, dict):
        for key, value in extra_pnginfo.items():
            try:
                metadata[str(key)] = json.dumps(value)
            except Exception:
                metadata[str(key)] = str(value)

    payload = {
        "latent_tensor": samples.detach().cpu(),
        "latent_format_version_0": torch.tensor([]),
    }
    temp_path = str(target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp"))
    try:
        comfy.utils.save_torch_file(payload, temp_path, metadata=metadata or None)
        os.replace(temp_path, final_path)
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass
    return latent, final_path, True


def _store_vram_latent(key: str, samples: torch.Tensor) -> tuple[dict[str, torch.Tensor], int, str]:
    global _VRAM_LATENT_CACHE_VERSION
    device = _vram_device()
    stored = samples.detach().to(device=device, non_blocking=True).clone().contiguous()
    with _VRAM_LATENT_CACHE_LOCK:
        _VRAM_LATENT_CACHE_VERSION += 1
        version = _VRAM_LATENT_CACHE_VERSION
        _VRAM_LATENT_CACHE[key] = {
            "samples": stored,
            "version": version,
            "shape": tuple(stored.shape),
            "dtype": str(stored.dtype),
            "device": str(stored.device),
        }
    return {"samples": stored}, version, str(stored.device)


def _store_ram_latent(key: str, samples: torch.Tensor) -> tuple[dict[str, torch.Tensor], int, str]:
    global _VRAM_LATENT_CACHE_VERSION
    stored = samples.detach().cpu().clone().contiguous()
    with _VRAM_LATENT_CACHE_LOCK:
        _VRAM_LATENT_CACHE_VERSION += 1
        version = _VRAM_LATENT_CACHE_VERSION
        _RAM_LATENT_CACHE[key] = {
            "samples": stored,
            "version": version,
            "shape": tuple(stored.shape),
            "dtype": str(stored.dtype),
            "device": str(stored.device),
        }
    return {"samples": stored}, version, "cpu"


def _store_smart_cache_latent(key: str, samples: torch.Tensor) -> tuple[dict[str, torch.Tensor], int, str]:
    _release_cached_latent_memory()
    try:
        return _store_vram_latent(key, samples)
    except Exception:
        _release_cached_latent_memory()
        return _store_ram_latent(key, samples)


def _load_vram_latent(key: str) -> tuple[dict[str, torch.Tensor], bool, int, str]:
    with _VRAM_LATENT_CACHE_LOCK:
        entry = _VRAM_LATENT_CACHE.get(key)
        if entry is None:
            return {}, False, 0, ""
        samples = entry.get("samples")
        version = int(entry.get("version") or 0)
        device = str(entry.get("device") or getattr(samples, "device", ""))
    if not isinstance(samples, torch.Tensor) or samples.numel() <= 0:
        return {}, False, version, device
    return {"samples": samples}, True, version, device


def _load_ram_latent(key: str) -> tuple[dict[str, torch.Tensor], bool, int, str]:
    with _VRAM_LATENT_CACHE_LOCK:
        entry = _RAM_LATENT_CACHE.get(key)
        if entry is None:
            return {}, False, 0, ""
        samples = entry.get("samples")
        version = int(entry.get("version") or 0)
        device = str(entry.get("device") or getattr(samples, "device", "cpu"))
    if not isinstance(samples, torch.Tensor) or samples.numel() <= 0:
        return {}, False, version, device
    return {"samples": samples}, True, version, device


def _load_smart_cache_latent(key: str) -> tuple[dict[str, torch.Tensor], bool, int, str]:
    latent, exists, version, device = _load_vram_latent(key)
    if exists:
        return latent, exists, version, device
    return _load_ram_latent(key)


def _vram_cache_signature(key: str) -> str:
    with _VRAM_LATENT_CACHE_LOCK:
        entry = _VRAM_LATENT_CACHE.get(key)
        backend = "vram"
        if entry is None:
            entry = _RAM_LATENT_CACHE.get(key)
            backend = "ram"
        if entry is None:
            return f"missing:{key}:{_VRAM_LATENT_CACHE_VERSION}"
        return f"exists:{backend}:{key}:{entry.get('version')}:{entry.get('shape')}:{entry.get('device')}"


class GJJ_SaveLatentAbsolute:
    CATEGORY = "GJJ/🛠️ 工具/Latent"
    FUNCTION = "save"
    OUTPUT_NODE = True
    RETURN_TYPES = ("LATENT", "STRING", "BOOLEAN")
    RETURN_NAMES = ("Latent", "绝对路径", "已保存")
    OUTPUT_TOOLTIPS = (
        "原样透传输入 Latent，方便继续接后续节点。",
        "最终写入的绝对路径。",
        "保存成功时为 True。",
    )
    DESCRIPTION = "GJJ 零依赖 Latent 保存节点：按绝对路径保存 .latent，同名文件直接覆盖。"
    GJJ_HELP = {
        "title": SAVE_DISPLAY_NAME,
        "description": DESCRIPTION,
        "usage": [
            "把上一段任务输出的 LATENT 接到本节点。",
            "设置同一个绝对路径，例如 D:/AI/cache/wan_loop/last.latent。",
            "下一段任务用 GJJ Latent 读取节点读取同一路径，并接到 WanSCAIL 的 上一段视频 Latent。",
        ],
        "notes": [
            "保存格式兼容系统 SaveLatent/LoadLatent 的 .latent 文件。",
            "同名文件使用原子替换覆盖，适合队列长视频续段。",
            "外部 STRING 接到 外部绝对路径 时，会覆盖面板里的路径。",
        ],
    }
    GJJ_PRESERVE_DISPLAY_NAME_KEYS = (SAVE_NODE_NAME,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent": ("LATENT", {"display_name": "Latent", "tooltip": "要保存的 ComfyUI LATENT。"}),
                "absolute_path": (
                    "STRING",
                    {
                        "default": _default_latent_path(),
                        "display_name": "绝对路径",
                        "tooltip": "保存目标。建议填写完整绝对路径；没有扩展名时自动补 .latent。",
                    },
                ),
            },
            "optional": {
                "path_override": (
                    "STRING",
                    {
                        "forceInput": True,
                        "display_name": "外部绝对路径",
                        "tooltip": "连接外部 STRING 时覆盖上面的绝对路径，便于队列/循环任务统一传路径。",
                    },
                ),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    def save(self, latent, absolute_path, path_override=None, prompt=None, extra_pnginfo=None):
        final_path = _resolve_latent_path(absolute_path, path_override)
        return _save_latent_file(latent, final_path, prompt, extra_pnginfo)

    @classmethod
    def IS_CHANGED(cls, latent, absolute_path, path_override=None, **_kwargs):
        return uuid.uuid4().hex


class GJJ_LoadLatentAbsolute:
    CATEGORY = "GJJ/🛠️ 工具/Latent"
    FUNCTION = "load"
    RETURN_TYPES = ("LATENT", "STRING", "BOOLEAN")
    RETURN_NAMES = ("Latent", "绝对路径", "文件存在")
    OUTPUT_TOOLTIPS = (
        "读取到文件时输出 LATENT；文件不存在时输出空对象 {}，下游可当作未连接处理。",
        "最终读取的绝对路径。",
        "文件存在并成功读取时为 True；第一次队列运行未找到文件时为 False。",
    )
    DESCRIPTION = "GJJ 零依赖 Latent 读取节点：按绝对路径读取 .latent；文件不存在时输出空对象。"
    GJJ_HELP = {
        "title": LOAD_DISPLAY_NAME,
        "description": DESCRIPTION,
        "usage": [
            "下一段任务读取和上一段保存节点相同的绝对路径。",
            "第一次没有文件时会输出空对象，不影响 WanSCAIL 第一次生成。",
            "后续队列任务中，保存节点覆盖该文件，读取节点再拿到上一段 Latent。",
        ],
        "notes": [
            "读取格式兼容系统 LoadLatent 的 .latent 文件。",
            "外部 STRING 接到 外部绝对路径 时，会覆盖面板里的路径。",
            "读取失败但文件存在时会报错，避免误用坏文件继续队列。",
        ],
    }
    GJJ_PRESERVE_DISPLAY_NAME_KEYS = (LOAD_NODE_NAME,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "absolute_path": (
                    "STRING",
                    {
                        "default": _default_latent_path(),
                        "display_name": "绝对路径",
                        "tooltip": "读取目标。建议填写完整绝对路径；没有扩展名时自动补 .latent。",
                    },
                ),
            },
            "optional": {
                "path_override": (
                    "STRING",
                    {
                        "forceInput": True,
                        "display_name": "外部绝对路径",
                        "tooltip": "连接外部 STRING 时覆盖上面的绝对路径，便于队列/循环任务统一传路径。",
                    },
                ),
            },
        }

    def load(self, absolute_path, path_override=None):
        final_path = _resolve_latent_path(absolute_path, path_override)
        if not os.path.isfile(final_path):
            return ({}, final_path, False)
        data = _load_safetensor_file(final_path)
        samples = _select_loaded_samples(data)
        return ({"samples": samples}, final_path, True)

    @classmethod
    def IS_CHANGED(cls, absolute_path, path_override=None, **_kwargs):
        return _file_signature(_resolve_latent_path(absolute_path, path_override))

    @classmethod
    def VALIDATE_INPUTS(cls, absolute_path, path_override=None, **_kwargs):
        return True


class GJJ_SaveLatentVRAM:
    CATEGORY = "GJJ/🛠️ 工具/Latent"
    FUNCTION = "save"
    OUTPUT_NODE = True
    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("Latent",)
    OUTPUT_TOOLTIPS = (
        "保存后的 Latent。路径会写硬盘；键值会优先写显存缓存，失败时写内存缓存。",
    )
    DESCRIPTION = "GJJ 零依赖智能 Latent 保存节点：输入路径时写硬盘；输入键值时优先写显存缓存，显存不可用时写内存缓存。"
    GJJ_HELP = {
        "title": SAVE_VRAM_DISPLAY_NAME,
        "description": DESCRIPTION,
        "usage": [
            "把上一段任务输出的 LATENT 接到本节点。",
            "填 D:/AI/cache/wan_loop/last.latent 这类路径时会保存到硬盘。",
            "填 last_latent 这类键值时会优先保存到显存缓存，显存不可用时自动改存内存。",
        ],
        "notes": [
            "键值缓存只在同一 ComfyUI 进程内有效；重启后缓存会消失。",
            "每次按键值保存前会清空旧显存/内存缓存，避免跨队列累积占用。",
            "面板里的 键值/路径 控件可按 ComfyUI 原生方式转为外接输入。",
        ],
    }
    GJJ_PRESERVE_DISPLAY_NAME_KEYS = (SAVE_VRAM_NODE_NAME,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent": ("LATENT", {"display_name": "Latent", "tooltip": "要保存的 ComfyUI LATENT。"}),
                "cache_key": (
                    "STRING",
                    {
                        "default": _default_latent_cache_key(),
                        "display_name": "键值/路径",
                        "tooltip": "填路径时写硬盘；填普通键值时优先写显存缓存，失败后写内存缓存。",
                    },
                ),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    def save(self, latent, cache_key, prompt=None, extra_pnginfo=None):
        mode, location = _resolve_latent_location(cache_key)
        if mode == "path":
            _release_cached_latent_memory()
            saved_latent, _final_path, _saved = _save_latent_file(latent, location, prompt, extra_pnginfo)
            return (saved_latent,)
        samples = _latent_samples(latent, "Latent")
        cached_latent, _version, _device = _store_smart_cache_latent(location, samples)
        return (cached_latent,)

    @classmethod
    def IS_CHANGED(cls, latent, cache_key, **_kwargs):
        return uuid.uuid4().hex

    @classmethod
    def VALIDATE_INPUTS(cls, cache_key, **_kwargs):
        return True


class GJJ_LoadLatentVRAM:
    CATEGORY = "GJJ/🛠️ 工具/Latent"
    FUNCTION = "load"
    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("Latent",)
    OUTPUT_TOOLTIPS = (
        "读取到路径/缓存时输出 LATENT；不存在时输出空对象 {}，下游可当作未连接处理。",
    )
    DESCRIPTION = "GJJ 零依赖智能 Latent 读取节点：输入路径时读硬盘；输入键值时先读显存缓存，再读内存缓存。"
    GJJ_HELP = {
        "title": LOAD_VRAM_DISPLAY_NAME,
        "description": DESCRIPTION,
        "usage": [
            "填和智能保存节点一致的路径或键值。",
            "路径模式会读取硬盘上的 .latent 文件。",
            "键值模式会优先读取显存缓存，找不到时再读取内存缓存。",
        ],
        "notes": [
            "第一次没有文件或缓存时会输出空对象，不影响 WanSCAIL 第一段生成。",
            "键值缓存只在同一 ComfyUI 进程内有效；重启后缓存会消失。",
            "面板里的 键值/路径 控件可按 ComfyUI 原生方式转为外接输入。",
        ],
    }
    GJJ_PRESERVE_DISPLAY_NAME_KEYS = (LOAD_VRAM_NODE_NAME,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cache_key": (
                    "STRING",
                    {
                        "default": _default_latent_cache_key(),
                        "display_name": "键值/路径",
                        "tooltip": "填路径时读硬盘；填普通键值时先读显存缓存，再读内存缓存。",
                    },
                ),
            },
        }

    def load(self, cache_key):
        mode, location = _resolve_latent_location(cache_key)
        if mode == "path":
            if not os.path.isfile(location):
                return ({},)
            data = _load_safetensor_file(location)
            samples = _select_loaded_samples(data)
            return ({"samples": samples},)
        latent, _exists, _version, _device = _load_smart_cache_latent(location)
        return (latent,)

    @classmethod
    def IS_CHANGED(cls, cache_key, **_kwargs):
        mode, location = _resolve_latent_location(cache_key)
        if mode == "path":
            return _file_signature(location)
        return _vram_cache_signature(location)

    @classmethod
    def VALIDATE_INPUTS(cls, cache_key, **_kwargs):
        return True


NODE_CLASS_MAPPINGS = {
    SAVE_NODE_NAME: GJJ_SaveLatentAbsolute,
    LOAD_NODE_NAME: GJJ_LoadLatentAbsolute,
    SAVE_VRAM_NODE_NAME: GJJ_SaveLatentVRAM,
    LOAD_VRAM_NODE_NAME: GJJ_LoadLatentVRAM,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    SAVE_NODE_NAME: SAVE_DISPLAY_NAME,
    LOAD_NODE_NAME: LOAD_DISPLAY_NAME,
    SAVE_VRAM_NODE_NAME: SAVE_VRAM_DISPLAY_NAME,
    LOAD_VRAM_NODE_NAME: LOAD_VRAM_DISPLAY_NAME,
}
