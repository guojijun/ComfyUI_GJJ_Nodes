from __future__ import annotations

import os
import ast
import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageFile, ImageOps, ImageSequence, UnidentifiedImageError

from .common_utils.network_media import (
    MEDIA_COPY_SUBDIR,
    gjjutils_detect_media_type as _detect_media_type,
    gjjutils_download_network_media_to_input as _download_network_media_to_input,
    gjjutils_input_relative_media_path as _input_relative_media_path,
    gjjutils_is_network_url as _is_network_url,
)

# =========================
# GJJ MEDIA V2 PATCH
# =========================

def _register_template_params_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    server = getattr(PromptServer, "instance", None)
    routes = getattr(server, "routes", None)
    if server is None or routes is None:
        return
    if getattr(server, "_gjj_template_params_routes_registered", False):
        return
    setattr(server, "_gjj_template_params_routes_registered", True)

    @routes.post("/gjj/template_params/download_media")
    async def download_media(request):
        try:
            data = await request.json()
        except Exception:
            data = {}

        url = str(data.get("url") or "").strip()
        media_type = str(data.get("media_type") or _detect_media_type(url) or "").upper()
        if not _is_network_url(url):
            return web.json_response({"error": "只支持 http/https 网络媒体地址。"}, status=400)
        if media_type not in {"IMAGE", "AUDIO", "VIDEO"}:
            return web.json_response({"error": "无法识别媒体类型。"}, status=400)

        try:
            file_path = _download_network_media_to_input(url, media_type)
        except Exception as exc:
            return web.json_response({"ok": False, "error": f"下载失败：{exc}"})

        return web.json_response({
            "ok": True,
            "filename": _input_relative_media_path(file_path),
            "name": Path(file_path).name,
            "media_type": media_type,
        })


_register_template_params_routes()


def _image_to_rgb_array(image: Image.Image, target_size: tuple[int, int] | None = None) -> np.ndarray:
    """把单帧 PIL 图像转成 RGB float array；多帧 WebP/GIF 也走同一套。"""
    frame = ImageOps.exif_transpose(image)
    if frame.mode in {"RGBA", "LA"} or ("transparency" in getattr(frame, "info", {})):
        frame = frame.convert("RGBA")
        background = Image.new("RGBA", frame.size, (0, 0, 0, 0))
        background.alpha_composite(frame)
        frame = background.convert("RGB")
    else:
        frame = frame.convert("RGB")
    if target_size and frame.size != target_size:
        frame = frame.resize(target_size, Image.Resampling.LANCZOS)
    return np.asarray(frame).astype(np.float32) / 255.0


def _load_image_arrays_from_path(file_path: str) -> list[np.ndarray]:
    with Image.open(file_path) as img:
        frame_count = max(1, int(getattr(img, "n_frames", 1) or 1))
        if frame_count <= 1:
            img.load()
            return [_image_to_rgb_array(img)]

        arrays: list[np.ndarray] = []
        target_size: tuple[int, int] | None = None
        for frame in ImageSequence.Iterator(img):
            frame_copy = frame.copy()
            frame_copy.load()
            if target_size is None:
                target_size = frame_copy.size
            arrays.append(_image_to_rgb_array(frame_copy, target_size))
        return arrays or [_image_to_rgb_array(img)]


def _load_image_from_path(file_path: str) -> torch.Tensor:
    """从文件路径加载图片为 ComfyUI 标准 IMAGE tensor: [B, H, W, 3] RGB float32；WebP/GIF 多帧会作为 batch 输出。"""
    try:
        try:
            arrays = _load_image_arrays_from_path(file_path)
        except UnidentifiedImageError:
            old_load_truncated = ImageFile.LOAD_TRUNCATED_IMAGES
            ImageFile.LOAD_TRUNCATED_IMAGES = True
            try:
                arrays = _load_image_arrays_from_path(file_path)
            finally:
                ImageFile.LOAD_TRUNCATED_IMAGES = old_load_truncated
        return torch.from_numpy(np.stack(arrays, axis=0)).contiguous()
    except Exception as e:
        raise ValueError(f"加载图片失败：{file_path}，错误：{e}") from e


