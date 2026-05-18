from __future__ import annotations

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
    """Split `值 # 提示` into (值, 提示). Supports escaping literal # with \#."""
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
    DESCRIPTION = "通过模板文本自动生成参数输入框和输出口。支持格式：帧率：24.0 # 每秒帧数"
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
    OUTPUT_TOOLTIPS = tuple("由模板自动解析出的参数值。" for _ in range(MAX_OUTPUTS))

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
                        "tooltip": "由前端 ⚙ 设置按钮维护。每行一个参数，支持格式：名称：默认值 # 说明",
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
            outputs.append(parse_value(raw_value))
        while len(outputs) < MAX_OUTPUTS:
            outputs.append(None)
        return tuple(outputs[:MAX_OUTPUTS])


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TemplateParams}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ⚙ 模板参数输入器"}
