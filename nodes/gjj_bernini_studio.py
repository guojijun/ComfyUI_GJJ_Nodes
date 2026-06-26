from __future__ import annotations

import random
import time
from typing import Any

import folder_paths
import torch

from .common_utils.temp_files import gjjutils_write_temp_tensor_images
from .gjj_bernini import (
    FRAME_QUEUE_REQUIREMENT,
    _as_bhwc_tensor,
    _build_bernini_context,
    _conditioning_set_values,
    _has_value,
    REF_PREFIX,
)
from .gjj_clip_prompt_encode_panel import GJJ_CLIPPromptEncodePanel
from .gjj_image_batch_multi import GJJ_ImageBatchMulti
from .gjj_model_patch_bundle import GJJ_ModelPatchBundle
from .gjj_video_combine import GJJ_VideoCombine
from .gjj_video_universal_model_loader import GJJ_VideoUniversalModelLoader
from .gjj_wanvideo_decode import GJJ_WanVideoDecode
from .common_utils.dependency_checker import build_node_help_payload, make_missing_model_spec
from .common_utils.model_manager import gjjutils_find_model_list


NODE_NAME = "GJJ_BerniniStudio"


class AnyMediaType(str):
    def __ne__(self, _other: object) -> bool:
        return False


MIXED_IMAGE_TYPE = AnyMediaType("GJJ_BATCH_IMAGE,IMAGE,VIDEO")
MAX_REFERENCE_IMAGES = 2

DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant."

MODE_SYSTEM_PROMPTS = {
    "T2I": "You are a helpful assistant specialized in text-to-image generation.",
    "T2V": "You are a helpful assistant specialized in text-to-video generation.",
    "I2I": "You are a helpful assistant specialized in image editing.",
    "R2I": "You are a helpful assistant specialized in subject-to-image generation.",
    "I2V": "You are a helpful assistant specialized in image-to-video generation.",
    "V2V": "You are a helpful assistant specialized in video editing.",
    "R2V": "You are a helpful assistant specialized in subject-to-video generation.",
    "VI2V": "You are a helpful assistant specialized in video editing on content propagation.",
    "RV2V": "You are a helpful assistant specialized in video editing with reference.",
    "ADS2V": "You are a helpful assistant specialized in ads insertion.",
    "VRC2V": "You are a helpful assistant for editing. You may need to adjust the subject's action or position.",
    "MV2V": "You are a helpful assistant for editing. You might need to adjust the video's style, lighting, colors, textures, and the subject's pose or action.",
}

MODE_CHOICES = ["auto"] + list(MODE_SYSTEM_PROMPTS.keys())
DEFAULT_PROMPT = "Remove subtitles and watermarks while preserving the original scene, motion, lighting, and identity."
DEFAULT_NEGATIVE = "bad video"
DEFAULT_HIGH_MODEL = "wan2.2_bernini_r_high_noise_fp8_scaled.safetensors"
DEFAULT_LOW_MODEL = "wan2.2_bernini_r_low_noise_fp8_scaled.safetensors"
DEFAULT_VAE = "wan_2.1_vae.safetensors"
DEFAULT_CLIP = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
DEFAULT_HIGH_LORA = "wan\\wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors"
DEFAULT_LOW_LORA = "wan\\wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors"

MODEL_TREE = [
    {
        "label": "Bernini High diffusion model",
        "path": "models/diffusion_models",
        "folder": "diffusion_models",
        "filename": DEFAULT_HIGH_MODEL,
        "value": DEFAULT_HIGH_MODEL,
        "kind": "diffusion",
        "required": True,
        "description": "High 阶段模型；下拉只显示文件名同时匹配 bernini + high 的 diffusion_models 文件。",
    },
    {
        "label": "Bernini Low diffusion model",
        "path": "models/diffusion_models",
        "folder": "diffusion_models",
        "filename": DEFAULT_LOW_MODEL,
        "value": DEFAULT_LOW_MODEL,
        "kind": "diffusion",
        "required": True,
        "description": "Low 阶段模型；下拉只显示文件名同时匹配 bernini + low 的 diffusion_models 文件。",
    },
    {
        "label": "Wan VAE",
        "path": "models/vae",
        "folder": "vae",
        "filename": DEFAULT_VAE,
        "value": DEFAULT_VAE,
        "kind": "vae",
        "required": True,
        "description": "Wan 视频 VAE；下拉只显示文件名同时匹配 wan + vae 的 VAE 文件。",
    },
    {
        "label": "UMT5 XXL text encoder",
        "path": "models/text_encoders",
        "folder": "text_encoders",
        "filename": DEFAULT_CLIP,
        "value": DEFAULT_CLIP,
        "kind": "clip",
        "required": True,
        "description": "Bernini/Wan 使用的 UMT5 XXL 文本编码器；下拉只显示匹配 umt5 + xxl 的 text_encoders 文件。",
    },
    {
        "label": "Wan2.2 High acceleration LoRA",
        "path": "models/loras/wan",
        "folder": "loras",
        "filename": DEFAULT_HIGH_LORA,
        "value": DEFAULT_HIGH_LORA,
        "kind": "loras",
        "required": True,
        "description": "High 阶段加速 LoRA；下拉只显示匹配 wan + t2v + high 的 LoRA 文件。",
    },
    {
        "label": "Wan2.2 Low acceleration LoRA",
        "path": "models/loras/wan",
        "folder": "loras",
        "filename": DEFAULT_LOW_LORA,
        "value": DEFAULT_LOW_LORA,
        "kind": "loras",
        "required": True,
        "description": "Low 阶段加速 LoRA；下拉只显示匹配 wan + t2v + low 的 LoRA 文件。",
    },
]

REQUIRED_MODELS = [
    make_missing_model_spec(item["label"], item["path"], item["filename"], item["description"])
    for item in MODEL_TREE
]


def _filename_list(folder_type: str) -> list[str]:
    try:
        return [str(item) for item in folder_paths.get_filename_list(folder_type)]
    except Exception:
        return []


def _dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value or "").strip()
        key = text.replace("\\", "/").lower()
        if text and key not in seen:
            result.append(text)
            seen.add(key)
    return result


def _model_choices(folder_type: str, keywords: str | list[str], default: str, match_mode: str = "AND") -> list[str]:
    try:
        matches = gjjutils_find_model_list(keywords, folder_type, match_mode)
    except Exception:
        matches = []
    folder_names = set(_filename_list(folder_type))
    choices = _dedupe([*matches])
    if default in folder_names and default not in choices:
        choices.insert(0, default)
    if choices:
        return choices
    label = " + ".join(str(item) for item in (keywords if isinstance(keywords, list) else [keywords]))
    return [f"未找到匹配模型：{folder_type} / {label}"]


def _is_missing_model_choice(value: Any) -> bool:
    return str(value or "").strip().startswith("未找到匹配模型：")


def _require_model_choice(value: Any, label: str) -> str:
    text = _as_text(value, "")
    if not text or _is_missing_model_choice(text):
        raise RuntimeError(f"{label} 未找到合法模型。请按 Bernini Studio 模型树放置模型后刷新 ComfyUI。")
    return text


def _as_bool(value: Any, default: bool = False) -> bool:
    value = _first_value(value, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "on", "是", "开", "开启"}:
            return True
        if text in {"0", "false", "no", "off", "否", "关", "关闭", ""}:
            return False
    return default


