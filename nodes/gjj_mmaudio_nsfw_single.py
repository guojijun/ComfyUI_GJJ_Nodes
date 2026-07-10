from __future__ import annotations

import json
import math
import os
import subprocess
import importlib.util
from pathlib import Path
from typing import Any

import numpy as np
import torch

import folder_paths
import comfy.model_management as mm
from comfy.utils import load_torch_file

from .gjj_video_combine_runtime import (
    DEFAULT_FORMAT,
    DEFAULT_FRAME_RATE,
    DEFAULT_FILENAME_PREFIX,
    VIDEO_SUFFIXES,
    combine_video,
    get_ffmpeg_path,
    list_supported_formats,
)
from .common_utils.dependency_checker import (
    load_dependency_at_runtime,
    raise_dependency_model_error,
)
from .common_utils.prompt_translation import (
    COMMON_PROMPT_TRANSLATE_API_PATH,
    TRANSLATION_BUNDLE_FILENAME,
    TRANSLATION_DEPENDENCY_SPECS,
    TRANSLATION_MODEL_DOWNLOAD_URL,
    TRANSLATION_MODEL_SUBDIR,
    as_bool,
    build_translation_environment_report,
    register_prompt_translation_api,
    send_translated_prompt,
    translate_prompt_pair,
)


register_prompt_translation_api((COMMON_PROMPT_TRANSLATE_API_PATH,))


NODE_NAME = "GJJ_MMAudioNSFWSingle"
NODE_DISPLAY_NAME = "GJJ ·📢 视频配音(MMAudio)"
MMAUDIO_CATEGORY = "mmaudio"
_MODEL_CACHE: dict[tuple[Any, ...], Any] = {}
_FEATURE_CACHE: dict[tuple[Any, ...], Any] = {}
RUNTIME_DEPENDENCY_SPECS = [
    {"module_name": "accelerate", "package_name": "accelerate", "display_name": "accelerate", "description": "低内存加载 MMAudio、Synchformer 和 CLIP 权重。"},
    {"module_name": "einops", "package_name": "einops", "display_name": "einops", "description": "MMAudio / Synchformer 张量重排。"},
    {"module_name": "timm", "package_name": "timm", "display_name": "timm", "description": "Synchformer / MotionFormer 视频特征网络。"},
    {"module_name": "huggingface_hub", "package_name": "huggingface_hub", "display_name": "huggingface_hub", "description": "BigVGAN v2 本地加载接口依赖。"},
    {"module_name": "torchvision", "package_name": "torchvision", "display_name": "torchvision", "description": "MMAudio 视频帧缩放、裁剪和归一化。"},
    {"module_name": "requests", "package_name": "requests", "display_name": "requests", "description": "MMAudio vendored 下载工具依赖。"},
    {"module_name": "tqdm", "package_name": "tqdm", "display_name": "tqdm", "description": "MMAudio 采样进度显示。"},
]
_TRANSLATION_ENVIRONMENT_REPORT = build_translation_environment_report(
    node_name=NODE_DISPLAY_NAME,
    description=(
        "MMAudio 正向提示词翻译需要 transformers、sentencepiece 和本地 Opus-MT 中英翻译模型包。"
        f"模型包请放到 {TRANSLATION_MODEL_SUBDIR}。"
    ),
)


def _runtime_dependency_by_module(module_name: str) -> dict[str, str] | None:
    needle = str(module_name or "").split(".")[0].strip().lower()
    aliases = {"huggingface_hub": "huggingface_hub"}
    needle = aliases.get(needle, needle)
    for spec in RUNTIME_DEPENDENCY_SPECS:
        if str(spec.get("module_name", "")).lower() == needle:
            return spec
    return None


def _ensure_runtime_dependencies(unique_id: Any = None) -> None:
    missing = [
        spec
        for spec in RUNTIME_DEPENDENCY_SPECS
        if importlib.util.find_spec(str(spec["module_name"])) is None
    ]
    if missing:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=missing,
            install_packages=[str(spec["package_name"]) for spec in missing],
            description="MMAudio 单节点运行前检测到缺少必要 Python 依赖。请复制安装命令，安装后重启 ComfyUI。",
            unique_id=unique_id,
            title="GJJ · MMAudio 运行依赖缺失！",
        )


def _raise_runtime_import_error(error: BaseException, unique_id: Any = None) -> None:
    missing_name = getattr(error, "name", "") or ""
    spec = _runtime_dependency_by_module(missing_name)
    if spec is None:
        text = str(error)
        for candidate in RUNTIME_DEPENDENCY_SPECS:
            if str(candidate["module_name"]).lower() in text.lower():
                spec = candidate
                break
    if spec is None:
        raise error
    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=[spec],
        install_packages=[str(spec["package_name"])],
        description="MMAudio 运行时导入依赖失败。请复制安装命令，安装后重启 ComfyUI。",
        original_error=str(error),
        unique_id=unique_id,
        title="GJJ · MMAudio 运行依赖缺失！",
    )


def _ensure_mmaudio_folder() -> None:
    if MMAUDIO_CATEGORY not in folder_paths.folder_names_and_paths:
        folder_paths.add_model_folder_path(MMAUDIO_CATEGORY, os.path.join(folder_paths.models_dir, MMAUDIO_CATEGORY))


def _mmaudio_models() -> list[str]:
    _ensure_mmaudio_folder()
    try:
        names = list(folder_paths.get_filename_list(MMAUDIO_CATEGORY) or [])
    except Exception:
        names = []
    return names or [""]


def _filter_model_names(names: list[str], include: tuple[str, ...], exclude: tuple[str, ...] = ()) -> list[str]:
    result: list[str] = []
    for name in names:
        text = str(name or "").strip()
        lowered = text.lower()
        if not text:
            continue
        if include and not any(keyword in lowered for keyword in include):
            continue
        if exclude and any(keyword in lowered for keyword in exclude):
            continue
        result.append(text)
    return result or [""]


