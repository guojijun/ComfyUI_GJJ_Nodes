from __future__ import annotations

import os
import json
from typing import Any

import folder_paths
import comfy.model_management as mm


NODE_NAME = "GJJ_FantasyTalkingWav2VecEmbeds"
NODE_DISPLAY_NAME = "🗣️ FantasyTalking音频条件"

BASE_PRECISION_VALUES = ["fp32", "bf16", "fp16"]
LOAD_DEVICE_VALUES = ["main_device", "offload_device"]
DEFAULT_WAV2VEC_DIR = "wav2vec2-base-960h"


try:
    folder_paths.add_model_folder_path(
        "wav2vec2", os.path.join(folder_paths.models_dir, "wav2vec2")
    )
except Exception:
    pass


def _torch_dtype(base_precision: str):
    import torch

    mapping = {
        "bf16": torch.bfloat16,
        "fp16": torch.float16,
        "fp32": torch.float32,
    }
    return mapping.get(str(base_precision or "fp16"), torch.float16)


def _wav2vec_roots() -> list[str]:
    try:
        return list(folder_paths.get_folder_paths("wav2vec2"))
    except Exception:
        return [os.path.join(folder_paths.models_dir, "wav2vec2")]


def _is_wav2vec_model_dir(path: str) -> bool:
    return (
        os.path.isdir(path)
        and os.path.exists(os.path.join(path, "config.json"))
        and (
            os.path.exists(os.path.join(path, "model.safetensors"))
            or os.path.exists(os.path.join(path, "pytorch_model.bin"))
        )
    )


def _wav2vec_choices() -> list[str]:
    choices: list[str] = []
    for root in _wav2vec_roots():
        if not os.path.isdir(root):
            continue
        if _is_wav2vec_model_dir(root):
            choices.append(".")
        for current, dirnames, filenames in os.walk(root):
            if _is_wav2vec_model_dir(current):
                rel = os.path.relpath(current, root)
                choices.append("." if rel == "." else rel.replace(os.sep, "/"))
                dirnames[:] = []
                continue
            for filename in filenames:
                lower = filename.lower()
                if lower.endswith((".safetensors", ".bin", ".pt", ".pth")):
                    rel_file = os.path.relpath(os.path.join(current, filename), root)
                    choices.append(rel_file.replace(os.sep, "/"))
    unique = sorted({item for item in choices if item and item != "."})
    if DEFAULT_WAV2VEC_DIR in unique:
        unique.remove(DEFAULT_WAV2VEC_DIR)
        unique.insert(0, DEFAULT_WAV2VEC_DIR)
    return unique or ["[未找到模型]"]


def _resolve_wav2vec_path(model_name: str) -> str:
    model_name = str(model_name or "").strip()
    if not model_name or model_name == "[未找到模型]":
        raise RuntimeError(
            "未找到 Wav2Vec2 模型。请把 facebook/wav2vec2-base-960h 放到 models/wav2vec2/wav2vec2-base-960h。"
        )

    try:
        direct = folder_paths.get_full_path("wav2vec2", model_name)
    except Exception:
        direct = None
    if direct and os.path.exists(direct):
        return direct

    for root in _wav2vec_roots():
        candidate = os.path.join(root, model_name.replace("/", os.sep))
        if os.path.exists(candidate):
            return candidate

    raise RuntimeError(f"未找到 Wav2Vec2 模型：models/wav2vec2/{model_name}")


_WAV2VEC_CACHE: dict[tuple[str, str], dict[str, Any]] = {}


def _load_local_wav2vec(model_name: str, base_precision: str, load_device: str) -> dict[str, Any]:
    from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2Model

    import torch

    model_path = _resolve_wav2vec_path(model_name)
    if not os.path.isdir(model_path):
        raise RuntimeError(
            "FantasyTalking 需要 HuggingFace 目录格式的 Wav2Vec2 模型，"
            f"当前选择的是单文件：models/wav2vec2/{model_name}。"
        )

    cache_key = (os.path.abspath(model_path), str(base_precision or "fp16"))
    cached = _WAV2VEC_CACHE.get(cache_key)
    if cached is not None:
        return cached

    dtype = _torch_dtype(base_precision)
    device = mm.get_torch_device()
    offload_device = mm.unet_offload_device()
    target_device = offload_device if load_device == "offload_device" else device

    try:
        try:
            processor = Wav2Vec2FeatureExtractor.from_pretrained(
                model_path, local_files_only=True
            )
        except OSError:
            feature_config = os.path.join(model_path, "feature_extractor_config.json")
            if not os.path.exists(feature_config):
                raise
            with open(feature_config, "r", encoding="utf-8") as handle:
                processor = Wav2Vec2FeatureExtractor(**json.load(handle))
        wav2vec = (
            Wav2Vec2Model.from_pretrained(model_path, local_files_only=True)
            .to(dtype)
            .to(target_device)
            .eval()
        )
    except Exception as error:
        raise RuntimeError(
            "加载本地 Wav2Vec2 失败。请确认目录内至少包含 config.json、feature_extractor_config.json 和 model.safetensors。\n"
            f"模型目录：models/wav2vec2/{model_name}\n"
            f"错误信息：{error}"
        ) from error

    payload = {
        "processor": processor,
        "feature_extractor": processor,
        "model": wav2vec,
        "dtype": dtype,
        "model_type": "facebook/wav2vec2-base-960h",
        "model_path": model_path,
    }
    _WAV2VEC_CACHE[cache_key] = payload

    if target_device == device and torch.cuda.is_available():
        mm.soft_empty_cache()

    return payload


