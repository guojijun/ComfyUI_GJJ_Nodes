from __future__ import annotations

import importlib
import json
import os
import time
from typing import Any

import folder_paths
import torch
import torch.nn.functional as F
from comfy.utils import common_upscale, load_torch_file

try:
    import comfy.model_management as model_management
except Exception:
    model_management = None

try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        print_dependency_model_report,
        send_dependency_model_notice,
    )
    from .common_utils.progress import send_node_progress
except ImportError:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        print_dependency_model_report,
        send_dependency_model_notice,
    )
    from common_utils.progress import send_node_progress


NODE_NAME = "GJJ_HuMoWhisperEmbeds"
NODE_DISPLAY_NAME = "🎭 HuMo音频条件"
CATEGORY = "GJJ/视频生成"
MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d"
DEFAULT_WHISPER_MODEL = "whisper_large_v3_encoder_fp16.safetensors"
NO_WHISPER_MODEL = "[未找到 Whisper Encoder 模型]"

REQUIRED_DEPENDENCIES = (
    {
        "module_name": "accelerate",
        "package_name": "accelerate",
        "display_name": "accelerate",
        "description": "按空权重方式初始化 Whisper encoder，避免加载阶段占用过多内存。",
    },
    {
        "module_name": "transformers",
        "package_name": "transformers",
        "display_name": "transformers",
        "description": "加载 WhisperConfig、WhisperModel 和 WhisperFeatureExtractor。",
    },
    {
        "module_name": "torchaudio.functional",
        "package_name": "torchaudio",
        "display_name": "torchaudio",
        "description": "把输入 AUDIO 重采样到 HuMo/Whisper 需要的 16000Hz。",
    },
    {
        "module_name": "numpy",
        "package_name": "numpy",
        "display_name": "numpy",
        "description": "Whisper feature extractor 需要 numpy 音频数组。",
    },
)

REQUIRED_WHISPER_MODEL = {
    "label": "Whisper Encoder",
    "subdir": "models/audio_encoders",
    "filename": DEFAULT_WHISPER_MODEL,
    "download_url": MODEL_DOWNLOAD_URL,
    "description": "HuMo 使用的 Whisper large-v3 encoder 单文件权重。",
}

_WHISPER_MODEL_CACHE: dict[tuple[str, str, str], dict[str, Any]] = {}


def _device():
    if model_management is not None:
        try:
            return model_management.get_torch_device()
        except Exception:
            pass
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _offload_device():
    if model_management is not None:
        try:
            return model_management.unet_offload_device()
        except Exception:
            pass
    return torch.device("cpu")


def _soft_empty_cache():
    if model_management is not None:
        try:
            model_management.soft_empty_cache()
        except Exception:
            pass


def _audio_encoder_models(keyword: str = "whisper"):
    try:
        models = list(folder_paths.get_filename_list("audio_encoders") or [])
    except Exception:
        models = []
    if not models:
        return [NO_WHISPER_MODEL]

    needle = str(keyword or "").strip().lower()
    filtered = [name for name in models if needle and needle in str(name).lower()]
    values = filtered or models
    preferred = next(
        (
            name
            for name in values
            if str(name).replace("\\", "/").endswith(DEFAULT_WHISPER_MODEL)
        ),
        None,
    )
    if preferred:
        values = [preferred] + [name for name in values if name != preferred]
    return values


def _collect_missing_dependencies():
    missing = []
    for spec in REQUIRED_DEPENDENCIES:
        try:
            importlib.import_module(spec["module_name"])
        except Exception:
            missing.append(dict(spec))
    return missing


_WHISPER_CHOICES = _audio_encoder_models()
_MISSING_DEPENDENCIES = _collect_missing_dependencies()
_DEPENDENCIES_AVAILABLE = not _MISSING_DEPENDENCIES
_MISSING_MODELS = (
    [] if _WHISPER_CHOICES and _WHISPER_CHOICES[0] != NO_WHISPER_MODEL else [REQUIRED_WHISPER_MODEL]
)
_MODELS_AVAILABLE = not _MISSING_MODELS
_ENVIRONMENT_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_MISSING_DEPENDENCIES,
    missing_models=_MISSING_MODELS,
    install_packages=[item["package_name"] for item in _MISSING_DEPENDENCIES],
    description=(
        "合并 Whisper Model Loader 与 HuMo Embeds，生成 WanVideo HuMo 可用的音频/参考图条件。"
        if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
        else ""
    ),
    model_download_url=MODEL_DOWNLOAD_URL,
)

