from __future__ import annotations

import math
import logging
from typing import List

import numpy as np
import torch
import torch.nn.functional as F

from PIL import ImageColor

from nodes import MAX_RESOLUTION
from comfy.utils import common_upscale
from comfy import model_management

try:
    from server import PromptServer
except ImportError:
    PromptServer = None


def string_to_color(color_string: str) -> List[int]:
    color_list = [0, 0, 0]

    if ',' in color_string:
        try:
            values = [float(channel.strip()) for channel in color_string.split(',')]
            if all(0 <= v <= 1 for v in values):
                color_list = [int(v * 255) for v in values]
            else:
                color_list = [int(v) for v in values]
        except ValueError:
            logging.warning(f"无效的颜色格式: {color_string}，使用默认黑色。")
    elif color_string.startswith('#') or (color_string.lstrip('#').isalnum() and not color_string.lstrip('#').replace('.', '', 1).isdigit()):
        color_string_stripped = color_string.lstrip('#')
        if len(color_string_stripped) in [6, 8] and all(c in '0123456789ABCDEFabcdef' for c in color_string_stripped):
            if len(color_string_stripped) == 6:
                color_list = [int(color_string_stripped[i:i+2], 16) for i in (0, 2, 4)]
            elif len(color_string_stripped) == 8:
                color_list = [int(color_string_stripped[i:i+2], 16) for i in (0, 2, 4, 6)]
        else:
            try:
                rgb = ImageColor.getrgb(color_string)
                color_list = list(rgb)
            except ValueError:
                logging.warning(f"无效的颜色名称或十六进制格式: {color_string}，使用默认黑色。")
    else:
        try:
            value = float(color_string.strip())
            if 0 <= value <= 1:
                value = int(value * 255)
            else:
                value = int(value)
            color_list = [value, value, value]
        except ValueError:
            logging.warning(f"无效的颜色格式: {color_string}，使用默认黑色。")

    color_list = np.clip(color_list, 0, 255).tolist()

    return color_list


