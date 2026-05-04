from __future__ import annotations

from typing import Any


NODE_NAME = "GJJ_AnySwitch"


class AnyType(str):
    """始终可兼容任意类型的占位类型。"""

    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    """允许节点接收动态数量与动态类型的可选输入。"""

    def __init__(self, input_type, data: dict[str, Any] | None = None):
        super().__init__()
        self.input_type = input_type
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        return (self.input_type,)

    def __contains__(self, key):
        return True


any_type = AnyType("*")


def is_context_empty(ctx: Any) -> bool:
    return not ctx or all(value is None for value in ctx.values())


def is_none(value: Any) -> bool:
    if value is not None:
        if isinstance(value, dict) and "model" in value and "clip" in value:
            return is_context_empty(value)
    return value is None


def extract_input_index(name: str) -> int:
    text = str(name or "")
    if not text.startswith("any_"):
        return 999999
    try:
        return int(text[4:])
    except Exception:
        return 999999


class GJJ_AnySwitch:
    CATEGORY = "GJJ"
    FUNCTION = "switch"
    DESCRIPTION = "按输入顺序返回第一个非空值的动态切换器，支持任意类型并会自动增减输入插槽。"
    SEARCH_ALIASES = ["any switch", "switch", "first valid", "动态切换", "任意切换", "选择器"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("任意切换结果",)
    OUTPUT_TOOLTIPS = ("按输入插槽顺序返回第一个非空值；若全部为空，则返回空值。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": FlexibleOptionalInputType(any_type),
        }

    def switch(self, **kwargs):
        chosen = None
        for key in sorted(kwargs.keys(), key=extract_input_index):
            if not key.startswith("any_"):
                continue
            value = kwargs.get(key)
            if not is_none(value):
                chosen = value
                break
        return (chosen,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AnySwitch}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔀 任意切换器"}
