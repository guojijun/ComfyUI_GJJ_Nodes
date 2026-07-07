from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageFilter

from .common_utils.model_family import (
    gjjutils_model_family_pick_lora_name,
    gjjutils_model_family_pick_model_name,
)
from .common_utils.dependency_checker import (
    build_dependency_model_report,
    send_dependency_model_notice,
)
from .common_utils.temp_files import gjjutils_write_temp_pil_image
from .gjj_lazy_image_studio import (
    DEFAULT_CLIP_NAME,
    DEFAULT_UNET_DTYPE,
    DEFAULT_UNET_NAME,
    DEFAULT_VAE_NAME,
    GJJ_LazyImageStudio,
    UNET_DTYPE_OPTIONS,
    _list_lazy_clip_models,
    _list_lazy_unet_models,
)
from .gjj_model_bundle_loader import list_vae_models
from .gjj_model_upscaler import GJJ_ModelUpscaler, _list_pth_upscale_models
from .gjj_batch_outpaint import (
    _decode_vae,
    _ksampler,
    _normalize_conditioning,
    _node_call,
    _qwen_image_edit_encode,
    _try_import,
)


NODE_NAME = "GJJ_360PanoramaGenerator"
IMAGE_INPUT_TYPE = "GJJ_BATCH__IMAGE,GJJ_BATCH_IMAGE,IMAGE"

DEFAULT_UNET = "qwen_image_edit_2511_fp8mixed.safetensors"
DEFAULT_CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
DEFAULT_VAE = "qwen_image_vae.safetensors"
DEFAULT_LIGHTNING_LORA = "QWEN\\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
DEFAULT_360_LORA = "QWEN\\251018_MICKMUMPITZ_QWEN-EDIT_360_03.safetensors"
DEFAULT_UPSCALE_MODEL = "RealESRGAN_x2plus.pth"
GGUF_PACKAGE_SPEC = "gguf>=0.13.0"
DEFAULT_PROMPT_SUFFIX = (
    "Create a 360-degree panoramic image. Capture an ultra-wide, high-definition "
    "environmental image using equirectangular projection. Maintain the original aesthetic."
)
DEFAULT_SEAM_PROMPT = "Remove the visible seam in the middle of the image. Remove the white bar. Keep the rest of the image exactly the same."

MODEL_TREE = [
    {
        "label": "Qwen Image Edit 2511 UNET",
        "path": "models/diffusion_models",
        "filename": DEFAULT_UNET,
        "required": True,
        "description": "360 全景主生成使用的 Qwen Image Edit 扩散模型。",
    },
    {
        "label": "Qwen 2.5 VL 文本编码器",
        "path": "models/text_encoders",
        "filename": DEFAULT_CLIP,
        "required": True,
        "description": "Qwen Image Edit 使用的文本编码器；部分 ComfyUI 配置也可能放在 models/clip。",
    },
    {
        "label": "Qwen Image VAE",
        "path": "models/vae",
        "filename": DEFAULT_VAE,
        "required": True,
        "description": "Qwen Image 系列 VAE。",
    },
    {
        "label": "Qwen Image Edit Lightning LoRA",
        "path": "models/loras/QWEN",
        "filename": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
        "required": True,
        "description": "4 步 Lightning 加速 LoRA。",
    },
    {
        "label": "Qwen 360 全景 LoRA",
        "path": "models/loras/QWEN",
        "filename": "251018_MICKMUMPITZ_QWEN-EDIT_360_03.safetensors",
        "required": True,
        "description": "360 全景风格/投影辅助 LoRA。",
    },
    {
        "label": "RealESRGAN x2 放大模型",
        "path": "models/upscale_models",
        "filename": DEFAULT_UPSCALE_MODEL,
        "required": False,
        "description": "可选。启用模型放大时使用；找不到时节点会回退普通缩放。",
    },
]


def _hidden_widget(options: dict[str, Any]) -> dict[str, Any]:
    result = dict(options)
    result["hidden"] = True
    result["display"] = "hidden"
    return result


def _send_status(unique_id: Any, text: str, progress: float | None = None, **extra: Any) -> None:
    if unique_id is None or str(unique_id).strip() == "":
        return
    try:
        from server import PromptServer

        payload: dict[str, Any] = {"node": str(unique_id), "text": str(text or "").strip() or "处理中..."}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        for key, value in extra.items():
            if value is not None:
                payload[str(key)] = value
        PromptServer.instance.send_sync(
            "gjj_node_progress",
            payload,
        )
    except Exception:
        pass


