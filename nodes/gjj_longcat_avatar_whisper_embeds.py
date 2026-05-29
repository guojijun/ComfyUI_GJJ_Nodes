from __future__ import annotations

import json
import os
from typing import Any

import folder_paths
import torch
import torch.nn.functional as F
from comfy.utils import load_torch_file

try:
    import comfy.model_management as model_management
except Exception:
    model_management = None


NODE_NAME = "GJJ_LongCatAvatarWhisperEmbeds"
NODE_DISPLAY_NAME = "🎙️ LongCat数字人Whisper嵌入"
LONGCAT_WHISPER_MODEL = "whisper_large_v3_encoder_fp16.safetensors"
_WHISPER_MODEL_CACHE: dict[tuple[str, str, str], dict[str, Any]] = {}


def _audio_encoder_models(keyword: str = "whisper"):
    models = list(folder_paths.get_filename_list("audio_encoders") or [])
    needle = str(keyword or "").strip().lower()
    if not needle:
        return models
    filtered = [name for name in models if needle in str(name).lower()]
    values = filtered or models
    preferred = next((name for name in values if str(name).replace("\\", "/").endswith(LONGCAT_WHISPER_MODEL)), None)
    if preferred:
        return [preferred] + [name for name in values if name != preferred]
    return values


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


def _loudness_norm(audio_array, sr=16000, lufs=-23):
    try:
        import pyloudnorm
    except Exception as error:
        raise RuntimeError("响度归一化需要 pyloudnorm。请安装 pyloudnorm，或关闭“响度归一化”。") from error
    meter = pyloudnorm.Meter(sr)
    loudness = meter.integrated_loudness(audio_array)
    if abs(loudness) > 100:
        return audio_array
    return pyloudnorm.normalize.loudness(audio_array, loudness, lufs)


def _linear_interp(features, output_len):
    features = features.transpose(1, 2)
    out = F.interpolate(features, size=int(output_len), align_corners=True, mode="linear")
    return out.transpose(1, 2)


def _validate_whisper_model(whisper_model: Any):
    if not isinstance(whisper_model, dict):
        raise RuntimeError("Whisper模型输入无效：需要 WHISPERMODEL 字典。")
    model = whisper_model.get("model")
    feature_extractor = whisper_model.get("feature_extractor")
    dtype = whisper_model.get("dtype", torch.float16)
    if model is None or feature_extractor is None:
        raise RuntimeError("Whisper模型缺少 model 或 feature_extractor。")
    return model, feature_extractor, dtype


