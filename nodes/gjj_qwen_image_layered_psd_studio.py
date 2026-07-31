from __future__ import annotations

import os
import json
import struct
import time
from io import BytesIO
from pathlib import Path
from typing import Any

import comfy.model_management
import comfy.samplers
import folder_paths
import torch
import torch.nn.functional as F
from PIL import Image
from nodes import VAEEncode, VAEDecode, common_ksampler

from .common_utils.model_loader import (
    gjjutils_load_clip_from_names,
    gjjutils_load_model,
    gjjutils_load_vae,
    gjjutils_patch_model_sampling,
)
from .common_utils.temp_files import gjjutils_write_temp_file, gjjutils_write_temp_pil_image
from .gjj_clip_prompt_encode_panel import GJJ_CLIPPromptEncodePanel
from .gjj_model_bundle_loader import list_clip_models, list_unet_models, list_vae_models
from .gjj_multi_lora_chain import apply_lora_chain_config, build_lora_trigger_text
from .gjj_multi_image_loader import load_image_tensor, resolve_selected_image_path


NODE_NAME = "GJJ_QwenImageLayeredPSDStudio"
DEFAULT_UNET = "qwen_image_layered_int8_convrot.safetensors"
DEFAULT_CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
DEFAULT_VAE = "qwen_image_layered_vae.safetensors"
DEFAULT_ACCEL_LORA = "QWEN\\lighting\\Qwen-Image-Lightning-4steps-V2.0.safetensors"
QWEN_LAYERED_MODEL_TREE = [
    {
        "label": "Qwen Image Layered 主模型",
        "path": "models/diffusion_models",
        "filename": DEFAULT_UNET,
        "kind": "diffusion",
        "icon": "🟣",
        "type": "UNET",
        "input": "unet_name",
        "required": True,
        "description": "Qwen-Image-Layered 分层图像主模型；放在 ComfyUI/models/diffusion_models/。",
    },
    {
        "label": "Qwen 2.5 VL 文本编码器",
        "path": "models/text_encoders",
        "filename": DEFAULT_CLIP,
        "kind": "clip",
        "icon": "🟡",
        "type": "CLIP",
        "input": "clip_name",
        "required": True,
        "description": "Qwen 2.5 VL 文本编码器；放在 ComfyUI/models/text_encoders/。",
    },
    {
        "label": "Qwen Image Layered VAE",
        "path": "models/vae",
        "filename": DEFAULT_VAE,
        "kind": "vae",
        "icon": "🔴",
        "type": "VAE",
        "input": "vae_name",
        "required": True,
        "description": "Qwen Image Layered 专用 VAE；放在 ComfyUI/models/vae/。",
    },
    {
        "label": "Qwen Image Lightning 加速 LoRA",
        "path": "models/loras/QWEN/lighting",
        "filename": "Qwen-Image-Lightning-4steps-V2.0.safetensors",
        "kind": "lora",
        "icon": "🟠",
        "type": "LORA",
        "input": "accel_lora_name",
        "required": False,
        "description": "默认加速 LoRA；放在 ComfyUI/models/loras/QWEN/lighting/。",
    },
]


def _model_key(value: Any) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _filter_model_names(values: list[str], *keywords: str, fallback: str = "") -> list[str]:
    keys = [_model_key(item) for item in keywords if str(item or "").strip()]
    result = [str(item) for item in values if all(key in _model_key(item) for key in keys)]
    if fallback and fallback not in result:
        result.append(fallback)
    return result or ([fallback] if fallback else [])


def _prefer_safetensors_first(values: list[str]) -> list[str]:
    def rank(name: str) -> tuple[int, str]:
        lower = str(name or "").lower()
        if lower.endswith(".safetensors"):
            return (0, lower)
        if lower.endswith(".gguf"):
            return (1, lower)
        return (2, lower)

    return sorted(values, key=rank)


def _pick_model_name(value: Any, choices: list[str], fallback: str) -> str:
    text = str(value or "").strip()
    if text in choices:
        return text
    text_key = _model_key(text)
    if text_key:
        for item in choices:
            if _model_key(item) == text_key:
                return item
    return choices[0] if choices else fallback


