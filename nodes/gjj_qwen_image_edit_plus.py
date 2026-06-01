from __future__ import annotations

import math
import re
from typing import Any

import comfy.utils
import node_helpers
import torch
import torch.nn.functional as F

try:
    from .common_utils.dependency_checker import print_dependency_model_report
    from .common_utils.prompt_translation import (
        COMMON_PROMPT_TRANSLATE_API_PATH,
        TRANSLATION_DEPENDENCY_SPECS,
        TRANSLATION_MODEL_SUBDIR,
        as_bool,
        build_translation_environment_report,
        register_prompt_translation_api,
        send_translated_prompt,
        translate_prompt_pair,
    )
except ImportError:
    from common_utils.dependency_checker import print_dependency_model_report
    from common_utils.prompt_translation import (
        COMMON_PROMPT_TRANSLATE_API_PATH,
        TRANSLATION_DEPENDENCY_SPECS,
        TRANSLATION_MODEL_SUBDIR,
        as_bool,
        build_translation_environment_report,
        register_prompt_translation_api,
        send_translated_prompt,
        translate_prompt_pair,
    )


NODE_NAME = "GJJ_TextEncodeQwenImageEditPlus"
NODE_DISPLAY_NAME = "GJJ · 🖼️ 千问CLIP图像编码"
TRANSLATED_EVENT = "gjj_qwen_image_edit_prompt_translated"

_DESCRIPTION = (
    "Qwen Image Edit Plus 条件编码面板：正负提示词统一编辑，支持外部正向提示词、"
    "Opus-MT 中英翻译、条件零化、译后卸载、FluxKontext 推荐分辨率缩放和多参考潜在方法。"
    "单图按原生 TextEncodeQwenImageEdit 编码；多图接入 VAE 时使用 LazyImageStudio 同款 FireRed 平等参考编码。"
    "提示词写到图2/图3背景时，会自动把对应图片作为出图主画布。"
)

REFERENCE_LATENTS_METHODS = ["offset", "index", "uxo/uno", "index_timestep_zero"]
DEFAULT_REFERENCE_LATENTS_METHOD = "index_timestep_zero"
MAX_REFERENCE_IMAGES = 3
LAZY_REFERENCE_VL_SIZE = 384

PREFERED_KONTEXT_RESOLUTIONS = [
    (672, 1568),
    (688, 1504),
    (720, 1456),
    (752, 1392),
    (800, 1328),
    (832, 1248),
    (880, 1184),
    (944, 1104),
    (1024, 1024),
    (1104, 944),
    (1184, 880),
    (1248, 832),
    (1328, 800),
    (1392, 752),
    (1456, 720),
    (1504, 688),
    (1568, 672),
]

DEFAULT_LLAMA_TEMPLATE = (
    "<|im_start|>system\n"
    "Describe the key features of the input image (color, shape, size, texture, objects, background), "
    "then explain how the user's text instruction should alter or modify the image. Generate a new image "
    "that meets the user's requirements while maintaining consistency with the original input where appropriate."
    "<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"
)

_CN_NUMBER_MAP = {
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}

_TRANSLATION_ENVIRONMENT_REPORT = build_translation_environment_report(
    node_name=NODE_DISPLAY_NAME,
    description=(
        "Qwen 图像编辑编码本身可继续使用；只有开启翻译开关时需要这些依赖和本地模型。"
        f"模型请放到 {TRANSLATION_MODEL_SUBDIR}。"
    ),
)
if not _TRANSLATION_ENVIRONMENT_REPORT.get("available", True):
    try:
        print_dependency_model_report(_TRANSLATION_ENVIRONMENT_REPORT, title="GJJ Qwen图像编辑提示词翻译环境缺失")
    except Exception:
        pass

register_prompt_translation_api((COMMON_PROMPT_TRANSLATE_API_PATH,))


class FlexibleOptionalInputType(dict):
    def __init__(self, data: dict[str, Any] | None = None):
        super().__init__()
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        if _is_dynamic_image_key(key):
            return _image_input(_dynamic_image_index(key))
        raise KeyError(key)

    def __contains__(self, key):
        return key in self.data or _is_dynamic_image_key(key)


