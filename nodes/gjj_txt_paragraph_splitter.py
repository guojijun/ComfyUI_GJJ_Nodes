from __future__ import annotations

import re
from typing import Any


NODE_NAME = "GJJ_TXTParagraphSplitter"
MAX_PARAGRAPH_INDEX = 1000
MAX_INPUT_PORTS = 64
SPLIT_MODES = ["端口", "空行", "---", "序号", "段落", "标题", "数字", "地址"]


class AnyType(str):
    """ComfyUI wildcard input type."""

    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    """Allow dynamic any_01, any_02 ... inputs without predeclaring all ports."""

    def __init__(self, input_type: Any, data: dict[str, Any] | None = None):
        super().__init__()
        self.input_type = input_type
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        return (self.input_type, {"display_name": str(key), "tooltip": "可选外部文本/任意对象输入，会按输入端口数量合并或作为端口分段。"})

    def __contains__(self, key):
        return True


any_type = AnyType("*")


def _input_key(index: int) -> str:
    return f"any_{index:02d}"


def _legacy_input_key(index: int) -> str:
    return f"any_{index}"


def _input_value(kwargs: dict[str, Any], index: int):
    if _input_key(index) in kwargs:
        return kwargs.get(_input_key(index))
    return kwargs.get(_legacy_input_key(index))


def _connected_input_indices(kwargs: dict[str, Any]) -> list[int]:
    indices: set[int] = set()
    for key in kwargs:
        match = re.fullmatch(r"any_0*(\d+)", str(key))
        if not match:
            continue
        index = int(match.group(1))
        if 1 <= index <= MAX_INPUT_PORTS:
            indices.add(index)
    return sorted(indices)


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "\n".join(_as_text(item) for item in value)
    return str(value)


def _split_by_numbered_items(text: str) -> list[str]:
    pattern = r"^(?:\d+[\.、]|[\(\（]\d+[\)\）]|[A-Za-z][\.、]|[一二三四五六七八九十百千万]+[、\.])"
    parts = re.split(f"({pattern})", text, flags=re.MULTILINE)
    if len(parts) <= 1:
        return [text]
    paragraphs: list[str] = []
    if parts[0].strip():
        paragraphs.append(parts[0])
    for index in range(1, len(parts), 2):
        paragraphs.append(parts[index] + (parts[index + 1] if index + 1 < len(parts) else ""))
    return paragraphs


def _split_by_titles(text: str) -> list[str]:
    cn_nums = "一二三四五六七八九十百千万"
    title_pattern = (
        rf"^(?:"
        rf"第[{cn_nums}\d]+[章节回部分单元].*|"
        rf"(?:\d+\.)+\d+.*|"
        rf"#+\s+.*|"
        rf".{{1,10}}[{cn_nums}\d]+(?:[\.、\s].*|(?:\s|$))"
        rf")"
    )
    parts = re.split(f"({title_pattern})", text, flags=re.MULTILINE)
    if len(parts) <= 1:
        return [text]
    paragraphs: list[str] = []
    if parts[0].strip():
        paragraphs.append(parts[0])
    for index in range(1, len(parts), 2):
        paragraphs.append(parts[index] + (parts[index + 1] if index + 1 < len(parts) else ""))
    return paragraphs


def _split_text(full_text: str, split_mode: str) -> list[str]:
    if split_mode == "空行":
        return re.split(r"\n\s*\n", full_text)
    if split_mode == "---":
        return re.split(r"(?:^|\n)\s*-{3,}\s*(?:\n|$)", full_text)
    if split_mode == "序号":
        return _split_by_numbered_items(full_text)
    if split_mode == "段落":
        return full_text.splitlines()
    if split_mode == "标题":
        return _split_by_titles(full_text)
    if split_mode == "数字":
        return re.findall(r"\d+", full_text)
    if split_mode == "地址":
        return re.findall(r"[a-zA-Z]:\\[^ \n\u4e00-\u9fa5]+", full_text)
    return [full_text]


