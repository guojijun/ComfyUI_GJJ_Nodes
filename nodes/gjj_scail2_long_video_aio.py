from __future__ import annotations

import json
import logging
import gc
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F
import folder_paths
import comfy.model_management
from aiohttp import web
from PIL import Image
from comfy_api.latest import InputImpl
try:
    from server import PromptServer
except Exception:  # pragma: no cover - ComfyUI provides this at runtime.
    PromptServer = None

from .common_utils.progress import send_node_progress
from .common_utils.model_manager import gjjutils_model_stem_without_quant
from .common_utils.temp_files import gjjutils_temp_path, gjjutils_write_temp_file, gjjutils_write_temp_pil_image
from .gjj_clip_prompt_encode_panel import GJJ_CLIPPromptEncodePanel
from .gjj_multi_image_loader import GJJ_MultiImageLoader, resolve_selected_image_path
from .gjj_multi_lora_chain import normalize_lora_chain_data, parse_lora_data
from .gjj_multi_video_loader import GJJ_MultiVideoLoader
from .gjj_multi_video_loader import (
    _audio_window_from_meta,
    _slice_audio_window,
    concat_audio_segments,
    decode_audio_ffmpeg,
    empty_audio,
    parse_selected_videos,
    resolve_input_video_path,
    video_meta,
)
from .gjj_sam3_scail2_track_mask_aio import GJJ_SAM3SCAIL2TrackMaskAIO
from .gjj_video_combine import GJJ_VideoCombine
from .gjj_video_combine_runtime import get_ffmpeg_path
from .gjj_video_universal_model_loader import GJJ_VideoUniversalModelLoader
from .gjj_wan_scail_infinity import GJJ_WanSCAILInfinity

try:
    from nodes import CLIPVisionEncode
except Exception:  # pragma: no cover - ComfyUI provides this at runtime.
    CLIPVisionEncode = None


log = logging.getLogger(__name__)

NODE_NAME = "GJJ_SCAIL2LongVideoAIO"
NODE_DISPLAY_NAME = "🎬 SCAIL2 超长视频导演台单节点(一键生成)"

VIDEO_INPUT_TYPE = "VIDEO,IMAGE"
REFERENCE_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
OUTPUT_TYPE = "VIDEO,IMAGE"
MODEL_LIST_API_PATH = "/gjj/scail2_long_video_aio/models"
REF_STITCH_API_PATH = "/gjj/scail2_long_video_aio/stitch_references"
REF_REMOVE_BG_API_PATH = "/gjj/scail2_long_video_aio/remove_background_references"
AUDIO_UPLOAD_API_PATH = "/gjj/scail2_long_video_aio/upload_audio"
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".webm"}
DEFAULT_NEGATIVE_PROMPT = "(worst quality, low quality, normal quality:1.3), (blurry, out of focus, pixelated, jpeg artifacts, noise, grainy:1.2), (text, watermark, logo, signature, subtitle, border, qr code:1.3), (bad anatomy, bad hands, malformed fingers, extra digits, missing digits, fused fingers, extra limbs, missing limbs, deformed body:1.2), (facial distortion, cross-eyed, asymmetric face, plastic skin, uncanny valley:1.2), (flickering, frame jitter, color flickering, inconsistent lighting, overexposed, underexposed, motion distortion, unnatural movement, rigid movement:1.3), (duplicate characters, extra people, floating objects, wrong background, style drift, 3d render, cartoon, cgi if unwanted:1.1), ugly, disfigured, mutated, morbid, gore"
NO_LORA_TOKENS = {"不使用", "不使用lora", "不使用 lora", "no lora", "none", "off", "disable", "disabled", "🚫 不使用 lora"}
DEFAULT_SCAIL2_ACCEL_LORA = "wan/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors"
DEFAULT_SCAIL2_DPO_LORA = "wan/wan2.1_SCAIL_2_DPO_lora_bf16.safetensors"
DEFAULT_SCAIL2_RELIGHTING_LORA = "Scail-2_relighting-lora.safetensors"
DEFAULT_QWEN2511_LIGHTNING_LORA = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
DEFAULT_MULTI_ANGLES_LORA = "qwen-image-edit-2511-multiple-angles-lora.safetensors"


def _progress(unique_id: Any, message: str, progress: float | None = None, **extra: Any) -> None:
    text = f"[GJJ SCAIL2-AIO] {message}"
    log.info(text)
    print(text, flush=True)
    send_node_progress(unique_id, message, progress, **extra)


def _bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "是", "开", "开启"}
    return bool(value)


def _float_value(value: Any, fallback: float, min_value: float | None = None, max_value: float | None = None) -> float:
    try:
        text = str(value).strip() if value is not None else ""
        number = float(text) if text else float(fallback)
    except Exception:
        number = float(fallback)
    if min_value is not None:
        number = max(float(min_value), number)
    if max_value is not None:
        number = min(float(max_value), number)
    return number


def _json_text(value: Any, fallback: str = "[]") -> str:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    text = str(value or "").strip()
    return text if text else fallback


def _reference_items_from_json(value: Any) -> list[dict[str, Any]]:
    try:
        data = json.loads(_json_text(value, "[]"))
    except Exception:
        data = []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict) and str(item.get("filename") or "").strip()]


def _reference_item_key(item: dict[str, Any]) -> tuple[str, str, str]:
    filename = str(item.get("filename") or "").replace("\\", "/").strip()
    subfolder = str(item.get("subfolder") or "").replace("\\", "/").strip("/")
    if "/" in filename:
        parts = [part for part in filename.split("/") if part]
        filename = parts.pop() if parts else filename
        from_filename = "/".join(parts)
        subfolder = "/".join(part for part in (subfolder, from_filename) if part)
    clean_subfolder = "/".join(part for part in subfolder.split("/") if part and part not in {".", ".."})
    return (str(item.get("type") or "input").strip() or "input", clean_subfolder, filename)


def _merge_reference_items(*groups: Any) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for group in groups:
        items = group if isinstance(group, list) else []
        for item in items:
            if not isinstance(item, dict) or not str(item.get("filename") or "").strip():
                continue
            key = _reference_item_key(item)
            if key in seen:
                continue
            seen.add(key)
            merged.append(dict(item))
    return merged


def _reference_pad_color(kwargs: dict[str, Any]) -> str:
    value = str(kwargs.get("reference_pad_color") or "黑色").strip()
    return value if value in {"黑色", "白色", "灰色", "边缘均色"} else "黑色"


def _pad_color_tensor(tensor: torch.Tensor, target_h: int, target_w: int, mode: str) -> torch.Tensor:
    mode_text = str(mode or "黑色").strip()
    if mode_text == "白色":
        return tensor.new_ones((int(tensor.shape[0]), target_h, target_w, 3))
    if mode_text == "灰色":
        return tensor.new_full((int(tensor.shape[0]), target_h, target_w, 3), 0.5)
    if mode_text == "边缘均色":
        top = tensor[:, :1, :, :]
        bottom = tensor[:, -1:, :, :]
        left = tensor[:, :, :1, :]
        right = tensor[:, :, -1:, :]
        color = torch.cat([
            top.reshape(int(tensor.shape[0]), -1, 3),
            bottom.reshape(int(tensor.shape[0]), -1, 3),
            left.reshape(int(tensor.shape[0]), -1, 3),
            right.reshape(int(tensor.shape[0]), -1, 3),
        ], dim=1).mean(dim=1).view(int(tensor.shape[0]), 1, 1, 3)
        return color.expand(-1, target_h, target_w, -1).clone()
    return tensor.new_zeros((int(tensor.shape[0]), target_h, target_w, 3))


