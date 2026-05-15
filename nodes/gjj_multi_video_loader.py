from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from aiohttp import web
try:
    from server import PromptServer
except Exception:
    PromptServer = None

import folder_paths
from nodes import PreviewImage

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_MultiVideoLoader"
VIDEO_API_PATH = "/gjj/input_videos"
VIDEO_UPLOAD_API_PATH = "/gjj/upload_video"
VIDEO_META_API_PATH = "/gjj/video_meta"
UPLOAD_SUBFOLDER = "gjj_multi_video_loader"
MAX_SELECTED_VIDEOS = 20
MAX_PREVIEW_FRAMES = 16
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".wmv", ".flv", ".gif"}
ENABLED_OUTPUTS_PROPERTY = "enabled_outputs"
OPTIONAL_OUTPUT_KEYS = [
    "first_frame",
    "last_frame",
    "info_json",
    "frame_rate",
    "frame_count",
    "source_duration",
    "width",
    "height",
    "video_format",
]

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


def _video_meta_cv2(path: Path) -> dict[str, Any]:
    try:
        import cv2
    except Exception:
        return {"width": 0, "height": 0, "fps": 0.0, "frames": 0, "duration": 0.0}

    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        return {"width": 0, "height": 0, "fps": 0.0, "frames": 0, "duration": 0.0}
    try:
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    finally:
        capture.release()
    duration = float(frames / fps) if fps > 0 and frames > 0 else 0.0
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
        }
        path = resolve_input_video_path(entry)
        meta = video_meta(path)
        return web.json_response({
            "filename": path.name,
            "subfolder": entry.get("subfolder", ""),
            "label": f"{entry.get('subfolder', '')}/{path.name}" if entry.get("subfolder") else path.name,
            "type": "input",
            **meta,
        })
    except Exception as error:
        return web.json_response({"error": str(error)}, status=400)


async def upload_gjj_input_video(request):
    reader = await request.multipart()
    upload_dir = _input_dir() / UPLOAD_SUBFOLDER
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

        target = _unique_path(upload_dir, filename)
        with target.open("wb") as handle:
            while True:
                chunk = await field.read_chunk()
                if not chunk:
                    break
                handle.write(chunk)
        saved.append({"filename": target.name, "subfolder": UPLOAD_SUBFOLDER})

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
        cleaned.append({"filename": filename, "subfolder": subfolder})
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
            from_property = parse_selected_videos(properties.get("selected_videos"))
            if from_property:
                candidates.append(from_property)
    if unique_id is not None and candidates:
        return candidates[0]
    return candidates[0] if len(candidates) == 1 else []


def parse_enabled_outputs(raw_value: Any) -> list[str]:
    if raw_value is None:
        return []
    try:
        parsed = json.loads(str(raw_value or "[]"))
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    enabled: list[str] = []
    for item in parsed:
        key = str(item or "")
        if key in OPTIONAL_OUTPUT_KEYS and key not in enabled:
            enabled.append(key)
    return enabled


def recover_enabled_outputs(raw_value: Any = None, extra_pnginfo: Any = None, unique_id: Any = None) -> list[str]:
    enabled = parse_enabled_outputs(raw_value)
    if enabled:
        return enabled
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
    if unique_id is not None and candidates:
        return candidates[0]
    return candidates[0] if len(candidates) == 1 else []


def resolve_input_video_path(entry: dict[str, str]) -> Path:
    input_dir = _input_dir()
    filename = str(entry.get("filename") or "").strip()
    subfolder = str(entry.get("subfolder") or "").strip().replace("\\", "/")
    candidate = (input_dir / subfolder / filename).resolve()
    try:
        candidate.relative_to(input_dir)
    except ValueError as error:
        raise RuntimeError(f"视频路径越界：{subfolder}/{filename}") from error
    if not candidate.exists():
        raise RuntimeError(f"未找到视频：{subfolder}/{filename}")
    if candidate.suffix.lower() not in VIDEO_EXTENSIONS:
        raise RuntimeError(f"不支持的视频格式：{candidate.name}")
    return candidate


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


