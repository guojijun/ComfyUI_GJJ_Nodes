from __future__ import annotations

from typing import Any

import torch


NODE_NAME = "GJJ_AudioSilenceTrimmer"
NODE_DISPLAY_NAME = "GJJ · ✂️ 音频静音修剪"


def _normalize_audio(audio: dict[str, Any]) -> tuple[torch.Tensor, int]:
    if not isinstance(audio, dict):
        raise RuntimeError("音频输入无效：需要 ComfyUI AUDIO 字典。")
    waveform = audio.get("waveform")
    if not isinstance(waveform, torch.Tensor):
        raise RuntimeError("音频输入缺少 waveform。")
    sample_rate = int(audio.get("sample_rate") or 0)
    if sample_rate <= 0:
        raise RuntimeError("音频输入缺少有效 sample_rate。")

    value = waveform.detach().clone()
    if value.ndim == 1:
        value = value.unsqueeze(0).unsqueeze(0)
    elif value.ndim == 2:
        value = value.unsqueeze(0)
    elif value.ndim > 3:
        value = value.reshape(-1, value.shape[-2], value.shape[-1])
    if value.shape[-1] <= 0:
        raise RuntimeError("音频输入为空，无法修剪。")
    return torch.nan_to_num(value.float(), nan=0.0, posinf=0.0, neginf=0.0), sample_rate


def _amplitude_to_db(amplitude: torch.Tensor) -> torch.Tensor:
    return 20.0 * torch.log10(torch.clamp(amplitude, min=1e-10))


def _audio_duration(waveform: torch.Tensor, sample_rate: int) -> float:
    return float(waveform.shape[-1]) / float(max(1, sample_rate))


def _mono_for_detection(waveform: torch.Tensor) -> torch.Tensor:
    if waveform.ndim == 3:
        return waveform.mean(dim=(0, 1)).contiguous()
    return waveform.reshape(-1, waveform.shape[-1]).mean(dim=0).contiguous()


def _energy_profile(mono: torch.Tensor, sample_rate: int) -> tuple[torch.Tensor, int, int]:
    total = int(mono.numel())
    window_size = max(1, min(total, int(round(sample_rate * 0.02))))
    hop_length = max(1, int(round(sample_rate * 0.01)))
    starts = list(range(0, max(1, total - window_size + 1), hop_length))
    last_start = max(0, total - window_size)
    if starts[-1] != last_start:
        starts.append(last_start)

    energies = []
    for start in starts:
        chunk = mono[start:start + window_size]
        energies.append(torch.sqrt(torch.mean(chunk * chunk) + 1e-12))
    return torch.stack(energies), window_size, hop_length


def _merge_close_regions(regions: list[tuple[int, int]], min_gap_samples: int) -> list[tuple[int, int]]:
    if not regions:
        return []
    merged: list[tuple[int, int]] = []
    current_start, current_end = regions[0]
    for start, end in regions[1:]:
        if start - current_end <= min_gap_samples:
            current_end = max(current_end, end)
        else:
            merged.append((current_start, current_end))
            current_start, current_end = start, end
    merged.append((current_start, current_end))
    return merged


def _find_non_silent_regions(
    waveform: torch.Tensor,
    threshold_db: float,
    min_silence_samples: int,
    sample_rate: int,
) -> list[tuple[int, int]]:
    mono = _mono_for_detection(waveform)
    total = int(mono.numel())
    energy, window_size, hop_length = _energy_profile(mono, sample_rate)
    is_sound = (_amplitude_to_db(energy) > float(threshold_db)).tolist()

    regions: list[tuple[int, int]] = []
    region_start: int | None = None
    silence_start: int | None = None

    for index, active in enumerate(is_sound):
        sample_pos = min(total, index * hop_length)
        window_end = min(total, sample_pos + window_size)
        if active:
            if region_start is None:
                region_start = sample_pos
            silence_start = None
            continue

        if region_start is None:
            continue
        if silence_start is None:
            silence_start = sample_pos
        if sample_pos - silence_start >= min_silence_samples:
            end = max(region_start + 1, silence_start)
            regions.append((region_start, min(total, end)))
            region_start = None
            silence_start = None

        # Keep the variable alive for readability when the final window is short.
        _ = window_end

    if region_start is not None:
        regions.append((region_start, total))

    return _merge_close_regions(regions, max(1, int(min_silence_samples)))


