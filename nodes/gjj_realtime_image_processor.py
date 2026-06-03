from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen

import folder_paths
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_RealtimeImageProcessor"
MIXED_IMAGE_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
CONFIG_WIDGET = "config_json"
INTERNAL_FILE_WIDGET = "internal_file"
DEFAULT_IMAGE_URL = "https://raw.githubusercontent.com/Comfy-Org/example_workflows/main/flux/krea/flux1_krea_dev.png"
MEDIA_COPY_SUBDIR = "GJJ_RealtimeImageProcessor"
MEDIA_DOWNLOAD_TIMEOUT = 45
IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "avif", "tiff"}


DEFAULT_CONFIG = json.dumps(
    {
        "version": 1,
        "activeCategory": "color",
        "selected": [],
        "values": {},
    },
    ensure_ascii=False,
    separators=(",", ":"),
)


OP_ORDER = [
    "brightness",
    "contrast",
    "saturation",
    "hue",
    "lightness",
    "gamma",
    "levels",
    "rgb_channels",
    "hsl_channels",
    "invert",
    "grayscale",
    "white_balance",
    "color_shift",
    "color_temp",
    "highlight_recover",
    "shadow_lift",
    "exposure",
    "split_tone",
    "auto_levels",
    "auto_contrast",
    "auto_white_balance",
    "rotate",
    "flip_h",
    "flip_v",
    "scale",
    "crop",
    "pad",
    "translate",
    "perspective",
    "aspect_crop",
    "exif_orient",
    "gaussian_blur",
    "mean_blur",
    "box_blur",
    "bilateral_blur",
    "radial_blur",
    "motion_blur",
    "usm_sharpen",
    "smart_sharpen",
    "edge_sharpen",
    "denoise",
    "skin_blur",
    "channel_sharpen",
    "dilate",
    "erode",
    "open_morph",
    "close_morph",
    "quantize",
    "threshold_key",
    "binary",
    "despeckle",
    "resample",
    "blend_mode",
    "opacity_blend",
    "solid_overlay",
    "mask_cut",
    "local_mask_color",
    "alpha_key",
    "mono_filter",
    "sepia",
    "cool_cyan",
    "cyber_cool",
    "film_grain",
    "vignette",
    "dust_gradient",
    "negative",
    "mono_mask",
    "sketch_desat",
    "soft_fog",
    "alpha_extract",
    "transparent_remove",
    "feather_alpha",
    "transparent_fill",
    "rgb_split_merge",
    "channel_invert",
    "single_channel_gray",
    "center_trim",
    "fixed_crop",
    "border_trim",
    "canvas_expand",
    "asymmetric_pad",
    "rounded_corner",
]


DEFAULT_VALUES: dict[str, dict[str, float]] = {
    "brightness": {"amount": 0.0},
    "contrast": {"amount": 0.0},
    "saturation": {"amount": 0.0},
    "hue": {"degrees": 0.0},
    "lightness": {"amount": 0.0},
    "gamma": {"gamma": 1.0},
    "levels": {"black": 0.0, "gray": 1.0, "white": 1.0},
    "rgb_channels": {"red": 1.0, "green": 1.0, "blue": 1.0},
    "hsl_channels": {"hue": 0.0, "saturation": 0.0, "lightness": 0.0},
    "invert": {"amount": 1.0},
    "grayscale": {"amount": 1.0},
    "white_balance": {"temperature": 0.0, "tint": 0.0},
    "color_shift": {"amount": 0.0},
    "color_temp": {"temperature": 0.0},
    "highlight_recover": {"amount": 0.0},
    "shadow_lift": {"amount": 0.0},
    "exposure": {"ev": 0.0},
    "split_tone": {"shadow_hue": 220.0, "highlight_hue": 35.0, "amount": 0.0},
    "auto_levels": {"strength": 1.0},
    "auto_contrast": {"strength": 1.0},
    "auto_white_balance": {"strength": 1.0},
    "rotate": {"angle": 0.0},
    "flip_h": {"enabled": 1.0},
    "flip_v": {"enabled": 1.0},
    "scale": {"x": 1.0, "y": 1.0},
    "crop": {"width": 1.0, "height": 1.0},
    "pad": {"size": 0.0, "value": 0.0},
    "translate": {"x": 0.0, "y": 0.0},
    "perspective": {"x": 0.0, "y": 0.0},
    "aspect_crop": {"ratio": 1.0},
    "exif_orient": {"quarter_turns": 0.0},
    "gaussian_blur": {"radius": 0.0},
    "mean_blur": {"radius": 0.0},
    "box_blur": {"radius": 0.0},
    "bilateral_blur": {"radius": 0.0, "strength": 0.4},
    "radial_blur": {"amount": 0.0},
    "motion_blur": {"radius": 0.0, "angle": 0.0},
    "usm_sharpen": {"amount": 0.0, "radius": 1.0},
    "smart_sharpen": {"amount": 0.0, "threshold": 0.03},
    "edge_sharpen": {"amount": 0.0},
    "denoise": {"amount": 0.0},
    "skin_blur": {"amount": 0.0},
    "channel_sharpen": {"red": 0.0, "green": 0.0, "blue": 0.0},
    "dilate": {"radius": 0.0},
    "erode": {"radius": 0.0},
    "open_morph": {"radius": 0.0},
    "close_morph": {"radius": 0.0},
    "quantize": {"levels": 8.0},
    "threshold_key": {"threshold": 0.5, "softness": 0.0},
    "binary": {"threshold": 0.5},
    "despeckle": {"amount": 0.0},
    "resample": {"scale": 1.0, "mode": 1.0},
    "blend_mode": {"mode": 0.0, "opacity": 0.5},
    "opacity_blend": {"opacity": 0.5},
    "solid_overlay": {"red": 0.0, "green": 0.5, "blue": 1.0, "opacity": 0.0},
    "mask_cut": {"threshold": 0.5, "softness": 0.1},
    "local_mask_color": {"amount": 0.0},
    "alpha_key": {"threshold": 0.1, "softness": 0.05},
    "mono_filter": {"hue": 200.0, "amount": 0.0},
    "sepia": {"amount": 0.0},
    "cool_cyan": {"amount": 0.0},
    "cyber_cool": {"amount": 0.0},
    "film_grain": {"amount": 0.0, "seed": 0.0},
    "vignette": {"amount": 0.0, "size": 0.65},
    "dust_gradient": {"amount": 0.0},
    "negative": {"amount": 1.0},
    "mono_mask": {"threshold": 0.5},
    "sketch_desat": {"amount": 0.0},
    "soft_fog": {"amount": 0.0},
    "alpha_extract": {"source": 0.0},
    "transparent_remove": {"background": 1.0},
    "feather_alpha": {"radius": 0.0},
    "transparent_fill": {"value": 1.0},
    "rgb_split_merge": {"mode": 0.0},
    "channel_invert": {"channel": 0.0},
    "single_channel_gray": {"channel": 0.0},
    "center_trim": {"amount": 0.0},
    "fixed_crop": {"width": 1.0, "height": 1.0},
    "border_trim": {"amount": 0.0},
    "canvas_expand": {"amount": 0.0, "value": 0.0},
    "asymmetric_pad": {"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0},
    "rounded_corner": {"radius": 0.0, "background": 0.0},
}


def _is_network_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value.strip())
    return parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc)


