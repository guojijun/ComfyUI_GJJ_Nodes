from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
import wave
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    from .common_utils.dependency_checker import raise_dependency_model_error
except ImportError:
    from common_utils.dependency_checker import raise_dependency_model_error


NODE_NAME = "GJJ_AudioSmartSegmenter"
DISPLAY_NAME = "GJJ · ✂️ 音频智能分段"
MODE_SILENCE = "静音分段"
MODE_PARAGRAPH = "文本段落"
ALIGN_COMPAT = "最大兼容(按比例)"
ALIGN_WHISPER = "Whisper对齐(可选)"
MODEL_ROOT_NAME = "faster-whisper"
DEFAULT_FASTER_WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v3"]
_CACHE: dict[str, dict[str, Any]] = {}
_CACHE_ORDER: list[str] = []
_CACHE_MAX = 12


def _normalize_audio(audio: Any) -> dict[str, Any] | None:
    if not isinstance(audio, dict) or "waveform" not in audio or "sample_rate" not in audio:
        return None
    waveform = audio["waveform"]
    if not isinstance(waveform, torch.Tensor):
        waveform = torch.as_tensor(waveform)
    waveform = waveform.detach().float().cpu()
    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0).unsqueeze(0)
    elif waveform.ndim == 2:
        waveform = waveform.unsqueeze(0)
    elif waveform.ndim > 3:
        waveform = waveform.reshape(-1, waveform.shape[-2], waveform.shape[-1])
    if waveform.numel() == 0:
        return None
    waveform = torch.nan_to_num(waveform, nan=0.0, posinf=0.0, neginf=0.0).clamp(-1.0, 1.0)
    return {"waveform": waveform.contiguous(), "sample_rate": int(audio["sample_rate"])}


def _load_audio_from_video_like(media: Any) -> dict[str, Any] | None:
    if hasattr(media, "get_components"):
        try:
            components = media.get_components()
            audio = getattr(components, "audio", None)
            if audio is None and isinstance(components, dict):
                audio = components.get("audio")
            audio = _normalize_audio(audio)
            if audio is not None:
                return audio
        except Exception:
            pass

    stream_source = None
    if hasattr(media, "get_stream_source"):
        try:
            stream_source = media.get_stream_source()
        except Exception:
            stream_source = None
    if stream_source is None:
        for name in ("path", "filepath", "file_path", "filename", "video_path", "source", "src", "full_path", "abs_path"):
            try:
                value = getattr(media, name, None)
                if callable(value):
                    value = value()
                if value:
                    stream_source = value
                    break
            except Exception:
                pass
    if stream_source is None and isinstance(media, (str, os.PathLike)):
        stream_source = os.fspath(media)
    if stream_source is None:
        return None
    return _load_audio_file(stream_source)


def _resolve_media_path(path_value: Any) -> str | None:
    text = str(path_value or "").strip().strip('"')
    if not text:
        return None
    candidates = [text]
    if folder_paths is not None:
        try:
            if folder_paths.exists_annotated_filepath(text):
                return folder_paths.get_annotated_filepath(text)
        except Exception:
            pass
        try:
            annotated = folder_paths.get_annotated_filepath(text)
            if annotated:
                candidates.append(annotated)
        except Exception:
            pass
        try:
            input_dir = folder_paths.get_input_directory()
            candidates.append(os.path.join(input_dir, text))
        except Exception:
            pass
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return os.path.abspath(candidate)
    return text


