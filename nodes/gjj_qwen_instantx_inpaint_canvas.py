from __future__ import annotations

import base64
import hashlib
import io
import json
import os
from typing import Any

import comfy.samplers
import folder_paths
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter

try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        build_node_help_payload,
        get_pip_install_command_text,
        get_report_from_exception,
        print_dependency_model_report,
        send_dependency_model_notice,
    )
    from .common_utils.prompt_translation import (
        COMMON_PROMPT_TRANSLATE_API_PATH,
        TRANSLATION_BUNDLE_FILENAME,
        TRANSLATION_BUNDLE_RELATIVE_PATH,
        TRANSLATION_DEPENDENCY_SPECS,
        TRANSLATION_MODEL_SUBDIR,
        build_translation_environment_report,
        register_prompt_translation_api,
    )
    from .gjj_alimama_controlnet_apply import GJJ_AliMamaControlNetApply
    from .gjj_batch_outpaint import (
        _apply_aura_flow_shift,
        _apply_lora_model_only,
        _clip_text_encode,
        _decode_vae,
        _ensure_image_batch,
        _ksampler,
        _load_clip,
        _load_unet,
        _load_vae,
        _send_status,
    )
    from .gjj_multi_lora_chain import apply_lora_chain_config, normalize_lora_chain_data
    from .gjj_wanvideo_runtime_shims import ensure_optional_gguf_module
except ImportError:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        build_node_help_payload,
        get_pip_install_command_text,
        get_report_from_exception,
        print_dependency_model_report,
        send_dependency_model_notice,
    )
    from common_utils.prompt_translation import (
        COMMON_PROMPT_TRANSLATE_API_PATH,
        TRANSLATION_BUNDLE_FILENAME,
        TRANSLATION_BUNDLE_RELATIVE_PATH,
        TRANSLATION_DEPENDENCY_SPECS,
        TRANSLATION_MODEL_SUBDIR,
        build_translation_environment_report,
        register_prompt_translation_api,
    )
    from gjj_alimama_controlnet_apply import GJJ_AliMamaControlNetApply
    from gjj_batch_outpaint import (
        _apply_aura_flow_shift,
        _apply_lora_model_only,
        _clip_text_encode,
        _decode_vae,
        _ensure_image_batch,
        _ksampler,
        _load_clip,
        _load_unet,
        _load_vae,
        _send_status,
    )
    from gjj_multi_lora_chain import apply_lora_chain_config, normalize_lora_chain_data
    from gjj_wanvideo_runtime_shims import ensure_optional_gguf_module


NODE_NAME = "GJJ_QwenInstantXInpaintCanvas"
NODE_DISPLAY_NAME = "GJJ · 千问2512局部重绘画布"
DESCRIPTION = (
    "仿 GJJ_DoodleCanvas 的交互式单节点局部重绘：节点内载图、画遮罩，"
    "按 Qwen Image 2512 + InstantX Inpainting ControlNet 工作流直接生成结果图。"
)
INPUT_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
OUTPUT_IMAGE_TYPE = "IMAGE"
MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d"
GGUF_PACKAGE_SPEC = "gguf>=0.13.0"

DEFAULT_WIDTH = 512
DEFAULT_HEIGHT = 512
DEFAULT_UNET = "qwen_image_2512_fp8_e4m3fn.safetensors"
DEFAULT_CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
DEFAULT_CONTROLNET = "Qwen-Image-InstantX-ControlNet-Inpainting.safetensors"
DEFAULT_VAE = "qwen_image_vae.safetensors"
DEFAULT_LORA = "QWEN\\Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors"
DEFAULT_POSITIVE = "虎头"
DEFAULT_NEGATIVE = " "
DEFAULT_SEED = 530168790484505
DEFAULT_STEPS = 4
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "simple"
DEFAULT_DENOISE = 1.0
DEFAULT_LARGEST_SIZE = 1536
DEFAULT_MASK_EXPAND = 0
DEFAULT_MASK_BLUR_RADIUS = 31
DEFAULT_MASK_BLUR_SIGMA = 1.0
DEFAULT_CONTROL_STRENGTH = 1.0
DEFAULT_START_PERCENT = 0.0
DEFAULT_END_PERCENT = 1.0
DEFAULT_LORA_STRENGTH = 1.0
DEFAULT_SHIFT = 3.1
NO_LORA = "不使用 LoRA"
MODEL_EXTENSIONS = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft"}


register_prompt_translation_api((COMMON_PROMPT_TRANSLATE_API_PATH,))

_TRANSLATION_ENVIRONMENT_REPORT = build_translation_environment_report(
    node_name=NODE_DISPLAY_NAME,
    description=(
        "千问局部重绘画布本身不强制依赖翻译模型；只有点击面板 🌐 翻译按钮时，"
        f"才需要 {TRANSLATION_MODEL_SUBDIR}/{TRANSLATION_BUNDLE_FILENAME}。"
    ),
)

_QWEN_INPAINT_MODEL_TREE = [
    {
        "label": "Qwen / FireRed UNET",
        "path": "models/diffusion_models",
        "folder": "diffusion_models",
        "subdir": "models/diffusion_models",
        "filename": DEFAULT_UNET,
        "value": DEFAULT_UNET,
        "kind": "diffusion",
        "description": "必需。工作流中的主模型；下拉列表会优先显示文件名包含 qwen 或 firered 的权重。",
        "icon": "🟣",
    },
    {
        "label": "Qwen / FireRed UNET GGUF",
        "path": "models/unet_gguf",
        "folder": "unet_gguf",
        "subdir": "models/unet_gguf",
        "filename": "qwen*.gguf / firered*.gguf",
        "value": "qwen*.gguf / firered*.gguf",
        "kind": "diffusion",
        "description": "可选。选择 .gguf 主模型时使用 GJJ 内置 GGUF UNET 加载器；只需安装 gguf Python 依赖。",
        "icon": "🟪",
    },
    {
        "label": "Qwen 2.5 VL 文本编码器",
        "path": "models/text_encoders",
        "folder": "text_encoders",
        "subdir": "models/text_encoders",
        "filename": DEFAULT_CLIP,
        "value": DEFAULT_CLIP,
        "kind": "clip",
        "description": "必需。CLIPLoader 使用 qwen_image 类型加载，负责正负提示词编码。",
        "icon": "🟢",
    },
    {
        "label": "Qwen 2.5 VL 文本编码器 GGUF",
        "path": "models/text_encoders",
        "folder": "text_encoders",
        "subdir": "models/text_encoders",
        "filename": "qwen_*.gguf",
        "value": "qwen_*.gguf",
        "kind": "clip",
        "required": False,
        "description": "可选。选择 .gguf 文本编码器时使用 GJJ 内置 GGUF CLIP 加载器，适合低显存环境。",
        "icon": "🟩",
    },
    {
        "label": "InstantX Inpainting ControlNet",
        "path": "models/controlnet",
        "folder": "controlnet",
        "subdir": "models/controlnet",
        "filename": DEFAULT_CONTROLNET,
        "value": DEFAULT_CONTROLNET,
        "kind": "controlnet",
        "description": "必需。Qwen-Image-InstantX-ControlNet-Inpainting，用于按遮罩引导局部重绘。",
        "icon": "🟦",
    },
    {
        "label": "Qwen Image VAE",
        "path": "models/vae",
        "folder": "vae",
        "subdir": "models/vae",
        "filename": DEFAULT_VAE,
        "value": DEFAULT_VAE,
        "kind": "vae",
        "description": "必需。编码原图 latent 并解码采样结果。",
        "icon": "🔴",
    },
    {
        "label": "Qwen 2512 Lightning LoRA",
        "path": "models/loras/QWEN",
        "folder": "loras/QWEN",
        "subdir": "models/loras/QWEN",
        "filename": "Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors",
        "value": DEFAULT_LORA,
        "kind": "loras",
        "description": "必需/建议。工作流默认 4 steps 加速 LoRA；可在设置中改为不使用。",
        "icon": "🟡",
    },
    {
        "label": "提示词翻译模型包",
        "path": "models/translation",
        "folder": "translation",
        "subdir": "models/translation",
        "filename": TRANSLATION_BUNDLE_FILENAME,
        "value": TRANSLATION_BUNDLE_RELATIVE_PATH,
        "kind": "translation",
        "required": False,
        "description": "可选。只在点击 🌐 翻译按钮时使用；Qwen 2512 本身可直接接收中文提示词。",
        "icon": "🧠",
    },
]

