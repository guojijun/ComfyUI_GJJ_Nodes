from __future__ import annotations

import ast
import json
import math
import re
from typing import Any

from .gjj_conditional_bypass import (
    INPUT_PREFIX,
    MAX_INPUTS as MAX_CONDITION_INPUTS,
    VARIABLE_NAMES_NAME,
    _collect_values,
    _eval_ast,
    _normalize_formula,
    any_type,
)


NODE_NAME = "GJJ_ConditionalRouteSwitch"
ROUTE_PREFIX = "any_"
MAX_ROUTES = 16
ROUTE_FORMULA_TYPE = "STRING"


class FlexibleRouteInputType(dict):
    def __init__(self, data: dict[str, Any] | None = None):
        super().__init__()
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        text = str(key or "")
        if text.startswith(ROUTE_PREFIX):
            index = _extract_index(text)
            if 1 <= index <= MAX_ROUTES:
                return (
                    any_type,
                    {
                        "display_name": f"输入 {index}",
                        "tooltip": "待路由的任意对象；公式结果等于本路序号时才会请求并透传。",
                        "forceInput": True,
                        "lazy": True,
                    },
                )
        if text.startswith(INPUT_PREFIX):
            index = _extract_index(text)
            if 1 <= index <= MAX_CONDITION_INPUTS:
                return (
                    any_type,
                    {
                        "display_name": f"x{index}",
                        "tooltip": "内部变量输入；可在路由公式中使用 x1、x2 或变量显示名。",
                        "forceInput": True,
                    },
                )
        raise KeyError(key)

    def __contains__(self, key):
        text = str(key or "")
        if key in self.data:
            return True
        if text.startswith(ROUTE_PREFIX):
            index = _extract_index(text)
            return 1 <= index <= MAX_ROUTES
        if text.startswith(INPUT_PREFIX):
            index = _extract_index(text)
            return 1 <= index <= MAX_CONDITION_INPUTS
        return False


def _extract_index(name: str) -> int:
    try:
        return int(str(name or "").split("_")[-1])
    except Exception:
        return 999999


def _route_key(index: int) -> str:
    return f"{ROUTE_PREFIX}{index:02d}"


def _condition_key(index: int) -> str:
    return f"{INPUT_PREFIX}{index:02d}"


def _eval_route_ast(node, values: dict[str, Any]) -> Any:
    if isinstance(node, ast.Expression):
        return _eval_route_ast(node.body, values)
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return [_eval_route_ast(item, values) for item in node.elts]
    return _eval_ast(node, values)


def _coerce_route_index(value: Any) -> int:
    if isinstance(value, bool):
        return 1 if value else 0
    try:
        numeric = float(value)
    except Exception as exc:
        raise ValueError(f"公式结果不能转换为路号：{value}") from exc
    if not math.isfinite(numeric):
        raise ValueError("公式结果不是有限数字。")
    return int(numeric)


def _expand_route_result(result: Any) -> list[Any]:
    if isinstance(result, (list, tuple, set)):
        return list(result)
    if isinstance(result, str):
        text = result.strip()
        if text.startswith(("[", "(", "{")) and text.endswith(("]", ")", "}")):
            try:
                import ast

                parsed = ast.literal_eval(text)
                if isinstance(parsed, (list, tuple, set)):
                    return list(parsed)
            except Exception:
                pass
        if "," in text or "，" in text:
            return [part.strip() for part in text.replace("，", ",").split(",") if part.strip()]
    return [result]


def _formula_is_variable_map(text: str) -> bool:
    if not text.startswith("{") or not text.endswith("}"):
        return False
    try:
        data = json.loads(text)
    except Exception:
        return False
    return isinstance(data, dict) and any(str(key).startswith("x") for key in data)


def _normalize_route_formula(formula: Any, values: dict[str, Any] | None = None) -> str:
    text = _normalize_formula(formula)
    if _formula_is_variable_map(text):
        return "x1"
    return text


def _formula_value_indexes(formula_text: str) -> list[int]:
    indexes: list[int] = []
    for match in re.finditer(r"\bx([1-9]\d*)\b", formula_text):
        index = int(match.group(1))
        if 1 <= index <= MAX_CONDITION_INPUTS and index not in indexes:
            indexes.append(index)
    return indexes


def _calculate_route_indexes(formula: Any, values: dict[str, Any]) -> list[int]:
    text = _normalize_route_formula(formula, values)
    if len(text) > 512:
        raise ValueError("公式过长，请控制在 512 个字符以内。")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        raise ValueError("公式语法错误，请检查变量名、运算符或括号。") from exc

    raw_indexes = _expand_route_result(_eval_route_ast(tree, values))
    indexes: list[int] = []
    for item in raw_indexes:
        index = _coerce_route_index(item)
        if index not in indexes:
            indexes.append(index)
    return indexes


