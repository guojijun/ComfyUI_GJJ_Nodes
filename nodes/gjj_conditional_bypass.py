from __future__ import annotations

import ast
import math
import operator
import re
from typing import Any


NODE_NAME = "GJJ_ConditionalBypass"
INPUT_PREFIX = "value_"
VARIABLE_NAMES_NAME = "variable_names_json"
MAX_INPUTS = 24


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


class FlexibleConditionInputType(dict):
    def __init__(self, data: dict[str, Any] | None = None):
        super().__init__()
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        text = str(key or "")
        if text.startswith(INPUT_PREFIX):
            index = _extract_input_index(text)
            if 1 <= index <= MAX_INPUTS:
                return (
                    any_type,
                    {
                        "display_name": f"x{index}",
                        "tooltip": "动态条件输入；可在公式中使用 x1、x2、x3，或使用变量运算选择的变量显示名。",
                        "forceInput": True,
                    },
                )
        raise KeyError(key)

    def __contains__(self, key):
        text = str(key or "")
        if key in self.data:
            return True
        if not text.startswith(INPUT_PREFIX):
            return False
        index = _extract_input_index(text)
        return 1 <= index <= MAX_INPUTS


BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}

UNARY_OPS = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
    ast.Not: operator.not_,
}

COMPARE_OPS = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
}

SAFE_FUNCS = {
    "abs": abs,
    "ceil": math.ceil,
    "floor": math.floor,
    "float": float,
    "int": int,
    "max": max,
    "min": min,
    "round": round,
}


def _extract_input_index(name: str) -> int:
    try:
        return int(str(name or "").split("_")[-1])
    except Exception:
        return 999999


def _safe_json_loads(value: Any, fallback: Any) -> Any:
    if not isinstance(value, str) or not value.strip():
        return fallback
    try:
        import json

        return json.loads(value)
    except Exception:
        return fallback


def _normalize_formula(formula: Any) -> str:
    text = str(formula or "").strip()
    if not text:
        return "False"
    return text.replace("×", "*").replace("÷", "/").replace("％", "%")


def _coerce_value(value: Any) -> Any:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    text = str(value).strip()
    if re.fullmatch(r"[+-]?\d+", text):
        return int(text)
    if re.fullmatch(r"[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?", text) or re.fullmatch(r"[+-]?\d+[eE][+-]?\d+", text):
        return float(text)
    return text


def _collect_variable_names(raw: Any) -> dict[str, list[str]]:
    data = _safe_json_loads(raw, {})
    if not isinstance(data, dict):
        return {}
    result: dict[str, list[str]] = {}
    for key, raw_names in data.items():
        input_name = str(key or "").strip()
        if not input_name:
            continue
        names = raw_names if isinstance(raw_names, list) else [raw_names]
        cleaned = []
        for name in names:
            text = str(name or "").strip()
            if text and text not in cleaned:
                cleaned.append(text)
        if cleaned:
            result[input_name] = cleaned
    return result


def _collect_values(kwargs: dict[str, Any]) -> tuple[dict[str, Any], Any]:
    values: dict[str, Any] = {}
    first_value = None
    input_items = []
    for key, value in kwargs.items():
        key_text = str(key or "")
        if not key_text.startswith(INPUT_PREFIX):
            continue
        index = _extract_input_index(key_text)
        if index < 1 or index > MAX_INPUTS or value is None:
            continue
        input_items.append((index, key_text, value))
    for index, _key, value in sorted(input_items, key=lambda item: item[0]):
        coerced = _coerce_value(value)
        values[f"x{index}"] = coerced
        if first_value is None:
            first_value = value

    input_names = _collect_variable_names(kwargs.get(VARIABLE_NAMES_NAME))
    for input_name, names in input_names.items():
        if input_name not in values:
            continue
        for name in names:
            if name.isidentifier():
                values.setdefault(name, values[input_name])
    return values, first_value


def _guard_number(value: Any) -> int | float:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        resolved = value
    else:
        try:
            resolved = float(value)
        except Exception as exc:
            raise ValueError(f"公式里的值不能转换为数字：{value}") from exc
    if isinstance(resolved, float) and not math.isfinite(resolved):
        raise ValueError("公式结果不是有限数字，请检查除数或幂运算。")
    return resolved


