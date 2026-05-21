from __future__ import annotations

import os
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
AUDIO_EXTS = {"mp3", "wav", "flac", "ogg", "m4a", "aac", "wma"}
VIDEO_EXTS = {"mp4", "mov", "mkv", "webm", "avi", "flv", "mpeg", "m4v"}


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
    """从文件路径加载音频为 AUDIO 对象（兼容旧版 API）"""
    try:
        import av
        with av.open(file_path) as container:
            if not container.streams.audio:
                raise ValueError("No audio stream found")
            stream = container.streams.audio[0]
            sample_rate = stream.codec_context.sample_rate
            frames = []
            for frame in container.decode(streams=stream.index):
                buf = torch.from_numpy(frame.to_ndarray())
                if buf.shape[0] != stream.channels:
                    buf = buf.view(-1, stream.channels).t()
                frames.append(buf)
            if not frames:
                raise ValueError("No audio frames decoded")
            waveform = torch.cat(frames, dim=1)
            # 转换为 float32
            if waveform.dtype != torch.float32:
                if waveform.dtype == torch.int16:
                    waveform = waveform.float() / 32768.0
                elif waveform.dtype == torch.int32:
                    waveform = waveform.float() / 2147483648.0
            return {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}
    except Exception as e:
        print(f"[GJJ_TemplateParams] 加载音频失败: {file_path}, 错误: {e}")
        # 加载失败时返回默认空音频对象，避免中断执行
        return {"waveform": torch.zeros((1, 1, 44100)), "sample_rate": 44100}


def _load_video_from_path(file_path: str):
    """从文件路径加载视频为 Video 对象"""
    try:
        from comfy_api.latest import InputImpl
        return InputImpl.VideoFromFile(file_path)
    except Exception as e:
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
        except Exception:
            pass
        return torch.zeros((1, 64, 64, 3), dtype=torch.float32)


def _resolve_media_file(filename: str) -> str | None:
    """解析媒体文件路径，支持 input/output/temp 目录"""
    if not filename or not filename.strip():
        return None
    
    filename = filename.strip()
    parsed = urlparse(filename)
    if parsed.path.endswith("/view") and parsed.query:
        query = parse_qs(parsed.query)
        name = query.get("filename", [""])[0]
        subfolder = query.get("subfolder", [""])[0]
        filename = os.path.join(subfolder, name) if subfolder else name

    filename = unquote(filename).strip().replace("\\", os.sep).replace("/", os.sep)
    lowered = filename.lower()
    for prefix in ("input" + os.sep, "output" + os.sep, "temp" + os.sep):
        if lowered.startswith(prefix):
            filename = filename[len(prefix):]
            break
    
    # 尝试在 input 目录查找
    input_dir = folder_paths.get_input_directory()
    candidate = os.path.join(input_dir, filename)
    if os.path.exists(candidate):
        return candidate
    
    # 尝试在 output 目录查找
    output_dir = folder_paths.get_output_directory()
    candidate = os.path.join(output_dir, filename)
    if os.path.exists(candidate):
        return candidate
    
    # 尝试在 temp 目录查找
    temp_dir = folder_paths.get_temp_directory()
    candidate = os.path.join(temp_dir, filename)
    if os.path.exists(candidate):
        return candidate
    
    # 如果是绝对路径且存在
    if os.path.isabs(filename) and os.path.exists(filename):
        return filename
    
    return None


def _load_media_object(filename: str, media_type: str) -> Any:
    """根据类型加载媒体对象"""
    file_path = _resolve_media_file(filename)
    if not file_path:
        if media_type == "IMAGE":
            raise FileNotFoundError(f"找不到图片文件：{filename}。请确认文件在当前 ComfyUI 的 input 目录，或填写 input 子目录相对路径。")
        elif media_type == "AUDIO":
            return {"waveform": torch.zeros((1, 1, 44100)), "sample_rate": 44100}
        elif media_type == "VIDEO":
            return torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        raise ValueError(f"不支持的媒体类型: {media_type}")
    
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
            print(f"[GJJ_TemplateParams] 加载音频失败: {filename}, 错误: {e}")
            return {"waveform": torch.zeros((1, 1, 44100)), "sample_rate": 44100}
        elif media_type == "VIDEO":
            print(f"[GJJ_TemplateParams] 加载视频失败: {filename}, 错误: {e}")
            return torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        raise


import ast
import json
import re
from typing import Any

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
        value = parse_value(default_text)
        fields.append({
            "key": key,
            "label": label,
            "default": default_text,
            "value": value,
            "type": _infer_type(value),
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
    DESCRIPTION = "通过模板文本自动生成参数输入框和输出口。支持格式：帧率：24.0 # 每秒帧数\n媒体文件会自动加载为 IMAGE/AUDIO/VIDEO 对象"
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
        default_template = "帧率：24.0 # 每秒帧数\n时长：5 # 总时长\nLora加速：true # 是否启用Lora加速"
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
        
        for field in fields:
            key = str(field.get("key") or "")
            label = str(field.get("label") or "")
            raw_value = value_map.get(key, value_map.get(label, field.get("default", "")))
            
            # 检测是否为媒体文件
            media_type = _detect_media_type(str(raw_value))
            
            if media_type and isinstance(raw_value, str):
                # 直接加载为媒体对象（失败时返回默认值）
                media_obj = _load_media_object(raw_value, media_type)
                outputs.append(media_obj)
            else:
                # 非媒体类型：正常解析
                outputs.append(parse_value(raw_value))
        
        while len(outputs) < MAX_OUTPUTS:
            outputs.append(None)
        return tuple(outputs[:MAX_OUTPUTS])


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TemplateParams}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ⚙️ 模板参数输入器"}
