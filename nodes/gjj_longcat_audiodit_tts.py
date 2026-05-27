from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

import folder_paths
import numpy as np
import torch
import torch.nn.functional as F
from .common_utils.dependency_checker import (
    build_dependency_model_report,
    check_dependencies,
    get_report_from_exception,
    raise_dependency_model_error,
    send_dependency_model_notice,
)

# 延迟导入 soundfile，避免缺失时导致整个模块无法加载
# import soundfile as sf  # 在函数内部导入

from .gjj_longcat_audiodit_loader import (
    HF_MODELS,
    HF_MODELS_FOLDER_NAME,
    LOCAL_MODEL_PLACEHOLDER,
    RUNTIME_INSTALL_PACKAGES,
    _strip_auto_download_suffix,
    approx_duration_from_text,
    get_model_names,
    load_model,
    normalize_text,
    numpy_audio_to_comfy,
    resolve_device,
)
from .gjj_longcat_audiodit_model_cache import (
    cancel_event,
    get_cache_key,
    get_cached_model,
    is_offloaded,
    offload_model_to_cpu,
    resume_model_to_cuda,
    set_cached_model,
    set_keep_loaded,
    unload_model,
)

NODE_NAME = "GJJ_LongCatAudioDiTTTS"
MAX_SPEAKERS = 10
AUDIO_PREFIX = "speaker_"
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"}
MISSING_AUDIO_CHOICE = "[未找到models/mp3音频]"
MP3_QUALITY_OPTIONS = ["320k", "128k", "V0"]
DEFAULT_REFERENCE_TEXT = "人生不如意十有八九。要么看得开，要么就认栽!"
MIN_VISIBLE_PAIRS = 1  # 默认只显示 1 对输入口
NODE_DISPLAY_NAME = "📢[多人]语音克隆TTS (LongCat)"
MODEL_DOWNLOAD_URL = "https://huggingface.co/meituan-longcat"
DEPENDENCY_SPECS = [
    {"module_name": "transformers", "package_name": "transformers", "display_name": "transformers", "description": "LongCat AudioDiT 文本编码与推理依赖。"},
    {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "LongCat AudioDiT 音频读写依赖。"},
    {"module_name": "huggingface_hub", "package_name": "huggingface_hub", "display_name": "huggingface_hub", "description": "自动下载 LongCat 模型与 tokenizer 依赖。"},
    {"module_name": "librosa", "package_name": "librosa", "display_name": "librosa", "description": "LongCat AudioDiT 音频重采样依赖。"},
]
OPTIONAL_DEPENDENCY_SPECS = [
    {"module_name": "av", "package_name": "av", "display_name": "PyAV", "description": "可选：当 soundfile 无法读取某些音频/视频格式时，用 PyAV 回退解码。缺失不影响已支持格式的合成。"},
]


def _collect_dependency_state() -> tuple[bool, list[dict[str, str]]]:
    missing_dependencies: list[dict[str, str]] = []
    for spec in DEPENDENCY_SPECS:
        available, _ = check_dependencies([spec["module_name"]], NODE_DISPLAY_NAME)
        if not available:
            missing_dependencies.append(spec)
    return (not missing_dependencies), missing_dependencies


def _collect_optional_dependency_state() -> tuple[bool, list[dict[str, str]]]:
    missing_dependencies: list[dict[str, str]] = []
    for spec in OPTIONAL_DEPENDENCY_SPECS:
        available, _ = check_dependencies([spec["module_name"]], NODE_DISPLAY_NAME)
        if not available:
            missing_dependencies.append(spec)
    return (not missing_dependencies), missing_dependencies


def _collect_model_state() -> tuple[bool, list[dict[str, str]]]:
    model_names = get_model_names()
    if model_names and model_names[0] != LOCAL_MODEL_PLACEHOLDER:
        return True, []
    return False, [
        {
            "label": "LongCat AudioDiT 模型",
            "subdir": HF_MODELS_FOLDER_NAME,
            "filename": "LongCat-AudioDiT-*",
            "description": "请放到 models/audiodit/ 或开启自动下载。",
        }
    ]


