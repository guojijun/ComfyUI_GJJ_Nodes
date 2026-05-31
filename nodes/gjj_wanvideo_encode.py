from __future__ import annotations

from typing import Any

import torch
import comfy.model_management as mm
from comfy.utils import common_upscale


NODE_NAME = "GJJ_WanVideoEncode"
NODE_DISPLAY_NAME = "🎞️ WanVideo编码"


def _load_wanvideo_helpers():
    try:
        from ..vendor.wanvideo_wrapper.utils import add_noise_to_reference_video, log
    except Exception as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo 编码 runtime 加载失败。无需安装外部 WanVideoWrapper 插件；"
            f"如果是运行库缺失，请先补齐 GJJ WanVideo 依赖。\n错误信息：{error}"
        ) from error

    try:
        from ..vendor.wanvideo_wrapper.taehv import TAEHV
    except Exception:
        TAEHV = None

    return add_noise_to_reference_video, log, TAEHV


def _is_taehv(vae: Any, taehv_cls: Any) -> bool:
    return (taehv_cls is not None and isinstance(vae, taehv_cls)) or type(vae).__name__ == "TAEHV"


def _safe_vae_to(vae: Any, device: Any) -> None:
    if hasattr(vae, "to"):
        vae.to(device)
        return
    model = getattr(vae, "model", None)
    if hasattr(model, "to"):
        model.to(device)


