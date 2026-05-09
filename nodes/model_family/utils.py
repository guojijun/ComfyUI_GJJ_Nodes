"""GJJ 模型族公共工具函数模块。

提供跨节点复用的模型族匹配、CLIP 解析、LoRA 名称选择等功能。
所有公共函数使用 gjjutils_ 前缀，与普通节点函数明确区分。
"""

from __future__ import annotations

from typing import Any

from ..gjj_model_bundle_loader import _dedupe_keep_order, _normalize_text
from ..gjj_model_family_preset_table import load_model_family_presets

# ============================================================================
# 常量定义
# ============================================================================

DEFAULT_CLIP_NAME = "qwen_3_8b.safetensors"
DEFAULT_VAE_NAME = "flux2-vae.safetensors"

CLIP_TYPE_KEYWORDS = [
    (("hidream",), "hidream"),
    (("wan", "wan2.2"), "wan"),
    (("ace",), "ace"),
    (("hunyuan_image", "hunyuan-image"), "hunyuan_image"),
    (("qwen_image", "qwen-image", "lotus-depth"), "qwen_image"),
    (("flux2", "klein"), "flux2"),
    (("flux1", "flux-1", "kontext", "schnell"), "flux"),
    (("omnigen2",), "omnigen2"),
    (("ovis",), "ovis"),
    (("z_image", "z-image", "zimage"), "lumina2"),
    (("newbie",), "newbie"),
]

MODEL_FAMILY_PRESETS = load_model_family_presets()


# ============================================================================
# 内部辅助函数（模块内部使用）
# ============================================================================


def _canonical_model_text(value: str | None) -> str:
    """将模型名称规范化为纯字母数字字符串，用于模糊匹配。

    Args:
            value: 原始模型名称

    Returns:
            去除所有特殊字符的小写字符串
    """
    text = _normalize_text(value)
    for char in ("\\", "/", "_", "-", ".", " "):
        text = text.replace(char, "")
    return text


def _pick_available_name(
    requested: str, available: list[str], fallback: str = ""
) -> str:
    """从可用列表中选择最匹配的模型名称（内部实现）。

    优先顺序：
    1. 完全匹配请求名称
    2. 基于规范化的 basename 匹配
    3. 使用 fallback 名称
    4. fallback 的 basename 匹配
    5. 返回列表第一个或空字符串

    Args:
            requested: 请求的模型名称
            available: 可用的模型名称列表
            fallback: 备选模型名称

    Returns:
            最佳匹配的模型名称
    """
    requested = str(requested or "").strip()
    if requested and requested in available:
        return requested

    # 尝试 basename 匹配
    requested_basename = (
        requested.replace("/", "\\").split("\\")[-1] if requested else ""
    )
    requested_canonical = _canonical_model_text(requested_basename or requested)
    if requested_canonical:
        for candidate in available:
            candidate_text = str(candidate or "").strip()
            candidate_basename = candidate_text.replace("/", "\\").split("\\")[-1]
            if _canonical_model_text(candidate_basename) == requested_canonical:
                return candidate_text

    # 尝试 fallback
    fallback = str(fallback or "").strip()
    if fallback and fallback in available:
        return fallback

    fallback_basename = fallback.replace("/", "\\").split("\\")[-1] if fallback else ""
    fallback_canonical = _canonical_model_text(fallback_basename or fallback)
    if fallback_canonical:
        for candidate in available:
            candidate_text = str(candidate or "").strip()
            candidate_basename = candidate_text.replace("/", "\\").split("\\")[-1]
            if _canonical_model_text(candidate_basename) == fallback_canonical:
                return candidate_text

    return available[0] if available else requested or fallback


# ============================================================================
# 公共函数（供其他节点复用）
# ============================================================================


