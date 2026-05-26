from __future__ import annotations

import gc
import importlib.util
import math
import os
import random
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    import comfy.model_management as model_management
except Exception:
    model_management = None

try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
        send_dependency_model_notice,
    )
except ImportError:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
        send_dependency_model_notice,
    )


NODE_LOADER = "GJJ_LongCatAvatarLoader"
NODE_GENERATOR = "GJJ_LongCatAvatarGenerator"
DISPLAY_LOADER = "GJJ · 🐱 LongCat数字人加载器"
DISPLAY_GENERATOR = "GJJ · 🎭 LongCat数字人生成"
GJJ_ROOT = Path(__file__).resolve().parents[1]
VENDOR_ROOT = GJJ_ROOT / "vendor" / "longcat_video_runtime"
AUTO = "自动检测"
MODEL_HINTS = {
    "dit": ("Diffusion_models", "LongCat-Avatar"),
    "text_encoder": ("text_encoders", "umt5-xxl-enc"),
    "audio_encoder": ("audio_encoders", "whisper_large_v3_encoder"),
    "lora": ("loras", "LongCat-Avatar-15"),
    "vae": ("vae", "Wan2_1_VAE_"),
}
CATEGORY_ALIASES = {
    "diffusion_models": ("diffusion_models", "Diffusion_models"),
    "text_encoders": ("text_encoders", "textencoder", "text_encoder"),
    "audio_encoders": ("audio_encoders", "audio_encoder"),
    "faster-whisper": ("faster-whisper", "audio_encoders", "audio_encoder"),
    "loras": ("loras", "lora"),
    "vae": ("vae",),
}
NEGATIVE_PROMPT = (
    "Close-up, Bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, "
    "images, static, overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, "
    "extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, misshapen limbs, fused "
    "fingers, still picture, messy background, three legs, many people in the background, walking backwards"
)

_PIPE_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}
_DEPENDENCY_SPECS = [
    {"module_name": "torch", "package_name": "torch", "display_name": "PyTorch", "description": "LongCat 推理需要 PyTorch/CUDA。"},
    {"module_name": "diffusers", "package_name": "diffusers", "display_name": "diffusers", "description": "加载 LongCat VAE 和调度器。"},
    {"module_name": "transformers", "package_name": "transformers", "display_name": "transformers", "description": "加载 UMT5 文本编码器和 Whisper 音频编码器。"},
    {"module_name": "einops", "package_name": "einops", "display_name": "einops", "description": "LongCat 张量维度重排。"},
    {"module_name": "ftfy", "package_name": "ftfy", "display_name": "ftfy", "description": "提示词清洗。"},
    {"module_name": "regex", "package_name": "regex", "display_name": "regex", "description": "提示词清洗。"},
    {"module_name": "scipy", "package_name": "scipy", "display_name": "scipy", "description": "音频处理。"},
    {"module_name": "pyloudnorm", "package_name": "pyloudnorm", "display_name": "pyloudnorm", "description": "LongCat 音频归一化。"},
    {"module_name": "librosa", "package_name": "librosa", "display_name": "librosa", "description": "读取和重采样音频。"},
    {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "临时音频文件写入。"},
    {"module_name": "safetensors", "package_name": "safetensors", "display_name": "safetensors", "description": "读取 DiT/LoRA 权重。"},
]


def _norm_rel(path: str | Path) -> str:
    return str(path).replace("\\", "/").strip("/")


def _models_roots() -> list[Path]:
    roots: list[Path] = []
    if folder_paths is not None:
        models_dir = getattr(folder_paths, "models_dir", None)
        if models_dir:
            roots.append(Path(models_dir))
    roots.extend([Path("D:/AI/MOD/models"), Path("D:/AI/CUI/ComfyUI/models")])
    out: list[Path] = []
    seen = set()
    for root in roots:
        try:
            key = str(root.resolve()).lower()
        except Exception:
            key = str(root).lower()
        if key not in seen:
            seen.add(key)
            out.append(root)
    return out


def _dir_has_safetensors(path: Path) -> bool:
    return path.exists() and any(p.is_file() and p.suffix == ".safetensors" for p in path.rglob("*.safetensors"))


def _full_longcat_video_dir() -> Path | None:
    root = Path("D:/AI/LongCat-Video")
    if (
        (root / "tokenizer" / "tokenizer.json").exists()
        and (root / "text_encoder" / "config.json").exists()
        and _dir_has_safetensors(root / "text_encoder")
        and (root / "vae" / "config.json").exists()
        and _dir_has_safetensors(root / "vae")
    ):
        return root
    return None


def _category_roots(category: str) -> list[Path]:
    roots: list[Path] = []
    if folder_paths is not None:
        try:
            for item in folder_paths.get_folder_paths(category):
                roots.append(Path(item))
        except Exception:
            pass
    aliases = CATEGORY_ALIASES.get(category, (category,))
    for model_root in _models_roots():
        roots.extend(model_root / alias for alias in aliases)
    out: list[Path] = []
    seen = set()
    for root in roots:
        key = str(root).lower()
        if key not in seen:
            seen.add(key)
            out.append(root)
    return out


