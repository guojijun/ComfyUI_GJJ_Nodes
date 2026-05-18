from __future__ import annotations

import os
import sys
import gc

import torch

import folder_paths
import comfy.model_management as mm
from comfy.model_patcher import ModelPatcher

try:
    from server import PromptServer
except:
    PromptServer = None

_WANVIDEO_LOADED = False
_wan_video_wrapper = None

def _load_wanvideo_deps():
    global _WANVIDEO_LOADED, _wan_video_wrapper
    if _WANVIDEO_LOADED:
        return

    try:
        import WanVideoWrapper.nodes_model_loading as wan_video_module
        _wan_video_wrapper = wan_video_module
        _WANVIDEO_LOADED = True
    except ImportError as e:
        raise RuntimeError(
            f"缺少 WanVideoWrapper 依赖，请先安装 ComfyUI-WanVideoWrapper 插件。\n"
            f"错误信息: {e}\n"
            f"安装命令: git clone https://github.com/WanVideo/ComfyUI-WanVideoWrapper.git custom_nodes/ComfyUI-WanVideoWrapper"
        )

def _filter_models_by_keyword(model_list, keyword):
    keyword_lower = keyword.lower()
    filtered = [m for m in model_list if keyword_lower in m.lower()]
    if filtered:
        return filtered
    return model_list

def _get_multitalk_models():
    models = folder_paths.get_filename_list("diffusion_models")
    try:
        unet_gguf_models = folder_paths.get_filename_list("unet_gguf")
        models = unet_gguf_models + models
    except KeyError:
        pass
    return models

class GJJ_WanVideoModelLoader:
    @classmethod
    def INPUT_TYPES(s):
        all_models = folder_paths.get_filename_list("diffusion_models")
        wan_models = _filter_models_by_keyword(all_models, "wan")
        if not wan_models:
            wan_models = all_models

        multitalk_models = _get_multitalk_models()
        talk_models = _filter_models_by_keyword(multitalk_models, "talk")
        if not talk_models:
            talk_models = multitalk_models

        return {
            "required": {
                "model": (wan_models if wan_models else ["[未找到模型]"], {
                    "display_name": "📦 主模型",
                    "tooltip": "选择 WanVideo 主模型\n只显示包含 'wan' 关键词的模型",
                }),
                "base_precision": (["fp32", "bf16", "fp16", "fp16_fast"], {
                    "display_name": "⚙️ 基础精度",
                    "default": "bf16",
                    "tooltip": "模型权重的数据精度\nbf16: 平衡精度与显存（推荐）\nfp16: 较省显存\nfp32: 最高精度，最大显存\nfp16_fast: 快速 fp16，适合新显卡",
                }),
                "quantization": (["disabled", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e4m3fn_scaled",
                                "fp8_e4m3fn_scaled_fast", "fp8_e5m2", "fp8_e5m2_fast",
                                "fp8_e5m2_scaled", "fp8_e5m2_scaled_fast"], {
                    "display_name": "🔢 量化方法",
                    "default": "disabled",
                    "tooltip": "量化方法，用于减少显存占用\ndisabled: 禁用量化，使用原始精度\nfp8_e4m3fn: INT8 量化，适合 8GB 显存\nfp8_e4m3fn_scaled: 带缩放的 FP8，更精确\nfp8_e5m2: 另一个 INT8 量化方案",
                }),
                "load_device": (["main_device", "offload_device"], {
                    "display_name": "💾 加载设备",
                    "default": "offload_device",
                    "tooltip": "模型初始加载到的设备\nmain_device: 直接加载到 GPU（需要 48GB+ 显存）\noffload_device: 分块加载到 CPU，大模型推荐",
                }),
            },
            "optional": {
                "multitalk_model": (talk_models if talk_models else ["[未找到模型]"], {
                    "display_name": "🎤 MultiTalk 模型",
                    "tooltip": "选择 MultiTalk/InfiniteTalk 音频模型（可选）\n用于音频驱动的视频生成\n只显示包含 'talk' 关键词的模型",
                }),
                "attention_mode": (["sdpa", "flash_attn_2", "flash_attn_3", "sageattn", "sageattn_3",
                                   "radial_sage_attention", "sageattn_compiled", "sageattn_ultravico", "comfy"], {
                    "display_name": "🧠 Attention 模式",
                    "default": "sdpa",
                    "tooltip": "注意力机制实现方式\nsdpa: PyTorch 内置，兼容性好（推荐）\nflash_attn_2/3: 更快，需要对应硬件\nsageattn: SageAttention 库，更快\ncomfy: ComfyUI 优化版本",
                }),
                "rms_norm_function": (["default", "pytorch"], {
                    "display_name": "📐 RMSNorm 函数",
                    "default": "default",
                    "tooltip": "RMSNorm 归一化函数的实现\ndefault: 原始实现，更精确\npytorch: PyTorch 实现，稍快但结果略有不同",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("WANVIDEOMODEL", "MULTITALKMODEL")
    RETURN_NAMES = ("📹 WanVideo 模型", "🎤 MultiTalk 模型")
    OUTPUT_TOOLTIPS = ("WanVideo 主模型，用于视频生成", "MultiTalk/InfiniteTalk 音频模型，用于音频驱动的口型同步")
    FUNCTION = "loadmodel"
    CATEGORY = "GJJ/视频模型"
    DESCRIPTION = "WanVideo 模型加载器 - 支持 MultiTalk 音频模型"

    def loadmodel(self, model, base_precision, quantization, load_device,
                  multitalk_model=None, attention_mode="sdpa", rms_norm_function="default",
                  unique_id=None, extra_pnginfo=None):
        _load_wanvideo_deps()

        loader = _wan_video_wrapper.WanVideoModelLoader()
        wanvideo_result = loader.loadmodel(
            model=model,
            base_precision=base_precision,
            quantization=quantization,
            load_device=load_device,
            attention_mode=attention_mode,
            rms_norm_function=rms_norm_function,
            unique_id=unique_id,
            extra_pnginfo=extra_pnginfo
        )

        multitalk_result = None
        if multitalk_model and multitalk_model not in ("[未找到模型]", ""):
            try:
                from WanVideoWrapper.multitalk.nodes import MultiTalkModelLoader
                multitalk_loader = MultiTalkModelLoader()
                multitalk_result = multitalk_loader.loadmodel(model=multitalk_model)
            except Exception as e:
                if PromptServer:
                    PromptServer.instance.send_sync("gjj_wanvideo_model_loader_error", {
                        "node": unique_id,
                        "title": "加载 MultiTalk 模型失败",
                        "message": str(e),
                    })
                raise RuntimeError(f"加载 MultiTalk 模型失败: {e}")

        return (wanvideo_result, multitalk_result)

NODE_CLASS_MAPPINGS = {
    "GJJ_WanVideoModelLoader": GJJ_WanVideoModelLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WanVideoModelLoader": "🎬 WanVideo 模型加载器",
}
