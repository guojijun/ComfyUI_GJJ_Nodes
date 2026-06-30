from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path
from typing import Any

import folder_paths
import torch
import comfy.model_management as mm
from comfy.utils import ProgressBar, load_torch_file

try:
    from .common_utils.dependency_checker import (
        DEFAULT_MODEL_URL,
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
    )
    from .gjj_model_name_resolver import pick_available_model_name
except ImportError:
    from common_utils.dependency_checker import (
        DEFAULT_MODEL_URL,
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
    )
    from gjj_model_name_resolver import pick_available_model_name


NODE_NAME = "GJJ_GIMMVFIInterpolate"
NODE_DISPLAY_NAME = "GJJ · 🎞️ GIMM-VFI插帧"
MODEL_CATEGORY = "interpolation"
MODEL_SUBDIR = "models/interpolation"
DEFAULT_R_MODEL = "gimmvfi_r_arb_lpips_fp32.safetensors"
DEFAULT_F_MODEL = "gimmvfi_f_arb_lpips_fp32.safetensors"
RAFT_MODEL = "raft-things_fp32.safetensors"
FLOWFORMER_MODEL = "flowformer_sintel_fp32.safetensors"
MODEL_EXT = ".safetensors"
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
_MODEL_CACHE: dict[tuple[str, str, bool], Any] = {}
GIMMVFI_MODEL_TREE = """ComfyUI/
└── models/
    └── interpolation/
        ├── gimmvfi_r_arb_lpips_fp32.safetensors  或可模糊匹配的 R 主模型
        ├── raft-things_fp32.safetensors          R 模型需要
        ├── gimmvfi_f_arb_lpips_fp32.safetensors  或可模糊匹配的 F 主模型
        └── flowformer_sintel_fp32.safetensors    F 模型需要
"""


def _ensure_interpolation_folder() -> None:
    try:
        folder_paths.add_model_folder_path(MODEL_CATEGORY, str(Path(folder_paths.models_dir) / MODEL_CATEGORY))
    except Exception:
        pass


def _interpolation_models() -> list[str]:
    _ensure_interpolation_folder()
    try:
        names = list(folder_paths.get_filename_list(MODEL_CATEGORY) or [])
    except Exception:
        names = []
    values = []
    seen = set()
    for name in names:
        text = str(name or "").strip()
        if not text or not text.lower().endswith(MODEL_EXT):
            continue
        if text in seen:
            continue
        seen.add(text)
        values.append(text)
    return values


def _main_model_choices() -> list[str]:
    names = _interpolation_models()
    preferred = [name for name in names if "gimmvfi" in name.replace("\\", "/").lower()]
    return preferred or names


def _default_model_choice() -> str:
    names = _main_model_choices()
    if not names:
        return ""
    return names[0]


def _resolve_model_name(selected: str, *, preferred: str = "", label: str = "GIMM-VFI模型", unique_id=None) -> str:
    names = _interpolation_models()
    resolved = pick_available_model_name(selected, names, fallback=preferred, allow_first=not bool(selected or preferred))
    if resolved:
        return resolved
    missing = make_missing_model_spec(
        label=label,
        subdir=MODEL_SUBDIR,
        filename=preferred or selected or "*.safetensors",
        description="使用公共模糊搜索 models/interpolation 下的 safetensors 文件，未找到可用文件。",
    )
    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[missing],
        description=(
            "请把 GIMM-VFI 主模型和对应光流模型放到 models/interpolation；"
            "可放在子目录中，节点会按文件名做模糊匹配。"
        ),
        unique_id=unique_id,
        copy_text=MODEL_SUBDIR,
        copy_label="📋 复制模型目录",
        model_download_url=DEFAULT_MODEL_URL,
    )


def _flow_model_for(main_model: str) -> tuple[str, str]:
    text = str(main_model or "").replace("\\", "/").lower()
    if "gimmvfi_f" in text:
        return FLOWFORMER_MODEL, "FlowFormer光流模型"
    return RAFT_MODEL, "RAFT光流模型"


def _dtype_from_precision(precision: str):
    mapping = {
        "fp32": torch.float32,
        "bf16": torch.bfloat16,
        "fp16": torch.float16,
    }
    return mapping.get(str(precision or "fp32").lower(), torch.float32)


def _load_runtime_dependency(name: str, package: str, description: str, unique_id=None):
    return load_dependency_at_runtime(
        name,
        node_name=NODE_DISPLAY_NAME,
        package_name=package,
        description=description,
        unique_id=unique_id,
    )


