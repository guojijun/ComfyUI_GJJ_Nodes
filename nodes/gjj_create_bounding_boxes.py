# -*- coding: utf-8 -*-
"""
GJJ · 创建边界框画布（零依赖单节点）
============================================================

复制系统节点 `CreateBoundingBoxes`（comfy_extras/nodes_bounding_boxes.py）的核心
逻辑，改造为 GJJ 传统 API 风格的单文件自包含节点：

- 零依赖：不 import 任何 GJJ 其它模块，也不依赖 comfy_api.latest 新 API，
  只使用 torch / numpy / PIL / json 等 ComfyUI 环境必有的依赖。
- 输出类型与系统节点一致（IMAGE / BOUNDING_BOXES / ARRAY），可与系统节点、
  上游 GJJ 节点互相连接。
- OUTPUT_NODE=True：preview 图像会被 ComfyUI 记录到 nodeOutputStore，
  因此本节点作为上游 background 来源时，下游画布背景预览可以更新。
- 前端配套 js/gjj_create_bounding_boxes.js 负责隐藏 last_incoming widget，
  并把上游 GJJ_MultiImageLoader 的图片注入 nodeOutputStore，使画布背景预览
  能随 GJJ_MultiImageLoader / 本节点等任意 IMAGE 输出源的变化而更新。
"""

from __future__ import annotations

import json

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageEnhance, ImageFont

NODE_NAME = "GJJ_CreateBoundingBoxes"

_PREVIEW_LONG_EDGE = 1024
_PREVIEW_DIM = 0.25


# ---------------------------------------------------------------------------
# 颜色辅助（内联自 comfy_extras/color_util.py，避免跨文件依赖）
# ---------------------------------------------------------------------------

def _hex_to_rgb(value: str) -> tuple[int, int, int]:
    h = str(value or "").lstrip("#")
    if len(h) != 6:
        return (255, 255, 255)
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return (255, 255, 255)


