from __future__ import annotations

import math
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter


REGION_TYPE = "GJJ_REGION"


def _normalize_mask(mask: torch.Tensor) -> torch.Tensor:
    if not isinstance(mask, torch.Tensor):
        raise ValueError("遮罩输入必须是 MASK。")
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    if mask.ndim == 4:
        mask = mask.squeeze(-1) if mask.shape[-1] == 1 else mask[..., 0]
    if mask.ndim != 3:
        raise ValueError("遮罩维度不正确。")
    return mask.float().clamp(0, 1)


def _pool_mask(mask: torch.Tensor, radius: int, mode: str) -> torch.Tensor:
    mask = _normalize_mask(mask)
    radius = int(abs(radius))
    if radius <= 0:
        return mask
    kernel = radius * 2 + 1
    x = mask.unsqueeze(1)
    if mode == "erode":
        x = 1.0 - F.max_pool2d(1.0 - x, kernel_size=kernel, stride=1, padding=radius)
    else:
        x = F.max_pool2d(x, kernel_size=kernel, stride=1, padding=radius)
    return x.squeeze(1).clamp(0, 1)


def _blur_mask(mask: torch.Tensor, radius: float) -> torch.Tensor:
    mask = _normalize_mask(mask)
    if radius <= 0:
        return mask
    out = []
    for item in mask:
        array = (item.detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
        image = Image.fromarray(array, mode="L").filter(ImageFilter.GaussianBlur(float(radius)))
        out.append(torch.from_numpy(np.asarray(image).astype(np.float32) / 255.0))
    return torch.stack(out, dim=0).to(mask.device).clamp(0, 1)


def _region_to_box(region: Any) -> tuple[int, int, int, int]:
    if not isinstance(region, dict):
        raise ValueError("区域数据无效，请连接 GJJ 区域节点输出。")
    x = int(region.get("x", 0))
    y = int(region.get("y", 0))
    width = int(region.get("width", 0))
    height = int(region.get("height", 0))
    return x, y, width, height


class GJJ_MaskOutline:
    CATEGORY = "GJJ/Mask"
    FUNCTION = "outline"
    DESCRIPTION = "从遮罩生成内外轮廓线，可用于局部重绘边缘、描边控制或可视化区域边界。"
    SEARCH_ALIASES = ["mask outline", "outline mask", "遮罩描边", "轮廓遮罩"]
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("轮廓遮罩",)
    OUTPUT_TOOLTIPS = ("由原遮罩扩张与收缩相减得到的轮廓遮罩。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK", {"display_name": "输入遮罩", "tooltip": "需要生成轮廓的遮罩。"}),
                "width": ("INT", {"default": 8, "min": 1, "max": 512, "step": 1, "display_name": "轮廓宽度", "tooltip": "轮廓向内外扩展的像素宽度。"}),
                "mode": (["内外轮廓", "外轮廓", "内轮廓"], {"default": "内外轮廓", "display_name": "轮廓模式", "tooltip": "选择生成内外两侧、仅外侧或仅内侧轮廓。"}),
                "blur": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 128.0, "step": 0.5, "display_name": "轮廓模糊", "tooltip": "对轮廓边缘做高斯模糊。"}),
            }
        }

    def outline(self, mask, width: int, mode: str, blur: float):
        src = _normalize_mask(mask)
        dilated = _pool_mask(src, width, "dilate")
        eroded = _pool_mask(src, width, "erode")
        if mode == "外轮廓":
            out = (dilated - src).clamp(0, 1)
        elif mode == "内轮廓":
            out = (src - eroded).clamp(0, 1)
        else:
            out = (dilated - eroded).clamp(0, 1)
        return (_blur_mask(out, float(blur)),)


class GJJ_MaskGrowBlur:
    CATEGORY = "GJJ/Mask"
    FUNCTION = "grow_blur"
    DESCRIPTION = "对遮罩执行扩张、收缩与模糊，常用于重绘遮罩预处理。"
    SEARCH_ALIASES = ["mask grow", "mask blur", "遮罩扩张", "遮罩羽化"]
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("处理后遮罩",)
    OUTPUT_TOOLTIPS = ("扩张/收缩并模糊后的遮罩。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK", {"display_name": "输入遮罩", "tooltip": "需要处理的遮罩。"}),
                "grow": ("INT", {"default": 0, "min": -512, "max": 512, "step": 1, "display_name": "扩张/收缩", "tooltip": "正数扩张遮罩，负数收缩遮罩。"}),
                "blur": ("FLOAT", {"default": 8.0, "min": 0.0, "max": 256.0, "step": 0.5, "display_name": "羽化模糊", "tooltip": "对遮罩边缘做高斯模糊。"}),
                "invert": ("BOOLEAN", {"default": False, "display_name": "反相", "tooltip": "开启后输出 1 - 遮罩。"}),
            }
        }

    def grow_blur(self, mask, grow: int, blur: float, invert: bool):
        out = _normalize_mask(mask)
        if grow > 0:
            out = _pool_mask(out, grow, "dilate")
        elif grow < 0:
            out = _pool_mask(out, -grow, "erode")
        out = _blur_mask(out, float(blur))
        if invert:
            out = 1.0 - out
        return (out.clamp(0, 1),)


