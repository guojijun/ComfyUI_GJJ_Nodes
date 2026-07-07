from __future__ import annotations

import inspect
import random
import time
from pathlib import Path
from typing import Any

import comfy.utils
import torch
from comfy_extras.nodes_custom_sampler import (
    BasicGuider,
    KSamplerSelect,
    RandomNoise,
    SamplerCustomAdvanced,
)
from comfy_extras.nodes_flux import EmptyFlux2LatentImage, Flux2Scheduler
from nodes import CLIPLoader, CLIPTextEncode, UNETLoader, VAEDecode, VAEEncode, VAELoader

from .common_utils.dependency_checker import build_node_help_payload, make_missing_model_spec
from .common_utils.model_manager import gjjutils_find_model_list
from .common_utils.progress import send_node_progress
from .common_utils.text_tools import gjjutils_normalize_text
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_F2KMultiImagePoseTransfer"
NODE_DISPLAY_NAME = "F2K多功能图片全身动作姿势迁移"
MIXED_IMAGE_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"

PROMPT = (
    "Preserve 100% of the subject's appearance, clothing, facial features, background, and environment from the first image. The only modification is to replicate the precise pose, standing position, arm gestures, and body orientation of the subject in the second image. No changes to the original subject, outfit, or background whatsoever. High-fidelity,photorealistic, sharp details, consistent lighting."
)

UNET_KEYWORDS = ("flux-2-klein-9b", "f2k")
CLIP_KEYWORDS = ("qwen_3_8b",)
VAE_KEYWORDS = ("flux2-vae",)
LORA_KEYWORDS = ("turbo-lora",)

UNET_DTYPE = "fp8_e4m3fn_fast"
CLIP_TYPE = "flux2"
CLIP_DEVICE = "default"
SCALE_METHOD = "area"
SCALE_MEGAPIXELS = 1.0
SCALE_RESOLUTION_STEPS = 1
GUIDANCE = 4.0
SAMPLER_NAME = "euler"
BASE_STEPS = 8
TURBO_STEPS = 8
ENABLE_TURBO_LORA = True
LORA_STRENGTH = 1.0
AUTO_UNET = "自动匹配（flux-2-klein-9b / f2k）"
MISSING_UNET = "未找到匹配模型：flux-2-klein-9b / f2k"
DEFAULT_UNET_MODEL = "flux-2-klein-9b-nvfp4.safetensors"
DEFAULT_CLIP_MODEL = "qwen_3_8b_fp8mixed.safetensors"
DEFAULT_VAE_MODEL = "flux2-vae.safetensors"
DEFAULT_LORA_MODEL = "Flux_2-Turbo-LoRA_comfyui_8steps_V2.safetensors"


MODEL_TREE = [
    {
        "label": "F2K / Flux2 Klein UNet",
        "path": "models/diffusion_models",
        "folder": "diffusion_models",
        "filename": DEFAULT_UNET_MODEL,
        "value": DEFAULT_UNET_MODEL,
        "kind": "diffusion",
        "required": True,
        "description": "节点会在 models/diffusion_models 中用公共模糊搜索自动匹配 flux-2-klein-9b / f2k。",
    },
    {
        "label": "Qwen3 8B CLIP",
        "path": "models/text_encoders",
        "folder": "text_encoders",
        "filename": DEFAULT_CLIP_MODEL,
        "value": DEFAULT_CLIP_MODEL,
        "kind": "clip",
        "required": True,
        "description": "节点会在 models/text_encoders 中自动匹配 qwen_3_8b。",
    },
    {
        "label": "Flux2 VAE",
        "path": "models/vae",
        "folder": "vae",
        "filename": DEFAULT_VAE_MODEL,
        "value": DEFAULT_VAE_MODEL,
        "kind": "vae",
        "required": True,
        "description": "节点会在 models/vae 中自动匹配 flux2-vae。",
    },
    {
        "label": "Flux2 Turbo LoRA",
        "path": "models/loras/Flux2",
        "folder": "loras/Flux2",
        "filename": DEFAULT_LORA_MODEL,
        "value": DEFAULT_LORA_MODEL,
        "kind": "loras",
        "required": True,
        "description": "必需；节点默认加载 Turbo LoRA，并按 8 步采样。",
    },
]