def _readable_color(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    r, g, b = rgb
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    if lum >= 130:
        return (r, g, b)
    t = (130 - lum) / (255 - lum)
    return (
        round(r + (255 - r) * t),
        round(g + (255 - g) * t),
        round(b + (255 - b) * t),
    )


def _normalize_palette(colors) -> list[str]:
    if isinstance(colors, dict):
        colors = colors.values()
    return [c.upper() for c in colors if isinstance(c, str) and c]


# ---------------------------------------------------------------------------
# 坐标换算
# ---------------------------------------------------------------------------

def pixels_to_fractions(box: dict, width: int, height: int) -> dict:
    w = width or 1
    h = height or 1
    return {
        "x": box.get("x", 0) / w,
        "y": box.get("y", 0) / h,
        "w": box.get("width", 0) / w,
        "h": box.get("height", 0) / h,
    }


def fractions_to_pixels(box: dict, width: int, height: int) -> dict:
    x, y = box.get("x", 0.0), box.get("y", 0.0)
    w, h = box.get("w", 0.0), box.get("h", 0.0)
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    return {
        "x": round(x * width),
        "y": round(y * height),
        "width": round(w * width),
        "height": round(h * height),
    }


def fractions_to_bbox_frame(boxes: list, width: int, height: int) -> list:
    pixels = [
        fractions_to_pixels(box, width, height)
        for box in boxes
        if isinstance(box, dict)
    ]
    return [pixels] if pixels else []


# ---------------------------------------------------------------------------
# 预览渲染
# ---------------------------------------------------------------------------

def _font(size: int):
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def _wrap(draw, text: str, font, max_w: float) -> list[str]:
    lines = []
    for para in text.split("\n"):
        line = ""
        for word in para.split():
            test = word if not line else line + " " + word
            if line and draw.textlength(test, font=font) > max_w:
                lines.append(line)
                line = word
            else:
                line = test
        lines.append(line)
    return lines


def _bg_from_image(image) -> Image.Image | None:
    if image is None:
        return None
    try:
        arr = (image[0].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
        return Image.fromarray(arr)
    except Exception:
        return None


def render_preview(regions, width, height, bg=None):
    if bg is not None:
        iw, ih = bg.size
        long_edge = max(iw, ih) or 1
        scale = min(1.0, _PREVIEW_LONG_EDGE / long_edge)
        rw, rh = max(1, round(iw * scale)), max(1, round(ih * scale))
        base = bg.convert("RGB").resize((rw, rh), Image.LANCZOS)
        base = ImageEnhance.Brightness(base).enhance(_PREVIEW_DIM)
        img = base.convert("RGBA")
    else:
        long_edge = max(width, height) or 1
        scale = min(1.0, _PREVIEW_LONG_EDGE / long_edge)
        rw, rh = max(1, round(width * scale)), max(1, round(height * scale))
        grey = round(_PREVIEW_DIM * 128)
        img = Image.new("RGBA", (rw, rh), (grey, grey, grey, 255))

    overlay = Image.new("RGBA", (rw, rh), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fs = max(10, round(rh / 64))
    font = _font(fs)
    tag_font = _font(max(9, fs - 2))
    line_h = fs + 2

    for i, region in enumerate(regions):
        if not isinstance(region, dict):
            continue
        palette = [c for c in (region.get("palette") or []) if c]
        r, g, b = _hex_to_rgb(palette[0]) if palette else (140, 140, 140)
        x1 = max(0, min(rw, round(region.get("x", 0) * rw)))
        y1 = max(0, min(rh, round(region.get("y", 0) * rh)))
        x2 = max(0, min(rw, round((region.get("x", 0) + region.get("w", 0)) * rw)))
        y2 = max(0, min(rh, round((region.get("y", 0) + region.get("h", 0)) * rh)))
        if x2 < x1:
            x1, x2 = x2, x1
        if y2 < y1:
            y1, y2 = y2, y1

        draw.rectangle([x1, y1, x2, y2], outline=(r, g, b, 255), width=2)

        swatches = palette[:5]
        if swatches and (x2 - x1) > 2:
            sh = max(5, fs // 2)
            seg = (x2 - x1) / len(swatches)
            for p, hexc in enumerate(swatches):
                sx = x1 + round(p * seg)
                draw.rectangle([sx, y1, x1 + round((p + 1) * seg), y1 + sh], fill=_hex_to_rgb(hexc))

        etype = "text" if region.get("type") == "text" else "obj"
        tag = str(i + 1).zfill(2)
        tw = draw.textlength(tag, font=tag_font)
        draw.rectangle([x1, y1, x1 + tw + 6, y1 + fs + 2], fill=(r, g, b, 255))
        tag_fill = (0, 0, 0, 255) if (0.299 * r + 0.587 * g + 0.114 * b) > 140 else (255, 255, 255, 255)
        draw.text((x1 + 3, y1 + 1), tag, fill=tag_fill, font=tag_font)

        body = region.get("desc", "") or ""
        if etype == "text" and region.get("text"):
            body = '"%s"%s' % (region["text"], " — " + body if body else "")
        if body and (x2 - x1) > 8:
            ty = y1 + fs + 5
            for line in _wrap(draw, body, font, x2 - x1 - 8):
                if ty > y2:
                    break
                draw.text((x1 + 4, ty), line, fill=_readable_color((r, g, b)) + (255,), font=font)
                ty += line_h

    composed = Image.alpha_composite(img, overlay).convert("RGB")
    arr = np.asarray(composed, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


# ---------------------------------------------------------------------------
# 边界框数据解析（内联自系统节点，保持行为一致）
# ---------------------------------------------------------------------------

def boxes_to_regions(boxes, width: int, height: int) -> list:
    regions: list = []
    if not isinstance(boxes, list):
        return regions
    for box in boxes:
        if not isinstance(box, dict):
            continue
        meta = box.get("metadata")
        meta = meta if isinstance(meta, dict) else {}
        regions.append({
            **pixels_to_fractions(box, width, height),
            "type": meta.get("type", "obj"),
            "text": meta.get("text", ""),
            "desc": meta.get("desc", ""),
            "palette": meta.get("palette", []),
        })
    return regions


def normalize_incoming_boxes(bboxes) -> list:
    if isinstance(bboxes, dict):
        frame = [bboxes]
    elif not isinstance(bboxes, list) or not bboxes:
        frame = []
    elif isinstance(bboxes[0], dict):
        frame = bboxes
    else:
        frame = bboxes[0] if isinstance(bboxes[0], list) else []
    boxes = []
    for box in frame:
        if not isinstance(box, dict):
            continue
        norm = {
            "x": box.get("x", 0),
            "y": box.get("y", 0),
            "width": box.get("width", 0),
            "height": box.get("height", 0),
        }
        meta = box.get("metadata")
        if isinstance(meta, dict):
            norm["metadata"] = meta
        boxes.append(norm)
    return boxes


def _looks_like_element(box: dict) -> bool:
    bbox = box.get("bbox")
    return isinstance(bbox, (list, tuple)) and len(bbox) == 4


def _looks_like_bbox(box: dict) -> bool:
    return all(key in box for key in ("x", "y", "width", "height"))


def elements_to_boxes(elements: list, width: int, height: int) -> list:
    boxes = []
    for element in elements:
        if not isinstance(element, dict):
            continue
        bbox = element.get("bbox")
        if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
            raise ValueError("bboxes element is missing a valid 'bbox' [ymin, xmin, ymax, xmax]")
        try:
            ymin, xmin, ymax, xmax = (float(v) / 1000.0 for v in bbox)
        except (TypeError, ValueError):
            raise ValueError("bboxes element 'bbox' must contain four numbers")
        etype = "text" if element.get("type") == "text" else "obj"
        boxes.append({
            "x": round(min(xmin, xmax) * width),
            "y": round(min(ymin, ymax) * height),
            "width": round(abs(xmax - xmin) * width),
            "height": round(abs(ymax - ymin) * height),
            "metadata": {
                "type": etype,
                "text": element.get("text", "") if etype == "text" else "",
                "desc": element.get("desc", ""),
                "palette": element.get("color_palette", []) or [],
            },
        })
    return boxes


def boxes_from_input(data, width: int, height: int) -> list:
    if data is None:
        return []
    if isinstance(data, str):
        text = data.strip()
        if not text:
            return []
        try:
            data = json.loads(text)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"bboxes string input is not valid JSON: {exc}") from exc
    if isinstance(data, dict):
        if _looks_like_element(data):
            return elements_to_boxes([data], width, height)
        if _looks_like_bbox(data):
            return normalize_incoming_boxes(data)
        raise ValueError(
            "bboxes dict must be a bounding box (x, y, width, height) or an element (with a 'bbox')"
        )
    if not isinstance(data, list):
        raise ValueError(
            "bboxes input must be bounding boxes, elements, or a JSON string, "
            f"got {type(data).__name__}"
        )
    if not data:
        return []
    first = data[0]
    if isinstance(first, list):
        return normalize_incoming_boxes(data)
    if isinstance(first, dict):
        if _looks_like_element(first):
            return elements_to_boxes(data, width, height)
        if _looks_like_bbox(first):
            return normalize_incoming_boxes(data)
        raise ValueError(
            "bboxes items must be bounding boxes (x, y, width, height) or elements (with a 'bbox')"
        )
    raise ValueError(
        f"bboxes list must contain bounding boxes or elements, got {type(first).__name__}"
    )


def _norm_bbox(region: dict) -> list[int]:
    def grid(value: float) -> int:
        return max(0, min(1000, round(value * 1000)))

    x, y = region.get("x", 0.0), region.get("y", 0.0)
    w, h = region.get("w", 0.0), region.get("h", 0.0)
    ymin, xmin, ymax, xmax = grid(y), grid(x), grid(y + h), grid(x + w)
    if ymin > ymax:
        ymin, ymax = ymax, ymin
    if xmin > xmax:
        xmin, xmax = xmax, xmin
    return [ymin, xmin, ymax, xmax]


def build_elements(regions: list) -> list:
    elements = []
    for region in regions:
        if not isinstance(region, dict):
            continue
        etype = "text" if region.get("type") == "text" else "obj"
        element = {"type": etype}
        element["bbox"] = _norm_bbox(region)
        if etype == "text":
            element["text"] = region.get("text", "")
        element["desc"] = region.get("desc", "")
        palette = _normalize_palette(region.get("palette", []))
        if palette:
            element["color_palette"] = palette[:5]
        elements.append(element)
    return elements


# ---------------------------------------------------------------------------
# 节点定义
# ---------------------------------------------------------------------------

class GJJ_CreateBoundingBoxes:
    """在画布中绘制边界框，输出 Ideogram 提示元素、像素边界框与预览图。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 64,
                        "max": 16384,
                        "step": 16,
                        "tooltip": "画布与边界框像素网格的宽度。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 64,
                        "max": 16384,
                        "step": 16,
                        "tooltip": "画布与边界框像素网格的高度。",
                    },
                ),
                "editor_state": (
                    "BOUNDING_BOXES",
                    {
                        "tooltip": (
                            "在画布上绘制边界框，并设置每个框的类型、文本、描述与配色。"
                            "建议先连接背景图再绘制。"
                        ),
                    },
                ),
            },
            "optional": {
                "background": (
                    "IMAGE",
                    {
                        "tooltip": (
                            "可选背景图，用作画布与预览的背景。"
                            "支持 LoadImage、GJJ_MultiImageLoader 及任意 IMAGE 输出，"
                            "图片变化时画布预览会自动更新。"
                        ),
                    },
                ),
                "bboxes": (
                    "BOUNDING_BOXES,ARRAY,STRING",
                    {
                        "tooltip": (
                            "边界框、元素或 JSON 字符串，用于初始化画布。"
                            "上游值变化会重新初始化画布；画布上的编辑优先并保持到上游再次变化。"
                        ),
                    },
                ),
                "last_incoming": (
                    "BOUNDING_BOXES",
                    {
                        "tooltip": (
                            "画布内部状态：上次初始化画布的上游 bboxes 值，由前端画布托管，"
                            "清空可让画布在下一次运行重新从 bboxes 输入初始化。"
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "BOUNDING_BOXES", "ARRAY")
    RETURN_NAMES = ("预览图", "边界框", "元素")
    FUNCTION = "create"
    OUTPUT_NODE = True
    CATEGORY = "GJJ/🖼️ 图像/生成"
    DESCRIPTION = (
        "在画布中绘制边界框（支持对象/文本两种类型、调色板与描述），"
        "输出 Ideogram 提示元素、像素空间边界框和一张预览图。"
        "预览背景可随上游任意 IMAGE 输出（LoadImage、GJJ_MultiImageLoader、"
        "本节点等）的变化自动更新。"
    )
    SEARCH_ALIASES = [
        "bounding box",
        "bounding boxes",
        "bbox",
        "创建边界框",
        "边界框画布",
        "画框",
        "元素标注",
        "ideogram 元素",
    ]

    GJJ_HELP = {
        "title": "GJJ · 🧡·🖼️ 创建边界框画布",
        "version": "v1.0",
        "author": "GJJ Custom Nodes Team",
        "description": (
            "在节点内嵌画布中绘制边界框，为每个框设置对象/文本类型、文本内容、"
            "描述与配色，输出 Ideogram 提示元素、像素边界框和预览图。"
            "背景预览可随上游任意 IMAGE 输出变化自动更新。"
        ),
        "features": [
            {
                "name": "内嵌画布编辑器",
                "description": "直接在图内拖拽绘制、缩放、移动边界框，双击框内可编辑描述文字",
            },
            {
                "name": "对象/文本类型",
                "description": "每个框可切换为对象(obj)或文本(text)类型，文本类型可写具体文案",
            },
            {
                "name": "调色板",
                "description": "为每个框设置最多 5 个颜色的调色板，供下游元素提示使用",
            },
            {
                "name": "背景预览自动更新",
                "description": "背景输入支持 LoadImage、GJJ_MultiImageLoader 等任意 IMAGE 源，图片变化时画布与预览自动刷新",
            },
            {
                "name": "三种输出",
                "description": "预览图(IMAGE)、像素边界框(BOUNDING_BOXES)、Ideogram 元素(ARRAY)",
            },
        ],
        "usage": [
            "1. 背景：把 LoadImage 或 GJJ_MultiImageLoader 的 IMAGE 输出接入「background」，画布以它为背景",
            "2. 绘制：在画布上拖拽画出边界框；选中框后可切换类型、填写文本/描述、设置调色板",
            "3. 排序：背景元素应最先绘制，前景元素最后绘制",
            "4. 输出：将「边界框」接入支持 BOUNDING_BOXES 的下游节点，或将「元素」直接作为提示词元素使用",
        ],
    }

    def create(
        self,
        width=None,
        height=None,
        editor_state=None,
        last_incoming=None,
        background=None,
        bboxes=None,
    ):
        # 传统 API 下 width/height 可能缺省，兜底为画布默认值
        width = width if isinstance(width, int) and width > 0 else 1024
        height = height if isinstance(height, int) and height > 0 else 1024
        incoming = boxes_from_input(bboxes, width, height)
        applied = last_incoming if isinstance(last_incoming, list) else []
        upstream_changed = bool(incoming) and incoming != applied
        source = incoming if upstream_changed else (editor_state or [])
        regions = boxes_to_regions(source, width, height)
        preview = render_preview(regions, width, height, _bg_from_image(background))
        ui = {"dims": [width, height]}
        if incoming:
            ui["input_bboxes"] = incoming
        return {
            "ui": ui,
            "result": (
                preview,
                fractions_to_bbox_frame(regions, width, height),
                build_elements(regions),
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_CreateBoundingBoxes}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "创建边界框画布"}
