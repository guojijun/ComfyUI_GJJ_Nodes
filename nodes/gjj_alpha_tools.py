from __future__ import annotations

import hashlib
import os
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

try:
    import folder_paths
except Exception:
    folder_paths = None


def _input_files() -> list[str]:
    if folder_paths is None:
        return [""]
    input_dir = folder_paths.get_input_directory()
    files = [name for name in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, name))]
    return sorted(files) or [""]


def _mask_from_alpha(alpha: torch.Tensor, invert: bool) -> torch.Tensor:
    mask = 1.0 - alpha if invert else alpha
    return mask.squeeze(-1).clamp(0.0, 1.0)


def _background(rgb: torch.Tensor, color: str) -> torch.Tensor:
    bg = torch.zeros_like(rgb)
    if color == "白色":
        bg = torch.ones_like(rgb)
    elif color == "绿幕":
        bg[..., 1] = 1.0
    elif color == "透明黑":
        bg = torch.zeros_like(rgb)
    return bg


class GJJ_LoadImageWithAlpha:
    CATEGORY = "GJJ/图像"
    FUNCTION = "load"
    DESCRIPTION = "加载 input 目录图片，保留 RGBA 并输出 alpha 遮罩。"
    SEARCH_ALIASES = ["alpha", "透明", "rgba", "load image alpha"]
    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("RGBA图像", "Alpha遮罩", "图片路径")
    OUTPUT_TOOLTIPS = (
        "保留透明通道的图片张量；没有 alpha 时为 RGB。",
        "由 alpha 通道生成的遮罩，默认白色表示透明区域，便于接入重绘。",
        "图片文件的绝对路径。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (_input_files(), {"image_upload": True, "display_name": "图片", "tooltip": "从 ComfyUI input 目录选择或上传图片。"}),
                "mask_mode": (["透明为白", "不透明为白"], {"default": "透明为白", "display_name": "遮罩语义", "tooltip": "控制 Alpha 遮罩输出中白色代表透明区域还是不透明区域。"}),
            }
        }

    def load(self, image: str, mask_mode: str):
        if folder_paths is None:
            raise RuntimeError("当前环境无法访问 ComfyUI 的 folder_paths。")
        image_path = folder_paths.get_annotated_filepath(image)
        output_images: list[torch.Tensor] = []
        output_masks: list[torch.Tensor] = []
        base_size: tuple[int, int] | None = None
        with Image.open(image_path) as img:
            excluded_formats = {"MPO"}
            for frame in ImageSequence.Iterator(img):
                frame = ImageOps.exif_transpose(frame)
                rgba = frame.convert("RGBA")
                if base_size is None:
                    base_size = rgba.size
                if rgba.size != base_size:
                    continue
                array = np.asarray(rgba).astype(np.float32) / 255.0
                tensor = torch.from_numpy(array).unsqueeze(0)
                alpha = tensor[..., 3:4]
                output_images.append(tensor)
                output_masks.append(_mask_from_alpha(alpha, mask_mode == "透明为白"))
            if len(output_images) > 1 and img.format not in excluded_formats:
                out_image = torch.cat(output_images, dim=0)
                out_mask = torch.cat(output_masks, dim=0)
            else:
                out_image = output_images[0]
                out_mask = output_masks[0]
        return (out_image, out_mask, image_path)

    @classmethod
    def IS_CHANGED(cls, image: str, mask_mode: str):
        if folder_paths is None:
            return image
        image_path = folder_paths.get_annotated_filepath(image)
        digest = hashlib.sha256()
        with open(image_path, "rb") as handle:
            digest.update(handle.read())
        return f"{digest.hexdigest()}|{mask_mode}"

    @classmethod
    def VALIDATE_INPUTS(cls, image: str, mask_mode: str):
        if folder_paths is not None and not folder_paths.exists_annotated_filepath(image):
            return f"图片文件无效：{image}"
        return True


class GJJ_AlphaTools:
    CATEGORY = "GJJ/图像"
    FUNCTION = "process"
    DESCRIPTION = "透明通道处理：绿幕转透明、Alpha转遮罩、移除透明背景。"
    SEARCH_ALIASES = ["alpha", "green screen", "透明", "绿幕", "remove transparency"]
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("图像", "遮罩")
    OUTPUT_TOOLTIPS = ("处理后的图像。", "处理得到的遮罩；无 alpha 时为全黑。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "图像", "tooltip": "输入 RGB 或 RGBA 图片。"}),
                "mode": (["Alpha转遮罩", "绿幕转透明", "移除透明背景"], {"default": "Alpha转遮罩", "display_name": "处理模式", "tooltip": "选择透明通道处理方式。"}),
                "green_threshold": ("FLOAT", {"default": 0.10, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "绿幕阈值", "tooltip": "绿通道比红蓝通道高出多少时认为是绿幕。"}),
                "background": (["黑色", "白色", "绿幕", "透明黑"], {"default": "黑色", "display_name": "背景颜色", "tooltip": "移除透明背景时填充的底色。"}),
                "mask_mode": (["透明为白", "不透明为白"], {"default": "透明为白", "display_name": "遮罩语义", "tooltip": "控制输出遮罩的白色区域语义。"}),
            }
        }

    def process(self, image: torch.Tensor, mode: str, green_threshold: float, background: str, mask_mode: str):
        value = image.detach().float().cpu().clamp(0.0, 1.0)
        if value.shape[-1] >= 4:
            rgb = value[..., :3]
            alpha = value[..., 3:4]
        else:
            rgb = value[..., :3]
            alpha = torch.ones((*rgb.shape[:-1], 1), dtype=rgb.dtype)

        if mode == "绿幕转透明":
            r, g, b = rgb[..., 0:1], rgb[..., 1:2], rgb[..., 2:3]
            alpha = torch.where((g > r + float(green_threshold)) & (g > b + float(green_threshold)), torch.zeros_like(alpha), alpha)
            out = torch.cat([rgb, alpha], dim=-1)
        elif mode == "移除透明背景":
            bg = _background(rgb, background)
            out = rgb * alpha + bg * (1.0 - alpha)
        else:
            out = value
        mask = _mask_from_alpha(alpha, mask_mode == "透明为白")
        return (out.clamp(0.0, 1.0), mask)


NODE_CLASS_MAPPINGS = {
    "GJJ_LoadImageWithAlpha": GJJ_LoadImageWithAlpha,
    "GJJ_AlphaTools": GJJ_AlphaTools,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_LoadImageWithAlpha": "GJJ · 🧊 透明图片加载",
    "GJJ_AlphaTools": "GJJ · 🧪 透明通道工具",
}
