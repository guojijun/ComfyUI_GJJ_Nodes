from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import wave
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    from .gjj_video_combine_runtime import get_ffmpeg_path, _render_filename_prefix_template
except Exception:
    try:
        from gjj_video_combine_runtime import get_ffmpeg_path, _render_filename_prefix_template
    except Exception:
        get_ffmpeg_path = None
        _render_filename_prefix_template = None


MEDIA_FRAME_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO,STRING"
AUDIO_INPUT_TYPE = "AUDIO,VIDEO,STRING"
FPS_INPUT_TYPE = "INT,FLOAT,STRING,VIDEO"
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus"}


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False

    def __eq__(self, __value: object) -> bool:
        return True


any_type = AnyType("*")


def _looks_like_bad_executable_path(value: Any) -> bool:
    text = str(value or "").strip().lower()
    if not text:
        return True
    return bool(re.fullmatch(r"[-+]?\d+(?:\.\d+)?", text) or text in {"true", "false", "yes", "no", "on", "off", "none", "null"})


def _output_dir() -> Path:
    root = Path(folder_paths.get_output_directory()) if folder_paths is not None else Path.cwd() / "output"
    path = root / "GJJ" / "ffmpeg"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _run(command: list[str]) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(command, capture_output=True, text=True)
    except FileNotFoundError as exc:
        executable = command[0] if command else "命令"
        raise RuntimeError(f"未找到可执行文件：{executable}") from exc
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "FFmpeg 执行失败").strip())
    return result


def _condition_enabled(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    text = str(value).strip().lower()
    if text in {"", "false", "0", "no", "off", "none", "null"}:
        return False
    return True


def _ffmpeg(ffmpeg_path: str | None = None) -> str:
    text = str(ffmpeg_path or "").strip()
    if not _looks_like_bad_executable_path(text):
        return text
    if get_ffmpeg_path is not None:
        try:
            found = get_ffmpeg_path()
            if found:
                return str(found)
        except Exception:
            pass
    return shutil.which("ffmpeg") or "ffmpeg"


def _ffprobe(ffprobe_path: str | None = None, ffmpeg_path: str | None = None) -> str:
    text = str(ffprobe_path or "").strip()
    if not _looks_like_bad_executable_path(text):
        if Path(text).exists() or shutil.which(text):
            return text
        return ""
    ffmpeg = _ffmpeg(ffmpeg_path)
    ffmpeg_file = Path(ffmpeg)
    if ffmpeg_file.name.lower().startswith("ffmpeg"):
        probe_name = "ffprobe.exe" if ffmpeg_file.suffix.lower() == ".exe" else "ffprobe"
        candidate = ffmpeg_file.with_name(probe_name)
        if candidate.exists():
            return str(candidate)
    return shutil.which("ffprobe") or ""


def _safe_output_info(path: Path, ffprobe_path: str, fallback_fps: float = 0.0) -> tuple[str, int, int, float, int, float, str]:
    try:
        return GJJ_VideoInfo().probe(str(path), ffprobe_path)
    except Exception as exc:
        payload = {
            "warning": f"ffprobe 不可用，已跳过视频信息读取：{exc}",
            "path": str(path),
        }
        return (path.name, 0, 0, float(fallback_fps or 0.0), 0, 0.0, json.dumps(payload, ensure_ascii=False))


def _video_dimensions_from_first_segment(paths: list[Path], ffprobe_path: str) -> tuple[int, int]:
    if not paths:
        return 0, 0
    try:
        info = GJJ_VideoInfo().probe(str(paths[0]), ffprobe_path)
        return int(info[1]), int(info[2])
    except Exception:
        return 0, 0


def _output_root() -> Path:
    return Path(folder_paths.get_output_directory()).resolve() if folder_paths is not None else (Path.cwd() / "output").resolve()


def _temp_root() -> Path:
    return Path(folder_paths.get_temp_directory()).resolve() if folder_paths is not None else (Path.cwd() / "temp").resolve()


def _safe_parts(value: str) -> list[str]:
    text = str(value or "").replace("\\", "/").strip(" /.")
    return [part for part in text.split("/") if part and part not in {".", ".."}]


def _preview_item(path: str | Path, item_type: str = "output", format_name: str = "video/mp4") -> dict[str, Any]:
    resolved = Path(path).resolve()
    try:
        relative = resolved.relative_to(_output_root())
        subfolder = "" if str(relative.parent) == "." else str(relative.parent).replace("\\", "/")
        item_type = "output"
    except Exception:
        try:
            relative = resolved.relative_to(_temp_root())
            subfolder = "" if str(relative.parent) == "." else str(relative.parent).replace("\\", "/")
            item_type = "temp"
        except Exception:
            subfolder = ""
    return {
        "filename": resolved.name,
        "subfolder": subfolder,
        "type": item_type,
        "format": format_name,
    }


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value: Any) -> dict[str, Any] | None:
    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
            if isinstance(components, dict):
                return components
        except Exception:
            return None
    return None


def _as_path_from_text(value: Any) -> Path | None:
    text = str(value or "").strip().strip('"')
    if not text:
        return None
    expanded = Path(os.path.expandvars(os.path.expanduser(text)))
    candidates = [expanded]
    if not expanded.is_absolute():
        candidates.extend([_output_root() / expanded, _temp_root() / expanded, Path.cwd() / expanded])
    for candidate in candidates:
        try:
            if candidate.exists() and candidate.is_file():
                return candidate.resolve()
        except Exception:
            continue
    return None


def _path_from_comfy_item(value: Any) -> Path | None:
    if not isinstance(value, dict):
        return None
    direct = value.get("path") or value.get("filepath") or value.get("fullpath")
    if direct:
        found = _as_path_from_text(direct)
        if found:
            return found
    filename = str(value.get("filename") or "").strip()
    if not filename:
        return None
    subfolder = str(value.get("subfolder") or "").strip().replace("\\", "/")
    item_type = str(value.get("type") or "output").strip().lower()
    root = _temp_root() if item_type == "temp" else _output_root()
    candidate = (root / subfolder / filename).resolve()
    return candidate if candidate.exists() and candidate.is_file() else None


def _resolve_media_path(value: Any, suffixes: set[str] | None = None) -> Path | None:
    if value is None:
        return None
    path = _path_from_comfy_item(value)
    if path is None and isinstance(value, dict):
        for key in ("video", "audio", "file", "path", "filename"):
            path = _resolve_media_path(value.get(key), suffixes)
            if path:
                break
    if path is None:
        for method_name in ("get_stream_source", "get_filename", "get_filepath", "get_path", "path"):
            method = getattr(value, method_name, None)
            if callable(method):
                try:
                    candidate = method()
                except Exception:
                    continue
                path = _resolve_media_path(candidate, suffixes)
                if path:
                    break
        if path is None:
            for attr in ("stream_source", "source", "source_path", "filepath", "file_path", "filename", "path", "video_path", "audio_path", "_path", "_filename", "_video_path"):
                candidate = getattr(value, attr, None)
                path = _resolve_media_path(candidate, suffixes) if candidate is not None and candidate is not value else None
                if path:
                    break
    if path is None:
        for attr in ("path", "filename", "file", "filepath", "file_path", "source_path", "video_path", "audio_path", "_path", "_filename", "_video_path"):
            candidate = getattr(value, attr, None)
            path = _resolve_media_path(candidate, suffixes) if candidate is not None else None
            if path:
                break
    if path is None and isinstance(value, (str, os.PathLike)):
        path = _as_path_from_text(value)
    if path is not None and suffixes and path.suffix.lower() not in suffixes:
        return None
    return path


