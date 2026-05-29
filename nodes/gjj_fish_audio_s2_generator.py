from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

import folder_paths
import numpy as np
import torch
from .common_utils.dependency_checker import (
    build_dependency_model_report,
    check_dependencies,
    get_report_from_exception,
    raise_dependency_model_error,
    send_dependency_model_notice,
)

# 延迟导入 soundfile，避免缺失时导致整个模块无法加载
# import soundfile as sf  # 在函数内部导入

from .gjj_fish_audio_s2_loader import (
    HF_MODELS,
    LOCAL_MODEL_PLACEHOLDER,
    _register_folder,
    _strip_auto_download_suffix,
    audio_bytes_from_comfy,
    get_model_names,
    load_engine,
    numpy_audio_to_comfy,
    resolve_device,
)
from .gjj_fish_audio_s2_model_cache import (
    cancel_event,
    get_cache_key,
    get_cached_engine,
    is_offloaded,
    offload_engine_to_cpu,
    resume_engine_to_cuda,
    set_cached_engine,
    unload_engine,
)

NODE_NAME = "GJJ_FishAudioS2Generator"
MAX_SPEAKERS = 10
AUDIO_PREFIX = "speaker_"
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"}
MISSING_AUDIO_CHOICE = "[未找到models/mp3音频]"
DEFAULT_REFERENCE_TEXT = "人生不如意十有八九。要么看得开，要么就认栽！"
DEFAULT_MAX_NEW_TOKENS = 1024
MP3_QUALITY_OPTIONS = ["320k", "128k", "V0"]
MODES = ["单人克隆", "普通TTS", "多说话人克隆"]
LANGUAGES = [
    "auto", "en", "zh", "ja", "ko", "es", "pt", "ar", "ru", "fr", "de",
    "it", "tr", "nl", "sv", "no", "da", "fi", "pl", "hi", "vi", "th",
    "id", "ms", "uk", "bg", "hr", "cs", "sk", "sl", "ro", "hu", "et",
    "lv", "lt", "el", "he", "fa", "bn", "ta", "te", "kn", "ml", "si",
    "my", "km", "am", "ka", "az", "kk", "mn", "sw", "yo", "eu", "ca",
    "gl", "cy", "la", "sa", "ur", "ne", "tl", "jw",
]
NODE_DISPLAY_NAME = "📢[语气]语音克隆TTS(FishAudioS2)"
MODEL_DOWNLOAD_URL = "https://huggingface.co/fishaudio"
DEPENDENCY_SPECS = [
    {"module_name": "transformers", "package_name": "transformers", "display_name": "transformers", "description": "Fish Audio S2 文本语义模型依赖。"},
    {"module_name": "loguru", "package_name": "loguru", "display_name": "loguru", "description": "Fish Audio S2 运行日志依赖。"},
    {"module_name": "pydantic", "package_name": "pydantic", "display_name": "pydantic", "description": "Fish Audio S2 请求结构依赖。"},
    {"module_name": "tiktoken", "package_name": "tiktoken", "display_name": "tiktoken", "description": "Fish Audio S2 文本编码依赖。"},
    {"module_name": "hydra", "package_name": "hydra-core", "display_name": "hydra-core", "description": "Fish Audio S2 配置系统依赖。"},
    {"module_name": "pyrootutils", "package_name": "pyrootutils", "display_name": "pyrootutils", "description": "Fish Audio S2 项目路径依赖。"},
    {"module_name": "omegaconf", "package_name": "omegaconf", "display_name": "omegaconf", "description": "Fish Audio S2 配置解析依赖。"},
    {"module_name": "dac", "package_name": "descript-audio-codec", "display_name": "descript-audio-codec", "description": "Fish Audio S2 DAC 编解码依赖。"},
    {"module_name": "audiotools", "package_name": "descript-audiotools", "display_name": "descript-audiotools", "description": "Fish Audio S2 音频工具依赖。"},
    {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "Fish Audio S2 音频读写依赖。"},
    {"module_name": "librosa", "package_name": "librosa", "display_name": "librosa", "description": "Fish Audio S2 音频处理依赖。"},
    {"module_name": "torchvision", "package_name": "torchvision", "display_name": "torchvision", "description": "Fish Audio S2 运行时依赖。"},
    {"module_name": "datasets", "package_name": "datasets", "display_name": "datasets", "description": "Fish Audio S2 数据处理依赖。"},
    {"module_name": "pyarrow", "package_name": "pyarrow", "display_name": "pyarrow", "description": "Fish Audio S2 数据缓存依赖。"},
    {"module_name": "google.protobuf", "package_name": "protobuf", "display_name": "protobuf", "description": "Fish Audio S2 模型序列化依赖。"},
    {"module_name": "natsort", "package_name": "natsort", "display_name": "natsort", "description": "Fish Audio S2 文件排序依赖。"},
    {"module_name": "loralib", "package_name": "loralib", "display_name": "loralib", "description": "Fish Audio S2 LoRA 运行依赖。"},
]
OPTIONAL_DEPENDENCY_SPECS = [
    {"module_name": "huggingface_hub", "package_name": "huggingface_hub", "display_name": "huggingface_hub", "description": "仅自动下载模型时需要；使用本地模型不需要。"},
    {"module_name": "imageio_ffmpeg", "package_name": "imageio-ffmpeg", "display_name": "imageio-ffmpeg", "description": "音频/MP3 回退处理依赖；基础 AUDIO 输出不依赖它。"},
    {"module_name": "av", "package_name": "av", "display_name": "PyAV", "description": "soundfile 无法读取本地参考音频时的回退解码依赖。"},
]