_QWEN_INPAINT_HELP = build_node_help_payload(
    description=(
        "把 `image_qwen_image_instantx_inpainting_controlnet.json` 收口成一个交互式单节点。\n\n"
        "使用方法：\n"
        "1. 将 IMAGE/GJJ_BATCH_IMAGE 接到图像输入，或在节点面板点击 📂 导入图片。\n"
        "2. 用绿色画笔在图上涂白色遮罩区域；黄色橡皮擦可擦掉遮罩。白色/红色覆盖处会被重绘。\n"
        "3. 输入正向提示词，默认沿用工作流的“虎头”；需要时点击 🌐 翻译。\n"
        "4. 点击节点内 🚀 只执行当前节点，或点击 ComfyUI 顶部运行；本节点都会直接输出生成后的图片。\n"
        "5. 没有遮罩时会自动使用全图遮罩执行生成，避免只输出原图。"
    ),
    dependencies=[
        {
            "name": "gguf",
            "type": "GGUF 模型依赖",
            "required": False,
            "description": "仅在 UNET 或 CLIP 选择 .gguf 时需要；GJJ 内置加载器，不依赖 ComfyUI-GGUF 第三方节点。",
        },
    ]
    + [
        {
            "name": spec.get("display_name") or spec.get("package_name") or spec.get("module_name"),
            "type": "提示词翻译可选依赖",
            "required": False,
            "description": spec.get("description", ""),
        }
        for spec in TRANSLATION_DEPENDENCY_SPECS
    ],
    model_tree=_QWEN_INPAINT_MODEL_TREE,
    models=[],
    usage=[
        "节点唯一输出口始终输出生成图，不再需要把多个官方节点手动串起来。",
        "图像输入口接线时优先使用上游图像；未接线时使用面板中上传/粘贴的图片；两者都没有时使用空白画布并全图生成。",
        "遮罩输入口接线时优先使用上游 MASK；未接线时使用面板绘制的遮罩；两者都没有时自动全图重绘。",
        "默认参数完全贴近工作流：steps=4、cfg=1、euler/simple、denoise=1、最大边=1536、mask blur radius=31、sigma=1。",
        "UNET 下拉会筛选文件名包含 qwen 或 firered 的模型，默认仍优先 qwen_image_2512_fp8_e4m3fn.safetensors。",
    ],
    runtime=[
        "执行链路：GJJ 内置 UNET/CLIP GGUF Loader → VAELoader → LoraLoaderModelOnly → 可选 LoRA串联配置 → ModelSamplingAuraFlow(shift=3.1)。",
        "图像会按最大边缩放到 1536 内，并对遮罩执行扩展与模糊，然后同时用于 latent noise mask 与 InstantX ControlNet。",
        "ControlNet 路径复用 GJJ 阿里妈妈 ControlNet Apply 的 inpaint mask 处理逻辑，以兼容 concat_mask 模型。",
        "采样后会按处理后的遮罩把生成结果合回缩放后的原图，输出就是局部重绘后的图片。",
        "常见问题：新增 Python/JS 节点后必须重启 ComfyUI 后端并强刷新浏览器，节点面板和帮助才会更新。",
    ],
    model_download_url=MODEL_DOWNLOAD_URL,
    copy_text=MODEL_DOWNLOAD_URL,
    copy_label="🌏 复制模型下载地址",
    notice=(
        _TRANSLATION_ENVIRONMENT_REPORT.get("warning_message", "")
        if not _TRANSLATION_ENVIRONMENT_REPORT.get("available", True)
        else ""
    ),
    extra={
        "model_tree": _QWEN_INPAINT_MODEL_TREE,
        "models": [],
        "translation_notice": _TRANSLATION_ENVIRONMENT_REPORT.get("help_message", "")
        if not _TRANSLATION_ENVIRONMENT_REPORT.get("available", True)
        else "",
        "translation_install_cmd": _TRANSLATION_ENVIRONMENT_REPORT.get("install_cmd", ""),
        "translation_copy_text": _TRANSLATION_ENVIRONMENT_REPORT.get("copy_text", ""),
        "translation_model_download_url": _TRANSLATION_ENVIRONMENT_REPORT.get("model_download_url", ""),
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "source_workflow": "D:/AI/MOD/user/default/workflows/image_qwen_image_instantx_inpainting_controlnet.json",
        "troubleshooting": [
            "点击运行没有生成：重启 ComfyUI 后端，并强刷新浏览器，确认加载到 gjj_qwen_instantx_inpaint_canvas.js。",
            "模型树为空：确认帮助面板读取到本节点 GJJ_HELP；本节点声明了 diffusion_models、text_encoders、controlnet、vae、loras、translation。",
            "生成报模型不存在：按模型树路径放入 Qwen/FireRed UNET、Qwen 2.5 VL、InstantX Inpainting ControlNet、Qwen VAE 和 2512 Lightning LoRA。",
            "只想局部改动：画遮罩后再生成；没有任何遮罩时会按全图重绘处理。",
        ],
    },
)


def _list_models(category: str, preferred: str = "", include_none: bool = False) -> list[str]:
    try:
        values = [str(item) for item in folder_paths.get_filename_list(category)]
    except Exception:
        values = []
    result: list[str] = []
    if include_none:
        result.append(NO_LORA)
    preferred = str(preferred or "").strip()
    if preferred and preferred not in values:
        result.append(preferred)
    result.extend(values)
    seen: set[str] = set()
    unique: list[str] = []
    for item in result or ([preferred] if preferred else [""]):
        key = item.replace("\\", "/").lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique or [""]


def _ensure_unet_gguf_folder() -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    for target in ("diffusion_models", "unet"):
        current = existing.get(target)
        if not current:
            continue
        paths, exts = current
        ext_set = set(exts or [])
        if ".gguf" not in ext_set:
            existing[target] = (paths, ext_set | {".gguf"})
    if "unet_gguf" in existing:
        return
    for target in ("diffusion_models", "unet"):
        current = existing.get(target)
        if current and current[0]:
            paths = current[0] if isinstance(current[0], (list, tuple, set)) else [current[0]]
            existing["unet_gguf"] = (list(paths), {".gguf"})
            return
    models_dir = str(getattr(folder_paths, "models_dir", "") or "").strip()
    if models_dir:
        existing["unet_gguf"] = ([os.path.join(models_dir, "diffusion_models")], {".gguf"})


def _ensure_clip_gguf_folder() -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    for target in ("text_encoders", "clip"):
        current = existing.get(target)
        if not current:
            continue
        paths, exts = current
        ext_set = set(exts or [])
        if ".gguf" not in ext_set:
            existing[target] = (paths, ext_set | {".gguf"})
    if "clip_gguf" in existing:
        return
    for target in ("text_encoders", "clip"):
        current = existing.get(target)
        if current and current[0]:
            paths = current[0] if isinstance(current[0], (list, tuple, set)) else [current[0]]
            existing["clip_gguf"] = (list(paths), {".gguf"})
            return
    models_dir = str(getattr(folder_paths, "models_dir", "") or "").strip()
    if models_dir:
        existing["clip_gguf"] = ([os.path.join(models_dir, "text_encoders")], {".gguf"})


def _normalize_model_key(value: Any) -> str:
    text = str(value or "").replace("\\", "/").rsplit("/", 1)[-1].lower()
    for char in ("-", ".", " ", "__"):
        text = text.replace(char, "_")
    while "__" in text:
        text = text.replace("__", "_")
    return text


def _is_qwen_or_firered_unet(value: Any) -> bool:
    key = _normalize_model_key(value)
    return "qwen" in key or "firered" in key or "fire_red" in key


def _list_qwen_or_firered_unets(preferred: str = DEFAULT_UNET) -> list[str]:
    _ensure_unet_gguf_folder()
    values: list[str] = []
    for category in ("diffusion_models", "unet_gguf"):
        try:
            values.extend(str(item) for item in folder_paths.get_filename_list(category))
        except Exception:
            pass
    preferred = str(preferred or "").strip()
    if preferred:
        values.insert(0, preferred)
    filtered = [item for item in values if _is_qwen_or_firered_unet(item)]
    seen: set[str] = set()
    unique: list[str] = []
    for item in filtered or ([preferred] if preferred else []):
        key = item.replace("\\", "/").lower()
        if not item or key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique or [preferred or ""]


