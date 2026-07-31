from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import re
from fractions import Fraction
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F
from PIL import Image

try:
    from aiohttp import web
except Exception:
    web = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None

import folder_paths
from .common_utils.temp_files import gjjutils_temp_path

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_VideoSmartStoryboard"
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
OUTPUT_MEDIA_TYPE = f"VIDEO,{GJJ_BATCH_IMAGE_TYPE},IMAGE"
AUDIO_INPUT_TYPE = "AUDIO,VIDEO"
UI_KEY = "gjj_video_smart_storyboard"
VIDEO_UPLOAD_API_PATH = "/gjj/video_smart_storyboard/upload"
VIDEO_META_API_PATH = "/gjj/video_smart_storyboard/meta"
VIDEO_ANALYZE_API_PATH = "/gjj/video_smart_storyboard/analyze"
UPLOAD_SUBFOLDER = "gjj_video_smart_storyboard"
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".wmv", ".flv", ".mpeg", ".mpg", ".gif"}

ANALYSIS_MAX_EDGE = 48
THUMB_MAX_EDGE = 160
MAX_CACHE_ITEMS = 4

_SCENE_CACHE: dict[str, dict[str, Any]] = {}


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


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


def _normalize_video_entry(filename: str, subfolder: str = "", media_type: str = "input") -> dict[str, str] | None:
    filename = str(filename or "").strip().replace("\\", "/")
    subfolder = str(subfolder or "").strip().replace("\\", "/").strip("/")
    if not filename:
        return None
    if "/" in filename:
        parts = [part for part in filename.split("/") if part]
        filename = parts[-1] if parts else filename
        prefix = "/".join(parts[:-1])
        subfolder = "/".join(part for part in (subfolder, prefix) if part)
    clean_parts = []
    for part in subfolder.split("/"):
        if not part or part in {".", ".."}:
            continue
        if not clean_parts or clean_parts[-1] != part:
            clean_parts.append(part)
    return {"filename": filename, "subfolder": "/".join(clean_parts), "type": str(media_type or "input")}


def _video_from_file(path: Path):
    try:
        from comfy_api.latest import InputImpl

        return InputImpl.VideoFromFile(str(path))
    except Exception:
        from comfy_api.input_impl import VideoFromFile

        return VideoFromFile(str(path))


def _as_int(value: Any, default: int = 1) -> int:
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
            return _normalize_video_entry(filename, subfolder, str(parsed.get("type") or "input"))
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
    if Path(parts[-1]).suffix.lower() not in VIDEO_EXTENSIONS:
        return None
    return _normalize_video_entry(parts[-1], "/".join(parts[:-1]))


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
    if str(entry.get("type") or "input").lower() == "temp":
        candidate = gjjutils_temp_path(str(entry.get("filename") or "")).resolve()
        if not candidate.exists():
            raise RuntimeError(f"未找到临时视频：{_display_video_entry(entry)}")
        if candidate.suffix.lower() not in VIDEO_EXTENSIONS:
            raise RuntimeError(f"不支持的视频格式：{candidate.name}")
        return candidate
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


async def upload_video_smart_storyboard_video(request):
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


async def get_video_smart_storyboard_meta(request):
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


async def analyze_video_smart_storyboard(request):
    if web is None:
        return None
    try:
        if request.method == "POST":
            payload = await request.json()
        else:
            payload = request.query
        entry = {
            "filename": payload.get("filename", ""),
            "subfolder": payload.get("subfolder", ""),
        }
        path = resolve_input_video_path(entry)
        frames, fps, source_label, _audio = _coerce_media_to_frames(_video_from_file(path))
        total_frames = int(frames.shape[0])
        if total_frames <= 0:
            raise RuntimeError("输入视频没有可用帧。")
        analysis = _analyze_scenes(frames)
        scenes = []
        fps_value = float(fps or 24.0)
        for item in list(analysis.get("scene_items") or []):
            start_frame = int(item.get("start_frame") or 1)
            end_frame = int(item.get("end_frame") or start_frame)
            scenes.append(
                {
                    **item,
                    "start_seconds": float(max(0, start_frame - 1) / max(0.01, fps_value)),
                    "end_seconds": float(max(start_frame, end_frame) / max(0.01, fps_value)),
                }
            )
        return web.json_response(
            {
                "ok": True,
                "source": source_label,
                "fps": fps_value,
                "total_frames": total_frames,
                "total_scenes": len(scenes),
                "threshold": float(analysis.get("threshold") or 0.0),
                "transition_count": int(analysis.get("transition_count") or 0),
                "trimmed_frames": int(analysis.get("trimmed_frames") or 0),
                "scenes": scenes,
            }
        )
    except Exception as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


