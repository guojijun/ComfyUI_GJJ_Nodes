from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import torch
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
UPLOAD_SUBFOLDER = "gjj_multi_video_loader"
MAX_SELECTED_VIDEOS = 20
MAX_PREVIEW_FRAMES = 16
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".wmv", ".flv", ".gif"}


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
        meta = _video_meta_cv2(file_path)
        items.append(
            {
                "filename": file_path.name,
                "subfolder": subfolder,
                "label": f"{subfolder}/{file_path.name}" if subfolder else file_path.name,
                **meta,
            }
        )
    return items


async def get_gjj_input_videos(request):
    return web.json_response({"videos": list_input_videos()})


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


def decode_video_cv2(path: Path, start_frame: int, end_frame: int, frame_stride: int, max_frames: int) -> tuple[list[torch.Tensor], dict[str, Any]]:
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
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
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
                frames.append(_frame_to_tensor(rgb))
            current += 1
    finally:
        capture.release()

    if not frames:
        raise RuntimeError(f"未从视频读取到有效帧：{path.name}")

    duration = float(total / fps) if fps > 0 and total > 0 else 0.0
    return frames, {"fps": fps or 24.0, "frames": total, "width": width, "height": height, "duration": duration}


class GJJ_MultiVideoLoader:
    CATEGORY = "GJJ"
    FUNCTION = "load_videos"
    OUTPUT_NODE = False
    DESCRIPTION = "一次选择多个 input 目录视频，按帧范围和抽帧间隔解码为 GJJ 批量图片帧队列，可直接连接 GJJ 视频合成器、插帧器或放大器。"
    SEARCH_ALIASES = ["multi video loader", "video loader", "批量视频", "视频加载", "视频解码", "视频帧", "视频预览", "批量视频加载预览器"]
    RETURN_TYPES = (GJJ_BATCH_IMAGE_TYPE, "IMAGE", "IMAGE", "STRING", "FLOAT", "INT", "FLOAT")
    RETURN_NAMES = ("视频帧队列", "首帧预览", "尾帧预览", "视频信息JSON", "源帧率", "输出帧数", "源时长")
    OUTPUT_TOOLTIPS = (
        "按选择顺序解码后拼接的帧序列，类型为 GJJ_BATCH_IMAGE，可直接接入 GJJ · 视频合成器。",
        "输出帧队列的第一帧，便于连接首帧参考。",
        "输出帧队列的最后一帧，便于连接尾帧参考。",
        "包含已选视频路径、原始尺寸、帧率、总帧数、输出帧数等信息的 JSON。",
        "第一个视频的原始帧率；多个不同帧率视频拼接时以信息 JSON 为准。",
        "本次实际输出的总帧数。",
        "已选视频原始时长合计，单位秒。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "start_frame": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 999999,
                        "step": 1,
                        "display_name": "起始帧",
                        "tooltip": "从第几帧开始读取；0 表示从第一帧开始。",
                    },
                ),
                "end_frame": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 999999,
                        "step": 1,
                        "display_name": "结束帧",
                        "tooltip": "读取到第几帧结束；0 表示读取到视频末尾或达到最大帧数。",
                    },
                ),
                "frame_stride": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 1000,
                        "step": 1,
                        "display_name": "抽帧间隔",
                        "tooltip": "每隔多少帧取一帧；1 表示不跳帧。",
                    },
                ),
                "max_frames": (
                    "INT",
                    {
                        "default": 240,
                        "min": 1,
                        "max": 100000,
                        "step": 1,
                        "display_name": "最大帧数",
                        "tooltip": "每个视频最多解码多少帧，防止超长视频一次占用过多内存。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def __init__(self):
        self.preview_image = PreviewImage()

    def load_videos(
        self,
        start_frame,
        end_frame,
        frame_stride,
        max_frames,
        selected_videos="[]",
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        selected = recover_selected_videos(selected_videos, extra_pnginfo, unique_id)
        if not selected:
            raise RuntimeError("请先在 GJJ · 批量视频加载预览器里选择或导入视频。")

        all_frames: list[torch.Tensor] = []
        video_infos: list[dict[str, Any]] = []
        total_duration = 0.0
        source_fps = 24.0

        for index, entry in enumerate(selected):
            path = resolve_input_video_path(entry)
            frames, meta = decode_video_cv2(path, int(start_frame), int(end_frame), int(frame_stride), int(max_frames))
            if index == 0:
                source_fps = float(meta.get("fps") or 24.0)
            total_duration += float(meta.get("duration") or 0.0)
            all_frames.extend(frames)
            video_infos.append(
                {
                    "filename": entry["filename"],
                    "subfolder": entry.get("subfolder", ""),
                    "path": str(path),
                    "width": int(meta.get("width") or 0),
                    "height": int(meta.get("height") or 0),
                    "fps": float(meta.get("fps") or 0.0),
                    "source_frames": int(meta.get("frames") or 0),
                    "duration": float(meta.get("duration") or 0.0),
                    "output_frames": len(frames),
                }
            )

        batch_output = build_uniform_batch(all_frames)
        first_frame = batch_output[0:1].contiguous() if int(batch_output.shape[0]) > 0 else empty_image_tensor()
        last_frame = batch_output[-1:].contiguous() if int(batch_output.shape[0]) > 0 else empty_image_tensor()

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
            "selection_count": len(selected),
            "output_frames": int(batch_output.shape[0]),
            "source_fps": source_fps,
            "total_source_duration": total_duration,
            "start_frame": int(start_frame),
            "end_frame": int(end_frame),
            "frame_stride": int(frame_stride),
            "max_frames_per_video": int(max_frames),
        }

        return {
            "ui": {
                "preview_images": preview_entries,
                "video_count": [len(selected)],
                "frame_count": [int(batch_output.shape[0])],
                "source_fps": [float(source_fps)],
            },
            "result": (
                batch_output,
                first_frame,
                last_frame,
                json.dumps(info, ensure_ascii=False, indent=2),
                float(source_fps),
                int(batch_output.shape[0]),
                float(total_duration),
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MultiVideoLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🧡·🎬 批量多视频加载预览器"}
