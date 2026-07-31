from __future__ import annotations

from io import BytesIO
import itertools
import logging
import math
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F

from comfy import model_management
from comfy.utils import ProgressBar, common_upscale


NODE_NAME = "GJJ_EncodeVideoComponents"
POSITION_OPTIONS = ("居中", "顶部", "底部", "左侧", "右侧")
POSITION_MAP = {
    "居中": "center",
    "顶部": "top",
    "底部": "bottom",
    "左侧": "left",
    "右侧": "right",
    "center": "center",
    "top": "top",
    "bottom": "bottom",
    "left": "left",
    "right": "right",
}
KEEP_PROPORTION_OPTIONS = (
    "拉伸",
    "等比缩放",
    "按总像素",
    "裁剪",
    "纯色填充",
    "边缘均色填充",
    "边缘像素填充",
    "模糊背景填充",
)
KEEP_PROPORTION_MAP = {
    "拉伸": "stretch",
    "等比缩放": "resize",
    "按总像素": "total_pixels",
    "裁剪": "crop",
    "纯色填充": "pad",
    "边缘均色填充": "pad_edge",
    "边缘像素填充": "pad_edge_pixel",
    "模糊背景填充": "pillarbox_blur",
    "stretch": "stretch",
    "resize": "resize",
    "total_pixels": "total_pixels",
    "crop": "crop",
    "pad": "pad",
    "pad_edge": "pad_edge",
    "pad_edge_pixel": "pad_edge_pixel",
    "pillarbox_blur": "pillarbox_blur",
}
UPSCALE_METHODS = ("最近邻精确", "双线性", "面积", "双三次", "Lanczos")
UPSCALE_METHOD_MAP = {
    "最近邻精确": "nearest-exact",
    "双线性": "bilinear",
    "面积": "area",
    "双三次": "bicubic",
    "Lanczos": "lanczos",
    "nearest-exact": "nearest-exact",
    "bilinear": "bilinear",
    "area": "area",
    "bicubic": "bicubic",
    "lanczos": "lanczos",
}


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(video: Any) -> dict[str, Any] | None:
    if not hasattr(video, "get_components"):
        return None
    try:
        components = video.get_components()
    except Exception:
        return None
    return {
        "images": _component_value(components, "images"),
        "frames": _component_value(components, "frames"),
        "audio": _component_value(components, "audio"),
        "frame_rate": _component_value(components, "frame_rate"),
    }


def _normalize_image_tensor(tensor: torch.Tensor) -> torch.Tensor:
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"视频帧张量必须是 [B,H,W,C] 或 [B,C,H,W]，实际为 {tuple(tensor.shape)}。")
    if tensor.shape[-1] not in (1, 2, 3, 4) and tensor.shape[1] in (1, 2, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 2:
        tensor = tensor[..., :1].repeat(1, 1, 1, 3)
    elif channels >= 4:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"视频帧通道数无效：{tuple(tensor.shape)}。")
    return tensor.detach().float().clamp(0.0, 1.0).contiguous()


def _parse_color(color: str, dtype: torch.dtype, device: torch.device) -> torch.Tensor:
    text = str(color or "0, 0, 0").strip()
    values: list[float] = []
    if text.startswith("#"):
        hex_text = text[1:]
        if len(hex_text) in (3, 4):
            hex_text = "".join(ch * 2 for ch in hex_text[:3])
        if len(hex_text) >= 6:
            values = [int(hex_text[i:i + 2], 16) for i in (0, 2, 4)]
    if not values:
        try:
            values = [float(part.strip()) for part in text.replace("，", ",").split(",") if part.strip()]
        except Exception:
            values = []
    if not values:
        named = {
            "black": (0, 0, 0),
            "white": (255, 255, 255),
            "red": (255, 0, 0),
            "green": (0, 255, 0),
            "blue": (0, 0, 255),
        }
        values = list(named.get(text.lower(), (0, 0, 0)))
    if len(values) == 1:
        values = values * 3
    values = values[:3]
    if max(values) > 1.0:
        values = [v / 255.0 for v in values]
    return torch.tensor(values, dtype=dtype, device=device).clamp(0.0, 1.0)


