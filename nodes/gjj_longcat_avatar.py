from __future__ import annotations

import gc
import importlib.util
import json
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
    from .common_utils.progress import send_node_progress
except ImportError:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
        send_dependency_model_notice,
    )
    from common_utils.progress import send_node_progress


NODE_LOADER = "GJJ_LongCatAvatarLoader"
NODE_GENERATOR = "GJJ_LongCatAvatarGenerator"
DISPLAY_LOADER = "GJJ · 🐱 LongCat数字人加载器"
DISPLAY_GENERATOR = "GJJ · 🎭 LongCat数字人生成"
GJJ_ROOT = Path(__file__).resolve().parents[1]
VENDOR_ROOT = GJJ_ROOT / "vendor" / "longcat_video_runtime"
AUTO = "自动检测"
MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d"
LONGCAT_AVATAR_MODEL = "LongCat-Avatar-15_bf16.safetensors"
LONGCAT_DMD_LORA = "LongCat-Avatar-15_dmd_distill_lora_rank128_bf16.safetensors"
LONGCAT_WHISPER_MODEL = "whisper_large_v3_encoder_fp16.safetensors"
LONGCAT_T5_MODEL = "umt5-xxl-enc-bf16.safetensors"
LONGCAT_VAE_MODEL = "Wan2_1_VAE_bf16.safetensors"
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
LONGCAT_PROMPT = "一个人物正在自然地说话，面部清晰，对口型准确，动作稳定，光线自然"
LONGCAT_SCHEDULERS = [
    "longcat_distill_euler",
    "euler",
    "dpm++_sde",
    "dpm++",
    "unipc",
    "multitalk",
]

_PIPE_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}
_DEPENDENCY_SPECS = [
    {"module_name": "torch", "package_name": "torch", "display_name": "PyTorch", "description": "LongCat 推理需要 PyTorch/CUDA。"},
    {"module_name": "numpy", "package_name": "numpy", "display_name": "numpy", "description": "处理音频波形和视频帧数组。"},
    {"module_name": "accelerate", "package_name": "accelerate", "display_name": "accelerate", "description": "按 safetensors 单文件加载 Whisper/T5/WanVideo 权重。"},
    {"module_name": "transformers", "package_name": "transformers", "display_name": "transformers", "description": "加载 UMT5 文本编码器和 Whisper 音频编码器。"},
    {"module_name": "einops", "package_name": "einops", "display_name": "einops", "description": "WanVideo/LongCat 张量维度重排。"},
    {"module_name": "torchaudio", "package_name": "torchaudio", "display_name": "torchaudio", "description": "重采样 AUDIO 输入并生成 Whisper 音频嵌入。"},
    {"module_name": "pyloudnorm", "package_name": "pyloudnorm", "display_name": "pyloudnorm", "description": "LongCat 参考工作流的音频响度归一化。"},
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


def _file_choices(category: str, preferred: str, keywords: tuple[str, ...]) -> list[str]:
    names: list[str] = []
    if folder_paths is not None:
        try:
            names = list(folder_paths.get_filename_list(category) or [])
        except Exception:
            names = []
    if not names:
        return [AUTO]
    lower_keywords = [k.lower() for k in keywords if k]
    filtered = [
        name for name in names
        if not lower_keywords or any(k in str(name).replace("\\", "/").lower() for k in lower_keywords)
    ] or names
    preferred_match = next((name for name in filtered if str(name).replace("\\", "/").lower().endswith(preferred.lower())), None)
    if preferred_match:
        return [preferred_match] + [name for name in filtered if name != preferred_match]
    return filtered


def _selected_file(category: str, selected: str, preferred: str, label: str, unique_id=None) -> str:
    value = str(selected or "").strip()
    if value and value != AUTO:
        return value
    choices = _file_choices(category, preferred, (Path(preferred).stem,))
    if choices and choices[0] != AUTO:
        return choices[0]
    raise_dependency_model_error(
        node_name=DISPLAY_GENERATOR,
        missing_models=[make_missing_model_spec(label=label, subdir=f"models/{category}", filename=preferred, description="LongCat Avatar 1.5 成功工作流使用的单文件权重。")],
        description="LongCat 数字人生成节点内部加载成功工作流所需 safetensors 单文件权重。",
        unique_id=unique_id,
        model_download_url=MODEL_DOWNLOAD_URL,
    )


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
        ("LongCat Avatar DiT", "diffusion_models", LONGCAT_AVATAR_MODEL, "成功工作流使用的 LongCat Avatar 1.5 单文件 DiT。"),
        ("DMD Distill LoRA", "loras", LONGCAT_DMD_LORA, "成功工作流使用的 DMD 蒸馏 LoRA。"),
        ("Whisper Encoder", "audio_encoders", LONGCAT_WHISPER_MODEL, "成功工作流使用的 Whisper encoder 单文件。"),
        ("UMT5 Text Encoder", "text_encoders", LONGCAT_T5_MODEL, "成功工作流使用的 T5 文本编码器单文件。"),
        ("Wan VAE", "vae", LONGCAT_VAE_MODEL, "成功工作流使用的 Wan VAE 单文件。"),
    ]
    for label, category, filename, desc in required:
        found = False
        if folder_paths is not None:
            try:
                found = any(str(name).replace("\\", "/").lower().endswith(filename.lower()) for name in folder_paths.get_filename_list(category))
            except Exception:
                found = False
        if not found:
            specs.append(make_missing_model_spec(label=label, subdir=f"models/{category}", filename=filename, description=desc))
    return specs


