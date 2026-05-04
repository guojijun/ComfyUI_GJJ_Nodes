from __future__ import annotations

import math
from fractions import Fraction
from typing import Any

import torch
import torch.nn.functional as F


NODE_NAME = "GJJ_VideoOutpaintPad"

MODE_MARGINS = "边距扩充"
MODE_RATIO = "目标比例扩充"
EXPAND_MODES = [MODE_MARGINS, MODE_RATIO]

ANCHOR_CENTER = "居中"
ANCHOR_TOP = "靠上"
ANCHOR_BOTTOM = "靠下"
ANCHOR_LEFT = "靠左"
ANCHOR_RIGHT = "靠右"
ANCHORS = [ANCHOR_CENTER, ANCHOR_TOP, ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT]

FILL_BLACK = "黑色"
FILL_EDGE = "边缘延展"
FILL_BLUR = "模糊背景"
FILL_MODES = [FILL_EDGE, FILL_BLACK, FILL_BLUR]


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _ensure_image_batch(images: Any) -> torch.Tensor:
    if images is None:
        raise RuntimeError("未收到视频帧。")
    if not isinstance(images, torch.Tensor):
        raise RuntimeError(f"视频帧不是有效 IMAGE 张量：{type(images)!r}")
    if images.ndim == 3:
        images = images.unsqueeze(0)
    if images.ndim != 4:
        raise RuntimeError(f"视频帧维度无效：{tuple(images.shape)}，应为 [帧, 高, 宽, 通道]。")
    if int(images.shape[0]) <= 0:
        raise RuntimeError("输入视频没有可处理的帧。")
    if int(images.shape[-1]) not in (3, 4):
        raise RuntimeError(f"视频帧通道数无效：{int(images.shape[-1])}。")
    return images.detach().float().clamp(0.0, 1.0).contiguous()


def _empty_audio() -> dict[str, Any]:
    return {"waveform": torch.zeros((1, 2, 1), dtype=torch.float32), "sample_rate": 44100}


def _extract_video_components(video: Any) -> tuple[torch.Tensor, Any, float]:
    if video is None:
        raise RuntimeError("请连接输入视频。")
    if isinstance(video, torch.Tensor):
        return _ensure_image_batch(video), None, 24.0
    if not hasattr(video, "get_components"):
        raise RuntimeError("输入视频不是有效 VIDEO 对象。请连接 ComfyUI 核心 Load Video 或 GJJ 视频加载节点的 VIDEO 输出。")
    try:
        components = video.get_components()
        frames = _ensure_image_batch(components.images)
        audio = getattr(components, "audio", None)
        frame_rate = float(getattr(components, "frame_rate", 24.0) or 24.0)
    except Exception as exc:
        raise RuntimeError(f"读取输入视频失败。\n详细错误：{exc}") from exc
    return frames, audio, max(0.01, frame_rate)


def _ceil_to_multiple(value: int | float, multiple: int) -> int:
    multiple = max(1, int(multiple))
    return int(math.ceil(max(1.0, float(value)) / multiple) * multiple)


def _split_padding(total: int, anchor: str, negative_anchor: str, positive_anchor: str) -> tuple[int, int]:
    total = max(0, int(total))
    if anchor == negative_anchor:
        before = 0
    elif anchor == positive_anchor:
        before = total
    else:
        before = total // 2
    return before, total - before


def _compute_ratio_size(width: int, height: int, ratio_text: str) -> tuple[int, int]:
    text = str(ratio_text or "").strip().lower().replace("：", ":").replace("x", ":")
    if ":" in text:
        left, right = text.split(":", 1)
        try:
            ratio = float(left.strip()) / max(0.0001, float(right.strip()))
        except Exception:
            raise RuntimeError(f"目标比例无效：{ratio_text}")
    else:
        try:
            ratio = float(text)
        except Exception:
            raise RuntimeError(f"目标比例无效：{ratio_text}")
    current = width / max(1, height)
    if abs(current - ratio) < 0.0001:
        return width, height
    if current < ratio:
        return int(math.ceil(height * ratio)), height
    return width, int(math.ceil(width / ratio))


