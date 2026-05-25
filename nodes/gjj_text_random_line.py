from __future__ import annotations

import json
from typing import Iterable

NODE_NAME = "GJJ_TextRandomLine"


def parse_text_blob(raw: str, strip_empty: bool = True) -> list[str]:
    if raw is None:
        return []

    text = str(raw).strip()
    if not text:
        return []

    items: Iterable[str]

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, list):
        items = [str(item) for item in parsed]
    elif isinstance(parsed, str):
        items = [parsed]
    else:
        items = [line.strip() for line in text.splitlines()]

    if strip_empty:
        return [item for item in items if item]
    return list(items)


class GJJ_TextRandomLine:
    CATEGORY = "GJJ"
    FUNCTION = "pick"
    DESCRIPTION = "从多行文本或 JSON 数组中按 1 基序号稳定选出一条，并输出合并后的正面提示词、总数和选中文本。"
    SEARCH_ALIASES = ["random line", "text random", "文本", "随机", "分行", "选择器"]
    RETURN_TYPES = ("STRING", "INT", "STRING")
    RETURN_NAMES = ("合并正面提示词结果", "文本总行数量", "随机文本")
    OUTPUT_TOOLTIPS = (
        "拼接固定前缀后得到的最终文本结果。",
        "参与随机选择的有效文本总行数。",
        "本次按序号选中的原始文本。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "fixed_prefix": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "固定前缀",
                        "tooltip": "会自动加在随机选中的文本前面，适合拼接通用提示词前缀。",
                    },
                ),
                "texts": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display_name": "文本列表",
                        "tooltip": "输入多行文本或 JSON 数组；每一行都会作为一个候选项参与选择。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "display_name": "序号值",
                        "tooltip": "按 1 基序号选择文本；1 选第 1 行，2 选第 2 行，与 GJJ 序列范围和多图编号保持一致。",
                    },
                ),
                "strip_empty": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "过滤空行",
                        "tooltip": "启用后会自动跳过空白行；关闭后空行也会参与顺序计算。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(cls, texts, fixed_prefix, seed, strip_empty):
        return "|".join(
            [
                str(texts),
                str(fixed_prefix),
                str(seed),
                str(strip_empty),
            ]
        )

    def pick(self, texts: str, fixed_prefix: str, seed: int, strip_empty: bool):
        items = parse_text_blob(texts, strip_empty=bool(strip_empty))
        current_value = max(1, int(seed))
        if not items:
            return {
                "ui": {
                    "gjj_text_random_line": [
                        {
                            "current_value": current_value,
                            "total_count": 0,
                            "status": "没有可选择的文本",
                        }
                    ]
                },
                "result": ("", 0, ""),
            }

        total = len(items)
        index = (current_value - 1) % total
        chosen = str(items[index]).strip()
        result = f"{fixed_prefix} {chosen}".strip()
        return {
            "ui": {
                "gjj_text_random_line": [
                    {
                        "current_value": current_value,
                        "total_count": total,
                        "status": f"当前第 {index + 1} 行 / 共 {total} 行",
                    }
                ]
            },
            "result": (result, total, chosen),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TextRandomLine}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎲 批量文本分行执行器"}
