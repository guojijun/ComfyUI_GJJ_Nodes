from __future__ import annotations

import math
from typing import Any

import torch
import torch.nn.functional as F

try:
    import comfy.model_management
except Exception:
    comfy = None

MAX_RESOLUTION = 16384


NODE_CROP = "GJJ_InpaintCrop"
NODE_STITCH = "GJJ_InpaintStitch"

RESIZE_MODES = ["nearest", "bilinear", "bicubic", "lanczos", "box", "hamming"]
PRERESIZE_MIN = "确保最小分辨率"
PRERESIZE_MAX = "确保最大分辨率"
PRERESIZE_RANGE = "确保最小和最大分辨率"
PRERESIZE_MODES = [PRERESIZE_MIN, PRERESIZE_MAX, PRERESIZE_RANGE]
DEVICE_CPU = "CPU 兼容"
DEVICE_GPU = "GPU 加速"
DEVICE_MODES = [DEVICE_GPU, DEVICE_CPU]


def _as_image(image: torch.Tensor) -> torch.Tensor:
    if image is None or not isinstance(image, torch.Tensor):
        raise RuntimeError("请连接有效的图片输入。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise RuntimeError(f"图片维度无效：{tuple(image.shape)}，应为 [批次, 高, 宽, 通道]。")
    if image.shape[-1] not in (3, 4):
        raise RuntimeError(f"图片通道数无效：{int(image.shape[-1])}。")
    return image.float().clamp(0.0, 1.0).contiguous()


def _as_mask(mask: torch.Tensor | None, image: torch.Tensor, default: float = 0.0) -> torch.Tensor:
    if mask is None:
        return torch.full((image.shape[0], image.shape[1], image.shape[2]), default, dtype=image.dtype, device=image.device)
    if not isinstance(mask, torch.Tensor):
        raise RuntimeError("遮罩输入不是有效 MASK 张量。")
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    if mask.ndim == 4:
        mask = mask[..., 0]
    if mask.ndim != 3:
        raise RuntimeError(f"遮罩维度无效：{tuple(mask.shape)}，应为 [批次, 高, 宽]。")
    mask = mask.float().clamp(0.0, 1.0).to(device=image.device)
    if mask.shape[1:] != image.shape[1:3]:
        if torch.count_nonzero(mask).item() == 0:
            mask = torch.zeros((mask.shape[0], image.shape[1], image.shape[2]), dtype=image.dtype, device=image.device)
        else:
            mask = _resize_mask(mask, int(image.shape[2]), int(image.shape[1]), "bilinear")
    if mask.shape[0] == 1 and image.shape[0] > 1:
        mask = mask.expand(image.shape[0], -1, -1).clone()
    if image.shape[0] == 1 and mask.shape[0] > 1:
        return mask.contiguous()
    if mask.shape[0] != image.shape[0]:
        raise RuntimeError(f"遮罩批次数 {int(mask.shape[0])} 与图片批次数 {int(image.shape[0])} 不一致。")
    return mask.contiguous()


def _interp_mode(name: str) -> tuple[str, bool | None]:
    table = {
        "nearest": ("nearest", None),
        "bilinear": ("bilinear", False),
        "bicubic": ("bicubic", False),
        "lanczos": ("bicubic", False),
        "box": ("area", None),
        "hamming": ("bilinear", False),
    }
    return table.get(str(name).lower(), ("bilinear", False))


def _resize_image(image: torch.Tensor, width: int, height: int, algorithm: str) -> torch.Tensor:
    width = max(1, int(width))
    height = max(1, int(height))
    mode, align = _interp_mode(algorithm)
    nchw = image.movedim(-1, 1)
    if align is None:
        out = F.interpolate(nchw, size=(height, width), mode=mode)
    else:
        out = F.interpolate(nchw, size=(height, width), mode=mode, align_corners=align)
    return out.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _resize_mask(mask: torch.Tensor, width: int, height: int, algorithm: str) -> torch.Tensor:
    width = max(1, int(width))
    height = max(1, int(height))
    mode, align = _interp_mode(algorithm)
    x = mask.unsqueeze(1)
    if align is None:
        out = F.interpolate(x, size=(height, width), mode=mode)
    else:
        out = F.interpolate(x, size=(height, width), mode=mode, align_corners=align)
    return out[:, 0].clamp(0.0, 1.0).contiguous()


def _max_pool_mask(mask: torch.Tensor, pixels: int) -> torch.Tensor:
    pixels = int(pixels)
    if pixels <= 0:
        return mask
    kernel = max(3, int(math.ceil(pixels / 2.0)) * 2 + 1)
    pad = kernel // 2
    return F.max_pool2d(F.pad(mask.unsqueeze(1), (pad, pad, pad, pad), mode="replicate"), kernel, stride=1)[:, 0].clamp(0, 1)


def _blur_mask(mask: torch.Tensor, pixels: float) -> torch.Tensor:
    sigma = max(0.01, float(pixels) / 4.0)
    radius = max(1, int(math.ceil(sigma * 3.0)))
    size = radius * 2 + 1
    x = torch.arange(size, dtype=mask.dtype, device=mask.device) - radius
    kernel = torch.exp(-(x * x) / (2 * sigma * sigma))
    kernel = (kernel / kernel.sum()).view(1, 1, size)
    data = mask.unsqueeze(1)
    data = F.pad(data, (radius, radius, 0, 0), mode="replicate")
    data = F.conv2d(data, kernel.view(1, 1, 1, size))
    data = F.pad(data, (0, 0, radius, radius), mode="replicate")
    data = F.conv2d(data, kernel.view(1, 1, size, 1))
    return data[:, 0].clamp(0.0, 1.0)


def _fill_holes(mask: torch.Tensor) -> torch.Tensor:
    result = mask.clone()
    for threshold in (0.9, 0.5, 0.1):
        solid = (result >= threshold).float()
        solid = _max_pool_mask(solid, 1).clamp(0, 1)
        inv = 1.0 - solid
        exterior = torch.zeros_like(inv)
        exterior[:, 0, :] = inv[:, 0, :]
        exterior[:, -1, :] = inv[:, -1, :]
        exterior[:, :, 0] = torch.maximum(exterior[:, :, 0], inv[:, :, 0])
        exterior[:, :, -1] = torch.maximum(exterior[:, :, -1], inv[:, :, -1])
        step = 15
        for _ in range(max(4, int(math.ceil(max(mask.shape[1], mask.shape[2]) / step)) + 2)):
            grown = _max_pool_mask(exterior, step) * inv
            if torch.equal(grown, exterior):
                break
            exterior = grown
        filled = 1.0 - exterior
        result = torch.maximum(result, filled * float(threshold))
    return result.clamp(0, 1)


def _pad_to_multiple(value: int, multiple: int) -> int:
    multiple = max(1, int(multiple))
    return int(math.ceil(max(1, int(value)) / multiple) * multiple)


def _find_bbox(mask: torch.Tensor) -> tuple[int, int, int, int]:
    points = torch.nonzero(mask > 0, as_tuple=False)
    if points.numel() == 0:
        return -1, -1, -1, -1
    y0 = int(points[:, 0].min().item())
    x0 = int(points[:, 1].min().item())
    y1 = int(points[:, 0].max().item()) + 1
    x1 = int(points[:, 1].max().item()) + 1
    return x0, y0, x1 - x0, y1 - y0


def _grow_bbox(x: int, y: int, w: int, h: int, factor: float, image_w: int, image_h: int) -> tuple[int, int, int, int]:
    if x < 0:
        return 0, 0, image_w, image_h
    grow_x = int(round(w * (float(factor) - 1.0) / 2.0))
    grow_y = int(round(h * (float(factor) - 1.0) / 2.0))
    x0 = max(0, x - grow_x)
    y0 = max(0, y - grow_y)
    x1 = min(image_w, x + w + grow_x)
    y1 = min(image_h, y + h + grow_y)
    return x0, y0, max(1, x1 - x0), max(1, y1 - y0)


def _merge_bbox(a: tuple[int, int, int, int], b: tuple[int, int, int, int], image_w: int, image_h: int) -> tuple[int, int, int, int]:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    if ax < 0 and bx < 0:
        return -1, -1, -1, -1
    if ax < 0:
        return bx, by, bw, bh
    if bx < 0:
        return ax, ay, aw, ah
    x0 = max(0, min(ax, bx))
    y0 = max(0, min(ay, by))
    x1 = min(image_w, max(ax + aw, bx + bw))
    y1 = min(image_h, max(ay + ah, by + bh))
    return x0, y0, max(1, x1 - x0), max(1, y1 - y0)


def _edge_canvas(image: torch.Tensor, height: int, width: int, top: int, left: int) -> torch.Tensor:
    canvas = torch.zeros((1, height, width, image.shape[-1]), dtype=image.dtype, device=image.device)
    h = int(image.shape[1])
    w = int(image.shape[2])
    canvas[:, top:top + h, left:left + w] = image
    if top > 0:
        canvas[:, :top, left:left + w] = image[:, :1].expand(-1, top, -1, -1)
    bottom = height - top - h
    if bottom > 0:
        canvas[:, top + h:, left:left + w] = image[:, -1:].expand(-1, bottom, -1, -1)
    if left > 0:
        canvas[:, :, :left] = canvas[:, :, left:left + 1].expand(-1, -1, left, -1)
    right = width - left - w
    if right > 0:
        canvas[:, :, left + w:] = canvas[:, :, left + w - 1:left + w].expand(-1, -1, right, -1)
    return canvas


def _extend_for_outpaint(
    image: torch.Tensor,
    mask: torch.Tensor,
    context_mask: torch.Tensor,
    up: float,
    down: float,
    left: float,
    right: float,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    _, h, w, _ = image.shape
    new_h = max(1, int(h * (float(up) + float(down) - 1.0)))
    new_w = max(1, int(w * (float(left) + float(right) - 1.0)))
    top = int(h * (float(up) - 1.0))
    left_pad = int(w * (float(left) - 1.0))
    target_y0 = max(0, top)
    target_x0 = max(0, left_pad)
    src_y0 = max(0, -top)
    src_x0 = max(0, -left_pad)
    copy_h = min(h - src_y0, new_h - target_y0)
    copy_w = min(w - src_x0, new_w - target_x0)
    canvas = _edge_canvas(image[:, src_y0:src_y0 + copy_h, src_x0:src_x0 + copy_w], new_h, new_w, target_y0, target_x0)
    new_mask = torch.ones((1, new_h, new_w), dtype=mask.dtype, device=mask.device)
    new_context = torch.zeros((1, new_h, new_w), dtype=context_mask.dtype, device=context_mask.device)
    new_mask[:, target_y0:target_y0 + copy_h, target_x0:target_x0 + copy_w] = mask[:, src_y0:src_y0 + copy_h, src_x0:src_x0 + copy_w]
    new_context[:, target_y0:target_y0 + copy_h, target_x0:target_x0 + copy_w] = context_mask[:, src_y0:src_y0 + copy_h, src_x0:src_x0 + copy_w]
    return canvas, new_mask, new_context


def _preresize(
    image: torch.Tensor,
    mask: torch.Tensor,
    context_mask: torch.Tensor,
    downscale_algorithm: str,
    upscale_algorithm: str,
    mode: str,
    min_w: int,
    min_h: int,
    max_w: int,
    max_h: int,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    h, w = int(image.shape[1]), int(image.shape[2])
    scale = 1.0
    algorithm = upscale_algorithm
    if mode == PRERESIZE_MIN:
        if w >= min_w and h >= min_h:
            return image, mask, context_mask
        scale = max(min_w / max(1, w), min_h / max(1, h))
    elif mode == PRERESIZE_MAX:
        if w <= max_w and h <= max_h:
            return image, mask, context_mask
        scale = min(max_w / max(1, w), max_h / max(1, h))
        algorithm = downscale_algorithm
    else:
        if max_w < min_w or max_h < min_h:
            raise RuntimeError("预缩放最大尺寸不能小于最小尺寸。")
        if min_w <= w <= max_w and min_h <= h <= max_h:
            return image, mask, context_mask
        min_scale = max(min_w / max(1, w), min_h / max(1, h))
        max_scale = min(max_w / max(1, w), max_h / max(1, h))
        if min_scale > 1.0 and max_scale < 1.0:
            raise RuntimeError("当前宽高比无法同时满足预缩放的最小和最大尺寸。")
        if min_scale > 1.0:
            scale = min_scale
            algorithm = upscale_algorithm
        else:
            scale = max_scale
            algorithm = downscale_algorithm
    target_w = max(1, int(math.ceil(w * scale) if scale >= 1.0 else math.floor(w * scale)))
    target_h = max(1, int(math.ceil(h * scale) if scale >= 1.0 else math.floor(h * scale)))
    return (
        _resize_image(image, target_w, target_h, algorithm),
        _resize_mask(mask, target_w, target_h, "bilinear"),
        _resize_mask(context_mask, target_w, target_h, "bilinear"),
    )


def _crop_magic(
    image: torch.Tensor,
    mask: torch.Tensor,
    x: int,
    y: int,
    w: int,
    h: int,
    target_w: int,
    target_h: int,
    padding: int,
    downscale_algorithm: str,
    upscale_algorithm: str,
    resize_output: bool,
) -> tuple[torch.Tensor, int, int, int, int, torch.Tensor, torch.Tensor, int, int, int, int]:
    image_h, image_w = int(image.shape[1]), int(image.shape[2])
    if x < 0 or w <= 0 or h <= 0:
        x, y, w, h = 0, 0, image_w, image_h
    if padding > 0:
        target_w = _pad_to_multiple(target_w, padding)
        target_h = _pad_to_multiple(target_h, padding)
    target_ratio = max(1, target_w) / max(1, target_h)
    current_ratio = w / max(1, h)
    if current_ratio < target_ratio:
        new_w = int(math.ceil(h * target_ratio))
        new_h = h
        new_x = x - (new_w - w) // 2
        new_y = y
    else:
        new_w = w
        new_h = int(math.ceil(w / target_ratio))
        new_x = x
        new_y = y - (new_h - h) // 2
    if not resize_output:
        if new_w < target_w:
            new_x -= (target_w - new_w) // 2
            new_w = target_w
        if new_h < target_h:
            new_y -= (target_h - new_h) // 2
            new_h = target_h
    left_pad = max(0, -new_x)
    top_pad = max(0, -new_y)
    right_pad = max(0, new_x + new_w - image_w)
    bottom_pad = max(0, new_y + new_h - image_h)
    canvas_w = image_w + left_pad + right_pad
    canvas_h = image_h + top_pad + bottom_pad
    canvas_image = _edge_canvas(image, canvas_h, canvas_w, top_pad, left_pad)
    canvas_mask = torch.ones((1, canvas_h, canvas_w), dtype=mask.dtype, device=mask.device)
    canvas_mask[:, top_pad:top_pad + image_h, left_pad:left_pad + image_w] = mask
    ctc_x = new_x + left_pad
    ctc_y = new_y + top_pad
    cropped_image = canvas_image[:, ctc_y:ctc_y + new_h, ctc_x:ctc_x + new_w]
    cropped_mask = canvas_mask[:, ctc_y:ctc_y + new_h, ctc_x:ctc_x + new_w]
    if resize_output:
        algorithm = upscale_algorithm if target_w > new_w or target_h > new_h else downscale_algorithm
        cropped_image = _resize_image(cropped_image, target_w, target_h, algorithm)
        cropped_mask = _resize_mask(cropped_mask, target_w, target_h, algorithm)
    return canvas_image, left_pad, top_pad, image_w, image_h, cropped_image, cropped_mask, ctc_x, ctc_y, new_w, new_h


class GJJ_InpaintCrop:
    DESCRIPTION = "根据遮罩自动裁出局部重绘区域，并输出可拼回原图的零依赖 stitcher。"
    RETURN_TYPES = ("STITCHER", "IMAGE", "MASK")
    RETURN_NAMES = ("拼回信息", "裁切图片", "裁切遮罩")
    OUTPUT_TOOLTIPS = ("传给 GJJ 局部重绘拼回节点的内部信息。", "送入重绘流程的局部图片。", "送入重绘流程的局部遮罩。")
    FUNCTION = "inpaint_crop"
    CATEGORY = "GJJ/Image"
    SEARCH_ALIASES = ["Inpaint Crop", "inpaint crop", "局部重绘裁切", "重绘裁切", "裁切拼回"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "图片", "tooltip": "需要局部重绘的原始图片。"}),
                "downscale_algorithm": (RESIZE_MODES, {"default": "bilinear", "display_name": "缩小时算法", "tooltip": "裁切区域缩小时使用的插值算法。"}),
                "upscale_algorithm": (RESIZE_MODES, {"default": "bicubic", "display_name": "放大时算法", "tooltip": "裁切区域放大时使用的插值算法。"}),
                "preresize": ("BOOLEAN", {"default": False, "display_name": "预缩放原图", "tooltip": "在查找遮罩区域前先按尺寸规则缩放整张图。"}),
                "preresize_mode": (PRERESIZE_MODES, {"default": PRERESIZE_MIN, "display_name": "预缩放模式", "tooltip": "控制预缩放时满足最小尺寸、最大尺寸或两者范围。"}),
                "preresize_min_width": ("INT", {"default": 1024, "min": 0, "max": MAX_RESOLUTION, "step": 1, "display_name": "预缩放最小宽度", "tooltip": "预缩放启用时的最小宽度。"}),
                "preresize_min_height": ("INT", {"default": 1024, "min": 0, "max": MAX_RESOLUTION, "step": 1, "display_name": "预缩放最小高度", "tooltip": "预缩放启用时的最小高度。"}),
                "preresize_max_width": ("INT", {"default": MAX_RESOLUTION, "min": 0, "max": MAX_RESOLUTION, "step": 1, "display_name": "预缩放最大宽度", "tooltip": "预缩放启用时的最大宽度。"}),
                "preresize_max_height": ("INT", {"default": MAX_RESOLUTION, "min": 0, "max": MAX_RESOLUTION, "step": 1, "display_name": "预缩放最大高度", "tooltip": "预缩放启用时的最大高度。"}),
                "mask_fill_holes": ("BOOLEAN", {"default": True, "display_name": "填补遮罩空洞", "tooltip": "填补被遮罩包围的小空洞，减少局部遗漏。"}),
                "mask_expand_pixels": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1, "display_name": "遮罩扩张像素", "tooltip": "在裁切前向外扩张遮罩范围。"}),
                "mask_invert": ("BOOLEAN", {"default": False, "display_name": "反转遮罩", "tooltip": "反转遮罩，白色和黑色区域互换。"}),
                "mask_blend_pixels": ("INT", {"default": 32, "min": 0, "max": 256, "step": 1, "display_name": "拼回羽化像素", "tooltip": "拼回原图时用于柔和边缘的羽化范围。"}),
                "mask_hipass_filter": ("FLOAT", {"default": 0.10, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "遮罩低值过滤", "tooltip": "低于该值的遮罩像素会被视为未遮罩。"}),
                "extend_for_outpainting": ("BOOLEAN", {"default": False, "display_name": "扩画模式", "tooltip": "按上下左右倍率扩展画布，扩展区域自动作为重绘区域。"}),
                "extend_up_factor": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 100.0, "step": 0.01, "display_name": "上方扩展倍率", "tooltip": "扩画模式下，上方相对原图高度的扩展倍率。"}),
                "extend_down_factor": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 100.0, "step": 0.01, "display_name": "下方扩展倍率", "tooltip": "扩画模式下，下方相对原图高度的扩展倍率。"}),
                "extend_left_factor": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 100.0, "step": 0.01, "display_name": "左侧扩展倍率", "tooltip": "扩画模式下，左侧相对原图宽度的扩展倍率。"}),
                "extend_right_factor": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 100.0, "step": 0.01, "display_name": "右侧扩展倍率", "tooltip": "扩画模式下，右侧相对原图宽度的扩展倍率。"}),
                "context_from_mask_extend_factor": ("FLOAT", {"default": 1.20, "min": 1.0, "max": 100.0, "step": 0.01, "display_name": "上下文扩展倍率", "tooltip": "从遮罩边界向外扩大裁切上下文，例如 1.2 表示额外取 20% 上下文。"}),
                "output_resize_to_target_size": ("BOOLEAN", {"default": True, "display_name": "输出到目标尺寸", "tooltip": "开启后裁切图强制缩放到指定采样尺寸。批量输入时必须开启。"}),
                "output_target_width": ("INT", {"default": 512, "min": 64, "max": MAX_RESOLUTION, "step": 1, "display_name": "目标宽度", "tooltip": "裁切输出图片的目标宽度。"}),
                "output_target_height": ("INT", {"default": 512, "min": 64, "max": MAX_RESOLUTION, "step": 1, "display_name": "目标高度", "tooltip": "裁切输出图片的目标高度。"}),
                "output_padding": (["0", "8", "16", "32", "64", "128", "256", "512"], {"default": "32", "display_name": "尺寸对齐倍数", "tooltip": "把裁切目标尺寸向上对齐到指定倍数，适合模型尺寸约束。"}),
                "device_mode": (DEVICE_MODES, {"default": DEVICE_GPU, "display_name": "运行设备", "tooltip": "选择在 GPU 或 CPU 上执行裁切和遮罩处理。"}),
            },
            "optional": {
                "mask": ("MASK", {"display_name": "遮罩", "tooltip": "白色区域为需要重绘的区域。"}),
                "optional_context_mask": ("MASK", {"display_name": "额外上下文遮罩", "tooltip": "额外保留在裁切区域内的上下文范围，不一定参与重绘。"}),
            },
        }

    def inpaint_crop(
        self,
        image,
        downscale_algorithm,
        upscale_algorithm,
        preresize,
        preresize_mode,
        preresize_min_width,
        preresize_min_height,
        preresize_max_width,
        preresize_max_height,
        mask_fill_holes,
        mask_expand_pixels,
        mask_invert,
        mask_blend_pixels,
        mask_hipass_filter,
        extend_for_outpainting,
        extend_up_factor,
        extend_down_factor,
        extend_left_factor,
        extend_right_factor,
        context_from_mask_extend_factor,
        output_resize_to_target_size,
        output_target_width,
        output_target_height,
        output_padding,
        device_mode,
        mask=None,
        optional_context_mask=None,
    ):
        image = _as_image(image)
        device = image.device
        if device_mode == DEVICE_GPU and comfy is not None:
            try:
                device = comfy.model_management.get_torch_device()
            except Exception:
                device = image.device
        image = image.to(device)
        mask = _as_mask(mask, image)
        if image.shape[0] == 1 and mask.shape[0] > 1:
            image = image.expand(mask.shape[0], -1, -1, -1).clone()
        context_mask = _as_mask(optional_context_mask, image)
        if image.shape[0] > 1 and not output_resize_to_target_size:
            raise RuntimeError("批量图片输出必须开启“输出到目标尺寸”，否则每张裁切图尺寸可能不同，无法组成 IMAGE 批次。")
        padding = int(output_padding)
        stitcher = {
            "downscale_algorithm": downscale_algorithm,
            "upscale_algorithm": upscale_algorithm,
            "blend_pixels": int(mask_blend_pixels),
            "canvas_to_orig_x": [],
            "canvas_to_orig_y": [],
            "canvas_to_orig_w": [],
            "canvas_to_orig_h": [],
            "canvas_image": [],
            "cropped_to_canvas_x": [],
            "cropped_to_canvas_y": [],
            "cropped_to_canvas_w": [],
            "cropped_to_canvas_h": [],
            "cropped_mask_for_blend": [],
            "device_mode": device_mode,
            "source": "GJJ_InpaintCrop",
        }
        out_images: list[torch.Tensor] = []
        out_masks: list[torch.Tensor] = []
        for i in range(int(image.shape[0])):
            sub_image = image[i:i + 1]
            sub_mask = mask[i:i + 1]
            sub_context = context_mask[i:i + 1]
            if preresize:
                sub_image, sub_mask, sub_context = _preresize(
                    sub_image,
                    sub_mask,
                    sub_context,
                    downscale_algorithm,
                    upscale_algorithm,
                    preresize_mode,
                    int(preresize_min_width),
                    int(preresize_min_height),
                    int(preresize_max_width),
                    int(preresize_max_height),
                )
            if mask_fill_holes:
                sub_mask = _fill_holes(sub_mask)
            if int(mask_expand_pixels) > 0:
                sub_mask = _max_pool_mask(sub_mask, int(mask_expand_pixels))
            if mask_invert:
                sub_mask = 1.0 - sub_mask
            if int(mask_blend_pixels) > 0:
                sub_mask = _blur_mask(_max_pool_mask(sub_mask, int(mask_blend_pixels)), float(mask_blend_pixels) * 0.5)
            if float(mask_hipass_filter) >= 0.01:
                sub_mask = torch.where(sub_mask >= float(mask_hipass_filter), sub_mask, torch.zeros_like(sub_mask))
                sub_context = torch.where(sub_context >= float(mask_hipass_filter), sub_context, torch.zeros_like(sub_context))
            if extend_for_outpainting:
                sub_image, sub_mask, sub_context = _extend_for_outpaint(
                    sub_image, sub_mask, sub_context, extend_up_factor, extend_down_factor, extend_left_factor, extend_right_factor
                )
            image_h, image_w = int(sub_image.shape[1]), int(sub_image.shape[2])
            bbox = _find_bbox(sub_mask[0])
            if bbox[0] < 0:
                bbox = (0, 0, image_w, image_h)
            bbox = _grow_bbox(*bbox, float(context_from_mask_extend_factor), image_w, image_h)
            bbox = _merge_bbox(bbox, _find_bbox(sub_context[0]), image_w, image_h)
            if bbox[0] < 0:
                bbox = (0, 0, image_w, image_h)
            target_w = int(output_target_width) if output_resize_to_target_size else bbox[2]
            target_h = int(output_target_height) if output_resize_to_target_size else bbox[3]
            canvas, cto_x, cto_y, cto_w, cto_h, cropped, cropped_mask, ctc_x, ctc_y, ctc_w, ctc_h = _crop_magic(
                sub_image,
                sub_mask,
                *bbox,
                target_w,
                target_h,
                padding,
                downscale_algorithm,
                upscale_algorithm,
                bool(output_resize_to_target_size),
            )
            blend_mask = _blur_mask(cropped_mask, float(mask_blend_pixels) * 0.5) if int(mask_blend_pixels) > 0 else cropped_mask
            stitcher["canvas_to_orig_x"].append(cto_x)
            stitcher["canvas_to_orig_y"].append(cto_y)
            stitcher["canvas_to_orig_w"].append(cto_w)
            stitcher["canvas_to_orig_h"].append(cto_h)
            stitcher["canvas_image"].append(canvas.cpu())
            stitcher["cropped_to_canvas_x"].append(ctc_x)
            stitcher["cropped_to_canvas_y"].append(ctc_y)
            stitcher["cropped_to_canvas_w"].append(ctc_w)
            stitcher["cropped_to_canvas_h"].append(ctc_h)
            stitcher["cropped_mask_for_blend"].append(blend_mask.cpu())
            out_images.append(cropped[0].cpu())
            out_masks.append(cropped_mask[0].cpu())
        return (stitcher, torch.stack(out_images, dim=0), torch.stack(out_masks, dim=0))