def _as_int(value: Any, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
    value = _first_value(value, default)
    try:
        result = int(value)
    except Exception:
        result = default
    if min_value is not None:
        result = max(min_value, result)
    if max_value is not None:
        result = min(max_value, result)
    return result


def _as_float(value: Any, default: float, min_value: float | None = None, max_value: float | None = None) -> float:
    value = _first_value(value, default)
    try:
        result = float(value)
    except Exception:
        result = default
    if min_value is not None:
        result = max(min_value, result)
    if max_value is not None:
        result = min(max_value, result)
    return result


def _as_format_name(value: Any, default: str = "video/h264-mp4") -> str:
    value = _first_value(value, default)
    text = str(value if value is not None else "").strip()
    if not text or text.lower() in {"true", "false", "none", "null", "0", "1"}:
        return default
    return text


def _first_value(value: Any, default: Any = None) -> Any:
    if isinstance(value, (list, tuple)):
        return _first_value(value[0], default) if value else default
    return default if value is None else value


def _as_text(value: Any, default: str = "") -> str:
    return str(_first_value(value, default) or default)


def _has_media(value: Any) -> bool:
    try:
        if _media_components(value)[0] is not None:
            return True
    except Exception:
        pass
    return bool(_collect_reference_image_frames(value))


def _components_indicate_video(value: Any) -> bool:
    if value is None:
        return False
    audio = _component_value(value, "audio")
    fps = _component_value(value, "frame_rate")
    if fps is None:
        fps = _component_value(value, "fps")
    return audio is not None or fps is not None


def _is_video_media(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, (list, tuple)):
        return _is_video_media(value[0]) if len(value) == 1 else False
    getter = getattr(value, "get_components", None)
    if callable(getter):
        try:
            return _components_indicate_video(getter())
        except Exception:
            return False
    if isinstance(value, dict):
        return _components_indicate_video(value)
    return False


def _tensor_frame_sizes(value: Any) -> list[tuple[int, int]]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        sizes: list[tuple[int, int]] = []
        for item in value:
            sizes.extend(_tensor_frame_sizes(item))
        return sizes
    if isinstance(value, dict):
        for key in ("images", "frames", "image", "samples"):
            sizes = _tensor_frame_sizes(value.get(key))
            if sizes:
                return sizes
        return []
    if not isinstance(value, torch.Tensor):
        return []
    tensor = value.detach()
    if tensor.ndim == 3:
        if tensor.shape[-1] in (1, 3, 4):
            return [(int(tensor.shape[0]), int(tensor.shape[1]))]
        if tensor.shape[0] in (1, 3, 4):
            return [(int(tensor.shape[1]), int(tensor.shape[2]))]
        return []
    if tensor.ndim < 4:
        return []
    if tensor.shape[-1] in (1, 3, 4):
        return [(int(tensor.shape[-3]), int(tensor.shape[-2]))]
    if tensor.shape[-3] in (1, 3, 4):
        return [(int(tensor.shape[-2]), int(tensor.shape[-1]))]
    return []


def _media_original_frame_sizes(value: Any) -> list[tuple[int, int]]:
    getter = getattr(value, "get_components", None)
    if callable(getter):
        try:
            components = getter()
        except Exception:
            return []
        source = _component_value(components, "images")
        if source is None:
            source = _component_value(components, "frames")
        return _tensor_frame_sizes(source)
    if isinstance(value, dict):
        for key in ("images", "frames", "image", "samples"):
            sizes = _tensor_frame_sizes(value.get(key))
            if sizes:
                return sizes
    return _tensor_frame_sizes(value)


def _multiframe_source_looks_like_video(value: Any, frame_count: int) -> bool:
    if int(frame_count) <= 1:
        return False
    if _is_video_media(value):
        return True
    if int(frame_count) > 10:
        return True
    sizes = _media_original_frame_sizes(value)
    return bool(sizes) and len(set(sizes)) == 1


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _cat_bhwc_tensors(tensors: list[torch.Tensor]) -> torch.Tensor | None:
    tensors = [tensor for tensor in tensors if tensor is not None and tensor.ndim == 4]
    if not tensors:
        return None

    channels = max(3, max(int(tensor.shape[-1]) for tensor in tensors))
    device = tensors[0].device
    dtype = tensors[0].dtype
    target_short = max(min(int(tensor.shape[1]), int(tensor.shape[2])) for tensor in tensors)

    resized: list[torch.Tensor] = []
    for tensor in tensors:
        tensor = tensor.to(device=device, dtype=dtype)
        if int(tensor.shape[-1]) < channels:
            pad = torch.zeros(
                (*tensor.shape[:-1], channels - int(tensor.shape[-1])),
                dtype=dtype,
                device=device,
            )
            tensor = torch.cat((tensor, pad), dim=-1)
        h = int(tensor.shape[1])
        w = int(tensor.shape[2])
        short = max(1, min(h, w))
        scale = float(target_short) / float(short)
        next_h = max(1, int(round(h * scale)))
        next_w = max(1, int(round(w * scale)))
        if next_h != h or next_w != w:
            import comfy.utils

            method = "area" if scale < 1.0 else "bicubic"
            tensor = comfy.utils.common_upscale(
                tensor[:, :, :, :channels].movedim(-1, 1),
                next_w,
                next_h,
                method,
                "center",
            ).movedim(1, -1).clamp(0.0, 1.0)
        resized.append(tensor.contiguous())

    target_h = max(int(tensor.shape[1]) for tensor in resized)
    target_w = max(int(tensor.shape[2]) for tensor in resized)
    packed: list[torch.Tensor] = []
    for tensor in resized:
        if int(tensor.shape[1]) == target_h and int(tensor.shape[2]) == target_w:
            packed.append(tensor.contiguous())
            continue
        canvas = torch.zeros(
            (int(tensor.shape[0]), target_h, target_w, channels),
            dtype=dtype,
            device=device,
        )
        y = max(0, (target_h - int(tensor.shape[1])) // 2)
        x = max(0, (target_w - int(tensor.shape[2])) // 2)
        canvas[:, y : y + int(tensor.shape[1]), x : x + int(tensor.shape[2]), :] = tensor
        packed.append(canvas)
    return torch.cat(packed, dim=0).contiguous()


def _tensor_to_bhwc(value: Any) -> torch.Tensor | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        tensors = [_tensor_to_bhwc(item) for item in value]
        tensors = [item for item in tensors if item is not None]
        return _cat_bhwc_tensors(tensors)
    if isinstance(value, dict):
        for key in ("images", "frames", "image", "samples"):
            tensor = _tensor_to_bhwc(value.get(key))
            if tensor is not None:
                return tensor
        return None
    if not isinstance(value, torch.Tensor):
        return None
    tensor = value.detach()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim > 4:
        if tensor.shape[-1] in (1, 3, 4):
            tensor = tensor.reshape(-1, tensor.shape[-3], tensor.shape[-2], tensor.shape[-1])
        elif tensor.shape[-3] in (1, 3, 4):
            tensor = tensor.reshape(-1, tensor.shape[-3], tensor.shape[-2], tensor.shape[-1]).permute(0, 2, 3, 1)
        else:
            return None
    if tensor.ndim != 4:
        return None
    if tensor.shape[-1] not in (1, 3, 4) and tensor.shape[1] in (1, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    if tensor.shape[-1] == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif tensor.shape[-1] >= 4:
        tensor = tensor[..., :3]
    elif tensor.shape[-1] != 3:
        return None
    tensor = torch.nan_to_num(tensor.float(), nan=0.0, posinf=1.0, neginf=0.0)
    if tensor.numel() and (float(tensor.amin()) < 0.0 or float(tensor.amax()) > 1.0):
        low, high = tensor.amin(), tensor.amax()
        tensor = (tensor - low) / (high - low) if float(high - low) > 1e-8 else torch.zeros_like(tensor)
    return tensor.clamp(0.0, 1.0).contiguous()


def _media_components(value: Any) -> tuple[torch.Tensor | None, Any, float | None]:
    source = value
    audio = None
    fps = None
    getter = getattr(value, "get_components", None)
    if callable(getter):
        try:
            components = getter()
        except Exception as exc:
            raise RuntimeError(f"读取 VIDEO 输入失败：{exc}") from exc
        source = _component_value(components, "images")
        if source is None:
            source = _component_value(components, "frames")
        audio = _component_value(components, "audio")
        fps = _component_value(components, "frame_rate")
    elif isinstance(value, dict):
        audio = value.get("audio")
        fps = value.get("frame_rate") or value.get("fps")
    try:
        fps = float(fps) if fps is not None else None
    except Exception:
        fps = None
    return _tensor_to_bhwc(source), audio, fps


def _first_media_size(*values: Any) -> tuple[int, int] | None:
    for value in values:
        try:
            tensor = _media_components(value)[0]
        except Exception:
            frames = _collect_reference_image_frames(value)
            tensor = frames[0] if frames else None
        if tensor is not None:
            return int(tensor.shape[2]), int(tensor.shape[1])
    return None


def _normalize_to_stride(value: int, stride: int = 16) -> int:
    return max(stride, int(round(int(value) / stride) * stride))


def _source_length(value: Any, fallback: int) -> int:
    tensor = _media_components(value)[0]
    if tensor is None:
        return fallback
    return max(1, min(int(tensor.shape[0]), fallback))


def _resolve_output_kind(output_kind: str, length: int, source_media: Any, reference_video: Any) -> str:
    output_kind = str(output_kind or "auto")
    if output_kind in {"image", "video"}:
        return output_kind
    if int(length) <= 1 and not _has_media(reference_video):
        return "image"
    return "video"


def _mode_output_kind(mode: str, fallback: str) -> str:
    mode = str(mode or "auto").upper()
    if mode in {"T2I", "I2I", "R2I"}:
        return "image"
    if mode in MODE_SYSTEM_PROMPTS:
        return "video"
    return fallback


def _mode_uses_source_context(mode: str) -> bool:
    return str(mode or "").upper() in {"I2I", "I2V", "V2V", "VI2V", "RV2V", "ADS2V", "VRC2V", "MV2V"}


def _mode_uses_source_as_reference(mode: str) -> bool:
    return str(mode or "").upper() in {"R2I", "R2V"}


def _mode_pads_source_context(mode: str) -> bool:
    return str(mode or "").upper() not in {"I2V"}


def _mode_treats_multiframe_source_as_video(mode: str) -> bool:
    return str(mode or "").upper() in {"V2V", "VI2V", "RV2V", "ADS2V", "VRC2V", "MV2V"}


def _resolve_mode(mode: str, output_kind: str, source_media: Any, reference_video: Any, kwargs: dict[str, Any]) -> str:
    mode = str(mode or "auto").upper()
    if mode in MODE_SYSTEM_PROMPTS:
        return mode

    has_source = _has_media(source_media)
    source_is_video = _is_video_media(source_media) or _as_bool(kwargs.get("source_looks_like_video"), False)
    ref_values = [kwargs.get(f"reference_media_{index}") for index in range(1, MAX_REFERENCE_IMAGES + 1)]
    has_refs = any(_has_media(value) for value in ref_values)

    if output_kind == "image":
        if has_refs and (not has_source or not source_is_video):
            return "R2I"
        if has_source:
            return "I2I"
        return "T2I"

    if has_refs and (not has_source or not source_is_video):
        return "R2V"
    if has_source:
        if source_is_video:
            return "VI2V" if has_refs else "V2V"
        return "I2V"
    return "T2V"


def _merge_prompt(mode: str, prompt: str, extra_instruction: str = "") -> str:
    parts = [MODE_SYSTEM_PROMPTS.get(mode, DEFAULT_SYSTEM_PROMPT)]
    prompt = str(prompt or "").strip()
    extra_instruction = str(extra_instruction or "").strip()
    if prompt:
        parts.append(prompt)
    if extra_instruction:
        parts.append(extra_instruction)
    return "\n".join(parts)


def _split_sigmas(sigmas: torch.Tensor, high_steps: int) -> tuple[torch.Tensor, torch.Tensor]:
    high_steps = max(1, min(int(high_steps), max(1, int(sigmas.shape[0]) - 1)))
    return sigmas[: high_steps + 1], sigmas[high_steps:]


def _node_output_first(value: Any) -> Any:
    if isinstance(value, (list, tuple)):
        return value[0]
    try:
        return value[0]
    except Exception:
        pass
    for key in ("result", "values", "output"):
        candidate = getattr(value, key, None)
        if isinstance(candidate, (list, tuple)) and candidate:
            return candidate[0]
    raise RuntimeError(f"无法解析官方采样节点输出：{type(value).__name__}")


def _video_combine_result(value: Any) -> tuple[Any, str, str]:
    if isinstance(value, dict):
        result = value.get("result")
        if isinstance(result, (list, tuple)):
            return (
                result[0] if len(result) > 0 else None,
                str(result[1] if len(result) > 1 and result[1] is not None else ""),
                str(result[2] if len(result) > 2 and result[2] is not None else ""),
            )
        return (value.get("video"), str(value.get("output_path") or ""), str(value.get("files_json") or ""))
    if isinstance(value, (list, tuple)):
        return (
            value[0] if len(value) > 0 else None,
            str(value[1] if len(value) > 1 and value[1] is not None else ""),
            str(value[2] if len(value) > 2 and value[2] is not None else ""),
        )
    return (value, "", "")


def _decode_bernini_frames(vae: Any, samples: dict[str, Any], kwargs: dict[str, Any]) -> torch.Tensor:
    try:
        from nodes import VAEDecode

        decoded = VAEDecode().decode(vae, samples)
        frames = _node_output_first(decoded)
        tensor = _tensor_to_bhwc(frames)
        if tensor is None:
            raise RuntimeError(f"原生 VAEDecode 返回了不可识别的图像结果：{type(frames).__name__}")
        return tensor
    except Exception as native_exc:
        print(f"[GJJ BerniniStudio] 原生 VAEDecode 失败，回退 GJJ_WanVideoDecode：{native_exc}")
        return GJJ_WanVideoDecode().decode(
            vae=vae,
            samples=samples,
            enable_vae_tiling=_as_bool(kwargs.get("vae_tiling"), False),
            tile_x=_as_int(kwargs.get("tile_x"), 272, 40, 2048),
            tile_y=_as_int(kwargs.get("tile_y"), 272, 40, 2048),
            tile_stride_x=144,
            tile_stride_y=128,
            normalization="default",
        )[0]


def _custom_sampler_nodes():
    try:
        from comfy_extras.nodes_custom_sampler import BasicScheduler, KSamplerSelect, SamplerCustom

        return BasicScheduler, KSamplerSelect, SamplerCustom
    except Exception as exc:
        raise RuntimeError(f"无法导入 ComfyUI 官方自定义采样模块：{exc}") from exc


def _basic_sigmas(model: Any, scheduler: str, steps: int, denoise: float):
    try:
        import comfy.samplers

        steps = max(1, int(steps))
        denoise = max(0.0, min(1.0, float(denoise)))
        scheduler = str(scheduler or "simple").strip()
        available_schedulers = {
            str(item) for item in getattr(comfy.samplers, "SCHEDULER_NAMES", [])
        }
        if scheduler not in available_schedulers:
            print(
                f"[GJJ BerniniStudio] 无效调度器 {scheduler!r}，"
                "已自动回退为 'simple'。"
            )
            scheduler = "simple"
        if denoise <= 0.0:
            return torch.empty((0,), dtype=torch.float32)
        total_steps = steps if denoise >= 1.0 else max(steps, int(steps / denoise))
        model_sampling = model.get_model_object("model_sampling")
        sigmas = comfy.samplers.calculate_sigmas(
            model_sampling,
            scheduler,
            total_steps,
        ).cpu()
        return sigmas[-(steps + 1):]
    except Exception as exc:
        raise RuntimeError(f"生成采样调度失败（GJJ直接调度器）：{exc}") from exc


def _ksampler(sampler_name: str):
    try:
        _BasicScheduler, KSamplerSelect, _SamplerCustom = _custom_sampler_nodes()
        import comfy.samplers

        sampler_name = str(sampler_name or "euler").strip()
        available_samplers = {
            str(item)
            for item in (
                getattr(comfy.samplers, "SAMPLER_NAMES", None)
                or getattr(comfy.samplers.KSampler, "SAMPLERS", [])
            )
        }
        if sampler_name not in available_samplers:
            print(
                f"[GJJ BerniniStudio] 无效采样器 {sampler_name!r}，"
                "已自动回退为 'euler'。"
            )
            sampler_name = "euler"
        return _node_output_first(KSamplerSelect.execute(sampler_name))
    except Exception as exc:
        raise RuntimeError(f"选择采样器失败：{exc}") from exc


def _sample(model, positive, negative, sampler, sigmas, latent, add_noise, seed, cfg):
    try:
        _BasicScheduler, _KSamplerSelect, SamplerCustom = _custom_sampler_nodes()
        return _node_output_first(
            SamplerCustom.execute(
                model,
                bool(add_noise),
                int(seed),
                float(cfg),
                positive,
                negative,
                sampler,
                sigmas,
                latent,
            )
        )
    except Exception as exc:
        raise RuntimeError(f"Bernini 采样失败：{exc}") from exc


def _legal_segment_length(value: Any) -> int:
    length = _as_int(value, 81, 5, 225)
    return max(5, ((length - 1 + 3) // 4) * 4 + 1)


def _pad_frames(frames: torch.Tensor | None, length: int) -> torch.Tensor | None:
    if frames is None or int(frames.shape[0]) >= int(length):
        return frames
    tail = frames[-1:].repeat(int(length) - int(frames.shape[0]), 1, 1, 1)
    return torch.cat([frames, tail], dim=0)


def _collect_reference_image_frames(value: Any) -> list[torch.Tensor]:
    if value is None:
        return []
    getter = getattr(value, "get_components", None)
    if callable(getter):
        try:
            components = getter()
        except Exception:
            return []
        return _collect_reference_image_frames(components)
    if isinstance(value, torch.Tensor):
        tensor = _tensor_to_bhwc(value)
        if tensor is None:
            return []
        return [tensor[index : index + 1].contiguous() for index in range(int(tensor.shape[0]))]
    if isinstance(value, (list, tuple)):
        frames: list[torch.Tensor] = []
        for item in value:
            frames.extend(_collect_reference_image_frames(item))
        return frames
    if isinstance(value, dict):
        priority_keys = ("images", "frames", "image", "samples")
        frames: list[torch.Tensor] = []
        for key in priority_keys:
            if key in value:
                frames.extend(_collect_reference_image_frames(value.get(key)))
        if frames:
            return frames
        for key, item in value.items():
            if str(key).lower() in {"audio", "frame_rate", "fps", "metadata", "info"}:
                continue
            frames.extend(_collect_reference_image_frames(item))
        return frames
    return []


def _resize_reference_frame(frame: torch.Tensor, max_size: int) -> torch.Tensor:
    tensor = _tensor_to_bhwc(frame)
    if tensor is None:
        raise RuntimeError("参考图片无法转换为 BHWC tensor。")
    h, w = int(tensor.shape[1]), int(tensor.shape[2])
    if h <= 0 or w <= 0:
        raise RuntimeError("参考图片尺寸无效。")
    scale = min(float(max_size) / max(h, w), 1.0)
    nh = max(16, int(round(h * scale / 16) * 16))
    nw = max(16, int(round(w * scale / 16) * 16))
    if nh == h and nw == w:
        return tensor[:, :, :, :3].contiguous()
    import comfy.utils

    return comfy.utils.common_upscale(
        tensor[:, :, :, :3].movedim(-1, 1),
        nw,
        nh,
        "area",
        "center",
    ).movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _pack_reference_image_batch(values: list[Any], ref_max_size: int) -> torch.Tensor | None:
    frames: list[torch.Tensor] = []
    for value in values:
        frames.extend(_collect_reference_image_frames(value))
    if not frames:
        return None
    resized = [_resize_reference_frame(frame, int(ref_max_size)) for frame in frames]
    target_h = max(int(frame.shape[1]) for frame in resized)
    target_w = max(int(frame.shape[2]) for frame in resized)
    packed: list[torch.Tensor] = []
    for frame in resized:
        h, w = int(frame.shape[1]), int(frame.shape[2])
        canvas = torch.zeros((int(frame.shape[0]), target_h, target_w, 3), dtype=frame.dtype, device=frame.device)
        y = max(0, (target_h - h) // 2)
        x = max(0, (target_w - w) // 2)
        canvas[:, y : y + h, x : x + w, :] = frame[:, :, :, :3]
        packed.append(canvas)
    return torch.cat(packed, dim=0).contiguous()


def _batch_references_with_image_batch_multi(values: list[Any], ref_max_size: int) -> torch.Tensor | None:
    values = [value for value in values if value is not None]
    frames: list[torch.Tensor] = []
    for value in values:
        frames.extend(_collect_reference_image_frames(value))
    if not frames:
        return None
    first = _tensor_to_bhwc(frames[0])
    if first is None:
        return None
    height = int(first.shape[1])
    width = int(first.shape[2])
    if height <= 0 or width <= 0:
        return None
    scale = min(float(ref_max_size) / max(height, width), 1.0)
    target_width = _normalize_to_stride(max(16, int(round(width * scale))))
    target_height = _normalize_to_stride(max(16, int(round(height * scale))))
    kwargs = {
        f"image_{index:02d}": frame
        for index, frame in enumerate(frames, start=1)
        if index <= 16
    }
    if not kwargs:
        return None
    if len(frames) > 16:
        raise RuntimeError("Bernini Studio 参考图超过 16 张；GJJ_ImageBatchMulti 当前最多接收 16 路图片。请减少参考图数量。")
    try:
        output, _width, _height, count = GJJ_ImageBatchMulti().combine(
            size_preset="320",
            orientation="原始比例",
            prepend_frame="无",
            custom_size=0,
            custom_ratio="1:1",
            align_multiple="16",
            width=target_width,
            height=target_height,
            **kwargs,
        )
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"参考图批量打包失败：{exc}") from exc
    if output is None or int(count) <= 0:
        return None
    tensor = _tensor_to_bhwc(output)
    return tensor.contiguous() if tensor is not None and int(tensor.shape[0]) > 0 else None


def _reference_order_summary(values: list[Any]) -> str:
    parts: list[str] = []
    for index, value in enumerate(values, start=1):
        count = len(_collect_reference_image_frames(value))
        if count:
            parts.append(f"参考媒体{index}:{count}张")
    return " + ".join(parts)


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if unique_id is None:
        return
    try:
        from server import PromptServer

        payload = {"node": str(unique_id), "text": str(text)}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _send_segment_preview(unique_id: Any, preview_images: list[dict[str, Any]], index: int, total: int, label: str = "") -> None:
    if unique_id is None:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_bernini_segment_preview",
            {
                "node": str(unique_id),
                "images": preview_images,
                "segment": int(index),
                "total": int(total),
                "label": str(label or ""),
            },
        )
    except Exception:
        pass


def _send_seed_update(unique_id: Any, seed: int) -> None:
    if unique_id is None:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_bernini_seed_update",
            {"node": str(unique_id), "seed": int(seed)},
        )
    except Exception:
        pass


class GJJ_BerniniStudio:
    CATEGORY = "GJJ/Bernini"
    FUNCTION = "generate"
    INPUT_IS_LIST = True
    OUTPUT_NODE = True
    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE,VIDEO",)
    RETURN_NAMES = ("生成结果",)
    OUTPUT_TOOLTIPS = (
        "按当前模式输出生成结果：图像模式为 IMAGE/GJJ_BATCH_IMAGE，视频模式为 VIDEO。",
    )
    DESCRIPTION = "LazyImageStudio 风格 Bernini 一体化节点：三路智能媒体输入，自动识别图片/批量图片/VIDEO，长视频分段生成、逐段节点内预览，最终保留源帧率和音频合成视频。"
    SEARCH_ALIASES = ["bernini", "Bernini Studio", "Bernini单节点", "多功能视频编辑", "参考视频编辑"]
    GJJ_UI = {"style_reference": "GJJ_LazyImageStudio", "model_keyword": "bernini"}
    GJJ_HELP = build_node_help_payload(
        description=DESCRIPTION,
        model_tree=MODEL_TREE,
        models=REQUIRED_MODELS,
        usage=[
            "不手动选模式时，节点会根据源媒体与两路参考媒体自动判断 T2I/T2V/I2I/I2V/V2V/R2V/RV2V/MV2V。",
            "VIDEO 自动解包帧、帧率与音频；长视频按每段帧数循环执行 Bernini High/Low 双阶段采样。",
            "模型下拉只显示符合 Bernini 模型树关键词的合法候选，不再混入目录中的其它模型。",
        ],
        notice="Bernini Studio 使用公共模型树声明；模型按树放入对应目录后刷新或重启 ComfyUI。",
        extra={
            "title": "Bernini Studio",
            "workflow_reference": r"D:\AI\MOD\user\default\workflows\BERNINI.json",
            "model_tree": MODEL_TREE,
            "models": REQUIRED_MODELS,
            "static_model_tree_only": True,
            "model_tree_priority": "static",
        },
    )
    _MODEL_CACHE: dict[tuple[Any, ...], tuple[Any, Any, Any, Any]] = {}
    _RESULT_CACHE: dict[str, dict[str, Any]] = {}

    @classmethod
    def INPUT_TYPES(cls):
        high_models = _model_choices("diffusion_models", ["bernini", "high"], DEFAULT_HIGH_MODEL)
        low_models = _model_choices("diffusion_models", ["bernini", "low"], DEFAULT_LOW_MODEL)
        vae_models = _model_choices("vae", ["wan","2.1", "vae"], DEFAULT_VAE)
        clip_models = _model_choices("text_encoders", ["umt5", "xxl"], DEFAULT_CLIP)
        high_loras = _model_choices("loras", ["wan", "t2v","a14b","high"], DEFAULT_HIGH_LORA)
        low_loras = _model_choices("loras", ["wan", "t2v","a14b","low"], DEFAULT_LOW_LORA)
        return {
            "required": {},
            "optional": {
                "source_media": (MIXED_IMAGE_TYPE, {"display_name": "源媒体", "tooltip": "支持 GJJ_BATCH_IMAGE、IMAGE、VIDEO；VIDEO 会自动解包帧、音频与帧率，长视频自动分段执行。"}),
                "reference_media_1": (MIXED_IMAGE_TYPE, {"display_name": "参考媒体 1", "tooltip": "支持图片、批量图片或 VIDEO；视频会按当前源视频分段位置同步切片。"}),
                "reference_media_2": (MIXED_IMAGE_TYPE, {"display_name": "参考媒体 2", "tooltip": "第二路参考图片、批量图片或 VIDEO。"}),
                "prompt": ("STRING", {"default": DEFAULT_PROMPT, "multiline": True, "display_name": "提示词", "tooltip": "描述要生成或编辑的目标。节点会在前面自动加入当前模式的系统提示词。"}),
                "extra_instruction": ("STRING", {"default": "", "multiline": True, "display_name": "附加指令", "tooltip": "可选。追加在提示词后，适合写局部要求、风格、镜头或约束。"}),
                "negative_prompt": ("STRING", {"default": DEFAULT_NEGATIVE, "multiline": True, "display_name": "负面提示词", "tooltip": "不想要的内容。默认沿用 BERNINI.json 的 bad video。"}),
                "mode": (MODE_CHOICES, {"default": "auto", "display_name": "模式", "tooltip": "auto 会根据接入内容智能选择；也可手动固定 T2I/T2V/I2I/R2V/MV2V 等模式。"}),
                "width": ("INT", {"default": 832, "min": 16, "max": 8192, "step": 16, "display_name": "宽度", "tooltip": "输出宽度。"}),
                "height": ("INT", {"default": 480, "min": 16, "max": 8192, "step": 16, "display_name": "高度", "tooltip": "输出高度。"}),
                "length": ("INT", {"default": 81, "min": 1, "max": 8192, "step": 4, "display_name": "帧数", "tooltip": "视频帧数。"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096, "step": 1, "display_name": "批次数", "tooltip": "latent 批次数。"}),
                "steps": ("INT", {"default": 6, "min": 1, "max": 1000, "step": 1, "display_name": "步数", "tooltip": "总采样步数。默认对齐 BERNINI.json。"}),
                "high_steps": ("INT", {"default": 3, "min": 1, "max": 1000, "step": 1, "display_name": "高噪步数", "tooltip": "双阶段中 High 模型使用的前半段步数。默认 3。"}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 30.0, "step": 0.01, "display_name": "CFG", "tooltip": "提示词引导强度。"}),
                "seed": ("INT", {"default": 42, "min": 0, "max": 0xffffffffffffffff, "display_name": "种子", "tooltip": "随机种子。"}),
                "sampler_name": ("STRING", {"default": "euler", "display_name": "采样器", "tooltip": "默认 euler。"}),
                "scheduler": ("STRING", {"default": "simple", "display_name": "调度器", "tooltip": "默认 simple。"}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "降噪", "tooltip": "调度器 denoise。"}),
                "ref_max_size": ("INT", {"default": 848, "min": 16, "max": 8192, "step": 16, "display_name": "参考最长边", "tooltip": "参考图/参考视频编码前的最长边。"}),
                "use_accel_lora": ("BOOLEAN", {"default": True, "display_name": "加速LoRA", "tooltip": "对齐原工作流，默认叠加 Wan2.2 T2V 4step LightX2V LoRA。"}),
                "enable_sage_attention": ("BOOLEAN", {"default": True, "display_name": "SageAttention", "tooltip": "对齐原工作流。缺依赖时 GJJ 模型补丁会自动跳过。"}),
                "enable_fp16_accumulation": ("BOOLEAN", {"default": False, "display_name": "FP16累积", "tooltip": "对齐 BERNINI.json 原工作流，默认不启用模型补丁里的 FP16 累积设置；部分环境开启会导致采样花屏。"}),
                "frame_rate": ("FLOAT", {"default": 16.0, "min": 1.0, "max": 240.0, "step": 1.0, "display_name": "帧率", "tooltip": "视频输出帧率。"}),
                "filename_prefix": ("STRING", {"default": "video/Bernini_Studio", "display_name": "文件名前缀", "tooltip": "保存视频的文件名前缀。"}),
                "format_name": ("STRING", {"default": "video/h264-mp4", "display_name": "输出格式", "tooltip": "GJJ 视频合成器格式名。"}),
                "vae_tiling": ("BOOLEAN", {"default": False, "display_name": "VAE分块", "tooltip": "解码时启用 VAE 分块，省显存但可能更慢。"}),
                "tile_x": ("INT", {"default": 272, "min": 40, "max": 2048, "step": 8, "display_name": "分块宽", "tooltip": "VAE 分块宽度。"}),
                "tile_y": ("INT", {"default": 272, "min": 40, "max": 2048, "step": 8, "display_name": "分块高", "tooltip": "VAE 分块高度。"}),
                "high_model": (high_models, {"default": high_models[0], "display_name": "High模型", "tooltip": "使用 GJJ 公共模型搜索函数在 diffusion_models 中搜索 Bernini High 模型，并返回可选列表。"}),
                "low_model": (low_models, {"default": low_models[0], "display_name": "Low模型", "tooltip": "使用 GJJ 公共模型搜索函数在 diffusion_models 中搜索 Bernini Low 模型，并返回可选列表。"}),
                "vae_name": (vae_models, {"default": vae_models[0], "display_name": "VAE", "tooltip": "使用 GJJ 公共模型搜索函数在 models/vae 中搜索 Wan VAE，并返回可选列表。"}),
                "clip_name": (clip_models, {"default": clip_models[0], "display_name": "CLIP编码器", "tooltip": "使用 GJJ 公共模型搜索函数在 text_encoders 中搜索 UMT5 XXL 编码器，并返回可选列表。"}),
                "high_lora": (high_loras, {"default": high_loras[0], "display_name": "High LoRA", "tooltip": "使用 GJJ 公共模型搜索函数在 loras 中搜索 High 加速 LoRA，并返回可选列表。"}),
                "low_lora": (low_loras, {"default": low_loras[0], "display_name": "Low LoRA", "tooltip": "使用 GJJ 公共模型搜索函数在 loras 中搜索 Low 加速 LoRA，并返回可选列表。"}),
                "translation_enabled": ("BOOLEAN", {"default": False, "display_name": "翻译提示词", "tooltip": "开启后复用 GJJ CLIP 面板翻译。"}),
                "segment_frames": ("INT", {"default": 21, "min": 5, "max": 225, "step": 4, "display_name": "每段帧数", "tooltip": "长视频每段生成帧数，自动规范为 4n+1。推荐 25、49、81、121、169、225。"}),
                "keep_model": ("BOOLEAN", {"default": True, "display_name": "保持模型", "tooltip": "开启后相同模型配置会复用已加载的 High/Low/VAE/CLIP，避免每次生成都重新加载。"}),
                "prev_segment_ref_frames": ("INT", {"default": 1, "min": 0, "max": 32, "step": 1, "display_name": "上一段尾帧参考", "tooltip": "长视频分段时，从上一段生成结果取最后 N 帧，作为下一段的额外参考图。0 表示关闭。"}),
                "randomize_seed": ("BOOLEAN", {"default": False, "display_name": "随机种子", "tooltip": "开启后每次执行自动生成新种子；关闭时保持当前种子，输入不变可复用缓存结果。"}),
                "resize_to_panel": ("BOOLEAN", {"default": True, "display_name": "按面板尺寸", "tooltip": "开启时按面板宽高缩放裁剪；关闭时优先沿用源媒体尺寸。"}),
                "use_prev_segment_latent": ("BOOLEAN", {"default": False, "display_name": "上一段Latent", "tooltip": "长视频分段时，把上一段最终 latent 的尾部写入下一段初始 latent 开头，用于增强段落衔接。"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt_info": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        keys = [
            "source_media", "reference_media_1", "reference_media_2", "prompt", "extra_instruction",
            "negative_prompt", "mode", "width", "height", "length", "steps", "high_steps",
            "cfg", "seed", "sampler_name", "scheduler", "denoise", "ref_max_size", "use_accel_lora",
            "enable_sage_attention", "enable_fp16_accumulation", "frame_rate", "filename_prefix",
            "format_name", "vae_tiling", "high_model", "low_model", "vae_name", "clip_name", "high_lora", "low_lora",
            "segment_frames", "keep_model", "prev_segment_ref_frames", "randomize_seed", "resize_to_panel",
            "translation_enabled", "batch_size", "use_prev_segment_latent",
        ]
        parts = ["bernini_studio_cache_v2"]
        parts.extend(str(_first_value(kwargs.get(key), "")) for key in keys)
        if _as_bool(kwargs.get("randomize_seed"), False):
            parts.append(str(time.time_ns()))
        return "|".join(parts)

    def _model_cache_key(self, kwargs: dict[str, Any]) -> tuple[Any, ...]:
        return (
            _as_text(kwargs.get("high_model"), DEFAULT_HIGH_MODEL),
            _as_text(kwargs.get("low_model"), DEFAULT_LOW_MODEL),
            _as_text(kwargs.get("vae_name"), DEFAULT_VAE),
            _as_text(kwargs.get("clip_name"), DEFAULT_CLIP),
            _as_text(kwargs.get("high_lora"), DEFAULT_HIGH_LORA),
            _as_text(kwargs.get("low_lora"), DEFAULT_LOW_LORA),
            _as_bool(kwargs.get("use_accel_lora"), True),
            _as_bool(kwargs.get("enable_sage_attention"), True),
            _as_bool(kwargs.get("enable_fp16_accumulation"), False),
        )

    def _load_models(self, kwargs: dict[str, Any], unique_id=None):
        keep_model = _as_bool(kwargs.get("keep_model"), True)
        cache_key = self._model_cache_key(kwargs)
        if keep_model and cache_key in self._MODEL_CACHE:
            _send_status(unique_id, "1/5 复用 Bernini 模型缓存...", 0.03)
            return self._MODEL_CACHE[cache_key]

        out = GJJ_VideoUniversalModelLoader().load_models(
            config="wan22_bernini",
            use_accel_lora=_as_bool(kwargs.get("use_accel_lora"), True),
            file_1=_require_model_choice(kwargs.get("high_model"), "High 模型"),
            dtype_1="fp8_e4m3fn",
            file_2=_require_model_choice(kwargs.get("low_model"), "Low 模型"),
            dtype_2="fp8_e4m3fn",
            file_3=_require_model_choice(kwargs.get("vae_name"), "VAE"),
            dtype_3="default",
            file_4=_require_model_choice(kwargs.get("clip_name"), "CLIP 编码器"),
            dtype_4="fp8_e4m3fn",
            file_5=_require_model_choice(kwargs.get("high_lora"), "High LoRA"),
            file_6=_require_model_choice(kwargs.get("low_lora"), "Low LoRA"),
            clip_type_override="auto",
            unique_id=unique_id,
        )
        high_model, low_model, vae, clip = out[0], out[1], out[2], out[3]
        if high_model is None or low_model is None or vae is None or clip is None:
            raise RuntimeError("Bernini 模型加载结果不完整，请检查 High/Low/VAE/CLIP 模型是否存在。")
        patched_high, patched_low = GJJ_ModelPatchBundle().patch(
            MODEL=high_model,
            低模=low_model,
            启用SageAttention=_as_bool(kwargs.get("enable_sage_attention"), True),
            SageAttention模式="自动",
            允许Sage编译=False,
            启用FP16累积设置=_as_bool(kwargs.get("enable_fp16_accumulation"), False),
            FP16累积=True,
            启用LTXV前馈分块=False,
            分块数量=4,
            分块阈值=4096,
            缺SageAttention处理="自动跳过SageAttention继续运行",
            unique_id=unique_id,
        )
        result = (patched_high, patched_low, vae, clip)
        if keep_model:
            self._MODEL_CACHE[cache_key] = result
        return result

    def generate(self, **kwargs):
        unique_id = _first_value(kwargs.get("unique_id"))
        prompt_info = _first_value(kwargs.get("prompt_info"))
        extra_pnginfo = _first_value(kwargs.get("extra_pnginfo"))
        result_cache_key = ""
        if not _as_bool(kwargs.get("randomize_seed"), False):
            result_cache_key = self.IS_CHANGED(**kwargs)
            cached_result = self._RESULT_CACHE.get(result_cache_key)
            if cached_result is not None:
                _send_status(unique_id, "使用固定种子缓存结果", 1.0)
                return cached_result
        source_media = kwargs.get("source_media")
        source_is_video = _is_video_media(source_media)
        source_frames, source_audio, source_fps = _media_components(source_media)
        reference_values = [kwargs.get("reference_media_1"), kwargs.get("reference_media_2")]
        ref_max_size_value = _as_int(kwargs.get("ref_max_size"), 848, 16, 8192)
        reference_entries = []
        for value in reference_values:
            is_video = _is_video_media(value)
            frames, _audio, _fps = _media_components(value)
            frame_count = int(frames.shape[0]) if frames is not None else 0
            looks_like_video = is_video or _multiframe_source_looks_like_video(value, frame_count)
            reference_entries.append(
                {
                    "value": value,
                    "frames": frames,
                    "is_video": looks_like_video,
                }
            )
        reference_frames = [entry["frames"] for entry in reference_entries]
        reference_image_batch = _batch_references_with_image_batch_multi(
            [entry["value"] for entry in reference_entries if not entry["is_video"]],
            ref_max_size_value,
        )
        reference_image_inputs: list[torch.Tensor] = []
        if reference_image_batch is not None:
            reference_image_inputs = [
                reference_image_batch[index : index + 1].contiguous()
                for index in range(int(reference_image_batch.shape[0]))
            ]

        width = _as_int(kwargs.get("width"), 832, 16, 8192)
        height = _as_int(kwargs.get("height"), 480, 16, 8192)
        if not _as_bool(kwargs.get("resize_to_panel"), True):
            media_size = _first_media_size(source_media)
            if media_size:
                width = _normalize_to_stride(media_size[0])
                height = _normalize_to_stride(media_size[1])

        reference_video = next(
            (entry["frames"] for entry in reference_entries if entry["is_video"] and entry["frames"] is not None),
            None,
        )
        mode_kwargs = {
            "reference_media_1": reference_values[0],
            "reference_media_2": reference_values[1],
        }
        requested_length = _as_int(kwargs.get("length"), 81, 1, 8192)
        source_count = int(source_frames.shape[0]) if source_frames is not None else 0
        source_looks_like_video = _multiframe_source_looks_like_video(source_media, source_count)
        mode_kwargs["source_looks_like_video"] = source_looks_like_video
        source_image_batch_count = source_count if source_frames is not None and not source_is_video and source_count > 1 else 0
        initial_total_frames = source_count if source_looks_like_video and source_count > 1 else requested_length
        initial_output_kind = _resolve_output_kind("auto", initial_total_frames, source_media, reference_video)
        mode = _resolve_mode(_as_text(kwargs.get("mode"), "auto"), initial_output_kind, source_media, reference_video, mode_kwargs)
        source_sequence_is_video = source_is_video or (source_count > 1 and _mode_treats_multiframe_source_as_video(mode))
        if source_sequence_is_video:
            source_image_batch_count = 0
            if source_count > 1:
                initial_total_frames = source_count
                initial_output_kind = "video"
        elif mode not in {"I2I", "I2V"}:
            source_image_batch_count = 0
        mode_output_kind = _mode_output_kind(mode, initial_output_kind)
        use_source_context = _mode_uses_source_context(mode)
        use_source_as_reference = _mode_uses_source_as_reference(mode)
        pad_source_context = _mode_pads_source_context(mode)
        if use_source_as_reference and source_frames is not None and not source_sequence_is_video:
            source_reference = _resize_reference_frame(source_frames[:1], ref_max_size_value)
            reference_image_inputs = [source_reference, *reference_image_inputs]
        if reference_image_inputs:
            order_summary = _reference_order_summary([entry["value"] for entry in reference_entries if not entry["is_video"]])
            _send_status(
                unique_id,
                f"参考图顺序：{order_summary or '无'}；源媒体{'作为参考图参与' if use_source_as_reference else ('参与' if use_source_context else '不参与')}参考编号；已按顺序喂给条件入口：{len(reference_image_inputs)} 张",
                0.02,
            )
        segment_frames = _legal_segment_length(kwargs.get("segment_frames"))
        prev_segment_ref_frames = _as_int(kwargs.get("prev_segment_ref_frames"), 1, 0, 32)
        use_prev_segment_latent = _as_bool(kwargs.get("use_prev_segment_latent"), False)
        source_image_batches = mode == "I2I" and source_image_batch_count > 1
        source_image_transitions = mode == "I2V" and source_image_batch_count > 1
        total_output_frames = (
            requested_length * max(1, source_image_batch_count - 1)
            if source_image_transitions
            else (1 if mode_output_kind == "image" else initial_total_frames)
        )
        segmented = (not source_image_batches) and total_output_frames > segment_frames
        segment_count = source_image_batch_count if source_image_batches else (
            max(1, source_image_batch_count - 1) if source_image_transitions else (
                max(1, (total_output_frames + segment_frames - 1) // segment_frames) if segmented else 1
            )
        )
        final_prompt = _merge_prompt(mode, _as_text(kwargs.get("prompt"), DEFAULT_PROMPT), _as_text(kwargs.get("extra_instruction"), ""))

        _send_status(unique_id, "1/5 加载 Bernini 模型...", 0.03)
        patched_high, patched_low, vae, clip = self._load_models(kwargs, unique_id=unique_id)

        base_positive, base_negative = GJJ_CLIPPromptEncodePanel().encode(
            clip=clip,
            positive_text=final_prompt,
            negative_text=_as_text(kwargs.get("negative_prompt"), DEFAULT_NEGATIVE),
            zero_conditioning=False,
            translation_device="gpu",
            translation_unload_after_use=False,
            translation_enabled=_as_bool(kwargs.get("translation_enabled"), False),
            unique_id=unique_id,
        )

        batch_size = 1 if mode_output_kind == "image" else _as_int(kwargs.get("batch_size"), 1, 1, 4096)
        steps = _as_int(kwargs.get("steps"), 6, 1, 1000)
        high_steps = _as_int(kwargs.get("high_steps"), 3, 1, steps)
        if mode == "T2I" and steps == 6 and high_steps == 3:
            steps = 20
            high_steps = 10
        elif mode == "I2V" and steps == 20 and high_steps == 10:
            steps = 6
            high_steps = 3
        sigmas = _basic_sigmas(patched_low, _as_text(kwargs.get("scheduler"), "simple"), steps, _as_float(kwargs.get("denoise"), 1.0, 0.0, 1.0))
        high_sigmas, low_sigmas = _split_sigmas(sigmas, high_steps)
        sampler = _ksampler(_as_text(kwargs.get("sampler_name"), "euler"))
        seed = _as_int(kwargs.get("seed"), 42, 0, 0xffffffffffffffff)
        if _as_bool(kwargs.get("randomize_seed"), False):
            seed = random.SystemRandom().randrange(0, 0xffffffffffffffff)
            _send_seed_update(unique_id, seed)
        cfg = _as_float(kwargs.get("cfg"), 1.0, 0.0, 30.0)
        generated_segments: list[torch.Tensor] = []
        latest_preview: list[dict[str, Any]] = []
        previous_segment_latent: torch.Tensor | None = None

        for segment_index in range(segment_count):
            start = segment_index * segment_frames
            if source_image_batches:
                desired_length = 1
            elif source_image_transitions:
                desired_length = requested_length
            else:
                desired_length = (
                    min(segment_frames, max(1, total_output_frames - start))
                    if segmented
                    else max(1, total_output_frames)
                )
            generation_length = 1 if mode_output_kind == "image" else _legal_segment_length(desired_length)
            source_segment = None
            if use_source_context and source_frames is not None:
                if source_image_batches:
                    source_segment = source_frames[segment_index : segment_index + 1]
                elif source_image_transitions:
                    source_segment = source_frames[segment_index : segment_index + 1]
                elif source_sequence_is_video and source_count > 1 and segmented:
                    source_segment = source_frames[start : start + desired_length]
                else:
                    source_segment = source_frames if source_sequence_is_video else (
                        source_frames[:1] if source_count > 1 else source_frames
                    )
                if pad_source_context:
                    source_segment = _pad_frames(source_segment, generation_length)

            segment_reference_video = None
            segment_reference_images: list[torch.Tensor] = list(reference_image_inputs)
            if source_image_transitions:
                segment_reference_images.append(
                    _resize_reference_frame(source_frames[segment_index + 1 : segment_index + 2], ref_max_size_value)
                )
            if (not source_image_transitions) and segmented and mode_output_kind == "video" and prev_segment_ref_frames > 0 and generated_segments:
                tail = generated_segments[-1][-prev_segment_ref_frames:].contiguous()
                segment_reference_images.extend(
                    tail[index : index + 1].contiguous()
                    for index in range(int(tail.shape[0]))
                )
            for entry in reference_entries:
                ref = entry["frames"]
                if ref is None:
                    continue
                if entry["is_video"] and segment_reference_video is None:
                    ref_start = min(start, max(0, int(ref.shape[0]) - 1))
                    ref_chunk = ref[ref_start : ref_start + desired_length]
                    segment_reference_video = _pad_frames(ref_chunk, generation_length)

            progress_base = 0.12 + 0.72 * (segment_index / max(1, segment_count))
            _send_status(
                unique_id,
                f"2/5 生成第 {segment_index + 1}/{segment_count} 段（{desired_length} 帧）...",
                progress_base,
            )
            latent = torch.zeros(
                [batch_size, 16, ((generation_length - 1) // 4) + 1, height // 8, width // 8],
                device=torch.device("cpu"),
            )
            try:
                import comfy.model_management

                latent = latent.to(comfy.model_management.intermediate_device())
            except Exception:
                pass
            if (
                use_prev_segment_latent
                and segmented
                and mode_output_kind == "video"
                and previous_segment_latent is not None
                and previous_segment_latent.ndim == latent.ndim
            ):
                tail = previous_segment_latent.to(device=latent.device, dtype=latent.dtype)
                count = min(int(tail.shape[2]), int(latent.shape[2]))
                if count > 0 and tuple(tail.shape[:2]) == tuple(latent.shape[:2]) and tuple(tail.shape[3:]) == tuple(latent.shape[3:]):
                    latent[:, :, :count, :, :] = tail[:, :, -count:, :, :]

            context = []
            if source_segment is not None or segment_reference_video is not None or segment_reference_images:
                context_parts = _build_bernini_context(
                    vae,
                    generation_length,
                    width,
                    height,
                    source_video=source_segment,
                    reference_video=segment_reference_video,
                    reference_images=segment_reference_images,
                    ref_max_size=ref_max_size_value,
                )
                if "video" in context_parts:
                    context.append(context_parts["video"])
                context.extend(context_parts.get("refs") or [])
            positive, negative = base_positive, base_negative
            if context:
                positive = _conditioning_set_values(base_positive, {"context_latents": context})
                negative = _conditioning_set_values(base_negative, {"context_latents": context})

            latent_dict = {"samples": latent}
            high_latent = _sample(
                patched_high, positive, negative, sampler, high_sigmas, latent_dict,
                True, seed + segment_index, cfg,
            )
            final_latent = _sample(
                patched_low, positive, negative, sampler, low_sigmas, high_latent,
                False, seed + segment_index, cfg,
            )
            try:
                samples = final_latent.get("samples") if isinstance(final_latent, dict) else None
                previous_segment_latent = samples[:, :, -1:, :, :].detach().cpu().contiguous() if isinstance(samples, torch.Tensor) and samples.ndim == 5 else None
            except Exception:
                previous_segment_latent = None
            frames = _decode_bernini_frames(vae, final_latent, kwargs)
            frames = frames[:desired_length].detach().cpu().contiguous()
            if mode_output_kind == "image":
                frames = frames[:1]
            generated_segments.append(frames)

            latest_preview = gjjutils_write_temp_tensor_images(frames[-1:])
            _send_segment_preview(unique_id, latest_preview, segment_index + 1, segment_count, "tail_frame")
            try:
                del latent, latent_dict, high_latent, final_latent, positive, negative, context
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

        _send_status(unique_id, "4/5 拼接全部生成片段...", 0.88)
        all_frames = torch.cat(generated_segments, dim=0)
        if mode_output_kind == "image":
            all_frames = all_frames[:1].contiguous()
        effective_fps = source_media if callable(getattr(source_media, "get_components", None)) else (source_fps or _as_float(kwargs.get("frame_rate"), 8.0, 1.0, 240.0))
        audio_input = source_media if callable(getattr(source_media, "get_components", None)) else source_audio
        if mode_output_kind == "image":
            result_value = all_frames
            output_path = ""
        else:
            video, output_path, _files_json = _video_combine_result(
                GJJ_VideoCombine().combine(
                    images=all_frames,
                    frame_rate=effective_fps,
                    loop_count=0,
                    filename_prefix=_as_text(kwargs.get("filename_prefix"), "video/Bernini_Studio"),
                    format_name=_as_format_name(kwargs.get("format_name")),
                    pingpong=False,
                    save_output=True,
                    use_source_fps=True,
                    delete_tail_frame=False,
                    save_metadata=True,
                    trim_to_audio=False,
                    pix_fmt="auto",
                    crf="-1",
                    vae=None,
                    audio=audio_input,
                    prompt=prompt_info,
                    extra_pnginfo=extra_pnginfo,
                    unique_id=unique_id,
                )
            )
            result_value = video
        _send_status(unique_id, f"5/5 完成：{int(all_frames.shape[0])} 帧 / {segment_count} 段", 1.0)
        result_payload = {
            "ui": {
                "gjj_images": latest_preview,
                "segment_count": [segment_count],
                "frame_count": [int(all_frames.shape[0])],
                "output_path": [str(output_path or "")],
            },
            "result": (result_value,),
        }
        if result_cache_key:
            self._RESULT_CACHE[result_cache_key] = result_payload
            while len(self._RESULT_CACHE) > 3:
                try:
                    self._RESULT_CACHE.pop(next(iter(self._RESULT_CACHE)))
                except Exception:
                    break
        return result_payload


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_BerniniStudio}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧠Bernini多模态视频编辑器"}
