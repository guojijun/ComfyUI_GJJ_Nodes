from __future__ import annotations

import base64
import gc
import hashlib
import io
import json
import re
import secrets
import time
from typing import Any

import numpy as np
import torch
from PIL import Image

from .gjj_scribble_controlnet_generator import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_CFG,
    DEFAULT_CHECKPOINT,
    DEFAULT_CONTROLNET,
    DEFAULT_DENOISE,
    DEFAULT_END_PERCENT,
    DEFAULT_NEGATIVE,
    DEFAULT_POSITIVE,
    DEFAULT_SAMPLER,
    DEFAULT_SCHEDULER,
    DEFAULT_START_PERCENT,
    DEFAULT_STEPS,
    DEFAULT_STRENGTH,
    DEFAULT_VAE,
    _list_checkpoints,
    _list_controlnets,
    _load_checkpoint_runtime,
    _load_controlnet_runtime,
    _load_vae_runtime,
    _resolve_default_name,
    _send_status,
)
try:
    from .common_utils.temp_files import gjjutils_read_temp_pil_image, gjjutils_write_temp_pil_image
    from .common_utils.dependency_checker import build_node_help_payload
    from .common_utils.prompt_translation import (
        COMMON_PROMPT_TRANSLATE_API_PATH,
        TRANSLATION_BUNDLE_FILENAME,
        TRANSLATION_BUNDLE_RELATIVE_PATH,
        TRANSLATION_DEPENDENCY_SPECS,
        TRANSLATION_MODEL_DOWNLOAD_URL,
        TRANSLATION_MODEL_SUBDIR,
        build_translation_environment_report,
        register_prompt_translation_api,
        translate_zh_to_en,
    )
except ImportError:
    from common_utils.temp_files import gjjutils_read_temp_pil_image, gjjutils_write_temp_pil_image
    from common_utils.dependency_checker import build_node_help_payload
    from common_utils.prompt_translation import (
        COMMON_PROMPT_TRANSLATE_API_PATH,
        TRANSLATION_BUNDLE_FILENAME,
        TRANSLATION_BUNDLE_RELATIVE_PATH,
        TRANSLATION_DEPENDENCY_SPECS,
        TRANSLATION_MODEL_DOWNLOAD_URL,
        TRANSLATION_MODEL_SUBDIR,
        build_translation_environment_report,
        register_prompt_translation_api,
        translate_zh_to_en,
    )
from nodes import CLIPTextEncode, ControlNetApplyAdvanced, EmptyLatentImage, VAEDecode, common_ksampler


NODE_NAME = "GJJ_DoodleCanvas"
NODE_DISPLAY_NAME = "GJJ · 涂鸦画板"
DEFAULT_WIDTH = 512
DEFAULT_HEIGHT = 512
DEFAULT_BACKGROUND = "#000000"
DEFAULT_BRUSH = "#ffffff"
MIXED_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d"

register_prompt_translation_api((COMMON_PROMPT_TRANSLATE_API_PATH,))

_TRANSLATION_ENVIRONMENT_REPORT = build_translation_environment_report(
    node_name=NODE_DISPLAY_NAME,
    description=(
        "涂鸦画板本身不依赖翻译模型；只有点击主面板的提示词翻译按钮时，"
        f"才需要 {TRANSLATION_MODEL_SUBDIR}/{TRANSLATION_BUNDLE_FILENAME}。"
    ),
)

