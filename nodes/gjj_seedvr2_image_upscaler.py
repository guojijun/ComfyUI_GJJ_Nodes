from __future__ import annotations

import importlib
import gc
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from fractions import Fraction
from functools import lru_cache
from pathlib import Path
from typing import Any

import folder_paths
import torch
from comfy_api.latest import InputImpl, Types

NODE_NAME = "GJJ_SeedVR2ImageUpscaler"
NODE_DISPLAY_NAME = "GJJ · 🔍 SeedVR2图像视频放大器"
DEFAULT_DIT_MODEL = "seedvr2_3b_int8_convrot.safetensors"
DEFAULT_VAE_MODEL = "ema_vae_fp16.safetensors"
MODEL_CATEGORY = "SEEDVR2"
LEGACY_MODEL_CATEGORY = "seedvr2"
MODEL_SUBDIR = "models/SEEDVR2"
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
COMMON_VIDEO_HEIGHT_OPTIONS = [
    "手动输入",
    "480",
    "540",
    "576",
    "720",
    "768",
    "832",
    "960",
    "1024",
    "1080",
    "1216",
    "1440",
    "1536",
    "1920",
    "2160",
]

try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        build_node_help_payload,
        make_missing_model_spec,
        print_dependency_model_report,
        raise_dependency_model_error,
        send_dependency_model_notice,
    )
    from .common_utils.model_manager import gjjutils_resolve_model_by_extensionless_seed
except ImportError:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        build_node_help_payload,
        make_missing_model_spec,
        print_dependency_model_report,
        raise_dependency_model_error,
        send_dependency_model_notice,
    )
    from common_utils.model_manager import gjjutils_resolve_model_by_extensionless_seed


SEEDVR2_MODEL_TREE = """ComfyUI/
└── models/
    └── SEEDVR2/
        ├── seedvr2_3b_int8_convrot.safetensors
        ├── seedvr2_7b_int8_convrot.safetensors
        ├── seedvr2_ema_7b_sharp_int4_convrot.safetensors
        ├── seedvr2_ema_3b_fp16.safetensors         其他模型也必须是完整官方格式
        └── ema_vae_fp16.safetensors
"""
_DESCRIPTION_INTRO = "将 ComfyUI 官方 SeedVR2 图像/视频放大工作流整合成单节点；支持包含完整条件张量的 3B/7B SeedVR2 模型，接 VIDEO 时保留原音频与帧率。"


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _seedvr2_runtime_root() -> Path:
    return Path(__file__).resolve().parents[1] / "vendor" / "seedvr2_runtime"


def _missing_runtime_specs() -> list[dict[str, str]]:
    # The node now executes ComfyUI's official SeedVR2 graph.  The vendored
    # legacy runtime is deliberately not an installation dependency anymore.
    return []


def _ensure_seedvr2_model_folder() -> None:
    try:
        model_dir = Path(folder_paths.models_dir) / MODEL_CATEGORY
        folder_paths.add_model_folder_path(MODEL_CATEGORY, str(model_dir))
        folder_paths.add_model_folder_path(LEGACY_MODEL_CATEGORY, str(model_dir))
    except Exception:
        pass


def _list_seedvr2_folder_models() -> list[str]:
    _ensure_seedvr2_model_folder()
    try:
        names = list(folder_paths.get_filename_list(MODEL_CATEGORY) or [])
    except Exception:
        names = []
    values: list[str] = []
    seen: set[str] = set()
    for name in names:
        text = str(name or "").strip()
        if not text:
            continue
        lower = text.lower()
        if not lower.endswith(".safetensors"):
            continue
        key = lower.replace("\\", "/")
        if key in seen:
            continue
        seen.add(key)
        values.append(text)
    values.sort(key=lambda item: item.lower())
    return values


def _ordered_model_choices(seed_name: str, *, want_vae: bool) -> list[str]:
    folder_models = _list_seedvr2_folder_models()
    preferred = gjjutils_resolve_model_by_extensionless_seed(seed_name, MODEL_CATEGORY)
    if preferred and not str(preferred).lower().endswith(".safetensors"):
        preferred = None
    filtered = []
    for name in folder_models:
        is_vae = "vae" in name.replace("\\", "/").lower()
        if is_vae == want_vae:
            filtered.append(name)
    if not filtered:
        filtered = folder_models

    choices: list[str] = []
    for value in [preferred, *filtered, seed_name]:
        text = str(value or "").strip()
        if text and text not in choices:
            choices.append(text)
    return choices or [seed_name]


def _default_model_choice(seed_name: str) -> str:
    resolved = gjjutils_resolve_model_by_extensionless_seed(seed_name, MODEL_CATEGORY)
    return resolved if resolved and str(resolved).lower().endswith(".safetensors") else seed_name


_ENVIRONMENT_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=[],
    install_packages=None,
    description="使用 ComfyUI 官方 SeedVR2 实现，不依赖第三方自定义节点或 GJJ 旧版内置运行时。",
)
if _ENVIRONMENT_REPORT.get("missing_dependencies"):
    _ENVIRONMENT_REPORT["install_cmd"] = ""
    _ENVIRONMENT_REPORT["copy_text"] = ""
    _ENVIRONMENT_REPORT["copy_label"] = ""
_DEPENDENCIES_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("dependencies_available", True))
_MISSING_DEPENDENCIES = list(_ENVIRONMENT_REPORT.get("missing_dependencies", []) or [])
if _MISSING_DEPENDENCIES:
    print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ SeedVR2 运行时缺失")

_GJJ_HELP = build_node_help_payload(
    description=_DESCRIPTION_INTRO,
    dependencies=[
        {
            "name": "ComfyUI 官方 SeedVR2",
            "type": "ComfyUI 核心功能",
            "required": True,
            "description": "节点直接调用当前 ComfyUI 的官方 SeedVR2 预处理、条件、采样和后处理实现，无需安装第三方 SeedVR2 节点。",
        }
    ],
    model_tree=[
        {
            "label": "SeedVR2 主模型",
            "path": f"{MODEL_SUBDIR}/seedvr2_3b_int8_convrot.safetensors",
            "required": True,
            "description": "下拉列表会去扩展名与量化标记后在 models/SEEDVR2 深度搜索，优先取匹配项。",
        },
        {
            "label": "SeedVR2 VAE",
            "path": f"{MODEL_SUBDIR}/ema_vae_fp16.safetensors",
            "required": True,
            "description": "同样支持子目录与大小写不敏感模糊匹配。",
        },
    ],
    models=[],
    usage=[
        "连接统一媒体口：GJJ_BATCH_IMAGE / IMAGE 直接按图像批次处理，VIDEO 会先提取帧并在输出时保留音频与帧率。",
        "布尔选项在节点顶部按钮行切换，其余参数默认隐藏，点击 ⚙️设置 展开。",
    ],
    runtime=[
        "无需安装 ComfyUI-SeedVR2_VideoUpscaler；推理由当前 ComfyUI 官方 SeedVR2 实现完成。",
    ],
    install_cmd=_ENVIRONMENT_REPORT.get("install_cmd", ""),
    copy_text=_ENVIRONMENT_REPORT.get("copy_text", ""),
    copy_label=_ENVIRONMENT_REPORT.get("copy_label", ""),
    notice=_ENVIRONMENT_REPORT.get("warning_message", ""),
    extra={
        "模型放置树": SEEDVR2_MODEL_TREE,
        "模型树信息": [
            {
                "label": "SeedVR2 主模型",
                "path": f"{MODEL_SUBDIR}/seedvr2_3b_int8_convrot.safetensors",
                "folder": MODEL_CATEGORY,
                "required": True,
                "match_rule": "去扩展名、去量化标记后在 models/SEEDVR2 含子目录中大小写不敏感搜索。",
            },
            {
                "label": "SeedVR2 VAE",
                "path": f"{MODEL_SUBDIR}/ema_vae_fp16.safetensors",
                "folder": MODEL_CATEGORY,
                "required": True,
                "match_rule": "去扩展名、去量化标记后在 models/SEEDVR2 含子目录中大小写不敏感搜索。",
            },
        ],
        "依赖信息": [
            {
                "name": "ComfyUI 官方 SeedVR2",
                "type": "ComfyUI 核心功能",
                "path": "comfy_extras/nodes_seedvr.py",
                "required": True,
                "description": "随新版 ComfyUI 提供，不需要安装第三方自定义节点。",
            },
            {
                "name": "PyTorch / comfy_api.latest / folder_paths",
                "type": "ComfyUI 内置运行环境",
                "required": True,
                "description": "用于张量处理、官方 VIDEO 对象和模型目录解析。",
            },
        ],
        "warning_message": _ENVIRONMENT_REPORT.get("warning_message", ""),
        "notice_level": _ENVIRONMENT_REPORT.get("notice_level", "ok"),
    },
)


def _get_local_device_list(include_none: bool = False, include_cpu: bool = False) -> list[str]:
    devices: list[str] = []
    if include_none:
        devices.append("none")
    if include_cpu:
        devices.append("cpu")

    try:
        if torch.cuda.is_available():
            devices.extend([f"cuda:{i}" for i in range(torch.cuda.device_count())])
    except Exception:
        pass

    try:
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            devices.append("mps")
    except Exception:
        pass

    deduped: list[str] = []
    for item in devices:
        if item not in deduped:
            deduped.append(item)
    return deduped or (["cpu"] if include_cpu else ["cpu"])