_STARTUP_MISSING_DEPENDENCIES = _missing_dependency_specs()
_STARTUP_MISSING_MODELS = _startup_missing_models()
_STARTUP_REPORT = build_dependency_model_report(
    node_name=DISPLAY_GENERATOR,
    missing_dependencies=_STARTUP_MISSING_DEPENDENCIES,
    missing_models=_STARTUP_MISSING_MODELS,
    install_packages=[spec["package_name"] for spec in _STARTUP_MISSING_DEPENDENCIES],
    description="LongCat Avatar 1.5 数字人生成节点已对齐成功工作流，内部加载 WanVideo/Whisper/T5/VAE/LoRA。",
    model_download_url=MODEL_DOWNLOAD_URL,
)


def _ensure_runtime(unique_id=None, node_name=DISPLAY_GENERATOR):
    missing = _missing_dependency_specs()
    if missing:
        raise_dependency_model_error(
            node_name=node_name,
            missing_dependencies=missing,
            install_packages=[spec["package_name"] for spec in missing],
            description="LongCat 数字人推理运行依赖不完整。",
            unique_id=unique_id,
        )
    if str(VENDOR_ROOT) not in sys.path:
        sys.path.insert(0, str(VENDOR_ROOT))


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    send_node_progress(unique_id, text, progress)