def _load_audio_object(file_path: str) -> dict[str, Any]:
    """从文件路径加载音频为 ComfyUI 标准 AUDIO 对象。"""
    primary_error: Exception | None = None
    try:
        from comfy_extras.nodes_audio import load as load_audio

        waveform, sample_rate = load_audio(file_path)
        return {"waveform": waveform.unsqueeze(0).contiguous(), "sample_rate": int(sample_rate)}
    except Exception as e:
        primary_error = e

    try:
        import av

        with av.open(file_path) as container:
            if not container.streams.audio:
                raise ValueError("No audio stream found")
            stream = container.streams.audio[0]
            sample_rate = int(stream.codec_context.sample_rate)
            frames = []
            for frame in container.decode(streams=stream.index):
                buf = torch.from_numpy(frame.to_ndarray())
                if buf.shape[0] != stream.channels:
                    buf = buf.view(-1, stream.channels).t()
                frames.append(buf)
            if not frames:
                raise ValueError("No audio frames decoded")
            waveform = torch.cat(frames, dim=1)
            if waveform.dtype != torch.float32:
                if waveform.dtype == torch.int16:
                    waveform = waveform.float() / 32768.0
                elif waveform.dtype == torch.int32:
                    waveform = waveform.float() / 2147483648.0
                elif waveform.is_floating_point():
                    waveform = waveform.float()
                else:
                    raise ValueError(f"Unsupported audio dtype: {waveform.dtype}")
            return {"waveform": waveform.unsqueeze(0).contiguous(), "sample_rate": sample_rate}
    except Exception as fallback_error:
        raise RuntimeError(
            f"加载音频失败：{file_path}，ComfyUI加载器错误：{primary_error}；PyAV回退错误：{fallback_error}"
        ) from fallback_error


def _load_video_from_path(file_path: str):
    """从文件路径加载视频为 Video 对象"""
    first_error: Exception | None = None
    try:
        from comfy_api.latest import InputImpl
        return InputImpl.VideoFromFile(file_path)
    except Exception as e:
        first_error = e
        print(f"[GJJ_TemplateParams] 加载视频失败: {file_path}, 错误: {e}")
        # 回退到 Tensor 格式（兼容旧版）
        try:
            import av
            frames = []
            container = av.open(file_path)
            for frame in container.decode(video=0):
                rgb = frame.to_ndarray(format="rgb24")
                tensor = torch.from_numpy(rgb).float() / 255.0
                frames.append(tensor)
            container.close()
            if frames:
                return torch.stack(frames)
        except Exception as fallback_error:
            raise RuntimeError(
                f"加载视频失败：{file_path}，错误：{fallback_error}"
            ) from fallback_error
        raise RuntimeError(f"加载视频失败：{file_path}，未读取到视频帧。原始错误：{first_error}")


def _configured_media_roots() -> dict[str, str]:
    return {
        "input": folder_paths.get_input_directory(),
        "output": folder_paths.get_output_directory(),
        "temp": folder_paths.get_temp_directory(),
    }


def _path_exists(path: str | os.PathLike[str]) -> str | None:
    try:
        resolved = Path(path).expanduser()
        if resolved.exists():
            return str(resolved)
    except Exception:
        return None
    return None


def _is_inside_configured_root(file_path: str, roots: dict[str, str]) -> bool:
    try:
        abs_file = os.path.normcase(os.path.abspath(file_path))
    except Exception:
        return False
    for root_path in roots.values():
        if not root_path:
            continue
        try:
            abs_root = os.path.normcase(os.path.abspath(root_path))
            if os.path.commonpath([abs_file, abs_root]) == abs_root:
                return True
        except Exception:
            continue
    return False


def _safe_copy_name(file_path: str) -> str:
    path = Path(file_path)
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", path.name).strip(" ._") or "media"
    safe_path = Path(safe_name)
    stem = safe_path.stem or "media"
    suffix = safe_path.suffix
    try:
        stat = path.stat()
        fingerprint = f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}"
    except Exception:
        fingerprint = str(path.resolve())
    digest = hashlib.sha1(fingerprint.encode("utf-8", "ignore")).hexdigest()[:10]
    return f"{stem}_{digest}{suffix}"


def _copy_external_media_to_input(file_path: str) -> str:
    roots = _configured_media_roots()
    if _is_inside_configured_root(file_path, roots):
        return file_path

    src = Path(file_path)
    dest_dir = Path(roots["input"]) / MEDIA_COPY_SUBDIR
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / _safe_copy_name(file_path)
    if not dest.exists():
        shutil.copy2(src, dest)
    return str(dest)


def _clean_media_reference(filename: str) -> tuple[str, str]:
    media_type_hint = ""
    text = str(filename or "").strip()
    parsed = urlparse(text)

    if parsed.scheme.lower() in {"http", "https"}:
        return text, media_type_hint

    if parsed.scheme == "file":
        path = unquote(parsed.path or "")
        if os.name == "nt" and re.match(r"^/[A-Za-z]:/", path):
            path = path[1:]
        if parsed.netloc and not path.startswith(("\\", "/")):
            path = f"//{parsed.netloc}/{path}"
        return path, media_type_hint

    if parsed.path.endswith("/view") and parsed.query:
        query = parse_qs(parsed.query)
        name = query.get("filename", [""])[0]
        subfolder = query.get("subfolder", [""])[0]
        media_type_hint = query.get("type", [""])[0].strip().lower()
        text = os.path.join(subfolder, name) if subfolder else name

    text = unquote(text).strip().strip('"').strip("'")
    if os.name == "nt" and re.match(r"^/[A-Za-z]:[/\\]", text):
        text = text[1:]
    return text.replace("\\", os.sep).replace("/", os.sep), media_type_hint


