from __future__ import annotations

from typing import Any
import json
import re


NODE_NAME = "GJJ_TemplateSetVariables"
MAX_VARIABLES = 32
DEFAULT_TEMPLATE = "采样帧数（SampleFrames）[INT]：93\n宽度（Width）[INT]：640\n高度（Height）[INT]：608"
PRIMITIVE_TYPES = {"INT", "FLOAT", "BOOLEAN", "STRING", "*"}


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    def __init__(self, input_type: Any):
        super().__init__()
        self.input_type = input_type

    def __getitem__(self, key):
        return (self.input_type,)

    def __contains__(self, key):
        return True


any_type = AnyType("*")


def _safe_json_loads(value: Any, fallback: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value or ""))
    except Exception:
        return fallback


def _normalize_text(value: Any) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def _split_value_and_tooltip(text: str) -> tuple[str, str]:
    raw = str(text or "")
    escaped = False
    quote = ""
    for index, char in enumerate(raw):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char in {"'", '"'}:
            if quote == char:
                quote = ""
            elif not quote:
                quote = char
            continue
        if char == "#" and not quote:
            return raw[:index].replace("\\#", "#").strip(), raw[index + 1:].strip()
    return raw.replace("\\#", "#").strip(), ""


def _strip_quotes(value: str) -> str:
    text = str(value or "").strip()
    if len(text) >= 2 and ((text[0] == text[-1] == '"') or (text[0] == text[-1] == "'")):
        return text[1:-1]
    return text


def _slug_key(label: str, index: int, seen: dict[str, int]) -> str:
    text = str(label or "").strip()
    explicit = re.fullmatch(r"(.+?)[（(]\s*([^（）()]+?)\s*[）)]", text)
    if explicit:
        text = explicit.group(2).strip()
    key = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff-]+", "_", text).strip("_") or f"var_{index + 1}"
    count = seen.get(key, 0)
    seen[key] = count + 1
    return f"{key}_{count + 1}" if count else key


def _normalize_socket_type(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = text.replace("，", ",")
    text = re.sub(r"\s+", "", text)
    if text.lower() in {"any", "*"}:
        return "*"
    return text.upper()


def _split_socket_types(socket_type: Any) -> list[str]:
    normalized = _normalize_socket_type(socket_type)
    if not normalized:
        return []
    return [part for part in normalized.split(",") if part]


def _value_type_for_socket(socket_type: str, inferred_type: str) -> str:
    parts = _split_socket_types(socket_type)
    inferred = _normalize_socket_type(inferred_type) or "*"
    if not parts:
        return inferred
    if inferred in PRIMITIVE_TYPES and (inferred in parts or "*" in parts):
        return inferred
    for primitive in ("INT", "FLOAT", "BOOLEAN", "STRING"):
        if primitive in parts:
            return primitive
    return _normalize_socket_type(socket_type) or inferred


def _split_label_and_socket_type(raw_label: str) -> tuple[str, str]:
    label = str(raw_label or "").strip()
    match = re.search(r"\s*(?:\[\s*([^\]]+?)\s*\]|【\s*([^】]+?)\s*】)\s*$", label)
    if not match:
        return label, ""
    socket_type = _normalize_socket_type(match.group(1) or match.group(2) or "")
    return label[:match.start()].strip(), socket_type


def _label_and_key(raw_label: str, index: int, seen: dict[str, int]) -> tuple[str, str]:
    label = str(raw_label or "").strip() or f"变量 {index + 1}"
    explicit = re.fullmatch(r"(.+?)[（(]\s*([^（）()]+?)\s*[）)]", label)
    if explicit:
        label = explicit.group(1).strip() or label
        key_text = explicit.group(2).strip()
        key = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff-]+", "_", key_text).strip("_") or _slug_key(label, index, seen)
        count = seen.get(key, 0)
        seen[key] = count + 1
        if count:
            key = f"{key}_{count + 1}"
        return label, key
    return label, _slug_key(label, index, seen)


def parse_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    raw = value.strip()
    if not raw:
        return ""
    forced = re.fullmatch(r"(int|float|str|string|bool|boolean|json)\(([\s\S]*)\)", raw, re.IGNORECASE)
    if forced:
        kind = forced.group(1).lower()
        inner = _strip_quotes(forced.group(2).strip())
        if kind == "int":
            return int(float(inner or 0))
        if kind == "float":
            return float(inner or 0)
        if kind in {"bool", "boolean"}:
            return str(inner).strip().lower() in {"1", "true", "yes", "on", "是", "真", "开"}
        if kind == "json":
            return _safe_json_loads(forced.group(2).strip(), inner)
        return inner
    if re.fullmatch(r"true|yes|on|是|真|开", raw, re.IGNORECASE):
        return True
    if re.fullmatch(r"false|no|off|否|假|关", raw, re.IGNORECASE):
        return False
    if re.fullmatch(r"none|null|nil", raw, re.IGNORECASE):
        return None
    if re.fullmatch(r"[-+]?\d+", raw):
        return int(raw)
    if re.fullmatch(r"[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?", raw) or re.fullmatch(r"[-+]?\d+[eE][-+]?\d+", raw):
        return float(raw)
    if (raw.startswith("[") and raw.endswith("]")) or (raw.startswith("{") and raw.endswith("}")):
        return _safe_json_loads(raw, raw)
    return value


