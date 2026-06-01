from __future__ import annotations

from typing import Any

import torch
import folder_paths
import comfy.samplers
import comfy.utils
from nodes import ImageInvert, PreviewImage, UNETLoader, VAEDecode, VAEEncode, VAELoader
from comfy_extras.nodes_custom_sampler import (
    BasicGuider,
    BasicScheduler,
    DisableNoise,
    KSamplerSelect,
    SamplerCustomAdvanced,
    SetFirstSigma,
)
from comfy_extras.nodes_lotus import LotusConditioning

from .common_utils.dependency_checker import make_missing_model_spec, raise_dependency_model_error
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_LotusDepthMap"
NODE_DISPLAY_NAME = "GJJ · 🕳️ Lotus深度图"
DEFAULT_UNET = "lotus-depth-d-v1-1.safetensors"
DEFAULT_VAE = "vae-ft-mse-840000-ema-pruned.safetensors"
LOTUS_MODEL_URL = "https://huggingface.co/Comfy-Org/lotus/resolve/main/lotus-depth-d-v1-1.safetensors"
VAE_MODEL_URL = "https://huggingface.co/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors"
DESCRIPTION = (
    "把官方 Lotus Depth 工作流封装为 GJJ 零依赖单节点，输入图片或批量图片，输出可预览的深度图队列。\n\n"
    f"🌏模型下载：\nLotus Depth UNET：{LOTUS_MODEL_URL}\nSD VAE MSE：{VAE_MODEL_URL}"
)


def _model_spec(label: str, folder: str, filename: str, description: str, url: str = "") -> dict[str, str]:
    spec = make_missing_model_spec(label=label, subdir=f"models/{folder}", filename=filename, description=description)
    spec["folder"] = folder
    spec["value"] = filename
    if url:
        spec["download_url"] = url
    return spec


REQUIRED_MODELS = [
    _model_spec(
        "Lotus Depth UNET",
        "diffusion_models",
        DEFAULT_UNET,
        "官方 Lotus 深度扩散模型，工作流中的 UNETLoader 使用此文件。",
        LOTUS_MODEL_URL,
    ),
    _model_spec(
        "SD VAE MSE",
        "vae",
        DEFAULT_VAE,
        "官方工作流使用的 VAE，用于把输入图像编码到 latent 并解码深度图。",
        VAE_MODEL_URL,
    ),
]


def _safe_filename_list(category: str) -> list[str]:
    try:
        return [str(item) for item in folder_paths.get_filename_list(category)]
    except Exception:
        return []


def _with_preferred(values: list[str], preferred: str) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in [preferred, *values]:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result or [preferred]


def _basename(value: str) -> str:
    return str(value or "").replace("\\", "/").rsplit("/", 1)[-1]


def _resolve_model(category: str, requested: str, spec: dict[str, str], unique_id: Any = None) -> str:
    raw = str(requested or spec.get("filename") or "").strip()
    available = _safe_filename_list(category)
    raw_key = raw.replace("\\", "/").lower()
    raw_base = _basename(raw).lower()

    for candidate in available:
        if candidate.replace("\\", "/").lower() == raw_key:
            return candidate
    for candidate in available:
        if _basename(candidate).lower() == raw_base:
            return candidate
    try:
        if raw and folder_paths.get_full_path(category, raw):
            return raw
    except Exception:
        pass

    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[spec],
        description="Lotus 深度图节点需要官方 Lotus Depth UNET 与 VAE；请把模型放入模型树对应目录后重启或刷新 ComfyUI。",
        unique_id=unique_id,
        model_download_url=LOTUS_MODEL_URL,
        title="GJJ Lotus 深度图缺少模型",
    )
    return raw


def _node_result(value: Any) -> tuple[Any, ...]:
    if hasattr(value, "result"):
        result = getattr(value, "result")
        return tuple(result if isinstance(result, (tuple, list)) else (result,))
    if isinstance(value, tuple):
        return value
    if isinstance(value, list):
        return tuple(value)
    return (value,)


def _unwrap_param(value: Any, default: Any = None) -> Any:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    if isinstance(value, (list, tuple)):
        value = value[0] if value else default
    return default if value is None else value


def _as_int_param(value: Any, default: int = 0) -> int:
    try:
        return int(_unwrap_param(value, default))
    except Exception:
        return int(default)


def _as_float_param(value: Any, default: float = 0.0) -> float:
    try:
        return float(_unwrap_param(value, default))
    except Exception:
        return float(default)


