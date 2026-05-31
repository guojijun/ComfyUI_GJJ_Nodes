from __future__ import annotations

import gc
import inspect
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
        "gguf：仅使用 GGUF 量化模型时才需要；普通 safetensors/fp16 模型不需要。",
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


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if unique_id is None:
        return
    try:
        from server import PromptServer

        payload = {"node": str(unique_id), "text": str(text)}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


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
            dependency_name="accelerate einops diffusers ftfy",
            description=str(error),
        )
        raise RuntimeError(
            "GJJ 内置 WanVideo 采样 runtime 加载失败。\n"
            f"错误信息: {error}\n"
            "说明: 本节点不依赖 ComfyUI-WanVideoWrapper 插件本体；如果缺少 accelerate、einops、diffusers、ftfy 等 pip 库，请按 GJJ SKILL 的运行时依赖方案安装。"
        ) from error
    return sampler_runtime


def _model_input_type_label(model):
    outer_name = type(model).__name__
    try:
        inner = getattr(model, "model", None)
    except Exception:
        inner = None
    inner_name = type(inner).__name__ if inner is not None else ""
    if inner_name and inner_name != outer_name:
        return f"{outer_name}/{inner_name}"
    return outer_name


def _has_wanvideo_wrapper_metadata(model):
    try:
        inner = getattr(model, "model", None)
        if inner is None:
            return False
        for key in ("base_dtype", "weight_dtype", "fp8_matmul", "gguf_reader", "control_lora"):
            inner[key]
        transformer_options = getattr(model, "model_options", {}).get("transformer_options", None)
        return isinstance(transformer_options, dict)
    except Exception:
        return False


def _is_native_wan_model(model):
    try:
        inner = getattr(model, "model", None)
        transformer = getattr(inner, "diffusion_model", None)
        module_name = str(getattr(transformer.__class__, "__module__", "") or "")
        inner_name = type(inner).__name__
        return module_name.startswith("comfy.ldm.wan") or inner_name.startswith("WAN21") or inner_name.startswith("WAN22")
    except Exception:
        return False

def _validate_wanvideo_model_input(model):
    if _has_wanvideo_wrapper_metadata(model):
        return
    received = _model_input_type_label(model)
    raise RuntimeError(
        "GJJ WanVideo 视频采样器 v2 使用的是 WanVideoWrapper 包装格式，模型输入必须是 WANVIDEOMODEL。\n"
        f"当前收到的是 {received}，看起来是 ComfyUI 原生 MODEL/WAN 模型，不能走这个采样器。\n"
        "原生 MODEL 请改用「GJJ · 🎞️ Wan原生视频采样器」；"
        "WanVideoWrapper 流程请改接「GJJ · 🎬 WanVideo 模型加载器」输出的 WANVIDEOMODEL。"
    )


def _wanvideo_transformer_details(model):
    try:
        inner = getattr(model, "model", None)
        transformer = getattr(inner, "diffusion_model", None)
        return {
            "in_dim": getattr(transformer, "in_dim", None),
            "control_adapter": getattr(transformer, "control_adapter", None),
            "control_lora": bool(inner["control_lora"]) if inner is not None else False,
            "class_name": type(transformer).__name__ if transformer is not None else "未知模型",
        }
    except Exception:
        return {
            "in_dim": None,
            "control_adapter": None,
            "control_lora": False,
            "class_name": "未知模型",
        }


def _validate_fun_control_input(model, image_embeds):
    if not isinstance(image_embeds, dict):
        return
    control_embeds = image_embeds.get("control_embeds", None)
    if control_embeds is None:
        return

    details = _wanvideo_transformer_details(model)
    in_dim = details["in_dim"]
    control_lora = details["control_lora"]
    is_i2v_embeds = image_embeds.get("image_embeds", None) is not None
    fun_control_dims = {148, 52, 48, 36, 32}

    if is_i2v_embeds or not control_lora:
        if in_dim not in fun_control_dims:
            raise RuntimeError(
                "WanVideo 控制条件与当前模型不匹配。\n"
                "当前图像条件里带有 control_embeds（控制信号），但采样模型不是 Fun-Control / Fun-Camera / 对应控制结构。\n"
                f"检测到模型结构：{details['class_name']}，in_dim={in_dim}，control_lora={control_lora}。\n"
                "处理方式：如果你只是普通 T2V/I2V/首尾帧生成，请断开「控制条件 / control_embeds / WanVideo Control Embeds / Add Control Embeds」这一路；"
                "如果确实要用姿态、深度、轨迹或控制视频，请换成 Wan Fun-Control 模型，或加载匹配的 Wan Control LoRA。"
            )

    if isinstance(control_embeds, dict) and control_embeds.get("control_camera_latents", None) is not None:
        if details["control_adapter"] is None:
            raise RuntimeError(
                "WanVideo 相机控制条件与当前模型不匹配。\n"
                "当前连接了 control_camera_latents，但模型没有 Fun-Control-Camera 的 control_adapter。\n"
                "请换用 Fun-Camera 模型，或断开相机控制条件。"
            )


