from __future__ import annotations

import base64
import io
import json
import math
import re
from typing import Any

import comfy.utils
import torch
from PIL import Image, ImageDraw, ImageFont

from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .gjj_model_bundle_loader import list_clip_models, list_unet_models, list_vae_models
from .common_utils.temp_files import gjjutils_read_temp_pil_image, gjjutils_write_temp_pil_image
from .common_utils.flux2_tools import (
    gjjutils_append_reference_latent,
    gjjutils_encode_text,
    gjjutils_zero_out_conditioning,
)
from .common_utils.model_loader import (
    DEFAULT_UNET_DTYPE,
    gjjutils_load_clip_from_names as _load_clip_from_names,
    gjjutils_load_model as _load_model,
    gjjutils_load_vae as _load_vae,
)
from .common_utils.text_tools import gjjutils_pick_available_name as _pick_available_name
from comfy_extras.nodes_custom_sampler import CFGGuider, KSamplerSelect, RandomNoise, SamplerCustomAdvanced
from comfy_extras.nodes_flux import EmptyFlux2LatentImage, Flux2Scheduler
from nodes import VAEDecode, VAEEncode


NODE_NAME = "GJJ_VisualGridBoard"
IMAGE_INPUT_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
IMAGE_OUTPUT_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
LAYOUT_MODES = ("自动", "1列", "2列", "3列", "4列", "5列", "6列", "2x2", "2x3", "3x2", "3x3", "4x2", "2x4")
FIT_MODES = ("铺满裁切", "完整留白", "拉伸")
DEFAULT_SCRIPT = """**左上：** 主体或场景说明

**右上：** 第二个宫格说明

---
**左下：** 第三个宫格说明

**右下：** 第四个宫格说明"""
DEFAULT_UNET = "flux-2-klein-4b-fp8.safetensors"
DEFAULT_CLIP = "qwen_3_4b.safetensors"
DEFAULT_VAE = "flux2-vae.safetensors"
DEFAULT_NEGATIVE = "low quality, blurry, watermark, bad anatomy, deformed, cropped"
GENERATION_MODES = ("只拼图", "文生图", "图生图")
GENERATION_SCOPES = ("选中宫格", "全部宫格")
_MODEL_CACHE: dict[tuple[str, str, str], tuple[Any, Any, Any]] = {}


def _first_scalar(value: Any) -> Any:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    if isinstance(value, (list, tuple)) and value:
        return value[0]
    return value


def _coerce_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        number = int(round(float(_first_scalar(value))))
    except Exception:
        number = int(fallback)
    return max(minimum, min(maximum, number))