_SCRIBBLE_CONTROLNET_FILENAME = DEFAULT_CONTROLNET.replace("\\", "/").rsplit("/", 1)[-1]
_DOODLE_MODEL_TREE = [
    {
        "label": "UNET 主模型",
        "path": "models/checkpoints",
        "folder": "checkpoints",
        "subdir": "models/checkpoints",
        "filename": DEFAULT_CHECKPOINT,
        "value": DEFAULT_CHECKPOINT,
        "kind": "checkpoint",
        "description": "必需。内置 Scribble 生成时加载的 SD1.5 checkpoint；可在画板 ⚙️ 设置里改选其它 checkpoints 文件。",
        "icon": "🟣",
    },
    {
        "label": "涂鸦控制模型",
        "path": "models/controlnet/SD1.5",
        "folder": "controlnet/SD1.5",
        "subdir": "models/controlnet/SD1.5",
        "filename": _SCRIBBLE_CONTROLNET_FILENAME,
        "value": _SCRIBBLE_CONTROLNET_FILENAME,
        "kind": "controlnet",
        "description": "必需。Scribble ControlNet 控制模型；默认读取 controlnet/SD1.5 下的 scribble fp16 权重，也可在 ⚙️ 设置里改选。",
        "icon": "🟦",
    },
    {
        "label": "VAE",
        "path": "models/vae",
        "folder": "vae",
        "subdir": "models/vae",
        "filename": DEFAULT_VAE,
        "value": DEFAULT_VAE,
        "kind": "vae",
        "description": "必需。内置生图流程固定使用的 VAE，用于解码采样后的 latent。",
        "icon": "🔴",
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
        "description": "可选。只在点击主面板 🌐 翻译按钮或后端兜底翻译中文提示词时使用；英文提示词生图不依赖它。",
        "icon": "🧠",
    },
]
_DOODLE_MODELS = list(_DOODLE_MODEL_TREE)

_DOODLE_HELP = build_node_help_payload(
    description=(
        "内嵌涂鸦画板，把“画草图、输出控制图、Scribble ControlNet 生图”合成一个节点。\n\n"
        "使用方法：\n"
        "1. 在黑底画布上用自由线/直线/矩形/椭圆等工具画白色线稿，也可以从唯一图像输入口接入 IMAGE 或 GJJ_BATCH_IMAGE。\n"
        "2. 在正向提示词框写生成内容；中文可以点 🌐 翻译，后端也会在生成时尝试兜底翻译。\n"
        "3. 点画板工具栏的输出按钮：🎨 表示输出当前涂鸦；🖼️ 表示输出生成图。\n"
        "4. 选择 🖼️ 后点击 ComfyUI 顶部运行，节点会自动执行内置 Scribble ControlNet 生成；没有缓存生成图时不会再只输出线稿。\n"
        "5. 点击 🚀 只执行当前画板节点，适合单独调试草图到成图。\n\n"
        "输出规则：🎨 输出涂鸦控制图；🖼️ 输出最新生成图。如果输入口接了上游图，接入图会优先作为控制图。"
    ),
    dependencies=[
        {
            "name": spec.get("display_name") or spec.get("package_name") or spec.get("module_name"),
            "type": "提示词翻译可选依赖",
            "required": False,
            "description": spec.get("description", ""),
        }
        for spec in TRANSLATION_DEPENDENCY_SPECS
    ],
    model_tree=_DOODLE_MODEL_TREE,
    models=_DOODLE_MODELS,
    usage=[
        "节点只保留一个可连线输入口和一个输出口；输入口支持 GJJ_BATCH_IMAGE 与 IMAGE，不连接时使用面板涂鸦。",
        "在主画板上绘制线稿；⚙️ 设置里调整画布尺寸、UNET 主模型、涂鸦控制模型和种子。",
        "正向提示词放在主面板；点击“译”可用本地 Opus-MT 模型把中文提示词翻译成英文。",
        "后端生成时若检测到中文提示词，会兜底尝试翻译；翻译失败时继续使用原文，不阻断生成。",
        "点击 🚀 会只执行当前画板节点，生成结果返回后直接替换当前画布并缓存为生成图。",
        "主面板输出按钮可在 🎨 输出涂鸦 和 🖼️ 输出生成图之间切换，最终只走同一个输出口。",
    ],
    runtime=[
        "🖼️ 输出生成图时会设置 generation_mode=generate；后端还会读取画板状态 JSON 的 outputMode/generationMode 做兜底判断。",
        "生图流程复用 GJJ_ScribbleControlNetGenerator 的默认采样参数：20 steps、CFG 6、euler/normal、denoise 1.0、ControlNet strength 1.0。",
        "生成分辨率使用当前画布宽高；模型通过 ComfyUI folder_paths 在对应 models 子目录中查找。",
        "翻译功能走公共 /gjj/common_prompt_translate 接口，后续其他节点也可复用同一公共函数。",
        "常见问题：如果 🖼️ 仍只输出线稿，请确认已重启 ComfyUI 后端；Python 节点逻辑改动只刷新网页不会生效。",
        "常见问题：模型加载失败时，检查 checkpoint、controlnet/SD1.5、vae 三个目录是否存在模型树中列出的文件。",
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
        "model_tree": _DOODLE_MODEL_TREE,
        "models": _DOODLE_MODELS,
        "translation_notice": _TRANSLATION_ENVIRONMENT_REPORT.get("help_message", "")
        if not _TRANSLATION_ENVIRONMENT_REPORT.get("available", True)
        else "",
        "translation_install_cmd": _TRANSLATION_ENVIRONMENT_REPORT.get("install_cmd", ""),
        "translation_copy_text": _TRANSLATION_ENVIRONMENT_REPORT.get("copy_text", ""),
        "translation_model_download_url": _TRANSLATION_ENVIRONMENT_REPORT.get("model_download_url", ""),
        "static_model_tree_only": False,
        "model_tree_priority": "static",
        "troubleshooting": [
            "选择 🖼️ 后运行仍是线稿：重启 ComfyUI 后端，确认浏览器刷新到了新版 js/gjj_doodle_canvas.js。",
            "模型树为空：确认节点帮助面板读取到 GJJ_HELP；本节点声明了 checkpoints、controlnet/SD1.5、vae、translation 四类模型路径。",
            "生成报 checkpoint/controlnet/vae 不存在：把模型放到模型树对应目录，或在 ⚙️ 设置中选择本机已有模型。",
            "中文提示词生成效果差：先点 🌐 翻译；如果翻译模型包缺失，也可以直接输入英文提示词。",
        ],
    },
)