def _existing_category_dir(category: str, rel_dir: str) -> Path | None:
    for root in _category_roots(category):
        candidate = root / rel_dir
        if candidate.exists() and candidate.is_dir():
            return candidate
    return None


def _display_category_path(category: str, path: Path) -> str:
    for root in _category_roots(category):
        try:
            return _norm_rel(Path("models") / root.name / path.relative_to(root))
        except Exception:
            continue
    return _norm_rel(path)


def _longcat_component_dir(rel_dir: str, required_file: str, need_safetensors: bool = False) -> Path | None:
    candidate = Path("D:/AI/LongCat-Video") / rel_dir
    if not (candidate / required_file).exists():
        return None
    if need_safetensors and not _dir_has_safetensors(candidate):
        return None
    return candidate


def _candidate_dirs(
    category: str,
    required_file: str,
    keywords: tuple[str, ...],
    external_dirs: tuple[Path | None, ...] = (),
) -> list[str]:
    found: list[str] = []
    seen = set()
    for root in _category_roots(category):
        if not root.exists():
            continue
        for marker in root.rglob(required_file):
            if not marker.is_file():
                continue
            rel = _norm_rel(marker.parent.relative_to(root))
            text = _norm_rel(marker.parent).lower()
            if keywords and not all(k.lower() in text for k in keywords):
                continue
            if rel not in seen:
                seen.add(rel)
                found.append(rel)
    for path in external_dirs:
        if path is None:
            continue
        value = _norm_rel(path)
        key = value.lower()
        if key not in seen:
            seen.add(key)
            found.append(value)
    return found or [AUTO]


def _default_choice(choices: list[str]) -> str:
    for choice in choices:
        if choice and choice != AUTO:
            return choice
    return AUTO


def _preferred_dir(category: str, selected: str, required_file: str, fallbacks: tuple[str, ...], keywords: tuple[str, ...]) -> Path:
    if selected and selected != AUTO:
        selected_path = Path(str(selected).strip().strip('"'))
        if selected_path.is_absolute() and (selected_path / required_file).exists():
            return selected_path
        path = _existing_category_dir(category, selected)
        if path and (path / required_file).exists():
            return path
    for rel in fallbacks:
        path = _existing_category_dir(category, rel)
        if path and (path / required_file).exists():
            return path
        full_base = _full_longcat_video_dir()
        if full_base and rel.startswith("LongCat-Video/"):
            candidate = full_base / rel.split("/", 1)[1]
            if (candidate / required_file).exists():
                return candidate
    candidates = _candidate_dirs(category, required_file, keywords)
    for rel in candidates:
        if rel == AUTO:
            continue
        path = _existing_category_dir(category, rel)
        if path and (path / required_file).exists():
            return path
    raise FileNotFoundError(f"missing models/{category}/{fallbacks[0]}/{required_file}")


def _lora_choices() -> list[str]:
    names: list[str] = []
    if folder_paths is not None:
        try:
            names = list(folder_paths.get_filename_list("loras"))
        except Exception:
            names = []
    filtered = [n for n in names if MODEL_HINTS["lora"][1].lower() in n.lower() or "longcat" in n.lower() or "dmd_lora" in Path(n).name.lower()]
    return [AUTO] + filtered if filtered else [AUTO]


def _resolve_lora(selected: str) -> Path:
    if selected and selected != AUTO and folder_paths is not None:
        try:
            path = folder_paths.get_full_path("loras", selected)
            if path and Path(path).exists():
                return Path(path)
        except Exception:
            pass
    for root in _category_roots("loras"):
        if root.exists():
            matches = [p for p in root.rglob("*.safetensors") if MODEL_HINTS["lora"][1].lower() in _norm_rel(p).lower()]
            if matches:
                return matches[0]
        for rel in (
            Path("LongCat-Video-Avatar-1.5") / "dmd_lora.safetensors",
            Path("dmd_lora.safetensors"),
        ):
            candidate = root / rel
            if candidate.exists():
                return candidate
        matches = list(root.rglob("dmd_lora.safetensors")) if root.exists() else []
        if matches:
            return matches[0]
    raise FileNotFoundError("missing models/loras/LongCat-Video-Avatar-1.5/dmd_lora.safetensors")


def _missing_dependency_specs() -> list[dict[str, str]]:
    return [spec for spec in _DEPENDENCY_SPECS if importlib.util.find_spec(spec["module_name"]) is None]


