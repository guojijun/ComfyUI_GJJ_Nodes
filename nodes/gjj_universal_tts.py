from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import html
import io
import importlib.util
import json
import logging
import os
import queue
import random
import re
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import time
import uuid
import wave
from io import BytesIO
from pathlib import Path
from typing import Any

import folder_paths
import numpy as np
import torch

from .common_utils.dependency_checker import (
    build_dependency_model_report,
    build_node_help_payload,
    check_dependencies,
    get_report_from_exception,
    raise_dependency_model_error,
    send_dependency_model_notice,
)


NODE_NAME = "GJJ_UniversalTTS"
NODE_DISPLAY_NAME = "📢 多功能文字转语音TTS"
MAX_REFERENCES = 10
AUDIO_PREFIX = "reference_"
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".webm", ".mp4", ".mov", ".mkv"}
MISSING_AUDIO_CHOICE = "[未找到 models/mp3 音频]"
MP3_QUALITY_OPTIONS = ["320k", "128k", "V0"]
BRANCHES = ["EdgeTTS", "FishAudioS2", "LongCat-1B", "LongCat3.5B", "Fun-CosyVoice3-0.5B-2512"]
TEXT_FORMATS = ["SRT", "VTT", "LRC", "JSON"]
AUDIO_OUTPUT_MODES = ["整体合并", "单个队列"]
DEFAULT_TEXT = "你好，这是一段多功能 TTS 节点生成的语音。"
DEFAULT_REFERENCE_TEXT = "人生不如意十有八九。要么看得开，要么就认栽！"
DEFAULT_SAMPLE_RATE = 24000
EDGE_HOST = "speech.platform.bing.com"
EDGE_PATH = "/consumer/speech/synthesize/readaloud/edge/v1"
EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
EDGE_OUTPUT_FORMAT = "riff-24khz-16bit-mono-pcm"
MAX_WS_PAYLOAD = 32 * 1024 * 1024

VOICE_IDS = {
    "[中文] zh-CN Xiaoxiao 女声": "zh-CN-XiaoxiaoNeural",
    "[中文] zh-CN Yunxi 男声": "zh-CN-YunxiNeural",
    "[中文] zh-CN Yunjian 男声": "zh-CN-YunjianNeural",
    "[中文] zh-CN Xiaoyi 女声": "zh-CN-XiaoyiNeural",
    "[中文] zh-CN Yunyang 男声": "zh-CN-YunyangNeural",
    "[中文] zh-HK HiuMaan 女声": "zh-HK-HiuMaanNeural",
    "[中文] zh-TW HsiaoChen 女声": "zh-TW-HsiaoChenNeural",
    "[英文] en-US Jenny 女声": "en-US-JennyNeural",
    "[英文] en-US Guy 男声": "en-US-GuyNeural",
    "[日文] ja-JP Nanami 女声": "ja-JP-NanamiNeural",
    "[韩文] ko-KR SunHi 女声": "ko-KR-SunHiNeural",
}

BRANCH_DEPENDENCIES = {
    "EdgeTTS": [],
    "FishAudioS2": [
        {"module_name": "transformers", "package_name": "transformers", "display_name": "transformers", "description": "Fish Audio S2 文本语义模型依赖。"},
        {"module_name": "loguru", "package_name": "loguru", "display_name": "loguru", "description": "Fish Audio S2 日志依赖。"},
        {"module_name": "pydantic", "package_name": "pydantic", "display_name": "pydantic", "description": "Fish Audio S2 请求结构依赖。"},
        {"module_name": "tiktoken", "package_name": "tiktoken", "display_name": "tiktoken", "description": "Fish Audio S2 文本编码依赖。"},
        {"module_name": "hydra", "package_name": "hydra-core", "display_name": "hydra-core", "description": "Fish Audio S2 配置系统依赖。"},
        {"module_name": "dac", "package_name": "descript-audio-codec", "display_name": "descript-audio-codec", "description": "Fish Audio S2 DAC 编解码依赖。"},
        {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "读取参考音频。"},
    ],
    "LongCat-1B": [
        {"module_name": "transformers", "package_name": "transformers", "display_name": "transformers", "description": "LongCat AudioDiT 文本与模型运行时。"},
        {"module_name": "safetensors", "package_name": "safetensors", "display_name": "safetensors", "description": "LongCat 权重读取依赖。"},
        {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "读取参考音频。"},
    ],
    "LongCat3.5B": [
        {"module_name": "transformers", "package_name": "transformers", "display_name": "transformers", "description": "LongCat AudioDiT 文本与模型运行时。"},
        {"module_name": "safetensors", "package_name": "safetensors", "display_name": "safetensors", "description": "LongCat 权重读取依赖。"},
        {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "读取参考音频。"},
    ],
    "Fun-CosyVoice3-0.5B-2512": [
        {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "读取参考音频。"},
        {"module_name": "yaml", "package_name": "pyyaml", "display_name": "pyyaml", "description": "CosyVoice3 配置解析依赖。"},
    ],
}

BRANCH_MODEL_HINTS = {
    "FishAudioS2": ("fishaudioS2", "s2-pro / s2-base / 其它 S2 变体"),
    "LongCat-1B": ("audiodit", "LongCat-AudioDiT-1B"),
    "LongCat3.5B": ("audiodit", "LongCat-AudioDiT-3.5B-*"),
    "Fun-CosyVoice3-0.5B-2512": ("cosyvoice", "Fun-CosyVoice3-0.5B-2512"),
}

_MODEL_CACHE: dict[str, Any] = {}
_LOGGER = logging.getLogger("GJJ.UniversalTTS")
_ROOT = Path(__file__).resolve().parents[1]
_VENDOR_ROOT = _ROOT / "vendor"
_FISH_VENDOR = _VENDOR_ROOT / "fish_speech"
_COSY_VENDOR = _VENDOR_ROOT / "cosyvoice3"
_AUDIODIT_VENDOR = _VENDOR_ROOT / "audiodit"
FISH_DECODER_FILE_NAMES = (
    "codec.pth",
    "firefly-gan-vq-fsq-8x1024-21hz-generator.pth",
    "decoder.pth",
    "vocoder.pth",
)
FISH_RUNTIME_PACKAGES = [
    "transformers", "loguru", "pydantic", "tiktoken", "hydra-core",
    "descript-audio-codec", "descript-audiotools", "soundfile", "pyrootutils",
    "omegaconf", "torchvision", "librosa", "pyarrow", "protobuf", "natsort",
    "loralib", "datasets",
]
LONGCAT_TOKENIZER_ID = "google/umt5-base"
LONGCAT_KNOWN_MODELS = {
    "LongCat-1B": "LongCat-AudioDiT-1B",
    "LongCat3.5B": "LongCat-AudioDiT-3.5B-bf16",
}


def _safe_filename(value: str, fallback: str = "reference") -> str:
    name = os.path.basename(str(value or "").strip()) or fallback
    name = re.sub(r'[<>:"/\\|?*\x00-\x1F]+', "_", name).strip(" .")
    return (name or fallback)[:160]


def _has_module(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def _ensure_sys_path(path: Path) -> None:
    text = str(path)
    if text not in sys.path:
        sys.path.insert(0, text)


def _ensure_vendor_package(package_name: str, vendor_parent: Path, unique_id: Any = None) -> None:
    if not vendor_parent.exists():
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[{
                "module_name": package_name,
                "package_name": "",
                "display_name": f"GJJ 内置 {package_name} 运行时",
                "description": f"vendor 目录缺失：{vendor_parent}",
            }],
            install_packages=[],
            description=f"未找到 GJJ vendor 运行时：{vendor_parent}",
            unique_id=unique_id,
            copy_text="",
            copy_label="",
        )
    _ensure_sys_path(vendor_parent)


