from __future__ import annotations

from typing import Any
import json
import os
from urllib.parse import quote_plus

import folder_paths
from aiohttp import web

try:
    from server import PromptServer
except Exception:  # pragma: no cover
    PromptServer = None

from .gjj_video_universal_model_loader import (
    _choice,
    _format_slot_runtime_error,
    _get_full_path_any,
    _load_audio_encoder,
    _load_clip_vision,
    _load_wan_t5_encoder,
    _load_wan_vae,
    _load_wanvideo_runtime,
    _parse_extra_model_chain_config,
    _parse_wan_runtime_args,
    _unwrap_loader_output,
)


NODE_NAME = "GJJ_VideoKijaiModelLoader"
LIST_API = "/gjj/video_kijai_loader_lists"
MAX_SLOTS = 12
WAN_RUNTIME_ARGS_TYPE = "WANCOMPILEARGS,BLOCKSWAPARGS,VRAM_MANAGEMENTARGS"
LORA_CONFIG_TYPE = "WANVIDLORA,LORA_CHAIN_CONFIG"

DTYPES = ["default", "fp8_e4m3fn", "fp8_e5m2", "fp16", "bf16", "fp32"]
CLIP_TYPES = ["auto", "wan"]
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
WAN_ATTENTION_MODES = [
    "sdpa",
    "flash_attn_2",
    "flash_attn_3",
    "sageattn",
    "sageattn_3",
    "radial_sage_attention",
    "sageattn_compiled",
    "sageattn_ultravico",
    "comfy",
]
WAN_RMS_NORM_FUNCTIONS = ["default", "pytorch"]
WAN_VAE_PRECISIONS = ["bf16", "fp16", "fp32"]
WAN_T5_PRECISIONS = ["bf16", "fp32"]
WAN_T5_QUANTIZATIONS = ["disabled", "fp8_e4m3fn"]
EXTRA_BASE_PRECISIONS = ["fp16", "bf16", "fp32"]
SLOT_SETTING_FIELDS = [
    "base_precision",
    "quantization",
    "load_device",
    "attention_mode",
    "rms_norm_function",
    "vae_precision",
    "vae_use_cpu_cache",
    "t5_precision",
    "t5_quantization",
    "t5_load_device",
    "extra_base_precision",
    "lora_strength",
    "lora_merge_loras",
    "lora_low_mem_load",
]

KIND_OUTPUT_TYPE = {
    "wanvideo_model": "WANVIDEOMODEL",
    "wan_t5_encoder": "WANTEXTENCODER",
    "wan_vae": "WANVAE",
    "clip_vision": "CLIP_VISION",
    "audio_encoder": "AUDIO_ENCODER",
    "vace_model": "VACEPATH",
    "extra_model": "VACEPATH",
    "fantasytalking_model": "FANTASYTALKINGMODEL",
    "multitalk_model": "MULTITALKMODEL",
    "fantasyportrait_model": "FANTASYPORTRAITMODEL",
    "wan_lora": "WANVIDLORA",
    "empty": "*",
}

ICON_BY_KIND = {
    "wanvideo_model": "🟣",
    "wan_t5_encoder": "🟡",
    "wan_vae": "🔴",
    "clip_vision": "🔵",
    "audio_encoder": "🔵",
    "vace_model": "🧩",
    "extra_model": "🧩",
    "fantasytalking_model": "🗣",
    "multitalk_model": "🎤",
    "fantasyportrait_model": "🧑",
    "wan_lora": "🟠",
}


def _ensure_unet_gguf_folder() -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    for target in ("diffusion_models", "unet"):
        current = existing.get(target)
        if not current:
            continue
        paths, exts = current
        ext_set = set(exts or [])
        if ".gguf" not in ext_set:
            existing[target] = (paths, ext_set | {".gguf"})
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


_ensure_unet_gguf_folder()


def _dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value or "").strip()
        key = text.replace("\\", "/").lower()
        if not text or key in seen:
            continue
        result.append(text)
        seen.add(key)
    return result


def _filename_list(folder: str) -> list[str]:
    def read(kind: str) -> list[str]:
        try:
            return list(folder_paths.get_filename_list(kind))
        except Exception:
            return []

    if folder == "diffusion_models":
        return _dedupe(read("unet_gguf") + read("diffusion_models"))
    return read(folder)


