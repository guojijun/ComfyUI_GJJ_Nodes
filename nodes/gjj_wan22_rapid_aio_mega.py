from __future__ import annotations

from fractions import Fraction
import json
import shutil
import re
from pathlib import Path
from typing import Any

import comfy.model_management
import comfy.model_sampling
import comfy.sd
import comfy.utils
import comfy.clip_vision
import folder_paths
import torch
import torch.nn.functional as F
from comfy_api.latest import InputImpl, Types
from nodes import CheckpointLoaderSimple, CLIPTextEncode, CLIPVisionEncode, VAEDecode, common_ksampler

try:
    from aiohttp import web
    from server import PromptServer
except Exception:
    web = None
    PromptServer = None

from .common_utils.model_loader import gjjutils_load_clip_from_names, gjjutils_load_model, gjjutils_load_vae
from .common_utils.model_manager import gjjutils_model_stem_without_quant, gjjutils_resolve_model_name
from .common_utils.temp_files import gjjutils_temp_path, gjjutils_write_temp_file
from .common_utils.dependency_checker import (
    build_dependency_model_report,
    print_dependency_model_report,
    send_dependency_model_notice,
)
from .gjj_multi_image_loader import load_image_tensor, parse_selected_images, resolve_selected_image_path
from .gjj_multi_lora_chain import apply_lora_chain_config, normalize_lora_chain_data
from .gjj_wan_unified_video_conditioning import GJJ_WanUnifiedVideoConditioning
from .gjj_mmaudio_nsfw_single import (
    _mmaudio_clip_models,
    _mmaudio_main_models,
    _mmaudio_models,
    _mmaudio_synchformer_models,
    _mmaudio_vae_models,
    _prefer_main_model,
    _prefer_model,
)
from .gjj_video_combine_runtime import DEFAULT_FORMAT as DEFAULT_VIDEO_FORMAT
from .gjj_video_combine_runtime import DEFAULT_FRAME_RATE, _probe_video_file, combine_video, list_supported_formats


NODE_NAME = "GJJ_Wan22RapidAIOMega"
DEFAULT_CHECKPOINT = "wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors"
DEFAULT_POSITIVE = (
    "一个全身古装的中国美女"
)
DEFAULT_NEGATIVE = ""
DEFAULT_SHIFT = 8.0
DEFAULT_STEPS = 4
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "ipndm"
DEFAULT_SCHEDULER = "beta"
DEFAULT_DENOISE = 1.0
DEFAULT_WIDTH = 768
DEFAULT_HEIGHT = 768
DEFAULT_SEGMENT_FRAMES = 65
DEFAULT_EMPTY_FRAME_LEVEL = 0.5
SIZE_ALIGNMENT = 32
IMAGE_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
IMAGE_FIT_MODES = ("拉伸", "补边", "留边", "裁剪")
CROP_POSITIONS = ("上", "下", "左", "右", "中")
DEFAULT_VIDEO_PREFIX = "GJJ/Wan22RapidAIOMega"
DEFAULT_AUDIO_PROMPT = "强烈、有节奏的动作音效，贴近画面的 Foley 声音"
DEFAULT_AUDIO_NEGATIVE = "音乐，唱歌，说话，对话，男声，背景噪声，干燥声音，安静，平静"
GGUF_DEFAULT_CLIP = "umt5-xxl-encoder-Q4_K_M.gguf"
DEFAULT_WAN_CLIP = "umt5_xxl_int4_convrot.safetensors"
GGUF_DEFAULT_VAE = "wan_2.1_vae.safetensors"
DEFAULT_HIGH_LORA = "wan/Wan2.2_I2V_LightX2V_2step_high_noise.safetensors"
DEFAULT_LOW_LORA = "wan/Wan2.2_I2V_LightX2V_2step_low_noise.safetensors"
DEFAULT_CLIP_VISION = "clip_vision_h.safetensors"
DEFAULT_TRANSITION_LORA = "wan/Wan2.2-ST_I2V2.2_high_34-无缝转场，丝滑转场.safetensors"
DEFAULT_WORKFLOW_HIGH_MODEL = "diffusion_models/DasiwaWAN22I2V14BTruevision_boundbiteHighV10_int4_convrot.safetensors"
DEFAULT_WORKFLOW_LOW_MODEL = "diffusion_models/DasiwaWAN22I2V14BTruevision_boundbiteLowV10_int4_convrot.safetensors"
GGUF_PACKAGE_SPEC = "gguf>=0.13.0"
RAPID_AIO_SEARCH_SEED = "wan2.2-rapid-mega-aio"
# 这些是“视频通用模型加载器”里已经提供给用户的 Wan2.2 预设族。
# Rapid 节点只有一个主模型槽，因此这里负责发现单个可加载的主模型文件；
# high/low、精度和量化后缀不参与预设族判断。
WAN22_COMPATIBLE_MODEL_KEYWORDS = (
    ("wan2.2", "rapid"),
    ("wan22", "rapid"),
    ("wan2.2", "i2v"),
    ("wan22", "i2v"),
    ("wan2.2", "is2v"),
    ("wan22", "is2v"),
    ("wan", "is2v"),
    ("remix", "i2v"),
    ("smooth", "mix"),
    ("smoothmix",),
    ("dasiwa", "wan"),
    ("dasiwa", "i2v"),
)
WAN22_RAPID_AIO_MODEL_DOWNLOAD_URL = "https://huggingface.co/Phr00t/WAN2.2-14B-Rapid-AllInOne"
WAN22_RAPID_AIO_MODEL_TREE = [
    {
        "label": "Wan Rapid AllInOne checkpoint",
        "folder": "checkpoints",
        "filename": "wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors",
        "value": "wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors",
        "kind": "checkpoint",
        "icon": "🎬",
        "description": "推荐的 AIO 单文件 safetensors。它自带生成视频需要的 MODEL / CLIP / VAE，节点会直接按 checkpoint 加载，不需要额外选择 Wan CLIP 和 Wan VAE。",
    },
    {
        "label": "Wan Rapid AllInOne 分体主模型 GGUF",
        "folder": "diffusion_models",
        "filename": "wan2.2-rapid-mega-aio-nsfw-v12.2-Q4_K.gguf",
        "value": "diffusion_models/wan2.2-rapid-mega-aio-nsfw-v12.2-Q4_K.gguf",
        "kind": "unet_gguf",
        "icon": "🟢",
        "description": "低显存主扩散模型。选择 .gguf 或 diffusion_models 下的主模型时，节点会走 GJJ 内置 GGUF UNET 加载器；建议 Q4_K / Q4_K_M 或更高量化。Q2_K 对该 Wan 视频模型容易花屏，节点会阻止执行。",
    },
    {
        "label": "Wan Rapid AllInOne 分体主模型 safetensors",
        "folder": "diffusion_models",
        "filename": "wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors",
        "value": "diffusion_models/wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors",
        "kind": "unet",
        "icon": "🔵",
        "description": "分体 UNET 主模型。只包含视频扩散网络，不自带文本编码器和 VAE；需要同时选择 Wan CLIP 与 Wan VAE。",
    },
    {
        "label": "Wan GGUF CLIP / T5 文本编码器",
        "folder": "clip_gguf",
        "filename": DEFAULT_WAN_CLIP,
        "value": DEFAULT_WAN_CLIP,
        "kind": "clip",
        "icon": "🧠",
        "description": "分体主模型使用的 Wan 文本编码器，工作流中等价于 CLIPLoaderGGUF(type=wan)。负责把正向/反向提示词编码为 Wan 条件。",
    },
    {
        "label": "Wan VAE",
        "folder": "vae",
        "filename": GGUF_DEFAULT_VAE,
        "value": GGUF_DEFAULT_VAE,
        "kind": "vae",
        "icon": "📦",
        "description": "分体主模型使用的视频 VAE，负责把 latent 解码成视频帧，也用于首尾图/VACE 条件编码。checkpoint AIO 自带 VAE 时不需要这一项。",
    },
    {
        "label": "MMAudio 主模型",
        "folder": "mmaudio",
        "filename": "mmaudio_large_44k_v2.pth / mmaudio_large_44k_v2_fp16.safetensors",
        "value": "mmaudio_large_44k_v2.pth",
        "kind": "audio_model",
        "icon": "📢",
        "description": "配音主生成模型。开启 📢 配音后，它根据视频画面、配音提示词和同步特征生成 44.1kHz 音频。",
    },
    {
        "label": "MMAudio VAE",
        "folder": "mmaudio",
        "filename": "mmaudio_vae_44k_fp16.safetensors",
        "value": "mmaudio_vae_44k_fp16.safetensors",
        "kind": "audio_vae",
        "icon": "🎚️",
        "description": "MMAudio 的音频 VAE。负责音频 latent 与波形之间的转换，是配音链路必需模型。",
    },
    {
        "label": "MMAudio Synchformer",
        "folder": "mmaudio",
        "filename": "mmaudio_synchformer_fp16.safetensors",
        "value": "mmaudio_synchformer_fp16.safetensors",
        "kind": "audio_sync",
        "icon": "🎞️",
        "description": "视频同步特征模型。负责从画面节奏、运动和时序中提取配音参考特征，让音效更贴近视频动作。",
    },
    {
        "label": "MMAudio CLIP / DFN 条件模型",
        "folder": "mmaudio",
        "filename": "apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors",
        "value": "apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors",
        "kind": "audio_clip",
        "icon": "🧩",
        "description": "配音条件模型。用于理解配音提示词和视觉语义；没有 open_clip 或模型不可用时，配音条件能力会下降。",
    },
    {
        "label": "可选 LoRA",
        "folder": "loras",
        "filename": "按 LoraChainConfig 选择",
        "value": "LoraChainConfig",
        "kind": "lora",
        "icon": "🧵",
        "required": False,
        "description": "可选风格/动作/角色增强模型。通过 LoRA 串联配置输入接入，节点会在加载 Wan 模型与 CLIP 后按配置顺序应用。",
    },
]
WAN22_RAPID_AIO_MODEL_TREE_TEXT = """models/
├─ checkpoints/
│  └─ wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors
│     AIO 单文件，内含 MODEL / CLIP / VAE；最省心，推荐优先使用。
├─ diffusion_models/
│  ├─ wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors
│  │  分体 UNET 主模型；需要配套 Wan CLIP 与 Wan VAE。
│  └─ wan2.2-rapid-mega-aio-nsfw-v12.2-Q4_K.gguf
│     分体 GGUF 主模型；低显存，建议 Q4_K / Q4_K_M 或更高，Q2_K 容易花屏。
├─ text_encoders/
│  └─ umt5-xxl-encoder-Q4_K_M.gguf
│     Wan 文本编码器，等价 CLIPLoaderGGUF(type=wan)，用于正向/反向提示词。
├─ vae/
│  └─ wan_2.1_vae.safetensors
│     分体 Wan VAE，用于视频帧解码和 VACE 条件编码。
├─ mmaudio/
│  ├─ mmaudio_large_44k_v2.pth 或 mmaudio_large_44k_v2_fp16.safetensors
│  │  MMAudio 配音主模型。
│  ├─ mmaudio_vae_44k_fp16.safetensors
│  │  MMAudio 音频 VAE。
│  ├─ mmaudio_synchformer_fp16.safetensors
│  │  视频同步特征模型。
│  └─ apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors
│     配音 CLIP/DFN 条件模型。
└─ loras/
   └─ 可选 LoRA
      通过 LoRA 串联配置输入接入，用于风格、角色、动作或加速增强。"""


def _send_status(unique_id: Any, text: str, progress: float | None = None, extra: dict[str, Any] | None = None) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        if extra:
            payload.update(extra)
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _normalize_text(text: str) -> str:
    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _safe_filename_list(category: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(category))
    except Exception:
        return []


def _scan_model_folder_files(category: str, suffixes: set[str]) -> list[str]:
    names: list[str] = []
    try:
        roots = folder_paths.get_folder_paths(category)
    except Exception:
        roots = []
    for root in roots or []:
        root_path = Path(root)
        if not root_path.is_dir():
            continue
        for path in root_path.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in suffixes:
                continue
            try:
                names.append(path.relative_to(root_path).as_posix())
            except Exception:
                names.append(path.name)
    return names


def _find_model_file(category: str, name: str) -> str | None:
    try:
        path = folder_paths.get_full_path(category, name)
    except Exception:
        path = None
    if path:
        return path
    normalized = str(name or "").replace("\\", "/").lower()
    if not normalized:
        return None
    try:
        roots = folder_paths.get_folder_paths(category)
    except Exception:
        roots = []
    for root in roots or []:
        root_path = Path(root)
        candidate = root_path / str(name or "")
        if candidate.is_file():
            return str(candidate)
        for path in root_path.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(root_path).as_posix().lower()
            if rel == normalized or path.name.lower() == normalized:
                return str(path)
    return None


def _folder_entry_parts(entry: Any) -> tuple[Any, set[str], tuple[Any, ...]] | None:
    if not isinstance(entry, (list, tuple)) or len(entry) < 2:
        return None
    paths = entry[0]
    exts = set(entry[1] or set())
    return paths, exts, tuple(entry[2:])


def _folder_entry_with_exts(paths: Any, exts: set[str], extra: tuple[Any, ...] = ()) -> tuple[Any, ...]:
    return (paths, exts, *extra)


def _ensure_checkpoint_gguf_extension() -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    current = _folder_entry_parts(existing.get("checkpoints"))
    if not current:
        return
    paths, ext_set, extra = current
    if ".gguf" not in ext_set:
        existing["checkpoints"] = _folder_entry_with_exts(paths, ext_set | {".gguf"}, extra)


