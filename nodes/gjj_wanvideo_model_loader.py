from __future__ import annotations

import gc
import json
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

        # 处理 LoRA 输入，根据数据类型选择相应处理方式
        final_lora = self._normalize_lora_input(lora)
        if final_lora:
            print(f"[GJJ WanVideoModelLoader] LoRA 已处理，共 {len(final_lora)} 个 LoRA")

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
            lora=final_lora,
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


NODE_CLASS_MAPPINGS = {
    "GJJ_WanVideoModelLoader": GJJ_WanVideoModelLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WanVideoModelLoader": "🎬 WanVideo 模型加载器",
}
