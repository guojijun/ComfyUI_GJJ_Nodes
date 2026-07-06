from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import hashlib
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
import types
import uuid
import wave
from io import BytesIO
from pathlib import Path
from typing import Any

import folder_paths
import numpy as np
import torch
import torch.nn.functional as F

from .common_utils.dependency_checker import (
    build_dependency_model_report,
    build_node_help_payload,
    build_report_from_exception,
    check_dependencies,
    get_report_from_exception,
    make_model_tree_item,
    raise_dependency_model_error,
    send_dependency_model_notice,
)
from .gjj_longcat_audiodit_loader import (
    approx_duration_from_text as _longcat_approx_duration_from_text,
    load_model as _load_longcat_audiodit_model,
    normalize_text as _longcat_normalize_text,
)


NODE_NAME = "GJJ_UniversalTTS"
NODE_DISPLAY_NAME = "📢 多功能文字转语音TTS"
MAX_REFERENCES = 10
AUDIO_PREFIX = "reference_"
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".webm", ".mp4", ".mov", ".mkv"}
MISSING_AUDIO_CHOICE = "[未找到 models/GJJ/wav 音频]"
MP3_QUALITY_OPTIONS = ["320k", "128k", "V0"]
AUDIO_FORMAT_OPTIONS = ["MP3", "WAV"]
BRANCHES = [
    "EdgeTTS", "FishAudioS2", "LongCat-1B", "LongCat3.5B", "Fun-CosyVoice3-0.5B-2512",
    "Qwen3-CustomVoice", "Qwen3-VoiceDesign", "Qwen3-VoiceClone", "IndexTTS-v1.5", "IndexTTS-v1.0", "IndexTTS-v2",
    "VoxCPM2",
]
TEXT_FORMATS = ["SRT", "VTT", "LRC", "JSON"]
AUDIO_OUTPUT_MODES = ["整体合并", "单个队列"]
DEFAULT_TEXT = "你好，这是一段多功能 TTS 节点生成的语音。"
LEGACY_DEFAULT_REFERENCE_TEXT = "人生不如意十有八九。要么看得开，要么就认栽！"
DEFAULT_REFERENCE_TEXT = "人生不如意十有八九。要么看得开，要么就认栽!"
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
    "Qwen3-CustomVoice": [
        {"module_name": "qwen_tts", "package_name": "qwen-tts", "display_name": "qwen-tts", "description": "Qwen3-TTS 推理运行时。"},
        {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "音频读写依赖。"},
    ],
    "Qwen3-VoiceDesign": [
        {"module_name": "qwen_tts", "package_name": "qwen-tts", "display_name": "qwen-tts", "description": "Qwen3-TTS 推理运行时。"},
        {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "音频读写依赖。"},
    ],
    "Qwen3-VoiceClone": [
        {"module_name": "qwen_tts", "package_name": "qwen-tts", "display_name": "qwen-tts", "description": "Qwen3-TTS 推理运行时。"},
        {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "音频读写依赖。"},
    ],
    "IndexTTS-v1.5": [
        {"module_name": "modelscope", "package_name": "modelscope", "display_name": "modelscope", "description": "IndexTTS Qwen emotion 模型依赖。"},
        {"module_name": "yaml", "package_name": "pyyaml", "display_name": "pyyaml", "description": "IndexTTS 配置解析依赖。"},
        {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "参考音频缓存依赖。"},
        {"module_name": "json5", "package_name": "json5", "display_name": "json5", "description": "MaskGCT/语义配置解析依赖。"},
        {"module_name": "cn2an", "package_name": "cn2an", "display_name": "cn2an", "description": "中文文本数字规范化依赖。"},
        {"module_name": "wetext", "package_name": "wetext", "display_name": "wetext", "description": "IndexTTS 文本规范化依赖。"},
        {"module_name": "sentencepiece", "package_name": "sentencepiece", "display_name": "sentencepiece", "description": "IndexTTS tokenizer 依赖。"},
        {"module_name": "textstat", "package_name": "textstat", "display_name": "textstat", "description": "文本处理依赖。"},
    ],
    "IndexTTS-v1.0": [
        {"module_name": "modelscope", "package_name": "modelscope", "display_name": "modelscope", "description": "IndexTTS Qwen emotion 模型依赖。"},
        {"module_name": "yaml", "package_name": "pyyaml", "display_name": "pyyaml", "description": "IndexTTS 配置解析依赖。"},
        {"module_name": "soundfile", "package_name": "soundfile", "description": "参考音频缓存依赖。"},
        {"module_name": "json5", "package_name": "json5", "display_name": "json5", "description": "MaskGCT/语义配置解析依赖。"},
        {"module_name": "cn2an", "package_name": "cn2an", "display_name": "cn2an", "description": "中文文本数字规范化依赖。"},
        {"module_name": "wetext", "package_name": "wetext", "display_name": "wetext", "description": "IndexTTS 文本规范化依赖。"},
        {"module_name": "sentencepiece", "package_name": "sentencepiece", "display_name": "sentencepiece", "description": "IndexTTS tokenizer 依赖。"},
        {"module_name": "textstat", "package_name": "textstat", "display_name": "textstat", "description": "文本处理依赖。"},
    ],
    "IndexTTS-v2": [
        {"module_name": "modelscope", "package_name": "modelscope", "display_name": "modelscope", "description": "IndexTTS2 Qwen emotion 模型依赖。"},
        {"module_name": "yaml", "package_name": "pyyaml", "display_name": "pyyaml", "description": "IndexTTS2 配置解析依赖。"},
        {"module_name": "soundfile", "package_name": "soundfile", "description": "参考音频缓存依赖。"},
        {"module_name": "json5", "package_name": "json5", "display_name": "json5", "description": "MaskGCT/语义配置解析依赖。"},
        {"module_name": "cn2an", "package_name": "cn2an", "display_name": "cn2an", "description": "中文文本数字规范化依赖。"},
        {"module_name": "wetext", "package_name": "wetext", "display_name": "wetext", "description": "IndexTTS2 文本规范化依赖。"},
        {"module_name": "sentencepiece", "package_name": "sentencepiece", "display_name": "sentencepiece", "description": "IndexTTS tokenizer 依赖。"},
        {"module_name": "textstat", "package_name": "textstat", "display_name": "textstat", "description": "文本处理依赖。"},
    ],
    "VoxCPM2": [
        {"module_name": "transformers", "package_name": "transformers", "display_name": "transformers", "description": "VoxCPM2 文本与模型运行时。"},
        {"module_name": "safetensors", "package_name": "safetensors", "display_name": "safetensors", "description": "VoxCPM2 权重读取依赖。"},
        {"module_name": "einops", "package_name": "einops", "display_name": "einops", "description": "VoxCPM2 张量变换依赖。"},
        {"module_name": "tqdm", "package_name": "tqdm", "display_name": "tqdm", "description": "VoxCPM2 运行时进度依赖。"},
        {"module_name": "librosa", "package_name": "librosa", "display_name": "librosa", "description": "VoxCPM2 参考音频读取依赖。"},
        {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "参考音频缓存依赖。"},
        {"module_name": "pydantic", "package_name": "pydantic", "display_name": "pydantic", "description": "VoxCPM2 配置解析依赖。"},
    ],
}

BRANCH_MODEL_HINTS = {
    "FishAudioS2": ("TTS", "fishaudio-s2-pro-fp8"),
    "LongCat-1B": ("TTS", "LongCat-AudioDiT-1B-mxfp8"),
    "LongCat3.5B": ("TTS", "LongCat-AudioDiT-3.5B-fp8"),
    "Fun-CosyVoice3-0.5B-2512": ("TTS", "Fun-CosyVoice3-0.5B-2512"),
    "Qwen3-CustomVoice": ("TTS", "Qwen3-TTS-12Hz-1.7B-CustomVoice"),
    "Qwen3-VoiceDesign": ("TTS", "Qwen3-TTS-12Hz-1.7B-VoiceDesign"),
    "Qwen3-VoiceClone": ("TTS", "Qwen3-TTS-12Hz-1.7B-base"),
    "IndexTTS-v1.5": ("TTS", "IndexTTS-1.5"),
    "IndexTTS-v1.0": ("TTS", "Index-TTS-1.0"),
    "IndexTTS-v2": ("TTS", "IndexTTS-2"),
    "VoxCPM2": ("TTS", "VoxCPM2"),
}

QWEN_BRANCH_MODEL_TYPES = {
    "Qwen3-CustomVoice": "custom_voice",
    "Qwen3-VoiceDesign": "voice_design",
    "Qwen3-VoiceClone": "base",
}
INDEXTTS_SHARED_MODEL_SPECS = [
    ("Wav2Vec2-BERT 目录", "TTS", "w2v-bert-2.0", "IndexTTS v1.x/v2 共用语音特征模型目录。"),
    ("MaskGCT 目录", "TTS", "MaskGCT", "IndexTTS v1.x/v2 共用语义 codec 模型目录。"),
    ("CampPlus 目录", "TTS", "campplus", "IndexTTS v1.x/v2 共用说话人特征模型目录。"),
    ("BigVGAN 目录", "TTS", "bigvgan_v2_22khz_80band_256x", "IndexTTS v1.x/v2 共用声码器目录。"),
    ("Speakers 目录", "TTS", "speakers", "IndexTTS v1.x/v2 说话人预设目录。", False),
]
INDEXTTS_V2_MODEL_SPECS = [
    ("CampPlus 目录", "TTS", "campplus", "IndexTTS v2 说话人特征模型目录。"),
    ("IndexTTS2 目录", "TTS", "IndexTTS-2", "IndexTTS v2 主模型目录。"),
    ("Wav2Vec2-BERT 目录", "TTS", "w2v-bert-2.0", "IndexTTS v2 语音特征模型目录。"),
    ("MaskGCT 目录", "TTS", "MaskGCT", "IndexTTS v2 语义 codec 模型目录。"),
    ("BigVGAN 目录", "TTS", "bigvgan_v2_22khz_80band_256x", "IndexTTS v2 声码器目录。"),
    ("Speakers 目录", "TTS", "speakers", "IndexTTS v2 说话人预设目录。", False),
]


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
    "LongCat-1B": "LongCat-AudioDiT-1B-mxfp8",
    "LongCat3.5B": "LongCat-AudioDiT-3.5B-fp8",
}
LONGCAT_BRANCH_PREFIXES = {
    "LongCat-1B": "LongCat-AudioDiT-1B",
    "LongCat3.5B": "LongCat-AudioDiT-3.5B",
}
LONGCAT_UNSUPPORTED_MODEL_MARKERS = ("nvfp4",)
BRANCH_MODEL_DOWNLOAD_URLS = {
    "Qwen3-CustomVoice": "https://huggingface.co/Qwen",
    "Qwen3-VoiceDesign": "https://huggingface.co/Qwen",
    "Qwen3-VoiceClone": "https://huggingface.co/Qwen",
    "IndexTTS-v1.5": "https://github.com/index-tts/index-tts",
    "IndexTTS-v1.0": "https://github.com/index-tts/index-tts",
    "IndexTTS-v2": "https://github.com/index-tts/index-tts",
    "VoxCPM2": "https://github.com/OpenBMB/VoxCPM",
}
QWEN_GENERATION_PRESETS = {
    "Qwen3-CustomVoice": {
        "max_new_tokens": 8192,
        "top_p": 1.0,
        "top_k": 50,
        "temperature": 0.9,
        "repetition_penalty": 1.05,
        "x_vector_only": False,
    },
    "Qwen3-VoiceDesign": {
        "max_new_tokens": 4096,
        "top_p": 0.9,
        "top_k": 40,
        "temperature": 0.8,
        "repetition_penalty": 1.05,
        "x_vector_only": False,
    },
    "Qwen3-VoiceClone": {
        "max_new_tokens": 2048,
        "top_p": 0.8,
        "top_k": 20,
        "temperature": 1.0,
        "repetition_penalty": 1.05,
        "x_vector_only": False,
    },
}
REFERENCE_REQUIRED_BRANCHES = {
    "FishAudioS2", "LongCat-1B", "LongCat3.5B", "Fun-CosyVoice3-0.5B-2512",
    "Qwen3-VoiceClone", "IndexTTS-v1.5", "IndexTTS-v1.0", "IndexTTS-v2",
}
REFERENCE_TEXT_ASR_BRANCHES = {
    "FishAudioS2", "LongCat-1B", "LongCat3.5B", "Fun-CosyVoice3-0.5B-2512",
    "Qwen3-VoiceClone",
}