def _missing_dependencies(branch: str) -> list[dict[str, str]]:
    missing: list[dict[str, str]] = []
    for spec in BRANCH_DEPENDENCIES.get(branch, []):
        available, _ = check_dependencies([spec["module_name"]], NODE_DISPLAY_NAME)
        if not available:
            missing.append(spec)
    return missing


def _models_root(subdir: str) -> Path:
    root = Path(folder_paths.models_dir) / subdir
    root.mkdir(parents=True, exist_ok=True)
    return root


def _branch_model_choices(branch: str) -> list[str]:
    hint = BRANCH_MODEL_HINTS.get(branch)
    if not hint:
        return [""]
    root = _models_root(hint[0])
    choices: list[str] = []
    for path in sorted(root.iterdir() if root.is_dir() else []):
        if path.name.startswith("."):
            continue
        if path.is_dir() or path.suffix.lower() in {".pt", ".pth", ".safetensors", ".bin", ".ckpt"}:
            choices.append(path.name)
    return choices or [hint[1]]


def _missing_models(branch: str, model_name: str = "") -> list[dict[str, str]]:
    hint = BRANCH_MODEL_HINTS.get(branch)
    if not hint:
        return []
    root = _models_root(hint[0])
    selected = str(model_name or "").strip()
    if selected and selected != hint[1] and (root / selected).exists():
        return []
    if any(root.iterdir()):
        return []
    return [{
        "label": f"{branch} 模型",
        "subdir": hint[0],
        "filename": hint[1],
        "description": f"请放到 models/{hint[0]}/。",
    }]


def _build_branch_report(branch: str, model_name: str = "", original_error: str = "") -> dict[str, Any]:
    missing_deps = _missing_dependencies(branch)
    missing_models = _missing_models(branch, model_name)
    return build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=missing_deps,
        missing_models=missing_models,
        install_packages=[spec["package_name"] for spec in missing_deps],
        description=f"{branch} 分支运行环境检查。",
        original_error=original_error,
    )


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

        PromptServer.instance.send_sync("gjj_node_audio", {"node": str(unique_id), "audio": audio_ui.get("audio", [])})
    except Exception:
        pass


def _save_audio_mp3_ui(audio: dict[str, Any], filename_prefix: str, quality: str = "320k") -> dict[str, Any]:
    try:
        from comfy_api.latest import UI

        selected_quality = quality if quality in MP3_QUALITY_OPTIONS else "320k"
        return UI.AudioSaveHelper.get_save_audio_ui(
            audio,
            filename_prefix=str(filename_prefix or "audio/GJJ_UniversalTTS"),
            cls=None,
            format="mp3",
            quality=selected_quality,
        ).as_dict()
    except Exception as exc:
        raise RuntimeError(f"保存 MP3 失败：{exc}") from exc


def _audio_to_tensor(audio: dict[str, Any]) -> tuple[torch.Tensor, int]:
    if not isinstance(audio, dict) or "waveform" not in audio or "sample_rate" not in audio:
        raise RuntimeError("输入不是有效的 ComfyUI AUDIO。")
    waveform = audio["waveform"]
    if not isinstance(waveform, torch.Tensor):
        waveform = torch.as_tensor(waveform, dtype=torch.float32)
    waveform = waveform.detach().float().cpu()
    if waveform.ndim == 2:
        waveform = waveform.unsqueeze(0)
    if waveform.ndim == 1:
        waveform = waveform.reshape(1, 1, -1)
    if waveform.shape[1] > 1:
        waveform = waveform.mean(dim=1, keepdim=True)
    return waveform.contiguous(), int(audio["sample_rate"])


def _comfy_audio(waveform: torch.Tensor, sample_rate: int) -> dict[str, Any]:
    wav = waveform.detach().float().cpu()
    if wav.ndim == 1:
        wav = wav.reshape(1, 1, -1)
    elif wav.ndim == 2:
        wav = wav.unsqueeze(0)
    if wav.shape[1] > 1:
        wav = wav.mean(dim=1, keepdim=True)
    peak = float(wav.abs().max()) if wav.numel() else 0.0
    if peak > 1.0:
        wav = wav / peak
    return {"waveform": wav.contiguous(), "sample_rate": int(sample_rate)}


def _silence(sample_rate: int, seconds: float) -> torch.Tensor:
    return torch.zeros((1, 1, max(1, int(float(sample_rate) * max(0.0, float(seconds))))), dtype=torch.float32)


def _concat_audio(items: list[dict[str, Any]], pause_seconds: float) -> dict[str, Any]:
    if not items:
        return _comfy_audio(_silence(DEFAULT_SAMPLE_RATE, 0.25), DEFAULT_SAMPLE_RATE)
    target_sr = int(items[0].get("sample_rate") or DEFAULT_SAMPLE_RATE)
    chunks: list[torch.Tensor] = []
    for idx, audio in enumerate(items):
        wav, sr = _audio_to_tensor(audio)
        if sr != target_sr:
            wav = _resample_waveform(wav, sr, target_sr)
        if idx > 0 and pause_seconds > 0:
            chunks.append(_silence(target_sr, pause_seconds))
        chunks.append(wav)
    return _comfy_audio(torch.cat(chunks, dim=-1), target_sr)


def _resample_waveform(waveform: torch.Tensor, source_sr: int, target_sr: int) -> torch.Tensor:
    if int(source_sr) == int(target_sr):
        return waveform
    try:
        import torchaudio.functional as F

        flat = waveform.reshape(-1, waveform.shape[-1])
        out = F.resample(flat, int(source_sr), int(target_sr))
        return out.reshape(waveform.shape[0], waveform.shape[1], -1)
    except Exception:
        ratio = float(target_sr) / float(source_sr)
        new_len = max(1, int(round(waveform.shape[-1] * ratio)))
        return torch.nn.functional.interpolate(waveform, size=new_len, mode="linear", align_corners=False)


def _models_mp3_root() -> Path:
    root = Path(folder_paths.models_dir) / "mp3"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _unique_models_mp3_path(filename: str) -> Path:
    root = _models_mp3_root()
    safe = _safe_filename(filename, "reference.wav")
    stem = Path(safe).stem or "reference"
    suffix = Path(safe).suffix or ".wav"
    candidate = root / f"{stem}{suffix}"
    counter = 1
    while candidate.exists():
        candidate = root / f"{stem}_{counter:03d}{suffix}"
        counter += 1
    return candidate


def _find_ffmpeg_executable() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return str(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:
        return ""


def _extract_audio_from_video(source: Path, target: Path) -> None:
    ffmpeg = _find_ffmpeg_executable()
    if not ffmpeg:
        report = build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[{
                "module_name": "imageio_ffmpeg",
                "package_name": "imageio-ffmpeg",
                "display_name": "imageio-ffmpeg",
                "description": "浏览器导入视频并提取音频需要 ffmpeg。系统已安装 ffmpeg 时无需此包。",
            }],
            install_packages=["imageio-ffmpeg"],
            description="没有找到可用 ffmpeg，无法从视频中提取音频。",
        )
        err = RuntimeError(report.get("warning_message") or "缺少 ffmpeg")
        setattr(err, "gjj_report", report)
        raise err
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "24000",
        "-c:a",
        "pcm_s16le",
        str(target),
    ]
    completed = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if completed.returncode != 0 or not target.exists():
        raise RuntimeError(f"视频音频提取失败：{completed.stderr[-1200:]}")