def _infer_type(raw_value: str, parsed: Any) -> str:
    raw = str(raw_value or "").strip()
    forced = re.match(r"(int|float|str|string|bool|boolean|json)\(", raw, re.IGNORECASE)
    if forced:
        kind = forced.group(1).lower()
        if kind == "int":
            return "INT"
        if kind == "float":
            return "FLOAT"
        if kind in {"bool", "boolean"}:
            return "BOOLEAN"
        if kind == "json":
            return "*"
        return "STRING"
    if isinstance(parsed, bool):
        return "BOOLEAN"
    if isinstance(parsed, int) and not isinstance(parsed, bool):
        return "INT"
    if isinstance(parsed, float):
        return "FLOAT"
    if isinstance(parsed, (dict, list)) or parsed is None:
        return "*"
    return "STRING"


def _coerce_value(value: Any, field_type: str) -> Any:
    field_type = _normalize_socket_type(field_type) or "*"
    if field_type == "INT":
        try:
            return int(float(value))
        except Exception:
            return 0
    if field_type == "FLOAT":
        try:
            return float(value)
        except Exception:
            return 0.0
    if field_type == "BOOLEAN":
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on", "是", "真", "开"}
        return bool(value)
    if field_type == "STRING":
        return str(value)
    if field_type not in {"*"} and (value is None or value == ""):
        return None
    return value


def parse_template(template_text: str) -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    for raw_line in _normalize_text(template_text or DEFAULT_TEMPLATE).split("\n"):
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("...."):
            continue
        match = re.match(r"^([^:：=]+?)\s*[:：=]\s*(.*?)\s*$", line)
        left_text = match.group(1) if match else line
        right_text = match.group(2) if match else ""
        label_text, explicit_type = _split_label_and_socket_type(left_text)
        label, key = _label_and_key(label_text, len(fields), seen)
        raw_default, tooltip = _split_value_and_tooltip(right_text)
        parsed = parse_value(raw_default)
        inferred_type = _infer_type(raw_default, parsed)
        field_type = explicit_type or inferred_type
        value_type = _value_type_for_socket(explicit_type, inferred_type) if explicit_type else inferred_type
        fields.append({
            "key": key,
            "input_key": f"var_{key}",
            "label": label,
            "default": raw_default,
            "value": parsed,
            "type": field_type,
            "value_type": value_type,
            "explicit_type": explicit_type,
            "tooltip": tooltip,
        })
        if len(fields) >= MAX_VARIABLES:
            break
    return fields


class GJJ_TemplateSetVariables:
    CATEGORY = "GJJ/逻辑控制"
    FUNCTION = "output_variables"
    DESCRIPTION = "根据模板设置动态生成变量输入小圆点，并作为 GJJ 全局变量供变量读取节点使用。格式：中文标签（变量Key）[接口类型]：默认值，例如：宽度（Width）[INT]：640。默认隐藏右侧输出口；需要直接连线时可在节点工具栏点击 🔌 显示输出插口。GJJ 变量读取节点会在提交前解析到真实变量来源，不依赖右侧插口显示状态。"
    SEARCH_ALIASES = ["template variables", "模板设置", "模板变量", "变量设置", "动态变量", "SampleFrames", "Width", "Height", "WANVAE", "WANVIDEOMODEL"]
    RETURN_TYPES = tuple(any_type for _ in range(MAX_VARIABLES))
    RETURN_NAMES = tuple(f"变量{i + 1}" for i in range(MAX_VARIABLES))
    OUTPUT_TOOLTIPS = tuple("由模板设置生成的变量值；若连接左侧变量输入，则外部输入优先。" for _ in range(MAX_VARIABLES))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "template_text": ("STRING", {
                    "default": DEFAULT_TEMPLATE,
                    "multiline": True,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "隐藏模板",
                    "tooltip": "由前端设置面板维护。每行一个变量，格式：中文标签（变量Key）[接口类型]：默认值 # 说明。方括号接口类型可省略，省略时根据默认值推断；支持 INT,FLOAT 这类组合声明。",
                }),
                "values_json": ("STRING", {
                    "default": "{}",
                    "multiline": True,
                    "hidden": True,
                    "display": "hidden",
                    "display_name": "变量值 JSON",
                    "tooltip": "由前端动态变量控件维护，不建议手动修改。",
                }),
            },
            "optional": FlexibleOptionalInputType(any_type),
        }

    @classmethod
    def IS_CHANGED(cls, template_text: str = "", values_json: str = "{}", **kwargs):
        dynamic = {key: repr(value) for key, value in sorted(kwargs.items()) if str(key).startswith("var_")}
        return json.dumps([_normalize_text(template_text), _normalize_text(values_json), dynamic], ensure_ascii=False, sort_keys=True)

    def output_variables(self, template_text: str = "", values_json: str = "{}", **kwargs):
        fields = parse_template(template_text or DEFAULT_TEMPLATE)
        value_map = _safe_json_loads(values_json, {})
        if not isinstance(value_map, dict):
            value_map = {}

        outputs: list[Any] = []
        for field in fields:
            key = str(field.get("key", ""))
            input_key = str(field.get("input_key", f"var_{key}"))
            value_type = str(field.get("value_type", field.get("type", "*")))
            if input_key in kwargs and kwargs.get(input_key) is not None:
                outputs.append(kwargs.get(input_key))
                continue
            raw = value_map.get(key, value_map.get(input_key, field.get("value")))
            outputs.append(_coerce_value(raw, value_type))

        while len(outputs) < MAX_VARIABLES:
            outputs.append(None)
        return tuple(outputs[:MAX_VARIABLES])


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TemplateSetVariables}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧩 模板设置变量"}
