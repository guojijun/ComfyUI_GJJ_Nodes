from __future__ import annotations

from typing import Any


NODE_NAME = "GJJ_AdvancedPassthroughRouter"
MAX_SLOTS = 64


class AnyType(str):
    """始终可兼容任意 ComfyUI 插槽类型。"""

    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    """允许前端动态添加任意数量、任意类型的输入口。"""

    def __init__(self, input_type):
        super().__init__()
        self.input_type = input_type

    def __getitem__(self, key):
        return (
            self.input_type,
            {
                "display_name": _display_name_for_key(key, "输入"),
                "tooltip": "透传任意类型数据；连接后会生成对应输出口并继续追加下一组空插槽。",
            },
        )

    def __contains__(self, key):
        return True


any_type = AnyType("*")


def _extract_index(name: str) -> int:
    text = str(name or "")
    if "_" not in text:
        return 999999
    try:
        return int(text.rsplit("_", 1)[1])
    except Exception:
        return 999999


def _display_name_for_key(key: str, prefix: str) -> str:
    index = _extract_index(key)
    if index == 999999:
        return prefix
    return f"{prefix} {index}"


class GJJ_AdvancedPassthroughRouter:
    CATEGORY = "GJJ"
    FUNCTION = "route"
    DESCRIPTION = "高级透传路由：支持任意类型输入输出。默认一组输入/输出，输入连接后输出会跟随输入类型与标签，并自动扩展下一组。"
    SEARCH_ALIASES = [
        "reroute",
        "route",
        "passthrough",
        "advanced reroute",
        "高级透传",
        "透传路由",
        "任意路由",
        "动态路由",
    ]
    RETURN_TYPES = tuple(any_type for _ in range(MAX_SLOTS))
    RETURN_NAMES = tuple(f"输出 {index}" for index in range(1, MAX_SLOTS + 1))
    OUTPUT_TOOLTIPS = tuple(
        "透传同序号输入口的数据；前端会按连接类型自动调整可见输出口。"
        for _ in range(MAX_SLOTS)
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": FlexibleOptionalInputType(any_type),
        }

    def route(self, **kwargs):
        values = []
        for index in range(1, MAX_SLOTS + 1):
            values.append(kwargs.get(f"any_{index:02d}"))
        return tuple(values)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AdvancedPassthroughRouter}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔁 高级透传路由"}