def _mmaudio_main_models(names: list[str]) -> list[str]:
    return _filter_model_names(names, ("mmaudio",), ("vae", "synchformer", "clip", "dfn", "bigvgan", "vocoder"))


def _mmaudio_vae_models(names: list[str]) -> list[str]:
    return _filter_model_names(names, ("vae",), ("synchformer", "clip", "dfn", "bigvgan", "vocoder"))


def _mmaudio_synchformer_models(names: list[str]) -> list[str]:
    return _filter_model_names(names, ("synchformer",), ("vae", "clip", "dfn", "bigvgan", "vocoder"))


def _mmaudio_clip_models(names: list[str]) -> list[str]:
    return _filter_model_names(names, ("clip", "dfn"), ("vae", "synchformer", "bigvgan", "vocoder"))


def _prefer_model(names: list[str], keywords: tuple[str, ...]) -> str:
    lowered = [(name, str(name).lower()) for name in names if str(name or "").strip()]
    for name, value in lowered:
        if all(keyword in value for keyword in keywords):
            return name
    return names[0] if names else ""


def _prefer_main_model(names: list[str]) -> str:
    lowered = [(name, str(name).lower()) for name in names if str(name or "").strip()]
    for name, value in lowered:
        if "mmaudio" in value and "44k" in value and "nsfw" not in value:
            return name
    for name, value in lowered:
        if "mmaudio" in value and "nsfw" not in value:
            return name
    return _prefer_model(names, ("mmaudio", "44k"))


def _input_videos() -> list[str]:
    roots = []
    try:
        roots.append(Path(folder_paths.get_input_directory()))
    except Exception:
        pass
    videos: list[str] = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.suffix.lower() in VIDEO_SUFFIXES:
                try:
                    videos.append(path.relative_to(root).as_posix())
                except Exception:
                    videos.append(str(path))
    return videos or [""]


def _resolve_video_path(value: Any) -> Path:
    text = str(value or "").strip().strip('"')
    if not text:
        raise RuntimeError("请选择或填写源视频。")
    candidates = [Path(os.path.expandvars(os.path.expanduser(text)))]
    if not candidates[0].is_absolute():
        try:
            candidates.append(Path(folder_paths.get_input_directory()) / text)
        except Exception:
            pass
        try:
            candidates.append(Path(folder_paths.get_output_directory()) / text)
        except Exception:
            pass
        try:
            candidates.append(Path(folder_paths.get_temp_directory()) / text)
        except Exception:
            pass
    for candidate in candidates:
        if candidate.is_file() and candidate.suffix.lower() in VIDEO_SUFFIXES:
            return candidate.resolve()
    raise RuntimeError(f"未找到视频文件：{text}")


def _ratio_to_float(value: Any) -> float:
    text = str(value or "").strip()
    if "/" in text:
        left, right = text.split("/", 1)
        try:
            return float(left) / max(1e-9, float(right))
        except Exception:
            return 0.0
    try:
        return float(text)
    except Exception:
        return 0.0


def _probe_video(path: Path) -> tuple[int, int, float, float]:
    ffmpeg = get_ffmpeg_path()
    ffprobe = "ffprobe"
    if ffmpeg:
        candidate = Path(ffmpeg).with_name("ffprobe.exe" if str(ffmpeg).lower().endswith(".exe") else "ffprobe")
        if candidate.is_file():
            ffprobe = str(candidate)
    command = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,duration,avg_frame_rate,r_frame_rate",
        "-of",
        "json",
        str(path),
    ]
    proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=15)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "ffprobe 读取视频信息失败").strip())
    stream = (json.loads(proc.stdout or "{}").get("streams") or [{}])[0]
    width = int(float(stream.get("width") or 0))
    height = int(float(stream.get("height") or 0))
    fps = _ratio_to_float(stream.get("avg_frame_rate")) or _ratio_to_float(stream.get("r_frame_rate")) or DEFAULT_FRAME_RATE
    duration = float(stream.get("duration") or 0.0)
    if width <= 0 or height <= 0:
        raise RuntimeError("无法读取源视频尺寸。")
    return width, height, fps, duration


def _decode_video_frames(
    path: Path,
    force_rate: float,
    custom_width: int,
    custom_height: int,
    frame_load_cap: int,
    skip_first_frames: int,
    select_every_nth: int,
) -> tuple[torch.Tensor, float, float]:
    ffmpeg = get_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("当前环境未找到 ffmpeg，无法在零第三方节点模式下读取视频。")

    width, height, source_fps, source_duration = _probe_video(path)
    target_fps = float(force_rate) if float(force_rate or 0) > 0 else float(source_fps or DEFAULT_FRAME_RATE)
    custom_width = int(custom_width or 0)
    custom_height = int(custom_height or 0)
    if (custom_width <= 0) != (custom_height <= 0):
        raise RuntimeError("自定义宽高请同时填写；都为 0 时使用源视频尺寸。")
    if custom_width > 0 and custom_height > 0:
        width, height = custom_width, custom_height

    filters = []
    if target_fps > 0:
        filters.append(f"fps={target_fps:.6f}")
    if custom_width > 0 and custom_height > 0:
        filters.append(f"scale={width}:{height}")

    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path)]
    if filters:
        command.extend(["-vf", ",".join(filters)])
    command.extend(["-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])

    selected: list[np.ndarray] = []
    frame_size = int(width) * int(height) * 3
    skip = max(0, int(skip_first_frames or 0))
    every = max(1, int(select_every_nth or 1))
    cap = max(0, int(frame_load_cap or 0))
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
        assert proc.stdout is not None
        index = 0
        while True:
            raw = proc.stdout.read(frame_size)
            if not raw:
                break
            if len(raw) != frame_size:
                break
            if index >= skip and ((index - skip) % every == 0):
                frame = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3)).copy()
                selected.append(frame)
                if cap > 0 and len(selected) >= cap:
                    proc.terminate()
                    break
            index += 1
        stderr = proc.stderr.read() if proc.stderr is not None else b""
        proc.wait()
    if not selected:
        details = stderr.decode("utf-8", "ignore").strip()
        raise RuntimeError(f"源视频没有读到可用帧。{details}")
    frames = torch.from_numpy(np.stack(selected).astype(np.float32) / 255.0).contiguous()
    effective_fps = max(0.01, target_fps / float(every))
    duration = float(frames.shape[0]) / effective_fps if frames.shape[0] > 0 else float(source_duration)
    return frames, effective_fps, duration


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value: Any) -> Any | None:
    if value is None:
        return None
    if hasattr(value, "get_components"):
        try:
            return value.get_components()
        except Exception as exc:
            raise RuntimeError(f"读取 VIDEO 输入失败：{exc}") from exc
    if isinstance(value, dict) and any(key in value for key in ("images", "image", "frames", "frame", "fps", "frame_rate")):
        return value
    return None


