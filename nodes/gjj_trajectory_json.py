import json
import math
import base64
import io

import numpy as np
from PIL import Image


NODE_NAME = "GJJ_TrajectoryJSON"

DEFAULT_TRAJECTORY = [[
    {"x": 393, "y": 126},
    {"x": 393, "y": 126},
    {"x": 388, "y": 123},
    {"x": 372, "y": 122},
    {"x": 312, "y": 121},
    {"x": 263, "y": 123},
    {"x": 226, "y": 137},
    {"x": 226, "y": 142},
    {"x": 252, "y": 149},
    {"x": 307, "y": 153},
    {"x": 367, "y": 165},
    {"x": 448, "y": 175},
    {"x": 523, "y": 181},
    {"x": 590, "y": 187},
    {"x": 625, "y": 192},
    {"x": 632, "y": 218},
]]

DEFAULT_TRAJECTORY_JSON = json.dumps(DEFAULT_TRAJECTORY, ensure_ascii=False, separators=(",", ":"))


def _dist(a, b):
    return ((float(a["x"]) - float(b["x"])) ** 2 + (float(a["y"]) - float(b["y"])) ** 2) ** 0.5


def _coerce_point(value):
    if not isinstance(value, dict):
        return None
    try:
        x = int(round(float(value.get("x", 0))))
        y = int(round(float(value.get("y", 0))))
    except (TypeError, ValueError):
        return None
    return {"x": x, "y": y}


def _resample_track(points, frame_count):
    target = max(1, int(frame_count or 1))
    if not points:
        return [{"x": 0, "y": 0} for _ in range(target)]
    if len(points) == 1:
        return [dict(points[0]) for _ in range(target)]
    if len(points) == target:
        return [dict(point) for point in points]

    lengths = [0.0]
    for index in range(1, len(points)):
        lengths.append(lengths[-1] + _dist(points[index - 1], points[index]))

    total = lengths[-1]
    if total <= 1e-6:
        return [dict(points[0]) for _ in range(target)]

    result = []
    src_index = 1
    for out_index in range(target):
        distance = total * out_index / max(1, target - 1)
        while src_index < len(lengths) - 1 and lengths[src_index] < distance:
            src_index += 1
        left_index = max(0, src_index - 1)
        right_index = min(src_index, len(points) - 1)
        left_distance = lengths[left_index]
        right_distance = lengths[right_index]
        span = max(1e-6, right_distance - left_distance)
        ratio = max(0.0, min(1.0, (distance - left_distance) / span))
        left = points[left_index]
        right = points[right_index]
        result.append({
            "x": int(round(float(left["x"]) + (float(right["x"]) - float(left["x"])) * ratio)),
            "y": int(round(float(left["y"]) + (float(right["y"]) - float(left["y"])) * ratio)),
        })

    return result


def _looks_like_point(value):
    return isinstance(value, dict) and "x" in value and "y" in value


def _extract_tracks(data):
    if not isinstance(data, list):
        return DEFAULT_TRAJECTORY

    if data and all(_looks_like_point(item) for item in data):
        return [data]

    if data and all(isinstance(track, list) and track and all(_looks_like_point(item) for item in track) for track in data):
        return data

    if data and all(isinstance(batch, list) for batch in data):
        tracks = []
        for batch in data:
            if not isinstance(batch, list):
                continue
            for track in batch:
                if isinstance(track, list) and track and all(_looks_like_point(item) for item in track):
                    tracks.append(track)
        if tracks:
            return tracks

    return DEFAULT_TRAJECTORY


def _normalize_tracks(raw, frame_count=121):
    try:
        data = json.loads(str(raw or ""))
    except Exception:
        data = DEFAULT_TRAJECTORY

    tracks = _extract_tracks(data)

    normalized_tracks = []
    for track in tracks:
        if not isinstance(track, list):
            continue
        points = []
        for item in track:
            point = _coerce_point(item)
            if point is not None:
                points.append(point)
        if points:
            normalized_tracks.append(points)

    frame_count = max(1, int(frame_count or 121))
    if not normalized_tracks:
        normalized_tracks = [[{"x": 0, "y": 0}]]

    return [_resample_track(track, frame_count) for track in normalized_tracks]


def _normalize_trajectory_json(raw, frame_count=121):
    tracks = _normalize_tracks(raw, frame_count)
    return json.dumps(tracks, ensure_ascii=False, separators=(",", ":"))


