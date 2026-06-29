from __future__ import annotations

import json
import math
import sys
from importlib import import_module
from pathlib import Path
from typing import Any

import torch
from PIL import Image, ImageColor, ImageDraw, ImageFilter, ImageOps

import folder_paths

from .common_utils.dependency_checker import (
    build_dependency_model_report,
    make_missing_model_spec,
    raise_dependency_model_error,
)
from .gjj_comprehensive_matting import (
    METHOD_RMBG14,
    MODEL_DOWNLOAD_URL,
    _load_rmbg14_model,
    _make_rgba_and_mask,
    _pil_list_to_tensor,
    _resolve_model_path,
    _select_device,
)
from .gjj_remove_bg_stitch import (
    MEDIA_INPUT_TYPE,
    _collect_media_images,
    _fit_background,
    _postprocess_mask_local,
    _run_rmbg14_all_masks,
    _tensor_signature,
)
from .gjj_model_bundle_loader import GJJ_ModelBundleLoader
from .gjj_qwen_image_edit_plus import GJJ_TextEncodeQwenImageEditPlus
from .common_utils import gjjutils_read_temp_pil_image, gjjutils_write_temp_pil_image, make_model_tree_item
from .common_utils.model_manager import gjjutils_resolve_model_name


NODE_NAME = "GJJ_SceneFusionPrep"
NODE_DISPLAY_NAME = "GJJ · 🧍 人景融合单节点"
BACKGROUND_UPLOAD_WIDGET = "background_upload"
PERSON_UPLOADS_WIDGET = "person_uploads_json"
CUTOUT_PREVIEW_WIDGET = "cutout_preview_only"

DEFAULT_COLORS = (
    "#0000FF",
    "#FF0000",
    "#00FF00",
    "#FF00FF",
    "#00FFFF",
    "#FFFF00",
)

DEFAULT_FUSION_PROMPT = "按颜色将图1中的角色精准放置到图2场景指定位置，保持角色外观与随身道具不变，并匹配场景的光照遮挡与透视尺度，不改动背景与构图。"
DEFAULT_TEMPLATE_ID = "FireRed-Image-Edit-1.1"
DEFAULT_UNET_SEEDS = ("FireRed-Image-Edit-1.1_fp8mixed_comfy.safetensors", "FireRed Image Edit 1.1")
DEFAULT_CLIP_SEEDS = ("qwen_2.5_vl_7b_fp8_scaled.safetensors", "qwen 2.5 vl 7b fp8 scaled")
DEFAULT_VAE_SEEDS = ("qwen_image_vae.safetensors", "qwen image vae")
DEFAULT_LORA_1_SEEDS = ("QWEN/FireRed-Image-Edit-1.0-Lightning-8steps-v1.1.safetensors", "FireRed Image Edit Lightning 8steps")
DEFAULT_LORA_2_SEEDS = ("QWEN/edit_2511人景色交互20-LORA+by_xiaodu.safetensors", "人景色交互")
DEFAULT_FUSION_CFG = 1.0
DEFAULT_FUSION_DENOISE = 1.0
DEFAULT_FUSION_SAMPLER = "euler"
DEFAULT_FUSION_SCHEDULER = "simple"
TTT_SEED = 397815496732818
TTT_STEPS = 8
TTT_CFG = 1.0
TTT_DENOISE = 1.0
TTT_SAMPLER = "euler"
TTT_SCHEDULER = "simple"
TTT_MODEL_SHIFT = 3.1
TTT_CFG_NORM_STRENGTH = 1.0
TTT_CFG_NORM_PRE_CFG = False

FUSION_MODEL_TREE = [
    make_model_tree_item(
        label="FireRed Image Edit 主模型",
        folder="diffusion_models",
        filename=DEFAULT_UNET_SEEDS[0],
        description="内部单节点融合默认使用的主扩散模型；支持 safetensors / gguf 等 ComfyUI 可加载格式，执行时用公共模糊搜索匹配。",
    ),
    make_model_tree_item(
        label="Qwen Image CLIP",
        folder="text_encoders",
        filename=DEFAULT_CLIP_SEEDS[0],
        description="Qwen Image Edit 文本/视觉编码器；也会兼容 models/clip。",
    ),
    make_model_tree_item(
        label="Qwen Image VAE",
        folder="vae",
        filename=DEFAULT_VAE_SEEDS[0],
        description="内部 VAE 编码/解码使用。",
    ),
    make_model_tree_item(
        label="Lightning LoRA",
        folder="loras",
        filename=DEFAULT_LORA_1_SEEDS[0],
        description="默认 8 步加速 LoRA。",
    ),
    make_model_tree_item(
        label="人景融合 LoRA",
        folder="loras",
        filename=DEFAULT_LORA_2_SEEDS[0],
        description="默认人景色交互 LoRA。",
    ),
]

DEFAULT_POSE = {
    "head": [0.0, -0.43],
    "neck": [0.0, -0.25],
    "pelvis": [0.0, 0.14],
    "left_shoulder": [-0.15, -0.21],
    "right_shoulder": [0.15, -0.21],
    "left_elbow": [-0.22, 0.02],
    "right_elbow": [0.22, 0.02],
    "left_hand": [-0.18, 0.25],
    "right_hand": [0.18, 0.25],
    "left_knee": [-0.11, 0.42],
    "right_knee": [0.11, 0.42],
    "left_foot": [-0.13, 0.66],
    "right_foot": [0.13, 0.66],
}

FIGURE_ASPECT = 0.42
IK_CHAINS = (
    {"root": "left_shoulder", "mid": "left_elbow", "end": "left_hand", "bend": 1.0},
    {"root": "right_shoulder", "mid": "right_elbow", "end": "right_hand", "bend": -1.0},
    {"root": "pelvis", "mid": "left_knee", "end": "left_foot", "bend": 1.0},
    {"root": "pelvis", "mid": "right_knee", "end": "right_foot", "bend": -1.0},
)

POSE_LINES = (
    ("head", "neck"),
    ("neck", "pelvis"),
    ("left_shoulder", "right_shoulder"),
    ("neck", "left_shoulder"),
    ("neck", "right_shoulder"),
    ("left_shoulder", "left_elbow"),
    ("left_elbow", "left_hand"),
    ("right_shoulder", "right_elbow"),
    ("right_elbow", "right_hand"),
    ("pelvis", "left_knee"),
    ("left_knee", "left_foot"),
    ("pelvis", "right_knee"),
    ("right_knee", "right_foot"),
)


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


class FlexiblePersonInputs(dict):
    def __init__(self, data: dict[str, Any] | None = None):
        super().__init__()
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        return (
            MEDIA_INPUT_TYPE,
            {
                "forceInput": True,
                "display_name": "人物",
                "tooltip": "需要去背景后作为角色资产放入准备图的人物图片；单个输入可接 IMAGE 批次/多图对象，节点会拆成多个人物并自动分配颜色。",
            },
        )

    def __contains__(self, key):
        return True


def _rmbg14_model_spec() -> dict[str, str]:
    return make_missing_model_spec(
        label="RMBG1.4 模型",
        subdir="RMBG",
        filename="rmbg1.4.safetensors",
        description="节点内部给人物去背景使用的默认模型。",
    )


