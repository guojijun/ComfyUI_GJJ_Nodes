from __future__ import annotations

from typing import Any

import torch
from nodes import PreviewImage

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


IMAGE_TO_BATCH_NODE = "GJJ_ImageToBatchImage"
BATCH_TO_IMAGE_NODE = "GJJ_BatchImageToImage"
BATCH_PREVIEW_NODE = "guojijun_BatchImagePreview"


class FlexibleBatchImageInputType(dict):
    def __init__(self, data: dict[str, Any] | None = None):
        super().__init__()
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        text = str(key or "")
        if text == "image" or text.startswith("image_"):
            return (
                "IMAGE",
                {
                    "display_name": "图像输入",
                    "tooltip": "可接单张 IMAGE 或 IMAGE batch；节点会按输入顺序合并打包为 GJJ_BATCH_IMAGE。",
                },
            )
        raise KeyError(key)

    def __contains__(self, key):
        text = str(key or "")
        return key in self.data or text == "image" or text.startswith("image_")


def _extract_input_index(name: str) -> int:
    text = str(name or "")
    if text == "image":
        return 1
    if not text.startswith("image_"):
        return 999999
    try:
        return int(text[6:])
    except Exception:
        return 999999


def _split_image_batch(value: Any) -> list[torch.Tensor]:
    if value is None or not isinstance(value, torch.Tensor):
        return []
    batch = value
    if batch.ndim == 3:
        batch = batch.unsqueeze(0)
    if batch.ndim != 4:
        return []
    return [batch[index:index + 1].detach().float().contiguous() for index in range(int(batch.shape[0]))]


def _to_rgb_image(image: torch.Tensor) -> torch.Tensor:
    channels = int(image.shape[-1]) if image.ndim == 4 else 0
    if channels == 3:
        return image.contiguous()
    if channels == 4:
        rgb = image[..., :3]
        alpha = image[..., 3:4].clamp(0.0, 1.0)
        return (rgb * alpha).contiguous()
    if channels == 1:
        return image.repeat(1, 1, 1, 3).contiguous()
    if channels > 4:
        return image[..., :3].contiguous()
    raise RuntimeError(f"批量图片包装器收到不支持的图像通道数：{channels}")