def _list_models_mp3() -> list[str]:
    root = _models_mp3_root()
    items: list[tuple[str, float]] = []
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS:
            try:
                mtime = path.stat().st_mtime
            except OSError:
                mtime = 0.0
            items.append((str(path.relative_to(root)).replace("/", "\\"), mtime))
    items.sort(key=lambda item: item[1], reverse=True)
    return [item[0] for item in items]


def _audio_choices() -> list[str]:
    return [""] + (_list_models_mp3() or [MISSING_AUDIO_CHOICE])


def _resolve_local_audio(name: str) -> Path:
    selected = str(name or "").strip()
    choices = _list_models_mp3()
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


def _audio_from_file(path: Path) -> dict[str, Any]:
    try:
        import soundfile as sf

        audio_np, sample_rate = sf.read(str(path), always_2d=True, dtype="float32")
        waveform = torch.from_numpy(audio_np.T).float()
    except Exception:
        try:
            import torchaudio

            waveform, sample_rate = torchaudio.load(str(path))
        except Exception as exc:
            raise_dependency_model_error(
                node_name=NODE_DISPLAY_NAME,
                missing_dependencies=[{"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile"}],
                install_packages=["soundfile"],
                description="读取本地音频/视频音轨需要可用的音频解码依赖。",
                original_error=str(exc),
            )
    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    return _comfy_audio(waveform.unsqueeze(0), int(sample_rate))


def _speaker_audio_name(index: int) -> str:
    return f"{AUDIO_PREFIX}{index:02d}_audio"


def _speaker_ref_text_name(index: int) -> str:
    return f"{AUDIO_PREFIX}{index:02d}_text"


def _build_reference_inputs() -> dict[str, tuple[str, dict[str, Any]]]:
    optional: dict[str, tuple[str, dict[str, Any]]] = {}
    # 后端只声明默认一对；后续输入由前端动态追加，执行时通过 **kwargs 接收。
    for index in range(1, 2):
        optional[_speaker_audio_name(index)] = ("AUDIO", {
            "forceInput": True,
            "display_name": f"参考音频{index}",
            "tooltip": "连接最后一对输入后会自动扩展下一对；没有链接会自动收缩。",
        })
        optional[_speaker_ref_text_name(index)] = ("STRING", {
            "forceInput": True,
            "default": "",
            "display_name": f"参考文本{index}",
            "tooltip": "对应参考音频的原文。可连接文本节点，也可留空使用默认参考文本。",
        })
    return optional


def _valid_audio(value: Any) -> bool:
    return isinstance(value, dict) and value.get("waveform") is not None and value.get("sample_rate") is not None


def _collect_references(kwargs: dict[str, Any], local_audio_name: str, default_reference_text: str) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for index in range(1, MAX_REFERENCES + 1):
        audio = kwargs.get(_speaker_audio_name(index))
        if not _valid_audio(audio):
            continue
        refs.append({
            "speaker": index - 1,
            "audio": audio,
            "text": str(kwargs.get(_speaker_ref_text_name(index)) or default_reference_text or "").strip(),
        })
    if not refs and str(local_audio_name or "").strip():
        refs.append({"speaker": 0, "audio": _audio_from_file(_resolve_local_audio(local_audio_name)), "text": str(default_reference_text or "").strip()})
    return refs


def _split_sentences(text: str) -> list[str]:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if not value:
        return []
    parts = re.split(r"(?<=[。！？!?；;])\s*", value)
    return [part.strip() for part in parts if part.strip()]


def _parse_turns(text: str) -> list[dict[str, Any]]:
    tag_re = re.compile(r"^\s*(?:\[speaker[_\s-]*(\d+)\]|speaker[_\s-]*(\d+)|角色\s*(\d+)|说话人\s*(\d+))\s*[:：]\s*(.*)$", re.I)
    turns: list[dict[str, Any]] = []
    current_speaker = 0
    buffer: list[str] = []

    def flush() -> None:
        nonlocal buffer
        joined = " ".join(part.strip() for part in buffer if part.strip()).strip()
        if joined:
            for sentence in _split_sentences(joined):
                turns.append({"speaker": current_speaker, "text": sentence})
        buffer = []

    for raw in str(text or "").splitlines():
        match = tag_re.match(raw)
        if match:
            flush()
            number = next((group for group in match.groups()[:4] if group), "1")
            current_speaker = max(0, int(number) - 1)
            buffer = [match.group(5)] if match.group(5).strip() else []
        else:
            stripped = raw.strip()
            if stripped:
                buffer.append(stripped)
    flush()
    return turns or [{"speaker": 0, "text": sentence} for sentence in _split_sentences(text)]


def _fmt_time_srt(seconds: float, comma: bool = True) -> str:
    total_ms = max(0, int(round(float(seconds) * 1000)))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    sep = "," if comma else "."
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _format_timeline(items: list[dict[str, Any]], fmt: str) -> str:
    selected = str(fmt or "SRT").upper()
    if selected == "JSON":
        return json.dumps(items, ensure_ascii=False, indent=2)
    if selected == "VTT":
        lines = ["WEBVTT", ""]
        for item in items:
            lines += [f"{_fmt_time_srt(item['start'], False)} --> {_fmt_time_srt(item['end'], False)}", item["text"], ""]
        return "\n".join(lines)
    if selected == "LRC":
        return "\n".join(f"[{_fmt_time_srt(item['start'], False)[3:8]}]{item['text']}" for item in items)
    lines = []
    for idx, item in enumerate(items, start=1):
        lines += [str(idx), f"{_fmt_time_srt(item['start'])} --> {_fmt_time_srt(item['end'])}", item["text"], ""]
    return "\n".join(lines)


def _rate_from_speed(speed: float) -> str:
    value = max(0.5, min(2.0, float(speed)))
    percent = int(round((value - 1.0) * 100.0))
    return "+0%" if percent == 0 else f"{percent:+d}%"


def _pitch_value(pitch: int) -> str:
    value = max(-20, min(20, int(pitch)))
    return f"{value:+d}Hz"


def _audio_from_wav_bytes(data: bytes) -> dict[str, Any]:
    with wave.open(BytesIO(data), "rb") as reader:
        channels = int(reader.getnchannels())
        sample_width = int(reader.getsampwidth())
        sample_rate = int(reader.getframerate())
        raw = reader.readframes(int(reader.getnframes()))
    if sample_width != 2:
        raise RuntimeError(f"当前只支持 16-bit PCM，实际为 {sample_width * 8}-bit。")
    samples = torch.frombuffer(bytearray(raw), dtype=torch.int16).float() / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(dim=1)
    return _comfy_audio(samples.reshape(1, 1, -1), sample_rate)