def _list_qwen_clips(preferred: str = DEFAULT_CLIP) -> list[str]:
    _ensure_clip_gguf_folder()
    values = _list_models("text_encoders", preferred)
    try:
        values.extend(str(item) for item in folder_paths.get_filename_list("clip_gguf"))
    except Exception:
        pass
    seen: set[str] = set()
    unique: list[str] = []
    for item in values or ([preferred] if preferred else []):
        key = str(item or "").replace("\\", "/").lower()
        if not item or key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique or [preferred or ""]


def _preferred_default(values: list[str], preferred: str) -> str:
    preferred_key = str(preferred or "").replace("\\", "/").lower()
    preferred_base = preferred_key.rsplit("/", 1)[-1]
    for value in values:
        key = str(value or "").replace("\\", "/").lower()
        if key == preferred_key or key.rsplit("/", 1)[-1] == preferred_base:
            return value
    return values[0] if values else preferred


def _is_gguf_model(value: Any) -> bool:
    return str(value or "").replace("\\", "/").lower().endswith(".gguf")


def _gguf_install_command() -> str:
    return get_pip_install_command_text(packages=[GGUF_PACKAGE_SPEC])


def _build_gguf_dependency_report(model_name: str, original_error: Any = "", model_kind: str = "模型") -> dict[str, Any]:
    install_cmd = _gguf_install_command()
    report = build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=[
            {
                "module_name": "gguf",
                "package_name": GGUF_PACKAGE_SPEC,
                "display_name": "gguf",
                "description": "GJJ 内置 GGUF UNET/CLIP 加载器读取 .gguf 权重时需要的 Python 依赖。",
            }
        ],
        install_packages=[GGUF_PACKAGE_SPEC],
        description=(
            f"当前 {model_kind} 选择的是 GGUF 模型：{model_name}\n"
            "GJJ 已内置 GGUF UNET/CLIP 加载器，不需要安装 ComfyUI-GGUF 第三方节点。\n"
            "这里只需要安装/升级 gguf Python 依赖；或者改用 safetensors 版 Qwen 2512。"
        ),
        original_error=str(original_error or ""),
    )
    report["warning_message"] = "⚠️缺失 gguf 依赖，点击按钮复制安装命令。"
    report["description_message"] = report["warning_message"]
    report["install_cmd"] = install_cmd
    report["copy_text"] = install_cmd
    report["copy_label"] = "📋 复制安装 gguf 依赖命令"
    report["model_download_url"] = ""
    report["panel_message"] = "\n\n".join(
        item
        for item in (
            report.get("panel_message", ""),
            "🔧 快速安装命令：\n\n" + install_cmd,
        )
        if item
    )
    report["help_message"] = report["panel_message"]
    return report


def _raise_gguf_dependency_missing(
    model_name: str,
    unique_id=None,
    original_error: Any = "",
    model_kind: str = "模型",
) -> None:
    report = _build_gguf_dependency_report(model_name, original_error, model_kind=model_kind)
    print_dependency_model_report(report, title="GJJ 千问局部重绘 GGUF 依赖缺失！")
    send_dependency_model_notice(report, unique_id=unique_id)
    err = RuntimeError(
        f"检测到 GGUF {model_kind}，但当前 ComfyUI Python 缺少 gguf 依赖。"
        "请点击面板按钮复制安装命令，或改用 safetensors 版 Qwen 2512。"
    )
    setattr(err, "gjj_report", report)
    raise err


def _first_node_output(value: Any) -> Any:
    if isinstance(value, dict) and "result" in value:
        value = value["result"]
    if isinstance(value, (list, tuple)):
        return value[0]
    return value


def _ensure_gguf_dependency(model_name: str, unique_id=None, model_kind: str = "模型") -> None:
    gguf_module = ensure_optional_gguf_module()
    if getattr(gguf_module, "_GJJ_OPTIONAL_RUNTIME_STUB", False):
        _raise_gguf_dependency_missing(model_name, unique_id=unique_id, model_kind=model_kind)


def _load_unet_gguf(unet_name: str, unique_id=None) -> Any:
    _ensure_gguf_dependency(unet_name, unique_id=unique_id, model_kind="UNET")
    try:
        from ..vendor.gjj_gguf_runtime import load_unet_gguf as load_gjj_gguf_unet
    except ImportError:
        from vendor.gjj_gguf_runtime import load_unet_gguf as load_gjj_gguf_unet
    try:
        return load_gjj_gguf_unet(unet_name)
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", "") == "gguf":
            _raise_gguf_dependency_missing(unet_name, unique_id=unique_id, original_error=exc, model_kind="UNET")
        raise
    except Exception as exc:
        error_text = str(exc)
        if "No module named 'gguf'" in error_text or "需要先安装 gguf" in error_text:
            _raise_gguf_dependency_missing(unet_name, unique_id=unique_id, original_error=exc, model_kind="UNET")
        raise RuntimeError(f"GJJ 内置 GGUF UNET 加载失败：{unet_name}\n{exc}") from exc


def _load_clip_gguf(clip_name: str, clip_type: str = "qwen_image", unique_id=None) -> Any:
    _ensure_gguf_dependency(clip_name, unique_id=unique_id, model_kind="CLIP")
    try:
        from ..vendor.gjj_gguf_runtime import load_clip_gguf as load_gjj_gguf_clip
    except ImportError:
        from vendor.gjj_gguf_runtime import load_clip_gguf as load_gjj_gguf_clip
    try:
        return load_gjj_gguf_clip(clip_name, clip_type)
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", "") == "gguf":
            _raise_gguf_dependency_missing(clip_name, unique_id=unique_id, original_error=exc, model_kind="CLIP")
        raise
    except Exception as exc:
        error_text = str(exc)
        if "No module named 'gguf'" in error_text or "需要先安装 gguf" in error_text:
            _raise_gguf_dependency_missing(clip_name, unique_id=unique_id, original_error=exc, model_kind="CLIP")
        raise RuntimeError(f"GJJ 内置 GGUF CLIP 加载失败：{clip_name}\n{exc}") from exc


def _load_qwen_unet(unet_name: str, dtype: str = "default", unique_id=None) -> Any:
    if _is_gguf_model(unet_name):
        return _load_unet_gguf(unet_name, unique_id=unique_id)
    return _load_unet(unet_name, dtype)


def _load_qwen_clip(clip_name: str, clip_type: str = "qwen_image", device: str = "default", unique_id=None) -> Any:
    if _is_gguf_model(clip_name):
        return _load_clip_gguf(clip_name, clip_type, unique_id=unique_id)
    return _load_clip(clip_name, clip_type, device)


def _coerce_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        number = int(round(float(value)))
    except Exception:
        number = int(fallback)
    return max(minimum, min(maximum, number))


