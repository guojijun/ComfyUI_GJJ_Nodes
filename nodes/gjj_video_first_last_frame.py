import os
from pathlib import Path
from typing import Any, Iterable, Optional

import torch


MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO,STRING"
VIDEO_EXTENSIONS = {
    ".mp4",
    ".mov",
    ".m4v",
    ".webm",
    ".avi",
    ".mkv",
    ".wmv",
    ".flv",
    ".mpeg",
    ".mpg",
    ".gif",
    ".ts",
    ".m2ts",
    ".3gp",
    ".ogv",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
MEDIA_EXTENSIONS = VIDEO_EXTENSIONS | IMAGE_EXTENSIONS


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value: Any) -> Any:
    getter = getattr(value, "get_components", None)
    if callable(getter):
        try:
            return getter()
        except Exception:
            return None
    return None


def _media_root(media_type: str) -> Path:
    media_type = str(media_type or "temp").strip().lower()
    try:
        import folder_paths

        if media_type == "output":
            return Path(folder_paths.get_output_directory()).resolve()
        if media_type == "input":
            return Path(folder_paths.get_input_directory()).resolve()
        return Path(folder_paths.get_temp_directory()).resolve()
    except Exception:
        return Path.cwd().resolve()


def _path_from_comfy_item(value: dict[str, Any]) -> Path | None:
    filename = str(value.get("filename") or "").replace("\\", "/").strip("/")
    if not filename or "/" in filename:
        return None
    subfolder = str(value.get("subfolder") or "").replace("\\", "/").strip("/")
    root = _media_root(str(value.get("type") or "temp"))
    candidate = (root / subfolder / filename).resolve() if subfolder else (root / filename).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def _path_from_text(value: Any) -> Path | None:
    text = os.fspath(value) if isinstance(value, os.PathLike) else str(value or "")
    text = text.strip().strip('"').strip("'")
    if not text:
        return None
    if text.startswith("file://"):
        text = text[7:]
    text = text.split("?", 1)[0]
    candidate = Path(text).expanduser()
    if candidate.is_file():
        return candidate.resolve()
    if not candidate.is_absolute():
        input_candidate = (_media_root("input") / text).resolve()
        if input_candidate.is_file():
            return input_candidate
    return None


def _resolve_media_path(value: Any) -> Path | None:
    if value is None:
        return None
    if isinstance(value, dict):
        path = _path_from_comfy_item(value)
        if path is not None:
            return path
        for key in (
            "path",
            "filepath",
            "file_path",
            "source_path",
            "video_path",
            "filename",
            "file",
            "video",
        ):
            if key not in value:
                continue
            path = _resolve_media_path(value.get(key))
            if path is not None:
                return path
    for method_name in ("get_stream_source", "get_filename", "get_filepath", "get_path"):
        method = getattr(value, method_name, None)
        if not callable(method):
            continue
        try:
            path = _resolve_media_path(method())
        except Exception:
            path = None
        if path is not None:
            return path
    for attr in (
        "stream_source",
        "source",
        "source_path",
        "filepath",
        "file_path",
        "filename",
        "path",
        "video_path",
        "_path",
        "_filename",
        "_video_path",
    ):
        candidate = getattr(value, attr, None)
        if candidate is None or candidate is value:
            continue
        path = _resolve_media_path(candidate)
        if path is not None:
            return path
    if isinstance(value, (str, os.PathLike)):
        return _path_from_text(value)
    return None


def _collect_media_paths(value: Any) -> list[Path]:
    paths: list[Path] = []
    seen: set[str] = set()

    def add(path: Path | None) -> bool:
        if path is None or path.suffix.lower() not in MEDIA_EXTENSIONS:
            return False
        key = str(path.resolve()).lower()
        if key in seen:
            return True
        seen.add(key)
        paths.append(path.resolve())
        return True

    def walk(item: Any) -> None:
        if item is None:
            return
        if add(_resolve_media_path(item)):
            return
        if isinstance(item, dict):
            for key in (
                "items",
                "videos",
                "video",
                "video_paths",
                "paths",
                "files",
                "selected",
                "value",
                "values",
                "outputs",
                "result",
                "results",
            ):
                if key in item:
                    walk(item.get(key))
            return
        components = _video_components(item)
        if components is not None:
            walk(components)
            return
        if isinstance(item, (list, tuple, set)):
            for child in item:
                walk(child)

    walk(value)
    return paths


def _looks_like_channel_count(size: int) -> bool:
    return int(size) in (1, 3, 4)


