from __future__ import annotations

from typing import Any
import importlib.util
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

try:
    from .gjj_wanvideo_runtime_shims import ensure_optional_gguf_module
except Exception:  # pragma: no cover - keeps standalone syntax checks lightweight
    def ensure_optional_gguf_module():
        return None

try:
    from .common_utils.dependency_checker import (
        DEFAULT_MODEL_URL,
        build_dependency_model_report,
        print_dependency_model_report,
        raise_dependency_model_error,
        send_dependency_model_notice,
        get_report_from_exception,
        load_dependency_at_runtime,
    )
except Exception:  # pragma: no cover - keeps standalone syntax checks lightweight
    build_dependency_model_report = None
    DEFAULT_MODEL_URL = ""
    print_dependency_model_report = None
    raise_dependency_model_error = None
    send_dependency_model_notice = None
    get_report_from_exception = None
    load_dependency_at_runtime = None

NODE_NAME = "GJJ_VideoUniversalModelLoader"
NODE_DISPLAY_NAME = "GJJ·🔵🟡🔴 智能视频模型加载🎞️官方流"
LIST_API = "/gjj/video_universal_loader_lists"
MAX_SLOTS = 12
WAN_RUNTIME_ARGS_TYPE = "WANCOMPILEARGS,BLOCKSWAPARGS,VRAM_MANAGEMENTARGS"
GGUF_PACKAGE_SPEC = "gguf>=0.13.0"
MODEL_DOWNLOAD_URL = DEFAULT_MODEL_URL

DTYPES = ["default", "fp8_e4m3fn", "fp8_e5m2", "fp16", "bf16", "fp32"]
WEIGHT_DTYPES = ["bf16", "fp16", "fp32"]
WEIGHT_DTYPE_CHOICES = ["default", *WEIGHT_DTYPES]
CLIP_TYPES = ["auto", "wan", "ltxv", "hunyuan_video", "flux", "stable_diffusion", "minimax"]
MODEL_EXTENSIONS = {".ckpt", ".pt", ".pt2", ".bin", ".pth", ".safetensors", ".pkl", ".sft", ".gguf"}
WAN_BASE_PRECISIONS = ["fp32", "bf16", "fp16", "fp16_fast"]
WAN_QUANTIZATIONS = [
    "disabled",
    "fp8_e4m3fn",
    "fp8_e4m3fn_fast",
    "fp8_e4m3fn_scaled",
    "fp8_e4m3fn_scaled_fast",
    "fp8_e5m2",
    "fp8_e5m2_fast",
    "fp8_e5m2_scaled",
    "fp8_e5m2_scaled_fast",
]
WAN_LOAD_DEVICES = ["main_device", "offload_device"]
WAN_ATTENTION_MODES = ["sdpa", "flash_attn_2", "flash_attn_3", "sageattn", "sageattn_3", "radial_sage_attention", "sageattn_compiled", "sageattn_ultravico", "comfy"]
WAN_RMS_NORM_FUNCTIONS = ["default", "pytorch"]
WAN_VAE_PRECISIONS = ["bf16", "fp16", "fp32"]
WAN_T5_PRECISIONS = ["bf16", "fp32"]
WAN_T5_QUANTIZATIONS = ["disabled", "fp8_e4m3fn"]
EXTRA_BASE_PRECISIONS = ["fp16", "bf16", "fp32"]
WANVIDEO_RUNTIME_DEPENDENCIES = [
    {
        "module_name": "accelerate",
        "package_name": "accelerate",
        "display_name": "accelerate",
        "description": "WanVideo 模型、T5、CLIP 低内存权重初始化与设备分配必需。",
    },
    {
        "module_name": "transformers",
        "package_name": "transformers",
        "display_name": "transformers",
        "description": "WanVideo T5 tokenizer 与部分文本/音频编码器运行必需。",
    },
]

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


def _folder_entry_parts(entry: Any) -> tuple[Any, set[str], tuple[Any, ...]] | None:
    if not isinstance(entry, (list, tuple)) or len(entry) < 2:
        return None
    return entry[0], set(entry[1] or set()), tuple(entry[2:])


def _folder_entry_with_exts(
    paths: Any,
    extensions: set[str],
    extra: tuple[Any, ...] = (),
) -> tuple[Any, ...]:
    return (paths, extensions, *extra)


def _ensure_model_folder(folder_name: str) -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    current = _folder_entry_parts(existing.get(folder_name))
    if current:
        paths, exts, extra = current
        if not exts:
            existing[folder_name] = _folder_entry_with_exts(paths, MODEL_EXTENSIONS, extra)
        return

    paths = [path for path in _model_root_candidates(folder_name) if os.path.isdir(path)]
    if not paths:
        candidates = _model_root_candidates(folder_name)
        if candidates:
            paths = [candidates[0]]
    if paths:
        existing[folder_name] = (paths, MODEL_EXTENSIONS)


def _ensure_folder_extensions(folder_name: str, extensions: set[str]) -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    current = _folder_entry_parts(existing.get(folder_name))
    if not current:
        return
    paths, ext_set, extra = current
    merged = ext_set | set(extensions or set())
    if merged != ext_set:
        existing[folder_name] = _folder_entry_with_exts(paths, merged, extra)


def _ensure_unet_gguf_folder() -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    for target in ("diffusion_models", "unet"):
        current = _folder_entry_parts(existing.get(target))
        if not current:
            continue
        paths, ext_set, extra = current
        if ".gguf" not in ext_set:
            existing[target] = _folder_entry_with_exts(paths, ext_set | {".gguf"}, extra)
    if "unet_gguf" in existing:
        return
    for target in ("diffusion_models", "unet"):
        current = existing.get(target)
        if current and current[0]:
            paths = current[0] if isinstance(current[0], (list, tuple, set)) else [current[0]]
            existing["unet_gguf"] = (list(paths), {".gguf"})
            return
    models_dir = str(getattr(folder_paths, "models_dir", "") or "").strip()
    if models_dir:
        existing["unet_gguf"] = ([os.path.join(models_dir, "diffusion_models")], {".gguf"})


def _ensure_clip_gguf_folder() -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    paths: list[str] = []
    exts: set[str] = {".gguf"}
    current = _folder_entry_parts(existing.get("clip_gguf"))
    current_extra: tuple[Any, ...] = ()
    if current:
        current_paths, current_exts, current_extra = current
        paths.extend(str(path) for path in current_paths or [])
        exts.update(current_exts or set())
    for source in ("text_encoders", "clip"):
        source_entry = _folder_entry_parts(existing.get(source))
        if not source_entry:
            continue
        source_paths, _source_exts, _source_extra = source_entry
        paths.extend(str(path) for path in source_paths or [])
    models_dir = str(getattr(folder_paths, "models_dir", "") or "").strip()
    if models_dir:
        paths.append(os.path.join(models_dir, "clip_gguf"))

    unique: list[str] = []
    seen: set[str] = set()
    for path in paths:
        norm = os.path.normpath(str(path or ""))
        key = norm.lower()
        if norm and key not in seen:
            unique.append(norm)
            seen.add(key)
    if unique:
        existing["clip_gguf"] = _folder_entry_with_exts(unique, exts | {".gguf"}, current_extra)


_ensure_folder_extensions("checkpoints", {".gguf"})
_ensure_unet_gguf_folder()
_ensure_clip_gguf_folder()
_ensure_model_folder("sam2")