def pad(self, image, left, right, top, bottom, extra_padding, color, pad_mode, mask=None, target_width=None, target_height=None):
    B, H, W, C = image.shape
    if mask is not None:
        BM, HM, WM = mask.shape
        if HM != H or WM != W:
            mask = F.interpolate(mask.unsqueeze(1), size=(H, W), mode='nearest-exact').squeeze(1)

    color_list = string_to_color(color)
    bg_color = [x / 255.0 for x in color_list]
    if len(bg_color) == 1:
        bg_color = bg_color * 3
    bg_color = torch.tensor(bg_color, dtype=image.dtype, device=image.device)

    if target_width is not None and target_height is not None:
        if extra_padding > 0:
            image = common_upscale(image.movedim(-1, 1), W - extra_padding, H - extra_padding, "lanczos", "disabled").movedim(1, -1)
            B, H, W, C = image.shape

        padded_width = target_width
        padded_height = target_height
        pad_left = (padded_width - W) // 2
        pad_right = padded_width - W - pad_left
        pad_top = (padded_height - H) // 2
        pad_bottom = padded_height - H - pad_top
    else:
        pad_left = left + extra_padding
        pad_right = right + extra_padding
        pad_top = top + extra_padding
        pad_bottom = bottom + extra_padding

        padded_width = W + pad_left + pad_right
        padded_height = H + pad_top + pad_bottom

    if pad_mode == "pillarbox_blur":
        def _gaussian_blur_nchw(img_nchw, sigma_px):
            if sigma_px <= 0:
                return img_nchw
            radius = max(1, int(3.0 * float(sigma_px)))
            k = 2 * radius + 1
            x = torch.arange(-radius, radius + 1, device=img_nchw.device, dtype=img_nchw.dtype)
            k1 = torch.exp(-(x * x) / (2.0 * float(sigma_px) * float(sigma_px)))
            k1 = k1 / k1.sum()
            kx = k1.view(1, 1, 1, k)
            ky = k1.view(1, 1, k, 1)
            c = img_nchw.shape[1]
            kx = kx.repeat(c, 1, 1, 1)
            ky = ky.repeat(c, 1, 1, 1)
            img_nchw = F.conv2d(img_nchw, kx, padding=(0, radius), groups=c)
            img_nchw = F.conv2d(img_nchw, ky, padding=(radius, 0), groups=c)
            return img_nchw

        out_image = torch.zeros((B, padded_height, padded_width, C), dtype=image.dtype, device=image.device)
        for b in range(B):
            scale_fill = max(padded_width / float(W), padded_height / float(H)) if (W > 0 and H > 0) else 1.0
            bg_w = max(1, int(round(W * scale_fill)))
            bg_h = max(1, int(round(H * scale_fill)))
            src_b = image[b].movedim(-1, 0).unsqueeze(0)
            bg = common_upscale(src_b, bg_w, bg_h, "bilinear", crop="disabled")
            y0 = max(0, (bg_h - padded_height) // 2)
            x0 = max(0, (bg_w - padded_width) // 2)
            y1 = min(bg_h, y0 + padded_height)
            x1 = min(bg_w, x0 + padded_width)
            bg = bg[:, :, y0:y1, x0:x1]
            if bg.shape[2] != padded_height or bg.shape[3] != padded_width:
                pad_h = padded_height - bg.shape[2]
                pad_w = padded_width - bg.shape[3]
                pad_top_fix = max(0, pad_h // 2)
                pad_bottom_fix = max(0, pad_h - pad_top_fix)
                pad_left_fix = max(0, pad_w // 2)
                pad_right_fix = max(0, pad_w - pad_left_fix)
                bg = F.pad(bg, (pad_left_fix, pad_right_fix, pad_top_fix, pad_bottom_fix), mode="replicate")
            sigma = max(1.0, 0.006 * float(min(padded_height, padded_width)))
            bg = _gaussian_blur_nchw(bg, sigma_px=sigma)
            if C >= 3:
                r, g, bch = bg[:, 0:1], bg[:, 1:2], bg[:, 2:3]
                luma = 0.2126 * r + 0.7152 * g + 0.0722 * bch
                gray = torch.cat([luma, luma, luma], dim=1)
                desat = 0.20
                rgb = torch.cat([r, g, bch], dim=1)
                rgb = rgb * (1.0 - desat) + gray * desat
                bg[:, 0:3, :, :] = rgb
            dim = 0.35
            bg = torch.clamp(bg * dim, 0.0, 1.0)
            out_image[b] = bg.squeeze(0).movedim(0, -1)
        out_image[:, pad_top:pad_top+H, pad_left:pad_left+W, :] = image
        if mask is not None:
            fg_mask = mask
            out_masks = torch.ones((B, padded_height, padded_width), dtype=image.dtype, device=image.device)
            out_masks[:, pad_top:pad_top+H, pad_left:pad_left+W] = fg_mask
        else:
            out_masks = torch.ones((B, padded_height, padded_width), dtype=image.dtype, device=image.device)
            out_masks[:, pad_top:pad_top+H, pad_left:pad_left+W] = 0.0
        return (out_image, out_masks)

    out_image = torch.zeros((B, padded_height, padded_width, C), dtype=image.dtype, device=image.device)
    for b in range(B):
            if pad_mode == "edge":
                top_edge = image[b, 0, :, :]
                bottom_edge = image[b, H-1, :, :]
                left_edge = image[b, :, 0, :]
                right_edge = image[b, :, W-1, :]
                out_image[b, :pad_top, :, :] = top_edge.mean(dim=0)
                out_image[b, pad_top+H:, :, :] = bottom_edge.mean(dim=0)
                out_image[b, :, :pad_left, :] = left_edge.mean(dim=0)
                out_image[b, :, pad_left+W:, :] = right_edge.mean(dim=0)
                out_image[b, pad_top:pad_top+H, pad_left:pad_left+W, :] = image[b]
            elif pad_mode == "edge_pixel":
                for y in range(pad_top):
                    out_image[b, y, pad_left:pad_left+W, :] = image[b, 0, :, :]
                for y in range(pad_top+H, padded_height):
                    out_image[b, y, pad_left:pad_left+W, :] = image[b, H-1, :, :]
                for x in range(pad_left):
                    out_image[b, pad_top:pad_top+H, x, :] = image[b, :, 0, :]
                for x in range(pad_left+W, padded_width):
                    out_image[b, pad_top:pad_top+H, x, :] = image[b, :, W-1, :]
                out_image[b, :pad_top, :pad_left, :] = image[b, 0, 0, :]
                out_image[b, :pad_top, pad_left+W:, :] = image[b, 0, W-1, :]
                out_image[b, pad_top+H:, :pad_left, :] = image[b, H-1, 0, :]
                out_image[b, pad_top+H:, pad_left+W:, :] = image[b, H-1, W-1, :]
                out_image[b, pad_top:pad_top+H, pad_left:pad_left+W, :] = image[b]
            else:
                out_image[b, :, :, :] = bg_color.unsqueeze(0).unsqueeze(0)
                out_image[b, pad_top:pad_top+H, pad_left:pad_left+W, :] = image[b]

    if mask is not None:
        out_masks = torch.nn.functional.pad(
            mask,
            (pad_left, pad_right, pad_top, pad_bottom),
            mode='replicate'
        )
    else:
        out_masks = torch.ones((B, padded_height, padded_width), dtype=image.dtype, device=image.device)
        for m in range(B):
            out_masks[m, pad_top:pad_top+H, pad_left:pad_left+W] = 0.0

    return (out_image, out_masks)


NODE_NAME = "GJJ_ImageResizeKJv2"


class GJJ_ImageResizeKJv2:
    # 中文显示名称到内部值的映射
    upscale_method_map = {
        "最近邻": "nearest-exact",
        "双线性": "bilinear",
        "区域": "area",
        "双三次": "bicubic",
        "兰索斯": "lanczos"
    }
    keep_proportion_map = {
        "拉伸": "stretch",
        "等比缩放": "resize",
        "颜色填充": "pad",
        "边缘填充(平均)": "pad_edge",
        "边缘填充(像素)": "pad_edge_pixel",
        "裁剪": "crop",
        "模糊边框": "pillarbox_blur",
        "总像素数": "total_pixels"
    }
    crop_position_map = {
        "居中": "center",
        "顶部": "top",
        "底部": "bottom",
        "左侧": "left",
        "右侧": "right"
    }
    device_map = {
        "CPU": "cpu",
        "GPU": "gpu"
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "🖼️ 图片"}),
                "width": ("INT", {"default": 512, "min": 0, "max": MAX_RESOLUTION, "step": 8, "display_name": "📐 宽度"}),
                "height": ("INT", {"default": 512, "min": 0, "max": MAX_RESOLUTION, "step": 8, "display_name": "📐 高度"}),
                "upscale_method": (list(cls.upscale_method_map.keys()), {"default": "最近邻", "display_name": "🔄 缩放方法"}),
                "keep_proportion": (list(cls.keep_proportion_map.keys()), {"default": "拉伸", "display_name": "📏 保持比例"}),
                "pad_color": ("COLOR", {"default": "#000000", "display_name": "🎨 填充颜色", "tooltip": "填充区域的颜色。"}),
                "crop_position": (list(cls.crop_position_map.keys()), {"default": "居中", "display_name": "✂️ 裁剪位置"}),
                "divisible_by": ("INT", {"default": 2, "min": 0, "max": 512, "step": 1, "display_name": "🔢 对齐倍数"}),
            },
            "optional": {
                "mask": ("MASK", {"display_name": "🎭 遮罩"}),
                "device": (list(cls.device_map.keys()), {"default": "CPU", "display_name": "⚙️ 计算设备"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "MASK",)
    RETURN_NAMES = ("图片", "宽度", "高度", "遮罩",)
    FUNCTION = "resize"
    CATEGORY = "GJJ/image"
    DESCRIPTION = """
将图像缩放到指定的宽度和高度。

• 支持多种缩放方法（最近邻、双线性、双三次等）
• 保持比例模式可以按照最大尺寸等比缩放
• 填充模式会在空白区域填充指定颜色
• 裁剪模式会裁剪超出部分
• 支持遮罩同步处理
• 对齐倍数确保输出尺寸为指定值的整数倍
"""

    def resize(self, image, width, height, keep_proportion, upscale_method, divisible_by, pad_color, crop_position, unique_id, device="CPU", mask=None):
        # 将中文显示值转换为内部值
        keep_proportion = self.keep_proportion_map.get(keep_proportion, keep_proportion)
        upscale_method = self.upscale_method_map.get(upscale_method, upscale_method)
        crop_position = self.crop_position_map.get(crop_position, crop_position)
        device = self.device_map.get(device, device)

        B, H, W, C = image.shape

        if mask is not None and mask.shape[-2:] == (64, 64) and (H != 64 or W != 64):
            mask = None

        if mask is not None and mask.shape[-2:] != (H, W):
            mask = common_upscale(mask.unsqueeze(1), W, H, "bilinear", crop="disabled").squeeze(1)

        if device == "gpu":
            if upscale_method == "lanczos":
                raise Exception("兰索斯不支持GPU")
            device = model_management.get_torch_device()
        else:
            device = torch.device("cpu")

        pillarbox_blur = keep_proportion == "pillarbox_blur"

        pad_left = pad_right = pad_top = pad_bottom = 0

        if keep_proportion in ["resize", "total_pixels"] or keep_proportion.startswith("pad") or pillarbox_blur:
            if keep_proportion == "total_pixels":
                total_pixels = width * height
                aspect_ratio = W / H
                new_height = int(math.sqrt(total_pixels / aspect_ratio))
                new_width = int(math.sqrt(total_pixels * aspect_ratio))

            elif width == 0 and height == 0:
                new_width = W
                new_height = H
            elif width == 0 and height != 0:
                ratio = height / H
                new_width = round(W * ratio)
                new_height = height
            elif height == 0 and width != 0:
                ratio = width / W
                new_width = width
                new_height = round(H * ratio)
            elif width != 0 and height != 0:
                ratio = min(width / W, height / H)
                new_width = round(W * ratio)
                new_height = round(H * ratio)
            else:
                new_width = width
                new_height = height

            if keep_proportion.startswith("pad") or pillarbox_blur:
                if crop_position == "center":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top
                elif crop_position == "top":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_top = 0
                    pad_bottom = height - new_height
                elif crop_position == "bottom":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_top = height - new_height
                    pad_bottom = 0
                elif crop_position == "left":
                    pad_left = 0
                    pad_right = width - new_width
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top
                elif crop_position == "right":
                    pad_left = width - new_width
                    pad_right = 0
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top

            width = new_width
            height = new_height
        else:
            if width == 0:
                width = W
            if height == 0:
                height = H

        if divisible_by > 1:
            width = width - (width % divisible_by)
            height = height - (height % divisible_by)

        out_image = image if image.device == device else image.to(device)
        out_mask = None if mask is None else (mask if mask.device == device else mask.to(device))

        if keep_proportion == "crop":
            old_height = out_image.shape[-3]
            old_width = out_image.shape[-2]
            old_aspect = old_width / old_height
            new_aspect = width / height
            if old_aspect > new_aspect:
                crop_w = round(old_height * new_aspect)
                crop_h = old_height
            else:
                crop_w = old_width
                crop_h = round(old_width / new_aspect)
            if crop_position == "center":
                x = (old_width - crop_w) // 2
                y = (old_height - crop_h) // 2
            elif crop_position == "top":
                x = (old_width - crop_w) // 2
                y = 0
            elif crop_position == "bottom":
                x = (old_width - crop_w) // 2
                y = old_height - crop_h
            elif crop_position == "left":
                x = 0
                y = (old_height - crop_h) // 2
            elif crop_position == "right":
                x = old_width - crop_w
                y = (old_height - crop_h) // 2
            out_image = out_image.narrow(-2, x, crop_w).narrow(-3, y, crop_h)
            if out_mask is not None:
                out_mask = out_mask.narrow(-1, x, crop_w).narrow(-2, y, crop_h)

        out_image = common_upscale(out_image.movedim(-1, 1), width, height, upscale_method, crop="disabled").movedim(1, -1)
        if out_mask is not None:
            if upscale_method == "lanczos":
                out_mask = common_upscale(out_mask.unsqueeze(1).repeat(1, 3, 1, 1), width, height, upscale_method, crop="disabled").movedim(1, -1)[:, :, :, 0]
            else:
                out_mask = common_upscale(out_mask.unsqueeze(1), width, height, upscale_method, crop="disabled").squeeze(1)

        if (keep_proportion.startswith("pad") or pillarbox_blur) and (pad_left > 0 or pad_right > 0 or pad_top > 0 or pad_bottom > 0):
            padded_width = width + pad_left + pad_right
            padded_height = height + pad_top + pad_bottom
            if divisible_by > 1:
                width_remainder = padded_width % divisible_by
                height_remainder = padded_height % divisible_by
                if width_remainder > 0:
                    extra_width = divisible_by - width_remainder
                    pad_right += extra_width
                if height_remainder > 0:
                    extra_height = divisible_by - height_remainder
                    pad_bottom += extra_height

            pad_mode = (
                "pillarbox_blur" if pillarbox_blur else
                "edge" if keep_proportion == "pad_edge" else
                "edge_pixel" if keep_proportion == "pad_edge_pixel" else
                "color"
            )
            out_image, out_mask = pad(self, out_image, pad_left, pad_right, pad_top, pad_bottom, 0, pad_color, pad_mode, mask=out_mask)

        return (out_image.cpu(), out_image.shape[2], out_image.shape[1], out_mask.cpu() if out_mask is not None else torch.zeros(64, 64, device=torch.device("cpu"), dtype=torch.float32))


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageResizeKJv2}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔍 图片缩放 KJv2"}
