from __future__ import annotations

from typing import Any

import torch


NODE_NAME = "GJJ_WanVideoImageToVideoEncode"
NODE_DISPLAY_NAME = "🖼️ Wan图生视频编码"


class _NoopModel:
    def to(self, *_args, **_kwargs):
        return self


class _ComfyWanI2VVAEAdapter:
    """Expose ComfyUI's native VAE through the WanVideoWrapper I2V encode API."""

    def __init__(self, vae: Any):
        self._vae = vae
        self.dtype = getattr(vae, "vae_dtype", torch.float32)
        self.model = _NoopModel()
        try:
            self.upsampling_factor = int(vae.spacial_compression_encode())
        except Exception:
            self.upsampling_factor = 8

    def to(self, *_args, **_kwargs):
        return self

    def encode(
        self,
        videos,
        device: Any = None,
        tiled: bool = False,
        end_: bool = False,
        tile_size: tuple[int, int] | None = None,
        tile_stride: tuple[int, int] | None = None,
        **_kwargs,
    ):
        if end_:
            print("[GJJ Wan I2V] 普通 VAE 不支持 WanVideoWrapper 的 end_ 双端编码，已按普通视频编码处理。")

        if isinstance(videos, torch.Tensor):
            if videos.ndim == 4:
                iterable = [videos]
            elif videos.ndim == 5:
                iterable = [video for video in videos]
            else:
                raise RuntimeError(f"VAE 视频输入维度无效：{tuple(videos.shape)}")
        else:
            iterable = list(videos)

        latents = []
        for video in iterable:
            if not isinstance(video, torch.Tensor) or video.ndim != 4:
                raise RuntimeError(f"VAE 视频帧维度无效，应为 C/T/H/W，实际为：{getattr(video, 'shape', None)}")

            pixels = ((video.movedim(0, -1) + 1.0) / 2.0).clamp(0.0, 1.0)
            pixels = pixels.to(device=device if device is not None else pixels.device, dtype=torch.float32)

            if tiled and hasattr(self._vae, "encode_tiled"):
                kwargs: dict[str, Any] = {}
                if tile_size is not None:
                    kwargs["tile_x"] = int(tile_size[1]) * self.upsampling_factor
                    kwargs["tile_y"] = int(tile_size[0]) * self.upsampling_factor
                if tile_stride is not None:
                    stride_x = int(tile_stride[1]) * self.upsampling_factor
                    stride_y = int(tile_stride[0]) * self.upsampling_factor
                    tile_x = int(kwargs.get("tile_x", 512))
                    tile_y = int(kwargs.get("tile_y", 512))
                    kwargs["overlap"] = max(0, min(tile_x - stride_x, tile_y - stride_y))
                encoded = self._vae.encode_tiled(pixels, **kwargs)
            else:
                encoded = self._vae.encode(pixels)

            if encoded.ndim == 5 and int(encoded.shape[0]) == 1:
                encoded = encoded[0]
            elif encoded.ndim != 4:
                raise RuntimeError(f"VAE 编码结果维度异常：{tuple(encoded.shape)}")
            latents.append(encoded.to(dtype=torch.float32))

        return torch.stack(latents)


def _adapt_vae_for_i2v(vae: Any) -> Any:
    if hasattr(vae, "dtype") and hasattr(vae, "upsampling_factor") and hasattr(vae, "encode"):
        return vae
    if hasattr(vae, "first_stage_model") and hasattr(vae, "encode"):
        return _ComfyWanI2VVAEAdapter(vae)
    return vae


def _load_wanvideo_runtime():
    try:
        from ..vendor.wanvideo_wrapper import nodes as wan_nodes
    except Exception as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo I2V 编码 runtime 加载失败。无需安装 WanVideoWrapper 插件本体；"
            f"如果是 pip 运行库缺失，请按 GJJ 的 WanVideo 运行时依赖方案安装。\n错误信息：{error}"
        ) from error
    return wan_nodes


