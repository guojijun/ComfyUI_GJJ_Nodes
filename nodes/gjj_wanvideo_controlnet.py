from __future__ import annotations

import gc
import os
from contextlib import contextmanager
from typing import Any

import folder_paths
import torch
from comfy import model_management as mm
from comfy.utils import load_torch_file

from .common_utils.dependency_checker import (
    make_missing_model_spec,
    raise_dependency_model_error,
)


NODE_NAME = "GJJ_WanVideoControlNet"
NODE_DISPLAY_NAME = "🎮 万相视频控制网（kijai流）"
PREFERRED_CONTROLNET_KEYWORD = "wan2.2-ti2v-5b-controlnet"
MISSING_MODEL_CHOICE = "[未找到万相2.2图文视频5B控制网]"
MODEL_EXTENSIONS = (".safetensors", ".pt", ".pth", ".ckpt", ".bin")


def _missing_controlnet_spec(filename: str | None = None) -> dict[str, str]:
    return make_missing_model_spec(
        label="万相2.2图文视频5B控制网",
        subdir="models/controlnet",
        filename=filename or "wan2.2-ti2v-5b-controlnet*.safetensors",
        description="节点会在 models/controlnet 及其子目录中搜索 wan2.2-ti2v-5b-controlnet。",
    )


REQUIRED_MODELS = [_missing_controlnet_spec()]


def _filename_list(category: str) -> list[str]:
    try:
        return [str(item) for item in folder_paths.get_filename_list(category)]
    except Exception:
        return []


def _basename(value: str) -> str:
    return os.path.basename(str(value or "").replace("\\", "/"))


def _stem(value: str) -> str:
    text = _basename(value)
    lowered = text.lower()
    for ext in MODEL_EXTENSIONS:
        if lowered.endswith(ext):
            return text[: -len(ext)]
    return os.path.splitext(text)[0]


def _compact(value: str) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _is_missing_choice(value: Any) -> bool:
    text = str(value or "").strip()
    return not text or text == MISSING_MODEL_CHOICE or text.lower() in {"none", "null", "false"}


def _matches_preferred_controlnet(value: str) -> bool:
    keyword = _compact(PREFERRED_CONTROLNET_KEYWORD)
    return keyword in _compact(value) or keyword in _compact(_stem(value))


def _rank_controlnet_name(value: str) -> tuple[int, int, int, str]:
    normalized = str(value or "").replace("\\", "/").lower()
    basename = _basename(value).lower()
    stem = _stem(value).lower()
    keyword = PREFERRED_CONTROLNET_KEYWORD.lower()
    if stem == keyword:
        bucket = 0
    elif basename.startswith(keyword):
        bucket = 1
    elif keyword in normalized:
        bucket = 2
    elif _matches_preferred_controlnet(value):
        bucket = 3
    else:
        bucket = 80
    return (bucket, normalized.count("/"), len(normalized), normalized)


def _preferred_controlnets() -> list[str]:
    candidates = [name for name in _filename_list("controlnet") if _matches_preferred_controlnet(name)]
    return sorted(candidates, key=_rank_controlnet_name)


def _controlnet_choices() -> tuple[list[str], str]:
    all_models = _filename_list("controlnet")
    preferred = _preferred_controlnets()
    if preferred:
        seen = set(preferred)
        choices = preferred + [name for name in all_models if name not in seen]
        return choices, preferred[0]
    if all_models:
        return [MISSING_MODEL_CHOICE, *all_models], MISSING_MODEL_CHOICE
    return [MISSING_MODEL_CHOICE], MISSING_MODEL_CHOICE


def _raise_missing_controlnet(requested: Any = None, unique_id: Any = None) -> None:
    requested_text = str(requested or "").strip()
    filename = requested_text if requested_text and requested_text != MISSING_MODEL_CHOICE else None
    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[_missing_controlnet_spec(filename)],
        description=(
            "未找到万相2.2图文视频5B控制网。请把包含 "
            "wan2.2-ti2v-5b-controlnet 的模型文件放入 models/controlnet 或其子目录，"
            "刷新模型列表后再运行。"
        ),
        unique_id=unique_id,
        title="GJJ 万相视频控制网缺少模型",
    )