def _qwen_layered_unet_models() -> list[str]:
    return _prefer_safetensors_first(
        _filter_model_names(list_unet_models() or [], "qwen", "layer", fallback=DEFAULT_UNET)
    )


def _qwen25vl_clip_models() -> list[str]:
    return _filter_model_names(list_clip_models() or [], "qwen25vl7b", fallback=DEFAULT_CLIP)


def _qwen_layered_vae_models() -> list[str]:
    return _filter_model_names(list_vae_models() or [], "qwen", "layer", fallback=DEFAULT_VAE)


def _qwen_accel_lora_models() -> list[str]:
    return _prefer_safetensors_first(
        _filter_model_names(folder_paths.get_filename_list("loras") or [], "qwen", "image", "lightning", fallback=DEFAULT_ACCEL_LORA)
    )


def _lora_data_from_name(lora_name: Any, fallback_data: Any = "[]") -> str:
    name = str(lora_name or "").strip()
    if name:
        return json.dumps([{"enabled": True, "name": name, "strength": 1.0}], ensure_ascii=False)
    text = str(fallback_data or "").strip()
    return text if text else "[]"


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync("gjj_node_progress", {"node": str(unique_id), "text": str(text or "")})
    except Exception:
        pass


def _call_comfy_node(class_name: str, *args, **kwargs):
    import nodes as comfy_nodes

    cls = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}).get(class_name) or getattr(comfy_nodes, class_name, None)
    if cls is None:
        raise RuntimeError(f"当前 ComfyUI 未找到节点：{class_name}")
    inst = cls()
    fn_name = getattr(cls, "FUNCTION", None)
    method_names = [fn_name] if fn_name else []
    method_names.extend(["execute", "generate", "create", "op", "run"])
    last_type_error: TypeError | None = None
    for name in method_names:
        if not name or not hasattr(inst, name):
            continue
        fn = getattr(inst, name)
        try:
            return fn(*args, **kwargs)
        except TypeError as exc:
            last_type_error = exc
            continue
    if last_type_error is not None:
        raise last_type_error
    raise RuntimeError(f"节点 {class_name} 没有可调用的执行方法。")


def _node_first(class_name: str, *args, **kwargs):
    result = _call_comfy_node(class_name, *args, **kwargs)
    return _first_output(result)


def _first_output(result: Any):
    if isinstance(result, dict) and "result" in result:
        result = result["result"]
    node_output_args = getattr(result, "args", None)
    if isinstance(node_output_args, (tuple, list)):
        result = node_output_args
    if isinstance(result, (tuple, list)):
        return result[0]
    return result


def _unwrap_latent(value: Any) -> dict[str, Any]:
    latent = _first_output(value)
    if isinstance(latent, dict) and "samples" in latent:
        return latent
    raise RuntimeError(f"内部 latent 输出格式不兼容：{type(latent).__name__}")


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on", "文生图"}


def _align(value: int, multiple: int = 8) -> int:
    value = max(multiple, int(value or multiple))
    return max(multiple, int(round(value / multiple)) * multiple)


def _panel_dimension(value: Any, fallback: int = 640) -> int:
    try:
        number = int(round(float(value)))
    except Exception:
        number = int(fallback)
    number = int(round(number / 32) * 32)
    return max(256, min(2048, number))


def _resize_image_to_max(image: torch.Tensor, largest_size: int) -> torch.Tensor:
    if image is None:
        return image
    tensor = image.detach().float().clamp(0.0, 1.0)
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4 or tensor.shape[0] < 1:
        return image
    height = int(tensor.shape[1])
    width = int(tensor.shape[2])
    longest = max(width, height)
    target = max(64, int(largest_size or longest))
    if longest <= 0 or longest == target:
        return tensor
    scale = target / float(longest)
    new_w = _align(width * scale)
    new_h = _align(height * scale)
    chw = tensor.permute(0, 3, 1, 2)
    resized = F.interpolate(chw, size=(new_h, new_w), mode="bicubic", align_corners=False)
    return resized.permute(0, 2, 3, 1).clamp(0.0, 1.0).contiguous()


