from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import torch

try:
    import folder_paths
except Exception:
    folder_paths = None


NODE_NAME = "GJJ_MediaFrameCount"
MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv"}


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value: Any) -> Any:
    if not hasattr(value, "get_components"):
        return None
    try:
        return value.get_components()
    except Exception:
        return None


def _count_tensor_frames(value: torch.Tensor) -> int:
    if value.ndim <= 0:
        return 0
    if value.ndim == 3:
        return 1
    return max(0, int(value.shape[0]))


def _positive_int(value: Any) -> int:
    try:
        count = int(float(str(value).strip()))
    except Exception:
        return 0
    return count if count > 0 else 0


def _ratio_to_float(value: Any) -> float:
    text = str(value or "").strip()
    if not text:
        return 0.0
    if "/" in text:
        left, right = text.split("/", 1)
        try:
            return float(left) / max(1e-9, float(right))
        except Exception:
            return 0.0
    try:
        return float(text)
    except Exception:
        return 0.0


def _call_noarg(value: Any, method_name: str) -> Any:
    method = getattr(value, method_name, None)
    if not callable(method):
        return None
    try:
        return method()
    except Exception:
        return None


def _quick_attr_frame_count(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, dict):
        for key in ("frame_count", "num_frames", "count", "frames", "length"):
            count = _positive_int(value.get(key))
            if count > 0:
                return count
        metadata = value.get("metadata")
        if isinstance(metadata, dict):
            count = _quick_attr_frame_count(metadata)
            if count > 0:
                return count
    for attr in ("frame_count", "num_frames", "count", "frames", "length"):
        count = _positive_int(getattr(value, attr, None))
        if count > 0:
            return count
    return 0


def _positive_float(value: Any) -> float:
    result = _ratio_to_float(value)
    return result if result > 0 else 0.0


def _quick_attr_frame_rate(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, dict):
        for key in ("frame_rate", "fps", "rate", "source_fps", "source_video_fps"):
            fps = _positive_float(value.get(key))
            if fps > 0:
                return fps
        metadata = value.get("metadata")
        if isinstance(metadata, dict):
            fps = _quick_attr_frame_rate(metadata)
            if fps > 0:
                return fps
    for attr in ("frame_rate", "fps", "rate", "source_fps", "source_video_fps"):
        fps = _positive_float(getattr(value, attr, None))
        if fps > 0:
            return fps
    return 0.0


def _output_root() -> Path:
    if folder_paths is not None:
        return Path(folder_paths.get_output_directory()).resolve()
    return (Path.cwd() / "output").resolve()


def _input_root() -> Path:
    if folder_paths is not None:
        return Path(folder_paths.get_input_directory()).resolve()
    return Path.cwd().resolve()


def _temp_root() -> Path:
    if folder_paths is not None:
        return Path(folder_paths.get_temp_directory()).resolve()
    return (Path.cwd() / "temp").resolve()


def _path_from_text(value: Any) -> Path | None:
    text = str(value or "").strip().strip('"')
    if not text:
        return None
    candidate = Path(os.path.expandvars(os.path.expanduser(text)))
    candidates = [candidate]
    if not candidate.is_absolute():
        candidates.extend([_input_root() / candidate, _output_root() / candidate, _temp_root() / candidate, Path.cwd() / candidate])
    for item in candidates:
        try:
            if item.exists() and item.is_file() and item.suffix.lower() in VIDEO_SUFFIXES:
                return item.resolve()
        except Exception:
            continue
    return None


def _path_from_comfy_item(value: Any) -> Path | None:
    if not isinstance(value, dict):
        return None
    for key in ("path", "filepath", "fullpath", "file"):
        path = _path_from_text(value.get(key))
        if path:
            return path
    filename = str(value.get("filename") or "").strip()
    if not filename:
        return None
    subfolder = str(value.get("subfolder") or "").strip().replace("\\", "/")
    item_type = str(value.get("type") or "input").strip().lower()
    root = _temp_root() if item_type == "temp" else _output_root() if item_type == "output" else _input_root()
    path = (root / subfolder / filename).resolve()
    return path if path.exists() and path.is_file() and path.suffix.lower() in VIDEO_SUFFIXES else None


def _video_path(value: Any) -> Path | None:
    path = _path_from_comfy_item(value)
    if path:
        return path
    if isinstance(value, dict):
        for key in ("video", "source", "stream_source", "value", "selected", "filename"):
            path = _video_path(value.get(key))
            if path:
                return path
    source = _call_noarg(value, "get_stream_source")
    path = _path_from_text(source)
    if path:
        return path
    for attr in ("stream_source", "source", "source_path", "filepath", "file_path", "filename", "path", "_path", "_filename"):
        path = _path_from_text(getattr(value, attr, None))
        if path:
            return path
    if isinstance(value, (str, os.PathLike)):
        return _path_from_text(value)
    return None


def _ffprobe_exe() -> str:
    try:
        import imageio_ffmpeg
        ffmpeg_path = Path(imageio_ffmpeg.get_ffmpeg_exe())
        probe_name = "ffprobe.exe" if ffmpeg_path.suffix.lower() == ".exe" else "ffprobe"
        candidate = ffmpeg_path.with_name(probe_name)
        if candidate.exists():
            return str(candidate)
    except Exception:
        pass
    return shutil.which("ffprobe") or "ffprobe"


