from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    from .gjj_video_combine_runtime import get_ffmpeg_path
except Exception:
    try:
        from gjj_video_combine_runtime import get_ffmpeg_path
    except Exception:
        get_ffmpeg_path = None

try:
    import comfy.model_management as model_management
except Exception:
    model_management = None

try:
    from comfy.utils import ProgressBar
except Exception:
    ProgressBar = None


NODE_NAME = "GJJ_ImageConcanate"
MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,MASK,VIDEO"
IMAGE_PREFIX = "media_"
DIRECTIONS = ("right", "down", "left", "up", "square")
DIRECTION_LABELS = {
    "up": "向上",
    "down": "向下",
    "left": "向左",
    "right": "向右",
    "square": "方形",
}
BLACK_PLACEHOLDER_EPSILON = 1e-6
CUDA_HEADROOM = 0.82
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv", ".mpeg", ".mpg"}
MEDIA_KEYS = ("images", "frames", "image", "samples", "items", "queue", "batch")


class FlexibleMediaInputs(dict):
    def __getitem__(self, key):
        if str(key or "").startswith(IMAGE_PREFIX):
            return (
                MEDIA_TYPE,
                {
                    "display_name": "媒体输入",
                    "tooltip": "连接 GJJ_BATCH_IMAGE、IMAGE、MASK 或 VIDEO；连接后会自动扩展下一个输入口。",
                },
            )
        return super().__getitem__(key)

    def __contains__(self, key):
        return str(key or "").startswith(IMAGE_PREFIX) or super().__contains__(key)


def _input_index(name: str) -> int:
    text = str(name or "")
    if not text.startswith(IMAGE_PREFIX):
        return 999999
    try:
        return int(text[len(IMAGE_PREFIX):])
    except Exception:
        return 999999


def _single_value(value: Any, default: Any = None) -> Any:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    return default if value is None else value


def _extract_video_frames(value: Any) -> Any:
    if hasattr(value, "get_components"):
        return value
    if isinstance(value, dict):
        for key in ("frames", "images", "image", "samples"):
            item = value.get(key)
            if item is not None:
                return item
    for attr in ("frames", "images", "image", "samples"):
        if hasattr(value, attr):
            item = getattr(value, attr)
            if item is not None:
                return item
    return value


def _input_root() -> Path:
    if folder_paths is not None:
        return Path(folder_paths.get_input_directory()).resolve()
    return Path.cwd().resolve()


def _output_root() -> Path:
    if folder_paths is not None:
        return Path(folder_paths.get_output_directory()).resolve()
    return (Path.cwd() / "output").resolve()


def _temp_root() -> Path:
    if folder_paths is not None:
        return Path(folder_paths.get_temp_directory()).resolve()
    return (Path.cwd() / "temp").resolve()


def _as_path_from_text(value: Any) -> Path | None:
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
        found = _as_path_from_text(value.get(key))
        if found:
            return found
    filename = str(value.get("filename") or "").strip()
    if not filename:
        return None
    subfolder = str(value.get("subfolder") or "").strip().replace("\\", "/")
    item_type = str(value.get("type") or "input").strip().lower()
    root = _temp_root() if item_type == "temp" else _output_root() if item_type == "output" else _input_root()
    return _as_path_from_text(root / subfolder / filename)


def _video_path(value: Any) -> Path | None:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    found = _path_from_comfy_item(value)
    if found:
        return found
    if isinstance(value, dict):
        for key in ("video", "source", "stream_source", "value", "selected", "filename", "file"):
            found = _video_path(value.get(key))
            if found:
                return found
    for method_name in ("get_stream_source", "get_filename", "get_filepath", "get_path", "path"):
        method = getattr(value, method_name, None)
        if callable(method):
            try:
                found = _video_path(method())
            except Exception:
                found = None
            if found:
                return found
    for attr in ("stream_source", "source", "source_path", "filepath", "file_path", "filename", "path", "_path", "_filename"):
        candidate = getattr(value, attr, None)
        if candidate is not None and candidate is not value:
            found = _video_path(candidate)
            if found:
                return found
    if isinstance(value, (str, os.PathLike)):
        return _as_path_from_text(value)
    return None


