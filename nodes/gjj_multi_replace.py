from __future__ import annotations

import json
import re
from typing import Any


NODE_NAME = "GJJ_MultiReplace"
MAX_REPLACE_PAIRS = 20
SEARCH_PREFIX = "search_"
REPLACE_PREFIX = "replace_"


class AnyType(str):
    """始终可兼容任意类型的占位类型。"""

    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _pair_name(prefix: str, index: int) -> str:
    return f"{prefix}{index:02d}"


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _build_pair_inputs() -> dict[str, tuple[str, dict[str, Any]]]:
    inputs: dict[str, tuple[str, dict[str, Any]]] = {
        "options_json": (
            "STRING",
            {
                "default": "{}",
                "multiline": False,
                "display": "hidden",
                "hidden": True,
                "display_name": "按钮选项存储",
                "tooltip": "前端按钮维护的内部状态，保存大小写模糊、正则表达、全部替换设置。",
            },
        )
    }
    for index in range(1, MAX_REPLACE_PAIRS + 1):
        inputs[_pair_name(SEARCH_PREFIX, index)] = (
            "STRING",
            {
                "default": "",
                "multiline": False,
                "display_name": f"查找 {index}",
                "tooltip": f"第 {index} 组要查找的文本或正则表达式；留空会跳过这一组。",
            },
        )
        inputs[_pair_name(REPLACE_PREFIX, index)] = (
            "STRING",
            {
                "default": "",
                "multiline": False,
                "display_name": f"替换 {index}",
                "tooltip": f"第 {index} 组替换成的内容；可以留空表示删除匹配内容。",
            },
        )
    return inputs


def _collect_rules(kwargs: dict[str, Any]) -> list[tuple[str, str, int]]:
    rules: list[tuple[str, str, int]] = []
    for index in range(1, MAX_REPLACE_PAIRS + 1):
        search = _text(kwargs.get(_pair_name(SEARCH_PREFIX, index)))
        replace = _text(kwargs.get(_pair_name(REPLACE_PREFIX, index)))
        if search == "":
            continue
        rules.append((search, replace, index))
    return rules


def _parse_options(raw: Any, kwargs: dict[str, Any]) -> dict[str, bool]:
    options = {
        "case_insensitive": False,
        "regex_mode": False,
        "replace_all": True,
    }
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                for key in options:
                    if key in parsed:
                        options[key] = bool(parsed[key])
        except json.JSONDecodeError:
            pass

    # 兼容旧版工作流里可能残留的 3 个布尔 widget 输入。
    for key in options:
        if key in kwargs:
            options[key] = bool(kwargs.get(key))
    return options


def _replace_literal_once(text: str, search: str, replace: str) -> tuple[str, int]:
    position = text.find(search)
    if position < 0:
        return text, 0
    end = position + len(search)
    return f"{text[:position]}{replace}{text[end:]}", 1


def _replace_text(
    text: str,
    rules: list[tuple[str, str, int]],
    *,
    case_insensitive: bool,
    regex_mode: bool,
    replace_all: bool,
) -> tuple[str, int]:
    total = 0
    result = text
    count = 0 if replace_all else 1
    flags = re.IGNORECASE if case_insensitive else 0

    for search, replace, index in rules:
        if regex_mode:
            try:
                result, changed = re.subn(search, replace, result, count=count, flags=flags)
            except re.error as error:
                raise RuntimeError(f"第 {index} 组正则表达式无效：{error}") from error
        elif case_insensitive:
            pattern = re.compile(re.escape(search), flags)
            result, changed = pattern.subn(lambda _match: replace, result, count=count)
        elif replace_all:
            changed = result.count(search)
            if changed:
                result = result.replace(search, replace)
        else:
            result, changed = _replace_literal_once(result, search, replace)
        total += changed

    return result, total