def _coerce_float(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except Exception:
        number = float(fallback)
    return max(minimum, min(maximum, number))


def _safe_json_loads(value: Any, fallback: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    text = str(value or "").strip()
    if not text:
        return fallback
    try:
        return json.loads(text)
    except Exception:
        return fallback


def _image_payload_from_state(value: Any, keys: tuple[str, ...]) -> str:
    state = _safe_json_loads(value, {})
    if isinstance(state, dict):
        for key in keys:
            payload = state.get(key)
            if payload:
                return str(payload).strip()
    return ""


def _decode_data_url(value: Any) -> bytes | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.lower().startswith("data:") and "," in text:
        text = text.split(",", 1)[1]
    try:
        return base64.b64decode(text, validate=False)
    except Exception:
        return None


def _resampling_filter():
    return getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.BICUBIC)


def _load_state_image(inpaint_data: Any, width: int, height: int) -> Image.Image | None:
    raw = _decode_data_url(
        _image_payload_from_state(
            inpaint_data,
            ("baseImage", "sourceImage", "image", "data_url", "png"),
        )
    )
    if not raw:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            result = image.convert("RGB")
    except Exception as exc:
        print(f"[{NODE_NAME}] 面板图像解码失败，已回退空白画布：{exc}")
        return None
    if result.size != (width, height):
        result = result.resize((width, height), _resampling_filter())
    return result


def _load_state_mask(inpaint_data: Any, width: int, height: int) -> torch.Tensor | None:
    raw = _decode_data_url(
        _image_payload_from_state(
            inpaint_data,
            ("maskImage", "mask", "maskData", "mask_data"),
        )
    )
    if not raw:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            if "A" in image.getbands():
                alpha = image.convert("RGBA").getchannel("A")
                luminance = image.convert("RGB").convert("L")
                mask_image = Image.fromarray(
                    np.maximum(
                        np.asarray(alpha, dtype=np.uint8),
                        np.asarray(luminance, dtype=np.uint8),
                    ),
                    mode="L",
                )
            else:
                mask_image = image.convert("L")
    except Exception as exc:
        print(f"[{NODE_NAME}] 面板遮罩解码失败，已回退全图遮罩：{exc}")
        return None
    if mask_image.size != (width, height):
        mask_image = mask_image.resize((width, height), _resampling_filter())
    array = np.asarray(mask_image, dtype=np.float32) / 255.0
    if float(array.max()) <= 0.001:
        return None
    return torch.from_numpy(array).unsqueeze(0).clamp(0.0, 1.0)


def _blank_image(width: int, height: int) -> torch.Tensor:
    return torch.zeros((1, int(height), int(width), 3), dtype=torch.float32)


def _image_to_tensor(image: Image.Image) -> torch.Tensor:
    array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0).clamp(0.0, 1.0)


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    tensor = image[0] if image.ndim == 4 else image
    array = tensor.detach().cpu().float().clamp(0.0, 1.0).numpy()
    if array.ndim == 3 and array.shape[0] in (1, 3, 4) and array.shape[-1] not in (1, 3, 4):
        array = np.moveaxis(array, 0, -1)
    if array.ndim == 2:
        array = np.repeat(array[..., None], 3, axis=-1)
    if array.shape[-1] == 1:
        array = np.repeat(array, 3, axis=-1)
    if array.shape[-1] > 3:
        array = array[..., :3]
    return Image.fromarray((array * 255.0).astype(np.uint8), mode="RGB")


def _tensor_to_base64(image: torch.Tensor) -> str:
    buffer = io.BytesIO()
    _tensor_to_pil(image).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _image_payload_to_tensor(value: Any) -> torch.Tensor | None:
    raw = _decode_data_url(value)
    if not raw:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            return _image_to_tensor(image.convert("RGB"))
    except Exception as exc:
        print(f"[{NODE_NAME}] 生成图缓存解码失败，已重新生成：{exc}")
        return None


def _image_to_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _tensor_layer_to_pil(image: torch.Tensor, mask: torch.Tensor, size: tuple[int, int] | None = None) -> Image.Image:
    image_tensor = _ensure_image_batch(image)[0].detach().cpu().float().clamp(0.0, 1.0)
    mask_tensor = _ensure_mask(mask)
    if mask_tensor is None:
        mask_tensor = torch.ones((1, int(image_tensor.shape[0]), int(image_tensor.shape[1])), dtype=torch.float32)
    alpha = mask_tensor[0].detach().cpu().float().clamp(0.0, 1.0)
    if int(alpha.shape[0]) != int(image_tensor.shape[0]) or int(alpha.shape[1]) != int(image_tensor.shape[1]):
        alpha = _resize_mask_tensor(alpha.unsqueeze(0), int(image_tensor.shape[0]), int(image_tensor.shape[1]))[0].cpu()
    rgb = (image_tensor.numpy() * 255.0).round().astype(np.uint8)
    a = (alpha.numpy() * 255.0).round().astype(np.uint8)
    rgba = np.concatenate([rgb, a[..., None]], axis=-1)
    layer = Image.fromarray(rgba, mode="RGBA")
    if size and layer.size != size:
        layer = layer.resize(size, _resampling_filter())
    return layer


def _tensor_layer_to_base64(image: torch.Tensor, mask: torch.Tensor) -> str:
    return _image_to_data_url(_tensor_layer_to_pil(image, mask))


def _decode_layer_image(value: Any, size: tuple[int, int]) -> Image.Image | None:
    raw = _decode_data_url(value)
    if not raw:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            layer = image.convert("RGBA")
    except Exception as exc:
        print(f"[{NODE_NAME}] 编辑图层解码失败，已忽略该图层：{exc}")
        return None
    if layer.size != size:
        layer = layer.resize(size, _resampling_filter())
    return layer


def _state_layer_is_visible(item: dict[str, Any]) -> bool:
    value = item.get("visible", True)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        return normalized not in {"", "0", "false", "no", "off", "hidden", "hide", "隐藏"}
    return value is not False


def _state_layer_entries(state: Any) -> list[tuple[int, dict[str, Any]]]:
    if not isinstance(state, dict):
        return []
    layers = state.get("layers")
    if not isinstance(layers, list):
        return []
    return [(index, item) for index, item in enumerate(layers) if isinstance(item, dict)]


def _state_active_layer_index(state: Any) -> int:
    entries = _state_layer_entries(state)
    if not entries:
        return -1
    active_id = str(state.get("activeLayerId") or "").strip() if isinstance(state, dict) else ""
    if active_id:
        for index, item in entries:
            if str(item.get("id") or "").strip() == active_id:
                return index
    return entries[-1][0]


