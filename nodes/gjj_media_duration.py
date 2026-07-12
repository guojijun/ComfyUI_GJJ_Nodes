from __future__ import annotations

import math
from typing import Any


NODE_NAME = "GJJ_MediaDuration"
MEDIA_INPUT_TYPE = "VIDEO,AUDIO"


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except Exception:
        return default
    return result if math.isfinite(result) else default


def _shape_length(value: Any) -> int:
    shape = getattr(value, "shape", None)
    if not shape:
        return 0
    try:
        return int(shape[0])
    except Exception:
        return 0


def _last_shape_length(value: Any) -> int:
    shape = getattr(value, "shape", None)
    if not shape:
        return 0
    try:
        return int(shape[-1])
    except Exception:
        return 0


def _stored_duration(value: Any) -> float:
    for key in ("duration", "duration_seconds", "seconds"):
        duration = _as_float(_component_value(value, key), 0.0)
        if duration > 0:
            return duration
    return 0.0


def _audio_duration(value: Any) -> float:
    if value is None:
        return 0.0
    stored = _stored_duration(value)
    if stored > 0:
        return stored
    waveform = _component_value(value, "waveform")
    sample_rate = _as_float(_component_value(value, "sample_rate"), 0.0)
    samples = _last_shape_length(waveform)
    if samples > 0 and sample_rate > 0:
        return float(samples) / sample_rate
    return 0.0


def _video_components(value: Any) -> Any:
    getter = getattr(value, "get_components", None)
    if callable(getter):
        return getter()
    return value


def _video_frame_rate(value: Any, components: Any) -> float:
    fps = _as_float(_component_value(components, "frame_rate"), 0.0)
    if fps <= 0:
        for key in ("fps", "source_fps", "framerate"):
            fps = _as_float(_component_value(components, key), 0.0)
            if fps > 0:
                break
    if fps <= 0:
        getter = getattr(value, "get_frame_rate", None)
        if callable(getter):
            fps = _as_float(getter(), 0.0)
    return fps


def _video_duration(value: Any) -> float:
    stored = _stored_duration(value)
    if stored > 0:
        return stored

    components = _video_components(value)
    stored = _stored_duration(components)
    if stored > 0:
        return stored

    frames = _component_value(components, "images")
    frame_count = _shape_length(frames)
    fps = _video_frame_rate(value, components)
    if frame_count > 0 and fps > 0:
        return float(frame_count) / fps

    return _audio_duration(_component_value(components, "audio"))


class GJJ_MediaDuration:
    """读取 VIDEO 或 AUDIO 的时长，输出秒数。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "media": (
                    MEDIA_INPUT_TYPE,
                    {
                        "display_name": "媒体",
                        "tooltip": "连接 VIDEO 或 AUDIO，输出媒体时长（秒）。",
                    },
                ),
            }
        }

    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("时长",)
    OUTPUT_TOOLTIPS = ("媒体时长，单位为秒。",)
    FUNCTION = "measure"
    CATEGORY = "GJJ/媒体"
    DESCRIPTION = "输入 VIDEO 或 AUDIO，输出时长（秒）。"

    def measure(self, media):
        duration = _audio_duration(media)
        if duration <= 0:
            duration = _video_duration(media)
        if duration <= 0:
            raise RuntimeError("无法从输入的 VIDEO/AUDIO 中读取时长。")
        return (float(duration),)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_MediaDuration,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "⏱️ 媒体时长",
}
