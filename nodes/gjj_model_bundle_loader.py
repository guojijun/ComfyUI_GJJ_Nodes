from __future__ import annotations

import json
import os
import re

import folder_paths
import torch
import comfy.clip_vision
import comfy.sd
import comfy.utils
from aiohttp import web

try:
    from .gjj_multi_lora_chain import apply_lora_chain_config, normalize_lora_chain_data
except Exception:  # pragma: no cover - 允许单文件语法检查
    apply_lora_chain_config = None
    normalize_lora_chain_data = None

try:
    from server import PromptServer
except Exception:  # pragma: no cover - 单文件语法检查时可能没有 ComfyUI server
    PromptServer = None

try:
    from .gjj_model_family_preset_table import load_model_family_presets
except Exception:  # pragma: no cover
    load_model_family_presets = None


UNET_DTYPE_OPTIONS = ["default", "float16", "bfloat16", "float32", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"]
CLIP_TYPE_OPTIONS = [
    "stable_diffusion",
    "stable_cascade",
    "sd3",
    "stable_audio",
    "mochi",
    "flux",
    "ltx",
    "ltxv",
    "pixart",
    "cosmos",
    "lumina2",
    "wan",
    "hidream",
    "chroma",
    "ace",
    "omnigen2",
    "qwen_image",
    "hunyuan_image",
    "flux2",
    "ovis",
    "newbie",
    "longcat_image",
]
CLIP_DTYPE_OPTIONS = ["default", "float16", "bfloat16", "float32"]
CLIP_DEVICE_OPTIONS = ["default", "cpu"]
VAE_DTYPE_OPTIONS = ["default", "float16", "bfloat16", "float32"]
NODE_NAME = "GJJ_ModelBundleLoader"
LIST_API = "/gjj/model_bundle_loader_lists"
PRESET_LORA_SLOTS = (1, 2)
MODEL_EXTENSIONS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".sft", ".gguf")
MODEL_IGNORED_TOKENS = {
    "fp8",
    "fp16",
    "fp32",
    "bf16",
    "float8",
    "float16",
    "float32",
    "e4m3fn",
    "e5m2",
    "scaled",
    "fast",
    "mixed",
    "nvfp4",
    "mxfp4",
    "q2",
    "q3",
    "q4",
    "q5",
    "q6",
    "q8",
    "q8_0",
    "q4_0",
    "q4_1",
    "q5_0",
    "q5_1",
}


def _register_model_folder_path(folder_name: str, subdir: str) -> None:
    if not hasattr(folder_paths, "add_model_folder_path"):
        return
    try:
        folder_paths.add_model_folder_path(folder_name, os.path.join(folder_paths.models_dir, subdir))
    except Exception:
        pass


_register_model_folder_path("clip_vision", "clip_visions")


