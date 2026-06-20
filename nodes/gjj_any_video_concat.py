from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

import torch

try:
    from comfy_api.latest import InputImpl
except Exception:
    InputImpl = None

from .gjj_any_switch import AnyType, FlexibleOptionalInputType
from .gjj_ffmpeg_tools import (
    VIDEO_SUFFIXES,
    _collect_media_paths,
    _condition_enabled,
    _concat_videos,
    _ffmpeg,
    _ffprobe,
    _fps_from_value,
    _find_prefixed_videos,
    _preview_item,
    _prefixed_videos_signature,
    _run,
    _safe_output_info,
    _segment_prefix_text,
    _trim_tail_frame,
    _unique_output_path,
    _write_audio_wav,
    _write_frames,
    _tensor_from_media,
)
from .gjj_video_combine_runtime import _render_filename_prefix_template


NODE_NAME = "GJJ_AnyVideoConcat"
VIDEO_INPUT_TYPE = "VIDEO,STRING"
any_type = AnyType("*")


def _input_index(name: str) -> int:
    text = str(name or "")
    if not text.startswith("video_"):
        return 999999
    try:
        return int(text[6:])
    except Exception:
        return 999999


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str) and not value.strip():
        return True
    return False


def _collect_video_inputs(kwargs: dict[str, Any]) -> list[Any]:
    values: list[Any] = []
    for key in sorted(kwargs.keys(), key=_input_index):
        if not str(key).startswith("video_"):
            continue
        value = kwargs.get(key)
        if not _is_empty(value):
            values.append(value)
    return values


def _dependency_signature(value: Any) -> str:
    paths = _collect_media_paths(value, VIDEO_SUFFIXES)
    if paths:
        return ",".join(str(path) for path in paths)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return str(value)
    return str(id(value))


def _input_to_video_path(value: Any, index: int, tmp_path: Path, ffmpeg: str, fps: float) -> Path | None:
    paths = _collect_media_paths(value, VIDEO_SUFFIXES)
    if paths:
        return paths[0]

    frames, source_audio, source_fps = _tensor_from_media(value)
    if frames is None:
        frames, source_fps = _frames_from_video_components(value)
        source_audio = _audio_from_video_components(value)
    if frames is None:
        return None

    effective_fps = _fps_from_value(source_fps, fps)
    frame_dir = tmp_path / f"frames_{index:02d}"
    frame_dir.mkdir(parents=True, exist_ok=True)
    frame_pattern = _write_frames(frames, frame_dir)
    output = tmp_path / f"input_{index:02d}.mp4"
    command = [
        ffmpeg,
        "-y",
        "-framerate",
        str(float(effective_fps)),
        "-i",
        frame_pattern,
    ]
    audio_path = None
    if isinstance(source_audio, dict) and source_audio.get("waveform") is not None:
        audio_path = tmp_path / f"input_{index:02d}_audio.wav"
        _write_audio_wav(source_audio, audio_path)
        command.extend(["-i", str(audio_path), "-map", "0:v:0", "-map", "1:a:0"])
    command.extend([
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
    ])
    if audio_path is not None:
        command.extend(["-c:a", "aac", "-shortest"])
    command.append(str(output))
    _run(command)
    return output if output.exists() else None


def _audio_from_video_components(value: Any) -> Any | None:
    getter = getattr(value, "get_components", None)
    if not callable(getter):
        return None
    try:
        components = getter()
    except Exception:
        return None
    return _component_value(components, "audio")


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _frames_from_video_components(value: Any) -> tuple[torch.Tensor | None, float | None]:
    getter = getattr(value, "get_components", None)
    if not callable(getter):
        return None, None
    try:
        components = getter()
    except Exception:
        return None, None

    frames = _component_value(components, "images")
    fps = _component_value(components, "frame_rate")
    if not isinstance(frames, torch.Tensor):
        return None, None
    if frames.ndim == 3:
        frames = frames.unsqueeze(0)
    if frames.ndim != 4:
        return None, None
    if frames.shape[-1] not in (1, 3, 4) and frames.shape[1] in (1, 3, 4):
        frames = frames.permute(0, 2, 3, 1)
    if frames.shape[-1] == 1:
        frames = frames.repeat(1, 1, 1, 3)
    elif frames.shape[-1] >= 4:
        frames = frames[..., :3]
    elif frames.shape[-1] != 3:
        return None, None
    try:
        fps_value = float(fps)
    except Exception:
        fps_value = None
    return frames.detach().float().clamp(0.0, 1.0).contiguous(), fps_value


