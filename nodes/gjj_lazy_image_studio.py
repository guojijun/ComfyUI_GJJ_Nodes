from __future__ import annotations

import json
import hashlib
import math
import os
import re
import time
import weakref
from pathlib import Path
from typing import Any

import comfy.lora
import comfy.lora_convert
import comfy.model_management
import comfy.model_sampling
import comfy.samplers
import comfy.sd
import comfy.utils
import folder_paths
import node_helpers
import torch
import torch.nn.functional as F
from PIL import Image, ImageDraw, ImageFont
from nodes import (
    CheckpointLoaderSimple,
    EmptyLatentImage,
    VAEDecode,
    VAEEncode,
    VAEEncodeForInpaint,
    common_ksampler,
)

try:
    from nodes import EmptySD3LatentImage
except ImportError:
    # 如果 EmptySD3LatentImage 不可用，使用内置实现或占位符
    EmptySD3LatentImage = None

from .common_utils.text_tools import (
    gjjutils_normalize_text as _normalize_text,
    gjjutils_canonical_model_text as _canonical_model_text,
    gjjutils_dedupe_keep_order as _dedupe_keep_order,
)
from .common_utils.temp_files import gjjutils_write_temp_tensor_images
from .common_utils.dependency_checker import (
    DEFAULT_MODEL_URL,
    is_comfyui_model_compatibility_error,
    raise_comfyui_model_compatibility_error,
)

from .common_utils.sampler_tools import (
    EmptyFlux2LatentImage_execute as EmptyFlux2LatentImage,
    Flux2Scheduler_execute as Flux2Scheduler,
    RandomNoise_execute as RandomNoise,
    KSamplerSelect_execute as KSamplerSelect,
    CFGGuider_execute as CFGGuider,
    SamplerCustomAdvanced_execute as SamplerCustomAdvanced,
)
from .common_utils.prompt_translation import (
    COMMON_PROMPT_TRANSLATE_API_PATH,
    register_prompt_translation_api,
)
from .common_utils.lora_triggers import append_lora_triggers_to_positive_prompt
from .gjj_model_bundle_loader import (
    UNET_DTYPE_OPTIONS,
    _build_unet_model_options,
    _load_boogu_clip_compatible,
    _raise_if_unsupported_boogu_diffusion,
    _resolve_full_path,
    list_clip_models,
    list_unet_models,
    list_vae_models,
)
from .gjj_model_patch_bundle import (
    GJJ_ModelPatchBundle,
    MISSING_SAGE_HANDLING_MODES,
    SAGE_ATTENTION_MODES,
)
from .common_utils.model_manager import (
    gjjutils_find_model_list,
    gjjutils_model_stem_without_quant,
)
from .common_utils.model_family import (
    gjjutils_model_family_match_preset as match_model_family,
    gjjutils_model_family_resolve_clip_type as resolve_clip_type,
    gjjutils_model_family_resolve_clip_names as resolve_clip_names_for_preset,
    gjjutils_model_family_pick_lora_name as _pick_available_lora_name,
    gjjutils_model_family_pick_model_name as _pick_available_name,
    MODEL_FAMILY_PRESETS,
    CLIP_TYPE_KEYWORDS,
)
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE
from .common_utils.mage_flow_runtime import (
    encode_conditioning as encode_mage_flow_conditioning,
    is_mage_flow_name,
    make_empty_latent as make_mage_flow_empty_latent,
    safe_bf16_accumulation as mage_flow_safe_bf16_accumulation,
)
from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .gjj_multi_lora_chain import (
    apply_lora_chain_config,
    build_lora_trigger_text,
    clean_lora_config_name,
    normalize_lora_chain_data,
    parse_lora_data,
)
from .gjj_multi_image_loader import (
    load_image_tensor,
    parse_selected_images,
    resolve_input_image_path,
)
from .gjj_krea2_grounded_encode import (
    GJJ_Krea2EditGroundedEncode as _GJJKrea2EditGroundedEncode,
)
from .gjj_krea2_edit_model_patch import (
    GJJ_Krea2EditModelPatch as _GJJKrea2EditModelPatch,
    LORA_FILENAME as KREA2_IDENTITY_EDIT_LORA,
)
from .gjj_text_encode_boogu_edit import GJJ_TextEncodeBooguEdit

try:
    from .gjj_ltx2_nag import GJJ_LTX2NAG as _GJJLTX2NAG
except Exception:  # pragma: no cover - 允许单文件语法检查环境缺少运行时依赖
    _GJJLTX2NAG = None

try:
    from .gjj_wanvideo_runtime_shims import ensure_optional_gguf_module
except Exception:  # pragma: no cover - 单文件语法检查兜底
    def ensure_optional_gguf_module():
        import importlib

        return importlib.import_module("gguf")

NODE_NAME = "GJJ_LazyImageStudio"
MAX_MAIN_IMAGE_INDEX = 9999
DEFAULT_UNET_NAME = "krea2_turbo_int4_convrot.safetensors"
DEFAULT_LAZY_CLIP_NAME = "qwen3vl_4b_bf16.safetensors"
DEFAULT_LAZY_VAE_NAME = "qwen_image_vae.safetensors"
DEFAULT_UNET_DTYPE = "default"
DEFAULT_MODEL_SOURCE = "UNET 主模型"
MODEL_SOURCE_OPTIONS = [DEFAULT_MODEL_SOURCE, "底模 checkpoint"]
DEFAULT_CHECKPOINT_NAME = ""
DEFAULT_DEVICE_PREFERENCE = "智能调度"
DEVICE_PREFERENCE_OPTIONS = ["GPU优先", "CPU优先", DEFAULT_DEVICE_PREFERENCE]
DEFAULT_GLOBAL_QUALITY_PROMPT = (
    "high quality, highly detailed, sharp focus, clean composition, "
    "professional lighting, natural colors"
)
DEFAULT_NEGATIVE_PROMPT = (
    "low quality, worst quality, lowres, blurry, out of focus, jpeg artifacts, "
    "bad anatomy, deformed anatomy, malformed limbs, extra arms, extra legs, "
    "extra hands, extra feet, extra fingers, missing fingers, fused fingers, "
    "mutated hands, poorly drawn hands, malformed hands, broken hands, "
    "malformed feet, broken legs, severed hands, severed feet, severed limbs, "
    "dismembered, duplicate limbs, distorted face"
)
DEFAULT_LIGHTNING_LORA = ""
DEFAULT_NSFW_LORA = ""
LTX_NAG_NEGATIVE_PROMPT = "text, subtitles, logo, watermark, signature"
LTX_NAG_SCALE = 11.0
LTX_NAG_ALPHA = 0.25
LTX_NAG_TAU = 2.5
REFERENCE_IMAGE_MEGAPIXELS = 1.0
LAZY_IMAGE_RESIZE_MODES = ("宽高", "等比", "长边", "像素")
LAZY_IMAGE_FIT_MODES = ("拉伸", "补边", "留边", "裁剪")
LAZY_IMAGE_CROP_POSITIONS = ("上", "下", "左", "右", "中")
DEFAULT_LAZY_IMAGE_RESIZE_CONFIG = {
    "mode": "宽高",
    "fit_mode": "裁剪",
    "crop_position": "上",
    "scale_percent": 100.0,
    "long_side_length": 1024,
    "total_pixel_k": 260,
}


def _is_checkpoint_model_source(model_source: Any, ckpt_name: Any = "") -> bool:
    source_text = str(model_source or "").strip().lower()
    checkpoint_text = str(ckpt_name or "").strip()
    return source_text in {"底模 checkpoint", "checkpoint", "ckpt"} or (
        not source_text and bool(checkpoint_text)
    )
REFERENCE_IMAGE_RESOLUTION_STEPS = 1
FLUX2_REFERENCE_RESOLUTION_STEPS = 16
IMAGE_RATIO_EPSILON = 0.015
GGUF_PACKAGE_SPEC = "gguf>=0.13.0"
QWEN_IMAGE_EDIT_LLAMA_TEMPLATE = (
    "<|im_start|>system\n"
    "Describe the key features of the input image (color, shape, size, texture, objects, background), "
    "then explain how the user's text instruction should alter or modify the image. Generate a new image "
    "that meets the user's requirements while maintaining consistency with the original input where appropriate."
    "<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"
)
QWEN_IMAGE_EDIT_IMAGE_TOKEN = "<|vision_start|><|image_pad|><|vision_end|>"
QWEN_IMAGE_EDIT_MAX_PLUS_IMAGES = 3
KREA2_STYLE_REFERENCE_LORA_STEM = "krea2_style_reference"
KREA2_STYLE_REFERENCE_WORKFLOW_VERSION = 10

register_prompt_translation_api((COMMON_PROMPT_TRANSLATE_API_PATH,))


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        # 确保text是字符串且不为空
        status_text = str(text or "").strip()
        if not status_text:
            status_text = "处理中..."

        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": status_text},
        )
    except Exception as e:
        # 添加调试信息，但不要中断主流程
        print(f"[DEBUG] _send_status failed for node {unique_id}: {str(e)}")
        try:
            # 尝试备用方案：直接设置节点状态（如果可用）
            if hasattr(_send_status, "current_node") and hasattr(
                _send_status.current_node, "status"
            ):
                _send_status.current_node.status = {
                    "status": "processing",
                    "message": text,
                }
        except Exception:
            pass


def _send_soft_test_error(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_lazy_image_studio_soft_error",
            {"node": str(unique_id), "message": str(text or "")},
        )
    except Exception:
        pass


def _send_test_preview(
    unique_id: Any,
    image: torch.Tensor,
    *,
    append: bool = False,
    prompt_index: int | None = None,
    prompt_count: int | None = None,
) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        preview_images = gjjutils_write_temp_tensor_images(image)
        PromptServer.instance.send_sync(
            "gjj_lazy_image_studio_test_preview",
            {
                "node": str(unique_id),
                "gjj_images": preview_images,
                "images": _standard_queue_images(preview_images),
                "append": bool(append),
                "prompt_index": (
                    int(prompt_index) if prompt_index is not None else None
                ),
                "prompt_count": (
                    int(prompt_count) if prompt_count is not None else None
                ),
            },
        )
    except Exception:
        pass


def _format_bytes(size: int | float | None) -> str:
    try:
        value = float(size or 0)
    except Exception:
        value = 0.0
    if value <= 0:
        return "未知"
    units = ["B", "KB", "MB", "GB", "TB"]
    index = 0
    while value >= 1024 and index < len(units) - 1:
        value /= 1024.0
        index += 1
    return f"{value:.1f}{units[index]}" if index else f"{int(value)}{units[index]}"


def _padded_convrot_legacy_alias(name: Any) -> str:
    return re.sub(
        r"(?i)_int4_convrot_padded(?=\.safetensors$)",
        "_int4_convrot",
        str(name or "").strip(),
    )


def _padded_convrot_target_name(name: Any) -> str:
    return re.sub(
        r"(?i)_int4_convrot(?=\.safetensors$)",
        "_int4_convrot_padded",
        str(name or "").strip(),
    )


def _resolve_lazy_unet_model_name(name: Any) -> str:
    value = str(name or "").strip()
    if not value:
        return value
    for category in ("diffusion_models", "unet_gguf", "checkpoints"):
        try:
            if folder_paths.get_full_path(category, value):
                return value
        except Exception:
            pass
    padded_name = _padded_convrot_target_name(value)
    if padded_name == value:
        return value
    for category in ("diffusion_models", "unet_gguf", "checkpoints"):
        try:
            if folder_paths.get_full_path(category, padded_name):
                print(f"[GJJ] LazyImageStudio 模型别名：{value} -> {padded_name}")
                return padded_name
        except Exception:
            pass
    return value


def _switch_image_unet_for_input(
    unet_name: Any, *, has_input_images: bool
) -> str:
    current = str(unet_name or "").strip()
    canonical = _canonical_model_text(current)
    family = ""
    is_edit_model = False
    if "qwenimageedit2511" in canonical:
        family = "qwen"
        is_edit_model = True
    elif "qwenimage2512" in canonical and "edit" not in canonical:
        family = "qwen"
    elif "booguimageeditturbo" in canonical:
        family = "boogu"
        is_edit_model = True
    elif "booguimageturbo" in canonical and "edit" not in canonical:
        family = "boogu"
    elif "mageflow" in canonical:
        family = "mage_flow"
        is_edit_model = "edit" in canonical
    if not family:
        return current
    wants_edit_model = bool(has_input_images)
    if wants_edit_model == is_edit_model:
        return current
    desired_tokens = {
        ("qwen", True): ("qwenimageedit2511", "qwen_image_edit_2511"),
        ("qwen", False): ("qwenimage2512", "qwen_image_2512"),
        ("boogu", True): ("booguimageeditturbo", "boogu_image_edit_turbo"),
        ("boogu", False): ("booguimageturbo", "boogu_image_turbo"),
        ("mage_flow", True): (
            "mageflowedit",
            "mage_flow_edit_turbo" if "turbo" in canonical else "mage_flow_edit",
        ),
        ("mage_flow", False): (
            "mageflowturbo" if "turbo" in canonical else "mageflow",
            "mage_flow_turbo" if "turbo" in canonical else "mage_flow",
        ),
    }
    desired_token, desired_label = desired_tokens[(family, wants_edit_model)]
    candidates = [
        str(item)
        for item in _list_lazy_unet_models()
        if desired_token in _canonical_model_text(item)
        and ("edit" in _canonical_model_text(item)) == wants_edit_model
        and (
            family != "mage_flow"
            or ("turbo" in _canonical_model_text(item)) == ("turbo" in canonical)
        )
    ]
    if not candidates:
        raise RuntimeError(
            f"LazyImageStudio 需要自动切换到 {desired_label}，"
            "但 diffusion_models / unet_gguf 中未找到对应模型。"
        )

    current_lower = current.replace("\\", "/").lower()
    quant_tokens = (
        "int4_convrot_padded",
        "int4_convrot",
        "int8_convrot",
        "nvfp4",
        "mxfp4",
        "mxfp8",
        "fp8_e4m3fn",
        "fp8_scaled",
        "fp8",
        "bf16",
        "fp16",
        "gguf",
    )
    current_quant = next(
        (token for token in quant_tokens if token in current_lower),
        "",
    )

    def candidate_score(candidate: str) -> tuple[int, int, int]:
        candidate_lower = candidate.replace("\\", "/").lower()
        same_quant = int(bool(current_quant) and current_quant in candidate_lower)
        if "int4_convrot" in candidate_lower:
            quant_priority = 4
        elif "int8_convrot" in candidate_lower:
            quant_priority = 3
        elif "int4" in candidate_lower:
            quant_priority = 2
        elif "int8" in candidate_lower:
            quant_priority = 1
        else:
            quant_priority = 0
        return same_quant, quant_priority, -len(candidate)

    selected = max(candidates, key=candidate_score)
    print(
        "[GJJ] LazyImageStudio 根据图片输入自动切换 UNET："
        f"{current} -> {selected}"
    )
    return selected


def _is_convrot_quantized_model_name(name: Any) -> bool:
    normalized = str(name or "").replace("\\", "/").lower()
    return any(token in normalized for token in ("int4_convrot", "int8_convrot", "convrot_w4a4"))


def _model_full_path(kind: str, name: str) -> str | None:
    if kind not in {"lora", "checkpoint"}:
        name = _resolve_lazy_unet_model_name(name)
    categories = (
        ("loras",)
        if kind == "lora"
        else (("checkpoints",) if kind == "checkpoint" else ("diffusion_models", "unet_gguf"))
    )
    for category in categories:
        try:
            path = folder_paths.get_full_path(category, name)
        except Exception:
            path = None
        if path and os.path.isfile(path):
            return path
    return None


def _model_size_text(kind: str, name: str) -> str:
    path = _model_full_path(kind, name)
    if not path:
        return "未知"
    try:
        return _format_bytes(os.path.getsize(path))
    except Exception:
        return "未知"


def _compact_model_name(name: Any) -> str:
    text = str(name or "").strip().replace("\\", "/").rstrip("/")
    leaf = text.rsplit("/", 1)[-1] if text else ""
    stem = os.path.splitext(leaf)[0]
    return stem or leaf or "unknown"


def _compact_model_size_text(kind: str, name: str) -> str:
    path = _model_full_path(kind, name)
    if not path:
        return "未知"
    try:
        size = float(os.path.getsize(path))
    except Exception:
        return "未知"
    units = [("T", 1024.0 ** 4), ("G", 1024.0 ** 3), ("M", 1024.0 ** 2), ("K", 1024.0)]
    for unit, factor in units:
        if size >= factor:
            value = size / factor
            return f"{value:.1f}{unit}" if value < 10 and value % 1 else f"{round(value):.0f}{unit}"
    return f"{max(1, int(round(size)))}B"


def _test_caption_label(kind: str, model_name: str, elapsed: float | None = None, failed: bool = False) -> str:
    time_text = "失败" if failed else f"{max(0, int(round(float(elapsed or 0))))}秒"
    if kind in {"sampler", "scheduler"}:
        return f"{_compact_model_name(model_name)} [{time_text}]"
    return f"{_compact_model_name(model_name)} ({_compact_model_size_text(kind, model_name)})[{time_text}]"


def _format_test_strength(value: Any) -> str:
    try:
        number = round(float(value), 4)
    except Exception:
        number = 1.0
    text = f"{number:.4f}".rstrip("0").rstrip(".")
    return text or "0"


def _lora_strength_test_values(start: Any, end: Any, step: Any) -> list[float]:
    try:
        current = float(start)
    except Exception:
        current = 0.2
    try:
        target = float(end)
    except Exception:
        target = 1.2
    try:
        delta = abs(float(step))
    except Exception:
        delta = 0.2
    if delta <= 1e-6:
        delta = 0.2
    direction = 1.0 if target >= current else -1.0
    values: list[float] = []
    limit = 256
    epsilon = delta * 0.001 + 1e-9
    while len(values) < limit:
        if direction > 0 and current > target + epsilon:
            break
        if direction < 0 and current < target - epsilon:
            break
        values.append(round(current, 4))
        current += delta * direction
    if not values:
        values.append(round(target, 4))
    return values


def _load_caption_font(size: int) -> ImageFont.ImageFont:
    windir = os.environ.get("WINDIR", "C:\\Windows")
    candidates = [
        os.path.join(windir, "Fonts", "msyh.ttc"),
        os.path.join(windir, "Fonts", "simhei.ttf"),
        os.path.join(windir, "Fonts", "seguiemj.ttf"),
        "arial.ttf",
    ]
    for path in candidates:
        try:
            if os.path.isfile(path):
                return ImageFont.truetype(path, size=size)
        except Exception:
            pass
    try:
        return ImageFont.load_default(size=size)
    except Exception:
        return ImageFont.load_default()


def _tensor_to_pil_rgb(image: torch.Tensor) -> Image.Image:
    tensor = image.detach().cpu()
    if tensor.ndim == 4:
        tensor = tensor[0]
    tensor = tensor.clamp(0.0, 1.0)
    array = (tensor.numpy() * 255.0).round().astype("uint8")
    return Image.fromarray(array, mode="RGB")


def _pil_rgb_to_tensor(image: Image.Image) -> torch.Tensor:
    import numpy as np

    array = np.asarray(image.convert("RGB")).astype("float32") / 255.0
    return torch.from_numpy(array).unsqueeze(0)


def _wrap_caption_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    words = re.split(r"([\\/_\-.|\s])", str(text or ""))
    lines: list[str] = []
    current = ""
    def append_long_word(value: str) -> str:
        chunk = ""
        for char in value:
            candidate = chunk + char
            try:
                width = draw.textbbox((0, 0), candidate, font=font)[2]
            except Exception:
                width = len(candidate) * 8
            if chunk and width > max_width:
                lines.append(chunk.strip())
                chunk = char
            else:
                chunk = candidate
        return chunk
    for word in words:
        candidate = current + word
        try:
            width = draw.textbbox((0, 0), candidate, font=font)[2]
        except Exception:
            width = len(candidate) * 8
        if current and width > max_width:
            lines.append(current.strip())
            current = append_long_word(word.strip())
        elif not current and width > max_width:
            current = append_long_word(word.strip())
        else:
            current = candidate
    if current.strip():
        lines.append(current.strip())
    return lines or [str(text or "")]


def _caption_test_image(image: torch.Tensor, label: str) -> torch.Tensor:
    pil = _tensor_to_pil_rgb(image)
    width, height = pil.size
    font_size = max(14, min(28, width // 34))
    font = _load_caption_font(font_size)
    scratch = Image.new("RGB", (width, 80), (10, 16, 20))
    draw = ImageDraw.Draw(scratch)
    lines = _wrap_caption_text(draw, label, font, max(20, width - 24))[:3]
    line_height = max(font_size + 6, 20)
    caption_height = max(42, 14 + line_height * len(lines))
    output = Image.new("RGB", (width, height + caption_height), (10, 16, 20))
    output.paste(pil, (0, 0))
    draw = ImageDraw.Draw(output)
    draw.rectangle((0, height, width, height + caption_height), fill=(10, 16, 20))
    y = height + 8
    for line in lines:
        draw.text((12, y), line, fill=(229, 237, 242), font=font)
        y += line_height
    return _pil_rgb_to_tensor(output)


def _resize_test_image_to_target(image: torch.Tensor, target_width: int, target_height: int) -> torch.Tensor:
    width = max(8, int(target_width))
    height = max(8, int(target_height))
    pil = _tensor_to_pil_rgb(image)
    if pil.size != (width, height):
        resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.BICUBIC)
        pil = pil.resize((width, height), resampling)
    return _pil_rgb_to_tensor(pil)


def _pad_images_to_common_size(images: list[torch.Tensor]) -> list[torch.Tensor]:
    if not images:
        return []
    valid = [item for item in images if isinstance(item, torch.Tensor) and item.ndim == 4]
    if not valid:
        return images
    max_height = max(int(item.shape[1]) for item in valid)
    max_width = max(int(item.shape[2]) for item in valid)
    padded: list[torch.Tensor] = []
    for item in images:
        if not isinstance(item, torch.Tensor) or item.ndim != 4:
            continue
        if int(item.shape[1]) == max_height and int(item.shape[2]) == max_width:
            padded.append(item)
            continue
        pad_h = max_height - int(item.shape[1])
        pad_w = max_width - int(item.shape[2])
        padded.append(F.pad(item, (0, 0, 0, pad_w, 0, pad_h), value=0.04))
    return padded


def _format_model_missing_error(
    label: str, filename: str, categories: tuple[str, ...], exc: Exception | None = None
) -> RuntimeError:
    model_dirs = " / ".join(f"models\\{category}" for category in categories)
    detail = f"\n详细错误：{exc}" if exc else ""
    return RuntimeError(
        f"缺少{label}模型。\n"
        f"当前选择：{filename or '[未填写]'}\n"
        f"查找目录：{model_dirs}{detail}"
    )


def _format_runtime_error(stage: str, exc: Exception) -> RuntimeError:
    return RuntimeError(f"{stage}失败。\n详细错误：{exc}")


def _clear_torch_and_comfy_cache() -> None:
    import gc

    gc.collect()
    try:
        comfy.model_management.soft_empty_cache()
    except Exception:
        pass
    if hasattr(torch.cuda, "empty_cache"):
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass
    if hasattr(torch.cuda, "ipc_collect"):
        try:
            torch.cuda.ipc_collect()
        except Exception:
            pass


def _is_memory_allocation_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(
        needle in text
        for needle in (
            "vbar allocation failed",
            "out of memory",
            "cuda error: out of memory",
            "allocation failed",
            "failed to allocate",
        )
    )


def _format_memory_allocation_error(exc: Exception, *, unet_name: str, width: Any, height: Any, batch_size: Any) -> RuntimeError:
    return RuntimeError(
        "显存/内存分配失败，已尝试释放 LazyImageStudio 缓存。\n"
        f"UNET：{unet_name}\n"
        f"输出尺寸：{width} x {height}，批次数：{batch_size}\n"
        "建议：关闭其它占显存的节点或工作流、降低宽高/批次数、关闭“保持模型”，"
        "或重启 ComfyUI 后优先运行当前节点。\n"
        f"详细错误：{exc}"
    )


def _is_flux2_family(unet_name: str | None = "", clip_type: str | None = "") -> bool:
    normalized_unet = _normalize_text(unet_name)
    normalized_clip = _normalize_text(clip_type)
    return (
        normalized_clip == "flux2"
        or "flux2" in normalized_unet
        or "f2k" in normalized_unet
        or "flux-2" in str(unet_name or "").lower()
        or "klein" in normalized_unet
    )


def _is_krea2_family(
    unet_name: str | None = "",
    clip_type: str | None = "",
    preset: dict[str, Any] | None = None,
) -> bool:
    normalized_unet = _normalize_text(unet_name)
    normalized_clip = _normalize_text(clip_type)
    preset_text = _canonical_model_text(
        "|".join(
            [
                str((preset or {}).get("id", "")),
                str((preset or {}).get("keywords", "")),
                str((preset or {}).get("model_name", "")),
                str((preset or {}).get("clip_type", "")),
            ]
        )
    )
    return (
        normalized_clip in {"krea", "krea2", "krea2turbo"}
        or "krea2" in normalized_unet
        or "krea2turbo" in normalized_unet
        or "krea2" in preset_text
        or "krea2turbo" in preset_text
    )


def _without_krea2_edit_lora(value: Any) -> str:
    """Remove the edit-only LoRA while preserving every other configured LoRA."""
    if not str(value or "").strip():
        return str(value or "")
    try:
        normalized = normalize_lora_chain_data(value)
        rows = json.loads(normalized)
    except Exception:
        return str(value or "")
    if not isinstance(rows, list):
        return str(value or "")
    edit_basename = Path(KREA2_IDENTITY_EDIT_LORA).name.casefold()
    filtered = [
        row
        for row in rows
        if not (
            isinstance(row, dict)
            and Path(str(row.get("name", "")).replace("\\", "/")).name.casefold()
            == edit_basename
        )
    ]
    return json.dumps(filtered, ensure_ascii=False)


def _configured_krea2_edit_lora_strength(*values: Any) -> float:
    edit_basename = Path(KREA2_IDENTITY_EDIT_LORA).name.casefold()
    resolved: float | None = None
    for value in values:
        if not str(value or "").strip():
            continue
        try:
            rows = json.loads(normalize_lora_chain_data(value))
        except Exception:
            continue
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            row_basename = Path(
                str(row.get("name", "")).replace("\\", "/")
            ).name.casefold()
            if row_basename != edit_basename:
                continue
            if row.get("enabled", True) is False:
                resolved = 0.0
                continue
            try:
                resolved = float(row.get("strength", 1.0))
            except (TypeError, ValueError):
                resolved = 1.0
    return 1.0 if resolved is None else resolved


def _has_enabled_lora(lora_stem: str, *values: Any) -> bool:
    expected_stem = Path(str(lora_stem or "")).stem.casefold()
    if not expected_stem:
        return False
    for value in values:
        if not str(value or "").strip():
            continue
        try:
            rows = json.loads(normalize_lora_chain_data(value))
        except Exception:
            continue
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict) or row.get("enabled", True) is False:
                continue
            row_stem = Path(
                str(row.get("name", "")).replace("\\", "/")
            ).stem.casefold()
            try:
                strength = float(row.get("strength", 1.0))
            except (TypeError, ValueError):
                strength = 1.0
            if row_stem == expected_stem and abs(strength) > 1e-6:
                return True
    return False


