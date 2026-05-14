from __future__ import annotations

import math
import logging
from typing import Any, List, Tuple

import numpy as np
import torch

from PIL import ImageColor

from nodes import MAX_RESOLUTION
from comfy.utils import common_upscale
from comfy import model_management

NODE_NAME = "GJJ_ImageResizeKJv2"


# -----------------------------
# 通用工具
# -----------------------------


def string_to_color(color_string: str) -> List[int]:
    color_list = [0, 0, 0]
    color_string = str(color_string or "#000000").strip()

    if "," in color_string:
        try:
            values = [float(channel.strip()) for channel in color_string.split(",")]
            if all(0 <= v <= 1 for v in values):
                color_list = [int(v * 255) for v in values]
            else:
                color_list = [int(v) for v in values]
        except ValueError:
            logging.warning(f"无效的颜色格式: {color_string}，使用默认黑色。")
    elif color_string.startswith("#") or (
        color_string.lstrip("#").isalnum()
        and not color_string.lstrip("#").replace(".", "", 1).isdigit()
    ):
        color_string_stripped = color_string.lstrip("#")
        if len(color_string_stripped) in [6, 8] and all(
            c in "0123456789ABCDEFabcdef" for c in color_string_stripped
        ):
            color_list = [int(color_string_stripped[i : i + 2], 16) for i in (0, 2, 4)]
        else:
            try:
                rgb = ImageColor.getrgb(color_string)
                color_list = list(rgb[:3])
            except ValueError:
                logging.warning(
                    f"无效的颜色名称或十六进制格式: {color_string}，使用默认黑色。"
                )
    else:
        try:
            value = float(color_string.strip())
            value = int(value * 255) if 0 <= value <= 1 else int(value)
            color_list = [value, value, value]
        except ValueError:
            logging.warning(f"无效的颜色格式: {color_string}，使用默认黑色。")

    return np.clip(color_list[:3], 0, 255).tolist()


def _round_to_multiple(value: float | int, multiple: int) -> int:
    value = max(1, int(round(float(value))))
    multiple = int(multiple or 0)
    if multiple <= 1:
        return value
    return max(multiple, int(math.ceil(value / multiple) * multiple))


def _safe_int(value, default: int = 1) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _get_aspect_ratio(
    aspect_ratio: str, custom_w: int, custom_h: int, orig_w: int, orig_h: int
) -> float:
    if aspect_ratio in ("原始比例", "original"):
        return orig_w / max(1, orig_h)
    if aspect_ratio in ("自定义", "custom"):
        return max(1, custom_w) / max(1, custom_h)
    if ":" in str(aspect_ratio):
        try:
            a, b = str(aspect_ratio).split(":", 1)
            return max(1.0, float(a)) / max(1.0, float(b))
        except Exception:
            pass
    return orig_w / max(1, orig_h)


def _normalize_mask(
    mask: torch.Tensor | None, batch: int, height: int, width: int, device: torch.device
) -> torch.Tensor | None:
    if mask is None:
        return None
    if mask.dim() == 2:
        mask = mask.unsqueeze(0)
    if mask.dim() == 4:
        if mask.shape[1] == 1:
            mask = mask.squeeze(1)
        else:
            mask = mask[..., 0]
    if mask.shape[0] == 1 and batch > 1:
        mask = mask.repeat(batch, 1, 1)
    if mask.shape[0] != batch:
        mask = mask[:1].repeat(batch, 1, 1)
    if mask.shape[-2:] == (64, 64) and (height != 64 or width != 64):
        return None
    mask = mask.to(device)
    if mask.shape[-2:] != (height, width):
        mask = common_upscale(
            mask.unsqueeze(1), width, height, "bilinear", crop="disabled"
        ).squeeze(1)
    return mask


def _resize_image_tensor(
    image: torch.Tensor, width: int, height: int, method: str
) -> torch.Tensor:
    return common_upscale(
        image.movedim(-1, 1), width, height, method, crop="disabled"
    ).movedim(1, -1)