def _eval_ast(node: ast.AST, values: dict[str, Any]) -> Any:
    if isinstance(node, ast.Expression):
        return _eval_ast(node.body, values)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (bool, int, float, str)):
            return node.value
        raise ValueError("公式只允许布尔值、数字、字符串、变量和安全运算符。")
    if isinstance(node, ast.Name):
        if node.id in values:
            return values[node.id]
        if node.id in {"True", "true"}:
            return True
        if node.id in {"False", "false"}:
            return False
        raise ValueError(f"公式变量“{node.id}”没有可用输入。")
    if isinstance(node, ast.BinOp):
        op_type = type(node.op)
        if op_type not in BIN_OPS:
            raise ValueError("公式包含不支持的二元运算。")
        left = _eval_ast(node.left, values)
        right = _eval_ast(node.right, values)
        if op_type is ast.Add and (isinstance(left, str) or isinstance(right, str)):
            return f"{left}{right}"
        left = _guard_number(left)
        right = _guard_number(right)
        if op_type in (ast.Div, ast.FloorDiv, ast.Mod) and right == 0:
            raise ValueError("除法、整除或取余的右侧不能为 0。")
        if op_type is ast.Pow and abs(right) > 12:
            raise ValueError("幂运算指数过大，请降低指数。")
        return BIN_OPS[op_type](left, right)
    if isinstance(node, ast.UnaryOp):
        op_type = type(node.op)
        if op_type not in UNARY_OPS:
            raise ValueError("公式包含不支持的一元运算。")
        value = _eval_ast(node.operand, values)
        if op_type is ast.Not:
            return not bool(value)
        return UNARY_OPS[op_type](_guard_number(value))
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            return all(bool(_eval_ast(value, values)) for value in node.values)
        if isinstance(node.op, ast.Or):
            return any(bool(_eval_ast(value, values)) for value in node.values)
        raise ValueError("公式包含不支持的布尔运算。")
    if isinstance(node, ast.Compare):
        left = _eval_ast(node.left, values)
        for op, comparator in zip(node.ops, node.comparators):
            op_type = type(op)
            if op_type not in COMPARE_OPS:
                raise ValueError("公式包含不支持的比较运算。")
            right = _eval_ast(comparator, values)
            left_cmp = _guard_number(left) if not isinstance(left, str) else left
            right_cmp = _guard_number(right) if not isinstance(right, str) else right
            if not COMPARE_OPS[op_type](left_cmp, right_cmp):
                return False
            left = right
        return True
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in SAFE_FUNCS:
            raise ValueError("公式只允许 abs、round、floor、ceil、int、float、min、max 函数。")
        if node.keywords:
            raise ValueError("公式函数不支持关键字参数。")
        args = [_eval_ast(arg, values) for arg in node.args]
        try:
            return SAFE_FUNCS[node.func.id](*args)
        except TypeError as exc:
            raise ValueError(f"{node.func.id} 函数参数数量不正确。") from exc
    raise ValueError("公式包含不支持的语法。")


def _calculate_condition(formula: Any, values: dict[str, Any]) -> bool:
    text = _normalize_formula(formula)
    if len(text) > 512:
        raise ValueError("公式过长，请控制在 512 个字符以内。")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        raise ValueError("公式语法错误，请检查变量名、比较符或括号。") from exc
    return bool(_eval_ast(tree, values))


class GJJ_ConditionalBypass:
    CATEGORY = "GJJ"
    FUNCTION = "check"
    DESCRIPTION = "用可输入公式判断是否放行下游；条件为假时输出 False，供下游条件口跳过执行。"
    SEARCH_ALIASES = ["conditional bypass", "condition bypass", "条件旁路", "条件放行", "旁路", "公式条件"]
    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("条件通行",)
    OUTPUT_TOOLTIPS = ("条件为真时输出 True；条件为假时输出 False。连接到支持条件通行的节点时会直接跳过，不打断队列。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "formula": (
                    "STRING",
                    {
                        "default": "(x1 //x2)+1== x3",
                        "multiline": False,
                        "display_name": "公式输入",
                        "tooltip": "输入条件公式，结果转为布尔值。可用 x1、x2、x3，也可用变量运算选择的变量显示名，例如：视频帧数量 // 每段帧数 > 当前段序号。",
                    },
                ),
            },
            "optional": FlexibleConditionInputType(
                {
                    "value_01": (
                        any_type,
                        {
                            "display_name": "x1",
                            "tooltip": "第一路动态条件输入；连接后前端会自动显示下一个输入口。",
                            "forceInput": True,
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
        for index in range(1, MAX_INPUTS + 1):
            key = f"{INPUT_PREFIX}{index:02d}"
            parts.append(f"{key}:{kwargs.get(key, None)}")
        return "|".join(parts)

    def check(self, formula, **kwargs):
        formula_text = _normalize_formula(formula)
        values, first_value = _collect_values(kwargs)
        try:
            passed = _calculate_condition(formula_text, values)
            status = f"条件成立：{formula_text}" if passed else f"条件不成立：{formula_text}，下游已旁路。"
        except Exception as exc:
            passed = False
            status = f"条件计算失败：{exc} 下游已旁路。"

        return {
            "ui": {
                "conditional_bypass_passed": [passed],
                "conditional_bypass_status": [status],
                "conditional_bypass_formula": [formula_text],
            },
            "result": (bool(passed),),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ConditionalBypass}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🚦 条件旁路"}
