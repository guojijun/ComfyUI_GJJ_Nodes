from __future__ import annotations

import logging
from typing import Any

import torch
import torch.nn.functional as F

import comfy.model_management
import comfy.utils


log = logging.getLogger(__name__)

NODE_NAME = "GJJ_WanSCAILToVideo"
NODE_DISPLAY_NAME = "GJJ_WanSCAILToVideo"

DESCRIPTION = (
    "零依赖复刻官方 WanSCAILToVideo：创建 Wan SCAIL/SCAIL-2 视频 latent，"
    "并把姿态视频、彩色身份遮罩、参考图、CLIP视觉条件和上一段帧写入正负条件。"
)

DEFAULT_PALETTE = [
    (0.0, 0.0, 1.0),
    (1.0, 0.0, 0.0),
    (0.0, 1.0, 0.0),
    (1.0, 0.0, 1.0),
    (0.0, 1.0, 1.0),
    (1.0, 1.0, 0.0),
]


def _max_resolution() -> int:
    try:
        import nodes as comfy_nodes

        return int(getattr(comfy_nodes, "MAX_RESOLUTION", 16384))
    except Exception:
        return 16384


def _conditioning_set_values(conditioning: Any, values: dict[str, Any], append: bool = False) -> Any:
    result = []
    for item in conditioning or []:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            result.append(item)
            continue
        cond, data = item
        next_data = dict(data)
        for key, value in values.items():
            if append and key in next_data and next_data[key] is not None:
                value = next_data[key] + value
            next_data[key] = value
        result.append([cond, next_data])
    return result


def _conditioning_set_values_with_timestep_range(
    conditioning: Any,
    values: dict[str, Any],
    start_percent: float = 0.0,
    end_percent: float = 1.0,
) -> Any:
    start_percent = float(start_percent)
    end_percent = float(end_percent)
    if start_percent > end_percent:
        log.warning("SCAIL pose_start %.4f 大于 pose_end %.4f，已透传原条件。", start_percent, end_percent)
        return conditioning

    eps = 1e-5
    result = []
    for item in conditioning or []:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            result.append(item)
            continue
        cond_start = float(item[1].get("start_percent", 0.0))
        cond_end = float(item[1].get("end_percent", 1.0))
        intersect_start = max(start_percent, cond_start)
        intersect_end = min(end_percent, cond_end)

        if intersect_start >= intersect_end:
            result.append(item)
            continue
        if intersect_start > cond_start:
            result.extend(
                _conditioning_set_values(
                    [item],
                    {"start_percent": cond_start, "end_percent": intersect_start - eps},
                )
            )
        result.extend(
            _conditioning_set_values(
                [item],
                {**values, "start_percent": intersect_start, "end_percent": intersect_end},
            )
        )
        if intersect_end < cond_end:
            result.extend(
                _conditioning_set_values(
                    [item],
                    {"start_percent": intersect_end + eps, "end_percent": cond_end},
                )
            )
    return result


def _ensure_conditioning(value: Any, label: str) -> Any:
    if value is None:
        raise RuntimeError(f"{label}未连接。Wan SCAIL 条件节点需要正向和负向 CONDITIONING。")
    return value


def _ensure_image_tensor(value: Any, label: str) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise RuntimeError(f"{label}必须是 ComfyUI IMAGE 张量。")
    tensor = value
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4 or int(tensor.shape[-1]) < 3:
        raise RuntimeError(f"{label}维度无效：需要 [帧,高,宽,通道] 的 IMAGE，当前为 {tuple(tensor.shape)}。")
    return tensor[..., :3].float().clamp(0.0, 1.0).contiguous()


def _optional_image_tensor(value: Any, label: str) -> torch.Tensor | None:
    if value is None:
        return None
    return _ensure_image_tensor(value, label)


def _upscale_bhwc(image: torch.Tensor, width: int, height: int, method: str, crop: str = "center") -> torch.Tensor:
    return comfy.utils.common_upscale(
        image.movedim(-1, 1),
        int(width),
        int(height),
        method,
        crop,
    ).movedim(1, -1)


