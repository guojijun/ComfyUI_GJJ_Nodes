from __future__ import annotations

import json
import logging
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F
import folder_paths
from PIL import Image

from .gjj_sam3_scail2_track_mask_aio import (
    DEFAULT_CHECKPOINT,
    MEDIA_INPUT,
    _checkpoint_list,
    _encode_text,
    _load_checkpoint,
    _normalize_track_frame_count,
    _pick_default_checkpoint,
    _prepare_track_data,
    _track_route,
    _translate_prompts,
    _unpack_sam3_masks,
)
from .common_utils.dependency_checker import build_node_help_payload, make_missing_model_spec
from .gjj_video_combine_runtime import DEFAULT_FRAME_RATE


log = logging.getLogger(__name__)

NODE_NAME = "GJJ_SAM3FaceCropVideoAIO"
DISPLAY_NAME = "GJJ · 🎯🙂 SAM3多人脸裁剪视频"
MAX_FACE_OUTPUTS = 8
TIMELINE_TIME_RE = re.compile(
    r"(?P<h>\d{1,2}):(?P<m>\d{2}):(?P<s>\d{2})(?P<ms>[,.]\d{1,3})?"
    r"|(?P<m2>\d{1,3}):(?P<s2>\d{2})(?P<ms2>[,.]\d{1,3})?"
)
SPEAKER_PREFIX_RE = re.compile(
    r"^\s*(?:\[(?P<bracket>[^\]\n\r]{1,40})\]\s*|\[?(?P<speaker>[^:\]\n\r：]{1,40})\]?\s*[:：]|(?P<speaker2>说话人\s*\d+|speaker\s*\d+)\s+)",
    re.IGNORECASE,
)
AUTO_MODEL_CHOICE = "自动"
MODEL_QUANT_RE = re.compile(
    r"(?i)(?:^|[_\-.\\/\s])("
    r"fp8(?:[_\-.]?e4m3fn)?|fp8[_\-.]?scaled|fp16|bf16|fp32|int8|int4|"
    r"q[234568][_\-.]?[km]?|q\d+[_\-.]?\w*|e4m3fn|scaled|safetensors|ckpt|pt|pth"
    r")(?:$|[_\-.\\/\s])"
)

BERNINI_AIO_HIGH_MODEL = "wan2.2_bernini_r_high_noise_int8_convrot_s2v.safetensors"
BERNINI_AIO_LOW_MODEL = "wan2.2_bernini_r_low_noise_int8_convrot_s2v.safetensors"
BERNINI_AIO_VAE = "wan_2.1_vae.safetensors"
BERNINI_AIO_CLIP = "umt5_xxl_int4_convrot.safetensors"
BERNINI_AIO_AUDIO_ENCODER = "wav2vec2_large_english_fp16.safetensors"
BERNINI_AIO_HIGH_LORA = "Bernini/Bernini-R_LightX2V_high_noise.safetensors"
BERNINI_AIO_LOW_LORA = "Bernini/Bernini-R_LightX2V_low_noise.safetensors"

BERNINI_AIO_MODEL_TREE = [
    {
        "label": "SAM3.1 Multiplex checkpoint",
        "path": "models/checkpoints",
        "folder": "checkpoints",
        "filename": DEFAULT_CHECKPOINT,
        "value": DEFAULT_CHECKPOINT,
        "kind": "checkpoint_model",
        "required": True,
        "description": "SAM3.1 Multiplex 人脸/目标跟踪 checkpoint；Bernini AIO 默认跟踪 head 并生成分段裁剪位置。",
    },
    {
        "label": "Bernini High diffusion model",
        "path": "models/diffusion_models",
        "folder": "diffusion_models",
        "filename": BERNINI_AIO_HIGH_MODEL,
        "value": BERNINI_AIO_HIGH_MODEL,
        "kind": "diffusion",
        "required": True,
        "description": "Bernini S2V 高噪阶段模型；下拉按 bernini + s2v + high 关键词过滤。",
    },
    {
        "label": "Bernini Low diffusion model",
        "path": "models/diffusion_models",
        "folder": "diffusion_models",
        "filename": BERNINI_AIO_LOW_MODEL,
        "value": BERNINI_AIO_LOW_MODEL,
        "kind": "diffusion",
        "required": True,
        "description": "Bernini S2V 低噪阶段模型；下拉按 bernini + s2v + low 关键词过滤。",
    },
    {
        "label": "Wan VAE",
        "path": "models/vae",
        "folder": "vae",
        "filename": BERNINI_AIO_VAE,
        "value": BERNINI_AIO_VAE,
        "kind": "vae",
        "required": True,
        "description": "Bernini/Wan 视频 VAE；下拉按 wan + 2.1 + vae 关键词过滤。",
    },
    {
        "label": "UMT5 XXL text encoder",
        "path": "models/text_encoders",
        "folder": "text_encoders",
        "filename": BERNINI_AIO_CLIP,
        "value": BERNINI_AIO_CLIP,
        "kind": "clip",
        "required": True,
        "description": "Bernini/Wan 文本编码器；下拉按 umt5 + xxl 关键词过滤。",
    },
    {
        "label": "Wav2Vec2 audio encoder",
        "path": "models/audio_encoders",
        "folder": "audio_encoders",
        "filename": BERNINI_AIO_AUDIO_ENCODER,
        "value": BERNINI_AIO_AUDIO_ENCODER,
        "kind": "audio_encoder",
        "required": True,
        "description": "Bernini S2V 音频编码器；下拉按 wav2vec2 关键词过滤。",
    },
    {
        "label": "Bernini High LightX2V LoRA",
        "path": "models/loras/Bernini",
        "folder": "loras",
        "filename": BERNINI_AIO_HIGH_LORA,
        "value": BERNINI_AIO_HIGH_LORA,
        "kind": "loras",
        "required": True,
        "description": "High 阶段 LightX2V 加速 LoRA；下拉按 bernini + lightx2v + high 关键词过滤。",
    },
    {
        "label": "Bernini Low LightX2V LoRA",
        "path": "models/loras/Bernini",
        "folder": "loras",
        "filename": BERNINI_AIO_LOW_LORA,
        "value": BERNINI_AIO_LOW_LORA,
        "kind": "loras",
        "required": True,
        "description": "Low 阶段 LightX2V 加速 LoRA；下拉按 bernini + lightx2v + low 关键词过滤。",
    },
]


def _aio_model_spec(item: dict[str, Any]) -> dict[str, Any]:
    spec = make_missing_model_spec(
        label=item["label"],
        subdir=item["path"],
        filename=item["filename"],
        description=item["description"],
    )
    spec["folder"] = item.get("folder", "")
    spec["value"] = item.get("value") or item.get("filename", "")
    spec["kind"] = item.get("kind", "")
    spec["required"] = bool(item.get("required", True))
    return spec


BERNINI_AIO_REQUIRED_MODELS = [_aio_model_spec(item) for item in BERNINI_AIO_MODEL_TREE]


def _model_filter_key(value: str) -> str:
    text = str(value or "").replace("\\", "/")
    text = "/".join(Path(part).stem for part in text.split("/") if part)
    previous = None
    while previous != text:
        previous = text
        text = MODEL_QUANT_RE.sub("_", text)
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _filtered_model_choices(folder: str, keywords: list[str], preferred: str = "") -> tuple[list[str], str]:
    try:
        names = [str(item) for item in folder_paths.get_filename_list(folder) or []]
    except Exception:
        names = []
    keys = [_model_filter_key(item) for item in keywords if str(item or "").strip()]
    filtered = [name for name in names if all(key in _model_filter_key(name) for key in keys)]
    if preferred:
        preferred_matches = [name for name in names if Path(name).name.lower() == Path(preferred).name.lower()]
        for item in reversed(preferred_matches):
            if item in filtered:
                filtered.remove(item)
            filtered.insert(0, item)
    choices = [AUTO_MODEL_CHOICE, *filtered]
    default = filtered[0] if filtered else AUTO_MODEL_CHOICE
    return choices, default


def _model_choice_value(value: Any) -> str:
    text = str(value or "").strip()
    return "" if not text or text == AUTO_MODEL_CHOICE else text


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _extract_images(value: Any) -> torch.Tensor | None:
    if value is None:
        return None
    if isinstance(value, torch.Tensor):
        if value.ndim == 3:
            value = value.unsqueeze(0)
        if value.ndim == 4:
            if value.shape[-1] not in (1, 3, 4) and value.shape[1] in (1, 3, 4):
                value = value.permute(0, 2, 3, 1)
            channels = int(value.shape[-1])
            if channels == 1:
                value = value.repeat(1, 1, 1, 3)
            elif channels >= 4:
                value = value[..., :3]
            return value.detach().float().clamp(0.0, 1.0).contiguous()
    if isinstance(value, dict):
        for key in ("images", "image", "frames", "samples"):
            images = _extract_images(value.get(key))
            if images is not None:
                return images
    if hasattr(value, "get_components"):
        components = value.get_components()
        return _extract_images(_component_value(components, "images"))
    if hasattr(value, "images"):
        return _extract_images(getattr(value, "images"))
    return None


def _extract_fps(value: Any, fallback: float = DEFAULT_FRAME_RATE) -> float:
    if value is None:
        return float(fallback)
    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception:
            components = None
        if components is not None:
            for key in ("frame_rate", "fps", "frameRate"):
                fps = _component_value(components, key)
                if fps is not None:
                    try:
                        return max(0.01, float(fps))
                    except Exception:
                        pass
    if isinstance(value, dict):
        for key in ("frame_rate", "fps", "frameRate", "source_fps", "source_video_fps"):
            fps = value.get(key)
            if fps is not None:
                try:
                    return max(0.01, float(fps))
                except Exception:
                    pass
    return float(fallback)


def _audio_duration_seconds(audio: Any) -> float:
    if not isinstance(audio, dict):
        return 0.0
    waveform = audio.get("waveform")
    if not isinstance(waveform, torch.Tensor) or waveform.ndim <= 0:
        return 0.0
    try:
        sample_rate = max(1.0, float(audio.get("sample_rate") or 44100.0))
    except Exception:
        sample_rate = 44100.0
    return max(0.0, float(waveform.shape[-1]) / sample_rate)


def _extend_frames_pingpong(frames: torch.Tensor, target_count: int) -> torch.Tensor:
    current_count = int(frames.shape[0])
    target = max(current_count, int(target_count))
    if target <= current_count:
        return frames
    if current_count <= 1:
        return frames[:1].repeat(target, 1, 1, 1).contiguous()

    if current_count == 2:
        cycle = [0, 1]
    else:
        cycle = [*range(current_count), *range(current_count - 2, 0, -1)]
    repeats = (target + len(cycle) - 1) // len(cycle)
    indices = (cycle * repeats)[:target]
    index_tensor = torch.tensor(indices, device=frames.device, dtype=torch.long)
    return frames.index_select(0, index_tensor).contiguous()


def _empty_frames(size: int = 64) -> torch.Tensor:
    return torch.zeros((1, int(size), int(size), 3), dtype=torch.float32)


def _empty_frames_for_size(size: int | tuple[int, int] = 64) -> torch.Tensor:
    if isinstance(size, (tuple, list)) and len(size) >= 2:
        width = max(1, int(size[0]))
        height = max(1, int(size[1]))
        return torch.zeros((1, height, width, 3), dtype=torch.float32)
    return _empty_frames(int(size))


def _safe_float(value: Any, default: float, min_value: float | None = None, max_value: float | None = None) -> float:
    try:
        result = float(value)
    except Exception:
        result = float(default)
    if min_value is not None:
        result = max(float(min_value), result)
    if max_value is not None:
        result = min(float(max_value), result)
    return result


