from __future__ import annotations

import ast
import math
import operator
import re
from typing import Any

NODE_NAME = "GJJ_MultifunctionCalculator"
INPUT_PREFIX = "value_"
MAX_INPUTS = 24
SHOW_INT_OUTPUT_NAME = "show_int_output"
SHOW_FORMULA_OUTPUT_NAME = "show_formula_output"
PRESET_MODE_NAME = "calculator_preset_mode"
INPUT_NAMES_NAME = "input_names_json"
LEGACY_INPUT_NAMES_NAME = "input_aliases_json"
PRESET_CONVERT = "convert"


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
                    "tooltip": "可选动态输入；可手动连线，也可由同名 GJJ 变量广播自动填入，在公式里用 x1、x2、x3 或 {变量名} 引用。",
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
    "float": float,
    "int": int,
    "max": max,
    "mean": None,
    "min": min,
    "mod": operator.mod,
    "pow": pow,
    "round": round,
    "sum": sum,
}

RESERVED_NAMES = set(SAFE_FUNCS)


def _is_plain_formula_name(name: str) -> bool:
    text = str(name or "").strip()
    return bool(text) and text.isidentifier() and text not in RESERVED_NAMES and not re.fullmatch(r"x\d+", text)


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


def _coerce_value(value: Any) -> Any:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value
    text = str(value).strip()
    if re.fullmatch(r"[+-]?\d+", text):
        return int(text)
    if re.fullmatch(r"[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?", text) or re.fullmatch(r"[+-]?\d+[eE][+-]?\d+", text):
        return float(text)
    return str(value)


def _safe_json_loads(value: Any, fallback: Any) -> Any:
    if not isinstance(value, str) or not value.strip():
        return fallback
    try:
        import json

        return json.loads(value)
    except Exception:
        return fallback


def _collect_input_names(raw: Any) -> dict[str, list[str]]:
    data = _safe_json_loads(raw, {})
    if not isinstance(data, dict):
        return {}
    result: dict[str, list[str]] = {}
    for key, raw_name in data.items():
        input_name = str(key or "").strip()
        if not input_name:
            continue
        candidates = raw_name if isinstance(raw_name, list) else [raw_name]
        names: list[str] = []
        for candidate in candidates:
            text = str(candidate or "").strip()
            if text and text not in names:
                names.append(text)
        if names:
            result[input_name] = names
    return result


def _collect_values(kwargs: dict[str, Any]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for key, value in kwargs.items():
        text = str(key or "")
        if not text.startswith(INPUT_PREFIX):
            continue
        index = _extract_input_index(text)
        if index < 1 or index > MAX_INPUTS:
            continue
        if value is None:
            continue
        values[f"x{index}"] = _coerce_value(value)
    input_names = _collect_input_names(kwargs.get(INPUT_NAMES_NAME))
    if not input_names:
        input_names = _collect_input_names(kwargs.get(LEGACY_INPUT_NAMES_NAME))
    for input_name, names in input_names.items():
        if input_name not in values:
            continue
        for name in names:
            values.setdefault(name, values[input_name])
    return values


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _guard_number(value: Any) -> int | float:
    try:
        resolved = value if _is_number(value) else float(value)
    except Exception as exc:
        raise ValueError("公式结果不是可计算数字。") from exc
    if isinstance(resolved, float) and not math.isfinite(resolved):
        raise ValueError("公式结果不是有限数字，请检查除数或幂运算。")
    return resolved


def _infer_output_type(value: Any) -> str:
    if isinstance(value, bool):
        return "INT"
    if isinstance(value, int):
        return "INT"
    if isinstance(value, float):
        return "FLOAT"
    return "STRING"


def _eval_ast(node: ast.AST, values: dict[str, Any]) -> Any:
    if isinstance(node, ast.Expression):
        return _eval_ast(node.body, values)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool):
            return int(node.value)
        if isinstance(node.value, (int, float, str)):
            return node.value
        raise ValueError("公式只允许数字、字符串、变量、运算符和白名单函数。")
    if isinstance(node, ast.Name):
        if node.id in values:
            return values[node.id]
        # 让纯文本如 hello 也能作为字符串结果使用。
        return node.id
    if isinstance(node, ast.BinOp):
        op_type = type(node.op)
        if op_type not in BIN_OPS:
            raise ValueError("公式包含不支持的二元运算。")
        left = _eval_ast(node.left, values)
        right = _eval_ast(node.right, values)
        if op_type is ast.Add and (isinstance(left, str) or isinstance(right, str)):
            return f"{left}{right}"
        if op_type is ast.Mult and isinstance(left, str) and isinstance(right, int):
            return left * right
        if op_type is ast.Mult and isinstance(right, str) and isinstance(left, int):
            return right * left
        left = _guard_number(left)
        right = _guard_number(right)
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
                "公式只允许 abs、round、floor、ceil、int、float、min、max、sum、avg、mean、any、pow、mod 函数。"
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
            x_keys = [name for name in values if re.fullmatch(r"x\d+", name)]
            if not x_keys:
                raise ValueError("any 函数没有可用的 x 输入。")
            first_key = sorted(x_keys, key=lambda name: int(name[1:]))[0]
            return _guard_number(values[first_key])
        if node.func.id == "mod" and len(args) == 2 and args[1] == 0:
            raise ValueError("mod 函数的第二个参数不能为 0。")
        if node.func.id in ("int", "float"):
            if len(args) != 1:
                raise ValueError(f"{node.func.id} 函数只接受 1 个参数。")
            try:
                return SAFE_FUNCS[node.func.id](args[0])
            except Exception as exc:
                raise ValueError(f"{node.func.id} 函数无法转换当前结果。") from exc
        try:
            return _guard_number(SAFE_FUNCS[node.func.id](*args))
        except TypeError as exc:
            raise ValueError(f"{node.func.id} 函数参数数量不正确。") from exc
    raise ValueError("公式包含不支持的语法。")


