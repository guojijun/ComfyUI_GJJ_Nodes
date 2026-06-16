from __future__ import annotations

import json
import math
import uuid
from pathlib import Path
from typing import Any

import torch
from PIL import Image, ImageColor, ImageDraw, ImageFilter

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


NODE_NAME = "GJJ_SceneFusionPrep"
NODE_DISPLAY_NAME = "GJJ · 🧍 人景融合准备"
PREVIEW_SUBFOLDER = "GJJ/scene_fusion_prep"

DEFAULT_COLORS = (
    "#0000FF",
    "#FF0000",
    "#00FF00",
    "#FF00FF",
    "#00FFFF",
    "#FFFF00",
)

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
        filename="rmbg1.4.pth",
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


def _resample_lanczos():
    return getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)


def _save_temp_image(image: Image.Image, prefix: str) -> dict[str, Any]:
    target_dir = Path(folder_paths.get_temp_directory()) / PREVIEW_SUBFOLDER
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{prefix}_{uuid.uuid4().hex[:12]}.png"
    image.save(target_dir / filename, format="PNG")
    return {
        "filename": filename,
        "subfolder": PREVIEW_SUBFOLDER,
        "type": "temp",
        "format": "image/png",
        "media_type": "image",
        "width": int(image.width),
        "height": int(image.height),
    }


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
            "pose": _normalize_ik_pose({**DEFAULT_POSE, **clean_pose}),
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


def _white_layout_slots(count: int, canvas_w: int, canvas_h: int) -> list[tuple[int, int, int, int]]:
    count = max(1, int(count or 1))
    columns = count
    rows = 1
    slots: list[tuple[int, int, int, int]] = []
    margin = max(8, int(round(min(canvas_w, canvas_h) * 0.025)))
    for index in range(count):
        col = index % columns
        row = index // columns
        left = int(round(col * canvas_w / columns)) + margin
        top = int(round(row * canvas_h / rows)) + margin
        right = int(round((col + 1) * canvas_w / columns)) - margin
        bottom = int(round((row + 1) * canvas_h / rows)) - margin
        slots.append((left, top, max(left + 1, right), max(top + 1, bottom)))
    return slots


def _place_cutout_in_slot(canvas: Image.Image, cutout: Image.Image, slot: tuple[int, int, int, int]) -> dict[str, int]:
    left, top, right, bottom = slot
    slot_w = max(1, right - left)
    slot_h = max(1, bottom - top)
    ratio = min(slot_w / max(1, cutout.width), slot_h / max(1, cutout.height))
    target_w = max(1, int(round(cutout.width * ratio)))
    target_h = max(1, int(round(cutout.height * ratio)))
    layer = cutout.convert("RGBA").resize((target_w, target_h), _resample_lanczos())
    paste_left = left + (slot_w - target_w) // 2
    paste_top = top + (slot_h - target_h) // 2
    _paste_rgba(canvas, layer, paste_left, paste_top)
    return {"left": paste_left, "top": paste_top, "right": paste_left + target_w, "bottom": paste_top + target_h}


