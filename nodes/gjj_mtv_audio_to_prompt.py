from __future__ import annotations

from collections import OrderedDict
import hashlib
import math
import re
from typing import Any

import torch

from .gjj_audio_separator import GJJ_AudioSeparator, _scan_melband_models
from .gjj_audio_silence_trimmer import _align_audio_queue_to_8n_plus_blank
from .gjj_gemma_text_generate import (
    GJJ_GemmaTextGenerate,
    _coerce_media_for_textgen,
    _text_encoder_options,
)
from .common_utils.mtv_ltx_prompt_settings import read_mtv_ltx_prompt_settings


NODE_NAME = "GJJ_MTVAudioToPrompt"
NODE_DISPLAY_NAME = "GJJ · 🎬 MTV音频转提示词"
DEFAULT_TEXT_MODEL = "Qwen3.5-4B-Uncensored-FP8_E4M3FN.safetensors"
DEFAULT_PROMPT_INSTRUCTION = """你是专业音乐视频（MTV/MV）剧情分镜导演。
根据本段歌词的具体含义，把它改编成一幕电影化剧情画面，写一条可用于生成 MTV 参考图的中文提示词。
人物必须在做与歌词内容直接相关的具体事情，并随歌词切换地点、行为、表情、道具、天气和叙事情境。
必须描述：剧情事件、人物动作、具体环境、镜头景别与角度、灯光、色彩和情绪。
这不是演唱会、舞台录像或歌手表演：除非歌词明确提到，否则禁止舞台、麦克风、乐器、观众、对镜演唱和表演手势。
不要描写唱歌、张嘴或口型；静态参考图中的人物保持自然闭嘴。
不要写解释、标题、序号、时间码、Markdown 或多条方案，只输出一段紧凑且可直接使用的画面提示词。"""
DEFAULT_EMPTY_INSTRUCTION = """这是没有人声的音乐段落。请阅读随附的整首歌词，从歌词的故事、地点、时代、季节、天气、物件和情绪中选择一个无人环境，写成电影化空镜提示词。
空镜必须属于整首歌词构建的故事世界，并能承担片头建立、段落过渡或片尾收束作用；不要脱离歌词自动生成演出现场。
除非歌词明确出现，否则禁止舞台、聚光灯、钢琴、乐器、麦克风、指挥台、观众席、演唱会和演出空间。
不要出现人物、人物外观、观众、歌手、舞者或动态人物剪影。
不要写解释、标题、序号、时间码、Markdown 或多条方案，只输出一段紧凑且可直接使用的画面提示词。"""
REFERENCE_FEATURE_INSTRUCTION = """分析所附参考图片，只提取后续生成画面时必须保持一致的人物设定。
需要准确描述：人物数量、每个人的性别呈现与年龄段、脸型与五官、肤色、发型发色、体型，以及额头印记、痣等稳定身份标志。
必须描述人物的固定服装设计，包括服装类型、主色、关键剪裁、固定装饰和饰品；不同视角中重复出现的服装细节应合并为一套一致设定。
多张图片若是同一人物的不同角度，应合并成一个一致人物描述；若是不同人物，应分别编号描述。
禁止描述人物的站姿、动作、表情，也不要描述参考图的背景、排版、构图、镜头、光线或图片质量。
只输出一段紧凑的中文“人物与服装设定”，不要标题、解释、Markdown 或生成建议。"""
REFERENCE_FEATURE_CACHE_VERSION = "identity_costume_v3"
LTX_SINGING_TAG = "人物嘴巴自然闭合，面部特写。"
STATIC_SINGLE_CENTER_TAG = ("画面中只有一位主角，面部特写。")
STATIC_REFERENCE_CONSTRAINT = (
    "本段将先生成静态参考图：人物嘴巴保持自然闭合或放松中性状态，"
    "不要描写张嘴、口型、喊叫或夸张演唱表情；视频阶段的演唱动作由固定标签交给 LTX 处理。"
    "人物参考图只用于保持主角外貌与固定服装；画面采用一位主角居中的胸像中近景或人物特写，"
    "人物头部与上半身必须占据画面主要面积、五官清晰；禁止远景、全景、大全景、全身小人以及人物占比过小。"
    "背景仍需铺满当前歌词对应的完整场景并具有清晰环境层次。"
)
REFERENCE_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
_REFERENCE_FEATURE_CACHE: OrderedDict[tuple[Any, ...], str] = OrderedDict()
_REFERENCE_FEATURE_CACHE_MAX = 8
_PERSON_PROMPT_PATTERN = re.compile(
    r"人物|歌手|主唱|乐手|舞者|演员|男(?:人|性|生)|女(?:人|性|生)|"
    r"少年|少女|青年|中年|老人|面孔|脸部|全身|半身|人像"
)


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
    minimum = max(0.1, float(min_seconds))
    maximum = max(minimum, float(max_seconds))
    # “最长分段”只是软目标，所有切点必须来自歌词边界，绝不按秒数硬切人声。
    # 第一行开始用于分离片头空镜，最后一行结束用于分离片尾空镜；
    # 中间优先在相邻歌词之间的人声低能量气口切分。
    safe_boundaries: set[float] = set()
    for previous, following in zip(entries, entries[1:]):
        boundary = _breath_aware_boundary(vocals, previous, following, duration)
        if boundary is not None:
            safe_boundaries.add(float(boundary))
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
        candidates_after_target = [
            point for point in safe_boundaries
            if point > target_end
        ]
        if candidates_before_target:
            end = candidates_before_target[-1]
        elif next_activity_boundary is not None:
            # 真实人声开始/结束是强制边界，用于把中间纯音乐过门独立成无人空镜。
            end = next_activity_boundary
        elif candidates_after_target:
            # 当前歌词跨过最长时间时延长到下一处歌词安全边界，避免半句戛然而止。
            end = candidates_after_target[0]
        else:
            end = duration
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
    # “最长分段”软目标的一侧，否则选择合并后总时长较短的一侧。
    while len(segments) > 1:
        short_index = next(
            (
                index for index, segment in enumerate(segments)
                if float(segment["end"]) - float(segment["start"]) < minimum - 1e-6
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


def _reference_cache_key(reference_images: torch.Tensor, text_model: Any) -> tuple[Any, ...]:
    tensor = reference_images.detach().float().cpu().contiguous()
    digest = hashlib.sha256(tensor.numpy().tobytes()).hexdigest()
    return (
        str(tensor.dtype),
        tuple(int(item) for item in tensor.shape),
        digest,
        str(text_model or ""),
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
    CATEGORY = "GJJ/音频"
    FUNCTION = "convert"
    OUTPUT_NODE = True
    DESCRIPTION = "将 ACE 音乐音频与歌词 SRT 自动分段，分离人声/伴奏，并用 GJJ_GemmaTextGenerate 逐段生成 MTV 参考画面与 LTX 视频提示词；可从参考图反推并缓存人物特征。"
    SEARCH_ALIASES = ["MTV", "MV", "音频转提示词", "歌词分镜", "LTX", "音乐视频提示词"]
    RETURN_TYPES = ("AUDIO", "STRING", "AUDIO")
    RETURN_NAMES = ("完整人声分段列表", "所有分段提示词", "整段背景音乐")
    OUTPUT_IS_LIST = (True, False, False)
    OUTPUT_TOOLTIPS = (
        "一次输出按时间排序的全部 AUDIO 人声分段列表；无人声段保留为等长静音。",
        "整首音乐的所有分段提示词一次性完整输出，不受“当前分段序号”影响；段落之间以换行、---、换行分隔。",
        "人声分离后的完整背景音乐，供后期与人声合成。",
    )
    GJJ_UI = {
        "toolbar": ["🧠", "⏰", "📢", "📒"],
        "hidden_parameters": [
            "text_model", "separator_model", "min_segment_seconds", "max_segment_seconds",
            "vocal_threshold_db", "target_lufs", "current_segment", "fps", "max_tokens",
            "temperature", "seed", "keep_model", "prompt_instruction", "empty_prompt_instruction",
            "boundary_fade_seconds", "vocal_prompt_tag", "static_closeup_tag",
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
        text_model_choices = [DEFAULT_TEXT_MODEL] + [
            item for item in text_models
            if str(item).replace("\\", "/").rsplit("/", 1)[-1].lower() != DEFAULT_TEXT_MODEL.lower()
        ]
        separator_models = _scan_melband_models()
        if not separator_models or separator_models[0].startswith("["):
            separator_models = ["MelBandRoformer_fp16.safetensors"] + separator_models
        return {
            "required": {
                "audio": ("AUDIO", {"display_name": "音乐音频", "tooltip": "对齐 GJJ_AudioAceMusicGenerator 的“音乐音频输出”。"}),
                "srt": ("STRING", {"forceInput": True, "multiline": True, "display_name": "歌词 SRT", "tooltip": "对齐 GJJ_AudioAceMusicGenerator 的“原歌词SRT”。"}),
                "text_model": (text_model_choices, _hidden({
                    "default": DEFAULT_TEXT_MODEL, "display_name": "提示词反推模型",
                })),
                "separator_model": (separator_models, _hidden({
                    "default": separator_models[0] if separator_models else "", "display_name": "人声分离模型",
                })),
                "min_segment_seconds": ("FLOAT", _hidden({
                    "default": 3.0, "min": 0.1, "max": 120.0, "step": 0.1, "display_name": "最短分段（秒）",
                })),
                "max_segment_seconds": ("FLOAT", _hidden({
                    "default": 8.0, "min": 0.1, "max": 300.0, "step": 0.1,
                    "display_name": "最长分段软目标（秒）",
                    "tooltip": "优先在此时长内寻找歌词安全边界；一句歌词跨过该时长时会自动延长，绝不硬切人声。",
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
                    "default": DEFAULT_PROMPT_INSTRUCTION, "multiline": True, "display_name": "有人声提示词指令",
                })),
                "empty_prompt_instruction": ("STRING", _hidden({
                    "default": DEFAULT_EMPTY_INSTRUCTION, "multiline": True, "display_name": "无人声提示词指令",
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
                "reference_image": (
                    REFERENCE_IMAGE_TYPE,
                    {
                        "display_name": "可选人物参考图片",
                        "tooltip": "支持 GJJ_BATCH_IMAGE 与普通 IMAGE。接入后先反推并缓存人物身份、脸部、发型、体型和服饰特征；后续所有涉及人物的提示词必须以参考图为准。",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, *args, seed: int = 0, **kwargs):
        return float("NaN") if int(seed or 0) == 0 else str(seed)

    def convert(
        self,
        audio,
        srt,
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
        prompt_instruction=DEFAULT_PROMPT_INSTRUCTION,
        empty_prompt_instruction=DEFAULT_EMPTY_INSTRUCTION,
        boundary_fade_seconds=0.05,
        vocal_prompt_tag=LTX_SINGING_TAG,
        static_closeup_tag=STATIC_SINGLE_CENTER_TAG,
        unique_id=None,
        reference_image=None,
    ):
        shared_prompts = read_mtv_ltx_prompt_settings()
        prompt_instruction = shared_prompts.get("prompt_instruction", prompt_instruction)
        empty_prompt_instruction = shared_prompts.get("empty_prompt_instruction", empty_prompt_instruction)
        vocal_image_prompt = shared_prompts.get("vocal_image_prompt", vocal_prompt_tag)
        generator = GJJ_GemmaTextGenerate()
        reference_features = ""
        if reference_image is not None:
            _send_status(unique_id, "1/5 正在读取参考图片并反推人物特征…")
            reference_images = _coerce_media_for_textgen(reference_image)
            if not isinstance(reference_images, torch.Tensor) or reference_images.ndim != 4 or not reference_images.numel():
                raise RuntimeError("可选人物参考图片没有解析出有效的 GJJ_BATCH_IMAGE / IMAGE。")
            reference_key = _reference_cache_key(reference_images, text_model)
            reference_features = _cached_reference_features(reference_key)
            if reference_features:
                _send_status(unique_id, "1/5 已命中人物参考特征缓存。")
            else:
                reference_features = _unwrap(generator.generate(
                    clip_name=text_model,
                    clip_type="stable_diffusion",
                    clip_device="default",
                    prompt=REFERENCE_FEATURE_INSTRUCTION,
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
            duration,
            entries,
            min_segment_seconds,
            max_segment_seconds,
            vocals=vocals,
            vocal_threshold_db=vocal_threshold_db,
        )
        _send_status(unique_id, f"{timeline_step}/{progress_total} 已按 SRT 与时间参数划分 {len(segments)} 个段落")
        generated: list[str] = []
        vocal_queue: list[dict[str, Any]] = []
        metadata: list[dict[str, Any]] = []

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
                empty_scene_constraint = (
                    "这是片头开场空镜：从整首歌词最核心的故事地点或象征物中选择无人环境，"
                    "建立故事发生的时间、空间和情绪悬念；不要呈现结束或余韵画面。"
                )
            elif not singing_segment and index == len(segments):
                empty_scene_role = "片尾"
                empty_scene_constraint = (
                    "这是片尾收束空镜：回到整首歌词中的关键地点或象征物，用环境变化表现故事结束后的余韵；"
                    "必须与片头采用不同的场景、布景、镜头机位、景别、构图和灯光状态，禁止重复片头画面。"
                )
            elif not singing_segment:
                empty_scene_role = "过场"
                empty_scene_constraint = (
                    "这是中段过场空镜：从整首歌词的故事地点、物件或自然环境中选择无人画面，"
                    "使用与片头、片尾不同的环境细节和镜头构图承接剧情与音乐节奏。"
                )
            else:
                empty_scene_role = "歌词剧情"
                empty_scene_constraint = ""
            vocal_performance_constraint = (
                f"\n静态参考图约束：{STATIC_REFERENCE_CONSTRAINT}\n"
                if singing_segment else
                "\n硬性空镜约束：本段没有有效歌词，只生成无人空镜；"
                "不要出现人物、人物参考特征、观众、歌手、演唱、舞蹈或人物剪影。"
                f"{empty_scene_constraint}\n"
            )
            lyric_context = segment["lyrics"] or (
                "（本段无人声；以下为整首歌词，仅用于确定空镜的故事世界）\n"
                + (full_lyrics_context or "（没有可用歌词）")
            )
            reference_constraint = (
                f"内部固定人物与服装设定（后处理会统一添加，禁止在正文中复述或改写）：{reference_features}\n"
                "只用这份设定确认主角的外貌和固定服装，正文统一称为“主角”，不要另行描述、修改或替换服装。"
                "只设计一位主角居中的独立画面，以胸像中近景或人物特写为主，人物头部与上半身占据画面主要面积、五官清晰；"
                "禁止远景、全景、大全景、全身小人以及人物在画面中占比过小；"
                "背景必须铺满画面，并根据本段歌词设计完整环境、前后景层次和丰富细节。\n"
                if reference_features and singing_segment else ""
            )
            request = (
                f"{instruction}\n\n"
                f"段落时间：{segment['start']:.3f}s - {segment['end']:.3f}s\n"
                f"歌词：\n{lyric_context}\n"
                f"{reference_constraint}"
                f"{vocal_performance_constraint}"
                "请优先依据歌词语义设计具体剧情事件、人物行为和对应场景；"
                "音频只用于判断节奏、情绪和动作强弱，不要把有人声自动理解成舞台演唱。"
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
            if singing_segment:
                text = _apply_reference_identity(text, reference_features, "")
                text = f"{str(vocal_image_prompt or '').strip()}{text}"
            elif empty_scene_role == "片头":
                text = f"片头开场空镜，与片尾使用不同场景和构图。{text}"
            elif empty_scene_role == "片尾":
                text = f"片尾收束空镜，必须与片头使用不同场景、布景、机位和构图。{text}"
            else:
                text = f"中段过场空镜。{text}"
            generated.append(text)
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

        # 与 GJJ_AudioSilenceTrimmer 保持一致：只在每段末尾补静音到 8n+1 帧，
        # 不拉伸或重采样人声主体，方便直接驱动 LTX 视频。
        vocal_queue = _align_audio_queue_to_8n_plus_blank(vocal_queue, float(fps))
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
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MTVAudioToPrompt}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
