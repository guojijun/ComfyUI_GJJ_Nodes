from __future__ import annotations

import math
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

NODE_NAME = "GJJ_LazyImageStudio"
MAX_MAIN_IMAGE_INDEX = 9999
DEFAULT_UNET_NAME = "flux-2-klein-9b-nvfp4.safetensors"
DEFAULT_UNET_DTYPE = "default"
DEFAULT_LIGHTNING_LORA = ""
DEFAULT_NSFW_LORA = ""
REFERENCE_IMAGE_MEGAPIXELS = 1.0
REFERENCE_IMAGE_RESOLUTION_STEPS = 1
IMAGE_RATIO_EPSILON = 0.015


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


def _preferred_default(values: list[str], preferred: str) -> str:
    preferred = str(preferred or "").strip()
    if preferred and preferred in values:
        return preferred
    return values[0] if values else preferred


def _clip_type_enum(name: str):
    return getattr(
        comfy.sd.CLIPType, str(name or "").upper(), comfy.sd.CLIPType.STABLE_DIFFUSION
    )


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


def _resolve_prompt_node(prompt_graph: Any, node_id: Any) -> dict[str, Any] | None:
    if not isinstance(prompt_graph, dict):
        return None
    text_id = str(node_id or "").strip()
    if text_id and isinstance(prompt_graph.get(text_id), dict):
        return prompt_graph[text_id]
    if node_id in prompt_graph and isinstance(prompt_graph[node_id], dict):
        return prompt_graph[node_id]
    return None


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
    recovered_primary_images = _recover_serialized_image_entries(
        batch_source_images
    ) or _recover_multi_image_loader_primary_batch(prompt_graph, unique_id)
    has_secondary_images = any(
        input_index(name, "image_") > 1 and value is not None
        for name, value in sorted_dynamic_items(kwargs, "image_")
    )
    skip_primary_batch = has_secondary_images and (
        bool(recovered_primary_images)
        or (
            isinstance(primary_value, torch.Tensor)
            and getattr(primary_value, "ndim", 0) == 4
            and int(primary_value.shape[0]) > 1
        )
    )
    pairs: list[dict[str, Any]] = []
    for name, value in sorted_dynamic_items(kwargs, "image_"):
        input_slot = input_index(name, "image_")
        if input_slot >= 999999 or value is None:
            continue
        if skip_primary_batch and input_slot == 1:
            continue
        if input_slot == 1 and recovered_primary_images:
            source_images = recovered_primary_images
        else:
            source_images = _split_image_batch(value)
        for batch_index, image in enumerate(source_images):
            pairs.append(
                {
                    "slot_index": len(pairs),
                    "source_input_index": input_slot - 1,
                    "source_batch_index": batch_index,
                    "image": image,
                }
            )
    return pairs


def zero_out_conditioning(conditioning):
    result = []
    for item in conditioning:
        payload = item[1].copy()
        pooled_output = payload.get("pooled_output")
        if pooled_output is not None:
            payload["pooled_output"] = torch.zeros_like(pooled_output)
        conditioning_lyrics = payload.get("conditioning_lyrics")
        if conditioning_lyrics is not None:
            payload["conditioning_lyrics"] = torch.zeros_like(conditioning_lyrics)
        result.append([torch.zeros_like(item[0]), payload])
    return result


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
    return normalized in {"qwen_image"}


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
                    return vae
                except Exception:
                    pass
            raise RuntimeError(
                "当前 ComfyUI 核心无法加载 full_encoder_small_decoder.safetensors，且可回退的 Flux2 VAE 也不可用。"
                "请升级 ComfyUI，或改用 flux2-vae.safetensors / Flux2-DEV-ae.safetensors。"
            ) from exc
        raise _format_runtime_error("VAE 加载", exc) from exc


def _load_model(unet_name: str, unet_dtype: str):
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
        return model
    except Exception as exc:
        raise _format_runtime_error("UNET 加载", exc) from exc


def _load_clip_from_names(clip_names: list[str], clip_type: str):
    clean_names = [
        str(name or "").strip() for name in clip_names if str(name or "").strip()
    ]
    if not clean_names:
        raise RuntimeError("至少需要一个文本编码器模型。")
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
    samples = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(
        samples, int(target_width), int(target_height), upscale, "disabled"
    )
    return resized.movedim(1, -1)