def _resolve_media_file(filename: str, media_type: str | None = None) -> str | None:
    """解析媒体文件路径：支持 input/output/temp、其它相对路径和绝对路径。"""
    if not filename or not str(filename).strip():
        return None

    raw_filename = str(filename).strip()
    if _is_network_url(raw_filename):
        inferred_type = media_type or _detect_media_type(raw_filename)
        if not inferred_type:
            return None
        return _download_network_media_to_input(raw_filename, inferred_type)

    filename, media_type_hint = _clean_media_reference(filename)
    roots = _configured_media_roots()
    lowered = filename.lower()

    if media_type_hint in roots:
        stripped = filename
        prefix = media_type_hint + os.sep
        if lowered.startswith(prefix):
            stripped = filename[len(prefix):]
        found = _path_exists(Path(roots[media_type_hint]) / stripped)
        if found:
            return found

    if os.path.isabs(filename):
        return _path_exists(filename)

    for root_key, root_path in roots.items():
        prefix = root_key + os.sep
        if lowered.startswith(prefix):
            found = _path_exists(Path(root_path) / filename[len(prefix):])
            if found:
                return found
            break

    for base in (Path.cwd(), Path(roots["input"])):
        found = _path_exists(base / filename)
        if found:
            return found

    for root_path in roots.values():
        found = _path_exists(Path(root_path) / filename)
        if found:
            return found

    return None


def _load_media_object(filename: str, media_type: str) -> Any:
    """根据类型加载媒体对象"""
    file_path = _resolve_media_file(filename, media_type)
    if not file_path:
        if media_type in {"IMAGE", "AUDIO", "VIDEO"}:
            label = {"IMAGE": "图片", "AUDIO": "音频", "VIDEO": "视频"}.get(media_type, "媒体")
            raise FileNotFoundError(
                f"找不到{label}文件：{filename}。请用 📁 重新选择，节点会先复制到 ComfyUI input 后再解析。"
            )
        raise ValueError(f"不支持的媒体类型: {media_type}")

    file_path = _copy_external_media_to_input(file_path)

    try:
        if media_type == "IMAGE":
            return _load_image_from_path(file_path)
        elif media_type == "AUDIO":
            return _load_audio_object(file_path)
        elif media_type == "VIDEO":
            return _load_video_from_path(file_path)
    except Exception as e:
        if media_type == "IMAGE":
            raise
        elif media_type == "AUDIO":
            raise RuntimeError(f"加载音频失败：{filename}，错误：{e}") from e
        elif media_type == "VIDEO":
            raise RuntimeError(f"加载视频失败：{filename}，错误：{e}") from e
        raise


def _media_label(media_type: str) -> str:
    return {"IMAGE": "图片", "AUDIO": "音频", "VIDEO": "视频"}.get(media_type, "媒体")


def _display_media_reference(value: Any) -> str:
    text = _normalize_text(value).strip()
    if not text:
        return "空路径"
    cleaned, _hint = _clean_media_reference(text)
    cleaned = cleaned.replace("\\", "/").strip()
    for root_name in ("input", "output", "temp"):
        prefix = f"{root_name}/"
        if cleaned.lower().startswith(prefix):
            cleaned = cleaned[len(prefix):]
            break
    name = cleaned.rsplit("/", 1)[-1] or cleaned
    return name if len(name) <= 80 else f"{name[:36]}...{name[-36:]}"


def _build_media_warning(label: str, media_type: str, raw_value: Any, exc: Exception) -> str:
    media_label = _media_label(media_type)
    ref = _display_media_reference(raw_value)
    if isinstance(exc, FileNotFoundError):
        reason = "文件不存在"
    else:
        reason = "加载失败"
    field = label or "未命名参数"
    return f"{field}：{reason}，已跳过{media_label}输出，不中断工作流。文件：{ref}"


NODE_NAME = "GJJ_TemplateParams"
MAX_OUTPUTS = 20


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _normalize_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _safe_json_loads(value: Any, fallback: Any) -> Any:
    if not isinstance(value, str) or not value.strip():
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def _strip_quotes(text: str) -> str:
    raw = text.strip()
    if len(raw) >= 6 and raw[:3] == raw[-3:] and raw[:3] in {'"""', "'''"}:
        inner = raw[3:-3]
        if inner.startswith("\n"):
            inner = inner[1:]
        if inner.endswith("\n"):
            inner = inner[:-1]
        return inner
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'"', "'"}:
        return raw[1:-1]
    return raw


def _is_string_literal_text(text: Any) -> bool:
    raw = _normalize_text(text).strip()
    return (
        len(raw) >= 6 and raw[:3] == raw[-3:] and raw[:3] in {'"""', "'''"}
    ) or (
        len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'"', "'"}
    )