def _send_preview(unique_id: Any, image: torch.Tensor, stage: str) -> list[dict[str, str]]:
    if not isinstance(image, torch.Tensor):
        return []
    try:
        preview = _ensure_bhwc_rgb(image)[:1].detach().float().clamp(0.0, 1.0).cpu()[0]
        array = (preview.numpy() * 255.0).round().astype(np.uint8)
        item = gjjutils_write_temp_pil_image(Image.fromarray(array, "RGB"), format="PNG", suffix=".png")
        if unique_id is not None and str(unique_id).strip():
            from server import PromptServer

            PromptServer.instance.send_sync(
                "gjj_360_panorama_preview",
                {"node": str(unique_id), "stage": str(stage or ""), "image": item},
            )
        return [item]
    except Exception as exc:
        print(f"[GJJ 360PanoramaGenerator] 预览保存失败: {exc}")
        return []


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    preview = _ensure_bhwc_rgb(image)[:1].detach().float().clamp(0.0, 1.0).cpu()[0]
    array = (preview.numpy() * 255.0).round().astype(np.uint8)
    return Image.fromarray(array, "RGB")


def _decode_data_url_image(data_url: str) -> torch.Tensor | None:
    text = str(data_url or "").strip()
    if not text:
        return None
    if "," in text and text.lower().startswith("data:image/"):
        text = text.split(",", 1)[1]
    payload = base64.b64decode(text, validate=False)
    with Image.open(io.BytesIO(payload)) as image:
        image = image.convert("RGB")
        array = np.asarray(image).astype(np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0).contiguous()


def _load_input_image_reference(data: dict[str, Any]) -> torch.Tensor | None:
    filename = str(data.get("filename") or data.get("name") or data.get("file") or "").strip()
    if not filename:
        return None
    subfolder = str(data.get("subfolder") or "").strip().strip("/\\")
    image_type = str(data.get("type") or "input").strip().lower()
    if image_type and image_type != "input":
        return None

    input_root = Path(folder_paths.get_input_directory()).resolve()
    candidate = (input_root / subfolder / filename).resolve() if subfolder else (input_root / filename).resolve()
    try:
        candidate.relative_to(input_root)
    except ValueError:
        return None
    if not candidate.is_file():
        annotated = f"{subfolder}/{filename}" if subfolder else filename
        if folder_paths.exists_annotated_filepath(annotated):
            candidate = Path(folder_paths.get_annotated_filepath(annotated)).resolve()
        else:
            return None
    with Image.open(candidate) as image:
        image = image.convert("RGB")
        array = np.asarray(image).astype(np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0).contiguous()


def _decode_current_view_image(view_data: str) -> torch.Tensor | None:
    text = str(view_data or "").strip()
    if not text:
        return None
    if text.lower().startswith("data:image/"):
        return _decode_data_url_image(text)
    try:
        data = json.loads(text)
    except Exception:
        return None
    if isinstance(data, dict):
        return _load_input_image_reference(data)
    return None


def _render_view_from_panorama(panorama: torch.Tensor, view_data: str) -> torch.Tensor | None:
    text = str(view_data or "").strip()
    if not text or text.lower().startswith("data:image/"):
        return None
    try:
        data = json.loads(text)
    except Exception:
        return None
    tensor = _ensure_bhwc_rgb(panorama)[:1].detach().float().clamp(0.0, 1.0)
    device = tensor.device
    dtype = tensor.dtype
    source = tensor.movedim(-1, 1)
    output_width = max(64, min(4096, int(float(data.get("width", 1024) or 1024))))
    output_height = max(64, min(4096, int(float(data.get("height", 640) or 640))))
    yaw = float(data.get("yaw", 0.0) or 0.0)
    pitch = float(data.get("pitch", 0.0) or 0.0)
    fov = max(0.05, min(float(data.get("fov", np.pi / 2.2) or np.pi / 2.2), np.pi * 0.98))
    ys = torch.linspace(0.5, output_height - 0.5, output_height, device=device, dtype=dtype)
    xs = torch.linspace(0.5, output_width - 0.5, output_width, device=device, dtype=dtype)
    yy, xx = torch.meshgrid(ys, xs, indexing="ij")
    aspect = float(output_width) / max(1.0, float(output_height))
    tan_fov = float(np.tan(fov / 2.0))
    dx = ((xx / float(output_width)) * 2.0 - 1.0) * tan_fov * aspect
    dy = (1.0 - (yy / float(output_height)) * 2.0) * tan_fov
    dz = torch.full_like(dx, -1.0)
    inv_len = torch.rsqrt(dx * dx + dy * dy + dz * dz)
    dx = dx * inv_len
    dy = dy * inv_len
    dz = dz * inv_len
    cy = float(np.cos(yaw))
    sy = float(np.sin(yaw))
    cp = float(np.cos(pitch))
    sp = float(np.sin(pitch))
    dy2 = dy * cp - dz * sp
    dz2 = dy * sp + dz * cp
    dx3 = dx * cy + dz2 * sy
    dz3 = -dx * sy + dz2 * cy
    lon = torch.atan2(dx3, -dz3)
    lat = torch.asin(dy2.clamp(-1.0, 1.0))
    grid_x = lon / np.pi
    grid_y = -2.0 * lat / np.pi
    grid = torch.stack((grid_x, grid_y), dim=-1).unsqueeze(0)
    sampled = torch.nn.functional.grid_sample(
        source,
        grid,
        mode="bilinear",
        padding_mode="border",
        align_corners=True,
    )
    return sampled.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _save_output_image(image: torch.Tensor, save_directory: str, prefix: str = "GJJ_360") -> str:
    raw = str(save_directory or "").strip().strip('"')
    if not raw:
        return ""
    path = Path(os.path.expandvars(os.path.expanduser(raw)))
    if not path.is_absolute():
        path = Path(folder_paths.get_output_directory()) / path
    path.mkdir(parents=True, exist_ok=True)
    filename = f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.png"
    final_path = path / filename
    _tensor_to_pil(image).save(final_path, "PNG", compress_level=4)
    return str(final_path)


