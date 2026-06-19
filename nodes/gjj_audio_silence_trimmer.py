from __future__ import annotations

from typing import Any

import torch

try:
    from .common_utils.dependency_checker import build_node_help_payload
except Exception:
    from common_utils.dependency_checker import build_node_help_payload


NODE_NAME = "GJJ_AudioSilenceTrimmer"
NODE_DISPLAY_NAME = "GJJ · ✂️ 音频静音修剪"
QUEUE_MODE_AUTO = "自动"
QUEUE_MODE_INITIAL = "初始"
QUEUE_MODE_BLANK = "空行"
QUEUE_MODES = [QUEUE_MODE_AUTO, QUEUE_MODE_INITIAL, QUEUE_MODE_BLANK]
_GJJ_HELP = build_node_help_payload(
    description="从 SoundFlow_SilenceTrimmer 迁移来的 GJJ 零依赖版，只使用 torch 和 ComfyUI AUDIO 数据，不依赖 SoundFlow 原包。",
    dependencies=[
        {
            "name": "torch",
            "type": "内置运行依赖",
            "required": True,
            "description": "ComfyUI 自带，用于音频张量处理、能量检测、交叉淡化和队列切片。",
        },
    ],
    model_tree=[
        {
            "label": "无需模型",
            "path": "",
            "required": False,
            "description": "本节点不加载任何模型文件。",
        },
    ],
    usage=[
        "阈值越高，越容易把低音量区域判为静音。",
        "最短静音秒决定多长的连续静音才会被压缩。",
        "保留静音秒决定每段之间以及首尾最多留下多少静音。",
        "最长保留时长用于分段队列：优先在静音边界或段落边界截断，0 表示不限制。",
        "模式为“自动”且当前分段未外接时，会按分段顺序自动添加任务。",
    ],
    runtime=[
        "如果最长时间落在句子中间，会回退到上一个安全断句边界；单句本身超长时保留整句，不硬切。",
        "外接“当前分段”输入后，节点会交出自动队列控制权，由外部序号控制。",
        "“空行”模式会输出一个短静音占位段，适合批处理占位。",
    ],
    notice="零额外模型依赖；无需下载模型。",
)


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


def _audio_dict(waveform: torch.Tensor, sample_rate: int) -> dict[str, Any]:
    return {"waveform": waveform.contiguous().clamp(-1.0, 1.0), "sample_rate": int(sample_rate)}


def _silent_audio_like(waveform: torch.Tensor, sample_rate: int, seconds: float = 0.05) -> dict[str, Any]:
    samples = max(1, int(round(float(seconds) * max(1, sample_rate))))
    silent = torch.zeros((*waveform.shape[:-1], samples), device=waveform.device, dtype=waveform.dtype)
    return _audio_dict(silent, sample_rate)


def _segment_audio_queue_from_boundaries(
    waveform: torch.Tensor,
    safe_cut_points: list[int],
    max_duration: float,
    sample_rate: int,
) -> list[dict[str, Any]]:
    total_samples = int(waveform.shape[-1])
    if total_samples <= 0:
        return [_audio_dict(waveform, sample_rate)]
    max_samples = int(round(float(max_duration) * sample_rate))
    if max_samples <= 0:
        return [_audio_dict(waveform, sample_rate)]

    boundaries = sorted(
        {
            max(1, min(int(point), total_samples))
            for point in safe_cut_points
            if int(point) > 0
        }
    )
    if total_samples not in boundaries:
        boundaries.append(total_samples)
    if not boundaries:
        return [_audio_dict(waveform, sample_rate)]

    segments: list[dict[str, Any]] = []
    start = 0
    while start < total_samples:
        limit = min(total_samples, start + max_samples)
        candidates = [point for point in boundaries if start < point <= limit]
        if candidates:
            end = max(candidates)
        else:
            # 当前句子本身超过最长时间时，回退点不存在；保留整句，不从句中硬切。
            future = [point for point in boundaries if point > start]
            end = min(future) if future else total_samples
        end = max(start + 1, min(int(end), total_samples))
        segment = waveform[..., start:end]
        if segment.shape[-1] <= 0:
            break
        segments.append(_audio_dict(segment, sample_rate))
        start = end
    return segments or [_audio_dict(waveform, sample_rate)]


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
        future = [point for point in safe_cut_points if int(point) > max_samples]
        if future:
            cut_samples = min(future)
        else:
            cut_samples = max_samples
    cut_samples = max(1, min(int(cut_samples), int(waveform.shape[-1])))
    return waveform[..., :cut_samples]


def _select_slide_index(total: int, fallback: int = 1, slide_start_index=None) -> int:
    total = max(0, int(total))
    if total <= 0:
        return 0
    current_value = max(1, int(fallback))
    if slide_start_index is not None:
        try:
            x = int(slide_start_index)
            current_value = x % total
            current_value = total if current_value == 0 else current_value
        except Exception:
            pass
    return ((current_value - 1) % total) + 1


def _prompt_input_is_linked(prompt: Any, unique_id: Any, names: tuple[str, ...]) -> bool:
    if unique_id is None or not isinstance(prompt, dict):
        return False
    node_data = prompt.get(str(unique_id)) or prompt.get(unique_id)
    if not isinstance(node_data, dict):
        return False
    inputs = node_data.get("inputs")
    if not isinstance(inputs, dict):
        return False
    for name in names:
        value = inputs.get(name)
        if isinstance(value, (list, tuple)) and len(value) >= 2:
            return True
    return False


