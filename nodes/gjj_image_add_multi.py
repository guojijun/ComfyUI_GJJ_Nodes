from __future__ import annotations

from typing import Any

import torch


NODE_NAME = "GJJ_ImageAddMulti"
IMAGE_TYPE = "IMAGE"


class FlexibleImageInputs(dict):
    """允许前端动态添加 image_3、image_4 ... 输入。"""

    def __getitem__(self, key):
        return (IMAGE_TYPE,)

    def __contains__(self, key):
        return True


def _to_int(value: Any, default: int = 2) -> int:
    try:
        if isinstance(value, (list, tuple)) and len(value) == 1:
            value = value[0]
        return int(float(value))
    except Exception:
        return default


def _to_float(value: Any, default: float = 0.5) -> float:
    try:
        if isinstance(value, (list, tuple)) and len(value) == 1:
            value = value[0]
        return float(value)
    except Exception:
        return default


def _check_image(name: str, value: Any) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise RuntimeError(f"{name} 未连接 IMAGE。")
    if value.ndim != 4:
        raise RuntimeError(f"{name} 格式不正确，应为 ComfyUI IMAGE：BHWC 张量。")
    return value


class GJJ_ImageAddMulti:
    CATEGORY = "GJJ/图像"
    FUNCTION = "add"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    OUTPUT_TOOLTIPS = ("多张 IMAGE 按指定混合方式逐张合成后的结果。",)
    DESCRIPTION = "复刻 KJNodes 的 Image Add Multi：按输入数量把多张 IMAGE 逐张 add/subtract/multiply/difference 混合。"
    SEARCH_ALIASES = [
        "Image Add Multi",
        "image add",
        "multi image blend",
        "多图相加",
        "多图混合",
        "图片混合",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "inputcount": (
                    "INT",
                    {
                        "default": 2,
                        "min": 2,
                        "max": 1000,
                        "step": 1,
                        "display_name": "输入数量",
                        "tooltip": "需要混合的 IMAGE 输入数量；前端会自动显示 image_1 到 image_N。",
                    },
                ),
                "image_1": (
                    "IMAGE",
                    {
                        "display_name": "图像 1",
                        "tooltip": "第一张图像，作为逐步混合的起点。",
                    },
                ),
                "image_2": (
                    "IMAGE",
                    {
                        "display_name": "图像 2",
                        "tooltip": "第二张图像。",
                    },
                ),
                "blending": (
                    ["add", "subtract", "multiply", "difference"],
                    {
                        "default": "add",
                        "display_name": "混合方式",
                        "tooltip": "add 相加、subtract 相减、multiply 相乘、difference 差值。保持 KJ 原节点算法。",
                    },
                ),
                "blend_amount": (
                    "FLOAT",
                    {
                        "default": 0.5,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "混合强度",
                        "tooltip": "add/subtract/multiply 会把当前图和新图都乘以此强度后再运算；difference 不使用该参数。",
                    },
                ),
            },
            "optional": FlexibleImageInputs(),
        }

    def add(
        self,
        inputcount=2,
        image_1=None,
        image_2=None,
        blending="add",
        blend_amount=0.5,
        **kwargs,
    ):
        count = max(2, min(1000, _to_int(inputcount, 2)))
        amount = max(0.0, min(1.0, _to_float(blend_amount, 0.5)))
        mode = str(blending or "add")
        if mode not in {"add", "subtract", "multiply", "difference"}:
            mode = "add"

        images: list[torch.Tensor] = [
            _check_image("图像 1", image_1),
            _check_image("图像 2", image_2),
        ]
        for index in range(3, count + 1):
            key = f"image_{index}"
            images.append(_check_image(f"图像 {index}", kwargs.get(key)))

        result = images[0]
        for index, new_image in enumerate(images[1:], start=2):
            if tuple(result.shape) != tuple(new_image.shape):
                raise RuntimeError(
                    f"图像 {index} 尺寸与图像 1 不一致："
                    f"{tuple(new_image.shape)} vs {tuple(result.shape)}。请先缩放到相同尺寸和批次数。"
                )
            if mode == "add":
                result = torch.add(result * amount, new_image * amount)
            elif mode == "subtract":
                result = torch.sub(result * amount, new_image * amount)
            elif mode == "multiply":
                result = torch.mul(result * amount, new_image * amount)
            elif mode == "difference":
                result = torch.sub(result, new_image)

        return (result,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageAddMulti}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ➕ 多图混合相加"}