def _replace_object(
    value: Any,
    rules: list[tuple[str, str, int]],
    *,
    case_insensitive: bool,
    regex_mode: bool,
    replace_all: bool,
) -> tuple[Any, int]:
    if isinstance(value, str):
        return _replace_text(
            value,
            rules,
            case_insensitive=case_insensitive,
            regex_mode=regex_mode,
            replace_all=replace_all,
        )

    if isinstance(value, list):
        changed_total = 0
        replaced_items = []
        for item in value:
            replaced, changed = _replace_object(
                item,
                rules,
                case_insensitive=case_insensitive,
                regex_mode=regex_mode,
                replace_all=replace_all,
            )
            replaced_items.append(replaced)
            changed_total += changed
        return replaced_items, changed_total

    if isinstance(value, tuple):
        changed_total = 0
        replaced_items = []
        for item in value:
            replaced, changed = _replace_object(
                item,
                rules,
                case_insensitive=case_insensitive,
                regex_mode=regex_mode,
                replace_all=replace_all,
            )
            replaced_items.append(replaced)
            changed_total += changed
        return tuple(replaced_items), changed_total

    if isinstance(value, dict):
        changed_total = 0
        replaced_dict = {}
        for key, item in value.items():
            replaced_key = key
            if isinstance(key, str):
                replaced_key, key_changed = _replace_text(
                    key,
                    rules,
                    case_insensitive=case_insensitive,
                    regex_mode=regex_mode,
                    replace_all=replace_all,
                )
                changed_total += key_changed
            replaced_item, item_changed = _replace_object(
                item,
                rules,
                case_insensitive=case_insensitive,
                regex_mode=regex_mode,
                replace_all=replace_all,
            )
            replaced_dict[replaced_key] = replaced_item
            changed_total += item_changed
        return replaced_dict, changed_total

    if isinstance(value, set):
        changed_total = 0
        replaced_set = set()
        for item in value:
            replaced, changed = _replace_object(
                item,
                rules,
                case_insensitive=case_insensitive,
                regex_mode=regex_mode,
                replace_all=replace_all,
            )
            replaced_set.add(replaced)
            changed_total += changed
        return replaced_set, changed_total

    return value, 0


class GJJ_MultiReplace:
    CATEGORY = "GJJ"
    FUNCTION = "replace"
    DESCRIPTION = "对任意对象中的文本内容执行多组查找替换；字符串、列表、元组、字典会递归处理，非文本对象原样透传。"
    SEARCH_ALIASES = ["replace", "multi replace", "文本替换", "批量替换", "正则替换", "任意对象替换"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("替换结果",)
    OUTPUT_TOOLTIPS = ("替换后的对象；字符串直接输出文本，列表/字典会保留原结构并替换其中的文本。",)
    GJJ_HELP = {
        "title": "GJJ · 🔤 多功能替换",
        "description": "支持任意对象输入的多组文本替换节点。可开启大小写模糊、正则表达式和仅替换首个匹配。",
        "inputs": {
            "任意对象": "要处理的输入对象。字符串会直接替换；列表、元组、字典会递归替换其中的文本；其他对象原样输出。",
            "查找/替换": "默认显示一组。当前最后一组填入查找或替换内容后，会自动展开下一组。",
        },
        "outputs": {
            "替换结果": "完成替换后的对象。",
        },
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source": (
                    any_type,
                    {
                        "display_name": "任意对象",
                        "tooltip": "可连接任意类型。字符串会被替换；列表、元组、字典会递归替换其中的文本；其他对象原样透传。",
                    },
                ),
            },
            "optional": _build_pair_inputs(),
        }

    def replace(
        self,
        source: Any,
        options_json: str = "{}",
        **kwargs,
    ):
        options = _parse_options(options_json, kwargs)
        rules = _collect_rules(kwargs)
        if not rules:
            return {
                "ui": {"text": ("未设置替换规则，已原样输出。",)},
                "result": (source,),
            }

        result, changed = _replace_object(
            source,
            rules,
            case_insensitive=options["case_insensitive"],
            regex_mode=options["regex_mode"],
            replace_all=options["replace_all"],
        )
        summary = f"已应用 {len(rules)} 组规则，命中替换 {changed} 处。"
        return {
            "ui": {"text": (summary,)},
            "result": (result,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MultiReplace}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔤 多功能替换"}
