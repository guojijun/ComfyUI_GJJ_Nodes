from __future__ import annotations

import json
import re
import subprocess
import uuid
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from aiohttp import web
from PIL import Image
try:
    from server import PromptServer
except Exception:
    PromptServer = None

import folder_paths
from .common_utils.temp_files import gjjutils_temp_path, gjjutils_write_temp_file

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_MultiVideoLoader"
VIDEO_FRAME_QUEUE_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE,VIDEO"
FIRST_LAST_FRAME_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
VIDEO_API_PATH = "/gjj/input_videos"
VIDEO_UPLOAD_API_PATH = "/gjj/upload_video"
VIDEO_META_API_PATH = "/gjj/video_meta"
UPLOAD_SUBFOLDER = "gjj_multi_video_loader"
MAX_SELECTED_VIDEOS = 20
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".wmv", ".flv", ".gif"}
ENABLED_OUTPUTS_PROPERTY = "enabled_outputs"
SELECTED_VIDEOS_PROPERTY = "selected_videos"
PREVIEW_MAX_FRAMES = 96
PREVIEW_MAX_EDGE = 250
OPTIONAL_OUTPUT_DEFS = {
    "first_frame": {"name": "首帧预览", "type": "IMAGE"},
    "last_frame": {"name": "尾帧预览", "type": "IMAGE"},
    "info_json": {"name": "视频信息JSON", "type": "STRING"},
    "frame_rate": {"name": "帧率", "type": "INT,FLOAT"},
    "frame_count": {"name": "输出帧数", "type": "INT"},
    "source_duration": {"name": "源时长", "type": "FLOAT"},
    "width": {"name": "宽度", "type": "INT"},
    "height": {"name": "高度", "type": "INT"},
    "video_format": {"name": "视频格式", "type": "STRING"},
    "audio": {"name": "音频", "type": "AUDIO"},
    "first_last_frames": {"name": "首尾帧", "type": FIRST_LAST_FRAME_TYPE},
    "processed_video": {"name": "处理后视频", "type": "VIDEO"},
}
OPTIONAL_OUTPUT_KEYS = list(OPTIONAL_OUTPUT_DEFS.keys())


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


# 与 VHS_VideoCombine 的常用格式保持相近命名；这里只作为格式参数输出，真正合成仍交给后续视频合成节点。
VIDEO_FORMATS = [
    "image/gif",
    "image/webp",
    "video/h264-mp4",
    "video/h265-mp4",
    "video/webm",
    "video/av1-webm",
]


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


def _save_sequence_webp_preview(frames: torch.Tensor, fps: float = 8.0) -> list[dict[str, Any]]:
    try:
        frames = frames.detach().cpu().float().clamp(0.0, 1.0).contiguous()
        if int(frames.shape[0]) <= 0:
            return []
        original_count = int(frames.shape[0])
        if original_count > PREVIEW_MAX_FRAMES:
            indices = torch.linspace(0, original_count - 1, steps=PREVIEW_MAX_FRAMES).round().to(torch.long)
            frames = frames.index_select(0, indices).contiguous()
        height = int(frames.shape[1])
        width = int(frames.shape[2])
        max_edge = max(width, height)
        if max_edge > PREVIEW_MAX_EDGE:
            scale = PREVIEW_MAX_EDGE / float(max_edge)
            preview_width = max(1, int(round(width * scale)))
            preview_height = max(1, int(round(height * scale)))
            frames = _resize_image_tensor(frames, preview_width, preview_height)
        target_dir = Path(folder_paths.get_temp_directory()) / "GJJ" / "multi_video_preview"
        target_dir.mkdir(parents=True, exist_ok=True)
        filename = f"GJJ_MultiVideoLoader_{uuid.uuid4().hex[:12]}.webp"
        filepath = target_dir / filename
        arrays = torch.round(frames * 255.0).to(torch.uint8).numpy()
        pil_frames = [Image.fromarray(array[..., :3], mode="RGB") for array in arrays]
        pil_frames[0].save(
            filepath,
            format="WEBP",
            save_all=True,
            append_images=pil_frames[1:],
            duration=max(1, round(1000.0 / max(0.01, float(fps)))),
            loop=0,
            lossless=False,
            quality=72,
            method=1,
        )
        return [{
            "filename": filename,
            "subfolder": "GJJ/multi_video_preview",
            "type": "temp",
            "format": "image/webp",
            "media_type": "image",
            "is_sequence": True,
            "autoplay": True,
            "loop": True,
            "frame_rate": float(fps),
            "frame_count": original_count,
            "preview_frame_count": int(frames.shape[0]),
            "width": int(frames.shape[2]),
            "height": int(frames.shape[1]),
        }]
    except Exception as error:
        print(f"[GJJ_MultiVideoLoader] WebP 预览保存失败: {error}")
        return []


def _video_meta_cv2(path: Path) -> dict[str, Any]:
    try:
        import av
    except Exception:
        return {"width": 0, "height": 0, "fps": 0.0, "frames": 0, "duration": 0.0}

    try:
        container = av.open(str(path))
    except Exception:
        return {"width": 0, "height": 0, "fps": 0.0, "frames": 0, "duration": 0.0}

    try:
        video_stream = None
        for stream in container.streams:
            if stream.type == "video":
                video_stream = stream
                break

        if video_stream is None:
            return {"width": 0, "height": 0, "fps": 0.0, "frames": 0, "duration": 0.0}

        width = video_stream.width or 0
        height = video_stream.height or 0
        fps = float(video_stream.average_rate) if video_stream.average_rate else 0.0
        frames = int(video_stream.frames) if video_stream.frames and video_stream.frames > 0 else 0
        
        if frames <= 0 and fps > 0 and video_stream.duration and video_stream.time_base:
            raw_duration = float(video_stream.duration * video_stream.time_base)
            frames = int(round(raw_duration * fps))
        
        duration = float(frames / fps) if fps > 0 and frames > 0 else 0.0
        
        if container.duration is not None:
            duration = float(container.duration / av.time_base)
        
    finally:
        container.close()

    return {"width": width, "height": height, "fps": fps, "frames": frames, "duration": duration}



def _video_meta_ffprobe(path: Path) -> dict[str, Any]:
    """Use ffprobe as a fallback/stronger parser when cv2 cannot read metadata."""
    try:
        import imageio_ffmpeg
        ffprobe = str(Path(imageio_ffmpeg.get_ffmpeg_exe()).with_name("ffprobe.exe" if Path(imageio_ffmpeg.get_ffmpeg_exe()).suffix.lower() == ".exe" else "ffprobe"))
        if not Path(ffprobe).exists():
            ffprobe = "ffprobe"
    except Exception:
        ffprobe = "ffprobe"

    cmd = [
        ffprobe,
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration",
        "-of", "json",
        str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=8)
        if proc.returncode != 0:
            return {"width": 0, "height": 0, "fps": 0.0, "frames": 0, "duration": 0.0}
        payload = json.loads(proc.stdout or "{}")
        streams = payload.get("streams") or []
        stream = streams[0] if streams else {}
    except Exception:
        return {"width": 0, "height": 0, "fps": 0.0, "frames": 0, "duration": 0.0}

    def _ratio_to_float(value: Any) -> float:
        text = str(value or "").strip()
        if "/" in text:
            a, b = text.split("/", 1)
            try:
                return float(a) / max(1e-9, float(b))
            except Exception:
                return 0.0
        try:
            return float(text)
        except Exception:
            return 0.0

    width = int(float(stream.get("width") or 0))
    height = int(float(stream.get("height") or 0))
    fps = _ratio_to_float(stream.get("avg_frame_rate")) or _ratio_to_float(stream.get("r_frame_rate"))
    duration = float(stream.get("duration") or 0.0)
    frames = int(float(stream.get("nb_frames") or 0))
    if frames <= 0 and fps > 0 and duration > 0:
        frames = int(round(fps * duration))
    return {"width": width, "height": height, "fps": fps, "frames": frames, "duration": duration}


