from __future__ import annotations

import torch


NODE_NAME = "GJJ_ImageAdjuster"


def _rgb_to_hsv(image: torch.Tensor) -> torch.Tensor:
    r, g, b = image.unbind(dim=-1)
    maxc = torch.max(image, dim=-1).values
    minc = torch.min(image, dim=-1).values
    deltac = maxc - minc
    eps = torch.finfo(image.dtype).eps

    h = torch.zeros_like(maxc)
    mask = deltac > eps
    rc = ((maxc - r) / (deltac + eps))
    gc = ((maxc - g) / (deltac + eps))
    bc = ((maxc - b) / (deltac + eps))
    h = torch.where((r == maxc) & mask, bc - gc, h)
    h = torch.where((g == maxc) & mask, 2.0 + rc - bc, h)
    h = torch.where((b == maxc) & mask, 4.0 + gc - rc, h)
    h = (h / 6.0) % 1.0
    s = torch.where(maxc > eps, deltac / (maxc + eps), torch.zeros_like(maxc))
    v = maxc
    return torch.stack((h, s, v), dim=-1)


def _hsv_to_rgb(hsv: torch.Tensor) -> torch.Tensor:
    h, s, v = hsv.unbind(dim=-1)
    i = torch.floor(h * 6.0)
    f = h * 6.0 - i
    p = v * (1.0 - s)
    q = v * (1.0 - f * s)
    t = v * (1.0 - (1.0 - f) * s)
    i_mod = (i.to(torch.int64) % 6)

    rgb = torch.zeros_like(hsv)
    choices = [
        torch.stack((v, t, p), dim=-1),
        torch.stack((q, v, p), dim=-1),
        torch.stack((p, v, t), dim=-1),
        torch.stack((p, q, v), dim=-1),
        torch.stack((t, p, v), dim=-1),
        torch.stack((v, p, q), dim=-1),
    ]
    for idx, choice in enumerate(choices):
        rgb = torch.where((i_mod == idx).unsqueeze(-1), choice, rgb)
    return rgb


def _ensure_rgb(image: torch.Tensor) -> torch.Tensor:
    if image.ndim != 4:
        raise ValueError("图片调色器需要 IMAGE 批次输入。")
    if image.shape[-1] == 1:
        return image.repeat(1, 1, 1, 3)
    if image.shape[-1] >= 3:
        return image[..., :3]
    raise ValueError("图片通道数不正确。")


class GJJ_ImageAdjuster:
    CATEGORY = "GJJ/Image"
    FUNCTION = "adjust"
    DESCRIPTION = "对图片批次执行本地调色：曝光、对比、饱和、鲜艳度、色温、色调、色相、伽马和颗粒。"
    SEARCH_ALIASES = ["adjust", "color", "tone", "调色", "白平衡", "颗粒", "色相", "饱和度"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("调色图像",)
    OUTPUT_TOOLTIPS = ("调色后的 IMAGE 批次。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "输入图像", "tooltip": "需要调色的图片或图片批次。"}),
                "exposure": ("FLOAT", {"default": 0.0, "min": -2.0, "max": 2.0, "step": 0.05, "display": "slider", "display_name": "曝光", "tooltip": "线性曝光补偿；正数变亮，负数变暗。"}),
                "contrast": ("FLOAT", {"default": 0.0, "min": -100.0, "max": 100.0, "step": 1.0, "display": "slider", "display_name": "对比度", "tooltip": "围绕中灰提升或降低对比。"}),
                "saturation": ("FLOAT", {"default": 0.0, "min": -100.0, "max": 100.0, "step": 1.0, "display": "slider", "display_name": "饱和度", "tooltip": "整体颜色饱和度。"}),
                "vibrance": ("FLOAT", {"default": 0.0, "min": -100.0, "max": 100.0, "step": 1.0, "display": "slider", "display_name": "鲜艳度", "tooltip": "主要增强低饱和区域，比整体饱和更温和。"}),
                "temperature": ("FLOAT", {"default": 0.0, "min": -100.0, "max": 100.0, "step": 1.0, "display": "slider", "display_name": "色温", "tooltip": "正数偏暖，负数偏冷。"}),
                "tint": ("FLOAT", {"default": 0.0, "min": -100.0, "max": 100.0, "step": 1.0, "display": "slider", "display_name": "色调", "tooltip": "正数偏洋红，负数偏绿色。"}),
                "hue_shift": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 1.0, "display": "slider", "display_name": "色相偏移", "tooltip": "整体旋转色相角度。"}),
                "gamma": ("FLOAT", {"default": 1.0, "min": 0.2, "max": 3.0, "step": 0.02, "display": "slider", "display_name": "伽马", "tooltip": "小于 1 提亮暗部，大于 1 压暗中间调。"}),
                "grain": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 1.0, "display": "slider", "display_name": "颗粒", "tooltip": "添加轻微随机胶片颗粒。"}),
                "grain_mode": (["胶片均匀颗粒", "高斯噪声"], {"default": "胶片均匀颗粒", "display_name": "颗粒模式", "tooltip": "选择颗粒噪声的随机分布。"}),
            }
        }

    def adjust(
        self,
        image,
        exposure,
        contrast,
        saturation,
        vibrance,
        temperature,
        tint,
        hue_shift,
        gamma,
        grain,
        grain_mode,
    ):
        out = _ensure_rgb(image).float().clamp(0, 1)

        if exposure:
            out = out * (2.0 ** float(exposure))

        if contrast:
            factor = 1.0 + float(contrast) / 100.0
            out = (out - 0.5) * factor + 0.5

        if temperature or tint:
            temp = float(temperature) / 100.0
            tint_value = float(tint) / 100.0
            balance = torch.tensor(
                [1.0 + 0.18 * temp + 0.08 * tint_value, 1.0 - 0.10 * tint_value, 1.0 - 0.18 * temp + 0.08 * tint_value],
                device=out.device,
                dtype=out.dtype,
            )
            out = out * balance

        if hue_shift or saturation or vibrance:
            hsv = _rgb_to_hsv(out.clamp(0, 1))
            if hue_shift:
                hsv[..., 0] = (hsv[..., 0] + float(hue_shift) / 360.0) % 1.0
            if saturation:
                hsv[..., 1] = hsv[..., 1] * (1.0 + float(saturation) / 100.0)
            if vibrance:
                v = float(vibrance) / 100.0
                hsv[..., 1] = hsv[..., 1] + (1.0 - hsv[..., 1]) * v * 0.65
            hsv[..., 1] = hsv[..., 1].clamp(0, 1)
            out = _hsv_to_rgb(hsv)

        if gamma and abs(float(gamma) - 1.0) > 1e-6:
            out = out.clamp(0, 1).pow(1.0 / max(0.001, float(gamma)))

        if grain:
            intensity = float(grain) / 500.0
            if grain_mode == "高斯噪声":
                noise = torch.randn_like(out) * intensity
            else:
                noise = torch.empty_like(out).uniform_(-intensity, intensity)
            out = out + noise

        return (out.clamp(0, 1),)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageAdjuster}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎚️ 图片调色"}
