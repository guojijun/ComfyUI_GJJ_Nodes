from __future__ import annotations

import json
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

    @staticmethod
    def _type_set(value):
        if isinstance(value, (list, tuple, set)):
            parts = []
            for item in value:
                parts.extend(str(item).split(","))
        else:
            parts = str(value).split(",")
        return {part.strip() for part in parts if part.strip()}

    def __ne__(self, other):
        if self.allowed_types == "*" or other == "*":
            return False
        allowed = self._type_set(self.allowed_types)
        incoming = self._type_set(other)
        return not (incoming.issubset(allowed) or allowed.issubset(incoming))


class AnyOfInput(MultiInput):
    def __ne__(self, other):
        if self.allowed_types == "*" or other == "*":
            return False
        allowed = self._type_set(self.allowed_types)
        incoming = self._type_set(other)
        return not bool(allowed.intersection(incoming))


image_or_latent = MultiInput(
    f"{GJJ_BATCH_IMAGE_TYPE},IMAGE", [GJJ_BATCH_IMAGE_TYPE, "IMAGE", "LATENT", "VIDEO"]
)
FRAME_RATE_INPUT_TYPE = "INT,FLOAT,VIDEO"
AUDIO_INPUT_TYPE = "AUDIO,VIDEO"
# Keep the frontend-facing type numeric so ComfyUI creates the FPS widget.
# AnyOfInput still accepts INT/FLOAT/VIDEO links during backend validation.
float_or_int = AnyOfInput("FLOAT", ["INT", "FLOAT", "VIDEO"])
audio_or_video = AnyOfInput(AUDIO_INPUT_TYPE, ["AUDIO", "VIDEO"])


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value: Any) -> Any | None:
    if not hasattr(value, "get_components"):
        return None
    try:
        return value.get_components()
    except Exception as exc:
        raise RuntimeError(f"读取 VIDEO 输入失败：{exc}") from exc


def _audio_from_input(value: Any) -> Any:
    components = _video_components(value)
    if components is None:
        return value
    return _component_value(components, "audio")


def _frame_rate_from_input(value: Any) -> Any:
    components = _video_components(value)
    if components is not None:
        frame_rate = _component_value(components, "frame_rate")
        if frame_rate is not None:
            return frame_rate
    if callable(getattr(value, "get_frame_rate", None)):
        try:
            frame_rate = value.get_frame_rate()
            if frame_rate is not None:
                return frame_rate
        except Exception:
            pass
    if isinstance(value, dict):
        for key in ("frame_rate", "fps", "frameRate", "source_fps", "source_video_fps"):
            if value.get(key) is not None:
                return value.get(key)
    return value


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
                        "tooltip": "输出动画或视频的帧率。可连接 INT、FLOAT 或 VIDEO；连接 VIDEO 时读取该视频帧率。",
                    },
                ),
                "loop_count": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "循环次数",
                        "tooltip": "GIF/WEBP 写入循环次数；video/* 格式会实际重复内容。",
                    },
                ),
                "filename_prefix": (
                    "STRING",
                    {
                        "default": DEFAULT_FILENAME_PREFIX,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "文件名前缀",
                        "tooltip": "支持子目录和 GJJ_SETNODE / 模板参数变量占位，例如 video/第{当前分段}段。",
                    },
                ),
                "format_name": (
                    supported_formats,
                    {
                        "default": default_format,
                        "display": "hidden",
                        "hidden": True,
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
                "delete_tail_frame": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "删除尾帧",
                        "tooltip": "开启后在合成前删除时间线最后一帧，适合去掉重复尾帧或循环衔接帧。",
                    },
                ),
                "save_metadata": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "保存元数据",
                        "tooltip": "写入 ComfyUI 工作流元数据；不支持元数据的格式会自动忽略。",
                    },
                ),
                "trim_to_audio": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "按音频裁切",
                        "tooltip": "封入音频时，开启后按音频长度裁切；关闭时会补足音频到视频时长。",
                    },
                ),
                "pix_fmt": (
                    [
                        "auto",
                        "yuv420p",
                        "yuv420p10le",
                        "yuva420p",
                        "p010le",
                        "rgba64le",
                        "bgra",
                        "yuv444p",
                        "yuv444p10le",
                    ],
                    {
                        "default": "auto",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "像素格式",
                        "tooltip": "默认 auto 使用当前输出格式预设；手动选择后覆盖 VHS pix_fmt。",
                    },
                ),
                "crf": (
                    "STRING",
                    {
                        "default": "-1",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "CRF 画质",
                        "tooltip": "-1 表示使用当前输出格式预设；0-100 会覆盖 VHS crf，数值越低质量越高。",
                    },
                ),
            },
            "optional": {

                "audio": (
                    audio_or_video,
                    {
                        "display_name": "音频",
                        "tooltip": "可选。可连接 AUDIO 或 VIDEO；连接 VIDEO 时读取其中音轨并封入输出。",
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
        delete_tail_frame=False,
        save_metadata=True,
        trim_to_audio=False,
        pix_fmt="auto",
        crf="-1",
        vae=None,
        audio=None,
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
        if frame_rate is None:
            frame_rate = images if _video_components(images) is not None else None
            if frame_rate is None:
                frame_rate = next(
                    (value for value in legacy_video_inputs.values() if _video_components(value) is not None),
                    DEFAULT_FRAME_RATE,
                )
        try:
            resolved_frame_rate = float(_frame_rate_from_input(frame_rate))
        except Exception as exc:
            raise RuntimeError(f"帧率必须是可转换为数字的 INT/FLOAT，或包含帧率的 VIDEO：{frame_rate!r}") from exc
        resolved_audio = _audio_from_input(audio)
        format_overrides: dict[str, Any] = {}
        raw_overrides = str(format_overrides_json or "").strip()
        if raw_overrides:
            try:
                parsed_overrides = json.loads(raw_overrides)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"格式高级参数(JSON) 解析失败：{exc}") from exc
            if not isinstance(parsed_overrides, dict):
                raise RuntimeError("格式高级参数(JSON) 必须是 JSON 对象。")
            format_overrides.update(parsed_overrides)
        format_overrides["save_metadata"] = bool(save_metadata)
        format_overrides["trim_to_audio"] = bool(trim_to_audio)
        if str(pix_fmt or "auto") != "auto":
            format_overrides["pix_fmt"] = str(pix_fmt)
        try:
            crf_text = str(crf if crf is not None else "").strip()
            crf_value = int(float(crf_text)) if crf_text else -1
        except Exception:
            crf_value = -1
        if crf_value >= 0:
            format_overrides["crf"] = crf_value

        return combine_video(
            images=images,
            video_inputs=legacy_video_inputs,
            frame_rate=resolved_frame_rate,
            loop_count=loop_count,
            filename_prefix=filename_prefix,
            format_name=format_name,
            pingpong=pingpong,
            save_output=save_output,
            use_source_fps=use_source_fps,
            delete_tail_frame=delete_tail_frame,
            vae=vae,
            audio=resolved_audio,
            format_overrides_json=json.dumps(format_overrides, ensure_ascii=False),
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
            unique_id=unique_id,
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoCombine}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ 视频合成器VHS"}