def universal_tts_branch_model_specs(branch: str) -> list[dict[str, str]]:
    hint = BRANCH_MODEL_HINTS.get(branch)
    if not hint:
        return []
    if branch.startswith("Qwen3-"):
        expected_type = _qwen_expected_model_type(branch)
        return [{
            "label": f"{branch} 模型",
            "subdir": hint[0],
            "filename": hint[1],
            "description": f"tts_model_type={expected_type}；请预先下载到 models/{hint[0]}/，UniversalTTS 不会在运行时临时下载。",
        }]
    if branch.startswith("LongCat"):
        return [
            {
                "label": f"{branch} 模型目录",
                "subdir": hint[0],
                "filename": hint[1],
                "description": "LongCat AudioDiT 模型目录。",
            },
            {
                "label": "UMT5 tokenizer 目录",
                "subdir": "TTS",
                "filename": "umt5-base-tokenizer",
                "description": "LongCat AudioDiT tokenizer 目录。",
            },
        ]
    if branch == "IndexTTS-v2":
        return [
            {
                "label": label,
                "subdir": subdir,
                "filename": filename,
                "description": f"{description} 请预先放到 models/{subdir}/{filename}。",
                "required": required,
            }
            for label, subdir, filename, description, *optional in INDEXTTS_V2_MODEL_SPECS
            for required in [optional[0] if optional else True]
        ]
    if branch.startswith("IndexTTS"):
        specs = [
            (f"{branch} 目录", hint[0], hint[1], f"{branch} 主模型目录。"),
            *INDEXTTS_SHARED_MODEL_SPECS,
        ]
        return [
            {
                "label": label,
                "subdir": subdir,
                "filename": filename,
                "description": f"{description} 请预先放到 models/{subdir}/{filename}。",
                "required": required,
            }
            for label, subdir, filename, description, *optional in specs
            for required in [optional[0] if optional else True]
        ]
    description = f"{branch} 默认模型；请放到 models/{hint[0]}/。"
    if branch == "FishAudioS2":
        description = "Fish Audio S2 模型目录需包含 config.json、文本权重和 DAC 解码器。"
    elif branch == "Fun-CosyVoice3-0.5B-2512":
        description = "Fun-CosyVoice3 官方模型目录。"
    return [{
        "label": f"{branch} 模型",
        "subdir": hint[0],
        "filename": hint[1],
        "description": description,
    }]


def build_universal_tts_model_tree(branches: list[str] | None = None) -> list[dict[str, Any]]:
    tree: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for branch in branches or BRANCHES:
        for spec in universal_tts_branch_model_specs(branch):
            key = (spec.get("subdir", ""), spec.get("filename", ""), branch)
            if key in seen:
                continue
            seen.add(key)
            item = make_model_tree_item(
                label=spec.get("label", branch),
                folder=spec.get("subdir", ""),
                filename=spec.get("filename", ""),
                kind="tts",
                icon="🎙️",
                type=branch,
                input="",
                required=bool(spec.get("required", True)),
                description=spec.get("description", ""),
            )
            item["directory"] = True
            tree.append(item)
    return tree


def universal_tts_model_tree_text() -> str:
    entries = [
        ("Qwen3-TTS-12Hz-1.7B-CustomVoice", "10语种；9种预置音色；含北京/四川口音、英/日/韩音色；支持自然语言情感风格控制"),
        ("Qwen3-TTS-12Hz-1.7B-VoiceDesign", "10语种；用文字描述设计音色、年龄、语气与情感；无需参考音频"),
        ("Qwen3-TTS-12Hz-1.7B-base", "10语种；零样本/跨语言音色克隆；中、英、日、韩及德/法/俄/葡/西/意"),
        ("LongCat-AudioDiT-1B-mxfp8", "中英文零样本音色克隆；轻量省显存；扩散式波形生成"),
        ("LongCat-AudioDiT-3.5B-fp8", "中英文零样本音色克隆；更高音色相似度与清晰度；显存需求更高"),
        ("umt5-base-tokenizer", "LongCat 共用多语言文本 tokenizer；辅助组件，不单独生成语音"),
        ("Index-TTS-1.0", "中英文零样本音色克隆；基础版，偏中文"),
        ("IndexTTS-1.5", "中英文零样本音色克隆；英文稳定性与自然度增强"),
        ("IndexTTS-2", "中英文音色克隆；强化情感表现，并支持时长控制能力"),
        ("w2v-bert-2.0", "IndexTTS 共用语音内容特征编码器；辅助组件"),
        ("MaskGCT", "IndexTTS 共用语义 codec；辅助组件"),
        ("bigvgan_v2_22khz_80band_256x", "IndexTTS 共用 BigVGAN 声码器；将声学特征还原为波形"),
        ("campplus", "IndexTTS 共用说话人特征编码器；用于保持音色相似度"),
        ("speakers", "IndexTTS 可选预置说话人音色目录"),
        ("fishaudio-s2-pro-fp8", "约50语种；跨语言音色克隆；情感丰富，支持细粒度行内控制"),
        ("Fun-CosyVoice3-0.5B-2512", "9语种：中/英/日/韩/德/西/法/意/俄；18+中文方言口音；跨语言克隆与情感/语速控制"),
        ("VoxCPM2", "30语种；真实感音色克隆、跨语言合成、创意音色设计；控制指令支持中英文"),
    ]
    lines = ["ComfyUI/", "└──📁 models/", "    ├──📁 TTS/"]
    for index, (name, feature) in enumerate(entries):
        joint = "└" if index == len(entries) - 1 else "├"
        lines.append(f"    │   {joint}──📁 {name}/  —— {feature}")
    lines.extend([
        "    └──📁 ASR/",
        "        ├──📁 Qwen3-ASR-1.7B/  —— 多语言参考音频识别；精度优先，与 0.6B 二选一",
        "        ├──📁 Qwen3-ASR-0.6B/  —— 多语言参考音频识别；速度/显存优先，与 1.7B 二选一",
        "        └──📁 Qwen3-ForcedAligner-0.6B/  —— 字词级强制对齐；供 ASR 节点生成时间戳",
    ])
    return "\n".join(lines)


def _safe_filename(value: str, fallback: str = "reference") -> str:
    name = os.path.basename(str(value or "").strip()) or fallback
    name = re.sub(r'[<>:"/\\|?*\x00-\x1F]+', "_", name).strip(" .")
    return (name or fallback)[:160]


def _safe_path_part(value: Any, fallback: str = "未命名") -> str:
    text = str(value or "").strip() or fallback
    text = re.sub(r'[<>:"\\|?*\x00-\x1F]+', "_", text).strip(" .")
    return text or fallback


def _expand_mp3_filename_prefix(template: str, *, branch: str, model_name: str, seed: int) -> str:
    value = str(template or "audio/GJJ_UniversalTTS").strip() or "audio/GJJ_UniversalTTS"
    now = time.localtime()
    variables = {
        "分支": branch,
        "branch": branch,
        "模型": model_name or "自动",
        "model": model_name or "auto",
        "种子": seed,
        "seed": seed,
        "日期": time.strftime("%Y%m%d", now),
        "date": time.strftime("%Y%m%d", now),
        "时间": time.strftime("%H%M%S", now),
        "time": time.strftime("%H%M%S", now),
        "年月日": time.strftime("%Y-%m-%d", now),
        "时分秒": time.strftime("%H-%M-%S", now),
    }

    def replace_var(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        if key not in variables:
            return match.group(0)
        return _safe_path_part(variables[key], key)

    expanded = re.sub(r"\{([^{}]+)\}", replace_var, value)
    parts = [_safe_path_part(part, "GJJ_UniversalTTS") for part in re.split(r"[\\/]+", expanded) if part.strip()]
    return "/".join(parts) or "audio/GJJ_UniversalTTS"


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


def _qwen_config(model_dir: Path) -> dict[str, Any]:
    config_path = model_dir / "config.json"
    if not config_path.is_file():
        return {}
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _qwen_model_type(model_dir: Path) -> str:
    return str(_qwen_config(model_dir).get("tts_model_type") or "").strip().lower()


def _qwen_expected_model_type(branch: str) -> str:
    return QWEN_BRANCH_MODEL_TYPES.get(branch, "")


def _qwen_compatible_model_dirs(branch: str) -> list[Path]:
    expected = _qwen_expected_model_type(branch)
    root = _models_root("TTS")
    if not expected or not root.is_dir():
        return []
    matches: list[Path] = []
    for path in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if path.is_dir() and any(path.iterdir()) and _qwen_model_type(path) == expected:
            matches.append(path)
    return matches


def _is_longcat_supported_model_name(name: str) -> bool:
    value = str(name or "").lower()
    return bool(value) and not any(marker in value for marker in LONGCAT_UNSUPPORTED_MODEL_MARKERS)


def _longcat_compatible_model_names(branch: str) -> list[str]:
    root = _models_root("TTS")
    prefix = LONGCAT_BRANCH_PREFIXES.get(branch, "")
    if not prefix or not root.is_dir():
        return []
    names: list[str] = []
    for path in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if path.name.startswith(".") or not path.is_dir():
            continue
        if not path.name.startswith(prefix):
            continue
        if not _is_longcat_supported_model_name(path.name):
            continue
        names.append(path.name)
    return names


def _fish_compatible_model_names() -> list[str]:
    root = _models_root("TTS")
    if not root.is_dir():
        return []
    names: list[str] = []
    for path in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if path.name.startswith(".") or not path.is_dir():
            continue
        if _fish_model_complete(path):
            names.append(path.name)
    return names


def _cosyvoice_compatible_model_names(branch: str) -> list[str]:
    root = _models_root("TTS")
    hint = BRANCH_MODEL_HINTS.get(branch)
    default_name = hint[1] if hint else "Fun-CosyVoice3-0.5B-2512"
    if not root.is_dir():
        return []
    exact = root / default_name
    if exact.is_dir() and any(exact.iterdir()):
        return [default_name]
    names: list[str] = []
    for path in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if path.name.startswith(".") or not path.is_dir():
            continue
        if "cosyvoice" in path.name.lower() and any(path.iterdir()):
            names.append(path.name)
    return names


def _branch_model_choices(branch: str) -> list[str]:
    hint = BRANCH_MODEL_HINTS.get(branch)
    if not hint:
        return [""]
    root = _models_root(hint[0])
    if branch.startswith("Qwen3-"):
        choices = [path.name for path in _qwen_compatible_model_dirs(branch)]
        return choices or [hint[1]]
    if branch.startswith("IndexTTS"):
        return [hint[1]]
    if branch.startswith("LongCat"):
        choices = _longcat_compatible_model_names(branch)
        return choices or [LONGCAT_KNOWN_MODELS.get(branch, hint[1])]
    if branch == "FishAudioS2":
        choices = _fish_compatible_model_names()
        return choices or [hint[1]]
    if branch == "Fun-CosyVoice3-0.5B-2512":
        choices = _cosyvoice_compatible_model_names(branch)
        return choices or [hint[1]]
    if branch == "VoxCPM2":
        return [hint[1]]
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
    if branch.startswith("Qwen3-"):
        if _qwen_compatible_model_dirs(branch):
            return []
        specs = universal_tts_branch_model_specs(branch)
        if selected and selected != "自动" and specs:
            specs = [dict(specs[0], filename=selected)]
        return specs
    if branch.startswith("IndexTTS"):
        missing: list[dict[str, str]] = []
        if branch == "IndexTTS-v1.5":
            specs = [{
                "label": "IndexTTS-v1.5 目录",
                "subdir": "TTS",
                "filename": "IndexTTS-1.5",
                "description": "IndexTTS-v1.5 主模型目录。请预先放到 models/TTS/IndexTTS-1.5。",
                "required": True,
            }]
        elif branch == "IndexTTS-v1.0":
            specs = [{
                "label": "IndexTTS-v1.0 目录",
                "subdir": "TTS",
                "filename": "Index-TTS-1.0",
                "description": "IndexTTS-v1.0 主模型目录。请预先放到 models/TTS/Index-TTS-1.0。",
                "required": True,
            }]
        else:
            specs = universal_tts_branch_model_specs(branch)
        for spec in specs:
            if spec.get("required") is False:
                continue
            label = spec.get("label", "模型")
            subdir = spec.get("subdir", "")
            filename = spec.get("filename", "")
            path = root / filename
            ok = path.is_dir() or path.is_file()
            if not ok:
                missing.append(spec)
        return missing
    if branch.startswith("LongCat"):
        selected_name = _longcat_model_name(branch, selected)
        if selected_name and (root / selected_name).exists() and _is_longcat_supported_model_name(selected_name):
            return []
        if _longcat_compatible_model_names(branch):
            return []
        return [{
            "label": f"{branch} 模型",
            "subdir": hint[0],
            "filename": LONGCAT_KNOWN_MODELS.get(branch, hint[1]),
            "description": (
                f"请放到 models/{hint[0]}/。当前加载器不支持 nvfp4 压缩版；"
                "请使用未压缩或当前加载器支持的 bf16/fp8 目录，或切换到已支持的 LongCat 分支。"
            ),
        }]
    if branch == "FishAudioS2":
        names = _fish_compatible_model_names()
        if selected and selected != "自动" and _fish_model_complete(root / Path(selected).name):
            return []
        if names:
            return []
        return [{
            "label": f"{branch} 模型",
            "subdir": hint[0],
            "filename": hint[1],
            "description": "请放到 models/TTS/，目录需包含 config.json、文本权重和 DAC 解码器。",
        }]
    if branch == "Fun-CosyVoice3-0.5B-2512":
        names = _cosyvoice_compatible_model_names(branch)
        if selected and selected != "自动" and (root / Path(selected).name).is_dir():
            return []
        if names:
            return []
        return [{
            "label": f"{branch} 模型",
            "subdir": hint[0],
            "filename": hint[1],
            "description": "请放到 models/TTS/。",
        }]
    if branch == "VoxCPM2":
        selected_name = Path(selected).name if selected and selected != "自动" else hint[1]
        path = root / selected_name
        if path.is_dir() and (path / "config.json").is_file():
            return []
        return [{
            "label": "VoxCPM2 模型目录",
            "subdir": hint[0],
            "filename": selected_name,
            "description": "请放到 models/TTS/VoxCPM2，目录内需包含 config.json 和权重文件。",
        }]
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
        model_download_url=BRANCH_MODEL_DOWNLOAD_URLS.get(branch),
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


def _send_audio_preview(unique_id: Any, audio_ui: dict[str, Any], text: str = "", preview: bool = False) -> None:
    if not unique_id or not audio_ui:
        return
    try:
        from server import PromptServer

        payload: dict[str, Any] = {"node": str(unique_id), "audio": audio_ui.get("audio", [])}
        if text:
            payload["text"] = str(text)
        if preview:
            payload["preview"] = True
        PromptServer.instance.send_sync("gjj_node_audio", payload)
    except Exception:
        pass


def _save_audio_ui(
    audio: dict[str, Any],
    filename_prefix: str,
    audio_format: str = "WAV",
    quality: str = "320k",
) -> dict[str, Any]:
    try:
        from comfy_api.latest import UI

        selected_format = _coerce_choice(audio_format, AUDIO_FORMAT_OPTIONS, "WAV")
        selected_quality = quality if quality in MP3_QUALITY_OPTIONS else "320k"
        return UI.AudioSaveHelper.get_save_audio_ui(
            audio,
            filename_prefix=str(filename_prefix or "audio/GJJ_UniversalTTS"),
            cls=None,
            format=selected_format.lower(),
            quality=selected_quality if selected_format == "MP3" else "pcm16",
        ).as_dict()
    except Exception as exc:
        raise RuntimeError(f"保存 {audio_format} 失败：{exc}") from exc


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


def _normalize_audio_rms(waveform: torch.Tensor, target_dbfs: float = -23.0) -> torch.Tensor:
    wav = waveform.float()
    rms = torch.sqrt(torch.mean(wav.square()).clamp_min(1e-12))
    target = float(10 ** (float(target_dbfs) / 20.0))
    return torch.clamp(wav * (target / rms), -1.0, 1.0)


def _models_mp3_root() -> Path:
    root = Path(folder_paths.models_dir) / "GJJ" / "wav"
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


def _audio_stem(value: str, fallback: str = "reference") -> str:
    text = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", str(value or ""), flags=re.UNICODE).strip("._-")
    return text[:72] or fallback


def _save_audio_to_models_mp3(audio: dict[str, Any], filename: str) -> str:
    wav, sample_rate = _audio_to_tensor(audio)
    data = wav.squeeze(0).detach().cpu().numpy()
    if data.ndim == 2:
        data = data.T
    data = np.asarray(data, dtype=np.float32)
    wav_target = _unique_models_mp3_path(f"{Path(filename).stem}.wav")

    def write_wav(path: Path) -> None:
        try:
            import soundfile as sf

            sf.write(str(path), data, int(sample_rate), subtype="PCM_16")
            return
        except Exception:
            pass
        pcm = np.clip(data.reshape(-1), -1.0, 1.0)
        pcm16 = (pcm * 32767.0).astype(np.int16)
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1 if data.ndim == 1 else int(data.shape[1]))
            handle.setsampwidth(2)
            handle.setframerate(int(sample_rate))
            handle.writeframes(pcm16.tobytes())

    write_wav(wav_target)
    return str(wav_target.relative_to(_models_mp3_root())).replace("/", "\\")