def _resolve_canvas(
    width: int,
    height: int,
    expand_mode: str,
    alignment: int,
    left: int,
    right: int,
    top: int,
    bottom: int,
    min_width: int,
    min_height: int,
    target_ratio: str,
    anchor: str,
) -> tuple[int, int, int, int, int, int]:
    if expand_mode == MODE_RATIO:
        canvas_width, canvas_height = _compute_ratio_size(width, height, target_ratio)
        canvas_width = max(canvas_width, int(min_width))
        canvas_height = max(canvas_height, int(min_height))
    else:
        canvas_width = width + max(0, int(left)) + max(0, int(right))
        canvas_height = height + max(0, int(top)) + max(0, int(bottom))

    canvas_width = _ceil_to_multiple(canvas_width, alignment)
    canvas_height = _ceil_to_multiple(canvas_height, alignment)

    extra_width = max(0, canvas_width - width)
    extra_height = max(0, canvas_height - height)
    if expand_mode == MODE_MARGINS:
        left_pad = max(0, int(left))
        right_pad = max(0, int(right))
        top_pad = max(0, int(top))
        bottom_pad = max(0, int(bottom))
        left_pad += max(0, extra_width - left_pad - right_pad) // 2
        right_pad = canvas_width - width - left_pad
        top_pad += max(0, extra_height - top_pad - bottom_pad) // 2
        bottom_pad = canvas_height - height - top_pad
    else:
        left_pad, right_pad = _split_padding(extra_width, anchor, ANCHOR_LEFT, ANCHOR_RIGHT)
        top_pad, bottom_pad = _split_padding(extra_height, anchor, ANCHOR_TOP, ANCHOR_BOTTOM)
    return canvas_width, canvas_height, left_pad, right_pad, top_pad, bottom_pad


def _make_mask(frame_count: int, height: int, width: int, left: int, right: int, top: int, bottom: int) -> torch.Tensor:
    mask = torch.ones((frame_count, height, width), dtype=torch.float32)
    y0 = int(top)
    y1 = height - int(bottom)
    x0 = int(left)
    x1 = width - int(right)
    if y1 > y0 and x1 > x0:
        mask[:, y0:y1, x0:x1] = 0.0
    return mask.contiguous()


def _resize_to_cover(frames: torch.Tensor, width: int, height: int) -> torch.Tensor:
    current_h = int(frames.shape[1])
    current_w = int(frames.shape[2])
    scale = max(width / max(1, current_w), height / max(1, current_h))
    scaled_w = max(width, int(math.ceil(current_w * scale)))
    scaled_h = max(height, int(math.ceil(current_h * scale)))
    resized = F.interpolate(frames.movedim(-1, 1), size=(scaled_h, scaled_w), mode="bilinear", align_corners=False)
    y0 = max(0, (scaled_h - height) // 2)
    x0 = max(0, (scaled_w - width) // 2)
    return resized[:, :, y0:y0 + height, x0:x0 + width].movedim(1, -1).contiguous()


def _fill_canvas(
    frames: torch.Tensor,
    fill_mode: str,
    canvas_width: int,
    canvas_height: int,
    left: int,
    top: int,
    fill_color: str,
) -> torch.Tensor:
    frame_count, height, width, channels = (int(x) for x in frames.shape)
    if fill_mode == FILL_BLACK:
        color_values = [0.0, 0.0, 0.0, 1.0]
        parts = [part.strip() for part in str(fill_color or "").replace("，", ",").split(",") if part.strip()]
        if len(parts) >= 3:
            try:
                color_values[:3] = [max(0.0, min(1.0, float(part) / 255.0)) for part in parts[:3]]
            except Exception:
                raise RuntimeError("填充颜色格式无效，请使用类似 0,0,0 或 24,24,24 的 RGB 数值。")
        canvas = frames.new_empty((frame_count, canvas_height, canvas_width, channels))
        for channel in range(channels):
            canvas[..., channel] = color_values[channel]
    elif fill_mode == FILL_BLUR:
        canvas = _resize_to_cover(frames, canvas_width, canvas_height)
        canvas = F.avg_pool2d(canvas.movedim(-1, 1), kernel_size=31, stride=1, padding=15).movedim(1, -1).contiguous()
    else:
        canvas = F.pad(frames.movedim(-1, 1), (left, canvas_width - width - left, top, canvas_height - height - top), mode="replicate").movedim(1, -1).contiguous()
    canvas[:, top:top + height, left:left + width, :] = frames
    return canvas.clamp(0.0, 1.0).contiguous()


def _create_video(frames: torch.Tensor, audio: Any, fps: float):
    try:
        from comfy_api.latest import InputImpl, Types
    except Exception as exc:
        raise RuntimeError("当前 ComfyUI 环境缺少 comfy_api.latest，无法创建官方 VIDEO 输出。") from exc
    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=frames[..., :3].contiguous(),
            audio=audio or _empty_audio(),
            frame_rate=Fraction(str(float(fps))).limit_denominator(1000),
        )
    )