def _is_dynamic_image_key(name: Any) -> bool:
    text = str(name or "")
    return bool(re.fullmatch(r"image_\d+", text)) or text in {"main_image", "主图"}


def _dynamic_image_index(name: Any) -> int:
    text = str(name or "")
    if text in {"main_image", "主图"}:
        return 1
    match = re.fullmatch(r"image_(\d+)", text)
    if not match:
        return 999999
    try:
        return int(match.group(1))
    except Exception:
        return 999999


def _image_input(index: int):
    label = "主图" if int(index) == 1 else f"参考图 {int(index) - 1}"
    tip = (
        "主图会按 FluxKontext 推荐分辨率缩放，并作为本节点的图像输出。"
        if int(index) == 1
        else f"第 {int(index) - 1} 张参考图；参与 Qwen 图像编辑条件编码，不作为图像输出。"
    )
    return (
        "IMAGE",
        {
            "display_name": label,
            "tooltip": f"{tip} 连接最后一个图片口后会自动增加下一路。",
        },
    )


def _collect_images(kwargs: dict[str, Any]) -> list[torch.Tensor]:
    images: list[torch.Tensor] = []
    for key, value in sorted(kwargs.items(), key=lambda item: _dynamic_image_index(item[0])):
        if not _is_dynamic_image_key(key) or value is None:
            continue
        images.append(value)
    return images


def _parse_image_number(text: str) -> int | None:
    value = str(text or "").strip()
    if not value:
        return None
    if value.isdigit():
        return int(value)
    return _CN_NUMBER_MAP.get(value)


def _detect_background_image_index(prompts: list[str], image_count: int) -> int:
    if image_count <= 0:
        return 1

    patterns = [
        re.compile(r"(?:图像|图片|图)\s*([0-9一二两三四五六七八九]+)\s*(?:的|中|里)?\s*(?:背景|环境|场景)"),
        re.compile(r"(?:背景|环境|场景)\s*(?:为|是|用|使用|来自|来自于|of|from)?\s*(?:图像|图片|图)\s*([0-9一二两三四五六七八九]+)"),
        re.compile(r"(?:image|picture|photo)\s*([0-9]+)[^.\n,;，。；]{0,40}(?:background|scene|environment|backdrop)", re.I),
        re.compile(r"(?:background|scene|environment|backdrop)[^.\n,;，。；]{0,40}(?:image|picture|photo)\s*([0-9]+)", re.I),
    ]
    for prompt in prompts:
        text = str(prompt or "")
        for pattern in patterns:
            for match in pattern.finditer(text):
                number = _parse_image_number(match.group(1))
                if number is not None and 1 <= number <= image_count:
                    return number
    return 1


def _append_background_hint(prompt: str, background_index: int, image_count: int) -> str:
    text = str(prompt or "")
    if background_index <= 0 or background_index > image_count:
        return text
    hint = f" Use image {background_index} as the background/environment."
    if hint.lower().strip() in text.lower():
        return text
    return f"{text.rstrip()}{hint}" if text.strip() else hint.strip()


def _empty_image() -> torch.Tensor:
    return torch.zeros((1, 1, 1, 3), dtype=torch.float32)


def _image_size(image: torch.Tensor | None) -> tuple[int, int]:
    if image is None or not hasattr(image, "shape") or len(image.shape) < 3:
        return 0, 0
    return int(image.shape[2]), int(image.shape[1])


def _ceil_to_multiple(value: int, multiple: int = 8) -> int:
    multiple = max(1, int(multiple))
    return max(multiple, int(math.ceil(max(1, int(value)) / float(multiple))) * multiple)