def _ensure_unet_gguf_folder() -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    paths: list[str] = []
    exts: set[str] = {".gguf"}
    current = _folder_entry_parts(existing.get("unet_gguf"))
    if current:
        current_paths, current_exts, _current_extra = current
        paths.extend(str(path) for path in current_paths or [])
        exts.update(current_exts or set())
    for source in ("diffusion_models", "unet", "checkpoints"):
        source_entry = _folder_entry_parts(existing.get(source))
        if not source_entry:
            continue
        source_paths, _source_exts, _source_extra = source_entry
        paths.extend(str(path) for path in source_paths or [])
    try:
        paths.append(str(Path(getattr(folder_paths, "models_dir", "")) / "unet_gguf"))
    except Exception:
        pass
    deduped = []
    seen: set[str] = set()
    for path in paths:
        key = str(path).replace("\\", "/").lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(path)
    existing["unet_gguf"] = _folder_entry_with_exts(deduped, exts | {".gguf"})


def _ensure_clip_gguf_folder() -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    paths: list[str] = []
    exts: set[str] = {".gguf"}
    current = _folder_entry_parts(existing.get("clip_gguf"))
    if current:
        current_paths, current_exts, _current_extra = current
        paths.extend(str(path) for path in current_paths or [])
        exts.update(current_exts or set())
    for source in ("text_encoders", "clip"):
        source_entry = _folder_entry_parts(existing.get(source))
        if not source_entry:
            continue
        source_paths, _source_exts, _source_extra = source_entry
        paths.extend(str(path) for path in source_paths or [])
    try:
        paths.append(str(Path(getattr(folder_paths, "models_dir", "")) / "clip_gguf"))
    except Exception:
        pass
    deduped = []
    seen: set[str] = set()
    for path in paths:
        key = str(path).replace("\\", "/").lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(path)
    existing["clip_gguf"] = _folder_entry_with_exts(deduped, exts | {".gguf"})


def _pick_available_name(preferred: str, available: list[str], fallback: str = "") -> str:
    preferred = str(preferred or "").strip()
    fallback = str(fallback or "").strip()
    if preferred and preferred in available:
        return preferred

    preferred_base = preferred.replace("\\", "/").split("/")[-1] if preferred else ""
    if preferred_base:
        for item in available:
            if item.replace("\\", "/").split("/")[-1].lower() == preferred_base.lower():
                return item

    normalized = _normalize_text(preferred)
    if normalized:
        for item in available:
            if normalized in _normalize_text(item):
                return item

    if fallback:
        return _pick_available_name(fallback, available, "")
    return available[0] if available else ""


def _split_model_selection(value: Any) -> tuple[str, str]:
    text = str(value or "").strip().replace("\\", "/")
    for category in ("checkpoints", "diffusion_models", "unet_gguf"):
        prefix = f"{category}/"
        if text.lower().startswith(prefix):
            return category, text[len(prefix):]
    return "", text


def _main_model_choice(category: str, name: str) -> str:
    clean = str(name or "").replace("\\", "/").strip()
    if not clean:
        return ""
    if category in {"diffusion_models", "unet_gguf"}:
        return f"diffusion_models/{clean}"
    return clean


def _is_compatible_wan22_main_model(name: str) -> bool:
    """Return whether a filename belongs to a supported Wan2.2 single-model preset.

    Normalising first deliberately makes names such as ``Wan2_2``, ``Wan2.2`` and
    ``Smooth-Mix`` equivalent.  Quantisation markers (int4/int8, Q4/Q8, fp8) are
    left unrestricted; file format is checked separately by the caller.
    """
    compact = _normalize_text(gjjutils_model_stem_without_quant(name))
    return any(all(_normalize_text(token) in compact for token in keywords) for keywords in WAN22_COMPATIBLE_MODEL_KEYWORDS)


def _is_int4_convrot(name: Any) -> bool:
    normalized = _normalize_text(str(name or ""))
    return "int4" in normalized and "convrot" in normalized


def _quantization_priority(name: Any) -> int:
    normalized = _normalize_text(str(name or ""))
    if "int4" in normalized and "convrot" in normalized:
        return 0
    if "int4" in normalized:
        return 1
    if "int8" in normalized:
        return 2
    return 3


def _list_rapid_checkpoints() -> list[str]:
    _ensure_checkpoint_gguf_extension()
    _ensure_unet_gguf_folder()
    sources = (
        ("checkpoints", _safe_filename_list("checkpoints") + _scan_model_folder_files("checkpoints", {".safetensors", ".gguf"})),
        ("diffusion_models", _safe_filename_list("diffusion_models") + _scan_model_folder_files("diffusion_models", {".safetensors", ".gguf"})),
        ("unet_gguf", _safe_filename_list("unet_gguf") + _scan_model_folder_files("unet_gguf", {".gguf"})),
    )
    filtered: list[str] = []
    seen: set[str] = set()
    for _category, names in sources:
        for item in names:
            item = str(item or "").replace("\\", "/")
            if _category == "checkpoints" and Path(item).suffix.lower() == ".gguf":
                continue
            choice = _main_model_choice(_category, item)
            key = choice.lower()
            if not item or key in seen:
                continue
            suffix = Path(item).suffix.lower()
            if suffix not in {".safetensors", ".gguf"}:
                continue
            seen.add(key)
            filtered.append(choice)
    filtered.sort(
        key=lambda name: (
            _quantization_priority(name),
            0 if not str(name).lower().startswith("diffusion_models/") and str(name).lower().endswith(".safetensors") else 1,
            0 if str(name).lower().startswith("diffusion_models/") and str(name).lower().endswith(".safetensors") else 1,
            0 if str(name).lower().endswith(".gguf") else 1,
            str(name).lower(),
        )
    )
    return filtered or [DEFAULT_CHECKPOINT]


def _list_lora_models() -> list[str]:
    names = _safe_filename_list("loras") + _scan_model_folder_files("loras", {".safetensors", ".pt", ".ckpt"})
    return [""] + sorted({str(name or "").replace("\\", "/") for name in names if str(name or "").strip()}, key=str.lower)


def _is_transition_lora_name(name: Any) -> bool:
    return bool(re.search(r"st[_-]?i2v|无缝转场|丝滑转场", str(name or ""), re.IGNORECASE))


def _resolve_transition_lora_name(requested: Any) -> str:
    requested_name = str(requested or "").strip().replace("\\", "/")
    choices = [name for name in _list_lora_models() if name]
    if _is_transition_lora_name(requested_name) and requested_name in choices:
        return requested_name
    default_key = re.sub(r"[^a-z0-9]+", "", DEFAULT_TRANSITION_LORA.lower())
    preferred = next(
        (name for name in choices if re.sub(r"[^a-z0-9]+", "", name.lower()) == default_key),
        None,
    )
    preferred = preferred or next(
        (name for name in choices if re.search(r"st[_-]?i2v.*high.*34|无缝转场|丝滑转场", name, re.IGNORECASE)),
        None,
    )
    if preferred:
        if requested_name and requested_name != preferred:
            print(
                f"[GJJ_Wan22RapidAIOMega] 已阻止无关转场 LoRA：{requested_name} -> {preferred}",
                flush=True,
            )
        return preferred
    return ""


def _pick_noise_model(models: list[str], noise: str, fallback: str) -> str:
    tokens = ("high", "高") if noise == "high" else ("low", "低")
    matching = [
        name
        for name in models
        if str(name).startswith("diffusion_models/")
        and any(token in str(name).lower() for token in tokens)
    ]
    if matching:
        return sorted(matching, key=lambda name: (_quantization_priority(name), str(name).lower()))[0]
    return fallback


def _load_model_lora(model: Any, lora_name: str):
    name = str(lora_name or "").strip()
    if not name:
        return model
    path = folder_paths.get_full_path_or_raise("loras", name)
    lora = comfy.utils.load_torch_file(path, safe_load=True)
    patched, _ = comfy.sd.load_lora_for_models(model, None, lora, 1.0, 0.0)
    return patched


def _list_wan_gguf_clip_models() -> list[str]:
    _ensure_clip_gguf_folder()
    names = (
        _safe_filename_list("clip_gguf")
        + _scan_model_folder_files("clip_gguf", {".gguf"})
        + _safe_filename_list("text_encoders")
        + _scan_model_folder_files("text_encoders", {".safetensors", ".gguf"})
    )
    filtered: list[str] = []
    seen: set[str] = set()
    for item in names:
        item = str(item or "").replace("\\", "/")
        key = item.lower()
        suffix = Path(item).suffix.lower()
        normalized_stem = re.sub(r"[^a-z0-9]+", "_", Path(item).stem.lower()).strip("_")
        if not item or key in seen or suffix not in {".safetensors", ".gguf"}:
            continue
        if "umt5" not in normalized_stem:
            continue
        # convrot 的独立 `enc` Safetensors 不是这里使用的完整 Wan T5；
        # 正常的 `encoder` GGUF（例如 Q3_K_M）仍然受支持。
        if suffix == ".safetensors" and "enc" in normalized_stem.split("_"):
            continue
        seen.add(key)
        filtered.append(item)
    filtered.sort(
        key=lambda name: (
            _quantization_priority(name),
            0 if str(name).lower().endswith(".gguf") else 1,
            str(name).lower(),
        )
    )
    return [""] + (filtered or [GGUF_DEFAULT_CLIP])


def _list_wan_vae_models() -> list[str]:
    names = _safe_filename_list("vae") + _scan_model_folder_files("vae", {".safetensors", ".pt", ".pth", ".ckpt"})
    filtered: list[str] = []
    seen: set[str] = set()
    for item in names:
        item = str(item or "").replace("\\", "/")
        key = item.lower()
        if not item or key in seen:
            continue
        if Path(item).suffix.lower() not in {".safetensors", ".pt", ".pth", ".ckpt"}:
            continue
        seen.add(key)
        filtered.append(item)
    filtered.sort(key=lambda name: (0 if "wan" in str(name).lower() and "vae" in str(name).lower() else 1, str(name).lower()))
    return [""] + (filtered or [GGUF_DEFAULT_VAE])


def _list_clip_vision_models() -> list[str]:
    names = _safe_filename_list("clip_vision") + _scan_model_folder_files(
        "clip_vision",
        {".safetensors", ".pt", ".pth", ".ckpt"},
    )
    filtered = sorted(
        {str(name or "").replace("\\", "/") for name in names if str(name or "").strip()},
        key=lambda name: (
            0 if Path(name).name.lower() == DEFAULT_CLIP_VISION.lower() else 1,
            str(name).lower(),
        ),
    )
    # 保留空值用于兼容在新增此隐藏字段前保存的工作流。执行时空值会自动
    # 回退到 DEFAULT_CLIP_VISION，避免 ComfyUI 在进入节点前判定为无效输入。
    return [""] + (filtered or [DEFAULT_CLIP_VISION])


def _is_gguf_model(value: Any) -> bool:
    return _split_model_selection(value)[1].lower().endswith(".gguf")


def _is_gguf_dependency_error(exc: Any) -> bool:
    text_parts = [str(exc or "")]
    cause = getattr(exc, "__cause__", None)
    context = getattr(exc, "__context__", None)
    if cause is not None:
        text_parts.append(str(cause or ""))
        if isinstance(cause, ModuleNotFoundError) and getattr(cause, "name", "") == "gguf":
            return True
    if context is not None:
        text_parts.append(str(context or ""))
        if isinstance(context, ModuleNotFoundError) and getattr(context, "name", "") == "gguf":
            return True
    text = "\n".join(text_parts).lower()
    return (
        "no module named 'gguf'" in text
        or 'no module named "gguf"' in text
        or "需要先安装 gguf" in text
        or "需要安装 gguf python 依赖" in text
        or "缺少 gguf 依赖" in text
    )


def _build_gguf_dependency_report(model_name: str, original_error: Any = "", model_kind: str = "模型") -> dict[str, Any]:
    report = build_dependency_model_report(
        node_name=NODE_NAME,
        missing_dependencies=[
            {
                "module_name": "gguf",
                "package_name": GGUF_PACKAGE_SPEC,
                "display_name": "gguf",
                "description": f"读取 .gguf {model_kind} 权重时需要；safetensors 模型不需要此依赖。",
            }
        ],
        install_packages=[GGUF_PACKAGE_SPEC],
        description=(
            f"当前 {model_kind} 选择的是 GGUF 模型：{model_name}\n"
            "GJJ 已内置 GGUF UNET/CLIP 加载器，不需要安装 ComfyUI-GGUF 第三方节点。\n"
            "只需要安装/升级 gguf Python 依赖；或者改用 safetensors 版 Wan Rapid AIO。"
        ),
        original_error=str(original_error or ""),
    )
    report["warning_message"] = "⚠️缺失 gguf 依赖，点击按钮复制安装命令。"
    report["description_message"] = report["warning_message"]
    report["copy_label"] = "📋 复制安装 gguf 依赖命令"
    report["model_download_url"] = ""
    return report


def _raise_gguf_dependency_missing(
    model_name: str,
    unique_id: Any = None,
    original_error: Any = "",
    model_kind: str = "模型",
) -> None:
    report = _build_gguf_dependency_report(model_name, original_error, model_kind=model_kind)
    print_dependency_model_report(report, title="GJJ Wan Rapid-AIO GGUF 依赖缺失！")
    send_dependency_model_notice(report, unique_id=unique_id)
    err = RuntimeError(
        f"检测到 GGUF {model_kind}，但当前 ComfyUI Python 缺少 gguf 依赖。"
        "请点击面板按钮复制安装命令，或改用 safetensors 版 Wan Rapid AIO。"
    )
    setattr(err, "gjj_report", report)
    raise err


def _ensure_gguf_dependency(model_name: str, unique_id: Any = None, model_kind: str = "模型") -> None:
    try:
        from .gjj_wanvideo_runtime_shims import ensure_optional_gguf_module
    except Exception:
        try:
            from gjj_wanvideo_runtime_shims import ensure_optional_gguf_module
        except Exception as exc:
            _raise_gguf_dependency_missing(model_name, unique_id=unique_id, original_error=exc, model_kind=model_kind)
    try:
        gguf_module = ensure_optional_gguf_module()
    except Exception as exc:
        _raise_gguf_dependency_missing(model_name, unique_id=unique_id, original_error=exc, model_kind=model_kind)
    if getattr(gguf_module, "_GJJ_OPTIONAL_RUNTIME_STUB", False):
        _raise_gguf_dependency_missing(model_name, unique_id=unique_id, model_kind=model_kind)


