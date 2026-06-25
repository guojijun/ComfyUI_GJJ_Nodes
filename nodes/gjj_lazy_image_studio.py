from __future__ import annotations

import json
import hashlib
import math
import os
import time
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
from nodes import (
    EmptyLatentImage,
    VAEDecode,
    VAEEncode,
    VAEEncodeForInpaint,
    common_ksampler,
    PreviewImage,
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
from .gjj_model_bundle_loader import (
    UNET_DTYPE_OPTIONS,
    _build_unet_model_options,
    _resolve_full_path,
    list_clip_models,
    list_unet_models,
    list_vae_models,
)
from .common_utils.model_manager import gjjutils_find_model_list
from .common_utils.model_family import (
    gjjutils_model_family_match_preset as match_model_family,
    gjjutils_model_family_resolve_clip_type as resolve_clip_type,
    gjjutils_model_family_resolve_clip_names as resolve_clip_names_for_preset,
    gjjutils_model_family_pick_lora_name as _pick_available_lora_name,
    gjjutils_model_family_pick_model_name as _pick_available_name,
    MODEL_FAMILY_PRESETS,
    CLIP_TYPE_KEYWORDS,
    DEFAULT_CLIP_NAME,
    DEFAULT_VAE_NAME,
)
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE
from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .gjj_multi_lora_chain import apply_lora_chain_config, normalize_lora_chain_data
from .gjj_multi_image_loader import (
    load_image_tensor,
    parse_selected_images,
    resolve_input_image_path,
)

try:
    from .gjj_wanvideo_runtime_shims import ensure_optional_gguf_module
except Exception:  # pragma: no cover - 单文件语法检查兜底
    def ensure_optional_gguf_module():
        import importlib

        return importlib.import_module("gguf")

NODE_NAME = "GJJ_LazyImageStudio"
MAX_MAIN_IMAGE_INDEX = 9999
DEFAULT_UNET_NAME = "flux-2-klein-9b-nvfp4.safetensors"
DEFAULT_UNET_DTYPE = "default"
DEFAULT_LIGHTNING_LORA = ""
DEFAULT_NSFW_LORA = ""
REFERENCE_IMAGE_MEGAPIXELS = 1.0
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
    return _dedupe_keep_order(_safe_filename_list("unet_gguf") + list_unet_models())


def _list_lazy_clip_models() -> list[str]:
    _ensure_gguf_model_folders()
    return _dedupe_keep_order(_safe_filename_list("clip_gguf") + list_clip_models())


def _preferred_default(values: list[str], preferred: str) -> str:
    preferred = str(preferred or "").strip()
    if preferred and preferred in values:
        return preferred
    return values[0] if values else preferred


def _clip_type_enum(name: str):
    normalized = _normalize_text(name)
    enum_name = str(name or "").upper()
    clip_type = getattr(comfy.sd.CLIPType, enum_name, None)
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


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    return text in {"true", "1", "yes", "on", "启用", "开启"}


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


def _make_soft_error_image(width: Any, height: Any) -> torch.Tensor:
    w = max(64, min(2048, int(float(width or 512))))
    h = max(64, min(2048, int(float(height or 512))))
    image = torch.zeros((1, h, w, 3), dtype=torch.float32)
    image[..., 0] = 0.24
    image[..., 1] = 0.04
    image[..., 2] = 0.06
    band_h = max(4, min(32, h // 20))
    image[:, :band_h, :, 0] = 0.95
    image[:, :band_h, :, 1] = 0.12
    image[:, :band_h, :, 2] = 0.18
    return image


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
    primary_value = kwargs.get("image_01")
    primary_images = [
        image
        for image in _split_image_batch(primary_value)
        if isinstance(image, torch.Tensor) and image.ndim in (3, 4)
    ]
    recovered_primary_images: list[torch.Tensor] = []
    if not primary_images:
        recovered_primary_images = _recover_serialized_image_entries(
            batch_source_images
        ) or _recover_multi_image_loader_primary_batch(prompt_graph, unique_id)
    pairs: list[dict[str, Any]] = []
    source_images = primary_images or recovered_primary_images
    for batch_index, image in enumerate(source_images):
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


def _load_model(unet_name: str, unet_dtype: str):
    if _is_gguf_model(unet_name):
        return _load_model_gguf(unet_name)
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
        model = comfy.sd.load_diffusion_model(
            unet_path, model_options=_build_unet_model_options(unet_dtype)
        )
        print(f"[DEBUG] Successfully loaded UNET model: {unet_name}")
        # 彩色打印 UNET 信息
        print(f"\033[95m🟣 UNET: {unet_name}\033[0m")
        return model
    except Exception as exc:
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
        if normalized_type == "hidream":
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
    return (
        "qwenimageedit2511" in text
        or "fireredimageedit11" in text
        or "fireredimageedit1.1" in _normalize_text(str(unet_name or ""))
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


class GJJ_LazyImageStudio:
    CATEGORY = "GJJ/Image"
    FUNCTION = "create_image"
    DESCRIPTION = "懒人图文集成一键生图：支持文生图、图生图，以及多图参考编辑。节点会根据所选 UNET 主关键词自动推荐匹配的文本编码器、VAE、加速 LoRA、NSFW LoRA 与常用采样参数。"
    GJJ_HELP = {
        "description": DESCRIPTION,
        "model_tree": True,
        "dynamic_model_tree_only": True,
        "model_download_url": "https://pan.quark.cn/s/6ec846f1f58d",
        "notice": (
            "模型树会按当前面板选择动态生成：UNET、CLIP、VAE 来自对应模型目录；"
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
    _shared_result_cache: dict[str, dict[str, Any]] = {}
    _shared_result_order: list[str] = []
    _MAX_RESULT_CACHE = 8

    def __init__(self):
        self._lora_cache: dict[str, Any] = {}
        self._kept_runtime: tuple[Any, Any, Any] | None = None
        self.preview_image = PreviewImage()

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
    def INPUT_TYPES(cls):
        _raw_diffusion_models = _list_lazy_unet_models() or [DEFAULT_UNET_NAME]
        _diffusion_keywords = ["flux", "f2k", "zimage", "z_image", "z-image", "zit", "qwen", "firered", "boogu", "gguf"]
        _filtered = [
            m
            for m in _raw_diffusion_models
            if any(k in str(m).lower() for k in _diffusion_keywords)
        ]
        diffusion_models = _filtered if _filtered else _raw_diffusion_models
        clip_models = _list_lazy_clip_models() or [DEFAULT_CLIP_NAME]
        vae_models = list_vae_models() or [DEFAULT_VAE_NAME]
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
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "🚫 反向提示词",
                        "tooltip": "反向提示词；为空时会自动生成零反向条件。",
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
                        "tooltip": "默认会在接入批量图片时，从所有图片里不分先后取最大图自动同步宽度；如果你手动修改，节点会按目标尺寸自动缩放或外扩填充。",
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
                        "tooltip": "默认会在接入批量图片时，从所有图片里不分先后取最大图自动同步高度；如果你手动修改，节点会按目标尺寸自动缩放或外扩填充。",
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
                        "default": _preferred_default(clip_models, DEFAULT_CLIP_NAME),
                        "display_name": "🟡 CLIP 编码器",
                        "tooltip": "仅在需要手动选择可变文本编码器的模型族中显示，例如 Flux1 的 T5 编码器；支持 text_encoders / clip_gguf 中的 safetensors 与 GGUF。",
                    },
                ),
                "vae_name": (
                    vae_models,
                    {
                        "default": _preferred_default(vae_models, DEFAULT_VAE_NAME),
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
            current_model, current_clip, _ = apply_lora_chain_config(
                current_model,
                current_clip,
                lora_data=final_lora_data,
                loaded_lora_cache=None,
            )
        return current_model, current_clip

    def _encode_text_conditioning(self, clip, text: str):
        tokens = clip.tokenize(str(text or ""))
        return clip.encode_from_tokens_scheduled(tokens)

    def _encode_negative_conditioning(self, clip, positive, negative_prompt: str):
        if str(negative_prompt or "").strip():
            return self._encode_text_conditioning(clip, negative_prompt)
        return zero_out_conditioning(positive)

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
        MAX_REFERENCE_IMAGES = 3
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
            image_prompt += f"Picture {slot + 1}: {QWEN_IMAGE_EDIT_IMAGE_TOKEN}"

            # 及时清理不需要的中间变量以释放显存
            del prepared_image, vl_image

        if not ref_latents:
            raise RuntimeError("平等参考模式至少需要一张有效参考图。")
        full_prompt = image_prompt + str(prompt or "")
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
        resolved_width = max(16, int(width))
        resolved_height = max(16, int(height))
        reference_latents: list[torch.Tensor] = []
        reference_sizes: list[str] = []
        reference_short_edge = min(resolved_width, resolved_height)
        for pair in ordered_pairs:
            image = pair["image"]
            # 所有参考图统一按输出画布短边等比缩放。
            # 不裁切、不拉伸、不补边，也不再把辅助图压缩到较小像素预算。
            scaled_image = _scale_image_to_short_edge(
                image,
                short_edge=reference_short_edge,
                resolution_steps=FLUX2_REFERENCE_RESOLUTION_STEPS,
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
            negative = node_helpers.conditioning_set_values(
                negative, {"reference_latents": reference_latents}, append=True
            )
        latent_out = EmptyFlux2LatentImage(
            int(resolved_width), int(resolved_height), int(batch_size)
        )
        print(
            "[GJJ] Flux2/F2K 多图参考："
            f"主图+参考图 {len(reference_latents)} 张，"
            f"编码尺寸 {', '.join(reference_sizes)}，"
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
    ):
        model = _load_model(unet_name, unet_dtype)
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
        keep_model_loaded=False,
        prompt_graph=None,
        unique_id=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        prompt = _unwrap_list_input(prompt)
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
        keep_model_loaded = _unwrap_list_input(keep_model_loaded)
        prompt_graph = _unwrap_list_input(prompt_graph)
        unique_id = _unwrap_list_input(unique_id)
        extra_pnginfo = _unwrap_list_input(extra_pnginfo)
        keep_model_loaded = _as_bool(keep_model_loaded)

        # 兼容旧工作流：如果隐藏输入未提交，再从 workflow properties 读取。
        if not str(lora_data or "").strip():
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
                                    lora_data = str(props.get("lora_data", ""))
                                    break
            except Exception:
                lora_data = ""

        # 设置当前节点引用用于状态更新
        _send_status.current_node = self

        # 记录开始时间
        start_time = time.time()
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
            effective_params = {
                "prompt": str(prompt or ""),
                "negative_prompt": str(negative_prompt or ""),
                "main_image_index": int(main_image_index),
                "width": int(width),
                "height": int(height),
                "batch_size": int(batch_size),
                "unet_name": str(unet_name or ""),
                "unet_dtype": str(unet_dtype or ""),
                "clip_name1": str(clip_name1 or ""),
                "vae_name": str(vae_name or ""),
                "seed": int(seed),
                "steps": int(steps),
                "cfg": float(cfg),
                "sampler_name": str(sampler_name or ""),
                "scheduler": str(scheduler or ""),
                "denoise": float(denoise),
                "grow_mask_by": int(grow_mask_by),
                "keep_model_loaded": bool(keep_model_loaded),
            }
            return {
                "ui": {
                    "gjj_lazy_soft_error": [{"message": first_line}],
                    "effective_params": [effective_params],
                },
                "result": (image,),
            }

        try:
            _send_status(unique_id, "1/6 解析模型配套...")
            preset = match_model_family(unet_name)
            preset = _apply_f2k_fallback_preset(preset, unet_name)
            preset = _apply_zit_fallback_preset(preset, unet_name)
            clip_models = _list_lazy_clip_models() or [DEFAULT_CLIP_NAME]
            vae_models = list_vae_models() or [DEFAULT_VAE_NAME]
            # 确保 loras 目录存在并获取文件列表
            try:
                lora_files = folder_paths.get_filename_list("loras")
                lora_models = [str(f) for f in lora_files if str(f or "").strip()]
            except Exception:
                lora_models = []
            preset_driven_model = bool(unet_name_is_linked and not clip_name_is_linked)
            exposed_clip_name = "" if preset_driven_model else clip_name1
            legacy_clip_names = [] if preset_driven_model else [clip_name1]
            resolved_clip_names = resolve_clip_names_for_preset(
                preset,
                clip_models,
                exposed_clip_name=exposed_clip_name,
                legacy_clip_names=legacy_clip_names,
            )
            if not resolved_clip_names:
                resolved_clip_names.append(
                    _pick_available_name("", clip_models, DEFAULT_CLIP_NAME)
                )

            # 验证 CLIP 模型是否正确匹配 UNET 模型
            preset_clip_names = preset.get("clip_names", [])
            if preset_clip_names and resolved_clip_names:
                # 检查解析后的 CLIP 名称是否与预设中的推荐名称匹配
                for i, (resolved, recommended) in enumerate(
                    zip(resolved_clip_names, preset_clip_names)
                ):
                    if resolved != recommended and recommended:
                        # 如果解析的名称与推荐的不一致，发出警告
                        print(f"[GJJ_LazyImageStudio] 警告: CLIP 模型不匹配！")
                        print(f"  UNET: {unet_name}")
                        print(f"  推荐的 CLIP: {recommended}")
                        print(f"  实际加载的 CLIP: {resolved}")
                        print(
                            f"  这可能导致维度不匹配错误。请确保 '{recommended}' 存在于 models/text_encoders 或 models/clip 目录中。"
                        )
            vae_fallback = (
                DEFAULT_VAE_NAME
                if unet_name_is_linked and not vae_name_is_linked
                else vae_name
            )
            resolved_vae_name = _pick_available_name(
                preset.get("vae_name", DEFAULT_VAE_NAME), vae_models, vae_fallback
            )
            resolved_clip_type = resolve_clip_type(
                unet_name,
                resolved_clip_names,
                str(preset.get("clip_type", "stable_diffusion")),
            )
            is_flux2_runtime = _is_flux2_family(
                unet_name,
                str(resolved_clip_type or preset.get("clip_type", "")),
            )
            if is_flux2_runtime:
                resolved_clip_type = "flux2"
            preset = dict(preset)
            preset["resolved_unet_name"] = str(unet_name or "")
            preset["resolved_clip_type"] = str(resolved_clip_type or "")
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
            input_shapes = [
                "x".join(str(int(size)) for size in pair["image"].shape)
                for pair in pairs
                if isinstance(pair.get("image"), torch.Tensor)
            ]
            print(
                f"[GJJ] LazyImageStudio 实际接收图片：{len(pairs)} 张"
                + (f"，张量尺寸 {', '.join(input_shapes)}" if input_shapes else "")
            )

            normalized_lora_parts = [
                normalize_lora_chain_data(value)
                for value in (lora_data, lora_chain_config)
                if str(value or "").strip()
            ]
            runtime_key = _cache_digest(
                {
                    "unet_name": str(unet_name or ""),
                    "unet_dtype": str(unet_dtype or ""),
                    "clip_names": [str(item or "") for item in resolved_clip_names],
                    "clip_type": str(resolved_clip_type or ""),
                    "vae_name": str(resolved_vae_name or ""),
                    "lora": normalized_lora_parts,
                    "model_sampling": str(preset.get("model_sampling", "")),
                    "model_shift": float(preset.get("model_shift", 0.0)),
                    "cfg_norm_strength": float(preset.get("cfg_norm_strength", 0.0)),
                }
            )
            effective_steps_for_cache = _resolve_effective_steps(int(steps), preset)
            result_key = _cache_digest(
                {
                    "runtime": runtime_key,
                    "prompt": str(prompt or ""),
                    "negative_prompt": str(negative_prompt or ""),
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
                    "pairs": _pairs_signature(pairs),
                    "mask": _tensor_signature(mask) if mask is not None else "",
                }
            )
            if keep_model_loaded:
                cached_result = self._cached_result(result_key)
                if cached_result is not None:
                    _send_status(unique_id, "缓存命中：参数未变化，直接返回上次结果。")
                    return {
                        "ui": {
                            "gjj_images": cached_result.get("preview_images", []),
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
                model, clip, vae = self._load_runtime_pipeline(
                    unet_name,
                    unet_dtype,
                    resolved_clip_names,
                    resolved_clip_type,
                    resolved_vae_name,
                )

                _send_status(unique_id, "3/6 应用 LoRA 与模型补丁...")
                model, clip = self._apply_loras(
                    model,
                    clip,
                    resolved_clip_type,
                    lora_chain_config,
                    lora_data,
                )
                model = _patch_model_sampling(
                    model,
                    str(preset.get("model_sampling", "")),
                    float(preset.get("model_shift", 0.0)),
                )
                model = _apply_cfg_norm(model, float(preset.get("cfg_norm_strength", 0.0)))
                if keep_model_loaded:
                    self._remember_runtime(runtime_key, model, clip, vae)

            _send_status(unique_id, "4/6 编码条件与 latent...")
            flux2_sample_size = None
            supports_reference_edit = _supports_multi_reference_edit(
                preset, unet_name, resolved_clip_type
            )
            if pairs and resolved_clip_type == "flux2":
                _send_status(
                    unique_id, f"4/6 编码 Flux2 图片编辑条件（{len(pairs)} 张）..."
                )
                positive, negative, latent_out, flux2_width, flux2_height = (
                    self._encode_flux2_multi_reference(
                        clip=clip,
                        vae=vae,
                        prompt=prompt,
                        negative_prompt=negative_prompt,
                        main_image_index=main_image_index,
                        pairs=pairs,
                        width=int(width),
                        height=int(height),
                        batch_size=int(batch_size),
                        preset=preset,
                    )
                )
                flux2_sample_size = (int(flux2_width), int(flux2_height))
            elif (
                pairs
                and mask is None
                and supports_reference_edit
                and (
                    _uses_equal_reference_canvas(preset, unet_name)
                    or (len(pairs) > 1 and _is_qwen_image_edit_family(preset, unet_name))
                )
            ):
                _send_status(
                    unique_id,
                    f"4/6 编码平等参考条件（{len(pairs)} 张，按设置尺寸创建空 latent）...",
                )
                positive, negative, latent_out, equal_width, equal_height = (
                    self._encode_equal_reference_image_edit(
                        clip=clip,
                        vae=vae,
                        prompt=prompt,
                        negative_prompt=negative_prompt,
                        pairs=pairs,
                        vl_long_edge=int(preset.get("vl_long_edge", 512)),
                        target_width=int(width),
                        target_height=int(height),
                        batch_size=int(batch_size),
                    )
                )
                width = int(equal_width)
                height = int(equal_height)
            elif pairs and supports_reference_edit:
                positive, negative, latent_out = self._encode_multi_image_edit(
                    clip=clip,
                    vae=vae,
                    prompt=prompt,
                    negative_prompt=negative_prompt,
                    main_image_index=main_image_index,
                    pairs=pairs,
                    main_mask=mask,
                    main_long_edge=int(preset.get("main_long_edge", 1024)),
                    vl_long_edge=int(preset.get("vl_long_edge", 512)),
                    target_width=int(width),
                    target_height=int(height),
                    disable_auto_noise_mask=bool(disable_reference_auto_mask),
                )
            else:
                positive = self._encode_text_conditioning(clip, prompt)
                negative = self._encode_negative_conditioning(
                    clip, positive, negative_prompt
                )
                latent_out = self._build_latent(
                    vae=vae,
                    width=width,
                    height=height,
                    batch_size=batch_size,
                    image_pairs=pairs,
                    mask=mask,
                    grow_mask_by=grow_mask_by,
                    preset=preset,
                    disable_auto_mask=bool(disable_reference_auto_mask),
                )

            _send_status(unique_id, "5/6 采样生成图像...")
            positive = _limit_conditioning_batch(positive, int(batch_size))
            negative = _limit_conditioning_batch(negative, int(batch_size))
            effective_steps = _resolve_effective_steps(
                int(steps),
                preset,
            )
            if flux2_sample_size is not None:
                flux2_width, flux2_height = flux2_sample_size
                _send_status(
                    unique_id,
                    f"5/6 按 Flux2 工作流采样（{flux2_width} x {flux2_height}）...",
                )
                sampled_latent = self._sample_flux2_reference_workflow(
                    model=model,
                    positive=positive,
                    negative=negative,
                    latent_out=latent_out,
                    width=flux2_width,
                    height=flux2_height,
                    steps=effective_steps,
                    seed=int(seed),
                    cfg=float(cfg),
                    sampler_name=str(preset.get("sampler_name", "lcm") or "lcm"),
                )
            else:
                sampled_latent = common_ksampler(
                    model,
                    int(seed),
                    effective_steps,
                    float(cfg),
                    sampler_name,
                    scheduler,
                    positive,
                    negative,
                    latent_out,
                    denoise=float(denoise),
                )[0]

            _send_status(unique_id, "6/6 解码输出图像...")
            sampled_latent = _limit_latent_batch(sampled_latent, int(batch_size))
            image = VAEDecode().decode(vae, sampled_latent)[0]

            # 计算耗时
            end_time = time.time()
            elapsed_time = end_time - start_time
            elapsed_str = f"{elapsed_time:.1f}s"

            # 更新状态，显示尺寸和耗时
            _send_status(unique_id, f"完成：{image.shape[2]} x {image.shape[1]}  耗时：{elapsed_str}")

            # 保存预览图片给 GJJ 自定义前端预览；避免使用 ui.images 触发 ComfyUI 原生重复预览。
            preview_ui = self.preview_image.save_images(
                image,
                filename_prefix="GJJ_LazyImageStudio",
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            preview_images = preview_ui.get("ui", {}).get("images", [])

            effective_params = {
                "prompt": str(prompt or ""),
                "negative_prompt": str(negative_prompt or ""),
                "main_image_index": int(main_image_index),
                "width": int(width),
                "height": int(height),
                "batch_size": int(batch_size),
                "unet_name": str(unet_name or ""),
                "unet_dtype": str(unet_dtype or ""),
                "clip_name1": str(resolved_clip_names[0] if resolved_clip_names else clip_name1 or ""),
                "vae_name": str(resolved_vae_name or vae_name or ""),
                "seed": int(seed),
                "steps": int(steps),
                "cfg": float(cfg),
                "sampler_name": str(sampler_name or ""),
                "scheduler": str(scheduler or ""),
                "denoise": float(denoise),
                "grow_mask_by": int(grow_mask_by),
                "keep_model_loaded": bool(keep_model_loaded),
            }

            # 准备返回值（在清理资源之前）
            result_data = {
                "ui": {
                    "gjj_images": preview_images,
                    "elapsed_time": [elapsed_time],
                    "effective_params": [effective_params],
                },
                "result": (image,),
            }

            if keep_model_loaded:
                self._kept_runtime = (model, clip, vae)
                self._remember_result_cache(result_key, image, preview_images, effective_params)
                del positive, negative, sampled_latent, image
                _send_status(unique_id, f"完成：模型保持中  耗时：{elapsed_str}")
            else:
                self._kept_runtime = None
                # 及时清理 GPU/CPU 缓存，释放显存供下次调用
                del model, clip, vae, positive, negative, sampled_latent, image
                import gc
                gc.collect()
                if hasattr(torch.cuda, 'empty_cache'):
                    torch.cuda.empty_cache()

            # 返回 UI 数据，包含图片和耗时
            return result_data
        except RuntimeError as exc:
            first_line = str(exc).splitlines()[0]
            if soft_test_mode:
                return soft_error_result(exc)
            _send_status(unique_id, f"执行失败：{first_line}")
            raise
        except Exception as exc:
            if soft_test_mode:
                return soft_error_result(exc)
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

except Exception:
    pass