def _fit_image_with_canvas_padding(
    image: torch.Tensor,
    target_width: int,
    target_height: int,
    upscale: str = "lanczos",
) -> torch.Tensor:
    source_height = int(image.shape[1])
    source_width = int(image.shape[2])
    target_width = _ceil_to_multiple(target_width, 8)
    target_height = _ceil_to_multiple(target_height, 8)
    if source_width == target_width and source_height == target_height:
        return image

    scale = min(
        float(target_width) / float(max(1, source_width)),
        float(target_height) / float(max(1, source_height)),
    )
    resized_width = min(target_width, max(8, int(round(source_width * scale))))
    resized_height = min(target_height, max(8, int(round(source_height * scale))))
    resized = comfy.utils.common_upscale(
        image.movedim(-1, 1),
        resized_width,
        resized_height,
        upscale,
        "disabled",
    ).movedim(1, -1)

    left = (target_width - resized_width) // 2
    top = (target_height - resized_height) // 2
    right = target_width - resized_width - left
    bottom = target_height - resized_height - top
    return F.pad(
        resized.movedim(-1, 1),
        (left, right, top, bottom),
        mode="constant",
        value=1.0,
    ).movedim(1, -1)


def _best_kontext_size(width: int, height: int) -> tuple[int, int]:
    if width <= 0 or height <= 0:
        return 0, 0
    aspect_ratio = float(width) / float(height)
    _delta, best_w, best_h = min(
        (abs(aspect_ratio - float(w) / float(h)), w, h)
        for w, h in PREFERED_KONTEXT_RESOLUTIONS
    )
    return int(best_w), int(best_h)


def _scale_flux_kontext(image: torch.Tensor | None) -> tuple[torch.Tensor | None, int, int]:
    if image is None:
        return None, 0, 0
    width, height = _image_size(image)
    best_w, best_h = _best_kontext_size(width, height)
    if best_w <= 0 or best_h <= 0:
        return image, width, height
    scaled = comfy.utils.common_upscale(
        image.movedim(-1, 1), best_w, best_h, "lanczos", "center"
    ).movedim(1, -1)
    return scaled, best_w, best_h


def _zero_conditioning(conditioning: Any):
    try:
        from nodes import ConditioningZeroOut

        return ConditioningZeroOut().zero_out(conditioning)[0]
    except Exception:
        try:
            zeroed = []
            for item in conditioning:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    cond = item[0]
                    meta = item[1].copy() if isinstance(item[1], dict) else item[1]
                    if hasattr(cond, "clone"):
                        cond = cond.clone()
                    if hasattr(cond, "zero_"):
                        cond.zero_()
                    if isinstance(meta, dict):
                        pooled_output = meta.get("pooled_output")
                        if pooled_output is not None and hasattr(pooled_output, "clone"):
                            meta["pooled_output"] = torch.zeros_like(pooled_output)
                        conditioning_lyrics = meta.get("conditioning_lyrics")
                        if conditioning_lyrics is not None and hasattr(conditioning_lyrics, "clone"):
                            meta["conditioning_lyrics"] = torch.zeros_like(conditioning_lyrics)
                        c_crossattn = meta.get("c_crossattn")
                        if c_crossattn is not None and hasattr(c_crossattn, "clone"):
                            meta["c_crossattn"] = torch.zeros_like(c_crossattn)
                    zeroed.append([cond, meta])
                else:
                    zeroed.append(item)
            return zeroed
        except Exception as exc:
            raise RuntimeError(f"条件零化失败：{exc}") from exc


def _normalize_reference_latents_method(method: Any) -> str:
    text = str(method or DEFAULT_REFERENCE_LATENTS_METHOD).strip() or DEFAULT_REFERENCE_LATENTS_METHOD
    if "uxo" in text or "uso" in text or "uno" in text:
        return "uxo"
    if text not in {"offset", "index", "index_timestep_zero"}:
        return DEFAULT_REFERENCE_LATENTS_METHOD
    return text


def _apply_reference_latents_method(conditioning: Any, method: Any):
    normalized = _normalize_reference_latents_method(method)
    try:
        return node_helpers.conditioning_set_values(conditioning, {"reference_latents_method": normalized})
    except Exception as exc:
        raise RuntimeError(f"FluxKontext 多参考潜在方法设置失败：{exc}") from exc


