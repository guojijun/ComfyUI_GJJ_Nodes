from __future__ import annotations

import json
import math
import os
import re
import struct
import time
from pathlib import Path
from typing import Any

import comfy.samplers
import comfy.model_management
import folder_paths
import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from nodes import CLIPLoader, CLIPTextEncode, ConditioningZeroOut, SaveImage, UNETLoader, VAEDecode, VAELoader

try:
    from comfy_extras.nodes_custom_sampler import DualModelGuider, KSamplerSelect, RandomNoise, SamplerCustomAdvanced, CFGOverride
except Exception as exc:  # pragma: no cover - only hit on old ComfyUI builds
    DualModelGuider = KSamplerSelect = RandomNoise = SamplerCustomAdvanced = CFGOverride = None
    _CUSTOM_SAMPLER_IMPORT_ERROR = exc
else:
    _CUSTOM_SAMPLER_IMPORT_ERROR = None

try:
    from comfy_extras.nodes_flux import EmptyFlux2LatentImage
except Exception as exc:  # pragma: no cover - only hit on old ComfyUI builds
    EmptyFlux2LatentImage = None
    _FLUX_IMPORT_ERROR = exc
else:
    _FLUX_IMPORT_ERROR = None

from .gjj_model_name_resolver import pick_available_model_name, model_lookup_stem
from .gjj_multi_lora_chain import apply_lora_chain_config, normalize_lora_chain_data
from .common_utils.temp_files import gjjutils_write_temp_tensor_images


NODE_NAME = "GJJ_Ideogram4DirectGenerator"
DEFAULT_PROMPT = (
    "{\n"
    '  "high_level_description": "一张精致的 Ideogram 4 风格海报，主体清晰，构图大胆，文字干净可读。",\n'
    '  "style_description": {\n'
    '    "aesthetics": "高级商业视觉，干净排版，细节丰富",\n'
    '    "lighting": "柔和但有层次的工作室光线",\n'
    '    "medium": "mixed-media digital poster"\n'
    "  }\n"
    "}"
)

MODE_PRESETS = {
    "质量": {"steps": 48, "mu": 0.0, "std": 1.5, "preset_id": "V4_QUALITY_48"},
    "默认": {"steps": 20, "mu": 0.0, "std": 1.75, "preset_id": "V4_DEFAULT_20"},
    "极速": {"steps": 12, "mu": 0.5, "std": 1.75, "preset_id": "V4_TURBO_12"},
}
MODE_NAMES = list(MODE_PRESETS.keys())

MODEL_SLOTS = {
    "unet_name": {
        "category": "diffusion_models",
        "seed": "ideogram4_fp8_scaled.safetensors",
        "label": "主扩散模型",
        "models_path": "models/diffusion_models/ideogram4_fp8_scaled.safetensors",
    },
    "uncond_unet_name": {
        "category": "diffusion_models",
        "seed": "ideogram4_unconditional_fp8_scaled.safetensors",
        "label": "无条件扩散模型",
        "models_path": "models/diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors",
    },
    "clip_name": {
        "category": "text_encoders",
        "seed": "qwen3vl_8b_fp8_scaled.safetensors",
        "label": "Ideogram 4 文本编码器",
        "models_path": "models/text_encoders/qwen3vl_8b_fp8_scaled.safetensors",
    },
    "vae_name": {
        "category": "vae",
        "seed": "flux2-vae.safetensors",
        "label": "Flux2 VAE",
        "models_path": "models/vae/flux2-vae.safetensors",
    },
}

IDEOGRAM4_MODEL_TREE = [
    {
        "label": "Flux2 VAE",
        "path": "models/vae",
        "filename": "flux2-vae.safetensors",
        "description": "放到 ComfyUI/models/vae/flux2-vae.safetensors。",
    },
    {
        "label": "主扩散模型",
        "path": "models/diffusion_models",
        "filename": "ideogram4_fp8_scaled.safetensors",
        "description": "放到 ComfyUI/models/diffusion_models/ideogram4_fp8_scaled.safetensors。",
    },
    {
        "label": "无条件扩散模型",
        "path": "models/diffusion_models",
        "filename": "ideogram4_unconditional_fp8_scaled.safetensors",
        "description": "放到 ComfyUI/models/diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors。",
    },
    {
        "label": "Ideogram 4 文本编码器",
        "path": "models/text_encoders",
        "filename": "qwen3vl_8b_fp8_scaled.safetensors",
        "description": "放到 ComfyUI/models/text_encoders/qwen3vl_8b_fp8_scaled.safetensors。",
    },
]