def _to_tensor(image: Image.Image) -> torch.Tensor:
    return _pil_list_to_tensor([image.convert("RGB")]).contiguous()


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
    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("背景火柴棍标注图", "白底人物色框图")
    OUTPUT_TOOLTIPS = (
        "背景图上叠加带颜色的人物火柴棍、面部朝向十字和色框，用作后续人景融合的场景位置/姿势参考。",
        "白色背景上按相同位置合成人物抠图，并给每个人物添加同色方框，用作角色外观和颜色编号参考。",
    )
    GJJ_HELP = {
        "notice": _ENVIRONMENT_REPORT["help_message"] if not _MODELS_AVAILABLE else "",
        "install_cmd": _ENVIRONMENT_REPORT["install_cmd"],
        "copy_text": _ENVIRONMENT_REPORT["copy_text"],
        "copy_label": _ENVIRONMENT_REPORT["copy_label"],
        "warning_message": _ENVIRONMENT_REPORT["warning_message"],
        "notice_level": _ENVIRONMENT_REPORT["notice_level"],
        "model_download_url": MODEL_DOWNLOAD_URL,
        "models": [
            {
                "label": "RMBG1.4 模型",
                "path": "models/RMBG/rmbg1.4.pth",
                "folder": "RMBG",
                "kind": "background_removal",
                "tooltip": "用于自动去除人物背景，生成白底人物色框参考图。",
            }
        ],
        "usage": [
            "连接背景图和人物 1；人物口可接单张、批量或多图对象，节点会拆成多个人物并按蓝、红、绿、品红、青、黄循环分配颜色。",
            "执行一次后，在节点预览里选中人物，直接拖控制点调整位置、大小、整体方向、肢体姿势和头部十字朝向。",
            "第一个输出接给场景/ControlNet/融合参考，第二个输出接给人物外观参考或多参考图输入。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "background": (
                    MEDIA_INPUT_TYPE,
                    {
                        "display_name": "背景图",
                        "tooltip": "最终场景背景；节点会使用第一张图片，并按画布尺寸适配。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 16,
                        "max": 8192,
                        "step": 16,
                        "display_name": "宽度",
                        "tooltip": "输出准备图宽度；执行时会向下对齐到 16 的倍数。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 16,
                        "max": 8192,
                        "step": 16,
                        "display_name": "高度",
                        "tooltip": "输出准备图高度；执行时会向下对齐到 16 的倍数。",
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
            },
            "optional": FlexiblePersonInputs(
                {
                    "person_01": (
                        MEDIA_INPUT_TYPE,
                        {
                            "forceInput": True,
                            "display_name": "人物 1",
                            "tooltip": "第 1 组需要标注和抠图的人物；可接单张、批量或多图对象，节点会拆成多个人物并自动分配颜色。连接后前端会自动扩展人物 2。",
                        },
                    )
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
        ]
        parts = [str(_unwrap(kwargs.get(key), "")) for key in keys]
        parts.append(_tensor_signature(_unwrap(kwargs.get("background")), sample_video=False))
        for key in sorted(kwargs.keys()):
            if str(key).startswith("person_") and kwargs.get(key) is not None:
                parts.append(f"{key}:{_tensor_signature(_unwrap(kwargs.get(key)), sample_video=True)}")
        return "|".join(parts)

    def prepare(self, **kwargs):
        background = _unwrap(kwargs.get("background"))
        width = _align16(_int(_unwrap(kwargs.get("width"), 1024), 1024))
        height = _align16(_int(_unwrap(kwargs.get("height"), 1024), 1024))
        placement_config = str(_unwrap(kwargs.get("placement_config"), "") or "")
        background_fit = str(_unwrap(kwargs.get("background_fit"), "裁切填满") or "裁切填满")
        device = str(_unwrap(kwargs.get("device"), "自动") or "自动")
        process_res = max(64, _int(_unwrap(kwargs.get("process_res"), 1024), 1024))
        mask_blur = max(0.0, _float(_unwrap(kwargs.get("mask_blur"), 0.8), 0.8))
        unique_id = _unwrap(kwargs.get("unique_id"))

        bg_images = _collect_media_images(background, "人景融合准备背景", sample_video=False)
        if not bg_images:
            raise RuntimeError("人景融合准备节点需要连接背景图。")
        person_images = _collect_person_images(kwargs)
        if not person_images:
            raise RuntimeError("人景融合准备节点至少需要连接 1 张人物图。")

        bg = _fit_background(bg_images[0], width, height, background_fit, (255, 255, 255))
        config_map = _parse_config(placement_config)
        person_configs: list[dict[str, Any]] = []
        for index in range(len(person_images)):
            person_id = f"person_{index + 1:02d}"
            config = {"id": person_id, **_default_person(index, len(person_images)), **config_map.get(person_id, {})}
            config["id"] = person_id
            config["color"] = DEFAULT_COLORS[index % len(DEFAULT_COLORS)]
            person_configs.append(config)

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
        model = _load_rmbg14_model(weight_path, target_device)
        masks = _run_rmbg14_all_masks(model, person_images, target_device, process_res)
        cutouts: list[Image.Image] = []
        for image, mask in zip(person_images, masks):
            processed = _postprocess_mask_local(mask, 0.0, mask_blur)
            rgba, _ = _make_rgba_and_mask(image, processed)
            cutouts.append(rgba)

        stick = bg.convert("RGB")
        stick_draw = ImageDraw.Draw(stick)
        for config in sorted(person_configs, key=lambda item: _float(item.get("z"), 0.0)):
            _draw_stick_person(stick_draw, config, width, height)

        white = Image.new("RGBA", (width, height), (255, 255, 255, 255))
        placed_boxes: list[tuple[dict[str, Any], dict[str, int]]] = []
        white_items = list(zip(person_configs, cutouts))
        slots = _white_layout_slots(len(white_items), width, height)
        for slot, (config, cutout) in zip(slots, white_items):
            placed_boxes.append((config, _place_cutout_in_slot(white, cutout, slot)))
        white_rgb = white.convert("RGB")
        white_draw = ImageDraw.Draw(white_rgb)
        for config, box in placed_boxes:
            color = _rgb(str(config.get("color") or "#0000FF"), (0, 0, 255))
            line_w = max(5, int(round(height * 0.01)))
            white_draw.rectangle((box["left"], box["top"], box["right"], box["bottom"]), outline=color, width=line_w)

        output_a = _to_tensor(stick)
        output_b = _to_tensor(white_rgb)

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

        payload = {
            "canvas": {"width": width, "height": height, "background_fit": background_fit},
            "background": _save_temp_image(bg, f"{NODE_NAME}_background"),
            "stick": _save_temp_image(stick, f"{NODE_NAME}_stick"),
            "white": _save_temp_image(white_rgb, f"{NODE_NAME}_white"),
            "persons": payload_persons,
            "placement_config": {
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
            },
        }
        return {"ui": {"gjj_scene_fusion_prep": [payload]}, "result": (output_a, output_b)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SceneFusionPrep}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧍 人景融合准备"}