def _is_empty_lora_config(value: Any) -> bool:
    text = str(value or "").strip()
    if not text or text.casefold() in {"null", "none"}:
        return True
    try:
        parsed = json.loads(text)
    except Exception:
        return False
    return isinstance(parsed, list) and not parsed


def _is_empty_scene_prompt(value: Any) -> bool:
    return "空镜" in str(value or "").replace(" ", "")


def _is_ltx_family(
    unet_name: str | None = "",
    clip_type: str | None = "",
    preset: dict[str, Any] | None = None,
) -> bool:
    normalized_unet = _normalize_text(unet_name)
    normalized_clip = _normalize_text(clip_type)
    preset_id = _normalize_text((preset or {}).get("id", ""))
    preset_clip = _normalize_text((preset or {}).get("clip_type", ""))
    return (
        normalized_clip in {"ltx", "ltxv"}
        or preset_clip in {"ltx", "ltxv"}
        or preset_id.startswith("ltx")
        or "ltx" in normalized_unet
    )


def _ltx_negative_prompt_text(negative_prompt: str | None) -> str:
    text = str(negative_prompt or "").strip()
    if not text:
        return LTX_NAG_NEGATIVE_PROMPT
    if LTX_NAG_NEGATIVE_PROMPT.casefold() in text.casefold():
        return text
    return f"{text}, {LTX_NAG_NEGATIVE_PROMPT}"


def _apply_f2k_fallback_preset(preset: dict[str, Any], unet_name: str) -> dict[str, Any]:
    if str(preset.get("id", "")) != "generic":
        return preset
    normalized = _normalize_text(unet_name)
    if "f2k" not in normalized:
        return preset
    is_4b = "4b" in normalized
    return {
        **preset,
        "id": "flux2_klein_4b" if is_4b else "flux2_klein_9b",
        "keywords": ["f2k-4b", "f2k4b"] if is_4b else ["f2k-9b", "f2k9b", "f2k"],
        "clip_type": "flux2",
        "clip_names": ["qwen_3_4b.safetensors"] if is_4b else ["qwen_3_8b_fp8mixed.safetensors"],
        "vae_name": "flux2-vae.safetensors",
        "steps": 4,
        "cfg": 1.0,
        "sampler_name": "lcm",
        "scheduler": "simple",
        "denoise": 1.0,
        "supports_multi_image_edit": False,
        "width": 1024,
        "height": 1024,
    }


def _apply_zit_fallback_preset(preset: dict[str, Any], unet_name: str) -> dict[str, Any]:
    if str(preset.get("id", "")) != "generic":
        return preset
    canonical = _canonical_model_text(unet_name)
    if "zit" not in canonical:
        return preset
    return {
        **preset,
        "id": "z_image_turbo",
        "keywords": ["z_image_turbo", "zit", "z-it", "zit-turbo"],
        "clip_type": "lumina2",
        "clip_names": ["qwen_3_4b.safetensors"],
        "vae_name": "ae.safetensors",
        "lora_1_strength": 1.0,
        "steps": 8,
        "cfg": 1.0,
        "sampler_name": "res_multistep",
        "scheduler": "simple",
        "denoise": 1.0,
        "model_sampling": "aura",
        "model_shift": 3.0,
        "cfg_norm_strength": 0.0,
        "supports_multi_image_edit": False,
        "width": 1024,
        "height": 1024,
    }


def _apply_krea2_fallback_preset(preset: dict[str, Any], unet_name: str) -> dict[str, Any]:
    if str(preset.get("id", "")) != "generic":
        return preset
    if not _is_krea2_family(unet_name, preset=preset):
        return preset
    return {
        **preset,
        "id": "krea2_turbo",
        "keywords": ["krea2", "krea2_turbo", "krea2-turbo"],
        "clip_type": "krea2",
        "clip_names": ["qwen3vl_4b_int4_convrot.safetensors","qwen3vl_4b_fp8_scaled.safetensors"],
        "vae_name": "qwen_image_vae.safetensors",
        "steps": 8,
        "cfg": 1.0,
        "sampler_name": "euler",
        "scheduler": "simple",
        "denoise": 1.0,
        "supports_multi_image_edit": False,
        "width": 1024,
        "height": 1024,
    }


def _lazy_preset_for_unet(unet_name: str) -> dict[str, Any]:
    preset = match_model_family(unet_name)
    preset = _apply_f2k_fallback_preset(preset, unet_name)
    preset = _apply_zit_fallback_preset(preset, unet_name)
    preset = _apply_krea2_fallback_preset(preset, unet_name)
    return preset


def _model_matches_preset_expression(model_name: Any, expression: Any) -> bool:
    terms = [
        part.strip()
        for part in str(expression or "").split("+")
        if part.strip()
    ]
    if not terms:
        return False
    model_canonical = _canonical_model_text(model_name)
    model_family = _canonical_model_text(
        gjjutils_model_stem_without_quant(str(model_name or ""))
    )
    return all(
        (
            (term_canonical := _canonical_model_text(term)) in model_canonical
            or (
                (term_family := _canonical_model_text(
                    gjjutils_model_stem_without_quant(term)
                ))
                and term_family in model_family
            )
        )
        for term in terms
    )


def _require_legal_preset_model(
    family_id: str,
    model_kind: str,
    model_name: str,
    expression: str,
) -> str:
    if model_name and _model_matches_preset_expression(model_name, expression):
        return model_name
    raise RuntimeError(
        f"模型族 {family_id or '(未识别)'} 的 {model_kind} 配套解析失败："
        f"需要匹配关键词“{expression or '(未配置)'}”，"
        f"实际解析为“{model_name or '(空)'}”。"
    )


def _resolve_lazy_test_model_pair(unet_name: str) -> tuple[dict[str, Any], str, str]:
    preset = _lazy_preset_for_unet(unet_name)
    if str(preset.get("id", "")) == "generic":
        raise RuntimeError(
            f"主模型 {unet_name} 未匹配任何模型族预设，不能执行合法配套测试。"
        )
    clip_models = _list_lazy_clip_models() or [DEFAULT_LAZY_CLIP_NAME]
    vae_models = list_vae_models() or [DEFAULT_LAZY_VAE_NAME]
    clip_names = resolve_clip_names_for_preset(
        preset,
        clip_models,
        exposed_clip_name="",
        legacy_clip_names=[],
    )
    preset_clip_names = list(preset.get("clip_names", []))
    for index, expression in enumerate(preset_clip_names):
        resolved = str(clip_names[index] if index < len(clip_names) else "")
        _require_legal_preset_model(
            str(preset.get("id", "")),
            f"CLIP {index + 1}",
            resolved,
            str(expression),
        )
    vae_name = _pick_available_name(
        preset.get("vae_name", ""),
        vae_models,
        "",
    )
    _require_legal_preset_model(
        str(preset.get("id", "")),
        "VAE",
        str(vae_name or ""),
        str(preset.get("vae_name", "")),
    )
    selected_clip_name = str(clip_names[0] if clip_names else "")
    if (
        _normalize_text(preset.get("clip_type", "")) == "flux"
        and len(clip_names) > 1
    ):
        # The exposed Flux slot represents T5XXL; CLIP-L is fixed and is added
        # again by the normal single-run resolver for every batch item.
        selected_clip_name = str(clip_names[1])
    return preset, selected_clip_name, str(vae_name or "")


def _supports_multi_reference_edit(
    preset: dict[str, Any], unet_name: str | None = "", clip_type: str | None = ""
) -> bool:
    text = _canonical_model_text(
        "|".join(
            [
                str(unet_name or ""),
                str(clip_type or ""),
                str(preset.get("id", "")),
                str(preset.get("keywords", "")),
            ]
        )
    )
    return bool(preset.get("supports_multi_image_edit")) or any(
        keyword in text for keyword in ("flux", "f2k", "edit")
    )


class FlexibleImageStudioInputType(dict):
    def __init__(self, data: dict[str, Any] | None = None):
        super().__init__()
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        text = str(key or "")
        if text.startswith("image_"):
            return ("GJJ_BATCH_IMAGE,IMAGE",)
        raise KeyError(key)

    def __contains__(self, key):
        text = str(key or "")
        return key in self.data or text.startswith("image_")


def _safe_filename_list(category: str) -> list[str]:
    try:
        return _dedupe_keep_order(list(folder_paths.get_filename_list(category)))
    except Exception:
        return []


def _is_gguf_model(value: Any) -> bool:
    return str(value or "").replace("\\", "/").lower().endswith(".gguf")


def _merge_model_folder_path(folder_name: str, path: str, extensions: set[str]) -> None:
    if not path:
        return
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    current = existing.get(folder_name)
    if current:
        paths, exts = current
        path_list = list(paths) if isinstance(paths, (list, tuple, set)) else [paths]
        if path not in path_list:
            path_list.append(path)
        existing[folder_name] = (path_list, set(exts or set()) | set(extensions))
        return
    existing[folder_name] = ([path], set(extensions))


def _ensure_gguf_model_folders() -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    models_dir = str(getattr(folder_paths, "models_dir", "") or "").strip()

    for target in ("diffusion_models", "unet", "text_encoders", "clip"):
        current = existing.get(target)
        if not current:
            continue
        paths, exts = current
        existing[target] = (paths, set(exts or set()) | {".gguf"})

    if models_dir:
        _merge_model_folder_path("unet_gguf", os.path.join(models_dir, "unet_gguf"), {".gguf"})
        _merge_model_folder_path("clip_gguf", os.path.join(models_dir, "clip_gguf"), {".gguf"})

    for source, target in (
        ("diffusion_models", "unet_gguf"),
        ("text_encoders", "clip_gguf"),
        ("clip", "clip_gguf"),
    ):
        current = existing.get(source)
        if not current:
            continue
        paths, _exts = current
        for path in list(paths) if isinstance(paths, (list, tuple, set)) else [paths]:
            _merge_model_folder_path(target, str(path), {".gguf"})


def _list_lazy_unet_models() -> list[str]:
    _ensure_gguf_model_folders()
    models = _dedupe_keep_order(
        _safe_filename_list("unet_gguf")
        + list_unet_models()
        + _safe_filename_list("diffusion_models")
        + _safe_filename_list("checkpoints")
    )
    legacy_aliases = [
        alias
        for name in models
        if (alias := _padded_convrot_legacy_alias(name)) != name
    ]
    return _dedupe_keep_order(models + legacy_aliases)


def _list_lazy_checkpoints() -> list[str]:
    # Keep an explicit empty choice so ComfyUI accepts serialized UNET-mode
    # workflows whose inactive checkpoint widget has no value.
    return _dedupe_keep_order([DEFAULT_CHECKPOINT_NAME] + _safe_filename_list("checkpoints"))


def _list_lazy_clip_models() -> list[str]:
    _ensure_gguf_model_folders()
    return _dedupe_keep_order(
        _safe_filename_list("clip_gguf")
        + list_clip_models()
        + _safe_filename_list("text_encoders")
        + _safe_filename_list("clip")
    )


def _preferred_default(values: list[str], preferred: str) -> str:
    preferred = str(preferred or "").strip()
    if preferred and preferred in values:
        return preferred
    return values[0] if values else preferred


def _clip_type_enum(name: str):
    normalized = _normalize_text(name)
    aliases = {
        "krea": "krea2",
        "krea2turbo": "krea2",
        "mage_flow": "mage",
    }
    enum_key = aliases.get(normalized, normalized)
    enum_name = enum_key.upper()
    clip_type = getattr(comfy.sd.CLIPType, enum_name, None)
    if clip_type is None:
        for member_name in dir(comfy.sd.CLIPType):
            if _normalize_text(member_name) == enum_key:
                clip_type = getattr(comfy.sd.CLIPType, member_name, None)
                break
    if clip_type is None:
        for candidate in getattr(comfy.sd.CLIPType, "__members__", {}).values():
            if _normalize_text(getattr(candidate, "name", "")) == enum_key or _normalize_text(getattr(candidate, "value", "")) == enum_key:
                clip_type = candidate
                break
    if clip_type is None and normalized in {"krea", "krea2", "krea2turbo"}:
        raise RuntimeError(
            "当前 ComfyUI 缺少原生 KREA2 CLIP 类型，无法加载 krea2_turbo 的 Qwen3VL 文本编码器。"
            "请更新到包含 CLIPType.KREA2 / Krea2 文本编码支持的 ComfyUI 版本后再使用。"
        )
    if clip_type is None and normalized == "boogu":
        raise RuntimeError(
            "当前 ComfyUI 缺少原生 BOOGU CLIP 类型，无法加载 Boogu-Image 的 Qwen3VL 文本编码器。"
            "请更新到包含 CLIPType.BOOGU / comfy.text_encoders.boogu 的 ComfyUI 版本后再使用。"
        )
    return clip_type or comfy.sd.CLIPType.STABLE_DIFFUSION


# ============================================================================
# 注意：以下函数已迁移到 .common_utils.model_family 模块
# - match_model_family → gjjutils_model_family_match_preset
# - resolve_clip_type → gjjutils_model_family_resolve_clip_type
# - resolve_clip_names_for_preset → gjjutils_model_family_resolve_clip_names
# - _pick_available_name → gjjutils_model_family_pick_model_name
# - _pick_available_lora_name → gjjutils_model_family_pick_lora_name
# - _canonical_model_text → 内部辅助函数（已在 common_utils 中定义）
#
# 为保持向后兼容，此处保留别名导入（见上方 import）
# 以下旧实现已注释，避免重复定义
# ============================================================================

# def _canonical_model_text(value: str | None) -> str:
# 	text=_normalize_text(value)
# 	for char in ("\\", "/", "_", "-", ".", " "):
# 		text=text.replace(char, "")
# 	return text


def input_index(name: str, prefix: str) -> int:
    text = str(name or "")
    if not text.startswith(prefix):
        return 999999
    try:
        return int(text[len(prefix) :])
    except Exception:
        return 999999


def sorted_dynamic_items(kwargs: dict[str, Any], prefix: str) -> list[tuple[str, Any]]:
    return sorted(
        [(key, value) for key, value in kwargs.items() if str(key).startswith(prefix)],
        key=lambda item: input_index(item[0], prefix),
    )