class GJJ_FantasyTalkingWav2VecEmbeds:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    DESCRIPTION = (
        "FantasyTalking 音频条件节点：内部从 models/wav2vec2 加载本地 Wav2Vec2，"
        "输出可直接连接 GJJ WanVideo Sampler 的 FantasyTalking 条件。"
    )
    SEARCH_ALIASES = [
        "FantasyTalking",
        "Wav2Vec",
        "WanVideo FantasyTalking",
        "讲话音频条件",
    ]

    RETURN_TYPES = ("FANTASYTALKING_EMBEDS",)
    RETURN_NAMES = ("FantasyTalking条件",)
    OUTPUT_TOOLTIPS = ("供 GJJ WanVideo Sampler 使用的 FantasyTalking 音频条件。",)

    @classmethod
    def INPUT_TYPES(cls):
        wav2vec_models = _wav2vec_choices()
        default_wav2vec = (
            DEFAULT_WAV2VEC_DIR
            if DEFAULT_WAV2VEC_DIR in wav2vec_models
            else wav2vec_models[0]
        )
        return {
            "required": {
                "fantasytalking_model": (
                    "FANTASYTALKINGMODEL",
                    {
                        "display_name": "FantasyTalking模型",
                        "tooltip": "由 GJJ Wan 模型加载器内部加载或原 FantasyTalking 模型加载器输出的模型对象。",
                    },
                ),
                "audio": (
                    "AUDIO",
                    {
                        "display_name": "驱动音频",
                        "tooltip": "用于提取口型驱动特征的音频。",
                    },
                ),
                "wav2vec_model": (
                    wav2vec_models,
                    {
                        "default": default_wav2vec,
                        "display_name": "Wav2Vec2模型",
                        "tooltip": "从本地 models/wav2vec2 读取。FantasyTalking 推荐 wav2vec2-base-960h 目录。",
                    },
                ),
                "base_precision": (
                    BASE_PRECISION_VALUES,
                    {
                        "default": "fp16",
                        "display_name": "Wav2Vec精度",
                        "tooltip": "Wav2Vec2 的加载精度，显存紧张时使用 fp16。",
                    },
                ),
                "load_device": (
                    LOAD_DEVICE_VALUES,
                    {
                        "default": "main_device",
                        "display_name": "初始加载设备",
                        "tooltip": "main_device 会先放到显卡；offload_device 会先放到卸载设备，执行时再切换。",
                    },
                ),
                "num_frames": (
                    "INT",
                    {
                        "default": 81,
                        "min": 1,
                        "max": 1000,
                        "step": 1,
                        "display_name": "帧数",
                        "tooltip": "需要生成或采样的视频帧数。",
                    },
                ),
                "fps": (
                    "FLOAT",
                    {
                        "default": 23.0,
                        "min": 1.0,
                        "max": 60.0,
                        "step": 0.1,
                        "display_name": "帧率",
                        "tooltip": "用于按帧数截取对应长度的音频。",
                    },
                ),
                "audio_scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display_name": "音频强度",
                        "tooltip": "FantasyTalking 音频条件强度。",
                    },
                ),
                "audio_cfg_scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display_name": "音频CFG",
                        "tooltip": "不为 1 时会启用无音频条件的额外 CFG 分支，速度会变慢。",
                    },
                ),
            }
        }

    def process(
        self,
        fantasytalking_model,
        audio,
        wav2vec_model,
        base_precision,
        load_device,
        num_frames,
        fps,
        audio_scale,
        audio_cfg_scale,
    ):
        try:
            from ..vendor.wanvideo_wrapper.fantasytalking import nodes as ft_nodes
        except Exception as error:
            raise RuntimeError(
                "GJJ 内置 FantasyTalking runtime 加载失败。无需安装 WanVideoWrapper 插件本体；"
                f"如果是 pip 运行库缺失，请按 GJJ 的 WanVideo 运行时依赖方案安装。\n错误信息：{error}"
            ) from error

        wav2vec_payload = _load_local_wav2vec(
            wav2vec_model, base_precision=base_precision, load_device=load_device
        )
        return ft_nodes.FantasyTalkingWav2VecEmbeds().process(
            wav2vec_model=wav2vec_payload,
            fantasytalking_model=fantasytalking_model,
            fps=fps,
            num_frames=num_frames,
            audio_scale=audio_scale,
            audio_cfg_scale=audio_cfg_scale,
            audio=audio,
        )


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_FantasyTalkingWav2VecEmbeds,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