def _resize_image_to_size(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    if image is None:
        return image
    tensor = image.detach().float().clamp(0.0, 1.0)
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4 or tensor.shape[0] < 1:
        return image
    target_w = _panel_dimension(width)
    target_h = _panel_dimension(height)
    chw = tensor.permute(0, 3, 1, 2)
    resized = F.interpolate(chw, size=(target_h, target_w), mode="bicubic", align_corners=False)
    return resized.permute(0, 2, 3, 1).clamp(0.0, 1.0).contiguous()


def _zero_conditioning_from_positive(positive: Any):
    try:
        from nodes import ConditioningZeroOut

        return ConditioningZeroOut().zero_out(positive)[0]
    except Exception:
        zeroed = []
        for item in positive:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                cond = item[0].clone() if hasattr(item[0], "clone") else item[0]
                if hasattr(cond, "zero_"):
                    cond.zero_()
                meta = item[1].copy() if isinstance(item[1], dict) else item[1]
                zeroed.append([cond, meta])
            else:
                zeroed.append(item)
        return zeroed


def _append_reference_latent(conditioning: Any, latent: dict[str, Any]):
    try:
        return _node_first("ReferenceLatent", conditioning=conditioning, latent=latent)
    except Exception:
        samples = latent.get("samples") if isinstance(latent, dict) else latent
        result = []
        for item in conditioning:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                meta = dict(item[1] or {})
                meta["reference_latents"] = samples
                result.append([item[0], meta])
            else:
                result.append(item)
        return result


def _tensor_batch_to_rgba_pils(images: torch.Tensor) -> list[Image.Image]:
    tensor = images.detach().cpu().float().clamp(0.0, 1.0)
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    result: list[Image.Image] = []
    for index in range(int(tensor.shape[0])):
        frame = tensor[index]
        if int(frame.shape[2]) >= 4:
            array = (frame[:, :, :4].numpy() * 255.0).round().clip(0, 255).astype("uint8")
            result.append(Image.fromarray(array, "RGBA"))
        else:
            rgb = frame[:, :, :3]
            alpha = rgb.amax(dim=2, keepdim=True)
            alpha = ((alpha - 0.015) / 0.985).clamp(0.0, 1.0)
            straight = torch.where(alpha > (1.0 / 255.0), (rgb / alpha.clamp(min=1.0 / 255.0)).clamp(0.0, 1.0), torch.zeros_like(rgb))
            rgba = torch.cat([straight, alpha], dim=2)
            array = (rgba.numpy() * 255.0).round().clip(0, 255).astype("uint8")
            result.append(Image.fromarray(array, "RGBA"))
    return result


def _write_layer_preview_images(layer_images: torch.Tensor) -> list[dict[str, Any]]:
    return [
        gjjutils_write_temp_pil_image(image, format="PNG", suffix=".png")
        for image in _tensor_batch_to_rgba_pils(layer_images)
    ]


def _psd_pascal_name(name: str) -> bytes:
    raw = str(name or "Layer").encode("utf-8", "replace")[:255]
    data = bytes([len(raw)]) + raw
    while len(data) % 4:
        data += b"\0"
    return data


def _pack_rect(width: int, height: int) -> bytes:
    return struct.pack(">iiii", 0, 0, int(height), int(width))


def _write_layered_psd(layers: list[Image.Image], out_path: str) -> None:
    if not layers:
        raise RuntimeError("没有可写入 PSD 的图层。")
    width, height = layers[0].size
    normalized = [layer.convert("RGBA").resize((width, height), Image.Resampling.LANCZOS) for layer in layers]
    layer_records = bytearray()
    channel_data = bytearray()
    channel_ids = [0, 1, 2, -1]

    for index, layer in enumerate(normalized):
        rgba = layer.tobytes()
        channels = [rgba[i::4] for i in range(4)]
        layer_records += _pack_rect(width, height)
        layer_records += struct.pack(">H", 4)
        for channel_id, channel in zip(channel_ids, channels):
            layer_records += struct.pack(">hI", channel_id, 2 + len(channel))
        layer_records += b"8BIMnorm"
        layer_records += bytes([255, 0, 0, 0])
        extra = bytearray()
        extra += struct.pack(">I", 0)
        extra += struct.pack(">I", 0)
        extra += _psd_pascal_name(f"Layer {index + 1:02d}")
        layer_records += struct.pack(">I", len(extra)) + extra
        for channel in channels:
            channel_data += struct.pack(">H", 0) + channel

    layer_info = struct.pack(">h", len(normalized)) + layer_records + channel_data
    layer_mask_payload = struct.pack(">I", len(layer_info)) + layer_info + struct.pack(">I", 0)
    layer_mask_section = struct.pack(">I", len(layer_mask_payload)) + layer_mask_payload

    composite = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for layer in normalized:
        composite.alpha_composite(layer)
    rgb = composite.convert("RGB").tobytes()
    flat_channels = [rgb[i::3] for i in range(3)]

    with open(out_path, "wb") as handle:
        handle.write(b"8BPS")
        handle.write(struct.pack(">H", 1))
        handle.write(b"\0" * 6)
        handle.write(struct.pack(">HIIHH", 3, height, width, 8, 3))
        handle.write(struct.pack(">I", 0))
        handle.write(struct.pack(">I", 0))
        handle.write(layer_mask_section)
        handle.write(struct.pack(">H", 0))
        for channel in flat_channels:
            handle.write(channel)


def _output_path(prefix: str = "GJJ_Qwen_Layered") -> str:
    output_dir = Path(folder_paths.get_output_directory()) / "GJJ" / "PSD"
    output_dir.mkdir(parents=True, exist_ok=True)
    return str(output_dir / f"{prefix}_{int(time.time() * 1000)}.psd")


class GJJ_QwenImageLayeredPSDStudio:
    DESCRIPTION = "Qwen-Image-Layered 图文生图单节点：内部完成模型加载、提示词编码、文生/图生分支、切层解码和零依赖 PSD 写出。"
    GJJ_HELP = {
        "title": "GJJ · 图片分层PSD图层（Qwen Layered）",
        "description": DESCRIPTION,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "model_tree": QWEN_LAYERED_MODEL_TREE,
    }
    SEARCH_ALIASES = ["qwen image layered", "分层图像", "PSD", "图层PSD", "一键分层"]
    CATEGORY = "GJJ/🖼️ 图像"
    FUNCTION = "generate"
    RETURN_TYPES = ("STRING", "IMAGE")
    RETURN_NAMES = ("图层PSD", "图层预览")
    OUTPUT_TOOLTIPS = ("生成的分层 PSD 文件路径。", "解码后的图层批次，用于面板重叠预览。")
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        samplers = list(getattr(comfy.samplers.KSampler, "SAMPLERS", []) or ["euler"])
        schedulers = list(getattr(comfy.samplers.KSampler, "SCHEDULERS", []) or ["simple"])
        def hidden(options: dict[str, Any] | None = None) -> dict[str, Any]:
            data = dict(options or {})
            data["display"] = "hidden"
            data["hidden"] = True
            return data
        return {
            "required": {
                "method": (["文生图", "图生图"], hidden({"default": "图生图", "display_name": "生图方式"})),
                "prompt": (
                    "STRING",
                    {
                        "default": "一个人在森林里",
                        "multiline": True,
                        "display_name": "正向提示词",
                        "tooltip": "正向提示词。使用原生控件，保留 ComfyUI 的连接/转换输入能力。",
                    },
                ),
                "negative_prompt": ("STRING", hidden({"default": "", "multiline": True, "display_name": "负面提示词"})),
                "size_mode": (["原图尺寸", "面板尺寸"], hidden({"default": "原图尺寸", "display_name": "尺寸来源"})),
                "largest_size": ("INT", hidden({"default": 640, "min": 64, "max": 4096, "step": 8, "display_name": "尺寸限制"})),
                "layers": ("INT", hidden({"default": 6, "min": 2, "max": 20, "step": 1, "display_name": "图层数"})),
                "unet_name": (_qwen_layered_unet_models(), hidden({"default": DEFAULT_UNET, "display_name": "UNET"})),
                "clip_name": (_qwen25vl_clip_models(), hidden({"default": DEFAULT_CLIP, "display_name": "CLIP"})),
                "vae_name": (_qwen_layered_vae_models(), hidden({"default": DEFAULT_VAE, "display_name": "VAE"})),
                "seed": ("INT", hidden({"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "display_name": "种子"})),
                "steps": ("INT", hidden({"default": 4, "min": 1, "max": 100, "step": 1, "display_name": "步数"})),
                "cfg": ("FLOAT", hidden({"default": 1.0, "min": 0.0, "max": 30.0, "step": 0.1, "display_name": "CFG"})),
                "sampler_name": (samplers, hidden({"default": "euler" if "euler" in samplers else samplers[0], "display_name": "采样器"})),
                "scheduler": (schedulers, hidden({"default": "simple" if "simple" in schedulers else schedulers[0], "display_name": "调度器"})),
                "denoise": ("FLOAT", hidden({"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "降噪"})),
                "keep_model_loaded": ("BOOLEAN", hidden({"default": False, "display_name": "保持模型"})),
                "lora_data": ("STRING", hidden({"default": "[]", "multiline": True, "display_name": "LoRA 数据"})),
                "uploaded_image": ("STRING", hidden({"default": "", "display_name": "按钮选择图片"})),
                "accel_lora_name": (_qwen_accel_lora_models(), hidden({"default": DEFAULT_ACCEL_LORA, "display_name": "加速 LoRA"})),
                "panel_width": ("INT", hidden({"default": 640, "min": 256, "max": 2048, "step": 32, "display_name": "面板宽度"})),
                "panel_height": ("INT", hidden({"default": 640, "min": 256, "max": 2048, "step": 32, "display_name": "面板高度"})),
            },
            "optional": {
                "image": ("IMAGE", {"display_name": "原图"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def __init__(self):
        self._cache_key = None
        self._cache = None

    def _load_runtime(self, unet_name: str, clip_name: str, vae_name: str, lora_data: str, keep: bool):
        unet_name = _pick_model_name(unet_name, _qwen_layered_unet_models(), DEFAULT_UNET)
        clip_name = _pick_model_name(clip_name, _qwen25vl_clip_models(), DEFAULT_CLIP)
        vae_name = _pick_model_name(vae_name, _qwen_layered_vae_models(), DEFAULT_VAE)
        key = (str(unet_name), str(clip_name), str(vae_name), str(lora_data or "[]"))
        if keep and self._cache_key == key and self._cache is not None:
            return self._cache
        model = gjjutils_load_model(unet_name, "default")
        clip = gjjutils_load_clip_from_names([clip_name], "qwen_image")
        vae = gjjutils_load_vae(vae_name)
        model = gjjutils_patch_model_sampling(model, "aura", 1.0)
        model, clip = apply_lora_chain_config(model, clip, lora_data)[:2]
        if keep:
            self._cache_key = key
            self._cache = (model, clip, vae)
        else:
            self._cache_key = None
            self._cache = None
        return model, clip, vae

    def generate(
        self,
        method,
        prompt,
        negative_prompt,
        size_mode,
        largest_size,
        layers,
        unet_name,
        clip_name,
        vae_name,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        keep_model_loaded,
        lora_data="[]",
        uploaded_image="",
        accel_lora_name="",
        panel_width=640,
        panel_height=640,
        image=None,
        unique_id=None,
    ):
        start = time.time()
        lora_data = _lora_data_from_name(accel_lora_name, lora_data)
        layer_count = max(2, min(20, int(layers)))
        panel_width = _panel_dimension(panel_width or largest_size or 640)
        panel_height = _panel_dimension(panel_height or largest_size or 640)
        _send_status(unique_id, "1/6 加载 Qwen Image Layered 模型...")
        model, clip, vae = self._load_runtime(unet_name, clip_name, vae_name, lora_data, bool(keep_model_loaded))

        _send_status(unique_id, "2/6 编码提示词...")
        triggers = build_lora_trigger_text(lora_data)
        positive, negative = GJJ_CLIPPromptEncodePanel().encode(
            clip=clip,
            positive_text=str(prompt or ""),
            negative_text=str(negative_prompt or ""),
            zero_conditioning=True if not str(negative_prompt or "").strip() else False,
            translation_enabled=False,
            lora_triggers=triggers,
            unique_id=unique_id,
        )

        if image is None and str(uploaded_image or "").strip():
            try:
                image = load_image_tensor(
                    resolve_selected_image_path(
                        {"filename": str(uploaded_image or "").strip(), "type": "input", "subfolder": ""}
                    )
                )
            except Exception as exc:
                raise RuntimeError(f"📁 选择的图片无法读取：{uploaded_image}\n{exc}") from exc

        text_to_image = image is None
        use_source_size = str(size_mode or "") == "原图尺寸"
        if image is None:
            _send_status(unique_id, "未检测到参考图，按文生图生成。")
            src_w = panel_width
            src_h = panel_height
            source = None
        else:
            _send_status(unique_id, "检测到参考图，按图生图生成。")
            source = image.detach().float().clamp(0.0, 1.0) if use_source_size else _resize_image_to_size(image, panel_width, panel_height)
            if source.ndim == 3:
                source = source.unsqueeze(0)
            src_h = int(source.shape[1])
            src_w = int(source.shape[2])
        width = _align(src_w)
        height = _align(src_h)

        _send_status(unique_id, "3/6 构建分层 latent...")
        if text_to_image:
            latent = _unwrap_latent(_node_first(
                "EmptyQwenImageLayeredLatentImage",
                width=width,
                height=height,
                layers=layer_count,
                batch_size=1,
            ))
        else:
            if source is None:
                text_to_image = True
                latent = _unwrap_latent(_node_first(
                    "EmptyQwenImageLayeredLatentImage",
                    width=width,
                    height=height,
                    layers=layer_count,
                    batch_size=1,
                ))
            else:
                encoded = VAEEncode().encode(vae, source)[0]
                positive = _append_reference_latent(positive, encoded)
                negative = _append_reference_latent(negative, encoded)
                latent = _unwrap_latent(_node_first(
                    "EmptyQwenImageLayeredLatentImage",
                    width=width,
                    height=height,
                    layers=layer_count,
                    batch_size=1,
                ))

        _send_status(unique_id, "4/6 采样生成分层图像...")
        sampled = common_ksampler(
            model,
            int(seed),
            int(steps),
            float(cfg),
            str(sampler_name),
            str(scheduler),
            positive,
            negative,
            latent,
            denoise=float(denoise),
        )[0]

        _send_status(unique_id, "5/6 切分并解码图层...")
        sampled = _unwrap_latent(sampled)
        layer_latent = _unwrap_latent(_node_first("LatentCutToBatch", samples=sampled, dim="t", slice_size=1))
        layer_images = VAEDecode().decode(vae, layer_latent)[0].clamp(0.0, 1.0).contiguous()
        requested_layers = layer_count
        if not text_to_image and int(layer_images.shape[0]) > requested_layers:
            layer_images = layer_images[1:requested_layers + 1].contiguous()
        preview_images = _write_layer_preview_images(layer_images)

        _send_status(unique_id, "6/6 写出 PSD...")
        psd_path = _output_path()
        _write_layered_psd(_tensor_batch_to_rgba_pils(layer_images), psd_path)
        psd_ref = gjjutils_write_temp_file(psd_path, ".psd")
        elapsed = time.time() - start
        _send_status(unique_id, f"完成：{len(preview_images)} 层  耗时 {elapsed:.1f}s")

        if not bool(keep_model_loaded):
            self._cache = None
            self._cache_key = None
            try:
                comfy.model_management.soft_empty_cache()
            except Exception:
                pass

        return {
            "ui": {
                "gjj_layer_images": preview_images,
                "gjj_psd": [psd_ref | {"path": psd_path, "filename": os.path.basename(psd_path), "type": "output", "subfolder": "GJJ/PSD"}],
                "images": preview_images,
                "elapsed_time": [elapsed],
            },
            "result": (psd_path, layer_images),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_QwenImageLayeredPSDStudio}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🧩图片分层PSD图层（Qwen Layered）"}
