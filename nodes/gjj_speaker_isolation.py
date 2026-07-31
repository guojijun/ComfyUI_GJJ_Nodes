import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import torch
import folder_paths


NODE_NAME = "GJJ_SpeakerIsolation"
NO_CAMPPLUS_MODEL = "无（使用轻量算法）"
_CAMPPLUS_CACHE: Dict[Tuple[str, str], torch.nn.Module] = {}
_WHISPER_CACHE: Dict[Tuple[str, str, str], Any] = {}


def _speaker_model_root() -> Path:
    root = Path(folder_paths.models_dir) / "speaker_models"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _campplus_model_names() -> List[str]:
    root = _speaker_model_root()
    names = [
        str(path.relative_to(root)).replace("\\", "/")
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in {".bin", ".ckpt", ".pt", ".pth", ".safetensors"}
    ]
    return [NO_CAMPPLUS_MODEL, *sorted(names, key=str.lower)]


def _resolve_model_device(value: str) -> str:
    requested = str(value or "自动")
    if requested == "CPU":
        return "cpu"
    if requested == "CUDA":
        if not torch.cuda.is_available():
            raise RuntimeError("CAM++ 选择了 CUDA，但当前环境没有可用 CUDA。")
        return "cuda"
    return "cuda" if torch.cuda.is_available() else "cpu"


def _load_campplus_model(model_name: str, device_name: str) -> torch.nn.Module:
    if not model_name or model_name == NO_CAMPPLUS_MODEL:
        raise RuntimeError(
            "声纹模型模式未选择模型。请把 ERes2NetV2、CAM++ 官方权重或转换后的 safetensors "
            "放入 ComfyUI/models/speaker_models 后重启 ComfyUI。"
        )
    model_path = (_speaker_model_root() / str(model_name)).resolve()
    if _speaker_model_root().resolve() not in model_path.parents or not model_path.is_file():
        raise RuntimeError(f"CAM++ 模型不存在：{model_name}")
    device = _resolve_model_device(device_name)
    cache_key = (str(model_path), device)
    cached = _CAMPPLUS_CACHE.get(cache_key)
    if cached is not None:
        return cached

    try:
        if "eres2netv2" in model_path.name.lower():
            from funasr.models.eres2net.eres2netv2 import ERes2NetV2

            model = ERes2NetV2(
                feat_dim=80,
                embedding_size=192,
                m_channels=64,
                baseWidth=26,
                scale=2,
                expansion=2,
                num_blocks=[3, 4, 6, 3],
                pooling_func="TSTP",
                two_emb_layer=False,
            )
        else:
            from funasr.models.campplus.model import CAMPPlus

            model = CAMPPlus(
                feat_dim=80,
                embedding_size=192,
                growth_rate=32,
                bn_size=4,
                init_channels=128,
                config_str="batchnorm-relu",
                memory_efficient=True,
                output_level="segment",
            )
        if model_path.suffix.lower() == ".safetensors":
            from safetensors.torch import load_file

            state_dict = load_file(str(model_path), device="cpu")
        else:
            state_dict = torch.load(str(model_path), map_location="cpu", weights_only=True)
        if isinstance(state_dict, dict):
            for key in ("state_dict", "model", "model_state_dict"):
                nested = state_dict.get(key)
                if isinstance(nested, dict):
                    state_dict = nested
                    break
        if not isinstance(state_dict, dict):
            raise TypeError("权重文件中没有有效的 state_dict。")
        state_dict = {
            str(key).removeprefix("module.").removeprefix("model."): value
            for key, value in state_dict.items()
            if isinstance(value, torch.Tensor)
        }
        model.load_state_dict(state_dict, strict=True)
        model = model.eval().to(device)
    except Exception as exc:
        raise RuntimeError(f"加载说话人声纹模型失败：{exc}") from exc

    _CAMPPLUS_CACHE[cache_key] = model
    return model


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _decode_video_source_audio(video: Any) -> Dict[str, Any]:
    get_source = getattr(video, "get_stream_source", None)
    if not callable(get_source):
        raise ValueError("VIDEO 对象没有可读取的媒体源。")

    try:
        source = get_source()
        import av

        if hasattr(source, "seek"):
            source.seek(0)
        with av.open(source, mode="r") as container:
            if not container.streams.audio:
                raise ValueError("输入 VIDEO 不包含音频轨道。")
            stream = container.streams.audio[0]
            sample_rate = int(stream.codec_context.sample_rate or 0)
            channel_count = int(stream.channels or 1)
            frames: List[torch.Tensor] = []
            for frame in container.decode(stream):
                tensor = torch.from_numpy(frame.to_ndarray())
                if tensor.ndim == 1:
                    tensor = tensor.unsqueeze(0)
                elif int(tensor.shape[0]) != channel_count and int(tensor.shape[-1]) == channel_count:
                    tensor = tensor.transpose(0, 1).contiguous()
                elif int(tensor.shape[0]) != channel_count:
                    tensor = tensor.reshape(-1, channel_count).transpose(0, 1).contiguous()
                if tensor.dtype == torch.int16:
                    tensor = tensor.float().div_(2**15)
                elif tensor.dtype == torch.int32:
                    tensor = tensor.float().div_(2**31)
                else:
                    tensor = tensor.float()
                frames.append(tensor)
    except Exception as exc:
        raise RuntimeError(f"从 VIDEO 源文件提取音频失败：{exc}") from exc

    if sample_rate <= 0 or not frames:
        raise ValueError("输入 VIDEO 的音频轨道为空或采样率无效。")

    waveform = torch.cat(frames, dim=1).unsqueeze(0).contiguous()
    get_trim = getattr(video, "get_active_trim_window", None)
    if callable(get_trim):
        try:
            start_seconds, duration_seconds = get_trim()
            start_sample = max(0, int(round(float(start_seconds) * sample_rate)))
            end_sample = int(waveform.shape[-1])
            if float(duration_seconds) > 0:
                end_sample = min(end_sample, start_sample + int(round(float(duration_seconds) * sample_rate)))
            waveform = waveform[..., start_sample:end_sample].contiguous()
        except Exception:
            pass
    return {"waveform": waveform, "sample_rate": sample_rate}