def _safe_int(value: Any, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
    try:
        result = int(float(value))
    except Exception:
        result = int(default)
    if min_value is not None:
        result = max(int(min_value), result)
    if max_value is not None:
        result = min(int(max_value), result)
    return result


def _safe_float(value: Any, default: float, min_value: float | None = None, max_value: float | None = None) -> float:
    try:
        result = float(value)
    except Exception:
        result = float(default)
    if min_value is not None:
        result = max(float(min_value), result)
    if max_value is not None:
        result = min(float(max_value), result)
    return result


def _safe_choice(value: Any, choices: list[str], default: str) -> str:
    text = str(value or "").strip()
    return text if text in choices else default


def _node_result(value: Any) -> Any:
    if isinstance(value, dict) and "result" in value:
        return value["result"]
    return value


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


def _raise_startup_model_notice(unique_id=None):
    missing_models = _startup_missing_models()
    if missing_models:
        raise_dependency_model_error(
            node_name=DISPLAY_GENERATOR,
            missing_models=missing_models,
            description="LongCat 数字人生成节点缺少参考工作流所需的 safetensors 单文件权重。",
            unique_id=unique_id,
            model_download_url=MODEL_DOWNLOAD_URL,
        )


def _longcat_workflow_files(unique_id=None) -> dict[str, str]:
    _raise_startup_model_notice(unique_id=unique_id)
    return {
        "dit": _selected_file("diffusion_models", AUTO, LONGCAT_AVATAR_MODEL, "LongCat Avatar DiT", unique_id),
        "lora": _selected_file("loras", AUTO, LONGCAT_DMD_LORA, "DMD Distill LoRA", unique_id),
        "whisper": _selected_file("audio_encoders", AUTO, LONGCAT_WHISPER_MODEL, "Whisper Encoder", unique_id),
        "t5": _selected_file("text_encoders", AUTO, LONGCAT_T5_MODEL, "UMT5 Text Encoder", unique_id),
        "vae": _selected_file("vae", AUTO, LONGCAT_VAE_MODEL, "Wan VAE", unique_id),
    }


def _audio_frame_count(audio: Any, fps: float) -> int:
    if not isinstance(audio, dict) or "waveform" not in audio or "sample_rate" not in audio:
        raise RuntimeError("音频输入格式无效：请连接 ComfyUI AUDIO。")
    waveform = audio["waveform"]
    sample_rate = int(audio.get("sample_rate") or 0)
    if sample_rate <= 0 or not hasattr(waveform, "shape") or int(waveform.shape[-1]) <= 0:
        raise RuntimeError("音频输入为空或采样率无效。")
    duration = float(waveform.shape[-1]) / float(sample_rate)
    frames = int((duration * float(fps)) // 4 * 4 + 1)
    return max(17, frames)


def _resize_reference_image(image: Any, width: int = 512, height: int = 512):
    load_dependency_at_runtime("torch", DISPLAY_GENERATOR, package_name="torch")
    import torch
    from comfy.utils import common_upscale

    if not isinstance(image, torch.Tensor):
        raise RuntimeError("图片输入格式无效：请连接 IMAGE 或 GJJ_BATCH_IMAGE。")
    pixels = image
    if pixels.ndim == 3:
        pixels = pixels.unsqueeze(0)
    if pixels.ndim != 4:
        raise RuntimeError(f"图片输入维度无效，应为 [B,H,W,C]，实际为 {tuple(pixels.shape)}。")
    pixels = pixels[:1].detach().float().cpu()
    if int(pixels.shape[-1]) > 3:
        pixels = pixels[..., :3]
    src_h = max(1, int(pixels.shape[1]))
    src_w = max(1, int(pixels.shape[2]))
    scale = max(float(width) / float(src_w), float(height) / float(src_h))
    scaled_w = max(width, int(round(src_w * scale)))
    scaled_h = max(height, int(round(src_h * scale)))
    nchw = pixels.movedim(-1, 1)
    resized = common_upscale(nchw, scaled_w, scaled_h, "nearest-exact", "disabled")
    left = max(0, (scaled_w - width) // 2)
    top = max(0, (scaled_h - height) // 2)
    cropped = resized[:, :, top:top + height, left:left + width]
    if int(cropped.shape[-2]) != height or int(cropped.shape[-1]) != width:
        cropped = common_upscale(cropped, width, height, "nearest-exact", "disabled")
    return cropped.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _load_reference_workflow_assets(unique_id=None, blocks_to_swap=40, lora_strength=1.0) -> dict[str, Any]:
    _ensure_runtime(unique_id=unique_id, node_name=DISPLAY_GENERATOR)
    files = _longcat_workflow_files(unique_id=unique_id)
    swap_blocks = _safe_int(blocks_to_swap, 40, min_value=0, max_value=80)
    lora_value = round(_safe_float(lora_strength, 1.0, min_value=-10.0, max_value=10.0), 4)
    cache_key = ("longcat_avatar_workflow", files["dit"], files["lora"], files["whisper"], files["t5"], files["vae"], swap_blocks, lora_value)
    cached = _PIPE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    from .gjj_wan_video_block_swap import GJJ_WanVideoBlockSwap, GJJ_WanVideoSetBlockSwap
    from .gjj_wanvideo_model_loader import GJJ_WanVideoModelLoader
    from .gjj_wanvideo_vae_loader import GJJ_WanVideoVAELoader

    lora_config = json.dumps([{"enabled": True, "name": files["lora"], "strength": lora_value}], ensure_ascii=False)
    block_swap_args, = GJJ_WanVideoBlockSwap().setargs(
        blocks_to_swap=swap_blocks,
        offload_img_emb=False,
        offload_txt_emb=False,
        use_non_blocking=False,
        vace_blocks_to_swap=0,
        prefetch_blocks=0,
        block_swap_debug=False,
    )
    model, = GJJ_WanVideoModelLoader().loadmodel(
        model=files["dit"],
        base_precision="bf16",
        load_device="offload_device",
        quantization="disabled",
        attention_mode="sdpa",
        lora=lora_config,
        rms_norm_function="default",
    )
    model, = GJJ_WanVideoSetBlockSwap().loadmodel(model=model, block_swap_args=block_swap_args)
    vae, = GJJ_WanVideoVAELoader().loadmodel(
        model_name=files["vae"],
        precision="bf16",
        use_cpu_cache=False,
        verbose=False,
        unique_id=unique_id,
    )
    assets = {
        "model": model,
        "vae": vae,
        "files": files,
        "lora_config": lora_config,
    }
    _PIPE_CACHE.clear()
    _PIPE_CACHE[cache_key] = assets
    return assets


class GJJ_LongCatAvatarLoader:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "load"
    RETURN_TYPES = ("WANVIDEOMODEL", "LORA_CHAIN_CONFIG", "STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("LongCat模型", "DMD LoRA配置", "Whisper模型", "T5模型", "VAE模型", "加载状态")
    OUTPUT_TOOLTIPS = (
        "按成功工作流加载好的 WanVideo LongCat Avatar 模型，可接 GJJ WanVideo Sampler v2。",
        "成功工作流使用的 DMD LoRA 配置 JSON。",
        "成功工作流使用的 Whisper encoder 文件名，可用于 LongCat数字人Whisper嵌入。",
        "成功工作流使用的 T5 文件名，可用于 Wan T5 文本编码。",
        "成功工作流使用的 VAE 文件名，可用于 WanVideo VAE 加载器。",
        "加载路径、精度和对齐状态。",
    )
    DESCRIPTION = _STARTUP_REPORT["warning_message"] if not _STARTUP_REPORT.get("available") else "加载 LongCat Avatar 1.5 成功工作流单文件 safetensors 模型，不再使用官方目录结构权重。"
    GJJ_HELP = {
        "description": _STARTUP_REPORT["panel_message"] if not _STARTUP_REPORT.get("available") else "完全对齐 examples/GJJ_ViDEO/longcatAvatar1.5美团龙猫对口型数字人.json：只使用单文件 safetensors 权重，不再检测 scheduler/tokenizer/text_encoder/vae 官方目录。",
        "models": [
            f"models/diffusion_models/{LONGCAT_AVATAR_MODEL}",
            f"models/loras/{LONGCAT_DMD_LORA}",
            f"models/audio_encoders/{LONGCAT_WHISPER_MODEL}",
            f"models/text_encoders/{LONGCAT_T5_MODEL}",
            f"models/vae/{LONGCAT_VAE_MODEL}",
        ],
        "notice": _STARTUP_REPORT.get("help_message", "") if not _STARTUP_REPORT.get("available", True) else "",
        "copy_text": _STARTUP_REPORT.get("copy_text", ""),
        "copy_label": _STARTUP_REPORT.get("copy_label", ""),
        "warning_message": _STARTUP_REPORT.get("warning_message", "") if not _STARTUP_REPORT.get("available", True) else "",
        "install_cmd": _STARTUP_REPORT.get("install_cmd", "") if not _STARTUP_REPORT.get("available", True) else "",
        "optional_install_cmd": _STARTUP_REPORT.get("optional_install_cmd", ""),
        "model_download_url": _STARTUP_REPORT.get("model_download_url", MODEL_DOWNLOAD_URL),
        "notice_level": _STARTUP_REPORT.get("notice_level", ""),
    }

    @classmethod
    def INPUT_TYPES(cls):
        dit_choices = _file_choices("diffusion_models", LONGCAT_AVATAR_MODEL, ("longcat", "avatar"))
        lora_choices = _file_choices("loras", LONGCAT_DMD_LORA, ("longcat", "dmd", "distill"))
        whisper_choices = _file_choices("audio_encoders", LONGCAT_WHISPER_MODEL, ("whisper", "large", "v3"))
        text_encoder_choices = _file_choices("text_encoders", LONGCAT_T5_MODEL, ("umt5", "xxl"))
        vae_choices = _file_choices("vae", LONGCAT_VAE_MODEL, ("wan", "vae"))
        return {
            "required": {
                "dit单文件": (dit_choices, {"default": _default_choice(dit_choices), "display_name": "DiT单文件", "tooltip": f"成功工作流使用 {LONGCAT_AVATAR_MODEL}，从 models/diffusion_models 选择。"}),
                "dmd_lora": (lora_choices, {"default": _default_choice(lora_choices), "display_name": "DMD LoRA", "tooltip": f"成功工作流使用 {LONGCAT_DMD_LORA}，从 models/loras 选择。"}),
                "whisper单文件": (whisper_choices, {"default": _default_choice(whisper_choices), "display_name": "Whisper单文件", "tooltip": f"成功工作流使用 {LONGCAT_WHISPER_MODEL}，从 models/audio_encoders 选择。"}),
                "t5单文件": (text_encoder_choices, {"default": _default_choice(text_encoder_choices), "display_name": "T5单文件", "tooltip": f"成功工作流使用 {LONGCAT_T5_MODEL}，从 models/text_encoders 选择。"}),
                "vae单文件": (vae_choices, {"default": _default_choice(vae_choices), "display_name": "VAE单文件", "tooltip": f"成功工作流使用 {LONGCAT_VAE_MODEL}，从 models/vae 选择。"}),
            },
            "optional": {
                "保持缓存": ("BOOLEAN", {"default": True, "display_name": "保持缓存", "tooltip": "开启后重复执行会复用已加载管线，减少重复加载时间。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def load(self, dit单文件=AUTO, dmd_lora=AUTO, whisper单文件=AUTO, t5单文件=AUTO, vae单文件=AUTO, 保持缓存=True, unique_id=None):
        missing_models = _startup_missing_models()
        if missing_models:
            raise_dependency_model_error(
                node_name=DISPLAY_LOADER,
                missing_models=missing_models,
                description="LongCat Avatar 1.5 缺少成功工作流所需 safetensors 单文件权重。请放入对应 models 分类目录。",
                unique_id=unique_id,
                model_download_url=MODEL_DOWNLOAD_URL,
            )

        dit_file = _selected_file("diffusion_models", dit单文件, LONGCAT_AVATAR_MODEL, "LongCat Avatar DiT", unique_id)
        lora_file = _selected_file("loras", dmd_lora, LONGCAT_DMD_LORA, "DMD Distill LoRA", unique_id)
        whisper_file = _selected_file("audio_encoders", whisper单文件, LONGCAT_WHISPER_MODEL, "Whisper Encoder", unique_id)
        t5_file = _selected_file("text_encoders", t5单文件, LONGCAT_T5_MODEL, "UMT5 Text Encoder", unique_id)
        vae_file = _selected_file("vae", vae单文件, LONGCAT_VAE_MODEL, "Wan VAE", unique_id)
        lora_config = json.dumps([{"enabled": True, "name": lora_file, "strength": 1.0}], ensure_ascii=False)
        key = (dit_file, lora_file, whisper_file, t5_file, vae_file)
        if 保持缓存 and key in _PIPE_CACHE:
            model = _PIPE_CACHE[key]
            return (model, lora_config, whisper_file, t5_file, vae_file, "✅ 已复用 LongCat Avatar 1.5 WanVideo 单文件模型缓存")

        from .gjj_wanvideo_model_loader import GJJ_WanVideoModelLoader

        model, = GJJ_WanVideoModelLoader().loadmodel(
            model=dit_file,
            base_precision="bf16",
            load_device="offload_device",
            quantization="disabled",
            attention_mode="comfy",
            lora=lora_config,
            rms_norm_function="default",
        )
        if 保持缓存:
            _PIPE_CACHE.clear()
            _PIPE_CACHE[key] = model
        status = (
            "✅ 已对齐成功工作流加载 LongCat Avatar 1.5 单文件模型：\n"
            f"DiT：{dit_file}\nLoRA：{lora_file}\nWhisper：{whisper_file}\nT5：{t5_file}\nVAE：{vae_file}\n"
            "采样建议：8步 / CFG 1 / Shift 12 / longcat_distill_euler。"
        )
        return (model, lora_config, whisper_file, t5_file, vae_file, status)


class GJJ_LongCatAvatarGenerator:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频",)
    OUTPUT_TOOLTIPS = ("LongCat Avatar 1.5 数字人口型视频，已封入输入音频。",)
    DESCRIPTION = _STARTUP_REPORT["warning_message"] if not _STARTUP_REPORT.get("available") else "输入图片和音频，节点内部按参考工作流加载 LongCat Avatar 1.5 模型并输出视频。"
    GJJ_HELP = {
        "description": _STARTUP_REPORT["panel_message"] if not _STARTUP_REPORT.get("available") else "完全内置 examples/GJJ_ViDEO/longcatAvatar1.5美团龙猫对口型数字人.json 的核心链路：图片缩放、VAE 编码、Whisper 音频嵌入、LongCat 条件、WanVideo 采样、VAE 解码和视频合成。",
        "models": [
            f"models/diffusion_models/{LONGCAT_AVATAR_MODEL}",
            f"models/loras/{LONGCAT_DMD_LORA}",
            f"models/audio_encoders/{LONGCAT_WHISPER_MODEL}",
            f"models/text_encoders/{LONGCAT_T5_MODEL}",
            f"models/vae/{LONGCAT_VAE_MODEL}",
        ],
        "notice": _STARTUP_REPORT.get("help_message", "") if not _STARTUP_REPORT.get("available", True) else "",
        "warning_message": _STARTUP_REPORT.get("warning_message", "") if not _STARTUP_REPORT.get("available", True) else "",
        "install_cmd": _STARTUP_REPORT.get("install_cmd", "") if not _STARTUP_REPORT.get("available", True) else "",
        "optional_install_cmd": _STARTUP_REPORT.get("optional_install_cmd", ""),
        "copy_text": _STARTUP_REPORT.get("copy_text", ""),
        "copy_label": _STARTUP_REPORT.get("copy_label", ""),
        "model_download_url": _STARTUP_REPORT.get("model_download_url", MODEL_DOWNLOAD_URL),
        "notice_level": _STARTUP_REPORT.get("notice_level", ""),
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "GJJ_BATCH_IMAGE,IMAGE",
                    {
                        "display_name": "图片",
                        "tooltip": "数字人参考图。节点内部会按参考工作流裁剪填满到 512x512。",
                    },
                ),
                "audio": (
                    "AUDIO",
                    {
                        "display_name": "音频",
                        "tooltip": "驱动口型的音频。节点会按音频长度自动计算帧数并封入输出视频。",
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": LONGCAT_PROMPT,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "描述数字人口型视频的画面内容。默认值来自内置参考工作流，可直接编辑或外接 STRING。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": NEGATIVE_PROMPT,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "负向提示词",
                        "tooltip": "描述不希望出现在视频中的内容。默认使用参考工作流的通用负向词。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xffffffffffffffff,
                        "control_after_generate": True,
                        "display_name": "随机种子",
                        "tooltip": "0 表示每次随机；大于 0 时固定结果。可在生成后自动变化。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 8,
                        "min": 1,
                        "max": 80,
                        "step": 1,
                        "display_name": "采样步数",
                        "tooltip": "参考工作流为 8 步。步数越高越慢，蒸馏 LongCat 通常不需要很高。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 30.0,
                        "step": 0.05,
                        "display_name": "CFG",
                        "tooltip": "提示词引导强度。参考工作流为 1。",
                    },
                ),
                "shift": (
                    "FLOAT",
                    {
                        "default": 12.0,
                        "min": 0.0,
                        "max": 1000.0,
                        "step": 0.1,
                        "display_name": "Shift",
                        "tooltip": "WanVideo 采样 Shift。参考工作流为 12。",
                    },
                ),
                "scheduler": (
                    LONGCAT_SCHEDULERS,
                    {
                        "default": "longcat_distill_euler",
                        "display_name": "调度器",
                        "tooltip": "参考工作流使用 longcat_distill_euler。",
                    },
                ),
                "lora_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": -10.0,
                        "max": 10.0,
                        "step": 0.05,
                        "display_name": "DMD LoRA强度",
                        "tooltip": "内置 DMD 蒸馏 LoRA 的强度。改动后会按新强度重新加载模型缓存。",
                    },
                ),
                "blocks_to_swap": (
                    "INT",
                    {
                        "default": 40,
                        "min": 0,
                        "max": 80,
                        "step": 1,
                        "display_name": "Block Swap",
                        "tooltip": "分块交换数量，用于降低显存占用。参考工作流为 40。",
                    },
                ),
                "audio_fps": (
                    "FLOAT",
                    {
                        "default": 25.0,
                        "min": 1.0,
                        "max": 120.0,
                        "step": 0.5,
                        "display_name": "音频嵌入FPS",
                        "tooltip": "Whisper 音频嵌入按此帧率计算。参考工作流为 25。",
                    },
                ),
                "output_fps": (
                    "FLOAT",
                    {
                        "default": 24.0,
                        "min": 1.0,
                        "max": 120.0,
                        "step": 0.5,
                        "display_name": "输出FPS",
                        "tooltip": "最终 MP4 视频帧率。参考工作流的视频合成为 24。",
                    },
                ),
                "normalize_loudness": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "响度归一化",
                        "tooltip": "开启后按参考工作流对音频做响度归一化，口型驱动更稳定。",
                    },
                ),
                "keep_model_cache": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "保留模型缓存",
                        "tooltip": "开启后复用已加载的 LongCat/Wan/VAE 模型；关闭后本次结束会清空节点模型缓存。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def generate(
        self,
        image,
        audio,
        positive_prompt=LONGCAT_PROMPT,
        negative_prompt=NEGATIVE_PROMPT,
        seed=0,
        steps=8,
        cfg=1.0,
        shift=12.0,
        scheduler="longcat_distill_euler",
        lora_strength=1.0,
        blocks_to_swap=40,
        audio_fps=25.0,
        output_fps=24.0,
        normalize_loudness=True,
        keep_model_cache=True,
        unique_id=None,
        prompt=None,
        extra_pnginfo=None,
    ):
        start = time.time()
        audio_fps = _safe_float(audio_fps, 25.0, min_value=1.0, max_value=120.0)
        output_fps = _safe_float(output_fps, 24.0, min_value=1.0, max_value=120.0)
        steps = _safe_int(steps, 8, min_value=1, max_value=80)
        cfg = _safe_float(cfg, 1.0, min_value=0.0, max_value=30.0)
        shift = _safe_float(shift, 12.0, min_value=0.0, max_value=1000.0)
        scheduler = _safe_choice(scheduler, LONGCAT_SCHEDULERS, "longcat_distill_euler")
        lora_strength = _safe_float(lora_strength, 1.0, min_value=-10.0, max_value=10.0)
        blocks_to_swap = _safe_int(blocks_to_swap, 40, min_value=0, max_value=80)
        seed = _safe_int(seed, 0, min_value=0, max_value=0xffffffffffffffff)
        if seed <= 0:
            seed = random.randrange(1, 0xffffffffffffffff)
        positive_prompt = str(positive_prompt or LONGCAT_PROMPT).strip() or LONGCAT_PROMPT
        negative_prompt = str(negative_prompt or "").strip()

        _send_status(unique_id, "1/8 检查输入并准备 LongCat 模型...", 0.04)
        num_frames = _audio_frame_count(audio, audio_fps)
        assets = _load_reference_workflow_assets(
            unique_id=unique_id,
            blocks_to_swap=blocks_to_swap,
            lora_strength=lora_strength,
        )
        files = assets["files"]
        _send_status(unique_id, "2/8 裁剪参考图并加载子节点...", 0.12)
        ref_image = _resize_reference_image(image, 512, 512)

        from .gjj_longcat_avatar_extend_embeds import GJJ_LongCatAvatarExtendEmbeds
        from .gjj_longcat_avatar_whisper_embeds import GJJ_LongCatAvatarWhisperEmbeds
        from .gjj_video_combine import GJJ_VideoCombine
        from .gjj_wanvideo_decode import GJJ_WanVideoDecode
        from .gjj_wanvideo_encode import GJJ_WanVideoEncode
        from .gjj_wanvideo_sampler_v2 import GJJ_WanVideoSamplerV2
        from .gjj_wanvideo_t5_text_encode import GJJ_WanVideoT5TextEncode

        _send_status(unique_id, f"3/8 提取 Whisper 音频嵌入：{int(num_frames)} 帧...", 0.2)
        audio_embeds, trimmed_audio, effective_frames = _node_result(GJJ_LongCatAvatarWhisperEmbeds().process(
            model_name=files["whisper"],
            base_precision="fp16",
            load_device="offload_device",
            normalize_loudness=bool(normalize_loudness),
            num_frames=num_frames,
            fps=audio_fps,
            audio_scale=1.0,
            audio_cfg_scale=1.0,
            multi_audio_type="para",
            audio_1=audio,
        ))
        _send_status(unique_id, "4/8 VAE 编码参考图...", 0.34)
        ref_latent, = _node_result(GJJ_WanVideoEncode().encode(
            vae=assets["vae"],
            image=ref_image,
            enable_vae_tiling=False,
            tile_x=272,
            tile_y=272,
            tile_stride_x=144,
            tile_stride_y=128,
            noise_aug_strength=0.0,
            latent_strength=1.0,
        ))
        _send_status(unique_id, "5/8 构建 LongCat 图像/音频条件...", 0.44)
        image_embeds, sample_slice = _node_result(GJJ_LongCatAvatarExtendEmbeds().process(
            prev_latents=ref_latent,
            audio_embeds=audio_embeds,
            num_frames=effective_frames,
            overlap=13,
            frames_processed=0,
            if_not_enough_audio="pad_with_start",
            ref_frame_index=10,
            ref_mask_frame_range=3,
            ref_latent=ref_latent,
        ))
        _send_status(unique_id, "6/8 编码 T5 提示词...", 0.54)
        text_embeds, _negative_text_embeds, _prompt_text = _node_result(GJJ_WanVideoT5TextEncode().process(
            model_name=files["t5"],
            precision="bf16",
            positive_prompt=positive_prompt,
            negative_prompt=negative_prompt,
            quantization="disabled",
            load_device="offload_device",
            compute_device="gpu",
            force_offload=True,
            use_disk_cache=False,
        ))
        _send_status(unique_id, f"7/8 WanVideo 采样：{steps}步 / CFG {cfg:g} / Shift {shift:g}...", 0.64)
        latent, _denoised = _node_result(GJJ_WanVideoSamplerV2().process(
            model=assets["model"],
            image_embeds=image_embeds,
            steps=steps,
            cfg=cfg,
            shift=shift,
            force_offload=False,
            scheduler=scheduler,
            riflex_freq_index=0,
            text_embeds=text_embeds,
            samples=sample_slice,
            denoise_strength=1.0,
            batched_cfg=False,
            rope_function="comfy",
            start_step=0,
            end_step=-1,
            add_noise_to_samples=False,
            seed=seed,
        ))
        _send_status(unique_id, "8/8 VAE 解码并封装视频...", 0.84)
        frames, = _node_result(GJJ_WanVideoDecode().decode(
            vae=assets["vae"],
            samples=latent,
            enable_vae_tiling=False,
            tile_x=272,
            tile_y=272,
            tile_stride_x=144,
            tile_stride_y=128,
            normalization="default",
        ))
        combine_result = GJJ_VideoCombine().combine(
            images=frames,
            frame_rate=output_fps,
            loop_count=0,
            filename_prefix="video/GJJ/LongCat数字人",
            format_name="video/h264-mp4",
            pingpong=False,
            save_output=True,
            use_source_fps=True,
            delete_tail_frame=False,
            save_metadata=True,
            trim_to_audio=False,
            pix_fmt="auto",
            crf="-1",
            audio=trimmed_audio,
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
            unique_id=unique_id,
        )
        video, _main_file, _files_json = _node_result(combine_result)
        if not bool(keep_model_cache):
            _PIPE_CACHE.clear()
        if model_management is not None:
            _clear_cache()
        elapsed = time.time() - start
        _send_status(unique_id, f"完成：{int(effective_frames)} 帧，视频 {output_fps:g}fps，耗时 {elapsed:.1f}s", 1.0)
        print(f"[GJJ LongCat数字人生成] 完成：{int(effective_frames)} 帧，视频 {output_fps:g}fps，音频嵌入 {audio_fps:g}fps，seed={seed}，耗时 {elapsed:.1f}s")
        if isinstance(combine_result, dict):
            return {"ui": combine_result.get("ui", {}), "result": (video,)}
        return (video,)


NODE_CLASS_MAPPINGS = {
    "GJJ_LongCatAvatarLoader": GJJ_LongCatAvatarLoader,
    "GJJ_LongCatAvatarGenerator": GJJ_LongCatAvatarGenerator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_LongCatAvatarLoader": DISPLAY_LOADER,
    "GJJ_LongCatAvatarGenerator": DISPLAY_GENERATOR,
}