def _filter_control_named_models(names: list[str]) -> list[str]:
    return [
        name
        for name in names
        if "control" in str(name or "").lower() and "sd" in str(name or "").lower()
    ]


def _coerce_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        number = int(round(float(value)))
    except Exception:
        number = int(fallback)
    return max(minimum, min(maximum, number))


def _coerce_bool(value: Any, fallback: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value if value is not None else "").strip().lower()
    if text in {"true", "1", "yes", "on"}:
        return True
    if text in {"false", "0", "no", "off"}:
        return False
    return fallback


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


def _parse_color(value: Any, fallback: tuple[int, int, int] = (0, 0, 0)) -> tuple[int, int, int]:
    text = str(value or "").strip()
    if not text:
        return fallback
    if text.startswith("#"):
        raw = text[1:]
        if len(raw) == 3:
            raw = "".join(ch * 2 for ch in raw)
        if len(raw) >= 6:
            try:
                return tuple(int(raw[index:index + 2], 16) for index in (0, 2, 4))
            except Exception:
                return fallback
    match = re.match(r"rgba?\(([^)]+)\)", text, flags=re.IGNORECASE)
    if match:
        parts = [part.strip() for part in match.group(1).split(",")[:3]]
        if len(parts) != 3:
            return fallback
        try:
            return tuple(max(0, min(255, int(round(float(part))))) for part in parts)
        except Exception:
            return fallback
    return fallback


def _image_payload_from_state(
    value: Any,
    keys: tuple[str, ...] = ("doodleImage", "image", "data_url", "png"),
) -> str:
    state = _safe_json_loads(value, {})
    if isinstance(state, dict):
        image = ""
        for key in keys:
            image = state.get(key) or ""
            if image:
                break
        return str(image or "").strip()
    return str(value or "").strip()


def _image_ref_from_state(value: Any, keys: tuple[str, ...]) -> dict[str, Any] | None:
    state = _safe_json_loads(value, {})
    if not isinstance(state, dict):
        return None
    for key in keys:
        ref = state.get(key)
        if isinstance(ref, dict) and ref.get("filename"):
            return ref
    return None