def _tensor_to_bhwc(value: torch.Tensor) -> Optional[torch.Tensor]:
    if value.numel() == 0:
        return None

    tensor = value
    if tensor.ndim == 5:
        # Common video forms: B,T,H,W,C or B,C,T,H,W.
        if _looks_like_channel_count(tensor.shape[-1]):
            tensor = tensor.reshape(-1, tensor.shape[-3], tensor.shape[-2], tensor.shape[-1])
        elif _looks_like_channel_count(tensor.shape[1]):
            tensor = tensor.permute(0, 2, 3, 4, 1).reshape(
                -1, tensor.shape[3], tensor.shape[4], tensor.shape[1]
            )
        else:
            return None

    if tensor.ndim == 4:
        # ComfyUI IMAGE is BHWC. Accept NCHW too for compatibility.
        if _looks_like_channel_count(tensor.shape[-1]):
            frames = tensor
        elif _looks_like_channel_count(tensor.shape[1]):
            frames = tensor.movedim(1, -1)
        else:
            return None
    elif tensor.ndim == 3:
        # Accept HWC and CHW single frames.
        if _looks_like_channel_count(tensor.shape[-1]):
            frames = tensor.unsqueeze(0)
        elif _looks_like_channel_count(tensor.shape[0]):
            frames = tensor.movedim(0, -1).unsqueeze(0)
        else:
            return None
    else:
        return None

    return frames.float().clamp(0.0, 1.0).contiguous()


def _iter_children(value: Any) -> Iterable[Any]:
    if isinstance(value, dict):
        preferred_keys = (
            "images",
            "image",
            "frames",
            "frame",
            "samples",
            "batch",
            "items",
            "value",
            "video",
        )
        for key in preferred_keys:
            if key in value:
                yield value[key]
        return

    components = _video_components(value)
    if components is not None:
        for key in ("images", "image", "frames", "frame"):
            child = _component_value(components, key)
            if child is not None:
                yield child
        return

    if isinstance(value, (list, tuple)):
        yield from value


def _collect_frame_batches(value: Any, batches: list[torch.Tensor]) -> None:
    if isinstance(value, torch.Tensor):
        frames = _tensor_to_bhwc(value)
        if frames is not None:
            batches.append(frames)
        return

    for child in _iter_children(value):
        _collect_frame_batches(child, batches)


def _load_image_file(path: Path) -> torch.Tensor:
    try:
        import numpy as np
        from PIL import Image, ImageOps
    except Exception as exc:
        raise RuntimeError(f"读取图片文件需要 Pillow/numpy：{exc}") from exc

    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        array = np.asarray(image).astype("float32") / 255.0
    return torch.from_numpy(array).unsqueeze(0).contiguous()


def _decode_video_file_pair(path: Path) -> torch.Tensor:
    try:
        from .gjj_multi_video_loader import decode_video_frame_pair

        return decode_video_frame_pair(path, 0, 0)
    except Exception as error:
        raise RuntimeError(f"读取视频首尾帧失败：{path.name}；{error}") from error


def _decode_media_pair(path: Path) -> torch.Tensor:
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        frame = _load_image_file(path)
        return torch.cat([frame, frame], dim=0).contiguous()
    if suffix in VIDEO_EXTENSIONS:
        return _decode_video_file_pair(path)
    raise RuntimeError(f"不支持的媒体格式：{path.name}")


def _as_frame_sequence(value: Any) -> torch.Tensor:
    batches: list[torch.Tensor] = []
    _collect_frame_batches(value, batches)

    if not batches:
        raise ValueError("未从输入中提取到图像帧。")

    first_shape = tuple(batches[0].shape[1:])
    if any(tuple(batch.shape[1:]) != first_shape for batch in batches):
        raise ValueError("输入图像序列尺寸不一致，无法合并首尾帧。")

    frames = torch.cat(batches, dim=0)
    if frames.shape[0] < 1:
        raise ValueError("输入图像序列为空。")
    return frames


def _extract_first_last(value: Any) -> tuple[torch.Tensor, torch.Tensor]:
    batches: list[torch.Tensor] = []
    _collect_frame_batches(value, batches)
    if batches:
        frames = _as_frame_sequence(value)
        return frames[:1], frames[-1:]

    paths = _collect_media_paths(value)
    if not paths:
        raise ValueError("未从输入中提取到图像帧，也没有解析到可读取的视频/图片文件。")

    first_pair = _decode_media_pair(paths[0])
    last_pair = first_pair if len(paths) == 1 else _decode_media_pair(paths[-1])
    return first_pair[:1].contiguous(), last_pair[-1:].contiguous()


class GJJ_VideoFirstLastFrame:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "media": (MEDIA_INPUT_TYPE, {"display_name": "视频/图像序列"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("首帧", "尾帧")
    FUNCTION = "extract"
    CATEGORY = "GJJ/视频"

    def extract(self, media):
        return _extract_first_last(media)


NODE_CLASS_MAPPINGS = {
    "GJJ_VideoFirstLastFrame": GJJ_VideoFirstLastFrame,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_VideoFirstLastFrame": "GJJ · 视频首尾帧",
}