def _safe_int(value: Any, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
    try:
        result = int(float(value))
    except Exception:
        result = int(default)
    if min_value is not None:
        result = max(int(min_value), result)
    if max_value is not None:
        result = min(int(max_value), result)
    return result


def _bbox_from_mask(mask: torch.Tensor) -> tuple[int, int, int, int] | None:
    coords = torch.nonzero(mask, as_tuple=False)
    if int(coords.shape[0]) <= 0:
        return None
    y1 = int(coords[:, 0].min().item())
    x1 = int(coords[:, 1].min().item())
    y2 = int(coords[:, 0].max().item()) + 1
    x2 = int(coords[:, 1].max().item()) + 1
    return x1, y1, x2, y2


def _expand_box(
    box: tuple[int, int, int, int],
    width: int,
    height: int,
    padding_percent: float,
    square_crop: bool,
) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = box
    bw = max(1.0, float(x2 - x1))
    bh = max(1.0, float(y2 - y1))
    pad = max(0.0, float(padding_percent)) * 0.01
    cx = (x1 + x2) * 0.5
    cy = (y1 + y2) * 0.5
    target_w = bw * (1.0 + pad * 2.0)
    target_h = bh * (1.0 + pad * 2.0)
    if square_crop:
        side = max(target_w, target_h)
        target_w = target_h = side
    nx1 = int(round(cx - target_w * 0.5))
    ny1 = int(round(cy - target_h * 0.5))
    nx2 = int(round(cx + target_w * 0.5))
    ny2 = int(round(cy + target_h * 0.5))
    nx1 = max(0, min(int(width) - 1, nx1))
    ny1 = max(0, min(int(height) - 1, ny1))
    nx2 = max(nx1 + 1, min(int(width), nx2))
    ny2 = max(ny1 + 1, min(int(height), ny2))
    return nx1, ny1, nx2, ny2


def _smooth_boxes(
    boxes: list[tuple[int, int, int, int] | None],
    width: int,
    height: int,
    smoothing: float,
) -> list[tuple[int, int, int, int]]:
    valid = [index for index, box in enumerate(boxes) if box is not None]
    if not valid:
        return [(0, 0, int(width), int(height)) for _ in boxes]

    filled: list[tuple[float, float, float, float]] = []
    first = boxes[valid[0]]
    assert first is not None
    last = tuple(float(v) for v in first)
    for index, box in enumerate(boxes):
        if box is None:
            nearest = min(valid, key=lambda item: abs(item - index))
            source = boxes[nearest]
            assert source is not None
            current = tuple(float(v) for v in source)
        else:
            current = tuple(float(v) for v in box)
        alpha = max(0.0, min(0.95, float(smoothing)))
        last = tuple(last[i] * alpha + current[i] * (1.0 - alpha) for i in range(4))
        filled.append(last)

    result = []
    for x1, y1, x2, y2 in filled:
        ix1 = max(0, min(int(width) - 1, int(round(x1))))
        iy1 = max(0, min(int(height) - 1, int(round(y1))))
        ix2 = max(ix1 + 1, min(int(width), int(round(x2))))
        iy2 = max(iy1 + 1, min(int(height), int(round(y2))))
        result.append((ix1, iy1, ix2, iy2))
    return result


def _crop_face_frames(
    images: torch.Tensor,
    object_masks: torch.Tensor,
    output_size: int,
    padding_percent: float,
    square_crop: bool,
    smoothing: float,
) -> tuple[torch.Tensor, list[dict[str, int]]]:
    frame_count, height, width, _channels = images.shape
    raw_boxes = [
        _bbox_from_mask(object_masks[index])
        for index in range(int(frame_count))
    ]
    padded_boxes = [
        _expand_box(box, int(width), int(height), padding_percent, square_crop) if box is not None else None
        for box in raw_boxes
    ]
    boxes = _smooth_boxes(padded_boxes, int(width), int(height), smoothing)
    crops: list[torch.Tensor] = []
    box_records: list[dict[str, int]] = []
    target = max(16, int(output_size))

    for index, box in enumerate(boxes):
        x1, y1, x2, y2 = box
        crop = images[index : index + 1, y1:y2, x1:x2, :3].movedim(-1, 1)
        crop = F.interpolate(crop, size=(target, target), mode="bilinear", align_corners=False)
        crops.append(crop.movedim(1, -1).squeeze(0).contiguous())
        box_records.append(
            {
                "frame": int(index),
                "x": int(x1),
                "y": int(y1),
                "width": int(x2 - x1),
                "height": int(y2 - y1),
            }
        )

    return torch.stack(crops, dim=0).clamp(0.0, 1.0).contiguous(), box_records


def _horizontal_component_boxes(mask: torch.Tensor, desired_count: int) -> list[tuple[int, int, int, int]]:
    bbox = _bbox_from_mask(mask)
    if bbox is None:
        return []
    x1, y1, x2, y2 = bbox
    col_any = mask[:, x1:x2].any(dim=0).detach().cpu().tolist()
    segments: list[tuple[int, int]] = []
    start: int | None = None
    gap = 0
    max_gap = max(2, int((x2 - x1) * 0.015))
    for index, value in enumerate(col_any + [False]):
        if value:
            if start is None:
                start = index
            gap = 0
            continue
        if start is None:
            continue
        gap += 1
        if gap > max_gap or index == len(col_any):
            end = max(start + 1, index - gap + 1)
            segments.append((x1 + start, x1 + end))
            start = None
            gap = 0

    boxes: list[tuple[int, int, int, int]] = []
    min_area = max(8, int(mask.numel() * 0.0002))
    for sx1, sx2 in segments:
        part = mask[:, sx1:sx2]
        part_box = _bbox_from_mask(part)
        if part_box is None:
            continue
        px1, py1, px2, py2 = part_box
        box = (sx1 + px1, py1, sx1 + px2, py2)
        if (box[2] - box[0]) * (box[3] - box[1]) >= min_area:
            boxes.append(box)

    boxes.sort(key=lambda item: (item[0] + item[2]) * 0.5)
    desired = max(1, int(desired_count))
    if len(boxes) >= desired:
        return boxes[:desired]
    if desired <= 1:
        return boxes or [bbox]

    # If SAM3 merged adjacent faces into one blob, split the union box into left/right slices.
    split_boxes: list[tuple[int, int, int, int]] = []
    width = max(1, x2 - x1)
    for index in range(desired):
        sx1 = x1 + int(round(width * index / desired))
        sx2 = x1 + int(round(width * (index + 1) / desired))
        sx2 = max(sx1 + 1, sx2)
        part = mask[:, sx1:sx2]
        part_box = _bbox_from_mask(part)
        if part_box is None:
            split_boxes.append((sx1, y1, sx2, y2))
        else:
            px1, py1, px2, py2 = part_box
            split_boxes.append((sx1 + px1, py1, sx1 + px2, py2))
    return split_boxes


def _round_up_to_multiple(value: float, multiple: int) -> int:
    step = max(1, int(multiple))
    return max(step, int((int(round(float(value))) + step - 1) // step) * step)


def _auto_face_crop_size(
    masks: torch.Tensor,
    desired_count: int,
    width: int,
    height: int,
) -> int:
    union = masks.any(dim=1) if masks.ndim == 4 else masks
    sides: list[float] = []
    for frame_index in range(int(union.shape[0])):
        boxes = _partition_face_boxes(union[frame_index], int(width), int(height), desired_count)
        for box in boxes[: max(1, int(desired_count))]:
            x1, y1, x2, y2 = box
            side = max(1.0, float(max(int(x2) - int(x1), int(y2) - int(y1))))
            sides.append(side)
    limit = max(32, min(int(width), int(height)))
    if not sides:
        return max(32, min(64, limit))
    sides.sort()
    percentile_index = int(round((len(sides) - 1) * 0.90))
    max_side = max(16.0, float(sides[max(0, min(len(sides) - 1, percentile_index))]))
    rounded = _round_up_to_multiple(max_side, 32)
    if rounded > limit:
        rounded = max(32, (limit // 32) * 32)
    return max(32, int(rounded))


def _fit_aligned_dimension(value: float, limit: int, multiple: int = 32) -> int:
    safe_limit = max(1, int(limit))
    aligned = _round_up_to_multiple(max(1.0, float(value)), int(multiple))
    if aligned > safe_limit:
        aligned = max(1, (safe_limit // int(multiple)) * int(multiple))
        if aligned <= 0:
            aligned = safe_limit
    return max(1, min(safe_limit, int(aligned)))


def _auto_face_crop_dimensions(
    masks: torch.Tensor,
    face_index: int,
    desired_count: int,
    width: int,
    height: int,
) -> tuple[int, int]:
    union = masks.any(dim=1) if masks.ndim == 4 else masks
    widths: list[float] = []
    heights: list[float] = []
    for frame_index in range(int(union.shape[0])):
        boxes = _partition_face_boxes(union[frame_index], int(width), int(height), desired_count)
        if int(face_index) >= len(boxes):
            continue
        x1, y1, x2, y2 = boxes[int(face_index)]
        widths.append(max(1.0, float(int(x2) - int(x1))))
        heights.append(max(1.0, float(int(y2) - int(y1))))
    if not widths or not heights:
        fallback = _auto_face_crop_size(masks, desired_count, int(width), int(height))
        return int(fallback), int(fallback)
    widths.sort()
    heights.sort()
    percentile_index = int(round((len(widths) - 1) * 0.90))
    sample_index = max(0, min(len(widths) - 1, percentile_index))
    crop_w = _fit_aligned_dimension(widths[sample_index], int(width), 32)
    crop_h = _fit_aligned_dimension(heights[sample_index], int(height), 32)
    return int(crop_w), int(crop_h)


def _face_boxes_from_union_masks(
    masks: torch.Tensor,
    face_index: int,
    desired_count: int,
    width: int,
    height: int,
    square_crop: bool,
    smoothing: float,
    crop_size: int | tuple[int, int],
) -> list[dict[str, int]]:
    raw_boxes: list[tuple[int, int, int, int] | None] = []
    union = masks.any(dim=1) if masks.ndim == 4 else masks
    for frame_index in range(int(union.shape[0])):
        boxes = _partition_face_boxes(union[frame_index], int(width), int(height), desired_count)
        raw_boxes.append(boxes[int(face_index)] if int(face_index) < len(boxes) else None)

    records: list[dict[str, int]] = []
    valid_indices = [index for index, box in enumerate(raw_boxes) if box is not None]
    if isinstance(crop_size, (tuple, list)) and len(crop_size) >= 2:
        target_w = max(1, min(int(crop_size[0]), int(width)))
        target_h = max(1, min(int(crop_size[1]), int(height)))
    else:
        side = max(1, min(int(crop_size), int(width), int(height)))
        target_w = side
        target_h = side
    if square_crop:
        side = max(target_w, target_h)
        side = max(1, min(int(side), int(width), int(height)))
        target_w = side
        target_h = side
    for index, raw_box in enumerate(raw_boxes):
        if raw_box is None and valid_indices:
            nearest = min(valid_indices, key=lambda item: abs(item - index))
            raw_box = raw_boxes[nearest]
        if raw_box is None:
            raw_box = (0, 0, int(width), int(height))
        fx1, fy1, fx2, fy2 = raw_box
        center_x = (int(fx1) + int(fx2)) * 0.5
        center_y = (int(fy1) + int(fy2)) * 0.5
        x1 = max(0, min(int(width) - target_w, int(round(center_x - target_w * 0.5))))
        y1 = max(0, min(int(height) - target_h, int(round(center_y - target_h * 0.5))))
        x2 = x1 + target_w
        y2 = y1 + target_h
        records.append(
            {
                "frame": int(index),
                "x": int(x1),
                "y": int(y1),
                "width": int(x2 - x1),
                "height": int(y2 - y1),
                "face_x": int(fx1),
                "face_y": int(fy1),
                "face_width": int(fx2 - fx1),
                "face_height": int(fy2 - fy1),
            }
        )
    return records


def _partition_face_boxes(
    mask: torch.Tensor,
    width: int,
    height: int,
    desired_count: int,
) -> list[tuple[int, int, int, int]]:
    desired = max(1, int(desired_count))
    if desired <= 1:
        return _horizontal_component_boxes(mask, desired)

    boxes: list[tuple[int, int, int, int]] = []
    for index in range(desired):
        sx1 = int(round(float(width) * index / desired))
        sx2 = int(round(float(width) * (index + 1) / desired))
        sx2 = max(sx1 + 1, min(int(width), sx2))
        region = mask[:, sx1:sx2]
        box = _bbox_from_mask(region)
        if box is None:
            # Hard fallback: crop each speaker's horizontal lane, biased toward the upper face area.
            lane_w = sx2 - sx1
            side = max(16, min(lane_w, int(height)))
            cx = (sx1 + sx2) * 0.5
            cy = int(height) * 0.38
            x1 = max(0, min(int(width) - 1, int(round(cx - side * 0.5))))
            y1 = max(0, min(int(height) - 1, int(round(cy - side * 0.5))))
            x2 = max(x1 + 1, min(int(width), x1 + side))
            y2 = max(y1 + 1, min(int(height), y1 + side))
            boxes.append((x1, y1, x2, y2))
            continue
        px1, py1, px2, py2 = box
        boxes.append((sx1 + px1, py1, sx1 + px2, py2))
    return boxes


def _crop_frames_from_box_records(
    images: torch.Tensor,
    boxes: list[dict[str, int]],
    output_size: int | tuple[int, int],
) -> torch.Tensor:
    if isinstance(output_size, (tuple, list)) and len(output_size) >= 2:
        target_w = max(1, int(output_size[0]))
        target_h = max(1, int(output_size[1]))
    else:
        target = max(16, int(output_size))
        target_w = target
        target_h = target
    crops: list[torch.Tensor] = []
    for index, box in enumerate(boxes):
        x1 = max(0, min(int(images.shape[2]) - 1, int(box.get("x", 0))))
        y1 = max(0, min(int(images.shape[1]) - 1, int(box.get("y", 0))))
        x2 = max(x1 + 1, min(int(images.shape[2]), x1 + int(box.get("width", images.shape[2]))))
        y2 = max(y1 + 1, min(int(images.shape[1]), y1 + int(box.get("height", images.shape[1]))))
        crop = images[index : index + 1, y1:y2, x1:x2, :3].movedim(-1, 1)
        crop = F.interpolate(crop, size=(target_h, target_w), mode="bilinear", align_corners=False)
        crops.append(crop.movedim(1, -1).squeeze(0).contiguous())
    return torch.stack(crops, dim=0).clamp(0.0, 1.0).contiguous()


def _mean_box_center_x(boxes: list[dict[str, int]]) -> float:
    centers = [
        float(box.get("x", 0)) + float(box.get("width", 0)) * 0.5
        for box in boxes
        if int(box.get("width", 0)) > 0
    ]
    if not centers:
        return 0.0
    return sum(centers) / float(len(centers))


def _sort_faces_left_to_right(
    frame_outputs: list[torch.Tensor],
    face_positions: list[list[dict[str, int]]],
) -> tuple[list[torch.Tensor], list[list[dict[str, int]]]]:
    order = sorted(range(len(face_positions)), key=lambda index: _mean_box_center_x(face_positions[index]))
    return [frame_outputs[index] for index in order], [face_positions[index] for index in order]


def _parse_time_value(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    text = str(value or "").strip()
    if not text:
        return None
    match = TIMELINE_TIME_RE.search(text)
    if not match:
        try:
            return max(0.0, float(text))
        except Exception:
            return None
    if match.group("h") is not None:
        hours = int(match.group("h"))
        minutes = int(match.group("m"))
        seconds = int(match.group("s"))
        ms = match.group("ms") or ""
    else:
        hours = 0
        minutes = int(match.group("m2"))
        seconds = int(match.group("s2"))
        ms = match.group("ms2") or ""
    frac = float(f"0.{ms[1:]}") if ms else 0.0
    return max(0.0, hours * 3600.0 + minutes * 60.0 + seconds + frac)


def _extract_speaker_from_text(text: str) -> tuple[str, str]:
    raw = str(text or "").strip()
    match = SPEAKER_PREFIX_RE.match(raw)
    if not match:
        return "", raw
    speaker = str(match.group("bracket") or match.group("speaker") or match.group("speaker2") or "").strip()
    body = raw[match.end() :].strip()
    return speaker, body


def _normalize_timeline_entry(item: Any, default_duration: float) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    start = _parse_time_value(
        item.get("start", item.get("from", item.get("begin", item.get("start_time", item.get("startTime")))))
    )
    end = _parse_time_value(item.get("end", item.get("to", item.get("stop", item.get("end_time", item.get("endTime"))))))
    duration = _parse_time_value(item.get("duration", item.get("dur")))
    if start is None:
        return None
    if end is None:
        end = start + (duration if duration is not None and duration > 0 else max(0.05, float(default_duration)))
    text = str(item.get("text", item.get("content", item.get("line", item.get("caption", "")))) or "").strip()
    speaker_label = str(item.get("speaker_label", item.get("speakerLabel", item.get("label", ""))) or "").strip()
    raw_speaker = item.get("speaker", item.get("spk", item.get("name", item.get("role", ""))))
    speaker = speaker_label
    if not speaker and raw_speaker is not None:
        if isinstance(raw_speaker, (int, float)) and float(raw_speaker).is_integer():
            speaker = f"说话人{max(1, int(raw_speaker))}"
        else:
            speaker = str(raw_speaker or "").strip()
    if not speaker:
        speaker, text = _extract_speaker_from_text(text)
    elif speaker_label and text.startswith(f"[{speaker_label}]"):
        _speaker, text = _extract_speaker_from_text(text)
    return {
        "start": float(start),
        "end": max(float(start), float(end)),
        "speaker": speaker,
        "speaker_id": raw_speaker,
        "speaker_label": speaker_label or speaker,
        "text": text,
    }


def _flatten_json_timeline(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("segments", "items", "subtitles", "captions", "lines", "entries", "result"):
            value = data.get(key)
            if isinstance(value, list):
                return value
    return []


def _parse_json_timeline(text: str, default_duration: float) -> list[dict[str, Any]]:
    try:
        data = json.loads(text)
    except Exception:
        return []
    entries = []
    for item in _flatten_json_timeline(data):
        entry = _normalize_timeline_entry(item, default_duration)
        if entry is not None:
            entries.append(entry)
    return entries


def _parse_srt_vtt_timeline(text: str, default_duration: float) -> list[dict[str, Any]]:
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n+", normalized)
    entries: list[dict[str, Any]] = []
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        time_line_index = next((index for index, line in enumerate(lines) if "-->" in line), -1)
        if time_line_index < 0:
            continue
        left, right = lines[time_line_index].split("-->", 1)
        start = _parse_time_value(left)
        end = _parse_time_value(right)
        if start is None:
            continue
        if end is None:
            end = start + max(0.05, float(default_duration))
        body = " ".join(lines[time_line_index + 1 :]).strip()
        speaker, clean = _extract_speaker_from_text(body)
        entries.append({"start": float(start), "end": max(float(start), float(end)), "speaker": speaker, "text": clean})
    return entries


def _parse_lrc_timeline(text: str, default_duration: float) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in str(text or "").replace("\r\n", "\n").replace("\r", "\n").splitlines():
        matches = list(re.finditer(r"\[(\d{1,3}:\d{2}(?:[,.]\d{1,3})?)\]", line))
        if not matches:
            continue
        body = re.sub(r"\[(\d{1,3}:\d{2}(?:[,.]\d{1,3})?)\]", "", line).strip()
        speaker, clean = _extract_speaker_from_text(body)
        for match in matches:
            start = _parse_time_value(match.group(1))
            if start is not None:
                rows.append({"start": float(start), "end": float(start), "speaker": speaker, "text": clean})
    rows.sort(key=lambda item: float(item["start"]))
    for index, entry in enumerate(rows):
        next_start = rows[index + 1]["start"] if index + 1 < len(rows) else entry["start"] + max(0.05, float(default_duration))
        entry["end"] = max(float(entry["start"]), float(next_start))
    return rows


def _parse_timeline(text: str, default_duration: float) -> list[dict[str, Any]]:
    raw = str(text or "").strip()
    if not raw:
        return []
    entries = _parse_json_timeline(raw, default_duration)
    if not entries:
        entries = _parse_srt_vtt_timeline(raw, default_duration)
    if not entries:
        entries = _parse_lrc_timeline(raw, default_duration)
    entries = [entry for entry in entries if float(entry.get("end", 0.0)) > float(entry.get("start", 0.0))]
    entries.sort(key=lambda item: (float(item["start"]), float(item["end"])))
    return entries


def _speaker_stats(entries: list[dict[str, Any]]) -> tuple[list[str], dict[str, Any]]:
    speakers: list[str] = []
    stats: dict[str, Any] = {}
    for entry in entries:
        speaker = str(entry.get("speaker") or "").strip()
        if not speaker:
            continue
        if speaker not in stats:
            speakers.append(speaker)
            stats[speaker] = {"segments": 0, "duration": 0.0}
        stats[speaker]["segments"] += 1
        stats[speaker]["duration"] += max(0.0, float(entry["end"]) - float(entry["start"]))
    return speakers, stats


POSITION_NUMBER_MAP = {
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
}


def _parse_position_number(value: str) -> int:
    text = str(value or "").strip()
    if not text:
        return 1
    if text.isdigit():
        return max(1, int(text))
    return POSITION_NUMBER_MAP.get(text[:1], 1)


def _parse_face_position_index(value: str, face_count: int) -> int | None:
    text = re.sub(r"\s+", "", str(value or "").strip().lower())
    if not text or int(face_count) <= 0:
        return None
    if re.fullmatch(r"\d+", text):
        return max(0, int(text))

    left_match = re.search(r"(?:左边?|left|l[_-]?)([1-8一二两三四五六七八]?)", text)
    if left_match:
        number = _parse_position_number(left_match.group(1))
        return max(0, min(int(face_count) - 1, number - 1))

    right_match = re.search(r"(?:右边?|right|r[_-]?)([1-8一二两三四五六七八]?)", text)
    if right_match:
        number = _parse_position_number(right_match.group(1))
        return max(0, min(int(face_count) - 1, int(face_count) - number))

    if any(token in text for token in ("中", "中间", "center", "middle")):
        return max(0, min(int(face_count) - 1, int(face_count) // 2))
    return None


def _parse_speaker_face_map(text: str, face_count: int = MAX_FACE_OUTPUTS) -> dict[str, int]:
    result: dict[str, int] = {}
    for part in re.split(r"[;\n；]+", str(text or "")):
        raw = part.strip()
        if not raw:
            continue
        if "=" in raw:
            left, right = raw.split("=", 1)
        elif ":" in raw:
            left, right = raw.split(":", 1)
        elif "：" in raw:
            left, right = raw.split("：", 1)
        else:
            continue

        left = left.strip()
        right = right.strip()
        right_index = _parse_face_position_index(right, face_count)
        left_index = _parse_face_position_index(left, face_count)
        if right_index is not None and left:
            name = left
            index = right_index
        elif left_index is not None and right:
            name = right
            index = left_index
        else:
            continue
        if name:
            result[name] = max(0, min(int(face_count) - 1, int(index)))
    return result


def _speaker_direction_face_index(speaker: str, face_count: int) -> int | None:
    return _parse_face_position_index(speaker, face_count)


def _timeline_frame_ranges(
    entries: list[dict[str, Any]],
    speaker_name: str,
    speaker_to_face: dict[str, int],
    fps: float,
    frame_count: int,
) -> list[dict[str, Any]]:
    selected = str(speaker_name or "").strip()
    ranges: list[dict[str, Any]] = []
    for entry_index, entry in enumerate(entries):
        speaker = str(entry.get("speaker") or "").strip()
        if selected and speaker != selected:
            continue
        if speaker not in speaker_to_face:
            continue
        start_frame = max(0, min(int(frame_count), int(float(entry["start"]) * float(fps))))
        end_frame = max(start_frame + 1, min(int(frame_count), int(float(entry["end"]) * float(fps) + 0.999)))
        if start_frame >= frame_count:
            continue
        ranges.append(
            {
                "entry_index": int(entry_index),
                "speaker": speaker,
                "face_index": int(speaker_to_face[speaker]),
                "start": float(entry["start"]),
                "end": float(entry["end"]),
                "start_frame": int(start_frame),
                "end_frame": int(end_frame),
                "text": str(entry.get("text") or ""),
            }
        )
    return ranges


def _build_timeline_selection(
    face_outputs: list[torch.Tensor],
    face_positions: list[list[dict[str, int]]],
    ranges: list[dict[str, Any]],
    output_size: int | tuple[int, int],
) -> tuple[torch.Tensor, dict[str, Any]]:
    selected_frames: list[torch.Tensor] = []
    positions: list[dict[str, Any]] = []
    for item in ranges:
        face_index = int(item["face_index"])
        if face_index < 0 or face_index >= len(face_outputs):
            continue
        frames = face_outputs[face_index]
        face_boxes = face_positions[face_index] if face_index < len(face_positions) else []
        start_frame = max(0, min(int(frames.shape[0]), int(item["start_frame"])))
        end_frame = max(start_frame, min(int(frames.shape[0]), int(item["end_frame"])))
        for source_frame in range(start_frame, end_frame):
            selected_frames.append(frames[source_frame])
            box = dict(face_boxes[source_frame]) if source_frame < len(face_boxes) else {"frame": source_frame}
            box.update(
                {
                    "selected_frame": len(selected_frames) - 1,
                    "source_frame": int(source_frame),
                    "speaker": item["speaker"],
                    "face_index": face_index,
                    "entry_index": int(item["entry_index"]),
                    "start": float(item["start"]),
                    "end": float(item["end"]),
                }
            )
            positions.append(box)
    if selected_frames:
        tensor = torch.stack(selected_frames, dim=0).clamp(0.0, 1.0).contiguous()
    else:
        tensor = _empty_frames_for_size(output_size)
    return tensor, {"frame_count": int(len(selected_frames)), "positions": positions, "ranges": ranges}


def _build_source_aligned_timeline(
    face_outputs: list[torch.Tensor],
    face_positions: list[list[dict[str, int]]],
    ranges: list[dict[str, Any]],
    frame_count: int,
    output_size: int,
) -> tuple[torch.Tensor, dict[str, Any]]:
    target = max(16, int(output_size))
    sample = next((item for item in face_outputs if isinstance(item, torch.Tensor) and item.ndim == 4), None)
    device = sample.device if isinstance(sample, torch.Tensor) else torch.device("cpu")
    dtype = sample.dtype if isinstance(sample, torch.Tensor) else torch.float32
    aligned_frames = torch.zeros((int(frame_count), target, target, 3), dtype=dtype, device=device)
    positions_by_frame: dict[int, dict[str, Any]] = {}

    def put_frame(source_frame: int, base: dict[str, Any], is_silence: bool, filled_from_frame: int | None = None) -> dict[str, Any] | None:
        face_index = int(base.get("face_index", 0))
        if face_index < 0 or face_index >= len(face_outputs):
            return None
        frames = face_outputs[face_index]
        if source_frame < 0 or source_frame >= int(frames.shape[0]):
            return None
        aligned_frames[source_frame] = frames[source_frame]
        face_boxes = face_positions[face_index] if face_index < len(face_positions) else []
        box = dict(face_boxes[source_frame]) if source_frame < len(face_boxes) else {"frame": source_frame}
        box.update(
            {
                "source_frame": int(source_frame),
                "processed_frame": int(source_frame),
                "speaker": str(base.get("speaker") or ""),
                "face_index": face_index,
                "entry_index": int(base.get("entry_index", -1)),
                "start": float(base.get("start", 0.0)),
                "end": float(base.get("end", 0.0)),
                "start_frame": int(base.get("start_frame", source_frame)),
                "end_frame": int(base.get("end_frame", source_frame + 1)),
                "is_silence": bool(is_silence),
            }
        )
        if filled_from_frame is not None:
            box["filled_from_frame"] = int(filled_from_frame)
        return box

    for item in ranges:
        face_index = int(item["face_index"])
        if face_index < 0 or face_index >= len(face_outputs):
            continue
        start_frame = max(0, min(int(frame_count), int(item["start_frame"])))
        end_frame = max(start_frame, min(int(frame_count), int(item["end_frame"])))
        for source_frame in range(start_frame, end_frame):
            box = put_frame(source_frame, item, False)
            if box is not None:
                positions_by_frame[int(source_frame)] = box

    active_frame_numbers = sorted(positions_by_frame)
    if active_frame_numbers:
        nearest_index = 0
        for source_frame in range(int(frame_count)):
            if source_frame in positions_by_frame:
                continue
            while (
                nearest_index + 1 < len(active_frame_numbers)
                and abs(active_frame_numbers[nearest_index + 1] - source_frame) <= abs(active_frame_numbers[nearest_index] - source_frame)
            ):
                nearest_index += 1
            nearest_frame = active_frame_numbers[nearest_index]
            box = put_frame(source_frame, positions_by_frame[nearest_frame], True, nearest_frame)
            if box is not None:
                positions_by_frame[int(source_frame)] = box
    elif face_outputs:
        fallback = {"speaker": "", "face_index": 0, "entry_index": -1, "start": 0.0, "end": 0.0}
        for source_frame in range(int(frame_count)):
            box = put_frame(source_frame, fallback, True, None)
            if box is not None:
                positions_by_frame[int(source_frame)] = box

    all_positions = [positions_by_frame[source_frame] for source_frame in sorted(positions_by_frame)]
    active_count = sum(1 for item in all_positions if not bool(item.get("is_silence")))
    compact_positions = [
        {
            "frame": int(item.get("source_frame", item.get("frame", index))),
            "x": int(item.get("x", 0)),
            "y": int(item.get("y", 0)),
            "width": int(item.get("width", 1)),
            "height": int(item.get("height", 1)),
        }
        for index, item in enumerate(all_positions)
    ]
    return aligned_frames.clamp(0.0, 1.0).contiguous(), {
        "frame_count": int(frame_count),
        "active_frame_count": int(active_count),
        "silence_frame_count": int(len(all_positions) - active_count),
        "positions": compact_positions,
    }


def _load_position_payload(text: str) -> dict[str, Any]:
    try:
        payload = json.loads(str(text or "").strip())
    except Exception as exc:
        raise RuntimeError(f"裁剪位置 JSON 无法解析：{exc}") from exc
    if isinstance(payload, list):
        payload = {"positions": payload}
    if not isinstance(payload, dict):
        raise RuntimeError("裁剪位置 JSON 必须是对象或位置数组。")
    positions = payload.get("positions")
    if not isinstance(positions, list):
        raise RuntimeError("裁剪位置 JSON 缺少 positions 列表。")
    return payload


def _resize_processed_frame(frame: torch.Tensor, width: int, height: int) -> torch.Tensor:
    patch = frame[:height, :width, :3].unsqueeze(0).movedim(-1, 1)
    if int(patch.shape[-1]) != int(width) or int(patch.shape[-2]) != int(height):
        patch = F.interpolate(patch, size=(int(height), int(width)), mode="bilinear", align_corners=False)
    return patch.movedim(1, -1).squeeze(0).clamp(0.0, 1.0)


def _paste_mapping_from_record(raw: dict[str, Any], frame_width: int, frame_height: int) -> tuple[int, int, int, int]:
    crop_x = _safe_int(raw.get("x", 0), 0, 0, int(frame_width) - 1)
    crop_y = _safe_int(raw.get("y", 0), 0, 0, int(frame_height) - 1)
    crop_w = _safe_int(raw.get("width", frame_width), frame_width, 1, int(frame_width) - crop_x)
    crop_h = _safe_int(raw.get("height", frame_height), frame_height, 1, int(frame_height) - crop_y)
    return crop_x, crop_y, crop_w, crop_h


def _make_feather_mask(height: int, width: int, feather_percent: float, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    feather = max(0, int(round(min(int(height), int(width)) * max(0.0, float(feather_percent)) * 0.01)))
    if feather <= 0:
        return torch.ones((int(height), int(width), 1), device=device, dtype=dtype)
    y = torch.arange(int(height), device=device, dtype=dtype)
    x = torch.arange(int(width), device=device, dtype=dtype)
    dist_y = torch.minimum(y + 1, torch.tensor(int(height), device=device, dtype=dtype) - y)
    dist_x = torch.minimum(x + 1, torch.tensor(int(width), device=device, dtype=dtype) - x)
    mask_y = (dist_y / float(feather)).clamp(0.0, 1.0).view(int(height), 1)
    mask_x = (dist_x / float(feather)).clamp(0.0, 1.0).view(1, int(width))
    return torch.minimum(mask_y, mask_x).unsqueeze(-1)


def _make_face_soft_mask(height: int, width: int, feather_percent: float, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    edge = _make_feather_mask(int(height), int(width), feather_percent, device, dtype)
    y = torch.linspace(-1.0, 1.0, int(height), device=device, dtype=dtype).view(int(height), 1)
    x = torch.linspace(-1.0, 1.0, int(width), device=device, dtype=dtype).view(1, int(width))
    distance = torch.sqrt((x / 0.82).pow(2) + (y / 1.08).pow(2))
    oval = ((1.0 - distance) / 0.22).clamp(0.0, 1.0).unsqueeze(-1)
    return (edge * oval).clamp(0.0, 1.0)


def _match_patch_luma(patch: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    if patch.numel() <= 0 or target.numel() <= 0:
        return patch
    patch_mean = patch.mean(dim=(0, 1), keepdim=True)
    target_mean = target.mean(dim=(0, 1), keepdim=True)
    return (patch + (target_mean - patch_mean) * 0.75).clamp(0.0, 1.0)


def _save_preview_webp(tensor: torch.Tensor, fps: float, title: str) -> dict[str, Any] | None:
    if not isinstance(tensor, torch.Tensor) or tensor.numel() <= 0:
        return None
    try:
        frames = tensor.detach().cpu().float().clamp(0.0, 1.0).contiguous()
        target_dir = Path(folder_paths.get_temp_directory()) / "GJJ" / "sam3_face_crop_video_aio"
        target_dir.mkdir(parents=True, exist_ok=True)
        filename = f"GJJ_SAM3FaceCrop_{uuid.uuid4().hex[:12]}.webp"
        filepath = target_dir / filename
        arrays = torch.round(frames[..., :3] * 255.0).to(torch.uint8).numpy()
        pil_frames = [Image.fromarray(array, mode="RGB") for array in arrays]
        pil_frames[0].save(
            filepath,
            format="WEBP",
            save_all=len(pil_frames) > 1,
            append_images=pil_frames[1:],
            duration=max(1, round(1000.0 / max(0.01, float(fps)))),
            loop=0,
            lossless=False,
            quality=90,
            method=4,
        )
        return {
            "filename": filename,
            "subfolder": "GJJ/sam3_face_crop_video_aio",
            "type": "temp",
            "format": "image/webp",
            "media_type": "image",
            "title": title,
            "is_sequence": len(pil_frames) > 1,
            "autoplay": len(pil_frames) > 1,
            "loop": len(pil_frames) > 1,
            "frame_rate": float(fps),
            "frame_count": int(frames.shape[0]),
            "width": int(frames.shape[2]),
            "height": int(frames.shape[1]),
        }
    except Exception as exc:
        log.warning("SAM3 多人脸裁剪预览保存失败：%s", exc)
        return None


class GJJ_SAM3FaceCropVideoAIO:
    CATEGORY = "GJJ/视频工具/裁剪"
    FUNCTION = "crop_faces"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "输入单个媒体和 GJJ_UniversalTTS 对齐的时间轴文本，固定以 face 作为 SAM3 跟踪目标；"
        "按说话人时间段取当前说话人的脸，输出与源视频同帧数的脸部裁剪队列和回贴位置 JSON。"
    )
    RETURN_TYPES = (
        "GJJ_BATCH_IMAGE,IMAGE",
        "STRING",
    )
    RETURN_NAMES = (
        "切割后的脸",
        "时间裁剪JSON",
    )
    OUTPUT_TOOLTIPS = (
        "与源视频总帧数一致的脸部裁剪帧序列；静音帧会用最近说话人的当前帧人脸补齐，方便后续处理后按帧贴回。",
        "纯位置 JSON 数组；每项只包含 frame、x、y、width、height，用于贴回节点。",
    )
    SEARCH_ALIASES = [
        "SAM3 face crop video",
        "SAM3多人脸裁剪",
        "face crop video",
        "多人对口型裁脸",
        "GJJ_SAM3FaceCropVideoAIO",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        available = _checkpoint_list()
        default_model = _pick_default_checkpoint()
        return {
            "required": {
                "media": (
                    MEDIA_INPUT,
                    {
                        "display_name": "单个媒体",
                        "tooltip": "支持 GJJ_BATCH_IMAGE、普通 IMAGE batch 和官方 VIDEO；官方 VIDEO 会读取帧率。",
                    },
                ),
                "checkpoint": (
                    available or [DEFAULT_CHECKPOINT],
                    {
                        "default": default_model,
                        "display_name": "SAM3.1模型",
                        "tooltip": "自动搜索 models/checkpoints 下第一个包含 sam3.1_multiplex 的模型作为默认值。",
                    },
                ),
                "detection_threshold": (
                    "STRING",
                    {
                        "default": "0.5",
                        "multiline": False,
                        "display_name": "检测阈值",
                    },
                ),
                "max_faces": (
                    "INT",
                    {
                        "default": 8,
                        "min": 1,
                        "max": MAX_FACE_OUTPUTS,
                        "step": 1,
                        "display_name": "无时间轴兜底人数",
                        "tooltip": "有时间轴文本时自动使用说话人数；没有解析到说话人时才使用这个兜底人数。",
                    },
                ),
                "detect_interval": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 999,
                        "step": 1,
                        "display_name": "检测间隔",
                    },
                ),
                "smoothing": (
                    "STRING",
                    {
                        "default": "0.65",
                        "multiline": False,
                        "display_name": "裁剪框平滑",
                    },
                ),
                "square_crop": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "正方形裁剪",
                    },
                ),
                "timeline_text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "forceInput": True,
                        "display_name": "时间轴文本",
                        "tooltip": "可直接连接 GJJ_UniversalTTS 的“时间轴文本”输出；默认按 SRT 解析，也兼容它生成的 VTT、LRC 或 JSON。",
                    },
                ),
                "speaker_name": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "指定说话人",
                        "tooltip": "留空按时间轴输出全部说话人片段；填写 UniversalTTS 的 speaker_label 时只输出这个说话人的脸部裁剪片段。",
                    },
                ),
                "speaker_face_map": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "说话人-人脸映射",
                        "tooltip": "可写 说话人1=0、张三=左1，或 左1:张三、右1:李四。留空时按说话人首次出现顺序绑定从左到右的人脸。",
                    },
                ),
                "timeline_default_duration": (
                    "STRING",
                    {
                        "default": "2.0",
                        "multiline": False,
                        "display_name": "LRC默认时长",
                        "tooltip": "LRC 最后一行或无结束时间 JSON 项使用的兜底持续时间。",
                    },
                ),
                "frame_rate": (
                    "STRING",
                    {
                        "default": "16",
                        "multiline": False,
                        "display_name": "帧率",
                        "tooltip": "时间轴秒数换算为帧号时使用的帧率。必须和后续视频合成帧率一致。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        media,
        checkpoint,
        detection_threshold,
        max_faces,
        detect_interval,
        smoothing,
        square_crop,
        timeline_text="",
        speaker_name="",
        speaker_face_map="",
        timeline_default_duration=2.0,
        frame_rate="16",
        **kwargs,
    ):
        images = _extract_images(media)
        shape = tuple(images.shape) if isinstance(images, torch.Tensor) else None
        return json.dumps(
            [
                shape,
                checkpoint,
                detection_threshold,
                max_faces,
                detect_interval,
                smoothing,
                bool(square_crop),
                timeline_text,
                speaker_name,
                speaker_face_map,
                timeline_default_duration,
                frame_rate,
            ],
            ensure_ascii=False,
        )

    def crop_faces(
        self,
        media,
        checkpoint,
        detection_threshold="0.5",
        max_faces=8,
        detect_interval=1,
        smoothing="0.65",
        square_crop=True,
        timeline_text="",
        speaker_name="",
        speaker_face_map="",
        timeline_default_duration="2.0",
        frame_rate="16",
        unique_id=None,
        **kwargs,
    ):
        images = _extract_images(media)
        if images is None or int(images.shape[0]) <= 0:
            raise RuntimeError("请连接单个媒体输入：需要 GJJ_BATCH_IMAGE、IMAGE 批次或官方 VIDEO。")

        frame_count, height, width, _channels = images.shape
        detection_threshold_value = _safe_float(detection_threshold, 0.5, 0.0, 1.0)
        max_faces_value = _safe_int(max_faces, 8, 1, MAX_FACE_OUTPUTS)
        detect_interval_value = _safe_int(detect_interval, 1, 1, 999)
        smoothing_value = _safe_float(smoothing, 0.65, 0.0, 0.95)
        timeline_default_duration_value = _safe_float(timeline_default_duration, 2.0, 0.05, 60.0)
        fps = _safe_float(frame_rate, _extract_fps(media), 0.01, 240.0)
        model, clip, resolved = _load_checkpoint(checkpoint, unique_id=unique_id)
        translated_prompt = (_translate_prompts(["face"], unique_id=unique_id)[0] or "face").strip()
        conditioning = _encode_text(clip, translated_prompt)

        try:
            track_data = _track_route(
                images,
                model,
                conditioning,
                detection_threshold_value,
                max_faces_value,
                detect_interval_value,
            )
            track_data = _normalize_track_frame_count(track_data, images)
            track_data = _prepare_track_data(track_data, "", "从左到右")
        except Exception as exc:
            raise RuntimeError(
                f"SAM3 多人脸裁剪执行失败。\n模型：{resolved}\n跟踪目标：face\n详细错误：{exc}"
            ) from exc

        timeline_entries = _parse_timeline(timeline_text, timeline_default_duration_value)
        speakers, _per_speaker_stats = _speaker_stats(timeline_entries)

        masks = _unpack_sam3_masks(track_data)
        if masks is None:
            face_count = 0
        else:
            masks = F.interpolate(
                masks.float().view(int(masks.shape[0]) * int(masks.shape[1]), 1, int(masks.shape[-2]), int(masks.shape[-1])),
                size=(int(height), int(width)),
                mode="nearest",
            ).view(int(masks.shape[0]), int(masks.shape[1]), int(height), int(width)) > 0.5
            desired_face_count = len(speakers) if speakers else max_faces_value
            desired_face_count = max(1, min(MAX_FACE_OUTPUTS, int(desired_face_count)))
            face_count = min(desired_face_count, MAX_FACE_OUTPUTS)

        auto_crop_size = _auto_face_crop_size(masks, face_count, int(width), int(height)) if masks is not None and face_count > 0 else 64
        frame_outputs = []
        face_positions: list[list[dict[str, int]]] = []
        for face_index in range(face_count):
            boxes = _face_boxes_from_union_masks(
                masks,
                face_index,
                face_count,
                int(width),
                int(height),
                bool(square_crop),
                smoothing_value,
                auto_crop_size,
            )
            crops = _crop_frames_from_box_records(images, boxes, auto_crop_size)
            frame_outputs.append(crops)
            face_positions.append(boxes)

        frame_outputs, face_positions = _sort_faces_left_to_right(frame_outputs, face_positions)

        while len(frame_outputs) < MAX_FACE_OUTPUTS:
            frame_outputs.append(_empty_frames(auto_crop_size))
        while len(face_positions) < MAX_FACE_OUTPUTS:
            face_positions.append([])

        manual_map = _parse_speaker_face_map(speaker_face_map, face_count)
        speaker_to_face: dict[str, int] = {}
        next_face = 0
        for speaker in speakers:
            if speaker in manual_map:
                speaker_to_face[speaker] = manual_map[speaker]
                continue
            direction_index = _speaker_direction_face_index(speaker, face_count)
            if direction_index is not None:
                speaker_to_face[speaker] = direction_index
                continue
            while next_face in set(speaker_to_face.values()):
                next_face += 1
            speaker_to_face[speaker] = next_face
            next_face += 1
        speaker_to_face = {
            speaker: index
            for speaker, index in speaker_to_face.items()
            if 0 <= int(index) < int(face_count)
        }
        timeline_ranges = _timeline_frame_ranges(
            timeline_entries,
            speaker_name,
            speaker_to_face,
            float(fps),
            int(frame_count),
        )
        aligned_frames, selected_payload = _build_source_aligned_timeline(
            frame_outputs,
            face_positions,
            timeline_ranges,
            int(frame_count),
            auto_crop_size,
        )
        position_payload = _minimal_position_payload(selected_payload["positions"])
        preview_images = []
        preview = _save_preview_webp(aligned_frames, float(fps), "全长裁剪队列预览")
        if preview is not None:
            preview_images.append(preview)

        return {
            "ui": {
                "images": preview_images,
            },
            "result": (
                aligned_frames,
                json.dumps(position_payload, ensure_ascii=False),
            ),
        }


def _crop_audio_by_seconds(audio: dict[str, Any], start_time: float, end_time: float) -> dict[str, Any]:
    if not isinstance(audio, dict):
        raise RuntimeError("说话人分段裁剪需要连接 GJJ_UniversalTTS 的合成音频。")
    waveform = audio.get("waveform")
    if not isinstance(waveform, torch.Tensor):
        raise RuntimeError("音频对象缺少有效 waveform，无法按说话段裁剪。")
    sample_rate = _safe_int(audio.get("sample_rate", 44100), 44100, 1, 384000)
    total_samples = int(waveform.shape[-1])
    if total_samples <= 0:
        raise RuntimeError("音频 waveform 为空，无法按说话段裁剪。")
    start_sample = max(0, min(total_samples - 1, int(float(start_time) * sample_rate)))
    end_sample = max(start_sample + 1, min(total_samples, int(float(end_time) * sample_rate + 0.999)))
    return {
        "waveform": waveform[..., start_sample:end_sample].contiguous(),
        "sample_rate": sample_rate,
    }


def _minimal_position_payload(positions: list[dict[str, Any]]) -> list[dict[str, int]]:
    result: list[dict[str, int]] = []
    for index, raw in enumerate(positions):
        if not isinstance(raw, dict):
            continue
        source_frame = _safe_int(raw.get("source_frame", raw.get("frame", index)), index, 0, 10**9)
        processed_frame = _safe_int(raw.get("processed_frame", raw.get("selected_frame", index)), index, 0, 10**9)
        result.append(
            {
                "frame": int(source_frame),
                "processed_frame": int(processed_frame),
                "x": _safe_int(raw.get("x", 0), 0, 0, 10**9),
                "y": _safe_int(raw.get("y", 0), 0, 0, 10**9),
                "width": _safe_int(raw.get("width", 0), 0, 0, 10**9),
                "height": _safe_int(raw.get("height", 0), 0, 0, 10**9),
            }
        )
    return result


def _first_node_output(value: Any) -> Any:
    if isinstance(value, dict):
        result = value.get("result")
        if isinstance(result, (list, tuple)) and result:
            return result[0]
        if "video" in value:
            return value.get("video")
    if isinstance(value, (list, tuple)) and value:
        return value[0]
    return value


def _extract_audio_encoder_output(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    for attr in ("result", "output", "outputs"):
        if hasattr(value, attr):
            nested = _extract_audio_encoder_output(getattr(value, attr))
            if nested is not None:
                return nested
    if isinstance(value, dict):
        if value.get("encoded_audio_all_layers"):
            return value
        for key in ("result", "output", "outputs", "audio_encoder_output", "AUDIO_ENCODER_OUTPUT"):
            if key in value:
                nested = _extract_audio_encoder_output(value.get(key))
                if nested is not None:
                    return nested
        return None
    if isinstance(value, (list, tuple)):
        for item in value:
            nested = _extract_audio_encoder_output(item)
            if nested is not None:
                return nested
        return None
    layers = getattr(value, "encoded_audio_all_layers", None)
    if layers:
        return {"encoded_audio_all_layers": layers}
    return None


def _encode_audio_encoder_output(audio_encoder: Any, audio: dict[str, Any]) -> Any:
    if callable(getattr(audio_encoder, "encode_audio", None)):
        output = audio_encoder.encode_audio(audio["waveform"], audio["sample_rate"])
        return _ensure_audio_encoder_output(output)

    errors: list[str] = []
    for module_name in ("comfy_extras.nodes_audio_encoder", "comfy_extras.nodes_audio", "comfy_extras.nodes_wan", "nodes"):
        try:
            import importlib

            module = importlib.import_module(module_name)
            cls = getattr(module, "AudioEncoderEncode", None)
            if cls is None:
                mappings = getattr(module, "NODE_CLASS_MAPPINGS", None)
                if isinstance(mappings, dict):
                    cls = mappings.get("AudioEncoderEncode")
            if cls is None:
                continue
            instance = cls()
            for method_name in ("encode", "encode_audio", "execute"):
                methods = []
                instance_method = getattr(instance, method_name, None)
                class_method = getattr(cls, method_name, None)
                if callable(instance_method):
                    methods.append(instance_method)
                if callable(class_method) and class_method is not instance_method:
                    methods.append(class_method)
                for method in methods:
                    calls = (
                        lambda method=method: method(audio_encoder=audio_encoder, audio=audio),
                        lambda method=method: method(audio_encoder, audio),
                        lambda method=method: method(audio, audio_encoder),
                    )
                    for call in calls:
                        try:
                            output = _extract_audio_encoder_output(call())
                            if output is not None:
                                return output
                            errors.append(f"{module_name}.{method_name}: 返回值缺少 encoded_audio_all_layers")
                        except TypeError as exc:
                            errors.append(f"{module_name}.{method_name}: {exc}")
                            continue
                        except Exception as exc:
                            errors.append(f"{module_name}.{method_name}: {exc}")
                            continue
        except Exception as exc:
            errors.append(f"{module_name}: {exc}")
    raise RuntimeError("无法生成有效 AUDIO_ENCODER_OUTPUT；返回值缺少 encoded_audio_all_layers。尝试结果：" + " | ".join(errors[-8:]))


def _ensure_audio_encoder_output(value: Any) -> dict[str, Any]:
    output = _extract_audio_encoder_output(value)
    if output is None:
        if isinstance(value, dict):
            keys = ", ".join(str(key) for key in value.keys())
            raise RuntimeError(f"AUDIO_ENCODER_OUTPUT 格式不正确，缺少 encoded_audio_all_layers。当前字段：{keys}")
        raise RuntimeError(f"AUDIO_ENCODER_OUTPUT 格式不正确，缺少 encoded_audio_all_layers。当前类型：{type(value).__name__}")
    return output


def _video_from_combine_result(value: Any) -> Any:
    if isinstance(value, dict):
        result = value.get("result")
        if isinstance(result, (list, tuple)) and result:
            return result[0]
        if value.get("video") is not None:
            return value.get("video")
    if isinstance(value, (list, tuple)) and value:
        return value[0]
    return value


class GJJ_SAM3SpeakerSegmentFaceCrop:
    CATEGORY = "GJJ/视频工具/裁剪"
    FUNCTION = "crop_segment"
    OUTPUT_NODE = True
    DESCRIPTION = "按时间轴的第 N 个说话段裁剪单一说话人的脸和对应音频，避免 Bernini 在多人切换处生成滑动中间脸。"
    RETURN_TYPES = (
        "GJJ_BATCH_IMAGE,IMAGE",
        "AUDIO",
        "STRING",
        "INT",
        "INT",
        "INT",
        "INT",
        "STRING",
    )
    RETURN_NAMES = (
        "当前段脸",
        "当前段音频",
        "当前段贴回JSON",
        "当前段序号",
        "总段数",
        "起始帧",
        "当前段帧数",
        "当前段信息JSON",
    )
    OUTPUT_TOOLTIPS = (
        "只包含当前说话段、当前说话人的脸部裁剪帧，帧数等于当前说话段时长换算出的帧数。",
        "从合成音频中按当前说话段起止时间精确裁出的音频。",
        "只包含 frame、processed_frame、x、y、width、height 的贴回 JSON。",
        "当前实际输出的 1 基说话段序号。",
        "时间轴中可处理的说话段总数。",
        "当前段在源视频中的 0 基起始帧。",
        "当前段输出帧数。",
        "调试用信息 JSON。",
    )
    SEARCH_ALIASES = [
        "SAM3 speaker segment face crop",
        "说话人分段裁脸",
        "Bernini多人对话分段",
        "speaker segment crop",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        available = _checkpoint_list()
        default_model = _pick_default_checkpoint()
        return {
            "required": {
                "media": (
                    MEDIA_INPUT,
                    {
                        "display_name": "源视频",
                        "tooltip": "原始视频帧，支持 GJJ_BATCH_IMAGE、IMAGE 批次或官方 VIDEO。",
                    },
                ),
                "audio": (
                    "AUDIO",
                    {
                        "display_name": "合成音频",
                        "tooltip": "连接 GJJ_UniversalTTS 的合成音频；节点会按当前说话段精确裁剪。",
                    },
                ),
                "timeline_text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "forceInput": True,
                        "display_name": "时间轴文本",
                        "tooltip": "连接 GJJ_UniversalTTS 的时间轴文本。",
                    },
                ),
                "segment_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 100000,
                        "step": 1,
                        "display_name": "说话段序号",
                        "tooltip": "1 基序号。第 1 段、第 2 段……每次只输出一个说话段。",
                    },
                ),
                "checkpoint": (
                    available or [DEFAULT_CHECKPOINT],
                    {
                        "default": default_model,
                        "display_name": "SAM3.1模型",
                    },
                ),
                "detection_threshold": (
                    "STRING",
                    {
                        "default": "0.5",
                        "multiline": False,
                        "display_name": "检测阈值",
                    },
                ),
                "max_faces": (
                    "INT",
                    {
                        "default": 8,
                        "min": 1,
                        "max": MAX_FACE_OUTPUTS,
                        "step": 1,
                        "display_name": "无时间轴兜底人数",
                    },
                ),
                "detect_interval": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 999,
                        "step": 1,
                        "display_name": "检测间隔",
                    },
                ),
                "smoothing": (
                    "STRING",
                    {
                        "default": "0.65",
                        "multiline": False,
                        "display_name": "裁剪框平滑",
                    },
                ),
                "square_crop": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "正方形裁剪",
                    },
                ),
                "speaker_face_map": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "说话人-人脸映射",
                        "tooltip": "可写 张三=左1，或 左1:张三、右1:李四。留空时按说话人首次出现顺序绑定从左到右的人脸。",
                    },
                ),
                "timeline_default_duration": (
                    "STRING",
                    {
                        "default": "2.0",
                        "multiline": False,
                        "display_name": "LRC默认时长",
                    },
                ),
                "frame_rate": (
                    "STRING",
                    {
                        "default": "16",
                        "multiline": False,
                        "display_name": "帧率",
                        "tooltip": "时间轴秒数换算为源视频帧号时使用，必须和最终视频帧率一致。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        media,
        audio,
        timeline_text,
        segment_index,
        checkpoint,
        detection_threshold,
        max_faces,
        detect_interval,
        smoothing,
        square_crop,
        speaker_face_map="",
        timeline_default_duration="2.0",
        frame_rate="16",
        **kwargs,
    ):
        images = _extract_images(media)
        waveform = audio.get("waveform") if isinstance(audio, dict) else None
        return json.dumps(
            [
                tuple(images.shape) if isinstance(images, torch.Tensor) else None,
                tuple(waveform.shape) if isinstance(waveform, torch.Tensor) else None,
                audio.get("sample_rate") if isinstance(audio, dict) else None,
                timeline_text,
                segment_index,
                checkpoint,
                detection_threshold,
                max_faces,
                detect_interval,
                smoothing,
                bool(square_crop),
                speaker_face_map,
                timeline_default_duration,
                frame_rate,
            ],
            ensure_ascii=False,
        )

    def crop_segment(
        self,
        media,
        audio,
        timeline_text,
        segment_index=1,
        checkpoint=DEFAULT_CHECKPOINT,
        detection_threshold="0.5",
        max_faces=8,
        detect_interval=1,
        smoothing="0.65",
        square_crop=True,
        speaker_face_map="",
        timeline_default_duration="2.0",
        frame_rate="16",
        unique_id=None,
        **kwargs,
    ):
        images = _extract_images(media)
        if images is None or int(images.shape[0]) <= 0:
            raise RuntimeError("请连接源视频：需要 GJJ_BATCH_IMAGE、IMAGE 批次或官方 VIDEO。")

        frame_count, height, width, _channels = images.shape
        timeline_default_duration_value = _safe_float(timeline_default_duration, 2.0, 0.05, 60.0)
        fps = _safe_float(frame_rate, _extract_fps(media), 0.01, 240.0)
        timeline_entries = _parse_timeline(timeline_text, timeline_default_duration_value)
        if not timeline_entries:
            raise RuntimeError("时间轴为空，无法按说话人分段裁剪。")
        speakers, _stats = _speaker_stats(timeline_entries)
        if not speakers:
            raise RuntimeError("时间轴里没有解析到说话人标签，例如 [男人] 或 [右边的女人]。")

        detection_threshold_value = _safe_float(detection_threshold, 0.5, 0.0, 1.0)
        max_faces_value = _safe_int(max_faces, 8, 1, MAX_FACE_OUTPUTS)
        detect_interval_value = _safe_int(detect_interval, 1, 1, 999)
        smoothing_value = _safe_float(smoothing, 0.65, 0.0, 0.95)
        model, clip, resolved = _load_checkpoint(checkpoint, unique_id=unique_id)
        conditioning = _encode_text(clip, (_translate_prompts(["face"], unique_id=unique_id)[0] or "face").strip())

        try:
            track_data = _track_route(
                images,
                model,
                conditioning,
                detection_threshold_value,
                max_faces_value,
                detect_interval_value,
            )
            track_data = _normalize_track_frame_count(track_data, images)
            track_data = _prepare_track_data(track_data, "", "从左到右")
        except Exception as exc:
            raise RuntimeError(
                f"SAM3 说话人分段裁脸失败。\n模型：{resolved}\n详细错误：{exc}"
            ) from exc

        masks = _unpack_sam3_masks(track_data)
        if masks is None:
            raise RuntimeError("SAM3 没有返回可用的人脸 mask，无法按说话人裁剪。")
        masks = F.interpolate(
            masks.float().view(int(masks.shape[0]) * int(masks.shape[1]), 1, int(masks.shape[-2]), int(masks.shape[-1])),
            size=(int(height), int(width)),
            mode="nearest",
        ).view(int(masks.shape[0]), int(masks.shape[1]), int(height), int(width)) > 0.5
        face_count = min(max(1, len(speakers)), MAX_FACE_OUTPUTS, int(masks.shape[1]))
        if face_count <= 0:
            raise RuntimeError("没有检测到可用人脸。")

        auto_crop_size = _auto_face_crop_size(masks, face_count, int(width), int(height))
        frame_outputs = []
        face_positions: list[list[dict[str, int]]] = []
        for face_index in range(face_count):
            boxes = _face_boxes_from_union_masks(
                masks,
                face_index,
                face_count,
                int(width),
                int(height),
                bool(square_crop),
                smoothing_value,
                auto_crop_size,
            )
            frame_outputs.append(_crop_frames_from_box_records(images, boxes, auto_crop_size))
            face_positions.append(boxes)
        frame_outputs, face_positions = _sort_faces_left_to_right(frame_outputs, face_positions)

        manual_map = _parse_speaker_face_map(speaker_face_map, face_count)
        speaker_to_face: dict[str, int] = {}
        next_face = 0
        for speaker in speakers:
            if speaker in manual_map:
                speaker_to_face[speaker] = manual_map[speaker]
                continue
            direction_index = _speaker_direction_face_index(speaker, face_count)
            if direction_index is not None:
                speaker_to_face[speaker] = direction_index
                continue
            while next_face in set(speaker_to_face.values()):
                next_face += 1
            speaker_to_face[speaker] = next_face
            next_face += 1
        speaker_to_face = {speaker: index for speaker, index in speaker_to_face.items() if 0 <= int(index) < int(face_count)}
        ranges = _timeline_frame_ranges(timeline_entries, "", speaker_to_face, float(fps), int(frame_count))
        if not ranges:
            raise RuntimeError("时间轴说话人没有匹配到可用人脸，请检查说话人-人脸映射。")
        current_index = max(1, min(_safe_int(segment_index, 1, 1, len(ranges)), len(ranges)))
        current_range = ranges[current_index - 1]
        segment_frames, selected_payload = _build_timeline_selection(
            frame_outputs,
            face_positions,
            [current_range],
            auto_crop_size,
        )
        positions = _minimal_position_payload(selected_payload.get("positions") or [])
        if not positions:
            raise RuntimeError("当前说话段没有生成有效裁剪位置。")
        segment_audio = _crop_audio_by_seconds(audio, float(current_range["start"]), float(current_range["end"]))
        info = {
            "segment_index": int(current_index),
            "total_segments": int(len(ranges)),
            "start": float(current_range["start"]),
            "end": float(current_range["end"]),
            "start_frame": int(current_range["start_frame"]),
            "end_frame": int(current_range["end_frame"]),
            "frame_count": int(segment_frames.shape[0]),
            "crop_size": int(auto_crop_size),
            "frame_rate": float(fps),
        }
        preview_images = []
        preview = _save_preview_webp(segment_frames, float(fps), f"说话段 {current_index}/{len(ranges)}")
        if preview is not None:
            preview_images.append(preview)

        return {
            "ui": {
                "images": preview_images,
                "text": [
                    f"说话段 {current_index}/{len(ranges)}：源帧 {int(current_range['start_frame'])}-{int(current_range['end_frame']) - 1}，输出 {int(segment_frames.shape[0])} 帧"
                ],
            },
            "result": (
                segment_frames,
                segment_audio,
                json.dumps(positions, ensure_ascii=False),
                int(current_index),
                int(len(ranges)),
                int(current_range["start_frame"]),
                int(segment_frames.shape[0]),
                json.dumps(info, ensure_ascii=False),
            ),
        }


class GJJ_BerniniSpeakerSegmentAIO:
    CATEGORY = "GJJ/视频工具/对口型"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = "零依赖 Bernini 对口型：输入源视频和合成音频；有时间轴时按说话人逐段生成，没有时间轴时按单人整段生成，最后贴回并输出带完整音频的视频。"
    GJJ_UI = {"model_keyword": "bernini sam3.1 sam3.1_multiplex wav2vec2 umt5 lightx2v"}
    GJJ_HELP = build_node_help_payload(
        description=DESCRIPTION,
        model_tree=BERNINI_AIO_MODEL_TREE,
        models=BERNINI_AIO_REQUIRED_MODELS,
        usage=[
            "先用 SAM3.1 Multiplex 跟踪源视频中的 face，并根据时间轴/说话人映射裁出当前说话人的脸。",
            "每个说话段用 Bernini S2V High/Low 双阶段模型、UMT5 文本编码器、wav2vec2 音频编码器和 LightX2V LoRA 生成对口型。",
            "最终把分段对口型脸部贴回源视频，并保留完整合成音频输出。",
        ],
        runtime=[
            "SAM3.1 checkpoint 从 models/checkpoints 加载，默认匹配 sam3.1_multiplex_fp16.safetensors。",
            "Bernini 模型通过 GJJ_VideoUniversalModelLoader 加载 diffusion_models、vae、text_encoders、audio_encoders 与 loras。",
            "GJJ_ModelPatchBundle 会把 High/Low 模型与对应 LightX2V LoRA 组合后采样。",
        ],
        notice="模型树列出 Bernini 说话人分段 AIO 的全部本地模型；🧠 Bernini模型面板也包含 SAM3.1。sam3 和 sam3.1 是不同结构，不能互相替代。",
        copy_text="models/checkpoints/" + DEFAULT_CHECKPOINT,
        copy_label="📋 复制 SAM3.1 默认模型路径",
        extra={
            "title": "Bernini 说话人分段对口型 AIO",
            "model_tree": BERNINI_AIO_MODEL_TREE,
            "models": BERNINI_AIO_REQUIRED_MODELS,
            "static_model_tree_only": True,
            "model_tree_priority": "static",
        },
    )
    RETURN_TYPES = ("VIDEO", "STRING")
    RETURN_NAMES = ("对口型后视频", "处理信息JSON")
    OUTPUT_TOOLTIPS = (
        "已按说话段生成并贴回源视频、带完整合成音频的视频。",
        "本次处理的分段、帧数和输出信息。",
    )
    SEARCH_ALIASES = [
        "Bernini speaker segment aio",
        "Bernini多人对话一体化",
        "说话人分段对口型",
        "SAM3 Bernini lipsync",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        available = _checkpoint_list()
        default_model = _pick_default_checkpoint()
        high_models, high_default = _filtered_model_choices(
            "diffusion_models",
            ["bernini", "s2v", "high"],
            "wan2.2_bernini_r_high_noise_int8_convrot_s2v.safetensors",
        )
        low_models, low_default = _filtered_model_choices(
            "diffusion_models",
            ["bernini", "s2v", "low"],
            "wan2.2_bernini_r_low_noise_int8_convrot_s2v.safetensors",
        )
        vae_models, vae_default = _filtered_model_choices("vae", ["wan", "2.1", "vae"], "wan_2.1_vae.safetensors")
        clip_models, clip_default = _filtered_model_choices("text_encoders", ["umt5", "xxl"], "umt5_xxl_int4_convrot.safetensors")
        audio_models, audio_default = _filtered_model_choices("audio_encoders", ["wav2vec2"], "wav2vec2_large_english_fp16.safetensors")
        high_loras, high_lora_default = _filtered_model_choices("loras", ["bernini", "lightx2v", "high"], "Bernini/Bernini-R_LightX2V_high_noise.safetensors")
        low_loras, low_lora_default = _filtered_model_choices("loras", ["bernini", "lightx2v", "low"], "Bernini/Bernini-R_LightX2V_low_noise.safetensors")
        return {
            "required": {
                "source_video": (
                    MEDIA_INPUT,
                    {
                        "display_name": "源视频",
                        "tooltip": "原始视频帧，支持 GJJ_BATCH_IMAGE、IMAGE 批次或官方 VIDEO。",
                    },
                ),
                "audio": (
                    "AUDIO",
                    {
                        "display_name": "合成音频",
                        "tooltip": "连接 GJJ_UniversalTTS 的合成音频。",
                    },
                ),
                "frame_rate": (
                    "STRING",
                    {
                        "default": "16",
                        "multiline": False,
                        "display_name": "帧率",
                        "tooltip": "时间轴秒数换算为帧号、最终视频合成都会使用这个帧率。",
                    },
                ),
                "checkpoint": (
                    available or [DEFAULT_CHECKPOINT],
                    {
                        "default": default_model,
                        "display_name": "SAM3.1模型",
                    },
                ),
                "speaker_face_map": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "说话人-人脸映射",
                        "tooltip": "可写 张三=左1，或 左1:张三、右1:李四。留空时按说话人首次出现顺序绑定从左到右的人脸。",
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": "A person speaking naturally, accurate lip sync, stable face, realistic mouth movement.",
                        "multiline": True,
                        "display_name": "正向提示词",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "Vivid color tone, overexposed, static, unclear details, subtitles, style, artwork, painting, image, still, overall grayish, worst quality, low quality, leftover JPEG compression artifacts, ugly, incomplete, missing parts, poorly drawn face, disfigured, malformed body parts, fused fingers, a completely motionless image.",
                        "multiline": True,
                        "display_name": "负向提示词",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 4,
                        "min": 1,
                        "max": 100,
                        "step": 1,
                        "display_name": "步数",
                    },
                ),
                "high_steps": (
                    "INT",
                    {
                        "default": 2,
                        "min": 1,
                        "max": 100,
                        "step": 1,
                        "display_name": "高噪步数",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 30.0,
                        "step": 0.01,
                        "display_name": "CFG",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 999,
                        "min": 0,
                        "max": 0xffffffffffffffff,
                        "display_name": "种子",
                    },
                ),
                "sampler_name": (
                    "STRING",
                    {
                        "default": "dpmpp_2m_sde",
                        "multiline": False,
                        "display_name": "采样器",
                    },
                ),
                "scheduler": (
                    "STRING",
                    {
                        "default": "sgm_uniform",
                        "multiline": False,
                        "display_name": "调度器",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪",
                    },
                ),
                "ref_max_size": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 16,
                        "max": 8192,
                        "step": 16,
                        "display_name": "参考最长边",
                    },
                ),
                "detection_threshold": (
                    "STRING",
                    {
                        "default": "0.5",
                        "multiline": False,
                        "display_name": "检测阈值",
                    },
                ),
                "max_faces": (
                    "INT",
                    {
                        "default": 8,
                        "min": 1,
                        "max": MAX_FACE_OUTPUTS,
                        "step": 1,
                        "display_name": "无时间轴兜底人数",
                    },
                ),
                "detect_interval": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 999,
                        "step": 1,
                        "display_name": "检测间隔",
                    },
                ),
                "smoothing": (
                    "STRING",
                    {
                        "default": "0.65",
                        "multiline": False,
                        "display_name": "裁剪框平滑",
                    },
                ),
                "feather_percent": (
                    "STRING",
                    {
                        "default": "4",
                        "multiline": False,
                        "display_name": "贴回羽化%",
                    },
                ),
                "timeline_default_duration": (
                    "STRING",
                    {
                        "default": "2.0",
                        "multiline": False,
                        "display_name": "LRC默认时长",
                    },
                ),
                "filename_prefix": (
                    "STRING",
                    {
                        "default": "GJJ/bernini_speaker_aio/output",
                        "multiline": False,
                        "display_name": "文件名前缀",
                    },
                ),
                "vae_tiling": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "VAE分块",
                    },
                ),
                "bernini_high_model": (
                    high_models,
                    {
                        "default": high_default,
                        "display_name": "High模型",
                        "tooltip": "Bernini S2V High 模型；列表按去量化/扩展名后的 bernini+s2v+high 关键词过滤。",
                    },
                ),
                "bernini_low_model": (
                    low_models,
                    {
                        "default": low_default,
                        "display_name": "Low模型",
                        "tooltip": "Bernini S2V Low 模型；列表按去量化/扩展名后的 bernini+s2v+low 关键词过滤。",
                    },
                ),
                "bernini_vae": (
                    vae_models,
                    {
                        "default": vae_default,
                        "display_name": "VAE",
                        "tooltip": "Wan VAE；列表按去量化/扩展名后的 wan+2.1+vae 关键词过滤。",
                    },
                ),
                "bernini_clip": (
                    clip_models,
                    {
                        "default": clip_default,
                        "display_name": "CLIP编码器",
                        "tooltip": "Wan UMT5 XXL 文本编码器；列表按去量化/扩展名后的 umt5+xxl 关键词过滤。",
                    },
                ),
                "bernini_audio_encoder": (
                    audio_models,
                    {
                        "default": audio_default,
                        "display_name": "音频编码器",
                        "tooltip": "Wan S2V 音频编码器；列表按去量化/扩展名后的 wav2vec2 关键词过滤。",
                    },
                ),
                "bernini_high_lora": (
                    high_loras,
                    {
                        "default": high_lora_default,
                        "display_name": "High LoRA名称",
                        "tooltip": "High 加速 LoRA；列表按去量化/扩展名后的 bernini+lightx2v+high 关键词过滤。",
                    },
                ),
                "bernini_low_lora": (
                    low_loras,
                    {
                        "default": low_lora_default,
                        "display_name": "Low LoRA名称",
                        "tooltip": "Low 加速 LoRA；列表按去量化/扩展名后的 bernini+lightx2v+low 关键词过滤。",
                    },
                ),
                "sam3_text_prompt": (
                    "STRING",
                    {
                        "default": "head",
                        "multiline": False,
                        "display_name": "SAM3目标关键词",
                        "tooltip": "SAM3.1 Multiplex 跟踪目标关键词。默认 head；可改为 face、people 等英文目标。",
                    },
                ),
            },
            "optional": {
                "timeline_text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "forceInput": True,
                        "display_name": "时间轴文本",
                        "tooltip": "可选。连接 GJJ_UniversalTTS 的时间轴文本时按说话人分段；不连接或为空时按单人整段视频处理。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        source = _extract_images(kwargs.get("source_video"))
        audio = kwargs.get("audio")
        waveform = audio.get("waveform") if isinstance(audio, dict) else None
        return json.dumps(
            [
                tuple(source.shape) if isinstance(source, torch.Tensor) else None,
                tuple(waveform.shape) if isinstance(waveform, torch.Tensor) else None,
                audio.get("sample_rate") if isinstance(audio, dict) else None,
                kwargs.get("timeline_text", ""),
                kwargs.get("frame_rate", "16"),
                kwargs.get("checkpoint", ""),
                kwargs.get("speaker_face_map", ""),
                kwargs.get("positive_prompt", ""),
                kwargs.get("negative_prompt", ""),
                kwargs.get("steps", 4),
                kwargs.get("high_steps", 2),
                kwargs.get("cfg", 1.0),
                kwargs.get("seed", 999),
                kwargs.get("sampler_name", "dpmpp_2m_sde"),
                kwargs.get("scheduler", "sgm_uniform"),
                kwargs.get("denoise", 1.0),
                kwargs.get("bernini_high_model", ""),
                kwargs.get("bernini_low_model", ""),
                kwargs.get("bernini_vae", ""),
                kwargs.get("bernini_clip", ""),
                kwargs.get("bernini_audio_encoder", ""),
                kwargs.get("bernini_high_lora", ""),
                kwargs.get("bernini_low_lora", ""),
                kwargs.get("sam3_text_prompt", "head"),
            ],
            ensure_ascii=False,
        )

    def generate(
        self,
        source_video,
        audio,
        timeline_text,
        frame_rate="16",
        checkpoint=DEFAULT_CHECKPOINT,
        speaker_face_map="",
        positive_prompt="A person speaking naturally, accurate lip sync, stable face, realistic mouth movement.",
        negative_prompt="",
        steps=4,
        high_steps=2,
        cfg=1.0,
        seed=999,
        sampler_name="dpmpp_2m_sde",
        scheduler="sgm_uniform",
        denoise=1.0,
        ref_max_size=1024,
        detection_threshold="0.5",
        max_faces=8,
        detect_interval=1,
        smoothing="0.65",
        feather_percent="4",
        timeline_default_duration="2.0",
        filename_prefix="GJJ/bernini_speaker_aio/output",
        vae_tiling=True,
        bernini_high_model=AUTO_MODEL_CHOICE,
        bernini_low_model=AUTO_MODEL_CHOICE,
        bernini_vae=AUTO_MODEL_CHOICE,
        bernini_clip=AUTO_MODEL_CHOICE,
        bernini_audio_encoder=AUTO_MODEL_CHOICE,
        bernini_high_lora=AUTO_MODEL_CHOICE,
        bernini_low_lora=AUTO_MODEL_CHOICE,
        sam3_text_prompt="head",
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
        **kwargs,
    ):
        from .gjj_bernini_s2v import GJJBerniniS2VConditioning
        from .gjj_bernini_studio import (
            _basic_sigmas,
            _decode_bernini_frames,
            _ksampler,
            _memory_cleanup,
            _sample,
            _send_status,
            _split_sigmas,
        )
        from .gjj_clip_prompt_encode_panel import GJJ_CLIPPromptEncodePanel
        from .gjj_model_patch_bundle import GJJ_ModelPatchBundle
        from .gjj_video_combine import GJJ_VideoCombine
        from .gjj_video_universal_model_loader import GJJ_VideoUniversalModelLoader

        source = _extract_images(source_video)
        if source is None or int(source.shape[0]) <= 0:
            raise RuntimeError("请连接源视频。")
        if not isinstance(audio, dict) or not isinstance(audio.get("waveform"), torch.Tensor):
            raise RuntimeError("请连接有效的合成音频。")

        fps = _safe_float(frame_rate, _extract_fps(source_video), 0.01, 240.0)
        original_frame_count = int(source.shape[0])
        audio_duration = _audio_duration_seconds(audio)
        audio_frame_count = int(audio_duration * float(fps) + 0.999999) if audio_duration > 0 else original_frame_count
        source_extended = audio_frame_count > original_frame_count
        if source_extended:
            _send_status(
                unique_id,
                f"准备源视频：音频 {audio_duration:.2f}s，需要 {audio_frame_count} 帧，源视频往返补帧...",
                0.01,
            )
            source = _extend_frames_pingpong(source, audio_frame_count)
        frame_count, height, width, _channels = source.shape
        timeline_default_duration_value = _safe_float(timeline_default_duration, 2.0, 0.05, 60.0)
        timeline_entries = _parse_timeline(timeline_text, timeline_default_duration_value)
        single_speaker_mode = not timeline_entries
        if single_speaker_mode:
            timeline_entries = [
                {
                    "start": 0.0,
                    "end": float(int(frame_count) / float(fps)),
                    "speaker": "单人",
                    "text": "",
                }
            ]
        speakers, _stats = _speaker_stats(timeline_entries)
        if not speakers:
            speakers = ["单人"]

        _send_status(unique_id, "1/6 加载 SAM3 并跟踪目标...", 0.03)
        detection_threshold_value = _safe_float(detection_threshold, 0.5, 0.0, 1.0)
        max_faces_value = _safe_int(max_faces, 8, 1, MAX_FACE_OUTPUTS)
        detect_interval_value = _safe_int(detect_interval, 1, 1, 999)
        smoothing_value = _safe_float(smoothing, 0.65, 0.0, 0.95)
        model, sam_clip, resolved = _load_checkpoint(checkpoint, unique_id=unique_id)
        sam3_target = str(sam3_text_prompt or "head").strip() or "head"
        translated_sam3_target = (_translate_prompts([sam3_target], unique_id=unique_id)[0] or sam3_target).strip() or "head"
        conditioning = _encode_text(sam_clip, translated_sam3_target)
        try:
            track_data = _track_route(source, model, conditioning, detection_threshold_value, max_faces_value, detect_interval_value)
            track_data = _normalize_track_frame_count(track_data, source)
            track_data = _prepare_track_data(track_data, "", "从左到右")
        except Exception as exc:
            raise RuntimeError(
                f"SAM3 目标跟踪失败。\n模型：{resolved}\n原始目标：{sam3_target}\n翻译目标：{translated_sam3_target}\n详细错误：{exc}"
            ) from exc

        masks = _unpack_sam3_masks(track_data)
        if masks is None:
            raise RuntimeError("SAM3 没有返回可用的人脸 mask。")
        masks = F.interpolate(
            masks.float().view(int(masks.shape[0]) * int(masks.shape[1]), 1, int(masks.shape[-2]), int(masks.shape[-1])),
            size=(int(height), int(width)),
            mode="nearest",
        ).view(int(masks.shape[0]), int(masks.shape[1]), int(height), int(width)) > 0.5
        face_count = min(max(1, len(speakers)), MAX_FACE_OUTPUTS, int(masks.shape[1]))
        auto_crop_sizes = [
            _auto_face_crop_dimensions(masks, face_index, face_count, int(width), int(height))
            for face_index in range(face_count)
        ]
        frame_outputs = []
        face_positions: list[list[dict[str, int]]] = []
        for face_index in range(face_count):
            crop_size = auto_crop_sizes[face_index]
            boxes = _face_boxes_from_union_masks(
                masks,
                face_index,
                face_count,
                int(width),
                int(height),
                False,
                smoothing_value,
                crop_size,
            )
            frame_outputs.append(_crop_frames_from_box_records(source, boxes, crop_size))
            face_positions.append(boxes)
        frame_outputs, face_positions = _sort_faces_left_to_right(frame_outputs, face_positions)
        auto_crop_sizes = [
            (int(frames.shape[2]), int(frames.shape[1]))
            for frames in frame_outputs[:face_count]
        ]

        manual_map = _parse_speaker_face_map(speaker_face_map, face_count)
        speaker_to_face: dict[str, int] = {}
        next_face = 0
        for speaker in speakers:
            if speaker in manual_map:
                speaker_to_face[speaker] = manual_map[speaker]
                continue
            direction_index = _speaker_direction_face_index(speaker, face_count)
            if direction_index is not None:
                speaker_to_face[speaker] = direction_index
                continue
            while next_face in set(speaker_to_face.values()):
                next_face += 1
            speaker_to_face[speaker] = next_face
            next_face += 1
        speaker_to_face = {speaker: index for speaker, index in speaker_to_face.items() if 0 <= int(index) < int(face_count)}
        ranges = _timeline_frame_ranges(timeline_entries, "", speaker_to_face, float(fps), int(frame_count))
        if single_speaker_mode and ranges:
            ranges[0]["start_frame"] = 0
            ranges[0]["end_frame"] = int(frame_count)
            ranges[0]["start"] = 0.0
            ranges[0]["end"] = float(int(frame_count) / float(fps))
        if not ranges:
            raise RuntimeError("时间轴说话人没有匹配到可用人脸，请检查说话人-人脸映射。")

        _send_status(unique_id, "2/6 加载 Bernini S2V 模型...", 0.12)
        loaded = GJJ_VideoUniversalModelLoader().load_models(
            config="wan22_bernini_s2v",
            use_accel_lora=True,
            clip_type_override="auto",
            file_1=_model_choice_value(bernini_high_model),
            file_2=_model_choice_value(bernini_low_model),
            file_3=_model_choice_value(bernini_vae),
            file_4=_model_choice_value(bernini_clip),
            file_5=_model_choice_value(bernini_audio_encoder),
            file_6=_model_choice_value(bernini_high_lora),
            file_7=_model_choice_value(bernini_low_lora),
            unique_id=unique_id,
        )
        high_model, low_model, vae, clip, audio_encoder = loaded[:5]
        if high_model is None or low_model is None or vae is None or clip is None or audio_encoder is None:
            raise RuntimeError("Bernini S2V 模型加载结果不完整，请检查 High/Low/VAE/CLIP/音频编码器模型。")
        high_model, low_model = GJJ_ModelPatchBundle().patch(
            MODEL=high_model,
            低模=low_model,
            启用SageAttention=True,
            SageAttention模式="自动",
            允许Sage编译=False,
            启用FP16累积设置=False,
            FP16累积=True,
            缺SageAttention处理="自动跳过SageAttention继续运行",
            unique_id=unique_id,
        )
        positive, negative = GJJ_CLIPPromptEncodePanel().encode(
            clip=clip,
            positive_text=str(positive_prompt or ""),
            negative_text=str(negative_prompt or ""),
            zero_conditioning=False,
            translation_device="auto",
            translation_unload_after_use=True,
            translation_enabled=False,
            unique_id=unique_id,
        )

        steps_value = _safe_int(steps, 4, 1, 1000)
        high_steps_value = _safe_int(high_steps, 2, 1, steps_value)
        sigmas = _basic_sigmas(low_model, str(scheduler or "sgm_uniform"), steps_value, float(denoise))
        high_sigmas, low_sigmas = _split_sigmas(sigmas, high_steps_value)
        sampler = _ksampler(str(sampler_name or "dpmpp_2m_sde"))
        result_frames = source.clone().float().clamp(0.0, 1.0).contiguous()
        segment_infos: list[dict[str, Any]] = []

        with tempfile.TemporaryDirectory(prefix="gjj_bernini_speaker_aio_") as temp_dir:
            temp_path = Path(temp_dir)
            for index, item in enumerate(ranges, start=1):
                progress = 0.18 + 0.70 * ((index - 1) / max(1, len(ranges)))
                _send_status(unique_id, f"3/6 生成说话段 {index}/{len(ranges)}...", progress)
                segment_file = temp_path / f"segment_{index:04d}.pt"
                positions: list[dict[str, int]] = []
                seg_len = 0
                try:
                    segment_faces, selected_payload = _build_timeline_selection(
                        frame_outputs,
                        face_positions,
                        [item],
                        auto_crop_sizes[int(item["face_index"])] if int(item["face_index"]) < len(auto_crop_sizes) else 64,
                    )
                    positions = _minimal_position_payload(selected_payload.get("positions") or [])
                    if int(segment_faces.shape[0]) <= 0 or not positions:
                        continue
                    segment_audio = _crop_audio_by_seconds(audio, float(item["start"]), float(item["end"]))
                    audio_encoder_output = _ensure_audio_encoder_output(_encode_audio_encoder_output(audio_encoder, segment_audio))
                    seg_len = int(segment_faces.shape[0])
                    seg_h = int(segment_faces.shape[1])
                    seg_w = int(segment_faces.shape[2])
                    seg_positive, seg_negative, latent = GJJBerniniS2VConditioning().build(
                        positive=positive,
                        negative=negative,
                        vae=vae,
                        width=seg_w,
                        height=seg_h,
                        length=seg_len,
                        batch_size=1,
                        ref_max_size=int(ref_max_size),
                        audio_encoder_output=audio_encoder_output,
                        source_video=segment_faces,
                    )
                    high_latent = _sample(high_model, seg_positive, seg_negative, sampler, high_sigmas, latent, True, int(seed) + index - 1, float(cfg))
                    final_latent = _sample(low_model, seg_positive, seg_negative, sampler, low_sigmas, high_latent, False, int(seed) + index - 1, float(cfg))
                    generated = _decode_bernini_frames(
                        vae,
                        final_latent,
                        {
                            "vae_tiling": bool(vae_tiling),
                            "tile_x": 272,
                            "tile_y": 272,
                        },
                    )[:seg_len].detach().cpu().float().clamp(0.0, 1.0).contiguous()
                    torch.save(generated, segment_file)
                finally:
                    try:
                        del segment_faces
                    except Exception:
                        pass
                    try:
                        del selected_payload
                    except Exception:
                        pass
                    try:
                        del segment_audio
                    except Exception:
                        pass
                    try:
                        del audio_encoder_output
                    except Exception:
                        pass
                    try:
                        del latent
                    except Exception:
                        pass
                    try:
                        del high_latent
                    except Exception:
                        pass
                    try:
                        del final_latent
                    except Exception:
                        pass
                    try:
                        del generated
                    except Exception:
                        pass
                    try:
                        del seg_positive
                    except Exception:
                        pass
                    try:
                        del seg_negative
                    except Exception:
                        pass
                    _memory_cleanup(unique_id, f"说话段 {index} 生成后清理缓存...", clear_video_cache=True)

                if not segment_file.exists():
                    continue
                _send_status(unique_id, f"4/6 贴回说话段 {index}/{len(ranges)}...", progress + 0.03)
                generated_segment = torch.load(segment_file, map_location="cpu")
                result_frames = GJJ_SAM3FacePasteBackVideo().paste_back(
                    result_frames,
                    generated_segment,
                    json.dumps(positions, ensure_ascii=False),
                    feather_percent=feather_percent,
                )[0].detach().cpu().contiguous()
                try:
                    segment_file.unlink(missing_ok=True)
                except Exception:
                    pass
                try:
                    del generated_segment
                except Exception:
                    pass
                _memory_cleanup(unique_id, f"说话段 {index} 贴回后清理缓存...", clear_video_cache=True)
                segment_infos.append(
                    {
                        "segment_index": int(index),
                        "start": float(item["start"]),
                        "end": float(item["end"]),
                        "start_frame": int(item["start_frame"]),
                        "end_frame": int(item["end_frame"]),
                        "frame_count": int(seg_len),
                        "crop_width": int(seg_w),
                        "crop_height": int(seg_h),
                        "temp_saved": True,
                    }
                )

        _send_status(unique_id, "5/6 合成带音频视频...", 0.92)
        combined = GJJ_VideoCombine().combine(
            images=result_frames,
            frame_rate=float(fps),
            loop_count=0,
            filename_prefix=str(filename_prefix or "GJJ/bernini_speaker_aio/output"),
            format_name="video/h264-mp4",
            pingpong=False,
            save_output=True,
            use_source_fps=True,
            delete_tail_frame=False,
            save_metadata=True,
            trim_to_audio=False,
            pix_fmt="auto",
            crf="-1",
            vae=None,
            audio=audio,
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
            unique_id=unique_id,
        )
        video = _video_from_combine_result(combined)
        info = {
            "frame_rate": float(fps),
            "source_frames": int(frame_count),
            "source_original_frames": int(original_frame_count),
            "audio_duration": float(audio_duration),
            "audio_frames": int(audio_frame_count),
            "source_extended": bool(source_extended),
            "source_width": int(width),
            "source_height": int(height),
            "segments": segment_infos,
            "segment_count": int(len(segment_infos)),
        }
        _send_status(unique_id, f"6/6 完成：{len(segment_infos)} 段", 1.0)
        ui = combined.get("ui", {}) if isinstance(combined, dict) else {}
        return {
            "ui": ui,
            "result": (video, json.dumps(info, ensure_ascii=False)),
        }


class GJJ_SAM3FacePasteBackVideo:
    CATEGORY = "GJJ/视频工具/裁剪"
    FUNCTION = "paste_back"
    DESCRIPTION = "输入源视频、处理后的全长脸部裁剪视频和裁剪 JSON，按源帧号把人脸贴回源视频。"
    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE",)
    RETURN_NAMES = ("贴回后视频",)
    OUTPUT_TOOLTIPS = ("与源视频同帧数、同尺寸的贴回结果。",)
    SEARCH_ALIASES = [
        "SAM3 face paste back",
        "SAM3人脸贴回",
        "face crop paste back",
        "GJJ_SAM3FacePasteBackVideo",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source_media": (
                    MEDIA_INPUT,
                    {
                        "display_name": "源视频",
                        "tooltip": "原始视频帧，支持 GJJ_BATCH_IMAGE、IMAGE 批次或官方 VIDEO。",
                    },
                ),
                "processed_faces": (
                    MEDIA_INPUT,
                    {
                        "display_name": "处理后切割视频",
                        "tooltip": "连接 GJJ_SAM3FaceCropVideoAIO 的切割脸队列经过口型/修复处理后的结果；建议保持与源视频同帧数。",
                    },
                ),
                "time_crop_json": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "forceInput": True,
                        "display_name": "时间裁剪JSON",
                        "tooltip": "连接 GJJ_SAM3FaceCropVideoAIO 的时间裁剪 JSON。",
                    },
                ),
                "feather_percent": (
                    "STRING",
                    {
                        "default": "4",
                        "multiline": False,
                        "display_name": "边缘羽化%",
                        "tooltip": "贴回裁剪框边缘的柔化比例。0 表示硬贴。",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(cls, source_media, processed_faces, time_crop_json, feather_percent="4", **kwargs):
        source = _extract_images(source_media)
        processed = _extract_images(processed_faces)
        return json.dumps(
            [
                tuple(source.shape) if isinstance(source, torch.Tensor) else None,
                tuple(processed.shape) if isinstance(processed, torch.Tensor) else None,
                time_crop_json,
                feather_percent,
            ],
            ensure_ascii=False,
        )

    def paste_back(self, source_media, processed_faces, time_crop_json, feather_percent="4", **kwargs):
        source = _extract_images(source_media)
        processed = _extract_images(processed_faces)
        if source is None or int(source.shape[0]) <= 0:
            raise RuntimeError("请连接源视频。")
        if processed is None or int(processed.shape[0]) <= 0:
            raise RuntimeError("请连接处理后的切割视频。")

        payload = _load_position_payload(time_crop_json)
        positions = payload.get("positions") or []
        feather_value = _safe_float(feather_percent, 4.0, 0.0, 50.0)
        result = source.clone().float().clamp(0.0, 1.0).contiguous()
        source_frames, source_h, source_w, _channels = result.shape
        processed_frames = int(processed.shape[0])

        for fallback_index, raw in enumerate(positions):
            if not isinstance(raw, dict):
                continue
            source_frame = _safe_int(raw.get("source_frame", raw.get("frame", fallback_index)), fallback_index, 0, int(source_frames) - 1)
            processed_frame = _safe_int(
                raw.get("processed_frame", raw.get("selected_frame", source_frame)),
                source_frame,
                0,
                max(0, processed_frames - 1),
            )
            x, y, width, height = _paste_mapping_from_record(
                raw,
                int(source_w),
                int(source_h),
            )
            if width <= 0 or height <= 0:
                continue

            current = result[source_frame, y : y + height, x : x + width, :3]
            patch = _resize_processed_frame(processed[processed_frame], int(width), int(height)).to(result.device, result.dtype)
            patch = _match_patch_luma(patch, current)
            mask = _make_face_soft_mask(int(height), int(width), feather_value, result.device, result.dtype)
            result[source_frame, y : y + height, x : x + width, :3] = current * (1.0 - mask) + patch * mask

        return (result.clamp(0.0, 1.0).contiguous(),)


PASTE_NODE_NAME = "GJJ_SAM3FacePasteBackVideo"
PASTE_DISPLAY_NAME = "GJJ · 🎯🙂 SAM3人脸贴回视频"
SEGMENT_NODE_NAME = "GJJ_SAM3SpeakerSegmentFaceCrop"
SEGMENT_DISPLAY_NAME = "GJJ · 🎯🙂 SAM3说话人分段裁脸"
BERNINI_AIO_NODE_NAME = "GJJ_BerniniSpeakerSegmentAIO"
BERNINI_AIO_DISPLAY_NAME = "GJJ · 🎯🗣️ Bernini说话人分段对口型AIO"

NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_SAM3FaceCropVideoAIO,
    PASTE_NODE_NAME: GJJ_SAM3FacePasteBackVideo,
    SEGMENT_NODE_NAME: GJJ_SAM3SpeakerSegmentFaceCrop,
    BERNINI_AIO_NODE_NAME: GJJ_BerniniSpeakerSegmentAIO,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: DISPLAY_NAME,
    PASTE_NODE_NAME: PASTE_DISPLAY_NAME,
    SEGMENT_NODE_NAME: SEGMENT_DISPLAY_NAME,
    BERNINI_AIO_NODE_NAME: BERNINI_AIO_DISPLAY_NAME,
}