def _scan_triple_quote_state(text: str, quote: str | None = None) -> str | None:
    escaped = False
    index = 0
    raw = str(text or "")
    while index < len(raw):
        ch = raw[index]
        if escaped:
            escaped = False
            index += 1
            continue
        if ch == "\\":
            escaped = True
            index += 1
            continue
        if quote:
            if raw.startswith(quote, index):
                quote = None
                index += 3
                continue
            index += 1
            continue
        if raw.startswith('"""', index) or raw.startswith("'''", index):
            quote = raw[index : index + 3]
            index += 3
            continue
        index += 1
    return quote


def _is_empty_assignment_line(line: str) -> bool:
    return re.match(r"^([^:=：=]+?)\s*[:：=]\s*$", str(line or "").strip()) is not None


def _line_starts_triple_quote(line: str) -> bool:
    return str(line or "").lstrip().startswith(('"""', "'''"))


def _template_logical_lines(template_text: Any) -> list[str]:
    text = _normalize_text(template_text).replace("\r\n", "\n").replace("\r", "\n")
    result: list[str] = []
    current: list[str] = []
    quote: str | None = None
    pending_empty_value = False
    lines = text.split("\n")
    index = 0

    def flush_current() -> None:
        nonlocal current, pending_empty_value
        logical = "\n".join(current).strip()
        if logical:
            result.append(logical)
        current = []
        pending_empty_value = False

    while index < len(lines):
        line = lines[index]
        raw = line.strip()

        if quote is not None:
            current.append(line)
            quote = _scan_triple_quote_state(line, quote)
            if quote is None:
                flush_current()
            index += 1
            continue

        if pending_empty_value:
            if not raw:
                current.append(line)
                index += 1
                continue
            if raw.startswith(("#", "//", ";")) or raw in {"...", "....", "……", "…"}:
                index += 1
                continue
            if _line_starts_triple_quote(line):
                current.append(line)
                quote = _scan_triple_quote_state(line, quote)
                if quote is None:
                    flush_current()
                index += 1
                continue
            flush_current()
            continue

        if not current and (not raw or raw.startswith(("#", "//", ";")) or raw in {"...", "....", "……", "…"}):
            index += 1
            continue

        current.append(line)
        quote = _scan_triple_quote_state(line, quote)
        if quote is not None:
            index += 1
            continue
        if _is_empty_assignment_line(line):
            pending_empty_value = True
            index += 1
            continue
        flush_current()
        index += 1

    if current:
        flush_current()
    return result


def _split_value_and_tooltip(text: str) -> tuple[str, str]:
    r"""Split `值 # 提示` into (值, 提示). Supports escaping literal # with \#."""
    raw = str(text or "")
    escaped = False
    triple_quote: str | None = None
    quote: str | None = None
    index = 0
    while index < len(raw):
        ch = raw[index]
        if escaped:
            escaped = False
            index += 1
            continue
        if ch == "\\":
            escaped = True
            index += 1
            continue
        if triple_quote:
            if raw.startswith(triple_quote, index):
                triple_quote = None
                index += 3
                continue
            index += 1
            continue
        if quote is None and (raw.startswith('"""', index) or raw.startswith("'''", index)):
            triple_quote = raw[index : index + 3]
            index += 3
            continue
        if ch in {'"', "'"}:
            if quote == ch:
                quote = None
            elif quote is None:
                quote = ch
            index += 1
            continue
        if ch == "#" and quote is None:
            value = raw[:index].replace("\\#", "#").strip()
            tooltip = raw[index + 1 :].strip()
            return value, tooltip
        index += 1
    return raw.replace("\\#", "#").strip(), ""


def _split_enum_options(inner: str) -> list[str]:
    options: list[str] = []
    escaped = False
    quote: str | None = None
    current: list[str] = []
    for ch in str(inner or ""):
        if escaped:
            current.append(ch)
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch in {'"', "'"}:
            if quote == ch:
                quote = None
                continue
            if quote is None:
                quote = ch
                continue
        if ch in {",", "，", "|"} and quote is None:
            option = "".join(current).strip()
            if option:
                options.append(_strip_quotes(option))
            current = []
            continue
        current.append(ch)
    option = "".join(current).strip()
    if option:
        options.append(_strip_quotes(option))
    return options


def _split_pipe_pair(text: str) -> tuple[str, str]:
    parts = _split_enum_options(text)
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], parts[0]
    return parts[0], parts[1]