def _register_routes() -> None:
    server = getattr(PromptServer, "instance", None) if PromptServer is not None else None
    routes = getattr(server, "routes", None)
    if server is None or routes is None or web is None:
        return
    if getattr(server, "_gjj_video_smart_storyboard_routes_registered", False):
        return
    setattr(server, "_gjj_video_smart_storyboard_routes_registered", True)
    routes.post(VIDEO_UPLOAD_API_PATH)(upload_video_smart_storyboard_video)
    routes.get(VIDEO_META_API_PATH)(get_video_smart_storyboard_meta)
    routes.get(VIDEO_ANALYZE_API_PATH)(analyze_video_smart_storyboard)
    routes.post(VIDEO_ANALYZE_API_PATH)(analyze_video_smart_storyboard)


_register_routes()


def _prompt_input_is_linked(prompt: Any, unique_id: Any, names: tuple[str, ...]) -> bool:
    if unique_id is None or not isinstance(prompt, dict):
        return False
    node_data = prompt.get(str(unique_id)) or prompt.get(unique_id)
    if not isinstance(node_data, dict):
        return False
    inputs = node_data.get("inputs")
    if not isinstance(inputs, dict):
        return False
    for name in names:
        value = inputs.get(name)
        if isinstance(value, (list, tuple)) and len(value) >= 2:
            return True
    return False


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
        pieces: list[torch.Tensor] = []
        for item in value:
            normalized = _normalize_frames_tensor(item, source_label)
            if normalized is not None:
                pieces.append(normalized)
        if not pieces:
            return None
        try:
            tensor = torch.cat(pieces, dim=0)
        except Exception as error:
            raise RuntimeError(f"{source_label} 的帧尺寸不一致，无法作为视频分镜处理：{error}") from error
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


def _slice_audio_window(audio: Any, start_seconds: float, duration_seconds: float) -> Any | None:
    waveform = audio.get("waveform") if isinstance(audio, dict) else _component_value(audio, "waveform")
    sample_rate = int((audio.get("sample_rate") if isinstance(audio, dict) else _component_value(audio, "sample_rate")) or 0)
    if not isinstance(waveform, torch.Tensor) or sample_rate <= 0:
        return audio
    start_sample = max(0, int(round(float(start_seconds) * sample_rate)))
    count = max(1, int(round(float(duration_seconds) * sample_rate)))
    end_sample = min(int(waveform.shape[-1]), start_sample + count)
    if end_sample <= start_sample:
        channels = int(waveform.shape[-2]) if waveform.ndim >= 2 else 2
        empty = torch.zeros((1, channels, max(1, count)), dtype=torch.float32)
        return {"waveform": empty, "sample_rate": sample_rate}
    return {"waveform": waveform[..., start_sample:end_sample].contiguous(), "sample_rate": sample_rate}


def _audio_has_waveform(audio: Any) -> bool:
    waveform = audio.get("waveform") if isinstance(audio, dict) else _component_value(audio, "waveform")
    sample_rate = int((audio.get("sample_rate") if isinstance(audio, dict) else _component_value(audio, "sample_rate")) or 0)
    return isinstance(waveform, torch.Tensor) and sample_rate > 0 and int(waveform.numel()) > 0


