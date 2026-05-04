from __future__ import annotations

import json
import os
import re
import wave
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image

try:
    from .gjj_video_combine_runtime import DEFAULT_FRAME_RATE, DEFAULT_FORMAT, combine_video
except Exception:
    DEFAULT_FRAME_RATE = 24
    DEFAULT_FORMAT = "video/h264-mp4"
    combine_video = None

try:
    import folder_paths
except Exception:
    folder_paths = None


NODE_NAME = "GJJ_SaveAnyObject"
INPUT_PREFIX = "any_"
DEFAULT_FILENAME_PREFIX = "GJJ/任意对象"


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    def __init__(self, input_type, data: dict[str, Any] | None = None):
        super().__init__()
        self.input_type = input_type
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        text = str(key or "")
        if text.startswith(INPUT_PREFIX):
            return (
                self.input_type,
                {
                    "display_name": "保存对象",
                    "tooltip": "可接任意类型；节点会根据对象类型自动保存为视频、图片、音频、文本、JSON、Tensor 或对象摘要。",
                },
            )
        raise KeyError(key)

    def __contains__(self, key):
        return key in self.data or str(key or "").startswith(INPUT_PREFIX)


any_type = AnyType("*")


def _extract_input_index(name: str) -> int:
    text = str(name or "")
    if not text.startswith(INPUT_PREFIX):
        return 999999
    try:
        return int(text[len(INPUT_PREFIX):])
    except Exception:
        return 999999


def _is_none(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, dict) and value and all(item is None for item in value.values()):
        return True
    return False


def _output_root() -> Path:
    if folder_paths is not None:
        return Path(folder_paths.get_output_directory()).resolve()
    return Path.cwd().resolve() / "output"


def _sanitize_part(part: str) -> str:
    text = re.sub(r'[<>:"|?*\x00-\x1f]', "_", str(part or "").strip())
    text = text.replace("\\", "/")
    text = re.sub(r"/+", "/", text)
    return text.strip(" /.")


def _resolve_prefix(filename_prefix: str) -> tuple[Path, str]:
    raw = _sanitize_part(filename_prefix or DEFAULT_FILENAME_PREFIX)
    if not raw:
        raw = DEFAULT_FILENAME_PREFIX
    parts = [part for part in raw.split("/") if part and part not in {".", ".."}]
    if not parts:
        parts = ["GJJ", "任意对象"]
    base_name = parts[-1]
    subfolder = Path(*parts[:-1]) if len(parts) > 1 else Path()
    directory = (_output_root() / subfolder).resolve()
    root = _output_root()
    try:
        directory.relative_to(root)
    except ValueError as error:
        raise RuntimeError(f"文件名前缀越界：{filename_prefix}") from error
    directory.mkdir(parents=True, exist_ok=True)
    return directory, base_name


def _next_path(directory: Path, base_name: str, suffix: str) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = _sanitize_part(base_name) or "任意对象"
    candidate = directory / f"{stem}_{timestamp}{suffix}"
    index = 1
    while candidate.exists():
        candidate = directory / f"{stem}_{timestamp}_{index:03d}{suffix}"
        index += 1
    return candidate


def _indexed_path(directory: Path, base_name: str, input_index: int, suffix: str, frame_index: int | None = None) -> Path:
    stem = f"{_sanitize_part(base_name) or '任意对象'}_{input_index:02d}"
    if frame_index is not None:
        stem = f"{stem}_{frame_index:04d}"
    return _next_path(directory, stem, suffix)


def _normalize_default_prefix(value: str) -> str:
    return _sanitize_part(value).replace("\\", "/").strip("/")


def _should_use_source_prefix(filename_prefix: str) -> bool:
    normalized = _normalize_default_prefix(filename_prefix or "")
    return normalized in {"", _normalize_default_prefix(DEFAULT_FILENAME_PREFIX), "任意对象"}


def _source_prefix(source_name: str) -> str:
    clean_name = _sanitize_part(source_name)
    if not clean_name:
        return DEFAULT_FILENAME_PREFIX
    return f"GJJ/{clean_name}"


