from __future__ import annotations

import hashlib
import json
import os
from typing import Any


NODE_NAME = "GJJ_JsonDynamicParser"
MAX_OUTPUTS = 64


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _is_empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _read_text_file(path_text: str, encoding: str) -> str:
    path = os.path.abspath(os.path.expanduser(str(path_text or "").strip().strip('"')))
    if not os.path.isfile(path):
        raise FileNotFoundError(f"未找到 JSON 文件：{path}")
    with open(path, "r", encoding=encoding or "utf-8", errors="replace") as file:
        return file.read()


def _parse_json_source(value: Any, source_name: str) -> Any:
    if isinstance(value, (dict, list, int, float, bool)) or value is None:
        return value
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{source_name}不是有效 JSON：第 {exc.lineno} 行第 {exc.colno} 列，{exc.msg}") from exc


def _flatten_top_level(data: Any) -> list[tuple[str, Any]]:
    if isinstance(data, dict):
        return [(str(key), value) for key, value in data.items()]
    if isinstance(data, list):
        return [(f"项目{i}", value) for i, value in enumerate(data, start=1)]
    return [("值", data)]


def _value_type(value: Any) -> str:
    if value is None:
        return "*"
    if isinstance(value, bool):
        return "BOOLEAN"
    if isinstance(value, int) and not isinstance(value, bool):
        return "INT"
    if isinstance(value, float):
        return "FLOAT"
    if isinstance(value, str):
        return "STRING"
    if isinstance(value, (dict, list)):
        return "JSON"
    return "*"


def _schema_items(data: Any) -> list[dict[str, str]]:
    return [
        {"name": name, "type": _value_type(value)}
        for name, value in _flatten_top_level(data)[:MAX_OUTPUTS]
    ]


def _json_text(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


def _source_signature(panel_json: Any, json_file_path: str, encoding: str) -> str:
    if str(panel_json or "").strip():
        text = panel_json if isinstance(panel_json, str) else _json_text(panel_json)
        digest = hashlib.sha1(str(text).encode("utf-8", errors="replace")).hexdigest()
        return f"panel:{digest}"
    path = os.path.abspath(os.path.expanduser(str(json_file_path or "").strip().strip('"')))
    if path and os.path.isfile(path):
        stat = os.stat(path)
        return f"file:{path}:{stat.st_mtime_ns}:{stat.st_size}:{encoding}"
    return "empty"


class GJJ_JsonDynamicParser:
    CATEGORY = "GJJ/Text"
    FUNCTION = "parse"
    DESCRIPTION = "从外部输入、面板粘贴文本、浏览器打开文件文本或本地文件路径读取 JSON，并按顶层键/项目动态显示输出口。"
    SEARCH_ALIASES = ["json", "动态JSON", "JSON解析", "JSON输出", "键值解析", "json parser"]
    RETURN_TYPES = (any_type,) * MAX_OUTPUTS
    RETURN_NAMES = tuple(f"输出{i}" for i in range(1, MAX_OUTPUTS + 1))
    OUTPUT_TOOLTIPS = tuple("根据 JSON 顶层键或数组项目动态生成的输出。复杂对象会保持为 Python dict/list 传递。" for _ in range(MAX_OUTPUTS))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "panel_json": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display_name": "JSON文本",
                        "tooltip": "可直接粘贴 JSON，也可连接上游 JSON/STRING。连接上游时优先使用上游数据，点击“解析上游”后刷新输出口。",
                    },
                ),
                "json_file_path": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "JSON文件路径",
                        "tooltip": "没有外接输入、且 JSON 文本为空时读取这个本地 JSON 文件路径。",
                    },
                ),
                "encoding": (
                    "STRING",
                    {
                        "default": "utf-8",
                        "display_name": "文件编码",
                        "tooltip": "读取 JSON 文件路径时使用的文本编码，通常为 utf-8。",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(cls, panel_json: Any = "", json_file_path: str = "", encoding: str = "utf-8", **_kwargs):
        return _source_signature(panel_json, json_file_path, encoding)

    def parse(self, panel_json: Any = "", json_file_path: str = "", encoding: str = "utf-8", json_input: Any = None, **_kwargs):
        # json_input 只为旧工作流兼容保留；新节点不再声明这个重复接口。
        source_value = json_input if not _is_empty(json_input) else panel_json
        if not _is_empty(source_value):
            data = _parse_json_source(source_value, "JSON 文本")
        elif str(json_file_path or "").strip():
            data = _parse_json_source(_read_text_file(json_file_path, encoding), "JSON 文件")
        else:
            data = {}

        items = _flatten_top_level(data)[:MAX_OUTPUTS]
        values = [value for _name, value in items]
        values.extend([None] * (MAX_OUTPUTS - len(values)))
        return {
            "ui": {
                "json_schema": [_schema_items(data)],
            },
            "result": tuple(values[:MAX_OUTPUTS]),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_JsonDynamicParser}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧬 JSON动态解析"}


def _register_json_dynamic_parser_api():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(server, "_gjj_json_dynamic_parser_api_registered", False):
        return

    @server.routes.get("/gjj/json_dynamic_parser/inspect")
    async def inspect_json_file(request):
        path = str(request.query.get("path", "") or "")
        encoding = str(request.query.get("encoding", "utf-8") or "utf-8")
        try:
            data = _parse_json_source(_read_text_file(path, encoding), "JSON 文件")
            return web.json_response({"ok": True, "items": _schema_items(data)}, dumps=lambda value: json.dumps(value, ensure_ascii=False))
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc), "items": []}, dumps=lambda value: json.dumps(value, ensure_ascii=False))

    server._gjj_json_dynamic_parser_api_registered = True


_register_json_dynamic_parser_api()
