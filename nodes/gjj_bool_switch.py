from __future__ import annotations

import ast
import json
import re
from typing import Any

NODE_NAME = "GJJ_BoolSwitch"


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_input_type = AnyType("STRING")  # 必须用 STRING 触发文本框渲染；前端 gjj_common_node_standardizer.js 会把插槽 type 改成 * 以支持任意类型连接
any_output_type = AnyType("*")
_FORCE_RE = re.compile(r"^(int|float|str|string|bool|boolean|json|list|tuple|none|null)\((.*)\)$", re.I | re.S)


def _unwrap_text_param(value: Any) -> Any:
    """
    只兼容“文本框参数被 ComfyUI 包成单元素 list/tuple”的情况。

    重要：
    - 如果外接的是非文本 list/tuple，例如 conditioning、批量数据、坐标列表等，必须原样透传。
    - 所以这里只在 len == 1 且内部元素是 str 时才拆包。
    """
    if isinstance(value, (list, tuple)) and len(value) == 1 and isinstance(value[0], str):
        return value[0]
    return value


def _strip_quotes(text: str) -> str:
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        try:
            return ast.literal_eval(text)
        except Exception:
            return text[1:-1]
    return text


def _to_bool(text: str) -> bool:
    value = text.strip().lower()
    if value in {"1", "true", "yes", "y", "on", "是", "真", "开", "启用"}:
        return True
    if value in {"0", "false", "no", "n", "off", "否", "假", "关", "禁用"}:
        return False
    raise ValueError(f"无法转换为 bool：{text!r}")


def _convert_forced(kind: str, inner: str) -> Any:
    kind = kind.lower()
    inner = inner.strip()

    if kind == "int":
        return int(float(_strip_quotes(inner)))
    if kind == "float":
        return float(_strip_quotes(inner))
    if kind in {"str", "string"}:
        return _strip_quotes(inner)
    if kind in {"bool", "boolean"}:
        return _to_bool(_strip_quotes(inner))
    if kind in {"none", "null"}:
        return None
    if kind == "json":
        return json.loads(inner)
    if kind in {"list", "tuple"}:
        parsed = _parse_one_value(inner)
        if isinstance(parsed, (list, tuple)):
            values = parsed
        else:
            values = [parsed]
        return tuple(values) if kind == "tuple" else list(values)

    return inner


def _parse_one_value(text: str) -> Any:
    """把节点内文本转换成更自然的 Python 类型。"""
    text = text.strip()
    if text == "":
        return ""

    forced = _FORCE_RE.match(text)
    if forced:
        return _convert_forced(forced.group(1), forced.group(2))

    lower = text.lower()
    if lower in {"none", "null", "空"}:
        return None
    if lower in {"true", "false"} or text in {"是", "否", "真", "假", "开", "关"}:
        return _to_bool(text)

    # 整数：1、-2、+3
    if re.fullmatch(r"[+-]?\d+", text):
        try:
            return int(text)
        except Exception:
            pass

    # 浮点：1.2、.5、1.、1e-3、-2.5e+4
    if re.fullmatch(r"[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?", text) and any(ch in text for ch in ".eE"):
        try:
            return float(text)
        except Exception:
            pass

    # JSON / Python 字面量：例如 [1, 2]、{"a": 1}、("a", 1)
    if text[:1] in "[{('\"" or text[-1:] in "]})'\"":
        try:
            return json.loads(text)
        except Exception:
            try:
                return ast.literal_eval(text)
            except Exception:
                pass

    return text


def _parse_widget_text(value: Any) -> Any:
    """
    规则：
    - 外接非字符串对象：原样透传，不解析、不转换、不拆包。
    - 外接 list/tuple/dict/tensor/IMAGE/AUDIO/LATENT/CONDITIONING/MODEL 等：原样透传。
    - 空文本：返回空字符串。
    - 单行：自动转 int / float / bool / None，或按 int(...) / float(...) 强制转换。
    - 多行：逐行转换，返回 list。例如：
      1\n2 -> [1, 2]
      1.2\n3.4 -> [1.2, 3.4]
    """
    value = _unwrap_text_param(value)
    if value is None:
        return ""
    if not isinstance(value, str):
        return value

    raw = value.strip()
    if raw == "":
        return ""

    lines = [line.strip() for line in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    lines = [line for line in lines if line != ""]
    if len(lines) > 1:
        return [_parse_one_value(line) for line in lines]

    return _parse_one_value(raw)


class GJJBoolSwitch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "boolean": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "是否判断",
                        "tooltip": "控制条件分支的布尔值。为真输出“为真时”，为假输出“为假时”。",
                    },
                ),
                "on_true": (
                    any_input_type,
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "为真时",
                        "tooltip": "当条件为真时输出。可直接输入，也可外接。输入 1/2 自动转 INT；1.2/3.4 自动转 FLOAT；多行会转列表；支持 int(1)、float(1)、str(1)、bool(true)、json([1,2])。",
                    },
                ),
                "on_false": (
                    any_input_type,
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "为假时",
                        "tooltip": "当条件为假时输出。可直接输入，也可外接。输入 1/2 自动转 INT；1.2/3.4 自动转 FLOAT；多行会转列表；支持 int(1)、float(1)、str(1)、bool(true)、json([1,2])。",
                    },
                ),
            },
        }

    RETURN_TYPES = (any_output_type,)
    RETURN_NAMES = ("输出",)
    FUNCTION = "execute"
    CATEGORY = "GJJ/逻辑控制"

    def execute(self, boolean: bool, on_true: Any = "", on_false: Any = ""):
        selected = on_true if boolean else on_false
        return (_parse_widget_text(selected),)

    GJJ_HELP = {
        "description": "🟦 布尔切换器：根据布尔值选择输出内容。为真/为假输入框本身支持外接，也支持节点内直接输入文本/数字。只有字符串会进入解析；外接非文本对象会原样透传，例如 IMAGE、AUDIO、MODEL、LATENT、CONDITIONING、list、dict、tensor 等。节点内输入会自动转换 int、float、bool、None，多行会输出列表，并支持 int(1)、float(1)、str(1)、bool(true)、json([1,2]) 等强制格式。",
        "example": "为真时输入 1\\n2 输出 [1, 2]；为假时输入 1.2\\n3.4 输出 [1.2, 3.4]；输入 int(1) 强制输出整数 1，输入 float(1) 强制输出浮点 1.0。",
    }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJBoolSwitch}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ. 🟦 布尔切换器（是否判断）"}
