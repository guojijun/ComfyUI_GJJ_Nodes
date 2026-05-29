from __future__ import annotations

import gc
import importlib
import json
import os
import sys
import torch

import folder_paths
import comfy.model_management as mm
from comfy.utils import load_torch_file
from .common_utils.model_manager import gjjutils_find_model_list


NODE_NAME = "GJJ_WanVideoModelLoader"
LONGCAT_AVATAR_MODEL = "LongCat-Avatar-15_bf16.safetensors"
MISSING_MODEL_CHOICE = "[未找到模型]"
DISABLE_LORA_CHOICE = "不使用"
WAN_VAE_KEYWORD = ["wan2", "1", "vae"]
WAN_CLIP_KEYWORD = "umt5_xxl_fp"
WAN_CLIP_VISION_KEYWORD = ["clip", "vision", "h"]
WAN_ACCEL_LORA_KEYWORD = ["lightx2v", "cfg", "step", "distill", "lora"]
CLIP_TYPE_VALUES = [
    "stable_diffusion",
    "stable_cascade",
    "sd3",
    "stable_audio",
    "mochi",
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
    "longcat_image",
]


def _load_wanvideo_model_loading():
    """懒加载 WanVideoWrapper 模型加载模块"""
    try:
        from ..vendor.wanvideo_wrapper import nodes_model_loading
    except ImportError as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo 模型加载模块失败。\n"
            f"错误信息: {error}\n"
            "说明: 本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时。"
        ) from error
    return nodes_model_loading


def _scan_diffusion_models(keywords=("wan", "longcat")):
    """扫描 diffusion_models 目录，按关键词过滤并返回模型列表。
    
    Args:
        keywords: 过滤关键词，默认同时兼容 "wan" 和 "longcat"
    
    Returns:
        (model_list, default_model) 元组
    """
    all_models = []
    try:
        all_models = list(folder_paths.get_filename_list("diffusion_models"))
    except Exception:
        pass
    
    gguf_models = []
    try:
        gguf_models = list(folder_paths.get_filename_list("unet_gguf"))
    except Exception:
        pass
    
    all_models = gguf_models + all_models
    
    if not all_models:
        return ["[未找到模型]"], "[未找到模型]"
    
    if isinstance(keywords, str):
        keyword_list = [keywords]
    else:
        keyword_list = list(keywords or [])
    keyword_lowers = [str(keyword).strip().lower() for keyword in keyword_list if str(keyword).strip()]
    matched = [
        name for name in all_models
        if any(keyword in name.lower() for keyword in keyword_lowers)
    ]
    
    if matched:
        preferred = next((name for name in matched if str(name).replace("\\", "/").endswith(LONGCAT_AVATAR_MODEL)), None)
        return matched, preferred or matched[0]
    
    return all_models, all_models[0]


def _filename_list(category: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(category))
    except Exception:
        return []


def _dedupe_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _compact_model_text(value: str) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _looks_like_wan_clip_name(value: str) -> bool:
    filename = str(value or "").replace("\\", "/").rsplit("/", 1)[-1]
    text = _compact_model_text(filename)
    return "umt5xxlfp" in text and "enc" not in text


def _rank_wan_clip_name(value: str) -> tuple[int, int, str]:
    filename = str(value or "").replace("\\", "/").rsplit("/", 1)[-1]
    text = _compact_model_text(filename)
    folder_depth = str(value or "").replace("\\", "/").count("/")
    if _looks_like_wan_clip_name(value) and "fp16" in text:
        bucket = 0
    elif _looks_like_wan_clip_name(value) and "fp8" in text:
        bucket = 1
    else:
        bucket = 80
    return (bucket, folder_depth, str(value).lower())


def _is_wan_clip_search(category: str, keyword: str | list[str]) -> bool:
    if category != "text_encoders":
        return False
    if isinstance(keyword, str):
        values = [keyword]
    else:
        values = list(keyword or [])
    normalized = {_compact_model_text(item) for item in values}
    return "umt5xxlfp" in normalized or {"umt5", "xxl"}.issubset(normalized)


