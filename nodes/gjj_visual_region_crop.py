from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any

import folder_paths
import numpy as np
import torch
from PIL import Image

try:
    from aiohttp import web
except Exception:
    web = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None


NODE_NAME = "GJJ_VisualRegionCrop"
INPUT_MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
OUTPUT_MEDIA_TYPE = "IMAGE"
DIM_TYPE = "INT,FLOAT,STRING"
ALIGN = 64
MIN_CROP_SIZE = 256
VIDEO_UPLOAD_API_PATH = "/gjj/visual_region_crop/upload"
VIDEO_META_API_PATH = "/gjj/visual_region_crop/meta"
UPLOAD_SUBFOLDER = "gjj_visual_region_crop"
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".wmv", ".flv", ".mpeg", ".mpg", ".gif"}
_VIDEO_FRAME_CACHE: dict[str, tuple[tuple[int, int], torch.Tensor, float]] = {}


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _media_components(value: Any) -> Any:
    if isinstance(value, dict):
        return value
    if hasattr(value, "get_components"):
        try:
            return value.get_components()
        except Exception:
            return None
    return None


def _source_path_from_media(value: Any) -> Path | None:
    components = _media_components(value)
    for source in (components, value):
        if source is None:
            continue
        raw_path = None
        for key in ("path", "video_path", "filename", "file", "source"):
            raw_path = _component_value(source, key)
            if raw_path:
                break
        if not raw_path:
            continue
        raw_text = str(raw_path).strip()
        if not raw_text:
            continue
        candidates: list[Path] = []
        try:
            candidate = Path(raw_text)
            if candidate.is_absolute():
                candidates.append(candidate)
            else:
                candidates.extend([
                    Path(folder_paths.get_input_directory()) / raw_text,
                    Path(folder_paths.get_output_directory()) / raw_text,
                    Path(folder_paths.get_temp_directory()) / raw_text,
                ])
        except Exception:
            continue
        for candidate in candidates:
            try:
                path = candidate.resolve()
            except Exception:
                continue
            if path.exists() and path.suffix.lower() in VIDEO_EXTENSIONS:
                return path
    return None


def _view_entry_from_path(path: Path) -> dict[str, Any] | None:
    try:
        resolved = path.resolve()
    except Exception:
        return None
    roots = (
        ("input", Path(folder_paths.get_input_directory()).resolve()),
        ("output", Path(folder_paths.get_output_directory()).resolve()),
        ("temp", Path(folder_paths.get_temp_directory()).resolve()),
    )
    for view_type, root in roots:
        try:
            relative = resolved.relative_to(root)
        except ValueError:
            continue
        subfolder = "" if relative.parent == Path(".") else str(relative.parent).replace("\\", "/")
        entry: dict[str, Any] = {
            "filename": resolved.name,
            "subfolder": subfolder,
            "type": view_type,
        }
        try:
            stat = resolved.stat()
            entry.update({"size_bytes": int(stat.st_size), "mtime_ns": int(stat.st_mtime_ns)})
        except Exception:
            pass
        try:
            entry.update(_video_meta(resolved))
        except Exception:
            pass
        return entry
    return None


def _source_video_entry(media: Any, selected_video: Any = "", extra_pnginfo: Any = None, unique_id: Any = None) -> dict[str, Any] | None:
    path = _source_path_from_media(media)
    if path is not None:
        return _view_entry_from_path(path)
    if media is not None:
        return None
    entry = recover_selected_video(selected_video, extra_pnginfo, unique_id)
    if not entry:
        return None
    try:
        path = resolve_input_video_path(entry)
    except Exception:
        return None
    return _view_entry_from_path(path)


def _extract_media_tensor(value: Any) -> torch.Tensor | None:
    if isinstance(value, torch.Tensor):
        return value
    if isinstance(value, dict):
        for key in ("images", "image", "frames", "samples"):
            tensor = _extract_media_tensor(value.get(key))
            if tensor is not None:
                return tensor
    if hasattr(value, "get_components"):
        components = value.get_components()
        tensor = _extract_media_tensor(_component_value(components, "images"))
        if tensor is None:
            tensor = _extract_media_tensor(_component_value(components, "frames"))
        return tensor
    if hasattr(value, "images"):
        return _extract_media_tensor(getattr(value, "images"))
    if hasattr(value, "frames"):
        return _extract_media_tensor(getattr(value, "frames"))
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


