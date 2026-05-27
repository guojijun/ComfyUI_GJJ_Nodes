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
    CATEGORY = "GJJ"
    FUNCTION = "index_output"
    DESCRIPTION = "按 0 基索引从任意对象、列表、Tensor 批或 Latent 中取出单项或多项，索引支持 0、0,1,3、[0,1,3]、0，3 等格式。"
    SEARCH_ALIASES = ["any index", "index output", "任意索引", "对象索引", "索引输出", "列表索引"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("索引结果",)
    OUTPUT_TOOLTIPS = ("按索引取出的结果；Tensor/IMAGE/MASK/LATENT 会尽量保留原批对象形态。",)

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
                        "tooltip": "0 基索引；支持 0、0,1,3、[0,1,3]、0，3，也支持负数索引。",
                    },
                ),
            }
        }

    def index_output(self, any, index):
        indices = _parse_indices(index)
        return (_select_any(any, indices),)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AnyIndexOutput}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔎 任意对象索引输出"}