def _is_q2_gguf_model(value: Any) -> bool:
    clean_name = _split_model_selection(value)[1].lower()
    return clean_name.endswith(".gguf") and any(token in clean_name for token in ("q2_k", "q2-k"))


def _extract_model_clip_vae(value: Any):
    if isinstance(value, dict):
        if all(key in value for key in ("model", "clip", "vae")):
            return value["model"], value["clip"], value["vae"]
        value = value.get("result", value)
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return value[0], value[1], value[2]
    return None


def _call_loader_with_checkpoint(loader: Any, method_name: str, checkpoint_name: str, checkpoint_path: str | None = None):
    method = getattr(loader, method_name, None)
    if not callable(method):
        return None
    errors: list[Exception] = []
    values = [checkpoint_name]
    if checkpoint_path and checkpoint_path not in values:
        values.append(checkpoint_path)
    keyword_names = (
        "ckpt_name",
        "checkpoint_name",
        "model_name",
        "model",
        "gguf_name",
        "path",
        "ckpt_path",
        "checkpoint_path",
        "model_path",
    )
    for value in values:
        for key in keyword_names:
            try:
                return method(**{key: value})
            except TypeError as exc:
                errors.append(exc)
            except Exception:
                raise
    for kwargs in (
        {"ckpt_name": checkpoint_name},
        {"checkpoint_name": checkpoint_name},
        {"model_name": checkpoint_name},
        {"model": checkpoint_name},
    ):
        try:
            return method(**kwargs)
        except TypeError as exc:
            errors.append(exc)
        except Exception:
            raise
    try:
        return method(checkpoint_name)
    except TypeError as exc:
        errors.append(exc)
    if errors:
        raise errors[-1]
    return None


def _node_class(class_name: str):
    try:
        import nodes as comfy_nodes
    except Exception as exc:
        raise RuntimeError(f"无法访问 ComfyUI 节点注册表：{exc}") from exc
    mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    node_cls = mappings.get(class_name)
    if node_cls is None:
        raise RuntimeError(f"当前 ComfyUI 没有注册节点：{class_name}")
    return node_cls


def _call_node_function(node_cls: Any, *args, **kwargs):
    node = node_cls()
    function_name = str(getattr(node_cls, "FUNCTION", "") or "").strip()
    method_names = [function_name] if function_name else []
    method_names.extend(name for name in ("load_unet", "load_clip", "load_vae", "load_checkpoint", "load") if name not in method_names)
    errors: list[str] = []
    for method_name in method_names:
        method = getattr(node, method_name, None)
        if not callable(method):
            continue
        try:
            return method(*args, **kwargs)
        except TypeError as exc:
            errors.append(f"{method_name}: {exc}")
    raise RuntimeError("; ".join(errors) or f"{node_cls.__name__} 没有可调用的加载函数")


def _load_wan_clip_model(clip_name: str, unique_id: Any = None):
    if _is_gguf_model(clip_name):
        _ensure_gguf_dependency(clip_name, unique_id=unique_id, model_kind="Wan CLIP")
        try:
            from ..vendor.gjj_gguf_runtime import load_clip_gguf as load_gjj_gguf_clip
        except ImportError:
            from vendor.gjj_gguf_runtime import load_clip_gguf as load_gjj_gguf_clip
        try:
            return load_gjj_gguf_clip(clip_name, "wan")
        except ModuleNotFoundError as exc:
            if getattr(exc, "name", "") == "gguf":
                _raise_gguf_dependency_missing(clip_name, unique_id=unique_id, original_error=exc, model_kind="Wan CLIP")
            raise
        except Exception as exc:
            if _is_gguf_dependency_error(exc):
                _raise_gguf_dependency_missing(clip_name, unique_id=unique_id, original_error=exc, model_kind="Wan CLIP")
            raise RuntimeError(f"GJJ 内置 GGUF Wan CLIP 加载失败：{clip_name}\n{exc}") from exc
    return gjjutils_load_clip_from_names([clip_name], "wan")


def _load_wan_split_workflow_models(
    unet_name: str,
    clip_name: str = DEFAULT_WAN_CLIP,
    vae_name: str = GGUF_DEFAULT_VAE,
    unique_id: Any = None,
):
    _ensure_unet_gguf_folder()
    _ensure_clip_gguf_folder()
    source_category, clean_unet_name = _split_model_selection(unet_name)
    is_gguf = _is_gguf_model(clean_unet_name)
    resolved_unet = gjjutils_resolve_model_name(
        clean_unet_name,
        "unet_gguf" if is_gguf else "diffusion_models",
        candidates=[clean_unet_name, RAPID_AIO_SEARCH_SEED, DEFAULT_CHECKPOINT],
        extensions={".gguf"} if is_gguf else {".safetensors", ".pt", ".pth", ".ckpt"},
        label="Wan Rapid-AIO 分体主模型",
    )
    if _is_q2_gguf_model(resolved_unet):
        raise RuntimeError(
            "当前 Wan Rapid AllInOne 的 Q2_K GGUF 会生成噪声/花屏视频，已阻止执行。\n"
            f"主模型：{resolved_unet}\n"
            "请改用 Q4_K / Q4_K_M / 更高量化 GGUF，或使用同仓库 .safetensors AIO。"
        )
    requested_clip = clip_name or DEFAULT_WAN_CLIP
    clip_is_gguf = _is_gguf_model(requested_clip)
    resolved_clip = gjjutils_resolve_model_name(
        requested_clip,
        "clip_gguf" if clip_is_gguf else "text_encoders",
        candidates=[clip_name, DEFAULT_WAN_CLIP, GGUF_DEFAULT_CLIP, "umt5 xxl encoder"],
        extensions={".gguf"} if clip_is_gguf else {".safetensors"},
        label="Wan CLIP / T5",
    )
    resolved_vae = gjjutils_resolve_model_name(
        vae_name or GGUF_DEFAULT_VAE,
        "vae",
        candidates=[vae_name, GGUF_DEFAULT_VAE, "wan 2.1 vae", "wan2 vae"],
        extensions={".safetensors", ".pt", ".pth", ".ckpt"},
        label="Wan VAE",
    )
    if is_gguf:
        _ensure_gguf_dependency(resolved_unet, unique_id=unique_id, model_kind="UNET")
    try:
        model = gjjutils_load_model(resolved_unet, "default")
    except Exception as exc:
        if is_gguf and _is_gguf_dependency_error(exc):
            _raise_gguf_dependency_missing(resolved_unet, unique_id=unique_id, original_error=exc, model_kind="UNET")
        raise
    clip = _load_wan_clip_model(resolved_clip, unique_id=unique_id)
    vae = gjjutils_load_vae(resolved_vae)
    return model, clip, vae


def _load_aio_checkpoint_gguf(
    checkpoint_name: str,
    clip_name: str = DEFAULT_WAN_CLIP,
    vae_name: str = GGUF_DEFAULT_VAE,
    unique_id: Any = None,
):
    try:
        return _load_wan_split_workflow_models(checkpoint_name, clip_name, vae_name, unique_id=unique_id)
    except Exception as workflow_exc:
        if getattr(workflow_exc, "gjj_report", None):
            raise
        workflow_error = str(workflow_exc)
        try:
            import nodes as comfy_nodes
        except Exception as exc:
            raise RuntimeError(f"{workflow_error}\n无法访问 ComfyUI 节点注册表：{exc}") from exc

    mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    checkpoint_path = _find_model_file("checkpoints", checkpoint_name)
    candidates = []
    for class_name, node_cls in mappings.items():
        lowered = str(class_name or "").lower()
        if "gguf" not in lowered:
            continue
        if not any(token in lowered for token in ("checkpoint", "ckpt", "loader")):
            continue
        if any(token in lowered for token in ("unet", "clip", "vae", "lora")):
            continue
        priority = 0 if any(token in lowered for token in ("checkpoint", "ckpt")) else 1
        candidates.append((priority, str(class_name), node_cls))
    candidates.sort(key=lambda item: (item[0], item[1].lower()))

    errors: list[str] = []
    for _priority, class_name, node_cls in candidates:
        try:
            loader = node_cls()
            method_names = ["load_checkpoint"]
            function_name = str(getattr(node_cls, "FUNCTION", "") or "").strip()
            if function_name and function_name not in method_names:
                method_names.append(function_name)
            method_names.extend(name for name in ("load", "load_gguf", "load_model") if name not in method_names)
            for method_name in method_names:
                result = _call_loader_with_checkpoint(loader, method_name, checkpoint_name, checkpoint_path)
                extracted = _extract_model_clip_vae(result)
                if extracted is not None:
                    return extracted
        except Exception as exc:
            errors.append(f"{class_name}: {exc}")

    if not candidates:
        raise RuntimeError(f"{workflow_error}\n没有发现已注册的 checkpoint GGUF 加载器。")
    raise RuntimeError(f"{workflow_error}\n已发现 checkpoint GGUF 加载器，但未能得到 Model/CLIP/VAE：\n" + "\n".join(errors[:6]))


def _is_split_model_selection(model_name: str) -> bool:
    if _is_gguf_model(model_name):
        return True
    source_category, clean_name = _split_model_selection(model_name)
    if source_category in {"diffusion_models", "unet_gguf"}:
        return True
    if source_category == "checkpoints":
        return False
    diffusion_path = _find_model_file("diffusion_models", clean_name)
    checkpoint_path = _find_model_file("checkpoints", clean_name)
    return bool(diffusion_path and not checkpoint_path)


def _load_rapid_pipeline(
    checkpoint_name: str,
    wan_clip_model: str = DEFAULT_WAN_CLIP,
    wan_vae_model: str = GGUF_DEFAULT_VAE,
    unique_id: Any = None,
):
    resolved_checkpoint = _require_checkpoint_name(checkpoint_name)
    if _is_split_model_selection(resolved_checkpoint):
        try:
            return resolved_checkpoint, *_load_wan_split_workflow_models(
                resolved_checkpoint,
                wan_clip_model,
                wan_vae_model,
                unique_id=unique_id,
            )
        except Exception as exc:
            if getattr(exc, "gjj_report", None):
                raise
            raise RuntimeError(
                "当前选择的是 Wan Rapid AllInOne 分体主模型，已按 GJJ 零依赖链路加载：内置 UNET/GGUF UNET + 内置 GGUF Wan CLIP + 内置 VAE。\n"
                f"主模型：{resolved_checkpoint}\n"
                "但当前分体模型组合加载失败。请检查主模型、Wan CLIP 和 Wan VAE 是否能被 GJJ 公共模型搜索找到。\n"
                f"原始错误：{exc}"
            ) from exc
    if _is_gguf_model(resolved_checkpoint):
        try:
            return resolved_checkpoint, *_load_aio_checkpoint_gguf(
                resolved_checkpoint,
                wan_clip_model,
                wan_vae_model,
                unique_id=unique_id,
            )
        except Exception as exc:
            if getattr(exc, "gjj_report", None):
                raise
            raise RuntimeError(
                "当前选择的是 Wan Rapid AllInOne GGUF，已按 GJJ 零依赖链路加载：内置 GGUF UNET + 内置 GGUF Wan CLIP + 内置 VAE。\n"
                f"GGUF：{resolved_checkpoint}\n"
                "但当前 GGUF 组合加载失败。请检查 gguf Python 依赖、"
                f"{GGUF_DEFAULT_CLIP} 和 {GGUF_DEFAULT_VAE} 是否能被 GJJ 公共模型搜索找到。\n"
                f"原始错误：{exc}"
            ) from exc
    try:
        return resolved_checkpoint, *CheckpointLoaderSimple().load_checkpoint(resolved_checkpoint)
    except Exception as exc:
        raise


def _require_checkpoint_name(preferred: str) -> str:
    available = _list_rapid_checkpoints()
    resolved = _pick_available_name(preferred, available, DEFAULT_CHECKPOINT)
    if not resolved:
        raise RuntimeError(f"未找到 Wan Rapid-AIO Checkpoint：{preferred or DEFAULT_CHECKPOINT}")
    source_category, clean_name = _split_model_selection(resolved)
    if _is_gguf_model(resolved):
        full_path = _find_model_file("unet_gguf", clean_name) or _find_model_file("diffusion_models", clean_name) or _find_model_file("checkpoints", clean_name)
    elif source_category == "diffusion_models":
        full_path = _find_model_file("diffusion_models", clean_name)
    elif source_category == "checkpoints":
        full_path = _find_model_file("checkpoints", clean_name)
    else:
        full_path = _find_model_file("diffusion_models", clean_name) or _find_model_file("checkpoints", clean_name)
    if not full_path and not _is_gguf_model(resolved):
        raise RuntimeError(f"未找到 Wan Rapid-AIO Checkpoint：{resolved}")
    return resolved


def _apply_sd3_shift(model, shift: float):
    patched = model.clone()

    class ModelSamplingAdvanced(comfy.model_sampling.ModelSamplingDiscreteFlow, comfy.model_sampling.CONST):
        pass

    model_sampling = ModelSamplingAdvanced(model.model.model_config)
    model_sampling.set_parameters(shift=float(shift), multiplier=1000)
    patched.add_object_patch("model_sampling", model_sampling)
    return patched


def _apply_chain_loras(model, clip, lora_chain_config: Any = "", loaded_lora_cache: tuple[str, Any] | None = None):
    if not str(lora_chain_config or "").strip():
        return model, clip, loaded_lora_cache
    current_model, current_clip, cache_entry = apply_lora_chain_config(
        model,
        clip,
        lora_data=normalize_lora_chain_data(lora_chain_config),
        loaded_lora_cache=loaded_lora_cache,
    )
    return current_model, current_clip, cache_entry


def _conditioning_set_values(conditioning, values: dict[str, Any], append: bool = False):
    updated = []
    for item in conditioning:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            updated.append(item)
            continue
        new_item = list(item)
        metadata = dict(new_item[1] or {})
        for key, value in values.items():
            if append and key in metadata:
                existing = metadata.get(key)
                if isinstance(existing, list):
                    metadata[key] = existing + (value if isinstance(value, list) else [value])
                else:
                    metadata[key] = ([existing] if existing is not None else []) + (
                        value if isinstance(value, list) else [value]
                    )
            else:
                metadata[key] = value
        new_item[1] = metadata
        updated.append(new_item)
    return updated