def _normalize_media_frames(value: torch.Tensor, label: str) -> torch.Tensor:
    tensor = value.detach()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim > 4 and int(tensor.shape[-1]) in (1, 2, 3, 4):
        tensor = tensor.reshape(-1, int(tensor.shape[-3]), int(tensor.shape[-2]), int(tensor.shape[-1]))
    if tensor.ndim != 4:
        raise RuntimeError(f"{label} 必须是 IMAGE/GJJ_BATCH_IMAGE/VIDEO 帧张量，实际维度为 {tuple(tensor.shape)}。")
    if int(tensor.shape[-1]) not in (1, 2, 3, 4) and int(tensor.shape[1]) in (1, 2, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 2:
        tensor = tensor[..., :1].repeat(1, 1, 1, 3)
    elif channels >= 4:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"{label} 图像通道数无效：{tuple(tensor.shape)}。")
    if int(tensor.shape[0]) <= 0:
        raise RuntimeError(f"{label} 没有可用帧。")
    return tensor.float().cpu().clamp(0.0, 1.0).contiguous()


def _extract_frames_from_media(value: Any, fallback_fps: float) -> tuple[torch.Tensor | None, float, float]:
    if value is None:
        return None, 0.0, 0.0
    if isinstance(value, torch.Tensor):
        frames = _normalize_media_frames(value, "媒体输入")
        fps = max(0.01, float(fallback_fps or DEFAULT_FRAME_RATE))
        return frames, fps, float(frames.shape[0]) / fps
    components = _video_components(value)
    if components is not None:
        fps = 0.0
        for key in ("frame_rate", "fps", "source_fps"):
            try:
                fps = float(_component_value(components, key) or 0.0)
            except Exception:
                fps = 0.0
            if fps > 0:
                break
        fps = max(0.01, fps or float(fallback_fps or DEFAULT_FRAME_RATE))
        for key in ("images", "image", "frames", "frame"):
            frames_value = _component_value(components, key)
            if isinstance(frames_value, torch.Tensor):
                frames = _normalize_media_frames(frames_value, "媒体输入")
                return frames, fps, float(frames.shape[0]) / fps
    if isinstance(value, dict):
        for key in ("images", "image", "frames", "frame", "batch", "samples"):
            frames, fps, duration = _extract_frames_from_media(value.get(key), fallback_fps)
            if frames is not None:
                return frames, fps, duration
    if isinstance(value, (list, tuple)):
        for item in value:
            frames, fps, duration = _extract_frames_from_media(item, fallback_fps)
            if frames is not None:
                return frames, fps, duration
    return None, 0.0, 0.0


def _process_video_tensor(video_tensor: torch.Tensor, duration_sec: float, unique_id: Any = None) -> tuple[torch.Tensor, torch.Tensor, float]:
    v2 = load_dependency_at_runtime(
        "torchvision.transforms.v2",
        node_name=NODE_DISPLAY_NAME,
        package_name="torchvision",
        description="MMAudio 视频特征处理需要 torchvision。",
        unique_id=unique_id,
    )

    clip_size = 384
    clip_fps = 8.0
    sync_size = 224
    sync_fps = 25.0
    clip_transform = v2.Compose([
        v2.Resize((clip_size, clip_size), interpolation=v2.InterpolationMode.BICUBIC),
        v2.ToPILImage(),
        v2.ToTensor(),
        v2.ConvertImageDtype(torch.float32),
    ])
    sync_transform = v2.Compose([
        v2.Resize(sync_size, interpolation=v2.InterpolationMode.BICUBIC),
        v2.CenterCrop(sync_size),
        v2.ToPILImage(),
        v2.ToTensor(),
        v2.ConvertImageDtype(torch.float32),
        v2.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5]),
    ])

    total_frames = int(video_tensor.shape[0])
    duration_sec = max(0.1, float(duration_sec or 0.0))
    clip_frames_count = max(1, int(round(clip_fps * duration_sec)))
    sync_frames_count = max(1, int(round(sync_fps * duration_sec)))

    def sample_frames(target_count: int) -> torch.Tensor:
        if total_frames <= 1:
            indices = torch.zeros((int(target_count),), dtype=torch.long, device=video_tensor.device)
        else:
            indices = torch.linspace(0, total_frames - 1, steps=int(target_count), device=video_tensor.device).round().long()
            indices = indices.clamp_(0, total_frames - 1)
        return video_tensor.index_select(0, indices)

    clip_frames = sample_frames(clip_frames_count).permute(0, 3, 1, 2)
    sync_frames = sample_frames(sync_frames_count).permute(0, 3, 1, 2)
    clip_frames = torch.stack([clip_transform(frame) for frame in clip_frames])
    sync_frames = torch.stack([sync_transform(frame) for frame in sync_frames])
    return clip_frames, sync_frames, float(duration_sec)


