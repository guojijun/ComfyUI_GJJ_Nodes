"""GJJ 图像处理工具模块。

提供图像扩图、填充、羽化等通用图像处理功能。
"""

from __future__ import annotations

import torch
import comfy.utils


def gjjutils_expand_image_with_padding(
    image: torch.Tensor,
    left: int = 0,
    right: int = 0,
    top: int = 0,
    bottom: int = 0,
    padding_mode: str = "replicate",
) -> torch.Tensor:
    """使用指定模式扩展图像边界。

    Args:
        image: 输入图像张量，形状为 (batch, height, width, channels)
        left: 左侧扩展像素数
        right: 右侧扩展像素数
        top: 顶部扩展像素数
        bottom: 底部扩展像素数
        padding_mode: 填充模式
            - "replicate": 复制边缘像素（默认）
            - "reflect": 反射填充
            - "constant": 常数填充（黑色）
            - "zeros": 零填充

    Returns:
        扩展后的图像张量

    Example:
        >>> expanded = gjjutils_expand_image_with_padding(image, left=128, right=128, top=128, bottom=128)
    """
    if image.ndim == 3:
        image = image.unsqueeze(0)

    _, orig_h, orig_w, channels = image.shape

    new_h = orig_h + top + bottom
    new_w = orig_w + left + right

    if padding_mode == "replicate":
        result = torch.zeros((1, new_h, new_w, channels), dtype=image.dtype, device=image.device)
        result[:, top:top+orig_h, left:left+orig_w, :] = image

        if left > 0:
            result[:, top:top+orig_h, :left, :] = image[:, :, :1, :]
        if right > 0:
            result[:, top:top+orig_h, left+orig_w:, :] = image[:, :, -1:, :]
        if top > 0:
            result[:, :top, :, :] = result[:, top:top+1, :, :]
        if bottom > 0:
            result[:, top+orig_h:, :, :] = result[:, top+orig_h-1:top+orig_h, :, :]

    elif padding_mode == "reflect":
        result = torch.zeros((1, new_h, new_w, channels), dtype=image.dtype, device=image.device)
        result[:, top:top+orig_h, left:left+orig_w, :] = image

        if left > 0:
            for i in range(left):
                result[:, top:top+orig_h, left-1-i, :] = image[:, :, i, :]
        if right > 0:
            for i in range(right):
                result[:, top:top+orig_h, left+orig_w+i, :] = image[:, :, orig_w-1-i, :]
        if top > 0:
            for i in range(top):
                result[:, top-1-i, :, :] = result[:, top+i, :, :]
        if bottom > 0:
            for i in range(bottom):
                result[:, top+orig_h+i, :, :] = result[:, top+orig_h-1-i, :, :]

    else:
        result = torch.zeros((1, new_h, new_w, channels), dtype=image.dtype, device=image.device)
        result[:, top:top+orig_h, left:left+orig_w, :] = image

    return result.contiguous()


