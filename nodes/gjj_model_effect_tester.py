from __future__ import annotations

import json
import math
import os
import re
from typing import Any

import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageColor, ImageDraw, ImageFont

import folder_paths

try:
    from server import PromptServer
except Exception:  # pragma: no cover
    PromptServer = None


NODE_NAME = "GJJ_ModelEffectTester"
API_PATH = "/gjj/model_effect_models"
STATE_WIDGET = "test_state"
MAX_INT = 0xFFFFFFFFFFFFFFFF
MODEL_SOURCES = ["diffusion_models", "checkpoints"]
PASS_MARK = "✅ "
FAIL_MARK = "❌ "
DEFAULT_STATE = {
    "version": 1,
    "filter": "",
    "subdir": "",
    "passed": [],
    "failed": [],
    "auto": True,
    "skip": True,
    "refresh": "",
}


def _safe_model_list(source: str) -> list[str]:
    source = str(source or "").strip()
    if source not in MODEL_SOURCES:
        source = "diffusion_models"
    try:
        return [str(item) for item in folder_paths.get_filename_list(source) if str(item or "").strip()]
    except Exception:
        return []


def _normalize_keyword(value: str) -> str:
    return str(value or "").strip().lower().replace("\\", "/")


def _parse_search_keywords(value: str) -> list[str]:
    return [
        _normalize_keyword(item)
        for item in re.split(r"[,，、;；|]+", str(value or ""))
        if _normalize_keyword(item)
    ]


def _parse_search_expression(value: str) -> list[list[str]]:
    groups: list[list[str]] = []
    for part in re.split(r"[&+＋]", str(value or "")):
        keywords = _parse_search_keywords(part)
        if keywords:
            groups.append(keywords)
    return groups


def _matches_search_expression(text: str, groups: list[list[str]]) -> bool:
    if not groups:
        return True
    lowered = _normalize_keyword(text)
    return all(any(keyword in lowered for keyword in group) for group in groups)


def _matches_subdir(text: str, subdir: str) -> bool:
    subdir = _normalize_keyword(subdir).strip("/")
    if not subdir:
        return True
    normalized = _normalize_keyword(text)
    return normalized.startswith(f"{subdir}/") or normalized == subdir


def _filtered_models(source: str, filter_keywords: str, subdir: str) -> list[str]:
    expression = _parse_search_expression(filter_keywords)
    return [
        name
        for name in _safe_model_list(source)
        if _matches_subdir(name, subdir) and _matches_search_expression(name, expression)
    ]


def _subdirs(source: str) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for name in _safe_model_list(source):
        parts = str(name or "").replace("\\", "/").split("/")[:-1]
        current = ""
        for part in parts:
            current = f"{current}/{part}".strip("/")
            key = current.lower()
            if current and key not in seen:
                seen.add(key)
                result.append(current)
    return result


async def get_model_effect_models(request):
    source = str(request.query.get("source", "diffusion_models") or "diffusion_models")
    if source not in MODEL_SOURCES:
        source = "diffusion_models"
    return web.json_response({
        "source": source,
        "models": _safe_model_list(source),
        "subdirs": _subdirs(source),
    })


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.get(API_PATH)(get_model_effect_models)


def _parse_key_list(value: Any) -> list[str]:
    if isinstance(value, list):
        raw_values = value
    else:
        raw_values = re.split(r"[\n,，;；]+", str(value or ""))
    result: list[str] = []
    for item in raw_values:
        text = str(item or "").strip()
        if text and text not in result:
            result.append(text)
    return result


def _as_bool(value: Any, fallback: bool) -> bool:
    if value is None:
        return fallback
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"false", "0", "off", "no", "关"}:
            return False
        if lowered in {"true", "1", "on", "yes", "开"}:
            return True
    return bool(value)


