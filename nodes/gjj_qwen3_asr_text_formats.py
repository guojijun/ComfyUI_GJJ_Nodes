from __future__ import annotations

import json
import os
import re
import time
from typing import Any

import folder_paths
import numpy as np
import torch
from .common_utils.dependency_checker import (
    build_dependency_model_report,
    check_dependencies,
    get_report_from_exception,
    load_dependency_at_runtime,
    make_missing_model_spec,
    raise_dependency_model_error,
    send_dependency_model_notice,
)


NODE_NAME = "GJJ_Qwen3ASRTextFormats"
MODEL_ROOT_NAME = "ASR"

ASR_MODEL_REPOS = {
    "Qwen3-ASR-1.7B": "Qwen/Qwen3-ASR-1.7B",
    "Qwen3-ASR-0.6B": "Qwen/Qwen3-ASR-0.6B",
}
ALIGNER_MODEL_REPOS = {
    "Qwen3-ForcedAligner-0.6B": "Qwen/Qwen3-ForcedAligner-0.6B",
}

ASR_LANGUAGES = [
    "Auto",
    "Chinese",
    "English",
    "Cantonese",
    "Arabic",
    "German",
    "French",
    "Spanish",
    "Portuguese",
    "Indonesian",
    "Italian",
    "Korean",
    "Russian",
    "Thai",
    "Vietnamese",
    "Japanese",
    "Turkish",
    "Hindi",
    "Malay",
    "Dutch",
    "Swedish",
    "Danish",
    "Finnish",
    "Polish",
    "Czech",
    "Filipino",
    "Persian",
    "Greek",
    "Romanian",
    "Hungarian",
    "Macedonian",
]

ALIGN_LANGUAGES = [
    "Chinese",
    "English",
    "Cantonese",
    "French",
    "German",
    "Italian",
    "Japanese",
    "Korean",
    "Portuguese",
    "Russian",
    "Spanish",
]
ALIGN_AUTO = "自动使用转写语言"
PRECISION_OPTIONS = ["自动", "bfloat16", "float16", "float32"]

_ASR_CACHE: dict[tuple[str, str, str, int, int], Any] = {}
_ALIGNER_CACHE: dict[tuple[str, str, str], Any] = {}
NODE_DISPLAY_NAME = "🎤 语音识别四文本TTS(Qwen3)"
MODEL_DOWNLOAD_BASE_URL = "https://pan.quark.cn/s/4b5a36d50e9c"
DEPENDENCY_SPECS = [
    {
        "module_name": "qwen_asr",
        "package_name": "qwen-asr",
        "display_name": "qwen-asr",
        "description": "Qwen3-ASR 主运行库。",
    },
]
def _local_model_tree_text() -> str:
    root = os.path.join(folder_paths.models_dir, MODEL_ROOT_NAME)

    def marker(name: str) -> str:
        return "✅" if _is_model_dir(os.path.join(root, name)) else "⚪"

    return "\n".join([
        "ComfyUI/",
        "└──📁 models/",
        "   └──📁 ASR/",
        f"      ├──{marker('Qwen3-ASR-1.7B')} Qwen3-ASR-1.7B/  （推荐，与 0.6B 二选一）",
        f"      ├──{marker('Qwen3-ASR-0.6B')} Qwen3-ASR-0.6B/  （轻量，与 1.7B 二选一）",
        f"      └──{marker('Qwen3-ForcedAligner-0.6B')} Qwen3-ForcedAligner-0.6B/  （强制对齐）",
    ])


def _collect_dependency_state() -> tuple[bool, list[dict[str, str]]]:
    missing_dependencies: list[dict[str, str]] = []
    for spec in DEPENDENCY_SPECS:
        available, _ = check_dependencies([spec["module_name"]], NODE_DISPLAY_NAME)
        if not available:
            missing_dependencies.append(spec)
    return (not missing_dependencies), missing_dependencies


_DEPENDENCIES_AVAILABLE, _MISSING_DEPENDENCIES = _collect_dependency_state()
_ENV_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_MISSING_DEPENDENCIES,
    missing_models=[],
    install_packages=[spec["package_name"] for spec in _MISSING_DEPENDENCIES],
    description="Qwen3-ASR 一体式语音识别与强制对齐节点，输出时间戳表、分段文本、开始时间和结束时间四种文本。",
)
_HELP_NOTICE = (
    f"{_ENV_REPORT['warning_message']}\n请参考下方依赖、模型说明和安装命令。"
    if not _ENV_REPORT.get("available", True)
    else ""
)
_DESCRIPTION_READY = """
🎤 语音识别四文本TTS(Qwen3)

Qwen3-ASR 一体式语音识别与强制对齐节点。

📁 模型目录：
models/ASR/

🌏模型下载（夸克网盘）：
https://pan.quark.cn/s/4b5a36d50e9c

💡 使用提示：
- 支持 28+ 种语言自动识别
- 内置强制对齐，输出时间戳表、分段文本、开始时间和结束时间
- 支持上下文提示，适合 Wan/LTX 等视频字幕时序场景
""".strip()
DESCRIPTION = (
    _DESCRIPTION_READY
    if _DEPENDENCIES_AVAILABLE
    else f"{_ENV_REPORT['warning_message']}\n\n{_DESCRIPTION_READY}"
)