def _build_uniform_batch(images: list[torch.Tensor]) -> torch.Tensor:
    if not images:
        raise RuntimeError("批量图片包装器至少需要连接一张图片。")

    images = [_to_rgb_image(image) for image in images]
    max_height = max(int(image.shape[1]) for image in images)
    max_width = max(int(image.shape[2]) for image in images)
    padded: list[torch.Tensor] = []
    for image in images:
        height = int(image.shape[1])
        width = int(image.shape[2])
        if height == max_height and width == max_width:
            padded.append(image.contiguous())
            continue
        canvas = torch.zeros((1, max_height, max_width, 3), dtype=image.dtype, device=image.device)
        top = max(0, (max_height - height) // 2)
        left = max(0, (max_width - width) // 2)
        canvas[:, top:top + height, left:left + width, :] = image
        padded.append(canvas)
    return torch.cat(padded, dim=0).contiguous()


class GJJ_ImageToBatchImage:
    CATEGORY = "GJJ"
    FUNCTION = "wrap"
    DESCRIPTION = "把一张或多张普通 IMAGE 打包成 GJJ 专用批量图片类型，便于连接到批量图片专用接口。"
    SEARCH_ALIASES = ["批量图片适配", "GJJ_BATCH_IMAGE", "图片包装", "批量图片桥"]
    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE",)
    RETURN_NAMES = ("批量图片",)
    OUTPUT_TOOLTIPS = ("把多路图片按输入顺序打包为 GJJ_BATCH_IMAGE；若尺寸不一致，会自动补齐到统一尺寸。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": FlexibleBatchImageInputType(
                {
                    "image_01": (
                        "IMAGE",
                        {
                            "display_name": "图片 1",
                            "tooltip": "可接单张 IMAGE 或 IMAGE batch；节点会自动补出更多图片输入口并按顺序打包。",
                        },
                    ),
                }
            ),
        }

    def wrap(self, **kwargs):
        merged_images: list[torch.Tensor] = []
        for key in sorted(kwargs.keys(), key=_extract_input_index):
            if key != "image" and not str(key).startswith("image_"):
                continue
            merged_images.extend(_split_image_batch(kwargs.get(key)))
        return (_build_uniform_batch(merged_images),)


class GJJ_BatchImageToImage:
    CATEGORY = "GJJ"
    FUNCTION = "unwrap"
    DESCRIPTION = "把 GJJ 专用批量图片类型还原为普通 IMAGE，便于接到通用节点。"
    SEARCH_ALIASES = ["批量图片解包", "GJJ_BATCH_IMAGE", "图片解包", "批量图片桥"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像输出",)
    OUTPUT_TOOLTIPS = ("把 GJJ_BATCH_IMAGE 直接还原为普通 IMAGE batch，不改像素数据。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "batch_image": (
                    GJJ_BATCH_IMAGE_TYPE,
                    {
                        "display_name": "批量图片输入",
                        "tooltip": "接入 GJJ 专用批量图片；节点只做类型解包，不修改内容。",
                    },
                ),
            }
        }

    def unwrap(self, batch_image):
        return (batch_image,)


class GuojijunBatchImagePreview:
    CATEGORY = "guojijun/内部引用"
    FUNCTION = "preview"
    OUTPUT_NODE = True
    DEPRECATED = True
    DESCRIPTION = "guojijun 批量图片类型专用预览节点：接入批量图片队列，直接预览全部图片，并透传为普通 IMAGE batch。"
    SEARCH_ALIASES = []
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像批次",)
    OUTPUT_TOOLTIPS = ("透传出的普通 IMAGE batch，可继续连接通用图片节点。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "batch_image": (
                    GJJ_BATCH_IMAGE_TYPE,
                    {
                        "display_name": "guojijun 批量图片",
                        "tooltip": "接入 guojijun 批量图片队列；节点会预览全部图片，并输出普通 IMAGE batch。",
                    },
                ),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    def __init__(self):
        self.preview_image = PreviewImage()

    def preview(self, batch_image, prompt=None, extra_pnginfo=None):
        if not isinstance(batch_image, torch.Tensor):
            raise RuntimeError("guojijun 批量图片预览器需要接入有效的 GJJ_BATCH_IMAGE 张量。")
        images = batch_image
        if images.ndim == 3:
            images = images.unsqueeze(0)
        if images.ndim != 4 or int(images.shape[0]) <= 0:
            raise RuntimeError(f"guojijun 批量图片维度无效：{tuple(images.shape)}")
        images = _to_rgb_image(images.detach().float().contiguous())
        preview_ui = self.preview_image.save_images(
            images,
            filename_prefix="guojijun_BatchImagePreview",
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
        )
        return {
            "ui": {
                "preview_images": preview_ui.get("ui", {}).get("images", []),
                "preview_text": (f"guojijun 批量图片：{int(images.shape[0])} 张，尺寸 {int(images.shape[2])} x {int(images.shape[1])}",),
                "preview_kind": ("image",),
                "preview_item_count": (int(images.shape[0]),),
            },
            "result": (images,),
        }


NODE_CLASS_MAPPINGS = {
    IMAGE_TO_BATCH_NODE: GJJ_ImageToBatchImage,
    BATCH_TO_IMAGE_NODE: GJJ_BatchImageToImage,
    BATCH_PREVIEW_NODE: GuojijunBatchImagePreview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    IMAGE_TO_BATCH_NODE: "GJJ · 🧺 批量图片包装器",
    BATCH_TO_IMAGE_NODE: "GJJ · 📤 批量图片解包器",
    BATCH_PREVIEW_NODE: "guojijun · 批量图片预览器（内部引用）",
}