class _StdlibWebSocket:
    def __init__(self, host: str, path: str, timeout: float = 30.0):
        self.host = host
        self.path = path
        self.timeout = float(timeout)
        self.sock: ssl.SSLSocket | None = None

    def __enter__(self):
        raw = socket.create_connection((self.host, 443), timeout=self.timeout)
        context = ssl.create_default_context()
        self.sock = context.wrap_socket(raw, server_hostname=self.host)
        self.sock.settimeout(self.timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold\r\n"
            "User-Agent: Mozilla/5.0\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        if b" 101 " not in self._recv_headers().split(b"\r\n", 1)[0]:
            raise RuntimeError("Edge TTS WebSocket 连接失败。")
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        if self.sock is not None:
            self.sock.close()
        self.sock = None

    def _recv_headers(self) -> bytes:
        data = bytearray()
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096) if self.sock else b""
            if not chunk:
                break
            data.extend(chunk)
        return bytes(data)

    def _recv_exact(self, size: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < size:
            chunk = self.sock.recv(size - len(chunks)) if self.sock else b""
            if not chunk:
                raise RuntimeError("Edge TTS 连接提前关闭。")
            chunks.extend(chunk)
        return bytes(chunks)

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        length = len(payload)
        header = bytearray([0x80 | int(opcode)])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.extend((0x80 | 126, *struct.pack("!H", length)))
        else:
            header.extend((0x80 | 127, *struct.pack("!Q", length)))
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + mask + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def recv_message(self) -> tuple[int, bytes]:
        chunks = bytearray()
        message_opcode = 0
        while True:
            first, second = self._recv_exact(2)
            fin = bool(first & 0x80)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            if length > MAX_WS_PAYLOAD:
                raise RuntimeError("Edge TTS 返回数据过大。")
            mask = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length) if length else b""
            if masked:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if opcode == 0x8:
                return opcode, payload
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode in (0x1, 0x2):
                message_opcode = opcode
                chunks = bytearray(payload)
            elif opcode == 0x0:
                chunks.extend(payload)
            if fin and message_opcode:
                return message_opcode, bytes(chunks)


def _edge_headers(path: str, request_id: str, content_type: str = "application/json") -> str:
    return f"X-RequestId:{request_id}\r\nContent-Type:{content_type}\r\nPath:{path}\r\n\r\n"


def _edge_ssml(text: str, voice: str, rate: str, pitch: str) -> str:
    escaped = html.escape(text, quote=False)
    voice_attr = html.escape(voice, quote=True)
    return (
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' "
        "xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='zh-CN'>"
        f"<voice name='{voice_attr}'><prosody rate='{rate}' pitch='{pitch}'>{escaped}</prosody></voice></speak>"
    )


async def _edge_tts_library(text: str, voice: str, speed: float, pitch: int) -> dict[str, Any]:
    import edge_tts

    fd, temp_path = tempfile.mkstemp(prefix="gjj_universal_edge_", suffix=".mp3")
    os.close(fd)
    try:
        communicate = edge_tts.Communicate(text=text, voice=voice, rate=_rate_from_speed(speed), pitch=_pitch_value(pitch))
        await communicate.save(temp_path)
        return _audio_from_file(Path(temp_path))
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


def _edge_tts(text: str, voice: str, speed: float, pitch: int, timeout: float) -> dict[str, Any]:
    if _has_module("edge_tts"):
        def run_async_in_thread():
            loop = asyncio.new_event_loop()
            try:
                asyncio.set_event_loop(loop)
                return loop.run_until_complete(_edge_tts_library(text, voice, speed, pitch))
            finally:
                loop.close()

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            return executor.submit(run_async_in_thread).result()

    request_id = uuid.uuid4().hex
    connection_id = uuid.uuid4().hex
    timestamp = time.strftime("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)", time.gmtime())
    path = f"{EDGE_PATH}?TrustedClientToken={EDGE_TOKEN}&ConnectionId={connection_id}"
    config = (
        _edge_headers("speech.config", request_id)
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
        + f'"outputFormat":"{EDGE_OUTPUT_FORMAT}"'
        + "}}}}\r\n"
    )
    payload = (
        f"X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{timestamp}\r\nPath:ssml\r\n\r\n"
        + _edge_ssml(text, voice, _rate_from_speed(speed), _pitch_value(pitch))
    )
    audio = bytearray()
    with _StdlibWebSocket(EDGE_HOST, path, timeout=timeout) as ws:
        ws.send_text(config)
        ws.send_text(payload)
        while True:
            opcode, data = ws.recv_message()
            if opcode == 0x8:
                break
            header_end = data.find(b"\r\n\r\n")
            headers = data[:header_end].decode("utf-8", "ignore") if header_end >= 0 else data.decode("utf-8", "ignore")
            body = data[header_end + 4:] if header_end >= 0 else b""
            if "Path:audio" in headers:
                audio.extend(body)
            elif "Path:turn.end" in headers:
                break
    data = bytes(audio)
    if data.startswith(b"RIFF"):
        return _audio_from_wav_bytes(data)
    samples = torch.frombuffer(bytearray(data), dtype=torch.int16).float() / 32768.0
    return _comfy_audio(samples.reshape(1, 1, -1), DEFAULT_SAMPLE_RATE)


def _resolve_device_dtype(device_choice: str, precision: str = "auto") -> tuple[str, torch.dtype]:
    if device_choice == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    else:
        device = str(device_choice or "cpu")
    if precision in {"bf16", "bfloat16"}:
        dtype = torch.bfloat16
    elif precision in {"fp16", "float16"}:
        dtype = torch.float16
    elif precision in {"fp32", "float32"}:
        dtype = torch.float32
    elif device == "cuda":
        dtype = torch.bfloat16
    elif device == "mps":
        dtype = torch.float16
    else:
        dtype = torch.float32
    return device, dtype


def _model_dir(subdir: str, model_name: str, default_name: str, unique_id: Any = None) -> Path:
    root = _models_root(subdir)
    name = str(model_name or "").strip()
    if not name or name == "自动":
        local_dirs = [item.name for item in sorted(root.iterdir()) if item.is_dir()]
        name = local_dirs[0] if local_dirs else default_name
    path = root / name
    if not path.exists():
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[{"label": name, "subdir": subdir, "filename": name, "description": f"请放到 models/{subdir}/。"}],
            install_packages=[],
            description=f"未找到模型目录：{path}",
            unique_id=unique_id,
            title="GJJ TTS 模型缺失",
        )
    return path


def _audio_bytes_from_comfy(audio: dict[str, Any]) -> bytes:
    import soundfile as sf

    waveform, sample_rate = _audio_to_tensor(audio)
    wav = waveform[0].permute(1, 0).cpu().float().numpy()
    if wav.ndim == 2 and wav.shape[1] == 1:
        wav = wav[:, 0]
    buf = io.BytesIO()
    sf.write(buf, wav, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _fish_model_complete(path: Path) -> bool:
    if not path.is_dir():
        return False
    has_config = (path / "config.json").is_file()
    has_weights = any(item.suffix.lower() in {".safetensors", ".bin"} and item.stat().st_size > 128 * 1024 * 1024 for item in path.iterdir() if item.is_file())
    has_decoder = any((search / name).is_file() for search in (path, path.parent) for name in FISH_DECODER_FILE_NAMES)
    return has_config and has_weights and has_decoder


def _find_fish_decoder(path: Path, unique_id: Any = None) -> Path:
    for search in (path, path.parent):
        for name in FISH_DECODER_FILE_NAMES:
            candidate = search / name
            if candidate.is_file():
                return candidate
    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[{"label": "Fish S2 DAC 解码器", "subdir": "fishaudioS2", "filename": "codec.pth / firefly-gan-vq-fsq-8x1024-21hz-generator.pth", "description": "请放在 Fish 模型目录或 models/fishaudioS2/ 下。"}],
        install_packages=[],
        description=f"未找到 Fish S2 解码器：{path}",
        unique_id=unique_id,
        title="GJJ TTS 模型缺失",
    )


