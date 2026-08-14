from __future__ import annotations

import re
from typing import Any


NODE_NAME = "GJJ_RegexExtractor"
MAX_PATTERNS = 16  # 最大正则条数，每条对应一个输出端口


class AnyType(str):
    """始终可兼容任意类型的占位类型。"""

    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


DESCRIPTION_TEXT = (
    "用多条正则表达式从输入文本中分别提取匹配内容。"
    "每条正则对应一个输出端口，输出该正则的所有完整匹配列表。"
    "支持动态增减正则条数，输出端口自动跟随。"
)

GJJ_HELP = {
    "description": DESCRIPTION_TEXT,
    "usage": [
        "在「输入文本」中填写或连接源文本。",
        "点击「+ 添加正则」按钮增加正则条数，每条正则对应一个输出端口。",
        "底部 emoji 按钮控制正则标志（DOTALL / MULTILINE / IGNORECASE / VERBOSE / ASCII），点击切换开关。",
        "每条正则输出该正则的所有完整匹配列表，可直接接到需要列表输入的下游节点。",
    ],
    "inputs": {
        "输入文本": {
            "type": "STRING",
            "description": "要提取的源文本；可连接上游 STRING 输出，也可直接粘贴。",
        },
    },
    "flags": {
        "🎯 DOTALL": "让 . 也匹配换行符。",
        "📄 MULTILINE": "^ 和 $ 在每行边界都生效。",
        "🔤 IGNORECASE": "忽略大小写。",
        "💬 VERBOSE": "允许正则中写空白和 # 注释，便于多行排版。",
        "🔢 ASCII": "让 \\w \\b 等只匹配 ASCII 字符。",
    },
}


def _get_node_properties(extra_pnginfo: Any, unique_id: Any) -> dict[str, Any]:
    """从 workflow JSON 中读取当前节点的 properties。"""
    try:
        workflow = (extra_pnginfo or {}).get("workflow") or {}
        for node in workflow.get("nodes") or []:
            if str(node.get("id")) == str(unique_id):
                return node.get("properties") or {}
    except Exception:
        pass
    return {}


def _build_flags(props: dict[str, Any], patterns: list[str] | None = None) -> int:
    """根据 node.properties 中的标志位构建 re flags。

    如果正则中出现 ^ 或 $ 且未显式开启 MULTILINE，自动补上。
    """
    flags = 0
    if props.get("flag_dotall"):
        flags |= re.DOTALL
    if props.get("flag_multiline"):
        flags |= re.MULTILINE
    if props.get("flag_ignorecase"):
        flags |= re.IGNORECASE
    if props.get("flag_verbose"):
        flags |= re.VERBOSE
    if props.get("flag_ascii"):
        flags |= re.ASCII

    # 自动检测：正则含 ^ 或 $ 时自动启用 MULTILINE（除非用户显式关闭）
    if patterns and not (flags & re.MULTILINE):
        if not props.get("flag_multiline_manually_off"):
            for p in patterns:
                if "^" in p or "$" in p:
                    flags |= re.MULTILINE
                    break

    return flags


def _extract_matches(text: str, pattern: str, flags: int) -> list[str]:
    """对单条正则执行 finditer，返回所有完整匹配的列表。"""
    if not pattern.strip():
        return []
    try:
        compiled = re.compile(pattern, flags)
    except re.error as exc:
        raise RuntimeError(f"正则表达式错误：{exc}") from exc
    return [match.group(0) or "" for match in compiled.finditer(text)]


