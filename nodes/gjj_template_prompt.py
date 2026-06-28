from __future__ import annotations

import json
import re
from typing import Any


NODE_NAME = "GJJ_TemplatePrompt"
DEFAULT_TEMPLATE = "一张{{主体}}的照片，{{风格}}，细节丰富"
EXTERNAL_TEMPLATE_INPUT = "external_template"
PLACEHOLDER_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
CHOICE_SPLIT_RE = re.compile(r"[,，、|]+")


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    def __init__(self, input_type: Any, fixed: dict[str, Any] | None = None):
        super().__init__(fixed or {})
        self.input_type = input_type

    def __getitem__(self, key):
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        return (self.input_type,)

    def __contains__(self, key):
        return True


any_type = AnyType("*")


def _normalize_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _safe_json_loads(value: Any, fallback: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value or ""))
    except Exception:
        return fallback


def _param_key(name: Any) -> str:
    text = _normalize_text(name).strip()
    key = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff-]+", "_", text).strip("_")
    return key or "param"


def _output_label(value: Any) -> str:
    text = _normalize_text(value).strip()
    cleaned = re.sub(r"^[^0-9A-Za-z_\u4e00-\u9fff]+", "", text)
    cleaned = cleaned.replace("\u200d", "").replace("\ufe0e", "").replace("\ufe0f", "").strip()
    return cleaned or text


def _placeholder_names(template: Any) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for match in PLACEHOLDER_RE.finditer(_normalize_text(template)):
        name = match.group(1).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        names.append(name)
    return names


def _parse_default_expr(expr: Any) -> dict[str, str]:
    source = _normalize_text(expr).strip()
    match = re.match(r"^(.*?)[(（]\s*([^()（）]+?)\s*[)）]\s*$", source)
    if not match:
        return {"label": source, "default": ""}
    label = match.group(1).strip()
    default = match.group(2).strip()
    if not label or not default:
        return {"label": source, "default": ""}
    return {"label": label, "default": default}


def _parse_placeholder_expr(expr: Any) -> dict[str, Any]:
    source = _normalize_text(expr).strip()
    if ":" in source:
        label, option_text = source.split(":", 1)
        parsed_label = _parse_default_expr(label)
        label = parsed_label["label"]
        options = [item.strip() for item in CHOICE_SPLIT_RE.split(option_text) if item.strip()]
        if label and len(options) >= 2:
            return {
                "expr": source,
                "label": label,
                "output_label": _output_label(label),
                "key_source": label,
                "kind": "choice",
                "options": options,
                "default": parsed_label["default"] if parsed_label["default"] in options else options[0],
            }
    parsed = _parse_default_expr(source)
    return {
        "expr": source,
        "label": parsed["label"],
        "output_label": _output_label(parsed["label"]),
        "key_source": parsed["label"],
        "kind": "text",
        "options": [],
        "default": parsed["default"],
    }


def _template_fields(template: Any) -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    seen_exprs: set[str] = set()
    seen_keys: dict[str, int] = {}
    for match in PLACEHOLDER_RE.finditer(_normalize_text(template)):
        expr = match.group(1).strip()
        if not expr or expr in seen_exprs:
            continue
        seen_exprs.add(expr)
        field = _parse_placeholder_expr(expr)
        base = _param_key(field["key_source"])
        count = seen_keys.get(base, 0)
        seen_keys[base] = count + 1
        key = f"{base}_{count + 1}" if count else base
        field["key"] = key
        field["input_name"] = f"param_{key}"
        fields.append(field)
    return fields


def _format_choice_output(field: dict[str, Any], selected: Any) -> str:
    text = _normalize_text(selected).strip()
    if not text:
        return ""
    label = _normalize_text(field.get("output_label") or _output_label(field.get("label"))).strip()
    return f"{label}：{text}" if label else text


def _field_text_value(field: dict[str, Any], values: dict[str, Any], expr: str, key: str) -> str:
    for value_key in (key, str(field.get("label") or ""), str(field.get("output_label") or ""), expr, _param_key(expr)):
        if value_key and value_key in values:
            text = _normalize_text(values.get(value_key))
            if text or not field.get("default"):
                return text
    return _normalize_text(field.get("default"))


