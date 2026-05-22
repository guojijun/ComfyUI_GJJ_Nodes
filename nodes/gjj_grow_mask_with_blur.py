from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter
from tqdm import tqdm

from comfy import model_management
try:
    from nodes import MAX_RESOLUTION
except Exception:
    MAX_RESOLUTION = 16384


def _normalize_mask(mask: torch.Tensor) -> torch.Tensor:
    if not isinstance(mask, torch.Tensor):
        raise RuntimeError(f"遮罩输入类型无效：{type(mask)!r}")
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    elif mask.ndim == 4 and int(mask.shape[-1]) == 1:
        mask = mask.squeeze(-1)
    elif mask.ndim == 4 and int(mask.shape[1]) == 1:
        mask = mask[:, 0]
    if mask.ndim != 3:
        raise RuntimeError(f"遮罩输入维度无效，应为 MASK 或 MASK 批次，实际为：{tuple(mask.shape)}")
    return mask.float().clamp(0.0, 1.0).contiguous()


def _kernel(tapered_corners: bool, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    if tapered_corners:
        data = [[0, 1, 0], [1, 1, 1], [0, 1, 0]]
    else:
        data = [[1, 1, 1], [1, 1, 1], [1, 1, 1]]
    return torch.tensor(data, dtype=dtype, device=device).view(1, 1, 3, 3)


def _dilate_once(mask_2d: torch.Tensor, tapered_corners: bool) -> torch.Tensor:
    x = F.pad(mask_2d.unsqueeze(0).unsqueeze(0), (1, 1, 1, 1), mode="constant", value=0.0)
    patches = F.unfold(x, kernel_size=3).transpose(1, 2)
    active = _kernel(tapered_corners, mask_2d.device, mask_2d.dtype).reshape(1, 1, 9) > 0
    patches = patches.masked_fill(~active, -float("inf"))
    return patches.max(dim=-1).values.reshape_as(mask_2d).to(mask_2d.dtype)


def _erode_once(mask_2d: torch.Tensor, tapered_corners: bool) -> torch.Tensor:
    x = F.pad(mask_2d.unsqueeze(0).unsqueeze(0), (1, 1, 1, 1), mode="constant", value=1.0)
    patches = F.unfold(x, kernel_size=3).transpose(1, 2)
    active = _kernel(tapered_corners, mask_2d.device, mask_2d.dtype).reshape(1, 1, 9) > 0
    patches = patches.masked_fill(~active, float("inf"))
    return patches.min(dim=-1).values.reshape_as(mask_2d).to(mask_2d.dtype)


def _grow_single(mask_2d: torch.Tensor, expand: int, tapered_corners: bool) -> torch.Tensor:
    steps = abs(int(round(expand)))
    if steps <= 0 or float(mask_2d.max().item()) <= 0.0:
        return mask_2d.clamp(0.0, 1.0)
    out = mask_2d
    step_fn = _erode_once if expand < 0 else _dilate_once
    for _ in range(steps):
        out = step_fn(out, tapered_corners)
    return out.clamp(0.0, 1.0)


def _fill_holes_single(mask_2d: torch.Tensor) -> torch.Tensor:
    binary = mask_2d > 0
    if binary.numel() == 0:
        return mask_2d
    background = ~binary
    reachable = torch.zeros_like(background)
    reachable[0, :] = background[0, :]
    reachable[-1, :] = background[-1, :]
    reachable[:, 0] |= background[:, 0]
    reachable[:, -1] |= background[:, -1]

    # Morphologically flood-fill the background connected to image edges.
    for _ in range(int(mask_2d.shape[-2]) + int(mask_2d.shape[-1])):
        expanded = F.max_pool2d(
            reachable.float().unsqueeze(0).unsqueeze(0),
            kernel_size=3,
            stride=1,
            padding=1,
        ).squeeze(0).squeeze(0) > 0
        next_reachable = expanded & background
        if torch.equal(next_reachable, reachable):
            break
        reachable = next_reachable
    filled = binary | (background & ~reachable)
    return filled.to(mask_2d.dtype)


def _gaussian_blur(mask: torch.Tensor, radius: float) -> torch.Tensor:
    radius = float(radius)
    if radius <= 0:
        return mask
    kernel_radius = max(1, int(math.ceil(radius * 2.0)))
    kernel_size = kernel_radius * 2 + 1
    sigma = max(0.1, radius / 3.0)
    coords = torch.arange(kernel_size, dtype=mask.dtype, device=mask.device) - kernel_radius
    kernel = torch.exp(-(coords * coords) / (2.0 * sigma * sigma))
    kernel = kernel / kernel.sum().clamp_min(1e-8)
    kernel_x = kernel.view(1, 1, 1, kernel_size)
    kernel_y = kernel.view(1, 1, kernel_size, 1)

    x = mask.unsqueeze(1)
    pad_mode = "reflect" if int(mask.shape[-2]) > 1 and int(mask.shape[-1]) > 1 else "replicate"
    x = F.pad(x, (kernel_radius, kernel_radius, 0, 0), mode=pad_mode)
    x = F.conv2d(x, kernel_x)
    x = F.pad(x, (0, 0, kernel_radius, kernel_radius), mode=pad_mode)
    x = F.conv2d(x, kernel_y)
    return x.squeeze(1).clamp(0.0, 1.0)


def _pil2tensor(image: Image.Image) -> torch.Tensor:
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)