def _resolve_controlnet_name(requested: Any, unique_id: Any = None) -> str:
    available = _filename_list("controlnet")
    raw = str(requested or "").strip()

    if _is_missing_choice(raw):
        preferred = _preferred_controlnets()
        if preferred:
            return preferred[0]
        _raise_missing_controlnet(raw, unique_id=unique_id)

    raw_key = raw.replace("\\", "/").lower()
    raw_base = _basename(raw).lower()
    for candidate in available:
        if candidate.replace("\\", "/").lower() == raw_key:
            return candidate
    for candidate in available:
        if _basename(candidate).lower() == raw_base:
            return candidate

    try:
        if folder_paths.get_full_path("controlnet", raw):
            return raw
    except Exception:
        pass

    fuzzy = [name for name in available if _compact(raw) in _compact(name) or _compact(name) in _compact(raw)]
    if fuzzy:
        return sorted(fuzzy, key=_rank_controlnet_name)[0]

    _raise_missing_controlnet(raw, unique_id=unique_id)
    return raw


@contextmanager
def _empty_weights_context(unique_id: Any = None):
    try:
        from accelerate import init_empty_weights
    except Exception as exc:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[
                {
                    "module_name": "accelerate",
                    "package_name": "accelerate",
                    "display_name": "低内存加载库（accelerate）",
                    "description": "万相视频控制网需要用它进行低内存模型初始化。",
                }
            ],
            install_packages=["accelerate"],
            description="当前环境缺少万相视频控制网低内存加载所需的 accelerate。",
            original_error=str(exc),
            unique_id=unique_id,
            title="GJJ 万相视频控制网运行依赖缺失",
        )

    try:
        try:
            context = init_empty_weights(include_buffers=False)
        except TypeError:
            context = init_empty_weights()
        with context:
            yield
    except Exception as exc:
        raise RuntimeError(
            "万相视频控制网空权重初始化失败。请更新 PyTorch，或确认当前 ComfyUI 运行环境支持空设备初始化。\n"
            f"原始错误：{exc}"
        ) from exc


def _set_module_tensor_to_device(module: torch.nn.Module, tensor_name: str, device: Any, value: torch.Tensor, dtype=None) -> None:
    if "." in tensor_name:
        parts = tensor_name.split(".")
        for part in parts[:-1]:
            module = getattr(module, part)
        tensor_name = parts[-1]

    is_param = tensor_name in module._parameters
    is_buffer = tensor_name in module._buffers
    if not is_param and not is_buffer:
        raise ValueError(f"{module.__class__.__name__} 没有参数或 buffer：{tensor_name}")

    if dtype is not None and torch.is_tensor(value) and value.is_floating_point():
        value = value.to(dtype=dtype)
    new_value = value.to(device=device)

    if is_buffer:
        module._buffers[tensor_name] = new_value
        return

    old_value = module._parameters[tensor_name]
    param_cls = type(old_value)
    module._parameters[tensor_name] = param_cls(new_value, requires_grad=False)


def _dtype_from_precision(precision: str):
    mapping = {
        "fp32": torch.float32,
        "bf16": torch.bfloat16,
        "fp16": torch.float16,
    }
    return mapping.get(str(precision or "bf16"), torch.bfloat16)


def _detect_weight_quantization(state_dict: dict[str, Any], quantization: str) -> str:
    if quantization != "disabled":
        return quantization
    for value in state_dict.values():
        if not torch.is_tensor(value):
            continue
        if hasattr(torch, "float8_e4m3fn") and value.dtype == torch.float8_e4m3fn:
            return "fp8_e4m3fn"
        if hasattr(torch, "float8_e5m2") and value.dtype == torch.float8_e5m2:
            return "fp8_e5m2"
    return quantization


def _weight_dtype(base_dtype, quantization: str):
    if "fp8_e4m3fn" in str(quantization) and hasattr(torch, "float8_e4m3fn"):
        return torch.float8_e4m3fn
    if str(quantization) == "fp8_e5m2" and hasattr(torch, "float8_e5m2"):
        return torch.float8_e5m2
    return base_dtype