def _load_audio_file(path_value: Any) -> dict[str, Any] | None:
    path = _resolve_media_path(path_value)
    if not path:
        return None
    try:
        from comfy_extras.nodes_audio import load as comfy_load_audio

        waveform, sample_rate = comfy_load_audio(path)
        return _normalize_audio({"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate})
    except Exception as exc:
        raise RuntimeError(
            "无法读取音频/视频文件的声音轨道。请确认文件存在，或 ComfyUI 的音频解码依赖可用。\n"
            f"文件：{path}\n底层错误：{exc}"
        ) from exc


def _extract_audio(media: Any, media_path: str) -> tuple[dict[str, Any], str]:
    audio = _normalize_audio(media)
    if audio is not None:
        return audio, "外部 AUDIO"
    if media is not None:
        audio = _load_audio_from_video_like(media)
        if audio is not None:
            return audio, "外部 VIDEO 音轨"
    audio = _load_audio_file(media_path)
    if audio is not None:
        return audio, f"内部文件：{Path(str(media_path)).name}"
    raise RuntimeError("请连接 AUDIO/VIDEO，或在“音视频文件路径”填写可读取的音频/视频文件。")


def _audio_signature(audio: dict[str, Any], source: str, media_path: str) -> str:
    waveform = audio["waveform"].detach().contiguous().cpu()
    h = hashlib.blake2b(digest_size=16)
    h.update(str(tuple(waveform.shape)).encode("utf-8"))
    h.update(str(waveform.dtype).encode("utf-8"))
    h.update(str(int(audio["sample_rate"])).encode("utf-8"))
    h.update(waveform.numpy().tobytes())
    if media_path:
        path = _resolve_media_path(media_path)
        h.update(str(path).encode("utf-8"))
        try:
            st = os.stat(path)
            h.update(str((st.st_size, st.st_mtime_ns)).encode("utf-8"))
        except Exception:
            pass
    h.update(str(source).encode("utf-8"))
    return h.hexdigest()


def _clone_audio(audio: dict[str, Any]) -> dict[str, Any]:
    return {"waveform": audio["waveform"].detach().cpu().clone(), "sample_rate": int(audio["sample_rate"])}


def _slice_audio(audio: dict[str, Any], start: int, end: int) -> dict[str, Any]:
    waveform = audio["waveform"]
    total = waveform.shape[-1]
    start = max(0, min(int(start), total))
    end = max(start + 1, min(int(end), total))
    return {"waveform": waveform[..., start:end].contiguous().clone(), "sample_rate": int(audio["sample_rate"])}


def _empty_audio(sample_rate: int = 44100) -> dict[str, Any]:
    return {"waveform": torch.zeros((1, 1, 1), dtype=torch.float32), "sample_rate": int(sample_rate)}


def _format_srt_time(seconds: float) -> str:
    millis = max(0, int(round(float(seconds) * 1000.0)))
    ss, ms = divmod(millis, 1000)
    mm, ss = divmod(ss, 60)
    hh, mm = divmod(mm, 60)
    return f"{hh:02d}:{mm:02d}:{ss:02d},{ms:03d}"


def _segments_to_srt(segments: list[dict[str, Any]]) -> str:
    blocks = []
    for index, segment in enumerate(segments, start=1):
        text = str(segment.get("text") or f"片段 {index}")
        start = _format_srt_time(float(segment["start"]))
        end = _format_srt_time(float(segment["end"]))
        blocks.append(f"{index}\n{start} --> {end}\n{text}\n")
    return "\n".join(blocks)


def _faster_whisper_root() -> str:
    if folder_paths is not None:
        root = os.path.join(folder_paths.models_dir, MODEL_ROOT_NAME)
    else:
        root = os.path.abspath(os.path.join(os.getcwd(), "models", MODEL_ROOT_NAME))
    os.makedirs(root, exist_ok=True)
    return root


def _is_faster_whisper_model_dir(path: str) -> bool:
    if not os.path.isdir(path):
        return False
    try:
        names = set(os.listdir(path))
    except OSError:
        return False
    return "config.json" in names or any(name.endswith((".bin", ".safetensors")) for name in names)


def _list_faster_whisper_models() -> list[str]:
    root = _faster_whisper_root()
    found: list[str] = []
    for current, _, _ in os.walk(root):
        if current == root or not _is_faster_whisper_model_dir(current):
            continue
        found.append(os.path.relpath(current, root).replace("/", "\\"))
    return found + [name for name in DEFAULT_FASTER_WHISPER_MODELS if name not in found]


def _resolve_faster_whisper_model(model_name: str, unique_id=None) -> str:
    requested = str(model_name or "base").strip() or "base"
    root = _faster_whisper_root()
    candidates = []
    if os.path.isabs(requested):
        candidates.append(requested)
    candidates.append(os.path.join(root, requested))
    for current in candidates:
        if _is_faster_whisper_model_dir(current):
            return current

    requested_lower = requested.lower()
    for current, _, _ in os.walk(root):
        if current == root or not _is_faster_whisper_model_dir(current):
            continue
        rel = os.path.relpath(current, root).replace("/", "\\")
        if rel.lower() == requested_lower or os.path.basename(rel).lower() == requested_lower:
            return current

    raise_dependency_model_error(
        node_name=DISPLAY_NAME,
        missing_models=[{
            "label": requested,
            "subdir": MODEL_ROOT_NAME,
            "filename": requested,
            "description": f"Whisper 对齐使用 faster-whisper 本地模型目录，请放到 models/{MODEL_ROOT_NAME}/ 下。",
        }],
        description=f"未找到 Faster Whisper 模型：models/{MODEL_ROOT_NAME}/{requested}",
        unique_id=unique_id,
        title="GJJ 节点模型缺失！",
        copy_text="https://huggingface.co/Systran",
        copy_label="🌏 复制模型下载页",
    )


def _audio_to_mono_numpy(audio: dict[str, Any]):
    waveform = audio["waveform"].detach().float().cpu()
    if waveform.ndim == 3:
        waveform = waveform[0]
    if waveform.ndim == 2:
        waveform = waveform.mean(dim=0)
    return waveform.flatten().contiguous().numpy()


def _resample_audio(audio: dict[str, Any], target_rate: int) -> dict[str, Any]:
    sample_rate = int(audio["sample_rate"])
    target_rate = int(target_rate or sample_rate)
    if target_rate <= 0 or target_rate == sample_rate:
        return audio
    waveform = audio["waveform"]
    total = max(1, int(round(waveform.shape[-1] * target_rate / sample_rate)))
    flat = waveform.reshape(-1, 1, waveform.shape[-1])
    resampled = F.interpolate(flat, size=total, mode="linear", align_corners=False)
    return {"waveform": resampled.reshape(waveform.shape[0], waveform.shape[1], total).contiguous(), "sample_rate": target_rate}


def _silence_segments(
    audio: dict[str, Any],
    max_length_s: float,
    silence_thresh_db: float,
    min_silence_ms: int,
    keep_silence_ms: int,
) -> list[dict[str, Any]]:
    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    mono = waveform[0].mean(dim=0)
    total = int(mono.numel())
    if total <= 1:
        return [{"start": 0.0, "end": 1.0 / sample_rate, "start_sample": 0, "end_sample": 1, "text": "片段 1"}]

    frame = max(1, int(sample_rate * 0.02))
    hop = frame
    threshold = 10.0 ** (float(silence_thresh_db) / 20.0)
    min_silence_frames = max(1, int(round(int(min_silence_ms) / 20.0)))
    keep = int(sample_rate * max(0, int(keep_silence_ms)) / 1000.0)
    active = []
    for start in range(0, total, hop):
        chunk = mono[start:min(start + frame, total)]
        rms = float(torch.sqrt(torch.mean(chunk * chunk) + 1e-12))
        active.append(rms > threshold)

    ranges = []
    start_frame = None
    silent_run = 0
    for frame_index, is_active in enumerate(active):
        if is_active:
            if start_frame is None:
                start_frame = frame_index
            silent_run = 0
        else:
            if start_frame is not None:
                silent_run += 1
                if silent_run >= min_silence_frames:
                    end_frame = frame_index - silent_run + 1
                    ranges.append((start_frame * hop, min(total, end_frame * hop)))
                    start_frame = None
                    silent_run = 0
    if start_frame is not None:
        ranges.append((start_frame * hop, total))
    if not ranges:
        ranges = [(0, total)]

    kept = []
    for start, end in ranges:
        kept.append((max(0, start - keep), min(total, end + keep)))
    merged = []
    max_len = max(1, int(float(max_length_s) * sample_rate))
    current_start = None
    current_end = None
    for start, end in kept:
        if current_start is None:
            current_start, current_end = start, end
            continue
        if end - current_start <= max_len:
            current_end = end
        else:
            merged.append((current_start, current_end))
            current_start, current_end = start, end
    if current_start is not None:
        merged.append((current_start, current_end))

    final = []
    for start, end in merged:
        if end - start > max_len:
            for pos in range(start, end, max_len):
                final.append((pos, min(end, pos + max_len)))
        else:
            final.append((start, end))
    return [
        {
            "start": start / sample_rate,
            "end": end / sample_rate,
            "start_sample": int(start),
            "end_sample": int(end),
            "text": f"片段 {idx}",
        }
        for idx, (start, end) in enumerate(final, start=1)
        if end > start
    ] or [{"start": 0.0, "end": total / sample_rate, "start_sample": 0, "end_sample": total, "text": "片段 1"}]


def _paragraphs(text: str) -> list[str]:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    return lines or ["片段 1"]


def _paragraph_segments(audio: dict[str, Any], text: str) -> list[dict[str, Any]]:
    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    total = int(waveform.shape[-1])
    paragraphs = _paragraphs(text)
    weights = [max(1, len(re.sub(r"\s+", "", item))) for item in paragraphs]
    total_weight = sum(weights)
    cursor = 0
    segments = []
    for idx, (para, weight) in enumerate(zip(paragraphs, weights), start=1):
        if idx == len(paragraphs):
            end = total
        else:
            end = int(round(total * sum(weights[:idx]) / total_weight))
        end = max(cursor + 1, min(end, total))
        segments.append({
            "start": cursor / sample_rate,
            "end": end / sample_rate,
            "start_sample": int(cursor),
            "end_sample": int(end),
            "text": para,
        })
        cursor = end
    return segments


def _normalize_text_for_align(text: str) -> str:
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]+", "", str(text or "")).lower()


def _write_temp_wav(audio: dict[str, Any]) -> str:
    waveform = audio["waveform"][0].detach().float().cpu().clamp(-1.0, 1.0)
    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0)
    samples = (waveform.transpose(0, 1).numpy() * 32767.0).astype("<i2")
    handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    handle.close()
    with wave.open(handle.name, "wb") as wav:
        wav.setnchannels(int(waveform.shape[0]))
        wav.setsampwidth(2)
        wav.setframerate(int(audio["sample_rate"]))
        wav.writeframes(samples.tobytes())
    return handle.name


