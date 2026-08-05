from __future__ import annotations

import torch
import torch.nn.functional as F


NODE_KEY = "GJJ_InjectLatentNoise+"
NODE_DISPLAY_NAME = "GJJ · 潜空间注入噪声+"
DESCRIPTION = (
    "向输入 Latent 注入可控强度的随机噪声；支持按原 Latent 的统计分布归一化噪声，"
    "并可通过遮罩限制注噪区域。"
)


class GJJ_InjectLatentNoisePlus:
    CATEGORY = "GJJ/⚙️ 采样/潜空间"
    FUNCTION = "inject_noise"
    DESCRIPTION = DESCRIPTION
    SEARCH_ALIASES = [
        "Inject Latent Noise",
        "InjectLatentNoise+",
        "latent noise",
        "潜空间噪声",
        "注入噪声",
    ]

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("注噪Latent",)
    OUTPUT_TOOLTIPS = ("已按设置注入随机噪声的 Latent；输入中的其他附加信息会原样保留。",)

    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": DESCRIPTION,
        "model_download_url": "",
        "dependencies": [
            "零第三方自定义节点依赖。",
            "仅使用 ComfyUI 运行环境自带的 PyTorch。",
        ],
        "usage": [
            "连接需要处理的 Latent，并设置噪声种子与噪声强度。",
            "噪声强度为 0 时不改变样本；正值加入噪声，负值反向叠加同一份噪声。",
            "开启噪声归一化后，随机噪声会匹配输入 Latent 的整体均值和标准差。",
            "可选遮罩中白色区域注入噪声，黑色区域保留原 Latent，灰色区域按比例混合。",
            "遮罩会自动缩放到 Latent 尺寸，并自动适配或截取批次数量。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent": (
                    "LATENT",
                    {
                        "display_name": "输入Latent",
                        "tooltip": "需要注入噪声的潜空间数据；除 samples 外的附加字段会原样保留。",
                    },
                ),
                "noise_seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "噪声种子",
                        "tooltip": "随机噪声种子。相同输入、种子与设置会生成相同结果。",
                    },
                ),
                "noise_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": -20.0,
                        "max": 20.0,
                        "step": 0.01,
                        "round": 0.01,
                        "display_name": "噪声强度",
                        "tooltip": "注入噪声的倍率。0 不注噪；1 为原始噪声幅度；允许负值反向叠加。",
                    },
                ),
                "normalize": (
                    ["关闭", "开启"],
                    {
                        "default": "关闭",
                        "display_name": "噪声归一化",
                        "tooltip": "开启后，使随机噪声匹配输入 Latent 的整体均值与标准差。",
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {
                        "display_name": "注噪遮罩",
                        "tooltip": "可选。白色区域注噪，黑色区域保持原样，灰色区域按遮罩强度混合。",
                    },
                ),
            },
        }

    def inject_noise(self, latent, noise_seed, noise_strength, normalize="关闭", mask=None):
        torch.manual_seed(noise_seed)

        noise_latent = latent.copy()
        original_samples = noise_latent["samples"].clone()
        random_noise = torch.randn_like(original_samples)

        if normalize in {"开启", "true", True}:
            mean = original_samples.mean()
            std = original_samples.std()
            random_noise = random_noise * std + mean

        noised_samples = original_samples + random_noise * noise_strength

        if mask is not None:
            prepared_mask = F.interpolate(
                mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])).to(
                    device=noised_samples.device,
                    dtype=noised_samples.dtype,
                ),
                size=(noised_samples.shape[2], noised_samples.shape[3]),
                mode="bilinear",
            )
            prepared_mask = prepared_mask.expand(
                -1, noised_samples.shape[1], -1, -1
            ).clamp(0.0, 1.0)

            if prepared_mask.shape[0] < noised_samples.shape[0]:
                repeats = (
                    (noised_samples.shape[0] - 1) // prepared_mask.shape[0] + 1
                )
                prepared_mask = prepared_mask.repeat(repeats, 1, 1, 1)[
                    : noised_samples.shape[0]
                ]
            elif prepared_mask.shape[0] > noised_samples.shape[0]:
                prepared_mask = prepared_mask[: noised_samples.shape[0]]

            noised_samples = (
                prepared_mask * noised_samples
                + (1.0 - prepared_mask) * original_samples
            )

        noise_latent["samples"] = noised_samples
        return (noise_latent,)


NODE_CLASS_MAPPINGS = {
    NODE_KEY: GJJ_InjectLatentNoisePlus,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_KEY: NODE_DISPLAY_NAME,
}