def _collect_media_paths(value: Any, suffixes: set[str] | None = None) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()

    def add(path: Path | None) -> None:
        if path is None:
            return
        key = str(path.resolve()).lower()
        if key in seen:
            return
        seen.add(key)
        result.append(path.resolve())

    def walk(item: Any) -> None:
        if item is None:
            return
        direct = _resolve_media_path(item, suffixes)
        if direct:
            add(direct)
            return
        if isinstance(item, dict):
            for key in (
                "videos", "video", "video_paths", "paths", "files", "items", "selected",
                "value", "values", "outputs", "result", "results", "filename", "filenames",
            ):
                if key in item:
                    walk(item.get(key))
            return
        if isinstance(item, (list, tuple, set)):
            for child in item:
                walk(child)
            return
        components = _video_components(item)
        if components is not None:
            for key in ("path", "filename", "video", "videos", "source", "stream_source"):
                if key in components:
                    walk(components.get(key))
            return
        for attr in ("videos", "video_paths", "paths", "files", "items", "selected", "value", "values"):
            child = getattr(item, attr, None)
            if child is not None and child is not item:
                walk(child)

    walk(value)
    return sorted(result, key=_natural_key)


def _first_text_hint(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, os.PathLike)):
        return str(value).strip()
    if isinstance(value, dict):
        for key in ("value", "video", "path", "filename", "prefix", "filename_prefix", "text", "selected", "values", "items"):
            if key in value:
                found = _first_text_hint(value.get(key))
                if found:
                    return found
        return ""
    if isinstance(value, (list, tuple, set)):
        for item in value:
            found = _first_text_hint(item)
            if found:
                return found
        return ""
    for attr in ("value", "path", "filename", "prefix", "filename_prefix", "text"):
        item = getattr(value, attr, None)
        if item is not None and item is not value:
            found = _first_text_hint(item)
            if found:
                return found
    return ""


def _tensor_from_media(value: Any) -> tuple[torch.Tensor | None, Any | None, float | None]:
    if value is None:
        return None, None, None
    source = value
    source_audio = None
    source_fps = None
    components = _video_components(source)
    if components is not None:
        source = _component_value(components, "images")
        source_audio = _component_value(components, "audio")
        try:
            source_fps = float(_component_value(components, "frame_rate"))
        except Exception:
            source_fps = None
    elif hasattr(source, "images"):
        source = getattr(source, "images", None)

    tensor = None
    if isinstance(source, torch.Tensor):
        tensor = source
    elif isinstance(source, dict):
        for key in ("images", "frames", "samples"):
            candidate = source.get(key)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
    elif isinstance(source, (list, tuple)) and source and all(isinstance(item, torch.Tensor) for item in source):
        tensor = torch.cat([item if item.ndim == 4 else item.unsqueeze(0) for item in source], dim=0)
    else:
        for key in ("images", "frames", "samples"):
            candidate = getattr(source, key, None)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
    if tensor is None:
        return None, source_audio, source_fps
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"图片帧输入必须是 [B,H,W,C] 或 [B,C,H,W]，实际为 {tuple(tensor.shape)}。")
    if tensor.shape[-1] not in (1, 3, 4) and tensor.shape[1] in (1, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels >= 4:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"图片帧输入通道数无效：{tuple(tensor.shape)}。")
    return tensor.detach().float().clamp(0.0, 1.0).contiguous(), source_audio, source_fps


def _fps_from_value(value: Any, fallback: float = 30.0) -> float:
    try:
        fallback_fps = float(str(fallback).strip())
    except Exception:
        fallback_fps = 30.0
    if not math.isfinite(fallback_fps) or fallback_fps <= 0:
        fallback_fps = 30.0
    if value is None:
        return fallback_fps
    if callable(getattr(value, "get_frame_rate", None)):
        try:
            value = value.get_frame_rate()
        except Exception:
            pass
    elif isinstance(value, dict):
        for key in ("frame_rate", "fps", "rate"):
            if key in value:
                value = value.get(key)
                break
    try:
        fps = float(str(value).strip())
    except Exception:
        fps = fallback_fps
    if not math.isfinite(fps) or fps <= 0:
        fps = fallback_fps
    return max(1.0, min(240.0, fps))


