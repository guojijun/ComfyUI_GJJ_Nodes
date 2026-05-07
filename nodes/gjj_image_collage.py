from __future__ import annotations

import math
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageColor, ImageDraw, ImageFont

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE

NODE_NAME = "GJJ_ImageCollage"


def _image_input(index: int):
    return (
        "IMAGE",
        {
            "display_name": f"图片 {index}",
            "tooltip": f"第 {index} 路图片输入；支持单张图片或 IMAGE 批次。",
        },
    )


class FlexibleCollageInputType(dict):
    """允许图片拼版接收动态数量的单张 IMAGE 输入。"""

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
            index = _extract_image_index(text)
            return _image_input(index if index < 999999 else 1)
        raise KeyError(key)

    def __contains__(self, key):
        text = str(key or "")
        return key in self.data or text.startswith("image_")


def _hex_color(value: str, fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    try:
        return ImageColor.getrgb(str(value).strip())
    except Exception:
        return fallback


def _background_rgba(value: str, fallback: tuple[int, int, int]) -> tuple[int, int, int, int]:
    text = str(value or "").strip().lower()
    if text in ("transparent", "透明", "none", "alpha"):
        return (0, 0, 0, 0)
    rgb = _hex_color(value, fallback)
    return (int(rgb[0]), int(rgb[1]), int(rgb[2]), 255)


def _flatten_images(images: list[Any]) -> list[torch.Tensor]:
    result: list[torch.Tensor] = []
    for value in images:
        if value is None or not isinstance(value, torch.Tensor):
            continue
        batch = value if value.ndim == 4 else value.unsqueeze(0)
        for i in range(int(batch.shape[0])):
            result.append(batch[i : i + 1].clamp(0, 1))
    return result


def _extract_image_index(name: str) -> int:
    text = str(name or "")
    if not text.startswith("image_"):
        return 999999
    try:
        return int(text[6:])
    except Exception:
        return 999999


def _fit_image(image: torch.Tensor, cell_w: int, cell_h: int, fit_mode: str, bg_rgba: tuple[int, int, int, int]) -> Image.Image:
    h = int(image.shape[1])
    w = int(image.shape[2])
    pil = _tensor_to_pil(image)
    if fit_mode == "拉伸填满":
        return pil.resize((cell_w, cell_h), Image.Resampling.LANCZOS).convert("RGBA")

    ratio = max(cell_w / max(w, 1), cell_h / max(h, 1)) if fit_mode == "裁切填满" else min(cell_w / max(w, 1), cell_h / max(h, 1))
    new_w = max(1, int(round(w * ratio)))
    new_h = max(1, int(round(h * ratio)))
    resized = pil.resize((new_w, new_h), Image.Resampling.LANCZOS)

    if fit_mode == "裁切填满":
        left = max(0, (new_w - cell_w) // 2)
        top = max(0, (new_h - cell_h) // 2)
        return resized.crop((left, top, left + cell_w, top + cell_h)).convert("RGBA")

    canvas = Image.new("RGBA", (cell_w, cell_h), bg_rgba)
    resized = resized.convert("RGBA")
    canvas.alpha_composite(resized, ((cell_w - new_w) // 2, (cell_h - new_h) // 2))
    return canvas


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    if image.ndim == 4:
        image = image[0]
    array = (image.detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    if array.shape[-1] == 1:
        array = np.repeat(array, 3, axis=-1)
    if array.shape[-1] == 4:
        return Image.fromarray(array, mode="RGBA")
    return Image.fromarray(array, mode="RGB").convert("RGBA")


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    array = np.asarray(image.convert("RGBA")).astype(np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("msyh.ttc", "simhei.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, max(8, int(size)))
        except Exception:
            pass
    return ImageFont.load_default()


def _labels(text: str) -> list[str]:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    if "\n" in raw:
        return [part.strip() for part in raw.split("\n")]
    if "," in raw:
        return [part.strip() for part in raw.split(",")]
    return [raw.strip()] if raw.strip() else []


def _draw_label(canvas: Image.Image, box: tuple[int, int, int, int], text: str, font_size: int, align: str, text_rgb: tuple[int, int, int]) -> None:
    if not text:
        return
    draw = ImageDraw.Draw(canvas)
    font = _font(font_size)
    left, top, right, bottom = box
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    pad = max(6, int(font_size * 0.3))
    if align == "居中":
        x = left + (right - left - tw) // 2
    elif align == "右对齐":
        x = right - tw - pad
    else:
        x = left + pad
    y = bottom - th - pad
    shadow = (0, 0, 0)
    draw.text((x + 1, y + 1), text, fill=shadow, font=font)
    draw.text((x, y), text, fill=text_rgb, font=font)


class GJJ_ImageCollage:
    CATEGORY = "GJJ/Image"
    FUNCTION = "collage"
    DESCRIPTION = "把多路图片或图片批次拼成横排、竖排或自动网格，适合对比图、参考图和结果展示。"
    SEARCH_ALIASES = ["collage", "layout", "grid", "拼版", "拼图", "对比图", "图片布局"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("拼版图像",)
    OUTPUT_TOOLTIPS = ("按当前布局参数合成后的单张图像；输入或背景包含透明时会保留 RGBA 通道。",)

    @classmethod
    def INPUT_TYPES(cls):
        optional = FlexibleCollageInputType(
            {
                "batch_image": (
                    GJJ_BATCH_IMAGE_TYPE,
                    {
                        "display_name": "批量图片",
                        "tooltip": "可直接接入 GJJ 专用批量图片队列；会按批次顺序参与拼版。",
                    },
                ),
                "image_01": _image_input(1),
            }
        )
        return {
            "required": {
                "layout": (
                    ["自动网格", "横向排列", "纵向排列"],
                    {"default": "自动网格", "display_name": "布局方式", "tooltip": "选择图片拼接方向；自动网格会按接近正方形的行列排布。"},
                ),
                "cell_mode": (
                    ["按最长边", "固定宽高"],
                    {"default": "按最长边", "display_name": "单格尺寸模式", "tooltip": "按最长边会保持每张图比例并统一最长边；固定宽高会先放入统一画格。"},
                ),
                "cell_size": (
                    "INT",
                    {"default": 512, "min": 16, "max": 4096, "step": 8, "display_name": "单格最长边", "tooltip": "单格尺寸模式为按最长边时使用。"},
                ),
                "cell_width": (
                    "INT",
                    {"default": 512, "min": 16, "max": 4096, "step": 8, "display_name": "单格宽度", "tooltip": "单格尺寸模式为固定宽高时使用。"},
                ),
                "cell_height": (
                    "INT",
                    {"default": 512, "min": 16, "max": 4096, "step": 8, "display_name": "单格高度", "tooltip": "单格尺寸模式为固定宽高时使用。"},
                ),
                "fit_mode": (
                    ["等比留边", "裁切填满", "拉伸填满"],
                    {"default": "等比留边", "display_name": "图片适配", "tooltip": "图片放入单格时的缩放方式。"},
                ),
                "gap": (
                    "INT",
                    {"default": 8, "min": 0, "max": 256, "step": 1, "display_name": "间距", "tooltip": "图片单格之间的像素间距。"},
                ),
                "background": (
                    "STRING",
                    {"default": "#111820", "display_name": "背景颜色", "tooltip": "拼版背景色，支持 #RRGGBB、常见颜色名或“透明”。"},
                ),
                "labels": (
                    "STRING",
                    {"default": "", "multiline": True, "display_name": "标签文本", "tooltip": "每行或逗号分隔一个标签，会按图片顺序绘制在单格底部。"},
                ),
                "font_size": (
                    "INT",
                    {"default": 28, "min": 8, "max": 160, "step": 1, "display_name": "标签字号", "tooltip": "标签文字字号。"},
                ),
                "label_align": (
                    ["左对齐", "居中", "右对齐"],
                    {"default": "左对齐", "display_name": "标签对齐", "tooltip": "标签在单格底部的水平对齐方式。"},
                ),
                "label_color": (
                    "STRING",
                    {"default": "#FFFFFF", "display_name": "标签颜色", "tooltip": "标签文字颜色。"},
                ),
            },
            "optional": optional,
        }

    def collage(
        self,
        layout: str,
        cell_mode: str,
        cell_size: int,
        cell_width: int,
        cell_height: int,
        fit_mode: str,
        gap: int,
        background: str,
        labels: str,
        font_size: int,
        label_align: str,
        label_color: str,
        **kwargs,
    ):
        ordered_inputs: list[Any] = []
        batch_image = kwargs.get("batch_image")
        if batch_image is not None:
            ordered_inputs.append(batch_image)
        for key in sorted(kwargs.keys(), key=_extract_image_index):
            if str(key).startswith("image_"):
                ordered_inputs.append(kwargs.get(key))

        images = _flatten_images(ordered_inputs)
        if not images:
            raise ValueError("请至少连接一张图片。")

        bg_rgba = _background_rgba(background, (17, 24, 32))
        text_rgb = _hex_color(label_color, (255, 255, 255))
        gap = int(gap)

        if cell_mode == "固定宽高":
            target_w = int(cell_width)
            target_h = int(cell_height)
        else:
            max_w = max(int(image.shape[2]) for image in images)
            max_h = max(int(image.shape[1]) for image in images)
            scale = int(cell_size) / max(max_w, max_h, 1)
            target_w = max(1, int(round(max_w * scale)))
            target_h = max(1, int(round(max_h * scale)))

        count = len(images)
        if layout == "横向排列":
            cols, rows = count, 1
        elif layout == "纵向排列":
            cols, rows = 1, count
        else:
            cols = max(1, math.ceil(math.sqrt(count)))
            rows = max(1, math.ceil(count / cols))

        out_w = cols * target_w + max(0, cols - 1) * gap
        out_h = rows * target_h + max(0, rows - 1) * gap
        canvas = Image.new("RGBA", (out_w, out_h), bg_rgba)
        label_list = _labels(labels)

        for index, image in enumerate(images):
            row = index // cols
            col = index % cols
            x = col * (target_w + gap)
            y = row * (target_h + gap)
            tile = _fit_image(image, target_w, target_h, fit_mode, bg_rgba)
            canvas.alpha_composite(tile, (x, y))
            label = label_list[index] if index < len(label_list) else ""
            _draw_label(canvas, (x, y, x + target_w, y + target_h), label, int(font_size), label_align, text_rgb)

        return (_pil_to_tensor(canvas),)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageCollage}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧩 图片拼版"}