def _as_bool_param(value: Any, default: bool = False) -> bool:
    raw = _unwrap_param(value, default)
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "on", "开启", "启用", "是"}
    return bool(raw)


def _split_image_source(value: Any, seen: set[int] | None = None) -> list[torch.Tensor]:
    if value is None:
        return []
    if seen is None:
        seen = set()
    value_id = id(value)
    if value_id in seen:
        return []
    seen.add(value_id)

    if isinstance(value, torch.Tensor):
        tensor = value
        if tensor.ndim == 3:
            tensor = tensor.unsqueeze(0)
        if tensor.ndim != 4:
            return []
        return [tensor[index:index + 1].detach().float().contiguous() for index in range(int(tensor.shape[0]))]

    if isinstance(value, dict):
        images: list[torch.Tensor] = []
        for key in ("images", "image", "frames", "batch", "items", "values"):
            if key in value:
                images.extend(_split_image_source(value.get(key), seen))
        return images

    if isinstance(value, (list, tuple, set)):
        images: list[torch.Tensor] = []
        for item in value:
            images.extend(_split_image_source(item, seen))
        return images

    return []


def _ensure_rgb_image(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise RuntimeError("Lotus 深度图输入必须是 IMAGE 或 GJJ_BATCH_IMAGE。")
    tensor = image.detach().float()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"Lotus 深度图输入维度无效：{tuple(tensor.shape)}")
    channels = int(tensor.shape[-1])
    if channels == 3:
        rgb = tensor
    elif channels == 4:
        alpha = tensor[..., 3:4].clamp(0.0, 1.0)
        rgb = tensor[..., :3] * alpha
    elif channels == 1:
        rgb = tensor.repeat(1, 1, 1, 3)
    elif channels > 4:
        rgb = tensor[..., :3]
    else:
        raise RuntimeError(f"Lotus 深度图不支持 {channels} 通道图像。")
    return torch.nan_to_num(rgb, nan=0.0, posinf=1.0, neginf=0.0).clamp(0.0, 1.0).contiguous()


