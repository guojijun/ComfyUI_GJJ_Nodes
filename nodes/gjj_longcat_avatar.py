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
        node_name=DISPLAY_LOADER,
        missing_models=[make_missing_model_spec(label=label, subdir=category, filename=preferred, description="LongCat Avatar 1.5 成功工作流使用的单文件权重。")],
        description="LongCat 数字人加载器现在只使用成功工作流中的 safetensors 单文件权重，不再检测官方目录结构。",
        unique_id=unique_id,
        model_download_url="https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5",
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


_STARTUP_REPORT = build_dependency_model_report(
    node_name=DISPLAY_LOADER,
    missing_dependencies=[],
    missing_models=_startup_missing_models(),
    install_packages=[],
    description="LongCat Avatar 1.5 数字人加载器已对齐成功工作流，只检查 safetensors 单文件权重。",
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
        "copy_text": _STARTUP_REPORT.get("copy_text", ""),
        "copy_label": _STARTUP_REPORT.get("copy_label", ""),
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
                model_download_url="https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5",
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