def _workflow_node_names(extra_pnginfo: Any) -> dict[str, str]:
    if not isinstance(extra_pnginfo, dict):
        return {}
    workflow = extra_pnginfo.get("workflow")
    if not isinstance(workflow, dict):
        return {}
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return {}
    names: dict[str, str] = {}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        if node_id is None:
            continue
        title = node.get("title") or node.get("label") or node.get("type")
        if title:
            names[str(node_id)] = str(title)
    return names


def _resolve_input_source_names(prompt: Any, extra_pnginfo: Any, unique_id: Any) -> dict[str, str]:
    if not isinstance(prompt, dict) or unique_id is None:
        return {}
    current = prompt.get(str(unique_id)) or prompt.get(unique_id)
    if not isinstance(current, dict):
        return {}
    inputs = current.get("inputs")
    if not isinstance(inputs, dict):
        return {}
    workflow_names = _workflow_node_names(extra_pnginfo)
    source_names: dict[str, str] = {}
    for input_name, link in inputs.items():
        if not str(input_name).startswith(INPUT_PREFIX):
            continue
        if not isinstance(link, (list, tuple)) or not link:
            continue
        source_id = str(link[0])
        source_node = prompt.get(source_id) or prompt.get(link[0])
        source_name = workflow_names.get(source_id)
        if not source_name and isinstance(source_node, dict):
            source_name = str(source_node.get("class_type") or "")
        if source_name:
            source_names[str(input_name)] = source_name
    return source_names


def _json_default(value: Any):
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, torch.Tensor):
        return {
            "type": "Tensor",
            "shape": list(value.shape),
            "dtype": str(value.dtype),
            "device": str(value.device),
        }
    if isinstance(value, np.ndarray):
        return {
            "type": "ndarray",
            "shape": list(value.shape),
            "dtype": str(value.dtype),
        }
    if isinstance(value, (set, tuple)):
        return list(value)
    return repr(value)


def _write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(text), encoding=encoding)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")


def _tensor_to_uint8_image(tensor: torch.Tensor) -> np.ndarray:
    value = tensor.detach().cpu().float()
    if value.ndim == 2:
        array = value.numpy()
        return np.clip(array * 255.0, 0, 255).astype(np.uint8)
    if value.ndim == 3 and value.shape[0] in (1, 3, 4) and value.shape[-1] not in (1, 3, 4):
        value = value.movedim(0, -1)
    if value.ndim == 3 and value.shape[-1] in (1, 3, 4):
        array = value.numpy()
        if array.shape[-1] == 1:
            array = array[..., 0]
        return np.clip(array * 255.0, 0, 255).astype(np.uint8)
    raise RuntimeError(f"无法把 Tensor 作为图片保存，形状为 {tuple(tensor.shape)}。")


def _is_image_tensor(value: Any) -> bool:
    if not isinstance(value, torch.Tensor):
        return False
    shape = tuple(value.shape)
    return (
        (len(shape) == 4 and shape[-1] in (1, 3, 4))
        or (len(shape) == 3 and shape[-1] in (1, 3, 4))
        or (len(shape) == 3 and shape[0] in (1, 3, 4))
    )


def _is_mask_tensor(value: Any) -> bool:
    return isinstance(value, torch.Tensor) and value.ndim in (2, 3) and not _is_image_tensor(value)


def _split_image_tensor(value: torch.Tensor) -> list[torch.Tensor]:
    tensor = value.detach()
    if tensor.ndim == 4:
        return [tensor[index] for index in range(int(tensor.shape[0]))]
    return [tensor]


def _save_image_tensor(value: torch.Tensor, directory: Path, base_name: str, input_index: int) -> list[str]:
    paths: list[str] = []
    frames = _split_image_tensor(value)
    for frame_index, frame in enumerate(frames, start=1):
        path = _indexed_path(directory, base_name, input_index, ".png", frame_index if len(frames) > 1 else None)
        Image.fromarray(_tensor_to_uint8_image(frame)).save(path)
        paths.append(str(path))
    return paths


