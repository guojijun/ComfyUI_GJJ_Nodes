from __future__ import annotations

import ast
import math
import operator
from typing import Any

NODE_NAME = "GJJ_MultifunctionCalculator"
INPUT_PREFIX = "value_"
MAX_INPUTS = 24
SHOW_INT_OUTPUT_NAME = "show_int_output"
SHOW_FORMULA_OUTPUT_NAME = "show_formula_output"


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


class FlexibleCalculatorInputType(dict):
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
            return (
                any_type,
                {
                    "display_name": f"x{index}",
                    "tooltip": "动态输入；可接入数字或可转换为数字的字符串，在公式里用 x1、x2、x3 引用。",
                    "forceInput": True,
                },
            )
        raise KeyError(key)

    def __contains__(self, key):
        text = str(key or "")
        return key in self.data or text.startswith(INPUT_PREFIX)


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
}

SAFE_FUNCS = {
    "abs": abs,
    "any": None,
    "avg": None,
    "ceil": math.ceil,
    "floor": math.floor,
    "max": max,
    "mean": None,
    "min": min,
    "mod": operator.mod,
    "pow": pow,
    "round": round,
    "sum": sum,
}


def _extract_input_index(name: str) -> int:
    try:
        return int(str(name or "").split("_")[-1])
    except Exception:
        return 999999


def _normalize_formula(formula: Any) -> str:
    text = str(formula or "").strip()
    if not text:
        return "0"
    return text.replace("×", "*").replace("÷", "/").replace("％", "%")


def _collect_values(kwargs: dict[str, Any]) -> dict[str, float]:
    values: dict[str, float] = {}
    for key, value in kwargs.items():
        text = str(key or "")
        if not text.startswith(INPUT_PREFIX):
            continue
        index = _extract_input_index(text)
        if index < 1 or index > MAX_INPUTS:
            continue
        if value is None:
            continue
        try:
            resolved = float(value)
        except Exception as exc:
            raise ValueError(f"数值 {index} 不是可计算数字。") from exc
        values[f"x{index}"] = resolved
    return values


def _guard_number(value: Any) -> float:
    try:
        resolved = float(value)
    except Exception as exc:
        raise ValueError("公式结果不是可计算数字。") from exc
    if not math.isfinite(resolved):
        raise ValueError("公式结果不是有限数字，请检查除数或幂运算。")
    return resolved


def _eval_ast(node: ast.AST, values: dict[str, float]) -> float:
    if isinstance(node, ast.Expression):
        return _eval_ast(node.body, values)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ValueError("公式只允许数字、变量、运算符和白名单函数。")
        return _guard_number(node.value)
    if isinstance(node, ast.Name):
        if node.id not in values:
            raise ValueError(f"公式引用了未连接的输入 {node.id}。")
        return _guard_number(values[node.id])
    if isinstance(node, ast.BinOp):
        op_type = type(node.op)
        if op_type not in BIN_OPS:
            raise ValueError("公式包含不支持的二元运算。")
        left = _eval_ast(node.left, values)
        right = _eval_ast(node.right, values)
        if op_type in (ast.Div, ast.FloorDiv, ast.Mod) and right == 0:
            raise ValueError("除法、整除或取余的右侧不能为 0。")
        if op_type is ast.Pow and abs(right) > 12:
            raise ValueError("幂运算指数过大，请降低指数。")
        return _guard_number(BIN_OPS[op_type](left, right))
    if isinstance(node, ast.UnaryOp):
        op_type = type(node.op)
        if op_type not in UNARY_OPS:
            raise ValueError("公式包含不支持的一元运算。")
        return _guard_number(UNARY_OPS[op_type](_eval_ast(node.operand, values)))
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in SAFE_FUNCS:
            raise ValueError(
                "公式只允许 abs、round、floor、ceil、min、max、sum、avg、mean、any、pow、mod 函数。"
            )
        if node.keywords:
            raise ValueError("公式函数不支持关键字参数。")
        args = [_eval_ast(arg, values) for arg in node.args]
        if node.func.id == "sum":
            if not args:
                raise ValueError("sum 函数至少需要 1 个参数。")
            return _guard_number(sum(args))
        if node.func.id in ("avg", "mean"):
            if not args:
                raise ValueError(f"{node.func.id} 函数至少需要 1 个参数。")
            return _guard_number(sum(args) / len(args))
        if node.func.id == "any":
            if args:
                return _guard_number(args[0])
            if not values:
                raise ValueError("any 函数没有可用的已连接输入。")
            first_key = sorted(values.keys(), key=lambda name: int(name[1:]))[0]
            return _guard_number(values[first_key])
        if node.func.id == "mod" and len(args) == 2 and args[1] == 0:
            raise ValueError("mod 函数的第二个参数不能为 0。")
        try:
            return _guard_number(SAFE_FUNCS[node.func.id](*args))
        except TypeError as exc:
            raise ValueError(f"{node.func.id} 函数参数数量不正确。") from exc
    raise ValueError("公式包含不支持的语法。")


