from __future__ import annotations

import importlib
import importlib.util
import sys
from fractions import Fraction
from functools import lru_cache
from pathlib import Path
from typing import Any

import folder_paths
import torch
from comfy_api.latest import InputImpl, Types

try:
    from .common_utils.dependency_checker import DEFAULT_MODEL_URL
except ImportError:
    from common_utils.dependency_checker import DEFAULT_MODEL_URL


NODE_NAME = "GJJ_SeedVR2ImageUpscaler"
NODE_DISPLAY_NAME = "GJJ · 🔍 SeedVR2图像视频放大器"
DEFAULT_DIT_MODEL = "seedvr2_ema_3b_fp8_e4m3fn.safetensors"
DEFAULT_VAE_MODEL = "ema_vae_fp16.safetensors"
MODEL_CATEGORY = "seedvr2"
MODEL_SUBDIR = "models/seedvr2"
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
MODEL_DOWNLOAD_URL = DEFAULT_MODEL_URL
GGUF_PACKAGE_SPEC = "gguf>=0.13.0"
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
    └── seedvr2/
        ├── seedvr2_ema_3b_fp8_e4m3fn.safetensors  或可模糊匹配的 SeedVR2 主模型
        └── ema_vae_fp16.safetensors                或可模糊匹配的 SeedVR2 VAE
