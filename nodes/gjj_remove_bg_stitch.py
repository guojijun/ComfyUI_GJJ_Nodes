from __future__ import annotations

import json
import math
from typing import Any

import torch
from PIL import Image, ImageChops, ImageColor, ImageFilter

from .common_utils.dependency_checker import (
    build_dependency_model_report,
    make_missing_model_spec,
    raise_dependency_model_error,
)
from .common_utils.temp_files import gjjutils_write_temp_pil_image
from .gjj_comprehensive_matting import (
    METHOD_RMBG14,
    MODEL_DOWNLOAD_URL,
    _coerce_media_tensor,
    _load_rmbg14_model,
    _make_rgba_and_mask,
    _pil_list_to_tensor,
    _resolve_model_path,
    _select_device,
    _tensor_to_pil_list,
)

NODE_NAME = "GJJ_RemoveBgStitch"
NODE_DISPLAY_NAME = "GJJ · 🧩 多对象去背景拼接（添加背景）"
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
BASE_DESCRIPTION = (
    "使用 RMBG1.4 自动抠出全部前景，并把每个可独立调整位置和大小的对象叠加到同一张背景上，最终只输出一张合成图。"
)


def _rmbg14_model_spec() -> dict[str, str]:
    return make_missing_model_spec(
        label="RMBG1.4 模型",
        subdir="RMBG",
        filename="rmbg1.4.pth",
        description="节点内部去背景使用的默认模型。",
    )


def _startup_report() -> dict[str, Any]:
    missing_models: list[dict[str, str]] = []
    try:
        _resolve_model_path(METHOD_RMBG14)
    except Exception:
        missing_models.append(_rmbg14_model_spec())
    return build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_models=missing_models,
        description="去背景拼接节点需要 RMBG1.4 模型才能执行自动抠图。",
        model_download_url=MODEL_DOWNLOAD_URL,
    )


_ENVIRONMENT_REPORT = _startup_report()
_MODELS_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("models_available", True))
DESCRIPTION_TEXT = (
    BASE_DESCRIPTION
    if _MODELS_AVAILABLE
    else f"{_ENVIRONMENT_REPORT['warning_message']}\n\n{BASE_DESCRIPTION}"
)


def _is_video_like(value: Any) -> bool:
    if value is None:
        return False
    if hasattr(value, "get_components"):
        return True
    class_name = type(value).__name__.lower()
    if "video" in class_name:
        return True
    if isinstance(value, dict):
        text = " ".join(str(key).lower() for key in value.keys())
        return "video" in text and any(key in value for key in ("images", "frames", "samples"))
    return False