def _save_mask_tensor(value: torch.Tensor, directory: Path, base_name: str, input_index: int) -> list[str]:
    tensor = value.detach().cpu().float()
    if tensor.ndim == 2:
        frames = [tensor]
    elif tensor.ndim == 3:
        frames = [tensor[index] for index in range(int(tensor.shape[0]))]
    else:
        return _save_tensor(value, directory, base_name, input_index)
    paths: list[str] = []
    for frame_index, frame in enumerate(frames, start=1):
        path = _indexed_path(directory, base_name, input_index, ".png", frame_index if len(frames) > 1 else None)
        Image.fromarray(np.clip(frame.numpy() * 255.0, 0, 255).astype(np.uint8), mode="L").save(path)
        paths.append(str(path))
    return paths


def _save_tensor(value: torch.Tensor, directory: Path, base_name: str, input_index: int) -> list[str]:
    tensor_path = _indexed_path(directory, base_name, input_index, ".pt")
    torch.save(value.detach().cpu(), tensor_path)
    info_path = tensor_path.with_suffix(".json")
    _write_json(
        info_path,
        {
            "type": "Tensor",
            "shape": list(value.shape),
            "dtype": str(value.dtype),
            "device": str(value.device),
            "tensor_file": str(tensor_path),
        },
    )
    return [str(tensor_path), str(info_path)]