def _tensor_shape(value: Any) -> tuple[int, ...] | None:
    shape = getattr(value, "shape", None)
    if shape is None:
        return None
    try:
        return tuple(int(item) for item in shape)
    except Exception:
        return None


def _latent_spatial_shape(shape: tuple[int, ...] | None) -> tuple[int, int] | None:
    if shape is None or len(shape) < 2:
        return None
    try:
        return int(shape[-2]), int(shape[-1])
    except Exception:
        return None


def _iter_extra_latent_entries(extra_latents: Any):
    if extra_latents is None:
        return []
    if isinstance(extra_latents, list):
        return extra_latents
    if isinstance(extra_latents, tuple):
        return list(extra_latents)
    return [extra_latents]


def _validate_image_embed_latent_shapes(image_embeds: Any) -> None:
    if not isinstance(image_embeds, dict):
        return
    target_shape = image_embeds.get("target_shape", None)
    if not isinstance(target_shape, (list, tuple)) or len(target_shape) < 4:
        return
    try:
        target_latent_h = int(target_shape[-2])
        target_latent_w = int(target_shape[-1])
    except Exception:
        return
    if target_latent_h <= 0 or target_latent_w <= 0:
        return

    expected = (target_latent_h, target_latent_w)
    extra_latents = image_embeds.get("extra_latents", None)
    for index, entry in enumerate(_iter_extra_latent_entries(extra_latents), start=1):
        if not isinstance(entry, dict):
            continue
        samples = entry.get("samples", None)
        actual = _latent_spatial_shape(_tensor_shape(samples))
        if actual is None or actual == expected:
            continue
        target_pixels = f"{target_latent_w * 8}x{target_latent_h * 8}"
        actual_pixels = f"{actual[1] * 8}x{actual[0] * 8}"
        raise RuntimeError(
            "WanVideo 额外 latent 尺寸与当前采样目标不一致。\n"
            f"当前图像条件目标 latent 尺寸为 {target_latent_w}x{target_latent_h}（约 {target_pixels} 像素），"
            f"但第 {index} 个额外 latent 尺寸为 {actual[1]}x{actual[0]}（约 {actual_pixels} 像素）。\n"
            "这通常是把上一段 1024x1024 等不同分辨率的 latent 接到了当前 640x608 等目标尺寸的采样器。\n"
            "处理方式：请让生成条件节点的宽度/高度与额外 latent 的来源保持一致，或先用同一分辨率重新编码/重新生成额外 latent；"
            "不要把不同分辨率的 LATENT 直接作为 extra_latents 接入。"
        )


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


def _force_sdpa_attention_runtime(patcher):
    """将当前 WanVideoWrapper 模型里的 Sage/Flash 注意力临时降级为 PyTorch SDPA。"""
    try:
        model = getattr(patcher, "model", None)
        if model is None:
            return False

        transformer = getattr(model, "diffusion_model", None)
        if transformer is None:
            return False

        changed = False

        def set_if_present(obj, attr_name):
            nonlocal changed
            try:
                value = getattr(obj, attr_name, None)
            except Exception:
                return
            if isinstance(value, str) and value != "sdpa":
                try:
                    setattr(obj, attr_name, "sdpa")
                    changed = True
                except Exception:
                    pass

        set_if_present(transformer, "attention_mode")
        set_if_present(transformer, "dense_attention_mode")

        try:
            modules = transformer.modules()
        except Exception:
            modules = []
        for module in modules:
            set_if_present(module, "attention_mode")
            set_if_present(module, "dense_attention_mode")

        try:
            transformer_options = patcher.model_options.setdefault("transformer_options", {})
            attention_override = transformer_options.get("attention_mode_override")
            if isinstance(attention_override, dict) and attention_override.get("mode") != "sdpa":
                attention_override["mode"] = "sdpa"
                changed = True
            if transformer_options.get("dense_attention_mode") != "sdpa":
                transformer_options["dense_attention_mode"] = "sdpa"
                changed = True
        except Exception:
            pass

        return changed
    except Exception:
        return False


