import json

NODE_NAME = "GJJ_PromptGroupSwitch"


class GJJ_PromptGroupSwitch:
    NAME = "GJJ_PromptGroupSwitch"
    DISPLAY_NAME = "提示词分组切换"
    CATEGORY = "GJJ"
    DESCRIPTION = "在同一个工作流里维护多组提示词文本，并按序号切换输出当前选中的那一组。"
    SEARCH_ALIASES = ["prompt group switch", "prompt switch", "提示词", "分组", "切换"]

    FUNCTION = "func"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("切换提示结果",)
    OUTPUT_TOOLTIPS = ("当前分组序号对应的提示词文本。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "group_id": ("STRING", {
                    "default": "group_1",
                    "multiline": False,
                    "display_name": "分组ID",
                    "tooltip": "不同分组 ID 彼此独立，适合在同一工作流中并行切换多套提示词。",
                }),
                "select": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 3,
                    "display_name": "选择序号（1-3）",
                    "tooltip": "指定当前输出第几组提示词内容。",
                }),
            },
            "optional": {
                "prompt_1": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "提示词1",
                    "tooltip": "第一组可切换的提示词内容。",
                }),
                "prompt_2": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "提示词2",
                    "tooltip": "第二组可切换的提示词内容。",
                }),
                "prompt_3": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "提示词3",
                    "tooltip": "第三组可切换的提示词内容。",
                }),
            }
        }

    def func(self, group_id, select, prompt_1, prompt_2, prompt_3):
        out = ""
        if select == 1:
            out = prompt_1
        elif select == 2:
            out = prompt_2
        elif select == 3:
            out = prompt_3
        return (out,)

NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_PromptGroupSwitch}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔀 提示词分组切换"}
