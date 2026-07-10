from __future__ import annotations

import json
from typing import Any

import torch

try:
    from .common_utils.dependency_checker import build_node_help_payload
except Exception:
    from common_utils.dependency_checker import build_node_help_payload

try:
    from .gjj_video_combine_runtime import register_runtime_variable_source
except Exception:
    register_runtime_variable_source = None


NODE_NAME = "GJJ_AudioSilenceTrimmer"
NODE_DISPLAY_NAME = "GJJ · ✂️ 音频静音修剪，队列输出"
QUEUE_MODE_AUTO = "自动"
QUEUE_MODE_INITIAL = "初始"
QUEUE_MODE_BLANK = "空行"
QUEUE_MODES = [QUEUE_MODE_AUTO, QUEUE_MODE_INITIAL, QUEUE_MODE_BLANK]
OUTPUT_KEYS = (
    "segment_audio",
    "segment_count",
    "segment_index",
    "background_audio",
    "current_audio_duration",
)
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
    notice="本节点直接处理后端传入的 AUDIO 张量；当前节点本身不直接加载具体模型文件。",
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


def _build_kept_intervals_from_regions(
    regions: list[tuple[int, int]],
    total_samples: int,
    keep_samples: int,
) -> list[tuple[int, int]]:
    total = max(0, int(total_samples))
    if total <= 0:
        return []
    ordered = sorted(
        (max(0, min(int(start), total)), max(0, min(int(end), total)))
        for start, end in regions
        if int(end) > int(start)
    )
    if not ordered:
        return []

    keep = max(0, int(keep_samples))
    intervals: list[tuple[int, int]] = []
    for index, (start, end) in enumerate(ordered):
        if index == 0:
            kept_start = max(0, start - keep)
        else:
            prev_end = ordered[index - 1][1]
            if start > prev_end:
                midpoint = prev_end + max(1, (start - prev_end) // 2)
                kept_start = max(midpoint, start - keep)
            else:
                kept_start = start

        if index + 1 < len(ordered):
            next_start = ordered[index + 1][0]
            if next_start > end:
                midpoint = end + max(1, (next_start - end) // 2)
                kept_end = min(midpoint, end + keep)
            else:
                kept_end = end
        else:
            kept_end = min(total, end + keep)

        kept_start = max(0, min(kept_start, total))
        kept_end = max(kept_start + 1, min(kept_end, total))
        intervals.append((kept_start, kept_end))
    return intervals


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


def _pad_audio_samples(waveform: torch.Tensor, target_samples: int) -> torch.Tensor:
    target_samples = max(1, int(target_samples))
    current_samples = int(waveform.shape[-1])
    if current_samples == target_samples:
        return waveform.contiguous()
    if current_samples > target_samples:
        return waveform[..., :target_samples].contiguous()
    blank = torch.zeros((*waveform.shape[:-1], target_samples - current_samples), device=waveform.device, dtype=waveform.dtype)
    return torch.cat([waveform.contiguous(), blank], dim=-1).contiguous()


def _frame_counts_for_segment(segment: dict[str, Any], fps: float) -> tuple[int, int]:
    waveform = segment.get("waveform") if isinstance(segment, dict) else None
    sample_rate = int(segment.get("sample_rate") or 0) if isinstance(segment, dict) else 0
    if not isinstance(waveform, torch.Tensor) or sample_rate <= 0:
        return 8, 9
    frame_rate = max(0.01, float(fps or 24.0))
    source_samples = max(1, int(waveform.shape[-1]))
    raw_frames = max(1, int(torch.ceil(torch.tensor(source_samples / float(sample_rate) * frame_rate)).item()))
    content_frames = max(8, ((raw_frames + 7) // 8) * 8)
    return content_frames, content_frames + 1


def _align_audio_segment_to_frame_counts(segment: dict[str, Any], content_frames: int, total_frames: int, fps: float) -> dict[str, Any]:
    waveform = segment.get("waveform") if isinstance(segment, dict) else None
    sample_rate = int(segment.get("sample_rate") or 0) if isinstance(segment, dict) else 0
    if not isinstance(waveform, torch.Tensor) or sample_rate <= 0:
        return segment
    frame_rate = max(0.01, float(fps or 24.0))
    total_samples = max(int(waveform.shape[-1]) + 1, int((float(total_frames) / frame_rate) * sample_rate))
    return _audio_dict(_pad_audio_samples(waveform, total_samples), sample_rate)


def _align_audio_segment_to_8n_plus_blank(segment: dict[str, Any], fps: float) -> dict[str, Any]:
    content_frames, total_frames = _frame_counts_for_segment(segment, fps)
    return _align_audio_segment_to_frame_counts(segment, content_frames, total_frames, fps)


def _align_audio_queue_to_8n_plus_blank(segment_queue: list[dict[str, Any]], fps: float) -> list[dict[str, Any]]:
    return [_align_audio_segment_to_8n_plus_blank(segment, fps) for segment in segment_queue]


def _align_audio_queue_like_reference(
    segment_queue: list[dict[str, Any]],
    reference_queue: list[dict[str, Any]],
    fps: float,
) -> list[dict[str, Any]]:
    aligned: list[dict[str, Any]] = []
    for index, segment in enumerate(segment_queue):
        reference = reference_queue[index] if index < len(reference_queue) else segment
        content_frames, total_frames = _frame_counts_for_segment(reference, fps)
        aligned.append(_align_audio_segment_to_frame_counts(segment, content_frames, total_frames, fps))
    return aligned


def _silent_audio_like(waveform: torch.Tensor, sample_rate: int, seconds: float = 0.05) -> dict[str, Any]:
    samples = max(1, int(round(float(seconds) * max(1, sample_rate))))
    silent = torch.zeros((*waveform.shape[:-1], samples), device=waveform.device, dtype=waveform.dtype)
    return _audio_dict(silent, sample_rate)


def _segment_audio_queue_from_boundaries(
    waveform: torch.Tensor,
    safe_cut_points: list[int],
    max_duration: float,
    sample_rate: int,
    min_segment_samples: int = 0,
) -> list[dict[str, Any]]:
    total_samples = int(waveform.shape[-1])
    if total_samples <= 0:
        return [_audio_dict(waveform, sample_rate)]
    max_samples = int(round(float(max_duration) * sample_rate))
    if max_samples <= 0:
        return [_audio_dict(waveform, sample_rate)]

    min_gap = max(1, int(min_segment_samples or 0))
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
    if min_gap > 1:
        filtered: list[int] = []
        last = 0
        for point in boundaries:
            point = int(point)
            if point >= total_samples:
                continue
            if point - last >= min_gap:
                filtered.append(point)
                last = point
        if total_samples - last < min_gap and filtered:
            filtered.pop()
        filtered.append(total_samples)
        boundaries = filtered

    segments: list[dict[str, Any]] = []
    start = 0
    while start < total_samples:
        limit = min(total_samples, start + max_samples)
        candidates = [point for point in boundaries if start < point <= limit]
        if candidates:
            end = max(candidates)
        else:
            # 软最长时长：不能硬切句中；往后找下一个静音段中间切点。
            future = [point for point in boundaries if point > limit]
            end = min(future) if future else total_samples
        end = max(start + 1, min(int(end), total_samples))
        segment = waveform[..., start:end]
        if segment.shape[-1] <= 0:
            break
        segments.append(_audio_dict(segment, sample_rate))
        start = end
    return segments or [_audio_dict(waveform, sample_rate)]


def _scale_cut_points(cut_points: list[int], source_rate: int, target_rate: int, target_total: int) -> list[int]:
    if source_rate <= 0 or target_rate <= 0:
        return []
    return [
        max(1, min(int(round(float(point) / float(source_rate) * float(target_rate))), int(target_total)))
        for point in cut_points
        if int(point) > 0
    ]


def _segment_background_like_vocal(
    background_waveform: torch.Tensor,
    background_rate: int,
    vocal_cut_points: list[int],
    vocal_rate: int,
    max_duration: float,
    min_segment_samples: int = 0,
) -> list[dict[str, Any]]:
    total_samples = int(background_waveform.shape[-1])
    cut_points = _scale_cut_points(vocal_cut_points, vocal_rate, background_rate, total_samples)
    background_min_segment = int(round(float(min_segment_samples) / float(max(1, vocal_rate)) * float(max(1, background_rate))))
    return _segment_audio_queue_from_boundaries(background_waveform, cut_points, max_duration, background_rate, background_min_segment)


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
        cut_samples = min(future) if future else int(waveform.shape[-1])
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
    current_background_audio: dict[str, Any] | None = None,
    output_order_json: str = '["segment_audio"]',
    unique_id=None,
):
    current_waveform = current_audio.get("waveform") if isinstance(current_audio, dict) else None
    current_sample_rate = int(current_audio.get("sample_rate") or 0) if isinstance(current_audio, dict) else 0
    current_audio_duration = (
        float(current_waveform.shape[-1]) / float(current_sample_rate)
        if isinstance(current_waveform, torch.Tensor) and current_sample_rate > 0
        else 0.0
    )
    values = {
        "segment_audio": current_audio,
        "segment_count": int(segment_count),
        "segment_index": int(current_index),
        "background_audio": current_background_audio if current_background_audio is not None else current_audio,
        "current_audio_duration": float(current_audio_duration),
    }
    try:
        requested = json.loads(str(output_order_json or "[]"))
    except (TypeError, ValueError, json.JSONDecodeError):
        requested = []
    order = [str(key) for key in requested if str(key) in values] if isinstance(requested, list) else []
    if not order:
        order = ["segment_audio"]
    if register_runtime_variable_source is not None:
        if "segment_count" in order:
            register_runtime_variable_source(unique_id, order.index("segment_count"), int(segment_count))
        if "segment_index" in order:
            register_runtime_variable_source(unique_id, order.index("segment_index"), int(current_index))
        if "current_audio_duration" in order:
            register_runtime_variable_source(unique_id, order.index("current_audio_duration"), float(current_audio_duration))
    result = [values[key] for key in dict.fromkeys(order)]
    for key in OUTPUT_KEYS:
        if len(result) >= len(OUTPUT_KEYS):
            break
        if key in order:
            continue
        result.append(values[key])
    return {
        "ui": {
            "gjj_audio_silence_trimmer": [
                {
                    "segment_count": int(segment_count),
                    "segment_index": int(current_index),
                    "queue_mode": str(queue_mode or QUEUE_MODE_AUTO),
                    "current_audio_duration": float(current_audio_duration),
                }
            ],
            "segment_count": (int(segment_count),),
            "segment_index": (int(current_index),),
            "queue_mode": (str(queue_mode or QUEUE_MODE_AUTO),),
            "current_audio_duration": (float(current_audio_duration),),
        },
        "result": tuple(result[:len(OUTPUT_KEYS)]),
    }


def _hidden_widget(options: dict[str, Any]) -> dict[str, Any]:
    result = dict(options)
    result.setdefault("hidden", True)
    result.setdefault("display", "hidden")
    result.setdefault("advanced", True)
    return result


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
    # 输出槽由前端 🔌 动态排序；后端使用通配类型，具体槽类型由前端 OUTPUT_DEFS 约束。
    RETURN_TYPES = ("*", "*", "*", "*", "*")
    RETURN_NAMES = ("分段音频", "分段总数", "当前分段序号", "分段背景声", "当前音频时长")
    OUTPUT_TOOLTIPS = (
        "按当前分段序号选中的当前 AUDIO 分段。",
        "分段队列中的音频片段总数。",
        "当前实际输出的 1 基分段序号；可接到其它队列节点保持同步。",
        "按同一分段边界、同一 8n+1 时长处理后的背景声；未接背景声时输出等长静音。",
        "当前实际输出音频的时长，单位秒。",
    )
    OUTPUT_IS_LIST = (False, False, False, False, False)
    GJJ_HELP = {"title": NODE_DISPLAY_NAME, **_GJJ_HELP}
    GJJ_UI = {
        "toolbar": ["🧹", "░", "▶", "🔌", "⚙️"],
        "hidden_parameters": [
            "threshold_db", "min_silence_duration", "keep_silence", "max_duration",
            "fade_duration", "queue_mode", "current_segment", "fps", "output_order_json",
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
                        "default": -40.0,
                        "hidden": True,
                        "display": "hidden",
                        "min": -120.0,
                        "max": 0.0,
                        "step": 1.0,
                        "display_name": "静音阈值dB",
                        "tooltip": "低于该音量的窗口视为静音。默认 -40，适合保留更多尾音和弱气声。",
                    },
                ),
                "min_silence_duration": (
                    "FLOAT",
                    {
                        "default": 0.1,
                        "hidden": True,
                        "display": "hidden",
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
                        "default": 0.4,
                        "hidden": True,
                        "display": "hidden",
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
                        "default": 7.0,
                        "hidden": True,
                        "display": "hidden",
                        "min": 0.0,
                        "max": 36000.0,
                        "step": 0.1,
                        "display_name": "最长保留时长",
                        "tooltip": "默认 7 秒。0 表示不限；大于 0 时，输出会优先在静音段中点附近截断，不硬切尾音。前方接口支持连接 INT 或 FLOAT。",
                    },
                ),
                "fade_duration": (
                    "FLOAT",
                    {
                        "default": 0.001,
                        "hidden": True,
                        "display": "hidden",
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
                        "hidden": True,
                        "display": "hidden",
                        "display_name": "队列模式",
                        "tooltip": "自动：未外接滑动序号时输出完整分段队列；初始：只输出第一段；空行：输出一个静音占位段。外接滑动起始序号时由外部接管。",
                    },
                ),
                "current_segment": (
                    "INT",
                    {
                        "default": 1,
                        "hidden": True,
                        "display": "hidden",
                        "min": 1,
                        "max": 100000,
                        "step": 1,
                        "display_name": "当前分段",
                        "forceInput": False,
                        "tooltip": "面板里的滑动起始序号。可手动设置，也可连接本行小圆点外接；外接时由外部接管。",
                    },
                ),
                "fps": (
                    "FLOAT",
                    {
                        "default": 24.0,
                        "hidden": True,
                        "display": "hidden",
                        "min": 0.01,
                        "max": 240.0,
                        "step": 0.01,
                        "display_name": "帧率",
                        "tooltip": "每段音频只在末尾补静音到 8n+1，不拉伸人声主体，避免改变音色。",
                    },
                ),
                "output_order_json": (
                    "STRING",
                    _hidden_widget({
                        "default": '["segment_audio"]',
                        "display_name": "输出接口顺序",
                        "tooltip": "由顶部 🔌 按钮自动维护。",
                    }),
                ),
            },
            "optional": {
                "background_audio": (
                    "AUDIO",
                    {
                        "display_name": "背景声",
                        "tooltip": "可选背景声。会跟随人声使用相同切点，并同样对齐到 8n+1，方便对口型后混回。",
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
        threshold_db: float = -40.0,
        min_silence_duration: float = 0.1,
        keep_silence: float = 0.4,
        max_duration: float = 7.0,
        fade_duration: float = 0.001,
        queue_mode: str = QUEUE_MODE_AUTO,
        current_segment: int = 1,
        fps: float = 24.0,
        output_order_json: str = '["segment_audio"]',
        background_audio: dict[str, Any] | None = None,
        prompt=None,
        unique_id=None,
    ):
        waveform, sample_rate = _normalize_audio(audio)
        if background_audio is not None:
            background_waveform, background_rate = _normalize_audio(background_audio)
        else:
            background_waveform = torch.zeros_like(waveform)
            background_rate = sample_rate
        total_samples = int(waveform.shape[-1])
        min_silence_samples = max(1, int(round(float(min_silence_duration) * sample_rate)))
        keep_samples = max(0, int(round(float(keep_silence) * sample_rate)))
        min_segment_samples = max(int(round(2.0 * sample_rate)), int(round(float(min_silence_duration) * sample_rate * 0.5)))
        max_duration_value = float(max_duration)
        fade_samples = max(0, int(round(float(fade_duration) * sample_rate)))
        background_fade_samples = max(0, int(round(float(fade_duration) * background_rate)))

        def background_slice(start_sample: int, end_sample: int) -> torch.Tensor:
            bg_total = int(background_waveform.shape[-1])
            start_bg = max(0, min(int(round(float(start_sample) / float(sample_rate) * float(background_rate))), bg_total))
            end_bg = max(start_bg + 1, min(int(round(float(end_sample) / float(sample_rate) * float(background_rate))), bg_total))
            return background_waveform[..., start_bg:end_bg]

        def current_background_from_queue(background_queue: list[dict[str, Any]], current_audio: dict[str, Any], current_index: int) -> dict[str, Any]:
            if current_index > 0 and current_index <= len(background_queue):
                return background_queue[current_index - 1]
            current_waveform = current_audio.get("waveform") if isinstance(current_audio, dict) else waveform
            current_rate = int(current_audio.get("sample_rate") or sample_rate) if isinstance(current_audio, dict) else sample_rate
            if isinstance(current_waveform, torch.Tensor):
                return _silent_audio_like(current_waveform, current_rate)
            return _silent_audio_like(waveform, sample_rate)

        panel_index_linked = _prompt_input_is_linked(prompt, unique_id, ("current_segment",))
        effective_slide_index = current_segment if panel_index_linked else None

        raw_regions = _find_non_silent_regions(waveform, threshold_db, min_silence_samples, sample_rate)
        kept_intervals = _build_kept_intervals_from_regions(raw_regions, total_samples, keep_samples)
        if not kept_intervals:
            safe_cut_points = [int(waveform.shape[-1])]
            limited = _limit_to_safe_boundary(waveform, safe_cut_points, max_duration_value, sample_rate)
            limited = limited.contiguous().clamp(-1.0, 1.0)
            raw_segment_queue = _segment_audio_queue_from_boundaries(waveform, safe_cut_points, max_duration_value, sample_rate, min_segment_samples)
            raw_background_queue = _segment_background_like_vocal(background_waveform, background_rate, safe_cut_points, sample_rate, max_duration_value, min_segment_samples)
            segment_queue = _align_audio_queue_to_8n_plus_blank(raw_segment_queue, fps)
            background_queue = _align_audio_queue_like_reference(raw_background_queue, raw_segment_queue, fps)
            current_audio, current_index = _resolve_queue_outputs(
                segment_queue,
                waveform,
                sample_rate,
                slide_start_index=effective_slide_index,
                queue_mode=queue_mode,
                current_segment=current_segment,
            )
            current_background = current_background_from_queue(background_queue, current_audio, current_index)
            return _return_payload(
                len(segment_queue),
                current_audio,
                current_index,
                queue_mode,
                current_background,
                output_order_json,
                unique_id,
            )

        result: torch.Tensor | None = None
        background_result: torch.Tensor | None = None
        safe_cut_points: list[int] = []

        def remember_boundary() -> None:
            if result is not None and result.shape[-1] > 0:
                safe_cut_points.append(int(result.shape[-1]))

        for index, (start, end) in enumerate(kept_intervals):
            start = max(0, min(int(start), total_samples))
            end = max(start + 1, min(int(end), total_samples))
            if index == 0:
                result = waveform[..., start:end]
                background_result = background_slice(start, end)
                remember_boundary()
            else:
                result = _append_audio(result, waveform[..., start:end], fade_samples)
                background_result = _append_audio(background_result, background_slice(start, end), background_fade_samples)
                remember_boundary()

        if result is None or result.shape[-1] <= 0:
            result = waveform
            background_result = background_waveform
            safe_cut_points = [int(result.shape[-1])]
        full_result = result.contiguous().clamp(-1.0, 1.0)
        full_background_result = (
            background_result.contiguous().clamp(-1.0, 1.0)
            if background_result is not None and background_result.shape[-1] > 0
            else torch.zeros_like(full_result)
        )
        raw_segment_queue = _segment_audio_queue_from_boundaries(full_result, safe_cut_points, max_duration_value, sample_rate, min_segment_samples)
        raw_background_queue = _segment_background_like_vocal(full_background_result, background_rate, safe_cut_points, sample_rate, max_duration_value, min_segment_samples)
        segment_queue = _align_audio_queue_to_8n_plus_blank(raw_segment_queue, fps)
        background_queue = _align_audio_queue_like_reference(raw_background_queue, raw_segment_queue, fps)
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
        current_background = current_background_from_queue(background_queue, current_audio, current_index)
        return _return_payload(
            int(segment_count),
            current_audio,
            int(current_index),
            queue_mode,
            current_background,
            output_order_json,
            unique_id,
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AudioSilenceTrimmer}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