def _coerce_audio_input(value: Any) -> Any | None:
    if value is None:
        return None
    if _audio_has_waveform(value):
        return value
    if isinstance(value, dict):
        nested = value.get("audio")
        if _audio_has_waveform(nested):
            return nested
    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception as error:
            raise RuntimeError(f"输入音频 VIDEO 读取失败：{error}") from error
        nested = _component_value(components, "audio")
        if _audio_has_waveform(nested):
            return nested
    return None


def _create_video_output(frames: torch.Tensor, fps: float, audio: Any | None = None):
    safe_frames = frames.detach().float().clamp(0.0, 1.0)
    if safe_frames.ndim != 4 or int(safe_frames.shape[0]) <= 0:
        raise RuntimeError("分镜 VIDEO 输出失败：没有可用的视频帧。")
    if int(safe_frames.shape[-1]) == 1:
        safe_frames = safe_frames.repeat(1, 1, 1, 3)
    elif int(safe_frames.shape[-1]) >= 4:
        safe_frames = safe_frames[..., :3]
    try:
        from comfy_api.latest import InputImpl, Types
    except Exception as exc:
        raise RuntimeError(f"分镜 VIDEO 输出失败：当前 ComfyUI 缺少官方 VIDEO 接口：{exc}") from exc
    frame_rate = Fraction(float(max(0.01, fps or 24.0))).limit_denominator(1000)
    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=safe_frames.contiguous(),
            audio=audio,
            frame_rate=frame_rate,
        )
    )


def _normalize_type_tokens(value: Any) -> set[str]:
    if isinstance(value, (list, tuple)):
        if not value:
            return set()
        value = value[0]
    return {item.strip().upper() for item in str(value or "").replace("|", ",").split(",") if item.strip()}


def _declared_input_type(class_type: str, input_name: str) -> Any:
    if not class_type or not input_name:
        return None
    try:
        import nodes as comfy_nodes

        node_cls = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}).get(class_type)
    except Exception:
        node_cls = None
    if node_cls is None:
        return None
    try:
        input_types = node_cls.INPUT_TYPES()
    except Exception:
        return None
    if not isinstance(input_types, dict):
        return None
    for section in ("required", "optional"):
        inputs = input_types.get(section)
        if isinstance(inputs, dict) and input_name in inputs:
            value = inputs.get(input_name)
            if isinstance(value, (list, tuple)) and value:
                return value[0]
            return value
    return None


def _type_prefers_video(type_value: Any) -> bool:
    tokens = _normalize_type_tokens(type_value)
    if "VIDEO" not in tokens:
        return False
    return "IMAGE" not in tokens and "GJJ_BATCH_IMAGE" not in tokens


def _workflow_node_by_id(extra_pnginfo: Any) -> dict[str, dict[str, Any]]:
    workflow = extra_pnginfo.get("workflow") if isinstance(extra_pnginfo, dict) else None
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    if not isinstance(nodes, list):
        return {}
    return {str(node.get("id")): node for node in nodes if isinstance(node, dict)}


def _workflow_downstream_prefers_video(extra_pnginfo: Any, unique_id: Any, output_slot: int = 0) -> bool:
    workflow = extra_pnginfo.get("workflow") if isinstance(extra_pnginfo, dict) else None
    links = workflow.get("links") if isinstance(workflow, dict) else None
    if not isinstance(links, list):
        return False
    node_by_id = _workflow_node_by_id(extra_pnginfo)
    source_id = str(unique_id)
    for link in links:
        if not isinstance(link, (list, tuple)) or len(link) < 5:
            continue
        if str(link[1]) != source_id or int(link[2] or 0) != int(output_slot):
            continue
        target = node_by_id.get(str(link[3]))
        inputs = target.get("inputs") if isinstance(target, dict) else None
        if not isinstance(inputs, list):
            continue
        target_slot = int(link[4] or 0)
        if target_slot < 0 or target_slot >= len(inputs):
            continue
        input_info = inputs[target_slot]
        if isinstance(input_info, dict) and _type_prefers_video(input_info.get("type")):
            return True
    return False


