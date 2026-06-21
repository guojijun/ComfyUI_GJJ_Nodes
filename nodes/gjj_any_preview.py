from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Any

import comfy.utils
import folder_paths
import torch
from nodes import PreviewImage, SaveImage
from PIL import Image

NODE_NAME = "GJJ_AnyPreview"
ANY_PREVIEW_INPUT_TYPE = "*"
ANY_PREVIEW_FAST_TYPES = "GJJ_BATCH_IMAGE、IMAGE、MASK、STRING、AUDIO、VIDEO"
VIDEO_SEQUENCE_MIN_FRAMES = 16
VIDEO_SEQUENCE_PREVIEW_FPS = 16.0
QUEUE_THUMBNAIL_PREFIX_FALLBACK = "GJJ/AnyPreview/工作流"


class AnyType(str):
    """始终可兼容任意类型的占位类型。"""

    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    """允许节点接收动态数量与动态类型的可选输入。"""

    def __init__(self, input_type, data: dict[str, Any] | None = None):
        super().__init__()
        self.input_type = input_type
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        return (
            self.input_type,
            {
                "lazy": True,
                "display_name": key,
                "tooltip": f"惰性任意输入；{ANY_PREVIEW_FAST_TYPES} 会走专用预览，已到达的第一路会先触发预览。",
            },
        )

    def get(self, key, default=None):
        if key in self:
            return self[key]
        return default

    def __contains__(self, key):
        return True


any_type = AnyType("*")
PREVIEW_KIND_LABELS = {
    "image": "图片",
    "mask": "遮罩",
    "text": "文本",
    "audio": "音频",
    "video": "视频",
    "3d": "3D文件",
    "other": "对象",
    "mixed": "混合对象",
}
PREVIEW_KIND_TYPE_LABELS = {
    "image": "IMAGE",
    "mask": "MASK",
    "text": "STRING",
    "audio": "AUDIO",
    "video": "VIDEO",
    "3d": "FILE_3D",
    "mixed": "MIXED",
}
PREVIEW_KIND_EMOJIS = {
    "image": "🖼️",
    "mask": "🎭",
    "text": "📝",
    "audio": "🎧",
    "video": "🎬",
    "3d": "🧊",
    "mixed": "🧩",
    "other": "🧩",
}
ORDINAL_EMOJIS = {
    1: "1️⃣",
    2: "2️⃣",
    3: "3️⃣",
    4: "4️⃣",
    5: "5️⃣",
    6: "6️⃣",
    7: "7️⃣",
    8: "8️⃣",
    9: "9️⃣",
    10: "🔟",
}


def ordinal_emoji(index: int) -> str:
    return ORDINAL_EMOJIS.get(int(index), f"{int(index)}.")


def concrete_preview_type_label(value: Any, kind: str) -> str:
    kind = str(kind or "other").lower()
    if kind in PREVIEW_KIND_TYPE_LABELS:
        return PREVIEW_KIND_TYPE_LABELS[kind]
    if isinstance(value, torch.Tensor):
        return "TENSOR"
    if value is None:
        return "NONE"
    value_type = type(value).__name__
    return value_type or "UNKNOWN"


def preview_kind_emoji(kind: str) -> str:
    return PREVIEW_KIND_EMOJIS.get(str(kind or "other").lower(), PREVIEW_KIND_EMOJIS["other"])


def format_preview_item_title(index: int, value: Any, kind: str) -> str:
    return f"{ordinal_emoji(index)} {preview_kind_emoji(kind)} {concrete_preview_type_label(value, kind)}"


def extract_input_index(name: str) -> int:
    text = str(name or "")
    if not text.startswith("any_"):
        return 999999
    try:
        return int(text[4:])
    except Exception:
        return 999999


def is_none(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, dict) and "model" in value and "clip" in value:
        return not value or all(v is None for v in value.values())
    return False


def _sanitize_filename_part(part: str) -> str:
    text = re.sub(r'[<>:"|?*\x00-\x1f]', "_", str(part or "").strip())
    text = text.replace("\\", "/")
    text = re.sub(r"/+", "/", text)
    return text.strip(" /.")