def _fuzzy_model_choices(category: str, keyword: str | list[str], *, allow_disable: bool = False) -> tuple[list[str], str]:
    all_models = _filename_list(category)
    try:
        matches = gjjutils_find_model_list(keyword, category, "AND")
    except Exception:
        matches = []
    if _is_wan_clip_search(category, keyword):
        combined = sorted(_dedupe_preserve_order(list(matches or []) + list(all_models or [])), key=_rank_wan_clip_name)
        supported = [name for name in combined if _looks_like_wan_clip_name(name)]
        ordered = _dedupe_preserve_order(supported) if supported else [MISSING_MODEL_CHOICE]
    else:
        ordered = _dedupe_preserve_order(list(matches or []) + list(all_models or []))
    if allow_disable:
        if ordered:
            return ordered + [DISABLE_LORA_CHOICE], ordered[0]
        return [DISABLE_LORA_CHOICE], DISABLE_LORA_CHOICE
    if ordered:
        return ordered, ordered[0]
    return [MISSING_MODEL_CHOICE], MISSING_MODEL_CHOICE


def _default_fuzzy_choice(category: str, keyword: str | list[str], *, allow_disable: bool = False) -> str:
    return _fuzzy_model_choices(category, keyword, allow_disable=allow_disable)[1]


def _is_missing_or_disabled(value: str) -> bool:
    text = str(value or "").strip()
    return not text or text in {MISSING_MODEL_CHOICE, DISABLE_LORA_CHOICE}


def _resolve_missing_choice(value: str, category: str, keyword: str | list[str], *, allow_disable: bool = False) -> str:
    if not _is_missing_or_disabled(value):
        return str(value).strip()
    return _default_fuzzy_choice(category, keyword, allow_disable=allow_disable)


def _resolve_wan_clip_choice(value: str) -> str:
    resolved = _resolve_missing_choice(value, "text_encoders", WAN_CLIP_KEYWORD)
    if _looks_like_wan_clip_name(resolved):
        return resolved
    fallback = _default_fuzzy_choice("text_encoders", WAN_CLIP_KEYWORD)
    if _looks_like_wan_clip_name(fallback):
        print(
            "[GJJ WanVideoModelLoader] 当前文本编码器不是支持的 umt5_xxl_fp16/fp8，"
            f"已自动改用: {fallback} (原选择: {resolved})"
        )
        return fallback
    raise RuntimeError(
        "WanVideo CLIP 选择错误：当前选择的不是本工作流支持的 UMT5 XXL 文本编码器。\n"
        f"当前选择：{resolved}\n"
        "请将 umt5_xxl_fp16 或 umt5_xxl_fp8 模型放入 models/text_encoders，并在本节点的 🟡 CLIP编码器 中选择它。\n"
        "注意：umt5-xxl-enc-bf16 / umt5-xxl-enc-fp8 这一类不兼容这里输出给 CLIP 文本编码的用法。"
    )


def _load_clip_with_official_loader(clip_name: str, clip_type: str = "wan", device: str = "default"):
    if _is_missing_or_disabled(clip_name):
        raise RuntimeError("未选择 WanVideo 文本编码器。请将 umt5_xxl_fp16 或 umt5_xxl_fp8 放入 models/text_encoders。")
    try:
        resolved_type = str(clip_type or "wan")
        if resolved_type not in CLIP_TYPE_VALUES:
            resolved_type = "wan"
        nodes_mod = importlib.import_module("nodes")
        loader_cls = getattr(nodes_mod, "CLIPLoader")
        try:
            return loader_cls().load_clip(clip_name, resolved_type, device)[0]
        except TypeError:
            return loader_cls().load_clip(clip_name, resolved_type)[0]
    except Exception as exc:
        raise RuntimeError(
            "WanVideo CLIP 加载失败。\n"
            f"需要文件：models/text_encoders/{clip_name}\n"
            f"原始错误：{exc}"
        ) from exc


def _load_clip_vision_with_official_loader(clip_name: str):
    if _is_missing_or_disabled(clip_name):
        raise RuntimeError("未选择 CLIP视觉模型。请将 clip_vision_h 模型放入 models/clip_vision。")
    try:
        nodes_mod = importlib.import_module("nodes")
        loader_cls = getattr(nodes_mod, "CLIPVisionLoader")
        return loader_cls().load_clip(clip_name)[0]
    except Exception as exc:
        raise RuntimeError(
            "CLIP视觉模型加载失败。\n"
            f"需要文件：models/clip_vision/{clip_name}\n"
            f"原始错误：{exc}"
        ) from exc