def _frame_to_tensor(frame: np.ndarray) -> torch.Tensor:
    array = np.asarray(frame).astype(np.float32) / 255.0
    if array.ndim == 2:
        array = np.stack([array, array, array], axis=-1)
    if array.shape[-1] == 4:
        array = array[..., :3]
    return torch.from_numpy(array[..., :3]).unsqueeze(0)


def decode_video_cv2(
    path: Path,
    start_frame: int,
    end_frame: int,
    frame_stride: int,
    max_frames: int,
    width: int = 0,
    height: int = 0,
) -> tuple[list[torch.Tensor], dict[str, Any]]:
    try:
        import cv2
    except Exception as error:
        raise RuntimeError("当前 Python 环境缺少 cv2，无法解码视频。请确认 ComfyUI 环境已安装 opencv-python。") from error

    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise RuntimeError(f"无法打开视频：{path.name}")

    try:
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        start = max(0, int(start_frame))
        stop = int(end_frame) if int(end_frame) > 0 else (total - 1 if total > 0 else 10**12)
        stop = max(start, stop)
        stride = max(1, int(frame_stride))
        limit = max(1, int(max_frames))

        if start > 0:
            capture.set(cv2.CAP_PROP_POS_FRAMES, start)

        frames: list[torch.Tensor] = []
        current = start
        while current <= stop and len(frames) < limit:
            ok, frame = capture.read()
            if not ok:
                break
            if (current - start) % stride == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                image = _frame_to_tensor(rgb)
                image = _resize_image_tensor(image, int(width), int(height))
                frames.append(image)
            current += 1
    finally:
        capture.release()

    if not frames:
        raise RuntimeError(f"未从视频读取到有效帧：{path.name}")

    duration = float(total / fps) if fps > 0 and total > 0 else 0.0
    output_width = int(frames[0].shape[2]) if frames else 0
    output_height = int(frames[0].shape[1]) if frames else 0
    return frames, {
        "fps": fps or 24.0,
        "frames": total,
        "width": source_width,
        "height": source_height,
        "output_width": output_width,
        "output_height": output_height,
        "duration": duration,
    }


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