def _load_mmaudio_model(mmaudio_model: str, base_precision: str, unique_id: Any = None):
    accelerate = load_dependency_at_runtime(
        "accelerate",
        node_name=NODE_DISPLAY_NAME,
        package_name="accelerate",
        description="MMAudio 主模型低内存加载需要 accelerate。",
        unique_id=unique_id,
    )
    accelerate_utils = load_dependency_at_runtime(
        "accelerate.utils",
        node_name=NODE_DISPLAY_NAME,
        package_name="accelerate",
        description="MMAudio 权重分配需要 accelerate.utils。",
        unique_id=unique_id,
    )
    init_empty_weights = accelerate.init_empty_weights
    set_module_tensor_to_device = accelerate_utils.set_module_tensor_to_device

    try:
        from ..vendor.mmaudio.model.networks import MMAudio
        from ..vendor.mmaudio.model.sequence_config import CONFIG_16K, CONFIG_44K
    except (ModuleNotFoundError, ImportError) as error:
        _raise_runtime_import_error(error, unique_id=unique_id)

    key = ("model", mmaudio_model, base_precision)
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]

    device = mm.get_torch_device()
    offload_device = mm.unet_offload_device()
    mm.soft_empty_cache()
    base_dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[str(base_precision)]
    model_path = folder_paths.get_full_path_or_raise(MMAUDIO_CATEGORY, mmaudio_model)
    state_dict = load_torch_file(model_path, device=offload_device)

    with init_empty_weights():
        if state_dict["audio_input_proj.0.bias"].shape[0] == 448:
            num_heads = 7
            model = MMAudio(
                latent_dim=40,
                clip_dim=1024,
                sync_dim=768,
                text_dim=1024,
                hidden_dim=64 * num_heads,
                depth=12,
                fused_depth=8,
                num_heads=num_heads,
                latent_seq_len=345,
                clip_seq_len=64,
                sync_seq_len=192,
            )
        else:
            num_heads = 14
            model = MMAudio(
                latent_dim=40,
                clip_dim=1024,
                sync_dim=768,
                text_dim=1024,
                hidden_dim=64 * num_heads,
                depth=21,
                fused_depth=14,
                num_heads=num_heads,
                latent_seq_len=345,
                clip_seq_len=64,
                sync_seq_len=192,
                v2=state_dict["t_embed.mlp.0.weight"].shape[1] == 896,
            )
    model = model.eval()
    for name, _param in model.named_parameters():
        set_module_tensor_to_device(model, name, device=device, dtype=base_dtype, value=state_dict[name])
    del state_dict
    lowered = str(mmaudio_model).lower()
    if "44" in lowered:
        model.seq_cfg = CONFIG_44K
    elif "16" in lowered:
        model.seq_cfg = CONFIG_16K
    _MODEL_CACHE[key] = model
    return model


def _load_feature_utils(vae_model: str, synchformer_model: str, clip_model: str, mode: str, precision: str, unique_id: Any = None):
    accelerate = load_dependency_at_runtime(
        "accelerate",
        node_name=NODE_DISPLAY_NAME,
        package_name="accelerate",
        description="MMAudio 特征模型低内存加载需要 accelerate。",
        unique_id=unique_id,
    )
    accelerate_utils = load_dependency_at_runtime(
        "accelerate.utils",
        node_name=NODE_DISPLAY_NAME,
        package_name="accelerate",
        description="MMAudio 特征模型权重分配需要 accelerate.utils。",
        unique_id=unique_id,
    )
    init_empty_weights = accelerate.init_empty_weights
    set_module_tensor_to_device = accelerate_utils.set_module_tensor_to_device

    try:
        from ..vendor.mmaudio.ext.autoencoder import AutoEncoderModule
        from ..vendor.mmaudio.ext.bigvgan_v2.bigvgan import BigVGAN as BigVGANv2
        from ..vendor.mmaudio.ext.synchformer import Synchformer
        from ..vendor.mmaudio.model.utils.features_utils import FeaturesUtils
    except (ModuleNotFoundError, ImportError) as error:
        _raise_runtime_import_error(error, unique_id=unique_id)

    key = ("features", vae_model, synchformer_model, clip_model, mode, precision)
    if key in _FEATURE_CACHE:
        return _FEATURE_CACHE[key]

    device = mm.get_torch_device()
    offload_device = mm.unet_offload_device()
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[str(precision)]

    synchformer_path = folder_paths.get_full_path_or_raise(MMAUDIO_CATEGORY, synchformer_model)
    synchformer_sd = load_torch_file(synchformer_path, device=offload_device)
    with init_empty_weights():
        synchformer = Synchformer().eval()
    for name, _param in synchformer.named_parameters():
        set_module_tensor_to_device(synchformer, name, device=device, dtype=dtype, value=synchformer_sd[name])
    del synchformer_sd

    mmaudio_root = folder_paths.get_folder_paths(MMAUDIO_CATEGORY)[0]
    if str(mode) != "44k":
        raise RuntimeError("当前 GJJ 单节点只内置 44k MMAudio 流程。")
    vocoder_path = os.path.join(mmaudio_root, "nvidia", "bigvgan_v2_44khz_128band_512x")
    if not os.path.isdir(vocoder_path):
        raise RuntimeError(f"未找到 BigVGAN vocoder：{vocoder_path}")
    bigvgan_vocoder = BigVGANv2._from_pretrained(
        model_id=vocoder_path,
        revision=None,
        cache_dir=None,
        force_download=False,
        proxies=None,
        resume_download=False,
        local_files_only=True,
        token=None,
        map_location="cpu",
        strict=False,
        use_cuda_kernel=False,
    ).eval().to(device=device, dtype=dtype)

    vae_path = folder_paths.get_full_path_or_raise(MMAUDIO_CATEGORY, vae_model)
    vae_sd = load_torch_file(vae_path, device=offload_device)
    vae = AutoEncoderModule(vae_state_dict=vae_sd, bigvgan_vocoder=bigvgan_vocoder, mode=mode)
    vae = vae.eval().to(device=device, dtype=dtype)
    del vae_sd

    clip = None
    try:
        from open_clip import CLIP
    except Exception:
        CLIP = None
    if CLIP is not None and str(clip_model or "").strip():
        clip_model_path = folder_paths.get_full_path_or_raise(MMAUDIO_CATEGORY, clip_model)
        clip_config_path = Path(__file__).resolve().parents[1] / "vendor" / "mmaudio_configs" / "DFN5B-CLIP-ViT-H-14-384.json"
        with clip_config_path.open("r", encoding="utf-8") as stream:
            clip_config = json.load(stream)
        with init_empty_weights():
            try:
                clip = CLIP(**clip_config["model_cfg"]).eval()
            except TypeError:
                clip_config["model_cfg"]["nonscalar_logit_scale"] = True
                clip = CLIP(**clip_config["model_cfg"]).eval()
        clip_sd = load_torch_file(clip_model_path, device=offload_device)
        for name, _param in clip.named_parameters():
            set_module_tensor_to_device(clip, name, device=device, dtype=dtype, value=clip_sd[name])
        del clip_sd
        clip.to(device=device, dtype=dtype)

    feature_utils = FeaturesUtils(vae=vae, synchformer=synchformer, enable_conditions=True, clip_model=clip)
    _FEATURE_CACHE[key] = feature_utils
    return feature_utils