class GJJ_MaskMerge:
    CATEGORY = "GJJ/Mask"
    FUNCTION = "merge"
    DESCRIPTION = "合并最多八路遮罩，支持相加、最大值、相交和扣除。"
    SEARCH_ALIASES = ["mask merge", "mask combine", "遮罩合并", "遮罩相交"]
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("合并遮罩",)
    OUTPUT_TOOLTIPS = ("按指定模式合并后的遮罩。",)

    @classmethod
    def INPUT_TYPES(cls):
        optional = {f"mask_{i}": ("MASK", {"display_name": f"遮罩 {i}", "tooltip": f"第 {i} 路待合并遮罩。"}) for i in range(2, 9)}
        return {
            "required": {
                "mask_1": ("MASK", {"display_name": "遮罩 1", "tooltip": "第一路待合并遮罩。"}),
                "mode": (["最大值合并", "相加合并", "相交", "从第一路扣除"], {"default": "最大值合并", "display_name": "合并模式", "tooltip": "控制多路遮罩如何合并。"}),
            },
            "optional": optional,
        }

    def merge(self, mask_1, mode: str, **kwargs):
        masks = [_normalize_mask(mask_1)]
        for i in range(2, 9):
            value = kwargs.get(f"mask_{i}")
            if value is not None:
                masks.append(_normalize_mask(value))
        base = masks[0]
        for item in masks[1:]:
            if item.shape[-2:] != base.shape[-2:]:
                raise ValueError("所有遮罩尺寸必须一致。")
            if mode == "相加合并":
                base = (base + item).clamp(0, 1)
            elif mode == "相交":
                base = torch.minimum(base, item)
            elif mode == "从第一路扣除":
                base = (base - item).clamp(0, 1)
            else:
                base = torch.maximum(base, item)
        return (base.clamp(0, 1),)


class GJJ_AreaToMask:
    CATEGORY = "GJJ/Mask"
    FUNCTION = "area_to_mask"
    DESCRIPTION = "按画布尺寸和矩形区域生成遮罩，也可直接接收 GJJ 区域数据。"
    SEARCH_ALIASES = ["area mask", "region mask", "区域遮罩", "矩形遮罩"]
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("区域遮罩",)
    OUTPUT_TOOLTIPS = ("矩形区域对应的遮罩。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "canvas_width": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "画布宽度", "tooltip": "输出遮罩宽度。"}),
                "canvas_height": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "画布高度", "tooltip": "输出遮罩高度。"}),
                "x": ("INT", {"default": 0, "min": -16384, "max": 16384, "step": 1, "display_name": "区域 X", "tooltip": "矩形区域左上角 X 坐标。"}),
                "y": ("INT", {"default": 0, "min": -16384, "max": 16384, "step": 1, "display_name": "区域 Y", "tooltip": "矩形区域左上角 Y 坐标。"}),
                "width": ("INT", {"default": 512, "min": 1, "max": 16384, "step": 1, "display_name": "区域宽度", "tooltip": "矩形区域宽度。"}),
                "height": ("INT", {"default": 512, "min": 1, "max": 16384, "step": 1, "display_name": "区域高度", "tooltip": "矩形区域高度。"}),
                "blur": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 256.0, "step": 0.5, "display_name": "边缘羽化", "tooltip": "输出遮罩边缘模糊半径。"}),
            },
            "optional": {
                "region": (REGION_TYPE, {"display_name": "区域数据", "tooltip": "可选。接入后使用区域数据中的 x/y/宽/高覆盖面板坐标。"}),
            },
        }

    def area_to_mask(self, canvas_width, canvas_height, x, y, width, height, blur, region=None):
        if region is not None:
            x, y, width, height = _region_to_box(region)
            canvas_width = int(region.get("canvas_width", canvas_width))
            canvas_height = int(region.get("canvas_height", canvas_height))
        mask = torch.zeros((1, int(canvas_height), int(canvas_width)), dtype=torch.float32)
        left = max(0, int(x))
        top = max(0, int(y))
        right = min(int(canvas_width), int(x) + int(width))
        bottom = min(int(canvas_height), int(y) + int(height))
        if right > left and bottom > top:
            mask[:, top:bottom, left:right] = 1.0
        return (_blur_mask(mask, float(blur)),)


NODE_CLASS_MAPPINGS = {
    "GJJ_MaskOutline": GJJ_MaskOutline,
    "GJJ_MaskGrowBlur": GJJ_MaskGrowBlur,
    "GJJ_MaskMerge": GJJ_MaskMerge,
    "GJJ_AreaToMask": GJJ_AreaToMask,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_MaskOutline": "GJJ · 🎭 遮罩描边",
    "GJJ_MaskGrowBlur": "GJJ · 🪶 遮罩扩张羽化",
    "GJJ_MaskMerge": "GJJ · 🧬 遮罩合并",
    "GJJ_AreaToMask": "GJJ · ▣ 区域转遮罩",
}
