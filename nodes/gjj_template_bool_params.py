from __future__ import annotations

import ast
import json
import re
from typing import Any


NODE_NAME = "GJJ_TemplateBoolParams"
MAX_OUTPUTS = 32
DEFAULT_TEMPLATE = "#启用加速Lora\n步数（steps）：4|20\n遵循值（cfg）：1.0|2.5"


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _normalize_text(value: Any) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def _strip_quotes(text: str) -> str:
    raw = str(text or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'"', "'"}:
        try:
            return ast.literal_eval(raw)
        except Exception:
            return raw[1:-1]
    return raw


def _split_pair(text: str) -> tuple[str, str]:
    raw = str(text or "")
    escaped = False
    quote = ""
    for index, char in enumerate(raw):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char in {'"', "'"}:
            if quote == char:
                quote = ""
            elif not quote:
                quote = char
            continue
        if char in {"|", "｜"} and not quote:
            return raw[:index].replace("\\|", "|").strip(), raw[index + 1 :].replace("\\|", "|").strip()
    value = raw.replace("\\|", "|").strip()
    return value, value


def _split_label_and_key(raw_label: str, index: int) -> tuple[str, str]:
    label = str(raw_label or "").strip() or f"参数 {index + 1}"
    match = re.fullmatch(r"(.+?)[（(]\s*([^（）()]+?)\s*[）)]", label)
    if match:
        display = match.group(1).strip() or label
        key = match.group(2).strip()
    else:
        display = label
        key = label
    key = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff-]+", "_", key).strip("_") or f"param_{index + 1}"
    return display, key


def _parse_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    raw = value.strip()
    if raw == "":
        return ""

    forced = re.fullmatch(r"(?is)\s*(int|float|str|string|bool|boolean|json|none|null)\s*\((.*)\)\s*", raw)
    if forced:
        kind = forced.group(1).lower()
        inner = forced.group(2).strip()
        if kind == "int":
            return int(float(_strip_quotes(inner) or 0))
        if kind == "float":
            return float(_strip_quotes(inner) or 0)
        if kind in {"str", "string"}:
            return _strip_quotes(inner)
        if kind in {"bool", "boolean"}:
            return _to_bool(_strip_quotes(inner))
        if kind in {"none", "null"}:
            return None
        if kind == "json":
            return json.loads(inner)

    lowered = raw.lower()
    if lowered in {"true", "yes", "y", "on", "是", "真", "开", "启用"}:
        return True
    if lowered in {"false", "no", "n", "off", "否", "假", "关", "禁用"}:
        return False
    if lowered in {"none", "null", "nil", "空"}:
        return None
    if re.fullmatch(r"[-+]?\d+", raw):
        return int(raw)
    if re.fullmatch(r"[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?", raw) or re.fullmatch(r"[-+]?\d+[eE][-+]?\d+", raw):
        return float(raw)
    if raw[:1] in "[{(" or raw[-1:] in "]})":
        try:
            return json.loads(raw)
        except Exception:
            try:
                return ast.literal_eval(raw)
            except Exception:
                pass
    return raw


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "y", "on", "是", "真", "开", "启用"}:
        return True
    if text in {"0", "false", "no", "n", "off", "否", "假", "关", "禁用"}:
        return False
    return bool(value)


def _infer_output_type(true_value: Any, false_value: Any) -> str:
    values = (true_value, false_value)
    if all(isinstance(item, bool) for item in values):
        return "BOOLEAN"
    if all(isinstance(item, int) and not isinstance(item, bool) for item in values):
        return "INT"
    if all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in values):
        return "FLOAT"
    if all(isinstance(item, str) for item in values):
        return "STRING"
    return "*"


def parse_template(template_text: Any) -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    for raw_line in _normalize_text(template_text or DEFAULT_TEMPLATE).split("\n"):
        line = raw_line.strip()
        if not line or line.startswith(("#", "//", ";")) or line in {"...", "....", "…", "……"}:
            continue
        match = re.match(r"^([^:：=]+?)\s*[:：=]\s*(.*?)\s*$", line)
        if not match:
            continue
        label, key = _split_label_and_key(match.group(1), len(fields))
        count = seen.get(key, 0)
        seen[key] = count + 1
        if count:
            key = f"{key}_{count + 1}"
        true_raw, false_raw = _split_pair(match.group(2))
        true_value = _parse_value(true_raw)
        false_value = _parse_value(false_raw)
        fields.append(
            {
                "key": key,
                "label": label,
                "true_raw": true_raw,
                "false_raw": false_raw,
                "true_value": true_value,
                "false_value": false_value,
                "type": _infer_output_type(true_value, false_value),
            }
        )
        if len(fields) >= MAX_OUTPUTS:
            break
    return fields


class GJJ_TemplateBoolParams:
    CATEGORY = "GJJ/逻辑控制"
    FUNCTION = "output_params"
    DESCRIPTION = "模板布尔参数：模板首行可写 #按钮文字，其余行用 名称（key）：真值|假值 动态生成输出口。"
    SEARCH_ALIASES = ["template bool", "模板布尔", "布尔模板", "布尔参数", "steps", "cfg", "boolean params"]
    RETURN_TYPES = tuple(any_type for _ in range(MAX_OUTPUTS))
    RETURN_NAMES = tuple(f"输出{i + 1}" for i in range(MAX_OUTPUTS))
    OUTPUT_TOOLTIPS = tuple("由模板布尔参数生成的输出值；布尔为真取左值，为假取右值。" for _ in range(MAX_OUTPUTS))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "boolean": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "是否启用",
                        "tooltip": "控制模板取值。为真时输出每行竖线左侧的值，为假时输出右侧的值。",
                    },
                ),
                "template_text": (
                    "STRING",
                    {
                        "default": DEFAULT_TEMPLATE,
                        "multiline": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "隐藏模板",
                        "tooltip": "由前端 ⚙️设置按钮维护。首行可写 #按钮文字，其余行格式：名称（key）：真值|假值。",
                    },
                ),
            },
            "optional": {
                "boolean_input": (
                    "BOOLEAN",
                    {
                        "forceInput": True,
                        "display_name": "布尔输入",
                        "tooltip": "可选外部布尔输入。连接后执行时优先使用外部布尔值，面板按钮只显示连接来源。",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(cls, boolean: bool = True, template_text: str = "", boolean_input: bool | None = None):
        effective = boolean if boolean_input is None else boolean_input
        return json.dumps([_to_bool(effective), _normalize_text(template_text or DEFAULT_TEMPLATE)], ensure_ascii=False)

    def output_params(self, boolean: bool = True, template_text: str = "", boolean_input: bool | None = None):
        enabled = _to_bool(boolean if boolean_input is None else boolean_input)
        outputs: list[Any] = []
        for field in parse_template(template_text or DEFAULT_TEMPLATE):
            outputs.append(field["true_value"] if enabled else field["false_value"])
        while len(outputs) < MAX_OUTPUTS:
            outputs.append(None)
        return tuple(outputs[:MAX_OUTPUTS])


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TemplateBoolParams}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔘 模板布尔参数"}