def _looks_like_triton_attention_compile_error(error_text: str) -> bool:
    text = error_text.lower()
    if not any(token in text for token in ("triton", "sageatt", "tcc.exe", "cuda_utils", "quant_per_block")):
        return False
    return any(
        token in text
        for token in (
            "returned non-zero exit status",
            "compile_module_from_src",
            "compile",
            "cuda_utils",
            "quant_per_block",
            "active_drivers",
            "get_current_device",
        )
    )


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


def _is_conditioning(value: Any) -> bool:
    if not isinstance(value, (list, tuple)) or not value:
        return False
    first = value[0]
    return isinstance(first, (list, tuple)) and len(first) >= 1 and hasattr(first[0], "shape")


def _conditioning_tensor(conditioning: Any):
    if not _is_conditioning(conditioning):
        raise RuntimeError("文本条件转换失败：输入不是有效的 CONDITIONING 结构。")
    tensor = conditioning[0][0]
    try:
        import comfy.model_management as mm

        return tensor.to(mm.get_torch_device()) if hasattr(tensor, "to") else tensor
    except Exception:
        return tensor


def _normalize_text_embeds_input(text_embeds: Any) -> Any:
    if text_embeds is None:
        return None
    if isinstance(text_embeds, dict):
        if "prompt_embeds" in text_embeds:
            return text_embeds
        raise RuntimeError("文本条件转换失败：字典输入缺少 prompt_embeds 字段。")
    if _is_conditioning(text_embeds):
        return {
            "prompt_embeds": _conditioning_tensor(text_embeds),
            "negative_prompt_embeds": None,
        }
    raise RuntimeError(
        "文本条件类型不兼容：请连接 WANVIDEOTEXTEMBEDS，或连接 CLIP 编码节点输出的 CONDITIONING。"
    )


def _merge_extra_args(args: dict[str, Any], extra_args: Any) -> None:
    if extra_args is None:
        return
    if not isinstance(extra_args, dict):
        raise TypeError("WanVideo 采样扩展参数必须是字典类型，请连接 GJJ · 🧰 WanVideo 采样扩展参数。")
    for key, value in extra_args.items():
        if value is not None:
            args[key] = value


def _cleanup_after_sampler(model: Any, force_offload: bool) -> None:
    """采样段之间主动释放临时显存，避免双模型工作流连续运行时显存逐轮抬高。"""
    try:
        import torch
        import comfy.model_management as mm

        if force_offload:
            offload_device = mm.unet_offload_device()
            candidates = [
                model,
                getattr(model, "model", None),
                getattr(getattr(model, "model", None), "diffusion_model", None),
            ]
            seen = set()
            for item in candidates:
                if item is None:
                    continue
                key = id(item)
                if key in seen:
                    continue
                seen.add(key)
                try:
                    if hasattr(item, "to"):
                        item.to(offload_device)
                except Exception:
                    pass

        gc.collect()
        try:
            mm.soft_empty_cache()
        except TypeError:
            mm.soft_empty_cache(force=True)
        except Exception:
            pass
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass
    except Exception:
        pass


def _normalize_sigmas_preview(value: Any) -> list[float]:
    if value is None:
        return []
    try:
        import torch

        if isinstance(value, torch.Tensor):
            value = value.detach().cpu().flatten().tolist()
    except Exception:
        pass
    if not isinstance(value, (list, tuple)):
        try:
            value = list(value)
        except Exception:
            return []
    sigmas: list[float] = []
    for item in value:
        try:
            sigmas.append(float(item))
        except Exception:
            continue
    if len(sigmas) >= 2 and abs(sigmas[-1]) > 1e-6:
        sigmas.append(0.0)
    return sigmas


