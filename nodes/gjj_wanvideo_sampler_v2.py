from __future__ import annotations

import sys
from typing import Any

# ============================================================================
# 导入公共依赖检查工具
# ============================================================================
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


NODE_NAME = "GJJ_WanVideoSamplerV2"
NODE_DISPLAY_NAME = "🎬 WanVideo Sampler v2"

# ============================================================================
# 节点描述和帮助信息
# ============================================================================
_DESCRIPTION = "GJJ WanVideo 视频采样器 v2：固定经典插槽版，调用 GJJ 内置 vendored WanVideoWrapper 核心 runtime。"
_GJJ_HELP = {
    "title": "WanVideo Sampler v2",
    "description": "复刻 WanVideoWrapper 的 Sampler 调用层。此版使用固定经典插槽，避免前端动态重排导致类型错位。",
    "usage": [
        "模型选择：由 WanVideo 模型加载器输出的 WANVIDEOMODEL。",
        "调度器：直接在节点面板选择采样调度器（unipc、dpm++_sde、euler 等）。",
        "采样步数：控制生成质量，通常 6-20 步即可。",
        "CFG：提示词引导强度，1.0-5.0 为常用范围。",
    ],
    "dependencies": [
        "accelerate：WanVideo 采样需要 accelerate 库做权重分配和模型加载。",
        "einops：WanVideo 模型结构需要 einops 做张量维度重排。",
        "diffusers：WanVideo 采样需要 diffusers 库提供调度器和工具函数。",
        "ftfy：WanVideo 文本处理需要 ftfy 修复文本编码问题。",
    ],
    "optional_dependencies": [
        "triton-windows：PyTorch 编译加速需要 triton-windows 库（Windows 专用，用于 torch.compile/torch._inductor）。",
        "triton：PyTorch 编译加速需要 triton 库（Linux/macOS 专用，用于 torch.compile/torch._inductor）。",
        "peft：LoRA 支持需要 peft 库。",
        "sentencepiece：分词器需要 sentencepiece 库。",
        "protobuf：模型序列化需要 protobuf 库。",
        "gguf：GGUF 格式模型支持需要 gguf 库。",
        "opencv-python：图像处理功能需要 opencv-python 库。",
        "scipy：科学计算需要 scipy 库。",
    ],
    "🌏模型下载": "复用本机 ComfyUI models/diffusion_models、models/unet_gguf、models/vae 等 WanVideo 模型目录。",
    "runtime": "无需安装 ComfyUI-WanVideoWrapper 插件本体；pip 依赖仍按 GJJ SKILL 的 WanVideo 运行时依赖方案安装。",
    "notes": [
        "缺失依赖时，节点面板会显示复制安装命令按钮，点击后可在 PowerShell 中直接执行安装。",
        "安装完成后请重启 ComfyUI 服务器。",
    ],
}


def _check_startup_dependencies():
    """启动时检查依赖，只跳过当前节点，不影响其他节点。"""
    global _DESCRIPTION

    import platform

    # 定义必需依赖及其描述（基于 vendor/wanvideo_wrapper/requirements.txt + PyTorch 运行时组件）
    required_deps = [
        ("accelerate", "WanVideo 采样需要 accelerate 库做权重分配和模型加载。"),
        ("einops", "WanVideo 模型结构需要 einops 做张量维度重排。"),
        ("diffusers", "WanVideo 采样需要 diffusers 库提供调度器和工具函数。"),
        ("ftfy", "WanVideo 文本处理需要 ftfy 修复文本编码问题。"),
    ]

    # Triton 依赖检查（根据平台选择正确的包名）
    system = platform.system()
    if system == "Windows":
        # Windows 使用 triton-windows 包
        try:
            __import__("triton")
        except ImportError:
            required_deps.append(
                ("triton-windows", "PyTorch 编译加速需要 triton-windows 库（用于 torch.compile/torch._inductor）。")
            )
    elif system in ["Linux", "Darwin"]:  # Darwin = macOS
        required_deps.append(
            ("triton", "PyTorch 编译加速需要 triton 库（用于 torch.compile/torch._inductor）。")
        )

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
                title="GJJ WanVideo Sampler v2 启动时依赖缺失！",
            )
        except Exception:
            pass
    else:
        _DESCRIPTION = f"✅ {_DESCRIPTION}"


