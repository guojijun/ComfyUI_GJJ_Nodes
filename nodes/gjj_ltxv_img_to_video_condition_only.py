from __future__ import annotations

from typing import Any

import comfy.utils
import torch


NODE_NAME = "GJJ_LTXVImgToVideoConditionOnly"


def _as_float(value: Any, default: float, min_value: float, max_value: float) -> float:
    try:
        result = float(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"true", "1", "yes", "on", "开启", "是"}:
            return True
        if text in {"false", "0", "no", "off", "关闭", "否"}:
            return False
    return default


def _downscale_formula(vae: Any) -> tuple[int, int, int]:
    formula = getattr(vae, "downscale_index_formula", None)
    if isinstance(formula, (list, tuple)) and len(formula) >= 3:
        return int(formula[0]), int(formula[1]), int(formula[2])

    spatial = 8
    try:
        if callable(getattr(vae, "spacial_compression_decode", None)):
            spatial = int(vae.spacial_compression_decode())
    except Exception:
        spatial = 8
    return 1, spatial, spatial


def _copy_latent(latent: dict[str, Any]) -> dict[str, Any]:
    copied = dict(latent)
    samples = copied.get("samples")
    if isinstance(samples, torch.Tensor):
        copied["samples"] = samples.clone()
    return copied


class GJJ_LTXVImgToVideoConditionOnly:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": (
                    "VAE",
                    {
                        "display_name": "VAE",
                        "tooltip": "连接 LTXV 使用的视频 VAE。节点不依赖 ComfyUI-LTXVideo，只调用传入 VAE 的 encode。",
                    },
                ),
                "image": (
                    "IMAGE",
                    {
                        "display_name": "参考图像",
                        "tooltip": "用于写入视频 latent 开头帧的参考图像，会自动缩放到 latent 对应的像素尺寸。",
                    },
                ),
                "latent": (
                    "LATENT",
                    {
                        "display_name": "视频Latent",
                        "tooltip": "已有的视频 latent，samples 维度应为 [批次, 通道, 帧, 高, 宽]。",
                    },
                ),
                "strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "条件强度",
                        "tooltip": "写入图像条件的强度。1 表示条件帧完全固定，0 表示条件帧也允许完全加噪。",
                    },
                ),
            },
            "optional": {
                "bypass": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "跳过",
                        "tooltip": "开启后直接输出原 latent，不写入图像条件。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("Latent",)
    OUTPUT_TOOLTIPS = ("写入图像条件和 noise_mask 后的视频 latent。",)
    FUNCTION = "generate"
    CATEGORY = "GJJ/视频模型/LTXV"
    DESCRIPTION = "零依赖移植 LTXVImgToVideoConditionOnly：把参考图像编码进现有视频 latent 的开头帧，并生成控制强度的 noise_mask。"
    GJJ_HELP = {
        "title": "LTXV 图生视频条件写入",
        "description": "从 ComfyUI-LTXVideo 的 LTXVImgToVideoConditionOnly 移植为 GJJ 单节点；不导入源插件，只依赖 ComfyUI 传入的 VAE 和 PyTorch。",
        "usage": [
            "参考图像会按 latent 尺寸自动缩放后送入 VAE encode。",
            "编码得到的图像 latent 会写入视频 latent 的开头帧。",
            "条件强度会转换成 noise_mask：强度越高，开头条件帧越少被噪声破坏。",
        ],
    }

    def encode_image(self, image: torch.Tensor, shape: tuple[int, ...], vae: Any) -> torch.Tensor:
        if not isinstance(image, torch.Tensor):
            raise RuntimeError(f"LTXV 图生视频条件写入失败：参考图像不是 Tensor，而是 {type(image)!r}")
        if image.ndim != 4:
            raise RuntimeError(f"LTXV 图生视频条件写入失败：参考图像维度应为 [B,H,W,C]，实际为 {tuple(image.shape)}")

        _time_scale_factor, height_scale_factor, width_scale_factor = _downscale_formula(vae)
        _batch, _channels, _frames, latent_height, latent_width = shape
        pixel_width = latent_width * width_scale_factor
        pixel_height = latent_height * height_scale_factor

        if image.shape[1] != pixel_height or image.shape[2] != pixel_width:
            pixels = comfy.utils.common_upscale(
                image.movedim(-1, 1),
                pixel_width,
                pixel_height,
                "bilinear",
                "center",
            ).movedim(1, -1)
        else:
            pixels = image

        encode_pixels = pixels[:, :, :, :3]
        encoded = vae.encode(encode_pixels)
        if not isinstance(encoded, torch.Tensor):
            raise RuntimeError(f"LTXV 图生视频条件写入失败：VAE encode 返回的不是 Tensor，而是 {type(encoded)!r}")
        if encoded.ndim != 5:
            raise RuntimeError(f"LTXV 图生视频条件写入失败：VAE encode 输出维度应为 [B,C,T,H,W]，实际为 {tuple(encoded.shape)}")
        return encoded

    def generate(self, image, vae, latent, strength, bypass=False):
        if _as_bool(bypass, False):
            return (latent,)
        if not isinstance(latent, dict) or "samples" not in latent:
            raise RuntimeError("LTXV 图生视频条件写入失败：Latent 输入缺少 samples。")

        result = _copy_latent(latent)
        samples = result["samples"]
        if not isinstance(samples, torch.Tensor):
            raise RuntimeError(f"LTXV 图生视频条件写入失败：samples 不是 Tensor，而是 {type(samples)!r}")
        if samples.ndim != 5:
            raise RuntimeError(f"LTXV 图生视频条件写入失败：samples 维度应为 [B,C,T,H,W]，实际为 {tuple(samples.shape)}")

        strength = _as_float(strength, 1.0, 0.0, 1.0)
        encoded = self.encode_image(image, tuple(samples.shape), vae).to(device=samples.device, dtype=samples.dtype)

        frames_to_write = min(samples.shape[2], encoded.shape[2])
        samples[:, :, :frames_to_write] = encoded[:, :, :frames_to_write]

        noise_mask = torch.ones(
            (1, 1, samples.shape[2], 1, 1),
            dtype=torch.float32,
            device=samples.device,
        )
        noise_mask[:, :, :frames_to_write] = 1.0 - strength

        result["samples"] = samples
        result["noise_mask"] = noise_mask
        return (result,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTXVImgToVideoConditionOnly}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ LTXV图生视频条件"}
