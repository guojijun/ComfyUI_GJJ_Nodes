from __future__ import annotations

from typing import Any
import json
import os
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

try:
    from .gjj_extra_model_chain import parse_extra_model_chain_data
except Exception:  # pragma: no cover - allows standalone syntax checks
    parse_extra_model_chain_data = None

NODE_NAME = "GJJ_VideoUniversalModelLoader"
LIST_API = "/gjj/video_universal_loader_lists"
MAX_SLOTS = 12
WAN_RUNTIME_ARGS_TYPE = "WANCOMPILEARGS,BLOCKSWAPARGS,VRAM_MANAGEMENTARGS"

DTYPES = ["default", "fp8_e4m3fn", "fp8_e5m2", "fp16", "bf16", "fp32"]
CLIP_TYPES = ["auto", "wan", "ltxv", "hunyuan_video", "flux", "stable_diffusion"]
MODEL_EXTENSIONS = {".ckpt", ".pt", ".pt2", ".bin", ".pth", ".safetensors", ".pkl", ".sft"}

KIND_OUTPUT_TYPE = {
    "diffusion": "MODEL",
    "checkpoint_model": "MODEL",
    "checkpoint_clip": "CLIP",
    "checkpoint_vae": "VAE",
    "vae": "VAE",
    "ltx_audio_vae": "VAE",
    "clip": "CLIP",
    "clip_vision": "CLIP_VISION",
    "wanvideo_model": "WANVIDEOMODEL",
    "wan_t5_encoder": "WANTEXTENCODER",
    "wan_vae": "WANVAE",
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
    "wanvideo_model": "🟣",
    "wan_t5_encoder": "🟡",
    "wan_vae": "🔴",
    "audio_encoder": "🔵",
    "empty": "⚫",
    "latent_upscale_model": "🟤",
    "name": "🟠",
    "name_any": "🟤",
}


def S(
    id: str,
    label: str,
    folder: str,
    kind: str,
    keywords: list[str],
    *,
    icon: str | None = None,
    strict: bool = False,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "id": id,
        "label": label,
        "folder": folder,
        "kind": kind,
        "keywords": keywords,
        "strict": bool(strict),
        "icon": icon or ICON_BY_KIND.get(kind, "⚪"),
        "output_type": KIND_OUTPUT_TYPE.get(kind, "*"),
        **extra,
    }


def _model_root_candidates(folder_name: str) -> list[str]:
    roots: list[str] = []
    models_dir = str(getattr(folder_paths, "models_dir", "") or "").strip()
    if models_dir:
        roots.append(os.path.join(models_dir, folder_name))

    # extra_model_paths.yaml may map common categories to a shared models root.
    # Derive models/<folder_name> from those mapped category roots so custom
    # categories such as sam2 still work in portable ComfyUI layouts.
    for base_category in ("controlnet", "checkpoints", "vae", "loras", "diffusion_models", "text_encoders"):
        try:
            category_paths = folder_paths.get_folder_paths(base_category)
        except Exception:
            continue
        for category_path in category_paths:
            parent = os.path.dirname(os.path.normpath(str(category_path or "")))
            if parent:
                roots.append(os.path.join(parent, folder_name))

    unique: list[str] = []
    seen: set[str] = set()
    for path in roots:
        norm = os.path.normpath(path)
        key = norm.lower()
        if norm and key not in seen:
            unique.append(norm)
            seen.add(key)
    return unique


def _ensure_model_folder(folder_name: str) -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    current = existing.get(folder_name)
    if current:
        paths, exts = current
        if not exts:
            existing[folder_name] = (paths, MODEL_EXTENSIONS)
        return

    paths = [path for path in _model_root_candidates(folder_name) if os.path.isdir(path)]
    if not paths:
        candidates = _model_root_candidates(folder_name)
        if candidates:
            paths = [candidates[0]]
    if paths:
        existing[folder_name] = (paths, MODEL_EXTENSIONS)


_ensure_model_folder("sam2")