def _parse_option_item(value: Any) -> dict[str, str]:
    if isinstance(value, dict):
        label = _normalize_text(value.get("label") or value.get("name") or value.get("text") or value.get("value")).strip()
        option_value = _normalize_text(value.get("value") or value.get("id") or label).strip()
        return {"label": label or option_value, "value": option_value or label}
    raw = _strip_quotes(_normalize_text(value)).strip()
    assign_match = re.fullmatch(r"(.+?)\s*(?:=>|=|:|：)\s*(.+)", raw)
    if assign_match:
        label = assign_match.group(1).strip()
        option_value = assign_match.group(2).strip()
        return {"label": label or option_value, "value": option_value or label}
    match = re.fullmatch(r"(.+?)[（(]\s*([^（）()]+?)\s*[）)]", raw)
    if match:
        label = match.group(1).strip()
        option_value = match.group(2).strip()
        return {"label": label or option_value, "value": option_value or label}
    return {"label": raw, "value": raw}


def _parse_enum_options(default_text: Any, tooltip: str = "") -> list[dict[str, str]]:
    raw = str(default_text or "").strip()
    if not (raw.startswith("[") and raw.endswith("]")):
        return []
    inner = raw[1:-1].strip()
    if not inner:
        return []
    tooltip_lower = str(tooltip or "").lower()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list) and ("枚举" in tooltip_lower or "enum" in tooltip_lower):
            return [_parse_option_item(item) for item in parsed]
        return []
    except Exception:
        pass
    return [_parse_option_item(item) for item in _split_enum_options(inner)]


def _option_value(option: Any) -> str:
    if isinstance(option, dict):
        return _normalize_text(option.get("value") or option.get("label")).strip()
    return _normalize_text(option).strip()


def _option_label(option: Any) -> str:
    if isinstance(option, dict):
        return _normalize_text(option.get("label") or option.get("value")).strip()
    return _normalize_text(option).strip()


def _coerce_enum_value(raw_value: Any, options: list[Any]) -> str:
    if not options:
        return _normalize_text(raw_value)
    text = _normalize_text(raw_value).strip()
    for option in options:
        if text in {_option_value(option), _option_label(option)}:
            return _option_value(option)
    nested_options = _parse_enum_options(text, "枚举")
    if nested_options:
        return _option_value(nested_options[0])
    return _option_value(options[0])


def _coerce_bool_value(raw_value: Any, bool_labels: dict[str, str] | None = None) -> bool:
    if isinstance(raw_value, bool):
        return raw_value
    labels = bool_labels or {}
    text = _normalize_text(raw_value).strip()
    if text and text == _normalize_text(labels.get("true_label")).strip():
        return True
    if text and text == _normalize_text(labels.get("false_label")).strip():
        return False
    parsed = parse_value(raw_value)
    if isinstance(parsed, bool):
        return parsed
    return bool(parsed)


def _parse_bool_spec(default_text: Any) -> tuple[bool | None, dict[str, str] | None]:
    raw = str(default_text or "").strip()
    brace_match = re.fullmatch(r"(?is)\s*(true|false|yes|no|on|off|1|0|是|否|开|关)?\s*[{｛]\s*(.*?)\s*[}｝]\s*", raw)
    if brace_match:
        default_raw = (brace_match.group(1) or "true").strip()
        true_label, false_label = _split_pipe_pair(brace_match.group(2).strip())
        return parse_value(default_raw) is True, {
            "true_label": true_label or "开启",
            "false_label": false_label or "关闭",
        }

    match = re.fullmatch(r"(?is)\s*(?:bool|boolean)\s*\((.*)\)\s*", raw)
    if not match:
        return None, None
    inner = match.group(1).strip()
    parts = _split_enum_options(inner)
    if len(parts) < 2:
        return None, None
    default_value = True
    if len(parts) >= 3 and isinstance(parse_value(parts[0]), bool):
        default_value = parse_value(parts[0]) is True
        true_label, false_label = parts[1], parts[2]
    else:
        true_label, false_label = _split_pipe_pair(inner)
    if not true_label and not false_label:
        return None, None
    return default_value, {
        "true_label": true_label or "开启",
        "false_label": false_label or "关闭",
    }


