from __future__ import annotations

from typing import Any
import json

import comfy.sd
import comfy.utils
import folder_paths
from aiohttp import web

try:
    from server import PromptServer
except Exception:
    PromptServer = None

WAN22_LIST_API = "/gjj/wan22_dual_loader_lists"

NODE_NAME = "GJJ_Wan22DualSampleModelLoader"
BASE_PRECISION_VALUES = ["fp32", "bf16", "fp16", "fp16_fast"]
QUANTIZATION_VALUES = [
    "disabled",
    "fp8_e4m3fn",
    "fp8_e4m3fn_fast",
    "fp8_e4m3fn_scaled",
    "fp8_e4m3fn_scaled_fast",
    "fp8_e5m2",
    "fp8_e5m2_fast",
    "fp8_e5m2_scaled",
    "fp8_e5m2_scaled_fast",
]
LOAD_DEVICE_VALUES = ["main_device", "offload_device"]
ATTENTION_MODE_VALUES = [
    "sdpa",
    "flash_attn_2",
    "flash_attn_3",
    "sageattn",
    "sageattn_3",
    "radial_sage_attention",
    "sageattn_compiled",
    "sageattn_ultravico",
    "comfy",
]
RMS_NORM_VALUES = ["default", "pytorch"]


def _filename_list(kind: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(kind))
    except Exception:
        return []


async def get_gjj_wan22_dual_loader_lists(request):
    return web.json_response(
        {
            "diffusion_models": _filename_list("diffusion_models"),
            "unet_gguf": _filename_list("unet_gguf"),
            "loras": _filename_list("loras"),
            "vae": _filename_list("vae"),
            "text_encoders": _filename_list("text_encoders"),
        }
    )


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.get(WAN22_LIST_API)(get_gjj_wan22_dual_loader_lists)


def _is_usable_file(name: str) -> bool:
    lower = str(name or "").replace("\\", "/").lower()
    return lower.endswith(".safetensors") and not lower.endswith(".metadata.json")


def _filter_names(names: list[str], *keywords: str) -> list[str]:
    active = [
        str(item or "").strip().lower() for item in keywords if str(item or "").strip()
    ]
    source = [name for name in names if _is_usable_file(name)]
    if not active:
        return source
    result: list[str] = []
    for name in source:
        lower = str(name).replace("\\", "/").lower()
        if all(word in lower for word in active):
            result.append(name)
    return result


def _branch_priority_score(name: str, branch_filter: str) -> int:
    text = str(name or "").replace("\\", "/").lower()
    target = str(branch_filter or "").lower()
    score = 0
    if target == "high_":
        if "high_noise" in text:
            score += 120
        if "high_" in text:
            score += 80
        if "_high" in text:
            score += 70
        if "high" in text:
            score += 30
        if "low_noise" in text or "low_" in text or "_low" in text:
            score -= 1000
    elif target == "low_":
        if "low_noise" in text:
            score += 120
        if "low_" in text:
            score += 80
        if "_low" in text:
            score += 70
        if "low" in text:
            score += 30
        if "high_noise" in text or "high_" in text or "_high" in text:
            score -= 1000
    return score


def _sort_branch(values: list[str], branch_filter: str) -> list[str]:
    return sorted(
        values,
        key=lambda name: (
            -_branch_priority_score(name, branch_filter),
            str(name).lower(),
        ),
    )


def _first_or_empty(values: list[str]) -> str:
    return values[0] if values else ""


def _resolve_selected(
    name: str, names: list[str], base_filter: str = "", role_filter: str = ""
) -> str:
    name = str(name or "").strip()
    if name and name in names:
        return name
    filtered = _sort_branch(_filter_names(names, base_filter, role_filter), role_filter)
    return _first_or_empty(filtered)


def _normalize_dtype(dtype: str) -> str:
    value = str(dtype or "default").strip().lower()
    return (
        value
        if value in {"default", "fp8_e4m3fn", "fp8_e5m2", "fp16", "bf16", "fp32"}
        else "default"
    )


def _torch_dtype(dtype: str):
    value = _normalize_dtype(dtype)
    if value == "default":
        return None
    try:
        import torch
    except Exception:
        return None
    mapping = {
        "fp16": torch.float16,
        "bf16": torch.bfloat16,
        "fp32": torch.float32,
        "fp8_e4m3fn": getattr(torch, "float8_e4m3fn", None),
        "fp8_e5m2": getattr(torch, "float8_e5m2", None),
    }
    return mapping.get(value)