def _clean_workflow_name(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = text.replace("\\", "/").rsplit("/", 1)[-1]
    text = re.sub(r"\.(json|workflow)$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^ComfyUI\s*[-|–—]\s*", "", text, flags=re.IGNORECASE)
    clean = _sanitize_filename_part(text)
    return "" if clean.lower() in {"comfyui", "untitled", "未命名"} else clean


def _workflow_name_from_value(value: Any, depth: int = 0) -> str:
    if depth > 4 or value is None:
        return ""
    if isinstance(value, str):
        return _clean_workflow_name(value)
    if not isinstance(value, dict):
        return ""

    name_keys = (
        "workflow_name",
        "workflowName",
        "name",
        "title",
        "filename",
        "file",
        "path",
        "workflow_path",
        "workflowPath",
    )
    for key in name_keys:
        if key not in value:
            continue
        name = _workflow_name_from_value(value.get(key), depth + 1)
        if name:
            return name

    for key in ("workflow", "extra", "metadata", "config", "app", "info"):
        nested = value.get(key)
        if isinstance(nested, dict):
            name = _workflow_name_from_value(nested, depth + 1)
            if name:
                return name
    return ""


def _queue_thumbnail_prefix(extra_pnginfo: Any) -> str:
    workflow_name = _workflow_name_from_value(extra_pnginfo)
    return f"GJJ/AnyPreview/{workflow_name}" if workflow_name else QUEUE_THUMBNAIL_PREFIX_FALLBACK


def is_image_tensor(value: Any) -> bool:
    if is_mask_tensor(value):
        return False
    return _coerce_image_tensor(value) is not None


def _scale_tensor_if_needed(value: torch.Tensor) -> torch.Tensor:
    value = value.float()
    if value.numel() <= 0:
        return value
    if not torch.is_floating_point(value):
        return value / 255.0
    try:
        max_value = float(value.detach().amax().item())
    except Exception:
        max_value = 1.0
    if max_value > 2.0:
        return value / 255.0
    return value


def _coerce_image_tensor(value: Any) -> torch.Tensor | None:
    """把常见 HWC/BHWC/CHW/BCHW/BT-HWC/BCTHW 图像张量统一成 BHWC。"""
    if not isinstance(value, torch.Tensor):
        return None
    tensor = value.detach().cpu()
    if tensor.ndim == 3:
        if int(tensor.shape[-1]) in (1, 3, 4):
            image = tensor.unsqueeze(0)
        elif int(tensor.shape[0]) in (1, 3, 4):
            image = tensor.movedim(0, -1).unsqueeze(0)
        else:
            return None
    elif tensor.ndim == 4:
        if int(tensor.shape[-1]) in (1, 3, 4):
            image = tensor
        elif int(tensor.shape[1]) in (1, 3, 4):
            image = tensor.movedim(1, -1)
        else:
            return None
    elif tensor.ndim == 5:
        if int(tensor.shape[-1]) in (1, 3, 4):
            image = tensor.reshape(-1, int(tensor.shape[-3]), int(tensor.shape[-2]), int(tensor.shape[-1]))
        elif int(tensor.shape[1]) in (1, 3, 4):
            moved = tensor.movedim(1, -1)
            image = moved.reshape(-1, int(moved.shape[-3]), int(moved.shape[-2]), int(moved.shape[-1]))
        else:
            return None
    else:
        return None
    if image.ndim != 4 or min(int(image.shape[0]), int(image.shape[1]), int(image.shape[2]), int(image.shape[3])) <= 0:
        return None
    image = torch.nan_to_num(_scale_tensor_if_needed(image), nan=0.0, posinf=1.0, neginf=0.0)
    return image.clamp(0.0, 1.0).contiguous()


def is_mask_tensor(value: Any) -> bool:
    if not isinstance(value, torch.Tensor):
        return False
    if value.ndim == 2:
        return True
    if value.ndim == 3:
        if value.shape[-1] in (3, 4) or value.shape[0] in (3, 4):
            return False
        return True
    if value.ndim == 4:
        if value.shape[-1] in (3, 4) or value.shape[1] in (3, 4):
            return False
        if value.shape[-1] == 1 or value.shape[1] == 1:
            return True
    if value.ndim == 5:
        if value.shape[-1] in (3, 4) or value.shape[1] in (3, 4):
            return False
        if value.shape[-1] == 1 or value.shape[1] == 1:
            return True
    return False


def normalize_mask_tensor(value: torch.Tensor) -> torch.Tensor:
    if value.ndim == 2:
        value = value.unsqueeze(0)
    elif value.ndim == 3 and value.shape[-1] == 1:
        value = value[..., 0].unsqueeze(0)
    elif value.ndim == 4 and value.shape[-1] == 1:
        value = value[..., 0]
    elif value.ndim == 4 and value.shape[1] == 1:
        value = value[:, 0]
    elif value.ndim == 5 and value.shape[-1] == 1:
        value = value[..., 0].reshape(-1, int(value.shape[-3]), int(value.shape[-2]))
    elif value.ndim == 5 and value.shape[1] == 1:
        value = value[:, 0].reshape(-1, int(value.shape[-2]), int(value.shape[-1]))
    elif value.ndim != 3:
        raise ValueError(f"不支持的 MASK 维度: {tuple(value.shape)}")
    value = torch.nan_to_num(_scale_tensor_if_needed(value.detach().cpu()), nan=0.0, posinf=1.0, neginf=0.0)
    return value.clamp(0.0, 1.0).contiguous()


def mask_to_preview_image(value: torch.Tensor) -> torch.Tensor:
    mask = normalize_mask_tensor(value)
    return mask.unsqueeze(-1).expand(-1, -1, -1, 3).contiguous()


def normalize_image_tensor(value: torch.Tensor) -> torch.Tensor:
    image = _coerce_image_tensor(value)
    if image is None:
        raise ValueError(f"不支持的 IMAGE 维度: {tuple(value.shape)}")
    return image


def image_frame_count(value: Any) -> int:
    if not is_image_tensor(value) or not isinstance(value, torch.Tensor):
        return 0
    return int(normalize_image_tensor(value).shape[0])


def mask_frame_count(value: Any) -> int:
    if not is_mask_tensor(value) or not isinstance(value, torch.Tensor):
        return 0
    try:
        return int(normalize_mask_tensor(value).shape[0])
    except Exception:
        return 0


def resize_image_batch(images: torch.Tensor, width: int, height: int) -> torch.Tensor:
    samples = images.movedim(-1, 1)
    resized = comfy.utils.common_upscale(
        samples, int(width), int(height), "lanczos", "disabled"
    )
    return resized.movedim(1, -1)


def merge_images(values: list[torch.Tensor]) -> torch.Tensor:
    batches = [normalize_image_tensor(value) for value in values]
    return batches[0] if len(batches) == 1 else batches


def serialize_preview(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if value is None:
        return "None"
    if isinstance(value, torch.Tensor):
        return f"Tensor(shape={tuple(value.shape)}, dtype={value.dtype})"
    try:
        return json.dumps(value, indent=2, ensure_ascii=False)
    except Exception:
        try:
            return str(value)
        except Exception:
            return "对象存在，但无法序列化为可预览文本。"


def flatten_preview_values(values: list[Any]) -> list[Any]:
    flattened: list[Any] = []

    def walk(value: Any) -> None:
        if is_none(value):
            return
        if isinstance(value, (list, tuple)):
            for item in value:
                walk(item)
            return
        flattened.append(value)

    for value in values:
        walk(value)
    return flattened


def is_audio_object(value: Any) -> bool:
    """检测是否为ComfyUI音频对象"""
    if not isinstance(value, dict):
        return False
    return "waveform" in value and "sample_rate" in value


def is_video_object(value: Any) -> bool:
    """检测是否为ComfyUI视频对象"""
    if value is None:
        return False
    # 检查是否有get_components方法（ComfyUI VIDEO对象的特征）
    return hasattr(value, "get_components") or (
        isinstance(value, dict) and "images" in value
    )


def is_3d_file_object(value: Any) -> bool:
    fmt = str(getattr(value, "format", "") or "").lstrip(".").lower()
    if fmt not in {"glb", "gltf", "obj", "fbx", "stl", "usdz", "ply", "splat", "spz", "ksplat"}:
        return False
    return hasattr(value, "save_to") or hasattr(value, "get_bytes") or hasattr(value, "get_data")


def save_3d_file_preview(value: Any) -> list[dict[str, Any]]:
    fmt = str(getattr(value, "format", "") or "glb").lstrip(".").lower() or "glb"
    filename = f"GJJ_AnyPreview_3d_{uuid.uuid4().hex[:12]}.{fmt}"
    path = Path(folder_paths.get_temp_directory()) / "GJJ" / "any_preview" / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    if hasattr(value, "save_to"):
        value.save_to(str(path))
    elif hasattr(value, "get_bytes"):
        path.write_bytes(value.get_bytes())
    elif hasattr(value, "get_data"):
        data = value.get_data()
        path.write_bytes(data.getvalue() if hasattr(data, "getvalue") else data.read())
    else:
        return []
    return [{"filename": filename, "subfolder": "GJJ/any_preview", "type": "temp", "format": fmt}]


def serialize_audio_preview(value: dict[str, Any]) -> str:
    """序列化音频对象为预览文本"""
    try:
        waveform = value.get("waveform")
        sample_rate = value.get("sample_rate", 0)
        if isinstance(waveform, torch.Tensor):
            duration = (
                float(waveform.shape[-1]) / float(sample_rate) if sample_rate > 0 else 0
            )
            return f"音频(时长: {duration:.2f}秒, 采样率: {sample_rate}Hz, 形状: {tuple(waveform.shape)})"
        return f"音频(采样率: {sample_rate}Hz)"
    except Exception:
        return "音频对象"


def normalize_audio_object(value: Any) -> dict[str, Any] | None:
    """转换为 ComfyUI 标准音频结构：[B, C, T] + sample_rate。"""
    if not is_audio_object(value):
        return None

    waveform = value.get("waveform")
    if not isinstance(waveform, torch.Tensor):
        return None

    try:
        sample_rate = int(value.get("sample_rate") or 44100)
    except Exception:
        sample_rate = 44100
    if sample_rate <= 0:
        sample_rate = 44100

    waveform = waveform.detach().cpu().float()
    if waveform.ndim == 1:
        waveform = waveform.reshape(1, 1, -1)
    elif waveform.ndim == 2:
        # 常见输入是 [C, T]；若明显是 [T, C]，转回标准声道优先格式。
        if waveform.shape[0] > waveform.shape[1] and waveform.shape[1] <= 8:
            waveform = waveform.transpose(0, 1)
        waveform = waveform.unsqueeze(0)
    elif waveform.ndim == 3:
        pass
    elif waveform.ndim > 3 and waveform.shape[-2] > 0 and waveform.shape[-1] > 0:
        waveform = waveform.reshape(-1, waveform.shape[-2], waveform.shape[-1])
    else:
        return None

    if waveform.shape[0] <= 0 or waveform.shape[1] <= 0 or waveform.shape[2] <= 0:
        return None
    if waveform.shape[1] > 2:
        waveform = waveform[:, :2, :]

    waveform = torch.nan_to_num(waveform, nan=0.0, posinf=1.0, neginf=-1.0)
    waveform = waveform.clamp(-1.0, 1.0).contiguous()

    normalized = dict(value)
    normalized["waveform"] = waveform
    normalized["sample_rate"] = sample_rate
    return normalized


def normalize_preview_media_items(items: Any) -> list[dict[str, Any]]:
    """把 ComfyUI SavedResult / dict 列表统一成前端可识别的文件描述。"""
    if not isinstance(items, (list, tuple)):
        return []
    result: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        filename = item.get("filename")
        if not filename:
            continue
        result.append(
            {
                "filename": str(filename),
                "subfolder": str(item.get("subfolder") or ""),
                "type": str(item.get("type") or "temp"),
            }
        )
    return result


def annotate_preview_image_dimensions(
    items: list[dict[str, Any]],
    images: torch.Tensor,
) -> list[dict[str, Any]]:
    """给 PreviewImage 返回项补上宽高，前端可据此算出无滚动条的单图高度。"""
    if not items or not isinstance(images, torch.Tensor):
        return items
    try:
        normalized = normalize_image_tensor(images)
        height = int(normalized.shape[1])
        width = int(normalized.shape[2])
        for item in items:
            item.setdefault("height", height)
            item.setdefault("width", width)
    except Exception:
        pass
    return items


def collect_queue_preview_images(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """从自定义预览项目中抽出标准 images，供 ComfyUI 队列/历史预览使用。"""
    queue_images: list[dict[str, Any]] = []
    for item in items:
        images = item.get("images") if isinstance(item, dict) else None
        if not isinstance(images, (list, tuple)):
            continue
        for image in images:
            if isinstance(image, dict) and image.get("filename"):
                queue_images.append(dict(image))
    return queue_images


def collect_queue_preview_media(items: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """从自定义预览项目中抽出队列/历史面板可识别的标准媒体字段。"""
    queue_images: list[dict[str, Any]] = []
    queue_media: list[dict[str, Any]] = []
    animated: list[dict[str, Any]] = []
    gifs: list[dict[str, Any]] = []

    def append_media(target: list[dict[str, Any]], media_item: Any) -> None:
        if isinstance(media_item, dict) and media_item.get("filename"):
            target.append(dict(media_item))

    for item in items:
        if not isinstance(item, dict):
            continue
        for image in item.get("images") or []:
            if not isinstance(image, dict) or not image.get("filename"):
                continue
            image_copy = dict(image)
            queue_images.append(image_copy)
            filename = str(image_copy.get("filename") or "").lower()
            if image_copy.get("is_sequence") or filename.endswith((".gif", ".webp")):
                animated.append(dict(image_copy))
                if filename.endswith(".gif"):
                    gifs.append(dict(image_copy))
        for media_key in ("video", "audio", "files"):
            media_values = item.get(media_key)
            if not isinstance(media_values, (list, tuple)):
                continue
            for media_item in media_values:
                append_media(queue_media, media_item)

    result: dict[str, list[dict[str, Any]]] = {}
    if queue_images:
        result["images"] = queue_images
    if queue_media:
        result["preview_media"] = queue_media
        result["animated"] = queue_media
    if animated:
        result["animated"] = animated
    if gifs:
        result["gifs"] = gifs
    return result


def first_queue_thumbnail_tensor(values: list[Any]) -> torch.Tensor | None:
    """取第一张适合写入 output 历史缩略图的图像。"""
    sequence_info = detect_video_sequence_preview(values)
    if sequence_info is not None:
        _source_kind, frames = sequence_info
        if isinstance(frames, torch.Tensor) and int(frames.shape[0]) > 0:
            return normalize_image_tensor(frames[:1])

    for value in values:
        if is_image_tensor(value) and isinstance(value, torch.Tensor):
            image = normalize_image_tensor(value)
            return image[:1]
        if is_mask_tensor(value) and isinstance(value, torch.Tensor):
            image = mask_to_preview_image(value)
            return normalize_image_tensor(image[:1])
    return None


def save_audio_with_native_preview(audio: dict[str, Any]) -> list[dict[str, Any]]:
    """优先复用 ComfyUI 原生音频预览保存逻辑。"""
    try:
        from comfy_api.latest import UI

        native_ui = UI.PreviewAudio(audio, cls=None).as_dict()
        return normalize_preview_media_items(native_ui.get("audio"))
    except Exception as error:
        print(f"[GJJ] 原生音频预览保存失败，改用 WAV 预览: {error}")
        return []


def save_audio_with_wav_fallback(audio: dict[str, Any]) -> list[dict[str, Any]]:
    """在原生 FLAC 保存不可用时，写入浏览器兼容的临时 WAV。"""
    try:
        import soundfile as sf

        waveform = audio["waveform"][0].movedim(0, 1).numpy()
        sample_rate = int(audio["sample_rate"])
        output_dir = folder_paths.get_temp_directory()
        os.makedirs(output_dir, exist_ok=True)
        filename = f"GJJ_AnyPreview_audio_{uuid.uuid4().hex[:12]}.wav"
        filepath = os.path.join(output_dir, filename)
        sf.write(filepath, waveform, sample_rate, subtype="PCM_16")
        return [{"filename": filename, "subfolder": "", "type": "temp"}]
    except Exception as error:
        print(f"[GJJ] WAV 音频预览保存失败: {error}")
        return []


def save_audio_preview(audio: dict[str, Any]) -> list[dict[str, Any]]:
    return save_audio_with_native_preview(audio) or save_audio_with_wav_fallback(audio)


def serialize_video_preview(value: Any) -> str:
    """序列化视频对象为预览文本"""
    try:
        components = (
            value.get_components() if hasattr(value, "get_components") else None
        )
        if components is None:
            return "视频对象"
        images = getattr(components, "images", None)
        frame_rate = getattr(components, "frame_rate", 0)
        if images is not None and isinstance(images, torch.Tensor):
            frame_count = int(images.shape[0])
            duration = frame_count / float(frame_rate) if frame_rate > 0 else 0
            return f"视频(时长: {duration:.2f}秒, 帧数: {frame_count}, 帧率: {frame_rate}, 形状: {tuple(images.shape)})"
        return "视频对象"
    except Exception:
        return "视频对象"


def serialize_video_sequence_preview(frames: torch.Tensor, source_kind: str) -> str:
    try:
        frame_count = int(frames.shape[0])
        height = int(frames.shape[1])
        width = int(frames.shape[2])
        duration = frame_count / float(VIDEO_SEQUENCE_PREVIEW_FPS)
        source_label = "遮罩序列" if source_kind == "mask" else "图片序列"
        return (
            f"{source_label}已包装为动态预览"
            f"(帧数: {frame_count}, 预览帧率: {VIDEO_SEQUENCE_PREVIEW_FPS:g}fps, "
            f"时长: {duration:.2f}秒, 尺寸: {width} x {height})"
        )
    except Exception:
        return "视频序列已包装为动态预览"


def detect_preview_kind(value: Any) -> str:
    if is_mask_tensor(value):
        return "mask"
    if is_image_tensor(value):
        return "image"
    if isinstance(value, str):
        return "text"
    if is_audio_object(value):
        return "audio"
    if is_video_object(value):
        return "video"
    if is_3d_file_object(value):
        return "3d"
    return "other"


def save_video_preview(
    value: Any,
    prompt: Any = None,
    extra_pnginfo: Any = None,
) -> list[dict[str, Any]]:
    try:
        components = value.get_components() if hasattr(value, "get_components") else None
        if components is None and isinstance(value, dict):
            components = value

        images = None
        audio = None
        frame_rate = 24.0
        video_path = None

        if isinstance(components, dict):
            images = components.get("images")
            audio = components.get("audio")
            frame_rate = float(
                components.get("frame_rate")
                or components.get("fps")
                or components.get("frameRate")
                or 24.0
            )
            video_path = components.get("path") or components.get("video_path")
        else:
            images = getattr(components, "images", None)
            audio = getattr(components, "audio", None)
            frame_rate = float(getattr(components, "frame_rate", 24.0) or 24.0)
            video_path = getattr(components, "path", None) or getattr(
                components, "video_path", None
            )

        if video_path and isinstance(video_path, str) and os.path.exists(video_path):
            filename = os.path.basename(video_path)
            subfolder = ""
            input_dir = folder_paths.get_input_directory()
            if video_path.startswith(input_dir):
                subfolder = os.path.relpath(os.path.dirname(video_path), input_dir)
            return [
                {
                    "filename": filename,
                    "subfolder": subfolder,
                    "type": "input",
                    "frame_rate": frame_rate,
                }
            ]

        if images is not None and isinstance(images, torch.Tensor):
            from .gjj_video_combine_runtime import combine_video

            format_overrides_json = json.dumps(
                {
                    "main_pass": [
                        "-c:v",
                        "libx264",
                        "-preset",
                        "ultrafast",
                        "-crf",
                        "28",
                        "-pix_fmt",
                        "yuv420p",
                        "-vf",
                        "scale=out_color_matrix=bt709",
                        "-color_range",
                        "tv",
                        "-colorspace",
                        "bt709",
                        "-color_primaries",
                        "bt709",
                        "-color_trc",
                        "bt709",
                    ],
                    "extension": "mp4",
                }
            )
            video_result = combine_video(
                images=images,
                audio=audio,
                frame_rate=frame_rate,
                loop_count=0,
                filename_prefix="GJJ_AnyPreview",
                format_name="video/h264-mp4",
                pingpong=False,
                save_output=False,
                use_source_fps=False,
                vae=None,
                format_overrides_json=format_overrides_json,
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
                unique_id=None,
            )

            if isinstance(video_result, dict):
                video_ui = video_result.get("ui", {})
                return video_ui.get("preview_media") or video_ui.get("images") or []
    except Exception as error:
        print(f"[GJJ] 视频预览失败: {error}")
        import traceback

        traceback.print_exc()
    return []


def save_image_sequence_webp_preview(
    frames: torch.Tensor,
    prompt: Any = None,
    extra_pnginfo: Any = None,
) -> list[dict[str, Any]]:
    try:
        frames = frames.detach().cpu().float().clamp(0.0, 1.0).contiguous()
        if int(frames.shape[0]) <= 0:
            return []

        target_dir = Path(folder_paths.get_temp_directory()) / "GJJ" / "any_preview"
        target_dir.mkdir(parents=True, exist_ok=True)
        filename = f"GJJ_AnyPreview_sequence_{uuid.uuid4().hex[:12]}.webp"
        filepath = target_dir / filename

        pil_frames: list[Image.Image] = []
        arrays = torch.round(frames * 255.0).to(torch.uint8).numpy()
        for array in arrays:
            if array.ndim == 2:
                pil_frames.append(Image.fromarray(array, mode="L").convert("RGB"))
                continue
            channels = int(array.shape[-1]) if array.ndim == 3 else 0
            if channels == 1:
                pil_frames.append(Image.fromarray(array[..., 0], mode="L").convert("RGB"))
            elif channels == 4:
                pil_frames.append(Image.fromarray(array, mode="RGBA"))
            else:
                pil_frames.append(Image.fromarray(array[..., :3], mode="RGB"))

        duration_ms = max(1, round(1000.0 / max(0.01, float(VIDEO_SEQUENCE_PREVIEW_FPS))))
        pil_frames[0].save(
            filepath,
            format="WEBP",
            save_all=True,
            append_images=pil_frames[1:],
            duration=duration_ms,
            loop=0,
            lossless=False,
            quality=88,
            method=4,
        )
        return [
            {
                "filename": filename,
                "subfolder": "GJJ/any_preview",
                "type": "temp",
                "format": "image/webp",
                "media_type": "image",
                "is_sequence": True,
                "autoplay": True,
                "loop": True,
                "frame_rate": VIDEO_SEQUENCE_PREVIEW_FPS,
                "frame_count": int(frames.shape[0]),
                "width": int(frames.shape[2]),
                "height": int(frames.shape[1]),
            }
        ]
    except Exception as error:
        print(f"[GJJ] WebP 序列预览失败: {error}")
        import traceback

        traceback.print_exc()
        return []


def detect_video_sequence_preview(values: list[Any]) -> tuple[str, torch.Tensor] | None:
    if not values:
        return None

    if len(values) == 1:
        value = values[0]
        if is_image_tensor(value) and image_frame_count(value) >= VIDEO_SEQUENCE_MIN_FRAMES:
            frames = normalize_image_tensor(value).detach().cpu().float().clamp(0.0, 1.0).contiguous()
            return "image", frames
        if is_mask_tensor(value) and mask_frame_count(value) >= VIDEO_SEQUENCE_MIN_FRAMES:
            frames = mask_to_preview_image(value).detach().cpu().float().clamp(0.0, 1.0).contiguous()
            return "mask", frames
        return None

    return None


def merge_values(values: list[Any]) -> tuple[str, Any, str]:
    if not values:
        return "other", None, "无可预览内容"

    preview_kinds = {detect_preview_kind(value) for value in values}
    if len(values) > 1:
        kind_text = "混合" if len(preview_kinds) > 1 else PREVIEW_KIND_LABELS.get(next(iter(preview_kinds), "other"), "对象")
        return "mixed", values, f"已平铺 {len(values)} 个{kind_text}预览项目"

    if all(is_image_tensor(value) for value in values):
        merged = merge_images(
            [value for value in values if isinstance(value, torch.Tensor)]
        )
        preview_text = f"已合并 {int(merged.shape[0])} 张图片，尺寸 {int(merged.shape[2])} x {int(merged.shape[1])}"
        return "image", merged, preview_text

    if all(is_mask_tensor(value) for value in values):
        merged = merge_images(
            [mask_to_preview_image(value) for value in values if isinstance(value, torch.Tensor)]
        )
        preview_text = f"已转换 {int(merged.shape[0])} 张遮罩为灰度预览图，尺寸 {int(merged.shape[2])} x {int(merged.shape[1])}"
        return "mask", merged, preview_text

    if all(isinstance(value, str) for value in values):
        merged = "\n".join(str(value) for value in values if str(value) != "")
        return "text", merged, merged or "空文本"

    # 新增：音频检测
    if len(values) == 1 and is_audio_object(values[0]):
        value = values[0]
        preview_text = serialize_audio_preview(value)
        return "audio", value, preview_text

    # 新增：视频检测
    if len(values) == 1 and is_video_object(values[0]):
        value = values[0]
        preview_text = serialize_video_preview(value)
        return "video", value, preview_text

    if len(values) == 1:
        value = values[0]
        if isinstance(value, str):
            return "text", value, value
        return "other", value, serialize_preview(value)

    merged = values
    return "other", merged, serialize_preview(merged)


def clone_cached_preview_value(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return value
    if torch.is_tensor(value):
        try:
            return value.detach().clone()
        except Exception:
            return value
    if isinstance(value, list):
        return [clone_cached_preview_value(item, depth + 1) for item in value]
    if isinstance(value, tuple):
        return tuple(clone_cached_preview_value(item, depth + 1) for item in value)
    if isinstance(value, dict):
        return {
            key: clone_cached_preview_value(item, depth + 1)
            for key, item in value.items()
        }
    return value


def _prompt_node_data(prompt: Any, unique_id: Any) -> dict[str, Any] | None:
    if unique_id is None or not isinstance(prompt, dict):
        return None
    key = str(unique_id).strip()
    if not key:
        return None
    node_data = prompt.get(key) or prompt.get(unique_id)
    return node_data if isinstance(node_data, dict) else None


def _is_prompt_link(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) >= 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], (int, float))
    )


def _node_has_linked_preview_inputs(prompt: Any, unique_id: Any) -> bool:
    node_data = _prompt_node_data(prompt, unique_id)
    inputs = node_data.get("inputs") if isinstance(node_data, dict) else None
    if not isinstance(inputs, dict):
        return False
    for key, value in inputs.items():
        key_text = str(key or "")
        if key_text == "batch_image" or key_text.startswith("any_"):
            if _is_prompt_link(value):
                return True
    return False


class GJJ_AnyPreview:
    CATEGORY = "GJJ"
    FUNCTION = "preview"
    OUTPUT_NODE = True
    DESCRIPTION = """动态接收任意类型输入的统一预览节点。

【核心功能】
• 图片预览：按来路平铺浏览图片，不强制合并尺寸或维度
• 文本预览：支持 Markdown 格式渲染，显示格式化文本
• 音频预览：内置播放器，支持 WAV/MP3 格式，显示波形控制条
• 视频预览：内置播放器，支持 MP4/H.264 格式，显示播放控件
• 对象预览：其他类型自动序列化为可读文本

【使用场景】
• 作为工作流最终输出的默认预览节点
• 调试时查看中间结果（图片、文本、音频、视频）
• 多路对象和批量图片的可视化检查
• 音频/视频生成结果的即时预览

【交互功能】
• 图片：悬停查看详情，点击放大，滚轮缩放网格
• 音频：播放/暂停，进度拖拽，音量调节
• 视频：播放/暂停，进度拖拽，全屏切换
• 文本：自动换行，代码高亮，滚动查看

【注意事项】
• 音频/视频首次加载可能需要几秒生成预览文件
• 大尺寸图片会自动缩略显示以保持性能
• 建议配合 GJJ 批量图片节点使用以获得最佳体验"""

    # 依赖声明
    REQUIRED_PACKAGES = [
        "soundfile>=0.12.0",  # 音频文件读写
        "numpy>=1.20.0",  # 数组处理
    ]

    # 使用的模型（本节点无需外部模型）
    REQUIRED_MODELS = []

    # 帮助文档
    GJJ_HELP = {
        "title": "GJJ · 👀 任意对象预览器",
        "version": "2.0.0",
        "author": "GJJ Custom Nodes Team",
        "description": "万能预览节点，支持图片、文本、音频、视频等专用预览，也可像官方 PreviewAny 一样查看任意对象的值",
        "features": [
            {
                "name": "图片预览",
                "description": "按来路平铺显示图片，支持缩略图、悬停详情、点击放大",
                "supported_formats": ["PNG", "JPEG", "WEBP"],
                "max_batch_size": 100,
            },
            {
                "name": "遮罩预览",
                "description": "自动把 MASK 转换为黑白灰度图预览，白色代表遮罩值 1，黑色代表遮罩值 0",
                "supported_formats": ["MASK"],
            },
            {
                "name": "文本预览",
                "description": "支持 Markdown 渲染、代码高亮、自动换行",
                "supported_formats": ["plain text", "markdown"],
                "max_length": 10000,
            },
            {
                "name": "音频预览",
                "description": "内置播放器，直接播放 ComfyUI AUDIO 对象",
                "supported_formats": ["FLAC", "WAV", "MP3"],
                "sample_rates": [16000, 22050, 44100, 48000],
            },
            {
                "name": "视频预览",
                "description": "内置播放器，支持播放控制、进度拖拽、全屏模式",
                "supported_formats": ["MP4/H.264"],
                "max_resolution": "1920x1080",
            },
        ],
        "inputs": {
            "any_01": {
                "type": ANY_PREVIEW_INPUT_TYPE,
                "required": False,
                "description": f"第一个入口显示为“任意对象”，端口为真实任意类型；{ANY_PREVIEW_FAST_TYPES} 会走专用预览，其它对象会序列化为可读文本。",
            },
            "any_XX": {
                "type": ANY_PREVIEW_INPUT_TYPE,
                "required": False,
                "description": "动态插槽，可连接任意类型数据；列表/元组会展开为多个预览项，支持混合类型同时显示。",
            },
        },
        "outputs": {
            "透传输出": {
                "type": "*",
                "description": "透传第一个有效输入；多路输入只用于浏览平铺，不会被强行合并或改尺寸。",
            },
        },
        "usage_examples": [
            {
                "title": "基础图片预览",
                "description": "连接单张、多张或多路图片进行预览",
                "workflow": "[Load Image] → [GJJ Any Preview]",
            },
            {
                "title": "批量图片检查",
                "description": "使用 GJJ 批量图片节点进行批次预览",
                "workflow": "[GJJ Batch Image] → [GJJ Any Preview]",
            },
            {
                "title": "遮罩检查",
                "description": "连接 MASK 后自动显示黑白灰度遮罩图",
                "workflow": "[MASK Output] → [GJJ Any Preview]",
            },
            {
                "title": "音频生成预览",
                "description": "预览 TTS 或音乐生成结果",
                "workflow": "[TTS Node] → [GJJ Any Preview]",
            },
            {
                "title": "视频合成预览",
                "description": "预览视频生成或合成结果",
                "workflow": "[Video Combine] → [GJJ Any Preview]",
            },
            {
                "title": "调试信息查看",
                "description": "查看任意对象的序列化文本表示",
                "workflow": "[Any Node Output] → [GJJ Any Preview]",
            },
        ],
        "technical_notes": [
            "音频/视频预览会在首次执行时生成临时文件（位于 ComfyUI temp 目录）",
            "图片预览使用 ComfyUI 原生 PreviewImage 节点的能力",
            "文本预览支持基本的 Markdown 语法（标题、列表、代码块等）",
            "动态插槽数量根据连接情况自动调整，最多支持 99 个输入",
            "所有预览数据通过 ui 字典返回，遵循 ComfyUI 规范",
        ],
        "troubleshooting": [
            {
                "problem": "音频/视频不显示播放器",
                "solution": "检查浏览器控制台是否有错误，确认文件格式正确，尝试刷新页面",
            },
            {
                "problem": "图片显示模糊",
                "solution": "这是缩略图效果，点击图片可全屏查看原始分辨率",
            },
            {
                "problem": "文本显示不完整",
                "solution": "向下滚动预览区域，或调整节点高度以显示更多内容",
            },
            {
                "problem": "预览数据为空",
                "solution": "确认已连接有效输入，检查后端日志是否有错误信息",
            },
        ],
        "changelog": [
            {
                "version": "2.0.0",
                "date": "2026-05-04",
                "changes": [
                    "✨ 新增 MASK 自动灰度图预览",
                    "✨ 新增音频预览功能（WAV/MP3 支持）",
                    "✨ 新增视频预览功能（MP4/H.264 支持）",
                    "🐛 修复 UI 数据格式问题（元组包裹规范）",
                    "🔧 优化前端 onExecuted 数据解析逻辑",
                ],
            },
            {
                "version": "1.0.0",
                "date": "2026-04-01",
                "changes": [
                    "🎉 初始版本发布",
                    "✨ 支持图片和文本预览",
                    "✨ 动态插槽系统",
                ],
            },
        ],
    }

    SEARCH_ALIASES = [
        "any preview",
        "preview any",
        "inspect any",
        "任意预览",
        "对象预览",
        "调试预览",
        "最终生成图像",
        "扩图结果图像",
        "结果图像",
        "最终预览",
        "任意对象预览器",
        "audio preview",
        "video preview",
        "媒体预览",
        "AAA",
    ]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("透传输出",)
    OUTPUT_TOOLTIPS = ("透传第一个有效输入；多路输入只用于浏览平铺。",)
    _LAST_INPUT_CACHE: dict[str, list[Any]] = {}
    _LAST_INPUT_CACHE_ORDER: list[str] = []
    _LAST_INPUT_CACHE_MAX = 64

    @classmethod
    def INPUT_TYPES(cls):
        first_input_data = {
            "any_01": (
                any_type,
                {
                    "lazy": True,
                    "display_name": "任意对象",
                    "tooltip": f"可连接任意类型；{ANY_PREVIEW_FAST_TYPES} 会走专用预览。多路输入时，此节点会先预览已到达的第一路，不再等待所有入口完成。",
                },
            ),
        }
        return {
            "required": {},
            "optional": FlexibleOptionalInputType(any_type, first_input_data),
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID"},
        }

    def __init__(self):
        self.preview_image = PreviewImage()
        self.queue_image = SaveImage()

    @classmethod
    def _cache_key(cls, unique_id: Any, prompt: Any = None) -> str:
        key = str(unique_id or "").strip()
        if not key or key == NODE_NAME:
            return ""
        return f"node:{key}"

    @classmethod
    def _remember_last_inputs(cls, unique_id: Any, values: list[Any], prompt: Any = None) -> None:
        key = cls._cache_key(unique_id, prompt)
        if not key or not values:
            return
        cls._LAST_INPUT_CACHE[key] = clone_cached_preview_value(values)
        if key in cls._LAST_INPUT_CACHE_ORDER:
            cls._LAST_INPUT_CACHE_ORDER.remove(key)
        cls._LAST_INPUT_CACHE_ORDER.append(key)
        while len(cls._LAST_INPUT_CACHE_ORDER) > cls._LAST_INPUT_CACHE_MAX:
            old_key = cls._LAST_INPUT_CACHE_ORDER.pop(0)
            cls._LAST_INPUT_CACHE.pop(old_key, None)

    @classmethod
    def _load_last_inputs(cls, unique_id: Any, prompt: Any = None) -> list[Any]:
        key = cls._cache_key(unique_id, prompt)
        if not key:
            return []
        values = cls._LAST_INPUT_CACHE.get(key)
        if not values:
            return []
        if key in cls._LAST_INPUT_CACHE_ORDER:
            cls._LAST_INPUT_CACHE_ORDER.remove(key)
            cls._LAST_INPUT_CACHE_ORDER.append(key)
        return clone_cached_preview_value(values)

    def _save_queue_thumbnail(
        self,
        preview_values: list[Any],
        prompt: Any = None,
        extra_pnginfo: Any = None,
    ) -> list[dict[str, Any]]:
        thumbnail = first_queue_thumbnail_tensor(preview_values)
        if thumbnail is None:
            return []
        try:
            image_ui = self.queue_image.save_images(
                thumbnail,
                filename_prefix=_queue_thumbnail_prefix(extra_pnginfo),
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            return annotate_preview_image_dimensions(
                image_ui.get("ui", {}).get("images", []),
                thumbnail,
            )
        except Exception as error:
            print(f"[GJJ] AnyPreview 队列缩略图保存失败: {error}")
            return []

    def check_lazy_status(self, batch_image=None, **kwargs):
        if batch_image is not None and not is_none(batch_image):
            return []

        input_keys = sorted(
            [key for key in kwargs.keys() if str(key).startswith("any_")],
            key=extract_input_index,
        )
        for key in input_keys:
            value = kwargs.get(key)
            if value is not None and not is_none(value):
                return []

        if not input_keys:
            return []
        return [input_keys[0]]

    def _save_image_preview(
        self,
        value: torch.Tensor,
        prompt: Any = None,
        extra_pnginfo: Any = None,
        is_mask: bool = False,
    ) -> list[dict[str, Any]]:
        preview_tensor = mask_to_preview_image(value) if is_mask else normalize_image_tensor(value)
        image_ui = self.preview_image.save_images(
            preview_tensor,
            filename_prefix="GJJ_AnyPreview",
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
        )
        return annotate_preview_image_dimensions(
            image_ui.get("ui", {}).get("images", []),
            preview_tensor,
        )

    def _build_preview_items(
        self,
        values: list[Any],
        prompt: Any = None,
        extra_pnginfo: Any = None,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for index, value in enumerate(values, start=1):
            kind = detect_preview_kind(value)
            type_label = concrete_preview_type_label(value, kind)
            item: dict[str, Any] = {
                "kind": "image" if kind == "mask" else kind,
                "source_kind": kind,
                "title": format_preview_item_title(index, value, kind),
                "ordinal": index,
                "ordinal_emoji": ordinal_emoji(index),
                "type_emoji": preview_kind_emoji(kind),
                "type_label": type_label,
            }

            sequence_info = detect_video_sequence_preview([value])
            sequence_handled = False
            if sequence_info is not None:
                source_kind, frames = sequence_info
                sequence_media = save_image_sequence_webp_preview(
                    frames,
                    prompt=prompt,
                    extra_pnginfo=extra_pnginfo,
                )
                if sequence_media:
                    sequence_label = "MASK_SEQUENCE" if source_kind == "mask" else "IMAGE_SEQUENCE"
                    item["kind"] = "image"
                    item["source_kind"] = source_kind
                    item["title"] = f"{ordinal_emoji(index)} 🎬 {sequence_label}"
                    item["type_emoji"] = "🎬"
                    item["type_label"] = sequence_label
                    item["images"] = sequence_media
                    item["text"] = serialize_video_sequence_preview(frames, source_kind)
                    sequence_handled = True
            if not sequence_handled:
                if kind == "image" and isinstance(value, torch.Tensor):
                    item["images"] = self._save_image_preview(
                        value,
                        prompt=prompt,
                        extra_pnginfo=extra_pnginfo,
                    )
                    item["text"] = serialize_preview(value)
                elif kind == "mask" and isinstance(value, torch.Tensor):
                    item["images"] = self._save_image_preview(
                        value,
                        prompt=prompt,
                        extra_pnginfo=extra_pnginfo,
                        is_mask=True,
                    )
                    item["text"] = serialize_preview(value)
                elif kind == "audio" and is_audio_object(value):
                    normalized_audio = normalize_audio_object(value)
                    if normalized_audio is None:
                        item["text"] = "音频对象无有效 waveform，无法生成播放器。"
                    else:
                        item["audio"] = save_audio_preview(normalized_audio)
                        item["text"] = serialize_audio_preview(normalized_audio)
                elif kind == "video" and is_video_object(value):
                    item["video"] = save_video_preview(
                        value,
                        prompt=prompt,
                        extra_pnginfo=extra_pnginfo,
                    )
                    item["text"] = serialize_video_preview(value)
                elif kind == "3d" and is_3d_file_object(value):
                    item["files"] = save_3d_file_preview(value)
                    item["text"] = serialize_preview(value)
                else:
                    item["text"] = serialize_preview(value)

            items.append(item)
        return items

    def preview(self, batch_image=None, prompt=None, extra_pnginfo=None, unique_id=None, **kwargs):
        raw_values = []
        using_cached_inputs = False

        # 优先处理 batch_image 参数
        if batch_image is not None and not is_none(batch_image):
            raw_values.append(batch_image)

        for key in sorted(kwargs.keys(), key=extract_input_index):
            if not key.startswith("any_"):
                continue
            value = kwargs.get(key)
            if is_none(value):
                continue
            raw_values.append(value)

        has_linked_inputs = _node_has_linked_preview_inputs(prompt, unique_id)
        if raw_values:
            self._remember_last_inputs(unique_id, raw_values, prompt)
        elif not has_linked_inputs:
            raw_values = self._load_last_inputs(unique_id, prompt)
            using_cached_inputs = bool(raw_values)

        preview_values = flatten_preview_values(raw_values)
        preview_kind, merged, preview_text = merge_values(preview_values)
        if using_cached_inputs and preview_values:
            preview_text = f"使用断开前缓存：{preview_text}"
        sequence_media: list[dict[str, Any]] = []
        sequence_info = detect_video_sequence_preview(preview_values)
        if sequence_info is not None:
            sequence_source_kind, sequence_frames = sequence_info
            sequence_media = save_image_sequence_webp_preview(
                sequence_frames,
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            if sequence_media:
                preview_kind = "image"
                preview_text = serialize_video_sequence_preview(
                    sequence_frames,
                    sequence_source_kind,
                )

        ui: dict[str, Any] = {
            "preview_text": (preview_text,),
            "preview_kind": (preview_kind,),
            "preview_item_count": (len(preview_values),),
            "preview_cached": ("true" if using_cached_inputs else "false",),
        }
        if len(preview_values) > 1 and not sequence_media:
            preview_items = self._build_preview_items(
                preview_values,
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            ui["preview_items"] = (preview_items,)
            ui.update(collect_queue_preview_media(preview_items))

        queue_thumbnails = self._save_queue_thumbnail(
            preview_values,
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
        )
        if queue_thumbnails:
            ui["images"] = queue_thumbnails

        # 添加调试日志
        print(f"[GJJ] 开始构建ui数据 - preview_kind: {preview_kind}")

        has_expanded_items = "preview_items" in ui

        if sequence_media:
            ui["preview_images"] = sequence_media
            if not queue_thumbnails:
                ui["images"] = [dict(item) for item in sequence_media]
            ui["preview_media"] = [dict(item) for item in sequence_media]
            ui["animated"] = [dict(item) for item in sequence_media]
            print(f"[GJJ] WebP 序列预览数据: {sequence_media}")

        elif (
            not has_expanded_items
            and preview_kind in {"image", "mask"}
            and isinstance(merged, torch.Tensor)
        ):
            preview_images = self._save_image_preview(
                merged,
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            ui["preview_images"] = preview_images
            if not queue_thumbnails:
                ui["images"] = [dict(item) for item in preview_images]
            if preview_kind == "mask":
                ui["preview_kind"] = ("image",)
            print(f"[GJJ] 图片ui数据: {ui['preview_images']}")

        # 新增：音频预览
        elif not has_expanded_items and preview_kind == "audio" and is_audio_object(merged):
            normalized_audio = normalize_audio_object(merged)
            if normalized_audio is None:
                ui["preview_text"] = ("音频对象无有效 waveform，无法生成播放器。",)
            else:
                preview_audio_data = save_audio_preview(normalized_audio)
                if preview_audio_data:
                    waveform = normalized_audio["waveform"]
                    sample_rate = int(normalized_audio["sample_rate"])
                    duration = float(waveform.shape[-1]) / float(sample_rate)
                    ui["preview_audio"] = (preview_audio_data,)
                    ui["audio"] = preview_audio_data
                    ui["preview_sample_rate"] = (sample_rate,)
                    ui["preview_duration"] = (duration,)
                    print(f"[GJJ] 音频预览数据: {preview_audio_data}")
                else:
                    ui["preview_text"] = ("音频临时文件生成失败，无法显示播放器。",)

        # 新增：视频预览
        elif not has_expanded_items and preview_kind == "video" and is_video_object(merged):
            preview_media = save_video_preview(
                merged,
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            if preview_media:
                ui["preview_video"] = (preview_media,)
                ui["preview_media"] = [dict(item) for item in preview_media]
                ui["animated"] = [dict(item) for item in preview_media]
                print(f"[GJJ] 视频预览数据: {preview_media}")

        elif not has_expanded_items and preview_kind == "3d" and is_3d_file_object(merged):
            preview_files = save_3d_file_preview(merged)
            if preview_files:
                ui["preview_files"] = (preview_files,)
                ui["files"] = preview_files
                print(f"[GJJ] 3D文件预览数据: {preview_files}")
            else:
                ui["preview_text"] = ("3D 文件临时预览生成失败。",)

        # 同时返回标准 ui.images 给 ComfyUI 队列/历史预览；前端会屏蔽本节点原生底部图片，
        # 避免与 GJJ 自定义 DOM 预览重复。

        # 添加最终调试日志
        print(f"[GJJ] 最终返回的ui数据: {ui}")
        print(f"[GJJ] ui.keys: {list(ui.keys())}")

        # 预览节点只做浏览，不改变数据形态。多路输入时输出第一个有效来路，
        # 避免不同尺寸/维度/类型被误合并后影响下游。
        result_output = raw_values[0] if raw_values else merged

        return {
            "ui": ui,
            "result": (result_output,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AnyPreview}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: " GJJ·👀 任意对象预览器"}


try:
    import subprocess
    import sys

    from aiohttp import web
    from server import PromptServer

    def _media_root(media_type: str) -> Path:
        media_type = str(media_type or "temp").strip().lower()
        if media_type == "output":
            return Path(folder_paths.get_output_directory()).resolve()
        if media_type == "input":
            return Path(folder_paths.get_input_directory()).resolve()
        return Path(folder_paths.get_temp_directory()).resolve()

    @PromptServer.instance.routes.post("/gjj/any_preview/open_media_folder")
    async def gjj_any_preview_open_media_folder(request):
        try:
            media_type = request.query.get("type", "temp")
            subfolder = str(request.query.get("subfolder", "") or "").strip("/\\")
            filename = str(request.query.get("filename", "") or "").replace("\\", "/").strip("/")
            root = _media_root(media_type)
            folder = (root / subfolder).resolve() if subfolder else root
            try:
                folder.relative_to(root)
            except ValueError:
                return web.json_response({"error": "路径越界"}, status=400)
            if not folder.exists():
                return web.json_response({"error": "目录不存在"}, status=404)
            target_file = (folder / filename).resolve() if filename else None
            if target_file is not None:
                try:
                    target_file.relative_to(root)
                except ValueError:
                    target_file = None
                if target_file is not None and not target_file.exists():
                    target_file = None
            if os.name == "nt":
                if target_file is not None:
                    subprocess.Popen(["explorer.exe", f"/select,{target_file}"])
                else:
                    subprocess.Popen(["explorer.exe", str(folder)])
            elif sys.platform == "darwin":
                if target_file is not None:
                    subprocess.Popen(["open", "-R", str(target_file)])
                else:
                    subprocess.Popen(["open", str(folder)])
            else:
                subprocess.Popen(["xdg-open", str(folder)])
            return web.json_response({"status": "ok", "path": str(folder)})
        except Exception as error:
            return web.json_response({"error": str(error)}, status=500)

except Exception:
    pass