def _state_active_layer_cache_context(state: Any) -> str:
    entries = _state_layer_entries(state)
    if not entries:
        return ""
    active_index = _state_active_layer_index(state)
    active_id = ""
    for index, item in entries:
        if index == active_index:
            active_id = str(item.get("id") or "").strip()
            break
    return json.dumps(
        {
            "activeLayerId": active_id,
            "activeLayerIndex": active_index,
            "layerCount": len(entries),
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _state_layer_payloads(state: Any, active_only: bool = False) -> list[str]:
    if not isinstance(state, dict):
        return []
    payloads: list[str] = []
    entries = _state_layer_entries(state)
    if entries:
        active_index = _state_active_layer_index(state)
        for index, item in entries:
            if active_only and index != active_index:
                continue
            if not isinstance(item, dict) or not _state_layer_is_visible(item):
                continue
            payload = str(item.get("image") or item.get("layerImage") or "").strip()
            if payload:
                payloads.append(payload)
        return payloads
    legacy = str(state.get("layerImage") or state.get("editLayerImage") or state.get("generatedLayerImage") or "").strip()
    return [legacy] if legacy else []


def _state_requests_inpaint(state: Any) -> bool:
    if not isinstance(state, dict):
        return False
    mode = str(state.get("executionMode") or state.get("execution_mode") or "").strip().lower()
    if mode in {"inpaint", "redraw", "repaint", "generate", "内部重绘", "重绘"}:
        return True
    return state.get("runInpaint") is True or state.get("run_inpaint") is True


def _composite_layer_on_tensor(image: torch.Tensor, layer_payload: Any) -> torch.Tensor:
    if not layer_payload:
        return image
    base = _tensor_to_pil(image).convert("RGBA")
    layer = _decode_layer_image(layer_payload, base.size)
    if layer is None:
        return image
    base.alpha_composite(layer)
    return _image_to_tensor(base.convert("RGB")).to(dtype=image.dtype, device=image.device)


def _composite_layers_on_tensor(image: torch.Tensor, layer_payloads: list[str]) -> torch.Tensor:
    result = image
    for layer_payload in layer_payloads:
        result = _composite_layer_on_tensor(result, layer_payload)
    return result


def _composite_generated_layer_on_state(
    image: torch.Tensor,
    state: Any,
    generated_image: torch.Tensor,
    generated_mask: torch.Tensor,
) -> torch.Tensor:
    image_tensor = _single_output_image(image)
    base = _tensor_to_pil(image_tensor).convert("RGBA")
    generated_layer = _tensor_layer_to_pil(generated_image, generated_mask, base.size)
    entries = _state_layer_entries(state)

    if not entries:
        for layer_payload in _state_layer_payloads(state):
            layer = _decode_layer_image(layer_payload, base.size)
            if layer is not None:
                base.alpha_composite(layer)
        base.alpha_composite(generated_layer)
        return _image_to_tensor(base.convert("RGB")).to(dtype=image_tensor.dtype, device=image_tensor.device)

    active_index = _state_active_layer_index(state)
    active_rendered = False
    for index, item in entries:
        is_active = index == active_index
        if not is_active and not _state_layer_is_visible(item):
            continue

        payload = str(item.get("image") or item.get("layerImage") or "").strip()
        layer = _decode_layer_image(payload, base.size) if payload else None
        if is_active:
            if layer is None:
                layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
            layer.alpha_composite(generated_layer)
            active_rendered = True
        if layer is not None:
            base.alpha_composite(layer)

    if not active_rendered:
        base.alpha_composite(generated_layer)
    return _image_to_tensor(base.convert("RGB")).to(dtype=image_tensor.dtype, device=image_tensor.device)


def _mask_to_base64(mask: torch.Tensor) -> str:
    tensor = mask[0] if mask.ndim == 3 else mask
    array = tensor.detach().cpu().float().clamp(0.0, 1.0).numpy()
    image = Image.fromarray((array * 255.0).astype(np.uint8), mode="L")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _ensure_mask(mask: Any) -> torch.Tensor | None:
    if mask is None or not torch.is_tensor(mask):
        return None
    tensor = mask.detach().float()
    if tensor.ndim == 2:
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim == 4:
        if int(tensor.shape[-1]) == 1:
            tensor = tensor[..., 0]
        elif int(tensor.shape[1]) == 1:
            tensor = tensor[:, 0]
        else:
            tensor = tensor.mean(dim=-1)
    if tensor.ndim != 3:
        return None
    tensor = tensor.clamp(0.0, 1.0).contiguous()
    if float(tensor.max().item()) <= 0.001:
        return None
    return tensor


def _resize_image_tensor(image: torch.Tensor, height: int, width: int) -> torch.Tensor:
    image = _ensure_image_batch(image).float()
    if int(image.shape[1]) == int(height) and int(image.shape[2]) == int(width):
        return image
    nchw = image.movedim(-1, 1)
    mode = "area" if int(height) <= int(image.shape[1]) and int(width) <= int(image.shape[2]) else "bicubic"
    resized = F.interpolate(nchw, size=(int(height), int(width)), mode=mode)
    return resized.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _resize_mask_tensor(mask: torch.Tensor, height: int, width: int) -> torch.Tensor:
    mask = _ensure_mask(mask)
    if mask is None:
        return torch.ones((1, int(height), int(width)), dtype=torch.float32)
    if int(mask.shape[1]) == int(height) and int(mask.shape[2]) == int(width):
        return mask
    resized = F.interpolate(
        mask.unsqueeze(1).float(),
        size=(int(height), int(width)),
        mode="bilinear",
        align_corners=False,
    )
    return resized[:, 0].clamp(0.0, 1.0).contiguous()


def _repeat_batch(tensor: torch.Tensor, batch: int, label: str) -> torch.Tensor:
    current = int(tensor.shape[0])
    if current == batch:
        return tensor
    if current == 1:
        return tensor.repeat((batch,) + (1,) * (tensor.ndim - 1))
    raise RuntimeError(f"{label}批次数量为 {current}，图像批次数量为 {batch}，无法自动匹配。")


def _round_to_multiple(value: float, multiple: int = 8) -> int:
    return max(multiple, int(round(float(value) / multiple) * multiple))


def _scale_to_max(image: torch.Tensor, mask: torch.Tensor, largest_size: int) -> tuple[torch.Tensor, torch.Tensor]:
    image = _ensure_image_batch(image).float()
    height = int(image.shape[1])
    width = int(image.shape[2])
    largest_size = _coerce_int(largest_size, DEFAULT_LARGEST_SIZE, 64, 4096)
    if max(height, width) <= largest_size:
        return image, _resize_mask_tensor(mask, height, width)
    ratio = float(largest_size) / float(max(height, width))
    target_height = _round_to_multiple(height * ratio)
    target_width = _round_to_multiple(width * ratio)
    return (
        _resize_image_tensor(image, target_height, target_width),
        _resize_mask_tensor(mask, target_height, target_width),
    )


def _process_mask(mask: torch.Tensor, expand: int, blur_radius: int, blur_sigma: float) -> torch.Tensor:
    mask = _ensure_mask(mask)
    if mask is None:
        raise RuntimeError("遮罩为空。")
    expand = _coerce_int(expand, DEFAULT_MASK_EXPAND, 0, 512)
    blur_radius = _coerce_int(blur_radius, DEFAULT_MASK_BLUR_RADIUS, 0, 512)
    blur_sigma = _coerce_float(blur_sigma, DEFAULT_MASK_BLUR_SIGMA, 0.0, 100.0)
    processed: list[torch.Tensor] = []
    for item in mask:
        array = item.detach().cpu().float().clamp(0.0, 1.0).numpy()
        image = Image.fromarray((array * 255.0).astype(np.uint8), mode="L")
        if expand > 0:
            image = image.filter(ImageFilter.MaxFilter(expand * 2 + 1))
        if blur_radius > 0:
            radius = blur_sigma if blur_sigma > 0 else max(0.1, blur_radius / 3.0)
            image = image.filter(ImageFilter.GaussianBlur(radius=radius))
        processed.append(torch.from_numpy(np.asarray(image, dtype=np.float32) / 255.0))
    return torch.stack(processed, dim=0).clamp(0.0, 1.0).to(mask.device).contiguous()


def _tensor_signature(value: Any) -> str:
    if not torch.is_tensor(value):
        return ""
    try:
        tensor = value.detach().float()
        return "|".join(
            [
                str(tuple(tensor.shape)),
                f"{float(tensor.mean().item()):.8f}",
                f"{float(tensor.std(unbiased=False).item()):.8f}",
            ]
        )
    except Exception:
        return str(tuple(value.shape)) if hasattr(value, "shape") else "tensor"


def _tensor_content_signature(value: Any, label: str = "tensor") -> str:
    if not torch.is_tensor(value):
        return ""
    try:
        tensor = value.detach().cpu().float().clamp(0.0, 1.0).contiguous()
        array = (tensor.numpy() * 255.0).round().astype(np.uint8)
        digest = hashlib.sha256()
        digest.update(str(tuple(array.shape)).encode("utf-8"))
        digest.update(array.tobytes())
        return f"{label}:{tuple(array.shape)}:{digest.hexdigest()}"
    except Exception:
        return f"{label}:{_tensor_signature(value)}"


def _single_output_image(value: torch.Tensor) -> torch.Tensor:
    image = _ensure_image_batch(value).float().clamp(0.0, 1.0)
    return image[:1].contiguous()


def _is_no_lora(value: Any) -> bool:
    text = str(value or "").strip()
    return not text or text == NO_LORA or text == "[未找到模型]"


def _state_cache_signature(state: Any) -> str:
    if not isinstance(state, dict):
        return ""
    return str(
        state.get("cacheSignature")
        or state.get("generationSignature")
        or state.get("generatedCacheSignature")
        or ""
    ).strip()


def _state_generated_payload(state: Any) -> str:
    if not isinstance(state, dict):
        return ""
    return str(state.get("generatedImage") or state.get("generated_image") or "").strip()


def _state_signature_value(state: Any, key: str) -> str:
    if not isinstance(state, dict):
        return ""
    return str(state.get(key) or "").strip()


def _build_generation_signature(
    *,
    image: torch.Tensor,
    mask: torch.Tensor,
    positive_prompt: str,
    negative_prompt: str,
    unet_name: str,
    clip_name: str,
    controlnet_name: str,
    vae_name: str,
    lora_name: str,
    seed: int,
    steps: int,
    cfg: float,
    sampler_name: str,
    scheduler: str,
    denoise: float,
    largest_size: int,
    mask_expand: int,
    mask_blur_radius: int,
    mask_blur_sigma: float,
    control_strength: float,
    start_percent: float,
    end_percent: float,
    lora_strength: float,
    shift: float,
    lora_chain_config: Any = "",
    layer_context: Any = "",
) -> tuple[str, str, str]:
    image_signature = _tensor_content_signature(image, "image")
    mask_signature = _tensor_content_signature(mask, "mask")
    payload = {
        "cache_contract": 2,
        "image_signature": image_signature,
        "mask_signature": mask_signature,
        "positive_prompt": str(positive_prompt or DEFAULT_POSITIVE),
        "negative_prompt": str(negative_prompt if negative_prompt is not None else DEFAULT_NEGATIVE),
        "unet_name": str(unet_name or ""),
        "clip_name": str(clip_name or ""),
        "controlnet_name": str(controlnet_name or ""),
        "vae_name": str(vae_name or ""),
        "lora_name": str(lora_name or ""),
        "seed": int(seed),
        "steps": int(steps),
        "cfg": float(cfg),
        "sampler_name": str(sampler_name or ""),
        "scheduler": str(scheduler or ""),
        "denoise": float(denoise),
        "largest_size": int(largest_size),
        "mask_expand": int(mask_expand),
        "mask_blur_radius": int(mask_blur_radius),
        "mask_blur_sigma": float(mask_blur_sigma),
        "control_strength": float(control_strength),
        "start_percent": float(start_percent),
        "end_percent": float(end_percent),
        "lora_strength": float(lora_strength),
        "shift": float(shift),
        "lora_chain_config": normalize_lora_chain_data(lora_chain_config),
        "layer_context": str(layer_context or ""),
    }
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(text.encode("utf-8")).hexdigest(), image_signature, mask_signature


class GJJ_QwenInstantXInpaintCanvas:
    CATEGORY = "GJJ/图像"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = DESCRIPTION
    SEARCH_ALIASES = [
        "qwen 2512 inpaint",
        "instantx inpaint",
        "qwen instantx",
        "qwen局部重绘",
        "千问局部重绘",
        "交互式局部重绘",
    ]
    RETURN_TYPES = (OUTPUT_IMAGE_TYPE,)
    RETURN_NAMES = ("生成图像",)
    OUTPUT_TOOLTIPS = ("输出单张最终合成 IMAGE，不输出 GJJ_BATCH_IMAGE 批次。",)
    GJJ_HELP = {"title": "千问2512局部重绘画布", **_QWEN_INPAINT_HELP}

    def __init__(self):
        self._runtime_cache_key: tuple[Any, ...] | None = None
        self._runtime_cache_value: tuple[Any, Any, Any] | None = None
        self._loaded_lora_cache: tuple[str, Any] | tuple[str, Any, dict[str, Any]] | None = None
        self._controlnet_apply = GJJ_AliMamaControlNetApply()
        self._generated_cache: dict[str, torch.Tensor] = {}
        self._generated_cache_order: list[str] = []

    @classmethod
    def INPUT_TYPES(cls):
        unets = _list_qwen_or_firered_unets(DEFAULT_UNET)
        clips = _list_qwen_clips(DEFAULT_CLIP)
        controlnets = _list_models("controlnet", DEFAULT_CONTROLNET)
        vaes = _list_models("vae", DEFAULT_VAE)
        loras = _list_models("loras", DEFAULT_LORA, include_none=True)
        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
        return {
            "required": {
                "inpaint_data": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "hidden": True,
                        "display": "hidden",
                        "socketless": True,
                        "advanced": True,
                        "display_name": "内部局部重绘数据",
                        "tooltip": "前端交互面板保存的图像和遮罩数据，请不要手动编辑。",
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_POSITIVE,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "描述遮罩区域希望生成的内容；默认来自工作流。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "反向提示词",
                        "tooltip": "反向提示词；默认来自工作流。",
                    },
                ),
                "unet_name": (
                    unets,
                    {
                        "default": _preferred_default(unets, DEFAULT_UNET),
                        "display_name": "Qwen / FireRed UNET",
                        "tooltip": "只显示文件名包含 qwen 或 firered 的 UNET；支持 diffusion_models/unet_gguf 里的 safetensors 与 GGUF。",
                    },
                ),
                "clip_name": (
                    clips,
                    {
                        "default": _preferred_default(clips, DEFAULT_CLIP),
                        "display_name": "Qwen 2.5 VL CLIP",
                        "tooltip": "工作流 CLIPLoader 的文本编码器，clip_type 固定为 qwen_image；支持 text_encoders/clip_gguf 里的 GGUF。",
                    },
                ),
                "controlnet_name": (
                    controlnets,
                    {
                        "default": _preferred_default(controlnets, DEFAULT_CONTROLNET),
                        "display_name": "InstantX ControlNet",
                        "tooltip": "Qwen-Image-InstantX-ControlNet-Inpainting 模型。",
                    },
                ),
                "vae_name": (
                    vaes,
                    {
                        "default": _preferred_default(vaes, DEFAULT_VAE),
                        "display_name": "Qwen VAE",
                        "tooltip": "工作流 VAELoader 的 VAE 模型。",
                    },
                ),
                "lora_name": (
                    loras,
                    {
                        "default": _preferred_default(loras, DEFAULT_LORA),
                        "display_name": "Lightning LoRA",
                        "tooltip": "工作流 LoraLoaderModelOnly 的模型；可选不使用 LoRA。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": DEFAULT_SEED,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "采样随机种子，默认来自工作流。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": DEFAULT_STEPS,
                        "min": 1,
                        "max": 10000,
                        "display_name": "步数",
                        "tooltip": "KSampler steps，默认 4。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": DEFAULT_CFG,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "round": 0.01,
                        "display_name": "CFG",
                        "tooltip": "KSampler CFG，默认 1。",
                    },
                ),
                "sampler_name": (
                    samplers,
                    {
                        "default": _preferred_default(samplers, DEFAULT_SAMPLER),
                        "display_name": "采样器",
                        "tooltip": "默认 euler。",
                    },
                ),
                "scheduler": (
                    schedulers,
                    {
                        "default": _preferred_default(schedulers, DEFAULT_SCHEDULER),
                        "display_name": "调度器",
                        "tooltip": "默认 simple。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": DEFAULT_DENOISE,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪",
                        "tooltip": "KSampler denoise，默认 1。",
                    },
                ),
                "largest_size": (
                    "INT",
                    {
                        "default": DEFAULT_LARGEST_SIZE,
                        "min": 64,
                        "max": 4096,
                        "step": 8,
                        "display_name": "最大边",
                        "tooltip": "仿工作流 ImageScaleToMaxDimension 的 largest_size，默认 1536。",
                    },
                ),
                "mask_expand": (
                    "INT",
                    {
                        "default": DEFAULT_MASK_EXPAND,
                        "min": 0,
                        "max": 512,
                        "step": 1,
                        "display_name": "遮罩扩展",
                        "tooltip": "仿工作流 GrowMask expand，默认 0。",
                    },
                ),
                "mask_blur_radius": (
                    "INT",
                    {
                        "default": DEFAULT_MASK_BLUR_RADIUS,
                        "min": 0,
                        "max": 512,
                        "step": 1,
                        "display_name": "遮罩模糊半径",
                        "tooltip": "仿工作流 ImageBlur blur_radius，默认 31。",
                    },
                ),
                "mask_blur_sigma": (
                    "FLOAT",
                    {
                        "default": DEFAULT_MASK_BLUR_SIGMA,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "round": 0.01,
                        "display_name": "遮罩模糊 Sigma",
                        "tooltip": "仿工作流 ImageBlur sigma，默认 1。",
                    },
                ),
                "control_strength": (
                    "FLOAT",
                    {
                        "default": DEFAULT_CONTROL_STRENGTH,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.01,
                        "round": 0.001,
                        "display_name": "ControlNet强度",
                        "tooltip": "ControlNet strength，默认 1。",
                    },
                ),
                "start_percent": (
                    "FLOAT",
                    {
                        "default": DEFAULT_START_PERCENT,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.001,
                        "round": 0.001,
                        "display_name": "开始百分比",
                        "tooltip": "ControlNet start_percent，默认 0。",
                    },
                ),
                "end_percent": (
                    "FLOAT",
                    {
                        "default": DEFAULT_END_PERCENT,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.001,
                        "round": 0.001,
                        "display_name": "结束百分比",
                        "tooltip": "ControlNet end_percent，默认 1。",
                    },
                ),
                "lora_strength": (
                    "FLOAT",
                    {
                        "default": DEFAULT_LORA_STRENGTH,
                        "min": -10.0,
                        "max": 10.0,
                        "step": 0.01,
                        "round": 0.001,
                        "display_name": "LoRA强度",
                        "tooltip": "LoraLoaderModelOnly strength，默认 1。",
                    },
                ),
                "shift": (
                    "FLOAT",
                    {
                        "default": DEFAULT_SHIFT,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "round": 0.001,
                        "display_name": "AuraFlow Shift",
                        "tooltip": "ModelSamplingAuraFlow shift，默认 3.1。",
                    },
                ),
            },
            "optional": {
                "image": (
                    INPUT_IMAGE_TYPE,
                    {
                        "display_name": "图像",
                        "tooltip": "可选。连接后优先作为局部重绘原图；不连接则使用面板上传/粘贴图像。",
                    },
                ),
                "mask": (
                    "MASK",
                    {
                        "display_name": "遮罩",
                        "tooltip": "可选。连接后优先作为重绘遮罩；不连接则使用面板绘制遮罩。白色区域会被重绘。",
                    },
                ),
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "display_name": "LoRA串联配置",
                        "tooltip": "可选。接入 GJJ · 额外LoRA串联配置 后，会在节点内部按顺序把多组 LoRA 应用到 Qwen 模型与 CLIP。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        inpaint_data,
        positive_prompt,
        negative_prompt,
        unet_name,
        clip_name,
        controlnet_name,
        vae_name,
        lora_name,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        largest_size,
        mask_expand,
        mask_blur_radius,
        mask_blur_sigma,
        control_strength,
        start_percent,
        end_percent,
        lora_strength,
        shift,
        image=None,
        mask=None,
        lora_chain_config="",
        unique_id=None,
    ):
        payload = json.dumps(
            {
                "contract": 1,
                "inpaint_data": str(inpaint_data or ""),
                "positive_prompt": positive_prompt,
                "negative_prompt": negative_prompt,
                "unet_name": unet_name,
                "clip_name": clip_name,
                "controlnet_name": controlnet_name,
                "vae_name": vae_name,
                "lora_name": lora_name,
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": sampler_name,
                "scheduler": scheduler,
                "denoise": denoise,
                "largest_size": largest_size,
                "mask_expand": mask_expand,
                "mask_blur_radius": mask_blur_radius,
                "mask_blur_sigma": mask_blur_sigma,
                "control_strength": control_strength,
                "start_percent": start_percent,
                "end_percent": end_percent,
                "lora_strength": lora_strength,
                "shift": shift,
                "image": _tensor_signature(image),
                "mask": _tensor_signature(mask),
                "lora_chain_config": normalize_lora_chain_data(lora_chain_config),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _load_runtime(
        self,
        unet_name: str,
        clip_name: str,
        vae_name: str,
        lora_name: str,
        lora_strength: float,
        shift: float,
        lora_chain_config: Any = "",
        unique_id: Any = None,
    ):
        normalized_lora_chain_config = normalize_lora_chain_data(lora_chain_config)
        cache_key = (
            str(unet_name or ""),
            str(clip_name or ""),
            str(vae_name or ""),
            str(lora_name or ""),
            float(lora_strength),
            float(shift),
            normalized_lora_chain_config,
        )
        if self._runtime_cache_key == cache_key and self._runtime_cache_value is not None:
            return self._runtime_cache_value

        model = _load_qwen_unet(unet_name, "default", unique_id=unique_id)
        clip = _load_qwen_clip(clip_name, "qwen_image", "default", unique_id=unique_id)
        vae = _load_vae(vae_name)
        if not _is_no_lora(lora_name):
            model = _apply_lora_model_only(model, lora_name, float(lora_strength))
        if str(normalized_lora_chain_config or "").strip() and normalized_lora_chain_config != "[]":
            def send_lora_applied(payload: dict[str, Any]) -> None:
                name = str(payload.get("name") or "").strip()
                strength = payload.get("strength", "")
                if name:
                    _send_status(unique_id, f"已应用 LoRA串联：{name} ({strength})")

            model, clip, self._loaded_lora_cache = apply_lora_chain_config(
                model,
                clip,
                lora_data=normalized_lora_chain_config,
                loaded_lora_cache=self._loaded_lora_cache,
                on_lora_applied=send_lora_applied,
            )
        model = _apply_aura_flow_shift(model, float(shift))

        self._runtime_cache_key = cache_key
        self._runtime_cache_value = (model, clip, vae)
        return model, clip, vae

    def _remember_generated_cache(self, signature: str, image: torch.Tensor) -> None:
        key = str(signature or "").strip()
        if not key:
            return
        self._generated_cache[key] = _ensure_image_batch(image).detach().cpu().clone()
        if key in self._generated_cache_order:
            self._generated_cache_order.remove(key)
        self._generated_cache_order.append(key)
        while len(self._generated_cache_order) > 3:
            old_key = self._generated_cache_order.pop(0)
            self._generated_cache.pop(old_key, None)

    def _load_generated_cache(self, state: Any, signature: str) -> tuple[torch.Tensor, str, str] | None:
        key = str(signature or "").strip()
        state_key = _state_cache_signature(state)
        lookup_key = state_key if state_key and state_key == key else key
        if not lookup_key:
            return None
        cached = self._generated_cache.get(lookup_key)
        if cached is not None:
            return cached.clone(), _tensor_to_base64(cached), "内存缓存"
        payload = _state_generated_payload(state)
        if not payload or not state_key or state_key != key:
            return None
        tensor = _image_payload_to_tensor(payload)
        if tensor is None:
            return None
        self._remember_generated_cache(state_key, tensor)
        return tensor, payload, "工作流缓存"

    def _resolve_base_image(
        self,
        inpaint_data: str,
        image: Any = None,
        unique_id: Any = None,
    ) -> tuple[torch.Tensor, str]:
        state = _safe_json_loads(inpaint_data, {})
        width = _coerce_int(state.get("width") if isinstance(state, dict) else DEFAULT_WIDTH, DEFAULT_WIDTH, 16, 4096)
        height = _coerce_int(state.get("height") if isinstance(state, dict) else DEFAULT_HEIGHT, DEFAULT_HEIGHT, 16, 4096)

        source = ""
        image_tensor = None
        if torch.is_tensor(image):
            image_tensor = _ensure_image_batch(image).float().clamp(0.0, 1.0)
            source = "上游图像"
        if image_tensor is None:
            pil_image = _load_state_image(inpaint_data, width, height)
            if pil_image is not None:
                image_tensor = _image_to_tensor(pil_image)
                source = "面板图像"
        if image_tensor is None:
            image_tensor = _blank_image(width, height)
            source = "空白画布"
            _send_status(unique_id, "未提供图像，使用空白画布。")
        return _ensure_image_batch(image_tensor).float().clamp(0.0, 1.0), source

    def _resolve_inputs(
        self,
        inpaint_data: str,
        image: Any = None,
        mask: Any = None,
        unique_id: Any = None,
    ) -> tuple[torch.Tensor, torch.Tensor, str, torch.Tensor]:
        state = _safe_json_loads(inpaint_data, {})
        image_tensor, source = self._resolve_base_image(inpaint_data, image=image, unique_id=unique_id)
        base_tensor = image_tensor.clone()
        image_tensor = _composite_layers_on_tensor(image_tensor, _state_layer_payloads(state, active_only=True)).clamp(0.0, 1.0)
        batch = int(image_tensor.shape[0])
        height = int(image_tensor.shape[1])
        width = int(image_tensor.shape[2])

        mask_tensor = _ensure_mask(mask)
        if mask_tensor is None:
            mask_tensor = _load_state_mask(inpaint_data, width, height)
        if mask_tensor is None:
            mask_tensor = torch.ones((1, height, width), dtype=image_tensor.dtype, device=image_tensor.device)
            _send_status(unique_id, "没有遮罩，自动使用全图遮罩生成。")
        else:
            mask_tensor = mask_tensor.to(dtype=image_tensor.dtype, device=image_tensor.device)
            mask_tensor = _resize_mask_tensor(mask_tensor, height, width)
        mask_tensor = _repeat_batch(mask_tensor, batch, "遮罩")
        return image_tensor, mask_tensor, source, base_tensor

    def _run_inpaint(
        self,
        image: torch.Tensor,
        mask: torch.Tensor,
        positive_prompt: str,
        negative_prompt: str,
        unet_name: str,
        clip_name: str,
        controlnet_name: str,
        vae_name: str,
        lora_name: str,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        largest_size: int,
        mask_expand: int,
        mask_blur_radius: int,
        mask_blur_sigma: float,
        control_strength: float,
        start_percent: float,
        end_percent: float,
        lora_strength: float,
        shift: float,
        lora_chain_config: Any = "",
        unique_id: Any = None,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        from nodes import VAEEncode

        _send_status(unique_id, "1/7 加载 Qwen 2512、CLIP、VAE、LoRA...")
        try:
            model, clip, vae = self._load_runtime(
                unet_name,
                clip_name,
                vae_name,
                lora_name,
                lora_strength,
                shift,
                lora_chain_config=lora_chain_config,
                unique_id=unique_id,
            )
        except Exception as exc:
            report = get_report_from_exception(exc)
            if report:
                send_dependency_model_notice(report, unique_id=unique_id)
            detailed_error = (
                "千问局部重绘画布加载模型失败。\n"
                f"UNET: {unet_name}\n"
                f"CLIP: {clip_name}\n"
                f"ControlNet: {controlnet_name}\n"
                f"VAE: {vae_name}\n"
                f"LoRA: {lora_name}\n"
                f"LoRA串联配置: {normalize_lora_chain_data(lora_chain_config)}\n"
                f"详细错误：{exc}"
            )
            wrapped = RuntimeError(detailed_error)
            if report:
                setattr(wrapped, "gjj_report", report)
            raise wrapped from exc

        _send_status(unique_id, "2/7 缩放图像并处理遮罩...")
        scaled_image, scaled_mask = _scale_to_max(image, mask, largest_size)
        processed_mask = _process_mask(
            scaled_mask,
            int(mask_expand),
            int(mask_blur_radius),
            float(mask_blur_sigma),
        )
        processed_mask = _repeat_batch(processed_mask, int(scaled_image.shape[0]), "处理后遮罩")

        _send_status(unique_id, "3/7 编码 Qwen 提示词...")
        positive = _clip_text_encode(clip, str(positive_prompt or DEFAULT_POSITIVE))
        negative = _clip_text_encode(clip, str(negative_prompt if negative_prompt is not None else DEFAULT_NEGATIVE))

        _send_status(unique_id, "4/7 应用 InstantX Inpainting ControlNet...")
        applied = self._controlnet_apply.apply(
            positive,
            negative,
            scaled_image,
            control_net_name=controlnet_name,
            strength=float(control_strength),
            start_percent=float(start_percent),
            end_percent=float(end_percent),
            vae=vae,
            mask=processed_mask,
            unique_id=unique_id,
        )
        if isinstance(applied, dict):
            positive, negative = applied.get("result", (positive, negative))
        else:
            positive, negative = applied

        _send_status(unique_id, "5/7 VAE 编码并写入 latent noise mask...")
        latent = VAEEncode().encode(vae, scaled_image)[0]
        if not isinstance(latent, dict):
            raise RuntimeError("VAEEncode 输出不是 LATENT 字典。")
        latent = latent.copy()
        latent["noise_mask"] = processed_mask

        _send_status(unique_id, "6/7 采样生成局部重绘结果...")
        sampled = _ksampler(
            model,
            int(seed),
            int(steps),
            float(cfg),
            str(sampler_name),
            str(scheduler),
            positive,
            negative,
            latent,
            float(denoise),
        )

        _send_status(unique_id, "7/7 解码并按遮罩合成回原图...")
        decoded = _decode_vae(vae, sampled)
        decoded = _resize_image_tensor(decoded, int(scaled_image.shape[1]), int(scaled_image.shape[2]))
        blend_mask = processed_mask.unsqueeze(-1).to(dtype=decoded.dtype, device=decoded.device)
        result = (decoded * blend_mask + scaled_image.to(decoded.device) * (1.0 - blend_mask)).clamp(0.0, 1.0)
        result = result.contiguous()
        _send_status(unique_id, f"完成：{int(result.shape[2])} × {int(result.shape[1])}")
        return result, scaled_image, processed_mask, decoded

    def generate(
        self,
        inpaint_data: str,
        positive_prompt: str,
        negative_prompt: str,
        unet_name: str,
        clip_name: str,
        controlnet_name: str,
        vae_name: str,
        lora_name: str,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        largest_size: int,
        mask_expand: int,
        mask_blur_radius: int,
        mask_blur_sigma: float,
        control_strength: float,
        start_percent: float,
        end_percent: float,
        lora_strength: float,
        shift: float,
        image=None,
        mask=None,
        lora_chain_config="",
        unique_id=None,
    ):
        state = _safe_json_loads(inpaint_data, {})
        if not _state_requests_inpaint(state):
            base_image, source_label = self._resolve_base_image(
                inpaint_data,
                image=image,
                unique_id=unique_id,
            )
            result = _single_output_image(
                _composite_layers_on_tensor(base_image, _state_layer_payloads(state)).clamp(0.0, 1.0)
            ).contiguous()
            _send_status(unique_id, "已输出当前可见图层合并图，未调用重绘模型。")
            return {
                "ui": {
                    "source_image": [_tensor_to_base64(base_image)],
                    "preview_text": [f"{source_label} → 已合并当前可见图层"],
                },
                "result": (result,),
            }

        source_image, source_mask, source_label, base_image = self._resolve_inputs(
            inpaint_data,
            image=image,
            mask=mask,
            unique_id=unique_id,
        )
        cache_signature, image_signature, mask_signature = _build_generation_signature(
            image=source_image,
            mask=source_mask,
            positive_prompt=positive_prompt,
            negative_prompt=negative_prompt,
            unet_name=unet_name,
            clip_name=clip_name,
            controlnet_name=controlnet_name,
            vae_name=vae_name,
            lora_name=lora_name,
            seed=int(seed),
            steps=int(steps),
            cfg=float(cfg),
            sampler_name=sampler_name,
            scheduler=scheduler,
            denoise=float(denoise),
            largest_size=int(largest_size),
            mask_expand=int(mask_expand),
            mask_blur_radius=int(mask_blur_radius),
            mask_blur_sigma=float(mask_blur_sigma),
            control_strength=float(control_strength),
            start_percent=float(start_percent),
            end_percent=float(end_percent),
            lora_strength=float(lora_strength),
            shift=float(shift),
            lora_chain_config=lora_chain_config,
            layer_context=_state_active_layer_cache_context(state),
        )
        cached = self._load_generated_cache(state, cache_signature)
        if cached is not None:
            cached_tensor, cached_payload, cache_source = cached
            cached_tensor = _single_output_image(cached_tensor)
            generated_signature = _tensor_content_signature(cached_tensor, "generated")
            _send_status(unique_id, f"签名命中，直接输出{cache_source}生成图。")
            return {
                "ui": {
                    "generated_image": [cached_payload],
                    "base_image": [_tensor_to_base64(base_image)],
                    "cache_signature": [cache_signature],
                    "image_signature": [image_signature],
                    "mask_signature": [mask_signature],
                    "generated_signature": [generated_signature],
                    "cache_hit": ["true"],
                    "preview_text": [f"{source_label} → 已命中缓存，未重新生成"],
                },
                "result": (cached_tensor,),
            }
        result, scaled_image, processed_mask, decoded = self._run_inpaint(
            source_image,
            source_mask,
            positive_prompt,
            negative_prompt,
            unet_name,
            clip_name,
            controlnet_name,
            vae_name,
            lora_name,
            int(seed),
            int(steps),
            float(cfg),
            sampler_name,
            scheduler,
            float(denoise),
            int(largest_size),
            int(mask_expand),
            int(mask_blur_radius),
            float(mask_blur_sigma),
            float(control_strength),
            float(start_percent),
            float(end_percent),
            float(lora_strength),
            float(shift),
            lora_chain_config=lora_chain_config,
            unique_id=unique_id,
        )
        result = _single_output_image(result)
        scaled_base_image = _resize_image_tensor(base_image, int(result.shape[1]), int(result.shape[2]))
        result = _composite_generated_layer_on_state(scaled_base_image, state, decoded, processed_mask).contiguous()
        generated_signature = _tensor_content_signature(result, "generated")
        self._remember_generated_cache(cache_signature, result)
        return {
            "ui": {
                "generated_image": [_tensor_to_base64(result)],
                "generated_layer_image": [_tensor_layer_to_base64(decoded, processed_mask)],
                "base_image": [_tensor_to_base64(base_image)],
                "source_image": [_tensor_to_base64(scaled_image)],
                "processed_mask_image": [_mask_to_base64(processed_mask)],
                "cache_signature": [cache_signature],
                "image_signature": [image_signature],
                "mask_signature": [mask_signature],
                "generated_signature": [generated_signature],
                "cache_hit": ["false"],
                "preview_text": [f"{source_label} → Qwen 2512 InstantX 局部重绘完成"],
            },
            "result": (result,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_QwenInstantXInpaintCanvas}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
