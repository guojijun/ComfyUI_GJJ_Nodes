from __future__ import annotations

from typing import Any


NODE_NAME = "GJJ_AnyQueueReverse"


class AnyType(str):
    """始终可兼容任意类型的占位类型。"""

    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _is_tensor_like(value: Any) -> bool:
    shape = getattr(value, "shape", None)
    return shape is not None and hasattr(value, "__getitem__")


def _reverse_tensor_like(value: Any) -> Any:
    try:
        if int(value.shape[0]) <= 0:
            return value
    except Exception:
        return value

    flip = getattr(value, "flip", None)
    if callable(flip):
        for args in ((0,),):
            try:
                result = flip(*args)
                contiguous = getattr(result, "contiguous", None)
                return contiguous() if callable(contiguous) else result
            except Exception:
                pass
        try:
            result = flip(dims=[0])
            contiguous = getattr(result, "contiguous", None)
            return contiguous() if callable(contiguous) else result
        except Exception:
            pass

    try:
        indices = list(range(int(value.shape[0]) - 1, -1, -1))
        result = value[indices]
        contiguous = getattr(result, "contiguous", None)
        return contiguous() if callable(contiguous) else result
    except Exception:
        return value


def _reverse_latent(value: dict[Any, Any]) -> dict[Any, Any]:
    result = dict(value)
    samples = value.get("samples")
    if _is_tensor_like(samples):
        result["samples"] = _reverse_tensor_like(samples)

    batch_index = value.get("batch_index")
    if isinstance(batch_index, list):
        result["batch_index"] = list(reversed(batch_index))
    elif isinstance(batch_index, tuple):
        result["batch_index"] = tuple(reversed(batch_index))
    elif _is_tensor_like(batch_index):
        result["batch_index"] = _reverse_tensor_like(batch_index)

    noise_mask = value.get("noise_mask")
    if _is_tensor_like(noise_mask):
        result["noise_mask"] = _reverse_tensor_like(noise_mask)
    return result


def _reverse_any(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, dict) and "samples" in value:
        return _reverse_latent(value)
    if _is_tensor_like(value):
        return _reverse_tensor_like(value)
    if isinstance(value, list):
        return list(reversed(value))
    if isinstance(value, tuple):
        return tuple(reversed(value))
    if isinstance(value, dict):
        return {key: value[key] for key in reversed(list(value.keys()))}

    try:
        return value[::-1]
    except Exception:
        return value


class GJJ_AnyQueueReverse:
    CATEGORY = "GJJ/列表工具"
    FUNCTION = "reverse"
    DESCRIPTION = "零依赖反转任意队列：列表 1,2,3,4 输出 4,3,2,1；IMAGE/MASK/Tensor 视频帧批次按第 0 维倒序。"
    SEARCH_ALIASES = ["reverse queue", "reverse list", "反转队列", "倒序队列", "视频倒放"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("反转队列",)
    OUTPUT_TOOLTIPS = ("倒序后的对象；列表/元组/字典会反转顺序，IMAGE/MASK/Tensor/LATENT 会按批次维度反转。",)

    GJJ_HELP = {
        "title": "GJJ · 🔁 反转任意队列",
        "description": DESCRIPTION,
        "usage": [
            "输入 [1,2,3,4]，输出 [4,3,2,1]。",
            "输入视频帧 IMAGE batch 时，会把帧顺序倒过来，输出仍是 IMAGE batch。",
            "输入 LATENT 时，会反转 samples，并尽量同步 batch_index / noise_mask。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "queue": (
                    any_type,
                    {
                        "forceInput": True,
                        "display_name": "任意队列",
                        "tooltip": "需要反转的队列。支持列表、元组、字典、IMAGE/MASK/Tensor 批、LATENT；普通对象会原样透传。",
                    },
                ),
            }
        }

    def reverse(self, queue):
        return (_reverse_any(queue),)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AnyQueueReverse}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔁 反转任意队列"}