def _split_image_batch(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        images: list[Any] = []
        for item in value:
            images.extend(_split_image_batch(item))
        return images
    if not isinstance(value, torch.Tensor):
        return [value]
    if value.ndim == 3:
        return [value.unsqueeze(0).contiguous()]
    if value.ndim != 4:
        return [value]
    batch_size = max(0, int(value.shape[0]))
    if batch_size <= 1:
        return [value.contiguous()]
    return [value[index : index + 1].contiguous() for index in range(batch_size)]


def _unwrap_list_input(value: Any) -> Any:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    return value


def _prompt_batch_items(value: Any) -> list[str]:
    value = _unwrap_list_input(value)
    if isinstance(value, (list, tuple)):
        items: list[str] = []
        for item in value:
            item = _unwrap_list_input(item)
            if isinstance(item, (list, tuple)):
                items.extend(_prompt_batch_items(item))
            else:
                items.append(str(item or ""))
        return items or [""]
    text = str(value or "")
    if "---" not in text:
        return [text]
    parts = [
        part.strip()
        for part in re.split(r"(?:^|\n)\s*---+\s*(?:\n|$)", text)
        if part.strip()
    ]
    if len(parts) <= 1:
        parts = [part.strip() for part in text.split("---") if part.strip()]
    return parts or [text]


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    return text in {"true", "1", "yes", "on", "启用", "开启"}


def _normalize_device_preference(value: Any) -> str:
    return DEFAULT_DEVICE_PREFERENCE


def _load_patcher_smart(patcher: Any) -> None:
    if patcher is None:
        return
    try:
        comfy.model_management.load_model_gpu(patcher)
    except TypeError:
        comfy.model_management.load_models_gpu([patcher])


def _prepare_model_device(model: Any, device_preference: Any) -> None:
    try:
        _load_patcher_smart(model)
    except Exception as exc:
        print(f"[GJJ_LazyImageStudio] 主模型智能调度失败，继续使用 ComfyUI 默认状态：{exc}")


def _prepare_vae_device(vae: Any, device_preference: Any) -> None:
    try:
        patcher = getattr(vae, "patcher", None)
        if patcher is not None:
            _load_patcher_smart(patcher)
    except Exception as exc:
        print(f"[GJJ_LazyImageStudio] VAE 智能调度失败，继续使用 ComfyUI 默认状态：{exc}")


def _stable_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        return str(value)


def _tensor_signature(value: Any, max_samples: int = 65536) -> str:
    if not isinstance(value, torch.Tensor):
        return f"{type(value).__name__}:{str(value)[:120]}"
    with torch.no_grad():
        tensor = value.detach()
        shape = tuple(int(dim) for dim in tensor.shape)
        if tensor.numel() == 0:
            return f"{shape}:empty"
        flat = tensor.reshape(-1)
        step = max(1, flat.numel() // int(max_samples))
        sample = flat[::step][:max_samples].detach().cpu().contiguous()
        if sample.dtype != torch.float32:
            sample = sample.float()
        digest = hashlib.sha256(sample.numpy().tobytes()).hexdigest()[:24]
        return f"{shape}:{sample.numel()}:{digest}"


def _pairs_signature(pairs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "slot": int(pair.get("slot_index", index)),
            "source_input": int(pair.get("source_input_index", 0)),
            "source_batch": int(pair.get("source_batch_index", index)),
            "image": _tensor_signature(pair.get("image")),
        }
        for index, pair in enumerate(pairs)
    ]


def _clone_image_pairs_for_task(
    pairs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Give every prompt task independent image tensors.

    Flux samplers and reference-conditioning helpers may retain or mutate tensor
    state during a sampling pass. Reusing the same pair dictionaries across a
    ``---`` prompt batch can therefore make later prompts lose their effective
    image condition. Keep the metadata stable while isolating tensor storage.
    """
    cloned: list[dict[str, Any]] = []
    for pair in pairs:
        item = dict(pair)
        image = pair.get("image")
        if isinstance(image, torch.Tensor):
            item["image"] = image.detach().clone().contiguous()
        cloned.append(item)
    return cloned


def _cache_digest(payload: Any) -> str:
    return hashlib.sha256(_stable_json(payload).encode("utf-8", "ignore")).hexdigest()


def _resolve_prompt_node(prompt_graph: Any, node_id: Any) -> dict[str, Any] | None:
    if not isinstance(prompt_graph, dict):
        return None
    text_id = str(node_id or "").strip()
    if text_id and isinstance(prompt_graph.get(text_id), dict):
        return prompt_graph[text_id]
    if node_id in prompt_graph and isinstance(prompt_graph[node_id], dict):
        return prompt_graph[node_id]
    return None


def _is_prompt_input_linked(prompt_graph: Any, node_id: Any, input_name: str) -> bool:
    current_node = _resolve_prompt_node(prompt_graph, node_id)
    if not isinstance(current_node, dict):
        return False
    inputs = current_node.get("inputs", {})
    if not isinstance(inputs, dict):
        return False
    value = inputs.get(input_name)
    return isinstance(value, (list, tuple)) and len(value) >= 2


def _prompt_input_source_class(prompt_graph: Any, node_id: Any, input_name: str) -> str:
    current_node = _resolve_prompt_node(prompt_graph, node_id)
    if not isinstance(current_node, dict):
        return ""
    inputs = current_node.get("inputs", {})
    if not isinstance(inputs, dict):
        return ""
    value = inputs.get(input_name)
    if not isinstance(value, (list, tuple)) or len(value) < 1:
        return ""
    source_node = _resolve_prompt_node(prompt_graph, value[0])
    if not isinstance(source_node, dict):
        return ""
    return str(source_node.get("class_type") or "")


def _is_model_effect_tester_input(prompt_graph: Any, node_id: Any, input_name: str) -> bool:
    return _prompt_input_source_class(prompt_graph, node_id, input_name) == "GJJ_ModelEffectTester"


def _make_soft_error_image(width: Any, height: Any, message: Any = "") -> torch.Tensor:
    w = max(64, min(2048, int(float(width or 512))))
    h = max(64, min(2048, int(float(height or 512))))
    text = str(message or "").strip()
    if not text:
        image = torch.zeros((1, h, w, 3), dtype=torch.float32)
        image[..., 0] = 0.24
        image[..., 1] = 0.04
        image[..., 2] = 0.06
        band_h = max(4, min(32, h // 20))
        image[:, :band_h, :, 0] = 0.95
        image[:, :band_h, :, 1] = 0.12
        image[:, :band_h, :, 2] = 0.18
        return image
    try:
        pil = Image.new("RGB", (w, h), (61, 10, 15))
        draw = ImageDraw.Draw(pil)
        band_h = max(4, min(32, h // 20))
        draw.rectangle((0, 0, w, band_h), fill=(242, 31, 46))
        title_font = _load_caption_font(max(16, min(34, w // 18)))
        body_font = _load_caption_font(max(12, min(24, w // 28)))
        margin = max(12, min(42, w // 16))
        title = "生成失败"
        title_box = draw.textbbox((0, 0), title, font=title_font)
        title_h = title_box[3] - title_box[1]
        max_text_width = max(40, w - margin * 2)
        lines: list[str] = []
        for raw_line in text.replace("\r", "\n").split("\n"):
            wrapped = _wrap_caption_text(draw, raw_line, body_font, max_text_width)
            lines.extend(wrapped)
        body_font_size = int(getattr(body_font, "size", max(12, min(24, w // 28))))
        max_lines = max(2, (h - band_h - title_h - margin * 2) // max(16, body_font_size + 6))
        lines = lines[:max_lines]
        if len(lines) == max_lines and len(text) > sum(len(line) for line in lines):
            lines[-1] = lines[-1].rstrip(".。 ") + "..."
        line_height = max(16, body_font_size + 6)
        block_h = title_h + 10 + line_height * len(lines)
        y = max(band_h + 8, (h - block_h) // 2)
        draw.text((margin, y), title, fill=(255, 244, 244), font=title_font)
        y += title_h + 10
        for line in lines:
            draw.text((margin, y), line, fill=(255, 214, 219), font=body_font)
            y += line_height
        return _pil_rgb_to_tensor(pil)
    except Exception:
        return _make_soft_error_image(w, h)


def _recover_serialized_image_entries(raw_value: Any) -> list[torch.Tensor]:
    selected_images = parse_selected_images(raw_value)
    if not selected_images:
        return []
    recovered: list[torch.Tensor] = []
    for entry in selected_images:
        try:
            recovered.append(load_image_tensor(resolve_input_image_path(entry)))
        except Exception:
            return []
    return recovered


def _recover_multi_image_loader_primary_batch(
    prompt_graph: Any, unique_id: Any
) -> list[torch.Tensor]:
    current_node = _resolve_prompt_node(prompt_graph, unique_id)
    if not isinstance(current_node, dict):
        return []
    current_inputs = current_node.get("inputs", {})
    image_ref = current_inputs.get("image_01")
    if not isinstance(image_ref, (list, tuple)) or len(image_ref) < 2:
        return []
    try:
        output_index = int(image_ref[1])
    except Exception:
        return []
    if output_index != 0:
        return []
    upstream_node = _resolve_prompt_node(prompt_graph, image_ref[0])
    if not isinstance(upstream_node, dict):
        return []
    if str(upstream_node.get("class_type") or "") != "GJJ_MultiImageLoader":
        return []
    upstream_inputs = upstream_node.get("inputs", {})
    if isinstance(upstream_inputs.get("input_images"), (list, tuple)):
        return []
    return _recover_serialized_image_entries(upstream_inputs.get("selected_images"))


def collect_image_pairs(
    kwargs: dict[str, Any],
    prompt_graph: Any = None,
    unique_id: Any = None,
    batch_source_images: Any = None,
) -> list[dict[str, Any]]:
    image_input_names = [
        name
        for name in kwargs
        if re.match(r"^image_\d+$", str(name or "")) and kwargs.get(name) is not None
    ]
    image_input_names.sort(key=lambda name: int(str(name).rsplit("_", 1)[-1]))
    pairs: list[dict[str, Any]] = []
    for source_input_index, input_name in enumerate(image_input_names):
        images = [
            image
            for image in _split_image_batch(kwargs.get(input_name))
            if isinstance(image, torch.Tensor) and image.ndim in (3, 4)
        ]
        for batch_index, image in enumerate(images):
            pairs.append(
                {
                    "slot_index": len(pairs),
                    "source_input_index": source_input_index,
                    "source_batch_index": batch_index,
                    "image": image,
                }
            )
    if pairs:
        return pairs

    recovered_primary_images: list[torch.Tensor] = []
    recovered_primary_images = _recover_serialized_image_entries(
        batch_source_images
    ) or _recover_multi_image_loader_primary_batch(prompt_graph, unique_id)
    for batch_index, image in enumerate(recovered_primary_images):
        pairs.append(
            {
                "slot_index": len(pairs),
                "source_input_index": 0,
                "source_batch_index": batch_index,
                "image": image,
            }
        )
    return pairs


def zero_out_conditioning(conditioning):
    result = []
    for item in conditioning:
        payload = item[1].copy()
        for key in ("reference_latents", "reference_latents_method"):
            payload.pop(key, None)
        pooled_output = payload.get("pooled_output")
        if pooled_output is not None:
            payload["pooled_output"] = torch.zeros_like(pooled_output)
        conditioning_lyrics = payload.get("conditioning_lyrics")
        if conditioning_lyrics is not None:
            payload["conditioning_lyrics"] = torch.zeros_like(conditioning_lyrics)
        result.append([torch.zeros_like(item[0]), payload])
    return result


def _limit_latent_batch(latent: Any, batch_size: int) -> Any:
    if not isinstance(latent, dict):
        return latent
    samples = latent.get("samples")
    if not isinstance(samples, torch.Tensor) or samples.ndim < 1:
        return latent
    target = max(1, int(batch_size))
    current = int(samples.shape[0])
    if current <= target:
        return latent
    limited = dict(latent)
    limited["samples"] = samples[:target].contiguous()
    noise_mask = limited.get("noise_mask")
    if (
        isinstance(noise_mask, torch.Tensor)
        and noise_mask.ndim >= 1
        and int(noise_mask.shape[0]) == current
    ):
        limited["noise_mask"] = noise_mask[:target].contiguous()
    return limited


def _limit_conditioning_batch(conditioning: Any, batch_size: int) -> Any:
    if not isinstance(conditioning, list):
        return conditioning
    target = max(1, int(batch_size))
    limited = []
    for item in conditioning:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            limited.append(item)
            continue
        cond = item[0]
        if isinstance(cond, torch.Tensor) and cond.ndim >= 1 and int(cond.shape[0]) > target:
            cond = cond[:target].contiguous()
        limited.append([cond, item[1]])
    return limited


def load_standard_lora_patches(
    model: Any, lora_state: dict[str, Any]
) -> dict[str, Any]:
    key_map = comfy.lora.model_lora_keys_unet(model.model, {})
    converted_lora = comfy.lora_convert.convert_lora(lora_state)
    return comfy.lora.load_lora(converted_lora, key_map)


def apply_lora_to_model_and_clip(
    model: Any,
    clip: Any,
    lora_state: dict[str, Any],
    strength_model: float,
    strength_clip: float,
):
    patched_model, patched_clip = comfy.sd.load_lora_for_models(
        model, clip, lora_state, strength_model, strength_clip
    )
    if patched_model is None:
        raise RuntimeError("LoRA 已读取，但没有任何权重成功应用到模型。")
    return patched_model, patched_clip or clip


def _should_skip_clip_lora_for_family(clip_type: str) -> bool:
    normalized = _normalize_text(clip_type)
    return normalized in {"qwen_image", "boogu"}


# 以下函数已迁移到 common_utils.model_family，使用导入的别名
# def match_model_family(unet_name: str) -> dict[str,Any]: ...
# def resolve_clip_type(...) -> str: ...
# def _pick_available_name(...) -> str: ...
# def _pick_available_lora_name(...) -> str: ...
# def _flux_optional_clip_candidates(...) -> list[str]: ...
# def resolve_clip_names_for_preset(...) -> list[str]: ...
def _load_vae(vae_name: str):
    try:
        vae_path = _resolve_full_path(("vae",), vae_name)
        print(f"[DEBUG] Loading VAE model: {vae_name}")
        print(f"[DEBUG] VAE model path: {vae_path}")
    except Exception as exc:
        raise _format_model_missing_error("VAE", vae_name, ("vae",), exc) from exc
    sd, metadata = comfy.utils.load_torch_file(vae_path, return_metadata=True)
    try:
        vae = comfy.sd.VAE(sd=sd, metadata=metadata, dtype=None)
        vae.throw_exception_if_invalid()
        print(f"[DEBUG] Successfully loaded VAE model: {vae_name}")
        # 彩色打印 VAE 信息
        print(f"\033[91m🔴 VAE: {vae_name}\033[0m")
        return vae
    except Exception as exc:
        requested_canonical = _canonical_model_text(vae_name)
        if requested_canonical == _canonical_model_text(
            "full_encoder_small_decoder.safetensors"
        ):
            for fallback_name in ("flux2-vae.safetensors", "Flux2-DEV-ae.safetensors"):
                try:
                    fallback_path = _resolve_full_path(("vae",), fallback_name)
                    print(f"[DEBUG] Trying fallback VAE: {fallback_name}")
                    print(f"[DEBUG] Fallback VAE path: {fallback_path}")
                    fallback_sd, fallback_metadata = comfy.utils.load_torch_file(
                        fallback_path, return_metadata=True
                    )
                    vae = comfy.sd.VAE(
                        sd=fallback_sd, metadata=fallback_metadata, dtype=None
                    )
                    vae.throw_exception_if_invalid()
                    print(f"[DEBUG] Successfully loaded fallback VAE: {fallback_name}")
                    # 彩色打印 VAE 信息
                    print(f"\033[91m🔴 VAE: {fallback_name} (fallback)\033[0m")
                    return vae
                except Exception:
                    pass
            raise RuntimeError(
                "当前 ComfyUI 核心无法加载 full_encoder_small_decoder.safetensors，且可回退的 Flux2 VAE 也不可用。"
                "请升级 ComfyUI，或改用 flux2-vae.safetensors / Flux2-DEV-ae.safetensors。"
            ) from exc
        raise _format_runtime_error("VAE 加载", exc) from exc


def _raise_gguf_dependency_missing(model_name: str, model_kind: str, exc: Exception | None = None) -> None:
    detail = f"\n详细错误：{exc}" if exc else ""
    raise RuntimeError(
        f"检测到 GGUF {model_kind}：{model_name}\n"
        f"当前 ComfyUI Python 缺少 gguf 依赖，请安装 {GGUF_PACKAGE_SPEC} 后重启 ComfyUI。"
        f"{detail}"
    )


def _ensure_gguf_dependency(model_name: str, model_kind: str) -> None:
    gguf_module = ensure_optional_gguf_module()
    if getattr(gguf_module, "_GJJ_OPTIONAL_RUNTIME_STUB", False):
        _raise_gguf_dependency_missing(model_name, model_kind)


def _load_model_gguf(unet_name: str):
    _ensure_gguf_model_folders()
    _ensure_gguf_dependency(unet_name, "UNET")
    try:
        from ..vendor.gjj_gguf_runtime import load_unet_gguf as load_gjj_gguf_unet
    except ImportError:
        from vendor.gjj_gguf_runtime import load_unet_gguf as load_gjj_gguf_unet
    try:
        print(f"[DEBUG] Loading GGUF UNET model: {unet_name}")
        model = load_gjj_gguf_unet(unet_name)
        print(f"[DEBUG] Successfully loaded GGUF UNET model: {unet_name}")
        print(f"\033[95m🟣 UNET GGUF: {unet_name}\033[0m")
        return model
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", "") == "gguf":
            _raise_gguf_dependency_missing(unet_name, "UNET", exc)
        raise
    except Exception as exc:
        error_text = str(exc)
        if "No module named 'gguf'" in error_text or "需要先安装 gguf" in error_text:
            _raise_gguf_dependency_missing(unet_name, "UNET", exc)
        raise _format_runtime_error("GGUF UNET 加载", exc) from exc


def _is_boogu_runtime(unet_name: str, clip_type: str = "") -> bool:
    return "boogu" in _normalize_text(unet_name) or _normalize_text(clip_type) == "boogu"


def _load_model_with_native_unet_loader(unet_name: str, unet_dtype: str):
    from nodes import UNETLoader

    loader = UNETLoader()
    for method_name in ("load_unet", "execute"):
        method = getattr(loader, method_name, None) or getattr(UNETLoader, method_name, None)
        if method is None:
            continue
        try:
            result = method(unet_name, unet_dtype)
        except TypeError:
            result = method(unet_name=unet_name, weight_dtype=unet_dtype)
        if isinstance(result, (list, tuple)):
            return result[0]
        return result
    raise RuntimeError("当前 ComfyUI 环境缺少可用的 UNETLoader.load_unet。")


def _load_model(
    unet_name: str, unet_dtype: str, clip_type: str = "", unique_id: Any = None
):
    unet_name = _resolve_lazy_unet_model_name(unet_name)
    if _is_gguf_model(unet_name):
        return _load_model_gguf(unet_name)
    if _is_convrot_quantized_model_name(unet_name):
        from .gjj_video_universal_model_loader import _load_convrot_quantized_diffusion_model

        return _load_convrot_quantized_diffusion_model(
            unet_name,
            unet_dtype,
            unique_id=unique_id,
        )
    try:
        unet_path = _resolve_full_path(("diffusion_models", "checkpoints"), unet_name)
        print(f"[DEBUG] Loading UNET model: {unet_name}")
        print(f"[DEBUG] UNET model path: {unet_path}")
        print(f"[DEBUG] UNET dtype: {unet_dtype}")
    except Exception as exc:
        raise _format_model_missing_error(
            "UNET", unet_name, ("diffusion_models", "checkpoints"), exc
        ) from exc
    try:
        if _is_boogu_runtime(unet_name, clip_type):
            model = _load_model_with_native_unet_loader(unet_name, unet_dtype)
        else:
            _raise_if_unsupported_boogu_diffusion(unet_path, clip_type)
            model_options = _build_unet_model_options(unet_dtype)
            if is_mage_flow_name(unet_name):
                model_options = dict(model_options)
                model_options["dtype"] = torch.bfloat16
            model = comfy.sd.load_diffusion_model(
                unet_path, model_options=model_options
            )
        print(f"[DEBUG] Successfully loaded UNET model: {unet_name}")
        # 彩色打印 UNET 信息
        print(f"\033[95m🟣 UNET: {unet_name}\033[0m")
        return model
    except Exception as exc:
        error_text = str(exc)
        if is_comfyui_model_compatibility_error(
            exc, model_name=unet_name, clip_type=clip_type
        ):
            raise_comfyui_model_compatibility_error(
                NODE_NAME,
                model_name=unet_name,
                clip_type=clip_type,
                original_error=exc,
                unique_id=unique_id,
            )
        if (not _is_boogu_runtime(unet_name, clip_type)) and (
            "shape '[13568, 3360]'" in error_text
            or ("3360" in error_text and "invalid for input of size" in error_text)
        ):
            raise RuntimeError(
                "检测到 Boogu-Image 主扩散模型加载不兼容。\n"
                f"当前 UNET：{unet_name}\n"
                "这个权重是 Boogu 新结构，不能按旧 OmniGen2/普通扩散模型方式加载；"
                "请使用已包含 comfy.ldm.boogu.model、supported_models.Boogu、CLIPType.BOOGU 的 ComfyUI 版本。"
            ) from exc
        raise _format_runtime_error("UNET 加载", exc) from exc


def _load_clip_from_names_with_gguf(clean_names: list[str], clip_type: str):
    _ensure_gguf_model_folders()
    for name in clean_names:
        if _is_gguf_model(name):
            _ensure_gguf_dependency(name, "CLIP")
    try:
        from ..vendor.gjj_gguf_runtime.runtime import GGUFModelPatcher
        from ..vendor.gjj_gguf_runtime.loader import gguf_clip_loader
        from ..vendor.gjj_gguf_runtime.ops import GGMLOps
    except ImportError:
        from vendor.gjj_gguf_runtime.runtime import GGUFModelPatcher
        from vendor.gjj_gguf_runtime.loader import gguf_clip_loader
        from vendor.gjj_gguf_runtime.ops import GGMLOps

    state_dicts: list[Any] = []
    clip_paths: list[str] = []
    for name in clean_names:
        if _is_gguf_model(name):
            path = _resolve_full_path(("clip_gguf", "text_encoders", "clip"), name)
            state_dicts.append(gguf_clip_loader(path))
        else:
            path = _resolve_full_path(("text_encoders", "clip"), name)
            state_dicts.append(comfy.utils.load_torch_file(path))
        clip_paths.append(path)

    try:
        print(f"[DEBUG] Loading CLIP models with GGUF support: {clean_names}")
        print(f"[DEBUG] CLIP model paths: {clip_paths}")
        print(f"[DEBUG] CLIP type: {clip_type}")
        clip = comfy.sd.load_text_encoder_state_dicts(
            clip_type=_clip_type_enum(clip_type),
            state_dicts=state_dicts,
            model_options={
                "custom_operations": GGMLOps,
                "initial_device": comfy.model_management.text_encoder_offload_device(),
            },
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        clip.patcher = GGUFModelPatcher.clone(clip.patcher)
        print(f"[DEBUG] Successfully loaded CLIP models with GGUF support: {clean_names}")
        print(f"\033[93m🟡 CLIP: {', '.join(clean_names)}\033[0m")
        return clip
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", "") == "gguf":
            _raise_gguf_dependency_missing(" + ".join(clean_names), "CLIP", exc)
        raise
    except Exception as exc:
        error_text = str(exc)
        if "No module named 'gguf'" in error_text or "需要先安装 gguf" in error_text:
            _raise_gguf_dependency_missing(" + ".join(clean_names), "CLIP", exc)
        raise _format_runtime_error("GGUF CLIP 加载", exc) from exc


def _load_clip_from_names(clip_names: list[str], clip_type: str):
    clean_names = [
        str(name or "").strip() for name in clip_names if str(name or "").strip()
    ]
    if not clean_names:
        raise RuntimeError("至少需要一个文本编码器模型。")
    if any(_is_gguf_model(name) for name in clean_names):
        return _load_clip_from_names_with_gguf(clean_names, clip_type)
    try:
        clip_paths = [
            _resolve_full_path(("text_encoders", "clip"), name) for name in clean_names
        ]
        print(f"[DEBUG] Loading CLIP models: {clean_names}")
        print(f"[DEBUG] CLIP model paths: {clip_paths}")
        print(f"[DEBUG] CLIP type: {clip_type}")
    except Exception as exc:
        raise _format_model_missing_error(
            "CLIP", " + ".join(clean_names), ("text_encoders", "clip"), exc
        ) from exc
    try:
        embedding_directory = folder_paths.get_folder_paths("embeddings")
    except Exception:
        embedding_directory = []
    normalized_type = _normalize_text(clip_type)
    try:
        if normalized_type == "boogu":
            clip = _load_boogu_clip_compatible(clip_paths, "default", "default")
        elif normalized_type in {"mage", "mage_flow"}:
            clip = comfy.sd.load_clip(
                ckpt_paths=clip_paths,
                embedding_directory=embedding_directory,
                clip_type=_clip_type_enum(clip_type),
                model_options={"dtype": torch.bfloat16},
            )
        elif normalized_type == "hidream":
            clip = comfy.sd.load_clip(
                ckpt_paths=clip_paths,
                embedding_directory=embedding_directory,
                model_options={},
            )
        else:
            clip = comfy.sd.load_clip(
                ckpt_paths=clip_paths,
                embedding_directory=embedding_directory,
                clip_type=_clip_type_enum(clip_type),
                model_options={},
            )
        print(f"[DEBUG] Successfully loaded CLIP models: {clean_names}")
        # 彩色打印 CLIP 信息
        clip_display = ", ".join(clean_names)
        print(f"\033[93m🟡 CLIP: {clip_display}\033[0m")
        return clip
    except Exception as exc:
        raise _format_runtime_error("CLIP 加载", exc) from exc


def _resize_to_long_edge(
    samples: torch.Tensor, longest_edge: int, upscale: str, crop: str
) -> torch.Tensor:
    height = int(samples.shape[2])
    width = int(samples.shape[3])
    current_long_edge = max(height, width)
    if current_long_edge <= 0:
        return samples
    scale = float(longest_edge) / float(current_long_edge)
    target_width = max(8, int(round(width * scale)))
    target_height = max(8, int(round(height * scale)))
    return comfy.utils.common_upscale(
        samples, target_width, target_height, upscale, crop
    )


def _scale_image_to_total_pixels(
    image: torch.Tensor,
    megapixels: float = REFERENCE_IMAGE_MEGAPIXELS,
    resolution_steps: int = REFERENCE_IMAGE_RESOLUTION_STEPS,
    upscale: str = "lanczos",
) -> torch.Tensor:
    samples = image.movedim(-1, 1)
    total = max(0.01, float(megapixels)) * 1024.0 * 1024.0
    current_total = max(1, int(samples.shape[2]) * int(samples.shape[3]))
    scale_by = math.sqrt(total / float(current_total))
    step = max(1, int(resolution_steps))
    target_width = max(step, int(round((samples.shape[3] * scale_by) / step)) * step)
    target_height = max(step, int(round((samples.shape[2] * scale_by) / step)) * step)
    return comfy.utils.common_upscale(
        samples, target_width, target_height, upscale, "disabled"
    ).movedim(1, -1)


def _scale_image_to_workflow_megapixels(
    image: torch.Tensor,
    megapixels: float = 1.0,
    upscale: str = "lanczos",
) -> torch.Tensor:
    samples = image.movedim(-1, 1)
    total = max(0.01, float(megapixels)) * 1_000_000.0
    current_total = max(1, int(samples.shape[2]) * int(samples.shape[3]))
    scale_by = math.sqrt(total / float(current_total))
    target_width = max(1, int(round(samples.shape[3] * scale_by)))
    target_height = max(1, int(round(samples.shape[2] * scale_by)))
    return comfy.utils.common_upscale(
        samples, target_width, target_height, upscale, "disabled"
    ).movedim(1, -1)


def _scale_image_to_short_edge(
    image: torch.Tensor,
    short_edge: int,
    resolution_steps: int = FLUX2_REFERENCE_RESOLUTION_STEPS,
    upscale: str = "lanczos",
) -> torch.Tensor:
    samples = image.movedim(-1, 1)
    source_height = max(1, int(samples.shape[2]))
    source_width = max(1, int(samples.shape[3]))
    target_short_edge = max(16, int(short_edge))
    scale = float(target_short_edge) / float(min(source_width, source_height))
    step = max(1, int(resolution_steps))
    target_width = max(
        step, int(round((source_width * scale) / step)) * step
    )
    target_height = max(
        step, int(round((source_height * scale) / step)) * step
    )
    return comfy.utils.common_upscale(
        samples, target_width, target_height, upscale, "disabled"
    ).movedim(1, -1)


def _reorder_pairs_by_main_index(
    pairs: list[dict[str, Any]], main_image_index: int
) -> list[dict[str, Any]]:
    if not pairs:
        return []
    main_slot = max(0, min(len(pairs) - 1, int(main_image_index) - 1))
    if main_slot <= 0:
        return list(pairs)
    return [pairs[main_slot], *pairs[:main_slot], *pairs[main_slot + 1 :]]


def _ensure_mask_bhw(mask: torch.Tensor | None) -> torch.Tensor | None:
    if mask is None:
        return None
    if mask.ndim == 2:
        return mask.unsqueeze(0)
    if mask.ndim == 3:
        return mask
    if mask.ndim == 4:
        return mask[:, 0, :, :]
    raise RuntimeError(f"不支持的遮罩维度：{tuple(mask.shape)}")


def _resize_image_exact(
    image: torch.Tensor, target_width: int, target_height: int, upscale: str = "lanczos"
) -> torch.Tensor:
    """保持宽高比的等比例缩放。"""
    samples = image.movedim(-1, 1)
    source_height = samples.shape[2]
    source_width = samples.shape[3]

    # 计算等比例缩放后的尺寸
    scale = min(
        float(target_width) / float(max(1, source_width)),
        float(target_height) / float(max(1, source_height)),
    )
    new_width = max(8, int(round(source_width * scale)))
    new_height = max(8, int(round(source_height * scale)))

    resized = comfy.utils.common_upscale(
        samples, new_width, new_height, upscale, "disabled"
    )
    return resized.movedim(1, -1)


def _resize_mask_exact(
    mask: torch.Tensor | None,
    target_width: int,
    target_height: int,
    upscale: str = "bilinear",
) -> torch.Tensor | None:
    """保持宽高比的等比例缩放遮罩。"""
    mask_bhw = _ensure_mask_bhw(mask)
    if mask_bhw is None:
        return None

    source_height = int(mask_bhw.shape[1])
    source_width = int(mask_bhw.shape[2])

    # 计算等比例缩放后的尺寸
    scale = min(
        float(target_width) / float(max(1, source_width)),
        float(target_height) / float(max(1, source_height)),
    )
    new_width = max(8, int(round(source_width * scale)))
    new_height = max(8, int(round(source_height * scale)))

    mask_image = mask_bhw.unsqueeze(1)
    resized = comfy.utils.common_upscale(
        mask_image, new_width, new_height, upscale, "disabled"
    )
    return resized[:, 0, :, :].clamp(0.0, 1.0)


def _same_aspect_ratio(
    width_a: int,
    height_a: int,
    width_b: int,
    height_b: int,
    epsilon: float = IMAGE_RATIO_EPSILON,
) -> bool:
    if min(width_a, height_a, width_b, height_b) <= 0:
        return False
    ratio_a = float(width_a) / float(height_a)
    ratio_b = float(width_b) / float(height_b)
    return abs((ratio_a / ratio_b) - 1.0) <= float(epsilon)


def _fit_image_with_replicate_padding(
    image: torch.Tensor, target_width: int, target_height: int, upscale: str = "lanczos"
):
    source_height = int(image.shape[1])
    source_width = int(image.shape[2])
    target_width = int(target_width)
    target_height = int(target_height)

    # 先等比例缩放，取较小的缩放比例以保证图片完整显示
    scale_w = float(target_width) / float(max(1, source_width))
    scale_h = float(target_height) / float(max(1, source_height))
    scale = min(scale_w, scale_h)

    # 计算等比例缩放后的尺寸
    resized_width = max(8, int(round(source_width * scale)))
    resized_height = max(8, int(round(source_height * scale)))

    # 确保不超过目标尺寸
    resized_width = min(target_width, resized_width)
    resized_height = min(target_height, resized_height)

    # 等比例缩放图片（使用 PIL 方式确保不变形）
    samples = image.movedim(-1, 1)
    # crop="disabled" 确保不裁剪，保持原始比例
    resized = comfy.utils.common_upscale(
        samples, resized_width, resized_height, upscale, "disabled"
    )
    resized = resized.movedim(1, -1)

    # 计算居中位置
    left = (target_width - resized_width) // 2
    top = (target_height - resized_height) // 2
    right = target_width - resized_width - left
    bottom = target_height - resized_height - top

    # 使用白边填充（constant mode），值设为 1.0（白色）
    padded = F.pad(
        resized.movedim(-1, 1), (left, right, top, bottom), mode="constant", value=1.0
    ).movedim(1, -1)

    # 生成遮罩：1.0 表示填充区域，0.0 表示原始图片区域
    mask = torch.ones(
        (image.shape[0], target_height, target_width),
        dtype=image.dtype,
        device=image.device,
    )
    mask[:, top : top + resized_height, left : left + resized_width] = 0.0
    return padded, mask, left, top, resized_width, resized_height


def _ceil_to_multiple(value: int, multiple: int = 8) -> int:
    multiple = max(1, int(multiple))
    return max(
        multiple, int(math.ceil(max(1, int(value)) / float(multiple))) * multiple
    )


def _lazy_image_resize_config(value: Any) -> dict[str, Any]:
    config = dict(DEFAULT_LAZY_IMAGE_RESIZE_CONFIG)
    if isinstance(value, dict):
        config.update(value)
    else:
        try:
            parsed = json.loads(str(value or "").strip() or "{}")
            if isinstance(parsed, dict):
                config.update(parsed)
        except Exception:
            pass
    if str(config.get("mode") or "") not in LAZY_IMAGE_RESIZE_MODES:
        config["mode"] = DEFAULT_LAZY_IMAGE_RESIZE_CONFIG["mode"]
    if str(config.get("fit_mode") or "") not in LAZY_IMAGE_FIT_MODES:
        config["fit_mode"] = DEFAULT_LAZY_IMAGE_RESIZE_CONFIG["fit_mode"]
    if str(config.get("crop_position") or "") not in LAZY_IMAGE_CROP_POSITIONS:
        config["crop_position"] = DEFAULT_LAZY_IMAGE_RESIZE_CONFIG["crop_position"]
    try:
        config["scale_percent"] = max(0.1, min(10000.0, float(config.get("scale_percent", 100.0))))
    except (TypeError, ValueError):
        config["scale_percent"] = 100.0
    try:
        config["long_side_length"] = max(8, min(16384, int(float(config.get("long_side_length", 1024)))))
    except (TypeError, ValueError):
        config["long_side_length"] = 1024
    try:
        config["total_pixel_k"] = max(1, min(1000000, int(float(config.get("total_pixel_k", 260)))))
    except (TypeError, ValueError):
        config["total_pixel_k"] = 260
    return config


def _largest_input_canvas_size(
    pairs: list[dict[str, Any]], fallback_width: int, fallback_height: int
) -> tuple[int, int]:
    candidates = [
        pair.get("image")
        for pair in pairs
        if isinstance(pair.get("image"), torch.Tensor) and pair["image"].ndim >= 3
    ]
    if not candidates:
        return int(fallback_width), int(fallback_height)
    largest = max(
        candidates,
        key=lambda image: int(image.shape[1]) * int(image.shape[2]),
    )
    return int(largest.shape[2]), int(largest.shape[1])


def _lazy_resize_target_size(
    base_width: int, base_height: int, config: dict[str, Any]
) -> tuple[int, int]:
    base_width = max(8, int(base_width))
    base_height = max(8, int(base_height))
    mode = str(config.get("mode") or "宽高")
    if mode == "等比":
        scale = float(config.get("scale_percent", 100.0)) / 100.0
        target_width = int(round(base_width * scale))
        target_height = int(round(base_height * scale))
    elif mode == "长边":
        long_side = max(8, int(config.get("long_side_length", 1024)))
        scale = float(long_side) / float(max(base_width, base_height))
        target_width = int(round(base_width * scale))
        target_height = int(round(base_height * scale))
    elif mode == "像素":
        total_pixels = max(1, int(config.get("total_pixel_k", 260))) * 1000
        aspect_ratio = float(base_width) / float(max(1, base_height))
        target_width = int(round(math.sqrt(total_pixels * aspect_ratio)))
        target_height = int(round(target_width / max(1e-8, aspect_ratio)))
    else:
        target_width = base_width
        target_height = base_height
    target_width = min(16384, max(8, int(target_width)))
    target_height = min(16384, max(8, int(target_height)))
    return _ceil_to_multiple(target_width, 8), _ceil_to_multiple(target_height, 8)


def _lazy_resize_axis_offset(extra: int, position: str, axis: str) -> int:
    extra = max(0, int(extra))
    if axis == "x":
        if position == "左":
            return 0
        if position == "右":
            return extra
    else:
        if position == "上":
            return 0
        if position == "下":
            return extra
    return extra // 2


def _lazy_resize_image_and_mask(
    image: torch.Tensor,
    mask: torch.Tensor | None,
    target_width: int,
    target_height: int,
    fit_mode: str,
    crop_position: str,
) -> tuple[torch.Tensor, torch.Tensor | None]:
    if image.ndim == 3:
        image = image.unsqueeze(0)
    source_height = int(image.shape[1])
    source_width = int(image.shape[2])
    target_width = max(8, int(target_width))
    target_height = max(8, int(target_height))
    source_mask = _ensure_mask_bhw(mask)

    def resize_mask(output_width: int, output_height: int) -> torch.Tensor | None:
        if source_mask is None:
            return None
        return comfy.utils.common_upscale(
            source_mask.unsqueeze(1),
            int(output_width),
            int(output_height),
            "bilinear",
            "disabled",
        )[:, 0, :, :].clamp(0.0, 1.0)

    if source_width == target_width and source_height == target_height:
        return image.contiguous(), source_mask

    samples = image.movedim(-1, 1)
    fit_mode = fit_mode if fit_mode in LAZY_IMAGE_FIT_MODES else "裁剪"
    crop_position = crop_position if crop_position in LAZY_IMAGE_CROP_POSITIONS else "上"
    if fit_mode == "拉伸":
        resized = comfy.utils.common_upscale(
            samples, target_width, target_height, "lanczos", "disabled"
        ).movedim(1, -1).contiguous()
        resized_mask = resize_mask(target_width, target_height)
        return resized, resized_mask

    if fit_mode == "裁剪":
        scale = max(
            float(target_width) / float(max(1, source_width)),
            float(target_height) / float(max(1, source_height)),
        )
    else:
        scale = min(
            float(target_width) / float(max(1, source_width)),
            float(target_height) / float(max(1, source_height)),
        )
        if fit_mode == "补边":
            scale = min(1.0, scale)
    resized_width = max(1, int(round(source_width * scale)))
    resized_height = max(1, int(round(source_height * scale)))
    resized = comfy.utils.common_upscale(
        samples, resized_width, resized_height, "lanczos", "disabled"
    ).movedim(1, -1).contiguous()
    resized_mask = resize_mask(resized_width, resized_height)

    if fit_mode == "裁剪":
        left = _lazy_resize_axis_offset(resized_width - target_width, crop_position, "x")
        top = _lazy_resize_axis_offset(resized_height - target_height, crop_position, "y")
        output = resized[:, top : top + target_height, left : left + target_width, :]
        output_mask = (
            None
            if resized_mask is None
            else resized_mask[:, top : top + target_height, left : left + target_width]
        )
        return output.contiguous(), None if output_mask is None else output_mask.contiguous()

    channels = int(resized.shape[-1])
    output = torch.ones(
        (int(resized.shape[0]), target_height, target_width, channels),
        dtype=resized.dtype,
        device=resized.device,
    )
    left = _lazy_resize_axis_offset(target_width - resized_width, crop_position, "x")
    top = _lazy_resize_axis_offset(target_height - resized_height, crop_position, "y")
    output[:, top : top + resized_height, left : left + resized_width, :] = resized
    output_mask = None
    if resized_mask is not None:
        output_mask = torch.ones(
            (int(resized_mask.shape[0]), target_height, target_width),
            dtype=resized_mask.dtype,
            device=resized_mask.device,
        )
        output_mask[:, top : top + resized_height, left : left + resized_width] = resized_mask
    return output.contiguous(), None if output_mask is None else output_mask.contiguous()


def _align_lazy_image_pairs(
    pairs: list[dict[str, Any]],
    mask: torch.Tensor | None,
    main_image_index: int,
    target_width: int,
    target_height: int,
    config: dict[str, Any],
) -> tuple[list[dict[str, Any]], torch.Tensor | None]:
    if not pairs:
        return pairs, _ensure_mask_bhw(mask)
    main_slot = max(0, min(len(pairs) - 1, int(main_image_index) - 1))
    aligned: list[dict[str, Any]] = []
    aligned_main_mask = _ensure_mask_bhw(mask)
    for index, pair in enumerate(pairs):
        item = dict(pair)
        image = pair.get("image")
        if not isinstance(image, torch.Tensor):
            aligned.append(item)
            continue
        image_mask = aligned_main_mask if index == main_slot else None
        fitted_image, fitted_mask = _lazy_resize_image_and_mask(
            image,
            image_mask,
            target_width,
            target_height,
            str(config.get("fit_mode") or "裁剪"),
            str(config.get("crop_position") or "上"),
        )
        item["image"] = fitted_image
        if index == main_slot:
            aligned_main_mask = fitted_mask
        aligned.append(item)
    return aligned, aligned_main_mask


def _largest_pair_canvas_size(
    pairs: list[dict[str, Any]], fallback_width: int = 1024, fallback_height: int = 1024
) -> tuple[int, int]:
    # 外部连接或面板宽高是输出画布的最高优先级。
    # 参考图尺寸只应该影响图片如何适配画布，不能反向把 256 目标尺寸顶回原图 2048。
    return _ceil_to_multiple(max(8, int(fallback_width)), 8), _ceil_to_multiple(
        max(8, int(fallback_height)), 8
    )


def _uses_equal_reference_canvas(preset: dict[str, Any], unet_name: str = "") -> bool:
    text = _canonical_model_text(
        "|".join(
            [
                str(preset.get("id", "")),
                str(preset.get("keywords", "")),
                str(unet_name or ""),
            ]
        )
    )
    normalized_unet = _normalize_text(str(unet_name or ""))
    return (
        "qwenimageedit2511" in text
        or ("firered" in text and "image" in text and "edit" in text)
        or "fireredimageedit" in normalized_unet
    )


def _is_qwen_image_edit_family(preset: dict[str, Any], unet_name: str = "") -> bool:
    text = _canonical_model_text(
        "|".join(
            [
                str(preset.get("id", "")),
                str(preset.get("keywords", "")),
                str(unet_name or ""),
            ]
        )
    )
    return "qwenimageedit" in text


def _is_boogu_image_edit_turbo_family(preset: dict[str, Any], unet_name: str = "") -> bool:
    text = _canonical_model_text(
        "|".join(
            [
                str(preset.get("id", "")),
                str(preset.get("keywords", "")),
                str(unet_name or ""),
                str(preset.get("model_name", "")),
            ]
        )
    )
    return "booguimageedit" in text


def _empty_sd3_latent(width: int, height: int, batch_size: int) -> dict[str, Any]:
    if EmptySD3LatentImage is not None:
        return EmptySD3LatentImage().generate(
            int(width), int(height), int(batch_size)
        )[0]
    return EmptyLatentImage().generate(
        int(width), int(height), int(batch_size)
    )[0]


def _prepare_primary_image_for_target(
    image: torch.Tensor,
    target_width: int,
    target_height: int,
    mask: torch.Tensor | None = None,
):
    source_height = int(image.shape[1])
    source_width = int(image.shape[2])
    target_width = max(8, int(target_width))
    target_height = max(8, int(target_height))
    if source_width == target_width and source_height == target_height:
        return image, _ensure_mask_bhw(mask), False
    # 统一使用扩图模式（边缘填充），避免非等比例缩放变形
    padded_image, layout_mask, left, top, resized_width, resized_height = (
        _fit_image_with_replicate_padding(image, target_width, target_height, "lanczos")
    )
    composed_mask = layout_mask
    source_mask = _ensure_mask_bhw(mask)
    if source_mask is not None:
        resized_source_mask = _resize_mask_exact(
            source_mask, resized_width, resized_height
        )
        mask_canvas = torch.zeros_like(layout_mask)
        mask_canvas[:, top : top + resized_height, left : left + resized_width] = (
            resized_source_mask
        )
        composed_mask = torch.maximum(composed_mask, mask_canvas)
    return padded_image, composed_mask.clamp(0.0, 1.0), True


def _apply_cfg_norm(model, strength: float):
    if abs(float(strength)) <= 1e-6:
        return model
    patched = model.clone()

    def cfg_norm(args):
        cond_p = args["cond_denoised"]
        pred_text = args["denoised"]
        norm_full_cond = torch.norm(cond_p, dim=1, keepdim=True)
        norm_pred_text = torch.norm(pred_text, dim=1, keepdim=True)
        scale = (norm_full_cond / (norm_pred_text + 1e-8)).clamp(min=0.0, max=1.0)
        return pred_text * scale * float(strength)

    patched.set_model_sampler_post_cfg_function(cfg_norm)
    return patched


def _patch_model_sampling(model, sampling_mode: str, shift: float):
    mode = _normalize_text(sampling_mode)
    if not mode or abs(float(shift)) <= 1e-6:
        return model
    patched = model.clone()
    if mode == "aura":
        sampling_base = comfy.model_sampling.ModelSamplingDiscreteFlow
        sampling_type = comfy.model_sampling.CONST
        multiplier = 1.0
    elif mode == "sd3":
        sampling_base = comfy.model_sampling.ModelSamplingDiscreteFlow
        sampling_type = comfy.model_sampling.CONST
        multiplier = 1000.0
    else:
        return model

    class ModelSamplingAdvanced(sampling_base, sampling_type):
        pass

    model_sampling = ModelSamplingAdvanced(patched.model.model_config)
    model_sampling.set_parameters(shift=float(shift), multiplier=multiplier)
    patched.add_object_patch("model_sampling", model_sampling)
    return patched


def _patch_flux_model_sampling(
    model,
    width: int,
    height: int,
    max_shift: float = 1.15,
    base_shift: float = 0.5,
):
    """Match ComfyUI's ModelSamplingFlux node for Flux 1 workflows."""
    patched = model.clone()
    x1 = 256
    x2 = 4096
    slope = (float(max_shift) - float(base_shift)) / (x2 - x1)
    intercept = float(base_shift) - slope * x1
    shift = (int(width) * int(height) / (8 * 8 * 2 * 2)) * slope + intercept

    class ModelSamplingAdvanced(
        comfy.model_sampling.ModelSamplingFlux,
        comfy.model_sampling.CONST,
    ):
        pass

    model_sampling = ModelSamplingAdvanced(patched.model.model_config)
    model_sampling.set_parameters(shift=shift)
    patched.add_object_patch("model_sampling", model_sampling)
    return patched


def _basic_scheduler_sigmas(model, scheduler: str, steps: int, denoise: float) -> torch.Tensor:
    steps = max(1, int(steps))
    denoise = max(0.0, min(1.0, float(denoise)))
    if denoise <= 0.0:
        return torch.empty((0,), dtype=torch.float32)
    scheduler = str(scheduler or "simple").strip() or "simple"
    total_steps = steps if denoise >= 1.0 else max(steps, int(steps / denoise))
    model_sampling = model.get_model_object("model_sampling")
    sigmas = comfy.samplers.calculate_sigmas(model_sampling, scheduler, total_steps).cpu()
    return sigmas[-(steps + 1):]


def _is_lora_enabled(name: str, strength: float) -> bool:
    return bool(str(name or "").strip()) and abs(float(strength)) > 1e-6


def _resolve_lora_suggested_steps(name: str) -> int | None:
    text = _normalize_text(name)
    canonical = _canonical_model_text(name)
    if "flux2turbocomfyv2" in canonical:
        return 8
    if "8step" in text or "8step" in canonical:
        return 8
    if "4step" in text or "4step" in canonical:
        return 4
    return None


def _resolve_effective_steps(
    requested_steps: int,
    preset: dict[str, Any],
) -> int:
    base_steps = preset.get("base_steps")
    if base_steps is not None:
        return int(base_steps)
    return int(requested_steps)


def _standard_queue_images(images: list[Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in images or []:
        if not isinstance(item, dict):
            continue
        image: dict[str, Any] = {
            "filename": item.get("filename", ""),
            "subfolder": item.get("subfolder", ""),
            "type": item.get("type", "temp"),
        }
        for key in ("width", "height", "format"):
            if item.get(key) not in (None, ""):
                image[key] = item.get(key)
        result.append(image)
    return result


class GJJ_LazyImageStudio:
    CATEGORY = "GJJ/💗 一键生成"
    FUNCTION = "create_image"
    DESCRIPTION = "懒人图文集成一键生图：支持文生图、图生图，以及多图参考编辑。节点会根据所选 UNET 主关键词自动推荐匹配的文本编码器、VAE、加速 LoRA、NSFW LoRA 与常用采样参数。"
    GJJ_HELP = {
        "description": DESCRIPTION,
        "model_tree": True,
        "dynamic_model_tree_only": True,
        "model_download_url": DEFAULT_MODEL_URL,
        "notice": (
            "模型树会按当前面板选择动态生成：可使用 UNET+CLIP+VAE，或直接使用 checkpoints 底模；"
            "节点内置 LoRA 行和外部 LoRA串联配置也会一并显示。"
        ),
    }
    SEARCH_ALIASES = [
        "懒人",
        "一键生图",
        "图文集成",
        "图文生成",
        "图生图",
        "文生图",
        "boogu",
        "flux",
        "mage flow",
        "mage-flow",
        "hidream",
        "omnigen2",
        "采样器",
    ]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("🖼️ 最终生成图像",)
    INPUT_IS_LIST = True
    OUTPUT_NODE = True  # 设为True以确保节点可以作为有效输出节点
    OUTPUT_TOOLTIPS = ("节点内部完成条件编码、采样和解码后的最终图片。",)
    _shared_runtime_cache: dict[str, tuple[Any, Any, Any]] = {}
    _shared_gpu_pin_cache: dict[str, Any] = {}
    _shared_result_cache: dict[str, dict[str, Any]] = {}
    _shared_result_order: list[str] = []
    _instances: weakref.WeakSet = weakref.WeakSet()
    _MAX_RESULT_CACHE = 8

    def __init__(self):
        self._lora_cache: dict[str, Any] = {}
        self._kept_runtime: tuple[Any, Any, Any] | None = None
        self._instances.add(self)

    @classmethod
    def _remember_result_cache(cls, key: str, image: torch.Tensor, preview_images: list[Any], effective_params: dict[str, Any]) -> None:
        cls._shared_result_cache[key] = {
            "image": image.detach().cpu().clone(),
            "preview_images": list(preview_images or []),
            "effective_params": dict(effective_params or {}),
            "time": time.time(),
        }
        if key in cls._shared_result_order:
            cls._shared_result_order.remove(key)
        cls._shared_result_order.append(key)
        while len(cls._shared_result_order) > cls._MAX_RESULT_CACHE:
            old_key = cls._shared_result_order.pop(0)
            cls._shared_result_cache.pop(old_key, None)

    @classmethod
    def _cached_result(cls, key: str) -> dict[str, Any] | None:
        cached = cls._shared_result_cache.get(key)
        if not cached:
            return None
        if key in cls._shared_result_order:
            cls._shared_result_order.remove(key)
        cls._shared_result_order.append(key)
        return cached

    @classmethod
    def _cached_runtime(cls, key: str) -> tuple[Any, Any, Any] | None:
        return cls._shared_runtime_cache.get(key)

    @classmethod
    def _remember_runtime(cls, key: str, model: Any, clip: Any, vae: Any) -> None:
        cls._shared_runtime_cache[key] = (model, clip, vae)

    @classmethod
    def _pin_runtime_gpu(cls, key: str, model: Any) -> None:
        cls._shared_gpu_pin_cache[key] = model

    @classmethod
    def _clear_shared_caches(cls, *, runtime: bool = False, results: bool = False) -> None:
        if runtime:
            cls._shared_runtime_cache.clear()
            cls._shared_gpu_pin_cache.clear()
        if results:
            cls._shared_result_cache.clear()
            cls._shared_result_order.clear()

    def _release_instance_caches(self, *, runtime: bool = False, loras: bool = False, results: bool = False) -> None:
        if runtime:
            self._kept_runtime = None
            self._clear_shared_caches(runtime=True, results=results)
        elif results:
            self._clear_shared_caches(results=True)
        if loras:
            self._lora_cache.clear()
        _clear_torch_and_comfy_cache()

    @classmethod
    def INPUT_TYPES(cls):
        _raw_diffusion_models = _list_lazy_unet_models() or [DEFAULT_UNET_NAME]
        _diffusion_keywords = ["flux", "f2k", "krea", "krea2", "zimage", "z_image", "z-image", "zit", "qwen", "firered", "boogu", "anima", "mage-flow", "mage_flow", "mageflow", "gguf"]
        _filtered = [
            m
            for m in _raw_diffusion_models
            if any(k in str(m).lower() for k in _diffusion_keywords)
        ]
        diffusion_models = _filtered if _filtered else _raw_diffusion_models
        clip_models = _list_lazy_clip_models() or [DEFAULT_LAZY_CLIP_NAME]
        vae_models = list_vae_models() or [DEFAULT_LAZY_VAE_NAME]
        checkpoint_models = _list_lazy_checkpoints()
        # 确保 loras 目录存在并获取文件列表
        try:
            lora_files = folder_paths.get_filename_list("loras")
            lora_models = [""] + [str(f) for f in lora_files if str(f or "").strip()]
        except Exception:
            lora_models = [""]
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "✨ 正向提示词",
                        "tooltip": "正向提示词；无图片输入时走文生图，有图片输入时走图生图或多图编辑。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE_PROMPT,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "🚫 反向提示词",
                        "tooltip": "反向提示词；默认包含低质量、模糊和常见肢体畸形排除词，清空后会生成零反向条件。",
                    },
                ),
                "main_image_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": MAX_MAIN_IMAGE_INDEX,
                        "display_name": "🎯 主图序号",
                        "tooltip": "有多张参考图时，哪一张作为主参考排在最前；Qwen Image Edit 2511 / FireRed Image Edit 1.1 分支会忽略该项，改为所有图片平等参考。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 64,
                        "max": 8192,
                        "step": 8,
                        "display_name": "📐 宽度",
                        "tooltip": "默认会在第一个图像输入有连接时同步为输入图宽度；关闭 📐 后按面板宽度生成。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 64,
                        "max": 8192,
                        "step": 8,
                        "display_name": "📏 高度",
                        "tooltip": "默认会在第一个图像输入有连接时同步为输入图高度；关闭 📐 后按面板高度生成。",
                    },
                ),
                "batch_size": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 64,
                        "display_name": "🔢 批次数",
                        "tooltip": "文生图时生成的 latent 批次数。",
                    },
                ),
                "unet_name": (
                    diffusion_models,
                    {
                        "default": _preferred_default(
                            diffusion_models, DEFAULT_UNET_NAME
                        ),
                        "display_name": "🟣 UNET 主模型",
                        "tooltip": "主扩散模型；支持 diffusion_models / unet_gguf 中的 safetensors 与 GGUF。前端会根据模型关键词自动推荐匹配的编码器、VAE、LoRA 与采样参数。",
                    },
                ),
                "unet_dtype": (
                    UNET_DTYPE_OPTIONS,
                    {
                        "default": DEFAULT_UNET_DTYPE,
                        "display_name": "⚙️ UNET 精度",
                        "tooltip": "UNET 加载精度；Flux2 工作流默认使用模型原生精度。",
                    },
                ),
                "clip_name1": (
                    clip_models,
                    {
                        "default": _preferred_default(clip_models, DEFAULT_LAZY_CLIP_NAME),
                        "display_name": "🟡 CLIP 编码器",
                        "tooltip": "仅在需要手动选择可变文本编码器的模型族中显示，例如 Flux1 的 T5 编码器；支持 text_encoders / clip_gguf 中的 safetensors 与 GGUF。",
                    },
                ),
                "vae_name": (
                    vae_models,
                    {
                        "default": _preferred_default(vae_models, DEFAULT_LAZY_VAE_NAME),
                        "display_name": "🔴 VAE 解码器",
                        "tooltip": "自动推荐与当前底模同体系的 VAE，可按需手动覆盖。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "🎲 种子",
                        "tooltip": "随机种子。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 4,
                        "min": 1,
                        "max": 10000,
                        "display_name": "👣 步数",
                        "tooltip": "采样步数；前端会按所选加速 LoRA 自动推荐。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "round": 0.01,
                        "display_name": "⚖️ CFG 引导强度",
                        "tooltip": "提示词引导强度；大多数新模型建议较低值。",
                    },
                ),
                "sampler_name": (
                    comfy.samplers.KSampler.SAMPLERS,
                    {
                        "default": "euler",
                        "display_name": "🌀 采样器",
                        "tooltip": "采样算法。",
                    },
                ),
                "scheduler": (
                    comfy.samplers.KSampler.SCHEDULERS,
                    {
                        "default": "simple",
                        "display_name": "📊 调度器",
                        "tooltip": "噪声调度器。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "🔧 降噪",
                        "tooltip": "文生图通常为 1.0；图生图可适当降低保留原图结构。",
                    },
                ),
                "grow_mask_by": (
                    "INT",
                    {
                        "default": 6,
                        "min": 0,
                        "max": 64,
                        "display_name": "🎭 遮罩扩张",
                        "tooltip": "图生图有遮罩时用于 latent 无缝过渡的遮罩扩张像素。",
                    },
                ),
            },
            "optional": FlexibleImageStudioInputType(
                {
                    "batch_source_images": (
                        "STRING",
                        {
                            "default": "[]",
                            "multiline": True,
                            "display_name": "📁 批量图片来源",
                            "tooltip": "前端自动同步的批量图片来源清单；正常使用时会自动隐藏。",
                        },
                    ),
                    "image_01": (
                        "GJJ_BATCH_IMAGE,IMAGE",
                        {
                            "display_name": "🖼️ 批量图片",
                            "tooltip": "可直接接入 GJJ · 多图片加载预览器 的批量图片输出；会按顺序拆成多张参考图参与工作流，并在所有图片里不分先后取最大图自动同步尺寸。",
                        },
                    ),
                    "mask": (
                        "MASK",
                        {
                            "display_name": "🎭 主图遮罩",
                            "tooltip": "可选主图遮罩；存在时会走带 noise_mask 的局部编辑逻辑。",
                        },
                    ),
                    "lora_chain_config": (
                        "LORA_CHAIN_CONFIG",
                        {
                            "display_name": "🔗 LoRA串联配置",
                            "tooltip": "可选接入 LoRA串联配置 节点的输出；接入后会在面板 LoRA 1/LoRA 2 之后继续按顺序串联应用多组 LoRA。",
                        },
                    ),
                    "lora_data": (
                        "STRING",
                        {
                            "default": "[]",
                            "multiline": False,
                            "display_name": "LoRA 配置",
                            "tooltip": "前端 LoRA 面板自动维护的隐藏配置。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "keep_model_loaded": (
                        "BOOLEAN",
                        {
                            "default": False,
                            "display_name": "🧠 保持模型",
                            "tooltip": "开启后执行结束不主动释放当前模型、CLIP 和 VAE，并在节点内保留引用以加速连续生成。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "test_config": (
                        "STRING",
                        {
                            "default": "",
                            "multiline": False,
                            "display_name": "模型测试配置",
                            "tooltip": "前端 🧪 测试窗口自动维护的隐藏配置。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "use_input_image_size": (
                        "BOOLEAN",
                        {
                            "default": True,
                            "display_name": "📐 使用输入图尺寸",
                            "tooltip": "有图像输入时，单图使用原图尺寸；多图使用面积最大的图片为尺寸基准，再按尺寸面板规则统一处理。关闭后使用面板宽高。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "model_source": (
                        MODEL_SOURCE_OPTIONS,
                        {
                            "default": DEFAULT_MODEL_SOURCE,
                            "display_name": "🧠 模型来源",
                            "tooltip": "UNET 主模型：使用 diffusion_models/unet_gguf + CLIP + VAE；底模 checkpoint：像 GJJ_CheckpointDirectGenerator 一样直接加载 models/checkpoints。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "ckpt_name": (
                        checkpoint_models,
                        {
                            "default": _preferred_default(checkpoint_models, DEFAULT_CHECKPOINT_NAME),
                            "display_name": "🎨 底模模型",
                            "tooltip": "从 models/checkpoints 选择可直接生图的底模；仅在模型来源为“底模 checkpoint”时生效。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "device_preference": (
                        DEVICE_PREFERENCE_OPTIONS,
                        {
                            "default": DEFAULT_DEVICE_PREFERENCE,
                            "display_name": "智能调度",
                            "tooltip": "交给 ComfyUI 根据实时可用显存自动决定完整加载、部分驻留和卸载，不再强制 GPU 或 CPU。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "enable_sage_attention": (
                        "BOOLEAN",
                        {
                            "default": False,
                            "display_name": "启用SageAttention",
                            "tooltip": "为采样模型启用 SageAttention；缺少对应运行库时按下方策略处理。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "sage_attention_mode": (
                        SAGE_ATTENTION_MODES,
                        {
                            "default": "自动",
                            "display_name": "SageAttention模式",
                            "tooltip": "选择 SageAttention 后端；自动模式遇到不支持的 head_dim 时会回退 ComfyUI 原生注意力。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "allow_sage_compile": (
                        "BOOLEAN",
                        {
                            "default": False,
                            "display_name": "允许Sage编译",
                            "tooltip": "允许 SageAttention 参与 torch.compile；默认关闭更稳。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "enable_fp16_accumulation_setting": (
                        "BOOLEAN",
                        {
                            "default": False,
                            "display_name": "启用FP16累积设置",
                            "tooltip": "兼容旧工作流的内部开关；懒人工作室面板已合并到“FP16累积”按钮。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "fp16_accumulation": (
                        "BOOLEAN",
                        {
                            "default": True,
                            "display_name": "FP16累积",
                            "tooltip": "开启时同时启用 FP16 累积设置并使用 CUDA FP16 矩阵乘累积路径。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "missing_sage_attention_policy": (
                        MISSING_SAGE_HANDLING_MODES,
                        {
                            "default": "自动跳过SageAttention继续运行",
                            "display_name": "缺SageAttention处理",
                            "tooltip": "缺少所选 SageAttention 依赖时的兼容策略；当前安全行为会跳过 Sage 并继续其它补丁。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "global_prompt": (
                        "STRING",
                        {
                            "default": DEFAULT_GLOBAL_QUALITY_PROMPT,
                            "multiline": True,
                            "display_name": "全局提示词",
                            "tooltip": "填写后会自动添加到每一条正向提示词的最前面。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                    "image_resize_config": (
                        "STRING",
                        {
                            "default": json.dumps(DEFAULT_LAZY_IMAGE_RESIZE_CONFIG, ensure_ascii=False),
                            "multiline": False,
                            "display_name": "图片尺寸修改配置",
                            "tooltip": "📐 尺寸面板自动维护：尺寸模式、图片适配方法和保留位置。",
                            "hidden": True,
                            "display": "hidden",
                            "forceInput": False,
                        },
                    ),
                }
            ),
            "hidden": {
                "prompt_graph": "PROMPT",
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def _load_lora_state(self, lora_name: str):
        lora_path = folder_paths.get_full_path("loras", lora_name)
        if not lora_path:
            raise _format_model_missing_error("LoRA", lora_name, ("loras",))
        print(f"[DEBUG] Loading LoRA model: {lora_name}")
        print(f"[DEBUG] LoRA model path: {lora_path}")
        if lora_path not in self._lora_cache:
            self._lora_cache[lora_path] = comfy.utils.load_torch_file(
                lora_path, safe_load=True
            )
            print(f"[DEBUG] Successfully loaded and cached LoRA model: {lora_name}")
        else:
            print(f"[DEBUG] Using cached LoRA model: {lora_name}")
        return self._lora_cache[lora_path]

    def _apply_loras(
        self,
        model,
        clip,
        clip_type: str,
        lora_chain_config: str = "",
        lora_data: str = "",
        use_checkpoint_model: bool = False,
    ):
        current_model = model
        current_clip = clip
        lora_parts = [
            normalize_lora_chain_data(value)
            for value in (lora_data, lora_chain_config)
            if str(value or "").strip()
        ]
        if not lora_parts:
            return current_model, current_clip

        merged_lora_rows: list[dict[str, Any]] = []
        for part in lora_parts:
            try:
                rows = normalize_lora_chain_data(part)
                parsed = json.loads(rows)
            except Exception:
                parsed = []
            if isinstance(parsed, list):
                merged_lora_rows.extend(item for item in parsed if isinstance(item, dict))

        final_lora_data = json.dumps(merged_lora_rows, ensure_ascii=False)
        effective_lora_rows = [
            row for row in merged_lora_rows
            if row.get("enabled", True) is not False and str(row.get("name", "")).strip()
        ]
        if effective_lora_rows:
            print(f"[GJJ] LazyImageStudio 应用 LoRA 数量：{len(effective_lora_rows)}")
            if use_checkpoint_model:
                print("[GJJ] LazyImageStudio 底模 checkpoint 分支：使用原生 LoRA 应用路径")
                current_model, current_clip = self._apply_checkpoint_loras(
                    current_model,
                    current_clip,
                    clip_type,
                    final_lora_data,
                )
            elif _has_enabled_lora(
                KREA2_STYLE_REFERENCE_LORA_STEM,
                final_lora_data,
            ):
                for row in effective_lora_rows:
                    lora_name = clean_lora_config_name(row.get("name", ""))
                    try:
                        strength = float(row.get("strength", 1.0))
                    except (TypeError, ValueError):
                        strength = 1.0
                    if abs(strength) < 1e-5:
                        continue
                    if (
                        Path(lora_name.replace("\\", "/")).stem.casefold()
                        == KREA2_STYLE_REFERENCE_LORA_STEM.casefold()
                    ):
                        try:
                            from nodes import LoraLoaderModelOnly

                            current_model = LoraLoaderModelOnly().load_lora_model_only(
                                current_model,
                                lora_name,
                                strength,
                            )[0]
                        except Exception:
                            lora_state = self._load_lora_state(lora_name)
                            current_model, _ = comfy.sd.load_lora_for_models(
                                current_model,
                                None,
                                lora_state,
                                strength,
                                0.0,
                            )
                        print(
                            "[GJJ] LazyImageStudio Krea2 Style Reference "
                            f"按源工作流仅应用到 MODEL：{lora_name} ({strength:g})"
                        )
                        continue
                    single_lora_data = json.dumps([row], ensure_ascii=False)
                    current_model, current_clip, _ = apply_lora_chain_config(
                        current_model,
                        current_clip,
                        lora_data=single_lora_data,
                        loaded_lora_cache=None,
                    )
            else:
                current_model, current_clip, _ = apply_lora_chain_config(
                    current_model,
                    current_clip,
                    lora_data=final_lora_data,
                    loaded_lora_cache=None,
                )
        return current_model, current_clip

    def _apply_checkpoint_loras(
        self,
        model,
        clip,
        clip_type: str,
        lora_data: str,
    ):
        current_model = model
        current_clip = clip
        skip_clip_lora = _should_skip_clip_lora_for_family(clip_type)
        for item in parse_lora_data(lora_data):
            if item.get("enabled", True) is False:
                continue
            lora_name = clean_lora_config_name(item.get("name", ""))
            if not lora_name:
                continue
            try:
                strength = float(item.get("strength", 1.0))
            except (TypeError, ValueError):
                strength = 1.0
            if abs(strength) < 1e-5:
                continue

            lora_state = self._load_lora_state(lora_name)
            try:
                patched_model, patched_clip = apply_lora_to_model_and_clip(
                    current_model,
                    None if skip_clip_lora else current_clip,
                    lora_state,
                    strength,
                    0.0 if skip_clip_lora else strength,
                )
            except Exception as exc:
                raise RuntimeError(f"LoRA 应用失败：{lora_name}\n{exc}") from exc

            current_model = patched_model
            if not skip_clip_lora and patched_clip is not None:
                current_clip = patched_clip
            print(
                f"[GJJ] LazyImageStudio checkpoint LoRA 已应用：{lora_name} "
                f"(model={strength}, clip={0.0 if skip_clip_lora else strength})"
            )
        return current_model, current_clip

    def _lora_trigger_text(self, lora_data: str = "", lora_chain_config: str = "") -> str:
        triggers: list[str] = []
        seen: set[str] = set()
        for value in (lora_data, lora_chain_config):
            if not str(value or "").strip():
                continue
            trigger_text = build_lora_trigger_text(normalize_lora_chain_data(value))
            for trigger in str(trigger_text or "").replace("\n", ",").split(","):
                item = " ".join(str(trigger or "").strip().split())
                key = item.lower()
                if item and key not in seen:
                    seen.add(key)
                    triggers.append(item)
        return ", ".join(triggers)

    def _encode_text_conditioning(self, clip, text: str):
        tokens = clip.tokenize(str(text or ""))
        return clip.encode_from_tokens_scheduled(tokens)

    def _encode_negative_conditioning(self, clip, positive, negative_prompt: str):
        if str(negative_prompt or "").strip():
            return self._encode_text_conditioning(clip, negative_prompt)
        return zero_out_conditioning(positive)

    def _apply_ltx_nag_model(self, model, nag_conditioning, *, enabled: bool):
        if not enabled:
            return model
        if _GJJLTX2NAG is None:
            raise RuntimeError("GJJ_LTX2NAG 不可用，无法应用 LTX NAG 流程。")
        return _GJJLTX2NAG().apply_nag(
            model,
            LTX_NAG_SCALE,
            LTX_NAG_ALPHA,
            LTX_NAG_TAU,
            nag_cond_video=nag_conditioning,
            nag_cond_audio=None,
            inplace=True,
        )[0]

    def _sample_flux2_reference_workflow(
        self,
        model,
        positive,
        negative,
        latent_out,
        width: int,
        height: int,
        steps: int,
        seed: int,
        cfg: float,
        sampler_name: str,
    ):
        selected_sampler = str(sampler_name or "").strip() or "lcm"
        noise = RandomNoise(int(seed))
        sampler = KSamplerSelect(selected_sampler)
        sigmas = Flux2Scheduler(int(steps), int(width), int(height))
        guider = CFGGuider(model, positive, negative, float(cfg))
        result = SamplerCustomAdvanced(noise, guider, sampler, sigmas, latent_out)
        # 将输出的 tensor 包装成字典格式，以兼容 VAEDecode
        return {"samples": result["output"]}

    def _encode_boogu_image_edit_turbo_workflow(
        self,
        clip,
        vae,
        prompt: str,
        negative_prompt: str,
        pairs: list[dict[str, Any]],
        batch_size: int,
        target_width: int | None = None,
        target_height: int | None = None,
    ):
        if not pairs:
            raise RuntimeError("Boogu Image Edit Turbo 分支至少需要一张有效参考图。")

        encoder_kwargs: dict[str, Any] = {}
        reference_images: list[torch.Tensor] = []
        for index, pair in enumerate(pairs[:16], start=1):
            image = pair.get("image")
            if not isinstance(image, torch.Tensor):
                continue
            encoder_kwargs[f"image_{index}"] = image
            reference_images.append(image)

        if not reference_images:
            raise RuntimeError("Boogu Image Edit Turbo 分支未收到可用图片张量。")

        first_image = reference_images[0]
        latent_width = int(target_width) if target_width else int(first_image.shape[2])
        latent_height = int(target_height) if target_height else int(first_image.shape[1])
        latent_width = max(8, latent_width)
        latent_height = max(8, latent_height)
        latent_out = EmptyLatentImage().generate(
            latent_width,
            latent_height,
            max(1, int(batch_size)),
        )[0]

        positive, negative = GJJ_TextEncodeBooguEdit().encode(
            clip,
            str(prompt or ""),
            negative_prompt=str(negative_prompt or ""),
            vae=vae,
            **encoder_kwargs,
        )
        return positive, negative, latent_out, latent_width, latent_height

    def _sample_boogu_image_edit_turbo_workflow(
        self,
        model,
        positive,
        negative,
        latent_out,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        model_sampling: str,
        model_shift: float,
    ):
        sigma_model = _patch_model_sampling(model, str(model_sampling or ""), float(model_shift or 0.0))
        sigmas = _basic_scheduler_sigmas(sigma_model, scheduler, int(steps), float(denoise))
        try:
            from comfy_extras.nodes_custom_sampler import KSamplerSelect as OfficialKSamplerSelect
            from comfy_extras.nodes_custom_sampler import Noise_RandomNoise
            import comfy.sample
            import latent_preview
        except Exception as exc:
            print(f"[GJJ_LazyImageStudio] Boogu Turbo 官方 SamplerCustom 路径不可用，回退兼容采样：{exc}")
            noise = RandomNoise(int(seed))
            sampler = KSamplerSelect(str(sampler_name or "dpmpp_2m") or "dpmpp_2m")
            guider = CFGGuider(model, positive, negative, float(cfg))
            result = SamplerCustomAdvanced(noise, guider, sampler, sigmas, latent_out)
            return {"samples": result["output"]}

        latent = latent_out.copy()
        latent_image = latent["samples"]
        latent_image = comfy.sample.fix_empty_latent_channels(
            model,
            latent_image,
            latent.get("downscale_ratio_spacial", None),
            latent.get("downscale_ratio_temporal", None),
        )
        latent["samples"] = latent_image
        noise = Noise_RandomNoise(int(seed)).generate_noise(latent)
        noise_mask = latent.get("noise_mask")
        sampler = OfficialKSamplerSelect().get_sampler(
            str(sampler_name or "dpmpp_2m") or "dpmpp_2m"
        )[0]
        x0_output = {}
        callback = latent_preview.prepare_callback(model, sigmas.shape[-1] - 1, x0_output)
        disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED
        samples = comfy.sample.sample_custom(
            model,
            noise,
            float(cfg),
            sampler,
            sigmas,
            positive,
            negative,
            latent_image,
            noise_mask=noise_mask,
            callback=callback,
            disable_pbar=disable_pbar,
            seed=int(seed),
        )
        out = latent.copy()
        out.pop("downscale_ratio_spacial", None)
        out.pop("downscale_ratio_temporal", None)
        out["samples"] = samples
        return out

    def _encode_krea2_image_edit(
        self,
        model,
        clip,
        vae,
        prompt: str,
        negative_prompt: str,
        pairs: list[dict[str, Any]],
        width: int,
        height: int,
        batch_size: int,
        identity_lora_strength: float = 1.0,
    ):
        if not pairs:
            raise RuntimeError("Krea2 图生图分支至少需要一张有效参考图。")

        reference_images = [
            pair["image"]
            for pair in pairs[:2]
            if isinstance(pair.get("image"), torch.Tensor)
        ]
        if not reference_images:
            raise RuntimeError("Krea2 图生图分支没有解析到有效参考图张量。")
        if len(pairs) > 2:
            print(
                f"[GJJ_LazyImageStudio] Krea2 Identity Edit 最多支持两张参考图，"
                f"当前收到 {len(pairs)} 张，仅使用前两张。"
            )

        positive, negative = _GJJKrea2EditGroundedEncode().encode(
            clip=clip,
            image=reference_images,
            positive_prompt=str(prompt or ""),
            negative_prompt=str(negative_prompt or ""),
            grounding_px=768,
            system_prompt="",
        )
        patched_model, _output_vae = _GJJKrea2EditModelPatch().patch(
            model=model,
            vae=vae,
            source_image=reference_images,
            lora_name=KREA2_IDENTITY_EDIT_LORA,
            lora_strength=float(identity_lora_strength),
            fit_mode="适配",
            reference_strength=4.0,
            earlier_reference_strength=1.0,
        )
        latent_out = _empty_sd3_latent(
            int(width),
            int(height),
            max(1, int(batch_size)),
        )
        return patched_model, positive, negative, latent_out

    def _encode_krea2_style_reference(
        self,
        clip,
        vae,
        prompt: str,
        pairs: list[dict[str, Any]],
        width: int,
        height: int,
        batch_size: int,
    ):
        reference_images = [
            pair["image"]
            for pair in pairs[:QWEN_IMAGE_EDIT_MAX_PLUS_IMAGES]
            if isinstance(pair.get("image"), torch.Tensor)
        ]
        if not reference_images:
            raise RuntimeError("Krea2 Style Reference 分支至少需要一张有效参考图。")
        if len(pairs) > QWEN_IMAGE_EDIT_MAX_PLUS_IMAGES:
            print(
                f"[GJJ_LazyImageStudio] Krea2 Style Reference 最多支持 "
                f"{QWEN_IMAGE_EDIT_MAX_PLUS_IMAGES} 张参考图，当前收到 {len(pairs)} 张，"
                f"仅使用主图优先排序后的前 {QWEN_IMAGE_EDIT_MAX_PLUS_IMAGES} 张。"
            )

        try:
            from comfy_extras.nodes_qwen import TextEncodeQwenImageEditPlus
        except ImportError:
            from comfy_extras.nodes_qwen_image import TextEncodeQwenImageEditPlus
        from comfy_extras.nodes_flux import FluxKontextMultiReferenceLatentMethod
        from nodes import ConditioningZeroOut

        image_inputs = reference_images + [None] * (
            QWEN_IMAGE_EDIT_MAX_PLUS_IMAGES - len(reference_images)
        )
        if hasattr(TextEncodeQwenImageEditPlus, "execute"):
            encoded = TextEncodeQwenImageEditPlus.execute(
                clip=clip,
                vae=vae,
                prompt=str(prompt or ""),
                image1=image_inputs[0],
                image2=image_inputs[1],
                image3=image_inputs[2],
            )
        else:
            encoded = TextEncodeQwenImageEditPlus().encode(
                clip=clip,
                vae=vae,
                prompt=str(prompt or ""),
                image1=image_inputs[0],
                image2=image_inputs[1],
                image3=image_inputs[2],
            )
        encoded_args = getattr(encoded, "args", encoded)
        positive = encoded_args[0]

        method_node = FluxKontextMultiReferenceLatentMethod
        if hasattr(method_node, "execute"):
            method_result = method_node.execute(
                conditioning=positive,
                reference_latents_method="index_timestep_zero",
            )
        else:
            method_result = method_node().append(
                conditioning=positive,
                reference_latents_method="index_timestep_zero",
            )
        method_args = getattr(method_result, "args", method_result)
        positive = method_args[0]
        negative = ConditioningZeroOut().zero_out(positive)[0]
        latent_out = EmptyLatentImage().generate(
            1024,
            1024,
            max(1, int(batch_size)),
        )[0]
        return positive, negative, latent_out

    def _sample_krea2_style_reference_workflow(
        self,
        model,
        positive,
        negative,
        latent_out,
        seed: int,
    ):
        from comfy_extras.nodes_custom_sampler import (
            BasicScheduler,
            CFGGuider as OfficialCFGGuider,
            KSamplerSelect as OfficialKSamplerSelect,
            RandomNoise as OfficialRandomNoise,
            SamplerCustomAdvanced as OfficialSamplerCustomAdvanced,
        )

        def output_args(value):
            args = getattr(value, "args", value)
            return args if isinstance(args, (tuple, list)) else (args,)

        noise = output_args(OfficialRandomNoise().get_noise(int(seed)))[0]
        guider = output_args(
            OfficialCFGGuider().get_guider(model, positive, negative, 1.0)
        )[0]
        sampler = output_args(
            OfficialKSamplerSelect().get_sampler("euler")
        )[0]
        sigmas = output_args(
            BasicScheduler().get_sigmas(model, "simple", 8, 1.0)
        )[0]
        return output_args(
            OfficialSamplerCustomAdvanced().sample(
                noise,
                guider,
                sampler,
                sigmas,
                latent_out,
            )
        )[0]

    def _rewrite_qwen_image_references(self, prompt: str, image_count: int = QWEN_IMAGE_EDIT_MAX_PLUS_IMAGES) -> str:
        text = str(prompt or "")
        max_index = max(1, min(QWEN_IMAGE_EDIT_MAX_PLUS_IMAGES, int(image_count or 1)))
        for index in range(1, max_index + 1):
            text = re.sub(
                rf"(?i)\b(?:picture|image|img)\s*#?\s*{index}\b",
                f"image{index}",
                text,
            )
            text = re.sub(
                rf"(?:第\s*{index}\s*[张个幅]?\s*(?:图|图片|参考图)|图\s*{index}|图片\s*{index}|参考图\s*{index})",
                f"image{index}",
                text,
            )
        return text

    def _encode_equal_reference_image_edit(
        self,
        clip,
        vae,
        prompt: str,
        negative_prompt: str,
        pairs: list[dict[str, Any]],
        vl_long_edge: int = 512,
        target_width: int = 1024,
        target_height: int = 1024,
        batch_size: int = 1,
    ):
        # 限制最大参考图数量以避免OOM，特别是对于FireRed和qwen-image-edit模型
        MAX_REFERENCE_IMAGES = QWEN_IMAGE_EDIT_MAX_PLUS_IMAGES
        if len(pairs) > MAX_REFERENCE_IMAGES:
            print(
                f"[WARNING] 参考图数量 ({len(pairs)}) 超过最大限制 ({MAX_REFERENCE_IMAGES})，仅使用前 {MAX_REFERENCE_IMAGES} 张"
            )
            pairs = pairs[:MAX_REFERENCE_IMAGES]

        # 对于FireRed和qwen-image-edit模型，降低视觉语言编码分辨率以节省显存
        canvas_width, canvas_height = _largest_pair_canvas_size(
            pairs, target_width, target_height
        )
        image_prompt = ""
        ref_latents: list[torch.Tensor] = []
        vl_images: list[torch.Tensor] = []

        # 降低VL处理分辨率以节省显存
        effective_vl_long_edge = min(vl_long_edge, 384)  # 限制最大为384

        for slot, pair in enumerate(pairs):
            image = pair["image"]
            prepared_image, _ignore_mask, _ignore_outpaint = (
                _prepare_primary_image_for_target(
                    image, canvas_width, canvas_height, None
                )
            )
            ref_latents.append(vae.encode(prepared_image[:, :, :, :3]))
            vl_image, _ignore_mask, _ignore_outpaint = (
                _prepare_primary_image_for_target(
                    prepared_image,
                    int(effective_vl_long_edge),
                    int(effective_vl_long_edge),
                    None,
                )
            )
            vl_images.append(vl_image[:, :, :, :3])
            image_prompt += f"image{slot + 1}: {QWEN_IMAGE_EDIT_IMAGE_TOKEN}\n"

            # 及时清理不需要的中间变量以释放显存
            del prepared_image, vl_image

        if not ref_latents:
            raise RuntimeError("平等参考模式至少需要一张有效参考图。")
        full_prompt = self._rewrite_qwen_image_references(image_prompt + str(prompt or ""), len(vl_images))
        tokens = clip.tokenize(
            full_prompt,
            images=vl_images,
            llama_template=QWEN_IMAGE_EDIT_LLAMA_TEMPLATE,
        )
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        positive = node_helpers.conditioning_set_values(
            conditioning, {"reference_latents": ref_latents}, append=True
        )
        negative = self._encode_negative_conditioning(clip, positive, negative_prompt)
        latent_out = _empty_sd3_latent(
            int(canvas_width),
            int(canvas_height),
            max(1, int(batch_size)),
        )

        # 清理VL图像列表以释放显存
        del vl_images
        del ref_latents
        del conditioning

        # 及时释放 GPU/CPU 缓存（Qwen/FireRed 模型会被 ComfyUI 缓存，后续调用速度飞快）
        import gc
        gc.collect()
        if hasattr(torch.cuda, 'empty_cache'):
            torch.cuda.empty_cache()

        return positive, negative, latent_out, canvas_width, canvas_height

    def _encode_multi_image_edit(
        self,
        clip,
        vae,
        prompt: str,
        negative_prompt: str,
        main_image_index: int,
        pairs: list[dict[str, Any]],
        main_mask=None,
        main_long_edge: int = 1024,
        vl_long_edge: int = 512,
        target_width: int = 1024,
        target_height: int = 1024,
        disable_auto_noise_mask: bool = False,
    ):
        # 限制最大参考图数量以避免OOM
        MAX_REFERENCE_IMAGES = 5
        if len(pairs) > MAX_REFERENCE_IMAGES:
            print(
                f"[WARNING] 多图编辑参考图数量 ({len(pairs)}) 超过最大限制 ({MAX_REFERENCE_IMAGES})，仅使用前 {MAX_REFERENCE_IMAGES} 张"
            )
            # 确保主图在限制范围内
            main_slot = max(0, min(len(pairs) - 1, int(main_image_index) - 1))
            if main_slot >= MAX_REFERENCE_IMAGES:
                # 如果主图超出限制，将其包含在前MAX_REFERENCE_IMAGES张中
                selected_pairs = [pairs[main_slot]] + pairs[: MAX_REFERENCE_IMAGES - 1]
            else:
                selected_pairs = pairs[:MAX_REFERENCE_IMAGES]
            pairs = selected_pairs

        valid_length = len(pairs)
        main_slot = max(0, min(valid_length - 1, int(main_image_index) - 1))
        image_prompt = ""
        main_ref_latent = None
        noise_mask = None
        vl_images: list[torch.Tensor] = []

        # 降低VL处理分辨率以节省显存
        effective_vl_long_edge = min(vl_long_edge, 384)

        for slot, pair in enumerate(pairs):
            image = pair["image"]
            is_main = slot == main_slot
            if is_main:
                processed_image, prepared_mask, _ = _prepare_primary_image_for_target(
                    image, int(target_width), int(target_height), main_mask
                )
                main_ref_latent = vae.encode(processed_image[:, :, :, :3])
                noise_mask = None if disable_auto_noise_mask else prepared_mask
                vl_image, _ignore_mask, _ignore_outpaint = (
                    _prepare_primary_image_for_target(
                        processed_image,
                        int(effective_vl_long_edge),
                        int(effective_vl_long_edge),
                        None,
                    )
                )
            else:
                vl_image, _ignore_mask, _ignore_outpaint = (
                    _prepare_primary_image_for_target(
                        image,
                        int(effective_vl_long_edge),
                        int(effective_vl_long_edge),
                        None,
                    )
                )
            vl_images.append(vl_image[:, :, :, :3])
            image_prompt += f"Picture {slot + 1}: {QWEN_IMAGE_EDIT_IMAGE_TOKEN}"

            # 及时清理不需要的中间变量
            del vl_image

        if main_ref_latent is None:
            raise RuntimeError("主图参考 latent 生成失败，请检查主图输入是否有效。")
        full_prompt = image_prompt + str(prompt or "")
        tokens = clip.tokenize(
            full_prompt,
            images=vl_images,
            llama_template=QWEN_IMAGE_EDIT_LLAMA_TEMPLATE,
        )
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        positive = node_helpers.conditioning_set_values(
            conditioning, {"reference_latents": [main_ref_latent]}, append=True
        )
        negative = self._encode_negative_conditioning(clip, positive, negative_prompt)
        latent_out = {"samples": main_ref_latent}
        if noise_mask is not None:
            latent_out["noise_mask"] = noise_mask

        # 清理VL图像列表以释放显存
        del vl_images

        return positive, negative, latent_out

    def _build_latent(
        self,
        vae,
        width,
        height,
        batch_size,
        image_pairs,
        mask,
        grow_mask_by,
        preset,
        disable_auto_mask=False,
    ):
        clip_type = str(preset.get("resolved_clip_type") or preset.get("clip_type") or "")
        unet_name = str(preset.get("resolved_unet_name") or preset.get("unet_name") or "")
        is_flux2_model = _is_flux2_family(unet_name, clip_type)

        if not image_pairs:
            if _normalize_text(preset.get("clip_type", "")) == "lumina2":
                if EmptySD3LatentImage is not None:
                    return EmptySD3LatentImage().generate(
                        int(width), int(height), int(batch_size)
                    )[0]
                else:
                    # EmptySD3LatentImage 不可用时，使用标准 EmptyLatentImage
                    return EmptyLatentImage().generate(
                        int(width), int(height), int(batch_size)
                    )[0]
            if is_flux2_model:
                latent_dict = EmptyFlux2LatentImage(
                    int(width), int(height), int(batch_size)
                )
                return latent_dict
            return EmptyLatentImage().generate(
                int(width), int(height), int(batch_size)
            )[0]
        main_slot = max(0, min(len(image_pairs) - 1, 0))
        image = image_pairs[main_slot]["image"]
        prepared_image, prepared_mask, use_outpaint = _prepare_primary_image_for_target(
            image, int(width), int(height), mask
        )
        if prepared_mask is not None and (use_outpaint or mask is not None) and not bool(disable_auto_mask):
            return VAEEncodeForInpaint().encode(
                vae, prepared_image, prepared_mask, int(grow_mask_by)
            )[0]
        return VAEEncode().encode(vae, prepared_image)[0]

    def _encode_flux2_multi_reference(
        self,
        clip,
        vae,
        prompt: str,
        negative_prompt: str,
        main_image_index: int,
        pairs: list[dict[str, Any]],
        width: int,
        height: int,
        batch_size: int,
        preset: dict[str, Any],
    ):
        ordered_pairs = _reorder_pairs_by_main_index(pairs, main_image_index)
        if not ordered_pairs:
            raise RuntimeError("Flux2 多图参考模式至少需要一张有效参考图。")
        positive = self._encode_text_conditioning(clip, prompt)
        negative = self._encode_negative_conditioning(clip, positive, negative_prompt)
        resolved_width, resolved_height = _largest_pair_canvas_size(
            ordered_pairs, width, height
        )
        reference_latents: list[torch.Tensor] = []
        reference_sizes: list[str] = []
        for pair in ordered_pairs:
            image = pair["image"]
            # F2K/Flux2 多图参考统一使用等比缩放补边，避免不同宽高比参考图被拉伸。
            scaled_image, _ignore_mask, _ignore_outpaint = (
                _prepare_primary_image_for_target(
                    image,
                    int(resolved_width),
                    int(resolved_height),
                    None,
                )
            )

            reference_latent = VAEEncode().encode(vae, scaled_image)[0]["samples"]
            reference_latents.append(reference_latent)
            reference_sizes.append(
                f"{int(scaled_image.shape[2])}x{int(scaled_image.shape[1])}"
            )
        if reference_latents:
            positive = node_helpers.conditioning_set_values(
                positive, {"reference_latents": reference_latents}, append=True
            )
        latent_out = EmptyFlux2LatentImage(
            int(resolved_width), int(resolved_height), int(batch_size)
        )
        print(
            "[GJJ] Flux2/F2K 多图参考："
            f"主图+参考图 {len(reference_latents)} 张，"
            f"等比补边编码尺寸 {', '.join(reference_sizes)}，"
            f"输出 {resolved_width}x{resolved_height}，batch={max(1, int(batch_size))}"
        )
        return positive, negative, latent_out, resolved_width, resolved_height

    def _load_runtime_pipeline(
        self,
        unet_name: str,
        unet_dtype: str,
        clip_names: list[str],
        clip_type: str,
        vae_name: str,
        model_source: str = DEFAULT_MODEL_SOURCE,
        ckpt_name: str = DEFAULT_CHECKPOINT_NAME,
        unique_id: Any = None,
    ):
        if _is_checkpoint_model_source(model_source, ckpt_name):
            checkpoint_name = str(ckpt_name or "").strip()
            if not checkpoint_name:
                raise RuntimeError("未选择底模 checkpoint，请先在 🧠 模型设置里选择底模模型。")
            try:
                print(f"[DEBUG] Loading checkpoint model: {checkpoint_name}")
                model, clip, vae = CheckpointLoaderSimple().load_checkpoint(checkpoint_name)
                print(f"[DEBUG] Successfully loaded checkpoint model: {checkpoint_name}")
                print(f"\033[95m🎨 Checkpoint: {checkpoint_name}\033[0m")
                return model, clip, vae
            except Exception as exc:
                raise _format_runtime_error("底模 checkpoint 加载", exc) from exc
        model = _load_model(unet_name, unet_dtype, clip_type, unique_id=unique_id)
        clip = _load_clip_from_names(clip_names, clip_type)
        vae = _load_vae(vae_name)
        return model, clip, vae

    def create_image(
        self,
        prompt,
        negative_prompt,
        main_image_index,
        width,
        height,
        batch_size,
        unet_name,
        unet_dtype,
        clip_name1,
        vae_name,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        grow_mask_by,
        lora_chain_config="",
        lora_data="",
        batch_source_images="[]",
        mask=None,
        disable_reference_auto_mask=False,
        force_empty_latent_reference=False,
        disable_equal_reference_canvas=False,
        keep_model_loaded=False,
        test_config="",
        use_input_image_size=True,
        model_source=DEFAULT_MODEL_SOURCE,
        ckpt_name=DEFAULT_CHECKPOINT_NAME,
        device_preference=DEFAULT_DEVICE_PREFERENCE,
        enable_sage_attention=False,
        sage_attention_mode="自动",
        allow_sage_compile=False,
        enable_fp16_accumulation_setting=False,
        fp16_accumulation=True,
        missing_sage_attention_policy="自动跳过SageAttention继续运行",
        prompt_graph=None,
        unique_id=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        image_resize_config_value = _unwrap_list_input(
            kwargs.pop("image_resize_config", "")
        )
        image_resize_config = _lazy_image_resize_config(image_resize_config_value)
        image_resize_config_json = json.dumps(
            image_resize_config, ensure_ascii=False, sort_keys=True
        )
        global_prompt = str(_unwrap_list_input(kwargs.pop("global_prompt", "")) or "").strip()
        raw_prompt_items = _prompt_batch_items(prompt)
        prompt_items = list(raw_prompt_items)
        if global_prompt:
            prompt_items = [
                f"{global_prompt}, {item}" if str(item or "").strip() else global_prompt
                for item in (prompt_items or [""])
            ]
            print(
                f"[GJJ] LazyImageStudio 全局提示词已前置到 {len(prompt_items)} 条提示词："
                f"{global_prompt}"
            )
        prompt = prompt_items[0] if prompt_items else ""
        negative_prompt = _unwrap_list_input(negative_prompt)
        main_image_index = _unwrap_list_input(main_image_index)
        width = _unwrap_list_input(width)
        height = _unwrap_list_input(height)
        batch_size = _unwrap_list_input(batch_size)
        unet_name = _unwrap_list_input(unet_name)
        unet_dtype = _unwrap_list_input(unet_dtype)
        clip_name1 = _unwrap_list_input(clip_name1)
        vae_name = _unwrap_list_input(vae_name)
        seed = _unwrap_list_input(seed)
        steps = _unwrap_list_input(steps)
        cfg = _unwrap_list_input(cfg)
        sampler_name = _unwrap_list_input(sampler_name)
        scheduler = _unwrap_list_input(scheduler)
        denoise = _unwrap_list_input(denoise)
        grow_mask_by = _unwrap_list_input(grow_mask_by)
        lora_chain_config = _unwrap_list_input(lora_chain_config)
        lora_data = _unwrap_list_input(lora_data)
        batch_source_images = _unwrap_list_input(batch_source_images)
        mask = _unwrap_list_input(mask)
        disable_reference_auto_mask = _unwrap_list_input(disable_reference_auto_mask)
        force_empty_latent_reference = _unwrap_list_input(force_empty_latent_reference)
        disable_equal_reference_canvas = _unwrap_list_input(disable_equal_reference_canvas)
        keep_model_loaded = _unwrap_list_input(keep_model_loaded)
        test_config = _unwrap_list_input(test_config)
        use_input_image_size = _unwrap_list_input(use_input_image_size)
        model_source = _unwrap_list_input(model_source)
        ckpt_name = _unwrap_list_input(ckpt_name)
        device_preference = _unwrap_list_input(device_preference)
        unet_name = _resolve_lazy_unet_model_name(unet_name)
        enable_sage_attention = _unwrap_list_input(enable_sage_attention)
        sage_attention_mode = _unwrap_list_input(sage_attention_mode)
        allow_sage_compile = _unwrap_list_input(allow_sage_compile)
        enable_fp16_accumulation_setting = _unwrap_list_input(enable_fp16_accumulation_setting)
        fp16_accumulation = _unwrap_list_input(fp16_accumulation)
        missing_sage_attention_policy = _unwrap_list_input(missing_sage_attention_policy)
        prompt_graph = _unwrap_list_input(prompt_graph)
        unique_id = _unwrap_list_input(unique_id)
        extra_pnginfo = _unwrap_list_input(extra_pnginfo)
        keep_model_loaded = _as_bool(keep_model_loaded)
        disable_equal_reference_canvas = _as_bool(disable_equal_reference_canvas)
        use_input_image_size = _as_bool(use_input_image_size)
        device_preference = _normalize_device_preference(device_preference)
        enable_sage_attention = _as_bool(enable_sage_attention)
        sage_attention_mode = str(sage_attention_mode or "自动")
        if sage_attention_mode not in SAGE_ATTENTION_MODES:
            sage_attention_mode = "自动"
        allow_sage_compile = _as_bool(allow_sage_compile)
        enable_fp16_accumulation_setting = _as_bool(enable_fp16_accumulation_setting)
        fp16_accumulation = _as_bool(fp16_accumulation)
        missing_sage_attention_policy = str(
            missing_sage_attention_policy or "自动跳过SageAttention继续运行"
        )
        if missing_sage_attention_policy not in MISSING_SAGE_HANDLING_MODES:
            missing_sage_attention_policy = "自动跳过SageAttention继续运行"
        optimization_params = {
            "enable_sage_attention": bool(enable_sage_attention),
            "sage_attention_mode": sage_attention_mode,
            "allow_sage_compile": bool(allow_sage_compile),
            "enable_fp16_accumulation_setting": bool(enable_fp16_accumulation_setting),
            "fp16_accumulation": bool(fp16_accumulation),
            "missing_sage_attention_policy": missing_sage_attention_policy,
        }

        test_config_data: dict[str, Any] = {}
        if str(test_config or "").strip():
            try:
                parsed_test_config = json.loads(str(test_config))
                if isinstance(parsed_test_config, dict):
                    test_config_data = parsed_test_config
            except Exception:
                test_config_data = {}

        # 兼容旧工作流：如果隐藏输入未提交，再从 workflow properties 读取。
        try:
            if extra_pnginfo and isinstance(extra_pnginfo, dict):
                workflow = extra_pnginfo.get("workflow", {})
                if isinstance(workflow, dict):
                    nodes = workflow.get("nodes", [])
                    if isinstance(nodes, list):
                        uid = str(unique_id)
                        for n in nodes:
                            if isinstance(n, dict) and str(n.get("id")) == uid:
                                props = n.get("properties", {}) or {}
                                if _is_empty_lora_config(lora_data):
                                    lora_data = str(props.get("lora_data", ""))
                                if not str(ckpt_name or "").strip():
                                    ckpt_name = str(props.get("ckpt_name", ""))
                                if not str(device_preference or "").strip():
                                    device_preference = str(props.get("device_preference", DEFAULT_DEVICE_PREFERENCE))
                                if not str(model_source or "").strip() or (
                                    str(model_source or "") == DEFAULT_MODEL_SOURCE
                                    and str(props.get("model_source", "")) == "底模 checkpoint"
                                ):
                                    model_source = str(props.get("model_source", model_source))
                                break
        except Exception:
            if not str(lora_data or "").strip():
                lora_data = ""

        use_checkpoint_model = _is_checkpoint_model_source(model_source, ckpt_name)
        pairs = [
            pair
            for pair in collect_image_pairs(
                kwargs,
                prompt_graph=prompt_graph,
                unique_id=unique_id,
                batch_source_images=batch_source_images,
            )
            if pair["image"] is not None
        ]
        if not use_checkpoint_model and not test_config_data:
            original_unet_name = str(unet_name or "")
            unet_name = _switch_image_unet_for_input(
                unet_name,
                has_input_images=bool(pairs),
            )
            if unet_name != original_unet_name:
                _send_status(
                    unique_id,
                    f"{'检测到' if pairs else '未检测到'}输入图片，"
                    f"已自动切换 UNET：{unet_name}",
                )
        active_model_name = str(ckpt_name or "").strip() if use_checkpoint_model else str(unet_name or "").strip()
        krea2_style_lora_selected = _has_enabled_lora(
            KREA2_STYLE_REFERENCE_LORA_STEM,
            lora_data,
            lora_chain_config,
        )
        if (
            krea2_style_lora_selected
            and _is_krea2_family(unet_name)
        ):
            prompt_items = list(raw_prompt_items)
            prompt = prompt_items[0] if prompt_items else ""
            if global_prompt:
                print(
                    "[GJJ] LazyImageStudio Krea2 Style Reference 按源工作流 "
                    "不向 TextEncodeQwenImageEditPlus 前置全局提示词。"
                )

        lora_trigger_text = self._lora_trigger_text(lora_data, lora_chain_config)
        if lora_trigger_text:
            prompt_items = [
                append_lora_triggers_to_positive_prompt(item, lora_trigger_text)
                for item in (prompt_items or [""])
            ]
            prompt = prompt_items[0] if prompt_items else ""
            try:
                print(f"[GJJ] LazyImageStudio 已追加 LoRA 触发词：{lora_trigger_text}")
            except Exception:
                pass

        # 设置当前节点引用用于状态更新
        _send_status.current_node = self

        # 记录开始时间
        start_time = time.time()

        if test_config_data.get("mode") in {"unet", "lora", "lora_strength", "checkpoint", "sampler", "scheduler"}:
            mode = str(test_config_data.get("mode") or "")
            selected_models = [
                str(item or "").strip()
                for item in test_config_data.get("models", [])
                if str(item or "").strip()
            ]
            if mode == "lora_strength":
                lora_name = str(test_config_data.get("lora_name") or "").strip()
                if lora_name:
                    selected_models = [lora_name]
            test_entries: list[dict[str, Any]] = [{"model": name, "strength": None} for name in selected_models]
            if mode == "lora_strength" and selected_models:
                strength_values = _lora_strength_test_values(
                    test_config_data.get("strength_start", 0.2),
                    test_config_data.get("strength_end", 1.2),
                    test_config_data.get("strength_step", 0.2),
                )
                test_entries = [
                    {"model": selected_models[0], "strength": strength}
                    for strength in strength_values
                ]
            if test_entries:
                test_started = time.time()
                test_base_width = max(8, int(width))
                test_base_height = max(8, int(height))
                if use_input_image_size and pairs:
                    test_base_width, test_base_height = _largest_input_canvas_size(
                        pairs, test_base_width, test_base_height
                    )
                test_width, test_height = _lazy_resize_target_size(
                    test_base_width, test_base_height, image_resize_config
                )
                test_seed = int(seed)
                test_family_clip_name = str(clip_name1 or "")
                test_family_vae_name = str(vae_name or "")
                if mode != "checkpoint" and not use_checkpoint_model:
                    (
                        _test_family_preset,
                        test_family_clip_name,
                        test_family_vae_name,
                    ) = _resolve_lazy_test_model_pair(unet_name)
                _send_status(unique_id, f"模型测试开始：{len(test_entries)} 项")
                progress = comfy.utils.ProgressBar(len(test_entries))
                captioned_images: list[torch.Tensor] = []
                effective_params_list: list[dict[str, Any]] = []
                for index, test_entry in enumerate(test_entries, start=1):
                    model_name = str(test_entry.get("model") or "").strip()
                    item_strength = test_entry.get("strength")
                    item_started = time.time()
                    strength_text = f" @ {_format_test_strength(item_strength)}" if item_strength is not None else ""
                    _send_status(unique_id, f"测试 {index}/{len(test_entries)}：{model_name}{strength_text}")
                    try:
                        item_lora_data = lora_data
                        item_unet_name = unet_name
                        item_clip_name1 = test_family_clip_name
                        item_vae_name = test_family_vae_name
                        item_steps = steps
                        item_cfg = cfg
                        item_sampler_name = sampler_name
                        item_scheduler = scheduler
                        item_denoise = denoise
                        item_model_source = model_source
                        item_ckpt_name = ckpt_name
                        if mode == "unet":
                            item_unet_name = model_name
                            item_preset, item_clip_name1, item_vae_name = _resolve_lazy_test_model_pair(item_unet_name)
                            item_steps = int(item_preset.get("steps", steps) or steps)
                            item_cfg = float(item_preset.get("cfg", cfg) or cfg)
                            item_sampler_name = str(item_preset.get("sampler_name", sampler_name) or sampler_name)
                            item_scheduler = str(item_preset.get("scheduler", scheduler) or scheduler)
                            item_denoise = float(item_preset.get("denoise", denoise) or denoise)
                            _send_status(
                                unique_id,
                                f"测试 {index}/{len(test_entries)} 配套：CLIP={item_clip_name1 or '默认'}，VAE={item_vae_name or '默认'}",
                            )
                        elif mode == "checkpoint":
                            item_model_source = "底模 checkpoint"
                            item_ckpt_name = model_name
                        elif mode == "lora_strength":
                            strength = float(item_strength if item_strength is not None else 1.0)
                            item_lora_data = json.dumps(
                                [{"enabled": True, "name": model_name, "strength": strength}],
                                ensure_ascii=False,
                            )
                        elif mode == "sampler":
                            item_sampler_name = model_name
                        elif mode == "scheduler":
                            item_scheduler = model_name
                        else:
                            item_lora_data = json.dumps(
                                [{"enabled": True, "name": model_name, "strength": 1.0}],
                                ensure_ascii=False,
                            )
                        item_result = self.create_image(
                            prompt,
                            negative_prompt,
                            main_image_index,
                            width,
                            height,
                            batch_size,
                            item_unet_name,
                            unet_dtype,
                            item_clip_name1,
                            item_vae_name,
                            test_seed,
                            item_steps,
                            item_cfg,
                            item_sampler_name,
                            item_scheduler,
                            item_denoise,
                            grow_mask_by,
                            lora_chain_config=lora_chain_config,
                            lora_data=item_lora_data,
                            batch_source_images=batch_source_images,
                            mask=mask,
                            disable_reference_auto_mask=disable_reference_auto_mask,
                            force_empty_latent_reference=force_empty_latent_reference,
                            disable_equal_reference_canvas=disable_equal_reference_canvas,
                            keep_model_loaded=keep_model_loaded,
                            test_config="",
                            use_input_image_size=use_input_image_size,
                            model_source=item_model_source,
                            ckpt_name=item_ckpt_name,
                            device_preference=device_preference,
                            enable_sage_attention=enable_sage_attention,
                            sage_attention_mode=sage_attention_mode,
                            allow_sage_compile=allow_sage_compile,
                            enable_fp16_accumulation_setting=enable_fp16_accumulation_setting,
                            fp16_accumulation=fp16_accumulation,
                            missing_sage_attention_policy=missing_sage_attention_policy,
                            image_resize_config=image_resize_config_json,
                            prompt_graph=prompt_graph,
                            unique_id=unique_id,
                            extra_pnginfo=extra_pnginfo,
                            **kwargs,
                        )
                        item_image = item_result["result"][0]
                        item_elapsed = time.time() - item_started
                        model_size = "" if mode in {"sampler", "scheduler"} else _model_size_text("lora" if mode == "lora_strength" else mode, model_name)
                        if (
                            isinstance(item_image, torch.Tensor)
                            and item_image.ndim == 4
                            and (int(item_image.shape[2]) != test_width or int(item_image.shape[1]) != test_height)
                        ):
                            _send_status(
                                unique_id,
                                f"测试 {index}/{len(selected_models)} 尺寸校正："
                                f"{int(item_image.shape[2])}x{int(item_image.shape[1])} -> {test_width}x{test_height}",
                            )
                            item_image = _resize_test_image_to_target(item_image, test_width, test_height)
                        label = _test_caption_label("lora" if mode == "lora_strength" else mode, model_name, item_elapsed)
                        if mode == "lora_strength":
                            label = f"{_compact_model_name(model_name)} @ {_format_test_strength(item_strength)} ({model_size})[{max(0, int(round(float(item_elapsed or 0))))}秒]"
                        captioned = _caption_test_image(item_image, label)
                        captioned_images.append(captioned)
                        ui_params = item_result.get("ui", {}).get("effective_params", [{}])
                        effective_params = dict(ui_params[0] if ui_params else {})
                        effective_params.update(
                            {
                                "test_mode": mode,
                                "test_model": model_name,
                                "test_model_size": model_size,
                                "test_elapsed_time": item_elapsed,
                                "test_lora_strength": item_strength,
                            }
                        )
                        effective_params_list.append(effective_params)
                        preview_batch = torch.cat(_pad_images_to_common_size(captioned_images), dim=0)
                        _send_test_preview(unique_id, preview_batch)
                    except Exception as exc:
                        _send_status(unique_id, f"测试失败 {index}/{len(test_entries)}：{str(exc).splitlines()[0]}")
                        if mode in {"unet", "lora", "lora_strength", "checkpoint", "sampler", "scheduler"}:
                            error_image = _caption_test_image(
                                _make_soft_error_image(test_width, test_height),
                                (
                                    f"{_compact_model_name(model_name)} @ {_format_test_strength(item_strength)} "
                                    f"({_compact_model_size_text('lora', model_name)})[失败]"
                                    if mode == "lora_strength"
                                    else _test_caption_label(mode, model_name, failed=True)
                                ),
                            )
                            captioned_images.append(error_image)
                    finally:
                        try:
                            progress.update(1)
                        except Exception:
                            pass
                if not captioned_images:
                    raise RuntimeError("模型测试没有生成任何图片。")
                image = torch.cat(_pad_images_to_common_size(captioned_images), dim=0)
                elapsed_time = time.time() - test_started
                preview_images = gjjutils_write_temp_tensor_images(image)
                _send_status(unique_id, f"模型测试完成：{len(captioned_images)} 项  耗时：{elapsed_time:.1f}s")
                return {
                    "ui": {
                        "gjj_images": preview_images,
                        "images": _standard_queue_images(preview_images),
                        "elapsed_time": [elapsed_time],
                        "effective_params": effective_params_list or [{}],
                        "test_mode": [mode],
                    },
                    "result": (image,),
                }

        unet_name_is_linked = _is_prompt_input_linked(prompt_graph, unique_id, "unet_name")
        clip_name_is_linked = _is_prompt_input_linked(prompt_graph, unique_id, "clip_name1")
        vae_name_is_linked = _is_prompt_input_linked(prompt_graph, unique_id, "vae_name")
        soft_test_mode = bool(
            unet_name_is_linked
            or _is_model_effect_tester_input(prompt_graph, unique_id, "unet_name")
        )

        def soft_error_result(exc: Exception):
            first_line = str(exc).splitlines()[0] if str(exc).splitlines() else str(exc)
            _send_status(unique_id, f"测试跳过：{first_line}")
            _send_soft_test_error(unique_id, first_line)
            image = _make_soft_error_image(width, height)
            preview_images = gjjutils_write_temp_tensor_images(image)
            effective_params = {
                "prompt": prompt_items if len(prompt_items) > 1 else str(prompt or ""),
                "global_prompt": global_prompt,
                "negative_prompt": str(negative_prompt or ""),
                "main_image_index": int(main_image_index),
                "width": int(width),
                "height": int(height),
                "batch_size": int(batch_size),
                "unet_name": str(unet_name or ""),
                "unet_dtype": str(unet_dtype or ""),
                "clip_name1": str(clip_name1 or ""),
                "vae_name": str(vae_name or ""),
                "model_source": str(model_source or DEFAULT_MODEL_SOURCE),
                "ckpt_name": str(ckpt_name or ""),
                "device_preference": str(device_preference or DEFAULT_DEVICE_PREFERENCE),
                "seed": int(seed),
                "steps": int(steps),
                "cfg": float(cfg),
                "sampler_name": str(sampler_name or ""),
                "scheduler": str(scheduler or ""),
                "denoise": float(denoise),
                "grow_mask_by": int(grow_mask_by),
                "keep_model_loaded": bool(keep_model_loaded),
                "use_input_image_size": bool(use_input_image_size),
                "image_resize_config": image_resize_config,
                **optimization_params,
            }
            return {
                "ui": {
                    "gjj_lazy_soft_error": [{"message": first_line}],
                    "gjj_images": preview_images,
                    "images": _standard_queue_images(preview_images),
                    "effective_params": [effective_params],
                },
                "result": (image,),
            }

        try:
            _send_status(unique_id, "1/6 解析模型配套...")
            if use_checkpoint_model:
                if not active_model_name:
                    raise RuntimeError("未选择底模 checkpoint，请先在 🧠 模型设置里选择底模模型。")
                preset = match_model_family("")
            else:
                preset = match_model_family(unet_name)
                preset = _apply_f2k_fallback_preset(preset, unet_name)
                preset = _apply_zit_fallback_preset(preset, unet_name)
                preset = _apply_krea2_fallback_preset(preset, unet_name)
            clip_models = _list_lazy_clip_models() or [DEFAULT_LAZY_CLIP_NAME]
            vae_models = list_vae_models() or [DEFAULT_LAZY_VAE_NAME]
            # 确保 loras 目录存在并获取文件列表
            try:
                lora_files = folder_paths.get_filename_list("loras")
                lora_models = [str(f) for f in lora_files if str(f or "").strip()]
            except Exception:
                lora_models = []
            if use_checkpoint_model:
                resolved_clip_names = []
                resolved_vae_name = ""
                resolved_clip_type = "stable_diffusion"
            else:
                preset_driven_model = bool(unet_name_is_linked)
                exposed_clip_name = "" if preset_driven_model else clip_name1
                legacy_clip_names = [] if preset_driven_model else [clip_name1]
                selected_clip_name = (
                    ""
                    if preset_driven_model
                    else _pick_available_name(exposed_clip_name, clip_models, "")
                )
                preset_clip_names = preset.get("clip_names", [])
                is_flux_dual_clip = (
                    _normalize_text(preset.get("clip_type", "")) == "flux"
                    and bool(preset_clip_names)
                    and _canonical_model_text(preset_clip_names[0]) == "cliplsafetensors"
                )
                if is_flux_dual_clip:
                    # Flux 1 always needs CLIP-L + T5XXL. The exposed widget is the
                    # selectable T5 slot; old workflows may still contain clip_l.
                    selected_t5_name = (
                        ""
                        if _canonical_model_text(selected_clip_name) == "cliplsafetensors"
                        else selected_clip_name
                    )
                    resolved_clip_names = resolve_clip_names_for_preset(
                        preset,
                        clip_models,
                        exposed_clip_name=selected_t5_name,
                        legacy_clip_names=legacy_clip_names,
                    )
                elif selected_clip_name:
                    resolved_clip_names = [selected_clip_name]
                else:
                    resolved_clip_names = resolve_clip_names_for_preset(
                        preset,
                        clip_models,
                        exposed_clip_name=exposed_clip_name,
                        legacy_clip_names=legacy_clip_names,
                    )
                if not resolved_clip_names:
                    if preset_driven_model:
                        raise RuntimeError(
                            f"模型族 {preset.get('id', '(未识别)')} 未解析到合法 CLIP。"
                        )
                    resolved_clip_names.append(
                        _pick_available_name("", clip_models, DEFAULT_LAZY_CLIP_NAME)
                    )
            # 验证 CLIP 模型是否正确匹配 UNET 模型
            preset_clip_names = preset.get("clip_names", [])
            if (not use_checkpoint_model) and preset_clip_names and resolved_clip_names:
                if unet_name_is_linked:
                    for index, expression in enumerate(preset_clip_names):
                        _require_legal_preset_model(
                            str(preset.get("id", "")),
                            f"CLIP {index + 1}",
                            str(
                                resolved_clip_names[index]
                                if index < len(resolved_clip_names)
                                else ""
                            ),
                            str(expression),
                        )
                # 检查解析后的 CLIP 名称是否与预设中的推荐名称匹配
                for i, (resolved, recommended) in enumerate(
                    zip(resolved_clip_names, preset_clip_names)
                ):
                    if (
                        recommended
                        and not _model_matches_preset_expression(
                            resolved,
                            recommended,
                        )
                    ):
                        # 如果解析的名称与推荐的不一致，发出警告
                        print(f"[GJJ_LazyImageStudio] 警告: CLIP 模型不匹配！")
                        print(f"  UNET: {unet_name}")
                        print(f"  推荐的 CLIP: {recommended}")
                        print(f"  实际加载的 CLIP: {resolved}")
                        print(
                            f"  这可能导致维度不匹配错误。请确保 '{recommended}' 存在于 models/text_encoders 或 models/clip 目录中。"
                        )
            if not use_checkpoint_model:
                vae_fallback = "" if unet_name_is_linked else vae_name
                resolved_vae_name = _pick_available_name(
                    preset.get("vae_name", ""), vae_models, vae_fallback
                )
                if unet_name_is_linked:
                    _require_legal_preset_model(
                        str(preset.get("id", "")),
                        "VAE",
                        str(resolved_vae_name or ""),
                        str(preset.get("vae_name", "")),
                    )
                resolved_clip_type = resolve_clip_type(
                    unet_name,
                    resolved_clip_names,
                    str(preset.get("clip_type", "stable_diffusion")),
                )
            if _is_krea2_family(unet_name, resolved_clip_type, preset):
                resolved_clip_type = "krea2"
            is_flux2_runtime = _is_flux2_family(
                unet_name,
                str(resolved_clip_type or preset.get("clip_type", "")),
            )
            if is_flux2_runtime:
                resolved_clip_type = "flux2"
            is_ltx_runtime = _is_ltx_family(unet_name, resolved_clip_type, preset)
            is_flux1_krea_runtime = (
                str(preset.get("id", "")) == "flux1_krea_dev"
                and _normalize_text(resolved_clip_type) == "flux"
            )
            is_mage_flow_runtime = (
                not use_checkpoint_model
                and (
                    str(resolved_clip_type or "") in {"mage", "mage_flow"}
                    or is_mage_flow_name(unet_name)
                )
            )
            if is_mage_flow_runtime:
                mage_is_turbo = "turbo" in _canonical_model_text(unet_name)
                mage_steps = 4 if mage_is_turbo else 30
                mage_cfg = 1.0 if mage_is_turbo else 5.0
                if int(steps) != mage_steps or float(cfg) != mage_cfg:
                    print(
                        "[GJJ] LazyImageStudio 按 Mage-Flow 主模型联动采样参数："
                        f"steps {int(steps)} -> {mage_steps}，"
                        f"cfg {float(cfg):g} -> {mage_cfg:g}"
                    )
                steps = mage_steps
                cfg = mage_cfg
            input_shapes = [
                "x".join(str(int(size)) for size in pair["image"].shape)
                for pair in pairs
                if isinstance(pair.get("image"), torch.Tensor)
            ]
            print(
                f"[GJJ] LazyImageStudio 实际接收图片：{len(pairs)} 张"
                + (f"，张量尺寸 {', '.join(input_shapes)}" if input_shapes else "")
            )
            is_krea2_runtime = _is_krea2_family(
                unet_name,
                resolved_clip_type,
                preset,
            )
            is_krea2_style_reference = (
                is_krea2_runtime
                and krea2_style_lora_selected
            )
            if is_krea2_style_reference:
                width = 1024
                height = 1024
                steps = 8
                cfg = 1.0
                sampler_name = "euler"
                scheduler = "simple"
                denoise = 1.0
            krea2_edit_lora_strength = 1.0
            if is_krea2_runtime:
                krea2_edit_lora_strength = _configured_krea2_edit_lora_strength(
                    lora_data,
                    lora_chain_config,
                )
                lora_data = _without_krea2_edit_lora(lora_data)
                lora_chain_config = _without_krea2_edit_lora(lora_chain_config)
            if is_krea2_runtime and not pairs:
                _send_status(
                    unique_id,
                    "Krea2 未收到参考图：切换为文生图，并跳过身份编辑 LoRA。",
                )
            if use_input_image_size and pairs and not is_krea2_style_reference:
                input_width, input_height = _largest_input_canvas_size(
                    pairs, int(width), int(height)
                )
                if input_width != int(width) or input_height != int(height):
                    print(
                        "[GJJ] LazyImageStudio 使用最大输入图尺寸："
                        f"{int(width)}x{int(height)} -> {input_width}x{input_height}"
                    )
                width = input_width
                height = input_height
            width, height = _lazy_resize_target_size(
                int(width), int(height), image_resize_config
            )
            if pairs:
                original_shapes = [
                    f"{int(pair['image'].shape[2])}x{int(pair['image'].shape[1])}"
                    for pair in pairs
                    if isinstance(pair.get("image"), torch.Tensor)
                    and pair["image"].ndim >= 3
                ]
                pairs, mask = _align_lazy_image_pairs(
                    pairs,
                    mask,
                    int(main_image_index),
                    int(width),
                    int(height),
                    image_resize_config,
                )
                print(
                    "[GJJ] LazyImageStudio 输入图片统一尺寸："
                    f"{', '.join(original_shapes) or '未知'} -> {int(width)}x{int(height)}；"
                    f"模式={image_resize_config['mode']}，"
                    f"适配={image_resize_config['fit_mode']}，"
                    f"位置={image_resize_config['crop_position']}"
                )
            preset = dict(preset)
            preset["resolved_unet_name"] = str(unet_name or "")
            preset["resolved_ckpt_name"] = str(ckpt_name or "")
            preset["resolved_clip_type"] = str(resolved_clip_type or "")
            is_boogu_image_edit_turbo = False if use_checkpoint_model else _is_boogu_image_edit_turbo_family(preset, unet_name)

            normalized_lora_parts = [
                normalize_lora_chain_data(value)
                for value in (lora_data, lora_chain_config)
                if str(value or "").strip()
            ]
            runtime_key = _cache_digest(
                {
                    "unet_name": str(unet_name or ""),
                    "model_source": str(model_source or DEFAULT_MODEL_SOURCE),
                    "ckpt_name": str(ckpt_name or ""),
                    "unet_dtype": str(unet_dtype or ""),
                    "clip_names": [str(item or "") for item in resolved_clip_names],
                    "clip_type": str(resolved_clip_type or ""),
                    "vae_name": str(resolved_vae_name or ""),
                    "lora": normalized_lora_parts,
                    "model_sampling": str(preset.get("model_sampling", "")),
                    "model_shift": float(preset.get("model_shift", 0.0)),
                    "cfg_norm_strength": float(preset.get("cfg_norm_strength", 0.0)),
                    "device_preference": str(device_preference or DEFAULT_DEVICE_PREFERENCE),
                    "optimization": optimization_params,
                    "krea2_style_reference_workflow_version": (
                        KREA2_STYLE_REFERENCE_WORKFLOW_VERSION
                        if is_krea2_style_reference
                        else 0
                    ),
                }
            )
            effective_steps_for_cache = _resolve_effective_steps(int(steps), preset)
            result_key = _cache_digest(
                {
                    "runtime": runtime_key,
                    "prompt": prompt_items,
                    "negative_prompt": str(negative_prompt or ""),
                    "ltx_auto_negative_prompt": LTX_NAG_NEGATIVE_PROMPT if is_ltx_runtime else "",
                    "main_image_index": int(main_image_index),
                    "width": int(width),
                    "height": int(height),
                    "batch_size": int(batch_size),
                    "seed": int(seed),
                    "steps": int(steps),
                    "effective_steps": int(effective_steps_for_cache),
                    "cfg": float(cfg),
                    "sampler_name": str(sampler_name or ""),
                    "scheduler": str(scheduler or ""),
                    "denoise": float(denoise),
                    "grow_mask_by": int(grow_mask_by),
                    "disable_reference_auto_mask": _as_bool(disable_reference_auto_mask),
                    "force_empty_latent_reference": _as_bool(force_empty_latent_reference),
                    "use_input_image_size": bool(use_input_image_size),
                    "image_resize_config": image_resize_config,
                    "pairs": _pairs_signature(pairs),
                    "krea2_edit_lora_strength": float(krea2_edit_lora_strength),
                    "krea2_style_reference": bool(is_krea2_style_reference),
                    "krea2_style_reference_workflow_version": (
                        KREA2_STYLE_REFERENCE_WORKFLOW_VERSION
                        if is_krea2_style_reference
                        else 0
                    ),
                    "mask": _tensor_signature(mask) if mask is not None else "",
                    "device_preference": str(device_preference or DEFAULT_DEVICE_PREFERENCE),
                }
            )
            if keep_model_loaded:
                cached_result = self._cached_result(result_key)
                if cached_result is not None:
                    cached_runtime = self._cached_runtime(runtime_key)
                    if cached_runtime is not None:
                        cached_model, _cached_clip, _cached_vae = cached_runtime
                        _send_status(unique_id, "缓存命中：按实时显存恢复模型。")
                        _prepare_model_device(cached_model, device_preference)
                        self._pin_runtime_gpu(runtime_key, cached_model)
                    _send_status(unique_id, "缓存命中：参数未变化，直接返回上次结果。")
                    return {
                        "ui": {
                            "gjj_images": cached_result.get("preview_images", []),
                            "images": _standard_queue_images(cached_result.get("preview_images", [])),
                            "elapsed_time": [0.0],
                            "effective_params": [cached_result.get("effective_params", {})],
                            "cache_hit": [True],
                        },
                        "result": (cached_result["image"].clone(),),
                    }

            _send_status(unique_id, "2/6 加载主模型、CLIP 和 VAE...")
            cached_runtime = self._cached_runtime(runtime_key) if keep_model_loaded else None
            if cached_runtime is not None:
                model, clip, vae = cached_runtime
                _send_status(unique_id, "2/6 复用已保持的模型、CLIP 和 VAE...")
            else:
                if not keep_model_loaded:
                    self._release_instance_caches(runtime=True)
                model, clip, vae = self._load_runtime_pipeline(
                    unet_name,
                    unet_dtype,
                    resolved_clip_names,
                    resolved_clip_type,
                    resolved_vae_name,
                    str(model_source or DEFAULT_MODEL_SOURCE),
                    str(ckpt_name or ""),
                    unique_id=unique_id,
                )

                _send_status(unique_id, "3/6 应用 LoRA 与模型补丁...")
                if is_mage_flow_runtime:
                    if str(lora_data or "").strip() not in {"", "[]"} or str(
                        lora_chain_config or ""
                    ).strip() not in {"", "[]"}:
                        print("[GJJ_LazyImageStudio] Mage-Flow 内置分支暂不应用 LoRA 配置。")
                else:
                    model, clip = self._apply_loras(
                        model,
                        clip,
                        resolved_clip_type,
                        lora_chain_config,
                        lora_data,
                        use_checkpoint_model,
                    )
                if not is_boogu_image_edit_turbo:
                    model = _patch_model_sampling(
                        model,
                        str(preset.get("model_sampling", "")),
                        float(preset.get("model_shift", 0.0)),
                    )
                    model = _apply_cfg_norm(model, float(preset.get("cfg_norm_strength", 0.0)))
                if is_mage_flow_runtime:
                    print("[GJJ_LazyImageStudio] Mage-Flow 使用 BF16 原生计算，跳过通用 Sage/FP16 模型补丁。")
                else:
                    model, _ = GJJ_ModelPatchBundle().patch(
                        MODEL=model,
                        启用SageAttention=enable_sage_attention,
                        SageAttention模式=sage_attention_mode,
                        允许Sage编译=allow_sage_compile,
                        启用FP16累积设置=enable_fp16_accumulation_setting,
                        FP16累积=fp16_accumulation,
                        缺SageAttention处理=missing_sage_attention_policy,
                        unique_id=unique_id,
                    )
                if keep_model_loaded:
                    self._remember_runtime(runtime_key, model, clip, vae)

            _send_status(unique_id, "3/6 智能调度：按实时显存准备主模型...")
            _prepare_model_device(model, device_preference)

            prompt_count = len(prompt_items)
            supports_reference_edit = _supports_multi_reference_edit(
                preset, unet_name, resolved_clip_type
            )
            effective_steps = _resolve_effective_steps(int(steps), preset)

            def generate_one_prompt(prompt_text: str, prompt_index: int) -> tuple[torch.Tensor, int, int]:
                status_suffix = f"（{prompt_index + 1}/{prompt_count}）" if prompt_count > 1 else ""
                local_width = int(width)
                local_height = int(height)
                task_pairs = _clone_image_pairs_for_task(pairs)
                if is_krea2_runtime and _is_empty_scene_prompt(prompt_text):
                    task_pairs = []
                    _send_status(
                        unique_id,
                        f"Krea2 空镜{status_suffix}：忽略人物参考图，使用纯文生图。",
                    )
                task_mask = (
                    mask.detach().clone().contiguous()
                    if isinstance(mask, torch.Tensor)
                    else mask
                )
                flux2_sample_size = None
                krea2_reference_sample = False
                krea2_style_reference_sample = False
                krea2_patched_model = None
                boogu_turbo_sample = False
                effective_negative_prompt = (
                    _ltx_negative_prompt_text(negative_prompt)
                    if is_ltx_runtime
                    else str(negative_prompt or "")
                )

                _send_status(unique_id, f"4/6 编码条件与 latent{status_suffix}...")
                if is_mage_flow_runtime:
                    local_width = max(16, (local_width // 16) * 16)
                    local_height = max(16, (local_height // 16) * 16)
                    ordered_pairs = _reorder_pairs_by_main_index(
                        task_pairs, int(main_image_index)
                    )
                    reference_images = [
                        pair["image"]
                        for pair in ordered_pairs[:3]
                        if isinstance(pair.get("image"), torch.Tensor)
                    ]
                    if task_mask is not None:
                        print("[GJJ_LazyImageStudio] Mage-Flow 分支暂不使用遮罩输入。")
                    _send_status(
                        unique_id,
                        (
                            f"4/6 Mage-Flow Edit 内置编码{status_suffix}"
                            f"（{len(reference_images)} 张参考图）..."
                            if reference_images
                            else f"4/6 Mage-Flow 文生图内置编码{status_suffix}..."
                        ),
                    )
                    positive = encode_mage_flow_conditioning(
                        clip,
                        vae,
                        prompt_text,
                        reference_images,
                        local_width,
                        local_height,
                    )
                    negative = encode_mage_flow_conditioning(
                        clip,
                        vae,
                        effective_negative_prompt or " ",
                        reference_images,
                        local_width,
                        local_height,
                    )
                    latent_out = make_mage_flow_empty_latent(
                        local_width,
                        local_height,
                        int(batch_size),
                    )
                elif is_boogu_image_edit_turbo:
                    if not task_pairs:
                        raise RuntimeError("Boogu Image Edit Turbo 工作流需要至少连接一张参考图。")
                    _send_status(
                        unique_id,
                        f"4/6 按 Boogu Image Edit Turbo 工作流编码{status_suffix}（参考图直连编码器，按目标尺寸创建空 latent）...",
                    )
                    positive, negative, latent_out, boogu_width, boogu_height = (
                        self._encode_boogu_image_edit_turbo_workflow(
                            clip=clip,
                            vae=vae,
                            prompt=prompt_text,
                            negative_prompt=effective_negative_prompt,
                            pairs=task_pairs,
                            batch_size=int(batch_size),
                            target_width=local_width,
                            target_height=local_height,
                        )
                    )
                    local_width = int(boogu_width)
                    local_height = int(boogu_height)
                    boogu_turbo_sample = True
                elif task_pairs and is_krea2_style_reference:
                    ordered_krea2_pairs = _reorder_pairs_by_main_index(
                        task_pairs, int(main_image_index)
                    )
                    _send_status(
                        unique_id,
                        f"4/6 按 Krea2 Style Reference 工作流编码{status_suffix}"
                        f"（image1-image{min(len(ordered_krea2_pairs), QWEN_IMAGE_EDIT_MAX_PLUS_IMAGES)}，"
                        "最多三张参考图）...",
                    )
                    positive, negative, latent_out = (
                        self._encode_krea2_style_reference(
                            clip=clip,
                            vae=vae,
                            prompt=prompt_text,
                            pairs=ordered_krea2_pairs,
                            width=local_width,
                            height=local_height,
                            batch_size=int(batch_size),
                        )
                    )
                    krea2_style_reference_sample = True
                elif task_pairs and _is_krea2_family(unet_name, resolved_clip_type, preset):
                    ordered_krea2_pairs = _reorder_pairs_by_main_index(
                        task_pairs, int(main_image_index)
                    )
                    _send_status(
                        unique_id,
                        f"4/6 按 Krea2 Identity Edit 工作流编码{status_suffix}"
                        f"（{min(len(ordered_krea2_pairs), 2)} 张参考图）...",
                    )
                    (
                        krea2_patched_model,
                        positive,
                        negative,
                        latent_out,
                    ) = self._encode_krea2_image_edit(
                        model=model,
                        clip=clip,
                        vae=vae,
                        prompt=prompt_text,
                        negative_prompt=effective_negative_prompt,
                        pairs=ordered_krea2_pairs,
                        width=local_width,
                        height=local_height,
                        batch_size=int(batch_size),
                        identity_lora_strength=float(krea2_edit_lora_strength),
                    )
                    krea2_reference_sample = True
                elif task_pairs and resolved_clip_type == "flux2":
                    _send_status(
                        unique_id,
                        f"4/6 编码 Flux2 图片编辑条件{status_suffix}（{len(task_pairs)} 张）...",
                    )
                    positive, negative, latent_out, flux2_width, flux2_height = (
                        self._encode_flux2_multi_reference(
                            clip=clip,
                            vae=vae,
                            prompt=prompt_text,
                            negative_prompt=effective_negative_prompt,
                            main_image_index=main_image_index,
                            pairs=task_pairs,
                            width=local_width,
                            height=local_height,
                            batch_size=int(batch_size),
                            preset=preset,
                        )
                    )
                    flux2_sample_size = (int(flux2_width), int(flux2_height))
                elif (
                    task_pairs
                    and task_mask is None
                    and supports_reference_edit
                    and (
                        _uses_equal_reference_canvas(preset, unet_name)
                        or _as_bool(force_empty_latent_reference)
                        or (len(task_pairs) > 1 and _is_qwen_image_edit_family(preset, unet_name))
                    )
                ):
                    _send_status(
                        unique_id,
                        f"4/6 编码平等参考条件{status_suffix}（{len(task_pairs)} 张，按设置尺寸创建空 latent）...",
                    )
                    positive, negative, latent_out, equal_width, equal_height = (
                        self._encode_equal_reference_image_edit(
                            clip=clip,
                            vae=vae,
                            prompt=prompt_text,
                            negative_prompt=effective_negative_prompt,
                            pairs=task_pairs,
                            vl_long_edge=int(preset.get("vl_long_edge", 512)),
                            target_width=local_width,
                            target_height=local_height,
                            batch_size=int(batch_size),
                        )
                    )
                    local_width = int(equal_width)
                    local_height = int(equal_height)
                elif task_pairs and supports_reference_edit:
                    positive, negative, latent_out = self._encode_multi_image_edit(
                        clip=clip,
                        vae=vae,
                        prompt=prompt_text,
                        negative_prompt=effective_negative_prompt,
                        main_image_index=main_image_index,
                        pairs=task_pairs,
                        main_mask=task_mask,
                        main_long_edge=int(preset.get("main_long_edge", 1024)),
                        vl_long_edge=int(preset.get("vl_long_edge", 512)),
                        target_width=local_width,
                        target_height=local_height,
                        disable_auto_noise_mask=bool(disable_reference_auto_mask),
                    )
                else:
                    positive = self._encode_text_conditioning(clip, prompt_text)
                    negative = self._encode_negative_conditioning(
                        clip, positive, effective_negative_prompt
                    )
                    latent_out = self._build_latent(
                        vae=vae,
                        width=local_width,
                        height=local_height,
                        batch_size=batch_size,
                        image_pairs=task_pairs,
                        mask=task_mask,
                        grow_mask_by=grow_mask_by,
                        preset=preset,
                        disable_auto_mask=bool(disable_reference_auto_mask),
                    )

                _send_status(unique_id, f"5/6 采样生成图像{status_suffix}...")
                if is_flux1_krea_runtime:
                    positive = node_helpers.conditioning_set_values(
                        positive,
                        {"guidance": 3.5},
                    )
                positive = _limit_conditioning_batch(positive, int(batch_size))
                negative = _limit_conditioning_batch(negative, int(batch_size))
                sample_model = (
                    krea2_patched_model
                    if krea2_patched_model is not None
                    else model
                )
                if is_flux1_krea_runtime:
                    sample_model = _patch_flux_model_sampling(
                        sample_model,
                        local_width,
                        local_height,
                        max_shift=1.15,
                        base_shift=0.5,
                    )
                elif krea2_style_reference_sample:
                    from comfy_extras.nodes_model_advanced import ModelSamplingFlux

                    sample_model = ModelSamplingFlux().patch(
                        sample_model,
                        max_shift=1.15,
                        base_shift=0.5,
                        width=int(local_width),
                        height=int(local_height),
                    )[0]
                if is_ltx_runtime:
                    _send_status(unique_id, f"5/6 应用 LTX NAG 引导{status_suffix}...")
                    nag_conditioning = self._encode_text_conditioning(
                        clip,
                        effective_negative_prompt,
                    )
                    sample_model = self._apply_ltx_nag_model(
                        model,
                        nag_conditioning,
                        enabled=True,
                    )
                sample_seed = int(seed) + prompt_index if prompt_count > 1 else int(seed)
                _send_status(unique_id, f"5/6 智能调度：确认采样模型驻留状态{status_suffix}...")
                _prepare_model_device(sample_model, device_preference)
                if boogu_turbo_sample:
                    _send_status(
                        unique_id,
                        f"5/6 按 Boogu Image Edit Turbo 工作流采样{status_suffix}（AuraFlow Sigmas，SamplerCustom）...",
                    )
                    sampled_latent = self._sample_boogu_image_edit_turbo_workflow(
                        model=sample_model,
                        positive=positive,
                        negative=negative,
                        latent_out=latent_out,
                        seed=sample_seed,
                        steps=int(preset.get("steps", effective_steps) or effective_steps),
                        cfg=float(preset.get("cfg", cfg) or cfg),
                        sampler_name=str(preset.get("sampler_name", "dpmpp_2m") or "dpmpp_2m"),
                        scheduler=str(preset.get("scheduler", "simple") or "simple"),
                        denoise=float(preset.get("denoise", denoise) or denoise),
                        model_sampling=str(preset.get("model_sampling", "aura") or "aura"),
                        model_shift=float(preset.get("model_shift", 3.16) or 3.16),
                    )
                elif flux2_sample_size is not None:
                    flux2_width, flux2_height = flux2_sample_size
                    _send_status(
                        unique_id,
                        f"5/6 按 Flux2 工作流采样{status_suffix}（{flux2_width} x {flux2_height}，heun）...",
                    )
                    sampled_latent = self._sample_flux2_reference_workflow(
                        model=sample_model,
                        positive=positive,
                        negative=negative,
                        latent_out=latent_out,
                        width=flux2_width,
                        height=flux2_height,
                        steps=effective_steps,
                        seed=sample_seed,
                        cfg=float(cfg),
                        sampler_name="heun",
                    )
                elif krea2_style_reference_sample:
                    _send_status(
                        unique_id,
                        f"5/6 按 Krea2 Style Reference 工作流采样{status_suffix}"
                        "（原生 SamplerCustomAdvanced，CFG=1）...",
                    )
                    sampled_latent = self._sample_krea2_style_reference_workflow(
                        model=sample_model,
                        positive=positive,
                        negative=negative,
                        latent_out=latent_out,
                        seed=sample_seed,
                    )
                elif krea2_reference_sample:
                    _send_status(
                        unique_id,
                        f"5/6 按 Krea2 图生图工作流采样{status_suffix}（BasicGuider 等价，CFG=1）...",
                    )
                    sampled_latent = common_ksampler(
                        sample_model,
                        sample_seed,
                        effective_steps,
                        1.0,
                        sampler_name,
                        scheduler,
                        positive,
                        negative,
                        latent_out,
                        denoise=float(denoise),
                    )[0]
                elif is_mage_flow_runtime:
                    with mage_flow_safe_bf16_accumulation():
                        sampled_latent = common_ksampler(
                            sample_model,
                            sample_seed,
                            effective_steps,
                            float(cfg),
                            "euler",
                            "simple",
                            positive,
                            negative,
                            latent_out,
                            denoise=1.0,
                        )[0]
                else:
                    sampled_latent = common_ksampler(
                        sample_model,
                        sample_seed,
                        effective_steps,
                        float(cfg),
                        sampler_name,
                        scheduler,
                        positive,
                        negative,
                        latent_out,
                        denoise=float(denoise),
                    )[0]

                _send_status(unique_id, f"6/6 解码输出图像{status_suffix}...")
                sampled_latent = _limit_latent_batch(sampled_latent, int(batch_size))
                _prepare_vae_device(vae, device_preference)
                output_image = VAEDecode().decode(vae, sampled_latent)[0]
                return output_image, local_width, local_height

            generated_images: list[torch.Tensor] = []
            final_width = int(width)
            final_height = int(height)
            for prompt_index, prompt_text in enumerate(prompt_items):
                try:
                    generated_image, final_width, final_height = generate_one_prompt(prompt_text, prompt_index)
                except Exception as exc:
                    if _is_memory_allocation_error(exc):
                        raise
                    first_line = str(exc).splitlines()[0] if str(exc).splitlines() else str(exc)
                    _send_status(
                        unique_id,
                        f"第 {prompt_index + 1}/{len(prompt_items)} 张生成失败，已输出错误占位图：{first_line}",
                    )
                    error_text = f"第 {prompt_index + 1}/{len(prompt_items)} 张\n{first_line}"
                    generated_image = _make_soft_error_image(final_width, final_height, error_text)
                    repeat_count = max(1, int(batch_size))
                    if repeat_count > 1:
                        generated_image = generated_image.repeat(repeat_count, 1, 1, 1)
                generated_images.append(generated_image)
                _send_test_preview(
                    unique_id,
                    generated_image,
                    append=prompt_index > 0,
                    prompt_index=prompt_index,
                    prompt_count=len(prompt_items),
                )
                if len(prompt_items) > 1:
                    _send_status(
                        unique_id,
                        f"第 {prompt_index + 1}/{len(prompt_items)} 张已完成并显示预览",
                    )
            image = torch.cat(generated_images, dim=0) if len(generated_images) > 1 else generated_images[0]
            width = int(final_width)
            height = int(final_height)

            # 计算耗时
            end_time = time.time()
            elapsed_time = end_time - start_time
            elapsed_str = f"{elapsed_time:.1f}s"

            # 更新状态，显示尺寸和耗时
            _send_status(unique_id, f"完成：{image.shape[2]} x {image.shape[1]}  耗时：{elapsed_str}")

            # gjj_images 给节点内自定义预览；images 给 ComfyUI 任务队列/历史缩略图。
            preview_images = gjjutils_write_temp_tensor_images(image)

            effective_params = {
                "prompt": prompt_items if len(prompt_items) > 1 else str(prompt or ""),
                "prompt_batch_count": len(prompt_items),
                "global_prompt": global_prompt,
                "negative_prompt": str(negative_prompt or ""),
                "main_image_index": int(main_image_index),
                "width": int(width),
                "height": int(height),
                "batch_size": int(batch_size),
                "output_batch_size": int(image.shape[0]) if isinstance(image, torch.Tensor) and image.ndim >= 1 else int(batch_size),
                "unet_name": str(unet_name or ""),
                "unet_dtype": str(unet_dtype or ""),
                "clip_name1": str(resolved_clip_names[0] if resolved_clip_names else clip_name1 or ""),
                "vae_name": str(resolved_vae_name or vae_name or ""),
                "model_source": str(model_source or DEFAULT_MODEL_SOURCE),
                "ckpt_name": str(ckpt_name or ""),
                "device_preference": str(device_preference or DEFAULT_DEVICE_PREFERENCE),
                "seed": int(seed),
                "steps": int(steps),
                "cfg": float(cfg),
                "sampler_name": str(sampler_name or ""),
                "scheduler": str(scheduler or ""),
                "denoise": float(denoise),
                "grow_mask_by": int(grow_mask_by),
                "keep_model_loaded": bool(keep_model_loaded),
                "use_input_image_size": bool(use_input_image_size),
                "image_resize_config": image_resize_config,
                **optimization_params,
            }

            # 准备返回值（在清理资源之前）
            result_data = {
                "ui": {
                    "gjj_images": preview_images,
                    "images": _standard_queue_images(preview_images),
                    "elapsed_time": [elapsed_time],
                    "effective_params": [effective_params],
                },
                "result": (image,),
            }

            if keep_model_loaded:
                _send_status(unique_id, f"完成：保持模型，显存继续智能调度  耗时：{elapsed_str}")
                _prepare_model_device(model, device_preference)
                self._pin_runtime_gpu(runtime_key, model)
                self._kept_runtime = (model, clip, vae)
                self._remember_result_cache(result_key, image, preview_images, effective_params)
                del image, generated_images
            else:
                self._kept_runtime = None
                # 及时清理 GPU/CPU 缓存，释放显存供下次调用
                del model, clip, vae, image, generated_images
                _clear_torch_and_comfy_cache()

            # 返回 UI 数据，包含图片和耗时
            return result_data
        except RuntimeError as exc:
            first_line = str(exc).splitlines()[0]
            if soft_test_mode:
                return soft_error_result(exc)
            if _is_memory_allocation_error(exc):
                self._release_instance_caches(runtime=True, loras=True, results=True)
                formatted = _format_memory_allocation_error(
                    exc,
                    unet_name=str(unet_name or ""),
                    width=width,
                    height=height,
                    batch_size=batch_size,
                )
                first_line = str(formatted).splitlines()[0]
                _send_status(unique_id, f"执行失败：{first_line}")
                raise formatted from exc
            _send_status(unique_id, f"执行失败：{first_line}")
            raise
        except Exception as exc:
            if soft_test_mode:
                return soft_error_result(exc)
            if _is_memory_allocation_error(exc):
                self._release_instance_caches(runtime=True, loras=True, results=True)
                formatted = _format_memory_allocation_error(
                    exc,
                    unet_name=str(unet_name or ""),
                    width=width,
                    height=height,
                    batch_size=batch_size,
                )
                _send_status(unique_id, str(formatted).splitlines()[0])
                raise formatted from exc
            _send_status(unique_id, "执行失败")
            raise RuntimeError(
                f"懒人图文集成一键生图执行失败。\n"
                f"UNET：{unet_name}\n"
                f"详细错误：{exc}"
            ) from exc


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LazyImageStudio}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🖼️ 懒人图文集成一键生图"}

# 注册 API 端点用于动态获取 LoRA 列表
try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/gjj/lora_list")
    async def get_lora_list_api(request):
        try:
            lora_files = folder_paths.get_filename_list("loras")
            lora_list = [str(f) for f in lora_files if str(f or "").strip()]
            return web.json_response({"loras": lora_list})
        except Exception as e:
            return web.json_response({"loras": [], "error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/gjj/lazy-image-studio/test-models")
    async def get_lazy_image_studio_test_models_api(request):
        try:
            kind = str(request.query.get("kind", "unet") or "unet").lower()
            if kind == "lora":
                names = [str(f) for f in folder_paths.get_filename_list("loras") if str(f or "").strip()]
            elif kind == "checkpoint":
                names = [str(f) for f in folder_paths.get_filename_list("checkpoints") if str(f or "").strip()]
            else:
                raw_models = _list_lazy_unet_models() or [DEFAULT_UNET_NAME]
                keywords = ["flux", "f2k", "krea", "krea2", "zimage", "z_image", "z-image", "zit", "qwen", "firered", "boogu", "anima", "mage-flow", "mage_flow", "mageflow", "gguf"]
                filtered = [m for m in raw_models if any(k in str(m).lower() for k in keywords)]
                names = filtered if filtered else raw_models
                kind = "unet"
            models = []
            for name in names:
                path = _model_full_path(kind, name)
                size = 0
                if path:
                    try:
                        size = os.path.getsize(path)
                    except Exception:
                        size = 0
                models.append({"name": name, "bytes": size, "size": _format_bytes(size)})
            return web.json_response({"kind": kind, "models": models})
        except Exception as e:
            return web.json_response({"kind": "unet", "models": [], "error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/gjj/lazy-image-studio/clear-cache")
    async def clear_lazy_image_studio_cache_api(request):
        try:
            for instance in list(GJJ_LazyImageStudio._instances):
                instance._kept_runtime = None
                instance._lora_cache.clear()
            GJJ_LazyImageStudio._clear_shared_caches(runtime=True, results=True)
            _clear_torch_and_comfy_cache()
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

except Exception:
    pass