def _scheduler_result_sigmas_preview(result: Any) -> list[float]:
    scheduler_dict = None
    if isinstance(result, tuple) and result:
        scheduler_dict = result[0]
    elif isinstance(result, dict):
        scheduler_dict = result.get("sample_scheduler") or result
    if not isinstance(scheduler_dict, dict):
        return []
    sample_scheduler = scheduler_dict.get("sample_scheduler")
    for attr in ("full_sigmas", "sigmas"):
        sigmas = _normalize_sigmas_preview(getattr(sample_scheduler, attr, None))
        if len(sigmas) >= 2:
            return sigmas
    return []


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

    RETURN_TYPES = ("WANVIDEOSCHEDULER", "SIGMAS", "INT", "FLOAT", _scheduler_choices(), "INT", "INT")
    RETURN_NAMES = ("调度器", "Sigmas", "步数", "Shift", "调度器名称", "起始步", "结束步")
    OUTPUT_TOOLTIPS = (
        "WanVideo Sampler v2 使用的调度器配置。",
        "与原版 WanVideoScheduler 第 1 个输出对齐的 SIGMAS；未连接自定义 sigmas 时通常为空。",
        "与原版 WanVideoScheduler 第 2 个输出对齐的采样步数。",
        "与原版 WanVideoScheduler 第 3 个输出对齐的 Shift 参数。",
        "与原版 WanVideoScheduler 第 4 个输出对齐的 COMBO 调度器名称，可接需要 COMBO 调度器的输入口。",
        "与原版 WanVideoScheduler 第 5 个输出对齐的起始步。",
        "与原版 WanVideoScheduler 第 6 个输出对齐的结束步。",
    )
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
        node = runtime.WanVideoScheduler()
        sigmas_out, steps_out, shift_out, scheduler_dict, start_step_out, end_step_out = node.process(
            scheduler=scheduler,
            steps=_as_int(steps, 30, min_value=1),
            shift=_as_float(shift, 5.0, min_value=0.0, max_value=1000.0),
            start_step=_as_int(start_step, 0, min_value=0),
            end_step=_as_int(end_step, -1, min_value=-1),
            # GJJ 前端已经根据 ui.sigmas 绘制预览；不传 unique_id 避免原版 matplotlib 预览重复显示。
            unique_id=None,
            sigmas=sigmas,
            enhance_hf=_as_bool(enhance_hf, False),
        )
        result = (
            scheduler_dict,
            sigmas_out,
            steps_out,
            shift_out,
            str(scheduler),
            start_step_out,
            end_step_out,
        )
        preview_sigmas = _scheduler_result_sigmas_preview(result)
        if len(preview_sigmas) >= 2:
            return {"ui": {"sigmas": [preview_sigmas]}, "result": result}
        return result


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
                        "default": 8,
                        "min": 1,
                        "step": 1,
                        "display_name": "采样步数",
                        "tooltip": "采样总步数。LongCat Avatar 1.5 成功工作流使用 8 步。",
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
                        "default": 12.0,
                        "min": 0.0,
                        "max": 1000.0,
                        "step": 0.01,
                        "display_name": "Shift",
                        "tooltip": "WanVideo flow shift 参数。LongCat Avatar 1.5 成功工作流使用 12.0。",
                    },
                ),
                "force_offload": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "采样后卸载",
                        "tooltip": "采样后把模型移回卸载设备，减少显存占用。",
                    },
                ),
                "scheduler": (
                    _scheduler_choices(),
                    {
                        "default": _scheduler_default("longcat_distill_euler"),
                        "display_name": "调度器",
                        "tooltip": "采样调度器。LongCat Avatar 1.5 成功工作流使用 longcat_distill_euler。",
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
                    "WANVIDEOTEXTEMBEDS,CONDITIONING",
                    {
                        "display_name": "文本条件",
                        "tooltip": "可选 WanVideo 文本编码输出；也可直接连接 CONDITIONING，节点内部会包装为 WANVIDEOTEXTEMBEDS 格式。",
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
            "hidden": {
                "unique_id": "UNIQUE_ID",
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
        unique_id=None,
    ):
        _send_status(unique_id, "校验输入...", 0.04)
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
        args["text_embeds"] = _normalize_text_embeds_input(args.get("text_embeds"))

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

        _validate_wanvideo_model_input(args["model"])
        _validate_fun_control_input(args["model"], args["image_embeds"])
        _validate_image_embed_latent_shapes(args["image_embeds"])

        _send_status(unique_id, "准备调度器...", 0.10)
        if isinstance(args["scheduler"], dict):
            scheduler_name = str(args["scheduler"].get("scheduler", "自定义调度器"))
        else:
            scheduler_name = str(args["scheduler"])

        _send_status(unique_id, f"加载采样 runtime... ({scheduler_name}, {args['steps']} 步)", 0.16)
        runtime = _load_sampler_runtime()
        node = runtime.WanVideoSampler()
        
        # 尝试执行,如果因 Triton 编译失败则自动降级
        import platform
        system = platform.system()
        max_retries = 2 if system == "Windows" else 1  # Windows 允许重试一次
        
        for attempt in range(max_retries):
            try:
                _send_status(unique_id, "进入采样循环...", 0.22)
                result = node.process(**args)
                _cleanup_after_sampler(args["model"], args["force_offload"])
                return result
            except Exception as e:
                _cleanup_after_sampler(args["model"], args["force_offload"])
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
                        ("inductorerror" in error_str and ("compile" in error_str or "tcc" in error_str or "cuda_utils" in error_str)) or
                        # SageAttention 调用 Triton/TCC 编译失败
                        _looks_like_triton_attention_compile_error(error_str)
                    )
                )
                
                if is_triton_compile_error:
                    # 首次遇到编译失败,禁用 torch.compile 并将 Sage/Flash 注意力降级到 SDPA 后重试
                    print(f"\n{'='*80}")
                    print(f"⚠️ 检测到 Triton/SageAttention 编译失败，尝试自动降级运行...")
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

                    attention_downgraded = _force_sdpa_attention_runtime(args["model"])
                    if attention_downgraded:
                        print("🔧 已将当前 WanVideo 模型注意力模式临时切换为 sdpa。")
                    
                    print(f"🔄 已禁用 torch.compile / SageAttention，正在重新执行...\n")
                    
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
                    if "control signal only works with fun-control model" in error_str:
                        raise RuntimeError(
                            "WanVideo 控制条件与当前模型不匹配。\n"
                            "采样器收到了 control_embeds，但当前 Wan 模型不是 Fun-Control 类型。\n"
                            "普通 T2V/I2V/首尾帧生成请断开「控制条件 / control_embeds / WanVideo Control Embeds / Add Control Embeds」；"
                            "需要控制视频时请换用 Wan Fun-Control 模型或匹配的 Control LoRA。"
                        ) from e
                    raise



class GJJ_WanVideoSamplerSettings(GJJ_WanVideoSamplerV2):
    DESCRIPTION = "GJJ WanVideo 采样参数：按 WanVideoSamplerSettings 复刻，只打包采样器输入为 SAMPLER_ARGS，不执行采样。"
    RETURN_TYPES = ("SAMPLER_ARGS",)
    RETURN_NAMES = ("sampler_inputs",)
    OUTPUT_TOOLTIPS = ("与原版 WanVideoSamplerSettings 对齐的采样器参数字典，可连接到接受 SAMPLER_ARGS 的采样节点。",)
    FUNCTION = "process"
    CATEGORY = "GJJ/视频模型/WanVideo"
    GJJ_HELP = {
        "title": "WanVideo 采样参数",
        "description": "复刻原版 WanVideoSamplerSettings：保留采样器完整输入面板，只把当前输入打包为 SAMPLER_ARGS，不加载模型、不执行采样。",
        "usage": [
            "用于把复杂采样器参数整理到单独节点中，再交给支持 SAMPLER_ARGS 的采样节点。",
            "输出内容保持原版键名，例如 model、image_embeds、steps、cfg、scheduler、sigmas 等。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        try:
            data = _load_sampler_runtime().WanVideoSampler.INPUT_TYPES()
        except Exception:
            data = cls._fallback_original_input_types()
        return cls._localized_copy(data)

    @staticmethod
    def _fallback_original_input_types():
        return {
            "required": {
                "model": ("WANVIDEOMODEL",),
                "image_embeds": ("WANVIDIMAGE_EMBEDS",),
                "steps": ("INT", {"default": 30, "min": 1}),
                "cfg": ("FLOAT", {"default": 6.0, "min": 0.0, "max": 30.0, "step": 0.01}),
                "shift": ("FLOAT", {"default": 5.0, "min": 0.0, "max": 1000.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "force_offload": ("BOOLEAN", {"default": True, "tooltip": "Moves the model to the offload device after sampling"}),
                "scheduler": (WANVIDEO_SAMPLER_SCHEDULER_CHOICES, {"default": "unipc"}),
                "riflex_freq_index": ("INT", {"default": 0, "min": 0, "max": 1000, "step": 1, "tooltip": "Frequency index for RIFLEX, disabled when 0, default 6. Allows for new frames to be generated after without looping"}),
            },
            "optional": {
                "text_embeds": ("WANVIDEOTEXTEMBEDS",),
                "samples": ("LATENT", {"tooltip": "init Latents to use for video2video process"}),
                "denoise_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "feta_args": ("FETAARGS",),
                "context_options": ("WANVIDCONTEXT",),
                "cache_args": ("CACHEARGS",),
                "flowedit_args": ("FLOWEDITARGS", {"tooltip": "FlowEdit support has been deprecated"}),
                "batched_cfg": ("BOOLEAN", {"default": False, "tooltip": "Batch cond and uncond for faster sampling, possibly faster on some hardware, uses more memory"}),
                "slg_args": ("SLGARGS",),
                "rope_function": (["default", "comfy", "comfy_chunked"], {"default": "comfy", "tooltip": "Comfy's RoPE implementation doesn't use complex numbers and can thus be compiled, that should be a lot faster when using torch.compile. Chunked version has reduced peak VRAM usage when not using torch.compile"}),
                "loop_args": ("LOOPARGS",),
                "experimental_args": ("EXPERIMENTALARGS",),
                "sigmas": ("SIGMAS",),
                "unianimate_poses": ("UNIANIMATE_POSE",),
                "fantasytalking_embeds": ("FANTASYTALKING_EMBEDS",),
                "uni3c_embeds": ("UNI3C_EMBEDS",),
                "multitalk_embeds": ("MULTITALK_EMBEDS",),
                "freeinit_args": ("FREEINITARGS",),
                "start_step": ("INT", {"default": 0, "min": 0, "max": 10000, "step": 1, "tooltip": "Start step for the sampling, 0 means full sampling, otherwise samples only from this step"}),
                "end_step": ("INT", {"default": -1, "min": -1, "max": 10000, "step": 1, "tooltip": "End step for the sampling, -1 means full sampling, otherwise samples only until this step"}),
                "add_noise_to_samples": ("BOOLEAN", {"default": False, "tooltip": "Add noise to the samples before sampling, needed for video2video sampling when starting from clean video"}),
            },
        }

    @classmethod
    def _localized_copy(cls, data):
        labels = {
            "model": ("WanVideo 模型", "连接 GJJ WanVideo 模型加载器输出的 WANVIDEOMODEL。"),
            "image_embeds": ("图像条件", "连接 WanVideo 图像条件、空 latent 条件或视频条件编码输出。"),
            "steps": ("采样步数", "采样总步数；默认值与原版 WanVideoSampler 一致。"),
            "cfg": ("CFG", "提示词引导强度；默认值与原版 WanVideoSampler 一致。"),
            "shift": ("Shift", "WanVideo flow shift 参数；默认值与原版 WanVideoSampler 一致。"),
            "seed": ("种子", "随机种子；按原版参数原样传递。"),
            "force_offload": ("采样后卸载", "采样后把模型移回卸载设备，行为与原版一致。"),
            "scheduler": ("调度器", "WanVideo 采样调度器；默认 unipc 与原版一致。"),
            "riflex_freq_index": ("RIFLEX 频率索引", "0 表示关闭；用于减少续帧循环感。"),
            "text_embeds": ("文本条件", "可选 WanVideo 文本编码输出。"),
            "samples": ("初始 latent", "视频转视频或续采样时使用的初始 latent。"),
            "denoise_strength": ("降噪强度", "视频转视频或续采样时的降噪强度。"),
            "feta_args": ("FETA 参数", "可选 FETA 增强参数。"),
            "context_options": ("上下文窗口", "可选长视频上下文窗口配置。"),
            "cache_args": ("缓存参数", "可选 TeaCache/MagCache/EasyCache 等缓存配置。"),
            "flowedit_args": ("FlowEdit 参数", "原版保留的旧接口；当前 runtime 已废弃。"),
            "batched_cfg": ("批量 CFG", "将正负条件合批运行，可能更快但会占用更多显存。"),
            "slg_args": ("SLG 参数", "可选 Skip Layer Guidance 参数。"),
            "rope_function": ("RoPE 函数", "comfy 通常更快；comfy_chunked 峰值显存更低；特殊模型可用 default。"),
            "loop_args": ("循环参数", "可选循环视频参数。"),
            "experimental_args": ("实验参数", "可选 WanVideoWrapper 实验参数。"),
            "sigmas": ("Sigmas", "可选自定义 sigmas；连接后会改变采样时间步。"),
            "unianimate_poses": ("UniAnimate 姿态", "可选 UniAnimate 姿态控制。"),
            "fantasytalking_embeds": ("FantasyTalking 条件", "可选 FantasyTalking 条件。"),
            "uni3c_embeds": ("Uni3C 条件", "可选 Uni3C 条件。"),
            "multitalk_embeds": ("MultiTalk 条件", "可选 MultiTalk/InfiniteTalk 音频条件。"),
            "freeinit_args": ("FreeInit 参数", "可选 FreeInit 参数；连接后会改变初始噪声和迭代采样。"),
            "start_step": ("起始步", "从指定步开始采样；0 表示完整采样。"),
            "end_step": ("结束步", "-1 表示完整采样；其它值表示采样到指定步结束。"),
            "add_noise_to_samples": ("给 latent 加噪", "视频转视频从干净 latent 开始时可启用。"),
        }
        copied = {}
        for section, values in data.items():
            if not isinstance(values, dict):
                copied[section] = values
                continue
            copied[section] = {}
            for key, spec in values.items():
                if section == "hidden":
                    copied[section][key] = spec
                    continue
                label = labels.get(key)
                if label is None or not isinstance(spec, tuple):
                    copied[section][key] = spec
                    continue
                meta = dict(spec[1]) if len(spec) >= 2 and isinstance(spec[1], dict) else {}
                meta["display_name"] = label[0]
                meta["tooltip"] = label[1]
                if len(spec) >= 2 and isinstance(spec[1], dict):
                    copied[section][key] = (spec[0], meta, *spec[2:])
                else:
                    copied[section][key] = (spec[0], meta, *spec[1:])
        return copied

    def process(self, **kwargs):
        params = inspect.signature(_load_sampler_runtime().WanVideoSampler.process).parameters
        args_dict = {}
        for name, param in params.items():
            if name in {"self", "unique_id", "extra_args"}:
                continue
            if name in kwargs:
                args_dict[name] = kwargs[name]
            elif param.default is not inspect.Parameter.empty:
                args_dict[name] = param.default
            else:
                args_dict[name] = None
        return (args_dict,)


class GJJ_WanVideoSamplerFromSettings(GJJ_WanVideoSamplerV2):
    DESCRIPTION = "GJJ WanVideo 从采样参数执行：复刻 WanVideoSamplerFromSettings，只接收 SAMPLER_ARGS 并执行采样。"
    RETURN_TYPES = ("LATENT", "LATENT")
    RETURN_NAMES = ("采样 latent", "去噪 latent")
    OUTPUT_TOOLTIPS = ("按采样参数包执行后的 latent。", "去噪后的 latent，供预览或调试使用。")
    FUNCTION = "process"
    CATEGORY = "GJJ/视频模型/WanVideo"
    GJJ_HELP = {
        "title": "WanVideo 从采样参数执行",
        "description": "复刻原版 WanVideoSamplerFromSettings：只接收 SAMPLER_ARGS，并把参数原样转交给 WanVideoSampler.process 执行。",
        "usage": [
            "上游连接 GJJ · ⚙️ WanVideo 采样参数 的 sampler_inputs 输出。",
            "适合把复杂采样参数折叠到单独节点里，让真正执行采样的节点保持简洁。",
            "此节点不再改写 seed、scheduler、steps、cfg、shift 等字段；行为与原版 FromSettings 的透明转发一致。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "sampler_inputs": (
                    "SAMPLER_ARGS",
                    {
                        "display_name": "采样参数",
                        "tooltip": "连接 GJJ · ⚙️ WanVideo 采样参数 输出的 SAMPLER_ARGS；内部字段保持原版 WanVideoSamplerSettings 键名。",
                    },
                ),
            },
        }

    def process(self, sampler_inputs):
        if not isinstance(sampler_inputs, dict):
            raise RuntimeError("WanVideo 采样参数必须是 SAMPLER_ARGS 字典，请连接「GJJ · ⚙️ WanVideo 采样参数」。")

        args = dict(sampler_inputs)
        runtime = _load_sampler_runtime()
        node = runtime.WanVideoSampler()
        return node.process(**args)


def _native_sampler_choices():
    try:
        import comfy.samplers
        return list(comfy.samplers.KSampler.SAMPLERS)
    except Exception:
        return ["euler", "dpmpp_2m", "uni_pc"]


def _native_scheduler_choices():
    try:
        import comfy.samplers
        return list(comfy.samplers.KSampler.SCHEDULERS)
    except Exception:
        return ["simple", "normal", "karras", "beta"]


def _native_choice(value, choices, default):
    value = str(value or "")
    if value in choices:
        return value
    return default if default in choices else (choices[0] if choices else default)


class GJJ_NativeWanVideoSampler:
    @classmethod
    def INPUT_TYPES(cls):
        samplers = _native_sampler_choices()
        schedulers = _native_scheduler_choices()
        return {
            "required": {
                "model": (
                    "MODEL",
                    {
                        "display_name": "原生Wan模型",
                        "tooltip": "连接 ComfyUI 原生 Wan MODEL，例如视频通用模型加载节点的 High模型/Low模型。",
                    },
                ),
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正向条件",
                        "tooltip": "连接 CLIP 正向提示词编码输出。",
                    },
                ),
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "负向条件",
                        "tooltip": "连接 CLIP 负向提示词编码输出。",
                    },
                ),
                "latent_image": (
                    "LATENT",
                    {
                        "display_name": "视频latent",
                        "tooltip": "连接原生 Wan 空 latent 或图生视频条件节点产生的 LATENT。",
                    },
                ),
                "steps": (
                    "INT",
                    {"default": 6, "min": 1, "max": 10000, "step": 1, "display_name": "采样步数", "tooltip": "原生采样步数。"},
                ),
                "cfg": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 30.0, "step": 0.01, "display_name": "CFG", "tooltip": "原生 CFG 引导强度。"},
                ),
                "sampler_name": (
                    samplers,
                    {"default": _native_choice("euler", samplers, "euler"), "display_name": "采样器", "tooltip": "ComfyUI 原生采样器。"},
                ),
                "scheduler": (
                    schedulers,
                    {"default": _native_choice("simple", schedulers, "simple"), "display_name": "调度器", "tooltip": "ComfyUI 原生调度器。"},
                ),
                "denoise": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "降噪强度", "tooltip": "1.0 表示完整采样。"},
                ),
                "seed": (
                    "INT",
                    {"default": 0, "min": 0, "max": 0xffffffffffffffff, "display_name": "种子", "tooltip": "采样随机种子。"},
                ),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("采样latent",)
    OUTPUT_TOOLTIPS = ("ComfyUI 原生 Wan 采样结果 latent。",)
    FUNCTION = "sample"
    CATEGORY = "GJJ/视频模型/WanVideo"
    DESCRIPTION = "GJJ Wan 原生视频采样器：用于视频通用模型加载节点输出的 ComfyUI 原生 MODEL。"
    GJJ_HELP = {
        "title": "Wan 原生视频采样器",
        "description": "使用 ComfyUI 原生采样链处理 Wan MODEL，与 WanVideoWrapper 的 WANVIDEOMODEL 采样器分开。",
        "usage": [
            "模型接视频通用模型加载节点输出的 High模型/Low模型等 MODEL。",
            "正向/负向条件接 GJJ · 🧾 CLIP正负提示词编码 的 CONDITIONING 输出。",
            "视频 latent 接原生空 latent 或原生图生视频条件节点输出。",
        ],
    }

    def sample(self, model, positive, negative, latent_image, steps, cfg, sampler_name, scheduler, denoise, seed):
        if not _is_native_wan_model(model):
            received = _model_input_type_label(model)
            raise RuntimeError(
                "Wan 原生视频采样器只接 ComfyUI 原生 Wan MODEL。\n"
                f"当前收到的是 {received}。如果你接的是 WANVIDEOMODEL，请使用「GJJ · 🎞️ WanVideo 视频采样器 v2」。"
            )
        try:
            from nodes import common_ksampler
        except Exception as error:
            raise RuntimeError(f"原生采样器加载 ComfyUI common_ksampler 失败：{error}") from error
        return common_ksampler(
            model,
            _as_int(seed, 0, min_value=0, max_value=0xffffffffffffffff),
            _as_int(steps, 6, min_value=1),
            _as_float(cfg, 1.0, min_value=0.0, max_value=30.0),
            str(sampler_name),
            str(scheduler),
            positive,
            negative,
            latent_image,
            denoise=_as_float(denoise, 1.0, min_value=0.0, max_value=1.0),
        )

