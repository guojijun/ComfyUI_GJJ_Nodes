from __future__ import annotations

from typing import Any

import comfy.utils
import torch


NODE_NAME = "GJJ_batchAnything"


class AnyType(str):
    """始终可兼容任意类型的占位类型。"""

    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


class FlexibleOptionalInputType(dict):
    """允许节点接收动态数量与动态类型的可选输入。"""

    def __init__(self, input_type):
        super().__init__()
        self.input_type = input_type

    def __getitem__(self, key):
        return (
            self.input_type,
            {
                "display_name": _display_name_for_input(key),
                "tooltip": "动态任意输入；连接最后一个输入口后会自动新增下一路。",
            },
        )

    def __contains__(self, key):
        return True


def _input_index(name: str) -> int:
    text = str(name or "")
    if not text.startswith("any_"):
        return 999999
    digits = text[4:]
    try:
        return int(digits)
    except Exception:
        return 999999


def _display_name_for_input(name: str) -> str:
    index = _input_index(name)
    if index == 999999:
        return "任意输入"
    return f"任意输入 {index}"


class GJJBatchAnything:
    CATEGORY = "GJJ/逻辑"
    FUNCTION = "batch"
    DESCRIPTION = "零依赖复刻 easy batchAnything：把多路输入合成一个批量/拼接结果；IMAGE 和 LATENT 会拼 batch，普通对象按原类型逻辑合并。"
    SEARCH_ALIASES = ["easy batchAnything", "batch anything", "batch any", "任意合并", "任意批量"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("批量/拼接结果（单对象）",)
    OUTPUT_TOOLTIPS = ("合并后的单个对象输出；图片会按第一路尺寸对齐后拼接 batch，latent 会对齐 samples 后拼接，不是 ComfyUI 列表口。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": FlexibleOptionalInputType(any_type),
        }

    @staticmethod
    def _ordered_values(kwargs: dict[str, Any]) -> list[Any]:
        values = []
        for key in sorted(kwargs.keys(), key=_input_index):
            if not str(key).startswith("any_"):
                continue
            value = kwargs.get(key)
            if value is not None:
                values.append(value)
        return values

    @staticmethod
    def _merge_plain(any_1: Any, any_2: Any):
        if isinstance(any_1, (str, float, int)):
            if any_2 is None:
                return any_1
            if isinstance(any_2, tuple):
                return any_2 + (any_1,)
            if isinstance(any_2, list):
                return any_2 + [any_1]
            return [any_1, any_2]

        if isinstance(any_2, (str, float, int)):
            if any_1 is None:
                return any_2
            if isinstance(any_1, tuple):
                return any_1 + (any_2,)
            if isinstance(any_1, list):
                return any_1 + [any_2]
            return [any_2, any_1]

        if any_1 is None:
            return any_2
        if any_2 is None:
            return any_1
        return any_1 + any_2

    @classmethod
    def LEGACY_INPUT_TYPES(cls):
        return {
            "required": {
                "any_01": (
                    any_type,
                    {
                        "display_name": "任意输入 1",
                        "tooltip": "第一路任意类型输入。图片或 latent 合并时会作为目标尺寸参考。",
                    },
                ),
            }
        }

    def latent_batch(self, any_1: dict[str, Any], any_2: dict[str, Any]) -> dict[str, Any]:
        samples_out = any_1.copy()
        s1 = any_1["samples"]
        s2 = any_2["samples"]

        if s1.shape[1:] != s2.shape[1:]:
            s2 = comfy.utils.common_upscale(s2, s1.shape[3], s1.shape[2], "bilinear", "center")
        samples_out["samples"] = torch.cat((s1, s2), dim=0)
        samples_out["batch_index"] = any_1.get("batch_index", [x for x in range(0, s1.shape[0])]) + any_2.get(
            "batch_index", [x for x in range(0, s2.shape[0])]
        )
        return samples_out

    def merge_two(self, any_1: Any, any_2: Any):
        if isinstance(any_1, torch.Tensor) or isinstance(any_2, torch.Tensor):
            if any_1 is None:
                return any_2
            if any_2 is None:
                return any_1
            if any_1.shape[1:] != any_2.shape[1:]:
                any_2 = comfy.utils.common_upscale(
                    any_2.movedim(-1, 1),
                    any_1.shape[2],
                    any_1.shape[1],
                    "bilinear",
                    "center",
                ).movedim(1, -1)
            return torch.cat((any_1, any_2), 0)

        if isinstance(any_1, dict) and "samples" in any_1:
            if any_2 is None:
                return any_1
            if isinstance(any_2, dict) and "samples" in any_2:
                return self.latent_batch(any_1, any_2)

        if isinstance(any_2, dict) and "samples" in any_2:
            if any_1 is None:
                return any_2
            if isinstance(any_1, dict) and "samples" in any_1:
                return self.latent_batch(any_2, any_1)

        return self._merge_plain(any_1, any_2)

    def batch(self, **kwargs):
        values = self._ordered_values(kwargs)
        if not values:
            return (None,)

        result = values[0]
        for value in values[1:]:
            result = self.merge_two(result, value)
        return (result,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJBatchAnything}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📦 任意批量合并（输出单对象）"}
