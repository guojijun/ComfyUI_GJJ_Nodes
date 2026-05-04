from __future__ import annotations

from typing import Any

import torch


NODE_NAME = "GJJ_VideoReverseFrame"


def _normalize_image_batch(video_frames: Any) -> torch.Tensor:
    if not isinstance(video_frames, torch.Tensor):
        raise RuntimeError("输入视频帧必须是 ComfyUI 的 IMAGE 张量。")

    if video_frames.ndim == 3:
        video_frames = video_frames.unsqueeze(0)

    if video_frames.ndim != 4:
        raise RuntimeError(
            f"输入视频帧维度不正确：期望 [帧数, 高, 宽, 通道]，实际为 {tuple(video_frames.shape)}。"
        )

    frame_count = int(video_frames.shape[0])
    if frame_count <= 0:
        raise RuntimeError("输入视频帧为空，无法提取图片。")

    return video_frames


class GJJ_VideoReverseFrame:
    CATEGORY = "GJJ/Video"
    FUNCTION = "extract"
    DESCRIPTION = "从输入视频帧序列中提取倒数第 N 帧，输出同尺寸的单张静态图片。"
    SEARCH_ALIASES = ["视频帧提取", "最后一帧", "倒数帧", "last frame", "video frame"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("静态图片",)
    OUTPUT_TOOLTIPS = ("从输入视频帧序列中提取出的单张图片，尺寸与原视频帧保持一致。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_frames": ("IMAGE", {
                    "forceInput": True,
                    "display_name": "输入视频帧",
                    "tooltip": "连接视频加载、视频解码或视频生成节点输出的 IMAGE 帧序列。",
                }),
                "nth_from_end": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 100000,
                    "step": 1,
                    "display_name": "倒数第几帧",
                    "tooltip": "1 表示最后一帧，2 表示倒数第二帧，依此类推。",
                }),
            },
        }

    def extract(self, video_frames, nth_from_end: int = 1):
        frames = _normalize_image_batch(video_frames)
        frame_count = int(frames.shape[0])
        offset = int(nth_from_end)
        if offset < 1:
            raise RuntimeError("倒数第几帧必须大于等于 1。")
        if offset > frame_count:
            raise RuntimeError(f"输入只有 {frame_count} 帧，无法提取倒数第 {offset} 帧。")

        frame_index = frame_count - offset
        return (frames[frame_index:frame_index + 1].clone().contiguous(),)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoReverseFrame}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ 视频倒数帧"}