def _select_paragraphs(paragraphs: list[str], selection_text: str) -> list[str]:
    text = str(selection_text or "").strip()
    if not text or text == "0":
        return paragraphs
    indices: list[int] = []
    for part in text.replace("，", ",").split(","):
        part = part.strip()
        if not part.isdigit():
            continue
        index = int(part) - 1
        if 0 <= index < len(paragraphs):
            indices.append(index)
    return [paragraphs[index] for index in indices] if indices else paragraphs


class GJJ_TXTParagraphSplitter:
    CATEGORY = "GJJ/文本"
    FUNCTION = "process_text"
    DESCRIPTION = "零依赖文本段落分割器：按空行、序号、标题、数字、地址或动态端口拆分文本，并输出段落数量与指定段落文本。"
    SEARCH_ALIASES = ["文本段落分割", "段落分割", "TXT splitter", "YUAN_TXTParagraphSplitter", "paragraph splitter"]
    RETURN_TYPES = ("INT", "STRING")
    RETURN_NAMES = ("段落数量", "指定段落")
    OUTPUT_TOOLTIPS = (
        "筛选后的段落数量。",
        "只输出“输出段落”参数指定的单个段落；0 或超出范围时输出空字符串。",
    )
    OUTPUT_IS_LIST = (False, False)
    GJJ_HELP = {
        "description": DESCRIPTION,
        "usage": [
            "分段方式为“端口”时，会把动态输入端口 any_01、any_02... 各自作为段落。",
            "其它分段方式会把主文本和动态端口文本合并后再分割。",
            "选取段落使用 1 基序号，例如 1,3,5；填 0 或留空表示保留全部。",
        ],
        "notes": ["该节点只使用 Python 标准库，无需安装 YUAN 原插件或额外 pip 依赖。"],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": "", "display_name": "文本", "tooltip": "输入需要分割段落的文本。"}),
                "split_mode": (SPLIT_MODES, {"default": "空行", "display_name": "分段方式", "tooltip": "端口：按动态输入端口分段；空行/序号/段落/标题/数字/地址：按对应规则分割。"}),
                "optimize_paragraphs": ("BOOLEAN", {"default": True, "label_on": "开启", "label_off": "关闭", "display_name": "段落优化", "tooltip": "开启时会去除首尾空白并丢弃空段落。"}),
                "output_paragraph": ("INT", {"default": 1, "min": 0, "max": MAX_PARAGRAPH_INDEX, "step": 1, "display_name": "输出段落", "tooltip": "指定第二输出口要输出的段落序号，按 1 开始；0 或超出范围时输出空字符串。"}),
            },
            "optional": FlexibleOptionalInputType(any_type, {_input_key(1): (any_type, {"display_name": "输入 1", "tooltip": "可选外部文本/任意对象输入。"})}),
        }

    def process_text(
        self,
        text: str,
        split_mode: str,
        optimize_paragraphs: bool,
        output_paragraph: int,
        list_output_mode: bool = False,
        input_port_count: int | None = None,
        select_paragraphs: str = "0",
        filter_paragraph: int = 0,
        **kwargs,
    ):
        specified_index = int(output_paragraph or 0) - 1
        paragraphs: list[str] = []
        full_text = str(text or "")

        for index in _connected_input_indices(kwargs):
            value = _input_value(kwargs, index)
            if value is None:
                continue
            if split_mode == "端口":
                if isinstance(value, (list, tuple)):
                    paragraphs.extend(_as_text(item) for item in value)
                else:
                    paragraphs.append(_as_text(value))
            else:
                if full_text and not full_text.endswith("\n"):
                    full_text += "\n"
                full_text += _as_text(value)

        if split_mode != "端口":
            paragraphs = _split_text(full_text, split_mode)

        if optimize_paragraphs:
            paragraphs = [paragraph.strip() for paragraph in paragraphs if paragraph and paragraph.strip()]
        else:
            paragraphs = [paragraph for paragraph in paragraphs if paragraph is not None]

        selected = _select_paragraphs(paragraphs, select_paragraphs)
        if int(filter_paragraph or 0) > 0:
            filter_index = int(filter_paragraph) - 1
            selected = [selected[filter_index]] if 0 <= filter_index < len(selected) else []

        specified_output = selected[specified_index] if 0 <= specified_index < len(selected) else ""
        return (len(selected), specified_output)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TXTParagraphSplitter}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📄 文本段落分割"}