def parse_value(value: Any) -> Any:
    """Parse widget text into int/float/bool/json when it is clearly typed.

    Non-string values are passed through unchanged.
    Supported forced forms: int(...), float(...), str(...), bool(...), json(...).
    """
    if not isinstance(value, str):
        return value
    raw = value.strip()
    if raw == "":
        return ""

    forced = re.fullmatch(r"(?is)\s*(int|float|str|string|bool|boolean|json)\s*\((.*)\)\s*", raw)
    if forced:
        kind = forced.group(1).lower()
        inner = forced.group(2).strip()
        if kind == "int":
            return int(float(_strip_quotes(inner)))
        if kind == "float":
            return float(_strip_quotes(inner))
        if kind in {"str", "string"}:
            return _strip_quotes(inner)
        if kind in {"bool", "boolean"}:
            lowered = _strip_quotes(inner).strip().lower()
            if lowered in {"1", "true", "yes", "y", "on", "是", "真"}:
                return True
            if lowered in {"0", "false", "no", "n", "off", "否", "假"}:
                return False
            return bool(lowered)
        if kind == "json":
            return json.loads(inner)

    if _is_string_literal_text(raw):
        return _strip_quotes(raw)

    lowered = raw.lower()
    if lowered in {"true", "yes", "on", "是", "真"}:
        return True
    if lowered in {"false", "no", "off", "否", "假"}:
        return False
    if lowered in {"none", "null", "nil"}:
        return None

    if re.fullmatch(r"[-+]?\d+", raw):
        try:
            return int(raw)
        except Exception:
            pass
    if re.fullmatch(r"[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?", raw) or re.fullmatch(r"[-+]?\d+[eE][-+]?\d+", raw):
        try:
            return float(raw)
        except Exception:
            pass

    if (raw.startswith("[") and raw.endswith("]")) or (raw.startswith("{") and raw.endswith("}")):
        try:
            return json.loads(raw)
        except Exception:
            try:
                return ast.literal_eval(raw)
            except Exception:
                return raw

    return value


def _infer_type(value: Any) -> str:
    media_type = _detect_media_type(value)

    if media_type:
        return media_type

    if isinstance(value, bool):
        return "BOOLEAN"
    if isinstance(value, int) and not isinstance(value, bool):
        return "INT"
    if isinstance(value, float):
        return "FLOAT"
    if isinstance(value, (dict, list)):
        return "JSON"
    if value is None:
        return "NONE"
    return "STRING"


def _infer_type_from_raw(raw_text: str, parsed_value: Any) -> str:
    """从原始文本和解析后的值推断类型。"""
    raw = str(raw_text or "").strip()

    # 优先检测媒体类型
    media_type = _detect_media_type(raw)
    if media_type:
        return media_type

    # 强制格式优先
    forced = re.fullmatch(r"(?is)\s*(int|float|str|string|bool|boolean|json)\s*\((.*)\)\s*", raw)
    if forced:
        kind = forced.group(1).lower()
        if kind == "int":
            return "INT"
        if kind == "float":
            return "FLOAT"
        if kind in {"bool", "boolean"}:
            return "BOOLEAN"
        if kind == "json":
            return "*"
        return "STRING"

    # 检测浮点数（包括科学计数法）
    if re.fullmatch(r"[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?", raw) or re.fullmatch(r"[-+]?\d+[eE][-+]?\d+", raw):
        return "FLOAT"

    # 检测整数
    if re.fullmatch(r"[-+]?\d+", raw):
        return "INT"

    return _infer_type(parsed_value)


def _normalize_socket_type(value: Any) -> str:
    text = _normalize_text(value).strip()
    if not text:
        return ""
    text = text.replace("，", ",")
    text = re.sub(r"\s+", "", text)
    if text.lower() in {"any", "*"}:
        return "*"
    return text.upper()


def _split_label_and_type(raw_label: Any) -> tuple[str, str]:
    label = _normalize_text(raw_label).strip()
    match = re.search(r"\s*(?:\[\s*([^\]]+?)\s*\]|【\s*([^】]+?)\s*】)\s*$", label)
    if not match:
        return label, ""
    socket_type = _normalize_socket_type(match.group(1) or match.group(2) or "")
    return label[: match.start()].strip(), socket_type


def _sanitize_template_key(value: Any) -> str:
    key = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff-]+", "_", _normalize_text(value).strip())
    return key.strip("_")


_IMPLICIT_TEMPLATE_KEY_ALIASES = {
    "width": "width",
    "宽度": "width",
    "图像宽度": "width",
    "视频宽度": "width",
    "height": "height",
    "高度": "height",
    "图像高度": "height",
    "视频高度": "height",
    "duration": "duration",
    "seconds": "duration",
    "second": "duration",
    "secs": "duration",
    "sec": "duration",
    "time": "duration",
    "时长": "duration",
    "持续时间": "duration",
    "视频时长": "duration",
    "frame_rate": "frame_rate",
    "framerate": "frame_rate",
    "fps": "frame_rate",
    "帧率": "frame_rate",
    "每秒帧数": "frame_rate",
    "帧每秒": "frame_rate",
    "length": "length",
    "frames": "length",
    "frame_count": "length",
    "framecount": "length",
    "帧数": "length",
    "视频帧数": "length",
    "总帧数": "length",
    "wan_mode": "wan_mode",
    "video_mode": "wan_mode",
    "mode": "wan_mode",
    "模式": "wan_mode",
    "视频模式": "wan_mode",
    "生成模式": "wan_mode",
    "wan模式": "wan_mode",
    "start_image": "start_image",
    "first_image": "start_image",
    "首帧": "start_image",
    "首图": "start_image",
    "起始图": "start_image",
    "起始帧": "start_image",
    "end_image": "end_image",
    "last_image": "end_image",
    "尾帧": "end_image",
    "尾图": "end_image",
    "结束图": "end_image",
    "结束帧": "end_image",
}


