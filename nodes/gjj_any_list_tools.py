from __future__ import annotations

from typing import Any


class AnyType(str):
    """始终可兼容任意类型的占位类型。"""

    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _any_input(index: int):
    return (
        any_type,
        {
            "display_name": f"任意输入 {index}",
            "tooltip": f"第 {index} 路任意类型输入；如果输入本身是列表，会按需要展开。",
        },
    )


def _as_list(value: Any, flatten: bool) -> list[Any]:
    if value is None:
        return []
    if flatten and isinstance(value, list):
        return list(value)
    return [value]


class GJJ_AnyListMerge:
    CATEGORY = "GJJ"
    FUNCTION = "merge"
    DESCRIPTION = "把多路任意输入合并成 ComfyUI 列表输出，适合批量参数、批量提示词和批量对象整理。"
    SEARCH_ALIASES = ["any list", "merge list", "列表合并", "任意列表"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("任意列表",)
    OUTPUT_TOOLTIPS = ("合并后的任意对象列表。",)
    OUTPUT_IS_LIST = (True,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "flatten": ("BOOLEAN", {"default": True, "display_name": "展开列表输入", "tooltip": "开启后，输入本身是列表时会展开后再合并。"}),
                "skip_empty": ("BOOLEAN", {"default": True, "display_name": "跳过空值", "tooltip": "开启后会跳过未连接或为空的输入。"}),
            },
            "optional": {f"any_{i}": _any_input(i) for i in range(1, 13)},
        }

    def merge(self, flatten: bool, skip_empty: bool, **kwargs):
        values: list[Any] = []
        for i in range(1, 13):
            value = kwargs.get(f"any_{i}")
            if value is None and skip_empty:
                continue
            values.extend(_as_list(value, bool(flatten)))
        return (values,)


class GuojijunAnyListRepeat:
    CATEGORY = "guojijun/内部引用"
    FUNCTION = "repeat"
    DEPRECATED = True
    DESCRIPTION = "把输入对象或列表重复指定次数并输出为列表。"
    SEARCH_ALIASES = []
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("重复列表",)
    OUTPUT_TOOLTIPS = ("重复后的任意对象列表。",)
    OUTPUT_IS_LIST = (True,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "any": (any_type, {"display_name": "任意输入", "tooltip": "需要重复的对象或列表。"}),
                "repeat": ("INT", {"default": 2, "min": 1, "max": 10000, "display_name": "重复次数", "tooltip": "把输入内容重复多少次。"}),
                "flatten": ("BOOLEAN", {"default": True, "display_name": "展开列表输入", "tooltip": "开启后，输入为列表时会重复列表里的每一项。"}),
            }
        }

    def repeat(self, any, repeat: int, flatten: bool):
        source = _as_list(any, bool(flatten))
        return (source * int(repeat),)


class GJJ_AnyListPick:
    CATEGORY = "GJJ"
    FUNCTION = "pick"
    DESCRIPTION = "从任意列表中按序号取一项，序号支持循环。"
    SEARCH_ALIASES = ["pick list", "list item", "列表取项", "按索引取值"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("选中对象",)
    OUTPUT_TOOLTIPS = ("列表中选中的一个对象。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "items": (any_type, {"display_name": "任意列表", "tooltip": "输入列表；也可接普通对象，节点会按单项列表处理。"}),
                "index": ("INT", {"default": 1, "min": -100000, "max": 100000, "display_name": "序号", "tooltip": "按 1 基序号取项；1 表示第一项，-1 表示最后一项。"}),
                "wrap": ("BOOLEAN", {"default": True, "display_name": "超出时循环", "tooltip": "开启后序号超出范围会按列表长度循环。"}),
            }
        }

    def pick(self, items, index: int, wrap: bool):
        values = list(items) if isinstance(items, list) else [items]
        if not values:
            return (None,)
        idx = int(index)
        raw = idx - 1 if idx > 0 else idx
        if wrap:
            raw = raw % len(values)
        if raw < -len(values) or raw >= len(values):
            raise ValueError("序号超出列表范围。")
        return (values[raw],)


class GJJ_AnyListFilter:
    CATEGORY = "GJJ"
    FUNCTION = "filter"
    DESCRIPTION = "按起止序号和可选布尔列表筛选任意列表。"
    SEARCH_ALIASES = ["filter list", "slice list", "列表筛选", "列表切片"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("筛选列表",)
    OUTPUT_TOOLTIPS = ("筛选后的任意对象列表。",)
    OUTPUT_IS_LIST = (True,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "items": (any_type, {"display_name": "任意列表", "tooltip": "需要筛选的列表；普通对象会按单项列表处理。"}),
                "start": ("INT", {"default": 1, "min": 1, "max": 100000, "display_name": "起始序号", "tooltip": "1 基起始序号，包含该项。"}),
                "end": ("INT", {"default": 0, "min": 0, "max": 100000, "display_name": "结束序号", "tooltip": "1 基结束序号，包含该项；0 表示直到末尾。"}),
            },
            "optional": {
                "mask": ("BOOLEAN", {"forceInput": True, "display_name": "布尔筛选列表", "tooltip": "可选布尔列表；对应位置为 True 的项目会保留。"}),
            },
        }

    def filter(self, items, start: int, end: int, mask=None):
        values = list(items) if isinstance(items, list) else [items]
        if not values:
            return ([],)
        start_idx = max(0, int(start) - 1)
        end_idx = len(values) if int(end) <= 0 else min(len(values), int(end))
        sliced = values[start_idx:end_idx]
        if mask is None:
            return (sliced,)
        mask_values = list(mask) if isinstance(mask, list) else [mask]
        result = [value for index, value in enumerate(sliced) if index < len(mask_values) and bool(mask_values[index])]
        return (result,)


NODE_CLASS_MAPPINGS = {
    "GJJ_AnyListMerge": GJJ_AnyListMerge,
    "guojijun_AnyListRepeat": GuojijunAnyListRepeat,
    "GJJ_AnyListPick": GJJ_AnyListPick,
    "GJJ_AnyListFilter": GJJ_AnyListFilter,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_AnyListMerge": "GJJ · 📚 任意列表合并",
    "guojijun_AnyListRepeat": "guojijun · 任意列表重复（内部引用）",
    "GJJ_AnyListPick": "GJJ · 👆 任意列表取项",
    "GJJ_AnyListFilter": "GJJ · 🧹 任意列表筛选",
}
