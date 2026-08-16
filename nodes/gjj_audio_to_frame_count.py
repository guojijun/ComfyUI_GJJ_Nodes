from __future__ import annotations

import math
from typing import Any


NODE_NAME = "GJJ_AudioToFrameCount"


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
    """读取 AUDIO 时长（秒），与 GJJ_MediaDuration 保持一致。"""
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


class GJJ_AudioToFrameCount:
    """根据音频时长和帧率计算所需帧数：int(音频时长 * 帧率 + 1)。"""

    CATEGORY = "GJJ/🛠️ 工具/媒体"
    FUNCTION = "execute"
    DESCRIPTION = "输入 AUDIO 与目标帧率，输出帧数 = int(音频时长 × 帧率 + 1)。"
    SEARCH_ALIASES = ["音频转帧数", "audio to frames", "音频时长转帧数", "帧数计算"]
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("帧数",)
    OUTPUT_TOOLTIPS = ("音频时长 × 帧率 + 1 后取整。",)

    GJJ_HELP = {
        "title": "音频转帧数",
        "description": "根据 AUDIO 时长与目标帧率计算所需帧数，常用于音频驱动视频生成。",
        "usage": [
            "连接 AUDIO 到输入口。",
            "设置目标帧率（默认 24）。",
            "输出帧数 = int(音频时长 × 帧率 + 1)。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": (
                    "AUDIO",
                    {
                        "display_name": "音频",
                        "tooltip": "连接 AUDIO，根据其时长计算所需帧数。",
                    },
                ),
                "frame_rate": (
                    "INT",
                    {
                        "default": 24,
                        "min": 1,
                        "max": 120,
                        "step": 1,
                        "display_name": "帧率",
                        "tooltip": "目标视频帧率，默认 24。",
                    },
                ),
            }
        }

    def execute(self, audio, frame_rate):
        fps = int(frame_rate)
        if fps <= 0:
            raise RuntimeError("帧率必须为正整数。")
        duration = _audio_duration(audio)
        if duration <= 0:
            raise RuntimeError("无法从输入的 AUDIO 中读取时长，请确认输入为有效音频。")
        frame_count = int(duration * fps + 1)
        return (frame_count,)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_AudioToFrameCount,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "🎵 音频转帧数",
}