def _dedupe_keep_order(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in values:
        value = str(item or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _safe_filename_list(category: str) -> list[str]:
    try:
        return _dedupe_keep_order(list(folder_paths.get_filename_list(category)))
    except Exception:
        return []


def _default_value(values: list[str]) -> str:
    return values[0] if values else ""


def _normalize_text(value: str | None) -> str:
    return str(value or "").strip().lower()


def _model_stem(name: str) -> str:
    text = str(name or "").replace("\\", "/").rsplit("/", 1)[-1].strip().lower()
    for suffix in MODEL_EXTENSIONS:
        if text.endswith(suffix):
            return text[: -len(suffix)]
    return text


def _model_match_tokens(value: str) -> list[str]:
    stem = _model_stem(value)
    raw_tokens = [token for token in re.split(r"[^a-zA-Z0-9]+", stem.lower()) if token]
    tokens: list[str] = []
    for token in raw_tokens:
        if token in MODEL_IGNORED_TOKENS:
            continue
        if re.fullmatch(r"v\d+(?:\d+|\.\d+)*", token):
            continue
        tokens.append(token)
    return tokens


def _model_match_key(value: str) -> str:
    return "".join(_model_match_tokens(value))


def _shared_prefix_len(left: str, right: str) -> int:
    count = 0
    for a, b in zip(left, right):
        if a != b:
            break
        count += 1
    return count


def _pick_short_model_name(requested: str, available: list[str], fallback: str = "") -> str:
    query = _normalize_text(requested).replace("\\", "/")
    if not query:
        return fallback

    query_base = query.rsplit("/", 1)[-1]
    query_stem = _model_stem(query_base)
    query_key = _model_match_key(query_base)
    query_tokens = _model_match_tokens(query_base)
    available_by_lower = {str(name or "").replace("\\", "/").lower(): name for name in available}
    if query in available_by_lower:
        return available_by_lower[query]
    query_base_lower = query_base.lower()
    for name in available:
        filename = str(name or "").replace("\\", "/").rsplit("/", 1)[-1].lower()
        if filename == query_base_lower:
            return name

    def rank(name: str) -> tuple[int, int, int, str]:
        text = str(name or "").replace("\\", "/").lower()
        filename = text.rsplit("/", 1)[-1]
        stem = _model_stem(filename)
        key = _model_match_key(filename)
        tokens = _model_match_tokens(filename)
        allow_fuzzy = len(query_key) >= 4
        allow_stem_fuzzy = len(query_stem) >= 4
        if filename == f"{query_stem}.safetensors":
            bucket = 0
        elif stem == query_stem:
            bucket = 1
        elif filename.startswith(f"{query_stem}."):
            bucket = 2
        elif query_key and key == query_key:
            bucket = 3
        elif allow_fuzzy and key.startswith(query_key):
            bucket = 4
        elif allow_fuzzy and query_key in key:
            bucket = 5
        elif allow_fuzzy and query_tokens and all(token in tokens for token in query_tokens):
            bucket = 6
        elif allow_stem_fuzzy and stem.startswith(query_stem):
            bucket = 7
        elif allow_stem_fuzzy and query_stem in stem:
            bucket = 8
        elif allow_stem_fuzzy and query_stem in text:
            bucket = 9
        else:
            bucket = 999
        prefix_bonus = -_shared_prefix_len(query_key, key) if query_key and key else 0
        return (bucket, prefix_bonus, len(filename), len(text), text)

    candidates = [name for name in available if rank(name)[0] < 999]
    return sorted(candidates, key=rank)[0] if candidates else fallback


def _resolve_model_name(categories: tuple[str, ...], filename: str) -> str:
    available: list[str] = []
    for category in categories:
        available.extend(_safe_filename_list(category))
    resolved = _pick_short_model_name(filename, _dedupe_keep_order(available), str(filename or "").strip())
    if not str(resolved or "").strip():
        raise RuntimeError("模型文件名不能为空。")
    return resolved


def _resolve_model_name_and_category(categories: tuple[str, ...], filename: str) -> tuple[str, str]:
    raw = str(filename or "").strip()
    if not raw:
        raise RuntimeError("模型文件名不能为空。")
    for category in categories:
        resolved = _pick_short_model_name(raw, _safe_filename_list(category), "")
        if resolved:
            return category, resolved
    return (categories[0] if categories else "", raw)


def _resolve_full_path(categories: tuple[str, ...], filename: str) -> str:
    filename = _resolve_model_name(categories, filename)
    if not str(filename or "").strip():
        raise RuntimeError("模型文件名不能为空。")

    last_error: Exception | None = None
    for category in categories:
        try:
            return folder_paths.get_full_path_or_raise(category, filename)
        except Exception as exc:  # pragma: no cover - 依赖 ComfyUI 路径索引
            last_error = exc

    if last_error is not None:
        folders = " 或 ".join(f"models/{category}" for category in categories)
        raise RuntimeError(f"未找到模型文件：{filename}\n请把模型放到 {folders} 后，在节点上点击刷新按钮重新读取。") from last_error
    raise RuntimeError(f"未找到模型文件：{filename}")


def list_unet_models() -> list[str]:
    return _dedupe_keep_order(_safe_filename_list("diffusion_models") + _safe_filename_list("checkpoints"))


def list_checkpoint_models() -> list[str]:
    return _safe_filename_list("checkpoints")


def list_clip_models() -> list[str]:
    return _dedupe_keep_order(_safe_filename_list("text_encoders") + _safe_filename_list("clip"))


def list_vae_models() -> list[str]:
    return _safe_filename_list("vae")


def list_lora_models() -> list[str]:
    return _safe_filename_list("loras")


def list_model_patch_models() -> list[str]:
    return _safe_filename_list("model_patches")


def list_clip_vision_models() -> list[str]:
    return _safe_filename_list("clip_vision")


async def get_gjj_model_bundle_loader_lists(request):
    presets = load_model_family_presets() if load_model_family_presets is not None else []
    return web.json_response(
        {
            "folders": {
                "diffusion_models": list_unet_models(),
                "checkpoints": list_checkpoint_models(),
                "clip": list_clip_models(),
                "vae": list_vae_models(),
                "loras": list_lora_models(),
                "model_patches": list_model_patch_models(),
                "clip_vision": list_clip_vision_models(),
                "clip_visions": list_clip_vision_models(),
            },
            "unet_dtypes": UNET_DTYPE_OPTIONS,
            "clip_dtypes": CLIP_DTYPE_OPTIONS,
            "clip_devices": CLIP_DEVICE_OPTIONS,
            "vae_dtypes": VAE_DTYPE_OPTIONS,
            "clip_types": CLIP_TYPE_OPTIONS,
            "presets": presets,
        }
    )


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.get(LIST_API)(get_gjj_model_bundle_loader_lists)


def _torch_dtype_from_name(name: str) -> torch.dtype | None:
    value = _normalize_text(name)
    if value == "float16":
        return torch.float16
    if value == "bfloat16":
        return torch.bfloat16
    if value == "float32":
        return torch.float32
    if value == "fp8_e4m3fn" and hasattr(torch, "float8_e4m3fn"):
        return torch.float8_e4m3fn
    if value == "fp8_e5m2" and hasattr(torch, "float8_e5m2"):
        return torch.float8_e5m2
    return None


def _build_unet_model_options(weight_dtype: str) -> dict:
    model_options: dict = {}
    value = _normalize_text(weight_dtype)
    if value == "fp8_e4m3fn_fast" and hasattr(torch, "float8_e4m3fn"):
        model_options["dtype"] = torch.float8_e4m3fn
        model_options["fp8_optimizations"] = True
        return model_options

    dtype = _torch_dtype_from_name(weight_dtype)
    if dtype is not None:
        model_options["dtype"] = dtype
    return model_options


def _build_clip_model_options(dtype_name: str, device: str = "default") -> dict:
    model_options: dict = {}
    dtype = _torch_dtype_from_name(dtype_name)
    if dtype is not None:
        model_options["dtype"] = dtype
    if _normalize_text(device) == "cpu":
        cpu = torch.device("cpu")
        model_options["load_device"] = cpu
        model_options["offload_device"] = cpu
    return model_options


def _split_clip_names(value: str) -> list[str]:
    text = str(value or "").strip()
    if not text or text == "0":
        return []
    return _dedupe_keep_order([part.strip() for part in re.split(r"[\n|,]+", text) if part.strip() and part.strip() != "0"])


def _is_flux1_dual_clip(clip_type: str, clip_names: list[str]) -> bool:
    normalized_type = _normalize_text(clip_type)
    normalized_clips = "|".join(_normalize_text(name) for name in clip_names)
    return normalized_type in {"flux", "flux1"} or (
        "clip_l" in normalized_clips and "t5xxl" in normalized_clips
    )


def _is_flux_t5_name(name: str) -> bool:
    normalized = _normalize_text(name)
    return "t5xxl" in normalized or ("t5" in normalized and "xxl" in normalized)


def _normalize_flux1_clip_names(clip_names: list[str], fallback_clip_names: list[str] | None = None) -> list[str]:
    names = _dedupe_keep_order([str(name or "").strip() for name in clip_names])
    fallbacks = _dedupe_keep_order([str(name or "").strip() for name in (fallback_clip_names or [])])
    clip_l = next((name for name in names if "clip_l" in _normalize_text(name)), "")
    if not clip_l:
        clip_l = next((name for name in fallbacks if "clip_l" in _normalize_text(name)), "")
    t5 = next((name for name in names if _is_flux_t5_name(name)), "")
    if not t5:
        t5 = next((name for name in fallbacks if _is_flux_t5_name(name)), "")
    return _dedupe_keep_order([clip_l or "clip_l.safetensors", t5 or "t5xxl_fp16.safetensors"])


def _clip_type_enum(name: str):
    aliases = {
        "flux1": "flux",
        "ltx": "ltxv",
    }
    normalized = _normalize_text(name)
    enum_name = aliases.get(normalized, normalized).upper()
    return getattr(comfy.sd.CLIPType, enum_name, comfy.sd.CLIPType.STABLE_DIFFUSION)


def _find_preset(template_id: str) -> dict:
    target = str(template_id or "").strip()
    if not target or load_model_family_presets is None:
        return {}
    try:
        for preset in load_model_family_presets():
            if str(preset.get("id", "")).strip() == target:
                return preset
    except Exception:
        return {}
    return {}


def _preset_text(preset: dict, key: str) -> str:
    return str((preset or {}).get(key, "") or "").strip()


def _preset_clip_names(preset: dict) -> list[str]:
    value = (preset or {}).get("clip_names", [])
    if isinstance(value, str):
        return _split_clip_names(value)
    if isinstance(value, (list, tuple)):
        return _dedupe_keep_order([str(item or "").strip() for item in value if str(item or "").strip()])
    return []


def _preset_uses_split_bundle(preset: dict) -> bool:
    if not preset:
        return False
    if _normalize_text(_preset_text(preset, "model_category")) == "checkpoints":
        return False
    clip_names = _preset_clip_names(preset)
    clip_type = _preset_text(preset, "clip_type")
    return bool(
        clip_names
        or _preset_text(preset, "vae_name")
        or _is_flux1_dual_clip(clip_type, clip_names)
    )


def _bool_value(value, default: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    text = _normalize_text(value)
    if text in {"1", "true", "yes", "on", "enable", "enabled", "启用", "开"}:
        return True
    if text in {"0", "false", "no", "off", "disable", "disabled", "关闭", "关"}:
        return False
    return default


def _float_value(value, default: float) -> float:
    text = str(value if value is not None else "").strip()
    if not text:
        return default
    try:
        return float(text)
    except (TypeError, ValueError):
        return default


def _option_value(value, allowed: list[str], default: str) -> str:
    text = str(value or "").strip()
    if text in allowed:
        return text
    return default if default in allowed else (allowed[0] if allowed else "")


def _preset_lora_default(preset: dict, index: int) -> tuple[str, float]:
    name = _preset_text(preset, f"lora_{index}_name")
    strength = _float_value((preset or {}).get(f"lora_{index}_strength", 1.0), 1.0)
    return name, strength


def _preset_lora_chain_config(
    preset: dict,
    lora_1_enabled=True,
    lora_1_name="",
    lora_1_strength="",
    lora_2_enabled=True,
    lora_2_name="",
    lora_2_strength="",
) -> str:
    items: list[dict] = []
    runtime_values = {
        1: (lora_1_enabled, lora_1_name, lora_1_strength),
        2: (lora_2_enabled, lora_2_name, lora_2_strength),
    }
    for index in PRESET_LORA_SLOTS:
        default_name, default_strength = _preset_lora_default(preset, index)
        if not default_name:
            continue
        enabled, runtime_name, runtime_strength = runtime_values.get(index, (True, "", ""))
        if not _bool_value(enabled, bool(default_name and abs(default_strength) >= 1e-5)):
            continue
        name = str(runtime_name or default_name or "").strip()
        if not name:
            continue
        strength = _float_value(runtime_strength, default_strength)
        if abs(strength) < 1e-5:
            continue
        items.append({"enabled": True, "name": name, "strength": strength})
    return json.dumps(items, ensure_ascii=False) if items else ""


class GJJ_ModelBundleLoader:
    CATEGORY = "GJJ"
    FUNCTION = "load_models"
    DESCRIPTION = "一次性加载模型族模板中的扩散模型、CLIP、VAE、模型补丁、CLIP视觉模型，并附带常用采样参数输出。"
    SEARCH_ALIASES = ["简易加载器", "model loader", "easy loader", "UNET", "Checkpoint", "CLIP", "VAE", "MODEL_PATCH", "CLIP_VISION", "KSampler", "采样参数"]
    RETURN_TYPES = ("MODEL", "CLIP", "VAE", "MODEL_PATCH", "CLIP_VISION", "INT", "FLOAT", "FLOAT")
    RETURN_NAMES = ("扩散模型（model）", "文本编码（clip）", "图像解码（vae）", "模型补丁（model_patch）", "CLIP视觉（clip_vision）", "步数（steps）", "CFG", "降噪（denoise）")
    OUTPUT_TOOLTIPS = (
        "当前节点加载完成后的 UNET / 扩散模型输出。",
        "当前节点加载完成后的 CLIP / 文本编码器输出。",
        "当前节点加载完成后的 VAE 模型输出。",
        "当前模板需要的 MODEL_PATCH 输出，例如 bytedance-uso 的 projector。",
        "当前模板需要的 CLIP_VISION 输出，例如 bytedance-uso 的 SigCLIP 视觉编码器。",
        "可直接连接到 KSampler 的 steps 输入。",
        "可直接连接到 KSampler 的 cfg 输入。",
        "可直接连接到 KSampler 的 denoise 输入。",
    )

    def __init__(self):
        self.loaded_lora: tuple[str, object] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        unet_models = list_unet_models() or [""]
        clip_models = list_clip_models() or [""]
        vae_models = list_vae_models() or [""]
        return {
            "required": {
                "unet_name": (
                    "STRING",
                    {
                        "default": _default_value(unet_models),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "💜 UNET 模型",
                        "tooltip": "选择主扩散模型文件，风格上采用 easy-use 那种标准 ComfyUI 简洁加载器排版。",
                    },
                ),
                "unet_dtype": (
                    "STRING",
                    {
                        "default": "default",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "💜 UNET 精度",
                        "tooltip": "设置 UNET 的加载精度；default 表示交给 ComfyUI 自动处理。",
                    },
                ),
                "clip_name": (
                    "STRING",
                    {
                        "default": _default_value(clip_models),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "💛 CLIP 模型",
                        "tooltip": "选择文本编码器模型；自动兼容 text_encoders / clip 两类目录。多编码器会用 | 分隔。",
                    },
                ),
                "clip_type": (
                    "STRING",
                    {
                        "default": "stable_diffusion",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "💛 CLIP 类型",
                        "tooltip": "设置文本编码器架构类型，通常需要与所选 UNET 架构匹配。",
                    },
                ),
                "clip_dtype": (
                    "STRING",
                    {
                        "default": "default",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "💛 CLIP 精度",
                        "tooltip": "设置 CLIP 的加载精度；default 表示交给 ComfyUI 自动处理。",
                    },
                ),
                "vae_name": (
                    "STRING",
                    {
                        "default": _default_value(vae_models),
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "❤️ VAE 模型",
                        "tooltip": "选择 VAE 模型，建议优先使用与当前 UNET 同体系的版本。",
                    },
                ),
                "vae_dtype": (
                    "STRING",
                    {
                        "default": "default",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "❤️ VAE 精度",
                        "tooltip": "设置 VAE 的加载精度；default 表示交给 ComfyUI 自动处理。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 20,
                        "min": 1,
                        "max": 10000,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "步数",
                        "tooltip": "默认采样步数，可直接输出给 KSampler 的 steps。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "CFG 引导强度",
                        "tooltip": "默认提示词引导强度，可直接输出给 KSampler 的 cfg。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "降噪",
                        "tooltip": "默认降噪强度，可直接输出给 KSampler 的 denoise。",
                    },
                ),
                "template_id": (
                    "STRING",
                    {
                        "default": "",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "模型族模板",
                        "tooltip": "由前端模板选择写入，用于保存当前模型族；后端会按模板补齐 checkpoint、LoRA、模型补丁和 CLIP视觉模型。",
                    },
                ),
                "model_patch_name": (
                    "STRING",
                    {
                        "default": "",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "模型补丁",
                        "tooltip": "由模板写入；需要时加载 models/model_patches 下的 MODEL_PATCH 文件。",
                    },
                ),
                "clip_vision_name": (
                    "STRING",
                    {
                        "default": "",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "CLIP视觉",
                        "tooltip": "由模板写入；需要时加载 models/clip_vision 或 models/clip_visions 下的 CLIP_VISION 文件。",
                    },
                ),
                "preset_lora_1_enabled": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "预设LoRA 1 启用",
                        "tooltip": "控制模板自带的第 1 个 LoRA 是否随模型一起加载；关闭后只加载基础模型。",
                    },
                ),
                "preset_lora_1_name": (
                    "STRING",
                    {
                        "default": "",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "预设LoRA 1",
                        "tooltip": "模板自带的第 1 个 LoRA；前端会自动匹配本地 models/loras 下的文件。",
                    },
                ),
                "preset_lora_1_strength": (
                    "STRING",
                    {
                        "default": "",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "预设LoRA 1 强度",
                        "tooltip": "模板自带第 1 个 LoRA 的模型强度；留空时使用模板默认强度。",
                    },
                ),
                "preset_lora_2_enabled": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "预设LoRA 2 启用",
                        "tooltip": "控制模板自带的第 2 个 LoRA 是否随模型一起加载；关闭后不会应用该 LoRA。",
                    },
                ),
                "preset_lora_2_name": (
                    "STRING",
                    {
                        "default": "",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "预设LoRA 2",
                        "tooltip": "模板自带的第 2 个 LoRA；前端会自动匹配本地 models/loras 下的文件。",
                    },
                ),
                "preset_lora_2_strength": (
                    "STRING",
                    {
                        "default": "",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "预设LoRA 2 强度",
                        "tooltip": "模板自带第 2 个 LoRA 的模型强度；留空时使用模板默认强度。",
                    },
                ),
                "flux_clip_l_name": (
                    "STRING",
                    {
                        "default": "clip_l.safetensors",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "Flux1 固定 CLIP",
                        "tooltip": "Flux1 双 CLIP 的第一个编码器，默认 clip_l.safetensors；前端放在 CLIP 齿轮参数中。",
                    },
                ),
                "clip_device": (
                    "STRING",
                    {
                        "default": "default",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "💛 CLIP 设备",
                        "tooltip": "CLIP 加载设备；default 跟随 ComfyUI，低显存时可改成 cpu。",
                    },
                ),
            },
            "optional": {
                "use_lora": (
                    "BOOLEAN",
                    {
                        "forceInput": True,
                        "display_name": "使用LoRA",
                        "tooltip": "可选外部开关。接入后，模板自带 LoRA 是否启用由这个布尔输入控制；不接入时使用面板中的 LoRA 开关。",
                    },
                ),
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "forceInput": True,
                        "display_name": "🧬 额外LoRA串联配置",
                        "tooltip": "可选接入 GJJ · 🧬 额外LoRA串联配置；会在模型加载完成后按顺序叠加到 MODEL 与 CLIP。",
                    },
                ),
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    @classmethod
    def IS_CHANGED(
        cls,
        unet_name,
        unet_dtype,
        clip_name,
        clip_type,
        clip_dtype,
        vae_name,
        vae_dtype,
        steps,
        cfg,
        denoise,
        template_id="",
        model_patch_name="",
        clip_vision_name="",
        preset_lora_1_enabled=True,
        preset_lora_1_name="",
        preset_lora_1_strength="",
        preset_lora_2_enabled=True,
        preset_lora_2_name="",
        preset_lora_2_strength="",
        flux_clip_l_name="",
        clip_device="default",
        use_lora=None,
        lora_chain_config="",
    ):
        return "|".join(
            [
                str(unet_name),
                str(unet_dtype),
                str(clip_name),
                str(clip_type),
                str(clip_dtype),
                str(vae_name),
                str(vae_dtype),
                str(steps),
                str(cfg),
                str(denoise),
                str(template_id),
                str(model_patch_name),
                str(clip_vision_name),
                str(preset_lora_1_enabled),
                str(preset_lora_1_name),
                str(preset_lora_1_strength),
                str(preset_lora_2_enabled),
                str(preset_lora_2_name),
                str(preset_lora_2_strength),
                str(flux_clip_l_name),
                str(clip_device),
                str(use_lora),
                str(lora_chain_config),
            ]
        )

    def _load_vae(self, vae_name: str, vae_dtype: str):
        vae_path = _resolve_full_path(("vae",), vae_name)
        sd, metadata = comfy.utils.load_torch_file(vae_path, return_metadata=True)
        dtype = _torch_dtype_from_name(vae_dtype)
        vae = comfy.sd.VAE(sd=sd, metadata=metadata, dtype=dtype)
        vae.throw_exception_if_invalid()
        return vae

    def _load_checkpoint(self, ckpt_name: str, unet_dtype: str, clip_dtype: str, clip_device: str):
        ckpt_path = _resolve_full_path(("checkpoints",), ckpt_name)
        out = comfy.sd.load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            model_options=_build_unet_model_options(unet_dtype),
            te_model_options=_build_clip_model_options(clip_dtype, clip_device),
        )
        return out[:3]

    def _load_split_bundle(
        self,
        unet_name: str,
        unet_dtype: str,
        clip_name: str,
        clip_type: str,
        clip_dtype: str,
        clip_device: str,
        vae_name: str,
        vae_dtype: str,
        unet_categories: tuple[str, ...] = ("diffusion_models",),
    ):
        if not str(clip_name or "").strip():
            raise RuntimeError("CLIP 模型不能为空。")
        if not str(vae_name or "").strip():
            raise RuntimeError("VAE 模型不能为空。")

        unet_name = _resolve_model_name(unet_categories, unet_name)
        clip_names = _split_clip_names(clip_name)
        if not clip_names:
            raise RuntimeError("CLIP 模型不能为空。")
        if _is_flux1_dual_clip(clip_type, clip_names):
            clip_names = _normalize_flux1_clip_names(clip_names)
            clip_type = "flux"
            if len(clip_names) < 2:
                raise RuntimeError("Flux 1 双 CLIP 需要同时提供 clip_l 与 T5 XXL 编码器。")
        clip_names = [_resolve_model_name(("text_encoders", "clip"), name) for name in clip_names]
        vae_name = _resolve_model_name(("vae",), vae_name)

        unet_path = _resolve_full_path(unet_categories, unet_name)
        model = comfy.sd.load_diffusion_model(unet_path, model_options=_build_unet_model_options(unet_dtype))

        clip_paths = [_resolve_full_path(("text_encoders", "clip"), name) for name in clip_names]
        clip = comfy.sd.load_clip(
            ckpt_paths=clip_paths,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=_clip_type_enum(clip_type),
            model_options=_build_clip_model_options(clip_dtype, clip_device),
        )

        vae = self._load_vae(vae_name, vae_dtype)
        return model, clip, vae

    def _load_model_patch(self, model_patch_name: str):
        name = str(model_patch_name or "").strip()
        if not name:
            return None
        resolved = _resolve_model_name(("model_patches",), name)
        try:
            from comfy_extras.nodes_model_patch import ModelPatchLoader
        except Exception as exc:
            raise RuntimeError("当前 ComfyUI 环境缺少 ModelPatchLoader，无法加载模型补丁。") from exc
        return ModelPatchLoader().load_model_patch(resolved)[0]

    def _load_clip_vision(self, clip_vision_name: str):
        name = str(clip_vision_name or "").strip()
        if not name:
            return None
        clip_path = _resolve_full_path(("clip_vision",), name)
        clip_vision = comfy.clip_vision.load(clip_path)
        if clip_vision is None:
            raise RuntimeError(f"加载 CLIP视觉模型失败：{name}")
        return clip_vision

    def load_models(
        self,
        unet_name,
        unet_dtype,
        clip_name,
        clip_type,
        clip_dtype,
        vae_name,
        vae_dtype,
        steps,
        cfg,
        denoise,
        template_id="",
        model_patch_name="",
        clip_vision_name="",
        preset_lora_1_enabled=True,
        preset_lora_1_name="",
        preset_lora_1_strength="",
        preset_lora_2_enabled=True,
        preset_lora_2_name="",
        preset_lora_2_strength="",
        flux_clip_l_name="",
        clip_device="default",
        use_lora=None,
        lora_chain_config="",
    ):
        preset = _find_preset(template_id)
        unet_dtype = _option_value(unet_dtype, UNET_DTYPE_OPTIONS, "default")
        clip_type = _option_value(clip_type, CLIP_TYPE_OPTIONS, "stable_diffusion")
        clip_dtype = _option_value(clip_dtype, CLIP_DTYPE_OPTIONS, "default")
        clip_device = _option_value(clip_device, CLIP_DEVICE_OPTIONS, "default")
        vae_dtype = _option_value(vae_dtype, VAE_DTYPE_OPTIONS, "default")
        preset_model_name = _preset_text(preset, "model_name")
        model_category = _normalize_text(_preset_text(preset, "model_category"))
        preset_is_checkpoint = model_category == "checkpoints"
        preset_clip_names = _preset_clip_names(preset)
        preset_vae_name = _preset_text(preset, "vae_name")
        preset_clip_type = _preset_text(preset, "clip_type")
        if preset_model_name and str(unet_name or "").strip() in {"", "0"}:
            unet_name = preset_model_name
        if not preset_is_checkpoint and preset_clip_names and not str(clip_name or "").strip():
            clip_name = "|".join(preset_clip_names)
        if not preset_is_checkpoint and preset_vae_name and not str(vae_name or "").strip():
            vae_name = preset_vae_name
        if not preset_is_checkpoint and preset_clip_type and (
            not str(clip_type or "").strip()
            or (
                _is_flux1_dual_clip(preset_clip_type, preset_clip_names)
                and _normalize_text(clip_type) == "stable_diffusion"
            )
        ):
            clip_type = preset_clip_type
        flux1_dual_clip = (not preset_is_checkpoint) and _is_flux1_dual_clip(str(clip_type or preset_clip_type or ""), _split_clip_names(str(clip_name or "")) + preset_clip_names)
        if flux1_dual_clip:
            runtime_clip_names = _split_clip_names(str(clip_name or ""))
            fixed_clip_l = str(flux_clip_l_name or "").strip()
            if fixed_clip_l:
                runtime_clip_names = [fixed_clip_l] + [name for name in runtime_clip_names if "clip_l" not in _normalize_text(name)]
            clip_name = "|".join(_normalize_flux1_clip_names(runtime_clip_names, preset_clip_names))
            clip_type = "flux"
            if preset_vae_name:
                vae_name = preset_vae_name
        if not str(unet_name or "").strip():
            raise RuntimeError("扩散模型不能为空。")
        categories = ("checkpoints", "diffusion_models") if model_category == "checkpoints" else ("diffusion_models", "checkpoints")
        main_category, resolved_unet_name = _resolve_model_name_and_category(categories, unet_name)
        manual_flux_split = (
            main_category != "checkpoints"
            and _is_flux1_dual_clip(str(clip_type or ""), _split_clip_names(str(clip_name or "")))
            and bool(str(vae_name or "").strip())
        )
        split_bundle = main_category != "checkpoints" or manual_flux_split
        if main_category == "checkpoints" and not split_bundle:
            unet, clip, vae = self._load_checkpoint(resolved_unet_name, unet_dtype, clip_dtype, clip_device)
        else:
            unet, clip, vae = self._load_split_bundle(
                resolved_unet_name,
                unet_dtype,
                clip_name,
                clip_type,
                clip_dtype,
                clip_device,
                vae_name,
                vae_dtype,
                (main_category,),
            )

        external_use_lora = use_lora if use_lora is not None else None
        lora_1_enabled = external_use_lora if external_use_lora is not None else preset_lora_1_enabled
        lora_2_enabled = external_use_lora if external_use_lora is not None else preset_lora_2_enabled
        preset_lora_config = _preset_lora_chain_config(
            preset,
            lora_1_enabled,
            preset_lora_1_name,
            preset_lora_1_strength,
            lora_2_enabled,
            preset_lora_2_name,
            preset_lora_2_strength,
        )
        if preset_lora_config:
            if apply_lora_chain_config is None or normalize_lora_chain_data is None:
                raise RuntimeError("当前环境未能加载 GJJ LoRA 串联工具，无法应用模板默认LoRA。")
            unet, _, self.loaded_lora = apply_lora_chain_config(
                unet,
                None,
                lora_data=normalize_lora_chain_data(preset_lora_config),
                loaded_lora_cache=self.loaded_lora,
            )

        if str(lora_chain_config or "").strip():
            if apply_lora_chain_config is None or normalize_lora_chain_data is None:
                raise RuntimeError("当前环境未能加载 GJJ LoRA 串联工具，无法应用额外LoRA串联配置。")
            unet, clip, self.loaded_lora = apply_lora_chain_config(
                unet,
                clip,
                lora_data=normalize_lora_chain_data(lora_chain_config),
                loaded_lora_cache=self.loaded_lora,
            )

        model_patch = self._load_model_patch(model_patch_name or _preset_text(preset, "model_patch_name"))
        clip_vision = self._load_clip_vision(clip_vision_name or _preset_text(preset, "clip_vision_name"))

        return (unet, clip, vae, model_patch, clip_vision, int(steps), float(cfg), float(denoise))


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ModelBundleLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📦 图像模型加载器"}