def _implicit_template_key_source(label: Any) -> str:
    text = _normalize_text(label).strip()
    compact = re.sub(r"[\s_\-]+", "", text).lower()
    underscored = re.sub(r"[\s\-]+", "_", text).lower()
    return (
        _IMPLICIT_TEMPLATE_KEY_ALIASES.get(compact)
        or _IMPLICIT_TEMPLATE_KEY_ALIASES.get(underscored)
        or text
    )


def _split_label_and_broadcast_keys(raw_label: Any, index: int) -> tuple[str, str, list[str]]:
    label = _normalize_text(raw_label).strip() or f"参数 {index + 1}"
    match = re.fullmatch(r"(?s)(.+?)[（(]\s*([^（）()]+?)\s*[）)]", label)
    if not match:
        return label, _implicit_template_key_source(label), []
    label = match.group(1).strip() or label
    # 只取括号里的第一个严格变量名；不把 | / , / or 当别名展开，避免大工作流误匹配。
    first_key = re.split(r"\s*(?:\||,|，|；|;|\bor\b|或)\s*", match.group(2), maxsplit=1, flags=re.I)[0]
    broadcast_key = _sanitize_template_key(first_key) or f"param_{index + 1}"
    return label, broadcast_key, [broadcast_key]


def _unique_broadcast_keys(values: Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        key = _normalize_text(value).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(key)
    return result


def _make_unique_template_key(source: Any, index: int, seen: dict[str, int]) -> str:
    key = re.sub(r"\s+", "_", _normalize_text(source).strip())
    key = _sanitize_template_key(key) or f"param_{index + 1}"
    count = seen.get(key, 0)
    seen[key] = count + 1
    if count:
        key = f"{key}_{count + 1}"
    return key


def parse_template(template_text: Any) -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    for raw in _template_logical_lines(template_text):
        match = re.match(r"(?s)^([^:=：=]+?)\s*[:：=]\s*(.*)$", raw)
        if not match:
            continue
        typed_label, socket_type = _split_label_and_type(match.group(1).strip())
        label, key_source, broadcast_keys = _split_label_and_broadcast_keys(typed_label, len(fields))
        right = match.group(2).strip()
        if not label:
            continue
        default_text, tooltip = _split_value_and_tooltip(right)
        key = _make_unique_template_key(key_source, len(fields), seen)
        broadcast_key_list = _unique_broadcast_keys([*broadcast_keys, key]) if broadcast_keys else []
        bool_default, bool_labels = _parse_bool_spec(default_text)
        enum_options = [] if bool_labels else _parse_enum_options(default_text, tooltip)
        value = bool_default if bool_labels else (_option_value(enum_options[0]) if enum_options else parse_value(default_text))
        default_value = (
            ("true" if bool_default else "false")
            if bool_labels
            else (_option_value(enum_options[0]) if enum_options else (value if isinstance(value, str) and _is_string_literal_text(default_text) else default_text))
        )
        field = {
            "key": key,
            "label": label,
            "output_enabled": True,
            "broadcast_key": broadcast_key_list[0] if broadcast_key_list else "",
            "broadcast_keys": broadcast_key_list,
            "default": default_value,
            "value": value,
            "socket_type": socket_type,
            "type": "BOOLEAN" if bool_labels else ("ENUM" if enum_options else (socket_type or _infer_type(value))),
            "options": enum_options,
            "tooltip": tooltip,
        }
        if bool_labels:
            field["bool_labels"] = bool_labels
        fields.append(field)
        if len(fields) >= MAX_OUTPUTS:
            break
    return fields


def _apply_schema_field_settings(fields: list[dict[str, Any]], schema_json: Any) -> list[dict[str, Any]]:
    schema = _safe_json_loads(schema_json, [])
    if not isinstance(schema, list):
        return fields
    by_key = {str(item.get("key") or ""): item for item in schema if isinstance(item, dict)}
    by_label = {str(item.get("label") or ""): item for item in schema if isinstance(item, dict)}
    for field in fields:
        saved = by_key.get(str(field.get("key") or "")) or by_label.get(str(field.get("label") or ""))
        if isinstance(saved, dict) and saved.get("output_enabled") is False:
            field["output_enabled"] = False
    return fields


def values_from_json(values_json: Any) -> dict[str, Any]:
    data = _safe_json_loads(values_json, {})
    return data if isinstance(data, dict) else {}


class GJJ_TemplateParams:
    CATEGORY = "GJJ/逻辑控制"
    FUNCTION = "output_params"
    DESCRIPTION = "通过模板文本自动生成参数输入框和输出口。支持格式：帧率 (frame_rate) [INT,FLOAT]：24.0 # 浮点；也兼容 帧率：24、宽度：832、模式：图生 这类未写括号的常用参数。\n提示词：'''多段文本''' # 字符串\n是否启用：[enable,disable] # 枚举\n媒体文件会自动加载为 IMAGE/AUDIO/VIDEO 对象。⚡ 广播默认关闭，开启后只广播写了 (变量名) 的字段。"
    SEARCH_ALIASES = [
        "template params",
        "params",
        "参数模板",
        "模板参数",
        "动态输出",
        "键值参数",
    ]
    RETURN_TYPES = tuple(any_type for _ in range(MAX_OUTPUTS))
    RETURN_NAMES = tuple(f"输出{i + 1}" for i in range(MAX_OUTPUTS))
    OUTPUT_TOOLTIPS = tuple("由模板自动解析出的参数值（媒体文件会加载为对象）。" for _ in range(MAX_OUTPUTS))

    @classmethod
    def INPUT_TYPES(cls):
        default_template = "帧率 (frame_rate) [INT,FLOAT]：8.0 # 每秒帧数\n时长 (duration) [INT,FLOAT]：5 # 秒数或帧数\n宽度（width）：512\n高度（height）：512\nLora加速（use_accel_lora）：true{开启加速|关闭加速} # 布尔按钮\n提示词（positive_text_input）:首尾帧\n首帧（start_image）：https://raw.githubusercontent.com/Comfy-Org/example_workflows/refs/heads/main/wan2.1_flf2v/input/start_image.png\n尾帧（end_image）：https://raw.githubusercontent.com/Comfy-Org/example_workflows/refs/heads/main/wan2.1_flf2v/input/end_image.png"
        return {
            "required": {
                "template_text": (
                    "STRING",
                    {
                        "default": default_template,
                        "multiline": True,
                        "display": "hidden",
                        "display_name": "隐藏模板",
                        "tooltip": "由前端 ⚙️ 设置按钮维护。每行一个参数，支持格式：显示名 (严格变量名) [类型1,类型2]：默认值 # 说明；宽度/高度/时长/帧率/模式等常用参数可省略括号；提示词可用 ''' 或 \"\"\" 包裹多段文本。",
                    },
                ),
                "values_json": (
                    "STRING",
                    {
                        "default": "{}",
                        "multiline": True,
                        "display": "hidden",
                        "display_name": "参数值 JSON",
                        "tooltip": "由前端维护的参数值，不建议手动修改。",
                    },
                ),
                "schema_json": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": True,
                        "display": "hidden",
                        "display_name": "参数结构 JSON",
                        "tooltip": "由前端维护的参数结构，不建议手动修改。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(cls, template_text: str = "", values_json: str = "{}", schema_json: str = "[]"):
        return "|".join([_normalize_text(template_text), _normalize_text(values_json), _normalize_text(schema_json)])

    def output_params(self, template_text: str = "", values_json: str = "{}", schema_json: str = "[]"):
        fields = _apply_schema_field_settings(parse_template(template_text), schema_json)
        value_map = values_from_json(values_json)
        outputs: list[Any] = []
        warnings: list[str] = []
        
        for field in fields:
            key = str(field.get("key") or "")
            label = str(field.get("label") or "")
            raw_value = value_map.get(key, value_map.get(label, field.get("default", "")))
            if field.get("type") == "BOOLEAN" and field.get("bool_labels"):
                outputs.append(_coerce_bool_value(raw_value, field.get("bool_labels") or {}))
                continue
            if field.get("type") == "ENUM":
                outputs.append(_coerce_enum_value(raw_value, list(field.get("options", []))))
                continue
            
            # 检测是否为媒体文件
            media_type = _detect_media_type(str(raw_value))
            
            if media_type and isinstance(raw_value, str):
                # 媒体参数常用于模板占位或可选引用。资源缺失时只提示并跳过，
                # 避免未使用的图片/音频/视频文件打断整个工作流。
                try:
                    media_obj = _load_media_object(raw_value, media_type)
                    outputs.append(media_obj)
                except Exception as exc:
                    warning = _build_media_warning(label, media_type, raw_value, exc)
                    warnings.append(warning)
                    print(f"[GJJ_TemplateParams] {warning} 详细错误：{exc}")
                    outputs.append(None)
            else:
                # 非媒体类型：正常解析
                outputs.append(parse_value(raw_value))
        
        while len(outputs) < MAX_OUTPUTS:
            outputs.append(None)
        result = tuple(outputs[:MAX_OUTPUTS])
        if warnings:
            warning_text = "\n".join(warnings)
            return {
                "ui": {
                    "text": (warning_text,),
                    "gjj_template_params_warnings": warnings,
                },
                "result": result,
            }
        return {
            "ui": {
                "gjj_template_params_warnings": [],
            },
            "result": result,
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TemplateParams}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ⚙️ 模板参数输入器"}
