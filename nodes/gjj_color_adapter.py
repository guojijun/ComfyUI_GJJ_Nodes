from __future__ import annotations

from typing import Any

import numpy as np
import torch
from PIL import Image


NODE_NAME = "GJJ_ColorAdapter"


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    array = image.detach().cpu().numpy()
    if array.ndim == 4:
        array = array[0]
    array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
    if array.ndim == 2:
        return Image.fromarray(array, mode="L")
    if array.shape[-1] == 4:
        return Image.fromarray(array, mode="RGBA")
    return Image.fromarray(array[..., :3], mode="RGB")


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    array = np.asarray(image).astype(np.float32) / 255.0
    if array.ndim == 2:
        array = np.stack([array, array, array], axis=-1)
    if array.shape[-1] == 4:
        array = array[..., :3]
    return torch.from_numpy(array).unsqueeze(0)


def _resize_reference(reference: Image.Image, size: tuple[int, int]) -> Image.Image:
    if reference.size == size:
        return reference
    resampling = getattr(Image, "Resampling", Image).BICUBIC
    return reference.resize(size, resampling)


def _lab_transfer(image: Image.Image, reference: Image.Image) -> Image.Image:
    source_lab = np.asarray(image.convert("LAB")).astype(np.float32)
    reference_lab = np.asarray(reference.convert("LAB")).astype(np.float32)

    source_flat = source_lab.reshape(-1, 3)
    reference_flat = reference_lab.reshape(-1, 3)
    source_mean = source_flat.mean(axis=0)
    reference_mean = reference_flat.mean(axis=0)
    source_std = np.maximum(source_flat.std(axis=0), 1e-6)
    reference_std = reference_flat.std(axis=0)

    transferred = (source_lab - source_mean) * (reference_std / source_std) + reference_mean
    transferred = np.clip(transferred, 0, 255).astype(np.uint8)
    return Image.fromarray(transferred, mode="LAB").convert("RGB")


def _adapt_one(image: torch.Tensor, reference: torch.Tensor, opacity: int) -> torch.Tensor:
    source = _tensor_to_pil(image)
    alpha = source.getchannel("A") if source.mode == "RGBA" else None
    source_rgb = source.convert("RGB")
    reference_rgb = _resize_reference(_tensor_to_pil(reference).convert("RGB"), source_rgb.size)
    adapted = _lab_transfer(source_rgb, reference_rgb)
    if opacity <= 0:
        result = source_rgb
    elif opacity < 100:
        result = Image.blend(source_rgb, adapted, float(opacity) / 100.0)
    else:
        result = adapted
    if alpha is not None:
        result = Image.merge("RGBA", (*result.convert("RGB").split(), alpha))
    return _pil_to_tensor(result)


class GJJ_ColorAdapter:
    CATEGORY = "GJJ/视频/图像处理"
    FUNCTION = "color_adapter"
    DESCRIPTION = "根据参考图自动调整输入图像的整体色调。复刻 LayerColor: ColorAdapter 的 LAB 色彩迁移逻辑，使用 GJJ 内置零依赖实现。"
    SEARCH_ALIASES = [
        "ColorAdapter",
        "LayerColor ColorAdapter",
        "颜色适配",
        "色调匹配",
        "参考图调色",
        "LAB color transfer",
    ]

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("调整后图像",)
    OUTPUT_TOOLTIPS = ("按参考图色调调整后的图像批次。",)

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "输入图像",
                        "tooltip": "需要自动调整色调的图像批次。",
                    },
                ),
                "color_ref_image": (
                    "IMAGE",
                    {
                        "display_name": "参考图像",
                        "tooltip": "提供目标色调的参考图。参考图数量少于输入图时，会复用最后一张参考图。",
                    },
                ),
                "opacity": (
                    "INT",
                    {
                        "default": 75,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "display_name": "调整强度",
                        "tooltip": "色调调整结果的不透明度。0 保持原图，100 完全使用自动匹配后的色调。",
                    },
                ),
            },
        }

    def color_adapter(self, image: torch.Tensor, color_ref_image: torch.Tensor, opacity: int):
        if image is None:
            raise ValueError("缺少输入图像。")
        if color_ref_image is None:
            raise ValueError("缺少参考图像。")
        if len(color_ref_image) <= 0:
            raise ValueError("参考图像批次为空。")

        opacity = int(max(0, min(100, opacity)))
        outputs = []
        for index, item in enumerate(image):
            ref_index = min(index, len(color_ref_image) - 1)
            outputs.append(_adapt_one(item, color_ref_image[ref_index], opacity))
        result = torch.cat(outputs, dim=0)
        print(f"[GJJ_ColorAdapter] 已处理 {len(outputs)} 张图像。")
        return (result,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ColorAdapter}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎨 颜色适配"}