_DEPENDENCIES_AVAILABLE, _MISSING_DEPENDENCIES = _collect_dependency_state()
_OPTIONAL_DEPENDENCIES_AVAILABLE, _MISSING_OPTIONAL_DEPENDENCIES = _collect_optional_dependency_state()
_MODELS_AVAILABLE, _MISSING_MODELS = _collect_model_state()
_ENV_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_MISSING_DEPENDENCIES,
    optional_dependencies=_MISSING_OPTIONAL_DEPENDENCIES,
    missing_models=_MISSING_MODELS,
    install_packages=RUNTIME_INSTALL_PACKAGES,
    optional_install_packages=["av"],
    description="LongCat AudioDiT 一体式语音克隆与多说话人 TTS 节点。",
)
_HELP_NOTICE = (
    f"{_ENV_REPORT['warning_message']}\n请参考下方依赖、模型说明和安装命令。"
    if _ENV_REPORT.get("notice_level") in {"error", "optional"}
    else ""
)
_DESCRIPTION_READY = """
📢[多人]语音克隆TTS (LongCat)

LongCat AudioDiT 一体式语音克隆与多说话人 TTS。

📁 模型目录：
models/audiodit/

🌏模型下载：
https://huggingface.co/meituan-longcat

💡 使用提示：
- 支持多说话人输入，按 [speaker_1]:、[speaker_2]: 这样的行首标签逐句合成
- 默认从 models/mp3 选择参考音频；连接输入音频后自动按实际输入数量匹配说话人
- 节点会自动保存 MP3 预览，便于快速试听
""".strip()
DESCRIPTION = (
    _DESCRIPTION_READY
    if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
    else f"{_ENV_REPORT['warning_message']}\n\n{_DESCRIPTION_READY}"
)


