from __future__ import annotations

from typing import Any

import comfy.samplers
import folder_paths
from nodes import CLIPTextEncode, CheckpointLoaderSimple, EmptyLatentImage, MAX_RESOLUTION, VAEEncodeForInpaint


NODE_NAME = "GJJ_ControlNetPreset"
DEFAULT_CHECKPOINT = "interiordesignsuperm_v2.safetensors"


def _preferred_default(values: list[str], preferred: str) -> str:
    preferred = str(preferred or "").strip()
    if preferred and preferred in values:
        return preferred
    return values[0] if values else ""


def _normalize_text(value: Any) -> str:
    return str(value or "")


def _normalize_int(value: Any, fallback: int, minimum: int = 1) -> int:
    try:
        resolved = int(value)
    except Exception:
        resolved = int(fallback)
    return max(minimum, resolved)


def _resolve_image_size(image: Any) -> tuple[int, int] | None:
    shape = getattr(image, "shape", None)
    if not shape:
        return None

    try:
        dims = [int(item) for item in shape]
    except Exception:
        return None

    if len(dims) < 3:
        return None

    height = dims[-3]
    width = dims[-2]
    if width <= 0 or height <= 0:
        return None
    return width, height


class GJJ_ControlNetPreset:
    CATEGORY = "GJJ"
    FUNCTION = "build"
    DESCRIPTION = "内部加载 checkpoint、编码正反提示词，并根据图像与遮罩生成可直接连接到 KSampler 的模型、条件和 latent。"
    SEARCH_ALIASES = [
        "controlnet preset",
        "ksampler preset",
        "checkpoint prompt latent",
        "controlnet",
        "局部重绘预设",
        "采样预设",
    ]
    RETURN_TYPES = ("MODEL", "CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("采样模型输出", "正向条件输出", "反向条件输出", "潜空间输出")
    OUTPUT_TOOLTIPS = (
        "内部 checkpoint 加载后的模型输出，可直接连接到 KSampler 的 model。",
        "正向提示词编码后的正面条件，可直接连接到 KSampler 的 positive。",
        "反向提示词编码后的负面条件，可直接连接到 KSampler 的 negative。",
        "根据图像遮罩生成的 inpaint latent，或在无图像时按宽高创建的空 latent，可直接连接到 KSampler 的 latent_image。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = list(folder_paths.get_filename_list("checkpoints")) or [""]
        return {
            "required": {
                "ckpt_name": (
                    checkpoints,
                    {
                        "default": _preferred_default(checkpoints, DEFAULT_CHECKPOINT),
                        "display_name": "Checkpoint 模型",
                        "tooltip": "内部加载的基础模型，默认使用 models/checkpoints/interiordesignsuperm_v2.safetensors。",
                    },
                ),
                "positive": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": True,
                        "placeholder": "请输入正向提示词",
                        "display_name": "正向提示词",
                        "tooltip": "正向提示词，节点内部会编码成正面条件输出。",
                    },
                ),
                "negative": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": True,
                        "placeholder": "请输入反向提示词",
                        "display_name": "反向提示词",
                        "tooltip": "反向提示词，节点内部会编码成负面条件输出。",
                    },
                ),
                "latent_width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 16,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "宽度",
                        "tooltip": "无图像输入时用于生成空 latent 的宽度；接入图像后会自动同步成图片宽度。",
                    },
                ),
                "latent_height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 16,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "高度",
                        "tooltip": "无图像输入时用于生成空 latent 的高度；接入图像后会自动同步成图片高度。",
                    },
                ),
                "grow_mask_by": (
                    "INT",
                    {
                        "default": 6,
                        "min": 0,
                        "max": 64,
                        "step": 1,
                        "display_name": "扩展遮罩",
                        "tooltip": "使用图像与遮罩生成 inpaint latent 时，额外扩展遮罩像素以提升边缘融合。",
                    },
                ),
            },
            "optional": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "输入图像",
                        "tooltip": "可选图像输入；接入图像和遮罩后会生成 inpaint latent，并自动同步宽高。",
                    },
                ),
                "mask": (
                    "MASK",
                    {
                        "display_name": "输入遮罩",
                        "tooltip": "可选遮罩输入；需与图像一起使用，白色区域表示需要重绘的区域。",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        ckpt_name,
        positive,
        negative,
        latent_width,
        latent_height,
        grow_mask_by,
        image=None,
        mask=None,
    ):
        return "|".join(
            [
                str(ckpt_name),
                str(positive),
                str(negative),
                str(latent_width),
                str(latent_height),
                str(grow_mask_by),
                str(getattr(image, "shape", "")),
                str(getattr(mask, "shape", "")),
            ]
        )

    def build(
        self,
        ckpt_name,
        positive,
        negative,
        latent_width,
        latent_height,
        grow_mask_by,
        image=None,
        mask=None,
    ):
        model, clip, vae = CheckpointLoaderSimple().load_checkpoint(ckpt_name)

        resolved_positive = _normalize_text(positive)
        resolved_negative = _normalize_text(negative)
        resolved_width = _normalize_int(latent_width, latent_width, minimum=16)
        resolved_height = _normalize_int(latent_height, latent_height, minimum=16)

        image_size = _resolve_image_size(image)
        if image_size is not None:
            resolved_width, resolved_height = image_size

        positive_conditioning = CLIPTextEncode().encode(clip, resolved_positive)[0]
        negative_conditioning = CLIPTextEncode().encode(clip, resolved_negative)[0]

        if image is not None and mask is not None:
            latent = VAEEncodeForInpaint().encode(vae, image, mask, grow_mask_by)[0]
        else:
            latent = EmptyLatentImage().generate(resolved_width, resolved_height, 1)[0]

        return {
            "ui": {
                "resolved_width": [resolved_width],
                "resolved_height": [resolved_height],
                "positive": [resolved_positive],
                "negative": [resolved_negative],
            },
            "result": (
                model,
                positive_conditioning,
                negative_conditioning,
                latent,
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ControlNetPreset}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎛️ ControlNet采样预设器"}
