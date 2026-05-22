from __future__ import annotations

import json
import math
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageDraw


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


class GJJ_AudioCrop:
    CATEGORY = "GJJ/音频"
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
    CATEGORY = "GJJ/音频"
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


NODE_CLASS_MAPPINGS = {
    "GJJ_AudioCrop": GJJ_AudioCrop,
    "GJJ_AudioBeatAnalyzer": GJJ_AudioBeatAnalyzer,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_AudioCrop": "GJJ · ✂️ 音频裁剪",
    "GJJ_AudioBeatAnalyzer": "GJJ · 🥁 音频节拍分析",
}