def _ffmpeg_exe() -> str:
    if get_ffmpeg_path is not None:
        try:
            found = get_ffmpeg_path()
            if found:
                return str(found)
        except Exception:
            pass
    return shutil.which("ffmpeg") or "ffmpeg"


def _ffprobe_exe(ffmpeg_path: str) -> str:
    ffmpeg_file = Path(ffmpeg_path)
    if ffmpeg_file.name.lower().startswith("ffmpeg"):
        probe_name = "ffprobe.exe" if ffmpeg_file.suffix.lower() == ".exe" else "ffprobe"
        candidate = ffmpeg_file.with_name(probe_name)
        if candidate.exists():
            return str(candidate)
    return shutil.which("ffprobe") or "ffprobe"


def _probe_video(path: Path, ffprobe_path: str) -> tuple[int, int, float]:
    command = [
        ffprobe_path,
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate",
        "-of", "default=noprint_wrappers=1:nokey=0",
        str(path),
    ]
    try:
        proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=10)
        if proc.returncode != 0:
            return 0, 0, 0.0
        data = {}
        for line in (proc.stdout or "").splitlines():
            if "=" in line:
                key, raw = line.split("=", 1)
                data[key.strip()] = raw.strip()
        width = int(float(data.get("width") or 0))
        height = int(float(data.get("height") or 0))
        fps = _ratio_to_float(data.get("avg_frame_rate")) or _ratio_to_float(data.get("r_frame_rate"))
        return width, height, fps
    except Exception:
        return 0, 0, 0.0


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


def _video_components(value: Any) -> dict[str, Any] | None:
    if not hasattr(value, "get_components"):
        return None
    try:
        components = value.get_components()
    except Exception:
        return None
    if isinstance(components, dict):
        return components
    return {key: _component_value(components, key) for key in ("images", "frames", "audio", "frame_rate")}


def _safe_name(text: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(text or "concat")).strip(" ._")
    return name or "concat"


def _video_output_path() -> Path:
    root = _temp_root() / "GJJ" / "video_concat"
    root.mkdir(parents=True, exist_ok=True)
    handle, raw_path = tempfile.mkstemp(prefix=f"{_safe_name(NODE_NAME)}_", suffix=".mp4", dir=root)
    os.close(handle)
    try:
        os.remove(raw_path)
    except OSError:
        pass
    return Path(raw_path)


def _ordered_video_paths(items: list[Any], direction: str) -> list[Path] | None:
    paths = [_video_path(item) for item in items]
    if not paths or any(path is None for path in paths):
        return None
    direction = direction if direction in DIRECTIONS else "right"
    ordered = [path for path in paths if path is not None]
    if direction in {"left", "up"}:
        ordered.reverse()
    return ordered


def _concat_video_files(items: list[Any], direction: str, match_image_size: bool):
    ordered_paths = _ordered_video_paths(items, direction)
    if not ordered_paths:
        return None
    if len(ordered_paths) == 1:
        return _video_from_file(ordered_paths[0])

    ffmpeg_path = _ffmpeg_exe()
    ffprobe_path = _ffprobe_exe(ffmpeg_path)
    infos = [_probe_video(path, ffprobe_path) for path in ordered_paths]
    if any(width <= 0 or height <= 0 for width, height, _fps in infos):
        raise RuntimeError("GJJ 视频拼接失败：无法读取输入视频尺寸，请确认 ffprobe 可用且视频文件完整。")

    horizontal = direction in {"right", "left"}
    first_w, first_h, first_fps = infos[0]
    max_w = max(width for width, _height, _fps in infos)
    max_h = max(height for _width, height, _fps in infos)
    parts: list[str] = []
    labels: list[str] = []
    for index, (_width, _height, _fps) in enumerate(infos):
        label = f"v{index}"
        labels.append(f"[{label}]")
        if bool(match_image_size):
            if horizontal:
                parts.append(f"[{index}:v]scale=-2:{first_h},setsar=1[{label}]")
            else:
                parts.append(f"[{index}:v]scale={first_w}:-2,setsar=1[{label}]")
        elif horizontal:
            parts.append(f"[{index}:v]pad=iw:{max_h}:0:(oh-ih)/2:color=black,setsar=1[{label}]")
        else:
            parts.append(f"[{index}:v]pad={max_w}:ih:(ow-iw)/2:0:color=black,setsar=1[{label}]")
    stack = "hstack" if horizontal else "vstack"
    parts.append(f"{''.join(labels)}{stack}=inputs={len(labels)}:shortest=1,format=yuv420p[vout]")
    output_path = _video_output_path()
    command = [ffmpeg_path, "-hide_banner", "-loglevel", "error", "-y"]
    for path in ordered_paths:
        command.extend(["-i", str(path)])
    command.extend([
        "-filter_complex", ";".join(parts),
        "-map", "[vout]",
        "-an",
        "-r", f"{first_fps or 24:g}",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-movflags", "+faststart",
        str(output_path),
    ])
    try:
        proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="ignore")
    except FileNotFoundError as exc:
        raise RuntimeError("GJJ 视频拼接失败：未找到 ffmpeg。请安装 ffmpeg 或确保 imageio_ffmpeg 可用。") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "ffmpeg 执行失败").strip()
        raise RuntimeError(f"GJJ 视频拼接失败：{detail}")
    return _video_from_file(output_path)


