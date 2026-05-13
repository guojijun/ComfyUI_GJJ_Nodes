from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any


NODE_NAME = "GJJ_CsvTsvRowIterator"
MAX_COLUMNS = 64
BROWSER_MARKER_PREFIX = "浏览器选择："
DEFAULT_STATE = {
    "auto_execute": True,
    "skip_header": True,
    "skip_empty_rows": True,
    "refresh_file": False,
    "browser_file_name": "",
    "browser_file_text": "",
}


def _is_url(source: str) -> bool:
    text = str(source or "").strip().lower()
    return text.startswith("http://") or text.startswith("https://")


def _read_url_text(url: str, timeout: int) -> tuple[str, str]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "GJJ-ComfyUI-CsvTsvRowIterator/1.0",
            "Accept": "text/csv,text/tab-separated-values,text/plain,*/*",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=max(1, int(timeout))) as response:
            data = response.read()
            content_type = response.headers.get("content-type", "")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"读取网络文件失败：{exc}") from exc

    encoding = "utf-8"
    for part in content_type.split(";"):
        part = part.strip()
        if part.lower().startswith("charset="):
            encoding = part.split("=", 1)[1].strip() or encoding
            break
    try:
        text = data.decode(encoding, errors="replace")
    except LookupError:
        text = data.decode("utf-8", errors="replace")
    return text, f"url:{url}:{len(data)}"


def _read_local_text(path_text: str) -> tuple[str, str]:
    path = os.path.abspath(os.path.expanduser(str(path_text or "").strip().strip('"')))
    if not os.path.isfile(path):
        raise FileNotFoundError(f"未找到 CSV/TSV 文件：{path}")

    stat = os.stat(path)
    with open(path, "rb") as file:
        data = file.read()
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            text = data.decode(encoding)
            return text, f"file:{path}:{stat.st_mtime_ns}:{stat.st_size}"
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace"), f"file:{path}:{stat.st_mtime_ns}:{stat.st_size}"


def _read_browser_text(file_name: str, text: str) -> tuple[str, str]:
    name = os.path.basename(str(file_name or "").strip()) or "浏览器选择文件"
    content = str(text or "")
    if not content.strip():
        raise ValueError("浏览器选择的 CSV/TSV 内容为空，请重新选择文件。")
    digest = hashlib.sha1(content.encode("utf-8", errors="replace")).hexdigest()[:12]
    return content, f"browser:{name}:{len(content)}:{digest}"


def _source_is_browser_marker(source: str) -> bool:
    return str(source or "").strip().startswith(BROWSER_MARKER_PREFIX)


def _detect_delimiter(text: str) -> tuple[str, str]:
    sample_lines = [line for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if line.strip()][:20]
    tab_count = sum(line.count("\t") for line in sample_lines)
    pipe_count = sum(line.count("||") for line in sample_lines)
    comma_count = sum(line.count(",") for line in sample_lines)
    if pipe_count > 0 and pipe_count >= tab_count and pipe_count >= comma_count:
        return "||", "双竖线"
    if tab_count >= comma_count:
        return "\t", "Tab"
    return ",", "逗号"


def _parse_rows(text: str, skip_empty_rows: bool) -> tuple[list[list[str]], str]:
    delimiter, delimiter_name = _detect_delimiter(text)
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    rows: list[list[str]] = []

    if delimiter == "||":
        for line in lines:
            cells = [str(cell).strip() for cell in line.split("||")]
            if skip_empty_rows and not any(cells):
                continue
            rows.append(cells)
    else:
        stream = io.StringIO(text.replace("\r\n", "\n").replace("\r", "\n"))
        reader = csv.reader(stream, delimiter=delimiter)
        for row in reader:
            cells = [str(cell).strip() for cell in row]
            if skip_empty_rows and not any(cells):
                continue
            rows.append(cells)
    return rows, delimiter_name


def _row_to_text(row: list[str]) -> str:
    return "\t".join(row)


def _as_bool(value: Any, fallback: bool) -> bool:
    if value is None:
        return fallback
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"false", "0", "off", "no", "关", "关闭", "否"}:
            return False
        if lowered in {"true", "1", "on", "yes", "开", "开启", "是"}:
            return True
    return bool(value)


