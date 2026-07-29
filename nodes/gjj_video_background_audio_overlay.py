from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F

from .gjj_audio_tools import GJJ_AudioVocalBackgroundMixer


NODE_NAME = "GJJ_VideoBackgroundAudioOverlay"
NODE_DISPLAY_NAME = "GJJ · 🎚️ 视频背景音叠加"


def _fast_file_audio_overlay(
    video: Any,
    background_audio: dict[str, Any],
    original_gain: float,
    background_gain: float,
    normalize_peak: bool,
    combine_mode: str,
):
    """Copy the encoded video stream and rebuild only the audio stream."""
    from comfy_api.latest import InputImpl

    from .gjj_ffmpeg_tools import (
        VIDEO_SUFFIXES,
        _ffmpeg,
        _preview_item,
        _resolve_media_path,
        _run,
        _unique_output_path,
        _write_audio_wav,
    )

    source_path = _resolve_media_path(video, VIDEO_SUFFIXES)
    if source_path is None:
        return None
    output_path = _unique_output_path(
        "video/GJJ_BackgroundAudioOverlay",
        ".mp4",
        marker="FastAudioMux",
    )
    ffmpeg_path = _ffmpeg("")
    with tempfile.TemporaryDirectory(prefix="gjj_audio_overlay_") as temp_dir:
        background_path = Path(temp_dir) / "background.wav"
        _write_audio_wav(background_audio, background_path)
        if str(combine_mode) == "左右声道极速结合":
            limiter = ",alimiter=limit=0.95" if bool(normalize_peak) else ""
            audio_filter = (
                f"[0:a:0]aformat=channel_layouts=mono,volume={float(original_gain):.8g}[voice];"
                f"[1:a:0]aformat=channel_layouts=mono,volume={float(background_gain):.8g}[music];"
                f"[voice][music]join=inputs=2:channel_layout=stereo{limiter}[aout]"
            )
        else:
            limiter = ",alimiter=limit=0.95" if bool(normalize_peak) else ""
            audio_filter = (
                f"[0:a:0]volume={float(original_gain):.8g}[voice];"
                f"[1:a:0]volume={float(background_gain):.8g}[music];"
                f"[voice][music]amix=inputs=2:duration=first:dropout_transition=0{limiter}[aout]"
            )
        command = [
            ffmpeg_path,
            "-y",
            "-i",
            str(source_path),
            "-i",
            str(background_path),
            "-filter_complex",
            audio_filter,
            "-map",
            "0:v:0",
            "-map",
            "[aout]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        try:
            _run(command)
        except Exception:
            output_path.unlink(missing_ok=True)
            raise
    preview = _preview_item(output_path, "output", "video/mp4")
    return InputImpl.VideoFromFile(str(output_path)), preview, source_path, output_path


def _audio_to_torch(audio: Any, label: str) -> dict[str, Any]:
    if not isinstance(audio, dict):
        raise RuntimeError(f"{label}不是有效 AUDIO。")
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate") or 0)
    if sample_rate <= 0:
        raise RuntimeError(f"{label}缺少有效 sample_rate。")
    if not isinstance(waveform, torch.Tensor):
        try:
            waveform = torch.as_tensor(waveform, dtype=torch.float32)
        except Exception as exc:
            raise RuntimeError(f"{label}缺少有效 waveform。") from exc
    return {"waveform": waveform.detach().float().contiguous(), "sample_rate": sample_rate}


def _extract_video(video: Any) -> tuple[torch.Tensor, dict[str, Any], float]:
    if video is None or not hasattr(video, "get_components"):
        raise RuntimeError("请连接带音频的 ComfyUI VIDEO 输入。")
    try:
        components = video.get_components()
        frames = getattr(components, "images", None)
        source_audio = getattr(components, "audio", None)
        fps = float(getattr(components, "frame_rate", 0.0) or 0.0)
    except Exception as exc:
        raise RuntimeError(f"读取输入视频失败：{exc}") from exc
    if not isinstance(frames, torch.Tensor) or frames.ndim != 4 or int(frames.shape[0]) <= 0:
        raise RuntimeError("输入 VIDEO 缺少有效图片帧。")
    if source_audio is None:
        raise RuntimeError("输入 VIDEO 没有原音轨；本节点需要输入带音频的视频。")
    if fps <= 0:
        raise RuntimeError("输入 VIDEO 缺少有效帧率。")
    return frames.detach().float().cpu().contiguous(), _audio_to_torch(source_audio, "视频原音轨"), fps


def _fit_audio_duration(audio: dict[str, Any], seconds: float) -> dict[str, Any]:
    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    target = max(1, int(round(max(0.0, float(seconds)) * sample_rate)))
    current = int(waveform.shape[-1])
    if current > target:
        waveform = waveform[..., :target]
    elif current < target:
        padding = torch.zeros(
            (*waveform.shape[:-1], target - current),
            dtype=waveform.dtype,
            device=waveform.device,
        )
        waveform = torch.cat([waveform, padding], dim=-1)
    return {"waveform": waveform.contiguous(), "sample_rate": sample_rate}


def _fast_left_right_combine(
    source_audio: dict[str, Any],
    background_audio: dict[str, Any],
    duration: float,
    original_gain: float,
    background_gain: float,
    normalize_peak: bool,
) -> dict[str, Any]:
    mixer = GJJ_AudioVocalBackgroundMixer
    source, sample_rate = mixer._normalize_audio(source_audio, "视频原音轨")
    background, background_rate = mixer._normalize_audio(background_audio, "叠加音频")
    if background_rate != sample_rate:
        target_samples = max(
            1,
            int(round(float(background.shape[-1]) / float(background_rate) * sample_rate)),
        )
        background = F.interpolate(
            background.float(),
            size=target_samples,
            mode="linear",
            align_corners=False,
        )
    target_samples = max(1, int(round(float(duration) * sample_rate)))
    source_mono = mixer._pad_to(source[:1].mean(dim=1, keepdim=True), target_samples)
    background_mono = mixer._pad_to(background[:1].mean(dim=1, keepdim=True), target_samples)
    stereo = torch.cat(
        [
            source_mono * float(original_gain),
            background_mono * float(background_gain),
        ],
        dim=1,
    )
    if bool(normalize_peak):
        peak = float(stereo.abs().max().item()) if stereo.numel() else 0.0
        if peak > 1.0:
            stereo = stereo / peak
    return {
        "waveform": stereo.clamp(-1.0, 1.0).contiguous(),
        "sample_rate": int(sample_rate),
    }


class GJJ_VideoBackgroundAudioOverlay:
    CATEGORY = "GJJ/视频/音频"
    FUNCTION = "overlay"
    OUTPUT_NODE = True
    DESCRIPTION = "将另一段 AUDIO 叠加到带原音轨的视频中，在节点内预览混音结果；VIDEO 输出口可用但不要求连接。"
    SEARCH_ALIASES = ["视频背景音", "视频混音", "背景音乐叠加", "video audio mix", "overlay audio"]
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("叠加背景音的视频",)
    OUTPUT_TOOLTIPS = ("带混合音轨的 VIDEO；输出口无需连接，本节点仍会作为终端节点执行并显示预览。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": (
                    "VIDEO",
                    {
                        "display_name": "带音频的视频",
                        "tooltip": "必须包含原音轨的 ComfyUI VIDEO。",
                    },
                ),
                "background_audio": (
                    "AUDIO",
                    {
                        "display_name": "叠加音频",
                        "tooltip": "要叠加到视频原音轨上的另一段 AUDIO。",
                    },
                ),
                "original_gain": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 4.0,
                        "step": 0.01,
                        "display_name": "视频原声音量",
                    },
                ),
                "background_gain": (
                    "FLOAT",
                    {
                        "default": 0.35,
                        "min": 0.0,
                        "max": 4.0,
                        "step": 0.01,
                        "display_name": "叠加音频音量",
                    },
                ),
                "normalize_peak": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "防爆音归一化",
                        "tooltip": "混合峰值超过安全范围时整体缩放，避免削波爆音。",
                    },
                ),
                "combine_mode": (
                    ["左右声道极速结合", "普通立体声叠加"],
                    {
                        "default": "左右声道极速结合",
                        "display_name": "结合方式",
                        "tooltip": "极速：视频原声放左声道、叠加音频放右声道；普通：两路音频在左右声道内自然求和。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def overlay(
        self,
        video,
        background_audio,
        original_gain=1.0,
        background_gain=0.35,
        normalize_peak=True,
        combine_mode="左右声道极速结合",
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        overlay_audio = _audio_to_torch(background_audio, "叠加音频")
        try:
            fast_result = _fast_file_audio_overlay(
                video,
                overlay_audio,
                float(original_gain),
                float(background_gain),
                bool(normalize_peak),
                str(combine_mode),
            )
        except Exception as exc:
            raise RuntimeError(f"视频背景音快速流复制失败：{exc}") from exc
        if fast_result is not None:
            output_video, preview, source_path, output_path = fast_result
            return {
                "ui": {
                    "preview_media": [preview],
                    "preview_is_video": [True],
                    "text": [
                        f"背景音叠加完成：{combine_mode} / 视频流直接复制，仅重新编码音频\n"
                        f"源视频：{source_path.name}\n输出：{output_path.name}"
                    ],
                },
                "result": (output_video,),
            }

        frames, source_audio, fps = _extract_video(video)
        duration = float(frames.shape[0]) / float(fps)
        if str(combine_mode) == "左右声道极速结合":
            mixed_audio = _fast_left_right_combine(
                source_audio,
                overlay_audio,
                duration,
                float(original_gain),
                float(background_gain),
                bool(normalize_peak),
            )
        else:
            mixed_audio = GJJ_AudioVocalBackgroundMixer().mix(
                vocal_audio=source_audio,
                background_audio=overlay_audio,
                vocal_gain=float(original_gain),
                background_gain=float(background_gain),
                normalize_peak=bool(normalize_peak),
            )[0]
            mixed_audio = _fit_audio_duration(mixed_audio, duration)

        try:
            from .gjj_video_combine_runtime import combine_video

            encoded = combine_video(
                images=frames,
                frame_rate=fps,
                loop_count=0,
                filename_prefix="video/GJJ_BackgroundAudioOverlay",
                format_name="video/h264-mp4",
                pingpong=False,
                save_output=False,
                audio=mixed_audio,
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
                unique_id=unique_id,
            )
        except Exception as exc:
            raise RuntimeError(f"视频背景音叠加编码失败：{exc}") from exc

        ui = dict(encoded.get("ui") or {}) if isinstance(encoded, dict) else {}
        encoded_result = encoded.get("result") if isinstance(encoded, dict) else None
        output_video = encoded_result[0] if isinstance(encoded_result, (tuple, list)) and encoded_result else None
        if output_video is None:
            raise RuntimeError("视频背景音叠加完成，但没有得到有效 VIDEO 输出。")
        ui["text"] = [
            f"背景音叠加完成：{combine_mode} / {int(frames.shape[0])} 帧 / {fps:.3f} fps / {duration:.3f} 秒"
        ]
        return {"ui": ui, "result": (output_video,)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoBackgroundAudioOverlay}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