class GJJ_MultiVideoLoader:
    CATEGORY = "GJJ"
    FUNCTION = "load_videos"
    OUTPUT_NODE = False
    DESCRIPTION = "一次选择多个 input 目录视频，按帧范围、帧率、宽高和格式参数解码为 GJJ 批量图片帧队列。"
    SEARCH_ALIASES = ["multi video loader", "video loader", "批量视频", "视频加载", "视频解码", "视频帧", "视频预览", "批量视频加载预览器"]
    # 后端只声明第一个固定输出；其它输出由前端按钮动态扩充。
    # 执行时会根据 workflow properties[enabled_outputs] 返回同顺序的附加值。
    RETURN_TYPES = (GJJ_BATCH_IMAGE_TYPE,)
    RETURN_NAMES = ("视频帧队列",)
    OUTPUT_TOOLTIPS = ("按选择顺序解码后拼接的帧序列，类型为 GJJ_BATCH_IMAGE。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "frame_rate": (
                    "FLOAT",
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
                        "step": 8,
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
                        "step": 8,
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
            },
            "optional": {
                "视频帧队列": ("GJJ_BATCH_IMAGE,IMAGE,VIDEO", {"tooltip": "非必选：可直接输入上游帧队列。接入后优先使用输入帧，未接入时读取下拉选择的视频。"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def __init__(self):
        self.preview_image = PreviewImage()

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

    def load_videos(
        self,
        frame_rate,
        width,
        height,
        video_format,
        start_frame,
        end_frame,
        frame_stride,
        max_frames,
        视频帧队列=None,
        selected_videos="[]",
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        selected = recover_selected_videos(selected_videos, extra_pnginfo, unique_id)
        enabled_outputs = recover_enabled_outputs(None, extra_pnginfo, unique_id)

        output_fps = float(frame_rate or 24.0)
        target_width = int(width or 0)
        target_height = int(height or 0)
        output_format = str(video_format or "video/h264-mp4")

        external_frames = self._coerce_external_frames(视频帧队列)
        if external_frames is not None:
            batch_output = _resize_image_tensor(external_frames, target_width, target_height)
            source_fps = output_fps
            total_duration = float(batch_output.shape[0]) / max(1e-6, output_fps)
            video_infos = [{
                "filename": "external_input",
                "subfolder": "",
                "path": "",
                "source_width": int(external_frames.shape[2]),
                "source_height": int(external_frames.shape[1]),
                "output_width": int(batch_output.shape[2]),
                "output_height": int(batch_output.shape[1]),
                "source_fps": output_fps,
                "output_fps": output_fps,
                "source_frames": int(batch_output.shape[0]),
                "duration": total_duration,
                "output_frames": int(batch_output.shape[0]),
                "video_format": output_format,
            }]
            selected_count = 0
        else:
            if not selected:
                raise RuntimeError("请先在 GJJ · 批量视频加载预览器里选择或导入视频，或接入左侧视频帧队列。")

            all_frames: list[torch.Tensor] = []
            video_infos: list[dict[str, Any]] = []
            total_duration = 0.0
            source_fps = 24.0

            for index, entry in enumerate(selected):
                path = resolve_input_video_path(entry)
                frames, meta = decode_video_cv2(
                    path,
                    int(start_frame),
                    int(end_frame),
                    int(frame_stride),
                    int(max_frames),
                    target_width,
                    target_height,
                )
                if index == 0:
                    source_fps = float(meta.get("fps") or 24.0)
                total_duration += float(meta.get("duration") or 0.0)
                all_frames.extend(frames)
                video_infos.append(
                    {
                        "filename": entry["filename"],
                        "subfolder": entry.get("subfolder", ""),
                        "path": str(path),
                        "source_width": int(meta.get("width") or 0),
                        "source_height": int(meta.get("height") or 0),
                        "output_width": int(meta.get("output_width") or 0),
                        "output_height": int(meta.get("output_height") or 0),
                        "source_fps": float(meta.get("fps") or 0.0),
                        "output_fps": output_fps,
                        "source_frames": int(meta.get("frames") or 0),
                        "duration": float(meta.get("duration") or 0.0),
                        "output_frames": len(frames),
                        "video_format": output_format,
                    }
                )

            batch_output = build_uniform_batch(all_frames)
            selected_count = len(selected)
        first_frame = batch_output[0:1].contiguous() if int(batch_output.shape[0]) > 0 else empty_image_tensor()
        last_frame = batch_output[-1:].contiguous() if int(batch_output.shape[0]) > 0 else empty_image_tensor()
        final_width = int(batch_output.shape[2]) if int(batch_output.ndim) == 4 else 0
        final_height = int(batch_output.shape[1]) if int(batch_output.ndim) == 4 else 0

        preview_entries: list[dict[str, Any]] = []
        preview_count = min(MAX_PREVIEW_FRAMES, int(batch_output.shape[0]))
        if preview_count > 0:
            indices = np.linspace(0, int(batch_output.shape[0]) - 1, preview_count, dtype=int).tolist()
            preview_tensor = torch.cat([batch_output[i:i + 1] for i in indices], dim=0)
            preview_ui = self.preview_image.save_images(
                preview_tensor,
                filename_prefix="GJJ_MultiVideoLoader",
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            preview_entries = preview_ui.get("ui", {}).get("images", [])

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
            "start_frame": int(start_frame),
            "end_frame": int(end_frame),
            "frame_stride": int(frame_stride),
            "max_frames_per_video": int(max_frames),
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
        }
        dynamic_result = [batch_output]
        for key in enabled_outputs:
            if key in optional_values:
                dynamic_result.append(optional_values[key])

        return {
            "ui": {
                "preview_images": preview_entries,
                "video_count": [selected_count],
                "frame_count": [int(batch_output.shape[0])],
                "source_fps": [float(source_fps)],
                "frame_rate": [float(output_fps)],
                "width": [int(final_width)],
                "height": [int(final_height)],
                "video_format": [output_format],
            },
            "result": tuple(dynamic_result),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MultiVideoLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🧡·🎬 批量多视频加载预览器"}