def _is_usable_file(name: str, allow_any: bool = False) -> bool:
    lower = str(name or "").replace("\\", "/").lower().strip()
    if not lower or lower.endswith(".metadata.json"):
        return False
    if allow_any:
        return lower.endswith(tuple(MODEL_EXTENSIONS | {".torchscript.pt"}))
    return lower.endswith((".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".gguf"))


def _score_name(name: str, keywords: list[str]) -> tuple[int, str]:
    text = str(name or "").replace("\\", "/").lower()
    score = 0
    for idx, kw in enumerate(keywords):
        word = str(kw or "").lower()
        if not word:
            continue
        if word in text:
            score += 100 - idx
        if f"_{word}" in text or f"-{word}" in text or f"/{word}" in text:
            score += 12
    if text.endswith(".safetensors"):
        score += 10
    if text.endswith(".gguf"):
        score += 6
    score -= text.count("/")
    return (-score, text)


def _filter_names(names: list[str], keywords: list[str], allow_any: bool = False) -> list[str]:
    words = [str(item or "").strip().lower() for item in keywords if str(item or "").strip()]
    source = [name for name in names if _is_usable_file(name, allow_any=allow_any)]
    if not words:
        return source
    return [name for name in source if all(word in str(name).replace("\\", "/").lower() for word in words)]


def _sort_matches(names: list[str], keywords: list[str]) -> list[str]:
    return sorted(names, key=lambda item: _score_name(item, keywords))


def _matches_keywords(name: str, keywords: list[str], allow_any: bool = False) -> bool:
    return bool(_filter_names([name], keywords, allow_any=allow_any))


def _path_key(value: str) -> str:
    return str(value or "").replace("\\", "/").strip().lower()


def _model_download_search_url(filename: str) -> str:
    text = str(filename or "").strip()
    if not text:
        return ""
    return f"https://huggingface.co/models?search={quote_plus(text)}"


def _find_named_file(names: list[str], value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    normalized = {_path_key(name): name for name in names}
    key = _path_key(text)
    if key in normalized:
        return normalized[key]
    base = os.path.basename(key)
    for name_key, original in normalized.items():
        if name_key.endswith("/" + key) or name_key.endswith("/" + base) or os.path.basename(name_key) == base:
            return original
    return ""


def _resolve_selected(
    selected: str,
    folder: str,
    keywords: list[str],
    *,
    allow_any: bool = False,
    preferred: str = "",
    fallback_keywords: list[list[str]] | None = None,
) -> str:
    names = _filename_list(folder)
    selected_match = _find_named_file(names, selected)
    preferred_match = _find_named_file(names, preferred)
    if selected_match:
        if (
            preferred_match
            and selected_match != preferred_match
            and keywords
            and not _matches_keywords(selected_match, keywords, allow_any=allow_any)
            and _matches_keywords(preferred_match, keywords, allow_any=allow_any)
        ):
            return preferred_match
        return selected_match
    if preferred_match:
        return preferred_match

    keyword_groups = [keywords]
    keyword_groups.extend(group for group in (fallback_keywords or []) if isinstance(group, list))
    for words in keyword_groups:
        matches = _sort_matches(_filter_names(names, words, allow_any=allow_any), words)
        if matches:
            return matches[0]
    return ""


def S(
    id: str,
    label: str,
    folder: str,
    kind: str,
    keywords: list[str],
    *,
    icon: str | None = None,
    target: str = "both",
    preferred_name: str = "",
    required_name: str = "",
    **extra: Any,
) -> dict[str, Any]:
    data = {
        "id": id,
        "label": label,
        "folder": folder,
        "kind": kind,
        "keywords": keywords,
        "icon": icon or ICON_BY_KIND.get(kind, "⚪"),
        "output_type": KIND_OUTPUT_TYPE.get(kind, "*"),
        "target": target,
        "preferred_name": preferred_name or required_name,
        "required_name": required_name or preferred_name,
        **extra,
    }
    if not str(data.get("download_url", "") or "").strip():
        data["download_url"] = _model_download_search_url(str(data.get("required_name", "") or data.get("preferred_name", "") or ""))
    return data


def WM(
    id: str,
    label: str,
    keywords: list[str],
    *,
    preferred_name: str = "",
    target: str = "both",
    base_precision: str = "fp16_fast",
    quantization: str = "disabled",
    load_device: str = "offload_device",
    attention_mode: str = "sageattn",
    rms_norm_function: str = "default",
    **extra: Any,
) -> dict[str, Any]:
    return S(
        id,
        label,
        "diffusion_models",
        "wanvideo_model",
        keywords,
        target=target,
        preferred_name=preferred_name,
        base_precision=base_precision,
        quantization=quantization,
        load_device=load_device,
        attention_mode=attention_mode,
        rms_norm_function=rms_norm_function,
        **extra,
    )


def WV(
    label: str = "Wan VAE",
    *,
    preferred_name: str = "Wan2_1_VAE_bf16.safetensors",
    keywords: list[str] | None = None,
    precision: str = "bf16",
    use_cpu_cache: bool = False,
) -> dict[str, Any]:
    return S(
        "vae",
        label,
        "vae",
        "wan_vae",
        keywords or ["wan2", "vae"],
        preferred_name=preferred_name,
        precision=precision,
        use_cpu_cache=use_cpu_cache,
    )


def T5(
    label: str = "Wan T5文本编码器",
    *,
    preferred_name: str = "umt5-xxl-enc-bf16.safetensors",
    precision: str = "bf16",
    quantization: str = "disabled",
) -> dict[str, Any]:
    return S(
        "t5",
        label,
        "text_encoders",
        "wan_t5_encoder",
        ["umt5", "xxl"],
        preferred_name=preferred_name,
        precision=precision,
        load_device="offload_device",
        quantization=quantization,
    )


def L(
    id: str,
    label: str,
    keywords: list[str],
    *,
    preferred_name: str = "",
    target: str = "both",
    strength: float = 1.0,
    low_mem_load: bool = False,
    merge_loras: bool = False,
    **extra: Any,
) -> dict[str, Any]:
    return S(
        id,
        label,
        "loras",
        "wan_lora",
        keywords,
        target=target,
        preferred_name=preferred_name,
        strength=float(strength),
        low_mem_load=bool(low_mem_load),
        merge_loras=bool(merge_loras),
        **extra,
    )


def X(
    id: str,
    label: str,
    kind: str,
    keywords: list[str],
    *,
    preferred_name: str = "",
    target: str = "both",
    base_precision: str = "fp16",
) -> dict[str, Any]:
    return S(
        id,
        label,
        "diffusion_models",
        kind,
        keywords,
        target=target,
        preferred_name=preferred_name,
        base_precision=base_precision,
    )


def VACE(id: str, label: str, keywords: list[str], **kwargs: Any) -> dict[str, Any]:
    return X(id, label, "vace_model", keywords, **kwargs)


def EXTRA(id: str, label: str, keywords: list[str], **kwargs: Any) -> dict[str, Any]:
    return X(id, label, "extra_model", keywords, **kwargs)


def FT(id: str, label: str, keywords: list[str], **kwargs: Any) -> dict[str, Any]:
    return X(id, label, "fantasytalking_model", keywords, **kwargs)


def MT(id: str, label: str, keywords: list[str], **kwargs: Any) -> dict[str, Any]:
    return X(id, label, "multitalk_model", keywords, **kwargs)


def FP(id: str, label: str, keywords: list[str], **kwargs: Any) -> dict[str, Any]:
    return X(id, label, "fantasyportrait_model", keywords, **kwargs)


WAN21_VAE = WV(preferred_name="Wan2_1_VAE_bf16.safetensors", keywords=["wan2_1", "vae"])
WAN22_VAE = WV("Wan2.2 VAE", preferred_name="Wan2_2_VAE_bf16.safetensors", keywords=["wan2_2", "vae"])
WAN_T5 = T5()
LIGHTX_T2V_14B = L(
    "lightx2v_t2v",
    "LightX2V T2V LoRA",
    ["lightx2v", "t2v", "14b"],
    preferred_name="lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16_.safetensors",
    strength=1.0,
    merge_loras=False,
)
LIGHTX_I2V_14B = L(
    "lightx2v_i2v",
    "LightX2V I2V LoRA",
    ["lightx2v", "i2v", "14b"],
    preferred_name="lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors",
    strength=1.0,
    merge_loras=False,
)


KIJAI_MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    "wan22_t2v_a14b_pusa_dual": {
        "label": "Wan2.2 A14B T2V Pusa 双模型",
        "slots": [
            WM("high_model", "High模型", ["wan2_2", "t2v", "a14b", "high"], preferred_name="Wan2_2-T2V-A14B-HIGH_fp8_e4m3fn_scaled_KJ.safetensors", target="high", quantization="fp8_e4m3fn_scaled"),
            WM("low_model", "Low模型", ["wan2_2", "t2v", "a14b", "low"], preferred_name="Wan2_2-T2V-A14B-LOW_fp8_e4m3fn_scaled_KJ.safetensors", target="low", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            L("high_pusa_lora", "High Pusa LoRA", ["pusa", "high"], preferred_name="Wan22_PusaV1_lora_HIGH_resized_dynamic_avg_rank_98_bf16.safetensors", target="high", strength=1.5, merge_loras=True),
            L("low_pusa_lora", "Low Pusa LoRA", ["pusa", "low"], preferred_name="Wan22_PusaV1_lora_LOW_resized_dynamic_avg_rank_98_bf16.safetensors", target="low", strength=1.4, merge_loras=True),
            LIGHTX_T2V_14B,
        ],
    },
    "wan22_i2v_a14b_dual": {
        "label": "Wan2.2 A14B I2V 双模型",
        "slots": [
            WM("high_model", "High模型", ["wan2_2", "i2v", "a14b", "high"], preferred_name="Wan2_2-I2V-A14B-HIGH_fp8_e4m3fn_scaled_KJ.safetensors", target="high", quantization="fp8_e4m3fn_scaled"),
            WM("low_model", "Low模型", ["wan2_2", "i2v", "a14b", "low"], preferred_name="Wan2_2-I2V-A14B-LOW_fp8_e4m3fn_scaled_KJ.safetensors", target="low", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            LIGHTX_I2V_14B,
            L("lightx2v_i2v_low", "Low增强 LoRA", ["lightx2v", "i2v", "14b"], preferred_name="lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", target="low", strength=3.0, merge_loras=False),
        ],
    },
    "wan22_fun_control_dual": {
        "label": "Wan2.2 Fun Control 双模型",
        "slots": [
            WM("high_model", "High Fun Control", ["wan2_2", "fun", "control", "high"], preferred_name="Wan2_2-Fun-Control-A14B-HIGH_fp8_e4m3fn_scaled_KJ_fixed.safetensors", target="high", quantization="fp8_e4m3fn_scaled"),
            WM("low_model", "Low Fun Control", ["wan2_2", "fun", "control", "low"], preferred_name="Wan2_2-Fun-Control-A14B-LOW_fp8_e4m3fn_scaled_KJ_fixed.safetensors", target="low", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            LIGHTX_T2V_14B,
        ],
    },
    "wan22_fun_camera_dual": {
        "label": "Wan2.2 Fun Camera 双模型",
        "slots": [
            WM("high_model", "High Fun Camera", ["wan2_2", "fun", "camera", "high"], preferred_name="Wan2_2-Fun-Control-Camera-A14B-HIGH_fp8_e4m3fn_scaled_KJ.safetensors", target="high", quantization="fp8_e4m3fn_scaled"),
            WM("low_model", "Low I2V模型", ["wan2_2", "i2v", "a14b", "low"], preferred_name="Wan2_2-I2V-A14B-LOW_fp8_e4m3fn_scaled_KJ.safetensors", target="low", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            LIGHTX_I2V_14B,
        ],
    },
    "wan22_ti2v_5b": {
        "label": "Wan2.2 TI2V 5B 单模型",
        "slots": [
            WM("model", "TI2V 5B模型", ["wan2_2", "ti2v", "5b"], preferred_name="wan2.2_ti2v_5B_fp16.safetensors", base_precision="fp16_fast", attention_mode="sageattn"),
            WAN22_VAE,
            WAN_T5,
        ],
    },
    "wan22_ovi_audio": {
        "label": "Wan2.2 Ovi 图像音频驱动",
        "slots": [
            WM("model", "Ovi视频模型", ["ovi", "video"], preferred_name="Wan_2_1_Ovi_video_model_bf16.safetensors", base_precision="bf16", attention_mode="sageattn"),
            WAN22_VAE,
            WAN_T5,
            EXTRA("ovi_audio_extra", "Ovi音频额外模型", ["ovi", "audio"], preferred_name="Wan_2_1_Ovi_audio_model_bf16.safetensors"),
        ],
    },
    "wan22_wananimate": {
        "label": "WanAnimate 14B 人物动画",
        "slots": [
            WM("model", "WanAnimate模型", ["wan2_2", "animate", "14b"], preferred_name="Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            L("wananimate_relight_lora", "WanAnimate Relight LoRA", ["wananimate", "relight"], preferred_name="WanAnimate_relight_lora_fp16.safetensors", strength=1.0, merge_loras=False),
            L("wananimate_lightx_lora", "LightX2V I2V LoRA", ["lightx2v", "i2v", "14b"], preferred_name="lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", strength=1.2, merge_loras=False),
        ],
    },
    "wan21_t2v_14b": {
        "label": "Wan2.1 T2V 文生视频 KJ流",
        "slots": [
            WM("model", "T2V 14B模型", ["wan2_1", "t2v","kj"], preferred_name="Wan2_1-T2V-14B_fp8_e4m3fn_scaled_KJ.safetensors", base_precision="fp16_fast", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            LIGHTX_T2V_14B,
        ],
    },
    "wan21_i2v_14b_720p": {
        "label": "Wan2.1 I2V 14B 720P KJ流",
        "slots": [
            WM("model", "I2V 14B模型", ["wan2_1", "i2v", "14b", "720"], preferred_name="Wan2_1-I2V-14B-720p_fp8_e4m3fn_scaled_KJ.safetensors", base_precision="fp16_fast", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            LIGHTX_I2V_14B,
        ],
    },
    "wan21_i2v_14b_480p_gguf": {
        "label": "Wan2.1 I2V 14B GGUF / InfiniteTalk底模",
        "slots": [
            WM("model", "I2V 14B GGUF模型", ["wan2.1", "i2v", "14b", "gguf"], preferred_name="wan2.1-i2v-14b-480p-Q8_0.gguf", base_precision="fp16_fast", quantization="disabled"),
            WAN21_VAE,
            WAN_T5,
            LIGHTX_I2V_14B,
        ],
    },
    "wan21_flf2v_14b": {
        "label": "Wan2.1 FLF2V 首尾帧 14B",
        "slots": [
            WM("model", "FLF2V 720P模型", ["flf2v", "14b", "720"], preferred_name="Wan2_1-FLF2V-14B-720P_fp8_e4m3fn.safetensors", base_precision="fp16_fast", quantization="fp8_e4m3fn", attention_mode="sageattn"),
            WAN21_VAE,
            WAN_T5,
            L("flf2v_lightx_lora", "FLF2V LightX LoRA", ["lightx2v", "14b", "rank32"], preferred_name="Wan21_T2V_14B_lightx2v_cfg_step_distill_lora_rank32.safetensors", strength=1.2, merge_loras=True),
        ],
    },
    "wan21_vace_13b": {
        "label": "Wan2.1 VACE 1.3B",
        "slots": [
            WM("model", "T2V 1.3B底模", ["wan2.1", "t2v", "1.3b"], preferred_name="wan2.1_t2v_1.3B_fp16.safetensors", base_precision="fp16", attention_mode="sdpa"),
            WAN21_VAE,
            WAN_T5,
            VACE("vace_model", "VACE 1.3B模块", ["vace", "1_3b"], preferred_name="Wan2_1-VACE_module_1_3B_bf16.safetensors", base_precision="bf16"),
        ],
    },
    "wan21_i2v_fantasytalking": {
        "label": "Wan2.1 I2V FantasyTalking",
        "slots": [
            WM("model", "I2V 14B底模", ["wan2_1", "i2v", "14b", "720"], preferred_name="Wan2_1-I2V-14B-720P_fp8_e4m3fn.safetensors", base_precision="fp16", quantization="fp8_e4m3fn", attention_mode="sdpa"),
            WAN21_VAE,
            WAN_T5,
            FT("fantasytalking_model", "FantasyTalking模型", ["fantasytalking"], preferred_name="fantasytalking_fp16.safetensors", base_precision="fp16"),
        ],
    },
    "wan21_i2v_infinitetalk": {
        "label": "Wan2.1 I2V InfiniteTalk / MultiTalk",
        "slots": [
            WM("model", "I2V 14B GGUF底模", ["wan2.1", "i2v", "14b", "gguf"], preferred_name="wan2.1-i2v-14b-480p-Q8_0.gguf", base_precision="fp16_fast", quantization="disabled"),
            WAN21_VAE,
            WAN_T5,
            MT("multitalk_model", "InfiniteTalk模型", ["infinitetalk"], preferred_name="Wan2_1-InfiniteTalk_Single_Q8.gguf"),
            LIGHTX_I2V_14B,
        ],
    },
    "wan21_i2v_fantasyportrait": {
        "label": "Wan2.1 I2V FantasyPortrait",
        "slots": [
            WM("model", "I2V 14B底模", ["wan2_1", "i2v", "14b", "720"], preferred_name="Wan2_1-I2V-14B-720p_fp8_e4m3fn_scaled_KJ.safetensors", base_precision="fp16_fast", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            FP("fantasyportrait_model", "FantasyPortrait模型", ["fantasyportrait"], preferred_name="Wan2_1_FantasyPortrait_fp16.safetensors", base_precision="fp16"),
            LIGHTX_I2V_14B,
        ],
    },
    "wan21_t2v_lynx": {
        "label": "Wan2.1 T2V Lynx 参考层",
        "slots": [
            WM("model", "T2V 14B底模", ["wan2_1", "t2v", "14b"], preferred_name="Wan2_1-T2V-14B_fp8_e4m3fn_scaled_KJ.safetensors", base_precision="fp16_fast", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            EXTRA("lynx_full_ref", "Lynx Full Ref层", ["lynx", "full", "ref"], preferred_name="Wan2_1-T2V-Lynx_full_ref_layers_fp16.safetensors"),
            LIGHTX_T2V_14B,
        ],
    },
    "wan21_i2v_mtv_crafter": {
        "label": "Wan2.1 MTV-Crafter 动作适配",
        "slots": [
            WM("model", "MAGREF I2V底模", ["magref", "i2v", "14b"], preferred_name="Wan2_1-I2V-14B-MAGREF_fp8_e4m3fn_scaled_KJ.safetensors", base_precision="fp16_fast", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            EXTRA("mtv_motion_adapter", "MTV-Crafter运动适配器", ["mtv", "crafter", "motion"], preferred_name="Wan2_1_MTV-Crafter_motion_adapter_bf16.safetensors", base_precision="bf16"),
            L("mtv_lightx_lora", "MTV LightX LoRA", ["lightx2v", "i2v", "rank"], preferred_name="lightx2v_I2V_not_clamped_rank_64_fp16_00001_.safetensors", strength=1.0),
        ],
    },
    "longcat_ti2v": {
        "label": "LongCat TI2V 美团龙猫",
        "slots": [
            WM("model", "LongCat TI2V模型", ["longcat", "ti2v"], preferred_name="LongCat_TI2V_comfy_fp8_e4m3fn_scaled_KJ.safetensors", base_precision="bf16", quantization="disabled", attention_mode="sageattn_compiled"),
            WAN21_VAE,
            WAN_T5,
            L("longcat_distill_lora", "LongCat Distill LoRA", ["longcat"], preferred_name="LongCat_distill_lora_rank128_bf16.safetensors", strength=1.0),
        ],
    },
    "longcat_avatar": {
        "label": "LongCat Avatar 音频图生视频",
        "slots": [
            WM("model", "LongCat Avatar模型", ["longcat", "avatar", "15"], preferred_name="LongCat-Avatar-15_fp8_e4m3fn_wancompatible.safetensors", base_precision="bf16", quantization="disabled", attention_mode="sageattn", fallback_keywords=[["longcat", "avatar"]]),
            WAN21_VAE,
            WAN_T5,
            L("longcat_distill_lora", "LongCat Avatar DMD Distill LoRA", ["longcat", "avatar", "dmd", "distill"], preferred_name="LongCat-Avatar-15_dmd_distillLoRA.safetensors", strength=0.9, fallback_keywords=[["longcat", "distill"]]),
        ],
    },
    "wan21_13b_control_lora": {
        "label": "Wan2.1 1.3B Control LoRA",
        "slots": [
            WM("model", "T2V 1.3B模型", ["wan2.1", "t2v", "1.3b"], preferred_name="wan2.1_t2v_1.3B_fp16.safetensors", base_precision="fp16", attention_mode="sdpa"),
            WAN21_VAE,
            WAN_T5,
            L("control_tile_lora", "Control Tile LoRA", ["control", "lora", "tile"], preferred_name="wan2.1-1.3b-control-lora-tile-v0.1_comfy.safetensors", strength=1.0),
        ],
    },
    "wan21_13b_echoshot": {
        "label": "Wan2.1 1.3B EchoShot",
        "slots": [
            WM("model", "EchoShot 1.3B模型", ["echoshot", "1", "3b"], preferred_name="Wan2_1-T2V-1-3B-EchoShot_fp16.safetensors", base_precision="fp16_fast", attention_mode="sageattn"),
            WAN21_VAE,
            WAN_T5,
            L("echoshot_causvid_lora", "CausVid LoRA", ["causvid", "1_3b"], preferred_name="Wan21_CausVid_bidirect2_T2V_1_3B_lora_rank32.safetensors", strength=0.6, merge_loras=True),
            L("echoshot_self_forcing_lora", "Self Forcing LoRA", ["self", "forcing", "1_3b"], preferred_name="Wan2_1_self_forcing_dmd_1_3B_lora_rank_32_fp16.safetensors", strength=0.4, merge_loras=True),
            L("echoshot_funreward_lora", "FunReward LoRA", ["funreward", "1.3b"], preferred_name="Wan2.1-Fun-1.3B-InP-MPS_reward_lora_comfy.safetensors", strength=0.4, merge_loras=True),
        ],
    },
    "wan21_13b_flashvsr": {
        "label": "Wan2.1 1.3B FlashVSR",
        "slots": [
            WM("model", "FlashVSR 1.3B模型", ["flashvsr", "1_3b"], preferred_name="Wan2_1-T2V-1_3B_FlashVSR_fp32.safetensors", base_precision="fp16", attention_mode="sdpa"),
            WAN21_VAE,
            WAN_T5,
            EXTRA("flashvsr_lq_proj", "FlashVSR LQ投影模型", ["flashvsr", "lq", "proj"], preferred_name="Wan2_1_FlashVSR_LQ_proj_model_bf16.safetensors", base_precision="bf16"),
        ],
    },
    "wan21_13b_recammaster": {
        "label": "Wan2.1 1.3B ReCamMaster",
        "slots": [
            WM("model", "ReCamMaster 1.3B模型", ["recammaster", "1_3b"], preferred_name="Wan2_1_kwai_recammaster_1_3B_step20000_bf16.safetensors", base_precision="bf16", attention_mode="sdpa"),
            WAN21_VAE,
            WAN_T5,
        ],
    },
    "wan21_13b_unilumos": {
        "label": "Wan2.1 1.3B UniLumos Relight",
        "slots": [
            WM("model", "UniLumos 1.3B模型", ["unilumos", "1_3b"], preferred_name="Wan2_1_UniLumos_1_3B_bf16.safetensors", base_precision="bf16", attention_mode="sdpa"),
            WAN21_VAE,
            WAN_T5,
            L("causvid_lora", "CausVid LoRA", ["causvid", "1_3b"], preferred_name="Wan21_CausVid_bidirect2_T2V_1_3B_lora_rank32.safetensors", strength=1.0),
        ],
    },
    "wan21_14b_phantom": {
        "label": "Wan2.1 Phantom Subject2Vid",
        "slots": [
            WM("model", "Phantom T2V 14B模型", ["phantom", "14b"], preferred_name="Wan2_1-T2V-14B-Phantom_fp8_e4m3fn_scaled_KJ.safetensors", base_precision="fp16_fast", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            L("phantom_lightx_lora", "Phantom LightX LoRA", ["lightx2v", "t2v", "14b"], preferred_name="lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16_.safetensors", strength=0.8),
        ],
    },
    "wan21_14b_standin": {
        "label": "Wan2.1 Stand-In 参考角色",
        "slots": [
            WM("model", "T2V 14B底模", ["wan2_1", "t2v", "14b"], preferred_name="Wan2_1-T2V-14B_fp8_e4m3fn_scaled_KJ.safetensors", base_precision="fp16", quantization="fp8_e4m3fn_scaled"),
            WAN21_VAE,
            WAN_T5,
            L("standin_lora", "Stand-In LoRA", ["stand", "in"], preferred_name="Stand-In_wan2.1_T2V_14B_ver1.0.safetensors", strength=1.0),
            LIGHTX_T2V_14B,
        ],
    },
    "wan21_14b_humo": {
        "label": "Wan2.1 HuMo 14B",
        "slots": [
            WM("model", "HuMo 14B模型", ["humo", "14b"], preferred_name="Wan2_1-HuMo-14B_fp8_e4m3fn_scaled_KJ.safetensors", base_precision="fp16_fast", quantization="disabled"),
            WAN21_VAE,
            WAN_T5,
            LIGHTX_I2V_14B,
        ],
    },
    "wan21_14b_mocha": {
        "label": "Wan2.1 MoCha Subject Replace",
        "slots": [
            WM("model", "MoCha 14B模型", ["mocha", "14b"], preferred_name="Wan2_1_mocha-14B-preview_fp8_e4m3fn_scaled_KJ.safetensors", base_precision="fp16_fast", quantization="disabled"),
            WAN21_VAE,
            WAN_T5,
            L("mocha_lightx_lora", "MoCha LightX LoRA", ["lightx2v", "t2v", "14b"], preferred_name="lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16_.safetensors", strength=1.0, merge_loras=True),
        ],
    },
    "wan21_14b_scail": {
        "label": "Wan2.1 SCAIL Pose Control",
        "slots": [
            WM("model", "SCAIL 14B模型", ["scail", "14b"], preferred_name="Wan21-14B-SCAIL-preview_fp8_e4m3fn_scaled_KJ.safetensors", base_precision="fp16_fast", quantization="disabled"),
            WAN21_VAE,
            WAN_T5,
            LIGHTX_I2V_14B,
        ],
    },
    "wan21_14b_steadydancer": {
        "label": "Wan2.1 SteadyDancer Pose Control",
        "slots": [
            WM("model", "SteadyDancer模型", ["steadydancer"], preferred_name="Wan2.1-SteadyDancer_fp8_scaled_KJ.safetensors", base_precision="fp16_fast", quantization="disabled"),
            WAN21_VAE,
            WAN_T5,
            LIGHTX_I2V_14B,
        ],
    },
    "wan21_14b_wanmove": {
        "label": "Wan2.1 WanMove I2V",
        "slots": [
            WM("model", "WanMove模型", ["wanmove"], preferred_name="Wan21-WanMove_fp8_scaled_e4m3fn_KJ.safetensors", base_precision="fp16", quantization="disabled"),
            WAN21_VAE,
            WAN_T5,
            LIGHTX_I2V_14B,
        ],
    },
    "wan21_skyreels_a2v": {
        "label": "Wan2.1 SkyReels A2V",
        "slots": [
            WM("model", "SkyReels A2V模型", ["skyreels", "a2v"], preferred_name="Wan21_SkyReelsV3-A2V_fp8_scaled_mixed.safetensors", base_precision="fp16_fast", quantization="disabled"),
            WAN21_VAE,
            WAN_T5,
        ],
    },
}


FOLDERS = sorted(
    {slot["folder"] for cfg in KIJAI_MODEL_CONFIGS.values() for slot in cfg["slots"] if slot.get("folder")}
    | {"diffusion_models", "unet_gguf", "loras", "vae", "text_encoders", "clip_vision", "audio_encoders"}
)

def _is_lora_slot(slot: dict[str, Any]) -> bool:
    return str(slot.get("folder", "")).strip() == "loras" or str(slot.get("kind", "")).strip() == "wan_lora"


def _is_visible_output_slot(slot: dict[str, Any]) -> bool:
    if _is_lora_slot(slot):
        return False
    return str(slot.get("kind", "")).strip() not in {"empty", "name", "name_any"}


def _output_class_for_slot(slot: dict[str, Any]) -> str:
    kind = str(slot.get("kind", "") or "")
    slot_id = str(slot.get("id", "") or "")
    target = _target(slot.get("target", "both"))
    extra_kind = _extra_kind(slot)
    if kind == "wanvideo_model":
        if target == "low" or "low" in slot_id.lower():
            return "kijai_low_model"
        if target == "high" or "high" in slot_id.lower():
            return "kijai_high_model"
        return "kijai_main_model"
    if slot_id == "audio_vae":
        return "kijai_audio_vae"
    if kind == "wan_vae" or slot_id in {"vae", "video_vae"}:
        return "kijai_video_vae"
    if kind == "wan_t5_encoder":
        return "kijai_wan_t5"
    if kind == "clip_vision":
        return "kijai_clip_vision"
    if extra_kind == "fantasytalking":
        return "kijai_fantasytalking_model"
    if extra_kind == "multitalk":
        return "kijai_multitalk_model"
    if extra_kind == "fantasyportrait":
        return "kijai_fantasyportrait_model"
    if extra_kind == "vace":
        return "kijai_extra_model"
    if kind == "audio_encoder":
        return "kijai_audio_encoder"
    return f"kijai_{slot_id or kind or 'aux'}"


def _preferred_output_index(slot: dict[str, Any]) -> int:
    output_class = _output_class_for_slot(slot)
    if output_class in {"kijai_high_model", "kijai_main_model"}:
        return 0
    if output_class == "kijai_low_model":
        return 1
    if output_class == "kijai_video_vae":
        return 2
    if output_class == "kijai_audio_vae":
        return 3
    if output_class == "kijai_wan_t5":
        return 4
    if output_class == "kijai_clip_vision":
        return 5
    if output_class == "kijai_extra_model":
        return 6
    if output_class == "kijai_fantasytalking_model":
        return 7
    if output_class == "kijai_multitalk_model":
        return 8
    if output_class == "kijai_fantasyportrait_model":
        return 9
    if output_class == "kijai_audio_encoder":
        return 10
    return 11


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


def _target(value: Any) -> str:
    text = str(value or "both").strip().lower()
    text = {"all": "both", "": "both", "高": "high", "低": "low"}.get(text, text)
    return text if text in {"both", "high", "low"} else "both"


def _target_matches(item_target: str, model_target: str) -> bool:
    item_target = _target(item_target)
    model_target = _target(model_target)
    return item_target == "both" or model_target == "both" or item_target == model_target


def _slot_branch(slot: dict[str, Any]) -> str:
    explicit = str(slot.get("target", "") or "").strip().lower()
    if explicit in {"high", "low"}:
        return explicit
    text = f"{slot.get('id', '')} {slot.get('label', '')}".lower()
    if "high" in text or "高" in text:
        return "high"
    if "low" in text or "低" in text:
        return "low"
    return "both"


def _external_lora_branch(name: str) -> str:
    text = str(name or "").replace("\\", "/").lower()
    if "high_noise" in text or "_high" in text or "-high" in text or "/high" in text:
        return "high"
    if "low_noise" in text or "_low" in text or "-low" in text or "/low" in text:
        return "low"
    return "both"


def _make_wan_lora_payload(
    lora_name: str,
    strength: float,
    *,
    low_mem_load: bool = False,
    merge_loras: bool = False,
    blocks: dict[str, Any] | None = None,
    layer_filter: str = "",
) -> dict[str, Any] | None:
    if not lora_name or abs(float(strength)) < 1e-8:
        return None
    try:
        lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
    except Exception:
        lora_path = lora_name
    return {
        "path": lora_path,
        "strength": round(float(strength), 4),
        "name": os.path.splitext(str(lora_name).replace("\\", "/").split("/")[-1])[0],
        "blocks": blocks or {},
        "layer_filter": layer_filter,
        "low_mem_load": bool(low_mem_load) if merge_loras else False,
        "merge_loras": bool(merge_loras),
    }


def _parse_wan_lora_config(raw_value: Any) -> list[dict[str, Any]]:
    if raw_value is None or (isinstance(raw_value, str) and not raw_value.strip()):
        return []
    if isinstance(raw_value, list):
        raw = raw_value
    else:
        try:
            raw = json.loads(str(raw_value or "[]"))
        except Exception:
            return []
    if not isinstance(raw, list):
        return []

    items: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict) or item.get("enabled", True) is False:
            continue
        name = str(item.get("name") or item.get("lora_name") or item.get("file") or item.get("path") or "").strip()
        if not name:
            continue
        try:
            strength = float(item.get("strength", item.get("model_strength", item.get("weight", 1.0))))
        except Exception:
            strength = 1.0
        payload = item if item.get("path") else _make_wan_lora_payload(
            name,
            strength,
            low_mem_load=bool(item.get("low_mem_load", False)),
            merge_loras=bool(item.get("merge_loras", item.get("merge", False))),
            blocks=item.get("blocks") if isinstance(item.get("blocks"), dict) else None,
            layer_filter=str(item.get("layer_filter", "") or ""),
        )
        if payload is None:
            continue
        payload = dict(payload)
        payload["strength"] = round(float(payload.get("strength", strength)), 4)
        payload["target"] = _target(item.get("target", item.get("branch", _external_lora_branch(name))))
        items.append(payload)
    return items


def _load_fantasytalking_model(model_name: str, base_precision: str):
    try:
        from ..vendor.wanvideo_wrapper.fantasytalking import nodes as fantasytalking_nodes
    except Exception as error:
        raise RuntimeError(f"GJJ 内置 FantasyTalking runtime 加载失败：{error}") from error
    return _unwrap_loader_output(
        fantasytalking_nodes.FantasyTalkingModelLoader().loadmodel(model=model_name, base_precision=base_precision)
    )


def _load_multitalk_model(model_name: str):
    try:
        from ..vendor.wanvideo_wrapper.multitalk import nodes as multitalk_nodes
    except Exception as error:
        raise RuntimeError(f"GJJ 内置 MultiTalk runtime 加载失败：{error}") from error
    return _unwrap_loader_output(multitalk_nodes.MultiTalkModelLoader().loadmodel(model=model_name))


def _load_fantasyportrait_model(model_name: str, base_precision: str):
    try:
        from ..vendor.wanvideo_wrapper.fantasyportrait import nodes as fantasyportrait_nodes
    except Exception as error:
        raise RuntimeError(f"GJJ 内置 FantasyPortrait runtime 加载失败：{error}") from error
    return _unwrap_loader_output(
        fantasyportrait_nodes.FantasyPortraitModelLoader().loadmodel(model=model_name, base_precision=base_precision)
    )


def _extra_kind(slot_or_item: dict[str, Any]) -> str:
    kind = str(slot_or_item.get("kind", "vace") or "vace").strip().lower().replace("-", "_").replace(" ", "_")
    return {
        "vace_model": "vace",
        "extra_model": "vace",
        "fantasytalking_model": "fantasytalking",
        "fantasy_talking": "fantasytalking",
        "multitalk_model": "multitalk",
        "multi_talk": "multitalk",
        "infinite_talk": "multitalk",
        "infinitetalk": "multitalk",
        "fantasyportrait_model": "fantasyportrait",
        "fantasy_portrait": "fantasyportrait",
    }.get(kind, kind)


def _load_extra_value(kind: str, name: str, base_precision: str) -> Any:
    if kind == "vace":
        return [{"path": _get_full_path_any(("diffusion_models", "unet_gguf"), name)}]
    if kind == "fantasytalking":
        return _load_fantasytalking_model(name, base_precision)
    if kind == "multitalk":
        return _load_multitalk_model(name)
    if kind == "fantasyportrait":
        return _load_fantasyportrait_model(name, base_precision)
    return None


def _extra_kwargs_for_branch(extra_items: list[dict[str, Any]], model_target: str) -> dict[str, Any]:
    extra_models: list[dict[str, str]] = []
    fantasytalking_model = None
    multitalk_model = None
    fantasyportrait_model = None

    for item in extra_items:
        if not _target_matches(str(item.get("target", "both")), model_target):
            continue
        kind = str(item.get("extra_kind", "") or "")
        value = item.get("value")
        if kind == "vace":
            if isinstance(value, list):
                extra_models.extend(value)
        elif kind == "fantasytalking":
            fantasytalking_model = value
        elif kind == "multitalk":
            multitalk_model = value
        elif kind == "fantasyportrait":
            fantasyportrait_model = value

    return {
        "extra_model": extra_models or None,
        "fantasytalking_model": fantasytalking_model,
        "multitalk_model": multitalk_model,
        "fantasyportrait_model": fantasyportrait_model,
    }


def _load_wanvideo_model(
    model_name: str,
    slot: dict[str, Any],
    loras: list[dict[str, Any]],
    extra_items: list[dict[str, Any]],
    *,
    compile_args: Any = None,
    block_swap_args: Any = None,
    vram_management_args: Any = None,
):
    runtime = _load_wanvideo_runtime()
    loader = runtime["model_loading"].WanVideoModelLoader()
    model_target = _slot_branch(slot)
    branch_loras = [dict(item) for item in loras if _target_matches(str(item.get("target", "both")), model_target)]
    for item in branch_loras:
        item.pop("target", None)
    # Kijai 示例流里大多数 distill LoRA 是 WanVideoLoraSelect -> WanVideoSetLoRAs：
    # merge_loras=False 时要在模型加载后走 SetLoRAs 的 WanVideo 专用 patch 逻辑，不能塞进 ModelLoader。
    loader_loras = [item for item in branch_loras if bool(item.get("merge_loras", False))]
    set_loras = [item for item in branch_loras if not bool(item.get("merge_loras", False))]
    model = _unwrap_loader_output(
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
            lora=loader_loras or None,
            **_extra_kwargs_for_branch(extra_items, model_target),
        )
    )
    if set_loras:
        model = _unwrap_loader_output(runtime["model_loading"].WanVideoSetLoRAs().setlora(model, set_loras))
    return model


def _setting_text(kwargs: dict[str, Any], index: int, field: str) -> str:
    return str(kwargs.get(f"{field}_{index}", "") or "").strip()


def _setting_choice(
    kwargs: dict[str, Any],
    index: int,
    field: str,
    allowed: list[str] | set[str],
    default: Any,
    fallback: str,
) -> str:
    allowed_set = set(allowed)
    default_value = _choice(default, allowed_set, fallback)
    value = _setting_text(kwargs, index, field)
    if not value or value == "preset":
        return default_value
    return _choice(value, allowed_set, default_value)


def _setting_bool(kwargs: dict[str, Any], index: int, field: str, default: Any) -> bool:
    value = _setting_text(kwargs, index, field).lower()
    if not value or value == "preset":
        return bool(default)
    return value in {"1", "true", "yes", "on", "开", "启用"}


def _setting_float(kwargs: dict[str, Any], index: int, field: str, default: Any) -> float:
    value = _setting_text(kwargs, index, field)
    try:
        return float(default if value in {"", "preset"} else value)
    except Exception:
        try:
            return float(default)
        except Exception:
            return 1.0


def _slot_with_overrides(slot: dict[str, Any], index: int, kwargs: dict[str, Any]) -> dict[str, Any]:
    current = dict(slot)
    kind = str(current.get("kind", "") or "")
    extra_kind = _extra_kind(current)

    if kind == "wanvideo_model":
        current["base_precision"] = _setting_choice(
            kwargs, index, "base_precision", WAN_BASE_PRECISIONS, current.get("base_precision", "bf16"), "bf16"
        )
        current["quantization"] = _setting_choice(
            kwargs, index, "quantization", WAN_QUANTIZATIONS, current.get("quantization", "disabled"), "disabled"
        )
        current["load_device"] = _setting_choice(
            kwargs, index, "load_device", WAN_LOAD_DEVICES, current.get("load_device", "offload_device"), "offload_device"
        )
        current["attention_mode"] = _setting_choice(
            kwargs, index, "attention_mode", WAN_ATTENTION_MODES, current.get("attention_mode", "sdpa"), "sdpa"
        )
        current["rms_norm_function"] = _setting_choice(
            kwargs, index, "rms_norm_function", WAN_RMS_NORM_FUNCTIONS, current.get("rms_norm_function", "default"), "default"
        )
    elif kind == "wan_vae":
        current["precision"] = _setting_choice(
            kwargs, index, "vae_precision", WAN_VAE_PRECISIONS, current.get("precision", "bf16"), "bf16"
        )
        current["use_cpu_cache"] = _setting_bool(kwargs, index, "vae_use_cpu_cache", current.get("use_cpu_cache", False))
    elif kind == "wan_t5_encoder":
        current["precision"] = _setting_choice(
            kwargs, index, "t5_precision", WAN_T5_PRECISIONS, current.get("precision", "bf16"), "bf16"
        )
        current["quantization"] = _setting_choice(
            kwargs, index, "t5_quantization", WAN_T5_QUANTIZATIONS, current.get("quantization", "disabled"), "disabled"
        )
        current["load_device"] = _setting_choice(
            kwargs, index, "t5_load_device", WAN_LOAD_DEVICES, current.get("load_device", "offload_device"), "offload_device"
        )
    elif extra_kind in {"fantasytalking", "fantasyportrait", "vace"}:
        current["base_precision"] = _setting_choice(
            kwargs, index, "extra_base_precision", EXTRA_BASE_PRECISIONS, current.get("base_precision", "fp16"), "fp16"
        )
    elif _is_lora_slot(current):
        current["strength"] = _setting_float(kwargs, index, "lora_strength", current.get("strength", 1.0))
        current["merge_loras"] = _setting_bool(kwargs, index, "lora_merge_loras", current.get("merge_loras", False))
        current["low_mem_load"] = _setting_bool(kwargs, index, "lora_low_mem_load", current.get("low_mem_load", False))

    return current


def _config_payload() -> dict[str, Any]:
    return {
        key: {
            "label": cfg.get("label", key),
            "clip_type": "wan",
            "lora_label": "🟠 预设LoRA",
            "uses_lora": any(_is_lora_slot(slot) for slot in cfg.get("slots", [])),
            "uses_extra_model_chain": True,
            "output_slots": _output_slots_for_config(cfg),
            "slots": cfg.get("slots", []),
        }
        for key, cfg in KIJAI_MODEL_CONFIGS.items()
    }


async def get_gjj_video_kijai_loader_lists(request):
    return web.json_response({
        "configs": _config_payload(),
        "folders": {folder: _filename_list(folder) for folder in FOLDERS},
        "dtypes": DTYPES,
        "clip_types": CLIP_TYPES,
    })


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.get(LIST_API)(get_gjj_video_kijai_loader_lists)


class GJJ_VideoKijaiModelLoader:
    CATEGORY = "GJJ/模型加载"
    FUNCTION = "load_models"
    DESCRIPTION = (
        "Kijai/WanVideoWrapper 生态模型族预设加载器。输出 WANVIDEOMODEL / WANVAE / WANTEXTENCODER，"
        "支持双模型、单模型、预设 LoRA、VACE、FantasyTalking、MultiTalk/InfiniteTalk、FantasyPortrait 等扩展模块。"
        "节点使用 GJJ 内置 vendor/wanvideo_wrapper 运行层，不依赖外部 ComfyUI-WanVideoWrapper 节点包。"
    )
    SEARCH_ALIASES = [
        "Kijai Model Loader",
        "WanVideoWrapper loader",
        "WANVIDEOMODEL",
        "WANVAE",
        "FantasyTalking",
        "MultiTalk",
        "VACE",
    ]
    GJJ_HELP = {
        "models": [
            {"label": "主模型", "value": "models/diffusion_models/...", "tooltip": "按当前预设从 Kijai/WanVideoWrapper 工作流模型族中自动匹配。"},
            {"label": "VAE", "value": "models/vae/Wan2_1_VAE_bf16.safetensors 或 Wan2_2_VAE_bf16.safetensors", "tooltip": "输出 WANVAE，可直连 KJ 系 WanVideo 节点。"},
            {"label": "扩展模型", "value": "models/diffusion_models/extra/fantasytalking/multitalk/fantasyportrait/vace...", "tooltip": "预设会按模型族显示需要的额外模块。"},
        ],
        "dependencies": ["GJJ 内置 vendor/wanvideo_wrapper 运行层", "WanVideo 运行依赖按 GJJ WanVideo 节点环境安装"],
    }

    RETURN_TYPES = ("*",) * MAX_SLOTS
    RETURN_NAMES = tuple(f"output{i}" for i in range(1, MAX_SLOTS + 1))

    @classmethod
    def INPUT_TYPES(cls):
        config_keys = list(KIJAI_MODEL_CONFIGS.keys())
        inputs: dict[str, Any] = {
            "config": (config_keys, {
                "default": config_keys[0],
                "display_name": "⚫ KJ预设",
                "tooltip": "选择 Kijai/WanVideoWrapper 生态模型族预设；前端会按预设动态显示模型参数和输出接口。",
            }),
            "use_accel_lora": ("BOOLEAN", {
                "default": True,
                "display_name": "🟠 预设LoRA",
                "tooltip": "控制当前预设内置 LoRA 与外接 LoRA 配置是否注入 WANVIDEOMODEL。",
            }),
        }
        for i in range(1, MAX_SLOTS + 1):
            inputs[f"file_{i}"] = ("STRING", {
                "default": "",
                "display": "hidden",
                "hidden": True,
                "display_name": f"模型{i}",
                "tooltip": "由前端动态面板写入真实模型文件名。",
            })
            inputs[f"secondary_file_{i}"] = ("STRING", {
                "default": "",
                "display": "hidden",
                "hidden": True,
                "display_name": f"另一个模型{i}",
                "tooltip": "保留给动态面板兼容。",
            })
            inputs[f"dtype_{i}"] = (DTYPES, {
                "default": "default",
                "display_name": f"⚙{i}",
                "tooltip": "保留给通用面板兼容；KJ 主模型精度优先使用预设内的 base_precision / quantization。",
            })
            for field in SLOT_SETTING_FIELDS:
                inputs[f"{field}_{i}"] = ("STRING", {
                    "default": "",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": f"参数{i}",
                    "tooltip": "由前端齿轮参数面板维护；空值表示使用当前预设默认值。",
                })
        inputs["clip_type_override"] = (CLIP_TYPES, {
            "default": "auto",
            "display_name": "CLIP类型",
            "tooltip": "保留给通用面板兼容；KJ 预设固定为 Wan。",
        })
        return {
            "required": inputs,
            "optional": {
                "wan_runtime_args": (WAN_RUNTIME_ARGS_TYPE, {
                    "forceInput": True,
                    "display_name": "⚙️ Wan运行参数",
                    "tooltip": "兼容 WANCOMPILEARGS / BLOCKSWAPARGS / VRAM_MANAGEMENTARGS，直接传给 KJ WanVideoModelLoader。",
                }),
                "extra_model_chain": ("EXTRA_MODEL_CHAIN", {
                    "forceInput": True,
                    "display_name": "🧩 额外模型配置",
                    "tooltip": "可额外叠加 GJJ 额外模型串联配置；会与当前预设扩展模块合并。",
                }),
                "lora_chain_config": (LORA_CONFIG_TYPE, {
                    "forceInput": True,
                    "display_name": "🧬 LoRA配置",
                    "tooltip": "兼容 KJ WANVIDLORA 或 GJJ LORA_CHAIN_CONFIG；开启预设 LoRA 后合并注入主模型。",
                }),
                "use_accel_lora_in": ("BOOLEAN", {
                    "forceInput": True,
                    "display_name": "🟠 预设LoRA",
                    "tooltip": "外部布尔控制 LoRA 注入开关；连接后优先使用外部值。",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        keys = [
            "config",
            "use_accel_lora",
            "use_accel_lora_in",
            "🟠 预设LoRA",
            "lora_chain_config",
            "🧬 LoRA配置",
            "extra_model_chain",
            "🧩 额外模型配置",
            "wan_runtime_args",
            "⚙️ Wan运行参数",
        ]
        for i in range(1, MAX_SLOTS + 1):
            keys += [f"file_{i}", f"secondary_file_{i}", f"dtype_{i}"]
            keys += [f"{field}_{i}" for field in SLOT_SETTING_FIELDS]
        return "|".join(str(kwargs.get(key, "")) for key in keys)

    def load_models(self, *args, **kwargs):
        config_key = str(kwargs.get("config", "") or "")
        if config_key not in KIJAI_MODEL_CONFIGS:
            config_key = next(iter(KIJAI_MODEL_CONFIGS.keys()))
        cfg = KIJAI_MODEL_CONFIGS[config_key]

        use_lora = bool(kwargs.get("use_accel_lora", True))
        lora_bool_in = kwargs.get("🟠 预设LoRA", kwargs.get("use_accel_lora_in", None))
        if lora_bool_in is not None:
            use_lora = bool(lora_bool_in)

        wan_compile_args, wan_block_swap_args, wan_vram_management_args = _parse_wan_runtime_args(
            kwargs.get("⚙️ Wan运行参数", kwargs.get("wan_runtime_args", None))
        )
        slots = []
        for index, slot in enumerate(cfg.get("slots", []), start=1):
            current_slot = _slot_with_overrides(slot, index, kwargs)
            current_slot["_source_index"] = index
            slots.append(current_slot)
        output_layout = _output_slots_for_config({"slots": slots})
        output_index_by_source = {
            int(slot["_source_index"]): int(slot["output_index"])
            for slot in output_layout
            if "_source_index" in slot and "output_index" in slot
        }

        resolved: dict[int, str] = {}
        preset_loras: list[dict[str, Any]] = []
        extra_items: list[dict[str, Any]] = []
        extra_cache: dict[tuple[str, str, str], Any] = {}

        for index, slot in enumerate(slots, start=1):
            if index > MAX_SLOTS or str(slot.get("kind", "")) == "empty":
                continue
            selected = str(kwargs.get(f"file_{index}", "") or "")
            folder = str(slot.get("folder", "") or "")
            kind = str(slot.get("kind", "") or "")
            name = _resolve_selected(
                selected,
                folder,
                list(slot.get("keywords", []) or []),
                allow_any=kind in {"name_any"},
                preferred=str(slot.get("preferred_name", "") or slot.get("required_name", "") or ""),
                fallback_keywords=list(slot.get("fallback_keywords", []) or []),
            )

            if not name:
                if _is_lora_slot(slot):
                    continue
                raise _format_slot_runtime_error(
                    cfg.get("label", config_key),
                    slot,
                    RuntimeError("未找到匹配的本地模型文件。"),
                    selected_name=selected,
                )

            resolved[index] = name

            if _is_lora_slot(slot):
                payload = _make_wan_lora_payload(
                    name,
                    float(slot.get("strength", 1.0)),
                    low_mem_load=bool(slot.get("low_mem_load", False)),
                    merge_loras=bool(slot.get("merge_loras", False)),
                )
                if payload is not None:
                    payload["target"] = _slot_branch(slot)
                    preset_loras.append(payload)
                continue

            extra_kind = _extra_kind(slot)
            if extra_kind in {"vace", "fantasytalking", "multitalk", "fantasyportrait"}:
                precision = str(slot.get("base_precision", "fp16") or "fp16")
                cache_key = (extra_kind, name, precision)
                try:
                    if cache_key not in extra_cache:
                        extra_cache[cache_key] = _load_extra_value(extra_kind, name, precision)
                except Exception as exc:
                    raise _format_slot_runtime_error(cfg.get("label", config_key), slot, exc, selected_name=name) from exc
                extra_items.append({
                    "extra_kind": extra_kind,
                    "target": _slot_branch(slot),
                    "name": name,
                    "value": extra_cache[cache_key],
                })

        for item in _parse_extra_model_chain_config(kwargs.get("🧩 额外模型配置", kwargs.get("extra_model_chain", None))):
            name = str(item.get("name", "") or "").strip()
            if not name:
                continue
            extra_kind = _extra_kind(item)
            precision = str(item.get("base_precision", "fp16") or "fp16")
            cache_key = (extra_kind, name, precision)
            if cache_key not in extra_cache:
                extra_cache[cache_key] = _load_extra_value(extra_kind, name, precision)
            extra_items.append({
                "extra_kind": extra_kind,
                "target": _target(item.get("branch", "both")),
                "name": name,
                "value": extra_cache[cache_key],
            })

        loras = preset_loras if use_lora else []
        if use_lora:
            loras = [*loras, *_parse_wan_lora_config(kwargs.get("🧬 LoRA配置", kwargs.get("lora_chain_config", None)))]

        values: list[Any] = [None] * MAX_SLOTS
        for index, slot in enumerate(slots, start=1):
            if index > MAX_SLOTS or not _is_visible_output_slot(slot):
                continue
            output_index = output_index_by_source.get(index)
            if output_index is None or output_index < 0 or output_index >= MAX_SLOTS:
                continue
            kind = str(slot.get("kind", "") or "")
            name = resolved.get(index, "")
            try:
                if kind == "wanvideo_model":
                    value = _load_wanvideo_model(
                        name,
                        slot,
                        loras,
                        extra_items,
                        compile_args=wan_compile_args,
                        block_swap_args=wan_block_swap_args,
                        vram_management_args=wan_vram_management_args,
                    )
                elif kind == "wan_vae":
                    value = _load_wan_vae(name, slot)
                elif kind == "wan_t5_encoder":
                    value = _load_wan_t5_encoder(name, slot)
                elif kind == "clip_vision":
                    value = _load_clip_vision(name)
                elif kind == "audio_encoder":
                    value = _load_audio_encoder(name)
                elif _extra_kind(slot) in {"vace", "fantasytalking", "multitalk", "fantasyportrait"}:
                    extra_kind = _extra_kind(slot)
                    precision = str(slot.get("base_precision", "fp16") or "fp16")
                    value = extra_cache[(extra_kind, name, precision)]
                else:
                    value = name
            except Exception as exc:
                raise _format_slot_runtime_error(cfg.get("label", config_key), slot, exc, selected_name=name) from exc
            values[output_index] = value

        return tuple(values[:MAX_SLOTS])


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoKijaiModelLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ ·🎞️ Kijai视频模型加载"}