def _assert_no_meta_tensors(module: torch.nn.Module) -> None:
    meta_names: list[str] = []
    for name, param in module.named_parameters():
        if getattr(param, "device", None) is not None and param.device.type == "meta":
            meta_names.append(name)
    for name, buffer in module.named_buffers():
        if getattr(buffer, "device", None) is not None and buffer.device.type == "meta":
            meta_names.append(name)
    if meta_names:
        preview = ", ".join(meta_names[:8])
        raise RuntimeError(
            "控制网仍有空设备张量未加载，无法交给采样器使用。"
            f"未加载张量数量：{len(meta_names)}；示例：{preview}"
        )


def _load_wan_controlnet_class(unique_id: Any = None):
    try:
        from ..vendor.wanvideo_wrapper.controlnet.wan_controlnet import WanControlnet
    except Exception as exc:
        message = str(exc)
        missing = []
        lowered = message.lower()
        if "diffusers" in lowered or "no module named 'diffusers'" in lowered:
            missing.append("diffusers")
        if not missing:
            missing.append("diffusers")
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=missing,
            install_packages=missing,
            description="万相视频控制网运行时需要 GJJ 内置的万相视频结构，以及 diffusers 中的万相变换器组件。",
            original_error=message,
            unique_id=unique_id,
            title="GJJ 万相视频控制网运行依赖缺失",
        )
    return WanControlnet


def _build_controlnet_config(state_dict: dict[str, Any]) -> dict[str, Any]:
    if "control_encoder.0.0.weight" not in state_dict:
        raise RuntimeError("控制网模型无效：缺少 control_encoder.0.0.weight。")
    if "controlnet_blocks.0.bias" not in state_dict:
        raise RuntimeError("控制网模型无效：缺少 controlnet_blocks.0.bias。")

    num_layers = 8 if "blocks.7.scale_shift_table" in state_dict else 6
    out_proj_dim = int(state_dict["controlnet_blocks.0.bias"].shape[0])
    downscale_coef = 16 if out_proj_dim == 3072 else 8
    vae_channels = 48 if out_proj_dim == 3072 else 16

    return {
        "added_kv_proj_dim": None,
        "attention_head_dim": 128,
        "cross_attn_norm": None,
        "downscale_coef": downscale_coef,
        "eps": 1e-6,
        "ffn_dim": 8960,
        "freq_dim": 256,
        "image_dim": None,
        "in_channels": 3,
        "num_attention_heads": 12,
        "num_layers": num_layers,
        "out_proj_dim": out_proj_dim,
        "patch_size": [1, 2, 2],
        "qk_norm": "rms_norm_across_heads",
        "rope_max_seq_len": 1024,
        "text_dim": 4096,
        "vae_channels": vae_channels,
    }


def _normalize_control_images(control_images: torch.Tensor) -> torch.Tensor:
    if not torch.is_tensor(control_images):
        raise RuntimeError("万相视频控制网需要图片批次作为控制帧输入。")
    image = control_images.float()
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise RuntimeError(f"万相视频控制网控制帧维度无效，应为图片批次，实际为：{tuple(image.shape)}")
    channels = int(image.shape[-1])
    if channels == 1:
        image = image.repeat(1, 1, 1, 3)
    elif channels > 3:
        image = image[..., :3]
    elif channels != 3:
        raise RuntimeError(f"万相视频控制网控制帧通道数无效：{channels}")
    return (image.permute(3, 0, 1, 2).unsqueeze(0).contiguous() * 2.0) - 1.0