def _detect_image_type(value: str) -> bool:
    text = str(value or "").strip()
    if "." not in text:
        return False
    parsed = urlparse(text)
    path_text = unquote(parsed.path or text).strip().lower()
    if parsed.path.endswith("/view") and parsed.query:
        query = parse_qs(parsed.query)
        query_name = query.get("filename", [""])[0]
        if query_name:
            path_text = unquote(query_name).strip().lower()
    ext = Path(path_text).suffix.lower().lstrip(".")
    if not ext and "." in path_text:
        ext = path_text.rsplit(".", 1)[-1]
    return ext in IMAGE_EXTS


def _safe_image_basename(name: str) -> str:
    raw_name = unquote(str(name or "")).replace("\\", "/").rsplit("/", 1)[-1]
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", raw_name).strip(" ._")
    if not safe_name:
        safe_name = "downloaded_image"
    if not Path(safe_name).suffix:
        safe_name = f"{safe_name}.png"
    return safe_name


def _safe_image_subdir_part(name: str) -> str:
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f\s]+', "_", unquote(str(name or ""))).strip(" ._")
    return (safe_name or "network")[:72].strip(" ._") or "network"


def _url_image_relative_path(url: str) -> Path:
    parsed = urlparse(str(url or "").strip())
    path_parts = [part for part in unquote(parsed.path or "").replace("\\", "/").split("/") if part]
    source_name = path_parts[-2] if len(path_parts) >= 2 else (parsed.netloc or "network")
    source_dir = "/".join(path_parts[:-1])
    source_key = f"{parsed.scheme.lower()}://{parsed.netloc.lower()}/{source_dir}"
    if parsed.query:
        source_key = f"{source_key}?{parsed.query}"
    digest = hashlib.sha1(source_key.encode("utf-8", "ignore")).hexdigest()[:10]
    subdir = f"{_safe_image_subdir_part(source_name)}_{digest}"
    filename = _safe_image_basename(Path(unquote(parsed.path or "")).name or "network_image.png")
    return Path(MEDIA_COPY_SUBDIR) / subdir / filename


def _input_relative_image_path(file_path: str) -> str:
    try:
        input_root = Path(folder_paths.get_input_directory()).resolve()
        path = Path(file_path).resolve()
        return path.relative_to(input_root).as_posix()
    except Exception:
        return Path(file_path).name


def _find_input_image_by_relative_path(relative_path: str | os.PathLike[str]) -> str | None:
    parts = [part for part in Path(relative_path).parts if part not in {"", ".", ".."}]
    if not parts:
        return None
    try:
        direct = Path(folder_paths.get_input_directory()).joinpath(*parts)
    except Exception:
        return None
    return str(direct) if direct.is_file() else None