def _resize_mask_tensor(
    mask: torch.Tensor, width: int, height: int, method: str
) -> torch.Tensor:
    if method == "lanczos":
        return common_upscale(
            mask.unsqueeze(1).repeat(1, 3, 1, 1), width, height, method, crop="disabled"
        ).movedim(1, -1)[:, :, :, 0]
    return common_upscale(
        mask.unsqueeze(1), width, height, method, crop="disabled"
    ).squeeze(1)


def _empty_mask(batch: int, height: int, width: int, dtype, device) -> torch.Tensor:
    return torch.zeros((batch, height, width), dtype=dtype, device=device)


def _pad_to_target(
    image: torch.Tensor,
    mask: torch.Tensor | None,
    target_width: int,
    target_height: int,
    color: str,
) -> Tuple[torch.Tensor, torch.Tensor]:
    b, h, w, c = image.shape
    color_list = string_to_color(color)
    bg_color = torch.tensor(
        [x / 255.0 for x in color_list], dtype=image.dtype, device=image.device
    )
    if c > 3:
        bg_color = torch.cat(
            [bg_color, torch.ones((c - 3,), dtype=image.dtype, device=image.device)],
            dim=0,
        )
    elif c < 3:
        bg_color = bg_color[:c]

    pad_left = max(0, (target_width - w) // 2)
    pad_top = max(0, (target_height - h) // 2)

    out_image = torch.zeros(
        (b, target_height, target_width, c), dtype=image.dtype, device=image.device
    )
    out_image[:, :, :, :] = bg_color.view(1, 1, 1, c)
    out_image[:, pad_top : pad_top + h, pad_left : pad_left + w, :] = image

    if mask is None:
        out_mask = torch.ones(
            (b, target_height, target_width), dtype=image.dtype, device=image.device
        )
        out_mask[:, pad_top : pad_top + h, pad_left : pad_left + w] = 0.0
    else:
        out_mask = torch.ones(
            (b, target_height, target_width), dtype=mask.dtype, device=mask.device
        )
        out_mask[:, pad_top : pad_top + h, pad_left : pad_left + w] = mask
    return out_image, out_mask


def _crop_center_to_target(
    image: torch.Tensor,
    mask: torch.Tensor | None,
    target_width: int,
    target_height: int,
):
    _, h, w, _ = image.shape
    x = max(0, (w - target_width) // 2)
    y = max(0, (h - target_height) // 2)
    image = image[:, y : y + target_height, x : x + target_width, :]
    if mask is not None:
        mask = mask[:, y : y + target_height, x : x + target_width]
    return image, mask


def _apply_fit(
    image: torch.Tensor,
    mask: torch.Tensor | None,
    target_width: int,
    target_height: int,
    fit_mode: str,
    upscale_method: str,
    pad_color: str,
):
    b, h, w, _ = image.shape

    if fit_mode == "stretch":
        out_image = _resize_image_tensor(
            image, target_width, target_height, upscale_method
        )
        out_mask = (
            _resize_mask_tensor(mask, target_width, target_height, upscale_method)
            if mask is not None
            else _empty_mask(b, target_height, target_width, image.dtype, image.device)
        )
        return out_image, out_mask

    scale = (
        min(target_width / max(1, w), target_height / max(1, h))
        if fit_mode == "letterbox"
        else max(target_width / max(1, w), target_height / max(1, h))
    )
    resize_w = max(1, int(round(w * scale)))
    resize_h = max(1, int(round(h * scale)))

    resized_image = _resize_image_tensor(image, resize_w, resize_h, upscale_method)
    resized_mask = (
        _resize_mask_tensor(mask, resize_w, resize_h, upscale_method)
        if mask is not None
        else None
    )

    if fit_mode == "letterbox":
        return _pad_to_target(
            resized_image, resized_mask, target_width, target_height, pad_color
        )

    cropped_image, cropped_mask = _crop_center_to_target(
        resized_image, resized_mask, target_width, target_height
    )
    if cropped_mask is None:
        cropped_mask = _empty_mask(
            b, target_height, target_width, image.dtype, image.device
        )
    return cropped_image, cropped_mask


def _tensor_to_bhwc(image: torch.Tensor) -> torch.Tensor:
    """把单张 HWC 或批量 BHWC 统一成 BHWC。"""
    if not isinstance(image, torch.Tensor):
        raise TypeError(f"图片数据不是 torch.Tensor: {type(image)}")
    if image.dim() == 3:
        return image.unsqueeze(0)
    if image.dim() == 4:
        return image
    raise ValueError(f"不支持的图片维度: {tuple(image.shape)}，需要 HWC 或 BHWC。")


def _looks_like_image_tensor(value: Any) -> bool:
    return isinstance(value, torch.Tensor) and value.dim() in (3, 4)


def _extract_tensor_from_item(item: Any) -> torch.Tensor | None:
    """兼容常见 GJJ_BATCH_IMAGE 结构：Tensor、dict[image/images/tensor]、对象.image。"""
    if _looks_like_image_tensor(item):
        return item
    if isinstance(item, dict):
        for key in ("image", "images", "tensor", "IMAGE"):
            value = item.get(key)
            if _looks_like_image_tensor(value):
                return value
        # 有些批量结构会把图片放在嵌套 value 中，这里做一层轻量兜底。
        for value in item.values():
            if _looks_like_image_tensor(value):
                return value
    for attr in ("image", "images", "tensor"):
        value = getattr(item, attr, None)
        if _looks_like_image_tensor(value):
            return value
    return None


def _is_multi_image_container(image: Any) -> bool:
    if _looks_like_image_tensor(image):
        return False
    if isinstance(image, (list, tuple)):
        return True
    if isinstance(image, dict):
        for key in ("images", "image", "items", "batch"):
            value = image.get(key)
            if isinstance(value, (list, tuple)):
                return True
    return False


def _iter_batch_images(image: Any) -> List[Any]:
    """把 GJJ_BATCH_IMAGE 拆成逐张/逐项处理列表。"""
    if isinstance(image, dict):
        for key in ("images", "items", "batch"):
            value = image.get(key)
            if isinstance(value, (list, tuple)):
                return list(value)
        value = image.get("image")
        if isinstance(value, (list, tuple)):
            return list(value)
    if isinstance(image, (list, tuple)):
        return list(image)
    return [image]


def _replace_item_image(item: Any, new_image: torch.Tensor) -> Any:
    """批处理输出时尽量保持原 GJJ_BATCH_IMAGE 的条目结构；无法识别时直接输出图片 Tensor。"""
    if isinstance(item, dict):
        out = dict(item)
        for key in ("image", "images", "tensor", "IMAGE"):
            if key in out and _looks_like_image_tensor(out[key]):
                out[key] = new_image
                return out
        out["image"] = new_image
        return out
    return new_image


def _select_mask_for_item(mask: torch.Tensor | None, index: int) -> torch.Tensor | None:
    if mask is None or not isinstance(mask, torch.Tensor):
        return None
    if mask.dim() == 2:
        return mask.unsqueeze(0)
    if mask.dim() == 3:
        if mask.shape[0] == 1:
            return mask
        if index < mask.shape[0]:
            return mask[index : index + 1]
        return mask[:1]
    if mask.dim() == 4:
        if mask.shape[0] == 1:
            return mask
        if index < mask.shape[0]:
            return mask[index : index + 1]
        return mask[:1]
    return None


class GJJ_ImageResizeKJv2:
    resize_mode_map = {
        "宽高": "fixed",
        "固定宽高": "fixed",
        "等比": "proportional",
        "等比缩放": "proportional",
        "长边": "long_side",
        "长边适配": "long_side",
        "像素": "pixel_control",
        "像素控制": "pixel_control",
    }
    upscale_method_map = {
        "最近邻": "nearest-exact",
        "双线性": "bilinear",
        "区域": "area",
        "双三次": "bicubic",
        "兰索斯": "lanczos",
        "nearest": "nearest-exact",
        "bilinear": "bilinear",
        "box": "area",
        "bicubic": "bicubic",
        "hamming": "bicubic",
        "lanczos": "lanczos",
    }
    fit_mode_map = {
        "拉伸": "stretch",
        "留边填充": "letterbox",
        "裁剪填满": "crop",
        "stretch": "stretch",
        "letterbox": "letterbox",
        "crop": "crop",
        "fill": "stretch",
    }
    aspect_ratio_list = [
        "原始比例",
        "自定义",
        "1:1",
        "3:2",
        "4:3",
        "16:9",
        "2:3",
        "3:4",
        "9:16",
    ]
    multiple_list = ["无", "8", "16", "32", "64", "128", "256", "512"]
    device_map = {"CPU": "cpu", "GPU": "gpu"}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "GJJ_BATCH_IMAGE,IMAGE",
                    {
                        "display_name": "🖼️ 图片",
                        "tooltip": "输入图片。支持普通 IMAGE，也支持 GJJ_BATCH_IMAGE 多图列表；检测到多图会自动逐张批处理，并输出处理后的图片列表。",
                    },
                ),
                "resize_mode": (
                    ["宽高", "等比", "长边", "像素"],
                    {
                        "default": "宽高",
                        "display_name": "缩放模式",
                        "tooltip": "选择缩放计算方式。前端会显示为按钮：宽高、等比、长边、像素。",
                    },
                ),
                # 宽高
                "width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 1,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "📐 目标宽度",
                        "tooltip": "宽高模式使用。设置最终输出图片的宽度，单位为像素。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 1,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "📐 目标高度",
                        "tooltip": "宽高模式使用。设置最终输出图片的高度，单位为像素。",
                    },
                ),
                # 等比
                "scale_percent": (
                    "FLOAT",
                    {
                        "default": 100.0,
                        "min": 1.0,
                        "max": 10000.0,
                        "step": 1.0,
                        "display_name": "🔍 缩放百分比",
                        "tooltip": "等比模式使用。100 表示原尺寸，50 表示缩小一半，200 表示放大两倍。",
                    },
                ),
                # 长边
                "long_side_length": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 4,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "📏 长边长度",
                        "tooltip": "长边模式使用。把图片较长的一边缩放到此长度，另一边按原比例自动计算。",
                    },
                ),
                # 像素，总像素逻辑：target_width * target_height ≈ total_pixel_k * 1000
                "total_pixel_k": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 1,
                        "max": 1000000,
                        "step": 1,
                        "display_name": "🔢 总像素/K",
                        "tooltip": "像素模式使用。按总像素数量计算输出尺寸，单位为千像素。例如 1024 表示约 102.4 万像素。",
                    },
                ),
                "aspect_ratio": (
                    cls.aspect_ratio_list,
                    {
                        "default": "原始比例",
                        "display_name": "🧩 输出比例",
                        "tooltip": "像素模式使用。决定总像素如何分配成宽高。选择原始比例会沿用输入图片比例；选择自定义会显示自定义比例宽和高。",
                    },
                ),
                "proportional_width": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 100000000,
                        "step": 1,
                        "display_name": "↔️ 自定义比例宽",
                        "tooltip": "像素模式且输出比例为自定义时使用。与自定义比例高共同决定宽高比例。",
                    },
                ),
                "proportional_height": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 100000000,
                        "step": 1,
                        "display_name": "↕️ 自定义比例高",
                        "tooltip": "像素模式且输出比例为自定义时使用。与自定义比例宽共同决定宽高比例。",
                    },
                ),
                # 公共参数，放在最后，前端按模式重排/隐藏
                "fit_mode": (
                    ["拉伸", "留边填充", "裁剪填满"],
                    {
                        "default": "拉伸",
                        "display_name": "🧲 适配方式",
                        "tooltip": "宽高和像素模式使用。拉伸会直接变成目标宽高；留边填充会保持比例并补边；裁剪填满会保持比例并居中裁剪。",
                    },
                ),
                "upscale_method": (
                    ["最近邻", "双线性", "区域", "双三次", "兰索斯"],
                    {
                        "default": "兰索斯",
                        "display_name": "🔄 缩放算法",
                        "tooltip": "图片缩放采样算法。兰索斯质量较高但只支持 CPU；GPU 模式请使用最近邻、双线性、区域或双三次。",
                    },
                ),
                "round_to_multiple": (
                    cls.multiple_list,
                    {
                        "default": "8",
                        "display_name": "🔢 尺寸对齐",
                        "tooltip": "把输出宽高向上对齐到指定倍数。常用于确保尺寸能被 8、16、32、64 等整除。选择无则不额外对齐。",
                    },
                ),
                "pad_color": (
                    "COLOR",
                    {
                        "default": "#000000",
                        "display_name": "🎨 留边颜色",
                        "tooltip": "留边填充时使用的背景颜色。支持颜色选择器、十六进制颜色和常见颜色名称。",
                    },
                ),
                "device": (
                    ["CPU", "GPU"],
                    {
                        "default": "CPU",
                        "display_name": "⚙️ 计算设备",
                        "tooltip": "选择缩放计算设备。兰索斯不支持 GPU，如果选择 GPU 请改用其它缩放算法。",
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {
                        "display_name": "🎭 遮罩",
                        "tooltip": "可选输入。连接后会随图片同步缩放、填充或裁剪。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE", "MASK", "BOX", "INT", "INT")
    RETURN_NAMES = ("图片", "遮罩", "原始尺寸", "宽度", "高度")
    FUNCTION = "resize"
    CATEGORY = "GJJ/image"
    DESCRIPTION = """
图片缩放 KJv2：合并 ImageScaleByAspectRatio V2 的比例、适配、长边、总像素控制能力。

模式：
• 宽高：直接指定输出宽高，可拉伸、留边、裁剪。
• 等比：按百分比缩放，保持原图比例。
• 长边：指定长边长度，短边自动计算。
• 像素：按总像素/K + 输出比例计算尺寸。

输出：图片、遮罩、原始尺寸、输出宽度、输出高度。
"""

    def _resize_tensor(
        self,
        image,
        resize_mode,
        width,
        height,
        scale_percent,
        long_side_length,
        total_pixel_k,
        aspect_ratio,
        proportional_width,
        proportional_height,
        fit_mode,
        upscale_method,
        round_to_multiple,
        pad_color,
        device,
        mask=None,
    ):
        resize_mode = self.resize_mode_map.get(resize_mode, resize_mode)
        upscale_method = self.upscale_method_map.get(upscale_method, upscale_method)
        fit_mode = self.fit_mode_map.get(fit_mode, fit_mode)
        device = self.device_map.get(device, device)

        image = _tensor_to_bhwc(image)
        b, orig_h, orig_w, _ = image.shape
        original_size = [int(orig_w), int(orig_h)]

        if device == "gpu":
            if upscale_method == "lanczos":
                raise Exception("兰索斯不支持 GPU，请改用 CPU 或换成双三次/双线性。")
            torch_device = model_management.get_torch_device()
        else:
            torch_device = torch.device("cpu")

        image = image.to(torch_device)
        mask = _normalize_mask(mask, b, orig_h, orig_w, torch_device)

        multiple = (
            0
            if round_to_multiple in ("无", "None", None)
            else _safe_int(round_to_multiple, 0)
        )

        if resize_mode == "fixed":
            target_w = _round_to_multiple(_safe_int(width, orig_w), multiple)
            target_h = _round_to_multiple(_safe_int(height, orig_h), multiple)
            out_image, out_mask = _apply_fit(
                image, mask, target_w, target_h, fit_mode, upscale_method, pad_color
            )

        elif resize_mode == "proportional":
            ratio = max(0.01, float(scale_percent) / 100.0)
            target_w = _round_to_multiple(orig_w * ratio, multiple)
            target_h = _round_to_multiple(orig_h * ratio, multiple)
            out_image = _resize_image_tensor(image, target_w, target_h, upscale_method)
            out_mask = (
                _resize_mask_tensor(mask, target_w, target_h, upscale_method)
                if mask is not None
                else _empty_mask(b, target_h, target_w, image.dtype, image.device)
            )

        elif resize_mode == "long_side":
            long_side = max(4, _safe_int(long_side_length, max(orig_w, orig_h)))
            if orig_w >= orig_h:
                target_w = long_side
                target_h = max(1, int(round(orig_h * (target_w / max(1, orig_w)))))
            else:
                target_h = long_side
                target_w = max(1, int(round(orig_w * (target_h / max(1, orig_h)))))
            target_w = _round_to_multiple(target_w, multiple)
            target_h = _round_to_multiple(target_h, multiple)
            out_image = _resize_image_tensor(image, target_w, target_h, upscale_method)
            out_mask = (
                _resize_mask_tensor(mask, target_w, target_h, upscale_method)
                if mask is not None
                else _empty_mask(b, target_h, target_w, image.dtype, image.device)
            )

        elif resize_mode == "pixel_control":
            ratio = _get_aspect_ratio(
                aspect_ratio, proportional_width, proportional_height, orig_w, orig_h
            )
            total_pixels = max(1, _safe_int(total_pixel_k, 1024)) * 1000
            target_w = int(round(math.sqrt(total_pixels * ratio)))
            target_h = int(round(target_w / max(1e-8, ratio)))
            target_w = _round_to_multiple(target_w, multiple)
            target_h = _round_to_multiple(target_h, multiple)
            out_image, out_mask = _apply_fit(
                image, mask, target_w, target_h, fit_mode, upscale_method, pad_color
            )

        else:
            raise ValueError(f"未知缩放模式: {resize_mode}")

        out_h = int(out_image.shape[1])
        out_w = int(out_image.shape[2])
        return out_image.cpu(), out_mask.cpu(), original_size, out_w, out_h

    def resize(
        self,
        image,
        resize_mode,
        width,
        height,
        scale_percent,
        long_side_length,
        total_pixel_k,
        aspect_ratio,
        proportional_width,
        proportional_height,
        fit_mode,
        upscale_method,
        round_to_multiple,
        pad_color,
        device,
        unique_id=None,
        mask=None,
    ):
        """
        支持两种输入：
        1. IMAGE：普通 ComfyUI 图片 Tensor，形状 HWC 或 BHWC，输出仍为 Tensor。
        2. GJJ_BATCH_IMAGE：多图列表/批量容器，逐张处理，输出处理后的图片列表。
        """
        is_multi_container = _is_multi_image_container(image)

        if not is_multi_container:
            return self._resize_tensor(
                image,
                resize_mode,
                width,
                height,
                scale_percent,
                long_side_length,
                total_pixel_k,
                aspect_ratio,
                proportional_width,
                proportional_height,
                fit_mode,
                upscale_method,
                round_to_multiple,
                pad_color,
                device,
                mask=mask,
            )

        items = _iter_batch_images(image)
        if not items:
            raise ValueError("GJJ_BATCH_IMAGE 为空，没有可处理的图片。")

        out_items: List[Any] = []
        out_masks: List[torch.Tensor] = []
        original_sizes: List[List[int]] = []
        first_w = 0
        first_h = 0

        for index, item in enumerate(items):
            item_image = _extract_tensor_from_item(item)
            if item_image is None:
                logging.warning(
                    f"GJJ_ImageResizeKJv2 跳过第 {index + 1} 张：未找到可识别的图片 Tensor。"
                )
                continue

            item_mask = _select_mask_for_item(mask, index)
            out_image, out_mask, original_size, out_w, out_h = self._resize_tensor(
                item_image,
                resize_mode,
                width,
                height,
                scale_percent,
                long_side_length,
                total_pixel_k,
                aspect_ratio,
                proportional_width,
                proportional_height,
                fit_mode,
                upscale_method,
                round_to_multiple,
                pad_color,
                device,
                mask=item_mask,
            )

            # 多图列表输出按“每个元素一张/一批”返回，便于后续 GJJ 批处理节点继续逐项处理。
            out_items.append(_replace_item_image(item, out_image))
            out_masks.append(out_mask)
            original_sizes.append(original_size)
            if first_w <= 0:
                first_w = int(out_w)
                first_h = int(out_h)

        if not out_items:
            raise ValueError("GJJ_BATCH_IMAGE 中没有可处理的图片。")

        # 对于多图列表，原始尺寸返回每张图的尺寸列表；宽度/高度返回第一张处理结果尺寸。
        return (out_items, out_masks, original_sizes, first_w, first_h)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageResizeKJv2}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔍 多功能图片缩放"}