def _load_diffusion_model(model_name: str, weight_dtype: str = "default"):
    model_path = folder_paths.get_full_path_or_raise("diffusion_models", model_name)
    dtype = _torch_dtype(weight_dtype)

    # ComfyUI 版本之间 load_diffusion_model 参数略有差异，做几种兼容。
    if dtype is not None:
        try:
            return comfy.sd.load_diffusion_model(
                model_path, model_options={"dtype": dtype}
            )
        except TypeError:
            try:
                return comfy.sd.load_diffusion_model(model_path, dtype=dtype)
            except TypeError:
                pass

    return comfy.sd.load_diffusion_model(model_path)


def _load_vae(vae_name: str):
    vae_path = folder_paths.get_full_path_or_raise("vae", vae_name)
    sd = comfy.utils.load_torch_file(vae_path)
    return comfy.sd.VAE(sd=sd)


def _clip_type_from_text(clip_type: str):
    raw = str(clip_type or "wan").strip().lower()
    clip_type_enum = getattr(comfy.sd, "CLIPType", None)
    if clip_type_enum is None:
        return raw

    candidates = {
        "wan": ["WAN", "Wan", "wan"],
        "hunyuan_video": ["HUNYUAN_VIDEO", "hunyuan_video"],
        "flux": ["FLUX", "flux"],
        "stable_diffusion": ["STABLE_DIFFUSION", "SD1", "stable_diffusion"],
    }.get(raw, [raw, raw.upper()])

    for name in candidates:
        if hasattr(clip_type_enum, name):
            return getattr(clip_type_enum, name)
    return raw


def _load_clip(
    text_encoder_name: str, clip_type: str = "wan", weight_dtype: str = "default"
):
    clip_path = folder_paths.get_full_path_or_raise("text_encoders", text_encoder_name)
    clip_type_value = _clip_type_from_text(clip_type)
    dtype = _torch_dtype(weight_dtype)

    model_options: dict[str, Any] = {}
    if dtype is not None:
        model_options["dtype"] = dtype

    kwargs: dict[str, Any] = {
        "embedding_directory": folder_paths.get_folder_paths("embeddings"),
        "clip_type": clip_type_value,
    }
    if model_options:
        kwargs["model_options"] = model_options

    try:
        return comfy.sd.load_clip([clip_path], **kwargs)
    except TypeError:
        # 兼容旧版 ComfyUI：旧签名可能不支持 model_options。
        kwargs.pop("model_options", None)
        return comfy.sd.load_clip([clip_path], **kwargs)


def _load_lora_patch_model(model: Any, lora_name: str, strength: float):
    if not lora_name or float(strength) == 0:
        return model

    lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
    lora = comfy.utils.load_torch_file(lora_path, safe_load=True)

    patched = comfy.sd.load_lora_for_models(model, None, lora, float(strength), 0.0)
    return patched[0] if isinstance(patched, tuple) else patched


def _parse_lora_chain_config(config: Any) -> list[dict[str, Any]]:
    if config is None:
        return []
    if isinstance(config, list):
        raw = config
    else:
        try:
            raw = json.loads(str(config or "[]"))
        except Exception:
            return []
    if not isinstance(raw, list):
        return []
    items: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "") or "").strip()
        enabled = item.get("enabled", True) is not False
        if not name or not enabled:
            continue
        try:
            strength = float(item.get("strength", 1.0))
        except Exception:
            strength = 1.0
        if abs(strength) < 1e-6:
            continue
        items.append({"name": name, "strength": strength})
    return items


def _lora_matches_branch(name: str, branch_filter: str) -> bool:
    return (
        str(branch_filter or "").strip().lower()
        in str(name or "").replace("\\", "/").lower()
    )


def _apply_lora_items_for_branch(
    model: Any, lora_items: list[dict[str, Any]], branch_filter: str
) -> Any:
    available = _filename_list("loras")
    current = model
    for item in lora_items:
        name = str(item.get("name", "") or "")
        if not _lora_matches_branch(name, branch_filter):
            continue
        resolved = _resolve_selected(name, available, branch_filter)
        if resolved:
            current = _load_lora_patch_model(
                current, resolved, float(item.get("strength", 1.0))
            )
    return current


_WANVIDEO_RUNTIME: dict[str, Any] | None = None


def _get_wanvideo_model_names() -> list[str]:
    return _filename_list("unet_gguf") + _filename_list("diffusion_models")


def _get_multitalk_model_names() -> list[str]:
    return _filter_names(_get_wanvideo_model_names(), "talk") or _get_wanvideo_model_names()


