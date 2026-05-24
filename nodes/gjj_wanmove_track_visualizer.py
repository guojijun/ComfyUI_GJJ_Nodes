import base64
import io
import json
import math

import numpy as np
from PIL import Image


NODE_NAME = "GJJ_WanMoveTrackVisualizer"


DEFAULT_TRACKS = [[{"x": 160, "y": 360}, {"x": 460, "y": 300}]]
DEFAULT_TRACKS_JSON = json.dumps(DEFAULT_TRACKS, ensure_ascii=False, separators=(",", ":"))


def _coerce_int(value, fallback=1):
    try:
        return max(1, int(round(float(value))))
    except Exception:
        return int(fallback)


def _coerce_point(value):
    if not isinstance(value, dict):
        return None
    try:
        return {"x": int(round(float(value.get("x", 0)))), "y": int(round(float(value.get("y", 0))))}
    except Exception:
        return None


def _dist(a, b):
    return math.hypot(float(a["x"]) - float(b["x"]), float(a["y"]) - float(b["y"]))


def _resample_track(points, frame_count):
    target = _coerce_int(frame_count, 81)
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
        span = max(1e-6, lengths[right_index] - lengths[left_index])
        ratio = max(0.0, min(1.0, (distance - lengths[left_index]) / span))
        left = points[left_index]
        right = points[right_index]
        result.append({
            "x": int(round(float(left["x"]) + (float(right["x"]) - float(left["x"])) * ratio)),
            "y": int(round(float(left["y"]) + (float(right["y"]) - float(left["y"])) * ratio)),
        })
    return result


def _normalize_tracks(raw, frame_count, width=None, height=None):
    try:
        data = json.loads(str(raw or ""))
    except Exception:
        data = DEFAULT_TRACKS
    source_width = None
    source_height = None
    if isinstance(data, dict) and isinstance(data.get("tracks"), list):
        source_width = data.get("width")
        source_height = data.get("height")
        data = data["tracks"]
    if isinstance(data, list) and data and isinstance(data[0], dict):
        data = [data]
    if not isinstance(data, list):
        data = DEFAULT_TRACKS

    try:
        scale_x = float(width) / float(source_width) if width and source_width and float(source_width) > 0 else 1.0
    except Exception:
        scale_x = 1.0
    try:
        scale_y = float(height) / float(source_height) if height and source_height and float(source_height) > 0 else 1.0
    except Exception:
        scale_y = 1.0

    tracks = []
    for track in data:
        if not isinstance(track, list):
            continue
        points = [_coerce_point(item) for item in track]
        points = [point for point in points if point is not None]
        if scale_x != 1.0 or scale_y != 1.0:
            points = [
                {"x": int(round(point["x"] * scale_x)), "y": int(round(point["y"] * scale_y))}
                for point in points
            ]
        if points:
            tracks.append(_resample_track(points, frame_count))
    return tracks or [_resample_track(DEFAULT_TRACKS[0], frame_count)]


