from __future__ import annotations

from typing import Any

import torch


NODE_NAME = "GJJ_MediaFrameCount"
MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value: Any) -> Any:
    if not hasattr(value, "get_components"):
        return None
    try:
        return value.get_components()
    except Exception:
        return None


def _count_tensor_frames(value: torch.Tensor) -> int:
    if value.ndim <= 0:
        return 0
    if value.ndim == 3:
        return 1
    return max(0, int(value.shape[0]))


def _frame_count(value: Any) -> int:
    if value is None:
        return 0

    components = _video_components(value)
    if components is not None:
        images = _component_value(components, "images")
        if isinstance(images, torch.Tensor):
            return _count_tensor_frames(images)
        frame_count = _component_value(components, "frame_count")
        if frame_count is not None:
            try:
                return max(0, int(frame_count))
            except Exception:
                pass

    if isinstance(value, torch.Tensor):
        return _count_tensor_frames(value)

    if isinstance(value, dict):
        for key in ("images", "frames", "samples"):
            count = _frame_count(value.get(key))
            if count > 0:
                return count
        for key in ("frame_count", "num_frames", "count"):
            raw = value.get(key)
            if raw is not None:
                try:
                    return max(0, int(raw))
                except Exception:
                    pass

    images = getattr(value, "images", None)
    if isinstance(images, torch.Tensor):
        return _count_tensor_frames(images)

    if isinstance(value, (list, tuple)):
        if not value:
            return 0
        total = 0
        for item in value:
            count = _frame_count(item)
            total += count if count > 0 else 1
        return total

    return 0


class GJJ_MediaFrameCount:
    CATEGORY = "GJJ/视频"
    FUNCTION = "count_frames"
    DESCRIPTION = "获取图片批次、视频帧序列或 VIDEO 的帧数量。"
    SEARCH_ALIASES = ["帧数量", "视频数量", "图片序列数量", "frame count", "video frame count"]
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("数量",)
    OUTPUT_TOOLTIPS = ("输入视频或帧序列的帧数量。",)

    GJJ_HELP = {
        "title": "获取视频/帧序列数量",
        "description": "读取 GJJ_BATCH_IMAGE、IMAGE 批次或官方 VIDEO 中的帧数量，并输出 INT。",
        "usage": [
            "连接图片批次、帧序列或 VIDEO 到输入口。",
            "执行后输入口标签会显示为“视频/帧序列（数量）”。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "media": (
                    MEDIA_TYPE,
                    {
                        "display_name": "视频/帧序列",
                        "tooltip": "支持 GJJ_BATCH_IMAGE、IMAGE 批次和官方 VIDEO。",
                    },
                ),
            },
        }

    def count_frames(self, media):
        count = _frame_count(media)
        return {"ui": {"frame_count": [count]}, "result": (count,)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MediaFrameCount}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔢 视频帧数量"}