def _load_whisper_model(model_name: str, base_precision: str = "fp16", load_device: str = "offload_device"):
    from accelerate import init_empty_weights
    from transformers import WhisperConfig, WhisperFeatureExtractor, WhisperModel

    try:
        from ..vendor.wanvideo_wrapper.utils import set_module_tensor_to_device
    except Exception as error:
        raise RuntimeError(f"GJJ 内置 Whisper 加载工具导入失败：{error}") from error

    precision_map = {
        "fp32": torch.float32,
        "bf16": torch.bfloat16,
        "fp16": torch.float16,
    }
    base_dtype = precision_map.get(str(base_precision), torch.float16)
    device = _device()
    offload_device = _offload_device()
    transformer_load_device = offload_device if load_device == "offload_device" else device
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
        whisper_config = WhisperConfig(**json.load(handle))

    with init_empty_weights():
        whisper = WhisperModel(whisper_config).eval()
        whisper.decoder = None

    feature_extractor = WhisperFeatureExtractor(
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
    state_dict = load_torch_file(model_path, device=transformer_load_device, safe_load=True)
    for name, _param in whisper.named_parameters():
        key = "model." + name
        if key not in state_dict:
            raise RuntimeError(f"Whisper 模型权重缺少键：{key}")
        set_module_tensor_to_device(whisper, name, device=offload_device, dtype=base_dtype, value=state_dict[key])
    del state_dict

    whisper_model = {
        "feature_extractor": feature_extractor,
        "model": whisper,
        "dtype": base_dtype,
    }
    _WHISPER_MODEL_CACHE[cache_key] = whisper_model
    return whisper_model


class GJJ_LongCatAvatarWhisperEmbeds:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    RETURN_TYPES = ("MULTITALK_EMBEDS", "AUDIO", "INT")
    RETURN_NAMES = ("音频嵌入", "音频", "帧数")
    OUTPUT_TOOLTIPS = (
        "LongCat Avatar 1.5 使用的 MULTITALK_EMBEDS，audio_features 为 [T, 5, 1280] 分组 Whisper 特征。",
        "归一化、重采样并按多音频模式混合/拼接后的音频。",
        "传入的目标帧数，方便串接后续节点。",
    )
    DESCRIPTION = "LongCat Avatar 1.5 Whisper 音频嵌入节点：把 Whisper-large-v3 编码成数字人驱动需要的 MULTITALK_EMBEDS。"
    SEARCH_ALIASES = [
        "LongCat Avatar Whisper Embeds",
        "LongCatAvatarWhisperEmbeds",
        "Whisper Embeds v1.5",
        "数字人Whisper嵌入",
        "LongCat音频嵌入",
    ]
    GJJ_HELP = {
        "title": "LongCat 数字人 Whisper 嵌入",
        "description": "内置 Whisper Model Loader 的 LongCat Avatar Whisper Embeds (v1.5)，用 Whisper-large-v3 生成 LongCat-Avatar 音频条件。",
        "usage": [
            "模型选择会从 models/audio_encoders 中读取 Whisper encoder 权重。",
            "默认只显示音频1；连接最后一个音频口后会自动扩充下一路音频。",
            "输出的音频嵌入接 GJJ LongCat数字人续帧条件节点。",
        ],
        "notes": [
            "para 模式会把多路音频按最长长度对齐并混合；add 模式会按顺序拼接。",
            "开启响度归一化时需要 pyloudnorm；关闭后可跳过该依赖。",
            "本节点逻辑已内联在 GJJ，不依赖外部 ComfyUI-WanVideoWrapper 插件。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        whisper_models = _audio_encoder_models("whisper")
        return {
            "required": {
                "model_name": (
                    whisper_models,
                    {
                        "default": whisper_models[0] if whisper_models else None,
                        "display_name": "Whisper模型",
                        "tooltip": "从 models/audio_encoders 及其子目录中选择 Whisper encoder；默认按 whisper 关键词过滤。",
                    },
                ),
                "base_precision": (
                    ["fp32", "bf16", "fp16"],
                    {
                        "default": "fp16",
                        "display_name": "Whisper精度",
                        "tooltip": "Whisper encoder 的权重精度。fp16 速度/显存较均衡，bf16 适合现代显卡。",
                    },
                ),
                "load_device": (
                    ["main_device", "offload_device"],
                    {
                        "default": "offload_device",
                        "display_name": "Whisper加载设备",
                        "tooltip": "main_device 首次运行更快但占显存；offload_device 更省显存。",
                    },
                ),
                "normalize_loudness": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "响度归一化",
                        "tooltip": "归一化到 -23 LUFS，贴近 LongCat Avatar 1.5 参考流程。",
                    },
                ),
                "num_frames": (
                    "INT",
                    {
                        "default": 93,
                        "min": 1,
                        "max": 10000,
                        "step": 1,
                        "display_name": "帧数",
                        "tooltip": "目标视频总帧数，用来决定截取多少音频。",
                    },
                ),
                "fps": (
                    "FLOAT",
                    {
                        "default": 25.0,
                        "min": 1.0,
                        "max": 60.0,
                        "step": 0.1,
                        "display_name": "帧率",
                        "tooltip": "目标视频帧率；LongCat-Avatar 1.5 默认 25fps。前方接口支持连接 INT 或 FLOAT。",
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
                        "tooltip": "音频条件强度。",
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
                        "tooltip": "不为 1.0 时，采样器会额外做无音频条件分支。",
                    },
                ),
                "multi_audio_type": (
                    ["para", "add"],
                    {
                        "default": "para",
                        "display_name": "多音频模式",
                        "tooltip": "para 为多路并行混合；add 为按顺序拼接。",
                    },
                ),
            },
            "optional": {
                "ref_target_masks": (
                    "MASK",
                    {
                        "display_name": "说话人目标遮罩",
                        "tooltip": "可选：每个说话人的语义遮罩，传给后续 LongCat Avatar 条件。",
                    },
                ),
                "audio_1": ("AUDIO", {"display_name": "音频1", "tooltip": "主音频输入。连接后会自动扩充下一路音频。"}),
            },
        }

    def process(
        self,
        model_name,
        base_precision,
        load_device,
        normalize_loudness,
        num_frames,
        fps,
        audio_scale,
        audio_cfg_scale,
        multi_audio_type,
        ref_target_masks=None,
        audio_1=None,
        **kwargs,
    ):
        try:
            import numpy as np
            import torchaudio
        except Exception as error:
            raise RuntimeError("LongCat Whisper 嵌入需要 numpy 和 torchaudio。请确认 ComfyUI Python 环境已安装。") from error

        try:
            fps_value = float(fps)
        except Exception as error:
            raise RuntimeError(f"帧率必须是可转换为数字的 INT/FLOAT：{fps!r}") from error
        if fps_value <= 0:
            raise RuntimeError("帧率必须大于 0。")

        whisper_model = _load_whisper_model(model_name, base_precision, load_device)
        model, feature_extractor, dtype = _validate_whisper_model(whisper_model)

        sample_rate_target = 16000
        mel_chunk = 750 * 640
        enc_chunk = 3000
        device = _device()
        offload_device = _offload_device()

        audio_slots = [("audio_1", audio_1)]
        for key, value in kwargs.items():
            if str(key).startswith("audio_"):
                audio_slots.append((str(key), value))
        audio_slots.sort(key=lambda item: int(item[0].split("_", 1)[1]) if item[0].split("_", 1)[1].isdigit() else 999999)
        audio_inputs = [audio for _name, audio in audio_slots if audio is not None]
        if not audio_inputs:
            raise RuntimeError("请至少连接一路音频输入。")
        audio_features_list = []
        seq_lengths = []
        audio_outputs = []
        end_sample = int((int(num_frames) / fps_value) * sample_rate_target)

        for audio_index, audio in enumerate(audio_inputs, start=1):
            if not isinstance(audio, dict) or "waveform" not in audio or "sample_rate" not in audio:
                raise RuntimeError(f"音频{audio_index} 输入格式无效。")
            audio_input = audio["waveform"]
            source_sr = int(audio["sample_rate"])
            if source_sr != sample_rate_target:
                audio_input = torchaudio.functional.resample(audio_input, source_sr, sample_rate_target)
            if audio_input.ndim != 3:
                raise RuntimeError(f"音频{audio_index} waveform 维度应为 [B, C, T]，实际为 {tuple(audio_input.shape)}。")

            mono = audio_input[0].mean(dim=0)
            audio_segment = mono[:end_sample].cpu().numpy().astype(np.float32)
            if audio_segment.size == 0:
                continue

            if normalize_loudness:
                audio_segment = _loudness_norm(audio_segment, sr=sample_rate_target).astype(np.float32)

            audio_duration = len(audio_segment) / sample_rate_target
            video_length = int(audio_duration * fps_value)
            if video_length < 1:
                continue

            mel_chunks = []
            for start in range(0, len(audio_segment), mel_chunk):
                mel = feature_extractor(
                    audio_segment[start : start + mel_chunk],
                    sampling_rate=sample_rate_target,
                    return_tensors="pt",
                ).input_features
                mel_chunks.append(mel)
            if not mel_chunks:
                continue

            mel_features = torch.cat(mel_chunks, dim=-1).to(device=device, dtype=dtype)
            model.to(device)
            enc_chunks = []
            with torch.no_grad():
                for start in range(0, mel_features.shape[-1], enc_chunk):
                    chunk = mel_features[:, :, start : start + enc_chunk]
                    hidden_states = model.encoder(chunk, output_hidden_states=True).hidden_states
                    enc_chunks.append(torch.stack(hidden_states, dim=2))
            model.to(offload_device)

            if not enc_chunks:
                continue
            audio_prompts = torch.cat(enc_chunks, dim=1)
            audio_prompts = audio_prompts[:, : video_length * 2]

            feat0 = _linear_interp(audio_prompts[:, :, 0:8].mean(dim=2), video_length)
            feat1 = _linear_interp(audio_prompts[:, :, 8:16].mean(dim=2), video_length)
            feat2 = _linear_interp(audio_prompts[:, :, 16:24].mean(dim=2), video_length)
            feat3 = _linear_interp(audio_prompts[:, :, 24:32].mean(dim=2), video_length)
            feat4 = _linear_interp(audio_prompts[:, :, 32], video_length)
            audio_emb = torch.stack([feat0, feat1, feat2, feat3, feat4], dim=2)[0]

            audio_features_list.append(audio_emb.cpu().detach())
            seq_lengths.append(int(audio_emb.shape[0]))
            waveform_tensor = torch.from_numpy(audio_segment).float().unsqueeze(0).unsqueeze(0)
            audio_outputs.append({"waveform": waveform_tensor, "sample_rate": sample_rate_target})

        if not audio_features_list:
            raise RuntimeError("没有提取到有效的 Whisper 音频嵌入，请检查音频输入、帧数和帧率。")

        if len(audio_features_list) > 1:
            if multi_audio_type == "para":
                max_len = max(seq_lengths)
                padded = []
                for emb in audio_features_list:
                    if emb.shape[0] < max_len:
                        pad = torch.zeros(max_len - emb.shape[0], *emb.shape[1:], dtype=emb.dtype)
                        emb = torch.cat([emb, pad], dim=0)
                    padded.append(emb)
                audio_features_list = padded
            else:
                total_len = sum(seq_lengths)
                merged_features = []
                offset = 0
                for emb, length in zip(audio_features_list, seq_lengths):
                    full = torch.zeros(total_len, *emb.shape[1:], dtype=emb.dtype)
                    full[offset : offset + length] = emb
                    merged_features.append(full)
                    offset += length
                audio_features_list = merged_features

        multitalk_embeds = {
            "audio_features": audio_features_list,
            "audio_scale": float(audio_scale),
            "audio_cfg_scale": float(audio_cfg_scale),
            "ref_target_masks": ref_target_masks,
            "audio_stride": 1,
            "audio_encoder_type": "whisper",
        }

        if len(audio_outputs) == 1:
            out_audio = audio_outputs[0]
        elif multi_audio_type == "para":
            max_len = max(item["waveform"].shape[-1] for item in audio_outputs)
            mixed = torch.zeros(1, 1, max_len, dtype=audio_outputs[0]["waveform"].dtype)
            for item in audio_outputs:
                waveform = item["waveform"]
                if waveform.shape[-1] < max_len:
                    waveform = F.pad(waveform, (0, max_len - waveform.shape[-1]))
                mixed += waveform
            out_audio = {"waveform": mixed, "sample_rate": sample_rate_target}
        else:
            total_len = sum(item["waveform"].shape[-1] for item in audio_outputs)
            mixed = torch.zeros(1, 1, total_len, dtype=audio_outputs[0]["waveform"].dtype)
            offset = 0
            for item in audio_outputs:
                waveform = item["waveform"]
                mixed[:, :, offset : offset + waveform.shape[-1]] += waveform
                offset += waveform.shape[-1]
            out_audio = {"waveform": mixed, "sample_rate": sample_rate_target}

        return (multitalk_embeds, out_audio, int(num_frames))


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LongCatAvatarWhisperEmbeds}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
