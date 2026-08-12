from __future__ import annotations

from typing import Any

from .gjj_gemma_text_generate import (
    GJJ_GemmaTextGenerate,
    MEDIA_INPUT_TYPE,
    NODE_DESCRIPTION,
    _coerce_media_for_textgen,
    _find_text_encoder_path,
    _is_audio_media,
    _text_encoder_options,
)


NODE_NAME = "GJJ_TextGenerateLTX2Prompt"
MAX_REFERENCE_MEDIA = 15
DEFAULT_MODEL_FILTER_KEYWORDS = "gemma4_e2b_it"


def _merge_reference_media(values: list[Any]) -> tuple[Any, Any]:
    """Return one image batch and one audio value for ComfyUI's TextGenerate."""
    images: list[Any] = []
    audios: list[Any] = []
    for value in values:
        if value is None:
            continue
        if _is_audio_media(value):
            audios.append(value)
            continue
        image = _coerce_media_for_textgen(value)
        if image is not None:
            images.append(image)
    merged_image = None
    if images:
        try:
            import torch

            merged_image = torch.cat(images, dim=0)
        except Exception:
            merged_image = images[0]
    # Official multimodal tokenizers generally accept one AUDIO object. Preserve
    # the first connection deterministically; image/video references remain batched.
    return merged_image, (audios[0] if audios else None)


class GJJ_TextGenerateLTX2Prompt(GJJ_GemmaTextGenerate):
    CATEGORY = "GJJ/🧠 图文推理"
    DESCRIPTION = "LTX2 提示词生成紧凑单节点：内部加载模型，统一参考媒体口支持多路图片、视频和音频。"
    SEARCH_ALIASES = ["TextGenerateLTX2Prompt", "LTX2 Prompt", "LTX2提示词", "多媒体提示词"]
    OUTPUT_TOOLTIPS = ("✅ 时由模型生成 LTX2 提示词；✖️ 时不加载模型并原样输出用户文字。",)

    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()
        required = inputs["required"]
        clip_options, clip_config = required["clip_name"]
        preferred_clip = next(
            (name for name in clip_options if DEFAULT_MODEL_FILTER_KEYWORDS.lower() in str(name).lower()),
            clip_config.get("default"),
        )
        required["clip_name"] = (clip_options, {
            **clip_config,
            "default": preferred_clip,
        })
        required["prompt"] = ("STRING", {
            **required["prompt"][1],
            "display": "text",
            "hidden": False,
            "defaultInput": True,
            "display_name": "原生提示词",
        })
        required["model_filter_keywords"] = ("STRING", {
            **required["model_filter_keywords"][1],
            "default": DEFAULT_MODEL_FILTER_KEYWORDS,
        })
        required["passthrough"] = ("BOOLEAN", {
            "default": False,
            "display": "hidden",
            "hidden": True,
            "display_name": "模型生成",
            "tooltip": "✅ 加载模型生成；✖️ 不加载模型，直接原样输出用户输入的文字。",
        })
        optional = {
            "reference_resources": (MEDIA_INPUT_TYPE, {
                "display_name": "参考媒体",
                "tooltip": "支持图片、视频、音频；同一接口可连接最多 15 路参考媒体。",
            }),
        }
        for index in range(1, MAX_REFERENCE_MEDIA + 1):
            optional[f"reference_media_{index}"] = (MEDIA_INPUT_TYPE, {
                "display": "hidden",
                "hidden": True,
            })
        inputs["optional"] = optional
        return inputs

    def generate(self, passthrough: bool = False, reference_resources: Any = None, **kwargs):
        prompt = str(kwargs.get("prompt") or "")
        if not bool(passthrough):
            return (prompt,)
        clip_name = str(kwargs.get("clip_name") or "")
        if not _find_text_encoder_path(clip_name):
            expression = str(kwargs.get("model_filter_keywords") or "").strip().lower()
            groups = [[term for term in group.split() if term] for group in expression.split("|")]
            candidates = [
                name for name in _text_encoder_options()
                if not expression or any(all(term in name.lower() for term in group) for group in groups if group)
            ]
            if candidates:
                kwargs["clip_name"] = candidates[0]
        references = [reference_resources]
        references.extend(kwargs.pop(f"reference_media_{index}", None) for index in range(1, MAX_REFERENCE_MEDIA + 1))
        image, audio = _merge_reference_media(references)
        kwargs["media"] = audio if audio is not None and image is None else image
        if image is not None and audio is not None:
            kwargs["image"] = image
            kwargs["audio"] = audio
        return super().generate(**kwargs)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TextGenerateLTX2Prompt}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·🧠LTX2 提示词生成"}