def _preferred_runtime_device() -> str:
    devices = _get_local_device_list(include_cpu=True)
    if "cuda:0" in devices:
        return "cuda:0"
    return "cpu" if "cpu" in devices else devices[0]


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        status_text = str(text or "")
        if progress is None:
            prefix = status_text.split(" ", 1)[0]
            if "/6" in prefix:
                try:
                    stage = max(1, min(6, int(prefix.split("/", 1)[0])))
                    progress = 0.03 + ((stage - 1) / 5.0) * 0.87
                except (TypeError, ValueError):
                    progress = None
            elif status_text.startswith("完成："):
                progress = 1.0
        payload = {"node": str(unique_id), "text": status_text, "pipeline": "seedvr2"}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        PromptServer.instance.send_sync(
            "gjj_node_progress",
            payload,
        )
    except Exception:
        pass


def _send_segment_preview(
    unique_id: Any,
    frame: torch.Tensor,
    *,
    segment: int,
    total_segments: int,
    start_frame: int,
    end_frame: int,
    total_frames: int,
    completed_seconds: float = 0.0,
    completed_frames: int = 0,
    context_start_frame: int | None = None,
    context_end_frame: int | None = None,
) -> None:
    if not unique_id or not isinstance(frame, torch.Tensor) or frame.numel() == 0:
        return
    try:
        import numpy as np
        from PIL import Image
        from server import PromptServer

        preview = frame.detach().to(device="cpu", dtype=torch.float32).clamp(0, 1)
        array = (preview.numpy() * 255.0).round().astype(np.uint8)
        image = Image.fromarray(array[..., :3]).convert("RGB")
        safe_node_id = "".join(
            character if character.isalnum() or character in "-_" else "_"
            for character in str(unique_id)
        ) or "unknown"
        preview_root = Path(folder_paths.get_temp_directory()) / "GJJ"
        preview_root.mkdir(parents=True, exist_ok=True)
        preview_filename = f"seedvr2_preview_{safe_node_id}.png"
        preview_path = preview_root / preview_filename
        temporary_path = preview_path.with_name(
            f".{preview_filename}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        image.save(temporary_path, format="PNG")
        os.replace(temporary_path, preview_path)
        payload = {
            "node": str(unique_id),
            "text": (
                f"当前第 {int(segment)} 段："
                f"{int(start_frame)}-{int(end_frame)}/{int(total_frames)} 帧"
            ),
            "preview_filename": preview_filename,
            "segment": int(segment),
            "total_segments": int(total_segments),
            "start_frame": int(start_frame),
            "end_frame": int(end_frame),
            "total_frames": int(total_frames),
            "completed_seconds": max(0.0, float(completed_seconds)),
            "completed_frames": max(0, int(completed_frames)),
            "context_start_frame": int(context_start_frame or start_frame),
            "context_end_frame": int(context_end_frame or end_frame),
        }
        if completed_frames > 0 and completed_seconds > 0:
            seconds_per_frame = float(completed_seconds) / int(completed_frames)
            payload["seconds_per_frame"] = seconds_per_frame
            payload["eta_seconds"] = seconds_per_frame * max(
                0,
                int(total_frames) - int(completed_frames),
            )
        # gjj_node_progress is already used by the status text and is known to
        # pass through every supported ComfyUI frontend/proxy.  Keep the
        # dedicated event too for older cached versions of this extension.
        PromptServer.instance.send_sync("gjj_node_progress", payload)
        PromptServer.instance.send_sync("gjj_seedvr2_segment_preview", payload)
    except Exception as exc:
        print(f"[GJJ SeedVR2] 当前段首帧预览生成失败：{exc}")


def _get_seedvr2_model_options() -> tuple[list[str], list[str]]:
    dit_models = _ordered_model_choices(DEFAULT_DIT_MODEL, want_vae=False)
    vae_models = _ordered_model_choices(DEFAULT_VAE_MODEL, want_vae=True)

    try:
        runtime_parent = str(_seedvr2_runtime_root().parent)
        if runtime_parent not in sys.path:
            sys.path.insert(0, runtime_parent)

        constants = importlib.import_module("seedvr2_runtime.src.utils.constants")
        discovered = constants.get_all_model_files()
        for filename in sorted(discovered.keys()):
            lowered = filename.lower()
            if not lowered.endswith(".safetensors"):
                continue
            if "vae" in lowered:
                if filename not in vae_models:
                    vae_models.append(filename)
            else:
                if filename not in dit_models:
                    dit_models.append(filename)
    except Exception:
        pass

    return dit_models, vae_models


@lru_cache(maxsize=1)
def _get_seedvr2_api() -> dict[str, Any]:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

    runtime_parent = str(_seedvr2_runtime_root().parent)
    if runtime_parent not in sys.path:
        sys.path.insert(0, runtime_parent)

    try:
        runtime_package = "seedvr2_runtime.src"
        model_registry = importlib.import_module(f"{runtime_package}.utils.model_registry")
        constants = importlib.import_module(f"{runtime_package}.utils.constants")
        debug_module = importlib.import_module(f"{runtime_package}.utils.debug")
        generation_phases = importlib.import_module(f"{runtime_package}.core.generation_phases")
        generation_utils = importlib.import_module(f"{runtime_package}.core.generation_utils")
        memory_manager = importlib.import_module(f"{runtime_package}.optimization.memory_manager")
    except Exception as exc:
        err = RuntimeError("无法导入 GJJ 内置 SeedVR2 运行时。")
        setattr(err, "_gjj_original_error", str(exc))
        raise err from exc

    return {
        "DEFAULT_DIT": getattr(model_registry, "DEFAULT_DIT", DEFAULT_DIT_MODEL),
        "DEFAULT_VAE": getattr(model_registry, "DEFAULT_VAE", DEFAULT_VAE_MODEL),
        "get_base_cache_dir": constants.get_base_cache_dir,
        "Debug": debug_module.Debug,
        "encode_all_batches": generation_phases.encode_all_batches,
        "upscale_all_batches": generation_phases.upscale_all_batches,
        "decode_all_batches": generation_phases.decode_all_batches,
        "postprocess_all_batches": generation_phases.postprocess_all_batches,
        "setup_generation_context": generation_utils.setup_generation_context,
        "prepare_runner": generation_utils.prepare_runner,
        "compute_generation_info": generation_utils.compute_generation_info,
        "log_generation_start": generation_utils.log_generation_start,
        "load_text_embeddings": generation_utils.load_text_embeddings,
        "script_directory": generation_utils.script_directory,
        "cleanup_text_embeddings": memory_manager.cleanup_text_embeddings,
        "complete_cleanup": memory_manager.complete_cleanup,
        "get_device_list": memory_manager.get_device_list,
    }


def _safe_option_list(getter, fallback: list[str]) -> list[str]:
    try:
        values = list(getter())
    except Exception:
        values = []
    return values or fallback


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _coerce_media_to_image_batch(value: Any) -> tuple[torch.Tensor, Any, float | None, str]:
    if value is None:
        raise RuntimeError("请连接输入媒体：支持 GJJ_BATCH_IMAGE、IMAGE 或 VIDEO。")

    source = value
    source_audio = None
    source_fps: float | None = None
    output_mode = "image"
    if hasattr(source, "get_components"):
        try:
            components = source.get_components()
        except Exception as exc:
            raise RuntimeError(f"输入可识别为 VIDEO，但读取视频帧失败：{exc}") from exc
        source = _component_value(components, "images")
        source_audio = _component_value(components, "audio")
        fps = _component_value(components, "frame_rate")
        try:
            source_fps = float(fps)
        except Exception:
            source_fps = None
        output_mode = "video"
    elif hasattr(source, "images"):
        source = getattr(source, "images", None)

    if isinstance(source, torch.Tensor):
        tensor = source
    elif isinstance(source, dict):
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = source.get(key)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
    elif isinstance(source, (list, tuple)) and source and all(isinstance(item, torch.Tensor) for item in source):
        tensor = torch.cat([item if item.ndim == 4 else item.unsqueeze(0) for item in source], dim=0)
    else:
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = getattr(source, key, None)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break

    if tensor is None:
        raise RuntimeError(f"输入不是有效的 GJJ_BATCH_IMAGE / IMAGE / VIDEO：{type(value).__name__}。")
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"输入图片/视频帧必须是 [B,H,W,C] 或 [B,C,H,W]，实际为 {tuple(tensor.shape)}。")
    if tensor.shape[-1] not in (1, 3, 4) and tensor.shape[1] in (1, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 4:
        tensor = tensor[..., :3]
    elif channels > 4:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"输入图片/视频帧通道数无效：{tuple(tensor.shape)}。")
    tensor = tensor.detach()
    if tensor.dtype == torch.float32 and tensor.is_contiguous():
        # Comfy IMAGE/VIDEO frames are already normalized float32.  Repeating
        # float()+clamp()+contiguous() here duplicated the complete source video.
        normalized = tensor
    else:
        normalized = tensor.to(dtype=torch.float32).clamp_(0.0, 1.0).contiguous()
    return normalized, source_audio, source_fps, output_mode


def _model_category_root_for(model_name: str) -> Path | None:
    try:
        full_path = folder_paths.get_full_path(MODEL_CATEGORY, model_name)
    except Exception:
        full_path = None
    if not full_path:
        return None
    full = Path(full_path).resolve()
    try:
        roots = [Path(path).resolve() for path in folder_paths.get_folder_paths(MODEL_CATEGORY)]
    except Exception:
        roots = []
    for root in roots:
        try:
            full.relative_to(root)
            return root
        except Exception:
            continue
    return full.parent


def _seedvr2_model_dir(api: dict[str, Any], dit_model: str, vae_model: str) -> Any:
    dit_root = _model_category_root_for(dit_model)
    vae_root = _model_category_root_for(vae_model)
    if dit_root is not None and vae_root is not None and dit_root == vae_root:
        return str(dit_root)
    return api["get_base_cache_dir"]()