def _save_indextts_prompt_wav(waveform: torch.Tensor, sample_rate: int) -> str:
    cache_root = _ROOT / "__pycache__" / "gjj_indextts_audio_cache"
    cache_root.mkdir(parents=True, exist_ok=True)
    wav = waveform.detach().cpu().float()
    if wav.ndim == 3:
        wav = wav.squeeze(0)
    if wav.ndim == 1:
        wav = wav.unsqueeze(0)
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    data = wav.squeeze(0).numpy().astype(np.float32, copy=False)
    digest = hashlib.sha256(data[: min(data.shape[0], int(sample_rate) * 30)].tobytes()).hexdigest()[:16]
    target = cache_root / f"prompt_{digest}_{int(sample_rate)}.wav"
    if target.exists():
        return str(target)
    try:
        import soundfile as sf

        sf.write(str(target), data, int(sample_rate), subtype="PCM_16")
    except Exception:
        pcm16 = (np.clip(data, -1.0, 1.0) * 32767.0).astype(np.int16)
        with wave.open(str(target), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(int(sample_rate))
            handle.writeframes(pcm16.tobytes())
    return str(target)


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


def _audio_from_file_ffmpeg(path: Path) -> dict[str, Any]:
    ffmpeg = _find_ffmpeg_executable()
    if not ffmpeg:
        raise RuntimeError("没有找到可用 ffmpeg。")
    cmd = [
        ffmpeg,
        "-v",
        "error",
        "-i",
        str(path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(DEFAULT_SAMPLE_RATE),
        "-f",
        "wav",
        "-c:a",
        "pcm_s16le",
        "pipe:1",
    ]
    completed = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0 or not completed.stdout:
        stderr = completed.stderr.decode("utf-8", "ignore") if isinstance(completed.stderr, bytes) else str(completed.stderr or "")
        raise RuntimeError(f"ffmpeg 解码失败：{stderr[-800:]}")
    return _audio_from_wav_bytes(completed.stdout)


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


def _models_mp3_items() -> list[dict[str, Any]]:
    root = _models_mp3_root()
    items: list[dict[str, Any]] = []
    for path in root.rglob("*"):
        if not (path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS):
            continue
        try:
            stat = path.stat()
            mtime = float(stat.st_mtime)
            size = int(stat.st_size)
        except OSError:
            mtime = 0.0
            size = 0
        name = str(path.relative_to(root)).replace("/", "\\")
        items.append({"name": name, "mtime": mtime, "size": size})
    items.sort(key=lambda item: item.get("mtime", 0), reverse=True)
    return items


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
    errors: list[str] = []
    try:
        import soundfile as sf

        audio_np, sample_rate = sf.read(str(path), always_2d=True, dtype="float32")
        waveform = torch.from_numpy(audio_np.T).float()
    except Exception as sf_exc:
        errors.append(f"soundfile: {sf_exc}")
        try:
            return _audio_from_file_ffmpeg(path)
        except Exception as ffmpeg_exc:
            errors.append(f"ffmpeg: {ffmpeg_exc}")
        try:
            import torchaudio

            waveform, sample_rate = torchaudio.load(str(path))
        except Exception as exc:
            errors.append(f"torchaudio: {exc}")
            raise_dependency_model_error(
                node_name=NODE_DISPLAY_NAME,
                missing_dependencies=[
                    {"module_name": "soundfile", "package_name": "soundfile", "display_name": "soundfile", "description": "优先用于读取本地参考音频。"},
                    {"module_name": "imageio_ffmpeg", "package_name": "imageio-ffmpeg", "display_name": "imageio-ffmpeg", "description": "soundfile 无法读取某些 MP3/视频音轨时用于 ffmpeg 兜底解码。"},
                ],
                install_packages=["soundfile", "imageio-ffmpeg"],
                description="读取本地参考音频需要 soundfile，或可用的 ffmpeg/imageio-ffmpeg 兜底解码。",
                original_error="；".join(errors),
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
    # 后端只声明一个参考音频；后续输入由前端动态追加，参考文本由 Qwen3-ASR 自动识别。
    for index in range(1, 2):
        optional[_speaker_audio_name(index)] = ("AUDIO", {
            "forceInput": True,
            "display_name": f"参考音频{index}",
            "tooltip": "连接最后一对输入后会自动扩展下一对；没有链接会自动收缩。",
        })
    return optional


def _valid_audio(value: Any) -> bool:
    return isinstance(value, dict) and value.get("waveform") is not None and value.get("sample_rate") is not None


def _collect_references(kwargs: dict[str, Any], local_audio_name: str, local_audio_order: Any = None) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for index in range(1, MAX_REFERENCES + 1):
        audio = kwargs.get(_speaker_audio_name(index))
        if not _valid_audio(audio):
            continue
        refs.append({
            "speaker": index - 1,
            "source": "input",
            "audio": audio,
            "text": "",
            "text_is_explicit": False,
        })
    if not refs:
        ordered_names: list[str] = []
        if isinstance(local_audio_order, list):
            ordered_names = [str(item or "").strip() for item in local_audio_order if str(item or "").strip()]
        fallback_name = str(local_audio_name or "").strip()
        if fallback_name and fallback_name not in ordered_names:
            ordered_names.append(fallback_name)
        if not ordered_names:
            ordered_names = _list_models_mp3()
        for index, name in enumerate(list(dict.fromkeys(ordered_names))):
            refs.append({
                "speaker": index,
                "source": "local",
                "audio": _audio_from_file(_resolve_local_audio(name)),
                "text": "",
                "text_is_explicit": False,
            })
    return refs


def _recognize_reference_texts(references: list[dict[str, Any]], unique_id: Any = None) -> None:
    if not references:
        return
    from .gjj_qwen3_asr_text_formats import transcribe_reference_audio

    for index, reference in enumerate(references):
        _send_status(unique_id, f"正在识别参考音频文本 {index + 1}/{len(references)}", 0.07)
        reference["text"] = transcribe_reference_audio(reference["audio"], unique_id)
        reference["text_is_explicit"] = True


def _reference_for_speaker(references: list[dict[str, Any]], speaker: int) -> dict[str, Any] | None:
    if not references:
        return None
    index = max(0, int(speaker or 0)) % len(references)
    return references[index]


def _split_long_sentence(text: str, max_chars: int) -> list[str]:
    value = str(text or "").strip()
    if not value or len(value) <= max_chars:
        return [value] if value else []
    pieces = [part.strip() for part in re.split(r"(?<=[，,、：:])\s*", value) if part.strip()]
    if len(pieces) <= 1:
        return [value[index:index + max_chars].strip() for index in range(0, len(value), max_chars) if value[index:index + max_chars].strip()]
    result: list[str] = []
    current = ""
    for piece in pieces:
        candidate = f"{current}{piece}" if current else piece
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            result.append(current)
        if len(piece) > max_chars:
            result.extend(_split_long_sentence(piece, max_chars))
            current = ""
        else:
            current = piece
    if current:
        result.append(current)
    return result


def _merge_short_sentences(parts: list[str], min_chars: int, max_chars: int) -> list[str]:
    if min_chars <= 0:
        return parts
    result: list[str] = []
    current = ""
    for part in parts:
        candidate = f"{current}{part}" if current else part
        if current and len(current) >= min_chars:
            result.append(current)
            current = part
        elif len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                result.append(current)
            current = part
    if current:
        result.append(current)
    return result


def _split_sentences(text: str, min_chars: int = 12, max_chars: int = 80) -> list[str]:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if not value:
        return []
    max_chars = max(8, int(max_chars or 80))
    min_chars = max(0, min(int(min_chars or 0), max_chars))
    rough_parts = [part.strip() for part in re.split(r"(?<=[。！？!?；;])\s*", value) if part.strip()]
    long_split: list[str] = []
    for part in rough_parts:
        long_split.extend(_split_long_sentence(part, max_chars))
    return _merge_short_sentences(long_split, min_chars, max_chars)


def _speaker_index_from_label(label: str, speaker_map: dict[str, int]) -> int:
    raw = str(label or "").strip().strip("[]【】（）() ")
    numeric = re.search(r"(?:speaker|spk|角色|说话人)?[_\s-]*(\d+)$", raw, re.I)
    if numeric:
        return max(0, int(numeric.group(1)) - 1)
    key = raw.lower()
    if key not in speaker_map:
        speaker_map[key] = len(speaker_map)
    return speaker_map[key]


def _clean_speaker_label(label: str) -> str:
    return str(label or "").strip().strip("[]【】（）() ")


def _parse_turns(text: str, min_chars: int = 12, max_chars: int = 80) -> list[dict[str, Any]]:
    tag_re = re.compile(r"^\s*((?:\[?speaker[_\s-]*(\d+)\]?|spk[_\s-]*(\d+)|角色\s*(\d+)|说话人\s*(\d+)))\s*[:：]\s*(.*)$", re.I)
    named_tag_re = re.compile(r"^\s*([A-Za-z]|[甲乙丙丁戊己庚辛壬癸]|[\u4e00-\u9fffA-Za-z0-9_·]{1,12}(?:\s*[、,，/|&和与]\s*[\u4e00-\u9fffA-Za-z0-9_·]{1,12}){0,8})\s*[:：]\s*(.*)$")
    turns: list[dict[str, Any]] = []
    current_speaker = 0
    current_speakers = [0]
    current_label = "说话人1"
    speaker_map: dict[str, int] = {}
    buffer: list[str] = []

    def flush() -> None:
        nonlocal buffer
        joined = " ".join(part.strip() for part in buffer if part.strip()).strip()
        if joined:
            for sentence in _split_sentences(joined, min_chars, max_chars):
                turns.append({
                    "speaker": current_speakers[0] if current_speakers else 0,
                    "speaker_label": current_label,
                    "text": sentence,
                })
        buffer = []

    def labels_to_speaker_info(value: str) -> tuple[list[int], str]:
        labels = [_clean_speaker_label(part) for part in re.split(r"\s*(?:[、,，/|&]|和|与)\s*", str(value or "")) if part.strip()]
        speakers = [_speaker_index_from_label(label, speaker_map) for label in labels]
        display = "、".join(labels) if labels else "说话人1"
        return list(dict.fromkeys(speakers)) or [0], display

    for raw in str(text or "").splitlines():
        match = tag_re.match(raw)
        if match:
            flush()
            number = next((group for group in match.groups()[1:5] if group), "1")
            current_speaker = max(0, int(number) - 1)
            current_speakers = [current_speaker]
            current_label = _clean_speaker_label(match.group(1)) or f"说话人{current_speaker + 1}"
            buffer = [match.group(6)] if match.group(6).strip() else []
            continue
        named_match = named_tag_re.match(raw)
        if named_match:
            flush()
            current_speakers, current_label = labels_to_speaker_info(named_match.group(1))
            current_speaker = current_speakers[0]
            buffer = [named_match.group(2)] if named_match.group(2).strip() else []
        else:
            stripped = raw.strip()
            if stripped:
                buffer.append(stripped)
    flush()
    return turns or [{"speaker": 0, "speaker_label": "说话人1", "text": sentence} for sentence in _split_sentences(text, min_chars, max_chars)]


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
    def speaker_label(item: dict[str, Any]) -> str:
        label = str(item.get("speaker_label") or "").strip()
        return label or f"说话人{max(1, int(item.get('speaker') or 1))}"

    def speaker_text(item: dict[str, Any]) -> str:
        return f"[{speaker_label(item)}] {item['text']}"

    selected = str(fmt or "SRT").upper()
    if selected == "JSON":
        enriched = [{**item, "speaker_label": speaker_label(item), "text": speaker_text(item)} for item in items]
        return json.dumps(enriched, ensure_ascii=False, indent=2)
    if selected == "VTT":
        lines = ["WEBVTT", ""]
        for item in items:
            lines += [f"{_fmt_time_srt(item['start'], False)} --> {_fmt_time_srt(item['end'], False)}", speaker_text(item), ""]
        return "\n".join(lines)
    if selected == "LRC":
        return "\n".join(f"[{_fmt_time_srt(item['start'], False)[3:8]}]{speaker_text(item)}" for item in items)
    lines = []
    for idx, item in enumerate(items, start=1):
        lines += [str(idx), f"{_fmt_time_srt(item['start'])} --> {_fmt_time_srt(item['end'])}", speaker_text(item), ""]
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


def _edge_error_message(exc: Exception) -> str:
    message = str(exc or "").strip()
    lowered = message.lower()
    if "timeout" in lowered or "timed out" in lowered or "connection" in lowered:
        return "EdgeTTS 在线服务连接超时。请检查网络，稍后重试，或切换到本地/参考音频分支。"
    if "invalid voice" in lowered:
        return f"EdgeTTS 音色无效：{message}"
    return f"EdgeTTS 生成失败：{message or type(exc).__name__}"


def _edge_tts_once(text: str, voice: str, speed: float, pitch: int, timeout: float) -> dict[str, Any]:
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

    return _edge_tts_stdlib(text, voice, speed, pitch, timeout)


def _edge_tts_stdlib(text: str, voice: str, speed: float, pitch: int, timeout: float) -> dict[str, Any]:
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
    if not data:
        raise RuntimeError("EdgeTTS 没有返回音频。")
    if data.startswith(b"RIFF"):
        return _audio_from_wav_bytes(data)
    samples = torch.frombuffer(bytearray(data), dtype=torch.int16).float() / 32768.0
    return _comfy_audio(samples.reshape(1, 1, -1), DEFAULT_SAMPLE_RATE)


def _edge_tts(text: str, voice: str, speed: float, pitch: int, timeout: float) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            return _edge_tts_once(text, voice, speed, pitch, timeout)
        except Exception as exc:
            last_error = exc
            if _has_module("edge_tts"):
                try:
                    return _edge_tts_stdlib(text, voice, speed, pitch, timeout)
                except Exception as fallback_exc:
                    last_error = fallback_exc
            if attempt < 3:
                time.sleep(0.8 * attempt)
    raise RuntimeError(_edge_error_message(last_error or RuntimeError("unknown error")))


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


def _qwen_device(device_choice: str) -> str:
    value = str(device_choice or "auto").strip().lower()
    if value == "auto":
        return "cuda:0" if torch.cuda.is_available() else "cpu"
    if value == "cuda":
        return "cuda:0"
    if value == "mps":
        return "mps"
    return "cpu"


def _qwen_dtype_name(precision: str) -> str:
    value = str(precision or "auto").strip().lower()
    if value == "fp16":
        return "float16"
    if value == "fp32":
        return "float32"
    return "bfloat16"


def _qwen_model_name(branch: str, model_name: str) -> str:
    raw = str(model_name or "").strip()
    requested = Path(raw).name if raw and raw != "自动" else ""
    if requested and _qwen_expected_model_type(branch) == _qwen_model_type(_models_root("TTS") / requested):
        return requested
    matches = _qwen_compatible_model_dirs(branch)
    if matches:
        return matches[0].name
    hint = BRANCH_MODEL_HINTS.get(branch)
    return hint[1] if hint else "Qwen3-TTS-12Hz-1.7B-base"


def _qwen_model_dir(branch: str, model_name: str, unique_id: Any = None) -> Path:
    name = _qwen_model_name(branch, model_name)
    path = _models_root("TTS") / name
    expected_type = _qwen_expected_model_type(branch)
    actual_type = _qwen_model_type(path)
    if not (path.is_dir() and any(path.iterdir())) or (expected_type and actual_type != expected_type):
        selected = str(model_name or "").strip()
        reason = ""
        if selected and selected != "自动":
            selected_path = _models_root("TTS") / Path(selected).name
            selected_type = _qwen_model_type(selected_path)
            if selected_path.is_dir() and selected_type and selected_type != expected_type:
                reason = f"当前选择的模型类型是 {selected_type}，但 {branch} 需要 {expected_type}。"
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[{
                "label": f"{branch} 模型",
                "subdir": "TTS",
                "filename": name,
                "description": f"请预先下载 tts_model_type={expected_type} 的模型到 models/TTS/；UniversalTTS 不会在运行时临时下载。{reason}",
            }],
            description="Qwen3-TTS 模型目录缺失或模型能力与当前分支不匹配。",
            unique_id=unique_id,
            title="GJJ 节点模型缺失！",
        )
    return path


def _load_qwen3(branch: str, model_name: str, device: str, precision: str, unique_id: Any = None):
    model_path = _qwen_model_dir(branch, model_name, unique_id)
    device_name = _qwen_device(device)
    dtype_name = _qwen_dtype_name(precision)
    cache_key = f"qwen3:{model_path}:{device_name}:{dtype_name}"
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]
    try:
        from qwen_tts import Qwen3TTSModel
    except Exception as exc:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=BRANCH_DEPENDENCIES.get(branch, []),
            install_packages=["qwen-tts", "soundfile"],
            description="Qwen3-TTS 运行时导入失败；请安装 qwen-tts。模型仍需手动放在 models/TTS/ 下。",
            original_error=str(exc),
            unique_id=unique_id,
        )
    dtype_map = {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}
    _send_status(unique_id, f"正在加载 Qwen3-TTS：{model_path.name}", 0.12)
    model = Qwen3TTSModel.from_pretrained(
        str(model_path),
        device_map=device_name,
        dtype=dtype_map.get(dtype_name, torch.bfloat16),
        attn_implementation="eager",
    )
    _MODEL_CACHE[cache_key] = model
    return model


