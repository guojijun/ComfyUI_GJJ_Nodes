from __future__ import annotations

import gc
import os
import sys
import torch

import folder_paths
import comfy.model_management as mm
from comfy.utils import load_torch_file


NODE_NAME = "GJJ_WanVideoModelLoader"


def _load_wanvideo_model_loading():
    """懒加载 WanVideoWrapper 模型加载模块"""
    try:
        from ..vendor.wanvideo_wrapper import nodes_model_loading
    except ImportError as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo 模型加载模块失败。\n"
            f"错误信息: {error}\n"
            "说明: 本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时，不依赖外部 ComfyUI-WanVideoWrapper 插件。"
        ) from error
    return nodes_model_loading


def _scan_diffusion_models(keyword="wan"):
    """扫描 diffusion_models 目录，按关键词过滤并返回模型列表。
    
    Args:
        keyword: 过滤关键词，默认 "wan"
    
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
    
    keyword_lower = keyword.lower()
    matched = [
        name for name in all_models
        if keyword_lower in name.lower()
    ]
    
    if matched:
        return matched, matched[0]
    
    return all_models, all_models[0]


class GJJ_WanVideoModelLoader:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "loadmodel"
    DESCRIPTION = "加载 WanVideo 扩散模型，支持多种精度和量化选项。"
    SEARCH_ALIASES = [
        "WanVideo Model Loader",
        "WanVideo 模型加载",
        "Wan2.1 模型",
    ]
    RETURN_TYPES = ("WANVIDEOMODEL",)
    RETURN_NAMES = ("模型",)
    OUTPUT_TOOLTIPS = ("加载的 WanVideo 模型",)

    @classmethod
    def INPUT_TYPES(cls):
        diffusion_models, default_model = _scan_diffusion_models("wan")
        
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
                        "display_name": "模型选择",
                        "tooltip": "自动搜索 diffusion_models 和 unet_gguf 目录，默认优先显示包含 wan 的模型。",
                    },
                ),
                "base_precision": (
                    ["fp32", "bf16", "fp16", "fp16_fast"],
                    {
                        "default": "bf16",
                        "display_name": "基础精度",
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
                        "display_name": "量化",
                        "tooltip": "可选量化方法，disabled 为自动检测。_fast 模式需要 CUDA 计算能力 >= 8.9。",
                    },
                ),
                "load_device": (
                    ["main_device", "offload_device"],
                    {
                        "default": "offload_device",
                        "display_name": "加载设备",
                        "tooltip": "模型初始加载设备，除非有 48GB+ 显存否则推荐 offload_device。",
                    },
                ),
            },
            "optional": {
                "attention_mode": (
                    attention_modes,
                    {
                        "default": "sdpa",
                        "display_name": "注意力模式",
                        "tooltip": "注意力计算模式，sdpa 为 PyTorch 内置。",
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
                    "WANVIDLORA",
                    {
                        "default": None,
                        "display_name": "LoRA",
                        "tooltip": "WanVideo LoRA 权重。",
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
        print(f"[GJJ WanVideoModelLoader] ========== 开始加载模型 ==========")
        print(f"[GJJ WanVideoModelLoader] 模型: {model}")
        print(f"[GJJ WanVideoModelLoader] 基础精度: {base_precision}")
        print(f"[GJJ WanVideoModelLoader] 量化: {quantization}")
        print(f"[GJJ WanVideoModelLoader] 加载设备: {load_device}")
        print(f"[GJJ WanVideoModelLoader] 注意力模式: {attention_mode}")
        print(f"[GJJ WanVideoModelLoader] RMSNorm: {rms_norm_function}")

        wan_model_loading = _load_wanvideo_model_loading()
        WanVideoModelLoader = getattr(wan_model_loading, "WanVideoModelLoader")

        print(f"[GJJ WanVideoModelLoader] 正在加载模型...")
        
        result = WanVideoModelLoader().loadmodel(
            model=model,
            base_precision=base_precision,
            load_device=load_device,
            quantization=quantization,
            attention_mode=attention_mode,
            compile_args=compile_args,
            block_swap_args=block_swap_args,
            lora=lora,
            vram_management_args=vram_management_args,
            extra_model=extra_model,
            fantasytalking_model=fantasytalking_model,
            multitalk_model=multitalk_model,
            fantasyportrait_model=fantasyportrait_model,
            rms_norm_function=rms_norm_function,
        )

        print(f"[GJJ WanVideoModelLoader] 模型加载完成")
        print(f"[GJJ WanVideoModelLoader] ========== 加载完成 ==========")

        return result


NODE_CLASS_MAPPINGS = {
    "GJJ_WanVideoModelLoader": GJJ_WanVideoModelLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WanVideoModelLoader": "🎬 WanVideo 模型加载器",
}
