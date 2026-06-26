"""GJJ Ideogram 4 structured prompt builder.

Zero-dependency GJJ rewrite of KJNodes' Ideogram4PromptBuilderKJ.
"""

from __future__ import annotations

import json
import base64
import io
import time
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from .common_utils.temp_files import gjjutils_write_temp_tensor_images
try:
    from .gjj_ollama_common import (
        DEFAULT_OLLAMA_HOST,
        extract_final_answer,
        model_options_with_fallback,
        normalize_ollama_host,
        request_chat,
        resolve_model,
        tensor_to_png_base64,
        unload_model,
    )
except Exception:
    DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"

    def model_options_with_fallback(*_args, **_kwargs):
        return [""]

    def normalize_ollama_host(raw_host: str | None) -> str:
        return raw_host or DEFAULT_OLLAMA_HOST

    def resolve_model(model: str, host: str | None = None) -> str:
        if str(model or "").strip():
            return str(model).strip()
        raise RuntimeError("未选择 Ollama 反推模型。")

    def request_chat(*_args, **_kwargs):
        raise RuntimeError("当前环境无法导入 GJJ Ollama 公共工具。")

    def extract_final_answer(_response):
        return ""

    def tensor_to_png_base64(_image):
        raise RuntimeError("当前环境无法转换图片给 Ollama。")

    def unload_model(_model: str, host: str | None = None):
        return {}


NODE_NAME = "GJJ_Ideogram4PromptBuilder"
STYLE_NONE = "无样式"
STYLE_PHOTO = "照片"
STYLE_ART = "艺术风格"
STYLE_OPTIONS = [STYLE_NONE, STYLE_PHOTO, STYLE_ART]
MIXED_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
CAPTION_BACKEND_OFF = "关闭"
CAPTION_BACKEND_OLLAMA = "Ollama"
CAPTION_BACKENDS = [CAPTION_BACKEND_OFF, CAPTION_BACKEND_OLLAMA]
DEFAULT_IMAGE_CAPTION_PROMPT = (
    "请识别这张参考图的主体、背景、构图、光线、色调、材质、文字内容和关键细节，"
    "输出一段适合写入 Ideogram 4 JSON caption 的中文画面描述。只输出描述正文。"
)


def _hex_rgb(value: Any) -> tuple[int, int, int]:
    text = str(value or "").strip().lstrip("#")
    if len(text) != 6:
        return (255, 255, 255)
    try:
        return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
    except Exception:
        return (255, 255, 255)


def _font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    lines: list[str] = []
    for para in str(text or "").split("\n"):
        line = ""
        for word in para.split():
            test = word if not line else line + " " + word
            if line and draw.textlength(test, font=font) > max_width:
                lines.append(line)
                line = word
            else:
                line = test
        lines.append(line)
    return lines