def _model_spec(label: str, folder: str, filename: str, description: str, kind: str = "") -> dict[str, str]:
    spec = make_missing_model_spec(
        label=label,
        subdir=f"models/{folder}",
        filename=filename,
        description=description,
    )
    spec["folder"] = folder
    spec["value"] = filename
    if kind:
        spec["kind"] = kind
    return spec


REQUIRED_MODELS = [
    _model_spec(
        label="F2K / Flux2 Klein UNet",
        folder="diffusion_models",
        filename=DEFAULT_UNET_MODEL,
        description="必需；主模型下拉只显示匹配 flux-2-klein-9b / f2k 的 diffusion_models 文件。",
        kind="diffusion",
    ),
    _model_spec(
        label="Qwen3 8B CLIP",
        folder="text_encoders",
        filename=DEFAULT_CLIP_MODEL,
        description="必需；节点内部自动按 qwen_3_8b 模糊搜索文本编码器。",
        kind="clip",
    ),
    _model_spec(
        label="Flux2 VAE",
        folder="vae",
        filename=DEFAULT_VAE_MODEL,
        description="必需；节点内部自动按 flux2-vae 模糊搜索 VAE。",
        kind="vae",
    ),
    _model_spec(
        label="Flux2 Turbo LoRA",
        folder="loras/Flux2",
        filename=DEFAULT_LORA_MODEL,
        description="必需；节点默认加载 Turbo LoRA，并按 8 步采样。",
        kind="loras",
    ),
]

GJJ_HELP_PAYLOAD = build_node_help_payload(
    description=(
        "把 F2K 图片动作姿势迁移工作流封装为 GJJ 零依赖单节点。"
        "只暴露图片入口和主模型选择；CLIP、VAE、LoRA、提示词、采样器、步数等按源工作流固定。"
    ),
    dependencies=[
        {
            "name": "ComfyUI Flux2 / 自定义采样内置节点",
            "type": "ComfyUI 核心运行环境",
            "required": True,
            "description": "使用 UNETLoader、CLIPLoader、VAELoader、ReferenceLatent、Flux2Scheduler、SamplerCustomAdvanced 等核心节点。",
        },
    ],
    model_tree=MODEL_TREE,
    models=REQUIRED_MODELS,
    usage=[
        "1口必填，2口选填；两个入口都支持 IMAGE 和 GJJ_BATCH_IMAGE。",
        "2口为空时，1口第一张为主体，后面的图片依次作为动作图。",
        "1口、2口都有图时，按主体优先顺序组合输出，例如 a1,a2,a3,b1,b2,b3,c1,c2,c3。",
        "主模型下拉只显示 models/diffusion_models 中匹配 flux-2-klein-9b / f2k 的模型；选择自动匹配会优先使用 flux-2-klein-9b，再回退 f2k。",
    ],
    runtime=[
        "CLIP 固定通过公共模糊搜索匹配 qwen_3_8b。",
        "VAE 固定通过公共模糊搜索匹配 flux2-vae。",
        "Turbo LoRA 固定通过公共模糊搜索匹配 turbo-lora；启用 LoRA 时固定使用 8 步采样。",
    ],
    notice="零第三方自定义节点依赖；模型按模型树放入对应目录后刷新或重启 ComfyUI。",
    extra={
        "model_tree": MODEL_TREE,
        "models": REQUIRED_MODELS,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
    },
)


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    send_node_progress(unique_id, text, progress)