def _video_frame_count(path: Path, ffprobe: str, fallback_fps: float) -> int:
    try:
        info = _safe_output_info(path, ffprobe, fallback_fps)
        return max(0, int(info[4] or 0))
    except Exception:
        return 0


def _scene_cuts_from_counts(frame_counts: list[int]) -> list[int]:
    cuts: list[int] = []
    cursor = 1
    for count in frame_counts[:-1]:
        cursor += max(0, int(count or 0))
        if cursor > 1:
            cuts.append(cursor)
    return cuts


class GJJ_AnyVideoConcat:
    CATEGORY = "GJJ/视频"
    FUNCTION = "concat"
    OUTPUT_NODE = True
    DESCRIPTION = "动态输入任意数量视频，按输入顺序拼合成一段视频；可删除衔接处重复锚点帧，并在节点和队列里显示预览。"
    SEARCH_ALIASES = ["any video concat", "video concat", "video merge", "多视频合并", "任意视频合并", "视频拼接"]
    RETURN_TYPES = ("VIDEO", "STRING", "FLOAT", "INT", "STRING")
    RETURN_NAMES = ("视频", "输出视频路径", "视频时长", "总帧数", "合并信息JSON")
    OUTPUT_TOOLTIPS = (
        "合并后的视频对象。",
        "合并后 mp4 文件路径。",
        "输出视频时长秒。",
        "输出视频帧数估算。",
        "输入片段、输出尺寸、帧率等信息。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "filename_prefix": ("STRING", {
                    "default": "GJJ/video_concat/concat",
                    "display_name": "待合并视频前缀",
                    "tooltip": "未连接视频输入时，用此前缀查找要合并的分段视频；合并结果会以此前缀派生命名并保存到 ComfyUI output 目录。",
                }),
                "fps": ("FLOAT", {
                    "default": 30.0,
                    "min": 1.0,
                    "max": 240.0,
                    "step": 0.01,
                    "display_name": "默认帧率",
                    "tooltip": "当输入 VIDEO 无法提供帧率时使用。",
                }),
                "delete_anchor_frame": ("BOOLEAN", {
                    "default": True,
                    "display_name": "删除衔接锚点帧",
                    "tooltip": "开启后删除每个非最后片段的最后一帧，避免 [1,41] + [41,81] 这类尾首锚点重复。",
                }),
                "ffmpeg_path": ("STRING", {
                    "default": "",
                    "display_name": "",
                    "tooltip": "内部高级参数：ffmpeg 可执行文件路径。留空自动查找。",
                    "display": "hidden",
                    "hidden": True,
                }),
                "ffprobe_path": ("STRING", {
                    "default": "",
                    "display_name": "",
                    "tooltip": "内部高级参数：ffprobe 可执行文件路径。留空自动查找。",
                    "display": "hidden",
                    "hidden": True,
                }),
            },
            "optional": FlexibleOptionalInputType(VIDEO_INPUT_TYPE, {
                "condition": ("BOOLEAN", {
                    "default": True,
                    "display_name": "条件通行",
                    "tooltip": "可选布尔门控；未连接时默认为真。为假时本节点不执行，下游到此停止。",
                }),
                "wait_for": (any_type, {
                    "display_name": "等待完成",
                    "tooltip": "任意类型依赖输入；不参与合并，只用于等待最后一段或其它上游节点执行完成后再开始合并。",
                }),
            }),
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        filename_prefix: str,
        fps: float = 30.0,
        delete_anchor_frame: bool = True,
        ffmpeg_path: str = "",
        ffprobe_path: str = "",
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
        **kwargs,
    ):
        parts = [
            str(_condition_enabled(kwargs.get("condition", True))),
            _dependency_signature(kwargs.get("wait_for")),
            str(filename_prefix or ""),
            _prefixed_videos_signature(_segment_prefix_text(filename_prefix)),
            str(float(fps or 30.0)),
            str(bool(delete_anchor_frame)),
        ]
        for value in _collect_video_inputs(kwargs):
            paths = _collect_media_paths(value, VIDEO_SUFFIXES)
            parts.extend(str(path) for path in paths)
            if not paths:
                parts.append(str(id(value)))
        return "|".join(parts)

    def concat(
        self,
        filename_prefix: str,
        fps: float = 30.0,
        delete_anchor_frame: bool = True,
        ffmpeg_path: str = "",
        ffprobe_path: str = "",
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
        **kwargs,
    ):
        condition = kwargs.get("condition", True)
        if not _condition_enabled(condition):
            info_json = json.dumps({"skipped": True, "reason": "condition_false"}, ensure_ascii=False, indent=2)
            return {
                "ui": {"text": ["条件通行关闭，任意视频合并节点已跳过。"]},
                "result": (None, "", 0.0, 0, info_json),
            }

        ffmpeg = _ffmpeg(ffmpeg_path)
        ffprobe = _ffprobe(ffprobe_path, ffmpeg)
        fps_value = _fps_from_value(fps, 30.0)
        resolved_prefix = _render_filename_prefix_template(
            filename_prefix or "GJJ/video_concat/concat",
            prompt,
            {
                "frame_rate": fps_value,
                "frameRate": fps_value,
                "fps": fps_value,
                "帧率": fps_value,
            },
            extra_pnginfo,
        )
        output_path = _unique_output_path(str(resolved_prefix or "GJJ/video_concat/concat"), ".mp4", marker="Concat")

        source_paths: list[Path] = []
        inputs = _collect_video_inputs(kwargs)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            if inputs:
                for index, value in enumerate(inputs, start=1):
                    path = _input_to_video_path(value, index, tmp_path, ffmpeg, fps_value)
                    if path is None:
                        raise RuntimeError(f"第 {index} 个输入无法解析为视频路径或 VIDEO 帧。")
                    source_paths.append(path)
            else:
                input_prefix = _segment_prefix_text(resolved_prefix or filename_prefix)
                source_paths = _find_prefixed_videos(input_prefix)
                if not source_paths:
                    raise RuntimeError(f"未找到同前缀视频片段：{input_prefix or filename_prefix or '空'}")

            concat_paths = list(source_paths)
            if bool(delete_anchor_frame) and len(concat_paths) > 1:
                trimmed: list[Path] = []
                for index, path in enumerate(concat_paths):
                    if index < len(concat_paths) - 1:
                        trimmed.append(_trim_tail_frame(path, fps_value, tmp_path, ffmpeg, ffprobe))
                    else:
                        trimmed.append(path)
                concat_paths = trimmed

            segment_frame_counts = [_video_frame_count(path, ffprobe, fps_value) for path in concat_paths]
            scene_cut_frames = _scene_cuts_from_counts(segment_frame_counts)
            temp_output = tmp_path / "concat_output.mp4"
            _concat_videos(concat_paths, temp_output, ffmpeg)
            shutil.copy2(temp_output, output_path)

        info_tuple = _safe_output_info(output_path, ffprobe, fps_value)
        _, width, height, output_fps, frame_count, duration, _ = info_tuple
        preview = _preview_item(output_path, "output", "video/mp4")
        preview.update({
            "format": "video/h264-mp4",
            "frame_rate": float(output_fps or fps_value or 0.0),
            "width": int(width),
            "height": int(height),
            "frame_count": int(frame_count),
        })

        if InputImpl is None:
            raise RuntimeError("当前 ComfyUI 环境不支持 InputImpl.VideoFromFile，无法构建 VIDEO 输出。")
        video_output = InputImpl.VideoFromFile(str(output_path))
        for key, value in {
            "gjj_scene_cut_frames": scene_cut_frames,
            "gjj_segment_frame_counts": segment_frame_counts,
            "gjj_concat_info": {
                "scene_cut_frames": scene_cut_frames,
                "segment_frame_counts": segment_frame_counts,
            },
        }.items():
            try:
                setattr(video_output, key, value)
            except Exception:
                pass

        info = {
            "output_path": str(output_path),
            "input_count": len(inputs),
            "source_paths": [str(path) for path in source_paths],
            "segment_frame_counts": segment_frame_counts,
            "scene_cut_frames": scene_cut_frames,
            "delete_anchor_frame": bool(delete_anchor_frame),
            "frame_rate": float(output_fps or fps_value),
            "frame_count": int(frame_count),
            "duration": float(duration),
            "width": int(width),
            "height": int(height),
        }
        info_json = json.dumps(info, ensure_ascii=False, indent=2)
        ui_payload = {
            "preview_main_path": (str(output_path),),
            "preview_format": ("video/h264-mp4",),
            "preview_is_video": (True,),
            "preview_width": (int(width),),
            "preview_height": (int(height),),
            "preview_media": [preview],
            "animated": [dict(preview)],
            "text": [f"已合并 {len(inputs)} 段：{output_path.name}\n时长：{float(duration):.3f} 秒，帧数：{int(frame_count)}"],
        }
        return {
            "ui": ui_payload,
            "result": (video_output, str(output_path), float(duration), int(frame_count), info_json),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AnyVideoConcat}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ 任意视频合并"}