class GJJ_ConditionalRouteSwitch:
    CATEGORY = "GJJ"
    FUNCTION = "route"
    DESCRIPTION = "条件路由切换：公式或变量值等于第几路，就透传第几路输入；变量模式下未选中路会在提交前旁路下游。"
    SEARCH_ALIASES = ["conditional route switch", "route switch", "条件路由", "条件切换", "公式路由", "变量路由", "多选路由"]
    RETURN_TYPES = tuple(any_type for _ in range(MAX_ROUTES))
    RETURN_NAMES = tuple(f"输出 {index}" for index in range(1, MAX_ROUTES + 1))
    OUTPUT_TOOLTIPS = tuple("公式结果包含本路序号时输出同序号输入；变量模式下未选中路会在提交前旁路下游。 " for _ in range(MAX_ROUTES))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "formula": (
                    ROUTE_FORMULA_TYPE,
                    {
                        "default": "1",
                        "multiline": False,
                        "display_name": "路由公式",
                        "tooltip": "公式结果作为 1 基路号：等于 1 走第 1 路，等于 2 走第 2 路；也可返回 [1,2] 同时走多路。可用 x1、x2 或变量显示名。",
                    },
                ),
            },
            "optional": FlexibleRouteInputType(
                {
                    "any_01": (
                        any_type,
                        {
                            "display_name": "输入 1",
                            "tooltip": "第一路任意输入；连接后前端会自动增加下一对输入/输出。",
                            "forceInput": True,
                            "lazy": True,
                        },
                    ),
                    VARIABLE_NAMES_NAME: (
                        "STRING",
                        {
                            "default": "{}",
                            "display_name": "",
                            "tooltip": "内部状态：前端记录变量选择对应的显示名，用于公式里的中文变量名。",
                            "display": "hidden",
                            "hidden": True,
                        },
                    ),
                }
            ),
        }

    @classmethod
    def IS_CHANGED(cls, formula, **kwargs):
        parts = [str(_normalize_formula(formula)), str(kwargs.get(VARIABLE_NAMES_NAME, ""))]
        for index in range(1, MAX_CONDITION_INPUTS + 1):
            key = _condition_key(index)
            parts.append(f"{key}:{kwargs.get(key, None)}")
        for index in range(1, MAX_ROUTES + 1):
            key = _route_key(index)
            parts.append(f"{key}:{kwargs.get(key, None)}")
        return "|".join(parts)

    def check_lazy_status(self, formula, **kwargs):
        values, _first_value = _collect_values(kwargs)
        formula_text = _normalize_route_formula(formula, values)
        needed_conditions = []
        for index in _formula_value_indexes(formula_text):
            key = _condition_key(index)
            if kwargs.get(key) is None:
                needed_conditions.append(key)
        if needed_conditions:
            return needed_conditions
        try:
            route_indexes = _calculate_route_indexes(formula_text, values)
        except Exception:
            return []
        needed = []
        for route_index in route_indexes:
            if 1 <= route_index <= MAX_ROUTES:
                key = _route_key(route_index)
                if kwargs.get(key) is None:
                    needed.append(key)
        return needed

    def route(self, formula, **kwargs):
        values, _first_value = _collect_values(kwargs)
        formula_text = _normalize_route_formula(formula, values)
        outputs = [None for _ in range(MAX_ROUTES)]
        try:
            selected_indexes = _calculate_route_indexes(formula_text, values)
            valid_indexes = [index for index in selected_indexes if 1 <= index <= MAX_ROUTES]
            for index in valid_indexes:
                outputs[index - 1] = kwargs.get(_route_key(index))
            if valid_indexes:
                selected_text = "、".join(str(index) for index in valid_indexes)
                status = f"路由到第 {selected_text} 路：{formula_text}"
            else:
                raw_text = "、".join(str(index) for index in selected_indexes) or "空"
                status = f"公式结果为 {raw_text}，没有匹配路由，全部旁路。"
        except Exception as exc:
            valid_indexes = []
            status = f"路由计算失败：{exc} 全部旁路。"

        return {
            "ui": {
                "conditional_route_selected": [valid_indexes],
                "conditional_route_status": [status],
                "conditional_route_formula": [formula_text],
            },
            "result": tuple(outputs),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ConditionalRouteSwitch}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🚦 条件路由切换"}