def _unpack(value: Any, index: int = 0) -> Any:
    if isinstance(value, (tuple, list)):
        return value[index] if len(value) > index else None
    args = getattr(value, "args", None)
    if isinstance(args, (tuple, list)):
        return args[index] if len(args) > index else None
    result = getattr(value, "result", None)
    if isinstance(result, (tuple, list)):
        return result[index] if len(result) > index else None
    return value


def _unwrap_single(value: Any) -> Any:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    if isinstance(value, (list, tuple)):
        for item in value:
            if item is not None:
                return _unwrap_single(item)
        return None
    return value


def _node_call(node: Any, *fallback_args: Any, **kwargs: Any) -> tuple[Any, ...]:
    fn_names = (
        getattr(node, "FUNCTION", None),
        "execute",
        "generate",
        "encode",
        "decode",
        "upscale",
        "load_unet",
        "load_clip",
        "load_vae",
        "load_lora_model_only",
    )
    candidates = []
    for name in fn_names:
        if not name or not hasattr(node, name):
            continue
        fn = getattr(node, name)
        if fn not in candidates:
            candidates.append(fn)

    last_error: Exception | None = None
    for fn in candidates:
        try:
            sig = inspect.signature(fn)
            accepted = {
                key: value
                for key, value in kwargs.items()
                if key in sig.parameters
                or any(param.kind == inspect.Parameter.VAR_KEYWORD for param in sig.parameters.values())
            }
            out = fn(**accepted) if accepted else fn(*fallback_args)
            if isinstance(out, tuple):
                return out
            args = getattr(out, "args", None)
            if isinstance(args, tuple):
                return args
            if isinstance(args, list):
                return tuple(args)
            return (out,)
        except TypeError as exc:
            last_error = exc
            try:
                out = fn(*fallback_args)
                if isinstance(out, tuple):
                    return out
                args = getattr(out, "args", None)
                if isinstance(args, tuple):
                    return args
                if isinstance(args, list):
                    return tuple(args)
                return (out,)
            except Exception as fallback_exc:
                last_error = fallback_exc
        except Exception as exc:
            last_error = exc
    if last_error is not None:
        raise last_error
    raise RuntimeError(f"无法调用节点：{node.__class__.__name__}")