def _decode_data_url(value: str) -> bytes | None:
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


def _blank_image(width: int, height: int, background_color: str) -> Image.Image:
    return Image.new("RGB", (width, height), _parse_color(background_color))


def _load_doodle_image(doodle_data: Any, width: int, height: int, background_color: str) -> Image.Image:
    raw = _decode_data_url(_image_payload_from_state(doodle_data))
    if not raw:
        return _blank_image(width, height, background_color)

    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            image = image.convert("RGBA")
    except Exception as exc:
        print(f"[GJJ_DoodleCanvas] 涂鸦数据解码失败，已输出空白画布：{exc}")
        return _blank_image(width, height, background_color)

    background = Image.new("RGBA", image.size, (*_parse_color(background_color), 255))
    background.alpha_composite(image)
    result = background.convert("RGB")
    if result.size != (width, height):
        result = result.resize((width, height), _resampling_filter())
    return result


def _finish_loaded_image(image: Image.Image, width: int, height: int, background_color: str) -> Image.Image:
    image = image.convert("RGBA")
    background = Image.new("RGBA", image.size, (*_parse_color(background_color), 255))
    background.alpha_composite(image)
    result = background.convert("RGB")
    if result.size != (width, height):
        result = result.resize((width, height), _resampling_filter())
    return result


def _load_generated_image(doodle_data: Any, width: int, height: int, background_color: str) -> Image.Image | None:
    image_ref = _image_ref_from_state(doodle_data, ("generatedImageRef", "generated_image_ref"))
    if image_ref:
        try:
            image = gjjutils_read_temp_pil_image(image_ref)
            return _finish_loaded_image(image, width, height, background_color)
        except Exception as exc:
            print(f"[GJJ_DoodleCanvas] 生成图临时缓存读取失败，尝试旧缓存：{exc}")

    raw = _decode_data_url(_image_payload_from_state(doodle_data, ("generatedImage", "generated_image")))
    if not raw:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            return _finish_loaded_image(image, width, height, background_color)
    except Exception as exc:
        print(f"[GJJ_DoodleCanvas] 生成图缓存解码失败，已回退到涂鸦输出：{exc}")
        return None


def _image_to_tensor(image: Image.Image) -> torch.Tensor:
    array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0).clamp(0.0, 1.0)


def _image_to_mask(image: Image.Image) -> torch.Tensor:
    array = np.asarray(image.convert("L"), dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0).clamp(0.0, 1.0)