def _seed_all(seed: int) -> None:
    if int(seed) < 0:
        return
    torch.manual_seed(int(seed))
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(int(seed))
    np.random.seed(int(seed) % (2**32))


def _qwen_audio_from_wavs(wavs: Any, sr: int) -> dict[str, Any]:
    first = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
    wav = np.asarray(first, dtype=np.float32)
    if wav.ndim > 1:
        wav = np.reshape(wav, (-1,))
    return _comfy_audio(torch.from_numpy(wav).reshape(1, 1, -1), int(sr))


def _qwen_language(language: str) -> str:
    value = str(language or "auto").strip().lower()
    return {
        "auto": "Auto",
        "zh": "Chinese",
        "cn": "Chinese",
        "chinese": "Chinese",
        "en": "English",
        "english": "English",
        "ja": "Japanese",
        "jp": "Japanese",
        "japanese": "Japanese",
        "ko": "Korean",
        "kr": "Korean",
        "korean": "Korean",
    }.get(value, str(language or "Auto").strip() or "Auto")


def _qwen_reference_text(reference_text: str) -> str:
    text = str(reference_text or "").strip()
    if not text or text == LEGACY_DEFAULT_REFERENCE_TEXT:
        raise RuntimeError("Qwen3-ASR 未能提供参考音频的有效识别文本。")
    return text


def _parse_edge_speaker_voices(value: Any) -> dict[int, str]:
    if isinstance(value, list):
        return {index: str(voice or "").strip() for index, voice in enumerate(value) if str(voice or "").strip()}
    if isinstance(value, dict):
        data = value
    else:
        try:
            data = json.loads(str(value or "{}"))
        except Exception:
            data = {}
    if isinstance(data, list):
        return {index: str(voice or "").strip() for index, voice in enumerate(data) if str(voice or "").strip()}
    result: dict[int, str] = {}
    if not isinstance(data, dict):
        return result
    for key, raw_voice in data.items():
        match = re.search(r"(\d+)", str(key or ""))
        if not match:
            continue
        voice = str(raw_voice or "").strip()
        if voice:
            result[max(0, int(match.group(1)) - 1)] = voice
    return result


def _edge_voice_id(value: str, fallback: str) -> str:
    selected = str(value or "").strip() or str(fallback or "").strip()
    return VOICE_IDS.get(selected, selected)


def _edge_voice_for_speaker(speaker: int, default_voice: str, speaker_voices: dict[int, str]) -> str:
    voice = speaker_voices.get(max(0, int(speaker or 0)))
    return str(voice or default_voice or "").strip()


def _parse_tts_speaker_voices(value: Any, branch: str, legacy_value: Any = None) -> dict[int, str]:
    try:
        data = value if isinstance(value, dict) else json.loads(str(value or "{}"))
    except Exception:
        data = {}
    branch_value = data.get(str(branch or "")) if isinstance(data, dict) else None
    parsed = _parse_edge_speaker_voices(branch_value)
    return parsed or _parse_edge_speaker_voices(legacy_value)


def _qwen_clone_reference_audio(reference: dict[str, Any]) -> tuple[np.ndarray, int]:
    wav, sr = _audio_to_tensor(reference["audio"])
    ref_waveform = wav.squeeze(0).detach().cpu().numpy().copy()
    if ref_waveform.ndim > 1:
        ref_waveform = np.mean(ref_waveform, axis=0)
    return ref_waveform.astype(np.float32, copy=False), int(sr)


