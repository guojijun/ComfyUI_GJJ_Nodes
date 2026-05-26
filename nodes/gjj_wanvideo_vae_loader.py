from __future__ import annotations

import sys
import torch

import folder_paths
import comfy.model_management as mm
from comfy.utils import load_torch_file

# 导入公共依赖检查器
try:
    from .common_utils.dependency_checker import (
        check_dependencies,
        load_dependency_at_runtime,
        print_runtime_dependency_error,
        build_dependency_model_report,
        print_dependency_model_report,
        get_pip_install_command_text,
    )
except ImportError:
    from common_utils.dependency_checker import (
        check_dependencies,
        load_dependency_at_runtime,
        print_runtime_dependency_error,
        build_dependency_model_report,
        print_dependency_model_report,
        get_pip_install_command_text,
    )

NODE_NAME = "GJJ_WanVideoVAELoader"
NODE_DISPLAY_NAME = "🎬 WanVideo VAE 加载器"
LONGCAT_VAE_MODEL = "Wan2_1_VAE_bf16.safetensors"

# ============================================================================
# 启动时依赖检查
# ============================================================================
_DEPENDENCIES_AVAILABLE = False
_DESCRIPTION = "加载 WanVideo VAE 模型，支持自动检测模型类型（标准/38层/轻量）"
_GJJ_HELP = {
    "title": "WanVideo VAE 加载器",
    "description": "加载 WanVideo 系列 VAE 模型，用于视频帧的编码与解码。",
    "usage": [
        "模型选择：从 models/vae/ 目录及其子目录中自动扫描可用模型。",
        "精度：bf16 推荐用于现代 GPU，fp16 兼容性好，fp32 精度最高但显存占用大。",
        "使用 CPU 缓存：开启后减少 VRAM 使用，但会显著降低速度。",
    ],
    "dependencies": [
        "accelerate：WanVideo 模型加载需要 accelerate 库做权重分配。",
        "einops：WanVideo VAE 结构需要 einops 做张量维度重排。",
    ],
    "optional_dependencies": [
        "gguf：仅在加载 GGUF 量化格式 VAE 模型时需要，普通 safetensors 格式不需要。",
    ],
    "notes": [
        "本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时。",
        "缺失依赖时，节点面板会显示复制安装命令按钮，点击后可在 PowerShell 中直接执行安装。",
        "安装完成后请重启 ComfyUI 服务器。",
    ],
}


def _check_startup_dependencies():
    """启动时检查依赖，只跳过当前节点，不影响其他节点。"""
    global _DEPENDENCIES_AVAILABLE, _DESCRIPTION

    # 定义必需依赖及其描述
    required_deps = [
        ("accelerate", "WanVideo 模型加载需要 accelerate 库做权重分配。"),
        ("einops", "WanVideo VAE 结构需要 einops 做张量维度重排。"),
    ]

    # 检查缺失的依赖
    missing_deps = []
    for module_name, description in required_deps:
        try:
            __import__(module_name)
        except ImportError:
            missing_deps.append({
                "module_name": module_name,
                "package_name": module_name,
                "display_name": module_name,
                "description": description,
            })

    if missing_deps:
        _DEPENDENCIES_AVAILABLE = False
        
        # 使用公共函数生成报告
        report = build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=missing_deps,
            install_packages=[m["package_name"] for m in missing_deps],
        )
        
        _DESCRIPTION = report.get("warning_message", _DESCRIPTION)
        _GJJ_HELP["description"] = report.get("panel_message", _GJJ_HELP["description"])
        _GJJ_HELP["install_cmd"] = report.get("install_cmd", "")
        _GJJ_HELP["warning_message"] = report.get("warning_message", "")

        # 打印控制台报告
        try:
            print_dependency_model_report(
                report,
                title="GJJ WanVideo VAE 加载器 启动时依赖缺失！",
            )
        except Exception:
            pass
    else:
        _DEPENDENCIES_AVAILABLE = True
        _DESCRIPTION = f"✅ {_DESCRIPTION}"


# 启动时检查依赖
_check_startup_dependencies()


def _filter_vae_models(keyword: str = "wan"):
    models = list(folder_paths.get_filename_list("vae") or [])
    needle = str(keyword or "").strip().lower()
    if not needle:
        return models
    filtered = [name for name in models if needle in str(name).lower()]
    values = filtered or models
    preferred = next((name for name in values if str(name).replace("\\", "/").endswith(LONGCAT_VAE_MODEL)), None)
    if preferred:
        return [preferred] + [name for name in values if name != preferred]
    return values