# 启动时检查依赖
_check_startup_dependencies()


WANVIDEO_SAMPLER_SCHEDULER_CHOICES = [
    "unipc",
    "unipc/beta",
    "dpm++",
    "dpm++/beta",
    "dpm++_sde",
    "dpm++_sde/beta",
    "euler",
    "euler/beta",
    "longcat_distill_euler",
    "deis",
    "lcm",
    "lcm/beta",
    "res_multistep",
    "er_sde",
    "flowmatch_causvid",
    "flowmatch_distill",
    "flowmatch_pusa",
    "multitalk",
    "sa_ode_stable",
    "rcm",
    "vibt_unipc",
]


def _load_sampler_runtime():
    try:
        from ..vendor.wanvideo_wrapper import nodes_sampler as sampler_runtime
    except ImportError as error:
        # 使用公共函数处理运行时依赖错误（不传 unique_id，因为这是模块级加载）
        print_runtime_dependency_error(
            node_name=NODE_DISPLAY_NAME,
            dependency_name="accelerate/einops/diffusers/ftfy",
            description=str(error),
        )
        raise RuntimeError(
            "GJJ 内置 WanVideo 采样 runtime 加载失败。\n"
            f"错误信息: {error}\n"
            "说明: 本节点不依赖 ComfyUI-WanVideoWrapper 插件本体；如果缺少 accelerate、einops、diffusers、ftfy 等 pip 库，请按 GJJ SKILL 的运行时依赖方案安装。"
        ) from error
    return sampler_runtime


def _model_runtime_module_name(model):
    try:
        transformer = model.model.diffusion_model
        return str(transformer.__class__.__module__ or "")
    except Exception:
        return ""


def _is_gjj_vendored_model(model):
    module_name = _model_runtime_module_name(model)
    return ".vendor.wanvideo_wrapper." in module_name or module_name.startswith(
        "ComfyUI_GJJ_Nodes.vendor.wanvideo_wrapper"
    )


def _source_wanvideo_sampler_if_loaded(model):
    if _is_gjj_vendored_model(model):
        return None
    comfy_nodes = sys.modules.get("nodes")
    mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}) if comfy_nodes is not None else {}
    sampler_cls = mappings.get("WanVideoSampler")
    if sampler_cls is None:
        return None
    module_name = str(getattr(sampler_cls, "__module__", "") or "")
    if ".vendor.wanvideo_wrapper." in module_name or module_name.startswith(
        "ComfyUI_GJJ_Nodes.vendor.wanvideo_wrapper"
    ):
        return None
    try:
        return sampler_cls()
    except Exception:
        return None


def _unwrap_compiled_module(module):
    while hasattr(module, "_orig_mod"):
        module = module._orig_mod
    return module


def _disable_model_compile_runtime(patcher):
    """在当前已加载模型上禁用 compile，并尽量解包已包装的模块。"""
    try:
        model = getattr(patcher, "model", None)
        if model is None:
            return False

        changed = False

        try:
            if model["compile_args"] is not None:
                model["compile_args"] = None
                changed = True
        except Exception:
            pass

        transformer = getattr(model, "diffusion_model", None)
        if transformer is None:
            return changed

        unwrapped_transformer = _unwrap_compiled_module(transformer)
        if unwrapped_transformer is not transformer:
            try:
                model.diffusion_model = unwrapped_transformer
                transformer = unwrapped_transformer
                changed = True
            except Exception:
                transformer = unwrapped_transformer

        for attr_name in ("blocks", "vace_blocks"):
            blocks = getattr(transformer, attr_name, None)
            if blocks is None:
                continue
            try:
                for index, block in enumerate(blocks):
                    unwrapped_block = _unwrap_compiled_module(block)
                    if unwrapped_block is not block:
                        blocks[index] = unwrapped_block
                        changed = True
            except Exception:
                continue

        return changed
    except Exception:
        return False


def _scheduler_choices():
    try:
        runtime = _load_sampler_runtime()
        choices = list(getattr(runtime, "scheduler_list", []) or [])
        return choices or WANVIDEO_SAMPLER_SCHEDULER_CHOICES
    except Exception:
        return WANVIDEO_SAMPLER_SCHEDULER_CHOICES