def _startup_missing_models() -> list[dict[str, str]]:
    specs: list[dict[str, str]] = []
    required = [
        ("DiT INT8", f"models/{MODEL_HINTS['dit'][0]}/{MODEL_HINTS['dit'][1]}", "quantized_model.safetensors.index.json", "Avatar 1.5 官方 INT8 DiT。"),
        ("DMD LoRA", f"models/{MODEL_HINTS['lora'][0]}/{MODEL_HINTS['lora'][1]}", "*.safetensors", "Avatar 1.5 蒸馏 LoRA，8 步推理需要。"),
        ("Whisper Large v3", f"models/{MODEL_HINTS['audio_encoder'][0]}/{MODEL_HINTS['audio_encoder'][1]}", "config.json", "Avatar 1.5 音频编码器。"),
        ("Vocal Separator", "models/audio_encoders/LongCat-Video-Avatar-1.5/vocal_separator", "Kim_Vocal_2.onnx", "可选人声分离模型。"),
        ("Scheduler", "models/configs/LongCat-Video-Avatar-1.5/scheduler", "scheduler_config.json", "Avatar 1.5 调度器配置。"),
        ("LongCat Tokenizer", "models/tokenizers/LongCat-Video/tokenizer", "tokenizer.json", "LongCat 基础文本 tokenizer。"),
        ("LongCat Text Encoder", f"models/{MODEL_HINTS['text_encoder'][0]}/{MODEL_HINTS['text_encoder'][1]}", "config.json", "LongCat 基础 UMT5 文本编码器。"),
        ("LongCat VAE", f"models/{MODEL_HINTS['vae'][0]}/{MODEL_HINTS['vae'][1]}", "config.json", "LongCat 基础视频 VAE。"),
    ]
    for label, subdir, filename, desc in required:
        rel = Path(subdir.replace("models/", "", 1))
        found = False
        for root in _models_roots():
            candidate_dir = root / rel
            found = bool(list(candidate_dir.glob(filename))) if "*" in filename else (candidate_dir / filename).exists()
            if found and label in {"LongCat Text Encoder", "LongCat VAE"}:
                found = _dir_has_safetensors(candidate_dir)
            if found:
                break
        if not found:
            if label == "DiT INT8":
                found = bool(_candidate_dirs("diffusion_models", "quantized_model.safetensors.index.json", (MODEL_HINTS["dit"][1],)) != [AUTO])
            elif label == "DMD LoRA":
                found = any(root.exists() and any(MODEL_HINTS["lora"][1].lower() in _norm_rel(p).lower() for p in root.rglob("*.safetensors")) for root in _category_roots("loras"))
            elif label == "Whisper Large v3":
                found = bool(_candidate_dirs("audio_encoders", "config.json", (MODEL_HINTS["audio_encoder"][1],)) != [AUTO])
                if not found:
                    found = bool(_candidate_dirs("faster-whisper", "model.safetensors", ("whisper", "large", "v3")) != [AUTO])
            elif label == "LongCat Text Encoder":
                found = bool(_candidate_dirs("text_encoders", "config.json", (MODEL_HINTS["text_encoder"][1],)) != [AUTO])
            elif label == "LongCat VAE":
                found = bool(_candidate_dirs("vae", "config.json", (MODEL_HINTS["vae"][1],)) != [AUTO])
        full_base = _full_longcat_video_dir()
        if not found and full_base and subdir.startswith("models/") and "LongCat-Video/" in subdir:
            suffix = subdir.split("LongCat-Video/", 1)[1]
            candidate_dir = full_base / suffix
            found = (candidate_dir / filename).exists()
            if found and label in {"LongCat Text Encoder", "LongCat VAE"}:
                found = _dir_has_safetensors(candidate_dir)
        if not found:
            specs.append(make_missing_model_spec(label=label, subdir=subdir, filename=filename, description=desc))
    return specs


_STARTUP_REPORT = build_dependency_model_report(
    node_name=DISPLAY_LOADER,
    missing_dependencies=_missing_dependency_specs(),
    missing_models=_startup_missing_models(),
    install_packages=[spec["package_name"] for spec in _missing_dependency_specs()],
    description="LongCat Avatar 1.5 需要 Avatar 权重以及 LongCat-Video 基础 tokenizer/text_encoder/vae。",
    model_download_url="https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5",
)


def _ensure_runtime(unique_id=None):
    missing = _missing_dependency_specs()
    if missing:
        raise_dependency_model_error(
            node_name=DISPLAY_LOADER,
            missing_dependencies=missing,
            install_packages=[spec["package_name"] for spec in missing],
            description="LongCat 数字人推理运行依赖不完整。",
            unique_id=unique_id,
        )
    if str(VENDOR_ROOT) not in sys.path:
        sys.path.insert(0, str(VENDOR_ROOT))