def _tensor2pil(image: torch.Tensor) -> list[Image.Image]:
    batch_count = image.size(0) if len(image.shape) > 3 else 1
    if batch_count > 1:
        out = []
        for i in range(batch_count):
            out.extend(_tensor2pil(image[i]))
        return out

    return [
        Image.fromarray(
            np.clip(255.0 * image.cpu().numpy().squeeze(), 0, 255).astype(np.uint8)
        )
    ]


class GJJ_GrowMaskWithBlur:
    CATEGORY = "GJJ/遮罩"
    FUNCTION = "expand_mask"
    DESCRIPTION = (
        "KJNodes GrowMaskWithBlur 的 GJJ 零依赖复刻版。"
        "支持遮罩扩张/收缩、逐帧递增、翻转、填洞、帧间插值、衰减叠加和高斯模糊。"
    )
    SEARCH_ALIASES = [
        "GrowMaskWithBlur",
        "Grow Mask With Blur",
        "KJNodes GrowMaskWithBlur",
        "grow mask blur",
        "mask grow blur",
        "遮罩扩张模糊",
        "遮罩羽化",
    ]

    RETURN_TYPES = ("MASK", "MASK")
    RETURN_NAMES = ("遮罩", "反相遮罩")
    OUTPUT_TOOLTIPS = (
        "扩张/收缩、填洞、插值和模糊后的遮罩。",
        "处理后遮罩的反相结果，等于 1 - 遮罩。",
    )

    GJJ_HELP = {
        "title": "遮罩扩张模糊",
        "description": "复刻 KJNodes 的 GrowMaskWithBlur，用于批量遮罩扩张、收缩和羽化。",
        "usage": [
            "expand 为正数时扩张遮罩，为负数时收缩遮罩。",
            "incremental_expandrate 会让每一帧的扩张/收缩量递增。",
            "tapered_corners 开启时使用十字形核，关闭时使用 3x3 方形核。",
            "lerp_alpha 和 decay_factor 会参考上一帧输出做平滑。",
        ],
        "notes": [
            "该节点不依赖 KJNodes、kornia 或 scipy。",
            "fill_holes 使用 GJJ 内置 torch 泛洪填洞实现，可能比 scipy 慢，但便于打包。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK", {"display_name": "遮罩", "tooltip": "输入 MASK 或 MASK 批次。"}),
                "expand": (
                    "INT",
                    {
                        "default": 0,
                        "min": -MAX_RESOLUTION,
                        "max": MAX_RESOLUTION,
                        "step": 1,
                        "display_name": "扩张/收缩",
                        "tooltip": "正数扩张遮罩，负数收缩遮罩，0 表示不改变边界。",
                    },
                ),
                "incremental_expandrate": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display_name": "逐帧递增量",
                        "tooltip": "每处理一张遮罩后，扩张/收缩量增加的绝对值。",
                    },
                ),
                "tapered_corners": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "柔化角",
                        "tooltip": "开启时使用十字形核，角落增长更柔和；关闭时使用完整 3x3 方形核。",
                    },
                ),
                "flip_input": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "输入反相",
                        "tooltip": "处理前先把输入遮罩反相。",
                    },
                ),
                "blur_radius": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display_name": "模糊半径",
                        "tooltip": "高斯模糊半径。0 表示不模糊。",
                    },
                ),
                "lerp_alpha": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "插值权重",
                        "tooltip": "当前帧与上一帧输出的线性插值权重。1 表示只使用当前帧。",
                    },
                ),
                "decay_factor": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "衰减叠加",
                        "tooltip": "小于 1 时将上一帧按该比例叠加到当前帧，再归一化。",
                    },
                ),
            },
            "optional": {
                "fill_holes": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "填洞",
                        "tooltip": "填充遮罩内部闭合空洞。该操作为 torch 实现，批量大时会更慢。",
                    },
                ),
            },
        }

    def expand_mask(
        self,
        mask: torch.Tensor,
        expand: int,
        tapered_corners: bool,
        flip_input: bool,
        blur_radius: float,
        incremental_expandrate: float,
        lerp_alpha: float,
        decay_factor: float,
        fill_holes: bool = False,
    ):
        if flip_input:
            mask = 1.0 - mask

        main_device = model_management.get_torch_device()
        growmask = mask.reshape((-1, mask.shape[-2], mask.shape[-1]))
        out = []
        previous_output = None
        current_expand = expand
        alpha = float(lerp_alpha)
        decay = float(decay_factor)
        for m in tqdm(growmask, desc="Expanding/Contracting Mask"):
            output = m.unsqueeze(0).unsqueeze(0).to(main_device)
            if abs(round(current_expand)) > 0 and output.max() > 0:
                output_2d = output.squeeze(0).squeeze(0)
                for _ in range(abs(round(current_expand))):
                    if current_expand < 0:
                        output_2d = _erode_once(output_2d, bool(tapered_corners))
                    else:
                        output_2d = _dilate_once(output_2d, bool(tapered_corners))
                output = output_2d.unsqueeze(0).unsqueeze(0)

            output = output.squeeze(0).squeeze(0)

            if current_expand < 0:
                current_expand -= abs(incremental_expandrate)
            else:
                current_expand += abs(incremental_expandrate)

            if fill_holes:
                output = _fill_holes_single(output)

            if alpha < 1.0 and previous_output is not None:
                output = alpha * output + (1 - alpha) * previous_output
            if decay < 1.0 and previous_output is not None:
                output += decay * previous_output
                output = output / output.max()
            previous_output = output
            out.append(output.cpu())

        if blur_radius != 0:
            for idx, tensor in enumerate(out):
                pil_image = _tensor2pil(tensor.cpu().detach())[0]
                pil_image = pil_image.filter(ImageFilter.GaussianBlur(blur_radius))
                out[idx] = _pil2tensor(pil_image)
            blurred = torch.cat(out, dim=0)
            return (blurred, 1.0 - blurred)

        result = torch.stack(out, dim=0)
        return (result, 1.0 - result)


NODE_CLASS_MAPPINGS = {
    "GJJ_GrowMaskWithBlur": GJJ_GrowMaskWithBlur,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_GrowMaskWithBlur": "🪄 遮罩扩张模糊",
}
