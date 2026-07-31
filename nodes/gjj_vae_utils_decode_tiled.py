from __future__ import annotations

import torch
import torch.nn.functional as F


NODE_NAME = "GJJ_VAEUtils_VAEDecodeTiled"
NODE_DISPLAY_NAME = "GJJ · 🧩 VAE 分块解码"


class GJJ_VAEUtils_VAEDecodeTiled:
    """兼容 VAEUtils_VAEDecodeTiled 的零外部插件依赖实现。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": (
                    "LATENT",
                    {
                        "display_name": "潜空间",
                        "tooltip": "连接采样器输出的 LATENT 潜空间数据。",
                    },
                ),
                "vae": (
                    "VAE",
                    {
                        "display_name": "VAE 模型",
                        "tooltip": "用于把潜空间解码为图像；兼容普通图像 VAE、视频 VAE 和多通道放大 VAE。",
                    },
                ),
                "upscale": (
                    "INT",
                    {
                        "default": -1,
                        "min": -1,
                        "display_name": "像素重排倍数",
                        "tooltip": "解码后的像素重排放大倍数；-1 表示根据输出通道数自动判断。",
                    },
                ),
                "tile": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用分块解码",
                        "tooltip": "开启后按空间切片解码，可显著降低大图 VAE 解码时的显存占用。",
                    },
                ),
                "tile_size": (
                    "INT",
                    {
                        "default": 512,
                        "min": 64,
                        "max": 4096,
                        "step": 32,
                        "display_name": "分块尺寸",
                        "tooltip": "空间切片的像素尺寸。数值越小越省显存，但解码更慢且接缝风险更高。",
                    },
                ),
                "overlap": (
                    "INT",
                    {
                        "default": 64,
                        "min": 0,
                        "max": 4096,
                        "step": 32,
                        "display_name": "分块重叠",
                        "tooltip": "相邻空间切片的像素重叠范围，用于柔化切片接缝。",
                    },
                ),
                "temporal_size": (
                    "INT",
                    {
                        "default": 4096,
                        "min": 8,
                        "max": 4096,
                        "step": 4,
                        "display_name": "时间分块帧数",
                        "tooltip": "仅视频 VAE 使用：每次解码的帧数。",
                    },
                ),
                "temporal_overlap": (
                    "INT",
                    {
                        "default": 64,
                        "min": 4,
                        "max": 4096,
                        "step": 4,
                        "display_name": "时间重叠帧数",
                        "tooltip": "仅视频 VAE 使用：时间切片的重叠帧数。",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    OUTPUT_TOOLTIPS = ("完成分块解码及可选像素重排放大的图像。",)
    FUNCTION = "decode"
    CATEGORY = "GJJ/🖼️ 图像/处理"
    DESCRIPTION = "零外部插件依赖的 VAE 分块解码节点，兼容 VAEUtils_VAEDecodeTiled 的输入和处理行为。"
    SEARCH_ALIASES = ["VAE分块解码", "VAE切片解码", "VAEDecodeTiled", "VAE Utils", "零依赖"]
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "version": "1.0.0",
        "author": "GJJ Custom Nodes Team",
        "description": DESCRIPTION,
        "dependencies": ["仅使用 ComfyUI 自带的 PyTorch 与 VAE 接口，无需安装 ComfyUI-VAE-Utils。"],
        "features": [
            {
                "name": "🧩 空间分块解码",
                "description": "把大尺寸潜空间拆成重叠切片解码，降低峰值显存占用。",
            },
            {
                "name": "🎞️ 视频 VAE 兼容",
                "description": "自动读取 VAE 的时间压缩倍率，并换算时间分块与重叠帧数。",
            },
            {
                "name": "🔎 多通道自动放大",
                "description": "可从输出通道数自动判断 Pixel Shuffle 倍数；12 通道会自动执行 2× 重排。",
            },
            {
                "name": "🛡️ 输出范围修正",
                "description": "检测到部分版本返回 [-1, 1] 图像时，自动修正到 ComfyUI 使用的 [0, 1]。",
            },
        ],
        "inputs": {
            "潜空间": {"type": "LATENT", "description": "采样器生成、等待 VAE 解码的潜空间数据。"},
            "VAE 模型": {"type": "VAE", "description": "负责解码的 VAE 模型。"},
            "像素重排倍数": {"type": "INT", "description": "-1 自动判断；1 不重排；2 表示 2× Pixel Shuffle。"},
            "启用分块解码": {"type": "BOOLEAN", "description": "显存不足或输出尺寸较大时建议开启。"},
            "分块尺寸": {"type": "INT", "description": "每个空间切片的像素尺寸，默认 512。"},
            "分块重叠": {"type": "INT", "description": "相邻空间切片的重叠像素，默认 64。"},
            "时间分块帧数": {"type": "INT", "description": "视频 VAE 每批处理的帧数；图像 VAE 会忽略。"},
            "时间重叠帧数": {"type": "INT", "description": "视频时间切片的重叠帧数；图像 VAE 会忽略。"},
        },
        "outputs": {
            "图像": {"type": "IMAGE", "description": "解码、展平并完成可选像素重排后的图像批次。"},
        },
        "usage_notes": [
            "普通 VAE 可保持像素重排倍数为 -1，此时 RGB 输出会自动按 1× 处理。",
            "JoyAI 2× 专用 VAE 输出 12 通道时，-1 会自动识别为 2× 放大。",
            "开启分块后，如果重叠值过大，节点会自动限制到分块尺寸的四分之一。",
        ],
    }

    def decode(self, samples, vae, upscale, tile, tile_size, overlap, temporal_size, temporal_overlap):
        if not isinstance(samples, dict) or "samples" not in samples:
            raise ValueError("LATENT 输入缺少 samples 张量。")

        if tile_size < overlap * 4:
            overlap = tile_size // 4
        if temporal_size < temporal_overlap * 2:
            temporal_overlap = temporal_overlap // 2

        temporal_compression = vae.temporal_compression_decode()
        if temporal_compression is not None:
            temporal_size = max(2, temporal_size // temporal_compression)
            temporal_overlap = max(1, min(temporal_size // 2, temporal_overlap // temporal_compression))
        else:
            temporal_size = None
            temporal_overlap = None

        compression = vae.spacial_compression_decode()
        if tile:
            images = vae.decode_tiled(
                samples["samples"],
                tile_x=tile_size // compression,
                tile_y=tile_size // compression,
                overlap=overlap // compression,
                tile_t=temporal_size,
                overlap_t=temporal_overlap,
            )
        else:
            images = vae.decode(samples["samples"])

        if len(images.shape) == 5:
            images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])

        # 兼容部分 ComfyUI 版本未走 process_output、返回 [-1, 1] 的情况。
        if images.numel() and images.min() < -0.1:
            images = torch.clamp((images.float() + 1.0) / 2.0, min=0.0, max=1.0)

        if upscale < 1:
            channels = images.shape[-1]
            if channels == 3:
                upscale = 1
            elif channels % 3 == 0:
                upscale = round((channels // 3) ** 0.5)
            else:
                raise ValueError("无法自动判断放大倍数，请手动设置 upscale。")

        if upscale > 1:
            expected_channels = 3 * int(upscale) ** 2
            if images.shape[-1] != expected_channels:
                raise ValueError(
                    f"像素重排需要 {expected_channels} 个输出通道，当前为 {images.shape[-1]}；"
                    "请检查 upscale 设置或 VAE 是否匹配。"
                )
            images = F.pixel_shuffle(images.movedim(-1, 1), upscale_factor=int(upscale)).movedim(1, -1)

        return (images,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VAEUtils_VAEDecodeTiled}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