def _raise_seedvr2_runtime_error(original_error: str, unique_id=None):
    missing_runtime = _missing_runtime_specs()
    report = build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=missing_runtime,
        install_packages=[] if missing_runtime else None,
        description=(
            "GJJ 内置 SeedVR2 运行时文件缺失，请重新下载或更新 GJJ 扩展。"
            if missing_runtime
            else "GJJ 内置 SeedVR2 运行时加载失败，请确认已安装 GJJ requirements.txt 中的基础 Python 依赖。"
        ),
        original_error=original_error,
    )
    report["install_cmd"] = ""
    report["copy_text"] = ""
    report["copy_label"] = ""
    print_dependency_model_report(report, title="GJJ SeedVR2 运行时缺失")
    send_dependency_model_notice(report, unique_id=unique_id)
    err = RuntimeError(report.get("warning_message") or "SeedVR2 运行时缺失")
    setattr(err, "gjj_report", report)
    raise err


def _resolve_seedvr2_model_path(model_name: str, label: str) -> Path:
    _ensure_seedvr2_model_folder()
    try:
        full_path = folder_paths.get_full_path(MODEL_CATEGORY, str(model_name))
    except Exception:
        full_path = None
    if not full_path or not Path(full_path).is_file():
        raise RuntimeError(f"未在 {MODEL_SUBDIR} 中找到{label}：{model_name}")
    return Path(full_path)


def _dequantize_seedvr2_vae_convrot(sd: dict[str, Any]) -> int:
    """Restore the eight W4A4 attention matrices unsupported by the core VAE loader."""
    quantized = [str(key)[:-12] for key in sd if str(key).endswith(".comfy_quant")]
    if not quantized:
        return 0
    try:
        from .gjj_video_universal_model_loader import _dequantize_convrot_weight_tensor
    except ImportError:
        from nodes.gjj_video_universal_model_loader import _dequantize_convrot_weight_tensor
    restored_count = 0
    for prefix in quantized:
        weight = sd.get(f"{prefix}.weight")
        if weight is None or getattr(weight, "ndim", 0) != 2:
            continue
        out_features = int(weight.shape[0])
        # ConvRot W4A4 packs two signed int4 values into each stored column.
        in_features = int(weight.shape[1]) * 2
        restored = _dequantize_convrot_weight_tensor(
            sd, prefix, (out_features, in_features), torch.float16,
        )
        if restored is None:
            continue
        sd[f"{prefix}.weight"] = restored
        sd.pop(f"{prefix}.weight_scale", None)
        sd.pop(f"{prefix}.comfy_quant", None)
        restored_count += 1
    if restored_count != len(quantized):
        raise RuntimeError(
            f"SeedVR2 ConvRot VAE 量化层还原不完整：需要 {len(quantized)} 层，成功 {restored_count} 层。"
        )
    return restored_count


def _load_official_seedvr2_components(dit_model: str, vae_model: str):
    """Load the same MODEL/VAE objects used by ComfyUI's official workflow."""
    import comfy.sd
    import comfy.utils

    dit_path = _resolve_seedvr2_model_path(dit_model, "SeedVR2 主模型")
    vae_path = _resolve_seedvr2_model_path(vae_model, "SeedVR2 VAE")
    dit_sd, dit_metadata = comfy.utils.load_torch_file(str(dit_path), return_metadata=True)
    required_conditioning = ("positive_conditioning", "negative_conditioning")
    if not all(key in dit_sd for key in required_conditioning):
        missing = ", ".join(key for key in required_conditioning if key not in dit_sd)
        raise RuntimeError(
            f"所选模型不是 ComfyUI SeedVR2 完整格式：{dit_model}。"
            f"缺少必需张量：{missing}。请使用 Comfy-Org/SeedVR2 完整模型，"
            "或将转换模型重新封装为包含这两个条件张量的完整文件。"
        )
    if "int4_convrot" in dit_path.name.lower():
        try:
            from .gjj_video_universal_model_loader import _patch_int4_convrot_embedding_tensors
        except ImportError:
            from nodes.gjj_video_universal_model_loader import _patch_int4_convrot_embedding_tensors
        _patch_int4_convrot_embedding_tensors(dit_sd)
    model = comfy.sd.load_diffusion_model_state_dict(dit_sd, model_options={}, metadata=dit_metadata)
    if model is None:
        raise RuntimeError(f"ComfyUI 无法识别 SeedVR2 主模型：{dit_model}")
    del dit_sd, dit_metadata
    gc.collect()
    vae_sd, vae_metadata = comfy.utils.load_torch_file(str(vae_path), return_metadata=True)
    _dequantize_seedvr2_vae_convrot(vae_sd)
    vae = comfy.sd.VAE(sd=vae_sd, metadata=vae_metadata)
    vae.throw_exception_if_invalid()
    del vae_sd, vae_metadata
    gc.collect()
    # ComfyUI 0.28 creates VAEs with CoreModelPatcher unconditionally.  When a
    # chunked dynamic DiT is replaced by that dynamic VAE, free_memory() can
    # iterate stale current_loaded_models indices.  SeedVR2's VAE is small
    # enough to use the stable non-dynamic patcher without compromising DiT
    # low-VRAM loading.
    from comfy.model_patcher import ModelPatcher

    dynamic_vae_patcher = vae.patcher
    vae.patcher = ModelPatcher(
        vae.first_stage_model,
        load_device=dynamic_vae_patcher.load_device,
        offload_device=dynamic_vae_patcher.offload_device,
    )
    return model, vae


def _try_resident_seedvr2_components(
    components: tuple[Any, Any],
    *,
    model_offload_device: str,
    unique_id: Any = None,
) -> bool:
    """Keep both SeedVR2 patchers fully loaded when offloading is disabled."""
    if str(model_offload_device or "none").strip().lower() != "none":
        return False
    if not torch.cuda.is_available():
        return False

    model, vae = components
    try:
        import comfy.model_management as model_management

        _send_status(unique_id, "2/6 将 SeedVR2 主模型与 VAE 完整驻留显存...")
        model_management.load_models_gpu(
            [model, vae.patcher],
            force_full_load=True,
        )
        _send_status(unique_id, "2/6 SeedVR2 主模型与 VAE 已全部驻留显存。")
        return True
    except (torch.cuda.OutOfMemoryError, RuntimeError) as exc:
        # A failed forced load can leave partially loaded patchers behind.
        # Restore ComfyUI's normal lazy model scheduling before continuing.
        try:
            model_management.unload_all_models()
            model_management.soft_empty_cache()
        except Exception:
            pass
        if isinstance(exc, torch.cuda.OutOfMemoryError) or "out of memory" in str(exc).lower():
            _send_status(unique_id, "显存不足以全部驻留，已自动恢复 ComfyUI 动态调度。")
            return False
        raise


def _resize_for_seedvr2(images: torch.Tensor, resolution: int, max_resolution: int) -> torch.Tensor:
    from comfy.utils import common_upscale

    height, width = int(images.shape[1]), int(images.shape[2])
    short_edge = max(2, min(height, width))
    scale = max(2, int(resolution)) / short_edge
    target_h = max(2, round(height * scale))
    target_w = max(2, round(width * scale))
    longest = max(target_h, target_w)
    if int(max_resolution) > 0 and longest > int(max_resolution):
        cap_scale = int(max_resolution) / longest
        target_h = max(2, round(target_h * cap_scale))
        target_w = max(2, round(target_w * cap_scale))
    target_h += target_h % 2
    target_w += target_w % 2
    samples = images.movedim(-1, 1)
    return common_upscale(samples, target_w, target_h, "lanczos", "disabled").movedim(1, -1)