def _resize_to_shape(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    if int(image.shape[1]) == int(height) and int(image.shape[2]) == int(width):
        return image.contiguous()
    chw = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(chw, int(width), int(height), "lanczos", "disabled")
    return resized.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _preview_item_from_image_entry(entry: dict[str, Any], index: int, image: torch.Tensor) -> dict[str, Any]:
    height = int(image.shape[1]) if image.ndim == 4 else 0
    width = int(image.shape[2]) if image.ndim == 4 else 0
    return {
        "kind": "image",
        "title": f"深度图 {index}",
        "filename": str(entry.get("filename") or ""),
        "subfolder": str(entry.get("subfolder") or ""),
        "type": str(entry.get("type") or "temp"),
        "width": width,
        "height": height,
        "description": f"Lotus 深度图 {index} · {width}x{height}",
    }


class GJJ_LotusDepthMap:
    INPUT_IS_LIST = True
    CATEGORY = "GJJ/图像/深度"
    FUNCTION = "generate_depth"
    DESCRIPTION = DESCRIPTION
    SEARCH_ALIASES = ["Lotus Depth", "depth map", "深度图", "深度无依赖", "GJJ_BATCH_IMAGE"]
    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE",)
    RETURN_NAMES = ("深度图队列",)
    OUTPUT_TOOLTIPS = ("Lotus 生成的深度图列表；支持不同尺寸，兼容 GJJ_BATCH_IMAGE 与 IMAGE 连接。",)
    OUTPUT_IS_LIST = (True,)
    OUTPUT_NODE = True
    REQUIRED_MODELS = REQUIRED_MODELS
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": DESCRIPTION,
        "model_tree": True,
        "model_download_url": LOTUS_MODEL_URL,
        "models": REQUIRED_MODELS,
        "dependencies": [
            "ComfyUI 官方节点：UNETLoader / VAELoader / LotusConditioning / BasicGuider / BasicScheduler / SamplerCustomAdvanced / VAEDecode / ImageInvert",
            "无第三方自定义节点依赖。",
        ],
        "usage": [
            "输入支持普通 IMAGE batch、GJJ_BATCH_IMAGE 列表和不同尺寸图片队列。",
            "节点会逐张解包运行，输出保持为 GJJ_BATCH_IMAGE 深度图列表。",
            "执行后面板内会显示 GJJ 自定义深度图预览，不再追加 ComfyUI 原生重复预览。",
        ],
    }

    def __init__(self):
        self.preview_image = PreviewImage()
        self._cache_key: tuple[str, str, str] | None = None
        self._cached_model = None
        self._cached_vae = None

    @classmethod
    def INPUT_TYPES(cls):
        unets = _with_preferred(_safe_filename_list("diffusion_models"), DEFAULT_UNET)
        vaes = _with_preferred(_safe_filename_list("vae"), DEFAULT_VAE)
        samplers = list(getattr(comfy.samplers, "SAMPLER_NAMES", ["euler"])) or ["euler"]
        schedulers = list(getattr(comfy.samplers, "SCHEDULER_NAMES", ["normal"])) or ["normal"]
        return {
            "required": {
                "images": (
                    f"{GJJ_BATCH_IMAGE_TYPE},IMAGE",
                    {
                        "display_name": "输入图片",
                        "tooltip": "支持 IMAGE、IMAGE batch、GJJ_BATCH_IMAGE 列表；不同尺寸会逐张解包处理。",
                    },
                ),
                "unet_name": (
                    unets,
                    {
                        "default": DEFAULT_UNET if DEFAULT_UNET in unets else unets[0],
                        "display_name": "Lotus模型",
                        "tooltip": "官方 Lotus Depth UNET，默认 lotus-depth-d-v1-1.safetensors，放在 models/diffusion_models。",
                    },
                ),
                "vae_name": (
                    vaes,
                    {
                        "default": DEFAULT_VAE if DEFAULT_VAE in vaes else vaes[0],
                        "display_name": "VAE模型",
                        "tooltip": "官方工作流使用的 VAE，默认 vae-ft-mse-840000-ema-pruned.safetensors，放在 models/vae。",
                    },
                ),
                "weight_dtype": (
                    ["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"],
                    {
                        "default": "default",
                        "display_name": "UNET精度",
                        "tooltip": "传给官方 UNETLoader 的 weight_dtype。官方工作流默认 default。",
                    },
                ),
                "sampler_name": (
                    samplers,
                    {
                        "default": "euler" if "euler" in samplers else samplers[0],
                        "display_name": "采样器",
                        "tooltip": "传给官方 KSamplerSelect。官方工作流默认 euler。",
                    },
                ),
                "scheduler": (
                    schedulers,
                    {
                        "default": "normal" if "normal" in schedulers else schedulers[0],
                        "display_name": "调度器",
                        "tooltip": "传给官方 BasicScheduler。官方工作流默认 normal。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 10000,
                        "display_name": "步数",
                        "tooltip": "官方工作流为 1 步。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0001,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪",
                        "tooltip": "传给官方 BasicScheduler。官方工作流默认 1.0；0 会让官方 SetFirstSigma 无可用 sigma。",
                    },
                ),
                "first_sigma": (
                    "FLOAT",
                    {
                        "default": 10000.0,
                        "min": 0.0,
                        "max": 20000.0,
                        "step": 0.001,
                        "display_name": "首个Sigma",
                        "tooltip": "传给官方 SetFirstSigma。官方工作流默认 10000。",
                    },
                ),
                "invert_depth": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "反相深度",
                        "tooltip": "开启时执行官方 ImageInvert，与提供的 workflow 保持一致。",
                    },
                ),
                "keep_size": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "保持原尺寸",
                        "tooltip": "若 VAE 解码尺寸与输入略有差异，自动缩放回原图宽高。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def _load_models(self, unet_name: str, weight_dtype: str, vae_name: str, unique_id: Any = None):
        resolved_unet = _resolve_model("diffusion_models", unet_name, REQUIRED_MODELS[0], unique_id)
        resolved_vae = _resolve_model("vae", vae_name, REQUIRED_MODELS[1], unique_id)
        cache_key = (resolved_unet, str(weight_dtype or "default"), resolved_vae)
        if self._cache_key == cache_key and self._cached_model is not None and self._cached_vae is not None:
            return self._cached_model, self._cached_vae, resolved_unet, resolved_vae
        model = UNETLoader().load_unet(resolved_unet, str(weight_dtype or "default"))[0]
        vae = VAELoader().load_vae(resolved_vae)[0]
        self._cache_key = cache_key
        self._cached_model = model
        self._cached_vae = vae
        return model, vae, resolved_unet, resolved_vae

    def _run_single_depth(
        self,
        image: torch.Tensor,
        *,
        model: Any,
        vae: Any,
        sampler: Any,
        conditioning: Any,
        scheduler: str,
        steps: int,
        denoise: float,
        first_sigma: float,
        invert_depth: bool,
        keep_size: bool,
    ) -> torch.Tensor:
        image = _ensure_rgb_image(image)
        original_height = int(image.shape[1])
        original_width = int(image.shape[2])
        noise = _node_result(DisableNoise().execute())[0]
        guider = _node_result(BasicGuider().execute(model, conditioning))[0]
        safe_denoise = max(0.0001, min(1.0, float(denoise)))
        sigmas = _node_result(BasicScheduler().execute(model, scheduler, int(steps), safe_denoise))[0]
        sigmas = _node_result(SetFirstSigma().execute(sigmas, float(first_sigma)))[0]
        latent = VAEEncode().encode(vae, image)[0]
        sampled = _node_result(SamplerCustomAdvanced().execute(noise, guider, sampler, sigmas, latent))[0]
        decoded = VAEDecode().decode(vae, sampled)[0]
        if invert_depth:
            decoded = ImageInvert().invert(decoded)[0]
        decoded = _ensure_rgb_image(decoded)
        if keep_size:
            decoded = _resize_to_shape(decoded, original_width, original_height)
        return decoded.detach().float().cpu().clamp(0.0, 1.0).contiguous()

    def _save_previews(self, images: list[torch.Tensor], prompt=None, extra_pnginfo=None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        preview_entries: list[dict[str, Any]] = []
        preview_items: list[dict[str, Any]] = []
        for index, image in enumerate(images, start=1):
            ui = self.preview_image.save_images(
                image,
                filename_prefix="GJJ_LotusDepth",
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            entries = list(ui.get("ui", {}).get("images", []) or [])
            preview_entries.extend(entries)
            if entries:
                preview_items.append(_preview_item_from_image_entry(entries[-1], index, image))
        return preview_entries, preview_items

    def generate_depth(
        self,
        images,
        unet_name=DEFAULT_UNET,
        vae_name=DEFAULT_VAE,
        weight_dtype="default",
        sampler_name="euler",
        scheduler="normal",
        steps=1,
        denoise=1.0,
        first_sigma=10000.0,
        invert_depth=True,
        keep_size=True,
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        unet_name = str(_unwrap_param(unet_name, DEFAULT_UNET) or DEFAULT_UNET)
        vae_name = str(_unwrap_param(vae_name, DEFAULT_VAE) or DEFAULT_VAE)
        weight_dtype = str(_unwrap_param(weight_dtype, "default") or "default")
        sampler_name = str(_unwrap_param(sampler_name, "euler") or "euler")
        scheduler = str(_unwrap_param(scheduler, "normal") or "normal")
        steps_value = max(1, _as_int_param(steps, 1))
        denoise_value = max(0.0001, min(1.0, _as_float_param(denoise, 1.0)))
        first_sigma_value = _as_float_param(first_sigma, 10000.0)
        invert_depth_value = _as_bool_param(invert_depth, True)
        keep_size_value = _as_bool_param(keep_size, True)
        prompt = _unwrap_param(prompt)
        extra_pnginfo = _unwrap_param(extra_pnginfo)
        unique_id = _unwrap_param(unique_id)

        input_images = [_ensure_rgb_image(image) for image in _split_image_source(images)]
        if not input_images:
            raise RuntimeError("Lotus 深度图没有收到有效图片，请连接 IMAGE 或 GJJ_BATCH_IMAGE。")

        model, vae, resolved_unet, resolved_vae = self._load_models(unet_name, weight_dtype, vae_name, unique_id)
        conditioning = _node_result(LotusConditioning().execute())[0]
        sampler = _node_result(KSamplerSelect().execute(sampler_name))[0]

        output_images: list[torch.Tensor] = []
        for image in input_images:
            output_images.append(
                self._run_single_depth(
                    image,
                    model=model,
                    vae=vae,
                    sampler=sampler,
                    conditioning=conditioning,
                    scheduler=scheduler,
                    steps=steps_value,
                    denoise=denoise_value,
                    first_sigma=first_sigma_value,
                    invert_depth=invert_depth_value,
                    keep_size=keep_size_value,
                )
            )

        _preview_entries, preview_items = self._save_previews(output_images, prompt=prompt, extra_pnginfo=extra_pnginfo)
        count = len(output_images)
        summary = (
            f"Lotus 深度图完成：{count} 张；"
            f"模型 {resolved_unet}；VAE {resolved_vae}；"
            f"{steps_value} 步 / {scheduler} / {sampler_name} / sigma {first_sigma_value:g}"
        )
        return {
            "ui": {
                "preview_items": preview_items,
                "preview_text": [summary],
                "preview_kind": ["image"],
                "depth_count": [count],
            },
            "result": (output_images,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LotusDepthMap}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