def _wan_processed_len(length):
    num_frames = max(0, int(length) - 1)
    if num_frames <= 0:
        return 1
    divisor = math.gcd(120, num_frames)
    step = 120 // divisor
    repeat = num_frames // divisor
    repeated_len = 120 * repeat
    sampled_len = 0 if repeated_len <= 1 else ((repeated_len - 2) // step) + 1
    return 1 + sampled_len


def _wan_required_track_len(length):
    latent_t = ((max(1, int(length)) - 1) // 4) + 1
    return 1 + 4 * (latent_t - 1)


def _safe_wan_length(length):
    requested = max(1, int(length or 81))
    if _wan_processed_len(requested) == _wan_required_track_len(requested):
        return requested

    candidate = requested
    while candidate <= 4096:
        candidate += 1
        if (candidate - 1) % 4 == 0 and _wan_processed_len(candidate) == _wan_required_track_len(candidate):
            return candidate

    candidate = requested
    while candidate > 1:
        candidate -= 1
        if (candidate - 1) % 4 == 0 and _wan_processed_len(candidate) == _wan_required_track_len(candidate):
            return candidate

    return 81


def _image_to_base64(image):
    if image is None:
        return None
    try:
        tensor = image[0] if getattr(image, "ndim", 0) == 4 else image
        array = tensor.detach().cpu().numpy() if hasattr(tensor, "detach") else np.asarray(tensor)
        array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
        if array.ndim == 2:
            pil_image = Image.fromarray(array, mode="L").convert("RGB")
        elif array.shape[-1] == 4:
            pil_image = Image.fromarray(array, mode="RGBA").convert("RGB")
        else:
            pil_image = Image.fromarray(array[..., :3], mode="RGB")
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG")
        return base64.b64encode(buffer.getvalue()).decode("utf-8")
    except Exception:
        return None


class GJJTrajectoryJSON:
    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("轨迹JSON", "Wan安全长度")
    OUTPUT_TOOLTIPS = (
        "标准轨迹字符串，格式为 [[{\"x\":整数,\"y\":整数},...]]。",
        "连接到 WanTrackToVideo 的 length。会把 121 这类官方会 reshape 报错的长度自动改为安全值。",
    )
    FUNCTION = "build"
    CATEGORY = "GJJ/实用工具"
    OUTPUT_NODE = True
    DESCRIPTION = "图形化编辑二维轨迹，并输出可直接连接其它节点的 Trajectory JSON 字符串。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "canvas_width": (
                    "INT",
                    {
                        "default": 512,
                        "min": 16,
                        "max": 8192,
                        "step": 1,
                        "display_name": "画布宽度",
                        "tooltip": "轨迹坐标的参考宽度；图形面板会按这个宽度显示网格。",
                    },
                ),
                "canvas_height": (
                    "INT",
                    {
                        "default": 512,
                        "min": 16,
                        "max": 8192,
                        "step": 1,
                        "display_name": "画布高度",
                        "tooltip": "轨迹坐标的参考高度；图形面板会按这个高度显示网格。",
                    },
                ),
                "frame_count": (
                    "INT",
                    {
                        "default": 121,
                        "min": 1,
                        "max": 4096,
                        "step": 1,
                        "display_name": "轨迹采样点数",
                        "tooltip": "输出时把每条轨迹重采样到固定点数。可用时长×帧率+1 输入；如果要接 WanTrackToVideo 的 length，请使用本节点的 Wan安全长度输出。",
                    },
                ),
                "trajectory_json": (
                    "STRING",
                    {
                        "default": DEFAULT_TRAJECTORY_JSON,
                        "multiline": True,
                        "display_name": "轨迹JSON",
                        "tooltip": "内部序列化字段，由图形轨迹面板自动维护。",
                    },
                ),
            },
            "optional": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "参考图片",
                        "tooltip": "可选参考图输入。前端会优先尝试读取上游预览作为轨迹背景；后端只输出轨迹 JSON。",
                    },
                ),
            },
        }

    def build(self, canvas_width, canvas_height, frame_count, trajectory_json, image=None):
        result = (_normalize_trajectory_json(trajectory_json, frame_count), _safe_wan_length(frame_count))
        preview = _image_to_base64(image)
        if preview:
            return {"ui": {"bg_image": [preview]}, "result": result}
        return result


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJTrajectoryJSON,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "GJJ · 🧭 轨迹JSON生成",
}
