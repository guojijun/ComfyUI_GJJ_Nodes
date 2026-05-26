import json
import math
from typing import Any, Dict, List, Optional, Tuple

import torch


NODE_NAME = "GJJ_SpeakerIsolation"


def _extract_audio(audio: Any) -> Tuple[torch.Tensor, int]:
    if isinstance(audio, dict):
        waveform = audio.get("waveform")
        sample_rate = audio.get("sample_rate")
    elif isinstance(audio, (list, tuple)) and len(audio) >= 2:
        waveform, sample_rate = audio[0], audio[1]
    else:
        raise TypeError("输入必须是 ComfyUI AUDIO 数据。")

    if waveform is None or sample_rate is None:
        raise ValueError("AUDIO 数据缺少 waveform 或 sample_rate。")

    if not isinstance(waveform, torch.Tensor):
        waveform = torch.as_tensor(waveform, dtype=torch.float32)
    waveform = waveform.detach().to(dtype=torch.float32).cpu()

    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0).unsqueeze(0)
    elif waveform.ndim == 2:
        if waveform.shape[0] <= 8 and waveform.shape[1] > waveform.shape[0]:
            waveform = waveform.unsqueeze(0)
        else:
            waveform = waveform.t().unsqueeze(0)
    elif waveform.ndim == 3:
        pass
    else:
        raise ValueError(f"不支持的 AUDIO waveform 形状：{tuple(waveform.shape)}")

    if waveform.shape[-1] <= 0:
        raise ValueError("音频为空。")

    max_abs = float(waveform.abs().max().item())
    if max_abs > 1.5:
        waveform = waveform / 32768.0
    waveform = waveform.clamp(-1.0, 1.0)
    return waveform.contiguous(), int(sample_rate)


def _mono(waveform: torch.Tensor) -> torch.Tensor:
    if waveform.ndim == 3:
        return waveform[0].mean(dim=0).contiguous()
    if waveform.ndim == 2:
        return waveform.mean(dim=0).contiguous()
    return waveform.flatten().contiguous()


def _audio_like(waveform: torch.Tensor, sample_rate: int) -> Dict[str, Any]:
    return {"waveform": waveform.contiguous(), "sample_rate": int(sample_rate)}


def _seconds(samples: int, sample_rate: int) -> float:
    return float(samples) / max(1, int(sample_rate))


def _fmt_time(seconds: float) -> str:
    total_ms = max(0, int(round(float(seconds) * 1000.0)))
    mins, rem_ms = divmod(total_ms, 60_000)
    secs, ms = divmod(rem_ms, 1000)
    return f"{mins:02d}:{secs:02d}.{ms:03d}"


def _rms_threshold(threshold_db: float) -> float:
    return float(10.0 ** (float(threshold_db) / 20.0))


def _detect_speech_turns(
    mono: torch.Tensor,
    sample_rate: int,
    silence_thresh_db: float,
    min_segment_s: float,
    merge_gap_s: float,
) -> List[Dict[str, Any]]:
    sample_count = int(mono.numel())
    if sample_count <= 0:
        return []

    frame = max(128, int(sample_rate * 0.030))
    hop = max(64, int(sample_rate * 0.015))
    if sample_count < frame:
        rms = float(torch.sqrt(torch.mean(mono * mono) + 1e-12).item())
        return [{"start_sample": 0, "end_sample": sample_count}] if rms >= _rms_threshold(silence_thresh_db) else []

    frames = mono.unfold(0, frame, hop)
    rms = torch.sqrt(torch.mean(frames * frames, dim=1) + 1e-12)
    voiced = rms >= _rms_threshold(silence_thresh_db)
    if not bool(voiced.any().item()):
        overall_rms = float(torch.sqrt(torch.mean(mono * mono) + 1e-12).item())
        if overall_rms < _rms_threshold(silence_thresh_db):
            return []
        return [{"start_sample": 0, "end_sample": sample_count}]

    turns: List[Dict[str, Any]] = []
    active_start: Optional[int] = None
    for idx, is_voiced in enumerate(voiced.tolist()):
        frame_start = idx * hop
        frame_end = min(sample_count, frame_start + frame)
        if is_voiced and active_start is None:
            active_start = frame_start
        elif not is_voiced and active_start is not None:
            turns.append({"start_sample": active_start, "end_sample": frame_end})
            active_start = None
    if active_start is not None:
        turns.append({"start_sample": active_start, "end_sample": sample_count})

    merge_gap = int(max(0.0, merge_gap_s) * sample_rate)
    merged: List[Dict[str, Any]] = []
    for turn in turns:
        if merged and int(turn["start_sample"]) - int(merged[-1]["end_sample"]) <= merge_gap:
            merged[-1]["end_sample"] = max(int(merged[-1]["end_sample"]), int(turn["end_sample"]))
        else:
            merged.append(dict(turn))

    min_len = int(max(0.05, min_segment_s) * sample_rate)
    filtered = [turn for turn in merged if int(turn["end_sample"]) - int(turn["start_sample"]) >= min_len]
    return filtered or merged[:1]