def _encode_qwen_image_edit_plus(
    clip: Any,
    prompt: str,
    vae: Any | None,
    images: list[torch.Tensor],
    latent_canvas_size: tuple[int, int] | None = None,
    lazy_reference_mode: bool = False,
):
    ref_latents = []
    images_vl = []
    image_prompt = ""
    canvas_w = int(latent_canvas_size[0]) if latent_canvas_size else 0
    canvas_h = int(latent_canvas_size[1]) if latent_canvas_size else 0
    lazy_reference_mode = bool(lazy_reference_mode and vae is not None and canvas_w > 0 and canvas_h > 0)

    for index, image in enumerate(images[:MAX_REFERENCE_IMAGES], start=1):
        if image is None:
            continue

        samples = image.movedim(-1, 1)
        current_w = int(samples.shape[3])
        current_h = int(samples.shape[2])
        if current_w <= 0 or current_h <= 0:
            continue

        if lazy_reference_mode:
            vae_image = _fit_image_with_canvas_padding(image, canvas_w, canvas_h)
            vl_image = _fit_image_with_canvas_padding(
                vae_image,
                LAZY_REFERENCE_VL_SIZE,
                LAZY_REFERENCE_VL_SIZE,
                "area",
            )
            images_vl.append(vl_image[:, :, :, :3])
            ref_latents.append(vae.encode(vae_image[:, :, :, :3]))
            image_prompt += f"Picture {index}: "
            continue

        total = int(384 * 384)
        scale_by = math.sqrt(total / (current_w * current_h))
        width = round(current_w * scale_by)
        height = round(current_h * scale_by)
        vl_image = comfy.utils.common_upscale(samples, width, height, "area", "disabled").movedim(1, -1)
        images_vl.append(vl_image[:, :, :, :3])

        if vae is not None:
            if canvas_w > 0 and canvas_h > 0:
                vae_image = _fit_image_with_canvas_padding(image, canvas_w, canvas_h)
            else:
                total = int(1024 * 1024)
                scale_by = math.sqrt(total / (current_w * current_h))
                width = round(current_w * scale_by / 8.0) * 8
                height = round(current_h * scale_by / 8.0) * 8
                vae_image = comfy.utils.common_upscale(samples, width, height, "area", "disabled").movedim(1, -1)
            ref_latents.append(vae.encode(vae_image[:, :, :, :3]))

        image_prompt += f"Picture {index}: <|vision_start|><|image_pad|><|vision_end|>"

    if lazy_reference_mode:
        tokens = clip.tokenize(image_prompt + str(prompt or ""), images=images_vl)
    else:
        tokens = clip.tokenize(image_prompt + str(prompt or ""), images=images_vl, llama_template=DEFAULT_LLAMA_TEMPLATE)
    conditioning = clip.encode_from_tokens_scheduled(tokens)
    if ref_latents:
        conditioning = node_helpers.conditioning_set_values(
            conditioning,
            {"reference_latents": ref_latents},
            append=True,
        )
    return conditioning


def _encode_qwen_image_edit_single(
    clip: Any,
    prompt: str,
    vae: Any | None,
    image: torch.Tensor | None,
):
    """Match ComfyUI's TextEncodeQwenImageEdit single-image path."""
    ref_latent = None
    images_vl = []
    if image is not None:
        samples = image.movedim(-1, 1)
        current_w = int(samples.shape[3])
        current_h = int(samples.shape[2])
        if current_w > 0 and current_h > 0:
            total = int(1024 * 1024)
            scale_by = math.sqrt(total / (current_w * current_h))
            width = round(current_w * scale_by)
            height = round(current_h * scale_by)
            scaled = comfy.utils.common_upscale(samples, width, height, "area", "disabled").movedim(1, -1)
            images_vl = [scaled[:, :, :, :3]]
            if vae is not None:
                ref_latent = vae.encode(scaled[:, :, :, :3])

    tokens = clip.tokenize(str(prompt or ""), images=images_vl)
    conditioning = clip.encode_from_tokens_scheduled(tokens)
    if ref_latent is not None:
        conditioning = node_helpers.conditioning_set_values(
            conditioning,
            {"reference_latents": [ref_latent]},
            append=True,
        )
    return conditioning


