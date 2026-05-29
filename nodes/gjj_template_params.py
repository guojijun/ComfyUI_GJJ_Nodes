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
from PIL import Image, ImageFile, ImageOps, UnidentifiedImageError

# =========================
# GJJ MEDIA V2 PATCH
# =========================

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "avif", "tiff"}
AUDIO_EXTS = {"mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus", "aiff", "aif"}
VIDEO_EXTS = {"mp4", "mov", "mkv", "webm", "avi", "flv", "mpeg", "mpg", "m4v", "wmv"}
MEDIA_COPY_SUBDIR = "GJJ_TemplateParams"


def _detect_media_type(value: Any) -> str | None:
    if not isinstance(value, str):
        return None

    text = value.strip().lower()

    if "." not in text:
        return None

    ext = text.rsplit(".", 1)[-1]

    if ext in IMAGE_EXTS:
        return "IMAGE"

    if ext in AUDIO_EXTS:
        return "AUDIO"

    if ext in VIDEO_EXTS:
        return "VIDEO"

    return None


def _load_image_from_path(file_path: str) -> torch.Tensor:
    """从文件路径加载图片为 ComfyUI 标准 IMAGE tensor: [B, H, W, 3] RGB float32。"""
    try:
        try:
            with Image.open(file_path) as img:
                img.load()
                img = ImageOps.exif_transpose(img)
                img = img.convert("RGB")
                array = np.asarray(img).astype(np.float32) / 255.0
        except UnidentifiedImageError:
            old_load_truncated = ImageFile.LOAD_TRUNCATED_IMAGES
            ImageFile.LOAD_TRUNCATED_IMAGES = True
            try:
                with Image.open(file_path) as img:
                    img.load()
                    img = ImageOps.exif_transpose(img)
                    img = img.convert("RGB")
                    array = np.asarray(img).astype(np.float32) / 255.0
            finally:
                ImageFile.LOAD_TRUNCATED_IMAGES = old_load_truncated
        return torch.from_numpy(array)[None, ...]
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


def _resolve_media_file(filename: str) -> str | None:
    """解析媒体文件路径：支持 input/output/temp、其它相对路径和绝对路径。"""
    if not filename or not str(filename).strip():
        return None

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
    file_path = _resolve_media_file(filename)
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
MAX_OUTPUTS = 64


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
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'"', "'"}:
        return raw[1:-1]
    return raw


def _split_value_and_tooltip(text: str) -> tuple[str, str]:
    r"""Split `值 # 提示` into (值, 提示). Supports escaping literal # with \#."""
    raw = str(text or "")
    escaped = False
    quote: str | None = None
    for index, ch in enumerate(raw):
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch in {'"', "'"}:
            if quote == ch:
                quote = None
            elif quote is None:
                quote = ch
            continue
        if ch == "#" and quote is None:
            value = raw[:index].replace("\\#", "#").strip()
            tooltip = raw[index + 1 :].strip()
            return value, tooltip
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


def _parse_enum_options(default_text: Any, tooltip: str = "") -> list[str]:
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
            return [str(item) for item in parsed]
        return []
    except Exception:
        pass
    return _split_enum_options(inner)


def _coerce_enum_value(raw_value: Any, options: list[str]) -> str:
    if not options:
        return _normalize_text(raw_value)
    text = _normalize_text(raw_value).strip()
    if text in options:
        return text
    nested_options = _parse_enum_options(text, "枚举")
    if nested_options:
        return nested_options[0]
    return options[0]


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


def parse_template(template_text: Any) -> list[dict[str, Any]]:
    text = _normalize_text(template_text).replace("\r\n", "\n")
    fields: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    for line in text.split("\n"):
        raw = line.strip()
        if not raw:
            continue
        if raw.startswith(("#", "//", ";")):
            continue
        if raw in {"...", "....", "……", "…"}:
            continue
        match = re.match(r"^([^:=：=]+?)\s*[:：=]\s*(.*)$", raw)
        if not match:
            continue
        label = match.group(1).strip()
        right = match.group(2).strip()
        if not label:
            continue
        default_text, tooltip = _split_value_and_tooltip(right)
        key = re.sub(r"\s+", "_", label)
        key = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff-]", "_", key).strip("_") or f"param_{len(fields)+1}"
        count = seen.get(key, 0)
        seen[key] = count + 1
        if count:
            key = f"{key}_{count + 1}"
        enum_options = _parse_enum_options(default_text, tooltip)
        value = enum_options[0] if enum_options else parse_value(default_text)
        fields.append({
            "key": key,
            "label": label,
            "default": enum_options[0] if enum_options else default_text,
            "value": value,
            "type": "ENUM" if enum_options else _infer_type(value),
            "options": enum_options,
            "tooltip": tooltip,
        })
        if len(fields) >= MAX_OUTPUTS:
            break
    return fields


def values_from_json(values_json: Any) -> dict[str, Any]:
    data = _safe_json_loads(values_json, {})
    return data if isinstance(data, dict) else {}


class GJJ_TemplateParams:
    CATEGORY = "GJJ/逻辑控制"
    FUNCTION = "output_params"
    DESCRIPTION = "通过模板文本自动生成参数输入框和输出口。支持格式：帧率：24.0 # 浮点\n是否启用：[enable,disable] # 枚举\n媒体文件会自动加载为 IMAGE/AUDIO/VIDEO 对象。"
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
        default_template = "帧率：24.0 # 浮点\n时长：5 # 整数\nLora加速：true # 布尔\n是否启用：[enable,disable] # 枚举"
        return {
            "required": {
                "template_text": (
                    "STRING",
                    {
                        "default": default_template,
                        "multiline": True,
                        "display": "hidden",
                        "display_name": "隐藏模板",
                        "tooltip": "由前端 ⚙️ 设置按钮维护。每行一个参数，支持格式：名称：默认值 # 说明",
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
        fields = parse_template(template_text)
        value_map = values_from_json(values_json)
        outputs: list[Any] = []
        warnings: list[str] = []
        
        for field in fields:
            key = str(field.get("key") or "")
            label = str(field.get("label") or "")
            raw_value = value_map.get(key, value_map.get(label, field.get("default", "")))
            if field.get("type") == "ENUM":
                outputs.append(_coerce_enum_value(raw_value, [str(item) for item in field.get("options", [])]))
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
