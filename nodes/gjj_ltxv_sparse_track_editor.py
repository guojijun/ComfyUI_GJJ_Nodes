from __future__ import annotations

import base64
import json
from io import BytesIO
from typing import Any

import numpy as np
import torch
from PIL import Image


NODE_NAME = "GJJ_LTXVSparseTrackEditor"
NODE_DISPLAY_NAME = "GJJ · 🧭 LTX稀疏轨迹编辑器"


def _catmull_rom(p0: dict, p1: dict, p2: dict, p3: dict, t: float) -> dict[str, float]:
    t2 = t * t
    t3 = t2 * t
    return {
        "x": 0.5
        * (
            2 * p1["x"]
            + (-p0["x"] + p2["x"]) * t
            + (2 * p0["x"] - 5 * p1["x"] + 4 * p2["x"] - p3["x"]) * t2
            + (-p0["x"] + 3 * p1["x"] - 3 * p2["x"] + p3["x"]) * t3
        ),
        "y": 0.5
        * (
            2 * p1["y"]
            + (-p0["y"] + p2["y"]) * t
            + (2 * p0["y"] - 5 * p1["y"] + 4 * p2["y"] - p3["y"]) * t2
            + (-p0["y"] + 3 * p1["y"] - 3 * p2["y"] + p3["y"]) * t3
        ),
    }


def _interpolate_spline(control_points: list[dict], num_samples: int) -> list[dict[str, int]]:
    """Catmull-Rom spline interpolation matching the frontend logic."""
    num_samples = max(2, int(num_samples))
    if len(control_points) == 0:
        return []
    if len(control_points) == 1:
        p = control_points[0]
        return [{"x": round(float(p["x"])), "y": round(float(p["y"]))} for _ in range(num_samples)]
    if len(control_points) == 2:
        a, b = control_points
        return [
            {
                "x": round(float(a["x"]) + (float(b["x"]) - float(a["x"])) * i / (num_samples - 1)),
                "y": round(float(a["y"]) + (float(b["y"]) - float(a["y"])) * i / (num_samples - 1)),
            }
            for i in range(num_samples)
        ]

    pts = [control_points[0], *control_points, control_points[-1]]
    n_seg = len(pts) - 3
    result = []
    for i in range(num_samples):
        g_t = (i / (num_samples - 1)) * n_seg
        seg = min(int(g_t), n_seg - 1)
        l_t = g_t - seg
        p = _catmull_rom(pts[seg], pts[seg + 1], pts[seg + 2], pts[seg + 3], l_t)
        result.append({"x": round(p["x"]), "y": round(p["y"])})
    return result


def _safe_json_loads(raw: Any, fallback: Any) -> Any:
    try:
        return json.loads(raw) if raw else fallback
    except (json.JSONDecodeError, TypeError, ValueError):
        return fallback


def _image_to_jpeg_base64(image: torch.Tensor) -> str:
    if image is None or not torch.is_tensor(image) or image.ndim != 4 or image.shape[0] < 1:
        raise RuntimeError("LTX稀疏轨迹编辑器失败：必须输入至少一帧 IMAGE。")
    img_array = (image[0].detach().cpu().clamp(0, 1).numpy() * 255).astype(np.uint8)
    img = Image.fromarray(img_array)
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=75)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