def _send_error_to_frontend(unique_id: Any, error_message: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync("gjj_longcat_error", {
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


def _send_audio_preview(unique_id: Any, audio_ui: dict[str, Any]) -> None:
    if not unique_id or not audio_ui:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_node_audio",
            {"node": str(unique_id), "audio": audio_ui.get("audio", [])},
        )
    except Exception:
        pass


def _save_audio_mp3_ui(audio: dict[str, Any], filename_prefix: str, quality: str = "320k") -> dict[str, Any]:
    prefix = str(filename_prefix or "").strip() or "audio/GJJ_LongCat"
    selected_quality = str(quality or "320k").strip()
    if selected_quality not in set(MP3_QUALITY_OPTIONS):
        selected_quality = "320k"
    try:
        from comfy_api.latest import UI

        return UI.AudioSaveHelper.get_save_audio_ui(
            audio,
            filename_prefix=prefix,
            cls=None,
            format="mp3",
            quality=selected_quality,
        ).as_dict()
    except Exception as exc:
        raise RuntimeError(f"保存 MP3 失败：{exc}") from exc


def _new_progress_bar(total: int):
    try:
        import comfy.utils

        return comfy.utils.ProgressBar(total)
    except Exception:
        return None


def _update_progress(pbar: Any, current: int, total: int) -> None:
    if pbar is None:
        return
    try:
        pbar.update_absolute(current, total)
    except Exception:
        pass


def _check_interrupt() -> None:
    try:
        import comfy.model_management as mm

        mm.throw_exception_if_processing_interrupted()
    except Exception as exc:
        cancel_event.set()
        raise exc


def _models_mp3_root() -> Path:
    root = Path(folder_paths.models_dir) / "mp3"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _list_models_mp3() -> list[str]:
    root = _models_mp3_root()
    items: list[tuple[str, float]] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            mtime = 0.0
        items.append((str(path.relative_to(root)).replace("/", "\\"), mtime))
    # 按修改时间降序排列（最新的在前面）
    items.sort(key=lambda x: x[1], reverse=True)
    return [item[0] for item in items]


def _audio_choices() -> list[str]:
    items = _list_models_mp3()
    return [""] + (items or [MISSING_AUDIO_CHOICE])


def _resolve_local_audio(name: str) -> Path:
    choices = _list_models_mp3()
    selected = str(name or "").strip()
    if not selected or selected == MISSING_AUDIO_CHOICE:
        if not choices:
            raise RuntimeError(f"未找到本地参考音频，请把音频放到：{_models_mp3_root()}")
        selected = choices[0]

    root = _models_mp3_root().resolve()
    candidate = (root / selected.replace("/", os.sep).replace("\\", os.sep)).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise RuntimeError(f"参考音频路径越界：{selected}") from error
    if not candidate.is_file():
        raise RuntimeError(f"未找到本地参考音频：{selected}")
    return candidate


def _decode_audio_with_av(source_path: Path) -> tuple[np.ndarray, int]:
    import av

    with av.open(str(source_path)) as container:
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


def _read_audio_file(path: Path) -> tuple[np.ndarray, int]:
    sf_exc = None
    try:
        import soundfile as sf
        audio_np, sample_rate = sf.read(str(path), always_2d=True)
    except Exception as exc:
        sf_exc = exc
        audio_np = None
        sample_rate = 0
    else:
        if audio_np.size == 0:
            raise RuntimeError(f"参考音频为空：{path}")
        return audio_np.astype(np.float32, copy=False), int(sample_rate)

    try:
        audio_np, sample_rate = _decode_audio_with_av(path)
    except Exception as av_exc:
        missing_dependencies = []
        if isinstance(sf_exc, (ImportError, ModuleNotFoundError)):
            missing_dependencies.append({
                "module_name": "soundfile",
                "package_name": "soundfile",
                "display_name": "soundfile",
                "description": "LongCat AudioDiT 读取本地参考音频建议安装 soundfile。",
            })
        if isinstance(av_exc, (ImportError, ModuleNotFoundError)):
            missing_dependencies.append({
                "module_name": "av",
                "package_name": "av",
                "display_name": "PyAV",
                "description": "LongCat AudioDiT 回退音频解码需要 av。",
            })
        if missing_dependencies:
            raise_dependency_model_error(
                node_name="📢 语音克隆TTS(LongCat AudioDiT)",
                missing_dependencies=missing_dependencies,
                install_packages=["soundfile", "av"],
                description="缺少可用的本地参考音频解码依赖。",
                original_error=f"soundfile: {sf_exc}\nPyAV: {av_exc}",
            )
        raise RuntimeError(
            f"无法解码本地参考音频：{path}\n"
            f"soundfile 错误：{sf_exc}\n"
            f"PyAV 错误：{av_exc}"
        ) from av_exc
    return audio_np.astype(np.float32, copy=False), int(sample_rate)


def _resample_audio(audio_np: np.ndarray, source_sr: int, target_sr: int) -> np.ndarray:
    if int(source_sr) == int(target_sr):
        return audio_np.astype(np.float32, copy=False)
    import librosa

    return librosa.resample(audio_np.astype(np.float32, copy=False), orig_sr=int(source_sr), target_sr=int(target_sr))


def _numpy_to_reference_tensor(audio_np: np.ndarray, source_sr: int, target_sr: int) -> torch.Tensor:
    if audio_np.ndim == 2:
        audio_np = np.mean(audio_np, axis=1)
    elif audio_np.ndim > 2:
        audio_np = np.reshape(audio_np, (-1,))
    audio_np = _resample_audio(audio_np, source_sr, target_sr)
    return torch.from_numpy(np.asarray(audio_np, dtype=np.float32)).unsqueeze(0)


def _comfy_audio_to_tensor(audio: dict[str, Any], target_sr: int) -> torch.Tensor:
    if not isinstance(audio, dict) or "waveform" not in audio or "sample_rate" not in audio:
        raise RuntimeError("输入的参考音频不是有效 ComfyUI AUDIO 对象。")
    waveform = audio["waveform"]
    source_sr = int(audio["sample_rate"])
    if isinstance(waveform, torch.Tensor):
        wav = waveform.detach().float().cpu()
    else:
        wav = torch.as_tensor(waveform, dtype=torch.float32)
    if wav.ndim == 3:
        wav = wav[0]
    if wav.ndim == 2:
        if wav.shape[0] > 1:
            wav = wav.mean(dim=0, keepdim=True)
        wav_np = wav.squeeze(0).numpy()
    else:
        wav_np = wav.reshape(-1).numpy()
    return _numpy_to_reference_tensor(wav_np, source_sr, target_sr)


def _normalize_reference(wav: torch.Tensor, enabled: bool, target_dbfs: float) -> torch.Tensor:
    if not enabled:
        return wav
    wav = wav.float()
    rms = torch.sqrt(torch.mean(wav.square()).clamp_min(1e-12))
    target = float(10 ** (float(target_dbfs) / 20.0))
    return torch.clamp(wav * (target / rms), -1.0, 1.0)


def _parse_dialogue_lines(text: str) -> list[tuple[int, str]]:
    tag_re = re.compile(r"^\s*\[speaker_(\d+)\]:\s*(.*)$")
    turns: list[tuple[int, str]] = []
    current_speaker: int | None = None
    current_parts: list[str] = []
    for raw in str(text or "").splitlines():
        match = tag_re.match(raw)
        if match:
            if current_speaker is not None and current_parts:
                turns.append((current_speaker, " ".join(current_parts).strip()))
            current_speaker = int(match.group(1)) - 1
            current_parts = [match.group(2)] if match.group(2).strip() else []
            continue
        stripped = raw.strip()
        if stripped and current_speaker is not None:
            current_parts.append(stripped)
    if current_speaker is not None and current_parts:
        turns.append((current_speaker, " ".join(current_parts).strip()))
    return [(speaker, line) for speaker, line in turns if line]


def _speaker_audio_name(index: int) -> str:
    return f"{AUDIO_PREFIX}{index:02d}_audio"


def _speaker_ref_text_name(index: int) -> str:
    return f"{AUDIO_PREFIX}{index:02d}_ref_text"


def _build_optional_inputs() -> dict[str, tuple[str, dict[str, Any]]]:
    optional: dict[str, tuple[str, dict[str, Any]]] = {}

    for index in range(1, MAX_SPEAKERS + 1):
        optional[_speaker_audio_name(index)] = ("AUDIO", {
            "forceInput": True,
            "display_name": f"参考音频{index}",
            "tooltip": f"第 {index} 个说话人的参考音频。连接当前最后一路后会自动扩展下一组输入。",
        })
        optional[_speaker_ref_text_name(index)] = ("STRING", {
            "forceInput": True,
            "default": DEFAULT_REFERENCE_TEXT,
            "display_name": f"参考文本{index}",
            "tooltip": f"第 {index} 个说话人参考音频对应的文字，可留空；连接文本后会随同音频作为克隆提示。",
        })
    return optional


def _valid_audio(value: Any) -> bool:
    return isinstance(value, dict) and value.get("waveform") is not None and value.get("sample_rate") is not None


def _collect_connected_references(kwargs: dict[str, Any]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for index in range(1, MAX_SPEAKERS + 1):
        audio = kwargs.get(_speaker_audio_name(index))
        if not _valid_audio(audio):
            continue
        refs.append({
            "source": f"输入音频 {len(refs) + 1}",
            "audio": audio,
            "ref_text": str(kwargs.get(_speaker_ref_text_name(index)) or DEFAULT_REFERENCE_TEXT).strip(),
        })
    return refs


def _pick_default_model(models: list[str]) -> str:
    for preferred in ("LongCat-AudioDiT-3.5B-fp8", "LongCat-AudioDiT-3.5B-bf16"):
        for item in models:
            if _strip_auto_download_suffix(item) == preferred:
                return item
    return models[0] if models else ""


def _get_model(model_path: str, device: str, dtype: str, attention: str, keep_loaded: bool, unique_id=None):
    if dtype == "fp16":
        dtype = "bf16"
    key = get_cache_key(model_path, device, dtype, attention)
    cached_model, cached_tokenizer, cached_key = get_cached_model()
    if cached_model is not None and cached_key != key:
        unload_model()
    if cached_model is not None and cached_key == key:
        set_keep_loaded(keep_loaded)
        if is_offloaded():
            device_str, _ = resolve_device(device)
            resume_model_to_cuda(device_str)
        return cached_model, cached_tokenizer
    model, tokenizer = load_model(model_path, device, dtype, attention, unique_id=unique_id)
    set_cached_model(model, tokenizer, key, keep_loaded=keep_loaded)
    return model, tokenizer


class GJJ_LongCatAudioDiTTTS:
    CATEGORY = "GJJ/Audio"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = DESCRIPTION
    SEARCH_ALIASES = ["LongCat", "AudioDiT", "TTS", "语音克隆", "多说话人", "文字转语音"]
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("合成音频",)
    OUTPUT_TOOLTIPS = ("LongCat AudioDiT 合成后的 ComfyUI 音频对象；节点内部也会保存 MP3 并显示播放器。",)
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": _DESCRIPTION_READY,
        "notice": _HELP_NOTICE,
        "warning_message": _ENV_REPORT["warning_message"] if _ENV_REPORT.get("notice_level") in {"error", "optional"} else "",
        "install_cmd": _ENV_REPORT["install_cmd"] if _ENV_REPORT.get("notice_level") == "error" else "",
        "optional_install_cmd": _ENV_REPORT.get("optional_install_cmd", "") if _ENV_REPORT.get("notice_level") == "optional" else "",
        "copy_text": _ENV_REPORT["copy_text"] if _ENV_REPORT.get("notice_level") in {"error", "optional"} else "",
        "copy_label": _ENV_REPORT["copy_label"] if _ENV_REPORT.get("notice_level") in {"error", "optional"} else "",
        "notice_level": _ENV_REPORT.get("notice_level", "ok"),
        "model_download_url": MODEL_DOWNLOAD_URL,
        "missing_dependencies": _MISSING_DEPENDENCIES,
        "optional_dependencies": _MISSING_OPTIONAL_DEPENDENCIES,
        "missing_models": _MISSING_MODELS,
        "dependencies": [
            "需要 transformers、soundfile、huggingface_hub、librosa 等 Python 依赖。",
            "可选：本地参考音频回退解码会使用 PyAV；缺失时，soundfile 能读取的格式仍可正常运行。",
            "Tokenizer 会在首次执行时按需自动下载。",
        ],
        "models": _MISSING_MODELS or [
            {
                "label": "LongCat-AudioDiT-3.5B-bf16",
                "value": "models/audiodit/LongCat-AudioDiT-3.5B-bf16",
                "tooltip": "推荐，显存占用和效果更平衡。",
            },
            {
                "label": "LongCat-AudioDiT-3.5B-fp8",
                "value": "models/audiodit/LongCat-AudioDiT-3.5B-fp8",
                "tooltip": "显存更低，速度更快。",
            },
        ],
        "tips": [
            "连接多个参考音频时，文本必须使用 [speaker_1]:、[speaker_2]: 这样的行首标签。",
            "没有连接参考音频时，会优先使用 models/mp3 下最新的本地音频文件。",
            "LongCat 音质通常不如 FishAudioS2，但多说话人流程更直接。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        model_names = get_model_names()
        audio_choices = _audio_choices()
        default_audio = next((item for item in audio_choices if item), "")
        return {
            "required": {
                "model_path": (model_names, {
                    "default": _pick_default_model(model_names),
                    "display_name": "LongCat模型",
                    "tooltip": "自动搜索 models/audiodit 下的 LongCat-AudioDiT 模型。没有本地模型时可选择带 auto download 的条目。",
                }),
                "text": ("STRING", {
                    "multiline": True,
                    "default": "[speaker_1]: 最近字母圈怎么样？\n[speaker_2]: 你说的是什么字母？\n[speaker_1]: AI！人工智能！\n[speaker_2]: 哦，我以为你说的是SM？哈哈……",
                    "display_name": "合成文本",
                    "tooltip": "要合成的文本。多说话人请使用 [speaker_1]:、[speaker_2]: 这样的行首标签。",
                }),
                "local_audio_name": (audio_choices, {
                    "default": default_audio,
                    "display_name": "本地参考音频",
                    "tooltip": "没有连接参考音频时，从 models/mp3 选择一段音频作为 speaker_1；连接任意参考音频后此项会自动置空并被忽略。",
                }),
                "steps": ("INT", {
                    "default": 16,
                    "min": 4,
                    "max": 64,
                    "step": 1,
                    "display_name": "采样步数",
                    "tooltip": "ODE Euler 采样步数。更高通常更细致，但更慢。",
                }),
                "guidance_strength": ("FLOAT", {
                    "default": 4.0,
                    "min": 0.0,
                    "max": 10.0,
                    "step": 0.5,
                    "display_name": "引导强度",
                    "tooltip": "CFG/APG 引导强度，语音克隆通常使用 4 左右。",
                }),
                "guidance_method": (["cfg", "apg"], {
                    "default": "apg",
                    "display_name": "引导方式",
                    "tooltip": "语音克隆推荐使用 APG；普通 TTS 可尝试 CFG。",
                }),
                "device": (["auto", "cuda", "cpu", "mps"], {
                    "default": "auto",
                    "display_name": "运行设备",
                    "tooltip": "auto 会优先选择 CUDA，其次 MPS，最后 CPU。",
                }),
                "dtype": (["auto", "bf16", "fp16", "fp32"], {
                    "default": "auto",
                    "display_name": "计算精度",
                    "tooltip": "auto 会按设备选择精度。语音克隆内部会把 fp16 自动提升为 bf16 以避免不稳定。",
                }),
                "attention": (["auto", "sdpa", "sage_attention", "flash_attention"], {
                    "default": "auto",
                    "display_name": "注意力实现",
                    "tooltip": "默认 auto。sage_attention 或 flash_attention 需要当前环境已安装对应加速库。",
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 2**31 - 1,
                    "control_after_generate": True,
                    "display_name": "随机种子",
                    "tooltip": "0 表示随机；固定种子可以复现结果。多句对话会按行递增种子。",
                }),
                "pause_after_speaker": ("FLOAT", {
                    "default": 0.4,
                    "min": 0.0,
                    "max": 5.0,
                    "step": 0.1,
                    "display_name": "说话间隔秒数",
                    "tooltip": "多句合成后，在相邻说话片段之间插入的静音秒数。",
                }),
                "reference_dbfs": ("FLOAT", {
                    "default": -23.0,
                    "min": -40.0,
                    "max": -6.0,
                    "step": 0.5,
                    "display_name": "参考目标响度",
                    "tooltip": "参考音频 RMS 归一化目标，默认约等于工作流里的 -23。",
                }),
                "mp3_filename_prefix": ("STRING", {
                    "default": "audio/GJJ_LongCat",
                    "display_name": "MP3文件名前缀",
                    "tooltip": "生成后会自动保存 MP3，并在节点中间显示播放器。这里控制输出目录和文件名前缀。",
                }),
                "mp3_quality": (MP3_QUALITY_OPTIONS, {
                    "default": "320k",
                    "display_name": "MP3质量",
                    "tooltip": "内置 MP3 保存质量。320k 体积较大但质量更高；128k 体积更小；V0 是可变码率。",
                }),
            },
            "optional": {
                "keep_model_loaded": ("BOOLEAN", {
                    "default": True,
                    "display_name": "保留模型",
                    "tooltip": "任务结束后保留模型缓存并自动转移到 CPU，下次运行会尝试恢复到 GPU；关闭则任务后卸载。",
                }),
                **_build_optional_inputs(),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def _prepare_references(
        self,
        model,
        connected_refs: list[dict[str, Any]],
        local_audio_name: str,
        normalize_reference: bool,
        reference_dbfs: float,
        kwargs: dict[str, Any],
        unique_id: Any = None,
    ) -> list[dict[str, Any]]:
        sr = int(model.config.sampling_rate)
        refs = connected_refs

        # 如果没有连接任何参考音频，使用本地参考音频列表中的文件
        if not refs:
            audio_choices = _list_models_mp3()

            # 默认使用本地参考音频列表中的 [1] 和 [2]（如果存在）
            if len(audio_choices) >= 2:
                # 有两个或更多文件，使用 [0] 和 [1] 作为 speaker_1 和 speaker_2
                refs = []
                for idx in range(min(2, len(audio_choices))):
                    local_path = _models_mp3_root() / audio_choices[idx].replace("/", os.sep).replace("\\", os.sep)
                    refs.append({
                        "source": f"models/mp3：{local_path.name}",
                        "local_path": local_path,
                        "ref_text": str(kwargs.get(_speaker_ref_text_name(idx + 1)) or DEFAULT_REFERENCE_TEXT).strip(),
                    })
            elif len(audio_choices) == 1:
                # 只有一个文件，使用它作为 speaker_1
                local_path = _models_mp3_root() / audio_choices[0].replace("/", os.sep).replace("\\", os.sep)
                refs = [{
                    "source": f"models/mp3：{local_path.name}",
                    "local_path": local_path,
                    "ref_text": str(kwargs.get(_speaker_ref_text_name(1)) or DEFAULT_REFERENCE_TEXT).strip(),
                }]
            else:
                # 没有本地音频文件，回退到 local_audio_name
                local_path = _resolve_local_audio(local_audio_name)
                refs = [{
                    "source": f"models/mp3：{local_path.name}",
                    "local_path": local_path,
                    "ref_text": str(kwargs.get(_speaker_ref_text_name(1)) or DEFAULT_REFERENCE_TEXT).strip(),
                }]

        prepared: list[dict[str, Any]] = []
        for index, ref in enumerate(refs, start=1):
            _send_status(unique_id, f"正在准备参考音频 {index}/{len(refs)}", 0.16)
            if "audio" in ref:
                tensor = _comfy_audio_to_tensor(ref["audio"], sr)
            else:
                audio_np, source_sr = _read_audio_file(ref["local_path"])
                tensor = _numpy_to_reference_tensor(audio_np, source_sr, sr)
            tensor = _normalize_reference(tensor, bool(normalize_reference), float(reference_dbfs)).to(model.device)
            duration = float(tensor.shape[-1]) / float(sr)
            if duration > 30:
                _send_status(unique_id, f"提示：参考音频 {index} 时长 {duration:.1f} 秒，超过推荐 30 秒。", 0.18)
            prepared.append({
                "audio": tensor,
                "ref_text": str(ref.get("ref_text") or "").strip(),
                "source": ref.get("source") or f"参考音频 {index}",
                "duration": duration,
            })
        return prepared

    def _build_turns(self, text: str, speaker_count: int) -> list[tuple[int, str]]:
        raw_text = str(text or "").strip()
        if not raw_text:
            raise RuntimeError("合成文本不能为空。")
        turns = _parse_dialogue_lines(raw_text)
        if not turns:
            if speaker_count > 1:
                raise RuntimeError("连接多个参考音频时，合成文本需要使用 [speaker_1]:、[speaker_2]: 这样的说话人标签。")
            return [(0, raw_text)]
        max_speaker = max(speaker for speaker, _ in turns)
        if max_speaker >= speaker_count:
            raise RuntimeError(f"文本使用了 speaker_{max_speaker + 1}，但当前只有 {speaker_count} 路参考音频。")
        return turns

    def generate(
        self,
        model_path,
        text,
        local_audio_name,
        steps,
        guidance_strength,
        guidance_method,
        device,
        dtype,
        attention,
        seed,
        pause_after_speaker,
        reference_dbfs,
        mp3_filename_prefix="audio/GJJ_LongCat",
        mp3_quality="320k",
        unique_id=None,
        extra_pnginfo=None,
        **kwargs,
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

        normalize_reference = bool(props.get("normalize_reference", True))
        keep_model_loaded = bool(props.get("keep_model_loaded", True))
        started_at = time.perf_counter()
        cancel_event.clear()
        pbar = None
        connected_refs = _collect_connected_references(kwargs)
        reference_mode = "输入音频" if connected_refs else "models/mp3"
        try:
            _check_interrupt()
            _send_status(unique_id, "1/5 正在加载 LongCat AudioDiT 模型...", 0.06)
            model, tokenizer = _get_model(
                str(model_path),
                str(device),
                str(dtype),
                str(attention),
                bool(keep_model_loaded),
                unique_id=unique_id,
            )
            sr = int(model.config.sampling_rate)
            full_hop = int(model.config.latent_hop)
            max_duration = float(model.config.max_wav_duration)

            _send_status(unique_id, f"2/5 正在准备参考音频：{reference_mode}", 0.14)
            references = self._prepare_references(
                model,
                connected_refs,
                str(local_audio_name or ""),
                bool(normalize_reference),
                float(reference_dbfs),
                kwargs,
                unique_id,
            )
            turns = self._build_turns(text, len(references))
            total_steps = max(1, len(turns))
            pbar = _new_progress_bar(total_steps)
            _send_status(unique_id, f"3/5 解析到 {len(references)} 个说话人，{len(turns)} 段文本。", 0.24)

            audio_turns: list[np.ndarray] = []
            for line_idx, (speaker_idx, line_text) in enumerate(turns):
                _check_interrupt()
                ref = references[speaker_idx]
                ref_audio = ref["audio"]
                ref_text = ref["ref_text"]
                line_norm = normalize_text(line_text)
                ref_norm = normalize_text(ref_text) if ref_text else ""
                full_text = f"{ref_norm} {line_norm}" if ref_norm else line_norm

                _send_status(
                    unique_id,
                    f"4/5 正在合成 {line_idx + 1}/{len(turns)}：speaker_{speaker_idx + 1}",
                    0.24 + 0.66 * ((line_idx + 1) / total_steps),
                )
                inputs = tokenizer([full_text], padding="longest", return_tensors="pt")
                input_ids = inputs.input_ids.to(model.device)
                attention_mask = inputs.attention_mask.to(model.device)

                off = 3
                prompt_wav = ref_audio.clone()
                if prompt_wav.shape[-1] % full_hop != 0:
                    prompt_wav = F.pad(prompt_wav, (0, full_hop - prompt_wav.shape[-1] % full_hop))
                prompt_wav = F.pad(prompt_wav, (0, full_hop * off))
                with torch.no_grad():
                    prompt_latent = model.vae.encode(prompt_wav.unsqueeze(0))
                if off:
                    prompt_latent = prompt_latent[..., :-off]
                prompt_dur = int(prompt_latent.shape[-1])
                prompt_time = prompt_dur * full_hop / sr

                dur_sec = approx_duration_from_text(line_norm, max_duration=max_duration - prompt_time)
                if ref_norm:
                    approx_prompt = approx_duration_from_text(ref_norm, max_duration=max_duration)
                    ratio = np.clip(prompt_time / max(approx_prompt, 0.1), 1.0, 1.5)
                    dur_sec = float(dur_sec * ratio)
                duration = int(dur_sec * sr // full_hop)
                total_duration = min(duration + prompt_dur, int(max_duration * sr // full_hop))

                actual_seed = int(seed) + line_idx if int(seed) != 0 else int(torch.randint(0, 2**31, (1,)).item()) + line_idx
                torch.manual_seed(actual_seed)
                if torch.cuda.is_available():
                    torch.cuda.manual_seed(actual_seed)

                with torch.no_grad():
                    output = model(
                        input_ids=input_ids,
                        attention_mask=attention_mask,
                        prompt_audio=ref_audio.unsqueeze(0),
                        duration=total_duration,
                        steps=int(steps),
                        cfg_strength=float(guidance_strength),
                        guidance_method=str(guidance_method),
                        seed=actual_seed,
                    )
                audio_turns.append(output.waveform.squeeze().detach().cpu().numpy().astype(np.float32, copy=False))
                _update_progress(pbar, line_idx + 1, total_steps)

            _send_status(unique_id, "5/6 正在拼接输出音频...", 0.92)
            if not audio_turns:
                raise RuntimeError("没有生成任何有效音频片段。")
            if float(pause_after_speaker) > 0 and len(audio_turns) > 1:
                silence = np.zeros(int(float(pause_after_speaker) * sr), dtype=np.float32)
                output_audio = audio_turns[0]
                for turn in audio_turns[1:]:
                    output_audio = np.concatenate([output_audio, silence, turn], axis=0)
            else:
                output_audio = np.concatenate(audio_turns, axis=0)

            result = numpy_audio_to_comfy(output_audio, sr)
            _send_status(unique_id, "6/6 正在保存 MP3...", 0.97)
            audio_ui = _save_audio_mp3_ui(result, str(mp3_filename_prefix), str(mp3_quality))
            _send_audio_preview(unique_id, audio_ui)
            elapsed = time.perf_counter() - started_at
            _send_status(unique_id, f"完成：{len(references)} 个说话人，输出 {len(output_audio) / sr:.2f} 秒，耗时 {elapsed:.2f} 秒。", 1.0)
            return {"ui": audio_ui, "result": (result,)}
        except Exception as exc:
            report = get_report_from_exception(exc)
            if report:
                _send_status(unique_id, "执行失败，请查看上方面板", 1.0)
                send_dependency_model_notice(report, unique_id=unique_id)
                raise RuntimeError(report.get("warning_message") or "运行环境缺失。") from exc

            _send_status(unique_id, f"执行失败：{exc}", 1.0)
            detailed_error = (
                "LongCat AudioDiT 单节点执行失败。\n"
                f"参考来源：{reference_mode}\n"
                f"模型：{model_path}\n"
                f"详细错误：{exc}"
            )
            _send_error_to_frontend(unique_id, detailed_error)
            raise RuntimeError(detailed_error) from exc
        finally:
            if not bool(keep_model_loaded):
                unload_model()
            else:
                offload_model_to_cpu()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LongCatAudioDiTTTS}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·📢[多人]语音克隆TTS (LongCat)"}