def _unique_folders(values: list[Any] | tuple[Any, ...]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        folder = str(value or "").strip().strip("/\\")
        if not folder:
            continue
        key = folder.lower()
        if key not in seen:
            result.append(folder)
            seen.add(key)
    return result


def _dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        text = str(value or "").strip()
        key = text.replace("\\", "/").lower()
        if not text or key in seen:
            continue
        result.append(text)
        seen.add(key)
    return result


def _slot_search_folders(slot: dict[str, Any], folder: str = "") -> list[str]:
    values: list[Any] = [folder or slot.get("folder", "")]
    extra = slot.get("search_folders", [])
    if isinstance(extra, str):
        values.append(extra)
    elif isinstance(extra, (list, tuple)):
        values.extend(extra)
    if str(slot.get("kind", "") or "").lower() == "latent_upscale_model":
        values.extend(["latent_upscale_models", "upscale_models"])
    if "diffusion_models" in {str(value or "").strip() for value in values}:
        values.append("unet_gguf")
    return _unique_folders(values)


def _folder_search_hint(folders: list[str] | tuple[str, ...]) -> str:
    clean = _unique_folders(list(folders))
    if not clean:
        return "ComfyUI 已配置的模型目录"
    if len(clean) == 1:
        return f"ComfyUI 已配置的 {clean[0]} 模型分类目录"
    return "ComfyUI 已配置的模型分类目录：" + " / ".join(clean)


# 官方文件名种子用于默认选择：匹配时会去子目录、扩展名、量化/精度标识后做最长公共片段匹配。
WAN_T5_NAMES = ["umt5_xxl_int4_convrot.safetensors","umt5_xxl_fp8_e4m3fn_scaled.safetensors", "umt5_xxl_fp16.safetensors"]
WAN21_VAE_NAMES = ["wan_2.1_vae.safetensors", "ComfyUI-wan_2.1_vae.safetensors", "Wan2_1_VAE_bf16.safetensors", "Wan2.1_VAE_bf16.safetensors"]
WAN22_VAE_NAMES = ["wan2.2_vae.safetensors"]
CLIP_VISION_H_NAMES = ["clip_vision_h.safetensors"]
SAM2_BASE_PLUS_NAMES = ["sam2_hiera_base_plus.safetensors", "sam2.1_hiera_base_plus-fp16.safetensors"]
WAN22_T2V_HIGH_NAMES = ["wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors", "Wan2_2-T2V-A14B_HIGH_fp8_e4m3fn_scaled_KJ.safetensors"]
WAN22_T2V_LOW_NAMES = ["wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors", "Wan2_2-T2V-A14B-LOW_fp8_e4m3fn_scaled_KJ.safetensors"]
WAN22_BERNINI_S2V_HIGH_NAMES = [
    "wan2.2_bernini_r_high_noise_int4_convrot_s2v.safetensors",
    "wan2.2_bernini_r_high_noise_int8_convrot_s2v.safetensors",
]
WAN22_BERNINI_S2V_LOW_NAMES = [
    "wan2.2_bernini_r_low_noise_int4_convrot_s2v.safetensors",
    "wan2.2_bernini_r_low_noise_int8_convrot_s2v.safetensors",
]
WAN22_I2V_HIGH_NAMES = ["wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", "wan2.2_i2v_high_noise_14B_fp16.safetensors"]
WAN22_I2V_LOW_NAMES = ["wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", "wan2.2_i2v_low_noise_14B_fp16.safetensors"]
WAN22_IS2V_HIGH_NAMES = [
    "wan2.2_is2v_high_noise_14B_int8_convrot.safetensors",
    "wan2.2_is2v_high_noise_14B_int4_convrot.safetensors",
    "wan2.2_is2v_high_noise_14B_fp16.safetensors",
]
WAN22_IS2V_LOW_NAMES = [
    "wan2.2_is2v_low_noise_14B_int8_convrot.safetensors",
    "wan2.2_is2v_low_noise_14B_int4_convrot.safetensors",
    "wan2.2_is2v_low_noise_14B_fp16.safetensors",
]
WAN22_REMIX_I2V_HIGH_NAMES = ["Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors"]
WAN22_REMIX_I2V_LOW_NAMES = ["Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors"]
WAN22_SMOOTHMIX_I2V_HIGH_NAMES = [
    "smoothMixWan22I2VT2V_i2vHigh.safetensors",
    "smoothMix_Wan2214B-I2V_i2v_V20_High.safetensors",
]
WAN22_SMOOTHMIX_I2V_LOW_NAMES = [
    "smoothMixWan22I2VT2V_i2vLow.safetensors",
    "smoothMix_Wan2214B-I2V_i2v_V20_Low.safetensors",
]
WAN22_RAPID_AIO_GGUF_NAMES = [
    "wan2.2-rapid-mega-aio-nsfw-v12.2-Q4_K.gguf",
    "wan2.2-rapid-mega-aio-nsfw-v12.2_Q4_K.gguf",
    "wan2.2-rapid-mega-aio-nsfw-v12.2-Q4_K_M.gguf",
    "wan2.2-rapid-mega-aio-nsfw-v12.2_Q4_K_M.gguf",
]
WAN22_RAPID_AIO_CLIP_GGUF_NAMES = ["umt5-xxl-encoder-Q4_K_M.gguf", "umt5-xxl-encoder-Q4_K.gguf"]
WAN22_RAPID_AIO_VAE_NAMES = ["wan_2.1_vae.safetensors", "ComfyUI-wan_2.1_vae.safetensors", "wan2.2_vae.safetensors", *WAN21_VAE_NAMES]
WAN22_I2V_LORA_HIGH_NAMES = ["Wan2.2_I2V_LightX2V_2step_high_noise.safetensors", "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"]
WAN22_I2V_LORA_LOW_NAMES = ["Wan2.2_I2V_LightX2V_2step_low_noise.safetensors", "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"]
WAN22_REMIX_I2V_LORA_HIGH_NAMES = ["wan/wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors"]
WAN22_REMIX_I2V_LORA_LOW_NAMES = ["wan/wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors"]
WAN22_T2V_LORA_HIGH_NAMES = ["wan/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors", "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors"]
WAN22_T2V_LORA_LOW_NAMES = ["wan/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors", "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors"]
WAN22_BERNINI_R_LORA_HIGH_NAMES = ["Bernini/Bernini-R_LightX2V_high_noise.safetensors", "Bernini-R_LightX2V_high_noise.safetensors"]
WAN22_BERNINI_R_LORA_LOW_NAMES = ["Bernini/Bernini-R_LightX2V_low_noise.safetensors", "Bernini-R_LightX2V_low_noise.safetensors"]
LTX23_CHECKPOINT_NAMES = ["ltx-2.3-22b-dev-fp8.safetensors", "ltx-2.3-22b-dev.safetensors"]
LTX23_DISTILL_LORA_NAMES = ["ltx-2.3-22b-distilled-lora-384.safetensors", "ltx-2.3-22b-distilled-lora-384-1.1.safetensors"]
LTX23_GEMMA_NAMES = ["gemma_3_12B_it_fp4_mixed.safetensors", "comfy_gemma_3_12B_it.safetensors", "gemma_3_12B_it_fp8_e4m3fn.safetensors"]
LTX23_GEMMA_LORA_NAMES = ["gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors", "NSFW/gemma3-NSFW/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors"]
LTX23_SPATIAL_UPSCALER_NAMES = ["ltx-2.3-spatial-upscaler-x2-1.0.safetensors", "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"]
LTX23_KJ_MODEL_NAMES = ["ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled_v2.safetensors", "ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors"]
LTX23_KJ_GEMMA_NAMES = ["gemma_3_12B_it_fp8_e4m3fn.safetensors"]
LTX23_TEXT_PROJECTION_NAMES = ["ltx-2.3_text_projection_bf16.safetensors"]
LTX23_VIDEO_VAE_NAMES = ["LTX23_video_vae_bf16.safetensors"]
LTX23_AUDIO_VAE_NAMES = ["LTX23_audio_vae_bf16.safetensors"]
LTX23_GGUF_MODEL_NAMES = ["ltx-2.3-22b-dev.gguf", "ltx-2.3-22b.gguf"]
LTX23_GGUF_GEMMA_NAMES = ["gemma-3-12b-it-Q2_K.gguf", "gemma-3-12b-it.gguf"]
LTX23_GGUF_TEXT_CONNECTOR_NAMES = ["ltx-2.3-22b-dev_embeddings_connectors.safetensors"]
LTX23_GGUF_VIDEO_VAE_NAMES = ["ltx-2.3-22b-dev_video_vae.safetensors"]
LTX23_GGUF_AUDIO_VAE_NAMES = ["ltx-2.3-22b-dev_audio_vae.safetensors"]
MINIMAX_H3_MODEL_NAMES = ["minimax_h3_fl2va_pruned_int8_convrot.safetensors"]
MINIMAX_H3_TEXT_ENCODER_NAMES = ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"]
MINIMAX_H3_VIDEO_VAE_NAMES = ["minimax_h3_video_vae_fp16.safetensors"]
MINIMAX_H3_AUDIO_VAE_NAMES = ["minimax_h3_audio_vae_fp32.safetensors"]


VIDEO_MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    "wan22_t2v_dual": {
        "label": "Wan2.2 T2V 文生视频官方流",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan2.2", "t2v", "high"], preferred_name=WAN22_T2V_HIGH_NAMES[0], official_names=WAN22_T2V_HIGH_NAMES),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan2.2", "t2v", "low"], preferred_name=WAN22_T2V_LOW_NAMES[0], official_names=WAN22_T2V_LOW_NAMES),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan2.2", "t2v", "lightx2v", "high"], preferred_name=WAN22_T2V_LORA_HIGH_NAMES[0], official_names=WAN22_T2V_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan2.2", "t2v", "lightx2v", "low"], preferred_name=WAN22_T2V_LORA_LOW_NAMES[0], official_names=WAN22_T2V_LORA_LOW_NAMES),
        ],
    },

    "wan22_bernini": {
        "label": "Bernini+多功能视频编辑",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["bernini", "high"], preferred_name=WAN22_T2V_HIGH_NAMES[0], official_names=WAN22_T2V_HIGH_NAMES, loader="unet"),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["bernini","low"], preferred_name=WAN22_T2V_LOW_NAMES[0], official_names=WAN22_T2V_LOW_NAMES, loader="unet"),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("high_lora", "High LoRA名称", "loras", "name", ["Bernini-R","lightx2v", "high"], preferred_name=WAN22_T2V_LORA_HIGH_NAMES[0], official_names=WAN22_T2V_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["Bernini-R","lightx2v","low"], preferred_name=WAN22_T2V_LORA_LOW_NAMES[0], official_names=WAN22_T2V_LORA_LOW_NAMES),
        ],
    },
    "wan22_bernini_s2v": {
        "label": "Bernini-R S2V 音频驱动",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["bernini", "s2v", "high"], preferred_name=WAN22_BERNINI_S2V_HIGH_NAMES[0], official_names=WAN22_BERNINI_S2V_HIGH_NAMES, loader="unet"),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["bernini", "s2v", "low"], preferred_name=WAN22_BERNINI_S2V_LOW_NAMES[0], official_names=WAN22_BERNINI_S2V_LOW_NAMES, loader="unet"),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("audio_encoder", "音频编码器", "audio_encoders", "audio_encoder", ["wav2vec2"], preferred_name="wav2vec2_large_english_fp16.safetensors", official_names=["wav2vec2_large_english_fp16.safetensors"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["Bernini-R", "lightx2v", "high"], preferred_name=WAN22_BERNINI_R_LORA_HIGH_NAMES[0], official_names=WAN22_BERNINI_R_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["Bernini-R", "lightx2v", "low"], preferred_name=WAN22_BERNINI_R_LORA_LOW_NAMES[0], official_names=WAN22_BERNINI_R_LORA_LOW_NAMES),
        ],
    },
    "wan22_is2v": {
        "label": "Wan2.2 IS2V 图片音频生视频",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "is2v", "high"], preferred_name=WAN22_IS2V_HIGH_NAMES[0], official_names=WAN22_IS2V_HIGH_NAMES, loader="unet"),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan", "is2v", "low"], preferred_name=WAN22_IS2V_LOW_NAMES[0], official_names=WAN22_IS2V_LOW_NAMES, loader="unet"),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
            S("audio_encoder", "音频编码器", "audio_encoders", "audio_encoder", ["wav2vec2"], preferred_name="wav2vec2_large_english_fp16.safetensors", official_names=["wav2vec2_large_english_fp16.safetensors"]),
            S("high_lora", "High LoRA名称", "loras", "name", ["Bernini-R", "lightx2v", "high"], preferred_name=WAN22_BERNINI_R_LORA_HIGH_NAMES[0], official_names=WAN22_BERNINI_R_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["Bernini-R", "lightx2v", "low"], preferred_name=WAN22_BERNINI_R_LORA_LOW_NAMES[0], official_names=WAN22_BERNINI_R_LORA_LOW_NAMES),
        ],
    },
    "wan22_Dancer": {
        "label": "Wan2.2 Dancer 舞蹈视频生成",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan", "dancer","global"], preferred_name="wan2.2_dancer_14b_global_fp8_scaled.safetensors", official_names="wan2.2_dancer_14b_global_fp8_scaled.safetensors", loader="unet"),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan","dancer","local"], preferred_name="wan2.2_dancer_14b_global_fp8_scaled.safetensors", official_names="wan2.2_dancer_14b_global_fp8_scaled.safetensors", loader="unet"),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
            S("high_lora", "High LoRA名称", "loras", "name", ["lightx2v", "i2v","cfg_step_distill"], preferred_name=WAN22_T2V_LORA_HIGH_NAMES[0], official_names=WAN22_T2V_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["lightx2v","i2v","cfg_step_distill"], preferred_name=WAN22_T2V_LORA_LOW_NAMES[0], official_names=WAN22_T2V_LORA_LOW_NAMES),
        ],
    },
    "wan22_remix": {
        "label": "REMIX NSFW 破限版",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["remix", "i2v", "14b", "high", "lighting"], preferred_name=WAN22_REMIX_I2V_HIGH_NAMES[0], official_names=WAN22_REMIX_I2V_HIGH_NAMES),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["remix", "i2v", "14b", "low", "lighting"], preferred_name=WAN22_REMIX_I2V_LOW_NAMES[0], official_names=WAN22_REMIX_I2V_LOW_NAMES),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan2.2", "i2v","lightx2v", "high"], preferred_name=WAN22_REMIX_I2V_LORA_HIGH_NAMES[0], official_names=WAN22_REMIX_I2V_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan2.2", "i2v","lightx2v", "low"], preferred_name=WAN22_REMIX_I2V_LORA_LOW_NAMES[0], official_names=WAN22_REMIX_I2V_LORA_LOW_NAMES),
        ],
    },
    "wan22_smoothMix": {
        "label": "SmoothMix NSFW 破限版",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["smooth","mix","i2v","high"], preferred_name=WAN22_SMOOTHMIX_I2V_HIGH_NAMES[0], official_names=WAN22_SMOOTHMIX_I2V_HIGH_NAMES),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["smooth","mix","i2v","low"], preferred_name=WAN22_SMOOTHMIX_I2V_LOW_NAMES[0], official_names=WAN22_SMOOTHMIX_I2V_LOW_NAMES),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan2.2", "i2v","lightx2v", "high"], preferred_name=WAN22_I2V_LORA_HIGH_NAMES[0], official_names=WAN22_I2V_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan2.2", "i2v","lightx2v", "low"], preferred_name=WAN22_I2V_LORA_LOW_NAMES[0], official_names=WAN22_I2V_LORA_LOW_NAMES),
        ],
    },
    "wan22_dasiwa": {
        "label": "Dasiwa NSFW 破限版",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["dasiwa","wan", "high"], preferred_name=WAN22_I2V_HIGH_NAMES[0], official_names=WAN22_I2V_HIGH_NAMES),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["dasiwa","wan","low"], preferred_name=WAN22_I2V_LOW_NAMES[0], official_names=WAN22_I2V_LOW_NAMES),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan2.2", "i2v","lightx2v", "high"], preferred_name=WAN22_I2V_LORA_HIGH_NAMES[0], official_names=WAN22_I2V_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan2.2", "i2v","lightx2v", "low"], preferred_name=WAN22_I2V_LORA_LOW_NAMES[0], official_names=WAN22_I2V_LORA_LOW_NAMES),
        ],
    },
    "wan22_i2v_dual": {
        "label": "Wan2.2 I2V 图生视频官方流",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan2.2", "i2v", "high"], preferred_name=WAN22_I2V_HIGH_NAMES[0], official_names=WAN22_I2V_HIGH_NAMES),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan2.2", "i2v", "low"], preferred_name=WAN22_I2V_LOW_NAMES[0], official_names=WAN22_I2V_LOW_NAMES),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan2.2", "i2v", "lightx2v", "high"], preferred_name=WAN22_I2V_LORA_HIGH_NAMES[0], official_names=WAN22_I2V_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan2.2", "i2v", "lightx2v", "low"], preferred_name=WAN22_I2V_LORA_LOW_NAMES[0], official_names=WAN22_I2V_LORA_LOW_NAMES),
        ],
    },
    "wan22_s2v_14b": {
        "label": "Wan2.2 S2V 音频驱动官方流",
        "clip_type": "wan",
        "slots": [
            S("model", "S2V模型", "diffusion_models", "diffusion", ["wan2.2", "s2v"], preferred_name="wan2.2_s2v_14B_fp8_scaled.safetensors", official_names=["wan2.2_s2v_14B_fp8_scaled.safetensors", "wan2.2_s2v_14B_bf16.safetensors"]),
            S("model2_empty", "", "", "empty", []),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("audio_encoder", "音频编码器", "audio_encoders", "audio_encoder", ["wav2vec2"], preferred_name="wav2vec2_large_english_fp16.safetensors", official_names=["wav2vec2_large_english_fp16.safetensors"]),
            S("lightx2v_lora", "S2V LoRA名称", "loras", "name", ["wan2.2", "t2v", "lightx2v", "high"], preferred_name=WAN22_T2V_LORA_HIGH_NAMES[0], official_names=WAN22_T2V_LORA_HIGH_NAMES),
        ],
    },
    "wan22_ti2v_5b": {
        "label": "Wan2.2 TI2V 5B图文官方流",
        "clip_type": "wan",
        "slots": [
            S("model", "TI2V模型", "diffusion_models", "diffusion", ["wan2.2", "ti2v"], preferred_name="wan2.2_ti2v_5B_fp16.safetensors", official_names=["wan2.2_ti2v_5B_fp16.safetensors"]),
            S("model2_empty", "", "", "empty", []),
            S("vae", "Wan2.2 VAE", "vae", "vae", ["wan2.2", "vae"], strict=True, preferred_name=WAN22_VAE_NAMES[0], official_names=WAN22_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
        ],
    },
    "wan22_flf2v_dual": {
        "label": "Wan2.2 FLF2V 首尾帧官方流",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan2.2", "i2v", "high"], preferred_name=WAN22_I2V_HIGH_NAMES[0], official_names=WAN22_I2V_HIGH_NAMES),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan2.2", "i2v", "low"], preferred_name=WAN22_I2V_LOW_NAMES[0], official_names=WAN22_I2V_LOW_NAMES),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan2.2", "i2v", "lightx2v", "high"], preferred_name=WAN22_I2V_LORA_HIGH_NAMES[0], official_names=WAN22_I2V_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan2.2", "i2v", "lightx2v", "low"], preferred_name=WAN22_I2V_LORA_LOW_NAMES[0], official_names=WAN22_I2V_LORA_LOW_NAMES),
        ],
    },
    "wan22_fun_camera_dual": {
        "label": "Wan2.2 Fun Camera 相机控制官方流",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan2.2", "fun", "camera", "high"], preferred_name="wan2.2_fun_camera_high_noise_14B_fp8_scaled.safetensors", official_names=["wan2.2_fun_camera_high_noise_14B_fp8_scaled.safetensors"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan2.2", "fun", "camera", "low"], preferred_name="wan2.2_fun_camera_low_noise_14B_fp8_scaled.safetensors", official_names=["wan2.2_fun_camera_low_noise_14B_fp8_scaled.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan2.2", "i2v", "lightx2v", "high"], preferred_name=WAN22_I2V_LORA_HIGH_NAMES[0], official_names=WAN22_I2V_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan2.2", "i2v", "lightx2v", "low"], preferred_name=WAN22_I2V_LORA_LOW_NAMES[0], official_names=WAN22_I2V_LORA_LOW_NAMES),
        ],
    },
    "wan22_fun_control_dual": {
        "label": "Wan2.2 Fun Control 双模型",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan2.2", "fun", "control", "high"], preferred_name="wan2.2_fun_control_high_noise_14B_fp8_scaled.safetensors", official_names=["wan2.2_fun_control_high_noise_14B_fp8_scaled.safetensors"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan2.2", "fun", "control", "low"], preferred_name="wan2.2_fun_control_low_noise_14B_fp8_scaled.safetensors", official_names=["wan2.2_fun_control_low_noise_14B_fp8_scaled.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan2.2", "i2v", "lightx2v", "high"], preferred_name=WAN22_I2V_LORA_HIGH_NAMES[0], official_names=WAN22_I2V_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan2.2", "i2v", "lightx2v", "low"], preferred_name=WAN22_I2V_LORA_LOW_NAMES[0], official_names=WAN22_I2V_LORA_LOW_NAMES),
        ],
    },
    "wan22_fun_inpaint_dual": {
        "label": "Wan2.2 Fun Inpaint 双模型 14B",
        "clip_type": "wan",
        "slots": [
            S("high_model", "High模型", "diffusion_models", "diffusion", ["wan2.2", "fun", "inpaint", "high"], preferred_name="wan2.2_fun_inpaint_high_noise_14B_fp8_scaled.safetensors", official_names=["wan2.2_fun_inpaint_high_noise_14B_fp8_scaled.safetensors"]),
            S("low_model", "Low模型", "diffusion_models", "diffusion", ["wan2.2", "fun", "inpaint", "low"], preferred_name="wan2.2_fun_inpaint_low_noise_14B_fp8_scaled.safetensors", official_names=["wan2.2_fun_inpaint_low_noise_14B_fp8_scaled.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("high_lora", "High LoRA名称", "loras", "name", ["wan2.2", "i2v", "lightx2v", "high"], preferred_name=WAN22_I2V_LORA_HIGH_NAMES[0], official_names=WAN22_I2V_LORA_HIGH_NAMES),
            S("low_lora", "Low LoRA名称", "loras", "name", ["wan2.2", "i2v", "lightx2v", "low"], preferred_name=WAN22_I2V_LORA_LOW_NAMES[0], official_names=WAN22_I2V_LORA_LOW_NAMES),
        ],
    },
    "wan21_t2v_13b": {
        "label": "Wan2.1 T2V 1.3B",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan2.1","t2v","3B"], preferred_name="wan2.1_t2v_1.3B_fp16.safetensors", official_names=["wan2.1_t2v_1.3B_fp16.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
        ],
    },
    "wan21_i2v": {
        "label": "Wan2.1 I2V 14B 图生视频",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan2.1", "i2v"], preferred_name="wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors", official_names=["wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors", "wan2.1_i2v_720p_14B_fp16.safetensors", "wan2.1_i2v_480p_14B_fp16.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5_xxl_in","umt5_xxl_fp"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
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
                official_names=["wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors", "wan2.1_i2v_720p_14B_fp16.safetensors"],
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
                official_names=WAN_T5_NAMES,
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
                official_names=CLIP_VISION_H_NAMES,
            ),
            S(
                "wan_vae",
                "WanVideo VAE",
                "vae",
                "wan_vae",
                ["wan", "vae"],
                preferred_name="Wan2.1_VAE_bf16.safetensors",
                official_names=WAN21_VAE_NAMES,
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
            S("model", "模型", "diffusion_models", "diffusion", ["wan2.1", "flf2v"], preferred_name="Wan2_1-FLF2V-14B-720P_fp8_e4m3fn.safetensors", official_names=["Wan2_1-FLF2V-14B-720P_fp8_e4m3fn.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
        ],
    },
    "wan21_vace": {
        "label": "Wan2.1 VACE 14B 可控生成",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan2.1", "vace"], preferred_name="wan2.1_vace_14B_fp8_e4m3fn.safetensors", official_names=["wan2.1_vace_14B_fp8_e4m3fn.safetensors", "wan2.1_vace_14B_fp16.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1","vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
        ],
    },
    "wan21_fun_camera": {
        "label": "Wan2.1 Fun Camera 1.3B",
        "clip_type": "wan",
        "slots": [
            S("model", "Fun Camera", "diffusion_models", "diffusion", ["wan2.1", "fun", "camera"], preferred_name="wan2.1_fun_camera_v1.1_1.3B_bf16.safetensors", official_names=["wan2.1_fun_camera_v1.1_1.3B_bf16.safetensors", "wan2.1_fun_camera_v1.1_14B_bf16.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
        ],},
    "wan21_fun_inp": {
        "label": "Wan2.1 Fun Inp 1.3B",
        "clip_type": "wan",
        "slots": [
            S("model", "Fun Inp", "diffusion_models", "diffusion", ["wan2.1", "fun", "inp"], preferred_name="Wan2.1-Fun-1.3B-InP.safetensors", official_names=["Wan2.1-Fun-1.3B-InP.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
        ],
    },
    "wan21_fun_control": {
        "label": "Wan2.1 Fun Control 1.3B",
        "clip_type": "wan",
        "slots": [
            S("model", "Fun Control", "diffusion_models", "diffusion", ["wan2.1", "fun", "control"], preferred_name="wan2.1_fun_control_1.3B_bf16.safetensors", official_names=["wan2.1_fun_control_1.3B_bf16.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
        ],
    },
    "wan21_ati_i2v": {
        "label": "Wan2.1 ATI I2V 14B",
        "clip_type": "wan",
        "slots": [
            S("model", "ATI模型", "diffusion_models", "diffusion", ["wan2.1", "ati", "i2v"], preferred_name="Wan2_1-I2V-ATI-14B_fp8_e4m3fn.safetensors", official_names=["Wan2_1-I2V-ATI-14B_fp8_e4m3fn.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
        ],
    },
    "wan21_alpha": {
        "label": "Wan Alpha 透明通道",
        "clip_type": "wan",
        "slots": [
            S("model", "模型", "diffusion_models", "diffusion", ["wan2.1_t2v_1.3B"], preferred_name="Wan2_1-AccVideo-T2V-14B_fp8_e4m3fn.safetensors", official_names=["wan2.1_t2v_1.3B_fp16.safetensors"]),
            S("rgb_vae", "RGB VAE", "vae", "vae", ["wan", "alpha", "rgb"], preferred_name="Wan21Alpha/wan_alpha_2.1_vae_rgb_channel.safetensors.safetensors", official_names=["Wan21Alpha/wan_alpha_2.1_vae_rgb_channel.safetensors.safetensors", "wan_alpha_2.1_vae_rgb_channel.safetensors.safetensors"]),
            S("alpha_vae", "Alpha VAE", "vae", "vae", ["wan", "alpha", "alpha"], preferred_name="Wan21Alpha/wan_alpha_2.1_vae_alpha_channel.safetensors.safetensors", official_names=["Wan21Alpha/wan_alpha_2.1_vae_alpha_channel.safetensors.safetensors", "wan_alpha_2.1_vae_alpha_channel.safetensors.safetensors"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("lightx2v_lora", "LightX2V LoRA名称", "loras", "name", ["lightx2v", "rank256"], preferred_name="wan/WANALPHA_lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank256_bf16.safetensors", official_names=["wan/WANALPHA_lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank256_bf16.safetensors", "lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors"]),
            S("alpha_lora", "Alpha LoRA名称", "loras", "name", ["epoch", "changed"], preferred_name="wan/epoch-13-1500_changed.safetensors", official_names=["wan/epoch-13-1500_changed.safetensors", "epoch-13-1500_changed.safetensors"]),
        ],
    },
    "wan21_wanmove_480p": {
        "label": "WanMove 480P",
        "clip_type": "wan",
        "slots": [
            S("model", "WanMove模型", "diffusion_models", "diffusion", ["wan21", "wanmove"], preferred_name="Wan21-WanMove_fp8_scaled_e4m3fn_KJ.safetensors", official_names=["Wan21-WanMove_fp8_scaled_e4m3fn_KJ.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
            S("lightx2v_lora", "LightX2V LoRA名称", "loras", "name", ["lightx2v", "i2v", "480p"], preferred_name="wan/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", official_names=["wan/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors"]),
        ],
    },
    "wan21_SCAIL": {
        "label": "Wan SCAIL2 动作迁移",
        "clip_type": "wan",
        "slots": [
            S("model", "WanMove模型", "diffusion_models", "diffusion", ["wan", "scail"], preferred_name="wan2.1_14B_SCAIL_2_fp8_scaled.safetensors", official_names=["wan2.1_14B_SCAIL_2_fp8_scaled.safetensors"]),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip", "T5编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES, prefer_default_dtype=True),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision", "_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
            S("lightx2v_lora", "LightX2V LoRA名称", "loras", "name", ["lightx2v", "i2v", "480p"], preferred_name="wan/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", official_names=["wan/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors"]),
        ],
    },
    "wan22_animate_14b": {
        "label": "Wan2.2 Animate 14B",
        "clip_type": "wan",
        "slots": [
            S("model", "Animate模型", "diffusion_models", "diffusion", ["wan2.2", "animate"], preferred_name="wan2.2_animate_14B_fp8_scaled_e4m3fn_KJ_v2.safetensors", official_names=["wan2.2_animate_14B_fp8_scaled_e4m3fn_KJ_v2.safetensors", "Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors", "wan2.2_animate_14B_bf16.safetensors"]),
            S("clip", "CLIP编码器", "text_encoders", "clip", ["umt5", "xxl"], preferred_name=WAN_T5_NAMES[0], official_names=WAN_T5_NAMES),
            S("vae", "VAE", "vae", "vae", ["wan_2.1_vae"], preferred_name=WAN21_VAE_NAMES[0], official_names=WAN21_VAE_NAMES),
            S("clip_vision", "CLIP视觉", "clip_vision", "clip_vision", ["clip_vision_h"], preferred_name=CLIP_VISION_H_NAMES[0], official_names=CLIP_VISION_H_NAMES),
            S("lightx2v_lora", "LightX2V LoRA名称", "loras", "name", ["lightx2v", "i2v", "480p"], preferred_name="wan/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", official_names=["wan/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors"]),
            S("relight_lora", "Relight LoRA名称", "loras", "name", ["wan", "animate", "relight"], preferred_name="wan/WanAnimate_relight_lora_fp16.safetensors", official_names=["wan/WanAnimate_relight_lora_fp16.safetensors", "WanAnimate_relight_lora_fp16.safetensors"]),
            S("dwpose", "DWPose名称", "controlnet", "name_any", ["dw", "ucoco"], preferred_name="DWPose/dw-ll_ucoco_384_bs5.torchscript.pt", official_names=["DWPose/dw-ll_ucoco_384_bs5.torchscript.pt", "dw-ll_ucoco_384_bs5.torchscript.pt"]),
            S(
                "sam2",
                "SAM2模型",
                "sam2",
                "name_any",
                ["sam2", "hiera", "base", "plus"],
                required_name="sam2_hiera_base_plus.safetensors",
                preferred_name=SAM2_BASE_PLUS_NAMES[0],
                official_names=SAM2_BASE_PLUS_NAMES,
                download_url=MODEL_DOWNLOAD_URL,
            ),
        ],
    },
    "ltx23_i2v_t2v": {
        "label": "LTX23 T2V / I2V官方流",
        "clip_type": "ltxv",
        "slots": [
            S("ckpt_model", "LTX Checkpoint模型", "checkpoints", "checkpoint_model", ["ltx2.3", "dev"], preferred_name=LTX23_CHECKPOINT_NAMES[0], official_names=LTX23_CHECKPOINT_NAMES),
            S("video_vae", "视频VAE", "checkpoints", "checkpoint_vae", ["ltx2.3", "dev"], preferred_name=LTX23_CHECKPOINT_NAMES[0], official_names=LTX23_CHECKPOINT_NAMES),
            S("audio_vae", "音频VAE", "checkpoints", "ltx_audio_vae", ["ltx2.3", "dev"], preferred_name=LTX23_CHECKPOINT_NAMES[0], official_names=LTX23_CHECKPOINT_NAMES),
            S("text_encoder", "Gemma文本编码器", "text_encoders", "clip", ["gemma", "it"], loader="ltxav_text_encoder", preferred_name=LTX23_GEMMA_NAMES[0], official_names=LTX23_GEMMA_NAMES),
            S("distill_lora", "Distill LoRA名称", "loras", "name", ["ltx2.3", "distilled", "lora"], preferred_name=LTX23_DISTILL_LORA_NAMES[0], official_names=LTX23_DISTILL_LORA_NAMES),
            S("gemma_lora", "Gemma LoRA名称", "loras", "name", ["gemma", "abliterated", "lora"], preferred_name=LTX23_GEMMA_LORA_NAMES[0], official_names=LTX23_GEMMA_LORA_NAMES),
            S("spatial_upscaler", "空间放大模型", "latent_upscale_models", "latent_upscale_model", ["ltx2.3", "spatial", "upscaler"], preferred_name=LTX23_SPATIAL_UPSCALER_NAMES[0], official_names=LTX23_SPATIAL_UPSCALER_NAMES),
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
                ["ltx"],
                loader="unet",
                required_name="ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled_v2.safetensors",
                preferred_name=LTX23_KJ_MODEL_NAMES[0],
                official_names=LTX23_KJ_MODEL_NAMES,
                download_url=MODEL_DOWNLOAD_URL,
            ),
            S(
                "clip",
                "双CLIP编码器",
                "text_encoders",
                "clip",
                ["gemma_3_12B_it"],
                loader="dual_clip",
                required_name="gemma_3_12B_it_fp8_e4m3fn.safetensors",
                preferred_name=LTX23_KJ_GEMMA_NAMES[0],
                official_names=LTX23_KJ_GEMMA_NAMES,
                download_url=MODEL_DOWNLOAD_URL,
                secondary_label="另一个模型",
                secondary_name="ltx-2.3_text_projection_bf16.safetensors",
                secondary_official_names=LTX23_TEXT_PROJECTION_NAMES,
                secondary_download_url=MODEL_DOWNLOAD_URL,
                device="default",
            ),
            S(
                "video_vae",
                "视频VAE",
                "vae",
                "vae",
                ["LTX23_video_vae"],
                loader="gjj_vae",
                device="main_device",
                weight_dtype="bf16",
                required_name="LTX23_video_vae_bf16.safetensors",
                preferred_name=LTX23_VIDEO_VAE_NAMES[0],
                official_names=LTX23_VIDEO_VAE_NAMES,
                download_url=MODEL_DOWNLOAD_URL,
            ),
            S(
                "audio_vae",
                "音频VAE",
                "vae",
                "vae",
                ["LTX23_audio_vae"],
                loader="gjj_vae",
                device="main_device",
                weight_dtype="bf16",
                required_name="LTX23_audio_vae_bf16.safetensors",
                preferred_name=LTX23_AUDIO_VAE_NAMES[0],
                official_names=LTX23_AUDIO_VAE_NAMES,
                download_url=MODEL_DOWNLOAD_URL,
            ),
            S(
                "spatial_upscaler",
                "空间放大模型",
                "latent_upscale_models",
                "latent_upscale_model",
                ["ltx-2.3-spatial-upscaler-x2-1.0"],
                search_folders=["upscale_models"],
                required_name="ltx-2.3-spatial-upscaler-x2-1.0.safetensors",
                preferred_name=LTX23_SPATIAL_UPSCALER_NAMES[0],
                official_names=LTX23_SPATIAL_UPSCALER_NAMES,
                download_url=MODEL_DOWNLOAD_URL,
            ),
        ],
    },
    "ltx23_i2v_t2v_gguf": {
        "label": "LTX23 T2V/I2V GGUF 低显存配置",
        "clip_type": "ltxv",
        "slots": [
            S(
                "model",
                "GGUF主模型",
                "diffusion_models",
                "diffusion",
                ["ltx","gguf"],
                loader="unet",
                preferred_name=LTX23_GGUF_MODEL_NAMES[0],
                official_names=LTX23_GGUF_MODEL_NAMES,
            ),
            S(
                "distill_lora",
                "Distill LoRA名称",
                "loras",
                "name",
                ["ltx2.3", "distilled", "lora"],
                preferred_name=LTX23_DISTILL_LORA_NAMES[0],
                official_names=LTX23_DISTILL_LORA_NAMES,
            ),
            S(
                "clip",
                "GGUF双CLIP编码器",
                "text_encoders",
                "clip",
                ["gemma","gguf"],
                loader="dual_clip",
                search_folders=["clip_gguf"],
                preferred_name=LTX23_GGUF_GEMMA_NAMES[0],
                official_names=LTX23_GGUF_GEMMA_NAMES,
                secondary_label="Embeddings Connectors",
                secondary_name="ltx-2.3-22b-dev_embeddings_connectors.safetensors",
                secondary_official_names=LTX23_GGUF_TEXT_CONNECTOR_NAMES,
                device="default",
            ),
            S(
                "video_vae",
                "视频VAE",
                "vae",
                "vae",
                ["ltx","video", "vae"],
                loader="gjj_vae",
                device="main_device",
                weight_dtype="bf16",
                required_name="ltx-2.3-22b-dev_video_vae.safetensors",
                preferred_name=LTX23_GGUF_VIDEO_VAE_NAMES[0],
                official_names=LTX23_GGUF_VIDEO_VAE_NAMES,
            ),
            S(
                "audio_vae",
                "音频VAE",
                "vae",
                "vae",
                ["ltx","audio", "vae"],
                loader="gjj_vae",
                device="main_device",
                weight_dtype="bf16",
                required_name="ltx-2.3-22b-dev_audio_vae.safetensors",
                preferred_name=LTX23_GGUF_AUDIO_VAE_NAMES[0],
                official_names=LTX23_GGUF_AUDIO_VAE_NAMES,
            ),
            S(
                "spatial_upscaler",
                "空间放大模型",
                "latent_upscale_models",
                "latent_upscale_model",
                ["ltx-2.3-spatial-upscaler"],
                search_folders=["upscale_models"],
                required_name="ltx-2.3-spatial-upscaler-x2-1.0.safetensors",
                preferred_name=LTX23_SPATIAL_UPSCALER_NAMES[0],
                official_names=LTX23_SPATIAL_UPSCALER_NAMES,
                download_url=MODEL_DOWNLOAD_URL,
            ),
        ],
    },
    "wan22_rapid_aio_gguf_lowvram": {
        "label": "Wan2.2 T2V/I2V GGUF 低显存配置",
        "clip_type": "wan",
        "slots": [
            S(
                "model",
                "Rapid AIO GGUF主模型",
                "diffusion_models",
                "diffusion",
                ["wan2.2", "rapid", "mega", "aio", "gguf"],
                loader="unet",
                preferred_name=WAN22_RAPID_AIO_GGUF_NAMES[0],
                official_names=WAN22_RAPID_AIO_GGUF_NAMES,
                disallow_q2_gguf=True,
            ),
            S(
                "clip",
                "Wan GGUF CLIP",
                "text_encoders",
                "clip",
                ["umt5", "xxl"],
                search_folders=["clip_gguf"],
                preferred_name=WAN22_RAPID_AIO_CLIP_GGUF_NAMES[0],
                official_names=[*WAN22_RAPID_AIO_CLIP_GGUF_NAMES, *WAN_T5_NAMES],
                weight_dtype="default",
            ),
            S(
                "vae",
                "Wan VAE",
                "vae",
                "vae",
                ["wan", "vae"],
                preferred_name=WAN22_RAPID_AIO_VAE_NAMES[0],
                official_names=WAN22_RAPID_AIO_VAE_NAMES,
            ),
        ],
    },
    "wan21_bernini_13b_lightx2v": {
        "label": "Wan2.1 Bernini 1.3B",
        "clip_type": "wan",
        "slots": [
            S(
                "model",
                "Bernini 1.3B模型",
                "diffusion_models",
                "diffusion",
                ["wan2.1", "bernini", "1.3b"],
                loader="unet",
                preferred_name="wan2.1_bernini_1.3B_int4_convrot.safetensors",
                official_names=["wan2.1_bernini_1.3B_int4_convrot.safetensors"],
            ),
            S(
                "clip",
                "CLIP编码器",
                "text_encoders",
                "clip",
                ["umt5", "xxl"],
                preferred_name="umt5_xxl_int4_convrot.safetensors",
                official_names=["umt5_xxl_int4_convrot.safetensors"],
            ),
            S(
                "vae",
                "VAE",
                "vae",
                "vae",
                ["wan_2.1_vae"],
                preferred_name="wan_2.1_vae.safetensors",
                official_names=WAN21_VAE_NAMES,
            ),
        ],
    },
    "minimax_h3": {
        "label": "海螺 MiniMax H3",
        "clip_type": "minimax",
        "slots": [
            S(
                "model",
                "MiniMax H3模型",
                "diffusion_models",
                "diffusion",
                ["minimax_h3_"],
                loader="unet",
                preferred_name=MINIMAX_H3_MODEL_NAMES[0],
                official_names=MINIMAX_H3_MODEL_NAMES,
            ),
            S(
                "video_vae",
                "视频VAE",
                "vae",
                "vae",
                ["minimax_h3_video_vae"],
                preferred_name=MINIMAX_H3_VIDEO_VAE_NAMES[0],
                official_names=MINIMAX_H3_VIDEO_VAE_NAMES,
            ),
            S(
                "audio_vae",
                "音频VAE",
                "vae",
                "vae",
                ["minimax_h3_audio_vae"],
                preferred_name=MINIMAX_H3_AUDIO_VAE_NAMES[0],
                official_names=MINIMAX_H3_AUDIO_VAE_NAMES,
            ),
            S(
                "clip",
                "Qwen3-VL 32B文本编码器",
                "text_encoders",
                "clip",
                ["qwen3vl_32b_"],
                strict=True,
                preferred_name=MINIMAX_H3_TEXT_ENCODER_NAMES[0],
                official_names=MINIMAX_H3_TEXT_ENCODER_NAMES,
            ),
        ],
    },
}

_CONFIG_FOLDERS: list[str] = []
for _cfg in VIDEO_MODEL_CONFIGS.values():
    for _slot in _cfg.get("slots", []):
        _CONFIG_FOLDERS.extend(_slot_search_folders(_slot, str(_slot.get("folder", "") or "")))
FOLDERS = sorted(set(_CONFIG_FOLDERS) | {"diffusion_models", "checkpoints", "loras", "vae", "text_encoders", "clip_vision", "controlnet", "audio_encoders", "latent_upscale_models", "upscale_models"})


def _model_rel_path(folder: str, filename: str) -> str:
    folder = str(folder or "").strip("/\\")
    filename = str(filename or "").strip("/\\")
    if not folder:
        return filename or "模型文件"
    if not filename:
        return folder
    return f"{folder}/{filename}"


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
        tooltip_lines.append(f"📁搜索目录：{_folder_search_hint(_slot_search_folders(slot, folder))}")
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
            "dest": _folder_search_hint(_slot_search_folders(slot, folder)),
        })
        secondary_name = str(slot.get("secondary_name", "") or "").strip()
        secondary_download_url = str(slot.get("secondary_download_url", "") or "").strip()
        if secondary_name:
            items.append({
                "filename": secondary_name,
                "url": secondary_download_url,
                "dest": _folder_search_hint(_slot_search_folders(slot, folder)),
            })
    return items


def _missing_wanvideo_runtime_dependencies() -> list[dict[str, str]]:
    missing: list[dict[str, str]] = []
    for spec in WANVIDEO_RUNTIME_DEPENDENCIES:
        module_name = str(spec.get("module_name", "") or "").strip()
        if not module_name:
            continue
        try:
            available = importlib.util.find_spec(module_name) is not None
        except Exception:
            available = False
        if not available:
            missing.append(dict(spec))
    return missing


def _raise_wanvideo_runtime_dependency_error(original_error: Any = "", unique_id: Any = None) -> None:
    missing = _missing_wanvideo_runtime_dependencies()
    if not missing:
        missing = [
            {
                "module_name": "accelerate",
                "package_name": "accelerate",
                "display_name": "accelerate",
                "description": "GJJ 内置 WanVideo runtime 导入失败时最常见的必需依赖。",
            }
        ]
    description = (
        "当前模型文件已经进入 WanVideo 加载流程，但 GJJ 内置 WanVideo runtime 缺少必需 Python 运行依赖。"
        "这不是 diffusion_models 目录里的模型文件缺失。"
    )
    packages = [item.get("package_name") or item.get("module_name") for item in missing]
    if callable(raise_dependency_model_error):
        raise_dependency_model_error(
            node_name="GJJ 智能视频模型加载",
            missing_dependencies=missing,
            install_packages=packages,
            description=description,
            original_error=str(original_error or ""),
            unique_id=unique_id,
            title="GJJ WanVideo runtime 依赖缺失！",
        )

    lines = [
        "⚠️缺失运行依赖，点击❓按钮了解详情。",
        "",
        description,
        "",
        "缺失依赖：" + "、".join(str(item.get("display_name") or item.get("package_name") or item.get("module_name")) for item in missing),
    ]
    if original_error:
        lines += ["", f"原始错误：{original_error}"]
    raise RuntimeError("\n".join(lines))


def _build_gguf_dependency_report(model_name: str, original_error: Any = "", model_kind: str = "模型") -> dict[str, Any]:
    if callable(build_dependency_model_report):
        report = build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[
                {
                    "module_name": "gguf",
                    "package_name": GGUF_PACKAGE_SPEC,
                    "display_name": "gguf",
                    "description": f"读取 .gguf {model_kind} 权重时需要；safetensors 模型不需要此依赖。",
                }
            ],
            install_packages=[GGUF_PACKAGE_SPEC],
            description=(
                f"当前 {model_kind} 选择的是 GGUF 模型：{model_name}\n"
                "GJJ 已内置 GGUF UNET 加载器，不需要安装 ComfyUI-GGUF 第三方节点。\n"
                "只需要安装/升级 gguf Python 依赖；或者改用 safetensors 模型。"
            ),
            original_error=str(original_error or ""),
        )
    else:
        report = {
            "panel_message": (
                f"检测到 GGUF {model_kind}：{model_name}\n"
                f"当前 ComfyUI Python 缺少 gguf 依赖，请安装 {GGUF_PACKAGE_SPEC} 后重启 ComfyUI。"
            ),
            "original_error": str(original_error or ""),
        }
    report["warning_message"] = "⚠️缺失 gguf 依赖，点击按钮复制安装命令。"
    report["description_message"] = report["warning_message"]
    report["copy_label"] = "📋 复制安装 gguf 依赖命令"
    report["model_download_url"] = ""
    return report


def _raise_gguf_dependency_missing(
    model_name: str,
    unique_id: Any = None,
    original_error: Any = "",
    model_kind: str = "模型",
) -> None:
    report = _build_gguf_dependency_report(model_name, original_error, model_kind=model_kind)
    if callable(print_dependency_model_report):
        print_dependency_model_report(report, title="GJJ 视频通用加载器 GGUF 依赖缺失！")
    if callable(send_dependency_model_notice):
        send_dependency_model_notice(report, unique_id=unique_id)
    err = RuntimeError(
        f"检测到 GGUF {model_kind}，但当前 ComfyUI Python 缺少 gguf 依赖。"
        "请点击面板按钮复制安装命令，或改用 safetensors 模型。"
    )
    setattr(err, "gjj_report", report)
    raise err


def _is_gguf_tokenizer_dependency_error(exc: BaseException | str) -> bool:
    module_name = str(getattr(exc, "name", "") or "").lower()
    if module_name in {"sentencepiece", "protobuf", "google.protobuf"}:
        return True
    error_text = str(exc or "").lower()
    return (
        "sentencepiece" in error_text
        or "protobuf" in error_text
        or "sentencepiece_model_pb2" in error_text
    )


def _raise_gguf_tokenizer_runtime_dependency(
    clip_name1: str,
    clip_name2: str,
    unique_id: Any = None,
    original_error: Any = "",
) -> None:
    description = (
        "当前 GGUF 双 CLIP 编码器需要从 Gemma GGUF 元数据重建 tokenizer。\n"
        f"Gemma GGUF：{clip_name1}\n"
        f"Embeddings Connectors：{clip_name2}\n"
        "请在 ComfyUI 使用的 Python 环境安装 sentencepiece 和 protobuf，安装后重启 ComfyUI。"
    )
    if callable(raise_dependency_model_error):
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[
                {
                    "module_name": "sentencepiece",
                    "package_name": "sentencepiece",
                    "display_name": "sentencepiece",
                    "description": "用于解析 GGUF 内的 Gemma sentencepiece tokenizer。",
                },
                {
                    "module_name": "google.protobuf",
                    "package_name": "protobuf",
                    "display_name": "protobuf",
                    "description": "sentencepiece tokenizer proto 解析依赖。",
                },
            ],
            install_packages=["sentencepiece", "protobuf"],
            description=description,
            original_error=str(original_error or ""),
            unique_id=unique_id,
            title="GJJ 节点运行时依赖缺失！",
            copy_label="📋 复制安装 sentencepiece/protobuf 命令",
        )
    raise RuntimeError(f"{description}\n\npip install sentencepiece protobuf")


def _ensure_gguf_tokenizer_runtime_dependencies(clip_name1: str, clip_name2: str, unique_id: Any = None) -> None:
    description = (
        "GGUF 双 CLIP 编码器需要从 Gemma GGUF 元数据重建 tokenizer。"
        "缺少该依赖时会在读取 gemma GGUF tokenizer 阶段失败。"
    )
    if callable(load_dependency_at_runtime):
        load_dependency_at_runtime(
            "sentencepiece",
            node_name=NODE_DISPLAY_NAME,
            package_name="sentencepiece",
            description=description,
            extra_packages=["protobuf"],
            unique_id=unique_id,
        )
        load_dependency_at_runtime(
            "google.protobuf",
            node_name=NODE_DISPLAY_NAME,
            package_name="protobuf",
            description=description,
            unique_id=unique_id,
        )
        return
    try:
        importlib.import_module("sentencepiece")
        importlib.import_module("google.protobuf")
    except Exception as exc:
        _raise_gguf_tokenizer_runtime_dependency(clip_name1, clip_name2, unique_id=unique_id, original_error=exc)


def _ensure_gguf_dependency(model_name: str, unique_id: Any = None, model_kind: str = "模型") -> None:
    gguf_module = ensure_optional_gguf_module()
    if getattr(gguf_module, "_GJJ_OPTIONAL_RUNTIME_STUB", False):
        _raise_gguf_dependency_missing(model_name, unique_id=unique_id, model_kind=model_kind)


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
        f"需要文件：{required_name}",
        f"搜索目录：{_folder_search_hint(_slot_search_folders(slot, folder))}",
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
        if "no module named" in lower_message:
            lines.append("提示：这是 Python 运行依赖缺失，不是模型文件缺失。")
        elif "cannot import name" in lower_message:
            lines.append("提示：这更像是 Python 依赖版本不兼容或运行库缺失，不是模型文件缺失。")
        elif "没有可调用" in message:
            lines.append("提示：这更像是 ComfyUI 官方加载器/节点缺失或版本过旧。")
        elif "not found" in lower_message or "未找到" in message or "no such file" in lower_message:
            lines.append("提示：这是模型文件缺失，请按上面的目录与文件名放置。")
        lines.append(f"原始错误：{message}")
    return RuntimeError("\n".join(lines))


def _filename_list(kind: str) -> list[str]:
    def read(folder: str) -> list[str]:
        try:
            return list(folder_paths.get_filename_list(folder))
        except Exception:
            return []

    def scan_ext(folder: str, extensions: tuple[str, ...]) -> list[str]:
        found: list[str] = []
        try:
            roots = folder_paths.get_folder_paths(folder)
        except Exception:
            roots = []
        for root in roots or []:
            root_path = os.path.normpath(str(root or ""))
            if not root_path or not os.path.isdir(root_path):
                continue
            for dirpath, _, filenames in os.walk(root_path):
                for filename in filenames:
                    if not filename.lower().endswith(extensions):
                        continue
                    full_path = os.path.join(dirpath, filename)
                    try:
                        rel = os.path.relpath(full_path, root_path)
                    except Exception:
                        rel = filename
                    found.append(rel.replace(os.sep, "/"))
        return found

    if kind == "diffusion_models":
        return _dedupe(read("unet_gguf") + read("diffusion_models") + scan_ext("diffusion_models", (".gguf",)))
    if kind == "checkpoints":
        return _dedupe(read("checkpoints") + scan_ext("checkpoints", (".gguf",)))
    return read(kind)


def _filename_list_for_folders(folders: list[str] | tuple[str, ...] | str) -> list[str]:
    if isinstance(folders, str):
        folders = [folders]
    result: list[str] = []
    seen: set[str] = set()
    for folder in _unique_folders(list(folders)):
        for name in _filename_list(folder):
            key = str(name).replace("\\", "/").lower()
            if key not in seen:
                result.append(name)
                seen.add(key)
    return result


def _is_gguf_model(value: Any) -> bool:
    return str(value or "").replace("\\", "/").lower().endswith(".gguf")


def _is_q2_gguf_model(value: Any) -> bool:
    text = str(value or "").replace("\\", "/").lower()
    return text.endswith(".gguf") and re.search(r"(?:^|[-_./])q2[_-]k(?:[-_./]|$)", text) is not None


def _is_usable_file(name: str, allow_any: bool = False) -> bool:
    lower = str(name or "").replace("\\", "/").lower().strip()
    if lower.endswith(".metadata.json"):
        return False
    exts = (".safetensors", ".sft", ".pt", ".pth", ".ckpt", ".bin", ".gguf", ".torchscript.pt") if allow_any else (".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".gguf")
    return lower.endswith(exts)


_SEARCH_DROP_TOKENS = {
    "fp", "fp8", "fp16", "fp32", "bf16", "int8", "int4", "nf4", "nvfp4", "mxfp4",
    "e4m3", "e4m3fn", "e5m2", "gguf", "bnb4bit", "bitsandbytes", "quant", "quantized",
    "input", "scaled", "scale", "fast", "dtype", "weight", "weights", "only",
}


def _strip_model_extension(value: Any) -> str:
    text = str(value or "").replace("\\", "/").strip()
    lower = text.lower()
    for suffix in (".torchscript.pt", ".safetensors", ".ckpt", ".pt2", ".pth", ".pt", ".bin", ".gguf", ".sft", ".pkl"):
        if lower.endswith(suffix):
            return text[:-len(suffix)]
    return text


def _clean_search_token(token: str) -> str:
    value = str(token or "").strip().lower()
    if not value:
        return ""
    if value in {"t2v", "i2v", "s2v", "ti2v", "flf2v", "f2v", "vace", "x2", "32b"}:
        return value
    if value in {"wan21", "wan22"}:
        return value
    if value == "wan2":
        return "wan"
    if value in {"ltx23"}:
        return value
    if re.fullmatch(r"ltx(?:2(?:3)?)", value):
        return "ltx"
    if re.fullmatch(r"gemma\d+", value):
        return "gemma"
    if value in _SEARCH_DROP_TOKENS:
        return ""
    if re.fullmatch(r"v?\d+(?:\.\d+)*", value):
        return ""
    if re.fullmatch(r"\d+(?:\.\d+)?b", value):
        return ""
    if re.fullmatch(r"(?:rank|dim|r)\d+", value):
        return ""
    if re.fullmatch(r"q\d(?:[_a-z0-9]*)?", value):
        return ""
    if re.fullmatch(r"(?:fp|bf|int)\d+(?:[_a-z0-9]*)?", value):
        return ""
    if re.fullmatch(r"e[45]m[23]fn?", value):
        return ""
    return value


def _search_tokens(value: Any) -> list[str]:
    text = _strip_model_extension(value).lower()
    text = re.sub(r"wan[\s._-]*2[\s._-]*1(?=$|[\s._-])", " wan21 wan ", text)
    text = re.sub(r"wan[\s._-]*2[\s._-]*2(?=$|[\s._-])", " wan22 wan ", text)
    text = re.sub(r"\bwan[\s._-]*21(?=$|[\s._-])", " wan21 wan ", text)
    text = re.sub(r"\bwan[\s._-]*22(?=$|[\s._-])", " wan22 wan ", text)
    text = re.sub(r"\bltx[\s._-]*2[\s._-]*3(?=$|[\s._-])", " ltx23 ltx ", text)
    text = re.sub(r"\bltx23(?=$|[\s._-])", " ltx23 ltx ", text)
    text = re.sub(r"\bgemma[\s._-]*3\b", " gemma ", text)
    parts = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", " ", text).split()
    tokens: list[str] = []
    seen: set[str] = set()
    for part in parts:
        token = _clean_search_token(part)
        if token and token not in seen:
            tokens.append(token)
            seen.add(token)
    return tokens


def _normalize_search_keywords(keywords: list[str] | tuple[str, ...]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for keyword in keywords or []:
        for token in _search_tokens(keyword):
            if token and token not in seen:
                result.append(token)
                seen.add(token)
    return result


def _normalize_fallback_keywords(value: Any) -> Any:
    if not isinstance(value, list):
        return value
    result: list[Any] = []
    for item in value:
        if isinstance(item, (list, tuple)):
            result.append(_normalize_search_keywords(list(item)))
        else:
            result.append(item)
    return result


def _slot_file_extension_filter(slot: dict[str, Any]) -> str:
    values: list[Any] = []
    values.extend(list(slot.get("keywords", []) or []))
    values.extend(list(slot.get("official_names", []) or []))
    values.append(slot.get("required_name", ""))
    values.append(slot.get("preferred_name", ""))
    text = " ".join(str(value or "") for value in values).lower()
    return "gguf" if re.search(r"\bgguf\b|\.gguf(?:$|[?#])", text) else ""


def _slot_payload(slot: dict[str, Any]) -> dict[str, Any]:
    result = dict(slot)
    result["keywords"] = _normalize_search_keywords(list(slot.get("keywords", []) or []))
    file_extension = _slot_file_extension_filter(slot)
    if file_extension:
        result["file_extension"] = file_extension
    if "fallback_keywords" in result:
        result["fallback_keywords"] = _normalize_fallback_keywords(result.get("fallback_keywords"))
    return result


def _infer_weight_dtype_from_model_name(name: Any) -> str:
    text = _strip_model_extension(name).lower()
    text = re.sub(r"[^0-9a-z]+", "_", text)
    for dtype in ("bf16", "fp16", "fp32"):
        if re.search(rf"(?:^|_){dtype}(?:_|$)", text):
            return dtype
    return ""


def _normalize_weight_dtype(value: Any, default: str = "bf16") -> str:
    text = str(value or default).strip().lower()
    return text if text in set(WEIGHT_DTYPES) else default


def _filter_names(
    names: list[str],
    keywords: list[str] | tuple[str, ...],
    allow_any: bool = False,
    file_extension: str = "",
) -> list[str]:
    words = _normalize_search_keywords(keywords)
    source = [n for n in names if _is_usable_file(n, allow_any=allow_any)]
    if str(file_extension or "").lower() == "gguf":
        source = [n for n in source if _is_gguf_model(n)]
    if not words:
        return source
    result: list[str] = []
    for name in source:
        text = _match_text(name)
        if all(w in text for w in words):
            result.append(name)
    return result


def _match_text(value: Any) -> str:
    return " ".join(_search_tokens(value))


_OFFICIAL_DROP_TOKENS = {
    "fp", "fp8", "fp16", "f16", "fp32", "bf16", "int8", "int4", "nf4", "nvfp4", "mxfp4",
    "e4m3", "e4m3fn", "e5m2", "gguf", "bnb4bit", "bitsandbytes", "quant", "quantized",
    "input", "scaled", "scale", "fast", "dtype", "weight", "weights", "only", "mixed",
}


def _model_basename_stem(value: Any) -> str:
    return _strip_model_extension(str(value or "").replace("\\", "/").split("/")[-1])


def _official_match_key(value: Any) -> str:
    text = _model_basename_stem(value).lower()
    text = re.sub(r"wan[\s._-]*2[\s._-]*1(?=$|[\s._-])", " wan21 ", text)
    text = re.sub(r"wan[\s._-]*2[\s._-]*2(?=$|[\s._-])", " wan22 ", text)
    text = re.sub(r"\bwan[\s._-]*21(?=$|[\s._-])", " wan21 ", text)
    text = re.sub(r"\bwan[\s._-]*22(?=$|[\s._-])", " wan22 ", text)
    text = re.sub(r"\bltx[\s._-]*2[\s._-]*3(?=$|[\s._-])", " ltx23 ", text)
    parts = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", " ", text).split()
    kept: list[str] = []
    for part in parts:
        token = part.lower()
        if token in _OFFICIAL_DROP_TOKENS:
            continue
        if re.fullmatch(r"(?:fp|bf|int)\d+(?:[_a-z0-9]*)?", token):
            continue
        if re.fullmatch(r"e[45]m[23]fn?", token):
            continue
        if re.fullmatch(r"q\d(?:[_a-z0-9]*)?", token) or token in {"k", "m", "s", "xl", "xs", "xxl"}:
            continue
        kept.append(token)
    return "".join(kept)


def _longest_common_substring_length(a: str, b: str) -> int:
    if not a or not b:
        return 0
    if len(a) > len(b):
        a, b = b, a
    previous = [0] * (len(a) + 1)
    best = 0
    for char_b in b:
        current = [0] * (len(a) + 1)
        for index, char_a in enumerate(a, start=1):
            if char_a == char_b:
                current[index] = previous[index - 1] + 1
                if current[index] > best:
                    best = current[index]
        previous = current
    return best


def _official_name_seeds(*values: Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        items = value if isinstance(value, (list, tuple)) else [value]
        for item in items:
            text = str(item or "").strip()
            key = text.replace("\\", "/").lower()
            if text and key not in seen:
                seen.add(key)
                result.append(text)
    return result


def _best_official_name_match(names: list[str], seeds: list[str], keywords: list[str], allow_any: bool = False, strict: bool = False) -> str:
    usable = [name for name in names if _is_usable_file(name, allow_any=allow_any)]
    if strict:
        usable = [name for name in usable if _name_matches_keywords(name, keywords, allow_any=allow_any)]
    if not usable or not seeds:
        return ""

    by_full = {str(name).replace("\\", "/").lower(): name for name in usable}
    by_base: dict[str, str] = {}
    for name in usable:
        by_base.setdefault(str(name).replace("\\", "/").split("/")[-1].lower(), name)

    for seed in seeds:
        full_key = str(seed).replace("\\", "/").strip().lower()
        base_key = full_key.split("/")[-1]
        if full_key in by_full:
            return by_full[full_key]
        if base_key in by_base:
            return by_base[base_key]

    best_name = ""
    best_score: tuple[int, int, int, str] = (0, 0, 0, "")
    seed_keys = [_official_match_key(seed) for seed in seeds]
    for name in usable:
        candidate_key = _official_match_key(name)
        if not candidate_key:
            continue
        for seed_key in seed_keys:
            if not seed_key:
                continue
            if candidate_key == seed_key:
                score = (100000 + len(seed_key), len(seed_key), -abs(len(candidate_key) - len(seed_key)), name.lower())
            elif seed_key in candidate_key or candidate_key in seed_key:
                common = min(len(seed_key), len(candidate_key))
                score = (50000 + common, common, -abs(len(candidate_key) - len(seed_key)), name.lower())
            else:
                common = _longest_common_substring_length(candidate_key, seed_key)
                score = (common, common, -abs(len(candidate_key) - len(seed_key)), name.lower())
            if score > best_score:
                best_score = score
                best_name = name
    return best_name if best_score[1] >= 6 else ""


def _score_name(name: str, keywords: list[str]) -> tuple[int, str]:
    text = _match_text(name)
    score = 0
    for i, kw in enumerate(_normalize_search_keywords(keywords)):
        if not kw:
            continue
        if kw in text:
            score += 100 - i
        if f"_{kw}" in text or f"-{kw}" in text:
            score += 10
    if text.endswith(".safetensors"):
        score += 10
    if text.endswith(".gguf"):
        score += 6
    score -= text.count("/")
    return (-score, text)


def _sort_matches(values: list[str], keywords: list[str]) -> list[str]:
    return sorted(values, key=lambda n: _score_name(n, keywords))


def _name_matches_keywords(name: str, keywords: list[str], allow_any: bool = False) -> bool:
    if allow_any:
        return True
    active = _normalize_search_keywords(keywords)
    if not active:
        return True
    text = _match_text(name)
    return all(k in text for k in active)


def _resolve_selected(
    selected: str,
    folder: str | list[str] | tuple[str, ...],
    keywords: list[str],
    allow_any: bool = False,
    strict: bool = False,
    preferred: str = "",
    official_names: list[str] | tuple[str, ...] | None = None,
    file_extension: str = "",
) -> str:
    names = _filename_list_for_folders(folder)
    if str(file_extension or "").lower() == "gguf":
        names = [name for name in names if _is_gguf_model(name)]
    selected = str(selected or "").strip()
    if selected and selected in names and (not strict or _name_matches_keywords(selected, keywords, allow_any=allow_any)):
        return selected
    if selected:
        selected_base = selected.replace("\\", "/").split("/")[-1].lower()
        for name in names:
            if name.replace("\\", "/").split("/")[-1].lower() == selected_base and (not strict or _name_matches_keywords(name, keywords, allow_any=allow_any)):
                return name
        selected_match = _best_official_name_match(names, [selected], keywords, allow_any=allow_any, strict=strict)
        if selected_match:
            return selected_match
    preferred = str(preferred or "").strip()
    if preferred and preferred in names and (not strict or _name_matches_keywords(preferred, keywords, allow_any=allow_any)):
        return preferred
    seeds = _official_name_seeds(preferred, official_names or [])
    official_match = _best_official_name_match(names, seeds, keywords, allow_any=allow_any, strict=strict)
    if official_match:
        return official_match
    matches = _sort_matches(_filter_names(names, keywords, allow_any=allow_any, file_extension=file_extension), keywords)
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


def _convrot_quantization_from_model_name(model_name: str) -> str:
    text = str(model_name or "").replace("\\", "/").lower()
    if "int4_convrot" in text or "convrot_w4a4" in text or "w4a4" in text:
        return "int4"
    if "int8_convrot" in text:
        return "int8"
    return ""


def _is_convrot_quantized_model(model_name: str) -> bool:
    return bool(_convrot_quantization_from_model_name(model_name))


def _dequantize_convrot_weight_tensor(sd: dict[str, Any], prefix: str, orig_shape: tuple[int, int], dtype: Any):
    weight_key = f"{prefix}.weight"
    quant_key = f"{prefix}.comfy_quant"
    scale_key = f"{prefix}.weight_scale"
    if weight_key not in sd or quant_key not in sd or scale_key not in sd:
        return None
    try:
        import torch
        from comfy.quant_ops import QuantizedTensor
        try:
            from comfy.quant_ops import TensorCoreConvRotW4A4Layout
        except ImportError as exc:
            raise RuntimeError(
                "当前 ComfyUI 不支持 INT4 ConvRot W4A4。"
                "请使用带 TensorCoreConvRotW4A4Layout 的 ComfyUI/ComfyUI-Quant 版本，"
                "或改选 int8_convrot / fp16 模型。"
            ) from exc

        conf_tensor = sd[quant_key]
        conf = json.loads(bytes(conf_tensor.detach().cpu().tolist()).decode("utf-8"))
        if str(conf.get("format", "")).lower() != "convrot_w4a4":
            return None
        params_conf = conf.get("params", {})
        if not isinstance(params_conf, dict):
            params_conf = {}
        params = TensorCoreConvRotW4A4Layout.Params(
            scale=sd[scale_key],
            convrot_groupsize=int(conf.get("convrot_groupsize", params_conf.get("convrot_groupsize", 256))),
            quant_group_size=64,
            linear_dtype=conf.get("linear_dtype", params_conf.get("linear_dtype", "int4")),
            orig_dtype=dtype or torch.float16,
            orig_shape=tuple(int(x) for x in orig_shape),
        )
        tensor = QuantizedTensor(sd[weight_key], "TensorCoreConvRotW4A4Layout", params).dequantize()
        return tensor.to(dtype=dtype or torch.float16, device="cpu").contiguous()
    except Exception as exc:
        raise RuntimeError(
            f"INT4 ConvRot 模型里的 {prefix}.weight 需要还原成普通张量，但当前环境还原失败：{exc}"
        ) from exc


def _patch_int4_convrot_embedding_tensors(sd: dict[str, Any]) -> bool:
    patched = False
    key = "trainable_cond_mask"
    if f"{key}.comfy_quant" not in sd:
        return False
    try:
        import torch

        dim = None
        head = sd.get("head.modulation")
        if head is not None and len(getattr(head, "shape", ())) > 0:
            dim = int(head.shape[-1])
        patch_embedding = sd.get("patch_embedding.weight")
        if dim is None and patch_embedding is not None and len(getattr(patch_embedding, "shape", ())) > 0:
            dim = int(patch_embedding.shape[0])
        q_weight = sd.get(f"{key}.weight")
        if dim is None and q_weight is not None and len(getattr(q_weight, "shape", ())) == 2:
            dim = int(q_weight.shape[1]) * 2
        if q_weight is None or dim is None:
            return False
        dtype = getattr(head, "dtype", None) or torch.float16
        restored = _dequantize_convrot_weight_tensor(sd, key, (int(q_weight.shape[0]), dim), dtype)
        if restored is None:
            return False
        sd[f"{key}.weight"] = restored
        sd.pop(f"{key}.weight_scale", None)
        sd.pop(f"{key}.comfy_quant", None)
        patched = True
    except Exception:
        raise
    return patched


def _load_convrot_quantized_diffusion_model(model_name: str, weight_dtype: str = "default", unique_id: Any = None):
    path = folder_paths.get_full_path_or_raise("diffusion_models", model_name)
    dtype = _torch_dtype(weight_dtype)
    sd, metadata = comfy.utils.load_torch_file(path, return_metadata=True)
    if str((metadata or {}).get("gjj_padded_convrot_version", "") or "").strip():
        try:
            from .gjj_padded_convrot_runtime import PADDED_CONVROT_AVAILABLE, _PATCH_ERROR
        except Exception as exc:
            raise RuntimeError(
                "该模型使用 GJJ 填充式 INT4 ConvRot，需要启用 ComfyUI_GJJ_Nodes 后重启 ComfyUI。"
            ) from exc
        if not PADDED_CONVROT_AVAILABLE:
            raise RuntimeError(
                "当前运行环境无法启用 GJJ 填充式 INT4 ConvRot。"
                f"运行时错误：{_PATCH_ERROR or '未知错误'}"
            )
    patched = _patch_int4_convrot_embedding_tensors(sd)
    model_options: dict[str, Any] = {}
    if dtype is not None:
        model_options["dtype"] = dtype
    model = comfy.sd.load_diffusion_model_state_dict(sd, model_options=model_options, metadata=metadata)
    if model is None:
        quant_label = (_convrot_quantization_from_model_name(model_name) or "ConvRot").upper()
        raise RuntimeError(f"ERROR: Could not detect {quant_label} model type of: {path}")
    model.cached_patcher_init = (_load_convrot_quantized_diffusion_model, (model_name, weight_dtype, unique_id))
    if patched:
        try:
            setattr(model, "gjj_int4_convrot_embedding_patch", True)
        except Exception:
            pass
    return model


def _load_unet_gguf(model_name: str, unique_id: Any = None):
    _ensure_gguf_dependency(model_name, unique_id=unique_id, model_kind="UNET")
    try:
        from ..vendor.gjj_gguf_runtime import load_unet_gguf as load_gjj_gguf_unet
    except ImportError:
        from vendor.gjj_gguf_runtime import load_unet_gguf as load_gjj_gguf_unet
    try:
        return load_gjj_gguf_unet(model_name)
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", "") == "gguf":
            _raise_gguf_dependency_missing(model_name, unique_id=unique_id, original_error=exc, model_kind="UNET")
        raise
    except Exception as exc:
        error_text = str(exc)
        if "No module named 'gguf'" in error_text or "需要先安装 gguf" in error_text:
            _raise_gguf_dependency_missing(model_name, unique_id=unique_id, original_error=exc, model_kind="UNET")
        raise RuntimeError(f"GJJ 内置 GGUF UNET 加载失败：{model_name}\n{exc}") from exc


def _load_ltx_checkpoint_gguf(ckpt_name: str, unique_id: Any = None) -> tuple[Any, Any, Any]:
    _ensure_gguf_dependency(ckpt_name, unique_id=unique_id, model_kind="LTX checkpoint")
    try:
        from ..vendor.gjj_gguf_runtime import load_ltx_checkpoint_gguf as load_gjj_ltx_checkpoint_gguf
    except ImportError:
        from vendor.gjj_gguf_runtime import load_ltx_checkpoint_gguf as load_gjj_ltx_checkpoint_gguf
    try:
        return load_gjj_ltx_checkpoint_gguf(ckpt_name)
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", "") == "gguf":
            _raise_gguf_dependency_missing(ckpt_name, unique_id=unique_id, original_error=exc, model_kind="LTX checkpoint")
        raise
    except Exception as exc:
        error_text = str(exc)
        if "No module named 'gguf'" in error_text or "需要先安装 gguf" in error_text:
            _raise_gguf_dependency_missing(ckpt_name, unique_id=unique_id, original_error=exc, model_kind="LTX checkpoint")
        raise RuntimeError(f"GJJ 内置 GGUF LTX checkpoint 加载失败：{ckpt_name}\n{exc}") from exc


def _load_ltxav_text_encoder_gguf(text_encoder_name: str, ckpt_name: str, device: str = "default", unique_id: Any = None):
    _ensure_gguf_dependency(ckpt_name, unique_id=unique_id, model_kind="LTXAV text encoder checkpoint")
    try:
        from ..vendor.gjj_gguf_runtime import load_ltxav_text_encoder_gguf as load_gjj_ltxav_text_encoder_gguf
    except ImportError:
        from vendor.gjj_gguf_runtime import load_ltxav_text_encoder_gguf as load_gjj_ltxav_text_encoder_gguf
    try:
        return load_gjj_ltxav_text_encoder_gguf(text_encoder_name, ckpt_name, device)
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", "") == "gguf":
            _raise_gguf_dependency_missing(ckpt_name, unique_id=unique_id, original_error=exc, model_kind="LTXAV text encoder checkpoint")
        raise
    except Exception as exc:
        error_text = str(exc)
        if "No module named 'gguf'" in error_text or "需要先安装 gguf" in error_text:
            _raise_gguf_dependency_missing(ckpt_name, unique_id=unique_id, original_error=exc, model_kind="LTXAV text encoder checkpoint")
        raise RuntimeError(f"GJJ 内置 GGUF LTXAV 文本编码器加载失败：{text_encoder_name} + {ckpt_name}\n{exc}") from exc


def _load_dual_clip_gguf(clip_name1: str, clip_name2: str, clip_type: str = "ltxv", device: str = "default", unique_id: Any = None):
    gguf_name = clip_name1 if _is_gguf_model(clip_name1) else clip_name2
    _ensure_gguf_dependency(gguf_name, unique_id=unique_id, model_kind="CLIP")
    _ensure_gguf_tokenizer_runtime_dependencies(clip_name1, clip_name2, unique_id=unique_id)
    try:
        from ..vendor.gjj_gguf_runtime import load_dual_clip_gguf as load_gjj_dual_clip_gguf
    except ImportError:
        from vendor.gjj_gguf_runtime import load_dual_clip_gguf as load_gjj_dual_clip_gguf
    try:
        return load_gjj_dual_clip_gguf(clip_name1, clip_name2, clip_type, device)
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", "") == "gguf":
            _raise_gguf_dependency_missing(gguf_name, unique_id=unique_id, original_error=exc, model_kind="CLIP")
        if _is_gguf_tokenizer_dependency_error(exc):
            _raise_gguf_tokenizer_runtime_dependency(clip_name1, clip_name2, unique_id=unique_id, original_error=exc)
        raise
    except Exception as exc:
        error_text = str(exc)
        if "No module named 'gguf'" in error_text or "需要先安装 gguf" in error_text:
            _raise_gguf_dependency_missing(gguf_name, unique_id=unique_id, original_error=exc, model_kind="CLIP")
        if _is_gguf_tokenizer_dependency_error(exc):
            _raise_gguf_tokenizer_runtime_dependency(clip_name1, clip_name2, unique_id=unique_id, original_error=exc)
        raise RuntimeError(f"GJJ 内置 GGUF 双CLIP加载失败：{clip_name1} + {clip_name2}\n{exc}") from exc


def _load_diffusion_model(model_name: str, weight_dtype: str = "default", unique_id: Any = None):
    if _is_gguf_model(model_name):
        return _load_unet_gguf(model_name, unique_id=unique_id)
    if _is_convrot_quantized_model(model_name):
        return _load_convrot_quantized_diffusion_model(model_name, weight_dtype, unique_id=unique_id)
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


def _load_unet_model(model_name: str, weight_dtype: str = "default", unique_id: Any = None):
    """Prefer the official UNETLoader shape used by the KJ workflow."""
    if _is_gguf_model(model_name):
        return _load_unet_gguf(model_name, unique_id=unique_id)
    if _is_convrot_quantized_model(model_name):
        return _load_convrot_quantized_diffusion_model(model_name, weight_dtype, unique_id=unique_id)
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
    return _load_diffusion_model(model_name, weight_dtype, unique_id=unique_id)


def _load_checkpoint_parts(
    ckpt_name: str,
    cache: dict[str, tuple[Any, Any, Any]],
    unique_id: Any = None,
) -> tuple[Any, Any, Any]:
    if ckpt_name in cache:
        return cache[ckpt_name]
    if _is_gguf_model(ckpt_name):
        cache[ckpt_name] = _load_ltx_checkpoint_gguf(ckpt_name, unique_id=unique_id)
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
        "minimax_h3": ["MINIMAX", "MINIMAX_H3", "MINIMAXH3", "minimax_h3"],
    }.get(raw, [raw, raw.upper()])
    for name in candidates:
        if hasattr(enum, name):
            return getattr(enum, name)
    return raw


def _load_clip(name: str, clip_type: str = "wan", weight_dtype: str = "default"):
    if _is_gguf_model(name):
        _ensure_gguf_dependency(name, model_kind="CLIP")
    path = folder_paths.get_full_path("text_encoders", name)
    if not path and _is_gguf_model(name):
        path = folder_paths.get_full_path("clip_gguf", name)
    if not path:
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


def _load_dual_clip(clip_name1: str, clip_name2: str, clip_type: str = "ltxv", device: str = "default", unique_id: Any = None):
    if _is_gguf_model(clip_name1) or _is_gguf_model(clip_name2):
        return _load_dual_clip_gguf(clip_name1, clip_name2, clip_type, device, unique_id=unique_id)

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
            "或对应模型文件不在 ComfyUI 已配置的 text_encoders 模型分类目录中。\n"
            f"需要文件：{clip_name1} + {clip_name2}\n"
            f"搜索目录：{_folder_search_hint(['text_encoders'])}\n"
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


def _load_wanvideo_runtime(unique_id: Any = None) -> dict[str, Any]:
    global _WANVIDEO_RUNTIME
    if _WANVIDEO_RUNTIME is not None:
        return _WANVIDEO_RUNTIME
    missing = _missing_wanvideo_runtime_dependencies()
    if missing:
        _raise_wanvideo_runtime_dependency_error(
            "缺少 " + "、".join(str(item.get("display_name") or item.get("package_name") or item.get("module_name")) for item in missing),
            unique_id=unique_id,
        )
    ensure_optional_gguf_module()
    try:
        from ..vendor.wanvideo_wrapper import nodes_model_loading
    except Exception as error:
        if "No module named" in str(error) or isinstance(error, ModuleNotFoundError):
            _raise_wanvideo_runtime_dependency_error(error, unique_id=unique_id)
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


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value if value is not None else "").strip().lower()
    if not text:
        return default
    if text in {"1", "true", "yes", "on", "启用", "开"}:
        return True
    if text in {"0", "false", "no", "off", "禁用", "关"}:
        return False
    return default


def _as_float(value: Any, default: float = 1.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _infer_quantization_from_model_name(name: Any) -> str:
    text = _model_basename_stem(name).lower()
    if str(name or "").replace("\\", "/").lower().endswith(".gguf"):
        return "disabled"
    text = re.sub(r"[^0-9a-z]+", "_", text)
    if "fp8" not in text:
        return ""
    if re.search(r"fp8_(?:e4m3fn_|e5m2_)?scaled_fast|fp8_scaled_(?:e4m3fn_|e5m2_)?fast", text):
        return "fp8_e5m2_scaled_fast" if "e5m2" in text else "fp8_e4m3fn_scaled_fast"
    if re.search(r"fp8_(?:e4m3fn_|e5m2_)?scaled|fp8_scaled(?:_(?:e4m3fn|e5m2))?", text):
        return "fp8_e5m2_scaled" if "e5m2" in text else "fp8_e4m3fn_scaled"
    if "e5m2" in text:
        return "fp8_e5m2_fast" if "fast" in text else "fp8_e5m2"
    return "fp8_e4m3fn_fast" if "fast" in text else "fp8_e4m3fn"


def _infer_dtype_from_model_name(name: Any) -> str:
    text = _model_basename_stem(name).lower()
    text = re.sub(r"[^0-9a-z]+", "_", text)
    if "fp8" in text:
        return "fp8_e5m2" if "e5m2" in text else "fp8_e4m3fn"
    for dtype in ("fp16", "bf16", "fp32"):
        if re.search(rf"(?:^|_){dtype}(?:_|$)", text):
            return dtype
    return ""


def _apply_slot_widget_settings(slot: dict[str, Any], index: int, kwargs: dict[str, Any]) -> dict[str, Any]:
    result = dict(slot)
    fields = {
        "base_precision": (set(WAN_BASE_PRECISIONS), "bf16"),
        "quantization": (set(WAN_QUANTIZATIONS), "disabled"),
        "load_device": (set(WAN_LOAD_DEVICES), "offload_device"),
        "attention_mode": (set(WAN_ATTENTION_MODES), "sdpa"),
        "rms_norm_function": (set(WAN_RMS_NORM_FUNCTIONS), "default"),
        "vae_precision": (set(WAN_VAE_PRECISIONS), "bf16"),
        "t5_precision": (set(WAN_T5_PRECISIONS), "bf16"),
        "t5_quantization": (set(WAN_T5_QUANTIZATIONS), "disabled"),
        "t5_load_device": (set(WAN_LOAD_DEVICES), "offload_device"),
        "extra_base_precision": (set(EXTRA_BASE_PRECISIONS), "fp16"),
        "weight_dtype": (set(WEIGHT_DTYPE_CHOICES), "bf16"),
    }
    for suffix, (allowed, default) in fields.items():
        raw = kwargs.get(f"{suffix}_{index}", None)
        if raw is None:
            continue
        value = _choice(raw, allowed, default)
        if suffix == "vae_precision":
            result["precision"] = value
        elif suffix == "t5_precision":
            result["precision"] = value
        elif suffix == "t5_load_device":
            result["load_device"] = value
        elif suffix == "extra_base_precision":
            result["base_precision"] = value
        else:
            result[suffix] = value
    if f"vae_use_cpu_cache_{index}" in kwargs:
        result["use_cpu_cache"] = _as_bool(kwargs.get(f"vae_use_cpu_cache_{index}"), bool(result.get("use_cpu_cache", False)))
    if f"lora_strength_{index}" in kwargs:
        result["strength"] = _as_float(kwargs.get(f"lora_strength_{index}"), float(result.get("strength", 1.0) or 1.0))
    if f"lora_merge_loras_{index}" in kwargs:
        result["merge_loras"] = _as_bool(kwargs.get(f"lora_merge_loras_{index}"), bool(result.get("merge_loras", False)))
    if f"lora_low_mem_load_{index}" in kwargs:
        result["low_mem_load"] = _as_bool(kwargs.get(f"lora_low_mem_load_{index}"), bool(result.get("low_mem_load", False)))
    return result


def _apply_name_derived_settings(slot: dict[str, Any], kind: str, name: str, dtype: str) -> tuple[dict[str, Any], str]:
    result = dict(slot)
    if kind == "wanvideo_model":
        quantization = _infer_quantization_from_model_name(name)
        if quantization in set(WAN_QUANTIZATIONS):
            result["quantization"] = quantization
    if kind in {"diffusion", "clip"}:
        inferred_dtype = _infer_dtype_from_model_name(name)
        if inferred_dtype in set(DTYPES):
            dtype = inferred_dtype
    return result, dtype


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
    unique_id: Any = None,
):
    runtime = _load_wanvideo_runtime(unique_id=unique_id)
    loader = runtime["model_loading"].WanVideoModelLoader()
    extra_kwargs = _build_wanvideo_extra_model_kwargs(extra_chain, model_branch)
    quantization = _choice(
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
    )
    if str(model_name or "").replace("\\", "/").lower().endswith(".gguf"):
        quantization = "disabled"
    return _unwrap_loader_output(
        loader.loadmodel(
            model=model_name,
            base_precision=_choice(slot.get("base_precision"), {"fp32", "bf16", "fp16", "fp16_fast"}, "bf16"),
            load_device=_choice(slot.get("load_device"), {"main_device", "offload_device"}, "offload_device"),
            quantization=quantization,
            attention_mode=str(slot.get("attention_mode", "sdpa") or "sdpa"),
            rms_norm_function=_choice(slot.get("rms_norm_function"), {"default", "pytorch"}, "default"),
            compile_args=compile_args,
            block_swap_args=block_swap_args,
            vram_management_args=vram_management_args,
            **extra_kwargs,
        )
    )


def _load_wan_t5_encoder(model_name: str, slot: dict[str, Any], unique_id: Any = None):
    runtime = _load_wanvideo_runtime(unique_id=unique_id)
    loader = runtime["model_loading"].LoadWanVideoT5TextEncoder()
    return _unwrap_loader_output(
        loader.loadmodel(
            model_name=model_name,
            precision=_choice(slot.get("precision"), {"bf16", "fp32"}, "bf16"),
            load_device=_choice(slot.get("load_device"), {"main_device", "offload_device"}, "offload_device"),
            quantization=_choice(slot.get("quantization"), {"disabled", "fp8_e4m3fn"}, "disabled"),
        )
    )


def _load_wan_vae(model_name: str, slot: dict[str, Any], unique_id: Any = None):
    runtime = _load_wanvideo_runtime(unique_id=unique_id)
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
                f"需要文件：{model_name}\n"
                f"搜索目录：{_folder_search_hint(['latent_upscale_models', 'upscale_models'])}\n"
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
    if _is_gguf_model(ckpt_name):
        return _load_ltx_checkpoint_gguf(ckpt_name)[2]
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
    if _is_gguf_model(ckpt_name):
        return _load_ltxav_text_encoder_gguf(text_encoder_name, ckpt_name, device)
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
            "slots": [_slot_payload(slot) for slot in cfg.get("slots", [])],
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
    CATEGORY = "GJJ/🧠 模型/加载"
    FUNCTION = "load_models"
    DESCRIPTION = (
        "视频通用模型加载器：按官方工作流配置扫描 models 子目录，动态显示模型下拉与输出槽。"
        "官方流保留原有加载方式；KJ 流改为 UNET 主模型 + 双 CLIP + LTX23 视频/音频 VAE。"
    )
    SEARCH_ALIASES = ["MMV"]
    # 模型槽会随“官方流”预设动态变化；固定 REQUIRED_MODELS 会让帮助窗串到别的预设。
    REQUIRED_MODELS = []
    GJJ_HELP = {
        "model_tree": True,
        "dynamic_model_tree_only": True,
        "model_download_url": MODEL_DOWNLOAD_URL,
        "notice": "模型树按当前选择的官方流和面板下拉动态生成；若刚刷新页面还没读取到模型列表，请先点一次节点或刷新模型列表。",
        "dependencies": [
            "ComfyUI 对应预设所需的官方模型加载节点",
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
            inputs[f"weight_dtype_{i}"] = (WEIGHT_DTYPE_CHOICES, {
                "default": "bf16",
                "display": "hidden",
                "hidden": True,
                "display_name": f"权重精度{i}",
                "tooltip": "根据模型文件名中的 bf16/fp16/fp32 后缀自动同步，主要用于 GJJ 兼容 VAE 加载。",
            })
            inputs[f"base_precision_{i}"] = (WAN_BASE_PRECISIONS, {"default": "bf16", "display": "hidden", "hidden": True, "display_name": f"Wan精度{i}", "tooltip": "WanVideoWrapper 主模型基础精度。"})
            inputs[f"quantization_{i}"] = (WAN_QUANTIZATIONS, {"default": "disabled", "display": "hidden", "hidden": True, "display_name": f"Wan量化{i}", "tooltip": "WanVideoWrapper 主模型量化方式；会从文件名中的 fp8/e4m3fn/scaled 自动同步。"})
            inputs[f"load_device_{i}"] = (WAN_LOAD_DEVICES, {"default": "offload_device", "display": "hidden", "hidden": True, "display_name": f"Wan设备{i}", "tooltip": "WanVideoWrapper 主模型加载设备。"})
            inputs[f"attention_mode_{i}"] = (WAN_ATTENTION_MODES, {"default": "sdpa", "display": "hidden", "hidden": True, "display_name": f"Wan注意力{i}", "tooltip": "WanVideoWrapper 主模型注意力实现。"})
            inputs[f"rms_norm_function_{i}"] = (WAN_RMS_NORM_FUNCTIONS, {"default": "default", "display": "hidden", "hidden": True, "display_name": f"Wan RMS{i}", "tooltip": "WanVideoWrapper RMS Norm 实现。"})
            inputs[f"vae_precision_{i}"] = (WAN_VAE_PRECISIONS, {"default": "bf16", "display": "hidden", "hidden": True, "display_name": f"Wan VAE精度{i}", "tooltip": "WanVideoWrapper VAE 加载精度。"})
            inputs[f"vae_use_cpu_cache_{i}"] = ("BOOLEAN", {"default": False, "display": "hidden", "hidden": True, "display_name": f"Wan VAE缓存{i}", "tooltip": "WanVideoWrapper VAE CPU 缓存开关。"})
            inputs[f"t5_precision_{i}"] = (WAN_T5_PRECISIONS, {"default": "bf16", "display": "hidden", "hidden": True, "display_name": f"Wan T5精度{i}", "tooltip": "WanVideoWrapper T5 编码器精度。"})
            inputs[f"t5_quantization_{i}"] = (WAN_T5_QUANTIZATIONS, {"default": "disabled", "display": "hidden", "hidden": True, "display_name": f"Wan T5量化{i}", "tooltip": "WanVideoWrapper T5 编码器量化方式。"})
            inputs[f"t5_load_device_{i}"] = (WAN_LOAD_DEVICES, {"default": "offload_device", "display": "hidden", "hidden": True, "display_name": f"Wan T5设备{i}", "tooltip": "WanVideoWrapper T5 编码器加载设备。"})
            inputs[f"extra_base_precision_{i}"] = (EXTRA_BASE_PRECISIONS, {"default": "fp16", "display": "hidden", "hidden": True, "display_name": f"扩展模型精度{i}", "tooltip": "FantasyTalking/FantasyPortrait 等扩展模型基础精度。"})
            inputs[f"lora_strength_{i}"] = ("FLOAT", {"default": 1.0, "display": "hidden", "hidden": True, "display_name": f"LoRA强度{i}", "tooltip": "内置 LoRA 强度。"})
            inputs[f"lora_merge_loras_{i}"] = ("BOOLEAN", {"default": False, "display": "hidden", "hidden": True, "display_name": f"LoRA合并{i}", "tooltip": "预留给 Wan LoRA 加载器的合并开关。"})
            inputs[f"lora_low_mem_load_{i}"] = ("BOOLEAN", {"default": False, "display": "hidden", "hidden": True, "display_name": f"LoRA低显存{i}", "tooltip": "预留给 Wan LoRA 加载器的低显存开关。"})
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
            "hidden": {
                "unique_id": "UNIQUE_ID",
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
            keys += [
                f"file_{i}", f"secondary_file_{i}", f"dtype_{i}", f"weight_dtype_{i}",
                f"base_precision_{i}", f"quantization_{i}", f"load_device_{i}", f"attention_mode_{i}", f"rms_norm_function_{i}",
                f"vae_precision_{i}", f"vae_use_cpu_cache_{i}", f"t5_precision_{i}", f"t5_quantization_{i}", f"t5_load_device_{i}",
                f"extra_base_precision_{i}", f"lora_strength_{i}", f"lora_merge_loras_{i}", f"lora_low_mem_load_{i}",
            ]
        return "|".join(str(kwargs.get(k, "")) for k in keys)

    def load_models(self, *args, **kwargs):
        # 只按名称读取，故意忽略位置参数，避免动态面板/输入口/输出口变化引起参数错位。
        unique_id = kwargs.get("unique_id", None)
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
            current_slot = _apply_slot_widget_settings(current_slot, index, kwargs)
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
            search_folders = _slot_search_folders(slot, folder)
            kind = str(slot.get("kind", "name") or "name")
            loader_kind = str(slot.get("loader", "") or "").lower()
            keywords = _normalize_search_keywords(list(slot.get("keywords", []) or []))
            selected = str(kwargs.get(f"file_{index}", "") or "")
            dtype = str(kwargs.get(f"dtype_{index}", "default") or "default")
            file_extension = _slot_file_extension_filter(slot)

            if kind == "empty":
                continue

            allow_any = kind in {"name_any"}
            name = _resolve_selected(
                selected,
                search_folders,
                keywords,
                allow_any=allow_any,
                strict=bool(slot.get("strict", False)),
                preferred=str(slot.get("preferred_name", "") or slot.get("required_name", "") or ""),
                official_names=list(slot.get("official_names", []) or []),
                file_extension=file_extension,
            )

            if not name:
                raise _format_slot_runtime_error(
                    cfg.get("label", config_key),
                    slot,
                    RuntimeError("未找到匹配的本地模型文件。"),
                    selected_name=selected,
                )

            slot_id = str(slot.get("id", f"slot_{index}"))
            resolved_names[slot_id] = name
            if bool(slot.get("disallow_q2_gguf", False)) and _is_q2_gguf_model(name):
                raise RuntimeError(
                    f"[{cfg.get('label', config_key)}] 当前 AIO GGUF 主模型不支持 Q2_K，容易输出噪声/花屏视频。\n"
                    f"当前选择：{name}\n"
                    "请改用 Q4_K / Q4_K_M 或更高量化。"
                )
            slot, dtype = _apply_name_derived_settings(slot, kind, name, dtype)

            if _is_lora_slot(slot):
                lora_items.append({
                    "name": name,
                    "strength": float(slot.get("strength", 1.0) or 1.0),
                    "branch": _slot_branch(str(slot.get("id", "")), str(slot.get("label", ""))),
                    "slot": slot,
                })
                continue

            output_index = output_index_by_source.get(index)
            is_visible_output = output_index is not None and 0 <= output_index < MAX_SLOTS

            try:
                if kind == "diffusion":
                    if loader_kind == "unet":
                        value = _load_unet_model(name, dtype, unique_id=unique_id)
                    else:
                        value = _load_diffusion_model(name, dtype, unique_id=unique_id)
                elif kind == "wanvideo_model":
                    value = _load_wanvideo_model(
                        name,
                        slot,
                        extra_model_chain,
                        _slot_branch(str(slot.get("id", "")), str(slot.get("label", ""))),
                        compile_args=wan_compile_args,
                        block_swap_args=wan_block_swap_args,
                        vram_management_args=wan_vram_management_args,
                        unique_id=unique_id,
                    )
                elif kind == "checkpoint_model":
                    value = _load_checkpoint_parts(name, ckpt_cache, unique_id=unique_id)[0]
                elif kind == "checkpoint_clip":
                    value = _load_checkpoint_parts(name, ckpt_cache, unique_id=unique_id)[1]
                elif kind == "checkpoint_vae":
                    value = _load_checkpoint_parts(name, ckpt_cache, unique_id=unique_id)[2]
                elif kind == "vae":
                    loader_kind = str(slot.get("loader", "") or "").lower()
                    if loader_kind == "gjj_vae":
                        weight_dtype = _normalize_weight_dtype(
                            _infer_weight_dtype_from_model_name(name)
                            or kwargs.get(f"weight_dtype_{index}", "")
                            or slot.get("weight_dtype", "bf16"),
                            str(slot.get("weight_dtype", "bf16") or "bf16"),
                        )
                        value = _load_gjj_vae(
                            name,
                            str(slot.get("device", "main_device") or "main_device"),
                            weight_dtype,
                        )
                    else:
                        value = _load_vae(name)
                elif kind == "ltx_audio_vae":
                    value = _load_ltx_audio_vae(name)
                elif kind == "clip":
                    loader_kind = str(slot.get("loader", "") or "").lower()
                    if loader_kind == "dual_clip":
                        secondary_name = str(kwargs.get(f"secondary_file_{index}", "") or "").strip()
                        secondary_name = _resolve_selected(
                            secondary_name,
                            search_folders,
                            _normalize_search_keywords([slot.get("secondary_name", "")] + list(slot.get("secondary_keywords", []) or [])),
                            preferred=str(slot.get("secondary_name", "") or ""),
                            official_names=list(slot.get("secondary_official_names", []) or []),
                        )
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
                            unique_id=unique_id,
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
                                        prev_search_folders = _slot_search_folders(prev_slot, str(prev_slot.get("folder", "checkpoints")))
                                        ckpt_name = _resolve_selected(
                                            "",
                                            prev_search_folders,
                                            _normalize_search_keywords(list(prev_slot.get("keywords", []) or [])),
                                            preferred=str(prev_slot.get("preferred_name", "") or prev_slot.get("required_name", "") or ""),
                                            official_names=list(prev_slot.get("official_names", []) or []),
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
                        if bool(slot.get("prefer_default_dtype", False)) and dtype != "default":
                            try:
                                value = _load_clip(name, clip_type, "default")
                            except Exception as default_exc:
                                try:
                                    value = _load_clip(name, clip_type, dtype)
                                except Exception as dtype_exc:
                                    raise RuntimeError(
                                        "CLIP/T5 智能加载失败：已尝试 default 和文件名推断 dtype。\n"
                                        f"default 错误：{default_exc}\n"
                                        f"推断 dtype({dtype}) 错误：{dtype_exc}"
                                    ) from dtype_exc
                        else:
                            value = _load_clip(name, clip_type, dtype)
                elif kind == "clip_vision":
                    value = _load_clip_vision(name)
                elif kind == "wan_t5_encoder":
                    value = _load_wan_t5_encoder(name, slot, unique_id=unique_id)
                elif kind == "wan_vae":
                    value = _load_wan_vae(name, slot, unique_id=unique_id)
                elif kind == "audio_encoder":
                    value = _load_audio_encoder(name)
                elif kind == "latent_upscale_model":
                    value = _load_latent_upscale_model(name)
                else:
                    value = name
            except Exception as exc:
                report = get_report_from_exception(exc) if callable(get_report_from_exception) else None
                if report:
                    if callable(send_dependency_model_notice):
                        send_dependency_model_notice(report, unique_id=unique_id)
                    raise
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
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