"""
_DESCRIPTION_INTRO = "将 SeedVR2 的图像/视频放大整合成单节点；单输入口兼容 GJJ_BATCH_IMAGE、IMAGE、VIDEO，接 VIDEO 时保留原音频与帧率。"


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _seedvr2_runtime_root() -> Path:
    return Path(__file__).resolve().parents[2] / "seedvr2_videoupscaler"


def _missing_runtime_specs() -> list[dict[str, str]]:
    root = _seedvr2_runtime_root()
    if root.exists() and (root / "src").exists():
        return []
    return [
        {
            "module_name": "seedvr2_videoupscaler",
            "package_name": "seedvr2_videoupscaler",
            "display_name": "SeedVR2 运行时",
            "description": "需要本地 custom_nodes/seedvr2_videoupscaler 运行时；GJJ 节点复用它执行 SeedVR2 推理。",
        }
    ]


def _ensure_seedvr2_model_folder() -> None:
    try:
        folder_paths.add_model_folder_path(MODEL_CATEGORY, str(Path(folder_paths.models_dir) / MODEL_CATEGORY))
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
        if not lower.endswith((".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin")):
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
    return gjjutils_resolve_model_by_extensionless_seed(seed_name, MODEL_CATEGORY) or seed_name


_ENVIRONMENT_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_missing_runtime_specs(),
    install_packages=None,
    description="SeedVR2 运行时用于加载模型并执行图像/视频超分。",
    model_download_url=MODEL_DOWNLOAD_URL,
)
# 不再手动覆盖 install_cmd 和 copy_text，让公共函数自动生成完整安装命令
_DEPENDENCIES_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("dependencies_available", True))
_MISSING_DEPENDENCIES = list(_ENVIRONMENT_REPORT.get("missing_dependencies", []) or [])
if _MISSING_DEPENDENCIES:
    print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ SeedVR2 运行时缺失")

_GJJ_HELP = build_node_help_payload(
    description=_DESCRIPTION_INTRO,
    dependencies=[
        {
            "name": "SeedVR2 运行时 custom_nodes/seedvr2_videoupscaler",
            "type": "本地运行时",
            "required": True,
            "description": "节点复用该运行时的推理、显存优化和视频组件处理。",
        }
    ],
    model_tree=[
        {
            "label": "SeedVR2 主模型",
            "path": f"{MODEL_SUBDIR}/seedvr2_ema_3b_fp8_e4m3fn.safetensors",
            "required": True,
            "description": "下拉列表会去扩展名与量化标记后在 models/seedvr2 深度搜索，优先取匹配项。",
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
        "执行期如果 SeedVR2 运行时或模型不可用，会通过 GJJ 公共提示面板给出中文说明和可复制内容。",
    ],
    model_download_url=MODEL_DOWNLOAD_URL,
    install_cmd=_ENVIRONMENT_REPORT.get("install_cmd", ""),
    copy_text=_ENVIRONMENT_REPORT.get("copy_text", ""),
    copy_label=_ENVIRONMENT_REPORT.get("copy_label", ""),
    notice=_ENVIRONMENT_REPORT.get("warning_message", ""),
    extra={
        "模型放置树": SEEDVR2_MODEL_TREE,
        "模型树信息": [
            {
                "label": "SeedVR2 主模型",
                "path": f"{MODEL_SUBDIR}/seedvr2_ema_3b_fp8_e4m3fn.safetensors",
                "folder": MODEL_CATEGORY,
                "required": True,
                "match_rule": "去扩展名、去量化标记后在 models/seedvr2 含子目录中大小写不敏感搜索。",
            },
            {
                "label": "SeedVR2 VAE",
                "path": f"{MODEL_SUBDIR}/ema_vae_fp16.safetensors",
                "folder": MODEL_CATEGORY,
                "required": True,
                "match_rule": "去扩展名、去量化标记后在 models/seedvr2 含子目录中大小写不敏感搜索。",
            },
        ],
        "依赖信息": [
            {
                "name": "SeedVR2 运行时",
                "type": "本地 custom_nodes 运行时",
                "path": "custom_nodes/seedvr2_videoupscaler",
                "required": True,
                "description": "节点复用该运行时的推理、显存优化和 VIDEO 输出构建逻辑。",
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


def _is_gguf_model(value: Any) -> bool:
    return str(value or "").replace("\\", "/").lower().endswith(".gguf")


def _raise_gguf_dependency_missing(model_names: list[str], unique_id=None, original_error: Any = "") -> None:
    names = "、".join(str(name) for name in model_names if str(name or "").strip()) or "GGUF 模型"
    report = build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=[
            {
                "module_name": "gguf",
                "package_name": GGUF_PACKAGE_SPEC,
                "display_name": GGUF_PACKAGE_SPEC,
                "description": "只有读取 .gguf SeedVR2 模型时需要；safetensors 模型不需要此依赖。",
            }
        ],
        install_packages=[GGUF_PACKAGE_SPEC],
        description=(
            f"当前选择了 GGUF 模型：{names}\n"
            "如改用 safetensors / int4_convrot / int8_convrot 模型，则不需要安装 gguf。"
        ),
        original_error=str(original_error or ""),
        model_download_url=MODEL_DOWNLOAD_URL,
    )
    report["warning_message"] = f"⚠️检测到 GGUF 模型但缺少 gguf 依赖：{names}"
    report["copy_label"] = "📋 复制安装 gguf 依赖命令"
    print_dependency_model_report(report, title="GJJ SeedVR2 GGUF 依赖缺失")
    send_dependency_model_notice(report, unique_id=unique_id)
    err = RuntimeError(
        f"检测到 GGUF 模型，但当前 ComfyUI Python 缺少 gguf 依赖。\n"
        f"模型：{names}\n"
        f"请安装 {GGUF_PACKAGE_SPEC} 后重启 ComfyUI，或改用非 GGUF 模型。"
    )
    setattr(err, "gjj_report", report)
    raise err


def _ensure_gguf_dependency_for_selected_models(dit_model: Any, vae_model: Any, unique_id=None) -> None:
    gguf_models = [str(name) for name in (dit_model, vae_model) if _is_gguf_model(name)]
    if not gguf_models:
        return
    try:
        importlib.import_module("gguf")
    except Exception as exc:
        _raise_gguf_dependency_missing(gguf_models, unique_id=unique_id, original_error=exc)


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


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": str(text or "")},
        )
    except Exception:
        pass


def _get_seedvr2_model_options() -> tuple[list[str], list[str]]:
    dit_models = _ordered_model_choices(DEFAULT_DIT_MODEL, want_vae=False)
    vae_models = _ordered_model_choices(DEFAULT_VAE_MODEL, want_vae=True)

    try:
        custom_nodes_root = Path(__file__).resolve().parents[2]
        seedvr2_root = custom_nodes_root / "seedvr2_videoupscaler"
        seedvr2_root_str = str(seedvr2_root)
        if seedvr2_root_str not in sys.path:
            sys.path.insert(0, seedvr2_root_str)

        constants = importlib.import_module("src.utils.constants")
        discovered = constants.get_all_model_files()
        for filename in sorted(discovered.keys()):
            lowered = filename.lower()
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

    custom_nodes_root = Path(__file__).resolve().parents[2]
    custom_nodes_root_str = str(custom_nodes_root)
    if custom_nodes_root_str not in sys.path:
        sys.path.insert(0, custom_nodes_root_str)

    seedvr2_root = custom_nodes_root / "seedvr2_videoupscaler"
    seedvr2_root_str = str(seedvr2_root)
    if seedvr2_root_str not in sys.path:
        sys.path.insert(0, seedvr2_root_str)

    try:
        model_registry = importlib.import_module("src.utils.model_registry")
        constants = importlib.import_module("src.utils.constants")
        downloads = importlib.import_module("src.utils.downloads")
        debug_module = importlib.import_module("src.utils.debug")
        generation_phases = importlib.import_module("src.core.generation_phases")
        generation_utils = importlib.import_module("src.core.generation_utils")
        memory_manager = importlib.import_module("src.optimization.memory_manager")
    except Exception as exc:
        err = RuntimeError("无法导入 seedvr2_videoupscaler 运行时。")
        setattr(err, "_gjj_original_error", str(exc))
        raise err from exc

    return {
        "DEFAULT_DIT": getattr(model_registry, "DEFAULT_DIT", DEFAULT_DIT_MODEL),
        "DEFAULT_VAE": getattr(model_registry, "DEFAULT_VAE", DEFAULT_VAE_MODEL),
        "get_base_cache_dir": constants.get_base_cache_dir,
        "download_weight": downloads.download_weight,
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
    return tensor.detach().float().clamp(0.0, 1.0).contiguous(), source_audio, source_fps, output_mode


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
    report = build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=_missing_runtime_specs() or [
            {
                "module_name": "seedvr2_videoupscaler",
                "package_name": "seedvr2_videoupscaler",
                "display_name": "SeedVR2 运行时",
                "description": "运行时导入失败，可能是依赖未安装或版本不兼容。",
            }
        ],
        install_packages=None,
        description="SeedVR2 图像/视频放大需要本地 seedvr2_videoupscaler 运行时。",
        original_error=original_error,
        model_download_url=MODEL_DOWNLOAD_URL,
    )
    # 不再手动覆盖 install_cmd 和 copy_text，让公共函数自动生成完整安装命令
    print_dependency_model_report(report, title="GJJ SeedVR2 运行时缺失")
    send_dependency_model_notice(report, unique_id=unique_id)
    err = RuntimeError(report.get("warning_message") or "SeedVR2 运行时缺失")
    setattr(err, "gjj_report", report)
    raise err


class GJJ_SeedVR2ImageUpscaler:
    CATEGORY = "GJJ"
    FUNCTION = "upscale_image"
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
                    "tooltip": "SeedVR2 主超分模型。会按去扩展名、去量化标记后的名称在 models/seedvr2 深度搜索，列表第一项作为默认。",
                }),
                "vae_model": (vae_models, {
                    "default": _default_model_choice(DEFAULT_VAE_MODEL),
                    "display_name": "解码模型",
                    "tooltip": "SeedVR2 编码/解码模型。会按去扩展名、去量化标记后的名称在 models/seedvr2 深度搜索，列表第一项作为默认。",
                }),
                "device": (devices, {
                    "default": preferred_device,
                    "display_name": "运行设备",
                    "tooltip": "SeedVR2 推理主设备；如存在 cuda:0，默认自动选中 cuda:0，否则使用 cpu。",
                }),
                "model_offload_device": (offload_devices, {
                    "default": "none" if "none" in offload_devices else offload_devices[0],
                    "display_name": "模型卸载设备",
                    "tooltip": "模型空闲时卸载到的设备；低显存时可设为 cpu。",
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
                    "default": True,
                    "display_name": "分块编码",
                    "tooltip": "降低 VAE 编码显存占用。",
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
                    "default": 128,
                    "min": 0,
                    "max": 2048,
                    "step": 32,
                    "display_name": "编码分块重叠",
                    "tooltip": "VAE 编码阶段的分块重叠。",
                }),
                "decode_tiled": ("BOOLEAN", {
                    "default": True,
                    "display_name": "分块解码",
                    "tooltip": "降低 VAE 解码显存占用。",
                }),
                "decode_tile_size": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 8192,
                    "step": 32,
                    "display_name": "解码分块大小",
                    "tooltip": "VAE 解码阶段的分块大小。",
                }),
                "decode_tile_overlap": ("INT", {
                    "default": 128,
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

        _ensure_gguf_dependency_for_selected_models(dit_model, vae_model, unique_id=unique_id)

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
            _send_status(unique_id, f"{phase_name}：{current_step}/{total_steps}")

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
                missing.append(make_missing_model_spec("SeedVR2 主模型", MODEL_SUBDIR, str(dit_model or DEFAULT_DIT_MODEL), "未在 models/seedvr2 中找到主模型。"))
            if vae_root is None:
                missing.append(make_missing_model_spec("SeedVR2 VAE", MODEL_SUBDIR, str(vae_model or DEFAULT_VAE_MODEL), "未在 models/seedvr2 中找到 VAE。"))
            if not missing:
                missing = [
                    make_missing_model_spec("SeedVR2 主模型", MODEL_SUBDIR, str(dit_model or DEFAULT_DIT_MODEL), "主模型与 VAE 不在同一个模型根目录。"),
                    make_missing_model_spec("SeedVR2 VAE", MODEL_SUBDIR, str(vae_model or DEFAULT_VAE_MODEL), "主模型与 VAE 不在同一个模型根目录。"),
                ]
            raise_dependency_model_error(
                node_name=NODE_DISPLAY_NAME,
                missing_models=missing,
                description="本地 SeedVR2 模式要求主模型和 VAE 都能在 models/seedvr2（含子目录）中解析到，并位于同一个模型根目录。",
                unique_id=unique_id,
                copy_text=MODEL_SUBDIR,
                copy_label="📋 复制模型目录",
                model_download_url=MODEL_DOWNLOAD_URL,
            )
        if dit_root is None and vae_root is None:
            try:
                _send_status(unique_id, "2/6 检查 SeedVR2 模型...")
                api["download_weight"](dit_model=dit_model, vae_model=vae_model, debug=debug)
            except Exception as exc:
                missing = [
                    make_missing_model_spec("SeedVR2 主模型", MODEL_SUBDIR, str(dit_model or DEFAULT_DIT_MODEL), "主超分模型不可用。"),
                    make_missing_model_spec("SeedVR2 VAE", MODEL_SUBDIR, str(vae_model or DEFAULT_VAE_MODEL), "VAE 模型不可用。"),
                ]
                raise_dependency_model_error(
                    node_name=NODE_DISPLAY_NAME,
                    missing_models=missing,
                    description="请把 SeedVR2 模型放到 models/seedvr2，可放在子目录中；节点会按去扩展名、去量化信息后的名称做大小写不敏感搜索。",
                    original_error=str(exc),
                    unique_id=unique_id,
                    copy_text=MODEL_SUBDIR,
                    copy_label="📋 复制模型目录",
                    model_download_url=MODEL_DOWNLOAD_URL,
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
                decode_tiled=bool(decode_tiled),
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