def _ensure_image_batch(image: Any, label: str) -> torch.Tensor:
    if image is None:
        raise RuntimeError(f"{label}没有接入图片。")
    if not isinstance(image, torch.Tensor):
        raise RuntimeError(f"{label}需要接入 IMAGE 或 GJJ_BATCH_IMAGE。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise RuntimeError(f"{label}图片维度不支持：{tuple(image.shape)}")
    if int(image.shape[0]) <= 0:
        raise RuntimeError(f"{label}至少需要一张图片。")
    image = image.detach().float()
    channels = int(image.shape[-1])
    if channels == 1:
        image = image.repeat(1, 1, 1, 3)
    elif channels >= 3:
        image = image[..., :3]
    else:
        raise RuntimeError(f"{label}图片通道数不支持：{channels}")
    return image.clamp(0.0, 1.0).contiguous()


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _image_source(value: Any) -> Any:
    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception:
            components = None
        for key in ("images", "frames", "samples"):
            candidate = _component_value(components, key)
            if candidate is not None:
                return candidate
    if isinstance(value, dict):
        for key in ("images", "frames", "samples", "image"):
            candidate = value.get(key)
            if candidate is not None:
                return candidate
    if hasattr(value, "images"):
        candidate = getattr(value, "images", None)
        if candidate is not None:
            return candidate
    return value


def _split_images(value: Any, label: str, required: bool = True) -> list[torch.Tensor]:
    value = _image_source(value)
    if value is None:
        if required:
            raise RuntimeError(f"{label}没有接入图片。")
        return []

    if isinstance(value, (list, tuple)):
        images: list[torch.Tensor] = []
        for item in value:
            images.extend(_split_images(item, label, required=False))
        if required and not images:
            raise RuntimeError(f"{label}没有可用图片。")
        return images

    batch = _ensure_image_batch(value, label)
    return [batch[index : index + 1].contiguous() for index in range(int(batch.shape[0]))]


def _resize_exact(image: torch.Tensor, width: int, height: int, method: str = "area") -> torch.Tensor:
    samples = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(samples, int(width), int(height), str(method or "area"), "disabled")
    return resized.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _scale_to_total_pixels_fallback(image: torch.Tensor) -> torch.Tensor:
    width = max(1, int(image.shape[2]))
    height = max(1, int(image.shape[1]))
    target_pixels = max(0.05, float(SCALE_MEGAPIXELS)) * 1_000_000.0
    scale = (target_pixels / max(1.0, float(width * height))) ** 0.5
    new_width = max(16, int(round(width * scale / 8.0) * 8))
    new_height = max(16, int(round(height * scale / 8.0) * 8))
    if new_width == width and new_height == height:
        return image
    return _resize_exact(image, new_width, new_height, SCALE_METHOD)


def _scale_to_total_pixels(image: torch.Tensor) -> torch.Tensor:
    try:
        from nodes import ImageScaleToTotalPixels

        result = _node_call(
            ImageScaleToTotalPixels(),
            image=image,
            upscale_method=SCALE_METHOD,
            megapixels=float(SCALE_MEGAPIXELS),
            resolution_steps=int(SCALE_RESOLUTION_STEPS),
        )[0]
        if isinstance(result, torch.Tensor):
            return _ensure_image_batch(result, "缩放后的图片")
    except Exception:
        pass
    return _scale_to_total_pixels_fallback(image)


def _normalize_conditioning(conditioning: Any) -> Any:
    if isinstance(conditioning, tuple) and len(conditioning) == 1:
        conditioning = conditioning[0]
    if not isinstance(conditioning, list):
        return conditioning
    fixed = []
    changed = False
    for item in conditioning:
        if isinstance(item, (list, tuple)) and len(item) >= 1:
            meta = dict(item[1]) if len(item) >= 2 and isinstance(item[1], dict) else {}
            fixed.append([item[0], meta])
            changed = True
        elif torch.is_tensor(item):
            fixed.append([item, {}])
            changed = True
        else:
            fixed.append(item)
    return fixed if changed else conditioning


def _set_conditioning_values(conditioning: Any, values: dict[str, Any]) -> Any:
    conditioning = _normalize_conditioning(conditioning)
    if not isinstance(conditioning, list):
        return conditioning
    result = []
    for item in conditioning:
        if isinstance(item, (list, tuple)) and len(item) >= 1:
            meta = dict(item[1]) if len(item) >= 2 and isinstance(item[1], dict) else {}
            meta.update(values)
            result.append([item[0], meta])
        elif torch.is_tensor(item):
            result.append([item, dict(values)])
        else:
            result.append(item)
    return result


def _apply_flux_guidance(conditioning: Any) -> Any:
    return _set_conditioning_values(conditioning, {"guidance": float(GUIDANCE)})


def _append_reference_latent_manual(conditioning: Any, latent: dict[str, torch.Tensor]) -> Any:
    samples = latent.get("samples") if isinstance(latent, dict) else None
    if not torch.is_tensor(samples):
        raise RuntimeError("参考图 VAE 编码失败：latent 中没有 samples。")
    conditioning = _normalize_conditioning(conditioning)
    if not isinstance(conditioning, list):
        return conditioning
    result = []
    for item in conditioning:
        if isinstance(item, (list, tuple)) and len(item) >= 1:
            meta = dict(item[1]) if len(item) >= 2 and isinstance(item[1], dict) else {}
            for key in ("ref_latents", "reference_latents"):
                refs = meta.get(key) or []
                if isinstance(refs, dict) and torch.is_tensor(refs.get("samples")):
                    refs = [refs["samples"]]
                elif torch.is_tensor(refs):
                    refs = [refs]
                elif isinstance(refs, tuple):
                    refs = list(refs)
                elif not isinstance(refs, list):
                    refs = []
                refs.append(samples)
                meta[key] = refs
            result.append([item[0], meta])
        elif torch.is_tensor(item):
            result.append([item, {"ref_latents": [samples], "reference_latents": [samples]}])
        else:
            result.append(item)
    return result


def _append_reference_latent(conditioning: Any, latent: dict[str, torch.Tensor]) -> Any:
    try:
        from nodes import ReferenceLatent

        result = _node_call(
            ReferenceLatent(),
            conditioning=_normalize_conditioning(conditioning),
            latent=latent,
        )[0]
        return _normalize_conditioning(result)
    except Exception:
        return _append_reference_latent_manual(conditioning, latent)


def _compact(value: str) -> str:
    return gjjutils_normalize_text(value)


def _pick_preferred(candidates: list[str], preferred_keywords: tuple[str, ...]) -> str:
    if not candidates:
        return ""
    compact_candidates = [(candidate, _compact(Path(str(candidate).replace("\\", "/")).name)) for candidate in candidates]
    for keyword in preferred_keywords:
        needle = _compact(keyword)
        for candidate, compact_name in compact_candidates:
            if needle and needle in compact_name:
                return candidate
    return candidates[0]


def _filtered_unet_models() -> list[str]:
    return gjjutils_find_model_list(list(UNET_KEYWORDS), "diffusion_models", "OR")


def _unet_choices() -> list[str]:
    models = _filtered_unet_models()
    if not models:
        return [AUTO_UNET, MISSING_UNET]
    preferred = _pick_preferred(models, UNET_KEYWORDS)
    ordered = [AUTO_UNET]
    if preferred:
        ordered.append(preferred)
    for model_name in models:
        if model_name not in ordered:
            ordered.append(model_name)
    return ordered


def _find_model(label: str, folder_type: str, keywords: tuple[str, ...], match_mode: str = "AND") -> str:
    query: str | list[str] = list(keywords) if len(keywords) > 1 else keywords[0]
    candidates = gjjutils_find_model_list(query, folder_type, match_mode)
    if not candidates:
        words = " | ".join(keywords)
        raise RuntimeError(f"未找到{label}：请把匹配 {words} 的模型放入 models/{folder_type} 后刷新 ComfyUI。")
    return _pick_preferred(candidates, keywords)


def _resolve_unet_name(selection: Any) -> str:
    value = str(selection or "").strip()
    if not value or value == AUTO_UNET:
        return _find_model("UNet", "diffusion_models", UNET_KEYWORDS, "OR")
    if value == MISSING_UNET or value.startswith("未找到"):
        return _find_model("UNet", "diffusion_models", UNET_KEYWORDS, "OR")
    return value


def _load_clip(clip_name: str) -> Any:
    try:
        return CLIPLoader().load_clip(clip_name, CLIP_TYPE, CLIP_DEVICE)[0]
    except TypeError:
        return CLIPLoader().load_clip(clip_name, CLIP_TYPE)[0]


def _apply_lora_if_enabled(model: Any) -> tuple[Any, str]:
    if not ENABLE_TURBO_LORA:
        return model, ""
    from nodes import LoraLoaderModelOnly

    lora_name = _find_model("Turbo LoRA", "loras", LORA_KEYWORDS, "AND")
    try:
        model = LoraLoaderModelOnly().load_lora_model_only(model, lora_name, float(LORA_STRENGTH))[0]
    except TypeError:
        model = _node_call(
            LoraLoaderModelOnly(),
            model=model,
            lora_name=lora_name,
            strength_model=float(LORA_STRENGTH),
        )[0]
    return model, lora_name


def _load_pipeline(unet_name: Any = AUTO_UNET, unique_id: Any = None) -> tuple[Any, Any, Any, dict[str, str]]:
    unet_name = _resolve_unet_name(unet_name)
    clip_name = _find_model("CLIP", "text_encoders", CLIP_KEYWORDS, "AND")
    vae_name = _find_model("VAE", "vae", VAE_KEYWORDS, "AND")

    _send_status(unique_id, f"加载 F2K 模型链：{unet_name}", 0.08)
    model = UNETLoader().load_unet(unet_name, UNET_DTYPE)[0]
    model, lora_name = _apply_lora_if_enabled(model)
    clip = _load_clip(clip_name)
    vae = VAELoader().load_vae(vae_name)[0]
    info = {
        "unet": unet_name,
        "clip": clip_name,
        "vae": vae_name,
        "lora": lora_name,
    }
    return model, clip, vae, info


def _run_pair(
    subject_image: torch.Tensor,
    pose_image: torch.Tensor,
    *,
    model: Any,
    clip: Any,
    vae: Any,
    seed: int,
    unique_id: Any,
    label: str,
    progress_start: float,
    progress_end: float,
) -> torch.Tensor:
    span = max(0.0, float(progress_end) - float(progress_start))
    subject_ref = _scale_to_total_pixels(subject_image)
    pose_ref = _scale_to_total_pixels(pose_image)
    width = max(16, int(subject_ref.shape[2]))
    height = max(16, int(subject_ref.shape[1]))

    _send_status(unique_id, f"编码参考图 {label}...", progress_start + span * 0.12)
    subject_latent = VAEEncode().encode(vae, subject_ref)[0]
    pose_latent = VAEEncode().encode(vae, pose_ref)[0]

    conditioning = CLIPTextEncode().encode(clip, PROMPT)[0]
    conditioning = _apply_flux_guidance(conditioning)
    conditioning = _append_reference_latent(conditioning, subject_latent)
    conditioning = _append_reference_latent(conditioning, pose_latent)

    _send_status(unique_id, f"采样生成 {label}...", progress_start + span * 0.34)
    steps = TURBO_STEPS if ENABLE_TURBO_LORA else BASE_STEPS
    latent = EmptyFlux2LatentImage.execute(width, height, 1)[0]
    sigmas = Flux2Scheduler.execute(int(steps), width, height)[0]
    sampler = KSamplerSelect.execute(SAMPLER_NAME)[0]
    noise = RandomNoise.execute(int(seed))[0]
    guider = BasicGuider().execute(model, conditioning)[0]
    sampled = SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, latent)[0]

    _send_status(unique_id, f"解码 {label}...", progress_start + span * 0.86)
    result = VAEDecode().decode(vae, sampled)[0]
    _send_status(unique_id, f"完成 {label}", progress_end)
    return _ensure_image_batch(result, "生成结果")