def _normalize_bhwc(tensor: torch.Tensor) -> torch.Tensor:
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"可视化区域裁切需要 [B,H,W,C] 或 [B,C,H,W]，实际为 {tuple(tensor.shape)}。")
    if tensor.shape[-1] not in (1, 2, 3, 4) and tensor.shape[1] in (1, 2, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    if int(tensor.shape[-1]) <= 0:
        raise RuntimeError("可视化区域裁切收到的媒体通道数无效。")
    tensor = tensor.detach()
    if not torch.is_floating_point(tensor) or tensor.dtype != torch.float32:
        tensor = tensor.float()
    return tensor.clamp(0.0, 1.0).contiguous()


def _media_to_frames(media: Any, selected_video: Any = "", extra_pnginfo: Any = None, unique_id: Any = None) -> torch.Tensor:
    tensor = _extract_media_tensor(media)
    if tensor is not None:
        return _normalize_bhwc(tensor)
    if media is not None:
        raise RuntimeError(f"可视化区域裁切无法读取输入媒体：{type(media).__name__}。")

    entry = recover_selected_video(selected_video, extra_pnginfo, unique_id)
    if not entry:
        raise RuntimeError("请先连接上游 GJJ_BATCH_IMAGE / IMAGE / VIDEO，或点击节点内 📁 打开一个视频。")
    return _decode_video_path(resolve_input_video_path(entry))


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except Exception:
        return default
    return result if np.isfinite(result) else default


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
    if not parts or Path(parts[-1]).suffix.lower() not in VIDEO_EXTENSIONS:
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


def _decode_video_path(path: Path) -> torch.Tensor:
    stat = path.stat()
    cache_key = str(path.resolve())
    cache_sig = (int(stat.st_mtime_ns), int(stat.st_size))
    cached = _VIDEO_FRAME_CACHE.get(cache_key)
    if cached and cached[0] == cache_sig:
        return cached[1]

    video = _video_from_file(path)
    try:
        components = video.get_components()
    except Exception as error:
        raise RuntimeError(f"视频解码失败：{path.name}。{error}") from error
    tensor = _extract_media_tensor(components)
    if tensor is None:
        raise RuntimeError(f"视频没有可用帧：{path.name}")
    frames = _normalize_bhwc(tensor)
    if int(frames.shape[0]) <= 0:
        raise RuntimeError(f"视频没有可用帧：{path.name}")
    _VIDEO_FRAME_CACHE[cache_key] = (cache_sig, frames, 0.0)
    while len(_VIDEO_FRAME_CACHE) > 2:
        _VIDEO_FRAME_CACHE.pop(next(iter(_VIDEO_FRAME_CACHE)))
    return frames


async def upload_visual_region_crop_video(request):
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


async def get_visual_region_crop_video_meta(request):
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
    if getattr(server, "_gjj_visual_region_crop_routes_registered", False):
        return
    setattr(server, "_gjj_visual_region_crop_routes_registered", True)
    routes.post(VIDEO_UPLOAD_API_PATH)(upload_visual_region_crop_video)
    routes.get(VIDEO_META_API_PATH)(get_visual_region_crop_video_meta)


_register_routes()


def _as_int(value: Any, default: int = 0) -> int:
    if isinstance(value, torch.Tensor):
        if value.numel() <= 0:
            return default
        value = value.flatten()[0].item()
    try:
        return int(round(float(str(value).strip())))
    except Exception:
        return default


def _align_down(value: int, multiple: int = ALIGN) -> int:
    value = max(1, int(value or 1))
    multiple = max(1, int(multiple or 1))
    return max(multiple, (value // multiple) * multiple)


def _min_crop_size(limit: int) -> int:
    limit = max(1, int(limit or 1))
    if limit < MIN_CROP_SIZE:
        return _align_down(limit, ALIGN) if limit >= ALIGN else limit
    return MIN_CROP_SIZE


def _aligned_size(value: Any, fallback: int, limit: int) -> int:
    limit = max(1, int(limit or 1))
    min_size = _min_crop_size(limit)
    raw = _as_int(value, fallback)
    raw = max(min_size, min(limit, raw))
    if raw >= ALIGN:
        raw = _align_down(raw, ALIGN)
    if raw < min_size:
        raw = min_size
    if raw > limit:
        raw = _align_down(limit, ALIGN) if limit >= ALIGN else limit
    return max(1, min(limit, raw))


def _safe_crop_data(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    text = str(value or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _normalize_keyframes(data: dict[str, Any], frame_count: int, src_w: int, src_h: int, crop_w: int, crop_h: int) -> list[dict[str, int]]:
    result: list[dict[str, int]] = []
    for item in data.get("keyframes") or []:
        if not isinstance(item, dict):
            continue
        frame = max(0, min(frame_count - 1, _as_int(item.get("frame"), 0)))
        x = max(0, min(src_w - crop_w, _as_int(item.get("x"), 0)))
        y = max(0, min(src_h - crop_h, _as_int(item.get("y"), 0)))
        result.append({"frame": frame, "x": x, "y": y})
    if not result:
        result.append({
            "frame": 0,
            "x": max(0, (src_w - crop_w) // 2),
            "y": max(0, (src_h - crop_h) // 2),
        })
    by_frame: dict[int, dict[str, int]] = {}
    for item in result:
        by_frame[item["frame"]] = item
    return [by_frame[key] for key in sorted(by_frame.keys())]


def _normalize_frame_range(data: dict[str, Any], frame_count: int) -> tuple[int, int]:
    max_frame = max(0, int(frame_count) - 1)
    start = max(0, min(max_frame, _as_int(data.get("range_start"), 0)))
    raw_end = max(start, min(max_frame, _as_int(data.get("range_end"), max_frame)))
    end = start + ((raw_end - start) // 8) * 8
    return int(start), int(max(start, min(max_frame, end)))


def _interp_at(frame: int, keyframes: list[dict[str, int]], src_w: int, src_h: int, crop_w: int, crop_h: int) -> tuple[int, int]:
    if frame <= keyframes[0]["frame"]:
        x, y = keyframes[0]["x"], keyframes[0]["y"]
    elif frame >= keyframes[-1]["frame"]:
        x, y = keyframes[-1]["x"], keyframes[-1]["y"]
    else:
        left = keyframes[0]
        right = keyframes[-1]
        for index in range(len(keyframes) - 1):
            if keyframes[index]["frame"] <= frame <= keyframes[index + 1]["frame"]:
                left, right = keyframes[index], keyframes[index + 1]
                break
        span = max(1, right["frame"] - left["frame"])
        t = float(frame - left["frame"]) / float(span)
        x = int(round(left["x"] + (right["x"] - left["x"]) * t))
        y = int(round(left["y"] + (right["y"] - left["y"]) * t))
    return max(0, min(src_w - crop_w, x)), max(0, min(src_h - crop_h, y))


def _tensor_to_preview(frame: torch.Tensor, unique: str) -> dict[str, Any]:
    image = frame.detach().float().clamp(0.0, 1.0).cpu()
    if image.ndim == 4:
        image = image[0]
    if image.shape[-1] == 1:
        image = image.repeat(1, 1, 3)
    elif image.shape[-1] >= 4:
        image = image[..., :3]
    array = (image.numpy() * 255.0).round().astype(np.uint8)
    filename = f"visual_region_crop_{unique}_{int(time.time() * 1000)}.png"
    subfolder = "GJJ/visual_region_crop"
    out_dir = Path(folder_paths.get_temp_directory()) / subfolder
    out_dir.mkdir(parents=True, exist_ok=True)
    Image.fromarray(array).save(out_dir / filename)
    return {
        "filename": filename,
        "subfolder": subfolder,
        "type": "temp",
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
    }


class GJJ_VisualRegionCrop:
    CATEGORY = "GJJ/视频工具/裁切"
    FUNCTION = "crop"
    OUTPUT_NODE = True
    DESCRIPTION = "可视化区域裁切：节点内预览源媒体，用控制点设置最小 256 且 64 对齐的裁切框，并按关键帧插值移动裁切位置输出视频帧序列；可设置输出起止帧，尾帧按 8n+1 锁定。"
    SEARCH_ALIASES = ["visual crop", "region crop", "可视化裁切", "区域裁切", "关键帧裁切", "视频裁切"]
    RETURN_TYPES = (OUTPUT_MEDIA_TYPE, DIM_TYPE, DIM_TYPE, "INT", "STRING")
    RETURN_NAMES = ("裁切帧序列", "宽度", "高度", "帧数", "关键帧JSON")
    OUTPUT_TOOLTIPS = (
        "按输出起止帧和关键帧插值裁切后的 IMAGE 帧序列。",
        "实际输出宽度，最小 256、不会超过源宽度，并始终按 64 对齐。",
        "实际输出高度，最小 256、不会超过源高度，并始终按 64 对齐。",
        "输出帧数。",
        "本次使用的裁切关键帧 JSON。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preview_width": ("INT", {
                    "default": 360,
                    "min": 180,
                    "max": 960,
                    "step": 16,
                    "display_name": "预览宽度",
                    "tooltip": "节点内预览按此宽度等比缩放；不影响最终输出尺寸。",
                }),
                "crop_data": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "裁切关键帧 JSON",
                    "tooltip": "由前端可视化编辑器维护，包含最小 256、64 对齐的宽高和关键帧位置。",
                }),
                "selected_video": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "display_name": "已选视频",
                    "tooltip": "由节点内 📁 按钮写入的视频路径；上游媒体有连线时会优先使用上游。",
                    "widget": "hidden",
                    "hidden": True,
                    "display": "hidden",
                    "advanced": True,
                }),
                "preview_frame": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 1000000,
                    "step": 1,
                    "display_name": "预览帧",
                    "tooltip": "由前端帧滑块维护，只影响节点内源画面预览。",
                    "widget": "hidden",
                    "hidden": True,
                    "display": "hidden",
                    "advanced": True,
                }),
            },
            "optional": {
                "media": (INPUT_MEDIA_TYPE, {
                    "display_name": "图片/视频帧",
                    "tooltip": "可选。支持 GJJ_BATCH_IMAGE、普通 IMAGE batch 和官方 VIDEO；连接后优先使用上游。",
                }),
            },
            "hidden": {
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            }
        }

    @classmethod
    def IS_CHANGED(cls, media=None, preview_width: int = 360, crop_data: str = "", selected_video: str = "", preview_frame: int = 0, **kwargs):
        entry = parse_selected_video(selected_video)
        stat_sig = ""
        if media is None and entry:
            try:
                path = resolve_input_video_path(entry)
                stat = path.stat()
                stat_sig = f"{stat.st_mtime_ns}:{stat.st_size}"
            except Exception:
                stat_sig = str(selected_video or "")
        return "|".join([str(id(media)), str(preview_width), str(crop_data or ""), str(selected_video or ""), str(preview_frame or 0), stat_sig])

    def crop(
        self,
        media=None,
        preview_width: int = 360,
        crop_data: str = "",
        selected_video: str = "",
        preview_frame: int = 0,
        extra_pnginfo=None,
        unique_id=None,
    ):
        source_video = _source_video_entry(media, selected_video, extra_pnginfo, unique_id)
        frames = _media_to_frames(media, selected_video, extra_pnginfo, unique_id)
        frame_count, src_h, src_w, _channels = frames.shape
        preview_index = max(0, min(int(frame_count) - 1, _as_int(preview_frame, 0)))
        data = _safe_crop_data(crop_data)
        crop_w = _aligned_size(data.get("width"), src_w, src_w)
        crop_h = _aligned_size(data.get("height"), src_h, src_h)
        keyframes = _normalize_keyframes(data, int(frame_count), int(src_w), int(src_h), crop_w, crop_h)
        range_start, range_end = _normalize_frame_range(data, int(frame_count))

        cropped: list[torch.Tensor] = []
        for frame in range(range_start, range_end + 1):
            x, y = _interp_at(frame, keyframes, int(src_w), int(src_h), crop_w, crop_h)
            cropped.append(frames[frame : frame + 1, y : y + crop_h, x : x + crop_w, :])
        output = torch.cat(cropped, dim=0).contiguous()
        output_frame_count = int(range_end - range_start + 1)

        normalized_data = {
            "version": 1,
            "source_width": int(src_w),
            "source_height": int(src_h),
            "frame_count": int(frame_count),
            "range_start": int(range_start),
            "range_end": int(range_end),
            "output_frame_count": int(output_frame_count),
            "width": int(crop_w),
            "height": int(crop_h),
            "keyframes": keyframes,
        }
        preview_payload = {**normalized_data, "preview_frame": int(preview_index)}
        digest = hashlib.sha1(json.dumps(preview_payload, sort_keys=True).encode("utf-8")).hexdigest()[:10]
        preview = _tensor_to_preview(frames[preview_index : preview_index + 1], digest)
        json_text = json.dumps(normalized_data, ensure_ascii=False, separators=(",", ":"))
        return {
            "ui": {
                "preview_image": [preview],
                "source_width": [int(src_w)],
                "source_height": [int(src_h)],
                "frame_count": [int(frame_count)],
                "range_start": [int(range_start)],
                "range_end": [int(range_end)],
                "output_frame_count": [int(output_frame_count)],
                "preview_frame": [int(preview_index)],
                "crop_data": [json_text],
                "source_video": [source_video] if source_video else [],
            },
            "result": (output, int(crop_w), int(crop_h), int(output_frame_count), json_text),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VisualRegionCrop}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ✂️ 可视化区域裁切"}