def _segment_feature(mono: torch.Tensor, sample_rate: int, start: int, end: int) -> torch.Tensor:
    clip = mono[max(0, start) : max(start + 1, end)].float()
    if clip.numel() < 2:
        return torch.zeros(5, dtype=torch.float32)

    rms = torch.sqrt(torch.mean(clip * clip) + 1e-12)
    peak = torch.max(torch.abs(clip)) + 1e-12
    signs = torch.sign(clip)
    zcr = torch.mean((signs[1:] != signs[:-1]).float()) if clip.numel() > 1 else torch.tensor(0.0)

    fft_size = min(4096, int(2 ** math.floor(math.log2(max(2, clip.numel())))))
    if fft_size >= 32:
        step = max(1, clip.numel() // fft_size)
        sample = clip[::step][:fft_size]
        window = torch.hann_window(sample.numel(), dtype=sample.dtype)
        mag = torch.abs(torch.fft.rfft(sample * window)) + 1e-12
        freqs = torch.linspace(0.0, float(sample_rate) / 2.0, mag.numel())
        centroid = torch.sum(freqs * mag) / torch.sum(mag) / max(1.0, float(sample_rate) / 2.0)
    else:
        centroid = torch.tensor(0.0)

    duration = torch.tensor(min(10.0, _seconds(end - start, sample_rate)) / 10.0)
    return torch.stack(
        [
            torch.log10(rms + 1e-6),
            rms / peak,
            zcr,
            centroid.float(),
            duration.float(),
        ]
    ).to(dtype=torch.float32)


def _cluster_turns(mono: torch.Tensor, sample_rate: int, turns: List[Dict[str, Any]], speaker_count: int) -> None:
    if not turns:
        return
    k = max(1, min(int(speaker_count), len(turns)))
    if k == 1:
        for turn in turns:
            turn["speaker_index"] = 1
            turn["speaker"] = "SPEAKER_01"
        return

    features = torch.stack(
        [
            _segment_feature(mono, sample_rate, int(turn["start_sample"]), int(turn["end_sample"]))
            for turn in turns
        ]
    )
    mean = features.mean(dim=0, keepdim=True)
    std = features.std(dim=0, keepdim=True).clamp_min(1e-4)
    features = (features - mean) / std

    init_ids = torch.linspace(0, len(turns) - 1, steps=k).round().long()
    centers = features[init_ids].clone()
    labels = torch.zeros(len(turns), dtype=torch.long)
    for _ in range(16):
        dist = torch.cdist(features, centers)
        new_labels = torch.argmin(dist, dim=1)
        if torch.equal(new_labels, labels):
            break
        labels = new_labels
        for idx in range(k):
            mask = labels == idx
            if bool(mask.any().item()):
                centers[idx] = features[mask].mean(dim=0)

    first_seen: Dict[int, int] = {}
    next_index = 1
    for raw_label in labels.tolist():
        if raw_label not in first_seen:
            first_seen[raw_label] = next_index
            next_index += 1

    for turn, raw_label in zip(turns, labels.tolist()):
        speaker_index = first_seen[raw_label]
        turn["speaker_index"] = speaker_index
        turn["speaker"] = f"SPEAKER_{speaker_index:02d}"


def _merge_same_speaker(turns: List[Dict[str, Any]], sample_rate: int, merge_gap_s: float) -> List[Dict[str, Any]]:
    if not turns:
        return []
    merge_gap = int(max(0.0, merge_gap_s) * sample_rate)
    merged: List[Dict[str, Any]] = []
    for turn in turns:
        if (
            merged
            and merged[-1].get("speaker_index") == turn.get("speaker_index")
            and int(turn["start_sample"]) - int(merged[-1]["end_sample"]) <= merge_gap
        ):
            merged[-1]["end_sample"] = max(int(merged[-1]["end_sample"]), int(turn["end_sample"]))
        else:
            merged.append(dict(turn))
    return merged


def _parse_whisper_segments(whisper_output: Any) -> List[Dict[str, Any]]:
    if not whisper_output:
        return []
    if isinstance(whisper_output, str):
        try:
            whisper_output = json.loads(whisper_output)
        except Exception:
            return []
    if not isinstance(whisper_output, dict):
        return []

    raw_segments = whisper_output.get("segments")
    if not raw_segments:
        raw_segments = whisper_output.get("chunks")

    parsed: List[Dict[str, Any]] = []
    if isinstance(raw_segments, list):
        for item in raw_segments:
            if not isinstance(item, dict):
                continue
            timestamp = item.get("timestamp")
            if isinstance(timestamp, (list, tuple)) and len(timestamp) >= 2:
                start, end = timestamp[0], timestamp[1]
            else:
                start, end = item.get("start"), item.get("end")
            try:
                start_f = float(start)
                end_f = float(end if end is not None else start_f)
            except Exception:
                continue
            text = str(item.get("text") or "").strip()
            parsed.append({"start": max(0.0, start_f), "end": max(start_f, end_f), "text": text})
    return parsed


def _pick_turn_for_range(start: float, end: float, turns: List[Dict[str, Any]], sample_rate: int) -> Optional[Dict[str, Any]]:
    best_turn = None
    best_overlap = 0.0
    for turn in turns:
        turn_start = _seconds(int(turn["start_sample"]), sample_rate)
        turn_end = _seconds(int(turn["end_sample"]), sample_rate)
        overlap = max(0.0, min(end, turn_end) - max(start, turn_start))
        if overlap > best_overlap:
            best_overlap = overlap
            best_turn = turn
    return best_turn


def _build_entries(turns: List[Dict[str, Any]], whisper_segments: List[Dict[str, Any]], sample_rate: int) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    if whisper_segments:
        for segment in whisper_segments:
            text = str(segment.get("text") or "").strip()
            if not text:
                continue
            start = float(segment.get("start") or 0.0)
            end = float(segment.get("end") or start)
            turn = _pick_turn_for_range(start, end, turns, sample_rate)
            if turn is None:
                speaker = "UNKNOWN"
                speaker_index = 0
            else:
                speaker = str(turn.get("speaker") or "SPEAKER_01")
                speaker_index = int(turn.get("speaker_index") or 1)
            entries.append(
                {
                    "speaker": speaker,
                    "speaker_index": speaker_index,
                    "start": start,
                    "end": max(start, end),
                    "text": text,
                }
            )
    else:
        for turn in turns:
            start = _seconds(int(turn["start_sample"]), sample_rate)
            end = _seconds(int(turn["end_sample"]), sample_rate)
            entries.append(
                {
                    "speaker": str(turn.get("speaker") or "SPEAKER_01"),
                    "speaker_index": int(turn.get("speaker_index") or 1),
                    "start": start,
                    "end": end,
                    "text": "",
                }
            )
    return entries


def _merge_text_entries(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not entries:
        return []
    merged: List[Dict[str, Any]] = []
    for entry in entries:
        if merged and merged[-1].get("speaker") == entry.get("speaker"):
            merged[-1]["end"] = max(float(merged[-1]["end"]), float(entry["end"]))
            merged[-1]["text"] = (str(merged[-1].get("text") or "") + " " + str(entry.get("text") or "")).strip()
        else:
            merged.append(dict(entry))
    return merged


def _format_entries(entries: List[Dict[str, Any]]) -> str:
    lines = []
    for entry in entries:
        text = str(entry.get("text") or "").strip()
        if text:
            lines.append(f"{_fmt_time(float(entry['start']))} {entry['speaker']}: {text}")
        else:
            lines.append(f"{_fmt_time(float(entry['start']))}-{_fmt_time(float(entry['end']))} {entry['speaker']}")
    return "\n".join(lines)


def _isolate_audio(
    waveform: torch.Tensor,
    turns: List[Dict[str, Any]],
    speaker_index: int,
) -> Tuple[torch.Tensor, torch.Tensor]:
    selected = [turn for turn in turns if int(turn.get("speaker_index") or 1) == int(speaker_index)]
    masked = torch.zeros_like(waveform)
    chunks: List[torch.Tensor] = []
    total = waveform.shape[-1]
    for turn in selected:
        start = max(0, min(total, int(turn["start_sample"])))
        end = max(start, min(total, int(turn["end_sample"])))
        if end <= start:
            continue
        masked[..., start:end] = waveform[..., start:end]
        chunks.append(waveform[..., start:end])
    if chunks:
        concat = torch.cat(chunks, dim=-1)
    else:
        concat = torch.zeros(*waveform.shape[:-1], 1, dtype=waveform.dtype)
    return masked.contiguous(), concat.contiguous()


class GJJ_SpeakerIsolation:
    CATEGORY = "GJJ/Audio"
    FUNCTION = "isolate"
    RETURN_TYPES = ("AUDIO", "AUDIO", "STRING", "STRING", "INT")
    RETURN_NAMES = ("选中说话人原位音频", "选中说话人拼接音频", "说话人文本", "说话人JSON", "片段总数")
    DESCRIPTION = (
        "零依赖说话人分段/隔离节点：不依赖 ComfyUI-Speaker-Isolation、pyannote、Whisper 或 HF Token。"
        "可选接入 WHISPER_OUTPUT，将已有识别文本按时间戳对齐到估算的说话人片段。"
    )
    GJJ_HELP = {
        "功能": [
            "默认使用音频能量检测和轻量特征聚类估算说话人片段。",
            "speaker_index 从 1 开始：1 表示 SPEAKER_01，2 表示 SPEAKER_02。",
            "接入 WHISPER_OUTPUT 后会输出带说话人的文本；不接入时输出时间段清单。",
        ],
        "限制": [
            "这是零依赖近似隔离，不等同于 pyannote 的深度说话人识别模型。",
            "多人重叠说话、背景音乐很强或音质很差时，建议先做降噪/人声增强，或接外部 ASR 时间戳辅助。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"display_name": "音频"}),
                "speaker_count": (
                    "INT",
                    {
                        "default": 2,
                        "min": 1,
                        "max": 8,
                        "step": 1,
                        "display_name": "说话人数",
                        "tooltip": "预计说话人的数量；零依赖模式会按这个数量做轻量聚类。",
                    },
                ),
                "speaker_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 8,
                        "step": 1,
                        "display_name": "选择说话人",
                        "tooltip": "从 1 开始：1=SPEAKER_01，2=SPEAKER_02。",
                    },
                ),
                "silence_thresh_db": (
                    "FLOAT",
                    {
                        "default": -40.0,
                        "min": -80.0,
                        "max": -10.0,
                        "step": 1.0,
                        "display_name": "静音阈值dB",
                        "tooltip": "低于该音量的区域会被视为静音；环境噪声大时可调高。",
                    },
                ),
                "min_segment_s": (
                    "FLOAT",
                    {
                        "default": 0.45,
                        "min": 0.05,
                        "max": 10.0,
                        "step": 0.05,
                        "display_name": "最短片段秒",
                        "tooltip": "短于该时长的语音片段会被过滤或合并。",
                    },
                ),
                "merge_gap_s": (
                    "FLOAT",
                    {
                        "default": 0.35,
                        "min": 0.0,
                        "max": 5.0,
                        "step": 0.05,
                        "display_name": "合并间隔秒",
                        "tooltip": "相邻语音片段间隔小于该值时会合并。",
                    },
                ),
                "merge_consecutive_speaker": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "合并连续同说话人",
                        "tooltip": "相邻片段属于同一说话人时合并为一段。",
                    },
                ),
            },
            "optional": {
                "whisper_output": (
                    "WHISPER_OUTPUT",
                    {
                        "display_name": "识别时间戳",
                        "tooltip": "可选接入 GJJ Faster Whisper 或 MTB Audio To Text 的 WHISPER_OUTPUT，用于生成带说话人的文本。",
                    },
                ),
            },
        }

    def isolate(
        self,
        audio,
        speaker_count,
        speaker_index,
        silence_thresh_db,
        min_segment_s,
        merge_gap_s,
        merge_consecutive_speaker,
        whisper_output=None,
    ):
        waveform, sample_rate = _extract_audio(audio)
        mono = _mono(waveform)
        turns = _detect_speech_turns(mono, sample_rate, silence_thresh_db, min_segment_s, merge_gap_s)
        if not turns:
            empty = torch.zeros_like(waveform)
            return (_audio_like(empty, sample_rate), _audio_like(empty[..., :1], sample_rate), "", "[]", 0)

        _cluster_turns(mono, sample_rate, turns, speaker_count)
        turns = _merge_same_speaker(turns, sample_rate, merge_gap_s) if merge_consecutive_speaker else turns

        max_speaker = max(int(turn.get("speaker_index") or 1) for turn in turns)
        picked_speaker = max(1, min(int(speaker_index), max(1, max_speaker)))
        masked, concat = _isolate_audio(waveform, turns, picked_speaker)

        whisper_segments = _parse_whisper_segments(whisper_output)
        entries = _build_entries(turns, whisper_segments, sample_rate)
        if merge_consecutive_speaker and whisper_segments:
            entries = _merge_text_entries(entries)

        turn_payload = []
        for idx, turn in enumerate(turns, start=1):
            start = _seconds(int(turn["start_sample"]), sample_rate)
            end = _seconds(int(turn["end_sample"]), sample_rate)
            turn_payload.append(
                {
                    "index": idx,
                    "speaker": str(turn.get("speaker") or "SPEAKER_01"),
                    "speaker_index": int(turn.get("speaker_index") or 1),
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "duration": round(max(0.0, end - start), 3),
                }
            )

        payload = {
            "sample_rate": int(sample_rate),
            "speaker_count": int(speaker_count),
            "selected_speaker_index": int(picked_speaker),
            "turns": turn_payload,
            "entries": entries,
        }
        return (
            _audio_like(masked, sample_rate),
            _audio_like(concat, sample_rate),
            _format_entries(entries),
            json.dumps(payload, ensure_ascii=False, indent=2),
            len(turns),
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SpeakerIsolation}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🗣️ 说话人隔离（零依赖）"}
