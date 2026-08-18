from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

import comfy.samplers
import folder_paths
import torch
from PIL import Image

from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .common_utils.temp_files import (
    gjjutils_temp_path,
    gjjutils_write_temp_pil_image,
    gjjutils_write_temp_tensor_images,
)
from .gjj_lazy_image_studio import GJJ_LazyImageStudio
from .gjj_minimax_h3_studio import (
    DIALOGUE_LANGUAGE_TAGS,
    DEFAULT_ACCEL_STEPS,
    DEFAULT_AUDIO_VAE,
    DEFAULT_CLIP,
    DEFAULT_FL_MODEL_KEYWORD,
    DEFAULT_REASONING_KEYWORD,
    DEFAULT_VIDEO_VAE,
    GJJ_MiniMaxH3Studio,
    _default_accel_lora_data,
    _force_dialogue_language,
    _official_prompt_rewrite_rules,
    _spoken_language,
)
from .gjj_model_bundle_loader import list_vae_models
from .gjj_reference_grid_generator import _align_down, _first_scalar, _fit_cell
from .gjj_storyboard_grid_generator import (
    CELL_BLEED_PROMPT,
    DEFAULT_STORYBOARD_CLIP,
    DEFAULT_STORYBOARD_UNET,
    DEFAULT_STORYBOARD_VAE,
    GJJ_StoryboardGridGenerator,
    MULTI_REFERENCE_IMAGE_LIMIT,
    STORYBOARD_IMAGE_EDIT_LAYOUT_VERSION,
    _character_prompt_and_reference,
    _costume_prompt_and_reference,
    _ensure_next_scene_image_edit_clip_vae,
    _ensure_next_scene_lora_data,
    _has_configured_lora_data,
    _is_flux_storyboard_unet,
    _is_next_scene_image_edit_unet,
    _lazy_optional_images,
    _load_storyboard_preview_cells,
    _make_grid,
    _media_count,
    _media_slice,
    _append_plain_reference_prompt,
    _prefix_next_scene_prompt,
    _preset_lora_data,
    _resolved_character_refs,
    _scene_reference_tensor_for_prompt,
    _send_live_preview,
    _storyboard_character_context,
    _normalize_storyboard_cell,
    _write_debug_final_prompt,
    _write_debug_reference_images,
)
from .gjj_video_combine import GJJ_VideoCombine
from .gjj_video_combine_runtime import DEFAULT_FORMAT, list_supported_formats

try:
    from server import PromptServer
except Exception:
    PromptServer = None

# Optional model-management helpers must never control whether PromptServer is
# available.  Current ComfyUI builds no longer export unload_model_clones; the
# previous grouped import therefore disabled every live storyboard UI event
# while leaving video generation itself operational.
try:
    from comfy.model_management import soft_empty_cache
except Exception:
    soft_empty_cache = None

try:
    from comfy.model_management import unload_model_clones
except Exception:
    unload_model_clones = None


NODE_NAME = "GJJ_StoryboardVideoGrid"
MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO,AUDIO"

# 默认模型关键词（禁止硬编码绝对路径，通过关键词动态匹配）
DEFAULT_KEYFRAME_UNET_KEYWORD = DEFAULT_STORYBOARD_UNET
DEFAULT_KEYFRAME_CLIP_KEYWORD = DEFAULT_STORYBOARD_CLIP
DEFAULT_KEYFRAME_VAE_KEYWORD = DEFAULT_STORYBOARD_VAE
DEFAULT_KEYFRAME_LORA_MAIN_KEYWORD = "qwen 2511 lora"
DEFAULT_KEYFRAME_LORA_EXTRA_TERMS = ("next-scene", "image-edit")
DEFAULT_KEYFRAME_ACCEL_LORA = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
DEFAULT_VIDEO_UNET_KEYWORD = DEFAULT_FL_MODEL_KEYWORD
STORYBOARD_REF_MODEL_KEYWORD = "minimax_h3_ref2va_pruned"
# 注意：必须精确匹配 32b 版本（5120 维）。"qwen3v" 会同时匹配 8b（4096 维）导致维度不兼容
DEFAULT_VIDEO_CLIP_KEYWORD = "qwen3vl_32b"
DEFAULT_VIDEO_VAE_KEYWORD = "minimax_h3_video_vae"
DEFAULT_VIDEO_AUDIO_VAE_KEYWORD = "minimax_h3_audio_vae"
DEFAULT_REF_VIDEO_ACCEL_LORA_KEYWORD = "minimax_h3_ref2v_lightx2v_turbo_4step"


def _default_ref_video_lora_data() -> str:
    candidates = [
        str(item) for item in folder_paths.get_filename_list("loras")
        if DEFAULT_REF_VIDEO_ACCEL_LORA_KEYWORD in str(item).casefold()
        and str(item).casefold().endswith((".safetensors", ".sft"))
    ]
    candidates.sort(key=lambda item: ("4step" not in item.casefold(), len(item), item.casefold()))
    return json.dumps(
        [{"enabled": True, "name": candidates[0], "strength": 1.0}],
        ensure_ascii=False,
    ) if candidates else "[]"


def _ensure_ref_video_accel_lora_data(raw_value: Any) -> str:
    default_text = _default_ref_video_lora_data()
    try:
        default_rows = json.loads(default_text)
    except Exception:
        default_rows = []
    if not default_rows:
        return _safe_text(raw_value).strip() or "[]"
    try:
        rows = json.loads(_safe_text(raw_value).strip() or "[]")
    except Exception:
        rows = []
    if not isinstance(rows, list):
        rows = []
    rows = [
        row for row in rows
        if isinstance(row, dict)
        and "minimax_h3_ref2v" not in _safe_text(row.get("name")).casefold()
    ]
    return json.dumps([default_rows[0], *rows], ensure_ascii=False)


def _default_keyframe_lora_data() -> str:
    """搜索 lora 目录中匹配 qwen2511 关键词的 LoRA，返回 JSON 配置。
    最多选择 2 个 LoRA（next-scene + lightning），按优先级排序。

    匹配规则：
    - 必须包含所有主关键词（qwen, 2511, lora），或
    - 包含任一额外匹配词（next-scene, image-edit）
    排序：next-scene 优先，其次 lightning，最后按长度排序。
    """
    main_terms = [t for t in re.split(r"[^a-z0-9\u4e00-\u9fff]+", DEFAULT_KEYFRAME_LORA_MAIN_KEYWORD.casefold()) if t]
    extra_terms = tuple(t.casefold() for t in DEFAULT_KEYFRAME_LORA_EXTRA_TERMS)
    try:
        candidates = []
        for item in folder_paths.get_filename_list("loras"):
            name = str(item)
            name_lower = name.casefold()
            if all(term in name_lower for term in main_terms) or any(
                extra in name_lower for extra in extra_terms
            ):
                candidates.append(name)
        candidates.sort(key=lambda item: (
            "next-scene" in item.casefold(),
            "lightning" in item.casefold(),
            len(item),
            item.casefold(),
        ))
        if not candidates:
            return "[]"
        selected: list[Dict[str, Any]] = []
        # 优先选 next-scene
        for name in candidates:
            if "next-scene" in name.casefold():
                selected.append({"enabled": True, "name": name, "strength_model": 1.0, "strength_clip": 1.0})
                break
        # 加速 LoRA 必须严格使用 2511 4-step 版本；通用/2509/FireRed
        # Lightning 虽然名字相近，但会造成明显的画质与结构退化。
        accel_name = next((
            name for name in folder_paths.get_filename_list("loras")
            if str(name).replace("\\", "/").rsplit("/", 1)[-1].casefold()
            == DEFAULT_KEYFRAME_ACCEL_LORA.casefold()
        ), "")
        if accel_name:
            selected.append({"enabled": True, "name": str(accel_name), "strength": 1.0})
        # 如果都没选到，用第一个候选
        if not selected and candidates:
            selected.append({"enabled": True, "name": candidates[0], "strength_model": 1.0, "strength_clip": 1.0})
        return json.dumps(selected, ensure_ascii=False)
    except Exception:
        pass
    return "[]"


def _ensure_keyframe_accel_lora_data(raw_value: Any) -> str:
    try:
        rows = json.loads(_safe_text(raw_value).strip() or "[]")
    except Exception:
        rows = []
    if not isinstance(rows, list):
        rows = []
    available = [str(item) for item in folder_paths.get_filename_list("loras")]
    accel_name = next((
        name for name in available
        if name.replace("\\", "/").rsplit("/", 1)[-1].casefold()
        == DEFAULT_KEYFRAME_ACCEL_LORA.casefold()
    ), "")
    cleaned: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = _safe_text(row.get("name")).strip()
        name_key = name.casefold()
        if "lightning" in name_key and "2511" not in name_key:
            continue
        cleaned.append(row)
    next_scene_name = next((
        name for name in available
        if name.replace("\\", "/").rsplit("/", 1)[-1].casefold()
        == "next-scene_lora-v2-3000.safetensors"
    ), "")
    other_rows = [
        row for row in cleaned
        if "lightning" not in _safe_text(row.get("name")).casefold()
        and "next-scene" not in _safe_text(row.get("name")).casefold()
    ]
    ordered: list[dict[str, Any]] = []
    if accel_name:
        ordered.append({"enabled": True, "name": accel_name, "strength": 1.0})
    if next_scene_name:
        ordered.append({"enabled": True, "name": next_scene_name, "strength": 1.0})
    ordered.extend(other_rows)
    return json.dumps(ordered, ensure_ascii=False) if ordered else "[]"


def _split_storyboard_lora_data(raw_value: Any) -> tuple[str, str]:
    """Mirror StoryboardGridGenerator's two LoRA inputs exactly.

    Its model preset carries the Qwen2511 Lightning LoRA in ``lora_data``;
    Next-Scene is supplied through ``storyboard_lora_name`` and appended by the
    source node itself.  Keeping those entry points identical avoids the video
    wrapper applying a subtly different image preset.
    """
    try:
        rows = json.loads(_safe_text(raw_value).strip() or "[]")
    except Exception:
        rows = []
    if not isinstance(rows, list):
        rows = []
    base_rows: list[dict[str, Any]] = []
    storyboard_lora_name = ""
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = _safe_text(row.get("name")).strip()
        if "next-scene" in name.casefold():
            if row.get("enabled", True) and not storyboard_lora_name:
                storyboard_lora_name = name
            continue
        base_rows.append(row)
    return json.dumps(base_rows, ensure_ascii=False) if base_rows else "[]", storyboard_lora_name

# 视觉风格与运镜选项（复用 minimax-h3）
VISUAL_STYLES = [
    "自动 / Auto", "Cinematic / 电影感", "Live-action / 实拍", "Vintage film / 复古胶片",
    "Black & White / 黑白电影", "Documentary / 纪录片", "Minimalist commercial / 极简广告",
    "Macro photography / 微距摄影", "Aerial drone / 航拍", "2D-animated / 二维动画",
    "3D CG / 三维CG", "Anime / 日系二次元", "American Comic / 美式漫画", "Pixar-style 3D / 皮克斯3D",
    "Stop-motion / 定格动画", "Cyberpunk / 赛博朋克", "Watercolor / 水彩", "Claymation / 粘土动画",
    "Ink wash / 水墨", "Oil painting / 油画", "Paper cutout / 剪纸", "Pencil sketch / 铅笔素描",
]
CAMERA_MOTIONS = [
    "自动 / Auto", "Static Shot / 静止镜头", "Push In / 前推", "Pull Out / 后拉",
    "Pan Left / 向左摇摄", "Pan Right / 向右摇摄", "Truck Left / 向左横移", "Truck Right / 向右横移",
    "Tilt Up / 上摇", "Tilt Down / 下摇", "Pedestal Up / 上升", "Pedestal Down / 下降",
    "Arc Shot / 环绕", "Tracking Shot / 跟拍", "Zoom In / 变焦推近", "Zoom Out / 变焦拉远",
    "POV / 主观视角", "Shake Slightly / 轻微手持晃动",
]
MODEL_STRATEGIES = ["两阶段串行", "同时加载", "仅视频模型"]
OUTPUT_MODES = ["分段输出", "合并输出"]
MIN_SHOT_DURATION_SECONDS = 4.0

# 台词解析正则：一段对白持续到下一个“||@角色：”或文本结尾。
# 逗号、句号属于对白正文，不能作为终止符；旧表达式在第一个逗号
# 就截断，导致“此情此景，岂是凡尘可及？”只按“此情此景”4 字计时。
DIALOGUE_RE = re.compile(
    r"@([^\s:：,，。.！!？?|]+)\s*[:：]\s*"
    r"(.*?)"
    r"(?=(?:\s*\|\|\s*)?@[^\s:：,，。.！!？?|]+\s*[:：]|\Z)",
    re.DOTALL,
)


@dataclass
class Dialogue:
    speaker: str
    text: str
    duration: float = 0.0


@dataclass
class SubShot:
    start_time: float
    end_time: float
    dialogues: list[Dialogue] = field(default_factory=list)
    video_prompt: str = ""


@dataclass
class Shot:
    index: int
    keyframe_prompt: str
    video_prompt: str
    dialogues: list[Dialogue] = field(default_factory=list)
    sub_shots: list[SubShot] = field(default_factory=list)
    total_duration: float = 0.0


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        value = value[0] if value else ""
    return str(value or "").strip()


def _dialogue_speaker_name(value: Any) -> str:
    """Keep keyframe-only character view suffixes out of voice identities."""
    speaker = _safe_text(value)
    if "/" in speaker or "\\" in speaker:
        speaker = re.split(r"[/\\]", speaker, maxsplit=1)[0]
    return speaker.strip()


def _storyboard_preview_layout_versions(preview_images: Any) -> dict[int, str]:
    """Return persisted keyframe layout versions keyed by one-based position."""
    text = _safe_text(preview_images)
    if not text:
        return {}
    try:
        payload = json.loads(text)
    except Exception:
        return {}
    items = payload.get("items") if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        return {}
    versions: dict[int, str] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            index = int(item.get("index") or 0)
        except Exception:
            continue
        if index > 0:
            versions[index] = _safe_text(item.get("storyboard_layout_version"))
    return versions


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        v = float(value)
        if v != v or v in (float("inf"), float("-inf")):
            return default
        return v
    except (TypeError, ValueError):
        return default


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        v = int(float(value))
        return v
    except (TypeError, ValueError):
        return default


def _parse_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    text = _safe_text(value).lower()
    if text in ("true", "1", "yes", "是"):
        return True
    if text in ("false", "0", "no", "否", ""):
        return False
    return default


