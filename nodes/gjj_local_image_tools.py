from __future__ import annotations

import math

import numpy as np
import torch
from PIL import Image, ImageColor, ImageDraw, ImageFont


def _color(value: str, fallback=(0, 0, 0)) -> tuple[int, int, int]:
    try:
        return ImageColor.getrgb(str(value).strip())[:3]
    except Exception:
        return fallback


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    array = np.asarray(image.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


def _full_mask(width: int, height: int, value: float = 1.0) -> torch.Tensor:
    return torch.full((1, int(height), int(width)), float(value), dtype=torch.float32)


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("msyh.ttc", "simhei.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, max(8, int(size)))
        except Exception:
            pass
    return ImageFont.load_default()


class GJJ_SolidColorImage:
    CATEGORY = "GJJ/Image"
    FUNCTION = "make"
    DESCRIPTION = "生成指定尺寸的纯色图片和全白遮罩。"
    SEARCH_ALIASES = ["solid color", "color image", "纯色图", "底色图"]
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("纯色图像", "全图遮罩")
    OUTPUT_TOOLTIPS = ("按指定颜色生成的 RGB 图像。", "与图像同尺寸的全白遮罩。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "宽度", "tooltip": "输出图片宽度。"}),
                "height": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "高度", "tooltip": "输出图片高度。"}),
                "color": ("COLOR", {"default": "#000000", "display_name": "颜色", "tooltip": "纯色颜色。"}),
            }
        }

    def make(self, width, height, color):
        image = Image.new("RGB", (int(width), int(height)), _color(color))
        return (_pil_to_tensor(image), _full_mask(width, height))


class GJJ_GradientImage:
    CATEGORY = "GJJ/Image"
    FUNCTION = "make"
    DESCRIPTION = "生成线性或径向渐变图，可作为背景、遮罩参考或 ControlNet 辅助图。"
    SEARCH_ALIASES = ["gradient", "渐变图", "渐变背景"]
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("渐变图像", "全图遮罩")
    OUTPUT_TOOLTIPS = ("生成的 RGB 渐变图像。", "与图像同尺寸的全白遮罩。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "宽度", "tooltip": "输出图片宽度。"}),
                "height": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "高度", "tooltip": "输出图片高度。"}),
                "start_color": ("COLOR", {"default": "#000000", "display_name": "起始颜色", "tooltip": "渐变起始颜色。"}),
                "end_color": ("COLOR", {"default": "#FFFFFF", "display_name": "结束颜色", "tooltip": "渐变结束颜色。"}),
                "direction": (["左到右", "上到下", "左上到右下", "径向"], {"default": "左到右", "display_name": "渐变方向", "tooltip": "选择线性渐变方向或径向渐变。"}),
            }
        }

    def make(self, width, height, start_color, end_color, direction):
        width = int(width)
        height = int(height)
        c1 = np.array(_color(start_color), dtype=np.float32)
        c2 = np.array(_color(end_color, (255, 255, 255)), dtype=np.float32)
        yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
        if direction == "上到下":
            t = yy / max(height - 1, 1)
        elif direction == "左上到右下":
            t = (xx / max(width - 1, 1) + yy / max(height - 1, 1)) / 2.0
        elif direction == "径向":
            cx = (width - 1) / 2.0
            cy = (height - 1) / 2.0
            dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
            t = dist / max(float(dist.max()), 1.0)
        else:
            t = xx / max(width - 1, 1)
        array = (c1 * (1.0 - t[..., None]) + c2 * t[..., None]).clip(0, 255).astype(np.uint8)
        return (_pil_to_tensor(Image.fromarray(array, mode="RGB")), _full_mask(width, height))


class GJJ_NoiseImage:
    CATEGORY = "GJJ/Image"
    FUNCTION = "make"
    DESCRIPTION = "生成随机噪声图片，支持彩色、灰度、均匀和高斯噪声。"
    SEARCH_ALIASES = ["noise", "噪声图", "随机图"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("噪声图像",)
    OUTPUT_TOOLTIPS = ("按种子生成的噪声图像。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "宽度", "tooltip": "输出图片宽度。"}),
                "height": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "高度", "tooltip": "输出图片高度。"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "display_name": "种子", "tooltip": "随机噪声种子。"}),
                "mode": (["彩色均匀", "灰度均匀", "彩色高斯", "灰度高斯"], {"default": "彩色均匀", "display_name": "噪声模式", "tooltip": "选择噪声通道和分布。"}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider", "display_name": "强度", "tooltip": "噪声对比强度。"}),
            }
        }

    def make(self, width, height, seed, mode, strength):
        generator = torch.Generator(device="cpu")
        generator.manual_seed(int(seed))
        channels = 1 if "灰度" in mode else 3
        if "高斯" in mode:
            data = torch.randn((1, int(height), int(width), channels), generator=generator) * 0.2 + 0.5
        else:
            data = torch.rand((1, int(height), int(width), channels), generator=generator)
        data = (0.5 + (data - 0.5) * float(strength)).clamp(0, 1)
        if channels == 1:
            data = data.repeat(1, 1, 1, 3)
        return (data,)