def _qwen3_tts(
    branch: str,
    model_name: str,
    text: str,
    reference: dict[str, Any] | None,
    reference_text: str,
    custom_voice: str,
    language: str,
    device: str,
    precision: str,
    seed: int,
    qwen_max_new_tokens: int,
    qwen_top_p: float,
    qwen_top_k: int,
    qwen_temperature: float,
    qwen_repetition_penalty: float,
    qwen_x_vector_only: bool,
    emotion_prompt: str,
    qwen_instruct: str,
    unique_id: Any,
) -> dict[str, Any]:
    _seed_all(seed)
    model = _load_qwen3(branch, model_name, device, precision, unique_id)
    lang = _qwen_language(language)
    gen_kwargs = {
        "max_new_tokens": int(qwen_max_new_tokens),
        "temperature": float(qwen_temperature),
        "top_p": float(qwen_top_p),
        "top_k": int(qwen_top_k),
        "repetition_penalty": float(qwen_repetition_penalty),
    }
    if branch == "Qwen3-CustomVoice":
        speaker = str(custom_voice or "").strip() or "Vivian"
        wavs, sr = model.generate_custom_voice(
            text=text,
            language=lang,
            speaker=speaker,
            instruct=None,
            **gen_kwargs,
        )
        return _qwen_audio_from_wavs(wavs, sr)
    if branch == "Qwen3-VoiceDesign":
        description = (
            str(qwen_instruct or "").strip()
            or str(emotion_prompt or "").strip()
            or str(custom_voice or "").strip()
            or "A warm, clear natural voice."
        )
        wavs, sr = model.generate_voice_design(
            text=text,
            language=lang,
            instruct=description,
            **gen_kwargs,
        )
        return _qwen_audio_from_wavs(wavs, sr)
    if reference is None or not _valid_audio(reference.get("audio")):
        raise RuntimeError("Qwen3-VoiceClone 分支需要参考音频。")
    ref_text = "" if qwen_x_vector_only else _qwen_reference_text(reference_text)
    ref_np, sr0 = _qwen_clone_reference_audio(reference)
    wavs, sr = model.generate_voice_clone(
        text=text,
        language=lang,
        ref_audio=(ref_np, int(sr0)),
        ref_text=ref_text,
        x_vector_only_mode=bool(qwen_x_vector_only),
        **gen_kwargs,
    )
    return _qwen_audio_from_wavs(wavs, sr)


def _indextts_root() -> Path:
    return _ROOT.parent / "ComfyUI_IndexTTS"


def _install_indextts_audio_compat():
    module_name = "indextts.s2mel.modules.audio"
    if module_name in sys.modules:
        return
    try:
        import torchaudio.functional as ta_functional
    except Exception:
        return

    audio_module = types.ModuleType(module_name)
    audio_module.MAX_WAV_VALUE = 32768.0
    audio_module.mel_basis = {}
    audio_module.hann_window = {}

    def load_wav(full_path):
        import soundfile as sf

        data, sampling_rate = sf.read(full_path, dtype="int16")
        return data, sampling_rate

    def dynamic_range_compression(x, C=1, clip_val=1e-5):
        return np.log(np.clip(x, a_min=clip_val, a_max=None) * C)

    def dynamic_range_decompression(x, C=1):
        return np.exp(x) / C

    def dynamic_range_compression_torch(x, C=1, clip_val=1e-5):
        return torch.log(torch.clamp(x, min=clip_val) * C)

    def dynamic_range_decompression_torch(x, C=1):
        return torch.exp(x) / C

    def spectral_normalize_torch(magnitudes):
        return dynamic_range_compression_torch(magnitudes)

    def spectral_de_normalize_torch(magnitudes):
        return dynamic_range_decompression_torch(magnitudes)

    def mel_spectrogram(y, n_fft, num_mels, sampling_rate, hop_size, win_size, fmin, fmax, center=False):
        key = f"{sampling_rate}_{fmax}_{y.device}"
        win_key = f"{sampling_rate}_{y.device}"
        if key not in audio_module.mel_basis:
            mel = ta_functional.melscale_fbanks(
                n_freqs=n_fft // 2 + 1,
                f_min=float(fmin),
                f_max=float(fmax) if fmax is not None else float(sampling_rate) / 2,
                n_mels=int(num_mels),
                sample_rate=int(sampling_rate),
                norm="slaney",
                mel_scale="slaney",
            ).transpose(0, 1)
            audio_module.mel_basis[key] = mel.float().to(y.device)
            audio_module.hann_window[win_key] = torch.hann_window(win_size).to(y.device)
        y = torch.nn.functional.pad(
            y.unsqueeze(1), (int((n_fft - hop_size) / 2), int((n_fft - hop_size) / 2)), mode="reflect"
        ).squeeze(1)
        spec = torch.view_as_real(
            torch.stft(
                y,
                n_fft,
                hop_length=hop_size,
                win_length=win_size,
                window=audio_module.hann_window[win_key],
                center=center,
                pad_mode="reflect",
                normalized=False,
                onesided=True,
                return_complex=True,
            )
        )
        spec = torch.sqrt(spec.pow(2).sum(-1) + 1e-9)
        spec = torch.matmul(audio_module.mel_basis[key], spec)
        return spectral_normalize_torch(spec)

    audio_module.load_wav = load_wav
    audio_module.dynamic_range_compression = dynamic_range_compression
    audio_module.dynamic_range_decompression = dynamic_range_decompression
    audio_module.dynamic_range_compression_torch = dynamic_range_compression_torch
    audio_module.dynamic_range_decompression_torch = dynamic_range_decompression_torch
    audio_module.spectral_normalize_torch = spectral_normalize_torch
    audio_module.spectral_de_normalize_torch = spectral_de_normalize_torch
    audio_module.mel_spectrogram = mel_spectrogram
    sys.modules[module_name] = audio_module


def _patch_indextts_deepspeed_fallback():
    if importlib.util.find_spec("deepspeed") is not None:
        return
    for module_name in ("indextts.gpt.model", "indextts.gpt.model_v2"):
        try:
            module = __import__(module_name, fromlist=["UnifiedVoice"])
            cls = getattr(module, "UnifiedVoice", None)
            original = getattr(cls, "post_init_gpt2_config", None)
        except Exception:
            continue
        if cls is None or original is None or getattr(original, "_gjj_no_deepspeed", False):
            continue

        def patched(self, use_deepspeed=False, kv_cache=False, half=False, _original=original):
            return _original(self, use_deepspeed=False, kv_cache=kv_cache, half=half)

        patched._gjj_no_deepspeed = True
        cls.post_init_gpt2_config = patched


def _patch_indextts_text_normalizer():
    try:
        from indextts.utils.front import TextNormalizer
        from wetext import Normalizer
    except Exception:
        return
    original = getattr(TextNormalizer, "load", None)
    if original is None or getattr(original, "_gjj_wetext", False):
        return

    def load(self):
        if self.zh_normalizer is not None and self.en_normalizer is not None:
            return
        self.zh_normalizer = Normalizer(remove_erhua=False, lang="zh", operator="tn")
        self.en_normalizer = Normalizer(lang="en", operator="tn")

    load._gjj_wetext = True
    TextNormalizer.load = load


def _patch_indextts_torchaudio_load():
    try:
        import indexttsnode
    except Exception:
        return
    ta = getattr(indexttsnode, "torchaudio", None)
    if ta is None:
        return
    original = getattr(ta, "load", None)
    if original is not None and not getattr(original, "_gjj_soundfile_fallback", False):
        def load(path, *args, _original=original, **kwargs):
            try:
                return _original(path, *args, **kwargs)
            except Exception as exc:
                message = str(exc)
                if "TorchCodec is required" not in message and "load_with_torchcodec" not in message:
                    raise
                import soundfile as sf

                data, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
                tensor = torch.from_numpy(data.T.copy())
                return tensor, int(sample_rate)

        load._gjj_soundfile_fallback = True
        ta.load = load

    original_save = getattr(ta, "save", None)
    if original_save is None or getattr(original_save, "_gjj_soundfile_fallback", False):
        return

    def save(path, src, sample_rate, *args, _original=original_save, **kwargs):
        try:
            return _original(path, src, sample_rate, *args, **kwargs)
        except Exception as exc:
            message = str(exc)
            if "TorchCodec is required" not in message and "save_with_torchcodec" not in message:
                raise
            import soundfile as sf

            tensor = src.detach().cpu().float()
            if tensor.ndim == 3:
                tensor = tensor.squeeze(0)
            if tensor.ndim == 1:
                data = tensor.numpy()
            else:
                data = tensor.numpy().T
            sf.write(str(path), data, int(sample_rate), subtype="PCM_16")

    save._gjj_soundfile_fallback = True
    ta.save = save


def _patch_indextts_audio_cache_manager():
    try:
        import indexttsnode
    except Exception:
        return
    manager_cls = getattr(indexttsnode, "AudioCacheManager", None)
    if manager_cls is None:
        return
    original = getattr(manager_cls, "_cache_audio_tensor", None)
    if original is None or getattr(original, "_gjj_soundfile_cache", False):
        return

    def _cache_audio_tensor(self, audio_tensor, sample_rate, filename_prefix="cached_audio_", audio_format=".wav"):
        try:
            import soundfile as sf

            with tempfile.NamedTemporaryFile(
                prefix=filename_prefix,
                suffix=audio_format or ".wav",
                dir=self.cache_dir,
                delete=False,
            ) as tmp_file:
                temp_filepath = tmp_file.name
            tensor = audio_tensor.detach().cpu().float()
            if tensor.ndim == 3:
                tensor = tensor.squeeze(0)
            if tensor.ndim == 1:
                data = tensor.numpy()
            else:
                data = tensor.numpy().T
            sf.write(str(temp_filepath), data, int(sample_rate), subtype="PCM_16")
            return temp_filepath
        except Exception as exc:
            raise Exception(f"Error caching audio tensor: {exc}")

    _cache_audio_tensor._gjj_soundfile_cache = True
    manager_cls._cache_audio_tensor = _cache_audio_tensor


def _ensure_indextts_runtime(branch: str = "IndexTTS-v2", unique_id: Any = None):
    root = _indextts_root()
    if not root.is_dir():
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[{
                "module_name": "",
                "package_name": "",
                "display_name": "ComfyUI_IndexTTS",
                "description": f"未找到自定义节点目录：{root}",
            }],
            install_packages=[],
            description="IndexTTS 运行时代码缺失。",
            unique_id=unique_id,
            copy_text="",
            copy_label="",
        )
    _ensure_sys_path(root)
    numba_cache_dir = _ROOT / "__pycache__" / "gjj_numba_cache"
    try:
        numba_cache_dir.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("NUMBA_CACHE_DIR", str(numba_cache_dir))
    except Exception:
        pass
    _install_indextts_audio_compat()
    try:
        from indexttsnode import AudioCacheManager, IndexTTS, IndexTTS2, cache_dir, current_dir
        _patch_indextts_deepspeed_fallback()
        _patch_indextts_text_normalizer()
        _patch_indextts_torchaudio_load()
        _patch_indextts_audio_cache_manager()
    except Exception as exc:
        deps = BRANCH_DEPENDENCIES.get(branch, BRANCH_DEPENDENCIES.get("IndexTTS-v2", []))
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=deps,
            install_packages=[spec.get("package_name", "") for spec in deps if spec.get("package_name")],
            description="IndexTTS 运行时导入失败；请补齐 Python 依赖。模型仍需手动放在 models/TTS/ 下。",
            original_error=str(exc),
            unique_id=unique_id,
        )
    return AudioCacheManager, IndexTTS, IndexTTS2, cache_dir, current_dir


def _indextts_v1_model_dir(branch: str) -> Path:
    hint = BRANCH_MODEL_HINTS.get(branch, ("TTS", "Index-TTS"))
    return _models_root(hint[0]) / hint[1]


def _index_cfg_path(branch: str, model_dir: Path) -> str:
    candidates = ["config_v1_5.yaml", "config.yaml"] if branch == "IndexTTS-v1.5" else ["config.yaml"]
    for name in candidates:
        cfg_path = model_dir / name
        if cfg_path.is_file():
            if branch == "IndexTTS-v1.0":
                text = cfg_path.read_text(encoding="utf-8")
                if "checkpoints/" in text:
                    cache_root = _ROOT / "__pycache__" / "gjj_indextts_configs"
                    cache_root.mkdir(parents=True, exist_ok=True)
                    patched_path = cache_root / f"{branch}_config.yaml"
                    patched_path.write_text(text.replace("checkpoints/", ""), encoding="utf-8")
                    return str(patched_path)
            return str(cfg_path)
    return str(model_dir / candidates[-1])


def _load_indextts(branch: str, device: str, precision: str, unique_id: Any = None):
    AudioCacheManager, IndexTTS, IndexTTS2, cache_dir, current_dir = _ensure_indextts_runtime(branch, unique_id)
    precision_value = str(precision or "auto").strip().lower()
    is_auto_cuda = precision_value == "auto" and torch.cuda.is_available() and str(device or "auto") in {"auto", "cuda", "cuda:0"}
    is_fp16 = precision_value in {"fp16", "float16"}
    if branch != "IndexTTS-v2" and is_auto_cuda:
        is_fp16 = True
    if branch == "IndexTTS-v2":
        cache_key = f"indextts:{branch}:{is_fp16}:{device}"
        if cache_key in _MODEL_CACHE:
            return _MODEL_CACHE[cache_key]
        _send_status(unique_id, f"正在加载 {branch}", 0.12)
        model = IndexTTS2(is_fp16=is_fp16, device=None if str(device or "auto") == "auto" else str(device), use_cuda_kernel=False)
        _MODEL_CACHE[cache_key] = (model, AudioCacheManager(cache_dir))
        return _MODEL_CACHE[cache_key]
    model_dir = _indextts_v1_model_dir(branch)
    cfg_path = _index_cfg_path(branch, model_dir)
    cache_key = f"indextts:{branch}:{model_dir}:{cfg_path}:{is_fp16}:{device}"
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]
    _send_status(unique_id, f"正在加载 {branch}", 0.12)
    model = IndexTTS(
        cfg_path=cfg_path,
        model_dir=str(model_dir),
        is_fp16=is_fp16,
        device=None if str(device or "auto") == "auto" else str(device),
    )
    _MODEL_CACHE[cache_key] = (model, AudioCacheManager(cache_dir))
    return _MODEL_CACHE[cache_key]