def _align16_min256(value: Any) -> int:
    try:
        number = int(float(value))
    except Exception:
        number = 1024
    return max(((max(1, number) + 15) // 16) * 16, 256)


def _image_to_pil(image: Any) -> Image.Image | None:
    tensor = image
    if isinstance(tensor, dict):
        for key in ("images", "frames", "image", "samples"):
            if key in tensor:
                return _image_to_pil(tensor.get(key))
        return None
    if isinstance(tensor, (list, tuple)):
        for item in tensor:
            pil = _image_to_pil(item)
            if pil is not None:
                return pil
        return None
    if not isinstance(tensor, torch.Tensor):
        return None
    if tensor.ndim == 4:
        tensor = tensor[0]
    if tensor.ndim != 3:
        return None
    tensor = tensor.detach().cpu().float().clamp(0.0, 1.0)
    if tensor.shape[-1] == 1:
        tensor = tensor.repeat(1, 1, 3)
    elif tensor.shape[-1] >= 4:
        tensor = tensor[..., :3]
    elif tensor.shape[-1] != 3:
        return None
    array = (tensor.numpy() * 255.0).astype(np.uint8)
    return Image.fromarray(array, mode="RGB")


def _image_to_pil_list(image: Any) -> list[Image.Image]:
    tensor = image
    if isinstance(tensor, dict):
        for key in ("images", "frames", "image", "samples"):
            if key in tensor:
                return _image_to_pil_list(tensor.get(key))
        return []
    if isinstance(tensor, (list, tuple)):
        result: list[Image.Image] = []
        for item in tensor:
            result.extend(_image_to_pil_list(item))
        return result
    if not isinstance(tensor, torch.Tensor):
        return []
    if tensor.ndim == 3:
        pil = _image_to_pil(tensor)
        return [pil] if pil is not None else []
    if tensor.ndim != 4:
        return []
    result: list[Image.Image] = []
    for index in range(int(tensor.shape[0])):
        pil = _image_to_pil(tensor[index])
        if pil is not None:
            result.append(pil)
    return result


def _data_url_to_pil(data_url: Any) -> Image.Image | None:
    text = str(data_url or "").strip()
    if not text:
        return None
    if "," in text and text.lower().startswith("data:image/"):
        text = text.split(",", 1)[1]
    try:
        raw = base64.b64decode(text)
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        return None


def _pil_to_png_base64(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _box_image_data(box: Any) -> str:
    if not isinstance(box, dict):
        return ""
    return str(box.get("imageData") or box.get("image_data") or box.get("image") or "").strip()


def _render_preview(boxes: list[Any], width: int, height: int, image: Any = None, image_element_data: str = "") -> torch.Tensor:
    width = max(1, int(width or 1))
    height = max(1, int(height or 1))
    long_edge = max(width, height)
    scale = min(1.0, 1024 / long_edge) if long_edge > 0 else 1.0
    render_width = max(1, round(width * scale))
    render_height = max(1, round(height * scale))

    input_images = _image_to_pil_list(image)
    legacy_image = _data_url_to_pil(image_element_data)
    has_image_element = any(isinstance(box, dict) and box.get("type") == "image" for box in boxes)
    if input_images and not has_image_element:
        image = input_images[0].convert("RGB").resize((render_width, render_height), Image.Resampling.LANCZOS).convert("RGBA")
    else:
        image = Image.new("RGBA", (render_width, render_height), (0, 0, 0, 255))
    overlay = Image.new("RGBA", (render_width, render_height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font_size = max(10, round(render_height / 64))
    font = _font(font_size)
    tag_font = _font(max(9, font_size - 2))
    line_height = font_size + 2

    image_element_index = 0
    for index, box in enumerate(boxes):
        if not isinstance(box, dict) or box.get("nobbox"):
            continue
        palette = [str(color) for color in (box.get("palette") or []) if color]
        red, green, blue = _hex_rgb(palette[0]) if palette else (140, 140, 140)
        x1 = max(0, min(render_width, round(float(box.get("x", 0)) * render_width)))
        y1 = max(0, min(render_height, round(float(box.get("y", 0)) * render_height)))
        x2 = max(0, min(render_width, round((float(box.get("x", 0)) + float(box.get("w", 0))) * render_width)))
        y2 = max(0, min(render_height, round((float(box.get("y", 0)) + float(box.get("h", 0))) * render_height)))
        if x2 < x1:
            x1, x2 = x2, x1
        if y2 < y1:
            y1, y2 = y2, y1

        element_type = str(box.get("type") or "obj")
        if element_type == "image" and x2 > x1 and y2 > y1:
            element_pil = _data_url_to_pil(_box_image_data(box))
            if element_pil is None and image_element_index < len(input_images):
                element_pil = input_images[image_element_index]
            if element_pil is None:
                element_pil = legacy_image
            image_element_index += 1
            if element_pil is not None:
                fitted = element_pil.convert("RGB").resize((max(1, x2 - x1), max(1, y2 - y1)), Image.Resampling.LANCZOS).convert("RGBA")
                image.alpha_composite(fitted, (x1, y1))

        draw.rectangle([x1, y1, x2, y2], outline=(red, green, blue, 255), width=2)

        palette_strip = palette[:5]
        if palette_strip and (x2 - x1) > 2:
            strip_height = max(5, font_size // 2)
            segment = (x2 - x1) / len(palette_strip)
            for palette_index, hex_color in enumerate(palette_strip):
                sx = x1 + round(palette_index * segment)
                draw.rectangle(
                    [sx, y1, x1 + round((palette_index + 1) * segment), y1 + strip_height],
                    fill=_hex_rgb(hex_color),
                )

        element_type = str(box.get("type") or "obj")
        tag = str(index + 1).zfill(2)
        tag_width = draw.textlength(tag, font=tag_font)
        draw.rectangle([x1, y1, x1 + tag_width + 6, y1 + font_size + 2], fill=(red, green, blue, 255))
        tag_fill = (0, 0, 0, 255) if (0.299 * red + 0.587 * green + 0.114 * blue) > 140 else (255, 255, 255, 255)
        draw.text((x1 + 3, y1 + 1), tag, fill=tag_fill, font=tag_font)

        body = str(box.get("desc", "") or "")
        if element_type == "image" and not body:
            body = "等待图片反推"
        if element_type == "text" and box.get("text"):
            body = '"%s"%s' % (box["text"], " - " + body if body else "")
        if body and (x2 - x1) > 8:
            text_y = y1 + font_size + 5
            for line in _wrap(draw, body, font, x2 - x1 - 8):
                if text_y > y2:
                    break
                draw.text((x1 + 4, text_y), line, fill=(212, 212, 212, 255), font=font)
                text_y += line_height

    image = Image.alpha_composite(image, overlay).convert("RGB")
    array = np.asarray(image, dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


def _norm_bbox(box: dict[str, Any]) -> list[int]:
    def clamp_grid(value: float) -> int:
        return max(0, min(1000, round(value * 1000)))

    x = float(box.get("x", 0.0) or 0.0)
    y = float(box.get("y", 0.0) or 0.0)
    width = float(box.get("w", 0.0) or 0.0)
    height = float(box.get("h", 0.0) or 0.0)
    ymin, xmin, ymax, xmax = clamp_grid(y), clamp_grid(x), clamp_grid(y + height), clamp_grid(x + width)
    if ymin > ymax:
        ymin, ymax = ymax, ymin
    if xmin > xmax:
        xmin, xmax = xmax, xmin
    return [ymin, xmin, ymax, xmax]


def _palette(colors: Any) -> list[str]:
    if isinstance(colors, dict):
        colors = colors.values()
    if not isinstance(colors, (list, tuple)):
        return []
    result: list[str] = []
    for color in colors:
        text = str(color or "").strip()
        if text:
            result.append(text.upper())
    return result


def _dumps(value: Any, level: int = 0) -> str:
    pad = "    " * (level + 1)
    end = "    " * level
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        if not value:
            return "[]"
        if all(not isinstance(item, (dict, list)) for item in value):
            return "[" + ", ".join(_dumps(item, level) for item in value) + "]"
        return "[\n" + ",\n".join(pad + _dumps(item, level + 1) for item in value) + "\n" + end + "]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [pad + json.dumps(key, ensure_ascii=False) + ": " + _dumps(item, level + 1) for key, item in value.items()]
        return "{\n" + ",\n".join(items) + "\n" + end + "}"
    return json.dumps(value, ensure_ascii=False)


def _parse_json_list(text: str) -> list[Any]:
    if text:
        try:
            value = json.loads(text)
            if isinstance(value, list):
                return value
        except Exception:
            pass
    return []


def _parse_external_bboxes(text: str, width: int, height: int) -> list[dict[str, Any]]:
    values = _parse_json_list(text)
    boxes: list[dict[str, Any]] = []
    for index, item in enumerate(values):
        label = ""
        desc = ""
        raw_box: Any = item
        if isinstance(item, dict):
            label = str(item.get("label") or item.get("name") or item.get("text") or "").strip()
            desc = str(item.get("desc") or item.get("description") or item.get("prompt") or label or f"框选区域 {index + 1}").strip()
            raw_box = item.get("bbox", item.get("box", item))
            if all(key in item for key in ("x", "y", "w", "h")):
                raw_box = [item.get("x"), item.get("y"), item.get("w"), item.get("h")]
            elif all(key in item for key in ("x1", "y1", "x2", "y2")):
                raw_box = [item.get("x1"), item.get("y1"), item.get("x2"), item.get("y2")]
        if not isinstance(raw_box, (list, tuple)) or len(raw_box) < 4:
            continue
        try:
            a, b, c, d = [float(v or 0) for v in raw_box[:4]]
        except Exception:
            continue
        if max(abs(a), abs(b), abs(c), abs(d)) <= 1.0:
            x, y, w, h = a, b, c - a, d - b
            if w <= 0 or h <= 0:
                w, h = c, d
        elif max(abs(a), abs(b), abs(c), abs(d)) <= 1000.0:
            ymin, xmin, ymax, xmax = a, b, c, d
            x, y, w, h = xmin / 1000.0, ymin / 1000.0, (xmax - xmin) / 1000.0, (ymax - ymin) / 1000.0
        else:
            x, y, w, h = a / max(1, width), b / max(1, height), (c - a) / max(1, width), (d - b) / max(1, height)
        x = max(0.0, min(1.0, x))
        y = max(0.0, min(1.0, y))
        w = max(0.0, min(1.0 - x, w))
        h = max(0.0, min(1.0 - y, h))
        if w <= 0 or h <= 0:
            continue
        boxes.append({"x": x, "y": y, "w": w, "h": h, "type": "obj", "text": label, "desc": desc, "palette": []})
    return boxes


def _parse_caption(text: str) -> dict[str, Any] | None:
    if not str(text or "").strip():
        return None
    try:
        value = json.loads(text)
    except Exception:
        return None
    if isinstance(value, dict) and isinstance(value.get("compositional_deconstruction"), dict):
        return value
    return None


def _normalize_style(style: str) -> str:
    text = str(style or "").strip()
    if text in {"photo", STYLE_PHOTO}:
        return STYLE_PHOTO
    if text in {"art_style", STYLE_ART}:
        return STYLE_ART
    return STYLE_NONE


def _element_to_box(element: Any, index: int) -> dict[str, Any] | None:
    if not isinstance(element, dict):
        return None
    box: dict[str, Any] = {
        "type": "text" if element.get("type") == "text" else "obj",
        "text": str(element.get("text", "") or ""),
        "desc": str(element.get("desc", "") or ""),
        "palette": _palette(element.get("color_palette", []))[:5],
    }
    bbox = element.get("bbox")
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        try:
            ymin, xmin, ymax, xmax = [float(v or 0) for v in bbox]
            box["x"] = max(0.0, min(1.0, xmin / 1000.0))
            box["y"] = max(0.0, min(1.0, ymin / 1000.0))
            box["w"] = max(0.0, min(1.0 - box["x"], (xmax - xmin) / 1000.0))
            box["h"] = max(0.0, min(1.0 - box["y"], (ymax - ymin) / 1000.0))
            return box
        except Exception:
            pass
    offset = (index % 6) * 0.035
    box.update({"x": 0.03 + offset, "y": 0.03 + offset, "w": 0.22, "h": 0.14, "nobbox": True})
    return box


def _caption_to_boxes(caption: dict[str, Any]) -> list[dict[str, Any]]:
    cd = caption.get("compositional_deconstruction")
    elements = cd.get("elements") if isinstance(cd, dict) else []
    if not isinstance(elements, list):
        return []
    boxes: list[dict[str, Any]] = []
    for index, element in enumerate(elements):
        box = _element_to_box(element, index)
        if box:
            boxes.append(box)
    return boxes


def _caption_from_parts(
    high_level_description: str,
    background: str,
    style: str,
    photo: str,
    art_style: str,
    aesthetics: str,
    lighting: str,
    medium: str,
    style_palette_data: str,
    boxes: list[Any],
) -> dict[str, Any]:
    caption: dict[str, Any] = {}
    if str(high_level_description or "").strip():
        caption["high_level_description"] = high_level_description

    style_kind = _normalize_style(style)
    if style_kind != STYLE_NONE:
        style_description: dict[str, Any] = {
            "aesthetics": aesthetics,
            "lighting": lighting,
        }
        if style_kind == STYLE_PHOTO:
            style_description["photo"] = photo
            style_description["medium"] = medium
        else:
            style_description["medium"] = medium
            style_description["art_style"] = art_style
        palette = _palette(_parse_json_list(style_palette_data))[:16]
        if palette:
            style_description["color_palette"] = palette
        caption["style_description"] = style_description

    elements: list[dict[str, Any]] = []
    for box in boxes:
        if not isinstance(box, dict):
            continue
        raw_type = str(box.get("type") or "obj")
        element_type = "text" if raw_type == "text" else "obj"
        element: dict[str, Any] = {"type": element_type}
        if not box.get("nobbox"):
            element["bbox"] = _norm_bbox(box)
        if element_type == "text":
            element["text"] = box.get("text", "")
        desc = str(box.get("desc", "") or "")
        element["desc"] = desc
        palette = _palette(box.get("palette", []))[:5]
        if palette:
            element["color_palette"] = palette
        elements.append(element)

    caption["compositional_deconstruction"] = {
        "background": background,
        "elements": elements,
    }
    return caption


def _normalize_imported_caption(caption: dict[str, Any]) -> dict[str, Any]:
    cd = caption.get("compositional_deconstruction") if isinstance(caption, dict) else {}
    sd = caption.get("style_description") if isinstance(caption, dict) else {}
    style = STYLE_NONE
    if isinstance(sd, dict):
        if isinstance(sd.get("photo"), str):
            style = STYLE_PHOTO
        elif isinstance(sd.get("art_style"), str):
            style = STYLE_ART
    return _caption_from_parts(
        str(caption.get("high_level_description", "") or ""),
        str(cd.get("background", "") or "") if isinstance(cd, dict) else "",
        style,
        str(sd.get("photo", "") or "") if isinstance(sd, dict) else "",
        str(sd.get("art_style", "") or "") if isinstance(sd, dict) else "",
        str(sd.get("aesthetics", "") or "") if isinstance(sd, dict) else "",
        str(sd.get("lighting", "") or "") if isinstance(sd, dict) else "",
        str(sd.get("medium", "") or "") if isinstance(sd, dict) else "",
        json.dumps(sd.get("color_palette", []), ensure_ascii=False) if isinstance(sd, dict) else "",
        _caption_to_boxes(caption),
    )


def _caption_image_with_ollama(
    image: Any,
    model: str,
    host: str,
    prompt: str,
    thinking_mode: str,
    max_tokens: int,
    keep_alive: str,
) -> str:
    if image is None:
        return ""
    chosen_model = resolve_model(model, host=host)
    pil = _image_to_pil(image)
    image_base64 = _pil_to_png_base64(pil) if pil is not None else tensor_to_png_base64(image)
    return _caption_base64_with_ollama(
        image_base64,
        chosen_model,
        host,
        prompt,
        thinking_mode,
        max_tokens,
        keep_alive,
    )


def _caption_pil_with_ollama(
    image: Image.Image,
    model: str,
    host: str,
    prompt: str,
    thinking_mode: str,
    max_tokens: int,
    keep_alive: str,
) -> str:
    if image is None:
        return ""
    chosen_model = resolve_model(model, host=host)
    return _caption_base64_with_ollama(
        _pil_to_png_base64(image),
        chosen_model,
        host,
        prompt,
        thinking_mode,
        max_tokens,
        keep_alive,
    )


def _caption_base64_with_ollama(
    image_base64: str,
    chosen_model: str,
    host: str,
    prompt: str,
    thinking_mode: str,
    max_tokens: int,
    keep_alive: str,
) -> str:
    options: dict[str, Any] = {
        "temperature": 0.35,
        "num_predict": max(32, min(8192, int(max_tokens or 512))),
        "seed": int(time.time_ns() & 0xFFFFFFFF),
    }
    payload = {
        "model": chosen_model,
        "messages": [
            {
                "role": "user",
                "content": str(prompt or DEFAULT_IMAGE_CAPTION_PROMPT),
                "images": [image_base64],
            }
        ],
        "stream": False,
        "think": str(thinking_mode) == "开启思考",
        "options": options,
    }
    response = request_chat(payload, error_label="Ollama 图片反推请求", host=host, timeout=120)
    text = extract_final_answer(response).strip()
    if str(keep_alive) == "卸载模型":
        unload_model(chosen_model, host=host)
    return text


def _merge_image_caption(caption: dict[str, Any], image_text: str) -> None:
    text = str(image_text or "").strip()
    if not text:
        return
    current = str(caption.get("high_level_description", "") or "").strip()
    caption["high_level_description"] = f"{current}\n{text}".strip() if current else text


def _is_placeholder_image_desc(value: Any) -> bool:
    text = str(value or "").strip()
    if not text:
        return True
    lowered = text.lower()
    return lowered in {
        "input",
        "image",
        "reference image",
        "输入图片元素",
        "输入图片",
        "参考图片",
        "本图",
    }


def _apply_image_caption_to_boxes(boxes: list[Any], image_text: str) -> None:
    text = str(image_text or "").strip()
    if not text:
        return
    for box in boxes:
        if isinstance(box, dict) and str(box.get("type") or "") == "image" and _is_placeholder_image_desc(box.get("desc")):
            box["desc"] = text
            return


def _image_sources_for_boxes(boxes: list[Any], image: Any = None, image_element_data: str = "") -> list[tuple[int, Image.Image]]:
    sources: list[tuple[int, Image.Image]] = []
    input_images = _image_to_pil_list(image)
    legacy_image = _data_url_to_pil(image_element_data)
    image_element_index = 0
    for index, box in enumerate(boxes):
        if not isinstance(box, dict) or str(box.get("type") or "") != "image":
            continue
        pil = _data_url_to_pil(_box_image_data(box))
        if pil is None and image_element_index < len(input_images):
            pil = input_images[image_element_index]
        if pil is None:
            pil = legacy_image
        image_element_index += 1
        if pil is not None:
            sources.append((index, pil))
    return sources


def _apply_image_captions_to_boxes(boxes: list[Any], captions: list[tuple[int, str]]) -> None:
    for index, text in captions:
        value = str(text or "").strip()
        if not value or index < 0 or index >= len(boxes):
            continue
        box = boxes[index]
        if isinstance(box, dict) and str(box.get("type") or "") == "image" and _is_placeholder_image_desc(box.get("desc")):
            box["desc"] = value


def _ensure_image_element(boxes: list[Any], image: Any) -> list[Any]:
    if image is None:
        return boxes
    if any(isinstance(box, dict) and str(box.get("type") or "") == "image" for box in boxes):
        return boxes
    if boxes:
        return boxes
    return [
        {
            "x": 0.12,
            "y": 0.12,
            "w": 0.76,
            "h": 0.76,
            "type": "image",
            "text": "",
            "desc": "",
            "palette": [],
        }
    ]


class GJJ_Ideogram4PromptBuilder:
    DESCRIPTION = (
        "可视化构建 Ideogram 4 结构化 JSON 提示词。"
        "在节点画布中拖拽绘制区域，为每个区域填写类型、描述、文字和颜色，并按 Ideogram 4 提示词工程推荐的字段顺序输出 JSON 字符串。"
    )
    CATEGORY = "GJJ/文本"
    RETURN_TYPES = ("STRING", "IMAGE")
    RETURN_NAMES = ("提示词JSON", "区域预览图")
    OUTPUT_TOOLTIPS = (
        "按 Ideogram 4 结构化 caption 格式生成的 JSON 字符串。",
        "根据画布区域和颜色生成的预览图，用于检查框选位置与描述。",
    )
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        model_options = model_options_with_fallback()
        default_model = model_options[0] if model_options else ""
        return {
            "required": {
                "width": ("INT", {
                    "default": 1024,
                    "min": 256,
                    "max": 16384,
                    "step": 8,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "画布宽度",
                    "tooltip": "用于预览画布比例，也用于把区域框换算为 Ideogram 4 的 0-1000 坐标；执行时会按 16 倍数向上对齐，最小 256。",
                }),
                "height": ("INT", {
                    "default": 1024,
                    "min": 256,
                    "max": 16384,
                    "step": 8,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "画布高度",
                    "tooltip": "用于预览画布比例，也用于把区域框换算为 Ideogram 4 的 0-1000 坐标；执行时会按 16 倍数向上对齐，最小 256。",
                }),
                "high_level_description": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "整体概述",
                    "tooltip": "整张图的一句话总体描述；留空时不会写入 JSON。",
                }),
                "background": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "背景描述",
                    "tooltip": "画面背景和环境描述，会写入结构化提示词的背景部分。",
                }),
                "style": (STYLE_OPTIONS, {
                    "default": STYLE_NONE,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "样式类型",
                    "tooltip": "选择是否写入样式描述；照片会使用“照片质感”，艺术风格会使用“艺术风格”。",
                }),
                "photo": ("STRING", {
                    "default": "",
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "照片质感",
                    "tooltip": "样式类型为“照片”时使用，例如镜头、胶片、摄影质感等。",
                }),
                "art_style": ("STRING", {
                    "default": "",
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "艺术风格",
                    "tooltip": "样式类型为“艺术风格”时使用，例如插画、海报、绘画流派等。",
                }),
                "aesthetics": ("STRING", {
                    "default": "",
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "审美描述",
                    "tooltip": "整体视觉审美关键词；选择样式类型后会写入样式描述。",
                }),
                "lighting": ("STRING", {
                    "default": "",
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "光照描述",
                    "tooltip": "整体光照、阴影和氛围描述；选择样式类型后会写入样式描述。",
                }),
                "medium": ("STRING", {
                    "default": "",
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "媒介描述",
                    "tooltip": "作品媒介，例如数字摄影、混合媒介拼贴、3D 渲染、油画等。",
                }),
                "image_caption_backend": (CAPTION_BACKENDS, {
                    "default": CAPTION_BACKEND_OLLAMA if default_model else CAPTION_BACKEND_OFF,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "图片反推方式",
                    "tooltip": "连接图片后可选择是否调用本机 Ollama 多模态模型反推图片描述，并写入对应图片元素的描述。",
                }),
                "image_caption_model": (model_options, {
                    "default": default_model,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "反推模型",
                    "tooltip": "选择本机 Ollama 已安装的多模态模型；留空或关闭反推时不会调用。",
                }),
                "image_caption_prompt": ("STRING", {
                    "default": DEFAULT_IMAGE_CAPTION_PROMPT,
                    "multiline": True,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "反推提示词",
                    "tooltip": "发送给反推模型的图片识别要求。",
                }),
                "image_caption_thinking": (["关闭思考", "开启思考"], {
                    "default": "关闭思考",
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "反推思考",
                    "tooltip": "是否允许支持思考的模型先推理再输出。",
                }),
                "image_caption_keep_alive": (["保持模型", "卸载模型"], {
                    "default": "保持模型",
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "模型处理",
                    "tooltip": "反推完成后保持模型常驻，或立即卸载。",
                }),
                "image_caption_max_tokens": ("INT", {
                    "default": 512,
                    "min": 32,
                    "max": 8192,
                    "step": 1,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "最大反推长度",
                    "tooltip": "限制图片反推模型最多生成多少 token。",
                }),
                "ollama_host": ("STRING", {
                    "default": DEFAULT_OLLAMA_HOST,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "Ollama 地址",
                    "tooltip": "本机 Ollama 完整地址，例如 http://127.0.0.1:11434 。",
                }),
            },
            "optional": {
                "import_json": ("STRING", {
                    "default": "",
                    "forceInput": True,
                    "display_name": "导入JSON",
                    "tooltip": "可选连接完整 Ideogram 4 JSON；连接后本次执行会直接按上游 JSON 生成输出、区域预览图，并同步刷新面板字段。",
                }),
                "bboxes": ("STRING", {
                    "default": "",
                    "forceInput": True,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "外部框选",
                    "tooltip": "可选连接外部 bboxes JSON。支持 Ideogram [ymin,xmin,ymax,xmax]、像素 [x1,y1,x2,y2] 或对象数组。",
                }),
                "image": (MIXED_IMAGE_TYPE, {
                    "display_name": "参考图片",
                    "tooltip": "可选参考图。支持 GJJ_BATCH_IMAGE 或普通 IMAGE；连接后会作为图片元素缩略图，开启反推时会把图片识别文本写入 JSON 的图片元素描述。",
                }),
                "style_palette_data": ("STRING", {
                    "default": "",
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "样式调色板数据",
                    "tooltip": "前端编辑器保存的样式颜色数据，通常无需手动编辑。",
                }),
                "elements_data": ("STRING", {
                    "default": "",
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "区域数据",
                    "tooltip": "前端编辑器保存的区域框数据，通常无需手动编辑。",
                }),
                "image_element_data": ("STRING", {
                    "default": "",
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "图片元素数据",
                    "tooltip": "前端图片元素通过文件按钮载入的本地图片数据，通常无需手动编辑。",
                }),
            },
        }

    def build(
        self,
        width: int,
        height: int,
        high_level_description: str,
        background: str,
        style: str,
        photo: str,
        art_style: str,
        aesthetics: str,
        lighting: str,
        medium: str,
        image_caption_backend: str = CAPTION_BACKEND_OFF,
        image_caption_model: str = "",
        image_caption_prompt: str = DEFAULT_IMAGE_CAPTION_PROMPT,
        image_caption_thinking: str = "关闭思考",
        image_caption_keep_alive: str = "保持模型",
        image_caption_max_tokens: int = 512,
        ollama_host: str = DEFAULT_OLLAMA_HOST,
        style_palette_data: str = "",
        elements_data: str = "",
        image_element_data: str = "",
        import_json: str = "",
        bboxes: str = "",
        image: Any = None,
    ):
        width = _align16_min256(width)
        height = _align16_min256(height)
        boxes = _parse_json_list(elements_data)
        external_boxes = _parse_external_bboxes(bboxes, width, height)
        if external_boxes:
            boxes = external_boxes
        boxes = _ensure_image_element(boxes, image if image is not None else image_element_data)

        imported = _parse_caption(import_json)
        if imported:
            caption = _normalize_imported_caption(imported)
            boxes = _caption_to_boxes(caption)
        else:
            caption = {}

        image_caption = ""
        image_sources = _image_sources_for_boxes(boxes, image=image, image_element_data=image_element_data)
        has_caption_model = bool(str(image_caption_model or "").strip())
        # 旧工作流里反推方式可能仍保存为“关闭”。只要已选择模型且存在图片元素，
        # 就按 Ollama 执行，避免图片元素 desc 一直为空。
        should_caption_images = has_caption_model and bool(image_sources) and (
            str(image_caption_backend or "") in {CAPTION_BACKEND_OLLAMA, CAPTION_BACKEND_OFF}
        )
        if should_caption_images:
            image_captions: list[tuple[int, str]] = []
            for box_index, pil in image_sources:
                box = boxes[box_index] if 0 <= box_index < len(boxes) else {}
                if isinstance(box, dict) and not _is_placeholder_image_desc(box.get("desc")):
                    continue
                text = _caption_pil_with_ollama(
                    pil,
                    str(image_caption_model or ""),
                    normalize_ollama_host(ollama_host or DEFAULT_OLLAMA_HOST),
                    image_caption_prompt,
                    image_caption_thinking,
                    int(image_caption_max_tokens or 512),
                    image_caption_keep_alive,
                )
                if text:
                    image_captions.append((box_index, text))
            _apply_image_captions_to_boxes(boxes, image_captions)
            image_caption = "\n".join(text for _, text in image_captions if text)
        if image_caption:
            caption = _caption_from_parts(
                high_level_description,
                background,
                style,
                photo,
                art_style,
                aesthetics,
                lighting,
                medium,
                style_palette_data,
                boxes,
            )
            # 图片元素的描述只来自反推结果，避免和对象/文字的手写描述混淆。
        elif not imported:
            caption = _caption_from_parts(
                high_level_description,
                background,
                style,
                photo,
                art_style,
                aesthetics,
                lighting,
                medium,
                style_palette_data,
                boxes,
            )

        preview = _render_preview(boxes, width, height, image=image, image_element_data=image_element_data)

        ui: dict[str, list[str]] = {}
        if imported:
            ui["caption"] = [_dumps(caption)]
        if image_caption:
            ui["image_caption"] = [image_caption]
            ui["image_element_captions"] = [
                json.dumps(
                    [{"index": index, "desc": text} for index, text in image_captions if str(text or "").strip()],
                    ensure_ascii=False,
                )
            ]
            ui["caption"] = [_dumps(caption)]
        ui["dimensions"] = [json.dumps({"width": width, "height": height}, ensure_ascii=False)]
        if image is not None and not str(image_element_data or "").strip():
            try:
                ui["image_element_preview"] = [f"data:image/png;base64,{tensor_to_png_base64(image)}"]
            except Exception:
                pass
        try:
            preview_entries = gjjutils_write_temp_tensor_images(preview)
            if preview_entries:
                ui["preview_images"] = preview_entries
                ui["images"] = [dict(item) for item in preview_entries]
        except Exception:
            pass
        result = (_dumps(caption), preview)
        if ui:
            return {"ui": ui, "result": result}
        return result


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Ideogram4PromptBuilder}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧭 Ideogram4提示词画框"}