def _smart_decode_tile_geometry(
    width: int,
    height: int,
    maximum_tile: int,
    overlap: int,
    alignment: int,
) -> tuple[int, int, int]:
    alignment = max(1, int(alignment))
    maximum_tile = max(alignment, (int(maximum_tile) // alignment) * alignment)
    overlap = max(0, min(int(overlap), maximum_tile - alignment))

    def minimum_for_axis(length: int) -> int:
        length = max(alignment, int(length))
        if length <= maximum_tile:
            return ((length + alignment - 1) // alignment) * alignment
        stride = max(alignment, maximum_tile - overlap)
        tile_count = max(2, (length - overlap + stride - 1) // stride)
        required = (length + (tile_count - 1) * overlap + tile_count - 1) // tile_count
        return min(maximum_tile, ((required + alignment - 1) // alignment) * alignment)

    tile_width = minimum_for_axis(width)
    tile_height = minimum_for_axis(height)
    return max(tile_width, tile_height), tile_width, tile_height


def _run_official_seedvr2_flow(
    images: torch.Tensor,
    *,
    dit_model: str,
    vae_model: str,
    resolution: int,
    max_resolution: int,
    seed: int,
    encode_tiled: bool,
    encode_tile_size: int,
    encode_tile_overlap: int,
    decode_tiled: Any,
    decode_tile_size: int,
    decode_tile_overlap: int,
    color_correction: str,
    is_video: bool,
    video_chunk_mode: str,
    frames_per_chunk: int,
    temporal_overlap: int,
    vae_temporal_size: int,
    vae_temporal_overlap: int,
    tensor_offload_device: str,
    loaded_components: tuple[Any, Any] | None = None,
    unique_id: Any = None,
) -> torch.Tensor:
    """Execute the official SeedVR2 graph in-process, without third-party nodes."""
    from comfy_extras.nodes_seedvr import (
        SeedVR2Conditioning,
        SeedVR2PostProcessing,
        SeedVR2Preprocess,
        SeedVR2TemporalChunk,
        SeedVR2TemporalMerge,
    )
    from nodes import KSampler, VAEDecode, VAEDecodeTiled, VAEEncode, VAEEncodeTiled

    _send_status(unique_id, "2/6 加载官方 SeedVR2 模型...")
    model, vae = loaded_components or _load_official_seedvr2_components(dit_model, vae_model)
    resized = _resize_for_seedvr2(images, resolution, max_resolution)

    _send_status(unique_id, "3/6 官方预处理与 VAE 编码...")
    prepared = SeedVR2Preprocess.execute(resized)[0]
    if encode_tiled:
        latent = VAEEncodeTiled().encode(
            vae, prepared, int(encode_tile_size), int(encode_tile_overlap),
            temporal_size=int(vae_temporal_size), temporal_overlap=int(vae_temporal_overlap),
        )[0]
    else:
        latent = VAEEncode().encode(vae, prepared)[0]

    mode = str(video_chunk_mode)
    use_chunks = bool(is_video and mode != "关闭" and latent["samples"].shape[2] > 1)
    if use_chunks:
        chunking_mode = {"chunking_mode": "auto"}
        if mode == "手动":
            chunking_mode = {"chunking_mode": "manual", "frames_per_chunk": int(frames_per_chunk)}
        latent_chunks, effective_overlap = SeedVR2TemporalChunk.execute(
            latent, int(temporal_overlap), chunking_mode,
        ).result
    else:
        latent_chunks, effective_overlap = [latent], 0

    sampled_chunks = []
    total_chunks = len(latent_chunks)
    for index, latent_chunk in enumerate(latent_chunks, start=1):
        _send_status(unique_id, f"4/6 构建条件并采样视频段 {index}/{total_chunks}...")
        positive, negative = SeedVR2Conditioning.execute(model, latent_chunk).result
        sampled_chunks.append(KSampler().sample(
            model, int(seed) + index - 1, 1, 1.0, "euler", "simple",
            positive, negative, latent_chunk, denoise=1.0,
        )[0])
    if len(sampled_chunks) > 1:
        sampled = SeedVR2TemporalMerge.execute(sampled_chunks, [effective_overlap])[0]
    else:
        sampled = sampled_chunks[0]

    _send_status(unique_id, "5/6 VAE 分块解码...")
    decode_mode = (
        "开启" if decode_tiled is True
        else "关闭" if decode_tiled is False
        else str(decode_tiled or "智能").strip()
    )
    use_tiled_decode = decode_mode != "关闭"
    effective_decode_tile_size = int(decode_tile_size)
    if decode_mode in ("智能", "自动"):
        target_height, target_width = int(resized.shape[1]), int(resized.shape[2])
        try:
            alignment = max(64, int(vae.spacial_compression_decode()) * 8)
        except Exception:
            alignment = 64
        effective_decode_tile_size, minimum_tile_width, minimum_tile_height = _smart_decode_tile_geometry(
            target_width,
            target_height,
            int(decode_tile_size),
            int(decode_tile_overlap),
            alignment,
        )
        use_tiled_decode = max(target_width, target_height) > effective_decode_tile_size
        _send_status(
            unique_id,
            (
                f"5/6 智能解码：目标 {target_width}×{target_height}，"
                f"最小块 {minimum_tile_width}×{minimum_tile_height}，"
                f"实际方块 {effective_decode_tile_size}，对齐 {alignment}。"
            ) if use_tiled_decode else (
                f"5/6 智能解码：目标 {target_width}×{target_height} 可整图解码，跳过空间分块。"
            ),
        )
    if use_tiled_decode:
        decoded = VAEDecodeTiled().decode(
            vae, sampled, effective_decode_tile_size, int(decode_tile_overlap),
            temporal_size=int(vae_temporal_size), temporal_overlap=int(vae_temporal_overlap),
        )[0]
    else:
        decoded = VAEDecode().decode(vae, sampled)[0]

    correction = str(color_correction)
    if correction == "wavelet_adaptive" or correction == "hsv":
        correction = "wavelet"
    if correction not in ("lab", "wavelet", "adain", "none"):
        correction = "none"
    if not is_video:
        result = SeedVR2PostProcessing.execute(decoded, resized, correction)[0]
        del decoded, resized, prepared, latent, latent_chunks, sampled_chunks, sampled
        return result

    # Post-processing a complete long video creates another full float32 copy
    # beside decoded + resized.  At 2K that copy alone can consume tens of GB.
    # Write small processed slices directly to a float16 result buffer instead.
    requested_output_device = str(tensor_offload_device or "none")
    if requested_output_device == "none":
        requested_output_device = "cpu"
    output_device = torch.device(requested_output_device)
    # Temporal VAE alignment may decode one padded frame beyond the source
    # sequence (for example 41 decoded frames for 40 resized source frames).
    # Post-processing pairs both tensors frame-by-frame, so only process the
    # common range and never reserve a larger destination slice than it can
    # actually return.
    frame_count = min(int(decoded.shape[0]), int(resized.shape[0]))
    postprocess_chunk = max(1, min(16, int(vae_temporal_size)))
    result = None
    for start in range(0, frame_count, postprocess_chunk):
        end = min(frame_count, start + postprocess_chunk)
        _send_status(
            unique_id,
            f"5/6 分段后处理并写入{('显存' if output_device.type == 'cuda' else '内存')} "
            f"{end}/{frame_count}...",
        )
        processed = SeedVR2PostProcessing.execute(
            decoded[start:end],
            resized[start:end],
            correction,
        )[0]
        if result is None:
            # The VAE may decode to an aligned size (for example 1088 high)
            # while SeedVR2 post-processing crops back to the requested 1080.
            # Allocate from the real post-processed geometry, not decoded.
            result = torch.empty(
                (frame_count, *tuple(processed.shape[1:])),
                dtype=torch.float16,
                device=output_device,
            )
        result[start:end].copy_(
            processed.to(device=output_device, dtype=torch.float16),
        )
        del processed

    del decoded, resized, prepared, latent, latent_chunks, sampled_chunks, sampled
    if result is None:
        raise RuntimeError("SeedVR2 后处理没有生成任何视频帧。")
    return result


def _stream_source_path(video: Any) -> Path | None:
    getter = getattr(video, "get_stream_source", None)
    if not callable(getter):
        return None
    try:
        source = getter()
    except Exception:
        return None
    if not isinstance(source, (str, Path)):
        return None
    path = Path(source).resolve()
    return path if path.is_file() else None


def _resolve_local_media_file(value: str | Path | None) -> Path | None:
    text = str(value or "").strip()
    if not text:
        return None
    direct = Path(text).expanduser()
    if direct.is_file():
        return direct.resolve()
    try:
        annotated = Path(folder_paths.get_annotated_filepath(text))
    except Exception:
        annotated = Path(folder_paths.get_input_directory()) / text
    return annotated.resolve() if annotated.is_file() else None


def _load_local_media(path: Path) -> Any:
    if path.suffix.lower() in {
        ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".wmv", ".flv",
        ".mpeg", ".mpg", ".gif",
    }:
        return InputImpl.VideoFromFile(str(path))
    import numpy as np
    from PIL import Image, ImageOps

    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        array = np.asarray(image).astype(np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0).contiguous()


def _replace_media_file(path: Path, value: Any) -> Any:
    temporary = path.with_name(f".{path.stem}.gjj-upscaled-{uuid.uuid4().hex}{path.suffix}")
    try:
        if isinstance(value, torch.Tensor):
            import numpy as np
            from PIL import Image

            image = value[0].detach().to(device="cpu", dtype=torch.float32).clamp(0, 1)
            array = (image.numpy() * 255.0).round().astype(np.uint8)
            Image.fromarray(array).save(temporary)
        else:
            value.save_to(str(temporary))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    if isinstance(value, torch.Tensor):
        return value
    return InputImpl.VideoFromFile(str(path))


def _stream_target_dimensions(
    video: Any,
    resolution: int,
    max_resolution: int,
) -> tuple[int, int]:
    """Estimate the real SeedVR2 output geometry without decoding video frames."""
    try:
        width, height = video.get_dimensions()
        width, height = int(width), int(height)
    except Exception:
        width, height = int(resolution), int(resolution)
    if width <= 0 or height <= 0:
        width, height = int(resolution), int(resolution)
    scale = max(2, int(resolution)) / max(2, min(width, height))
    target_w = max(2, round(width * scale))
    target_h = max(2, round(height * scale))
    longest = max(target_w, target_h)
    if int(max_resolution) > 0 and longest > int(max_resolution):
        cap_scale = int(max_resolution) / longest
        target_w = max(2, round(target_w * cap_scale))
        target_h = max(2, round(target_h * cap_scale))
    target_w += target_w % 2
    target_h += target_h % 2
    return target_w, target_h


def _smart_stream_chunk_frames(
    video: Any,
    *,
    resolution: int,
    max_resolution: int,
    video_chunk_mode: str,
    frames_per_chunk: int,
    vae_temporal_size: int,
) -> tuple[int, str]:
    """Choose an outer stream segment that amortizes I/O but stays RAM-safe."""
    target_w, target_h = _stream_target_dimensions(video, resolution, max_resolution)
    mpx = max(0.01, target_w * target_h / 1_000_000.0)
    mode = str(video_chunk_mode).strip()

    if mode == "手动":
        sampler_frames = max(1, int(frames_per_chunk))
        basis = f"手动采样段 {sampler_frames} 帧"
    elif mode == "关闭":
        # “关闭” only disables the inner latent split.  The outer stream split
        # is deliberately retained so a long video never becomes one huge tensor.
        # Since there is no second-level safety split, keep each outer segment
        # deliberately small; 17 is a valid 4n+1 SeedVR2 frame count.
        sampler_frames = 17
        basis = "潜空间分块关闭，使用保守的 17 帧流式段"
    else:
        try:
            import comfy.model_management as model_management
            from comfy.ldm.seedvr.constants import (
                SEEDVR2_CHUNK_GIB_PER_MPX_FRAME,
                SEEDVR2_CHUNK_RESERVED_GIB,
                SEEDVR2_CHUNK_SIGMA_GIB,
                SEEDVR2_CHUNK_SIGMA_K,
            )

            device = model_management.get_torch_device()
            free_gb = model_management.get_free_memory(device) / (1024 ** 3)
            budget_gb = (
                free_gb
                - SEEDVR2_CHUNK_RESERVED_GIB
                - SEEDVR2_CHUNK_SIGMA_K * SEEDVR2_CHUNK_SIGMA_GIB
            )
            latent_frames = max(
                1,
                int(budget_gb / (SEEDVR2_CHUNK_GIB_PER_MPX_FRAME * mpx)),
            )
            sampler_frames = max(1, 4 * (latent_frames - 1) + 1)
            basis = f"可用显存 {free_gb:.1f} GB，单次采样约 {sampler_frames} 帧"
        except Exception:
            sampler_frames = max(17, int(frames_per_chunk))
            basis = f"显存信息不可用，回退 {sampler_frames} 帧"

    # Keep one sampler-sized outer segment.  Making the outer segment larger
    # does not make DiT sampling cheaper (it is split again internally), while
    # VAE encode/decode and post-processing still operate on the whole outer
    # segment and can pin VRAM at 100% for a very long time.
    minimum_frames = 1 if mode == "手动" else 9
    desired = max(minimum_frames, sampler_frames)
    try:
        import psutil

        available_bytes = int(psutil.virtual_memory().available)
        estimated_bytes_per_frame = max(1, target_w * target_h * 3 * 4 * 4)
        ram_cap = max(minimum_frames, int(available_bytes * 0.20 / estimated_bytes_per_frame))
    except Exception:
        ram_cap = 161
    core_frames = min(desired, ram_cap, 161)
    # Keep SeedVR's required 4n+1 temporal alignment.
    if core_frames <= 1:
        core_frames = 1
    else:
        core_frames = max(5 if mode == "手动" else 9, 4 * ((core_frames - 1) // 4) + 1)
    detail = (
        f"{target_w}×{target_h}，{basis}；"
        f"外层每段 {core_frames} 帧（内存安全上限 {ram_cap} 帧）"
    )
    return core_frames, detail


def _begin_segment_resource_sample() -> torch.device | None:
    if not torch.cuda.is_available():
        return None
    try:
        device = torch.device("cuda", torch.cuda.current_device())
        torch.cuda.reset_peak_memory_stats(device)
        return device
    except Exception:
        return None


def _segment_resource_pressure(device: torch.device | None) -> tuple[float, float]:
    vram_pressure = 0.0
    if device is not None:
        try:
            torch.cuda.synchronize(device)
            total = torch.cuda.get_device_properties(device).total_memory
            # Reserved memory includes PyTorch's reusable cache.  Using it here
            # makes a healthy, fully utilized GPU look permanently "100% full"
            # and prevents later segments from growing.  Allocated is the real
            # tensor peak produced by this segment.
            vram_pressure = torch.cuda.max_memory_allocated(device) / max(1, total)
        except Exception:
            vram_pressure = 0.0
    try:
        import psutil

        ram_pressure = float(psutil.virtual_memory().percent) / 100.0
    except Exception:
        ram_pressure = 0.0
    return vram_pressure, ram_pressure


def _next_adaptive_segment_frames(
    current: int,
    target: int,
    vram_pressure: float,
    ram_pressure: float,
    minimum: int = 9,
) -> int:
    pressure = max(float(vram_pressure), float(ram_pressure))
    if pressure >= 0.97:
        candidate = max(minimum, current - 8)
    elif pressure >= 0.94:
        candidate = max(minimum, current - 4)
    elif pressure <= 0.88:
        candidate = min(target, current + 4)
    else:
        candidate = current
    candidate = min(candidate, target)
    return max(minimum, 4 * max(1, (candidate - 1) // 4) + 1)


def _run_streaming_video_upscale(
    video: Any,
    *,
    dit_model: str,
    vae_model: str,
    resolution: int,
    max_resolution: int,
    seed: int,
    encode_tiled: bool,
    encode_tile_size: int,
    encode_tile_overlap: int,
    decode_tiled: Any,
    decode_tile_size: int,
    decode_tile_overlap: int,
    color_correction: str,
    video_chunk_mode: str,
    frames_per_chunk: int,
    temporal_overlap: int,
    vae_temporal_size: int,
    vae_temporal_overlap: int,
    model_offload_device: str,
    tensor_offload_device: str,
    unique_id: Any,
    replace_path: Path | None = None,
) -> Any | None:
    source_path = _stream_source_path(video)
    trim_getter = getattr(video, "get_active_trim_window", None)
    trim_factory = getattr(video, "as_trimmed", None)
    if source_path is None or not callable(trim_factory):
        return None

    fps = float(video.get_frame_rate())
    duration = float(video.get_duration())
    if fps <= 0 or duration <= 0:
        return None
    trim_start = 0.0
    if callable(trim_getter):
        try:
            trim_start = float(trim_getter()[0])
        except Exception:
            trim_start = 0.0

    try:
        total_frames = max(1, int(video.get_frame_count()))
    except Exception:
        total_frames = max(1, int(round(duration * fps)))
    target_core_frames, chunk_detail = _smart_stream_chunk_frames(
        video,
        resolution=resolution,
        max_resolution=max_resolution,
        video_chunk_mode=video_chunk_mode,
        frames_per_chunk=frames_per_chunk,
        vae_temporal_size=vae_temporal_size,
    )
    chunk_mode = str(video_chunk_mode).strip()
    adaptive = chunk_mode != "手动"
    adaptive_minimum = 5
    # The old adaptive path always started at five frames and grew by four.
    # With temporal context on both sides, those probe segments could process
    # nearly three times as many frames as they emitted.  The target has
    # already been bounded by both the official SeedVR2 VRAM estimate and the
    # available system RAM, so start there and only shrink after observing
    # genuine resource pressure.
    core_frames = target_core_frames
    _send_status(
        unique_id,
        f"智能视频分段：按显存与内存预算从 {core_frames} 帧开始；{chunk_detail}"
        if adaptive else f"手动视频分段：固定 {core_frames} 帧",
    )
    output_root = Path(folder_paths.get_temp_directory()).resolve() / "GJJ" / "seedvr2_stream"
    output_root.mkdir(parents=True, exist_ok=True)
    final_path = output_root / f"seedvr2_{uuid.uuid4().hex}.mp4"

    try:
        from .gjj_video_combine_runtime import get_ffmpeg_path
    except ImportError:
        from nodes.gjj_video_combine_runtime import get_ffmpeg_path
    ffmpeg_value = get_ffmpeg_path()
    if not ffmpeg_value:
        raise RuntimeError("未找到 ffmpeg，无法拼接 SeedVR2 流式视频分段。")
    ffmpeg = str(ffmpeg_value)
    loaded_components = _load_official_seedvr2_components(dit_model, vae_model)
    _try_resident_seedvr2_components(
        loaded_components,
        model_offload_device=model_offload_device,
        unique_id=unique_id,
    )

    with tempfile.TemporaryDirectory(prefix="gjj_seedvr2_") as temp_name:
        temp_root = Path(temp_name)
        segment_paths: list[Path] = []
        segment_index = 0
        core_start_frame = 0
        completed_processing_seconds = 0.0
        best_seconds_per_frame: float | None = None
        best_core_frames = core_frames
        while core_start_frame < total_frames:
            segment_started_at = time.perf_counter()
            segment_index += 1
            core_end_frame = min(total_frames, core_start_frame + core_frames)
            # One latent overlap corresponds to four source frames.  Reusing
            # the full VAE temporal overlap here duplicated as many as eight
            # source frames on *each* side even though VAE tiling already
            # handles its own internal overlap.  Four source frames is enough
            # boundary context for the default one-latent overlap.
            requested_overlap_frames = max(
                int(temporal_overlap) * 4,
                min(4, int(vae_temporal_overlap)),
            )
            # Streaming overlap is inference context, not duplicated output.
            # A five-frame probe previously produced core_frames // 8 == 0,
            # leaving the first boundary without temporal context.
            overlap_frames = (
                min(max(1, core_frames - 1), requested_overlap_frames)
                if requested_overlap_frames > 0
                else 0
            )
            total_segments = segment_index + (
                total_frames - core_end_frame + core_frames - 1
            ) // core_frames
            load_start_frame = max(0, core_start_frame - overlap_frames)
            load_end_frame = min(total_frames, core_end_frame + overlap_frames)
            load_start = load_start_frame / fps
            load_duration = (load_end_frame - load_start_frame) / fps
            _send_status(
                unique_id,
                f"流式分段 {segment_index}/{total_segments}："
                f"读取 {load_start_frame + 1}-{load_end_frame} 帧...",
            )
            trimmed = video.as_trimmed(load_start, load_duration, strict_duration=False)
            if trimmed is None:
                raise RuntimeError(f"无法读取 SeedVR2 视频分段：{load_start:.3f}s + {load_duration:.3f}s")
            components = trimmed.get_components()
            frames = _component_value(components, "images")
            if not isinstance(frames, torch.Tensor) or frames.shape[0] == 0:
                raise RuntimeError(f"SeedVR2 视频分段 {segment_index} 没有可用画面。")
            sample_device = _begin_segment_resource_sample() if adaptive else None
            try:
                sample = _run_official_seedvr2_flow(
                    frames,
                    dit_model=dit_model,
                    vae_model=vae_model,
                    resolution=resolution,
                    max_resolution=max_resolution,
                    seed=seed,
                    encode_tiled=encode_tiled,
                    encode_tile_size=encode_tile_size,
                    encode_tile_overlap=encode_tile_overlap,
                    decode_tiled=decode_tiled,
                    decode_tile_size=decode_tile_size,
                    decode_tile_overlap=decode_tile_overlap,
                    color_correction=color_correction,
                    is_video=True,
                    video_chunk_mode=video_chunk_mode,
                    frames_per_chunk=frames_per_chunk,
                    temporal_overlap=temporal_overlap,
                    vae_temporal_size=vae_temporal_size,
                    vae_temporal_overlap=vae_temporal_overlap,
                    # A completed streaming segment is immediately encoded to a
                    # temporary video, so retaining its output tensor on the GPU
                    # only steals VRAM from the next segment.
                    tensor_offload_device="cpu",
                    loaded_components=loaded_components,
                    unique_id=unique_id,
                )
            except torch.cuda.OutOfMemoryError:
                # Budget estimates can be optimistic when another workflow is
                # occupying VRAM.  Preserve the fast start, but retry the same
                # output range at roughly half length instead of failing.
                retry_frames = max(adaptive_minimum, 4 * max(1, ((core_frames // 2) - 1) // 4) + 1)
                if not adaptive or retry_frames >= core_frames:
                    raise
                del components, frames, trimmed
                gc.collect()
                torch.cuda.empty_cache()
                core_frames = retry_frames
                segment_index -= 1
                _send_status(unique_id, f"显存不足，自动缩短为 {core_frames} 帧并重试当前分段...")
                continue
            left_trim = core_start_frame - load_start_frame
            wanted = core_end_frame - core_start_frame
            sample = sample[left_trim:left_trim + wanted]
            # Show the actual upscaled first frame after this segment finishes.
            # The fixed filename is atomically overwritten so the node panel
            # always monitors the latest completed segment's output quality.
            _send_segment_preview(
                unique_id,
                sample[0],
                segment=segment_index,
                total_segments=total_segments,
                start_frame=core_start_frame + 1,
                end_frame=core_end_frame,
                total_frames=total_frames,
                completed_seconds=(
                    completed_processing_seconds
                    + max(0.0, time.perf_counter() - segment_started_at)
                ),
                completed_frames=core_end_frame,
                context_start_frame=load_start_frame + 1,
                context_end_frame=load_end_frame,
            )
            segment_path = temp_root / f"segment_{segment_index:06d}.mp4"
            segment_video = InputImpl.VideoFromComponents(
                Types.VideoComponents(images=sample, audio=None, frame_rate=Fraction(fps).limit_denominator())
            )
            segment_video.save_to(str(segment_path))
            segment_paths.append(segment_path)
            segment_seconds = time.perf_counter() - segment_started_at
            completed_processing_seconds += segment_seconds
            segment_seconds_per_frame = segment_seconds / max(1, wanted)
            vram_pressure, ram_pressure = _segment_resource_pressure(sample_device)
            previous_core_frames = core_frames
            if adaptive:
                core_frames = _next_adaptive_segment_frames(
                    core_frames,
                    target_core_frames,
                    vram_pressure,
                    ram_pressure,
                    adaptive_minimum,
                )
                if (
                    best_seconds_per_frame is not None
                    and previous_core_frames > best_core_frames
                    and segment_seconds_per_frame > best_seconds_per_frame * 1.10
                ):
                    # A larger segment can be slower despite fitting in memory
                    # when it triggers model/activation swapping.  Prefer the
                    # empirically faster size rather than chasing VRAM usage.
                    core_frames = best_core_frames
                elif (
                    best_seconds_per_frame is None
                    or segment_seconds_per_frame < best_seconds_per_frame * 0.95
                ):
                    best_seconds_per_frame = segment_seconds_per_frame
                    best_core_frames = previous_core_frames
                _send_status(
                    unique_id,
                    f"第 {segment_index} 段完成：显存峰值 {vram_pressure * 100:.1f}% / "
                    f"内存 {ram_pressure * 100:.1f}%，"
                    f"{segment_seconds_per_frame:.2f} 秒/帧，"
                    f"后续段长 {previous_core_frames} → {core_frames} 帧",
                )
            del components, frames, sample, segment_video, trimmed
            # Python ref-counting releases the large per-segment tensors above.
            # Keep CUDA's allocator cache warm between segments: empty_cache()
            # forced expensive allocation/model-transfer churn every time.
            # A periodic cyclic-GC pass is sufficient for long videos.
            if segment_index % 8 == 0:
                gc.collect()
            core_start_frame = core_end_frame

        concat_list = temp_root / "segments.txt"
        concat_list.write_text(
            "".join(f"file '{path.as_posix()}'\n" for path in segment_paths),
            encoding="utf-8",
        )
        silent_path = temp_root / "joined.mp4"
        concat_command = [
            ffmpeg, "-y", "-v", "error", "-f", "concat", "-safe", "0",
            "-i", str(concat_list), "-c", "copy", str(silent_path),
        ]
        completed = subprocess.run(concat_command, capture_output=True, text=True)
        if completed.returncode != 0:
            raise RuntimeError(f"SeedVR2 分段拼接失败：{completed.stderr[-1200:]}")

        mux_command = [
            ffmpeg, "-y", "-v", "error", "-i", str(silent_path),
            "-ss", f"{trim_start:.6f}", "-t", f"{duration:.6f}", "-i", str(source_path),
            "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac",
            "-shortest", str(final_path),
        ]
        completed = subprocess.run(mux_command, capture_output=True, text=True)
        if completed.returncode != 0:
            raise RuntimeError(f"SeedVR2 恢复原音频失败：{completed.stderr[-1200:]}")

    del loaded_components
    gc.collect()
    _send_status(unique_id, f"完成：流式放大 {total_frames} 帧，峰值内存不再随视频长度增长")
    if replace_path is not None:
        replacement = replace_path.with_name(
            f".{replace_path.stem}.gjj-upscaled-{uuid.uuid4().hex}{replace_path.suffix}"
        )
        try:
            shutil.copy2(final_path, replacement)
            os.replace(replacement, replace_path)
        finally:
            replacement.unlink(missing_ok=True)
        return InputImpl.VideoFromFile(str(replace_path))
    return InputImpl.VideoFromFile(str(final_path))


class GJJ_SeedVR2ImageUpscaler:
    CATEGORY = "GJJ/🔍 超分放大"
    FUNCTION = "upscale_image"
    OUTPUT_NODE = True
    DESCRIPTION = _DESCRIPTION_INTRO if _DEPENDENCIES_AVAILABLE else _ENVIRONMENT_REPORT.get("warning_message", _DESCRIPTION_INTRO)
    GJJ_HELP = _GJJ_HELP

    SEARCH_ALIASES = [
        "seedvr2 image upscale",
        "seedvr2 video upscale",
        "seedvr2 upscaler",
        "图片放大",
        "超分",
        "视频放大",
        "seedvr2",
    ]
    RETURN_TYPES = (MEDIA_INPUT_TYPE,)
    RETURN_NAMES = ("放大完成结果",)
    OUTPUT_TOOLTIPS = ("兼容 GJJ_BATCH_IMAGE、IMAGE、VIDEO：输入图像/批量图时输出放大后的图像帧，输入视频时输出放大后的视频并保留原音频与帧率。",)

    @classmethod
    def INPUT_TYPES(cls):
        devices = _get_local_device_list(include_cpu=True)
        offload_devices = _get_local_device_list(include_none=True, include_cpu=True)
        dit_models, vae_models = _get_seedvr2_model_options()
        preferred_device = _preferred_runtime_device()

        result = {
            "required": {
                "common_video_height": (COMMON_VIDEO_HEIGHT_OPTIONS, {
                    "default": "手动输入",
                    "display_name": "目标短边预设",
                    "tooltip": "兼容旧工作流的快捷预设。新节点默认使用“手动输入”，由目标短边字段决定输出尺寸。",
                }),
                "resolution": ("INT", {
                    "default": 1080,
                    "min": 16,
                    "max": 16384,
                    "step": 2,
                    "display_name": "目标短边",
                    "tooltip": "输出图像的目标短边尺寸，自动保持原图比例。",
                }),
                "max_resolution": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 16384,
                    "step": 2,
                    "display_name": "最长边上限",
                    "tooltip": "限制输出图像任一边的最大尺寸；0 表示不限制。",
                }),
                "seed": ("INT", {
                    "default": 42,
                    "min": 0,
                    "max": 2**32 - 1,
                    "control_after_generate": True,
                    "display_name": "随机种子",
                    "tooltip": "相同输入和相同参数下，使用同一随机种子可复现结果。",
                }),
                "dit_model": (dit_models, {
                    "default": _default_model_choice(DEFAULT_DIT_MODEL),
                    "display_name": "放大主模型",
                    "tooltip": "SeedVR2 主超分模型。会按去扩展名、去量化标记后的名称在 models/SEEDVR2 深度搜索，列表第一项作为默认。",
                }),
                "vae_model": (vae_models, {
                    "default": _default_model_choice(DEFAULT_VAE_MODEL),
                    "display_name": "解码模型",
                    "tooltip": "SeedVR2 编码/解码模型。会按去扩展名、去量化标记后的名称在 models/SEEDVR2 深度搜索，列表第一项作为默认。",
                }),
                "device": (devices, {
                    "default": preferred_device,
                    "display_name": "运行设备",
                    "tooltip": "SeedVR2 推理主设备；如存在 cuda:0，默认自动选中 cuda:0，否则使用 cpu。",
                }),
                "model_offload_device": (offload_devices, {
                    "default": "none" if "none" in offload_devices else offload_devices[0],
                    "display_name": "模型卸载设备",
                    "tooltip": "none 会在视频分段期间尝试让 SeedVR2 主模型和 VAE 全部驻留显存；显存不足时会自动恢复动态调度，低显存也可主动设为 cpu。",
                }),
                "tensor_offload_device": (offload_devices, {
                    "default": preferred_device if preferred_device in offload_devices else ("cpu" if "cpu" in offload_devices else offload_devices[0]),
                    "display_name": "张量卸载设备",
                    "tooltip": "中间张量卸载设备；如存在 cuda:0，默认自动选中 cuda:0，否则使用 cpu。",
                }),
                "attention_mode": (["sdpa", "flash_attn_2", "flash_attn_3", "sageattn_2", "sageattn_3"], {
                    "default": "sdpa",
                    "display_name": "注意力模式",
                    "tooltip": "默认 sdpa 最稳；其它模式依赖你的显卡和环境支持。",
                }),
                "blocks_to_swap": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 36,
                    "display_name": "模块交换数量",
                    "tooltip": "低显存优化参数；0 表示关闭。开启时建议同时设置模型卸载设备。",
                }),
                "swap_io_components": ("BOOLEAN", {
                    "default": False,
                    "display_name": "卸载IO组件",
                    "tooltip": "进一步降低显存占用，但可能降低速度。",
                }),
                "encode_tiled": ("BOOLEAN", {
                    "default": False,
                    "display_name": "空间分块编码",
                    "tooltip": "只对画面做空间切块以降低 VAE 编码显存；显存足够时关闭通常更快，与视频时间分段无关。",
                }),
                "encode_tile_size": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 8192,
                    "step": 32,
                    "display_name": "编码分块大小",
                    "tooltip": "VAE 编码阶段的分块大小。",
                }),
                "encode_tile_overlap": ("INT", {
                    "default": 96,
                    "min": 0,
                    "max": 2048,
                    "step": 32,
                    "display_name": "编码分块重叠",
                    "tooltip": "VAE 编码阶段的分块重叠。",
                }),
                "decode_tiled": (["智能", "开启", "关闭"], {
                    "default": "智能",
                    "display_name": "空间分块解码",
                    "tooltip": "智能会根据目标宽高、重叠和 VAE 对齐倍数计算最小安全块；整图能放入上限时自动跳过分块。",
                }),
                "decode_tile_size": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 8192,
                    "step": 32,
                    "display_name": "解码分块上限",
                    "tooltip": "智能模式用作最大允许方块尺寸；实际尺寸会根据目标宽高、重叠和对齐倍数计算。",
                }),
                "decode_tile_overlap": ("INT", {
                    "default": 96,
                    "min": 0,
                    "max": 2048,
                    "step": 32,
                    "display_name": "解码分块重叠",
                    "tooltip": "VAE 解码阶段的分块重叠。",
                }),
                "tile_debug": (["false", "encode", "decode"], {
                    "default": "false",
                    "display_name": "分块调试显示",
                    "tooltip": "调试 VAE 分块边界；正常使用建议保持 false。",
                }),
                "color_correction": (["lab", "wavelet", "wavelet_adaptive", "hsv", "adain", "none"], {
                    "default": "lab",
                    "display_name": "色彩校正",
                    "tooltip": "让放大后的颜色更接近原图；lab 通常最稳。",
                }),
                "input_noise_scale": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.001,
                    "display_name": "输入噪声强度",
                    "tooltip": "对输入图注入微量噪声以缓和压缩瑕疵；默认 0。",
                }),
                "latent_noise_scale": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.001,
                    "display_name": "潜空间噪声强度",
                    "tooltip": "对潜空间结果注入微量噪声；默认 0。",
                }),
                "enable_debug": ("BOOLEAN", {
                    "default": False,
                    "display_name": "开启调试模式",
                    "tooltip": "打印 SeedVR2 的详细执行和显存日志。",
                }),
                "video_chunk_mode": (["智能", "手动", "关闭"], {
                    "default": "智能",
                    "display_name": "视频时间分块",
                    "tooltip": "智能会根据显存和内存预算直接选择高吞吐段长，并按实际压力与秒/帧调整；手动使用“每段视频帧数”；关闭仅关闭段内潜空间切分，长视频仍会安全地流式分段。",
                }),
                "frames_per_chunk": ("INT", {
                    "default": 13,
                    "min": 1,
                    "max": 1001,
                    "step": 4,
                    "display_name": "每段视频帧数",
                    "tooltip": "手动时间分块使用，必须为 4n+1，例如 9、13、21。",
                }),
                "temporal_overlap": ("INT", {
                    "default": 1,
                    "min": 0,
                    "max": 64,
                    "step": 1,
                    "display_name": "潜空间时间重叠",
                    "tooltip": "相邻采样段共享并交叉淡化的潜空间帧数；通常使用 1–2。",
                }),
                "vae_temporal_size": ("INT", {
                    "default": 64,
                    "min": 8,
                    "max": 4096,
                    "step": 4,
                    "display_name": "VAE 时间块大小",
                    "tooltip": "VAE 编码和解码一次处理的时间帧数；默认 64 与官方视频工作流一致，显存紧张时可降为 16–32。",
                }),
                "vae_temporal_overlap": ("INT", {
                    "default": 8,
                    "min": 4,
                    "max": 1024,
                    "step": 4,
                    "display_name": "VAE 时间重叠",
                    "tooltip": "VAE 时间块之间的重叠帧数；通常使用 4–8。",
                }),
                "local_media_file": ("STRING", {
                    "default": "",
                    "display_name": "节点本地媒体",
                    "tooltip": "由 📁 按钮写入；输入媒体接口已连接时忽略。",
                }),
                "save_in_place": ("BOOLEAN", {
                    "default": False,
                    "display_name": "原地保存",
                    "tooltip": "由 ▶️ 按钮临时启用；完成后替换 📁 选择的媒体文件。",
                }),
            },
            "optional": {
                "media": (MEDIA_INPUT_TYPE, {
                    "display_name": "输入媒体",
                    "tooltip": "统一输入口：支持 GJJ_BATCH_IMAGE、普通 IMAGE 批量和官方 VIDEO。接 VIDEO 时会自动提取帧，放大后按原视频帧率与音频重建。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }
        for _name, (_typ, _options) in result["required"].items():
            if isinstance(_options, dict):
                _options["hidden"] = True
                _options["display"] = "hidden"
        return result

    def upscale_image(
        self,
        common_video_height,
        resolution,
        max_resolution,
        seed,
        dit_model,
        vae_model,
        device,
        model_offload_device,
        tensor_offload_device,
        attention_mode,
        blocks_to_swap,
        swap_io_components,
        encode_tiled,
        encode_tile_size,
        encode_tile_overlap,
        decode_tiled,
        decode_tile_size,
        decode_tile_overlap,
        tile_debug,
        color_correction,
        input_noise_scale,
        latent_noise_scale,
        enable_debug,
        video_chunk_mode,
        frames_per_chunk,
        temporal_overlap,
        vae_temporal_size,
        vae_temporal_overlap,
        local_media_file,
        save_in_place,
        media=None,
        unique_id=None,
        **kwargs,
    ):
        if media is None:
            media = kwargs.get("media", None)
        if media is None:
            media = kwargs.get("image", None)
        if media is None:
            media = kwargs.get("video", None)
        local_media_path = None
        if media is None:
            local_media_path = _resolve_local_media_file(local_media_file)
            if local_media_path is not None:
                media = _load_local_media(local_media_path)
        replace_path = local_media_path if bool(save_in_place) else None

        if str(common_video_height) != "手动输入":
            try:
                resolution = int(common_video_height)
            except (TypeError, ValueError):
                pass
        streamed_video = _run_streaming_video_upscale(
            media,
            dit_model=str(dit_model),
            vae_model=str(vae_model),
            resolution=int(resolution),
            max_resolution=int(max_resolution),
            seed=int(seed),
            encode_tiled=bool(encode_tiled),
            encode_tile_size=int(encode_tile_size),
            encode_tile_overlap=int(encode_tile_overlap),
            decode_tiled=decode_tiled,
            decode_tile_size=int(decode_tile_size),
            decode_tile_overlap=int(decode_tile_overlap),
            color_correction=str(color_correction),
            video_chunk_mode=str(video_chunk_mode),
            frames_per_chunk=int(frames_per_chunk),
            temporal_overlap=int(temporal_overlap),
            vae_temporal_size=int(vae_temporal_size),
            vae_temporal_overlap=int(vae_temporal_overlap),
            model_offload_device=str(model_offload_device),
            tensor_offload_device=str(tensor_offload_device),
            unique_id=unique_id,
            replace_path=replace_path,
        )
        if streamed_video is not None:
            return (streamed_video,)

        _send_status(unique_id, "1/6 读取输入媒体...")
        image, source_audio, source_fps, output_mode = _coerce_media_to_image_batch(media)
        sample = _run_official_seedvr2_flow(
            image,
            dit_model=str(dit_model),
            vae_model=str(vae_model),
            resolution=int(resolution),
            max_resolution=int(max_resolution),
            seed=int(seed),
            encode_tiled=bool(encode_tiled),
            encode_tile_size=int(encode_tile_size),
            encode_tile_overlap=int(encode_tile_overlap),
            decode_tiled=decode_tiled,
            decode_tile_size=int(decode_tile_size),
            decode_tile_overlap=int(decode_tile_overlap),
            color_correction=str(color_correction),
            is_video=(output_mode == "video"),
            video_chunk_mode=str(video_chunk_mode),
            frames_per_chunk=int(frames_per_chunk),
            temporal_overlap=int(temporal_overlap),
            vae_temporal_size=int(vae_temporal_size),
            vae_temporal_overlap=int(vae_temporal_overlap),
            tensor_offload_device=str(tensor_offload_device),
            unique_id=unique_id,
        )
        if isinstance(sample, torch.Tensor) and sample.shape[0] > 0:
            _send_segment_preview(
                unique_id,
                sample[0],
                segment=1,
                total_segments=1,
                start_frame=1,
                end_frame=int(sample.shape[0]),
                total_frames=int(sample.shape[0]),
                completed_frames=int(sample.shape[0]),
            )
        if output_mode == "video":
            _send_status(unique_id, "6/6 创建视频...")
            output = InputImpl.VideoFromComponents(
                Types.VideoComponents(
                    images=sample,
                    audio=source_audio,
                    frame_rate=Fraction(source_fps if source_fps and source_fps > 0 else 24.0),
                )
            )
            if replace_path is not None:
                output = _replace_media_file(replace_path, output)
            return (output,)
        if sample.is_cuda or sample.is_mps:
            sample = sample.cpu()
        sample = sample.to(torch.float32)
        if replace_path is not None:
            sample = _replace_media_file(replace_path, sample)
        _send_status(unique_id, f"完成：图像 {int(sample.shape[2])} × {int(sample.shape[1])}")
        return (sample,)

        try:
            api = _get_seedvr2_api()
        except Exception as exc:
            send_dependency_model_notice(_ENVIRONMENT_REPORT, unique_id=unique_id)
            original = getattr(exc, "_gjj_original_error", str(exc))
            _raise_seedvr2_runtime_error(original, unique_id=unique_id)
        Debug = api["Debug"]
        debug = Debug(enabled=enable_debug)

        if (blocks_to_swap > 0 or swap_io_components) and model_offload_device == "none":
            raise RuntimeError("启用模块交换或 IO 组件卸载时，请同时设置“模型卸载设备”。")

        runner = None
        ctx = None
        pbar = None

        def progress_callback(current_step: int, total_steps: int, current_frames: int, phase_name: str) -> None:
            if pbar is None:
                return

            phase_weights = {
                "阶段 1: 编码": 0.2,
                "阶段 2: 放大": 0.25,
                "阶段 3: 解码": 0.5,
                "阶段 4: 后处理": 0.05,
            }
            phase_offset = {
                "阶段 1: 编码": 0.0,
                "阶段 2: 放大": 0.2,
                "阶段 3: 解码": 0.45,
                "阶段 4: 后处理": 0.95,
            }

            phase_key = phase_name.split(" (")[0] if " (" in phase_name else phase_name
            weight = phase_weights.get(phase_key, 1.0)
            offset = phase_offset.get(phase_key, 0.0)
            phase_progress = (current_step / total_steps) if total_steps > 0 else 0.0
            pbar.update_absolute(int((offset + phase_progress * weight) * 100), 100)
            _send_status(
                unique_id,
                f"{phase_name}：{current_step}/{total_steps}",
                0.67 + (offset + phase_progress * weight) * 0.28,
            )

        def cleanup() -> None:
            nonlocal runner, ctx
            if runner is not None:
                api["complete_cleanup"](runner=runner, debug=debug, dit_cache=False, vae_cache=False)
                runner = None
            if ctx is not None:
                api["cleanup_text_embeddings"](ctx, debug)
                ctx = None

        _send_status(unique_id, "1/6 读取输入媒体...")
        image, source_audio, source_fps, output_mode = _coerce_media_to_image_batch(media)

        model_offload = torch.device(model_offload_device) if model_offload_device != "none" else None
        tensor_offload = torch.device(tensor_offload_device) if tensor_offload_device != "none" else None
        run_device = torch.device(device)

        block_swap_config = None
        if blocks_to_swap > 0 or swap_io_components:
            block_swap_config = {
                "blocks_to_swap": int(blocks_to_swap),
                "swap_io_components": bool(swap_io_components),
            }
            if model_offload is not None:
                block_swap_config["offload_device"] = model_offload

        dit_root = _model_category_root_for(str(dit_model))
        vae_root = _model_category_root_for(str(vae_model))
        model_dir = _seedvr2_model_dir(api, str(dit_model), str(vae_model))
        if (dit_root is None) != (vae_root is None) or (dit_root is not None and vae_root is not None and dit_root != vae_root):
            missing = []
            if dit_root is None:
                missing.append(make_missing_model_spec("SeedVR2 主模型", MODEL_SUBDIR, str(dit_model or DEFAULT_DIT_MODEL), "未在 models/SEEDVR2 中找到主模型。"))
            if vae_root is None:
                missing.append(make_missing_model_spec("SeedVR2 VAE", MODEL_SUBDIR, str(vae_model or DEFAULT_VAE_MODEL), "未在 models/SEEDVR2 中找到 VAE。"))
            if not missing:
                missing = [
                    make_missing_model_spec("SeedVR2 主模型", MODEL_SUBDIR, str(dit_model or DEFAULT_DIT_MODEL), "主模型与 VAE 不在同一个模型根目录。"),
                    make_missing_model_spec("SeedVR2 VAE", MODEL_SUBDIR, str(vae_model or DEFAULT_VAE_MODEL), "主模型与 VAE 不在同一个模型根目录。"),
                ]
            raise_dependency_model_error(
                node_name=NODE_DISPLAY_NAME,
                missing_models=missing,
                description="本地 SeedVR2 模式要求主模型和 VAE 都能在 models/SEEDVR2（含子目录）中解析到，并位于同一个模型根目录。",
                unique_id=unique_id,
                copy_text=MODEL_SUBDIR,
                copy_label="📋 复制模型目录",
            )
        if dit_root is None and vae_root is None:
            missing = [
                make_missing_model_spec("SeedVR2 主模型", MODEL_SUBDIR, str(dit_model or DEFAULT_DIT_MODEL), "主超分 safetensors 模型不可用。"),
                make_missing_model_spec("SeedVR2 VAE", MODEL_SUBDIR, str(vae_model or DEFAULT_VAE_MODEL), "VAE safetensors 模型不可用。"),
            ]
            raise_dependency_model_error(
                node_name=NODE_DISPLAY_NAME,
                missing_models=missing,
                description="请把 SeedVR2 的 safetensors 主模型和 VAE 放到 models/SEEDVR2；节点不会联网下载模型。",
                unique_id=unique_id,
                copy_text=MODEL_SUBDIR,
                copy_label="📋 复制模型目录",
            )
        else:
            _send_status(unique_id, "2/6 已找到本地 SeedVR2 模型...")

        try:
            try:
                from comfy.utils import ProgressBar
            except Exception:
                ProgressBar = None

            if ProgressBar is not None:
                pbar = ProgressBar(100)

            _send_status(unique_id, "3/6 准备运行环境...")
            ctx = api["setup_generation_context"](
                dit_device=run_device,
                vae_device=run_device,
                dit_offload_device=model_offload,
                vae_offload_device=model_offload,
                tensor_offload_device=tensor_offload,
                debug=debug,
            )

            runner, cache_context = api["prepare_runner"](
                dit_model=dit_model,
                vae_model=vae_model,
                model_dir=model_dir,
                debug=debug,
                ctx=ctx,
                dit_cache=False,
                vae_cache=False,
                dit_id=None,
                vae_id=None,
                block_swap_config=block_swap_config,
                encode_tiled=bool(encode_tiled),
                encode_tile_size=(int(encode_tile_size), int(encode_tile_size)),
                encode_tile_overlap=(int(encode_tile_overlap), int(encode_tile_overlap)),
                decode_tiled=decode_tiled,
                decode_tile_size=(int(decode_tile_size), int(decode_tile_size)),
                decode_tile_overlap=(int(decode_tile_overlap), int(decode_tile_overlap)),
                tile_debug=str(tile_debug),
                attention_mode=str(attention_mode),
                torch_compile_args_dit=None,
                torch_compile_args_vae=None,
            )

            ctx["cache_context"] = cache_context
            ctx["text_embeds"] = api["load_text_embeddings"](
                api["script_directory"],
                ctx["dit_device"],
                ctx["compute_dtype"],
                debug,
            )

            _send_status(unique_id, "4/6 计算放大计划...")
            image, gen_info = api["compute_generation_info"](
                ctx=ctx,
                images=image,
                resolution=int(resolution),
                max_resolution=int(max_resolution),
                batch_size=1,
                uniform_batch_size=False,
                seed=int(seed),
                prepend_frames=0,
                temporal_overlap=0,
                debug=debug,
            )
            api["log_generation_start"](gen_info, debug)

            _send_status(unique_id, "5/6 执行 SeedVR2 放大...")
            ctx = api["encode_all_batches"](
                runner,
                ctx=ctx,
                images=image,
                debug=debug,
                batch_size=1,
                uniform_batch_size=False,
                seed=int(seed),
                progress_callback=progress_callback,
                temporal_overlap=0,
                resolution=int(resolution),
                max_resolution=int(max_resolution),
                input_noise_scale=float(input_noise_scale),
                color_correction=str(color_correction),
            )

            ctx = api["upscale_all_batches"](
                runner,
                ctx=ctx,
                debug=debug,
                progress_callback=progress_callback,
                seed=int(seed),
                latent_noise_scale=float(latent_noise_scale),
                cache_model=False,
            )

            ctx = api["decode_all_batches"](
                runner,
                ctx=ctx,
                debug=debug,
                progress_callback=progress_callback,
                cache_model=False,
            )

            ctx = api["postprocess_all_batches"](
                ctx=ctx,
                debug=debug,
                progress_callback=progress_callback,
                color_correction=str(color_correction),
                prepend_frames=0,
                temporal_overlap=0,
                batch_size=1,
            )

            sample = ctx["final_video"]
            if torch.is_tensor(sample):
                if sample.is_cuda or sample.is_mps:
                    sample = sample.cpu()
                if sample.dtype != torch.float32:
                    sample = sample.to(torch.float32)

            cleanup()
            pbar = None
            if output_mode == "video":
                _send_status(unique_id, "6/6 创建视频...")
                video_output = InputImpl.VideoFromComponents(
                    Types.VideoComponents(
                        images=sample,
                        audio=source_audio,
                        frame_rate=Fraction(source_fps if source_fps and source_fps > 0 else 24.0),
                    )
                )
                _send_status(unique_id, f"完成：视频 {int(sample.shape[2])} × {int(sample.shape[1])}")
                return (video_output,)

            _send_status(unique_id, f"完成：图像 {int(sample.shape[2])} × {int(sample.shape[1])}")
            return (sample,)
        except Exception:
            cleanup()
            raise


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SeedVR2ImageUpscaler}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
