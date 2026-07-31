from __future__ import annotations

import math
from typing import Any

import comfy.utils
import node_helpers
import torch

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_TextEncodeBooguEdit"
IMAGE_INPUT_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
MAX_IMAGE_INPUTS = 16


class FlexibleImageInputs(dict):
    def __init__(self, data: dict[str, Any] | None = None):
        super().__init__()
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        index = _image_input_index(key)
        if 1 <= index <= MAX_IMAGE_INPUTS:
            return _image_input(index)
        raise KeyError(key)

    def __contains__(self, key):
        return key in self.data or 1 <= _image_input_index(key) <= MAX_IMAGE_INPUTS


def _image_input_index(name: Any) -> int:
    text = str(name or "")
    if not text.startswith("image_"):
        return 0
    try:
        return int(text.split("_", 1)[1])
    except Exception:
        return 0


def _image_input(index: int):
    return (
        IMAGE_INPUT_TYPE,
        {
            "display_name": "图片" if int(index) == 1 else f"图片 {int(index)}",
            "tooltip": "支持 GJJ_BATCH_IMAGE 或 IMAGE。若接入批量图，会按批次顺序拆成多张 Boogu 参考图；连接最后一路后会自动增加下一路。",
        },
    )


def _looks_like_image_tensor(value: Any) -> bool:
    if not isinstance(value, torch.Tensor):
        return False
    try:
        shape = tuple(int(item) for item in value.shape)
    except Exception:
        return False
    return (
        (len(shape) == 4 and shape[-1] in (1, 3, 4))
        or (len(shape) == 3 and shape[-1] in (1, 3, 4))
    )


def _split_image_tensor(value: torch.Tensor) -> list[torch.Tensor]:
    if value.ndim == 3 and int(value.shape[-1]) in (1, 3, 4):
        return [value.unsqueeze(0).float().clamp(0.0, 1.0).contiguous()]
    if value.ndim == 4 and int(value.shape[-1]) in (1, 3, 4):
        batch = value.float().clamp(0.0, 1.0).contiguous()
        return [batch[index:index + 1].contiguous() for index in range(int(batch.shape[0]))]
    return []


def _iter_image_container(value: Any) -> list[Any]:
    if value is None or isinstance(value, (str, bytes, bytearray)):
        return []
    if isinstance(value, torch.Tensor):
        return []

    if isinstance(value, dict):
        common_names = (
            "images", "image", "imgs", "batch", "batches", "queue", "items",
            "data", "samples", "frames", "outputs", "values", "selected",
            "selected_images", "image_list", "image_queue", "pictures", "pics",
            "图片", "图像", "图片列表", "批量图片", "批量图片队列",
            "result", "results", "output",
        )
        preferred = []
        for name in common_names:
            if name in value and value.get(name) is not value:
                preferred.append(value.get(name))
        return preferred or list(value.values())

    if isinstance(value, (list, tuple, set)):
        return list(value)

    values: list[Any] = []
    common_names = (
        "images", "image", "imgs", "batch", "batches", "queue", "items",
        "data", "samples", "frames", "outputs", "values", "selected",
        "selected_images", "image_list", "image_queue", "pictures", "pics",
        "图片", "图像", "图片列表", "批量图片", "批量图片队列",
        "result", "results", "output",
    )
    for name in common_names:
        try:
            child = getattr(value, name, None)
            if child is not None and child is not value:
                values.append(child)
        except Exception:
            pass

    try:
        data = vars(value)
        if isinstance(data, dict):
            values.extend(data.values())
    except Exception:
        pass

    try:
        if hasattr(value, "_asdict"):
            data = value._asdict()
            if isinstance(data, dict):
                values.extend(data.values())
    except Exception:
        pass

    return values