def _load_wan_video_vae():
    """懒加载 WanVideoVAE 依赖"""
    # 为可选依赖 gguf 创建占位模块，避免 vendor 导入链中断
    if "gguf" not in sys.modules:
        import types
        gguf_stub = types.ModuleType("gguf")
        gguf_stub.GGML_QUANT_SIZES = {}
        gguf_stub.GGMLQuantizationType = type("GGMLQuantizationType", (), {
            "F32": 0,
            "F16": 1,
            "BF16": 2,
            "Q8_0": 3,
            "Q5_1": 4,
            "Q5_0": 5,
            "Q4_1": 6,
            "Q4_0": 7,
            "Q6_K": 8,
            "Q5_K": 9,
            "Q4_K": 10,
            "Q3_K": 11,
            "Q2_K": 12,
        })
        sys.modules["gguf"] = gguf_stub

    try:
        from ..vendor.wanvideo_wrapper.wanvideo import wan_video_vae as vae_module
    except ImportError as error:
        raise RuntimeError(
            "GJJ 内置 WanVideoVAE 加载失败。\n"
            f"错误信息: {error}\n"
            "说明: 本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时。"
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
    DESCRIPTION = _DESCRIPTION
    SEARCH_ALIASES = [
        "WanVideo VAE",
        "Wan VAE Loader",
        "视频 VAE",
        "Wan2.1 VAE",
    ]
    RETURN_TYPES = ("WANVAE",)
    RETURN_NAMES = ("vae",)
    OUTPUT_TOOLTIPS = ("加载的 WanVideo VAE 模型，可用于视频解码。",)

    GJJ_HELP = _GJJ_HELP

    @classmethod
    def INPUT_TYPES(cls):
        vae_models = _filter_vae_models("wan")
        return {
            "required": {
                "model_name": (
                    vae_models,
                    {
                        "default": vae_models[0] if vae_models else None,
                        "display_name": "模型选择",
                        "tooltip": "自动搜索 ComfyUI/models/vae/ 及其子目录，默认按关键词 wan 过滤；若无匹配则显示全部。",
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
                "compile_args": (
                    "WANCOMPILEARGS",
                    {
                        "display_name": "编译参数",
                        "tooltip": "可选。连接 GJJ · ⚙️ WanVideo编译设置 后，对 VAE decoder 使用 torch.compile。",
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
        compile_args=None,
        use_cpu_cache=False,
        verbose=False,
        unique_id=None,
        extra_pnginfo=None,
    ):
        print(f"[GJJ WanVideoVAE] ========== 开始加载 VAE ==========")
        print(f"[GJJ WanVideoVAE] 模型名称: {model_name}")
        print(f"[GJJ WanVideoVAE] 精度: {precision}")
        print(f"[GJJ WanVideoVAE] 使用 CPU 缓存: {use_cpu_cache}")
        
        # 运行时依赖检查
        try:
            WanVideoVAE, WanVideoVAE38 = _load_wan_video_vae()
        except RuntimeError as e:
            # 使用公共函数处理运行时依赖错误（传递 unique_id 以支持前端通知）
            print_runtime_dependency_error(
                node_name=NODE_DISPLAY_NAME,
                dependency_name="accelerate einops",
                description=str(e),
                unique_id=unique_id,
            )
            raise
        except Exception as e:
            # 使用公共函数处理运行时依赖错误（传递 unique_id 以支持前端通知）
            print_runtime_dependency_error(
                node_name=NODE_DISPLAY_NAME,
                dependency_name="accelerate einops",
                description=str(e),
                unique_id=unique_id,
            )
            raise RuntimeError(
                f"GJJ 内置 WanVideoVAE 加载失败。\n"
                f"错误信息: {e}\n"
                f"说明: 本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时。"
            ) from e
        
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

        if compile_args is not None:
            try:
                print("[GJJ WanVideoVAE] 正在编译 VAE decoder...")
                vae.model.decoder = torch.compile(
                    vae.model.decoder,
                    fullgraph=compile_args["fullgraph"],
                    dynamic=compile_args["dynamic"],
                    backend=compile_args["backend"],
                    mode=compile_args["mode"],
                )
                print("[GJJ WanVideoVAE] VAE decoder 编译完成")
            except Exception as e:
                raise RuntimeError(
                    "VAE decoder 编译失败。\n"
                    "建议先断开“编译参数”输入确认模型可正常加载，再调整 torch.compile 设置。\n"
                    f"原始错误: {e}"
                ) from e
        
        print(f"[GJJ WanVideoVAE] ========== VAE 加载完成 ==========")
        
        return (vae,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanVideoVAELoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