def _indextts_audio(
    branch: str,
    text: str,
    reference: dict[str, Any] | None,
    device: str,
    precision: str,
    emotion_prompt: str,
    unique_id: Any,
) -> dict[str, Any]:
    if reference is None or not _valid_audio(reference.get("audio")):
        raise RuntimeError(f"{branch} 分支需要参考音频。")
    model, audio_cache = _load_indextts(branch, device, precision, unique_id)
    waveform = reference["audio"]["waveform"].squeeze(0)
    sr = int(reference["audio"]["sample_rate"])
    prompt_path = audio_cache.process_audio(waveform, sr)
    infer_kwargs = {
        "top_p": 0.8,
        "top_k": 30,
        "temperature": 0.8 if branch == "IndexTTS-v2" else 1.0,
        "max_mel_tokens": 1500 if branch == "IndexTTS-v2" else 1000,
        "max_text_tokens_per_sentence": 120,
        "num_beams": 3,
    }
    if hasattr(model, "infer_fast"):
        res = model.infer_fast(
            prompt_path,
            str(text or ""),
            sentences_bucket_max_size=4,
            **infer_kwargs,
        )
    else:
        emotion_text = str(emotion_prompt or "").strip()
        res = model.infer(
            prompt_path,
            str(text or ""),
            use_emo_text=bool(emotion_text),
            emo_text=emotion_text or None,
            **infer_kwargs,
        )
    wav = res[0]
    out_sr = int(res[1])
    if isinstance(wav, torch.Tensor):
        tensor = wav.detach().cpu().float()
    else:
        tensor = torch.as_tensor(wav, dtype=torch.float32)
    if tensor.ndim == 1:
        tensor = tensor.reshape(1, 1, -1)
    elif tensor.ndim == 2:
        tensor = tensor.unsqueeze(0)
    return {"waveform": tensor.contiguous(), "sample_rate": out_sr}


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
        missing_models=[{"label": "Fish S2 DAC 解码器", "subdir": "TTS", "filename": "codec.pth / firefly-gan-vq-fsq-8x1024-21hz-generator.pth", "description": "请放在 Fish 模型目录或 models/TTS/ 下。"}],
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
    selected_name = str(model_name or "").strip()
    if not selected_name or selected_name == "自动":
        choices = _fish_compatible_model_names()
        selected_name = choices[0] if choices else "fishaudio-s2-pro-fp8"
    model_path = _model_dir("TTS", selected_name, "fishaudio-s2-pro-fp8", unique_id)
    if not _fish_model_complete(model_path):
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[{"label": model_path.name, "subdir": "TTS", "filename": model_path.name, "description": "目录需包含 config.json、文本权重和 DAC 解码器。"}],
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
        selected = raw.replace(" (auto download)", "")
        prefix = LONGCAT_BRANCH_PREFIXES.get(branch, "")
        if prefix and selected.startswith(prefix) and _is_longcat_supported_model_name(selected):
            return selected
    choices = _longcat_compatible_model_names(branch)
    if choices:
        return choices[0]
    return LONGCAT_KNOWN_MODELS.get(branch, "LongCat-AudioDiT-3.5B-fp8")


def _is_longcat_quantization_mismatch_error(error: Any) -> bool:
    text = str(error or "").lower()
    return "size mismatch" in text and "embedding" in text and "256384" in text and ("96" in text or "nvfp4" in text)


def _raise_longcat_quantization_error(model_name: str, unique_id: Any = None) -> None:
    branch_hint = "LongCat3.5B" if "3.5b" in str(model_name).lower() else "LongCat-1B"
    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[{
            "label": f"{branch_hint} 支持模型",
            "subdir": "TTS",
            "filename": LONGCAT_KNOWN_MODELS.get(branch_hint, "LongCat-AudioDiT-3.5B-fp8"),
            "description": (
                "当前本地 LongCat 权重是 nvfp4 压缩形态，text encoder 权重维度与当前加载器不匹配。"
                "请使用未压缩或当前加载器支持的 bf16/fp8/mxfp8 版本；UniversalTTS 会自动忽略 nvfp4 目录。"
            ),
        }],
        description="LongCat 模型权重格式暂不兼容。",
        original_error=str(model_name or ""),
        unique_id=unique_id,
        model_download_url="https://huggingface.co/meituan-longcat",
    )


def _is_longcat_architecture_error(error: Any) -> bool:
    text = str(error or "").lower()
    return "longcat_audiodit" in text and "recognize this architecture" in text


def _raise_longcat_architecture_error(unique_id: Any = None) -> None:
    copy_text = (
        f'& "{sys.executable}" -m pip install --upgrade transformers\n'
        f'& "{sys.executable}" -m pip install git+https://github.com/huggingface/transformers.git'
    )
    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=[{
            "module_name": "transformers",
            "package_name": "transformers",
            "display_name": "transformers",
            "description": "LongCat AudioDiT 模型结构加载依赖。",
        }],
        install_packages=["transformers", "safetensors"],
        description=(
            "当前 transformers 版本不认识 LongCat AudioDiT 的 longcat_audiodit 架构。"
            "请先升级 transformers；如果 PyPI 版本仍不支持，请安装 HuggingFace 源码版后重启 ComfyUI。"
        ),
        original_error="",
        unique_id=unique_id,
        copy_text=copy_text,
        copy_label="📋 复制升级命令",
    )


def _load_longcat(model_name: str, device_choice: str, precision: str, unique_id: Any = None):
    _ensure_vendor_package("audiodit", _VENDOR_ROOT, unique_id)
    selected_name = str(model_name or "").strip() or LONGCAT_KNOWN_MODELS.get("LongCat3.5B", "LongCat-AudioDiT-3.5B-fp8")
    if not _is_longcat_supported_model_name(selected_name):
        _raise_longcat_quantization_error(selected_name, unique_id)
    device, dtype = _resolve_device_dtype(device_choice, precision)
    loader_precision = "bf16" if str(precision or "auto") == "fp16" else str(precision or "auto")
    cache_key = f"longcat:{selected_name}:{device}:{loader_precision}"
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]
    _send_status(unique_id, "正在加载 LongCat AudioDiT 模型", 0.14)
    model, tokenizer = _load_longcat_audiodit_model(selected_name, device_choice, loader_precision, "auto", unique_id=unique_id)
    _MODEL_CACHE[cache_key] = (model, tokenizer)
    return model, tokenizer


def _reference_to_tensor(reference: dict[str, Any], target_sr: int) -> torch.Tensor:
    wav, sr = _audio_to_tensor(reference["audio"])
    if sr != target_sr:
        wav = _resample_waveform(wav, sr, target_sr)
    if wav.ndim == 3:
        wav = wav[:, 0, :]
    return _normalize_audio_rms(wav.to(torch.float32))


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
    line_text = _longcat_normalize_text(text)
    ref_text_matches_audio = bool(reference.get("text_is_explicit", True))
    ref_norm = _longcat_normalize_text(reference_text) if ref_text_matches_audio and str(reference_text or "").strip() else ""
    full_text = f"{ref_norm} {line_text}" if ref_norm else line_text
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
    duration_sec = _longcat_approx_duration_from_text(line_text, max_duration=max_duration - prompt_time)
    if ref_norm:
        approx_prompt = _longcat_approx_duration_from_text(ref_norm, max_duration=max_duration)
        ratio = float(np.clip(prompt_time / max(approx_prompt, 0.1), 1.0, 1.5))
        duration_sec = float(duration_sec * ratio)
    duration = int(duration_sec * sr // full_hop)
    total_duration = min(duration + prompt_dur, int(max_duration * sr // full_hop))
    with torch.no_grad():
        output = model(
            input_ids=input_ids,
            attention_mask=attention_mask,
            prompt_audio=ref_audio.unsqueeze(0),
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

    model_root = _models_root("TTS")
    selected_name = str(model_name or "").strip()
    if not selected_name or selected_name == "自动":
        choices = _cosyvoice_compatible_model_names(branch)
        selected_name = choices[0] if choices else "Fun-CosyVoice3-0.5B-2512"
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


def _voxcpm_root() -> Path:
    return _VENDOR_ROOT / "voxcpm"


def _ensure_voxcpm_runtime(unique_id: Any = None):
    root = _voxcpm_root()
    if not (root / "__init__.py").is_file():
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[{
                "module_name": "voxcpm",
                "package_name": "",
                "display_name": "GJJ 内置 VoxCPM 运行时",
                "description": f"未找到 GJJ vendor 运行时：{root}",
            }],
            install_packages=[],
            description="VoxCPM vendor 运行时代码缺失。",
            unique_id=unique_id,
            copy_text="",
            copy_label="",
        )
    _ensure_sys_path(_VENDOR_ROOT)
    try:
        from voxcpm import VoxCPM
    except Exception as exc:
        deps = BRANCH_DEPENDENCIES.get("VoxCPM2", [])
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=deps,
            install_packages=[spec.get("package_name", "") for spec in deps if spec.get("package_name")],
            description="VoxCPM 运行时导入失败；请补齐 Python 依赖。",
            original_error=str(exc),
            unique_id=unique_id,
        )
    return VoxCPM


def _load_voxcpm2(model_name: str, device: str, unique_id: Any = None):
    VoxCPM = _ensure_voxcpm_runtime(unique_id)
    selected_name = str(model_name or "").strip()
    if not selected_name or selected_name == "自动":
        selected_name = "VoxCPM2"
    model_path = _models_root("TTS") / Path(selected_name).name
    if not model_path.is_dir():
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[{
                "label": "VoxCPM2 模型目录",
                "subdir": "TTS",
                "filename": selected_name,
                "description": "请放到 models/TTS/VoxCPM2。",
            }],
            install_packages=[],
            description=f"未找到 VoxCPM2 模型目录：{model_path}",
            unique_id=unique_id,
            title="GJJ TTS 模型缺失",
        )
    device_arg = None if str(device or "auto") == "auto" else str(device)
    cache_key = f"voxcpm2:{model_path}:{device_arg or 'auto'}"
    if cache_key not in _MODEL_CACHE:
        _send_status(unique_id, "正在加载 VoxCPM2", 0.12)
        _MODEL_CACHE[cache_key] = VoxCPM.from_pretrained(
            str(model_path),
            load_denoiser=False,
            local_files_only=True,
            optimize=False,
            device=device_arg,
        )
    return _MODEL_CACHE[cache_key]


def _voxcpm2_control_text(custom_voice: str, emotion_prompt: str) -> str:
    parts = [str(custom_voice or "").strip(), str(emotion_prompt or "").strip()]
    return "，".join(part for part in parts if part)


def _voxcpm2_tts(
    model_name: str,
    text: str,
    reference: dict[str, Any] | None,
    reference_text: str,
    custom_voice: str,
    emotion_prompt: str,
    device: str,
    steps: int,
    guidance_strength: float,
    seed: int,
    unique_id: Any,
) -> dict[str, Any]:
    if not str(text or "").strip():
        raise RuntimeError("VoxCPM2 需要输入文本。")
    model = _load_voxcpm2(model_name, device, unique_id)
    prompt_path = ""
    if reference is not None and _valid_audio(reference.get("audio")):
        wav, sr = _audio_to_tensor(reference["audio"])
        prompt_path = _save_indextts_prompt_wav(wav, sr)
    control = _voxcpm2_control_text(custom_voice, emotion_prompt)
    control = re.sub(r"[()（）]", "", control).strip()
    final_text = f"({control}){str(text or '').strip()}" if control else str(text or "").strip()
    kwargs: dict[str, Any] = {
        "text": final_text,
        "reference_wav_path": prompt_path or None,
        "cfg_value": float(guidance_strength),
        "inference_timesteps": int(max(1, steps)),
        "normalize": False,
        "denoise": False,
        "seed": int(seed),
    }
    wav = model.generate(**kwargs)
    if isinstance(wav, torch.Tensor):
        tensor = wav.detach().cpu().float()
    else:
        tensor = torch.as_tensor(np.asarray(wav, dtype=np.float32), dtype=torch.float32)
    sample_rate = int(getattr(getattr(model, "tts_model", None), "sample_rate", DEFAULT_SAMPLE_RATE) or DEFAULT_SAMPLE_RATE)
    return _comfy_audio(tensor.reshape(1, 1, -1), sample_rate)


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
    err = RuntimeError(report.get("panel_message") or report.get("warning_message"))
    setattr(err, "gjj_report", report)
    raise err


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


def _terms_path() -> Path:
    return Path(__file__).resolve().parents[1] / "presets" / "gjj_universal_tts_terms.tsv"


def _read_terms_text() -> str:
    path = _terms_path()
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# 原术语\t替换读法\n", encoding="utf-8")
    return path.read_text(encoding="utf-8")


def _write_terms_text(text: str) -> None:
    path = _terms_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(text or ""), encoding="utf-8", newline="")