if not _ENVIRONMENT_REPORT.get("available", True):
    try:
        print_dependency_model_report(
            _ENVIRONMENT_REPORT,
            title="GJJ HuMo Whisper 条件节点运行环境缺失！",
        )
    except Exception:
        pass

DESCRIPTION = (
    "合并 Whisper Model Loader 与 HuMo Embeds，直接输出 WanVideo HuMo 图像条件。"
    if _ENVIRONMENT_REPORT.get("available", True)
    else _ENVIRONMENT_REPORT.get("warning_message", "⚠️缺失运行依赖或模型，点击❓按钮了解详情。")
)


def _runtime_import(module_name: str, package_name: str, description: str, unique_id=None):
    return load_dependency_at_runtime(
        module_name,
        NODE_DISPLAY_NAME,
        package_name=package_name,
        description=description,
        unique_id=unique_id,
    )


def _raise_report(report: dict[str, Any], unique_id=None):
    send_dependency_model_notice(report, unique_id=unique_id)
    raise RuntimeError(report.get("warning_message") or "运行环境缺失。")


def _missing_whisper_model_report():
    return build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[REQUIRED_WHISPER_MODEL],
        install_packages=[],
        model_download_url=MODEL_DOWNLOAD_URL,
    )


def _set_module_tensor_to_device(module, tensor_name, target_device, *, value, dtype=None):
    parts = str(tensor_name).split(".")
    for part in parts[:-1]:
        module = getattr(module, part)
    leaf = parts[-1]
    if leaf not in module._parameters and leaf not in module._buffers:
        raise RuntimeError(f"Whisper 权重目标不存在：{tensor_name}")
    tensor = value.to(target_device)
    if dtype is not None and tensor.is_floating_point():
        tensor = tensor.to(dtype=dtype)
    if leaf in module._buffers:
        module._buffers[leaf] = tensor
    else:
        module._parameters[leaf] = torch.nn.Parameter(tensor, requires_grad=False)


def _load_whisper_model(model_name: str, base_precision: str, load_device: str, unique_id=None):
    if not model_name or model_name == NO_WHISPER_MODEL:
        _raise_report(_missing_whisper_model_report(), unique_id=unique_id)

    accelerate = _runtime_import(
        "accelerate",
        "accelerate",
        "按空权重方式初始化 Whisper encoder，避免加载阶段占用过多内存。",
        unique_id=unique_id,
    )
    transformers = _runtime_import(
        "transformers",
        "transformers",
        "加载 WhisperConfig、WhisperModel 和 WhisperFeatureExtractor。",
        unique_id=unique_id,
    )

    precision_map = {
        "fp32": torch.float32,
        "bf16": torch.bfloat16,
        "fp16": torch.float16,
    }
    base_dtype = precision_map.get(str(base_precision), torch.float16)
    main_device = _device()
    offload_device = _offload_device()
    initial_device = offload_device if load_device == "offload_device" else main_device
    cache_key = (str(model_name), str(base_precision), str(load_device))
    cached = _WHISPER_MODEL_CACHE.get(cache_key)
    if cached is not None:
        return cached

    config_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "vendor",
        "wanvideo_wrapper",
        "HuMo",
        "whisper_config.json",
    )
    with open(config_path, "r", encoding="utf-8") as handle:
        whisper_config = transformers.WhisperConfig(**json.load(handle))

    with accelerate.init_empty_weights():
        whisper = transformers.WhisperModel(whisper_config).eval()
        whisper.decoder = None

    feature_extractor = transformers.WhisperFeatureExtractor(
        chunk_length=30,
        feature_extractor_type="WhisperFeatureExtractor",
        feature_size=128,
        hop_length=160,
        n_fft=400,
        n_samples=480000,
        nb_max_frames=3000,
        padding_side="right",
        padding_value=0.0,
        processor_class="WhisperProcessor",
        return_attention_mask=False,
        sampling_rate=16000,
    )

    model_path = folder_paths.get_full_path_or_raise("audio_encoders", model_name)
    state_dict = load_torch_file(model_path, device=initial_device, safe_load=True)
    for name, _param in whisper.named_parameters():
        key = "model." + name
        if key not in state_dict and name in state_dict:
            key = name
        if key not in state_dict:
            raise RuntimeError(f"Whisper 模型权重缺少键：model.{name}")
        _set_module_tensor_to_device(
            whisper,
            name,
            offload_device,
            dtype=base_dtype,
            value=state_dict[key],
        )
    del state_dict

    whisper_model = {
        "feature_extractor": feature_extractor,
        "model": whisper,
        "dtype": base_dtype,
    }
    _WHISPER_MODEL_CACHE.clear()
    _WHISPER_MODEL_CACHE[cache_key] = whisper_model
    return whisper_model