def _load_gimmvfi_model(model_name: str, precision: str, torch_compile: bool, unique_id=None):
    model_name = _resolve_model_name(model_name, preferred=DEFAULT_R_MODEL, label="GIMM-VFI主模型", unique_id=unique_id)
    flow_seed, flow_label = _flow_model_for(model_name)
    flow_name = _resolve_model_name(flow_seed, preferred=flow_seed, label=flow_label, unique_id=unique_id)
    cache_key = (model_name, str(precision or "fp32"), bool(torch_compile))
    cached = _MODEL_CACHE.get(cache_key)
    if cached is not None:
        return cached

    _load_runtime_dependency("yaml", "PyYAML", "读取 GIMM-VFI YAML 配置。", unique_id)
    _load_runtime_dependency("omegaconf", "omegaconf", "合并 GIMM-VFI 模型结构配置。", unique_id)
    _load_runtime_dependency("easydict", "easydict", "转换 GIMM-VFI 配置字典。", unique_id)
    _load_runtime_dependency("cupy", "cupy-cuda12x", "GIMM-VFI softsplat CUDA 算子需要 cupy。", unique_id)
    _load_runtime_dependency("yacs", "yacs", "FlowFormer 光流配置需要 yacs。", unique_id)
    _load_runtime_dependency("timm", "timm", "FlowFormer/Twins 编码器需要 timm。", unique_id)

    import yaml
    from omegaconf import OmegaConf

    from .vendor.gimmvfi.generalizable_INR.configs import GIMMVFIConfig
    from .vendor.gimmvfi.generalizable_INR.flowformer.configs.submission import get_cfg
    from .vendor.gimmvfi.generalizable_INR.flowformer.core.FlowFormer.LatentCostFormer.transformer import FlowFormer
    from .vendor.gimmvfi.generalizable_INR.gimmvfi_f import GIMMVFI_F
    from .vendor.gimmvfi.generalizable_INR.gimmvfi_r import GIMMVFI_R
    from .vendor.gimmvfi.generalizable_INR.raft import RAFT
    from .vendor.gimmvfi.utils.utils import RaftArgs, easydict_to_dict

    device = mm.get_torch_device()
    dtype = _dtype_from_precision(precision)
    model_path = folder_paths.get_full_path_or_raise(MODEL_CATEGORY, model_name)
    flow_model_path = folder_paths.get_full_path_or_raise(MODEL_CATEGORY, flow_name)
    config_dir = Path(__file__).resolve().parent / "vendor" / "gimmvfi_configs"

    if "gimmvfi_f" in model_name.replace("\\", "/").lower():
        config_path = config_dir / "gimmvfi_f_arb.yaml"
        with config_path.open("r", encoding="utf-8") as handle:
            raw_config = yaml.load(handle, Loader=yaml.FullLoader)
        config = OmegaConf.create(easydict_to_dict(raw_config))
        config = OmegaConf.merge(GIMMVFIConfig.create(config.arch), config.arch)
        model = GIMMVFI_F(dtype, config)
        flowformer = FlowFormer(get_cfg().latentcostformer)
        flowformer_sd = load_torch_file(flow_model_path)
        flowformer.load_state_dict(flowformer_sd, strict=True)
        flow_estimator = flowformer.to(dtype).to(device)
    else:
        config_path = config_dir / "gimmvfi_r_arb.yaml"
        with config_path.open("r", encoding="utf-8") as handle:
            raw_config = yaml.load(handle, Loader=yaml.FullLoader)
        config = OmegaConf.create(easydict_to_dict(raw_config))
        config = OmegaConf.merge(GIMMVFIConfig.create(config.arch), config.arch)
        model = GIMMVFI_R(dtype, config)
        raft_model = RAFT(RaftArgs(small=False, mixed_precision=False, alternate_corr=False))
        raft_sd = load_torch_file(flow_model_path)
        raft_model.load_state_dict(raft_sd, strict=True)
        flow_estimator = raft_model.to(dtype).to(device)

    sd = load_torch_file(model_path)
    model.load_state_dict(sd, strict=False)
    model.flow_estimator = flow_estimator
    model = model.eval().to(dtype).to(device)
    if torch_compile:
        model = torch.compile(model)
    _MODEL_CACHE[cache_key] = model
    return model