class GJJ_LTXVSparseTrackEditor:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "参考图像",
                        "tooltip": "显示在轨迹编辑画布里的背景图，通常接 LTX 运动轨迹参考帧。",
                    },
                ),
                "points_store": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": False,
                        "display_name": "控制点存储",
                        "tooltip": "前端画布保存的样条控制点 JSON；面板中会自动隐藏。",
                    },
                ),
                "coordinates": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": False,
                        "display_name": "轨迹坐标缓存",
                        "tooltip": "前端画布同步生成的插值轨迹 JSON；面板中会自动隐藏。",
                    },
                ),
                "points_to_sample": (
                    "INT",
                    {
                        "default": 121,
                        "min": 2,
                        "max": 10000,
                        "step": 1,
                        "display_name": "采样点数",
                        "tooltip": "每条样条曲线输出多少个轨迹点。修改后后端会重新插值，确保输出一致。",
                    },
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("轨迹JSON",)
    OUTPUT_TOOLTIPS = ("LTX 稀疏轨迹 JSON，格式为多条 point-list，每个点包含 x/y。",)
    FUNCTION = "execute"
    CATEGORY = "GJJ/视频模型/LTX"
    OUTPUT_NODE = True
    DESCRIPTION = "一比一复刻 LTX Sparse Track Editor：在参考图上交互编辑稀疏运动轨迹，并输出可给 LTX 轨迹绘制/控制节点使用的 JSON。"
    GJJ_HELP = {
        "title": "LTX稀疏轨迹编辑器",
        "description": "GJJ 零外部节点依赖版 SparseTrackEditor。后端负责保存控制点、重新插值轨迹，并把参考图发送给前端画布。",
        "usage": [
            "右键画布可添加点、新建样条、细分线段或删除点。",
            "拖动控制点调整运动轨迹；输出为轨迹 JSON 字符串。",
            "采样点数会影响每条轨迹输出长度，适合与视频帧数保持一致。",
        ],
    }

    def execute(self, image, points_store="[]", coordinates="[]", points_to_sample=121):
        splines = _safe_json_loads(points_store, [])
        sample_count = max(2, int(points_to_sample or 121))

        if splines and isinstance(splines, list) and isinstance(splines[0], list):
            interpolated = [_interpolate_spline(sp, sample_count) for sp in splines]
            tracks = json.dumps(interpolated, ensure_ascii=False)
        elif coordinates and coordinates != "[]":
            tracks = str(coordinates)
        else:
            tracks = "[]"

        img_b64 = _image_to_jpeg_base64(image)
        return {"ui": {"bg_image": [img_b64]}, "result": (tracks,)}


def _parse_tracks(raw: str) -> list[list[dict]]:
    """Parse tracks from a JSON string, handling nested/wrapped formats."""
    parsed = json.loads(raw) if isinstance(raw, str) else raw

    if isinstance(parsed, list):
        unwrapped = []
        for item in parsed:
            unwrapped.append(json.loads(item) if isinstance(item, str) else item)
        parsed = unwrapped

    tracks: list[list[dict]] = []
    stack = [parsed]
    while stack:
        obj = stack.pop()
        if isinstance(obj, list) and len(obj) > 0:
            if isinstance(obj[0], dict) and "x" in obj[0] and "y" in obj[0]:
                tracks.append(obj)
            else:
                stack.extend(obj)
    return tracks


def _age_color_batch(ratios: torch.Tensor, device: torch.device) -> torch.Tensor:
    """Vectorised age-ratio -> RGB [0..1] mapping on GPU."""
    colors = torch.zeros(ratios.shape[0], 3, device=device)

    m1 = ratios <= 1 / 3
    tr1 = ratios[m1] * 3
    colors[m1, 1] = tr1
    colors[m1, 2] = 1 - tr1

    m2 = (ratios > 1 / 3) & (ratios <= 2 / 3)
    tr2 = (ratios[m2] - 1 / 3) * 3
    colors[m2, 0] = tr2
    colors[m2, 1] = 1

    m3 = ratios > 2 / 3
    tr3 = (ratios[m3] - 2 / 3) * 3
    colors[m3, 0] = 1
    colors[m3, 1] = 1 - tr3

    return colors


def _render_resolution(width: int, height: int, reference_short_side: int):
    """Compute the higher render resolution that preserves aspect ratio."""
    if height <= width:
        rw = int(width * reference_short_side / height)
        rh = reference_short_side
    else:
        rw = reference_short_side
        rh = int(height * reference_short_side / width)
    scale_x = rw / width
    scale_y = rh / height
    return rw, rh, scale_x, scale_y


_MIN_RADIUS = 2
_MAX_RADIUS = 8
_MAX_TRAIL = 50
_REF_SHORT_SIDE = 1080


def _rasterise_circles(
    frame: torch.Tensor,
    pts: torch.Tensor,
    radii: torch.Tensor,
    colors: torch.Tensor,
    template_dist_sq: torch.Tensor,
    half_d: int,
    max_d: int,
    height: int,
    width: int,
) -> None:
    """Stamp filled circles onto frame fully on-device."""
    count = pts.shape[0]
    if count == 0:
        return
    device = pts.device

    radii_sq = (radii * radii).view(count, 1, 1)
    circle_masks = template_dist_sq.unsqueeze(0) <= radii_sq

    cx = pts[:, 0].round().long().view(count, 1, 1)
    cy = pts[:, 1].round().long().view(count, 1, 1)
    offsets_y = torch.arange(max_d, device=device).sub(half_d).view(1, max_d, 1)
    offsets_x = torch.arange(max_d, device=device).sub(half_d).view(1, 1, max_d)
    fy = (cy + offsets_y).expand(count, max_d, max_d)
    fx = (cx + offsets_x).expand(count, max_d, max_d)

    valid = circle_masks & (fy >= 0) & (fy < height) & (fx >= 0) & (fx < width)

    flat_fy = fy[valid]
    flat_fx = fx[valid]
    flat_lin = (flat_fy * width + flat_fx).long()

    j_map = torch.arange(count, device=device, dtype=torch.float32).view(count, 1, 1)
    j_map = j_map.expand_as(valid)
    flat_j = j_map[valid]

    priority = torch.full((height * width,), -1.0, device=device)
    priority.scatter_reduce_(0, flat_lin, flat_j, reduce="amax", include_self=False)
    priority = priority.view(height, width).long()

    has_circle = priority >= 0
    frame[has_circle] = colors[priority[has_circle]]


class GJJ_LTXVDrawTracks:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "tracks": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": False,
                        "display_name": "轨迹JSON",
                        "tooltip": "轨迹坐标 JSON，格式为多条 point-list，每个点包含 x/y。可直接连接 LTX稀疏轨迹编辑器输出。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 512,
                        "min": 8,
                        "max": 8192,
                        "step": 8,
                        "display_name": "输出宽度",
                        "tooltip": "轨迹渲染图的输出宽度，单位像素。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 512,
                        "min": 8,
                        "max": 8192,
                        "step": 8,
                        "display_name": "输出高度",
                        "tooltip": "轨迹渲染图的输出高度，单位像素。",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("轨迹图像",)
    OUTPUT_TOOLTIPS = ("按 LTX IC-LoRA 训练数据格式生成的稀疏轨迹图像序列。",)
    FUNCTION = "execute"
    CATEGORY = "GJJ/视频模型/LTX"
    DESCRIPTION = "一比一复刻 LTX Draw Sparse Tracks：把稀疏轨迹 JSON 渲染成 LTX 可用的轨迹图像序列。"
    GJJ_HELP = {
        "title": "LTX轨迹绘制",
        "description": "GJJ 零外部节点依赖版 LTXVDrawTracks。使用原版 GPU 光栅化逻辑绘制彩色拖尾轨迹。",
        "usage": [
            "轨迹JSON可直接连接 GJJ · 🧭 LTX稀疏轨迹编辑器。",
            "输出帧数等于轨迹中最长点列表长度。",
            "空轨迹时输出一张黑色图。",
        ],
    }

    def execute(self, tracks: str, width: int = 512, height: int = 512):
        width = max(8, min(8192, int(width or 512)))
        height = max(8, min(8192, int(height or 512)))
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        parsed = _parse_tracks(tracks)
        if not parsed:
            blank = torch.zeros(1, height, width, 3, device=device, dtype=torch.float16)
            return (blank,)

        num_tracks = len(parsed)
        num_frames = max(len(track) for track in parsed)
        render_width, render_height, scale_x, scale_y = _render_resolution(width, height, _REF_SHORT_SIDE)

        point_xy = torch.zeros(num_tracks, num_frames, 2, device=device)
        visibility = torch.zeros(num_tracks, num_frames, dtype=torch.bool, device=device)
        for i, track in enumerate(parsed):
            coords = torch.tensor(
                [[float(p["x"]) * scale_x, float(p["y"]) * scale_y] for p in track],
                dtype=torch.float32,
                device=device,
            )
            point_xy[i, : len(track)] = coords
            visibility[i, : len(track)] = True

        max_d = 2 * _MAX_RADIUS + 3
        half_d = max_d // 2
        offsets = torch.arange(max_d, device=device) - half_d
        oy, ox = torch.meshgrid(offsets, offsets, indexing="ij")
        template_dist_sq = oy.float().square() + ox.float().square()

        render_frames = torch.zeros(num_frames, render_height, render_width, 3, device=device)

        for frame_index in range(num_frames):
            tau_min = max(0, frame_index - _MAX_TRAIL)
            window = frame_index - tau_min + 1

            active_xy = point_xy[:, tau_min : frame_index + 1]
            active_visibility = visibility[:, tau_min : frame_index + 1]

            ages = torch.arange(window - 1, -1, -1, device=device, dtype=torch.float32)
            ratios = 1.0 - ages / _MAX_TRAIL
            radii = _MIN_RADIUS + (_MAX_RADIUS - _MIN_RADIUS) * ratios
            colors = _age_color_batch(ratios, device)

            flat_xy = active_xy.reshape(-1, 2)
            flat_visibility = active_visibility.reshape(-1)
            flat_radii = radii.unsqueeze(0).expand(num_tracks, -1).reshape(-1)
            flat_colors = colors.unsqueeze(0).expand(num_tracks, -1, -1).reshape(-1, 3)

            idx = flat_visibility.nonzero(as_tuple=True)[0]
            if idx.shape[0] == 0:
                continue

            pts = flat_xy[idx]
            point_radii = flat_radii[idx]
            point_colors = flat_colors[idx]

            flat_ages = ages.unsqueeze(0).expand(num_tracks, -1).reshape(-1)
            sort_order = flat_ages[idx].argsort(descending=True)
            pts = pts[sort_order]
            point_radii = point_radii[sort_order]
            point_colors = point_colors[sort_order]

            _rasterise_circles(
                render_frames[frame_index],
                pts,
                point_radii,
                point_colors,
                template_dist_sq,
                half_d,
                max_d,
                render_height,
                render_width,
            )

        out = torch.nn.functional.interpolate(
            render_frames.permute(0, 3, 1, 2),
            size=(height, width),
            mode="bilinear",
            align_corners=False,
        ).permute(0, 2, 3, 1)

        out = out[..., [2, 1, 0]]
        return (out.half(),)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_LTXVSparseTrackEditor,
    "GJJ_LTXVDrawTracks": GJJ_LTXVDrawTracks,
    "LTXVDrawTracks": GJJ_LTXVDrawTracks,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
    "GJJ_LTXVDrawTracks": "GJJ · 🧵 LTX稀疏轨迹绘制",
    "LTXVDrawTracks": "GJJ · 🧵 LTX稀疏轨迹绘制",
}