def _linear_interpolation_fps(features, input_fps, output_fps, output_len=None):
    features = features.transpose(1, 2)
    seq_len = features.shape[2] / float(input_fps)
    if output_len is None:
        output_len = int(seq_len * output_fps)
    output_features = F.interpolate(
        features,
        size=int(output_len),
        align_corners=True,
        mode="linear",
    )
    return output_features.transpose(1, 2)


def _audio_to_mono_16k(audio, unique_id=None):
    if not isinstance(audio, dict) or "waveform" not in audio or "sample_rate" not in audio:
        raise RuntimeError("音频输入格式无效：需要 ComfyUI AUDIO 对象。")

    np = _runtime_import("numpy", "numpy", "Whisper feature extractor 需要 numpy 音频数组。", unique_id=unique_id)
    torchaudio_functional = _runtime_import(
        "torchaudio.functional",
        "torchaudio",
        "把输入 AUDIO 重采样到 HuMo/Whisper 需要的 16000Hz。",
        unique_id=unique_id,
    )

    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    if not isinstance(waveform, torch.Tensor):
        waveform = torch.as_tensor(waveform)
    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0).unsqueeze(0)
    elif waveform.ndim == 2:
        waveform = waveform.unsqueeze(0)
    if waveform.ndim != 3:
        raise RuntimeError(f"AUDIO waveform 维度应为 [B,C,T]，实际为 {tuple(waveform.shape)}。")

    audio_input = waveform[0].float()
    if sample_rate != 16000:
        audio_input = torchaudio_functional.resample(audio_input, sample_rate, 16000)
    mono = audio_input.mean(dim=0) if audio_input.shape[0] > 1 else audio_input[0]
    audio_array = mono.detach().cpu().numpy().astype(np.float32)
    return np.ascontiguousarray(audio_array)