def _as_media_tensor(value: Any) -> torch.Tensor | None:
    value = _extract_video_frames(value)
    if not torch.is_tensor(value):
        return None
    tensor = value.detach()
    if tensor.dim() == 2:
        tensor = tensor.unsqueeze(0)
    if tensor.dim() == 3 and int(tensor.shape[-1]) in (1, 2, 3, 4) and int(tensor.shape[0]) not in (1, 2, 3, 4):
        tensor = tensor.unsqueeze(0)
    if tensor.dim() == 4 and int(tensor.shape[-1]) not in (1, 2, 3, 4) and int(tensor.shape[1]) in (1, 2, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    if tensor.dim() not in (3, 4):
        return None
    return tensor.to(device=torch.device("cpu"), dtype=torch.float32, copy=False).clamp(0.0, 1.0)


def _media_tensors_recursive(value: Any, seen: set[int] | None = None, depth: int = 0) -> list[torch.Tensor]:
    if value is None or depth > 24:
        return []
    seen = seen if seen is not None else set()
    if isinstance(value, (str, bytes, os.PathLike)):
        return []
    if not torch.is_tensor(value):
        value_id = id(value)
        if value_id in seen:
            return []
        seen.add(value_id)

    tensor = _as_media_tensor(value)
    if tensor is not None:
        return [tensor]

    components = _video_components(value)
    if components is not None:
        tensors: list[torch.Tensor] = []
        for key in MEDIA_KEYS:
            tensors.extend(_media_tensors_recursive(components.get(key), seen, depth + 1))
        return tensors

    if isinstance(value, dict):
        tensors: list[torch.Tensor] = []
        for key in MEDIA_KEYS:
            tensors.extend(_media_tensors_recursive(value.get(key), seen, depth + 1))
        return tensors

    if isinstance(value, (list, tuple)):
        tensors: list[torch.Tensor] = []
        for item in value:
            tensors.extend(_media_tensors_recursive(item, seen, depth + 1))
        return tensors

    tensors = []
    for key in MEDIA_KEYS:
        if hasattr(value, key):
            tensors.extend(_media_tensors_recursive(getattr(value, key, None), seen, depth + 1))
    return tensors


def _media_frames(value: Any) -> list[torch.Tensor]:
    tensors = _media_tensors_recursive(value)
    frames: list[torch.Tensor] = []
    for tensor in tensors:
        if tensor is None:
            continue
        if tensor.dim() == 4:
            frames.extend(tensor[index:index + 1] for index in range(int(tensor.shape[0])))
        elif tensor.dim() == 3:
            frames.extend(tensor[index:index + 1] for index in range(int(tensor.shape[0])))
        else:
            frames.append(tensor)
    return [frame for frame in frames if not _is_black_placeholder(frame)]


def _is_black_placeholder(tensor: torch.Tensor) -> bool:
    if tensor.numel() == 0:
        return True
    if not torch.is_floating_point(tensor):
        tensor = tensor.float()
    try:
        max_value = float(tensor.detach().abs().amax().cpu())
    except Exception:
        return False
    return max_value <= BLACK_PLACEHOLDER_EPSILON


def _intermediate_device():
    return torch.device("cpu")


def _intermediate_dtype():
    return torch.float32


def _concat_device(input_numel: int, output_numel: int):
    return torch.device("cpu")


def _torch_device():
    return torch.device("cpu")


def _resize_frame(frame: torch.Tensor, height: int, width: int) -> torch.Tensor:
    frame = frame.detach().to(device=torch.device("cpu"), dtype=torch.float32, copy=False)
    frame = frame.permute(0, 3, 1, 2)
    resized = F.interpolate(frame, size=(height, width), mode="bicubic", antialias=True)
    return resized.permute(0, 2, 3, 1).clamp(0.0, 1.0)


def _release_cuda_cache():
    if not torch.cuda.is_available():
        return
    try:
        torch.cuda.empty_cache()
    except Exception:
        pass
    if model_management is not None:
        try:
            model_management.soft_empty_cache()
        except Exception:
            pass


def _convert_to_base_type(base: torch.Tensor, other: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, bool]:
    output_is_mask = base.dim() == 3
    if output_is_mask and other.dim() == 4:
        channels = min(3, int(other.shape[-1]))
        other = other[..., :channels].mean(dim=-1)
    elif not output_is_mask and other.dim() == 3:
        channels = int(base.shape[-1])
        other = other.unsqueeze(-1).expand(-1, -1, -1, channels)
    if output_is_mask:
        base = base.unsqueeze(-1)
        other = other.unsqueeze(-1)
    return base, other, output_is_mask


def _write(dst: torch.Tensor, src: torch.Tensor, src_channels: int):
    src = src.to(device=dst.device, dtype=dst.dtype, non_blocking=True, copy=False)
    if dst.shape[-1] == src_channels:
        dst.copy_(src)
        return
    dst[..., :src_channels].copy_(src)
    dst[..., src_channels:].fill_(1.0)


def _concat_pair(base: torch.Tensor, other: torch.Tensor, direction: str, match_image_size: bool, first_shape=None) -> torch.Tensor:
    direction = direction if direction in DIRECTIONS else "right"
    base, other, output_is_mask = _convert_to_base_type(base, other)

    bs1 = int(base.shape[0])
    bs2 = int(other.shape[0])
    batch = max(bs1, bs2)

    h1, w1 = int(base.shape[1]), int(base.shape[2])
    c1, c2 = int(base.shape[-1]), int(other.shape[-1])
    out_channels = max(c1, c2)

    if match_image_size:
        target_shape = first_shape if first_shape is not None else base.shape
        aspect = float(other.shape[2]) / max(1.0, float(other.shape[1]))
        if direction in ("left", "right"):
            h2 = int(target_shape[1])
            w2 = max(1, int(round(h2 * aspect)))
        else:
            w2 = int(target_shape[2])
            h2 = max(1, int(round(w2 / aspect)))
    else:
        h2, w2 = int(other.shape[1]), int(other.shape[2])

    if direction in ("right", "left"):
        out_h, out_w = max(h1, h2), w1 + w2
    else:
        out_h, out_w = h1 + h2, max(w1, w2)

    if direction == "right":
        y1, x1, y2, x2 = (out_h - h1) // 2, 0, (out_h - h2) // 2, w1
    elif direction == "left":
        y1, x1, y2, x2 = (out_h - h1) // 2, w2, (out_h - h2) // 2, 0
    elif direction == "down":
        y1, x1, y2, x2 = 0, (out_w - w1) // 2, h1, (out_w - w2) // 2
    else:
        y1, x1, y2, x2 = h2, (out_w - w1) // 2, 0, (out_w - w2) // 2

    output_shape = (batch, out_h, out_w, out_channels)
    output = torch.zeros(
        output_shape,
        dtype=_intermediate_dtype(),
        device=_concat_device(int(base.numel()) + int(other.numel()), math.prod(output_shape)),
    )

    slot1 = output[:, y1:y1 + h1, x1:x1 + w1, :]
    if bs1 == batch:
        _write(slot1, base, c1)
    else:
        _write(slot1[:bs1], base, c1)
        _write(slot1[bs1:], base[-1:].expand(batch - bs1, -1, -1, -1), c1)

    slot2 = output[:, y2:y2 + h2, x2:x2 + w2, :]
    if match_image_size:
        pbar = ProgressBar(batch) if ProgressBar is not None else None
        device = _torch_device()
        for index in range(batch):
            src_index = min(index, bs2 - 1)
            frame = other[src_index:src_index + 1].to(device, non_blocking=True)
            resized = _resize_frame(frame, h2, w2)
            _write(slot2[index:index + 1], resized, c2)
            if pbar is not None:
                pbar.update(1)
    elif bs2 == batch:
        _write(slot2, other, c2)
    else:
        _write(slot2[:bs2], other, c2)
        _write(slot2[bs2:], other[-1:].expand(batch - bs2, -1, -1, -1), c2)

    return output.squeeze(-1) if output_is_mask else output


def _grid_shape(count: int, cell_height: int, cell_width: int) -> tuple[int, int]:
    count = max(1, int(count))
    best_rows = 1
    best_cols = count
    best_score = float("inf")
    for cols in range(1, count + 1):
        rows = int(math.ceil(count / cols))
        empty = rows * cols - count
        score = abs(rows - cols) * 10 + empty
        if score < best_score:
            best_score = score
            best_cols = cols
            best_rows = rows
    return best_rows, best_cols


def _as_base_media(tensor: torch.Tensor, output_is_mask: bool, image_channels: int) -> torch.Tensor:
    if output_is_mask:
        if tensor.dim() == 4:
            channels = min(3, int(tensor.shape[-1]))
            tensor = tensor[..., :channels].mean(dim=-1)
        return tensor.unsqueeze(-1)
    if tensor.dim() == 3:
        tensor = tensor.unsqueeze(-1).expand(-1, -1, -1, image_channels)
    return tensor


def _write_grid_slot(
    output: torch.Tensor,
    slot: torch.Tensor,
    tensor: torch.Tensor,
    src_channels: int,
    batch: int,
    match_image_size: bool,
    target_height: int,
    target_width: int,
    progress: Any,
):
    if match_image_size:
        device = _torch_device()
        for index in range(batch):
            src_index = min(index, int(tensor.shape[0]) - 1)
            frame = tensor[src_index:src_index + 1].to(device, non_blocking=True)
            src_height, src_width = int(frame.shape[1]), int(frame.shape[2])
            scale = min(target_width / max(1.0, float(src_width)), target_height / max(1.0, float(src_height)))
            resize_height = max(1, min(target_height, int(round(src_height * scale))))
            resize_width = max(1, min(target_width, int(round(src_width * scale))))
            resized = _resize_frame(frame, resize_height, resize_width)
            y = max(0, (target_height - resize_height) // 2)
            x = max(0, (target_width - resize_width) // 2)
            _write(slot[index:index + 1, y:y + resize_height, x:x + resize_width, :], resized, src_channels)
            if progress is not None:
                progress.update(1)
        return

    src_height, src_width = int(tensor.shape[1]), int(tensor.shape[2])
    y = (target_height - src_height) // 2
    x = (target_width - src_width) // 2
    dst = output[:, y:y + src_height, x:x + src_width, :]
    if int(tensor.shape[0]) == batch:
        _write(dst, tensor, src_channels)
    else:
        _write(dst[: int(tensor.shape[0])], tensor, src_channels)
        _write(dst[int(tensor.shape[0]):], tensor[-1:].expand(batch - int(tensor.shape[0]), -1, -1, -1), src_channels)


def _concat_square(media_items: list[torch.Tensor], match_image_size: bool) -> torch.Tensor:
    first = media_items[0]
    output_is_mask = first.dim() == 3
    image_channels = 1 if output_is_mask else int(first.shape[-1])
    items = [_as_base_media(tensor, output_is_mask, image_channels) for tensor in media_items]

    batch = max(int(tensor.shape[0]) for tensor in items)
    out_channels = max(int(tensor.shape[-1]) for tensor in items)
    input_numel = sum(int(tensor.numel()) for tensor in items)

    if match_image_size:
        cell_height = int(items[0].shape[1])
        cell_width = int(items[0].shape[2])
    else:
        cell_height = max(int(tensor.shape[1]) for tensor in items)
        cell_width = max(int(tensor.shape[2]) for tensor in items)

    rows, cols = _grid_shape(len(items), cell_height, cell_width)
    output_shape = (batch, rows * cell_height, cols * cell_width, out_channels)
    output = torch.zeros(
        output_shape,
        dtype=_intermediate_dtype(),
        device=_concat_device(input_numel, math.prod(output_shape)),
    )
    progress = ProgressBar(batch * len(items)) if match_image_size and ProgressBar is not None else None

    for index, tensor in enumerate(items):
        row = index // cols
        col = index % cols
        slot = output[
            :,
            row * cell_height:(row + 1) * cell_height,
            col * cell_width:(col + 1) * cell_width,
            :,
        ]
        _write_grid_slot(
            output=slot,
            slot=slot,
            tensor=tensor,
            src_channels=int(tensor.shape[-1]),
            batch=batch,
            match_image_size=match_image_size,
            target_height=cell_height,
            target_width=cell_width,
            progress=progress,
        )

    return output.squeeze(-1) if output_is_mask else output


class GJJ_ImageConcanate:
    CATEGORY = "GJJ/图像"
    FUNCTION = "concatenate"
    DESCRIPTION = "GJJ 零依赖媒体拼接节点：动态接收 GJJ_BATCH_IMAGE、IMAGE、MASK、VIDEO，按方向依次拼接，可选择匹配首图尺寸。"
    SEARCH_ALIASES = ["image concatenate", "image concat", "图片拼接", "图像拼接", "媒体拼接", "ImageConcanate"]
    INPUT_IS_LIST = True
    RETURN_TYPES = (MEDIA_TYPE,)
    RETURN_NAMES = ("拼接结果",)
    OUTPUT_TOOLTIPS = ("按输入顺序拼接后的结果；首个有效输入是 MASK 时输出 MASK，否则输出 IMAGE/GJJ 批量图片。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "direction": (
                    DIRECTIONS,
                    {
                        "default": "right",
                        "display_name": "拼接方向",
                        "tooltip": "第二张及之后的媒体相对当前结果放置的方向；方形模式会按输入顺序排成尽量接近正方形的网格；前端按钮会同步这个值。",
                    },
                ),
                "match_image_size": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "匹配首图尺寸",
                        "tooltip": "开启后后续媒体会按首个输入的共享边缩放并保持比例；关闭时尺寸不一致会居中补黑。",
                    },
                ),
            },
            "optional": FlexibleMediaInputs(),
        }

    def concatenate(self, direction="right", match_image_size=True, **kwargs):
        direction = str(_single_value(direction, "right"))
        match_image_size = bool(_single_value(match_image_size, True))
        raw_items: list[Any] = []
        media_items: list[torch.Tensor] = []
        with torch.inference_mode():
            for key in sorted(kwargs.keys(), key=_input_index):
                if not str(key).startswith(IMAGE_PREFIX):
                    continue
                raw_value = kwargs.get(key)
                if raw_value is None:
                    continue
                raw_items.append(raw_value)
                media_items.extend(_media_frames(raw_value))
            _release_cuda_cache()

            if direction != "square":
                video_result = _concat_video_files(raw_items, str(direction), bool(match_image_size))
                if video_result is not None:
                    return (video_result,)

            if not media_items:
                raise RuntimeError("GJJ 图片/视频拼接失败：未解析到可用媒体。若输入是 VIDEO，请确认它来自 Load Video 或包含可访问的视频文件路径。")

            if direction == "square":
                return (_concat_square(media_items, bool(match_image_size)),)

            result = media_items[0]
            first_shape = result.shape
            for tensor in media_items[1:]:
                result = _concat_pair(result, tensor, str(direction), bool(match_image_size), first_shape=first_shape)
            return (result,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageConcanate}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧩 图片、视频拼接（简易）"}