def _pad_to_size(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    image = _ensure_image_batch(image, "输出图片")
    src_h = int(image.shape[1])
    src_w = int(image.shape[2])
    if src_w == width and src_h == height:
        return image
    canvas = torch.zeros((1, height, width, 3), dtype=image.dtype, device=image.device)
    left = max(0, (width - src_w) // 2)
    top = max(0, (height - src_h) // 2)
    canvas[:, top : top + src_h, left : left + src_w, :] = image[:, : min(src_h, height), : min(src_w, width), :]
    return canvas.clamp(0.0, 1.0).contiguous()


def _merge_results(images: list[torch.Tensor]) -> torch.Tensor:
    if not images:
        raise RuntimeError("没有生成任何图片。")
    normalized = [_ensure_image_batch(image, "输出图片") for image in images]
    max_w = max(int(image.shape[2]) for image in normalized)
    max_h = max(int(image.shape[1]) for image in normalized)
    return torch.cat([_pad_to_size(image, max_w, max_h) for image in normalized], dim=0).contiguous()


class GJJ_F2KMultiImagePoseTransfer:
    NAME = NODE_NAME
    DISPLAY_NAME = NODE_DISPLAY_NAME
    CATEGORY = "GJJ/视频/姿势迁移"
    DESCRIPTION = (
        "把 F2K 图片动作姿势迁移工作流封装为 GJJ 零依赖单节点。"
        "1口必填，2口选填；模型、提示词与采样参数按工作流固定并自动查找。"
    )
    SEARCH_ALIASES = ["F2K姿势迁移", "图片动作迁移", "动作姿势迁移", "pose transfer", "flux2 klein pose"]
    REQUIRED_MODELS = REQUIRED_MODELS
    GJJ_HELP = GJJ_HELP_PAYLOAD

    FUNCTION = "transfer"
    RETURN_TYPES = (MIXED_IMAGE_TYPE,)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = ("姿势迁移后的图片队列。",)
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (False,)

    @classmethod
    def INPUT_TYPES(cls):
        unet_choices = _unet_choices()
        return {
            "required": {
                "image_1": (
                    MIXED_IMAGE_TYPE,
                    {
                        "display_name": "1口 主体/主体+动作",
                        "tooltip": "必填。2口为空时，第一张是主体，后面的图片依次作为动作；2口有图时，这里全部作为主体。",
                    },
                ),
            },
            "optional": {
                "image_2": (
                    MIXED_IMAGE_TYPE,
                    {
                        "display_name": "2口 动作图",
                        "tooltip": "选填。接入后会用 1口 的每个主体依次替换 2口 的每个动作。",
                    },
                ),
                "unet_name": (
                    unet_choices,
                    {
                        "default": unet_choices[0],
                        "display_name": "主模型",
                        "tooltip": "只显示 models/diffusion_models 中匹配 flux-2-klein-9b / f2k 的模型；自动匹配会优先 flux-2-klein-9b，再回退 f2k。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return time.time()

    def transfer(self, image_1, image_2=None, unet_name=AUTO_UNET, unique_id=None):
        unique_id = _unwrap_single(unique_id)
        unet_name = _unwrap_single(unet_name)
        _send_status(unique_id, "准备 F2K 姿势迁移任务...", 0.02)
        subjects_or_mixed = _split_images(image_1, "1口")
        pose_items = _split_images(image_2, "2口", required=False)
        if not pose_items:
            if len(subjects_or_mixed) < 2:
                raise RuntimeError("2口为空时，1口至少需要 2 张图片：第一张为主体，后面的图片作为动作。")
            subjects = [subjects_or_mixed[0]]
            poses = subjects_or_mixed[1:]
        else:
            subjects = subjects_or_mixed
            poses = pose_items

        total = len(subjects) * len(poses)
        if total <= 0:
            raise RuntimeError("没有可处理的主体或动作图片。")

        model, clip, vae, _info = _load_pipeline(unet_name, unique_id)
        base_seed = random.SystemRandom().randint(0, 2**63 - 1)
        results: list[torch.Tensor] = []

        done = 0
        for subject_index, subject in enumerate(subjects, start=1):
            for pose_index, pose in enumerate(poses, start=1):
                done += 1
                label = f"{done}/{total}（主体 {subject_index} / 动作 {pose_index}）"
                progress_start = 0.12 + 0.82 * ((done - 1) / max(1, total))
                progress_end = 0.12 + 0.82 * (done / max(1, total))
                results.append(
                    _run_pair(
                        subject,
                        pose,
                        model=model,
                        clip=clip,
                        vae=vae,
                        seed=base_seed + done - 1,
                        unique_id=unique_id,
                        label=label,
                        progress_start=progress_start,
                        progress_end=progress_end,
                    )
                )

        merged = _merge_results(results)
        _send_status(unique_id, f"完成：输出 {int(merged.shape[0])} 张图片。", 1.0)
        return (merged,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_F2KMultiImagePoseTransfer}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