def _extract_humo_audio_emb(audio, whisper_model, unique_id=None):
    model = whisper_model["model"]
    feature_extractor = whisper_model["feature_extractor"]
    dtype = whisper_model["dtype"]
    main_device = _device()
    offload_device = _offload_device()
    audio_array = _audio_to_mono_16k(audio, unique_id=unique_id)
    if len(audio_array) < 1:
        raise RuntimeError("音频为空，无法提取 HuMo Whisper 条件。")

    audio_len = max(1, len(audio_array) // 640)
    mel_chunk = 750 * 640
    enc_chunk = 3000

    audio_features = []
    for start in range(0, len(audio_array), mel_chunk):
        feature = feature_extractor(
            audio_array[start : start + mel_chunk],
            sampling_rate=16000,
            return_tensors="pt",
        ).input_features
        audio_features.append(feature)
    if not audio_features:
        raise RuntimeError("未生成 Whisper mel 特征，请检查音频长度。")

    audio_features = torch.cat(audio_features, dim=-1).to(main_device, dtype=dtype)
    model.to(main_device)
    prompts = []
    with torch.no_grad():
        for start in range(0, audio_features.shape[-1], enc_chunk):
            chunk = audio_features[:, :, start : start + enc_chunk]
            hidden_states = model.encoder(chunk, output_hidden_states=True).hidden_states
            prompts.append(torch.stack(hidden_states, dim=2))
    model.to(offload_device)
    _soft_empty_cache()

    if not prompts:
        raise RuntimeError("Whisper encoder 没有返回有效 hidden states。")
    audio_prompts = torch.cat(prompts, dim=1)
    if audio_prompts.shape[2] < 33:
        raise RuntimeError(
            f"HuMo 需要 Whisper large-v3 encoder 的 33 组 hidden states，当前只有 {audio_prompts.shape[2]} 组。"
        )
    audio_prompts = audio_prompts[:, : audio_len * 2]

    feat0 = _linear_interpolation_fps(audio_prompts[:, :, 0:8].mean(dim=2), 50, 25)
    feat1 = _linear_interpolation_fps(audio_prompts[:, :, 8:16].mean(dim=2), 50, 25)
    feat2 = _linear_interpolation_fps(audio_prompts[:, :, 16:24].mean(dim=2), 50, 25)
    feat3 = _linear_interpolation_fps(audio_prompts[:, :, 24:32].mean(dim=2), 50, 25)
    feat4 = _linear_interpolation_fps(audio_prompts[:, :, 32], 50, 25)
    audio_emb = torch.stack([feat0, feat1, feat2, feat3, feat4], dim=2)[0]
    return audio_emb, audio_len


def _encode_reference_images(vae, reference_images, width, height, tiled_vae):
    main_device = _device()
    offload_device = _offload_device()
    if reference_images.shape[1] != height or reference_images.shape[2] != width:
        images = common_upscale(
            reference_images.movedim(-1, 1),
            width,
            height,
            "lanczos",
            "disabled",
        ).movedim(1, -1)
    else:
        images = reference_images

    if images.shape[-1] == 4:
        images = images[..., :3]
    vae.to(main_device)
    images = images.clone().to(vae.dtype).to(main_device) * 2.0 - 1.0

    latents = []
    for image in images:
        latent = vae.encode(
            image.unsqueeze(0).unsqueeze(0).permute(0, 4, 1, 2, 3),
            device=main_device,
            tiled=bool(tiled_vae),
            tile_size=(272 // vae.upsampling_factor, 272 // vae.upsampling_factor),
            tile_stride=(144 // vae.upsampling_factor, 128 // vae.upsampling_factor),
        )
        latents.append(latent.squeeze(0).cpu())
    vae.to(offload_device)
    _soft_empty_cache()

    if not latents:
        return None
    latent_batch = torch.stack(latents, dim=0)
    return latent_batch.transpose(0, 2).squeeze(0)


class GJJ_HuMoWhisperEmbeds:
    CATEGORY = CATEGORY
    FUNCTION = "process"
    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS", "INT", "STRING")
    RETURN_NAMES = ("HuMo条件", "实际帧数", "状态")
    OUTPUT_TOOLTIPS = (
        "WanVideo HuMo 采样器可用的 WANVIDIMAGE_EMBEDS，内含 humo_audio_emb、humo_image_cond、target_shape 等字段。",
        "按 HuMo 规则修正后的实际视频帧数：4n+1。",
        "本次 HuMo 条件生成摘要。",
    )
    DESCRIPTION = DESCRIPTION
    SEARCH_ALIASES = [
        "HuMo Embeds",
        "Whisper Model Loader",
        "WhisperModelLoader",
        "HuMoEmbeds",
        "HuMo音频条件",
        "WanVideo HuMo",
    ]
    GJJ_HELP = {
        "title": "HuMo Whisper 音频条件",
        "description": DESCRIPTION,
        "notice": _ENVIRONMENT_REPORT.get("warning_message", ""),
        "warning_message": _ENVIRONMENT_REPORT.get("warning_message", ""),
        "notice_level": _ENVIRONMENT_REPORT.get("notice_level", "ok"),
        "panel_message": _ENVIRONMENT_REPORT.get("panel_message", ""),
        "install_cmd": _ENVIRONMENT_REPORT.get("install_cmd", ""),
        "optional_install_cmd": _ENVIRONMENT_REPORT.get("optional_install_cmd", ""),
        "copy_text": _ENVIRONMENT_REPORT.get("copy_text", ""),
        "copy_label": _ENVIRONMENT_REPORT.get("copy_label", ""),
        "model_download_url": MODEL_DOWNLOAD_URL,
        "missing_dependencies": _MISSING_DEPENDENCIES,
        "missing_models": _MISSING_MODELS,
        "usage": [
            "本节点把 Whisper Model Loader 与 HuMo Embeds 合并成一个 GJJ 节点。",
            "Whisper 权重从 models/audio_encoders 读取；推荐 whisper_large_v3_encoder_fp16.safetensors。",
            "VAE 输入需要连接 WanVideo VAE Loader 输出的 WANVAE。",
            "输出 HuMo条件 直接连接 GJJ WanVideo Sampler v2 的图像条件输入。",
        ],
        "notes": [
            "不依赖外部 ComfyUI-WanVideoWrapper 插件；运行逻辑已内联到 GJJ。",
            "若不连接音频，会生成静音 HuMo 音频条件；若不连接参考图，则只生成空图像条件。",
            "参考图会自动缩放到面板宽高再编码为 HuMo 条件。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        whisper_models = _audio_encoder_models()
        return {
            "required": {
                "whisper_model": (
                    whisper_models,
                    {
                        "default": whisper_models[0] if whisper_models else NO_WHISPER_MODEL,
                        "display_name": "Whisper模型",
                        "tooltip": "从 models/audio_encoders 选择 Whisper encoder 单文件。HuMo 推荐 whisper_large_v3_encoder_fp16.safetensors；未连接音频时可不实际加载。",
                    },
                ),
                "base_precision": (
                    ["fp32", "bf16", "fp16"],
                    {
                        "default": "fp16",
                        "display_name": "Whisper精度",
                        "tooltip": "Whisper encoder 权重精度。fp16 最常用；bf16 适合新显卡；fp32 更稳但更占内存。",
                    },
                ),
                "load_device": (
                    ["main_device", "offload_device"],
                    {
                        "default": "offload_device",
                        "display_name": "Whisper加载设备",
                        "tooltip": "offload_device 更省显存；main_device 首次加载更快但更占显存。",
                    },
                ),
                "vae": (
                    "WANVAE",
                    {
                        "display_name": "WanVideo VAE",
                        "tooltip": "HuMo 条件必须用 WanVideo VAE 编码空 latent 和参考图 latent。",
                    },
                ),
                "num_frames": (
                    "INT",
                    {
                        "default": 81,
                        "min": -1,
                        "max": 10000,
                        "step": 1,
                        "display_name": "帧数",
                        "tooltip": "-1 表示跟随音频长度；否则会按 HuMo 规则修正为 4n+1。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 832,
                        "min": 64,
                        "max": 4096,
                        "step": 16,
                        "display_name": "宽度",
                        "tooltip": "目标视频宽度，参考图会按此宽度缩放后编码。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 480,
                        "min": 64,
                        "max": 4096,
                        "step": 16,
                        "display_name": "高度",
                        "tooltip": "目标视频高度，参考图会按此高度缩放后编码。",
                    },
                ),
                "audio_scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "音频强度",
                        "tooltip": "HuMo 音频条件强度。",
                    },
                ),
                "audio_cfg_scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "音频CFG",
                        "tooltip": "不为 1.0 时采样器会额外计算无音频分支，速度更慢但动作自由度更高。",
                    },
                ),
                "audio_start_percent": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "音频开始比例",
                        "tooltip": "从采样进度的哪个比例开始应用 HuMo 音频条件。",
                    },
                ),
                "audio_end_percent": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "音频结束比例",
                        "tooltip": "到采样进度的哪个比例停止应用 HuMo 音频条件。",
                    },
                ),
                "tiled_vae": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "VAE平铺",
                        "tooltip": "开启后参考图和空条件编码更省显存，但可能稍慢。",
                    },
                ),
            },
            "optional": {
                "reference_images": (
                    "IMAGE",
                    {
                        "display_name": "参考图",
                        "tooltip": "可选 HuMo 参考图；会缩放到目标宽高并编码进 HuMo 图像条件。",
                    },
                ),
                "audio": (
                    "AUDIO",
                    {
                        "display_name": "音频",
                        "tooltip": "可选驱动音频；连接后会自动加载 Whisper 并生成 HuMo 音频条件。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def process(
        self,
        whisper_model,
        base_precision,
        load_device,
        vae,
        num_frames,
        width,
        height,
        audio_scale,
        audio_cfg_scale,
        audio_start_percent,
        audio_end_percent,
        tiled_vae,
        reference_images=None,
        audio=None,
        unique_id=None,
    ):
        started = time.perf_counter()
        width = int(width)
        height = int(height)
        num_frames = int(num_frames)
        main_device = _device()
        offload_device = _offload_device()

        if vae is None:
            raise RuntimeError("请连接 WanVideo VAE。HuMo 条件需要 VAE 编码空 latent 和参考图 latent。")

        send_node_progress(unique_id, "1/4 准备 HuMo 条件...", 0.05)

        if audio is not None:
            send_node_progress(unique_id, "2/4 加载 Whisper 并提取音频嵌入...", 0.22)
            model_bundle = _load_whisper_model(
                str(whisper_model),
                str(base_precision),
                str(load_device),
                unique_id=unique_id,
            )
            audio_emb, audio_len = _extract_humo_audio_emb(audio, model_bundle, unique_id=unique_id)
        else:
            if num_frames == -1:
                raise RuntimeError("未连接音频时，帧数不能为 -1；请填写明确帧数。")
            audio_len = max(1, num_frames)
            audio_emb = torch.zeros(audio_len, 5, 1280, device=main_device)

        pixel_frame_num = audio_len if num_frames == -1 else num_frames
        pixel_frame_num = max(1, 4 * ((int(pixel_frame_num) - 1) // 4) + 1)
        latent_frame_num = (pixel_frame_num - 1) // 4 + 1

        send_node_progress(unique_id, "3/4 编码参考图与空 HuMo 条件...", 0.62)

        reference_latents = None
        num_refs = 0
        if reference_images is not None:
            reference_latents = _encode_reference_images(
                vae,
                reference_images,
                width,
                height,
                bool(tiled_vae),
            )
            if reference_latents is not None:
                num_refs = int(reference_latents.shape[1])

        vae.to(main_device)
        zero_frames = torch.zeros(
            1,
            3,
            pixel_frame_num + 4 * num_refs,
            height,
            width,
            device=main_device,
            dtype=vae.dtype,
        )
        zero_latents = vae.encode(
            zero_frames,
            device=main_device,
            tiled=bool(tiled_vae),
        )[0].to(offload_device)
        vae.to(offload_device)
        _soft_empty_cache()

        target_shape = (16, latent_frame_num + num_refs, height // 8, width // 8)
        mask = torch.ones(
            4,
            target_shape[1],
            target_shape[2],
            target_shape[3],
            device=offload_device,
            dtype=vae.dtype,
        )
        if reference_latents is not None and num_refs > 0:
            reference_latents = reference_latents.to(offload_device, dtype=vae.dtype)
            mask[:, :-num_refs] = 0
            image_cond = torch.cat(
                [zero_latents[:, : (target_shape[1] - num_refs)], reference_latents],
                dim=1,
            )
        else:
            image_cond = zero_latents
            mask = torch.zeros_like(mask)

        image_cond = torch.cat([mask, image_cond], dim=0)
        image_cond_neg = torch.cat([mask, zero_latents], dim=0)
        audio_emb = audio_emb.to(offload_device)

        embeds = {
            "humo_audio_emb": audio_emb,
            "humo_audio_emb_neg": torch.zeros_like(audio_emb, dtype=audio_emb.dtype, device=audio_emb.device),
            "humo_image_cond": image_cond,
            "humo_image_cond_neg": image_cond_neg,
            "humo_reference_count": num_refs,
            "target_shape": target_shape,
            "num_frames": pixel_frame_num,
            "humo_audio_scale": float(audio_scale),
            "humo_audio_cfg_scale": float(audio_cfg_scale),
            "humo_start_percent": float(audio_start_percent),
            "humo_end_percent": float(audio_end_percent),
        }

        elapsed = time.perf_counter() - started
        status = (
            f"HuMo 条件生成完成\n"
            f"帧数：{pixel_frame_num}，尺寸：{width}x{height}\n"
            f"参考图：{num_refs}，音频：{'已连接' if audio is not None else '静音条件'}\n"
            f"耗时：{elapsed:.2f}s"
        )
        send_node_progress(unique_id, status, 1.0, done=True)
        return {"ui": {"text": [status]}, "result": (embeds, pixel_frame_num, status)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_HuMoWhisperEmbeds}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
