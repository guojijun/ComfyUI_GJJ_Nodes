from __future__ import annotations

from collections import OrderedDict
import hashlib
import json
import math
import re
from typing import Any

import torch

from .gjj_audio_separator import GJJ_AudioSeparator, _scan_melband_models
from .gjj_gemma_text_generate import (
    GJJ_GemmaTextGenerate,
    _coerce_media_for_textgen,
    _text_encoder_options,
)
from .common_utils.mtv_ltx_prompt_settings import read_mtv_ltx_prompt_settings


NODE_NAME = "GJJ_MTVAudioToPrompt"
NODE_DISPLAY_NAME = "GJJ · 🎬 MTV音频转提示词"
MAX_VIDEO_SEGMENT_SECONDS = 15.0
FRAME_ALIGNMENT_MODELS = ("WAN", "LTX", "MinimaxH3")
DEFAULT_TEXT_MODEL = "Qwen3.5-4B-Uncensored-FP8_E4M3FN.safetensors"
REFERENCE_FEATURE_CACHE_VERSION = "identity_costume_v3"
LTX_SINGING_TAG = "人物嘴巴自然闭合，面部特写。"
STATIC_SINGLE_CENTER_TAG = ("画面中只有一位主角，面部特写。")
REFERENCE_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
_REFERENCE_FEATURE_CACHE: OrderedDict[tuple[Any, ...], str] = OrderedDict()
_REFERENCE_FEATURE_CACHE_MAX = 8
_PERSON_PROMPT_PATTERN = re.compile(
    r"人物|歌手|主唱|乐手|舞者|演员|男(?:人|性|生)|女(?:人|性|生)|"
    r"少年|少女|青年|中年|老人|面孔|脸部|全身|半身|人像"
)


def _fill_prompt_template(template: Any, **values: Any) -> str:
    result = str(template or "")
    for name, value in values.items():
        result = result.replace("{" + str(name) + "}", str(value or ""))
    return result.strip()


def _library_items(value: Any, marker: str) -> list[dict[str, str]]:
    try:
        source = json.loads(str(value or "[]"))
    except (TypeError, ValueError, json.JSONDecodeError):
        source = []
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in source if isinstance(source, list) else []:
        data = item if isinstance(item, dict) else {"name": item}
        name = re.sub(r"^\s*[♀♂]\ufe0f?\s*", "", str(data.get("name") or data.get("id") or "")).strip().lstrip("@🏕️")
        if not name or name.casefold() in seen:
            continue
        seen.add(name.casefold())
        result.append({"name": f"{marker}{name}", "notes": re.sub(r"\s+", " ", str(data.get("notes") or "")).strip()})
    return result


def _assigned_items(items: list[dict[str, str]], index: int, total: int) -> list[dict[str, str]]:
    if not items:
        return []
    assigned = items[index - 1::max(1, total)]
    return assigned or [items[(index - 1) % len(items)]]


def _storyboard_line(text: str, index: int, scene_names: list[str], actor_names: list[str]) -> str:
    clean = re.sub(r"^```[^\n]*|```$", "", str(text or "").strip(), flags=re.I).strip()
    clean = " ".join(line.strip() for line in clean.splitlines() if line.strip() and line.strip() != "---")
    parts = [part.strip() for part in clean.split("||")]
    scene_prefix = " ".join(scene_names).strip()
    actor_prefix = " ".join(actor_names).strip()
    if len(parts) >= 3:
        keyframe = parts[1]
        video = parts[2]
    else:
        keyframe = clean or "依据当前歌词设计的电影化关键帧"
        video = clean or "承接相邻分镜的连贯镜头运动与人物动作"
    if scene_prefix and not any(name in keyframe for name in scene_names):
        keyframe = f"{scene_prefix} {keyframe}"
    if not scene_names:
        keyframe = keyframe.replace("🏕️", "")
        video = video.replace("🏕️", "")
    if actor_prefix and not any(name in f"{keyframe} {video}" for name in actor_names):
        keyframe = f"{actor_prefix} {keyframe}"
    return f"{index}||{keyframe}||{video}"


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": str(text or "")},
        )
    except Exception:
        pass


def _send_prompt_preview(unique_id: Any, text: str, completed: int = 0, total: int = 0) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("gjj_mtv_prompt_preview", {
            "node": str(unique_id),
            "text": str(text or ""),
            "completed": int(completed),
            "total": int(total),
        })
    except Exception:
        pass


def _hidden(spec: dict[str, Any]) -> dict[str, Any]:
    result = dict(spec)
    result.setdefault("hidden", True)
    result.setdefault("display", "hidden")
    result.setdefault("advanced", True)
    return result


def _srt_seconds(value: str) -> float:
    parts = re.split(r"[:,.]", str(value).strip())
    if len(parts) != 4:
        raise ValueError(value)
    hours, minutes, seconds, millis = (int(item) for item in parts)
    return hours * 3600.0 + minutes * 60.0 + seconds + millis / 1000.0