def _ffprobe_video_stream(path: Path) -> dict[str, Any]:
    command = [
        _ffprobe_exe(),
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=nb_frames,duration,avg_frame_rate,r_frame_rate",
        "-of", "json",
        str(path),
    ]
    try:
        proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=5)
        if proc.returncode != 0:
            return {}
        payload = json.loads(proc.stdout or "{}")
        streams = payload.get("streams") or []
    except Exception:
        return {}
    return streams[0] if streams else {}


def _ffprobe_frame_rate(path: Path) -> float:
    stream = _ffprobe_video_stream(path)
    return _ratio_to_float(stream.get("avg_frame_rate")) or _ratio_to_float(stream.get("r_frame_rate"))


def _ffprobe_frame_count(path: Path) -> int:
    stream = _ffprobe_video_stream(path)
    if not stream:
        return 0
    count = _positive_int(stream.get("nb_frames"))
    if count > 0:
        return count
    fps = _ratio_to_float(stream.get("avg_frame_rate")) or _ratio_to_float(stream.get("r_frame_rate"))
    try:
        duration = float(stream.get("duration") or 0.0)
    except Exception:
        duration = 0.0
    if fps > 0 and duration > 0:
        return max(1, int(round(fps * duration)))
    return 0


def _safe_method_frame_count(value: Any) -> int:
    method = getattr(value, "get_frame_count", None)
    if not callable(method):
        return 0
    owner = getattr(method, "__qualname__", "")
    if owner == "VideoInput.get_frame_count":
        return 0
    return _positive_int(_call_noarg(value, "get_frame_count"))


def _safe_method_frame_rate(value: Any) -> float:
    return _positive_float(_call_noarg(value, "get_frame_rate"))


def _frame_count(value: Any) -> int:
    if value is None:
        return 0

    count = _quick_attr_frame_count(value)
    if count > 0:
        return count

    path = _video_path(value)
    if path is not None:
        count = _ffprobe_frame_count(path)
        if count > 0:
            return count

    count = _safe_method_frame_count(value)
    if count > 0:
        return count

    components = _video_components(value)
    if components is not None:
        count = _quick_attr_frame_count(components)
        if count > 0:
            return count
        images = _component_value(components, "images")
        if isinstance(images, torch.Tensor):
            return _count_tensor_frames(images)

    if isinstance(value, torch.Tensor):
        return _count_tensor_frames(value)

    if isinstance(value, dict):
        for key in ("images", "frames", "samples"):
            count = _frame_count(value.get(key))
            if count > 0:
                return count
    images = getattr(value, "images", None)
    if isinstance(images, torch.Tensor):
        return _count_tensor_frames(images)

    if isinstance(value, (list, tuple)):
        if not value:
            return 0
        total = 0
        for item in value:
            count = _frame_count(item)
            total += count if count > 0 else 1
        return total

    return 0


def _frame_rate(value: Any) -> float:
    if value is None:
        return 0.0

    fps = _quick_attr_frame_rate(value)
    if fps > 0:
        return fps

    fps = _safe_method_frame_rate(value)
    if fps > 0:
        return fps

    path = _video_path(value)
    if path is not None:
        fps = _ffprobe_frame_rate(path)
        if fps > 0:
            return fps

    components = _video_components(value)
    if components is not None:
        fps = _quick_attr_frame_rate(components)
        if fps > 0:
            return fps

    if isinstance(value, dict):
        for key in ("video", "source", "stream_source", "value", "selected"):
            fps = _frame_rate(value.get(key))
            if fps > 0:
                return fps

    if isinstance(value, (list, tuple)):
        for item in value:
            fps = _frame_rate(item)
            if fps > 0:
                return fps

    return 0.0


class GJJ_MediaFrameCount:
    CATEGORY = "GJJ/🎬 视频"
    FUNCTION = "count_frames"
    DESCRIPTION = "获取图片批次、视频帧序列或 VIDEO 的帧数量，并尽量快速读取原视频帧率。"
    SEARCH_ALIASES = ["帧数量", "视频数量", "图片序列数量", "frame count", "video frame count", "video fps", "帧率"]
    RETURN_TYPES = ("INT", "FLOAT")
    RETURN_NAMES = ("数量", "帧率")
    OUTPUT_TOOLTIPS = ("输入视频或帧序列的帧数量。", "原视频帧率；图片批次或无法读取时为 0。")

    GJJ_HELP = {
        "title": "获取视频/帧序列数量",
        "description": "读取 GJJ_BATCH_IMAGE、IMAGE 批次或官方 VIDEO 中的帧数量，并输出数量和原视频帧率。",
        "usage": [
            "连接图片批次、帧序列或 VIDEO 到输入口。",
            "执行后输入口标签会显示为“视频/帧序列（数量）”。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "media": (
                    MEDIA_TYPE,
                    {
                        "display_name": "视频/帧序列",
                        "tooltip": "支持 GJJ_BATCH_IMAGE、IMAGE 批次和官方 VIDEO。",
                    },
                ),
            },
        }

    def count_frames(self, media):
        count = _frame_count(media)
        fps = _frame_rate(media)
        return {"ui": {"frame_count": [count], "frame_rate": [fps]}, "result": (count, fps)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MediaFrameCount}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔢 视频帧数量\帧率"}