def _choices(folder: str, default_keyword: str, keywords: tuple[str, ...] = ()) -> tuple[list[str], str]:
    """获取模型选择列表。

    稳定性保障：
    1. 始终返回至少 1 个默认选项（防止 combo 列表长度变化导致位置错位）
    2. 默认选项放在列表首位，确保模块加载时和运行时的列表索引一致
    3. 模块加载时 folder_paths 未初始化，返回 [default_keyword] 单元素列表
       运行时 folder_paths 已初始化，返回完整模型列表
       但前端通过 onSerialize/onConfigure 的命名值机制，按名称还原而非位置，所以不会错位
    """
    try:
        models = list(folder_paths.get_filename_list(folder))
    except Exception:
        models = []
    if not models:
        return [default_keyword], default_keyword
    # 优先按关键词匹配
    for keyword in keywords:
        if not keyword:
            continue
        matched = [m for m in models if keyword.lower() in str(m).lower()]
        if matched:
            matched.sort(key=lambda m: ("converted" in m.lower(), len(m), m.lower()))
            default = matched[0]
            return matched, default
    # 兜底返回全量
    models_sorted = sorted(models, key=lambda m: (len(str(m)), str(m).lower()))
    return models_sorted, models_sorted[0]


def _validate_model_param(current_value: str, folder: str, keyword: str, strict_family: bool = False) -> str:
    """运行时验证模型参数，确保模型文件存在。如果当前值无效，返回匹配关键词的第一个可用模型。"""
    if not current_value:
        return current_value
    try:
        models = list(folder_paths.get_filename_list(folder))
    except Exception:
        return current_value
    def matches_strict_family(value: Any) -> bool:
        text = re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold())
        required = {
            "diffusion_models": ("qwen", "image", "edit", "2511"),
            "text_encoders": ("qwen", "2", "5", "vl", "7b"),
            "vae": ("qwen", "image", "vae"),
        }.get(folder, ())
        return all(token in text.split() for token in required)

    # 严格图片模式下，有效文件也必须属于 Qwen2511 对应模型族。
    if current_value in models and (not strict_family or matches_strict_family(current_value)):
        return current_value
    # 当前值无效，尝试匹配关键词
    keyword_lower = keyword.lower()
    matched = [m for m in models if keyword_lower in str(m).lower()]
    if strict_family:
        matched = [m for m in matched if matches_strict_family(m)]
    if matched:
        matched.sort(key=lambda m: ("converted" in m.lower(), len(m), m.lower()))
        print(f"[GJJ StoryboardVideoGrid] 修复模型值: {current_value} → {matched[0]}")
        return matched[0]
    # 图片阶段必须保持 Qwen2511 模型族；找不到时保留明确默认值，
    # 让模型加载给出真实缺失错误，不能静默回退到其他无关模型族。
    if strict_family:
        return current_value or keyword
    # 视频模型维持原有兼容回退，稍后单独调整视频链。
    if models:
        models_sorted = sorted(models, key=lambda m: (len(str(m)), str(m).lower()))
        print(f"[GJJ StoryboardVideoGrid] 修复模型值(无匹配): {current_value} → {models_sorted[0]}")
        return models_sorted[0]
    # 没有任何可用模型，返回原值
    return current_value


def _validate_enum_param(current_value: str, valid_options: list, default: str) -> str:
    """运行时验证枚举参数，如果当前值不在有效选项中，返回默认值。"""
    if not current_value:
        return default
    if current_value in valid_options:
        return current_value
    print(f"[GJJ StoryboardVideoGrid] 修复枚举值: {current_value} → {default}")
    return default


# ===== 参考图处理工具（复用 GJJ_StoryboardGridGenerator 流程）=====

MAX_KEYFRAME_REFERENCE_IMAGES = 3


def _split_media(value: Any) -> list[torch.Tensor]:
    if value is None:
        return []
    if isinstance(value, torch.Tensor):
        tensor = _ensure_bhwc_rgb(value)
        return [tensor[index:index + 1].contiguous() for index in range(int(tensor.shape[0]))]
    if isinstance(value, dict):
        images: list[torch.Tensor] = []
        for item in value.values():
            images.extend(_split_media(item))
        return images
    if isinstance(value, (list, tuple)):
        images: list[torch.Tensor] = []
        for item in value:
            images.extend(_split_media(item))
        return images
    return []


def _ensure_bhwc_rgb(image: torch.Tensor) -> torch.Tensor:
    tensor = image.detach().float().clamp(0.0, 1.0)
    if tensor.ndim == 3:
        if int(tensor.shape[-1]) in (1, 3, 4):
            tensor = tensor.unsqueeze(0)
        elif int(tensor.shape[0]) in (1, 3, 4):
            tensor = tensor.movedim(0, -1).unsqueeze(0)
        else:
            raise RuntimeError(f"参考图维度不支持：{tuple(tensor.shape)}")
    if tensor.ndim != 4:
        raise RuntimeError(f"参考图维度不支持：{tuple(tensor.shape)}")
    if int(tensor.shape[-1]) not in (1, 3, 4) and int(tensor.shape[1]) in (1, 3, 4):
        tensor = tensor.movedim(1, -1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 4:
        rgb = tensor[..., :3]
        alpha = tensor[..., 3:4].clamp(0.0, 1.0)
        tensor = rgb * alpha + (1.0 - alpha)
    elif channels > 4:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"参考图通道数不支持：{channels}")
    return tensor.contiguous()