def _load_fish_engine(model_name: str, device_choice: str, precision: str, unique_id: Any = None):
    _ensure_vendor_package("fish_speech", _VENDOR_ROOT, unique_id)
    marker = _FISH_VENDOR / ".project-root"
    try:
        marker.write_text("GJJ vendored Fish Speech project root marker.\n", encoding="utf-8")
    except OSError:
        pass
    model_path = _model_dir("fishaudioS2", model_name, "s2-pro-fp8", unique_id)
    if not _fish_model_complete(model_path):
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[{"label": model_path.name, "subdir": "fishaudioS2", "filename": model_path.name, "description": "目录需包含 config.json、文本权重和 DAC 解码器。"}],
            install_packages=[],
            description=f"Fish S2 模型不完整：{model_path}",
            unique_id=unique_id,
            title="GJJ TTS 模型缺失",
        )
    device, dtype = _resolve_device_dtype(device_choice, precision)
    cache_key = f"fish:{model_path}:{device}:{dtype}"
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]
    try:
        from fish_speech.models.dac.inference import load_model as load_decoder_model
        from fish_speech.models.text2semantic import inference as text2semantic_inference
        from fish_speech.inference_engine import TTSInferenceEngine
    except Exception as exc:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=BRANCH_DEPENDENCIES["FishAudioS2"],
            install_packages=FISH_RUNTIME_PACKAGES,
            description="Fish Audio S2 vendor 运行时导入失败；请补齐 pip 运行依赖。",
            original_error=str(exc),
            unique_id=unique_id,
        )
    _send_status(unique_id, "正在加载 Fish Audio S2 文本模型", 0.10)
    llama_queue, llama_thread = text2semantic_inference.launch_thread_safe_queue(
        checkpoint_path=str(model_path),
        device=device,
        precision=dtype,
        compile=False,
        bnb_mode=None,
        lazy_load=False,
    )
    decoder_path = _find_fish_decoder(model_path, unique_id)
    _send_status(unique_id, "正在加载 Fish Audio S2 解码器", 0.16)
    decoder_model = load_decoder_model(config_name="modded_dac_vq", checkpoint_path=str(decoder_path), device=device)
    engine = TTSInferenceEngine(llama_queue=llama_queue, decoder_model=decoder_model, precision=dtype, compile=False)
    engine._llama_thread = llama_thread
    _MODEL_CACHE[cache_key] = engine
    return engine


def _fish_tts(
    model_name: str,
    text: str,
    reference: dict[str, Any] | None,
    reference_text: str,
    language: str,
    device: str,
    precision: str,
    seed: int,
    unique_id: Any,
) -> dict[str, Any]:
    if reference is None or not _valid_audio(reference.get("audio")):
        raise RuntimeError("FishAudioS2 分支需要参考音频。")
    engine = _load_fish_engine(model_name, device, precision, unique_id)
    try:
        from fish_speech.utils.schema import ServeReferenceAudio, ServeTTSRequest
    except Exception as exc:
        raise RuntimeError(f"FishAudioS2 schema 导入失败：{exc}") from exc
    prompt_prefix = f"[{language}] " if str(language or "auto") != "auto" else ""
    req = ServeTTSRequest(
        text=f"{prompt_prefix}{text}",
        references=[ServeReferenceAudio(audio=_audio_bytes_from_comfy(reference["audio"]), text=str(reference_text or ""))],
        reference_id=None,
        max_new_tokens=1024,
        chunk_length=200,
        top_p=0.7,
        repetition_penalty=1.2,
        temperature=0.7,
        seed=int(seed),
        streaming=False,
        format="wav",
    )
    audio_np = None
    sample_rate = 44100
    for result in engine.inference(req):
        if result.code == "error":
            raise RuntimeError(f"FishAudioS2 推理失败：{result.error}")
        if result.code == "final":
            sample_rate, audio_np = result.audio
    if audio_np is None:
        raise RuntimeError("FishAudioS2 没有生成有效音频。")
    return _comfy_audio(torch.from_numpy(np.asarray(audio_np, dtype=np.float32)).reshape(1, 1, -1), int(sample_rate))


def _longcat_model_name(branch: str, model_name: str) -> str:
    raw = str(model_name or "").strip()
    if raw and raw != "自动":
        return raw.replace(" (auto download)", "")
    return LONGCAT_KNOWN_MODELS.get(branch, "LongCat-AudioDiT-3.5B-bf16")


def _load_longcat(model_name: str, device_choice: str, precision: str, unique_id: Any = None):
    _ensure_vendor_package("audiodit", _VENDOR_ROOT, unique_id)
    model_path = _model_dir("audiodit", model_name, model_name, unique_id)
    device, dtype = _resolve_device_dtype(device_choice, precision)
    cache_key = f"longcat:{model_path}:{device}:{dtype}"
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]
    try:
        import audiodit  # noqa: F401
        from transformers import AutoModel, AutoTokenizer
    except Exception as exc:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=BRANCH_DEPENDENCIES["LongCat3.5B"],
            install_packages=["transformers", "safetensors", "soundfile"],
            description="LongCat AudioDiT vendor 运行时导入失败；请补齐 pip 运行依赖。",
            original_error=str(exc),
            unique_id=unique_id,
        )
    tokenizer_dir = _models_root("audiodit") / "umt5-base-tokenizer"
    tokenizer_source = str(tokenizer_dir) if (tokenizer_dir / "tokenizer_config.json").is_file() else LONGCAT_TOKENIZER_ID
    _send_status(unique_id, "正在加载 LongCat tokenizer", 0.10)
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_source)
    _send_status(unique_id, "正在加载 LongCat AudioDiT 模型", 0.14)
    model = AutoModel.from_pretrained(str(model_path), torch_dtype=dtype, trust_remote_code=True)
    model.to(device).eval()
    _MODEL_CACHE[cache_key] = (model, tokenizer)
    return model, tokenizer


def _reference_to_tensor(reference: dict[str, Any], target_sr: int) -> torch.Tensor:
    wav, sr = _audio_to_tensor(reference["audio"])
    if sr != target_sr:
        wav = _resample_waveform(wav, sr, target_sr)
    if wav.ndim == 3:
        wav = wav[:, 0, :]
    return wav.to(torch.float32)


