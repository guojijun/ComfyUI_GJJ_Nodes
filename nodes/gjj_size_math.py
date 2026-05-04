from __future__ import annotations

from typing import Any

import comfy.utils
import torch
from nodes import MAX_RESOLUTION


NODE_NAME = "GJJ_SizeMath"
MAX_IMAGES = 12
DEFAULT_ALIGN_MULTIPLE = 32
ASPECT_RATIO_OPTIONS = [
    "1:1",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
    "16:9",
    "9:16",
    "21:9",
    "9:21",
    "5:4",
    "4:5",
]
SIZE_MODE_OPTIONS = ["直接指定", "按长边缩放", "按短边缩放"]
ROTATION_MODE_OPTIONS = ["不旋转", "顺时针90°", "逆时针90°", "180°"]
OUTPUT_SIZE_MODE_OPTIONS = ["当前尺寸", "宽高和", "最大宽高", "最小宽高"]


class FlexibleSizeMathInputType(dict):
    def __init__(self, data: dict[str, Any] | None = None):
        super().__init__()
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        text = str(key or "")
        if text.startswith("image_"):
            return (
                "IMAGE",
                {
                    "display_name": f"图片 {int(text.split('_')[-1])}",
                    "tooltip": "多张图片会自动扩展输入插槽，并参与尺寸统计运算。",
                },
            )
        raise KeyError(key)

    def __contains__(self, key):
        text = str(key or "")
        return key in self.data or text.startswith("image_")


def _normalize_int(value: Any, fallback: int, minimum: int = 1) -> int:
    try:
        resolved = int(value)
    except Exception:
        resolved = int(fallback)
    return max(minimum, resolved)


def _resolve_image_size(image: Any) -> tuple[int, int] | None:
    shape = getattr(image, "shape", None)
    if not shape:
        return None
    try:
        dims = [int(item) for item in shape]
    except Exception:
        return None
    if len(dims) < 3:
        return None
    height = dims[-3]
    width = dims[-2]
    if width <= 0 or height <= 0:
        return None
    return width, height