class GJJ_VideoOutpaintPad:
    CATEGORY = "GJJ/视频"
    FUNCTION = "outpaint_video"
    DESCRIPTION = "把输入 VIDEO 拆成帧后做零依赖外扩画布预处理，支持边距扩充和目标比例/尺寸扩充，并自动对齐 LTX 常用倍数。"
    SEARCH_ALIASES = ["视频外扩", "outpaint video", "LTX outpaint", "视频画布扩展", "视频填充"]
    RETURN_TYPES = ("VIDEO", "IMAGE", "MASK", "INT", "INT", "INT", "FLOAT")
    RETURN_NAMES = ("外扩视频", "外扩帧序列", "外扩遮罩", "宽度", "高度", "帧数", "帧率")
    OUTPUT_TOOLTIPS = (
        "保留原音频和帧率的官方 VIDEO 输出，可继续接视频节点。",
        "外扩后的 IMAGE 批次，可直接接 LTX guide、预览或视频合成器。",
        "白色为新增外扩区域，黑色为原始画面区域。",
        "已对齐后的输出宽度。",
        "已对齐后的输出高度。",
        "输出帧数量。",
        "输入视频帧率；无法读取时使用 24。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_video": ("VIDEO", {"display_name": "输入视频", "tooltip": "必接。连接 ComfyUI 核心 Load Video、GJJ 多视频加载或其它 VIDEO 输出。"}),
                "expand_mode": (EXPAND_MODES, {"default": MODE_MARGINS, "display_name": "扩充方式", "tooltip": "边距扩充按四边像素外扩；目标比例扩充按比例和最小宽高增加画布，不裁剪原视频。"}),
                "fill_mode": (FILL_MODES, {"default": FILL_EDGE, "display_name": "填充方式", "tooltip": "新增区域的临时填充。接 LTX outpaint guide 时通常用边缘延展或黑色。"}),
                "alignment": ("INT", {"default": 32, "min": 8, "max": 128, "step": 8, "display_name": "LTX倍数对齐", "tooltip": "最终宽高会向上补齐到该倍数。LTX 常用 32。"}),
                "left": ("INT", {"default": 256, "min": 0, "max": 8192, "step": 8, "display_name": "左扩", "tooltip": "边距扩充模式下向左增加的像素。"}),
                "right": ("INT", {"default": 256, "min": 0, "max": 8192, "step": 8, "display_name": "右扩", "tooltip": "边距扩充模式下向右增加的像素。"}),
                "top": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 8, "display_name": "上扩", "tooltip": "边距扩充模式下向上增加的像素。"}),
                "bottom": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 8, "display_name": "下扩", "tooltip": "边距扩充模式下向下增加的像素。"}),
                "target_ratio": ("STRING", {"default": "16:9", "multiline": False, "display_name": "目标比例", "tooltip": "目标比例扩充模式使用，例如 16:9、9:16、1:1。"}),
                "target_width": ("INT", {"default": 1280, "min": 64, "max": 8192, "step": 8, "display_name": "最小宽度", "tooltip": "目标比例扩充模式使用；最终画布不会小于此宽度，并会继续向上对齐 LTX 倍数。"}),
                "target_height": ("INT", {"default": 720, "min": 64, "max": 8192, "step": 8, "display_name": "最小高度", "tooltip": "目标比例扩充模式使用；最终画布不会小于此高度，并会继续向上对齐 LTX 倍数。"}),
                "anchor": (ANCHORS, {"default": ANCHOR_CENTER, "display_name": "原画位置", "tooltip": "目标比例扩充时原视频在新画布里的停靠位置。"}),
                "fill_color": ("STRING", {"default": "0,0,0", "multiline": False, "display_name": "黑色填充RGB", "tooltip": "填充方式为黑色时使用，格式为 R,G,B，取值 0-255。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def outpaint_video(
        self,
        input_video,
        expand_mode,
        fill_mode,
        alignment,
        left,
        right,
        top,
        bottom,
        target_ratio,
        target_width,
        target_height,
        anchor,
        fill_color,
        unique_id=None,
    ):
        _send_status(unique_id, "1/3 读取输入视频...", 0.05)
        frames, audio, fps = _extract_video_components(input_video)
        frame_count = int(frames.shape[0])
        height = int(frames.shape[1])
        width = int(frames.shape[2])

        _send_status(unique_id, "2/3 计算外扩画布并对齐 LTX 倍数...", 0.30)
        canvas_width, canvas_height, left_pad, right_pad, top_pad, bottom_pad = _resolve_canvas(
            width,
            height,
            str(expand_mode),
            int(alignment),
            int(left),
            int(right),
            int(top),
            int(bottom),
            int(target_width),
            int(target_height),
            str(target_ratio),
            str(anchor),
        )
        if canvas_width == width and canvas_height == height:
            raise RuntimeError("外扩后的画布与原视频尺寸相同。请增加边距、目标比例或目标尺寸。")

        _send_status(unique_id, f"3/3 生成外扩帧：{width}x{height} -> {canvas_width}x{canvas_height}...", 0.65)
        output_frames = _fill_canvas(
            frames,
            str(fill_mode),
            canvas_width,
            canvas_height,
            left_pad,
            top_pad,
            str(fill_color),
        )
        mask = _make_mask(frame_count, canvas_height, canvas_width, left_pad, right_pad, top_pad, bottom_pad)
        video = _create_video(output_frames, audio, fps)
        _send_status(
            unique_id,
            f"完成：{frame_count} 帧 / {canvas_width} x {canvas_height} / 左{left_pad} 右{right_pad} 上{top_pad} 下{bottom_pad}",
            1.0,
        )
        return (video, output_frames, mask, canvas_width, canvas_height, frame_count, float(fps))


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoOutpaintPad}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 外扩视频填充编辑器"}