def _parse_srt(text: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    pattern = re.compile(
        r"(?ms)^\s*(?:\d+\s*\r?\n)?"
        r"(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*"
        r"(\d{1,2}:\d{2}:\d{2}[,.]\d{3})[^\r\n]*\r?\n"
        r"(.*?)(?=\r?\n\s*\r?\n|\Z)"
    )
    for match in pattern.finditer(str(text or "").strip()):
        start = _srt_seconds(match.group(1))
        end = max(start, _srt_seconds(match.group(2)))
        lyric = " ".join(line.strip() for line in match.group(3).splitlines() if line.strip())
        entries.append({"start": start, "end": end, "text": lyric})
    return sorted(entries, key=lambda item: (item["start"], item["end"]))


def _segment_timeline(
    duration: float,
    entries: list[dict[str, Any]],
    min_seconds: float,
    max_seconds: float,
    vocals: dict[str, Any] | None = None,
    vocal_threshold_db: float = -48.0,
) -> list[dict[str, Any]]:
    duration = max(0.001, float(duration))
    minimum = min(MAX_VIDEO_SEGMENT_SECONDS, max(0.1, float(min_seconds)))
    maximum = min(MAX_VIDEO_SEGMENT_SECONDS, max(minimum, float(max_seconds)))
    # “最长分段”是下游视频模型的硬安全上限。优先使用歌词/气口边界；
    # 上限内没有安全边界时必须在上限处切分，避免产生几十秒 latent/attention mask。
    # 第一行开始用于分离片头空镜，最后一行结束用于分离片尾空镜；
    # 中间优先在相邻歌词之间的人声低能量气口切分。
    safe_boundaries: set[float] = set()
    for previous, following in zip(entries, entries[1:]):
        boundary = _breath_aware_boundary(vocals, previous, following, duration)
        if boundary is not None:
            safe_boundaries.add(float(boundary))
    # 不只依赖 SRT 气口：歌词时间可能覆盖整句，且常见的 300~900ms 停顿
    # 不会被下方“纯音乐过门”（要求约 1 秒）识别。把人声轨上的明确静音末端
    # 也作为安全候选，避免明明已有静音却在 max_seconds 处兜底硬切。
    safe_boundaries.update(
        _detect_vocal_silence_boundaries(vocals, vocal_threshold_db)
    )
    activity_intervals = _detect_vocal_activity_intervals(vocals, vocal_threshold_db)
    if entries:
        safe_boundaries.add(max(0.0, min(duration, float(entries[0]["start"]))))
        # 有真实人声检测结果时，以带尾音保护的人声结束点为准；
        # SRT 最后一行往往早于实际尾音，不能再作为切点。
        if not activity_intervals:
            safe_boundaries.add(max(0.0, min(duration, float(entries[-1]["end"]))))
    mandatory_activity_boundaries: set[float] = set()
    for activity_start, activity_end in activity_intervals:
        mandatory_activity_boundaries.add(max(0.0, min(duration, activity_start)))
        mandatory_activity_boundaries.add(max(0.0, min(duration, activity_end)))
    safe_boundaries.update(mandatory_activity_boundaries)
    safe_boundaries = sorted(
        point for point in safe_boundaries
        if 1e-6 < float(point) < duration - 1e-6
    )
    segments: list[dict[str, Any]] = []
    start = 0.0
    while start < duration - 1e-6:
        target_end = min(duration, start + maximum)
        next_activity_boundary = next(
            (
                point for point in sorted(mandatory_activity_boundaries)
                if point > start + 1e-6
            ),
            None,
        )
        search_end = min(
            target_end,
            next_activity_boundary if next_activity_boundary is not None else target_end,
        )
        candidates_before_target = [
            point for point in safe_boundaries
            if start + 1e-6 < point <= search_end
            and point not in mandatory_activity_boundaries
        ]
        if candidates_before_target:
            end = candidates_before_target[-1]
        elif next_activity_boundary is not None and next_activity_boundary <= target_end + 1e-6:
            # 真实人声开始/结束是强制边界，用于把中间纯音乐过门独立成无人空镜。
            end = next_activity_boundary
        else:
            # 单句或连续人声跨过上限时强制切分；后续淡入淡出负责抑制硬切爆音。
            end = target_end
        if end <= start + 1e-6:
            end = duration
        lyrics = [
            str(item["text"]).strip()
            for item in entries
            if item["end"] > start + 1e-6 and item["start"] < end - 1e-6 and str(item["text"]).strip()
        ]
        segments.append({"start": start, "end": end, "lyrics": "\n".join(lyrics)})
        start = end
    # “最短分段”必须覆盖整条时间线，而不只是无歌词的短尾段。
    # 强制人声边界可能产生很短的片头、过门或片尾；这些短段交给 LTX
    # 会形成不足 3 秒的视频段，并让固定长度的参考 guide 超出 latent。
    # 开头并入后一段，结尾并入前一段；中间短段优先并到不会超过
    # 硬上限内的一侧；若两侧合并都会越界，则保留该短段，绝不为满足最短值破坏上限。
    while len(segments) > 1:
        short_index = next(
            (
                index for index, segment in enumerate(segments)
                if float(segment["end"]) - float(segment["start"]) < minimum - 1e-6
                and (
                    (index > 0 and float(segment["end"]) - float(segments[index - 1]["start"]) <= maximum + 1e-6)
                    or (index + 1 < len(segments) and float(segments[index + 1]["end"]) - float(segment["start"]) <= maximum + 1e-6)
                )
            ),
            None,
        )
        if short_index is None:
            break
        if short_index == 0:
            merge_into_previous = False
        elif short_index == len(segments) - 1:
            merge_into_previous = True
        else:
            short = segments[short_index]
            previous = segments[short_index - 1]
            following = segments[short_index + 1]
            previous_duration = float(short["end"]) - float(previous["start"])
            following_duration = float(following["end"]) - float(short["start"])
            previous_overflow = max(0.0, previous_duration - maximum)
            following_overflow = max(0.0, following_duration - maximum)
            merge_into_previous = (
                (previous_overflow, previous_duration)
                <= (following_overflow, following_duration)
            )

        short = segments.pop(short_index)
        if merge_into_previous:
            target = segments[short_index - 1]
            target["end"] = short["end"]
            lyric_parts = [target.get("lyrics"), short.get("lyrics")]
        else:
            target = segments[short_index]
            target["start"] = short["start"]
            lyric_parts = [short.get("lyrics"), target.get("lyrics")]
        target["lyrics"] = "\n".join(
            str(part).strip() for part in lyric_parts if str(part or "").strip()
        )
    return segments


def _aligned_frame_count_down(*, seconds: float, fps: float, alignment_model: str, minimum_seconds: float = 0.0) -> int:
    """返回不超过给定时长的最大合法帧数；只向下对齐，绝不补长。"""
    available = max(0, int(math.floor(max(0.0, float(seconds)) * max(0.01, float(fps)) + 1e-9)))
    mode = str(alignment_model or "LTX").strip().casefold()
    if mode == "wan":
        modulus, remainder, minimum = 4, 1, 5
    elif mode in {"minimax h3", "minimaxh3", "minimax"}:
        modulus, remainder, minimum = 17, 5, 5
    else:
        modulus, remainder, minimum = 8, 1, 9
    aligned = available - ((available - remainder) % modulus)
    requested_minimum = max(minimum, int(math.ceil(max(0.0, float(minimum_seconds)) * max(0.01, float(fps)) - 1e-9)))
    return aligned if aligned >= requested_minimum else 0


def _align_segments_to_video_model(
    *,
    segments: list[dict[str, Any]],
    entries: list[dict[str, Any]],
    duration: float,
    min_seconds: float,
    max_seconds: float,
    fps: float,
    alignment_model: str,
) -> list[dict[str, Any]]:
    """在原断点范围内向短侧吸附，生成无需后补帧的连续音频段。"""
    if not segments:
        return []
    maximum = min(MAX_VIDEO_SEGMENT_SECONDS, max(0.1, float(max_seconds)))
    total = max(0.0, float(duration))
    cursor = 0.0
    aligned_segments: list[dict[str, Any]] = []
    raw_ends = [float(item["end"]) for item in segments]
    if not raw_ends or raw_ends[-1] < total - 1e-6:
        raw_ends.append(total)

    for raw_index, raw_end in enumerate(raw_ends):
        target_end = min(total, max(cursor, raw_end))
        is_final_target = raw_index == len(raw_ends) - 1
        while target_end - cursor > 1e-6:
            available = min(maximum, target_end - cursor)
            frame_count = _aligned_frame_count_down(
                seconds=available,
                fps=fps,
                alignment_model=alignment_model,
                minimum_seconds=0.0 if is_final_target else min_seconds,
            )
            if frame_count <= 0:
                break
            end = min(target_end, cursor + frame_count / max(0.01, float(fps)))
            lyrics = [
                str(item["text"]).strip()
                for item in entries
                if item["end"] > cursor + 1e-6 and item["start"] < end - 1e-6 and str(item["text"]).strip()
            ]
            aligned_segments.append({"start": cursor, "end": end, "lyrics": "\n".join(lyrics)})
            cursor = end
            if available < maximum - 1e-6:
                break
        if cursor >= total - 1e-6:
            break
    return aligned_segments


def _detect_vocal_silence_boundaries(
    vocals: dict[str, Any] | None,
    threshold_db: float,
) -> list[float]:
    """返回明确静音区间靠近末端的切点，给后续向下帧对齐保留余量。"""
    if not isinstance(vocals, dict):
        return []
    waveform = vocals.get("waveform")
    sample_rate = int(vocals.get("sample_rate") or 0)
    if not isinstance(waveform, torch.Tensor) or sample_rate <= 0 or waveform.numel() <= 0:
        return []
    try:
        mono = waveform.detach().float().cpu()
        while mono.ndim > 1:
            mono = mono.mean(dim=0)
        window = max(32, int(round(sample_rate * 0.04)))
        hop = max(16, int(round(sample_rate * 0.02)))
        if mono.numel() < window:
            return []
        rms = torch.nn.functional.avg_pool1d(
            mono.square().view(1, 1, -1),
            kernel_size=window,
            stride=hop,
        ).sqrt().flatten()
        if rms.numel() <= 0:
            return []
        absolute_threshold = 10.0 ** (float(threshold_db) / 20.0)
        peak = float(torch.max(rms).item())
        silence_threshold = max(absolute_threshold, peak * 0.03)
        silent = rms < silence_threshold
        # 至少约 360ms，既过滤字间微停顿，也足以容纳 LTX/WAN 向下帧吸附。
        sustained = max(2, int(math.ceil(0.36 / (hop / float(sample_rate)))))
        boundaries: list[float] = []
        run_start: int | None = None
        for index, is_silent in enumerate(silent.tolist() + [False]):
            if is_silent and run_start is None:
                run_start = index
            elif not is_silent and run_start is not None:
                if index - run_start >= sustained:
                    # 取静音末端前 60ms；后续即使向较短方向对齐，仍大概率落在静音内。
                    point = (index * hop + window) / float(sample_rate) - 0.06
                    boundaries.append(max(0.0, min(mono.numel() / float(sample_rate), point)))
                run_start = None
        return boundaries
    except Exception:
        return []


def _detect_vocal_activity_intervals(
    vocals: dict[str, Any] | None,
    threshold_db: float,
) -> list[tuple[float, float]]:
    if not isinstance(vocals, dict):
        return []
    waveform = vocals.get("waveform")
    sample_rate = int(vocals.get("sample_rate") or 0)
    if not isinstance(waveform, torch.Tensor) or sample_rate <= 0 or waveform.numel() <= 0:
        return []
    try:
        mono = waveform.detach().float().cpu()
        while mono.ndim > 1:
            mono = mono.mean(dim=0)
        window = max(32, int(round(sample_rate * 0.05)))
        hop = max(16, int(round(sample_rate * 0.02)))
        if mono.numel() < window:
            return []
        rms = torch.nn.functional.avg_pool1d(
            mono.square().view(1, 1, -1),
            kernel_size=window,
            stride=hop,
        ).sqrt().flatten()
        if rms.numel() <= 0:
            return []
        absolute_threshold = 10.0 ** (float(threshold_db) / 20.0)
        peak = float(torch.max(rms).item())
        # 同时使用绝对阈值和相对峰值阈值，避免分离轨底噪被误判成人声。
        activity_threshold = max(absolute_threshold, peak * 0.03)
        active = rms >= activity_threshold
        # 要求至少连续约 120ms，过滤前奏中的瞬态残留和分离噪声。
        sustained = max(2, int(round(0.12 / (hop / float(sample_rate)))))
        indices = torch.nonzero(active, as_tuple=False).flatten().tolist()
        runs: list[tuple[int, int]] = []
        if indices:
            run_start = run_end = int(indices[0])
            for index in indices[1:]:
                index = int(index)
                if index == run_end + 1:
                    run_end = index
                else:
                    if run_end - run_start + 1 >= sustained:
                        runs.append((run_start, run_end))
                    run_start = run_end = index
            if run_end - run_start + 1 >= sustained:
                runs.append((run_start, run_end))
        if not runs:
            return []
        intervals = [
            (
                max(0.0, run_start * hop / float(sample_rate)),
                min(
                    mono.numel() / float(sample_rate),
                    (run_end * hop + window) / float(sample_rate),
                ),
            )
            for run_start, run_end in runs
        ]
        # 歌词内换气和短停顿不拆段；只有约 1 秒以上的无持续人声区间才视为纯音乐过门。
        merged: list[tuple[float, float]] = []
        for interval_start, interval_end in intervals:
            if merged and interval_start - merged[-1][1] < 1.0:
                merged[-1] = (merged[-1][0], max(merged[-1][1], interval_end))
            else:
                merged.append((interval_start, interval_end))
        # 为开口保留少量预卷，为尾字、气声和混响保留释放时间。
        padded: list[tuple[float, float]] = []
        duration_seconds = mono.numel() / float(sample_rate)
        for interval_start, interval_end in merged:
            padded_start = max(0.0, interval_start - 0.08)
            padded_end = min(duration_seconds, interval_end + 0.85)
            if padded and padded_start <= padded[-1][1]:
                padded[-1] = (padded[-1][0], max(padded[-1][1], padded_end))
            else:
                padded.append((padded_start, padded_end))
        return padded
    except Exception:
        return []


def _breath_aware_boundary(
    vocals: dict[str, Any] | None,
    previous: dict[str, Any],
    following: dict[str, Any],
    duration: float,
) -> float | None:
    next_start = min(float(duration), max(0.0, float(following["start"])))
    previous_end = min(float(duration), max(0.0, float(previous["end"])))
    # SRT 时间重叠表示上一句尚未结束，禁止在下一句开头切断上一句。
    if next_start < previous_end - 0.02:
        return None
    if not isinstance(vocals, dict):
        return next_start
    waveform = vocals.get("waveform")
    sample_rate = int(vocals.get("sample_rate") or 0)
    if not isinstance(waveform, torch.Tensor) or sample_rate <= 0 or waveform.numel() <= 0:
        return next_start

    # 最多检查下一句前 0.9 秒，并从上一句标注结尾稍后开始；
    # 末尾留 60ms，防止把下一句的起音切到前一段。
    search_start = max(float(previous["end"]) + 0.06, next_start - 0.9)
    search_end = next_start - 0.06
    if search_end - search_start < 0.12:
        return next_start
    first = max(0, min(int(round(search_start * sample_rate)), int(waveform.shape[-1])))
    last = max(first, min(int(round(search_end * sample_rate)), int(waveform.shape[-1])))
    window = max(16, int(round(sample_rate * 0.04)))
    if last - first < window * 3:
        return next_start

    try:
        mono = waveform[..., first:last].detach().float().cpu()
        while mono.ndim > 1:
            mono = mono.mean(dim=0)
        energy = mono.square().view(1, 1, -1)
        rms = torch.nn.functional.avg_pool1d(
            energy,
            kernel_size=window,
            stride=max(1, window // 4),
        ).sqrt().flatten()
        if rms.numel() <= 0:
            return next_start
        minimum_value, minimum_index = torch.min(rms, dim=0)
        median_value = torch.median(rms)
        # 只有谷底至少比局部中位能量低约 6dB，才视为可靠气口；
        # 否则继续使用下一句开头，不做猜测性提前切分。
        if float(median_value) > 1e-7 and float(minimum_value) > float(median_value) * 0.5:
            return next_start
        stride = max(1, window // 4)
        center_sample = first + int(minimum_index) * stride + window // 2
        return min(next_start, max(0.0, float(center_sample) / float(sample_rate)))
    except Exception:
        return next_start


def _slice_audio(audio: dict[str, Any], start: float, end: float) -> dict[str, Any]:
    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    first = max(0, min(int(round(start * sample_rate)), waveform.shape[-1]))
    last = max(first + 1, min(int(round(end * sample_rate)), waveform.shape[-1]))
    return {"waveform": waveform[..., first:last].detach().clone(), "sample_rate": sample_rate}


def _silent_like(audio: dict[str, Any]) -> dict[str, Any]:
    return {"waveform": torch.zeros_like(audio["waveform"]), "sample_rate": int(audio["sample_rate"])}


def _apply_boundary_fades(
    audio: dict[str, Any],
    fade_seconds: float,
    fade_in: bool,
    fade_out: bool,
) -> dict[str, Any]:
    waveform = audio["waveform"].detach().clone()
    sample_rate = int(audio["sample_rate"])
    fade_samples = min(
        max(0, int(round(float(fade_seconds) * sample_rate))),
        max(0, int(waveform.shape[-1]) // 2),
    )
    if fade_samples <= 0:
        return {"waveform": waveform.contiguous(), "sample_rate": sample_rate}
    if fade_in:
        ramp_in = torch.linspace(0.0, 1.0, fade_samples, device=waveform.device, dtype=waveform.dtype)
        waveform[..., :fade_samples] *= ramp_in
    if fade_out:
        ramp_out = torch.linspace(1.0, 0.0, fade_samples, device=waveform.device, dtype=waveform.dtype)
        waveform[..., -fade_samples:] *= ramp_out
    return {"waveform": waveform.contiguous(), "sample_rate": sample_rate}


def _has_vocal(audio: dict[str, Any], threshold_db: float) -> bool:
    waveform = torch.nan_to_num(audio["waveform"].float(), nan=0.0, posinf=0.0, neginf=0.0)
    rms = float(torch.sqrt(torch.mean(waveform * waveform) + 1e-12).item())
    db = 20.0 * math.log10(max(rms, 1e-10))
    return db > float(threshold_db)


def _unwrap(result: Any) -> str:
    if isinstance(result, dict):
        result = result.get("result", result)
    if isinstance(result, (tuple, list)):
        result = result[0] if result else ""
    return str(result or "").strip()


def _reference_cache_key(reference_images: torch.Tensor, text_model: Any, instruction: Any = "") -> tuple[Any, ...]:
    tensor = reference_images.detach().float().cpu().contiguous()
    digest = hashlib.sha256(tensor.numpy().tobytes()).hexdigest()
    return (
        str(tensor.dtype),
        tuple(int(item) for item in tensor.shape),
        digest,
        str(text_model or ""),
        hashlib.sha256(str(instruction or "").encode("utf-8")).hexdigest(),
        REFERENCE_FEATURE_CACHE_VERSION,
    )


def _cached_reference_features(key: tuple[Any, ...]) -> str:
    value = _REFERENCE_FEATURE_CACHE.get(key, "")
    if value:
        _REFERENCE_FEATURE_CACHE.move_to_end(key)
    return value


def _store_reference_features(key: tuple[Any, ...], value: str) -> None:
    text = str(value or "").strip()
    if not text:
        return
    _REFERENCE_FEATURE_CACHE[key] = text
    _REFERENCE_FEATURE_CACHE.move_to_end(key)
    while len(_REFERENCE_FEATURE_CACHE) > _REFERENCE_FEATURE_CACHE_MAX:
        _REFERENCE_FEATURE_CACHE.popitem(last=False)


def _apply_reference_identity(
    prompt: str,
    reference_features: str,
    static_closeup_tag: str | None = None,
) -> str:
    text = str(prompt or "").strip()
    features = str(reference_features or "").strip()
    if not text or not features or not _PERSON_PROMPT_PATTERN.search(text):
        return text
    return (
        str(STATIC_SINGLE_CENTER_TAG if static_closeup_tag is None else static_closeup_tag).strip()
        + f"主角固定人物与服装设定：{features}。"
        "主角身份和服装保持一致，动作、场景、镜头、灯光与画面风格完全按照当前歌词重新设计。"
        f"{text}"
    )


class GJJ_MTVAudioToPrompt:
    CATEGORY = "GJJ/🎵 音频"
    FUNCTION = "convert"
    OUTPUT_NODE = True
    DESCRIPTION = "将 ACE 音乐音频与歌词 SRT 自动分段，分离人声/伴奏，并用 GJJ_GemmaTextGenerate 逐段生成 MTV 参考画面与 LTX 视频提示词；可从参考图反推并缓存人物特征。"
    SEARCH_ALIASES = ["MTV", "MV", "音频转提示词", "歌词分镜", "LTX", "音乐视频提示词"]
    RETURN_TYPES = ("AUDIO", "STRING", "AUDIO", "STRING")
    RETURN_NAMES = ("完整人声分段列表", "所有分段提示词", "整段背景音乐", "同步 SRT")
    OUTPUT_IS_LIST = (True, False, False, False)
    OUTPUT_TOOLTIPS = (
        "一次输出按时间排序的全部 AUDIO 人声分段列表；无人声段保留为等长静音。",
        "整首音乐的所有分段提示词一次性完整输出，不受“当前分段序号”影响；段落之间以换行、---、换行分隔。",
        "人声分离后的完整背景音乐，供后期与人声合成。",
        "最终使用的同步 SRT；既可能来自外部输入，也可能由 📁 音乐自动通过 Qwen3 ASR 与强制对齐生成。",
    )
    GJJ_UI = {
        "toolbar": ["📁", "👤", "🏕️", "🧠", "⏰", "📢", "📒"],
        "hidden_parameters": [
            "text_model", "separator_model", "min_segment_seconds", "max_segment_seconds",
            "vocal_threshold_db", "target_lufs", "current_segment", "fps", "max_tokens",
            "temperature", "seed", "keep_model", "prompt_instruction", "empty_prompt_instruction",
            "boundary_fade_seconds", "vocal_prompt_tag", "static_closeup_tag",
            "media_file", "asr_model_name", "aligner_model_name",
            "selected_actors_json", "selected_scenes_json",
            "alignment_model",
        ],
    }
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": DESCRIPTION,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "model_tree": [
            {
                "label": "人声分离模型",
                "folder": "diffusion_models",
                "filename": "MelBandRoformer_fp16.safetensors",
                "input": "separator_model",
                "type": "AUDIO_SEPARATOR",
                "description": "整段音乐的人声与背景音乐分离模型。",
            },
            {
                "label": "音频理解与提示词模型",
                "folder": "text_encoders",
                "filename": DEFAULT_TEXT_MODEL,
                "input": "text_model",
                "type": "TEXT_ENCODER",
                "description": "通过 GJJ_GemmaTextGenerate 流程理解分段音频并生成 MTV/LTX 提示词。",
            },
        ],
        "models": [
            {
                "label": "人声分离模型",
                "subdir": "models/diffusion_models",
                "filename": "MelBandRoformer_fp16.safetensors",
                "description": "Mel-Band RoFormer 人声/背景音乐分离模型。",
            },
            {
                "label": "音频理解与提示词模型",
                "subdir": "models/text_encoders",
                "filename": DEFAULT_TEXT_MODEL,
                "description": "GJJ_GemmaTextGenerate 使用的 Qwen3.5 音频理解模型。",
            },
        ],
        "runtime": [
            "整段音频先由 GJJ_AudioSeparator 同流程分离人声和背景音乐。",
            "分段以下一句 SRT 开头为基准，并在人声轨的句间区域寻找明显低能量气口；找到时切在气口安静处，让呼吸归入下一段，找不到则使用下一句开头。",
            "接入参考图片时先反推人物稳定身份特征并缓存，后续所有含人物的分段提示词都以参考图为准。",
            "每个人声段通过 GJJ_GemmaTextGenerate 音频理解流程生成一条 MTV/LTX 场景提示词。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        text_models = _text_encoder_options()
        text_model_choices = list(dict.fromkeys([DEFAULT_TEXT_MODEL, *text_models]))
        text_models_missing = not bool(text_models)
        separator_models = _scan_melband_models()
        separator_models_missing = not separator_models or separator_models[0].startswith("[")
        if separator_models_missing:
            separator_models = ["MelBandRoformer_fp16.safetensors"] + separator_models
        from .gjj_qwen3_asr_text_formats import (
            ALIGNER_MODEL_REPOS, ASR_MODEL_REPOS, _list_local_model_names,
        )
        asr_default = next(iter(ASR_MODEL_REPOS))
        aligner_default = next(iter(ALIGNER_MODEL_REPOS))
        local_asr_models = _list_local_model_names("asr")
        local_aligner_models = _list_local_model_names("aligner")
        asr_models = list(dict.fromkeys([asr_default, *local_asr_models]))
        aligner_models = list(dict.fromkeys([aligner_default, *local_aligner_models]))
        return {
            "required": {
                "text_model": (text_model_choices, _hidden({
                    "default": DEFAULT_TEXT_MODEL, "display_name": "提示词反推模型",
                    "modelTreeMissingDefault": text_models_missing,
                })),
                "separator_model": (separator_models, _hidden({
                    "default": separator_models[0] if separator_models else "", "display_name": "人声分离模型",
                    "modelTreeMissingDefault": separator_models_missing,
                })),
                "min_segment_seconds": ("FLOAT", _hidden({
                    "default": 3.0, "min": 0.1, "max": 120.0, "step": 0.1, "display_name": "最短分段（秒）",
                })),
                "max_segment_seconds": ("FLOAT", _hidden({
                    "default": 8.0, "min": 0.1, "max": 15.0, "step": 0.1,
                    "display_name": "最长分段硬上限（秒）",
                    "tooltip": "优先在此时长内寻找歌词或气口边界；没有安全边界时也会在上限处切分，防止视频模型注意力遮罩与 latent 过长。",
                })),
                "vocal_threshold_db": ("FLOAT", _hidden({
                    "default": -48.0, "min": -120.0, "max": 0.0, "step": 1.0, "display_name": "人声判定阈值 dB",
                })),
                "target_lufs": ("FLOAT", _hidden({
                    "default": -23.0, "min": -100.0, "max": 0.0, "step": 0.1, "display_name": "人声目标 LUFS",
                })),
                "current_segment": ("INT", _hidden({
                    "default": 1, "min": 1, "max": 100000, "step": 1, "display_name": "当前人声段",
                })),
                "fps": ("FLOAT", _hidden({
                    "default": 24.0, "min": 1.0, "max": 240.0, "step": 0.01, "display_name": "目标视频帧率",
                })),
                "max_tokens": ("INT", _hidden({
                    "default": 320, "min": 32, "max": 4096, "step": 1, "display_name": "单段最大 Token",
                })),
                "temperature": ("FLOAT", _hidden({
                    "default": 0.65, "min": 0.01, "max": 2.0, "step": 0.01, "display_name": "生成温度",
                })),
                "seed": ("INT", _hidden({
                    "default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "step": 1, "display_name": "种子",
                })),
                "keep_model": ("BOOLEAN", _hidden({"default": True, "display_name": "保持提示词模型"})),
                "prompt_instruction": ("STRING", _hidden({
                    "default": "", "multiline": True, "display_name": "有人声提示词指令",
                })),
                "empty_prompt_instruction": ("STRING", _hidden({
                    "default": "", "multiline": True, "display_name": "无人声提示词指令",
                })),
                "boundary_fade_seconds": ("FLOAT", _hidden({
                    "default": 0.05, "min": 0.0, "max": 2.0, "step": 0.01, "display_name": "分段边缘淡化（秒）",
                    "tooltip": "相邻人声段边缘使用短淡入淡出，避免波形硬切、爆音和戛然而止。0 表示关闭。",
                })),
                "vocal_prompt_tag": ("STRING", _hidden({
                    "default": LTX_SINGING_TAG,
                    "multiline": True,
                    "display_name": "有人声标签",
                    "tooltip": "仅添加到有人声分段最前面。LTX 可用它识别并替换成视频阶段提示词。",
                })),
                "static_closeup_tag": ("STRING", _hidden({
                    "default": STATIC_SINGLE_CENTER_TAG,
                    "multiline": True,
                    "display_name": "静态人物特写标签",
                    "tooltip": "接入人物参考图且当前分段有人物时添加，用于生成清晰的近景静态参考图。",
                })),
            },
            "optional": {
                "audio": ("AUDIO", {"display_name": "可选音乐音频", "tooltip": "未连接时使用主面板 📁 选择的音频或视频音轨。"}),
                "srt": ("STRING", {"forceInput": True, "multiline": True, "display_name": "可选歌词 SRT", "tooltip": "留空且使用 📁 音乐时，自动通过 Qwen3 ASR 与强制对齐生成同步 SRT。"}),
                "reference_image": (
                    REFERENCE_IMAGE_TYPE,
                    {
                        "display_name": "可选人物参考图片",
                        "tooltip": "支持 GJJ_BATCH_IMAGE 与普通 IMAGE。接入后先反推并缓存人物身份、脸部、发型、体型和服饰特征；后续所有涉及人物的提示词必须以参考图为准。",
                    },
                ),
                "media_file": ("STRING", _hidden({"default": "", "display_name": "本地音频/视频素材"})),
                "asr_model_name": (asr_models, _hidden({"default": asr_default, "display_name": "ASR 模型", "modelTreeMissingDefault": not local_asr_models})),
                "aligner_model_name": (aligner_models, _hidden({"default": aligner_default, "display_name": "强制对齐模型", "modelTreeMissingDefault": not local_aligner_models})),
                "selected_actors_json": ("STRING", _hidden({"default": "[]", "display_name": "选中角色库项目"})),
                "selected_scenes_json": ("STRING", _hidden({"default": "[]", "display_name": "选中场景库项目"})),
                "alignment_model": (FRAME_ALIGNMENT_MODELS, _hidden({
                    "default": "LTX", "display_name": "视频模型帧对齐",
                    "tooltip": "WAN=4n+1，LTX=8n+1，MinimaxH3=17n+5。分段断点只向较短方向吸附，不在末尾补帧。",
                })),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        seed = kwargs.get("seed", 0)
        seed = seed[0] if isinstance(seed, list) and seed else seed
        return float("NaN") if int(seed or 0) == 0 else str(seed)

    def convert(
        self,
        *,
        text_model,
        separator_model,
        min_segment_seconds=3.0,
        max_segment_seconds=8.0,
        vocal_threshold_db=-48.0,
        target_lufs=-23.0,
        current_segment=1,
        fps=24.0,
        max_tokens=320,
        temperature=0.65,
        seed=0,
        keep_model=True,
        prompt_instruction="",
        empty_prompt_instruction="",
        boundary_fade_seconds=0.05,
        vocal_prompt_tag=LTX_SINGING_TAG,
        static_closeup_tag=STATIC_SINGLE_CENTER_TAG,
        unique_id=None,
        reference_image=None,
        audio=None,
        media_file="",
        srt="",
        asr_model_name=None,
        aligner_model_name=None,
        selected_actors_json="[]",
        selected_scenes_json="[]",
        alignment_model="LTX",
    ):
        _send_prompt_preview(unique_id, "", 0, 0)
        if audio is None:
            if not str(media_file or "").strip():
                raise RuntimeError("请连接可选音乐音频接口，或点击主面板 📁 选择音频/视频素材。")
            from .gjj_audio_separator import _load_audio_from_file
            audio = _load_audio_from_file(media_file)
        if not str(srt or "").strip():
            if not str(media_file or "").strip():
                raise RuntimeError("SRT 未连接；自动生成同步 SRT 需要先用主面板 📁 打开音乐素材。")
            _send_status(unique_id, "正在通过 Qwen3 ASR 生成同步 SRT…")
            from .gjj_qwen3_asr_text_formats import transcribe_and_align_backend
            asr_result = transcribe_and_align_backend(
                audio=audio,
                asr_model_name=asr_model_name,
                aligner_model_name=aligner_model_name,
                output_order_json='["srt"]',
                unique_id=unique_id,
            )
            values = asr_result.get("result", ()) if isinstance(asr_result, dict) else asr_result
            srt = str(values[0] if values else "").strip()
            if not srt:
                raise RuntimeError("Qwen3 ASR 未生成有效的同步 SRT。")
        shared_prompts = read_mtv_ltx_prompt_settings()
        # 兼容保留旧工作流参数槽位，但推理命令只从 📒 共享面板读取。
        prompt_instruction = shared_prompts.get("prompt_instruction", "")
        empty_prompt_instruction = shared_prompts.get("empty_prompt_instruction", "")
        vocal_image_prompt = shared_prompts.get("vocal_image_prompt", vocal_prompt_tag)
        reference_feature_instruction = shared_prompts.get("reference_feature_instruction", "")
        segment_request_template = shared_prompts.get("segment_request_template", "")
        if not segment_request_template.strip():
            raise RuntimeError("📒 提示词参数中的“分镜完整请求模板”为空。")
        generator = GJJ_GemmaTextGenerate()
        selected_actors = _library_items(selected_actors_json, "@")
        selected_scenes = _library_items(selected_scenes_json, "🏕️")
        reference_features = ""
        if reference_image is not None:
            if not reference_feature_instruction.strip():
                raise RuntimeError("📒 提示词参数中的“参考图特征提取指令”为空。")
            _send_status(unique_id, "1/5 正在读取参考图片并反推人物特征…")
            reference_images = _coerce_media_for_textgen(reference_image)
            if not isinstance(reference_images, torch.Tensor) or reference_images.ndim != 4 or not reference_images.numel():
                raise RuntimeError("可选人物参考图片没有解析出有效的 GJJ_BATCH_IMAGE / IMAGE。")
            reference_key = _reference_cache_key(reference_images, text_model, reference_feature_instruction)
            reference_features = _cached_reference_features(reference_key)
            if reference_features:
                _send_status(unique_id, "1/5 已命中人物参考特征缓存。")
            else:
                reference_features = _unwrap(generator.generate(
                    clip_name=text_model,
                    clip_type="stable_diffusion",
                    clip_device="default",
                    prompt=reference_feature_instruction,
                    max_length=max(256, int(max_tokens)),
                    sampling_mode="off",
                    temperature=0.2,
                    top_k=32,
                    top_p=0.9,
                    min_p=0.05,
                    repetition_penalty=1.05,
                    seed=0,
                    presence_penalty="0.0",
                    thinking=False,
                    use_default_template=True,
                    media=reference_images,
                    keep_model=True,
                    device_preference="GPU优先",
                    unique_id=unique_id,
                ))
                if not reference_features:
                    raise RuntimeError("参考图片人物特征反推结果为空，无法建立人物一致性约束。")
                _store_reference_features(reference_key, reference_features)
                _send_status(unique_id, "1/5 人物参考特征反推完成并已缓存。")

        progress_total = 5 if reference_image is not None else 4
        separation_step = 2 if reference_image is not None else 1
        timeline_step = separation_step + 1
        generation_step = timeline_step + 1
        completion_step = progress_total
        _send_status(unique_id, f"{separation_step}/{progress_total} 正在分离整段人声与背景音乐…")
        separator_result = GJJ_AudioSeparator().execute(
            **{
                "📦 模型选择": separator_model,
                "audio": audio,
                "🏷️ 音频标签": "MTV",
                "🛠️ 维度修复模式": "显式维度修复",
                "🧾 日志输出": False,
                "🎚️ LUFS目标响度": float(target_lufs),
                "unique_id": unique_id,
            }
        )
        vocals, background, duration, _tag = separator_result["result"]
        entries = _parse_srt(str(srt or ""))
        full_lyrics_context = "\n".join(
            str(item.get("text") or "").strip()
            for item in entries
            if str(item.get("text") or "").strip()
        ).strip()
        segments = _segment_timeline(
            duration=duration,
            entries=entries,
            min_seconds=min_segment_seconds,
            max_seconds=max_segment_seconds,
            vocals=vocals,
            vocal_threshold_db=vocal_threshold_db,
        )
        segments = _align_segments_to_video_model(
            segments=segments,
            entries=entries,
            duration=duration,
            min_seconds=min_segment_seconds,
            max_seconds=max_segment_seconds,
            fps=fps,
            alignment_model=alignment_model,
        )
        if not segments:
            raise RuntimeError("当前音频在所选视频模型帧规则下无法形成有效分段，请增大最长分段或检查帧率。")
        _send_status(unique_id, f"{timeline_step}/{progress_total} 已按 SRT 与时间参数划分 {len(segments)} 个段落")
        generated: list[str] = []
        vocal_queue: list[dict[str, Any]] = []
        metadata: list[dict[str, Any]] = []
        _send_prompt_preview(unique_id, "", 0, len(segments))

        for index, segment in enumerate(segments, start=1):
            _send_status(unique_id, f"{generation_step}/{progress_total} 正在生成第 {index}/{len(segments)} 段提示词…")
            vocal_slice = _slice_audio(vocals, segment["start"], segment["end"])
            has_vocal = _has_vocal(vocal_slice, vocal_threshold_db)
            if has_vocal:
                vocal_output = _apply_boundary_fades(
                    vocal_slice,
                    boundary_fade_seconds,
                    fade_in=index > 1,
                    fade_out=index < len(segments),
                )
            else:
                vocal_output = _silent_like(vocal_slice)
            vocal_queue.append(vocal_output)
            has_lyrics = bool(str(segment.get("lyrics") or "").strip())
            singing_segment = has_lyrics and has_vocal
            instruction = str(prompt_instruction if singing_segment else empty_prompt_instruction)
            if not singing_segment and index == 1:
                empty_scene_role = "片头"
                empty_scene_constraint = shared_prompts.get("silent_intro_context", "")
            elif not singing_segment and index == len(segments):
                empty_scene_role = "片尾"
                empty_scene_constraint = shared_prompts.get("silent_outro_context", "")
            elif not singing_segment:
                empty_scene_role = "过场"
                empty_scene_constraint = shared_prompts.get("silent_transition_context", "")
            else:
                empty_scene_role = "歌词剧情"
                empty_scene_constraint = ""
            vocal_performance_constraint = (
                shared_prompts.get("singing_segment_context", "")
                if singing_segment else
                _fill_prompt_template(
                    shared_prompts.get("silent_segment_context", ""),
                    silent_role_context=empty_scene_constraint,
                )
            )
            lyric_context = segment["lyrics"] or (
                _fill_prompt_template(
                    shared_prompts.get("silent_lyrics_context", ""),
                    full_lyrics=full_lyrics_context,
                )
            )
            assigned_actors = _assigned_items(selected_actors, index, len(segments))
            assigned_scenes = _assigned_items(selected_scenes, index, len(segments))
            actor_default_notes = shared_prompts.get("actor_default_notes", "")
            scene_default_notes = shared_prompts.get("scene_default_notes", "")
            actor_lines = "\n".join(f"- {item['name']}：{item['notes'] or actor_default_notes}" for item in selected_actors)
            scene_lines = "\n".join(f"- {item['name']}：{item['notes'] or scene_default_notes}" for item in selected_scenes)
            assigned_actor_names = [item["name"] for item in assigned_actors]
            assigned_scene_names = [item["name"] for item in assigned_scenes]
            scene_marker_rule = (
                shared_prompts.get("selected_scene_rule", "")
                if selected_scenes else
                shared_prompts.get("unselected_scene_rule", "")
            )
            next_scenes = _assigned_items(selected_scenes, index + 1, len(segments)) if index < len(segments) else []
            next_actors = _assigned_items(selected_actors, index + 1, len(segments)) if index < len(segments) else []
            reference_constraint = (
                _fill_prompt_template(
                    shared_prompts.get("reference_identity_context", ""),
                    reference_features=reference_features,
                )
                if reference_features and singing_segment else ""
            )
            request = _fill_prompt_template(
                segment_request_template,
                instruction=instruction,
                start=f"{segment['start']:.3f}",
                end=f"{segment['end']:.3f}",
                duration=f"{segment['end'] - segment['start']:.3f}",
                lyrics=lyric_context,
                reference_context=reference_constraint,
                segment_context=vocal_performance_constraint,
                actor_library=actor_lines,
                scene_library=scene_lines,
                assigned_scenes="、".join(assigned_scene_names),
                assigned_actors="、".join(assigned_actor_names),
                previous_storyboard=generated[-1] if generated else "",
                next_scenes="、".join(item["name"] for item in next_scenes),
                next_actors="、".join(item["name"] for item in next_actors),
                scene_marker_rule=scene_marker_rule,
            )
            text = _unwrap(generator.generate(
                clip_name=text_model,
                clip_type="stable_diffusion",
                clip_device="default",
                prompt=request,
                max_length=int(max_tokens),
                sampling_mode="on",
                temperature=float(temperature),
                top_k=64,
                top_p=0.95,
                min_p=0.05,
                repetition_penalty=1.05,
                seed=int(seed) + index - 1 if int(seed) else 0,
                presence_penalty="0.0",
                thinking=False,
                use_default_template=True,
                media=vocal_slice if singing_segment and has_vocal else _slice_audio(background, segment["start"], segment["end"]),
                keep_model=bool(keep_model),
                device_preference="GPU优先",
                unique_id=unique_id,
            ))
            if not text:
                text = (
                    "主角以嘴巴自然闭合、表情放松的状态面对镜头，"
                    "舞台灯光随音乐节奏流动，电影感中近景构图。"
                    if singing_segment else
                    "无人的空舞台建立镜头，舞台灯光随音乐节奏缓慢流动，电影感构图，细腻氛围，平稳推进镜头。"
                )
            text = _storyboard_line(text, index, assigned_scene_names, assigned_actor_names)
            generated.append(text)
            _send_prompt_preview(unique_id, "\n---\n".join(generated), index, len(segments))
            metadata.append({
                "segment": index,
                "start": round(segment["start"], 3),
                "end": round(segment["end"], 3),
                "has_vocal": has_vocal,
                "has_lyrics": has_lyrics,
                "scene_role": empty_scene_role,
                "lyrics": segment["lyrics"],
                "prompt": text,
            })

        selected = max(1, min(int(current_segment), len(vocal_queue))) - 1
        # 人声输出始终返回完整 AUDIO 列表；current_segment 仅兼容既有工作流，
        # 不再筛选人声输出。提示词同样始终聚合完整分段列表。
        prompt_text = "\n---\n".join(generated)
        _send_status(
            unique_id,
            f"{completion_step}/{progress_total} 完成：已生成全部 {len(segments)} 段提示词"
            + ("，人物提示词已应用参考图约束。" if reference_features else ""),
        )
        return {
            "ui": {
                "gjj_mtv_audio_to_prompt": [{
                    "segment_count": len(segments),
                    "segment_index": selected + 1,
                    "has_vocal": metadata[selected]["has_vocal"],
                    "reference_cached": bool(reference_features),
                    "reference_features": reference_features,
                }]
            },
            "result": (
                vocal_queue,
                prompt_text,
                background,
                str(srt or ""),
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MTVAudioToPrompt}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
