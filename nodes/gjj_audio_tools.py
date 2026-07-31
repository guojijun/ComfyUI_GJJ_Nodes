from __future__ import annotations

import json
import math
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageDraw

MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
IMAGE_OUTPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE"


def _parse_time(value: str | float | int) -> float:
    text = str(value).strip()
    if not text:
        return 0.0
    if ":" not in text:
        # Users often type "0.06" when they mean "0:06" because the ComfyUI
        # audio preview displays durations as m:ss. Keep normal decimal seconds
        # for values like "0.5", but accept two-digit dot notation as m.ss.
        if "." in text:
            head, tail = text.split(".", 1)
            if head.isdigit() and tail.isdigit() and len(tail) == 2 and int(tail) < 60:
                return max(0.0, int(head) * 60.0 + int(tail))
        return max(0.0, float(text))
    parts = [float(part) for part in text.split(":")]
    if len(parts) == 2:
        return max(0.0, parts[0] * 60.0 + parts[1])
    if len(parts) == 3:
        return max(0.0, parts[0] * 3600.0 + parts[1] * 60.0 + parts[2])
    raise RuntimeError(f"时间格式无效：{value}")


def _mono_waveform(audio: dict[str, Any]) -> tuple[torch.Tensor, int]:
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate") or 44100)
    if not isinstance(waveform, torch.Tensor):
        raise RuntimeError("AUDIO 输入缺少 waveform。")
    value = waveform.detach().float().cpu()
    while value.ndim > 2:
        value = value[0]
    if value.ndim == 2:
        mono = value.mean(dim=0)
    else:
        mono = value
    return mono, sample_rate


def _visualize_beats(waveform: torch.Tensor, sample_rate: int, beats: list[float], bpm: float) -> torch.Tensor:
    width, height = 1024, 320
    image = Image.new("RGB", (width, height), (15, 20, 24))
    draw = ImageDraw.Draw(image)
    values = waveform.numpy()
    if values.size == 0:
        return torch.from_numpy(np.asarray(image).astype(np.float32) / 255.0).unsqueeze(0)
    duration = max(0.001, float(values.size) / float(sample_rate))
    center = height // 2
    step = max(1, int(values.size / width))
    points = []
    for x in range(width):
        start = x * step
        chunk = values[start:start + step]
        amp = float(np.max(np.abs(chunk))) if chunk.size else 0.0
        points.append((x, center - int(amp * 120)))
        points.append((x, center + int(amp * 120)))
    for x in range(0, width, 2):
        if x + 1 < len(points):
            draw.line((points[x][0], points[x][1], points[x + 1][0], points[x + 1][1]), fill=(94, 175, 190))
    for beat in beats:
        x = int((beat / duration) * (width - 1))
        draw.line((x, 24, x, height - 24), fill=(235, 115, 95), width=2)
    draw.text((14, 10), f"BPM {bpm:.2f} / Beats {len(beats)} / {duration:.2f}s", fill=(220, 232, 226))
    return torch.from_numpy(np.asarray(image).astype(np.float32) / 255.0).unsqueeze(0)


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value: Any) -> dict[str, Any] | None:
    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception:
            return None
        return {
            "images": _component_value(components, "images"),
            "frames": _component_value(components, "frames"),
            "audio": _component_value(components, "audio"),
            "frame_rate": _component_value(components, "frame_rate"),
        }
    if isinstance(value, dict) and any(key in value for key in ("images", "image", "frames", "audio", "frame_rate", "fps")):
        return value
    return None


def _normalize_image_tensor(value: torch.Tensor, label: str) -> torch.Tensor:
    tensor = value.detach()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim > 4 and int(tensor.shape[-1]) in (1, 2, 3, 4):
        tensor = tensor.reshape(-1, int(tensor.shape[-3]), int(tensor.shape[-2]), int(tensor.shape[-1]))
    if tensor.ndim != 4:
        raise RuntimeError(f"{label} 必须是 IMAGE/GJJ_BATCH_IMAGE/VIDEO 帧张量，实际维度为 {tuple(tensor.shape)}。")
    if int(tensor.shape[-1]) not in (1, 2, 3, 4) and int(tensor.shape[1]) in (1, 2, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 2:
        tensor = tensor[..., :1].repeat(1, 1, 1, 3)
    elif channels >= 4:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"{label} 图像通道数无效：{tuple(tensor.shape)}。")
    if int(tensor.shape[0]) <= 0:
        raise RuntimeError(f"{label} 没有可用画面帧。")
    return tensor.float().clamp(0.0, 1.0).contiguous()