def _download_network_image_to_input(url: str) -> str:
    relative_path = _url_image_relative_path(url)
    existing = _find_input_image_by_relative_path(relative_path)
    if existing:
        return existing

    input_root = Path(folder_paths.get_input_directory())
    dest = input_root / relative_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.download")
    request = Request(
        url,
        headers={
            "User-Agent": "ComfyUI-GJJ-RealtimeImageProcessor/1.0",
            "Accept": "image/*,*/*",
        },
    )
    try:
        with urlopen(request, timeout=MEDIA_DOWNLOAD_TIMEOUT) as response:
            status = int(getattr(response, "status", 200) or 200)
            if status >= 400:
                raise RuntimeError(f"HTTP {status}")
            with open(tmp, "wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
        os.replace(tmp, dest)
    except Exception:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        raise
    return str(dest)


def _configured_image_roots() -> dict[str, str]:
    roots = {
        "input": folder_paths.get_input_directory(),
        "output": folder_paths.get_output_directory(),
        "temp": folder_paths.get_temp_directory(),
    }
    return {key: value for key, value in roots.items() if value}


def _clean_image_reference(value: str) -> tuple[str, str]:
    text = str(value or "").strip()
    root_hint = "input"
    try:
        parsed = urlparse(text)
        if parsed.path.endswith("/view") and parsed.query:
            query = parse_qs(parsed.query)
            name = query.get("filename", [""])[0]
            subfolder = query.get("subfolder", [""])[0]
            root_hint = (query.get("type", ["input"])[0] or "input").lower()
            text = os.path.join(subfolder, name) if subfolder else name
    except Exception:
        pass
    annotated = re.search(r"\s+\[(input|output|temp)\]$", text, re.IGNORECASE)
    if annotated:
        root_hint = annotated.group(1).lower()
        text = text[: annotated.start()].strip()
    text = unquote(text).strip().strip('"').strip("'")
    if os.name == "nt" and re.match(r"^/[A-Za-z]:[/\\]", text):
        text = text[1:]
    return text.replace("\\", os.sep).replace("/", os.sep), root_hint


def _path_exists(path: str | os.PathLike[str]) -> str | None:
    try:
        resolved = Path(path)
        return str(resolved) if resolved.is_file() else None
    except Exception:
        return None


def _resolve_image_file(reference: str) -> str | None:
    raw = str(reference or "").strip()
    if not raw:
        return None
    if _is_network_url(raw) and not urlparse(raw).path.endswith("/view"):
        if not _detect_image_type(raw):
            return None
        return _download_network_image_to_input(raw)

    filename, root_hint = _clean_image_reference(raw)
    roots = _configured_image_roots()
    lowered = filename.lower()
    if root_hint in roots:
        stripped = filename
        prefix = root_hint + os.sep
        if lowered.startswith(prefix):
            stripped = filename[len(prefix):]
        found = _path_exists(Path(roots[root_hint]) / stripped)
        if found:
            return found
    if os.path.isabs(filename):
        return _path_exists(filename)
    for root_key, root_path in roots.items():
        prefix = root_key + os.sep
        if lowered.startswith(prefix):
            found = _path_exists(Path(root_path) / filename[len(prefix):])
            if found:
                return found
            break
    for root_path in roots.values():
        found = _path_exists(Path(root_path) / filename)
        if found:
            return found
    try:
        annotated = folder_paths.get_annotated_filepath(filename)
        return _path_exists(annotated)
    except Exception:
        return None


class GJJ_RealtimeImageProcessor:
    CATEGORY = "GJJ/Image"
    FUNCTION = "process"
    DESCRIPTION = "单节点零依赖图片实时对比处理器。节点面板可打开图片、按分类复选处理项、用滑块调参，并实时显示原图/结果对比。"
    SEARCH_ALIASES = [
        "图片实时对比处理",
        "实时修图",
        "image processor",
        "image effects",
        "before after",
        "调色",
        "滤镜",
        "几何变换",
    ]
    RETURN_TYPES = (MIXED_IMAGE_TYPE,)
    RETURN_NAMES = ("处理图像",)
    OUTPUT_TOOLTIPS = ("按面板当前启用操作处理后的图像；兼容 IMAGE 与 GJJ 批量图像流。",)
    INPUT_IS_LIST = False
    OUTPUT_IS_LIST = (False,)

    GJJ_HELP = {
        "title": "GJJ · 🪄 图片实时对比处理",
        "description": "零第三方节点、零模型依赖的轻量图片处理工作台。前端实时预览，后端执行输出同一份配置。",
        "features": [
            "一个可选图片输入口，一个图片输出口",
            "📁 按钮可上传本地图片到 ComfyUI input 并作为节点内部图片使用",
            "未连接输入时默认使用 Comfy 官方示例图，并按 GJJ_TemplateParams 风格缓存到 input",
            "大分类页签 + 可复选处理按钮 + 滑块参数",
            "原图/结果实时滑动对比预览",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                CONFIG_WIDGET: (
                    "STRING",
                    {
                        "default": DEFAULT_CONFIG,
                        "multiline": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "内部配置JSON",
                        "tooltip": "前端实时面板自动维护的处理配置；通常不需要手动编辑。",
                    },
                ),
            },
            "optional": {
                "image": (
                    MIXED_IMAGE_TYPE,
                    {
                        "display_name": "输入图片",
                        "tooltip": "可选输入图片；未连接时可点击节点面板的 📁 打开图片。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def process(
        self,
        config_json: str = DEFAULT_CONFIG,
        internal_file: str = "",
        image: torch.Tensor | None = None,
        unique_id: str | None = None,
        prompt: dict[str, Any] | None = None,
        extra_pnginfo: dict[str, Any] | None = None,
    ):
        config_json = self._read_state_value(unique_id, prompt, extra_pnginfo, CONFIG_WIDGET, config_json or DEFAULT_CONFIG)
        internal_file = self._read_state_value(unique_id, prompt, extra_pnginfo, INTERNAL_FILE_WIDGET, internal_file or "")

        source = image
        if source is None:
            source = self._load_internal_image(internal_file)
        if source is None:
            source = self._load_internal_image(DEFAULT_IMAGE_URL)
        if source is None:
            source = _generated_default_image_tensor()

        source = _normalize_image(source)
        state = _parse_config(config_json)
        result = _apply_config(source, state)
        return (_clamp01(result),)

    @staticmethod
    def _read_state_value(
        unique_id: str | None,
        prompt: dict[str, Any] | None,
        extra_pnginfo: dict[str, Any] | None,
        key: str,
        default: str,
    ) -> str:
        uid = str(unique_id) if unique_id is not None else ""
        try:
            node_prompt = (prompt or {}).get(uid) or (prompt or {}).get(int(uid))
            value = (node_prompt or {}).get("inputs", {}).get(key)
            if value not in (None, ""):
                return str(value)
        except Exception:
            pass
        try:
            workflow = (extra_pnginfo or {}).get("workflow") or {}
            for node in workflow.get("nodes", []) or []:
                if str(node.get("id")) == uid:
                    props = node.get("properties") or {}
                    value = props.get(key)
                    if value not in (None, ""):
                        return str(value)
        except Exception:
            pass
        return default

    @staticmethod
    def _load_internal_image(filename: str) -> torch.Tensor | None:
        name = str(filename or "").strip()
        if not name:
            return None
        try:
            path = _resolve_image_file(name)
            if not path or not os.path.isfile(path):
                return None
            pil = Image.open(path)
            pil = pil.convert("RGBA" if pil.mode == "RGBA" else "RGB")
            array = np.asarray(pil).astype(np.float32) / 255.0
            return torch.from_numpy(array).unsqueeze(0)
        except Exception as exc:
            print(f"[GJJ] 图片实时对比处理：内部图片加载失败：{exc}")
            return None


def _parse_config(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(str(raw or "{}"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _generated_default_image_tensor() -> torch.Tensor:
    width, height = 1920, 1088
    x = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :, None]
    y = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None, None]
    glow = np.exp(-(((x - 0.42) ** 2) / 0.08 + ((y - 0.38) ** 2) / 0.12)).astype(np.float32)
    grid = ((np.floor(x * 24.0) + np.floor(y * 14.0)) % 2.0) * 0.018
    red = 0.10 + 0.22 * x + 0.08 * glow + grid
    green = 0.16 + 0.30 * y + 0.18 * glow + grid
    blue = 0.20 + 0.22 * (1.0 - x) + 0.12 * glow + grid
    image = np.concatenate([red, green, blue], axis=2)
    return torch.from_numpy(np.clip(image, 0.0, 1.0)).unsqueeze(0)


def _active_ops(state: dict[str, Any]) -> list[str]:
    selected = state.get("selected")
    if isinstance(selected, dict):
        enabled = {str(key) for key, value in selected.items() if bool(value)}
    elif isinstance(selected, list):
        enabled = {str(item) for item in selected}
    else:
        enabled = set()
    return [op for op in OP_ORDER if op in enabled]


def _value(state: dict[str, Any], op_id: str, name: str) -> float:
    defaults = DEFAULT_VALUES.get(op_id, {})
    default = float(defaults.get(name, 0.0))
    values = state.get("values")
    if not isinstance(values, dict):
        return default
    op_values = values.get(op_id)
    if not isinstance(op_values, dict):
        return default
    try:
        value = float(op_values.get(name, default))
    except Exception:
        return default
    if not math.isfinite(value):
        return default
    return value


def _normalize_image(image: torch.Tensor) -> torch.Tensor:
    if image.ndim == 3:
        image = image.unsqueeze(0)
    image = image.float()
    if image.shape[-1] == 1:
        image = image.repeat(1, 1, 1, 3)
    if image.shape[-1] == 2:
        image = torch.cat([image[..., :1].repeat(1, 1, 1, 3), image[..., 1:2]], dim=-1)
    if image.shape[-1] > 4:
        image = image[..., :4]
    return _clamp01(image)


def _clamp01(image: torch.Tensor) -> torch.Tensor:
    return torch.nan_to_num(image, nan=0.0, posinf=1.0, neginf=0.0).clamp(0.0, 1.0)


def _split_rgba(image: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor | None]:
    rgb = image[..., :3]
    alpha = image[..., 3:4] if image.shape[-1] >= 4 else None
    return rgb, alpha


def _merge_rgba(rgb: torch.Tensor, alpha: torch.Tensor | None) -> torch.Tensor:
    rgb = _clamp01(rgb)
    if alpha is None:
        return rgb
    if alpha.shape[1:3] != rgb.shape[1:3]:
        alpha = _resize_tensor(alpha, rgb.shape[1], rgb.shape[2], "bilinear")
    return torch.cat([rgb, _clamp01(alpha)], dim=-1)


def _with_rgb(image: torch.Tensor, fn) -> torch.Tensor:
    rgb, alpha = _split_rgba(image)
    return _merge_rgba(fn(rgb), alpha)


def _luma(rgb: torch.Tensor) -> torch.Tensor:
    return rgb[..., 0:1] * 0.299 + rgb[..., 1:2] * 0.587 + rgb[..., 2:3] * 0.114


def _rgb_from_hue(degrees: float, saturation: float = 1.0, value: float = 1.0, device=None, dtype=None) -> torch.Tensor:
    hue = (float(degrees) % 360.0) / 60.0
    chroma = value * saturation
    x = chroma * (1.0 - abs(hue % 2.0 - 1.0))
    if hue < 1:
        rgb = (chroma, x, 0.0)
    elif hue < 2:
        rgb = (x, chroma, 0.0)
    elif hue < 3:
        rgb = (0.0, chroma, x)
    elif hue < 4:
        rgb = (0.0, x, chroma)
    elif hue < 5:
        rgb = (x, 0.0, chroma)
    else:
        rgb = (chroma, 0.0, x)
    m = value - chroma
    return torch.tensor([rgb[0] + m, rgb[1] + m, rgb[2] + m], device=device, dtype=dtype).view(1, 1, 1, 3)


def _hue_rotate(rgb: torch.Tensor, degrees: float) -> torch.Tensor:
    angle = math.radians(float(degrees))
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    matrix = torch.tensor(
        [
            [0.299 + 0.701 * cos_a + 0.168 * sin_a, 0.587 - 0.587 * cos_a + 0.330 * sin_a, 0.114 - 0.114 * cos_a - 0.497 * sin_a],
            [0.299 - 0.299 * cos_a - 0.328 * sin_a, 0.587 + 0.413 * cos_a + 0.035 * sin_a, 0.114 - 0.114 * cos_a + 0.292 * sin_a],
            [0.299 - 0.300 * cos_a + 1.250 * sin_a, 0.587 - 0.588 * cos_a - 1.050 * sin_a, 0.114 + 0.886 * cos_a - 0.203 * sin_a],
        ],
        device=rgb.device,
        dtype=rgb.dtype,
    )
    return torch.matmul(rgb, matrix.T)


def _nchw(image: torch.Tensor) -> torch.Tensor:
    return image.permute(0, 3, 1, 2).contiguous()


def _bhwc(image: torch.Tensor) -> torch.Tensor:
    return image.permute(0, 2, 3, 1).contiguous()


def _resize_tensor(image: torch.Tensor, height: int, width: int, mode: str = "bilinear") -> torch.Tensor:
    if image.shape[1] == int(height) and image.shape[2] == int(width):
        return image
    x = _nchw(image)
    kwargs = {"mode": mode}
    if mode in {"bilinear", "bicubic"}:
        kwargs["align_corners"] = False
    return _bhwc(F.interpolate(x, size=(max(1, int(height)), max(1, int(width))), **kwargs))


def _kernel_conv(image: torch.Tensor, kernel: torch.Tensor) -> torch.Tensor:
    x = _nchw(image)
    channels = x.shape[1]
    kernel = kernel.to(device=x.device, dtype=x.dtype)
    kernel = kernel.view(1, 1, kernel.shape[-2], kernel.shape[-1]).repeat(channels, 1, 1, 1)
    pad_y = kernel.shape[-2] // 2
    pad_x = kernel.shape[-1] // 2
    x = F.pad(x, (pad_x, pad_x, pad_y, pad_y), mode="reflect")
    return _bhwc(F.conv2d(x, kernel, groups=channels))


def _box_blur(image: torch.Tensor, radius: float) -> torch.Tensor:
    r = max(0, int(round(radius)))
    if r <= 0:
        return image
    size = r * 2 + 1
    kernel = torch.ones((size, size), device=image.device, dtype=image.dtype) / float(size * size)
    return _kernel_conv(image, kernel)


def _gaussian_blur(image: torch.Tensor, radius: float) -> torch.Tensor:
    r = max(0, int(round(radius)))
    if r <= 0:
        return image
    sigma = max(0.1, r / 2.0)
    coords = torch.arange(-r, r + 1, device=image.device, dtype=image.dtype)
    one = torch.exp(-(coords * coords) / (2.0 * sigma * sigma))
    one = one / one.sum()
    kernel = one[:, None] * one[None, :]
    return _kernel_conv(image, kernel)


def _motion_blur(image: torch.Tensor, radius: float, angle: float) -> torch.Tensor:
    r = max(0, int(round(radius)))
    if r <= 0:
        return image
    size = r * 2 + 1
    kernel = torch.zeros((size, size), device=image.device, dtype=image.dtype)
    rad = math.radians(float(angle))
    cx = cy = r
    for i in range(size):
        t = i - r
        x = int(round(cx + math.cos(rad) * t))
        y = int(round(cy + math.sin(rad) * t))
        if 0 <= x < size and 0 <= y < size:
            kernel[y, x] = 1.0
    if float(kernel.sum()) <= 0:
        kernel[r, :] = 1.0
    kernel = kernel / kernel.sum()
    return _kernel_conv(image, kernel)


def _affine(image: torch.Tensor, theta_values: list[list[float]]) -> torch.Tensor:
    x = _nchw(image)
    theta = torch.tensor(theta_values, device=x.device, dtype=x.dtype).view(1, 2, 3).repeat(x.shape[0], 1, 1)
    grid = F.affine_grid(theta, x.shape, align_corners=False)
    return _bhwc(F.grid_sample(x, grid, mode="bilinear", padding_mode="zeros", align_corners=False))


def _center_crop(image: torch.Tensor, crop_h: int, crop_w: int) -> torch.Tensor:
    h = image.shape[1]
    w = image.shape[2]
    crop_h = max(1, min(h, int(crop_h)))
    crop_w = max(1, min(w, int(crop_w)))
    y0 = max(0, (h - crop_h) // 2)
    x0 = max(0, (w - crop_w) // 2)
    return image[:, y0 : y0 + crop_h, x0 : x0 + crop_w, :].contiguous()


def _pad_all(image: torch.Tensor, left: int, right: int, top: int, bottom: int, value: float = 0.0) -> torch.Tensor:
    left = max(0, int(left))
    right = max(0, int(right))
    top = max(0, int(top))
    bottom = max(0, int(bottom))
    if left == right == top == bottom == 0:
        return image
    return _bhwc(F.pad(_nchw(image), (left, right, top, bottom), value=float(value)))


def _pool(image: torch.Tensor, radius: float, mode: str) -> torch.Tensor:
    r = max(0, int(round(radius)))
    if r <= 0:
        return image
    x = _nchw(image)
    k = r * 2 + 1
    if mode == "min":
        x = -F.max_pool2d(-x, kernel_size=k, stride=1, padding=r)
    else:
        x = F.max_pool2d(x, kernel_size=k, stride=1, padding=r)
    return _bhwc(x)


def _blend(base: torch.Tensor, overlay: torch.Tensor, mode: int, opacity: float) -> torch.Tensor:
    mode = int(round(mode)) % 5
    opacity = max(0.0, min(1.0, float(opacity)))
    if mode == 1:
        mixed = base * overlay
    elif mode == 2:
        mixed = 1.0 - (1.0 - base) * (1.0 - overlay)
    elif mode == 3:
        mixed = torch.where(base < 0.5, 2.0 * base * overlay, 1.0 - 2.0 * (1.0 - base) * (1.0 - overlay))
    elif mode == 4:
        mixed = torch.abs(base - overlay)
    else:
        mixed = overlay
    return base * (1.0 - opacity) + mixed * opacity


def _grain_like(image: torch.Tensor, amount: float, seed: float) -> torch.Tensor:
    amount = max(0.0, min(1.0, float(amount)))
    if amount <= 0:
        return image
    generator = torch.Generator(device="cpu")
    generator.manual_seed(int(seed) & 0xFFFFFFFF)
    noise = torch.rand(image.shape, generator=generator, dtype=torch.float32).to(device=image.device, dtype=image.dtype) - 0.5
    return image + noise * amount * 0.35


def _vignette(image: torch.Tensor, amount: float, size: float) -> torch.Tensor:
    amount = max(0.0, min(1.0, float(amount)))
    if amount <= 0:
        return image
    h, w = image.shape[1], image.shape[2]
    yy = torch.linspace(-1.0, 1.0, h, device=image.device, dtype=image.dtype).view(1, h, 1, 1)
    xx = torch.linspace(-1.0, 1.0, w, device=image.device, dtype=image.dtype).view(1, 1, w, 1)
    dist = torch.sqrt(xx * xx + yy * yy)
    mask = 1.0 - torch.clamp((dist - float(size)) / max(0.001, 1.2 - float(size)), 0.0, 1.0) * amount
    return image * mask


def _rounded(image: torch.Tensor, radius_ratio: float, background: float) -> torch.Tensor:
    radius_ratio = max(0.0, min(0.5, float(radius_ratio)))
    if radius_ratio <= 0:
        return image
    h, w = image.shape[1], image.shape[2]
    r = max(1.0, min(h, w) * radius_ratio)
    yy = torch.arange(h, device=image.device, dtype=image.dtype).view(1, h, 1, 1)
    xx = torch.arange(w, device=image.device, dtype=image.dtype).view(1, 1, w, 1)
    left = xx
    right = w - 1 - xx
    top = yy
    bottom = h - 1 - yy
    dx = torch.clamp(r - torch.minimum(left, right), min=0.0)
    dy = torch.clamp(r - torch.minimum(top, bottom), min=0.0)
    corner = torch.sqrt(dx * dx + dy * dy)
    mask = (corner <= r).to(image.dtype)
    bg = torch.full_like(image, float(background))
    if image.shape[-1] >= 4:
        out = image.clone()
        out[..., 3:4] = out[..., 3:4] * mask
        out[..., :3] = out[..., :3] * mask + bg[..., :3] * (1.0 - mask)
        return out
    return image * mask + bg * (1.0 - mask)


def _auto_scale(rgb: torch.Tensor, strength: float, per_channel: bool = True) -> torch.Tensor:
    strength = max(0.0, min(1.0, float(strength)))
    if strength <= 0:
        return rgb
    dims = (1, 2) if per_channel else (1, 2, 3)
    low = rgb.amin(dim=dims, keepdim=True)
    high = rgb.amax(dim=dims, keepdim=True)
    adjusted = (rgb - low) / torch.clamp(high - low, min=1e-5)
    return rgb * (1.0 - strength) + adjusted * strength


def _apply_config(source: torch.Tensor, state: dict[str, Any]) -> torch.Tensor:
    image = source.clone()
    original = source.clone()

    for op_id in _active_ops(state):
        try:
            image = _apply_op(image, original, state, op_id)
            image = _clamp01(image)
        except Exception as exc:
            print(f"[GJJ] 图片实时对比处理：跳过操作 {op_id}：{exc}")
    return image


def _apply_op(image: torch.Tensor, original: torch.Tensor, state: dict[str, Any], op_id: str) -> torch.Tensor:
    v = lambda name: _value(state, op_id, name)

    if op_id == "brightness":
        return _with_rgb(image, lambda rgb: rgb + v("amount"))
    if op_id == "contrast":
        amount = v("amount")
        factor = 1.0 + amount * (2.0 if amount > 0 else 1.0)
        return _with_rgb(image, lambda rgb: (rgb - 0.5) * factor + 0.5)
    if op_id == "saturation":
        amount = 1.0 + v("amount")
        return _with_rgb(image, lambda rgb: _luma(rgb) + (rgb - _luma(rgb)) * amount)
    if op_id == "hue":
        return _with_rgb(image, lambda rgb: _hue_rotate(rgb, v("degrees")))
    if op_id == "lightness":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: torch.where(torch.tensor(amount, device=rgb.device) >= 0, rgb + (1.0 - rgb) * amount, rgb * (1.0 + amount)))
    if op_id == "gamma":
        gamma = max(0.05, v("gamma"))
        return _with_rgb(image, lambda rgb: torch.pow(torch.clamp(rgb, min=0.0), 1.0 / gamma))
    if op_id == "levels":
        black = min(v("black"), v("white") - 0.001)
        white = max(v("white"), black + 0.001)
        gray = max(0.05, v("gray"))
        return _with_rgb(image, lambda rgb: torch.pow(torch.clamp((rgb - black) / (white - black), 0, 1), 1.0 / gray))
    if op_id == "rgb_channels":
        scale = torch.tensor([v("red"), v("green"), v("blue")], device=image.device, dtype=image.dtype).view(1, 1, 1, 3)
        return _with_rgb(image, lambda rgb: rgb * scale)
    if op_id == "hsl_channels":
        return _with_rgb(
            image,
            lambda rgb: _luma(_hue_rotate(rgb, v("hue"))) + (_hue_rotate(rgb, v("hue")) - _luma(_hue_rotate(rgb, v("hue")))) * (1.0 + v("saturation")) + v("lightness"),
        )
    if op_id == "invert":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + (1.0 - rgb) * amount)
    if op_id == "grayscale":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + _luma(rgb).repeat(1, 1, 1, 3) * amount)
    if op_id == "white_balance":
        temp = v("temperature")
        tint = v("tint")
        offset = torch.tensor([temp, tint * 0.5, -temp], device=image.device, dtype=image.dtype).view(1, 1, 1, 3)
        return _with_rgb(image, lambda rgb: rgb + offset)
    if op_id == "color_shift":
        amount = (v("amount") + 1.0) / 2.0
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + torch.roll(rgb, shifts=1, dims=-1) * amount)
    if op_id == "color_temp":
        temp = v("temperature")
        offset = torch.tensor([temp, temp * 0.18, -temp], device=image.device, dtype=image.dtype).view(1, 1, 1, 3)
        return _with_rgb(image, lambda rgb: rgb + offset)
    if op_id == "highlight_recover":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb - torch.clamp((_luma(rgb) - 0.55) / 0.45, 0, 1) * amount * 0.6)
    if op_id == "shadow_lift":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb + torch.clamp((0.55 - _luma(rgb)) / 0.55, 0, 1) * amount * (1.0 - rgb))
    if op_id == "exposure":
        return _with_rgb(image, lambda rgb: rgb * (2.0 ** v("ev")))
    if op_id == "split_tone":
        amount = v("amount")
        shadow = _rgb_from_hue(v("shadow_hue"), device=image.device, dtype=image.dtype)
        high = _rgb_from_hue(v("highlight_hue"), device=image.device, dtype=image.dtype)
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + (shadow * (1.0 - _luma(rgb)) + high * _luma(rgb)) * amount)
    if op_id == "auto_levels":
        return _with_rgb(image, lambda rgb: _auto_scale(rgb, v("strength"), per_channel=True))
    if op_id == "auto_contrast":
        return _with_rgb(image, lambda rgb: _auto_scale(rgb, v("strength"), per_channel=False))
    if op_id == "auto_white_balance":
        strength = v("strength")
        def wb(rgb):
            means = rgb.mean(dim=(1, 2), keepdim=True)
            gray = means.mean(dim=-1, keepdim=True)
            adjusted = rgb * torch.clamp(gray / torch.clamp(means, min=1e-5), 0.25, 4.0)
            return rgb * (1.0 - strength) + adjusted * strength
        return _with_rgb(image, wb)
    if op_id == "rotate":
        angle = math.radians(v("angle"))
        return _affine(image, [[math.cos(angle), -math.sin(angle), 0.0], [math.sin(angle), math.cos(angle), 0.0]])
    if op_id == "flip_h":
        return torch.flip(image, dims=[2])
    if op_id == "flip_v":
        return torch.flip(image, dims=[1])
    if op_id == "scale":
        sx = max(0.05, v("x"))
        sy = max(0.05, v("y"))
        return _affine(image, [[1.0 / sx, 0.0, 0.0], [0.0, 1.0 / sy, 0.0]])
    if op_id == "crop":
        return _center_crop(image, int(image.shape[1] * max(0.05, min(1.0, v("height")))), int(image.shape[2] * max(0.05, min(1.0, v("width")))))
    if op_id == "pad":
        size = int(round(min(image.shape[1], image.shape[2]) * max(0.0, v("size"))))
        return _pad_all(image, size, size, size, size, v("value"))
    if op_id == "translate":
        return _affine(image, [[1.0, 0.0, -v("x")], [0.0, 1.0, -v("y")]])
    if op_id == "perspective":
        return _affine(image, [[1.0, v("x"), 0.0], [v("y"), 1.0, 0.0]])
    if op_id == "aspect_crop":
        ratio = max(0.1, v("ratio"))
        h, w = image.shape[1], image.shape[2]
        if w / h > ratio:
            return _center_crop(image, h, int(h * ratio))
        return _center_crop(image, int(w / ratio), w)
    if op_id == "exif_orient":
        turns = int(round(v("quarter_turns"))) % 4
        return torch.rot90(image, turns, dims=[1, 2]) if turns else image
    if op_id == "gaussian_blur":
        return _with_rgb(image, lambda rgb: _gaussian_blur(rgb, v("radius")))
    if op_id == "mean_blur" or op_id == "box_blur":
        return _with_rgb(image, lambda rgb: _box_blur(rgb, v("radius")))
    if op_id == "bilateral_blur":
        radius = v("radius")
        strength = v("strength")
        return _with_rgb(image, lambda rgb: rgb * (1.0 - strength) + _gaussian_blur(rgb, radius) * strength)
    if op_id == "radial_blur":
        amount = v("amount")
        small = _resize_tensor(image, max(1, image.shape[1] // 3), max(1, image.shape[2] // 3), "bilinear")
        blurred = _resize_tensor(small, image.shape[1], image.shape[2], "bilinear")
        return image * (1.0 - amount) + blurred * amount
    if op_id == "motion_blur":
        return _with_rgb(image, lambda rgb: _motion_blur(rgb, v("radius"), v("angle")))
    if op_id == "usm_sharpen":
        amount = v("amount")
        radius = v("radius")
        return _with_rgb(image, lambda rgb: rgb + (rgb - _gaussian_blur(rgb, radius)) * amount)
    if op_id == "smart_sharpen":
        amount = v("amount")
        threshold = v("threshold")
        def smart(rgb):
            diff = rgb - _gaussian_blur(rgb, 1.0)
            return rgb + diff * amount * (diff.abs() > threshold).to(rgb.dtype)
        return _with_rgb(image, smart)
    if op_id == "edge_sharpen":
        amount = v("amount")
        kernel = torch.tensor([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], device=image.device, dtype=image.dtype)
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + _kernel_conv(rgb, kernel) * amount)
    if op_id == "denoise":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + _box_blur(rgb, 1.0 + amount * 3.0) * amount)
    if op_id == "skin_blur":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + _gaussian_blur(rgb, 2.0 + amount * 4.0) * amount)
    if op_id == "channel_sharpen":
        def chans(rgb):
            blur = _gaussian_blur(rgb, 1.5)
            factors = torch.tensor([v("red"), v("green"), v("blue")], device=rgb.device, dtype=rgb.dtype).view(1, 1, 1, 3)
            return rgb + (rgb - blur) * factors
        return _with_rgb(image, chans)
    if op_id == "dilate":
        return _with_rgb(image, lambda rgb: _pool(rgb, v("radius"), "max"))
    if op_id == "erode":
        return _with_rgb(image, lambda rgb: _pool(rgb, v("radius"), "min"))
    if op_id == "open_morph":
        return _with_rgb(image, lambda rgb: _pool(_pool(rgb, v("radius"), "min"), v("radius"), "max"))
    if op_id == "close_morph":
        return _with_rgb(image, lambda rgb: _pool(_pool(rgb, v("radius"), "max"), v("radius"), "min"))
    if op_id == "quantize":
        levels = max(2.0, round(v("levels")))
        return _with_rgb(image, lambda rgb: torch.round(rgb * (levels - 1.0)) / (levels - 1.0))
    if op_id == "threshold_key":
        threshold = v("threshold")
        softness = max(0.001, v("softness"))
        return _with_rgb(image, lambda rgb: rgb * torch.clamp((_luma(rgb) - threshold + softness) / (softness * 2.0), 0.0, 1.0))
    if op_id == "binary":
        threshold = v("threshold")
        return _with_rgb(image, lambda rgb: (_luma(rgb) >= threshold).to(rgb.dtype).repeat(1, 1, 1, 3))
    if op_id == "despeckle":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + _box_blur(rgb, 1.0) * amount)
    if op_id == "resample":
        scale = max(0.05, v("scale"))
        mode = ["nearest", "bilinear", "bicubic"][int(round(v("mode"))) % 3]
        return _resize_tensor(image, max(1, round(image.shape[1] * scale)), max(1, round(image.shape[2] * scale)), mode)
    if op_id == "blend_mode":
        rgb, alpha = _split_rgba(image)
        overlay = torch.roll(rgb, shifts=1, dims=-1)
        return _merge_rgba(_blend(rgb, overlay, int(round(v("mode"))), v("opacity")), alpha)
    if op_id == "opacity_blend":
        opacity = v("opacity")
        base = _resize_tensor(original, image.shape[1], image.shape[2], "bilinear")
        return base * (1.0 - opacity) + image * opacity
    if op_id == "solid_overlay":
        color = torch.tensor([v("red"), v("green"), v("blue")], device=image.device, dtype=image.dtype).view(1, 1, 1, 3)
        opacity = v("opacity")
        return _with_rgb(image, lambda rgb: _blend(rgb, color.expand_as(rgb), 3, opacity))
    if op_id == "mask_cut":
        threshold = v("threshold")
        softness = max(0.001, v("softness"))
        rgb, alpha = _split_rgba(image)
        mask = torch.clamp((_luma(rgb) - threshold + softness) / (softness * 2.0), 0.0, 1.0)
        return torch.cat([rgb, mask if alpha is None else alpha * mask], dim=-1)
    if op_id == "local_mask_color":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb + (torch.roll(rgb, 1, -1) - rgb) * _luma(rgb) * amount)
    if op_id == "alpha_key":
        threshold = v("threshold")
        softness = max(0.001, v("softness"))
        rgb, alpha = _split_rgba(image)
        key_dist = torch.linalg.norm(rgb - rgb[..., :1].new_tensor([0.0, 1.0, 0.0]).view(1, 1, 1, 3), dim=-1, keepdim=True)
        mask = torch.clamp((key_dist - threshold) / softness, 0.0, 1.0)
        return torch.cat([rgb, mask if alpha is None else alpha * mask], dim=-1)
    if op_id == "mono_filter":
        amount = v("amount")
        color = _rgb_from_hue(v("hue"), device=image.device, dtype=image.dtype)
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + _luma(rgb).repeat(1, 1, 1, 3) * color * amount)
    if op_id == "sepia":
        amount = v("amount")
        matrix = torch.tensor([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]], device=image.device, dtype=image.dtype)
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + torch.matmul(rgb, matrix.T) * amount)
    if op_id == "cool_cyan":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + (rgb + rgb.new_tensor([-0.06, 0.04, 0.12]).view(1, 1, 1, 3)) * amount)
    if op_id == "cyber_cool":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + _hue_rotate(rgb * 1.18 + 0.03, -18.0) * amount)
    if op_id == "film_grain":
        return _with_rgb(image, lambda rgb: _grain_like(rgb, v("amount"), v("seed")))
    if op_id == "vignette":
        return _with_rgb(image, lambda rgb: _vignette(rgb, v("amount"), v("size")))
    if op_id == "dust_gradient":
        amount = v("amount")
        h, w = image.shape[1], image.shape[2]
        gradient = torch.linspace(0, 1, w, device=image.device, dtype=image.dtype).view(1, 1, w, 1)
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount * 0.25) + gradient * amount * 0.25)
    if op_id == "negative":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + (1.0 - rgb) * amount)
    if op_id == "mono_mask":
        threshold = v("threshold")
        return _with_rgb(image, lambda rgb: (_luma(rgb) >= threshold).to(rgb.dtype).repeat(1, 1, 1, 3))
    if op_id == "sketch_desat":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + (1.0 - (_gaussian_blur(_luma(rgb), 2.0) - _luma(rgb)).abs() * 4.0).repeat(1, 1, 1, 3) * amount)
    if op_id == "soft_fog":
        amount = v("amount")
        return _with_rgb(image, lambda rgb: rgb * (1.0 - amount) + _gaussian_blur(rgb, 6.0) * amount + amount * 0.08)
    if op_id == "alpha_extract":
        rgb, alpha = _split_rgba(image)
        mask = alpha if alpha is not None else _luma(rgb)
        return mask.repeat(1, 1, 1, 3)
    if op_id == "transparent_remove":
        rgb, alpha = _split_rgba(image)
        if alpha is None:
            return image
        bg = torch.full_like(rgb, v("background"))
        return rgb * alpha + bg * (1.0 - alpha)
    if op_id == "feather_alpha":
        rgb, alpha = _split_rgba(image)
        if alpha is None:
            return image
        return torch.cat([rgb, _gaussian_blur(alpha, v("radius"))], dim=-1)
    if op_id == "transparent_fill":
        rgb, alpha = _split_rgba(image)
        if alpha is None:
            return image
        bg = torch.full_like(rgb, v("value"))
        return rgb * alpha + bg * (1.0 - alpha)
    if op_id == "rgb_split_merge":
        mode = int(round(v("mode"))) % 4
        if mode == 1:
            order = [1, 2, 0]
        elif mode == 2:
            order = [2, 0, 1]
        elif mode == 3:
            order = [2, 1, 0]
        else:
            order = [0, 1, 2]
        return _with_rgb(image, lambda rgb: rgb[..., order])
    if op_id == "channel_invert":
        channel = int(round(v("channel"))) % 3
        return _with_rgb(image, lambda rgb: torch.cat([1.0 - rgb[..., i : i + 1] if i == channel else rgb[..., i : i + 1] for i in range(3)], dim=-1))
    if op_id == "single_channel_gray":
        channel = int(round(v("channel"))) % 3
        return _with_rgb(image, lambda rgb: rgb[..., channel : channel + 1].repeat(1, 1, 1, 3))
    if op_id == "center_trim":
        amount = max(0.0, min(0.95, v("amount")))
        return _center_crop(image, int(image.shape[1] * (1.0 - amount)), int(image.shape[2] * (1.0 - amount)))
    if op_id == "fixed_crop":
        return _center_crop(image, int(image.shape[1] * max(0.05, v("height"))), int(image.shape[2] * max(0.05, v("width"))))
    if op_id == "border_trim":
        amount = max(0.0, min(0.45, v("amount")))
        y = int(image.shape[1] * amount)
        x = int(image.shape[2] * amount)
        return image[:, y : image.shape[1] - y or image.shape[1], x : image.shape[2] - x or image.shape[2], :]
    if op_id == "canvas_expand":
        amount = int(round(min(image.shape[1], image.shape[2]) * max(0.0, v("amount"))))
        return _pad_all(image, amount, amount, amount, amount, v("value"))
    if op_id == "asymmetric_pad":
        unit = min(image.shape[1], image.shape[2])
        return _pad_all(image, int(unit * v("left")), int(unit * v("right")), int(unit * v("top")), int(unit * v("bottom")), 0.0)
    if op_id == "rounded_corner":
        return _rounded(image, v("radius"), v("background"))

    return image


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_RealtimeImageProcessor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🪄 图片实时对比处理"}


