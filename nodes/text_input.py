from __future__ import annotations

from typing import Any


NODE_NAME = "GJJ_TextInput"


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


class GJJ_TextInput:
    CATEGORY = "GJJ"
    FUNCTION = "output_text"
    DESCRIPTION = "提供一个可手填或透传外部输入的文本节点，适合作为工作流里的文本源头；前端支持 Markdown 预览模式。"
    SEARCH_ALIASES = ["text", "text input", "文本", "文本输入", "文字输入", "字符串", "传递文本", "markdown", "Markdown 预览", "文本预览"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本输入结果",)
    OUTPUT_TOOLTIPS = ("最终输出的文本内容；连接外部文本时优先透传外部输入。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "文本内容",
                        "tooltip": "可直接在这里输入多行文本；未连接外部文本时会输出这里的内容。",
                    },
                ),
            },
            "optional": {
                "text_in": (
                    "STRING",
                    {
                        "forceInput": True,
                        "display_name": "外部文本",
                        "tooltip": "可选的文本输入；连接后会优先输出这里传入的文本内容。",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(cls, text, text_in=None):
        return "|".join(
            [
                normalize_text(text),
                normalize_text(text_in),
                str(text_in is not None),
            ]
        )

    def output_text(self, text: str, text_in: str | None = None):
        result = normalize_text(text_in) if text_in is not None else normalize_text(text)
        return (result,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TextInput}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📝 文本输入"}