def _image_to_base64(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


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
    return _image_to_base64(_tensor_to_pil(image))


def _image_to_temp_ref(image: Image.Image) -> dict[str, Any]:
    return gjjutils_write_temp_pil_image(image.convert("RGB"), format="PNG", suffix=".png", media_type="image")


def _connected_image_to_pil(image: Any, width: int, height: int) -> Image.Image | None:
    if image is None or not torch.is_tensor(image):
        return None
    try:
        pil_image = _tensor_to_pil(image)
    except Exception as exc:
        print(f"[GJJ_DoodleCanvas] 输入图片读取失败，已回退到面板涂鸦：{exc}")
        return None
    if pil_image.size != (width, height):
        pil_image = pil_image.resize((width, height), _resampling_filter())
    return pil_image


def _image_dimensions_from_tensor(image: Any) -> tuple[int, int] | None:
    if image is None or not torch.is_tensor(image):
        return None
    try:
        shape = tuple(int(part) for part in image.shape)
    except Exception:
        return None
    if len(shape) == 4:
        shape = shape[1:]
    if len(shape) == 3:
        if shape[0] in (1, 3, 4) and shape[-1] not in (1, 3, 4):
            height, width = shape[1], shape[2]
        else:
            height, width = shape[0], shape[1]
    elif len(shape) == 2:
        height, width = shape
    else:
        return None
    return (
        _coerce_int(width, DEFAULT_WIDTH, 16, 4096),
        _coerce_int(height, DEFAULT_HEIGHT, 16, 4096),
    )


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
        return str(tuple(value.shape)) if hasattr(value, "shape") else "image"


def _contains_cjk(text: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", str(text or "")))


def _state_mode(state: Any, key: str, fallback: str, valid: tuple[str, ...]) -> str:
    value = ""
    if isinstance(state, dict):
        value = str(state.get(key) or "").strip().lower()
    if value in valid:
        return value
    fallback_value = str(fallback or "").strip().lower()
    return fallback_value if fallback_value in valid else valid[0]


def _maybe_translate_prompt(prompt: str, unique_id: Any = None) -> str:
    text = str(prompt or "").strip() or DEFAULT_POSITIVE
    if not _contains_cjk(text):
        return text
    _send_status(unique_id, "检测到中文提示词，后台尝试翻译...")
    try:
        translated = translate_zh_to_en(
            text,
            "auto",
            max_length=512,
            batch_size=8,
            unload_after_use=False,
            unique_id=unique_id,
            node_name=NODE_DISPLAY_NAME,
        )
        translated = str(translated or "").strip()
        if translated:
            _send_status(unique_id, "后台提示词翻译完成。")
            return translated
    except Exception as exc:
        print(f"[GJJ_DoodleCanvas] 后台提示词兜底翻译失败，继续使用原文：{exc}")
        _send_status(unique_id, "后台翻译不可用，继续使用原文提示词。")
    return text


class GJJ_DoodleCanvas:
    CATEGORY = "GJJ/图像"
    FUNCTION = "make_image"
    OUTPUT_NODE = True
    DESCRIPTION = "内嵌涂鸦画板。可直接在 ComfyUI 节点中画草图、线稿，并内置 Scribble ControlNet 一键原地生图。"
    SEARCH_ALIASES = ["doodle", "scribble", "paint", "画板", "涂鸦", "草图", "线稿", "涂鸦生图"]
    RETURN_TYPES = (MIXED_IMAGE_TYPE,)
    RETURN_NAMES = ("图像",)
    OUTPUT_TOOLTIPS = (
        "由面板输出按钮控制：输出当前涂鸦或最近一次 Scribble 生成图；类型兼容 GJJ_BATCH_IMAGE 与 IMAGE。",
    )
    GJJ_HELP = {"title": "涂鸦画板", **_DOODLE_HELP}

    def __init__(self):
        self._scribble_runtime_cache_key: tuple[str, str, str] | None = None
        self._scribble_runtime_cache_value: tuple[Any, Any, Any, Any] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = _list_checkpoints() or [DEFAULT_CHECKPOINT]
        controlnets = _filter_control_named_models(_list_controlnets()) or [DEFAULT_CONTROLNET]
        return {
            "required": {
                "doodle_data": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "hidden": True,
                        "display": "hidden",
                        "socketless": True,
                        "advanced": True,
                        "display_name": "内部涂鸦数据",
                        "tooltip": "前端画板保存的 PNG 数据，请不要手动编辑。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": DEFAULT_WIDTH,
                        "min": 16,
                        "max": 4096,
                        "step": 8,
                        "display_name": "画布宽度",
                        "tooltip": "涂鸦画布宽度。修改后会保留已有内容的左上区域。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": DEFAULT_HEIGHT,
                        "min": 16,
                        "max": 4096,
                        "step": 8,
                        "display_name": "画布高度",
                        "tooltip": "涂鸦画布高度。修改后会保留已有内容的左上区域。",
                    },
                ),
                "background_color": (
                    "STRING",
                    {
                        "default": DEFAULT_BACKGROUND,
                        "multiline": False,
                        "hidden": True,
                        "display": "hidden",
                        "socketless": True,
                        "advanced": True,
                        "display_name": "背景颜色",
                        "tooltip": "画板背景和橡皮擦颜色。",
                    },
                ),
                "default_brush_color": (
                    "STRING",
                    {
                        "default": DEFAULT_BRUSH,
                        "multiline": False,
                        "hidden": True,
                        "display": "hidden",
                        "socketless": True,
                        "advanced": True,
                        "display_name": "画笔颜色",
                        "tooltip": "当前画笔颜色。",
                    },
                ),
                "default_brush_size": (
                    "INT",
                    {
                        "default": 6,
                        "min": 1,
                        "max": 256,
                        "step": 1,
                        "hidden": True,
                        "display": "hidden",
                        "socketless": True,
                        "advanced": True,
                        "display_name": "画笔大小",
                        "tooltip": "当前画笔粗细。",
                    },
                ),
                "generation_mode": (
                    ["doodle", "generate"],
                    {
                        "default": "doodle",
                        "hidden": True,
                        "display": "hidden",
                        "socketless": True,
                        "advanced": True,
                        "display_name": "执行模式",
                        "tooltip": "前端 ✔ 按钮内部使用。doodle 只输出画布；generate 会执行 Scribble ControlNet 并回写生成图。",
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_POSITIVE,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "点击 ✔ 原地生成时使用的正向提示词。",
                    },
                ),
                "ckpt_name": (
                    checkpoints,
                    {
                        "default": DEFAULT_CHECKPOINT if DEFAULT_CHECKPOINT in checkpoints else checkpoints[0],
                        "display_name": "UNET 主模型",
                        "tooltip": "点击 ✔ 原地生成时使用的底模 checkpoint。",
                    },
                ),
                "controlnet_name": (
                    controlnets,
                    {
                        "default": _resolve_default_name(controlnets, DEFAULT_CONTROLNET),
                        "display_name": "涂鸦控制模型",
                        "tooltip": "点击 ✔ 原地生成时使用的 Scribble ControlNet 模型。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 240272355371031,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": False,
                        "display_name": "种子",
                        "tooltip": "点击 ✔ 原地生成时使用的采样随机种子。",
                    },
                ),
                "output_mode": (
                    ["doodle", "generated"],
                    {
                        "default": "doodle",
                        "hidden": True,
                        "display": "hidden",
                        "socketless": True,
                        "advanced": True,
                        "display_name": "输出模式",
                        "tooltip": "前端输出按钮内部使用。doodle 输出涂鸦；generated 输出最近一次生成图。",
                    },
                ),
                "auto_upstream_size": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "hidden": True,
                        "display": "hidden",
                        "socketless": True,
                        "advanced": True,
                        "display_name": "上游图尺寸",
                        "tooltip": "📐 按钮内部使用。开启后，连接上游图像时画布尺寸自动使用上游图像宽高。",
                    },
                ),
                "randomize_seed": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "hidden": True,
                        "display": "hidden",
                        "socketless": True,
                        "advanced": True,
                        "display_name": "随机种子",
                        "tooltip": "🎲 按钮内部使用。开启后，每次提交运行前自动更换种子；关闭时固定当前种子。",
                    },
                ),
                "keep_model": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "hidden": True,
                        "display": "hidden",
                        "socketless": True,
                        "advanced": True,
                        "display_name": "保留模型",
                        "tooltip": "🧠 按钮内部使用。开启后保留 Scribble 生成模型缓存；关闭后每次执行完成都会卸载缓存模型。",
                    },
                ),
            },
            "optional": {
                "image": (
                    MIXED_IMAGE_TYPE,
                    {
                        "display_name": "图像",
                        "tooltip": "唯一可连线输入口。支持 GJJ_BATCH_IMAGE 与 IMAGE；连接后优先作为涂鸦/控制图，不连接则使用面板画布。",
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
        doodle_data,
        width,
        height,
        background_color,
        default_brush_color,
        default_brush_size,
        generation_mode,
        positive_prompt,
        ckpt_name,
        controlnet_name,
        seed,
        output_mode,
        auto_upstream_size=True,
        randomize_seed=False,
        keep_model=True,
        image=None,
        unique_id=None,
    ):
        randomize_seed = _coerce_bool(randomize_seed, False)
        keep_model = _coerce_bool(keep_model, True)
        payload = json.dumps(
            {
                "auto_generate_contract": 2,
                "random_tick": f"{time.time_ns()}:{secrets.randbits(64)}" if randomize_seed else "",
                "doodle_data": str(doodle_data or ""),
                "width": width,
                "height": height,
                "background_color": background_color,
                "default_brush_color": default_brush_color,
                "default_brush_size": default_brush_size,
                "generation_mode": generation_mode,
                "positive_prompt": positive_prompt,
                "ckpt_name": ckpt_name,
                "controlnet_name": controlnet_name,
                "seed": seed,
                "output_mode": output_mode,
                "auto_upstream_size": _coerce_bool(auto_upstream_size, True),
                "randomize_seed": randomize_seed,
                "keep_model": keep_model,
                "image": _tensor_signature(image),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _load_scribble_runtime(self, ckpt_name: str, controlnet_name: str):
        cache_key = (str(ckpt_name or ""), DEFAULT_VAE, str(controlnet_name or ""))
        if self._scribble_runtime_cache_key == cache_key and self._scribble_runtime_cache_value is not None:
            return self._scribble_runtime_cache_value

        model, clip = _load_checkpoint_runtime(ckpt_name)
        vae = _load_vae_runtime(DEFAULT_VAE)
        controlnet = _load_controlnet_runtime(controlnet_name)

        self._scribble_runtime_cache_key = cache_key
        self._scribble_runtime_cache_value = (model, clip, vae, controlnet)
        return model, clip, vae, controlnet

    def _clear_scribble_runtime_cache(self, unique_id: Any = None) -> None:
        self._scribble_runtime_cache_key = None
        self._scribble_runtime_cache_value = None
        gc.collect()
        try:
            import comfy.model_management as model_management
            for name in ("unload_all_models", "cleanup_models", "cleanup_models_gc"):
                cleanup = getattr(model_management, name, None)
                if callable(cleanup):
                    try:
                        cleanup()
                    except Exception:
                        pass
            empty_cache = getattr(model_management, "soft_empty_cache", None)
            if callable(empty_cache):
                try:
                    empty_cache(force=True)
                except TypeError:
                    empty_cache()
        except Exception:
            pass
        _send_status(unique_id, "🧠 模型保留已关闭：已请求卸载 Scribble 生成模型")

    def _generate_scribble(
        self,
        image_tensor: torch.Tensor,
        width: int,
        height: int,
        positive_prompt: str,
        ckpt_name: str,
        controlnet_name: str,
        seed: int,
        unique_id: Any = None,
    ) -> torch.Tensor:
        _send_status(unique_id, "1/6 检查并加载底模、VAE 与 Scribble ControlNet...")
        try:
            model, clip, vae, controlnet = self._load_scribble_runtime(ckpt_name, controlnet_name)
        except Exception as exc:
            raise RuntimeError(
                "涂鸦画板内置 Scribble ControlNet 加载模型失败。\n"
                f"Checkpoint: {ckpt_name}\n"
                f"VAE: {DEFAULT_VAE}\n"
                f"ControlNet: {controlnet_name}\n"
                f"详细错误：{exc}"
            ) from exc

        _send_status(unique_id, "2/6 编码提示词...")
        encoded_prompt = _maybe_translate_prompt(positive_prompt, unique_id=unique_id)
        positive = CLIPTextEncode().encode(clip, encoded_prompt)[0]
        negative = CLIPTextEncode().encode(clip, DEFAULT_NEGATIVE)[0]

        _send_status(unique_id, "3/6 应用 Scribble ControlNet...")
        positive, negative = ControlNetApplyAdvanced().apply_controlnet(
            positive,
            negative,
            controlnet,
            image_tensor,
            DEFAULT_STRENGTH,
            DEFAULT_START_PERCENT,
            DEFAULT_END_PERCENT,
            vae=None,
        )

        _send_status(unique_id, "4/6 构建 Latent...")
        latent = EmptyLatentImage().generate(width, height, DEFAULT_BATCH_SIZE)[0]

        _send_status(unique_id, "5/6 采样生成...")
        sampled = common_ksampler(
            model,
            int(seed),
            DEFAULT_STEPS,
            DEFAULT_CFG,
            DEFAULT_SAMPLER,
            DEFAULT_SCHEDULER,
            positive,
            negative,
            latent,
            denoise=DEFAULT_DENOISE,
        )[0]

        _send_status(unique_id, "6/6 解码生成图像...")
        result = VAEDecode().decode(vae, sampled)[0]
        _send_status(unique_id, f"完成：{int(result.shape[2])} × {int(result.shape[1])}")
        return result

    def make_image(
        self,
        doodle_data: str,
        width: int,
        height: int,
        background_color: str,
        default_brush_color: str,
        default_brush_size: int,
        generation_mode: str,
        positive_prompt: str,
        ckpt_name: str,
        controlnet_name: str,
        seed: int,
        output_mode: str,
        auto_upstream_size: bool = True,
        randomize_seed: bool = False,
        keep_model: bool = True,
        image=None,
        unique_id=None,
    ):
        width = _coerce_int(width, DEFAULT_WIDTH, 16, 4096)
        height = _coerce_int(height, DEFAULT_HEIGHT, 16, 4096)
        auto_upstream_size = _coerce_bool(auto_upstream_size, True)
        randomize_seed = _coerce_bool(randomize_seed, False)
        keep_model = _coerce_bool(keep_model, True)
        if randomize_seed:
            seed = secrets.randbits(64)
        if auto_upstream_size:
            upstream_dimensions = _image_dimensions_from_tensor(image)
            if upstream_dimensions is not None:
                width, height = upstream_dimensions
        background = background_color or DEFAULT_BACKGROUND
        connected_image = _connected_image_to_pil(image, width, height)
        has_connected_image = connected_image is not None
        doodle_image = connected_image or _load_doodle_image(doodle_data, width, height, background)
        doodle_tensor = _image_to_tensor(doodle_image)
        selected_tensor = doodle_tensor
        selected_image = doodle_image
        ui = {"doodle_image": [_image_to_base64(doodle_image)]}
        state = _safe_json_loads(doodle_data, {})
        generation_mode_key = _state_mode(
            state,
            "generationMode",
            generation_mode,
            ("doodle", "generate"),
        )
        output_mode_key = _state_mode(
            state,
            "outputMode",
            output_mode,
            ("doodle", "generated"),
        )
        wants_generated_output = output_mode_key == "generated"
        cached_generated_image = None
        if wants_generated_output and not randomize_seed and not has_connected_image:
            cached_generated_image = _load_generated_image(doodle_data, width, height, background)

        try:
            if wants_generated_output and cached_generated_image is not None:
                selected_image = cached_generated_image
                selected_tensor = _image_to_tensor(cached_generated_image)
                ui["generated_image"] = [_image_to_base64(cached_generated_image)]
                ui["generated_image_ref"] = [_image_to_temp_ref(cached_generated_image)]
            elif generation_mode_key == "generate" or (wants_generated_output and cached_generated_image is None):
                if wants_generated_output and generation_mode_key != "generate":
                    _send_status(unique_id, "已选择输出生成图，自动执行 Scribble 生成...")
                generated_tensor = self._generate_scribble(
                    doodle_tensor,
                    width,
                    height,
                    positive_prompt,
                    ckpt_name,
                    controlnet_name,
                    seed,
                    unique_id=unique_id,
                )
                generated_image = _tensor_to_pil(generated_tensor)
                generated_ref = _image_to_temp_ref(generated_image)
                ui["generated_image"] = [_tensor_to_base64(generated_tensor)]
                ui["generated_image_ref"] = [generated_ref]
                if wants_generated_output:
                    selected_tensor = generated_tensor
                    selected_image = generated_image
            elif wants_generated_output:
                ui["generated_image"] = []
            return {
                "ui": {**ui, "selected_image": [_image_to_base64(selected_image)]},
                "result": (selected_tensor,),
            }
        finally:
            if not keep_model:
                self._clear_scribble_runtime_cache(unique_id)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_DoodleCanvas}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🖌 涂鸦画板"}