def _read_terms() -> list[tuple[str, str]]:
    terms: list[tuple[str, str]] = []
    for raw_line in _read_terms_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = raw_line.split("\t", 1)
        if len(parts) != 2:
            continue
        source = parts[0].strip()
        target = parts[1].strip()
        if source and target:
            terms.append((source, target))
    terms.sort(key=lambda item: len(item[0]), reverse=True)
    return terms


def _apply_terms(text: str) -> str:
    result = str(text or "")
    for source, target in _read_terms():
        result = result.replace(source, target)
    return result


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

    @server.routes.get("/gjj/universal_tts/audio_library")
    async def audio_library(request):
        return web.json_response({"ok": True, "root": str(_models_mp3_root()), "items": _models_mp3_items()})

    @server.routes.get("/gjj/universal_tts/terms")
    async def terms_get(request):
        return web.json_response({"ok": True, "path": str(_terms_path()), "text": _read_terms_text()})

    @server.routes.post("/gjj/universal_tts/terms")
    async def terms_post(request):
        try:
            data = await request.json()
            _write_terms_text(str(data.get("text") or ""))
            return web.json_response({"ok": True, "path": str(_terms_path())})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

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


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "开", "是"}:
        return True
    if text in {"0", "false", "no", "off", "关", "否"}:
        return False
    return bool(default)