def _downstream_prefers_video(prompt: Any, unique_id: Any, extra_pnginfo: Any, output_slot: int = 0) -> bool:
    if unique_id is None:
        return False
    source_id = str(unique_id)
    if isinstance(prompt, dict):
        for node_data in prompt.values():
            if not isinstance(node_data, dict):
                continue
            inputs = node_data.get("inputs")
            if not isinstance(inputs, dict):
                continue
            for input_name, value in inputs.items():
                if not isinstance(value, (list, tuple)) or len(value) < 2:
                    continue
                if str(value[0]) != source_id or int(value[1] or 0) != int(output_slot):
                    continue
                declared = _declared_input_type(str(node_data.get("class_type") or ""), str(input_name))
                if _type_prefers_video(declared):
                    return True
    return _workflow_downstream_prefers_video(extra_pnginfo, unique_id, output_slot)


def _coerce_media_to_frames(value: Any) -> tuple[torch.Tensor, float, str, Any | None]:
    direct = _normalize_frames_tensor(value, "输入视频/帧队列")
    if direct is not None:
        fps = 0.0
        audio = None
        if isinstance(value, dict):
            for key in ("frame_rate", "fps", "source_fps"):
                if key in value:
                    fps = _as_float(value.get(key), 0.0)
                    break
            audio = value.get("audio")
        return direct, fps, "输入帧队列", audio

    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception as error:
            raise RuntimeError(f"输入 VIDEO 读取失败：{error}") from error
        frames = _normalize_frames_tensor(_component_value(components, "images"), "输入 VIDEO")
        if frames is None:
            raise RuntimeError("输入 VIDEO 没有解析出可用视频帧。")
        fps = _as_float(_component_value(components, "frame_rate"), 0.0)
        audio = _component_value(components, "audio")
        if fps <= 0 and callable(getattr(value, "get_frame_rate", None)):
            try:
                fps = _as_float(value.get_frame_rate(), 0.0)
            except Exception:
                pass
        source = "输入 VIDEO"
        if callable(getattr(value, "get_stream_source", None)):
            try:
                stream_source = value.get_stream_source()
                if stream_source:
                    source = str(stream_source).split("\\")[-1].split("/")[-1] or source
            except Exception:
                pass
        return frames, fps, source, audio

    images = getattr(value, "images", None)
    frames = _normalize_frames_tensor(images, "输入媒体")
    if frames is not None:
        return frames, _as_float(getattr(value, "frame_rate", 0.0), 0.0), "输入媒体", getattr(value, "audio", None)

    raise RuntimeError(f"输入不是有效的 GJJ_BATCH_IMAGE / IMAGE / VIDEO：{type(value).__name__}。")


def _rgb_for_analysis(frames: torch.Tensor) -> torch.Tensor:
    rgb = frames.detach().float().clamp(0.0, 1.0)
    channels = int(rgb.shape[-1])
    if channels == 1:
        rgb = rgb.repeat(1, 1, 1, 3)
    elif channels >= 4:
        alpha = rgb[..., 3:4].clamp(0.0, 1.0)
        rgb = rgb[..., :3] * alpha
    else:
        rgb = rgb[..., :3]
    return rgb.cpu().contiguous()


def _resize_for_analysis(frames: torch.Tensor) -> torch.Tensor:
    rgb = _rgb_for_analysis(frames)
    height = int(rgb.shape[1])
    width = int(rgb.shape[2])
    max_edge = max(height, width)
    if max_edge <= ANALYSIS_MAX_EDGE:
        return rgb.contiguous()
    scale = float(ANALYSIS_MAX_EDGE) / float(max_edge)
    target_h = max(1, int(round(height * scale)))
    target_w = max(1, int(round(width * scale)))
    resized = F.interpolate(
        rgb.permute(0, 3, 1, 2),
        size=(target_h, target_w),
        mode="bilinear",
        align_corners=False,
    )
    return resized.permute(0, 2, 3, 1).contiguous()