_register_folder()


def _collect_missing_dependencies(specs: list[dict[str, str]]) -> list[dict[str, str]]:
    missing_dependencies: list[dict[str, str]] = []
    for spec in specs:
        available, _ = check_dependencies([spec["module_name"]], NODE_DISPLAY_NAME)
        if not available:
            missing_dependencies.append(spec)
    return missing_dependencies


def _collect_dependency_state() -> tuple[bool, list[dict[str, str]], list[dict[str, str]]]:
    missing_dependencies = _collect_missing_dependencies(DEPENDENCY_SPECS)
    optional_missing_dependencies = _collect_missing_dependencies(OPTIONAL_DEPENDENCY_SPECS)
    return (not missing_dependencies), missing_dependencies, optional_missing_dependencies


def _collect_model_state() -> tuple[bool, list[dict[str, str]]]:
    model_names = get_model_names()
    if model_names and model_names[0] != LOCAL_MODEL_PLACEHOLDER:
        return True, []
    preferred = HF_MODELS.get("s2-pro", {})
    return False, [
        {
            "label": "Fish S2 模型",
            "subdir": "fishaudioS2",
            "filename": "s2-pro / s2-base / 其它 S2 变体",
            "description": preferred.get("description") or "请放到 models/fishaudioS2/。",
        }
    ]


_DEPENDENCIES_AVAILABLE, _MISSING_DEPENDENCIES, _OPTIONAL_MISSING_DEPENDENCIES = _collect_dependency_state()
_MODELS_AVAILABLE, _MISSING_MODELS = _collect_model_state()
_REQUIRED_INSTALL_PACKAGES = [spec["package_name"] for spec in DEPENDENCY_SPECS]
_OPTIONAL_INSTALL_PACKAGES = [spec["package_name"] for spec in OPTIONAL_DEPENDENCY_SPECS]
_ENV_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_MISSING_DEPENDENCIES,
    missing_models=_MISSING_MODELS,
    install_packages=_REQUIRED_INSTALL_PACKAGES,
    optional_dependencies=_OPTIONAL_MISSING_DEPENDENCIES,
    optional_install_packages=_OPTIONAL_INSTALL_PACKAGES,
    description="Fish Audio S2 一体式 TTS、单人语音克隆和多说话人语音克隆节点。",
)
_HELP_NOTICE = (
    f"{_ENV_REPORT['warning_message']}\n请参考下方依赖、模型说明和安装命令。"
    if not _ENV_REPORT.get("available", True)
    else ""
)
_DESCRIPTION_READY = """
📢[语气]语音克隆TTS(FishAudioS2)

Fish Audio S2 一体式 TTS、单人语音克隆和多说话人语音克隆节点。

📁 模型目录：
models/fishaudioS2/

🌏模型下载：
https://huggingface.co/fishaudio

💡 使用提示：
- 支持普通 TTS、单人克隆、多说话人克隆三种模式
- 单人克隆可用本地参考音频或外部输入；多说话人支持最多 10 人
- 节点会自动保存 MP3 预览，便于快速试听
""".strip()
DESCRIPTION = (
    _DESCRIPTION_READY
    if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
    else f"{_ENV_REPORT['warning_message']}\n\n{_DESCRIPTION_READY}"
)