def _calculate_formula(formula: Any, values: dict[str, Any]) -> Any:
    text = _normalize_formula(formula)
    if len(text) > 512:
        raise ValueError("公式过长，请控制在 512 个字符以内。")
    text, placeholder_values = _replace_placeholder_variables(text, values)
    text, plain_name_values = _replace_plain_name_variables(text, values)
    eval_values = {**values, **placeholder_values, **plain_name_values}
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        return _render_template_formula(_normalize_formula(formula), values)
    result = _eval_ast(tree, eval_values)
    if _is_number(result):
        _guard_number(result)
    return result


def _replace_plain_name_variables(text: str, values: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    placeholder_values: dict[str, Any] = {}
    name_map: dict[str, str] = {}
    plain_names = [name for name in values if _is_plain_formula_name(name)]
    if not plain_names:
        return text, placeholder_values
    plain_names.sort(key=len, reverse=True)

    for token in plain_names:
        safe_name = f"__gjj_name_{len(name_map) + 1}"
        name_map[token] = safe_name
        placeholder_values[safe_name] = values[token]

    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError:
        return text, placeholder_values

    class PlainNameTransformer(ast.NodeTransformer):
        def visit_Name(self, node: ast.Name) -> ast.AST:
            safe_name = name_map.get(node.id)
            if not safe_name:
                return node
            return ast.copy_location(ast.Name(id=safe_name, ctx=node.ctx), node)

    tree = PlainNameTransformer().visit(tree)
    ast.fix_missing_locations(tree)
    return ast.unparse(tree), placeholder_values


def _replace_placeholder_variables(text: str, values: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    placeholder_values: dict[str, Any] = {}
    used_names: dict[str, str] = {}

    def replace(match: re.Match[str]) -> str:
        name = str(match.group(1) or "").strip()
        if not name:
            raise ValueError("公式里的 {} 变量名不能为空。")
        if name not in values:
            raise ValueError(f"公式变量 {{{name}}} 没有连接到可用输入。")
        safe_name = used_names.get(name)
        if not safe_name:
            safe_name = f"__gjj_var_{len(used_names) + 1}"
            used_names[name] = safe_name
        placeholder_values[safe_name] = values[name]
        return safe_name

    return re.sub(r"\{([^{}]+)\}", replace, text), placeholder_values


def _render_template_formula(text: str, values: dict[str, Any]) -> str:
    def replace(match: re.Match[str]) -> str:
        name = match.group(0)
        return str(values.get(name, name))

    rendered = re.sub(r"\bx\d+\b", replace, str(text or ""))
    return re.sub(r"\{([^{}]+)\}", lambda match: str(values.get(match.group(1).strip(), match.group(0))), rendered)


def _converted_pair_value(value: Any) -> Any:
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, int):
        return float(value)
    if isinstance(value, float):
        return int(round(value))
    return _punctuation_to_lines(value)


def _punctuation_to_lines(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    # 保留标点本身，在常见中英文标点后断行，便于提示词/文案分段。
    text = re.sub(r"([。！？!?；;，,、：:])\s*", r"\1\n", text)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return "\n".join(lines)


def _converted_pair_type(value: Any) -> str:
    if isinstance(value, float):
        return "INT"
    if isinstance(value, (int, bool)):
        return "FLOAT"
    return "STRING"


def _coerce_float_for_conversion(value: Any) -> float:
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)):
        resolved = float(value)
    else:
        text = str(value).strip()
        if not text:
            raise ValueError("数据转换需要 x1 输入一个可转为数字的值。")
        resolved = float(text)
    if not math.isfinite(resolved):
        raise ValueError("数据转换结果不是有限数字。")
    return resolved


def _convert_int_float_pair(values: dict[str, Any]) -> tuple[int, float]:
    if "x1" not in values:
        raise ValueError("数据转换需要连接 x1 输入。")
    float_value = _coerce_float_for_conversion(values["x1"])
    return int(float_value), float_value


