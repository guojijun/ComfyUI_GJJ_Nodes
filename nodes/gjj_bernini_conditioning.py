from __future__ import annotations

import logging
from typing import Any

import torch

import comfy.utils
import node_helpers


LOGGER = logging.getLogger("GJJ.BerniniConditioning")

NODE_NAME = "GJJ_BerniniConditioning"
COMPAT_NODE_NAME = "BerniniConditioning"
NODE_DISPLAY_NAME = "🧩 Bernini条件（兼容）"
COMPAT_NODE_DISPLAY_NAME = "Bernini Conditioning"

WAN_LATENT_CHANNELS = 16
WAN_TEMPORAL_STRIDE = 4
WAN_SPATIAL_STRIDE = 8
MAX_REFERENCE_IMAGES = 10


def _as_int(value: Any, default: int, minimum: int = 1) -> int:
    try:
        value = int(value)
    except Exception:
        value = default
    return max(minimum, value)


def _snap(value: int, stride: int, minimum: int | None = None) -> int:
    stride = max(1, int(stride))
    minimum = stride if minimum is None else max(stride, int(minimum))
    return max(minimum, int(value) // stride * stride)


def _vae_scales(vae: Any) -> tuple[int, int, int, int]:
    latent_channels = _as_int(getattr(vae, "latent_channels", WAN_LATENT_CHANNELS), WAN_LATENT_CHANNELS)
    temporal_stride = WAN_TEMPORAL_STRIDE
    height_stride = WAN_SPATIAL_STRIDE
    width_stride = WAN_SPATIAL_STRIDE

    formula = getattr(vae, "downscale_index_formula", None)
    if isinstance(formula, (tuple, list)) and len(formula) >= 3:
        temporal_stride = _as_int(formula[0], temporal_stride)
        height_stride = _as_int(formula[1], height_stride)
        width_stride = _as_int(formula[2], width_stride)
    else:
        spatial = getattr(vae, "spacial_compression_encode", None)
        if callable(spatial):
            try:
                height_stride = width_stride = _as_int(spatial(), WAN_SPATIAL_STRIDE)
            except Exception:
                pass

    return latent_channels, temporal_stride, height_stride, width_stride


def _latent_t(length: int, temporal_stride: int) -> int:
    return ((max(1, int(length)) - 1) // max(1, int(temporal_stride))) + 1


def _resize_exact(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    image = image[:, :, :, :3]
    if int(image.shape[1]) == int(height) and int(image.shape[2]) == int(width):
        return image
    return comfy.utils.common_upscale(
        image.movedim(-1, 1),
        int(width),
        int(height),
        "area",
        "center",
    ).movedim(1, -1)


def _resize_long_edge(image: torch.Tensor, max_size: int, stride: int = 16) -> torch.Tensor:
    image = image[:, :, :, :3]
    height = int(image.shape[1])
    width = int(image.shape[2])
    max_size = _snap(max_size, stride)

    scale = min(1.0, float(max_size) / float(max(height, width)))
    target_height = _snap(int(round(height * scale)), stride)
    target_width = _snap(int(round(width * scale)), stride)

    if target_height == height and target_width == width:
        return image
    return comfy.utils.common_upscale(
        image.movedim(-1, 1),
        target_width,
        target_height,
        "area",
        "disabled",
    ).movedim(1, -1)


def _fit_length(frames: torch.Tensor, length: int) -> torch.Tensor:
    length = max(1, int(length))
    frames = frames[:, :, :, :3]
    if int(frames.shape[0]) >= length:
        return frames[:length]
    if int(frames.shape[0]) <= 0:
        raise RuntimeError("Bernini 条件节点没有收到有效视频帧。")
    pad = frames[-1:].repeat(length - int(frames.shape[0]), 1, 1, 1)
    return torch.cat((frames, pad), dim=0)


def _encode_vae(vae: Any, image: torch.Tensor, frame_count: int) -> torch.Tensor:
    latent = vae.encode(image[:, :, :, :3])
    if not torch.is_tensor(latent):
        raise RuntimeError(f"Bernini 条件节点 VAE 编码失败：返回值不是 Tensor，而是 {type(latent)!r}。")
    if latent.ndim == 5:
        return latent
    if latent.ndim == 4:
        if int(latent.shape[0]) == int(frame_count):
            return latent.permute(1, 0, 2, 3).unsqueeze(0).contiguous()
        return latent.unsqueeze(2)
    raise RuntimeError(f"Bernini 条件节点 VAE 编码失败：latent 维度无效 {tuple(latent.shape)}。")


def _apply_conditioning(conditioning: Any, values: dict[str, Any], append: bool = False) -> Any:
    if not values:
        return conditioning
    return node_helpers.conditioning_set_values(conditioning, values, append=append)


class GJJ_BerniniConditioning:
    CATEGORY = "GJJ/视频生成/内部引用"
    FUNCTION = "build"
    GJJ_PRESERVE_DISPLAY_NAME_KEYS = {COMPAT_NODE_NAME}
    DESCRIPTION = (
        "零新增依赖的 BerniniConditioning 兼容节点。"
        "用于旧 Bernini 工作流：输入源视频、参考图/参考视频，输出官方 CONDITIONING 和 Wan 视频 LATENT。"
    )
    SEARCH_ALIASES = ["BerniniConditioning", "Bernini", "Bernini条件", "人物替换"]

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "latent")
    OUTPUT_TOOLTIPS = (
        "附加 Bernini/Wan 视频条件后的正向 conditioning。",
        "附加 Bernini/Wan 视频条件后的负向 conditioning。",
        "按 Wan 视频格式生成的空 latent。",
    )

    GJJ_HELP = {
        "title": "Bernini 条件（兼容）",
        "description": "替代缺失的 BerniniConditioning 节点，不安装 Bernini 推理仓库的额外依赖。",
        "usage": [
            "旧工作流中的 BerniniConditioning 会自动映射到本节点。",
            "source_video 按目标宽高和帧数编码为源视频条件。",
            "reference_images 会按 ref_max_size 编码为参考 latent，最多取前 10 张。",
            "输出 latent 采用 Wan 视频格式：[batch, channels, frames, height, width]。",
        ],
        "notes": [
            "本节点只使用 ComfyUI 已有 torch / VAE / Wan conditioning 能力，不导入 diffusers、transformers 或 Bernini 包。",
            "如果使用的是带 Bernini in-context 支持的模型/采样器，节点也会保留 context_latents 元数据；官方采样器不识别时会自动忽略。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        max_resolution = 16384
        return {
            "required": {
                "positive": ("CONDITIONING", {"display_name": "正向条件"}),
                "negative": ("CONDITIONING", {"display_name": "负向条件"}),
                "vae": ("VAE", {"display_name": "VAE"}),
                "source_video": (
                    "IMAGE",
                    {"display_name": "源视频", "tooltip": "要编辑的人物/场景视频帧。"},
                ),
                "width": (
                    "INT",
                    {
                        "default": 832,
                        "min": 16,
                        "max": max_resolution,
                        "step": 16,
                        "display_name": "宽度",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 480,
                        "min": 16,
                        "max": max_resolution,
                        "step": 16,
                        "display_name": "高度",
                    },
                ),
                "length": (
                    "INT",
                    {
                        "default": 81,
                        "min": 1,
                        "max": max_resolution,
                        "step": 4,
                        "display_name": "帧数",
                    },
                ),
                "batch_size": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 4096,
                        "step": 1,
                        "display_name": "批次",
                    },
                ),
            },
            "optional": {
                "reference_video": (
                    "IMAGE",
                    {"display_name": "参考视频", "tooltip": "可选。作为额外 Bernini 上下文视频。"},
                ),
                "reference_images": (
                    "IMAGE",
                    {"display_name": "参考图", "tooltip": "可选。人物/物体替换参考图，批量输入最多取前 10 张。"},
                ),
                "ref_max_size": (
                    "INT",
                    {
                        "default": 848,
                        "min": 16,
                        "max": max_resolution,
                        "step": 16,
                        "display_name": "参考长边",
                    },
                ),
            },
        }

    def build(
        self,
        positive,
        negative,
        vae,
        source_video,
        width: int,
        height: int,
        length: int,
        batch_size: int,
        reference_video=None,
        reference_images=None,
        ref_max_size: int = 848,
    ):
        latent_channels, temporal_stride, height_stride, width_stride = _vae_scales(vae)
        spatial_stride = max(height_stride, width_stride, 16)

        width = _snap(_as_int(width, 832), spatial_stride)
        height = _snap(_as_int(height, 480), spatial_stride)
        length = _as_int(length, 81)
        batch_size = _as_int(batch_size, 1)
        ref_max_size = _snap(_as_int(ref_max_size, 848), spatial_stride)

        latent_shape = (
            batch_size,
            latent_channels,
            _latent_t(length, temporal_stride),
            height // height_stride,
            width // width_stride,
        )
        cond_values: dict[str, Any] = {}
        append_values: dict[str, Any] = {}
        context_latents: list[torch.Tensor] = []

        src_pixels = _resize_exact(_fit_length(source_video, length), width, height)
        source_latent = _encode_vae(vae, src_pixels, int(src_pixels.shape[0]))
        latent = torch.zeros(latent_shape, device=source_latent.device, dtype=source_latent.dtype)
        context_latents.append(source_latent)

        cond_values["concat_latent_image"] = source_latent
        cond_values["concat_mask"] = torch.zeros(
            (
                1,
                1,
                int(source_latent.shape[2]),
                int(source_latent.shape[-2]),
                int(source_latent.shape[-1]),
            ),
            device=source_latent.device,
            dtype=source_latent.dtype,
        )
        cond_values["time_dim_concat"] = source_latent
        cond_values["bernini_source_latent"] = source_latent

        if reference_video is not None:
            ref_video_pixels = _resize_long_edge(_fit_length(reference_video, length), ref_max_size, spatial_stride)
            ref_video_latent = _encode_vae(vae, ref_video_pixels, int(ref_video_pixels.shape[0]))
            context_latents.append(ref_video_latent)
            cond_values["bernini_reference_video_latent"] = ref_video_latent

        reference_latents: list[torch.Tensor] = []
        if reference_images is not None:
            total_refs = int(reference_images.shape[0])
            if total_refs > MAX_REFERENCE_IMAGES:
                LOGGER.info("BerniniConditioning: reference_images 有 %d 张，仅使用前 %d 张。", total_refs, MAX_REFERENCE_IMAGES)
            for index in range(min(total_refs, MAX_REFERENCE_IMAGES)):
                ref_image = _resize_long_edge(reference_images[index : index + 1], ref_max_size, spatial_stride)
                ref_latent = _encode_vae(vae, ref_image, 1)
                reference_latents.append(ref_latent)
                context_latents.append(ref_latent)

        if reference_latents:
            append_values["reference_latents"] = reference_latents
            cond_values["bernini_reference_latents"] = reference_latents

        if context_latents:
            cond_values["context_latents"] = context_latents

        positive = _apply_conditioning(positive, cond_values)
        negative = _apply_conditioning(negative, cond_values)
        positive = _apply_conditioning(positive, append_values, append=True)
        negative = _apply_conditioning(negative, append_values, append=True)

        out_latent = {"samples": latent}
        return positive, negative, out_latent


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_BerniniConditioning,
    COMPAT_NODE_NAME: GJJ_BerniniConditioning,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
    COMPAT_NODE_NAME: COMPAT_NODE_DISPLAY_NAME,
}