def _resize_mask_exact(
    mask: torch.Tensor | None,
    target_width: int,
    target_height: int,
    upscale: str = "bilinear",
) -> torch.Tensor | None:
    mask_bhw = _ensure_mask_bhw(mask)
    if mask_bhw is None:
        return None
    mask_image = mask_bhw.unsqueeze(1)
    resized = comfy.utils.common_upscale(
        mask_image, int(target_width), int(target_height), upscale, "disabled"
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
    scale = min(
        float(target_width) / float(max(1, source_width)),
        float(target_height) / float(max(1, source_height)),
    )
    resized_width = max(8, int(round(source_width * scale)))
    resized_height = max(8, int(round(source_height * scale)))
    resized_width = min(int(target_width), resized_width)
    resized_height = min(int(target_height), resized_height)
    resized = _resize_image_exact(image, resized_width, resized_height, upscale)
    left = max(0, (int(target_width) - resized_width) // 2)
    top = max(0, (int(target_height) - resized_height) // 2)
    right = max(0, int(target_width) - resized_width - left)
    bottom = max(0, int(target_height) - resized_height - top)
    padded = F.pad(
        resized.movedim(-1, 1), (left, right, top, bottom), mode="replicate"
    ).movedim(1, -1)
    mask = torch.ones(
        (image.shape[0], int(target_height), int(target_width)),
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
    width = max(8, int(fallback_width))
    height = max(8, int(fallback_height))
    for pair in pairs or []:
        image = pair.get("image") if isinstance(pair, dict) else None
        if not isinstance(image, torch.Tensor) or image.ndim < 3:
            continue
        width = max(width, int(image.shape[2]))
        height = max(height, int(image.shape[1]))
    return _ceil_to_multiple(width, 8), _ceil_to_multiple(height, 8)


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
    if _same_aspect_ratio(source_width, source_height, target_width, target_height):
        return (
            _resize_image_exact(image, target_width, target_height, "lanczos"),
            _resize_mask_exact(mask, target_width, target_height),
            False,
        )
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
    SEARCH_ALIASES = [
        "懒人",
        "一键生图",
        "图文集成",
        "图文生成",
        "图生图",
        "文生图",
        "flux",
        "hidream",
        "omnigen2",
        "采样器",
    ]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("最终生成图像",)
    OUTPUT_NODE = True  # 设为True以确保节点可以作为有效输出节点
    OUTPUT_TOOLTIPS = ("节点内部完成条件编码、采样和解码后的最终图片。",)

    def __init__(self):
        self._lora_cache: dict[str, Any] = {}
        self.preview_image = PreviewImage()

    @classmethod
    def INPUT_TYPES(cls):
        _raw_diffusion_models = list_unet_models() or [DEFAULT_UNET_NAME]
        _diffusion_keywords = ["flux", "zimage", "z_image", "qwen", "firered"]
        _filtered = [
            m
            for m in _raw_diffusion_models
            if any(k in str(m).lower() for k in _diffusion_keywords)
        ]
        diffusion_models = _filtered if _filtered else _raw_diffusion_models
        clip_models = list_clip_models() or [DEFAULT_CLIP_NAME]
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
                        "display_name": "正向提示词",
                        "tooltip": "正向提示词；无图片输入时走文生图，有图片输入时走图生图或多图编辑。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "反向提示词",
                        "tooltip": "反向提示词；为空时会自动生成零反向条件。",
                    },
                ),
                "main_image_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": MAX_MAIN_IMAGE_INDEX,
                        "display_name": "主图序号",
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
                        "display_name": "宽度",
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
                        "display_name": "高度",
                        "tooltip": "默认会在接入批量图片时，从所有图片里不分先后取最大图自动同步高度；如果你手动修改，节点会按目标尺寸自动缩放或外扩填充。",
                    },
                ),
                "batch_size": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 64,
                        "display_name": "批次数",
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
                        "tooltip": "主扩散模型；前端会根据模型关键词自动推荐匹配的编码器、VAE、LoRA 与采样参数。",
                    },
                ),
                "unet_dtype": (
                    UNET_DTYPE_OPTIONS,
                    {
                        "default": DEFAULT_UNET_DTYPE,
                        "display_name": "UNET 精度",
                        "tooltip": "UNET 加载精度；Flux2 工作流默认使用模型原生精度。",
                    },
                ),
                "clip_name1": (
                    clip_models,
                    {
                        "default": _preferred_default(clip_models, DEFAULT_CLIP_NAME),
                        "display_name": "🟡 CLIP 编码器",
                        "tooltip": "仅在需要手动选择可变文本编码器的模型族中显示，例如 Flux1 的 T5 编码器；固定配套模型会在节点内部自动匹配。",
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
                        "display_name": "种子",
                        "tooltip": "随机种子。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 4,
                        "min": 1,
                        "max": 10000,
                        "display_name": "步数",
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
                        "display_name": "CFG 引导强度",
                        "tooltip": "提示词引导强度；大多数新模型建议较低值。",
                    },
                ),
                "sampler_name": (
                    comfy.samplers.KSampler.SAMPLERS,
                    {
                        "default": "euler",
                        "display_name": "采样器",
                        "tooltip": "采样算法。",
                    },
                ),
                "scheduler": (
                    comfy.samplers.KSampler.SCHEDULERS,
                    {
                        "default": "simple",
                        "display_name": "调度器",
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
                        "display_name": "降噪",
                        "tooltip": "文生图通常为 1.0；图生图可适当降低保留原图结构。",
                    },
                ),
                "grow_mask_by": (
                    "INT",
                    {
                        "default": 6,
                        "min": 0,
                        "max": 64,
                        "display_name": "遮罩扩张",
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
                            "display_name": "批量图片来源",
                            "tooltip": "前端自动同步的批量图片来源清单；正常使用时会自动隐藏。",
                        },
                    ),
                    "image_01": (
                        "GJJ_BATCH_IMAGE,IMAGE",
                        {
                            "display_name": "批量图片",
                            "tooltip": "可直接接入 GJJ · 多图片加载预览器 的批量图片输出；会按顺序拆成多张参考图参与工作流，并在所有图片里不分先后取最大图自动同步尺寸。",
                        },
                    ),
                    "mask": (
                        "MASK",
                        {
                            "display_name": "主图遮罩",
                            "tooltip": "可选主图遮罩；存在时会走带 noise_mask 的局部编辑逻辑。",
                        },
                    ),
                    "lora_chain_config": (
                        "LORA_CHAIN_CONFIG",
                        {
                            "display_name": "LoRA串联配置",
                            "tooltip": "可选接入 LoRA串联配置 节点的输出；接入后会在面板 LoRA 1/LoRA 2 之后继续按顺序串联应用多组 LoRA。",
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
        # 优先使用 lora_data，如果没有则使用 lora_chain_config
        final_lora_data = (
            lora_data if str(lora_data or "").strip() else lora_chain_config
        )
        if str(final_lora_data or "").strip():
            current_model, current_clip, _ = apply_lora_chain_config(
                current_model,
                current_clip,
                lora_data=normalize_lora_chain_data(final_lora_data),
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
        return result["output"]

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
            image_prompt += f"Picture {slot + 1}: "

            # 及时清理不需要的中间变量以释放显存
            del prepared_image, vl_image

        if not ref_latents:
            raise RuntimeError("平等参考模式至少需要一张有效参考图。")
        full_prompt = image_prompt + str(prompt or "")
        tokens = clip.tokenize(full_prompt, images=vl_images)
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        positive = node_helpers.conditioning_set_values(
            conditioning, {"reference_latents": ref_latents}, append=True
        )
        negative = self._encode_negative_conditioning(clip, positive, negative_prompt)
        latent_out = {"samples": torch.zeros_like(ref_latents[0])}

        # 清理VL图像列表以释放显存
        del vl_images

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
                noise_mask = prepared_mask
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
            image_prompt += f"Picture {slot + 1}: "

            # 及时清理不需要的中间变量
            del vl_image

        if main_ref_latent is None:
            raise RuntimeError("主图参考 latent 生成失败，请检查主图输入是否有效。")
        full_prompt = image_prompt + str(prompt or "")
        tokens = clip.tokenize(full_prompt, images=vl_images)
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
        self, vae, width, height, batch_size, image_pairs, mask, grow_mask_by, preset
    ):
        # 检查是否为Flux2模型（32通道）
        is_flux2_model = False
        clip_type = preset.get("clip_type", "stable_diffusion")
        unet_name = preset.get("unet_name", "")

        # 通过UNET名称判断是否为Flux2模型
        normalized_unet = _normalize_text(unet_name)
        if "flux2" in normalized_unet:
            is_flux2_model = True

        # 或者通过clip_type判断
        if _normalize_text(clip_type) == "flux2":
            is_flux2_model = True

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
        if prepared_mask is not None and (use_outpaint or mask is not None):
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
        for ordered_index, pair in enumerate(ordered_pairs):
            scaled_image = _scale_image_to_total_pixels(pair["image"])
            if ordered_index == 0:
                resolved_width = max(16, int(scaled_image.shape[2]))
                resolved_height = max(16, int(scaled_image.shape[1]))
            reference_latent = VAEEncode().encode(vae, scaled_image)[0]["samples"]
            positive = node_helpers.conditioning_set_values(
                positive, {"reference_latents": [reference_latent]}, append=True
            )
            negative = node_helpers.conditioning_set_values(
                negative, {"reference_latents": [reference_latent]}, append=True
            )
        latent_out = EmptyFlux2LatentImage(
            int(resolved_width), int(resolved_height), int(batch_size)
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
        batch_source_images="[]",
        mask=None,
        prompt_graph=None,
        unique_id=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        # 从 properties 读取 lora_data（通过 extra_pnginfo + unique_id）
        lora_data = ""
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

        try:
            _send_status(unique_id, "1/6 解析模型配套...")
            preset = match_model_family(unet_name)
            clip_models = list_clip_models() or [DEFAULT_CLIP_NAME]
            vae_models = list_vae_models() or [DEFAULT_VAE_NAME]
            # 确保 loras 目录存在并获取文件列表
            try:
                lora_files = folder_paths.get_filename_list("loras")
                lora_models = [str(f) for f in lora_files if str(f or "").strip()]
            except Exception:
                lora_models = []
            resolved_clip_names = resolve_clip_names_for_preset(
                preset,
                clip_models,
                exposed_clip_name=clip_name1,
                legacy_clip_names=[clip_name1],
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
            resolved_vae_name = _pick_available_name(
                preset.get("vae_name", DEFAULT_VAE_NAME), vae_models, vae_name
            )
            resolved_clip_type = resolve_clip_type(
                unet_name,
                resolved_clip_names,
                str(preset.get("clip_type", "stable_diffusion")),
            )
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

            _send_status(unique_id, "2/6 加载主模型、CLIP 和 VAE...")
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

            _send_status(unique_id, "4/6 编码条件与 latent...")
            flux2_sample_size = None
            if len(pairs) > 1 and resolved_clip_type == "flux2" and mask is None:
                _send_status(
                    unique_id, f"4/6 编码 Flux2 多参考条件（{len(pairs)} 张）..."
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
                and bool(preset.get("supports_multi_image_edit"))
                and _uses_equal_reference_canvas(preset, unet_name)
            ):
                _send_status(
                    unique_id,
                    f"4/6 编码平等参考条件（{len(pairs)} 张，按最大图尺寸）...",
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
                    )
                )
                width = int(equal_width)
                height = int(equal_height)
            elif pairs and bool(preset.get("supports_multi_image_edit")):
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
                )

            _send_status(unique_id, "5/6 采样生成图像...")
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
            image = VAEDecode().decode(vae, sampled_latent)[0]

            # 计算耗时
            end_time = time.time()
            elapsed_time = end_time - start_time
            elapsed_str = f"{elapsed_time:.1f}s"

            # 更新状态，显示尺寸和耗时
            _send_status(unique_id, f"完成：{image.shape[2]} x {image.shape[1]} ⏰ 耗时：{elapsed_str}")

            # 保存预览图片并返回 UI 数据
            preview_ui = self.preview_image.save_images(
                image,
                filename_prefix="GJJ_LazyImageStudio",
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            preview_images = preview_ui.get("ui", {}).get("images", [])

            # 返回 UI 数据，包含图片和耗时
            return {"ui": {"images": preview_images, "elapsed_time": [elapsed_time]}, "result": (image,)}
        except RuntimeError as exc:
            _send_status(unique_id, f"执行失败：{str(exc).splitlines()[0]}")
            raise
        except Exception as exc:
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
