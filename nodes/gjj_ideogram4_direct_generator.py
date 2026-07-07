from __future__ import annotations

import math
import time
from typing import Any

import comfy.samplers
import folder_paths
import torch

from nodes import CLIPLoader, CLIPTextEncode, ConditioningZeroOut, UNETLoader, VAEDecode, VAELoader

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


def _filename_list(category: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(category) or [])
    except Exception:
        return []


def _related_model_choices(category: str, seed: str) -> list[str]:
    names = [name for name in _filename_list(category) if str(name or "").strip()]
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
    CATEGORY = "GJJ/视频/文本生成"
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
        unets = _related_model_choices("diffusion_models", MODEL_SLOTS["unet_name"]["seed"])
        uncond_unets = _related_model_choices("diffusion_models", MODEL_SLOTS["uncond_unet_name"]["seed"])
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
            },
            "optional": {
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "display_name": "🔗 LoRA串联配置",
                        "tooltip": "可选。接入 GJJ · 额外LoRA串联配置 后，会按顺序把多组 LoRA 应用到主扩散模型、无条件扩散模型与 CLIP。",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

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
        lora_chain_config="",
        unique_id=None,
    ):
        _missing_core_error()
        started = time.time()
        width = _align16(width)
        height = _align16(height)
        preset = MODE_PRESETS.get(str(mode or ""), MODE_PRESETS["默认"])
        steps = int(preset["steps"])
        mu = float(preset["mu"])
        std = float(preset["std"])

        try:
            _send_status(unique_id, "加载 Ideogram 4 模型...")
            unet_loader = UNETLoader()
            main_model = _unwrap(unet_loader.load_unet(unet_name, weight_dtype))
            uncond_model = _unwrap(unet_loader.load_unet(uncond_unet_name, weight_dtype))
            clip = _unwrap(CLIPLoader().load_clip(clip_name, "ideogram4", "default"))
            vae = _unwrap(VAELoader().load_vae(vae_name))
        except Exception as exc:
            raise _stage_error("模型加载", exc) from exc

        normalized_lora_chain_config = normalize_lora_chain_data(lora_chain_config)
        if str(normalized_lora_chain_config or "").strip() and normalized_lora_chain_config != "[]":
            try:
                _send_status(unique_id, "应用 LoRA 串联配置...")

                def send_lora_applied(payload: dict[str, Any]) -> None:
                    name = str(payload.get("name") or "").strip()
                    strength = payload.get("strength", "")
                    if name:
                        _send_status(unique_id, f"已应用 LoRA串联：{name} ({strength})")

                main_model, clip, self.loaded_lora = apply_lora_chain_config(
                    main_model,
                    clip,
                    lora_data=normalized_lora_chain_config,
                    loaded_lora_cache=self.loaded_lora,
                    on_lora_applied=send_lora_applied,
                )
                uncond_model, _, self.loaded_lora = apply_lora_chain_config(
                    uncond_model,
                    None,
                    lora_data=normalized_lora_chain_config,
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

        _send_status(unique_id, f"完成：{time.time() - started:.1f} 秒")
        return (image,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Ideogram4DirectGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🖼️ Ideogram4文生图"}