class GJJ_WanVideoImageToVideoEncode:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    DESCRIPTION = (
        "WanVideo 图生视频条件编码的 GJJ 零依赖节点。"
        "内部调用 GJJ vendor 中的 WanVideoImageToVideoEncode，不依赖外部 ComfyUI-WanVideoWrapper 插件。"
    )
    SEARCH_ALIASES = [
        "WanVideoImageToVideoEncode",
        "WanVideo I2V Encode",
        "wan i2v",
        "Wan图生视频",
        "图生视频编码",
    ]

    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS",)
    RETURN_NAMES = ("图生视频条件",)
    OUTPUT_TOOLTIPS = ("WanVideo 采样器可读取的 I2V 图像条件，包含图像 latent、mask 和可选 CLIP 图像上下文。",)

    GJJ_HELP = {
        "title": "Wan 图生视频编码",
        "description": "把起始图、结束图和可选控制条件编码为 WanVideo 采样器使用的图像条件。",
        "usage": [
            "Wan VAE 接 GJJ WanVideo VAE 加载器输出；也兼容 ComfyUI 普通 VAE。",
            "起始图可单独使用；只接结束图时会自动按 Fun/FLF2V 逻辑处理。",
            "输出连接到 GJJ WanVideo Sampler 的图像条件输入。",
        ],
        "notes": [
            "本节点只使用 GJJ vendor/wanvideo_wrapper 内置 runtime。",
            "普通 VAE 可完成基础编码；若需要原版 end_ 双端编码细节，优先使用 GJJ WanVideo VAE 加载器输出的 WANVAE。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": (
                    "WANVAE,VAE",
                    {
                        "display_name": "Wan VAE",
                        "tooltip": "可接 GJJ WanVideo VAE，也可接 ComfyUI 普通 VAE；普通 VAE 会自动适配基础 I2V 编码。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 832,
                        "min": 64,
                        "max": 8096,
                        "step": 8,
                        "display_name": "宽度",
                        "tooltip": "编码目标宽度，建议与采样宽度一致。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 480,
                        "min": 64,
                        "max": 8096,
                        "step": 8,
                        "display_name": "高度",
                        "tooltip": "编码目标高度，建议与采样高度一致。",
                    },
                ),
                "num_frames": (
                    "INT",
                    {
                        "default": 81,
                        "min": 1,
                        "max": 10000,
                        "step": 4,
                        "display_name": "帧数",
                        "tooltip": "目标视频帧数，会按 WanVideo 的 4n+1 规则自动对齐。",
                    },
                ),
                "noise_aug_strength": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "display_name": "参考图噪声",
                        "tooltip": "给参考图加入噪声，适当增加可带来更多运动。",
                    },
                ),
                "start_latent_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "display_name": "起始latent强度",
                        "tooltip": "起始帧 latent 的额外倍率。降低可增加运动自由度。",
                    },
                ),
                "end_latent_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "display_name": "结束latent强度",
                        "tooltip": "结束帧 latent 的额外倍率。降低可增加运动自由度。",
                    },
                ),
                "force_offload": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "编码后卸载VAE",
                        "tooltip": "编码完成后把 VAE 移回卸载设备，降低显存占用。",
                    },
                ),
            },
            "optional": {
                "start_image": (
                    "IMAGE",
                    {
                        "display_name": "起始图",
                        "tooltip": "图生视频的首帧或起始参考图。",
                    },
                ),
                "end_image": (
                    "IMAGE",
                    {
                        "display_name": "结束图",
                        "tooltip": "可选结束帧。首尾帧模型或 Fun/FLF2V 流程中使用。",
                    },
                ),
                "clip_embeds": (
                    "WANVIDIMAGE_CLIPEMBEDS",
                    {
                        "display_name": "CLIP图像条件",
                        "tooltip": "可选。由 WanVideo CLIP Vision 编码节点输出。",
                    },
                ),
                "control_embeds": (
                    "WANVIDIMAGE_EMBEDS",
                    {
                        "display_name": "控制条件",
                        "tooltip": "可选。Fun 模型或控制模型使用的控制条件。",
                    },
                ),
                "fun_or_fl2v_model": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "Fun/FLF2V",
                        "tooltip": "使用官方 FLF2V 或 Fun 模型时开启。只接结束图时会自动按开启处理。",
                    },
                ),
                "temporal_mask": (
                    "MASK",
                    {
                        "display_name": "时间遮罩",
                        "tooltip": "可选。按时间帧控制哪些位置使用图像条件。",
                    },
                ),
                "extra_latents": (
                    "LATENT",
                    {
                        "display_name": "额外latent",
                        "tooltip": "可选。插入到输入前端的额外 latent，常用于参考图扩展流程。",
                    },
                ),
                "tiled_vae": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "分块VAE",
                        "tooltip": "开启后使用分块 VAE 编码以降低显存占用，速度会变慢。",
                    },
                ),
                "add_cond_latents": (
                    "ADD_COND_LATENTS",
                    {
                        "advanced": True,
                        "display_name": "附加条件latent",
                        "tooltip": "高级输入。用于原版 WanVideoWrapper 的附加条件 latent 实验流程。",
                    },
                ),
                "augment_empty_frames": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.01,
                        "advanced": True,
                        "display_name": "空帧增强",
                        "tooltip": "实验选项。用起始图差值增强空帧运动。",
                    },
                ),
                "empty_frame_pad_image": (
                    "IMAGE",
                    {
                        "advanced": True,
                        "display_name": "空帧填充图",
                        "tooltip": "可选。用指定图片填充空帧，常用于 SVI-shot / SVI 2.0 LoRA。",
                    },
                ),
            },
        }

    def process(
        self,
        vae,
        width: int,
        height: int,
        num_frames: int,
        noise_aug_strength: float,
        start_latent_strength: float,
        end_latent_strength: float,
        force_offload: bool,
        start_image=None,
        end_image=None,
        clip_embeds=None,
        control_embeds=None,
        fun_or_fl2v_model: bool = True,
        temporal_mask=None,
        extra_latents=None,
        tiled_vae: bool = False,
        add_cond_latents=None,
        augment_empty_frames: float = 0.0,
        empty_frame_pad_image=None,
    ):
        wan_nodes = _load_wanvideo_runtime()
        encoder = wan_nodes.WanVideoImageToVideoEncode()
        return encoder.process(
            width=int(width),
            height=int(height),
            num_frames=int(num_frames),
            force_offload=bool(force_offload),
            noise_aug_strength=float(noise_aug_strength),
            start_latent_strength=float(start_latent_strength),
            end_latent_strength=float(end_latent_strength),
            start_image=start_image,
            end_image=end_image,
            control_embeds=control_embeds,
            fun_or_fl2v_model=bool(fun_or_fl2v_model),
            temporal_mask=temporal_mask,
            extra_latents=extra_latents,
            clip_embeds=clip_embeds,
            tiled_vae=bool(tiled_vae),
            add_cond_latents=add_cond_latents,
            vae=_adapt_vae_for_i2v(vae),
            augment_empty_frames=float(augment_empty_frames),
            empty_frame_pad_image=empty_frame_pad_image,
        )


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoImageToVideoEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
