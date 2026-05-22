from __future__ import annotations

import torch

from comfy import model_management as mm


NODE_NAME = "GJJ_WanVideoDecode"


def _decode_device():
    return mm.get_torch_device()


def _offload_device():
    return mm.unet_offload_device()


class _ComfyWanVAEAdapter:
    """Expose ComfyUI's native VAE object through the small WanVAE API decode uses."""

    def __init__(self, vae):
        self._vae = vae
        self.dtype = getattr(vae, "vae_dtype", torch.float32)
        self.upsampling_factor = getattr(vae, "spacial_compression_decode", lambda: 8)()

    def to(self, *_args, **_kwargs):
        return self

    def decode(
        self,
        hidden_states,
        device=None,
        tiled=False,
        tile_size=(34, 34),
        tile_stride=(18, 16),
        **_kwargs,
    ):
        if not isinstance(hidden_states, torch.Tensor):
            raise RuntimeError(f"VAE latent 类型无效：{type(hidden_states)!r}")
        if hidden_states.ndim == 4:
            hidden_states = hidden_states.unsqueeze(0)
        if hidden_states.ndim != 5:
            raise RuntimeError(f"VAE latent 维度无效，应为 B/C/T/H/W，实际为：{tuple(hidden_states.shape)}")

        hidden_states = hidden_states.to(device=device if device is not None else hidden_states.device)
        if tiled and hasattr(self._vae, "decode_tiled"):
            overlap_x = max(0, int(tile_size[0]) - int(tile_stride[0]))
            overlap_y = max(0, int(tile_size[1]) - int(tile_stride[1]))
            decoded = self._vae.decode_tiled(
                hidden_states,
                tile_x=int(tile_size[0]),
                tile_y=int(tile_size[1]),
                overlap=max(overlap_x, overlap_y),
            )
        else:
            decoded = self._vae.decode(hidden_states)

        if decoded.ndim == 4:
            decoded = decoded.unsqueeze(0)
        if decoded.ndim != 5:
            raise RuntimeError(f"VAE 解码结果维度异常：{tuple(decoded.shape)}")

        return [video.movedim(-1, 0) for video in decoded]


def _adapt_vae_for_decode(vae):
    if hasattr(vae, "dtype"):
        return vae
    if hasattr(vae, "first_stage_model") and hasattr(vae, "decode"):
        return _ComfyWanVAEAdapter(vae)
    return vae


