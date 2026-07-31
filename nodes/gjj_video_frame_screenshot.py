from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Iterable

import folder_paths
import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageSequence
try:
    from server import PromptServer
except Exception:
    PromptServer = None

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_VideoFrameScreenshot"
MEDIA_INPUT_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE,VIDEO"
OUTPUT_IMAGE_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
SOURCE_MEDIA_WIDGET = "source_media"
VIDEO_UPLOAD_API_PATH = "/gjj/video_frame_screenshot/upload"
UPLOAD_SUBFOLDER = "gjj_video_frame_screenshot"
ANIMATED_EXTENSIONS = {".gif", ".webp", ".apng"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".wmv", ".flv", ".mpeg", ".mpg"}
SUPPORTED_MEDIA_EXTENSIONS = VIDEO_EXTENSIONS | ANIMATED_EXTENSIONS


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


def _input_dir() -> Path:
    return Path(folder_paths.get_input_directory()).resolve()


def _safe_filename(name: str) -> str:
    cleaned = Path(str(name or "video.mp4")).name
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", cleaned).strip(" .")
    return cleaned or "video.mp4"


def _unique_path(directory: Path, filename: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    candidate = directory / filename
    index = 1
    while candidate.exists():
        candidate = directory / f"{stem}_{index}{suffix}"
        index += 1
    return candidate


async def upload_video_frame_screenshot_media(request):
    reader = await request.multipart()
    upload_dir = _input_dir() / UPLOAD_SUBFOLDER
    saved: list[dict[str, str]] = []

    while True:
        field = await reader.next()
        if field is None:
            break
        if field.name not in {"media", "video", "file"}:
            continue

        filename = _safe_filename(field.filename or "video.mp4")
        if Path(filename).suffix.lower() not in SUPPORTED_MEDIA_EXTENSIONS:
            return web.json_response({"error": f"不支持的动画/视频格式：{filename}"}, status=400)

        target = _unique_path(upload_dir, filename)
        with target.open("wb") as handle:
            while True:
                chunk = await field.read_chunk()
                if not chunk:
                    break
                handle.write(chunk)
        saved.append({"filename": target.name, "subfolder": UPLOAD_SUBFOLDER, "type": "input"})

    if not saved:
        return web.json_response({"error": "没有收到视频或动画文件。"}, status=400)
    return web.json_response({"media": saved})


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.post(VIDEO_UPLOAD_API_PATH)(upload_video_frame_screenshot_media)


def _looks_like_channel_count(size: int) -> bool:
    return int(size) in (1, 3, 4)


def _tensor_to_bhwc(value: torch.Tensor) -> torch.Tensor | None:
    if value.numel() == 0:
        return None

    tensor = value
    if tensor.ndim == 5:
        if _looks_like_channel_count(tensor.shape[-1]):
            tensor = tensor.reshape(-1, tensor.shape[-3], tensor.shape[-2], tensor.shape[-1])
        elif _looks_like_channel_count(tensor.shape[1]):
            tensor = tensor.permute(0, 2, 3, 4, 1).reshape(
                -1, tensor.shape[3], tensor.shape[4], tensor.shape[1]
            )
        else:
            return None

    if tensor.ndim == 4:
        if _looks_like_channel_count(tensor.shape[-1]):
            frames = tensor
        elif _looks_like_channel_count(tensor.shape[1]):
            frames = tensor.movedim(1, -1)
        else:
            return None
    elif tensor.ndim == 3:
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
        for key in ("images", "image", "frames", "frame", "samples", "batch", "items", "value", "video"):
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


def _as_frame_sequence(value: Any) -> torch.Tensor:
    batches: list[torch.Tensor] = []
    _collect_frame_batches(value, batches)
    if not batches:
        raise ValueError("未从输入中提取到视频帧。")

    first_shape = tuple(batches[0].shape[1:])
    if any(tuple(batch.shape[1:]) != first_shape for batch in batches):
        raise ValueError("输入帧尺寸不一致，无法输出统一图片批次。")

    frames = torch.cat(batches, dim=0).float().clamp(0.0, 1.0).contiguous()
    if int(frames.shape[0]) < 1:
        raise ValueError("输入视频帧为空。")
    return frames


def _resolve_source_media(value: Any) -> Path | None:
    text = str(value or "").strip()
    if not text:
        return None
    parsed: Any = None
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = None
    if isinstance(parsed, dict):
        filename = str(parsed.get("filename") or "").strip()
        subfolder = str(parsed.get("subfolder") or "").strip()
        if filename:
            root = _input_dir()
            candidate = (root / subfolder / filename).resolve()
            try:
                candidate.relative_to(root)
            except Exception:
                raise ValueError("保存的视频路径不在 ComfyUI input 目录内。")
            if candidate.exists() and candidate.suffix.lower() in SUPPORTED_MEDIA_EXTENSIONS:
                return candidate
    if folder_paths.exists_annotated_filepath(text):
        candidate = Path(folder_paths.get_annotated_filepath(text)).resolve()
        if candidate.suffix.lower() in SUPPORTED_MEDIA_EXTENSIONS:
            return candidate
    return None


def _load_animated_image_frames(path: Path) -> torch.Tensor:
    with Image.open(path) as img:
        frames = []
        for frame in ImageSequence.Iterator(img):
            arr = np.asarray(frame.convert("RGB"), dtype=np.float32) / 255.0
            frames.append(torch.from_numpy(arr))
    if not frames:
        raise ValueError(f"未从动画文件读取到帧：{path.name}")
    return torch.stack(frames, dim=0).contiguous()


def _load_video_file_frames(path: Path) -> torch.Tensor:
    suffix = path.suffix.lower()
    if suffix in ANIMATED_EXTENSIONS:
        return _load_animated_image_frames(path)
    try:
        import imageio.v2 as imageio

        frames = []
        reader = imageio.get_reader(str(path))
        try:
            for frame in reader:
                arr = np.asarray(frame)
                if arr.ndim == 2:
                    arr = np.repeat(arr[..., None], 3, axis=-1)
                if arr.shape[-1] > 3:
                    arr = arr[..., :3]
                frames.append(torch.from_numpy(arr.astype(np.float32) / 255.0))
        finally:
            reader.close()
        if not frames:
            raise ValueError(f"未从视频读取到帧：{path.name}")
        return torch.stack(frames, dim=0).contiguous()
    except Exception as exc:
        raise ValueError(f"读取视频失败：{path.name}，{exc}") from exc


def _coerce_fps(value: Any) -> float | None:
    if value is None:
        return None
    try:
        fps = float(value)
        if fps > 0:
            return fps
    except Exception:
        return None
    return None


def _source_fps(value: Any) -> float:
    for key in ("frame_rate", "fps", "framerate"):
        fps = _coerce_fps(_component_value(value, key))
        if fps is not None:
            return fps

    components = _video_components(value)
    if components is not None:
        for key in ("frame_rate", "fps", "framerate"):
            fps = _coerce_fps(_component_value(components, key))
            if fps is not None:
                return fps

    if isinstance(value, dict):
        for key in ("video", "media", "value"):
            fps = _source_fps(value.get(key)) if key in value else None
            if fps:
                return fps
    return 24.0


def _save_preview_video(frames: torch.Tensor, fps: float, prompt: Any = None) -> dict[str, Any] | None:
    output_dir = folder_paths.get_temp_directory()
    filename = f"GJJ_VideoFrameScreenshot_preview_{hash(str(prompt))}_{time.time_ns()}.mp4"
    filepath = os.path.join(output_dir, filename)
    os.makedirs(output_dir, exist_ok=True)

    arr = frames.detach().cpu().numpy()
    if arr.dtype != np.uint8:
        arr = (np.clip(arr, 0.0, 1.0) * 255).astype(np.uint8)
    if arr.ndim == 4 and arr.shape[-1] > 3:
        arr = arr[..., :3]

    try:
        import imageio.v2 as imageio

        writer = imageio.get_writer(
            filepath,
            fps=max(1.0, float(fps or 24.0)),
            codec="libx264",
            macro_block_size=2,
        )
        try:
            for frame in arr:
                writer.append_data(frame)
        finally:
            writer.close()
        return {
            "filename": filename,
            "subfolder": "",
            "type": "temp",
            "mtime_ns": os.stat(filepath).st_mtime_ns,
        }
    except Exception as exc:
        print(f"[GJJ] 视频任意帧截图 - 预览视频保存失败: {exc}")
        return None


def _parse_frame_numbers(value: Any) -> list[int]:
    text = str(value or "").strip()
    if not text:
        return []
    parsed: Any = None
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = None

    numbers: list[int] = []
    if isinstance(parsed, dict):
        parsed = parsed.get("frames") or parsed.get("indices") or parsed.get("frame_indices") or []
    if isinstance(parsed, list):
        for item in parsed:
            try:
                numbers.append(int(round(float(item))))
            except Exception:
                continue
        return numbers

    for part in re.split(r"[\s,;，；]+", text):
        if not part:
            continue
        range_match = re.fullmatch(r"(-?\d+)\s*[-~:：]\s*(-?\d+)", part)
        if range_match:
            start = int(range_match.group(1))
            end = int(range_match.group(2))
            step = 1 if end >= start else -1
            numbers.extend(range(start, end + step, step))
            continue
        try:
            numbers.append(int(round(float(part))))
        except Exception:
            continue
    return numbers


def _clamp_frame_numbers(numbers: list[int], total: int) -> list[int]:
    if total <= 0:
        return [1]
    if not numbers:
        return [1]
    return [max(1, min(int(total), int(number))) for number in numbers]


class GJJ_VideoFrameScreenshot:
    CATEGORY = "GJJ/🎬 视频"
    FUNCTION = "extract"
    DESCRIPTION = "从 VIDEO / IMAGE 批次 / GJJ_BATCH_IMAGE 中按 1 基帧号截取任意帧，并按选择顺序输出为 GJJ_BATCH_IMAGE,IMAGE。"
    SEARCH_ALIASES = ["video frame screenshot", "视频截图", "截取任意帧", "抽帧截图", "frame picker"]
    RETURN_TYPES = (OUTPUT_IMAGE_TYPE,)
    RETURN_NAMES = ("截图图片",)
    OUTPUT_TOOLTIPS = ("按选择顺序输出的截图图片批次，类型为 GJJ_BATCH_IMAGE,IMAGE。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "media": (MEDIA_INPUT_TYPE, {"display_name": "视频/图像序列"}),
                "frame_indices": (
                    "STRING",
                    {
                        "default": "1",
                        "display_name": "帧号列表",
                        "tooltip": "1 基帧号，支持 JSON 数组、逗号分隔、范围如 1-9。输出会保留顺序和重复项。",
                        "multiline": True,
                    },
                ),
                SOURCE_MEDIA_WIDGET: (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "保存的视频",
                        "tooltip": "由前端 📁 上传并保存到工作流的视频/动画文件信息。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
            },
        }

    def extract(self, media=None, frame_indices: str = "1", source_media: str = "", prompt: Any = None):
        source_path = None if media is not None else _resolve_source_media(source_media)
        if media is not None:
            frames = _as_frame_sequence(media)
        elif source_path is not None:
            frames = _load_video_file_frames(source_path)
        else:
            raise ValueError("请连接视频/图像序列，或用 📁 打开并保存一个视频/动画文件。")
        total = int(frames.shape[0])
        fps = _source_fps(media)
        frame_numbers = _clamp_frame_numbers(_parse_frame_numbers(frame_indices), total)
        zero_indices = torch.tensor([number - 1 for number in frame_numbers], dtype=torch.long, device=frames.device)
        output = frames.index_select(0, zero_indices).contiguous()
        preview_video = _save_preview_video(frames, fps, prompt)
        summary = f"已截取 {len(frame_numbers)} 帧 / 源总帧 {total}：{', '.join(str(n) for n in frame_numbers[:24])}"
        if len(frame_numbers) > 24:
            summary += "..."
        ui = {
            "preview_text": [summary],
            "preview_video": [preview_video] if preview_video else [],
            "preview_frame_rate": [fps],
            "frame_count": [total],
            "selected_frames": [json.dumps(frame_numbers, ensure_ascii=False)],
            "selected_count": [len(frame_numbers)],
        }
        return {
            "ui": ui,
            "result": (output,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoFrameScreenshot}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ 视频任意帧截图"}