class GJJ_TextImage:
    CATEGORY = "GJJ/Image"
    FUNCTION = "make"
    DESCRIPTION = "把文本渲染成图片，可用于标题卡、占位图、字幕图或提示词可视化。"
    SEARCH_ALIASES = ["text image", "文字图片", "文本转图", "标题图"]
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("文字图像", "文字遮罩")
    OUTPUT_TOOLTIPS = ("渲染后的文字图片。", "文字区域遮罩。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "GJJ", "multiline": True, "display_name": "文本", "tooltip": "需要渲染到图片上的文字。"}),
                "width": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "宽度", "tooltip": "输出图片宽度。"}),
                "height": ("INT", {"default": 512, "min": 1, "max": 16384, "step": 1, "display_name": "高度", "tooltip": "输出图片高度。"}),
                "font_size": ("INT", {"default": 64, "min": 8, "max": 512, "step": 1, "display_name": "字号", "tooltip": "文字字号。"}),
                "text_color": ("STRING", {"default": "#FFFFFF", "display_name": "文字颜色", "tooltip": "文字颜色。"}),
                "background_color": ("STRING", {"default": "#000000", "display_name": "背景颜色", "tooltip": "背景颜色。"}),
                "align": (["居中", "左上", "左中", "左下", "右上", "右中", "右下"], {"default": "居中", "display_name": "对齐方式", "tooltip": "文字块在画布中的位置。"}),
                "padding": ("INT", {"default": 32, "min": 0, "max": 2048, "step": 1, "display_name": "边距", "tooltip": "文字距离画布边缘的最小边距。"}),
            }
        }

    def make(self, text, width, height, font_size, text_color, background_color, align, padding):
        width = int(width)
        height = int(height)
        image = Image.new("RGB", (width, height), _color(background_color))
        mask = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(image)
        mask_draw = ImageDraw.Draw(mask)
        font = _font(int(font_size))
        lines = str(text).splitlines() or [""]
        line_boxes = [draw.textbbox((0, 0), line, font=font) for line in lines]
        line_heights = [box[3] - box[1] for box in line_boxes]
        block_w = max([box[2] - box[0] for box in line_boxes] or [0])
        block_h = sum(line_heights) + max(0, len(lines) - 1) * max(2, int(font_size * 0.25))
        pad = int(padding)
        if "右" in align:
            x = width - block_w - pad
        elif "左" in align:
            x = pad
        else:
            x = (width - block_w) // 2
        if "上" in align:
            y = pad
        elif "下" in align:
            y = height - block_h - pad
        else:
            y = (height - block_h) // 2
        y_cursor = y
        for line, line_h in zip(lines, line_heights):
            draw.text((x, y_cursor), line, fill=_color(text_color, (255, 255, 255)), font=font)
            mask_draw.text((x, y_cursor), line, fill=255, font=font)
            y_cursor += line_h + max(2, int(font_size * 0.25))
        return (_pil_to_tensor(image), torch.from_numpy(np.asarray(mask).astype(np.float32) / 255.0).unsqueeze(0))


NODE_CLASS_MAPPINGS = {
    "GJJ_SolidColorImage": GJJ_SolidColorImage,
    "GJJ_GradientImage": GJJ_GradientImage,
    "GJJ_NoiseImage": GJJ_NoiseImage,
    "GJJ_TextImage": GJJ_TextImage,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_SolidColorImage": "GJJ · 🎨 纯色图生成",
    "GJJ_GradientImage": "GJJ · 🌈 渐变图生成",
    "GJJ_NoiseImage": "GJJ · 🌫️ 噪声图生成",
    "GJJ_TextImage": "GJJ · 🔤 文字图生成",
}