def _align_down(value: int, min_val: int = 32, max_val: int = 64) -> int:
    value = max(int(min_val), int(value))
    if max_val <= 0:
        return value
    return max(int(min_val), (int(value) // int(max_val)) * int(max_val))


def _resize_crop_short_edge(image: torch.Tensor, target_width: int, target_height: int) -> torch.Tensor:
    target_width = _align_down(target_width, 32, 64)
    target_height = _align_down(target_height, 32, 64)
    tensor = _ensure_bhwc_rgb(image)
    source_height = int(tensor.shape[1])
    source_width = int(tensor.shape[2])
    if source_width <= 0 or source_height <= 0:
        raise RuntimeError("参考图尺寸无效，无法短边缩放裁剪。")
    scale = max(target_width / source_width, target_height / source_height)
    resized_width = max(target_width, int(round(source_width * scale)))
    resized_height = max(target_height, int(round(source_height * scale)))
    nchw = tensor.movedim(-1, 1)
    resized = torch.nn.functional.interpolate(
        nchw, size=(resized_height, resized_width), mode="bilinear", align_corners=False, antialias=True,
    ).movedim(1, -1)
    top = max(0, (resized_height - target_height) // 2)
    left = max(0, (resized_width - target_width) // 2)
    return resized[:, top:top + target_height, left:left + target_width, :].clamp(0.0, 1.0).contiguous()


def _resize_fit_reference(image: torch.Tensor, target_width: int, target_height: int) -> torch.Tensor:
    """与 GJJ_StoryboardGridGenerator 一致：等比缩放完整保留内容，白底居中填充。"""
    target_width = _align_down(target_width, 32, 64)
    target_height = _align_down(target_height, 32, 64)
    tensor = _ensure_bhwc_rgb(image)
    source_height = int(tensor.shape[1])
    source_width = int(tensor.shape[2])
    if source_width <= 0 or source_height <= 0:
        raise RuntimeError("参考图尺寸无效，无法缩放到目标尺寸。")
    scale = min(target_width / source_width, target_height / source_height)
    resized_width = max(1, min(target_width, int(round(source_width * scale))))
    resized_height = max(1, min(target_height, int(round(source_height * scale))))
    resized = torch.nn.functional.interpolate(
        tensor.movedim(-1, 1), size=(resized_height, resized_width),
        mode="bilinear", align_corners=False, antialias=True,
    ).movedim(1, -1)
    canvas = torch.ones((int(tensor.shape[0]), target_height, target_width, 3), dtype=resized.dtype, device=resized.device)
    top = max(0, (target_height - resized_height) // 2)
    left = max(0, (target_width - resized_width) // 2)
    canvas[:, top:top + resized_height, left:left + resized_width, :] = resized
    return canvas.clamp(0.0, 1.0).contiguous()


def _resize_bhwc_exact(image: torch.Tensor, target_width: int, target_height: int) -> torch.Tensor:
    tensor = _ensure_bhwc_rgb(image)
    if int(tensor.shape[2]) == int(target_width) and int(tensor.shape[1]) == int(target_height):
        return tensor
    resized = torch.nn.functional.interpolate(
        tensor.movedim(-1, 1),
        size=(max(1, int(target_height)), max(1, int(target_width))),
        mode="bicubic",
        align_corners=False,
        antialias=True,
    )
    return resized.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _is_qwen_image_edit_unet(unet_name: Any) -> bool:
    """与 GJJ_StoryboardGridGenerator._is_next_scene_image_edit_unet 一致。"""
    text = _safe_text(unet_name).lower()
    return ("qwen" in text or "firered" in text) and "image" in text and "edit" in text


def _combine_reference_images(reference_media: Any, width: int, height: int, max_count: int = MAX_KEYFRAME_REFERENCE_IMAGES) -> dict[str, torch.Tensor]:
    """将 reference_media 输入处理为 create_image 可接受的 image_01 批量格式。
    与 GJJ_StoryboardGridGenerator._lazy_optional_images 一致：fit 模式（等比缩放+白底填充）。"""
    images = _split_media(reference_media)
    if not images:
        return {}
    processed: list[torch.Tensor] = []
    for img in images[:max_count]:
        try:
            resized = _resize_fit_reference(img, width, height)
            processed.append(resized)
        except Exception as e:
            print(f"[GJJ StoryboardVideoGrid] 参考图处理失败: {e}")
            continue
    if not processed:
        return {}
    base = processed[0][:1].detach().float().clamp(0.0, 1.0).contiguous()
    batch_tensors = [base]
    for p in processed[1:]:
        batch_tensors.append(
            _ensure_bhwc_rgb(p)[:1].detach().to(device=base.device, dtype=base.dtype).clamp(0.0, 1.0).contiguous()
        )
    return {"image_01": torch.cat(batch_tensors, dim=0)}


def _parse_storyboard_table(table_text: str) -> list[Shot]:
    """解析分镜表格：序号||关键帧提示词||视频提示词||@角色：台词
    一行 = 一个分镜（宫格），每行的台词都属于该分镜。
    cell_id 为顺序编号（0-based），用于 DOM 查找和事件匹配，避免 index 重复导致冲突。
    """
    text = _safe_text(table_text)
    if not text:
        return []
    shots: list[Shot] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # 兼容 JS parseTable：支持 || 和 | 两种分隔符（优先 ||）
        if "||" in line:
            parts = line.split("||")
        elif "|" in line:
            parts = line.split("|")
        else:
            parts = [str(len(shots) + 1), line, "", ""]
        # 补齐到 4 段
        while len(parts) < 4:
            parts.append("")
        # 解析序号
        raw_idx = _safe_text(parts[0])
        try:
            index = int(raw_idx) if raw_idx.isdigit() else len(shots) + 1
        except Exception:
            index = len(shots) + 1
        keyframe_prompt = _safe_text(parts[1])
        video_prompt = _safe_text(parts[2])
        # 第 4 段之后都属于当前单格的对白，允许用户继续用 ||
        # 分隔多个“@角色：台词”，避免静默丢弃第二段及后续对白。
        dialogue_text = _safe_text("||".join(parts[3:]))
        # 解析台词
        dialogues: list[Dialogue] = []
        if dialogue_text:
            for match in DIALOGUE_RE.finditer(dialogue_text):
                speaker = _dialogue_speaker_name(match.group(1))
                text_content = _safe_text(match.group(2)).rstrip("，,。.！!？?；;")
                if speaker and text_content:
                    dialogues.append(Dialogue(speaker=speaker, text=text_content))
        # 过滤：如果关键帧、视频、台词全为空则跳过
        if not keyframe_prompt and not video_prompt and not dialogue_text:
            continue
        shots.append(Shot(
            index=index,
            keyframe_prompt=keyframe_prompt,
            video_prompt=video_prompt,
            dialogues=dialogues,
        ))
    return shots


def _estimate_dialogue_duration(text: str, chars_per_second: float = 3.0) -> float:
    """估算单句台词时长：字数 / 每秒字数 + 0.8秒停顿"""
    if not text:
        return 0.0
    # 中文字符数 + 英文单词数 * 2
    chinese_chars = len(re.findall(r"[\u4e00-\u9fff]", text))
    english_words = len(re.findall(r"[a-zA-Z]+", text))
    total_units = chinese_chars + english_words * 2
    duration = total_units / max(0.5, float(chars_per_second)) + 0.8
    return round(max(1.0, duration), 2)


def _calculate_shot_duration(
    dialogues: list[Dialogue],
    chars_per_second: float = 3.0,
    max_duration: float = 15.0,
    prompt_text: str = "",
    frame_rate: float = 24.0,
) -> tuple[float, list[SubShot]]:
    """计算分镜总时长，并将每个子分镜对齐到 MiniMax H3 的 17n+5 帧。"""
    safe_fps = max(1e-6, float(frame_rate))

    def aligned_duration(duration: float) -> float:
        requested_duration = max(MIN_SHOT_DURATION_SECONDS, float(duration))
        frame_count = max(5, round(requested_duration * safe_fps)) + (
            5 - (max(5, round(requested_duration * safe_fps)) % 17)
        ) % 17
        return frame_count / safe_fps

    if not dialogues:
        prompt = _safe_text(prompt_text)
        explicit = re.search(r"(?<!\d)(\d+(?:\.\d+)?)\s*秒", prompt)
        if explicit:
            duration = min(max_duration, max(MIN_SHOT_DURATION_SECONDS, float(explicit.group(1))))
        else:
            duration = MIN_SHOT_DURATION_SECONDS
        duration = aligned_duration(duration)
        return round(duration, 6), [SubShot(start_time=0.0, end_time=round(duration, 6), video_prompt=prompt)]

    # 计算每句台词时长
    for d in dialogues:
        d.duration = _estimate_dialogue_duration(d.text, chars_per_second)

    # 整个分镜能在 max_duration 内说完时保持为一个视频，不因有多段
    # 对白就机械拆镜。仅在确实超时后，才按对白顺序贪心分组。
    camera_tail = 0.75
    combined_duration = sum(d.duration for d in dialogues) + camera_tail
    if combined_duration <= max_duration:
        duration = round(aligned_duration(combined_duration), 6)
        return duration, [SubShot(
            start_time=0.0,
            end_time=duration,
            dialogues=list(dialogues),
        )]

    sub_shots: list[SubShot] = []
    start_time = 0.0
    current_dialogues: list[Dialogue] = []
    current_speech_duration = 0.0

    def append_group(group: list[Dialogue], speech_duration: float) -> None:
        nonlocal start_time
        if not group:
            return
        segment_duration = aligned_duration(
            min(max_duration, max(MIN_SHOT_DURATION_SECONDS, speech_duration + camera_tail))
        )
        end_time = start_time + segment_duration
        sub_shots.append(SubShot(
            start_time=round(start_time, 6),
            end_time=round(end_time, 6),
            dialogues=list(group),
        ))
        start_time = end_time

    for dialogue in dialogues:
        proposed = current_speech_duration + dialogue.duration + camera_tail
        if current_dialogues and proposed > max_duration:
            append_group(current_dialogues, current_speech_duration)
            current_dialogues = []
            current_speech_duration = 0.0
        current_dialogues.append(dialogue)
        current_speech_duration += dialogue.duration

    append_group(current_dialogues, current_speech_duration)

    return round(start_time, 6), sub_shots


def _continuation_video_prompt(child_index: int) -> str:
    """Prompt for child clips after the first; never repeat the source shot prompt."""
    return (
        f"Continuation part {child_index}: begin exactly from <Picture 1>, the final frame of the "
        "previous clip. Continue the ongoing action, expressions, environmental motion, and camera "
        "trajectory naturally forward in time. Develop the scene with new subsequent movement; do "
        "not restart, replay, summarize, or repeat the preceding clip. Preserve character identity, "
        "wardrobe, positions, lighting, scene geometry, motion direction, and screen direction for a "
        "seamless cut."
    )


def _build_h3_video_prompt(
    video_prompt: str,
    sub_shots: list[SubShot],
    duration: float,
    dialogue_language: str = "中文",
    visual_style: str = "自动 / Auto",
    camera_motion: str = "自动 / Auto",
    reference_prompt: str = "",
) -> str:
    """组装 minimax-h3 官方格式提示词。

    ``reference_prompt`` 仅为旧调用兼容保留。它来自关键帧列，视频阶段不得读取
    其中的动作、人物标记或文字，避免关键帧描述进入视频对白或参考资产规划。
    """
    language_tag = DIALOGUE_LANGUAGE_TAGS.get(str(dialogue_language), "Chinese")

    # 为说话者分配编号
    speaker_map: dict[str, str] = {}
    speaker_counter = 0
    for sub in sub_shots:
        for d in sub.dialogues:
            if d.speaker not in speaker_map:
                speaker_counter += 1
                speaker_map[d.speaker] = f"S{speaker_counter}"

    # 构建分镜描述
    shot_descriptions: list[str] = []
    for idx, sub in enumerate(sub_shots):
        shot_label = f"[Shot {idx + 1}]"
        time_label = "" if idx == 0 else f" At {int(sub.start_time // 60):02d}:{sub.start_time % 60:06.3f}"
        # 对白部分
        dialogue_parts: list[str] = []
        for d in sub.dialogues:
            speaker_id = speaker_map.get(d.speaker, "S1")
            dialogue_parts.append(
                f"({speaker_id}) {d.speaker} says:\n"
                f"<d>[{language_tag}] {d.text}</d>"
            )
        # 第 3 列只描述视觉动作。第 2 列关键帧提示词绝不进入视频正文；
        # 只有下面 dialogue_parts 中显式的 <d> 内容允许成为语音。
        prompt_section = ""
        if idx == 0 and video_prompt:
            prompt_section = (
                f"VISUAL ACTION AND CAMERA DIRECTION: {video_prompt}. "
                "SILENCE LOCK FOR THE PRECEDING VISUAL DIRECTION — never speak, narrate, quote, "
                "lip-sync, subtitle, or convert the preceding visual description into soundtrack speech."
            )
        parts = [shot_label, time_label, prompt_section, *dialogue_parts]
        shot_descriptions.append(" ".join(p for p in parts if p))

    # 视觉风格
    style_text = ""
    if visual_style and "自动" not in visual_style:
        style_text = f" Visual style: {visual_style}."

    # 运镜
    camera_text = ""
    if camera_motion and "自动" not in camera_motion:
        camera_text = f" Camera: {camera_motion}."

    # 组装 MiniMax-H3 Reference-to-Video 官方六字段格式。
    integrated = " ".join(shot_descriptions)
    body = (
        "subject_definitions: <Picture 1> is the visual reference for the subject identity, appearance, "
        "clothing, colors, scene details, and spatial traits used in the target video.\n\n"
        "summary: [reference generation] Preserve the referenced subject and scene while performing the "
        "requested motion, camera work, and dialogue.\n\n"
        "retention_analysis: <Picture 1>: fully_preserved - preserve identity, appearance, colors, clothing, "
        "objects, scene details, and spatial traits.\n\n"
        "detailed_description: SPEECH CONTENT LOCK — the only words permitted in the soundtrack are the "
        "explicit dialogue payloads attached to named speakers below. Never narrate visual descriptions, actions, camera directions, "
        "keyframe text, character names, labels, or reference notes. "
        f"{integrated}{style_text}{camera_text}\n\n"
        f"overall_soundscape: Environmental sounds and character movements synchronized with dialogue.\n\n"
        f"non_diegetic_music: N/A"
    )
    return body


def _send_status(unique_id: Any, message: str, progress: float = 0.0, extra: dict | None = None) -> None:
    """推送进度事件到前端"""
    if PromptServer is None:
        return
    try:
        PromptServer.instance.send_sync("gjj_storyboard_video_grid_progress", {
            "node": str(unique_id or ""),
            "message": str(message or ""),
            "progress": float(max(0.0, min(1.0, progress))),
            **(extra or {}),
        })
    except Exception:
        pass


def _send_cell_preview(
    unique_id: Any,
    cell_id: int,
    index: int,
    total: int,
    phase: str,
    status: str,
    preview_url: str = "",
    video_url: str = "",
    duration: float = 0.0,
    item: Optional[Dict[str, Any]] = None,
) -> None:
    """推送单格预览到前端。cell_id 为顺序编号（0-based），用于 DOM 查找，避免 index 重复冲突。
    item 为包含 filename / subfolder / type / preview_filename 的字典，供前端 Canvas 预览复用。"""
    if PromptServer is None:
        return
    payload_item: Dict[str, Any] = {}
    if isinstance(item, dict):
        for _k in ("filename", "subfolder", "type", "url", "format", "mime_type", "preview_filename", "preview_subfolder", "preview_type"):
            _v = item.get(_k)
            if _v is not None:
                payload_item[_k] = str(_v)
    try:
        PromptServer.instance.send_sync("gjj_storyboard_video_grid_cell", {
            "node": str(unique_id or ""),
            "cell_id": int(cell_id),
            "index": int(index),
            "total": int(total),
            "phase": str(phase),
            "status": str(status),
            "preview_url": str(preview_url or ""),
            "video_url": str(video_url or ""),
            "duration": float(duration or 0.0),
            "item": payload_item,
        })
    except Exception:
        pass


def _send_video_batch_preview(unique_id: Any, records: list[Dict[str, Any]], total: int = 0) -> None:
    """Final authoritative video list used to reconcile batch UI state."""
    if PromptServer is None:
        return
    try:
        PromptServer.instance.send_sync("gjj_storyboard_video_grid_videos_done", {
            "node": str(unique_id or ""),
            "records": records,
            "count": len(records),
            "total": int(total or len(records)),
        })
    except Exception:
        pass


def _storyboard_plan_cells(shots: list[Shot]) -> list[Dict[str, Any]]:
    cells = []
    for cell_id, shot in enumerate(shots):
        dialogue_text = "||".join(f"@{item.speaker}：{item.text}" for item in shot.dialogues)
        cells.append({
            "cell_id": cell_id,
            "index": int(shot.index),
            "keyframe_prompt": shot.keyframe_prompt,
            "video_prompt": shot.video_prompt,
            "dialogue_text": dialogue_text,
            "duration": float(shot.total_duration),
            "sub_shot_count": max(1, len(shot.sub_shots)),
        })
    return cells


def _send_storyboard_plan(
    unique_id: Any,
    shots: list[Shot],
    *,
    reset_videos: bool = False,
    run_token: str = "",
    table_signature: str = "",
) -> None:
    """图片生成前推送完整宫格、提示词、时长与子分镜计划。"""
    if PromptServer is None:
        return
    cells = _storyboard_plan_cells(shots)
    try:
        PromptServer.instance.send_sync("gjj_storyboard_video_grid_plan", {
            "node": str(unique_id or ""),
            "total": len(cells),
            "cells": cells,
            "reset_videos": bool(reset_videos),
            "run_token": str(run_token or ""),
            "table_signature": str(table_signature or ""),
        })
    except Exception:
        pass


def _video_preview_item(result: Any, video_output: Any = None) -> Dict[str, Any]:
    """Extract the saved video item emitted by GJJ_VideoCombine/MiniMaxH3Studio."""
    candidates: list[Any] = []
    if isinstance(video_output, dict):
        candidates.append(video_output)
    if isinstance(result, dict):
        ui = result.get("ui")
        if isinstance(ui, dict):
            for key in ("preview_media", "preview_video", "gifs", "animated", "videos", "video"):
                candidates.append(ui.get(key))
            candidates.append(ui.get("output_path"))

    def first(value: Any) -> Any:
        while isinstance(value, (list, tuple)) and value:
            value = value[0]
        return value

    for candidate in candidates:
        candidate = first(candidate)
        if isinstance(candidate, dict) and (candidate.get("filename") or candidate.get("url")):
            return {
                key: str(candidate.get(key))
                for key in ("filename", "subfolder", "type", "url", "format", "mime_type")
                if candidate.get(key) is not None
            }
        raw_path = str(candidate or "").strip()
        if not raw_path:
            continue
        path = Path(raw_path)
        if path.suffix.lower() not in {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".gif"}:
            continue
        try:
            relative = path.resolve().relative_to(Path(folder_paths.get_output_directory()).resolve())
            return {
                "filename": relative.name,
                "subfolder": "" if str(relative.parent) == "." else relative.parent.as_posix(),
                "type": "output",
            }
        except Exception:
            return {"url": raw_path}
    return {}


def _last_video_frame(video: Any) -> torch.Tensor | None:
    """Extract one BHWC CPU frame for chaining the next child shot."""
    getter = getattr(video, "get_components", None)
    if not callable(getter):
        return None
    try:
        components = getter()
        images = components.get("images") if isinstance(components, dict) else getattr(components, "images", None)
    except Exception:
        return None
    if not isinstance(images, torch.Tensor) or images.ndim != 4 or int(images.shape[0]) < 1:
        return None
    return images[-1:].detach().to(device="cpu", dtype=torch.float32).clamp(0.0, 1.0).contiguous()


def _shot_cache_signature(shot: Shot, width: int, height: int, seed: int, **kwargs) -> str:
    """生成单格缓存签名"""
    signature_data = json.dumps({
        "image_pipeline": "storyboard_grid_reference_batch_v4",
        "keyframe_prompt": shot.keyframe_prompt,
        "video_prompt": shot.video_prompt,
        "dialogues": [{"speaker": d.speaker, "text": d.text} for d in shot.dialogues],
        "width": int(width),
        "height": int(height),
        "seed": int(seed),
        **{k: str(v) for k, v in kwargs.items() if v is not None},
    }, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(signature_data.encode("utf-8")).hexdigest()


def _unload_all_models() -> None:
    """卸载所有模型克隆并清理缓存"""
    try:
        try:
            import comfy.model_management as model_management
            model_management.unload_all_models()
        except Exception:
            pass
        if unload_model_clones:
            try:
                unload_model_clones()
            except TypeError:
                pass
        if soft_empty_cache:
            soft_empty_cache()
        import gc
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
    except Exception:
        pass


def _release_image_resources(*lazy_studios: Any) -> None:
    """Drop every Qwen image-stage strong reference before loading video models."""
    seen: set[int] = set()
    for studio in lazy_studios:
        if studio is None or id(studio) in seen:
            continue
        seen.add(id(studio))
        try:
            studio._release_instance_caches(runtime=True, loras=True, results=False)
        except Exception:
            try:
                studio._kept_runtime = None
                studio._lora_cache.clear()
                studio._clear_shared_caches(runtime=True, results=False)
            except Exception:
                pass
    _unload_all_models()


class GJJ_StoryboardVideoGrid:
    """GJJ 分镜宫格视频生成器：qwen2511 起始帧 + minimax-h3 分镜视频"""

    CATEGORY = "GJJ/🎬 视频"
    FUNCTION = "generate"
    INPUT_IS_LIST = True
    OUTPUT_NODE = True
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频合并输出",)
    OUTPUT_IS_LIST = (False,)
    OUTPUT_TOOLTIPS = (
        "按宫格顺序合并后的单个官方 VIDEO，可直接连接播放或保存节点。",
    )
    DESCRIPTION = "分镜宫格视频生成器：解析表格 → qwen2511 生成起始帧 → minimax-h3 生成分镜视频，并输出可直接播放的完整 VIDEO。"
    SEARCH_ALIASES = ["分镜宫格视频", "storyboard video grid", "宫格视频", "分镜视频生成"]
    GJJ_HELP = {
        "title": "GJJ 分镜宫格视频生成器",
        "description": DESCRIPTION,
        "model_tree": True,
        "dynamic_model_tree_only": True,
        "notice": (
            "【输入格式】每行一个分镜：序号||关键帧提示词||视频提示词||@角色：台词\n"
            "第 2 列用 qwen2511 生成起始帧；第 3+4 列用 minimax-h3 生成视频。\n\n"
            "【单格重生成】点击宫格选中，Ctrl/Shift 多选，点重新生成按钮只生成选中格。\n"
            "【视频输出】各宫格分镜单独保存后，再按宫格顺序合并为一个可直接播放的官方 VIDEO。\n"
            "【模型加载】固定两阶段串行：全部首帧完成并卸载图片模型后，再生成视频。\n"
            "【多段对白】总时长不超过单分镜上限时保持一个视频；超时才切分，后续段延续上一段尾帧向前发展。"
        ),
    }

    _shared_cell_cache: dict[str, dict[str, Any]] = {}
    _shared_image_seed_cache: dict[str, int] = {}
    _shared_live_video_batches: dict[str, dict[str, Any]] = {}

    def __init__(self):
        self._lazy = GJJ_LazyImageStudio()
        self._storyboard_grid = GJJ_StoryboardGridGenerator()
        self._h3 = GJJ_MiniMaxH3Studio()
        self._cell_cache = self.__class__._shared_cell_cache

    @classmethod
    def INPUT_TYPES(cls):
        # qwen2511 模型选项
        kf_unets, kf_unet_default = _choices("diffusion_models", DEFAULT_KEYFRAME_UNET_KEYWORD, (DEFAULT_KEYFRAME_UNET_KEYWORD,))
        kf_clips, kf_clip_default = _choices("text_encoders", DEFAULT_KEYFRAME_CLIP_KEYWORD, (DEFAULT_KEYFRAME_CLIP_KEYWORD,))
        kf_vaes, kf_vae_default = _choices("vae", DEFAULT_KEYFRAME_VAE_KEYWORD, (DEFAULT_KEYFRAME_VAE_KEYWORD,))
        # minimax-h3 模型选项
        vd_unets, vd_unet_default = _choices("diffusion_models", DEFAULT_VIDEO_UNET_KEYWORD, (DEFAULT_VIDEO_UNET_KEYWORD,))
        vd_ref_unets, vd_ref_unet_default = _choices(
            "diffusion_models",
            STORYBOARD_REF_MODEL_KEYWORD,
            (STORYBOARD_REF_MODEL_KEYWORD,),
        )
        vd_clips, vd_clip_default = _choices("text_encoders", DEFAULT_VIDEO_CLIP_KEYWORD, (DEFAULT_VIDEO_CLIP_KEYWORD,))
        vd_vaes, vd_vae_default = _choices("vae", DEFAULT_VIDEO_VAE_KEYWORD, (DEFAULT_VIDEO_VAE_KEYWORD,))
        vd_audio_vaes, vd_audio_vae_default = _choices("vae", DEFAULT_VIDEO_AUDIO_VAE_KEYWORD, (DEFAULT_VIDEO_AUDIO_VAE_KEYWORD,))
        # 采样器/调度器（硬编码稳定列表，动态追加但不删除默认项）
        _DEFAULT_SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_sde", "heun", "lms", "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddpm", "ddim", "uni_pc", "lcm", "ddeuler"]
        _DEFAULT_SCHEDULERS = ["beta", "normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "lcm_uniform", "sgm"]
        try:
            samplers = list(comfy.samplers.KSampler.SAMPLERS)
        except Exception:
            samplers = []
        if not samplers:
            samplers = list(_DEFAULT_SAMPLERS)
        else:
            # 确保默认项在列表中
            for s in _DEFAULT_SAMPLERS:
                if s not in samplers:
                    samplers.append(s)
        try:
            schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
        except Exception:
            schedulers = []
        if not schedulers:
            schedulers = list(_DEFAULT_SCHEDULERS)
        else:
            for s in _DEFAULT_SCHEDULERS:
                if s not in schedulers:
                    schedulers.append(s)
        # 输出格式（安全获取，失败则返回默认列表）
        try:
            output_formats = list_supported_formats()
        except Exception:
            output_formats = ["video/h264-mp4", "image/gif", "image/png"]
        if not output_formats:
            output_formats = ["video/h264-mp4", "image/gif", "image/png"]
        # LoRA 默认配置（延迟到运行时动态计算，避免模块加载时 folder_paths 未初始化）
        result = {
            "required": {
                "storyboard_table": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": False,
                        "display_name": "📋 分镜表格",
                        "tooltip": "格式：序号||关键帧提示词||视频提示词||@角色：台词，每行一个分镜。第2列用 qwen2511 生成起始帧，第3+4列用 minimax-h3 生成视频。",
                    },
                ),
            },
            "optional": {
                # Keep the image stage on the same native-quality preset as
                # GJJ_StoryboardGridGenerator.  The former 864x480 / 0.4 MP
                # video-oriented default visibly softens Qwen2511 output.
                "width": ("INT", {"default": 1024, "min": 352, "max": 1920, "step": 32, "display_name": "宽度"}),
                "height": ("INT", {"default": 768, "min": 352, "max": 1920, "step": 32, "display_name": "高度"}),
                "frame_rate": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 1.0, "display_name": "帧率"}),
                "seed": ("INT", {"default": 42, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "display_name": "种子"}),
                "randomize_seed": ("BOOLEAN", {"default": True, "display_name": "随机种子"}),
                # qwen2511 图片模型
                "keyframe_unet": (kf_unets, {"default": kf_unet_default, "display_name": "起始帧模型", "gjj_default_model": kf_unet_default, "gjj_model_folder": "diffusion_models", "gjj_model_icon": "🟣", "gjj_model_keywords": [DEFAULT_KEYFRAME_UNET_KEYWORD]}),
                "keyframe_clip": (kf_clips, {"default": kf_clip_default, "display_name": "起始帧CLIP", "gjj_default_model": kf_clip_default, "gjj_model_folder": "text_encoders", "gjj_model_icon": "🟡", "gjj_model_keywords": [DEFAULT_KEYFRAME_CLIP_KEYWORD]}),
                "keyframe_vae": (kf_vaes, {"default": kf_vae_default, "display_name": "起始帧VAE", "gjj_default_model": kf_vae_default, "gjj_model_folder": "vae", "gjj_model_icon": "🔴", "gjj_model_keywords": [DEFAULT_KEYFRAME_VAE_KEYWORD]}),
                "keyframe_steps": ("INT", {"default": 4, "min": 1, "max": 100, "step": 1, "display_name": "起始帧步数"}),
                "keyframe_cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "display_name": "起始帧CFG"}),
                # minimax-h3 视频模型
                "video_unet": (vd_unets, {"default": vd_unet_default, "display_name": "视频模型", "gjj_default_model": vd_unet_default, "gjj_model_folder": "diffusion_models", "gjj_model_icon": "🟣", "gjj_model_keywords": [DEFAULT_VIDEO_UNET_KEYWORD]}),
                "video_clip": (vd_clips, {"default": vd_clip_default, "display_name": "视频CLIP", "gjj_default_model": vd_clip_default, "gjj_model_folder": "text_encoders", "gjj_model_icon": "🟡", "gjj_model_keywords": [DEFAULT_VIDEO_CLIP_KEYWORD]}),
                "video_vae": (vd_vaes, {"default": vd_vae_default, "display_name": "视频VAE", "gjj_default_model": vd_vae_default, "gjj_model_folder": "vae", "gjj_model_icon": "🔴", "gjj_model_keywords": [DEFAULT_VIDEO_VAE_KEYWORD]}),
                "video_audio_vae": (vd_audio_vaes, {"default": vd_audio_vae_default, "display_name": "音频VAE", "gjj_default_model": vd_audio_vae_default, "gjj_model_folder": "vae", "gjj_model_icon": "🔴", "gjj_model_keywords": [DEFAULT_VIDEO_AUDIO_VAE_KEYWORD]}),
                "video_steps": ("INT", {"default": DEFAULT_ACCEL_STEPS, "min": 1, "max": 100, "step": 1, "display_name": "视频步数"}),
                "video_sampler": (samplers, {"default": "euler", "display_name": "视频采样器"}),
                "video_scheduler": (schedulers, {"default": "beta", "display_name": "视频调度器"}),
                # 策略
                "model_strategy": (MODEL_STRATEGIES, {"default": "两阶段串行", "display_name": "模型加载策略", "tooltip": "两阶段串行：先生成所有起始帧再生成视频，省显存；同时加载：两个模型同时驻留；仅视频模型：跳过起始帧直接 T2V。"}),
                "output_mode": (OUTPUT_MODES, {"default": "分段输出", "display_name": "输出模式", "tooltip": "分段输出：每个分镜独立视频；合并输出：所有分镜拼接成一个长视频。"}),
                # 台词时长
                "chars_per_second": ("FLOAT", {"default": 3.0, "min": 1.0, "max": 10.0, "step": 0.5, "display_name": "语速(字/秒)", "tooltip": "台词时长估算：字数 / 每秒字数 + 停顿。"}),
                "max_shot_duration": ("FLOAT", {"default": 15.0, "min": 4.0, "max": 60.0, "step": 0.5, "display_name": "单分镜最长(秒)", "tooltip": "最低可设 4 秒；超过此时长按句分段。每个子分镜至少 4 秒，并按 17n+5 帧对齐。"}),
                # 格式
                "format_name": (output_formats, {"default": DEFAULT_FORMAT, "display_name": "输出格式"}),
                "filename_prefix": ("STRING", {"default": "video/StoryboardVideoGrid", "display_name": "文件名前缀"}),
                # 视觉/运镜
                "visual_style": (VISUAL_STYLES, {"default": "自动 / Auto", "display_name": "视觉风格"}),
                "camera_motion": (CAMERA_MOTIONS, {"default": "自动 / Auto", "display_name": "运镜"}),
                "dialogue_language": (list(DIALOGUE_LANGUAGE_TAGS), {"default": "中文", "display_name": "对白语言"}),
                "negative_prompt": ("STRING", {"default": "", "multiline": True, "display_name": "负面提示词"}),
                "lora_data": ("STRING", {"default": "[]", "display_name": "LoRA 配置"}),
                "keyframe_lora_data": ("STRING", {"default": "[]", "display_name": "首帧 LoRA 配置"}),
                "keep_model": ("BOOLEAN", {"default": False, "display_name": "保持模型"}),
                # 参考媒体（放在最后，避免打乱现有参数顺序）
                "reference_media": (MEDIA_TYPE, {"display_name": "参考媒体", "tooltip": "角色库/场景库引用图片，递归解包。"}),
                # 隐藏 widget（前端通过 ALWAYS_HIDDEN_WIDGETS 隐藏）
                "single_cell_index": ("INT", {"default": 0, "min": 0, "max": 255, "display_name": "单格生成序号", "hidden": True, "display": "hidden"}),
                "single_cell_total": ("INT", {"default": 0, "min": 0, "max": 255, "display_name": "单格总数", "hidden": True, "display": "hidden"}),
                "selected_cell_indices": ("STRING", {"default": "[]", "multiline": False, "display_name": "选中宫格序号", "hidden": True, "display": "hidden"}),
                "storyboard_full_table": ("STRING", {"default": "", "multiline": False, "display_name": "完整分镜表格", "hidden": True, "display": "hidden"}),
                "force_generate_all": ("STRING", {"default": "false", "multiline": False, "display_name": "强制全部生成", "hidden": True, "display": "hidden"}),
                "storyboard_preview_images": ("STRING", {"default": "[]", "multiline": False, "display_name": "分镜预览缓存", "hidden": True, "display": "hidden"}),
                # 与 GJJ_StoryboardGridGenerator 对齐的图片入口。为保持旧工作流
                # 参数位置不变，只能追加在既有 optional 列表末尾。
                "scene": (f"{GJJ_BATCH_IMAGE_TYPE},IMAGE", {"display_name": "🏞️ 场景", "tooltip": "与分镜宫格生成器相同：作为场景参考参与 Qwen2511 图片生成。"}),
                "reference": (f"{GJJ_BATCH_IMAGE_TYPE},IMAGE", {"display_name": "🖼️ 参考图", "tooltip": "与分镜宫格生成器相同：作为普通参考图参与 Qwen2511 图片生成。"}),
                "lora_chain_config": ("LORA_CHAIN_CONFIG", {"display_name": "🔗 LoRA串联配置"}),
                "video_ref_unet": (vd_ref_unets, {"default": vd_ref_unet_default, "display_name": "参考视频模型", "gjj_default_model": vd_ref_unet_default, "gjj_model_folder": "diffusion_models", "gjj_model_icon": "🟣", "gjj_model_keywords": [STORYBOARD_REF_MODEL_KEYWORD]}),
                "video_ref_lora_data": ("STRING", {"default": _default_ref_video_lora_data(), "display_name": "参考视频加速 LoRA"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt_info": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }
        return result

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        randomize_raw = kwargs.get("randomize_seed", True)
        randomize_val = randomize_raw[0] if isinstance(randomize_raw, list) and randomize_raw else randomize_raw
        if bool(randomize_val):
            return time.time_ns()
        digest = hashlib.sha256()
        for key in sorted(kwargs):
            if key == "video_unet":
                # Legacy FL2VA slot is retained only to preserve old workflow
                # widget positions. Storyboard video generation is R2V and
                # exclusively uses video_ref_unet.
                continue
            digest.update(f"{key}={kwargs[key]}|".encode("utf-8", errors="replace"))
        return digest.hexdigest()

    def generate(self, **kwargs):
        def first(name: str, default: Any = None):
            value = kwargs.get(name, default)
            return value[0] if isinstance(value, list) and value else value

        # ===== 全面参数验证层（解决重启后参数错位问题）=====
        # 每个参数都必须通过类型+范围检查，失败则回退到默认值
        _param_defaults: Dict[str, tuple] = {
            "width": (1024, int, 352, 1920, 32),
            "height": (768, int, 352, 1920, 32),
            "frame_rate": (24.0, float, 1.0, 120.0, None),
            "seed": (42, int, 0, 0xFFFFFFFFFFFFFFFF, None),
            "keyframe_steps": (4, int, 1, 100, 1),
            "keyframe_cfg": (1.0, float, 0.0, 20.0, None),
            "video_steps": (DEFAULT_ACCEL_STEPS, int, 1, 100, 1),
            "chars_per_second": (3.0, float, 1.0, 10.0, None),
            "max_shot_duration": (15.0, float, 4.0, 60.0, None),
        }

        def _validate_param(name: str) -> Any:
            """验证参数，无效时返回默认值并打印修复日志。"""
            if name not in _param_defaults:
                return first(name)
            default_val, py_type, pmin, pmax, pstep = _param_defaults[name]
            raw = first(name, default_val)
            try:
                if raw is None:
                    raise ValueError("参数为空")
                if py_type is int:
                    v = int(float(raw))
                else:
                    v = float(raw)
                # 检查 NaN / Inf
                if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
                    raise ValueError(f"参数 {name} 值无效: {raw}")
                # 检查范围
                if v < pmin or v > pmax:
                    raise ValueError(f"参数 {name} 超出范围 [{pmin}, {pmax}]: {v}")
                # 按 step 对齐
                if pstep is not None:
                    v = pmin + round((v - pmin) / pstep) * pstep
                return py_type(v)
            except (TypeError, ValueError) as e:
                print(f"[GJJ StoryboardVideoGrid] 修复参数 {name}: 值={raw!r} → 默认值={default_val}（原因: {e}）")
                return default_val

        # 解析基本参数（带范围保护）
        storyboard_table = _safe_text(first("storyboard_table"))
        if not storyboard_table:
            raise RuntimeError("分镜表格为空。请填写：序号||关键帧提示词||视频提示词||@角色：台词")

        width = _validate_param("width")
        height = _validate_param("height")
        frame_rate = _validate_param("frame_rate")
        seed = _validate_param("seed")
        randomize_seed = _parse_bool(first("randomize_seed", True), True)

        # 模型参数（运行时验证，确保模型文件存在）
        keyframe_unet = _safe_text(first("keyframe_unet"))
        keyframe_clip = _safe_text(first("keyframe_clip"))
        keyframe_vae = _safe_text(first("keyframe_vae"))
        keyframe_steps = _validate_param("keyframe_steps")
        keyframe_cfg = _validate_param("keyframe_cfg")
        # The image stage is deliberately the Qwen2511 preset from
        # GJJ_StoryboardGridGenerator, not a separately tunable video preset.
        # Legacy positional widget restoration can yield valid-looking values
        # such as CFG=4; with the 4-step Lightning LoRA that causes severe
        # over-guidance (soft/oily faces and hard halos).
        if keyframe_steps != 4 or abs(float(keyframe_cfg) - 1.0) > 1e-6:
            print(
                "[GJJ StoryboardVideoGrid] 对齐 GJJ_StoryboardGridGenerator 图片预设："
                f"steps {keyframe_steps} → 4，CFG {keyframe_cfg:g} → 1",
                flush=True,
            )
        keyframe_steps = 4
        keyframe_cfg = 1.0

        video_unet = _safe_text(first("video_unet"))
        video_ref_unet = _safe_text(first("video_ref_unet", STORYBOARD_REF_MODEL_KEYWORD))
        video_ref_lora_data = _safe_text(first("video_ref_lora_data", _default_ref_video_lora_data()))
        if not _has_configured_lora_data(video_ref_lora_data):
            video_ref_lora_data = _default_ref_video_lora_data()
        video_ref_lora_data = _ensure_ref_video_accel_lora_data(video_ref_lora_data)
        video_clip = _safe_text(first("video_clip"))
        video_vae = _safe_text(first("video_vae"))
        video_audio_vae = _safe_text(first("video_audio_vae"))
        video_steps = _validate_param("video_steps")
        video_sampler = _safe_text(first("video_sampler", "euler"))
        video_scheduler = _safe_text(first("video_scheduler", "beta"))

        # 运行时验证模型参数（确保模型文件存在，修复无效值）
        keyframe_unet = _validate_model_param(keyframe_unet, "diffusion_models", DEFAULT_KEYFRAME_UNET_KEYWORD, True)
        keyframe_clip = _validate_model_param(keyframe_clip, "text_encoders", DEFAULT_KEYFRAME_CLIP_KEYWORD, True)
        keyframe_vae = _validate_model_param(keyframe_vae, "vae", DEFAULT_KEYFRAME_VAE_KEYWORD, True)
        keyframe_clip, keyframe_vae = _ensure_next_scene_image_edit_clip_vae(
            keyframe_unet, keyframe_clip, keyframe_vae
        )
        # video_unet is a legacy compatibility slot. Do not validate or load
        # FL2VA: this node always supplies an image reference and runs the
        # MiniMax H3 R2V branch through video_ref_unet only.
        video_ref_unet = _validate_model_param(
            video_ref_unet,
            "diffusion_models",
            STORYBOARD_REF_MODEL_KEYWORD,
        )
        video_clip = _validate_model_param(video_clip, "text_encoders", DEFAULT_VIDEO_CLIP_KEYWORD)
        video_vae = _validate_model_param(video_vae, "vae", DEFAULT_VIDEO_VAE_KEYWORD)
        video_audio_vae = _validate_model_param(video_audio_vae, "vae", DEFAULT_VIDEO_AUDIO_VAE_KEYWORD)

        model_strategy = _safe_text(first("model_strategy", "两阶段串行"))
        output_mode = _safe_text(first("output_mode", "分段输出"))
        chars_per_second = _validate_param("chars_per_second")
        max_shot_duration = _validate_param("max_shot_duration")
        format_name = _safe_text(first("format_name", DEFAULT_FORMAT))
        filename_prefix = _safe_text(first("filename_prefix", "video/StoryboardVideoGrid"))
        visual_style = _validate_enum_param(_safe_text(first("visual_style")), VISUAL_STYLES, "自动 / Auto")
        camera_motion = _validate_enum_param(_safe_text(first("camera_motion")), CAMERA_MOTIONS, "自动 / Auto")
        dialogue_language = _validate_enum_param(_safe_text(first("dialogue_language")), list(DIALOGUE_LANGUAGE_TAGS), "中文")
        model_strategy = _validate_enum_param(model_strategy, MODEL_STRATEGIES, "两阶段串行")
        # 模型策略切换已取消；所有完整生成固定走图片阶段卸载后再进入视频阶段。
        model_strategy = "两阶段串行"
        output_mode = _validate_enum_param(output_mode, OUTPUT_MODES, "分段输出")
        # 输出模式切换已取消：子分镜先合并为父分镜，所有父分镜再按
        # 宫格顺序合并为唯一完整 VIDEO。保留旧参数仅用于位置兼容。
        output_mode = "合并输出"
        format_name = _validate_enum_param(format_name, list_supported_formats(), DEFAULT_FORMAT)
        negative_prompt = _safe_text(first("negative_prompt"))
        # Old saved instances created before the optional inputs were appended
        # can restore widget values by position.  A common corruption is the
        # dialogue language landing in the image negative prompt, which changes
        # Qwen2511 conditioning after every restart.
        if negative_prompt.strip() in DIALOGUE_LANGUAGE_TAGS:
            print(
                f"[GJJ StoryboardVideoGrid] 修复重启后的参数错位："
                f"negative_prompt={negative_prompt!r} → ''",
                flush=True,
            )
            negative_prompt = ""
        lora_data = _safe_text(first("lora_data", "[]"))
        keyframe_lora_data = _safe_text(first("keyframe_lora_data", "[]"))
        keep_model = _parse_bool(first("keep_model", False), False)

        # 动态加载默认 LoRA（如果用户没有配置）
        if not lora_data or lora_data == "[]":
            lora_data = _default_accel_lora_data()
        if not _has_configured_lora_data(keyframe_lora_data):
            keyframe_lora_data = _preset_lora_data(keyframe_unet)
        else:
            keyframe_lora_data = _ensure_next_scene_lora_data(keyframe_lora_data, keyframe_unet)
        keyframe_lora_data = _ensure_keyframe_accel_lora_data(keyframe_lora_data)
        keyframe_lora_data, storyboard_lora_name = _split_storyboard_lora_data(keyframe_lora_data)

        unique_id = first("unique_id")
        single_cell_index = int(first("single_cell_index", 0) or 0)
        single_cell_total = int(first("single_cell_total", 0) or 0)
        selected_cell_indices_raw = _safe_text(first("selected_cell_indices"))
        storyboard_full_table = _safe_text(first("storyboard_full_table"))
        force_generate_raw = _safe_text(first("force_generate_all", "false"))
        force_generate_all = _parse_bool(force_generate_raw, False)
        # keyframe_only = 只生成首帧；video_only = 只生成视频
        gen_mode = force_generate_raw if force_generate_raw in ("keyframe_only", "video_only") else ("keyframe_only" if force_generate_raw == "true" else "all")
        seed_cache_key = _safe_text(unique_id).strip()
        if randomize_seed:
            if gen_mode == "video_only" and seed_cache_key in self._shared_image_seed_cache:
                seed = self._shared_image_seed_cache[seed_cache_key]
            else:
                seed = time.time_ns() % (2**32)
                if seed_cache_key:
                    self._shared_image_seed_cache[seed_cache_key] = seed

        # 参考媒体由下方与 GJJ_StoryboardGridGenerator 相同的逐格解析流程处理。
        reference_media = first("reference_media")
        scene_media = first("scene")
        image_reference_media = first("reference")
        # Image generation must match GJJ_StoryboardGridGenerator exactly:
        # only its `scene` and `reference` sockets participate.  The legacy
        # `reference_media` socket belongs to the video stage and may contain a
        # mixed/low-resolution media batch; feeding it to Qwen2511 softens the
        # result and changes reference ordering.
        keyframe_lora_chain_config = first("lora_chain_config", "")
        if reference_media is not None:
            ref_count = len(_split_media(reference_media))
            _send_status(unique_id, f"已加载 {ref_count} 张外部参考图", 0.0)

        # 解析表格（优先使用完整快照）
        table_for_parse = storyboard_full_table if storyboard_full_table else storyboard_table
        shots = _parse_storyboard_table(table_for_parse)
        if not shots:
            raise RuntimeError("未解析到有效分镜。请检查表格格式：序号||关键帧提示词||视频提示词||@角色：台词")
        for shot in shots:
            duration, sub_shots = _calculate_shot_duration(
                shot.dialogues, chars_per_second, max_shot_duration, shot.video_prompt, frame_rate
            )
            shot.total_duration = duration
            shot.sub_shots = sub_shots
        live_batch_key = _safe_text(unique_id).strip()
        requested_full_batch = single_cell_total <= 0
        reset_live_videos = bool(
            live_batch_key and requested_full_batch and gen_mode in ("all", "video_only")
        )
        live_run_token = ""
        if reset_live_videos:
            # Reset before the image stage emits its first progress event.  If
            # this waited until video sampling began, the frontend poll could
            # briefly restore records from the previous run.
            self.__class__._shared_live_video_batches[live_batch_key] = {
                "run_token": str(time.time_ns()),
                "total": len(shots),
                "records": [],
            }
            live_run_token = str(
                self.__class__._shared_live_video_batches[live_batch_key]["run_token"]
            )
        _send_storyboard_plan(
            unique_id,
            shots,
            reset_videos=reset_live_videos,
            run_token=live_run_token,
            table_signature=hashlib.sha256(
                table_for_parse.replace("\r\n", "\n").strip().encode("utf-8", errors="replace")
            ).hexdigest(),
        )

        # 图片调试模式：完整、直接地委托给 GJJ_StoryboardGridGenerator，
        # 随即返回。不要再经过本节点自己的缓存、单格筛选或视频阶段，
        # 否则 👤/🏕️ 上下文、参考图顺序和批次数量都会产生第二套行为。
        # StoryboardGridGenerator only treats blank lines / standalone `---` /
        # Scene lines as cell separators.  A plain newline merges every shot into
        # one prompt, which produces exactly one image and mixes all references.
        # Pass the original keyframe prompts unchanged and use its canonical
        # separator so its per-cell 👤/🏕️ reference resolver runs independently.
        image_prompts = [shot.keyframe_prompt.strip() for shot in shots]
        all_image_prompt = "\n\n---\n\n".join(image_prompts)
        display_index_to_position = {shot.index: position for position, shot in enumerate(shots, start=1)}
        # A cell selection is valid only while the frontend explicitly enables
        # cell mode with a positive total.  Hidden widget values can survive a
        # previous single-cell run; treating those stale values as active makes
        # a later full-batch click generate just the previously selected cell.
        cell_mode_enabled = single_cell_total > 0
        single_position = (
            display_index_to_position.get(single_cell_index, 0)
            if cell_mode_enabled
            else 0
        )
        try:
            requested_display_indices = json.loads(selected_cell_indices_raw or "[]")
        except Exception:
            requested_display_indices = []
        selected_positions = [
            display_index_to_position[index]
            for index in requested_display_indices
            if isinstance(index, int) and index in display_index_to_position
        ] if cell_mode_enabled and isinstance(requested_display_indices, list) else []
        if single_position:
            delegated_prompt = image_prompts[single_position - 1]
            delegated_single_index = single_position
            delegated_selected_indices = "[]"
            delegated_total = len(shots)
            generation_label = f"单格 {single_position}/{len(shots)}"
        elif selected_positions:
            delegated_prompt = "\n\n---\n\n".join(image_prompts[position - 1] for position in selected_positions)
            delegated_single_index = 0
            delegated_selected_indices = json.dumps(selected_positions, ensure_ascii=False)
            delegated_total = len(shots)
            generation_label = f"选中 {len(selected_positions)}/{len(shots)} 格"
        else:
            delegated_prompt = all_image_prompt
            delegated_single_index = 0
            delegated_selected_indices = "[]"
            delegated_total = 0
            generation_label = f"全部 {len(shots)} 格"
        if gen_mode == "video_only":
            # Video-only requests must reuse the persisted/current storyboard
            # images as references. Preserve the caller's selection: clicking a
            # single cell's 🎬 must never expand into an all-cell image request.
            # If its persisted preview is unavailable, the source generator may
            # repair that one cell only.
            if single_position:
                generation_label = f"读取单格 {single_position}/{len(shots)} 首帧参考缓存"
            elif selected_positions:
                generation_label = f"读取选中 {len(selected_positions)}/{len(shots)} 格首帧参考缓存"
            else:
                delegated_prompt = all_image_prompt
                delegated_single_index = 0
                delegated_selected_indices = "[]"
                delegated_total = 0
                generation_label = f"读取全部 {len(shots)} 格首帧参考缓存"
        image_width = width
        image_height = height
        minimum_qwen_pixels = int(0.8 * 1024 * 1024)
        requested_pixels = max(1, int(width) * int(height))
        if requested_pixels < minimum_qwen_pixels:
            quality_scale = math.sqrt(minimum_qwen_pixels / requested_pixels)
            image_width = min(1920, int(math.ceil(width * quality_scale / 32.0) * 32))
            image_height = min(1920, int(math.ceil(height * quality_scale / 32.0) * 32))
            print(
                "[GJJ StoryboardVideoGrid][低 MP 防参考板拼接] "
                f"内部生成={image_width}x{image_height}，输出={width}x{height}",
                flush=True,
            )
        print(
            f"[GJJ StoryboardVideoGrid][直接图片模式] 表格分镜={len(shots)}，"
            f"委托 GJJ_StoryboardGridGenerator 生成：{generation_label}",
            flush=True,
        )
        print(
            "[GJJ StoryboardVideoGrid][图片参数] "
            f"UNET={keyframe_unet} · CLIP={keyframe_clip} · VAE={keyframe_vae} · "
            f"steps={keyframe_steps} · cfg={keyframe_cfg:g} · sampler=euler · scheduler=simple · "
            f"LoRA={keyframe_lora_data} · StoryboardLoRA={storyboard_lora_name or '无'}",
            flush=True,
        )
        # Every video-only request is strictly video-only. Load the persisted
        # preview tensors directly; never invoke Qwen as a hidden fallback.
        if gen_mode == "video_only":
            requested_video_positions = (
                [single_position]
                if single_position
                else (selected_positions if selected_positions else list(range(1, len(shots) + 1)))
            )
            persisted_preview_images = first("storyboard_preview_images", "[]")
            preview_cells = _load_storyboard_preview_cells(
                persisted_preview_images, image_width, image_height, None
            )
            preview_layout_versions = _storyboard_preview_layout_versions(persisted_preview_images)
            missing_positions = [
                position for position in requested_video_positions
                if (
                    not isinstance(preview_cells.get(position), torch.Tensor)
                    or preview_layout_versions.get(position) != STORYBOARD_IMAGE_EDIT_LAYOUT_VERSION
                )
            ]
            if missing_positions:
                missing_labels = "、".join(str(shots[position - 1].index) for position in missing_positions)
                raise RuntimeError(
                    f"分镜 {missing_labels} 没有当前版本的有效首帧。旧版角色资产卡缓存已禁止进入视频；"
                    "请先点击对应单元格的 🖼️ 重新生成图片，确认是正常镜头画面后再生成视频。"
                )
            output_images = [preview_cells[position] for position in requested_video_positions]
            keyframe_batch = torch.cat(output_images, dim=0).contiguous()
            grid_image = _make_grid(
                output_images, image_width, image_height, "自动", 0, "铺满裁切", "lanczos", "关闭"
            )
            print(
                f"[GJJ StoryboardVideoGrid][纯视频模式] 直接读取已保存首帧 "
                f"{requested_video_positions}，完全跳过图片模型。",
                flush=True,
            )
        else:
            delegated = self._storyboard_grid.generate(
                prompt=delegated_prompt,
                negative_prompt=negative_prompt,
                main_image_index=1,
                width=image_width,
                height=image_height,
                batch_size=1,
                unet_name=keyframe_unet,
                unet_dtype="default",
                clip_name1=keyframe_clip,
                vae_name=keyframe_vae,
                seed=seed,
                steps=keyframe_steps,
                cfg=keyframe_cfg,
                sampler_name="euler",
                scheduler="simple",
                denoise=1.0,
                grow_mask_by=6,
                layout_mode="自动",
                gap=0,
                cell_fit="铺满裁切",
                resize_method="lanczos",
                size_alignment="关闭",
                scene=scene_media,
                reference=image_reference_media,
                lora_chain_config=keyframe_lora_chain_config,
                lora_data=keyframe_lora_data,
                single_cell_index=delegated_single_index,
                single_cell_total=delegated_total,
                selected_cell_indices=delegated_selected_indices,
                storyboard_full_prompt=all_image_prompt if delegated_total else "",
                force_generate_all="false" if delegated_total or gen_mode == "video_only" else "true",
                storyboard_preview_images=first("storyboard_preview_images", "[]") if gen_mode == "video_only" else "[]",
                storyboard_lora_name=storyboard_lora_name,
                # 全量两阶段执行时图片模型绝不跨阶段保留。
                keep_model_loaded=keep_model if gen_mode == "keyframe_only" else False,
                unique_id=unique_id,
                storyboard_plan_cells=_storyboard_plan_cells(shots),
                prompt_graph=first("prompt_info"),
                extra_pnginfo=first("extra_pnginfo"),
            )
            grid_image = delegated[0] if isinstance(delegated, tuple) and len(delegated) > 0 else None
            keyframe_batch = delegated[1] if isinstance(delegated, tuple) and len(delegated) > 1 else None
        if not isinstance(grid_image, torch.Tensor) or not isinstance(keyframe_batch, torch.Tensor):
            raise RuntimeError("GJJ_StoryboardGridGenerator 未返回有效宫格与分镜图片。")
        if image_width != width or image_height != height:
            keyframe_batch = _resize_bhwc_exact(keyframe_batch, width, height)
            grid_target_width = max(1, round(int(grid_image.shape[2]) * width / image_width))
            grid_target_height = max(1, round(int(grid_image.shape[1]) * height / image_height))
            grid_image = _resize_bhwc_exact(grid_image, grid_target_width, grid_target_height)
        if not delegated_total and int(keyframe_batch.shape[0]) != len(shots):
            raise RuntimeError(
                f"GJJ_StoryboardGridGenerator 返回数量错误：表格 {len(shots)} 格，返回 {int(keyframe_batch.shape[0])} 张。"
            )
        print(
            f"[GJJ StoryboardVideoGrid][直接图片模式] 返回={int(keyframe_batch.shape[0])} "
            f"宫格={tuple(grid_image.shape)} 图片={tuple(keyframe_batch.shape)}",
            flush=True,
        )
        if gen_mode != "keyframe_only":
            # Preserve only CPU pixels across the model-family boundary. No
            # image-stage tensor is allowed to pin CUDA memory during H3 load.
            keyframe_batch = keyframe_batch.detach().to(device="cpu", dtype=torch.float32).contiguous()
            grid_image = grid_image.detach().to(device="cpu", dtype=torch.float32).contiguous()
            _send_status(unique_id, "视频阶段准备：正在清空图片模型资源…", 0.01)
            _release_image_resources(
                self._lazy,
                getattr(self._storyboard_grid, "_lazy", None),
            )
            print(
                "[GJJ StoryboardVideoGrid][模型切换] 图片 UNET / CLIP / VAE / LoRA "
                "运行时缓存已清空，CUDA 已同步；开始加载 MiniMax-H3。",
                flush=True,
            )
            if single_position:
                video_positions = [single_position]
            elif selected_positions:
                video_positions = selected_positions
            else:
                video_positions = list(range(1, len(shots) + 1))
            full_batch = not single_position and not selected_positions
            if live_batch_key and full_batch:
                live_batch = self.__class__._shared_live_video_batches.setdefault(
                    live_batch_key,
                    {"run_token": str(time.time_ns()), "total": len(video_positions), "records": []},
                )
                live_batch["total"] = len(video_positions)
            if int(keyframe_batch.shape[0]) == len(shots):
                keyframe_by_position = {
                    position: keyframe_batch[position - 1:position]
                    for position in video_positions
                }
            else:
                keyframe_by_position = {
                    position: keyframe_batch[offset:offset + 1]
                    for offset, position in enumerate(video_positions)
                    if offset < int(keyframe_batch.shape[0])
                }
            video_results: list[Any] = []
            video_preview_items: list[Dict[str, Any]] = []
            for queue_index, position in enumerate(video_positions, start=1):
                shot = shots[position - 1]
                keyframe_tensor = keyframe_by_position.get(position)
                if not isinstance(keyframe_tensor, torch.Tensor):
                    raise RuntimeError(f"分镜 {shot.index} 缺少首帧参考图，无法生成参考视频。")
                try:
                    ref_lora_names = [
                        str(row.get("name", ""))
                        for row in json.loads(video_ref_lora_data or "[]")
                        if isinstance(row, dict) and row.get("enabled", True) is not False and row.get("name")
                    ]
                except Exception:
                    ref_lora_names = []
                print(
                    "[GJJ StoryboardVideoGrid] REF2V 加速 LoRA："
                    + ("、".join(ref_lora_names) if ref_lora_names else "未找到（无加速 LoRA）"),
                    flush=True,
                )
                cell_id = position - 1
                _send_cell_preview(
                    unique_id, cell_id, shot.index, len(shots), "video", "generating",
                    duration=shot.total_duration,
                )
                child_videos: list[Any] = []
                child_results: list[Any] = []
                sub_shots = shot.sub_shots or [SubShot(0.0, shot.total_duration, [])]
                for child_index, sub_shot in enumerate(sub_shots, start=1):
                    child_duration = max(1.0, float(sub_shot.end_time - sub_shot.start_time))
                    prompt_sub_shot = SubShot(0.0, child_duration, list(sub_shot.dialogues))
                    child_video_prompt = (
                        shot.video_prompt
                        if child_index == 1
                        else _continuation_video_prompt(child_index)
                    )
                    h3_prompt = _build_h3_video_prompt(
                        child_video_prompt,
                        [prompt_sub_shot],
                        child_duration,
                        dialogue_language,
                        visual_style,
                        camera_motion,
                    )
                    child_label = f"{shot.index}-{child_index}"
                    print(
                        f"\n[GJJ StoryboardVideoGrid] ===== MiniMax-H3 子分镜 {child_label} =====\n"
                        f"{h3_prompt}\n"
                        f"[GJJ StoryboardVideoGrid] ===== 子分镜提示词结束 =====\n",
                        flush=True,
                    )
                    _send_status(
                        unique_id,
                        f"视频阶段：生成分镜 {child_label}（{child_index}/{len(sub_shots)}）",
                        0.1 + 0.8 * ((queue_index - 1 + child_index / len(sub_shots)) / len(video_positions)),
                    )
                    h3_result = self._h3.generate(
                        prompt=h3_prompt,
                        reference_media=keyframe_tensor.detach().cpu().float().contiguous(),
                        image_branch="参考",
                        prompt_structure="参考六字段",
                        first_frame_lock=True,
                        width=width,
                        height=height,
                        duration=child_duration,
                        frame_rate=frame_rate,
                        steps=video_steps,
                        seed=seed + (position - 1) * 100 + child_index - 1,
                        randomize_seed=False,
                        sampler_name=video_sampler,
                        scheduler=video_scheduler,
                        denoise=1.0,
                        ref_model=video_ref_unet,
                        clip_name=video_clip,
                        video_vae_name=video_vae,
                        audio_vae_name=video_audio_vae,
                        keep_model=True,
                        filename_prefix=f"{filename_prefix}_分镜{shot.index}-{child_index}",
                        format_name=format_name,
                        lora_data=video_ref_lora_data,
                        negative_prompt=negative_prompt,
                        dialogue_language=dialogue_language,
                        reasoning_enabled=False,
                        spectrum_enabled=False,
                        cache_clip=False,
                        progress_queue_index=queue_index,
                        progress_queue_total=len(video_positions),
                        progress_sub_index=child_index,
                        progress_sub_total=len(sub_shots),
                        unique_id=unique_id,
                        prompt_info=first("prompt_info"),
                        extra_pnginfo=first("extra_pnginfo"),
                    )
                    child_video = h3_result.get("result", (None, None))[0] if isinstance(h3_result, dict) else None
                    if child_video is None:
                        raise RuntimeError(f"子分镜 {child_label} MiniMax-H3 参考视频生成失败。")
                    child_videos.append(child_video)
                    child_results.append(h3_result)
                    if child_index < len(sub_shots):
                        chained_frame = _last_video_frame(child_video)
                        if not isinstance(chained_frame, torch.Tensor):
                            raise RuntimeError(
                                f"子分镜 {child_label} 无法读取尾帧，不能作为 "
                                f"{shot.index}-{child_index + 1} 的起始帧。"
                            )
                        keyframe_tensor = chained_frame

                if len(child_videos) > 1:
                    _send_status(
                        unique_id,
                        f"队列 {queue_index}/{len(video_positions)} · 正在合并 {len(child_videos)} 个子分镜...",
                        ((queue_index - 1) + 0.98) / max(1, len(video_positions)),
                    )
                    video_output = self._combine_videos(
                        child_videos,
                        frame_rate,
                        f"{filename_prefix}_分镜{shot.index}",
                        format_name,
                        unique_id,
                    )
                    _send_status(
                        unique_id,
                        f"队列 {queue_index}/{len(video_positions)} · 分镜 {shot.index} 视频合并完成",
                        queue_index / max(1, len(video_positions)),
                    )
                    video_item = _video_preview_item(getattr(self, "_last_combined_result", None), video_output)
                else:
                    video_output = child_videos[0]
                    video_item = _video_preview_item(child_results[0], video_output)
                video_results.append(video_output)
                video_url = str(video_item.get("url", "") or "")
                video_record = {
                    "cell_id": int(cell_id),
                    "index": int(shot.index),
                    "duration": float(shot.total_duration),
                    "item": video_item,
                    "video_url": video_url,
                }
                video_preview_items.append(video_record)
                if live_batch_key:
                    live_batch = self.__class__._shared_live_video_batches.setdefault(
                        live_batch_key,
                        {
                            "run_token": str(time.time_ns()),
                            "total": len(video_positions),
                            "records": [],
                        },
                    )
                    live_batch["total"] = len(video_positions)
                    live_batch["records"] = [dict(record) for record in video_preview_items]
                _send_cell_preview(
                    unique_id, cell_id, shot.index, len(shots), "video", "done",
                    video_url=video_url, duration=shot.total_duration,
                    item=video_item,
                )
                # The progress channel is already consumed continuously by the
                # panel during long jobs.  Carry the completed record on that
                # same reliable channel as a fallback in case a browser/proxy
                # drops the dedicated per-cell event.
                _send_status(
                    unique_id,
                    f"队列 {queue_index}/{len(video_positions)} · 分镜 {shot.index} 视频完成",
                    queue_index / max(1, len(video_positions)),
                    {
                        "video_record": video_record,
                        # Keep a flat copy for websocket clients/proxies that
                        # discard nested custom-event objects.
                        "completed_cell_id": int(cell_id),
                        "completed_index": int(shot.index),
                        "completed_duration": float(shot.total_duration),
                        "completed_video_filename": str(video_item.get("filename", "") or ""),
                        "completed_video_subfolder": str(video_item.get("subfolder", "") or ""),
                        "completed_video_type": str(video_item.get("type", "output") or "output"),
                        "completed_video_url": str(video_url or video_item.get("url", "") or ""),
                    },
                )
                # Batch-safe cumulative reconciliation after every completed
                # cell, so play buttons appear before the whole queue finishes.
                _send_video_batch_preview(unique_id, video_preview_items, len(video_positions))
            if len(video_results) > 1:
                _send_status(unique_id, f"正在按宫格顺序合并 {len(video_results)} 个分镜视频...", 0.99)
                final_video: Any = self._combine_videos(
                    video_results,
                    frame_rate,
                    f"{filename_prefix}_完整视频",
                    format_name,
                    unique_id,
                )
            else:
                final_video = video_results[0] if video_results else None
            if full_batch and len(video_results) != len(shots):
                raise RuntimeError(
                    f"完整视频缺少分镜：计划 {len(shots)} 个，实际生成 {len(video_results)} 个。"
                )
            final_video_item = _video_preview_item(
                getattr(self, "_last_combined_result", None), final_video
            )
            _send_video_batch_preview(unique_id, video_preview_items, len(video_positions))
            _send_status(unique_id, f"全部分镜视频生成完成：{len(video_results)}/{len(video_positions)}", 1.0)
            if not keep_model:
                _unload_all_models()
            return {
                "ui": {
                    "output_mode": [output_mode],
                    "shot_count": [len(video_positions)],
                    "storyboard_videos": video_preview_items,
                    "videos": [final_video_item] if final_video_item else [],
                    "complete_video": [final_video_item] if final_video_item else [],
                },
                "result": (final_video,),
            }
        return {
            "ui": {},
            "result": (None,),
        }

        # 计算每个分镜的时长和子分镜
        for shot in shots:
            duration, sub_shots = _calculate_shot_duration(
                shot.dialogues, chars_per_second, max_shot_duration, shot.video_prompt, frame_rate
            )
            shot.total_duration = duration
            shot.sub_shots = sub_shots

        # 建立 index → cell_id 映射（cell_id 为 0-based 顺序编号，避免 index 重复冲突）
        # 遇到重复 index 时保留第一次出现的 cell_id
        shot_cell_ids: dict[int, int] = {}  # shot.index → cell_id
        for cell_id, shot in enumerate(shots):
            if shot.index not in shot_cell_ids:
                shot_cell_ids[shot.index] = cell_id

        # 收集所有有效 shot 的 index 集合（用于后续验证）
        valid_indices = {shot.index for shot in shots}

        # 判断单格/多选模式
        selected_indices: list[int] = []
        if single_cell_total > 0:
            try:
                parsed = json.loads(selected_cell_indices_raw or "[]")
                if isinstance(parsed, list):
                    for v in parsed:
                        try:
                            iv = int(v)
                            if iv in valid_indices:
                                selected_indices.append(iv)
                        except Exception:
                            continue
            except Exception:
                pass

        single_cell_mode = single_cell_index > 0 and single_cell_total > 0
        selected_cell_mode = bool(selected_indices) and single_cell_total > 0
        geometry_count = len(shots)
        storyboard_character_refs = _storyboard_character_context(
            [shot.keyframe_prompt for shot in shots]
        )

        # 建立缓存
        cache_key = _safe_text(unique_id) or "default"
        cell_signatures = {}
        for shot in shots:
            cell_signatures[shot.index] = _shot_cache_signature(
                shot, width, height, seed + shot.index - 1,
                keyframe_unet=keyframe_unet,
                keyframe_clip=keyframe_clip,
                keyframe_vae=keyframe_vae,
                keyframe_steps=keyframe_steps,
                keyframe_cfg=keyframe_cfg,
                keyframe_lora_data=keyframe_lora_data,
                scene_media=scene_media,
                reference_media=image_reference_media,
                video_unet=video_unet,
                video_steps=video_steps,
            )

        cache = self._cell_cache.get(cache_key)
        cached_signatures = dict(cache.get("signatures", {})) if isinstance(cache, dict) else {}
        if force_generate_all or not cache:
            cache = {"cells": {}, "signatures": cell_signatures}
            self._cell_cache[cache_key] = cache
        else:
            cached_cells = cache.get("cells", {}) if isinstance(cache.get("cells"), dict) else {}
            for idx, current_signature in cell_signatures.items():
                if cached_signatures.get(idx) != current_signature:
                    cached_cells.pop(idx, None)
            cache["cells"] = cached_cells
            cache["signatures"] = cell_signatures

        # 确定需要生成的格子
        if single_cell_mode:
            active_indices = {single_cell_index}
        elif selected_cell_mode:
            active_indices = set(selected_indices)
        else:
            active_indices = valid_indices

        # 过滤掉缓存中签名未变的格子
        explicit_generation = single_cell_mode or selected_cell_mode or force_generate_raw in ("keyframe_only", "video_only")
        to_generate: list[int] = []
        for idx in active_indices:
            if idx not in valid_indices:
                continue
            cached_cell = cache.get("cells", {}).get(idx)
            cached_sig = cached_signatures.get(idx)
            current_sig = cell_signatures.get(idx)
            if cached_cell and cached_sig == current_sig and not force_generate_all and not explicit_generation:
                continue
            to_generate.append(idx)

        # 图片参考模式调试期间固定整批重建，忽略旧的单格状态、选中状态
        # 和内存缓存，确保每次都把完整分镜交给宫格生成器。
        to_generate = [shot.index for shot in shots]
        cache["cells"] = {}

        if not to_generate:
            _send_status(unique_id, "所有分镜已缓存，直接输出", 1.0)
        else:
            total_gen = len(to_generate)
            # === 阶段 1：qwen2511 生成起始帧 ===
            skip_keyframe = False
            # 临时暂停全部视频生成：当前阶段只校准
            # GJJ_StoryboardGridGenerator 的图片/参考模式。即使旧工作流、
            # 普通节点运行或误传 video_only，也绝不加载 MiniMax-H3。
            skip_video = True
            if not skip_keyframe:
                _send_status(unique_id, f"阶段1：生成起始帧 0/{total_gen}", 0.0)
                requested_image_indices = set(to_generate)
                image_shots = [shot for shot in shots if shot.index in requested_image_indices]
                image_indices = [shot.index for shot in image_shots]
                selected_prompt = "\n".join(
                    f"[{shot.index}] {shot.keyframe_prompt}" for shot in image_shots
                )
                full_keyframe_prompt = "\n".join(
                    f"[{shot.index}] {shot.keyframe_prompt}" for shot in shots
                )
                for idx in image_indices:
                    cell_id = shot_cell_ids.get(idx, idx - 1)
                    _send_cell_preview(unique_id, cell_id, idx, geometry_count, "keyframe", "generating")

                # 参考模式必须整批执行：宫格生成器需要同时看到全部待生成
                # 分镜，才能稳定建立 👤/🏕️ 上下文和 image1..image3 槽位。
                print(
                    f"[GJJ StoryboardVideoGrid][图片整批] 请求={len(image_indices)} "
                    f"序号={image_indices} 场景输入={'有' if scene_media is not None else '无'} "
                    f"参考输入={'有' if image_reference_media is not None else '无'}",
                    flush=True,
                )
                grid_result = self._storyboard_grid.generate(
                    prompt=selected_prompt,
                    negative_prompt=negative_prompt,
                    main_image_index=1,
                    width=width,
                    height=height,
                    batch_size=1,
                    unet_name=keyframe_unet,
                    unet_dtype="default",
                    clip_name1=keyframe_clip,
                    vae_name=keyframe_vae,
                    seed=seed,
                    steps=keyframe_steps,
                    cfg=keyframe_cfg,
                    sampler_name="euler",
                    scheduler="simple",
                    denoise=1.0,
                    grow_mask_by=6,
                    layout_mode="自动",
                    gap=0,
                    cell_fit="铺满裁切",
                    resize_method="lanczos",
                    size_alignment="关闭",
                    scene=scene_media,
                    reference=image_reference_media,
                    lora_chain_config=keyframe_lora_chain_config,
                    lora_data=keyframe_lora_data,
                    single_cell_index=0,
                    single_cell_total=geometry_count,
                    selected_cell_indices=json.dumps(image_indices),
                    storyboard_full_prompt=full_keyframe_prompt,
                    force_generate_all="false",
                    storyboard_preview_images=first("storyboard_preview_images", "[]"),
                    storyboard_lora_name="",
                    keep_model_loaded=keep_model or model_strategy == "同时加载",
                    unique_id=unique_id,
                    prompt_graph=first("prompt_info"),
                    extra_pnginfo=first("extra_pnginfo"),
                    storyboard_plan_cells=_storyboard_plan_cells(shots),
                )
                keyframe_batch = grid_result[1] if isinstance(grid_result, tuple) and len(grid_result) > 1 else None
                if not isinstance(keyframe_batch, torch.Tensor) or keyframe_batch.ndim != 4:
                    raise RuntimeError("GJJ_StoryboardGridGenerator 没有返回有效分镜图片批次。")
                print(
                    f"[GJJ StoryboardVideoGrid][图片整批] 返回={int(keyframe_batch.shape[0])} "
                    f"shape={tuple(keyframe_batch.shape)}",
                    flush=True,
                )
                if int(keyframe_batch.shape[0]) != len(image_indices):
                    raise RuntimeError(
                        f"分镜图片数量不匹配：请求 {len(image_indices)} 张，实际返回 {int(keyframe_batch.shape[0])} 张。"
                    )
                for batch_index, idx in enumerate(image_indices):
                    keyframe_tensor = keyframe_batch[batch_index:batch_index + 1].detach().float().clamp(0.0, 1.0).contiguous()
                    cache["cells"].setdefault(idx, {})["keyframe"] = keyframe_tensor.cpu().contiguous()
                    cache["signatures"][idx] = cell_signatures.get(idx, "")
                _send_status(unique_id, f"阶段1：已生成全部起始帧 {len(image_indices)}/{total_gen}", 0.4)

                # 以下旧逐格实现保留为暂时的源码对照，但不再进入执行路径。
                for i, idx in enumerate([]):
                    shot = next((s for s in shots if s.index == idx), None)
                    if not shot:
                        continue
                    cell_id = shot_cell_ids.get(idx, idx - 1)
                    _send_status(unique_id, f"阶段1：生成起始帧 {i + 1}/{total_gen}（分镜 {idx}）", (i / total_gen) * 0.4)
                    _send_cell_preview(unique_id, cell_id, idx, geometry_count, "keyframe", "generating")
                    try:
                        # 图片阶段不再复制/近似分镜宫格逻辑，直接调用
                        # GJJ_StoryboardGridGenerator 的唯一实现。单格、参考图排序、
                        # 角色/场景/服装绑定、Qwen2511 条件、裁边、缓存和实时预览
                        # 均由该节点原样负责。
                        selected_prompt = f"[{idx}] {shot.keyframe_prompt}"
                        full_keyframe_prompt = "\n".join(
                            f"[{item.index}] {item.keyframe_prompt}" for item in shots
                        )
                        grid_result = self._storyboard_grid.generate(
                            prompt=selected_prompt,
                            negative_prompt=negative_prompt,
                            main_image_index=1,
                            width=width,
                            height=height,
                            batch_size=1,
                            unet_name=keyframe_unet,
                            unet_dtype="default",
                            clip_name1=keyframe_clip,
                            vae_name=keyframe_vae,
                            seed=seed,
                            steps=keyframe_steps,
                            cfg=keyframe_cfg,
                            sampler_name="euler",
                            scheduler="simple",
                            denoise=1.0,
                            grow_mask_by=6,
                            layout_mode="自动",
                            gap=0,
                            cell_fit="铺满裁切",
                            resize_method="lanczos",
                            size_alignment="关闭",
                            scene=scene_media,
                            reference=image_reference_media,
                            lora_chain_config=keyframe_lora_chain_config,
                            lora_data=keyframe_lora_data,
                            single_cell_index=0,
                            single_cell_total=geometry_count,
                            selected_cell_indices=json.dumps([idx]),
                            storyboard_full_prompt=full_keyframe_prompt,
                            force_generate_all="false",
                            storyboard_preview_images=first("storyboard_preview_images", "[]"),
                            storyboard_lora_name="",
                            keep_model_loaded=keep_model or model_strategy == "同时加载",
                            unique_id=unique_id,
                            prompt_graph=first("prompt_info"),
                            extra_pnginfo=first("extra_pnginfo"),
                        )
                        keyframe_batch = grid_result[1] if isinstance(grid_result, tuple) and len(grid_result) > 1 else None
                        if not isinstance(keyframe_batch, torch.Tensor) or keyframe_batch.ndim != 4 or keyframe_batch.shape[0] < 1:
                            raise RuntimeError(f"分镜 {idx} 未从 GJJ_StoryboardGridGenerator 返回有效图片")
                        keyframe_tensor = keyframe_batch[:1].detach().float().clamp(0.0, 1.0).contiguous()
                        if idx not in cache["cells"]:
                            cache["cells"][idx] = {}
                        cache["cells"][idx]["keyframe"] = keyframe_tensor.cpu().contiguous()
                        continue

                        # Reuse StoryboardGridGenerator's scene/character/costume
                        # resolution and image-slot binding pipeline.
                        is_image_edit_unet = _is_next_scene_image_edit_unet(keyframe_unet)
                        is_flux_storyboard = _is_flux_storyboard_unet(keyframe_unet)
                        line = _safe_text(shot.keyframe_prompt)
                        line, library_scene_reference, scene_consumed_characters = _scene_reference_tensor_for_prompt(
                            line, width, height,
                            compose_character_references=is_image_edit_unet or is_flux_storyboard,
                            include_identity_reference_board=is_image_edit_unet,
                            use_direct_character_references=is_image_edit_unet,
                        )
                        external_reference = reference_media
                        library_scene_count = _media_count(library_scene_reference)
                        character_refs_for_limits = _resolved_character_refs(
                            line, storyboard_character_refs,
                            allow_storyboard_context=not is_image_edit_unet,
                        )
                        reference_limit = MULTI_REFERENCE_IMAGE_LIMIT - library_scene_count - len(character_refs_for_limits)
                        if is_image_edit_unet:
                            external_reference = _media_slice(external_reference, max(0, reference_limit))
                        external_reference_count = _media_count(external_reference)
                        if external_reference_count:
                            line = _append_plain_reference_prompt(
                                line, library_scene_count + 1, external_reference_count, library_scene_count > 0
                            )
                        character_start = library_scene_count + external_reference_count + 1
                        character_limit = None if not is_image_edit_unet else max(
                            0, MULTI_REFERENCE_IMAGE_LIMIT - library_scene_count - external_reference_count
                        )
                        line, character_reference = _character_prompt_and_reference(
                            line, storyboard_character_refs,
                            contain_reference_images=is_image_edit_unet,
                            first_reference_image_index=character_start,
                            include_reference_images=not scene_consumed_characters,
                            qwen_reference_binding=is_image_edit_unet,
                            max_reference_images=character_limit,
                            allow_storyboard_context=not is_image_edit_unet,
                            reference_width=width,
                            reference_height=height,
                        )
                        character_count = _media_count(character_reference)
                        remaining_slots = MULTI_REFERENCE_IMAGE_LIMIT - library_scene_count - external_reference_count - character_count
                        costume_reference = None
                        if not is_image_edit_unet or remaining_slots > 0:
                            line, costume_reference = _costume_prompt_and_reference(
                                line,
                                contain_reference_images=is_image_edit_unet,
                                first_reference_image_index=character_start + character_count,
                            )
                            if is_image_edit_unet:
                                costume_reference = _media_slice(costume_reference, remaining_slots)
                        line = _prefix_next_scene_prompt(line, keyframe_unet)
                        line = f"{line}\n\n{CELL_BLEED_PROMPT}"
                        reference_parts = [
                            item for item in (library_scene_reference, external_reference, character_reference, costume_reference)
                            if item is not None
                        ]
                        refs = _lazy_optional_images(
                            None, reference_parts if reference_parts else None, width, height,
                            fit_reference=is_image_edit_unet,
                        )
                        if is_image_edit_unet:
                            _write_debug_reference_images(unique_id, idx, refs)
                            _write_debug_final_prompt(unique_id, idx, line, negative_prompt)
                        ref_count_in_batch = _media_count(refs.get("image_01"))
                        print(f"[GJJ StoryboardVideoGrid] 分镜 {idx} 最终 prompt（参考图 {ref_count_in_batch} 张）:\n{line}")
                        print(
                            f"[GJJ StoryboardVideoGrid] 分镜 {idx} create_image 关键参数: "
                            f"unet={keyframe_unet}, clip={keyframe_clip}, vae={keyframe_vae}, "
                            f"force_empty_latent={is_image_edit_unet}, main_index=1, "
                            f"steps={keyframe_steps}, cfg={keyframe_cfg}, lora={keyframe_lora_data[:120]}"
                        )
                        create_kwargs: dict[str, Any] = dict(
                            prompt=line,
                            negative_prompt=negative_prompt,
                            main_image_index=1,
                            width=width,
                            height=height,
                            batch_size=1,
                            unet_name=keyframe_unet,
                            unet_dtype="default",
                            clip_name1=keyframe_clip,
                            vae_name=keyframe_vae,
                            seed=seed + idx - 1,
                            steps=keyframe_steps,
                            cfg=keyframe_cfg,
                            sampler_name="euler",
                            scheduler="simple",
                            denoise=1.0,
                            grow_mask_by=6,
                            lora_chain_config="",
                            lora_data=keyframe_lora_data,
                            batch_source_images="[]",
                            disable_reference_auto_mask=True,
                            force_empty_latent_reference=is_image_edit_unet,
                            keep_model_loaded=keep_model or model_strategy == "同时加载",
                            prompt_graph=first("prompt_info"),
                            unique_id=unique_id,
                            extra_pnginfo=first("extra_pnginfo"),
                        )
                        # 传递参考图（image_01）给 create_image —— 复用 GJJ_StoryboardGridGenerator 流程
                        if refs:
                            create_kwargs.update(refs)
                        result = self._lazy.create_image(**create_kwargs)
                        keyframe_tensor = result.get("result", (None,))[0] if isinstance(result, dict) else None
                        if not isinstance(keyframe_tensor, torch.Tensor):
                            raise RuntimeError(f"分镜 {idx} 起始帧生成失败")
                        keyframe_tensor = _normalize_storyboard_cell(
                            keyframe_tensor, width, height
                        ).detach().float().clamp(0.0, 1.0).contiguous()
                        # 缓存起始帧
                        if idx not in cache["cells"]:
                            cache["cells"][idx] = {}
                        cache["cells"][idx]["keyframe"] = keyframe_tensor.detach().cpu().contiguous()
                        # 与 GJJ_StoryboardGridGenerator 使用同一个持久化预览事件、
                        # 原图/缩略图结构和缓存签名，避免节点底部原生预览与宫格错位。
                        _send_live_preview(
                            unique_id,
                            keyframe_tensor,
                            idx,
                            geometry_count,
                            shot.keyframe_prompt,
                            cell_signatures.get(idx, ""),
                        )
                    except Exception as exc:
                        _send_cell_preview(unique_id, cell_id, idx, geometry_count, "keyframe", "error")
                        raise RuntimeError(f"分镜 {idx} 起始帧生成失败：{exc}") from exc

                # 两阶段串行：卸载 qwen2511
                if model_strategy == "两阶段串行" and not keep_model:
                    _send_status(unique_id, "阶段1完成，卸载图片模型...", 0.4)
                    _unload_all_models()

            # === 阶段 2：minimax-h3 生成视频 ===
            if not skip_video:
                _send_status(unique_id, f"阶段2：生成视频 0/{total_gen}", 0.4 if not skip_keyframe else 0.0)
                for i, idx in enumerate(to_generate):
                    shot = next((s for s in shots if s.index == idx), None)
                    if not shot:
                        continue
                    cell_id = shot_cell_ids.get(idx, idx - 1)
                    base_progress = 0.4 if not skip_keyframe else 0.0
                    _send_status(unique_id, f"阶段2：生成视频 {i + 1}/{total_gen}（分镜 {idx}，{shot.total_duration}s）", base_progress + (i / total_gen) * 0.5)
                    _send_cell_preview(unique_id, cell_id, idx, geometry_count, "video", "generating", duration=shot.total_duration)
                    try:
                        # 组装 H3 提示词
                        h3_prompt = _build_h3_video_prompt(
                            shot.video_prompt, shot.sub_shots, shot.total_duration,
                            dialogue_language, visual_style, camera_motion,
                        )
                        # 获取起始帧
                        keyframe_tensor = None
                        cached_cell_data = cache["cells"].get(idx, {})
                        if isinstance(cached_cell_data, dict):
                            cached_kf = cached_cell_data.get("keyframe")
                            # 避免 Tensor 布尔歧义：用 is not None + numel() 判断
                            if cached_kf is not None:
                                if isinstance(cached_kf, torch.Tensor):
                                    if int(cached_kf.numel()) > 0:
                                        keyframe_tensor = cached_kf
                                else:
                                    keyframe_tensor = cached_kf
                        # 调用 minimax-h3 生成视频
                        video_kwargs = {
                            "prompt": h3_prompt,
                            "width": width,
                            "height": height,
                            "duration": shot.total_duration,
                            "frame_rate": frame_rate,
                            "steps": video_steps,
                            "seed": seed + idx - 1,
                            "randomize_seed": False,
                            "sampler_name": video_sampler,
                            "scheduler": video_scheduler,
                            "denoise": 1.0,
                            "fl_model": video_unet,
                            "clip_name": video_clip,
                            "video_vae_name": video_vae,
                            "audio_vae_name": video_audio_vae,
                            "keep_model": keep_model,
                            "filename_prefix": f"{filename_prefix}_shot_{idx:03d}",
                            "format_name": format_name,
                            "lora_data": lora_data,
                            "negative_prompt": negative_prompt,
                            "dialogue_language": dialogue_language,
                            "image_branch": "首帧" if keyframe_tensor is not None else "参考",
                            "first_frame_lock": keyframe_tensor is not None,
                            "reasoning_enabled": False,
                            "spectrum_enabled": True,
                            "cache_clip": False,
                            "unique_id": unique_id,
                            "prompt_info": first("prompt_info"),
                            "extra_pnginfo": first("extra_pnginfo"),
                        }
                        if keyframe_tensor is not None:
                            # 验证 keyframe_tensor 格式
                            if not isinstance(keyframe_tensor, torch.Tensor):
                                keyframe_tensor = None
                                print(f"[GJJ StoryboardVideoGrid] 分镜 {idx} keyframe_tensor 不是 Tensor，跳过首帧")
                            elif keyframe_tensor.ndim != 4 or int(keyframe_tensor.shape[-1]) != 3:
                                keyframe_tensor = None
                                print(f"[GJJ StoryboardVideoGrid] 分镜 {idx} keyframe_tensor shape={tuple(keyframe_tensor.shape)} 不符合 [B,H,W,3]，跳过首帧")
                            else:
                                # 确保在正确设备上
                                keyframe_tensor = keyframe_tensor.detach().cpu().float().contiguous()
                                video_kwargs["reference_media"] = keyframe_tensor
                        result = self._h3.generate(**video_kwargs)
                        video_output = result.get("result", (None, None))[0] if isinstance(result, dict) else None
                        if video_output is None:
                            raise RuntimeError(f"分镜 {idx} 视频生成失败")
                        # 缓存视频
                        if idx not in cache["cells"]:
                            cache["cells"][idx] = {}
                        cache["cells"][idx]["video"] = video_output
                        cache["cells"][idx]["duration"] = shot.total_duration
                        # 推送视频预览
                        video_item = _video_preview_item(result, video_output)
                        video_url = str(video_item.get("url", "") or "")
                        _send_cell_preview(
                            unique_id, cell_id, idx, geometry_count, "video", "done",
                            video_url=video_url, duration=shot.total_duration,
                            item=video_item,
                        )
                    except Exception as exc:
                        _send_cell_preview(unique_id, cell_id, idx, geometry_count, "video", "error")
                        raise RuntimeError(f"分镜 {idx} 视频生成失败：{exc}") from exc

            # 卸载模型
            if not keep_model:
                _send_status(unique_id, "生成完成，卸载模型...", 0.95)
                _unload_all_models()

        # === 收集所有格子的结果 ===
        _send_status(unique_id, "正在收集结果...", 0.95)
        all_videos: list[Any] = []
        all_keyframes: list[torch.Tensor] = []
        for shot in shots:
            cell = cache.get("cells", {}).get(shot.index, {})
            video = cell.get("video")
            keyframe = cell.get("keyframe")
            if video is not None:
                all_videos.append(video)
            if keyframe is not None and isinstance(keyframe, torch.Tensor):
                all_keyframes.append(keyframe)

        # 拼接首帧宫格
        grid_image = None
        if all_keyframes:
            try:
                grid_image = self._build_grid(all_keyframes, width, height)
            except Exception:
                grid_image = all_keyframes[0] if all_keyframes else torch.zeros(1, height, width, 3)

        # === 输出 ===
        _send_status(unique_id, "正在输出...", 0.98)
        if len(all_videos) > 1:
            # VIDEO 输出口始终只返回一个官方 VIDEO，避免下游将对象列表
            # 当作普通数据序列保存为 JSON。
            try:
                combined = self._combine_videos(
                    all_videos, frame_rate, f"{filename_prefix}_完整视频", format_name, unique_id
                )
                video_output = combined
            except Exception as exc:
                raise RuntimeError(f"视频合并失败：{exc}") from exc
        elif all_videos:
            video_output = all_videos[0]
        else:
            video_output = None

        # 首帧列表
        keyframe_list = torch.cat(all_keyframes, dim=0) if all_keyframes else torch.zeros(1, height, width, 3)

        _send_status(unique_id, f"完成：{len(all_videos)} 个分镜", 1.0)

        ui = {
            "output_mode": [output_mode],
            "shot_count": [len(shots)],
            "total_duration": [sum(s.total_duration for s in shots)],
        }
        return {"ui": ui, "result": (video_output,)}

    def _build_grid(self, images: list[torch.Tensor], width: int, height: int) -> torch.Tensor:
        """拼接首帧宫格图"""
        if not images:
            return torch.zeros(1, height, width, 3)
        count = len(images)
        cols = int(math.ceil(math.sqrt(count)))
        rows = int(math.ceil(count / cols))
        cell_w = _align_down(width, 8)
        cell_h = _align_down(height, 8)
        grid_w = cell_w * cols
        grid_h = cell_h * rows
        grid = torch.zeros(1, grid_h, grid_w, 3, dtype=torch.float32)
        for i, img in enumerate(images):
            if i >= rows * cols:
                break
            row = i // cols
            col = i % cols
            # 调整尺寸
            if img.shape[0] > 0:
                frame = img[0].unsqueeze(0)
            else:
                frame = img
            fitted = _fit_cell(frame, cell_w, cell_h, "智能", 0.0, "lanczos")
            grid[0, row * cell_h:(row + 1) * cell_h, col * cell_w:(col + 1) * cell_w, :] = fitted[0]
        return grid

    def _combine_videos(
        self, videos: list[Any], frame_rate: float, filename_prefix: str,
        format_name: str, unique_id: Any,
    ) -> Any:
        """合并多个视频为一个"""
        if not videos:
            return None
        if len(videos) == 1:
            return videos[0]
        # GJJ_VideoCombine 原生支持官方 VIDEO 序列，并会顺序拼接画面与音频。
        # 不要在这里猜测 frames/images 字段；官方 VIDEO 通常通过
        # get_components() 暴露内容，旧逻辑因此会误判为空并退回第一段。
        result = GJJ_VideoCombine().combine(
            images=videos,
            frame_rate=frame_rate,
            loop_count=0,
            filename_prefix=filename_prefix,
            format_name=format_name,
            pingpong=False,
            save_output=True,
            use_source_fps=False,
            # 父节点负责展示“宫格队列/子分镜”层级；禁止内部合并器
            # 用自己的 1/5 状态覆盖外层真实进度。
            unique_id=None,
        )
        self._last_combined_result = result
        if isinstance(result, dict):
            result_values = result.get("result")
            combined = result_values[0] if isinstance(result_values, (list, tuple)) and result_values else None
            if combined is None:
                raise RuntimeError("GJJ_VideoCombine 未返回合并后的 VIDEO。")
            return combined
        if result is None:
            raise RuntimeError("GJJ_VideoCombine 未返回合并结果。")
        return result


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_StoryboardVideoGrid}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🎬 分镜宫格视频生成(MiniMax-H3)"}

# 注册 LoRA 列表 API（供前端动态加载）
if PromptServer is not None:
    try:
        import aiohttp.web
        from aiohttp import web

        async def _get_lora_list(request):
            """返回所有 LoRA 模型列表"""
            try:
                loras = [""] + list(folder_paths.get_filename_list("loras"))
                return web.json_response({"loras": loras})
            except Exception:
                return web.json_response({"loras": []})

        async def _get_live_video_batch(request):
            node_id = _safe_text(request.query.get("node", "")).strip()
            batch = GJJ_StoryboardVideoGrid._shared_live_video_batches.get(node_id)
            if not isinstance(batch, dict):
                return web.json_response({"run_token": "", "total": 0, "records": []})
            return web.json_response({
                "run_token": str(batch.get("run_token", "") or ""),
                "total": int(batch.get("total", 0) or 0),
                "records": list(batch.get("records", []) or []),
            })

        # Register the live route first and independently.  /gjj/loras may
        # already be owned by another GJJ module; a duplicate-route exception
        # must never prevent this node's result API from being installed.
        if not hasattr(PromptServer.instance, "_gjj_storyboard_live_video_api_registered"):
            PromptServer.instance.routes.get("/gjj/storyboard-video-grid/live")(_get_live_video_batch)
            PromptServer.instance._gjj_storyboard_live_video_api_registered = True
        if not hasattr(PromptServer.instance, "_gjj_storyboard_lora_api_registered"):
            try:
                PromptServer.instance.routes.get("/gjj/loras")(_get_lora_list)
            except Exception:
                pass
            PromptServer.instance._gjj_storyboard_lora_api_registered = True
    except Exception as exc:
        print(f"[GJJ StoryboardVideoGrid] 实时接口注册失败: {exc}", flush=True)