def _unwrap(value: Any, index: int = 0) -> Any:
    if isinstance(value, (tuple, list)):
        return value[index] if len(value) > index else None
    args = getattr(value, "args", None)
    if isinstance(args, (tuple, list)):
        return args[index] if len(args) > index else None
    for attr in ("result", "results", "output", "outputs", "value", "values"):
        item = getattr(value, attr, None)
        if item is None or callable(item):
            continue
        if isinstance(item, (tuple, list)):
            return item[index] if len(item) > index else None
        if isinstance(item, dict):
            values = list(item.values())
            return values[index] if len(values) > index else None
        return item
    try:
        return value[index]
    except Exception:
        return value


def _align16(value: Any) -> int:
    try:
        number = int(float(value))
    except Exception:
        number = 1024
    return max(((max(1, number) + 15) // 16) * 16, 256)


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync("gjj_node_progress", {"node": str(unique_id), "text": str(text or "处理中...")})
    except Exception:
        pass


def _send_test_preview(
    unique_id: Any,
    images: list[dict[str, Any]],
    completed: int,
    total: int,
    reset: bool = False,
) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_ideogram4_test_preview",
            {
                "node": str(unique_id),
                "images": list(images or []),
                "completed": max(0, int(completed)),
                "total": max(0, int(total)),
                "reset": bool(reset),
            },
        )
    except Exception:
        pass


def _filename_list(category: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(category) or [])
    except Exception:
        return []


def _related_model_choices(category: str, seed: str, widget_name: str = "") -> list[str]:
    names = [name for name in _filename_list(category) if str(name or "").strip()]
    if widget_name:
        names = [name for name in names if _matches_ideogram4_branch(widget_name, name)]
    if not names:
        return [seed]
    seed_key = model_lookup_stem(seed).casefold().replace(" ", "")
    related = []
    for name in names:
        key = model_lookup_stem(name).casefold().replace(" ", "")
        if seed_key and (seed_key in key or key in seed_key):
            related.append(name)
    selected = pick_available_model_name(seed, related or names, "", allow_first=True)
    ordered: list[str] = []
    for name in [selected] + related + names:
        if name and name not in ordered:
            ordered.append(name)
    return ordered or [seed]


def _model_default(widget_name: str, choices: list[str]) -> str:
    seed = MODEL_SLOTS[widget_name]["seed"]
    return pick_available_model_name(seed, choices, "", allow_first=True) or (choices[0] if choices else seed)


def _matches_ideogram4_branch(widget_name: str, model_name: str) -> bool:
    normalized = model_lookup_stem(model_name).casefold().replace("-", "_")
    is_unconditional = "unconditional" in normalized or "uncond" in normalized
    if widget_name == "unet_name":
        return not is_unconditional
    if widget_name == "uncond_unet_name":
        return is_unconditional
    return True


def _ideogram4_pair_key(model_name: Any) -> str:
    stem = Path(str(model_name or "").replace("\\", "/")).stem.casefold()
    stem = re.sub(r"(?:unconditional|uncond)", "", stem)
    return re.sub(r"[^a-z0-9]+", "", stem)


def _find_unconditional_pair(main_model_name: Any) -> str:
    main_key = _ideogram4_pair_key(main_model_name)
    candidates = [
        name
        for name in _filename_list("diffusion_models")
        if _matches_ideogram4_branch("uncond_unet_name", name)
    ]
    exact = [name for name in candidates if _ideogram4_pair_key(name) == main_key]
    if exact:
        return sorted(exact, key=lambda name: (len(str(name)), str(name).casefold()))[0]
    return ""


def _model_size_bytes(model_name: Any) -> int:
    try:
        path = folder_paths.get_full_path("diffusion_models", str(model_name or ""))
        return int(os.path.getsize(path)) if path else 0
    except Exception:
        return 0


def _format_model_size(size: int) -> str:
    value = max(0, int(size or 0))
    for suffix, divisor in (("TB", 1024**4), ("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)):
        if value >= divisor:
            number = value / divisor
            number_text = f"{number:.2f}".rstrip("0").rstrip(".")
            return f"{number_text}{suffix}"
    return f"{value}B"


def _safe_test_filename_part(value: Any) -> str:
    stem = Path(str(value or "").replace("\\", "/")).stem
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", stem).strip(" ._")
    return cleaned or "Ideogram4"


def _test_label_font(size: int) -> ImageFont.ImageFont:
    for name in ("msyh.ttc", "simhei.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, max(10, int(size)))
        except Exception:
            pass
    return ImageFont.load_default()


def _trim_test_label(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    max_width: int,
) -> str:
    if draw.textbbox((0, 0), text, font=font)[2] <= max_width:
        return text
    suffix = "..."
    low, high = 0, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        candidate = text[:middle] + suffix
        if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
            low = middle
        else:
            high = middle - 1
    return text[:low] + suffix


def _append_test_model_label(
    images: torch.Tensor,
    model_name: str,
    elapsed: float,
    model_size: int,
) -> torch.Tensor:
    labeled: list[torch.Tensor] = []
    label = (
        f"{_safe_test_filename_part(model_name)}_"
        f"{max(0.0, float(elapsed)):.2f}秒_"
        f"{_format_model_size(model_size)}"
    )
    for tensor in images:
        array = (
            tensor.detach()
            .to(device="cpu", dtype=torch.float32)
            .clamp(0.0, 1.0)
            .mul(255.0)
            .round()
            .to(torch.uint8)
            .numpy()
        )
        image = Image.fromarray(array, mode="RGB")
        font_size = max(14, min(30, image.width // 48))
        footer_height = max(38, int(font_size * 1.9))
        canvas = Image.new("RGB", (image.width, image.height + footer_height), (10, 17, 22))
        canvas.paste(image, (0, 0))
        draw = ImageDraw.Draw(canvas)
        font = _test_label_font(font_size)
        padding = max(10, font_size // 2)
        fitted_label = _trim_test_label(draw, label, font, image.width - padding * 2)
        text_box = draw.textbbox((0, 0), fitted_label, font=font)
        text_height = text_box[3] - text_box[1]
        text_y = image.height + max(0, (footer_height - text_height) // 2 - text_box[1])
        draw.text((padding, text_y), fitted_label, fill=(238, 242, 245), font=font)
        labeled.append(torch.from_numpy(np.asarray(canvas).copy()).to(torch.float32) / 255.0)
    return torch.stack(labeled, dim=0).to(device=images.device, dtype=images.dtype)


def _standard_queue_images(images: list[Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in images or []:
        if not isinstance(item, dict):
            continue
        image = {
            "filename": item.get("filename", ""),
            "subfolder": item.get("subfolder", ""),
            "type": item.get("type", "temp"),
        }
        for key in ("width", "height", "format"):
            if item.get(key) not in (None, ""):
                image[key] = item.get(key)
        result.append(image)
    return result


def _resolve_model_selection(widget_name: str, selected: Any) -> str:
    slot = MODEL_SLOTS[widget_name]
    names = [
        name for name in _filename_list(slot["category"])
        if _matches_ideogram4_branch(widget_name, name)
    ]
    preferred = str(selected or "").strip()
    resolved = pick_available_model_name(
        preferred,
        names,
        slot["seed"],
        allow_first=False,
    )
    if resolved:
        return resolved
    raise RuntimeError(
        f"未找到{slot['label']}：{preferred or slot['seed']}\n"
        f"请将模型放到 ComfyUI/{slot['models_path']}，或在节点设置中重新选择。"
    )


def _safetensors_keys(path: str) -> set[str]:
    try:
        with open(path, "rb") as handle:
            header_size_raw = handle.read(8)
            if len(header_size_raw) != 8:
                return set()
            header_size = struct.unpack("<Q", header_size_raw)[0]
            if header_size <= 0 or header_size > 64 * 1024 * 1024:
                return set()
            header = json.loads(handle.read(header_size).decode("utf-8"))
        return {str(key) for key in header if key != "__metadata__"}
    except Exception:
        return set()


def _prefer_native_ideogram4_model(model_name: str) -> str:
    if str(model_name or "").strip().lower().endswith(".gguf"):
        return model_name
    try:
        model_path = folder_paths.get_full_path("diffusion_models", model_name)
    except Exception:
        model_path = None
    if not model_path:
        return model_name

    keys = _safetensors_keys(model_path)
    has_diffusers_attention = "layers.0.attention.to_q.weight" in keys
    has_native_attention = "layers.0.attention.qkv.weight" in keys
    if not has_diffusers_attention or has_native_attention:
        return model_name

    source = Path(model_path)
    converted = source.with_name(f"{source.stem}_comfy{source.suffix}")
    if converted.is_file():
        try:
            relative = converted.relative_to(Path(folder_paths.get_folder_paths("diffusion_models")[0]))
            return str(relative).replace("\\", "/")
        except Exception:
            available = _filename_list("diffusion_models")
            converted_key = converted.name.casefold()
            for candidate in available:
                if Path(candidate).name.casefold() == converted_key:
                    return candidate

    raise RuntimeError(
        f"模型仍是 Diffusers 权重格式，不能直接交给 ComfyUI UNETLoader：{model_name}\n"
        "请先将每层 attention.to_q/to_k/to_v 合并为 attention.qkv，"
        "并将 attention.to_out.0 改名为 attention.o；"
        f"也可以在同目录放置已转换文件：{converted.name}"
    )


def _load_ideogram4_unet(model_name: str, weight_dtype: str) -> Any:
    if not str(model_name or "").strip().lower().endswith(".gguf"):
        return _unwrap(UNETLoader().load_unet(model_name, weight_dtype))
    try:
        from ..vendor.gjj_gguf_runtime import load_unet_gguf
    except ImportError:
        from vendor.gjj_gguf_runtime import load_unet_gguf
    try:
        return load_unet_gguf(model_name)
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", "") == "gguf":
            raise RuntimeError(
                "加载 Ideogram 4 GGUF 需要 gguf Python 依赖；"
                "请安装 requirements-optional.txt 后重启 ComfyUI。"
            ) from exc
        raise
    except Exception as exc:
        raise RuntimeError(f"GJJ 内置 GGUF UNET 加载失败：{model_name}\n{exc}") from exc


def _ideogram4_sigmas(steps: int, width: int, height: int, mu: float, std: float) -> torch.Tensor:
    logs_nr_min = -15.0
    logs_nr_max = 18.0
    mean = float(mu) + 0.5 * math.log((int(width) * int(height)) / (512 * 512))
    u = torch.linspace(0.0, 1.0, int(steps) + 1, dtype=torch.float64)
    t = 1.0 - torch.special.expit(mean + float(std) * torch.special.ndtri(u))
    t_min = 1.0 / (1.0 + math.exp(0.5 * logs_nr_max))
    t_max = 1.0 / (1.0 + math.exp(0.5 * logs_nr_min))
    sigmas = (1.0 - t.clamp(t_min, t_max)).flip(0)
    sigmas[-1] = 0.0
    return sigmas.to(torch.float32)


def _missing_core_error() -> None:
    errors = []
    if _CUSTOM_SAMPLER_IMPORT_ERROR is not None:
        errors.append(f"自定义采样器节点：{_CUSTOM_SAMPLER_IMPORT_ERROR}")
    if _FLUX_IMPORT_ERROR is not None:
        errors.append(f"Flux2 Latent 节点：{_FLUX_IMPORT_ERROR}")
    if errors:
        raise RuntimeError("当前 ComfyUI 缺少 Ideogram 4 工作流需要的官方内置节点。\n" + "\n".join(errors))


def _stage_error(stage: str, exc: Exception) -> RuntimeError:
    return RuntimeError(f"{stage}失败。\n详细错误：{exc}")


class GJJ_Ideogram4DirectGenerator:
    CATEGORY = "GJJ/🎬 视频/文本生成"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = "Ideogram 4 文生图零依赖单节点：内部完成模型加载、提示词编码、Ideogram 调度、双模型 CFG 采样和 VAE 解码。"
    SEARCH_ALIASES = ["ideogram4", "ideogram", "文生图", "海报", "单节点"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("生成图像",)
    OUTPUT_TOOLTIPS = ("按 Ideogram 4 官方文生图链路生成的 IMAGE 批量。",)
    GJJ_HELP = {
        "description": DESCRIPTION,
        "model_tree": IDEOGRAM4_MODEL_TREE,
        "models": IDEOGRAM4_MODEL_TREE,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "modes": MODE_PRESETS,
        "notice": "⚡按钮会从画布中的 GJJ_TemplateParams 读取 width/宽度 与 height/高度，并按 16 倍数向上对齐，最小 256。模型下拉会使用 GJJ 公共模型名解析函数，去除扩展名和 fp8/bf16/scaled 等量化精度标记后匹配，并保留子目录相对路径。",
        "model_download_url": "https://huggingface.co/Comfy-Org/Ideogram-4",
    }

    def __init__(self):
        self.loaded_lora: tuple[str, Any] | tuple[str, Any, dict[str, Any]] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        unets = _related_model_choices("diffusion_models", MODEL_SLOTS["unet_name"]["seed"], "unet_name")
        uncond_unets = _related_model_choices("diffusion_models", MODEL_SLOTS["uncond_unet_name"]["seed"], "uncond_unet_name")
        clips = _related_model_choices("text_encoders", MODEL_SLOTS["clip_name"]["seed"])
        vaes = _related_model_choices("vae", MODEL_SLOTS["vae_name"]["seed"])
        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        return {
            "required": {
                "mode": (MODE_NAMES, {"default": "默认", "display": "hidden", "hidden": True, "display_name": "模式", "tooltip": "选择官方预设：质量 48 步、默认 20 步、极速 12 步。前端会显示为一排按钮。"}),
                "unet_name": (unets, {"default": _model_default("unet_name", unets), "display": "hidden", "hidden": True, "display_name": "主扩散模型", "tooltip": "从 models/diffusion_models 搜索 Ideogram 4 主扩散模型，保留子目录名称。"}),
                "uncond_unet_name": (uncond_unets, {"default": _model_default("uncond_unet_name", uncond_unets), "display": "hidden", "hidden": True, "display_name": "无条件扩散模型", "tooltip": "从 models/diffusion_models 搜索 Ideogram 4 unconditional 模型，用于双模型负向分支。"}),
                "clip_name": (clips, {"default": _model_default("clip_name", clips), "display": "hidden", "hidden": True, "display_name": "文本编码器", "tooltip": "从 models/text_encoders 搜索 Qwen3VL Ideogram 4 文本编码器。"}),
                "vae_name": (vaes, {"default": _model_default("vae_name", vaes), "display": "hidden", "hidden": True, "display_name": "VAE", "tooltip": "从 models/vae 搜索 Flux2 VAE，用于把 latent 解码成图片。"}),
                "cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01, "display": "hidden", "hidden": True, "display_name": "CFG", "tooltip": "DualModelGuider 的主引导强度。"}),
                "override_cfg": ("FLOAT", {"default": 3.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01, "display": "hidden", "hidden": True, "display_name": "覆盖CFG", "tooltip": "采样前段对主模型应用 CFGOverride 的强度，复刻源工作流默认 3。"}),
                "override_start": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 1.0, "step": 0.001, "round": 0.001, "display": "hidden", "hidden": True, "display_name": "覆盖起点", "tooltip": "CFGOverride 生效起点百分比，复刻源工作流默认 0.7。"}),
                "override_end": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.001, "round": 0.001, "display": "hidden", "hidden": True, "display_name": "覆盖终点", "tooltip": "CFGOverride 生效终点百分比，复刻源工作流默认 1.0。"}),
                "sampler_name": (samplers, {"default": "euler" if "euler" in samplers else samplers[0], "display": "hidden", "hidden": True, "display_name": "采样器", "tooltip": "源工作流默认 euler。"}),
                "weight_dtype": (["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"], {"default": "default", "display": "hidden", "hidden": True, "display_name": "加载精度", "tooltip": "传给官方 UNETLoader 的 weight_dtype；默认使用模型文件自己的配置。"}),
                "prompt": ("STRING", {"default": DEFAULT_PROMPT, "multiline": False, "dynamicPrompts": True, "display_name": "Json提示词", "tooltip": "Ideogram 4 提示词，推荐使用 JSON 结构描述画面、风格、构图和文字。"}),
                "width": ("INT", {"default": 1024, "min": 256, "max": 8192, "step": 16, "display_name": "宽度", "tooltip": "生成宽度；执行时会按 16 倍数向上对齐。"}),
                "height": ("INT", {"default": 1024, "min": 256, "max": 8192, "step": 16, "display_name": "高度", "tooltip": "生成高度；执行时会按 16 倍数向上对齐。"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64, "step": 1, "display_name": "批次数", "tooltip": "一次生成的图片数量。"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True, "display_name": "种子", "tooltip": "随机噪声种子；可设为生成后随机。"}),
                "lora_name": (
                    ["无"] + list(folder_paths.get_filename_list("loras") or []),
                    {
                        "default": "无",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "LoRA",
                        "tooltip": "可选内置 LoRA；在 🧠 模型树中选择，执行时同时应用到主模型、无条件模型和可匹配的 CLIP 权重。",
                    },
                ),
                "lora_strength": ("FLOAT", {
                    "default": 1.0,
                    "min": -10.0,
                    "max": 10.0,
                    "step": 0.01,
                    "round": 0.001,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "LoRA强度",
                    "tooltip": "内置 LoRA 的模型与 CLIP 应用强度。",
                }),
                "keep_model": ("BOOLEAN", {
                    "default": False,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "保持模型",
                    "tooltip": "开启后生成完成仍保留模型缓存；关闭时生成完成后卸载模型并释放显存。",
                }),
            },
            "optional": {
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "display_name": "🔗 LoRA串联配置",
                        "tooltip": "可选。接入 GJJ · 额外LoRA串联配置 后，会按顺序把多组 LoRA 应用到主扩散模型、无条件扩散模型与 CLIP。",
                    },
                ),
                "test_config": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "模型测试配置",
                        "tooltip": "前端 🧪 批量测试窗口自动维护的隐藏配置。",
                        "hidden": True,
                        "display": "hidden",
                        "forceInput": False,
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **_kwargs):
        # Model combo values are intentionally resolved at execution time. This
        # keeps workflows valid when a model is moved into a subdirectory or its
        # quantization/precision suffix changes.
        return True

    def generate(
        self,
        mode: str,
        unet_name: str,
        uncond_unet_name: str,
        clip_name: str,
        vae_name: str,
        cfg: float,
        override_cfg: float,
        override_start: float,
        override_end: float,
        sampler_name: str,
        weight_dtype: str,
        prompt: str,
        width: int,
        height: int,
        batch_size: int,
        seed: int,
        lora_name: str = "无",
        lora_strength: float = 1.0,
        keep_model: bool = False,
        lora_chain_config="",
        test_config="",
        unique_id=None,
    ):
        _missing_core_error()
        test_data: dict[str, Any] = {}
        if str(test_config or "").strip():
            try:
                parsed = json.loads(str(test_config))
                if isinstance(parsed, dict):
                    test_data = parsed
            except Exception:
                test_data = {}
        test_models = [
            str(name).strip()
            for name in test_data.get("models", [])
            if str(name or "").strip()
        ]
        if test_models:
            test_images: list[torch.Tensor] = []
            saved_images: list[dict[str, Any]] = []
            test_started = time.time()
            _send_test_preview(unique_id, [], 0, len(test_models), reset=True)
            for index, test_model in enumerate(test_models, 1):
                test_unconditional = _find_unconditional_pair(test_model)
                if not test_unconditional:
                    raise RuntimeError(f"未找到主模型对应的 unconditional 模型：{test_model}")
                _send_status(unique_id, f"模型测试 {index}/{len(test_models)}：{Path(test_model).name}")
                item_started = time.time()
                item_result = self.generate(
                    mode=mode,
                    unet_name=test_model,
                    uncond_unet_name=test_unconditional,
                    clip_name=clip_name,
                    vae_name=vae_name,
                    cfg=cfg,
                    override_cfg=override_cfg,
                    override_start=override_start,
                    override_end=override_end,
                    sampler_name=sampler_name,
                    weight_dtype=weight_dtype,
                    prompt=prompt,
                    width=width,
                    height=height,
                    batch_size=batch_size,
                    seed=seed,
                    lora_name=lora_name,
                    lora_strength=lora_strength,
                    keep_model=keep_model,
                    lora_chain_config=lora_chain_config,
                    test_config="",
                    unique_id=unique_id,
                )
                item_image = (
                    item_result.get("result", (None,))[0]
                    if isinstance(item_result, dict)
                    else item_result[0]
                )
                item_elapsed = time.time() - item_started
                item_image = _append_test_model_label(
                    item_image,
                    test_model,
                    item_elapsed,
                    _model_size_bytes(test_model),
                )
                aligned_width = _align16(width)
                aligned_height = _align16(height)
                prefix = (
                    f"Ideogram4模型测试/"
                    f"{_safe_test_filename_part(test_model)}_"
                    f"{aligned_width}x{aligned_height}_{item_elapsed:.2f}秒"
                )
                save_result = SaveImage().save_images(item_image, prefix)
                saved_images.extend(save_result.get("ui", {}).get("images", []))
                test_images.append(item_image)
                _send_test_preview(
                    unique_id,
                    saved_images,
                    index,
                    len(test_models),
                )
            result_image = torch.cat(test_images, dim=0)
            elapsed = time.time() - test_started
            _send_status(unique_id, f"模型测试完成：{len(test_models)} 个模型，耗时 {elapsed:.1f} 秒")
            return {
                "ui": {
                    "images": saved_images,
                    "elapsed_time": [elapsed],
                    "test_models": test_models,
                },
                "result": (result_image,),
            }
        started = time.time()
        width = _align16(width)
        height = _align16(height)
        preset = MODE_PRESETS.get(str(mode or ""), MODE_PRESETS["默认"])
        steps = int(preset["steps"])
        mu = float(preset["mu"])
        std = float(preset["std"])

        try:
            _send_status(unique_id, "加载 Ideogram 4 模型...")
            unet_name = _resolve_model_selection("unet_name", unet_name)
            uncond_unet_name = _resolve_model_selection("uncond_unet_name", uncond_unet_name)
            unet_name = _prefer_native_ideogram4_model(unet_name)
            uncond_unet_name = _prefer_native_ideogram4_model(uncond_unet_name)
            clip_name = _resolve_model_selection("clip_name", clip_name)
            vae_name = _resolve_model_selection("vae_name", vae_name)
            main_model = _load_ideogram4_unet(unet_name, weight_dtype)
            uncond_model = _load_ideogram4_unet(uncond_unet_name, weight_dtype)
            clip = _unwrap(CLIPLoader().load_clip(clip_name, "ideogram4", "default"))
            vae = _unwrap(VAELoader().load_vae(vae_name))
        except Exception as exc:
            raise _stage_error("模型加载", exc) from exc

        selected_lora_name = str(lora_name or "").strip()
        direct_lora_config = "[]"
        if selected_lora_name and selected_lora_name not in {"无", "none", "None"}:
            direct_lora_config = normalize_lora_chain_data(json.dumps([{
                "enabled": True,
                "name": selected_lora_name,
                "strength": float(lora_strength),
            }], ensure_ascii=False))
        normalized_lora_chain_config = normalize_lora_chain_data(lora_chain_config)
        lora_configs = [config for config in (direct_lora_config, normalized_lora_chain_config) if config != "[]"]
        if lora_configs:
            try:
                _send_status(unique_id, "应用 LoRA 串联配置...")

                def send_lora_applied(payload: dict[str, Any]) -> None:
                    name = str(payload.get("name") or "").strip()
                    strength = payload.get("strength", "")
                    if name:
                        _send_status(unique_id, f"已应用 LoRA串联：{name} ({strength})")

                for lora_config in lora_configs:
                    main_model, clip, self.loaded_lora = apply_lora_chain_config(
                        main_model,
                        clip,
                        lora_data=lora_config,
                        loaded_lora_cache=self.loaded_lora,
                        on_lora_applied=send_lora_applied,
                    )
                    uncond_model, _, self.loaded_lora = apply_lora_chain_config(
                        uncond_model,
                        None,
                        lora_data=lora_config,
                        loaded_lora_cache=self.loaded_lora,
                    )
            except Exception as exc:
                raise _stage_error("LoRA 串联应用", exc) from exc

        try:
            _send_status(unique_id, "编码提示词...")
            positive = _unwrap(CLIPTextEncode().encode(clip, str(prompt or "")))
            negative = _unwrap(ConditioningZeroOut().zero_out(positive))
        except Exception as exc:
            raise _stage_error("提示词编码", exc) from exc

        try:
            _send_status(unique_id, f"创建 {width}x{height} latent...")
            latent = _unwrap(EmptyFlux2LatentImage.execute(width, height, int(batch_size)))
            patched_model = _unwrap(CFGOverride.execute(main_model, float(override_cfg), float(override_start), float(override_end)))
            guider = _unwrap(DualModelGuider.execute(patched_model, positive, float(cfg), model_negative=uncond_model, negative=negative))
            noise = _unwrap(RandomNoise.execute(int(seed)))
            sampler = _unwrap(KSamplerSelect.execute(sampler_name))
            sigmas = _ideogram4_sigmas(steps, width, height, mu, std)
        except Exception as exc:
            raise _stage_error("采样准备", exc) from exc

        try:
            _send_status(unique_id, f"{mode}模式采样中：{steps}步...")
            sampled = _unwrap(SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, latent), 0)
            _send_status(unique_id, "解码图像...")
            image = _unwrap(VAEDecode().decode(vae, sampled))
        except Exception as exc:
            raise _stage_error("采样或解码", exc) from exc

        elapsed = time.time() - started
        preview_images = gjjutils_write_temp_tensor_images(image)
        if keep_model:
            _send_status(unique_id, f"完成：{elapsed:.1f} 秒；保持模型已开启")
        else:
            self.loaded_lora = None
            comfy.model_management.unload_all_models()
            comfy.model_management.soft_empty_cache()
            _send_status(unique_id, f"完成：{elapsed:.1f} 秒；模型已卸载")
        return {
            "ui": {
                "gjj_images": preview_images,
                "images": _standard_queue_images(preview_images),
                "elapsed_time": [elapsed],
            },
            "result": (image,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Ideogram4DirectGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🖼️ Ideogram4文生图"}


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/gjj/ideogram4-direct/test-models")
    async def get_ideogram4_direct_test_models(_request):
        models = []
        for name in _filename_list("diffusion_models"):
            if not _matches_ideogram4_branch("unet_name", name):
                continue
            normalized = model_lookup_stem(name).casefold()
            if "ideogram4" not in normalized.replace(" ", ""):
                continue
            size = _model_size_bytes(name)
            uncond_name = _find_unconditional_pair(name)
            models.append({
                "name": name,
                "bytes": size,
                "size": _format_model_size(size),
                "unconditional": uncond_name,
                "available": bool(uncond_name),
            })
        return web.json_response({"models": models})
except Exception:
    pass
