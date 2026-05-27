from __future__ import annotations

import re
from typing import Any

import torch
import torch.nn.functional as F

NODE_NAME = "GJJ_ImageBatchMulti"
COMPAT_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE"


class FlexibleImageInputs(dict):
    """允许前端动态添加 image_02、image_03 ... 输入。"""

    def __init__(self):
        super().__init__(
            {
                "image_01": (
                    COMPAT_BATCH_IMAGE_TYPE,
                    {
                        "display_name": "图片 1",
                        "tooltip": "可连接普通 IMAGE 或 GJJ 批量图片；连接后会自动展开下一个输入口。",
                    },
                )
            }
        )

    def __getitem__(self, key):
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        if re.match(r"^image_\d+$", str(key or "")):
            return (
                COMPAT_BATCH_IMAGE_TYPE,
                {
                    "display_name": "图片",
                    "tooltip": "动态图片输入；支持普通 IMAGE 或 GJJ 批量图片。",
                },
            )
        raise KeyError(key)

    def __contains__(self, key):
        return dict.__contains__(self, key) or re.match(r"^image_\d+$", str(key or "")) is not None


def _image_input_index(name: str) -> int:
    match = re.match(r"^image_(\d+)$", str(name or ""))
    return int(match.group(1)) if match else 10**9


def _normalize_image_tensor(value: Any) -> torch.Tensor | None:
    if value is None or not isinstance(value, torch.Tensor):
        return None
    tensor = value.detach()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError("图片批量打包收到的图像张量维度不正确，应为 IMAGE 或 IMAGE batch。")
    return tensor.float().contiguous()


def _first_scalar(value: Any, default: int) -> int:
    if isinstance(value, (list, tuple)):
        return _first_scalar(value[0], default) if value else default
    try:
        return int(value)
    except Exception:
        return default


def _iter_image_frames(value: Any) -> list[torch.Tensor]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        frames: list[torch.Tensor] = []
        for item in value:
            frames.extend(_iter_image_frames(item))
        return frames

    tensor = _normalize_image_tensor(value)
    if tensor is None:
        return []
    return [tensor[index:index + 1].contiguous() for index in range(int(tensor.shape[0]))]


def _resize_image_batch(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    if image.shape[1] == height and image.shape[2] == width:
        return image

    source_height = int(image.shape[1])
    source_width = int(image.shape[2])
    if source_height <= 0 or source_width <= 0:
        raise RuntimeError("图片批量打包收到的图像尺寸无效，无法等比缩放。")

    scale = max(float(width) / float(source_width), float(height) / float(source_height))
    resized_width = max(1, int(round(source_width * scale)))
    resized_height = max(1, int(round(source_height * scale)))
    resized = F.interpolate(
        image.movedim(-1, 1),
        size=(resized_height, resized_width),
        mode="bilinear",
        align_corners=False,
    ).movedim(1, -1)

    top = max(0, (resized_height - height) // 2)
    left = max(0, (resized_width - width) // 2)
    return resized[:, top:top + height, left:left + width, :].contiguous()


def _match_channels(image: torch.Tensor, channels: int) -> torch.Tensor:
    current = int(image.shape[-1])
    if current == channels:
        return image
    if current > channels:
        return image[..., :channels].contiguous()
    pad = torch.ones(
        (*image.shape[:-1], channels - current),
        dtype=image.dtype,
        device=image.device,
    )
    return torch.cat((image, pad), dim=-1).contiguous()


def _collect_images(kwargs: dict[str, Any]) -> list[torch.Tensor]:
    images: list[torch.Tensor] = []
    for name in sorted(kwargs, key=_image_input_index):
        if not re.match(r"^image_\d+$", str(name or "")):
            continue
        images.extend(_iter_image_frames(kwargs.get(name)))
    return images


class GJJ_ImageBatchMulti:
    CATEGORY = "GJJ/图像"
    FUNCTION = "combine"
    INPUT_IS_LIST = True
    RETURN_TYPES = (COMPAT_BATCH_IMAGE_TYPE,)
    RETURN_NAMES = ("批量图像",)
    OUTPUT_TOOLTIPS = (
        "输出兼容 GJJ 批量图片和普通 IMAGE batch。第一帧为按宽高生成并反转得到的白色空图，后面依次追加已连接图片。",
    )
    DESCRIPTION = "零依赖图片批量打包：内部按宽高生成空图像并反转为白图，再与所有动态输入图片一起打包输出。"
    SEARCH_ALIASES = [
        "image batch multi",
        "ImageBatchMulti",
        "图片批量",
        "批量图片",
        "空图像",
        "反转图像",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": (
                    "INT",
                    {
                        "default": 1280,
                        "min": 1,
                        "max": 16384,
                        "step": 1,
                        "display_name": "宽度",
                        "tooltip": "内部空图像和输出批次统一使用的宽度，默认 1280。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 720,
                        "min": 1,
                        "max": 16384,
                        "step": 1,
                        "display_name": "高度",
                        "tooltip": "内部空图像和输出批次统一使用的高度，默认 720。",
                    },
                ),
            },
            "optional": FlexibleImageInputs(),
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def combine(self, width: int = 1280, height: int = 720, **kwargs):
        width = max(1, _first_scalar(width, 1280))
        height = max(1, _first_scalar(height, 720))

        images = _collect_images(kwargs)
        device = images[0].device if images else torch.device("cpu")
        dtype = images[0].dtype if images else torch.float32
        max_channels = max([3] + [int(image.shape[-1]) for image in images])

        empty = torch.zeros((1, height, width, max_channels), dtype=dtype, device=device)
        inverted_empty = 1.0 - empty
        batches = [inverted_empty]

        for image in images:
            normalized = _resize_image_batch(image.to(device=device, dtype=dtype), width, height)
            normalized = _match_channels(normalized, max_channels)
            batches.append(normalized.clamp(0.0, 1.0))

        return (torch.cat(batches, dim=0).contiguous().cpu(),)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageBatchMulti}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧺 图片批量打包"}
