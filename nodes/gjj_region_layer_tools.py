from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    from aiohttp import web
    from server import PromptServer
except Exception:
    web = None
    PromptServer = None


REGION_TYPE = "GJJ_REGION"
REGION_CROP_MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
REGION_CROP_SETTINGS_KEY = "region_crop"
REGION_CROP_SETTINGS_DEFAULTS = {"total_pixels": 10, "align_multiple": 8}
USER_SETTINGS_PATH = Path(__file__).resolve().parents[1] / "presets" / "gjj_user_settings.json"


def _normalize_image(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise ValueError("图像输入必须是 IMAGE。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise ValueError("图像维度不正确。")
    if image.shape[-1] not in (1, 2, 3, 4) and image.shape[1] in (1, 2, 3, 4):
        image = image.permute(0, 2, 3, 1)
    if image.shape[-1] == 1:
        image = image.repeat(1, 1, 1, 3)
    return image[..., :3].float().clamp(0, 1)


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _batch_image_items(value: Any) -> list[torch.Tensor]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        items: list[torch.Tensor] = []
        for item in value:
            items.extend(_batch_image_items(item))
        return items
    source = value
    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
            source = _component_value(components, "images") or _component_value(components, "image") or value
        except Exception:
            source = value
    elif not isinstance(value, torch.Tensor):
        for key in ("images", "image", "frames", "samples", "batch", "items", "value"):
            candidate = _component_value(value, key)
            if candidate is not None:
                source = candidate
                break
    if source is not value:
        return _batch_image_items(source)
    tensor = _normalize_image(source)
    return [tensor[index:index + 1].contiguous() for index in range(int(tensor.shape[0]))]


def _pad_images_to_common_size(images: list[torch.Tensor]) -> torch.Tensor:
    if not images:
        raise RuntimeError("区域裁切失败：没有可输出的图像。")
    target_h = max(int(item.shape[1]) for item in images)
    target_w = max(int(item.shape[2]) for item in images)
    target_device = torch.device("cpu") if any(item.device.type == "cpu" for item in images) else images[0].device
    padded: list[torch.Tensor] = []
    for item in images:
        item = item.to(device=target_device, dtype=torch.float32, non_blocking=True, copy=False).contiguous()
        pad_h = target_h - int(item.shape[1])
        pad_w = target_w - int(item.shape[2])
        if pad_h > 0 or pad_w > 0:
            item = F.pad(item.permute(0, 3, 1, 2), (0, pad_w, 0, pad_h), value=0.0).permute(0, 2, 3, 1)
        padded.append(item.contiguous())
    return torch.cat(padded, dim=0)


def _pad_masks_to_common_size(masks: list[torch.Tensor]) -> torch.Tensor:
    if not masks:
        raise RuntimeError("区域裁切失败：没有可输出的遮罩。")
    target_h = max(int(item.shape[1]) for item in masks)
    target_w = max(int(item.shape[2]) for item in masks)
    target_device = torch.device("cpu") if any(item.device.type == "cpu" for item in masks) else masks[0].device
    padded: list[torch.Tensor] = []
    for item in masks:
        item = item.to(device=target_device, dtype=torch.float32, non_blocking=True, copy=False).contiguous()
        pad_h = target_h - int(item.shape[1])
        pad_w = target_w - int(item.shape[2])
        if pad_h > 0 or pad_w > 0:
            item = F.pad(item, (0, pad_w, 0, pad_h), value=0.0)
        padded.append(item.contiguous())
    return torch.cat(padded, dim=0)


def _normalize_mask(mask: torch.Tensor | None, height: int, width: int) -> torch.Tensor:
    if mask is None:
        return torch.ones((1, height, width), dtype=torch.float32)
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    if mask.ndim == 4:
        mask = mask[..., 0]
    return mask.float().clamp(0, 1)


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    if image.ndim == 4:
        image = image[0]
    array = (image.detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    return Image.fromarray(array[..., :3], mode="RGB")


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    array = np.asarray(image.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


def _input_image_files() -> list[str]:
    if folder_paths is None:
        return [""]
    input_dir = folder_paths.get_input_directory()
    items: list[str] = [""]
    for root, _, files in os.walk(input_dir):
        rel_root = os.path.relpath(root, input_dir)
        for name in files:
            if name.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")):
                items.append(name if rel_root == "." else f"{rel_root.replace(os.sep, '/')}/{name}")
    return sorted(set(items), key=lambda item: item.lower())


def _load_input_image(image_file: str) -> torch.Tensor:
    if folder_paths is None:
        raise RuntimeError("当前环境无法访问 ComfyUI 的 input 目录。")
    if not str(image_file or "").strip():
        raise RuntimeError("请连接输入图像，或点击 📁 打开一张图片。")
    image_path = folder_paths.get_annotated_filepath(image_file)
    with Image.open(image_path) as img:
        img = ImageOps.exif_transpose(img)
        return _pil_to_tensor(img)


def _image_preview_data_url(image: torch.Tensor, max_edge: int = 1024) -> str:
    pil = _tensor_to_pil(image)
    src_w, src_h = pil.size
    ratio = min(1.0, float(max_edge) / max(src_w, src_h, 1))
    if ratio < 1.0:
        pil = pil.resize((max(1, round(src_w * ratio)), max(1, round(src_h * ratio))), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    pil.save(buffer, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _resize_image(image: torch.Tensor, width: int, height: int, mode: str) -> torch.Tensor:
    pil = _tensor_to_pil(image)
    src_w, src_h = pil.size
    if mode == "拉伸填满":
        return _pil_to_tensor(pil.resize((width, height), Image.Resampling.LANCZOS))
    ratio = max(width / max(src_w, 1), height / max(src_h, 1)) if mode == "裁切填满" else min(width / max(src_w, 1), height / max(src_h, 1))
    new_w = max(1, int(round(src_w * ratio)))
    new_h = max(1, int(round(src_h * ratio)))
    resized = pil.resize((new_w, new_h), Image.Resampling.LANCZOS)
    if mode == "裁切填满":
        left = max(0, (new_w - width) // 2)
        top = max(0, (new_h - height) // 2)
        fitted = resized.crop((left, top, left + width, top + height))
    else:
        fitted = Image.new("RGB", (width, height), (0, 0, 0))
        fitted.paste(resized, ((width - new_w) // 2, (height - new_h) // 2))
    return _pil_to_tensor(fitted)


def _resize_tensor_to(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    if int(image.shape[1]) == height and int(image.shape[2]) == width:
        return image.contiguous()
    tensor = image.permute(0, 3, 1, 2).to(dtype=torch.float32)
    resized = F.interpolate(tensor, size=(height, width), mode="bicubic", align_corners=False, antialias=True)
    return resized.permute(0, 2, 3, 1).clamp(0, 1).to(device=image.device, dtype=image.dtype).contiguous()


def _align_size(value: int, align_multiple: int) -> int:
    multiple = _power_of_two_align(align_multiple)
    if multiple <= 1:
        return max(1, int(value))
    return max(multiple, int(round(max(1, value) / multiple)) * multiple)


def _power_of_two_align(value: Any) -> int:
    try:
        raw = int(round(float(value or 1)))
    except Exception:
        raw = 1
    raw = max(1, min(256, raw))
    return min((1, 2, 4, 8, 16, 32, 64, 128, 256), key=lambda item: abs(item - raw))


def _normalize_total_wan_pixels(value: Any) -> int:
    try:
        raw = int(round(float(value or REGION_CROP_SETTINGS_DEFAULTS["total_pixels"])))
    except Exception:
        raw = REGION_CROP_SETTINGS_DEFAULTS["total_pixels"]
    raw = max(10, min(6400, raw))
    return int(round(raw / 5.0) * 5)


def _read_user_settings() -> dict[str, Any]:
    if not USER_SETTINGS_PATH.exists():
        return {}
    try:
        with USER_SETTINGS_PATH.open("r", encoding="utf-8") as file:
            data = json.load(file)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _write_user_settings(data: dict[str, Any]) -> None:
    USER_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with USER_SETTINGS_PATH.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def _region_crop_user_settings() -> dict[str, int]:
    data = _read_user_settings()
    section = data.get(REGION_CROP_SETTINGS_KEY) if isinstance(data.get(REGION_CROP_SETTINGS_KEY), dict) else {}
    return {
        "total_pixels": _normalize_total_wan_pixels(section.get("total_pixels", REGION_CROP_SETTINGS_DEFAULTS["total_pixels"])),
        "align_multiple": _power_of_two_align(section.get("align_multiple", REGION_CROP_SETTINGS_DEFAULTS["align_multiple"])),
    }


def _save_region_crop_user_settings(total_pixels: Any, align_multiple: Any) -> dict[str, int]:
    data = _read_user_settings()
    settings = {
        "total_pixels": _normalize_total_wan_pixels(total_pixels),
        "align_multiple": _power_of_two_align(align_multiple),
    }
    data[REGION_CROP_SETTINGS_KEY] = settings
    if "version" not in data:
        data["version"] = 1
    _write_user_settings(data)
    return settings


def _scaled_crop_size(width: int, height: int, total_wan_pixels: float, scale_ratio: float, align_multiple: int) -> tuple[int, int]:
    crop_w = max(1, int(width))
    crop_h = max(1, int(height))
    value = _normalize_total_wan_pixels(total_wan_pixels)
    pixels = int(round(value * 10_000))
    ratio = (float(pixels) / max(1.0, float(crop_w * crop_h))) ** 0.5 if pixels > 0 else 1.0
    target_w = _align_size(int(round(crop_w * ratio)), align_multiple)
    target_h = _align_size(int(round(crop_h * ratio)), align_multiple)
    return target_w, target_h


def _region_box(region: Any) -> tuple[int, int, int, int]:
    if not isinstance(region, dict):
        raise ValueError("区域数据无效。")
    return int(region.get("x", 0)), int(region.get("y", 0)), int(region.get("width", 0)), int(region.get("height", 0))


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _normalize_angle(value: Any) -> float:
    angle = _safe_float(value, 0.0)
    return ((angle + 180.0) % 360.0) - 180.0


def _region_from_crop_config(config: Any, width: int, height: int) -> dict[str, Any]:
    if isinstance(config, str) and config.strip():
        try:
            data = json.loads(config)
        except json.JSONDecodeError as exc:
            raise ValueError("面板框选数据不是有效 JSON。") from exc
    elif isinstance(config, dict):
        data = config
    else:
        data = {}

    default_w = max(1, width // 2)
    default_h = max(1, height // 2)
    x = int(data.get("x", max(0, (width - default_w) // 2)))
    y = int(data.get("y", max(0, (height - default_h) // 2)))
    w = int(data.get("width", default_w))
    h = int(data.get("height", default_h))
    return {
        "x": x,
        "y": y,
        "width": max(1, w),
        "height": max(1, h),
        "angle": _normalize_angle(data.get("angle", 0.0)),
        "canvas_width": int(data.get("canvas_width", width)),
        "canvas_height": int(data.get("canvas_height", height)),
    }


def _region_mask(canvas_width: int, canvas_height: int, x: int, y: int, width: int, height: int) -> torch.Tensor:
    mask = torch.zeros((1, canvas_height, canvas_width), dtype=torch.float32)
    left = max(0, x)
    top = max(0, y)
    right = min(canvas_width, x + width)
    bottom = min(canvas_height, y + height)
    if right > left and bottom > top:
        mask[:, top:bottom, left:right] = 1.0
    return mask


def _rotated_crop_tensor(image: torch.Tensor, x: int, y: int, width: int, height: int, angle: float) -> torch.Tensor:
    batch, source_h, source_w, channels = image.shape
    crop_w = max(1, int(width))
    crop_h = max(1, int(height))
    device = image.device
    dtype = image.dtype
    cx = float(x) + float(crop_w) / 2.0
    cy = float(y) + float(crop_h) / 2.0
    theta = torch.tensor(float(angle) * np.pi / 180.0, dtype=torch.float32, device=device)
    cos_t = torch.cos(theta)
    sin_t = torch.sin(theta)

    ys = torch.arange(crop_h, dtype=torch.float32, device=device) + 0.5 - float(crop_h) / 2.0
    xs = torch.arange(crop_w, dtype=torch.float32, device=device) + 0.5 - float(crop_w) / 2.0
    grid_y, grid_x = torch.meshgrid(ys, xs, indexing="ij")
    source_x = cx + grid_x * cos_t - grid_y * sin_t
    source_y = cy + grid_x * sin_t + grid_y * cos_t
    norm_x = (source_x / max(1.0, float(source_w - 1))) * 2.0 - 1.0
    norm_y = (source_y / max(1.0, float(source_h - 1))) * 2.0 - 1.0
    grid = torch.stack((norm_x, norm_y), dim=-1).unsqueeze(0).repeat(batch, 1, 1, 1)
    samples = image.permute(0, 3, 1, 2).to(dtype=torch.float32)
    cropped = F.grid_sample(samples, grid, mode="bilinear", padding_mode="zeros", align_corners=True)
    return cropped.permute(0, 2, 3, 1).to(device=device, dtype=dtype).contiguous()


class GJJ_RegionBox:
    CATEGORY = "GJJ/Layer"
    FUNCTION = "make_region"
    DESCRIPTION = "创建一个可传递的矩形区域，并同步输出该区域遮罩。"
    SEARCH_ALIASES = ["region", "box", "区域", "矩形区域", "区域框"]
    RETURN_TYPES = (REGION_TYPE, "MASK", "STRING")
    RETURN_NAMES = ("区域数据", "区域遮罩", "区域JSON")
    OUTPUT_TOOLTIPS = ("可传给合成、裁切等 GJJ 区域节点的区域数据。", "该区域在画布上的遮罩。", "区域数据 JSON 文本。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "canvas_width": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "画布宽度", "tooltip": "区域所属画布宽度。"}),
                "canvas_height": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "画布高度", "tooltip": "区域所属画布高度。"}),
                "x": ("INT", {"default": 0, "min": -16384, "max": 16384, "step": 1, "display_name": "X 坐标", "tooltip": "区域左上角 X 坐标。"}),
                "y": ("INT", {"default": 0, "min": -16384, "max": 16384, "step": 1, "display_name": "Y 坐标", "tooltip": "区域左上角 Y 坐标。"}),
                "width": ("INT", {"default": 512, "min": 1, "max": 16384, "step": 1, "display_name": "区域宽度", "tooltip": "区域宽度。"}),
                "height": ("INT", {"default": 512, "min": 1, "max": 16384, "step": 1, "display_name": "区域高度", "tooltip": "区域高度。"}),
            },
            "optional": {
                "image": ("IMAGE", {"display_name": "输入图片", "tooltip": "可选。连接图片后首次执行自动将画布宽高同步为图片尺寸；后续可手动修改。"}),
            },
        }

    def make_region(self, canvas_width, canvas_height, x, y, width, height, image=None):
        region = {
            "x": int(x),
            "y": int(y),
            "width": int(width),
            "height": int(height),
            "canvas_width": int(canvas_width),
            "canvas_height": int(canvas_height),
        }
        result = (region, _region_mask(int(canvas_width), int(canvas_height), int(x), int(y), int(width), int(height)), json.dumps(region, ensure_ascii=False))
        if image is not None:
            img = _normalize_image(image)
            return {
                "ui": {
                    "image_width": (int(img.shape[2]),),
                    "image_height": (int(img.shape[1]),),
                },
                "result": result,
            }
        return result


class GJJ_GridRegionSelector:
    CATEGORY = "GJJ/Layer"
    FUNCTION = "select"
    DESCRIPTION = "把画布切成行列网格，按序号输出其中一个区域和完整区域列表 JSON。"
    SEARCH_ALIASES = ["grid region", "split grid", "网格区域", "区域选择"]
    RETURN_TYPES = (REGION_TYPE, "MASK", "STRING")
    RETURN_NAMES = ("选中区域", "选中遮罩", "区域列表JSON")
    OUTPUT_TOOLTIPS = ("按序号选中的网格区域。", "选中网格区域遮罩。", "全部网格区域的 JSON 列表。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "canvas_width": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "画布宽度", "tooltip": "网格所属画布宽度。"}),
                "canvas_height": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1, "display_name": "画布高度", "tooltip": "网格所属画布高度。"}),
                "rows": ("INT", {"default": 2, "min": 1, "max": 64, "step": 1, "display_name": "行数", "tooltip": "网格行数。"}),
                "cols": ("INT", {"default": 2, "min": 1, "max": 64, "step": 1, "display_name": "列数", "tooltip": "网格列数。"}),
                "index": ("INT", {"default": 1, "min": 1, "max": 4096, "step": 1, "display_name": "区域序号", "tooltip": "按从左到右、从上到下的 1 基序号选择区域。"}),
                "gap": ("INT", {"default": 0, "min": 0, "max": 512, "step": 1, "display_name": "网格间距", "tooltip": "区域之间预留的像素间距。"}),
            }
        }

    def select(self, canvas_width, canvas_height, rows, cols, index, gap):
        canvas_width = int(canvas_width)
        canvas_height = int(canvas_height)
        rows = int(rows)
        cols = int(cols)
        gap = int(gap)
        cell_w = max(1, (canvas_width - gap * (cols - 1)) // cols)
        cell_h = max(1, (canvas_height - gap * (rows - 1)) // rows)
        regions = []
        for row in range(rows):
            for col in range(cols):
                regions.append({
                    "x": col * (cell_w + gap),
                    "y": row * (cell_h + gap),
                    "width": cell_w,
                    "height": cell_h,
                    "canvas_width": canvas_width,
                    "canvas_height": canvas_height,
                })
        selected = regions[(int(index) - 1) % len(regions)]
        x, y, w, h = _region_box(selected)
        return (selected, _region_mask(canvas_width, canvas_height, x, y, w, h), json.dumps(regions, ensure_ascii=False))


class GJJ_RegionCrop:
    CATEGORY = "GJJ/Layer"
    FUNCTION = "crop"
    DESCRIPTION = "按 GJJ 区域数据从图片中裁切局部图像。"
    SEARCH_ALIASES = ["region crop", "crop by region", "区域裁切", "局部裁切"]
    RETURN_TYPES = (REGION_CROP_MEDIA_TYPE, "MASK")
    RETURN_NAMES = ("裁剪图像", "裁剪遮罩")
    OUTPUT_TOOLTIPS = ("区域内裁切出的图像。", "区域内的白色遮罩。")

    @classmethod
    def INPUT_TYPES(cls):
        settings = _region_crop_user_settings()
        return {
            "required": {
                "crop_config": ("STRING", {"default": "", "multiline": False, "hidden": True, "display": "hidden", "display_name": "面板框选数据", "tooltip": "内部保存面板框选区域，通常无需手动编辑。"}),
                "image_file": (_input_image_files(), {"image_upload": True, "display_name": "图片文件", "tooltip": "输入图像未连接时使用。点击节点内 📁 可从磁盘/网盘选择并上传到 ComfyUI/input。"}),
                "total_pixels": ("INT", {"default": settings["total_pixels"], "min": 10, "max": 6400, "step": 5, "display": "slider", "display_name": "总像素(万)", "tooltip": "裁切后严格缩放到接近此总像素，单位为万像素。30 表示约 30 万像素；最低 10 万，步长 5 万。"}),
                "scale_ratio": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 16.0, "step": 0.01, "display": "slider", "display_name": "缩放比例(兼容保留)", "tooltip": "兼容旧工作流保留；当前节点不再使用此参数。"}),
                "align_multiple": ("INT", {"default": settings["align_multiple"], "min": 1, "max": 256, "step": 1, "display_name": "对齐倍数", "tooltip": "输出宽高按此倍数对齐，只使用 2 的 n 次方：1/2/4/8/16/32/64/128/256。默认 8。"}),
            },
            "optional": {
                "region": (REGION_TYPE, {"display_name": "区域数据", "tooltip": "可选。连接后优先使用外部区域；不连接时使用面板内框选区域。"}),
                "image": (REGION_CROP_MEDIA_TYPE, {"display_name": "输入图像", "tooltip": "可选。连接后优先使用外部图像；不连接时使用节点内 📁 选择的图片。"}),
            }
        }

    def _crop_one(self, image: torch.Tensor, crop_config="", total_pixels=0, scale_ratio=1.0, align_multiple=8, region=None):
        height = int(image.shape[1])
        width = int(image.shape[2])
        angle = 0.0
        if region is None:
            active_region = _region_from_crop_config(crop_config, width, height)
            angle = _normalize_angle(active_region.get("angle", 0.0))
        else:
            active_region = region
            angle = _normalize_angle(active_region.get("angle", 0.0)) if isinstance(active_region, dict) else 0.0
        x, y, w, h = _region_box(active_region)
        left = max(0, x)
        top = max(0, y)
        right = min(width, x + w)
        bottom = min(height, y + h)
        if right <= left or bottom <= top:
            raise ValueError("区域不在图片范围内。")
        if abs(angle) > 0.001:
            crop_width = max(1, int(w))
            crop_height = max(1, int(h))
            cropped = _rotated_crop_tensor(image, int(x), int(y), crop_width, crop_height, angle)
        else:
            cropped = image[:, top:bottom, left:right, :].contiguous()
            crop_width = right - left
            crop_height = bottom - top
        output_width, output_height = _scaled_crop_size(crop_width, crop_height, float(total_pixels), float(scale_ratio), int(align_multiple))
        if output_width != int(cropped.shape[2]) or output_height != int(cropped.shape[1]):
            cropped = _resize_tensor_to(cropped, output_width, output_height)
            crop_width = output_width
            crop_height = output_height
        mask = torch.ones((int(cropped.shape[0]), int(cropped.shape[1]), int(cropped.shape[2])), dtype=torch.float32, device=cropped.device)
        return cropped, mask.contiguous(), {
            "source_width": width,
            "source_height": height,
            "region_x": int(x),
            "region_y": int(y),
            "region_width": int(w),
            "region_height": int(h),
            "crop_angle": float(angle),
            "crop_x": left,
            "crop_y": top,
            "crop_width": crop_width,
            "crop_height": crop_height,
            "output_width": int(cropped.shape[2]),
            "output_height": int(cropped.shape[1]),
        }

    def crop(self, crop_config="", image_file="", total_pixels=0, scale_ratio=1.0, align_multiple=8, region=None, image=None):
        images = _batch_image_items(image) if image is not None else [_load_input_image(image_file)]
        cropped_items: list[torch.Tensor] = []
        mask_items: list[torch.Tensor] = []
        ui_items: list[dict[str, Any]] = []
        for item in images:
            cropped, mask, ui = self._crop_one(item, crop_config, total_pixels, scale_ratio, align_multiple, region)
            cropped_items.append(cropped)
            mask_items.append(mask)
            ui_items.append(ui)
        cropped_batch = _pad_images_to_common_size(cropped_items)
        mask_batch = _pad_masks_to_common_size(mask_items)
        first = ui_items[0]
        return {
            "ui": {
                "source_width": [first["source_width"]],
                "source_height": [first["source_height"]],
                "region_x": [first["region_x"]],
                "region_y": [first["region_y"]],
                "region_width": [first["region_width"]],
                "region_height": [first["region_height"]],
                "crop_angle": [first["crop_angle"]],
                "crop_x": [first["crop_x"]],
                "crop_y": [first["crop_y"]],
                "crop_width": [first["crop_width"]],
                "crop_height": [first["crop_height"]],
                "output_width": [int(cropped_batch.shape[2])],
                "output_height": [int(cropped_batch.shape[1])],
                "batch_count": [int(cropped_batch.shape[0])],
            },
            "result": (cropped_batch, mask_batch),
        }

    @classmethod
    def VALIDATE_INPUTS(cls, image_file="", **kwargs):
        if image_file and folder_paths is not None and not folder_paths.exists_annotated_filepath(image_file):
            return f"图片文件无效：{image_file}"
        return True


class GJJ_RegionComposite:
    CATEGORY = "GJJ/Layer"
    FUNCTION = "composite"
    DESCRIPTION = "把前景图片按指定区域合成到底图上，支持适配方式、透明度和可选遮罩。"
    SEARCH_ALIASES = ["region composite", "layer composite", "区域合成", "图层合成"]
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("合成图像", "合成区域遮罩")
    OUTPUT_TOOLTIPS = ("完成区域合成后的图片。", "实际合成区域遮罩。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_image": ("IMAGE", {"display_name": "底图", "tooltip": "被合成的背景图片。"}),
                "overlay_image": ("IMAGE", {"display_name": "前景图", "tooltip": "放入指定区域的前景图片。"}),
                "region": (REGION_TYPE, {"display_name": "区域数据", "tooltip": "前景图要放入的区域。"}),
                "fit_mode": (["等比留边", "裁切填满", "拉伸填满"], {"default": "等比留边", "display_name": "适配方式", "tooltip": "前景图放入区域时的缩放方式。"}),
                "opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider", "display_name": "透明度", "tooltip": "前景图整体混合透明度。"}),
                "canvas_width": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1, "display_name": "画布宽度", "tooltip": "合成画布宽度。0 表示自动跟随底图实际宽度。"}),
                "canvas_height": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1, "display_name": "画布高度", "tooltip": "合成画布高度。0 表示自动跟随底图实际高度。"}),
            },
            "optional": {
                "overlay_mask": ("MASK", {"display_name": "前景遮罩", "tooltip": "可选。控制前景图在区域内的可见范围。"}),
            },
        }

    def composite(self, base_image, overlay_image, region, fit_mode, opacity, canvas_width=0, canvas_height=0, overlay_mask=None):
        base = _normalize_image(base_image).clone()
        overlay = _normalize_image(overlay_image)
        x, y, w, h = _region_box(region)
        canvas_w = int(canvas_width) if int(canvas_width) > 0 else int(base.shape[2])
        canvas_h = int(canvas_height) if int(canvas_height) > 0 else int(base.shape[1])
        left = max(0, x)
        top = max(0, y)
        right = min(canvas_w, x + w)
        bottom = min(canvas_h, y + h)
        if right <= left or bottom <= top:
            raise ValueError("区域不在底图范围内。")
        target_w = right - left
        target_h = bottom - top
        fitted = _resize_image(overlay[0:1], target_w, target_h, fit_mode).to(base.device)
        mask = _normalize_mask(overlay_mask, target_h, target_w).to(base.device)
        if mask.shape[-2:] != (target_h, target_w):
            mask_img = Image.fromarray((mask[0].detach().cpu().numpy() * 255).astype(np.uint8), mode="L").resize((target_w, target_h), Image.Resampling.LANCZOS)
            mask = torch.from_numpy(np.asarray(mask_img).astype(np.float32) / 255.0).unsqueeze(0).to(base.device)
        alpha = (mask[0:1, :, :].unsqueeze(-1) * float(opacity)).clamp(0, 1)
        base[:, top:bottom, left:right, :] = base[:, top:bottom, left:right, :] * (1.0 - alpha) + fitted * alpha
        region_mask = _region_mask(canvas_w, canvas_h, left, top, target_w, target_h).to(base.device)
        return {
            "ui": {
                "canvas_width": [canvas_w],
                "canvas_height": [canvas_h],
            },
            "result": (base.clamp(0, 1), region_mask),
        }


if PromptServer is not None and web is not None:
    @PromptServer.instance.routes.get("/gjj/region_crop/settings")
    async def gjj_region_crop_settings_get(request):
        return web.json_response(_region_crop_user_settings())

    @PromptServer.instance.routes.post("/gjj/region_crop/settings")
    async def gjj_region_crop_settings_post(request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        settings = _save_region_crop_user_settings(
            payload.get("total_pixels", REGION_CROP_SETTINGS_DEFAULTS["total_pixels"]) if isinstance(payload, dict) else REGION_CROP_SETTINGS_DEFAULTS["total_pixels"],
            payload.get("align_multiple", REGION_CROP_SETTINGS_DEFAULTS["align_multiple"]) if isinstance(payload, dict) else REGION_CROP_SETTINGS_DEFAULTS["align_multiple"],
        )
        return web.json_response(settings)


NODE_CLASS_MAPPINGS = {
    "GJJ_RegionBox": GJJ_RegionBox,
    "GJJ_GridRegionSelector": GJJ_GridRegionSelector,
    "GJJ_RegionCrop": GJJ_RegionCrop,
    "GJJ_RegionComposite": GJJ_RegionComposite,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_RegionBox": "GJJ · 📐 区域框",
    "GJJ_GridRegionSelector": "GJJ · 🔲 网格区域选择",
    "GJJ_RegionCrop": "GJJ · ✂️ 图片可视化区域裁切",
    "GJJ_RegionComposite": "GJJ · 🧱 区域图层合成",
}
