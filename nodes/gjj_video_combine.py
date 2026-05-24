from __future__ import annotations

from typing import Any

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE
from .gjj_video_combine_runtime import (
    DEFAULT_FILENAME_PREFIX,
    DEFAULT_FORMAT,
    DEFAULT_FRAME_RATE,
    combine_video,
    get_video_formats,
    list_supported_formats,
)

NODE_NAME = "GJJ_VideoCombine"


class MultiInput(str):
    def __new__(cls, string: str, allowed_types="*"):
        instance = super().__new__(cls, string)
        instance.allowed_types = allowed_types
        return instance

    def __ne__(self, other):
        if self.allowed_types == "*" or other == "*":
            return False
        return other not in self.allowed_types


image_or_latent = MultiInput(
    f"{GJJ_BATCH_IMAGE_TYPE},IMAGE", [GJJ_BATCH_IMAGE_TYPE, "IMAGE", "LATENT", "VIDEO"]
)
float_or_int = MultiInput("FLOAT", ["FLOAT", "INT"])


class GJJ_VideoCombine:
    CATEGORY = "GJJ"
    FUNCTION = "combine"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "将 Video Helper Suite 的 Video Combine 迁移为 GJJ 本地零依赖节点："
        "支持 IMAGE/LATENT 序列输出 GIF、WEBP、PNG 序列和多种 FFmpeg 视频格式，"
        "也支持多个官方 VIDEO 顺序合并，可选封入音频，并同时产出官方 VIDEO 对象。"
    )
    SEARCH_ALIASES = [
        "Video Combine",
        "VHS Video Combine",
        "视频合成",
        "图片合成视频",
        "视频合并",
        "合并视频",
        "拼接视频",
        "导出视频",
        "导出GIF",
    ]
    RETURN_TYPES = ("VIDEO", "STRING", "STRING")
    RETURN_NAMES = ("视频", "主输出文件", "输出文件列表JSON")
    OUTPUT_TOOLTIPS = (
        "官方 VIDEO 输出，可继续接到 Save Video、视频裁切或其它视频节点。",
        "本次写出的主输出文件完整路径；序列输出时返回第一张。",
        "本次写出的全部文件路径 JSON 数组。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        video_formats, _ = get_video_formats()
        supported_formats = list_supported_formats()
        default_format = (
            DEFAULT_FORMAT
            if DEFAULT_FORMAT in supported_formats
            else (video_formats[0] if video_formats else supported_formats[0])
        )
        return {
            "required": {
                "images": (
                    image_or_latent,
                    {
                        "display_name": "图像",
                        "tooltip": "支持 GJJ_BATCH_IMAGE、IMAGE batch、LATENT、官方 VIDEO 或 VIDEO 序列；接 VIDEO 时自动走视频合并。",
                    },
                ),
                "frame_rate": (
                    float_or_int,
                    {
                        "default": DEFAULT_FRAME_RATE,
                        "min": 1,
                        "step": 1,
                        "display_name": "帧率",
                        "tooltip": "输出动画或视频的帧率。",
                    },
                ),
                "loop_count": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "display_name": "循环次数",
                        "tooltip": "GIF/WEBP 写入循环次数；video/* 格式会实际重复内容。",
                    },
                ),
                "filename_prefix": (
                    "STRING",
                    {
                        "default": DEFAULT_FILENAME_PREFIX,
                        "display_name": "文件名前缀",
                        "tooltip": "支持子目录，例如 video/MyJob。",
                    },
                ),
                "format_name": (
                    supported_formats,
                    {
                        "default": default_format,
                        "display_name": "输出格式",
                        "tooltip": "image/* 使用 Pillow；video/* 使用 GJJ 包内本地格式预设。",
                    },
                ),
                "pingpong": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "往返播放",
                        "tooltip": "正放后再倒放一遍中间帧，适合短动画闭环。",
                    },
                ),
                "save_output": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "保存到输出目录",
                        "tooltip": "关闭后改写到 ComfyUI 的 temp 目录。",
                    },
                ),
                "use_source_fps": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "使用源视频帧率",
                        "tooltip": "接入合并视频时，开启后使用第一段视频的帧率；未接视频或关闭时使用上方帧率。",
                    },
                ),
            },
            "optional": {
                "audio": (
                    "AUDIO",
                    {
                        "advanced": True,
                        "display_name": "音频",
                        "tooltip": "可选。接入后会在支持的格式里封入音轨，VIDEO 输出也会保留音频。",
                    },
                ),
                "vae": (
                    "VAE",
                    {
                        "advanced": True,
                        "display_name": "VAE 解码器",
                        "tooltip": "仅当上方输入 LATENT 时需要连接。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def combine(
        self,
        images,
        frame_rate,
        loop_count,
        filename_prefix,
        format_name,
        pingpong,
        save_output,
        use_source_fps,
        audio=None,
        vae=None,
        format_overrides_json="",
        prompt=None,
        extra_pnginfo=None,
        unique_id: Any = None,
        **kwargs,
    ):
        legacy_video_inputs = {
            key: value
            for key, value in kwargs.items()
            if str(key or "").startswith("video_") and value is not None
        }
        return combine_video(
            images=images,
            video_inputs=legacy_video_inputs,
            frame_rate=frame_rate,
            loop_count=loop_count,
            filename_prefix=filename_prefix,
            format_name=format_name,
            pingpong=pingpong,
            save_output=save_output,
            use_source_fps=use_source_fps,
            audio=audio,
            vae=vae,
            format_overrides_json=format_overrides_json,
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
            unique_id=unique_id,
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoCombine}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ 视频合成器VHS"}