def _scheduler_default(preferred="dpm++_sde"):
    choices = _scheduler_choices()
    if preferred in choices:
        return preferred
    if "unipc" in choices:
        return "unipc"
    return choices[0] if choices else "unipc"


def _rope_choices():
    try:
        runtime = _load_sampler_runtime()
        choices = list(getattr(runtime, "rope_functions", []) or [])
        return choices or ["default", "comfy", "comfy_chunked"]
    except Exception:
        return ["default", "comfy", "comfy_chunked"]


def _as_int(value, default, min_value=None, max_value=None):
    if isinstance(value, bool):
        result = default
    else:
        try:
            result = int(value)
        except (TypeError, ValueError):
            result = default
    if min_value is not None:
        result = max(min_value, result)
    if max_value is not None:
        result = min(max_value, result)
    return result


def _as_float(value, default, min_value=None, max_value=None):
    if isinstance(value, bool):
        result = default
    else:
        try:
            result = float(value)
        except (TypeError, ValueError):
            result = default
    if min_value is not None:
        result = max(min_value, result)
    if max_value is not None:
        result = min(max_value, result)
    return result


def _as_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"true", "1", "yes", "on"}:
            return True
        if text in {"false", "0", "no", "off"}:
            return False
    return default


def _as_choice(value, choices, default):
    if isinstance(value, str) and value in choices:
        return value
    return default


def _merge_extra_args(args: dict[str, Any], extra_args: Any) -> None:
    if extra_args is None:
        return
    if not isinstance(extra_args, dict):
        raise TypeError("WanVideo 采样扩展参数必须是字典类型，请连接 GJJ · 🧰 WanVideo 采样扩展参数。")
    for key, value in extra_args.items():
        if value is not None:
            args[key] = value


