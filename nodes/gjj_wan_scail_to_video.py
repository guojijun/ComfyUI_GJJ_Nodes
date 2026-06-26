from __future__ import annotations

import logging
from io import BytesIO
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F

import comfy.model_management
import comfy.utils
from PIL import Image

from .common_utils.temp_files import gjjutils_write_temp_bytes
from .gjj_latent_file_io import (
    _file_signature,
    _load_safetensor_file,
    _load_smart_cache_latent,
    _resolve_latent_location,
    _select_loaded_samples,
    _vram_cache_signature,
)


log = logging.getLogger(__name__)

NODE_NAME = "GJJ_WanSCAILToVideo"
NODE_DISPLAY_NAME = "GJJ · 🎬 Wan SCAIL 视频条件"
COLORED_MASK_NODE_NAME = "GJJ_SCAIL2ColoredMask"
COLORED_MASK_NODE_DISPLAY_NAME = "🧩 SCAIL-2 彩色遮罩"

DESCRIPTION = (
    "零依赖复刻官方 WanSCAILToVideo：创建 Wan SCAIL/SCAIL-2 视频 latent，"
    "并处理姿态视频、彩色身份遮罩、参考图、CLIP视觉条件和上一段帧/Latent续段锚定。"
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


def _optional_latent_samples(value: Any, label: str) -> torch.Tensor | None:
    if value is None:
        return None
    if isinstance(value, dict) and "samples" not in value:
        return None
    if not isinstance(value, dict) or "samples" not in value:
        raise RuntimeError(f"{label}必须是 ComfyUI LATENT，且包含 samples。")
    samples = value["samples"]
    if not isinstance(samples, torch.Tensor):
        raise RuntimeError(f"{label}的 samples 不是张量。")
    if samples.ndim == 4:
        if int(samples.shape[0]) == 16:
            samples = samples.unsqueeze(0)
        else:
            samples = samples.unsqueeze(2)
    if samples.ndim != 5:
        raise RuntimeError(f"{label}维度无效：需要 [批次,通道,时间,高,宽]，当前为 {tuple(samples.shape)}。")
    if int(samples.shape[0]) <= 0 or int(samples.shape[2]) <= 0:
        raise RuntimeError(f"{label}为空，无法作为续段锚定。")
    return samples


def _load_previous_latent_reference(value: Any) -> dict[str, torch.Tensor] | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    mode, location = _resolve_latent_location(raw)
    if mode == "path":
        if not Path(location).is_file():
            return None
        data = _load_safetensor_file(location)
        return {"samples": _select_loaded_samples(data)}
    latent, exists, _version, _device = _load_smart_cache_latent(location)
    return latent if exists else None


def _previous_latent_reference_signature(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    mode, location = _resolve_latent_location(raw)
    if mode == "path":
        return _file_signature(location)
    return _vram_cache_signature(location)


def _fit_latent_batch(samples: torch.Tensor, batch_size: int) -> torch.Tensor:
    batch = int(samples.shape[0])
    if batch == batch_size or batch_size <= 0:
        return samples
    if batch > batch_size:
        return samples[:batch_size]
    return torch.cat([samples, samples[-1:].repeat(batch_size - batch, 1, 1, 1, 1)], dim=0)


def _resize_latent_spatial(samples: torch.Tensor, height: int, width: int) -> torch.Tensor:
    if tuple(samples.shape[-2:]) == (int(height), int(width)):
        return samples
    work = samples
    restore_dtype = samples.dtype
    if samples.device.type == "cpu" and samples.dtype in (torch.float16, torch.bfloat16):
        work = samples.float()
    resized = F.interpolate(
        work,
        size=(int(samples.shape[2]), int(height), int(width)),
        mode="trilinear",
        align_corners=False,
    )
    return resized.to(dtype=restore_dtype)


def _optional_valid_image_tensor(
    value: Any,
    label: str,
    allow_all_black: bool = True,
    allow_all_white: bool = True,
) -> torch.Tensor | None:
    if value is None:
        return None
    try:
        tensor = _ensure_image_tensor(value, label)
    except Exception as exc:
        log.warning("%s输入无效，已忽略：%s", label, exc)
        return None
    if tensor.numel() == 0 or int(tensor.shape[0]) <= 0:
        log.warning("%s为空，已忽略。", label)
        return None
    if not allow_all_black:
        try:
            if float(tensor.detach().abs().amax().cpu()) <= 1e-6:
                log.warning("%s没有有效颜色内容，已忽略。", label)
                return None
        except Exception:
            pass
    if not allow_all_white:
        try:
            if float((1.0 - tensor.detach()).abs().amax().cpu()) <= 1e-6:
                log.warning("%s是纯白背景，没有有效颜色内容，已忽略。", label)
                return None
        except Exception:
            pass
    return tensor


def _upscale_bhwc(image: torch.Tensor, width: int, height: int, method: str, crop: str = "center") -> torch.Tensor:
    return comfy.utils.common_upscale(
        image.movedim(-1, 1),
        int(width),
        int(height),
        method,
        crop,
    ).movedim(1, -1)


def _fit_or_trim_batch(tensor: torch.Tensor | None, count: int) -> torch.Tensor | None:
    if tensor is None or count <= 0:
        return None
    if int(tensor.shape[0]) == count:
        return tensor
    if int(tensor.shape[0]) > count:
        return tensor[:count]
    if int(tensor.shape[0]) <= 0:
        return None
    return torch.cat([tensor, tensor[-1:].repeat(count - int(tensor.shape[0]), 1, 1, 1)], dim=0)


def _normalize_reference_mask(rgb: torch.Tensor, white_background: bool) -> torch.Tensor:
    rgb = rgb[..., :3].float().clamp(0.0, 1.0)
    if bool(white_background):
        bg = rgb.amax(dim=-1, keepdim=True) <= 0.05
        return torch.where(bg, torch.ones_like(rgb), rgb).contiguous()
    bg = rgb.amin(dim=-1, keepdim=True) >= 0.95
    return torch.where(bg, torch.zeros_like(rgb), rgb).contiguous()


def _composite_on_background(images: torch.Tensor, masks: torch.Tensor | None, background: torch.Tensor | None, width: int, height: int) -> torch.Tensor:
    if images is None or background is None or masks is None or int(masks.shape[0]) <= 0:
        return images
    count = min(int(images.shape[0]), int(masks.shape[0]))
    if count <= 0:
        return images
    bg = _upscale_bhwc(background[:1], width, height, "bicubic", "center").to(device=images.device, dtype=images.dtype)
    mask = _upscale_bhwc(masks[:count], width, height, "nearest-exact", "center")
    mask = _normalize_reference_mask(mask, white_background=False).to(device=images.device, dtype=images.dtype)
    is_character = (mask[..., :3].max(dim=-1, keepdim=True).values > 0.1).to(images.dtype)
    out = images.clone()
    out[:count] = out[:count] * is_character + bg * (1.0 - is_character)
    return out


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


def _coerce_pose_mask_background(rgb_video: torch.Tensor, replacement_mode: bool) -> torch.Tensor:
    """Make pose mask background match official SCAIL-2 mode convention."""
    if rgb_video.ndim != 4 or int(rgb_video.shape[-1]) < 3:
        return rgb_video

    rgb = rgb_video[..., :3].float().clamp(0.0, 1.0)
    near_white = rgb.min(dim=-1, keepdim=True).values > 225.0 / 255.0
    near_black = rgb.max(dim=-1, keepdim=True).values < 0.1

    if bool(replacement_mode):
        if torch.any(near_black):
            white = torch.ones_like(rgb)
            rgb = torch.where(near_black, white, rgb)
    else:
        if torch.any(near_white):
            black = torch.zeros_like(rgb)
            rgb = torch.where(near_white, black, rgb)

    if int(rgb_video.shape[-1]) == 3:
        return rgb.contiguous()
    return torch.cat([rgb, rgb_video[..., 3:]], dim=-1).contiguous()


def _unpack_sam3_masks(track_data: dict[str, Any]) -> torch.Tensor | None:
    if not isinstance(track_data, dict):
        raise RuntimeError("SAM3轨迹数据无效：需要连接 SAM3_TRACK_DATA。")
    packed = track_data.get("packed_masks")
    if packed is None or int(getattr(packed, "shape", [0, 0])[1]) == 0:
        return None
    return _unpack_sam3_packed_masks(packed)


def _unpack_sam3_packed_masks(packed: torch.Tensor) -> torch.Tensor:
    try:
        from comfy.ldm.sam3.tracker import unpack_masks
    except Exception:
        bits = torch.tensor([1, 2, 4, 8, 16, 32, 64, 128], dtype=torch.uint8, device=packed.device)
        return (packed.to(torch.uint8).unsqueeze(-1) & bits).bool().view(*packed.shape[:-1], -1)
    return unpack_masks(packed)


def _first_frame_cx_area(masks_bool: torch.Tensor) -> tuple[list[float], list[float]]:
    first = masks_bool[0].float()
    height, width = int(first.shape[-2]), int(first.shape[-1])
    n_pixels = max(1, height * width)
    grid_x = torch.arange(width, device=first.device, dtype=first.dtype).view(1, width)
    area = first.sum(dim=(-1, -2)).clamp_(min=1)
    cx = (first * grid_x).sum(dim=(-1, -2)) / area
    return (cx / max(1, width)).tolist(), (area / n_pixels).tolist()


def _subset_track_data(track_data: dict[str, Any], obj_indices: list[int]) -> dict[str, Any]:
    out = dict(track_data)
    packed = track_data.get("packed_masks")
    if packed is None or not obj_indices:
        out["packed_masks"] = None
        if "scores" in out:
            out["scores"] = []
        return out
    out["packed_masks"] = packed[:, obj_indices].contiguous()
    scores = track_data.get("scores")
    if scores is not None:
        out["scores"] = [scores[i] for i in obj_indices if i < len(scores)]
    return out


def _parse_object_indices(text: str, count: int) -> list[int] | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    indices: list[int] = []
    for item in raw.replace("，", ",").split(","):
        value = item.strip()
        if not value:
            continue
        try:
            index = int(value)
        except ValueError as exc:
            raise RuntimeError(f"对象编号列表包含无效值“{value}”。请使用英文或中文逗号分隔的数字，例如 0,2,3。") from exc
        if 0 <= index < count:
            indices.append(index)
    return indices


def _render_colored_masks(track_data: dict[str, Any], background: str = "黑色") -> torch.Tensor:
    packed = track_data.get("packed_masks")
    try:
        height, width = [int(v) for v in track_data["orig_size"]]
    except Exception as exc:
        raise RuntimeError("SAM3轨迹数据缺少 orig_size，无法渲染彩色遮罩。") from exc

    device = comfy.model_management.intermediate_device()
    dtype = comfy.model_management.intermediate_dtype()
    bg_rgb = (1.0, 1.0, 1.0) if str(background).startswith("白") else (0.0, 0.0, 0.0)
    if packed is None or int(packed.shape[1]) == 0:
        frames = int(track_data.get("n_frames", 1)) if packed is None else int(packed.shape[0])
        out = torch.empty(max(1, frames), height, width, 3, device=device, dtype=dtype)
        out[..., 0], out[..., 1], out[..., 2] = bg_rgb[0], bg_rgb[1], bg_rgb[2]
        return out

    frames, object_count = int(packed.shape[0]), int(packed.shape[1])
    colors = torch.tensor(
        [DEFAULT_PALETTE[i % len(DEFAULT_PALETTE)] for i in range(object_count)],
        device=device,
        dtype=dtype,
    )
    masks_full = _unpack_sam3_packed_masks(packed.to(device)).float()
    mask_h, mask_w = int(masks_full.shape[-2]), int(masks_full.shape[-1])
    masks_full = F.interpolate(
        masks_full.view(frames * object_count, 1, mask_h, mask_w),
        size=(height, width),
        mode="nearest",
    ).view(frames, object_count, height, width) > 0.5
    any_mask = masks_full.any(dim=1)
    obj_idx_map = masks_full.to(torch.uint8).argmax(dim=1)
    color_overlay = colors[obj_idx_map]
    bg_tensor = torch.tensor(bg_rgb, device=device, dtype=color_overlay.dtype).view(1, 1, 1, 3)
    return torch.where(any_mask.unsqueeze(-1), color_overlay, bg_tensor.expand_as(color_overlay))


def _save_mask_webp_preview(tensor: torch.Tensor, prefix: str, title: str, fps: float = 8.0) -> dict[str, Any] | None:
    if not isinstance(tensor, torch.Tensor) or tensor.numel() == 0:
        return None
    try:
        preview = tensor.detach().cpu().float().clamp(0.0, 1.0).contiguous()
        arrays = torch.round(preview[..., :3] * 255.0).to(torch.uint8).numpy()
        pil_frames = [Image.fromarray(array, mode="RGB") for array in arrays]
        buffer = BytesIO()
        pil_frames[0].save(
            buffer,
            format="WEBP",
            save_all=len(pil_frames) > 1,
            append_images=pil_frames[1:],
            duration=max(1, round(1000.0 / max(0.01, float(fps)))),
            loop=0,
            lossless=False,
            quality=90,
            method=4,
        )
        info = gjjutils_write_temp_bytes(buffer.getvalue(), suffix=".webp")
        info.update(
            {
                "format": "image/webp",
                "media_type": "image",
                "title": title,
                "is_sequence": len(pil_frames) > 1,
                "autoplay": len(pil_frames) > 1,
                "loop": len(pil_frames) > 1,
                "frame_rate": float(fps),
                "frame_count": int(preview.shape[0]),
                "width": int(preview.shape[2]),
                "height": int(preview.shape[1]),
            }
        )
        return info
    except Exception as exc:
        log.warning("SCAIL-2 彩色遮罩预览保存失败：%s", exc)
        return None


class GJJ_WanSCAILToVideo:
    CATEGORY = "GJJ/视频生成/SCAIL"
    FUNCTION = "build"
    DESCRIPTION = DESCRIPTION
    GJJ_PRESERVE_DISPLAY_NAME_KEYS = (NODE_NAME,)
    SEARCH_ALIASES = [
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
            "背景与参考：连接背景图、参考图、多参考图时，节点会在有有效数据时自动编码；动画模式下参考遮罩可把人物合成到背景上。",
            "多参考：多参考图会逐张编码并追加到 reference_latents；多参考图遮罩会按参考数量自动对齐，不足时复用最后一张，空输入自动忽略。",
            "续段生成：优先连接上一段视频 Latent；没有 Latent 时可连接上一段完整输出帧。节点会取末尾若干帧/latent 作为 anchor，并输出 noise_mask。",
        ],
        "inputs": {
            "正向条件/负向条件": "来自 Wan 文本编码节点的 CONDITIONING。",
            "VAE": "用于编码参考图、姿态视频和上一段帧。上一段视频 Latent 已经编码好时不会重复编码。",
            "宽度/高度/帧数/批次数": "决定输出视频 latent 形状；姿态视频会缩放到宽高的一半。",
            "姿态视频帧": "可选 IMAGE 帧队列，通常来自姿态视频或驱动视频抽帧。",
            "姿态彩色遮罩": "SCAIL-2 可选 IMAGE 帧队列，应与姿态视频同步；动画模式用黑底，替换模式用白底。",
            "背景图": "SCAIL-2 可选单张背景图。动画模式下用于参考图/多参考图按遮罩合成背景；替换模式下自动忽略。",
            "参考图彩色遮罩": "SCAIL-2 可选单帧彩色身份遮罩，应与参考图同构。",
            "多参考图": "SCAIL-2 可选多张参考图，会逐张编码成 reference_latents。",
            "多参考图遮罩": "SCAIL-2 可选多参考图对应彩色遮罩，可少于参考图数量；不足时复用最后一张。",
            "上一段视频帧": "SCAIL-2 续段可选输入，节点只取末尾 上一段锚定帧数 帧。",
            "上一段视频 Latent": "SCAIL-2 续段可选输入，优先级高于上一段视频帧；节点会按 上一段锚定帧数 换算需要的尾部 latent 数。",
            "上一段 Latent 键值/路径": "和 GJJ_LoadLatentVRAM 相同的键值/路径接口。留空不读取；填普通键值时优先读显存缓存再读内存缓存；填路径时读硬盘 .latent。",
        },
        "notes": [
            "本节点复刻官方 WanSCAILToVideo，不包含官方 SCAIL2ColoredMask / SAM3 轨迹转彩色遮罩预处理。",
            "如果彩色遮罩不是高亮纯色，28 通道遮罩可能为空；请优先检查上游遮罩颜色是否接近 255。",
            "姿态彩色遮罩会按替换模式自动校正近黑/近白底色：动画模式黑底，人物替换白底；参考图彩色遮罩请使用 SCAIL-2 彩色遮罩节点的配对输出。",
            "帧数最好保持 4n+1，例如 81；姿态视频和遮罩会共同裁切到不超过目标帧数的 4n+1 长度。",
            "上一段视频 Latent 直连优先级最高；未直连或直连为空时，才会按 上一段 Latent 键值/路径 读取。",
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
                "background_image": (
                    "IMAGE",
                    {"display_name": "背景图", "tooltip": "SCAIL-2 可选。动画模式下用于把参考图/多参考图按遮罩合成到背景上；替换模式会自动忽略。"},
                ),
                "reference_image": (
                    "IMAGE",
                    {"display_name": "参考图片", "tooltip": "可选主参考图。连接后缩放到目标宽高并编码为 reference_latents；无有效数据时自动忽略。"},
                ),
                "reference_image_mask": (
                    "IMAGE",
                    {"display_name": "参考图彩色遮罩", "tooltip": "SCAIL-2 可选。主参考图对应的彩色身份遮罩；替换模式下用于裁切，动画模式下可用于背景合成。"},
                ),
                "multi_reference_images": (
                    "IMAGE",
                    {"display_name": "多参考图", "tooltip": "SCAIL-2 可选。多张参考图会逐张编码并追加到 reference_latents；空输入不会打断工作流。"},
                ),
                "multi_reference_masks": (
                    "IMAGE",
                    {"display_name": "多参考图遮罩", "tooltip": "SCAIL-2 可选。多参考图对应的彩色身份遮罩；数量不足会复用最后一张，未连接或无效时自动跳过。"},
                ),
                "clip_vision_output": (
                    "CLIP_VISION_OUTPUT",
                    {"display_name": "CLIP视觉条件", "tooltip": "可选。连接 CLIP Vision 输出后会写入正负条件，增强参考图语义一致性。"},
                ),
                "previous_frames": (
                    "IMAGE",
                    {"display_name": "上一段视频帧", "tooltip": "SCAIL-2 续段可选。上一段完整解码帧队列；节点只取末尾 上一段锚定帧数 帧。"},
                ),
                "previous_latent": (
                    "LATENT",
                    {"display_name": "上一段视频 Latent", "tooltip": "SCAIL-2 续段可选。优先使用上一段输出的 Latent，取尾部 latent 作为当前段开头锚定，避免视频帧重复 VAE 编码。"},
                ),
                "previous_latent_cache_key": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "上一段 Latent 键值/路径",
                        "tooltip": "和 GJJ_LoadLatentVRAM 相同：留空不读取；填普通键值时优先读显存缓存再读内存缓存；填路径时读取硬盘 .latent。",
                    },
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
        background_image: Any = None,
        reference_image_mask: Any = None,
        multi_reference_images: Any = None,
        multi_reference_masks: Any = None,
        previous_frames: Any = None,
        previous_latent: Any = None,
        previous_latent_cache_key: str = "",
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

        cached_previous_latent = None
        prev_latent_input = _optional_latent_samples(previous_latent, "上一段视频 Latent")
        if prev_latent_input is None:
            cached_previous_latent = _load_previous_latent_reference(previous_latent_cache_key)
            prev_latent_input = _optional_latent_samples(cached_previous_latent, "上一段 Latent 键值/路径")
        prev_latent_anchor = None
        if prev_latent_input is not None:
            if previous_frames is not None:
                log.info("已连接上一段视频 Latent，优先使用 Latent，忽略上一段视频帧。")
            elif cached_previous_latent is not None:
                log.info("已从上一段 Latent 键值/路径读取 Latent，作为续段锚定。")
            wanted_prev_latents = ((previous_frame_count - 1) // 4) + 1
            used_prev_latents = min(wanted_prev_latents, int(prev_latent_input.shape[2]), int(latent.shape[2]))
            prev_latent_anchor = prev_latent_input[:, :, -used_prev_latents:].contiguous()
            used_anchor_frames = min(previous_frame_count, ((used_prev_latents - 1) * 4) + 1)
            video_frame_offset = max(0, video_frame_offset - used_anchor_frames)

        prev_trimmed = _optional_image_tensor(previous_frames, "上一段视频帧") if prev_latent_anchor is None else None
        if prev_trimmed is not None and int(prev_trimmed.shape[0]) > 0:
            prev_trimmed = prev_trimmed[-previous_frame_count:]
            video_frame_offset = max(0, video_frame_offset - int(prev_trimmed.shape[0]))

        ref_latents: list[torch.Tensor] = []
        ref_mask_inputs: list[torch.Tensor | None] = []
        background = _optional_valid_image_tensor(background_image, "背景图")
        if background is not None and bool(replacement_mode):
            log.info("SCAIL-2 背景图在替换模式下自动忽略。")
            background = None

        ref_image = _optional_valid_image_tensor(reference_image, "参考图片")
        ref_mask = _optional_valid_image_tensor(
            reference_image_mask,
            "参考图彩色遮罩",
            allow_all_black=False,
            allow_all_white=False,
        )
        if ref_mask is not None and ref_image is None:
            log.warning("已连接参考图彩色遮罩，但参考图片无有效数据，已忽略该遮罩。")
            ref_mask = None

        ref_images_to_encode: list[tuple[str, torch.Tensor, torch.Tensor | None]] = []
        if ref_image is not None:
            ref_images_to_encode.append(("参考图片", ref_image[:1], ref_mask[:1] if ref_mask is not None else None))

        multi_refs = _optional_valid_image_tensor(multi_reference_images, "多参考图")
        multi_masks = _optional_valid_image_tensor(
            multi_reference_masks,
            "多参考图遮罩",
            allow_all_black=False,
            allow_all_white=False,
        )
        if multi_refs is not None:
            aligned_multi_masks = _fit_or_trim_batch(multi_masks, int(multi_refs.shape[0])) if multi_masks is not None else None
            for index in range(int(multi_refs.shape[0])):
                one_mask = aligned_multi_masks[index:index + 1] if aligned_multi_masks is not None else None
                ref_images_to_encode.append((f"多参考图 {index + 1}", multi_refs[index:index + 1], one_mask))
        elif multi_masks is not None:
            log.warning("已连接多参考图遮罩，但多参考图无有效数据，已忽略该遮罩。")

        if background is not None and not ref_images_to_encode:
            ref_images_to_encode.append(("背景图", background[:1], None))

        for label, image_tensor, mask_tensor in ref_images_to_encode:
            prepared = _upscale_bhwc(image_tensor[:1], width, height, "bicubic", "center")
            if mask_tensor is not None:
                if bool(replacement_mode):
                    resized_mask = _upscale_bhwc(mask_tensor[:1], width, height, "nearest-exact", "center")
                    resized_mask = _normalize_reference_mask(resized_mask, white_background=False)
                    resized_mask = resized_mask.to(device=prepared.device, dtype=prepared.dtype)
                    is_character = (resized_mask[..., :3].max(dim=-1, keepdim=True).values > 0.1).to(prepared.dtype)
                    prepared = prepared * is_character
                elif background is not None:
                    prepared = _composite_on_background(prepared, mask_tensor[:1], background, width, height)
            ref_latents.append(vae.encode(prepared[:, :, :, :3]))
            ref_mask_inputs.append(mask_tensor[:1] if mask_tensor is not None else None)
            log.info("SCAIL-2 已编码%s参考 latent。", label)

        if ref_latents:
            positive = _conditioning_set_values(positive, {"reference_latents": ref_latents}, append=True)
            negative = _conditioning_set_values(negative, {"reference_latents": ref_latents}, append=True)

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
            mask_video_hw = _coerce_pose_mask_background(mask_video_hw, bool(replacement_mode))
            driving_mask_28ch = _extract_mask_to_28ch(mask_video_hw)
            positive = _conditioning_set_values(positive, {"driving_mask_28ch": driving_mask_28ch})
            negative = _conditioning_set_values(negative, {"driving_mask_28ch": driving_mask_28ch})

        valid_ref_masks = [mask for mask in ref_mask_inputs if mask is not None]
        if valid_ref_masks:
            ref_mask_latents = []
            first_mask_tensor = _normalize_reference_mask(valid_ref_masks[0][:1], white_background=not bool(replacement_mode))
            first_mask_hw = _upscale_bhwc(first_mask_tensor, width, height, "bicubic", "center")
            first_mask_latent = _extract_mask_to_28ch(first_mask_hw)
            for mask in ref_mask_inputs:
                if mask is None:
                    ref_mask_latents.append(torch.zeros_like(first_mask_latent))
                    continue
                ref_mask_tensor = _normalize_reference_mask(mask[:1], white_background=not bool(replacement_mode))
                ref_mask_hw = _upscale_bhwc(ref_mask_tensor, width, height, "bicubic", "center")
                ref_mask_latents.append(_extract_mask_to_28ch(ref_mask_hw))
            ref_mask_prefix = torch.cat(ref_mask_latents, dim=1)
            zeros = torch.zeros(
                (1, latent.shape[2], 28, ref_mask_prefix.shape[-2], ref_mask_prefix.shape[-1]),
                device=ref_mask_prefix.device,
                dtype=ref_mask_prefix.dtype,
            )
            ref_mask_28ch = torch.cat([ref_mask_prefix, zeros], dim=1)
            positive = _conditioning_set_values(positive, {"ref_mask_28ch": ref_mask_28ch})
            negative = _conditioning_set_values(negative, {"ref_mask_28ch": ref_mask_28ch})

        prev_latent_to_apply = prev_latent_anchor
        if prev_latent_to_apply is None and prev_trimmed is not None:
            previous = _upscale_bhwc(prev_trimmed, width, height, "bicubic", "center")
            prev_latent_to_apply = vae.encode(previous[:, :, :, :3])

        if prev_latent_to_apply is not None:
            prev_latent_to_apply = _fit_latent_batch(prev_latent_to_apply, batch_size)
            if int(prev_latent_to_apply.shape[1]) != int(latent.shape[1]):
                raise RuntimeError(
                    "上一段视频 Latent 通道数不匹配："
                    f"需要 {int(latent.shape[1])}，当前为 {int(prev_latent_to_apply.shape[1])}。"
                )
            prev_latent_to_apply = _resize_latent_spatial(prev_latent_to_apply, int(latent.shape[-2]), int(latent.shape[-1]))
            prev_latent_frames = min(int(prev_latent_to_apply.shape[2]), int(latent.shape[2]))
            latent[:, :, :prev_latent_frames] = prev_latent_to_apply[:, :, :prev_latent_frames].to(
                device=latent.device,
                dtype=latent.dtype,
            )
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

    @classmethod
    def IS_CHANGED(cls, previous_latent=None, previous_latent_cache_key: str = "", **_kwargs):
        if isinstance(previous_latent, dict) and "samples" in previous_latent:
            return ""
        return _previous_latent_reference_signature(previous_latent_cache_key)


class GJJ_SCAIL2ColoredMask:
    CATEGORY = "GJJ/视频生成/SCAIL"
    FUNCTION = "build"
    DESCRIPTION = (
        "零依赖复刻官方 SCAIL2ColoredMask：把 SAM3 轨迹数据渲染为 SCAIL-2 需要的彩色身份遮罩，"
        "并在节点内部预览姿态遮罩和参考图遮罩。"
    )
    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("姿态彩色遮罩", "参考图彩色遮罩")
    OUTPUT_TOOLTIPS = (
        "可连接到 GJJ_WanSCAILToVideo 的“姿态彩色遮罩”。替换模式关闭时为黑底，开启时为白底。",
        "可连接到 GJJ_WanSCAILToVideo 的“参考图彩色遮罩”。替换模式开启时黑底，关闭时白底。",
    )
    SEARCH_ALIASES = [
        "SCAIL2ColoredMask",
        "Create SCAIL-2 Colored Mask",
        "SCAIL-2",
        "SAM3彩色遮罩",
        "彩色身份遮罩",
        "节点内部预览",
    ]
    GJJ_HELP = {
        "title": COLORED_MASK_NODE_DISPLAY_NAME,
        "description": DESCRIPTION,
        "dependencies": [
            "只依赖 ComfyUI 自带 PyTorch、folder_paths、Pillow 和 SAM3 tracker 工具。",
            "不导入 comfy_api.latest、node_helpers，也不依赖 comfy_extras/nodes_scail.py。",
        ],
        "usage": [
            "连接 SAM3 视频轨迹到“驱动视频轨迹”，节点会输出可接入 WanSCAILToVideo 的姿态彩色遮罩。",
            "可选连接参考图的 SAM3 轨迹到“参考图轨迹”，节点会输出参考图彩色遮罩；替换模式开时参考图黑底，关时参考图白底。",
            "多人场景建议保持默认“从左到右”排序，让同一身份在驱动视频与参考图两侧使用同一色板颜色。",
            "执行后节点面板会预览姿态遮罩动图和参考图遮罩单帧。",
        ],
        "inputs": {
            "驱动视频轨迹": "来自 SAM3 追踪节点的 SAM3_TRACK_DATA，通常对应姿态/驱动视频。",
            "参考图轨迹": "可选。来自 SAM3 追踪节点的 SAM3_TRACK_DATA，通常对应参考图。",
            "对象编号列表": "可选。逗号分隔的对象编号，例如 0,2,3；留空表示保留全部对象。编号使用 SAM3 内部 0 基序号。",
            "颜色分配排序": "控制对象映射到固定色板的顺序，并同时作用于驱动和参考轨迹。",
            "替换模式": "开启时视频遮罩白底、参考图遮罩黑底；关闭时视频遮罩黑底、参考图遮罩白底。",
        },
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "driving_track_data": (
                    "SAM3_TRACK_DATA",
                    {
                        "display_name": "驱动视频轨迹",
                        "tooltip": "来自 SAM3 的视频追踪数据。节点会把其中的对象遮罩渲染成姿态彩色遮罩。",
                    },
                ),
                "object_indices": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "对象编号列表",
                        "tooltip": "可选。用逗号分隔要保留的 SAM3 对象编号，例如 0,2,3；留空表示保留全部对象。",
                    },
                ),
                "sort_by": (
                    ["从左到右", "面积从大到小", "保持原顺序"],
                    {
                        "default": "从左到右",
                        "display_name": "颜色分配排序",
                        "tooltip": "决定对象按什么顺序分配蓝、红、绿、洋红、青、黄等固定色板颜色；同一排序会同时应用到驱动和参考轨迹。",
                    },
                ),
                "replacement_mode": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "替换模式",
                        "tooltip": "开启时视频遮罩白底、参考图遮罩黑底；关闭时视频遮罩黑底、参考图遮罩白底。",
                    },
                ),
            },
            "optional": {
                "ref_track_data": (
                    "SAM3_TRACK_DATA",
                    {
                        "display_name": "参考图轨迹",
                        "tooltip": "可选。参考图对应的 SAM3 轨迹数据；连接后会生成参考图彩色遮罩。",
                    },
                ),
            },
        }

    def _prepare_track_data(self, track_data: dict[str, Any], object_indices: str, sort_by: str) -> dict[str, Any]:
        masks_bool = _unpack_sam3_masks(track_data)
        if masks_bool is not None and sort_by != "保持原顺序":
            cx, area = _first_frame_cx_area(masks_bool)
            if sort_by == "从左到右":
                order = sorted(range(len(cx)), key=lambda i: cx[i])
            elif sort_by == "面积从大到小":
                order = sorted(range(len(area)), key=lambda i: -area[i])
            else:
                order = list(range(len(cx)))
            track_data = _subset_track_data(track_data, order)

        packed = track_data.get("packed_masks")
        object_count = int(packed.shape[1]) if packed is not None else 0
        indices = _parse_object_indices(object_indices, object_count)
        if indices is not None:
            track_data = _subset_track_data(track_data, indices)
        return track_data

    def build(
        self,
        driving_track_data,
        object_indices: str = "",
        sort_by: str = "从左到右",
        replacement_mode: bool = False,
        ref_track_data=None,
    ):
        if not isinstance(driving_track_data, dict):
            raise RuntimeError("“驱动视频轨迹”未连接或数据格式无效，请连接 SAM3_TRACK_DATA。")

        driving = self._prepare_track_data(driving_track_data, object_indices, sort_by)
        pose_video_mask = _render_colored_masks(driving, "白色" if bool(replacement_mode) else "黑色")
        reference_background = "黑色" if bool(replacement_mode) else "白色"

        if ref_track_data is not None:
            if not isinstance(ref_track_data, dict):
                raise RuntimeError("“参考图轨迹”数据格式无效，请连接 SAM3_TRACK_DATA。")
            reference = self._prepare_track_data(ref_track_data, object_indices, sort_by)
            reference_image_mask = _render_colored_masks(reference, reference_background)
        else:
            height, width = [int(v) for v in driving["orig_size"]]
            reference_fill = 0.0 if bool(replacement_mode) else 1.0
            reference_image_mask = torch.full(
                (
                    1,
                    height,
                    width,
                    3,
                ),
                reference_fill,
                device=comfy.model_management.intermediate_device(),
                dtype=comfy.model_management.intermediate_dtype(),
            )

        preview_images = [
            item
            for item in (
                _save_mask_webp_preview(pose_video_mask, "GJJ_SCAIL2PoseMask", "姿态彩色遮罩"),
                _save_mask_webp_preview(reference_image_mask[:1], "GJJ_SCAIL2ReferenceMask", "参考图彩色遮罩"),
            )
            if item is not None
        ]
        return {
            "ui": {
                "images": preview_images,
            },
            "result": (pose_video_mask, reference_image_mask),
        }


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanSCAILToVideo,
    COLORED_MASK_NODE_NAME: GJJ_SCAIL2ColoredMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
    COLORED_MASK_NODE_NAME: COLORED_MASK_NODE_DISPLAY_NAME,
}
