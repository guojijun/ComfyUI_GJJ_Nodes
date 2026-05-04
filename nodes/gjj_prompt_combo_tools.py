from __future__ import annotations

import itertools
import random
from typing import Any

try:
    import folder_paths
except Exception:
    folder_paths = None


def _split_items(text: Any, mode: str, skip_empty: bool = True) -> list[str]:
    raw = "" if text is None else str(text)
    if mode == "按逗号":
        items = [part.strip() for part in raw.split(",")]
    elif mode == "按竖线":
        items = [part.strip() for part in raw.split("|")]
    else:
        items = [part.strip() for part in raw.splitlines()]
    if skip_empty:
        items = [item for item in items if item]
    return items


def _join_parts(parts: list[str], delimiter: str) -> str:
    if delimiter == "换行":
        sep = "\n"
    elif delimiter == "空格":
        sep = " "
    elif delimiter == "竖线":
        sep = " | "
    elif delimiter == "无分隔":
        sep = ""
    else:
        sep = ", "
    return sep.join([part for part in parts if str(part).strip()])


def _embedding_names() -> list[str]:
    if folder_paths is None:
        return ["手动输入"]
    try:
        names = folder_paths.get_filename_list("embeddings")
    except Exception:
        names = []
    return ["手动输入"] + sorted(names, key=str.lower)


class GJJ_PromptCombination:
    CATEGORY = "GJJ/Prompt"
    FUNCTION = "combine"
    DESCRIPTION = "把基础提示词、主体列表和风格列表做排列组合或随机抽样，输出提示词列表。"
    SEARCH_ALIASES = ["prompt combine", "prompt matrix", "提示词组合", "排列组合", "随机提示词"]
    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("提示词列表", "提示词数量")
    OUTPUT_TOOLTIPS = ("组合后的提示词列表，可直接进入批量文本流程。", "实际输出的提示词数量。")
    OUTPUT_IS_LIST = (True, False)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_prompt": ("STRING", {"default": "", "multiline": True, "display_name": "基础提示词", "tooltip": "每条组合都会包含的基础提示词。"}),
                "subjects": ("STRING", {"default": "", "multiline": True, "display_name": "主体列表", "tooltip": "主体候选列表，可按行、逗号或竖线分隔。"}),
                "styles": ("STRING", {"default": "", "multiline": True, "display_name": "风格列表", "tooltip": "风格候选列表，可按行、逗号或竖线分隔。"}),
                "split_mode": (["按行", "按逗号", "按竖线"], {"default": "按行", "display_name": "列表分隔", "tooltip": "主体和风格列表的分隔方式。"}),
                "combine_mode": (["全部组合", "按序配对", "随机抽样"], {"default": "全部组合", "display_name": "组合方式", "tooltip": "全部组合会输出主体 x 风格；按序配对按位置匹配；随机抽样从全部组合里抽取。"}),
                "delimiter": (["逗号", "空格", "换行", "竖线", "无分隔"], {"default": "逗号", "display_name": "片段分隔", "tooltip": "基础、主体、风格之间的拼接分隔符。"}),
                "max_count": ("INT", {"default": 64, "min": 1, "max": 10000, "step": 1, "display_name": "最大数量", "tooltip": "限制输出提示词数量。"}),
                "seed": ("INT", {"default": 1, "min": 0, "max": 0xffffffffffffffff, "display_name": "随机种子", "tooltip": "随机抽样模式使用的种子。"}),
            }
        }

    def combine(self, base_prompt, subjects, styles, split_mode, combine_mode, delimiter, max_count, seed):
        base = str(base_prompt or "").strip()
        subject_items = _split_items(subjects, split_mode)
        style_items = _split_items(styles, split_mode)
        if not subject_items:
            subject_items = [""]
        if not style_items:
            style_items = [""]

        if combine_mode == "按序配对":
            pairs = list(itertools.zip_longest(subject_items, style_items, fillvalue=""))
        else:
            pairs = list(itertools.product(subject_items, style_items))
            if combine_mode == "随机抽样":
                rng = random.Random(int(seed))
                rng.shuffle(pairs)

        results = []
        for subject, style in pairs[: int(max_count)]:
            prompt = _join_parts([base, str(subject).strip(), str(style).strip()], delimiter).strip()
            if prompt:
                results.append(prompt)
        return (results, len(results))