def _save_audio(value: dict[str, Any], directory: Path, base_name: str, input_index: int) -> list[str]:
    waveform = value.get("waveform")
    sample_rate = int(value.get("sample_rate") or value.get("frame_rate") or 44100)
    if not isinstance(waveform, torch.Tensor):
        return []
    audio = waveform.detach().cpu().float()
    while audio.ndim > 2:
        audio = audio[0]
    if audio.ndim == 1:
        audio = audio.unsqueeze(0)
    if audio.shape[0] > audio.shape[1]:
        audio = audio.movedim(0, 1)
    audio_np = np.clip(audio.numpy(), -1.0, 1.0)
    audio_i16 = (audio_np.T * 32767.0).astype(np.int16)
    path = _indexed_path(directory, base_name, input_index, ".wav")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(int(audio_i16.shape[1]) if audio_i16.ndim == 2 else 1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(audio_i16.tobytes())
    return [str(path)]


def _relative_output_prefix(directory: Path, base_name: str, input_index: int) -> str:
    stem = f"{_sanitize_part(base_name) or '任意对象'}_{input_index:02d}"
    try:
        relative_directory = directory.resolve().relative_to(_output_root())
    except Exception:
        return stem
    if str(relative_directory) in ("", "."):
        return stem
    return str(relative_directory / stem).replace("\\", "/")


def _is_video_object(value: Any) -> bool:
    if not hasattr(value, "get_components"):
        return False
    try:
        components = value.get_components()
    except Exception:
        return False
    return isinstance(getattr(components, "images", None), torch.Tensor)


def _save_video_object(value: Any, directory: Path, base_name: str, input_index: int) -> list[str]:
    if combine_video is None:
        raise RuntimeError("当前环境无法导入 GJJ 视频合成运行时，不能直接保存 VIDEO。")
    prefix = _relative_output_prefix(directory, base_name, input_index)
    try:
        result = combine_video(
            images=None,
            video_inputs={"video_01": value},
            frame_rate=DEFAULT_FRAME_RATE,
            loop_count=0,
            filename_prefix=prefix,
            format_name=DEFAULT_FORMAT,
            pingpong=False,
            save_output=True,
            use_source_fps=True,
            audio=None,
            vae=None,
            format_overrides_json="",
            prompt=None,
            extra_pnginfo=None,
            unique_id=None,
        )
    except Exception as exc:
        raise RuntimeError(f"直接保存 VIDEO 失败：{exc}") from exc
    output_json = result.get("result", ("", "", "[]"))[2] if isinstance(result, dict) else "[]"
    try:
        paths = json.loads(output_json)
    except Exception:
        paths = []
    if not isinstance(paths, list):
        paths = []
    main_path = result.get("result", ("", "", ""))[1] if isinstance(result, dict) else ""
    cleaned = [str(path) for path in paths if path]
    if main_path and str(main_path) not in cleaned:
        cleaned.insert(0, str(main_path))
    return cleaned


def _save_video_components(value: Any, directory: Path, base_name: str, input_index: int) -> list[str]:
    if not hasattr(value, "get_components"):
        return []
    components = value.get_components()
    paths: list[str] = []
    images = getattr(components, "images", None)
    audio = getattr(components, "audio", None)
    frame_rate = getattr(components, "frame_rate", None)
    if isinstance(images, torch.Tensor):
        paths.extend(_save_image_tensor(images, directory, f"{base_name}_{input_index:02d}_video_frames", input_index))
    if audio is not None:
        audio_paths = _save_any_value(audio, directory, f"{base_name}_{input_index:02d}_video_audio", input_index)
        paths.extend(audio_paths)
    info_path = _indexed_path(directory, base_name, input_index, ".video.json")
    _write_json(
        info_path,
        {
            "type": "VIDEO",
            "frame_rate": str(frame_rate),
            "frame_count": int(images.shape[0]) if isinstance(images, torch.Tensor) and images.ndim >= 1 else 0,
            "saved_files": paths,
        },
    )
    paths.append(str(info_path))
    return paths


def _save_any_value(value: Any, directory: Path, base_name: str, input_index: int) -> list[str]:
    if _is_none(value):
        return []
    if _is_video_object(value):
        return _save_video_object(value, directory, base_name, input_index)
    video_paths = _save_video_components(value, directory, base_name, input_index)
    if video_paths:
        return video_paths
    if isinstance(value, str):
        path = _indexed_path(directory, base_name, input_index, ".txt")
        _write_text(path, value)
        return [str(path)]
    if isinstance(value, bytes):
        path = _indexed_path(directory, base_name, input_index, ".bin")
        path.write_bytes(value)
        return [str(path)]
    if isinstance(value, (int, float, bool)):
        path = _indexed_path(directory, base_name, input_index, ".txt")
        _write_text(path, str(value))
        return [str(path)]
    if isinstance(value, dict) and isinstance(value.get("waveform"), torch.Tensor):
        return _save_audio(value, directory, base_name, input_index)
    if _is_image_tensor(value):
        return _save_image_tensor(value, directory, base_name, input_index)
    if _is_mask_tensor(value):
        return _save_mask_tensor(value, directory, base_name, input_index)
    if isinstance(value, torch.Tensor):
        return _save_tensor(value, directory, base_name, input_index)
    if isinstance(value, np.ndarray):
        return _save_tensor(torch.from_numpy(value), directory, base_name, input_index)
    if isinstance(value, (dict, list, tuple, set)):
        path = _indexed_path(directory, base_name, input_index, ".json")
        _write_json(path, value)
        return [str(path)]
    path = _indexed_path(directory, base_name, input_index, ".txt")
    _write_text(path, repr(value))
    return [str(path)]


def _output_image_preview(path: str) -> dict[str, str | int] | None:
    file_path = Path(path)
    if file_path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}:
        return None
    try:
        relative = file_path.resolve().relative_to(_output_root())
    except Exception:
        return None
    width = 0
    height = 0
    try:
        with Image.open(file_path) as image:
            width, height = image.size
    except Exception:
        pass
    return {
        "filename": relative.name,
        "subfolder": str(relative.parent).replace("\\", "/") if str(relative.parent) != "." else "",
        "type": "output",
        "path": str(file_path),
        "width": width,
        "height": height,
    }


def _output_media_preview(path: str) -> dict[str, str | int] | None:
    file_path = Path(path)
    suffix = file_path.suffix.lower()
    media_type = ""
    if suffix in {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}:
        media_type = "video"
    elif suffix in {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}:
        media_type = "audio"
    if not media_type:
        return None
    try:
        relative = file_path.resolve().relative_to(_output_root())
    except Exception:
        return None
    return {
        "filename": relative.name,
        "subfolder": str(relative.parent).replace("\\", "/") if str(relative.parent) != "." else "",
        "type": "output",
        "path": str(file_path),
        "media_type": media_type,
    }


def _read_text_preview(path: str, max_chars: int = 1600) -> str:
    file_path = Path(path)
    if file_path.suffix.lower() not in {".txt", ".json", ".log", ".csv", ".md"}:
        return ""
    try:
        text = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""
    text = text.strip()
    if len(text) > max_chars:
        text = f"{text[:max_chars]}\n..."
    return text