def _iter_media_values(value: Any) -> list[Any]:
    if value is None or isinstance(value, (str, bytes, bytearray)) or torch.is_tensor(value):
        return []
    if isinstance(value, dict):
        values = []
        for key in ("images", "image", "frames", "frame", "batch", "samples", "items", "values"):
            if key in value:
                values.append(value[key])
        return values
    if isinstance(value, (list, tuple)):
        return list(value)
    values = []
    for name in ("images", "image", "frames", "frame", "batch", "samples", "items", "values"):
        try:
            item = getattr(value, name, None)
        except Exception:
            item = None
        if item is not None and item is not value:
            values.append(item)
    return values


def _extract_media_frames_audio(value: Any, label: str = "源视频") -> tuple[torch.Tensor | None, dict[str, Any] | None, float]:
    if value is None:
        return None, None, 0.0
    components = _video_components(value)
    audio = None
    fps = 0.0
    if components is not None:
        audio_candidate = components.get("audio")
        if isinstance(audio_candidate, dict) and isinstance(audio_candidate.get("waveform"), torch.Tensor):
            audio = audio_candidate
        for key in ("frame_rate", "fps", "source_fps"):
            try:
                fps = float(components.get(key) or 0.0)
            except Exception:
                fps = 0.0
            if fps > 0:
                break
        for key in ("images", "image", "frames", "frame"):
            frames = components.get(key)
            if isinstance(frames, torch.Tensor):
                return _normalize_image_tensor(frames, label), audio, fps
    if isinstance(value, torch.Tensor):
        return _normalize_image_tensor(value, label), audio, fps
    for item in _iter_media_values(value):
        frames, nested_audio, nested_fps = _extract_media_frames_audio(item, label)
        if audio is None:
            audio = nested_audio
        if fps <= 0:
            fps = nested_fps
        if frames is not None:
            return frames, audio, fps
    return None, audio, fps


def _empty_image() -> torch.Tensor:
    return torch.zeros((1, 1, 1, 3), dtype=torch.float32)


class GJJ_AudioCrop:
    CATEGORY = "GJJ/🎵 音频"
    FUNCTION = "crop"
    DESCRIPTION = "按时间裁剪 AUDIO。"
    SEARCH_ALIASES = ["audio crop", "trim audio", "音频裁剪"]
    RETURN_TYPES = ("AUDIO", "FLOAT")
    RETURN_NAMES = ("裁剪音频", "裁剪秒数")
    OUTPUT_TOOLTIPS = ("裁剪后的 AUDIO。", "裁剪后的时长秒数。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"display_name": "音频", "tooltip": "需要裁剪的 AUDIO。"}),
                "start_time": ("STRING", {"default": "0:00", "display_name": "开始时间", "tooltip": "支持秒数、MM:SS、MM.SS 或 HH:MM:SS。"}),
                "end_time": ("STRING", {"default": "1:00", "display_name": "结束时间", "tooltip": "支持秒数、MM:SS、MM.SS 或 HH:MM:SS。"}),
            }
        }

    def crop(self, audio: dict[str, Any], start_time: str, end_time: str):
        waveform = audio.get("waveform")
        sample_rate = int(audio.get("sample_rate") or 44100)
        if not isinstance(waveform, torch.Tensor):
            raise RuntimeError("AUDIO 输入缺少 waveform。")
        total = int(waveform.shape[-1])
        start = int(_parse_time(start_time) * sample_rate)
        end = int(_parse_time(end_time) * sample_rate)
        if total <= 0:
            raise RuntimeError("AUDIO 输入为空，无法裁剪。")
        start = max(0, min(start, total))
        end = max(0, min(end, total))
        if end <= start:
            raise RuntimeError(
                f"结束时间必须大于开始时间：开始 {start_time}，结束 {end_time}。"
                "例如裁剪到 6 秒请填写 0:06 或 0.06。"
            )
        cropped = waveform[..., start:end].contiguous()
        return ({"waveform": cropped, "sample_rate": sample_rate}, float(end - start) / float(sample_rate))


