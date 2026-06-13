from __future__ import annotations

import torch
import torch.nn.functional as F


NODE_NAME = "GJJ_WanVideoAddTTMLatents"
NODE_DISPLAY_NAME = "🔗 Wan添加TTM Latent"


class GJJ_WanVideoAddTTMLatents:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "add_ttm"
    DESCRIPTION = (
        "WanVideo TTM (Time-To-Move) Latent 注入的 GJJ 零依赖节点。"
        "将参考 latent 和遮罩注入到图像条件中，供采样器在指定步数范围内使用 TTM 引导。"
        "参考：https://github.com/time-to-move/TTM"
    )
    SEARCH_ALIASES = [
        "WanVideoAddTTMLatents",
        "WanVideo Add TTMLatents",
        "TTM Latents",
        "Time To Move",
        "Wan TTM",
        "Wan添加TTM",
        "TTM Latent",
    ]

    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS",)
    RETURN_NAMES = ("图像条件",)
    OUTPUT_TOOLTIPS = ("包含 TTM 参考 latent、遮罩和步数范围的图像条件，供 WanVideo 采样器使用。",)

    GJJ_HELP = {
        "title": "Wan 添加 TTM Latent",
        "description": "将参考 latent 和遮罩注入图像条件，实现 TTM（Time-To-Move）引导去噪。",
        "usage": [
            "图像条件输入：连接 Wan 空图像条件或其它图像条件节点的输出。",
            "参考 latent：连接一个 LATENT，作为 TTM 的参考 latent。",
            "遮罩：连接 MASK，用于指定 TTM 作用区域。",
            "起始步数 / 结束步数：控制 TTM 引导的去噪步数范围。",
            "输出连接到 WanVideo 采样器的图像条件输入。",
        ],
        "notes": [
            "本节点为 GJJ 零依赖实现，不依赖外部 WanVideoWrapper 插件。",
            "结束步数必须大于等于起始步数，否则会报错。",
            "遮罩会按 4 帧间隔采样，并缩放到 latent 分辨率。",
            "如果参考 latent 通道数为 48，则 VAE 上采样因子自动切换为 16。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "embeds": (
                    "WANVIDIMAGE_EMBEDS",
                    {
                        "display_name": "图像条件",
                        "tooltip": "WanVideo 图像条件（来自空图像条件、I2V 编码等节点）。",
                    },
                ),
                "reference_latents": (
                    "LATENT",
                    {
                        "display_name": "参考latent",
                        "tooltip": "作为 TTM 参考的 latent，通常来自 VAE 编码或 latent 采样。",
                    },
                ),
                "mask": (
                    "MASK",
                    {
                        "display_name": "遮罩",
                        "tooltip": "TTM 作用区域的遮罩，白色区域为 TTM 引导区域。",
                    },
                ),
                "start_step": (
                    "INT",
                    {
                        "default": 0,
                        "min": -1,
                        "max": 1000,
                        "step": 1,
                        "display_name": "起始步数",
                        "tooltip": "TTM 引导的开始去噪步数。-1 表示从第 0 步开始。",
                    },
                ),
                "end_step": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 1000,
                        "step": 1,
                        "display_name": "结束步数",
                        "tooltip": "TTM 引导的结束去噪步数。必须大于等于起始步数。",
                    },
                ),
            },
        }

    def add_ttm(self, embeds, reference_latents, mask, start_step, end_step):
        if end_step < max(0, start_step):
            raise ValueError(
                f"结束步数 ({end_step}) 必须大于等于起始步数 ({start_step})。"
            )

        mask_sampled = mask[::4]
        mask_sampled = mask_sampled.unsqueeze(1).unsqueeze(0)

        vae_upscale_factor = 8
        if reference_latents["samples"].shape[1] == 48:
            vae_upscale_factor = 16

        H_latent = mask_sampled.shape[-2] // vae_upscale_factor
        W_latent = mask_sampled.shape[-1] // vae_upscale_factor
        mask_latent = F.interpolate(
            mask_sampled.float(),
            size=(mask_sampled.shape[2], H_latent, W_latent),
            mode="nearest",
        )

        updated = dict(embeds)
        updated["ttm_reference_latents"] = reference_latents["samples"].squeeze(0)
        updated["ttm_mask"] = mask_latent.squeeze(0).movedim(1, 0)
        updated["ttm_start_step"] = start_step
        updated["ttm_end_step"] = end_step

        return (updated,)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoAddTTMLatents,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