def _sample_start_middle_end(tensor: torch.Tensor) -> torch.Tensor:
    count = int(tensor.shape[0])
    if count <= 3:
        return tensor
    indices = sorted({0, count // 2, count - 1})
    return tensor[indices]


def _normalize_image_tensor(tensor: torch.Tensor) -> torch.Tensor:
    if not isinstance(tensor, torch.Tensor):
        raise TypeError("输入不是 torch.Tensor。")
    tensor = tensor.detach().float()
    if tensor.ndim == 2:
        tensor = tensor.unsqueeze(-1).unsqueeze(0)
    elif tensor.ndim == 3:
        if tensor.shape[-1] in (1, 3, 4):
            tensor = tensor.unsqueeze(0)
        elif tensor.shape[0] in (1, 3, 4):
            tensor = tensor.permute(1, 2, 0).unsqueeze(0)
        else:
            raise RuntimeError(f"图像张量维度无效：{tuple(tensor.shape)}。")
    elif tensor.ndim == 4:
        if tensor.shape[-1] in (1, 3, 4):
            pass
        elif tensor.shape[1] in (1, 3, 4):
            tensor = tensor.permute(0, 2, 3, 1)
        else:
            raise RuntimeError(f"图像批次张量维度无效：{tuple(tensor.shape)}。")
    else:
        raise RuntimeError(f"图像张量维度无效：{tuple(tensor.shape)}。")

    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels > 4:
        tensor = tensor[..., :3]
    elif channels not in (3, 4):
        raise RuntimeError(f"图像张量通道数无效：{tuple(tensor.shape)}。")
    return tensor.clamp(0.0, 1.0).contiguous()


def _collect_tensor_batches(value: Any) -> list[torch.Tensor]:
    if value is None:
        return []
    if isinstance(value, torch.Tensor):
        return [_normalize_image_tensor(value)]
    if hasattr(value, "get_components"):
        tensor = _coerce_media_tensor(value)
        return [_normalize_image_tensor(tensor)] if tensor is not None else []
    if hasattr(value, "images") and isinstance(getattr(value, "images", None), torch.Tensor):
        return [_normalize_image_tensor(getattr(value, "images"))]
    if isinstance(value, dict):
        batches: list[torch.Tensor] = []
        for key in ("images", "frames", "samples", "image", "batch", "batch_images"):
            if key in value:
                batches.extend(_collect_tensor_batches(value.get(key)))
        return batches
    if isinstance(value, (list, tuple)):
        batches: list[torch.Tensor] = []
        for item in value:
            batches.extend(_collect_tensor_batches(item))
        return batches
    tensor = _coerce_media_tensor(value)
    return [_normalize_image_tensor(tensor)] if tensor is not None else []


def _collect_media_images(value: Any, label: str, *, sample_video: bool = False) -> list[Image.Image]:
    if value is None:
        return []
    try:
        tensors = _collect_tensor_batches(value)
    except Exception as exc:
        raise RuntimeError(f"{label}读取媒体失败：{exc}") from exc
    images: list[Image.Image] = []
    for tensor in tensors:
        if sample_video and _is_video_like(value):
            tensor = _sample_start_middle_end(tensor)
        images.extend(image.convert("RGB") for image in _tensor_to_pil_list(tensor))
    return images


def _tensor_signature(value: Any, *, sample_video: bool = False) -> str:
    try:
        tensors = _collect_tensor_batches(value)
    except Exception as exc:
        return f"error:{type(exc).__name__}:{exc}"
    if not tensors:
        return "none"
    parts: list[str] = []
    for tensor in tensors:
        if sample_video and _is_video_like(value):
            tensor = _sample_start_middle_end(tensor)
        flat = tensor.detach().float().cpu().reshape(-1)
        if flat.numel() > 32768:
            step = max(1, int(math.ceil(flat.numel() / 32768)))
            flat = flat[::step]
        total = float(flat.sum().item()) if flat.numel() else 0.0
        mean = float(flat.mean().item()) if flat.numel() else 0.0
        parts.append(f"{tuple(tensor.shape)}:{total:.6f}:{mean:.6f}")
    return f"{len(parts)}|{'/'.join(parts)}|video={_is_video_like(value)}"


def _color_rgb(value: str, fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    try:
        rgb = ImageColor.getrgb(str(value or "").strip())
        return int(rgb[0]), int(rgb[1]), int(rgb[2])
    except Exception:
        return fallback


def _resample_lanczos():
    return getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)


def _fit_background(
    image: Image.Image | None,
    width: int,
    height: int,
    fit_mode: str,
    color: tuple[int, int, int],
) -> Image.Image:
    canvas = Image.new("RGB", (width, height), color)
    if image is None:
        return canvas
    source = image.convert("RGB")
    if fit_mode == "拉伸填满":
        return source.resize((width, height), _resample_lanczos())
    ratio = max(width / max(1, source.width), height / max(1, source.height))
    if fit_mode == "等比留边":
        ratio = min(width / max(1, source.width), height / max(1, source.height))
    new_w = max(1, int(round(source.width * ratio)))
    new_h = max(1, int(round(source.height * ratio)))
    resized = source.resize((new_w, new_h), _resample_lanczos())
    if fit_mode == "裁切填满":
        left = max(0, (new_w - width) // 2)
        top = max(0, (new_h - height) // 2)
        return resized.crop((left, top, left + width, top + height))
    canvas.paste(resized, ((width - new_w) // 2, (height - new_h) // 2))
    return canvas


def _parse_layer_config(value: str) -> dict[str, dict[str, float]]:
    try:
        parsed = json.loads(str(value or "{}"))
    except Exception:
        return {}
    layers = parsed.get("layers") if isinstance(parsed, dict) else parsed
    if not isinstance(layers, list):
        return {}
    result: dict[str, dict[str, float]] = {}
    for index, item in enumerate(layers):
        if not isinstance(item, dict):
            continue
        layer_id = str(item.get("id") or f"layer_{index + 1:02d}")
        result[layer_id] = {
            "x": _float(item.get("x"), 0.5),
            "y": _float(item.get("y"), 0.55),
            "scale": _float(item.get("scale"), 1.0),
            "opacity": _float(item.get("opacity"), 1.0),
            "z": _float(item.get("z"), index),
        }
    return result


def _float(value: Any, fallback: float) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else fallback
    except Exception:
        return fallback


def _unwrap_scalar(value: Any, fallback: Any = None) -> Any:
    """Restore scalar widgets wrapped by ComfyUI when INPUT_IS_LIST is enabled."""
    try:
        while isinstance(value, (list, tuple)) and len(value) == 1:
            value = value[0]
    except Exception:
        return fallback
    return fallback if value is None else value


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _default_layer(index: int, count: int) -> dict[str, float]:
    if count <= 1:
        x = 0.5
    else:
        x = (index + 1) / (count + 1)
    return {"x": x, "y": 0.56, "scale": 1.0, "opacity": 1.0, "z": float(index)}


def _base_scale(image: Image.Image, canvas_w: int, canvas_h: int) -> float:
    ratio = min(
        canvas_w * 0.42 / max(1, image.width),
        canvas_h * 0.72 / max(1, image.height),
    )
    return _clamp(ratio, 0.04, 2.5)


def _alpha_composite_clipped(canvas: Image.Image, layer: Image.Image, left: int, top: int) -> None:
    right = left + layer.width
    bottom = top + layer.height
    crop_left = max(0, -left)
    crop_top = max(0, -top)
    crop_right = layer.width - max(0, right - canvas.width)
    crop_bottom = layer.height - max(0, bottom - canvas.height)
    if crop_right <= crop_left or crop_bottom <= crop_top:
        return
    cropped = layer.crop((crop_left, crop_top, crop_right, crop_bottom))
    canvas.alpha_composite(cropped, (left + crop_left, top + crop_top))


def _paste_mask_clipped(mask_canvas: Image.Image, mask: Image.Image, left: int, top: int) -> Image.Image:
    layer_canvas = Image.new("L", mask_canvas.size, 0)
    right = left + mask.width
    bottom = top + mask.height
    crop_left = max(0, -left)
    crop_top = max(0, -top)
    crop_right = mask.width - max(0, right - mask_canvas.width)
    crop_bottom = mask.height - max(0, bottom - mask_canvas.height)
    if crop_right <= crop_left or crop_bottom <= crop_top:
        return mask_canvas
    cropped = mask.crop((crop_left, crop_top, crop_right, crop_bottom))
    layer_canvas.paste(cropped, (left + crop_left, top + crop_top))
    return ImageChops.lighter(mask_canvas, layer_canvas)


def _save_temp_image(image: Image.Image, prefix: str, suffix: str = ".png") -> dict[str, Any]:
    return gjjutils_write_temp_pil_image(image, format="PNG", suffix=suffix)


def _apply_opacity(layer: Image.Image, opacity: float) -> Image.Image:
    opacity = _clamp(float(opacity), 0.0, 1.0)
    if opacity >= 0.999:
        return layer
    rgba = layer.convert("RGBA")
    alpha = rgba.getchannel("A").point(lambda value: int(value * opacity))
    rgba.putalpha(alpha)
    return rgba


def _compose_layers(
    *,
    background: Image.Image,
    cutouts: list[Image.Image],
    layer_config: dict[str, dict[str, float]],
) -> tuple[Image.Image, Image.Image, list[dict[str, Any]]]:
    canvas_w, canvas_h = background.size
    canvas = background.convert("RGBA")
    mask_canvas = Image.new("L", (canvas_w, canvas_h), 0)
    metadata: list[dict[str, Any]] = []
    count = len(cutouts)

    prepared_layers: list[dict[str, Any]] = []
    for index, cutout in enumerate(cutouts):
        layer_id = f"layer_{index + 1:02d}"
        defaults = _default_layer(index, count)
        config = {**defaults, **layer_config.get(layer_id, {})}
        x = _clamp(_float(config.get("x"), defaults["x"]), -1.0, 2.0)
        y = _clamp(_float(config.get("y"), defaults["y"]), -1.0, 2.0)
        scale = _clamp(_float(config.get("scale"), defaults["scale"]), 0.02, 6.0)
        opacity = _clamp(_float(config.get("opacity"), defaults["opacity"]), 0.0, 1.0)
        z = _float(config.get("z"), defaults["z"])
        base = _base_scale(cutout, canvas_w, canvas_h)
        layer_w = max(1, int(round(cutout.width * base * scale)))
        layer_h = max(1, int(round(cutout.height * base * scale)))
        layer = cutout.resize((layer_w, layer_h), _resample_lanczos()).convert("RGBA")
        layer = _apply_opacity(layer, opacity)
        left = int(round(x * canvas_w - layer_w / 2))
        top = int(round(y * canvas_h - layer_h / 2))
        prepared_layers.append(
            {
                "index": index,
                "id": layer_id,
                "label": f"对象 {index + 1}",
                "x": x,
                "y": y,
                "scale": scale,
                "opacity": opacity,
                "z": z,
                "source_width": int(cutout.width),
                "source_height": int(cutout.height),
                "base_width": int(round(cutout.width * base)),
                "base_height": int(round(cutout.height * base)),
                "display_width": int(layer_w),
                "display_height": int(layer_h),
                "layer": layer,
                "left": left,
                "top": top,
            }
        )

    for item in sorted(prepared_layers, key=lambda entry: (entry["z"], entry["index"])):
        layer = item["layer"]
        left = item["left"]
        top = item["top"]
        _alpha_composite_clipped(canvas, layer, left, top)
        mask_canvas = _paste_mask_clipped(mask_canvas, layer.getchannel("A"), left, top)
    metadata = [
        {key: value for key, value in item.items() if key not in {"layer", "left", "top", "index"}}
        for item in prepared_layers
    ]

    return canvas.convert("RGB"), mask_canvas, metadata


def _finish_tensors(image: Image.Image, mask: Image.Image) -> tuple[torch.Tensor, torch.Tensor]:
    image_tensor = _pil_list_to_tensor([image.convert("RGB")]).contiguous()
    mask_tensor = _pil_list_to_tensor([mask.convert("L")]).squeeze(-1).contiguous()
    if image_tensor.ndim != 4 or int(image_tensor.shape[0]) != 1:
        raise RuntimeError(f"单张合成图输出维度异常：{tuple(image_tensor.shape)}。")
    if mask_tensor.ndim != 3 or int(mask_tensor.shape[0]) != 1:
        raise RuntimeError(f"单张合成遮罩输出维度异常：{tuple(mask_tensor.shape)}。")
    return image_tensor, mask_tensor


def _run_rmbg14_all_masks(
    model: torch.nn.Module,
    images: list[Image.Image],
    device: torch.device,
    process_res: int,
) -> list[Image.Image]:
    import numpy as np
    import torch.nn.functional as F

    input_size = max(64, int(process_res or 1024))
    tensors: list[torch.Tensor] = []
    for image in images:
        resized = image.convert("RGB").resize((input_size, input_size), _resample_lanczos())
        array = np.asarray(resized, dtype=np.float32) / 255.0
        tensor = torch.from_numpy(array).permute(2, 0, 1)
        tensor = tensor - torch.tensor([0.5, 0.5, 0.5], dtype=tensor.dtype).view(3, 1, 1)
        tensors.append(tensor)
    input_images = torch.stack(tensors, dim=0).to(device=device, dtype=torch.float32)

    with torch.inference_mode():
        raw_output = model(input_images)
    del input_images

    if isinstance(raw_output, (tuple, list)) and raw_output:
        first = raw_output[0]
        if isinstance(first, (tuple, list)) and first:
            predictions = first[0]
        else:
            predictions = first
    else:
        predictions = raw_output
    if not isinstance(predictions, torch.Tensor):
        raise RuntimeError("RMBG1.4 输出格式异常，无法解析遮罩。")
    predictions = predictions.detach().float().cpu()
    if predictions.ndim == 2:
        predictions = predictions.unsqueeze(0).unsqueeze(0)
    elif predictions.ndim == 3:
        if predictions.shape[0] == len(images):
            predictions = predictions.unsqueeze(1)
        else:
            predictions = predictions.unsqueeze(0)
    elif predictions.ndim != 4:
        raise RuntimeError(f"RMBG1.4 输出遮罩维度异常：{tuple(predictions.shape)}。")
    if int(predictions.shape[0]) < len(images):
        raise RuntimeError(f"RMBG1.4 只返回 {int(predictions.shape[0])} 张遮罩，但前景有 {len(images)} 张。")

    masks: list[Image.Image] = []
    for original, prediction in zip(images, predictions):
        if prediction.ndim == 3:
            prediction = prediction[:1].unsqueeze(0)
        resized = F.interpolate(
            prediction,
            size=(original.height, original.width),
            mode="bilinear",
            align_corners=False,
        ).squeeze()
        min_value = torch.min(resized)
        max_value = torch.max(resized)
        if float(max_value - min_value) > 1e-6:
            resized = (resized - min_value) / (max_value - min_value)
        array = np.clip(255.0 * resized.clamp(0, 1).numpy(), 0, 255).astype(np.uint8)
        masks.append(Image.fromarray(array, mode="L"))
    return masks


class GJJ_RemoveBgStitch:
    CATEGORY = "GJJ/Image"
    FUNCTION = "stitch"
    INPUT_IS_LIST = True
    OUTPUT_NODE = True
    DESCRIPTION = DESCRIPTION_TEXT
    SEARCH_ALIASES = ["remove background stitch", "rmbg stitch", "去背景拼接", "抠图拼接", "背景合成", "分层拼接"]
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("单张合成图像", "合成遮罩")
    OUTPUT_IS_LIST = (False, False)
    OUTPUT_TOOLTIPS = (
        "全部前景按各自位置和大小叠加到同一背景后的单张 ComfyUI IMAGE，批次大小固定为 1。",
        "所有前景对象叠加后的合成遮罩。",
    )
    GJJ_HELP = {
        "notice": _ENVIRONMENT_REPORT["help_message"] if not _MODELS_AVAILABLE else "",
        "install_cmd": _ENVIRONMENT_REPORT["install_cmd"],
        "copy_text": _ENVIRONMENT_REPORT["copy_text"],
        "copy_label": _ENVIRONMENT_REPORT["copy_label"],
        "warning_message": _ENVIRONMENT_REPORT["warning_message"],
        "notice_level": _ENVIRONMENT_REPORT["notice_level"],
        "model_download_url": MODEL_DOWNLOAD_URL,
        "models": [
            {
                "label": "🟣RMBG1.4 模型",
                "path": "models/RMBG/rmbg1.4.pth",
                "folder": "RMBG",
                "kind": "diffusion",
                "icon": "🟣",
                "tooltip": "节点内部使用 RMBG1.4 去除前景背景；会在 models 目录下模糊搜索 rmbg1.4 相关 pth 文件。",
            }
        ],
        "usage": [
            "连接前景；背景可不接，未接时使用纯色背景。",
            "VIDEO 前景会抽取开头、中间、结尾三帧作为三个可调对象。",
            "在节点预览里逐个拖动对象，或在对象行里调节大小。刷新后全部对象会合成到同一背景，并只输出一张图像和一张遮罩。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "foreground": (
                    MEDIA_INPUT_TYPE,
                    {
                        "display_name": "前景",
                        "tooltip": "需要去背景并作为对象拼接的前景；支持 GJJ_BATCH_IMAGE、IMAGE 批次和 VIDEO。VIDEO 会抽取开头、中间、结尾帧。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 16,
                        "max": 8192,
                        "step": 8,
                        "display_name": "宽度",
                        "tooltip": "合成画布宽度，由节点内 JS 面板管理。",
                        "hidden": True,
                        "display": "hidden",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 16,
                        "max": 8192,
                        "step": 8,
                        "display_name": "高度",
                        "tooltip": "合成画布高度，由节点内 JS 面板管理。",
                        "hidden": True,
                        "display": "hidden",
                    },
                ),
                "layer_config": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "图层参数",
                        "tooltip": "前端面板维护的图层位置、大小与透明度 JSON。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "background_color": (
                    "COLOR",
                    {
                        "default": "#20262D",
                        "display_name": "背景颜色",
                        "tooltip": "未连接背景图时使用的纯色背景。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "background_fit": (
                    ["裁切填满", "等比留边", "拉伸填满"],
                    {
                        "default": "裁切填满",
                        "display_name": "背景适配",
                        "tooltip": "背景图放入画布时的缩放方式。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "device": (
                    ["自动", "GPU", "CPU"],
                    {
                        "default": "自动",
                        "display_name": "设备",
                        "tooltip": "RMBG1.4 推理设备。自动会优先使用 CUDA。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "process_res": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 64,
                        "max": 4096,
                        "step": 64,
                        "display_name": "抠图分辨率",
                        "tooltip": "RMBG1.4 内部推理分辨率。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "threshold": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "遮罩阈值",
                        "tooltip": "0 保留软遮罩；大于 0 时会二值化。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "mask_blur": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 64.0,
                        "step": 0.5,
                        "display_name": "遮罩羽化",
                        "tooltip": "对 RMBG1.4 输出遮罩做高斯模糊。",
                        "widget": "hidden",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
            },
            "optional": {
                "background": (
                    MEDIA_INPUT_TYPE,
                    {
                        "display_name": "背景",
                        "tooltip": "可选背景图；支持 GJJ_BATCH_IMAGE、IMAGE 和 VIDEO，节点使用第一张背景帧。未连接时使用纯色背景。",
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
        foreground,
        width,
        height,
        background=None,
        layer_config="",
        background_color="#20262D",
        background_fit="裁切填满",
        device="自动",
        process_res=1024,
        threshold=0.0,
        mask_blur=0.0,
        unique_id=None,
    ):
        width = _unwrap_scalar(width, 1024)
        height = _unwrap_scalar(height, 1024)
        layer_config = _unwrap_scalar(layer_config, "")
        background_color = _unwrap_scalar(background_color, "#20262D")
        background_fit = _unwrap_scalar(background_fit, "裁切填满")
        device = _unwrap_scalar(device, "自动")
        process_res = _unwrap_scalar(process_res, 1024)
        threshold = _unwrap_scalar(threshold, 0.0)
        mask_blur = _unwrap_scalar(mask_blur, 0.0)
        model_hint = ""
        try:
            model_hint = str(_resolve_model_path(METHOD_RMBG14))
        except Exception as exc:
            model_hint = f"missing:{exc}"
        return "|".join(
            [
                _tensor_signature(foreground, sample_video=True),
                _tensor_signature(background, sample_video=False),
                str(width),
                str(height),
                str(layer_config or ""),
                str(background_color),
                str(background_fit),
                str(device),
                str(process_res),
                f"{float(threshold):.4f}",
                f"{float(mask_blur):.4f}",
                model_hint,
            ]
        )

    def stitch(
        self,
        foreground,
        width: int,
        height: int,
        background=None,
        layer_config: str = "",
        background_color: str = "#20262D",
        background_fit: str = "裁切填满",
        device: str = "自动",
        process_res: int = 1024,
        threshold: float = 0.0,
        mask_blur: float = 0.0,
        unique_id=None,
    ):
        width = _unwrap_scalar(width, 1024)
        height = _unwrap_scalar(height, 1024)
        layer_config = _unwrap_scalar(layer_config, "")
        background_color = _unwrap_scalar(background_color, "#20262D")
        background_fit = _unwrap_scalar(background_fit, "裁切填满")
        device = _unwrap_scalar(device, "自动")
        process_res = _unwrap_scalar(process_res, 1024)
        threshold = _unwrap_scalar(threshold, 0.0)
        mask_blur = _unwrap_scalar(mask_blur, 0.0)
        unique_id = _unwrap_scalar(unique_id)

        foreground_images = _collect_media_images(foreground, "去背景拼接前景", sample_video=True)
        if not foreground_images:
            raise RuntimeError("去背景拼接至少需要连接一组前景图片或视频。")

        bg_images = _collect_media_images(background, "去背景拼接背景", sample_video=False) if background is not None else []
        target_w = max(16, int(width or 0))
        target_h = max(16, int(height or 0))
        bg_rgb = _color_rgb(background_color, (32, 38, 45))
        bg_image = _fit_background(bg_images[0] if bg_images else None, target_w, target_h, background_fit, bg_rgb)

        try:
            weight_path = _resolve_model_path(METHOD_RMBG14)
        except Exception as exc:
            raise_dependency_model_error(
                node_name=NODE_DISPLAY_NAME,
                missing_models=[_rmbg14_model_spec()],
                description="去背景拼接节点需要 RMBG1.4 模型才能执行自动抠图。",
                original_error=str(exc),
                unique_id=unique_id,
                title="GJJ 去背景拼接模型缺失！",
                model_download_url=MODEL_DOWNLOAD_URL,
            )
        target_device = _select_device(device)
        model = _load_rmbg14_model(weight_path, target_device)
        masks = _run_rmbg14_all_masks(model, foreground_images, target_device, int(process_res or 1024))

        cutouts: list[Image.Image] = []
        for original, mask in zip(foreground_images, masks):
            mask = _postprocess_mask_local(mask, threshold, mask_blur)
            rgba, _ = _make_rgba_and_mask(original, mask)
            cutouts.append(rgba)

        layer_state = _parse_layer_config(layer_config)
        composed, mask, object_meta = _compose_layers(background=bg_image, cutouts=cutouts, layer_config=layer_state)
        image_tensor, mask_tensor = _finish_tensors(composed, mask)

        object_payloads = []
        for meta, cutout in zip(object_meta, cutouts):
            payload = {**meta, **_save_temp_image(cutout, f"{NODE_NAME}_{meta['id']}")}
            object_payloads.append(payload)

        preview_payload = {
            "canvas": {
                "width": target_w,
                "height": target_h,
                "background_color": background_color,
                "background_fit": background_fit,
            },
            "background": _save_temp_image(bg_image, f"{NODE_NAME}_background"),
            "composite": _save_temp_image(composed, f"{NODE_NAME}_composite"),
            "mask": _save_temp_image(mask.convert("RGB"), f"{NODE_NAME}_mask"),
            "objects": object_payloads,
            "layer_config": {
                "version": 1,
                "layers": [
                    {
                        "id": meta["id"],
                        "x": meta["x"],
                        "y": meta["y"],
                        "scale": meta["scale"],
                        "opacity": meta["opacity"],
                        "z": meta["z"],
                    }
                    for meta in object_meta
                ],
            },
        }
        return {"ui": {"gjj_remove_bg_stitch": [preview_payload]}, "result": (image_tensor, mask_tensor)}


def _postprocess_mask_local(mask: Image.Image, threshold: float, blur: float) -> Image.Image:
    mask = mask.convert("L")
    if float(threshold or 0.0) > 0:
        cutoff = int(_clamp(float(threshold), 0.0, 1.0) * 255)
        mask = mask.point(lambda value: 255 if value >= cutoff else 0)
    if float(blur or 0.0) > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=float(blur)))
    return mask


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_RemoveBgStitch}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧩 去背景拼接"}
