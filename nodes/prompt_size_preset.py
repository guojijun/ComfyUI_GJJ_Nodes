from __future__ import annotations

from typing import Any

from nodes import CLIPTextEncode, ConditioningZeroOut, MAX_RESOLUTION, EmptyLatentImage


NODE_NAME = "GJJ_PromptSizePreset"
ASPECT_RATIO_OPTIONS = [
    "1:1",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
    "16:9",
    "9:16",
    "21:9",
    "9:21",
    "5:4",
    "4:5",
]
DEFAULT_NEGATIVE_PROMPT = (
    "bad hands, missing fingers, extra fingers, deformed hands, broken limbs, malformed limbs, "
    "ugly feet, wrong anatomy, distorted limbs, fused fingers, missing hands, extra hands, "
    "disfigured, mutated, extra limbs, missing limbs, floating limbs, disconnected limbs"
)


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


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


class GJJ_PromptSizePreset:
    CATEGORY = "GJJ"
    FUNCTION = "preset"
    DESCRIPTION = "整合提示词输入、尺寸预设、图像尺寸同步与空 Latent 生成，并直接输出可接 KSampler 的正反条件。"
    SEARCH_ALIASES = [
        "prompt size preset",
        "prompt latent preset",
        "提示词",
        "空latent",
        "尺寸预设",
        "图像尺寸",
        "conditioning",
    ]
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT", "INT", "INT", "INT")
    RETURN_NAMES = ("正向条件输出", "反向条件输出", "空白潜空间", "推荐生成宽度", "推荐生成高度", "推荐生成批次")
    OUTPUT_TOOLTIPS = (
        "当前节点最终生效的正向提示词经 CLIP 编码后的正面条件，可直接连接到 KSampler 的 positive。",
        "当前节点最终生效的反向提示词经 CLIP 编码后的反面条件，可直接连接到 KSampler 的 negative。",
        "基于当前宽高和批次数生成的空 Latent 输出，可直接连接到 KSampler 的 latent_image。",
        "当前节点最终生效的宽度输出；若接入图像，会自动改成图像宽度。",
        "当前节点最终生效的高度输出；若接入图像，会自动改成图像高度。",
        "当前节点最终生效的批次数输出。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "aspect_ratio": (
                    ASPECT_RATIO_OPTIONS,
                    {
                        "default": "1:1",
                        "display_name": "比例",
                        "tooltip": "底部横向 / 纵向按钮和常用尺寸按钮都会基于这里的比例计算宽高。",
                    },
                ),
                "empty_latent_width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 16,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "宽度",
                        "tooltip": "当前空 Latent 宽度；点底部预设按钮或接入图像后会自动同步。",
                    },
                ),
                "empty_latent_height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 16,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "高度",
                        "tooltip": "当前空 Latent 高度；点底部预设按钮或接入图像后会自动同步。",
                    },
                ),
                "positive": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": True,
                        "placeholder": "请输入正向提示词",
                        "display_name": "正向提示词",
                        "tooltip": "输入要传给后续流程的正向提示词文本。",
                    },
                ),
                "negative": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE_PROMPT,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "placeholder": "请输入反向提示词",
                        "display_name": "反向提示词",
                        "tooltip": "输入要传给后续流程的反向提示词文本；已内置常用反向默认词。",
                    },
                ),
                "batch_size": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 4096,
                        "display_name": "批次数",
                        "tooltip": "当前空 Latent 的批次数。",
                    },
                ),
                "clip": (
                    "CLIP",
                    {
                        "display_name": "CLIP输入",
                        "tooltip": "用于把正向提示词和反向提示词编码成条件输出；这是必填输入。",
                    },
                ),
            },
            "optional": {
                "image_size_source": (
                    "IMAGE",
                    {
                        "display_name": "获取图像尺寸",
                        "tooltip": "接入图像后会优先读取图像宽高，并同步到当前宽度和高度。",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        aspect_ratio,
        empty_latent_width,
        empty_latent_height,
        positive,
        negative,
        batch_size,
        clip,
        image_size_source=None,
    ):
        return "|".join(
            [
                str(aspect_ratio),
                str(empty_latent_width),
                str(empty_latent_height),
                str(positive),
                str(negative),
                str(batch_size),
                str(clip is not None),
                str(getattr(image_size_source, "shape", "")),
            ]
        )

    def preset(
        self,
        aspect_ratio,
        empty_latent_width,
        empty_latent_height,
        positive,
        negative,
        batch_size,
        clip,
        image_size_source=None,
    ):
        if clip is None:
            raise RuntimeError("CLIP 输入不能为空，当前节点需要用 CLIP 把提示词编码成条件。")

        resolved_positive = _normalize_text(positive)
        resolved_negative = _normalize_text(negative)
        resolved_batch_size = _normalize_int(batch_size, batch_size, minimum=1)
        resolved_width = _normalize_int(empty_latent_width, empty_latent_width, minimum=16)
        resolved_height = _normalize_int(empty_latent_height, empty_latent_height, minimum=16)

        image_size = _resolve_image_size(image_size_source)
        if image_size is not None:
            resolved_width, resolved_height = image_size

        positive_conditioning = CLIPTextEncode().encode(clip, resolved_positive)[0]
        if resolved_negative:
            negative_conditioning = CLIPTextEncode().encode(clip, resolved_negative)[0]
        else:
            negative_conditioning = ConditioningZeroOut().zero_out(positive_conditioning)[0]

        latent = EmptyLatentImage().generate(resolved_width, resolved_height, resolved_batch_size)[0]
        short_edge = min(resolved_width, resolved_height)
        long_edge = max(resolved_width, resolved_height)

        return {
            "ui": {
                "resolved_width": [resolved_width],
                "resolved_height": [resolved_height],
                "resolved_batch_size": [resolved_batch_size],
                "resolved_short_edge": [short_edge],
                "resolved_long_edge": [long_edge],
                "positive": [resolved_positive],
                "negative": [resolved_negative],
                "aspect_ratio": [str(aspect_ratio or "1:1")],
            },
            "result": (
                positive_conditioning,
                negative_conditioning,
                latent,
                resolved_width,
                resolved_height,
                resolved_batch_size,
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_PromptSizePreset}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📐 提示词尺寸预设CLIP编码"}