def video_meta(path: Path) -> dict[str, Any]:
    cv2_meta = _video_meta_cv2(path)
    if int(cv2_meta.get("width") or 0) > 0 and int(cv2_meta.get("height") or 0) > 0 and float(cv2_meta.get("fps") or 0) > 0:
        return cv2_meta
    probe_meta = _video_meta_ffprobe(path)
    merged = dict(cv2_meta)
    for key, value in probe_meta.items():
        if not merged.get(key):
            merged[key] = value
    return merged

def list_input_videos() -> list[dict[str, Any]]:
    input_dir = _input_dir()
    items: list[dict[str, Any]] = []
    if not input_dir.exists():
        return items

    for file_path in sorted(input_dir.rglob("*")):
        if not file_path.is_file() or file_path.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        relative = file_path.relative_to(input_dir)
        subfolder = str(relative.parent).replace("\\", "/")
        if subfolder == ".":
            subfolder = ""
        meta = video_meta(file_path)
        items.append(
            {
                "filename": file_path.name,
                "subfolder": subfolder,
                "label": f"{subfolder}/{file_path.name}" if subfolder else file_path.name,
                "type": "input",
                **meta,
            }
        )
    return items


async def get_gjj_input_videos(request):
    return web.json_response({"videos": list_input_videos(), "formats": VIDEO_FORMATS})


async def get_gjj_video_meta(request):
    try:
        entry = {
            "filename": request.query.get("filename", ""),
            "subfolder": request.query.get("subfolder", ""),
            "type": request.query.get("type", "") or "input",
        }
        path = resolve_input_video_path(entry)
        meta = video_meta(path)
        return web.json_response({
            "filename": path.name,
            "subfolder": entry.get("subfolder", ""),
            "label": f"{entry.get('subfolder', '')}/{path.name}" if entry.get("subfolder") else path.name,
            "type": entry.get("type") or "input",
            **meta,
        })
    except Exception as error:
        return web.json_response({"error": str(error)}, status=400)


async def upload_gjj_input_video(request):
    reader = await request.multipart()
    saved: list[dict[str, str]] = []

    while True:
        field = await reader.next()
        if field is None:
            break
        if field.name not in {"video", "file"}:
            continue

        filename = _safe_filename(field.filename or "video.mp4")
        if Path(filename).suffix.lower() not in VIDEO_EXTENSIONS:
            return web.json_response({"error": f"不支持的视频格式：{filename}"}, status=400)

        target = _unique_path(gjjutils_temp_path("upload.tmp").parent, filename)
        with target.open("wb") as handle:
            while True:
                chunk = await field.read_chunk()
                if not chunk:
                    break
                handle.write(chunk)
        info = gjjutils_write_temp_file(target, suffix=target.suffix)
        try:
            target.unlink(missing_ok=True)
        except Exception:
            pass
        saved.append({"filename": info["filename"], "subfolder": info["subfolder"], "type": "temp"})

    if not saved:
        return web.json_response({"error": "没有收到视频文件。"}, status=400)
    return web.json_response({"videos": saved})


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.get(VIDEO_API_PATH)(get_gjj_input_videos)
    PromptServer.instance.routes.get(VIDEO_META_API_PATH)(get_gjj_video_meta)
    PromptServer.instance.routes.post(VIDEO_UPLOAD_API_PATH)(upload_gjj_input_video)


def parse_selected_videos(raw_value: Any) -> list[dict[str, str]]:
    if raw_value is None:
        return []
    text = str(raw_value).strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []

    cleaned: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in parsed:
        if not isinstance(item, dict):
            continue
        filename = str(item.get("filename") or "").strip()
        subfolder = str(item.get("subfolder") or "").strip().replace("\\", "/")
        if not filename:
            continue
        key = (subfolder, filename)
        if key in seen:
            continue
        seen.add(key)
        media_type = str(item.get("type") or "input").strip() or "input"
        cleaned.append({"filename": filename, "subfolder": subfolder, "type": media_type})
    return cleaned[:MAX_SELECTED_VIDEOS]


def recover_selected_videos(raw_value: Any, extra_pnginfo: Any = None, unique_id: Any = None) -> list[dict[str, str]]:
    selected = parse_selected_videos(raw_value)
    if selected:
        return selected
    if not isinstance(extra_pnginfo, dict):
        return []
    workflow = extra_pnginfo.get("workflow")
    if not isinstance(workflow, dict):
        return []
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return []

    candidates: list[list[dict[str, str]]] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != NODE_NAME:
            continue
        if unique_id is not None and str(node.get("id")) != str(unique_id):
            continue
        properties = node.get("properties")
        if isinstance(properties, dict):
            from_property = parse_selected_videos(properties.get(SELECTED_VIDEOS_PROPERTY))
            if from_property:
                candidates.append(from_property)
                continue
            from_widget_property = parse_selected_videos(properties.get("selected_videos_json"))
            if from_widget_property:
                candidates.append(from_widget_property)
                continue
        widget_values = node.get("widgets_values")
        if isinstance(widget_values, list):
            for value in widget_values:
                from_widget = parse_selected_videos(value)
                if from_widget:
                    candidates.append(from_widget)
                    break
    if unique_id is not None and candidates:
        return candidates[0]
    return candidates[0] if len(candidates) == 1 else []


def _is_prompt_link(value: Any) -> bool:
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return True
    if isinstance(value, dict):
        return any(key in value for key in ("node_id", "node", "slot", "output", "link"))
    return False


def _prompt_node(prompt: Any, unique_id: Any) -> dict[str, Any] | None:
    if not isinstance(prompt, dict) or unique_id is None:
        return None
    for key in (unique_id, str(unique_id)):
        node = prompt.get(key)
        if isinstance(node, dict):
            return node
    try:
        node = prompt.get(int(unique_id))
        if isinstance(node, dict):
            return node
    except (TypeError, ValueError):
        pass
    return None


def prompt_has_linked_input(prompt: Any, unique_id: Any, input_name: str) -> bool:
    node = _prompt_node(prompt, unique_id)
    inputs = node.get("inputs") if isinstance(node, dict) else None
    if not isinstance(inputs, dict):
        return False
    return _is_prompt_link(inputs.get(input_name))


def parse_enabled_outputs(raw_value: Any) -> list[str]:
    if raw_value is None:
        return []
    if isinstance(raw_value, (dict, list)):
        parsed = raw_value
    else:
        try:
            parsed = json.loads(str(raw_value or "[]"))
        except json.JSONDecodeError:
            return []
    if isinstance(parsed, dict):
        items = parsed.get("outputs") or parsed.get("enabled_outputs") or []
    elif isinstance(parsed, list):
        items = parsed
    else:
        return []
    enabled: list[str] = []
    for item in items:
        key = str(item.get("key") if isinstance(item, dict) else item or "")
        if key in OPTIONAL_OUTPUT_KEYS and key not in enabled:
            enabled.append(key)
    return enabled