def _parse_state(raw_value: Any) -> dict[str, Any]:
    state = dict(DEFAULT_STATE)
    try:
        parsed = json.loads(str(raw_value or "{}"))
    except json.JSONDecodeError:
        parsed = {}
    if isinstance(parsed, dict):
        state["filter"] = str(parsed.get("filter", state["filter"]) or "")
        state["subdir"] = str(parsed.get("subdir", state["subdir"]) or "")
        state["passed"] = _parse_key_list(parsed.get("passed", []))
        state["failed"] = _parse_key_list(parsed.get("failed", []))
        state["auto"] = _as_bool(parsed.get("auto"), True)
        state["skip"] = _as_bool(parsed.get("skip"), True)
        state["refresh"] = str(parsed.get("refresh", "") or "")
    return state


def _display_model_name(model_name: str) -> str:
    text = str(model_name or "").strip()
    if not text:
        return ""
    base, ext = os.path.splitext(text)
    display = base if ext else text
    return re.sub(r"[\\/]+", "_", display)


def _combo_label(model_name: str, passed: set[str], failed: set[str]) -> str:
    mark = FAIL_MARK if model_name in failed else PASS_MARK if model_name in passed else ""
    return f"{mark}{_display_model_name(model_name)}"


def _hex_color(value: str, fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    try:
        color = ImageColor.getrgb(str(value or "").strip())
        return int(color[0]), int(color[1]), int(color[2])
    except Exception:
        return fallback


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("msyh.ttc", "simhei.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, max(8, int(size)))
        except Exception:
            pass
    return ImageFont.load_default()


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    cleaned = str(text or "").strip()
    if not cleaned:
        return [""]
    lines: list[str] = []
    current = ""
    for char in cleaned:
        candidate = current + char
        bbox = draw.textbbox((0, 0), candidate, font=font)
        if current and bbox[2] - bbox[0] > max_width:
            lines.append(current)
            current = char
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines[:3]


def _make_label_image(
    current_index: int,
    total_count: int,
    model_name: str,
    label_width: int,
    label_height: int,
    font_size: int,
) -> torch.Tensor:
    width = max(64, int(label_width))
    height = max(24, int(label_height))
    image = Image.new("RGB", (width, height), _hex_color("#111820", (17, 24, 32)))
    draw = ImageDraw.Draw(image)
    font = _font(int(font_size))
    title = f"{current_index} / {max(0, total_count)}"
    label = str(model_name or "未匹配到模型")
    padding = max(8, int(font_size * 0.45))
    title_bbox = draw.textbbox((0, 0), title, font=font)
    title_w = title_bbox[2] - title_bbox[0]
    draw.text((padding, padding), title, fill=(130, 190, 255), font=font)

    text_left = padding + title_w + padding
    max_text_width = max(16, width - text_left - padding)
    wrapped = _wrap_text(draw, label, font, max_text_width)
    line_height = max(10, math.ceil(int(font_size) * 1.22))
    total_text_h = line_height * len(wrapped)
    y = max(padding, (height - total_text_h) // 2)
    for line in wrapped:
        draw.text((text_left, y), line, fill=(255, 255, 255), font=font)
        y += line_height

    array = np.asarray(image).astype(np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


class GJJ_ModelEffectTester:
    CATEGORY = "GJJ"
    FUNCTION = "build"
    DESCRIPTION = "按 checkpoints 或 diffusion_models 的过滤列表逐项输出当前模型、宽度、列表状态和名称注解图。"
    SEARCH_ALIASES = ["model test", "model effect", "checkpoint test", "unet test", "模型效果", "模型测试", "底模测试"]
    RETURN_TYPES = ("COMBO", "INT", "STRING", "STRING", "IMAGE")
    RETURN_NAMES = ("当前模型", "宽度", "当前模型名称", "过滤模型列表", "模型名称注解图")
    OUTPUT_TOOLTIPS = (
        "当前序号对应的模型相对路径。可连接到 GJJ_LazyImageStudio 的 UNET 主模型，或 GJJ_CheckpointDirectGenerator 的底模模型。",
        "测试宽度，可连接到生成节点宽度输入。",
        "当前模型的显示名称。",
        "过滤后的模型测试队列，每行一个模型，带 ✅/❌ 状态。",
        "当前模型名称注解图，可与生成结果拼版查看。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "current_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": MAX_INT,
                        "step": 1,
                        "display_name": "当前序号",
                        "tooltip": "1 基序号；前端测试面板会按当前列表推进。",
                    },
                ),
                "model_source": (
                    MODEL_SOURCES,
                    {
                        "default": "diffusion_models",
                        "display_name": "模型来源",
                        "tooltip": "diffusion_models 对齐 LazyImageStudio 的 UNET 主模型；checkpoints 对齐 CheckpointDirectGenerator 的底模模型。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 64,
                        "max": 8192,
                        "step": 8,
                        "display_name": "输出宽度",
                        "tooltip": "随当前模型一起输出，便于接入生成节点宽度。",
                    },
                ),
                "label_width": (
                    "INT",
                    {"default": 1024, "min": 64, "max": 8192, "step": 8, "display_name": "注解图宽度"},
                ),
                "label_height": (
                    "INT",
                    {"default": 96, "min": 24, "max": 512, "step": 4, "display_name": "注解图高度"},
                ),
                "font_size": (
                    "INT",
                    {"default": 28, "min": 8, "max": 160, "step": 1, "display_name": "注解字号"},
                ),
                STATE_WIDGET: (
                    "STRING",
                    {
                        "default": json.dumps(DEFAULT_STATE, ensure_ascii=False),
                        "display_name": "测试状态",
                        "tooltip": "前端面板维护的 JSON 状态；包含过滤词、子目录、通过/失败记录和自动执行开关。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(
        cls,
        current_index=1,
        model_source="diffusion_models",
        width=1024,
        label_width=1024,
        label_height=96,
        font_size=28,
        test_state="",
    ):
        state = _parse_state(test_state)
        return json.dumps(
            {
                "current_index": int(current_index),
                "model_source": str(model_source),
                "width": int(width),
                "label_width": int(label_width),
                "label_height": int(label_height),
                "font_size": int(font_size),
                "state": state,
                "models": _filtered_models(str(model_source), str(state["filter"]), str(state["subdir"])),
            },
            ensure_ascii=False,
            sort_keys=True,
        )

    def build(
        self,
        current_index: int = 1,
        model_source: str = "diffusion_models",
        width: int = 1024,
        label_width: int = 1024,
        label_height: int = 96,
        font_size: int = 28,
        test_state: str = "",
    ):
        state = _parse_state(test_state)
        models = _filtered_models(str(model_source), str(state["filter"]), str(state["subdir"]))
        passed = set(_parse_key_list(state["passed"]))
        failed = set(_parse_key_list(state["failed"]))
        total_count = len(models)
        requested_index = max(1, int(current_index))

        current_model = ""
        current_name = ""
        effective_index = 0
        if total_count > 0 and requested_index <= total_count:
            effective_index = requested_index
            current_model = models[effective_index - 1]
            current_name = _display_model_name(current_model)
        elif total_count > 0:
            effective_index = total_count

        label_image = _make_label_image(
            effective_index,
            total_count,
            current_name,
            label_width,
            label_height,
            font_size,
        )
        if total_count <= 0:
            status = "未匹配到模型"
        elif requested_index > total_count:
            status = f"已到末尾：当前 {requested_index}，总数 {total_count}"
        else:
            status = f"本轮 {effective_index} / {total_count}：{current_name}"

        return {
            "ui": {
                "gjj_model_effect_tester": [
                    {
                        "state": state,
                        "model_source": str(model_source),
                        "current_index": requested_index,
                        "effective_index": int(effective_index),
                        "total_count": int(total_count),
                        "current_key": current_model,
                        "current_name": current_name,
                        "status": status,
                    }
                ]
            },
            "result": (
                current_model,
                int(width),
                current_name,
                "\n".join(_combo_label(name, passed, failed) for name in models),
                label_image,
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ModelEffectTester}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧪 模型效果测试"}