def gjjutils_model_family_match_preset(
    unet_name: str, presets: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """根据 UNET 名称匹配对应的模型族预设。

    通过关键词模糊匹配找到最合适的预设配置，支持多关键词优先级排序。

    Args:
            unet_name: UNET 模型名称
            presets: 可选的预设列表，默认为全局 MODEL_FAMILY_PRESETS

    Returns:
            匹配的预设字典，包含 clip_type、clip_names、vae_name、采样参数等配置。
            如果未匹配到任何预设，返回通用默认配置。

    Example:
            >>> preset = gjjutils_model_family_match_preset("flux-2-klein-9b-nvfp4.safetensors")
            >>> print(preset["clip_type"])  # "flux2"
    """
    normalized_name = _normalize_text(unet_name)
    canonical_name = _canonical_model_text(unet_name)
    best: dict[str, Any] | None = None
    best_length = -1

    target_presets = presets if presets is not None else MODEL_FAMILY_PRESETS

    for preset in target_presets:
        for keyword in preset.get("keywords", []):
            normalized_keyword = _normalize_text(keyword)
            canonical_keyword = _canonical_model_text(keyword)
            if not normalized_keyword:
                continue
            if (
                normalized_keyword in normalized_name
                or (canonical_keyword and canonical_keyword in canonical_name)
            ) and len(canonical_keyword or normalized_keyword) > best_length:
                best = preset
                best_length = len(canonical_keyword or normalized_keyword)

    # 返回默认配置
    return best or {
        "id": "generic",
        "clip_type": "stable_diffusion",
        "clip_names": [DEFAULT_CLIP_NAME],
        "vae_name": DEFAULT_VAE_NAME,
        "lora_1_name": "",
        "lora_1_strength": 0.0,
        "lora_2_name": "",
        "lora_2_strength": 0.0,
        "steps": 20,
        "cfg": 1.0,
        "sampler_name": "euler",
        "scheduler": "simple",
        "denoise": 1.0,
        "model_sampling": "",
        "model_shift": 0.0,
        "cfg_norm_strength": 0.0,
        "supports_multi_image_edit": False,
        "main_long_edge": 1024,
        "vl_long_edge": 512,
        "width": 1024,
        "height": 1024,
    }


def gjjutils_model_family_resolve_clip_type(
    unet_name: str, clip_names: list[str], preferred_type: str = ""
) -> str:
    """根据 UNET 和 CLIP 名称智能推断 CLIP 类型。

    支持多种模型的自动识别，包括 Flux、Wan、HiDream、Qwen 等。

    Args:
            unet_name: UNET 模型名称
            clip_names: CLIP 模型名称列表
            preferred_type: 用户手动指定的 CLIP 类型（优先级最高）

    Returns:
            推断出的 CLIP 类型字符串，如 "flux2"、"wan"、"hidream" 等

    Example:
            >>> clip_type = gjjutils_model_family_resolve_clip_type(
            ...     "flux-2-klein-9b.safetensors",
            ...     ["qwen_3_8b.safetensors"]
            ... )
            >>> print(clip_type)  # "flux2"
    """
    preferred_text = str(preferred_type or "").strip()
    if preferred_text and _normalize_text(preferred_text) not in (
        "",
        "stable_diffusion",
        "auto",
    ):
        return preferred_text

    normalized_unet = _normalize_text(unet_name)
    canonical_unet = _canonical_model_text(unet_name)
    normalized_clips = " ".join(
        _normalize_text(name) for name in clip_names if str(name or "").strip()
    )
    canonical_clips = " ".join(
        _canonical_model_text(name) for name in clip_names if str(name or "").strip()
    )

    # 基于 UNET 名称匹配
    for keywords, clip_type in CLIP_TYPE_KEYWORDS:
        if any(
            _normalize_text(keyword) in normalized_unet
            or _canonical_model_text(keyword) in canonical_unet
            for keyword in keywords
        ):
            return clip_type

    # 基于 CLIP 名称的特殊规则
    if "clip_l_hidream" in normalized_clips or "clipghidream" in canonical_clips:
        return "hidream"
    if "qwen_2.5_vl" in normalized_clips or "qwen25vl" in canonical_clips:
        return "qwen_image"
    if (
        "qwen_3_8b" in normalized_clips
        or "qwen_3_4b" in normalized_clips
        or "qwen38b" in canonical_clips
        or "qwen34b" in canonical_clips
    ):
        if "flux2" in normalized_unet or "klein" in normalized_unet:
            return "flux2"
        if "wan" in normalized_unet:
            return "wan"
        if "ace" in normalized_unet:
            return "ace"
        if "hunyuan" in normalized_unet:
            return "hunyuan_image"
    if "clip_l" in normalized_clips and "t5xxl" in normalized_clips:
        return "flux"

    return str(preferred_type or "stable_diffusion")


def gjjutils_model_family_get_flux_clip_candidates(
    clip_models: list[str], default_name: str = ""
) -> list[str]:
    """获取 Flux 模型的可选 CLIP 候选列表。

    按优先级排序：default_name → t5xxl_fp16 → t5xxl_fp8_e4m3fn_scaled → t5xxl_fp8_e4m3fn

    Args:
            clip_models: 可用的 CLIP 模型列表
            default_name: 首选的 CLIP 名称

    Returns:
            过滤后的候选 CLIP 名称列表（仅包含实际存在的模型）
    """
    preferred = _dedupe_keep_order(
        [
            default_name,
            "t5xxl_fp16.safetensors",
            "t5xxl_fp8_e4m3fn_scaled.safetensors",
            "t5xxl_fp8_e4m3fn.safetensors",
        ]
    )
    return [
        name for name in preferred if str(name or "").strip() and name in clip_models
    ]


def gjjutils_model_family_resolve_clip_names(
    preset: dict[str, Any],
    clip_models: list[str],
    exposed_clip_name: str = "",
    legacy_clip_names: list[str] | None = None,
) -> list[str]:
    """从预设中解析并匹配可用的 CLIP 模型名称列表。

    支持 Flux 双 CLIP 的特殊处理逻辑，以及通用模型的名称匹配。

    Args:
            preset: 模型族预设字典
            clip_models: 系统中可用的 CLIP 模型列表
            exposed_clip_name: 前端暴露的 CLIP 名称（用户手动选择）
            legacy_clip_names: 旧版 CLIP 名称列表（向后兼容）

    Returns:
            解析后的 CLIP 名称列表，可用于加载 CLIP 模型

    Example:
            >>> clip_names = gjjutils_model_family_resolve_clip_names(
            ...     preset,
            ...     available_clip_models,
            ...     exposed_clip_name="custom_clip.safetensors"
            ... )
    """
    recommended_clip_names = [
        name for name in list(preset.get("clip_names", [])) if str(name or "").strip()
    ]

    # 无推荐名称时使用 legacy 名称
    if not recommended_clip_names:
        resolved: list[str] = []
        for manual_name in legacy_clip_names or []:
            chosen = _pick_available_name(manual_name, clip_models, "")
            if chosen:
                resolved.append(chosen)
        return resolved

    # Flux 特殊处理：clip_l + 可选 T5
    if (
        _normalize_text(preset.get("clip_type", "")) == "flux"
        and _normalize_text(recommended_clip_names[0]) == "clipl.safetensors"
    ):
        clip_l_name = _pick_available_name(
            "clip_l.safetensors", clip_models, recommended_clip_names[0]
        )
        optional_candidates = gjjutils_model_family_get_flux_clip_candidates(
            clip_models,
            recommended_clip_names[1] if len(recommended_clip_names) > 1 else "",
        )
        optional_name = _pick_available_name(
            exposed_clip_name,
            optional_candidates,
            recommended_clip_names[1] if len(recommended_clip_names) > 1 else "",
        )
        resolved = [
            name for name in [clip_l_name, optional_name] if str(name or "").strip()
        ]
        if resolved:
            return resolved

    # 通用处理：逐个匹配推荐名称
    resolved = []
    for recommended_name in recommended_clip_names:
        chosen = _pick_available_name(recommended_name, clip_models, recommended_name)
        if chosen:
            resolved.append(chosen)
    return resolved


def gjjutils_model_family_pick_lora_name(
    requested: str, available: list[str], fallback: str = ""
) -> str:
    """从可用 LoRA 列表中选择最匹配的名称（支持模糊匹配）。

    与模型名称匹配不同，LoRA 匹配还支持部分包含关系（requested 是 candidate 的子串）。

    Args:
            requested: 请求的 LoRA 名称
            available: 可用的 LoRA 名称列表
            fallback: 备选 LoRA 名称

    Returns:
            最佳匹配的 LoRA 名称，未找到则返回空字符串

    Example:
            >>> lora_name = gjjutils_model_family_pick_lora_name(
            ...     "lightning-lora.safetensors",
            ...     available_loras,
            ...     fallback="default-lora.safetensors"
            ... )
    """
    requested = str(requested or "").strip()
    if requested and requested in available:
        return requested

    # 尝试 basename 精确匹配和部分包含匹配
    requested_basename = (
        requested.replace("/", "\\").split("\\")[-1] if requested else ""
    )
    requested_canonical = _canonical_model_text(requested_basename or requested)
    if requested_canonical:
        for candidate in available:
            candidate_text = str(candidate or "").strip()
            candidate_basename = candidate_text.replace("/", "\\").split("\\")[-1]
            candidate_canonical = _canonical_model_text(candidate_basename)
            full_canonical = _canonical_model_text(candidate_text)
            if (
                candidate_canonical == requested_canonical
                or requested_canonical in candidate_canonical
                or requested_canonical in full_canonical
            ):
                return candidate_text

    # 尝试 fallback
    fallback = str(fallback or "").strip()
    if fallback and fallback in available:
        return fallback

    fallback_basename = fallback.replace("/", "\\").split("\\")[-1] if fallback else ""
    fallback_canonical = _canonical_model_text(fallback_basename or fallback)
    if fallback_canonical:
        for candidate in available:
            candidate_text = str(candidate or "").strip()
            candidate_basename = candidate_text.replace("/", "\\").split("\\")[-1]
            candidate_canonical = _canonical_model_text(candidate_basename)
            full_canonical = _canonical_model_text(candidate_text)
            if (
                candidate_canonical == fallback_canonical
                or fallback_canonical in candidate_canonical
                or fallback_canonical in full_canonical
            ):
                return candidate_text

    return ""


def gjjutils_model_family_pick_model_name(
    requested: str, available: list[str], fallback: str = ""
) -> str:
    """从可用模型列表中选择最匹配的名称（支持 basename 匹配）。

    这是 _pick_available_name 的公开版本，专门用于模型名称选择。

    Args:
            requested: 请求的模型名称
            available: 可用的模型名称列表
            fallback: 备选模型名称

    Returns:
            最佳匹配的模型名称

    Example:
            >>> vae_name = gjjutils_model_family_pick_model_name(
            ...     "flux2-vae.safetensors",
            ...     available_vaes,
            ...     fallback="default-vae.safetensors"
            ... )
    """
    return _pick_available_name(requested, available, fallback)
