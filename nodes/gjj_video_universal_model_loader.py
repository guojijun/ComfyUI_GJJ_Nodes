from __future__ import annotations

from typing import Any
import json
import re

import comfy.sd
import comfy.utils
import folder_paths
from aiohttp import web

try:
    import comfy.clip_vision
except Exception:  # pragma: no cover
    comfy_clip_vision = None
else:
    comfy_clip_vision = comfy.clip_vision

try:
    from server import PromptServer
except Exception:
    PromptServer = None

NODE_NAME = "GJJ_VideoUniversalModelLoader"
LIST_API = "/gjj/video_universal_loader_lists"
MAX_SLOTS = 12

DTYPES = ["default", "fp8_e4m3fn", "fp8_e5m2", "fp16", "bf16", "fp32"]
CLIP_TYPES = ["auto", "wan", "ltxv", "hunyuan_video", "flux", "stable_diffusion"]

KIND_OUTPUT_TYPE = {
    "diffusion": "MODEL",
    "checkpoint_model": "MODEL",
    "checkpoint_clip": "CLIP",
    "checkpoint_vae": "VAE",
    "vae": "VAE",
    "ltx_audio_vae": "VAE",
    "clip": "CLIP",
    "clip_vision": "CLIP_VISION",
    "audio_encoder": "AUDIO_ENCODER",
    "empty": "*",
    "latent_upscale_model": "LATENT_UPSCALE_MODEL",
    "name": "STRING",
    "name_any": "STRING",
}

# 图标颜色尽量与 ComfyUI 官方插口/连线颜色保持一致：
# MODEL=紫、VAE=红、CLIP=黄；视觉/音频编码器用蓝；内部 LoRA 不作为输出，只在面板中用橙色提示。
ICON_BY_KIND = {
    "diffusion": "🟣",
    "checkpoint_model": "🟣",
    "checkpoint_clip": "🟡",
    "checkpoint_vae": "🔴",
    "vae": "🔴",
    "ltx_audio_vae": "🔴",
    "clip": "🟡",
    "clip_vision": "🔵",
    "audio_encoder": "🔵",
    "empty": "⚫",
    "latent_upscale_model": "🟤",
    "name": "🟠",
    "name_any": "🟤",
}


def S(id: str, label: str, folder: str, kind: str, keywords: list[str], *, icon: str | None = None, strict: bool = False) -> dict[str, Any]:
    return {
        "id": id,
        "label": label,
        "folder": folder,
        "kind": kind,
        "keywords": keywords,
        "strict": bool(strict),
        "icon": icon or ICON_BY_KIND.get(kind, "⚪"),
        "output_type": KIND_OUTPUT_TYPE.get(kind, "*"),
    }