def _collect_images(kwargs: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen_indices: set[int] = set()
    for key, value in kwargs.items():
        text = str(key or "")
        if not text.startswith("image_"):
            continue
        try:
            index = int(text.split("_")[-1])
        except Exception:
            continue
        if index in seen_indices:
            continue
        size = _resolve_image_size(value)
        if value is None or size is None:
            continue
        seen_indices.add(index)
        items.append(
            {
                "index": index,
                "image": value,
                "width": size[0],
                "height": size[1],
                "area": size[0] * size[1],
            }
        )
    items.sort(key=lambda item: item["index"])
    return items[:MAX_IMAGES]


def _scale_from_edge(width: int, height: int, edge: int, by_long_edge: bool) -> tuple[int, int]:
    if width <= 0 or height <= 0:
        return edge, edge
    base_edge = max(width, height) if by_long_edge else min(width, height)
    if base_edge <= 0:
        return edge, edge
    factor = float(edge) / float(base_edge)
    scaled_width = max(1, int(round(width * factor)))
    scaled_height = max(1, int(round(height * factor)))
    return scaled_width, scaled_height


def _align_size(width: int, height: int, multiple: int) -> tuple[int, int]:
    safe_multiple = max(1, int(multiple))
    if safe_multiple == 1:
        return max(1, width), max(1, height)
    aligned_width = max(safe_multiple, int(round(width / safe_multiple)) * safe_multiple)
    aligned_height = max(safe_multiple, int(round(height / safe_multiple)) * safe_multiple)
    return aligned_width, aligned_height


def _apply_rotation(width: int, height: int, rotation_mode: str) -> tuple[int, int]:
    text = str(rotation_mode or "")
    if "90" in text and "180" not in text:
        return height, width
    return width, height


def _blank_image(width: int, height: int):
    safe_width = max(8, int(width))
    safe_height = max(8, int(height))
    return torch.zeros((1, safe_height, safe_width, 3), dtype=torch.float32)


def _resize_image(image: Any, width: int, height: int):
    if image is None:
        return _blank_image(width, height)
    safe_width = max(1, int(width))
    safe_height = max(1, int(height))
    if tuple(getattr(image, "shape", ()))[:1] == (0,):
        return _blank_image(safe_width, safe_height)
    samples = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(samples, safe_width, safe_height, "lanczos", "disabled")
    return resized.movedim(1, -1)


def _rotate_image_tensor(image: Any, rotation_mode: str):
    if image is None:
        return image
    text = str(rotation_mode or "")
    if text == "顺时针90°":
        return torch.rot90(image, k=3, dims=(1, 2))
    if text == "逆时针90°":
        return torch.rot90(image, k=1, dims=(1, 2))
    if text == "180°":
        return torch.rot90(image, k=2, dims=(1, 2))
    return image


def _process_output_image(image: Any, width: int, height: int, rotation_mode: str, align_multiple: int):
    resized = _resize_image(image, width, height)
    rotated = _rotate_image_tensor(resized, rotation_mode)
    rotated_size = _resolve_image_size(rotated)
    if rotated_size is None:
        final_width, final_height = _align_size(width, height, align_multiple)
        return _blank_image(final_width, final_height)
    final_width, final_height = _align_size(rotated_size[0], rotated_size[1], align_multiple)
    if rotated_size[0] == final_width and rotated_size[1] == final_height:
        return rotated
    return _resize_image(rotated, final_width, final_height)


class GJJ_SizeMath:
    CATEGORY = "GJJ"
    FUNCTION = "calculate"
    DESCRIPTION = "获取一张或多张图片尺寸，执行长边缩放、短边缩放、旋转和比例预设计算，并输出尺寸统计结果。"
    SEARCH_ALIASES = [
        "size math",
        "size adjust",
        "resize",
        "尺寸",
        "宽高",
        "分辨率",
        "长边",
        "短边",
        "图片尺寸统计",
    ]
    RETURN_TYPES = ("INT", "INT", "IMAGE", "IMAGE")
    RETURN_NAMES = ("输出目标宽度", "输出目标高度", "最大面积图片", "最小面积图片")
    OUTPUT_TOOLTIPS = (
        "根据输出尺寸模式最终决定的宽度。",
        "根据输出尺寸模式最终决定的高度。",
        "输入图片中面积最大的图片；无图片时输出一张黑色占位图。",
        "输入图片中面积最小的图片；无图片时输出一张黑色占位图。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "aspect_ratio": (
                    ASPECT_RATIO_OPTIONS,
                    {
                        "default": "1:1",
                        "display_name": "比例",
                        "tooltip": "底部横向、纵向、短边和官方推荐尺寸按钮会基于这个比例直接写入宽高。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 1,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "宽度",
                        "tooltip": "默认或按钮设置后的宽度；接入图片后前端会优先同步成第一张图片宽度。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 1,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "高度",
                        "tooltip": "默认或按钮设置后的高度；接入图片后前端会优先同步成第一张图片高度。",
                    },
                ),
                "size_mode": (
                    SIZE_MODE_OPTIONS,
                    {
                        "default": "直接指定",
                        "display_name": "尺寸模式",
                        "tooltip": "直接指定会直接输出当前宽高；按长边或短边缩放会基于第一张图片或输入尺寸计算。",
                    },
                ),
                "edge_length": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 1,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "目标边长",
                        "tooltip": "长边或短边缩放模式下，指定目标长边或目标短边长度。",
                    },
                ),
                "rotation_mode": (
                    ROTATION_MODE_OPTIONS,
                    {
                        "default": "不旋转",
                        "display_name": "旋转",
                        "tooltip": "对最终尺寸执行旋转换算；90° 与 270° 会交换宽高。",
                    },
                ),
                "align_multiple": (
                    "INT",
                    {
                        "default": DEFAULT_ALIGN_MULTIPLE,
                        "min": 1,
                        "max": 256,
                        "step": 1,
                        "display_name": "对齐倍数",
                        "tooltip": "把最终宽高对齐到指定倍数；默认 32，节点内部计算会始终按这里输入的倍数对齐。",
                    },
                ),
                "output_size_mode": (
                    OUTPUT_SIZE_MODE_OPTIONS,
                    {
                        "default": "当前尺寸",
                        "display_name": "输出尺寸",
                        "tooltip": "决定右侧宽度和高度输出使用当前计算尺寸，还是多图统计后的宽高和、最大宽高或最小宽高。",
                    },
                ),
            },
            "optional": FlexibleSizeMathInputType(
                {
                    "image_01": (
                        "IMAGE",
                        {
                            "display_name": "图片 1",
                        "tooltip": "第一张输入图；接入后会自动扩展新的图片输入插槽。",
                        },
                    ),
                }
            ),
        }

    @classmethod
    def IS_CHANGED(cls, aspect_ratio, width, height, size_mode, edge_length, rotation_mode, align_multiple, output_size_mode, **kwargs):
        images = _collect_images(kwargs)
        return "|".join(
            [
                str(aspect_ratio),
                str(width),
                str(height),
                str(size_mode),
                str(edge_length),
                str(rotation_mode),
                str(align_multiple),
                str(output_size_mode),
                ";".join(f"{item['index']}:{item['width']}x{item['height']}" for item in images),
            ]
        )

    def calculate(self, aspect_ratio, width, height, size_mode, edge_length, rotation_mode, align_multiple, output_size_mode, **kwargs):
        resolved_width = _normalize_int(width, width, minimum=1)
        resolved_height = _normalize_int(height, height, minimum=1)
        images = _collect_images(kwargs)

        if images:
            source_width = images[0]["width"]
            source_height = images[0]["height"]
        else:
            source_width = resolved_width
            source_height = resolved_height

        safe_edge_length = _normalize_int(edge_length, min(source_width, source_height), minimum=1)
        mode_text = str(size_mode or "直接指定")
        if mode_text == "按长边缩放":
            output_width, output_height = _scale_from_edge(source_width, source_height, safe_edge_length, True)
        elif mode_text == "按短边缩放":
            output_width, output_height = _scale_from_edge(source_width, source_height, safe_edge_length, False)
        else:
            output_width, output_height = source_width, source_height
        aligned_multiple = _normalize_int(align_multiple, DEFAULT_ALIGN_MULTIPLE, minimum=1)
        processed_image_width = output_width
        processed_image_height = output_height

        output_width, output_height = _apply_rotation(output_width, output_height, rotation_mode)
        output_width, output_height = _align_size(
            output_width,
            output_height,
            aligned_multiple,
        )

        if images:
            width_sum = sum(item["width"] for item in images)
            height_sum = sum(item["height"] for item in images)
            max_width = max(item["width"] for item in images)
            max_height = max(item["height"] for item in images)
            min_width = min(item["width"] for item in images)
            min_height = min(item["height"] for item in images)
            max_image_item = max(images, key=lambda item: (item["area"], item["width"], item["height"], -item["index"]))
            min_image_item = min(images, key=lambda item: (item["area"], item["width"], item["height"], item["index"]))
            max_image = _process_output_image(
                max_image_item["image"],
                processed_image_width,
                processed_image_height,
                rotation_mode,
                aligned_multiple,
            )
            min_image = _process_output_image(
                min_image_item["image"],
                processed_image_width,
                processed_image_height,
                rotation_mode,
                aligned_multiple,
            )
        else:
            width_sum = source_width
            height_sum = source_height
            max_width = source_width
            max_height = source_height
            min_width = source_width
            min_height = source_height
            max_image = _blank_image(output_width, output_height)
            min_image = _blank_image(output_width, output_height)

        output_mode = str(output_size_mode or "当前尺寸")
        if output_mode == "宽高和":
            final_width, final_height = width_sum, height_sum
        elif output_mode == "最大宽高":
            final_width, final_height = max_width, max_height
        elif output_mode == "最小宽高":
            final_width, final_height = min_width, min_height
        else:
            final_width, final_height = output_width, output_height

        return {
            "ui": {
                "source_width": [source_width],
                "source_height": [source_height],
                "resolved_width": [final_width],
                "resolved_height": [final_height],
                "aspect_ratio": [str(aspect_ratio or "1:1")],
                "short_edge": [min(final_width, final_height)],
                "long_edge": [max(final_width, final_height)],
                "image_count": [len(images)],
                "width_sum": [width_sum],
                "height_sum": [height_sum],
                "max_width": [max_width],
                "min_width": [min_width],
                "output_size_mode": [output_mode],
            },
            "result": (
                final_width,
                final_height,
                max_image,
                min_image,
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SizeMath}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📐 尺寸获取与运算"}