def _parse_state(raw_value: Any) -> dict[str, Any]:
    state = dict(DEFAULT_STATE)
    try:
        parsed = json.loads(str(raw_value or "{}"))
    except json.JSONDecodeError:
        parsed = {}
    if isinstance(parsed, dict):
        state["auto_execute"] = _as_bool(parsed.get("auto_execute"), state["auto_execute"])
        state["skip_header"] = _as_bool(parsed.get("skip_header"), state["skip_header"])
        state["skip_empty_rows"] = _as_bool(parsed.get("skip_empty_rows"), state["skip_empty_rows"])
        state["refresh_file"] = _as_bool(parsed.get("refresh_file"), state["refresh_file"])
        state["browser_file_name"] = str(parsed.get("browser_file_name", "") or "")
        state["browser_file_text"] = str(parsed.get("browser_file_text", "") or "")
    return state


class GJJ_CsvTsvRowIterator:
    CATEGORY = "GJJ/Text"
    FUNCTION = "next_row"
    DESCRIPTION = "读取本地、网络或浏览器选择的 CSV/TSV 文本，按当前行数分列输出，并支持前端自动逐行执行。"
    SEARCH_ALIASES = ["csv", "tsv", "tab", "表格逐行", "分列文本", "逐行递进", "CSV分列", "TSV分列"]
    RETURN_TYPES = ("INT", "INT") + ("STRING",) * MAX_COLUMNS
    RETURN_NAMES = ("当前行数", "总行数") + tuple(f"列{i}" for i in range(1, MAX_COLUMNS + 1))
    OUTPUT_TOOLTIPS = (
        "当前实际输出的数据行号；开启首行标题时不包含标题行。",
        "当前 CSV/TSV 可输出的数据总行数；开启首行标题时不包含标题行。",
    ) + tuple(f"当前行第 {i} 列文本；如果该行没有这一列则为空。" for i in range(1, MAX_COLUMNS + 1))

    _cache: dict[str, dict[str, Any]] = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "current_row": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 999999,
                        "step": 1,
                        "display_name": "当前行数",
                        "tooltip": "1 基行号；前端自动执行会在每次完成后加 1，最大不超过当前 CSV/TSV 数据行数。",
                    },
                ),
            },
            "optional": {
                "text_input": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "外部文本输入",
                        "tooltip": "从上游节点接收的文本内容；如果有内容，优先使用此输入。",
                    },
                ),
                "source_path": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "CSV/TSV路径或URL",
                        "tooltip": "填写本地 CSV/TSV 文件路径，或 http/https 网络地址。浏览器选择文件时这里会显示文件名占位。",
                    },
                ),
                "timeout_seconds": ("INT", {"default": 30, "min": 1, "max": 600, "display_name": "超时秒数", "tooltip": "读取网络 CSV/TSV 时的超时时间；本地文件不受影响。"}),
                "csv_state": (
                    "STRING",
                    {
                        "default": json.dumps(DEFAULT_STATE, ensure_ascii=False),
                        "display_name": "CSV状态",
                        "tooltip": "前端面板维护的 JSON 状态；包含按钮开关与浏览器选择文件内容。",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **_kwargs):
        return time.time()

    def _load_rows(
        self,
        source_path: str,
        skip_header: bool,
        skip_empty_rows: bool,
        refresh_file: bool,
        timeout_seconds: int,
        browser_file_name: str = "",
        browser_file_text: str = "",
        text_input: str = "",
    ) -> tuple[str, list[list[str]], list[str], str, str]:
        browser_text = str(browser_file_text or "")
        text_input_content = str(text_input or "")
        source = str(source_path or "").strip()

        if text_input_content.strip():
            import hashlib
            digest = hashlib.sha1(text_input_content.encode("utf-8", errors="replace")).hexdigest()[:12]
            raw_text = text_input_content
            signature = f"text_input:{len(text_input_content)}:{digest}"
            source_key = signature
        elif browser_text.strip():
            raw_text, signature = _read_browser_text(browser_file_name, browser_text)
            source_key = signature
        elif source:
            if _source_is_browser_marker(source):
                raise ValueError("浏览器选择文件内容未保存，请重新点击按钮选择 CSV/TSV 文件。")
            raw_text, signature = _read_url_text(source, timeout_seconds) if _is_url(source) else _read_local_text(source)
            source_key = source
        else:
            raise ValueError("请填写 CSV/TSV 文件路径、网络 URL，或点击按钮从浏览器选择 CSV/TSV 文件，或连接外部文本输入。")

        delimiter, delimiter_name = _detect_delimiter(raw_text)
        key = f"{source_key}|delimiter={delimiter_name}|skip_header={bool(skip_header)}|skip_empty={bool(skip_empty_rows)}"
        cache = self._cache.get(key)
        if refresh_file or not cache or cache.get("signature") != signature:
            rows, delimiter_name = _parse_rows(raw_text, bool(skip_empty_rows))
            header_names = [str(cell).strip() for cell in rows[0]] if skip_header and rows else []
            if skip_header and rows:
                rows = rows[1:]
            self._cache[key] = {"signature": signature, "rows": rows, "header_names": header_names, "delimiter_name": delimiter_name}
        else:
            rows = cache["rows"]
            header_names = cache.get("header_names") or []
            delimiter_name = cache.get("delimiter_name") or delimiter_name
        return key, rows, header_names, signature, delimiter_name

    def next_row(
        self,
        current_row: int = 1,
        source_path: str = "",
        timeout_seconds: int = 30,
        csv_state: str = "",
        auto_execute: bool = True,
        skip_header: bool = True,
        skip_empty_rows: bool = True,
        refresh_file: bool = False,
        browser_file_name: str = "",
        browser_file_text: str = "",
        text_input: str = "",
    ):
        try:
            state = _parse_state(csv_state)
            auto_execute = state["auto_execute"]
            skip_header = state["skip_header"]
            skip_empty_rows = state["skip_empty_rows"]
            refresh_file = state["refresh_file"]
            browser_file_name = state["browser_file_name"] or browser_file_name
            browser_file_text = state["browser_file_text"] or browser_file_text
            key, rows, header_names, signature, delimiter_name = self._load_rows(
                source_path,
                skip_header,
                skip_empty_rows,
                refresh_file,
                timeout_seconds,
                browser_file_name,
                browser_file_text,
                text_input,
            )

            if not rows:
                raise ValueError("CSV/TSV 没有可输出的数据行。")

            requested_row = max(1, int(current_row or 1))
            effective_row = min(requested_row, len(rows))
            position = effective_row - 1
            row = rows[position]
            max_columns = min(MAX_COLUMNS, max([len(header_names), *[len(item) for item in rows]], default=0))
            next_row = min(effective_row + 1, len(rows))
            at_end = effective_row >= len(rows)

            columns = tuple(str(row[index]) if index < len(row) else "" for index in range(MAX_COLUMNS))
            overflow = f"\n注意：当前行共 {len(row)} 列，节点后端最多返回前 {MAX_COLUMNS} 列。" if len(row) > MAX_COLUMNS else ""
            status = (
                f"已读取 {len(rows)} 行；当前第 {effective_row} 行；下一次第 {next_row} 行；"
                f"当前行 {len(row)} 列；最大 {max_columns} 列；自动执行={'开' if auto_execute else '关'}；"
                f"分隔符={delimiter_name}；签名={signature}{overflow}"
            )
            return {
                "ui": {
                    "preview_text": (
                        f"{status}\n\n当前行：\n{_row_to_text(row)}",
                    ),
                    "gjj_csv_tsv_row_iterator": [
                        {
                            "current_row": int(requested_row),
                            "effective_row": int(effective_row),
                            "next_row": int(next_row),
                            "total_rows": int(len(rows)),
                            "column_count": int(max_columns),
                            "current_column_count": int(len(row)),
                            "column_names": header_names[:MAX_COLUMNS],
                            "auto_execute": bool(auto_execute),
                            "at_end": bool(at_end),
                            "status": status,
                        }
                    ],
                },
                "result": (int(effective_row), int(len(rows))) + columns,
            }
        except Exception as e:
            print(f"[GJJ CSV/TSV] 执行错误: {e}")
            columns = tuple("" for _ in range(MAX_COLUMNS))
            return {
                "ui": {
                    "preview_text": (f"执行错误: {e}",),
                    "gjj_csv_tsv_row_iterator": [
                        {
                            "current_row": int(current_row or 1),
                            "effective_row": 0,
                            "next_row": 1,
                            "total_rows": 0,
                            "column_count": 1,
                            "current_column_count": 0,
                            "column_names": [],
                            "auto_execute": bool(auto_execute),
                            "at_end": False,
                            "status": f"执行错误: {e}",
                        }
                    ],
                },
                "result": (0, 0) + columns,
            }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_CsvTsvRowIterator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧾 CSV/TSV逐行分列"}