class GJJ_PromptWeight:
    CATEGORY = "GJJ/Prompt"
    FUNCTION = "weight"
    DESCRIPTION = "给提示词片段添加常见权重语法，支持单条或多行批量输出。"
    SEARCH_ALIASES = ["prompt weight", "提示词权重", "权重包装", "括号权重"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("加权提示词",)
    OUTPUT_TOOLTIPS = ("按权重格式包装后的提示词文本。",)
    OUTPUT_IS_LIST = (True,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True, "display_name": "提示词片段", "tooltip": "需要添加权重的提示词；多行会逐行处理。"}),
                "weight": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01, "display": "slider", "display_name": "权重", "tooltip": "提示词权重数值。"}),
                "format": (["圆括号权重", "方括号弱化", "仅数值后缀"], {"default": "圆括号权重", "display_name": "权重格式", "tooltip": "选择输出的提示词权重语法。"}),
                "split_lines": ("BOOLEAN", {"default": True, "display_name": "逐行输出", "tooltip": "开启后每行分别包装并作为列表输出；关闭后整体包装。"}),
            }
        }

    def weight(self, text, weight, format, split_lines):
        items = _split_items(text, "按行") if split_lines else [str(text or "").strip()]
        results = []
        value = round(float(weight), 4)
        for item in items:
            if not item:
                continue
            if format == "方括号弱化":
                results.append(f"[{item}:{value}]")
            elif format == "仅数值后缀":
                results.append(f"{item}:{value}")
            else:
                results.append(f"({item}:{value})")
        return (results,)


class GJJ_EmbeddingPrompt:
    CATEGORY = "GJJ/Prompt"
    FUNCTION = "make"
    DESCRIPTION = "生成 embedding 提示词片段，并可附加权重。"
    SEARCH_ALIASES = ["embedding prompt", "embedding", "嵌入提示词", "负面embedding"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("Embedding提示词",)
    OUTPUT_TOOLTIPS = ("形如 embedding:name 或加权后的 embedding 提示词片段。",)

    @classmethod
    def INPUT_TYPES(cls):
        names = _embedding_names()
        return {
            "required": {
                "embedding": (names, {"default": names[0], "display_name": "Embedding", "tooltip": "从 embeddings 目录选择一个 embedding；选择手动输入时使用下方名称。"}),
                "manual_name": ("STRING", {"default": "", "display_name": "手动名称", "tooltip": "当列表选择手动输入时使用的 embedding 文件名或名称。"}),
                "weight": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01, "display": "slider", "display_name": "权重", "tooltip": "Embedding 权重；1.0 时不额外包裹权重。"}),
            }
        }

    def make(self, embedding, manual_name, weight):
        name = str(manual_name or "").strip() if embedding == "手动输入" else str(embedding).strip()
        if not name:
            return ("",)
        prompt = f"embedding:{name}"
        value = round(float(weight), 4)
        if abs(value - 1.0) > 1e-6:
            prompt = f"({prompt}:{value})"
        return (prompt,)


class GJJ_TextJoinWithDelimiter:
    CATEGORY = "GJJ/Prompt"
    FUNCTION = "join"
    DESCRIPTION = "把文本列表或多路文本按指定分隔符合并，适合把批量提示词片段汇总成一段。"
    SEARCH_ALIASES = ["join delimiter", "文本分隔合并", "提示词拼接", "分隔符"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("合并文本",)
    OUTPUT_TOOLTIPS = ("按指定分隔符合并后的文本。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "delimiter": (["逗号", "空格", "换行", "竖线", "无分隔"], {"default": "逗号", "display_name": "分隔符", "tooltip": "控制文本片段之间如何连接。"}),
                "skip_empty": ("BOOLEAN", {"default": True, "display_name": "跳过空文本", "tooltip": "开启后忽略空白片段。"}),
            },
            "optional": {
                "text_1": ("STRING", {"forceInput": True, "display_name": "文本 1", "tooltip": "第一路文本或文本列表。"}),
                "text_2": ("STRING", {"forceInput": True, "display_name": "文本 2", "tooltip": "第二路文本或文本列表。"}),
                "text_3": ("STRING", {"forceInput": True, "display_name": "文本 3", "tooltip": "第三路文本或文本列表。"}),
                "text_4": ("STRING", {"forceInput": True, "display_name": "文本 4", "tooltip": "第四路文本或文本列表。"}),
                "text_5": ("STRING", {"forceInput": True, "display_name": "文本 5", "tooltip": "第五路文本或文本列表。"}),
                "text_6": ("STRING", {"forceInput": True, "display_name": "文本 6", "tooltip": "第六路文本或文本列表。"}),
            },
        }

    def join(self, delimiter, skip_empty, **kwargs):
        parts = []
        for i in range(1, 7):
            value = kwargs.get(f"text_{i}")
            if value is None:
                continue
            if isinstance(value, list):
                parts.extend([str(item).strip() for item in value])
            else:
                parts.append(str(value).strip())
        if skip_empty:
            parts = [part for part in parts if part]
        return (_join_parts(parts, delimiter),)


NODE_CLASS_MAPPINGS = {
    "GJJ_PromptCombination": GJJ_PromptCombination,
    "GJJ_PromptWeight": GJJ_PromptWeight,
    "GJJ_EmbeddingPrompt": GJJ_EmbeddingPrompt,
    "GJJ_TextJoinWithDelimiter": GJJ_TextJoinWithDelimiter,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_PromptCombination": "GJJ · 🧩 提示词组合",
    "GJJ_PromptWeight": "GJJ · ⚖️ 提示词权重",
    "GJJ_EmbeddingPrompt": "GJJ · 🧬 Embedding提示词",
    "GJJ_TextJoinWithDelimiter": "GJJ · 🔗 文本分隔合并",
}