def _longcat_tts(
    branch: str,
    model_name: str,
    text: str,
    reference: dict[str, Any] | None,
    reference_text: str,
    device: str,
    precision: str,
    steps: int,
    guidance_strength: float,
    seed: int,
    unique_id: Any,
) -> dict[str, Any]:
    if reference is None or not _valid_audio(reference.get("audio")):
        raise RuntimeError("LongCat 分支需要参考音频。")
    selected = _longcat_model_name(branch, model_name)
    model, tokenizer = _load_longcat(selected, device, precision, unique_id)
    sr = int(model.config.sampling_rate)
    full_hop = int(model.config.latent_hop)
    max_duration = float(model.config.max_wav_duration)
    ref_audio = _reference_to_tensor(reference, sr).to(model.device)
    line_text = re.sub(r"\s+", " ", str(text or "").lower()).strip()
    ref_norm = re.sub(r"\s+", " ", str(reference_text or "").lower()).strip()
    full_text = f"{ref_norm} {line_text}" if ref_norm else line_text
    inputs = tokenizer([full_text], padding="longest", return_tensors="pt")
    input_ids = inputs.input_ids.to(model.device)
    attention_mask = inputs.attention_mask.to(model.device)
    prompt_latent, prompt_dur = model.encode_prompt_audio(ref_audio)
    prompt_time = prompt_dur * full_hop / sr
    duration_sec = min(max_duration - prompt_time, max(1.5, len(line_text) * 0.16))
    total_duration = min(int(max_duration * sr // full_hop), int(duration_sec * sr // full_hop) + prompt_dur)
    with torch.no_grad():
        output = model(
            input_ids=input_ids,
            attention_mask=attention_mask,
            prompt_audio=ref_audio,
            duration=total_duration,
            steps=int(steps),
            cfg_strength=float(guidance_strength),
            guidance_method="apg",
            seed=int(seed),
        )
    waveform = output.waveform.squeeze().detach().cpu().float()
    return _comfy_audio(waveform.reshape(1, 1, -1), sr)


def _cosyvoice_tts(branch: str, model_name: str, text: str, reference: dict[str, Any] | None, reference_text: str, speed: float, seed: int, unique_id: Any) -> dict[str, Any]:
    report = _build_branch_report(branch, model_name)
    if report.get("notice_level") == "error":
        send_dependency_model_notice(report, unique_id=unique_id)
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=report.get("missing_dependencies", []),
            missing_models=report.get("missing_models", []),
            install_packages=[item.get("package_name") for item in report.get("missing_dependencies", [])],
            description=report.get("panel_message", ""),
            unique_id=unique_id,
        )
    _ensure_vendor_package("cosyvoice", _COSY_VENDOR, unique_id)
    try:
        from cosyvoice.cli.cosyvoice import AutoModel
    except Exception as exc:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=BRANCH_DEPENDENCIES[branch],
            install_packages=["soundfile", "pyyaml", "librosa", "onnxruntime", "modelscope"],
            description="CosyVoice3 vendor 运行时导入失败；请补齐 pip 运行依赖。",
            original_error=str(exc),
            unique_id=unique_id,
        )
    import soundfile as sf

    model_root = _models_root("cosyvoice")
    selected_name = str(model_name or "").strip()
    if not selected_name or selected_name == "自动":
        local_dirs = [item.name for item in sorted(model_root.iterdir()) if item.is_dir()]
        selected_name = local_dirs[0] if local_dirs else "Fun-CosyVoice3-0.5B-2512"
    selected_path = str((model_root / selected_name).resolve())
    key = f"cosyvoice:{selected_path}"
    if key not in _MODEL_CACHE:
        _send_status(unique_id, "正在加载 CosyVoice3 模型", 0.12)
        _MODEL_CACHE[key] = AutoModel(model_dir=selected_path, load_trt=False, fp16=False)
    model = _MODEL_CACHE[key]
    random.seed(int(seed))
    torch.manual_seed(int(seed) if int(seed) >= 0 else random.randint(0, 2**31 - 1))
    temp_path = ""
    try:
        if reference and _valid_audio(reference.get("audio")):
            fd, temp_path = tempfile.mkstemp(prefix="gjj_universal_ref_", suffix=".wav")
            os.close(fd)
            ref_wav, ref_sr = _audio_to_tensor(reference["audio"])
            sf.write(temp_path, ref_wav.squeeze().numpy(), ref_sr)
        elif reference:
            temp_path = str(_resolve_local_audio(""))
        else:
            raise RuntimeError("CosyVoice3 分支需要参考音频。")
        output = model.inference_zero_shot(
            tts_text=text,
            prompt_text=str(reference_text or "").strip() or DEFAULT_REFERENCE_TEXT,
            prompt_wav=temp_path,
            zero_shot_spk_id="",
            stream=False,
            speed=float(speed),
        )
        chunks = []
        for chunk in output:
            if isinstance(chunk, dict) and "tts_speech" in chunk:
                chunks.append(chunk["tts_speech"].detach().cpu())
        if not chunks:
            raise RuntimeError("CosyVoice3 没有生成有效音频。")
        waveform = torch.cat(chunks, dim=-1) if len(chunks) > 1 else chunks[0]
        sample_rate = int(getattr(model, "sample_rate", 24000) or 24000)
        return _comfy_audio(waveform, sample_rate)
    finally:
        if temp_path and temp_path.startswith(tempfile.gettempdir()):
            try:
                os.remove(temp_path)
            except OSError:
                pass


def _unsupported_public_adapter(branch: str, model_name: str, unique_id: Any) -> None:
    report = _build_branch_report(branch, model_name)
    if report.get("notice_level") == "ok":
        report = build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            description=(
                f"{branch} 分支已完成独立依赖检查，但当前环境未暴露稳定的公开 pip 推理入口。"
                "为保持“除公共函数外不导入本包旧节点函数”的零本地依赖原则，本节点不会回退调用旧节点 loader/cache。"
            ),
            original_error="请安装该模型官方 pip 运行时并在后续版本补充公开 API 适配，或暂用 EdgeTTS/CosyVoice3 分支。",
        )
        report["warning_message"] = "⚠️当前分支缺少公开 pip 推理适配，点击❓按钮了解详情。"
        report["panel_message"] = report["description_message"] = report["help_message"] = (
            "⚠️当前分支缺少公开 pip 推理适配。\n\n"
            + report["original_error"]
        )
        report["copy_text"] = report["panel_message"]
        report["copy_label"] = "📋 复制说明"
        report["notice_level"] = "error"
    send_dependency_model_notice(report, unique_id=unique_id)
    raise RuntimeError(report.get("panel_message") or report.get("warning_message"))


def _read_bool_props(extra_pnginfo: Any, unique_id: Any) -> dict[str, Any]:
    try:
        workflow = (extra_pnginfo or {}).get("workflow", {})
        for item in workflow.get("nodes", []):
            if isinstance(item, dict) and str(item.get("id")) == str(unique_id):
                return item.get("properties", {}) or {}
    except Exception:
        pass
    return {}


def _settings_path() -> Path:
    return Path(__file__).resolve().parents[1] / "presets" / "gjj_user_settings.json"


def _read_saved_branch() -> str:
    try:
        data = json.loads(_settings_path().read_text(encoding="utf-8"))
        value = str(((data.get("nodes") or {}).get(NODE_NAME) or {}).get("branch") or "")
        return value if value in BRANCHES else BRANCHES[0]
    except Exception:
        return BRANCHES[0]


def _register_universal_tts_api() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return
    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(server, "_gjj_universal_tts_api_registered", False):
        return

    @server.routes.post("/gjj/universal_tts/import_media")
    async def import_media(request):
        temp_path = None
        try:
            reader = await request.multipart()
            field = await reader.next()
            if field is None or field.name != "file":
                raise ValueError("没有收到文件。")
            filename = _safe_filename(field.filename or "reference")
            suffix = Path(filename).suffix.lower()
            is_video = suffix in {".mp4", ".mov", ".mkv", ".webm", ".avi", ".flv", ".m4v"}
            is_audio = suffix in AUDIO_EXTENSIONS and not is_video
            if not is_audio and not is_video:
                raise ValueError("只支持音频或视频文件。")
            fd, temp_name = tempfile.mkstemp(prefix="gjj_universal_tts_upload_", suffix=suffix or ".bin")
            os.close(fd)
            temp_path = Path(temp_name)
            with temp_path.open("wb") as handle:
                while True:
                    chunk = await field.read_chunk()
                    if not chunk:
                        break
                    handle.write(chunk)
            if is_video:
                target = _unique_models_mp3_path(f"{Path(filename).stem}.wav")
                _extract_audio_from_video(temp_path, target)
            else:
                target = _unique_models_mp3_path(filename)
                shutil.copyfile(temp_path, target)
            rel = str(target.relative_to(_models_mp3_root())).replace("/", "\\")
            return web.json_response({"ok": True, "name": rel, "path": str(target), "is_video": is_video})
        except Exception as exc:
            report = get_report_from_exception(exc)
            payload = {"ok": False, "error": str(exc)}
            if report:
                payload["report"] = report
            return web.json_response(payload, status=400)
        finally:
            if temp_path:
                try:
                    temp_path.unlink()
                except OSError:
                    pass

    @server.routes.get("/gjj/universal_tts/check")
    async def check_branch(request):
        branch = str(request.query.get("branch") or BRANCHES[0])
        model_name = str(request.query.get("model_name") or "")
        if branch not in BRANCHES:
            branch = BRANCHES[0]
        report = _build_branch_report(branch, model_name)
        return web.json_response({"ok": True, "branch": branch, "report": report})

    server._gjj_universal_tts_api_registered = True