def _analysis_signature(small: torch.Tensor, frames: torch.Tensor) -> str:
    hasher = hashlib.sha1()
    hasher.update(str(tuple(int(v) for v in frames.shape)).encode("ascii"))
    hasher.update(str(tuple(int(v) for v in small.shape)).encode("ascii"))
    quantized = torch.round(small.clamp(0.0, 1.0) * 255.0).to(torch.uint8).contiguous()
    hasher.update(quantized.numpy().tobytes())
    return hasher.hexdigest()


def _score_boundaries(small: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    flat = small.reshape(int(small.shape[0]), -1)
    if int(small.shape[0]) <= 1:
        return flat, torch.empty((0,), dtype=torch.float32)
    pixel_diff = (small[1:] - small[:-1]).abs().mean(dim=(1, 2, 3))
    color_diff = (small[1:].mean(dim=(1, 2)) - small[:-1].mean(dim=(1, 2))).abs().mean(dim=1)
    scores = pixel_diff * 0.85 + color_diff * 0.15
    return flat.contiguous(), scores.float().contiguous()


def _score_stats(scores: torch.Tensor) -> dict[str, float]:
    if scores.numel() <= 0:
        return {"median": 0.0, "mad": 0.0, "p75": 0.0, "p90": 0.0, "threshold": 1.0}
    sorted_scores = scores.sort().values
    median = float(torch.quantile(sorted_scores, 0.50).item())
    mad = float(torch.median((scores - median).abs()).item())
    p75 = float(torch.quantile(sorted_scores, 0.75).item())
    p90 = float(torch.quantile(sorted_scores, 0.90).item())
    threshold = max(median + max(0.018, mad * 4.0), p75 * 1.8, p90 * 1.08, 0.065)
    return {"median": median, "mad": mad, "p75": p75, "p90": p90, "threshold": threshold}


def _feature_distance(flat: torch.Tensor, left: int, right: int) -> float:
    if left == right:
        return 0.0
    left = max(0, min(int(left), int(flat.shape[0]) - 1))
    right = max(0, min(int(right), int(flat.shape[0]) - 1))
    return float((flat[left] - flat[right]).abs().mean().item())


def _binary_first_right_scene(flat: torch.Tensor, left_anchor: int, right_anchor: int) -> int:
    lo = max(0, min(int(left_anchor) + 1, int(flat.shape[0]) - 1))
    hi = max(lo, min(int(right_anchor), int(flat.shape[0]) - 1))
    while lo < hi:
        mid = (lo + hi) // 2
        dist_left = _feature_distance(flat, mid, left_anchor)
        dist_right = _feature_distance(flat, mid, right_anchor)
        if dist_right <= dist_left:
            hi = mid
        else:
            lo = mid + 1
    return lo


def _group_transition_runs(scores: torch.Tensor, threshold: float) -> list[tuple[int, int]]:
    if scores.numel() <= 0:
        return []
    values = [float(item) for item in scores.tolist()]
    groups: list[tuple[int, int]] = []
    index = 0
    while index < len(values):
        if values[index] < threshold:
            index += 1
            continue
        start = index
        end = index
        while end + 1 < len(values) and values[end + 1] >= threshold:
            end += 1
        soft = threshold * 0.58
        while start > 0 and values[start - 1] >= soft:
            start -= 1
        while end + 1 < len(values) and values[end + 1] >= soft:
            end += 1
        if not groups or start > groups[-1][1] + 1:
            groups.append((start, end))
        else:
            groups[-1] = (groups[-1][0], max(groups[-1][1], end))
        index = end + 1
    return groups


def _refine_transition(
    flat: torch.Tensor,
    run: tuple[int, int],
    stats: dict[str, float],
) -> dict[str, int]:
    frame_count = int(flat.shape[0])
    start_score, end_score = run
    context = max(2, min(18, int(round(frame_count * 0.025))))
    left_anchor = max(0, start_score - context)
    right_anchor = min(frame_count - 1, end_score + 1 + context)
    split = _binary_first_right_scene(flat, left_anchor, right_anchor)
    split = max(start_score + 1, min(split, end_score + 1))

    clean_limit = max(
        float(stats.get("median", 0.0)) + float(stats.get("mad", 0.0)) * 2.5,
        float(stats.get("threshold", 0.065)) * 0.55,
        0.045,
    )
    left_end = split
    while left_end > start_score + 1 and _feature_distance(flat, left_end - 1, left_anchor) > clean_limit:
        left_end -= 1
    right_start = split
    while right_start < end_score + 1 and _feature_distance(flat, right_start, right_anchor) > clean_limit:
        right_start += 1

    left_end = max(1, min(left_end, frame_count))
    right_start = max(left_end, min(right_start, frame_count - 1))
    return {
        "score_start": int(start_score),
        "score_end": int(end_score),
        "left_end": int(left_end),
        "right_start": int(right_start),
        "split": int(split),
        "left_anchor": int(left_anchor),
        "right_anchor": int(right_anchor),
    }


def _build_segments(frame_count: int, transitions: list[dict[str, int]]) -> list[tuple[int, int]]:
    if frame_count <= 0:
        return [(0, 1)]
    min_scene_frames = max(2, min(16, int(round(frame_count * 0.015))))
    segments: list[tuple[int, int]] = []
    cursor = 0
    for transition in sorted(transitions, key=lambda item: item["left_end"]):
        left_end = max(cursor + 1, min(int(transition["left_end"]), frame_count))
        right_start = max(left_end, min(int(transition["right_start"]), frame_count - 1))
        if left_end - cursor < min_scene_frames:
            continue
        if frame_count - right_start < min_scene_frames:
            continue
        segments.append((cursor, left_end))
        cursor = right_start
    if frame_count - cursor >= 1:
        segments.append((cursor, frame_count))
    if not segments:
        segments = [(0, frame_count)]
    return [(max(0, start), max(start + 1, min(end, frame_count))) for start, end in segments]


def _frame_to_data_url(frame: torch.Tensor, max_edge: int = THUMB_MAX_EDGE) -> str:
    preview = frame.detach().float().clamp(0.0, 1.0).cpu()
    if preview.ndim == 4:
        preview = preview[0]
    if preview.ndim != 3:
        return ""
    if int(preview.shape[-1]) == 1:
        preview = preview.repeat(1, 1, 3)
    elif int(preview.shape[-1]) >= 4:
        alpha = preview[..., 3:4].clamp(0.0, 1.0)
        preview = preview[..., :3] * alpha
    else:
        preview = preview[..., :3]

    height = int(preview.shape[0])
    width = int(preview.shape[1])
    scale = min(1.0, float(max_edge) / float(max(height, width, 1)))
    if scale < 1.0:
        target_h = max(1, int(round(height * scale)))
        target_w = max(1, int(round(width * scale)))
        preview = F.interpolate(
            preview.permute(2, 0, 1).unsqueeze(0),
            size=(target_h, target_w),
            mode="bilinear",
            align_corners=False,
        )[0].permute(1, 2, 0)
    array = torch.round(preview * 255.0).to(torch.uint8).numpy()
    image = Image.fromarray(array[..., :3], mode="RGB")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=76, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _make_scene_items(frames: torch.Tensor, segments: list[tuple[int, int]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for index, (start, end) in enumerate(segments, start=1):
        thumb = ""
        try:
            thumb = _frame_to_data_url(frames[start])
        except Exception:
            thumb = ""
        items.append(
            {
                "index": index,
                "start_frame": int(start + 1),
                "end_frame": int(end),
                "length": int(end - start),
                "thumb": thumb,
            }
        )
    return items


def _cache_get(key: str) -> dict[str, Any] | None:
    item = _SCENE_CACHE.get(key)
    if item is None:
        return None
    _SCENE_CACHE.pop(key, None)
    _SCENE_CACHE[key] = item
    return item


def _cache_set(key: str, value: dict[str, Any]) -> dict[str, Any]:
    _SCENE_CACHE[key] = value
    while len(_SCENE_CACHE) > MAX_CACHE_ITEMS:
        _SCENE_CACHE.pop(next(iter(_SCENE_CACHE)))
    return value


def _analyze_scenes(frames: torch.Tensor) -> dict[str, Any]:
    frame_count = int(frames.shape[0])
    if frame_count <= 1:
        segments = [(0, max(1, frame_count))]
        return {
            "segments": segments,
            "scene_items": _make_scene_items(frames, segments),
            "threshold": 1.0,
            "transition_count": 0,
            "trimmed_frames": 0,
            "cache_key": "",
        }

    small = _resize_for_analysis(frames)
    cache_key = _analysis_signature(small, frames)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    flat, scores = _score_boundaries(small)
    stats = _score_stats(scores)
    runs = _group_transition_runs(scores, float(stats["threshold"]))
    transitions = [_refine_transition(flat, run, stats) for run in runs]
    segments = _build_segments(frame_count, transitions)
    covered = sum(max(0, end - start) for start, end in segments)
    result = {
        "segments": segments,
        "scene_items": _make_scene_items(frames, segments),
        "threshold": float(stats["threshold"]),
        "transition_count": int(len(transitions)),
        "trimmed_frames": int(max(0, frame_count - covered)),
        "cache_key": cache_key,
    }
    return _cache_set(cache_key, result)


class GJJ_VideoSmartStoryboard:
    CATEGORY = "GJJ/🎬 视频"
    FUNCTION = "split_storyboard"
    DESCRIPTION = "单视频智能分镜：输入 GJJ_BATCH_IMAGE / IMAGE / VIDEO，自动识别镜头边界，用二分法细化切点，输出当前分镜帧和分镜序号。"
    SEARCH_ALIASES = ["智能分镜", "视频分镜", "镜头切分", "storyboard", "scene cut", "shot split"]
    OUTPUT_NODE = True
    RETURN_TYPES = (OUTPUT_MEDIA_TYPE, "INT", "INT")
    RETURN_NAMES = ("当前分镜", "当前分镜序号", "总分镜数")
    OUTPUT_TOOLTIPS = (
        "当前分镜优先输出官方 VIDEO，并携带当段源音频；无法创建 VIDEO 时回退为帧序列。",
        "当前实际输出的 1 基分镜序号。",
        "自动检测到的总分镜数。",
    )

    GJJ_HELP = {
        "title": "视频智能分镜",
        "description": DESCRIPTION,
        "usage": [
            "优先连接 GJJ_BATCH_IMAGE、IMAGE 批次或官方 VIDEO；没有外接输入时，点击节点内 📁 打开视频。",
            "点击节点内 🔄 可只执行当前节点并生成/刷新分镜首帧预览。",
            "在“输出分镜”输入要输出的分镜序号，或连接外部 INT 控制。",
            "可选连接 AUDIO/VIDEO 到“音频”输入；执行时会按当前分镜范围自动裁切并封入输出 VIDEO。",
            "执行后优先输出带当段源音频的 VIDEO，节点内会显示每个分镜首帧；点击首帧会更新“输出分镜”。",
            "未连接外部“输出分镜”时，可用“自动队列”从当前分镜连续排队到最后一段。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "output_scene": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 1000000,
                        "step": 1,
                        "display_name": "输出分镜",
                        "tooltip": "要输出的 1 基分镜序号；可在面板输入，也可外接 INT 控制。",
                    },
                ),
                "selected_video": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "已选视频",
                        "tooltip": "由节点内 📁 按钮写入的视频路径；有外接输入时会优先使用外接输入。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
            },
            "optional": {
                "media": (
                    MEDIA_INPUT_TYPE,
                    {
                        "display_name": "输入视频/帧队列",
                        "tooltip": "可选。支持 GJJ_BATCH_IMAGE、普通 IMAGE batch 和官方 VIDEO；连接后优先使用外接输入。",
                    },
                ),
                "audio": (
                    AUDIO_INPUT_TYPE,
                    {
                        "display_name": "音频",
                        "tooltip": "可选。可连接 AUDIO 或 VIDEO；连接后按当前分镜范围裁切并封入输出 VIDEO。",
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
    def IS_CHANGED(cls, *args, **kwargs):
        return float("NaN")

    def split_storyboard(
        self,
        output_scene: int = 1,
        selected_video: str = "",
        media=None,
        audio=None,
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        using_external = media is not None
        if using_external:
            frames, fps, source_label, source_audio = _coerce_media_to_frames(media)
        else:
            entry = recover_selected_video(selected_video, extra_pnginfo, unique_id)
            if not entry:
                raise RuntimeError("请先连接外接 GJJ_BATCH_IMAGE / IMAGE / VIDEO，或点击节点内 📁 打开一个视频。")
            path = resolve_input_video_path(entry)
            frames, fps, source_label, source_audio = _coerce_media_to_frames(_video_from_file(path))
            source_label = path.name
        total_frames = int(frames.shape[0])
        if total_frames <= 0:
            raise RuntimeError("输入视频或帧队列没有可用帧。")

        analysis = _analyze_scenes(frames)
        segments: list[tuple[int, int]] = list(analysis.get("segments") or [(0, total_frames)])
        total_scenes = max(1, len(segments))
        requested = max(1, _as_int(output_scene, 1))
        current = min(requested, total_scenes)
        start, end = segments[current - 1]
        start = max(0, min(int(start), total_frames - 1))
        end = max(start + 1, min(int(end), total_frames))
        segment = frames[start:end].contiguous()
        downstream_prefers_video = _downstream_prefers_video(prompt, unique_id, extra_pnginfo, 0)
        fps_value = float(fps or 24.0)
        input_audio = _coerce_audio_input(audio)
        if input_audio is not None:
            source_audio = input_audio
        audio = _slice_audio_window(source_audio, float(start) / max(0.01, fps_value), float(end - start) / max(0.01, fps_value))
        has_audio = _audio_has_waveform(audio)
        output_as_video = False
        video_fallback_reason = ""
        try:
            media_output = _create_video_output(segment, fps_value, audio)
            output_as_video = True
        except Exception as exc:
            if downstream_prefers_video:
                raise
            media_output = segment
            video_fallback_reason = str(exc)

        external_controlled = _prompt_input_is_linked(prompt, unique_id, ("output_scene",))
        range_text = f"源帧 {start + 1}-{end} / {total_frames}"
        status = f"第 {current} / {total_scenes} 个分镜，输出 {int(segment.shape[0])} 帧"
        if output_as_video:
            status += "，VIDEO"
            if has_audio:
                status += "+当段源音频"
        elif video_fallback_reason:
            status += "，VIDEO 不可用，已回退帧批次"
        trimmed = int(analysis.get("trimmed_frames") or 0)
        if trimmed > 0:
            status += f"，已剔除 {trimmed} 帧过渡画面"

        return {
            "ui": {
                UI_KEY: [
                    {
                        "source": source_label,
                        "using_external": bool(using_external),
                        "fps": float(fps or 0.0),
                        "total_frames": int(total_frames),
                        "total_scenes": int(total_scenes),
                        "current_scene": int(current),
                        "requested_scene": int(requested),
                        "output_frames": int(segment.shape[0]),
                        "output_as_video": bool(output_as_video),
                        "has_audio": has_audio,
                        "video_fallback_reason": video_fallback_reason,
                        "range_text": range_text,
                        "status": status,
                        "external_controlled": bool(external_controlled),
                        "threshold": float(analysis.get("threshold") or 0.0),
                        "transition_count": int(analysis.get("transition_count") or 0),
                        "trimmed_frames": trimmed,
                        "scenes": list(analysis.get("scene_items") or []),
                    }
                ]
            },
            "result": (media_output, int(current), int(total_scenes)),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoSmartStoryboard}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 视频智能分镜"}