class GJJ_AudioBeatAnalyzer:
    CATEGORY = "GJJ/🎵 音频"
    FUNCTION = "analyze"
    DESCRIPTION = "轻量音频节拍分析，不依赖 librosa，输出 BPM 和节拍时间 JSON。"
    SEARCH_ALIASES = ["bpm", "beat", "audio analyze", "节拍", "音频分析"]
    RETURN_TYPES = ("AUDIO", "FLOAT", "STRING", "IMAGE")
    RETURN_NAMES = ("音频", "BPM", "节拍JSON", "节拍预览")
    OUTPUT_TOOLTIPS = ("原音频透传。", "估算 BPM。", "节拍时间、帧号和基础统计 JSON。", "波形与节拍线预览图。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"display_name": "音频", "tooltip": "需要分析的 AUDIO。"}),
                "sensitivity": ("FLOAT", {"default": 1.35, "min": 1.0, "max": 4.0, "step": 0.05, "display_name": "灵敏度", "tooltip": "越低越容易检测到节拍。"}),
                "min_bpm": ("FLOAT", {"default": 60.0, "min": 20.0, "max": 240.0, "step": 1.0, "display_name": "最低BPM", "tooltip": "限制节拍间隔的最低 BPM。"}),
                "max_bpm": ("FLOAT", {"default": 180.0, "min": 40.0, "max": 320.0, "step": 1.0, "display_name": "最高BPM", "tooltip": "限制节拍间隔的最高 BPM。"}),
                "offset_ms": ("INT", {"default": 0, "min": -5000, "max": 5000, "display_name": "时间偏移ms", "tooltip": "对输出节拍整体平移。"}),
            }
        }

    def analyze(self, audio: dict[str, Any], sensitivity: float, min_bpm: float, max_bpm: float, offset_ms: int):
        mono, sample_rate = _mono_waveform(audio)
        duration = float(mono.numel()) / float(sample_rate)
        if duration <= 0:
            empty = _visualize_beats(torch.zeros(1), sample_rate, [], 0.0)
            return (audio, 0.0, "[]", empty)

        hop = max(128, int(sample_rate * 0.02))
        frame = max(hop * 2, int(sample_rate * 0.05))
        energies = []
        for start in range(0, max(1, int(mono.numel()) - frame), hop):
            chunk = mono[start:start + frame]
            energies.append(float(torch.sqrt(torch.mean(chunk * chunk) + 1e-9)))
        env = np.asarray(energies, dtype=np.float32)
        if env.size < 3:
            beats: list[float] = []
        else:
            smooth = np.convolve(env, np.ones(7, dtype=np.float32) / 7.0, mode="same")
            threshold = float(np.mean(smooth) + np.std(smooth) * (float(sensitivity) - 1.0))
            min_gap = 60.0 / max(float(max_bpm), 1.0)
            max_gap = 60.0 / max(float(min_bpm), 1.0)
            candidates = []
            last_time = -999.0
            for i in range(1, smooth.size - 1):
                if smooth[i] >= threshold and smooth[i] >= smooth[i - 1] and smooth[i] >= smooth[i + 1]:
                    time = float(i * hop) / float(sample_rate)
                    if time - last_time >= min_gap:
                        candidates.append(time)
                        last_time = time
            if len(candidates) > 2:
                gaps = np.diff(np.asarray(candidates))
                valid = gaps[(gaps >= min_gap) & (gaps <= max_gap)]
                interval = float(np.median(valid)) if valid.size else float(np.median(gaps))
                bpm = 60.0 / interval if interval > 0 else 0.0
            else:
                bpm = 0.0
            beats = [max(0.0, min(duration, time + int(offset_ms) / 1000.0)) for time in candidates]
        if len(beats) > 2:
            gaps = np.diff(np.asarray(beats))
            bpm_value = 60.0 / float(np.median(gaps)) if np.median(gaps) > 0 else 0.0
        else:
            bpm_value = 0.0
        payload = {
            "bpm": float(bpm_value),
            "beat_times": beats,
            "beat_frames": [int(round(time * sample_rate)) for time in beats],
            "num_beats": len(beats),
            "sample_rate": sample_rate,
            "audio_duration": duration,
            "method": "energy_peak",
        }
        preview = _visualize_beats(mono, sample_rate, beats, bpm_value)
        return (audio, float(bpm_value), json.dumps(payload, ensure_ascii=False, indent=2), preview)