class GJJ_RegexExtractor:
    CATEGORY = "GJJ/📝 文本"
    FUNCTION = "extract"
    DESCRIPTION = DESCRIPTION_TEXT
    SEARCH_ALIASES = [
        "正则",
        "regex",
        "extract",
        "提取",
        "匹配",
        "regular expression",
        "capture",
    ]

    # 后端保留 MAX_PATTERNS 个返回位；前端按实际正则条数动态增删可见输出端口。
    RETURN_TYPES = (any_type,) * MAX_PATTERNS
    RETURN_NAMES = tuple(f"输出{i}" for i in range(1, MAX_PATTERNS + 1))
    OUTPUT_IS_LIST = (True,) * MAX_PATTERNS

    GJJ_HELP = GJJ_HELP

    @classmethod
    def INPUT_TYPES(cls):
        inputs: dict[str, Any] = {
            "text": (
                "STRING",
                {
                    "default": "",
                    "multiline": True,
                    "display_name": "输入文本",
                    "tooltip": "要提取的源文本；可连接上游 STRING 输出，也可直接粘贴。",
                },
            ),
        }
        # pattern_1 ~ pattern_MAX_PATTERNS：隐藏 STRING，由前端 DOM 动态填充。
        for i in range(1, MAX_PATTERNS + 1):
            inputs[f"pattern_{i}"] = (
                "STRING",
                {
                    "default": "",
                    "multiline": True,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": f"正则{i}",
                    "tooltip": f"第{i}条正则表达式，由前端动态填充。",
                },
            )
        # flags_state：前端写入标志哈希，用于触发 IS_CHANGED 缓存刷新。
        inputs["flags_state"] = (
            "STRING",
            {
                "default": "",
                "display": "hidden",
                "hidden": True,
                "display_name": "标志状态",
                "tooltip": "前端写入，用于触发缓存刷新。",
            },
        )
        return {
            "required": inputs,
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def IS_CHANGED(cls, unique_id: Any = None, extra_pnginfo: Any = None, **kwargs):
        parts = [str(kwargs.get("text", "")), str(kwargs.get("flags_state", ""))]
        # 优先从 node.properties.patterns 读取（前端持久化的可靠来源）
        props = _get_node_properties(extra_pnginfo, unique_id)
        stored = props.get("patterns")
        if isinstance(stored, list):
            parts.append("patterns:" + "|".join(str(p) for p in stored))
        else:
            # fallback：从隐藏 widget 参数读取
            for i in range(1, MAX_PATTERNS + 1):
                parts.append(str(kwargs.get(f"pattern_{i}", "")))
        return "|".join(parts)

    def extract(
        self,
        text: str = "",
        unique_id: Any = None,
        extra_pnginfo: Any = None,
        **kwargs,
    ):
        source = str(text or "")
        props = _get_node_properties(extra_pnginfo, unique_id)

        # 优先从 node.properties.patterns 读取（前端持久化的可靠来源）
        stored_patterns = props.get("patterns")
        if isinstance(stored_patterns, list) and stored_patterns:
            all_patterns = [
                str(p or "")
                for p in stored_patterns[:MAX_PATTERNS]
                if str(p or "").strip()
            ]
        else:
            # fallback：从隐藏 widget 参数读取（兼容旧工作流）
            all_patterns = []
            for i in range(1, MAX_PATTERNS + 1):
                p = str(kwargs.get(f"pattern_{i}", "") or "")
                if p.strip():
                    all_patterns.append(p)

        flags = _build_flags(props, all_patterns)

        results: list[list[str]] = []
        match_counts: list[int] = []
        errors: list[str] = []
        active_count = 0

        for pattern in all_patterns:
            active_count += 1
            try:
                matches = _extract_matches(source, pattern, flags)
                results.append(matches)
                match_counts.append(len(matches))
            except RuntimeError as exc:
                errors.append(f"正则{active_count}：{exc}")
                results.append([])
                match_counts.append(0)

        # 补齐到 MAX_PATTERNS 长度
        while len(results) < MAX_PATTERNS:
            results.append([])

        return {
            "ui": {
                "pattern_count": [active_count],
                "match_counts": [match_counts],
                "errors": errors,
            },
            "result": tuple(results[:MAX_PATTERNS]),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_RegexExtractor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🔍 正则提取"}