def _load_wanvideo_runtime() -> dict[str, Any]:
    global _WANVIDEO_RUNTIME
    if _WANVIDEO_RUNTIME is None:
        try:
            from ..vendor.wanvideo_wrapper import nodes_model_loading as model_loading
            from ..vendor.wanvideo_wrapper.multitalk import nodes as multitalk_nodes
        except Exception as error:
            raise RuntimeError(
                "GJJ 内置 WanVideo runtime 加载失败。无需安装 WanVideoWrapper 插件本体；"
                f"如果是 pip 运行库缺失，请按 GJJ SKILL 的运行时依赖方案安装。\n错误信息：{error}"
            ) from error
        _WANVIDEO_RUNTIME = {
            "model_loading": model_loading,
            "multitalk": multitalk_nodes,
        }
    return _WANVIDEO_RUNTIME


def _make_extra_model_payload(model_name: str):
    model_name = str(model_name or "").strip()
    if not model_name or model_name in {"[未找到模型]", "[未启用]"}:
        return None
    return [{"path": folder_paths.get_full_path_or_raise("diffusion_models", model_name)}]


def _load_multitalk_model(model_name: str):
    model_name = str(model_name or "").strip()
    if not model_name or model_name in {"[未找到模型]", "[未启用]"}:
        return None
    runtime = _load_wanvideo_runtime()
    loader = runtime["multitalk"].MultiTalkModelLoader()
    return loader.loadmodel(model=model_name)[0]


def _load_fantasytalking_model(model_name: str, base_precision: str):
    model_name = str(model_name or "").strip()
    if not model_name or model_name in {"[未找到模型]", "[未启用]"}:
        return None
    try:
        from ..vendor.wanvideo_wrapper.fantasytalking import nodes as fantasytalking_nodes
    except Exception as error:
        raise RuntimeError(
            "GJJ 内置 FantasyTalking runtime 加载失败。无需安装 WanVideoWrapper 插件本体；"
            f"如果是 pip 运行库缺失，请按 GJJ SKILL 的运行时依赖方案安装。\n错误信息：{error}"
        ) from error
    loader = fantasytalking_nodes.FantasyTalkingModelLoader()
    return loader.loadmodel(model=model_name, base_precision=base_precision)[0]


def _load_fantasyportrait_model(model_name: str, base_precision: str):
    model_name = str(model_name or "").strip()
    if not model_name or model_name in {"[未找到模型]", "[未启用]"}:
        return None
    try:
        from ..vendor.wanvideo_wrapper.fantasyportrait import nodes as fantasyportrait_nodes
    except Exception as error:
        raise RuntimeError(
            "GJJ 内置 FantasyPortrait runtime 加载失败。无需安装 WanVideoWrapper 插件本体；"
            f"如果是 pip 运行库缺失，请按 GJJ SKILL 的运行时依赖方案安装。\n错误信息：{error}"
        ) from error
    loader = fantasyportrait_nodes.FantasyPortraitModelLoader()
    return loader.loadmodel(model=model_name, base_precision=base_precision)[0]