class GJJ_WanVideoEncode:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "encode"
    DESCRIPTION = (
        "把 IMAGE 帧序列编码为 WanVideo latent。"
        "等价复刻 WanVideoWrapper 的 WanVideo Encode，使用 GJJ 内置 vendor runtime。"
    )
    SEARCH_ALIASES = [
        "WanVideo Encode",
        "WanVideoEncode",
        "Wan编码",
        "视频编码",
        "WANVAE encode",
    ]

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("samples",)
    OUTPUT_TOOLTIPS = ("WanVideo 采样器可用的 latent；如果接入 mask，会随 latent 一起作为 noise_mask 输出。",)

    GJJ_HELP = {
        "title": "WanVideo 编码",
        "description": "把视频帧 IMAGE 编码成 WanVideo latent，常用于视频转视频、续帧或把预处理帧送入采样器。",
        "usage": [
            "VAE 接 GJJ WanVideo VAE 加载器输出的 WANVAE。",
            "image 接视频帧序列，节点会自动裁切到 16 的倍数尺寸。",
            "显存不足时开启 VAE 分块；tile 越小越省显存，但越容易出现块状痕迹。",
        ],
        "notes": [
            "本节点不依赖外部 ComfyUI-WanVideoWrapper 插件。",
            "噪声增强和 latent 强度用于 LeapFusion/I2V 等需要更大运动自由度的工作流，普通视频转 latent 保持默认即可。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": (
                    "WANVAE",
                    {
                        "display_name": "WANVAE",
                        "tooltip": "GJJ WanVideo VAE 加载器输出的 WANVAE。",
                    },
                ),
                "image": (
                    "IMAGE",
                    {
                        "display_name": "图像帧",
                        "tooltip": "要编码的视频帧序列，形状通常为 B/H/W/C。",
                    },
                ),
                "enable_vae_tiling": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用VAE分块",
                        "tooltip": "显存不足时开启。会明显降低显存占用，但可能增加块状痕迹。",
                    },
                ),
                "tile_x": (
                    "INT",
                    {
                        "default": 272,
                        "min": 64,
                        "max": 2048,
                        "step": 1,
                        "display_name": "分块宽度",
                        "tooltip": "VAE 分块宽度，越小越省显存。",
                    },
                ),
                "tile_y": (
                    "INT",
                    {
                        "default": 272,
                        "min": 64,
                        "max": 2048,
                        "step": 1,
                        "display_name": "分块高度",
                        "tooltip": "VAE 分块高度，越小越省显存。",
                    },
                ),
                "tile_stride_x": (
                    "INT",
                    {
                        "default": 144,
                        "min": 32,
                        "max": 2048,
                        "step": 32,
                        "display_name": "横向步长",
                        "tooltip": "VAE 分块横向步长，通常小于分块宽度以保留重叠区域。",
                    },
                ),
                "tile_stride_y": (
                    "INT",
                    {
                        "default": 128,
                        "min": 32,
                        "max": 2048,
                        "step": 32,
                        "display_name": "纵向步长",
                        "tooltip": "VAE 分块纵向步长，通常小于分块高度以保留重叠区域。",
                    },
                ),
                "noise_aug_strength": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "display_name": "噪声增强",
                        "tooltip": "编码前给参考视频加入噪声。普通编码保持 0；需要更大运动时可少量增加。",
                    },
                ),
                "latent_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "display_name": "latent强度",
                        "tooltip": "编码结果的额外倍率。普通编码保持 1.0。",
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {
                        "display_name": "遮罩",
                        "tooltip": "可选噪声遮罩，会作为 LATENT 的 noise_mask 一起传给下游采样器。",
                    },
                ),
            },
        }

    @staticmethod
    def VALIDATE_INPUTS(tile_x, tile_y, tile_stride_x, tile_stride_y, **_kwargs):
        if int(tile_x) <= int(tile_stride_x):
            return "分块宽度必须大于横向步长。"
        if int(tile_y) <= int(tile_stride_y):
            return "分块高度必须大于纵向步长。"
        return True

    def encode(
        self,
        vae,
        image,
        enable_vae_tiling,
        tile_x,
        tile_y,
        tile_stride_x,
        tile_stride_y,
        noise_aug_strength=0.0,
        latent_strength=1.0,
        mask=None,
    ):
        add_noise_to_reference_video, log, TAEHV = _load_wanvideo_helpers()

        device = mm.get_torch_device()
        offload_device = mm.unet_offload_device()
        _safe_vae_to(vae, device)

        pixels = image.clone()
        if pixels.ndim != 4:
            raise RuntimeError(f"WanVideo 编码需要 IMAGE 批次，实际维度为：{tuple(pixels.shape)}")

        _, height, width, _ = pixels.shape
        if width % 16 != 0 or height % 16 != 0:
            new_height = (height // 16) * 16
            new_width = (width // 16) * 16
            if new_width <= 0 or new_height <= 0:
                raise RuntimeError(f"图像尺寸过小，无法对齐到 16 的倍数：{width}x{height}")
            log.warning(f"GJJ WanVideoEncode: 图像尺寸 {width}x{height} 不能被 16 整除，已调整为 {new_width}x{new_height}")
            pixels = common_upscale(pixels.movedim(-1, 1), new_width, new_height, "lanczos", "disabled").movedim(1, -1)

        if pixels.shape[-1] == 4:
            pixels = pixels[..., :3]

        dtype = getattr(vae, "dtype", torch.float32)
        video = pixels.to(device=device, dtype=dtype).unsqueeze(0).permute(0, 4, 1, 2, 3)

        if float(noise_aug_strength) > 0.0:
            video = add_noise_to_reference_video(video, ratio=float(noise_aug_strength))

        if _is_taehv(vae, TAEHV):
            latents = vae.encode_video(video.permute(0, 2, 1, 3, 4), parallel=False)
            latents = latents.permute(0, 2, 1, 3, 4)
        else:
            upsampling_factor = int(getattr(vae, "upsampling_factor", 8) or 8)
            latents = vae.encode(
                video * 2.0 - 1.0,
                device=device,
                tiled=bool(enable_vae_tiling),
                tile_size=(int(tile_x) // upsampling_factor, int(tile_y) // upsampling_factor),
                tile_stride=(int(tile_stride_x) // upsampling_factor, int(tile_stride_y) // upsampling_factor),
            )

        if float(latent_strength) != 1.0:
            latents = latents * float(latent_strength)

        _safe_vae_to(vae, offload_device)
        mm.soft_empty_cache()

        latents = latents.cpu()
        log.info(f"GJJ WanVideoEncode: Encoded latents shape {tuple(latents.shape)}")
        return ({"samples": latents, "noise_mask": mask},)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
