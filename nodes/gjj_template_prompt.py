from __future__ import annotations

import json
import re
from typing import Any


NODE_NAME = "GJJ_TemplatePrompt"
DEFAULT_TEMPLATE = "一张{{主体}}的照片，{{风格}}，细节丰富"
PLACEHOLDER_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    def __init__(self, input_type: Any):
        super().__init__()
        self.input_type = input_type

    def __getitem__(self, key):
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


class GJJ_TemplatePrompt:
    CATEGORY = "GJJ/提示词"
    FUNCTION = "render_template"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("完整提示词",)
    OUTPUT_TOOLTIPS = ("把模板中的 {{参数}} 替换为面板值、外部连线值或 GJJ 参数绑定值后的完整文本。",)
    DESCRIPTION = "模板提示词节点。使用 {{参数名}} 声明动态参数；参数可在面板输入，也可通过左侧插口外接。前端可从 GJJ_TemplateParams 和 GJJ_SETNODE 选择参数并隐藏对应插槽。"
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
                        "tooltip": "由前端 ⚙️ 设置按钮维护。写 {{参数名}} 会自动生成对应参数插槽。",
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
            "optional": FlexibleOptionalInputType(any_type),
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
        dynamic = {str(k): repr(v) for k, v in sorted(kwargs.items()) if str(k).startswith("param_")}
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
        template = _normalize_text(template_text or DEFAULT_TEMPLATE)
        values = _safe_json_loads(values_json, {})
        if not isinstance(values, dict):
            values = {}

        names = _placeholder_names(template)
        key_by_name = {name: _param_key(name) for name in names}

        def replacement(match: re.Match[str]) -> str:
            name = match.group(1).strip()
            key = key_by_name.get(name) or _param_key(name)
            input_name = f"param_{key}"
            if input_name in kwargs and kwargs.get(input_name) is not None:
                return _normalize_text(kwargs.get(input_name))
            if key in values:
                return _normalize_text(values.get(key))
            if name in values:
                return _normalize_text(values.get(name))
            return ""

        return (PLACEHOLDER_RE.sub(replacement, template),)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TemplatePrompt}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧾 模板提示词"}