def _coerce_optional_prompt(value: Any) -> str:
    text = str(value or "").strip()
    if text.lower() in {"0", "false", "no", "none", "null", "off", "关", "否", "无", "空"}:
        return ""
    return text


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
        model_tree=[],
        usage=[
            "文本支持 [speaker_1]: 这样的说话人标签；未标记文本会按句自动分队列。",
            "参考音频输入口由前端自动扩展/收缩，后端最多接收 10 路；参考文本由本地 Qwen3-ASR 自动识别。",
        ],
        notice="模型树展示所有 UniversalTTS 分支用到的本地模型；EdgeTTS 分支不需要本地模型。",
        extra={
            "title": NODE_DISPLAY_NAME,
            "model_tree_text": universal_tts_model_tree_text(),
            "static_model_tree_only": True,
            "model_tree_priority": "static",
        },
    )
    GJJ_UI = {
        "dynamic_reference_pairs": True,
        "branch_presets_path": "presets/gjj_user_settings.json",
        "toolbar": ["📂", "🧠", "💱", "🔗", "🎲", "📢", "👨‍🎨", "🔌", "⚙️", "🎤", "🔄"],
        "hidden_parameters": ["model_name", "local_audio_name", "custom_voice", "language", "device", "precision", "steps", "guidance_strength", "qwen_max_new_tokens", "qwen_top_p", "qwen_top_k", "qwen_temperature", "qwen_repetition_penalty", "qwen_x_vector_only", "emotion_prompt", "audio_format", "qwen_instruct"],
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
                "local_audio_name": (audio_choices, _hidden_widget({"default": default_audio, "display_name": "本地参考音频", "tooltip": "由顶部 📢 按钮选择 models/GJJ/wav 及其子目录中的 .wav / .mp3 音频。"})),
                "edge_voice": (list(VOICE_IDS.keys()), _hidden_widget({"default": "[中文] zh-CN Xiaoxiao 女声", "display_name": "Edge音色"})),
                "custom_voice": ("STRING", _hidden_widget({"multiline": False, "default": "", "display_name": "自定义音色", "tooltip": "EdgeTTS 可直接填 voice id，优先于 Edge 音色下拉。"})),
                "speed": ("STRING", _hidden_widget({"multiline": False, "default": "1.0", "display_name": "语速"})),
                "pitch": ("STRING", _hidden_widget({"multiline": False, "default": "0", "display_name": "音调"})),
                "language": (["auto", "zh", "en", "ja", "ko"], _hidden_widget({"default": "auto", "display_name": "语言提示"})),
                "device": (["auto", "cuda", "cpu", "mps"], _hidden_widget({"default": "auto", "display_name": "运行设备"})),
                "precision": (["auto", "fp32", "fp16", "bf16"], _hidden_widget({"default": "auto", "display_name": "计算精度"})),
                "steps": ("STRING", _hidden_widget({"multiline": False, "default": "16", "display_name": "采样步数"})),
                "guidance_strength": ("STRING", _hidden_widget({"multiline": False, "default": "4.0", "display_name": "引导强度"})),
                "pause_after_speaker": ("STRING", _hidden_widget({"multiline": False, "default": "0.4", "display_name": "说话间隔秒数"})),
                "seed": ("STRING", _hidden_widget({"multiline": False, "default": "42", "display_name": "随机种子"})),
                "audio_output_mode": (AUDIO_OUTPUT_MODES, _hidden_widget({"default": "整体合并", "display_name": "音频输出"})),
                "timeline_format": (TEXT_FORMATS, _hidden_widget({"default": "SRT", "display_name": "文本输出"})),
                "mp3_filename_prefix": ("STRING", _hidden_widget({"multiline": False, "default": "audio/GJJ_UniversalTTS", "display_name": "音频文件名前缀", "tooltip": "支持变量：{分支}、{模型}、{种子}、{日期}、{时间}，例如 GJJ/{分支}。"})),
                "mp3_quality": (MP3_QUALITY_OPTIONS, _hidden_widget({"default": "320k", "display_name": "MP3质量"})),
                "fail_mode": (["报错", "静音占位"], _hidden_widget({"default": "报错", "display_name": "失败处理"})),
                "segment_min_chars": ("STRING", _hidden_widget({"multiline": False, "default": "12", "display_name": "最短分段字数"})),
                "segment_max_chars": ("STRING", _hidden_widget({"multiline": False, "default": "80", "display_name": "最长分段字数"})),
                "local_audio_order_json": ("STRING", _hidden_widget({"multiline": False, "default": "[]", "display_name": "本地参考语音表"})),
                "edge_speaker_voices_json": ("STRING", _hidden_widget({"multiline": False, "default": "{}", "display_name": "Edge说话人音色表", "tooltip": "EdgeTTS 多说话人音色映射；由前端面板自动维护。"})),
                "tts_voice_orders_json": ("STRING", _hidden_widget({"multiline": False, "default": "{}", "display_name": "TTS分支音色表", "tooltip": "按生成分支保存排序后的 TTS 音色队列；由前端面板自动维护。"})),
                "qwen_max_new_tokens": ("STRING", _hidden_widget({"multiline": False, "default": "2048", "display_name": "Qwen最大Token"})),
                "qwen_top_p": ("STRING", _hidden_widget({"multiline": False, "default": "0.8", "display_name": "Qwen Top-P"})),
                "qwen_top_k": ("STRING", _hidden_widget({"multiline": False, "default": "20", "display_name": "Qwen Top-K"})),
                "qwen_temperature": ("STRING", _hidden_widget({"multiline": False, "default": "1.0", "display_name": "Qwen温度"})),
                "qwen_repetition_penalty": ("STRING", _hidden_widget({"multiline": False, "default": "1.05", "display_name": "Qwen重复惩罚"})),
                "qwen_x_vector_only": ("BOOLEAN", _hidden_widget({"default": False, "display_name": "Qwen仅音色向量"})),
                "emotion_prompt": ("STRING", _hidden_widget({"multiline": True, "default": "", "display_name": "情感描述", "tooltip": "IndexTTS2 / VoxCPM2 的情感或风格描述；留空表示不额外控制。"})),
                "audio_format": (AUDIO_FORMAT_OPTIONS, _hidden_widget({"default": "WAV", "display_name": "音频格式", "tooltip": "选择生成音频和分段预览的保存格式；默认 WAV。"})),
                "qwen_instruct": ("STRING", _hidden_widget({"multiline": True, "default": "", "display_name": "Instruct", "tooltip": "Qwen3-VoiceDesign 的自然语言音色设计指令，例如：年轻温柔的女声，语速稍慢，带开心情绪。"})),
            },
            "optional": _build_reference_inputs(),
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

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
        qwen_max_new_tokens: int,
        qwen_top_p: float,
        qwen_top_k: int,
        qwen_temperature: float,
        qwen_repetition_penalty: float,
        qwen_x_vector_only: bool,
        emotion_prompt: str,
        qwen_instruct: str,
        seed: int,
        unique_id: Any,
    ) -> dict[str, Any]:
        if branch == "EdgeTTS":
            voice_id = str(custom_voice or "").strip() or _edge_voice_id(str(edge_voice), "[中文] zh-CN Xiaoxiao 女声")
            return _edge_tts(text, voice_id, speed, pitch, 45.0)
        if branch == "FishAudioS2":
            return _fish_tts(model_name, text, reference, str((reference or {}).get("text") or DEFAULT_REFERENCE_TEXT), language, device, precision, seed, unique_id)
        if branch in {"LongCat-1B", "LongCat3.5B"}:
            try:
                return _longcat_tts(branch, model_name, text, reference, str((reference or {}).get("text") or DEFAULT_REFERENCE_TEXT), device, precision, steps, guidance_strength, seed, unique_id)
            except Exception as exc:
                if get_report_from_exception(exc):
                    raise
                if _is_longcat_architecture_error(exc):
                    _raise_longcat_architecture_error(unique_id)
                if _is_longcat_quantization_mismatch_error(exc):
                    _raise_longcat_quantization_error(model_name, unique_id)
                raise
        if branch in {"Qwen3-CustomVoice", "Qwen3-VoiceDesign", "Qwen3-VoiceClone"}:
            return _qwen3_tts(
                branch,
                model_name,
                text,
                reference,
                str((reference or {}).get("text") or DEFAULT_REFERENCE_TEXT),
                custom_voice,
                language,
                device,
                precision,
                seed,
                qwen_max_new_tokens,
                qwen_top_p,
                qwen_top_k,
                qwen_temperature,
                qwen_repetition_penalty,
                qwen_x_vector_only,
                emotion_prompt,
                qwen_instruct,
                unique_id,
            )
        if branch in {"IndexTTS-v1.5", "IndexTTS-v1.0", "IndexTTS-v2"}:
            return _indextts_audio(branch, text, reference, device, precision, emotion_prompt if branch == "IndexTTS-v2" else "", unique_id)
        if branch == "Fun-CosyVoice3-0.5B-2512":
            return _cosyvoice_tts(branch, model_name, text, reference, str((reference or {}).get("text") or DEFAULT_REFERENCE_TEXT), speed, seed, unique_id)
        if branch == "VoxCPM2":
            return _voxcpm2_tts(
                model_name,
                text,
                reference,
                str((reference or {}).get("text") or DEFAULT_REFERENCE_TEXT),
                custom_voice,
                emotion_prompt,
                device,
                steps,
                guidance_strength,
                seed,
                unique_id,
            )
        _unsupported_public_adapter(branch, model_name, unique_id)
        raise RuntimeError(f"{branch} 分支未生成音频。")

    def _cache_external_reference_voice(
        self,
        branch: str,
        model_name: str,
        references: list[dict[str, Any]],
        default_reference_text: str,
        edge_voice: str,
        custom_voice: str,
        speed: float,
        pitch: int,
        language: str,
        device: str,
        precision: str,
        steps: int,
        guidance_strength: float,
        qwen_max_new_tokens: int,
        qwen_top_p: float,
        qwen_top_k: int,
        qwen_temperature: float,
        qwen_repetition_penalty: float,
        qwen_x_vector_only: bool,
        emotion_prompt: str,
        qwen_instruct: str,
        seed: int,
        unique_id: Any,
    ) -> list[str]:
        if branch.startswith("IndexTTS") or branch in {"Fun-CosyVoice3-0.5B-2512", "VoxCPM2"}:
            return []
        text = str(default_reference_text or DEFAULT_REFERENCE_TEXT).strip()
        external_refs = [ref for ref in references if str(ref.get("source") or "") == "input" and _valid_audio(ref.get("audio"))]
        if not text or not external_refs:
            return []
        saved: list[str] = []
        for index, ref in enumerate(external_refs[:MAX_REFERENCES]):
            try:
                speaker = int(ref.get("speaker") or index)
                turn_edge_voice = _edge_voice_for_speaker(speaker, edge_voice, {}) if branch == "EdgeTTS" else edge_voice
                _send_status(unique_id, f"正在缓存外部参考音频 {index + 1}/{len(external_refs)}", 0.05)
                audio = self._synthesize_one(
                    branch,
                    model_name,
                    text,
                    ref,
                    turn_edge_voice,
                    custom_voice,
                    speed,
                    pitch,
                    language,
                    device,
                    precision,
                    steps,
                    guidance_strength,
                    qwen_max_new_tokens,
                    qwen_top_p,
                    qwen_top_k,
                    qwen_temperature,
                    qwen_repetition_penalty,
                    qwen_x_vector_only,
                    emotion_prompt,
                    qwen_instruct,
                    int(seed) + 10000 + index,
                    unique_id,
                )
                stem = _audio_stem(f"{branch}_参考音频{index + 1}")
                rel = _save_audio_to_models_mp3(audio, f"GJJ_UniversalTTS_{stem}.wav")
                saved.append(rel)
            except Exception as exc:
                _send_status(unique_id, f"外部参考音频缓存失败：{exc}", 0.05)
        if saved:
            _send_status(unique_id, f"已缓存外部参考语音到 models\\GJJ\\wav：{saved[0]}", 0.06)
        return saved

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
        pause_after_speaker: float = 0.4,
        seed: int = 42,
        audio_output_mode: str = "整体合并",
        timeline_format: str = "SRT",
        mp3_filename_prefix: str = "audio/GJJ_UniversalTTS",
        mp3_quality: str = "320k",
        fail_mode: str = "报错",
        segment_min_chars: int = 12,
        segment_max_chars: int = 80,
        local_audio_order_json: str = "[]",
        edge_speaker_voices_json: str = "{}",
        tts_voice_orders_json: str = "{}",
        qwen_max_new_tokens: int = 2048,
        qwen_top_p: float = 0.8,
        qwen_top_k: int = 20,
        qwen_temperature: float = 1.0,
        qwen_repetition_penalty: float = 1.05,
        qwen_x_vector_only: bool = False,
        emotion_prompt: str = "",
        audio_format: str = "WAV",
        qwen_instruct: str = "",
        unique_id: Any = None,
        extra_pnginfo: dict[str, Any] | None = None,
        **kwargs,
    ):
        props = _read_bool_props(extra_pnginfo, unique_id)
        keep_model = bool(kwargs.get("keep_model_loaded", props.get("keep_model_loaded", True)))
        random_seed = bool(kwargs.get("random_seed", props.get("random_seed", False)))
        local_audio_order = props.get("local_audio_order", [])
        if not local_audio_order:
            try:
                parsed_order = json.loads(str(local_audio_order_json or "[]"))
                if isinstance(parsed_order, list):
                    local_audio_order = parsed_order
            except Exception:
                local_audio_order = []
        selected_branch = str(branch or _read_saved_branch() or BRANCHES[0])
        if selected_branch not in BRANCHES:
            selected_branch = BRANCHES[0]
        default_reference_text = str(default_reference_text or DEFAULT_REFERENCE_TEXT).strip()
        if default_reference_text == LEGACY_DEFAULT_REFERENCE_TEXT:
            default_reference_text = DEFAULT_REFERENCE_TEXT
        text = str(text if text is not None else "").strip()
        text = _apply_terms(text)
        edge_voice = _coerce_choice(edge_voice, list(VOICE_IDS.keys()), "[中文] zh-CN Xiaoxiao 女声")
        edge_speaker_voices = _parse_tts_speaker_voices(tts_voice_orders_json, selected_branch, edge_speaker_voices_json)
        language = _coerce_choice(language, ["auto", "zh", "en", "ja", "ko"], "auto")
        device = _coerce_choice(device, ["auto", "cuda", "cpu", "mps"], "auto")
        precision = _coerce_choice(precision, ["auto", "fp32", "fp16", "bf16"], "auto")
        speed = _coerce_float(speed, 1.0, 0.5, 2.0)
        pitch = _coerce_int(pitch, 0, -20, 20)
        steps = _coerce_int(steps, 16, 1, 128)
        guidance_strength = _coerce_float(guidance_strength, 4.0, 0.0, 20.0)
        raw_pause_after_speaker = _coerce_float(pause_after_speaker, 0.4, 0.0, 999.0)
        pause_after_speaker = 0.4 if raw_pause_after_speaker > 0.8 else raw_pause_after_speaker
        seed = _coerce_int(seed, 42, 0, 0x7FFFFFFF)
        audio_output_mode = _coerce_choice(audio_output_mode, AUDIO_OUTPUT_MODES, "整体合并")
        timeline_format = _coerce_choice(timeline_format, TEXT_FORMATS, "SRT")
        mp3_quality = _coerce_choice(mp3_quality, MP3_QUALITY_OPTIONS, "320k")
        audio_format = _coerce_choice(audio_format, AUDIO_FORMAT_OPTIONS, "WAV")
        mp3_filename_prefix = _expand_mp3_filename_prefix(
            mp3_filename_prefix,
            branch=selected_branch,
            model_name=model_name,
            seed=seed,
        )
        fail_mode = _coerce_choice(fail_mode, ["报错", "静音占位"], "报错")
        segment_min_chars = _coerce_int(segment_min_chars, 12, 0, 200)
        segment_max_chars = _coerce_int(segment_max_chars, 80, 8, 500)
        qwen_max_new_tokens = _coerce_int(qwen_max_new_tokens, 2048, 512, 8192)
        qwen_top_p = _coerce_float(qwen_top_p, 0.8, 0.0, 1.0)
        qwen_top_k = _coerce_int(qwen_top_k, 20, 0, 100)
        qwen_temperature = _coerce_float(qwen_temperature, 1.0, 0.1, 2.0)
        qwen_repetition_penalty = _coerce_float(qwen_repetition_penalty, 1.05, 1.0, 2.0)
        qwen_x_vector_only = _coerce_bool(qwen_x_vector_only, False)
        emotion_prompt = _coerce_optional_prompt(emotion_prompt)
        qwen_instruct = str(qwen_instruct or "").strip()
        qwen_old_default = (2048, 0.8, 20, 1.0, 1.05, False)
        qwen_current = (
            qwen_max_new_tokens,
            qwen_top_p,
            qwen_top_k,
            qwen_temperature,
            qwen_repetition_penalty,
            qwen_x_vector_only,
        )
        qwen_preset = QWEN_GENERATION_PRESETS.get(selected_branch)
        if qwen_preset and selected_branch != "Qwen3-VoiceClone" and qwen_current == qwen_old_default:
            qwen_max_new_tokens = int(qwen_preset["max_new_tokens"])
            qwen_top_p = float(qwen_preset["top_p"])
            qwen_top_k = int(qwen_preset["top_k"])
            qwen_temperature = float(qwen_preset["temperature"])
            qwen_repetition_penalty = float(qwen_preset["repetition_penalty"])
            qwen_x_vector_only = bool(qwen_preset["x_vector_only"])
        if segment_min_chars > segment_max_chars:
            segment_min_chars = segment_max_chars
        if str(model_name or "") == "自动":
            choices = _branch_model_choices(selected_branch)
            model_name = choices[0] if choices else ""

        started = time.perf_counter()
        try:
            _send_status(unique_id, "正在解析文本", 0.03)
            turns = _parse_turns(text, segment_min_chars, segment_max_chars)
            if not turns:
                raise RuntimeError("合成文本不能为空。")
            references = _collect_references(kwargs, local_audio_name, local_audio_order) if selected_branch in REFERENCE_REQUIRED_BRANCHES or selected_branch == "VoxCPM2" else []
            if selected_branch in REFERENCE_REQUIRED_BRANCHES and not references:
                raise RuntimeError(f"当前分支需要参考音频，但没有找到可用音频。请连接参考音频，或把音频放到：{_models_mp3_root()}")
            if selected_branch in REFERENCE_TEXT_ASR_BRANCHES:
                _recognize_reference_texts(references, unique_id)

            report = _build_branch_report(selected_branch, model_name)
            if report.get("notice_level") == "error":
                raise_dependency_model_error(
                    node_name=NODE_DISPLAY_NAME,
                    missing_dependencies=report.get("missing_dependencies", []),
                    missing_models=report.get("missing_models", []),
                    install_packages=[item.get("package_name") for item in report.get("missing_dependencies", [])],
                    description=report.get("panel_message", ""),
                    unique_id=unique_id,
                    copy_text=report.get("copy_text", ""),
                    copy_label=report.get("copy_label", ""),
                    model_download_url=report.get("model_download_url", ""),
                )

            self._cache_external_reference_voice(
                selected_branch,
                model_name,
                references,
                default_reference_text,
                edge_voice,
                custom_voice,
                speed,
                pitch,
                language,
                device,
                precision,
                steps,
                guidance_strength,
                qwen_max_new_tokens,
                qwen_top_p,
                qwen_top_k,
                qwen_temperature,
                qwen_repetition_penalty,
                qwen_x_vector_only,
                emotion_prompt,
                qwen_instruct,
                seed,
                unique_id,
            )

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
                ref = _reference_for_speaker(references, speaker)
                turn_edge_voice = _edge_voice_for_speaker(speaker, edge_voice, edge_speaker_voices) if selected_branch == "EdgeTTS" else edge_voice
                turn_custom_voice = custom_voice
                if selected_branch == "EdgeTTS" and edge_speaker_voices:
                    turn_custom_voice = ""
                elif selected_branch in {"Qwen3-CustomVoice", "Qwen3-VoiceDesign"} and edge_speaker_voices:
                    turn_custom_voice = _edge_voice_for_speaker(speaker, custom_voice, edge_speaker_voices)
                _send_status(unique_id, f"正在合成 {index + 1}/{len(turns)}：speaker_{speaker + 1}", 0.08 + 0.82 * ((index + 1) / len(turns)))
                audio = self._synthesize_one(
                    selected_branch,
                    model_name,
                    line,
                    ref,
                    turn_edge_voice,
                    turn_custom_voice,
                    speed,
                    pitch,
                    language,
                    device,
                    precision,
                    steps,
                    guidance_strength,
                    qwen_max_new_tokens,
                    qwen_top_p,
                    qwen_top_k,
                    qwen_temperature,
                    qwen_repetition_penalty,
                    qwen_x_vector_only,
                    emotion_prompt,
                    qwen_instruct,
                    actual_seed,
                    unique_id,
                )
                audio_items.append(audio)
                if len(turns) > 1:
                    try:
                        preview_ui = _save_audio_ui(
                            audio,
                            f"{mp3_filename_prefix}_segment_{index + 1:03d}",
                            audio_format,
                            mp3_quality,
                        )
                        _send_audio_preview(
                            unique_id,
                            preview_ui,
                            f"已生成片段 {index + 1}/{len(turns)}：speaker_{speaker + 1}",
                            True,
                        )
                    except Exception as preview_exc:
                        _send_status(unique_id, f"片段 {index + 1} 预览保存失败：{preview_exc}", 0.08 + 0.82 * ((index + 1) / len(turns)))
                wav, sr = _audio_to_tensor(audio)
                duration = float(wav.shape[-1]) / float(sr)
                start = cursor
                end = cursor + duration
                timeline.append({
                    "index": index + 1,
                    "speaker": speaker + 1,
                    "speaker_label": str(turn.get("speaker_label") or f"说话人{speaker + 1}").strip(),
                    "start": start,
                    "end": end,
                    "text": line,
                })
                cursor = end + (float(pause_after_speaker) if index < len(turns) - 1 else 0.0)
                if pbar:
                    pbar.update_absolute(index + 1, len(turns))

            if len(audio_items) == 1:
                _send_status(unique_id, "单段语音直接输出", 0.94)
                merged = audio_items[0]
            else:
                _send_status(unique_id, f"正在拼接 {len(audio_items)} 段语音", 0.94)
                merged = _concat_audio(audio_items, float(pause_after_speaker))
            timeline_text = _format_timeline(timeline, timeline_format)
            _send_status(unique_id, f"正在保存 {audio_format} 预览", 0.97)
            audio_ui = _save_audio_ui(merged, mp3_filename_prefix, audio_format, mp3_quality)
            _send_audio_preview(unique_id, audio_ui, "完成，音频已保存", False)
            elapsed = time.perf_counter() - started
            _send_status(unique_id, f"完成：{len(turns)} 段，耗时 {elapsed:.2f} 秒", 1.0)
            if not keep_model:
                _MODEL_CACHE.clear()
            return {"ui": audio_ui, "result": (merged, timeline_text)}
        except Exception as exc:
            report = get_report_from_exception(exc)
            if not report:
                report = build_report_from_exception(
                    exc,
                    NODE_DISPLAY_NAME,
                    dependency_specs=BRANCH_DEPENDENCIES.get(selected_branch, []),
                    description=f"{selected_branch} 分支运行时导入失败；请按面板提示补齐依赖后重启 ComfyUI。",
                    model_download_url=BRANCH_MODEL_DOWNLOAD_URLS.get(selected_branch),
                )
            if report:
                send_dependency_model_notice(report, unique_id=unique_id)
                _send_status(unique_id, report.get("warning_message") or f"执行失败：{exc}", 1.0)
                raise
            _send_status(unique_id, f"执行失败：{exc}", 1.0)
            if fail_mode == "静音占位":
                empty = _comfy_audio(_silence(DEFAULT_SAMPLE_RATE, 0.25), DEFAULT_SAMPLE_RATE)
                return (empty, "")
            raise


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_UniversalTTS}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: f"GJJ·{NODE_DISPLAY_NAME}"}
