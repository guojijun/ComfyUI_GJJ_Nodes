from __future__ import annotations

from typing import Any


NODE_NAME = "GJJ_ConditionPassthrough"


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


class GJJ_ConditionPassthrough:
    CATEGORY = "GJJ/逻辑控制"
    FUNCTION = "passthrough"
    DESCRIPTION = "条件透传任意对象。前端可用 ⚡ 选择 GJJ_TemplateParams 或 GJJ_SETNODE 的布尔变量；变量为真时透传，为假时提交前临时旁路下游链路。"
    SEARCH_ALIASES = ["condition passthrough", "条件透传", "条件旁路", "任意透传", "bypass downstream", "template params boolean"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("任意输出",)
    OUTPUT_TOOLTIPS = ("原样输出输入对象；若前端选择的布尔变量为假，下游节点会在提交前被临时旁路。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "input": (
                    any_type,
                    {
                        "display_name": "任意输入",
                        "tooltip": "需要条件透传的任意对象。布尔变量为真时原样输出，变量为假时下游链路会被临时旁路。",
                        "forceInput": True,
                    },
                ),
                "condition": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "条件",
                        "tooltip": "可直接外接布尔值；前端 ⚡ 选择变量时，会在提交前自动接入对应 GJJ_TemplateParams 或 GJJ_SETNODE 布尔变量。",
                        "forceInput": True,
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(cls, input: Any = None, condition: Any = True):
        return (repr(input), bool(condition))

    def passthrough(self, input: Any = None, condition: Any = True):
        passed = bool(condition)
        return {
            "ui": {
                "condition_passthrough_passed": [passed],
                "condition_passthrough_status": ["条件为真，已透传。" if passed else "条件为假，下游已旁路。"],
            },
            "result": (input,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ConditionPassthrough}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🚦 条件透传"}