def _calculate_formula(formula: Any, values: dict[str, float]) -> float:
    text = _normalize_formula(formula)
    if len(text) > 512:
        raise ValueError("公式过长，请控制在 512 个字符以内。")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        raise ValueError("公式语法不完整，请检查括号、运算符和变量。") from exc
    return _guard_number(_eval_ast(tree, values))


class GJJ_MultifunctionCalculator:
    CATEGORY = "GJJ"
    FUNCTION = "calculate"
    DESCRIPTION = "动态扩展数值输入，通过计算器按钮编辑公式，支持加减乘除、取余、整除、幂、括号和常用数学函数。"
    SEARCH_ALIASES = [
        "calculator",
        "math",
        "formula",
        "dynamic calculator",
        "计算器",
        "公式",
        "动态输入",
        "加减乘除",
        "取余",
        "模数",
    ]
    # 前端会按按钮动态显示输出口；后端按同一顺序动态返回，避免隐藏槽位错位。
    RETURN_TYPES = ("FLOAT", any_type, any_type)
    RETURN_NAMES = ("浮点结果", "整数结果", "输出公式")
    OUTPUT_TOOLTIPS = (
        "公式计算后的浮点结果。",
        "公式计算后四舍五入得到的整数结果。",
        "实际参与计算的公式文本，便于传给其他文本节点记录。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "formula": (
                    "STRING",
                    {
                        "default": "x1 * x2 +1",
                        "multiline": False,
                        "display_name": "计算公式",
                        "tooltip": "在这里填写公式；动态输入按 x1、x2、x3 引用。支持 + - * / % // ** 和 abs、round、floor、ceil、min、max、sum、avg、mean、any、pow、mod。",
                    },
                ),
            },
            "optional": FlexibleCalculatorInputType(
                {
                    "value_01": (
                        any_type,
                        {
                            "display_name": "x1",
                            "tooltip": "第一路动态输入；可接入数字或可转换为数字的字符串，在公式中使用 x1 引用。",
                            "forceInput": True,
                        },
                    ),
                    SHOW_INT_OUTPUT_NAME: (
                        "BOOLEAN",
                        {
                            "default": False,
                            "display_name": "",
                            "tooltip": "内部状态：是否显示整数结果输出口。前端按钮控制，默认隐藏。",
                            "display": "hidden",
                            "hidden": True,
                        },
                    ),
                    SHOW_FORMULA_OUTPUT_NAME: (
                        "BOOLEAN",
                        {
                            "default": False,
                            "display_name": "",
                            "tooltip": "内部状态：是否显示输出公式输出口。前端按钮控制，默认隐藏。",
                            "display": "hidden",
                            "hidden": True,
                        },
                    ),
                }
            ),
        }

    @classmethod
    def IS_CHANGED(cls, formula, **kwargs):
        values = _collect_values(kwargs)
        parts = [str(_normalize_formula(formula))]
        parts.append(f"int:{bool(kwargs.get(SHOW_INT_OUTPUT_NAME, False))}")
        parts.append(f"formula:{bool(kwargs.get(SHOW_FORMULA_OUTPUT_NAME, False))}")
        parts.extend(f"{key}:{values[key]}" for key in sorted(values))
        return "|".join(parts)

    def calculate(self, formula, **kwargs):
        values = _collect_values(kwargs)
        result = _calculate_formula(formula, values)
        formula_text = _normalize_formula(formula)
        outputs: list[Any] = [result]
        if bool(kwargs.get(SHOW_INT_OUTPUT_NAME, False)):
            outputs.append(int(round(result)))
        if bool(kwargs.get(SHOW_FORMULA_OUTPUT_NAME, False)):
            outputs.append(formula_text)
        return {
            "ui": {
                "calculator_result": [result],
                "calculator_formula": [formula_text],
                "calculator_inputs": [len(values)],
            },
            "result": tuple(outputs),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MultifunctionCalculator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧮 多功能计算器"}