def _safe_wan_length(length):
    requested = _coerce_int(length, 81)
    def processed_len(value):
        num_frames = max(0, int(value) - 1)
        if num_frames <= 0:
            return 1
        divisor = math.gcd(120, num_frames)
        step = 120 // divisor
        repeat = num_frames // divisor
        repeated_len = 120 * repeat
        sampled_len = 0 if repeated_len <= 1 else ((repeated_len - 2) // step) + 1
        return 1 + sampled_len
    def required_len(value):
        latent_t = ((max(1, int(value)) - 1) // 4) + 1
        return 1 + 4 * (latent_t - 1)
    if processed_len(requested) == required_len(requested):
        return requested
    for candidate in range(requested + 1, 4097):
        if (candidate - 1) % 4 == 0 and processed_len(candidate) == required_len(candidate):
            return candidate
    for candidate in range(requested - 1, 0, -1):
        if (candidate - 1) % 4 == 0 and processed_len(candidate) == required_len(candidate):
            return candidate
    return 81


def _tracks_dict(tracks, track_mask=None):
    try:
        import torch
        track_list = [
            [[track[frame]["x"], track[frame]["y"]] for track in tracks]
            for frame in range(len(tracks[0]))
        ]
        track = torch.tensor(track_list, dtype=torch.float32)
        visibility = torch.ones((track.shape[0], track.shape[1]), dtype=torch.bool)
        if track_mask is not None:
            mask = track_mask.detach().cpu() if hasattr(track_mask, "detach") else torch.as_tensor(track_mask)
            if mask.ndim == 2:
                mask = mask.unsqueeze(0)
            visible = (mask > 0).any(dim=tuple(range(1, mask.ndim))).bool()
            if visible.numel() > 0:
                if visible.shape[0] < track.shape[0]:
                    visible = torch.cat([visible, visible[-1:].repeat(track.shape[0] - visible.shape[0])], dim=0)
                visibility = visible[:track.shape[0]].unsqueeze(1).repeat(1, track.shape[1])
        return {"track_path": track, "track_visibility": visibility}
    except Exception:
        return {"track_path": tracks, "track_visibility": None}


def _image_to_base64(image):
    if image is None:
        return None
    try:
        tensor = image[0] if getattr(image, "ndim", 0) == 4 else image
        array = tensor.detach().cpu().numpy() if hasattr(tensor, "detach") else np.asarray(tensor)
        array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
        pil_image = Image.fromarray(array[..., :3], mode="RGB")
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG")
        return base64.b64encode(buffer.getvalue()).decode("utf-8")
    except Exception:
        return None


class GJJWanMoveTrackVisualizer:
    RETURN_TYPES = ("TRACKS", "STRING", "INT")
    RETURN_NAMES = ("WanMove轨道", "轨迹JSON", "Wan安全长度")
    OUTPUT_TOOLTIPS = (
        "WanMoveWrapper 风格 TRACKS 字典。",
        "可直接连接 WanTrackToVideo tracks 输入的 JSON 字符串。",
        "可连接 WanTrackToVideo length 的安全帧长。",
    )
    FUNCTION = "build"
    CATEGORY = "GJJ/视频"
    OUTPUT_NODE = True
    DESCRIPTION = "网站式 WanMove 轨迹可视化生成器。可拖拽起点、终点和贝塞尔控制点，输出轨迹 JSON 与 TRACKS。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 720, "min": 16, "max": 8192, "step": 1, "display_name": "宽度", "tooltip": "轨迹坐标参考宽度。"}),
                "height": ("INT", {"default": 480, "min": 16, "max": 8192, "step": 1, "display_name": "高度", "tooltip": "轨迹坐标参考高度。"}),
                "frame_count": ("INT", {"default": 81, "min": 1, "max": 4096, "step": 1, "display_name": "轨迹长度", "tooltip": "每条轨迹输出的点数。"}),
                "tracks_json": ("STRING", {"default": DEFAULT_TRACKS_JSON, "multiline": True, "display": "hidden", "hidden": True, "display_name": "轨迹JSON存储", "tooltip": "前端面板自动维护。"}),
            },
            "optional": {
                "image": ("IMAGE", {"display_name": "参考图片", "tooltip": "可选背景图。点击刷新后会显示在面板。"}),
                "track_mask": ("MASK", {"display_name": "轨道遮罩", "tooltip": "可选。用于生成 TRACKS 可见性。"}),
            },
        }

    def build(self, width, height, frame_count, tracks_json, image=None, track_mask=None):
        tracks = _normalize_tracks(tracks_json, frame_count, width, height)
        text = json.dumps(tracks, ensure_ascii=False, separators=(",", ":"))
        result = (_tracks_dict(tracks, track_mask), text, _safe_wan_length(frame_count))
        preview = _image_to_base64(image)
        if preview:
            return {"ui": {"bg_image": [preview]}, "result": result}
        return result


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJWanMoveTrackVisualizer}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🏂 可视化运动轨迹（WanMove）"}