def _collect_images(value: Any, seen: set[int] | None = None) -> list[torch.Tensor]:
    if seen is None:
        seen = set()
    if value is None:
        return []

    oid = id(value)
    if oid in seen:
        return []
    seen.add(oid)

    if _looks_like_image_tensor(value):
        return _split_image_tensor(value)

    images: list[torch.Tensor] = []
    for child in _iter_image_container(value):
        images.extend(_collect_images(child, seen))
    return images


def _ordered_images(kwargs: dict[str, Any]) -> list[torch.Tensor]:
    images: list[torch.Tensor] = []
    image_keys = [
        key for key in kwargs
        if 1 <= _image_input_index(key) <= MAX_IMAGE_INPUTS
    ]
    for key in sorted(image_keys, key=_image_input_index):
        images.extend(_collect_images(kwargs.get(key)))
    return images


def _scale_samples(samples: torch.Tensor, pixel_total: int, align: int | None = None) -> torch.Tensor:
    height = int(samples.shape[2])
    width = int(samples.shape[3])
    if height <= 0 or width <= 0:
        raise RuntimeError("Boogu Edit 编码失败：图片尺寸无效。")

    scale_by = math.sqrt(float(pixel_total) / float(width * height))
    target_width = max(1, round(width * scale_by))
    target_height = max(1, round(height * scale_by))
    if align and align > 1:
        target_width = max(align, round(target_width / float(align)) * align)
        target_height = max(align, round(target_height / float(align)) * align)
    return comfy.utils.common_upscale(samples, target_width, target_height, "area", "disabled")


class GJJ_TextEncodeBooguEdit:
    CATEGORY = "GJJ/条件编码/博古"
    FUNCTION = "encode"
    DESCRIPTION = (
        "GJJ 零依赖 Boogu-Image Edit 条件编码节点。复刻 TextEncodeBooguEdit，图片输入兼容 "
        "GJJ_BATCH_IMAGE 和 IMAGE；多路图片会按 image_1 到 image_16 的顺序展开，批量图按批次顺序拆开。"
    )
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative")
    OUTPUT_TOOLTIPS = (
        "包含提示词、Boogu VLM 参考图 token，以及可选 reference_latents 的正向条件。",
        "包含负向提示词，以及与正向相同的 reference_latents。Boogu 参考 latent 会在 CFG 下抵消以保留身份。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        optional: dict[str, Any] = {
            "negative_prompt": (
                "STRING",
                {
                    "default": "",
                    "multiline": False,
                    "dynamicPrompts": True,
                    "display_name": "负向提示词",
                },
            ),
            "vae": ("VAE", {"display_name": "VAE"}),
            "image_1": _image_input(1),
        }

        return {
            "required": {
                "clip": ("CLIP", {"display_name": "CLIP"}),
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "提示词",
                    },
                ),
            },
            "optional": FlexibleImageInputs(optional),
        }

    def encode(
        self,
        clip,
        prompt: str,
        negative_prompt: str = "",
        vae=None,
        **kwargs,
    ):
        ref_latents = []
        images_vl = []

        for image in _ordered_images(kwargs):
            samples = image.movedim(-1, 1)

            vl_samples = _scale_samples(samples, 384 * 384)
            images_vl.append(vl_samples.movedim(1, -1)[:, :, :, :3])

            if vae is not None:
                latent_samples = _scale_samples(samples, 1024 * 1024, align=16)
                ref_latents.append(vae.encode(latent_samples.movedim(1, -1)[:, :, :, :3]))

        positive = clip.encode_from_tokens_scheduled(
            clip.tokenize(str(prompt or ""), images=images_vl)
        )
        negative = clip.encode_from_tokens_scheduled(
            clip.tokenize(str(negative_prompt or ""))
        )

        if ref_latents:
            positive = node_helpers.conditioning_set_values(
                positive,
                {"reference_latents": ref_latents},
                append=True,
            )
            negative = node_helpers.conditioning_set_values(
                negative,
                {"reference_latents": ref_latents},
                append=True,
            )

        return (positive, negative)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TextEncodeBooguEdit}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · Boogu图像编辑编码"}