def _write_audio_wav(audio: dict[str, Any], path: Path) -> None:
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate") or 44100)
    if not isinstance(waveform, torch.Tensor):
        raise RuntimeError("AUDIO 输入缺少 waveform。")
    value = waveform.detach().float().cpu()
    while value.ndim > 2:
        value = value[0]
    if value.ndim == 1:
        value = value.unsqueeze(0)
    if value.shape[0] > value.shape[1]:
        value = value.movedim(0, 1)
    samples = (value.clamp(-1, 1).numpy().T * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(int(samples.shape[1]) if samples.ndim == 2 else 1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(samples.tobytes())


def _write_frames(images: torch.Tensor, directory: Path) -> str:
    pattern = str(directory / "frame_%06d.png")
    value = images.detach().float().cpu().clamp(0, 1)
    for index, frame in enumerate(value, start=1):
        array = (frame[..., :3].numpy() * 255.0).astype(np.uint8)
        Image.fromarray(array).save(pattern % index)
    return pattern


def _prefix_parts(filename_prefix: str) -> tuple[Path, str]:
    prefix = str(filename_prefix or "GJJ/ffmpeg/mux").strip() or "GJJ/ffmpeg/mux"
    if folder_paths is not None:
        try:
            folder, filename, _, _, _ = folder_paths.get_save_image_path(prefix, str(_output_root()), 0, 0)
            folder_path = Path(folder).resolve()
            stem = str(filename or "").strip() or Path(prefix.replace("\\", "/")).name or "mux"
            folder_path.mkdir(parents=True, exist_ok=True)
            return folder_path, stem
        except Exception:
            pass
    parts = _safe_parts(prefix)
    stem = parts[-1] if parts else "mux"
    folder = _output_root() / Path(*parts[:-1]) if len(parts) > 1 else _output_dir()
    folder.mkdir(parents=True, exist_ok=True)
    return folder, stem


def _unique_output_path(filename_prefix: str, suffix: str = ".mp4", marker: str = "") -> Path:
    folder, stem = _prefix_parts(filename_prefix)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    prefix = f"{marker}_" if marker else ""
    candidate = folder / f"{prefix}{stem}_{stamp}{suffix}"
    index = 1
    while candidate.exists():
        candidate = folder / f"{prefix}{stem}_{stamp}_{index:03d}{suffix}"
        index += 1
    return candidate


def _natural_key(path: Path) -> tuple:
    text = path.stem.lower()
    parts = re.split(r"(\d+)", text)
    key = [int(part) if part.isdigit() else part for part in parts]
    numbers = [int(match) for match in re.findall(r"\d+", text)]
    return (key, numbers[-1] if numbers else -1, path.name.lower())


def _compact_prefix_key(value: Any) -> str:
    return "".join(ch.lower() for ch in str(value or "") if ch.isalnum())


def _segment_number_for_prefix(path: Path, stem: str) -> int | None:
    prefix = str(stem or "").strip()
    if not prefix:
        return None
    name = path.stem
    if not name.startswith(prefix):
        return None
    tail = name[len(prefix):]
    match = re.match(r"^[\s._-]*(?:[A-Za-z][A-Za-z0-9]*[\s._-]+)*(\d+)(?:[\s._-].*)?$", tail)
    if not match:
        return None
    try:
        return int(match.group(1))
    except Exception:
        return None


def _segment_number_for_loose_prefix(path: Path, stem: str) -> int | None:
    number = _segment_number_for_prefix(path, stem)
    if number is not None:
        return number
    compact_prefix = _compact_prefix_key(stem)
    compact_name = _compact_prefix_key(path.stem)
    if not compact_prefix or not compact_name.startswith(compact_prefix):
        return None
    tail = compact_name[len(compact_prefix):]
    match = re.match(r"^(?:[a-z]+)?(\d+)(?:[a-z0-9]*)?$", tail)
    if not match:
        return None
    try:
        return int(match.group(1))
    except Exception:
        return None


def _matches_loose_prefix(path: Path, stem: str) -> bool:
    prefix = str(stem or "").strip()
    if not prefix:
        return False
    if path.stem.startswith(prefix):
        return True
    compact_prefix = _compact_prefix_key(prefix)
    compact_name = _compact_prefix_key(path.stem)
    return bool(compact_prefix and compact_name.startswith(compact_prefix))


def _matches_short_prefix(path: Path, prefix: str) -> bool:
    compact_prefix = _compact_prefix_key(prefix)
    if not compact_prefix:
        return False
    compact_stem = _compact_prefix_key(path.stem)
    if compact_prefix in compact_stem:
        return True
    try:
        relative = path.resolve().relative_to(_output_root())
        compact_relative = _compact_prefix_key(str(relative.with_suffix("")))
        return compact_prefix in compact_relative
    except Exception:
        return False


def _is_merged_video(path: Path) -> bool:
    lowered_stem = path.stem.lower()
    return (
        "_merged_" in lowered_stem
        or lowered_stem.startswith("merged_")
        or "_concat_" in lowered_stem
        or lowered_stem.startswith("concat_")
    )


def _directory_candidates_from_prefix(value: Any) -> list[Path]:
    raw = str(value or "").strip().strip('"')
    if not raw:
        return []
    expanded = Path(os.path.expandvars(os.path.expanduser(raw)))
    directory_like = raw.endswith(("/", "\\")) or (expanded.exists() and expanded.is_dir())
    if not directory_like:
        return []
    candidates = [expanded]
    if not expanded.is_absolute():
        parts = _safe_parts(raw)
        if parts:
            relative = Path(*parts)
            candidates.extend([_output_root() / relative, _temp_root() / relative, Path.cwd() / relative])
    folders: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            if not resolved.exists() or not resolved.is_dir():
                continue
            key = str(resolved).lower()
            if key in seen:
                continue
            seen.add(key)
            folders.append(resolved)
        except Exception:
            continue
    return folders


def _segment_prefix_path(path: Path) -> Path | None:
    match = re.match(r"^(.*?)[\s._-]+(\d+)$", path.stem)
    if not match:
        return None
    prefix_stem = match.group(1).rstrip(" ._-")
    if not prefix_stem:
        return None
    return path.with_name(prefix_stem)


def _segment_prefix_text(value: Any) -> str:
    text = str(value or "").strip().strip('"')
    if not text:
        return ""
    path = _as_path_from_text(text)
    if path is not None and path.suffix.lower() in VIDEO_SUFFIXES:
        prefix_path = _segment_prefix_path(path)
        return str(prefix_path) if prefix_path is not None else text

    raw = Path(os.path.expandvars(os.path.expanduser(text)))
    suffix = raw.suffix
    stem = raw.stem if suffix.lower() in VIDEO_SUFFIXES else raw.name
    match = re.match(r"^(.*?)[\s._-]+(\d+)$", stem)
    if not match:
        return text
    prefix_stem = match.group(1).rstrip(" ._-")
    if not prefix_stem:
        return text
    prefix = raw.with_name(prefix_stem)
    return str(prefix)


def _find_prefixed_videos(filename_prefix: str, explicit_prefix: str = "") -> list[Path]:
    search_values = []
    for raw_value in (explicit_prefix, filename_prefix):
        text_value = str(raw_value or "").strip()
        if not text_value:
            continue
        search_values.append(text_value)
        normalized = text_value.replace("\\", "/").strip("/")
        if normalized.startswith("video/"):
            search_values.append(normalized[6:])
        elif normalized.startswith("GJJ/"):
            search_values.append(f"video/{normalized}")
            basename = normalized.rsplit("/", 1)[-1]
            if basename:
                search_values.append(f"video/{basename}")
    results: list[Path] = []
    seen: set[str] = set()

    def add_candidate(candidate: Path) -> None:
        if not candidate.is_file() or _is_merged_video(candidate):
            return
        key = str(candidate.resolve()).lower()
        if key in seen:
            return
        seen.add(key)
        results.append(candidate.resolve())

    for raw in search_values:
        before_count = len(results)
        text = str(raw or "").strip().strip('"')
        if not text:
            continue
        for folder in _directory_candidates_from_prefix(text):
            for suffix in VIDEO_SUFFIXES:
                for candidate in folder.rglob(f"*{suffix}"):
                    add_candidate(candidate)
            if len(results) > before_count:
                break
        if len(results) > before_count:
            break
        file_path = _as_path_from_text(text)
        if file_path and file_path.suffix.lower() in VIDEO_SUFFIXES:
            segment_prefix = _segment_prefix_path(file_path)
            if segment_prefix is not None:
                text = str(segment_prefix)
            else:
                add_candidate(file_path)
                break
        direct = Path(os.path.expanduser(os.path.expandvars(text)))
        folder, stem = _prefix_parts(text)
        candidates: list[Path] = []
        if direct.is_absolute() and direct.parent.exists():
            folder = direct.parent
            stem = direct.name
        for suffix in VIDEO_SUFFIXES:
            candidates.extend(folder.glob(f"{stem}*{suffix}"))
        if folder.exists():
            for suffix in VIDEO_SUFFIXES:
                candidates.extend(folder.rglob(f"{stem}*{suffix}"))
        if folder.exists():
            for suffix in VIDEO_SUFFIXES:
                candidates.extend(
                    candidate
                    for candidate in folder.rglob(f"*{suffix}")
                    if _matches_loose_prefix(candidate, stem)
                )
        numbered_candidates = [candidate for candidate in candidates if _segment_number_for_loose_prefix(candidate, stem) is not None]
        if numbered_candidates:
            candidates = numbered_candidates
        for candidate in candidates:
            add_candidate(candidate)
        if len(results) <= before_count:
            short_prefix = Path(text.replace("\\", "/").strip("/")).name or text
            for suffix in VIDEO_SUFFIXES:
                for candidate in _output_root().rglob(f"*{suffix}"):
                    if _matches_short_prefix(candidate, short_prefix):
                        add_candidate(candidate)
        if len(results) > before_count:
            break
    return sorted(results, key=_natural_key)


def _short_prefix_text(value: Any) -> str:
    text = str(value or "").strip().strip('"')
    if not text:
        return ""
    normalized = text.replace("\\", "/").strip("/")
    if not normalized:
        return ""
    return Path(normalized).name or normalized


def _find_latest_short_prefix_videos(filename_prefix: str, explicit_prefix: str = "") -> list[Path]:
    prefixes = [_short_prefix_text(explicit_prefix), _short_prefix_text(filename_prefix)]
    prefixes = [item for item in dict.fromkeys(prefixes) if item]
    results: list[Path] = []
    seen: set[str] = set()

    def add(candidate: Path) -> None:
        if not candidate.is_file() or _is_merged_video(candidate):
            return
        key = str(candidate.resolve()).lower()
        if key in seen:
            return
        seen.add(key)
        results.append(candidate.resolve())

    for raw in (explicit_prefix, filename_prefix):
        for folder in _directory_candidates_from_prefix(raw):
            for suffix in VIDEO_SUFFIXES:
                for candidate in folder.rglob(f"*{suffix}"):
                    add(candidate)

    for suffix in VIDEO_SUFFIXES:
        for candidate in _output_root().rglob(f"*{suffix}"):
            if any(_matches_short_prefix(candidate, prefix) for prefix in prefixes):
                add(candidate)
    return sorted(results, key=_natural_key)


def _last_number_span(value: str) -> re.Match[str] | None:
    matches = list(re.finditer(r"\d+", str(value or "")))
    return matches[-1] if matches else None


def _numbered_sibling_info(path: Path, before: str, after: str) -> tuple[int, int] | None:
    stem = path.stem
    pattern = rf"^{re.escape(before)}(\d+){re.escape(after)}(?:[\s._-].*)?$"
    match = re.fullmatch(pattern, stem)
    if not match:
        return None
    try:
        return int(match.group(1)), len(match.group(1))
    except Exception:
        return None


def _previous_numbered_sibling_videos(filename_prefix: Any) -> list[Path]:
    text = str(filename_prefix or "").strip().strip('"')
    if not text:
        return []
    direct = Path(os.path.expandvars(os.path.expanduser(text)))
    if direct.is_absolute() and direct.parent.exists():
        folder = direct.parent
        stem = direct.stem if direct.suffix.lower() in VIDEO_SUFFIXES else direct.name
    else:
        folder, stem = _prefix_parts(text)
    match = _last_number_span(stem)
    if not match:
        return []
    try:
        current_number = int(match.group(0))
    except Exception:
        return []
    before = stem[:match.start()]
    after = stem[match.end():]
    if not before and not after:
        return []

    candidates: list[tuple[int, int, Path]] = []
    seen: set[str] = set()
    for suffix in VIDEO_SUFFIXES:
        for candidate in folder.rglob(f"*{suffix}") if folder.exists() else []:
            if not candidate.is_file() or _is_merged_video(candidate):
                continue
            info = _numbered_sibling_info(candidate, before, after)
            if info is None:
                continue
            number, width = info
            if number >= current_number:
                continue
            key = str(candidate.resolve()).lower()
            if key in seen:
                continue
            seen.add(key)
            candidates.append((number, width, candidate.resolve()))
    candidates.sort(key=lambda item: (item[0], item[1], _video_timestamp_ns(item[2]), str(item[2]).lower()))
    return [item[2] for item in candidates]


def _prefixed_videos_signature(filename_prefix: str) -> str:
    prefix = _segment_prefix_text(filename_prefix)
    if not prefix:
        return ""
    parts = []
    for path in _find_prefixed_videos(prefix):
        try:
            stat = path.stat()
            parts.append(f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}")
        except Exception:
            parts.append(path.name)
    return "|".join(parts)


def _media_input_summary(value: Any) -> str:
    if value is None:
        return "空"
    if isinstance(value, torch.Tensor):
        return f"Tensor{tuple(value.shape)}"
    text = _first_text_hint(value)
    if text:
        return f"{type(value).__name__}: {text[:160]}"
    components = _video_components(value)
    if components is not None:
        images = _component_value(components, "images")
        path = _component_value(components, "path") or _component_value(components, "video_path") or _component_value(components, "filename")
        if isinstance(images, torch.Tensor):
            return f"VIDEO(images={tuple(images.shape)})"
        if path:
            return f"VIDEO(path={str(path)[:160]})"
        return "VIDEO(无 images/path)"
    return type(value).__name__


def _dependency_signature(value: Any) -> str:
    paths = _collect_media_paths(value, VIDEO_SUFFIXES | AUDIO_SUFFIXES)
    if paths:
        return ",".join(str(path) for path in paths)
    if value is None or isinstance(value, (str, int, float, bool)):
        return str(value)
    if isinstance(value, torch.Tensor):
        return f"Tensor{tuple(value.shape)}:{value.dtype}:{value.device}"
    return f"{type(value).__name__}:{id(value)}"


def _probe_duration(path: Path, ffprobe_path: str, ffmpeg_path: str | None = None) -> float:
    try:
        result = _run([_ffprobe(ffprobe_path, ffmpeg_path), "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", str(path)])
        return max(0.0, float((result.stdout or "0").strip() or 0.0))
    except Exception:
        return 0.0


def _normalize_tail_frame_count(value: Any) -> int:
    if isinstance(value, bool):
        return 1 if value else 0
    text = str(value or "").strip().lower()
    if text in {"true", "yes", "on", "enable", "enabled", "开", "是", "真"}:
        return 1
    if text in {"", "false", "no", "off", "disable", "disabled", "关", "否", "假"}:
        return 0
    try:
        raw = int(round(float(text)))
    except Exception:
        return 0
    if raw <= 0:
        return 0
    return max(1, (max(0, int((raw - 1 + 3) // 4)) * 4) + 1)


def _trim_tail_frames(video_path: Path, frame_count: int, fps: float, tmp_path: Path, ffmpeg_path: str, ffprobe_path: str) -> Path:
    frame_count = _normalize_tail_frame_count(frame_count)
    if frame_count <= 0:
        return video_path
    duration = _probe_duration(video_path, ffprobe_path, ffmpeg_path)
    if duration <= 0 or fps <= 0:
        return video_path
    keep = max(0.001, duration - (float(frame_count) / float(fps)))
    out = tmp_path / f"{video_path.stem}_trim_tail_{frame_count}{video_path.suffix or '.mp4'}"
    _run([ffmpeg_path, "-y", "-i", str(video_path), "-t", f"{keep:.6f}", "-c", "copy", str(out)])
    return out if out.exists() else video_path


def _delete_merged_segment_files(segment_paths: list[Path], output_path: Path, tmp_path: Path | None = None) -> tuple[int, list[str]]:
    deleted = 0
    errors: list[str] = []
    seen: set[str] = set()
    try:
        output_resolved = output_path.resolve()
    except Exception:
        output_resolved = output_path
    tmp_resolved = None
    if tmp_path is not None:
        try:
            tmp_resolved = tmp_path.resolve()
        except Exception:
            tmp_resolved = tmp_path

    for raw_path in segment_paths:
        try:
            path = Path(raw_path).resolve()
        except Exception:
            path = Path(raw_path)
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        if path == output_resolved or not path.is_file():
            continue
        if tmp_resolved is not None:
            try:
                path.relative_to(tmp_resolved)
                continue
            except ValueError:
                pass
            except Exception:
                pass
        try:
            path.unlink()
            deleted += 1
        except Exception as exc:
            errors.append(f"{path.name}: {exc}")
    return deleted, errors


def _concat_videos(video_paths: list[Path], output_path: Path, ffmpeg_path: str, reencode: bool = False) -> Path:
    if not video_paths:
        raise RuntimeError("没有找到可合并的视频分段。")
    if len(video_paths) == 1:
        if video_paths[0].resolve() != output_path.resolve():
            shutil.copy2(video_paths[0], output_path)
        return output_path
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as handle:
        list_path = Path(handle.name)
        for path in video_paths:
            escaped = path.resolve().as_posix().replace("'", "'\\''")
            handle.write(f"file '{escaped}'\n")
    try:
        command = [ffmpeg_path, "-y", "-f", "concat", "-safe", "0", "-i", str(list_path)]
        if reencode:
            command.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
        else:
            command.extend(["-c", "copy"])
        command.append(str(output_path))
        try:
            _run(command)
        except RuntimeError:
            if not reencode:
                return _concat_videos(video_paths, output_path, ffmpeg_path, reencode=True)
            raise
    finally:
        try:
            list_path.unlink(missing_ok=True)
        except Exception:
            pass
    return output_path


def _resolve_audio_source(audio: Any, audio_path: Any, tmp_path: Path) -> Path | None:
    path = _resolve_media_path(audio_path, AUDIO_SUFFIXES | VIDEO_SUFFIXES)
    if path:
        return path
    path = _resolve_media_path(audio, AUDIO_SUFFIXES | VIDEO_SUFFIXES)
    if path:
        return path
    components = _video_components(audio)
    if components is not None:
        component_audio = _component_value(components, "audio")
        if component_audio is not None:
            audio = component_audio
    if isinstance(audio, dict) and audio.get("waveform") is not None:
        out = tmp_path / "source_audio.wav"
        _write_audio_wav(audio, out)
        return out
    return None


class GJJ_VideoInfo:
    CATEGORY = "GJJ/视频"
    FUNCTION = "probe"
    DESCRIPTION = "调用 ffprobe 读取视频基本信息。"
    SEARCH_ALIASES = ["ffprobe", "video info", "视频信息"]
    RETURN_TYPES = ("STRING", "INT", "INT", "FLOAT", "INT", "FLOAT", "STRING")
    RETURN_NAMES = ("文件名", "宽度", "高度", "帧率", "总帧数", "时长秒", "完整JSON")
    OUTPUT_TOOLTIPS = ("文件名。", "视频宽度。", "视频高度。", "帧率。", "估算或读取到的总帧数。", "时长秒。", "ffprobe 完整 JSON。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_path": ("STRING", {"default": "", "display_name": "视频路径", "tooltip": "本地视频文件路径。"}),
                "ffprobe_path": ("STRING", {"default": "ffprobe", "display_name": "ffprobe路径", "tooltip": "ffprobe 可执行文件路径，默认使用 PATH。"}),
            }
        }

    def probe(self, video_path: str, ffprobe_path: str):
        path = Path(video_path)
        if not path.exists():
            raise RuntimeError(f"未找到视频文件：{video_path}")
        probe_path = _ffprobe(ffprobe_path)
        if not probe_path:
            raise RuntimeError("当前环境未找到 ffprobe，无法读取视频信息。")
        result = _run([probe_path, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)])
        data = json.loads(result.stdout or "{}")
        width = height = total_frames = 0
        fps = 0.0
        for stream in data.get("streams", []):
            if stream.get("codec_type") != "video":
                continue
            width = int(stream.get("width") or 0)
            height = int(stream.get("height") or 0)
            rate = str(stream.get("r_frame_rate") or "0/1")
            try:
                numerator, denominator = rate.split("/")
                fps = float(numerator) / max(1.0, float(denominator))
            except Exception:
                fps = 0.0
            total_frames = int(stream.get("nb_frames") or 0)
            break
        duration = float(data.get("format", {}).get("duration") or 0.0)
        if total_frames <= 0 and fps > 0 and duration > 0:
            total_frames = int(round(duration * fps))
        return (path.name, width, height, fps, total_frames, duration, json.dumps(data, ensure_ascii=False, indent=2))


class GJJ_VideoFramesLoader:
    CATEGORY = "GJJ/视频"
    FUNCTION = "load"
    DESCRIPTION = "用 FFmpeg 抽取视频帧为 IMAGE 批次。"
    SEARCH_ALIASES = ["video frames", "ffmpeg", "视频抽帧"]
    RETURN_TYPES = ("IMAGE", "FLOAT", "FLOAT", "INT")
    RETURN_NAMES = ("视频帧", "原始帧率", "输出帧率", "总帧数")
    OUTPUT_TOOLTIPS = ("抽取出的 IMAGE 批次。", "原视频帧率。", "按间隔抽帧后的帧率。", "原视频总帧数估算。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_path": ("STRING", {"default": "", "display_name": "视频路径", "tooltip": "本地视频文件路径。"}),
                "frame_interval": ("INT", {"default": 1, "min": 1, "max": 1000, "display_name": "抽帧间隔", "tooltip": "每隔多少帧取一帧。"}),
                "max_frames": ("INT", {"default": 0, "min": 0, "max": 10000, "display_name": "最大帧数", "tooltip": "0 表示不限制。"}),
                "ffmpeg_path": ("STRING", {"default": "ffmpeg", "display_name": "ffmpeg路径", "tooltip": "ffmpeg 可执行文件路径，默认使用 PATH。"}),
                "ffprobe_path": ("STRING", {"default": "ffprobe", "display_name": "ffprobe路径", "tooltip": "ffprobe 可执行文件路径，默认使用 PATH。"}),
            }
        }

    def load(self, video_path: str, frame_interval: int, max_frames: int, ffmpeg_path: str, ffprobe_path: str):
        info = GJJ_VideoInfo().probe(video_path, ffprobe_path)
        fps = float(info[3])
        total = int(info[4])
        output_fps = fps / max(1, int(frame_interval)) if fps > 0 else 0.0
        with tempfile.TemporaryDirectory() as tmp:
            pattern = str(Path(tmp) / "frame_%06d.png")
            select = f"not(mod(n\\,{max(1, int(frame_interval))}))"
            command = [ffmpeg_path or "ffmpeg", "-y", "-i", str(video_path), "-vf", f"select='{select}'", "-vsync", "vfr"]
            if int(max_frames) > 0:
                command.extend(["-frames:v", str(int(max_frames))])
            command.append(pattern)
            _run(command)
            frames = []
            for frame_path in sorted(Path(tmp).glob("frame_*.png")):
                with Image.open(frame_path) as img:
                    frames.append(torch.from_numpy(np.asarray(img.convert("RGB")).astype(np.float32) / 255.0).unsqueeze(0))
            if not frames:
                raise RuntimeError("未能从视频中抽取到帧。")
            return (torch.cat(frames, dim=0), fps, output_fps, total)


def _empty_image_batch() -> torch.Tensor:
    return torch.zeros((0, 64, 64, 3), dtype=torch.float32)


def _first_image_frame(value: Any) -> torch.Tensor | None:
    frames, _audio, _fps = _tensor_from_media(value)
    if not isinstance(frames, torch.Tensor) or frames.ndim != 4 or int(frames.shape[0]) <= 0:
        return None
    return frames[:1].contiguous()


def _repeated_first_image_frame(value: Any, count: int) -> torch.Tensor | None:
    first = _first_image_frame(value)
    if first is None:
        return None
    repeat_count = max(1, int(count))
    return first.repeat((repeat_count, 1, 1, 1)).contiguous()


def _video_timestamp_ns(path: Path) -> int:
    try:
        stat = path.stat()
    except Exception:
        return 0
    return max(int(getattr(stat, "st_ctime_ns", 0) or 0), int(getattr(stat, "st_mtime_ns", 0) or 0))


def _format_video_timestamp(path: Path) -> str:
    timestamp_ns = _video_timestamp_ns(path)
    if timestamp_ns <= 0:
        return "未知时间"
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(timestamp_ns / 1_000_000_000))
    except Exception:
        return "未知时间"


def _format_elapsed_seconds(seconds: float) -> str:
    value = max(0.0, float(seconds or 0.0))
    total = int(round(value))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}小时{minutes:02d}分{secs:02d}秒"
    if minutes > 0:
        return f"{minutes}分{secs:02d}秒"
    return f"{value:.1f}秒"


def _segment_timing_text(segment_paths: list[Path]) -> str:
    unique_paths: list[Path] = []
    seen: set[str] = set()
    for raw_path in segment_paths:
        try:
            path = Path(raw_path).resolve()
        except Exception:
            path = Path(raw_path)
        key = str(path).lower()
        if key in seen or not path.is_file():
            continue
        seen.add(key)
        unique_paths.append(path)

    count = len(unique_paths)
    if count <= 0:
        return ""

    timestamps = [_video_timestamp_ns(path) for path in unique_paths]
    intervals: list[float] = []
    for previous, current in zip(timestamps, timestamps[1:]):
        if previous > 0 and current > 0:
            intervals.append(max(0.0, (current - previous) / 1_000_000_000.0))
    if not intervals:
        return f"\n片段：{count} 段，总耗时：无法推算"

    estimated_first_elapsed = sum(intervals) / len(intervals)
    total_elapsed = estimated_first_elapsed + sum(intervals)
    average_text = f"，平均 {_format_elapsed_seconds(total_elapsed / max(1, count))}/段"
    return f"\n片段：{count} 段，总耗时：{_format_elapsed_seconds(total_elapsed)}{average_text}"


def _latest_video_key(path: Path) -> tuple[int, str]:
    return (_video_timestamp_ns(path), str(path.resolve()).lower())


def _latest_video_from_prefix(filename_prefix: Any, source: Any = None) -> tuple[Path | None, str]:
    prefix_from_source = _segment_prefix_text(_first_text_hint(source))
    prefix_from_panel = _segment_prefix_text(filename_prefix)
    effective_prefix = prefix_from_source or prefix_from_panel or str(filename_prefix or "").strip()

    direct = _resolve_media_path(filename_prefix, VIDEO_SUFFIXES)
    if direct is not None:
        return direct, str(filename_prefix or "").strip()
    previous_siblings = _previous_numbered_sibling_videos(filename_prefix)
    if previous_siblings:
        return previous_siblings[-1], effective_prefix
    videos = _find_prefixed_videos(effective_prefix) if effective_prefix else []
    if not videos and effective_prefix:
        videos = _find_latest_short_prefix_videos(effective_prefix)
    if not videos:
        videos = _collect_media_paths(source, VIDEO_SUFFIXES)
    if not videos:
        return None, effective_prefix
    return max(videos, key=_latest_video_key), effective_prefix


def _render_latest_video_prefix(value: Any, prompt: Any = None, extra_pnginfo: Any = None) -> str:
    text = str(value or "").strip()
    if not text or "{" not in text or "}" not in text or _render_filename_prefix_template is None:
        return text
    directory_like = text.endswith(("/", "\\"))
    rendered = _render_filename_prefix_template(text, prompt, extra_pnginfo=extra_pnginfo)
    if directory_like and rendered and not str(rendered).endswith(("/", "\\")):
        return f"{rendered}/"
    return rendered


def _latest_video_from_rendered_prefix(
    filename_prefix: Any,
    source: Any = None,
    prompt: Any = None,
    extra_pnginfo: Any = None,
) -> tuple[Path | None, str]:
    source_hint = _first_text_hint(source)
    rendered_source = _render_latest_video_prefix(source_hint, prompt, extra_pnginfo)
    rendered_prefix = _render_latest_video_prefix(filename_prefix, prompt, extra_pnginfo)
    return _latest_video_from_prefix(rendered_prefix, rendered_source or source)


def _latest_video_signature(filename_prefix: Any, source: Any = None) -> str:
    video_path, effective_prefix = _latest_video_from_prefix(filename_prefix, source)
    if video_path is None:
        return f"missing:{effective_prefix}"
    try:
        stat = video_path.stat()
        return f"{video_path}:{stat.st_size}:{getattr(stat, 'st_ctime_ns', 0)}:{stat.st_mtime_ns}"
    except Exception:
        return str(video_path)


def _latest_video_rendered_signature(filename_prefix: Any, source: Any = None, prompt: Any = None, extra_pnginfo: Any = None) -> str:
    video_path, effective_prefix = _latest_video_from_rendered_prefix(filename_prefix, source, prompt, extra_pnginfo)
    if video_path is None:
        return f"missing:{effective_prefix}"
    try:
        stat = video_path.stat()
        return f"{video_path}:{stat.st_size}:{getattr(stat, 'st_ctime_ns', 0)}:{stat.st_mtime_ns}"
    except Exception:
        return str(video_path)


def _video_candidates_signature(filename_prefix: Any, source: Any = None) -> str:
    prefix_from_source = _segment_prefix_text(_first_text_hint(source))
    prefix_from_panel = _segment_prefix_text(filename_prefix)
    effective_prefix = prefix_from_source or prefix_from_panel or str(filename_prefix or "").strip()
    candidates: list[Path] = []
    seen: set[str] = set()

    def add(path: Path | None) -> None:
        if path is None:
            return
        try:
            resolved = path.resolve()
        except Exception:
            resolved = path
        key = str(resolved).lower()
        if key in seen:
            return
        seen.add(key)
        candidates.append(resolved)

    direct = _resolve_media_path(filename_prefix, VIDEO_SUFFIXES)
    add(direct)
    for path in _previous_numbered_sibling_videos(filename_prefix):
        add(path)
    if effective_prefix:
        for path in _find_prefixed_videos(effective_prefix):
            add(path)
        for path in _find_latest_short_prefix_videos(effective_prefix):
            add(path)
    for path in _collect_media_paths(source, VIDEO_SUFFIXES):
        add(path)

    parts = [f"prefix:{effective_prefix}"]
    for path in sorted(candidates, key=lambda item: str(item).lower()):
        try:
            stat = path.stat()
            parts.append(
                f"{path}:{stat.st_size}:{getattr(stat, 'st_ctime_ns', 0)}:{getattr(stat, 'st_mtime_ns', 0)}"
            )
        except Exception:
            parts.append(str(path))
    return "|".join(parts)


def _video_candidates_rendered_signature(filename_prefix: Any, source: Any = None, prompt: Any = None, extra_pnginfo: Any = None) -> str:
    source_hint = _first_text_hint(source)
    rendered_source = _render_latest_video_prefix(source_hint, prompt, extra_pnginfo)
    rendered_prefix = _render_latest_video_prefix(filename_prefix, prompt, extra_pnginfo)
    return _video_candidates_signature(rendered_prefix, rendered_source or source)



def _extract_video_tail_frames(video_path: Path, frame_count: int, ffmpeg_path: str) -> torch.Tensor:
    count = max(1, int(frame_count))
    with tempfile.TemporaryDirectory() as tmp:
        pattern = str(Path(tmp) / "tail_%06d.png")
        _run([
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(video_path),
            "-vf",
            "reverse",
            "-frames:v",
            str(count),
            pattern,
        ])
        frame_paths = sorted(Path(tmp).glob("tail_*.png"))
        if not frame_paths:
            return _empty_image_batch()
        frames = []
        for frame_path in reversed(frame_paths):
            with Image.open(frame_path) as img:
                array = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
                frames.append(torch.from_numpy(array).unsqueeze(0))
        return torch.cat(frames, dim=0).contiguous()


class GJJ_LatestVideoTailFrames:
    CATEGORY = "GJJ/视频"
    FUNCTION = "load_tail"
    DESCRIPTION = "按文件名前缀查找最新视频，并用 FFmpeg 返回最后若干帧；找不到或读取失败时输出空 IMAGE 批次，不打断工作流。"
    SEARCH_ALIASES = ["latest video tail frames", "last video frames", "视频尾帧", "最新视频", "文件名前缀"]
    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE", "STRING", "STRING", "INT")
    RETURN_NAMES = ("尾帧", "视频路径", "状态", "返回帧数")
    OUTPUT_TOOLTIPS = (
        "最新匹配视频的最后若干帧。找不到视频或读取失败时输出空 IMAGE 批次。",
        "实际读取的视频路径；未找到时为空。",
        "中文状态说明，可接到预览或日志节点。",
        "实际返回的帧数。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "filename_prefix": ("STRING", {
                    "default": "GJJ/ffmpeg/mux",
                    "display_name": "文件名前缀",
                    "tooltip": "用于搜索输出目录下同前缀视频；也可以直接填视频路径。支持外接小圆点传入前缀或 {变量名} 模板。",
                }),
                "frame_count": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 10000,
                    "step": 1,
                    "display_name": "返回尾帧数量",
                    "tooltip": "从最新视频末尾返回多少帧；视频不足时返回实际可读取的帧数。",
                }),
                "ffmpeg_path": ("STRING", {
                    "default": "",
                    "display_name": "",
                    "tooltip": "内部高级参数：ffmpeg 可执行文件路径。留空时自动查找；不可用时输出空帧并继续。",
                    "display": "hidden",
                    "hidden": True,
                }),
            },
            "optional": {
                "images": ("GJJ_BATCH_IMAGE,IMAGE,VIDEO", {
                    "display_name": "首帧候选图片",
                    "tooltip": "第一次序列还没有上一段保存视频时，使用这里输入的第一张图片作为尾帧兜底，并按返回尾帧数量复制。",
                }),
                "slide_start_index": ("INT,FLOAT", {
                    "display_name": "滑动起始序号",
                    "tooltip": "可接 GJJ_AudioSilenceTrimmer 的“当前分段序号”，用于建立执行依赖并让每段重新读取最新尾帧。",
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        filename_prefix: str,
        frame_count: int = 1,
        ffmpeg_path: str = "",
        images=None,
        slide_start_index=None,
        prompt=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        return "|".join([
            str(max(1, int(frame_count))),
            str(_media_input_summary(images)),
            str(slide_start_index if slide_start_index is not None else ""),
            str(filename_prefix or ""),
            _latest_video_rendered_signature(filename_prefix, None, prompt, extra_pnginfo),
            _video_candidates_rendered_signature(filename_prefix, None, prompt, extra_pnginfo),
        ])

    def load_tail(
        self,
        filename_prefix: str,
        frame_count: int = 1,
        ffmpeg_path: str = "",
        images=None,
        slide_start_index=None,
        prompt=None,
        extra_pnginfo=None,
    ):
        requested = max(1, int(frame_count))
        video_path, effective_prefix = _latest_video_from_rendered_prefix(filename_prefix, None, prompt, extra_pnginfo)
        if video_path is None:
            fallback = _repeated_first_image_frame(images, requested)
            if fallback is not None:
                count = int(fallback.shape[0])
                status = f"未找到上一段视频，已使用首帧候选图片复制 {count} 帧作为第一次序列起始帧。搜索前缀：{effective_prefix or '空'}"
                return {
                    "ui": {"text": [status]},
                    "result": (fallback, "", status, count),
                }
            status = f"未找到同前缀视频，且未提供首帧候选图片，已输出空帧并继续。搜索前缀：{effective_prefix or '空'}"
            return {
                "ui": {"text": [status]},
                "result": (_empty_image_batch(), "", status, 0),
            }

        try:
            ffmpeg = _ffmpeg(ffmpeg_path)
            frames = _extract_video_tail_frames(video_path, requested, ffmpeg)
            count = int(frames.shape[0]) if isinstance(frames, torch.Tensor) and frames.ndim >= 1 else 0
            if count <= 0:
                status = f"已找到视频但未能读取到尾帧，已输出空帧并继续：{video_path.name}"
                return {
                    "ui": {"text": [status]},
                    "result": (_empty_image_batch(), str(video_path), status, 0),
                }
            status = f"已按时间戳读取最新视频尾帧：{video_path.name}，时间：{_format_video_timestamp(video_path)}，返回 {count} / {requested} 帧。"
            return {
                "ui": {"text": [status]},
                "result": (frames, str(video_path), status, count),
            }
        except Exception as exc:
            status = f"读取最新视频尾帧失败，已输出空帧并继续：{video_path.name}；{exc}"
            return {
                "ui": {"text": [status]},
                "result": (_empty_image_batch(), str(video_path), status, 0),
            }


class GJJ_FFmpegMuxAudioVideo:
    CATEGORY = "GJJ/视频"
    FUNCTION = "mux"
    OUTPUT_NODE = True
    DESCRIPTION = "用 FFmpeg 把图片帧、视频路径或同前缀分段视频按序号合并，并可选封入音频。适合长视频分段保存后的最终合并。"
    SEARCH_ALIASES = ["ffmpeg mux", "audio video", "音视频合并", "分段合并", "长视频合并"]
    RETURN_TYPES = ("STRING", "FLOAT", "INT")
    RETURN_NAMES = ("输出视频路径", "视频时长", "总帧数")
    OUTPUT_TOOLTIPS = ("合并后视频文件路径。", "输出视频时长秒。", "输出视频帧数估算。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "filename_prefix": ("STRING", {"default": "GJJ/ffmpeg/mux", "display_name": "", "tooltip": "内部兼容字段：旧工作流文件名前缀。新工作流请把 STRING 前缀接到图片帧入口。", "display": "hidden", "hidden": True}),
                "default_fps": ("STRING", {"default": "30.0", "display_name": "", "tooltip": "内部默认帧率；帧率输入未连接或无法解析时使用。用 STRING 保持旧工作流错位值也不会阻断执行。", "display": "hidden", "hidden": True}),
                "delete_tail_frame": ("INT", {"default": 0, "min": 0, "max": 10001, "step": 1, "display_name": "删除尾帧数", "tooltip": "0 表示不删除；大于 0 时自动递进为 1、5、9、13...。合并分段视频时会删除每个非最后分段的尾部帧，避免分段边界重复。"}),
                "ffmpeg_path": ("STRING", {"default": "", "display_name": "", "tooltip": "内部高级参数：ffmpeg 可执行文件路径。留空时自动查找。", "display": "hidden", "hidden": True}),
                "ffprobe_path": ("STRING", {"default": "", "display_name": "", "tooltip": "内部高级参数：ffprobe 可执行文件路径。留空时自动查找。", "display": "hidden", "hidden": True}),
                "delete_segments_after_merge": ("BOOLEAN", {"default": False, "display_name": "合并后删除片段", "tooltip": "开启后，合并成功并生成最终视频后删除参与合并的原始片段文件；不会删除输出成品。"}),
            },
            "optional": {
                "condition": ("BOOLEAN", {"default": True, "display_name": "条件通行", "tooltip": "可选布尔门控；未连接时默认为真。为假时本节点不执行，下游到此停止。"}),
                "images": (MEDIA_FRAME_INPUT_TYPE, {"display_name": "图片帧（文件）", "tooltip": "可选。支持 GJJ_BATCH_IMAGE、IMAGE、VIDEO、STRING。STRING 可是视频文件路径或分段视频前缀。"}),
                "audio": (AUDIO_INPUT_TYPE, {"display_name": "音频", "tooltip": "可选。支持 AUDIO、VIDEO、STRING。VIDEO/STRING 会尽量解析其中的音频轨道或文件路径。"}),
                "fps": (FPS_INPUT_TYPE, {"display_name": "帧率", "tooltip": "可选。支持 INT、FLOAT、STRING、VIDEO；接 VIDEO 时读取其 frame_rate。"}),
                "video_path": ("STRING", {"default": "", "display_name": "", "tooltip": "内部兼容字段：旧工作流视频路径。新工作流请使用图片帧/文件名前缀入口。", "display": "hidden", "hidden": True}),
                "audio_path": ("STRING", {"default": "", "display_name": "", "tooltip": "内部兼容字段：旧工作流音频路径。新工作流请使用音频入口。", "display": "hidden", "hidden": True}),
                "wait_for": (any_type, {"display_name": "等待完成", "tooltip": "任意类型依赖输入；不参与合并，只用于等待最后一段或其它上游节点执行完成后再开始合并。"}),
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        filename_prefix: str,
        default_fps: Any = "30.0",
        delete_tail_frame: Any = 0,
        ffmpeg_path: str = "",
        ffprobe_path: str = "",
        condition: bool = True,
        images=None,
        audio=None,
        fps=None,
        video_path: str = "",
        audio_path: str = "",
        delete_segments_after_merge: bool = False,
        wait_for=None,
        **kwargs,
    ):
        prefix_from_images = _segment_prefix_text(_first_text_hint(images))
        effective_prefix = prefix_from_images or str(filename_prefix or "").strip() or "GJJ/ffmpeg/mux"
        delete_tail_count = _normalize_tail_frame_count(delete_tail_frame)
        return "|".join(
            [
                str(_condition_enabled(condition)),
                str(delete_tail_count),
                str(_fps_from_value(fps, default_fps)),
                effective_prefix,
                _prefixed_videos_signature(effective_prefix),
                str(_first_text_hint(audio)),
                str(_first_text_hint(video_path)),
                str(_first_text_hint(audio_path)),
                str(_condition_enabled(delete_segments_after_merge)),
                _dependency_signature(wait_for),
            ]
        )

    def mux(
        self,
        filename_prefix: str,
        default_fps: Any = "30.0",
        delete_tail_frame: Any = 0,
        ffmpeg_path: str = "",
        ffprobe_path: str = "",
        condition: bool = True,
        images=None,
        audio=None,
        fps=None,
        video_path: str = "",
        audio_path: str = "",
        delete_segments_after_merge: bool = False,
        wait_for=None,
    ):
        if not _condition_enabled(condition):
            return {
                "ui": {"text": ["条件通行关闭，音视频合并节点已跳过。"]},
                "result": ("", 0.0, 0),
            }

        ffmpeg = _ffmpeg(ffmpeg_path)
        ffprobe = _ffprobe(ffprobe_path, ffmpeg)
        prefix_from_images = _segment_prefix_text(_first_text_hint(images))
        effective_prefix = prefix_from_images or str(filename_prefix or "").strip() or "GJJ/ffmpeg/mux"
        fps_value = _fps_from_value(fps, default_fps)
        delete_tail_count = _normalize_tail_frame_count(delete_tail_frame)
        delete_segments_enabled = _condition_enabled(delete_segments_after_merge)
        output_path = _unique_output_path(effective_prefix, ".mp4", marker="Merged")
        preview_segments: list[Path] = []
        segment_cleanup_paths: list[Path] = []
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            source_audio_from_video = None
            source_fps_from_video = None
            segment_prefix = prefix_from_images or effective_prefix
            prefix_video_paths = _find_prefixed_videos(segment_prefix) if segment_prefix else []
            image_video_paths = [] if prefix_video_paths else _collect_media_paths(images, VIDEO_SUFFIXES)
            if not prefix_video_paths:
                image_video_paths.extend(_collect_media_paths(video_path, VIDEO_SUFFIXES))

            if prefix_video_paths:
                segments = prefix_video_paths
            elif image_video_paths:
                segments = image_video_paths
            else:
                segments = []

            if segments:
                preview_segments = list(segments)
                segment_cleanup_paths.extend(segments)
                if delete_tail_count > 0 and len(segments) > 1:
                    trimmed_segments = []
                    for index, segment in enumerate(segments):
                        if index < len(segments) - 1:
                            trimmed_segments.append(_trim_tail_frames(segment, delete_tail_count, fps_value, tmp_path, ffmpeg, ffprobe))
                        else:
                            trimmed_segments.append(segment)
                    segments = trimmed_segments
                source_video = tmp_path / "concat_source.mp4"
                _concat_videos(segments, source_video, ffmpeg)
            else:
                frame_tensor, source_audio_from_video, source_fps_from_video = _tensor_from_media(images)
                if source_fps_from_video:
                    fps_value = _fps_from_value(source_fps_from_video, fps_value)

            if not segments and frame_tensor is not None:
                if delete_tail_count > 0 and int(frame_tensor.shape[0]) > 1:
                    keep_frames = max(1, int(frame_tensor.shape[0]) - delete_tail_count)
                    frame_tensor = frame_tensor[:keep_frames].contiguous()
                frame_pattern = _write_frames(frame_tensor, tmp_path)
                source_video = tmp_path / "source.mp4"
                _run([ffmpeg, "-y", "-framerate", str(float(fps_value)), "-i", frame_pattern, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source_video)])
            elif not segments:
                direct_video = _resolve_media_path(images, VIDEO_SUFFIXES) or _resolve_media_path(video_path, VIDEO_SUFFIXES)
                if direct_video is not None:
                    source_video = direct_video
                else:
                    segments = _find_prefixed_videos(segment_prefix) if segment_prefix else []
                    if not segments:
                        raise RuntimeError(
                            "请把要合并的视频片段、图片帧，或分段视频文件名前缀连接到“图片帧”入口。"
                            f"\n当前收到：图片帧={_media_input_summary(images)}；"
                            f"旧视频路径={_media_input_summary(video_path)}；"
                            f"搜索前缀={segment_prefix or '空'}。"
                        )
                    segment_cleanup_paths.extend(segments)
                    if delete_tail_count > 0 and len(segments) > 1:
                        trimmed_segments = []
                        for index, segment in enumerate(segments):
                            if index < len(segments) - 1:
                                trimmed_segments.append(_trim_tail_frames(segment, delete_tail_count, fps_value, tmp_path, ffmpeg, ffprobe))
                            else:
                                trimmed_segments.append(segment)
                        segments = trimmed_segments
                    source_video = tmp_path / "concat_source.mp4"
                    _concat_videos(segments, source_video, ffmpeg)

            source_audio = _resolve_audio_source(audio, audio_path, tmp_path)
            if source_audio is None and source_audio_from_video is not None:
                source_audio = _resolve_audio_source(source_audio_from_video, "", tmp_path)

            if source_audio is not None:
                _run([
                    ffmpeg,
                    "-y",
                    "-i",
                    str(source_video),
                    "-i",
                    str(source_audio),
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0?",
                    "-shortest",
                    "-c:v",
                    "copy",
                    "-c:a",
                    "aac",
                    str(output_path),
                ])
            else:
                if Path(source_video).resolve() != output_path.resolve():
                    shutil.copy2(source_video, output_path)

        info = _safe_output_info(output_path, ffprobe, fps_value)
        preview = _preview_item(output_path, "output", "video/mp4")
        width = int(info[1])
        height = int(info[2])
        if width <= 0 or height <= 0:
            width, height = _video_dimensions_from_first_segment(preview_segments, ffprobe)
        timing_text = _segment_timing_text(segment_cleanup_paths)
        cleanup_text = ""
        if delete_segments_enabled:
            if output_path.is_file() and segment_cleanup_paths:
                deleted_count, delete_errors = _delete_merged_segment_files(segment_cleanup_paths, output_path)
                cleanup_text = f"\n已删除片段：{deleted_count} 个"
                if delete_errors:
                    cleanup_text += f"，失败 {len(delete_errors)} 个：{' | '.join(delete_errors[:3])}"
            elif not segment_cleanup_paths:
                cleanup_text = "\n已开启合并后删除片段，但本次没有可删除的原始片段。"
            else:
                cleanup_text = "\n已开启合并后删除片段，但未确认输出成品存在，已跳过删除。"
        preview.update(
            {
                "format": "video/h264-mp4",
                "frame_rate": float(info[3] or fps_value or 0.0),
                "width": int(width),
                "height": int(height),
                "frame_count": int(info[4]),
            }
        )
        ui_payload = {
            "preview_main_path": (str(output_path),),
            "preview_format": ("video/h264-mp4",),
            "preview_is_video": (True,),
            "preview_width": (int(width),),
            "preview_height": (int(height),),
            "preview_media": [preview],
            "text": [f"已合并：{output_path.name}\n时长：{float(info[5]):.3f} 秒，帧数：{int(info[4])}{timing_text}{cleanup_text}"],
        }
        return {"ui": ui_payload, "result": (str(output_path), float(info[5]), int(info[4]))}


NODE_CLASS_MAPPINGS = {
    "GJJ_VideoInfo": GJJ_VideoInfo,
    "GJJ_VideoFramesLoader": GJJ_VideoFramesLoader,
    "GJJ_LatestVideoTailFrames": GJJ_LatestVideoTailFrames,
    "GJJ_FFmpegMuxAudioVideo": GJJ_FFmpegMuxAudioVideo,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_VideoInfo": "GJJ · 🎞️ 视频信息读取",
    "GJJ_VideoFramesLoader": "GJJ · 🎞️ 视频抽帧",
    "GJJ_LatestVideoTailFrames": "GJJ · 🎞️ 最新视频尾帧",
    "GJJ_FFmpegMuxAudioVideo": "GJJ · 🔊 音视频合并",
}
