from __future__ import annotations

import ast
import re
from typing import Any


NODE_NAME = "GJJ_AnyIndexOutput"


class AnyType(str):
    """始终可兼容任意类型的占位类型。"""

    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


INDEX_HELP_DESCRIPTION = """🔎 这个节点按“0 基索引”从任意对象里取指定位置的内容。

🧭 先记住：0 是第 1 项，1 是第 2 项，-1 是最后 1 项，-2 是倒数第 2 项。

🧩 索引写法：
• 0：取第 1 项。
• 1,3：取第 2 项和第 4 项。
• [1,3] 或 (1,3)：同样取第 2 项和第 4 项。
• 1 3 / 1，3 / 1、3 / 多行填写：都会按多个索引处理。
• -1：取最后 1 项。
• 0,-1：取第 1 项和最后 1 项。
• 1.0 / [1.0]：允许，会当成整数 1。
• 1.3 / [1.3]：不允许，不会四舍五入；索引必须是整数，否则会报错。

📦 不同输入类型会输出什么：
• list：单个索引输出单个元素；多个索引输出 list。例如 [A,B,C,D] + 1,3 -> [B,D]。
• tuple：单个索引输出单个元素；多个索引输出 tuple。例如 (A,B,C,D) + 1,3 -> (B,D)。
• dict：按字典键的插入顺序取。单个索引输出对应 value；多个索引输出只含选中 key 的 dict。
  例如 {"a":10,"b":20,"c":30} + 1 -> 20；0,2 -> {"a":10,"c":30}。
• IMAGE / MASK / Tensor 批：按第 0 维 batch 取。单个索引也会保留 batch 维度。
  例如 4 张 IMAGE + 1 -> 形状仍是 1 张的 IMAGE 批；1,3 -> 2 张 IMAGE 批。
• LATENT：会复制 latent 字典，并同步裁剪 samples；如果有 batch_index / noise_mask，也会尽量按同样索引裁剪。
• 普通单个对象：只有 0 或 -1 会原样透传；其它索引会报错。

⚠️ 错误情况：
• 空索引会报错。
• 超出范围会报错。例如长度 4 时，4、-5 都越界。
• 布尔值 True/False 不能当索引。
• 不支持切片写法 1:3；请写成 1,2 或 [1,2]。""".strip()


