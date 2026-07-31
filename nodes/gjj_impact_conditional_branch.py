from __future__ import annotations

from typing import Any


NODE_NAME = "GJJ_ImpactConditionalBranch"


class AnyType(str):
    """始终可兼容任意类型的占位类型。"""

    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


class GJJImpactConditionalBranch:
    CATEGORY = "GJJ/🔀 逻辑与流程/逻辑"
    FUNCTION = "doit"
    DESCRIPTION = "零依赖复刻 ImpactConditionalBranch：按布尔条件只执行并输出被选中的任意输入。"
    SEARCH_ALIASES = ["ImpactConditionalBranch", "conditional branch", "impact branch", "条件分支", "惰性分支"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("选中输出",)
    OUTPUT_TOOLTIPS = ("条件为真时输出“为真值”，为假时输出“为假值”；未选中的分支保持惰性，不会被要求执行。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cond": (
                    "BOOLEAN",
                    {
                        "display_name": "条件",
                        "tooltip": "控制输出分支。开启时选择“为真值”，关闭时选择“为假值”。",
                    },
                ),
                "tt_value": (
                    any_type,
                    {
                        "lazy": True,
                        "display_name": "为真值",
                        "tooltip": "条件为真时才会请求并输出这一路输入。",
                    },
                ),
                "ff_value": (
                    any_type,
                    {
                        "lazy": True,
                        "display_name": "为假值",
                        "tooltip": "条件为假时才会请求并输出这一路输入。",
                    },
                ),
            },
        }

    def check_lazy_status(self, cond: bool, tt_value: Any = None, ff_value: Any = None):
        if cond and tt_value is None:
            return ["tt_value"]
        if not cond and ff_value is None:
            return ["ff_value"]
        return []

    def doit(self, cond: bool, tt_value: Any = None, ff_value: Any = None):
        return (tt_value if cond else ff_value,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJImpactConditionalBranch}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔀 Impact条件分支"}
