from __future__ import annotations

from typing import Any

import torch


NODE_NAME = "GJJ_ImageSize"
MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value: Any) -> dict[str, Any] | None:
    if not hasattr(value, "get_components"):
        return None
    try:
        components = value.get_components()
    except Exception:
        return None
    if isinstance(components, dict):
        return components
    return {
        "images": _component_value(components, "images"),
        "width": _component_value(components, "width"),
        "height": _component_value(components, "height"),
        "frame_rate": _component_value(components, "frame_rate"),
    }


def _positive_int(value: Any) -> int:
    try:
        number = int(round(float(str(value).strip())))
    except Exception:
        return 0
    return number if number > 0 else 0


def _shape_size(tensor: torch.Tensor) -> tuple[int, int] | None:
    if tensor.ndim == 2:
        return int(tensor.shape[1]), int(tensor.shape[0])
    if tensor.ndim == 3:
        if int(tensor.shape[-1]) in (1, 2, 3, 4):
            return int(tensor.shape[1]), int(tensor.shape[0])
        if int(tensor.shape[0]) in (1, 2, 3, 4):
            return int(tensor.shape[2]), int(tensor.shape[1])
    if tensor.ndim >= 4:
        if int(tensor.shape[-1]) in (1, 2, 3, 4):
            return int(tensor.shape[2]), int(tensor.shape[1])
        if int(tensor.shape[1]) in (1, 2, 3, 4):
            return int(tensor.shape[3]), int(tensor.shape[2])
    return None


def _media_size(value: Any) -> tuple[int, int]:
    if isinstance(value, torch.Tensor):
        size = _shape_size(value)
        if size:
            return size

    components = _video_components(value)
    if components is not None:
        width = _positive_int(components.get("width"))
        height = _positive_int(components.get("height"))
        if width > 0 and height > 0:
            return width, height
        images = components.get("images")
        if isinstance(images, torch.Tensor):
            size = _shape_size(images)
            if size:
                return size

    if isinstance(value, dict):
        width = _positive_int(value.get("width") or value.get("w"))
        height = _positive_int(value.get("height") or value.get("h"))
        if width > 0 and height > 0:
            return width, height
        for key in ("images", "image", "frames", "samples"):
            candidate = value.get(key)
            if isinstance(candidate, torch.Tensor):
                size = _shape_size(candidate)
                if size:
                    return size

    for key in ("images", "image", "frames", "samples"):
        candidate = getattr(value, key, None)
        if isinstance(candidate, torch.Tensor):
            size = _shape_size(candidate)
            if size:
                return size

    raise RuntimeError(
        f"获取图像尺寸失败：输入不是有效的 GJJ_BATCH_IMAGE / IMAGE / VIDEO：{type(value).__name__}。"
    )


class GJJ_ImageSize:
    CATEGORY = "GJJ/图像"
    FUNCTION = "get_size"
    DESCRIPTION = "获取图片、批量图片或官方 VIDEO 的首帧宽度和高度。"
    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("宽度", "高度")
    OUTPUT_TOOLTIPS = ("输入媒体的像素宽度。", "输入媒体的像素高度。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "media": (
                    MEDIA_TYPE,
                    {
                        "display_name": "图片或视频",
                        "tooltip": "支持 GJJ_BATCH_IMAGE、普通 IMAGE/IMAGE batch 和官方 VIDEO；输出首帧宽度与高度。",
                    },
                ),
            },
        }

    def get_size(self, media=None, **kwargs):
        if media is None:
            media = kwargs.get("图片或视频")
        if media is None:
            media = kwargs.get("image")
        if media is None:
            media = kwargs.get("video")
        if media is None:
            ui = {
                "width": [0],
                "height": [0],
                "size": ["未连接"],
            }
            return {"ui": ui, "result": (0, 0)}
        width, height = _media_size(media)
        ui = {
            "width": [int(width)],
            "height": [int(height)],
            "size": [f"{int(width)}x{int(height)}"],
        }
        return {"ui": ui, "result": (int(width), int(height))}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageSize}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📐 获取图像尺寸"}