def _coerce_index(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("索引不能是布尔值。")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value.is_integer():
            return int(value)
        raise ValueError(f"索引必须是整数：{value}")

    text = str(value or "").strip()
    if not text:
        raise ValueError("索引不能为空。")
    if re.fullmatch(r"[-+]?\d+", text):
        return int(text)
    if re.fullmatch(r"[-+]?\d+\.0+", text):
        return int(float(text))
    raise ValueError(f"无法转换为整数索引：{text}")


def _parse_indices(index: Any) -> list[int]:
    if isinstance(index, (list, tuple)):
        result: list[int] = []
        for item in index:
            result.extend(_parse_indices(item))
        if not result:
            raise ValueError("索引列表不能为空。")
        return result

    if isinstance(index, (int, float)) and not isinstance(index, bool):
        return [_coerce_index(index)]

    text = str(index or "").strip()
    if not text:
        raise ValueError("索引不能为空。")

    normalized = (
        text.replace("，", ",")
        .replace("、", ",")
        .replace("；", ",")
        .replace(";", ",")
        .replace("\n", ",")
        .replace("\t", ",")
    )

    try:
        literal = ast.literal_eval(normalized)
        if isinstance(literal, (list, tuple)):
            return _parse_indices(list(literal))
        return [_coerce_index(literal)]
    except Exception:
        pass

    compact = normalized.strip()
    if compact.startswith("[") and compact.endswith("]"):
        compact = compact[1:-1]
    if compact.startswith("(") and compact.endswith(")"):
        compact = compact[1:-1]

    parts = [part.strip() for part in re.split(r"[\s,]+", compact) if part.strip()]
    if not parts:
        raise ValueError("索引列表不能为空。")
    return [_coerce_index(part) for part in parts]


def _length(value: Any) -> int | None:
    try:
        return len(value)
    except Exception:
        return None


def _resolve_index(index: int, size: int) -> int:
    resolved = index if index >= 0 else size + index
    if resolved < 0 or resolved >= size:
        raise IndexError(f"索引 {index} 超出范围，当前长度为 {size}。")
    return resolved


def _is_tensor_like(value: Any) -> bool:
    shape = getattr(value, "shape", None)
    return shape is not None and hasattr(value, "__getitem__")


def _slice_tensor_like(value: Any, indices: list[int]) -> Any:
    size = int(value.shape[0])
    resolved = [_resolve_index(index, size) for index in indices]
    if len(resolved) == 1:
        start = resolved[0]
        return value[start : start + 1]
    try:
        return value[resolved]
    except Exception:
        return value[[int(item) for item in resolved]]


def _select_latent(latent: dict[str, Any], indices: list[int]) -> dict[str, Any]:
    samples = latent.get("samples")
    if not _is_tensor_like(samples):
        return _select_mapping(latent, indices)

    result = dict(latent)
    result["samples"] = _slice_tensor_like(samples, indices)

    batch_index = latent.get("batch_index")
    if isinstance(batch_index, (list, tuple)):
        result["batch_index"] = [_take_sequence(batch_index, index) for index in indices]
    elif _is_tensor_like(batch_index):
        result["batch_index"] = _slice_tensor_like(batch_index, indices)

    noise_mask = latent.get("noise_mask")
    if _is_tensor_like(noise_mask):
        try:
            result["noise_mask"] = _slice_tensor_like(noise_mask, indices)
        except Exception:
            pass
    return result


def _take_sequence(value: Any, index: int) -> Any:
    size = _length(value)
    if size is None:
        if index in (0, -1):
            return value
        raise IndexError("普通对象只能使用索引 0。")
    return value[_resolve_index(index, size)]


def _select_mapping(value: dict[Any, Any], indices: list[int]) -> Any:
    keys = list(value.keys())
    selected_keys = [_take_sequence(keys, index) for index in indices]
    if len(selected_keys) == 1:
        return value[selected_keys[0]]
    return {key: value[key] for key in selected_keys}


def _select_any(value: Any, indices: list[int]) -> Any:
    if isinstance(value, dict) and "samples" in value:
        return _select_latent(value, indices)
    if _is_tensor_like(value):
        return _slice_tensor_like(value, indices)
    if isinstance(value, tuple):
        selected = tuple(_take_sequence(value, index) for index in indices)
        return selected[0] if len(selected) == 1 else selected
    if isinstance(value, list):
        selected = [_take_sequence(value, index) for index in indices]
        return selected[0] if len(selected) == 1 else selected
    if isinstance(value, dict):
        return _select_mapping(value, indices)
    if len(indices) == 1 and indices[0] in (0, -1):
        return value
    raise IndexError("普通单个对象只能使用索引 0。")


class GJJ_AnyIndexOutput:
    CATEGORY = "GJJ/🔀 逻辑与流程/索引"
    FUNCTION = "index_output"
    DESCRIPTION = INDEX_HELP_DESCRIPTION
    SEARCH_ALIASES = ["any index", "index output", "任意索引", "对象索引", "索引输出", "列表索引"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("索引结果",)
    OUTPUT_TOOLTIPS = ("按索引取出的结果；Tensor/IMAGE/MASK/LATENT 会尽量保留原批对象形态。",)
    GJJ_HELP = {
        "title": "GJJ · 🔎 任意对象索引输出",
        "description": INDEX_HELP_DESCRIPTION,
        "features": [
            {
                "name": "🎯 0 基索引",
                "description": "0 表示第 1 项，1 表示第 2 项；和 Python / ComfyUI 批次索引一致。",
            },
            {
                "name": "🧺 多索引选择",
                "description": "支持 1,3、[1,3]、(1,3)、1 3、中文逗号和多行输入；输出顺序跟填写顺序一致。",
            },
            {
                "name": "↩️ 负数索引",
                "description": "-1 是最后一项，-2 是倒数第二项，可与正数混用，例如 0,-1。",
            },
            {
                "name": "🖼️ 批对象保持批形态",
                "description": "IMAGE、MASK、Tensor 和 LATENT 会按第 0 维裁剪，单个索引也尽量保留批维度。",
            },
        ],
        "inputs": {
            "任意对象": {
                "type": "*",
                "description": "要取索引的数据。支持 list、tuple、dict、Tensor、IMAGE、MASK、LATENT 和普通对象。",
            },
            "索引": {
                "type": "STRING",
                "description": "0 基索引表达式。常用写法：0、1,3、[1,3]、-1、0,-1。小数只有 .0 结尾才允许。",
            },
        },
        "outputs": {
            "索引结果": {
                "type": "*",
                "description": "按索引取出的数据。输出类型随输入对象和索引数量变化。",
            },
        },
        "usage_examples": [
            {
                "title": "📌 单个列表项",
                "description": "[A,B,C,D] + 1 -> B；单个索引会直接输出元素本身。",
            },
            {
                "title": "📌 多个列表项",
                "description": "[A,B,C,D] + 1,3 -> [B,D]；多个索引会输出 list。",
            },
            {
                "title": "📌 负数索引",
                "description": "[A,B,C,D] + -1 -> D；[A,B,C,D] + 0,-1 -> [A,D]。",
            },
            {
                "title": "📌 Tensor / IMAGE 批",
                "description": "4 张 IMAGE + 1 -> 1 张 IMAGE 批；4 张 IMAGE + 1,3 -> 2 张 IMAGE 批。",
            },
            {
                "title": "📌 字典按顺序取",
                "description": '{"a":10,"b":20,"c":30} + 1 -> 20；0,2 -> {"a":10,"c":30}。',
            },
            {
                "title": "📌 小数索引",
                "description": "1.0 和 [1.0] 都会按索引 1 处理；1.3 或 [1.3] 会报错，不会自动取整。",
            },
        ],
        "technical_notes": [
            "索引是 0 基，不是 1 基。",
            "字典使用 Python 字典的插入顺序。",
            "不支持 1:3 这种切片语法，需要手动写成 1,2。",
            "普通单个对象只支持 0 或 -1 作为原样透传。",
        ],
        "troubleshooting": [
            {
                "problem": "填 [1.3] 报错",
                "solution": "这是预期行为。索引必须是整数；请改成 1、1.0 或 [1]。",
            },
            {
                "problem": "负数索引越界",
                "solution": "负数会从末尾倒数。长度为 4 时，-1 到 -4 有效，-5 越界。",
            },
            {
                "problem": "输出不是列表",
                "solution": "单个索引会输出单项；需要列表形态时填写多个索引，例如 1,1 或 1,2。",
            },
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "any": (
                    any_type,
                    {
                        "display_name": "任意对象",
                        "tooltip": "需要取索引的对象。支持列表、元组、字典、Tensor 批、IMAGE/MASK 批和 LATENT。",
                    },
                ),
                "index": (
                    "STRING",
                    {
                        "default": "0",
                        "multiline": False,
                        "display_name": "索引",
                        "tooltip": "0 基索引；支持 0、1,3、[1,3]、0，3、-1。1.0 可用，[1.3] 这类非整数会报错。",
                    },
                ),
            }
        }

    def index_output(self, any, index):
        indices = _parse_indices(index)
        return (_select_any(any, indices),)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AnyIndexOutput}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔎 任意对象索引输出"}