class GJJ_WanVideoDecode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": ("WANVAE,VAE", {
                    "display_name": "WanVideo VAE",
                    "tooltip": "可接 WanVideo VAE，也可接 GJJ WanVideo模型加载输出的普通 VAE；普通 VAE 会自动按 WanVideo 解码方式适配。",
                }),
                "samples": ("LATENT", {
                    "display_name": "latent",
                    "tooltip": "WanVideo 采样器输出的 LATENT。若其中已包含 video，会按原版逻辑直接转为 IMAGE。",
                }),
                "enable_vae_tiling": ("BOOLEAN", {
                    "default": False,
                    "display_name": "启用 VAE 分块",
                    "tooltip": "显著降低显存占用，但可能在分块步幅边界出现接缝。增大分块尺寸或步幅可减轻接缝。",
                }),
                "tile_x": ("INT", {
                    "default": 272,
                    "min": 40,
                    "max": 2048,
                    "step": 8,
                    "display_name": "分块宽度",
                    "tooltip": "VAE 解码分块宽度，单位像素。数值越小越省显存，但接缝越明显。",
                }),
                "tile_y": ("INT", {
                    "default": 272,
                    "min": 40,
                    "max": 2048,
                    "step": 8,
                    "display_name": "分块高度",
                    "tooltip": "VAE 解码分块高度，单位像素。数值越小越省显存，但接缝越明显。",
                }),
                "tile_stride_x": ("INT", {
                    "default": 144,
                    "min": 32,
                    "max": 2040,
                    "step": 8,
                    "display_name": "横向步幅",
                    "tooltip": "VAE 解码分块横向步幅，单位像素。数值越小重叠越多、显存和耗时越高。",
                }),
                "tile_stride_y": ("INT", {
                    "default": 128,
                    "min": 32,
                    "max": 2040,
                    "step": 8,
                    "display_name": "纵向步幅",
                    "tooltip": "VAE 解码分块纵向步幅，单位像素。数值越小重叠越多、显存和耗时越高。",
                }),
            },
            "optional": {
                "normalization": (["default", "minmax", "none"], {
                    "default": "default",
                    "advanced": True,
                    "display_name": "归一化",
                    "tooltip": "与原版 WanVideoDecode 一致：default 为 [-1,1] 转 [0,1]，minmax 为全局最小最大归一化，none 不归一化。",
                }),
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, tile_x, tile_y, tile_stride_x, tile_stride_y):
        if tile_x <= tile_stride_x:
            return "分块宽度必须大于横向步幅。"
        if tile_y <= tile_stride_y:
            return "分块高度必须大于纵向步幅。"
        return True

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    OUTPUT_TOOLTIPS = ("解码后的视频帧序列，格式为 ComfyUI IMAGE。",)
    FUNCTION = "decode"
    CATEGORY = "GJJ/视频模型/WanVideo"
    DESCRIPTION = "GJJ 零依赖复刻 WanVideoDecode：按 WanVideoWrapper 原版逻辑把 WanVideo latent 解码为 IMAGE。"
    GJJ_HELP = {
        "title": "WanVideo 解码",
        "description": "复刻源 WanVideoDecode 的解码逻辑，支持普通 WanVAE、TAEHV、VAE 分块、循环 latent、end_image 和 FlashVSR 低清条件。",
        "runtime": "不依赖 ComfyUI-WanVideoWrapper 插件本体；只需要传入可用的 WanVideo VAE 对象。pip 运行时依赖仍按 GJJ WanVideo 运行时方案安装。",
    }

    def decode(self, vae, samples, enable_vae_tiling, tile_x, tile_y, tile_stride_x, tile_stride_y, normalization="default"):
        device = _decode_device()
        offload_device = _offload_device()
        vae = _adapt_vae_for_decode(vae)

        mm.soft_empty_cache()
        video = samples.get("video", None)
        if video is not None:
            video.clamp_(-1.0, 1.0)
            video.add_(1.0).div_(2.0)
            return (video.cpu().float(),)

        latents = samples["samples"].clone()
        end_image = samples.get("end_image", None)
        has_ref = samples.get("has_ref", False)
        drop_last = samples.get("drop_last", False)
        is_looped = samples.get("looped", False)
        flashvsr_LQ_images = samples.get("flashvsr_LQ_images", None)

        vae.to(device)
        latents = latents.to(device=device, dtype=vae.dtype)

        mm.soft_empty_cache()

        if has_ref:
            latents = latents[:, :, 1:]
        if drop_last:
            latents = latents[:, :, :-1]

        if type(vae).__name__ == "TAEHV":
            cond = flashvsr_LQ_images.to(vae.dtype) if flashvsr_LQ_images is not None else None
            images = vae.decode_video(latents.permute(0, 2, 1, 3, 4), cond=cond)[0].permute(1, 0, 2, 3)
            images = torch.clamp(images, 0.0, 1.0)
            images = images.permute(1, 2, 3, 0).cpu().float()
            return (images,)

        images = vae.decode(
            latents,
            device=device,
            end_=(end_image is not None),
            tiled=enable_vae_tiling,
            tile_size=(tile_x // 8, tile_y // 8),
            tile_stride=(tile_stride_x // 8, tile_stride_y // 8),
        )[0]

        images = images.cpu().float()

        if normalization != "none":
            if normalization == "minmax":
                images.sub_(images.min()).div_(images.max() - images.min())
            else:
                images.clamp_(-1.0, 1.0)
                images.add_(1.0).div_(2.0)

        if is_looped:
            temp_latents = torch.cat([latents[:, :, -3:]] + [latents[:, :, :2]], dim=2)
            factor = getattr(vae, "upsampling_factor", 8)
            temp_images = vae.decode(
                temp_latents,
                device=device,
                end_=(end_image is not None),
                tiled=enable_vae_tiling,
                tile_size=(tile_x // factor, tile_y // factor),
                tile_stride=(tile_stride_x // factor, tile_stride_y // factor),
            )[0]
            temp_images = temp_images.cpu().float()
            temp_images = (temp_images - temp_images.min()) / (temp_images.max() - temp_images.min())
            images = torch.cat([temp_images[:, 9:].to(images), images[:, 5:]], dim=1)

        if end_image is not None:
            images = images[:, 0:-1]

        vae.to(offload_device)
        mm.soft_empty_cache()

        images.clamp_(0.0, 1.0)

        return (images.permute(1, 2, 3, 0),)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoDecode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "GJJ · 🎞️ WanVideo 解码",
}