def _coerce_audio_input(value: Any) -> Any:
    if isinstance(value, dict):
        if value.get("waveform") is not None and value.get("sample_rate") is not None:
            return value
        nested_audio = value.get("audio")
        if nested_audio is not None and nested_audio is not value:
            return _coerce_audio_input(nested_audio)

    if callable(getattr(value, "get_stream_source", None)):
        return _decode_video_source_audio(value)

    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception as exc:
            raise RuntimeError(f"读取 VIDEO 音频组件失败：{exc}") from exc
        nested_audio = _component_value(components, "audio")
        if nested_audio is None:
            raise ValueError("输入 VIDEO 不包含音频轨道。")
        return _coerce_audio_input(nested_audio)

    return value


def _extract_audio(audio: Any) -> Tuple[torch.Tensor, int]:
    audio = _coerce_audio_input(audio)
    if isinstance(audio, dict):
        waveform = audio.get("waveform")
        sample_rate = audio.get("sample_rate")
    elif isinstance(audio, (list, tuple)) and len(audio) >= 2:
        waveform, sample_rate = audio[0], audio[1]
    else:
        raise TypeError("输入必须是 ComfyUI AUDIO 或包含音轨的 VIDEO 数据。")

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


def _fmt_srt_time(seconds: float) -> str:
    total_ms = max(0, int(round(float(seconds) * 1000.0)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


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


def _cluster_turns_lightweight(
    mono: torch.Tensor,
    sample_rate: int,
    turns: List[Dict[str, Any]],
    speaker_count: int,
) -> Tuple[List[Dict[str, Any]], int]:
    if not turns:
        return [], 0
    k = max(1, min(int(speaker_count), len(turns)))
    if k == 1:
        for turn in turns:
            turn["speaker_index"] = 1
            turn["speaker"] = "SPEAKER_01"
        return turns, 1

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
    return turns, len(first_seen)


def _campplus_chunks(
    mono_16k: torch.Tensor,
    turns: List[Dict[str, Any]],
    source_sample_rate: int,
    window_seconds: float = 1.5,
    shift_seconds: float = 0.75,
) -> Tuple[List[torch.Tensor], List[Tuple[int, int]]]:
    target_rate = 16000
    window = int(round(window_seconds * target_rate))
    shift = int(round(shift_seconds * target_rate))
    clips: List[torch.Tensor] = []
    source_ranges: List[Tuple[int, int]] = []
    source_total = int(round(int(mono_16k.numel()) * source_sample_rate / target_rate))

    for turn in turns:
        source_start = max(0, int(turn["start_sample"]))
        source_end = min(source_total, max(source_start + 1, int(turn["end_sample"])))
        start_16k = int(round(source_start * target_rate / source_sample_rate))
        end_16k = int(round(source_end * target_rate / source_sample_rate))
        starts = list(range(start_16k, max(start_16k + 1, end_16k - window + 1), shift))
        final_start = max(start_16k, end_16k - window)
        if not starts or starts[-1] != final_start:
            starts.append(final_start)
        for chunk_start in starts:
            chunk_end = min(end_16k, chunk_start + window)
            clip = mono_16k[chunk_start:chunk_end].float()
            if int(clip.numel()) < window:
                clip = torch.nn.functional.pad(clip, (0, window - int(clip.numel())))
            clips.append(clip.contiguous())
            mapped_start = max(source_start, int(round(chunk_start * source_sample_rate / target_rate)))
            mapped_end = min(source_end, int(round(chunk_end * source_sample_rate / target_rate)))
            source_ranges.append((mapped_start, max(mapped_start + 1, mapped_end)))
    return clips, source_ranges


def _campplus_embeddings(
    mono: torch.Tensor,
    sample_rate: int,
    turns: List[Dict[str, Any]],
    model_name: str,
    device_name: str,
) -> Tuple[torch.Tensor, List[Tuple[int, int]]]:
    import torchaudio
    import torchaudio.compliance.kaldi as kaldi

    mono_16k = mono.float()
    if int(sample_rate) != 16000:
        mono_16k = torchaudio.functional.resample(mono_16k, int(sample_rate), 16000)
    clips, source_ranges = _campplus_chunks(mono_16k, turns, int(sample_rate))
    if not clips:
        raise RuntimeError("CAM++ 没有获得可分析的语音片段。")

    features = []
    for clip in clips:
        feature = kaldi.fbank(clip.unsqueeze(0), num_mel_bins=80)
        feature = feature - feature.mean(dim=0, keepdim=True)
        features.append(feature)
    batch = torch.nn.utils.rnn.pad_sequence(features, batch_first=True)
    model = _load_campplus_model(model_name, device_name)
    device = next(model.parameters()).device
    outputs: List[torch.Tensor] = []
    with torch.inference_mode():
        for start in range(0, int(batch.shape[0]), 16):
            embedding = model(batch[start:start + 16].to(device=device, dtype=torch.float32))
            outputs.append(embedding.detach().float().cpu())
    embeddings = torch.cat(outputs, dim=0)
    embeddings = torch.nn.functional.normalize(embeddings, dim=1)
    return embeddings, source_ranges


def _labels_to_turns(
    labels: List[int],
    ranges: List[Tuple[int, int]],
) -> Tuple[List[Dict[str, Any]], int]:
    if not labels or not ranges:
        return [], 0
    stable_ids: Dict[int, int] = {}
    normalized: List[int] = []
    for label in labels:
        if int(label) not in stable_ids:
            stable_ids[int(label)] = len(stable_ids) + 1
        normalized.append(stable_ids[int(label)])

    segments: List[Dict[str, Any]] = []
    for index, ((start, end), speaker_index) in enumerate(zip(ranges, normalized)):
        segment_start = int(start)
        segment_end = int(end)
        if index > 0 and segment_start < int(segments[-1]["end_sample"]):
            boundary = (segment_start + int(segments[-1]["end_sample"])) // 2
            segments[-1]["end_sample"] = max(int(segments[-1]["start_sample"]) + 1, boundary)
            segment_start = boundary
        if segment_end <= segment_start:
            continue
        if (
            segments
            and int(segments[-1]["speaker_index"]) == int(speaker_index)
            and segment_start <= int(segments[-1]["end_sample"]) + 1
        ):
            segments[-1]["end_sample"] = max(int(segments[-1]["end_sample"]), segment_end)
        else:
            segments.append(
                {
                    "start_sample": segment_start,
                    "end_sample": segment_end,
                    "speaker_index": int(speaker_index),
                    "speaker": f"SPEAKER_{int(speaker_index):02d}",
                }
            )
    return segments, len(stable_ids)


def _cluster_turns_campplus(
    mono: torch.Tensor,
    sample_rate: int,
    turns: List[Dict[str, Any]],
    speaker_count: int,
    auto_speaker_count: bool,
    max_speaker_count: int,
    model_name: str,
    device_name: str,
) -> Tuple[List[Dict[str, Any]], int]:
    import numpy as np
    from sklearn.cluster import SpectralClustering
    from sklearn.metrics import silhouette_score

    embeddings, ranges = _campplus_embeddings(mono, sample_rate, turns, model_name, device_name)
    count = int(embeddings.shape[0])
    if count <= 1:
        labels = np.zeros(count, dtype=np.int64)
    elif auto_speaker_count:
        values = embeddings.numpy()
        upper = max(2, min(int(max_speaker_count), count - 1))
        lower = max(2, min(int(speaker_count), upper))
        best_score = float("-inf")
        best_labels = np.zeros(count, dtype=np.int64)
        for candidate_count in range(lower, upper + 1):
            candidate_labels = SpectralClustering(
                n_clusters=candidate_count,
                affinity="nearest_neighbors",
                n_neighbors=min(10, count - 1),
                assign_labels="cluster_qr",
                random_state=0,
            ).fit_predict(values)
            score = float(silhouette_score(values, candidate_labels, metric="cosine"))
            adjusted_score = score - 0.015 * float(candidate_count - 2)
            if adjusted_score > best_score:
                best_score = adjusted_score
                best_labels = candidate_labels
        labels = best_labels
    else:
        requested = max(1, min(int(speaker_count), count))
        labels = (
            np.zeros(count, dtype=np.int64)
            if requested == 1
            else SpectralClustering(
                n_clusters=requested,
                affinity="nearest_neighbors",
                n_neighbors=min(10, count - 1),
                assign_labels="cluster_qr",
                random_state=0,
            ).fit_predict(embeddings.numpy())
        )
    return _labels_to_turns([int(value) for value in labels.tolist()], ranges)


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


def _turns_from_whisper_segments(
    segments: List[Dict[str, Any]],
    sample_rate: int,
    total_samples: int,
) -> List[Dict[str, Any]]:
    """Use recognized speech boundaries as diarization units.

    Empty segments are deliberately excluded: music, isolated laughter and other
    foreground events must not be counted as speakers merely because they are loud.
    """
    turns: List[Dict[str, Any]] = []
    for segment in segments:
        if not str(segment.get("text") or "").strip():
            continue
        start = max(0, min(total_samples, int(round(float(segment["start"]) * sample_rate))))
        end = max(start + 1, min(total_samples, int(round(float(segment["end"]) * sample_rate))))
        if end > start:
            turns.append({"start_sample": start, "end_sample": end})
    return turns


def _internal_whisper_segments(
    mono: torch.Tensor,
    sample_rate: int,
    model_name: str,
    device_name: str,
) -> List[Dict[str, Any]]:
    from faster_whisper import WhisperModel

    model_root = Path(folder_paths.models_dir) / "faster-whisper" / str(model_name)
    if not (model_root / "model.bin").is_file():
        raise RuntimeError(
            f"自动精确分段需要本地 Faster-Whisper 模型：{model_root}。"
            "也可以把 GJJ Faster Whisper 的 WHISPER_OUTPUT 接到“识别时间戳”。"
        )

    device = _resolve_model_device(device_name)
    compute_type = "float16" if device == "cuda" else "int8"
    cache_key = (str(model_root), device, compute_type)
    model = _WHISPER_CACHE.get(cache_key)
    if model is None:
        try:
            model = WhisperModel(str(model_root), device=device, compute_type=compute_type)
        except Exception:
            if device == "cpu":
                raise
            device, compute_type = "cpu", "int8"
            cache_key = (str(model_root), device, compute_type)
            model = _WHISPER_CACHE.get(cache_key)
            if model is None:
                model = WhisperModel(str(model_root), device=device, compute_type=compute_type)
        _WHISPER_CACHE[cache_key] = model

    audio_np = mono.detach().float().cpu().numpy()
    if int(sample_rate) != 16000:
        import torchaudio
        audio_np = torchaudio.functional.resample(mono.float(), int(sample_rate), 16000).cpu().numpy()
    def transcribe(whisper_model: Any) -> List[Dict[str, Any]]:
        generated, _ = whisper_model.transcribe(
            audio_np,
            language="zh",
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        return [
            {"start": float(item.start), "end": float(item.end), "text": str(item.text or "").strip()}
            for item in generated
            if str(item.text or "").strip() and float(item.end) > float(item.start)
        ]

    try:
        return transcribe(model)
    except RuntimeError as exc:
        if device == "cpu" or not any(token in str(exc).lower() for token in ("cuda", "cublas", "cudnn")):
            raise
        cpu_key = (str(model_root), "cpu", "int8")
        cpu_model = _WHISPER_CACHE.get(cpu_key)
        if cpu_model is None:
            cpu_model = WhisperModel(str(model_root), device="cpu", compute_type="int8")
            _WHISPER_CACHE[cpu_key] = cpu_model
        return transcribe(cpu_model)


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


def _format_srt(entries: List[Dict[str, Any]]) -> str:
    blocks: List[str] = []
    for index, entry in enumerate(entries, start=1):
        start = max(0.0, float(entry.get("start") or 0.0))
        end = max(start + 0.001, float(entry.get("end") or start))
        speaker = str(entry.get("speaker") or "UNKNOWN")
        text = str(entry.get("text") or "").strip()
        subtitle = f"[{speaker}] {text}".rstrip()
        blocks.append(
            f"{index}\n"
            f"{_fmt_srt_time(start)} --> {_fmt_srt_time(end)}\n"
            f"{subtitle}"
        )
    return "\n\n".join(blocks)


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
    CATEGORY = "GJJ/🎵 音频"
    FUNCTION = "isolate"
    RETURN_TYPES = ("AUDIO", "STRING", "STRING", "INT", "STRING")
    RETURN_NAMES = (
        "选中说话人音频",
        "说话人文本",
        "说话人JSON",
        "说话人数",
        "SRT字幕",
    )
    OUTPUT_TOOLTIPS = (
        "仅拼接“选择说话人”编号对应的语音片段，不保留源音频中的静音占位。",
        "说话人时间线及可选识别文本。",
        "包含识别模式、人数与时间段的结构化结果。",
        "模型最终识别到的说话人数。",
        "标准 SRT 字幕；接入识别时间戳时包含说话人和文字，否则输出说话人时间轴。",
    )
    DESCRIPTION = (
        "说话人分段/隔离节点：支持 ERes2NetV2/CAM++ 声纹模型自动估算说话人数，也保留零模型轻量算法。"
        "输入兼容 AUDIO 和 VIDEO；VIDEO 会自动提取其内置音轨。"
        "可选接入 WHISPER_OUTPUT，将已有识别文本按时间戳对齐到估算的说话人片段。"
    )
    GJJ_HELP = {
        "功能": [
            "输入兼容 AUDIO 和 VIDEO；接入 VIDEO 时会自动读取其音频轨道。",
            "模型自动人数模式使用声纹向量、谱聚类和轮廓系数估算人数，无需 Token。",
            "ERes2NetV2 效果优先，CAM++ 速度和体积优先。",
            "轻量算法模式不加载模型，可作为兼容回退。",
            "speaker_index 从 1 开始：1 表示 SPEAKER_01，2 表示 SPEAKER_02。",
            "接入 WHISPER_OUTPUT 后会输出带说话人的文本；不接入时输出时间段清单。",
        ],
        "限制": [
            "当前输出按说话时间段屏蔽或拼接，不会分离两人同时说话的重叠声源。",
            "背景音乐很强或音质很差时，建议先做降噪/人声增强。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": (
                    "AUDIO,VIDEO",
                    {
                        "display_name": "音频/视频",
                        "tooltip": "支持 AUDIO 或 VIDEO；输入 VIDEO 时自动提取其内置音频轨道。",
                    },
                ),
                "speaker_count": (
                    "INT",
                    {
                        "default": 2,
                        "min": 1,
                        "max": 8,
                        "step": 1,
                        "display_name": "说话人数/下限",
                        "tooltip": "模型自动人数时作为最少人数；模型指定人数或轻量算法时作为精确人数。",
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
                "diarization_mode": (
                    ["模型自动人数", "模型指定人数", "轻量算法"],
                    {
                        "default": "模型自动人数",
                        "display_name": "识别模式",
                        "tooltip": "自动人数使用声纹模型和自动聚类；指定人数使用上方说话人数；轻量算法不加载模型。",
                    },
                ),
                "campplus_model": (
                    _campplus_model_names(),
                    {
                        "default": (
                            "eres2netv2_zh_16k.safetensors"
                            if "eres2netv2_zh_16k.safetensors" in _campplus_model_names()
                            else NO_CAMPPLUS_MODEL
                        ),
                        "display_name": "说话人声纹模型",
                        "tooltip": "模型目录：ComfyUI/models/speaker_models，支持 ERes2NetV2、CAM++ 及 safetensors。",
                    },
                ),
                "model_device": (
                    ["自动", "CUDA", "CPU"],
                    {
                        "default": "自动",
                        "display_name": "模型设备",
                        "tooltip": "自动优先使用 CUDA；显存不足时可选择 CPU。",
                    },
                ),
                "max_speaker_count": (
                    "INT",
                    {
                        "default": 8,
                        "min": 1,
                        "max": 15,
                        "step": 1,
                        "display_name": "自动人数上限",
                        "tooltip": "自动聚类估算时允许的最大说话人数。",
                    },
                ),
                "speech_segmentation": (
                    ["自动精确分段（large-v3）", "仅使用外接时间戳", "仅能量分段（旧版）"],
                    {
                        "default": "自动精确分段（large-v3）",
                        "display_name": "语音分段方式",
                        "tooltip": "推荐自动精确分段：用本地 Faster-Whisper 排除纯笑声/音乐并提供句级边界；外接时间戳时会优先复用。",
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
        diarization_mode="模型自动人数",
        campplus_model="eres2netv2_zh_16k.safetensors",
        model_device="自动",
        max_speaker_count=8,
        speech_segmentation="自动精确分段（large-v3）",
    ):
        waveform, sample_rate = _extract_audio(audio)
        mono = _mono(waveform)
        whisper_segments = _parse_whisper_segments(whisper_output)
        segmentation = str(speech_segmentation or "自动精确分段（large-v3）")
        if not whisper_segments and segmentation.startswith("自动精确分段"):
            whisper_segments = _internal_whisper_segments(mono, sample_rate, "large-v3", model_device)

        turns = _turns_from_whisper_segments(
            whisper_segments,
            sample_rate,
            int(mono.numel()),
        )
        if not turns:
            if segmentation == "仅使用外接时间戳":
                raise RuntimeError("已选择“仅使用外接时间戳”，但没有接入有效的 WHISPER_OUTPUT。")
            turns = _detect_speech_turns(mono, sample_rate, silence_thresh_db, min_segment_s, merge_gap_s)
        if not turns:
            empty = torch.zeros_like(waveform)
            return (
                _audio_like(empty[..., :1], sample_rate),
                "",
                "[]",
                0,
                "",
            )

        mode = str(diarization_mode or "模型自动人数")
        if mode.startswith("模型") or mode.startswith("CAM++"):
            turns, detected_speaker_count = _cluster_turns_campplus(
                mono,
                sample_rate,
                turns,
                speaker_count,
                mode in {"模型自动人数", "CAM++ 自动人数"},
                max_speaker_count,
                campplus_model,
                model_device,
            )
        else:
            turns, detected_speaker_count = _cluster_turns_lightweight(
                mono,
                sample_rate,
                turns,
                speaker_count,
            )
        turns = _merge_same_speaker(turns, sample_rate, merge_gap_s) if merge_consecutive_speaker else turns

        max_speaker = max(int(turn.get("speaker_index") or 1) for turn in turns)
        picked_speaker = max(1, min(int(speaker_index), max(1, max_speaker)))
        _, concat = _isolate_audio(waveform, turns, picked_speaker)

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
            "speaker_count": int(detected_speaker_count),
            "selected_speaker_index": int(picked_speaker),
            "diarization_mode": mode,
            "speaker_model": str(campplus_model) if mode != "轻量算法" else "",
            "speech_segmentation": segmentation,
            "turns": turn_payload,
            "entries": entries,
        }
        return (
            _audio_like(concat, sample_rate),
            _format_entries(entries),
            json.dumps(payload, ensure_ascii=False, indent=2),
            int(detected_speaker_count),
            _format_srt(entries),
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SpeakerIsolation}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🗣️ 说话人隔离（零依赖）"}