class GJJ_MultifunctionCalculator:
    CATEGORY = "GJJ/工作流辅助"
    FUNCTION = "calculate"
    DESCRIPTION = "动态扩展输入，通过计算器按钮编辑公式，支持数字计算、字符串拼接、自动结果类型，以及用 {输入显示名} 引用已连接输入。"
    SEARCH_ALIASES = [
        "JSQ",
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
    RETURN_TYPES = (any_type, any_type, any_type)
    RETURN_NAMES = ("自动结果", "互转/断行结果", "输出公式")
    OUTPUT_TOOLTIPS = (
        "公式计算后的自动类型结果：整数为 INT，小数为 FLOAT，文本为 STRING。",
        "自动结果为 FLOAT 时输出取整 INT；自动结果为 INT/帧数时输出 FLOAT；文本结果时按标点符号换行。",
        "实际参与计算的公式文本，便于传给其他文本节点记录。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "formula": (
                    "STRING",
                        {
                            "default": "int((x1 * x2)//4*4 +1)",
                            "multiline": False,
                            "display_name": "计算公式",
                            "tooltip": "在这里填写公式；动态输入可按 x1、x2、x3 引用，也可按前端显示名写成 {帧率}。支持数字计算、字符串常量和 + 拼接。",
                        },
                    ),
            },
            "optional": FlexibleCalculatorInputType(
                {
                    "value_01": (
                        any_type,
                        {
                            "display_name": "x1",
                            "tooltip": "第一路可选动态输入；可手动连线，也可由同名 GJJ 变量广播自动填入，在公式中使用 x1 或 {变量名} 引用。",
                            "forceInput": True,
                        },
                    ),
                    SHOW_INT_OUTPUT_NAME: (
                        "BOOLEAN",
                        {
                            "default": False,
                            "display_name": "",
                            "tooltip": "内部状态：是否显示互转结果输出口。前端按钮控制，默认隐藏。",
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
                    PRESET_MODE_NAME: (
                        "STRING",
                        {
                            "default": "",
                            "display_name": "",
                            "tooltip": "内部状态：常用预设模式。前端按钮控制，默认隐藏。",
                            "display": "hidden",
                            "hidden": True,
                        },
                    ),
                    INPUT_NAMES_NAME: (
                        "STRING",
                        {
                            "default": "{}",
                            "display_name": "",
                            "tooltip": "内部状态：前端记录连接输入的显示名，用于 {变量名} 公式。",
                            "display": "hidden",
                            "hidden": True,
                        },
                    ),
                    LEGACY_INPUT_NAMES_NAME: (
                        "STRING",
                        {
                            "default": "{}",
                            "display_name": "",
                            "tooltip": "内部兼容：旧版输入名称缓存。",
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
        parts.append(f"preset:{str(kwargs.get(PRESET_MODE_NAME, '') or '')}")
        parts.append(f"names:{str(kwargs.get(INPUT_NAMES_NAME, '') or '')}")
        parts.append(f"legacy_names:{str(kwargs.get(LEGACY_INPUT_NAMES_NAME, '') or '')}")
        parts.extend(f"{key}:{values[key]}" for key in sorted(values))
        return "|".join(parts)

    def calculate(self, formula, **kwargs):
        values = _collect_values(kwargs)
        formula_text = _normalize_formula(formula)
        preset_mode = str(kwargs.get(PRESET_MODE_NAME, "") or "").strip()
        try:
            if preset_mode == PRESET_CONVERT:
                result, converted = _convert_int_float_pair(values)
            else:
                result = _calculate_formula(formula, values)
                converted = _converted_pair_value(result)
            outputs: list[Any] = [result]
            if bool(kwargs.get(SHOW_INT_OUTPUT_NAME, False)):
                outputs.append(converted)
            if bool(kwargs.get(SHOW_FORMULA_OUTPUT_NAME, False)):
                outputs.append(formula_text)
            return {
                "ui": {
                    "calculator_result": [result],
                    "calculator_result_type": [_infer_output_type(result)],
                    "calculator_pair_type": ["FLOAT" if preset_mode == PRESET_CONVERT else _converted_pair_type(result)],
                    "calculator_pair_value": [converted],
                    "calculator_formula": [formula_text],
                    "calculator_inputs": [len(values)],
                },
                "result": tuple(outputs),
            }
        except Exception as exc:
            empty_result = ""
            outputs = [empty_result]
            if bool(kwargs.get(SHOW_INT_OUTPUT_NAME, False)):
                outputs.append("")
            if bool(kwargs.get(SHOW_FORMULA_OUTPUT_NAME, False)):
                outputs.append(formula_text)
            return {
                "ui": {
                    "calculator_error": [str(exc)],
                    "calculator_formula": [formula_text],
                    "calculator_inputs": [len(values)],
                },
                "result": tuple(outputs),
            }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MultifunctionCalculator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧮 多功能计算器"}