def _apply_crossfade(segment1: torch.Tensor, segment2: torch.Tensor, fade_samples: int) -> torch.Tensor:
    fade_samples = int(max(0, fade_samples))
    if fade_samples <= 0:
        return torch.cat([segment1, segment2], dim=-1)
    fade_samples = min(fade_samples, int(segment1.shape[-1]), int(segment2.shape[-1]))
    if fade_samples <= 0:
        return torch.cat([segment1, segment2], dim=-1)

    fade_out = torch.linspace(1.0, 0.0, fade_samples, device=segment1.device, dtype=segment1.dtype).view(1, 1, -1)
    fade_in = torch.linspace(0.0, 1.0, fade_samples, device=segment2.device, dtype=segment2.dtype).view(1, 1, -1)
    mixed = segment1[..., -fade_samples:] * fade_out + segment2[..., :fade_samples] * fade_in
    return torch.cat([segment1[..., :-fade_samples], mixed, segment2[..., fade_samples:]], dim=-1)


def _append_audio(result: torch.Tensor | None, segment: torch.Tensor, fade_samples: int) -> torch.Tensor:
    if segment.shape[-1] <= 0:
        return result if result is not None else segment
    if result is None or result.shape[-1] <= 0:
        return segment
    return _apply_crossfade(result, segment, fade_samples)


def _limit_to_safe_boundary(
    waveform: torch.Tensor,
    safe_cut_points: list[int],
    max_duration: float,
    sample_rate: int,
) -> torch.Tensor:
    max_samples = int(round(float(max_duration) * sample_rate))
    if max_samples <= 0 or waveform.shape[-1] <= max_samples:
        return waveform

    candidates = [point for point in safe_cut_points if 0 < int(point) <= max_samples]
    if candidates:
        cut_samples = max(candidates)
    else:
        cut_samples = max_samples
    cut_samples = max(1, min(int(cut_samples), int(waveform.shape[-1])))
    return waveform[..., :cut_samples]