def _align_sequence_tensor(tensor: torch.Tensor, target_len: int) -> torch.Tensor:
    target_len = max(0, int(target_len))
    if tensor.ndim < 2 or target_len <= 0 or int(tensor.shape[1]) == target_len:
        return tensor
    current_len = int(tensor.shape[1])
    if current_len > target_len:
        return tensor[:, :target_len].contiguous()
    pad_shape = list(tensor.shape)
    pad_shape[1] = target_len - current_len
    padding = torch.zeros(pad_shape, device=tensor.device, dtype=tensor.dtype)
    return torch.cat([tensor, padding], dim=1).contiguous()


def _generate_mmaudio_aligned(
    clip_video: torch.Tensor | None,
    sync_video: torch.Tensor | None,
    text: list[str],
    *,
    negative_text: list[str] | None,
    feature_utils,
    net,
    fm,
    rng: torch.Generator,
    cfg_strength: float,
) -> torch.Tensor:
    device = feature_utils.device
    dtype = feature_utils.dtype
    bs = len(text)

    if clip_video is not None and feature_utils.clip_model is not None:
        clip_video = clip_video.to(device, dtype, non_blocking=True)
        clip_features = feature_utils.encode_video_with_clip(clip_video, batch_size=bs)
    else:
        clip_features = net.get_empty_clip_sequence(bs)
    clip_features = _align_sequence_tensor(clip_features, int(net.clip_seq_len))

    if sync_video is not None:
        sync_video = sync_video.to(device, dtype, non_blocking=True)
        sync_features = feature_utils.encode_video_with_sync(sync_video, batch_size=bs)
    else:
        sync_features = net.get_empty_sync_sequence(bs)
    sync_features = _align_sequence_tensor(sync_features, int(net.sync_seq_len))

    if text is not None and feature_utils.clip_model is not None and feature_utils.tokenizer is not None:
        text_features = feature_utils.encode_text(text)
    else:
        text_features = net.get_empty_string_sequence(bs)
    text_features = _align_sequence_tensor(text_features, int(getattr(net, "_text_seq_len", text_features.shape[1])))

    if negative_text is not None and feature_utils.clip_model is not None and feature_utils.tokenizer is not None:
        if len(negative_text) != bs:
            raise RuntimeError("MMAudio 反向提示词数量与批次不一致。")
        negative_text_features = feature_utils.encode_text(negative_text)
    else:
        negative_text_features = net.get_empty_string_sequence(bs)
    negative_text_features = _align_sequence_tensor(negative_text_features, int(getattr(net, "_text_seq_len", negative_text_features.shape[1])))

    x0 = torch.randn(
        bs,
        net.latent_seq_len,
        net.latent_dim,
        device=device,
        dtype=dtype,
        generator=rng,
    )
    preprocessed_conditions = net.preprocess_conditions(clip_features, sync_features, text_features)
    empty_conditions = net.get_empty_conditions(
        bs,
        negative_text_features=negative_text_features if negative_text is not None else None,
    )
    x1 = fm.to_data(lambda t, x: net.ode_wrapper(t, x, preprocessed_conditions, empty_conditions, cfg_strength), x0)
    x1 = net.unnormalize(x1)
    spec = feature_utils.decode(x1)
    return feature_utils.vocode(spec)