class GJJ_WanVideoSchedulerV2:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scheduler": (
                    _scheduler_choices(),
                    {
                        "default": "unipc",
                        "display_name": "调度器",
                        "tooltip": "WanVideo 采样调度器。输出会连接到 GJJ WanVideo Sampler v2。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 30,
                        "min": 1,
                        "step": 1,
                        "display_name": "步数",
                        "tooltip": "采样总步数。",
                    },
                ),
                "shift": (
                    "FLOAT",
                    {
                        "default": 5.0,
                        "min": 0.0,
                        "max": 1000.0,
                        "step": 0.01,
                        "display_name": "Shift",
                        "tooltip": "WanVideo flow shift 参数，常用默认值为 5.0。",
                    },
                ),
                "start_step": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "step": 1,
                        "display_name": "起始步",
                        "tooltip": "从指定步开始采样；0 表示从头开始。",
                    },
                ),
                "end_step": (
                    "INT",
                    {
                        "default": -1,
                        "min": -1,
                        "step": 1,
                        "display_name": "结束步",
                        "tooltip": "-1 表示采完整段；其它值表示提前结束。",
                    },
                ),
            },
            "optional": {
                "sigmas": (
                    "SIGMAS",
                    {
                        "display_name": "Sigmas",
                        "tooltip": "可选自定义 sigmas；不连接时由调度器自动生成。",
                    },
                ),
                "enhance_hf": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "增强高频",
                        "tooltip": "启用 WanVideoWrapper 的高频增强调度。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("WANVIDEOSCHEDULER",)
    RETURN_NAMES = ("调度器",)
    OUTPUT_TOOLTIPS = ("WanVideo Sampler v2 使用的调度器配置。",)
    FUNCTION = "process"
    CATEGORY = "GJJ/视频模型/WanVideo"
    DESCRIPTION = "GJJ WanVideo 调度器 v2：调用 GJJ 内置 vendored WanVideo runtime。"
    GJJ_HELP = {
        "title": "WanVideo 调度器 v2",
        "description": "生成 WanVideo Sampler v2 需要的调度器对象；GJJ 已 vendoring 核心 runtime，不需要安装 WanVideoWrapper 插件本体。",
        "runtime": "pip 运行时依赖仍按 GJJ SKILL 的 WanVideo 运行时依赖方案安装。",
    }

    def process(self, scheduler, steps, shift, start_step, end_step, unique_id=None, sigmas=None, enhance_hf=False):
        runtime = _load_sampler_runtime()
        node = runtime.WanVideoSchedulerv2()
        return node.process(
            scheduler=scheduler,
            steps=_as_int(steps, 30, min_value=1),
            shift=_as_float(shift, 5.0, min_value=0.0, max_value=1000.0),
            start_step=_as_int(start_step, 0, min_value=0),
            end_step=_as_int(end_step, -1, min_value=-1),
            unique_id=unique_id,
            sigmas=sigmas,
            enhance_hf=_as_bool(enhance_hf, False),
        )


class GJJ_WanVideoSamplerV2ExtraArgs:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "riflex_freq_index": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 1000,
                        "step": 1,
                        "display_name": "RIFLEX 频率索引",
                        "tooltip": "0 表示关闭；用于减少续帧循环感。",
                    },
                ),
                "feta_args": (
                    "FETAARGS",
                    {
                        "display_name": "FETA 参数",
                        "tooltip": "可选 FETA 增强参数。",
                    },
                ),
                "context_options": (
                    "WANVIDCONTEXT",
                    {
                        "display_name": "上下文窗口",
                        "tooltip": "可选长视频上下文窗口配置。",
                    },
                ),
                "cache_args": (
                    "CACHEARGS",
                    {
                        "display_name": "缓存参数",
                        "tooltip": "可选 TeaCache/MagCache/EasyCache 等缓存配置。",
                    },
                ),
                "teacache_args": (
                    "CACHEARGS",
                    {
                        "display_name": "TeaCache 兼容参数",
                        "tooltip": "旧版 TeaCache 参数入口；连接后会覆盖缓存参数。",
                    },
                ),
                "flowedit_args": (
                    "FLOWEDITARGS",
                    {
                        "display_name": "FlowEdit 参数",
                        "tooltip": "WanVideoWrapper 已废弃该入口，保留用于旧工作流兼容。",
                    },
                ),
                "slg_args": (
                    "SLGARGS",
                    {
                        "display_name": "SLG 参数",
                        "tooltip": "可选 Skip Layer Guidance 参数。",
                    },
                ),
                "rope_function": (
                    ["default", "comfy", "comfy_chunked"],
                    {
                        "default": "comfy",
                        "display_name": "RoPE 函数",
                        "tooltip": "comfy 通常更快；comfy_chunked 峰值显存更低；特殊模型可用 default。",
                    },
                ),
                "loop_args": (
                    "LOOPARGS",
                    {
                        "display_name": "循环参数",
                        "tooltip": "可选循环视频参数。",
                    },
                ),
                "experimental_args": (
                    "EXPERIMENTALARGS",
                    {
                        "display_name": "实验参数",
                        "tooltip": "可选 WanVideoWrapper 实验参数。",
                    },
                ),
                "sigmas": (
                    "SIGMAS",
                    {
                        "display_name": "Sigmas",
                        "tooltip": "可选自定义 sigmas；连接后会改变采样时间步。",
                    },
                ),
                "unianimate_poses": (
                    "UNIANIMATE_POSE",
                    {
                        "display_name": "UniAnimate 姿态",
                        "tooltip": "可选 UniAnimate 姿态控制。",
                    },
                ),
                "fantasytalking_embeds": (
                    "FANTASYTALKING_EMBEDS",
                    {
                        "display_name": "FantasyTalking 条件",
                        "tooltip": "可选 FantasyTalking 条件。",
                    },
                ),
                "uni3c_embeds": (
                    "UNI3C_EMBEDS",
                    {
                        "display_name": "Uni3C 条件",
                        "tooltip": "可选 Uni3C 条件。",
                    },
                ),
                "multitalk_embeds": (
                    "MULTITALK_EMBEDS",
                    {
                        "display_name": "MultiTalk 条件",
                        "tooltip": "可选 MultiTalk/InfiniteTalk 音频条件。",
                    },
                ),
                "freeinit_args": (
                    "FREEINITARGS",
                    {
                        "display_name": "FreeInit 参数",
                        "tooltip": "可选 FreeInit 参数；连接后会改变初始噪声和迭代采样。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("WANVIDSAMPLEREXTRAARGS",)
    RETURN_NAMES = ("扩展参数",)
    OUTPUT_TOOLTIPS = ("WanVideo Sampler v2 的可选扩展参数包。",)
    FUNCTION = "process"
    CATEGORY = "GJJ/视频模型/WanVideo"
    DESCRIPTION = "GJJ WanVideo Sampler v2 扩展参数：把高级输入打包后连接到采样器。"

    def process(self, **kwargs):
        return kwargs,


class GJJ_WanVideoSamplerV2:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (
                    "WANVIDEOMODEL",
                    {
                        "display_name": "WanVideo 模型",
                        "tooltip": "由 GJJ WanVideo 模型加载器输出的模型。",
                    },
                ),
                "image_embeds": (
                    "WANVIDIMAGE_EMBEDS",
                    {
                        "display_name": "图像条件",
                        "tooltip": "WanVideo 图像/空 latent 条件，例如 VACE、I2V 或空条件编码输出。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 6,
                        "min": 1,
                        "step": 1,
                        "display_name": "采样步数",
                        "tooltip": "采样总步数。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 30.0,
                        "step": 0.01,
                        "display_name": "CFG",
                        "tooltip": "提示词引导强度。",
                    },
                ),
                "shift": (
                    "FLOAT",
                    {
                        "default": 8.0,
                        "min": 0.0,
                        "max": 1000.0,
                        "step": 0.01,
                        "display_name": "Shift",
                        "tooltip": "WanVideo flow shift 参数。Wan2.2 常见工作流会使用 8.0。",
                    },
                ),
                "force_offload": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "采样后卸载",
                        "tooltip": "采样后把模型移回卸载设备，减少显存占用。",
                    },
                ),
                "scheduler": (
                    _scheduler_choices(),
                    {
                        "default": _scheduler_default("dpm++_sde"),
                        "display_name": "调度器",
                        "tooltip": "采样调度器，直接在节点面板选择。",
                    },
                ),
                "riflex_freq_index": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 1000,
                        "step": 1,
                        "display_name": "RIFLEX 频率索引",
                        "tooltip": "0 表示关闭；用于减少续帧循环感。",
                    },
                ),
            },
            "optional": {
                "text_embeds": (
                    "WANVIDEOTEXTEMBEDS",
                    {
                        "display_name": "文本条件",
                        "tooltip": "可选 WanVideo 文本编码输出；不连接时使用空文本条件。",
                    },
                ),
                "samples": (
                    "LATENT",
                    {
                        "display_name": "初始 latent",
                        "tooltip": "视频转视频或续采样时使用的初始 latent。",
                    },
                ),
                "denoise_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪强度",
                        "tooltip": "视频转视频或续采样时的降噪强度。",
                    },
                ),
                "feta_args": (
                    "FETAARGS",
                    {
                        "display_name": "FETA 参数",
                        "tooltip": "对齐原版 WanVideo Sampler 的可选 FETA 增强参数。",
                    },
                ),
                "context_options": (
                    "WANVIDCONTEXT",
                    {
                        "display_name": "上下文窗口",
                        "tooltip": "对齐原版 WanVideo Sampler 的长视频上下文窗口参数。",
                    },
                ),
                "cache_args": (
                    "CACHEARGS",
                    {
                        "display_name": "缓存参数",
                        "tooltip": "对齐原版 WanVideo Sampler 的 TeaCache/MagCache/EasyCache 参数。",
                    },
                ),
                "teacache_args": (
                    "CACHEARGS",
                    {
                        "display_name": "TeaCache 兼容参数",
                        "tooltip": "对齐原版 process 的旧版兼容入口；连接后会覆盖缓存参数。",
                    },
                ),
                "flowedit_args": (
                    "FLOWEDITARGS",
                    {
                        "display_name": "FlowEdit 参数",
                        "tooltip": "原版保留的旧接口；当前 WanVideoWrapper runtime 已废弃，连接后会按原版逻辑报错。",
                    },
                ),
                "batched_cfg": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "批量 CFG",
                        "tooltip": "将正负条件合批运行，可能更快但会占用更多显存。",
                    },
                ),
                "slg_args": (
                    "SLGARGS",
                    {
                        "display_name": "SLG 参数",
                        "tooltip": "对齐原版 WanVideo Sampler 的 Skip Layer Guidance 参数。",
                    },
                ),
                "rope_function": (
                    _rope_choices(),
                    {
                        "default": "comfy",
                        "display_name": "RoPE 函数",
                        "tooltip": "comfy 通常更快；comfy_chunked 峰值显存更低；特殊模型可用 default。",
                    },
                ),
                "loop_args": (
                    "LOOPARGS",
                    {
                        "display_name": "循环参数",
                        "tooltip": "对齐原版 WanVideo Sampler 的循环视频参数。",
                    },
                ),
                "experimental_args": (
                    "EXPERIMENTALARGS",
                    {
                        "display_name": "实验参数",
                        "tooltip": "对齐原版 WanVideo Sampler 的实验参数。",
                    },
                ),
                "sigmas": (
                    "SIGMAS",
                    {
                        "display_name": "Sigmas",
                        "tooltip": "对齐原版 WanVideo Sampler 的自定义 sigmas 输入；连接后会改变采样时间步。",
                    },
                ),
                "unianimate_poses": (
                    "UNIANIMATE_POSE",
                    {
                        "display_name": "UniAnimate 姿态",
                        "tooltip": "对齐原版 WanVideo Sampler 的 UniAnimate 姿态控制。",
                    },
                ),
                "fantasytalking_embeds": (
                    "FANTASYTALKING_EMBEDS",
                    {
                        "display_name": "FantasyTalking 条件",
                        "tooltip": "对齐原版 WanVideo Sampler 的 FantasyTalking 条件。",
                    },
                ),
                "uni3c_embeds": (
                    "UNI3C_EMBEDS",
                    {
                        "display_name": "Uni3C 条件",
                        "tooltip": "对齐原版 WanVideo Sampler 的 Uni3C 条件。",
                    },
                ),
                "multitalk_embeds": (
                    "MULTITALK_EMBEDS",
                    {
                        "display_name": "MultiTalk 条件",
                        "tooltip": "对齐原版 WanVideo Sampler 的 MultiTalk/InfiniteTalk 音频条件。",
                    },
                ),
                "freeinit_args": (
                    "FREEINITARGS",
                    {
                        "display_name": "FreeInit 参数",
                        "tooltip": "对齐原版 WanVideo Sampler 的 FreeInit 参数；连接后会改变初始噪声和迭代采样。",
                    },
                ),
                "start_step": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 10000,
                        "step": 1,
                        "display_name": "起始步",
                        "tooltip": "从指定步开始采样；0 表示完整采样。",
                    },
                ),
                "end_step": (
                    "INT",
                    {
                        "default": -1,
                        "min": -1,
                        "max": 10000,
                        "step": 1,
                        "display_name": "结束步",
                        "tooltip": "-1 表示完整采样；其它值表示采样到指定步结束。",
                    },
                ),
                "add_noise_to_samples": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "给 latent 加噪",
                        "tooltip": "视频转视频从干净 latent 开始时可启用。",
                    },
                ),
                "extra_args": (
                    "WANVIDSAMPLEREXTRAARGS",
                    {
                        "display_name": "扩展参数",
                        "tooltip": "连接 GJJ WanVideo 采样扩展参数；连接后会覆盖同名面板参数。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xffffffffffffffff,
                        "display_name": "种子",
                        "tooltip": "随机种子。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("LATENT", "LATENT")
    RETURN_NAMES = ("采样 latent", "去噪 latent")
    OUTPUT_TOOLTIPS = ("采样结果 latent。", "去噪后的 latent，供预览或调试使用。")
    FUNCTION = "process"
    CATEGORY = "GJJ/视频模型/WanVideo"
    DESCRIPTION = _DESCRIPTION
    GJJ_HELP = _GJJ_HELP

    def process(
        self,
        model,
        image_embeds,
        steps,
        cfg,
        shift,
        force_offload,
        scheduler,
        riflex_freq_index,
        text_embeds=None,
        samples=None,
        denoise_strength=1.0,
        feta_args=None,
        context_options=None,
        cache_args=None,
        teacache_args=None,
        flowedit_args=None,
        batched_cfg=False,
        slg_args=None,
        rope_function="comfy",
        loop_args=None,
        experimental_args=None,
        sigmas=None,
        unianimate_poses=None,
        fantasytalking_embeds=None,
        uni3c_embeds=None,
        multitalk_embeds=None,
        freeinit_args=None,
        start_step=0,
        end_step=-1,
        add_noise_to_samples=False,
        extra_args=None,
        seed=0,
    ):
        args = {
            "model": model,
            "image_embeds": image_embeds,
            "steps": steps,
            "cfg": cfg,
            "shift": shift,
            "seed": seed,
            "force_offload": force_offload,
            "scheduler": scheduler,
            "riflex_freq_index": riflex_freq_index,
            "text_embeds": text_embeds,
            "samples": samples,
            "feta_args": feta_args,
            "denoise_strength": denoise_strength,
            "context_options": context_options,
            "cache_args": cache_args,
            "teacache_args": teacache_args,
            "flowedit_args": flowedit_args,
            "batched_cfg": batched_cfg,
            "slg_args": slg_args,
            "rope_function": rope_function,
            "loop_args": loop_args,
            "experimental_args": experimental_args,
            "sigmas": sigmas,
            "unianimate_poses": unianimate_poses,
            "fantasytalking_embeds": fantasytalking_embeds,
            "uni3c_embeds": uni3c_embeds,
            "multitalk_embeds": multitalk_embeds,
            "freeinit_args": freeinit_args,
            "start_step": start_step,
            "end_step": end_step,
            "add_noise_to_samples": add_noise_to_samples,
        }
        _merge_extra_args(args, extra_args)

        scheduler_choices = _scheduler_choices()
        rope_choices = _rope_choices()
        if not isinstance(args["scheduler"], dict):
            args["scheduler"] = _as_choice(
                args["scheduler"],
                scheduler_choices,
                _scheduler_default("dpm++_sde"),
            )
        args["rope_function"] = _as_choice(
            args["rope_function"],
            rope_choices,
            "comfy" if "comfy" in rope_choices else (rope_choices[0] if rope_choices else "default"),
        )
        args["steps"] = _as_int(args["steps"], 6, min_value=1)
        args["cfg"] = _as_float(args["cfg"], 1.0, min_value=0.0, max_value=30.0)
        args["shift"] = _as_float(args["shift"], 8.0, min_value=0.0, max_value=1000.0)
        args["seed"] = _as_int(args["seed"], 0, min_value=0, max_value=0xffffffffffffffff)
        args["force_offload"] = _as_bool(args["force_offload"], True)
        args["riflex_freq_index"] = _as_int(args["riflex_freq_index"], 0, min_value=0, max_value=1000)
        args["denoise_strength"] = _as_float(args["denoise_strength"], 1.0, min_value=0.0, max_value=1.0)
        args["batched_cfg"] = _as_bool(args["batched_cfg"], False)
        args["start_step"] = _as_int(args["start_step"], 0, min_value=0, max_value=10000)
        args["end_step"] = _as_int(args["end_step"], -1, min_value=-1, max_value=10000)
        args["add_noise_to_samples"] = _as_bool(args["add_noise_to_samples"], False)

        node = _source_wanvideo_sampler_if_loaded(model)
        if node is None:
            runtime = _load_sampler_runtime()
            node = runtime.WanVideoSampler()
        
        # 尝试执行,如果因 Triton 编译失败则自动降级
        import platform
        system = platform.system()
        max_retries = 2 if system == "Windows" else 1  # Windows 允许重试一次
        
        for attempt in range(max_retries):
            try:
                return node.process(**args)
            except Exception as e:
                error_str = str(e).lower()
                
                # 检测 Triton 编译失败错误（包括 InductorError 包装的情况）
                # 支持多种错误格式:
                # 1. torch._inductor.exc.TritonMissing
                # 2. torch._inductor.exc.InductorError (包装 CalledProcessError)
                # 3. subprocess.CalledProcessError (直接抛出)
                is_triton_compile_error = (
                    system == "Windows" and 
                    attempt == 0 and
                    (
                        # 原始 Triton 错误
                        ("triton" in error_str and ("not installed" in error_str or "too old" in error_str or "cannot find" in error_str)) or
                        # TCC 编译失败 (可能被 InductorError 包装)
                        ("tcc.exe" in error_str and "returned non-zero exit status" in error_str) or
                        # InductorError 包含编译相关错误
                        ("inductorerror" in error_str and ("compile" in error_str or "tcc" in error_str or "cuda_utils" in error_str))
                    )
                )
                
                if is_triton_compile_error:
                    # 首次遇到编译失败,尝试禁用 torch.compile 后重试
                    print(f"\n{'='*80}")
                    print(f"⚠️ 检测到 Triton 编译失败，尝试自动降级运行...")
                    print(f"{'='*80}\n")
                    
                    # 临时禁用 torch.compile
                    import os
                    original_torch_compile = os.environ.get("TORCH_COMPILE", "")
                    os.environ["TORCH_COMPILE"] = "0"
                    
                    # 清除 PyTorch 编译缓存
                    try:
                        import torch._dynamo as dynamo
                        dynamo.reset()
                    except Exception:
                        pass

                    runtime_compile_disabled = _disable_model_compile_runtime(args["model"])
                    if runtime_compile_disabled:
                        print("🔧 已从当前模型移除 compile_args，并解包已包装的编译模块。")
                    
                    print(f"🔄 已禁用 torch.compile，正在重新执行...\n")
                    
                    # 重新加载节点以应用新配置
                    if hasattr(node, '__class__'):
                        node = node.__class__()
                    
                    continue  # 重试
                
                # 非编译错误或已达到最大重试次数,按原逻辑处理
                # 检测 Triton 缺失错误
                if "triton" in error_str and ("not installed" in error_str or "too old" in error_str or "cannot find" in error_str):
                    if system == "Windows":
                        # Windows 使用 triton-windows 包
                        print_runtime_dependency_error(
                            node_name=NODE_DISPLAY_NAME,
                            dependency_name="triton-windows",
                            description=str(e),
                            unique_id=None,
                        )
                        raise RuntimeError(
                            f"GJJ WanVideo Sampler v2 运行时组件缺失：缺少 triton-windows（PyTorch 编译加速库）\n"
                            f"错误详情: {e}\n"
                            f"解决方案: pip install triton-windows -i https://pypi.tuna.tsinghua.edu.cn/simple"
                        ) from e
                    else:
                        # Linux/macOS 使用标准 triton 包
                        print_runtime_dependency_error(
                            node_name=NODE_DISPLAY_NAME,
                            dependency_name="triton",
                            description=str(e),
                            unique_id=None,
                        )
                        raise RuntimeError(
                            f"GJJ WanVideo Sampler v2 运行时组件缺失：缺少 triton（PyTorch 编译加速库）\n"
                            f"错误详情: {e}\n"
                            f"解决方案: pip install triton -i https://pypi.tuna.tsinghua.edu.cn/simple"
                        ) from e
                
                # 检测真正的 CUDA/cuDNN 缺失错误（非编译错误）
                elif ("cuda" in error_str or "cudnn" in error_str) and ("tcc.exe" not in error_str and "compile" not in error_str and "inductorerror" not in error_str):
                    print_runtime_dependency_error(
                        node_name=NODE_DISPLAY_NAME,
                        dependency_name="CUDA/cuDNN",
                        description=str(e),
                        unique_id=None,
                    )
                    raise RuntimeError(
                        f"GJJ WanVideo Sampler v2 运行时环境配置问题：CUDA/cuDNN 不可用\n"
                        f"错误详情: {e}\n"
                        f"解决方案: 请检查 NVIDIA 驱动和 CUDA Toolkit 是否正确安装"
                    ) from e
                
                # 其他未知错误，直接抛出
                else:
                    raise

NODE_CLASS_MAPPINGS = {
    "GJJ_WanVideoSchedulerV2": GJJ_WanVideoSchedulerV2,
    "GJJ_WanVideoSamplerV2ExtraArgs": GJJ_WanVideoSamplerV2ExtraArgs,
    "GJJ_WanVideoSamplerV2": GJJ_WanVideoSamplerV2,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WanVideoSchedulerV2": "GJJ · 🗓️ WanVideo 调度器 v2",
    "GJJ_WanVideoSamplerV2ExtraArgs": "GJJ · 🧰 WanVideo 采样扩展参数",
    "GJJ_WanVideoSamplerV2": "GJJ · 🎞️ WanVideo 视频采样器 v2",
}