class GJJ_AudioSilenceTrimmer:
    CATEGORY = "GJJ/音频"
    FUNCTION = "trim_silence"
    DESCRIPTION = "零依赖音频静音修剪：按音量阈值压缩长静音，并可按静音边界限制输出最长总时长。"
    SEARCH_ALIASES = [
        "SoundFlow SilenceTrimmer",
        "Audio Silence Trimmer",
        "silence trim",
        "静音修剪",
        "音频去静音",
    ]
    RETURN_TYPES = ("AUDIO", "FLOAT")
    RETURN_NAMES = ("处理后音频", "处理后总时长")
    OUTPUT_TOOLTIPS = (
        "移除长静音，并按最长保留时长裁剪后的 AUDIO。",
        "处理后音频的总时长，单位为秒。",
    )
    GJJ_HELP = {
        "description": "从 SoundFlow_SilenceTrimmer 迁移来的 GJJ 零依赖版，只使用 torch 和 ComfyUI AUDIO 数据，不依赖 SoundFlow 原包。",
        "usage": [
            "阈值越高，越容易把低音量区域判为静音。",
            "最短静音秒决定多长的连续静音才会被压缩。",
            "保留静音秒决定每段之间以及首尾最多留下多少静音。",
            "最长保留时长用于总时长裁剪：优先在静音边界或段落边界截断，0 表示不限制。",
            "处理后总时长可接到计算器、日志或后续节奏控制节点。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"display_name": "音频", "tooltip": "需要修剪静音的 ComfyUI AUDIO。"}),
                "threshold_db": (
                    "FLOAT",
                    {
                        "default": -30.0,
                        "min": -120.0,
                        "max": 0.0,
                        "step": 1.0,
                        "display_name": "静音阈值dB",
                        "tooltip": "低于该音量的窗口视为静音。默认 -30，适合更积极地识别静音。",
                    },
                ),
                "min_silence_duration": (
                    "FLOAT",
                    {
                        "default": 0.1,
                        "min": 0.01,
                        "max": 30.0,
                        "step": 0.01,
                        "display_name": "最短静音秒",
                        "tooltip": "连续静音达到该时长后才会被压缩，避免切掉很短的停顿。",
                    },
                ),
                "keep_silence": (
                    "FLOAT",
                    {
                        "default": 0.1,
                        "min": 0.0,
                        "max": 60.0,
                        "step": 0.01,
                        "display_name": "保留静音秒",
                        "tooltip": "每段之间以及首尾最多保留这么长的静音。0 表示尽量去掉检测到的静音。",
                    },
                ),
                "max_duration": (
                    "FLOAT",
                    {
                        "default": 5.0,
                        "min": 0.0,
                        "max": 36000.0,
                        "step": 0.1,
                        "display_name": "最长保留时长",
                        "tooltip": "默认 5 秒。0 表示不限；大于 0 时，输出会优先在不超过该秒数的静音或段落边界处截断。前方接口支持连接 INT 或 FLOAT。",
                    },
                ),
                "fade_duration": (
                    "FLOAT",
                    {
                        "default": 0.01,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.001,
                        "display_name": "交叉淡化秒",
                        "tooltip": "拼接片段时的交叉淡化时长，能减少硬切产生的爆音。",
                    },
                ),
            },
        }

    def trim_silence(
        self,
        audio: dict[str, Any],
        threshold_db: float = -30.0,
        min_silence_duration: float = 0.1,
        keep_silence: float = 0.1,
        max_duration: float = 5.0,
        fade_duration: float = 0.01,
    ):
        waveform, sample_rate = _normalize_audio(audio)
        total_samples = int(waveform.shape[-1])
        min_silence_samples = max(1, int(round(float(min_silence_duration) * sample_rate)))
        keep_samples = max(0, int(round(float(keep_silence) * sample_rate)))
        max_duration_value = float(max_duration)
        fade_samples = max(0, int(round(float(fade_duration) * sample_rate)))

        regions = _find_non_silent_regions(waveform, threshold_db, min_silence_samples, sample_rate)
        if not regions:
            limited = _limit_to_safe_boundary(waveform, [int(waveform.shape[-1])], max_duration_value, sample_rate)
            limited = limited.contiguous().clamp(-1.0, 1.0)
            return ({"waveform": limited, "sample_rate": sample_rate}, _audio_duration(limited, sample_rate))

        result: torch.Tensor | None = None
        safe_cut_points: list[int] = []
        last_end = 0

        def remember_boundary() -> None:
            if result is not None and result.shape[-1] > 0:
                safe_cut_points.append(int(result.shape[-1]))

        for index, (start, end) in enumerate(regions):
            start = max(0, min(int(start), total_samples))
            end = max(start + 1, min(int(end), total_samples))
            if index == 0:
                kept_start = max(0, start - keep_samples)
                result = waveform[..., kept_start:end]
                remember_boundary()
            else:
                gap = max(0, start - last_end)
                keep_gap = min(gap, keep_samples)
                if keep_gap > 0:
                    result = _append_audio(result, waveform[..., start - keep_gap:start], fade_samples)
                    if fade_samples <= 0:
                        remember_boundary()
                result = _append_audio(result, waveform[..., start:end], fade_samples)
                remember_boundary()
            last_end = end

        tail_keep = min(max(0, total_samples - last_end), keep_samples)
        if tail_keep > 0:
            result = _append_audio(result, waveform[..., last_end:last_end + tail_keep], fade_samples)
            remember_boundary()

        if result is None or result.shape[-1] <= 0:
            result = waveform
            safe_cut_points = [int(result.shape[-1])]
        result = _limit_to_safe_boundary(result, safe_cut_points, max_duration_value, sample_rate)
        result = result.contiguous().clamp(-1.0, 1.0)
        return ({"waveform": result, "sample_rate": sample_rate}, _audio_duration(result, sample_rate))


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AudioSilenceTrimmer}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
