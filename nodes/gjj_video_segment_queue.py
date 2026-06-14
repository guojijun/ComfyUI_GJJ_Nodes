from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import torch

try:
    from aiohttp import web
except Exception:
    web = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None

import folder_paths

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_VideoSegmentQueue"
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
VIDEO_FRAME_QUEUE_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
VIDEO_UPLOAD_API_PATH = "/gjj/video_segment_queue/upload"
VIDEO_META_API_PATH = "/gjj/video_segment_queue/meta"
UPLOAD_SUBFOLDER = "gjj_video_segment_queue"
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".wmv", ".flv", ".mpeg", ".mpg", ".gif"}
DEFAULT_SEGMENT_FRAMES = 81
_VIDEO_FRAME_CACHE: dict[str, tuple[tuple[int, int], torch.Tensor, float]] = {}


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
        candidate = directory / f"{stem}_{index:03d}{suffix}"
        index += 1
    return candidate


def _display_video_entry(entry: dict[str, str]) -> str:
    filename = str(entry.get("filename") or "").strip()
    subfolder = str(entry.get("subfolder") or "").strip().replace("\\", "/")
    return f"{subfolder}/{filename}".strip("/") if subfolder else filename


def _video_from_file(path: Path):
    try:
        from comfy_api.latest import InputImpl

        return InputImpl.VideoFromFile(str(path))
    except Exception:
        from comfy_api.input_impl import VideoFromFile

        return VideoFromFile(str(path))


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _as_int(value: Any, default: int = 0) -> int:
    if isinstance(value, torch.Tensor):
        if value.numel() <= 0:
            return default
        value = value.detach().flatten()[0].item()
    try:
        return int(float(str(value).strip()))
    except Exception:
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except Exception:
        return default
    return result if math.isfinite(result) else default


def _normalize_segment_frames(value: Any) -> tuple[int, bool]:
    raw = _as_int(value, DEFAULT_SEGMENT_FRAMES)
    if raw < 9:
        return 9, raw != 9
    n = max(1, int(round((raw - 1) / 8.0)))
    normalized = n * 8 + 1
    return normalized, normalized != raw