class GJJ_WanVideoControlNet:
    CATEGORY = "GJJ/视频模型/万相视频"
    FUNCTION = "apply"
    DESCRIPTION = (
        "GJJ 零依赖合并版万相视频控制网："
        "节点内从 models/controlnet 搜索并加载 wan2.2-ti2v-5b-controlnet，"
        "再把控制帧写入万相视频模型的控制参数。"
    )
    SEARCH_ALIASES = [
        "万相视频控制网",
        "万相控制网",
        "图文视频控制网",
        "控制视频",
        "kijai流",
    ]
    RETURN_TYPES = ("WANVIDEOMODEL",)
    RETURN_NAMES = ("万相视频模型",)
    OUTPUT_TOOLTIPS = ("已写入控制网参数的万相视频模型，可连接到 GJJ 万相视频采样器。",)
    REQUIRED_MODELS = REQUIRED_MODELS
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": DESCRIPTION,
        "models": REQUIRED_MODELS,
        "usage": [
            "万相视频模型输入接 GJJ 万相视频模型加载器输出。",
            "控制帧输入接图片批次，批次维度会按帧序作为控制视频帧。",
            "模型下拉优先搜索 models/controlnet 下包含 wan2.2-ti2v-5b-controlnet 的文件，支持子目录。",
            "输出模型继续接万相视频采样器；本节点不再暴露单独的控制网加载输出。",
        ],
        "runtime": [
            "不依赖外部万相视频插件，只使用 GJJ 内置的万相视频控制网结构。",
            "运行时需要当前环境可导入 diffusers 的万相变换器组件。",
        ],
    }

    def __init__(self):
        self._cache_key: tuple[str, str, str, str] | None = None
        self._cached_controlnet = None

    @classmethod
    def INPUT_TYPES(cls):
        controlnet_choices, default_controlnet = _controlnet_choices()
        return {
            "required": {
                "model": (
                    "WANVIDEOMODEL",
                    {
                        "display_name": "万相视频模型",
                        "tooltip": "来自 GJJ 万相视频模型加载器的模型。节点会复制模型引用后写入控制网参数，不直接修改输入模型。",
                    },
                ),
                "control_images": (
                    "IMAGE",
                    {
                        "display_name": "控制视频帧",
                        "tooltip": "用于控制生成结果的视频帧。图片批次会按顺序作为帧输入，并在节点内部转换为万相视频控制网需要的张量。",
                    },
                ),
                "controlnet_name": (
                    controlnet_choices,
                    {
                        "default": default_controlnet,
                        "display_name": "控制网模型",
                        "tooltip": "优先搜索 models/controlnet 下包含 wan2.2-ti2v-5b-controlnet 的模型，支持子目录相对路径。",
                    },
                ),
                "strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "display_name": "控制强度",
                        "tooltip": "控制网影响生成结果的强度。0 表示不写入控制，直接透传模型。",
                    },
                ),
                "control_stride": (
                    "INT",
                    {
                        "default": 3,
                        "min": 1,
                        "max": 8,
                        "step": 1,
                        "display_name": "控制步距",
                        "tooltip": "每隔多少个变换器模块注入一次控制网状态，默认与 kijai流的原始逻辑一致为 3。",
                    },
                ),
                "start_percent": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "开始比例",
                        "tooltip": "采样进度到达该比例后开始应用万相视频控制网。",
                    },
                ),
                "end_percent": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "结束比例",
                        "tooltip": "采样进度到达该比例后停止应用万相视频控制网。",
                    },
                ),
                "base_precision": (
                    ["fp32", "bf16", "fp16"],
                    {
                        "default": "bf16",
                        "display_name": "基础精度",
                        "tooltip": "控制网基础计算精度。通常 bf16 适合新显卡，fp16 更省显存。",
                    },
                ),
                "quantization": (
                    ["disabled", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2", "fp8_e4m3fn_fast_no_ffn"],
                    {
                        "default": "disabled",
                        "display_name": "权重量化",
                        "tooltip": "控制网权重量化方式。关闭时会自动识别八位浮点权重，否则按所选精度加载。",
                    },
                ),
                "load_device": (
                    ["main_device", "offload_device"],
                    {
                        "default": "offload_device",
                        "display_name": "加载设备",
                        "tooltip": "控制网初始加载位置。显存紧张时推荐卸载设备，采样时会自动搬到主设备。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def _load_controlnet(self, controlnet_name: Any, base_precision: str, quantization: str, load_device: str, unique_id: Any = None):
        resolved = _resolve_controlnet_name(controlnet_name, unique_id=unique_id)
        cache_key = (resolved, str(base_precision), str(quantization), str(load_device))
        if self._cache_key == cache_key and self._cached_controlnet is not None:
            return self._cached_controlnet, resolved

        device = mm.get_torch_device()
        offload_device = mm.unet_offload_device()
        transformer_load_device = device if load_device == "main_device" else offload_device
        base_dtype = _dtype_from_precision(base_precision)
        model_path = folder_paths.get_full_path_or_raise("controlnet", resolved)

        print("[GJJ 万相视频控制网] ========== 开始加载控制网 ==========")
        print(f"[GJJ 万相视频控制网] 模型: models/controlnet/{resolved}")
        print(f"[GJJ 万相视频控制网] 基础精度: {base_precision}")
        print(f"[GJJ 万相视频控制网] 量化: {quantization}")
        print(f"[GJJ 万相视频控制网] 加载设备: {transformer_load_device}")

        try:
            state_dict = load_torch_file(model_path, device=transformer_load_device, safe_load=True)
            config = _build_controlnet_config(state_dict)
            WanControlnet = _load_wan_controlnet_class(unique_id=unique_id)
            with _empty_weights_context(unique_id=unique_id):
                controlnet = WanControlnet(**config)
            controlnet.eval()

            detected_quantization = _detect_weight_quantization(state_dict, str(quantization or "disabled"))
            dtype = _weight_dtype(base_dtype, detected_quantization)
            keep_base_dtype = {
                "norm",
                "head",
                "time_in",
                "vector_in",
                "controlnet_patch_embedding",
                "time_",
                "img_emb",
                "modulation",
                "text_embedding",
                "adapter",
            }

            missing_keys = []
            for name, _param in controlnet.named_parameters():
                value = state_dict.get(name)
                if value is None:
                    missing_keys.append(name)
                    continue
                dtype_to_use = base_dtype if any(keyword in name for keyword in keep_base_dtype) else dtype
                if "controlnet_patch_embedding" in name:
                    dtype_to_use = torch.float32
                _set_module_tensor_to_device(controlnet, name, transformer_load_device, value, dtype=dtype_to_use)
            if missing_keys:
                first = ", ".join(missing_keys[:5])
                raise RuntimeError(f"控制网权重缺少 {len(missing_keys)} 个参数：{first}")
            _assert_no_meta_tensors(controlnet)
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(
                "万相视频控制网加载失败。\n"
                f"模型文件：models/controlnet/{resolved}\n"
                f"原始错误：{exc}"
            ) from exc
        finally:
            try:
                del state_dict
            except Exception:
                pass

        if load_device == "offload_device":
            try:
                controlnet.to(offload_device)
            except Exception:
                pass
            gc.collect()
            mm.soft_empty_cache()

        self._cache_key = cache_key
        self._cached_controlnet = controlnet
        print("[GJJ 万相视频控制网] 控制网加载完成")
        print("[GJJ 万相视频控制网] ========== 加载完成 ==========")
        return controlnet, resolved

    def apply(
        self,
        model,
        control_images,
        controlnet_name=MISSING_MODEL_CHOICE,
        strength=1.0,
        control_stride=3,
        start_percent=0.0,
        end_percent=1.0,
        base_precision="bf16",
        quantization="disabled",
        load_device="offload_device",
        unique_id=None,
    ):
        strength_value = max(0.0, min(10.0, float(strength)))
        if strength_value <= 0.0:
            return {
                "ui": {"preview_text": ["万相视频控制网强度为 0，已透传模型。"]},
                "result": (model,),
            }

        controlnet, resolved_name = self._load_controlnet(
            controlnet_name,
            base_precision,
            quantization,
            load_device,
            unique_id=unique_id,
        )
        control_input = _normalize_control_images(control_images)
        start_value = max(0.0, min(1.0, float(start_percent)))
        end_value = max(0.0, min(1.0, float(end_percent)))
        if end_value < start_value:
            start_value, end_value = end_value, start_value
        stride_value = max(1, min(8, int(control_stride)))

        patcher = model.clone()
        if not isinstance(getattr(patcher, "model_options", None), dict):
            raise RuntimeError("万相视频模型对象无效：缺少可写入的模型参数。")
        transformer_options = patcher.model_options.setdefault("transformer_options", {})
        transformer_options["controlnet"] = {
            "controlnet": controlnet,
            "control_latents": control_input,
            "controlnet_strength": strength_value,
            "control_stride": stride_value,
            "controlnet_start": start_value,
            "controlnet_end": end_value,
        }

        return {
            "ui": {
                "preview_text": [
                    (
                        "万相视频控制网已应用："
                        f"{resolved_name}；强度 {strength_value:g}；步距 {stride_value}；范围 {start_value:g}-{end_value:g}"
                    )
                ]
            },
            "result": (patcher,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanVideoControlNet}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