class GJJ_InpaintStitch:
    DESCRIPTION = "把 GJJ 局部重绘裁切输出的重绘图拼回原图。"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("拼回图片",)
    OUTPUT_TOOLTIPS = ("重绘区域按遮罩羽化后拼回原图得到的图片。",)
    FUNCTION = "inpaint_stitch"
    CATEGORY = "GJJ/Image"
    SEARCH_ALIASES = ["Inpaint Stitch", "inpaint stitch", "局部重绘拼回", "拼回原图"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "stitcher": ("STITCHER", {"display_name": "拼回信息", "tooltip": "连接 GJJ 局部重绘裁切节点输出的拼回信息。"}),
                "inpainted_image": ("IMAGE", {"display_name": "重绘图片", "tooltip": "已经完成重绘的裁切图片。"}),
            }
        }

    def inpaint_stitch(self, stitcher: dict[str, Any], inpainted_image: torch.Tensor):
        if not isinstance(stitcher, dict):
            raise RuntimeError("拼回信息无效，请连接 GJJ 局部重绘裁切节点的拼回信息输出。")
        image = _as_image(inpainted_image)
        device_mode = stitcher.get("device_mode", DEVICE_CPU)
        device = image.device
        if device_mode == DEVICE_GPU and comfy is not None:
            try:
                device = comfy.model_management.get_torch_device()
            except Exception:
                device = image.device
        image = image.to(device)
        count = len(stitcher.get("cropped_to_canvas_x", []))
        if count <= 0:
            raise RuntimeError("拼回信息为空，无法拼回原图。")
        if image.shape[0] not in (1, count):
            raise RuntimeError(f"重绘图片批次数 {int(image.shape[0])} 与拼回信息数量 {count} 不一致。")
        results: list[torch.Tensor] = []
        for i in range(count):
            src = image[0:1] if image.shape[0] == 1 else image[i:i + 1]
            canvas = stitcher["canvas_image"][i].to(device).clone()
            mask = stitcher["cropped_mask_for_blend"][i].to(device)
            ctc_x = int(stitcher["cropped_to_canvas_x"][i])
            ctc_y = int(stitcher["cropped_to_canvas_y"][i])
            ctc_w = int(stitcher["cropped_to_canvas_w"][i])
            ctc_h = int(stitcher["cropped_to_canvas_h"][i])
            cto_x = int(stitcher["canvas_to_orig_x"][i])
            cto_y = int(stitcher["canvas_to_orig_y"][i])
            cto_w = int(stitcher["canvas_to_orig_w"][i])
            cto_h = int(stitcher["canvas_to_orig_h"][i])
            algorithm = stitcher.get("upscale_algorithm", "bicubic") if ctc_w > src.shape[2] or ctc_h > src.shape[1] else stitcher.get("downscale_algorithm", "bilinear")
            resized_image = _resize_image(src, ctc_w, ctc_h, algorithm)
            resized_mask = _resize_mask(mask, ctc_w, ctc_h, algorithm).unsqueeze(-1)
            canvas_crop = canvas[:, ctc_y:ctc_y + ctc_h, ctc_x:ctc_x + ctc_w]
            if canvas_crop.shape[1:3] != resized_image.shape[1:3]:
                raise RuntimeError("拼回区域尺寸异常，请重新执行裁切节点。")
            canvas[:, ctc_y:ctc_y + ctc_h, ctc_x:ctc_x + ctc_w] = resized_mask * resized_image + (1.0 - resized_mask) * canvas_crop
            results.append(canvas[:, cto_y:cto_y + cto_h, cto_x:cto_x + cto_w][0].cpu())
        return (torch.stack(results, dim=0),)


NODE_CLASS_MAPPINGS = {
    NODE_CROP: GJJ_InpaintCrop,
    NODE_STITCH: GJJ_InpaintStitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_CROP: "✂️ 局部重绘裁切",
    NODE_STITCH: "🧵 局部重绘拼回",
}