class GJJ_AudioFrameCount8NPlus1:
    CATEGORY = "GJJ/🎵 音频"
    FUNCTION = "calculate"
    DESCRIPTION = "输入人声和可选背景声，已满足 8n+1 时原样输出；否则只在末尾补静音到 8n+1；可选接入视频/画面，视频音频会从第一路音频输出对齐后输出。"
    SEARCH_ALIASES = ["audio fps frame count", "8n+1", "音频帧数", "帧率"]
    RETURN_TYPES = ("AUDIO", "AUDIO", "INT", IMAGE_OUTPUT_TYPE)
    RETURN_NAMES = ("对齐人声", "对齐背景声", "8n+1帧数", "画面")
    OUTPUT_TOOLTIPS = (
        "源视频带音频时输出对齐后的源音频；否则输出对齐后的人声 AUDIO。",
        "按同一目标长度处理后的背景声 AUDIO；未接背景声时输出等长静音。",
        "最终对齐帧数，保证满足 8n+1。",
        "从源视频 / IMAGE / GJJ_BATCH_IMAGE 输入拆出的画面帧，类型兼容 GJJ_BATCH_IMAGE 和 IMAGE。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vocal_audio": ("AUDIO", {"display_name": "人声", "tooltip": "用于计算时长并对口型的人声 AUDIO。"}),
                "fps": (
                    "FLOAT",
                    {
                        "default": 24.0,
                        "min": 0.01,
                        "max": 240.0,
                        "step": 0.01,
                        "display_name": "帧率",
                        "tooltip": "目标视频帧率。已满足 8n+1 时不改人声；否则只在末尾补静音到 8n+1。",
                    },
                ),
            },
            "optional": {
                "background_audio": ("AUDIO", {"display_name": "背景声", "tooltip": "可选背景声，会和人声使用同一个目标时长对齐。"}),
                "source_video": (MEDIA_INPUT_TYPE, {"display_name": "源视频/画面", "tooltip": "可选。支持 GJJ_BATCH_IMAGE、IMAGE 和官方 VIDEO；VIDEO 会拆出画面与源音频。"}),
            },
        }

    @staticmethod
    def _normalize_audio(audio: dict[str, Any], label: str) -> tuple[dict[str, Any], torch.Tensor, int]:
        waveform = audio.get("waveform") if isinstance(audio, dict) else None
        sample_rate = int(audio.get("sample_rate") or 0) if isinstance(audio, dict) else 0
        if not isinstance(waveform, torch.Tensor):
            raise RuntimeError(f"{label} AUDIO 输入缺少 waveform。")
        if sample_rate <= 0:
            raise RuntimeError(f"{label} AUDIO 输入缺少有效 sample_rate。")
        value = waveform.detach()
        if value.ndim == 1:
            value = value.unsqueeze(0).unsqueeze(0)
        elif value.ndim == 2:
            value = value.unsqueeze(0)
        elif value.ndim > 3:
            value = value.reshape(-1, value.shape[-2], value.shape[-1])
        if int(value.shape[-1]) <= 0:
            raise RuntimeError(f"{label} AUDIO 输入为空。")
        return audio, value.contiguous(), sample_rate

    @staticmethod
    def _pad_audio(audio: dict[str, Any], waveform: torch.Tensor, sample_rate: int, target_samples: int) -> dict[str, Any]:
        target_samples = max(1, int(target_samples))
        current_samples = int(waveform.shape[-1])
        if current_samples == target_samples:
            padded = waveform.contiguous()
        elif current_samples > target_samples:
            padded = waveform[..., :target_samples].contiguous()
        else:
            silence = torch.zeros((*waveform.shape[:-1], target_samples - current_samples), device=waveform.device, dtype=waveform.dtype)
            padded = torch.cat([waveform.contiguous(), silence], dim=-1).contiguous()
        result = dict(audio)
        result["waveform"] = padded.contiguous()
        result["sample_rate"] = int(sample_rate)
        return result

    @staticmethod
    def _append_silence_to_samples(audio: dict[str, Any], waveform: torch.Tensor, sample_rate: int, target_samples: int) -> dict[str, Any]:
        blank_samples = max(1, int(target_samples) - int(waveform.shape[-1]))
        silence = torch.zeros((*waveform.shape[:-1], blank_samples), device=waveform.device, dtype=waveform.dtype)
        result = dict(audio)
        result["waveform"] = torch.cat([waveform.contiguous(), silence], dim=-1).contiguous()
        result["sample_rate"] = int(sample_rate)
        return result

    @staticmethod
    def _silent_audio_like(waveform: torch.Tensor, sample_rate: int, target_samples: int) -> dict[str, Any]:
        silent = torch.zeros((*waveform.shape[:-1], max(1, int(target_samples))), device=waveform.device, dtype=waveform.dtype)
        return {"waveform": silent.contiguous(), "sample_rate": int(sample_rate)}

    @staticmethod
    def _frame_count_from_samples(samples: int, sample_rate: int, fps: float) -> int:
        return max(1, int(math.ceil(float(max(1, samples)) / float(sample_rate) * max(0.01, float(fps)))))

    @staticmethod
    def _is_8n_plus_1(frame_count: int) -> bool:
        return int(frame_count) >= 1 and (int(frame_count) - 1) % 8 == 0

    def calculate(
        self,
        vocal_audio: dict[str, Any],
        fps: float = 24.0,
        background_audio: dict[str, Any] | None = None,
        source_video: Any = None,
    ):
        source_frames, source_audio, _source_fps = _extract_media_frames_audio(source_video, "源视频/画面")
        if source_audio is not None:
            vocal_source, vocal_waveform, sample_rate = self._normalize_audio(source_audio, "源音频")
        else:
            vocal_source, vocal_waveform, sample_rate = self._normalize_audio(vocal_audio, "人声")
        total_samples = int(vocal_waveform.shape[-1])
        frame_rate = max(0.01, float(fps))
        raw_frames = self._frame_count_from_samples(total_samples, sample_rate, frame_rate)
        if self._is_8n_plus_1(raw_frames):
            aligned_frames = raw_frames
            target_samples = total_samples
            aligned_vocal = vocal_source
        else:
            content_frames = max(8, int(math.ceil(float(raw_frames) / 8.0)) * 8)
            aligned_frames = content_frames + 1
            target_total_samples = max(total_samples + 1, int(math.floor(float(aligned_frames) / frame_rate * sample_rate)))
            aligned_vocal = self._pad_audio(vocal_source, vocal_waveform, sample_rate, target_total_samples)
            target_samples = int(aligned_vocal["waveform"].shape[-1])

        if background_audio is not None:
            background_source, background_waveform, background_rate = self._normalize_audio(background_audio, "背景声")
            background_target_samples = int(math.ceil(float(target_samples) / float(sample_rate) * background_rate))
            if int(background_waveform.shape[-1]) == background_target_samples:
                aligned_background = background_source
            else:
                aligned_background = self._pad_audio(background_source, background_waveform, background_rate, background_target_samples)
        else:
            aligned_background = self._silent_audio_like(vocal_waveform, sample_rate, target_samples)

        image_output = source_frames if source_frames is not None else _empty_image()
        return (aligned_vocal, aligned_background, int(aligned_frames), image_output)