def _coerce_float(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    try:
        number = float(_first_scalar(value))
    except Exception:
        number = float(fallback)
    return max(minimum, min(maximum, number))


def _align32(value: int) -> int:
    return max(32, int(round(value / 32.0)) * 32)


def _normalize_bhwc_tensor(value: torch.Tensor) -> torch.Tensor:
    tensor = value
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim == 5:
        if int(tensor.shape[-1]) in (1, 3, 4):
            tensor = tensor.reshape(-1, tensor.shape[-3], tensor.shape[-2], tensor.shape[-1])
        elif int(tensor.shape[1]) in (1, 3, 4):
            tensor = tensor.permute(0, 2, 3, 4, 1).reshape(-1, tensor.shape[3], tensor.shape[4], tensor.shape[1])
    if tensor.ndim != 4:
        raise RuntimeError(f"可视化宫格收到不支持的图片维度：{tuple(tensor.shape)}。")
    if int(tensor.shape[-1]) not in (1, 2, 3, 4) and int(tensor.shape[1]) in (1, 2, 3, 4):
        tensor = tensor.movedim(1, -1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 2:
        tensor = tensor[..., :1].repeat(1, 1, 1, 3)
    elif channels >= 3:
        tensor = tensor[..., :3]
    else:
        raise RuntimeError(f"可视化宫格收到不支持的通道数：{channels}。")
    return tensor.detach().float().clamp(0.0, 1.0).cpu().contiguous()


def _collect_media_batches(value: Any, batches: list[torch.Tensor]) -> None:
    if value is None:
        return
    if isinstance(value, torch.Tensor):
        batches.append(_normalize_bhwc_tensor(value))
        return
    getter = getattr(value, "get_components", None)
    if callable(getter):
        try:
            components = getter()
        except Exception:
            components = None
        _collect_media_batches(components, batches)
        return
    if isinstance(value, dict):
        for key in ("images", "image", "frames", "frame", "samples", "batch", "items", "value"):
            if key in value:
                _collect_media_batches(value[key], batches)
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            _collect_media_batches(item, batches)


def _split_media(value: Any) -> list[torch.Tensor]:
    batches: list[torch.Tensor] = []
    _collect_media_batches(value, batches)
    images: list[torch.Tensor] = []
    for batch in batches:
        images.extend(batch[index : index + 1].contiguous() for index in range(int(batch.shape[0])))
    return images


def _image_from_data_url(data_url: str) -> torch.Tensor | None:
    raw = str(data_url or "").strip()
    if not raw:
        return None
    if "," in raw and raw.lower().startswith("data:"):
        raw = raw.split(",", 1)[1]
    try:
        data = base64.b64decode(raw, validate=False)
        image = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as exc:
        raise RuntimeError(f"读取节点内参考图失败：{exc}") from exc
    width, height = image.size
    pixels = torch.ByteTensor(torch.ByteStorage.from_buffer(image.tobytes()))
    return pixels.reshape(height, width, 3).float().div(255.0).unsqueeze(0).contiguous()


def _image_from_local_image_data(value: str) -> torch.Tensor | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except Exception:
        payload = None
    if isinstance(payload, dict) and payload.get("filename"):
        try:
            return _pil_to_tensor(gjjutils_read_temp_pil_image(payload).convert("RGB"))
        except Exception as exc:
            raise RuntimeError(f"读取节点内参考图临时文件失败：{exc}") from exc
    return _image_from_data_url(raw)


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    tensor = image[0] if image.ndim == 4 else image
    tensor = tensor.detach().cpu().float().clamp(0.0, 1.0)
    if tensor.ndim == 3 and int(tensor.shape[0]) in (1, 3, 4) and int(tensor.shape[-1]) not in (1, 3, 4):
        tensor = tensor.movedim(0, -1)
    if tensor.ndim == 2:
        tensor = tensor.unsqueeze(-1).repeat(1, 1, 3)
    if int(tensor.shape[-1]) == 1:
        tensor = tensor.repeat(1, 1, 3)
    if int(tensor.shape[-1]) > 3:
        tensor = tensor[..., :3]
    array = (tensor * 255.0).round().byte().numpy()
    return Image.fromarray(array, mode="RGB")


def _tensor_to_base64(image: torch.Tensor) -> str:
    buffer = io.BytesIO()
    _tensor_to_pil(image).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _tensor_to_temp_ref(image: torch.Tensor) -> dict[str, Any]:
    return gjjutils_write_temp_pil_image(_tensor_to_pil(image), format="PNG", suffix=".png", media_type="image")


def _images_from_temp_refs(value: Any) -> list[torch.Tensor]:
    if not isinstance(value, list):
        return []
    result: list[torch.Tensor] = []
    for item in value:
        if not isinstance(item, dict) or not item.get("filename"):
            continue
        try:
            result.append(_pil_to_tensor(gjjutils_read_temp_pil_image(item).convert("RGB")))
        except Exception:
            continue
    return result


def _indexed_images_from_temp_refs(value: Any) -> dict[int, torch.Tensor]:
    if not isinstance(value, list):
        return {}
    result: dict[int, torch.Tensor] = {}
    for index, item in enumerate(value):
        if not isinstance(item, dict) or not item.get("filename"):
            continue
        try:
            result[index] = _pil_to_tensor(gjjutils_read_temp_pil_image(item).convert("RGB"))
        except Exception:
            continue
    return result


def _cell_temp_refs(images: list[torch.Tensor]) -> list[dict[str, Any]]:
    return [_tensor_to_temp_ref(image) for image in images]


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = torch.ByteTensor(torch.ByteStorage.from_buffer(rgb.tobytes()))
    return pixels.reshape(height, width, 3).float().div(255.0).unsqueeze(0).contiguous()


def _load_placeholder_font(size: int) -> ImageFont.ImageFont:
    for path in (
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size=size)
        except Exception:
            pass
    return ImageFont.load_default()


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int, max_lines: int) -> list[str]:
    raw = re.sub(r"\s+", " ", str(text or "").strip())
    if not raw:
        return []
    lines: list[str] = []
    current = ""
    for char in raw:
        test = current + char
        try:
            width = draw.textbbox((0, 0), test, font=font)[2]
        except Exception:
            width = len(test) * 8
        if current and width > max_width:
            lines.append(current)
            current = char
            if len(lines) >= max_lines:
                break
        else:
            current = test
    if current and len(lines) < max_lines:
        lines.append(current)
    if len(lines) == max_lines and len("".join(lines)) < len(raw):
        lines[-1] = lines[-1].rstrip("。,.， ") + "..."
    return lines


def _placeholder_image(text: str, width: int, height: int, index: int) -> torch.Tensor:
    width = max(8, int(width))
    height = max(8, int(height))
    image = Image.new("RGB", (width, height), (238, 244, 241))
    draw = ImageDraw.Draw(image)
    pad = max(10, min(width, height) // 18)
    accent = (67, 155, 98)
    draw.rectangle((0, 0, width - 1, height - 1), outline=(198, 210, 204), width=1)
    draw.rectangle((0, 0, width, max(4, height // 32)), fill=accent)
    title_font = _load_placeholder_font(max(13, min(22, height // 10)))
    body_font = _load_placeholder_font(max(12, min(18, height // 13)))
    label = f"宫格 {index + 1}"
    draw.text((pad, pad), label, fill=(27, 55, 43), font=title_font)
    top = pad + max(20, height // 9)
    max_lines = max(2, (height - top - pad) // max(14, body_font.size + 5 if hasattr(body_font, "size") else 17))
    for line_index, line in enumerate(_wrap_text(draw, text, body_font, max(20, width - pad * 2), max_lines)):
        draw.text((pad, top + line_index * max(16, (body_font.size if hasattr(body_font, "size") else 12) + 5)), line, fill=(47, 65, 61), font=body_font)
    return _pil_to_tensor(image)


def _prompt_parts(text: str) -> list[str]:
    raw = str(text or "").strip()
    if not raw:
        return []
    reference_text = re.split(r"###\s*Target\s+Description\b", raw, flags=re.IGNORECASE)[0]
    reference_text = re.sub(r"^\s*###\s*Reference\s+Sheet\s+Description\s*", "", reference_text, flags=re.IGNORECASE).strip()
    keyword_parts = _keyword_prompt_parts(reference_text)
    if len(keyword_parts) >= 2:
        return keyword_parts
    labeled = list(re.finditer(r"\*\*([^*\n：:]{2,96})\s*[:：]\*\*", reference_text))
    if len(labeled) >= 2:
        parts: list[str] = []
        for index, match in enumerate(labeled):
            start = match.end()
            end = labeled[index + 1].start() if index + 1 < len(labeled) else len(reference_text)
            label = match.group(1).strip()
            body = reference_text[start:end].strip()
            if body:
                parts.append(f"{label}: {body}")
        if parts:
            return parts
    chunks = re.split(r"(?:^\s*---+\s*$)|(?:\n\s*\n+)", raw, flags=re.MULTILINE)
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def _normalize_grid_label(label: str) -> str:
    return re.sub(r"[*_`~#\[\]（）()【】「」『』：:，,。.、\-\s]+", "", str(label or "").strip().lower())


def _grid_label_keyword(label: str) -> str:
    normalized = _normalize_grid_label(label)
    if not normalized:
        return ""
    keywords = (
        "topleft", "topmiddle", "topcenter", "topright", "middlerow", "middleleft", "middlecenter", "middleright",
        "bottomleft", "bottommiddle", "bottomcenter", "bottomright", "frontrow", "backrow", "toprow", "bottomrow",
        "top", "middle", "center", "bottom", "front", "back",
        "左上", "上左", "中上", "上中", "右上", "上右",
        "左中", "中左", "正中", "中心", "中间", "右中", "中右",
        "左下", "下左", "中下", "下中", "右下", "下右",
        "顶部", "顶", "中部", "中", "底部", "底", "前排", "后排",
    )
    return next((keyword for keyword in keywords if normalized.startswith(keyword)), "")


def _grid_label_row(label: str) -> int | None:
    keyword = _grid_label_keyword(label)
    if keyword in {"topleft", "topmiddle", "topcenter", "topright", "toprow", "top", "frontrow", "front", "左上", "上左", "中上", "上中", "右上", "上右", "顶部", "顶", "前排"}:
        return 0
    if keyword in {"middleleft", "middlecenter", "middleright", "middlerow", "middle", "center", "左中", "中左", "正中", "中心", "中间", "右中", "中右", "中部", "中"}:
        return 1
    if keyword in {"bottomleft", "bottommiddle", "bottomcenter", "bottomright", "bottomrow", "bottom", "backrow", "back", "左下", "下左", "中下", "下中", "右下", "下右", "底部", "底", "后排"}:
        return 2
    return None


def _keyword_row_counts(parts: list[str]) -> list[int]:
    rows: list[int] = []
    current_row: int | None = None
    for part in parts:
        label = str(part or "").split(":", 1)[0].strip()
        row = _grid_label_row(label)
        if row is None:
            return []
        if current_row is None or row != current_row:
            rows.append(1)
            current_row = row
        else:
            rows[-1] += 1
    return rows


def _keyword_label_line(line: str) -> tuple[str, str] | None:
    trimmed = str(line or "").strip()
    if not trimmed.startswith("**"):
        return None
    source = trimmed[2:].strip()
    if not source:
        return None
    candidates = [index for index in (source.find("："), source.find(":"), source.find("**")) if index >= 0]
    delimiter = min(candidates) if candidates else -1
    label = (source[:delimiter] if delimiter >= 0 else source).strip()
    if not _grid_label_keyword(label):
        return None
    body = ""
    if delimiter >= 0:
        step = 2 if source[delimiter : delimiter + 2] == "**" else 1
        body = source[delimiter + step :].strip()
        body = re.sub(r"^[:：]\s*", "", body)
        body = re.sub(r"^\*\*\s*", "", body).strip()
    return (re.sub(r"\*+$", "", label).strip(), body)


def _keyword_prompt_parts(reference_text: str) -> list[str]:
    parts: list[str] = []
    saw_marker = False
    current_label = ""
    current_lines: list[str] = []
    for line in str(reference_text or "").splitlines():
        marker = _keyword_label_line(line)
        if marker:
            saw_marker = True
            if current_label:
                body_text = "\n".join(current_lines).strip()
                parts.append(f"{current_label}: {body_text}")
            current_label, body = marker
            current_lines = [body] if body else []
        elif current_label:
            current_lines.append(line)
    if current_label:
        body_text = "\n".join(current_lines).strip()
        parts.append(f"{current_label}: {body_text}")
    if saw_marker and len(parts) >= 2:
        return parts
    return parts


def _contains_any(text: str, keywords: tuple[str, ...]) -> bool:
    lowered = str(text or "").lower()
    return any(keyword.lower() in lowered for keyword in keywords)


def _compact_model_text(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(text or "").lower())


def _is_qwen3_8b_clip(name: str) -> bool:
    compact = _compact_model_text(name)
    return "qwen" in compact and "3" in compact and "8b" in compact


def _is_qwen3_4b_clip(name: str) -> bool:
    compact = _compact_model_text(name)
    return "qwen" in compact and "3" in compact and "4b" in compact


def _is_mistral_flux2_clip(name: str) -> bool:
    compact = _compact_model_text(name)
    return "mistral" in compact and "flux2" in compact


def _is_flux2_klein_4b_unet(name: str) -> bool:
    compact = _compact_model_text(name)
    return ("f2k" in compact or "flux2klein" in compact or ("flux2" in compact and "klein" in compact)) and "4b" in compact


def _is_flux2_klein_9b_unet(name: str) -> bool:
    compact = _compact_model_text(name)
    return ("f2k" in compact or "flux2klein" in compact or ("flux2" in compact and "klein" in compact)) and "9b" in compact


def _is_flux2_dev_unet(name: str) -> bool:
    compact = _compact_model_text(name)
    return "flux2dev" in compact or ("flux2" in compact and "dev" in compact)


def _flux2_unet_models() -> list[str]:
    models = list_unet_models() or [DEFAULT_UNET]
    filtered = [name for name in models if _contains_any(name, ("f2k", "flux2", "flux-2", "klein"))]
    return filtered or models


def _flux2_clip_models() -> list[str]:
    models = list_clip_models() or [DEFAULT_CLIP]
    qwen3_4b = [name for name in models if _is_qwen3_4b_clip(name)]
    qwen3_8b = [name for name in models if _is_qwen3_8b_clip(name)]
    mistral_flux2 = [name for name in models if _is_mistral_flux2_clip(name)]
    compatible = [
        name
        for name in models
        if _contains_any(name, ("qwen_3", "qwen3", "flux2", "flux-2", "mistral"))
    ]
    ordered = [*qwen3_4b, *qwen3_8b, *mistral_flux2, *compatible]
    result: list[str] = []
    seen: set[str] = set()
    for name in ordered:
        if name and name not in seen:
            result.append(name)
            seen.add(name)
    return result or [DEFAULT_CLIP]


def _pick_required_clip(preferred: str, candidates: list[str], unet_name: str, family_label: str) -> str:
    if not candidates:
        raise RuntimeError(
            f"{family_label} 需要使用 {preferred} 文本编码器；当前选择的 UNET 是 {unet_name}，"
            "没有找到匹配 CLIP，不能自动退回其它 CLIP。"
        )
    return _pick_available_name(preferred, candidates, candidates[0])


def _resolve_f2k_clip_name(requested: str, unet_name: str) -> str:
    available = list_clip_models() or [DEFAULT_CLIP]
    if _is_flux2_klein_4b_unet(unet_name):
        qwen3_4b = [name for name in available if _is_qwen3_4b_clip(name)]
        return _pick_required_clip("qwen_3_4b.safetensors", qwen3_4b, unet_name, "Flux2 Klein 4B")
    if _is_flux2_klein_9b_unet(unet_name):
        qwen3_8b = [name for name in available if _is_qwen3_8b_clip(name)]
        return _pick_required_clip("qwen_3_8b_fp8mixed.safetensors", qwen3_8b, unet_name, "Flux2 Klein 9B")
    if _is_flux2_dev_unet(unet_name):
        mistral_flux2 = [name for name in available if _is_mistral_flux2_clip(name)]
        return _pick_required_clip("mistral_3_small_flux2_fp8.safetensors", mistral_flux2, unet_name, "Flux2 Dev")
    return _pick_available_name(DEFAULT_CLIP, available, DEFAULT_CLIP)


def _flux2_vae_models() -> list[str]:
    models = list_vae_models() or [DEFAULT_VAE]
    preferred = [name for name in models if _contains_any(name, ("flux2", "flux-2", "flux_2"))]
    return preferred or models


def _parse_layout(layout_mode: str, count: int, width: int, height: int) -> tuple[int, int]:
    text = str(layout_mode or "自动")
    match = re.match(r"^\s*(\d+)\s*[xX×]\s*(\d+)\s*$", text)
    if match:
        cols = max(1, int(match.group(1)))
        rows = max(1, int(match.group(2)))
        return cols, max(rows, int(math.ceil(max(1, count) / cols)))
    if text.endswith("列") and text[:-1].isdigit():
        cols = max(1, int(text[:-1]))
        return cols, int(math.ceil(max(1, count) / cols))
    count = max(1, count)
    target = max(1, width) / max(1, height)
    best = (count, 1)
    score = float("inf")
    for cols in range(1, count + 1):
        rows = int(math.ceil(count / cols))
        current = abs(math.log(max(0.01, (cols / rows) / target))) + (cols * rows - count) * 0.08
        if current < score:
            best = (cols, rows)
            score = current
    return best


def _default_row_counts(count: int) -> list[int]:
    count = max(1, int(count))
    if count == 1:
        return [1]
    if count <= 3:
        return [count]
    if count <= 5:
        first = int(math.ceil(count / 2))
        return [first, count - first]
    if count == 6:
        return [3, 3]
    if count == 7:
        return [3, 2, 2]
    first = int(math.ceil(count / 3))
    second = int(math.ceil((count - first) / 2))
    third = count - first - second
    return [value for value in (first, second, third) if value > 0]


def _parse_row_counts(value: Any, count: int) -> list[int]:
    if isinstance(value, list):
        rows = [_coerce_int(item, 1, 1, 32) for item in value]
    else:
        rows = [
            _coerce_int(item, 1, 1, 32)
            for item in re.split(r"[,，/|;\s]+", str(value or "").strip())
            if str(item or "").strip()
        ]
    if not rows:
        rows = _default_row_counts(count)
    total = sum(rows)
    if total < count:
        rows[-1] += count - total
    while sum(rows) - rows[-1] >= count and len(rows) > 1:
        rows.pop()
    if sum(rows) > count:
        rows[-1] = max(1, count - sum(rows[:-1]))
    return [row for row in rows if row > 0]


def _normalize_weights(values: Any, expected: int) -> list[float]:
    weights: list[float] = []
    if isinstance(values, list):
        for item in values[:expected]:
            try:
                weights.append(max(0.05, float(item)))
            except Exception:
                weights.append(1.0)
    while len(weights) < expected:
        weights.append(1.0)
    total = sum(weights) or 1.0
    return [value / total for value in weights]


def _layout_rects_from_state(state: dict[str, Any], count: int, width: int, height: int, line_px: int) -> list[tuple[int, int, int, int]]:
    count = max(1, int(count))
    line_px = max(0, int(line_px))
    layout = state.get("variableLayout") if isinstance(state, dict) else None
    if not isinstance(layout, dict):
        layout = {}
    rows = _parse_row_counts(state.get("rowTemplate") or layout.get("rows"), count)
    row_heights = _normalize_weights(layout.get("rowHeights") or state.get("rowHeights"), len(rows))
    row_weights = layout.get("rowWeights")
    if not isinstance(row_weights, list):
        row_weights = []

    inner_h = max(1, height - line_px * (len(rows) + 1))
    rects: list[tuple[int, int, int, int]] = []
    y = line_px
    remaining = count
    for row_index, columns in enumerate(rows):
        columns = max(1, min(int(columns), remaining))
        row_h = max(8, int(round(inner_h * row_heights[row_index])))
        if row_index == len(rows) - 1:
            row_h = max(8, height - line_px - y)
        weights = _normalize_weights(row_weights[row_index] if row_index < len(row_weights) else None, columns)
        inner_w = max(1, width - line_px * (columns + 1))
        x = line_px
        for col_index in range(columns):
            cell_w = max(8, int(round(inner_w * weights[col_index])))
            if col_index == columns - 1:
                cell_w = max(8, width - line_px - x)
            rects.append((x, y, x + cell_w, y + row_h))
            x += cell_w + line_px
            if len(rects) >= count:
                break
        y += row_h + line_px
        remaining -= columns
        if remaining <= 0:
            break
    return rects[:count]


def _dark_line_groups(values: torch.Tensor, min_dark_fraction: float) -> list[tuple[int, int]]:
    groups: list[tuple[int, int]] = []
    start = -1
    for index, value in enumerate(values.tolist()):
        if float(value) >= min_dark_fraction:
            if start < 0:
                start = index
        elif start >= 0:
            groups.append((start, index))
            start = -1
    if start >= 0:
        groups.append((start, len(values)))
    return groups


def _detect_cells_from_black_lines(image: torch.Tensor, min_cell: int = 32) -> list[torch.Tensor]:
    source = _normalize_bhwc_tensor(image)[:1]
    h = int(source.shape[1])
    w = int(source.shape[2])
    if h < min_cell * 2 or w < min_cell * 2:
        return []
    dark = source[0].mean(dim=-1) < 0.055

    def trim_region(left: int, top: int, right: int, bottom: int) -> tuple[int, int, int, int]:
        while right - left > min_cell and dark[top:bottom, left].float().mean().item() > 0.72:
            left += 1
        while right - left > min_cell and dark[top:bottom, right - 1].float().mean().item() > 0.72:
            right -= 1
        while bottom - top > min_cell and dark[top, left:right].float().mean().item() > 0.72:
            top += 1
        while bottom - top > min_cell and dark[bottom - 1, left:right].float().mean().item() > 0.72:
            bottom -= 1
        return left, top, right, bottom

    def split_region(left: int, top: int, right: int, bottom: int, depth: int = 0) -> list[tuple[int, int, int, int]]:
        left, top, right, bottom = trim_region(left, top, right, bottom)
        if depth > 12 or right - left < min_cell * 2 or bottom - top < min_cell * 2:
            return [(left, top, right, bottom)] if right - left >= min_cell and bottom - top >= min_cell else []
        region = dark[top:bottom, left:right]
        row_groups = [
            (start + top, end + top)
            for start, end in _dark_line_groups(region.float().mean(dim=1), 0.76)
            if end - start <= 16 and start >= min_cell and (bottom - top - end) >= min_cell
        ]
        col_groups = [
            (start + left, end + left)
            for start, end in _dark_line_groups(region.float().mean(dim=0), 0.76)
            if end - start <= 16 and start >= min_cell and (right - left - end) >= min_cell
        ]
        if row_groups and (not col_groups or len(row_groups) >= len(col_groups)):
            parts: list[tuple[int, int, int, int]] = []
            cursor = top
            for start, end in row_groups:
                parts.extend(split_region(left, cursor, right, start, depth + 1))
                cursor = end
            parts.extend(split_region(left, cursor, right, bottom, depth + 1))
            return parts
        if col_groups:
            parts = []
            cursor = left
            for start, end in col_groups:
                parts.extend(split_region(cursor, top, start, bottom, depth + 1))
                cursor = end
            parts.extend(split_region(cursor, top, right, bottom, depth + 1))
            return parts
        return [(left, top, right, bottom)]

    regions = split_region(0, 0, w, h)
    if len(regions) <= 1:
        return []
    regions.sort(key=lambda item: (item[1], item[0]))
    return [source[:, top:bottom, left:right, :].contiguous() for left, top, right, bottom in regions]


def _resize_exact(image: torch.Tensor, width: int, height: int, method: str = "lanczos") -> torch.Tensor:
    samples = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(samples, int(width), int(height), method, "disabled")
    return resized.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _cell_transform(transforms: Any, index: int) -> dict[str, float]:
    if not isinstance(transforms, list) or index < 0 or index >= len(transforms):
        return {"scale": 1.0, "offsetX": 0.0, "offsetY": 0.0}
    item = transforms[index]
    if not isinstance(item, dict):
        return {"scale": 1.0, "offsetX": 0.0, "offsetY": 0.0}
    return {
        "scale": _coerce_float(item.get("scale"), 1.0, 0.1, 8.0),
        "offsetX": _coerce_float(item.get("offsetX"), 0.0, -4.0, 4.0),
        "offsetY": _coerce_float(item.get("offsetY"), 0.0, -4.0, 4.0),
    }


def _paste_clipped(canvas: torch.Tensor, image: torch.Tensor, left: int, top: int, width: int, height: int) -> torch.Tensor:
    src_h = int(image.shape[1])
    src_w = int(image.shape[2])
    dst_left = max(0, left)
    dst_top = max(0, top)
    dst_right = min(width, left + src_w)
    dst_bottom = min(height, top + src_h)
    if dst_right <= dst_left or dst_bottom <= dst_top:
        return canvas
    src_left = dst_left - left
    src_top = dst_top - top
    canvas[:, dst_top:dst_bottom, dst_left:dst_right, :] = image[
        :,
        src_top : src_top + (dst_bottom - dst_top),
        src_left : src_left + (dst_right - dst_left),
        :,
    ]
    return canvas


def _fit_cell(image: torch.Tensor, width: int, height: int, fit_mode: str, method: str, transform: dict[str, float] | None = None) -> torch.Tensor:
    source = _normalize_bhwc_tensor(image)[:1]
    transform = transform or {"scale": 1.0, "offsetX": 0.0, "offsetY": 0.0}
    zoom = _coerce_float(transform.get("scale"), 1.0, 0.1, 8.0)
    offset_x = _coerce_float(transform.get("offsetX"), 0.0, -4.0, 4.0)
    offset_y = _coerce_float(transform.get("offsetY"), 0.0, -4.0, 4.0)
    has_transform = abs(zoom - 1.0) > 0.001 or abs(offset_x) > 0.001 or abs(offset_y) > 0.001
    if str(fit_mode) == "拉伸" and not has_transform:
        return _resize_exact(source, width, height, method)
    src_h = max(1, int(source.shape[1]))
    src_w = max(1, int(source.shape[2]))
    cover = str(fit_mode) != "完整留白"
    scale = (max(width / src_w, height / src_h) if cover else min(width / src_w, height / src_h)) * zoom
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    resized = _resize_exact(source, new_w, new_h, method)
    if cover:
        left = int(round((new_w - width) / 2 - offset_x * width))
        top = int(round((new_h - height) / 2 - offset_y * height))
        left = max(0, min(max(0, new_w - width), left))
        top = max(0, min(max(0, new_h - height), top))
        return resized[:, top : top + height, left : left + width, :].contiguous()
    canvas = torch.ones((1, height, width, 3), dtype=torch.float32)
    left = int(round((width - new_w) / 2 + offset_x * width))
    top = int(round((height - new_h) / 2 + offset_y * height))
    canvas = _paste_clipped(canvas, resized, left, top, width, height)
    return canvas.clamp(0.0, 1.0).contiguous()


def _make_grid(
    images: list[torch.Tensor],
    width: int,
    height: int,
    layout_mode: str,
    line_px: int,
    fit_mode: str,
    state: dict[str, Any] | None = None,
) -> torch.Tensor:
    if not images:
        return torch.zeros((1, height, width, 3), dtype=torch.float32)
    line_px = max(0, int(line_px))
    canvas = torch.zeros((1, height, width, 3), dtype=torch.float32)
    transforms = (state or {}).get("cellTransforms") if isinstance(state, dict) else None
    rects = _layout_rects_from_state(state or {}, len(images), width, height, line_px)
    if not rects:
        cols, rows = _parse_layout(layout_mode, len(images), width, height)
        cell_w = max(8, (width - line_px * (cols + 1)) // cols)
        cell_h = max(8, (height - line_px * (rows + 1)) // rows)
        rects = []
        for index in range(min(len(images), cols * rows)):
            row = index // cols
            col = index % cols
            left = line_px + col * (cell_w + line_px)
            top = line_px + row * (cell_h + line_px)
            right = width - line_px if col == cols - 1 else left + cell_w
            bottom = height - line_px if row == rows - 1 else top + cell_h
            rects.append((left, top, right, bottom))
    for index, (image, (left, top, right, bottom)) in enumerate(zip(images, rects)):
        fitted = _fit_cell(image, right - left, bottom - top, fit_mode, "lanczos", _cell_transform(transforms, index))
        canvas[:, top:bottom, left:right, :] = fitted
    return canvas.clamp(0.0, 1.0).contiguous()


def _grid_rects(width: int, height: int, layout_mode: str, count: int, line_px: int, state: dict[str, Any] | None = None) -> list[tuple[int, int, int, int]]:
    count = max(1, int(count))
    rects = _layout_rects_from_state(state or {}, count, width, height, line_px)
    if rects:
        return rects
    cols, rows = _parse_layout(layout_mode, count, width, height)
    cell_w = max(8, (width - line_px * (cols + 1)) // cols)
    cell_h = max(8, (height - line_px * (rows + 1)) // rows)
    result: list[tuple[int, int, int, int]] = []
    for index in range(min(count, cols * rows)):
        row = index // cols
        col = index % cols
        left = line_px + col * (cell_w + line_px)
        top = line_px + row * (cell_h + line_px)
        right = width - line_px if col == cols - 1 else left + cell_w
        bottom = height - line_px if row == rows - 1 else top + cell_h
        result.append((left, top, right, bottom))
    return result


def _ensure_cell_images(
    images: list[torch.Tensor],
    parts: list[str],
    rects: list[tuple[int, int, int, int]],
) -> list[torch.Tensor]:
    result = list(images[: len(rects)])
    while len(result) < len(rects):
        left, top, right, bottom = rects[len(result)]
        text = parts[len(result)] if len(result) < len(parts) else f"宫格 {len(result) + 1}"
        result.append(_placeholder_image(text, right - left, bottom - top, len(result)))
    return result


def _load_pipeline(unet_name: str, clip_name: str, vae_name: str, keep_loaded: bool):
    key = (str(unet_name), str(clip_name), str(vae_name))
    if keep_loaded and key in _MODEL_CACHE:
        return _MODEL_CACHE[key]
    if not keep_loaded:
        _MODEL_CACHE.clear()
    model = _load_model(unet_name, DEFAULT_UNET_DTYPE)
    clip = _load_clip_from_names([clip_name], "flux2")
    vae = _load_vae(vae_name)
    if keep_loaded:
        _MODEL_CACHE.clear()
        _MODEL_CACHE[key] = (model, clip, vae)
    return model, clip, vae


def _generate_f2k_image(
    model: Any,
    clip: Any,
    vae: Any,
    prompt: str,
    negative_prompt: str,
    reference_image: torch.Tensor | None,
    width: int,
    height: int,
    steps: int,
    cfg: float,
    seed: int,
) -> torch.Tensor:
    positive = gjjutils_encode_text(clip, prompt)
    negative = (
        gjjutils_encode_text(clip, negative_prompt)
        if str(negative_prompt or "").strip()
        else gjjutils_zero_out_conditioning(gjjutils_encode_text(clip, prompt))
    )
    if reference_image is not None:
        ref = _fit_cell(reference_image, width, height, "铺满裁切", "lanczos")
        reference_latent = VAEEncode().encode(vae, ref)[0]["samples"]
        positive = gjjutils_append_reference_latent(positive, reference_latent)
        negative = gjjutils_append_reference_latent(negative, reference_latent)

    latent = EmptyFlux2LatentImage.execute(int(width), int(height), 1)[0]
    sigmas = Flux2Scheduler.execute(int(steps), int(width), int(height))[0]
    sampler = KSamplerSelect.execute("euler")[0]
    noise = RandomNoise.execute(int(seed))[0]
    guider = CFGGuider.execute(model, positive, negative, float(cfg))[0]
    sampled = SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, latent)[0]
    return VAEDecode().decode(vae, sampled)[0].clamp(0.0, 1.0).contiguous()


def _cell_size(width: int, height: int, layout_mode: str, count: int, line_px: int, state: dict[str, Any] | None = None, index: int = 0) -> tuple[int, int]:
    rects = _layout_rects_from_state(state or {}, max(1, count), width, height, line_px)
    if rects:
        left, top, right, bottom = rects[max(0, min(index, len(rects) - 1))]
        return max(32, _align32(right - left)), max(32, _align32(bottom - top))
    cols, rows = _parse_layout(layout_mode, max(1, count), width, height)
    line_px = max(0, int(line_px))
    return max(32, _align32((width - line_px * (cols + 1)) // cols)), max(32, _align32((height - line_px * (rows + 1)) // rows))


class GJJ_VisualGridBoard:
    DESCRIPTION = "通用可视化宫格节点。支持导入整张参考板或接入 GJJ_BATCH_IMAGE/IMAGE，按黑色分割线自动切格，2 像素黑线重拼，输出 32 倍数尺寸最终宫格图。"
    SEARCH_ALIASES = ["可视化宫格", "宫格参考板", "参考图替换", "grid board"]
    RETURN_TYPES = (IMAGE_OUTPUT_TYPE,)
    RETURN_NAMES = ("最终宫格图",)
    OUTPUT_TOOLTIPS = ("黑色 2px 分割线、宽高对齐 32 倍数后的最终宫格图。",)
    FUNCTION = "render"
    CATEGORY = "GJJ"
    OUTPUT_NODE = True
    INPUT_IS_LIST = True
    GJJ_HELP = {
        "title": "GJJ · 通用可视化宫格节点",
        "description": DESCRIPTION,
        "usage": [
            "📁 可在节点顶部导入整张参考图；参考图片输入口有连接时，导入按钮会自动失效并以上游为准。",
            "节点会优先按 2px 黑线检测整张参考板的宫格；上游传来多图批次时按批次顺序作为每个宫格。",
            "整体脚本可写在面板，也可从文本输入口连接；文本口连接时优先使用外部文本。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        unet_models = _flux2_unet_models()
        clip_models = _flux2_clip_models()
        vae_models = _flux2_vae_models()
        return {
            "required": {
                "visual_script": (
                    "STRING",
                    {
                        "default": DEFAULT_SCRIPT,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "整体脚本",
                    },
                ),
                "grid_state": ("STRING", {"default": "{}", "multiline": True, "display_name": "界面状态"}),
                "local_image_data": ("STRING", {"default": "", "multiline": True, "display_name": "节点内参考图"}),
                "total_width": ("INT", {"default": 1024, "min": 32, "max": 8192, "step": 32, "display_name": "总宽"}),
                "total_height": ("INT", {"default": 672, "min": 32, "max": 8192, "step": 32, "display_name": "总高"}),
                "layout_mode": (LAYOUT_MODES, {"default": "自动", "display_name": "布局"}),
                "line_px": ("INT", {"default": 2, "min": 0, "max": 32, "step": 1, "display_name": "黑线像素"}),
                "cell_fit": (FIT_MODES, {"default": "铺满裁切", "display_name": "单格适配"}),
                "selected_cell": ("INT", {"default": 1, "min": 1, "max": 256, "step": 1, "display_name": "选中宫格"}),
                "generation_mode": (GENERATION_MODES, {"default": "只拼图", "display_name": "生成模式"}),
                "generation_scope": (GENERATION_SCOPES, {"default": "选中宫格", "display_name": "生成范围"}),
                "negative_prompt": ("STRING", {"default": DEFAULT_NEGATIVE, "multiline": True, "dynamicPrompts": True, "display_name": "反向提示词"}),
                "unet_name": (unet_models, {"default": _pick_available_name(DEFAULT_UNET, unet_models, unet_models[0]), "display_name": "🟣 f2k UNET"}),
                "clip_name": (clip_models, {"default": _pick_available_name(DEFAULT_CLIP, clip_models, clip_models[0]), "display_name": "🔤 f2k CLIP"}),
                "vae_name": (vae_models, {"default": _pick_available_name(DEFAULT_VAE, vae_models, vae_models[0]), "display_name": "🧩 VAE"}),
                "steps": ("INT", {"default": 4, "min": 1, "max": 100, "step": 1, "display_name": "采样步数"}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "display_name": "CFG"}),
                "seed": ("INT", {"default": 352628917855609, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True, "display_name": "种子"}),
                "keep_models_loaded": ("BOOLEAN", {"default": True, "display_name": "模型常驻", "label_on": "常驻", "label_off": "释放"}),
            },
            "optional": {
                "reference_image": (IMAGE_INPUT_TYPE, {"display_name": "参考图片", "tooltip": "支持 GJJ_BATCH_IMAGE、IMAGE；连接时以外部输入为准，📁 导入按钮失效。"}),
                "script_text": ("STRING", {"forceInput": True, "display_name": "文本输入", "tooltip": "可选整体脚本输入；连接后优先覆盖面板脚本。"}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return "|".join(str(kwargs.get(key, "")) for key in sorted(kwargs))

    def render(
        self,
        visual_script,
        grid_state,
        local_image_data,
        total_width,
        total_height,
        layout_mode,
        line_px,
        cell_fit,
        selected_cell,
        generation_mode,
        generation_scope,
        negative_prompt,
        unet_name,
        clip_name,
        vae_name,
        steps,
        cfg,
        seed,
        keep_models_loaded,
        reference_image=None,
        script_text=None,
    ):
        script = str(_first_scalar(script_text) or _first_scalar(visual_script) or "")
        state_raw = str(_first_scalar(grid_state) or "{}")
        try:
            state = json.loads(state_raw) if state_raw else {}
        except Exception:
            state = {}

        width = _align32(_coerce_int(state.get("totalWidth", total_width), 1024, 32, 8192))
        height = _align32(_coerce_int(state.get("totalHeight", total_height), 672, 32, 8192))
        layout = str(state.get("layoutMode") or _first_scalar(layout_mode) or "自动")
        line = _coerce_int(state.get("linePx", line_px), 2, 0, 32)
        fit = str(state.get("cellFit") or _first_scalar(cell_fit) or "铺满裁切")

        images = _split_media(reference_image)
        single_reference_fallback = images[0] if len(images) == 1 else None
        if not images:
            loaded = _image_from_local_image_data(str(_first_scalar(local_image_data) or ""))
            if loaded is not None:
                images = [loaded]
                single_reference_fallback = loaded
        if not images:
            images = _images_from_temp_refs(state.get("generatedCellRefs"))

        if len(images) == 1:
            detected = _detect_cells_from_black_lines(images[0])
            if detected:
                images = detected
        actual_reference_indexes = set(range(len(images)))

        mode = str(_first_scalar(generation_mode) or "只拼图")
        parts = _prompt_parts(script)
        source_image_count = len(images)
        cell_ref_images = _indexed_images_from_temp_refs(state.get("cellImageRefs"))
        generated_ref_images = _indexed_images_from_temp_refs(state.get("generatedCellRefs"))
        generated_indexes = {
            _coerce_int(item, -1, -1, 255)
            for item in state.get("generatedCellIndexes", [])
            if _coerce_int(item, -1, -1, 255) >= 0
        } if isinstance(state.get("generatedCellIndexes"), list) else set()
        cell_ref_count = max(cell_ref_images.keys(), default=-1) + 1
        generated_ref_count = max((index for index in generated_ref_images if index in generated_indexes), default=-1) + 1
        if mode == "只拼图" and source_image_count > 0:
            target_count = max(source_image_count, cell_ref_count, generated_ref_count)
        else:
            target_count = max(1, source_image_count, len(parts), cell_ref_count, generated_ref_count)
        keyword_rows = _keyword_row_counts(parts)
        if (
            keyword_rows
            and sum(keyword_rows) == target_count
            and layout == "自动"
            and not state.get("manualLayout")
            and not state.get("rowTemplate")
        ):
            state["variableLayout"] = {
                "rows": keyword_rows,
                "rowHeights": [1.0 for _ in keyword_rows],
                "rowWeights": [[1.0 for _ in range(cols)] for cols in keyword_rows],
            }
        rects = _grid_rects(width, height, layout, target_count, line, state)
        images = _ensure_cell_images(images, parts, rects)
        selected = max(0, int(_first_scalar(selected_cell) or 1) - 1)
        requested_indexes = state.get("regenerateCellIndexes")
        if mode != "只拼图" and isinstance(requested_indexes, list):
            skip_generated_overlay = {
                max(0, min(target_count - 1, _coerce_int(item, 0, 0, target_count - 1)))
                for item in requested_indexes
            }
        elif mode != "只拼图" and str(_first_scalar(generation_scope) or "选中宫格") == "全部宫格":
            skip_generated_overlay = set(range(target_count))
        elif mode != "只拼图":
            skip_generated_overlay = {min(selected, target_count - 1)}
        else:
            skip_generated_overlay = set()
        for index, image in generated_ref_images.items():
            if index in generated_indexes and index not in skip_generated_overlay and 0 <= index < len(images):
                images[index] = image
        for index, image in cell_ref_images.items():
            if 0 <= index < len(images):
                images[index] = image
                actual_reference_indexes.add(index)
        source_image_count = max(source_image_count, cell_ref_count)

        if mode != "只拼图":
            if not parts:
                raise RuntimeError("f2k 生成需要整体脚本或文本输入。")
            resolved_unet = _pick_available_name(
                str(_first_scalar(unet_name) or DEFAULT_UNET),
                list_unet_models() or [DEFAULT_UNET],
                DEFAULT_UNET,
            )
            resolved_clip = _resolve_f2k_clip_name(str(_first_scalar(clip_name) or DEFAULT_CLIP), resolved_unet)
            model, clip, vae = _load_pipeline(
                resolved_unet,
                resolved_clip,
                _pick_available_name(str(_first_scalar(vae_name) or DEFAULT_VAE), list_vae_models() or [DEFAULT_VAE], DEFAULT_VAE),
                bool(_first_scalar(keep_models_loaded)),
            )
            if isinstance(requested_indexes, list):
                indexes = sorted({
                    max(0, min(target_count - 1, _coerce_int(item, 0, 0, target_count - 1)))
                    for item in requested_indexes
                })
            elif str(_first_scalar(generation_scope) or "选中宫格") == "全部宫格":
                indexes = list(range(target_count))
            else:
                indexes = [min(selected, target_count - 1)]
            for index in indexes:
                left, top, right, bottom = rects[index]
                cell_w = max(8, int(right - left))
                cell_h = max(8, int(bottom - top))
                prompt = parts[index] if index < len(parts) else parts[-1]
                reference = None
                if mode != "文生图":
                    if index in actual_reference_indexes and index < len(images):
                        reference = images[index]
                    elif single_reference_fallback is not None:
                        reference = single_reference_fallback
                images[index] = _generate_f2k_image(
                    model=model,
                    clip=clip,
                    vae=vae,
                    prompt=prompt,
                    negative_prompt=str(_first_scalar(negative_prompt) or ""),
                    reference_image=reference,
                    width=cell_w,
                    height=cell_h,
                    steps=int(_first_scalar(steps) or 4),
                    cfg=float(_first_scalar(cfg) or 1.0),
                    seed=int(_first_scalar(seed) or 0) + index,
                )

        output = _make_grid(images, width, height, layout, line, fit, state)
        output_ref = _tensor_to_temp_ref(output)
        return {"ui": {"selected_image_ref": [output_ref], "generated_cell_refs": [_cell_temp_refs(images)], "cell_count": [len(images)]}, "result": (output,)}


def _register_visual_grid_board_api() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception as exc:
        print(f"[GJJ_VisualGridBoard] 临时文件接口注册失败：{exc}")
        return

    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(server, "_gjj_visual_grid_board_api_registered", False):
        return

    @server.routes.post("/gjj/visual_grid_board/upload_image")
    async def gjj_visual_grid_board_upload_image(request):
        try:
            reader = await request.multipart()
            field = await reader.next()
            if field is None:
                return web.json_response({"ok": False, "error": "没有收到图片文件。"}, status=400)
            data = await field.read(decode=False)
            image = Image.open(io.BytesIO(data)).convert("RGB")
            info = gjjutils_write_temp_pil_image(image, format="PNG", suffix=".png", media_type="image")
            return web.json_response({"ok": True, "image": info})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    server._gjj_visual_grid_board_api_registered = True


_register_visual_grid_board_api()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VisualGridBoard}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔳 可视化宫格生成（F2K）"}
