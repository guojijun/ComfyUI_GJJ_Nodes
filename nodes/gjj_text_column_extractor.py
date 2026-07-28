from __future__ import annotations


NODE_NAME = "GJJ_TextColumnExtractor"
MAX_COLUMN_INDEX = 128


def extract_column(
    text: str,
    column: int,
    delimiter: str = "||",
    skip_empty_lines: bool = True,
    trim_content: bool = True,
) -> list[str]:
    """Extract one 1-based column from every input line."""
    source = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    separator = str(delimiter or "||")

    selected_index = max(1, int(column or 1)) - 1
    results: list[str] = []
    for raw_line in source.split("\n"):
        if skip_empty_lines and not raw_line.strip():
            continue

        columns = raw_line.split(separator)
        if selected_index >= len(columns):
            continue

        value = columns[selected_index]
        if trim_content:
            value = value.strip()
        if skip_empty_lines and not value:
            continue
        results.append(value)
    return results


class GJJ_TextColumnExtractor:
    CATEGORY = "GJJ/文本"
    FUNCTION = "extract"
    DESCRIPTION = "按行拆分表格式文本，提取指定列，并将该列的所有内容逐条换行输出。"
    SEARCH_ALIASES = [
        "文本列提取",
        "按列输出",
        "分列",
        "双竖线",
        "column extractor",
        "text column",
    ]
    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("指定列文本", "有效行数")
    OUTPUT_TOOLTIPS = (
        "每条记录所选列的内容，按一条一行合并。",
        "成功提取到内容的行数。",
    )
    GJJ_HELP = {
        "description": DESCRIPTION,
        "usage": [
            "每条记录占一行，默认使用 || 分隔列。",
            "列号从 1 开始；例如“1||第一段||第二段”中，第 2 列是“第一段”。",
            "缺少所选列的行会自动跳过，输出内容始终按原行顺序排列。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "提示词",
                        "tooltip": "每条记录占一行，例如：1||第一段||第二段。",
                    },
                ),
                "column": (
                    "INT",
                    {
                        "default": 2,
                        "min": 1,
                        "max": MAX_COLUMN_INDEX,
                        "step": 1,
                        "display_name": "输出第几列",
                        "tooltip": "从 1 开始计数；选择 2 会输出每行第一个 || 后面的内容。",
                    },
                ),
                "delimiter": (
                    "STRING",
                    {
                        "default": "||",
                        "multiline": False,
                        "display_name": "列分隔符",
                        "tooltip": "用于切分每一行的文字，默认为双竖线 ||。",
                    },
                ),
                "skip_empty_lines": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "跳过空行/空内容",
                        "label_on": "开启",
                        "label_off": "关闭",
                    },
                ),
                "trim_content": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "去除首尾空白",
                        "label_on": "开启",
                        "label_off": "关闭",
                    },
                ),
                "line_delimiter": (
                    "STRING",
                    {
                        "default": "---",
                        "multiline": False,
                        "display_name": "行分隔符",
                        "tooltip": "插入到相邻输出内容之间并独占一行，默认为 ---。",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(cls, text, column, delimiter, skip_empty_lines, trim_content, line_delimiter="---"):
        return "|".join(
            [
                str(text),
                str(column),
                str(delimiter),
                str(skip_empty_lines),
                str(trim_content),
                str(line_delimiter),
            ]
        )

    def extract(
        self,
        text: str,
        column: int,
        delimiter: str,
        skip_empty_lines: bool,
        trim_content: bool,
        line_delimiter: str = "---",
    ):
        items = extract_column(
            text=text,
            column=column,
            delimiter=delimiter,
            skip_empty_lines=bool(skip_empty_lines),
            trim_content=bool(trim_content),
        )
        separator = str(line_delimiter if line_delimiter is not None else "---")
        output = f"\n{separator}\n".join(items) if separator else "\n".join(items)
        return {
            "ui": {
                "text": (output,),
                "count": (len(items),),
            },
            "result": (output, len(items)),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TextColumnExtractor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📋 文本指定列提取"}
