from __future__ import annotations

import os
from pathlib import Path

try:
    import folder_paths
except Exception:
    folder_paths = None


def _base_dir(choice: str) -> str:
    if folder_paths is None:
        return os.getcwd()
    if choice == "输出目录":
        return folder_paths.get_output_directory()
    if choice == "临时目录":
        return folder_paths.get_temp_directory()
    return folder_paths.get_input_directory()


def _resolve_path(directory: str, relative_path: str, custom_path: str = "") -> str:
    if custom_path.strip():
        return os.path.abspath(os.path.expanduser(custom_path.strip()))
    rel = relative_path.strip().lstrip("/\\")
    return os.path.abspath(os.path.join(_base_dir(directory), rel))


def _split_content(content: str, mode: str, skip_empty: bool) -> list[str]:
    if mode == "整文件":
        values = [content]
    elif mode == "按逗号":
        values = [part.strip() for part in content.split(",")]
    else:
        values = [line.strip() for line in content.splitlines()]
    if skip_empty:
        values = [value for value in values if value != ""]
    return values


class GJJ_TextFileReader:
    CATEGORY = "GJJ/Text"
    FUNCTION = "read"
    DESCRIPTION = "从 input/output/temp 或自定义路径读取文本，支持整文件、按行和按逗号输出。"
    SEARCH_ALIASES = ["read text", "load text", "文本读取", "提示词文件"]
    RETURN_TYPES = ("STRING", "STRING", "INT")
    RETURN_NAMES = ("文本输出", "文件路径", "条目数量")
    OUTPUT_TOOLTIPS = ("读取到的文本；可按整文件或单条输出。", "实际读取的绝对路径。", "分割后的条目数量。")
    OUTPUT_IS_LIST = (True, False, False)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "directory": (["输入目录", "输出目录", "临时目录", "自定义路径"], {"default": "输入目录", "display_name": "读取位置", "tooltip": "选择读取文件所在的基础目录；自定义路径会使用下方完整路径。"}),
                "relative_path": ("STRING", {"default": "prompts.txt", "display_name": "相对路径", "tooltip": "相对于所选目录的文本文件路径。"}),
                "custom_path": ("STRING", {"default": "", "display_name": "自定义完整路径", "tooltip": "读取位置为自定义路径时使用；也可直接填绝对路径覆盖相对路径。"}),
                "encoding": ("STRING", {"default": "utf-8", "display_name": "文本编码", "tooltip": "读取文件时使用的编码，通常为 utf-8。"}),
                "split_mode": (["整文件", "按行", "按逗号"], {"default": "按行", "display_name": "分割方式", "tooltip": "控制输出列表如何切分文本。"}),
                "index": ("INT", {"default": 0, "min": -100000, "max": 100000, "display_name": "输出序号", "tooltip": "0 表示输出全部条目；正数按 1 基序号取单条；负数可从末尾取。"}),
                "wrap": ("BOOLEAN", {"default": True, "display_name": "序号循环", "tooltip": "开启后序号超出范围时按条目数量循环。"}),
                "skip_empty": ("BOOLEAN", {"default": True, "display_name": "跳过空条目", "tooltip": "开启后会忽略空行或空白片段。"}),
            }
        }

    def read(self, directory, relative_path, custom_path, encoding, split_mode, index, wrap, skip_empty):
        path = _resolve_path(directory, relative_path, custom_path if directory == "自定义路径" or custom_path.strip() else "")
        if not os.path.isfile(path):
            raise FileNotFoundError(f"未找到文本文件：{path}")
        with open(path, "r", encoding=encoding) as file:
            content = file.read()
        values = _split_content(content, split_mode, bool(skip_empty))
        if int(index) == 0:
            output = values
        else:
            if not values:
                output = [""]
            else:
                idx = int(index)
                raw = idx - 1 if idx > 0 else idx
                if wrap:
                    raw = raw % len(values)
                if raw < -len(values) or raw >= len(values):
                    raise ValueError("输出序号超出文本条目范围。")
                output = [values[raw]]
        return (output, path, len(values))


class GJJ_TextFileWriter:
    CATEGORY = "GJJ/Text"
    FUNCTION = "write"
    DESCRIPTION = "把文本写入 input/output/temp 或自定义路径，支持覆盖、追加、前插和逗号拼接。"
    SEARCH_ALIASES = ["write text", "save text", "文本保存", "提示词保存"]
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("保存路径",)
    OUTPUT_TOOLTIPS = ("实际保存的绝对路径。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "content": ("STRING", {"default": "", "multiline": True, "display_name": "文本内容", "tooltip": "需要写入文件的文本内容。"}),
                "directory": (["输入目录", "输出目录", "临时目录", "自定义路径"], {"default": "输出目录", "display_name": "保存位置", "tooltip": "选择保存文件所在的基础目录；自定义路径会使用下方完整路径。"}),
                "relative_path": ("STRING", {"default": "GJJ/text_output.txt", "display_name": "相对路径", "tooltip": "相对于所选目录的保存路径，支持子目录。"}),
                "custom_path": ("STRING", {"default": "", "display_name": "自定义完整路径", "tooltip": "保存位置为自定义路径时使用；也可直接填绝对路径覆盖相对路径。"}),
                "encoding": ("STRING", {"default": "utf-8", "display_name": "文本编码", "tooltip": "写入文件时使用的编码。"}),
                "mode": (["覆盖文件", "追加新行", "前插新行", "追加逗号", "前插逗号"], {"default": "覆盖文件", "display_name": "写入方式", "tooltip": "选择新内容和旧文件内容的合并方式。"}),
            }
        }

    def write(self, content, directory, relative_path, custom_path, encoding, mode):
        path = _resolve_path(directory, relative_path, custom_path if directory == "自定义路径" or custom_path.strip() else "")
        Path(os.path.dirname(path)).mkdir(parents=True, exist_ok=True)
        old = ""
        if os.path.exists(path):
            with open(path, "r", encoding=encoding, errors="ignore") as file:
                old = file.read()
        if mode == "追加新行":
            new = f"{old}\n{content}" if old else str(content)
        elif mode == "前插新行":
            new = f"{content}\n{old}" if old else str(content)
        elif mode == "追加逗号":
            new = f"{old}, {content}" if old else str(content)
        elif mode == "前插逗号":
            new = f"{content}, {old}" if old else str(content)
        else:
            new = str(content)
        with open(path, "w", encoding=encoding) as file:
            file.write(new)
        return (path,)


NODE_CLASS_MAPPINGS = {
    "GJJ_TextFileReader": GJJ_TextFileReader,
    "GJJ_TextFileWriter": GJJ_TextFileWriter,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_TextFileReader": "GJJ · 📖 文本文件读取",
    "GJJ_TextFileWriter": "GJJ · 💾 文本文件保存",
}