def _resolve_max_new_tokens(value: Any) -> int:
    try:
        resolved = int(float(value))
    except Exception:
        resolved = DEFAULT_MAX_NEW_TOKENS
    if resolved <= 0:
        return DEFAULT_MAX_NEW_TOKENS
    return max(64, min(4096, resolved))


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


def _send_error_to_frontend(unique_id: Any, error_message: str):
    """将普通执行错误发送给前端状态区"""
    try:
        from server import PromptServer

        PromptServer.instance.send_sync("gjj_fish_audio_s2_error", {
            "node": str(unique_id),
            "error": error_message,
        })
    except Exception:
        pass


def _save_audio_mp3_ui(audio: dict[str, Any], filename_prefix: str, quality: str = "320k") -> dict[str, Any]:
    prefix = str(filename_prefix or "").strip() or "audio/GJJ_FishAudioS2"
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

        return comfy.utils.ProgressBar(max(1, int(total)))
    except Exception:
        return None


def _update_progress(pbar: Any, current: int, total: int) -> None:
    if pbar is None:
        return
    try:
        pbar.update_absolute(int(current), int(total))
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
    items: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
            continue
        items.append(str(path.relative_to(root)).replace("/", "\\"))
    return items


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
                "description": "Fish Audio S2 读取本地参考音频建议安装 soundfile。",
            })
        if isinstance(av_exc, (ImportError, ModuleNotFoundError)):
            missing_dependencies.append({
                "module_name": "av",
                "package_name": "av",
                "display_name": "PyAV",
                "description": "Fish Audio S2 回退音频解码需要 av。",
            })
        if missing_dependencies:
            raise_dependency_model_error(
                node_name="📢 语音克隆TTS(FishAudioS2)",
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


def _local_audio_to_comfy_audio(name: str) -> dict[str, Any]:
    path = _resolve_local_audio(name)
    audio_np, sample_rate = _read_audio_file(path)
    return numpy_audio_to_comfy(audio_np, sample_rate)


def _speaker_audio_name(index: int) -> str:
    return f"{AUDIO_PREFIX}{index:02d}_audio"


def _speaker_ref_text_name(index: int) -> str:
    return f"{AUDIO_PREFIX}{index:02d}_ref_text"


def _build_optional_inputs() -> dict[str, tuple[str, dict[str, Any]]]:
    optional: dict[str, tuple[str, dict[str, Any]]] = {}
    for index in range(1, MAX_SPEAKERS + 1):
        optional[_speaker_audio_name(index)] = ("AUDIO", {
            "forceInput": True,
            "display_name": f"参考音频 {index}",
            "tooltip": f"第 {index} 个说话人的参考音频。单人克隆只需要第 1 路，多说话人按 [speaker_{index}]: 匹配。",
        })
        optional[_speaker_ref_text_name(index)] = ("STRING", {
            "forceInput": True,
            "default": "",
            "display_name": f"参考文本 {index}",
            "tooltip": f"第 {index} 个参考音频对应的文字；未连接时使用“默认参考文本”。",
        })
    return optional


def _valid_audio(value: Any) -> bool:
    return isinstance(value, dict) and value.get("waveform") is not None and value.get("sample_rate") is not None


def _collect_connected_references(kwargs: dict[str, Any], fallback_reference_text: str) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    fallback_text = str(fallback_reference_text or "").strip()
    for index in range(1, MAX_SPEAKERS + 1):
        audio = kwargs.get(_speaker_audio_name(index))
        if not _valid_audio(audio):
            continue
        ref_text = str(kwargs.get(_speaker_ref_text_name(index)) or fallback_text).strip()
        refs.append({
            "speaker": index - 1,
            "source": f"输入音频 {index}",
            "audio": audio,
            "ref_text": ref_text,
        })
    return refs


def _pick_default_model(models: list[str]) -> str:
    preferred_names = ("s2-pro-fp8", "s2-pro-bnb-nf4", "s2-pro")
    for preferred in preferred_names:
        for item in models:
            if _strip_auto_download_suffix(str(item)) == preferred:
                return item
    return models[0] if models else ""


def _parse_dialogue_lines(text: str) -> list[tuple[int, str]]:
    tag_re = re.compile(r"^\s*(?:\[speaker_(\d+)\]|<\|speaker:(\d+)\|>):?\s*(.*)$")
    turns: list[tuple[int, str]] = []
    current_speaker: int | None = None
    current_parts: list[str] = []
    for raw in str(text or "").splitlines():
        match = tag_re.match(raw)
        if match:
            if current_speaker is not None and current_parts:
                turns.append((current_speaker, " ".join(current_parts).strip()))
            if match.group(1) is not None:
                current_speaker = int(match.group(1)) - 1
            else:
                current_speaker = int(match.group(2))
            current_parts = [match.group(3)] if match.group(3).strip() else []
            continue
        stripped = raw.strip()
        if stripped and current_speaker is not None:
            current_parts.append(stripped)
    if current_speaker is not None and current_parts:
        turns.append((current_speaker, " ".join(current_parts).strip()))
    return [(speaker, line) for speaker, line in turns if line]


def _get_engine(model_path, device, precision, attention, compile_model, keep_loaded=False, unique_id=None):
    model_name = _strip_auto_download_suffix(str(model_path))
    key = get_cache_key(model_path, device, precision, attention, model_name, compile_model)
    cached_engine, cached_key = get_cached_engine()
    if cached_engine is not None and cached_key == key:
        if is_offloaded():
            device_str, _ = resolve_device(device)
            resume_engine_to_cuda(device_str)
        return cached_engine
    if cached_engine is not None:
        unload_engine()
    engine = load_engine(model_path, device, precision, attention, bool(compile_model), unique_id=unique_id)
    set_cached_engine(engine, key, keep_loaded=bool(keep_loaded))
    return engine


class GJJ_FishAudioS2Generator:
    CATEGORY = "GJJ/Audio"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = DESCRIPTION
    SEARCH_ALIASES = ["Fish Audio", "Fish S2", "TTS", "语音克隆", "多说话人", "文字转语音"]
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("合成音频",)
    OUTPUT_TOOLTIPS = ("Fish Audio S2 合成后的 ComfyUI 音频对象；节点内部也会保存 MP3 并显示播放器。",)
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": _DESCRIPTION_READY,
        "notice": _HELP_NOTICE,
        "warning_message": _ENV_REPORT["warning_message"] if not _ENV_REPORT.get("available", True) else "",
        "install_cmd": _ENV_REPORT["install_cmd"] if not _ENV_REPORT.get("available", True) else "",
        "copy_text": _ENV_REPORT["copy_text"] if not _ENV_REPORT.get("available", True) else "",
        "copy_label": _ENV_REPORT["copy_label"] if not _ENV_REPORT.get("available", True) else "",
        "notice_level": _ENV_REPORT.get("notice_level", "ok"),
        "optional_install_cmd": _ENV_REPORT.get("optional_install_cmd", ""),
        "model_download_url": MODEL_DOWNLOAD_URL,
        "missing_dependencies": _MISSING_DEPENDENCIES,
        "optional_dependencies": _OPTIONAL_MISSING_DEPENDENCIES,
        "missing_models": _MISSING_MODELS,
        "dependencies": [
            "Fish Speech vendor 运行时源码由 GJJ 内置，不需要额外安装 fish-speech。",
            "核心推理需要 transformers、hydra-core、descript-audio-codec、soundfile 等 Python 依赖。",
            "huggingface_hub、av、imageio-ffmpeg 只用于自动下载或回退音频处理；本地模型和常规音频路径可不依赖它们。",
        ],
        "models": _MISSING_MODELS or [
            {
                "label": "s2-pro",
                "value": "models/fishaudioS2/s2-pro",
                "tooltip": "推荐，音质最佳。",
            },
            {
                "label": "s2-pro-fp8",
                "value": "models/fishaudioS2/s2-pro-fp8",
                "tooltip": "FP8 量化，显存占用更低。",
            },
        ],
        "tips": [
            "普通 TTS 不需要参考音频；单人克隆优先使用第 1 路输入，没有时才读本地参考音频。",
            "多说话人模式请使用 [speaker_1]:、[speaker_2]: 这样的行首标签。",
            "首次运行前建议先把本地模型放好，避免执行期在线下载带来的等待。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        model_names = get_model_names()
        audio_choices = _audio_choices()
        default_audio = next((item for item in audio_choices if item), "")
        return {
            "required": {
                "mode": (MODES, {
                    "default": "单人克隆",
                    "display_name": "合成模式",
                    "tooltip": "普通TTS不使用参考音频；单人克隆使用第 1 路参考音频或本地参考音频；多说话人克隆按 [speaker_1]: 这样的标签逐句合成。",
                }),
                "model_path": (model_names, {
                    "default": _pick_default_model(model_names),
                    "display_name": "Fish S2模型",
                    "tooltip": "只显示 models/fishaudioS2 下已下载完整的本地模型；FP8 模型会优先显示。",
                }),
                "text": ("STRING", {
                    "multiline": True,
                    "default": "你好！[excited] 这是 Fish Audio S2 的语音克隆测试。",
                    "display_name": "合成文本",
                    "tooltip": "要合成的文本。多说话人模式请使用 [speaker_1]:、[speaker_2]: 这样的行首标签。",
                }),
                "local_audio_name": (audio_choices, {
                    "default": default_audio,
                    "display_name": "本地参考音频",
                    "tooltip": "没有连接第 1 路参考音频时，从 models/mp3 选择一段音频作为单人克隆或 speaker_1 的参考。",
                }),
                "default_reference_text": ("STRING", {
                    "multiline": False,
                    "default": DEFAULT_REFERENCE_TEXT,
                    "display_name": "默认参考文本",
                    "tooltip": "参考音频对应的文字。未连接每路参考文本时，会使用这里作为克隆提示。",
                }),
                "language": (LANGUAGES, {
                    "default": "auto",
                    "display_name": "语言提示",
                    "tooltip": "auto 表示让模型自动判断；也可以指定 zh、en、ja 等语言代码。",
                }),
                "device": (["auto", "cuda", "cpu", "mps"], {
                    "default": "auto",
                    "display_name": "运行设备",
                    "tooltip": "auto 会优先选择 CUDA，其次 MPS，最后 CPU。",
                }),
                "precision": (["auto", "bfloat16", "float16", "float32"], {
                    "default": "auto",
                    "display_name": "计算精度",
                    "tooltip": "auto 会按模型与设备选择精度；CUDA 上通常推荐 bfloat16。",
                }),
                "attention": (["auto", "sdpa", "sage_attention", "flash_attention"], {
                    "default": "auto",
                    "display_name": "注意力实现",
                    "tooltip": "默认 auto。sage_attention 或 flash_attention 需要当前环境已安装对应加速库；BNB 模型会强制使用 sdpa。",
                }),
                "max_new_tokens": ("INT", {
                    "default": DEFAULT_MAX_NEW_TOKENS,
                    "min": 0,
                    "max": 4096,
                    "step": 64,
                    "display_name": "最大音频Token",
                    "tooltip": "默认 1024。旧工作流里的 0 会按 1024 处理，避免底层使用 3 万级超大上限卡住。",
                }),
                "chunk_length": ("INT", {
                    "default": 200,
                    "min": 100,
                    "max": 300,
                    "step": 10,
                    "display_name": "分块长度",
                    "tooltip": "Fish S2 迭代合成分块长度。较小会更快出声，较大有利于长句连贯。",
                }),
                "temperature": ("FLOAT", {
                    "default": 0.7,
                    "min": 0.1,
                    "max": 1.0,
                    "step": 0.05,
                    "display_name": "采样温度",
                    "tooltip": "越低越稳定，越高变化越大。",
                }),
                "top_p": ("FLOAT", {
                    "default": 0.7,
                    "min": 0.1,
                    "max": 1.0,
                    "step": 0.05,
                    "display_name": "Top-P",
                    "tooltip": "核采样截断值。",
                }),
                "repetition_penalty": ("FLOAT", {
                    "default": 1.2,
                    "min": 0.9,
                    "max": 2.0,
                    "step": 0.05,
                    "display_name": "重复惩罚",
                    "tooltip": "提高可减少重复发音或重复词。",
                }),
                "seed": ("INT", {
                    "default": 42,
                    "min": 0,
                    "max": 2**31 - 1,
                    "display_name": "随机种子",
                    "tooltip": "固定种子可以复现结果。多说话人模式会按句子递增种子。",
                }),
                "pause_after_speaker": ("FLOAT", {
                    "default": 0.4,
                    "min": 0.0,
                    "max": 5.0,
                    "step": 0.1,
                    "display_name": "说话间隔秒数",
                    "tooltip": "多说话人模式下，相邻说话片段之间插入的静音秒数。",
                }),
                "mp3_filename_prefix": ("STRING", {
                    "default": "audio/GJJ_FishAudioS2",
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
                **_build_optional_inputs(),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def _prepare_references(
        self,
        kwargs: dict[str, Any],
        default_reference_text: str,
        local_audio_name: str,
        unique_id: Any,
    ):
        from fish_speech.utils.schema import ServeReferenceAudio

        connected_refs = _collect_connected_references(kwargs, default_reference_text)
        refs: list[dict[str, Any]] = []
        if connected_refs:
            refs.extend(connected_refs)
        else:
            _send_status(unique_id, "正在读取本地参考音频", 0.18)
            refs.append({
                "speaker": 0,
                "source": "models/mp3",
                "audio": _local_audio_to_comfy_audio(local_audio_name),
                "ref_text": str(default_reference_text or "").strip(),
            })

        prepared: list[tuple[int, ServeReferenceAudio]] = []
        for index, ref in enumerate(refs, start=1):
            _check_interrupt()
            _send_status(unique_id, f"正在编码参考音频 {index}/{len(refs)}", 0.20)
            prepared.append((
                int(ref["speaker"]),
                ServeReferenceAudio(
                    audio=audio_bytes_from_comfy(ref["audio"]),
                    text=str(ref.get("ref_text") or "").strip(),
                ),
            ))
        return prepared

    def _generate_one(
        self,
        engine,
        request_text: str,
        references,
        max_new_tokens: int,
        chunk_length: int,
        temperature: float,
        top_p: float,
        repetition_penalty: float,
        seed: int,
    ) -> tuple[np.ndarray, int]:
        from fish_speech.utils.schema import ServeTTSRequest

        request = ServeTTSRequest(
            text=request_text,
            references=list(references or []),
            reference_id=None,
            max_new_tokens=_resolve_max_new_tokens(max_new_tokens),
            chunk_length=int(chunk_length),
            top_p=float(top_p),
            repetition_penalty=float(repetition_penalty),
            temperature=float(temperature),
            seed=int(seed),
            streaming=False,
            format="wav",
        )
        audio_out = None
        sample_rate = 44100
        for result in engine.inference(request):
            _check_interrupt()
            if result.code == "error":
                raise RuntimeError(f"Fish S2 推理失败：{result.error}")
            if result.code == "final":
                sample_rate, audio_out = result.audio
        if audio_out is None:
            raise RuntimeError("Fish S2 没有生成有效音频。")
        return np.asarray(audio_out, dtype=np.float32), int(sample_rate)

    def _read_bool_properties(self, extra_pnginfo, unique_id):
        """从 workflow 的 properties 中读取 Boolean 值"""
        if not isinstance(extra_pnginfo, dict):
            return None
        workflow = extra_pnginfo.get("workflow")
        if not isinstance(workflow, dict):
            return None
        nodes = workflow.get("nodes")
        if not isinstance(nodes, list):
            return None

        for node in nodes:
            if not isinstance(node, dict):
                continue
            # 查找当前节点
            if unique_id is not None and str(node.get("id")) != str(unique_id):
                continue
            if node.get("type") != NODE_NAME:
                continue

            # 读取 properties
            properties = node.get("properties")
            if isinstance(properties, dict):
                return {
                    "keep_model_loaded": properties.get("keep_model_loaded"),
                    "offload_to_cpu": properties.get("offload_to_cpu"),
                    "compile_model": properties.get("compile_model"),
                }
        return None

    def generate(
        self,
        mode,
        model_path,
        default_reference_text,
        text,
        local_audio_name,
        language,
        device,
        precision,
        attention,
        max_new_tokens,
        chunk_length,
        temperature,
        top_p,
        repetition_penalty,
        seed,
        pause_after_speaker,
        mp3_filename_prefix="audio/GJJ_FishAudioS2",
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

        keep_model_loaded = bool(props.get("keep_model_loaded", True))
        offload_to_cpu = bool(props.get("offload_to_cpu", False))
        compile_model = bool(props.get("compile_model", False))

        started_at = time.perf_counter()
        cancel_event.clear()
        pbar = None
        resolved_mode = str(mode or "单人克隆")
        try:
            if not str(text or "").strip():
                raise RuntimeError("合成文本不能为空。")

            _check_interrupt()
            _send_status(unique_id, "1/5 正在加载 Fish Audio S2 模型...", 0.08)
            engine = _get_engine(
                str(model_path),
                str(device),
                str(precision),
                str(attention),
                bool(compile_model),
                bool(keep_model_loaded),
                unique_id=unique_id,
            )

            prompt_prefix = f"[{language}] " if str(language or "auto") != "auto" else ""

            if resolved_mode == "普通TTS":
                _send_status(unique_id, "2/5 正在准备普通 TTS 请求...", 0.24)
                pbar = _new_progress_bar(3)
                _update_progress(pbar, 1, 3)
                _send_status(unique_id, "3/5 正在合成语音...", 0.42)
                audio_np, sample_rate = self._generate_one(
                    engine,
                    f"{prompt_prefix}{str(text).strip()}",
                    [],
                    int(max_new_tokens),
                    int(chunk_length),
                    float(temperature),
                    float(top_p),
                    float(repetition_penalty),
                    int(seed),
                )
                _update_progress(pbar, 2, 3)
            elif resolved_mode == "多说话人克隆":
                _send_status(unique_id, "2/5 正在准备多说话人参考音频...", 0.18)
                references = dict(self._prepare_references(kwargs, str(default_reference_text), str(local_audio_name), unique_id))
                turns = _parse_dialogue_lines(str(text))
                if not turns:
                    raise RuntimeError("多说话人克隆需要使用 [speaker_1]:、[speaker_2]: 这样的行首标签。")
                missing = sorted({speaker + 1 for speaker, _ in turns if speaker not in references})
                if missing:
                    raise RuntimeError(f"文本使用了 speaker_{missing[0]}，但没有对应的参考音频。")

                total_steps = max(1, len(turns))
                pbar = _new_progress_bar(total_steps)
                audio_turns: list[np.ndarray] = []
                sample_rate = 44100
                for line_idx, (speaker_idx, line_text) in enumerate(turns):
                    _check_interrupt()
                    _send_status(
                        unique_id,
                        f"3/5 正在合成 {line_idx + 1}/{len(turns)}：speaker_{speaker_idx + 1}",
                        0.28 + 0.58 * ((line_idx + 1) / total_steps),
                    )
                    line_audio, sample_rate = self._generate_one(
                        engine,
                        f"{prompt_prefix}{line_text}",
                        [references[speaker_idx]],
                        int(max_new_tokens),
                        int(chunk_length),
                        float(temperature),
                        float(top_p),
                        float(repetition_penalty),
                        int(seed) + line_idx,
                    )
                    audio_turns.append(line_audio)
                    _update_progress(pbar, line_idx + 1, total_steps)

                _send_status(unique_id, "4/5 正在拼接多说话人音频...", 0.90)
                if float(pause_after_speaker) > 0 and len(audio_turns) > 1:
                    silence = np.zeros(int(float(pause_after_speaker) * sample_rate), dtype=np.float32)
                    audio_np = audio_turns[0]
                    for turn in audio_turns[1:]:
                        audio_np = np.concatenate([audio_np, silence, turn], axis=0)
                else:
                    audio_np = np.concatenate(audio_turns, axis=0)
            else:
                _send_status(unique_id, "2/5 正在准备语音克隆参考音频...", 0.18)
                prepared_refs = self._prepare_references(kwargs, str(default_reference_text), str(local_audio_name), unique_id)
                if not prepared_refs:
                    raise RuntimeError("单人克隆需要参考音频。")
                _, reference = prepared_refs[0]
                pbar = _new_progress_bar(3)
                _update_progress(pbar, 1, 3)
                _send_status(unique_id, "3/5 正在合成克隆语音...", 0.42)
                audio_np, sample_rate = self._generate_one(
                    engine,
                    f"{prompt_prefix}{str(text).strip()}",
                    [reference],
                    int(max_new_tokens),
                    int(chunk_length),
                    float(temperature),
                    float(top_p),
                    float(repetition_penalty),
                    int(seed),
                )
                _update_progress(pbar, 2, 3)

            result = numpy_audio_to_comfy(audio_np, sample_rate)
            _send_status(unique_id, "5/5 正在保存 MP3...", 0.96)
            audio_ui = _save_audio_mp3_ui(result, str(mp3_filename_prefix), str(mp3_quality))
            _send_audio_preview(unique_id, audio_ui)
            elapsed = time.perf_counter() - started_at
            _send_status(unique_id, f"完成：输出 {len(audio_np) / sample_rate:.2f} 秒，耗时 {elapsed:.2f} 秒。", 1.0)
            return {"ui": audio_ui, "result": (result,)}
        except Exception as exc:
            report = get_report_from_exception(exc)
            if report:
                _send_status(unique_id, "执行失败，请查看上方面板", 1.0)
                send_dependency_model_notice(report, unique_id=unique_id)
                raise RuntimeError(report.get("warning_message") or "运行环境缺失。") from exc

            _send_status(unique_id, f"执行失败：{exc}", 1.0)
            detailed_error = (
                "🎵 Fish Audio S2 单节点执行失败。\n"
                f"模式：{resolved_mode}\n"
                f"模型：{model_path}\n\n"
                f"详细错误：{exc}"
            )
            _send_error_to_frontend(unique_id, detailed_error)
            raise RuntimeError(detailed_error) from exc
        finally:
            if not bool(keep_model_loaded):
                unload_engine()
            elif bool(offload_to_cpu):
                offload_engine_to_cpu()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_FishAudioS2Generator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·📢[语气]语音克隆TTS(FishAudioS2)"}