def gjjutils_create_expand_mask(
    original_size: tuple[int, int],
    pad_amounts: dict[str, int],
    latent_scale: int = 8,
) -> torch.Tensor:
    """创建扩图区域的遮罩。

    Args:
        original_size: 原始图像尺寸 (width, height)
        pad_amounts: 各方向填充量 {"left": int, "right": int, "top": int, "bottom": int}
        latent_scale: latent 缩放因子（通常为 8）

    Returns:
        遮罩张量，扩图区域为 1.0，原图区域为 0.0
    """
    orig_w, orig_h = original_size
    left = pad_amounts.get("left", 0)
    right = pad_amounts.get("right", 0)
    top = pad_amounts.get("top", 0)
    bottom = pad_amounts.get("bottom", 0)

    new_w = orig_w + left + right
    new_h = orig_h + top + bottom

    latent_w = max(1, new_w // latent_scale)
    latent_h = max(1, new_h // latent_scale)

    mask = torch.ones((1, latent_h, latent_w), dtype=torch.float32)

    latent_left = left // latent_scale
    latent_top = top // latent_scale
    latent_orig_w = max(1, orig_w // latent_scale)
    latent_orig_h = max(1, orig_h // latent_scale)

    end_x = min(latent_left + latent_orig_w, latent_w)
    end_y = min(latent_top + latent_orig_h, latent_h)

    if latent_left < end_x and latent_top < end_y:
        mask[:, latent_top:end_y, latent_left:end_x] = 0.0

    return mask


def gjjutils_resize_image_to_size(
    image: torch.Tensor,
    target_width: int,
    target_height: int,
    upscale_method: str = "lanczos",
) -> torch.Tensor:
    """将图像调整到指定尺寸。

    Args:
        image: 输入图像张量
        target_width: 目标宽度
        target_height: 目标高度
        upscale_method: 缩放方法（lanczos, bilinear, nearest等）

    Returns:
        调整尺寸后的图像张量
    """
    if image.ndim == 3:
        image = image.unsqueeze(0)

    samples = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(
        samples, int(target_width), int(target_height), upscale_method, "disabled"
    )
    return resized.movedim(1, -1)


def gjjutils_calculate_expand_size(
    original_width: int,
    original_height: int,
    direction: str,
    pixels: int,
) -> tuple[int, int, dict[str, int]]:
    """计算扩图后的尺寸和各方向扩展量。

    Args:
        original_width: 原始宽度
        original_height: 原始高度
        direction: 扩展方向（all, left, right, top, bottom, left+right, top+bottom）
        pixels: 每个方向扩展的像素数

    Returns:
        (新宽度, 新高度, 各方向填充量字典)
    """
    left = 0
    right = 0
    top = 0
    bottom = 0

    direction = str(direction or "").strip().lower()

    if direction == "all":
        left = right = top = bottom = pixels
    elif direction == "left":
        left = pixels
    elif direction == "right":
        right = pixels
    elif direction == "top":
        top = pixels
    elif direction == "bottom":
        bottom = pixels
    elif direction == "left+right":
        left = right = pixels
    elif direction == "top+bottom":
        top = bottom = pixels

    new_width = original_width + left + right
    new_height = original_height + top + bottom

    pad_amounts = {"left": left, "right": right, "top": top, "bottom": bottom}

    return new_width, new_height, pad_amounts


def gjjutils_blend_mask_edge(
    mask: torch.Tensor,
    blend_pixels: int = 16,
) -> torch.Tensor:
    """对遮罩边缘进行羽化处理。

    Args:
        mask: 输入遮罩张量
        blend_pixels: 羽化像素宽度

    Returns:
        羽化后的遮罩张量
    """
    if blend_pixels <= 0:
        return mask

    mask = mask.clone()
    device = mask.device
    dtype = mask.dtype

    h, w = mask.shape[-2], mask.shape[-1]

    for i in range(blend_pixels):
        t = i / blend_pixels

        if i < h:
            mask[..., i, :] *= t
            mask[..., h-1-i, :] *= t

        if i < w:
            mask[..., :, i] *= t
            mask[..., :, w-1-i] *= t

    return mask


def gjjutils_split_image_batch(
    value: torch.Tensor,
    min_batch_size: int = 1,
) -> list[torch.Tensor]:
    """拆分批次图像为单张图像列表。

    Args:
        value: 输入图像张量（可以是单张或批次）
        min_batch_size: 最小批次大小

    Returns:
        单张图像列表
    """
    if value is None:
        return []

    if not isinstance(value, torch.Tensor):
        return [value] if value is not None else []

    if value.ndim == 3:
        return [value.unsqueeze(0).contiguous()]

    if value.ndim != 4:
        return [value]

    batch_size = max(0, int(value.shape[0]))
    if batch_size <= min_batch_size:
        return [value.contiguous()]

    return [value[i:i+1].contiguous() for i in range(batch_size)]