def _encode_text_conditioning(clip: Any, prompt: str):
    tokens = clip.tokenize(str(prompt or ""))
    return clip.encode_from_tokens_scheduled(tokens)


class GJJ_TextEncodeQwenImageEditPlus:
    CATEGORY = "GJJ/条件编码"
    FUNCTION = "encode"
    DESCRIPTION = _DESCRIPTION
    SEARCH_ALIASES = [
        "qwen image edit",
        "TextEncodeQwenImageEditPlus",
        "Qwen图像编辑",
        "Kontext缩放",
        "提示词翻译",
        "条件零化",
        "FluxKontext多参考潜在方法",
    ]
    RETURN_TYPES = ("IMAGE", "CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("主图", "正向条件", "负向条件")
    OUTPUT_TOOLTIPS = (
        "出图主画布经 FluxKontext 推荐分辨率处理后的图像；默认使用第 1 张，提示词指定图2/图3背景时会自动改用对应图片。",
        "Qwen Image Edit Plus 正向 CONDITIONING；多图时可在面板中选择是否写入 FluxKontext 多参考潜在方法。",
        "Qwen Image Edit Plus 负向 CONDITIONING；单图负向为空时按原生单图空负向编码，多图 FireRed/Lazy 参考模式下为空则 zero_out。",
    )
    GJJ_HELP = {
        "title": "Qwen图像编辑编码面板",
        "description": _DESCRIPTION,
        "usage": [
            "连接 CLIP 后，在面板里填写正向/负向提示词；正向提示词也可以从左侧输入口外部连接。",
            "图片口默认只显示 1 个；最后一个图片口连接后会自动新增下一口，断开多余空口会自动收回。",
            "开启 Kontext缩放 后，出图主画布会按 FluxKontextImageScale 的推荐分辨率缩放，并输出处理后的主图。",
            "只有 1 张图时，正负条件按原生 TextEncodeQwenImageEdit 方式编码：单图会缩放到约 1024x1024 像素量，并把同一图写入 reference_latents。",
            "提示词写到“图2的背景 / background of image 2”时，节点会静默把第 2 张图作为出图主画布；Qwen 编码里的图像编号仍按面板顺序保持图1、图2。",
            "多图且接入 VAE 后，最多取前 3 张图按 LazyImageStudio 的 FireRed 平等参考方式写入 reference_latents，图2/图3不会再作为缩小的小物件视觉贴片参与。",
            "面板底部可开启/关闭 FluxKontext 多参考潜在方法；该项只作用于多图条件，关闭后正负条件保持 Qwen 原始编码。",
            "复刻原版链路时，将本节点【主图】输出接 VAEEncode；需要图2当背景时按自然顺序接图1、图2即可。",
            "开启翻译会调用本地 Opus-MT 中英翻译模型；中文引号“...”中的内容会保持原文。",
            "单图负向为空时会按 TextEncodeQwenImageEdit 的空提示词方式编码；多图 FireRed/Lazy 参考模式负向为空时会静默 zero_out，减少参考图抵消。",
        ],
        "translation_notice": _TRANSLATION_ENVIRONMENT_REPORT.get("help_message", "")
        if not _TRANSLATION_ENVIRONMENT_REPORT.get("available", True)
        else "",
        "translation_install_cmd": _TRANSLATION_ENVIRONMENT_REPORT.get("install_cmd", ""),
        "translation_copy_text": _TRANSLATION_ENVIRONMENT_REPORT.get("copy_text", ""),
        "translation_model_download_url": _TRANSLATION_ENVIRONMENT_REPORT.get("model_download_url", ""),
        "dependencies": [spec.get("description", "") for spec in TRANSLATION_DEPENDENCY_SPECS],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": (
                    "CLIP",
                    {
                        "display_name": "CLIP",
                        "tooltip": "接入 Qwen Image Edit 使用的 CLIP / 文本编码器。",
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "正向提示词",
                        "tooltip": "由前端统一面板维护的正向提示词。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "负向提示词",
                        "tooltip": "由前端统一面板维护的负向提示词；主要用于统一翻译和工作流记录。",
                    },
                ),
                "zero_conditioning": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "条件零化",
                        "tooltip": "开启后负向按正向条件结构 zero_out；单图负向为空仍按原生空负向编码，多图 FireRed/Lazy 参考模式为空会自动 zero_out。",
                    },
                ),
                "apply_kontext_scale": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "Kontext缩放",
                        "tooltip": "开启后仅缩放【主图】，等价于原版先过 FluxKontextImageScale；参考图不缩放。",
                    },
                ),
                "translation_device": (
                    ["auto", "cpu", "gpu"],
                    {
                        "default": "auto",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "翻译设备",
                        "tooltip": "翻译按钮使用的设备。auto 会自动选择 GPU 或 CPU。",
                    },
                ),
                "translation_unload_after_use": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "翻译后卸载",
                        "tooltip": "翻译完成后是否卸载 Opus-MT 模型。",
                    },
                ),
                "translation_enabled": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "翻译开关",
                        "tooltip": "开启后点击会立即翻译当前面板文本；连接外部正向提示词时会显示译文。",
                    },
                ),
                "reference_latents_method": (
                    REFERENCE_LATENTS_METHODS,
                    {
                        "default": DEFAULT_REFERENCE_LATENTS_METHOD,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "参考潜在方法",
                        "tooltip": "等价于 FluxKontextMultiReferenceLatentMethod，会写入正负条件。",
                    },
                ),
                "apply_reference_latents_method": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "参考潜在方法开关",
                        "tooltip": "关闭后不写入 FluxKontext 多参考潜在方法，正负条件按 Qwen 原始编码输出。",
                    },
                ),
            },
            "optional": FlexibleOptionalInputType(
                {
                    "positive_prompt_input": (
                        "STRING",
                        {
                            "forceInput": True,
                            "display_name": "正向提示词",
                            "tooltip": "外部正向提示词输入；连接后优先使用此文本。",
                        },
                    ),
                    "vae": (
                        "VAE",
                        {
                            "display_name": "VAE",
                            "tooltip": "可选。连接后会写入 Qwen 图像编辑参考 latent。",
                        },
                    ),
                    "image_01": _image_input(1),
                }
            ),
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **_kwargs):
        return True

    def encode(self, *args, **kwargs):
        clip = kwargs.get("clip", None)
        if clip is None:
            raise RuntimeError("请连接 CLIP 输入。")

        unique_id = kwargs.get("unique_id", None)
        external_positive = kwargs.get("positive_prompt_input", None)
        translation_enabled = as_bool(kwargs.get("translation_enabled", False))
        translation_device = str(kwargs.get("translation_device", "auto") or "auto")
        translation_unload_after_use = as_bool(kwargs.get("translation_unload_after_use", False))
        zero_conditioning = as_bool(kwargs.get("zero_conditioning", False))
        apply_kontext_scale = as_bool(kwargs.get("apply_kontext_scale", True))
        apply_reference_latents_method = as_bool(kwargs.get("apply_reference_latents_method", True))
        reference_latents_method = kwargs.get("reference_latents_method", DEFAULT_REFERENCE_LATENTS_METHOD)
        negative_prompt = str(kwargs.get("negative_prompt", "") or "")

        if external_positive is not None:
            source_positive_prompt = str(external_positive or "")
            positive_prompt = source_positive_prompt
            if translation_enabled:
                translated = translate_prompt_pair(
                    positive=positive_prompt,
                    negative=negative_prompt,
                    device=translation_device,
                    max_length=512,
                    batch_size=8,
                    unload_after_use=translation_unload_after_use,
                    unique_id=unique_id,
                    node_name=NODE_DISPLAY_NAME,
                )
                positive_prompt = str(translated.get("positive", "") or "")
                negative_prompt = str(translated.get("negative", "") or "")
                send_translated_prompt(
                    unique_id,
                    positive=positive_prompt,
                    negative=negative_prompt,
                    event_name=TRANSLATED_EVENT,
                )
        else:
            source_positive_prompt = str(kwargs.get("positive_prompt", "") or "")
            positive_prompt = source_positive_prompt
            if translation_enabled:
                translated = translate_prompt_pair(
                    positive=positive_prompt,
                    negative=negative_prompt,
                    device=translation_device,
                    max_length=512,
                    batch_size=8,
                    unload_after_use=translation_unload_after_use,
                    unique_id=unique_id,
                    node_name=NODE_DISPLAY_NAME,
                )
                positive_prompt = str(translated.get("positive", "") or "")
                negative_prompt = str(translated.get("negative", "") or "")
                send_translated_prompt(
                    unique_id,
                    positive=positive_prompt,
                    negative=negative_prompt,
                    event_name=TRANSLATED_EVENT,
                )

        images = _collect_images(kwargs)
        background_index = _detect_background_image_index(
            [source_positive_prompt, positive_prompt],
            len(images),
        )
        if background_index > 1:
            positive_prompt = _append_background_hint(positive_prompt, background_index, len(images))

        preview_image: torch.Tensor | None = None
        width, height = 0, 0

        for index, image in enumerate(images, start=1):
            if image is None:
                continue
            if index == background_index:
                if apply_kontext_scale:
                    scaled, scaled_w, scaled_h = _scale_flux_kontext(image)
                    preview_image = scaled if scaled is not None else image
                    width, height = scaled_w, scaled_h
                else:
                    width, height = _image_size(image)
                    preview_image = image

        if preview_image is None:
            preview_image = images[0] if images else _empty_image()
            if images:
                width, height = _image_size(preview_image)
        if not images:
            width, height = 0, 0

        latent_canvas_size = (int(width), int(height)) if width > 0 and height > 0 else None
        vae = kwargs.get("vae", None)
        single_image_mode = len(images) == 1
        lazy_reference_mode = bool(vae is not None and len(images) > 1 and latent_canvas_size is not None)

        if single_image_mode:
            single_image = preview_image if preview_image is not None else images[0]
            positive_conditioning = _encode_qwen_image_edit_single(
                clip=clip,
                prompt=positive_prompt,
                vae=vae,
                image=single_image,
            )
        else:
            positive_conditioning = _encode_qwen_image_edit_plus(
                clip=clip,
                prompt=positive_prompt,
                vae=vae,
                images=images,
                latent_canvas_size=latent_canvas_size,
                lazy_reference_mode=lazy_reference_mode,
            )
            if apply_reference_latents_method:
                positive_conditioning = _apply_reference_latents_method(positive_conditioning, reference_latents_method)

        should_zero_negative = (
            (single_image_mode and zero_conditioning and bool(negative_prompt.strip()))
            or (not single_image_mode and (zero_conditioning or (lazy_reference_mode and not negative_prompt.strip())))
        )
        if should_zero_negative:
            negative_conditioning = _zero_conditioning(positive_conditioning)
        elif single_image_mode:
            negative_conditioning = _encode_qwen_image_edit_single(
                clip=clip,
                prompt=negative_prompt,
                vae=vae,
                image=single_image,
            )
        elif lazy_reference_mode:
            negative_conditioning = _encode_text_conditioning(clip, negative_prompt)
        else:
            negative_conditioning = _encode_qwen_image_edit_plus(
                clip=clip,
                prompt=negative_prompt,
                vae=vae,
                images=images,
                latent_canvas_size=latent_canvas_size,
                lazy_reference_mode=False,
            )
            if apply_reference_latents_method:
                negative_conditioning = _apply_reference_latents_method(negative_conditioning, reference_latents_method)

        return (preview_image, positive_conditioning, negative_conditioning)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TextEncodeQwenImageEditPlus}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