def _extract_mask_to_28ch(rgb_video: torch.Tensor) -> torch.Tensor:
    """SCAIL-2 彩色 RGB 遮罩 -> 28 通道二值 latent。"""
    if rgb_video.ndim != 4 or int(rgb_video.shape[-1]) < 3:
        raise RuntimeError(f"SCAIL-2 彩色遮罩维度无效：{tuple(rgb_video.shape)}")

    frames, height, width, _ = rgb_video.shape
    on_thresh = 225.0 / 255.0
    mask = rgb_video[..., :3].movedim(-1, 1).float()
    red = (mask[:, 0:1] > on_thresh).float()
    green = (mask[:, 1:2] > on_thresh).float()
    blue = (mask[:, 2:3] > on_thresh).float()
    n_red, n_green, n_blue = 1 - red, 1 - green, 1 - blue
    binary_7ch = torch.cat(
        [
            red * green * blue,
            red * n_green * n_blue,
            n_red * green * n_blue,
            n_red * n_green * blue,
            red * green * n_blue,
            red * n_green * blue,
            n_red * green * blue,
        ],
        dim=1,
    )

    latent_h, latent_w = int(height), int(width)
    for _ in range(3):
        latent_h = (latent_h + 1) // 2
        latent_w = (latent_w + 1) // 2
    binary_7ch = F.interpolate(binary_7ch, size=(latent_h, latent_w), mode="area")
    latent_frames = ((int(frames) - 1) // 4) + 1
    needed = latent_frames * 4
    padded = torch.cat([binary_7ch[:1].repeat(4, 1, 1, 1), binary_7ch[1:]], dim=0)
    if int(padded.shape[0]) < needed:
        padded = torch.cat([padded, padded[-1:].repeat(needed - int(padded.shape[0]), 1, 1, 1)], dim=0)
    padded = padded[:needed]
    return padded.view(latent_frames, 28, latent_h, latent_w).unsqueeze(0)


class GJJ_WanSCAILToVideo:
    CATEGORY = "GJJ/视频生成/SCAIL"
    FUNCTION = "build"
    DESCRIPTION = DESCRIPTION
    GJJ_PRESERVE_DISPLAY_NAME_KEYS = (NODE_NAME,)
    SEARCH_ALIASES = [
        "WanSCAILToVideo",
        "SCAIL",
        "SCAIL-2",
        "Wan SCAIL",
        "姿态视频条件",
        "彩色身份遮罩",
    ]

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT", "INT")
    RETURN_NAMES = ("正向条件", "负向条件", "视频Latent", "下一段帧偏移")
    OUTPUT_TOOLTIPS = (
        "写入 SCAIL/SCAIL-2 控制信息后的正向 CONDITIONING。",
        "写入同一组 SCAIL/SCAIL-2 控制信息后的负向 CONDITIONING。",
        "按宽高、帧数、批次数创建的视频 latent；续段模式会带 noise_mask 锚定上一段末尾。",
        "当前帧偏移加本段帧数后的值，可连接到下一段的 视频帧偏移。",
    )
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": DESCRIPTION,
        "model_download_url": "",
        "dependencies": [
            "只依赖 ComfyUI 自带 PyTorch、comfy.utils、comfy.model_management 和 VAE。",
            "不导入 comfy_api.latest、node_helpers，也不依赖 comfy_extras/nodes_scail.py。",
            "需要下游模型/采样器本身支持 SCAIL 或 SCAIL-2 conditioning keys。",
        ],
        "usage": [
            "基础模式：连接正向条件、负向条件、VAE，设置宽度/高度/帧数/批次数，输出空视频 latent。",
            "姿态控制：连接 姿态视频帧，节点会缩放到目标视频一半分辨率，VAE 编码为 pose_video_latent，并按姿态开始/结束比例生效。",
            "SCAIL-2 身份遮罩：连接 姿态彩色遮罩 和/或 参考图彩色遮罩，遮罩应使用官方训练色板：红、绿、蓝、黄、洋红、青、白。",
            "替换模式：开启后参考图会按参考图彩色遮罩裁到黑底，并把 ref_mask_flag 写为 False；关闭时为动画模式。",
            "参考图：连接参考图后会缩放到目标宽高并编码为 reference_latents；多参考请在上游先合成到一张图。",
            "续段生成：连接上一段完整输出帧，并把上段输出的 下一段帧偏移 接回本节点；节点会取末尾若干帧作为 anchor，并输出 noise_mask。",
        ],
        "inputs": {
            "正向条件/负向条件": "来自 Wan 文本编码节点的 CONDITIONING。",
            "VAE": "用于编码参考图、姿态视频和上一段帧。请使用与 Wan/SCAIL 模型匹配的视频 VAE。",
            "宽度/高度/帧数/批次数": "决定输出视频 latent 形状；姿态视频会缩放到宽高的一半。",
            "姿态视频帧": "可选 IMAGE 帧队列，通常来自姿态视频或驱动视频抽帧。",
            "姿态彩色遮罩": "SCAIL-2 可选 IMAGE 帧队列，应与姿态视频同步；动画模式用黑底，替换模式用白底。",
            "参考图彩色遮罩": "SCAIL-2 可选单帧彩色身份遮罩，应与参考图同构。",
            "上一段视频帧": "SCAIL-2 续段可选输入，节点只取末尾 上一段锚定帧数 帧。",
        },
        "notes": [
            "本节点复刻官方 WanSCAILToVideo，不包含官方 SCAIL2ColoredMask / SAM3 轨迹转彩色遮罩预处理。",
            "如果彩色遮罩不是高亮纯色，28 通道遮罩可能为空；请优先检查上游遮罩颜色是否接近 255。",
            "帧数最好保持 4n+1，例如 81；姿态视频和遮罩会共同裁切到不超过目标帧数的 4n+1 长度。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        max_resolution = _max_resolution()
        return {
            "required": {
                "positive": (
                    "CONDITIONING",
                    {"display_name": "正向条件", "tooltip": "来自 Wan 文本编码器的正向条件；节点会写入 SCAIL/SCAIL-2 控制信息。"},
                ),
                "negative": (
                    "CONDITIONING",
                    {"display_name": "负向条件", "tooltip": "来自 Wan 文本编码器的负向条件；节点会同步写入 SCAIL/SCAIL-2 控制信息。"},
                ),
                "vae": (
                    "VAE",
                    {"display_name": "VAE", "tooltip": "用于编码参考图、姿态视频和上一段帧；请连接与 Wan/SCAIL 模型匹配的视频 VAE。"},
                ),
                "width": (
                    "INT",
                    {"default": 512, "min": 32, "max": max_resolution, "step": 32, "display_name": "宽度", "tooltip": "目标视频宽度；输出 latent 宽度为该值除以 8，姿态视频会缩放到一半宽度。"},
                ),
                "height": (
                    "INT",
                    {"default": 896, "min": 32, "max": max_resolution, "step": 32, "display_name": "高度", "tooltip": "目标视频高度；输出 latent 高度为该值除以 8，姿态视频会缩放到一半高度。"},
                ),
                "length": (
                    "INT",
                    {"default": 81, "min": 1, "max": max_resolution, "step": 4, "display_name": "帧数", "tooltip": "目标生成帧数。推荐使用 4n+1，例如 81。"},
                ),
                "batch_size": (
                    "INT",
                    {"default": 1, "min": 1, "max": 4096, "display_name": "批次数", "tooltip": "输出 latent 的批次数。"},
                ),
                "pose_strength": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01, "display_name": "姿态强度", "tooltip": "姿态 latent 的强度倍率；0 会让姿态条件近似失效。"},
                ),
                "pose_start": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "姿态开始比例", "tooltip": "姿态条件开始生效的采样比例。"},
                ),
                "pose_end": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "姿态结束比例", "tooltip": "姿态条件结束生效的采样比例。"},
                ),
                "video_frame_offset": (
                    "INT",
                    {"default": 0, "min": 0, "max": max_resolution, "step": 1, "display_name": "视频帧偏移", "tooltip": "当前分段从完整控制视频的第几帧开始；续段时接上一段输出的 下一段帧偏移。"},
                ),
                "previous_frame_count": (
                    "INT",
                    {"default": 5, "min": 1, "max": max_resolution, "step": 4, "display_name": "上一段锚定帧数", "tooltip": "续段时从上一段视频末尾取多少帧作为锚定；官方 SCAIL-2 通常使用 5。"},
                ),
                "replacement_mode": (
                    "BOOLEAN",
                    {"default": False, "display_name": "替换模式", "tooltip": "SCAIL-2 可选。关闭为动画模式，姿态遮罩通常黑底；开启为替换模式，姿态遮罩通常白底。"},
                ),
            },
            "optional": {
                "pose_video": (
                    "IMAGE",
                    {"display_name": "姿态视频帧", "tooltip": "可选。用于姿态控制的视频帧队列，会按视频帧偏移裁切，并缩放到目标宽高的一半后编码。"},
                ),
                "pose_video_mask": (
                    "IMAGE",
                    {"display_name": "姿态彩色遮罩", "tooltip": "SCAIL-2 可选。与姿态视频同步的彩色身份遮罩帧队列，动画模式黑底，替换模式白底。"},
                ),
                "reference_image": (
                    "IMAGE",
                    {"display_name": "参考图", "tooltip": "可选参考图。多参考请在上游合成到单张图；节点会缩放到目标宽高并编码为 reference_latents。"},
                ),
                "reference_image_mask": (
                    "IMAGE",
                    {"display_name": "参考图彩色遮罩", "tooltip": "SCAIL-2 可选。参考图对应的彩色身份遮罩；替换模式下还会作为参考图裁切蒙版。"},
                ),
                "clip_vision_output": (
                    "CLIP_VISION_OUTPUT",
                    {"display_name": "CLIP视觉条件", "tooltip": "可选。连接 CLIP Vision 输出后会写入正负条件，增强参考图语义一致性。"},
                ),
                "previous_frames": (
                    "IMAGE",
                    {"display_name": "上一段视频帧", "tooltip": "SCAIL-2 续段可选。上一段完整解码帧队列；节点只取末尾 上一段锚定帧数 帧。"},
                ),
            },
        }

    def build(
        self,
        positive,
        negative,
        vae,
        width: int,
        height: int,
        length: int,
        batch_size: int,
        pose_strength: float,
        pose_start: float,
        pose_end: float,
        video_frame_offset: int,
        previous_frame_count: int,
        replacement_mode: bool = False,
        reference_image: Any = None,
        clip_vision_output: Any = None,
        pose_video: Any = None,
        pose_video_mask: Any = None,
        reference_image_mask: Any = None,
        previous_frames: Any = None,
    ):
        positive = _ensure_conditioning(positive, "正向条件")
        negative = _ensure_conditioning(negative, "负向条件")
        if vae is None or not callable(getattr(vae, "encode", None)):
            raise RuntimeError("VAE 未连接或无法编码图像。请接入与 Wan/SCAIL 模型匹配的视频 VAE。")

        width = int(width)
        height = int(height)
        length = max(1, int(length))
        batch_size = max(1, int(batch_size))
        video_frame_offset = max(0, int(video_frame_offset))
        previous_frame_count = max(1, int(previous_frame_count))

        latent = torch.zeros(
            [batch_size, 16, ((length - 1) // 4) + 1, height // 8, width // 8],
            device=comfy.model_management.intermediate_device(),
        )
        noise_mask = None

        ref_mask_flag = not bool(replacement_mode)
        positive = _conditioning_set_values(positive, {"ref_mask_flag": ref_mask_flag})
        negative = _conditioning_set_values(negative, {"ref_mask_flag": ref_mask_flag})

        prev_trimmed = _optional_image_tensor(previous_frames, "上一段视频帧")
        if prev_trimmed is not None and int(prev_trimmed.shape[0]) > 0:
            prev_trimmed = prev_trimmed[-previous_frame_count:]
            video_frame_offset = max(0, video_frame_offset - int(prev_trimmed.shape[0]))

        ref_latent = None
        ref_image = _optional_image_tensor(reference_image, "参考图")
        ref_mask = _optional_image_tensor(reference_image_mask, "参考图彩色遮罩")
        if ref_mask is not None and ref_image is None:
            raise RuntimeError(
                "已连接“参考图彩色遮罩”，但“参考图”未连接。"
                "SCAIL-2 参考遮罩包含 1 个参考 latent 帧；缺少参考图会导致采样时视频 latent 与遮罩长度不一致。"
            )
        if ref_image is not None:
            ref_image = _upscale_bhwc(ref_image[:1], width, height, "bicubic", "center")
            if replacement_mode and ref_mask is not None:
                resized_mask = _upscale_bhwc(ref_mask[:1], width, height, "nearest-exact", "center")
                is_character = (resized_mask[..., :3].max(dim=-1, keepdim=True).values > 0.1).to(ref_image.dtype)
                ref_image = ref_image * is_character
            ref_latent = vae.encode(ref_image[:, :, :, :3])

        if ref_latent is not None:
            positive = _conditioning_set_values(positive, {"reference_latents": [ref_latent]}, append=True)
            negative = _conditioning_set_values(negative, {"reference_latents": [ref_latent]}, append=True)

        if clip_vision_output is not None:
            positive = _conditioning_set_values(positive, {"clip_vision_output": clip_vision_output})
            negative = _conditioning_set_values(negative, {"clip_vision_output": clip_vision_output})

        pose_frames = _optional_image_tensor(pose_video, "姿态视频帧")
        if pose_frames is not None:
            pose_frames = None if int(pose_frames.shape[0]) <= video_frame_offset else pose_frames[video_frame_offset:]
        pose_mask_frames = _optional_image_tensor(pose_video_mask, "姿态彩色遮罩")
        if pose_mask_frames is not None:
            pose_mask_frames = None if int(pose_mask_frames.shape[0]) <= video_frame_offset else pose_mask_frames[video_frame_offset:]

        time_lengths = [int(item.shape[0]) for item in (pose_frames, pose_mask_frames) if item is not None]
        if time_lengths:
            kept = ((min(min(time_lengths), length) - 1) // 4) * 4 + 1
            if pose_frames is not None:
                pose_frames = pose_frames[:kept]
            if pose_mask_frames is not None:
                pose_mask_frames = pose_mask_frames[:kept]

        if pose_frames is not None:
            pose_small = _upscale_bhwc(pose_frames[:length], width // 2, height // 2, "area", "center")
            pose_video_latent = vae.encode(pose_small[:, :, :, :3]) * float(pose_strength)
            values = {"pose_video_latent": pose_video_latent}
            positive = _conditioning_set_values_with_timestep_range(positive, values, pose_start, pose_end)
            negative = _conditioning_set_values_with_timestep_range(negative, values, pose_start, pose_end)

        if pose_mask_frames is not None:
            mask_video_hw = _upscale_bhwc(pose_mask_frames[:length], width // 2, height // 2, "area", "center")
            driving_mask_28ch = _extract_mask_to_28ch(mask_video_hw)
            positive = _conditioning_set_values(positive, {"driving_mask_28ch": driving_mask_28ch})
            negative = _conditioning_set_values(negative, {"driving_mask_28ch": driving_mask_28ch})

        if ref_mask is not None:
            ref_mask_hw = _upscale_bhwc(ref_mask[:1], width, height, "bicubic", "center")
            ref_mask_1f = _extract_mask_to_28ch(ref_mask_hw)
            zeros = torch.zeros(
                (1, latent.shape[2], 28, ref_mask_1f.shape[-2], ref_mask_1f.shape[-1]),
                device=ref_mask_1f.device,
                dtype=ref_mask_1f.dtype,
            )
            ref_mask_28ch = torch.cat([ref_mask_1f, zeros], dim=1)
            positive = _conditioning_set_values(positive, {"ref_mask_28ch": ref_mask_28ch})
            negative = _conditioning_set_values(negative, {"ref_mask_28ch": ref_mask_28ch})

        if prev_trimmed is not None:
            previous = _upscale_bhwc(prev_trimmed, width, height, "bicubic", "center")
            prev_latent = vae.encode(previous[:, :, :, :3])
            prev_latent_frames = min(int(prev_latent.shape[2]), int(latent.shape[2]))
            latent[:, :, :prev_latent_frames] = prev_latent[:, :, :prev_latent_frames].to(latent.dtype)
            noise_mask = torch.ones(
                (1, 1, latent.shape[2], latent.shape[-2], latent.shape[-1]),
                device=latent.device,
                dtype=latent.dtype,
            )
            noise_mask[:, :, :prev_latent_frames] = 0.0

        out_latent = {"samples": latent}
        if noise_mask is not None:
            out_latent["noise_mask"] = noise_mask

        return (positive, negative, out_latent, video_frame_offset + length)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanSCAILToVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