# 根据官方工作流整理出的配置：关键词已按“去量化、去版本号、去扩展名后取核心小写词”的思路手工固化。
VIDEO_MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    "wan22_t2v_dual": {
        "label": "Wan2.2 T2V 文生视频官方流",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "t2v", "high"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "t2v", "low"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "t2v", "lightx2v", "high"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "t2v", "lightx2v", "low"]),
        ],
    },
    "wan22_i2v_dual": {
        "label": "Wan2.2 I2V 图生视频官方流",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "i2v", "high"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "i2v", "low"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "high"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "low"]),
        ],
    },
    "wan22_s2v_14b": {
        "label": "Wan2.2 S2V 音频驱动官方流",
        "clip_type": "wan",
        "slots": [
            S("model", "S2V模型", "diffusion_models", "diffusion", ["wan", "s2v"]),
            S("model2_empty", "", "", "empty", []),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("audio_encoder", "音频编码器", "audio_encoders", "audio_encoder", ["wav2vec2"]),
            S("lightx2v_lora", "S2V LoRA名称", "loras", "name", ["wan", "t2v", "lightx2v", "high"]),
        ],
    },
    "wan22_ti2v_5b": {
        "label": "Wan2.2 TI2V 5B图文官方流",
        "clip_type": "wan",
        "slots": [
            S("model", "TI2V模型", "diffusion_models", "diffusion", ["wan", "ti2v"]),
            S("model2_empty", "", "", "empty", []),
            S("vae", "Wan2.2 VAE", "vae", "vae", ["wan2.2", "vae"], strict=True),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
        ],
    },
    "wan22_flf2v_dual": {
        "label": "Wan2.2 FLF2V 首尾帧官方流",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "i2v", "high"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "i2v", "low"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "high"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "low"]),
        ],
    },
    "wan22_fun_camera_dual": {
        "label": "Wan2.2 Fun Camera 相机控制官方流",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "fun", "camera", "high"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "fun", "camera", "low"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "t2v", "lightx2v", "high"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "t2v", "lightx2v", "low"]),
        ],
    },
    "wan22_fun_control_dual": {
        "label": "Wan2.2 Fun Control 双模型",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "fun", "control", "high"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "fun", "control", "low"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "high"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "low"]),
        ],
    },
    "wan22_fun_inpaint_dual": {
        "label": "Wan2.2 Fun Inpaint 双模型 14B",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "fun", "inpaint", "high"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "fun", "inpaint", "low"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "high"]),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan", "i2v", "lightx2v", "low"]),
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
    "wan21_i2v": {
        "label": "Wan2.1 I2V 14B 图生视频",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan", "i2v"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
        ],
    },
    "wan21_i2v_wanvideo_wrapper": {
        "label": "Wan2.1 I2V 720P WanVideoWrapper集成",
        "clip_type": "wan",
        "uses_extra_model_chain": True,
        "slots": [
            S(
                "wanvideo_model",
                "WanVideo模型",
                "diffusion_models",
                "wanvideo_model",
                ["i2v", "720p", "14b"],
                preferred_name="wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors",
                base_precision="bf16",
                quantization="fp8_e4m3fn",
                load_device="offload_device",
                attention_mode="sdpa",
                rms_norm_function="default",
            ),
            S(
                "wan_t5",
                "Wan T5编码器",
                "text_encoders",
                "wan_t5_encoder",
                ["umt5", "xxl"],
                preferred_name="umt5-xxl-enc-bf16.safetensors",
                precision="bf16",
                load_device="offload_device",
                quantization="disabled",
            ),
            S(
                "clip_vision",
                "CLIP视觉",
                "clip_vision",
                "clip_vision",
                ["clip", "vision"],
                preferred_name="clip_vision_h.safetensors",
            ),
            S(
                "wan_vae",
                "WanVideo VAE",
                "vae",
                "wan_vae",
                ["wan", "vae"],
                preferred_name="Wan2.1_VAE_bf16.safetensors",
                precision="bf16",
                use_cpu_cache=False,
                verbose=False,
            ),
        ],
    },
    "wan21_flf2v_720p": {
        "label": "Wan2.1 首尾帧 FLF2V 720P",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan", "flf2v"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
        ],
    },
    "wan21_vace": {
        "label": "Wan2.1 VACE 14B 可控生成",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan2.1", "vace"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1","vae"]),
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
        ],},
    "wan21_fun_inp": {
        "label": "Wan2.1 Fun Inp 1.3B",
        "clip_type": "wan",
        "slots": [
            S("model", "Fun Inp", "diffusion_models", "diffusion", ["wan", "fun", "inp"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
        ],
    },
    "wan21_fun_control": {
        "label": "Wan2.1 Fun Control 1.3B",
        "clip_type": "wan",
        "slots": [
            S("model", "Fun Control", "diffusion_models", "diffusion", ["wan2.1", "fun", "control"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
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
            S("model", "模型", "diffusion_models", "diffusion", ["wan2_1","t2v"]),
            S("rgb_vae", "RGB VAE", "vae", "vae", ["wan", "alpha", "rgb"]),
            S("alpha_vae", "Alpha VAE", "vae", "vae", ["wan", "alpha", "alpha"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("lightx2v_lora", "LightX2V LoRA名称", "loras", "name", ["lightx2v", "rank256"]),
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
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"]),
            S("vae", "VAE", "vae", "vae", ["wan", "vae"]),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip", "vision"]),
            S("lightx2v_lora", "LightX2V LoRA名称", "loras", "name", ["lightx2v", "i2v", "480p"]),
            S("relight_lora", "Relight LoRA名称", "loras", "name", ["wan", "animate", "relight"]),
            S("dwpose", "DWPose名称", "controlnet", "name_any", ["dw", "ucoco"]),
            S(
                "sam2",
                "SAM2模型",
                "sam2",
                "name_any",
                ["sam2", "hiera", "base", "plus"],
                required_name="sam2_hiera_base_plus.safetensors",
                download_url="https://huggingface.co/Kijai/sam2-safetensors/resolve/main/sam2_hiera_base_plus.safetensors",
            ),
        ],
    },
    "ltx23_i2v_t2v": {
        "label": "LTX23 T2V / I2V官方流",
        "clip_type": "ltxv",
        "slots": [
            S("ckpt_model", "LTX Checkpoint模型", "checkpoints", "checkpoint_model", ["ltx", "dev"]),
            S("video_vae", "视频VAE", "checkpoints", "checkpoint_vae", ["ltx", "dev"]),
            S("audio_vae", "音频VAE", "checkpoints", "ltx_audio_vae", ["ltx", "dev"]),
            S("text_encoder", "Gemma文本编码器", "text_encoders", "clip", ["gemma", "it"], loader="ltxav_text_encoder"),
            S("distill_lora", "Distill LoRA名称", "loras", "name", ["ltx", "distilled", "lora"]),
            S("gemma_lora", "Gemma LoRA名称", "loras", "name", ["gemma", "abliterated", "lora"]),
            S("spatial_upscaler", "空间放大模型", "latent_upscale_models", "latent_upscale_model", ["ltx", "spatial", "upscaler"]),
        ],
    },
    "ltx23_i2v_t2v_kj": {
        "label": "LTX 2.3 I2V / T2V KJ流",
        "clip_type": "ltxv",
        "slots": [
            S(
                "model",
                "UNET主模型",
                "diffusion_models",
                "diffusion",
                ["ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled_v2"],
                loader="unet",
                required_name="ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled_v2.safetensors",
                download_url="https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/diffusion_models/ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled_v2.safetensors",
            ),
            S(
                "clip",
                "双CLIP编码器",
                "text_encoders",
                "clip",
                ["gemma_3_12B_it_fp8_e4m3fn"],
                loader="dual_clip",
                required_name="gemma_3_12B_it_fp8_e4m3fn.safetensors",
                download_url="https://huggingface.co/GitMylo/LTX-2-comfy_gemma_fp8_e4m3fn/resolve/main/gemma_3_12B_it_fp8_e4m3fn.safetensors",
                secondary_label="另一个模型",
                secondary_name="ltx-2.3_text_projection_bf16.safetensors",
                secondary_download_url="https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/text_encoders/ltx-2.3_text_projection_bf16.safetensors",
                device="default",
            ),
            S(
                "video_vae",
                "视频VAE",
                "vae",
                "vae",
                ["LTX23_video_vae_bf16"],
                loader="gjj_vae",
                device="main_device",
                weight_dtype="bf16",
                required_name="LTX23_video_vae_bf16.safetensors",
                download_url="https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/vae/LTX23_video_vae_bf16.safetensors",
            ),
            S(
                "audio_vae",
                "音频VAE",
                "vae",
                "vae",
                ["LTX23_audio_vae_bf16"],
                loader="gjj_vae",
                device="main_device",
                weight_dtype="bf16",
                required_name="LTX23_audio_vae_bf16.safetensors",
                download_url="https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/vae/LTX23_audio_vae_bf16.safetensors",
            ),
            S(
                "spatial_upscaler",
                "空间放大模型",
                "latent_upscale_models",
                "latent_upscale_model",
                ["ltx-2.3-spatial-upscaler-x2-1.0"],
                required_name="ltx-2.3-spatial-upscaler-x2-1.0.safetensors",
                download_url="https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.0.safetensors",
            ),
        ],
    },
}

FOLDERS = sorted({slot["folder"] for cfg in VIDEO_MODEL_CONFIGS.values() for slot in cfg["slots"] if slot.get("folder")} | {"diffusion_models", "checkpoints", "loras", "vae", "text_encoders", "clip_vision", "controlnet", "audio_encoders", "latent_upscale_models"})


def _model_rel_path(folder: str, filename: str) -> str:
    folder = str(folder or "").strip("/\\")
    filename = str(filename or "").strip("/\\")
    if not folder:
        return f"models/{filename}" if filename else "models"
    if not filename:
        return f"models/{folder}/"
    return f"models/{folder}/{filename}"


def _slot_call_hint(slot: dict[str, Any]) -> str:
    loader = str(slot.get("loader", "") or "").lower()
    kind = str(slot.get("kind", "") or "").lower()
    if loader == "unet":
        return "调用方法：主模型槽走 UNETLoader；官方流保留原有 diffusion loader。"
    if loader == "dual_clip":
        return "调用方法：主槽选 Gemma，另一个模型槽选 text projection；最终只输出一个 CLIP 口。"
    if loader == "gjj_vae":
        device = str(slot.get("device", "main_device") or "main_device")
        weight_dtype = str(slot.get("weight_dtype", "bf16") or "bf16")
        return f"调用方法：走 GJJ 兼容 VAE 加载，device={device}，weight_dtype={weight_dtype}；缺失时会回退到 comfy.sd.VAE。"
    if kind == "wanvideo_model":
        return "调用方法：走 GJJ 内置 WanVideoModelLoader，可接额外模型串联配置后在加载主模型时合并 VACE / Talking / Portrait 模块。"
    if kind == "wan_t5_encoder":
        return "调用方法：走 GJJ 内置 LoadWanVideoT5TextEncoder，输出 WANTEXTENCODER。"
    if kind == "wan_vae":
        return "调用方法：走 GJJ 内置 WanVideoVAELoader，输出 WANVAE。"
    if kind == "latent_upscale_model":
        return "调用方法：空间放大模型槽会先走官方加载器，再走兼容回退；这是官方流和 KJ 流共用的辅助模型。"
    return ""


def _join_error_lines(errors: list[str], limit: int = 4) -> str:
    clean = [str(item).strip() for item in errors if str(item).strip()]
    if not clean:
        return ""
    if len(clean) <= limit:
        return " | ".join(clean)
    return " | ".join(clean[:limit]) + f" | ...（共{len(clean)}条）"


def _build_ltx23_kj_help_models() -> list[dict[str, str]]:
    cfg = VIDEO_MODEL_CONFIGS.get("ltx23_i2v_t2v_kj", {})
    items: list[dict[str, str]] = []
    for slot in cfg.get("slots", []):
        folder = str(slot.get("folder", "") or "")
        required_name = str(slot.get("required_name", "") or "").strip()
        secondary_name = str(slot.get("secondary_name", "") or "").strip()
        download_url = str(slot.get("download_url", "") or "").strip()
        secondary_download_url = str(slot.get("secondary_download_url", "") or "").strip()
        if not folder or not required_name:
            continue
        value_lines = [_model_rel_path(folder, required_name)]
        tooltip_lines = []
        if download_url:
            tooltip_lines.append(f"🌏模型下载：{download_url}")
        if secondary_name:
            value_lines.append(_model_rel_path(folder, secondary_name))
            if secondary_download_url:
                tooltip_lines.append(f"🌏模型下载：{secondary_download_url}")
        tooltip_lines.append(f"📁存放目录：models/{folder}/")
        call_hint = _slot_call_hint(slot)
        if call_hint:
            tooltip_lines.append(call_hint)
        items.append({
            "label": str(slot.get("label", "") or "模型"),
            "value": "\n".join(value_lines),
            "tooltip": "\n".join(tooltip_lines),
        })
    return items


def _build_ltx23_kj_required_models() -> list[dict[str, str]]:
    cfg = VIDEO_MODEL_CONFIGS.get("ltx23_i2v_t2v_kj", {})
    items: list[dict[str, str]] = []
    for slot in cfg.get("slots", []):
        folder = str(slot.get("folder", "") or "").strip()
        required_name = str(slot.get("required_name", "") or "").strip()
        download_url = str(slot.get("download_url", "") or "").strip()
        if not folder or not required_name:
            continue
        items.append({
            "filename": required_name,
            "url": download_url,
            "dest": f"models/{folder}/",
        })
        secondary_name = str(slot.get("secondary_name", "") or "").strip()
        secondary_download_url = str(slot.get("secondary_download_url", "") or "").strip()
        if secondary_name:
            items.append({
                "filename": secondary_name,
                "url": secondary_download_url,
                "dest": f"models/{folder}/",
            })
    return items


def _format_slot_runtime_error(
    cfg_label: str,
    slot: dict[str, Any],
    exc: Exception,
    *,
    secondary: bool = False,
    selected_name: str = "",
    secondary_selected_name: str = "",
) -> RuntimeError:
    folder = str(slot.get("folder", "") or "").strip()
    label = str(slot.get("secondary_label" if secondary else "label", "") or slot.get("id", "模型")).strip() or "模型"
    required_name = str(slot.get("secondary_name" if secondary else "required_name", "") or "").strip()
    if not required_name:
        required_name = selected_name.strip()
    if not required_name:
        required_name = str(slot.get("keywords", [""])[0] or "").strip()
    download_url = str(slot.get("secondary_download_url" if secondary else "download_url", "") or "").strip()
    lines = [
        f"[{cfg_label}] {label} 加载失败。",
        f"需要文件：{_model_rel_path(folder, required_name)}",
        f"存放目录：models/{folder}/",
    ]
    if selected_name:
        lines.append(f"当前选择：{selected_name}")
    if secondary and secondary_selected_name:
        lines.append(f"另一个模型当前选择：{secondary_selected_name}")
    if download_url:
        lines.append(f"🌏模型下载：{download_url}")
    hint = _slot_call_hint(slot)
    if hint:
        lines.append(hint)
    message = str(exc or "").strip()
    if message:
        lower_message = message.lower()
        if "no module named" in lower_message or "cannot import name" in lower_message or "没有可调用" in message:
            lines.append("提示：这更像是 ComfyUI 官方加载器/节点缺失或版本过旧，不是 pip 依赖问题。")
        elif "not found" in lower_message or "未找到" in message or "no such file" in lower_message:
            lines.append("提示：这是模型文件缺失，请按上面的目录与文件名放置。")
        lines.append(f"原始错误：{message}")
    return RuntimeError("\n".join(lines))


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
    words = [_match_text(x) for x in keywords if str(x or "").strip()]
    source = [n for n in names if _is_usable_file(n, allow_any=allow_any)]
    if not words:
        return source
    result: list[str] = []
    for name in source:
        text = _match_text(name)
        if all(w in text for w in words):
            result.append(name)
    return result


def _match_text(value: Any) -> str:
    text = str(value or "").replace("\\", "/").lower()
    return re.sub(r"wan[\s._-]*2[\s._-]*2", "wan22", text)


def _score_name(name: str, keywords: list[str]) -> tuple[int, str]:
    text = _match_text(name)
    score = 0
    for i, kw in enumerate(keywords):
        kw = _match_text(kw)
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
    active = [_match_text(k) for k in keywords if str(k or "").strip()]
    if not active:
        return True
    text = _match_text(name)
    return all(k in text for k in active)


def _resolve_selected(
    selected: str,
    folder: str,
    keywords: list[str],
    allow_any: bool = False,
    strict: bool = False,
    preferred: str = "",
) -> str:
    names = _filename_list(folder)
    selected = str(selected or "").strip()
    if selected and selected in names and (not strict or _name_matches_keywords(selected, keywords, allow_any=allow_any)):
        return selected
    preferred = str(preferred or "").strip()
    if preferred and preferred in names and (not strict or _name_matches_keywords(preferred, keywords, allow_any=allow_any)):
        return preferred
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


def _load_unet_model(model_name: str, weight_dtype: str = "default"):
    """Prefer the official UNETLoader shape used by the KJ workflow."""
    import importlib

    official_dtype = str(weight_dtype or "default").strip()
    try:
        mod = importlib.import_module("nodes")
        cls = getattr(mod, "UNETLoader")
        inst = cls()
        fn = getattr(inst, "load_unet", None) or getattr(cls, "load_unet", None) or getattr(inst, "execute", None) or getattr(cls, "execute", None)
        if callable(fn) and official_dtype in {"default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"}:
            try:
                return _unwrap_loader_output(fn(model_name, official_dtype))
            except TypeError:
                return _unwrap_loader_output(fn(model_name))
    except Exception:
        pass
    return _load_diffusion_model(model_name, weight_dtype)


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


def _load_dual_clip(clip_name1: str, clip_name2: str, clip_type: str = "ltxv", device: str = "default"):
    import importlib

    try:
        mod = importlib.import_module("nodes")
        cls = getattr(mod, "DualCLIPLoader")
        inst = cls()
        fn = getattr(inst, "load_clip", None) or getattr(cls, "load_clip", None)
        if callable(fn):
            return _unwrap_loader_output(fn(clip_name1, clip_name2, clip_type, device))
        raise RuntimeError("DualCLIPLoader 没有可调用的 load_clip 方法")
    except Exception:
        pass

    try:
        import torch
        clip_path1 = folder_paths.get_full_path_or_raise("text_encoders", clip_name1)
        clip_path2 = folder_paths.get_full_path_or_raise("text_encoders", clip_name2)
        model_options: dict[str, Any] = {}
        if str(device or "default").strip().lower() == "cpu":
            model_options["load_device"] = model_options["offload_device"] = torch.device("cpu")
        return comfy.sd.load_clip(
            [clip_path1, clip_path2],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=_clip_type_from_text(clip_type),
            model_options=model_options,
        )
    except Exception as fallback_error:
        raise RuntimeError(
            "双CLIP加载失败。当前环境可能缺少官方 DualCLIPLoader，"
            "或对应的 text_encoders 模型文件未放在 models/text_encoders/。\n"
            f"需要文件：models/text_encoders/{clip_name1} + models/text_encoders/{clip_name2}\n"
            f"原始错误：{fallback_error}"
        ) from fallback_error


def _load_gjj_vae(vae_name: str, device: str = "main_device", weight_dtype: str = "bf16"):
    import importlib

    try:
        mod = importlib.import_module(".gjj_vae_loader", __package__)
        cls = getattr(mod, "GJJ_VAELoader")
        inst = cls()
        fn = getattr(inst, "load_vae", None) or getattr(cls, "load_vae", None)
        if callable(fn):
            return _unwrap_loader_output(fn(vae_name, device, weight_dtype))
    except Exception:
        pass
    return _load_vae(vae_name)


def _load_clip_vision(name: str):
    if comfy_clip_vision is None:
        raise RuntimeError("当前 ComfyUI 环境无法导入 comfy.clip_vision，不能加载 CLIP视觉模型。")
    path = folder_paths.get_full_path_or_raise("clip_vision", name)
    return comfy_clip_vision.load(path)


_WANVIDEO_RUNTIME: dict[str, Any] | None = None


def _load_wanvideo_runtime() -> dict[str, Any]:
    global _WANVIDEO_RUNTIME
    if _WANVIDEO_RUNTIME is not None:
        return _WANVIDEO_RUNTIME
    try:
        from ..vendor.wanvideo_wrapper import nodes_model_loading
    except Exception as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo runtime 加载失败。无需安装 ComfyUI-WanVideoWrapper 插件本体；"
            f"如果是 pip 运行库缺失，请按 GJJ 的 WanVideo 运行时依赖方案安装。\n错误信息：{error}"
        ) from error
    _WANVIDEO_RUNTIME = {
        "model_loading": nodes_model_loading,
    }
    return _WANVIDEO_RUNTIME


def _parse_extra_model_chain_config(config: Any) -> list[dict[str, Any]]:
    if config is None:
        return []
    if callable(parse_extra_model_chain_data):
        try:
            return parse_extra_model_chain_data(config, enabled_only=True)
        except Exception:
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
        if not isinstance(item, dict) or item.get("enabled", True) is False:
            continue
        name = str(item.get("name") or item.get("model") or item.get("file") or "").strip()
        if not name:
            continue
        kind = str(item.get("kind") or "vace").strip().lower().replace("-", "_").replace(" ", "_")
        kind = {
            "fantasy_talking": "fantasytalking",
            "multi_talk": "multitalk",
            "infinite_talk": "multitalk",
            "infinitetalk": "multitalk",
            "fantasy_portrait": "fantasyportrait",
        }.get(kind, kind)
        if kind not in {"vace", "fantasytalking", "multitalk", "fantasyportrait"}:
            kind = "vace"
        branch = str(item.get("branch") or "both").strip().lower()
        if branch in {"all", "全部"}:
            branch = "both"
        if branch not in {"both", "high", "low"}:
            branch = "both"
        precision = str(item.get("base_precision") or item.get("precision") or "fp16").strip().lower()
        if precision not in {"fp16", "bf16", "fp32"}:
            precision = "fp16"
        items.append({"enabled": True, "kind": kind, "name": name, "branch": branch, "base_precision": precision})
    return items


def _extra_branch_matches(item_branch: str, model_branch: str) -> bool:
    item_branch = str(item_branch or "both").lower()
    model_branch = str(model_branch or "").lower()
    if item_branch in {"", "both", "all"}:
        return True
    if not model_branch:
        return True
    return item_branch == model_branch


def _get_full_path_any(categories: tuple[str, ...], model_name: str) -> str:
    last_error: Exception | None = None
    for category in categories:
        try:
            path = folder_paths.get_full_path(category, model_name)
            if path:
                return path
        except Exception as error:
            last_error = error
        try:
            return folder_paths.get_full_path_or_raise(category, model_name)
        except Exception as error:
            last_error = error
    raise RuntimeError(f"未找到模型文件：{model_name}") from last_error


def _load_fantasytalking_extra_model(model_name: str, base_precision: str):
    try:
        from ..vendor.wanvideo_wrapper.fantasytalking import nodes as fantasytalking_nodes
    except Exception as error:
        raise RuntimeError(f"GJJ 内置 FantasyTalking runtime 加载失败：{error}") from error
    loader = fantasytalking_nodes.FantasyTalkingModelLoader()
    return _unwrap_loader_output(loader.loadmodel(model=model_name, base_precision=base_precision))


def _load_multitalk_extra_model(model_name: str):
    try:
        from ..vendor.wanvideo_wrapper.multitalk import nodes as multitalk_nodes
    except Exception as error:
        raise RuntimeError(f"GJJ 内置 MultiTalk runtime 加载失败：{error}") from error
    loader = multitalk_nodes.MultiTalkModelLoader()
    return _unwrap_loader_output(loader.loadmodel(model=model_name))


def _load_fantasyportrait_extra_model(model_name: str, base_precision: str):
    try:
        from ..vendor.wanvideo_wrapper.FantasyPortrait import nodes as fantasyportrait_nodes
    except Exception as error:
        raise RuntimeError(f"GJJ 内置 FantasyPortrait runtime 加载失败：{error}") from error
    loader = fantasyportrait_nodes.FantasyPortraitModelLoader()
    return _unwrap_loader_output(loader.loadmodel(model=model_name, base_precision=base_precision))


def _build_wanvideo_extra_model_kwargs(extra_chain: list[dict[str, Any]], model_branch: str) -> dict[str, Any]:
    vace_paths: list[dict[str, str]] = []
    fantasytalking_model = None
    multitalk_model = None
    fantasyportrait_model = None

    for item in extra_chain:
        if item.get("enabled", True) is False:
            continue
        if not _extra_branch_matches(str(item.get("branch", "both")), model_branch):
            continue
        kind = str(item.get("kind", "vace") or "vace")
        name = str(item.get("name", "") or "").strip()
        if not name:
            continue
        try:
            if kind == "vace":
                vace_paths.append({"path": _get_full_path_any(("diffusion_models", "unet_gguf"), name)})
            elif kind == "fantasytalking":
                fantasytalking_model = _load_fantasytalking_extra_model(
                    name,
                    str(item.get("base_precision", "fp16") or "fp16"),
                )
            elif kind == "multitalk":
                multitalk_model = _load_multitalk_extra_model(name)
            elif kind == "fantasyportrait":
                fantasyportrait_model = _load_fantasyportrait_extra_model(
                    name,
                    str(item.get("base_precision", "fp16") or "fp16"),
                )
        except Exception as error:
            raise RuntimeError(f"WanVideo 额外模型加载失败：{name}\n类型：{kind}\n错误信息：{error}") from error

    return {
        "extra_model": vace_paths or None,
        "fantasytalking_model": fantasytalking_model,
        "multitalk_model": multitalk_model,
        "fantasyportrait_model": fantasyportrait_model,
    }


def _choice(value: Any, allowed: set[str], default: str) -> str:
    text = str(value or default).strip()
    return text if text in allowed else default


_WAN_COMPILE_KEYS = {
    "backend",
    "fullgraph",
    "mode",
    "dynamic",
    "dynamo_cache_size_limit",
    "dynamo_recompile_limit",
    "compile_transformer_blocks_only",
    "force_parameter_static_shapes",
    "allow_unmerged_lora_compile",
}
_WAN_BLOCK_SWAP_KEYS = {
    "blocks_to_swap",
    "offload_img_emb",
    "offload_txt_emb",
    "use_non_blocking",
    "vace_blocks_to_swap",
    "prefetch_blocks",
    "block_swap_debug",
}
_WAN_VRAM_KEYS = {"offload_percent"}


def _assign_wan_runtime_arg(current: Any, value: Any, label: str) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        return current
    if current is not None and current != value:
        raise RuntimeError(f"Wan 运行参数输入中包含重复的 {label}，请只保留一个。")
    return value


def _parse_wan_runtime_args(config: Any) -> tuple[Any, Any, Any]:
    compile_args = None
    block_swap_args = None
    vram_management_args = None

    def typed_payload(item: dict[str, Any]) -> Any:
        for payload_key in ("value", "args", "data", "payload"):
            if payload_key in item:
                return item.get(payload_key)
        return item

    def consume(item: Any) -> None:
        nonlocal compile_args, block_swap_args, vram_management_args
        if item is None or (isinstance(item, str) and not item.strip()):
            return
        if isinstance(item, str):
            text = item.strip()
            try:
                item = json.loads(text)
            except Exception as error:
                raise RuntimeError("Wan 运行参数输入不是可识别的 JSON 或参数字典。") from error
        if isinstance(item, (list, tuple)):
            for sub_item in item:
                consume(sub_item)
            return
        if not isinstance(item, dict):
            raise RuntimeError(f"Wan 运行参数输入类型无效：{type(item).__name__}。")

        nested = False
        for key in ("compile_args", "torch_compile_args", "wan_compile_args"):
            if key in item:
                compile_args = _assign_wan_runtime_arg(compile_args, item.get(key), "编译参数")
                nested = True
        for key in ("block_swap_args", "blockswap_args"):
            if key in item:
                block_swap_args = _assign_wan_runtime_arg(block_swap_args, item.get(key), "分块交换参数")
                nested = True
        for key in ("vram_management_args", "vram_args"):
            if key in item:
                vram_management_args = _assign_wan_runtime_arg(vram_management_args, item.get(key), "显存管理参数")
                nested = True
        if nested:
            return

        keys = set(item.keys())
        type_hint = str(item.get("type") or item.get("kind") or item.get("_type") or item.get("return_type") or "").upper()
        if type_hint == "WANCOMPILEARGS":
            compile_args = _assign_wan_runtime_arg(compile_args, typed_payload(item), "编译参数")
            return
        if type_hint == "BLOCKSWAPARGS":
            block_swap_args = _assign_wan_runtime_arg(block_swap_args, typed_payload(item), "分块交换参数")
            return
        if type_hint == "VRAM_MANAGEMENTARGS":
            vram_management_args = _assign_wan_runtime_arg(vram_management_args, typed_payload(item), "显存管理参数")
            return
        if keys.intersection(_WAN_COMPILE_KEYS):
            compile_args = _assign_wan_runtime_arg(compile_args, item, "编译参数")
            return
        if keys.intersection(_WAN_BLOCK_SWAP_KEYS):
            block_swap_args = _assign_wan_runtime_arg(block_swap_args, item, "分块交换参数")
            return
        if keys.intersection(_WAN_VRAM_KEYS):
            vram_management_args = _assign_wan_runtime_arg(vram_management_args, item, "显存管理参数")
            return

        preview = "、".join(str(key) for key in list(keys)[:8]) or "空字典"
        raise RuntimeError(f"Wan 运行参数输入无法识别字段：{preview}。")

    consume(config)
    if block_swap_args is not None and vram_management_args is not None:
        raise RuntimeError("WanVideo 模型加载不能同时使用分块交换参数和显存管理参数，请二选一。")
    return compile_args, block_swap_args, vram_management_args


def _load_wanvideo_model(
    model_name: str,
    slot: dict[str, Any],
    extra_chain: list[dict[str, Any]],
    model_branch: str,
    compile_args: Any = None,
    block_swap_args: Any = None,
    vram_management_args: Any = None,
):
    runtime = _load_wanvideo_runtime()
    loader = runtime["model_loading"].WanVideoModelLoader()
    extra_kwargs = _build_wanvideo_extra_model_kwargs(extra_chain, model_branch)
    return _unwrap_loader_output(
        loader.loadmodel(
            model=model_name,
            base_precision=_choice(slot.get("base_precision"), {"fp32", "bf16", "fp16", "fp16_fast"}, "bf16"),
            load_device=_choice(slot.get("load_device"), {"main_device", "offload_device"}, "offload_device"),
            quantization=_choice(
                slot.get("quantization"),
                {
                    "disabled",
                    "fp8_e4m3fn",
                    "fp8_e4m3fn_fast",
                    "fp8_e4m3fn_scaled",
                    "fp8_e4m3fn_scaled_fast",
                    "fp8_e5m2",
                    "fp8_e5m2_fast",
                    "fp8_e5m2_scaled",
                    "fp8_e5m2_scaled_fast",
                },
                "disabled",
            ),
            attention_mode=str(slot.get("attention_mode", "sdpa") or "sdpa"),
            rms_norm_function=_choice(slot.get("rms_norm_function"), {"default", "pytorch"}, "default"),
            compile_args=compile_args,
            block_swap_args=block_swap_args,
            vram_management_args=vram_management_args,
            **extra_kwargs,
        )
    )


def _load_wan_t5_encoder(model_name: str, slot: dict[str, Any]):
    runtime = _load_wanvideo_runtime()
    loader = runtime["model_loading"].LoadWanVideoT5TextEncoder()
    return _unwrap_loader_output(
        loader.loadmodel(
            model_name=model_name,
            precision=_choice(slot.get("precision"), {"bf16", "fp32"}, "bf16"),
            load_device=_choice(slot.get("load_device"), {"main_device", "offload_device"}, "offload_device"),
            quantization=_choice(slot.get("quantization"), {"disabled", "fp8_e4m3fn"}, "disabled"),
        )
    )


def _load_wan_vae(model_name: str, slot: dict[str, Any]):
    runtime = _load_wanvideo_runtime()
    loader = runtime["model_loading"].WanVideoVAELoader()
    return _unwrap_loader_output(
        loader.loadmodel(
            model_name=model_name,
            precision=_choice(slot.get("precision"), {"bf16", "fp16", "fp32"}, "bf16"),
            use_cpu_cache=bool(slot.get("use_cpu_cache", False)),
            verbose=bool(slot.get("verbose", False)),
        )
    )


def _unwrap_loader_output(out: Any):
    """Normalize outputs from classic Comfy nodes and new comfy_api io.NodeOutput."""
    if isinstance(out, (tuple, list)):
        return out[0] if out else None
    # New comfy_api io.NodeOutput is not a tuple in some ComfyUI builds.
    for attr in ("result", "results", "output", "outputs", "value", "values"):
        value = getattr(out, attr, None)
        if value is None or callable(value):
            continue
        if isinstance(value, (tuple, list)):
            return value[0] if value else None
        if isinstance(value, dict):
            return next(iter(value.values())) if value else None
        return value
    try:
        return out[0]
    except Exception:
        pass
    try:
        iterator = iter(out)
        return next(iterator)
    except Exception:
        return out


def _call_loader_class(possible_modules: list[str], class_name: str, model_name: str):
    import importlib
    errors: list[str] = []
    for mod_name in possible_modules:
        try:
            mod = importlib.import_module(mod_name)
            cls = getattr(mod, class_name)

            obj = None
            try:
                obj = cls()
            except Exception:
                obj = None

            candidates: list[Any] = []
            fn_name = getattr(cls, "FUNCTION", None) or getattr(obj, "FUNCTION", None)
            if fn_name:
                if obj is not None:
                    candidates.append(getattr(obj, fn_name, None))
                candidates.append(getattr(cls, fn_name, None))

            # Classic nodes usually expose load/load_model; new comfy_api nodes expose execute().
            for candidate in ["execute", "load", "load_model", "load_audio_encoder", "load_audio_vae"]:
                if obj is not None:
                    candidates.append(getattr(obj, candidate, None))
                candidates.append(getattr(cls, candidate, None))

            last_error: Exception | None = None
            for fn in candidates:
                if fn is None or not callable(fn):
                    continue
                try:
                    return _unwrap_loader_output(fn(model_name))
                except Exception as e:
                    last_error = e
                    continue

            if last_error is not None:
                raise last_error
            raise RuntimeError(f"{class_name} 没有可调用加载函数")
        except Exception as e:
            errors.append(f"{mod_name}.{class_name}: {e}")
    raise RuntimeError("无法调用加载器 " + class_name + "。尝试结果：" + " | ".join(errors))


def _load_audio_encoder(name: str):
    # 对应官方 AudioEncoderLoader，输出 AUDIO_ENCODER。
    return _call_loader_class([
        "comfy_extras.nodes_audio_encoder",
        "comfy_extras.nodes_audio",
        "comfy_extras.nodes_wan",
        "nodes",
    ], "AudioEncoderLoader", name)




class _FallbackLatentUpscaleModel:
    def __init__(self, sd, model=None):
        self._sd = sd or {}
        self._model = model

    def state_dict(self):
        if self._model is not None and hasattr(self._model, "state_dict"):
            return self._model.state_dict()
        return self._sd

    def parameters(self):
        if self._model is not None and hasattr(self._model, "parameters"):
            return self._model.parameters()
        try:
            import torch
        except Exception:
            return iter(())
        for value in self._sd.values():
            if isinstance(value, torch.Tensor):
                # 为了兼容官方节点通过 next(model.parameters()) 获取 dtype 的调用，
                # 在无法重建真实模块时至少暴露一个同 dtype 的 Parameter。
                return iter((torch.nn.Parameter(value.detach().reshape(-1)[:1].clone(), requires_grad=False),))
        return iter(())

    def to(self, *args, **kwargs):
        if self._model is not None and hasattr(self._model, "to"):
            self._model = self._model.to(*args, **kwargs)
            return self._model
        return self

    def cpu(self):
        if self._model is not None and hasattr(self._model, "cpu"):
            self._model = self._model.cpu()
            return self._model
        return self

    def eval(self):
        if self._model is not None and hasattr(self._model, "eval"):
            self._model = self._model.eval()
            return self._model
        return self

    def cuda(self):
        if self._model is not None and hasattr(self._model, "cuda"):
            self._model = self._model.cuda()
            return self._model
        return self

    def load_state_dict(self, sd, strict=True):
        if self._model is not None and hasattr(self._model, "load_state_dict"):
            self._model.load_state_dict(sd, strict=strict)
            return self._model
        self._sd = sd or {}
        return self

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        if self._model is not None and hasattr(self._model, name):
            return getattr(self._model, name)
        raise AttributeError(name)

    def __call__(self, *args, **kwargs):
        if self._model is not None and callable(self._model):
            return self._model(*args, **kwargs)
        raise RuntimeError("latent upscale model 回退对象未能重建为可执行模块，无法执行上采样。")


def _ensure_latent_upscale_model_compat(model: Any, sd: dict[str, Any] | None = None):
    """Guarantee the returned latent upscale model exposes the methods official nodes expect."""
    if model is None:
        return _FallbackLatentUpscaleModel(sd or {})

    required = ("parameters", "to", "cpu")
    if all(callable(getattr(model, attr, None)) for attr in required):
        return model

    source_sd = sd or {}
    if not source_sd and callable(getattr(model, "state_dict", None)):
        try:
            source_sd = model.state_dict() or {}
        except Exception:
            source_sd = {}
    return _FallbackLatentUpscaleModel(source_sd, model=model)


def _build_fallback_latent_upscale_model(sd, metadata=None):
    metadata = metadata or {}
    try:
        import importlib
        import torch
        comfy_model_management = importlib.import_module("comfy.model_management")
    except Exception:
        return _FallbackLatentUpscaleModel(sd)

    try:
        if "blocks.0.block.0.conv.weight" in sd:
            HunyuanVideo15SRModel = importlib.import_module("comfy.ldm.hunyuan_video.upsampler").HunyuanVideo15SRModel
            config = {
                "in_channels": sd["in_conv.conv.weight"].shape[1],
                "out_channels": sd["out_conv.conv.weight"].shape[0],
                "hidden_channels": sd["in_conv.conv.weight"].shape[0],
                "num_blocks": len([k for k in sd.keys() if k.startswith("blocks.") and k.endswith(".block.0.conv.weight")]),
                "global_residual": False,
            }
            model = HunyuanVideo15SRModel("720p", config)
            model.load_sd(sd)
            return _FallbackLatentUpscaleModel(sd, model=model)

        if "up.0.block.0.conv1.conv.weight" in sd:
            HunyuanVideo15SRModel = importlib.import_module("comfy.ldm.hunyuan_video.upsampler").HunyuanVideo15SRModel
            patched_sd = {key.replace("nin_shortcut", "nin_shortcut.conv", 1): value for key, value in sd.items()}
            config = {
                "z_channels": patched_sd["conv_in.conv.weight"].shape[1],
                "out_channels": patched_sd["conv_out.conv.weight"].shape[0],
                "block_out_channels": tuple(
                    patched_sd[f"up.{i}.block.0.conv1.conv.weight"].shape[0]
                    for i in range(len([k for k in patched_sd.keys() if k.startswith("up.") and k.endswith(".block.0.conv1.conv.weight")]))
                ),
            }
            model = HunyuanVideo15SRModel("1080p", config)
            model.load_sd(patched_sd)
            return _FallbackLatentUpscaleModel(patched_sd, model=model)

        if "post_upsample_res_blocks.0.conv2.bias" in sd:
            raw_config = metadata.get("config")
            if raw_config:
                if not isinstance(raw_config, str):
                    raw_config = json.dumps(raw_config)
                LatentUpsampler = importlib.import_module("comfy.ldm.lightricks.latent_upsampler").LatentUpsampler
                model = LatentUpsampler.from_config(json.loads(raw_config)).to(
                    dtype=comfy_model_management.vae_dtype(allowed_dtypes=[torch.bfloat16, torch.float32])
                )
                model.load_state_dict(sd)
                return _FallbackLatentUpscaleModel(sd, model=model)
    except Exception:
        pass

    return _FallbackLatentUpscaleModel(sd)


def _load_latent_upscale_model(model_name: str):
    import importlib
    errors = []

    for mod_name, cls_name in [
        ("comfy_extras.nodes_hunyuan", "LatentUpscaleModelLoader"),
        ("comfy_extras.nodes_upscale_model", "UpscaleModelLoader"),
        ("comfy_extras.nodes_model_downscale", "LatentUpscaleModelLoader"),
        ("nodes", "LatentUpscaleModelLoader"),
    ]:
        try:
            mod = importlib.import_module(mod_name)
            cls = getattr(mod, cls_name)
            inst = cls()
            for fn_name in ["load_model", "load_upscale_model", "execute"]:
                fn = getattr(inst, fn_name, None)
                if callable(fn):
                    try:
                        return _ensure_latent_upscale_model_compat(_unwrap_loader_output(fn(model_name)))
                    except TypeError:
                        try:
                            return _ensure_latent_upscale_model_compat(_unwrap_loader_output(fn(model_name,)))
                        except Exception as e:
                            errors.append(f"{mod_name}.{cls_name}.{fn_name}: {e}")
                    except Exception as e:
                        errors.append(f"{mod_name}.{cls_name}.{fn_name}: {e}")
        except Exception as e:
            errors.append(f"{mod_name}.{cls_name}: {e}")

    try:
        path = folder_paths.get_full_path_or_raise("latent_upscale_models", model_name)
        try:
            sd, metadata = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
        except TypeError:
            sd = comfy.utils.load_torch_file(path, safe_load=True)
            metadata = None
        return _ensure_latent_upscale_model_compat(_build_fallback_latent_upscale_model(sd, metadata), sd)
    except Exception as e:
        try:
            path = folder_paths.get_full_path_or_raise("upscale_models", model_name)
            try:
                sd, metadata = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
            except TypeError:
                sd = comfy.utils.load_torch_file(path, safe_load=True)
                metadata = None
            return _ensure_latent_upscale_model_compat(_build_fallback_latent_upscale_model(sd, metadata), sd)
        except Exception as fallback_error:
            raise RuntimeError(
                "空间放大模型加载失败。\n"
                f"需要文件：models/latent_upscale_models/{model_name}\n"
                "存放目录：models/latent_upscale_models/\n"
                "如果官方 latent upscale loader 不可用，先更新或启用 ComfyUI 官方节点，再重试。\n"
                + "官方加载器尝试结果："
                + _join_error_lines(errors)
                + f"\nlatent_upscale_models: {e}\nupscale_models: {fallback_error}"
            ) from fallback_error
def _load_ltx_audio_vae(ckpt_name: str):
    """Load LTX audio VAE with graceful fallback.

    Some ComfyUI builds do not ship LTXVAudioVAELoader at all. In that case we
    fall back to loading the selected checkpoint as a VAE state dict, so the
    universal loader does not hard-fail just because the optional official
    loader module is missing.
    """
    try:
        return _call_loader_class([
            "comfy_extras.nodes_lt_audio",
            "comfy_extras.nodes_ltxv",
            "comfy_extras.nodes_ltx",
            "nodes",
        ], "LTXVAudioVAELoader", ckpt_name)
    except Exception as loader_error:
        # 兼容没有 comfy_extras.nodes_ltxv / LTXVAudioVAELoader 的环境。
        # LTX 音频 VAE 通常放在 models/checkpoints；这里按普通 VAE 权重尝试加载。
        try:
            path = folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)
            try:
                sd, metadata = comfy.utils.load_torch_file(path, return_metadata=True)
            except TypeError:
                sd = comfy.utils.load_torch_file(path, safe_load=True)
                metadata = None
            sd = comfy.utils.state_dict_prefix_replace(
                sd,
                {"audio_vae.": "autoencoder.", "vocoder.": "vocoder."},
                filter_keys=True,
            )
            vae = comfy.sd.VAE(sd=sd, metadata=metadata)
            try:
                vae.throw_exception_if_invalid()
            except Exception:
                raise
            return vae
        except Exception as fallback_error:
            raise RuntimeError(
                "无法加载 LTX 音频 VAE。当前 ComfyUI 没有 LTXVAudioVAELoader，"
                "并且普通 VAE 兼容加载也失败。\n"
                f"官方加载器错误：{loader_error}\n"
                f"普通 VAE 回退错误：{fallback_error}\n"
                "解决：更新 ComfyUI / 安装包含 LTXVAudioVAELoader 的官方扩展，"
                "或确认该音频 VAE 权重可被 comfy.sd.VAE 直接加载。"
            ) from fallback_error



def _load_ltxav_text_encoder(text_encoder_name: str, ckpt_name: str, device: str = "default"):
    """Load LTXAV text encoder exactly like the official LTXAVTextEncoderLoader.

    Official node path: comfy_extras.nodes_lt_audio.LTXAVTextEncoderLoader
    It combines text_encoders/<gemma> + checkpoints/<ltx checkpoint> with CLIPType.LTXV.
    Loading Gemma alone as a normal CLIP produces wrong LTXAV cond dimensions.
    """
    import importlib
    errors: list[str] = []
    for mod_name in ["comfy_extras.nodes_lt_audio", "nodes"]:
        try:
            mod = importlib.import_module(mod_name)
            cls = getattr(mod, "LTXAVTextEncoderLoader")
            for fn in [getattr(cls, "execute", None)]:
                if fn is None or not callable(fn):
                    continue
                try:
                    return _unwrap_loader_output(fn(text_encoder_name, ckpt_name, device))
                except Exception as e:
                    errors.append(f"{mod_name}.LTXAVTextEncoderLoader.execute: {e}")
            raise RuntimeError("LTXAVTextEncoderLoader 没有 execute 方法")
        except Exception as e:
            errors.append(f"{mod_name}.LTXAVTextEncoderLoader: {e}")

    # Fallback: reproduce official node implementation directly.
    try:
        import torch
        clip_type = comfy.sd.CLIPType.LTXV
        clip_path1 = folder_paths.get_full_path_or_raise("text_encoders", text_encoder_name)
        clip_path2 = folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)
        model_options: dict[str, Any] = {}
        if str(device or "default") == "cpu":
            model_options["load_device"] = model_options["offload_device"] = torch.device("cpu")
        return comfy.sd.load_clip(
            ckpt_paths=[clip_path1, clip_path2],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=clip_type,
            model_options=model_options,
        )
    except Exception as fallback_error:
        raise RuntimeError(
            "无法加载 LTXAV 文本编码器。LTX2.3 不能只加载 Gemma 单文件，必须按官方 "
            "LTXAVTextEncoderLoader 使用 text_encoders/Gemma + checkpoints/LTX checkpoint 双文件加载。\n"
            f"官方加载器尝试结果：{' | '.join(errors)}\n"
            f"手动回退错误：{fallback_error}"
        ) from fallback_error



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


def _is_visible_output_slot(slot: dict[str, Any]) -> bool:
    if _is_lora_slot(slot):
        return False
    return str(slot.get("kind", "")).strip() not in {"empty", "name", "name_any"}


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


def _output_class_for_slot(slot: dict[str, Any]) -> str:
    kind = str(slot.get("kind", "") or "")
    slot_id = str(slot.get("id", "") or "")
    label = str(slot.get("label", "") or "")
    text = f"{slot_id} {label}".lower()

    if kind in {"diffusion", "checkpoint_model", "wanvideo_model"}:
        if "low" in text or "低" in text:
            return "universal_low_model"
        if "high" in text or "高" in text:
            return "universal_high_model"
        return "universal_main_model"
    if slot_id == "audio_vae" or kind == "ltx_audio_vae" or "音频vae" in label.lower():
        return "universal_audio_vae"
    if slot_id in {"video_vae", "vae", "wan_vae"} or kind in {"vae", "checkpoint_vae", "wan_vae"}:
        if slot_id == "alpha_vae" or "alpha" in text:
            return "universal_alpha_vae"
        if slot_id == "rgb_vae" or "rgb" in text:
            return "universal_rgb_vae"
        return "universal_video_vae"
    if kind in {"clip", "checkpoint_clip", "wan_t5_encoder"}:
        return "universal_text_encoder"
    if kind == "clip_vision":
        return "universal_clip_vision"
    if kind == "audio_encoder":
        return "universal_audio_encoder"
    if kind == "latent_upscale_model":
        return "universal_latent_upscale_model"
    if kind == "ltx_audio_vae":
        return "universal_audio_vae"
    return f"universal_{slot_id or kind or 'aux'}"


def _preferred_output_index(slot: dict[str, Any]) -> int:
    output_class = _output_class_for_slot(slot)
    if output_class in {"universal_high_model", "universal_main_model"}:
        return 0
    if output_class == "universal_low_model":
        return 1
    if output_class in {"universal_video_vae", "universal_rgb_vae", "universal_alpha_vae"}:
        return 2
    if output_class == "universal_audio_vae":
        return 3
    if output_class == "universal_text_encoder":
        return 4
    if output_class == "universal_clip_vision":
        return 5
    if output_class == "universal_audio_encoder":
        return 6
    if output_class == "universal_latent_upscale_model":
        return 7
    return 8


def _output_slots_for_config(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[tuple[int, int, dict[str, Any]]] = []
    for source_index, source_slot in enumerate(cfg.get("slots", [])):
        if not _is_visible_output_slot(source_slot):
            continue
        slot = dict(source_slot)
        slot["output_class"] = _output_class_for_slot(slot)
        records.append((_preferred_output_index(slot), source_index, slot))
    records.sort(key=lambda item: (item[0], item[1]))

    result: list[dict[str, Any]] = []
    for output_index, (_, _, slot) in enumerate(records[:MAX_SLOTS]):
        slot["output_index"] = output_index
        result.append(slot)
    return result


def _config_payload() -> dict[str, Any]:
    return {
        key: {
            "label": cfg.get("label", key),
            "clip_type": cfg.get("clip_type", "wan"),
            "uses_lora": any(_is_lora_slot(slot) for slot in cfg.get("slots", [])),
            "uses_extra_model_chain": bool(cfg.get("uses_extra_model_chain", False))
            or any(str(slot.get("kind", "")) == "wanvideo_model" for slot in cfg.get("slots", [])),
            # 输出槽只包含真正要给下游使用的对象；LoRA/名称槽只在节点内部使用，不暴露 STRING 输出。
            "output_slots": _output_slots_for_config(cfg),
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
        "官方流保留原有加载方式；KJ 流改为 UNET 主模型 + 双 CLIP + LTX23 视频/音频 VAE。"
    )
    SEARCH_ALIASES = ["MMV"]
    REQUIRED_MODELS = _build_ltx23_kj_required_models()
    GJJ_HELP = {
        "model_tree": True,
        "model_download_url": "https://pan.quark.cn/s/6ec846f1f58d",
        "models": _build_ltx23_kj_help_models(),
        "dependencies": [
            "ComfyUI 官方节点：UNETLoader / DualCLIPLoader / LTXAVTextEncoderLoader",
            "torch（ComfyUI 运行时基础依赖）",
        ],
    }

    # 后端仍保留 12 个 ANYTYPE 返回位以兼容旧工作流；前端按 output_slots 结构化增删真实可见输出口。
    # 每个可见口带 output_class/output_index，切换预设时按语义恢复连线，避免 high/low/VAE/CLIP 类型偏移。
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
            inputs[f"secondary_file_{i}"] = ("STRING", {
                "default": "",
                "display": "hidden",
                "hidden": True,
                "display_name": f"另一个模型{i}",
                "tooltip": "仅在双 CLIP 配置下使用；前端会显示为“另一个模型”。",
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
                "wan_runtime_args": (WAN_RUNTIME_ARGS_TYPE, {
                    "forceInput": True,
                    "display_name": "⚙️ Wan运行参数",
                    "tooltip": "一个入口兼容 WANCOMPILEARGS / BLOCKSWAPARGS / VRAM_MANAGEMENTARGS。WanVideoWrapper 集成预设会自动识别并传入模型加载器。",
                }),
                "extra_model_chain": ("EXTRA_MODEL_CHAIN", {
                    "forceInput": True,
                    "display_name": "🧩 额外模型配置",
                    "tooltip": "对齐 GJJ · 🧩 额外模型串联配置。WanVideoWrapper 集成预设会在加载主模型时合并这些额外模块。",
                }),
                # 注意顺序：LoRA 配置常态放前面；加速 LoRA BOOL 放后面，并由前端在无内置 LoRA 配置时隐藏。
                "lora_chain_config": ("LORA_CHAIN_CONFIG", {
                    "forceInput": True,
                    "display_name": "🧬 额外LoRA配置",
                    "tooltip": "对齐 GJJ · 🧬 LoRA串联配置 的输出口。开启加速 LoRA 时会额外叠加到 MODEL 输出。",
                }),
                "use_accel_lora_in": ("BOOLEAN", {
                    "forceInput": True,
                    "display_name": "🚕 加速LoRA",
                    "tooltip": "外部布尔控制加速 LoRA 开关；连接后优先使用外部输入。",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        keys = [
            "config",
            "clip_type_override",
            "use_accel_lora",
            "use_accel_lora_in",
            "🚕 加速LoRA",
            "lora_chain_config",
            "🧬 LoRA配置",
            "extra_model_chain",
            "🧩 额外模型配置",
            "wan_runtime_args",
            "⚙️ Wan运行参数",
        ]
        for i in range(1, MAX_SLOTS + 1):
            keys += [f"file_{i}", f"secondary_file_{i}", f"dtype_{i}"]
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
        extra_model_chain = _parse_extra_model_chain_config(
            kwargs.get("🧩 额外模型配置", kwargs.get("extra_model_chain", None))
        )
        wan_compile_args, wan_block_swap_args, wan_vram_management_args = _parse_wan_runtime_args(
            kwargs.get("⚙️ Wan运行参数", kwargs.get("wan_runtime_args", None))
        )
        slots = []
        for index, slot in enumerate(cfg.get("slots", []), start=1):
            current_slot = dict(slot)
            current_slot["_source_index"] = index
            slots.append(current_slot)
        output_layout = _output_slots_for_config({"slots": slots})
        output_index_by_source = {
            int(slot["_source_index"]): int(slot["output_index"])
            for slot in output_layout
            if "_source_index" in slot and "output_index" in slot
        }

        values: list[Any] = [None] * MAX_SLOTS
        output_records: list[dict[str, Any]] = []
        lora_items: list[dict[str, Any]] = []
        ckpt_cache: dict[str, tuple[Any, Any, Any]] = {}
        resolved_names: dict[str, str] = {}

        for index, slot in enumerate(slots, start=1):
            if index > MAX_SLOTS:
                break
            folder = str(slot.get("folder", "") or "")
            kind = str(slot.get("kind", "name") or "name")
            loader_kind = str(slot.get("loader", "") or "").lower()
            keywords = list(slot.get("keywords", []) or [])
            selected = str(kwargs.get(f"file_{index}", "") or "")
            dtype = str(kwargs.get(f"dtype_{index}", "default") or "default")

            if kind == "empty":
                continue

            allow_any = kind in {"name_any"}
            name = _resolve_selected(
                selected,
                folder,
                keywords,
                allow_any=allow_any,
                strict=bool(slot.get("strict", False)),
                preferred=str(slot.get("preferred_name", "") or slot.get("required_name", "") or ""),
            )

            if not name:
                raise _format_slot_runtime_error(
                    cfg.get("label", config_key),
                    slot,
                    RuntimeError("未找到匹配的本地模型文件。"),
                    selected_name=selected,
                )

            resolved_names[str(slot.get("id", f"slot_{index}"))] = name

            if _is_lora_slot(slot):
                lora_items.append({
                    "name": name,
                    "strength": 1.0,
                    "branch": _slot_branch(str(slot.get("id", "")), str(slot.get("label", ""))),
                    "slot": slot,
                })
                continue

            output_index = output_index_by_source.get(index)
            is_visible_output = output_index is not None and 0 <= output_index < MAX_SLOTS

            try:
                if kind == "diffusion":
                    if loader_kind == "unet":
                        value = _load_unet_model(name, dtype)
                    else:
                        value = _load_diffusion_model(name, dtype)
                elif kind == "wanvideo_model":
                    value = _load_wanvideo_model(
                        name,
                        slot,
                        extra_model_chain,
                        _slot_branch(str(slot.get("id", "")), str(slot.get("label", ""))),
                        compile_args=wan_compile_args,
                        block_swap_args=wan_block_swap_args,
                        vram_management_args=wan_vram_management_args,
                    )
                elif kind == "checkpoint_model":
                    value = _load_checkpoint_parts(name, ckpt_cache)[0]
                elif kind == "checkpoint_clip":
                    value = _load_checkpoint_parts(name, ckpt_cache)[1]
                elif kind == "checkpoint_vae":
                    value = _load_checkpoint_parts(name, ckpt_cache)[2]
                elif kind == "vae":
                    loader_kind = str(slot.get("loader", "") or "").lower()
                    if loader_kind == "gjj_vae":
                        value = _load_gjj_vae(
                            name,
                            str(slot.get("device", "main_device") or "main_device"),
                            str(slot.get("weight_dtype", "bf16") or "bf16"),
                        )
                    else:
                        value = _load_vae(name)
                elif kind == "ltx_audio_vae":
                    value = _load_ltx_audio_vae(name)
                elif kind == "clip":
                    loader_kind = str(slot.get("loader", "") or "").lower()
                    if loader_kind == "dual_clip":
                        secondary_name = str(kwargs.get(f"secondary_file_{index}", "") or "").strip()
                        if not secondary_name:
                            secondary_name = str(slot.get("secondary_name", "") or "").strip()
                        if not secondary_name:
                            raise _format_slot_runtime_error(
                                cfg.get("label", config_key),
                                slot,
                                RuntimeError("双CLIP配置缺少另一个模型。"),
                                selected_name=name,
                                secondary=True,
                            )
                        value = _load_dual_clip(
                            name,
                            secondary_name,
                            str(slot.get("clip_type", clip_type) or clip_type),
                            str(slot.get("device", "default") or "default"),
                        )
                    elif loader_kind == "ltxav_text_encoder":
                        ckpt_name = resolved_names.get("ckpt_model", "")
                        if not ckpt_name:
                            # 兜底：从当前配置中找第一个 checkpoint_model 槽位。
                            for prev_slot in cfg.get("slots", []):
                                if str(prev_slot.get("kind", "")) == "checkpoint_model":
                                    prev_index = cfg.get("slots", []).index(prev_slot) + 1
                                    ckpt_name = str(kwargs.get(f"file_{prev_index}", "") or "")
                                    if not ckpt_name:
                                        ckpt_name = _resolve_selected(
                                            "",
                                            str(prev_slot.get("folder", "checkpoints")),
                                            list(prev_slot.get("keywords", []) or []),
                                            preferred=str(prev_slot.get("preferred_name", "") or prev_slot.get("required_name", "") or ""),
                                        )
                                    break
                        if not ckpt_name:
                            raise _format_slot_runtime_error(
                                cfg.get("label", config_key),
                                slot,
                                RuntimeError("LTXAV 文本编码器需要先选择 LTX checkpoint。"),
                                selected_name=name,
                            )
                        value = _load_ltxav_text_encoder(name, ckpt_name, str(slot.get("device", "default") or "default"))
                    else:
                        value = _load_clip(name, clip_type, dtype)
                elif kind == "clip_vision":
                    value = _load_clip_vision(name)
                elif kind == "wan_t5_encoder":
                    value = _load_wan_t5_encoder(name, slot)
                elif kind == "wan_vae":
                    value = _load_wan_vae(name, slot)
                elif kind == "audio_encoder":
                    value = _load_audio_encoder(name)
                elif kind == "latent_upscale_model":
                    value = _load_latent_upscale_model(name)
                else:
                    value = name
            except Exception as exc:
                existing_text = str(exc or "")
                if existing_text.startswith(f"[{cfg.get('label', config_key)}]") and "需要文件：" in existing_text:
                    raise
                raise _format_slot_runtime_error(
                    cfg.get("label", config_key),
                    slot,
                    exc,
                    selected_name=name,
                ) from exc

            if is_visible_output:
                output_records.append({
                    "value_index": output_index,
                    "value": value,
                    "slot": slot,
                    "kind": kind,
                    "folder": folder,
                    "name": name,
                    "branch": _slot_branch(str(slot.get("id", "")), str(slot.get("label", ""))),
                })
                values[output_index] = value

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
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·🔵🟡🔴 智能视频模型加载🎞️官方流"}
