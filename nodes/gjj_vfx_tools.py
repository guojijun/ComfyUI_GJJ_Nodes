from __future__ import annotations

import math

import torch
import torch.nn.functional as F


def _resize(image: torch.Tensor, height: int, width: int, mode: str = "nearest") -> torch.Tensor:
    samples = image.movedim(-1, 1)
    if mode in {"bilinear", "bicubic"}:
        out = F.interpolate(samples, size=(height, width), mode=mode, align_corners=False)
    else:
        out = F.interpolate(samples, size=(height, width), mode=mode)
    return out.movedim(1, -1)


def _pixelate(image: torch.Tensor, block_size: int) -> torch.Tensor:
    _, height, width, _ = image.shape
    small_h = max(1, int(height) // max(1, block_size))
    small_w = max(1, int(width) // max(1, block_size))
    small = _resize(image, small_h, small_w, "nearest")
    return _resize(small, int(height), int(width), "nearest")


def _ordered_dither(image: torch.Tensor, levels: int) -> torch.Tensor:
    matrix = torch.tensor(
        [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]],
        dtype=image.dtype,
        device=image.device,
    ) / 16.0
    _, height, width, _ = image.shape
    threshold = matrix.repeat(math.ceil(height / 4), math.ceil(width / 4))[:height, :width]
    threshold = threshold[None, :, :, None]
    steps = max(2, int(levels))
    return (torch.floor(image * (steps - 1) + threshold) / (steps - 1)).clamp(0, 1)


def _glitch(image: torch.Tensor, strength: int, seed: int) -> torch.Tensor:
    generator = torch.Generator(device="cpu").manual_seed(int(seed))
    result = image.clone()
    _, height, width, channels = result.shape
    band_count = max(1, int(strength))
    for _ in range(band_count):
        y = int(torch.randint(0, max(1, height), (1,), generator=generator).item())
        band_h = int(torch.randint(2, max(3, height // 8), (1,), generator=generator).item())
        shift = int(torch.randint(-max(1, width // 8), max(2, width // 8), (1,), generator=generator).item())
        result[:, y:min(height, y + band_h), :, :] = torch.roll(result[:, y:min(height, y + band_h), :, :], shifts=shift, dims=2)
    if channels >= 3:
        result[..., 0] = torch.roll(result[..., 0], shifts=max(1, int(strength)), dims=2)
        result[..., 2] = torch.roll(result[..., 2], shifts=-max(1, int(strength)), dims=1)
    return result.clamp(0, 1)


def _halftone(image: torch.Tensor, cell_size: int) -> torch.Tensor:
    block = max(2, int(cell_size))
    _, height, width, _ = image.shape
    gray = image[..., :3].mean(dim=-1, keepdim=True)
    small_h = max(1, height // block)
    small_w = max(1, width // block)
    small = _resize(gray, small_h, small_w, "bilinear")
    dots = torch.zeros_like(image[..., :3])
    yy, xx = torch.meshgrid(torch.arange(height, device=image.device), torch.arange(width, device=image.device), indexing="ij")
    local_y = (yy % block).float() - block / 2.0
    local_x = (xx % block).float() - block / 2.0
    dist = torch.sqrt(local_x * local_x + local_y * local_y)[None, :, :, None]
    radius = _resize((1.0 - small).clamp(0, 1), height, width, "nearest") * (block * 0.65)
    dots[:] = (dist <= radius).float()
    return dots.clamp(0, 1)


class GJJ_VFXEffects:
    CATEGORY = "GJJ/VFX"
    FUNCTION = "apply"
    DESCRIPTION = "常用本地图像 VFX：像素化、抖动、故障偏移、半调。"
    SEARCH_ALIASES = ["vfx", "pixelate", "dither", "glitch", "halftone", "像素化", "抖动", "故障"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("效果图像",)
    OUTPUT_TOOLTIPS = ("应用 VFX 后的图像。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "图像", "tooltip": "输入图片或帧序列。"}),
                "effect": (["像素化", "有序抖动", "故障偏移", "半调网点"], {"default": "像素化", "display_name": "效果", "tooltip": "选择要应用的 VFX。"}),
                "amount": ("INT", {"default": 8, "min": 1, "max": 128, "display_name": "强度", "tooltip": "像素块、抖动层级、偏移条数或网点尺寸。"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF, "display_name": "随机种子", "tooltip": "故障偏移使用。"}),
            }
        }

    def apply(self, image: torch.Tensor, effect: str, amount: int, seed: int):
        value = image.detach().float().cpu().clamp(0, 1)
        if effect == "像素化":
            return (_pixelate(value, int(amount)),)
        if effect == "有序抖动":
            return (_ordered_dither(value, max(2, int(amount))),)
        if effect == "故障偏移":
            return (_glitch(value, int(amount), int(seed)),)
        return (_halftone(value, int(amount)),)


NODE_CLASS_MAPPINGS = {"GJJ_VFXEffects": GJJ_VFXEffects}
NODE_DISPLAY_NAME_MAPPINGS = {"GJJ_VFXEffects": "GJJ · ✨ VFX图像效果"}