class GJJ_TemplatePrompt:
    CATEGORY = "GJJ/提示词"
    FUNCTION = "render_template"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("完整提示词",)
    OUTPUT_TOOLTIPS = ("把模板中的 {{参数}} 替换为面板值、外部连线值或 GJJ 参数绑定值后的完整文本。",)
    DESCRIPTION = "模板提示词节点。使用 {{参数名}} 声明动态参数；使用 {{参数名(默认值)}} 声明默认值；使用 {{名称:选项1,选项2}} 声明按钮组选项，默认单选，按 Ctrl/Shift 可多选，输出会自动带“名称：”前缀。全角冒号 {{名称：正文}} 会按普通文本参数处理。普通参数可在面板输入，也可通过左侧插口外接。前端可从 GJJ_TemplateParams 和 GJJ_SETNODE 选择参数并隐藏对应插槽。可选外接模板输入连线后优先使用外部模板。"
    SEARCH_ALIASES = ["template prompt", "提示词模板", "模板提示词", "prompt template"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "template_text": (
                    "STRING",
                    {
                        "default": DEFAULT_TEMPLATE,
                        "multiline": True,
                        "hidden": True,
                        "display": "hidden",
                        "display_name": "隐藏模板",
                        "tooltip": "由前端 ⚙️ 设置按钮维护。写 {{参数名}} 会自动生成对应参数插槽；写 {{参数名(默认值)}} 可设置默认值；写 {{名称:选项1,选项2}} 会生成按钮组，默认单选，按 Ctrl/Shift 可多选，输出自动带“名称：”前缀。全角冒号不触发按钮组。",
                    },
                ),
                "values_json": (
                    "STRING",
                    {
                        "default": "{}",
                        "multiline": True,
                        "hidden": True,
                        "display": "hidden",
                        "display_name": "参数值 JSON",
                        "tooltip": "由前端面板维护的参数值，不建议手动修改。",
                    },
                ),
                "bindings_json": (
                    "STRING",
                    {
                        "default": "{}",
                        "multiline": True,
                        "hidden": True,
                        "display": "hidden",
                        "display_name": "参数绑定 JSON",
                        "tooltip": "记录 ⚡参数 选择的 GJJ 参数来源，不建议手动修改。",
                    },
                ),
                "schema_json": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": True,
                        "hidden": True,
                        "display": "hidden",
                        "display_name": "参数结构 JSON",
                        "tooltip": "由前端维护的参数结构，供变量读取和界面恢复使用。",
                    },
                ),
            },
            "optional": FlexibleOptionalInputType(
                any_type,
                {
                    EXTERNAL_TEMPLATE_INPUT: (
                        "GJJ_PROMPT",
                        {
                            "forceInput": True,
                            "display_name": "外接模板",
                            "tooltip": "可选。连接后优先使用外部模板文本，并隐藏节点内部模板设置、按钮和参数面板；断开后恢复内部模板。",
                        },
                    ),
                },
            ),
        }

    @classmethod
    def IS_CHANGED(
        cls,
        template_text: str = "",
        values_json: str = "{}",
        bindings_json: str = "{}",
        schema_json: str = "[]",
        **kwargs,
    ):
        dynamic = {
            str(k): repr(v)
            for k, v in sorted(kwargs.items())
            if str(k) == EXTERNAL_TEMPLATE_INPUT or str(k).startswith("param_")
        }
        return json.dumps(
            [_normalize_text(template_text), _normalize_text(values_json), _normalize_text(bindings_json), _normalize_text(schema_json), dynamic],
            ensure_ascii=False,
            sort_keys=True,
        )

    def render_template(
        self,
        template_text: str = "",
        values_json: str = "{}",
        bindings_json: str = "{}",
        schema_json: str = "[]",
        **kwargs,
    ):
        external_template = _normalize_text(kwargs.get(EXTERNAL_TEMPLATE_INPUT)).strip()
        template = external_template or _normalize_text(template_text or DEFAULT_TEMPLATE)
        values = _safe_json_loads(values_json, {})
        if not isinstance(values, dict):
            values = {}

        fields = _template_fields(template)
        field_by_expr = {str(field.get("expr") or ""): field for field in fields}

        def replacement(match: re.Match[str]) -> str:
            expr = match.group(1).strip()
            field = field_by_expr.get(expr) or _parse_placeholder_expr(expr)
            key = str(field.get("key") or _param_key(field.get("key_source") or expr))
            input_name = str(field.get("input_name") or f"param_{key}")
            if input_name in kwargs and kwargs.get(input_name) is not None:
                input_text = _normalize_text(kwargs.get(input_name))
                if input_text:
                    return input_text
            if field.get("kind") == "choice":
                options = [str(item) for item in field.get("options") or [] if str(item).strip()]
                default = str(field.get("default") or (options[0] if options else ""))
                legacy_key = _param_key(expr)
                output_label = str(field.get("output_label") or "")
                raw_selected = values.get(
                    key,
                    values.get(
                        field.get("label"),
                        values.get(output_label, values.get(expr, values.get(legacy_key, default))),
                    ),
                )
                if isinstance(raw_selected, (list, tuple)):
                    if not raw_selected:
                        return ""
                    selected_values: list[str] = []
                    for item in raw_selected:
                        selected = _normalize_text(item).strip()
                        if selected in options:
                            selected_values.append(selected)
                    return _format_choice_output(field, "、".join(selected_values))
                selected = _normalize_text(raw_selected).strip()
                if not selected:
                    return ""
                return _format_choice_output(field, selected if selected in options else default)
            return _field_text_value(field, values, expr, key)

        return (PLACEHOLDER_RE.sub(replacement, template),)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TemplatePrompt}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧾 模板提示词"}