def _device():
    load_dependency_at_runtime("torch", DISPLAY_LOADER, package_name="torch")
    import torch

    if model_management is not None:
        try:
            return model_management.get_torch_device()
        except Exception:
            pass
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _clear_cache():
    gc.collect()
    if model_management is not None:
        try:
            model_management.soft_empty_cache()
        except Exception:
            pass
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def _pil_from_image(image):
    from PIL import Image

    if image is None:
        return None
    frame = image[0].detach().cpu().numpy()
    frame = np.clip(frame * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(frame, "RGB")


def _frames_to_tensor(frames: Any):
    load_dependency_at_runtime("torch", DISPLAY_GENERATOR, package_name="torch")
    import torch

    if isinstance(frames, torch.Tensor):
        tensor = frames.detach().float().cpu()
        if tensor.ndim == 5:
            tensor = tensor[0]
        if tensor.shape[1] in (1, 3, 4):
            tensor = tensor.permute(0, 2, 3, 1)
        if tensor.max() > 1.5:
            tensor = tensor / 255.0
        return tensor.clamp(0, 1)
    if isinstance(frames, np.ndarray):
        arr = frames[0] if frames.ndim == 5 else frames
        if arr.max() > 1.5:
            arr = arr / 255.0
        return torch.from_numpy(np.clip(arr, 0, 1).astype(np.float32))
    arr = np.stack([np.asarray(img).astype(np.float32) / 255.0 for img in frames], axis=0)
    return torch.from_numpy(np.clip(arr, 0, 1).astype(np.float32))


def _audio_array(audio=None, audio_file: str = "", target_sr: int = 16000, unique_id=None):
    librosa = load_dependency_at_runtime("librosa", DISPLAY_GENERATOR, package_name="librosa", unique_id=unique_id)
    if audio is not None:
        waveform = audio.get("waveform") if isinstance(audio, dict) else None
        sample_rate = int(audio.get("sample_rate", target_sr)) if isinstance(audio, dict) else target_sr
        if waveform is None:
            raise RuntimeError("音频输入格式不正确：缺少 waveform。")
        data = waveform.detach().cpu().float().numpy()
        while data.ndim > 1:
            data = data[0] if data.shape[0] == 1 else data.mean(axis=0)
        if sample_rate != target_sr:
            data = librosa.resample(data.astype(np.float32), orig_sr=sample_rate, target_sr=target_sr)
        return data.astype(np.float32), target_sr
    path = Path(str(audio_file or "").strip().strip('"'))
    if not path.exists():
        raise RuntimeError("请连接 AUDIO 输入，或填写可读取的音频文件路径。")
    data, sr = librosa.load(str(path), sr=target_sr, mono=True)
    return data.astype(np.float32), int(sr)


def _maybe_extract_vocal(audio_file: str, separator_dir: Path, enabled: bool, unique_id=None) -> str:
    if not enabled:
        return audio_file
    if not audio_file or not Path(audio_file).exists():
        return audio_file
    if importlib.util.find_spec("audio_separator") is None:
        report = build_dependency_model_report(
            node_name=DISPLAY_GENERATOR,
            missing_dependencies=[{"module_name": "audio_separator", "package_name": "audio-separator[gpu]", "display_name": "audio-separator", "description": "可选：用于从音乐中提取人声。"}],
            install_packages=["audio-separator[gpu]"],
            description="未安装 audio-separator，已自动改用原始音频继续执行。",
        )
        send_dependency_model_notice(report, unique_id=unique_id)
        return audio_file
    from audio_separator.separator import Separator

    out_dir = Path(tempfile.mkdtemp(prefix="gjj_longcat_vocal_"))
    separator = Separator(output_dir=out_dir / "vocals", output_single_stem="vocals", model_file_dir=str(separator_dir))
    separator.load_model("Kim_Vocal_2.onnx")
    outputs = separator.separate(audio_file)
    if not outputs:
        return audio_file
    vocal = out_dir / "vocals" / outputs[0]
    return str(vocal) if vocal.exists() else audio_file


def _audio_embedding(pipe, speech_array, sample_rate, num_frames, num_segments, save_fps, audio_stride, device):
    load_dependency_at_runtime("torch", DISPLAY_GENERATOR, package_name="torch")
    import torch

    num_cond_frames = 13
    generate_duration = num_frames / save_fps + (num_segments - 1) * (num_frames - num_cond_frames) / save_fps
    added = math.ceil((generate_duration - len(speech_array) / sample_rate) * sample_rate)
    if added > 0:
        speech_array = np.append(speech_array, np.zeros(added, dtype=np.float32))
    full_audio_emb = pipe.get_audio_embedding(
        speech_array,
        fps=save_fps * audio_stride,
        device=device,
        sample_rate=sample_rate,
        model_type="avatar-v1.5",
    )
    if torch.isnan(full_audio_emb).any():
        raise RuntimeError("音频编码结果包含 NaN，请换一段音频或关闭人声分离后重试。")
    return full_audio_emb


def _segment_audio_emb(full_audio_emb, start_idx, num_frames, audio_stride, device):
    load_dependency_at_runtime("torch", DISPLAY_GENERATOR, package_name="torch")
    import torch

    indices = torch.arange(5, device=full_audio_emb.device) - 2
    audio_end_idx = start_idx + audio_stride * num_frames
    center = torch.arange(start_idx, audio_end_idx, audio_stride, device=full_audio_emb.device).unsqueeze(1) + indices.unsqueeze(0)
    center = torch.clamp(center, min=0, max=full_audio_emb.shape[0] - 1)
    return full_audio_emb[center][None, ...].to(device)


class GJJ_LongCatAvatarLoader:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "load"
    RETURN_TYPES = ("GJJ_LONGCAT_AVATAR_PIPELINE", "STRING")
    RETURN_NAMES = ("LongCat管线", "加载状态")
    OUTPUT_TOOLTIPS = ("已加载的 LongCat Avatar 1.5 管线，供生成节点使用。", "加载路径、精度和依赖状态。")
    DESCRIPTION = _STARTUP_REPORT["warning_message"] if not _STARTUP_REPORT.get("available") else "加载 LongCat Avatar 1.5 官方 INT8 数字人推理管线。"
    GJJ_HELP = {
        "description": _STARTUP_REPORT["panel_message"] if not _STARTUP_REPORT.get("available") else "加载 LongCat Avatar 1.5：优先按目录关键词自动匹配 DiT、DMD LoRA、Whisper、UMT5 和 VAE。",
        "models": [
            "models/Diffusion_models/*LongCat-Avatar*",
            "models/loras/*LongCat-Avatar-15*",
            "models/audio_encoders/*whisper_large_v3_encoder*",
            "models/audio_encoders/LongCat-Video-Avatar-1.5/vocal_separator",
            "models/configs/LongCat-Video-Avatar-1.5/scheduler",
            "models/tokenizers/LongCat-Video/tokenizer",
            "models/text_encoders/*umt5-xxl-enc*",
            "models/vae/*Wan2_1_VAE_*",
        ],
        "copy_text": _STARTUP_REPORT.get("copy_text", ""),
        "copy_label": _STARTUP_REPORT.get("copy_label", ""),
    }

    @classmethod
    def INPUT_TYPES(cls):
        dit_choices = _candidate_dirs("diffusion_models", "quantized_model.safetensors.index.json", (MODEL_HINTS["dit"][1],))
        if dit_choices == [AUTO]:
            dit_choices = _candidate_dirs("diffusion_models", "quantized_model.safetensors.index.json", ("longcat", "base_model_int8"))
        lora_choices = _lora_choices()
        whisper_choices = _candidate_dirs("audio_encoders", "config.json", (MODEL_HINTS["audio_encoder"][1],))
        if whisper_choices == [AUTO]:
            whisper_choices = _candidate_dirs("faster-whisper", "model.safetensors", ("whisper", "large", "v3"))
        scheduler_choices = _candidate_dirs("configs", "scheduler_config.json", ("longcat", "scheduler"))
        tokenizer_choices = _candidate_dirs(
            "tokenizers",
            "tokenizer.json",
            ("longcat",),
            (_longcat_component_dir("tokenizer", "tokenizer.json"),),
        )
        text_encoder_choices = _candidate_dirs(
            "text_encoders",
            "config.json",
            (MODEL_HINTS["text_encoder"][1],),
            (_longcat_component_dir("text_encoder", "config.json", need_safetensors=True),),
        )
        vae_choices = _candidate_dirs(
            "vae",
            "config.json",
            (MODEL_HINTS["vae"][1],),
            (_longcat_component_dir("vae", "config.json", need_safetensors=True),),
        )
        return {
            "required": {
                "dit目录": (dit_choices, {"default": _default_choice(dit_choices), "display_name": "DiT目录", "tooltip": "默认在 models/Diffusion_models 中搜索包含 LongCat-Avatar 的目录。"}),
                "dmd_lora": (lora_choices, {"default": _default_choice(lora_choices), "display_name": "DMD LoRA", "tooltip": "默认在 models/loras 中搜索包含 LongCat-Avatar-15 的 LoRA。"}),
                "whisper目录": (whisper_choices, {"default": _default_choice(whisper_choices), "display_name": "Whisper目录", "tooltip": "默认在 models/audio_encoders 中搜索包含 whisper_large_v3_encoder 的目录。"}),
                "scheduler目录": (scheduler_choices, {"default": _default_choice(scheduler_choices), "display_name": "调度器目录", "tooltip": "默认搜索 models/configs/LongCat-Video-Avatar-1.5/scheduler。"}),
                "tokenizer目录": (tokenizer_choices, {"default": _default_choice(tokenizer_choices), "display_name": "Tokenizer目录", "tooltip": "默认搜索 models/tokenizers/LongCat-Video/tokenizer。"}),
                "text_encoder目录": (text_encoder_choices, {"default": _default_choice(text_encoder_choices), "display_name": "文本编码器目录", "tooltip": "默认在 models/text_encoders 中搜索包含 umt5-xxl-enc 的目录。"}),
                "vae目录": (vae_choices, {"default": _default_choice(vae_choices), "display_name": "VAE目录", "tooltip": "默认在 models/vae 中搜索包含 Wan2_1_VAE_ 的目录。"}),
            },
            "optional": {
                "保持缓存": ("BOOLEAN", {"default": True, "display_name": "保持缓存", "tooltip": "开启后重复执行会复用已加载管线，减少重复加载时间。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def load(self, dit目录=AUTO, dmd_lora=AUTO, whisper目录=AUTO, scheduler目录=AUTO, tokenizer目录=AUTO, text_encoder目录=AUTO, vae目录=AUTO, 保持缓存=True, unique_id=None):
        _ensure_runtime(unique_id=unique_id)
        missing_models = _startup_missing_models()
        if missing_models:
            raise_dependency_model_error(
                node_name=DISPLAY_LOADER,
                missing_models=missing_models,
                description="LongCat Avatar 1.5 缺少必需模型。请按 models 分类目录补齐后重启或刷新模型列表。",
                unique_id=unique_id,
                model_download_url="https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5",
            )

        dit_dir = _preferred_dir("diffusion_models", dit目录, "quantized_model.safetensors.index.json", (MODEL_HINTS["dit"][1], "LongCat-Video-Avatar-1.5/base_model_int8"), (MODEL_HINTS["dit"][1],))
        lora_path = _resolve_lora(dmd_lora)
        try:
            whisper_dir = _preferred_dir("audio_encoders", whisper目录, "config.json", (MODEL_HINTS["audio_encoder"][1],), (MODEL_HINTS["audio_encoder"][1],))
        except FileNotFoundError:
            whisper_dir = _preferred_dir("faster-whisper", whisper目录, "model.safetensors", ("whisper-large-v3",), ("whisper", "large", "v3"))
        scheduler_dir = _preferred_dir("configs", scheduler目录, "scheduler_config.json", ("LongCat-Video-Avatar-1.5/scheduler",), ("longcat", "scheduler"))
        tokenizer_dir = _preferred_dir("tokenizers", tokenizer目录, "tokenizer.json", ("LongCat-Video/tokenizer",), ("longcat",))
        text_encoder_dir = _preferred_dir("text_encoders", text_encoder目录, "config.json", (MODEL_HINTS["text_encoder"][1], "LongCat-Video/text_encoder"), (MODEL_HINTS["text_encoder"][1],))
        vae_dir = _preferred_dir("vae", vae目录, "config.json", (MODEL_HINTS["vae"][1], "LongCat-Video/vae"), (MODEL_HINTS["vae"][1],))
        separator_dir = _existing_category_dir("audio_encoders", "LongCat-Video-Avatar-1.5/vocal_separator") or Path()
        key = tuple(str(p.resolve()) for p in (dit_dir, lora_path, whisper_dir, scheduler_dir, tokenizer_dir, text_encoder_dir, vae_dir))
        if 保持缓存 and key in _PIPE_CACHE:
            return (_PIPE_CACHE[key], "✅ 已复用 LongCat Avatar 1.5 缓存管线")

        import torch
        from transformers import AutoTokenizer, UMT5EncoderModel
        from longcat_video.audio_process import get_audio_encoder, get_audio_feature_extractor
        from longcat_video.modules.autoencoder_kl_wan import AutoencoderKLWan
        from longcat_video.modules.quantization import load_quantized_dit
        from longcat_video.modules.scheduling_flow_match_euler_discrete import FlowMatchEulerDiscreteScheduler
        from longcat_video.pipeline_longcat_video_avatar import LongCatVideoAvatarPipeline

        device = _device()
        cp_split_hw = [1, 1]
        tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_dir), local_files_only=True, torch_dtype=torch.bfloat16)
        text_encoder = UMT5EncoderModel.from_pretrained(str(text_encoder_dir), local_files_only=True, torch_dtype=torch.bfloat16).eval()
        text_encoder.requires_grad_(False)
        vae = AutoencoderKLWan.from_pretrained(str(vae_dir), local_files_only=True, torch_dtype=torch.bfloat16).eval()
        vae.requires_grad_(False)
        scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(str(scheduler_dir), local_files_only=True, torch_dtype=torch.bfloat16)
        dit = load_quantized_dit(
            str(dit_dir.parent),
            subfolder=dit_dir.name,
            cp_split_hw=cp_split_hw,
            enable_flashattn3=False,
            enable_flashattn2=False,
            enable_xformers=False,
            enable_bsa=False,
        )
        dit.load_lora(str(lora_path), "dmd", multiplier=1.0, lora_network_dim=128, lora_network_alpha=64)
        dit.enable_loras(["dmd"])
        audio_encoder = get_audio_encoder(str(whisper_dir), "avatar-v1.5").eval().to(device)
        audio_encoder.requires_grad_(False)
        audio_feature_extractor = get_audio_feature_extractor(str(whisper_dir), "avatar-v1.5")
        pipe = LongCatVideoAvatarPipeline(
            tokenizer=tokenizer,
            text_encoder=text_encoder,
            vae=vae,
            scheduler=scheduler,
            dit=dit,
            audio_encoder=audio_encoder,
            audio_feature_extractor=audio_feature_extractor,
            model_type="avatar-v1.5",
        )
        pipe.to(device)
        payload = {
            "pipe": pipe,
            "device": device,
            "separator_dir": separator_dir,
            "precision": "INT8 DiT + BF16 VAE/T5 + Whisper",
            "paths": {
                "dit": _display_category_path("diffusion_models", dit_dir),
                "lora": _display_category_path("loras", lora_path),
                "whisper": _display_category_path("faster-whisper", whisper_dir),
            },
        }
        if 保持缓存:
            _PIPE_CACHE.clear()
            _PIPE_CACHE[key] = payload
        status = "✅ LongCat Avatar 1.5 已加载：官方 INT8 DiT + DMD LoRA + Whisper-large-v3。"
        return (payload, status)


class GJJ_LongCatAvatarGenerator:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "generate"
    RETURN_TYPES = ("IMAGE", "FLOAT", "STRING")
    RETURN_NAMES = ("视频帧", "帧率", "生成状态")
    OUTPUT_TOOLTIPS = ("生成的视频帧批次，可接入 VHS 或预览节点。", "输出视频帧率，Avatar 1.5 默认 25fps。", "本次生成参数和状态。")
    DESCRIPTION = "使用已加载的 LongCat Avatar 1.5 管线生成单人音频驱动视频。"
    GJJ_HELP = {
        "description": "接 LongCat 数字人加载器输出，输入音频和可选参考图，生成图片帧批次。连接参考图时使用 AI2V，不连接参考图时使用 AT2V。",
        "notes": ["Avatar 1.5 官方蒸馏模式固定 8 步、CFG=1。", "未安装 audio-separator 时，人声分离会自动降级为原始音频。"],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "longcat管线": ("GJJ_LONGCAT_AVATAR_PIPELINE", {"display_name": "LongCat管线", "tooltip": "连接 LongCat 数字人加载器输出。"}),
                "提示词": ("STRING", {"default": "A person is speaking naturally, clear face, stable body motion, realistic lighting", "multiline": True, "display_name": "提示词", "tooltip": "描述人物、场景、动作和画面风格。"}),
                "分辨率": (["480p", "720p"], {"default": "480p", "display_name": "分辨率", "tooltip": "官方支持 480p 和 720p。720p 更慢且更吃显存。"}),
                "生成模式": (["自动", "音频文本生视频", "音频图像生视频"], {"default": "自动", "display_name": "生成模式", "tooltip": "自动模式：有参考图用音频图像生视频，否则用音频文本生视频。"}),
                "随机种": ("INT", {"default": 42, "min": 0, "max": 0xFFFFFFFF, "display_name": "随机种", "tooltip": "生成随机种。"}),
            },
            "optional": {
                "音频": ("AUDIO", {"display_name": "音频", "tooltip": "ComfyUI AUDIO 输入。优先级高于音频文件路径。"}),
                "参考图像": ("IMAGE", {"display_name": "参考图像", "tooltip": "连接后使用 AI2V 数字人模式。"}),
                "音频文件路径": ("STRING", {"default": "", "display_name": "音频文件路径", "tooltip": "未连接 AUDIO 时，可填写本地音频文件路径。"}),
                "负面提示词": ("STRING", {"default": NEGATIVE_PROMPT, "multiline": True, "display_name": "负面提示词", "tooltip": "不希望出现在视频中的内容。"}),
                "视频段数": ("INT", {"default": 1, "min": 1, "max": 20, "display_name": "视频段数", "tooltip": "大于 1 时使用官方 Video Continuation 续写长视频。"}),
                "帧数": ("INT", {"default": 93, "min": 17, "max": 201, "step": 4, "display_name": "帧数", "tooltip": "单段帧数；LongCat 会修正为符合 VAE 时间步的帧数。"}),
                "参考帧索引": ("INT", {"default": 10, "min": 0, "max": 92, "display_name": "参考帧索引", "tooltip": "长视频续写时插入参考帧的位置。"}),
                "遮罩帧范围": ("INT", {"default": 3, "min": 0, "max": 24, "display_name": "遮罩帧范围", "tooltip": "长视频续写时降低重复动作的参考帧屏蔽范围。"}),
                "启用人声分离": ("BOOLEAN", {"default": False, "display_name": "启用人声分离", "tooltip": "仅对音频文件路径生效；缺少 audio-separator 时会自动使用原始音频。"}),
                "完成后清理缓存": ("BOOLEAN", {"default": False, "display_name": "完成后清理缓存", "tooltip": "完成后释放 PyTorch 缓存；不会卸载加载器缓存中的模型对象。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def generate(
        self,
        longcat管线,
        提示词,
        分辨率,
        生成模式,
        随机种,
        音频=None,
        参考图像=None,
        音频文件路径="",
        负面提示词=NEGATIVE_PROMPT,
        视频段数=1,
        帧数=93,
        参考帧索引=10,
        遮罩帧范围=3,
        启用人声分离=False,
        完成后清理缓存=False,
        unique_id=None,
    ):
        _ensure_runtime(unique_id=unique_id)
        load_dependency_at_runtime("torch", DISPLAY_GENERATOR, package_name="torch", unique_id=unique_id)
        import torch

        pipe = longcat管线["pipe"]
        device = longcat管线.get("device") or _device()
        save_fps = 25.0
        audio_stride = 1
        num_cond_frames = 13
        num_segments = max(1, int(视频段数))
        num_frames = max(17, int(帧数))
        if (num_frames - 1) % 4 != 0:
            num_frames = ((num_frames - 1) // 4) * 4 + 1
        use_image = 参考图像 is not None and 生成模式 != "音频文本生视频"
        if 生成模式 == "音频图像生视频" and 参考图像 is None:
            raise RuntimeError("选择“音频图像生视频”时必须连接参考图像。")

        audio_file = _maybe_extract_vocal(str(音频文件路径 or ""), longcat管线.get("separator_dir") or Path(), bool(启用人声分离), unique_id=unique_id)
        speech_array, sr = _audio_array(音频, audio_file, unique_id=unique_id)
        full_audio_emb = _audio_embedding(pipe, speech_array, sr, num_frames, num_segments, save_fps, audio_stride, device)
        audio_start_idx = 0
        audio_emb = _segment_audio_emb(full_audio_emb, audio_start_idx, num_frames, audio_stride, device)

        generator = torch.Generator(device=device)
        generator.manual_seed(int(随机种) & 0xFFFFFFFF)
        use_distill = True
        steps = 8
        text_cfg = 1.0
        audio_cfg = 1.0
        prompt = str(提示词 or "").strip()
        negative = str(负面提示词 or "").strip()
        start = time.time()
        all_frames = []
        height, width = (480, 832) if 分辨率 == "480p" else (768, 1280)
        with torch.inference_mode():
            if use_image:
                pil_image = _pil_from_image(参考图像)
                output, latent = pipe.generate_ai2v(
                    image=pil_image,
                    prompt=prompt,
                    negative_prompt=negative,
                    resolution=分辨率,
                    num_frames=num_frames,
                    num_inference_steps=steps,
                    text_guidance_scale=text_cfg,
                    audio_guidance_scale=audio_cfg,
                    output_type="both",
                    generator=generator,
                    audio_emb=audio_emb,
                    use_distill=use_distill,
                )
            else:
                output, latent = pipe.generate_at2v(
                    prompt=prompt,
                    negative_prompt=negative,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    num_inference_steps=steps,
                    text_guidance_scale=text_cfg,
                    audio_guidance_scale=audio_cfg,
                    output_type="both",
                    generator=generator,
                    audio_emb=audio_emb,
                    use_distill=use_distill,
                )
            output = output[0]
            from PIL import Image

            current_video = [Image.fromarray((np.clip(output[i], 0, 1) * 255).astype(np.uint8)) for i in range(output.shape[0])]
            all_frames.extend(current_video)
            ref_latent = latent[:, :, :1].clone()
            for segment_idx in range(1, num_segments):
                audio_start_idx += audio_stride * (num_frames - num_cond_frames)
                audio_emb = _segment_audio_emb(full_audio_emb, audio_start_idx, num_frames, audio_stride, device)
                output, latent = pipe.generate_avc(
                    video=current_video,
                    video_latent=latent,
                    prompt=prompt,
                    negative_prompt=negative,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    num_cond_frames=num_cond_frames,
                    num_inference_steps=steps,
                    text_guidance_scale=text_cfg,
                    audio_guidance_scale=audio_cfg,
                    generator=generator,
                    output_type="both",
                    use_kv_cache=True,
                    offload_kv_cache=False,
                    enhance_hf=False,
                    audio_emb=audio_emb,
                    ref_latent=ref_latent,
                    ref_img_index=int(参考帧索引),
                    mask_frame_range=int(遮罩帧范围),
                    use_distill=use_distill,
                )
                output = output[0]
                current_video = [Image.fromarray((np.clip(output[i], 0, 1) * 255).astype(np.uint8)) for i in range(output.shape[0])]
                all_frames.extend(current_video[num_cond_frames:])
                _clear_cache()

        result = _frames_to_tensor(all_frames)
        if 完成后清理缓存:
            _clear_cache()
        elapsed = time.time() - start
        status = f"✅ LongCat 生成完成：{result.shape[0]} 帧，{save_fps:.0f}fps，{分辨率}，耗时 {elapsed:.1f}s。"
        return (result, float(save_fps), status)


NODE_CLASS_MAPPINGS = {
    "GJJ_LongCatAvatarLoader": GJJ_LongCatAvatarLoader,
    "GJJ_LongCatAvatarGenerator": GJJ_LongCatAvatarGenerator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_LongCatAvatarLoader": DISPLAY_LOADER,
    "GJJ_LongCatAvatarGenerator": DISPLAY_GENERATOR,
}