_register_universal_tts_api()


def _hidden_widget(options: dict[str, Any]) -> dict[str, Any]:
    result = dict(options)
    result.setdefault("hidden", True)
    result.setdefault("display", "hidden")
    result.setdefault("advanced", True)
    return result


def _coerce_choice(value: Any, choices: list[str], default: str) -> str:
    text = str(value or "").strip()
    return text if text in choices else default


def _coerce_float(value: Any, default: float, minimum: float | None = None, maximum: float | None = None) -> float:
    try:
        number = float(value)
    except Exception:
        number = float(default)
    if minimum is not None:
        number = max(float(minimum), number)
    if maximum is not None:
        number = min(float(maximum), number)
    return number


def _coerce_int(value: Any, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    try:
        number = int(float(value))
    except Exception:
        number = int(default)
    if minimum is not None:
        number = max(int(minimum), number)
    if maximum is not None:
        number = min(int(maximum), number)
    return int(number)


class GJJ_UniversalTTS:
    CATEGORY = "GJJ/Audio"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = "零本地节点依赖的多功能 TTS：统一文本解析、参考音频、队列合成、时间轴输出和依赖提示。"
    SEARCH_ALIASES = ["TTS", "文字转语音", "EdgeTTS", "FishAudioS2", "LongCat", "CosyVoice3"]
    RETURN_TYPES = ("AUDIO", "STRING")
    RETURN_NAMES = ("合成音频", "时间轴文本")
    OUTPUT_TOOLTIPS = ("合成后的 ComfyUI AUDIO。", "按输出设置生成的 SRT/VTT/LRC/JSON 时间轴文本。")
    GJJ_HELP = build_node_help_payload(
        description=DESCRIPTION,
        dependencies=[
            "EdgeTTS 分支零 pip 依赖，使用 Python 标准库访问在线 Edge TTS 服务。",
            "其它分支只允许使用公开 pip 包和模型文件；禁止导入本包旧 TTS 节点、loader 或 cache。",
        ],
        usage=[
            "文本支持 [speaker_1]: 这样的说话人标签；未标记文本会按句自动分队列。",
            "参考音频输入口由前端自动扩展/收缩，后端最多接收 10 对。",
        ],
    )
    GJJ_UI = {
        "dynamic_reference_pairs": True,
        "branch_presets_path": "presets/gjj_user_settings.json",
        "toolbar": ["📂", "🧠", "💱", "🔗", "🎲", "📢", "🔌", "⚙️", "🎤"],
        "hidden_parameters": ["model_name", "local_audio_name", "default_reference_text", "language", "device", "precision", "steps", "guidance_strength"],
    }

    @classmethod
    def INPUT_TYPES(cls):
        audio_choices = _audio_choices()
        default_audio = next((item for item in audio_choices if item), "")
        saved_branch = _read_saved_branch()
        model_choices = ["自动"] + [item for item in _branch_model_choices(saved_branch) if item]
        return {
            "required": {
                "text": ("STRING", {"multiline": False, "default": DEFAULT_TEXT, "display_name": "合成文本"}),
                "branch": (BRANCHES, _hidden_widget({"default": saved_branch, "display_name": "生成分支", "tooltip": "由顶部 💱 按钮切换。"})),
                "model_name": (model_choices, _hidden_widget({"default": "自动", "display_name": "模型", "tooltip": "当前生成分支的模型；留自动会选择对应模型目录中的第一个可用项。"})),
                "local_audio_name": (audio_choices, _hidden_widget({"default": default_audio, "display_name": "本地参考音频", "tooltip": "由顶部 📢 按钮选择 models/mp3 音频。"})),
                "default_reference_text": ("STRING", _hidden_widget({"multiline": False, "default": DEFAULT_REFERENCE_TEXT, "display_name": "默认参考文本", "tooltip": "参考文本输入未连接时使用。"})),
                "edge_voice": (list(VOICE_IDS.keys()), _hidden_widget({"default": "[中文] zh-CN Xiaoxiao 女声", "display_name": "Edge音色"})),
                "custom_voice": ("STRING", _hidden_widget({"multiline": False, "default": "", "display_name": "自定义音色", "tooltip": "EdgeTTS 可直接填 voice id，优先于 Edge 音色下拉。"})),
                "speed": ("STRING", _hidden_widget({"multiline": False, "default": "1.0", "display_name": "语速"})),
                "pitch": ("STRING", _hidden_widget({"multiline": False, "default": "0", "display_name": "音调"})),
                "language": (["auto", "zh", "en", "ja", "ko"], _hidden_widget({"default": "auto", "display_name": "语言提示"})),
                "device": (["auto", "cuda", "cpu", "mps"], _hidden_widget({"default": "auto", "display_name": "运行设备"})),
                "precision": (["auto", "fp32", "fp16", "bf16"], _hidden_widget({"default": "auto", "display_name": "计算精度"})),
                "steps": ("STRING", _hidden_widget({"multiline": False, "default": "16", "display_name": "采样步数"})),
                "guidance_strength": ("STRING", _hidden_widget({"multiline": False, "default": "4.0", "display_name": "引导强度"})),
                "pause_after_speaker": ("STRING", _hidden_widget({"multiline": False, "default": "0.35", "display_name": "说话间隔秒数"})),
                "seed": ("STRING", _hidden_widget({"multiline": False, "default": "42", "display_name": "随机种子"})),
                "audio_output_mode": (AUDIO_OUTPUT_MODES, _hidden_widget({"default": "整体合并", "display_name": "音频输出"})),
                "timeline_format": (TEXT_FORMATS, _hidden_widget({"default": "SRT", "display_name": "文本输出"})),
                "mp3_filename_prefix": ("STRING", _hidden_widget({"multiline": False, "default": "audio/GJJ_UniversalTTS", "display_name": "MP3文件名前缀"})),
                "mp3_quality": (MP3_QUALITY_OPTIONS, _hidden_widget({"default": "320k", "display_name": "MP3质量"})),
                "fail_mode": (["报错", "静音占位"], _hidden_widget({"default": "报错", "display_name": "失败处理"})),
            },
            "optional": _build_reference_inputs(),
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def _synthesize_one(
        self,
        branch: str,
        model_name: str,
        text: str,
        reference: dict[str, Any] | None,
        edge_voice: str,
        custom_voice: str,
        speed: float,
        pitch: int,
        language: str,
        device: str,
        precision: str,
        steps: int,
        guidance_strength: float,
        seed: int,
        unique_id: Any,
    ) -> dict[str, Any]:
        if branch == "EdgeTTS":
            voice_id = str(custom_voice or "").strip() or VOICE_IDS.get(str(edge_voice), str(edge_voice))
            return _edge_tts(text, voice_id, speed, pitch, 45.0)
        if branch == "FishAudioS2":
            return _fish_tts(model_name, text, reference, str((reference or {}).get("text") or DEFAULT_REFERENCE_TEXT), language, device, precision, seed, unique_id)
        if branch in {"LongCat-1B", "LongCat3.5B"}:
            return _longcat_tts(branch, model_name, text, reference, str((reference or {}).get("text") or DEFAULT_REFERENCE_TEXT), device, precision, steps, guidance_strength, seed, unique_id)
        if branch == "Fun-CosyVoice3-0.5B-2512":
            return _cosyvoice_tts(branch, model_name, text, reference, str((reference or {}).get("text") or DEFAULT_REFERENCE_TEXT), speed, seed, unique_id)
        _unsupported_public_adapter(branch, model_name, unique_id)
        raise RuntimeError(f"{branch} 分支未生成音频。")

    def generate(
        self,
        text: str,
        branch: str = "",
        model_name: str = "自动",
        local_audio_name: str = "",
        default_reference_text: str = DEFAULT_REFERENCE_TEXT,
        edge_voice: str = "[中文] zh-CN Xiaoxiao 女声",
        custom_voice: str = "",
        speed: float = 1.0,
        pitch: int = 0,
        language: str = "auto",
        device: str = "auto",
        precision: str = "auto",
        steps: int = 16,
        guidance_strength: float = 4.0,
        pause_after_speaker: float = 0.35,
        seed: int = 42,
        audio_output_mode: str = "整体合并",
        timeline_format: str = "SRT",
        mp3_filename_prefix: str = "audio/GJJ_UniversalTTS",
        mp3_quality: str = "320k",
        fail_mode: str = "报错",
        unique_id: Any = None,
        extra_pnginfo: dict[str, Any] | None = None,
        **kwargs,
    ):
        props = _read_bool_props(extra_pnginfo, unique_id)
        keep_model = bool(kwargs.get("keep_model_loaded", props.get("keep_model_loaded", True)))
        random_seed = bool(kwargs.get("random_seed", props.get("random_seed", False)))
        selected_branch = str(branch or _read_saved_branch() or BRANCHES[0])
        if selected_branch not in BRANCHES:
            selected_branch = BRANCHES[0]
        text = str(text if text is not None else "").strip()
        edge_voice = _coerce_choice(edge_voice, list(VOICE_IDS.keys()), "[中文] zh-CN Xiaoxiao 女声")
        language = _coerce_choice(language, ["auto", "zh", "en", "ja", "ko"], "auto")
        device = _coerce_choice(device, ["auto", "cuda", "cpu", "mps"], "auto")
        precision = _coerce_choice(precision, ["auto", "fp32", "fp16", "bf16"], "auto")
        speed = _coerce_float(speed, 1.0, 0.5, 2.0)
        pitch = _coerce_int(pitch, 0, -20, 20)
        steps = _coerce_int(steps, 16, 1, 128)
        guidance_strength = _coerce_float(guidance_strength, 4.0, 0.0, 20.0)
        pause_after_speaker = _coerce_float(pause_after_speaker, 0.35, 0.0, 10.0)
        seed = _coerce_int(seed, 42, 0, 0x7FFFFFFF)
        audio_output_mode = _coerce_choice(audio_output_mode, AUDIO_OUTPUT_MODES, "整体合并")
        timeline_format = _coerce_choice(timeline_format, TEXT_FORMATS, "SRT")
        mp3_quality = _coerce_choice(mp3_quality, MP3_QUALITY_OPTIONS, "320k")
        fail_mode = _coerce_choice(fail_mode, ["报错", "静音占位"], "报错")
        if str(model_name or "") == "自动":
            choices = _branch_model_choices(selected_branch)
            model_name = choices[0] if choices else ""

        started = time.perf_counter()
        try:
            _send_status(unique_id, "正在解析文本", 0.03)
            turns = _parse_turns(text)
            if not turns:
                raise RuntimeError("合成文本不能为空。")
            references = _collect_references(kwargs, local_audio_name, default_reference_text)
            ref_by_speaker = {int(ref["speaker"]): ref for ref in references}
            if selected_branch != "EdgeTTS" and not references:
                raise RuntimeError("当前分支需要参考音频。请连接参考音频，或在 models/mp3 中选择本地参考音频。")

            report = _build_branch_report(selected_branch, model_name)
            if report.get("notice_level") == "error":
                send_dependency_model_notice(report, unique_id=unique_id)
                raise RuntimeError(report.get("warning_message") or "运行环境缺失。")

            pbar = None
            try:
                import comfy.utils
                pbar = comfy.utils.ProgressBar(max(1, len(turns)))
            except Exception:
                pbar = None

            audio_items: list[dict[str, Any]] = []
            timeline: list[dict[str, Any]] = []
            cursor = 0.0
            for index, turn in enumerate(turns):
                actual_seed = random.randint(0, 2**31 - 1) if random_seed else int(seed) + index
                speaker = int(turn.get("speaker") or 0)
                line = str(turn.get("text") or "").strip()
                ref = ref_by_speaker.get(speaker) or (references[0] if references else None)
                _send_status(unique_id, f"正在合成 {index + 1}/{len(turns)}：speaker_{speaker + 1}", 0.08 + 0.82 * ((index + 1) / len(turns)))
                audio = self._synthesize_one(
                    selected_branch,
                    model_name,
                    line,
                    ref,
                    edge_voice,
                    custom_voice,
                    speed,
                    pitch,
                    language,
                    device,
                    precision,
                    steps,
                    guidance_strength,
                    actual_seed,
                    unique_id,
                )
                audio_items.append(audio)
                wav, sr = _audio_to_tensor(audio)
                duration = float(wav.shape[-1]) / float(sr)
                start = cursor
                end = cursor + duration
                timeline.append({"index": index + 1, "speaker": speaker + 1, "start": start, "end": end, "text": line})
                cursor = end + (float(pause_after_speaker) if index < len(turns) - 1 else 0.0)
                if pbar:
                    pbar.update_absolute(index + 1, len(turns))

            _send_status(unique_id, "正在拼接输出", 0.94)
            merged = _concat_audio(audio_items, float(pause_after_speaker))
            timeline_text = _format_timeline(timeline, timeline_format)
            _send_status(unique_id, "正在保存 MP3 预览", 0.97)
            audio_ui = _save_audio_mp3_ui(merged, mp3_filename_prefix, mp3_quality)
            _send_audio_preview(unique_id, audio_ui)
            elapsed = time.perf_counter() - started
            _send_status(unique_id, f"完成：{len(turns)} 段，耗时 {elapsed:.2f} 秒", 1.0)
            if not keep_model:
                _MODEL_CACHE.clear()
            return {"ui": audio_ui, "result": (merged, timeline_text)}
        except Exception as exc:
            report = get_report_from_exception(exc)
            if report:
                send_dependency_model_notice(report, unique_id=unique_id)
            _send_status(unique_id, f"执行失败：{exc}", 1.0)
            if fail_mode == "静音占位":
                empty = _comfy_audio(_silence(DEFAULT_SAMPLE_RATE, 0.25), DEFAULT_SAMPLE_RATE)
                return (empty, "")
            raise


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_UniversalTTS}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: f"GJJ·{NODE_DISPLAY_NAME}"}