def _sample_mmaudio(
    frames: torch.Tensor,
    duration: float,
    seed: int,
    steps: int,
    cfg: float,
    prompt: str,
    negative_prompt: str,
    mask_away_clip: bool,
    force_offload: bool,
    mmaudio_model: str,
    base_precision: str,
    vae_model: str,
    synchformer_model: str,
    clip_model: str,
    feature_precision: str,
    unique_id: Any = None,
) -> dict[str, Any]:
    try:
        from ..vendor.mmaudio.model.flow_matching import FlowMatching
    except (ModuleNotFoundError, ImportError) as error:
        _raise_runtime_import_error(error, unique_id=unique_id)

    device = mm.get_torch_device()
    offload_device = mm.unet_offload_device()
    model = _load_mmaudio_model(mmaudio_model, base_precision, unique_id=unique_id)
    feature_utils = _load_feature_utils(vae_model, synchformer_model, clip_model, "44k", feature_precision, unique_id=unique_id)

    rng = torch.Generator(device=device)
    rng.manual_seed(int(seed))
    video_frames = frames.to(device=device)
    clip_frames, sync_frames, resolved_duration = _process_video_tensor(video_frames, float(duration), unique_id=unique_id)
    clip_frames = None if bool(mask_away_clip) else clip_frames.unsqueeze(0)
    sync_frames = sync_frames.unsqueeze(0)

    seq_cfg = model.seq_cfg
    seq_cfg.duration = float(resolved_duration)
    model.update_seq_lengths(seq_cfg.latent_seq_len, seq_cfg.clip_seq_len, seq_cfg.sync_seq_len)
    scheduler = FlowMatching(min_sigma=0, inference_mode="euler", num_steps=int(steps))
    feature_utils.to(device)
    model.to(device)
    audio = _generate_mmaudio_aligned(
        clip_frames,
        sync_frames,
        [str(prompt or "")],
        negative_text=[str(negative_prompt or "")],
        feature_utils=feature_utils,
        net=model,
        fm=scheduler,
        rng=rng,
        cfg_strength=float(cfg),
    )
    if bool(force_offload):
        model.to(offload_device)
        feature_utils.to(offload_device)
        mm.soft_empty_cache()
    return {"waveform": audio.float().cpu(), "sample_rate": 44100}