def parse_enabled_outputs_from_workflow_outputs(outputs: Any) -> list[str]:
    if not isinstance(outputs, list):
        return []
    enabled: list[str] = []
    name_to_key = {
        str(definition.get("name") or ""): key
        for key, definition in OPTIONAL_OUTPUT_DEFS.items()
    }
    for index, item in enumerate(outputs):
        if index == 0 or not isinstance(item, dict):
            continue
        key = str(item.get("gjj_key") or item.get("key") or "")
        if key not in OPTIONAL_OUTPUT_DEFS:
            label = str(
                item.get("name")
                or item.get("label")
                or item.get("localized_name")
                or ""
            )
            key = name_to_key.get(label, "")
        if key in OPTIONAL_OUTPUT_DEFS and key not in enabled:
            enabled.append(key)
    return enabled


def parse_enabled_outputs_from_prompt_links(prompt: Any, unique_id: Any) -> list[str]:
    node = _prompt_node(prompt, unique_id)
    if not isinstance(node, dict):
        return []
    outputs = node.get("outputs")
    if isinstance(outputs, list):
        parsed = parse_enabled_outputs_from_workflow_outputs(outputs)
        if parsed:
            return parsed
    links = node.get("links") or node.get("output_links")
    if not isinstance(links, dict):
        return []
    enabled: list[str] = []
    for slot, value in links.items():
        try:
            index = int(slot)
        except Exception:
            continue
        if index <= 0 or not value:
            continue
        key = OPTIONAL_OUTPUT_KEYS[index - 1] if index - 1 < len(OPTIONAL_OUTPUT_KEYS) else ""
        if key and key not in enabled:
            enabled.append(key)
    return enabled


def recover_enabled_outputs(raw_value: Any = None, extra_pnginfo: Any = None, unique_id: Any = None, prompt: Any = None) -> list[str]:
    enabled = parse_enabled_outputs(raw_value)
    if enabled:
        return enabled
    from_prompt = parse_enabled_outputs_from_prompt_links(prompt, unique_id)
    if from_prompt:
        return from_prompt
    if not isinstance(extra_pnginfo, dict):
        return []
    workflow = extra_pnginfo.get("workflow")
    if not isinstance(workflow, dict):
        return []
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return []

    candidates: list[list[str]] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != NODE_NAME:
            continue
        if unique_id is not None and str(node.get("id")) != str(unique_id):
            continue
        properties = node.get("properties")
        if isinstance(properties, dict):
            from_property = parse_enabled_outputs(properties.get(ENABLED_OUTPUTS_PROPERTY))
            if from_property:
                candidates.append(from_property)
                continue
        from_outputs = parse_enabled_outputs_from_workflow_outputs(node.get("outputs"))
        if from_outputs:
            candidates.append(from_outputs)
    if unique_id is not None and candidates:
        return candidates[0]
    return candidates[0] if len(candidates) == 1 else []


def resolve_input_video_path(entry: dict[str, str]) -> Path:
    media_type = str(entry.get("type") or "input").strip().lower()
    if media_type == "output":
        root = Path(folder_paths.get_output_directory()).resolve()
    elif media_type == "temp":
        root = Path(folder_paths.get_temp_directory()).resolve()
    else:
        media_type = "input"
        root = _input_dir()
    filename = str(entry.get("filename") or "").strip()
    subfolder = str(entry.get("subfolder") or "").strip().replace("\\", "/")
    candidate = (root / subfolder / filename).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise RuntimeError(f"视频路径越界：{subfolder}/{filename}") from error
    if not candidate.exists():
        label = f"{subfolder}/{filename}".strip("/")
        raise RuntimeError(f"未找到{media_type}视频：{label}")
    if candidate.suffix.lower() not in VIDEO_EXTENSIONS:
        raise RuntimeError(f"不支持的视频格式：{candidate.name}")
    return candidate


def selected_video_preview_entries(selected: list[dict[str, str]]) -> list[dict[str, Any]]:
    previews: list[dict[str, Any]] = []
    for entry in selected:
        filename = str(entry.get("filename") or "").strip()
        if not filename:
            continue
        media_type = str(entry.get("type") or "input").strip().lower() or "input"
        suffix = Path(filename).suffix.lower().lstrip(".")
        is_gif = suffix == "gif"
        previews.append({
            "filename": filename,
            "subfolder": str(entry.get("subfolder") or "").strip().replace("\\", "/"),
            "type": media_type if media_type in {"input", "temp", "output"} else "input",
            "format": "image/gif" if is_gif else f"video/{suffix}",
            "media_type": "image" if is_gif else "video",
        })
    return previews


def empty_image_tensor() -> torch.Tensor:
    return torch.zeros((1, 64, 64, 3), dtype=torch.float32)


def _resize_image_tensor(image: torch.Tensor, target_width: int, target_height: int) -> torch.Tensor:
    """Resize one IMAGE tensor in BHWC format. 0 means keep/source-derived size."""
    if image.ndim != 4:
        return image
    height = int(image.shape[1])
    width = int(image.shape[2])
    tw = int(target_width or 0)
    th = int(target_height or 0)
    if tw <= 0 and th <= 0:
        return image.contiguous()
    if tw <= 0:
        tw = max(1, round(width * th / max(1, height)))
    if th <= 0:
        th = max(1, round(height * tw / max(1, width)))
    if width == tw and height == th:
        return image.contiguous()
    chw = image.permute(0, 3, 1, 2).contiguous()
    resized = F.interpolate(chw, size=(th, tw), mode="bilinear", align_corners=False)
    return resized.permute(0, 2, 3, 1).clamp(0.0, 1.0).contiguous()


def _normalize_target_dimension(value: int) -> int:
    """Treat tiny stale UI dimensions as source-following.

    Width/height widgets are hidden and maintained by JS. Old or mismatched
    workflows can leave them at tiny preview-like values such as 1, 14, or 25,
    which would collapse a valid video into tiny blurry thumbnails. Real
    video/image output below 64 px is not useful in this loader, so keep the
    source size instead.
    """
    value = int(value or 0)
    if 0 < value < 64:
        return 0
    return value


def _target_output_size(source_width: int, source_height: int, target_width: int, target_height: int) -> tuple[int, int]:
    sw = max(1, int(source_width or 1))
    sh = max(1, int(source_height or 1))
    tw = int(target_width or 0)
    th = int(target_height or 0)
    if tw <= 0 and th <= 0:
        return sw, sh
    if tw <= 0:
        tw = max(1, round(sw * th / max(1, sh)))
    if th <= 0:
        th = max(1, round(sh * tw / max(1, sw)))
    return tw, th


def _frames_tensor_from_rgb_bytes(raw_data: bytes, frame_count: int, width: int, height: int) -> torch.Tensor:
    array = np.frombuffer(raw_data, dtype=np.uint8)
    expected = int(frame_count) * int(height) * int(width) * 3
    if int(array.size) < expected:
        raise RuntimeError("FFmpeg 输出数据不完整")
    if int(array.size) > expected:
        array = array[:expected]
    array = array.reshape(int(frame_count), int(height), int(width), 3)
    return torch.from_numpy(array.copy()).float().div_(255.0).contiguous()