# 根据官方工作流整理出的配置：关键词已按“去量化、去版本号、去扩展名后取核心小写词”的思路手工固化。
VIDEO_MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    "wan22_t2v_dual": {
        "label": "Wan2.2 T2V 双模型 14B",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "t2v", "high", "noise"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "t2v", "low", "noise"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "t2v", "lightx2v", "high", "noise"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "t2v", "lightx2v", "low", "noise"]),
        ],
    },
    "wan22_i2v_dual": {
        "label": "Wan2.2 I2V 双模型 14B",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "i2v", "high", "noise"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "i2v", "low", "noise"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "high", "noise"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "low", "noise"]),
        ],
    },
    "wan22_s2v_14b": {
        "label": "Wan2.2 S2V 14B 音频驱动",
        "clip_type": "wan",
        "slots": [
            S("model", "S2V模型", "diffusion_models", "diffusion", ["wan", "s2v"]),
            S("model2_empty", "", "", "empty", []),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("audio_encoder", "音频编码器", "audio_encoders", "audio_encoder", ["wav2vec2"]),
            S("lightx2v_lora", "S2V LoRA名称", "loras", "name", ["wan", "t2v", "lightx2v", "high", "noise"]),
        ],
    },
    "wan22_ti2v_5b": {
        "label": "Wan2.2 TI2V 5B",
        "clip_type": "wan",
        "slots": [
            S("model", "TI2V模型", "diffusion_models", "diffusion", ["wan", "ti2v"]),
            S("model2_empty", "", "", "empty", []),
            S("vae", "Wan2.2 VAE", "vae", "vae", ["wan2.2", "vae"], strict=True),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
        ],
    },
    "wan22_flf2v_dual": {
        "label": "Wan2.2 首尾帧 FLF2V 双模型 14B",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "i2v", "high", "noise"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "i2v", "low", "noise"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "high", "noise"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "low", "noise"]),
        ],
    },
    "wan22_fun_camera_dual": {
        "label": "Wan2.2 Fun Camera 双模型 14B",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "fun", "camera", "high", "noise"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "fun", "camera", "low", "noise"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "high", "noise"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "low", "noise"]),
        ],
    },
    "wan22_fun_control_dual": {
        "label": "Wan2.2 Fun Control 双模型 14B",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "fun", "control", "high", "noise"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "fun", "control", "low", "noise"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "high", "noise"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "low", "noise"]),
        ],
    },
    "wan22_fun_inpaint_dual": {
        "label": "Wan2.2 Fun Inpaint 双模型 14B",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "fun", "inpaint", "high", "noise"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "fun", "inpaint", "low", "noise"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "high", "noise"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "low", "noise"]),
        ],
    },
    "wan21_t2v_13b": {
        "label": "Wan2.1 T2V 1.3B",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan", "t2v"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
        ],
    },
    "wan21_i2v_480p": {
        "label": "Wan2.1 I2V 480P 14B",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan", "i2v", "480p"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
        ],
    },
    "wan21_i2v_720p": {
        "label": "Wan2.1 I2V 720P 14B",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan", "i2v", "720p"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
        ],
    },
    "wan21_flf2v_720p": {
        "label": "Wan2.1 首尾帧 FLF2V 720P",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan", "flf2v", "720p"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
        ],
    },
    "wan21_vace": {
        "label": "Wan2.1 VACE 14B",
        "clip_type": "wan",
        "slots": [
            S("model", "VACE模型", "diffusion_models", "diffusion", ["wan", "vace"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
        ],
    },
    "wan21_fun_camera": {
        "label": "Wan2.1 Fun Camera 1.3B",
        "clip_type": "wan",
        "slots": [
            S("model", "Fun Camera", "diffusion_models", "diffusion", ["wan", "fun", "camera"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
        ],
    },
    "wan21_fun_control": {
        "label": "Wan2.1 Fun Control 1.3B",
        "clip_type": "wan",
        "slots": [
            S("model", "Fun Control", "diffusion_models", "diffusion", ["wan", "fun", "control"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
            S("dwpose", "DWPose名称", "controlnet", "name_any", ["dw", "ucoco"]),
        ],
    },
    "wan21_ati_i2v": {
        "label": "Wan2.1 ATI I2V 14B",
        "clip_type": "wan",
        "slots": [
            S("model", "ATI模型", "diffusion_models", "diffusion", ["wan", "ati", "i2v"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
        ],
    },
    "wan21_alpha": {
        "label": "Wan Alpha 透明通道",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan", "t2v"]),
            S("rgb_vae", "RGB VAE", "vae", "vae", ["wan", "alpha", "rgb"]),
            S("alpha_vae", "Alpha VAE", "vae", "vae", ["wan", "alpha", "alpha"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("lightx2v_lora", "LightX2V LoRA名称", "loras", "name", ["lightx2v", "t2v"]),
            S("alpha_lora", "Alpha LoRA名称", "loras", "name", ["epoch", "changed"]),
        ],
    },
    "wan21_wanmove_480p": {
        "label": "WanMove 480P",
        "clip_type": "wan",
        "slots": [
            S("model", "WanMove模型", "diffusion_models", "diffusion", ["wan", "move"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
            S("lightx2v_lora", "LightX2V LoRA名称", "loras", "name", ["lightx2v", "i2v", "480p"]),
        ],
    },
    "wan22_animate_14b": {
        "label": "Wan2.2 Animate 14B",
        "clip_type": "wan",
        "slots": [
            S("model", "Animate模型", "diffusion_models", "diffusion", ["wan", "animate"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
            S("lightx2v_lora", "LightX2V LoRA名称", "loras", "name", ["lightx2v", "i2v", "480p"]),
            S("relight_lora", "Relight LoRA名称", "loras", "name", ["wan", "animate", "relight"]),
            S("dwpose", "DWPose名称", "controlnet", "name_any", ["dw", "ucoco"]),
            S("sam2", "SAM2名称", "controlnet", "name_any", ["sam2", "hiera"]),
        ],
    },
    "ltx23_i2v_t2v": {
        "label": "LTX 2.3 I2V / T2V 双VAE",
        "clip_type": "ltxv",
        "slots": [
            S("ckpt_model", "LTX Checkpoint模型", "checkpoints", "checkpoint_model", ["ltx", "dev"]),
            S("video_vae", "视频VAE", "checkpoints", "checkpoint_vae", ["ltx", "dev"]),
            S("audio_vae", "音频VAE", "checkpoints", "ltx_audio_vae", ["ltx", "dev"]),
            S("text_encoder", "Gemma文本编码器", "text_encoders", "clip", ["gemma", "it"]),
            S("distill_lora", "Distill LoRA名称", "loras", "name", ["ltx", "distilled", "lora"]),
            S("gemma_lora", "Gemma LoRA名称", "loras", "name", ["gemma", "abliterated", "lora"]),
            S("spatial_upscaler", "空间放大模型名称", "latent_upscale_models", "name", ["ltx", "spatial", "upscaler"]),
        ],
    },
}

FOLDERS = sorted({slot["folder"] for cfg in VIDEO_MODEL_CONFIGS.values() for slot in cfg["slots"] if slot.get("folder")} | {"diffusion_models", "checkpoints", "loras", "vae", "text_encoders", "clip_vision", "controlnet", "audio_encoders", "latent_upscale_models"})


def _filename_list(kind: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(kind))
    except Exception:
        return []


def _is_usable_file(name: str, allow_any: bool = False) -> bool:
    lower = str(name or "").replace("\\", "/").lower().strip()
    if lower.endswith(".metadata.json"):
        return False
    exts = (".safetensors", ".sft", ".pt", ".pth", ".ckpt", ".bin", ".torchscript.pt") if allow_any else (".safetensors", ".sft", ".ckpt", ".pt", ".pth")
    return lower.endswith(exts)


def _filter_names(names: list[str], keywords: list[str] | tuple[str, ...], allow_any: bool = False) -> list[str]:
    words = [str(x or "").strip().lower() for x in keywords if str(x or "").strip()]
    source = [n for n in names if _is_usable_file(n, allow_any=allow_any)]
    if not words:
        return source
    result: list[str] = []
    for name in source:
        lower = str(name or "").replace("\\", "/").lower()
        if all(w in lower for w in words):
            result.append(name)
    return result


def _score_name(name: str, keywords: list[str]) -> tuple[int, str]:
    text = str(name or "").replace("\\", "/").lower()
    score = 0
    for i, kw in enumerate(keywords):
        kw = str(kw).lower()
        if not kw:
            continue
        if kw in text:
            score += 100 - i
        if f"_{kw}" in text or f"-{kw}" in text:
            score += 10
    if text.endswith(".safetensors"):
        score += 10
    score -= text.count("/")
    return (-score, text)


def _sort_matches(values: list[str], keywords: list[str]) -> list[str]:
    return sorted(values, key=lambda n: _score_name(n, keywords))


def _name_matches_keywords(name: str, keywords: list[str], allow_any: bool = False) -> bool:
    if allow_any:
        return True
    active = [str(k or "").strip().lower() for k in keywords if str(k or "").strip()]
    if not active:
        return True
    text = str(name or "").replace("\\", "/").lower()
    return all(k in text for k in active)


def _resolve_selected(selected: str, folder: str, keywords: list[str], allow_any: bool = False, strict: bool = False) -> str:
    names = _filename_list(folder)
    selected = str(selected or "").strip()
    if selected and selected in names and (not strict or _name_matches_keywords(selected, keywords, allow_any=allow_any)):
        return selected
    matches = _sort_matches(_filter_names(names, keywords, allow_any=allow_any), keywords)
    return matches[0] if matches else ""


def _normalize_dtype(dtype: str) -> str:
    value = str(dtype or "default").strip().lower()
    return value if value in set(DTYPES) else "default"


def _torch_dtype(dtype: str):
    value = _normalize_dtype(dtype)
    if value == "default":
        return None
    try:
        import torch
    except Exception:
        return None
    return {
        "fp16": torch.float16,
        "bf16": torch.bfloat16,
        "fp32": torch.float32,
        "fp8_e4m3fn": getattr(torch, "float8_e4m3fn", None),
        "fp8_e5m2": getattr(torch, "float8_e5m2", None),
    }.get(value)


def _load_diffusion_model(model_name: str, weight_dtype: str = "default"):
    path = folder_paths.get_full_path_or_raise("diffusion_models", model_name)
    dtype = _torch_dtype(weight_dtype)
    if dtype is not None:
        try:
            return comfy.sd.load_diffusion_model(path, model_options={"dtype": dtype})
        except TypeError:
            try:
                return comfy.sd.load_diffusion_model(path, dtype=dtype)
            except TypeError:
                pass
    return comfy.sd.load_diffusion_model(path)


def _load_checkpoint_parts(ckpt_name: str, cache: dict[str, tuple[Any, Any, Any]]) -> tuple[Any, Any, Any]:
    if ckpt_name in cache:
        return cache[ckpt_name]
    path = folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)
    try:
        result = comfy.sd.load_checkpoint_guess_config(path, output_vae=True, output_clip=True, embedding_directory=folder_paths.get_folder_paths("embeddings"))
    except TypeError:
        result = comfy.sd.load_checkpoint_guess_config(path, output_vae=True, output_clip=True)
    if not isinstance(result, tuple) or len(result) < 3:
        raise RuntimeError(f"Checkpoint 加载结果异常：{ckpt_name}")
    cache[ckpt_name] = (result[0], result[1], result[2])
    return cache[ckpt_name]


def _load_vae(vae_name: str):
    path = folder_paths.get_full_path_or_raise("vae", vae_name)
    sd = comfy.utils.load_torch_file(path)
    return comfy.sd.VAE(sd=sd)


def _clip_type_from_text(clip_type: str):
    raw = str(clip_type or "wan").strip().lower()
    enum = getattr(comfy.sd, "CLIPType", None)
    if enum is None:
        return raw
    candidates = {
        "wan": ["WAN", "Wan", "wan"],
        "ltxv": ["LTXV", "ltxv", "LTX", "ltx"],
        "hunyuan_video": ["HUNYUAN_VIDEO", "hunyuan_video"],
        "flux": ["FLUX", "flux"],
        "stable_diffusion": ["STABLE_DIFFUSION", "SD1", "stable_diffusion"],
    }.get(raw, [raw, raw.upper()])
    for name in candidates:
        if hasattr(enum, name):
            return getattr(enum, name)
    return raw


def _load_clip(name: str, clip_type: str = "wan", weight_dtype: str = "default"):
    path = folder_paths.get_full_path_or_raise("text_encoders", name)
    dtype = _torch_dtype(weight_dtype)
    kwargs: dict[str, Any] = {
        "embedding_directory": folder_paths.get_folder_paths("embeddings"),
        "clip_type": _clip_type_from_text(clip_type),
    }
    if dtype is not None:
        kwargs["model_options"] = {"dtype": dtype}
    try:
        return comfy.sd.load_clip([path], **kwargs)
    except TypeError:
        kwargs.pop("model_options", None)
        return comfy.sd.load_clip([path], **kwargs)


def _load_clip_vision(name: str):
    if comfy_clip_vision is None:
        raise RuntimeError("当前 ComfyUI 环境无法导入 comfy.clip_vision，不能加载 CLIP视觉模型。")
    path = folder_paths.get_full_path_or_raise("clip_vision", name)
    return comfy_clip_vision.load(path)


def _call_loader_class(possible_modules: list[str], class_name: str, model_name: str):
    import importlib
    errors: list[str] = []
    for mod_name in possible_modules:
        try:
            mod = importlib.import_module(mod_name)
            cls = getattr(mod, class_name)
            obj = cls()
            fn_name = getattr(cls, "FUNCTION", None) or getattr(obj, "FUNCTION", None)
            fn = getattr(obj, fn_name, None) if fn_name else None
            if fn is None:
                for candidate in ["load", "load_model", "load_audio_encoder", "load_audio_vae"]:
                    fn = getattr(obj, candidate, None)
                    if fn is not None:
                        break
            if fn is None:
                raise RuntimeError(f"{class_name} 没有可调用加载函数")
            out = fn(model_name)
            return out[0] if isinstance(out, tuple) else out
        except Exception as e:
            errors.append(f"{mod_name}.{class_name}: {e}")
    raise RuntimeError("无法调用加载器 " + class_name + "。尝试结果：" + " | ".join(errors))


def _load_audio_encoder(name: str):
    # 对应官方 AudioEncoderLoader，输出 AUDIO_ENCODER。
    return _call_loader_class(["comfy_extras.nodes_audio", "comfy_extras.nodes_wan", "nodes"], "AudioEncoderLoader", name)


def _load_ltx_audio_vae(ckpt_name: str):
    # 对应官方 LTXVAudioVAELoader，输出 VAE。不同 ComfyUI 版本模块名可能不同，所以做多模块兼容。
    return _call_loader_class(["comfy_extras.nodes_ltxv", "comfy_extras.nodes_ltx", "nodes"], "LTXVAudioVAELoader", ckpt_name)




def _load_lora_patch_model(model: Any, lora_name: str, strength: float = 1.0):
    if not lora_name or abs(float(strength)) < 1e-8:
        return model
    lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
    lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
    patched = comfy.sd.load_lora_for_models(model, None, lora, float(strength), 0.0)
    return patched[0] if isinstance(patched, tuple) else patched


def _parse_lora_chain_config(config: Any) -> list[dict[str, Any]]:
    if config is None:
        return []
    if isinstance(config, list):
        raw = config
    else:
        try:
            raw = json.loads(str(config or "[]"))
        except Exception:
            return []
    if not isinstance(raw, list):
        return []
    items: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("lora_name") or item.get("file") or "").strip()
        if not name:
            continue
        if item.get("enabled", True) is False:
            continue
        try:
            strength = float(item.get("strength", item.get("model_strength", item.get("weight", 1.0))))
        except Exception:
            strength = 1.0
        if abs(strength) < 1e-8:
            continue
        items.append({"name": name, "strength": strength})
    return items


def _is_lora_slot(slot: dict[str, Any]) -> bool:
    return str(slot.get("folder", "")).strip() == "loras"


def _slot_branch(slot_id: str, label: str = "") -> str:
    text = f"{slot_id} {label}".lower()
    if "high" in text or "高" in text:
        return "high"
    if "low" in text or "低" in text:
        return "low"
    return ""


def _lora_name_branch(name: str) -> str:
    text = str(name or "").replace("\\", "/").lower()
    if "high_noise" in text or "high_" in text or "_high" in text or "-high" in text:
        return "high"
    if "low_noise" in text or "low_" in text or "_low" in text or "-low" in text:
        return "low"
    return ""


def _branches_match(lora_branch: str, model_branch: str) -> bool:
    # 没有分支词时作为通用 LoRA，应用到所有 MODEL 输出。
    if not lora_branch:
        return True
    # 模型没有 high/low 分支时，也允许通用叠加。
    if not model_branch:
        return True
    return lora_branch == model_branch


def _config_payload() -> dict[str, Any]:
    return {
        key: {
            "label": cfg.get("label", key),
            "clip_type": cfg.get("clip_type", "wan"),
            "uses_lora": any(_is_lora_slot(slot) for slot in cfg.get("slots", [])),
            # 输出槽只包含真正要给下游使用的对象；LoRA 槽只在节点内部串联，不暴露 STRING 输出。
            "output_slots": [slot for slot in cfg.get("slots", []) if not _is_lora_slot(slot)],
            "slots": cfg.get("slots", []),
        }
        for key, cfg in VIDEO_MODEL_CONFIGS.items()
    }


async def get_gjj_video_universal_loader_lists(request):
    return web.json_response({
        "configs": _config_payload(),
        "folders": {folder: _filename_list(folder) for folder in FOLDERS},
        "dtypes": DTYPES,
        "clip_types": CLIP_TYPES,
    })


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.get(LIST_API)(get_gjj_video_universal_loader_lists)


class GJJ_VideoUniversalModelLoader:
    CATEGORY = "GJJ/模型加载"
    FUNCTION = "load_models"
    DESCRIPTION = (
        "视频通用模型加载器：按官方工作流配置扫描 models 子目录，动态显示模型下拉与输出槽。"
        "输出口使用固定语义布局；单模型配置会保留备用模型位，让 VAE/CLIP 位置稳定，避免 LiteGraph 输出口错位。"
    )

    # 关键稳定方案：Python 端固定 12 个 ANYTYPE 输出口。
    # 前端只按配置修改 node.outputs[i].name/type/label，不再 addOutput/removeOutput，避免动态输出口数量变化导致 LiteGraph 命中区域和连线序号错位。
    RETURN_TYPES = ("*",) * MAX_SLOTS
    RETURN_NAMES = tuple(f"output{i}" for i in range(1, MAX_SLOTS + 1))

    @classmethod
    def INPUT_TYPES(cls):
        config_keys = list(VIDEO_MODEL_CONFIGS.keys())
        inputs: dict[str, Any] = {
            "config": (config_keys, {
                "default": config_keys[0],
                "display_name": "⚫ 配置",
                "tooltip": "选择官方工作流对应的视频模型组合。前端会按配置动态显示相关模型下拉列表和输出接口。",
            }),
            "use_accel_lora": ("BOOLEAN", {
                "default": True,
                "display_name": "🚕 加速LoRA",
                "tooltip": "当前配置包含 LoRA 时，控制是否把内部/外接 LoRA 叠加到模型上。",
            }),
        }
        for i in range(1, MAX_SLOTS + 1):
            # 关键：file_i 必须是 STRING，不能是 [""] 下拉。
            # 前端的可搜索下拉会把真实文件名写入这个隐藏字符串；
            # 如果这里声明为只有 [""] 的 COMBO，ComfyUI 后端校验会报：
            # Value not in list: file_i: xxx not in [""]。
            inputs[f"file_{i}"] = ("STRING", {
                "default": "",
                "display": "hidden",
                "hidden": True,
                "display_name": f"模型{i}",
                "tooltip": "由前端根据配置动态填充；使用 STRING 避免动态列表校验错位。",
            })
            inputs[f"dtype_{i}"] = (DTYPES, {"default": "default", "display_name": f"⚙{i}", "tooltip": "加载 dtype；default 使用 ComfyUI 默认策略。"})
        inputs["clip_type_override"] = (CLIP_TYPES, {
            "default": "auto",
            "display_name": "CLIP类型",
            "tooltip": "auto 使用配置内置类型；需要特殊兼容时可手动覆盖。",
        })
        return {
            "required": inputs,
            "optional": {
                "🚕 加速LoRA": ("BOOLEAN", {
                    "forceInput": True,
                    "display_name": "🚕 加速LoRA",
                    "tooltip": "外部布尔控制加速 LoRA 开关；连接后优先使用外部输入。",
                }),
                "🧬 LoRA配置": ("LORA_CHAIN_CONFIG", {
                    "forceInput": True,
                    "display_name": "🧬 LoRA配置",
                    "tooltip": "对齐 GJJ · 🧬 LoRA串联配置 的输出口。开启加速 LoRA 时会额外叠加到 MODEL 输出。",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        keys = ["config", "clip_type_override", "use_accel_lora", "use_accel_lora_in", "🚕 加速LoRA", "lora_chain_config", "🧬 LoRA配置"]
        for i in range(1, MAX_SLOTS + 1):
            keys += [f"file_{i}", f"dtype_{i}"]
        return "|".join(str(kwargs.get(k, "")) for k in keys)

    def load_models(self, *args, **kwargs):
        # 只按名称读取，故意忽略位置参数，避免动态面板/输入口/输出口变化引起参数错位。
        config_key = str(kwargs.get("config", "") or "")
        if config_key not in VIDEO_MODEL_CONFIGS:
            config_key = next(iter(VIDEO_MODEL_CONFIGS.keys()))
        cfg = VIDEO_MODEL_CONFIGS[config_key]

        clip_type_override = str(kwargs.get("clip_type_override", "auto") or "auto")
        clip_type = cfg.get("clip_type", "wan") if clip_type_override == "auto" else clip_type_override

        use_accel_lora = bool(kwargs.get("use_accel_lora", True))
        lora_bool_in = kwargs.get("🚕 加速LoRA", kwargs.get("use_accel_lora_in", None))
        if lora_bool_in is not None:
            use_accel_lora = bool(lora_bool_in)
        external_loras = _parse_lora_chain_config(kwargs.get("🧬 LoRA配置", kwargs.get("lora_chain_config", None)))

        values: list[Any] = []
        output_records: list[dict[str, Any]] = []
        lora_items: list[dict[str, Any]] = []
        ckpt_cache: dict[str, tuple[Any, Any, Any]] = {}

        for index, slot in enumerate(cfg.get("slots", []), start=1):
            if index > MAX_SLOTS:
                break
            folder = str(slot.get("folder", "") or "")
            kind = str(slot.get("kind", "name") or "name")
            keywords = list(slot.get("keywords", []) or [])
            selected = str(kwargs.get(f"file_{index}", "") or "")
            dtype = str(kwargs.get(f"dtype_{index}", "default") or "default")

            # empty 是前端/后端共同保留的稳定占位输出：用于让单模型配置也保持 MODEL/VAE/CLIP 的固定位置。
            # 它不需要模型文件，不参与 LoRA，也不报错。
            if kind == "empty":
                values.append(None)
                output_records.append({
                    "value_index": len(values) - 1,
                    "value": None,
                    "slot": slot,
                    "kind": kind,
                    "folder": folder,
                    "name": "",
                    "branch": "",
                })
                continue

            allow_any = kind in {"name_any"}
            name = _resolve_selected(selected, folder, keywords, allow_any=allow_any, strict=bool(slot.get("strict", False)))

            if not name:
                raise RuntimeError(f"[{cfg.get('label', config_key)}] 没有在 models/{folder} 中找到 {slot.get('label', slot.get('id'))}：关键词 {keywords}")

            if _is_lora_slot(slot):
                lora_items.append({
                    "name": name,
                    "strength": 1.0,
                    "branch": _slot_branch(str(slot.get("id", "")), str(slot.get("label", ""))),
                    "slot": slot,
                })
                continue

            if kind == "diffusion":
                value = _load_diffusion_model(name, dtype)
            elif kind == "checkpoint_model":
                value = _load_checkpoint_parts(name, ckpt_cache)[0]
            elif kind == "checkpoint_clip":
                value = _load_checkpoint_parts(name, ckpt_cache)[1]
            elif kind == "checkpoint_vae":
                value = _load_checkpoint_parts(name, ckpt_cache)[2]
            elif kind == "vae":
                value = _load_vae(name)
            elif kind == "ltx_audio_vae":
                value = _load_ltx_audio_vae(name)
            elif kind == "clip":
                value = _load_clip(name, clip_type, dtype)
            elif kind == "clip_vision":
                value = _load_clip_vision(name)
            elif kind == "audio_encoder":
                value = _load_audio_encoder(name)
            else:
                value = name

            output_records.append({
                "value_index": len(values),
                "value": value,
                "slot": slot,
                "kind": kind,
                "folder": folder,
                "name": name,
                "branch": _slot_branch(str(slot.get("id", "")), str(slot.get("label", ""))),
            })
            values.append(value)

        if use_accel_lora:
            # 内部 LoRA：high/low 关键词会优先叠到同分支；无分支词则作为通用 LoRA。
            for item in lora_items:
                lora_name = str(item.get("name", ""))
                lora_branch = str(item.get("branch", "")) or _lora_name_branch(lora_name)
                for record in output_records:
                    if record.get("kind") not in {"diffusion", "checkpoint_model"}:
                        continue
                    model_branch = str(record.get("branch", ""))
                    if not _branches_match(lora_branch, model_branch):
                        continue
                    patched = _load_lora_patch_model(record["value"], lora_name, float(item.get("strength", 1.0)))
                    record["value"] = patched
                    values[int(record["value_index"])] = patched

            # 外接 LoRA 串联配置：对齐 GJJ · 🧬 LoRA串联配置，额外叠加，不替代内部 LoRA。
            for item in external_loras:
                selected_lora = str(item.get("name", ""))
                lora_names = _filename_list("loras")
                if selected_lora in lora_names:
                    resolved_lora = selected_lora
                else:
                    # 外接配置一般会给完整相对路径；如果不是完整路径，只按文件名片段匹配，不能空关键词随机选第一个。
                    key = selected_lora.replace("\\", "/").split("/")[-1]
                    resolved_matches = _filter_names(lora_names, [key], allow_any=False) if key else []
                    resolved_lora = _sort_matches(resolved_matches, [key])[0] if resolved_matches else ""
                if not resolved_lora:
                    continue
                lora_branch = _lora_name_branch(resolved_lora)
                for record in output_records:
                    if record.get("kind") not in {"diffusion", "checkpoint_model"}:
                        continue
                    model_branch = str(record.get("branch", ""))
                    if not _branches_match(lora_branch, model_branch):
                        continue
                    patched = _load_lora_patch_model(record["value"], resolved_lora, float(item.get("strength", 1.0)))
                    record["value"] = patched
                    values[int(record["value_index"])] = patched

        # 未使用 output 返回 None，避免用户误连空口时出现 tuple 越界。
        if len(values) < MAX_SLOTS:
            values.extend([None] * (MAX_SLOTS - len(values)))
        return tuple(values[:MAX_SLOTS])


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoUniversalModelLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 视频通用模型加载"}