def _align_up(value: int, alignment: int = SIZE_ALIGNMENT) -> int:
    alignment = max(1, int(alignment))
    value = max(1, int(value))
    return ((value + alignment - 1) // alignment) * alignment


def _align_size_widget_value(value: int) -> int:
    return max(320, min(1536, _align_up(int(value), SIZE_ALIGNMENT)))


def _unwrap_list_param(value: Any) -> Any:
    try:
        while isinstance(value, (list, tuple)) and len(value) == 1:
            value = value[0]
    except Exception:
        pass
    return value


def _bool_param(value: Any, default: bool = False) -> bool:
    value = _unwrap_list_param(value)
    if isinstance(value, bool):
        return value
    if value is None:
        return bool(default)
    text = str(value).strip().lower()
    if text in {"true", "1", "yes", "on", "开启", "启用", "是"}:
        return True
    if text in {"false", "0", "no", "off", "关闭", "禁用", "否"}:
        return False
    return bool(value)


def _parse_segment_timeline_config(value: Any) -> list[dict[str, Any]]:
    value = _unwrap_list_param(value)
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            value = json.loads(text)
        except Exception:
            return []
    if not isinstance(value, list):
        return []

    configs: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        duration = item.get("duration", item.get("seconds", None))
        try:
            duration_value = max(3.0, min(15.0, float(duration)))
        except Exception:
            duration_value = 0.0
        transition = str(item.get("transition") or "首尾帧").strip()
        if transition not in {"首尾帧", "硬切"}:
            transition = "首尾帧"
        configs.append(
            {
                "duration": duration_value,
                "prompt": str(item.get("prompt") or "").strip(),
                "transition": transition,
            }
        )
    return configs


def _split_positive_prompt_segments(text: Any) -> list[str]:
    normalized = str(text or "").replace("\r\n", "\n").strip()
    if not normalized:
        return []
    parts = [part.strip() for part in re.split(r"\n\s*(?:-{3,}|#{3,}|={3,})\s*\n", normalized) if part.strip()]
    if len(parts) <= 1:
        parts = [line.strip() for line in normalized.splitlines() if line.strip()]
    if len(parts) <= 1:
        return []
    cleaned: list[str] = []
    for part in parts:
        cleaned_part = re.sub(r"^(?:第?\s*\d+\s*[段.、:：-]\s*|\d+\s*[.、:：-]\s*)", "", part).strip()
        if cleaned_part:
            cleaned.append(cleaned_part)
    return cleaned


def _prepend_global_prompt(global_prompt: Any, prompt: Any) -> str:
    prefix = str(global_prompt or "").strip()
    body = str(prompt or "").strip()
    if prefix and body:
        return f"{prefix}, {body}"
    return prefix or body


def _timeline_segment_frames(config: dict[str, Any] | None, fallback_duration: Any, fps: Any) -> int:
    try:
        duration = max(3.0, min(15.0, float(fallback_duration)))
    except Exception:
        duration = 4.0
    if config and float(config.get("duration") or 0.0) > 0:
        duration = max(3.0, min(15.0, float(config.get("duration"))))
    frame_rate = max(1.0, float(fps or DEFAULT_FRAME_RATE))
    return max(1, int((duration * frame_rate // 4) * 4 + 1))


def _input_sequence_source(images: Any, pack_to_sequence: bool) -> Any:
    if bool(pack_to_sequence):
        return images
    if isinstance(images, (list, tuple)) and images:
        return images[0]
    return images


def _is_empty_loader_placeholder(images: torch.Tensor) -> bool:
    if images is None or not isinstance(images, torch.Tensor) or images.ndim != 4:
        return False
    if tuple(int(x) for x in images.shape) != (1, 64, 64, 3):
        return False
    return bool(torch.count_nonzero(images).item() == 0)


def _ensure_rgb_image_batch(images: torch.Tensor, label: str = "图片输入") -> torch.Tensor:
    if images.ndim == 3:
        images = images.unsqueeze(0)
    if images.ndim != 4:
        raise RuntimeError(f"{label}维度无效：{tuple(images.shape)}")

    channels = int(images.shape[-1])
    if channels == 3:
        return images
    if channels == 4:
        return images[:, :, :, :3].contiguous()
    if channels == 1:
        return images.expand(-1, -1, -1, 3).contiguous()
    raise RuntimeError(f"{label}通道数无效：{channels}，需要 RGB/RGBA/灰度图片。")


def _extract_image_frames(images: Any, _seen: set[int] | None = None) -> list[torch.Tensor]:
    if images is None:
        return []
    if _seen is None:
        _seen = set()
    if not isinstance(images, (torch.Tensor, str, bytes, int, float, bool)):
        object_id = id(images)
        if object_id in _seen:
            return []
        _seen.add(object_id)

    if callable(getattr(images, "get_components", None)):
        try:
            components = images.get_components()
        except Exception as exc:
            raise RuntimeError(f"读取 VIDEO/媒体组件失败：{exc}") from exc
        for key in ("images", "frames", "image"):
            value = _component_value(components, key)
            if value is not None:
                return _extract_image_frames(value, _seen)
        return []

    if isinstance(images, dict):
        frames: list[torch.Tensor] = []
        for key in ("images", "frames", "image", "samples", "batch", "items", "children", "media"):
            if key in images and images.get(key) is not None:
                frames.extend(_extract_image_frames(images.get(key), _seen))
        if frames:
            return frames
        raise RuntimeError(f"不支持的图片输入字典：{sorted(str(key) for key in images.keys())}")

    if isinstance(images, (list, tuple, set)):
        frames: list[torch.Tensor] = []
        for item in images:
            frames.extend(_extract_image_frames(item, _seen))
        return frames

    def extend_if_images(target: list[torch.Tensor], child: Any) -> None:
        try:
            target.extend(_extract_image_frames(child, _seen))
        except RuntimeError:
            return

    container_frames: list[torch.Tensor] = []
    for name in ("images", "frames", "image", "imgs", "batch", "queue", "items", "values", "selected", "image_list", "image_queue"):
        try:
            child = getattr(images, name, None)
        except Exception:
            child = None
        if child is not None and child is not images:
            extend_if_images(container_frames, child)
    try:
        for child in vars(images).values():
            if child is not images:
                extend_if_images(container_frames, child)
    except Exception:
        pass
    if container_frames:
        return container_frames

    if not isinstance(images, torch.Tensor):
        raise RuntimeError(f"不支持的图片输入类型：{type(images)!r}")

    batch = _ensure_rgb_image_batch(images)
    if _is_empty_loader_placeholder(batch):
        return []

    batch = batch.detach().float().cpu().clamp(0.0, 1.0).contiguous()
    return [batch[index:index + 1].contiguous() for index in range(int(batch.shape[0]))]


def _extract_local_image_frames(local_image_files: Any) -> list[torch.Tensor]:
    frames: list[torch.Tensor] = []
    for entry in parse_selected_images(local_image_files):
        path = resolve_selected_image_path(entry)
        frames.extend(_extract_image_frames(load_image_tensor(path)))
    return frames


def _make_transition_pair_image(first: torch.Tensor, second: torch.Tensor) -> torch.Tensor:
    first_batch = _ensure_rgb_image_batch(first).detach().float().cpu().clamp(0.0, 1.0)
    second_batch = _ensure_rgb_image_batch(second).detach().float().cpu().clamp(0.0, 1.0)
    first_frame = first_batch[:1].contiguous()
    second_frame = second_batch[:1].contiguous()
    target_height = max(int(first_frame.shape[1]), int(second_frame.shape[1]), 64)

    def resize_to_height(frame: torch.Tensor) -> torch.Tensor:
        height = int(frame.shape[1])
        width = int(frame.shape[2])
        if height == target_height:
            return frame
        target_width = max(1, int(round(width * (target_height / max(1, height)))))
        return comfy.utils.common_upscale(frame.movedim(-1, 1), target_width, target_height, "lanczos", "disabled").movedim(1, -1).contiguous()

    left = resize_to_height(first_frame)
    right = resize_to_height(second_frame)
    separator = torch.ones((1, target_height, 8, 3), dtype=left.dtype, device=left.device) * 0.1
    return torch.cat([left, separator, right], dim=2).contiguous()


def _resolve_generation_size(image_frames: list[torch.Tensor], width: int, height: int, auto_use_first_image_size: bool) -> tuple[int, int]:
    if auto_use_first_image_size and image_frames:
        first = image_frames[0]
        source_height = int(first.shape[1])
        source_width = int(first.shape[2])
        return _align_up(source_width), _align_up(source_height)
    return _align_size_widget_value(width), _align_size_widget_value(height)


def _crop_offset(extra: int, position: str, axis: str) -> int:
    if extra <= 0:
        return 0
    normalized = str(position or "中").strip()
    if axis == "x":
        if normalized == "左":
            return 0
        if normalized == "右":
            return int(extra)
    if axis == "y":
        if normalized == "上":
            return 0
        if normalized == "下":
            return int(extra)
    return int(extra) // 2


def _fit_image_batch_to_size(
    images: torch.Tensor | None,
    target_width: int,
    target_height: int,
    fit_mode: str,
    crop_position: str,
) -> torch.Tensor | None:
    if images is None:
        return None
    batch = _ensure_rgb_image_batch(images).detach().float().cpu().clamp(0.0, 1.0).contiguous()
    source_height = int(batch.shape[1])
    source_width = int(batch.shape[2])
    target_width = max(1, int(target_width))
    target_height = max(1, int(target_height))
    if source_width == target_width and source_height == target_height:
        return batch

    mode = str(fit_mode or "裁剪").strip()
    if mode not in IMAGE_FIT_MODES:
        mode = "裁剪"

    if mode == "拉伸":
        return comfy.utils.common_upscale(batch.movedim(-1, 1), target_width, target_height, "lanczos", "disabled").movedim(1, -1).contiguous()

    scale = max(target_width / max(1, source_width), target_height / max(1, source_height)) if mode == "裁剪" else min(target_width / max(1, source_width), target_height / max(1, source_height))
    scaled_width = max(1, int(round(source_width * scale)))
    scaled_height = max(1, int(round(source_height * scale)))
    scaled = comfy.utils.common_upscale(batch.movedim(-1, 1), scaled_width, scaled_height, "lanczos", "disabled").movedim(1, -1).contiguous()

    if mode == "裁剪":
        left = _crop_offset(scaled_width - target_width, crop_position, "x")
        top = _crop_offset(scaled_height - target_height, crop_position, "y")
        return scaled[:, top:top + target_height, left:left + target_width, :].contiguous()

    if scaled_width > target_width or scaled_height > target_height:
        left_crop = _crop_offset(scaled_width - target_width, crop_position, "x")
        top_crop = _crop_offset(scaled_height - target_height, crop_position, "y")
        scaled = scaled[:, top_crop:top_crop + min(scaled_height, target_height), left_crop:left_crop + min(scaled_width, target_width), :].contiguous()
        scaled_height = int(scaled.shape[1])
        scaled_width = int(scaled.shape[2])
    canvas = torch.ones((int(scaled.shape[0]), target_height, target_width, 3), dtype=scaled.dtype, device=scaled.device) * float(DEFAULT_EMPTY_FRAME_LEVEL)
    left = _crop_offset(target_width - scaled_width, crop_position, "x")
    top = _crop_offset(target_height - scaled_height, crop_position, "y")
    canvas[:, top:top + scaled_height, left:left + scaled_width, :] = scaled
    return canvas.contiguous()


def _build_vace_control_frames(
    num_frames: int,
    empty_frame_level: float,
    start_image: torch.Tensor | None = None,
    end_image: torch.Tensor | None = None,
    control_images: torch.Tensor | None = None,
    inpaint_mask: torch.Tensor | None = None,
    start_index: int = 0,
    end_index: int = -1,
) -> tuple[torch.Tensor | None, torch.Tensor | None]:
    if start_image is not None:
        start_image = _ensure_rgb_image_batch(start_image, "起始图片")
    if end_image is not None:
        end_image = _ensure_rgb_image_batch(end_image, "结束图片")
    if control_images is not None:
        control_images = _ensure_rgb_image_batch(control_images, "控制图片")

    if start_image is None and end_image is None and control_images is None:
        return None, None

    if start_image is None and end_image is None and control_images is not None:
        if int(control_images.shape[0]) >= int(num_frames):
            trimmed = control_images[:num_frames]
        else:
            padding = torch.ones(
                (num_frames - int(control_images.shape[0]), int(control_images.shape[1]), int(control_images.shape[2]), int(control_images.shape[3])),
                dtype=control_images.dtype,
                device=control_images.device,
            ) * float(empty_frame_level)
            trimmed = torch.cat([control_images, padding], dim=0)
        masks = torch.zeros_like(trimmed[:, :, :, 0])
        return trimmed.detach().float().cpu(), masks.detach().float().cpu()

    source = start_image if start_image is not None else end_image
    if source is None:
        raise RuntimeError("构建 VACE 控制帧失败：未提供起始图或结束图。")

    _, height, width, _ = source.shape
    device = source.device

    if end_index < 0:
        end_index = int(num_frames) + int(end_index)

    out_batch = torch.ones((num_frames, height, width, 3), device=device, dtype=source.dtype) * float(empty_frame_level)
    masks = torch.ones((num_frames, height, width), device=device, dtype=source.dtype)

    if end_image is not None and (int(end_image.shape[1]) != int(height) or int(end_image.shape[2]) != int(width)):
        end_image = comfy.utils.common_upscale(end_image.movedim(-1, 1), width, height, "lanczos", "disabled").movedim(1, -1)

    if control_images is not None and (int(control_images.shape[1]) != int(height) or int(control_images.shape[2]) != int(width)):
        control_images = comfy.utils.common_upscale(control_images.movedim(-1, 1), width, height, "lanczos", "disabled").movedim(1, -1)

    if start_image is not None:
        frames_to_copy = min(int(start_image.shape[0]), int(num_frames) - int(start_index))
        if frames_to_copy > 0:
            out_batch[start_index:start_index + frames_to_copy] = start_image[:frames_to_copy]
            masks[start_index:start_index + frames_to_copy] = 0

    if end_image is not None:
        end_start = int(end_index) - int(end_image.shape[0]) + 1
        if end_start < 0:
            end_image = end_image[abs(end_start):]
            end_start = 0
        frames_to_copy = min(int(end_image.shape[0]), int(num_frames) - int(end_start))
        if frames_to_copy > 0:
            out_batch[end_start:end_start + frames_to_copy] = end_image[:frames_to_copy]
            masks[end_start:end_start + frames_to_copy] = 0

    if control_images is not None:
        empty_frames = masks.sum(dim=(1, 2)) > 0.5 * int(height) * int(width)
        if bool(empty_frames.any()):
            control_length = int(control_images.shape[0])
            for frame_index in range(int(num_frames)):
                if bool(empty_frames[frame_index]) and frame_index < control_length:
                    out_batch[frame_index] = control_images[frame_index]

    if inpaint_mask is not None:
        inpaint_mask = comfy.utils.common_upscale(inpaint_mask.unsqueeze(1), width, height, "nearest-exact", "disabled").squeeze(1).to(device)
        if int(inpaint_mask.shape[0]) > int(num_frames):
            inpaint_mask = inpaint_mask[:num_frames]
        elif int(inpaint_mask.shape[0]) < int(num_frames):
            repeat_factor = (int(num_frames) + int(inpaint_mask.shape[0]) - 1) // int(inpaint_mask.shape[0])
            inpaint_mask = inpaint_mask.repeat(repeat_factor, 1, 1)[:num_frames]
        masks = inpaint_mask * masks

    return out_batch.detach().float().cpu(), masks.detach().float().cpu()


def _build_vace_latent(
    positive,
    negative,
    vae,
    width: int,
    height: int,
    length: int,
    batch_size: int,
    strength: float,
    control_video: torch.Tensor | None = None,
    control_masks: torch.Tensor | None = None,
    reference_image: torch.Tensor | None = None,
):
    latent_length = ((int(length) - 1) // 4) + 1
    if control_video is not None:
        control_video = comfy.utils.common_upscale(control_video[:length].movedim(-1, 1), width, height, "bilinear", "center").movedim(1, -1)
        if int(control_video.shape[0]) < int(length):
            control_video = F.pad(control_video, (0, 0, 0, 0, 0, 0, 0, int(length) - int(control_video.shape[0])), value=0.5)
    else:
        control_video = torch.ones((length, height, width, 3), dtype=torch.float32) * 0.5

    if reference_image is not None:
        reference_image = comfy.utils.common_upscale(reference_image[:1].movedim(-1, 1), width, height, "bilinear", "center").movedim(1, -1)
        reference_image = vae.encode(reference_image[:, :, :, :3])
        reference_image = torch.cat([reference_image, torch.zeros_like(reference_image)], dim=1)

    if control_masks is None:
        mask = torch.ones((length, height, width, 1), dtype=control_video.dtype)
    else:
        mask = control_masks
        if mask.ndim == 3:
            mask = mask.unsqueeze(1)
        mask = comfy.utils.common_upscale(mask[:length], width, height, "bilinear", "center").movedim(1, -1)
        if int(mask.shape[0]) < int(length):
            mask = F.pad(mask, (0, 0, 0, 0, 0, 0, 0, int(length) - int(mask.shape[0])), value=1.0)

    control_video = control_video - 0.5
    inactive = (control_video * (1 - mask)) + 0.5
    reactive = (control_video * mask) + 0.5

    inactive = vae.encode(inactive[:, :, :, :3])
    reactive = vae.encode(reactive[:, :, :, :3])
    control_video_latent = torch.cat((inactive, reactive), dim=1)

    trim_latent = 0
    if reference_image is not None:
        control_video_latent = torch.cat((reference_image, control_video_latent), dim=2)

    vae_stride = 8
    height_mask = height // vae_stride
    width_mask = width // vae_stride
    mask = mask.view(length, height_mask, vae_stride, width_mask, vae_stride)
    mask = mask.permute(2, 4, 0, 1, 3)
    mask = mask.reshape(vae_stride * vae_stride, length, height_mask, width_mask)
    mask = F.interpolate(mask.unsqueeze(0), size=(latent_length, height_mask, width_mask), mode="nearest-exact").squeeze(0)

    if reference_image is not None:
        mask_pad = torch.zeros_like(mask[:, : reference_image.shape[2], :, :])
        mask = torch.cat((mask_pad, mask), dim=1)
        latent_length += int(reference_image.shape[2])
        trim_latent = int(reference_image.shape[2])

    mask = mask.unsqueeze(0)

    positive = _conditioning_set_values(
        positive,
        {"vace_frames": [control_video_latent], "vace_mask": [mask], "vace_strength": [float(strength)]},
        append=True,
    )
    negative = _conditioning_set_values(
        negative,
        {"vace_frames": [control_video_latent], "vace_mask": [mask], "vace_strength": [float(strength)]},
        append=True,
    )

    latent = torch.zeros(
        [int(batch_size), 16, latent_length, int(height) // 8, int(width) // 8],
        device=comfy.model_management.intermediate_device(),
    )
    return positive, negative, {"samples": latent}, trim_latent


def _concat_segments(segments: list[torch.Tensor]) -> torch.Tensor:
    if not segments:
        return torch.zeros((0, 64, 64, 3), dtype=torch.float32)
    return torch.cat(segments, dim=0).contiguous()


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_component_frame_count(video_output: Any) -> int:
    if not callable(getattr(video_output, "get_components", None)):
        return 0
    try:
        components = video_output.get_components()
    except Exception:
        return 0
    images = _component_value(components, "images")
    if isinstance(images, torch.Tensor) and images.ndim >= 1:
        return int(images.shape[0])
    frames = _component_value(components, "frames")
    if isinstance(frames, torch.Tensor) and frames.ndim >= 1:
        return int(frames.shape[0])
    return 0


def _video_component_dimensions(video_output: Any) -> tuple[int, int]:
    if callable(getattr(video_output, "get_dimensions", None)):
        try:
            width, height = video_output.get_dimensions()
            if int(width) > 0 and int(height) > 0:
                return int(width), int(height)
        except Exception:
            pass
    if not callable(getattr(video_output, "get_components", None)):
        return 0, 0
    try:
        components = video_output.get_components()
    except Exception:
        return 0, 0
    for key in ("images", "frames"):
        frames = _component_value(components, key)
        if isinstance(frames, torch.Tensor) and frames.ndim >= 3:
            return int(frames.shape[-2]), int(frames.shape[-3])
    return 0, 0


def _direct_video_from_frames(frames: torch.Tensor, fps: float, audio: Any = None):
    frame_rate = Fraction(float(max(0.01, fps))).limit_denominator(1000)
    safe_frames = frames.detach().float().cpu().clamp(0.0, 1.0).contiguous()
    if int(safe_frames.shape[-1]) > 3:
        safe_frames = safe_frames[..., :3].contiguous()
    return InputImpl.VideoFromComponents(Types.VideoComponents(images=safe_frames, audio=audio, frame_rate=frame_rate))


class _GJJWanVideoFileOutput:
    def __init__(self, path: str, fallback: Any = None):
        self.path = str(path or "")
        self.fallback = fallback

    def save_to(self, path: str, *args, metadata: dict[str, Any] | None = None, **kwargs):
        if not self.path or not Path(self.path).is_file():
            if callable(getattr(self.fallback, "save_to", None)):
                if metadata is not None and "metadata" not in kwargs:
                    kwargs["metadata"] = metadata
                return self.fallback.save_to(path, *args, **kwargs)
            raise RuntimeError(f"VIDEO 文件不存在，无法保存：{self.path}")
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if str(target.resolve()).lower() != str(Path(self.path).resolve()).lower():
            shutil.copy2(self.path, target)

    def get_components(self):
        if callable(getattr(self.fallback, "get_components", None)):
            return self.fallback.get_components()
        raise RuntimeError("此 VIDEO 优先作为文件直通保存；当前环境无法从文件型 VIDEO 拆出帧组件。")

    def get_frame_rate(self):
        if callable(getattr(self.fallback, "get_frame_rate", None)):
            try:
                frame_rate = self.fallback.get_frame_rate()
                if frame_rate is not None:
                    return frame_rate
            except Exception:
                pass
        if self.path and Path(self.path).is_file():
            _width, _height, fps, _frames, _duration = _probe_video_file(Path(self.path))
            if float(fps or 0) > 0:
                return Fraction(float(fps)).limit_denominator(1000)
        return None

    def get_dimensions(self):
        width, height = _video_component_dimensions(self.fallback)
        if width > 0 and height > 0:
            return width, height
        if self.path and Path(self.path).is_file():
            width, height, _fps, _frames, _duration = _probe_video_file(Path(self.path))
            if int(width) > 0 and int(height) > 0:
                return int(width), int(height)
        raise RuntimeError(f"无法读取 VIDEO 尺寸：{self.path}")


def _video_from_file(path: str):
    if path:
        try:
            return InputImpl.VideoFromFile(str(path))
        except Exception:
            try:
                from comfy_api.input_impl import VideoFromFile

                return VideoFromFile(str(path))
            except Exception:
                return None
    return None


def _preview_ui_from_temp_file(path: str, ui_payload: dict[str, Any], format_name: str, fps: float) -> tuple[str, dict[str, Any]]:
    source = Path(str(path or ""))
    if not source.is_file():
        return str(path or ""), ui_payload
    info = gjjutils_write_temp_file(source, suffix=source.suffix or ".mp4")
    temp_path = gjjutils_temp_path(str(info.get("filename") or ""))
    try:
        if source.resolve() != temp_path.resolve():
            source.unlink(missing_ok=True)
    except Exception:
        pass
    width, height, probed_fps, frame_count, _duration = _probe_video_file(temp_path)
    preview_item = {
        "filename": str(info.get("filename") or temp_path.name),
        "subfolder": str(info.get("subfolder") or "GJJ"),
        "type": "temp",
        "format": str(format_name or DEFAULT_VIDEO_FORMAT),
        "frame_rate": float(probed_fps or fps or DEFAULT_FRAME_RATE),
        "width": int(width or 0),
        "height": int(height or 0),
        "frame_count": int(frame_count or 0),
    }
    updated = dict(ui_payload or {})
    updated.update(
        {
            "preview_main_path": (str(temp_path),),
            "preview_format": (str(format_name or DEFAULT_VIDEO_FORMAT),),
            "preview_is_video": (True,),
            "preview_width": (int(width or 0),),
            "preview_height": (int(height or 0),),
            "preview_media": [preview_item],
            "animated": [dict(preview_item)],
        }
    )
    return str(temp_path), updated


def _combined_video_from_frames(
    frames: torch.Tensor,
    fps: float,
    audio: Any,
    filename_prefix: str,
    format_name: str,
    unique_id: Any = None,
    save_output: bool = True,
):
    from .gjj_video_combine import GJJ_VideoCombine

    combined = GJJ_VideoCombine().combine(
        images=frames,
        frame_rate=float(fps),
        loop_count=0,
        filename_prefix=str(filename_prefix or DEFAULT_VIDEO_PREFIX).strip() or DEFAULT_VIDEO_PREFIX,
        format_name=str(format_name or DEFAULT_VIDEO_FORMAT).strip() or DEFAULT_VIDEO_FORMAT,
        pingpong=False,
        save_output=bool(save_output),
        use_source_fps=False,
        delete_tail_frame=False,
        save_metadata=False,
        trim_to_audio=False,
        pix_fmt="yuv420p",
        crf="19",
        vae=None,
        audio=audio,
        unique_id=unique_id,
    )
    ui_payload = dict(combined.get("ui") or {}) if isinstance(combined, dict) else {}
    result = combined.get("result") if isinstance(combined, dict) else combined
    video_output = None
    main_path = ""
    if isinstance(result, (list, tuple)) and result:
        video_output = result[0]
        if len(result) > 1:
            main_path = str(result[1] or "")
    raw_path = ui_payload.get("preview_main_path")
    if not main_path and isinstance(raw_path, (list, tuple)) and raw_path:
        main_path = str(raw_path[0] or "")
    elif not main_path and isinstance(raw_path, str):
        main_path = raw_path
    if main_path and not bool(save_output):
        main_path, ui_payload = _preview_ui_from_temp_file(main_path, ui_payload, format_name, float(fps or DEFAULT_FRAME_RATE))
    file_video = _video_from_file(main_path)
    if main_path:
        return _GJJWanVideoFileOutput(main_path, file_video or video_output), main_path, ui_payload
    return (file_video or video_output or _direct_video_from_frames(frames, fps, audio)), main_path, ui_payload


PROMPT_INFER_OPTIONS_API = "/gjj/wan22_rapid_aio_mega/prompt_infer/options"
PROMPT_INFER_RUN_API = "/gjj/wan22_rapid_aio_mega/prompt_infer/run"
PROMPT_INFER_SYSTEM = (
    "你是视频生成提示词专家。输入媒体虽然为了识别而把两帧临时并排展示，但它不是一个左右并排的画面："
    "第一张图代表视频时间轴的起始帧，第二张图代表同一视频时间轴的结束帧。"
    "请反推出从第一张图随时间连续变化到第二张图的首尾帧转场提示词。"
    "必须使用“起始帧、随后、逐渐、最终、结束帧”等时间顺序来理解和描述两张图；"
    "禁止把它们称为左图、右图、左侧画面、右侧画面、两侧、并排画面或拼接画面。"
    "只描述主体动作、形态变化、镜头运动、场景变化、光线氛围和自然过渡，"
    "不要解释，不要编号，不要 Markdown，不要输出标题。"
)
PROMPT_INFER_USER = (
    "按时间顺序分析这两个连续关键帧：第一张是起始帧，第二张是结束帧。"
    "请生成一条 1 句到 2 句的视频转场提示词，让起始帧中的内容自然、连续地运动并变化为结束帧中的内容。"
    "不要描述图片在输入媒体里的左右位置，不要出现“左图、右图、左侧画面、右侧画面、两侧、并排、拼接”等词。"
    "只输出提示词正文。"
)


def _clean_inferred_prompt(text: Any) -> str:
    cleaned = str(text or "").strip()
    cleaned = re.sub(r"^\s*(?:转场提示词|视频提示词|提示词|结果)\s*[:：]\s*", "", cleaned)
    temporal_replacements = (
        (r"(?:左侧|左边)(?:的)?(?:画面|图片|图像|图)中?", "起始帧中"),
        (r"(?:右侧|右边)(?:的)?(?:画面|图片|图像|图)中?", "结束帧中"),
        (r"从左图", "从起始帧"),
        (r"到右图", "到结束帧"),
        (r"由左图", "由起始帧"),
        (r"至右图", "至结束帧"),
    )
    for pattern, replacement in temporal_replacements:
        cleaned = re.sub(pattern, replacement, cleaned)
    cleaned = cleaned.strip().strip("`").strip()
    return cleaned


def _prompt_infer_options() -> dict[str, list[str]]:
    options: dict[str, list[str]] = {}
    try:
        from .gjj_llama_common import llm_main_model_options

        options["GJJ_LlamaAssistant"] = [str(item) for item in llm_main_model_options()]
    except Exception:
        options["GJJ_LlamaAssistant"] = []
    try:
        from .gjj_gemma_text_generate import _text_encoder_options

        options["GJJ_GemmaTextGenerate"] = [str(item) for item in _text_encoder_options()]
    except Exception:
        options["GJJ_GemmaTextGenerate"] = []
    try:
        from .gjj_image_analysis import _ollama_assistant_model_options

        options["GJJ_OllamaAssistant"] = [str(item) for item in _ollama_assistant_model_options()]
    except Exception:
        options["GJJ_OllamaAssistant"] = []
    return options


def _infer_transition_prompt(method: str, model: str, pair_image: torch.Tensor, unique_id: Any = None, keep_model: bool = True) -> str:
    method = str(method or "GJJ_OllamaAssistant").strip()
    model = str(model or "").strip()
    model_keep_alive = "保持模型" if bool(keep_model) else "卸载模型"
    if method == "GJJ_LlamaAssistant":
        from .gjj_llama_assistant import (
            CACHE_TYPE_OPTIONS,
            DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE,
            DEFAULT_SYSTEM_PROMPT_TEMPLATES,
            GJJ_LlamaAssistant,
            best_mmproj_for_main_model,
            llm_mmproj_options,
        )

        mmproj = best_mmproj_for_main_model(model, llm_mmproj_options())
        result = GJJ_LlamaAssistant().run(
            model,
            mmproj,
            model_keep_alive,
            "关闭思考",
            0.7,
            1024,
            "每次随机",
            0,
            80,
            0.95,
            0.03,
            0.3,
            0.2,
            1.15,
            8192,
            -1,
            24,
            1024,
            False,
            False,
            CACHE_TYPE_OPTIONS[0],
            CACHE_TYPE_OPTIONS[0],
            False,
            0,
            f"{PROMPT_INFER_SYSTEM}\n{DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE}",
            DEFAULT_SYSTEM_PROMPT_TEMPLATES,
            DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE,
            PROMPT_INFER_USER,
            image=pair_image,
            unique_id=unique_id,
        )
        payload = result.get("result") if isinstance(result, dict) else result
        return _clean_inferred_prompt(payload[0] if isinstance(payload, (list, tuple)) else payload)

    if method == "GJJ_GemmaTextGenerate":
        from .gjj_gemma_text_generate import GJJ_GemmaTextGenerate

        result = GJJ_GemmaTextGenerate().generate(
            model,
            "ideogram4",
            "default",
            PROMPT_INFER_USER,
            1024,
            "on",
            0.7,
            64,
            0.95,
            0.05,
            1.05,
            0,
            "0.0",
            False,
            True,
            media=pair_image,
            unique_id=unique_id,
            system_prompt=PROMPT_INFER_SYSTEM,
        )
        payload = result.get("result") if isinstance(result, dict) else result
        return _clean_inferred_prompt(payload[0] if isinstance(payload, (list, tuple)) else payload)

    if method == "GJJ_OllamaAssistant":
        from .gjj_image_analysis import DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT_TEMPLATES, GJJ_OllamaAssistant
        from .gjj_ollama_common import DEFAULT_OLLAMA_HOST, DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE

        result = GJJ_OllamaAssistant().run(
            DEFAULT_OLLAMA_HOST,
            model,
            model_keep_alive,
            "关闭思考",
            0.7,
            1024,
            f"{PROMPT_INFER_SYSTEM}\n{DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE}",
            DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT_TEMPLATES,
            DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE,
            PROMPT_INFER_USER,
            image=pair_image,
            unique_id=unique_id,
        )
        payload = result.get("result") if isinstance(result, dict) else result
        return _clean_inferred_prompt(payload[0] if isinstance(payload, (list, tuple)) else payload)

    raise RuntimeError(f"未知反推方式：{method}")


def _register_prompt_infer_routes() -> None:
    if web is None or PromptServer is None:
        return
    routes = PromptServer.instance.routes

    @routes.get(PROMPT_INFER_OPTIONS_API)
    async def get_prompt_infer_options(_request):
        return web.json_response({"ok": True, "methods": _prompt_infer_options()})

    @routes.post(PROMPT_INFER_RUN_API)
    async def post_prompt_infer_run(request):
        try:
            data = await request.json()
            items = parse_selected_images(json.dumps(data.get("items") or [], ensure_ascii=False))
            segment_index = int(data.get("segment_index") or 0)
            if segment_index < 0 or segment_index + 1 >= len(items):
                return web.json_response({"ok": False, "error": "请选择有效的相邻两张素材。"}, status=400)
            first = load_image_tensor(resolve_selected_image_path(items[segment_index]))
            second = load_image_tensor(resolve_selected_image_path(items[segment_index + 1]))
            pair_image = _make_transition_pair_image(first, second)
            prompt = _infer_transition_prompt(
                str(data.get("method") or "GJJ_OllamaAssistant"),
                str(data.get("model") or ""),
                pair_image,
                unique_id=data.get("node_id"),
                keep_model=bool(data.get("keep_model", True)),
            )
            if not prompt:
                return web.json_response({"ok": False, "error": "模型没有返回可用提示词。"}, status=500)
            return web.json_response({"ok": True, "prompt": prompt})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)


_register_prompt_infer_routes()


def _segment_preview_extra(
    frames: torch.Tensor,
    fps: float,
    filename_prefix: str,
    format_name: str,
    segment_index: int,
) -> dict[str, Any]:
    try:
        _video, preview_path, ui_payload = _combined_video_from_frames(
            frames,
            float(fps or DEFAULT_FRAME_RATE),
            None,
            f"{str(filename_prefix or DEFAULT_VIDEO_PREFIX).strip() or DEFAULT_VIDEO_PREFIX}_preview_segment_{segment_index + 1:03d}",
            str(format_name or DEFAULT_VIDEO_FORMAT).strip() or DEFAULT_VIDEO_FORMAT,
            unique_id=None,
            save_output=False,
        )
        extra = dict(ui_payload or {})
        extra["segment_preview_index"] = [segment_index + 1]
        if preview_path:
            extra["segment_preview_path"] = [preview_path]
        return extra
    except Exception as exc:
        return {"segment_preview_error": [str(exc)]}


def _video_component_audio(video_output: Any) -> Any:
    if not callable(getattr(video_output, "get_components", None)):
        return None
    try:
        return _component_value(video_output.get_components(), "audio")
    except Exception:
        return None


def _build_route_name(image_count: int) -> str:
    if image_count <= 0:
        return "T2V 流畅"
    if image_count == 1:
        return "I2V 流畅"
    if image_count == 2:
        return "首尾帧"
    return "多图串接"


class GJJ_Wan22RapidAIOMega:
    CATEGORY = "GJJ/视频生成/万相视频"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (False, False)
    DESCRIPTION = (
        "将 Wan2.2_Rapid-AIO-Mega 工作流封装为 GJJ 零依赖本地节点。"
        "未接图走 T2V，接 1 张图走 I2V，接 2 张图走首尾帧，多张图会按相邻图片自动串接生成整段帧序列。"
    )
    SEARCH_ALIASES = [
        "wan rapid",
        "wan2.2 rapid",
        "rapid aio mega",
        "wan t2v",
        "wan i2v",
        "首尾帧",
        "多图串接",
    ]
    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE", "VIDEO")
    RETURN_NAMES = ("视频帧序列", "视频")
    OUTPUT_TOOLTIPS = (
        "解码后的视频帧序列；这里复用 GJJ_BATCH_IMAGE 类型，可直接连接 GJJ · 视频合成器 的 图像/Latent 输入。",
        "官方 VIDEO 输出，可直接连接保存、剪辑或配音节点。",
    )
    GJJ_HELP = {
        "title": "Wan多合一合成视频流畅器",
        "description": (
            "Wan2.2 Rapid AllInOne 视频节点。支持 checkpoint AIO 单文件，也支持 diffusion_models 分体 safetensors / GGUF；"
            "GGUF 和 diffusion_models 分体模式需要 Wan CLIP 与 Wan VAE。开启 📢 后会额外使用 MMAudio 模型树为视频配音。"
        ),
        "notice": (
            "模型选择规则：checkpoints 下的 safetensors AIO 自带 CLIP/VAE；"
            "diffusion_models 或 .gguf 主模型必须配套 Wan CLIP 和 Wan VAE。"
            "Q2_K 对该 Wan 视频模型容易输出花屏，节点会阻止执行；建议 Q4_K / Q4_K_M 或更高量化。"
        ),
        "model_download_url": WAN22_RAPID_AIO_MODEL_DOWNLOAD_URL,
        "copy_text": WAN22_RAPID_AIO_MODEL_DOWNLOAD_URL,
        "copy_label": "复制 Wan Rapid AIO 下载地址",
        "model_tree": WAN22_RAPID_AIO_MODEL_TREE,
        "model_tree_text": WAN22_RAPID_AIO_MODEL_TREE_TEXT,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "models": [
            {
                "label": item["label"],
                "subdir": f"models/{item.get('folder', '')}".rstrip("/"),
                "filename": item.get("filename", ""),
                "description": item.get("description", ""),
            }
            for item in WAN22_RAPID_AIO_MODEL_TREE
            if item.get("required", True)
        ],
    }

    def __init__(self):
        self.loaded_lora: tuple[str, Any] | None = None
        self.loaded_clip_vision_name: str | None = None
        self.loaded_clip_vision: Any = None

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = _list_rapid_checkpoints()
        default_checkpoint = _pick_available_name(DEFAULT_CHECKPOINT, checkpoints, DEFAULT_CHECKPOINT)
        audio_models = _mmaudio_models()
        audio_main_models = _mmaudio_main_models(audio_models)
        audio_vae_models = _mmaudio_vae_models(audio_models)
        audio_synchformer_models = _mmaudio_synchformer_models(audio_models)
        audio_clip_models = _mmaudio_clip_models(audio_models)
        wan_clip_models = _list_wan_gguf_clip_models()
        wan_vae_models = _list_wan_vae_models()
        clip_vision_models = _list_clip_vision_models()
        lora_models = _list_lora_models()
        default_high_model = _pick_available_name(
            DEFAULT_WORKFLOW_HIGH_MODEL,
            checkpoints,
            _pick_noise_model(checkpoints, "high", default_checkpoint),
        )
        default_low_model = _pick_available_name(
            DEFAULT_WORKFLOW_LOW_MODEL,
            checkpoints,
            _pick_noise_model(checkpoints, "low", default_high_model),
        )
        return {
            "required": {
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_POSITIVE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "默认值直接来自 Wan2.2_Rapid-AIO-Mega 工作流当前提示词。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "反向提示词",
                        "tooltip": "默认留空，按原工作流的 1 CFG 用法保持极简负向条件。",
                    },
                ),
                "checkpoint_name": (
                    checkpoints,
                    {
                        "default": default_high_model,
                        "display_name": "Wan 基础模型",
                        "tooltip": "显示本机全部 checkpoint 与 diffusion_models；自动选择和列表排序优先 int4_convrot，再回退其他 safetensors / GGUF 精度。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": DEFAULT_WIDTH,
                        "min": 32,
                        "max": 8192,
                        "step": 32,
                        "display_name": "无图时宽度",
                        "tooltip": "未接图片时使用的输出宽度；接图后可自动改为首图尺寸并按 32 对齐。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": DEFAULT_HEIGHT,
                        "min": 32,
                        "max": 8192,
                        "step": 32,
                        "display_name": "无图时高度",
                        "tooltip": "未接图片时使用的输出高度；接图后可自动改为首图尺寸并按 32 对齐。",
                    },
                ),
                "segment_frames": (
                    "INT",
                    {
                        "default": DEFAULT_SEGMENT_FRAMES,
                        "min": 1,
                        "max": 1024,
                        "step": 4,
                        "display_name": "默认每段帧数",
                        "tooltip": "默认素材分段帧数；修改后会覆盖素材时间线中的每段时长。",
                    },
                ),
                "auto_use_first_image_size": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "接图后跟随首图尺寸",
                        "tooltip": "开启后，只要接入图片就自动按首图尺寸推导生成尺寸，并做 32 倍数对齐。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 6456545463455,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "统一控制所有分段的随机种子；多图串接时会复用同一个种子保持整体观感一致。",
                    },
                ),
                "local_image_files": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "内部硬盘图片",
                        "tooltip": "由顶部 📂 按钮写入；当批量图片输入口有外部链接时会自动忽略。",
                    },
                ),
                "randomize_seed_on_click": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "点击随机种",
                        "tooltip": "由顶部 🎲 开关控制；关闭时固定当前种子。",
                    },
                ),
                "output_fps": (
                    "FLOAT",
                    {
                        "default": float(DEFAULT_FRAME_RATE),
                        "min": 1.0,
                        "max": 120.0,
                        "step": 1.0,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "视频帧率",
                        "tooltip": "VIDEO 输出帧率。",
                    },
                ),
                "video_format": (
                    list_supported_formats(),
                    {
                        "default": DEFAULT_VIDEO_FORMAT if DEFAULT_VIDEO_FORMAT in list_supported_formats() else list_supported_formats()[0],
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "视频格式",
                        "tooltip": "VIDEO 文件写出格式；默认 H.264 MP4。",
                    },
                ),
                "filename_prefix": (
                    "STRING",
                    {
                        "default": DEFAULT_VIDEO_PREFIX,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "文件名前缀",
                        "tooltip": "VIDEO 输出文件名前缀。",
                    },
                ),
                "audio_enabled": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "启用配音",
                        "tooltip": "开启后使用 GJJ_MMAudioNSFWSingle 为生成的视频配音。",
                    },
                ),
                "audio_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_AUDIO_PROMPT,
                        "multiline": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "配音正向提示词",
                    },
                ),
                "audio_negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_AUDIO_NEGATIVE,
                        "multiline": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "配音反向提示词",
                    },
                ),
                "audio_mmaudio_model": (
                    audio_main_models,
                    {
                        "default": _prefer_main_model(audio_main_models),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "配音 MMAudio 主模型",
                    },
                ),
                "audio_vae_model": (
                    audio_vae_models,
                    {
                        "default": _prefer_model(audio_vae_models, ("vae", "44k")),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "配音 VAE 模型",
                    },
                ),
                "audio_synchformer_model": (
                    audio_synchformer_models,
                    {
                        "default": _prefer_model(audio_synchformer_models, ("synchformer",)),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "配音 Synchformer 模型",
                    },
                ),
                "audio_clip_model": (
                    audio_clip_models,
                    {
                        "default": _prefer_model(audio_clip_models, ("clip",)),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "配音 CLIP/DFN 模型",
                    },
                ),
                "wan_clip_model": (
                    wan_clip_models,
                    {
                        "default": _pick_available_name(
                            DEFAULT_WAN_CLIP,
                            wan_clip_models,
                            _prefer_model(wan_clip_models, ("umt5",)),
                        ),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "Wan CLIP / T5",
                        "tooltip": "分体主模型使用；支持 UMT5 INT4/INT8/FP8 safetensors 与 GGUF，独立 enc Safetensors 除外。",
                    },
                ),
                "wan_vae_model": (
                    wan_vae_models,
                    {
                        "default": _prefer_model(wan_vae_models, ("wan", "vae")),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "Wan VAE",
                        "tooltip": "diffusion_models 分体 safetensors / GGUF 主模型使用；对应工作流 VAELoader。",
                    },
                ),
                "image_fit_mode": (
                    list(IMAGE_FIT_MODES),
                    {
                        "default": "裁剪",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "图片适配",
                        "tooltip": "拉伸=直接缩放；补边/留边=等比缩放并补中性边；裁剪=短边等比缩放后按位置裁剪长边。",
                    },
                ),
                "crop_position": (
                    list(CROP_POSITIONS),
                    {
                        "default": "中",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "裁剪/补边位置",
                        "tooltip": "裁剪长边或补边时使用的位置：上、下、左、右、中。",
                    },
                ),
                "pack_input_images_to_sequence": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "输入图片打包到序列",
                        "tooltip": "开启后，未经过 GJJ_ImageBatchMulti 的多图输入也会在本节点内按顺序收拢为首尾帧序列；关闭时只使用传入列表的第一项。",
                    },
                ),
                "segment_timeline_config": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "素材时间线配置",
                        "tooltip": "由前端素材时间线写入：每两张图片之间的时长、提示词和转场方式。",
                    },
                ),
                "low_model_name": (
                    checkpoints,
                    {
                        "default": default_low_model,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "低噪模型",
                        "tooltip": "多合一 NSFW Wan 工作流的低噪阶段模型；与原 Wan 基础模型组成高噪/低噪两阶段采样。",
                    },
                ),
                "high_lora_name": (
                    lora_models,
                    {
                        "default": _pick_available_name(DEFAULT_HIGH_LORA, lora_models, ""),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "高噪 2step LoRA",
                    },
                ),
                "low_lora_name": (
                    lora_models,
                    {
                        "default": _pick_available_name(DEFAULT_LOW_LORA, lora_models, ""),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "低噪 2step LoRA",
                    },
                ),
                "clip_vision_model": (
                    clip_vision_models,
                    {
                        "default": _pick_available_name(DEFAULT_CLIP_VISION, clip_vision_models, DEFAULT_CLIP_VISION),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "首尾帧 CLIP Vision",
                        "tooltip": "按目标工作流使用 clip_vision_h 编码队列中的每一对参考图，作为 Wan 首尾帧视觉条件。",
                    },
                ),
                "transition_lora_name": (
                    lora_models,
                    {
                        "default": _pick_available_name(DEFAULT_TRANSITION_LORA, lora_models, ""),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "首尾帧转场 LoRA",
                        "tooltip": "首尾帧分段自动叠加的高噪转场 LoRA；文生、单图和硬切分段不会使用。",
                    },
                ),
                "global_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "全局提示词",
                        "tooltip": "可留空；设置后会自动添加到每一段正向提示词的前面。",
                    },
                ),
                "segment_duration": (
                    "FLOAT",
                    {
                        "default": 4.0,
                        "min": 3.0,
                        "max": 15.0,
                        "step": 0.1,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "每段时长",
                        "tooltip": "每段 3–15 秒；后台按 int((时长 * 帧率 // 4) * 4 + 1) 计算帧数。",
                    },
                ),
                "auto_transition_prompt": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "自动首尾帧过渡词",
                        "tooltip": "由前端 🎬 开关控制；多图输入时直接根据每一对相邻首尾帧自动反推转场提示词。",
                    },
                ),
            },
            "optional": {
                "images": (
                    IMAGE_INPUT_TYPE,
                    {
                        "display_name": "批量图片",
                        "tooltip": "推荐直接连接 GJJ · 多图片加载预览器 的 批量图片队列。未接图走 T2V，1 张走 I2V，2 张走首尾帧，多张走相邻两图依次串接。",
                    },
                ),
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "display_name": "LoRA串联配置",
                        "tooltip": "可选接入 GJJ · LoRA串联配置 的输出；会在加载 checkpoint 后按配置顺序串联应用到 Wan 模型与 CLIP。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        positive_prompt,
        negative_prompt,
        checkpoint_name,
        width,
        height,
        segment_frames,
        auto_use_first_image_size,
        seed,
        local_image_files="[]",
        randomize_seed_on_click=False,
        output_fps=DEFAULT_FRAME_RATE,
        video_format=DEFAULT_VIDEO_FORMAT,
        filename_prefix=DEFAULT_VIDEO_PREFIX,
        audio_enabled=False,
        audio_prompt=DEFAULT_AUDIO_PROMPT,
        audio_negative_prompt=DEFAULT_AUDIO_NEGATIVE,
        audio_mmaudio_model="",
        audio_vae_model="",
        audio_synchformer_model="",
        audio_clip_model="",
        wan_clip_model=DEFAULT_WAN_CLIP,
        wan_vae_model=GGUF_DEFAULT_VAE,
        image_fit_mode="裁剪",
        crop_position="中",
        pack_input_images_to_sequence=True,
        segment_timeline_config="[]",
        low_model_name="",
        high_lora_name=DEFAULT_HIGH_LORA,
        low_lora_name=DEFAULT_LOW_LORA,
        clip_vision_model=DEFAULT_CLIP_VISION,
        transition_lora_name=DEFAULT_TRANSITION_LORA,
        global_prompt="",
        segment_duration=4.0,
        auto_transition_prompt=False,
        images=None,
        lora_chain_config="",
        unique_id=None,
    ):
        try:
            positive_prompt = _unwrap_list_param(positive_prompt)
            negative_prompt = _unwrap_list_param(negative_prompt)
            checkpoint_name = _unwrap_list_param(checkpoint_name)
            width = _unwrap_list_param(width)
            height = _unwrap_list_param(height)
            segment_frames = _unwrap_list_param(segment_frames)
            auto_use_first_image_size = _bool_param(auto_use_first_image_size, True)
            seed = _unwrap_list_param(seed)
            local_image_files = _unwrap_list_param(local_image_files)
            randomize_seed_on_click = _bool_param(randomize_seed_on_click, False)
            output_fps = _unwrap_list_param(output_fps)
            video_format = _unwrap_list_param(video_format)
            filename_prefix = _unwrap_list_param(filename_prefix)
            audio_enabled = _bool_param(audio_enabled, False)
            audio_prompt = _unwrap_list_param(audio_prompt)
            audio_negative_prompt = _unwrap_list_param(audio_negative_prompt)
            audio_mmaudio_model = _unwrap_list_param(audio_mmaudio_model)
            audio_vae_model = _unwrap_list_param(audio_vae_model)
            audio_synchformer_model = _unwrap_list_param(audio_synchformer_model)
            audio_clip_model = _unwrap_list_param(audio_clip_model)
            wan_clip_model = _unwrap_list_param(wan_clip_model)
            wan_vae_model = _unwrap_list_param(wan_vae_model)
            image_fit_mode = _unwrap_list_param(image_fit_mode)
            crop_position = _unwrap_list_param(crop_position)
            pack_input_images_to_sequence = _bool_param(pack_input_images_to_sequence, True)
            low_model_name = _unwrap_list_param(low_model_name)
            high_lora_name = _unwrap_list_param(high_lora_name)
            low_lora_name = _unwrap_list_param(low_lora_name)
            clip_vision_model = _unwrap_list_param(clip_vision_model)
            transition_lora_name = _unwrap_list_param(transition_lora_name)
            global_prompt = _unwrap_list_param(global_prompt)
            segment_duration = _unwrap_list_param(segment_duration)
            auto_transition_prompt = _bool_param(auto_transition_prompt, False)
            timeline_config = _parse_segment_timeline_config(segment_timeline_config)
            lora_chain_config = _unwrap_list_param(lora_chain_config)
            unique_id = _unwrap_list_param(unique_id)

            image_source = _input_sequence_source(images, pack_input_images_to_sequence)
            raw_image_frames = _extract_image_frames(image_source) if image_source is not None else _extract_local_image_frames(local_image_files)
            image_count = len(raw_image_frames)
            route_name = _build_route_name(image_count)
            resolved_width, resolved_height = _resolve_generation_size(
                raw_image_frames,
                int(width),
                int(height),
                auto_use_first_image_size,
            )
            image_frames = [
                fitted
                for frame in raw_image_frames
                if (fitted := _fit_image_batch_to_size(frame, resolved_width, resolved_height, str(image_fit_mode), str(crop_position))) is not None
            ]
            image_count = len(image_frames)

            clip_vision = None
            if image_count > 0:
                selected_clip_vision = str(clip_vision_model or DEFAULT_CLIP_VISION).strip()
                if self.loaded_clip_vision_name != selected_clip_vision or self.loaded_clip_vision is None:
                    clip_vision_path = folder_paths.get_full_path_or_raise("clip_vision", selected_clip_vision)
                    self.loaded_clip_vision = comfy.clip_vision.load(clip_vision_path)
                    self.loaded_clip_vision_name = selected_clip_vision
                clip_vision = self.loaded_clip_vision

            _send_status(unique_id, "1/7 加载 Wan Rapid-AIO Checkpoint...", 0.06)
            resolved_checkpoint, model, clip, vae = _load_rapid_pipeline(
                checkpoint_name,
                wan_clip_model,
                wan_vae_model,
                unique_id=unique_id,
            )
            low_selection = str(low_model_name or "").strip()
            dual_model_mode = bool(low_selection and low_selection != str(resolved_checkpoint))
            if dual_model_mode:
                _, low_model, _, _ = _load_rapid_pipeline(
                    low_selection,
                    wan_clip_model,
                    wan_vae_model,
                    unique_id=unique_id,
                )
            else:
                low_model = model
            model = _load_model_lora(_apply_sd3_shift(model, DEFAULT_SHIFT), high_lora_name)
            low_model = _load_model_lora(_apply_sd3_shift(low_model, DEFAULT_SHIFT), low_lora_name)

            _send_status(unique_id, "2/7 应用 LoRA串联配置...", 0.14)
            model, clip, self.loaded_lora = _apply_chain_loras(
                model,
                clip,
                lora_chain_config=lora_chain_config,
                loaded_lora_cache=self.loaded_lora,
            )
            transition_lora_name = _resolve_transition_lora_name(transition_lora_name)
            if auto_transition_prompt and image_count > 1 and not transition_lora_name:
                raise RuntimeError(
                    "🎬 已开启，但未找到 ST-I2V/无缝转场 LoRA。"
                    f"请安装：{DEFAULT_TRANSITION_LORA}"
                )
            transition_model = _load_model_lora(model, transition_lora_name)

            _send_status(unique_id, "3/7 编码提示词...", 0.2)
            base_positive_text = _prepend_global_prompt(
                global_prompt,
                str(positive_prompt or "").strip() or DEFAULT_POSITIVE,
            )
            positive = CLIPTextEncode().encode(clip, base_positive_text)[0]
            negative = CLIPTextEncode().encode(clip, str(negative_prompt or "").strip() or DEFAULT_NEGATIVE)[0]
            positive_prompt_segments = _split_positive_prompt_segments(positive_prompt)

            base_segment_count = 1 if image_count <= 1 else image_count - 1
            close_loop = image_count > 1 and len(positive_prompt_segments) >= image_count
            segment_count = image_count if close_loop else base_segment_count
            ignored_prompt_count = max(0, len(positive_prompt_segments) - segment_count)
            _send_status(
                unique_id,
                (
                    f"4/7 当前模式：{route_name}，共 {segment_count} 段，"
                    f"{'已按 --- 顺序匹配队列提示词，' if positive_prompt_segments else ''}"
                    f"{'最后一段使用末图→首图闭环，' if close_loop else ''}"
                    f"{f'忽略多余 {ignored_prompt_count} 段提示词，' if ignored_prompt_count else ''}"
                    f"输出尺寸 {resolved_width}x{resolved_height}..."
                ),
                0.28,
            )

            collected_segments: list[torch.Tensor] = []
            decoded_segment_frames: list[int] = []
            for segment_index in range(segment_count):
                segment_config = timeline_config[segment_index] if segment_index < len(timeline_config) else None
                segment_frame_count = _timeline_segment_frames(segment_config, segment_duration, output_fps)
                if segment_index < len(positive_prompt_segments):
                    segment_prompt = positive_prompt_segments[segment_index]
                else:
                    segment_prompt = str((segment_config or {}).get("prompt") or "").strip()
                segment_transition = str((segment_config or {}).get("transition") or "首尾帧").strip()
                if auto_transition_prompt and image_count > 1:
                    segment_transition = "首尾帧"
                if (
                    auto_transition_prompt
                    and image_count > 1
                    and segment_transition != "硬切"
                    and not segment_prompt
                ):
                    infer_options = _prompt_infer_options()
                    infer_method = next(
                        (name for name in ("GJJ_OllamaAssistant", "GJJ_GemmaTextGenerate", "GJJ_LlamaAssistant") if infer_options.get(name)),
                        "",
                    )
                    infer_models = infer_options.get(infer_method, [])
                    if infer_method and infer_models:
                        next_image_index = 0 if close_loop and segment_index == image_count - 1 else segment_index + 1
                        _send_status(
                            unique_id,
                            f"🎬 第 {segment_index + 1}/{segment_count} 段：根据首尾帧自动生成过渡词...",
                            0.28 + (0.48 * (segment_index / max(1, segment_count))),
                        )
                        segment_prompt = _infer_transition_prompt(
                            infer_method,
                            infer_models[0],
                            _make_transition_pair_image(image_frames[segment_index], image_frames[next_image_index]),
                            unique_id=unique_id,
                            keep_model=True,
                        )
                if segment_prompt:
                    active_positive = CLIPTextEncode().encode(
                        clip,
                        _prepend_global_prompt(global_prompt, segment_prompt),
                    )[0]
                else:
                    active_positive = positive

                if image_count <= 0:
                    segment_start = None
                    segment_end = None
                elif image_count == 1:
                    segment_start = image_frames[0]
                    segment_end = None
                else:
                    segment_start = image_frames[segment_index]
                    next_image_index = 0 if close_loop and segment_index == image_count - 1 else segment_index + 1
                    segment_end = None if segment_transition == "硬切" else image_frames[next_image_index]

                if segment_start is None:
                    conditioning_mode = "文生"
                elif segment_end is None:
                    conditioning_mode = "图生"
                else:
                    conditioning_mode = "首尾帧"

                debug_payload = {
                    "segment": f"{segment_index + 1}/{segment_count}",
                    "image_pair": (
                        None
                        if image_count <= 1
                        else [
                            segment_index + 1,
                            (1 if close_loop and segment_index == image_count - 1 else segment_index + 2),
                        ]
                    ),
                    "source_image_count": image_count,
                    "auto_transition_prompt": bool(auto_transition_prompt),
                    "timeline_transition_raw": str((segment_config or {}).get("transition") or "首尾帧"),
                    "effective_transition": segment_transition,
                    "conditioning_mode": conditioning_mode,
                    "prompt": _prepend_global_prompt(global_prompt, segment_prompt) if segment_prompt else base_positive_text,
                    "segment_prompt": segment_prompt,
                    "global_prompt": str(global_prompt or ""),
                    "frame_count": segment_frame_count,
                    "fps": float(output_fps or DEFAULT_FRAME_RATE),
                    "size": [resolved_width, resolved_height],
                    "seed": int(seed),
                    "sampler": "euler_ancestral",
                    "scheduler": "simple",
                    "steps": 2,
                    "cfg": 1.0,
                    "denoise": float(DEFAULT_DENOISE),
                    "checkpoint_high": str(resolved_checkpoint),
                    "checkpoint_low": str(low_selection or resolved_checkpoint),
                    "high_lora": str(high_lora_name or ""),
                    "low_lora": str(low_lora_name or ""),
                    "transition_lora": str(transition_lora_name or ""),
                    "transition_lora_applied": bool(conditioning_mode == "首尾帧" and str(transition_lora_name or "").strip()),
                    "clip_vision_model": str(clip_vision_model or ""),
                    "start_image_shape": list(segment_start.shape) if isinstance(segment_start, torch.Tensor) else None,
                    "end_image_shape": list(segment_end.shape) if isinstance(segment_end, torch.Tensor) else None,
                }
                print(
                    "[GJJ_Wan22RapidAIOMega][SEGMENT_CONFIG] "
                    + json.dumps(debug_payload, ensure_ascii=False, default=str),
                    flush=True,
                )

                progress_base = 0.28 + (0.48 * (segment_index / max(1, segment_count)))
                next_image_number = 1 if close_loop and segment_index == image_count - 1 else segment_index + 2
                _send_status(
                    unique_id,
                    (
                        f"5/7 第 {segment_index + 1}/{segment_count} 段"
                        f"{f'（图{segment_index + 1}→图{next_image_number}）' if image_count > 1 else ''}："
                        f"构建 Wan {conditioning_mode}条件（{segment_transition}，{segment_frame_count} 帧）..."
                    ),
                    progress_base + 0.05,
                )
                start_clip_condition = (
                    CLIPVisionEncode().encode(clip_vision, segment_start[:1], "none")[0]
                    if clip_vision is not None and segment_start is not None
                    else None
                )
                end_clip_condition = (
                    CLIPVisionEncode().encode(clip_vision, segment_end[:1], "none")[0]
                    if clip_vision is not None and segment_end is not None
                    else None
                )
                segment_positive, segment_negative, segment_latent = GJJ_WanUnifiedVideoConditioning().generate(
                    resolved_width,
                    resolved_height,
                    segment_frame_count,
                    1,
                    gjj_mode=conditioning_mode,
                    positive=active_positive,
                    negative=negative,
                    vae=vae,
                    clip_vision_start_image=start_clip_condition,
                    clip_vision_end_image=end_clip_condition,
                    start_image=segment_start,
                    end_image=segment_end,
                )

                _send_status(
                    unique_id,
                    f"5/7 第 {segment_index + 1}/{segment_count} 段：采样中...",
                    progress_base + 0.18,
                )
                high_sampled = common_ksampler(
                    transition_model if conditioning_mode == "首尾帧" else model,
                    int(seed),
                    2,
                    1.0,
                    "euler_ancestral",
                    "simple",
                    segment_positive,
                    segment_negative,
                    segment_latent,
                    denoise=DEFAULT_DENOISE,
                    start_step=0,
                    last_step=1,
                    force_full_denoise=False,
                )[0]
                sampled = common_ksampler(
                    low_model,
                    int(seed),
                    2,
                    1.0,
                    "euler_ancestral",
                    "simple",
                    segment_positive,
                    segment_negative,
                    high_sampled,
                    denoise=DEFAULT_DENOISE,
                    disable_noise=True,
                    start_step=1,
                    last_step=2,
                    force_full_denoise=True,
                )[0]

                _send_status(
                    unique_id,
                    f"6/7 第 {segment_index + 1}/{segment_count} 段：VAE 解码...",
                    progress_base + 0.34,
                )
                decoded = VAEDecode().decode(vae, sampled)[0].detach().float().cpu().contiguous()
                if segment_index > 0 and int(decoded.shape[0]) > 1:
                    decoded = decoded[1:].contiguous()
                decoded_segment_frames.append(int(decoded.shape[0]))
                collected_segments.append(decoded)
                print(
                    "[GJJ_Wan22RapidAIOMega][SEGMENT_RESULT] "
                    + json.dumps(
                        {
                            "segment": f"{segment_index + 1}/{segment_count}",
                            "decoded_frames": int(decoded.shape[0]),
                            "decoded_shape": list(decoded.shape),
                            "conditioning_mode": conditioning_mode,
                            "effective_transition": segment_transition,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                segment_preview = _segment_preview_extra(
                    decoded,
                    float(output_fps or DEFAULT_FRAME_RATE),
                    str(filename_prefix or DEFAULT_VIDEO_PREFIX),
                    str(video_format or DEFAULT_VIDEO_FORMAT),
                    segment_index,
                )
                _send_status(
                    unique_id,
                    f"第 {segment_index + 1}/{segment_count} 段已生成，已更新节点预览",
                    min(0.86, progress_base + 0.44),
                    segment_preview,
                )

            _send_status(unique_id, "7/7 合并全部帧序列...", 0.88)
            frames = _concat_segments(collected_segments)
            # 给下游多图/视频节点保留原始素材边界。多段合并时后续段已经去掉
            # 重复首帧，因此每个场景边界等于累计帧数 - 1。
            if image_count > 1 and decoded_segment_frames:
                scene_frame_indices = [0]
                cumulative_frames = 0
                for decoded_count in decoded_segment_frames:
                    cumulative_frames += max(0, int(decoded_count))
                    scene_frame_indices.append(max(0, cumulative_frames - 1))
                scene_frame_indices = sorted({
                    min(max(0, int(index)), max(0, int(frames.shape[0]) - 1))
                    for index in scene_frame_indices
                })
                try:
                    frames.gjj_scene_frame_indices = scene_frame_indices
                    frames.gjj_source_image_count = int(image_count)
                except Exception:
                    pass
                print(
                    "[GJJ_Wan22RapidAIOMega][SCENE_BOUNDARIES] "
                    + json.dumps(
                        {
                            "source_image_count": int(image_count),
                            "total_frames": int(frames.shape[0]),
                            "scene_frame_indices": scene_frame_indices,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            output_audio = None
            if bool(audio_enabled):
                _send_status(unique_id, "7/7 使用 MMAudio 生成配音...", 0.94)
                from .gjj_mmaudio_nsfw_single import GJJ_MMAudioNSFWSingle

                audio_result = GJJ_MMAudioNSFWSingle().generate(
                    force_rate=float(output_fps or DEFAULT_FRAME_RATE),
                    custom_width=0,
                    custom_height=0,
                    frame_load_cap=0,
                    skip_first_frames=0,
                    select_every_nth=1,
                    duration_mode="源视频时长",
                    duration=max(0.1, int(frames.shape[0]) / max(1.0, float(output_fps or DEFAULT_FRAME_RATE))),
                    steps=150,
                    cfg=9.0,
                    seed=int(seed),
                    prompt=str(audio_prompt or DEFAULT_AUDIO_PROMPT),
                    negative_prompt=str(audio_negative_prompt or DEFAULT_AUDIO_NEGATIVE),
                    mask_away_clip=False,
                    force_offload=True,
                    base_precision="fp16",
                    feature_precision="fp16",
                    filename_prefix=str(filename_prefix or DEFAULT_VIDEO_PREFIX),
                    format_name=str(video_format or DEFAULT_VIDEO_FORMAT),
                    save_output=False,
                    pix_fmt="yuv420p",
                    crf="19",
                    mmaudio_model=str(audio_mmaudio_model or "").strip() or None,
                    vae_model=str(audio_vae_model or "").strip() or None,
                    synchformer_model=str(audio_synchformer_model or "").strip() or None,
                    clip_model=str(audio_clip_model or "").strip() or None,
                    source_media=frames,
                    unique_id=unique_id,
                )
                audio_tuple = audio_result.get("result") if isinstance(audio_result, dict) else audio_result
                video_output = audio_tuple[0]
                output_audio = audio_tuple[1] if isinstance(audio_tuple, (list, tuple)) and len(audio_tuple) > 1 else None
                if output_audio is None:
                    output_audio = _video_component_audio(video_output)
            else:
                video_output = None
            total_frames = int(frames.shape[0])
            encoded_video, encoded_video_path, encoded_ui = _combined_video_from_frames(
                frames,
                float(output_fps or DEFAULT_FRAME_RATE),
                output_audio,
                str(filename_prefix or DEFAULT_VIDEO_PREFIX),
                str(video_format or DEFAULT_VIDEO_FORMAT),
                unique_id=unique_id,
                save_output=True,
            )
            video_output = encoded_video
            video_component_frames = _video_component_frame_count(video_output)
            ui_payload = dict(encoded_ui or {})
            if ui_payload.get("preview_media") and not ui_payload.get("animated"):
                ui_payload["animated"] = [dict(item) for item in ui_payload.get("preview_media") or [] if isinstance(item, dict)]
            ui_payload.update(
                {
                    "mode_summary": [route_name],
                    "frame_count": [total_frames],
                    "frame_size": [f"{resolved_width}x{resolved_height}"],
                    "resolved_width": [resolved_width],
                    "resolved_height": [resolved_height],
                    "source_image_count": [image_count],
                    "auto_transition_prompt": [bool(auto_transition_prompt)],
                    "smooth_transition_segments": [
                        int(segment_count if auto_transition_prompt and image_count > 1 else 0)
                    ],
                    "video_component_frames": [video_component_frames],
                    "decoded_segment_frames": [",".join(str(value) for value in decoded_segment_frames)],
                    "encoded_video_path": [encoded_video_path],
                }
            )
            _send_status(unique_id, f"完成：{route_name}，共 {total_frames} 帧", 1.0, ui_payload)
            return {
                "ui": ui_payload,
                "result": (frames, video_output),
            }
        except RuntimeError as exc:
            _send_status(unique_id, f"执行失败：{str(exc).splitlines()[0]}", 0.0)
            raise
        except Exception as exc:
            _send_status(unique_id, "执行失败", 0.0)
            raise RuntimeError(
                "Wan2.2 Rapid-AIO Mega 节点执行失败。\n"
                f"Checkpoint：{checkpoint_name}\n"
                f"详细错误：{exc}"
            ) from exc


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Wan22RapidAIOMega}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 Wan多合一视频生成器(NSFW)"}
