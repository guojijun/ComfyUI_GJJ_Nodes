from __future__ import annotations

import json
import math
import os
import re
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageColor, ImageDraw, ImageFont

import folder_paths


NODE_NAME = "GJJ_LoraEffectTester"
MAX_INT = 0xFFFFFFFFFFFFFFFF
STATE_WIDGET = "test_state"
LABEL_BACKGROUND = "#111820"
LABEL_TEXT_COLOR = "#FFFFFF"
DEFAULT_STATE = {
    "version": 2,
    "filter": "",
    "strengths": [1.0],
    "passed": [],
    "failed": [],
    "auto": True,
    "skip": True,
    "refresh": "",
}
PASS_MARK = "✅ "
FAIL_MARK = "❌ "


def _safe_lora_list() -> list[str]:
    try:
        return [str(item) for item in folder_paths.get_filename_list("loras") if str(item or "").strip()]
    except Exception:
        return []


def _normalize_keyword(value: str) -> str:
    return str(value or "").strip().lower()


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


def _filtered_loras(filter_keywords: str) -> list[str]:
    expression = _parse_search_expression(filter_keywords)
    return [name for name in _safe_lora_list() if _matches_search_expression(name, expression)]


def _format_strength(value: float) -> str:
    return f"{float(value):.1f}"


def _display_lora_name(lora_name: str) -> str:
    text = str(lora_name or "").strip()
    if not text:
        return ""
    base, ext = os.path.splitext(text)
    display = base if ext else text
    return re.sub(r"[\\/]+", "_", display)


def _combo_key(lora_name: str, strength: float) -> str:
    return f"{lora_name}::{_format_strength(strength)}"


def _display_label(lora_name: str, strength: float) -> str:
    return f"({_format_strength(strength)}){_display_lora_name(lora_name)}"


def _combo_label(lora_name: str, strength: float, passed: set[str], failed: set[str]) -> str:
    key = _combo_key(lora_name, strength)
    mark = FAIL_MARK if key in failed else PASS_MARK if key in passed else ""
    return f"{mark}{_display_label(lora_name, strength)}"


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


def _parse_strengths(value: Any) -> list[float]:
    raw_values: list[Any]
    if isinstance(value, list):
        raw_values = value
    else:
        raw_values = re.split(r"[,，、;；|\s]+", str(value or ""))

    strengths: list[float] = []
    for raw in raw_values:
        try:
            strength = float(raw)
        except (TypeError, ValueError):
            continue
        if not any(abs(strength - old) < 1e-6 for old in strengths):
            strengths.append(strength)
    return strengths or [1.0]


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


def _parse_state(raw_value: Any) -> dict[str, Any]:
    state = dict(DEFAULT_STATE)
    try:
        parsed = json.loads(str(raw_value or "{}"))
    except json.JSONDecodeError:
        parsed = {}
    if isinstance(parsed, dict):
        state["filter"] = str(parsed.get("filter", state["filter"]) or "")
        state["strengths"] = _parse_strengths(parsed.get("strengths", state["strengths"]))
        state["passed"] = _parse_key_list(parsed.get("passed", []))
        state["failed"] = _parse_key_list(parsed.get("failed", []))
        state["auto"] = _as_bool(parsed.get("auto"), True)
        state["skip"] = _as_bool(parsed.get("skip"), True)
        state["refresh"] = str(parsed.get("refresh", "") or "")
    return state


