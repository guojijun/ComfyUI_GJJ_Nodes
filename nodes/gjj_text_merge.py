from __future__ import annotations

from typing import Any


MAX_TEXT_INPUTS = 32
TEXT_INPUT_PREFIX = "text_"
NODE_NAME = "GJJ_TextMerge"


def build_text_input_options(index: int) -> tuple[str, dict[str, Any]]:
    return (
        "STRING",
        {
            "default": "",
            "forceInput": True,
            "display_name": f"文本 {index}",
            "tooltip": f"第 {index} 路文本输入；未连接或内容为空时会自动跳过。",
        },
    )


def extract_input_index(name: str) -> int:
    raw_name = str(name or "")
    if not raw_name.startswith(TEXT_INPUT_PREFIX):
        return MAX_TEXT_INPUTS + 1

    try:
        return int(raw_name[len(TEXT_INPUT_PREFIX):])
    except ValueError:
        return MAX_TEXT_INPUTS + 1


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


class GJJ_TextMerge:
    CATEGORY = "GJJ"
    FUNCTION = "merge"
    OUTPUT_NODE = True
    DESCRIPTION = "把多路文本按顺序直接拼接，并在节点内提供预览，方便提示词和文案整合。"
    SEARCH_ALIASES = ["text merge", "text join", "文本", "合并", "拼接"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本合并结果",)
    OUTPUT_TOOLTIPS = ("已去除每段首尾空白并按顺序直接拼接后的文本结果。",)

    @classmethod
    def INPUT_TYPES(cls):
        optional_inputs = {
            f"{TEXT_INPUT_PREFIX}{index}": build_text_input_options(index)
            for index in range(1, MAX_TEXT_INPUTS + 1)
        }
        return {
            "required": {},
            "optional": optional_inputs,
        }

    def merge(self, **kwargs):
        texts = []
        for name in sorted(kwargs.keys(), key=extract_input_index):
            if not name.startswith(TEXT_INPUT_PREFIX):
                continue

            content = normalize_text(kwargs.get(name))
            if content:
                texts.append(content)

        merged_text = "".join(texts)
        return {
            "ui": {
                "text": (merged_text,),
            },
            "result": (merged_text,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TextMerge}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📝 文本合并预览"}