def _resolve_queue_outputs(
    segment_queue: list[dict[str, Any]],
    waveform: torch.Tensor,
    sample_rate: int,
    slide_start_index=None,
    queue_mode: str = QUEUE_MODE_AUTO,
    current_segment: int = 1,
) -> tuple[dict[str, Any], int]:
    segment_count = len(segment_queue)
    mode = str(queue_mode or QUEUE_MODE_AUTO).strip()
    external_slide = slide_start_index is not None

    if external_slide:
        current_index = _select_slide_index(segment_count, fallback=1, slide_start_index=slide_start_index)
        current_audio = segment_queue[current_index - 1] if current_index > 0 else _silent_audio_like(waveform, sample_rate)
        return current_audio, current_index

    if mode == QUEUE_MODE_BLANK:
        current_audio = _silent_audio_like(waveform, sample_rate)
        return current_audio, 0

    current_index = _select_slide_index(segment_count, fallback=current_segment)
    current_audio = segment_queue[0] if segment_count > 0 else _silent_audio_like(waveform, sample_rate)
    if current_index > 0 and segment_count > 0:
        current_audio = segment_queue[current_index - 1]
    return current_audio, current_index


def _return_payload(
    segment_count: int,
    current_audio: dict[str, Any],
    current_index: int,
    queue_mode: str,
):
    return {
        "ui": {
            "gjj_audio_silence_trimmer": [
                {
                    "segment_count": int(segment_count),
                    "segment_index": int(current_index),
                    "queue_mode": str(queue_mode or QUEUE_MODE_AUTO),
                }
            ],
            "segment_count": (int(segment_count),),
            "segment_index": (int(current_index),),
            "queue_mode": (str(queue_mode or QUEUE_MODE_AUTO),),
        },
        "result": (
            int(segment_count),
            current_audio,
            int(current_index),
        ),
    }


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
    RETURN_TYPES = ("INT", "AUDIO", "INT")
    RETURN_NAMES = ("分段总数", "当前分段音频", "当前分段序号")
    OUTPUT_TOOLTIPS = (
        "分段队列中的音频片段总数。",
        "按当前分段序号选中的当前 AUDIO 分段。",
        "当前实际输出的 1 基分段序号；可接到其它队列节点保持同步。",
    )
    OUTPUT_IS_LIST = (False, False, False)
    GJJ_HELP = {"title": NODE_DISPLAY_NAME, **_GJJ_HELP}

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
                        "default": 0.2,
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
                        "default": 0.2,
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
                        "default": 6.0,
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
                "queue_mode": (
                    QUEUE_MODES,
                    {
                        "default": QUEUE_MODE_AUTO,
                        "display_name": "队列模式",
                        "tooltip": "自动：未外接滑动序号时输出完整分段队列；初始：只输出第一段；空行：输出一个静音占位段。外接滑动起始序号时由外部接管。",
                    },
                ),
                "current_segment": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 100000,
                        "step": 1,
                        "display_name": "当前分段",
                        "forceInput": False,
                        "tooltip": "面板里的滑动起始序号。可手动设置，也可连接本行小圆点外接；外接时由外部接管。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    def trim_silence(
        self,
        audio: dict[str, Any],
        threshold_db: float = -30.0,
        min_silence_duration: float = 0.2,
        keep_silence: float = 0.2,
        max_duration: float = 6.0,
        fade_duration: float = 0.01,
        queue_mode: str = QUEUE_MODE_AUTO,
        current_segment: int = 1,
        prompt=None,
        unique_id=None,
    ):
        waveform, sample_rate = _normalize_audio(audio)
        total_samples = int(waveform.shape[-1])
        min_silence_samples = max(1, int(round(float(min_silence_duration) * sample_rate)))
        keep_samples = max(0, int(round(float(keep_silence) * sample_rate)))
        max_duration_value = float(max_duration)
        fade_samples = max(0, int(round(float(fade_duration) * sample_rate)))

        panel_index_linked = _prompt_input_is_linked(prompt, unique_id, ("current_segment",))
        effective_slide_index = current_segment if panel_index_linked else None

        regions = _find_non_silent_regions(waveform, threshold_db, min_silence_samples, sample_rate)
        if not regions:
            safe_cut_points = [int(waveform.shape[-1])]
            limited = _limit_to_safe_boundary(waveform, safe_cut_points, max_duration_value, sample_rate)
            limited = limited.contiguous().clamp(-1.0, 1.0)
            segment_queue = _segment_audio_queue_from_boundaries(waveform, safe_cut_points, max_duration_value, sample_rate)
            current_audio, current_index = _resolve_queue_outputs(
                segment_queue,
                waveform,
                sample_rate,
                slide_start_index=effective_slide_index,
                queue_mode=queue_mode,
                current_segment=current_segment,
            )
            return _return_payload(
                len(segment_queue),
                current_audio,
                current_index,
                queue_mode,
            )

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
        full_result = result.contiguous().clamp(-1.0, 1.0)
        segment_queue = _segment_audio_queue_from_boundaries(full_result, safe_cut_points, max_duration_value, sample_rate)
        result = _limit_to_safe_boundary(full_result, safe_cut_points, max_duration_value, sample_rate)
        result = result.contiguous().clamp(-1.0, 1.0)
        segment_count = len(segment_queue)
        current_audio, current_index = _resolve_queue_outputs(
            segment_queue,
            full_result,
            sample_rate,
            slide_start_index=effective_slide_index,
            queue_mode=queue_mode,
            current_segment=current_segment,
        )
        return _return_payload(
            int(segment_count),
            current_audio,
            int(current_index),
            queue_mode,
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AudioSilenceTrimmer}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