def _combo_items(loras: list[str], strengths: list[float], passed: set[str], failed: set[str]) -> list[dict[str, Any]]:
    return [
        {
            "lora_name": lora_name,
            "strength": float(strength),
            "key": _combo_key(lora_name, strength),
            "name": _display_label(lora_name, strength),
            "display_name": _combo_label(lora_name, strength, passed, failed),
        }
        for lora_name in loras
        for strength in strengths
    ]


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
    lora_name: str,
    label_width: int,
    label_height: int,
    font_size: int,
    background: str,
    text_color: str,
) -> torch.Tensor:
    width = max(64, int(label_width))
    height = max(24, int(label_height))
    bg = _hex_color(background, (17, 24, 32))
    fg = _hex_color(text_color, (255, 255, 255))
    image = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(image)
    font = _font(int(font_size))

    title = f"{current_index} / {max(0, total_count)}"
    label = str(lora_name or "未匹配到 LoRA")
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
        draw.text((text_left, y), line, fill=fg, font=font)
        y += line_height

    array = np.asarray(image).astype(np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


class GJJ_LoraEffectTester:
    CATEGORY = "GJJ"
    FUNCTION = "build"
    DESCRIPTION = "按过滤后的 LoRA 列表和多选强度逐项输出 LoRA 串联配置、当前名称、列表状态和名称注解图。"
    SEARCH_ALIASES = ["lora test", "lora effect", "lora compare", "LoRA测试", "LoRA效果", "LoRA对比", "序列测试"]
    RETURN_TYPES = ("LORA_CHAIN_CONFIG", "STRING", "STRING", "IMAGE")
    RETURN_NAMES = ("当前LoRA串联配置", "当前LoRA名称", "过滤LoRA列表", "LoRA名称注解图")
    OUTPUT_TOOLTIPS = (
        "只包含当前序号对应 LoRA 的原始串联配置；不会带 ✅/❌、强度前缀或去扩展名显示名。",
        "当前序号对应的显示名称，格式为“(强度)名称”，去掉扩展名并把子目录分隔符替换为下划线。",
        "过滤后的 LoRA 与强度测试队列，每行一个测试项，带 ✅/❌ 状态。",
        "当前 LoRA 名称注解图，可与生成结果接入 GJJ · 🧩 图片拼版或任意对象预览器查看。",
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
                        "tooltip": "1 基序号；前端自动测试会在每轮完成后更新这个值。",
                    },
                ),
                "label_width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 64,
                        "max": 8192,
                        "step": 8,
                        "display_name": "注解图宽度",
                        "tooltip": "名称注解图宽度；建议与生成结果宽度一致。",
                    },
                ),
                "label_height": (
                    "INT",
                    {
                        "default": 96,
                        "min": 24,
                        "max": 512,
                        "step": 4,
                        "display_name": "注解图高度",
                        "tooltip": "名称注解图高度；较长 LoRA 名称可适当增大。",
                    },
                ),
                "font_size": (
                    "INT",
                    {
                        "default": 28,
                        "min": 8,
                        "max": 160,
                        "step": 1,
                        "display_name": "注解字号",
                        "tooltip": "LoRA 名称注解字号。",
                    },
                ),
                STATE_WIDGET: (
                    "STRING",
                    {
                        "default": json.dumps(DEFAULT_STATE, ensure_ascii=False),
                        "display_name": "测试状态",
                        "tooltip": "前端面板维护的 JSON 状态；包含过滤词、强度、通过/失败记录和自动执行开关。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(
        cls,
        current_index=1,
        label_width=1024,
        label_height=96,
        font_size=28,
        test_state="",
    ):
        state = _parse_state(test_state)
        return json.dumps(
            {
                "current_index": int(current_index),
                "label_width": int(label_width),
                "label_height": int(label_height),
                "font_size": int(font_size),
                "state": state,
                "loras": _filtered_loras(str(state["filter"])),
            },
            ensure_ascii=False,
            sort_keys=True,
        )

    def build(
        self,
        current_index: int = 1,
        label_width: int = 1024,
        label_height: int = 96,
        font_size: int = 28,
        test_state: str = "",
    ):
        state = _parse_state(test_state)
        loras = _filtered_loras(str(state["filter"]))
        strengths = _parse_strengths(state["strengths"])
        passed_keys = set(_parse_key_list(state["passed"]))
        failed_keys = set(_parse_key_list(state["failed"]))
        items = _combo_items(loras, strengths, passed_keys, failed_keys)
        total_count = len(items)
        requested_index = max(1, int(current_index))

        raw_lora_name = ""
        current_name = ""
        current_strength = strengths[0] if strengths else 1.0
        current_key = ""
        effective_index = 0
        chain_config = "[]"
        if total_count > 0 and requested_index <= total_count:
            effective_index = requested_index
            item = items[effective_index - 1]
            raw_lora_name = str(item["lora_name"])
            current_strength = float(item["strength"])
            current_key = str(item["key"])
            current_name = str(item["name"])
            chain_config = json.dumps(
                [{"enabled": True, "name": raw_lora_name, "strength": current_strength}],
                ensure_ascii=False,
            )
        elif total_count > 0:
            effective_index = total_count

        label_image = _make_label_image(
            effective_index,
            total_count,
            current_name,
            label_width,
            label_height,
            font_size,
            LABEL_BACKGROUND,
            LABEL_TEXT_COLOR,
        )
        if total_count <= 0:
            status = "未匹配到 LoRA"
        elif requested_index > total_count:
            status = f"已到末尾：当前 {requested_index}，总数 {total_count}"
        else:
            status = f"本轮 {effective_index} / {total_count}：{current_name}"

        return {
            "ui": {
                "gjj_lora_effect_tester": [
                    {
                        "state": state,
                        "current_index": requested_index,
                        "effective_index": int(effective_index),
                        "total_count": int(total_count),
                        "current_key": current_key,
                        "current_name": current_name,
                        "raw_lora_name": raw_lora_name,
                        "current_strength": current_strength,
                        "status": status,
                    }
                ]
            },
            "result": (
                chain_config,
                current_name,
                "\n".join(str(item["display_name"]) for item in items),
                label_image,
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LoraEffectTester}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧪 LoRA效果测试"}