def _safe_output_filename(prefix: str) -> str:
    stem = re.sub(r"[^0-9A-Za-z._-]+", "_", str(prefix or "GJJ_RealtimeImageProcessor")).strip("._-")
    stem = stem or "GJJ_RealtimeImageProcessor"
    return f"{stem}_{time.strftime('%Y%m%d_%H%M%S')}.png"


def _register_save_api() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception as exc:
        print(f"[GJJ] 图片实时对比处理保存接口注册失败：{exc}")
        return

    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(server, "_gjj_realtime_image_processor_save_api_registered", False):
        return

    @server.routes.post("/gjj/realtime_image_processor/download_image")
    async def gjj_realtime_image_processor_download_image(request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        url = str(payload.get("url") or "").strip()
        if not _is_network_url(url):
            return web.json_response({"ok": False, "message": "只支持 http/https 图片地址。"}, status=400)
        if not _detect_image_type(url):
            return web.json_response({"ok": False, "message": "无法识别图片类型。"}, status=400)
        try:
            file_path = _download_network_image_to_input(url)
            return web.json_response({
                "ok": True,
                "filename": _input_relative_image_path(file_path),
                "name": Path(file_path).name,
                "type": "input",
                "subfolder": "",
            })
        except Exception as exc:
            return web.json_response({"ok": False, "message": f"下载失败：{exc}"}, status=500)

    @server.routes.post("/gjj/realtime_image_processor/save")
    async def gjj_realtime_image_processor_save(request):
        try:
            payload = await request.json()
            raw_image = str(payload.get("image") or payload.get("data_url") or "").strip()
            if not raw_image:
                return web.json_response({"ok": False, "message": "没有收到可保存的图片数据。"}, status=400)

            if "," in raw_image:
                raw_image = raw_image.split(",", 1)[1]
            data = base64.b64decode(raw_image, validate=False)
            image = Image.open(io.BytesIO(data))
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")

            output_dir = folder_paths.get_output_directory()
            os.makedirs(output_dir, exist_ok=True)
            filename = _safe_output_filename(str(payload.get("prefix") or "GJJ_RealtimeImageProcessor"))
            path = os.path.join(output_dir, filename)
            index = 1
            while os.path.exists(path):
                root, ext = os.path.splitext(filename)
                filename = f"{root}_{index}{ext}"
                path = os.path.join(output_dir, filename)
                index += 1

            image.save(path, format="PNG")
            return web.json_response({
                "ok": True,
                "filename": filename,
                "subfolder": "",
                "type": "output",
            })
        except Exception as exc:
            return web.json_response({"ok": False, "message": f"保存失败：{exc}"}, status=500)

    server._gjj_realtime_image_processor_save_api_registered = True


_register_save_api()