def _first_scalar(value: Any) -> Any:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    return value


def _ensure_bhwc_rgb(image: torch.Tensor) -> torch.Tensor:
    tensor = image.detach().float().clamp(0.0, 1.0)
    if tensor.ndim == 3:
        if int(tensor.shape[-1]) in (1, 3, 4):
            tensor = tensor.unsqueeze(0)
        elif int(tensor.shape[0]) in (1, 3, 4):
            tensor = tensor.movedim(0, -1).unsqueeze(0)
        else:
            raise RuntimeError(f"图片维度不支持：{tuple(tensor.shape)}")
    if tensor.ndim != 4:
        raise RuntimeError(f"图片维度不支持：{tuple(tensor.shape)}")
    if int(tensor.shape[-1]) not in (1, 3, 4) and int(tensor.shape[1]) in (1, 3, 4):
        tensor = tensor.movedim(1, -1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels > 3:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"图片通道数不支持：{channels}")
    return tensor.contiguous()


def _resize_exact(image: torch.Tensor, width: int, height: int, mode: str = "bilinear") -> torch.Tensor:
    return torch.nn.functional.interpolate(
        _ensure_bhwc_rgb(image).movedim(-1, 1),
        size=(int(height), int(width)),
        mode=mode,
        align_corners=False if mode in {"bilinear", "bicubic"} else None,
        antialias=True if mode in {"bilinear", "bicubic"} else False,
    ).movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _resize_fit_pad(image: torch.Tensor, width: int, height: int, color: float = 0.5) -> torch.Tensor:
    tensor = _ensure_bhwc_rgb(image)[:1]
    source_h = int(tensor.shape[1])
    source_w = int(tensor.shape[2])
    scale = min(float(width) / max(1, source_w), float(height) / max(1, source_h))
    new_w = max(1, min(int(width), int(round(source_w * scale))))
    new_h = max(1, min(int(height), int(round(source_h * scale))))
    resized = _resize_exact(tensor, new_w, new_h)
    canvas = torch.full((1, int(height), int(width), 3), float(color), dtype=resized.dtype, device=resized.device)
    top = max(0, (int(height) - new_h) // 2)
    left = max(0, (int(width) - new_w) // 2)
    canvas[:, top : top + new_h, left : left + new_w, :] = resized
    return canvas.contiguous()


def _center_crop(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    tensor = _ensure_bhwc_rgb(image)
    h = int(tensor.shape[1])
    w = int(tensor.shape[2])
    left = max(0, (w - int(width)) // 2)
    top = max(0, (h - int(height)) // 2)
    return tensor[:, top : top + int(height), left : left + int(width), :].contiguous()


def _horizontal_center_wrap(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    tensor = _ensure_bhwc_rgb(image)
    if int(tensor.shape[2]) != int(width) or int(tensor.shape[1]) != int(height):
        tensor = _resize_exact(tensor, int(width), int(height))
    doubled = torch.cat([tensor, tensor], dim=2)
    return _center_crop(doubled, int(width), int(height))


def _blur_mask(mask: torch.Tensor, radius: int) -> torch.Tensor:
    if int(radius) <= 0:
        return mask.float().clamp(0.0, 1.0)
    device = mask.device
    dtype = mask.dtype
    blurred = []
    for item in mask.detach().float().cpu():
        array = (item.clamp(0.0, 1.0).numpy() * 255.0).round().astype(np.uint8)
        image = Image.fromarray(array, "L").filter(ImageFilter.GaussianBlur(radius=float(radius)))
        blurred.append(torch.from_numpy(np.asarray(image).astype(np.float32) / 255.0))
    return torch.stack(blurred, dim=0).to(device=device, dtype=dtype).clamp(0.0, 1.0)


def _split_optional_image(value: Any) -> torch.Tensor | None:
    value = _first_scalar(value)
    if value is None or not isinstance(value, torch.Tensor):
        return None
    return _ensure_bhwc_rgb(value)[:1].contiguous()


def _image_fingerprint(image: torch.Tensor | None) -> str:
    if not isinstance(image, torch.Tensor):
        return ""
    with torch.no_grad():
        tensor = _ensure_bhwc_rgb(image).detach().float().cpu()
        shape = tuple(int(dim) for dim in tensor.shape)
        flat = tensor.reshape(-1)
        if flat.numel() == 0:
            return f"{shape}:empty"
        step = max(1, flat.numel() // 65536)
        sample = flat[::step][:65536].contiguous()
        digest = hashlib.sha256(sample.numpy().tobytes()).hexdigest()[:20]
        return f"{shape}:{sample.numel()}:{digest}"


def _make_lora_data(lora_1: str, strength_1: float, lora_2: str, strength_2: float) -> str:
    rows: list[dict[str, Any]] = []
    if str(lora_1 or "").strip():
        rows.append({"enabled": True, "name": str(lora_1), "strength": float(strength_1)})
    if str(lora_2 or "").strip():
        rows.append({"enabled": True, "name": str(lora_2), "strength": float(strength_2)})
    return json.dumps(rows, ensure_ascii=False)


def _list_loras() -> list[str]:
    try:
        return [str(item) for item in folder_paths.get_filename_list("loras")]
    except Exception:
        return []


def _with_suffix(prompt: str, suffix: str) -> str:
    prompt = str(prompt or "").strip()
    suffix = str(suffix or "").strip()
    if prompt and suffix:
        return f"{prompt}\n\n{suffix}"
    return prompt or suffix


def _is_gguf_model(name: Any) -> bool:
    return str(name or "").replace("\\", "/").lower().endswith(".gguf")


def _gguf_version_ok(version: str) -> bool:
    parts = []
    for item in str(version or "0").split(".")[:3]:
        try:
            parts.append(int("".join(ch for ch in item if ch.isdigit()) or "0"))
        except Exception:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts) >= (0, 13, 0)


def _check_gguf_dependency_for_selected_models(unet_name: str, clip_name: str, unique_id: Any) -> None:
    selected = []
    if _is_gguf_model(unet_name):
        selected.append(("UNET", unet_name))
    if _is_gguf_model(clip_name):
        selected.append(("CLIP", clip_name))
    if not selected:
        return
    original_error = ""
    try:
        import gguf  # type: ignore

        version = str(getattr(gguf, "__version__", "0") or "0")
        if _gguf_version_ok(version):
            return
        original_error = f"当前 gguf 版本为 {version}，需要 {GGUF_PACKAGE_SPEC}。"
    except Exception as exc:
        original_error = str(exc) or "No module named 'gguf'"
    model_text = "，".join(f"{kind}: {name}" for kind, name in selected)
    report = build_dependency_model_report(
        node_name="GJJ_360PanoramaGenerator",
        missing_dependencies=[
            {
                "module_name": "gguf",
                "package_name": GGUF_PACKAGE_SPEC,
                "display_name": GGUF_PACKAGE_SPEC,
                "description": f"加载 GGUF 模型需要此依赖。已选择：{model_text}",
            }
        ],
        install_packages=[GGUF_PACKAGE_SPEC],
        description="检测到当前节点选择了 GGUF 模型，但 ComfyUI Python 缺少可用的 gguf 依赖。",
        original_error=original_error,
    )
    send_dependency_model_notice(report, unique_id=unique_id)
    raise RuntimeError(
        f"检测到 GGUF 模型：{model_text}\n"
        f"当前 ComfyUI Python 缺少 gguf 依赖，请点击节点提示里的复制按钮安装 {GGUF_PACKAGE_SPEC} 后重启 ComfyUI。"
    )


def _qwen_image_edit_encode_with_vae(clip: Any, vae: Any, image: torch.Tensor, prompt: str) -> Any:
    TextEncodeQwenImageEditPlus = _try_import(
        "TextEncodeQwenImageEditPlus", ("nodes", "comfy_extras.nodes_qwen_image")
    )
    if TextEncodeQwenImageEditPlus is not None:
        try:
            return _normalize_conditioning(
                _node_call(
                    TextEncodeQwenImageEditPlus(),
                    clip=clip,
                    vae=vae,
                    image1=image,
                    prompt=str(prompt or ""),
                )[0]
            )
        except Exception as exc:
            print(f"[GJJ 360PanoramaGenerator] QwenImageEditPlus 接 VAE 编码失败，回退兼容路径：{exc}")
    return _qwen_image_edit_encode(clip, vae, image, prompt)


class GJJ_360PanoramaGenerator:
    CATEGORY = "GJJ/图像"
    FUNCTION = "generate"
    DESCRIPTION = "单节点 360 全景生成：无图时文生 360，有图时图生 360，并自动做中缝修复。"
    SEARCH_ALIASES = ["360 panorama", "360全景", "panorama generator", "全景生成", "Qwen 360"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("360全景图",)
    OUTPUT_TOOLTIPS = ("最终 2:1 等距柱状投影 360 全景图。",)
    OUTPUT_NODE = True
    INPUT_IS_LIST = True
    _FINAL_CACHE: dict[str, torch.Tensor] = {}
    _FINAL_CACHE_ORDER: list[str] = []

    GJJ_HELP = {
        "description": DESCRIPTION,
        "model_tree": MODEL_TREE,
        "models": MODEL_TREE,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
    }

    def __init__(self):
        self._lazy = GJJ_LazyImageStudio()

    @classmethod
    def _cache_get(cls, key: str) -> torch.Tensor | None:
        value = cls._FINAL_CACHE.get(key)
        if isinstance(value, torch.Tensor):
            return _ensure_bhwc_rgb(value).clone()
        return None

    @classmethod
    def _cache_put(cls, key: str, image: torch.Tensor) -> None:
        if not key or not isinstance(image, torch.Tensor):
            return
        cls._FINAL_CACHE[key] = _ensure_bhwc_rgb(image)[:1].detach().cpu().contiguous()
        if key in cls._FINAL_CACHE_ORDER:
            cls._FINAL_CACHE_ORDER.remove(key)
        cls._FINAL_CACHE_ORDER.append(key)
        while len(cls._FINAL_CACHE_ORDER) > 4:
            old = cls._FINAL_CACHE_ORDER.pop(0)
            cls._FINAL_CACHE.pop(old, None)

    @staticmethod
    def _generation_cache_key(params: dict[str, Any]) -> str:
        text = json.dumps(params, ensure_ascii=False, sort_keys=True, default=str)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    @classmethod
    def INPUT_TYPES(cls):
        unets = _list_lazy_unet_models() or [DEFAULT_UNET_NAME]
        clips = _list_lazy_clip_models() or [DEFAULT_CLIP_NAME]
        vaes = list_vae_models() or [DEFAULT_VAE_NAME]
        loras = ["", *_list_loras()]
        upscale_models = _list_pth_upscale_models() or [""]
        samplers = ["euler", "euler_cfg_pp", "dpmpp_2m", "dpmpp_2m_sde"]
        schedulers = ["simple", "normal", "karras", "sgm_uniform", "beta"]
        try:
            import comfy.samplers

            samplers = comfy.samplers.KSampler.SAMPLERS
            schedulers = comfy.samplers.KSampler.SCHEDULERS
        except Exception:
            pass
        return {
            "required": {
                "positive_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "正面提示词",
                        "tooltip": "无图时文生 360；连接图片时作为图生 360 的编辑描述。",
                    },
                ),
                "negative_prompt": ("STRING", {"default": "", "multiline": True, "display_name": "反向提示词"}),
                "unet_name": (unets, {"default": gjjutils_model_family_pick_model_name(DEFAULT_UNET, unets, unets[0] if unets else ""), "display_name": "UNET"}),
                "unet_dtype": (UNET_DTYPE_OPTIONS, {"default": DEFAULT_UNET_DTYPE, "display_name": "UNET 精度"}),
                "clip_name": (clips, {"default": gjjutils_model_family_pick_model_name(DEFAULT_CLIP, clips, clips[0] if clips else ""), "display_name": "CLIP"}),
                "vae_name": (vaes, {"default": gjjutils_model_family_pick_model_name(DEFAULT_VAE, vaes, vaes[0] if vaes else ""), "display_name": "VAE"}),
                "lora_1_name": (loras, {"default": gjjutils_model_family_pick_lora_name(DEFAULT_LIGHTNING_LORA, loras), "display_name": "Lightning LoRA"}),
                "lora_1_strength": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.05, "display_name": "Lightning 强度"}),
                "lora_2_name": (loras, {"default": gjjutils_model_family_pick_lora_name(DEFAULT_360_LORA, loras), "display_name": "360 LoRA"}),
                "lora_2_strength": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.05, "display_name": "360 强度"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True, "display_name": "种子"}),
                "steps": ("INT", {"default": 4, "min": 1, "max": 10000, "display_name": "步数"}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1, "display_name": "CFG"}),
                "sampler_name": (samplers, {"default": "euler" if "euler" in samplers else samplers[0], "display_name": "采样器"}),
                "scheduler": (schedulers, {"default": "simple" if "simple" in schedulers else schedulers[0], "display_name": "调度器"}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "降噪"}),
                "base_width": ("INT", {"default": 2048, "min": 512, "max": 8192, "step": 64, "display_name": "基础宽度"}),
                "base_height": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 64, "display_name": "基础高度"}),
                "final_width": ("INT", {"default": 4096, "min": 1024, "max": 16384, "step": 64, "display_name": "最终宽度"}),
                "final_height": ("INT", {"default": 2048, "min": 512, "max": 8192, "step": 64, "display_name": "最终高度"}),
                "upscale_enabled": ("BOOLEAN", {"default": True, "display_name": "启用模型放大"}),
                "upscale_model_name": (
                    upscale_models,
                    {
                        "default": gjjutils_model_family_pick_model_name(DEFAULT_UPSCALE_MODEL, upscale_models, upscale_models[0] if upscale_models else ""),
                        "display_name": "放大模型",
                    },
                ),
                "prompt_suffix": ("STRING", {"default": DEFAULT_PROMPT_SUFFIX, "multiline": True, "display_name": "360 提示词补充"}),
                "seam_prompt": ("STRING", {"default": DEFAULT_SEAM_PROMPT, "multiline": True, "display_name": "中缝修复提示词"}),
                "seam_mask_width": ("INT", {"default": 500, "min": 16, "max": 4096, "step": 8, "display_name": "中缝遮罩宽度"}),
                "seam_blur": ("INT", {"default": 30, "min": 0, "max": 512, "step": 1, "display_name": "中缝羽化"}),
                "repair_enabled": ("BOOLEAN", {"default": True, "display_name": "启用中缝修复"}),
            },
            "optional": {
                "image": (IMAGE_INPUT_TYPE, {"display_name": "输入图像", "tooltip": "可选。有图时图生 360；不连接时文生 360。"}),
                "output_current_view": ("BOOLEAN", _hidden_widget({"default": False, "display_name": "输出当前视窗"})),
                "current_view_data": ("STRING", _hidden_widget({"default": "", "multiline": False, "display_name": "当前视窗截图"})),
                "save_directory": ("STRING", _hidden_widget({"default": "", "multiline": False, "display_name": "保存位置"})),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "prompt_graph": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def _lazy_generate(
        self,
        *,
        prompt: str,
        negative_prompt: str,
        image: torch.Tensor | None,
        width: int,
        height: int,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        unet_name: str,
        unet_dtype: str,
        clip_name: str,
        vae_name: str,
        lora_data: str,
        mask: torch.Tensor | None = None,
        unique_id=None,
        prompt_graph=None,
        extra_pnginfo=None,
    ) -> torch.Tensor:
        kwargs: dict[str, Any] = {}
        if image is not None:
            kwargs["image_01"] = image
        result = self._lazy.create_image(
            prompt=prompt,
            negative_prompt=negative_prompt,
            main_image_index=1,
            width=int(width),
            height=int(height),
            batch_size=1,
            unet_name=unet_name,
            unet_dtype=unet_dtype,
            clip_name1=clip_name,
            vae_name=vae_name,
            seed=int(seed),
            steps=int(steps),
            cfg=float(cfg),
            sampler_name=sampler_name,
            scheduler=scheduler,
            denoise=float(denoise),
            grow_mask_by=0,
            lora_data=lora_data,
            batch_source_images="[]",
            mask=mask,
            prompt_graph=prompt_graph,
            unique_id=unique_id,
            extra_pnginfo=extra_pnginfo,
            **kwargs,
        )
        output = result.get("result", (None,))[0] if isinstance(result, dict) else None
        if not isinstance(output, torch.Tensor):
            raise RuntimeError("生成流程没有返回有效图片。")
        return _ensure_bhwc_rgb(output)[:1].contiguous()

    def _repair_seam_like_source(
        self,
        *,
        prompt: str,
        stitched_image: torch.Tensor,
        qwen_reference_image: torch.Tensor,
        mask: torch.Tensor,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        unet_name: str,
        unet_dtype: str,
        clip_name: str,
        vae_name: str,
        lora_data: str,
    ) -> torch.Tensor:
        try:
            from nodes import ConditioningZeroOut, InpaintModelConditioning
        except Exception:
            from .gjj_nodes import ConditioningZeroOut, InpaintModelConditioning

        model, clip, vae = self._lazy._load_runtime_pipeline(
            unet_name,
            unet_dtype,
            [clip_name],
            "qwen_image",
            vae_name,
        )
        model, clip = self._lazy._apply_loras(
            model,
            clip,
            "qwen_image",
            "",
            lora_data,
        )
        positive = _qwen_image_edit_encode_with_vae(clip, vae, qwen_reference_image, prompt)
        positive = _normalize_conditioning(positive)
        negative = _node_call(ConditioningZeroOut(), conditioning=positive)[0]
        cond = _node_call(
            InpaintModelConditioning(),
            positive=positive,
            negative=negative,
            pixels=stitched_image,
            vae=vae,
            mask=mask,
            noise_mask=True,
        )
        sampled = _ksampler(
            model,
            seed,
            steps,
            cfg,
            sampler_name,
            scheduler,
            cond[0],
            cond[1],
            cond[2],
            denoise,
        )
        return _ensure_bhwc_rgb(_decode_vae(vae, sampled))[:1].contiguous()

    def _finish_output(
        self,
        *,
        final: torch.Tensor,
        output_current_view: bool,
        current_view_data: str,
        save_directory: str,
        final_width: int,
        final_height: int,
        unique_id: Any,
        stage_total: int,
    ):
        output = final
        output_label = "全景图"
        if output_current_view:
            try:
                current_view = _decode_current_view_image(current_view_data)
                if current_view is None:
                    current_view = _render_view_from_panorama(final, current_view_data)
                if current_view is not None:
                    output = current_view
                    output_label = "当前视窗"
                else:
                    _send_status(unique_id, "📷 未取得当前视窗，已输出完整全景图。", 0.98, stage_index=5, stage_total=stage_total)
            except Exception as exc:
                print(f"[GJJ 360PanoramaGenerator] 当前视窗解析失败，回退完整全景：{exc}")
                _send_status(unique_id, "📷 当前视窗解析失败，已输出完整全景图。", 0.98, stage_index=5, stage_total=stage_total)

        saved_path = ""
        if save_directory:
            try:
                saved_path = _save_output_image(output, save_directory, "GJJ_360_view" if output_current_view else "GJJ_360_panorama")
                if saved_path:
                    _send_status(unique_id, f"💾 已保存：{saved_path}", 0.99, stage_index=5, stage_total=stage_total)
            except Exception as exc:
                print(f"[GJJ 360PanoramaGenerator] 保存失败：{exc}")
                _send_status(unique_id, f"💾 保存失败：{exc}", 0.99, stage_index=5, stage_total=stage_total)

        _send_status(unique_id, f"5/5 完成 360 全景图，输出：{output_label}。", 1.0, stage_index=5, stage_total=stage_total)
        images = _send_preview(unique_id, final, "完成")
        preview_text = [f"完成：{final_width} x {final_height}，输出：{output_label}"]
        if saved_path:
            preview_text.append(f"已保存：{saved_path}")
        return {"ui": {"images": images, "preview_text": preview_text}, "result": (output,)}

    def generate(
        self,
        positive_prompt,
        negative_prompt,
        unet_name,
        unet_dtype,
        clip_name,
        vae_name,
        lora_1_name,
        lora_1_strength,
        lora_2_name,
        lora_2_strength,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        base_width,
        base_height,
        final_width,
        final_height,
        upscale_enabled,
        upscale_model_name,
        prompt_suffix,
        seam_prompt,
        seam_mask_width,
        seam_blur,
        repair_enabled,
        image=None,
        output_current_view=False,
        current_view_data="",
        save_directory="",
        unique_id=None,
        prompt_graph=None,
        extra_pnginfo=None,
    ):
        positive_prompt = str(_first_scalar(positive_prompt) or "")
        negative_prompt = str(_first_scalar(negative_prompt) or "")
        unet_name = str(_first_scalar(unet_name) or "")
        unet_dtype = str(_first_scalar(unet_dtype) or DEFAULT_UNET_DTYPE)
        clip_name = str(_first_scalar(clip_name) or "")
        vae_name = str(_first_scalar(vae_name) or "")
        lora_1_name = str(_first_scalar(lora_1_name) or "")
        lora_2_name = str(_first_scalar(lora_2_name) or "")
        lora_1_strength = float(_first_scalar(lora_1_strength))
        lora_2_strength = float(_first_scalar(lora_2_strength))
        seed = int(_first_scalar(seed))
        steps = int(_first_scalar(steps))
        cfg = float(_first_scalar(cfg))
        sampler_name = str(_first_scalar(sampler_name) or "euler")
        scheduler = str(_first_scalar(scheduler) or "simple")
        denoise = float(_first_scalar(denoise))
        base_width = int(_first_scalar(base_width))
        base_height = int(_first_scalar(base_height))
        final_width = int(_first_scalar(final_width))
        final_height = int(_first_scalar(final_height))
        upscale_enabled = bool(_first_scalar(upscale_enabled))
        upscale_model_name = str(_first_scalar(upscale_model_name) or "")
        prompt_suffix = str(_first_scalar(prompt_suffix) or "")
        seam_prompt = str(_first_scalar(seam_prompt) or DEFAULT_SEAM_PROMPT)
        seam_mask_width = int(_first_scalar(seam_mask_width))
        seam_blur = int(_first_scalar(seam_blur))
        repair_enabled = bool(_first_scalar(repair_enabled))
        output_current_view = bool(_first_scalar(output_current_view))
        current_view_data = str(_first_scalar(current_view_data) or "")
        save_directory = str(_first_scalar(save_directory) or "")
        unique_id = _first_scalar(unique_id)

        source = _split_optional_image(image)
        lora_data = _make_lora_data(lora_1_name, lora_1_strength, lora_2_name, lora_2_strength)
        generation_key = self._generation_cache_key(
            {
                "positive_prompt": positive_prompt,
                "negative_prompt": negative_prompt,
                "unet_name": unet_name,
                "unet_dtype": unet_dtype,
                "clip_name": clip_name,
                "vae_name": vae_name,
                "lora_data": lora_data,
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": sampler_name,
                "scheduler": scheduler,
                "denoise": denoise,
                "base_width": base_width,
                "base_height": base_height,
                "final_width": final_width,
                "final_height": final_height,
                "upscale_enabled": upscale_enabled,
                "upscale_model_name": upscale_model_name,
                "prompt_suffix": prompt_suffix,
                "seam_prompt": seam_prompt,
                "seam_mask_width": seam_mask_width,
                "seam_blur": seam_blur,
                "repair_enabled": repair_enabled,
                "source": _image_fingerprint(source),
            }
        )

        stage_total = 5
        _send_status(unique_id, "1/5 准备 360 全景生成...", 0.02, stage_index=1, stage_total=stage_total)
        _check_gguf_dependency_for_selected_models(unet_name, clip_name, unique_id)
        cached_final = self._cache_get(generation_key)
        if cached_final is not None:
            _send_status(unique_id, "使用缓存全景，只更新输出视窗...", 0.96, stage_index=5, stage_total=stage_total)
            return self._finish_output(
                final=cached_final,
                output_current_view=output_current_view,
                current_view_data=current_view_data,
                save_directory=save_directory,
                final_width=final_width,
                final_height=final_height,
                unique_id=unique_id,
                stage_total=stage_total,
            )
        reference = _resize_fit_pad(source, base_width, base_height) if source is not None else None
        mode_text = "图生 360" if reference is not None else "文生 360"
        _send_status(
            unique_id,
            f"2/5 {mode_text} 主生成采样...",
            0.10,
            stage_index=2,
            stage_total=stage_total,
            sampling_start=0.10,
            sampling_end=0.46,
            sampling_total=steps,
        )
        base = self._lazy_generate(
            prompt=_with_suffix(positive_prompt, prompt_suffix),
            negative_prompt=negative_prompt,
            image=reference,
            width=base_width,
            height=base_height,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            denoise=denoise,
            unet_name=unet_name,
            unet_dtype=unet_dtype,
            clip_name=clip_name,
            vae_name=vae_name,
            lora_data=lora_data,
            unique_id=unique_id,
            prompt_graph=prompt_graph,
            extra_pnginfo=extra_pnginfo,
        )
        _send_status(unique_id, f"2/5 {mode_text} 主生成完成。", 0.46, stage_index=2, stage_total=stage_total)
        _send_preview(unique_id, base, "主生成")

        _send_status(unique_id, "3/5 放大、拼接并裁出 2:1 全景画布...", 0.52, stage_index=3, stage_total=stage_total)
        upscaled = base
        if upscale_enabled and upscale_model_name:
            try:
                upscaled = GJJ_ModelUpscaler().upscale(base, True, upscale_model_name, unique_id=unique_id)[0]
            except Exception as exc:
                print(f"[GJJ 360PanoramaGenerator] 模型放大失败，回退普通缩放：{exc}")
        if int(upscaled.shape[2]) != final_width or int(upscaled.shape[1]) != final_height:
            upscaled = _resize_exact(upscaled, final_width, final_height)
        doubled = torch.cat([upscaled, upscaled], dim=2)
        stitched = _center_crop(doubled, final_width, final_height)
        _send_preview(unique_id, stitched, "拼接")

        final = stitched
        if repair_enabled:
            _send_status(
                unique_id,
                "4/5 按源工作流叠加中缝遮罩并修复采样...",
                0.70,
                stage_index=4,
                stage_total=stage_total,
                sampling_start=0.70,
                sampling_end=0.94,
                sampling_total=steps,
            )
            mask = torch.zeros((1, final_height, final_width), dtype=stitched.dtype, device=stitched.device)
            half = max(1, int(seam_mask_width) // 2)
            center = final_width // 2
            mask[:, :, max(0, center - half) : min(final_width, center + half)] = 1.0
            mask = _blur_mask(mask, int(seam_blur))
            mask_image = mask.unsqueeze(-1).expand(-1, -1, -1, 3)
            repair_reference = 1.0 - (1.0 - stitched.clamp(0.0, 1.0)) * (1.0 - mask_image)
            _send_preview(unique_id, repair_reference, "中缝遮罩")
            final = self._repair_seam_like_source(
                prompt=seam_prompt,
                stitched_image=stitched,
                qwen_reference_image=repair_reference,
                mask=mask,
                seed=seed + 1,
                steps=steps,
                cfg=cfg,
                sampler_name=sampler_name,
                scheduler=scheduler,
                denoise=denoise,
                unet_name=unet_name,
                unet_dtype=unet_dtype,
                clip_name=clip_name,
                vae_name=vae_name,
                lora_data=lora_data,
            )
        else:
            _send_status(unique_id, "4/5 已跳过中缝修复。", 0.94, stage_index=4, stage_total=stage_total)

        final = _horizontal_center_wrap(final, final_width, final_height)
        _send_preview(unique_id, final, "居中")

        self._cache_put(generation_key, final)
        return self._finish_output(
            final=final,
            output_current_view=output_current_view,
            current_view_data=current_view_data,
            save_directory=save_directory,
            final_width=final_width,
            final_height=final_height,
            unique_id=unique_id,
            stage_total=stage_total,
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_360PanoramaGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🌐 360全景生成器"}
