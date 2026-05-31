from __future__ import annotations

from typing import Any

import torch

NODE_NAME = "GJJ_ImageBatchExtendWithOverlap"
OVERLAP_SIDES = ["source", "new_images"]
OVERLAP_MODES = ["cut", "linear_blend", "ease_in_out", "filmic_crossfade", "perceptual_crossfade"]


def _as_image_batch(value: Any, label: str) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise RuntimeError(f"{label} 必须是 IMAGE 图像批次。")
    if value.ndim == 3:
        value = value.unsqueeze(0)
    if value.ndim != 4:
        raise RuntimeError(f"{label} 维度不正确，应为 IMAGE 或 IMAGE batch。")
    if int(value.shape[0]) <= 0 or int(value.shape[1]) <= 0 or int(value.shape[2]) <= 0:
        raise RuntimeError(f"{label} 为空或尺寸无效。")
    return value.float().contiguous()


def _match_channels(left: torch.Tensor, right: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    channels = max(int(left.shape[-1]), int(right.shape[-1]))

    def pad(image: torch.Tensor) -> torch.Tensor:
        current = int(image.shape[-1])
        if current == channels:
            return image
        if current > channels:
            return image[..., :channels].contiguous()
        extra = torch.ones((*image.shape[:-1], channels - current), dtype=image.dtype, device=image.device)
        return torch.cat((image, extra), dim=-1).contiguous()

    return pad(left), pad(right)


def _alpha(overlap: int, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    return torch.linspace(0, 1, int(overlap) + 2, device=device, dtype=dtype)[1:-1].view(-1, 1, 1, 1)


def _linear_blend(src: torch.Tensor, dst: torch.Tensor, alpha: torch.Tensor) -> torch.Tensor:
    return (1 - alpha) * src + alpha * dst


def _srgb_to_linear(rgb: torch.Tensor) -> torch.Tensor:
    rgb = rgb.clamp(0.0, 1.0)
    low = rgb / 12.92
    high = torch.pow((rgb + 0.055) / 1.055, 2.4)
    return torch.where(rgb <= 0.04045, low, high)


def _linear_to_srgb(rgb: torch.Tensor) -> torch.Tensor:
    rgb = rgb.clamp(min=0.0)
    low = rgb * 12.92
    high = 1.055 * torch.pow(rgb.clamp(min=0.0), 1.0 / 2.4) - 0.055
    return torch.where(rgb <= 0.0031308, low, high).clamp(0.0, 1.0)


def _rgb_to_lab(image: torch.Tensor) -> torch.Tensor:
    rgb = _srgb_to_linear(image[..., :3])
    x = rgb[..., 0] * 0.4124564 + rgb[..., 1] * 0.3575761 + rgb[..., 2] * 0.1804375
    y = rgb[..., 0] * 0.2126729 + rgb[..., 1] * 0.7151522 + rgb[..., 2] * 0.0721750
    z = rgb[..., 0] * 0.0193339 + rgb[..., 1] * 0.1191920 + rgb[..., 2] * 0.9503041
    xyz = torch.stack((x / 0.95047, y, z / 1.08883), dim=-1)
    epsilon = 216.0 / 24389.0
    kappa = 24389.0 / 27.0
    f = torch.where(xyz > epsilon, torch.pow(xyz.clamp(min=0.0), 1.0 / 3.0), (kappa * xyz + 16.0) / 116.0)
    l = 116.0 * f[..., 1] - 16.0
    a = 500.0 * (f[..., 0] - f[..., 1])
    b = 200.0 * (f[..., 1] - f[..., 2])
    return torch.stack((l, a, b), dim=-1)


def _lab_to_rgb(lab: torch.Tensor) -> torch.Tensor:
    l = lab[..., 0]
    a = lab[..., 1]
    b = lab[..., 2]
    fy = (l + 16.0) / 116.0
    fx = fy + a / 500.0
    fz = fy - b / 200.0
    epsilon = 216.0 / 24389.0
    kappa = 24389.0 / 27.0

    def inv(value: torch.Tensor) -> torch.Tensor:
        cubic = value ** 3
        return torch.where(cubic > epsilon, cubic, (116.0 * value - 16.0) / kappa)

    x = inv(fx) * 0.95047
    y = inv(fy)
    z = inv(fz) * 1.08883
    r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314
    g = x * -0.9692660 + y * 1.8760108 + z * 0.0415560
    blue = x * 0.0556434 + y * -0.2040259 + z * 1.0572252
    return _linear_to_srgb(torch.stack((r, g, blue), dim=-1))


def _perceptual_blend(src: torch.Tensor, dst: torch.Tensor, alpha: torch.Tensor) -> torch.Tensor:
    if int(src.shape[-1]) < 3 or int(dst.shape[-1]) < 3:
        return _linear_blend(src, dst, alpha)
    blended_rgb = _lab_to_rgb(_linear_blend(_rgb_to_lab(src), _rgb_to_lab(dst), alpha))
    if int(src.shape[-1]) == 3:
        return blended_rgb
    blended_extra = _linear_blend(src[..., 3:], dst[..., 3:], alpha)
    return torch.cat((blended_rgb, blended_extra), dim=-1)


def _blend_overlap(src: torch.Tensor, dst: torch.Tensor, overlap_mode: str) -> torch.Tensor:
    alpha = _alpha(int(src.shape[0]), src.device, src.dtype)
    if overlap_mode == "linear_blend":
        return _linear_blend(src, dst, alpha)
    if overlap_mode == "ease_in_out":
        eased = 3 * alpha * alpha - 2 * alpha * alpha * alpha
        return _linear_blend(src, dst, eased)
    if overlap_mode == "filmic_crossfade":
        gamma = 2.2
        linear_src = torch.pow(src.clamp(0.0, 1.0), gamma)
        linear_dst = torch.pow(dst.clamp(0.0, 1.0), gamma)
        return torch.pow(_linear_blend(linear_src, linear_dst, alpha).clamp(min=0.0), 1.0 / gamma)
    if overlap_mode == "perceptual_crossfade":
        return _perceptual_blend(src, dst, alpha)
    raise RuntimeError(f"未知重叠模式：{overlap_mode}")


def _image_size(image: torch.Tensor) -> tuple[int, int]:
    return int(image.shape[2]), int(image.shape[1])


def _batch_count(image: torch.Tensor) -> int:
    return int(image.shape[0])


class GJJ_ImageBatchExtendWithOverlap:
    CATEGORY = "GJJ/图像"
    FUNCTION = "imagesfrombatch"
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "INT", "INT", "INT")
    RETURN_NAMES = ("源图像批次", "续接起始帧", "重叠扩展图像", "宽度", "高度", "批次总数量")
    OUTPUT_TOOLTIPS = (
        "原始源图像批次直通输出。",
        "从源图像批次尾部截取的起始帧，用于下一段生成。",
        "与新图像批次按重叠规则合并后的图像批次；未连接新图像批次时透传源图像批次，避免黑图。",
        "有效图像宽度；接入新图像批次时统计合并结果，否则统计源图像批次。",
        "有效图像高度；接入新图像批次时统计合并结果，否则统计源图像批次。",
        "有效图像批次总数量；接入新图像批次时统计合并结果，否则统计源图像批次。",
    )
    DESCRIPTION = "按 KJNodes 的 Image Batch Extend With Overlap 复刻图像批次续接逻辑，用于视频续帧时截取起始帧并把新旧批次按重叠帧合并。"
    GJJ_HELP = {
        "title": "图片批次重叠扩展",
        "description": "复刻 KJNodes 的 ImageBatchExtendWithOverlap：第一次只接源图像批次以取得续接起始帧；第二次接入新图像批次后，按指定重叠帧数裁切或混合合并。",
        "usage": [
            "源图像批次：上一段视频帧或图片批次。",
            "续接起始帧：把源图像批次尾部指定数量的帧输出给下一段生成作为参考。",
            "新图像批次：下一段生成结果，接入后会输出合并后的完整图像批次。",
            "未接新图像批次时，重叠扩展图像会透传源图像批次，等同内置连接到 Get Image Size & Count 的 image 输出。",
            "宽度/高度/批次总数量可直接接下游尺寸、循环和批量统计节点。",
            "perceptual_crossfade 模式已在 GJJ 内用 torch 实现，不依赖 kornia。",
        ],
    }
    SEARCH_ALIASES = [
        "ImageBatchExtendWithOverlap",
        "Image Batch Extend With Overlap",
        "图片批次重叠扩展",
        "图像续接",
        "overlap",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source_images": (
                    "IMAGE",
                    {
                        "display_name": "源图像批次",
                        "tooltip": "需要续接的原始图像批次。",
                    },
                ),
                "overlap": (
                    "INT",
                    {
                        "default": 13,
                        "min": 1,
                        "max": 4096,
                        "step": 1,
                        "display_name": "重叠帧数",
                        "tooltip": "源图像批次与新图像批次之间参与重叠或混合的帧数。",
                    },
                ),
                "overlap_side": (
                    OVERLAP_SIDES,
                    {
                        "default": "source",
                        "display_name": "重叠侧",
                        "tooltip": "source：从源批次尾部重叠；new_images：从新批次头部重叠。保留英文取值以兼容原版工作流。",
                    },
                ),
                "overlap_mode": (
                    OVERLAP_MODES,
                    {
                        "default": "linear_blend",
                        "display_name": "重叠模式",
                        "tooltip": "cut 直接裁切；其它模式会按不同曲线混合重叠帧。",
                    },
                ),
            },
            "optional": {
                "new_images": (
                    "IMAGE",
                    {
                        "display_name": "新图像批次",
                        "tooltip": "需要追加到源批次后的新生成图像批次；不连接时重叠扩展图像透传源图像批次。",
                    },
                ),
            },
        }

    def imagesfrombatch(
        self,
        source_images: torch.Tensor,
        overlap: int,
        overlap_side: str,
        overlap_mode: str,
        new_images: torch.Tensor | None = None,
    ):
        source_images = _as_image_batch(source_images, "源图像批次")
        overlap = max(1, int(overlap))
        source_width, source_height = _image_size(source_images)
        source_count = _batch_count(source_images)
        if overlap > int(source_images.shape[0]):
            return source_images, source_images, source_images, source_width, source_height, source_count

        start_images = source_images[-overlap:].contiguous()
        source_passthrough = source_images

        if new_images is None:
            return source_images, start_images, source_images, source_width, source_height, source_count

        new_images = _as_image_batch(new_images, "新图像批次").to(device=source_images.device, dtype=source_images.dtype)
        if tuple(source_images.shape[1:3]) != tuple(new_images.shape[1:3]):
            raise RuntimeError(
                f"源图像批次和新图像批次尺寸必须一致：{tuple(source_images.shape[1:3])} vs {tuple(new_images.shape[1:3])}"
            )
        if overlap > int(new_images.shape[0]):
            raise RuntimeError(f"重叠帧数 {overlap} 大于新图像批次数量 {int(new_images.shape[0])}。")

        source_images, new_images = _match_channels(source_images, new_images)

        if overlap_mode == "cut":
            if overlap_side == "new_images":
                extended_images = torch.cat((source_images, new_images[overlap:]), dim=0)
            else:
                extended_images = torch.cat((source_images[:-overlap], new_images), dim=0)
        else:
            prefix = source_images[:-overlap]
            if overlap_side == "new_images":
                blend_src = new_images[:overlap]
                blend_dst = source_images[-overlap:]
            else:
                blend_src = source_images[-overlap:]
                blend_dst = new_images[:overlap]
            suffix = new_images[overlap:]
            blended_images = _blend_overlap(blend_src, blend_dst, str(overlap_mode))
            extended_images = torch.cat((prefix, blended_images, suffix), dim=0)

        extended_images = extended_images.clamp(0.0, 1.0).contiguous()
        width, height = _image_size(extended_images)
        return source_passthrough.contiguous(), start_images, extended_images, width, height, _batch_count(extended_images)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageBatchExtendWithOverlap}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧩 图片批次重叠扩展"}