class GJJ_Wan22DualSampleModelLoader:
    CATEGORY = "GJJ/模型加载"
    FUNCTION = "load_models"
    DESCRIPTION = "Wan2.2 双采样模型加载器：固定 high / low 双模型流程，并按开关成对输出扩展模型。"

    RETURN_TYPES = (
        "MODEL",
        "MODEL",
        "VAE",
        "CLIP",
        "VACEPATH",
        "VACEPATH",
        "FANTASYTALKINGMODEL",
        "FANTASYTALKINGMODEL",
        "MULTITALKMODEL",
        "MULTITALKMODEL",
        "FANTASYPORTRAITMODEL",
        "FANTASYPORTRAITMODEL",
    )
    RETURN_NAMES = (
        "High模型",
        "Low模型",
        "VAE",
        "CLIP",
        "High Extra",
        "Low Extra",
        "High FantasyTalking",
        "Low FantasyTalking",
        "High MultiTalk",
        "Low MultiTalk",
        "High FantasyPortrait",
        "Low FantasyPortrait",
    )
    OUTPUT_TOOLTIPS = (
        "高噪声阶段模型；开启加速 LoRA 时会返回已叠加 high LoRA 的模型。",
        "低噪声阶段模型；开启加速 LoRA 时会返回已叠加 low LoRA 的模型。",
        "从 models/vae 中按 wan 默认过滤加载的 VAE。",
        "从 models/text_encoders 中按 umt5_xxl 默认过滤加载的 CLIP / 文本编码器。",
        "可选 High 分支 extra_model / VACEPATH；关闭扩展模型时为空。",
        "可选 Low 分支 extra_model / VACEPATH；关闭扩展模型时为空。",
        "可选 High 分支 FantasyTalking 模型；关闭扩展模型时为空。",
        "可选 Low 分支 FantasyTalking 模型；关闭扩展模型时为空。",
        "可选 High 分支 MultiTalk/InfiniteTalk 模型；关闭扩展模型时为空。",
        "可选 Low 分支 MultiTalk/InfiniteTalk 模型；关闭扩展模型时为空。",
        "可选 High 分支 FantasyPortrait 模型；关闭扩展模型时为空。",
        "可选 Low 分支 FantasyPortrait 模型；关闭扩展模型时为空。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        diffusion_models = _filename_list("diffusion_models")
        extra_models = _filter_names(diffusion_models, "vace") or diffusion_models or ["[未找到模型]"]
        fantasytalking_models = _filter_names(diffusion_models, "fantasytalking") or _filter_names(diffusion_models, "talk") or diffusion_models or ["[未找到模型]"]
        multitalk_models = _get_multitalk_model_names() or ["[未找到模型]"]
        fantasyportrait_models = _filter_names(diffusion_models, "fantasyportrait") or _filter_names(diffusion_models, "portrait") or diffusion_models or ["[未找到模型]"]
        loras = _filename_list("loras")
        vaes = _filename_list("vae")
        text_encoders = _filename_list("text_encoders")

        high_models = (
            _sort_branch(
                _filter_names(diffusion_models, "wan2.2_t2v", "high_"), "high_"
            )
            or diffusion_models
            or [""]
        )
        low_models = (
            _sort_branch(_filter_names(diffusion_models, "wan2.2_t2v", "low_"), "low_")
            or diffusion_models
            or [""]
        )
        high_loras = (
            _sort_branch(_filter_names(loras, "high_"), "high_") or loras or [""]
        )
        low_loras = _sort_branch(_filter_names(loras, "low_"), "low_") or loras or [""]
        high_extra_models = _sort_branch(_filter_names(extra_models, "high_"), "high_") or extra_models
        low_extra_models = _sort_branch(_filter_names(extra_models, "low_"), "low_") or extra_models
        high_fantasytalking_models = _sort_branch(_filter_names(fantasytalking_models, "high_"), "high_") or fantasytalking_models
        low_fantasytalking_models = _sort_branch(_filter_names(fantasytalking_models, "low_"), "low_") or fantasytalking_models
        high_multitalk_models = _sort_branch(_filter_names(multitalk_models, "high_"), "high_") or multitalk_models
        low_multitalk_models = _sort_branch(_filter_names(multitalk_models, "low_"), "low_") or multitalk_models
        high_fantasyportrait_models = _sort_branch(_filter_names(fantasyportrait_models, "high_"), "high_") or fantasyportrait_models
        low_fantasyportrait_models = _sort_branch(_filter_names(fantasyportrait_models, "low_"), "low_") or fantasyportrait_models
        vae_files = _filter_names(vaes, "wan_2.1_vae") or vaes or [""]
        clip_files = _filter_names(text_encoders, "umt5_xxl") or text_encoders or [""]

        dtype_values = ["default", "fp8_e4m3fn", "fp8_e5m2", "fp16", "bf16", "fp32"]

        return {
            "required": {
                "base_filter": (
                    "STRING",
                    {
                        "default": "wan2.2_t2v",
                        "display_name": "🔍",
                        "tooltip": "总过滤词。不区分大小写，支持子目录。默认 wan2.2_t2v。",
                    },
                ),
                "use_extra_model": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "➕",
                        "tooltip": "是否启用 High/Low 成对 Extra 模型输出。",
                    },
                ),
                "use_fantasytalking_model": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "🗣",
                        "tooltip": "是否启用 High/Low 成对 FantasyTalking 模型输出。",
                    },
                ),
                "use_multitalk_model": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "🎤",
                        "tooltip": "是否启用 High/Low 成对 MultiTalk/InfiniteTalk 模型输出。",
                    },
                ),
                "use_fantasyportrait_model": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "🧑",
                        "tooltip": "是否启用 High/Low 成对 FantasyPortrait 模型输出。",
                    },
                ),
                "show_more_params": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "更多参数",
                        "tooltip": "前端【更多参数】按钮状态。打开后显示精度、量化、加载设备等高级参数。",
                    },
                ),
                "base_precision": (
                    BASE_PRECISION_VALUES,
                    {
                        "default": "bf16",
                        "display_name": "基础精度",
                        "tooltip": "WanVideoModelLoader base_precision，默认收在【更多参数】里。",
                    },
                ),
                "quantization": (
                    QUANTIZATION_VALUES,
                    {
                        "default": "disabled",
                        "display_name": "量化",
                        "tooltip": "WanVideoModelLoader quantization，默认收在【更多参数】里。",
                    },
                ),
                "load_device": (
                    LOAD_DEVICE_VALUES,
                    {
                        "default": "offload_device",
                        "display_name": "加载设备",
                        "tooltip": "WanVideoModelLoader load_device，默认收在【更多参数】里。",
                    },
                ),
                "attention_mode": (
                    ATTENTION_MODE_VALUES,
                    {
                        "default": "sdpa",
                        "display_name": "Attention",
                        "tooltip": "WanVideoModelLoader attention_mode，默认收在【更多参数】里。",
                    },
                ),
                "rms_norm_function": (
                    RMS_NORM_VALUES,
                    {
                        "default": "default",
                        "display_name": "RMSNorm",
                        "tooltip": "WanVideoModelLoader rms_norm_function，默认收在【更多参数】里。",
                    },
                ),
                "use_accel_lora": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "🚕",
                        "tooltip": "是否给 high / low 模型加载对应加速 LoRA。",
                    },
                ),
                # 以下 4 个过滤词由前端固定维护，不在前台显示。
                "high_model_filter": (
                    "STRING",
                    {
                        "default": "high_",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "High模型过滤",
                        "tooltip": "后台过滤词：high_。",
                    },
                ),
                "low_model_filter": (
                    "STRING",
                    {
                        "default": "low_",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "Low模型过滤",
                        "tooltip": "后台过滤词：low_。",
                    },
                ),
                "high_lora_filter": (
                    "STRING",
                    {
                        "default": "high_",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "High LoRA过滤",
                        "tooltip": "后台过滤词：high_。",
                    },
                ),
                "low_lora_filter": (
                    "STRING",
                    {
                        "default": "low_",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "Low LoRA过滤",
                        "tooltip": "后台过滤词：low_。",
                    },
                ),
                "vae_filter": (
                    "STRING",
                    {
                        "default": "wan",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "VAE过滤",
                        "tooltip": "后台过滤词：wan。",
                    },
                ),
                "clip_filter": (
                    "STRING",
                    {
                        "default": "umt5_xxl",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "CLIP过滤",
                        "tooltip": "后台过滤词：umt5_xxl。",
                    },
                ),
                "vae_name": (
                    vae_files,
                    {
                        "default": _first_or_empty(vae_files),
                        "display_name": "VAE",
                        "tooltip": "从 models/vae 中按 wan 默认过滤。为空或不匹配时自动选择第一个满足条件的 VAE。",
                    },
                ),
                "clip_name": (
                    clip_files,
                    {
                        "default": _first_or_empty(clip_files),
                        "display_name": "CLIP",
                        "tooltip": "从 models/text_encoders 中按 umt5_xxl 默认过滤。为空或不匹配时自动选择第一个满足条件的文本编码器。",
                    },
                ),
                "clip_type": (
                    ["wan", "hunyuan_video", "flux", "stable_diffusion"],
                    {
                        "default": "wan",
                        "display_name": "类型",
                        "tooltip": "CLIP 类型。Wan2.2 通常使用 wan。",
                    },
                ),
                "clip_dtype": (
                    dtype_values,
                    {
                        "default": "default",
                        "display_name": "⚙",
                        "tooltip": "CLIP / 文本编码器加载 dtype。default 使用 ComfyUI 默认策略。",
                    },
                ),
                "high_model": (
                    high_models,
                    {
                        "default": _first_or_empty(high_models),
                        "display_name": "High",
                        "tooltip": "从 models/diffusion_models 中按 总过滤词 + high_ 过滤。为空或不匹配时自动选第一个满足条件的模型。",
                    },
                ),
                "high_dtype": (
                    dtype_values,
                    {
                        "default": "default",
                        "display_name": "⚙",
                        "tooltip": "High 模型数据类型。",
                    },
                ),
                "low_model": (
                    low_models,
                    {
                        "default": _first_or_empty(low_models),
                        "display_name": "Low",
                        "tooltip": "从 models/diffusion_models 中按 总过滤词 + low_ 过滤。为空或不匹配时自动选第一个满足条件的模型。",
                    },
                ),
                "low_dtype": (
                    dtype_values,
                    {
                        "default": "default",
                        "display_name": "⚙",
                        "tooltip": "Low 模型数据类型。",
                    },
                ),
                "high_lora": (
                    high_loras,
                    {
                        "default": _first_or_empty(high_loras),
                        "display_name": "High LoRA",
                        "tooltip": "从 models/loras 中按 总过滤词 + high_ 过滤。关闭加速 LoRA 时不使用。",
                    },
                ),
                "high_lora_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": -20.0,
                        "max": 20.0,
                        "step": 0.01,
                        "display_name": "💪",
                        "tooltip": "High LoRA 模型强度。",
                    },
                ),
                "low_lora": (
                    low_loras,
                    {
                        "default": _first_or_empty(low_loras),
                        "display_name": "Low LoRA",
                        "tooltip": "从 models/loras 中按 总过滤词 + low_ 过滤。关闭加速 LoRA 时不使用。",
                    },
                ),
                "low_lora_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": -20.0,
                        "max": 20.0,
                        "step": 0.01,
                        "display_name": "💪",
                        "tooltip": "Low LoRA 模型强度。",
                    },
                ),
                "high_extra_model": (
                    high_extra_models,
                    {
                        "default": _first_or_empty(high_extra_models),
                        "display_name": "High Extra",
                        "tooltip": "High 分支 extra_model，例如 VACE / MTV Crafter。打开 ➕ 后才加载并输出。",
                    },
                ),
                "low_extra_model": (
                    low_extra_models,
                    {
                        "default": _first_or_empty(low_extra_models),
                        "display_name": "Low Extra",
                        "tooltip": "Low 分支 extra_model，例如 VACE / MTV Crafter。打开 ➕ 后才加载并输出。",
                    },
                ),
                "high_fantasytalking_model": (
                    high_fantasytalking_models,
                    {
                        "default": _first_or_empty(high_fantasytalking_models),
                        "display_name": "High FantasyTalking",
                        "tooltip": "High 分支 FantasyTalking 模型。打开 🗣 后才加载并输出。",
                    },
                ),
                "low_fantasytalking_model": (
                    low_fantasytalking_models,
                    {
                        "default": _first_or_empty(low_fantasytalking_models),
                        "display_name": "Low FantasyTalking",
                        "tooltip": "Low 分支 FantasyTalking 模型。打开 🗣 后才加载并输出。",
                    },
                ),
                "high_multitalk_model": (
                    high_multitalk_models,
                    {
                        "default": _first_or_empty(high_multitalk_models),
                        "display_name": "High MultiTalk",
                        "tooltip": "High 分支 MultiTalk/InfiniteTalk 模型。打开 🎤 后才加载并输出。",
                    },
                ),
                "low_multitalk_model": (
                    low_multitalk_models,
                    {
                        "default": _first_or_empty(low_multitalk_models),
                        "display_name": "Low MultiTalk",
                        "tooltip": "Low 分支 MultiTalk/InfiniteTalk 模型。打开 🎤 后才加载并输出。",
                    },
                ),
                "high_fantasyportrait_model": (
                    high_fantasyportrait_models,
                    {
                        "default": _first_or_empty(high_fantasyportrait_models),
                        "display_name": "High FantasyPortrait",
                        "tooltip": "High 分支 FantasyPortrait 模型。打开 🧑 后才加载并输出。",
                    },
                ),
                "low_fantasyportrait_model": (
                    low_fantasyportrait_models,
                    {
                        "default": _first_or_empty(low_fantasyportrait_models),
                        "display_name": "Low FantasyPortrait",
                        "tooltip": "Low 分支 FantasyPortrait 模型。打开 🧑 后才加载并输出。",
                    },
                ),
            },
            "optional": {
                "compile_args": (
                    "WANCOMPILEARGS",
                    {
                        "forceInput": True,
                        "display_name": "⚙️ 编译参数",
                        "tooltip": "可连接 GJJ · WanVideo编译设置 输出。当前双采样基础 MODEL 路径只保存该输入，不主动执行 torch.compile。",
                    },
                ),
                "use_accel_lora_in": (
                    "BOOLEAN",
                    {
                        "forceInput": True,
                        "display_name": "🚕 加速LoRA",
                        "tooltip": "外部布尔控制加速 LoRA 开关；连接后优先使用外部输入，面板内部按钮会隐藏。",
                    },
                ),
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "forceInput": True,
                        "display_name": "🧬 LoRA配置",
                        "tooltip": "可接入 GJJ 多 LoRA 串联配置。连接后会把名称包含 high_ 的 LoRA 应用到 High 分支，名称包含 low_ 的 LoRA 应用到 Low 分支。",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        """Use keyword arguments only.

        之前追加 optional 输入后，如果某些 ComfyUI 版本/前端把输入按位置传递，
        外部 BOOLEAN / LORA_CHAIN_CONFIG 可能会把后面的模型选择参数顶偏。
        这里不再依赖函数形参顺序，只按参数名读取。
        """
        keys = [
            "base_filter",
            "use_extra_model",
            "use_fantasytalking_model",
            "use_multitalk_model",
            "use_fantasyportrait_model",
            "show_more_params",
            "base_precision",
            "quantization",
            "load_device",
            "attention_mode",
            "rms_norm_function",
            "compile_args",
            "use_accel_lora",
            "use_accel_lora_in",
            "lora_chain_config",
            "high_model_filter",
            "low_model_filter",
            "high_lora_filter",
            "low_lora_filter",
            "vae_filter",
            "clip_filter",
            "vae_name",
            "clip_name",
            "clip_type",
            "clip_dtype",
            "high_model",
            "high_dtype",
            "low_model",
            "low_dtype",
            "high_lora",
            "high_lora_strength",
            "low_lora",
            "low_lora_strength",
            "high_extra_model",
            "low_extra_model",
            "high_fantasytalking_model",
            "low_fantasytalking_model",
            "high_multitalk_model",
            "low_multitalk_model",
            "high_fantasyportrait_model",
            "low_fantasyportrait_model",
        ]
        return "|".join(str(kwargs.get(key, "")) for key in keys)

    def load_models(self, *args, **kwargs):
        """Load models using named parameters only. Positional args are intentionally ignored.

        关键点：
        - 所有输入都从 kwargs 按名称读取；
        - 不再依赖位置参数顺序；
        - 外接 BOOLEAN 只覆盖 use_accel_lora；
        - 外接 LORA_CHAIN_CONFIG 只影响 LoRA 分支，不会挤占 high_model / low_model。
        """
        base_filter = str(kwargs.get("base_filter", "wan2.2_t2v") or "wan2.2_t2v")
        use_extra_model = bool(kwargs.get("use_extra_model", False))
        use_fantasytalking_model = bool(kwargs.get("use_fantasytalking_model", False))
        use_multitalk_model = bool(kwargs.get("use_multitalk_model", False))
        use_fantasyportrait_model = bool(kwargs.get("use_fantasyportrait_model", False))
        base_precision = str(kwargs.get("base_precision", "bf16") or "bf16")
        quantization = str(kwargs.get("quantization", "disabled") or "disabled")
        load_device = str(kwargs.get("load_device", "offload_device") or "offload_device")
        attention_mode = str(kwargs.get("attention_mode", "sdpa") or "sdpa")
        rms_norm_function = str(kwargs.get("rms_norm_function", "default") or "default")
        compile_args = kwargs.get("compile_args", None)
        use_accel_lora = bool(kwargs.get("use_accel_lora", True))
        use_accel_lora_in = kwargs.get("use_accel_lora_in", None)
        lora_chain_config = kwargs.get("lora_chain_config", None)

        high_model_filter = str(kwargs.get("high_model_filter", "high_") or "high_")
        low_model_filter = str(kwargs.get("low_model_filter", "low_") or "low_")
        high_lora_filter = str(kwargs.get("high_lora_filter", "high_") or "high_")
        low_lora_filter = str(kwargs.get("low_lora_filter", "low_") or "low_")
        vae_filter = str(kwargs.get("vae_filter", "wan") or "wan")
        clip_filter = str(kwargs.get("clip_filter", "umt5_xxl") or "umt5_xxl")

        vae_name = str(kwargs.get("vae_name", "") or "")
        clip_name = str(kwargs.get("clip_name", "") or "")
        clip_type = str(kwargs.get("clip_type", "wan") or "wan")
        clip_dtype = str(kwargs.get("clip_dtype", "default") or "default")

        high_model = str(kwargs.get("high_model", "") or "")
        high_dtype = str(kwargs.get("high_dtype", "default") or "default")
        low_model = str(kwargs.get("low_model", "") or "")
        low_dtype = str(kwargs.get("low_dtype", "default") or "default")

        high_lora = str(kwargs.get("high_lora", "") or "")
        low_lora = str(kwargs.get("low_lora", "") or "")
        high_extra_model = str(kwargs.get("high_extra_model", kwargs.get("extra_model", "")) or "")
        low_extra_model = str(kwargs.get("low_extra_model", kwargs.get("extra_model", "")) or "")
        high_fantasytalking_model = str(kwargs.get("high_fantasytalking_model", "") or "")
        low_fantasytalking_model = str(kwargs.get("low_fantasytalking_model", "") or "")
        high_multitalk_model = str(kwargs.get("high_multitalk_model", kwargs.get("multitalk_model", "")) or "")
        low_multitalk_model = str(kwargs.get("low_multitalk_model", kwargs.get("multitalk_model", "")) or "")
        high_fantasyportrait_model = str(kwargs.get("high_fantasyportrait_model", "") or "")
        low_fantasyportrait_model = str(kwargs.get("low_fantasyportrait_model", "") or "")

        try:
            high_lora_strength = float(kwargs.get("high_lora_strength", 1.0))
        except Exception:
            high_lora_strength = 1.0
        try:
            low_lora_strength = float(kwargs.get("low_lora_strength", 1.0))
        except Exception:
            low_lora_strength = 1.0

        effective_use_accel_lora = bool(
            use_accel_lora if use_accel_lora_in is None else use_accel_lora_in
        )

        diffusion_models = _filename_list("diffusion_models")
        loras = _filename_list("loras")
        vaes = _filename_list("vae")
        text_encoders = _filename_list("text_encoders")

        high_model = _resolve_selected(
            high_model, diffusion_models, base_filter, high_model_filter
        )
        low_model = _resolve_selected(
            low_model, diffusion_models, base_filter, low_model_filter
        )
        vae_name = _resolve_selected(vae_name, vaes, vae_filter)
        clip_name = _resolve_selected(clip_name, text_encoders, clip_filter)

        if not high_model:
            raise RuntimeError(
                f"没有在 models/diffusion_models 中找到 High 模型：过滤词 {base_filter!r} + {high_model_filter!r}"
            )
        if not low_model:
            raise RuntimeError(
                f"没有在 models/diffusion_models 中找到 Low 模型：过滤词 {base_filter!r} + {low_model_filter!r}"
            )
        if not vae_name:
            raise RuntimeError(f"没有在 models/vae 中找到 VAE：过滤词 {vae_filter!r}")
        if not clip_name:
            raise RuntimeError(
                f"没有在 models/text_encoders 中找到 CLIP：过滤词 {clip_filter!r}"
            )

        high = _load_diffusion_model(high_model, high_dtype)
        low = _load_diffusion_model(low_model, low_dtype)
        vae = _load_vae(vae_name)
        clip = _load_clip(clip_name, clip_type, clip_dtype)

        if effective_use_accel_lora:
            # 先应用节点内部 LoRA。外接 LoRA 配置只做额外叠加，不再替代/隐藏内部 LoRA。
            high_lora = _resolve_selected(high_lora, loras, high_lora_filter)
            low_lora = _resolve_selected(low_lora, loras, low_lora_filter)
            if high_lora:
                high = _load_lora_patch_model(high, high_lora, high_lora_strength)
            if low_lora:
                low = _load_lora_patch_model(low, low_lora, low_lora_strength)

            # 再应用外接 LoRA 串联配置：名称包含 high_ 的进 High 分支，包含 low_ 的进 Low 分支。
            external_loras = _parse_lora_chain_config(lora_chain_config)
            if external_loras:
                high = _apply_lora_items_for_branch(
                    high, external_loras, high_lora_filter
                )
                low = _apply_lora_items_for_branch(low, external_loras, low_lora_filter)

        # compile_args 是给 WanVideo runtime 路径预留的输入；当前 wan22_dual 基础 MODEL 路径不主动编译。
        _ = (compile_args, base_precision, quantization, load_device, attention_mode, rms_norm_function)

        high_extra = _make_extra_model_payload(high_extra_model) if use_extra_model else None
        low_extra = _make_extra_model_payload(low_extra_model) if use_extra_model else None
        high_fantasytalking = (
            _load_fantasytalking_model(high_fantasytalking_model, base_precision)
            if use_fantasytalking_model
            else None
        )
        low_fantasytalking = (
            _load_fantasytalking_model(low_fantasytalking_model, base_precision)
            if use_fantasytalking_model
            else None
        )
        high_multitalk = _load_multitalk_model(high_multitalk_model) if use_multitalk_model else None
        low_multitalk = _load_multitalk_model(low_multitalk_model) if use_multitalk_model else None
        high_fantasyportrait = (
            _load_fantasyportrait_model(high_fantasyportrait_model, base_precision)
            if use_fantasyportrait_model
            else None
        )
        low_fantasyportrait = (
            _load_fantasyportrait_model(low_fantasyportrait_model, base_precision)
            if use_fantasyportrait_model
            else None
        )

        return (
            high,
            low,
            vae,
            clip,
            high_extra,
            low_extra,
            high_fantasytalking,
            low_fantasytalking,
            high_multitalk,
            low_multitalk,
            high_fantasyportrait,
            low_fantasyportrait,
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Wan22DualSampleModelLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 WanVideo模型加载"}