class GJJ_WanVideoModelLoader:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "loadmodel"
    DESCRIPTION = "加载 WanVideo 扩散模型，支持多种精度和量化选项。"
    SEARCH_ALIASES = [
        "WanVideo Model Loader",
        "WanVideo 模型加载",
        "Wan2.1 模型",
        "LongCat 模型",
        "LongCat Avatar",
    ]
    RETURN_TYPES = ("WANVIDEOMODEL", "WANVAE", "CLIP", "CLIP_VISION")
    RETURN_NAMES = ("🟣 模型", "🔴 VAE", "🟡 CLIP编码器", "🔵 CLIP视觉")
    OUTPUT_TOOLTIPS = (
        "加载并可带加速 LoRA 的 WanVideo 模型。",
        "内置 WanVideoVAELoader 加载的 WANVAE。",
        "内置 CLIPLoader 按面板 CLIP类型加载的文本编码器，可接 CLIP文本编码后再转 WanVideo 文本嵌入。",
        "内置 CLIPVisionLoader 加载的 CLIP视觉模型。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        diffusion_models, default_model = _scan_diffusion_models(("wan", "longcat"))
        vae_models, default_vae = _fuzzy_model_choices("vae", WAN_VAE_KEYWORD)
        clip_models, default_clip = _fuzzy_model_choices("text_encoders", WAN_CLIP_KEYWORD)
        clip_vision_models, default_clip_vision = _fuzzy_model_choices("clip_vision", WAN_CLIP_VISION_KEYWORD)
        accel_loras, default_accel_lora = _fuzzy_model_choices("loras", WAN_ACCEL_LORA_KEYWORD, allow_disable=True)
        
        attention_modes = [
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
        
        return {
            "required": {
                "model": (
                    diffusion_models,
                    {
                        "default": default_model,
                        "display_name": "🟣 模型",
                        "tooltip": "自动搜索 diffusion_models 和 unet_gguf 目录，默认优先显示包含 wan 或 longcat 的模型。",
                    },
                ),
                "base_precision": (
                    ["fp32", "bf16", "fp16", "fp16_fast"],
                    {
                        "default": "bf16",
                        "display_name": "🟣 基础精度",
                        "tooltip": "模型计算精度，bf16 推荐用于现代 GPU。",
                    },
                ),
                "quantization": (
                    [
                        "disabled",
                        "fp8_e4m3fn",
                        "fp8_e4m3fn_fast",
                        "fp8_e4m3fn_scaled",
                        "fp8_e4m3fn_scaled_fast",
                        "fp8_e5m2",
                        "fp8_e5m2_fast",
                        "fp8_e5m2_scaled",
                        "fp8_e5m2_scaled_fast",
                    ],
                    {
                        "default": "disabled",
                        "display_name": "🟣 量化",
                        "tooltip": "可选量化方法，disabled 为自动检测。_fast 模式需要 CUDA 计算能力 >= 8.9。",
                    },
                ),
                "load_device": (
                    ["main_device", "offload_device"],
                    {
                        "default": "offload_device",
                        "display_name": "🟣 加载设备",
                        "tooltip": "模型初始加载设备，除非有 48GB+ 显存否则推荐 offload_device。",
                    },
                ),
                "vae_name": (
                    vae_models,
                    {
                        "default": default_vae,
                        "display_name": "🔴 VAE",
                        "tooltip": "使用公共模糊搜索 models/vae 下的 wan2_1_vae；匹配项排在前面，后面保留其它 VAE。",
                    },
                ),
                "clip_name": (
                    clip_models,
                    {
                        "default": default_clip,
                        "display_name": "🟡 CLIP编码器",
                        "tooltip": "只显示 models/text_encoders 下的 umt5_xxl_fp 过滤结果；enc 裁剪版请用于 GJJ_WanVideoT5TextEncode。",
                    },
                ),
                "clip_vision_name": (
                    clip_vision_models,
                    {
                        "default": default_clip_vision,
                        "display_name": "🔵 CLIP视觉",
                        "tooltip": "使用公共模糊搜索 models/clip_vision 下的 clip_vision_h；按 ComfyUI CLIPVisionLoader 加载。",
                    },
                ),
                "accel_lora_name": (
                    accel_loras,
                    {
                        "default": default_accel_lora,
                        "display_name": "🟠 加速LoRA",
                        "tooltip": "使用公共模糊搜索 models/loras 下的 lightx2v_cfg_step_distill_lora，默认强度 1.2；可选“不使用”。",
                    },
                ),
                "accel_lora_strength": (
                    "FLOAT",
                    {
                        "default": 1.2,
                        "min": -20.0,
                        "max": 20.0,
                        "step": 0.05,
                        "display_name": "🟠 加速LoRA强度",
                        "tooltip": "内置加速 LoRA 的模型强度，默认 1.2。",
                    },
                ),
            },
            "optional": {
                "vae_precision": (
                    ["bf16", "fp16", "fp32"],
                    {
                        "default": "bf16",
                        "display_name": "🔴 VAE精度",
                        "tooltip": "内置 WanVideoVAELoader 使用的 VAE 精度。",
                    },
                ),
                "vae_use_cpu_cache": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "🔴 VAE CPU缓存",
                        "tooltip": "开启后减少 VAE 显存占用，但会降低解码速度。",
                    },
                ),
                "clip_type": (
                    CLIP_TYPE_VALUES,
                    {
                        "default": "wan",
                        "display_name": "🟡 CLIP类型",
                        "tooltip": "对齐官方 CLIPLoader 的 type 参数，WanVideo 默认使用 wan。",
                    },
                ),
                "clip_device": (
                    ["default", "cpu"],
                    {
                        "default": "default",
                        "display_name": "🟡 CLIP加载设备",
                        "tooltip": "内置 CLIPLoader 的 device 参数，默认跟随 ComfyUI。",
                    },
                ),
                "attention_mode": (
                    attention_modes,
                    {
                        "default": "comfy",
                        "display_name": "注意力模式",
                        "tooltip": "注意力计算模式。LongCat Avatar 1.5 成功工作流使用 comfy。",
                    },
                ),
                "compile_args": (
                    "WANCOMPILEARGS",
                    {
                        "default": None,
                        "display_name": "编译参数",
                        "tooltip": "torch.compile 参数。",
                    },
                ),
                "block_swap_args": (
                    "BLOCKSWAPARGS",
                    {
                        "default": None,
                        "display_name": "块交换参数",
                        "tooltip": "块交换显存管理参数。",
                    },
                ),
                "lora": (
                    "WANVIDLORA,LORA_CHAIN_CONFIG",
                    {
                        "default": None,
                        "display_name": "LoRA",
                        "tooltip": "WanVideo LoRA 权重，自动识别 WANVIDLORA 或 LORA_CHAIN_CONFIG 类型。",
                    },
                ),
                "vram_management_args": (
                    "VRAM_MANAGEMENTARGS",
                    {
                        "default": None,
                        "display_name": "显存管理参数",
                        "tooltip": "来自 DiffSynth-Studio 的显存管理方法，比块交换更激进但可能更慢。",
                    },
                ),
                "extra_model": (
                    "VACEPATH",
                    {
                        "default": None,
                        "display_name": "额外模型",
                        "tooltip": "添加到主模型的额外模型，如 VACE 或 MTV Crafter。",
                    },
                ),
                "fantasytalking_model": (
                    "FANTASYTALKINGMODEL",
                    {
                        "default": None,
                        "display_name": "FantasyTalking 模型",
                        "tooltip": "FantasyTalking 模型 https://github.com/Fantasy-AMAP",
                    },
                ),
                "multitalk_model": (
                    "MULTITALKMODEL",
                    {
                        "default": None,
                        "display_name": "Multitalk 模型",
                        "tooltip": "Multitalk 模型。",
                    },
                ),
                "fantasyportrait_model": (
                    "FANTASYPORTRAITMODEL",
                    {
                        "default": None,
                        "display_name": "FantasyPortrait 模型",
                        "tooltip": "FantasyPortrait 模型。",
                    },
                ),
                "rms_norm_function": (
                    ["default", "pytorch"],
                    {
                        "default": "default",
                        "display_name": "RMSNorm",
                        "tooltip": "RMSNorm 函数，pytorch 更快但结果略有差异。",
                    },
                ),
            },
        }

    def loadmodel(
        self,
        model,
        base_precision,
        load_device,
        quantization,
        vae_name=None,
        clip_name=None,
        clip_vision_name=None,
        accel_lora_name=None,
        accel_lora_strength=1.2,
        vae_precision="bf16",
        vae_use_cpu_cache=False,
        clip_type="wan",
        clip_device="default",
        attention_mode="sdpa",
        compile_args=None,
        block_swap_args=None,
        lora=None,
        vram_management_args=None,
        extra_model=None,
        fantasytalking_model=None,
        multitalk_model=None,
        fantasyportrait_model=None,
        rms_norm_function="default",
    ):
        vae_name = _resolve_missing_choice(vae_name, "vae", WAN_VAE_KEYWORD)
        clip_type = str(clip_type or "wan")
        if clip_type not in CLIP_TYPE_VALUES:
            clip_type = "wan"
        if clip_type == "wan":
            clip_name = _resolve_wan_clip_choice(clip_name)
        else:
            clip_name = _resolve_missing_choice(clip_name, "text_encoders", WAN_CLIP_KEYWORD)
        clip_vision_name = _resolve_missing_choice(clip_vision_name, "clip_vision", WAN_CLIP_VISION_KEYWORD)
        accel_lora_name = _resolve_missing_choice(accel_lora_name, "loras", WAN_ACCEL_LORA_KEYWORD, allow_disable=True)

        print(f"[GJJ WanVideoModelLoader] ========== 开始加载模型 ==========")
        print(f"[GJJ WanVideoModelLoader] 模型: {model}")
        print(f"[GJJ WanVideoModelLoader] 基础精度: {base_precision}")
        print(f"[GJJ WanVideoModelLoader] 量化: {quantization}")
        print(f"[GJJ WanVideoModelLoader] 加载设备: {load_device}")
        print(f"[GJJ WanVideoModelLoader] 注意力模式: {attention_mode}")
        print(f"[GJJ WanVideoModelLoader] RMSNorm: {rms_norm_function}")
        print(f"[GJJ WanVideoModelLoader] VAE: {vae_name} ({vae_precision})")
        print(f"[GJJ WanVideoModelLoader] CLIP: {clip_name} / type={clip_type} / device={clip_device}")
        print(f"[GJJ WanVideoModelLoader] CLIP视觉: {clip_vision_name}")
        print(f"[GJJ WanVideoModelLoader] 加速LoRA: {accel_lora_name} / 强度={accel_lora_strength}")

        # 处理 LoRA 输入，根据数据类型选择相应处理方式
        final_lora = self._normalize_lora_input(lora)
        final_lora = self._merge_accel_lora(final_lora, accel_lora_name, accel_lora_strength)
        if final_lora:
            print(f"[GJJ WanVideoModelLoader] LoRA 已处理，共 {len(final_lora)} 个 LoRA")

        wan_model_loading = _load_wanvideo_model_loading()
        WanVideoModelLoader = getattr(wan_model_loading, "WanVideoModelLoader")

        print(f"[GJJ WanVideoModelLoader] 正在加载模型...")
        
        model_result = WanVideoModelLoader().loadmodel(
            model=model,
            base_precision=base_precision,
            load_device=load_device,
            quantization=quantization,
            attention_mode=attention_mode,
            compile_args=compile_args,
            block_swap_args=block_swap_args,
            lora=final_lora,
            vram_management_args=vram_management_args,
            extra_model=extra_model,
            fantasytalking_model=fantasytalking_model,
            multitalk_model=multitalk_model,
            fantasyportrait_model=fantasyportrait_model,
            rms_norm_function=rms_norm_function,
        )
        wan_model = model_result[0] if isinstance(model_result, (tuple, list)) else model_result

        print(f"[GJJ WanVideoModelLoader] 正在加载 VAE / CLIP / CLIP视觉...")
        from .gjj_wanvideo_vae_loader import GJJ_WanVideoVAELoader

        if _is_missing_or_disabled(vae_name):
            raise RuntimeError("未选择 WanVideo VAE。请将 wan2_1_vae 模型放入 models/vae。")
        wan_vae = GJJ_WanVideoVAELoader().loadmodel(
            model_name=vae_name,
            precision=vae_precision,
            use_cpu_cache=vae_use_cpu_cache,
            verbose=False,
        )[0]
        clip = _load_clip_with_official_loader(clip_name, clip_type, clip_device)
        clip_vision = _load_clip_vision_with_official_loader(clip_vision_name)

        print(f"[GJJ WanVideoModelLoader] 模型加载完成")
        print(f"[GJJ WanVideoModelLoader] ========== 加载完成 ==========")

        return (wan_model, wan_vae, clip, clip_vision)

    def _normalize_lora_input(self, lora):
        """统一处理 LoRA 输入，根据数据类型选择相应处理方式。
        
        Args:
            lora: WANVIDLORA 列表 或 LORA_CHAIN_CONFIG JSON 字符串/列表
            
        Returns:
            WANVIDLORA 格式的 LoRA 列表，或 None
        """
        if lora is None:
            return None
        
        # 情况 1: 已经是 WANVIDLORA 格式（列表且包含 path 字段）
        if isinstance(lora, list) and lora and isinstance(lora[0], dict) and "path" in lora[0]:
            return lora
        
        # 情况 2: LORA_CHAIN_CONFIG 格式（JSON 字符串或列表）
        return self._convert_lora_chain_config(lora)

    def _convert_lora_chain_config(self, lora_chain_config):
        """将 LORA_CHAIN_CONFIG JSON 数据转换为 WANVIDLORA 格式。
        
        Args:
            lora_chain_config: JSON 字符串或已解析的列表
            
        Returns:
            WANVIDLORA 格式的 LoRA 列表，或 None
        """
        if lora_chain_config is None:
            return None
        
        # 解析 JSON 数据
        if isinstance(lora_chain_config, str):
            try:
                lora_list = json.loads(lora_chain_config)
            except json.JSONDecodeError as e:
                print(f"[GJJ WanVideoModelLoader] LoRA 串联配置 JSON 解析失败: {e}")
                return None
        elif isinstance(lora_chain_config, list):
            lora_list = lora_chain_config
        else:
            print(f"[GJJ WanVideoModelLoader] LoRA 串联配置类型无效: {type(lora_chain_config)}")
            return None
        
        if not isinstance(lora_list, list) or not lora_list:
            return None
        
        # 转换为 WANVIDLORA 格式
        wanvid_loras = []
        for item in lora_list:
            if not isinstance(item, dict):
                continue
            
            # 检查是否启用
            if item.get("enabled", True) is False:
                continue
            
            lora_name = item.get("name", "").strip()
            if not lora_name or lora_name.lower() == "none":
                continue
            
            strength = item.get("strength", 1.0)
            try:
                strength = float(strength)
            except (TypeError, ValueError):
                strength = 1.0
            
            if strength == 0.0:
                continue
            
            # 获取 LoRA 文件路径
            try:
                lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
            except Exception as e:
                print(f"[GJJ WanVideoModelLoader] 获取 LoRA 路径失败: {lora_name}, 错误: {e}")
                continue
            
            # 构建 WANVIDLORA 格式
            wanvid_loras.append({
                "path": lora_path,
                "strength": round(strength, 4),
                "name": os.path.splitext(lora_name)[0],
                "blocks": item.get("blocks", {}),
                "layer_filter": item.get("layer_filter", ""),
                "low_mem_load": item.get("low_mem_load", False),
                "merge_loras": item.get("merge_loras", True),
            })
        
        return wanvid_loras if wanvid_loras else None

    def _merge_accel_lora(self, existing_lora, accel_lora_name, accel_lora_strength):
        if _is_missing_or_disabled(accel_lora_name):
            return existing_lora
        try:
            strength = float(accel_lora_strength)
        except (TypeError, ValueError):
            strength = 1.2
        if abs(strength) < 1e-8:
            return existing_lora
        try:
            lora_path = folder_paths.get_full_path_or_raise("loras", accel_lora_name)
        except Exception as e:
            print(f"[GJJ WanVideoModelLoader] 加速 LoRA 路径获取失败: {accel_lora_name}, 错误: {e}")
            return existing_lora
        accel_item = {
            "path": lora_path,
            "strength": round(strength, 4),
            "name": os.path.splitext(str(accel_lora_name))[0],
            "blocks": {},
            "layer_filter": "",
            "low_mem_load": False,
            "merge_loras": True,
        }
        if existing_lora is None:
            return [accel_item]
        if isinstance(existing_lora, list):
            return [accel_item, *existing_lora]
        return [accel_item]


NODE_CLASS_MAPPINGS = {
    "GJJ_WanVideoModelLoader": GJJ_WanVideoModelLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WanVideoModelLoader": "🎬 WanVideo 模型加载器",
}