NODE_CLASS_MAPPINGS = {
    "GJJ_WanVideoSchedulerV2": GJJ_WanVideoSchedulerV2,
    "GJJ_WanVideoSamplerV2ExtraArgs": GJJ_WanVideoSamplerV2ExtraArgs,
    "GJJ_WanVideoSamplerSettings": GJJ_WanVideoSamplerSettings,
    "GJJ_WanVideoSamplerFromSettings": GJJ_WanVideoSamplerFromSettings,
    "GJJ_WanVideoSamplerV2": GJJ_WanVideoSamplerV2,
    "GJJ_NativeWanVideoSampler": GJJ_NativeWanVideoSampler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WanVideoSchedulerV2": "GJJ · 🗓️ WanVideo 调度器 v2",
    "GJJ_WanVideoSamplerV2ExtraArgs": "GJJ · 🧰 WanVideo 采样扩展参数",
    "GJJ_WanVideoSamplerSettings": "GJJ · ⚙️ WanVideo 采样参数",
    "GJJ_WanVideoSamplerFromSettings": "GJJ · ▶️ WanVideo 参数采样器",
    "GJJ_WanVideoSamplerV2": "GJJ · 🎞️ WanVideo 视频采样器 v2",
    "GJJ_NativeWanVideoSampler": "GJJ · 🎞️ Wan原生视频采样器",
}