def _build_preview_payload(saved_paths: list[str]) -> tuple[list[dict[str, str | int]], list[dict[str, str | int]], str]:
    images: list[dict[str, str | int]] = []
    media: list[dict[str, str | int]] = []
    text_blocks: list[str] = []
    for path in saved_paths:
        image = _output_image_preview(path)
        if image:
            images.append(image)
            continue
        media_item = _output_media_preview(path)
        if media_item:
            media.append(media_item)
            continue
        text = _read_text_preview(path)
        if text:
            text_blocks.append(f"{Path(path).name}\n{text}")
    summary_lines = [f"已保存 {len(saved_paths)} 个文件。"]
    if saved_paths:
        summary_lines.extend(f"{index}. {path}" for index, path in enumerate(saved_paths[:20], start=1))
        if len(saved_paths) > 20:
            summary_lines.append(f"... 还有 {len(saved_paths) - 20} 个文件")
    if text_blocks:
        summary_lines.append("")
        summary_lines.append("文本预览")
        summary_lines.append("\n\n".join(text_blocks[:3]))
    return images[:24], media[:8], "\n".join(summary_lines)


class GJJ_SaveAnyObject:
    CATEGORY = "GJJ"
    FUNCTION = "save"
    OUTPUT_NODE = True
    DESCRIPTION = "动态接收多个任意输入，根据对象类型自动保存为视频、图片、文本、JSON、Tensor、音频或对象摘要。"
    SEARCH_ALIASES = ["save any", "保存任意对象", "任意保存", "保存对象", "save object", "debug save"]
    RETURN_TYPES = ("STRING", "STRING", "INT")
    RETURN_NAMES = ("保存路径JSON", "首个保存路径", "保存文件数")
    OUTPUT_TOOLTIPS = (
        "本次保存的所有文件路径 JSON 数组。",
        "第一个保存文件的绝对路径；没有保存内容时为空。",
        "本次实际保存的文件数量。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "filename_prefix": (
                    "STRING",
                    {
                        "default": "GJJ/任意对象",
                        "display_name": "文件名前缀",
                        "tooltip": "保存到 output 目录下，支持子目录。保持默认值时会自动改用第一个来源节点名称。",
                    },
                ),
            },
            "optional": FlexibleOptionalInputType(
                any_type,
                {
                    "any_01": (
                        any_type,
                        {
                            "display_name": "保存对象 1",
                            "tooltip": "可接任意类型；连接后会自动扩展下一个输入口。",
                        },
                    ),
                },
            ),
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def save(self, filename_prefix=DEFAULT_FILENAME_PREFIX, prompt=None, extra_pnginfo=None, unique_id=None, **kwargs):
        source_names = _resolve_input_source_names(prompt, extra_pnginfo, unique_id)
        use_source_prefix = _should_use_source_prefix(filename_prefix) and bool(source_names)
        directory, base_name = _resolve_prefix(filename_prefix)
        saved_paths: list[str] = []
        for key in sorted(kwargs.keys(), key=_extract_input_index):
            if not str(key).startswith(INPUT_PREFIX):
                continue
            value = kwargs.get(key)
            if _is_none(value):
                continue
            input_index = _extract_input_index(key)
            target_directory, target_base_name = directory, base_name
            if use_source_prefix:
                target_directory, target_base_name = _resolve_prefix(_source_prefix(source_names.get(str(key), "")))
            saved_paths.extend(_save_any_value(value, target_directory, target_base_name, input_index))

        paths_json = json.dumps(saved_paths, ensure_ascii=False, indent=2)
        first_path = saved_paths[0] if saved_paths else ""
        preview_images, preview_media, preview_text = _build_preview_payload(saved_paths)
        return {
            "ui": {
                "saved_paths": saved_paths,
                "saved_count": [len(saved_paths)],
                "first_path": [first_path],
                "preview_images": preview_images,
                "preview_media": preview_media,
                "preview_text": [preview_text],
            },
            "result": (paths_json, first_path, len(saved_paths)),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SaveAnyObject}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 💾 保存任意对象"}