def _startup_report() -> dict[str, Any]:
    missing_models: list[dict[str, str]] = []
    try:
        _resolve_model_path(METHOD_RMBG14)
    except Exception:
        missing_models.append(_rmbg14_model_spec())
    return build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_models=missing_models,
        description="人景融合准备节点需要 RMBG1.4 模型才能给人物自动去背景。",
        model_download_url=MODEL_DOWNLOAD_URL,
    )


_ENVIRONMENT_REPORT = _startup_report()
_MODELS_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("models_available", True))


def _unwrap(value: Any, fallback: Any = None) -> Any:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    return fallback if value is None else value


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _float(value: Any, fallback: float) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else fallback
    except Exception:
        return fallback


def _int(value: Any, fallback: int) -> int:
    try:
        return int(round(float(value)))
    except Exception:
        return fallback


def _bool(value: Any, fallback: bool = False) -> bool:
    raw = _unwrap(value, fallback)
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    text = str(raw or "").strip().lower()
    if text in {"1", "true", "yes", "on", "启用", "是"}:
        return True
    if text in {"0", "false", "no", "off", "禁用", "否", ""}:
        return False
    return fallback


def _align16(value: int) -> int:
    value = max(16, int(value or 16))
    return max(16, (value // 16) * 16)


def _rgb(value: str, fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    try:
        color = ImageColor.getrgb(str(value or "").strip())
        return int(color[0]), int(color[1]), int(color[2])
    except Exception:
        return fallback


def _hex(value: str, fallback: str) -> str:
    rgb = _rgb(value, _rgb(fallback, (34, 197, 94)))
    return f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"


def _metric_point(point: list[float]) -> tuple[float, float]:
    return _float(point[0], 0.0) * FIGURE_ASPECT, _float(point[1], 0.0)


def _local_point(point: tuple[float, float]) -> list[float]:
    return [
        _clamp(_float(point[0], 0.0) / FIGURE_ASPECT, -1.2, 1.2),
        _clamp(_float(point[1], 0.0), -1.2, 1.2),
    ]


def _metric_distance(a: list[float], b: list[float]) -> float:
    ax, ay = _metric_point(a)
    bx, by = _metric_point(b)
    return math.hypot(bx - ax, by - ay)


def _ik_chain_lengths(chain: dict[str, Any]) -> tuple[float, float]:
    upper = max(0.01, _metric_distance(DEFAULT_POSE[str(chain["root"])], DEFAULT_POSE[str(chain["mid"])]))
    lower = max(0.01, _metric_distance(DEFAULT_POSE[str(chain["mid"])], DEFAULT_POSE[str(chain["end"])]))
    return upper, lower


def _ik_side(root: list[float], end: list[float], point: list[float], fallback: float) -> float:
    ax, ay = _metric_point(root)
    bx, by = _metric_point(end)
    px, py = _metric_point(point)
    cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    if abs(cross) < 1e-5:
        return -1.0 if fallback < 0.0 else 1.0
    return -1.0 if cross < 0.0 else 1.0


def _solve_two_bone(root_local: list[float], target_local: list[float], upper: float, lower: float, bend_side: float) -> tuple[list[float], list[float]]:
    root_x, root_y = _metric_point(root_local)
    target_x, target_y = _metric_point(target_local)
    dx = target_x - root_x
    dy = target_y - root_y
    dist = math.hypot(dx, dy)
    if dist < 1e-5:
        dx = 0.0
        dy = upper + lower
        dist = math.hypot(dx, dy)
    min_reach = max(0.001, abs(upper - lower) + 0.001)
    max_reach = max(min_reach, upper + lower - 0.001)
    solved_dist = _clamp(dist, min_reach, max_reach)
    ux = dx / dist
    uy = dy / dist
    target_x = root_x + ux * solved_dist
    target_y = root_y + uy * solved_dist
    along = _clamp((upper * upper + solved_dist * solved_dist - lower * lower) / (2.0 * solved_dist), 0.0, upper)
    height = math.sqrt(max(0.0, upper * upper - along * along))
    side = -1.0 if bend_side < 0.0 else 1.0
    mid_x = root_x + ux * along + (-uy) * height * side
    mid_y = root_y + uy * along + ux * height * side
    return _local_point((mid_x, mid_y)), _local_point((target_x, target_y))


def _normalize_ik_pose(pose: dict[str, list[float]]) -> dict[str, list[float]]:
    clean = {key: list(pose.get(key, DEFAULT_POSE[key])) for key in DEFAULT_POSE}
    for chain in IK_CHAINS:
        root_key = str(chain["root"])
        mid_key = str(chain["mid"])
        end_key = str(chain["end"])
        upper, lower = _ik_chain_lengths(chain)
        bend = _ik_side(clean[root_key], clean[end_key], clean[mid_key], _float(chain.get("bend"), 1.0))
        mid, end = _solve_two_bone(clean[root_key], clean[end_key], upper, lower, bend)
        clean[mid_key] = mid
        clean[end_key] = end
    return clean


def _clean_pose(pose: dict[str, list[float]] | None) -> dict[str, list[float]]:
    clean = {key: list(DEFAULT_POSE[key]) for key in DEFAULT_POSE}
    if isinstance(pose, dict):
        for key, point in pose.items():
            if key not in DEFAULT_POSE or not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            clean[str(key)] = [
                _clamp(_float(point[0], DEFAULT_POSE[key][0]), -1.2, 1.2),
                _clamp(_float(point[1], DEFAULT_POSE[key][1]), -1.2, 1.2),
            ]
    return clean


def _resample_lanczos():
    return getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)


def _save_temp_image(image: Image.Image, prefix: str) -> dict[str, Any]:
    return gjjutils_write_temp_pil_image(image, format="PNG", suffix=".png")


def _parse_config(value: str) -> dict[str, dict[str, Any]]:
    try:
        parsed = json.loads(str(value or "{}"))
    except Exception:
        parsed = {}
    persons = parsed.get("persons") if isinstance(parsed, dict) else parsed
    result: dict[str, dict[str, Any]] = {}
    if not isinstance(persons, list):
        return result
    for index, item in enumerate(persons):
        if not isinstance(item, dict):
            continue
        person_id = str(item.get("id") or f"person_{index + 1:02d}")
        pose = item.get("pose")
        clean_pose: dict[str, list[float]] = {}
        if isinstance(pose, dict):
            for key, point in pose.items():
                if isinstance(point, (list, tuple)) and len(point) >= 2:
                    clean_pose[str(key)] = [
                        _clamp(_float(point[0], 0.0), -1.2, 1.2),
                        _clamp(_float(point[1], 0.0), -1.2, 1.2),
                    ]
        result[person_id] = {
            "x": _float(item.get("x"), 0.5),
            "y": _float(item.get("y"), 0.58),
            "scale": _float(item.get("scale"), 1.0),
            "rotation": _float(item.get("rotation"), 0.0),
            "face_angle": _float(item.get("face_angle"), 0.0),
            "z": _float(item.get("z"), index),
            "pose": _clean_pose({**DEFAULT_POSE, **clean_pose}),
        }
    return result


def _default_person(index: int, count: int) -> dict[str, Any]:
    return {
        "x": 0.5 if count <= 1 else (index + 1) / (count + 1),
        "y": 0.58,
        "scale": 1.0,
        "rotation": 0.0,
        "face_angle": 0.0,
        "color": DEFAULT_COLORS[index % len(DEFAULT_COLORS)],
        "z": float(index),
        "pose": _normalize_ik_pose(DEFAULT_POSE),
    }


def _person_rect(config: dict[str, Any], canvas_w: int, canvas_h: int) -> tuple[int, int, int, int]:
    figure_h = max(24, int(round(canvas_h * 0.56 * _clamp(_float(config.get("scale"), 1.0), 0.08, 4.0))))
    figure_w = max(16, int(round(figure_h * 0.42)))
    cx = int(round(_float(config.get("x"), 0.5) * canvas_w))
    cy = int(round(_float(config.get("y"), 0.58) * canvas_h))
    return cx - figure_w // 2, cy - figure_h // 2, cx + figure_w // 2, cy + figure_h // 2


def _transform_point(local: list[float], rect: tuple[int, int, int, int], degrees: float) -> tuple[int, int]:
    left, top, right, bottom = rect
    cx = (left + right) / 2.0
    cy = (top + bottom) / 2.0
    width = max(1.0, float(right - left))
    height = max(1.0, float(bottom - top))
    x = cx + _float(local[0], 0.0) * width
    y = cy + _float(local[1], 0.0) * height
    rad = math.radians(float(degrees or 0.0))
    dx = x - cx
    dy = y - cy
    return int(round(cx + dx * math.cos(rad) - dy * math.sin(rad))), int(round(cy + dx * math.sin(rad) + dy * math.cos(rad)))


def _point_from_angle(center: tuple[int, int], length: float, degrees: float) -> tuple[int, int]:
    rad = math.radians(float(degrees or 0.0))
    return int(round(center[0] + math.cos(rad) * length)), int(round(center[1] + math.sin(rad) * length))


def _trim_line_to_circle(
    start: tuple[int, int],
    end: tuple[int, int],
    center: tuple[int, int],
    radius: float,
) -> tuple[tuple[int, int], tuple[int, int]]:
    dx = float(end[0] - start[0])
    dy = float(end[1] - start[1])
    fx = float(start[0] - center[0])
    fy = float(start[1] - center[1])
    a = dx * dx + dy * dy
    if a <= 1e-6:
        return start, end
    b = 2.0 * (fx * dx + fy * dy)
    c = fx * fx + fy * fy - float(radius) * float(radius)
    disc = b * b - 4.0 * a * c
    if disc < 0:
        return start, end
    sqrt_disc = math.sqrt(disc)
    candidates = [(-b - sqrt_disc) / (2.0 * a), (-b + sqrt_disc) / (2.0 * a)]
    inside_start = (float(start[0] - center[0]) ** 2 + float(start[1] - center[1]) ** 2) < float(radius) ** 2
    if inside_start:
        valid = [t for t in candidates if 0.0 <= t <= 1.0]
        if valid:
            t = max(valid)
            start = (int(round(start[0] + dx * t)), int(round(start[1] + dy * t)))
    else:
        valid = [t for t in candidates if 0.0 <= t <= 1.0]
        if valid:
            t = min(valid)
            end = (int(round(start[0] + dx * t)), int(round(start[1] + dy * t)))
    return start, end


def _draw_stick_person(draw: ImageDraw.ImageDraw, config: dict[str, Any], canvas_w: int, canvas_h: int) -> None:
    color = _rgb(str(config.get("color") or "#0000FF"), (0, 0, 255))
    rect = _person_rect(config, canvas_w, canvas_h)
    rotation = _float(config.get("rotation"), 0.0)
    pose = config.get("pose") if isinstance(config.get("pose"), dict) else DEFAULT_POSE
    line_w = max(3, int(round((rect[3] - rect[1]) * 0.018)))
    points = {key: _transform_point(pose.get(key, DEFAULT_POSE[key]), rect, rotation) for key in DEFAULT_POSE}
    head = points["head"]
    radius = max(10, int(round((rect[3] - rect[1]) * 0.105)))
    face_angle = rotation + _float(config.get("face_angle"), 0.0)
    face_center = _point_from_angle(head, radius * 0.34, face_angle)
    for a, b in POSE_LINES:
        start = points[a]
        end = points[b]
        if a == "head":
            start, end = _trim_line_to_circle(start, end, face_center, radius * 0.96)
        elif b == "head":
            start, end = _trim_line_to_circle(start, end, face_center, radius * 0.96)
        draw.line([start, end], fill=color, width=line_w)
    draw.ellipse((head[0] - radius, head[1] - radius, head[0] + radius, head[1] + radius), outline=color, width=line_w)
    h1 = _point_from_angle(face_center, radius * 0.82, face_angle)
    h2 = _point_from_angle(face_center, radius * 0.82, face_angle + 180.0)
    v1 = _point_from_angle(face_center, radius * 0.82, face_angle + 90.0)
    v2 = _point_from_angle(face_center, radius * 0.82, face_angle - 90.0)
    draw.line((h1[0], h1[1], h2[0], h2[1]), fill=color, width=max(1, line_w // 2))
    draw.line((v1[0], v1[1], v2[0], v2[1]), fill=color, width=max(1, line_w // 2))


def _paste_rgba(canvas: Image.Image, layer: Image.Image, left: int, top: int) -> None:
    right = left + layer.width
    bottom = top + layer.height
    crop_left = max(0, -left)
    crop_top = max(0, -top)
    crop_right = layer.width - max(0, right - canvas.width)
    crop_bottom = layer.height - max(0, bottom - canvas.height)
    if crop_right <= crop_left or crop_bottom <= crop_top:
        return
    cropped = layer.crop((crop_left, crop_top, crop_right, crop_bottom))
    canvas.alpha_composite(cropped, (left + crop_left, top + crop_top))


def _place_cutout(canvas: Image.Image, cutout: Image.Image, config: dict[str, Any], canvas_w: int, canvas_h: int) -> dict[str, Any]:
    rect = _person_rect(config, canvas_w, canvas_h)
    target_h = max(1, rect[3] - rect[1])
    ratio = target_h / max(1, cutout.height)
    target_w = max(1, int(round(cutout.width * ratio)))
    target_h = max(1, int(round(cutout.height * ratio)))
    layer = cutout.convert("RGBA").resize((target_w, target_h), _resample_lanczos())
    rotation = _float(config.get("rotation"), 0.0)
    if abs(rotation) > 0.01:
        layer = layer.rotate(-rotation, resample=_resample_lanczos(), expand=True)
    cx = int(round(_float(config.get("x"), 0.5) * canvas_w))
    cy = int(round(_float(config.get("y"), 0.58) * canvas_h))
    left = cx - layer.width // 2
    top = cy - layer.height // 2
    _paste_rgba(canvas, layer, left, top)
    return {"left": left, "top": top, "right": left + layer.width, "bottom": top + layer.height}


def _trim_cutout_alpha(cutout: Image.Image, padding: int = 2) -> Image.Image:
    rgba = cutout.convert("RGBA")
    alpha = rgba.getchannel("A")
    bbox = alpha.point(lambda value: 255 if value > 8 else 0).getbbox()
    if not bbox:
        return rgba
    left = max(0, bbox[0] - padding)
    top = max(0, bbox[1] - padding)
    right = min(rgba.width, bbox[2] + padding)
    bottom = min(rgba.height, bbox[3] + padding)
    if right <= left or bottom <= top:
        return rgba
    return rgba.crop((left, top, right, bottom))


def _white_layout_slots(cutouts: list[Image.Image], canvas_w: int, canvas_h: int) -> list[tuple[int, int, int, int]]:
    count = max(1, len(cutouts))
    margin = 3
    gap = 3 if count > 1 else 0
    inset = max(3, min(10, int(round(canvas_h * 0.006)))) + 3
    work_w = max(1, canvas_w - margin * 2)
    work_h = max(1, canvas_h - margin * 2)
    aspects = [max(0.05, min(8.0, item.width / max(1, item.height))) for item in cutouts] or [1.0]
    total_aspect = max(0.05, sum(aspects))
    content_w_limit = max(1, work_w - gap * (count - 1) - inset * 2 * count)
    content_h_limit = max(1, work_h - inset * 2)
    content_h = max(1, int(min(content_h_limit, content_w_limit / total_aspect)))
    item_h = max(1, content_h + inset * 2)
    item_widths = [max(1, int(round(aspect * content_h)) + inset * 2) for aspect in aspects]
    used_w = sum(item_widths) + gap * (count - 1)
    cursor = margin + max(0, int(round((work_w - used_w) / 2)))
    top = margin + max(0, int(round((work_h - item_h) / 2)))
    slots: list[tuple[int, int, int, int]] = []
    for item_w in item_widths:
        slots.append((cursor, top, cursor + item_w, top + item_h))
        cursor += item_w + gap
    if len(slots) == count:
        return slots

    best_slots: list[tuple[int, int, int, int]] = []
    best_score = -1.0
    for rows in range(1, count + 1):
        columns = int(math.ceil(count / rows))
        if columns <= 0:
            continue
        outer_row_h = (work_h - gap * (rows - 1)) / rows
        row_h = outer_row_h - inset * 2
        if row_h <= 1:
            continue
        slots: list[tuple[int, int, int, int]] = []
        row_slots: list[list[tuple[int, int, int, int]]] = []
        score = 0.0
        index = 0
        used_h = 0
        for row in range(rows):
            remaining = count - index
            if remaining <= 0:
                break
            row_count = min(columns, remaining)
            row_aspects = aspects[index : index + row_count]
            max_row_w = work_w - gap * (row_count - 1) - inset * 2 * row_count
            natural_w = sum(row_aspects) * row_h
            scale = max_row_w / max(1.0, natural_w)
            content_h = max(1, int(round(row_h * scale)))
            item_h = content_h + inset * 2
            if item_h > row_h:
                item_h = max(1, int(row_h)) + inset * 2
                content_h = max(1, item_h - inset * 2)
            item_widths = [max(1, int(round(aspect * content_h)) + inset * 2) for aspect in row_aspects]
            used_w = sum(item_widths) + gap * (row_count - 1)
            row_left = margin + max(0, int(round((work_w - used_w) / 2)))
            row_top = used_h
            cursor = row_left
            current_row_slots: list[tuple[int, int, int, int]] = []
            for item_w in item_widths:
                current_row_slots.append((cursor, row_top, cursor + item_w, row_top + item_h))
                score += float(item_w * item_h)
                cursor += item_w + gap
            row_slots.append(current_row_slots)
            used_h += item_h + gap
            index += row_count
        used_h = max(0, used_h - gap)
        top_offset = margin + max(0, int(round((work_h - used_h) / 2)))
        for current_row_slots in row_slots:
            for left, top, right, bottom in current_row_slots:
                slots.append((left, top + top_offset, right, bottom + top_offset))
        fill_penalty = abs((columns / max(1, rows)) - (canvas_w / max(1, canvas_h))) * 0.01
        score -= fill_penalty * float(canvas_w * canvas_h)
        if len(slots) == count and score > best_score:
            best_score = score
            best_slots = slots
    if best_slots:
        return best_slots
    return [(margin, margin, max(margin + 1, canvas_w - margin), max(margin + 1, canvas_h - margin))]


def _place_cutout_in_slot(canvas: Image.Image, cutout: Image.Image, slot: tuple[int, int, int, int], border_width: int = 0, inner_gap: int = 3) -> dict[str, int]:
    left, top, right, bottom = slot
    slot_w = max(1, right - left)
    slot_h = max(1, bottom - top)
    inset = max(0, int(border_width)) + max(0, int(inner_gap))
    content_left = min(right - 1, left + inset)
    content_top = min(bottom - 1, top + inset)
    content_right = max(content_left + 1, right - inset)
    content_bottom = max(content_top + 1, bottom - inset)
    content_w = max(1, content_right - content_left)
    content_h = max(1, content_bottom - content_top)
    ratio = min(content_w / max(1, cutout.width), content_h / max(1, cutout.height))
    target_w = max(1, int(round(cutout.width * ratio)))
    target_h = max(1, int(round(cutout.height * ratio)))
    layer = cutout.convert("RGBA").resize((target_w, target_h), _resample_lanczos())
    paste_left = content_left + (content_w - target_w) // 2
    paste_top = content_top + (content_h - target_h) // 2
    _paste_rgba(canvas, layer, paste_left, paste_top)
    return {"left": left, "top": top, "right": right, "bottom": bottom, "content_left": paste_left, "content_top": paste_top, "content_right": paste_left + target_w, "content_bottom": paste_top + target_h}


def _to_tensor(image: Image.Image) -> torch.Tensor:
    return _pil_list_to_tensor([image.convert("RGB")]).contiguous()


def _load_temp_tensor(info: dict[str, Any]) -> torch.Tensor:
    return _to_tensor(gjjutils_read_temp_pil_image(info).convert("RGB"))


def _input_image_path(ref: Any) -> Path | None:
    text = str(ref or "").replace("\\", "/").strip()
    if not text:
        return None
    try:
        path = folder_paths.get_annotated_filepath(text)
        if path and Path(path).is_file():
            return Path(path)
    except Exception:
        pass
    try:
        base = Path(folder_paths.get_input_directory())
        path = (base / text).resolve()
        if path.is_file() and str(path).lower().startswith(str(base.resolve()).lower()):
            return path
    except Exception:
        pass
    return None


def _load_uploaded_images(value: Any) -> list[Image.Image]:
    raw = _unwrap(value, "")
    refs: list[Any]
    try:
        parsed = json.loads(str(raw or "[]"))
        refs = parsed if isinstance(parsed, list) else [parsed]
    except Exception:
        refs = [raw]
    images: list[Image.Image] = []
    for ref in refs:
        filename = ref.get("filename") if isinstance(ref, dict) else ref
        path = _input_image_path(filename)
        if path is None:
            continue
        try:
            with Image.open(path) as image:
                images.append(ImageOps.exif_transpose(image).convert("RGB"))
        except Exception:
            continue
    return images


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload: dict[str, Any] = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _try_node_class(class_name: str, modules: tuple[str, ...] = ("nodes", "comfy_extras.nodes_model_advanced")):
    for module_name in modules:
        try:
            module = import_module(module_name)
            mappings = getattr(module, "NODE_CLASS_MAPPINGS", None)
            if isinstance(mappings, dict) and class_name in mappings:
                return mappings[class_name]
            value = getattr(module, class_name, None)
            if value is not None:
                return value
        except Exception:
            continue
    for module in list(sys.modules.values()):
        mappings = getattr(module, "NODE_CLASS_MAPPINGS", None)
        if isinstance(mappings, dict) and class_name in mappings:
            return mappings[class_name]
    return None


def _resolve_seeded_model_name(selection: Any, folder_type: str, seeds: tuple[str, ...], label: str, *, relative_dir: str | None = None) -> str:
    return gjjutils_resolve_model_name(
        selection,
        folder_type,
        relative_dir=relative_dir,
        candidates=seeds,
        label=label,
        auto_values=("", "auto", "自动", "锁定", "主关键词"),
    )


def _call_node_method(node: Any, method_name: str, **kwargs):
    method = getattr(node, method_name, None)
    if method is None:
        raise RuntimeError(f"当前 ComfyUI 环境缺少 {node.__class__.__name__}.{method_name}。")
    try:
        return _unpack_node_output(method(**kwargs))
    except TypeError:
        ordered = {
            "encode": ("vae", "pixels"),
            "decode": ("vae", "samples"),
            "sample": ("model", "seed", "steps", "cfg", "sampler_name", "scheduler", "positive", "negative", "latent_image", "denoise"),
            "patch": ("model", "strength", "pre_cfg"),
        }.get(method_name, tuple(kwargs.keys()))
        return _unpack_node_output(method(*[kwargs[key] for key in ordered if key in kwargs]))


def _looks_like_node_output(value: Any) -> bool:
    name = value.__class__.__name__ if value is not None else ""
    return name == "NodeOutput" or (hasattr(value, "node") and hasattr(value, "output_index"))


def _unpack_node_output(value: Any) -> tuple[Any, ...]:
    if value is None:
        return (None,)
    if isinstance(value, tuple):
        return value
    if _looks_like_node_output(value) and hasattr(value, "args"):
        args = getattr(value, "args", ())
        if isinstance(args, tuple):
            return args
        if isinstance(args, list):
            return tuple(args)
        return (args,)
    return (value,)


def _workflow_method_name(node: Any, preferred: str, *fallbacks: str) -> str:
    for name in (str(getattr(node, "FUNCTION", "") or ""), preferred, *fallbacks):
        if name and hasattr(node, name):
            return name
    candidates = [name for name in (preferred, *fallbacks) if name]
    raise RuntimeError(f"当前 ComfyUI 环境缺少 {node.__class__.__name__}.{candidates[0] if candidates else preferred}。")


def _call_workflow_node_method(node: Any, method_name: str, *fallbacks: str, **kwargs):
    actual_method_name = _workflow_method_name(node, method_name, *fallbacks)
    method = getattr(node, actual_method_name, None)
    if method is None:
        raise RuntimeError(f"当前 ComfyUI 环境缺少 {node.__class__.__name__}.{actual_method_name}。")
    return _unpack_node_output(method(**kwargs))


def _is_model_like(value: Any) -> bool:
    return value is not None and (
        hasattr(value, "get_model_object")
        or hasattr(value, "model")
        or value.__class__.__name__ == "ModelPatcher"
    )


def _use_model_result(original_model: Any, result: Any, node_name: str, unique_id: Any = None) -> Any:
    candidate = _unpack_node_output(result)[0]
    if _is_model_like(candidate):
        return candidate
    if candidate is not None:
        _send_status(unique_id, f"{node_name}:保留", None)
    return original_model


def _apply_model_sampling_aura_flow(model: Any, shift: float, unique_id: Any = None):
    node_class = _try_node_class("ModelSamplingAuraFlow", ("comfy_extras.nodes_model_advanced", "nodes"))
    if node_class is None:
        raise RuntimeError("当前 ComfyUI 环境缺少标准 ModelSamplingAuraFlow 节点，无法按 TTT 工作流执行二阶段。")
    patched = _use_model_result(
        model,
        _call_workflow_node_method(node_class(), "patch", "execute", "apply", model=model, shift=float(shift)),
        "AuraFlow",
        unique_id,
    )
    _send_status(unique_id, "AuraFlow:ModelSamplingAuraFlow", 0.60)
    return patched


def _apply_cfg_norm(model: Any, strength: float, pre_cfg: bool, unique_id: Any = None):
    strength = float(strength)
    node_class = _try_node_class("CFGNorm", ("comfy_extras.nodes_cfg", "comfy_extras.nodes_model_advanced", "nodes"))
    if node_class is None:
        raise RuntimeError("当前 ComfyUI 环境缺少标准 CFGNorm 节点，无法按 TTT 工作流执行二阶段。")
    node = node_class()
    try:
        result = _call_workflow_node_method(
            node,
            "patch",
            "execute",
            "apply",
            model=model,
            strength=strength,
            pre_cfg=bool(pre_cfg),
        )
    except TypeError as exc:
        if "pre_cfg" not in str(exc):
            raise
        result = _call_workflow_node_method(
            node,
            "patch",
            "execute",
            "apply",
            model=model,
            strength=strength,
        )
    patched = _use_model_result(model, result, "CFGNorm", unique_id)
    _send_status(unique_id, "CFGNorm:CFGNorm", 0.63)
    return patched


def _vae_encode_image(vae: Any, image: torch.Tensor, unique_id: Any = None) -> dict[str, Any]:
    node_class = _try_node_class("VAEEncode", ("nodes",))
    if node_class is None:
        raise RuntimeError("当前 ComfyUI 环境缺少标准 VAEEncode 节点，无法按 TTT 工作流执行二阶段。")
    _send_status(unique_id, "VAE入:VAEEncode", 0.73)
    return _call_workflow_node_method(node_class(), "encode", vae=vae, pixels=image[:, :, :, :3])[0]


def _vae_decode_latent(vae: Any, latent: dict[str, Any], unique_id: Any = None) -> torch.Tensor:
    node_class = _try_node_class("VAEDecode", ("nodes",))
    if node_class is None:
        raise RuntimeError("当前 ComfyUI 环境缺少标准 VAEDecode 节点，无法按 TTT 工作流执行二阶段。")
    _send_status(unique_id, "VAE出:VAEDecode", 0.94)
    return _call_workflow_node_method(node_class(), "decode", vae=vae, samples=latent)[0]


def _sample_latent_standard(
    model: Any,
    latent: dict[str, Any],
    positive: Any,
    negative: Any,
    *,
    seed: int,
    steps: int,
    cfg: float,
    sampler_name: str,
    scheduler: str,
    denoise: float,
    unique_id: Any = None,
) -> dict[str, Any]:
    node_class = _try_node_class("KSampler", ("nodes",))
    if node_class is None:
        raise RuntimeError("当前 ComfyUI 环境缺少标准 KSampler 节点，无法按 TTT 工作流执行二阶段。")
    _send_status(unique_id, "采样:KSampler", 0.80)
    return _call_workflow_node_method(
        node_class(),
        "sample",
        model=model,
        seed=seed,
        steps=steps,
        cfg=cfg,
        sampler_name=sampler_name,
        scheduler=scheduler,
        positive=positive,
        negative=negative,
        latent_image=latent,
        denoise=denoise,
    )[0]


def _load_internal_bundle(kwargs: dict[str, Any]) -> tuple[Any, Any, Any]:
    unique_id = kwargs.get("unique_id")
    _send_status(unique_id, "模型", 0.48)
    unet_name = _resolve_seeded_model_name(DEFAULT_UNET_SEEDS[0], "diffusion_models", DEFAULT_UNET_SEEDS, "FireRed Image Edit 主模型")
    clip_name = _resolve_seeded_model_name(DEFAULT_CLIP_SEEDS[0], "text_encoders", DEFAULT_CLIP_SEEDS, "Qwen Image CLIP")
    vae_name = _resolve_seeded_model_name(DEFAULT_VAE_SEEDS[0], "vae", DEFAULT_VAE_SEEDS, "Qwen Image VAE")
    lora_1_name = _resolve_seeded_model_name(DEFAULT_LORA_1_SEEDS[0], "loras", DEFAULT_LORA_1_SEEDS, "Lightning LoRA")
    lora_2_name = _resolve_seeded_model_name(DEFAULT_LORA_2_SEEDS[0], "loras", DEFAULT_LORA_2_SEEDS, "人景融合 LoRA")

    loader = GJJ_ModelBundleLoader()
    loaded = loader.load_models(
        unet_name=unet_name,
        unet_dtype="default",
        clip_name=clip_name,
        clip_type="qwen_image",
        clip_dtype="default",
        vae_name=vae_name,
        vae_dtype="default",
        use_separate_vae=False,
        steps=TTT_STEPS,
        cfg=TTT_CFG,
        denoise=TTT_DENOISE,
        template_id=DEFAULT_TEMPLATE_ID,
        preset_lora_1_enabled=True,
        preset_lora_1_name=lora_1_name,
        preset_lora_1_strength="1",
        preset_lora_2_enabled=True,
        preset_lora_2_name=lora_2_name,
        preset_lora_2_strength="1.00",
        model_patch_enabled=False,
        clip_vision_name="",
        control_net_name="",
        lora_chain_config="",
    )
    _send_status(unique_id, "模型完成", 0.58)
    return loaded[0], loaded[1], loaded[2]


def _generate_fusion_image(stick: torch.Tensor, white: torch.Tensor, kwargs: dict[str, Any]) -> torch.Tensor:
    unique_id = kwargs.get("unique_id")
    _send_status(unique_id, "融合", 0.45)
    model, clip, vae = _load_internal_bundle(kwargs)

    model = _apply_model_sampling_aura_flow(model, TTT_MODEL_SHIFT, unique_id)
    model = _apply_cfg_norm(
        model,
        TTT_CFG_NORM_STRENGTH,
        TTT_CFG_NORM_PRE_CFG,
        unique_id,
    )

    qwen = GJJ_TextEncodeQwenImageEditPlus()
    _send_status(unique_id, "编码:图1人物/图2背景", 0.66)
    _main_image, positive, negative = qwen.encode(
        clip=clip,
        positive_prompt=DEFAULT_FUSION_PROMPT,
        negative_prompt="",
        zero_conditioning=True,
        apply_kontext_scale=False,
        apply_reference_latents_method=False,
        reference_latents_method="index_timestep_zero",
        translation_device="auto",
        translation_unload_after_use=True,
        translation_enabled=False,
        vae=vae,
        lora_triggers="",
        image_01=white,
        image_02=stick,
    )

    _send_status(unique_id, "VAE入:背景", 0.72)
    latent = _vae_encode_image(vae, stick, unique_id)
    _send_status(unique_id, "采样", 0.78)

    sampled = _sample_latent_standard(
        model=model,
        seed=TTT_SEED,
        steps=TTT_STEPS,
        cfg=TTT_CFG,
        sampler_name=TTT_SAMPLER,
        scheduler=TTT_SCHEDULER,
        positive=positive,
        negative=negative,
        latent=latent,
        denoise=TTT_DENOISE,
        unique_id=unique_id,
    )
    _send_status(unique_id, "VAE出", 0.93)
    output = _vae_decode_latent(vae, sampled, unique_id)
    if hasattr(output, "shape") and len(output.shape) == 5:
        output = output.reshape(-1, output.shape[-3], output.shape[-2], output.shape[-1])
    _send_status(unique_id, "融合完成", 0.97)
    return output


def _collect_person_images(kwargs: dict[str, Any]) -> list[Image.Image]:
    images: list[Image.Image] = []
    for key in sorted(kwargs.keys()):
        if not str(key).startswith("person_"):
            continue
        batch = _collect_media_images(kwargs.get(key), f"人物 {key}", sample_video=True)
        if batch:
            images.extend(image.convert("RGB") for image in batch)
    return images


class GJJ_SceneFusionPrep:
    CATEGORY = "GJJ/Image"
    FUNCTION = "prepare"
    OUTPUT_NODE = True
    INPUT_IS_LIST = True
    DESCRIPTION = (
        "用于人景融合工作流的准备节点：把多个人物抠图后按自动颜色、位置、大小和火柴棍姿势标注到背景上，"
        "同时输出白底人物色框参考图。"
        if _MODELS_AVAILABLE
        else f"{_ENVIRONMENT_REPORT['warning_message']}\n\n用于人景融合工作流的准备节点：把多个人物抠图后按自动颜色、位置、大小和火柴棍姿势标注到背景上，同时输出白底人物色框参考图。"
    )
    SEARCH_ALIASES = ["人景融合准备", "人物位置标注", "火柴棍姿势", "scene fusion prep", "character placement"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("合并图片",)
    OUTPUT_TOOLTIPS = (
        "内部完整执行 Qwen/FireRed 人景融合链路后得到的最终图片。",
    )
    GJJ_HELP = {
        "notice": _ENVIRONMENT_REPORT["help_message"] if not _MODELS_AVAILABLE else "",
        "install_cmd": _ENVIRONMENT_REPORT["install_cmd"],
        "copy_text": _ENVIRONMENT_REPORT["copy_text"],
        "copy_label": _ENVIRONMENT_REPORT["copy_label"],
        "warning_message": _ENVIRONMENT_REPORT["warning_message"],
        "notice_level": _ENVIRONMENT_REPORT["notice_level"],
        "model_download_url": MODEL_DOWNLOAD_URL,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "model_tree": [
            {
                "label": "RMBG1.4 模型",
                "path": "models/RMBG/rmbg1.4.safetensors",
                "folder": "RMBG",
                "filename": "rmbg1.4.safetensors",
                "kind": "background_removal",
                "tooltip": "用于自动去除人物背景，生成白底人物色框参考图。",
            },
            *FUSION_MODEL_TREE,
        ],
        "models": [
            {
                "label": "RMBG1.4 模型",
                "path": "models/RMBG/rmbg1.4.safetensors",
                "folder": "RMBG",
                "kind": "background_removal",
                "tooltip": "用于自动去除人物背景，生成白底人物色框参考图。",
            },
            *FUSION_MODEL_TREE,
        ],
        "usage": [
            "连接背景图和人物 1；人物口可接单张、批量或多图对象，节点会拆成多个人物并按蓝、红、绿、品红、青、黄循环分配颜色。",
            "执行一次后，在节点预览里选中人物，直接拖控制点调整位置、大小、整体方向、肢体姿势和头部十字朝向。",
            "节点只输出合并后的图片；模型、CLIP、VAE、LoRA、编码、采样和解码都在节点内部完成。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 8192,
                        "step": 16,
                        "display_name": "宽度",
                        "tooltip": "输出宽度；0 表示使用背景图宽度，执行时会向下对齐到 16 的倍数。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 8192,
                        "step": 16,
                        "display_name": "高度",
                        "tooltip": "输出高度；0 表示使用背景图高度，执行时会向下对齐到 16 的倍数。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "placement_config": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "人物布局参数",
                        "tooltip": "前端面板维护的人物位置、颜色、大小、朝向和火柴棍姿势 JSON。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "background_fit": (
                    ["裁切填满", "等比留边", "拉伸填满"],
                    {
                        "default": "裁切填满",
                        "display_name": "背景适配",
                        "tooltip": "背景图放入输出画布时的缩放方式。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "device": (
                    ["自动", "GPU", "CPU"],
                    {
                        "default": "自动",
                        "display_name": "设备",
                        "tooltip": "RMBG1.4 推理设备。自动会优先使用 CUDA。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "process_res": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 64,
                        "max": 4096,
                        "step": 64,
                        "display_name": "抠图分辨率",
                        "tooltip": "RMBG1.4 内部推理分辨率。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "mask_blur": (
                    "FLOAT",
                    {
                        "default": 0.8,
                        "min": 0.0,
                        "max": 32.0,
                        "step": 0.1,
                        "display_name": "人物边缘羽化",
                        "tooltip": "人物抠图遮罩羽化，避免白底参考里的边缘太硬。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_FUSION_PROMPT,
                        "multiline": True,
                        "display_name": "融合提示词",
                        "tooltip": "内部 Qwen Image Edit 使用的正向提示词；前端保持隐藏。",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display_name": "负向提示词",
                        "tooltip": "内部 Qwen Image Edit/KSampler 使用的负向提示词。",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xffffffffffffffff,
                        "display_name": "种子",
                        "tooltip": "内部采样种子；可由 GJJ_TemplateParams 广播或外部转换输入覆盖。",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 8,
                        "min": 1,
                        "max": 1000,
                        "display_name": "步数",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": DEFAULT_FUSION_CFG,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display_name": "CFG",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                "sampler_name": (
                    "STRING",
                    {
                        "default": DEFAULT_FUSION_SAMPLER,
                        "display_name": "采样器",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                "scheduler": (
                    "STRING",
                    {
                        "default": DEFAULT_FUSION_SCHEDULER,
                        "display_name": "调度器",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": DEFAULT_FUSION_DENOISE,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                "model_shift": (
                    "FLOAT",
                    {
                        "default": 3.1,
                        "min": -100.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display_name": "AuraFlow Shift",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                "cfg_norm_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display_name": "CFGNorm 强度",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                "cfg_norm_pre_cfg": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "CFGNorm Pre CFG",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                "fusion_unet_name": (
                    "STRING",
                    {"default": DEFAULT_UNET_SEEDS[0], "display_name": "主模型关键词", "tooltip": "锁定主模型关键词；执行时用公共模糊搜索匹配本地文件，支持 GGUF。", "display": "hidden", "hidden": True, "advanced": True},
                ),
                "fusion_unet_dtype": ("STRING", {"default": "default", "display_name": "主模型精度", "display": "hidden", "hidden": True, "advanced": True}),
                "fusion_clip_name": ("STRING", {"default": DEFAULT_CLIP_SEEDS[0], "display_name": "CLIP关键词", "display": "hidden", "hidden": True, "advanced": True}),
                "fusion_clip_dtype": ("STRING", {"default": "default", "display_name": "CLIP精度", "display": "hidden", "hidden": True, "advanced": True}),
                "fusion_vae_name": ("STRING", {"default": DEFAULT_VAE_SEEDS[0], "display_name": "VAE关键词", "display": "hidden", "hidden": True, "advanced": True}),
                "fusion_vae_dtype": ("STRING", {"default": "default", "display_name": "VAE精度", "display": "hidden", "hidden": True, "advanced": True}),
                "fusion_lora_1_name": ("STRING", {"default": DEFAULT_LORA_1_SEEDS[0], "display_name": "LoRA 1关键词", "display": "hidden", "hidden": True, "advanced": True}),
                "fusion_lora_1_strength": ("STRING", {"default": "1", "display_name": "LoRA 1强度", "display": "hidden", "hidden": True, "advanced": True}),
                "fusion_lora_2_name": ("STRING", {"default": DEFAULT_LORA_2_SEEDS[0], "display_name": "LoRA 2关键词", "display": "hidden", "hidden": True, "advanced": True}),
                "fusion_lora_2_strength": ("STRING", {"default": "1.00", "display_name": "LoRA 2强度", "display": "hidden", "hidden": True, "advanced": True}),
                BACKGROUND_UPLOAD_WIDGET: (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "内部背景文件",
                        "tooltip": "🖼️ 按钮写入的内部背景文件名。",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                PERSON_UPLOADS_WIDGET: (
                    "STRING",
                    {
                        "default": "[]",
                        "display_name": "内部人物文件",
                        "tooltip": "👤 按钮写入的内部人物文件列表。",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
                CUTOUT_PREVIEW_WIDGET: (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "仅抠图预览",
                        "tooltip": "前端抠图按钮临时启用；只更新人物抠图卡，不生成火柴棍、白底参考图或执行二阶段采样。",
                        "display": "hidden",
                        "hidden": True,
                        "advanced": True,
                    },
                ),
            },
            "optional": FlexiblePersonInputs(
                {
                    "background": (
                        MEDIA_INPUT_TYPE,
                        {
                            "forceInput": True,
                            "display_name": "背景图",
                            "tooltip": "可选外部背景输入；不连接时使用 🖼️ 按钮在节点内部选择的背景。",
                        },
                    ),
                    "person_01": (
                        MEDIA_INPUT_TYPE,
                        {
                            "forceInput": True,
                            "display_name": "人物",
                            "tooltip": "可选外部人物输入；不连接时使用 👤 按钮在节点内部选择的人物。",
                        },
                    ),
                }
            ),
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        keys = [
            "width",
            "height",
            "placement_config",
            "background_fit",
            "device",
            "process_res",
            "mask_blur",
            "positive_prompt",
            "negative_prompt",
            "seed",
            "steps",
            "cfg",
            "sampler_name",
            "scheduler",
            "denoise",
            "model_shift",
            "cfg_norm_strength",
            "cfg_norm_pre_cfg",
            "fusion_unet_name",
            "fusion_unet_dtype",
            "fusion_clip_name",
            "fusion_clip_dtype",
            "fusion_vae_name",
            "fusion_vae_dtype",
            "fusion_lora_1_name",
            "fusion_lora_1_strength",
            "fusion_lora_2_name",
            "fusion_lora_2_strength",
            BACKGROUND_UPLOAD_WIDGET,
            PERSON_UPLOADS_WIDGET,
            CUTOUT_PREVIEW_WIDGET,
        ]
        parts = [str(_unwrap(kwargs.get(key), "")) for key in keys]
        parts.append(_tensor_signature(_unwrap(kwargs.get("background")), sample_video=False))
        for key in sorted(kwargs.keys()):
            if str(key).startswith("person_") and kwargs.get(key) is not None:
                parts.append(f"{key}:{_tensor_signature(_unwrap(kwargs.get(key)), sample_video=True)}")
        return "|".join(parts)

    def prepare(self, **kwargs):
        background = _unwrap(kwargs.get("background"))
        placement_config = str(_unwrap(kwargs.get("placement_config"), "") or "")
        background_fit = str(_unwrap(kwargs.get("background_fit"), "裁切填满") or "裁切填满")
        device = str(_unwrap(kwargs.get("device"), "自动") or "自动")
        process_res = max(64, _int(_unwrap(kwargs.get("process_res"), 1024), 1024))
        mask_blur = max(0.0, _float(_unwrap(kwargs.get("mask_blur"), 0.8), 0.8))
        cutout_preview_only = _bool(kwargs.get(CUTOUT_PREVIEW_WIDGET), False)
        unique_id = _unwrap(kwargs.get("unique_id"))
        _send_status(unique_id, "读图", 0.02)

        bg_images = _collect_media_images(background, "人景融合准备背景", sample_video=False)
        if not bg_images:
            bg_images = _load_uploaded_images(kwargs.get(BACKGROUND_UPLOAD_WIDGET))
        if not bg_images:
            raise RuntimeError("人景融合准备节点需要背景图。请点击节点内 🖼️ 按钮选择背景，或连接背景输入。")
        requested_width = _int(_unwrap(kwargs.get("width"), 0), 0)
        requested_height = _int(_unwrap(kwargs.get("height"), 0), 0)
        bg_width = int(bg_images[0].width)
        bg_height = int(bg_images[0].height)
        stale_square = requested_width == 2048 and requested_height == 2048 and (bg_width != 2048 or bg_height != 2048)
        width = _align16(bg_width if requested_width <= 0 or stale_square else requested_width)
        height = _align16(bg_height if requested_height <= 0 or stale_square else requested_height)
        _send_status(unique_id, f"尺寸 {width}x{height}", 0.08)
        person_images = _collect_person_images(kwargs)
        if not person_images:
            person_images = _load_uploaded_images(kwargs.get(PERSON_UPLOADS_WIDGET))
        if not person_images:
            raise RuntimeError("人景融合准备节点至少需要 1 张人物图。请点击节点内 👤 按钮选择人物，或连接人物输入。")
        _send_status(unique_id, "读图完成", 0.10)

        bg = _fit_background(bg_images[0], width, height, background_fit, (255, 255, 255))
        config_map = _parse_config(placement_config)
        person_configs: list[dict[str, Any]] = []
        for index in range(len(person_images)):
            person_id = f"person_{index + 1:02d}"
            config = {"id": person_id, **_default_person(index, len(person_images)), **config_map.get(person_id, {})}
            config["id"] = person_id
            config["color"] = _hex(str(config.get("color") or ""), DEFAULT_COLORS[index % len(DEFAULT_COLORS)])
            person_configs.append(config)
        _send_status(unique_id, "布局", 0.18)

        try:
            weight_path = _resolve_model_path(METHOD_RMBG14)
        except Exception as exc:
            raise_dependency_model_error(
                node_name=NODE_DISPLAY_NAME,
                missing_models=[_rmbg14_model_spec()],
                description="人景融合准备节点需要 RMBG1.4 模型才能执行人物去背景。",
                original_error=str(exc),
                unique_id=unique_id,
                title="GJJ 人景融合准备模型缺失！",
                model_download_url=MODEL_DOWNLOAD_URL,
            )

        target_device = _select_device(device)
        _send_status(unique_id, "抠图模型", 0.22)
        model = _load_rmbg14_model(weight_path, target_device)
        _send_status(unique_id, "抠图", 0.28)
        masks = _run_rmbg14_all_masks(model, person_images, target_device, process_res)
        del model
        if target_device == "cuda":
            torch.cuda.empty_cache()
        cutouts: list[Image.Image] = []
        for image, mask in zip(person_images, masks):
            processed = _postprocess_mask_local(mask, 0.0, mask_blur)
            rgba, _ = _make_rgba_and_mask(image, processed)
            cutouts.append(rgba)
        _send_status(unique_id, "抠图完成", 0.36)

        payload_persons = []
        for index, (config, cutout) in enumerate(zip(person_configs, cutouts)):
            payload_persons.append(
                {
                    "id": config["id"],
                    "label": f"人物 {index + 1}",
                    "x": config["x"],
                    "y": config["y"],
                    "scale": config["scale"],
                    "rotation": config["rotation"],
                    "face_angle": config["face_angle"],
                    "color": config["color"],
                    "z": config["z"],
                    "pose": config["pose"],
                    **_save_temp_image(cutout, f"{NODE_NAME}_{config['id']}"),
                }
            )
        placement_payload = {
            "version": 1,
            "persons": [
                {
                    "id": item["id"],
                    "x": item["x"],
                    "y": item["y"],
                    "scale": item["scale"],
                    "rotation": item["rotation"],
                    "face_angle": item["face_angle"],
                    "color": item["color"],
                    "z": item["z"],
                    "pose": item["pose"],
                }
                for item in person_configs
            ],
        }
        if cutout_preview_only:
            payload = {
                "canvas": {"width": width, "height": height, "background_fit": background_fit},
                "background": _save_temp_image(bg, f"{NODE_NAME}_background"),
                "persons": payload_persons,
                "placement_config": placement_payload,
            }
            _send_status(unique_id, "抠图预览完成", 1.0)
            return {"ui": {"gjj_scene_fusion_prep": [payload]}, "result": (_to_tensor(bg),)}

        stick = bg.convert("RGB")
        stick_draw = ImageDraw.Draw(stick)
        for config in sorted(person_configs, key=lambda item: _float(item.get("z"), 0.0)):
            _draw_stick_person(stick_draw, config, width, height)
        _send_status(unique_id, "火柴棍", 0.39)

        white = Image.new("RGBA", (width, height), (255, 255, 255, 255))
        placed_boxes: list[tuple[dict[str, Any], dict[str, int]]] = []
        white_cutouts = [_trim_cutout_alpha(cutout, 0) for cutout in cutouts]
        white_items = list(zip(person_configs, white_cutouts))
        slots = _white_layout_slots(white_cutouts, width, height)
        line_w = max(3, min(10, int(round(height * 0.006))))
        for slot, (config, cutout) in zip(slots, white_items):
            placed_boxes.append((config, _place_cutout_in_slot(white, cutout, slot, line_w, 3)))
        white_rgb = white.convert("RGB")
        white_draw = ImageDraw.Draw(white_rgb)
        for config, box in placed_boxes:
            color = _rgb(str(config.get("color") or "#0000FF"), (0, 0, 255))
            white_draw.rectangle((box["left"], box["top"], box["right"], box["bottom"]), outline=color, width=line_w)
        _send_status(unique_id, "人物拼图", 0.42)

        stick_info = _save_temp_image(stick, f"{NODE_NAME}_stick")
        white_info = _save_temp_image(white_rgb, f"{NODE_NAME}_white")
        output_a = _load_temp_tensor(stick_info)
        output_b = _load_temp_tensor(white_info)

        output_c = _generate_fusion_image(output_a, output_b, kwargs)

        payload = {
            "canvas": {"width": width, "height": height, "background_fit": background_fit},
            "background": _save_temp_image(bg, f"{NODE_NAME}_background"),
            "stick": stick_info,
            "white": white_info,
            "persons": payload_persons,
            "placement_config": placement_payload,
        }
        _send_status(unique_id, "完成", 1.0)
        return {"ui": {"gjj_scene_fusion_prep": [payload]}, "result": (output_c,)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SceneFusionPrep}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧍 人景融合准备"}