def _fit_pad_tensor_to_size(tensor: torch.Tensor, target_w: int, target_h: int, pad_color: str = "黑色") -> torch.Tensor:
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    tensor = tensor[..., :3].float().clamp(0.0, 1.0).contiguous()
    target_w = max(1, int(target_w or 0))
    target_h = max(1, int(target_h or 0))
    source_h = int(tensor.shape[1])
    source_w = int(tensor.shape[2])
    if source_w == target_w and source_h == target_h:
        return tensor
    scale = min(target_w / max(1, source_w), target_h / max(1, source_h))
    resize_w = max(1, min(target_w, int(round(source_w * scale))))
    resize_h = max(1, min(target_h, int(round(source_h * scale))))
    resized = F.interpolate(
        tensor.movedim(-1, 1),
        size=(resize_h, resize_w),
        mode="bilinear",
        align_corners=False,
    ).movedim(1, -1)
    padded = _pad_color_tensor(tensor, target_h, target_w, pad_color)
    top = max(0, (target_h - resize_h) // 2)
    left = max(0, (target_w - resize_w) // 2)
    padded[:, top:top + resize_h, left:left + resize_w, :] = resized
    return padded.clamp(0.0, 1.0).contiguous()


def _crop_tensor_to_size(tensor: torch.Tensor, target_w: int, target_h: int, keep_position: str = "中") -> torch.Tensor:
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    tensor = tensor[..., :3].float().clamp(0.0, 1.0).contiguous()
    target_w = max(1, int(target_w or 0))
    target_h = max(1, int(target_h or 0))
    source_h = int(tensor.shape[1])
    source_w = int(tensor.shape[2])
    if source_w == target_w and source_h == target_h:
        return tensor
    scale = max(target_w / max(1, source_w), target_h / max(1, source_h))
    resize_w = max(target_w, int(round(source_w * scale)))
    resize_h = max(target_h, int(round(source_h * scale)))
    resized = F.interpolate(
        tensor.movedim(-1, 1),
        size=(resize_h, resize_w),
        mode="bilinear",
        align_corners=False,
    ).movedim(1, -1)
    extra_h = max(0, resize_h - target_h)
    extra_w = max(0, resize_w - target_w)
    keep = str(keep_position or "中").strip()
    if keep == "上":
        top = 0
    elif keep == "下":
        top = extra_h
    else:
        top = extra_h // 2
    if keep == "左":
        left = 0
    elif keep == "右":
        left = extra_w
    else:
        left = extra_w // 2
    return resized[:, top:top + target_h, left:left + target_w, :].clamp(0.0, 1.0).contiguous()


def _stretch_tensor_to_size(tensor: torch.Tensor, target_w: int, target_h: int) -> torch.Tensor:
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    tensor = tensor[..., :3].float().clamp(0.0, 1.0).contiguous()
    target_w = max(1, int(target_w or 0))
    target_h = max(1, int(target_h or 0))
    if int(tensor.shape[2]) == target_w and int(tensor.shape[1]) == target_h:
        return tensor
    return F.interpolate(
        tensor.movedim(-1, 1),
        size=(target_h, target_w),
        mode="bilinear",
        align_corners=False,
    ).movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _cat_image_tensors_smart(tensors: list[torch.Tensor]) -> torch.Tensor | None:
    normalized = []
    for item in tensors:
        if item.ndim == 3:
            item = item.unsqueeze(0)
        if item.ndim == 4:
            normalized.append(item[..., :3].float().clamp(0.0, 1.0).contiguous())
    if not normalized:
        return None
    max_h = max(int(item.shape[1]) for item in normalized)
    max_w = max(int(item.shape[2]) for item in normalized)
    fitted = [_fit_pad_tensor_to_size(item, max_w, max_h) for item in normalized]
    return torch.cat(fitted, dim=0).contiguous()


def _first_image(value: Any) -> torch.Tensor | None:
    if value is None:
        return None
    if isinstance(value, torch.Tensor):
        tensor = value
    elif isinstance(value, (list, tuple)):
        tensors = [_first_image(item) for item in value]
        tensors = [item for item in tensors if isinstance(item, torch.Tensor)]
        if not tensors:
            return None
        return _cat_image_tensors_smart(tensors)
    elif isinstance(value, dict):
        tensor = None
        for key in ("images", "image", "frames"):
            candidate = _first_image(value.get(key))
            if candidate is not None:
                tensor = candidate
                break
        if tensor is None:
            return None
    else:
        return None
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        return None
    return tensor[..., :3].float().clamp(0.0, 1.0).contiguous()


def _resize_reference_images(images: Any, width: int, height: int, mode: str = "补边", pad_color: str = "黑色", keep_position: str = "中") -> torch.Tensor | None:
    tensor = _first_image(images)
    if tensor is None:
        return None
    mode_text = str(mode or "补边").strip().lower()
    if mode_text in {"原图", "none", "original", "不处理"}:
        return tensor
    if mode_text in {"拉伸", "stretch", "fill"}:
        return _stretch_tensor_to_size(tensor, width, height)
    if mode_text in {"裁剪", "crop", "cover"}:
        return _crop_tensor_to_size(tensor, width, height, keep_position)
    return _fit_pad_tensor_to_size(tensor, width, height, pad_color)


def _reference_target_size(kwargs: dict[str, Any]) -> tuple[int, int]:
    return int(kwargs.get("width") or 512), int(kwargs.get("height") or 896)


def _reference_resize_mode(kwargs: dict[str, Any]) -> str:
    value = str(kwargs.get("reference_resize_mode") or "补边").strip()
    return value if value in {"补边", "裁剪", "拉伸", "原图"} else "补边"


def _reference_crop_keep_position(kwargs: dict[str, Any]) -> str:
    value = str(kwargs.get("reference_crop_keep_position") or "中").strip()
    return value if value in {"上", "下", "左", "右", "中"} else "中"


def _video_size_mode(kwargs: dict[str, Any]) -> str:
    value = str(kwargs.get("video_size_mode") or "面板尺寸").strip()
    return value if value in {"面板尺寸", "原视频尺寸"} else "面板尺寸"


def _keep_model_loaded(kwargs: dict[str, Any]) -> bool:
    return _bool(kwargs.get("keep_model_loaded", False))


def _unwrap_result(value: Any) -> tuple[Any, dict[str, Any]]:
    if isinstance(value, dict) and "result" in value:
        ui = value.get("ui") if isinstance(value.get("ui"), dict) else {}
        result = value.get("result")
        return result, ui
    return value, {}


def _audio_duration_for_frames(frame_count: int, fps: float) -> float:
    return max(0.0, float(max(0, int(frame_count))) / max(1e-6, float(fps or 0.0)))


def _lora_chain_config(*names: str) -> str:
    items = [
        {"enabled": True, "name": str(name or "").strip(), "strength": 1.0}
        for name in names
        if str(name or "").strip()
    ]
    return json.dumps(items, ensure_ascii=False)


def _merge_lora_chain_configs(*configs: Any) -> str:
    items: list[dict[str, Any]] = []
    for config in configs:
        for item in parse_lora_data(normalize_lora_chain_data(config)):
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            try:
                strength = float(item.get("strength", 1.0))
            except (TypeError, ValueError):
                strength = 1.0
            items.append({
                "enabled": item.get("enabled", True) is not False,
                "name": name,
                "strength": strength,
            })
    return json.dumps(items, ensure_ascii=False)


def _active_lora_count(config: Any) -> int:
    count = 0
    for item in parse_lora_data(normalize_lora_chain_data(config)):
        if item.get("enabled", True) is False:
            continue
        if not str(item.get("name") or "").strip():
            continue
        try:
            strength = float(item.get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        if abs(strength) < 1e-8:
            continue
        count += 1
    return count


def _models_relative_dir(path: str) -> str:
    text = str(path or "").replace("\\", "/").strip("/")
    if text.lower().startswith("models/"):
        text = text[7:]
    return text


def _relative_model_files(path: str, extensions: tuple[str, ...] = ()) -> list[str]:
    rel_dir = _models_relative_dir(path)
    root = Path(getattr(folder_paths, "models_dir", Path.cwd() / "models")) / rel_dir
    exts = tuple(str(ext or "").lower() for ext in extensions if str(ext or "").strip())
    if not root.is_dir():
        return []
    names: list[str] = []
    seen: set[str] = set()
    def sort_key(item: Path) -> tuple[int, str]:
        suffix = item.suffix.lower()
        ext_rank = 0 if suffix == ".safetensors" else 1 if suffix == ".gguf" else 2
        return ext_rank, item.as_posix().lower()

    for file_path in sorted(root.rglob("*"), key=sort_key):
        if not file_path.is_file():
            continue
        rel = file_path.relative_to(root).as_posix()
        if exts and file_path.suffix.lower() not in exts:
            continue
        key = rel.lower()
        if key in seen:
            continue
        seen.add(key)
        names.append(rel)
    return names


def _matches_model_keywords(name: str, keywords: tuple[str, ...] | list[str]) -> bool:
    haystack = gjjutils_model_stem_without_quant(name)
    for keyword in keywords or []:
        parts = [part for part in gjjutils_model_stem_without_quant(str(keyword or "")).split(" ") if part]
        if parts and not all(part in haystack for part in parts):
            return False
    return True


def _find_models_in_relative_dir(
    path: str,
    keywords: tuple[str, ...] = (),
    extensions: tuple[str, ...] = (),
) -> list[str]:
    matches = []
    for name in _relative_model_files(path, extensions):
        item = str(name or "").strip()
        if not item:
            continue
        if keywords and not _matches_model_keywords(item, keywords):
            continue
        matches.append(item)
    return matches


def _pick_first_relative_model(path: str, keywords: tuple[str, ...], extensions: tuple[str, ...]) -> str:
    matches = _find_models_in_relative_dir(path, keywords, extensions)
    return matches[0] if matches else ""


def _is_no_lora_choice(value: Any) -> bool:
    text = str(value or "").strip().lower()
    compact = "".join(text.split())
    return text in NO_LORA_TOKENS or compact in {"不使用lora", "🚫不使用lora", "nolora", "none", "off", "disable", "disabled"}


def _resolve_relative_model_choice(selected: Any, path: str, keywords: tuple[str, ...], extensions: tuple[str, ...]) -> str:
    candidates = _find_models_in_relative_dir(path, keywords, extensions)
    if not candidates:
        return ""
    raw = str(selected or "").strip().replace("\\", "/").strip("/")
    if _is_no_lora_choice(raw):
        return ""
    raw_base = raw.rsplit("/", 1)[-1].lower()
    if raw:
        for candidate in candidates:
            key = candidate.replace("\\", "/").lower()
            if key == raw.lower() or key.rsplit("/", 1)[-1] == raw_base:
                return candidate
    return candidates[0]


def _resolve_optional_lora_choice(selected: Any, keywords: tuple[str, ...]) -> str:
    raw = str(selected or "").strip().replace("\\", "/").strip("/")
    if not raw or _is_no_lora_choice(raw):
        return ""
    candidates = _find_models_in_relative_dir("models/loras", keywords, (".safetensors",))
    raw_key = raw.lower()
    raw_base = raw_key.rsplit("/", 1)[-1]
    for candidate in candidates:
        key = candidate.replace("\\", "/").lower()
        if key == raw_key or key.rsplit("/", 1)[-1] == raw_base:
            return candidate
    return ""


def _pick_scail_model(selected: str = "") -> str:
    raw = str(selected or "").strip()
    scail_models = _find_models_in_relative_dir("models/diffusion_models", ("wan", "scail"), (".safetensors", ".gguf"))
    if raw and raw.lower().endswith((".safetensors", ".gguf")):
        raw_key = raw.replace("\\", "/").lower()
        raw_base = raw_key.rsplit("/", 1)[-1]
        for name in scail_models:
            name_key = name.replace("\\", "/").lower()
            if name_key == raw_key or name_key.rsplit("/", 1)[-1] == raw_base:
                return name
    return scail_models[0] if scail_models else ""


def _folder_models(path: str, extensions: list[str]) -> list[str]:
    return _relative_model_files(path, tuple(extensions or ()))


def _folder_roots(path: str) -> list[str]:
    return [f"models/{_models_relative_dir(path)}"]


def _reference_media_to_pil(item: dict[str, Any]) -> Image.Image:
    path = resolve_selected_image_path({
        "filename": str(item.get("filename") or ""),
        "subfolder": str(item.get("subfolder") or ""),
        "type": str(item.get("type") or "input"),
    })
    with Image.open(path) as opened:
        opened.load()
        return opened.convert("RGB")


def _model_field(name: str, label: str, folder: str, path: str, keywords: list[str], extensions: list[str], description: str, required: bool = False) -> dict[str, Any]:
    return {
        "name": name,
        "label": label,
        "folder": folder,
        "path": path,
        "keywords": [gjjutils_model_stem_without_quant(keyword) for keyword in keywords],
        "extensions": extensions,
        "description": description,
        "required": required,
    }


async def _get_scail2_aio_models(request):
    fields = [
        _model_field("model_file", "SCAIL2基本 / SCAIL模型", "diffusion_models", "models/diffusion_models", ["wan", "scail"], [".safetensors", ".gguf"], "【SCAIL2基本模型】SCAIL-2 主扩散模型；文件名建议同时包含 wan 和 scail。", True),
        _model_field("vae_file", "SCAIL2基本 / VAE", "vae", "models/vae", ["wan", "2.1", "vae"], [".safetensors"], "【SCAIL2基本模型】Wan 2.1 视频 VAE，用于条件编码、续段锚定解码和最终视频帧解码。", True),
        _model_field("text_encoder_file", "SCAIL2基本 / T5", "text_encoders", "models/text_encoders", ["umt5", "xxl"], [".safetensors"], "【SCAIL2基本模型】Wan T5 文本编码器，用于正向提示词和负向提示词编码。", True),
        _model_field("clip_vision_file", "SCAIL2基本 / CLIP Vision", "clip_vision", "models/clip_vision", ["clip", "vision"], [".safetensors"], "【SCAIL2基本模型】CLIP Vision 参考图编码器，用于增强参考图语义一致性。", True),
        _model_field("accel_lora_file", "SCAIL2基本 / 加速LoRA", "loras", "models/loras", ["lightx2v", "i2v", "14b"], [".safetensors"], "【SCAIL2基本模型】LightX2V I2V 14B 加速 LoRA；开启“使用加速LoRA”时叠加，也可选择“不使用 LoRA”。"),
        _model_field("dpo_lora_file", "SCAIL2基本 / DPO LoRA", "loras", "models/loras", ["scail", "dpo"], [".safetensors"], "【SCAIL2基本模型】SCAIL-2 DPO 修正 LoRA，可增强动作迁移/人物替换效果，也可选择“不使用 LoRA”。"),
        _model_field("slop_bounce_lora_file", "SCAIL2基本 / Slop Bounce", "loras", "models/loras", ["slop", "bounce"], [".safetensors"], "【SCAIL2基本模型】弹跳 LoRA，不变脸方向，也可选择“不使用 LoRA”。"),
        _model_field("relighting_lora_file", "SCAIL2基本 / Relighting LoRA", "loras", "models/loras", ["scail", "relighting"], [".safetensors"], "【SCAIL2基本模型】SCAIL-2 Relighting LoRA，用于增强/调整光照效果，也可选择“不使用 LoRA”。"),
        _model_field("sam3_checkpoint", "SCAIL2基本 / SAM3", "checkpoints", "models/checkpoints", ["sam3.1", "multiplex"], [".safetensors"], "【SCAIL2基本模型】SAM3.1 Multiplex checkpoint，用于目标跟踪并生成 SCAIL-2 彩色身份遮罩。", True),
        _model_field("multiview_unet", "可选多视图 / 主模型", "diffusion_models", "models/diffusion_models", ["qwen", "image", "edit", "2511"], [".safetensors", ".gguf"], "【可选多视图/多角度模型】按 GJJ_CharacterMultiViewStudio 的 2511 链路使用 Qwen Image Edit 主模型。"),
        _model_field("multiview_clip", "可选多视图 / CLIP", "text_encoders", "models/text_encoders", ["qwen", "2.5", "vl"], [".safetensors", ".gguf"], "【可选多视图/多角度模型】2511 链路使用的 Qwen 2.5 VL 文本/视觉编码器。"),
        _model_field("multiview_vae", "可选多视图 / VAE", "vae", "models/vae", ["qwen", "image", "vae"], [".safetensors"], "【可选多视图/多角度模型】2511 链路使用的 Qwen Image VAE。"),
        _model_field("multiview_lora_1", "可选多视图 / Lightning LoRA", "loras", "models/loras", ["qwen", "lightning"], [".safetensors"], "【可选多视图/多角度模型】2511 链路使用的 Lightning / 加速 LoRA，也可选择“不使用 LoRA”。"),
        _model_field("multiview_lora_2", "可选多视图 / 多角度LoRA", "loras", "models/loras", ["multiple", "angles"], [".safetensors"], "【可选多视图/多角度模型】2511 链路使用的多角度一致性 LoRA，也可选择“不使用 LoRA”。"),
        _model_field("multiview_lora_3", "可选多视图 / 第3 LoRA", "loras", "models/loras", ["qwen", "edit"], [".safetensors"], "【可选多视图/多角度模型】可选第3组微调模型，也可选择“不使用 LoRA”。"),
        _model_field("rmbg_model", "可选多视图 / RMBG抠图模型", "RMBG", "models/RMBG", ["rmbg", "1.4"], [".safetensors", ".pth"], "【可选多视图/多角度模型】GJJ_CharacterMultiViewStudio 人物资产分支、批量去背景与 GJJ_RemoveBgStitch 拼接图片使用的 RMBG1.4 模型。"),
    ]
    return web.json_response({
        "ok": True,
        "fields": [
            {
                **field,
                "models": _folder_models(str(field["path"]), list(field["extensions"])),
                "roots": _folder_roots(str(field["path"])),
            }
            for field in fields
        ],
    })


async def _post_scail2_aio_stitch_references(request):
    try:
        data = await request.json()
        refs = data.get("references") if isinstance(data, dict) else []
        if not isinstance(refs, list) or not refs:
            raise ValueError("请先选择要拼接的参考图片。")
        images = [_reference_media_to_pil(item) for item in refs if isinstance(item, dict)]
        if not images:
            raise ValueError("没有可用的参考图片。")
        from .gjj_comprehensive_matting import _pil_list_to_tensor, _tensor_to_pil_list
        from .gjj_remove_bg_stitch import GJJ_RemoveBgStitch

        width = int(data.get("width") or 1024)
        height = int(data.get("height") or 1024)
        foreground = _pil_list_to_tensor(images)
        result = GJJ_RemoveBgStitch().stitch(
            foreground=foreground,
            width=width,
            height=height,
            background=None,
            layer_config="",
            background_color=str(data.get("background_color") or "#20262D"),
            background_fit="等比留边",
            device="自动",
            process_res=1024,
            threshold=0.0,
            mask_blur=0.0,
            unique_id="gjj_scail2_director_stitch",
        )
        payload = result.get("ui", {}).get("gjj_remove_bg_stitch", [{}])[0] if isinstance(result, dict) else {}
        image_tensor = result.get("result", (None,))[0] if isinstance(result, dict) else None
        saved = None
        if isinstance(payload, dict) and isinstance(payload.get("composite"), dict):
            saved = payload["composite"]
        if saved is None:
            pil_images = _tensor_to_pil_list(image_tensor)
            if not pil_images:
                raise RuntimeError("拼接节点没有返回图像。")
            saved = gjjutils_write_temp_pil_image(pil_images[0].convert("RGBA"), format="PNG", suffix=".png")
        return web.json_response({"ok": True, "image": saved, "images": [saved], "preview": payload})
    except Exception as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


async def _post_scail2_aio_remove_background_references(request):
    try:
        data = await request.json()
        refs = data.get("references") if isinstance(data, dict) else []
        if not isinstance(refs, list) or not refs:
            raise ValueError("请先选择要去除背景的参考图片。")
        images = [_reference_media_to_pil(item) for item in refs if isinstance(item, dict)]
        if not images:
            raise ValueError("没有可用的参考图片。")
        from .gjj_comprehensive_matting import GJJ_ComprehensiveMatting, METHOD_RMBG14, _pil_list_to_tensor, _tensor_to_pil_list

        foreground = _pil_list_to_tensor(images)
        result = GJJ_ComprehensiveMatting().remove_background(
            matting_method=METHOD_RMBG14,
            background="透明",
            device="自动",
            process_res=1024,
            threshold=0.0,
            mask_blur=0.0,
            media=foreground,
            prompt={},
            extra_pnginfo={},
            unique_id="gjj_scail2_director_remove_bg",
        )
        image_tensor = result.get("result", (None,))[0] if isinstance(result, dict) else result[0]
        pil_images = _tensor_to_pil_list(image_tensor)
        if not pil_images:
            raise RuntimeError("去除背景节点没有返回图片。")
        saved = [
            gjjutils_write_temp_pil_image(image.convert("RGBA"), format="PNG", suffix=".png")
            for image in pil_images
        ]
        return web.json_response({"ok": True, "images": saved})
    except Exception as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


async def _post_scail2_aio_upload_audio(request):
    try:
        reader = await request.multipart()
        saved: list[dict[str, Any]] = []
        while True:
            field = await reader.next()
            if field is None:
                break
            if field.name not in {"audio", "file"}:
                continue
            source_name = Path(str(field.filename or "audio.wav")).name
            suffix = Path(source_name).suffix.lower()
            if suffix not in AUDIO_EXTENSIONS:
                return web.json_response({"ok": False, "error": f"不支持的音频格式：{source_name}"}, status=400)
            tmp_path = gjjutils_temp_path(f".upload_audio_{os.getpid()}_{next(tempfile._get_candidate_names())}{suffix}")
            try:
                with tmp_path.open("wb") as handle:
                    while True:
                        chunk = await field.read_chunk()
                        if not chunk:
                            break
                        handle.write(chunk)
                info = gjjutils_write_temp_file(tmp_path, suffix=suffix)
                info.update({"media_type": "audio", "label": source_name})
                saved.append(info)
            finally:
                try:
                    tmp_path.unlink(missing_ok=True)
                except Exception:
                    pass
        if not saved:
            return web.json_response({"ok": False, "error": "没有收到音频文件。"}, status=400)
        return web.json_response({"ok": True, "audios": saved})
    except Exception as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


class GJJ_SCAIL2LongVideoAIO:
    CATEGORY = "GJJ/视频生成/SCAIL"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "把 SCAIL2 超长视频极简工作流收敛为单节点：两个可选输入口，内部完成视频读取、"
        "参考图读取、模型加载、SAM3 彩色遮罩、长视频采样和视频合成。"
    )
    RETURN_TYPES = (OUTPUT_TYPE,)
    RETURN_NAMES = ("视频/图片",)
    OUTPUT_TOOLTIPS = ("官方 VIDEO 输出；端口类型同时标记 VIDEO,IMAGE 以便连接到兼容视频或图片帧队列的节点。",)
    SEARCH_ALIASES = [
        "SCAIL2 AIO",
        "SCAIL2超长视频",
        "动作驱动",
        "人物替换",
        "零依赖单节点",
    ]
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": DESCRIPTION,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "model_tree": [
            {
                "label": "【SCAIL2基本模型】包含 wan + scail 的 SCAIL 主模型",
                "path": "models/diffusion_models",
                "filename": "wan2.1_14B_SCAIL_2_fp8_scaled.safetensors",
                "required": True,
                "description": "SCAIL-2 主扩散模型。🧠 浮窗里的“SCAIL模型”会按关键词 wan + scail 从 diffusion_models 中过滤；也支持同目录下 .gguf 候选。",
            },
            {
                "label": "【SCAIL2基本模型】文件名包含 wan + 2.1 + vae 的 VAE",
                "path": "models/vae",
                "filename": "wan_2.1_vae.safetensors",
                "required": True,
                "description": "Wan 2.1 视频 VAE，用于 SCAIL 条件编码、续段锚定解码和最终视频帧解码。",
            },
            {
                "label": "【SCAIL2基本模型】文件名包含 umt5 + xxl 的 T5 文本编码器",
                "path": "models/text_encoders",
                "filename": "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
                "required": True,
                "description": "Wan T5 文本编码器，用于正向提示词和负向提示词编码。默认提示词为空时可配合“条件零化”输出稳定空负向条件。",
            },
            {
                "label": "【SCAIL2基本模型】文件名包含 clip + vision 的 CLIP Vision",
                "path": "models/clip_vision",
                "filename": "clip_vision_h.safetensors",
                "required": True,
                "description": "CLIP Vision 参考图编码器。连接或选择参考图时用于增强参考图语义一致性；运行时不可用会自动跳过 CLIP Vision 条件。",
            },
            {
                "label": "【SCAIL2基本模型】文件名包含 lightx2v + i2v + 14b 的加速 LoRA",
                "path": "models/loras",
                "filename": DEFAULT_SCAIL2_ACCEL_LORA,
                "required": False,
                "description": "LightX2V 加速 LoRA。默认开启“使用加速LoRA”；关闭开关或在 🧠 列表选择“不使用 LoRA”后不叠加该 LoRA。",
            },
            {
                "label": "【SCAIL2基本模型】文件名包含 scail + dpo 的 DPO LoRA",
                "path": "models/loras",
                "filename": DEFAULT_SCAIL2_DPO_LORA,
                "required": False,
                "description": "SCAIL-2 DPO LoRA，用于增强 SCAIL2 动作迁移/人物替换效果；可在 🧠 列表选择“不使用 LoRA”禁用。",
            },
            {
                "label": "【SCAIL2基本模型】文件名包含 slop + bounce 的 LoRA",
                "path": "models/loras",
                "filename": "i2v_slop_bounce.safetensors",
                "required": False,
                "description": "Slop Bounce 弹跳 LoRA，关键词 wan / i2v / slop / bounce；可在 🧠 列表选择“不使用 LoRA”禁用。",
            },
            {
                "label": "【可选多视图/多角度模型】主模型",
                "path": "models/diffusion_models",
                "filename": "qwen_image_edit_2511_int8_convrot.safetensors",
                "required": False,
                "description": "导演台“生成多视图”调用 GJJ_CharacterMultiViewStudio 时使用的 Qwen Image Edit 2511 主模型。",
            },
            {
                "label": "【可选多视图/多角度模型】CLIP 文本编码器",
                "path": "models/text_encoders",
                "filename": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
                "required": False,
                "description": "2511 多视图生成使用的 Qwen 2.5 VL 文本/视觉编码器；留空时会按 GJJ_CharacterMultiViewStudio 的模型族规则自动匹配。",
            },
            {
                "label": "【可选多视图/多角度模型】VAE",
                "path": "models/vae",
                "filename": "qwen_image_vae.safetensors",
                "required": False,
                "description": "2511 多视图生成使用的 Qwen Image VAE；留空时会按 GJJ_CharacterMultiViewStudio 的模型族规则自动匹配。",
            },
            {
                "label": "【可选多视图/多角度模型】Lightning / 加速 LoRA",
                "path": "models/loras",
                "filename": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
                "required": False,
                "description": "多视图生成第1组 LoRA，通常用于加速或适配当前编辑模型；可在 🧠 列表选择“不使用 LoRA”禁用。",
            },
            {
                "label": "【可选多视图/多角度模型】多角度 LoRA",
                "path": "models/loras",
                "filename": "qwen-image-edit-2511-multiple-angles-lora.safetensors",
                "required": False,
                "description": "多视图生成第2组 LoRA，用于角色/产品的多角度一致性；可在 🧠 列表选择“不使用 LoRA”禁用。",
            },
            {
                "label": "【可选多视图/多角度模型】RMBG1.4 去背景 / 拼接模型",
                "path": "models/RMBG",
                "filename": "rmbg1.4.safetensors",
                "required": False,
                "description": "去背景、拼接图片，以及多视图人物资产分支调用 RMBG1.4 时使用。",
            },
            {
                "label": "【SCAIL2基本模型】文件名包含 sam3 + multiplex 的 checkpoint",
                "path": "models/checkpoints",
                "filename": "sam3.1_multiplex.safetensors",
                "required": True,
                "description": "SAM3.1 Multiplex checkpoint，用于内部双通道目标跟踪并生成 SCAIL-2 彩色身份遮罩。",
            },
            {
                "label": "【SCAIL2基本模型】中英翻译模型包",
                "path": "models/translation",
                "filename": "opus-mt-zh-en.safetensors",
                "required": True,
                "description": "GJJ 单文件中英翻译模型包。SAM3 跟踪目标为中文时会在跟踪前翻译为英文。",
            },
        ],
        "copy_text": (
            "ComfyUI/\n"
            "├── models/\n"
            "│   ├── diffusion_models/\n"
            "│   │   └── wan2.1_14B_SCAIL_2_fp8_scaled.safetensors\n"
            "│   │   └── qwen_image_edit_2511_int8_convrot.safetensors\n"
            "│   ├── vae/\n"
            "│   │   └── wan_2.1_vae.safetensors\n"
            "│   │   └── qwen_image_vae.safetensors\n"
            "│   ├── text_encoders/\n"
            "│   │   └── umt5_xxl_fp8_e4m3fn_scaled.safetensors\n"
            "│   │   └── qwen_2.5_vl_7b_fp8_scaled.safetensors\n"
            "│   ├── clip_vision/\n"
            "│   │   └── clip_vision_h.safetensors\n"
            "│   ├── loras/\n"
            "│   │   └── lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors\n"
            "│   │   └── wan2.1_SCAIL_2_DPO_lora_bf16.safetensors\n"
            "│   │   └── i2v_slop_bounce.safetensors\n"
            "│   │   └── Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors\n"
            "│   │   └── qwen-image-edit-2511-multiple-angles-lora.safetensors\n"
            "│   ├── RMBG/\n"
            "│   │   └── rmbg1.4.safetensors\n"
            "│   ├── checkpoints/\n"
            "│   │   └── sam3.1_multiplex.safetensors\n"
            "│   └── translation/\n"
            "│       └── opus-mt-zh-en.safetensors"
        ),
        "copy_label": "复制 SCAIL2 AIO 模型树",
        "usage": [
            "只需要连接原视频和/或参考图；没有连接时可用节点面板按钮选择 input 目录中的视频和图片。",
            "面板参数由浮窗维护，后端所有默认值都在 Python INPUT_TYPES 中声明。",
            "模式关闭为动作驱动，开启为人物替换。",
            "🎬 和 👤 会打开系统文件选择器并导入到 ComfyUI input 目录；外部连接存在时按钮会禁用。",
            "🔗 会记住上游节点并断开连接，再次点击恢复连接。",
            "📐 调整尺寸、帧率兜底值、最大帧数、窗口长度和续段锚定帧数；正常情况下输出帧率优先沿用原视频。",
            "🧠 显示按关键词过滤后的模型文件列表，支持 safetensors 和主模型 gguf 候选。",
            "⚙️ 调整采样、SAM3 跟踪、输出格式和负向提示词等其它参数；正向提示词固定显示为原生多行控件。",
        ],
        "dependencies": [
            "运行时只调用本包内置 GJJ 节点和 ComfyUI 基础节点，不需要保留原 JSON 工作流里的外部节点。",
            "仍需要本地存在对应 SCAIL2、VAE、T5、CLIP Vision、SAM3 和可选 LoRA 模型文件。",
        ],
        "inputs": {
            "原视频": "非必选。支持 VIDEO 或 IMAGE 帧队列。未连接时使用 🎬 按钮选择的视频文件。",
            "参考图": "非必选。支持 GJJ_BATCH_IMAGE 或 IMAGE。未连接时使用 👤 按钮选择的图片文件；多图时会作为批量参考图传入。",
            "正向提示词": "原生多行控件，直接显示在节点面板上；默认可留空。",
        },
        "outputs": {
            "视频/图片": "返回官方 VIDEO 对象，端口标记为 VIDEO,IMAGE，便于继续连接兼容视频或图片帧队列的节点。",
        },
        "runtime": [
            "内部先读取原视频帧和参考图，再用视频通用模型加载器载入 SCAIL 主模型、VAE、T5、CLIP Vision 和可选 LoRA。",
            "使用 CLIP 提示词面板逻辑生成正负 CONDITIONING；zero_conditioning 开启时用正向条件结构生成零化负向条件。",
            "使用 SAM3.1 双通道跟踪：通道1是原视频，通道2是参考图；根据动作驱动/人物替换模式生成不同背景约定的彩色遮罩。",
            "使用 GJJ_WanSCAILInfinity 分段循环采样，默认窗口 121 帧、锚定 5 帧，并在每段完成后保存 WebP 预览。",
            "最后调用 GJJ_VideoCombine 写出视频文件并返回官方 VIDEO 输出；输出帧率和音频优先沿用原视频。",
        ],
        "troubleshooting": [
            {
                "problem": "🧠 浮窗某一项没有候选模型",
                "solution": "确认模型放在对应目录，并检查文件名是否包含该项关键词。例如 SCAIL 主模型建议包含 wan 和 scail；SAM3 模型建议包含 sam3.1_multiplex。",
            },
            {
                "problem": "SAM3 跟踪失败或遮罩为空",
                "solution": "确认 models/checkpoints 中有 SAM3.1 Multiplex checkpoint，并把 ⚙️ 里的跟踪目标改成英文 person / face / body 等更明确的词。",
            },
            {
                "problem": "视频生成很慢或显存不足",
                "solution": "在 📐 降低宽高或最大帧数，在 ⚙️ 开启分块解码，或在 🧠 使用更低显存的主模型/量化模型。",
            },
            {
                "problem": "参考图没有明显影响",
                "solution": "确认参考图已选择或连接，并检查 CLIP Vision 模型是否在 models/clip_vision 中；人物替换模式下可提高参考图与目标人物的清晰度。",
            },
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "selected_video_json": (
                    "STRING",
                    {"default": "[]", "hidden": True, "display": "hidden", "display_name": "已选参考视频"},
                ),
                "selected_reference_json": (
                    "STRING",
                    {"default": "[]", "hidden": True, "display": "hidden", "display_name": "已选参考图片"},
                ),
                "mode_replacement": (
                    "BOOLEAN",
                    {"default": False, "hidden": True, "display": "hidden", "display_name": "人物替换"},
                ),
                "width": (
                    "INT",
                    {"default": 512, "min": 320, "max": 2048, "step": 16, "hidden": True, "display": "hidden", "display_name": "宽度"},
                ),
                "height": (
                    "INT",
                    {"default": 896, "min": 320, "max": 2048, "step": 16, "hidden": True, "display": "hidden", "display_name": "高度"},
                ),
                "frame_rate": (
                    "FLOAT",
                    {"default": 8.0, "min": 1.0, "max": 240.0, "step": 1.0, "hidden": True, "display": "hidden", "display_name": "帧率"},
                ),
                "max_frames": (
                    "INT",
                    {"default": 0, "min": 0, "max": 100000, "step": 1, "hidden": True, "display": "hidden", "display_name": "最大帧数"},
                ),
                "window_length": (
                    "INT",
                    {"default": 121, "min": 5, "max": 100000, "step": 4, "hidden": True, "display": "hidden", "display_name": "窗口帧数"},
                ),
                "previous_frame_count": (
                    "INT",
                    {"default": 5, "min": 1, "max": 1000, "step": 4, "hidden": True, "display": "hidden", "display_name": "锚定帧数"},
                ),
                "seed": (
                    "INT",
                    {"default": 1, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "hidden": True, "display": "hidden", "display_name": "种子"},
                ),
                "steps": (
                    "INT",
                    {"default": 6, "min": 1, "max": 10000, "hidden": True, "display": "hidden", "display_name": "步数"},
                ),
                "cfg": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1, "hidden": True, "display": "hidden", "display_name": "CFG"},
                ),
                "sampler_name": (
                    ["euler", "uni_pc", "dpmpp_2m"],
                    {"default": "euler", "hidden": True, "display": "hidden", "display_name": "采样器"},
                ),
                "scheduler": (
                    ["simple", "normal", "beta"],
                    {"default": "simple", "hidden": True, "display": "hidden", "display_name": "调度器"},
                ),
                "denoise": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "hidden": True, "display": "hidden", "display_name": "降噪"},
                ),
                "pose_strength": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01, "hidden": True, "display": "hidden", "display_name": "姿态强度"},
                ),
                "pose_start": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01, "hidden": True, "display": "hidden", "display_name": "姿态开始"},
                ),
                "pose_end": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "hidden": True, "display": "hidden", "display_name": "姿态结束"},
                ),
                "negative_prompt": (
                    "STRING",
                    {"default": DEFAULT_NEGATIVE_PROMPT, "multiline": False, "hidden": True, "display": "hidden", "display_name": "负向提示词"},
                ),
                "zero_conditioning": (
                    "BOOLEAN",
                    {"default": True, "hidden": True, "display": "hidden", "display_name": "条件零化"},
                ),
                "model_file": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "SCAIL模型"},
                ),
                "vae_file": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "VAE"},
                ),
                "text_encoder_file": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "T5"},
                ),
                "clip_vision_file": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "CLIP Vision"},
                ),
                "accel_lora_file": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "加速LoRA"},
                ),
                "sam3_checkpoint": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "SAM3模型"},
                ),
                "model_dtype": (
                    "STRING",
                    {"default": "fp8_e4m3fn", "hidden": True, "display": "hidden", "display_name": "模型dtype"},
                ),
                "use_accel_lora": (
                    "BOOLEAN",
                    {"default": True, "hidden": True, "display": "hidden", "display_name": "使用加速LoRA"},
                ),
                "enable_model_sampling_sd3": (
                    "BOOLEAN",
                    {"default": True, "hidden": True, "display": "hidden", "display_name": "ModelSamplingSD3"},
                ),
                "model_sampling_sd3_shift": (
                    "FLOAT",
                    {"default": 5.0, "min": 0.0, "max": 100.0, "step": 0.01, "hidden": True, "display": "hidden", "display_name": "SD3移位"},
                ),
                "sam3_target": (
                    "STRING",
                    {"default": "person", "hidden": True, "display": "hidden", "display_name": "跟踪目标"},
                ),
                "sam3_object_indices": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "对象编号"},
                ),
                "sam3_detection_threshold": (
                    "STRING",
                    {"default": "0.5", "hidden": True, "display": "hidden", "display_name": "检测阈值"},
                ),
                "sam3_max_objects": (
                    "INT",
                    {"default": 1, "min": 0, "max": 64, "hidden": True, "display": "hidden", "display_name": "最大对象数"},
                ),
                "sam3_detect_interval": (
                    "INT",
                    {"default": 1, "min": 1, "max": 999, "hidden": True, "display": "hidden", "display_name": "检测间隔"},
                ),
                "sam3_sort_by": (
                    ["从左到右", "面积从大到小", "保持原顺序"],
                    {"default": "从左到右", "hidden": True, "display": "hidden", "display_name": "颜色排序"},
                ),
                "decode_tiled": (
                    "BOOLEAN",
                    {"default": False, "hidden": True, "display": "hidden", "display_name": "分块解码"},
                ),
                "vary_seed_per_window": (
                    "BOOLEAN",
                    {"default": True, "hidden": True, "display": "hidden", "display_name": "每段递增种子"},
                ),
                "output_format": (
                    "STRING",
                    {"default": "video/h264-mp4", "hidden": True, "display": "hidden", "display_name": "输出格式"},
                ),
                "filename_prefix": (
                    "STRING",
                    {"default": "video/SCAIL2_AIO", "hidden": True, "display": "hidden", "display_name": "文件名前缀"},
                ),
                "dpo_lora_file": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "DPO LoRA"},
                ),
                "slop_bounce_lora_file": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "Slop Bounce LoRA"},
                ),
                "director_storyboard_json": (
                    "STRING",
                    {"default": "{}", "hidden": True, "display": "hidden", "display_name": "导演分镜"},
                ),
                "selected_audio_json": (
                    "STRING",
                    {"default": "[]", "hidden": True, "display": "hidden", "display_name": "已选音频轨道"},
                ),
                "reference_resize_mode": (
                    ["补边", "裁剪", "拉伸", "原图"],
                    {"default": "补边", "hidden": True, "display": "hidden", "display_name": "参考图缩放方法"},
                ),
                "video_size_mode": (
                    ["面板尺寸", "原视频尺寸"],
                    {"default": "面板尺寸", "hidden": True, "display": "hidden", "display_name": "视频尺寸来源"},
                ),
                "reference_pad_color": (
                    ["黑色", "灰色", "白色", "边缘均色"],
                    {"default": "黑色", "hidden": True, "display": "hidden", "display_name": "参考图补边底色"},
                ),
                "keep_model_loaded": (
                    "BOOLEAN",
                    {"default": False, "hidden": True, "display": "hidden", "display_name": "保持模型"},
                ),
                "reference_crop_keep_position": (
                    ["上", "下", "左", "右", "中"],
                    {"default": "中", "hidden": True, "display": "hidden", "display_name": "裁剪保留位置"},
                ),
                "multiview_unet": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "多视图主模型"},
                ),
                "multiview_clip": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "多视图CLIP"},
                ),
                "multiview_vae": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "多视图VAE"},
                ),
                "multiview_lora_1": (
                    "STRING",
                    {"default": DEFAULT_QWEN2511_LIGHTNING_LORA, "hidden": True, "display": "hidden", "display_name": "多视图LoRA 1"},
                ),
                "multiview_lora_2": (
                    "STRING",
                    {"default": DEFAULT_MULTI_ANGLES_LORA, "hidden": True, "display": "hidden", "display_name": "多视图LoRA 2"},
                ),
                "multiview_lora_3": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "多视图第3 LoRA"},
                ),
                "rmbg_model": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "RMBG抠图模型"},
                ),
                "relighting_lora_file": (
                    "STRING",
                    {"default": "", "hidden": True, "display": "hidden", "display_name": "Relighting LoRA"},
                ),
            },
            "optional": {
                "positive_prompt": (
                    "STRING",
                    {"default": "", "multiline": False, "display_name": "正向提示词", "tooltip": "可留空。旧工作流缺少该输入时会按空提示词处理；需要指定画面内容时在这里填写。"},
                ),
                "original_video": (
                    VIDEO_INPUT_TYPE,
                    {"display_name": "原视频", "tooltip": "非必选。连接 VIDEO 或 IMAGE 帧队列后，面板的视频选择按钮会禁用。"},
                ),
                "reference_image": (
                    REFERENCE_INPUT_TYPE,
                    {"display_name": "参考图", "tooltip": "非必选。连接 GJJ_BATCH_IMAGE 或 IMAGE 后，面板的参考图按钮会禁用。"},
                ),
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "forceInput": True,
                        "display_name": "LoRA串联配置",
                        "tooltip": "对齐 GJJ_LoraChainConfig 输出；会追加到 SCAIL 内置 DPO / Slop Bounce / Relighting LoRA 后继续叠加。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def _load_video_source(self, original_video: Any, kwargs: dict[str, Any]) -> tuple[torch.Tensor, float, Any]:
        unique_id = kwargs.get("unique_id")
        _progress(unique_id, "1/9 检查原视频输入...", 0.01)
        external = GJJ_MultiVideoLoader._coerce_external_video(original_video)
        if external is not None:
            _progress(unique_id, "1/9 读取外部 VIDEO/IMAGE 帧队列...", 0.015)
            frames = _first_image(external.get("frames"))
            if frames is None:
                raise RuntimeError("原视频输入没有解析出可用视频帧。")
            fps = float(external.get("fps") or kwargs.get("frame_rate") or 8.0)
            audio = external.get("audio")
            _progress(unique_id, f"1/9 外部原视频：{int(frames.shape[0])} 帧，帧率 {fps:.3g}", 0.025)
            max_frames = int(kwargs.get("max_frames") or 0)
            if max_frames > 0:
                _progress(unique_id, f"1/9 按最大帧数裁切到 {max_frames} 帧，并同步裁切音频...", 0.03)
                frames = frames[:max_frames].contiguous()
                audio = _slice_audio_window(audio, 0.0, _audio_duration_for_frames(int(frames.shape[0]), fps))
            return frames, fps, audio

        selected = _json_text(kwargs.get("selected_video_json"), "[]")
        selected_entries = parse_selected_videos(selected)
        source_fps = float(kwargs.get("frame_rate") or 8.0)
        source_audio = None
        if selected_entries:
            try:
                _progress(unique_id, "1/9 解析面板选择的视频文件路径...", 0.015)
                path = resolve_input_video_path(selected_entries[0])
                _progress(unique_id, f"1/9 读取源视频信息：{path.name}", 0.02)
                meta = video_meta(path)
                source_fps = float(meta.get("fps") or source_fps)
                max_frames = max(1, int(kwargs.get("max_frames") or 100000))
                start_seconds, duration_seconds = _audio_window_from_meta(meta, 0, 0, 1, max_frames)
                _progress(unique_id, f"1/9 提取原视频音频：{duration_seconds:.2f}s，帧率 {source_fps:.3g}", 0.025)
                source_audio = decode_audio_ffmpeg(path, start_seconds, duration_seconds)
            except Exception as exc:
                log.warning("读取原视频音频/帧率失败，已只使用视频帧：%s", exc)

        _progress(unique_id, "1/9 解码原视频帧队列...", 0.035)
        loader = GJJ_MultiVideoLoader()
        loaded = loader.load_videos(
            frame_rate=source_fps,
            width=0,
            height=0,
            video_format=kwargs.get("output_format"),
            start_frame=0,
            end_frame=0,
            frame_stride=1,
            max_frames=max(1, int(kwargs.get("max_frames") or 100000)),
            selected_videos_json=selected,
            input_frames=None,
            prompt=kwargs.get("prompt"),
            extra_pnginfo=kwargs.get("extra_pnginfo"),
            unique_id=kwargs.get("unique_id"),
        )
        result, ui = _unwrap_result(loaded)
        frames = _first_image(result[0] if isinstance(result, (list, tuple)) else result)
        if frames is None:
            raise RuntimeError("请连接原视频，或点击 🎬 选择一个参考视频。")
        try:
            source_fps = float((ui.get("frame_rate") or [source_fps])[0] or source_fps)
        except Exception:
            pass
        if source_audio is not None:
            _progress(unique_id, "1/9 对齐音频长度到输出帧数...", 0.055)
            source_audio = _slice_audio_window(source_audio, 0.0, _audio_duration_for_frames(int(frames.shape[0]), source_fps))
        _progress(unique_id, f"1/9 原视频准备完成：{int(frames.shape[0])} 帧，{source_fps:.3g} fps", 0.06)
        return frames, source_fps, source_audio

    def _load_reference_image(self, reference_image: Any, kwargs: dict[str, Any]) -> Any:
        unique_id = kwargs.get("unique_id")
        _progress(unique_id, "2/9 检查参考图输入...", 0.065)
        direct = _first_image(reference_image)
        if direct is not None:
            width, height = _reference_target_size(kwargs)
            mode = _reference_resize_mode(kwargs)
            pad_color = _reference_pad_color(kwargs)
            keep_position = _reference_crop_keep_position(kwargs)
            padded = _resize_reference_images(direct, width, height, mode, pad_color, keep_position)
            if padded is None:
                padded = direct
            _progress(unique_id, f"2/9 使用外部参考图：{int(padded.shape[0])} 张，缩放方法：{mode}，补边底色：{pad_color}，保留位置：{keep_position}", 0.075)
            return padded

        selected = _json_text(kwargs.get("selected_reference_json"), "[]")
        if selected == "[]":
            _progress(unique_id, "2/9 未提供参考图，继续空参考流程。", 0.075)
            return None
        _progress(unique_id, "2/9 读取面板选择的参考图...", 0.07)
        loader = GJJ_MultiImageLoader()
        loaded = loader.load_images(
            selected_images=selected,
            sequence_range="",
            input_images=None,
            prompt=kwargs.get("prompt"),
            extra_pnginfo=kwargs.get("extra_pnginfo"),
            unique_id=kwargs.get("unique_id"),
        )
        result, _ui = _unwrap_result(loaded)
        if isinstance(result, (list, tuple)) and result:
            width, height = _reference_target_size(kwargs)
            mode = _reference_resize_mode(kwargs)
            pad_color = _reference_pad_color(kwargs)
            keep_position = _reference_crop_keep_position(kwargs)
            padded = _resize_reference_images(result[0], width, height, mode, pad_color, keep_position)
            if padded is not None:
                _progress(unique_id, f"2/9 参考图准备完成：{int(padded.shape[0])} 张，缩放方法：{mode}，补边底色：{pad_color}，保留位置：{keep_position}", 0.08)
                return padded
            count = len(result[0]) if isinstance(result[0], list) else (int(result[0].shape[0]) if isinstance(result[0], torch.Tensor) else 1)
            _progress(unique_id, f"2/9 参考图准备完成：{count} 张", 0.08)
            return result[0]
        _progress(unique_id, "2/9 参考图准备完成。", 0.08)
        return result

    def _load_reference_items(self, items: list[dict[str, Any]], kwargs: dict[str, Any]) -> Any:
        refs = [item for item in items or [] if isinstance(item, dict) and str(item.get("filename") or "").strip()]
        if not refs:
            return None
        loader = GJJ_MultiImageLoader()
        loaded = loader.load_images(
            selected_images=json.dumps(refs, ensure_ascii=False),
            sequence_range="",
            input_images=None,
            prompt=kwargs.get("prompt"),
            extra_pnginfo=kwargs.get("extra_pnginfo"),
            unique_id=kwargs.get("unique_id"),
        )
        result, _ui = _unwrap_result(loaded)
        if isinstance(result, (list, tuple)) and result:
            width, height = _reference_target_size(kwargs)
            padded = _resize_reference_images(result[0], width, height, _reference_resize_mode(kwargs), _reference_pad_color(kwargs), _reference_crop_keep_position(kwargs))
            return padded if padded is not None else result[0]
        width, height = _reference_target_size(kwargs)
        padded = _resize_reference_images(result, width, height, _reference_resize_mode(kwargs), _reference_pad_color(kwargs), _reference_crop_keep_position(kwargs))
        return padded if padded is not None else result

    @staticmethod
    def _resolve_audio_path(item: dict[str, Any]) -> Path:
        if not isinstance(item, dict):
            raise RuntimeError("音频轨道数据无效。")
        filename = str(item.get("filename") or "").strip()
        if not filename:
            raise RuntimeError("音频文件名为空。")
        suffix = Path(filename).suffix.lower()
        source_kind = str(item.get("source_kind") or item.get("media_type") or "").strip().lower()
        if source_kind in {"video", "video_audio"}:
            return resolve_input_video_path({
                "filename": filename,
                "subfolder": str(item.get("subfolder") or ""),
                "type": str(item.get("type") or "input"),
            })
        if suffix not in AUDIO_EXTENSIONS:
            raise RuntimeError(f"不支持的音频格式：{filename}")
        if str(item.get("type") or "temp").lower() == "temp":
            path = gjjutils_temp_path(filename).resolve()
            if not path.exists():
                raise RuntimeError(f"未找到临时音频：{filename}")
            return path
        input_dir = Path(folder_paths.get_input_directory()).resolve()
        subfolder = str(item.get("subfolder") or "").strip().replace("\\", "/")
        path = (input_dir / subfolder / filename).resolve()
        try:
            path.relative_to(input_dir)
        except ValueError as error:
            raise RuntimeError(f"音频路径越界：{subfolder}/{filename}") from error
        if not path.exists():
            raise RuntimeError(f"未找到音频：{subfolder}/{filename}")
        return path

    def _load_audio_track(self, kwargs: dict[str, Any], fallback_audio: Any, frame_count: int, fps: float) -> Any:
        try:
            items = json.loads(_json_text(kwargs.get("selected_audio_json"), "[]"))
        except Exception:
            items = []
        try:
            plan = json.loads(_json_text(kwargs.get("director_storyboard_json"), "{}"))
        except Exception:
            plan = {}
        override = bool(plan.get("audio_override")) if isinstance(plan, dict) else False
        duration = _audio_duration_for_frames(frame_count, fps)
        if not isinstance(items, list) or not items:
            return empty_audio(duration) if override else fallback_audio

        usable = [entry for entry in items if isinstance(entry, dict) and str(entry.get("filename") or "").strip()]
        if not usable:
            return empty_audio(duration) if override else fallback_audio

        sample_rate = 44100
        channels = 2
        cursor = 1
        segments: list[dict[str, Any]] = []
        for item in sorted(usable, key=lambda entry: int(float(entry.get("start_frame") or 1))):
            start_frame = max(1, int(float(item.get("start_frame") or 1)))
            end_frame = max(start_frame, int(float(item.get("end_frame") or frame_count)))
            if start_frame > frame_count:
                continue
            end_frame = min(int(frame_count), end_frame)
            if start_frame > cursor:
                segments.append(empty_audio(_audio_duration_for_frames(start_frame - cursor, fps), sample_rate, channels))
            source_start = max(1, int(float(item.get("source_start_frame") or 1)))
            source_seconds = float(source_start - 1) / max(1e-6, float(fps or 0.0))
            segment_duration = _audio_duration_for_frames(end_frame - start_frame + 1, fps)
            path = self._resolve_audio_path(item)
            segments.append(decode_audio_ffmpeg(path, source_seconds, segment_duration, sample_rate, channels))
            cursor = end_frame + 1
        if cursor <= frame_count:
            segments.append(empty_audio(_audio_duration_for_frames(frame_count - cursor + 1, fps), sample_rate, channels))
        return concat_audio_segments(segments, sample_rate, channels) if segments else empty_audio(duration, sample_rate, channels)

    def _director_plan(self, kwargs: dict[str, Any], total_frames: int, fps: float) -> dict[str, Any]:
        raw = _json_text(kwargs.get("director_storyboard_json"), "{}")
        try:
            data = json.loads(raw)
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}
        selected_refs = _reference_items_from_json(kwargs.get("selected_reference_json"))
        scenes = data.get("scenes")
        if not isinstance(scenes, list) or not scenes:
            return {
                "fps": fps,
                "total_frames": total_frames,
                "scenes": [{
                    "index": 1,
                    "start_frame": 1,
                    "end_frame": max(1, int(total_frames)),
                    "source_start_frame": 1,
                    "source_end_frame": max(1, int(total_frames)),
                    "prompt": str(kwargs.get("positive_prompt") or ""),
                    "references": selected_refs,
                    "video": None,
                }],
            }
        scene_ref_union = _merge_reference_items(*[
            scene.get("references") if isinstance(scene, dict) and isinstance(scene.get("references"), list) else []
            for scene in scenes
        ])
        saved_refs = _merge_reference_items(data.get("references") if isinstance(data.get("references"), list) else scene_ref_union)
        saved_ref_keys = {_reference_item_key(item) for item in saved_refs}
        added_selected_refs = [item for item in selected_refs if _reference_item_key(item) not in saved_ref_keys]
        fallback_refs = _merge_reference_items(saved_refs, selected_refs)
        normalized = []
        for index, scene in enumerate(scenes, start=1):
            if not isinstance(scene, dict):
                continue
            start = max(1, int(scene.get("start_frame") or 1))
            end = max(start, int(scene.get("end_frame") or start))
            length = end - start + 1
            source_start = max(1, int(scene.get("source_start_frame") or start))
            source_end = max(source_start, int(scene.get("source_end_frame") or (source_start + length - 1)))
            scene_refs = scene.get("references") if isinstance(scene.get("references"), list) else []
            scene_refs = _merge_reference_items(scene_refs, added_selected_refs) if scene_refs else fallback_refs
            normalized.append({
                **scene,
                "index": index,
                "start_frame": start,
                "end_frame": end,
                "source_start_frame": source_start,
                "source_end_frame": source_end,
                "prompt": str(scene.get("prompt") or kwargs.get("positive_prompt") or ""),
                "references": scene_refs,
            })
        if not normalized:
            return self._director_plan({**kwargs, "director_storyboard_json": "{}"}, total_frames, fps)
        return {
            **data,
            "fps": float(data.get("fps") or fps),
            "total_frames": max(int(data.get("total_frames") or total_frames), max(scene["end_frame"] for scene in normalized)),
            "scenes": normalized,
        }

    def _load_scene_video_frames(self, scene: dict[str, Any], fallback_frames: torch.Tensor, fallback_fps: float, kwargs: dict[str, Any]) -> torch.Tensor:
        length = max(1, int(scene.get("end_frame") or 1) - int(scene.get("start_frame") or 1) + 1)
        video_item = scene.get("video") if isinstance(scene.get("video"), dict) else None
        if video_item and str(video_item.get("filename") or "").strip():
            loader = GJJ_MultiVideoLoader()
            loaded = loader.load_videos(
                frame_rate=fallback_fps,
                width=0,
                height=0,
                video_format=kwargs.get("output_format"),
                start_frame=max(0, int(scene.get("source_start_frame") or 1) - 1),
                end_frame=max(0, int(scene.get("source_end_frame") or 0)),
                frame_stride=1,
                max_frames=length,
                selected_videos_json=json.dumps([video_item], ensure_ascii=False),
                input_frames=None,
                prompt=kwargs.get("prompt"),
                extra_pnginfo=kwargs.get("extra_pnginfo"),
                unique_id=kwargs.get("unique_id"),
            )
            result, _ui = _unwrap_result(loaded)
            frames = _first_image(result[0] if isinstance(result, (list, tuple)) else result)
            if frames is not None:
                return frames[:length].contiguous()
        start = max(0, int(scene.get("start_frame") or 1) - 1)
        end = min(int(fallback_frames.shape[0]), start + length)
        frames = fallback_frames[start:end]
        if int(frames.shape[0]) <= 0:
            raise RuntimeError(f"片段 {scene.get('index') or '?'} 没有可用视频帧。")
        return frames.contiguous()

    def _combine_segment_to_temp(self, frames: torch.Tensor, fps: float, kwargs: dict[str, Any], scene_index: int) -> tuple[Any, str, dict[str, Any]]:
        combined = GJJ_VideoCombine().combine(
            images=frames,
            frame_rate=float(fps or kwargs.get("frame_rate") or 8.0),
            loop_count=0,
            filename_prefix=f"GJJ/scail2_aio_segments/segment_{scene_index:03d}",
            format_name=str(kwargs.get("output_format") or "video/h264-mp4"),
            pingpong=False,
            save_output=False,
            use_source_fps=False,
            delete_tail_frame=False,
            save_metadata=False,
            trim_to_audio=False,
            pix_fmt="auto",
            crf="-1",
            prompt=kwargs.get("prompt"),
            extra_pnginfo=kwargs.get("extra_pnginfo"),
            unique_id=kwargs.get("unique_id"),
            audio=None,
        )
        result, ui = _unwrap_result(combined)
        video = result[0] if isinstance(result, (list, tuple)) and result else result
        path = str(result[1] if isinstance(result, (list, tuple)) and len(result) > 1 else "")
        if not path or not os.path.isfile(path):
            raise RuntimeError(f"片段 {scene_index} 已生成，但临时视频文件不存在。")
        return video, path, ui

    def _concat_segment_files_fast(self, segment_paths: list[str], kwargs: dict[str, Any]) -> str:
        paths = [str(path) for path in segment_paths if path and os.path.isfile(path)]
        if not paths:
            raise RuntimeError("没有可合并的视频片段。")
        if len(paths) == 1:
            return paths[0]
        ffmpeg_path = get_ffmpeg_path()
        if not ffmpeg_path:
            raise RuntimeError("当前环境未找到 ffmpeg，无法快速拼接分段视频。")
        output_dir = Path(folder_paths.get_temp_directory()) / "GJJ" / "scail2_aio_concat"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"scail2_aio_concat_{next(tempfile._get_candidate_names())}.mp4"
        list_path = output_dir / f"scail2_aio_concat_{next(tempfile._get_candidate_names())}.txt"
        with list_path.open("w", encoding="utf-8") as stream:
            for path in paths:
                escaped = str(Path(path).resolve()).replace("'", "'\\''")
                stream.write(f"file '{escaped}'\n")
        command = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="ignore")
        try:
            list_path.unlink(missing_ok=True)
        except Exception:
            pass
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "ffmpeg 快速拼接失败").strip())
        return str(output_path)

    def _finalize_segment_files(self, segment_paths: list[str], source_audio: Any, source_fps: float, kwargs: dict[str, Any]) -> tuple[Any, dict[str, Any], int]:
        concat_path = self._concat_segment_files_fast(segment_paths, kwargs)
        try:
            concat_video = InputImpl.VideoFromFile(concat_path)
        except Exception:
            concat_video = concat_path
        combined = GJJ_VideoCombine().combine(
            images=concat_video,
            frame_rate=float(source_fps or kwargs.get("frame_rate") or 8.0),
            loop_count=0,
            filename_prefix=str(kwargs.get("filename_prefix") or "video/SCAIL2_AIO"),
            format_name=str(kwargs.get("output_format") or "video/h264-mp4"),
            pingpong=False,
            save_output=True,
            use_source_fps=True,
            delete_tail_frame=False,
            save_metadata=True,
            trim_to_audio=False,
            pix_fmt="auto",
            crf="-1",
            prompt=kwargs.get("prompt"),
            extra_pnginfo=kwargs.get("extra_pnginfo"),
            unique_id=kwargs.get("unique_id"),
            audio=source_audio,
        )
        result, ui = _unwrap_result(combined)
        video = result[0] if isinstance(result, (list, tuple)) else result
        return video, ui, len(segment_paths)

    @staticmethod
    def _cleanup_segment_resources(*values: Any, empty_cache: bool = True) -> None:
        for value in values:
            try:
                del value
            except Exception:
                pass
        gc.collect()
        if not empty_cache:
            return
        try:
            comfy.model_management.soft_empty_cache()
        except Exception:
            pass

    def _load_models(self, kwargs: dict[str, Any]) -> tuple[Any, Any, Any, Any]:
        unique_id = kwargs.get("unique_id")
        raw_model = str(kwargs.get("model_file") or "").strip()
        selected_model = _pick_scail_model(raw_model)
        if not selected_model:
            raise RuntimeError(
                "SCAIL2 AIO 未找到可用的 SCAIL 主模型。\n"
                "请把文件放到 models/diffusion_models，文件名需包含关键词 wan + scail，"
                "扩展名支持 .safetensors 或 .gguf。"
            )
        selected_vae = _resolve_relative_model_choice(kwargs.get("vae_file"), "models/vae", ("wan", "2.1", "vae"), (".safetensors",))
        selected_t5 = _resolve_relative_model_choice(kwargs.get("text_encoder_file"), "models/text_encoders", ("umt5", "xxl"), (".safetensors",))
        selected_clip_vision = _resolve_relative_model_choice(kwargs.get("clip_vision_file"), "models/clip_vision", ("clip", "vision"), (".safetensors",))
        selected_accel_lora = _resolve_optional_lora_choice(kwargs.get("accel_lora_file"), ("lightx2v", "i2v", "14b"))
        dpo_lora = _resolve_optional_lora_choice(kwargs.get("dpo_lora_file"), ("scail", "dpo"))
        slop_bounce_lora = _resolve_optional_lora_choice(kwargs.get("slop_bounce_lora_file"), ("slop", "bounce"))
        relighting_lora = _resolve_optional_lora_choice(kwargs.get("relighting_lora_file"), ("scail", "relighting"))
        external_lora_chain = normalize_lora_chain_data(kwargs.get("lora_chain_config", "[]"))
        merged_lora_chain = _merge_lora_chain_configs(
            _lora_chain_config(dpo_lora, slop_bounce_lora, relighting_lora),
            external_lora_chain,
        )
        external_lora_count = _active_lora_count(external_lora_chain)
        selected_sam3 = _resolve_relative_model_choice(kwargs.get("sam3_checkpoint"), "models/checkpoints", ("sam3", "multiplex"), (".safetensors",))
        kwargs["model_file"] = selected_model
        kwargs["vae_file"] = selected_vae
        kwargs["text_encoder_file"] = selected_t5
        kwargs["clip_vision_file"] = selected_clip_vision
        kwargs["accel_lora_file"] = selected_accel_lora
        kwargs["dpo_lora_file"] = dpo_lora
        kwargs["slop_bounce_lora_file"] = slop_bounce_lora
        kwargs["relighting_lora_file"] = relighting_lora
        kwargs["sam3_checkpoint"] = selected_sam3
        missing = []
        if not selected_vae:
            missing.append("VAE(models/vae)")
        if not selected_t5:
            missing.append("T5(models/text_encoders)")
        if not selected_clip_vision:
            missing.append("CLIP Vision(models/clip_vision)")
        if not selected_sam3:
            missing.append("SAM3(models/checkpoints)")
        if missing:
            raise RuntimeError("SCAIL2 AIO 缺少模型：" + "、".join(missing) + "。请确认文件在对应相对目录。")
        _progress(unique_id, "3/9 匹配模型文件：SCAIL / VAE / T5 / CLIP Vision / LoRA...", 0.085)
        _progress(unique_id, f"3/9 主模型：{selected_model}", 0.09)
        _progress(unique_id, f"3/9 VAE：{selected_vae}", 0.095)
        _progress(unique_id, f"3/9 T5：{selected_t5}", 0.10)
        _progress(unique_id, f"3/9 CLIP Vision：{selected_clip_vision}", 0.105)
        if _bool(kwargs.get("use_accel_lora", True)):
            _progress(unique_id, f"3/9 加速 LoRA：{selected_accel_lora or '未找到，自动禁用'}", 0.11)
        else:
            _progress(unique_id, "3/9 加速 LoRA 已关闭。", 0.11)
        if dpo_lora:
            _progress(unique_id, f"3/9 DPO LoRA：{dpo_lora}", 0.112)
        else:
            _progress(unique_id, "3/9 DPO LoRA 已禁用。", 0.112)
        if slop_bounce_lora:
            _progress(unique_id, f"3/9 Slop Bounce LoRA：{slop_bounce_lora}", 0.113)
        else:
            _progress(unique_id, "3/9 Slop Bounce LoRA 已禁用。", 0.113)
        if relighting_lora:
            _progress(unique_id, f"3/9 Relighting LoRA：{relighting_lora}", 0.114)
        else:
            _progress(unique_id, "3/9 Relighting LoRA 已禁用。", 0.114)
        if external_lora_count:
            _progress(unique_id, f"3/9 外接 LoRA 串联配置：{external_lora_count} 个启用项", 0.1145)
        loader = GJJ_VideoUniversalModelLoader()
        _progress(unique_id, "3/9 开始加载模型到内存/显存...", 0.115)
        def load_with_model_file(model_file: str):
            return loader.load_models(
                config="wan21_SCAIL",
                use_accel_lora=_bool(kwargs.get("use_accel_lora", True)),
                file_1=str(model_file or ""),
                dtype_1=str(kwargs.get("model_dtype") or "default"),
                file_2=selected_vae,
                file_3=selected_t5,
                file_4=selected_clip_vision,
                file_5=selected_accel_lora,
                lora_chain_config=merged_lora_chain,
                clip_type_override="auto",
                unique_id=kwargs.get("unique_id"),
            )

        if raw_model.lower().endswith(".gguf"):
            if selected_model.lower().endswith(".gguf"):
                _progress(unique_id, f"3/9 主模型按手动选择的 GGUF 加载：{selected_model}", 0.116)
            else:
                _progress(unique_id, f"3/9 旧 GGUF 隐藏值不存在，已改用 safetensors：{selected_model}", 0.116)
        try:
            values = load_with_model_file(selected_model)
        except Exception as exc:
            if raw_model.lower().endswith(".gguf") and not selected_model.lower().endswith(".gguf"):
                _progress(
                    unique_id,
                    "3/9 safetensors 回退加载仍失败，请检查 diffusion_models 中的 SCAIL safetensors 文件。",
                    0.118,
                )
            raise
        model, vae, clip, clip_vision = values[:4]
        if model is None or vae is None or clip is None:
            raise RuntimeError("SCAIL2 AIO 内部模型加载失败：请检查模型浮窗里的 SCAIL/VAE/T5 文件名。")
        _progress(unique_id, "3/9 模型加载完成。", 0.135)
        return model, vae, clip, clip_vision

    def generate(self, original_video=None, reference_image=None, **kwargs):
        unique_id = kwargs.get("unique_id")
        replacement_mode = _bool(kwargs.get("mode_replacement", False))

        _progress(unique_id, "开始执行 SCAIL2 AIO...", 0.0)
        video_frames, source_fps, source_audio = self._load_video_source(original_video, kwargs)
        if _video_size_mode(kwargs) == "原视频尺寸":
            source_height = int(video_frames.shape[1]) if isinstance(video_frames, torch.Tensor) and video_frames.ndim >= 3 else int(kwargs.get("height") or 896)
            source_width = int(video_frames.shape[2]) if isinstance(video_frames, torch.Tensor) and video_frames.ndim >= 3 else int(kwargs.get("width") or 512)
            kwargs["width"] = min(2048, max(320, source_width))
            kwargs["height"] = min(2048, max(320, source_height))
            _progress(unique_id, f"1/9 使用原视频尺寸：{kwargs['width']}x{kwargs['height']}", 0.062)
        source_audio = self._load_audio_track(kwargs, source_audio, int(video_frames.shape[0]), float(source_fps or kwargs.get("frame_rate") or 8.0))
        model, vae, clip, clip_vision = self._load_models(kwargs)
        plan = self._director_plan(kwargs, int(video_frames.shape[0]), float(source_fps or kwargs.get("frame_rate") or 8.0))
        scenes = list(plan.get("scenes") or [])
        external_refs = self._load_reference_image(reference_image, kwargs) if reference_image is not None else None
        segment_paths: list[str] = []
        generated_frame_count = 0
        scene_count = max(1, len(scenes))
        _progress(unique_id, f"4/9 按导演台分段执行：{scene_count} 段。", 0.14)

        for scene_pos, scene in enumerate(scenes, start=1):
            scene_index = int(scene.get("index") or scene_pos)
            base_progress = 0.14 + 0.78 * ((scene_pos - 1) / scene_count)
            _progress(unique_id, f"片段 {scene_pos}/{scene_count}：读取视频段并准备参考图...", base_progress)
            scene_frames = self._load_scene_video_frames(scene, video_frames, source_fps, kwargs)
            scene_refs = external_refs if external_refs is not None else self._load_reference_items(list(scene.get("references") or []), kwargs)
            ref_tensor = _first_image(scene_refs)

            _progress(unique_id, f"片段 {scene_pos}/{scene_count}：编码提示词...", base_progress + 0.02)
            positive, negative = GJJ_CLIPPromptEncodePanel().encode(
                clip=clip,
                positive_text=str(scene.get("prompt") or kwargs.get("positive_prompt") or ""),
                negative_text=str(kwargs.get("negative_prompt") or DEFAULT_NEGATIVE_PROMPT),
                zero_conditioning=_bool(kwargs.get("zero_conditioning", True)),
                translation_enabled=False,
                unique_id=unique_id,
            )

            clip_vision_output = None
            if ref_tensor is not None and clip_vision is not None and CLIPVisionEncode is not None:
                _progress(unique_id, f"片段 {scene_pos}/{scene_count}：编码参考图 CLIP Vision...", base_progress + 0.04)
                clip_vision_output = CLIPVisionEncode().encode(clip_vision, ref_tensor[:1], "none")[0]

            _progress(unique_id, f"片段 {scene_pos}/{scene_count}：运行 SAM3 跟踪...", base_progress + 0.06)
            mask_result = GJJ_SAM3SCAIL2TrackMaskAIO().track_and_build(
                text_prompt=str(kwargs.get("sam3_target") or "person"),
                object_indices=str(kwargs.get("sam3_object_indices") or ""),
                checkpoint=str(kwargs.get("sam3_checkpoint") or ""),
                detection_threshold=_float_value(kwargs.get("sam3_detection_threshold"), 0.5, 0.0, 1.0),
                max_objects=int(kwargs.get("sam3_max_objects") or 1),
                detect_interval=int(kwargs.get("sam3_detect_interval") or 1),
                sort_by=str(kwargs.get("sam3_sort_by") or "从左到右"),
                replacement_mode=replacement_mode,
                media_01=scene_frames,
                media_02=ref_tensor,
                unique_id=unique_id,
            )
            masks, mask_ui = _unwrap_result(mask_result)
            pose_mask = masks[0] if isinstance(masks, (list, tuple)) and len(masks) > 0 else None
            ref_mask = masks[1] if isinstance(masks, (list, tuple)) and len(masks) > 1 else None

            _progress(unique_id, f"片段 {scene_pos}/{scene_count}：SCAIL2 生成...", base_progress + 0.1)
            target_frames = int(scene_frames.shape[0])
            infinity_result = GJJ_WanSCAILInfinity().generate(
                positive=positive,
                negative=negative,
                model=model,
                vae=vae,
                width=int(kwargs.get("width") or 512),
                height=int(kwargs.get("height") or 896),
                seed=int(kwargs.get("seed") or 1) + scene_pos - 1,
                steps=int(kwargs.get("steps") or 6),
                cfg=float(kwargs.get("cfg") or 1.0),
                sampler_name=str(kwargs.get("sampler_name") or "euler"),
                scheduler=str(kwargs.get("scheduler") or "simple"),
                denoise=float(kwargs.get("denoise") or 1.0),
                window_length=int(kwargs.get("window_length") or 121),
                previous_frame_count=int(kwargs.get("previous_frame_count") or 5),
                max_frames=target_frames,
                decode_tiled=_bool(kwargs.get("decode_tiled", False)),
                vary_seed_per_window=_bool(kwargs.get("vary_seed_per_window", True)),
                pose_strength=float(kwargs.get("pose_strength") or 1.0),
                pose_start=float(kwargs.get("pose_start") or 0.0),
                pose_end=float(kwargs.get("pose_end") or 1.0),
                replacement_mode=replacement_mode,
                enable_model_sampling_sd3=_bool(kwargs.get("enable_model_sampling_sd3", True)),
                model_sampling_sd3_shift=float(kwargs.get("model_sampling_sd3_shift") or 5.0),
                pose_video=scene_frames,
                pose_video_mask=pose_mask,
                reference_image=scene_refs,
                reference_image_mask=ref_mask,
                clip_vision_output=clip_vision_output,
                unique_id=unique_id,
            )
            scail_result, scail_ui = _unwrap_result(infinity_result)
            generated_frames = scail_result[0] if isinstance(scail_result, (list, tuple)) else scail_result
            generated_frame_count += int(generated_frames.shape[0]) if isinstance(generated_frames, torch.Tensor) else target_frames

            _progress(unique_id, f"片段 {scene_pos}/{scene_count}：写入临时视频并清理资源...", base_progress + 0.74 / scene_count)
            _segment_video, segment_path, segment_ui = self._combine_segment_to_temp(generated_frames, source_fps, kwargs, scene_index)
            segment_paths.append(segment_path)
            self._cleanup_segment_resources(
                scene_frames,
                scene_refs,
                ref_tensor,
                pose_mask,
                ref_mask,
                clip_vision_output,
                generated_frames,
                empty_cache=not _keep_model_loaded(kwargs),
            )

        _progress(unique_id, "9/9 快速合并所有片段视频...", 0.96)
        video, combine_ui, _segment_count = self._finalize_segment_files(segment_paths, source_audio, source_fps, kwargs)
        final_video = None
        for key in ("images", "preview_images", "preview_media"):
            value = combine_ui.get(key) if isinstance(combine_ui, dict) else None
            if isinstance(value, list):
                if key == "preview_media" and value and isinstance(value[0], dict):
                    final_video = value[0]

        final_label = ""
        if isinstance(final_video, dict):
            final_label = str(final_video.get("filename") or "")
            subfolder = str(final_video.get("subfolder") or "")
            if final_label and subfolder:
                final_label = f"{subfolder}/{final_label}"
        _progress(
            unique_id,
            f"完成：最终视频 {final_label or '已返回'}。",
            1.0,
            done=True,
            final_video=final_video,
        )
        return {
            "ui": {
                "images": [],
                "preview_media": [final_video] if isinstance(final_video, dict) else [],
                "frame_count": [generated_frame_count],
            },
            "result": (video,),
        }


def _register_scail2_aio_routes() -> None:
    if PromptServer is None or getattr(PromptServer, "instance", None) is None:
        return
    server = PromptServer.instance
    if getattr(server, "_gjj_scail2_aio_models_route_registered", False):
        return
    server.routes.get(MODEL_LIST_API_PATH)(_get_scail2_aio_models)
    server.routes.post(REF_STITCH_API_PATH)(_post_scail2_aio_stitch_references)
    server.routes.post(REF_REMOVE_BG_API_PATH)(_post_scail2_aio_remove_background_references)
    server.routes.post(AUDIO_UPLOAD_API_PATH)(_post_scail2_aio_upload_audio)
    server._gjj_scail2_aio_models_route_registered = True


_register_scail2_aio_routes()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SCAIL2LongVideoAIO}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