class GJJ_MMAudioNSFWSingle:
    CATEGORY = "GJJ/音频"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = "MMAudio 视频配音单节点：优先使用输入口媒体；未连接时使用 📁 打开的视频文件；本地生成音频并合成视频。"
    SEARCH_ALIASES = ["mmaudio", "nsfw audio", "video to audio", "视频配音", "视频音效"]
    RETURN_TYPES = ("VIDEO", "AUDIO")
    RETURN_NAMES = ("视频", "生成音频")
    OUTPUT_TOOLTIPS = ("封入生成音频后的视频。", "MMAudio 生成的 AUDIO。")
    GJJ_HELP = {
        "title": "MMAudio 视频配音单节点",
        "description": "一个节点完成媒体读取、MMAudio 音频生成和视频合成。媒体输入口有连接时优先使用输入口；没有连接时使用 📁 打开并保存到 input 目录的视频。",
        "dependencies": [
            {"name": spec["display_name"], "type": "运行依赖", "required": True, "description": spec["description"]}
            for spec in RUNTIME_DEPENDENCY_SPECS
        ] + [
            {"name": spec["display_name"], "type": "翻译依赖", "required": False, "description": spec["description"]}
            for spec in TRANSLATION_DEPENDENCY_SPECS
        ],
        "models": [
            {
                "name": "MMAudio 主模型",
                "folder": "models/mmaudio",
                "widget": "mmaudio_model",
                "example": "mmaudio_large_44k_v2_fp16.safetensors",
                "note": "默认优先选择非成人版的 44k 主模型；如果目录里只有成人版模型才会回退使用。",
            },
            {
                "name": "MMAudio VAE",
                "folder": "models/mmaudio",
                "widget": "vae_model",
                "example": "mmaudio_vae_44k_fp16.safetensors",
            },
            {
                "name": "Synchformer 视频同步模型",
                "folder": "models/mmaudio",
                "widget": "synchformer_model",
                "example": "mmaudio_synchformer_fp16.safetensors",
            },
            {
                "name": "CLIP/DFN 文本与视觉条件模型",
                "folder": "models/mmaudio",
                "widget": "clip_model",
                "example": "apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors",
                "note": "没有 open_clip 时会自动跳过 CLIP/text 条件，仍可使用 Synchformer 条件运行。",
            },
            {
                "name": "BigVGAN 44k 声码器",
                "folder": "models/mmaudio/nvidia/bigvgan_v2_44khz_128band_512x",
                "widget": "内部加载",
                "example": "config.json + bigvgan_generator.pt",
            },
            {
                "name": "Opus-MT 中英翻译模型包",
                "folder": TRANSLATION_MODEL_SUBDIR,
                "widget": "🌏 翻译开关",
                "example": TRANSLATION_BUNDLE_FILENAME,
                "note": "开启 🌏 后用于把正向提示词翻译为英文。",
            },
        ],
        "usage": [
            "默认只显示按钮行；点击 🧠 / 🎬 / 🔊 分别打开模型、视频、配音浮动设置窗口，同一时间只保留一个窗口。",
            "正向提示词始终显示；开启 🌏 后会使用 translation\\opus-mt-zh-en.safetensors 翻译正向提示词。",
            "把 IMAGE、GJJ_BATCH_IMAGE 或 VIDEO 接到“媒体输入”时，📁 会禁用并以输入口为准。",
            "没有输入口连接时，点击 📁 选择本机视频；如果文件名已在 input 目录中，节点会直接使用该文件名。",
        ],
        "translation_notice": _TRANSLATION_ENVIRONMENT_REPORT.get("help_message", "")
        if not _TRANSLATION_ENVIRONMENT_REPORT.get("available", True)
        else "",
        "translation_install_cmd": _TRANSLATION_ENVIRONMENT_REPORT.get("install_cmd", ""),
        "translation_copy_text": _TRANSLATION_ENVIRONMENT_REPORT.get("copy_text", ""),
        "translation_model_download_url": TRANSLATION_MODEL_DOWNLOAD_URL,
    }

    @classmethod
    def INPUT_TYPES(cls):
        models = _mmaudio_models()
        main_models = _mmaudio_main_models(models)
        vae_models = _mmaudio_vae_models(models)
        synchformer_models = _mmaudio_synchformer_models(models)
        clip_models = _mmaudio_clip_models(models)
        formats = list_supported_formats()
        return {
            "required": {
                "force_rate": ("FLOAT", {"default": 24.0, "min": 0.0, "max": 240.0, "step": 0.01, "display_name": "读取帧率", "tooltip": "读取磁盘视频时使用的帧率；0 表示使用源视频帧率。"}),
                "custom_width": ("INT", {"default": 0, "min": 0, "max": 8192, "display_name": "自定义宽", "tooltip": "读取磁盘视频时缩放到指定宽度；0 表示使用源宽度。"}),
                "custom_height": ("INT", {"default": 0, "min": 0, "max": 8192, "display_name": "自定义高", "tooltip": "读取磁盘视频时缩放到指定高度；0 表示使用源高度。"}),
                "frame_load_cap": ("INT", {"default": 0, "min": 0, "max": 100000, "display_name": "帧数读取上限", "tooltip": "最多读取多少帧；0 表示不限制。"}),
                "skip_first_frames": ("INT", {"default": 0, "min": 0, "max": 100000, "display_name": "跳过开头帧数", "tooltip": "读取磁盘视频时跳过前 N 帧。"}),
                "select_every_nth": ("INT", {"default": 1, "min": 1, "max": 1000, "display_name": "每 N 帧取 1 帧", "tooltip": "读取磁盘视频时降采样帧序列。"}),
                "duration_mode": (["源视频时长", "手动时长"], {"default": "源视频时长", "display_name": "音频时长模式", "tooltip": "使用源媒体时长，或手动指定生成音频秒数。"}),
                "duration": ("FLOAT", {"default": 16.0, "min": 0.1, "max": 600.0, "step": 0.01, "display_name": "手动时长(秒)", "tooltip": "音频时长模式为手动时使用。"}),
                "steps": ("INT", {"default": 150, "min": 1, "max": 1000, "step": 1, "display_name": "采样步数", "tooltip": "MMAudio flow matching 采样步数。"}),
                "cfg": ("FLOAT", {"default": 9.0, "min": 0.0, "max": 30.0, "step": 0.1, "display_name": "CFG 强度", "tooltip": "条件引导强度。"}),
                "seed": ("INT", {"default": 184852840990216, "min": 0, "max": 0xffffffffffffffff, "display_name": "种子", "tooltip": "随机种子；可用 🎲 按钮随机。"}),
                "prompt": ("STRING", {"default": "强烈、有节奏的动作音效，贴近画面的 Foley 声音，成年女性动漫风格声音", "multiline": True, "display_name": "正向提示词", "tooltip": "用于描述希望生成的声音。没有 open_clip 时文本条件会自动跳过。"}),
                "negative_prompt": ("STRING", {"default": "音乐，唱歌，说话，对话，男声，背景噪声，干燥声音，安静，平静", "multiline": True, "display_name": "反向提示词", "tooltip": "用于描述不希望出现的声音。没有 open_clip 时文本条件会自动跳过。"}),
                "mask_away_clip": ("BOOLEAN", {"default": False, "display_name": "屏蔽 CLIP 视觉条件", "tooltip": "开启后不使用 CLIP 视觉条件，只保留同步条件。"}),
                "force_offload": ("BOOLEAN", {"default": True, "display_name": "生成后卸载模型", "tooltip": "生成完成后把 MMAudio/特征模型移回卸载设备，节省显存。"}),
                "base_precision": (["fp16", "fp32", "bf16"], {"default": "fp16", "display_name": "主模型精度", "tooltip": "MMAudio 主模型加载精度。"}),
                "feature_precision": (["fp16", "fp32", "bf16"], {"default": "fp16", "display_name": "特征模型精度", "tooltip": "VAE、Synchformer、CLIP 等特征模型加载精度。"}),
                "filename_prefix": ("STRING", {"default": "MMaudio", "display_name": "文件名前缀", "tooltip": "输出视频文件名前缀。"}),
                "format_name": (formats, {"default": DEFAULT_FORMAT if DEFAULT_FORMAT in formats else formats[0], "display_name": "输出格式", "tooltip": "输出视频格式。"}),
                "save_output": ("BOOLEAN", {"default": False, "display_name": "保存到输出目录", "tooltip": "关闭时写入临时目录；开启时写入 output 目录。"}),
                "pix_fmt": (["auto", "yuv420p", "yuv420p10le"], {"default": "yuv420p", "display_name": "像素格式", "tooltip": "输出视频像素格式。"}),
                "crf": ("STRING", {"default": "19", "display_name": "CRF 画质", "tooltip": "输出视频压缩质量，数值越低质量越高。"}),
                "translation_enabled": ("BOOLEAN", {"default": False, "display_name": "翻译开关", "tooltip": "按钮状态。开启 🌏 后执行时把正向提示词翻译为英文。"}),
                "translation_device": (["auto", "cpu", "gpu"], {"default": "auto", "display_name": "翻译设备", "tooltip": "Opus-MT 翻译使用的设备。auto 自动选择。"}),
                "translation_unload_after_use": ("BOOLEAN", {"default": False, "display_name": "翻译后卸载", "tooltip": "翻译完成后卸载 Opus-MT 模型，节省显存。"}),
                "video": ("STRING", {"default": "", "display_name": "📁 打开的视频", "tooltip": "由 📁 按钮写入。媒体输入口没有连接时才使用这里的 input 视频文件名或绝对路径。"}),
                "mmaudio_model": (main_models, {"default": _prefer_main_model(main_models), "display_name": "MMAudio 主模型", "tooltip": "放在 models/mmaudio。默认优先选择非成人版的 44k 主模型。"}),
                "vae_model": (vae_models, {"default": _prefer_model(vae_models, ("vae", "44k")), "display_name": "VAE 模型", "tooltip": "MMAudio VAE，通常是 mmaudio_vae_44k_fp16.safetensors。"}),
                "synchformer_model": (synchformer_models, {"default": _prefer_model(synchformer_models, ("synchformer",)), "display_name": "Synchformer 模型", "tooltip": "视频同步特征模型，通常是 mmaudio_synchformer_fp16.safetensors。"}),
                "clip_model": (clip_models, {"default": _prefer_model(clip_models, ("clip",)), "display_name": "CLIP/DFN 模型", "tooltip": "CLIP/DFN 条件模型。没有 open_clip 时会自动跳过该条件。"}),
            },
            "optional": {
                "source_media": ("GJJ_BATCH_IMAGE,IMAGE,VIDEO", {"display_name": "媒体输入", "tooltip": "优先级最高。连接 IMAGE、GJJ_BATCH_IMAGE 或 VIDEO 后，将忽略 📁 打开的视频，且 📁 按钮会灰色禁用。"}),
            },
            "hidden": {
                "prompt_data": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        force_rate,
        custom_width,
        custom_height,
        frame_load_cap,
        skip_first_frames,
        select_every_nth,
        duration_mode,
        duration,
        steps,
        cfg,
        seed,
        prompt,
        negative_prompt,
        mask_away_clip,
        force_offload,
        base_precision,
        feature_precision,
        filename_prefix,
        format_name,
        save_output,
        pix_fmt,
        crf,
        translation_enabled=False,
        translation_device="auto",
        translation_unload_after_use=False,
        video="",
        mmaudio_model=None,
        vae_model=None,
        synchformer_model=None,
        clip_model=None,
        source_media=None,
        prompt_data=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        _ensure_runtime_dependencies(unique_id=unique_id)
        _ensure_mmaudio_folder()
        prompt = str(prompt or "")
        if as_bool(translation_enabled):
            translated = translate_prompt_pair(
                positive=prompt,
                negative="",
                device=str(translation_device or "auto"),
                max_length=512,
                batch_size=8,
                unload_after_use=as_bool(translation_unload_after_use),
                unique_id=unique_id,
                node_name=NODE_DISPLAY_NAME,
            )
            prompt = str(translated.get("positive", "") or prompt)
            send_translated_prompt(unique_id, positive=prompt)
        if not all(str(value or "").strip() for value in (mmaudio_model, vae_model, synchformer_model, clip_model)):
            models = _mmaudio_models()
            mmaudio_model = str(mmaudio_model or "").strip() or _prefer_main_model(_mmaudio_main_models(models))
            vae_model = str(vae_model or "").strip() or _prefer_model(_mmaudio_vae_models(models), ("vae", "44k"))
            synchformer_model = str(synchformer_model or "").strip() or _prefer_model(_mmaudio_synchformer_models(models), ("synchformer",))
            clip_model = str(clip_model or "").strip() or _prefer_model(_mmaudio_clip_models(models), ("clip",))
        frames, fps, source_duration = _extract_frames_from_media(source_media, force_rate)
        if frames is None:
            video_path = _resolve_video_path(video)
            frames, fps, source_duration = _decode_video_frames(
                video_path,
                force_rate,
                custom_width,
                custom_height,
                frame_load_cap,
                skip_first_frames,
                select_every_nth,
            )
        resolved_duration = float(duration) if str(duration_mode) == "手动时长" else float(source_duration)
        resolved_duration = max(0.1, min(resolved_duration, float(frames.shape[0]) / max(0.01, fps)))
        audio = _sample_mmaudio(
            frames=frames,
            duration=resolved_duration,
            seed=int(seed),
            steps=int(steps),
            cfg=float(cfg),
            prompt=prompt,
            negative_prompt=negative_prompt,
            mask_away_clip=bool(mask_away_clip),
            force_offload=bool(force_offload),
            mmaudio_model=mmaudio_model,
            base_precision=base_precision,
            vae_model=vae_model,
            synchformer_model=synchformer_model,
            clip_model=clip_model,
            feature_precision=feature_precision,
            unique_id=unique_id,
        )
        overrides = {"save_metadata": False, "trim_to_audio": False}
        if str(pix_fmt or "auto") != "auto":
            overrides["pix_fmt"] = str(pix_fmt)
        try:
            crf_value = int(float(str(crf).strip()))
            if crf_value >= 0:
                overrides["crf"] = crf_value
        except Exception:
            pass
        combined = combine_video(
            images=frames,
            frame_rate=fps,
            loop_count=0,
            filename_prefix=filename_prefix or DEFAULT_FILENAME_PREFIX,
            format_name=format_name or DEFAULT_FORMAT,
            pingpong=False,
            save_output=bool(save_output),
            use_source_fps=False,
            delete_tail_frame=False,
            vae=None,
            audio=audio,
            format_overrides_json=json.dumps(overrides, ensure_ascii=False),
            prompt=prompt_data,
            extra_pnginfo=extra_pnginfo,
            unique_id=unique_id,
        )
        result = combined.get("result") if isinstance(combined, dict) else combined
        ui = combined.get("ui", {}) if isinstance(combined, dict) else {}
        video_output, _output_path, _files_json = result
        ui["gjj_mmaudio_status"] = [f"完成：{frames.shape[0]}帧 / {fps:.3f}fps / 音频{resolved_duration:.2f}秒"]
        return {"ui": ui, "result": (video_output, audio)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MMAudioNSFWSingle}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·📢MMAudio 视频配音单节点"}