def _align_8n_plus_1_no_padding(frame_count: int) -> int:
    count = max(1, int(frame_count or 1))
    return max(1, ((count - 1) // 8) * 8 + 1)


def _normalize_frames_tensor(value: Any, source_label: str) -> torch.Tensor | None:
    if value is None:
        return None

    if isinstance(value, torch.Tensor):
        tensor = value
    elif isinstance(value, dict):
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = value.get(key)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
    elif isinstance(value, (list, tuple)) and value and all(isinstance(item, torch.Tensor) for item in value):
        pieces = []
        for item in value:
            normalized = _normalize_frames_tensor(item, source_label)
            if normalized is not None:
                pieces.append(normalized)
        if not pieces:
            return None
        try:
            tensor = torch.cat(pieces, dim=0)
        except Exception as error:
            raise RuntimeError(f"{source_label} 的帧尺寸不一致，无法作为单视频分段队列处理：{error}") from error
    else:
        tensor = None

    if tensor is None:
        return None
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"{source_label} 必须是 [B,H,W,C] 或 [B,C,H,W] 帧张量，实际为 {tuple(tensor.shape)}。")
    if tensor.shape[-1] not in (1, 3, 4) and tensor.shape[1] in (1, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels not in (3, 4):
        raise RuntimeError(f"{source_label} 的通道数无效：{tuple(tensor.shape)}。")

    tensor = tensor.detach().float().contiguous()
    if tensor.numel() > 0:
        try:
            if float(tensor.max().item()) > 1.5:
                tensor = tensor / 255.0
        except Exception:
            pass
    return tensor.clamp(0.0, 1.0).contiguous()


def _coerce_media_to_frames(value: Any) -> tuple[torch.Tensor | None, float, str]:
    if value is None:
        return None, 0.0, ""

    direct = _normalize_frames_tensor(value, "外接帧队列")
    if direct is not None:
        fps = 0.0
        if isinstance(value, dict):
            for key in ("frame_rate", "fps", "source_fps"):
                if key in value:
                    fps = _as_float(value.get(key), 0.0)
                    break
        return direct, fps, "外接帧队列"

    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception as error:
            raise RuntimeError(f"外接 VIDEO 读取失败：{error}") from error
        frames = _normalize_frames_tensor(_component_value(components, "images"), "外接 VIDEO")
        if frames is None:
            raise RuntimeError("外接 VIDEO 没有解析出可用视频帧。")
        fps = _as_float(_component_value(components, "frame_rate"), 0.0)
        if fps <= 0 and callable(getattr(value, "get_frame_rate", None)):
            try:
                fps = _as_float(value.get_frame_rate(), 0.0)
            except Exception:
                pass
        source = "外接 VIDEO"
        if callable(getattr(value, "get_stream_source", None)):
            try:
                stream_source = value.get_stream_source()
                if isinstance(stream_source, (str, Path)):
                    source = Path(stream_source).name
            except Exception:
                pass
        return frames, fps, source

    images = getattr(value, "images", None)
    frames = _normalize_frames_tensor(images, "外接媒体")
    if frames is not None:
        return frames, 0.0, "外接媒体"

    return None, 0.0, ""


def parse_selected_video(raw_value: Any) -> dict[str, str] | None:
    if raw_value is None:
        return None
    parsed: Any = raw_value
    if isinstance(raw_value, str):
        text = raw_value.strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = text

    if isinstance(parsed, list):
        parsed = parsed[0] if parsed else None
    if isinstance(parsed, dict):
        filename = str(parsed.get("filename") or "").strip()
        subfolder = str(parsed.get("subfolder") or "").strip().replace("\\", "/")
        if filename:
            return {"filename": filename, "subfolder": subfolder}
        return None

    text = str(parsed or "").strip().replace("\\", "/")
    if not text:
        return None
    for suffix in (" [input]", "[input]"):
        if text.endswith(suffix):
            text = text[: -len(suffix)].strip()
    parts = [part for part in text.split("/") if part]
    if not parts:
        return None
    return {"filename": parts[-1], "subfolder": "/".join(parts[:-1])}


def recover_selected_video(raw_value: Any, extra_pnginfo: Any = None, unique_id: Any = None) -> dict[str, str] | None:
    selected = parse_selected_video(raw_value)
    if selected:
        return selected
    if not isinstance(extra_pnginfo, dict):
        return None
    workflow = extra_pnginfo.get("workflow")
    if not isinstance(workflow, dict):
        return None
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return None

    candidates: list[dict[str, str]] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != NODE_NAME:
            continue
        if unique_id is not None and str(node.get("id")) != str(unique_id):
            continue
        properties = node.get("properties")
        if isinstance(properties, dict):
            selected = parse_selected_video(properties.get("selected_video"))
            if selected:
                candidates.append(selected)
                continue
        widget_values = node.get("widgets_values")
        if isinstance(widget_values, list):
            for value in widget_values:
                selected = parse_selected_video(value)
                if selected:
                    candidates.append(selected)
                    break
    if unique_id is not None and candidates:
        return candidates[0]
    return candidates[0] if len(candidates) == 1 else None


def resolve_input_video_path(entry: dict[str, str]) -> Path:
    input_dir = _input_dir()
    filename = str(entry.get("filename") or "").strip()
    subfolder = str(entry.get("subfolder") or "").strip().replace("\\", "/")
    candidate = (input_dir / subfolder / filename).resolve()
    try:
        candidate.relative_to(input_dir)
    except ValueError as error:
        raise RuntimeError(f"视频路径越界：{_display_video_entry(entry)}") from error
    if not candidate.exists():
        raise RuntimeError(f"未找到视频：{_display_video_entry(entry)}")
    if candidate.suffix.lower() not in VIDEO_EXTENSIONS:
        raise RuntimeError(f"不支持的视频格式：{candidate.name}")
    return candidate


def _video_meta(path: Path) -> dict[str, Any]:
    video = _video_from_file(path)
    width = height = frame_count = 0
    fps = duration = 0.0
    try:
        width, height = video.get_dimensions()
    except Exception:
        pass
    try:
        frame_count = int(video.get_frame_count())
    except Exception:
        pass
    try:
        fps = _as_float(video.get_frame_rate(), 0.0)
    except Exception:
        pass
    try:
        duration = _as_float(video.get_duration(), 0.0)
    except Exception:
        pass
    return {
        "width": int(width or 0),
        "height": int(height or 0),
        "frames": int(frame_count or 0),
        "fps": float(fps or 0.0),
        "duration": float(duration or 0.0),
    }


def _decode_video_path(path: Path) -> tuple[torch.Tensor, float, str]:
    stat = path.stat()
    cache_key = str(path.resolve())
    cache_sig = (int(stat.st_mtime_ns), int(stat.st_size))
    cached = _VIDEO_FRAME_CACHE.get(cache_key)
    if cached and cached[0] == cache_sig:
        return cached[1], cached[2], path.name

    video = _video_from_file(path)
    try:
        components = video.get_components()
    except Exception as error:
        raise RuntimeError(f"视频解码失败：{path.name}。{error}") from error
    frames = _normalize_frames_tensor(_component_value(components, "images"), f"视频 {path.name}")
    if frames is None or int(frames.shape[0]) <= 0:
        raise RuntimeError(f"视频没有可用帧：{path.name}")
    fps = _as_float(_component_value(components, "frame_rate"), 0.0)
    if fps <= 0:
        try:
            fps = _as_float(video.get_frame_rate(), 0.0)
        except Exception:
            pass
    _VIDEO_FRAME_CACHE[cache_key] = (cache_sig, frames, fps)
    while len(_VIDEO_FRAME_CACHE) > 2:
        _VIDEO_FRAME_CACHE.pop(next(iter(_VIDEO_FRAME_CACHE)))
    return frames, fps, path.name


async def upload_video_segment_queue_video(request):
    if web is None:
        return None
    reader = await request.multipart()
    upload_dir = _input_dir() / UPLOAD_SUBFOLDER
    saved: dict[str, Any] | None = None

    while True:
        field = await reader.next()
        if field is None:
            break
        if field.name not in {"video", "file", "image"}:
            continue
        filename = _safe_filename(field.filename or "video.mp4")
        if Path(filename).suffix.lower() not in VIDEO_EXTENSIONS:
            return web.json_response({"ok": False, "error": f"不支持的视频格式：{filename}"}, status=400)
        target = _unique_path(upload_dir, filename)
        with target.open("wb") as handle:
            while True:
                chunk = await field.read_chunk()
                if not chunk:
                    break
                handle.write(chunk)
        stat = target.stat()
        entry = {
            "filename": target.name,
            "subfolder": UPLOAD_SUBFOLDER,
            "type": "input",
            "size_bytes": int(stat.st_size),
            "mtime_ns": int(stat.st_mtime_ns),
        }
        try:
            entry.update(_video_meta(target))
        except Exception:
            pass
        saved = entry
        break

    if not saved:
        return web.json_response({"ok": False, "error": "没有收到视频文件。"}, status=400)
    return web.json_response({"ok": True, "video": saved})


async def get_video_segment_queue_meta(request):
    if web is None:
        return None
    try:
        entry = {
            "filename": request.query.get("filename", ""),
            "subfolder": request.query.get("subfolder", ""),
        }
        path = resolve_input_video_path(entry)
        stat = path.stat()
        return web.json_response({
            "ok": True,
            "video": {
                "filename": path.name,
                "subfolder": entry.get("subfolder", ""),
                "type": "input",
                "size_bytes": int(stat.st_size),
                "mtime_ns": int(stat.st_mtime_ns),
                **_video_meta(path),
            },
        })
    except Exception as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


def _register_routes() -> None:
    server = getattr(PromptServer, "instance", None) if PromptServer is not None else None
    routes = getattr(server, "routes", None)
    if server is None or routes is None or web is None:
        return
    if getattr(server, "_gjj_video_segment_queue_routes_registered", False):
        return
    setattr(server, "_gjj_video_segment_queue_routes_registered", True)
    routes.post(VIDEO_UPLOAD_API_PATH)(upload_video_segment_queue_video)
    routes.get(VIDEO_META_API_PATH)(get_video_segment_queue_meta)


_register_routes()


class GJJ_VideoSegmentQueue:
    CATEGORY = "GJJ/视频"
    FUNCTION = "segment_video"
    DESCRIPTION = "零依赖单视频分段队列：外接 GJJ_BATCH_IMAGE / IMAGE / VIDEO，或在节点内点击 📁 导入视频，按 8N+1 帧数输出当前分段和 1 基分段序号。"
    SEARCH_ALIASES = ["视频分段", "单视频队列", "video segment", "segment queue", "8N+1"]
    RETURN_TYPES = (VIDEO_FRAME_QUEUE_TYPE, "INT")
    RETURN_NAMES = ("当前段视频帧", "当前段序号")
    OUTPUT_TOOLTIPS = (
        "当前分段的帧序列，输出为 IMAGE batch，并兼容 GJJ_BATCH_IMAGE。",
        "当前实际输出的 1 基分段序号。",
    )

    GJJ_HELP = {
        "title": "单视频分段队列",
        "description": DESCRIPTION,
        "usage": [
            "外接输入优先；没有外接时，点击节点内 📁 导入一个视频。",
            "每段帧数按 8N+1 递进，例如 9、17、25、33、81。",
            "需要外部滑动序号时，直接连接“当前分段序号”面板行前的小圆点。",
            "未接外部滑动序号时，前端循环按钮会自动排队：1、2、3 ... 最后一段，然后停止。",
            "末段不足每段帧数时不会补帧，只裁到不超过剩余帧数的最大 8N+1 长度。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "selected_video": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "已选视频",
                        "tooltip": "由节点内 📁 按钮写入的视频路径；通常不需要手动编辑。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "segment_frames": (
                    "INT",
                    {
                        "default": DEFAULT_SEGMENT_FRAMES,
                        "min": 9,
                        "max": 4097,
                        "step": 8,
                        "display_name": "每段帧数",
                        "tooltip": "必须是 8N+1：9、17、25、33... 手动输入偏离时会按最近的有效值校正。",
                        "hidden": True,
                        "display": "hidden",
                    },
                ),
                "segment_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 1000000,
                        "step": 1,
                        "display_name": "当前分段序号",
                        "tooltip": "1 基分段序号。可连接本行前的小圆点作为外部滑动序号；未连接时由循环队列自动推进到最后一段并停止。",
                        "hidden": True,
                        "display": "hidden",
                    },
                ),
            },
            "optional": {
                "media": (
                    MEDIA_INPUT_TYPE,
                    {
                        "display_name": "外接视频/帧队列",
                        "tooltip": "可选。支持 GJJ_BATCH_IMAGE、普通 IMAGE batch 和官方 VIDEO；外接后优先使用这里的帧序列。",
                    },
                ),
            },
            "hidden": {
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return float("NaN")

    def segment_video(
        self,
        selected_video: str = "",
        segment_frames: int = DEFAULT_SEGMENT_FRAMES,
        segment_index: int = 1,
        media=None,
        slide_start_index=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        media_provided = media is not None
        frames, fps, source_label = _coerce_media_to_frames(media)
        using_external = frames is not None
        if media_provided and frames is None:
            raise RuntimeError("外接输入不是有效的 GJJ_BATCH_IMAGE / IMAGE / VIDEO 帧序列。请断开外接输入，或换成可读取的视频/图片批次。")
        if frames is None:
            entry = recover_selected_video(selected_video, extra_pnginfo, unique_id)
            if not entry:
                raise RuntimeError("请先连接外接 GJJ_BATCH_IMAGE / IMAGE / VIDEO，或点击节点内 📁 导入一个视频。")
            path = resolve_input_video_path(entry)
            frames, fps, source_label = _decode_video_path(path)

        total_frames = int(frames.shape[0])
        if total_frames <= 0:
            raise RuntimeError("输入视频或帧队列没有可用帧。")

        segment_len, adjusted = _normalize_segment_frames(segment_frames)
        total_segments = max(1, int(math.ceil(total_frames / float(segment_len))))

        index_value = slide_start_index if slide_start_index is not None else segment_index
        raw_index = max(1, _as_int(index_value, 1))
        current_segment = min(raw_index, total_segments)
        external_controlled = slide_start_index is not None

        start = (current_segment - 1) * segment_len
        remaining_frames = max(1, total_frames - start)
        is_last_segment = current_segment >= total_segments
        output_len = _align_8n_plus_1_no_padding(remaining_frames) if is_last_segment else min(segment_len, remaining_frames)
        end = min(start + output_len, total_frames)
        segment = frames[start:end].contiguous()
        valid_frames = int(segment.shape[0])
        if valid_frames <= 0:
            segment = frames[-1:].contiguous()
            valid_frames = 1
        trimmed_frames = max(0, remaining_frames - valid_frames) if is_last_segment else 0

        range_text = f"源帧 {start + 1}-{end} / {total_frames}"
        if trimmed_frames > 0:
            range_text += f"，末段裁去 {trimmed_frames} 帧用于 8N+1 对齐"
        status = f"第 {current_segment} 段 / 共 {total_segments} 段，输出 {int(segment.shape[0])} 帧"
        if adjusted:
            status += f"，每段帧数已校正为 {segment_len}"

        return {
            "ui": {
                "gjj_video_segment_queue": [
                    {
                        "source": source_label or ("外接输入" if using_external else "内部视频"),
                        "using_external": bool(using_external),
                        "fps": float(fps or 0.0),
                        "total_frames": int(total_frames),
                        "segment_frames": int(segment_len),
                        "segment_frames_adjusted": bool(adjusted),
                        "total_segments": int(total_segments),
                        "current_segment": int(current_segment),
                        "valid_frames": int(valid_frames),
                        "output_frames": int(segment.shape[0]),
                        "padded_frames": 0,
                        "trimmed_frames": int(trimmed_frames),
                        "range_text": range_text,
                        "status": status,
                        "external_controlled": bool(external_controlled),
                    }
                ]
            },
            "result": (segment, int(current_segment)),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoSegmentQueue}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🎞️ 单视频分段队列"}
