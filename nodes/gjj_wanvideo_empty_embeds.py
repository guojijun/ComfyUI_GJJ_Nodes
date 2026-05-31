from __future__ import annotations

from typing import Any


NODE_NAME = "GJJ_WanVideoEmptyEmbeds"
NODE_DISPLAY_NAME = "🎬 Wan空图像条件"

WAN_LATENT_CHANNELS = 16
WAN_VAE_STRIDE = (4, 8, 8)


def _extract_control_embeds(control_embeds: Any) -> Any:
    if control_embeds is None:
        return None
    if isinstance(control_embeds, dict):
        return control_embeds.get("control_embeds", None)
    return control_embeds


def _extract_latent_samples(extra_latents: Any) -> Any:
    if extra_latents is None:
        return None
    if not isinstance(extra_latents, dict) or "samples" not in extra_latents:
        raise RuntimeError("额外 latent 输入格式无效：需要 ComfyUI LATENT 字典，并包含 samples 字段。")
    return extra_latents["samples"]


def _latent_spatial_shape(samples: Any) -> tuple[int, int] | None:
    shape = getattr(samples, "shape", None)
    if shape is None:
        return None
    try:
        if len(shape) < 2:
            return None
        return int(shape[-2]), int(shape[-1])
    except Exception:
        return None


class GJJ_WanVideoEmptyEmbeds:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    DESCRIPTION = (
        "WanVideo T2V 空图像条件的 GJJ 零依赖节点。"
        "用于没有参考图时给 WanVideo Sampler 提供 target_shape，也可透传控制条件或首段 latent。"
    )
    SEARCH_ALIASES = [
        "WanVideoEmptyEmbeds",
        "WanVideo Empty Embeds",
        "Empty Embeds",
        "wan empty embeds",
        "Wan空图像条件",
        "空图像条件",
    ]

    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS",)
    RETURN_NAMES = ("图像条件",)
    OUTPUT_TOOLTIPS = ("WanVideo 采样器可读取的空图像条件，包含目标 latent 尺寸和可选控制/额外 latent。",)

    GJJ_HELP = {
        "title": "Wan 空图像条件",
        "description": "没有起始图、结束图或参考图时，用它给 WanVideo Sampler 提供 T2V 所需的空图像条件。",
        "usage": [
            "宽度、高度、帧数要与采样输出目标一致。",
            "普通 T2V 只需要连接本节点输出到采样器的图像条件输入。",
            "Fun-Control / Control LoRA 工作流可把控制条件接到本节点，再输出给采样器。",
            "需要从已有 latent 起步时，可连接额外 latent；它会按原版逻辑作为 index=0 的 extra_latents 传入。",
        ],
        "notes": [
            "本节点不导入外部 WanVideoWrapper 插件，也不加载模型。",
            "target_shape 采用 WanVideo 默认 latent 通道 16、时间步长 4、空间步长 8 计算。",
            "如果只是普通 T2V，不要连接控制条件，避免采样器按 Fun-Control 路径检查模型。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": (
                    "INT",
                    {
                        "default": 832,
                        "min": 64,
                        "max": 8096,
                        "step": 8,
                        "display_name": "宽度",
                        "tooltip": "目标视频宽度，建议与采样器和解码流程保持一致。",
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
                        "tooltip": "目标视频高度，建议与采样器和解码流程保持一致。",
                    },
                ),
                "num_frames": (
                    "INT",
                    {
                        "default": 121,
                        "min": 1,
                        "max": 10000,
                        "step": 4,
                        "display_name": "帧数",
                        "tooltip": "目标视频帧数。WanVideo 内部 latent 帧数会按 (帧数 - 1) / 4 + 1 计算。",
                    },
                ),
            },
            "optional": {
                "control_embeds": (
                    "WANVIDIMAGE_EMBEDS",
                    {
                        "display_name": "控制条件",
                        "tooltip": "可选。Fun-Control、Fun-Camera 或 Control LoRA 工作流使用；普通 T2V 请留空。",
                    },
                ),
                "extra_latents": (
                    "LATENT",
                    {
                        "display_name": "额外latent",
                        "tooltip": "可选。作为原版 Pusa/首段 latent 逻辑中的 index=0 extra_latents 传给采样器。",
                    },
                ),
            },
        }

    def process(
        self,
        width: int,
        height: int,
        num_frames: int,
        control_embeds: Any = None,
        extra_latents: Any = None,
    ):
        width = int(width)
        height = int(height)
        num_frames = int(num_frames)

        target_shape = (
            WAN_LATENT_CHANNELS,
            (num_frames - 1) // WAN_VAE_STRIDE[0] + 1,
            height // WAN_VAE_STRIDE[1],
            width // WAN_VAE_STRIDE[2],
        )

        embeds = {
            "target_shape": target_shape,
            "num_frames": num_frames,
            "control_embeds": _extract_control_embeds(control_embeds),
        }

        latent_samples = _extract_latent_samples(extra_latents)
        if latent_samples is not None:
            latent_spatial = _latent_spatial_shape(latent_samples)
            target_spatial = (target_shape[-2], target_shape[-1])
            if latent_spatial is not None and latent_spatial != target_spatial:
                raise RuntimeError(
                    "Wan 空图像条件的额外 latent 尺寸与目标宽高不一致。\n"
                    f"当前目标为 {width}x{height}，对应 latent {target_spatial[1]}x{target_spatial[0]}；"
                    f"额外 latent 为约 {latent_spatial[1] * 8}x{latent_spatial[0] * 8}，对应 latent {latent_spatial[1]}x{latent_spatial[0]}。\n"
                    "请把本节点的宽度/高度改成额外 latent 的来源分辨率，或用当前目标分辨率重新生成/重新编码额外 latent。"
                )
            embeds["extra_latents"] = [
                {
                    "samples": latent_samples,
                    "index": 0,
                }
            ]

        return (embeds,)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoEmptyEmbeds,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