def _flow_to_tensor(flow_images: list[Any]) -> torch.Tensor:
    if not flow_images:
        return torch.zeros(1, 64, 64, 3)
    import numpy as np
    tensors = []
    for image in flow_images:
        array = np.asarray(image)
        if array.ndim != 3:
            continue
        if array.shape[-1] == 3:
            array = array[..., ::-1].copy()
        tensors.append(torch.from_numpy(array).float() / 255.0)
    return torch.stack(tensors).cpu().float() if tensors else torch.zeros(1, 64, 64, 3)


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _coerce_media_to_image_frames(value: Any) -> torch.Tensor:
    if value is None:
        raise RuntimeError("请连接输入媒体：支持 GJJ_BATCH_IMAGE、IMAGE 或 VIDEO。")
    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception as exc:
            raise RuntimeError(f"输入可识别为 VIDEO，但读取视频帧失败：{exc}") from exc
        value = _component_value(components, "images")
    elif hasattr(value, "images"):
        value = getattr(value, "images", None)

    if isinstance(value, torch.Tensor):
        tensor = value
    elif isinstance(value, dict):
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = value.get(key)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
    elif isinstance(value, (list, tuple)) and value and all(isinstance(item, torch.Tensor) for item in value):
        tensor = torch.cat([item if item.ndim == 4 else item.unsqueeze(0) for item in value], dim=0)
    else:
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = getattr(value, key, None)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
    if tensor is None:
        raise RuntimeError(f"输入不是有效的 GJJ_BATCH_IMAGE / IMAGE / VIDEO：{type(value).__name__}")
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"输入图片/视频帧维度无效：{tuple(tensor.shape)}")
    if tensor.shape[-1] not in (1, 3, 4) and tensor.shape[1] in (1, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    if tensor.shape[-1] not in (1, 3, 4):
        raise RuntimeError(f"输入图片/视频帧通道数无效：{tuple(tensor.shape)}")
    if tensor.shape[-1] == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif tensor.shape[-1] == 4:
        tensor = tensor[..., :3]
    return tensor.detach().float().clamp(0.0, 1.0).contiguous()


class GJJ_GIMMVFIInterpolate:
    CATEGORY = "GJJ/视频工具"
    FUNCTION = "interpolate"
    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("插帧图片", "光流预览")
    OUTPUT_TOOLTIPS = (
        "输入序列插帧后的完整图片序列。",
        "可选输出的光流可视化图片；关闭光流输出时返回 64x64 空图。",
    )
    DESCRIPTION = "GIMM-VFI 零第三方节点包依赖单节点插帧；模型从 models/interpolation 下模糊搜索。"
    GJJ_HELP = {
        "description": DESCRIPTION,
        "模型放置树": GIMMVFI_MODEL_TREE,
        "models": [
            "models/interpolation/gimmvfi_r_arb_lpips_fp32.safetensors 或可模糊匹配的主模型",
            "models/interpolation/raft-things_fp32.safetensors（R 模型需要）",
            "models/interpolation/gimmvfi_f_arb_lpips_fp32.safetensors 或可模糊匹配的主模型",
            "models/interpolation/flowformer_sintel_fp32.safetensors（F 模型需要）",
        ],
        "notice": "节点不会自动下载模型；请把已有 safetensors 放到 models/interpolation，可放子目录。",
        "dependencies": ["cupy-cuda12x", "timm", "omegaconf", "yacs", "easydict"],
        "model_download_url": DEFAULT_MODEL_URL,
    }

    @classmethod
    def INPUT_TYPES(cls):
        models = _main_model_choices()
        default_model = _default_model_choice()
        if not models:
            models = ["未找到模型"]
            default_model = "未找到模型"
        return {
            "required": {
                "images": (MEDIA_INPUT_TYPE, {"display_name": "输入媒体", "tooltip": "单输入口兼容 GJJ_BATCH_IMAGE、IMAGE、VIDEO。接 VIDEO 时自动读取视频帧；接普通图片或 GJJ 批量图片时自动整理为插帧帧序列。至少需要 2 帧。"}),
                "model_name": (models, {"default": default_model, "display_name": "模型文件", "tooltip": f"从 models/interpolation 及子目录读取 .safetensors；默认使用公共模糊搜索后的第一个结果。\n模型树：\n{GIMMVFI_MODEL_TREE}"}),
                "precision": (["fp32", "bf16", "fp16"], {"default": "fp32", "display_name": "精度", "tooltip": "模型运行精度。fp32 最稳，bf16/fp16 更省显存但依赖显卡支持。"}),
                "ds_factor": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 1.0, "step": 0.01, "display_name": "下采样比例", "tooltip": "GIMM-VFI 的 upsample_ratio 参数；1.0 保持原始推理比例。"}),
                "interpolation_factor": ("INT", {"default": 8, "min": 1, "max": 100, "step": 1, "display_name": "插帧倍数", "tooltip": "每两张输入图之间按该倍数生成中间帧；8 表示每段输出首帧、7 张中间帧和尾帧。"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "display_name": "随机种子", "tooltip": "保持与源节点一致，用于固定可能的随机行为。"}),
                "output_flows": ("BOOLEAN", {"default": False, "display_name": "输出光流", "tooltip": "开启后输出光流可视化图片；会增加显存和运行时间。"}),
                "torch_compile": ("BOOLEAN", {"default": False, "display_name": "Torch编译", "tooltip": "对模型执行 torch.compile；首次运行更慢，且当前环境需要支持 Triton。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def interpolate(
        self,
        images,
        model_name: str,
        precision: str,
        ds_factor: float,
        interpolation_factor: int,
        seed: int,
        output_flows: bool = False,
        torch_compile: bool = False,
        unique_id=None,
    ):
        if str(model_name or "").strip() == "未找到模型":
            _resolve_model_name("", preferred=DEFAULT_R_MODEL, label="GIMM-VFI主模型", unique_id=unique_id)

        _load_runtime_dependency("easydict", "easydict", "GIMM-VFI 输入补边工具。", unique_id)
        from .vendor.gimmvfi.utils import flow_viz
        from .vendor.gimmvfi.utils import utils as runtime_utils

        gimmvfi_model = _load_gimmvfi_model(model_name, precision, torch_compile, unique_id=unique_id)
        images = _coerce_media_to_image_frames(images)
        if images.shape[0] < 2:
            raise RuntimeError("GIMM-VFI 插帧至少需要 2 张输入图片。")

        mm.soft_empty_cache()
        work_images = images.permute(0, 3, 1, 2)
        try:
            seed_int = int(seed)
            torch.manual_seed(seed_int)
            if torch.cuda.is_available():
                torch.cuda.manual_seed(seed_int)
        except Exception:
            pass

        device = mm.get_torch_device()
        dtype = getattr(gimmvfi_model, "dtype", _dtype_from_precision(precision))
        out_images_list = []
        flows = []
        pbar = ProgressBar(work_images.shape[0] - 1)
        interpolation_factor = max(1, int(interpolation_factor))
        ds_factor = max(0.01, min(1.0, float(ds_factor)))

        autocast_device = mm.get_autocast_device(device)
        cast_context = torch.autocast(device_type=autocast_device, dtype=dtype) if dtype != torch.float32 else nullcontext()
        InputPadder = runtime_utils.InputPadder

        with cast_context:
            for index in range(work_images.shape[0] - 1):
                image_a = work_images[index].unsqueeze(0)
                image_b = work_images[index + 1].unsqueeze(0)
                if index == 0:
                    out_images_list.append(image_a.squeeze(0).permute(1, 2, 0))

                padder = InputPadder(image_a.shape, 32)
                image_a, image_b = padder.pad(image_a, image_b)
                xs = torch.cat((image_a.unsqueeze(2), image_b.unsqueeze(2)), dim=2).to(device, non_blocking=True)
                batch_size = xs.shape[0]
                spatial_shape = xs.shape[-2:]
                coord_inputs = [
                    (
                        gimmvfi_model.sample_coord_input(
                            batch_size,
                            spatial_shape,
                            [1 / interpolation_factor * step],
                            device=xs.device,
                            upsample_ratio=ds_factor,
                        ),
                        None,
                    )
                    for step in range(1, interpolation_factor)
                ]
                timesteps = [
                    step * 1 / interpolation_factor * torch.ones(xs.shape[0]).to(xs.device)
                    for step in range(1, interpolation_factor)
                ]
                all_outputs = gimmvfi_model(xs, coord_inputs, t=timesteps, ds_factor=ds_factor)
                out_frames = [padder.unpad(frame) for frame in all_outputs["imgt_pred"]]
                out_flowts = [padder.unpad(flow) for flow in all_outputs["flowt"]]

                if output_flows and flow_viz is not None:
                    flows.extend(
                        flow_viz.flow_to_image(
                            flow.squeeze().detach().cpu().permute(1, 2, 0).numpy(),
                            convert_to_bgr=True,
                        )
                        for flow in out_flowts
                    )
                for pred in out_frames:
                    out_images_list.append(pred[0].detach().cpu().permute(1, 2, 0))
                out_images_list.append(padder.unpad(image_b).squeeze(0).detach().cpu().permute(1, 2, 0))
                pbar.update(1)

        image_tensors = torch.stack(out_images_list).cpu().float().clamp(0.0, 1.0)
        flow_tensors = _flow_to_tensor(flows) if output_flows else torch.zeros(1, 64, 64, 3)
        return (image_tensors, flow_tensors)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_GIMMVFIInterpolate}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🎞️ 视频插帧（GIMM-VFI）"}