def _align_paragraphs_to_words(paragraphs: list[str], words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not paragraphs or not words:
        return []
    normalized_words = []
    cursor = 0
    for word in words:
        text = _normalize_text_for_align(word.get("word") or word.get("text") or "")
        if not text:
            continue
        start = cursor
        cursor += len(text)
        normalized_words.append((start, cursor, word))
    full_text = "".join(_normalize_text_for_align(word.get("word") or word.get("text") or "") for _s, _e, word in normalized_words)
    if not full_text:
        return []

    aligned = []
    search_start = 0
    import difflib

    for para in paragraphs:
        normalized_para = _normalize_text_for_align(para)
        if not normalized_para:
            continue
        search_space = full_text[search_start:]
        matcher = difflib.SequenceMatcher(None, search_space, normalized_para, autojunk=False)
        blocks = [block for block in matcher.get_matching_blocks() if block.size > 0]
        if not blocks:
            continue
        match_size = sum(block.size for block in blocks)
        if match_size / max(1, len(normalized_para)) < 0.45:
            continue
        start_char = search_start + blocks[0].a
        end_char = search_start + blocks[-1].a + blocks[-1].size
        selected_words = [word for start, end, word in normalized_words if end > start_char and start < end_char]
        if not selected_words:
            continue
        start_time = float(selected_words[0].get("start") or 0.0)
        end_time = float(selected_words[-1].get("end") or start_time)
        if end_time <= start_time:
            continue
        aligned.append({"text": para, "start": start_time, "end": end_time})
        search_start = max(search_start, end_char)
    return aligned


def _paragraph_segments_whisper(audio: dict[str, Any], text: str, whisper_model: str, unique_id=None) -> list[dict[str, Any]]:
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        raise_dependency_model_error(
            node_name=DISPLAY_NAME,
            missing_dependencies=[{
                "module_name": "faster_whisper",
                "package_name": "faster-whisper",
                "display_name": "faster-whisper",
                "description": "仅在选择 Whisper 对齐时需要，用于按词时间戳对齐段落。",
            }],
            install_packages=["faster-whisper"],
            description="当前选择了 Whisper 段落对齐，但运行环境没有安装 faster-whisper。可切回“最大兼容(按比例)”免依赖运行。",
            original_error=str(exc),
            unique_id=unique_id,
        )
    model_path = _resolve_faster_whisper_model(whisper_model, unique_id=unique_id)
    waveform_np = _audio_to_mono_numpy(audio)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    try:
        model = WhisperModel(model_path, device=device, compute_type=compute_type)
        result_segments, _info = model.transcribe(waveform_np, word_timestamps=True, vad_filter=False)
    except Exception as exc:
        message = str(exc).lower()
        if device != "cpu" and ("cuda" in message or "cublas" in message or "cudnn" in message):
            model = WhisperModel(model_path, device="cpu", compute_type="int8")
            result_segments, _info = model.transcribe(waveform_np, word_timestamps=True, vad_filter=False)
        else:
            raise

    words = []
    for segment in result_segments:
        for word in getattr(segment, "words", None) or []:
            words.append({
                "start": float(getattr(word, "start", 0.0) or 0.0),
                "end": float(getattr(word, "end", 0.0) or 0.0),
                "word": str(getattr(word, "word", "") or ""),
            })
    aligned = _align_paragraphs_to_words(_paragraphs(text), words)
    if not aligned:
        return _paragraph_segments(audio, text)
    sample_rate = int(audio["sample_rate"])
    total = int(audio["waveform"].shape[-1])
    segments = []
    for item in aligned:
        start = max(0, min(int(float(item["start"]) * sample_rate), total - 1))
        end = max(start + 1, min(int(float(item["end"]) * sample_rate), total))
        segments.append({
            "start": start / sample_rate,
            "end": end / sample_rate,
            "start_sample": start,
            "end_sample": end,
            "text": item["text"],
        })
    return segments


def _cache_get(key: str) -> dict[str, Any] | None:
    cached = _CACHE.get(key)
    if cached is None:
        return None
    try:
        _CACHE_ORDER.remove(key)
    except ValueError:
        pass
    _CACHE_ORDER.append(key)
    return cached


def _cache_put(key: str, value: dict[str, Any]) -> None:
    _CACHE[key] = value
    try:
        _CACHE_ORDER.remove(key)
    except ValueError:
        pass
    _CACHE_ORDER.append(key)
    while len(_CACHE_ORDER) > _CACHE_MAX:
        old = _CACHE_ORDER.pop(0)
        _CACHE.pop(old, None)


class GJJ_AudioSmartSegmenter:
    CATEGORY = "GJJ/音频"
    FUNCTION = "segment"
    DESCRIPTION = "零依赖音视频智能分段：兼容 AUDIO/VIDEO/文件路径，按静音或文本段落切分，缓存分段结果并按 1 基 index 输出当前片段。"
    SEARCH_ALIASES = ["Audio Segmenter", "AudioSegment", "音频分段", "音频切片", "文本段落分割", "Select Audio From List"]
    RETURN_TYPES = ("AUDIO", "INT", "INT", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("当前音频片段", "片段总数", "当前序号", "当前文本", "SRT字幕", "缓存数据")
    OUTPUT_TOOLTIPS = (
        "按 index 选择的单段 AUDIO。",
        "缓存中的片段总数。",
        "实际输出的 1 基序号。",
        "文本段落模式输出对应段落；静音模式输出片段编号。",
        "全部片段的 SRT 字幕文本。",
        "分段缓存元数据 JSON，可用于检查每段起止时间。",
    )
    GJJ_HELP = {
        "description": "把 Audio Segmenter、按段落分割、列表选择合并为一个 GJJ 零依赖单节点。",
        "usage": [
            "输入可接 AUDIO、VIDEO，也可填写音视频文件路径；VIDEO 会尝试读取声音轨道。",
            "index 从 1 开始；外部接入 index 时，由外部调度。未接入时可用前端“自动运行”从 1 顺序执行。",
            "输入音频内容或切分参数变化时会重建缓存；只改变 index 时复用缓存。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": ([MODE_SILENCE, MODE_PARAGRAPH], {"default": MODE_SILENCE, "display_name": "分隔方式", "tooltip": "静音分段：按静音和最大长度切分；文本段落：按文本行比例切分。", "hidden": True, "display": "hidden"}),
                "index": ("INT", {"default": 1, "min": 1, "max": 100000, "step": 1, "display_name": "当前序号", "tooltip": "1 基片段序号。外接 index 时自动运行会让位给外部调度。"}),
                "media_path": ("STRING", {"default": "", "display_name": "音视频文件路径", "tooltip": "未连接输入时可填写音频或视频文件路径。支持 ComfyUI input 路径或绝对路径。", "hidden": True, "display": "hidden"}),
                "max_length_s": ("FLOAT", {"default": 10.0, "min": 0.2, "max": 3600.0, "step": 0.1, "display_name": "最大长度秒", "tooltip": "静音分段使用：每段尽量不超过该秒数。"}),
                "silence_thresh_db": ("FLOAT", {"default": -40.0, "min": -100.0, "max": 0.0, "step": 0.5, "display_name": "静音阈值dB", "tooltip": "静音分段使用：低于该 dBFS 视为静音。"}),
                "min_silence_ms": ("INT", {"default": 500, "min": 20, "max": 10000, "step": 10, "display_name": "最短静音ms", "tooltip": "静音持续至少这么久才作为切分点。"}),
                "keep_silence_ms": ("INT", {"default": 250, "min": 0, "max": 5000, "step": 10, "display_name": "保留静音ms", "tooltip": "切分后在片段两端保留少量静音。"}),
                "paragraph_text": ("STRING", {"default": "", "multiline": True, "display_name": "段落文本", "tooltip": "文本段落模式使用：每一非空行对应一个输出片段。"}),
                "paragraph_align": ([ALIGN_COMPAT, ALIGN_WHISPER], {"default": ALIGN_COMPAT, "display_name": "段落对齐", "tooltip": "最大兼容不需要额外依赖；Whisper 对齐会尝试按转写词时间戳切分，缺依赖时给出安装提示。", "hidden": True, "display": "hidden"}),
                "whisper_model": (_list_faster_whisper_models(), {"default": "base", "display_name": "Whisper模型", "tooltip": "仅 Whisper 对齐使用。模型目录：models/faster-whisper。"}),
                "target_sample_rate": ("INT", {"default": 0, "min": 0, "max": 192000, "step": 1, "display_name": "目标采样率", "tooltip": "0 表示保持原采样率；其它值会主动转成该采样率，便于兼容下游。"}),
            },
            "optional": {
                "media": ("AUDIO,VIDEO,*", {"display_name": "音频/视频", "tooltip": "可接 AUDIO 或 VIDEO；VIDEO 会自动提取声音轨道。外接输入优先于内部文件路径。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        media = kwargs.get("media")
        media_path = kwargs.get("media_path", "")
        try:
            audio, source = _extract_audio(media, media_path)
            signature = _audio_signature(audio, source, media_path)
        except Exception:
            signature = f"missing:{type(media).__name__}:{media_path}"
        payload = {
            "audio": signature,
            "mode": kwargs.get("mode"),
            "index": kwargs.get("index"),
            "media_path": str(media_path or ""),
            "max_length_s": kwargs.get("max_length_s"),
            "silence_thresh_db": kwargs.get("silence_thresh_db"),
            "min_silence_ms": kwargs.get("min_silence_ms"),
            "keep_silence_ms": kwargs.get("keep_silence_ms"),
            "paragraph_text": kwargs.get("paragraph_text"),
            "paragraph_align": kwargs.get("paragraph_align"),
            "whisper_model": kwargs.get("whisper_model"),
            "target_sample_rate": kwargs.get("target_sample_rate"),
        }
        return json.dumps(payload, ensure_ascii=False, sort_keys=True)

    def segment(
        self,
        media=None,
        mode=MODE_SILENCE,
        index=1,
        media_path="",
        max_length_s=10.0,
        silence_thresh_db=-40.0,
        min_silence_ms=500,
        keep_silence_ms=250,
        paragraph_text="",
        paragraph_align=ALIGN_COMPAT,
        whisper_model="base",
        target_sample_rate=0,
        unique_id=None,
    ):
        audio, source = _extract_audio(media, media_path)
        audio = _resample_audio(audio, int(target_sample_rate or 0))
        signature = _audio_signature(audio, source, media_path)
        params = {
            "mode": mode,
            "max_length_s": float(max_length_s),
            "silence_thresh_db": float(silence_thresh_db),
            "min_silence_ms": int(min_silence_ms),
            "keep_silence_ms": int(keep_silence_ms),
            "paragraph_text": str(paragraph_text or ""),
            "paragraph_align": str(paragraph_align or ALIGN_COMPAT),
            "whisper_model": str(whisper_model or "base"),
            "sample_rate": int(audio["sample_rate"]),
        }
        cache_key = hashlib.blake2b(json.dumps([signature, params], ensure_ascii=False, sort_keys=True).encode("utf-8"), digest_size=16).hexdigest()
        cached = _cache_get(cache_key)
        cache_hit = cached is not None
        if cached is None:
            if mode == MODE_PARAGRAPH:
                if paragraph_align == ALIGN_WHISPER:
                    segments = _paragraph_segments_whisper(audio, paragraph_text, whisper_model, unique_id=unique_id)
                else:
                    segments = _paragraph_segments(audio, paragraph_text)
            else:
                segments = _silence_segments(audio, max_length_s, silence_thresh_db, min_silence_ms, keep_silence_ms)
            srt = _segments_to_srt(segments)
            cached = {"audio": _clone_audio(audio), "segments": segments, "srt": srt, "source": source, "params": params}
            _cache_put(cache_key, cached)

        segments = cached["segments"]
        count = len(segments)
        if count <= 0:
            return (_empty_audio(int(audio["sample_rate"])), 0, 0, "", "", "{}")
        selected = max(1, min(int(index or 1), count))
        segment = segments[selected - 1]
        selected_audio = _slice_audio(cached["audio"], int(segment["start_sample"]), int(segment["end_sample"]))
        cache_json = json.dumps({
            "cache_key": cache_key,
            "cache_hit": cache_hit,
            "source": cached.get("source"),
            "mode": mode,
            "sample_rate": int(cached["audio"]["sample_rate"]),
            "duration": float(cached["audio"]["waveform"].shape[-1]) / float(cached["audio"]["sample_rate"]),
            "count": count,
            "index": selected,
            "segments": [
                {"index": i + 1, "start": item["start"], "end": item["end"], "text": item.get("text", "")}
                for i, item in enumerate(segments)
            ],
        }, ensure_ascii=False, indent=2)
        result = (selected_audio, int(count), int(selected), str(segment.get("text") or ""), str(cached["srt"]), cache_json)
        return {
            "ui": {
                "segment_count": [int(count)],
                "segment_index": [int(selected)],
                "segment_text": [str(segment.get("text") or "")],
                "segment_cache_hit": [bool(cache_hit)],
                "segment_source": [str(cached.get("source") or "")],
            },
            "result": result,
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AudioSmartSegmenter}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: DISPLAY_NAME}