def _send_error_to_frontend(unique_id: Any, error_message: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync("gjj_qwen3_error", {
            "node": str(unique_id),
            "error": error_message,
        })
    except Exception:
        pass


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload: dict[str, Any] = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = float(progress)
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _new_progress_bar(total: int):
    try:
        import comfy.utils

        return comfy.utils.ProgressBar(total)
    except Exception:
        return None


def _decode_audio_with_av(source_path: str) -> tuple[np.ndarray, int]:
    """使用 PyAV 解码音频文件（支持 WMA 等格式）"""
    import av

    with av.open(source_path) as container:
        if not container.streams.audio:
            raise RuntimeError("文件中没有可解码的音频流。")
        stream = container.streams.audio[0]
        sample_rate = int(stream.codec_context.sample_rate or 0)
        chunks: list[np.ndarray] = []
        for frame in container.decode(stream):
            if not sample_rate:
                sample_rate = int(frame.sample_rate or 0)
            chunk = frame.to_ndarray()
            if chunk.ndim == 1:
                chunk = chunk[:, None]
            elif chunk.shape[0] <= 8:
                chunk = chunk.T
            if chunk.dtype.kind in {"i", "u"}:
                chunk = chunk.astype(np.float32) / float(np.iinfo(chunk.dtype).max)
            else:
                chunk = chunk.astype(np.float32, copy=False)
            chunks.append(chunk)
        if not chunks:
            raise RuntimeError("音频文件没有有效采样。")
        audio_np = np.concatenate(chunks, axis=0)
        return audio_np.astype(np.float32, copy=False), sample_rate


def _read_audio_file(path: str) -> tuple[np.ndarray, int]:
    """读取音频文件，支持多种加载方式，逐级回退"""
    errors = []

    # 方式1: 尝试 soundfile（支持 WAV、FLAC、OGG 等）
    try:
        import soundfile as sf
        audio_np, sample_rate = sf.read(path, always_2d=True)
        if audio_np.size > 0:
            return audio_np.astype(np.float32, copy=False), int(sample_rate)
    except Exception as e:
        errors.append(f"soundfile: {e}")

    # 方式2: 尝试 torchaudio（支持 MP3、WAV 等）
    try:
        import torchaudio
        waveform, sr = torchaudio.load(path)
        audio_np = waveform.numpy()
        # torchaudio 返回 (channels, samples)，需要转为 (samples, channels)
        if audio_np.ndim == 2:
            audio_np = audio_np.T
        else:
            audio_np = audio_np.reshape(-1, 1)
        return audio_np.astype(np.float32, copy=False), int(sr)
    except Exception as e:
        errors.append(f"torchaudio: {e}")

    # 方式3: 尝试 PyAV（通过 FFmpeg 支持几乎所有格式，包括 WMA）
    try:
        audio_np, sample_rate = _decode_audio_with_av(path)
        if audio_np.size > 0:
            return audio_np, sample_rate
    except Exception as e:
        errors.append(f"PyAV: {e}")

    # 方式4: 尝试 librosa（支持多种格式，但速度较慢）
    try:
        import librosa
        audio_np, sr = librosa.load(path, sr=None, mono=False)
        if audio_np.ndim == 1:
            audio_np = audio_np.reshape(-1, 1)
        else:
            audio_np = audio_np.T
        return audio_np.astype(np.float32, copy=False), int(sr)
    except Exception as e:
        errors.append(f"librosa: {e}")

    # 所有方式都失败
    raise RuntimeError(
        f"无法解码音频文件：{path}\n"
        f"尝试的所有方法均失败：\n" + "\n".join(f"  - {err}" for err in errors)
    )


def _update_progress(pbar: Any, current: int, total: int) -> None:
    if pbar is None:
        return
    try:
        pbar.update_absolute(current, total)
    except Exception:
        pass


def _normalize_key(value: str) -> str:
    return (
        str(value or "")
        .lower()
        .replace("\\", "")
        .replace("/", "")
        .replace("_", "")
        .replace("-", "")
        .replace(".", "")
        .replace(" ", "")
    )


def _model_root() -> str:
    root = os.path.join(folder_paths.models_dir, MODEL_ROOT_NAME)
    os.makedirs(root, exist_ok=True)
    return root


def _is_model_dir(path: str) -> bool:
    if not os.path.isdir(path):
        return False
    try:
        names = set(os.listdir(path))
    except OSError:
        return False
    if not names:
        return False
    if {"config.json", "preprocessor_config.json", "tokenizer_config.json"} & names:
        return True
    return any(name.endswith((".safetensors", ".bin", ".json")) for name in names)


def _kind_matches(name: str, kind: str) -> bool:
    normalized = _normalize_key(name)
    if kind == "aligner":
        return "forcedaligner" in normalized or "aligner" in normalized
    return "asr" in normalized and "forcedaligner" not in normalized and "aligner" not in normalized


def _with_known_models(local_names: list[str], repos: dict[str, str]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for name in list(repos.keys()) + local_names:
        if name and name not in seen:
            ordered.append(name)
            seen.add(name)
    return ordered


def _list_local_model_names(kind: str) -> list[str]:
    root = _model_root()
    names: list[str] = []
    for current, _, _ in os.walk(root):
        if current == root or not _is_model_dir(current):
            continue
        rel = os.path.relpath(current, root).replace("/", "\\")
        if _kind_matches(rel, kind):
            names.append(rel)
    return sorted(names, key=lambda item: (item.count("\\"), item.lower()))


def _list_asr_models() -> list[str]:
    return _with_known_models(_list_local_model_names("asr"), ASR_MODEL_REPOS)


def _list_aligner_models() -> list[str]:
    return _with_known_models(_list_local_model_names("aligner"), ALIGNER_MODEL_REPOS)


def _resolve_known_model_name(model_name: str, repos: dict[str, str]) -> str:
    requested = str(model_name or "").strip()
    if requested in repos:
        return requested
    requested_base = os.path.basename(requested)
    for name in repos:
        if requested_base.lower() == name.lower() or _normalize_key(requested) == _normalize_key(name):
            return name
    return next(iter(repos.keys()))


def _find_local_model_dir(model_name: str, kind: str) -> str | None:
    root = _model_root()
    requested = str(model_name or "").strip()
    if requested:
        if os.path.isabs(requested) and _is_model_dir(requested):
            return requested
        direct = os.path.join(root, requested)
        if _is_model_dir(direct):
            return direct

    requested_base = os.path.basename(requested).lower()
    requested_key = _normalize_key(requested)
    best_contains: str | None = None
    for current, _, _ in os.walk(root):
        if current == root or not _is_model_dir(current):
            continue
        rel = os.path.relpath(current, root).replace("/", "\\")
        if not _kind_matches(rel, kind):
            continue
        rel_base = os.path.basename(rel).lower()
        rel_key = _normalize_key(rel)
        if requested and (rel.lower() == requested.lower() or rel_base == requested_base or rel_key == requested_key):
            return current
        if requested_key and requested_key in rel_key and best_contains is None:
            best_contains = current
    return best_contains


def _resolve_model_dir(model_name: str, kind: str, unique_id: Any = None) -> str:
    found = _find_local_model_dir(model_name, kind)
    if found:
        return found
    root = os.path.join(folder_paths.models_dir, MODEL_ROOT_NAME)
    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[
            make_missing_model_spec(
                label=str(model_name or "Qwen3-ASR 模型"),
                subdir=MODEL_ROOT_NAME,
                filename=str(model_name or ""),
                description=f"请从夸克网盘下载后放到 {root}。",
            )
        ],
        description=f"未找到本地模型：{model_name}",
        unique_id=unique_id,
        title="GJJ 节点模型缺失！",
        copy_text=MODEL_DOWNLOAD_BASE_URL,
        copy_label="🌏 复制夸克下载网址",
    )


def _load_qwen_runtime(unique_id: Any = None):
    qwen_asr = load_dependency_at_runtime(
        module_name="qwen_asr",
        node_name=NODE_DISPLAY_NAME,
        package_name="qwen-asr",
        description="Qwen3-ASR 运行时依赖 qwen-asr。",
        extra_packages=["huggingface_hub", "soundfile", "av"],
        unique_id=unique_id,
    )
    return qwen_asr.Qwen3ASRModel, qwen_asr.Qwen3ForcedAligner


def _resolve_device_map() -> str:
    return "cuda:0" if torch.cuda.is_available() else "cpu"


def _resolve_dtype_name(precision: str) -> str:
    precision = str(precision or "自动").strip()
    if precision != "自动":
        return precision
    if not torch.cuda.is_available():
        return "float32"
    try:
        if torch.cuda.is_bf16_supported():
            return "bfloat16"
    except Exception:
        pass
    return "float16"


def _dtype_from_name(dtype_name: str):
    if dtype_name == "float16":
        return torch.float16
    if dtype_name == "float32":
        return torch.float32
    return torch.bfloat16


def _load_asr_model(
    model_dir: str,
    dtype_name: str,
    device_map: str,
    max_inference_batch_size: int,
    max_new_tokens: int,
    unique_id: Any = None,
):
    cache_key = (model_dir, dtype_name, device_map, int(max_inference_batch_size), int(max_new_tokens))
    if cache_key in _ASR_CACHE:
        return _ASR_CACHE[cache_key]

    Qwen3ASRModel, _ = _load_qwen_runtime(unique_id)
    model = Qwen3ASRModel.from_pretrained(
        model_dir,
        dtype=_dtype_from_name(dtype_name),
        device_map=device_map,
        max_inference_batch_size=int(max_inference_batch_size),
        max_new_tokens=int(max_new_tokens),
    )
    _ASR_CACHE[cache_key] = model
    return model


def _load_aligner_model(model_dir: str, dtype_name: str, device_map: str, unique_id: Any = None):
    cache_key = (model_dir, dtype_name, device_map)
    if cache_key in _ALIGNER_CACHE:
        return _ALIGNER_CACHE[cache_key]

    _, Qwen3ForcedAligner = _load_qwen_runtime(unique_id)
    aligner = Qwen3ForcedAligner.from_pretrained(
        model_dir,
        dtype=_dtype_from_name(dtype_name),
        device_map=device_map,
    )
    _ALIGNER_CACHE[cache_key] = aligner
    return aligner


def _audio_to_numpy(audio: dict[str, Any]) -> tuple[np.ndarray, int]:
    if not isinstance(audio, dict):
        raise RuntimeError("输入音频不是 ComfyUI AUDIO 对象。")
    if "waveform" not in audio or "sample_rate" not in audio:
        raise RuntimeError("输入音频缺少 waveform 或 sample_rate。")

    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    if sample_rate <= 0:
        raise RuntimeError("输入音频采样率无效。")

    if isinstance(waveform, torch.Tensor):
        waveform = waveform.detach().float().cpu().numpy()
    else:
        waveform = np.asarray(waveform, dtype=np.float32)

    if waveform.size == 0:
        raise RuntimeError("输入音频为空。")
    while waveform.ndim > 3:
        waveform = waveform[0]
    if waveform.ndim == 3:
        waveform = waveform[0]
    if waveform.ndim == 2:
        waveform = np.mean(waveform, axis=0)
    if waveform.ndim != 1:
        waveform = np.reshape(waveform, (-1,))

    waveform = np.nan_to_num(waveform.astype(np.float32, copy=False))
    return waveform, sample_rate


def transcribe_reference_audio(audio: dict[str, Any], unique_id: Any = None) -> str:
    """Transcribe one local reference clip without loading the forced aligner."""
    waveform, sample_rate = _audio_to_numpy(audio)
    model_dir = _find_local_model_dir("Qwen3-ASR-1.7B", "asr")
    if not model_dir:
        model_dir = _find_local_model_dir("Qwen3-ASR-0.6B", "asr")
    if not model_dir:
        model_dir = _resolve_model_dir("Qwen3-ASR-1.7B", "asr", unique_id)
    dtype_name = _resolve_dtype_name("自动")
    model = _load_asr_model(
        model_dir,
        dtype_name,
        _resolve_device_map(),
        8,
        512,
        unique_id,
    )
    transcriptions = model.transcribe(
        audio=(waveform, sample_rate),
        context="",
        language=None,
        return_time_stamps=False,
    )
    text = str(getattr(transcriptions[0], "text", "") or "").strip() if transcriptions else ""
    if not text:
        raise RuntimeError("Qwen3-ASR 未能识别参考音频文本。")
    return text


def _normalize_language_name(value: str) -> str:
    target = str(value or "").strip()
    if not target:
        return ""
    lower = target.lower()
    for language in ALIGN_LANGUAGES:
        if lower == language.lower():
            return language
    return target


def _resolve_align_language(detected_language: str, align_language: str, asr_language: str) -> str:
    if align_language != ALIGN_AUTO:
        return _normalize_language_name(align_language)

    candidates: list[str] = []
    for source in (detected_language, asr_language):
        if not source or source == "Auto":
            continue
        candidates.extend(part.strip() for part in re.split(r"[,，/|]+", str(source)) if part.strip())

    supported = {language.lower(): language for language in ALIGN_LANGUAGES}
    for candidate in candidates:
        matched = supported.get(candidate.lower())
        if matched:
            return matched
    return "Chinese"


def _split_segments(text: str) -> list[str]:
    segments = [s for s in re.split(r"[。？！，、；.?!,;：:\s]+", str(text or "")) if s]
    return segments or ([str(text).strip()] if str(text or "").strip() else [])


def _segment_alignment(items: Any, text: str, segment_by_sentence: bool) -> tuple[list[str], list[str], list[str]]:
    texts: list[str] = []
    starts: list[str] = []
    ends: list[str] = []

    if not segment_by_sentence:
        for item in items:
            item_text = str(getattr(item, "text", "") or "")
            if not item_text:
                continue
            texts.append(item_text)
            starts.append(f"{float(getattr(item, 'start_time', 0.0)):.1f}")
            ends.append(f"{float(getattr(item, 'end_time', 0.0)):.1f}")
        return texts, starts, ends

    segments = _split_segments(text)
    item_idx = 0
    item_count = len(items)
    for segment in segments:
        segment_start = None
        segment_end = None
        matched = ""
        while item_idx < item_count and len(matched) < len(segment):
            item = items[item_idx]
            if segment_start is None:
                segment_start = float(getattr(item, "start_time", 0.0))
            segment_end = float(getattr(item, "end_time", segment_start or 0.0))
            matched += str(getattr(item, "text", "") or "")
            item_idx += 1
        if segment_start is not None and segment_end is not None:
            texts.append(segment)
            starts.append(f"{segment_start:.1f}")
            ends.append(f"{segment_end:.1f}")
    return texts, starts, ends


def _format_timestamps(texts: list[str], starts: list[str], ends: list[str]) -> str:
    return "\n".join(f"[{start}s-{end}s] {text}" for text, start, end in zip(texts, starts, ends))


def _format_time_array(values: list[str]) -> str:
    if not values:
        return "[]"
    return "[" + ",".join(str(value).strip() for value in values if str(value).strip()) + ",]"


def _format_srt_time(value: str) -> str:
    total_ms = max(0, int(round(float(value) * 1000.0)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def _format_srt(texts: list[str], starts: list[str], ends: list[str]) -> str:
    blocks = []
    for index, (text, start, end) in enumerate(zip(texts, starts, ends), start=1):
        blocks.append(
            f"{index}\n{_format_srt_time(start)} --> {_format_srt_time(end)}\n{str(text).strip()}"
        )
    return "\n\n".join(blocks)


def _segment_audio_queue(
    waveform: np.ndarray,
    sample_rate: int,
    starts: list[str],
    ends: list[str],
) -> list[dict[str, Any]]:
    total_samples = int(waveform.shape[-1])
    segments = []
    for start, end in zip(starts, ends):
        start_sample = max(0, min(total_samples, int(round(float(start) * sample_rate))))
        end_sample = max(start_sample, min(total_samples, int(round(float(end) * sample_rate))))
        if end_sample <= start_sample:
            continue
        segment = np.ascontiguousarray(waveform[start_sample:end_sample], dtype=np.float32)
        segments.append({
            "waveform": torch.from_numpy(segment).unsqueeze(0).unsqueeze(0),
            "sample_rate": int(sample_rate),
        })
    return segments


def _hidden_widget(options: dict[str, Any]) -> dict[str, Any]:
    result = dict(options)
    result.setdefault("hidden", True)
    result.setdefault("display", "hidden")
    result.setdefault("advanced", True)
    return result


class GJJ_Qwen3ASRTextFormats:
    CATEGORY = "GJJ/🎵 音频"
    FUNCTION = "transcribe_and_align"
    OUTPUT_NODE = True
    DESCRIPTION = DESCRIPTION
    SEARCH_ALIASES = ["qwen3 asr", "qwen asr", "语音识别", "音频转文字", "强制对齐", "字幕时间戳"]
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "STRING", "AUDIO")
    RETURN_NAMES = ("时间戳表", "分段文本", "开始时间列表", "结束时间列表", "标准SRT", "分段音频")
    OUTPUT_TOOLTIPS = (
        "每行输出为 Wan/LTX 常用时序提示格式：[开始s-结束s] 文本，例如 [0.4s-2.9s] 台词。",
        "每个识别片段一行，顺序与时间戳表一致。",
        "每个片段的开始时间，输出为 [1,2,] 形式的数组字符串。",
        "每个片段的结束时间，输出为 [1,2,] 形式的数组字符串。",
        "标准 SubRip 字幕文本，可连接文本保存节点并使用 .srt 扩展名保存。",
        "按强制对齐时间逐段裁切的 AUDIO 队列；每个字幕片段对应一段音频。",
    )
    OUTPUT_IS_LIST = (False, False, False, False, False, True)
    GJJ_UI = {
        "toolbar": ["📁", "🧠", "📝", "🔌", "⚙️", "📋", "🎤"],
        "hidden_parameters": [
            "example_audio",
            "asr_model_name",
            "aligner_model_name",
            "asr_language",
            "align_language",
            "context",
            "precision",
            "max_inference_batch_size",
            "max_new_tokens",
            "output_order_json",
        ],
    }
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": _DESCRIPTION_READY,
        "notice": _HELP_NOTICE,
        "warning_message": _ENV_REPORT["warning_message"] if not _ENV_REPORT.get("available", True) else "",
        "install_cmd": _ENV_REPORT["install_cmd"] if not _ENV_REPORT.get("available", True) else "",
        "copy_text": _ENV_REPORT["copy_text"] if not _ENV_REPORT.get("available", True) else "",
        "copy_label": _ENV_REPORT["copy_label"] if not _ENV_REPORT.get("available", True) else "",
        "model_download_url": MODEL_DOWNLOAD_BASE_URL,
        "missing_dependencies": _MISSING_DEPENDENCIES,
        "missing_models": [],
        "dependencies": [
            "qwen-asr（主识别与强制对齐运行库）",
            "huggingface_hub（qwen-asr 运行时依赖）",
            "soundfile / torchaudio / av / librosa（音频解码，至少可用一套）",
        ],
        "model_tree": [],
        "models": [],
        "model_tree_text": _local_model_tree_text(),
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "tips": [
            "推荐优先准备 Qwen3-ASR-1.7B 和 Qwen3-ForcedAligner-0.6B。",
            "长音频或显存不足时可降低推理批量，或切回 CPU。",
            "示例音频支持多种格式；若某种格式解码失败，可改用外部 AUDIO 输入。",
        ],
    }

    @staticmethod
    def _ordered_outputs(
        timestamps: str,
        text_list: str,
        start_times: str,
        end_times: str,
        srt: str,
        segment_audio: list[dict[str, Any]],
        output_order_json: str,
    ) -> tuple[Any, Any, Any, Any, Any, Any]:
        values = {
            "text_list": text_list,
            "timestamps": timestamps,
            "start_times": start_times,
            "end_times": end_times,
            "srt": srt,
            "segment_audio": segment_audio,
        }
        try:
            requested = json.loads(str(output_order_json or "[]"))
        except (TypeError, ValueError, json.JSONDecodeError):
            requested = []
        order = []
        if isinstance(requested, list):
            order = [str(key) for key in requested if str(key) in values]
        if not order:
            order = ["text_list"]
        result = [values[key] for key in dict.fromkeys(order)]
        result.extend("" for _ in range(6 - len(result)))
        return tuple(result[:6])

    @classmethod
    def INPUT_TYPES(cls):
        asr_models = _list_asr_models()
        aligner_models = _list_aligner_models()

        # 读取 models/GJJ/wav 列表（默认 .wav，兼容 .mp3）
        mp3_dir = os.path.join(folder_paths.models_dir, "GJJ", "wav")
        audio_choices = [""]  # 空选项
        if os.path.isdir(mp3_dir):
            for current_root, _, files in os.walk(mp3_dir):
                for f in sorted(files):
                    if f.lower().endswith((".wav", ".mp3", ".flac", ".m4a")):
                        audio_choices.append(os.path.relpath(os.path.join(current_root, f), mp3_dir))

        # 如果列表为空，添加占位符
        if len(audio_choices) == 1:
            audio_choices.append("[无示例音频]")

        return {
            "required": {},
            "optional": {
                "audio": ("AUDIO", {
                    "display_name": "输入音频",
                    "tooltip": "连接 ComfyUI 的音频对象，例如 Load Audio 节点输出。",
                }),
                "example_audio": (audio_choices, _hidden_widget({
                    "default": "",
                    "display_name": "示例音频",
                    "tooltip": "从 models/GJJ/wav 目录选择示例音频；默认 .wav，兼容 .mp3。",
                })),
                "asr_model_name": (asr_models, _hidden_widget({
                    "default": "Qwen3-ASR-1.7B" if "Qwen3-ASR-1.7B" in asr_models else asr_models[0],
                    "display_name": "ASR模型",
                    "tooltip": "搜索 models/ASR 下的本地 Qwen3-ASR 模型；缺少时显示夸克下载提示。",
                })),
                "aligner_model_name": (aligner_models, _hidden_widget({
                    "default": "Qwen3-ForcedAligner-0.6B" if "Qwen3-ForcedAligner-0.6B" in aligner_models else aligner_models[0],
                    "display_name": "对齐模型",
                    "tooltip": "用于把识别文本对齐到音频时间轴的 Qwen3-ForcedAligner 模型。",
                })),
                "asr_language": (ASR_LANGUAGES, _hidden_widget({
                    "default": "Auto",
                    "display_name": "识别语言",
                    "tooltip": "Auto 会自动检测语言；选择具体语言时会强制按该语言识别。",
                })),
                "align_language": ([ALIGN_AUTO] + ALIGN_LANGUAGES, _hidden_widget({
                    "default": ALIGN_AUTO,
                    "display_name": "对齐语言",
                    "tooltip": "默认使用 ASR 检测到的语言；如果检测语言不稳定，可手动指定强制对齐语言。",
                })),
                "context": ("STRING", _hidden_widget({
                    "default": "",
                    "multiline": True,
                    "display_name": "上下文提示",
                    "tooltip": "可填写专有名词、人物名或场景提示，帮助 ASR 识别更准确；不需要时留空。",
                })),
                "precision": (PRECISION_OPTIONS, _hidden_widget({
                    "default": "自动",
                    "display_name": "计算精度",
                    "tooltip": "CUDA 环境通常使用 bfloat16；显卡不支持时可改为 float16 或自动。",
                })),
                "max_inference_batch_size": ("INT", _hidden_widget({
                    "default": 32,
                    "min": 1,
                    "max": 128,
                    "display_name": "推理批量",
                    "tooltip": "控制 Qwen3-ASR 内部分批大小。显存不足时调小。",
                })),
                "max_new_tokens": ("INT", _hidden_widget({
                    "default": 512,
                    "min": 64,
                    "max": 4096,
                    "display_name": "最大输出长度",
                    "tooltip": "限制单段 ASR 生成 token 数。长音频或长句可适当调大。",
                })),
                "output_order_json": ("STRING", _hidden_widget({
                    "default": '["text_list"]',
                    "display_name": "输出接口顺序",
                    "tooltip": "由顶部 🔌 按钮自动维护。",
                })),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def transcribe_and_align(
        self,
        audio=None,
        example_audio="",
        asr_model_name=None,
        aligner_model_name=None,
        asr_language="Auto",
        align_language=ALIGN_AUTO,
        context="",
        segment_by_sentence=True,
        auto_download=False,
        precision="自动",
        max_inference_batch_size=32,
        max_new_tokens=512,
        output_order_json='["text_list"]',
        unique_id=None,
        extra_pnginfo=None,
        emit_frontend_events=True,
    ):
        # 从 properties 读取 Boolean 值（通过 extra_pnginfo + unique_id）
        props = {}
        try:
            if extra_pnginfo and isinstance(extra_pnginfo, dict):
                workflow = extra_pnginfo.get("workflow", {})
                if isinstance(workflow, dict):
                    nodes = workflow.get("nodes", [])
                    if isinstance(nodes, list):
                        uid = str(unique_id)
                        for n in nodes:
                            if isinstance(n, dict) and str(n.get("id")) == uid:
                                props = n.get("properties", {}) or {}
                                break
        except Exception:
            props = {}

        segment_by_sentence = bool(props.get("segment_by_sentence", True))
        # 如果提供了 example_audio，加载它作为 audio
        # 支持空字符串、'[无示例音频]' 或实际文件名
        if audio is None and example_audio and example_audio != "[无示例音频]":
            mp3_dir = os.path.join(folder_paths.models_dir, "GJJ", "wav")
            audio_path = os.path.join(mp3_dir, example_audio)
            if os.path.exists(audio_path):
                try:
                    # 使用 soundfile + PyAV 加载音频（支持 WMA 等多种格式）
                    audio_np, sample_rate = _read_audio_file(audio_path)
                    # 转换为 torch tensor
                    if audio_np.ndim == 1:
                        audio_np = audio_np.reshape(1, -1)
                    else:
                        audio_np = audio_np.T  # soundfile 返回 (samples, channels)，需要转为 (channels, samples)
                    waveform = torch.from_numpy(audio_np).float()
                    audio = {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}
                except Exception as e:
                    # 加载失败时给出警告，但不中断执行
                    import warnings
                    warnings.warn(f"️ 加载示例音频失败: {e}")
                    # 继续执行，等待用户连接音频
            else:
                # 文件不存在时（可能是旧工作流缓存），给出友好提示
                import warnings
                warnings.warn(
                    f"⚠️ 示例音频文件不存在: {example_audio}\n"
                    f"💡 提示：请从下拉列表重新选择，或连接音频输入。"
                )
                # 继续执行，等待用户连接音频
        started_at = time.perf_counter()
        pbar = _new_progress_bar(5)
        try:
            _send_status(unique_id, "1/5 正在准备输入音频...", 0.05)
            waveform, sample_rate = _audio_to_numpy(audio)
            duration = float(waveform.shape[-1]) / float(sample_rate)
            _update_progress(pbar, 1, 5)

            dtype_name = _resolve_dtype_name(precision)
            device_map = _resolve_device_map()
            _send_status(unique_id, "2/5 正在加载 Qwen3-ASR 模型...", 0.24)
            asr_dir = _resolve_model_dir(asr_model_name, "asr", unique_id)
            asr_model = _load_asr_model(
                asr_dir,
                dtype_name,
                device_map,
                int(max_inference_batch_size),
                int(max_new_tokens),
                unique_id,
            )
            _update_progress(pbar, 2, 5)

            language_param = None if asr_language == "Auto" else str(asr_language)
            _send_status(unique_id, "3/5 正在识别语音文本...", 0.48)
            transcriptions = asr_model.transcribe(
                audio=(waveform, sample_rate),
                context=str(context or ""),
                language=language_param,
                return_time_stamps=False,
            )
            if not transcriptions:
                raise RuntimeError("ASR 没有返回识别结果。")
            transcription = transcriptions[0]
            full_text = str(getattr(transcription, "text", "") or "").strip()
            detected_language = str(getattr(transcription, "language", "") or "").strip()
            _update_progress(pbar, 3, 5)

            if not full_text:
                _send_status(unique_id, f"完成：未识别到有效文本，音频时长 {duration:.2f} 秒。", 1.0)
                return {"ui": {"text": ("", "", "", "", "")}, "result": self._ordered_outputs("", "", "", "", "", [], output_order_json)}

            resolved_align_language = _resolve_align_language(detected_language, align_language, asr_language)
            _send_status(unique_id, f"4/5 正在执行强制对齐：{resolved_align_language}...", 0.72)
            aligner_dir = _resolve_model_dir(aligner_model_name, "aligner", unique_id)
            aligner = _load_aligner_model(aligner_dir, dtype_name, device_map, unique_id)
            align_results = aligner.align(
                audio=(waveform, sample_rate),
                text=full_text,
                language=resolved_align_language,
            )
            if not align_results:
                raise RuntimeError("强制对齐没有返回时间戳结果。")
            texts, starts, ends = _segment_alignment(align_results[0], full_text, bool(segment_by_sentence))
            _update_progress(pbar, 4, 5)

            _send_status(unique_id, "5/5 正在整理文本与 SRT 字幕...", 0.9)
            timestamps = _format_timestamps(texts, starts, ends)
            text_list = "\n".join(texts)
            start_times = _format_time_array(starts)
            end_times = _format_time_array(ends)
            srt = _format_srt(texts, starts, ends)
            segment_audio = _segment_audio_queue(waveform, sample_rate, starts, ends)
            elapsed = time.perf_counter() - started_at
            _send_status(
                unique_id,
                f"完成：{len(texts)} 段，识别语言 {detected_language or '未知'}，对齐语言 {resolved_align_language}，耗时 {elapsed:.2f} 秒。",
                1.0,
            )
            _update_progress(pbar, 5, 5)

            # 发送生成的文本到前端显示（通过 custom event）
            try:
                from server import PromptServer
                if emit_frontend_events:
                    PromptServer.instance.send_sync("gjj_qwen3_text_generated", {
                        "node": str(unique_id),
                        "text_list": text_list,
                        "timestamps": timestamps,
                    })
            except Exception:
                pass

            return {
                "ui": {"text": (timestamps, text_list, start_times, end_times, srt)},
                "result": self._ordered_outputs(timestamps, text_list, start_times, end_times, srt, segment_audio, output_order_json),
            }
        except Exception as exc:
            report = get_report_from_exception(exc)
            if report:
                _send_status(unique_id, "执行失败，请查看上方面板", 1.0)
                send_dependency_model_notice(report, unique_id=unique_id)
                raise RuntimeError(report.get("warning_message") or "运行环境缺失。") from exc

            _send_status(unique_id, f"执行失败：{exc}", 1.0)
            error_msg = str(exc)

            # 检测是否为 CUDA 错误，如果是则尝试自动降级到 CPU
            if ("CUDA error" in error_msg or "cuda" in error_msg.lower()) and torch.cuda.is_available():
                import warnings
                warnings.warn(
                    f"⚠️ 检测到 CUDA 错误，正在自动切换到 CPU 模式...\n"
                    f"原始错误：{exc}"
                )

                try:
                    _send_status(unique_id, "⚠️ CUDA 错误，正在切换到 CPU 模式重试...", 0.1)

                    original_device_map = _resolve_device_map

                    def _cpu_device_map():
                        return "cpu"

                    import gjj_qwen3_asr_text_formats as module
                    module._resolve_device_map = _cpu_device_map

                    _send_status(unique_id, "💡 请将节点中的「设备」参数改为 cpu，然后重新运行", 1.0)

                    raise RuntimeError(
                        "🎤 Qwen3-ASR 四文本单节点执行失败（CUDA 兼容性错误）\n"
                        f"ASR模型：{asr_model_name}\n"
                        f"对齐模型：{aligner_model_name}\n\n"
                        "❌ CUDA 兼容性错误：您的 GPU 架构与当前 PyTorch/CUDA 版本不兼容。\n\n"
                        "✅ 已为您准备解决方案：\n"
                        "1. 【推荐】将节点中的「设备」参数改为 cpu，然后重新运行\n"
                        "2. 更新 PyTorch 到最新版本以支持您的 GPU\n"
                        "3. 如果使用的是较新的 GPU（如 RTX 40/50 系列），请确保安装了支持该架构的 PyTorch\n\n"
                        f"详细错误：{exc}"
                    ) from exc
                finally:
                    import gjj_qwen3_asr_text_formats as module
                    module._resolve_device_map = original_device_map
            else:
                detailed_error = (
                    "🎤 Qwen3-ASR 四文本单节点执行失败。\n"
                    f"ASR模型：{asr_model_name}\n"
                    f"对齐模型：{aligner_model_name}\n\n"
                    f"详细错误：{exc}"
                )
                _send_error_to_frontend(unique_id, detailed_error)
                raise RuntimeError(detailed_error) from exc


def transcribe_and_align_backend(**kwargs):
    """供其它节点复用 ASR/对齐运行时，不触发 Qwen 节点专属前端面板事件。"""
    return GJJ_Qwen3ASRTextFormats().transcribe_and_align(
        **{**kwargs, "emit_frontend_events": False},
    )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Qwen3ASRTextFormats}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·🎤 语音识别四文本TTS(Qwen3)"}
