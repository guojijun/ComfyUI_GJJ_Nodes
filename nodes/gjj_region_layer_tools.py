from __future__ import annotations

import json
from typing import Any

import numpy as np
import torch
from PIL import Image


REGION_TYPE = "GJJ_REGION"


def _normalize_image(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise ValueError("图像输入必须是 IMAGE。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise ValueError("图像维度不正确。")
    if image.shape[-1] == 1:
        image = image.repeat(1, 1, 1, 3)
    return image[..., :3].float().clamp(0, 1)


def _normalize_mask(mask: torch.Tensor | None, height: int, width: int) -> torch.Tensor:
    if mask is None:
        return torch.ones((1, height, width), dtype=torch.float32)
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    if mask.ndim == 4:
        mask = mask[..., 0]
    return mask.float().clamp(0, 1)


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    if image.ndim == 4:
        image = image[0]
    array = (image.detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    return Image.fromarray(array[..., :3], mode="RGB")


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    array = np.asarray(image.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


def _resize_image(image: torch.Tensor, width: int, height: int, mode: str) -> torch.Tensor:
    pil = _tensor_to_pil(image)
    src_w, src_h = pil.size
    if mode == "拉伸填满":
        return _pil_to_tensor(pil.resize((width, height), Image.Resampling.LANCZOS))
    ratio = max(width / max(src_w, 1), height / max(src_h, 1)) if mode == "裁切填满" else min(width / max(src_w, 1), height / max(src_h, 1))
    new_w = max(1, int(round(src_w * ratio)))
    new_h = max(1, int(round(src_h * ratio)))
    resized = pil.resize((new_w, new_h), Image.Resampling.LANCZOS)
    if mode == "裁切填满":
        left = max(0, (new_w - width) // 2)
        top = max(0, (new_h - height) // 2)
        fitted = resized.crop((left, top, left + width, top + height))
    else:
        fitted = Image.new("RGB", (width, height), (0, 0, 0))
        fitted.paste(resized, ((width - new_w) // 2, (height - new_h) // 2))
    return _pil_to_tensor(fitted)


def _region_box(region: Any) -> tuple[int, int, int, int]:
    if not isinstance(region, dict):
        raise ValueError("区域数据无效。")
    return int(region.get("x", 0)), int(region.get("y", 0)), int(region.get("width", 0)), int(region.get("height", 0))


def _region_mask(canvas_width: int, canvas_height: int, x: int, y: int, width: int, height: int) -> torch.Tensor:
    mask = torch.zeros((1, canvas_height, canvas_width), dtype=torch.float32)
    left = max(0, x)
    top = max(0, y)
    right = min(canvas_width, x + width)
    bottom = min(canvas_height, y + height)
    if right > left and bottom > top:
        mask[:, top:bottom, left:right] = 1.0
    return mask


class GJJ_RegionBox:
    CATEGORY = "GJJ/Layer"
    FUNCTION = "make_region"
    DESCRIPTION = "创建一个可传递的矩形区域，并同步输出该区域遮罩。"
    SEARCH_ALIASES = ["region", "box", "区域", "矩形区域", "区域框"]
    RETURN_TYPES = (REGION_TYPE, "MASK", "STRING")
    RETURN_NAMES = ("区域数据", "区域遮罩", "区域JSON")
    OUTPUT_TOOLTIPS = ("可传给合成、裁切等 GJJ 区域节点的区域数据。", "该区域在画布上的遮罩。", "区域数据 JSON 文本。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "canvas_width": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "画布宽度", "tooltip": "区域所属画布宽度。"}),
                "canvas_height": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "画布高度", "tooltip": "区域所属画布高度。"}),
                "x": ("INT", {"default": 0, "min": -16384, "max": 16384, "step": 1, "display_name": "X 坐标", "tooltip": "区域左上角 X 坐标。"}),
                "y": ("INT", {"default": 0, "min": -16384, "max": 16384, "step": 1, "display_name": "Y 坐标", "tooltip": "区域左上角 Y 坐标。"}),
                "width": ("INT", {"default": 512, "min": 1, "max": 16384, "step": 1, "display_name": "区域宽度", "tooltip": "区域宽度。"}),
                "height": ("INT", {"default": 512, "min": 1, "max": 16384, "step": 1, "display_name": "区域高度", "tooltip": "区域高度。"}),
            },
            "optional": {
                "image": ("IMAGE", {"display_name": "输入图片", "tooltip": "可选。连接图片后首次执行自动将画布宽高同步为图片尺寸；后续可手动修改。"}),
            },
        }

    def make_region(self, canvas_width, canvas_height, x, y, width, height, image=None):
        region = {
            "x": int(x),
            "y": int(y),
            "width": int(width),
            "height": int(height),
            "canvas_width": int(canvas_width),
            "canvas_height": int(canvas_height),
        }
        result = (region, _region_mask(int(canvas_width), int(canvas_height), int(x), int(y), int(width), int(height)), json.dumps(region, ensure_ascii=False))
        if image is not None:
            img = _normalize_image(image)
            return {
                "ui": {
                    "image_width": (int(img.shape[2]),),
                    "image_height": (int(img.shape[1]),),
                },
                "result": result,
            }
        return result


class GJJ_GridRegionSelector:
    CATEGORY = "GJJ/Layer"
    FUNCTION = "select"
    DESCRIPTION = "把画布切成行列网格，按序号输出其中一个区域和完整区域列表 JSON。"
    SEARCH_ALIASES = ["grid region", "split grid", "网格区域", "区域选择"]
    RETURN_TYPES = (REGION_TYPE, "MASK", "STRING")
    RETURN_NAMES = ("选中区域", "选中遮罩", "区域列表JSON")
    OUTPUT_TOOLTIPS = ("按序号选中的网格区域。", "选中网格区域遮罩。", "全部网格区域的 JSON 列表。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "canvas_width": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "画布宽度", "tooltip": "网格所属画布宽度。"}),
                "canvas_height": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "画布高度", "tooltip": "网格所属画布高度。"}),
                "rows": ("INT", {"default": 2, "min": 1, "max": 64, "step": 1, "display_name": "行数", "tooltip": "网格行数。"}),
                "cols": ("INT", {"default": 2, "min": 1, "max": 64, "step": 1, "display_name": "列数", "tooltip": "网格列数。"}),
                "index": ("INT", {"default": 1, "min": 1, "max": 4096, "step": 1, "display_name": "区域序号", "tooltip": "按从左到右、从上到下的 1 基序号选择区域。"}),
                "gap": ("INT", {"default": 0, "min": 0, "max": 512, "step": 1, "display_name": "网格间距", "tooltip": "区域之间预留的像素间距。"}),
            }
        }

    def select(self, canvas_width, canvas_height, rows, cols, index, gap):
        canvas_width = int(canvas_width)
        canvas_height = int(canvas_height)
        rows = int(rows)
        cols = int(cols)
        gap = int(gap)
        cell_w = max(1, (canvas_width - gap * (cols - 1)) // cols)
        cell_h = max(1, (canvas_height - gap * (rows - 1)) // rows)
        regions = []
        for row in range(rows):
            for col in range(cols):
                regions.append({
                    "x": col * (cell_w + gap),
                    "y": row * (cell_h + gap),
                    "width": cell_w,
                    "height": cell_h,
                    "canvas_width": canvas_width,
                    "canvas_height": canvas_height,
                })
        selected = regions[(int(index) - 1) % len(regions)]
        x, y, w, h = _region_box(selected)
        return (selected, _region_mask(canvas_width, canvas_height, x, y, w, h), json.dumps(regions, ensure_ascii=False))


class GJJ_RegionCrop:
    CATEGORY = "GJJ/Layer"
    FUNCTION = "crop"
    DESCRIPTION = "按 GJJ 区域数据从图片中裁切局部图像。"
    SEARCH_ALIASES = ["region crop", "crop by region", "区域裁切", "局部裁切"]
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("裁切图像", "裁切遮罩")
    OUTPUT_TOOLTIPS = ("区域内裁切出的图像。", "区域内的白色遮罩。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "输入图像", "tooltip": "需要裁切的图片。"}),
                "region": (REGION_TYPE, {"display_name": "区域数据", "tooltip": "由区域框或网格区域节点输出的区域数据。"}),
            }
        }

    def crop(self, image, region):
        image = _normalize_image(image)
        x, y, w, h = _region_box(region)
        height = int(image.shape[1])
        width = int(image.shape[2])
        left = max(0, x)
        top = max(0, y)
        right = min(width, x + w)
        bottom = min(height, y + h)
        if right <= left or bottom <= top:
            raise ValueError("区域不在图片范围内。")
        cropped = image[:, top:bottom, left:right, :]
        mask = torch.ones((int(cropped.shape[0]), int(cropped.shape[1]), int(cropped.shape[2])), dtype=torch.float32, device=cropped.device)
        return (cropped, mask)


class GJJ_RegionComposite:
    CATEGORY = "GJJ/Layer"
    FUNCTION = "composite"
    DESCRIPTION = "把前景图片按指定区域合成到底图上，支持适配方式、透明度和可选遮罩。"
    SEARCH_ALIASES = ["region composite", "layer composite", "区域合成", "图层合成"]
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("合成图像", "合成区域遮罩")
    OUTPUT_TOOLTIPS = ("完成区域合成后的图片。", "实际合成区域遮罩。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_image": ("IMAGE", {"display_name": "底图", "tooltip": "被合成的背景图片。"}),
                "overlay_image": ("IMAGE", {"display_name": "前景图", "tooltip": "放入指定区域的前景图片。"}),
                "region": (REGION_TYPE, {"display_name": "区域数据", "tooltip": "前景图要放入的区域。"}),
                "fit_mode": (["等比留边", "裁切填满", "拉伸填满"], {"default": "等比留边", "display_name": "适配方式", "tooltip": "前景图放入区域时的缩放方式。"}),
                "opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider", "display_name": "透明度", "tooltip": "前景图整体混合透明度。"}),
                "canvas_width": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1, "display_name": "画布宽度", "tooltip": "合成画布宽度。0 表示自动跟随底图实际宽度。"}),
                "canvas_height": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1, "display_name": "画布高度", "tooltip": "合成画布高度。0 表示自动跟随底图实际高度。"}),
            },
            "optional": {
                "overlay_mask": ("MASK", {"display_name": "前景遮罩", "tooltip": "可选。控制前景图在区域内的可见范围。"}),
            },
        }

    def composite(self, base_image, overlay_image, region, fit_mode, opacity, canvas_width=0, canvas_height=0, overlay_mask=None):
        base = _normalize_image(base_image).clone()
        overlay = _normalize_image(overlay_image)
        x, y, w, h = _region_box(region)
        canvas_w = int(canvas_width) if int(canvas_width) > 0 else int(base.shape[2])
        canvas_h = int(canvas_height) if int(canvas_height) > 0 else int(base.shape[1])
        left = max(0, x)
        top = max(0, y)
        right = min(canvas_w, x + w)
        bottom = min(canvas_h, y + h)
        if right <= left or bottom <= top:
            raise ValueError("区域不在底图范围内。")
        target_w = right - left
        target_h = bottom - top
        fitted = _resize_image(overlay[0:1], target_w, target_h, fit_mode).to(base.device)
        mask = _normalize_mask(overlay_mask, target_h, target_w).to(base.device)
        if mask.shape[-2:] != (target_h, target_w):
            mask_img = Image.fromarray((mask[0].detach().cpu().numpy() * 255).astype(np.uint8), mode="L").resize((target_w, target_h), Image.Resampling.LANCZOS)
            mask = torch.from_numpy(np.asarray(mask_img).astype(np.float32) / 255.0).unsqueeze(0).to(base.device)
        alpha = (mask[0:1, :, :].unsqueeze(-1) * float(opacity)).clamp(0, 1)
        base[:, top:bottom, left:right, :] = base[:, top:bottom, left:right, :] * (1.0 - alpha) + fitted * alpha
        region_mask = _region_mask(canvas_w, canvas_h, left, top, target_w, target_h).to(base.device)
        return {
            "ui": {
                "canvas_width": [canvas_w],
                "canvas_height": [canvas_h],
            },
            "result": (base.clamp(0, 1), region_mask),
        }


NODE_CLASS_MAPPINGS = {
    "GJJ_RegionBox": GJJ_RegionBox,
    "GJJ_GridRegionSelector": GJJ_GridRegionSelector,
    "GJJ_RegionCrop": GJJ_RegionCrop,
    "GJJ_RegionComposite": GJJ_RegionComposite,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_RegionBox": "GJJ · 📐 区域框",
    "GJJ_GridRegionSelector": "GJJ · 🔲 网格区域选择",
    "GJJ_RegionCrop": "GJJ · ✂️ 区域裁切",
    "GJJ_RegionComposite": "GJJ · 🧱 区域图层合成",
}