def build_uniform_batch(images: list[torch.Tensor]) -> torch.Tensor:
    if not images:
        return empty_image_tensor()
    max_height = max(int(image.shape[1]) for image in images)
    max_width = max(int(image.shape[2]) for image in images)
    padded: list[torch.Tensor] = []
    for image in images:
        height = int(image.shape[1])
        width = int(image.shape[2])
        if height == max_height and width == max_width:
            padded.append(image.contiguous())
            continue
        canvas = torch.zeros((1, max_height, max_width, 3), dtype=image.dtype, device=image.device)
        top = max(0, (max_height - height) // 2)
        left = max(0, (max_width - width) // 2)
        canvas[:, top:top + height, left:left + width, :] = image
        padded.append(canvas)
    return torch.cat(padded, dim=0)


def empty_audio(duration: float = 0.0, sample_rate: int = 44100, channels: int = 2) -> dict[str, Any]:
    samples = max(1, int(round(max(0.0, float(duration)) * int(sample_rate))))
    waveform = torch.zeros((1, int(channels), samples), dtype=torch.float32)
    return {"waveform": waveform, "sample_rate": int(sample_rate)}


def _audio_window_from_meta(
    meta: dict[str, Any],
    start_frame: int,
    end_frame: int,
    frame_stride: int,
    max_frames: int,
) -> tuple[float, float]:
    fps = max(1e-6, float(meta.get("fps") or 24.0))
    start = max(0, int(start_frame))
    total = int(meta.get("frames") or 0)
    stop = int(end_frame) if int(end_frame) > 0 else (total - 1 if total > 0 else 0)
    if stop < start:
        stop = start
    stride = max(1, int(frame_stride))
    limit = max(1, int(max_frames))
    total_frames_to_decode = max(1, stop - start + 1)
    frames_to_output = min((total_frames_to_decode + stride - 1) // stride, limit)
    last_source_frame = start + max(0, frames_to_output - 1) * stride
    last_source_frame = min(stop, last_source_frame)
    return float(start) / fps, max(1.0 / fps, float(last_source_frame - start + 1) / fps)


def _selected_frame_indices(
    total_frames: int,
    start_frame: int,
    end_frame: int,
    frame_stride: int,
    max_frames: int,
) -> list[int]:
    total = max(0, int(total_frames))
    if total <= 0:
        return []
    start = max(0, min(int(start_frame), total - 1))
    stop = int(end_frame) if int(end_frame) > 0 else total - 1
    stop = max(start, min(stop, total - 1))
    stride = max(1, int(frame_stride))
    limit = max(1, int(max_frames))
    return list(range(start, stop + 1, stride))[:limit]


def _effective_output_fps(source_fps: float, frame_stride: int) -> float:
    fps = float(source_fps or 24.0)
    stride = max(1, int(frame_stride or 1))
    return max(1.0, min(240.0, fps / stride))


def _slice_external_frames(
    frames: torch.Tensor,
    start_frame: int,
    end_frame: int,
    frame_stride: int,
    max_frames: int,
) -> torch.Tensor:
    indices = _selected_frame_indices(int(frames.shape[0]), start_frame, end_frame, frame_stride, max_frames)
    if not indices:
        return frames[:1].contiguous()
    index_tensor = torch.tensor(indices, dtype=torch.long, device=frames.device)
    return frames.index_select(0, index_tensor).contiguous()


def _range_first_last_indices(total_frames: int, start_frame: int, end_frame: int) -> tuple[int, int]:
    total = max(0, int(total_frames))
    if total <= 0:
        return 0, 0
    start = max(0, min(int(start_frame), total - 1))
    stop = int(end_frame) if int(end_frame) > 0 else total - 1
    stop = max(start, min(stop, total - 1))
    return start, stop


def _first_last_from_tensor_range(
    frames: torch.Tensor,
    start_frame: int,
    end_frame: int,
    width: int = 0,
    height: int = 0,
) -> torch.Tensor:
    if not isinstance(frames, torch.Tensor) or frames.ndim != 4 or int(frames.shape[0]) <= 0:
        return empty_image_tensor().repeat(2, 1, 1, 1)
    first_index, last_index = _range_first_last_indices(int(frames.shape[0]), start_frame, end_frame)
    index_tensor = torch.tensor([first_index, last_index], dtype=torch.long, device=frames.device)
    selected = frames.index_select(0, index_tensor).contiguous()
    return _resize_image_tensor(selected, width, height)


def _slice_audio_window(audio: dict[str, Any] | None, start_seconds: float, duration_seconds: float) -> dict[str, Any] | None:
    if not isinstance(audio, dict):
        return None
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate") or 0)
    if not isinstance(waveform, torch.Tensor) or sample_rate <= 0:
        return audio
    start_sample = max(0, int(round(float(start_seconds) * sample_rate)))
    count = max(1, int(round(float(duration_seconds) * sample_rate)))
    end_sample = min(int(waveform.shape[-1]), start_sample + count)
    if end_sample <= start_sample:
        return empty_audio(0.0, sample_rate, int(waveform.shape[-2]) if waveform.ndim >= 2 else 2)
    return {"waveform": waveform[..., start_sample:end_sample].contiguous(), "sample_rate": sample_rate}


def decode_audio_ffmpeg(
    path: Path,
    start_seconds: float = 0.0,
    duration_seconds: float = 0.0,
    sample_rate: int = 44100,
    channels: int = 2,
) -> dict[str, Any]:
    ffmpeg = _get_ffmpeg_path()
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
    ]
    if start_seconds > 0:
        cmd.extend(["-ss", f"{float(start_seconds):.6f}"])
    cmd.extend(["-i", str(path), "-vn"])
    if duration_seconds > 0:
        cmd.extend(["-t", f"{float(duration_seconds):.6f}"])
    cmd.extend([
        "-ac", str(int(channels)),
        "-ar", str(int(sample_rate)),
        "-f", "f32le",
        "-acodec", "pcm_f32le",
        "-",
    ])
    proc = subprocess.run(cmd, capture_output=True, timeout=120)
    if proc.returncode != 0 or not proc.stdout:
        return empty_audio(duration_seconds, sample_rate, channels)
    audio = np.frombuffer(proc.stdout, dtype=np.float32)
    usable = (audio.size // int(channels)) * int(channels)
    if usable <= 0:
        return empty_audio(duration_seconds, sample_rate, channels)
    audio = audio[:usable].reshape(-1, int(channels)).T
    waveform = torch.from_numpy(audio.copy()).float().unsqueeze(0).clamp(-1.0, 1.0).contiguous()
    return {"waveform": waveform, "sample_rate": int(sample_rate)}


def concat_audio_segments(segments: list[dict[str, Any]], sample_rate: int = 44100, channels: int = 2) -> dict[str, Any]:
    waveforms: list[torch.Tensor] = []
    for segment in segments:
        waveform = segment.get("waveform") if isinstance(segment, dict) else None
        if not isinstance(waveform, torch.Tensor):
            continue
        if waveform.ndim == 2:
            waveform = waveform.unsqueeze(0)
        if waveform.ndim != 3:
            continue
        waveform = waveform.detach().cpu().float()
        if int(waveform.shape[1]) < channels:
            waveform = waveform.repeat(1, int(np.ceil(channels / max(1, int(waveform.shape[1])))), 1)[:, :channels, :]
        elif int(waveform.shape[1]) > channels:
            waveform = waveform[:, :channels, :]
        waveforms.append(waveform)
    if not waveforms:
        return empty_audio(0.0, sample_rate, channels)
    return {"waveform": torch.cat(waveforms, dim=-1).contiguous(), "sample_rate": int(sample_rate)}


def _frame_to_tensor(frame: np.ndarray) -> torch.Tensor:
    array = np.asarray(frame).astype(np.float32) / 255.0
    if array.ndim == 2:
        array = np.stack([array, array, array], axis=-1)
    if array.shape[-1] == 4:
        array = array[..., :3]
    return torch.from_numpy(array[..., :3]).unsqueeze(0)


def _get_ffmpeg_path() -> str:
    """获取 FFmpeg 可执行文件路径"""
    try:
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        if Path(ffmpeg_exe).exists():
            return str(ffmpeg_exe)
    except Exception:
        pass
    return "ffmpeg"


def decode_video_cv2(
    path: Path,
    start_frame: int,
    end_frame: int,
    frame_stride: int,
    max_frames: int,
    width: int = 0,
    height: int = 0,
) -> tuple[list[torch.Tensor], dict[str, Any]]:
    ffmpeg = _get_ffmpeg_path()
    start = max(0, int(start_frame))
    stride = max(1, int(frame_stride))
    limit = max(1, int(max_frames))

    meta = video_meta(path)
    fps = float(meta.get("fps") or 24.0)
    source_width = int(meta.get("width") or 0)
    source_height = int(meta.get("height") or 0)
    total = int(meta.get("frames") or 0)
    duration = float(meta.get("duration") or 0.0)

    stop = int(end_frame) if int(end_frame) > 0 else (total - 1 if total > 0 else 0)
    if stop < start:
        stop = start

    total_frames_to_decode = stop - start + 1
    if total_frames_to_decode <= 0:
        raise RuntimeError(f"无效的帧范围：start={start}, stop={stop}, total={total}")

    if stride > total_frames_to_decode:
        raise RuntimeError(f"抽帧间隔({stride})过大，超过了帧范围({total_frames_to_decode})，无法提取任何帧")

    frames_to_output = min((total_frames_to_decode + stride - 1) // stride, limit)
    if frames_to_output <= 0:
        frames_to_output = 1

    output_width, output_height = _target_output_size(source_width, source_height, int(width), int(height))
    filters = [f"select=not(mod(n\\,{stride}))"]
    if output_width != source_width or output_height != source_height:
        filters.append(f"scale={output_width}:{output_height}:flags=bicubic")

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-ss", str(start / fps),
        "-i", str(path),
        "-an",
        "-sn",
        "-frames:v", str(frames_to_output),
        "-vf", ",".join(filters),
        "-vsync", "vfr",
        "-f", "image2pipe",
        "-pix_fmt", "rgb24",
        "-vcodec", "rawvideo",
        "-",
    ]

    try:
        if source_width <= 0 or source_height <= 0:
            raise RuntimeError(f"无法确定视频原始尺寸")

        frame_size = output_width * output_height * 3
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        frames: list[torch.Tensor] = []
        try:
            assert proc.stdout is not None
            for _index in range(frames_to_output):
                raw_frame = proc.stdout.read(frame_size)
                if not raw_frame:
                    break
                if len(raw_frame) < frame_size:
                    raise RuntimeError(f"FFmpeg 输出数据不完整")
                frames.append(_frames_tensor_from_rgb_bytes(raw_frame, 1, output_width, output_height))
            try:
                proc.stdout.close()
            except Exception:
                pass
            stderr = proc.stderr.read() if proc.stderr is not None else b""
            return_code = proc.wait(timeout=30)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

        if return_code != 0:
            stderr_msg = stderr.decode('utf-8', errors='ignore') if stderr else ""
            raise RuntimeError(f"FFmpeg 解码失败: {stderr_msg}\n命令: {' '.join(cmd)}")
        if not frames:
            raise RuntimeError(f"FFmpeg 未输出任何数据\n命令: {' '.join(cmd)}\nstart={start}, stop={stop}, stride={stride}, frames_to_output={frames_to_output}")

    except subprocess.TimeoutExpired:
        raise RuntimeError(f"FFmpeg 解码结束等待超时")
    except Exception as e:
        raise RuntimeError(f"FFmpeg 解码错误: {str(e)}")

    if not frames:
        raise RuntimeError(f"未从视频读取到有效帧：{path.name}")

    actual_output_width = int(frames[0].shape[2]) if frames else 0
    actual_output_height = int(frames[0].shape[1]) if frames else 0
    
    return frames, {
        "fps": fps or 24.0,
        "frames": total,
        "width": source_width,
        "height": source_height,
        "output_width": actual_output_width,
        "output_height": actual_output_height,
        "duration": duration,
    }


def decode_video_frame_pair(
    path: Path,
    start_frame: int,
    end_frame: int,
    width: int = 0,
    height: int = 0,
) -> torch.Tensor:
    meta = video_meta(path)
    fps = float(meta.get("fps") or 24.0)
    source_width = int(meta.get("width") or 0)
    source_height = int(meta.get("height") or 0)
    total = int(meta.get("frames") or 0)
    first_index, last_index = _range_first_last_indices(total, start_frame, end_frame)
    output_width, output_height = _target_output_size(source_width, source_height, int(width), int(height))

    decoded: list[torch.Tensor] = []
    for frame_index in (first_index, last_index):
        filters = [f"select=eq(n\\,{int(frame_index)})"]
        if output_width != source_width or output_height != source_height:
            filters.append(f"scale={output_width}:{output_height}:flags=bicubic")
        cmd = [
            _get_ffmpeg_path(),
            "-hide_banner",
            "-loglevel", "error",
            "-i", str(path),
            "-an",
            "-sn",
            "-frames:v", "1",
            "-vf", ",".join(filters),
            "-vsync", "vfr",
            "-f", "image2pipe",
            "-pix_fmt", "rgb24",
            "-vcodec", "rawvideo",
            "-",
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=60)
        if proc.returncode != 0 or not proc.stdout:
            stderr_msg = proc.stderr.decode("utf-8", errors="ignore") if proc.stderr else ""
            raise RuntimeError(f"FFmpeg 读取首尾帧失败：{path.name} frame={frame_index} {stderr_msg}")
        frame_size = int(output_width) * int(output_height) * 3
        if len(proc.stdout) < frame_size:
            raise RuntimeError(f"FFmpeg 首尾帧输出数据不完整：{path.name} frame={frame_index}")
        decoded.append(_frames_tensor_from_rgb_bytes(proc.stdout[:frame_size], 1, output_width, output_height))
    return torch.cat(decoded, dim=0).contiguous()


def _hidden_panel_widget(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Keep backend inputs serializable while letting the JS DOM panel render them.

    ComfyUI versions differ on which option they honor, so we set several
    harmless flags. The JS still applies the full method-4 hide patch as a
    second layer.
    """
    options = dict(extra or {})
    options.update({
        "widget": "hidden",
        "display": "hidden",
        "hidden": True,
        "advanced": True,
    })
    return options


def _create_processed_video(frames: torch.Tensor, fps: float, audio: dict[str, Any] | None = None):
    if not isinstance(frames, torch.Tensor) or frames.ndim != 4 or int(frames.shape[0]) <= 0:
        raise RuntimeError("处理后 VIDEO 输出失败：没有可用的视频帧。")
    safe_frames = frames.float().clamp(0.0, 1.0)
    if int(safe_frames.shape[-1]) == 1:
        safe_frames = safe_frames.repeat(1, 1, 1, 3)
    elif int(safe_frames.shape[-1]) > 3:
        safe_frames = safe_frames[..., :3]
    try:
        from comfy_api.latest import InputImpl, Types
    except Exception as exc:
        raise RuntimeError(f"处理后 VIDEO 输出失败：当前 ComfyUI 缺少官方 VIDEO 接口：{exc}") from exc
    frame_rate = Fraction(float(max(0.01, fps))).limit_denominator(1000)
    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=safe_frames.contiguous(),
            audio=audio,
            frame_rate=frame_rate,
        )
    )


class GJJ_MultiVideoLoader:
    CATEGORY = "GJJ"
    FUNCTION = "load_videos"
    OUTPUT_NODE = False
    DESCRIPTION = "一次选择多个 input 目录视频，按帧范围、帧率、宽高和格式参数解码为 GJJ 批量图片帧队列。"
    SEARCH_ALIASES = ["multi video loader", "video loader", "批量视频", "视频加载", "视频解码", "视频帧", "视频预览", "批量视频加载预览器"]
    # 扩展输出由前端动态重建，用户可任意排序；后端静态类型必须用通配，
    # 否则例如“音频”落在静态 STRING 槽位时会被严格 AUDIO 输入拒绝。
    RETURN_TYPES = (
        VIDEO_FRAME_QUEUE_TYPE,  # 视频帧队列
        any_type,
        any_type,
        any_type,
        any_type,
        any_type,
        any_type,
        any_type,
        any_type,
        any_type,
        any_type,
        any_type,
        any_type,
    )
    RETURN_NAMES = (
        "视频帧队列",
        "首帧预览",
        "尾帧预览",
        "视频信息JSON",
        "帧率",
        "输出帧数",
        "源时长",
        "宽度",
        "高度",
        "视频格式",
        "音频",
        "首尾帧",
        "处理后视频",
    )
    OUTPUT_TOOLTIPS = (
        "按选择顺序解码后拼接的帧序列，类型为 GJJ_BATCH_IMAGE,IMAGE,VIDEO，兼容 GJJ 批量帧队列、普通 IMAGE 和 VIDEO 输入口。",
        "首帧预览图片。",
        "尾帧预览图片。",
        "视频信息JSON字符串。",
        "输出帧率。",
        "输出总帧数。",
        "源视频总时长（秒）。",
        "输出宽度。",
        "输出高度。",
        "视频格式参数。",
        "从所选视频音轨提取并按选择顺序拼接的 AUDIO；没有音轨时输出同段静音。",
        "视频序列首帧和尾帧拼成的 2 张 IMAGE 批次，类型为 GJJ_BATCH_IMAGE,IMAGE。",
        "按当前宽高、起止帧、抽帧间隔、最大帧数处理后的官方 VIDEO，包含同步裁剪/拼接后的音频。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        panel_inputs = {
            "frame_rate": (
                "INT,FLOAT",
                _hidden_panel_widget({
                    "default": 24.0,
                    "min": 1.0,
                    "max": 240.0,
                    "step": 0.01,
                    "display_name": "帧率",
                    "tooltip": "最终输出帧率参数；选择视频时会自动读取源帧率，可手动修改或转成外部输入。",
                }),
            ),
            "width": (
                "INT",
                _hidden_panel_widget({
                    "default": 0,
                    "min": 0,
                    "max": 16384,
                    "step": 1,
                    "display_name": "宽度",
                    "tooltip": "最终输出宽度；0 表示跟随源视频；只填宽度会按比例计算高度。",
                }),
            ),
            "height": (
                "INT",
                _hidden_panel_widget({
                    "default": 0,
                    "min": 0,
                    "max": 16384,
                    "step": 1,
                    "display_name": "高度",
                    "tooltip": "最终输出高度；0 表示跟随源视频；只填高度会按比例计算宽度。",
                }),
            ),
            "video_format": (
                VIDEO_FORMATS,
                _hidden_panel_widget({
                    "default": "video/h264-mp4",
                    "display_name": "视频格式",
                    "tooltip": "格式参数命名参考 VHS_VideoCombine，方便接到后续合成/保存节点。",
                }),
            ),
            "start_frame": (
                "INT",
                _hidden_panel_widget({
                    "default": 0,
                    "min": 0,
                    "max": 999999,
                    "step": 1,
                    "display_name": "起始帧",
                    "tooltip": "从第几帧开始读取；0 表示从第一帧开始。",
                }),
            ),
            "end_frame": (
                "INT",
                _hidden_panel_widget({
                    "default": 0,
                    "min": 0,
                    "max": 999999,
                    "step": 1,
                    "display_name": "结束帧",
                    "tooltip": "读取到第几帧结束；0 表示读取到视频末尾或达到最大帧数。",
                }),
            ),
            "frame_stride": (
                "INT",
                _hidden_panel_widget({
                    "default": 1,
                    "min": 1,
                    "max": 1000,
                    "step": 1,
                    "display_name": "抽帧间隔",
                    "tooltip": "每隔多少帧取一帧；1 表示不跳帧。",
                }),
            ),
            "max_frames": (
                "INT",
                _hidden_panel_widget({
                    "default": 240,
                    "min": 1,
                    "max": 100000,
                    "step": 1,
                    "display_name": "最大帧数",
                    "tooltip": "每个视频最多解码多少帧，防止超长视频一次占用过多内存。",
                }),
            ),
            "filter_keyword": (
                "STRING",
                _hidden_panel_widget({
                    "default": "",
                    "display_name": "过滤关键词",
                    "tooltip": "只在【视频】下拉列表中显示文件名或目录包含该关键词的视频；留空不过滤。",
                }),
            ),
            "filter_directory": (
                "STRING",
                _hidden_panel_widget({
                    "default": "",
                    "display_name": "过滤目录",
                    "tooltip": "只在【视频】下拉列表中显示 input 下相对目录包含该文本的视频；留空不过滤。",
                }),
            ),
            "refresh_interval": (
                "FLOAT",
                _hidden_panel_widget({
                    "default": 5.0,
                    "min": 1.0,
                    "max": 3600.0,
                    "step": 0.5,
                    "display_name": "刷新时间",
                    "tooltip": "开启定时刷新后，每隔多少秒重新扫描视频列表。",
                }),
            ),
            "auto_refresh": (
                "BOOLEAN",
                _hidden_panel_widget({
                    "default": False,
                    "display_name": "定时刷新",
                    "tooltip": "开启后前端按刷新时间自动重新扫描视频列表，适合监控分段生成的视频。",
                }),
            ),
            "selected_videos_json": (
                "STRING",
                _hidden_panel_widget({
                    "default": "[]",
                    "display_name": "已选视频JSON",
                    "tooltip": "内部保存用：记录面板中选择的视频，重新打开工作流后用于恢复真实源视频。",
                }),
            ),
        }
        return {
            "required": {},
            "optional": {
                **panel_inputs,
                "input_frames": ("GJJ_BATCH_IMAGE,IMAGE,VIDEO", {"display_name": "视频帧队列", "tooltip": "非必选：可直接输入上游帧队列。接入后优先使用输入帧，未接入时读取下拉选择的视频。"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    @staticmethod
    def _coerce_external_frames(value: Any) -> torch.Tensor | None:
        if value is None:
            return None
        if isinstance(value, torch.Tensor):
            tensor = value
        elif isinstance(value, dict):
            candidate = None
            for key in ("images", "frames", "samples"):
                if isinstance(value.get(key), torch.Tensor):
                    candidate = value.get(key)
                    break
            tensor = candidate if isinstance(candidate, torch.Tensor) else None
        elif isinstance(value, (list, tuple)) and value and all(isinstance(x, torch.Tensor) for x in value):
            tensor = torch.cat([x if x.ndim == 4 else x.unsqueeze(0) for x in value], dim=0)
        else:
            tensor = None
        if tensor is None:
            return None
        if tensor.ndim == 3:
            tensor = tensor.unsqueeze(0)
        if tensor.ndim != 4:
            return None
        # Accept BHWC IMAGE-like tensors. Latent/video dict formats should be converted upstream when needed.
        if tensor.shape[-1] not in (1, 3, 4):
            return None
        if tensor.shape[-1] == 1:
            tensor = tensor.repeat(1, 1, 1, 3)
        if tensor.shape[-1] == 4:
            tensor = tensor[..., :3]
        return tensor.float().clamp(0.0, 1.0).contiguous()

    @staticmethod
    def _component_value(value: Any, key: str) -> Any:
        if value is None:
            return None
        if isinstance(value, dict):
            return value.get(key)
        return getattr(value, key, None)

    @staticmethod
    def _float_value(value: Any, default: float = 0.0) -> float:
        if value is None:
            return default
        try:
            number = float(value)
        except (TypeError, ValueError):
            return default
        return number if np.isfinite(number) else default

    @staticmethod
    def _int_value(value: Any, default: int = 0) -> int:
        if value is None:
            return default
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _normalize_external_audio(value: Any) -> dict[str, Any] | None:
        if value is None:
            return None

        waveform = None
        sample_rate = None
        if isinstance(value, dict):
            waveform = value.get("waveform")
            sample_rate = value.get("sample_rate")
        else:
            waveform = getattr(value, "waveform", None)
            sample_rate = getattr(value, "sample_rate", None)
            if waveform is None and hasattr(value, "get"):
                try:
                    waveform = value.get("waveform")
                    sample_rate = value.get("sample_rate")
                except Exception:
                    pass

        sample_rate = GJJ_MultiVideoLoader._int_value(sample_rate, 0)
        if waveform is None or sample_rate <= 0:
            return None
        if not isinstance(waveform, torch.Tensor):
            try:
                waveform = torch.as_tensor(waveform)
            except Exception:
                return None
        if waveform.ndim == 1:
            waveform = waveform.unsqueeze(0).unsqueeze(0)
        elif waveform.ndim == 2:
            waveform = waveform.unsqueeze(0)
        elif waveform.ndim == 3:
            pass
        elif waveform.ndim > 3:
            waveform = waveform.reshape(-1, waveform.shape[-2], waveform.shape[-1])
        else:
            return None
        return {"waveform": waveform.float().contiguous(), "sample_rate": sample_rate}

    @classmethod
    def _coerce_external_video(cls, value: Any) -> dict[str, Any] | None:
        if value is None:
            return None

        direct_frames = cls._coerce_external_frames(value)
        if direct_frames is not None:
            fps = 0.0
            duration = 0.0
            audio = None
            metadata = None
            if isinstance(value, dict):
                for key in ("frame_rate", "fps", "source_fps"):
                    if key in value:
                        fps = cls._float_value(value.get(key), 0.0)
                        break
                for key in ("duration", "source_duration", "total_source_duration"):
                    if key in value:
                        duration = cls._float_value(value.get(key), 0.0)
                        break
                audio = cls._normalize_external_audio(value.get("audio"))
                metadata = value.get("metadata")
            return {
                "frames": direct_frames,
                "fps": fps,
                "duration": duration,
                "frame_count": int(direct_frames.shape[0]),
                "audio": audio,
                "metadata": metadata if isinstance(metadata, dict) else {},
                "source": "external_input",
                "format": "",
            }

        if not hasattr(value, "get_components"):
            return None

        try:
            components = value.get_components()
        except Exception as error:
            raise RuntimeError(f"左侧视频输入可识别为 VIDEO，但读取视频帧失败：{error}") from error

        frames = cls._coerce_external_frames(cls._component_value(components, "images"))
        if frames is None:
            raise RuntimeError("左侧视频输入可识别为 VIDEO，但没有解析出可用的视频帧。")

        fps = cls._float_value(cls._component_value(components, "frame_rate"), 0.0)
        audio = cls._normalize_external_audio(cls._component_value(components, "audio"))
        metadata = cls._component_value(components, "metadata")
        duration = 0.0
        frame_count = int(frames.shape[0])
        source = "external_video"
        container_format = ""

        for method_name, field_name in (
            ("get_frame_rate", "fps"),
            ("get_duration", "duration"),
            ("get_frame_count", "frame_count"),
            ("get_container_format", "format"),
            ("get_stream_source", "source"),
        ):
            method = getattr(value, method_name, None)
            if not callable(method):
                continue
            try:
                method_value = method()
            except Exception:
                continue
            if field_name == "fps":
                fps = cls._float_value(method_value, fps)
            elif field_name == "duration":
                duration = cls._float_value(method_value, duration)
            elif field_name == "frame_count":
                frame_count = cls._int_value(method_value, frame_count)
            elif field_name == "format":
                container_format = str(method_value or "")
            elif field_name == "source":
                source = Path(method_value).name if isinstance(method_value, (str, Path)) else "external_video"

        return {
            "frames": frames,
            "fps": fps,
            "duration": duration,
            "frame_count": frame_count,
            "audio": audio,
            "metadata": metadata if isinstance(metadata, dict) else {},
            "source": source,
            "format": container_format,
        }

    def load_videos(
        self,
        frame_rate=None,
        width=None,
        height=None,
        video_format=None,
        start_frame=None,
        end_frame=None,
        frame_stride=None,
        max_frames=None,
        filter_keyword=None,
        filter_directory=None,
        refresh_interval=None,
        auto_refresh=False,
        selected_videos_json=None,
        input_frames=None,
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        selected = recover_selected_videos(selected_videos_json, extra_pnginfo, unique_id)
        enabled_outputs = recover_enabled_outputs(None, extra_pnginfo, unique_id, prompt)
        enabled_output_set = set(enabled_outputs or [])
        audio_enabled = bool({"audio", "processed_video"} & enabled_output_set)

        def _safe_int(value, default=0, min_val=0, max_val=999999):
            try:
                return max(min_val, min(max_val, int(value)))
            except (ValueError, TypeError):
                return default
        
        def _safe_float(value, default=0.0, min_val=0.0, max_val=1e10):
            try:
                return max(min_val, min(max_val, float(value)))
            except (ValueError, TypeError):
                return default
        
        output_fps = _safe_float(frame_rate, 24.0, 1.0, 240.0)
        target_width = _normalize_target_dimension(_safe_int(width, 0, 0, 16384))
        target_height = _normalize_target_dimension(_safe_int(height, 0, 0, 16384))
        output_format = str(video_format or "video/h264-mp4")
        
        start_frame_val = _safe_int(start_frame, 0, 0, 999999)
        end_frame_val = _safe_int(end_frame, 0, 0, 999999)
        frame_stride_val = _safe_int(frame_stride, 1, 1, 1000)
        max_frames_val = _safe_int(max_frames, 240, 1, 100000)
        _ = (filter_keyword, filter_directory, refresh_interval, auto_refresh)
        first_last_frames = None

        external_video = self._coerce_external_video(input_frames)
        if external_video is not None and selected and isinstance(prompt, dict) and not prompt_has_linked_input(prompt, unique_id, "input_frames"):
            external_video = None
        if external_video is not None:
            raw_external_frames = external_video["frames"]
            source_fps = float(external_video.get("fps") or output_fps)
            output_fps = _effective_output_fps(source_fps, frame_stride_val)
            source_frame_count = int(external_video.get("frame_count") or raw_external_frames.shape[0])
            external_frames = _slice_external_frames(
                raw_external_frames,
                start_frame_val,
                end_frame_val,
                frame_stride_val,
                max_frames_val,
            )
            batch_output = _resize_image_tensor(external_frames, target_width, target_height)
            first_last_frames = _first_last_from_tensor_range(raw_external_frames, start_frame_val, end_frame_val, target_width, target_height)
            selected_indices = _selected_frame_indices(
                int(raw_external_frames.shape[0]),
                start_frame_val,
                end_frame_val,
                frame_stride_val,
                max_frames_val,
            )
            first_selected = selected_indices[0] if selected_indices else 0
            last_selected = selected_indices[-1] if selected_indices else first_selected
            total_duration = max(1.0 / max(1e-6, source_fps), float(last_selected - first_selected + 1) / max(1e-6, source_fps))
            external_audio = external_video.get("audio")
            external_audio = _slice_audio_window(external_audio, float(first_selected) / max(1e-6, source_fps), total_duration)
            source_name = str(external_video.get("source") or "external_input")
            video_infos = [{
                "filename": source_name,
                "subfolder": "",
                "path": "",
                "source_width": int(raw_external_frames.shape[2]),
                "source_height": int(raw_external_frames.shape[1]),
                "output_width": int(batch_output.shape[2]),
                "output_height": int(batch_output.shape[1]),
                "source_fps": source_fps,
                "output_fps": output_fps,
                "source_frames": source_frame_count,
                "duration": total_duration,
                "output_frames": int(batch_output.shape[0]),
                "start_frame": start_frame_val,
                "end_frame": last_selected,
                "frame_stride": frame_stride_val,
                "max_frames": max_frames_val,
                "video_format": str(external_video.get("format") or output_format),
            }]
            selected_count = 0
            if audio_enabled:
                output_audio = external_audio if external_audio is not None else empty_audio(total_duration)
            else:
                output_audio = None
        else:
            if not selected:
                raise RuntimeError("请先在 GJJ · 批量视频加载预览器里选择或导入视频，或接入左侧视频帧队列。")

            all_frames: list[torch.Tensor] = []
            audio_segments: list[dict[str, Any]] = []
            video_infos: list[dict[str, Any]] = []
            total_duration = 0.0
            source_fps = 24.0

            for index, entry in enumerate(selected):
                path = resolve_input_video_path(entry)
                frames, meta = decode_video_cv2(
                    path=path,
                    start_frame=start_frame_val,
                    end_frame=end_frame_val,
                    frame_stride=frame_stride_val,
                    max_frames=max_frames_val,
                    width=target_width,
                    height=target_height,
                )
                try:
                    pair = decode_video_frame_pair(path, start_frame_val, end_frame_val, target_width, target_height)
                    first_last_frames = pair if first_last_frames is None else torch.cat([first_last_frames[:1], pair[-1:]], dim=0).contiguous()
                except Exception as error:
                    print(f"[GJJ_MultiVideoLoader] 独立读取首尾帧失败，回退到输出队列首尾: {error}")
                if audio_enabled:
                    audio_start, audio_duration = _audio_window_from_meta(
                        meta,
                        start_frame_val,
                        end_frame_val,
                        frame_stride_val,
                        max_frames_val,
                    )
                    audio_segments.append(decode_audio_ffmpeg(path, audio_start, audio_duration))
                if index == 0:
                    source_fps = float(meta.get("fps") or 24.0)
                    output_fps = _effective_output_fps(source_fps, frame_stride_val)
                total_duration += float(meta.get("duration") or 0.0)
                all_frames.extend(frames)
                video_source_fps = float(meta.get("fps") or 0.0)
                video_infos.append(
                    {
                        "filename": entry["filename"],
                        "subfolder": entry.get("subfolder", ""),
                        "path": str(path),
                        "source_width": int(meta.get("width") or 0),
                        "source_height": int(meta.get("height") or 0),
                        "output_width": int(meta.get("output_width") or 0),
                        "output_height": int(meta.get("output_height") or 0),
                        "source_fps": video_source_fps,
                        "output_fps": _effective_output_fps(video_source_fps or source_fps, frame_stride_val),
                        "source_frames": int(meta.get("frames") or 0),
                        "duration": float(meta.get("duration") or 0.0),
                        "output_frames": len(frames),
                        "video_format": output_format,
                    }
                )

            batch_output = build_uniform_batch(all_frames)
            selected_count = len(selected)
            output_audio = concat_audio_segments(audio_segments) if audio_enabled else None
        first_frame = batch_output[0:1].contiguous() if int(batch_output.shape[0]) > 0 else empty_image_tensor()
        last_frame = batch_output[-1:].contiguous() if int(batch_output.shape[0]) > 0 else empty_image_tensor()
        if first_last_frames is None:
            first_last_frames = torch.cat([first_frame, last_frame], dim=0).contiguous()
        final_width = int(batch_output.shape[2]) if int(batch_output.ndim) == 4 else 0
        final_height = int(batch_output.shape[1]) if int(batch_output.ndim) == 4 else 0

        preview_entries: list[dict[str, Any]] = selected_video_preview_entries(selected) if selected_count > 0 else []
        if not preview_entries and int(batch_output.shape[0]) > 0:
            preview_tensor = batch_output
            preview_fps = max(1.0, float(output_fps or _effective_output_fps(source_fps, frame_stride_val)))
            preview_entries = _save_sequence_webp_preview(preview_tensor, preview_fps)

        processed_video = None
        if "processed_video" in enabled_output_set:
            processed_video = _create_processed_video(
                batch_output,
                float(output_fps or _effective_output_fps(source_fps, frame_stride_val)),
                output_audio if output_audio is not None else empty_audio(total_duration),
            )

        info = {
            "videos": video_infos,
            "selection_count": selected_count,
            "output_frames": int(batch_output.shape[0]),
            "source_fps": source_fps,
            "frame_rate": output_fps,
            "width": final_width,
            "height": final_height,
            "video_format": output_format,
            "total_source_duration": total_duration,
            "start_frame": start_frame_val,
            "end_frame": end_frame_val,
            "frame_stride": frame_stride_val,
            "max_frames_per_video": max_frames_val,
        }

        optional_values = {
            "first_frame": first_frame,
            "last_frame": last_frame,
            "info_json": json.dumps(info, ensure_ascii=False, indent=2),
            "frame_rate": float(output_fps),
            "frame_count": int(batch_output.shape[0]),
            "source_duration": float(total_duration),
            "width": int(final_width),
            "height": int(final_height),
            "video_format": output_format,
            "audio": output_audio if output_audio is not None else empty_audio(0.0),
            "first_last_frames": first_last_frames,
        }
        if "processed_video" in enabled_output_set:
            optional_values["processed_video"] = processed_video
        
        # 返回真正显示的动态输出，顺序必须与前端 enabled_outputs JSON 配置一致。
        # 前端会把用户当前选择序列化为 {outputs:[{key,name,type}]}，这里只按 key 取值，
        # 避免右侧输出标签和实际返回值在增删输出口后错位。
        result = [batch_output]
        for key in enabled_outputs or []:
            if key in optional_values:
                result.append(optional_values[key])

        ui_payload = {
            "preview_images": preview_entries,
            "video_count": [selected_count],
            "frame_count": [int(batch_output.shape[0])],
            "source_fps": [float(source_fps)],
            "frame_rate": [float(output_fps)],
            "width": [int(final_width)],
            "height": [int(final_height)],
            "video_format": [output_format],
        }
        return {
            "ui": ui_payload,
            "result": tuple(result),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MultiVideoLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🧡·🎬 批量多视频加载预览器"}
