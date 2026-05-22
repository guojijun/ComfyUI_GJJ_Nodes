from __future__ import annotations

import torch

import folder_paths
import comfy.model_management as mm
from comfy.utils import load_torch_file


NODE_NAME = "GJJ_WanVideoVAELoader"


def _load_wan_video_vae():
    """懒加载 WanVideoVAE 依赖"""
    try:
        from ..vendor.wanvideo_wrapper.wanvideo import wan_video_vae as vae_module
    except ImportError as error:
        raise RuntimeError(
            "GJJ 内置 WanVideoVAE 加载失败。\n"
            f"错误信息: {error}\n"
            "说明: 本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时，不依赖外部 ComfyUI-WanVideoWrapper 插件。"
        ) from error
    
    WanVideoVAE = getattr(vae_module, "WanVideoVAE")
    WanVideoVAE38 = getattr(vae_module, "WanVideoVAE38")
    
    return WanVideoVAE, WanVideoVAE38


def _get_offload_device():
    """获取卸载设备"""
    try:
        return mm.unet_offload_device()
    except Exception:
        return torch.device("cpu")


class GJJ_WanVideoVAELoader:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "loadmodel"
    DESCRIPTION = "加载 WanVideo VAE 模型，支持自动检测模型类型（标准/38层/轻量）"
    SEARCH_ALIASES = [
        "WanVideo VAE",
        "Wan VAE Loader",
        "视频 VAE",
        "Wan2.1 VAE",
    ]
    RETURN_TYPES = ("WANVAE",)
    RETURN_NAMES = ("vae",)
    OUTPUT_TOOLTIPS = ("加载的 WanVideo VAE 模型，可用于视频解码。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_name": (
                    folder_paths.get_filename_list("vae"),
                    {
                        "display_name": "模型选择",
                        "tooltip": "自动搜索 ComfyUI/models/vae/ 及其子目录。",
                    },
                ),
            },
            "optional": {
                "precision": (
                    ["bf16", "fp16", "fp32"],
                    {
                        "default": "bf16",
                        "display_name": "精度",
                        "tooltip": "模型计算精度，bf16 推荐用于现代 GPU。",
                    },
                ),
                "use_cpu_cache": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "使用 CPU 缓存",
                        "tooltip": "开启后减少 VRAM 使用，但会显著降低解码速度。",
                    },
                ),
                "verbose": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "详细日志",
                        "tooltip": "开启后在使用模型时打印内存使用情况。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def loadmodel(
        self,
        model_name,
        precision="bf16",
        use_cpu_cache=False,
        verbose=False,
        unique_id=None,
        extra_pnginfo=None,
    ):
        print(f"[GJJ WanVideoVAE] ========== 开始加载 VAE ==========")
        print(f"[GJJ WanVideoVAE] 模型名称: {model_name}")
        print(f"[GJJ WanVideoVAE] 精度: {precision}")
        print(f"[GJJ WanVideoVAE] 使用 CPU 缓存: {use_cpu_cache}")
        
        # 懒加载依赖
        WanVideoVAE, WanVideoVAE38 = _load_wan_video_vae()
        
        # 设置精度
        dtype_map = {
            "bf16": torch.bfloat16,
            "fp16": torch.float16,
            "fp32": torch.float32,
        }
        dtype = dtype_map.get(precision, torch.bfloat16)
        
        # 获取模型路径
        try:
            model_path = folder_paths.get_full_path_or_raise("vae", model_name)
        except Exception as e:
            raise RuntimeError(f"找不到 VAE 模型：{model_name}\n请确保模型已放入 ComfyUI/models/vae/ 目录。") from e
        
        print(f"[GJJ WanVideoVAE] 模型路径: {model_path}")
        
        # 加载模型权重
        print(f"[GJJ WanVideoVAE] 正在加载模型文件...")
        vae_sd = load_torch_file(model_path, safe_load=True)
        print(f"[GJJ WanVideoVAE] 模型文件加载完成，共 {len(vae_sd)} 个权重")
        
        # 标准化模型前缀
        has_model_prefix = any(k.startswith("model.") for k in vae_sd.keys())
        if not has_model_prefix:
            print(f"[GJJ WanVideoVAE] 检测到无前缀模型，自动添加 'model.' 前缀")
            vae_sd = {f"model.{k}": v for k, v in vae_sd.items()}
        
        # 自动检测模型类型
        try:
            dim = vae_sd["model.decoder.conv1.bias"].shape[0]
            if dim == 96:
                print(f"[GJJ WanVideoVAE] 检测到 LightVAE 模型（75% 剪枝）")
                pruning_rate = 0.75
            else:
                print(f"[GJJ WanVideoVAE] 检测到标准 VAE 模型")
                pruning_rate = 0.0
            
            conv2_channels = vae_sd["model.conv2.weight"].shape[0]
            if conv2_channels == 16:
                print(f"[GJJ WanVideoVAE] 使用标准 WanVideoVAE（conv2 channels: {conv2_channels}）")
                vae_class = WanVideoVAE
            elif conv2_channels == 48:
                print(f"[GJJ WanVideoVAE] 使用 WanVideoVAE38 模型（conv2 channels: {conv2_channels}）")
                vae_class = WanVideoVAE38
            else:
                raise RuntimeError(f"不支持的 VAE 模型类型（conv2 channels: {conv2_channels}）")
        except KeyError as e:
            raise RuntimeError(f"模型权重格式不正确，缺少必需的权重：{e}") from e
        
        # 创建 VAE 实例
        offload_device = _get_offload_device()
        print(f"[GJJ WanVideoVAE] 正在创建 VAE 实例...")
        
        vae = vae_class(
            dtype=dtype,
            pruning_rate=pruning_rate,
            cpu_cache=use_cpu_cache,
            verbose=verbose,
        )
        
        # 加载权重
        print(f"[GJJ WanVideoVAE] 正在加载权重到 VAE...")
        vae.load_state_dict(vae_sd)
        del vae_sd
        
        # 设置模型为评估模式
        vae.eval()
        
        # 将模型移动到设备
        print(f"[GJJ WanVideoVAE] 正在将模型移动到 {offload_device}...")
        vae.to(device=offload_device, dtype=dtype)
        
        print(f"[GJJ WanVideoVAE] ========== VAE 加载完成 ==========")
        
        return (vae,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanVideoVAELoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🎬 WanVideo VAE 加载器"}