class GJJ_AudioVocalBackgroundMixer:
    CATEGORY = "GJJ/🎵 音频"
    FUNCTION = "mix"
    DESCRIPTION = "合并人声和背景声，两路自动按最长长度补齐后混合输出。"
    SEARCH_ALIASES = ["audio mix", "vocal background mix", "人声背景合并", "混音"]
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("合并音频",)
    OUTPUT_TOOLTIPS = ("人声和背景声混合后的 AUDIO。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vocal_audio": ("AUDIO", {"display_name": "人声", "tooltip": "需要合并的人声 AUDIO。"}),
                "background_audio": ("AUDIO", {"display_name": "背景声", "tooltip": "需要合并回去的背景声 AUDIO。"}),
                "vocal_gain": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.01, "display_name": "人声音量", "tooltip": "人声混合倍率。"}),
                "background_gain": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.01, "display_name": "背景音量", "tooltip": "背景声混合倍率。"}),
                "normalize_peak": ("BOOLEAN", {"default": True, "display_name": "防爆音归一化", "tooltip": "开启后，如果混合结果峰值超过 1，会整体缩放到安全范围。"}),
            }
        }

    @staticmethod
    def _normalize_audio(audio: dict[str, Any], label: str) -> tuple[torch.Tensor, int]:
        waveform = audio.get("waveform") if isinstance(audio, dict) else None
        sample_rate = int(audio.get("sample_rate") or 0) if isinstance(audio, dict) else 0
        if not isinstance(waveform, torch.Tensor):
            raise RuntimeError(f"{label} AUDIO 输入缺少 waveform。")
        if sample_rate <= 0:
            raise RuntimeError(f"{label} AUDIO 输入缺少有效 sample_rate。")
        value = waveform.detach().float()
        if value.ndim == 1:
            value = value.unsqueeze(0).unsqueeze(0)
        elif value.ndim == 2:
            value = value.unsqueeze(0)
        elif value.ndim > 3:
            value = value.reshape(-1, value.shape[-2], value.shape[-1])
        if int(value.shape[-1]) <= 0:
            raise RuntimeError(f"{label} AUDIO 输入为空。")
        return value.contiguous(), sample_rate

    @staticmethod
    def _fit_channels(waveform: torch.Tensor, channels: int) -> torch.Tensor:
        current = int(waveform.shape[1])
        if current == channels:
            return waveform
        if current == 1:
            return waveform.repeat(1, channels, 1)
        if channels == 1:
            return waveform.mean(dim=1, keepdim=True)
        if current > channels:
            return waveform[:, :channels, :]
        repeat_count = int(math.ceil(channels / current))
        return waveform.repeat(1, repeat_count, 1)[:, :channels, :]

    @staticmethod
    def _pad_to(waveform: torch.Tensor, samples: int) -> torch.Tensor:
        samples = max(1, int(samples))
        current = int(waveform.shape[-1])
        if current >= samples:
            return waveform[..., :samples].contiguous()
        padding = torch.zeros((*waveform.shape[:-1], samples - current), device=waveform.device, dtype=waveform.dtype)
        return torch.cat([waveform, padding], dim=-1).contiguous()

    def mix(
        self,
        vocal_audio: dict[str, Any],
        background_audio: dict[str, Any],
        vocal_gain: float = 1.0,
        background_gain: float = 1.0,
        normalize_peak: bool = True,
    ):
        vocal, vocal_rate = self._normalize_audio(vocal_audio, "人声")
        background, background_rate = self._normalize_audio(background_audio, "背景声")
        if vocal_rate != background_rate:
            target_background_samples = int(round(float(background.shape[-1]) / float(background_rate) * vocal_rate))
            background = F.interpolate(background.float(), size=max(1, target_background_samples), mode="linear", align_corners=False)
            background_rate = vocal_rate
        channels = max(int(vocal.shape[1]), int(background.shape[1]))
        target_samples = max(int(vocal.shape[-1]), int(background.shape[-1]))
        vocal = self._pad_to(self._fit_channels(vocal, channels), target_samples)
        background = self._pad_to(self._fit_channels(background, channels), target_samples)
        mixed = vocal * float(vocal_gain) + background * float(background_gain)
        if bool(normalize_peak):
            peak = float(mixed.abs().max().item()) if mixed.numel() else 0.0
            if peak > 1.0:
                mixed = mixed / peak
        mixed = mixed.clamp(-1.0, 1.0).contiguous()
        return ({"waveform": mixed, "sample_rate": int(vocal_rate)},)


NODE_CLASS_MAPPINGS = {
    "GJJ_AudioCrop": GJJ_AudioCrop,
    "GJJ_AudioBeatAnalyzer": GJJ_AudioBeatAnalyzer,
    "GJJ_AudioFrameCount8NPlus1": GJJ_AudioFrameCount8NPlus1,
    "GJJ_AudioVocalBackgroundMixer": GJJ_AudioVocalBackgroundMixer,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_AudioCrop": "GJJ · ✂️ 音频裁剪",
    "GJJ_AudioBeatAnalyzer": "GJJ · 🥁 音频节拍分析",
    "GJJ_AudioFrameCount8NPlus1": "GJJ · 🎞️ 视频\音频帧数 8n+1",
    "GJJ_AudioVocalBackgroundMixer": "GJJ · 🎚️ 人声背景合并",
}