def _gaussian_blur_nchw(img_nchw: torch.Tensor, sigma_px: float) -> torch.Tensor:
    if sigma_px <= 0:
        return img_nchw
    radius = max(1, int(3.0 * float(sigma_px)))
    x = torch.arange(-radius, radius + 1, device=img_nchw.device, dtype=img_nchw.dtype)
    k1 = torch.exp(-(x * x) / (2.0 * float(sigma_px) * float(sigma_px)))
    k1 = k1 / k1.sum()
    kx = k1.view(1, 1, 1, -1).repeat(img_nchw.shape[1], 1, 1, 1)
    ky = k1.view(1, 1, -1, 1).repeat(img_nchw.shape[1], 1, 1, 1)
    img_nchw = F.conv2d(img_nchw, kx, padding=(0, radius), groups=img_nchw.shape[1])
    return F.conv2d(img_nchw, ky, padding=(radius, 0), groups=img_nchw.shape[1])


def _pad_images(
    image: torch.Tensor,
    left: int,
    right: int,
    top: int,
    bottom: int,
    color: str,
    pad_mode: str,
) -> torch.Tensor:
    batch, height, width, channels = image.shape
    padded_width = width + int(left) + int(right)
    padded_height = height + int(top) + int(bottom)
    if padded_width <= 0 or padded_height <= 0:
        return image

    if pad_mode == "edge_pixel":
        return F.pad(image.movedim(-1, 1), (left, right, top, bottom), mode="replicate").movedim(1, -1)

    if pad_mode == "pillarbox_blur":
        out = torch.zeros((batch, padded_height, padded_width, channels), dtype=image.dtype, device=image.device)
        for index in range(batch):
            scale_fill = max(padded_width / float(width), padded_height / float(height)) if width and height else 1.0
            bg_w = max(1, int(round(width * scale_fill)))
            bg_h = max(1, int(round(height * scale_fill)))
            bg = common_upscale(image[index].movedim(-1, 0).unsqueeze(0), bg_w, bg_h, "bilinear", crop="disabled")
            y0 = max(0, (bg_h - padded_height) // 2)
            x0 = max(0, (bg_w - padded_width) // 2)
            bg = bg[:, :, y0:y0 + padded_height, x0:x0 + padded_width]
            if bg.shape[2] != padded_height or bg.shape[3] != padded_width:
                bg = F.pad(
                    bg,
                    (
                        0,
                        max(0, padded_width - bg.shape[3]),
                        0,
                        max(0, padded_height - bg.shape[2]),
                    ),
                    mode="replicate",
                )
            sigma = max(1.0, 0.006 * float(min(padded_height, padded_width)))
            bg = _gaussian_blur_nchw(bg, sigma)
            if channels >= 3:
                luma = 0.2126 * bg[:, 0:1] + 0.7152 * bg[:, 1:2] + 0.0722 * bg[:, 2:3]
                bg[:, 0:3] = bg[:, 0:3] * 0.8 + luma.repeat(1, 3, 1, 1) * 0.2
            out[index] = torch.clamp(bg * 0.35, 0.0, 1.0).squeeze(0).movedim(0, -1)
        out[:, top:top + height, left:left + width, :] = image
        return out

    out = torch.zeros((batch, padded_height, padded_width, channels), dtype=image.dtype, device=image.device)
    if pad_mode == "edge":
        for index in range(batch):
            top_edge = image[index, 0, :, :].mean(dim=0)
            bottom_edge = image[index, height - 1, :, :].mean(dim=0)
            left_edge = image[index, :, 0, :].mean(dim=0)
            right_edge = image[index, :, width - 1, :].mean(dim=0)
            out[index, :top, :, :] = top_edge
            out[index, top + height:, :, :] = bottom_edge
            out[index, :, :left, :] = left_edge
            out[index, :, left + width:, :] = right_edge
            out[index, top:top + height, left:left + width, :] = image[index]
        return out

    bg_color = _parse_color(color, image.dtype, image.device)
    out[:, :, :, : min(channels, 3)] = bg_color[: min(channels, 3)]
    out[:, top:top + height, left:left + width, :] = image
    return out


class GJJ_EncodeVideoComponents:
    CATEGORY = "GJJ/🎬 视频"
    FUNCTION = "encode"
    DESCRIPTION = "逐帧读取 VIDEO、按比例模式缩放/裁剪/填充，并直接用 VAE 编码为 LATENT，同时输出音频、帧率和帧数。"
    SEARCH_ALIASES = ["video to latent", "encode video", "vae encode video", "视频转latent", "视频编码"]

    RETURN_TYPES = ("LATENT", "AUDIO", "FLOAT", "INT")
    RETURN_NAMES = ("潜空间", "音频", "帧率", "帧数")
    OUTPUT_TOOLTIPS = (
        "VAE 编码后的视频 latent。",
        "从 VIDEO 中提取或透传的音频。",
        "输入视频帧率。",
        "送入 VAE 前、并经 VAE 时间压缩约束裁剪后的帧数。",
    )

    GJJ_HELP = {
        "title": "视频组件编码",
        "description": "复刻 KJNodes 的 EncodeVideoComponents，内置缩放、裁剪、填充和音频提取逻辑，不引用 KJNodes。",
        "usage": [
            "连接官方 VIDEO 和 VAE；节点会优先从 VIDEO 组件读取帧，组件不可用时从视频流逐帧解码。",
            "宽度或高度设为 0 时使用原始尺寸；max_frames 为 0 表示不限制帧数。",
            "比例模式选择裁剪或填充类模式后，对应使用裁剪位置或填充位置。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {"display_name": "视频", "tooltip": "需要提取并编码的官方 VIDEO 对象。"}),
                "vae": ("VAE", {"display_name": "VAE", "tooltip": "用于编码视频帧的 VAE。"}),
                "width": ("INT", {"default": 768, "min": 0, "max": 16384, "step": 2, "display_name": "宽度", "tooltip": "编码前目标宽度；0 = 原始宽度。"}),
                "height": ("INT", {"default": 512, "min": 0, "max": 16384, "step": 2, "display_name": "高度", "tooltip": "编码前目标高度；0 = 原始高度。"}),
                "max_frames": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1, "display_name": "最大帧数", "tooltip": "最多读取多少帧；0 = 不限制。"}),
                "upscale_method": (UPSCALE_METHODS, {"default": "Lanczos", "display_name": "缩放算法", "tooltip": "编码前调整视频帧尺寸时使用的插值算法。"}),
                "keep_proportion": (KEEP_PROPORTION_OPTIONS, {"default": "拉伸", "display_name": "比例模式", "tooltip": "目标宽高与原视频比例不一致时的处理方式。"}),
                "crop_position": (POSITION_OPTIONS, {"default": "居中", "display_name": "裁剪位置", "tooltip": "比例模式为“裁剪”时，从哪个方向保留画面。"}),
                "pad_color": ("STRING", {"default": "0, 0, 0", "display_name": "填充颜色", "tooltip": "比例模式为“纯色填充”时使用；支持 0-255 RGB、0-1 RGB 或 #RRGGBB。"}),
                "pad_position": (POSITION_OPTIONS, {"default": "居中", "display_name": "填充位置", "tooltip": "比例模式为填充类模式时，原画面在目标画布中的对齐位置。"}),
            },
        }

    @staticmethod
    def _compute_resize_params(mode, position, width, height, src_w, src_h):
        if width == 0:
            width = src_w
        if height == 0:
            height = src_h
        pillarbox_blur = mode == "pillarbox_blur"
        pad_left = pad_right = pad_top = pad_bottom = 0
        crop_region = None

        if mode in ["resize", "total_pixels"] or mode.startswith("pad") or pillarbox_blur:
            if mode == "total_pixels":
                total_pixels = max(1, width * height)
                aspect_ratio = src_w / src_h
                new_height = max(1, int(math.sqrt(total_pixels / aspect_ratio)))
                new_width = max(1, int(math.sqrt(total_pixels * aspect_ratio)))
            else:
                ratio = min(width / src_w, height / src_h)
                new_width = max(1, round(src_w * ratio))
                new_height = max(1, round(src_h * ratio))

            if mode.startswith("pad") or pillarbox_blur:
                if position == "center":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top
                elif position == "top":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_bottom = height - new_height
                elif position == "bottom":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_top = height - new_height
                elif position == "left":
                    pad_right = width - new_width
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top
                elif position == "right":
                    pad_left = width - new_width
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top
            width = new_width
            height = new_height

        if mode == "crop":
            old_aspect = src_w / src_h
            new_aspect = width / height
            if old_aspect > new_aspect:
                crop_w = round(src_h * new_aspect)
                crop_h = src_h
            else:
                crop_w = src_w
                crop_h = round(src_w / new_aspect)
            if position == "center":
                x = (src_w - crop_w) // 2
                y = (src_h - crop_h) // 2
            elif position == "top":
                x = (src_w - crop_w) // 2
                y = 0
            elif position == "bottom":
                x = (src_w - crop_w) // 2
                y = src_h - crop_h
            elif position == "left":
                x = 0
                y = (src_h - crop_h) // 2
            else:
                x = src_w - crop_w
                y = (src_h - crop_h) // 2
            crop_region = (x, y, crop_w, crop_h)

        return int(width), int(height), crop_region, (int(pad_left), int(pad_right), int(pad_top), int(pad_bottom))

    @classmethod
    def _process_frame_tensor(cls, frames, width, height, max_frames, upscale_method, mode, crop_position, pad_position, pad_color, target_dtype):
        frames = _normalize_image_tensor(frames)
        if max_frames > 0:
            frames = frames[: int(max_frames)]
        if frames.shape[0] == 0:
            out_w = max(1, int(width or 1))
            out_h = max(1, int(height or 1))
            return torch.zeros(0, out_h, out_w, 3, dtype=target_dtype)

        src_h, src_w = int(frames.shape[1]), int(frames.shape[2])
        position = crop_position if mode == "crop" else pad_position
        res_w, res_h, crop_region, padding = cls._compute_resize_params(mode, position, int(width), int(height), src_w, src_h)
        if crop_region is not None:
            x, y, crop_w, crop_h = crop_region
            frames = frames[:, y:y + crop_h, x:x + crop_w, :]

        frames = common_upscale(frames.movedim(-1, 1), res_w, res_h, upscale_method, crop="disabled").movedim(1, -1)
        frames = frames.to(dtype=target_dtype, device="cpu")
        pad_left, pad_right, pad_top, pad_bottom = padding
        if (mode.startswith("pad") or mode == "pillarbox_blur") and any(v > 0 for v in padding):
            pad_mode = "pillarbox_blur" if mode == "pillarbox_blur" else "edge" if mode == "pad_edge" else "edge_pixel" if mode == "pad_edge_pixel" else "color"
            frames = _pad_images(frames, pad_left, pad_right, pad_top, pad_bottom, pad_color, pad_mode)
        return frames

    @classmethod
    def _decode_stream_frames(cls, video, width, height, max_frames, upscale_method, mode, crop_position, pad_position, pad_color, target_dtype):
        import av

        source = video.get_stream_source()
        start_time = getattr(video, "_VideoFromFile__start_time", 0) or 0
        duration = getattr(video, "_VideoFromFile__duration", 0) or 0
        try:
            total_frames = video.get_frame_count()
        except (ValueError, AttributeError):
            total_frames = 0
        if max_frames > 0 and total_frames > 0:
            total_frames = min(total_frames, int(max_frames))
        pbar = ProgressBar(total_frames) if total_frames > 0 else None
        use_gpu = upscale_method != "lanczos"
        device = model_management.get_torch_device() if use_gpu else torch.device("cpu")
        position = crop_position if mode == "crop" else pad_position

        with av.open(source, mode="r") as container:
            video_stream = container.streams.video[0]
            start_pts = int(start_time / video_stream.time_base)
            end_pts = int((start_time + duration) / video_stream.time_base) if duration else 0
            container.seek(start_pts, stream=video_stream)

            res_w, res_h, crop_region, padding = None, None, None, (0, 0, 0, 0)
            frames = []
            for frame in container.decode(video_stream):
                if frame.pts is not None and frame.pts < start_pts:
                    continue
                if duration and frame.pts is not None and frame.pts >= end_pts:
                    break
                if max_frames > 0 and len(frames) >= int(max_frames):
                    break
                if res_w is None:
                    res_w, res_h, crop_region, padding = cls._compute_resize_params(
                        mode, position, int(width), int(height), int(frame.width), int(frame.height)
                    )
                img = torch.from_numpy(frame.to_ndarray(format="rgb24")).to(device=device, dtype=torch.float32) / 255.0
                if crop_region is not None:
                    x, y, crop_w, crop_h = crop_region
                    img = img[y:y + crop_h, x:x + crop_w, :]
                img = common_upscale(
                    img.unsqueeze(0).movedim(-1, 1), res_w, res_h, upscale_method, crop="disabled"
                ).movedim(1, -1).squeeze(0).to(dtype=target_dtype, device="cpu")
                frames.append(img)
                if pbar is not None:
                    pbar.update(1)
            frame_rate = video_stream.average_rate if video_stream.average_rate else 1

        if isinstance(source, BytesIO):
            source.seek(0)
        fallback_w = int(width or (res_w or 1))
        fallback_h = int(height or (res_h or 1))
        images = torch.stack(frames) if frames else torch.zeros(0, fallback_h, fallback_w, 3, dtype=target_dtype)
        pad_left, pad_right, pad_top, pad_bottom = padding
        if (mode.startswith("pad") or mode == "pillarbox_blur") and any(v > 0 for v in padding):
            pad_mode = "pillarbox_blur" if mode == "pillarbox_blur" else "edge" if mode == "pad_edge" else "edge_pixel" if mode == "pad_edge_pixel" else "color"
            images = _pad_images(images, pad_left, pad_right, pad_top, pad_bottom, pad_color, pad_mode)
        return images, float(frame_rate), source, start_time, duration

    @staticmethod
    def _extract_audio_from_stream(source, start_time, duration):
        import av

        audio = None
        if isinstance(source, BytesIO):
            source.seek(0)
        with av.open(source, mode="r") as container:
            if len(container.streams.audio):
                audio_stream = container.streams.audio[-1]
                if start_time > 0:
                    container.seek(int(start_time / audio_stream.time_base), stream=audio_stream)
                audio_frames = []
                resample = av.audio.resampler.AudioResampler(format="fltp").resample
                aframes = itertools.chain.from_iterable(map(resample, container.decode(audio_stream)))
                has_first_frame = False
                for aframe in aframes:
                    offset_seconds = start_time - (aframe.time or 0)
                    to_skip = int(offset_seconds * audio_stream.sample_rate)
                    if to_skip < aframe.samples:
                        has_first_frame = True
                        break
                if has_first_frame:
                    audio_frames.append(aframe.to_ndarray()[..., max(0, to_skip):])
                    for aframe in aframes:
                        if duration and aframe.time and aframe.time > start_time + duration:
                            break
                        audio_frames.append(aframe.to_ndarray())
                if audio_frames:
                    audio_data = np.concatenate(audio_frames, axis=1)
                    if duration:
                        audio_data = audio_data[..., : int(duration * audio_stream.sample_rate)]
                    audio = {
                        "waveform": torch.from_numpy(audio_data).unsqueeze(0),
                        "sample_rate": int(audio_stream.sample_rate) if audio_stream.sample_rate else 1,
                    }
        return audio

    @classmethod
    def encode(cls, video, vae, width, height, max_frames, upscale_method, keep_proportion, crop_position, pad_color, pad_position):
        mode = KEEP_PROPORTION_MAP.get(str(keep_proportion or "拉伸"), "stretch")
        upscale_method = UPSCALE_METHOD_MAP.get(str(upscale_method or "Lanczos"), "lanczos")
        crop_position = POSITION_MAP.get(str(crop_position or "居中"), "center")
        pad_position = POSITION_MAP.get(str(pad_position or "居中"), "center")
        target_dtype = getattr(vae, "vae_dtype", torch.float32)

        components = _video_components(video)
        source = None
        start_time = 0
        duration = 0
        frame_tensor = None
        if components is not None:
            image_tensor = components.get("images")
            frames_tensor = components.get("frames")
            if isinstance(image_tensor, torch.Tensor):
                frame_tensor = image_tensor
            elif isinstance(frames_tensor, torch.Tensor):
                frame_tensor = frames_tensor

        if frame_tensor is not None:
            pixels = cls._process_frame_tensor(
                frame_tensor, width, height, max_frames, upscale_method, mode, crop_position, pad_position, pad_color, target_dtype
            )
            fps = components.get("frame_rate") or 1
            audio = components.get("audio")
        else:
            if not hasattr(video, "get_stream_source"):
                raise RuntimeError("输入 VIDEO 既没有可用帧组件，也没有可读取的视频流。")
            pixels, fps, source, start_time, duration = cls._decode_stream_frames(
                video, width, height, max_frames, upscale_method, mode, crop_position, pad_position, pad_color, target_dtype
            )
            audio = None

        try:
            temporal_compress = vae.downscale_ratio[0]
            temporal_decompress = vae.upscale_ratio[0]
            valid_frames = temporal_decompress(temporal_compress(pixels.shape[0]))
            if valid_frames < pixels.shape[0]:
                logging.warning(
                    "[GJJ_EncodeVideoComponents] Trimming %s frames (%s -> %s) to match VAE temporal compression ratio",
                    pixels.shape[0] - valid_frames,
                    pixels.shape[0],
                    valid_frames,
                )
                pixels = pixels[:valid_frames]
        except (TypeError, IndexError, AttributeError):
            pass

        latent = vae.encode(pixels)
        if audio is None and source is not None:
            audio = cls._extract_audio_from_stream(source, start_time, duration)
        return ({"samples": latent}, audio, float(fps), int(pixels.shape[0]))


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_EncodeVideoComponents}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ 视频组件编码"}
