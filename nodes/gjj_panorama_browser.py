from __future__ import annotations

import base64
import hashlib
import io
import os
import time
import uuid
from pathlib import Path
from typing import Any

import comfy.utils
import folder_paths
import torch
from aiohttp import web
from comfy import model_management
from PIL import Image, ImageOps
from server import PromptServer

from .gjj_model_upscaler import _load_upscale_model, _list_upscale_models


NODE_NAME = "GJJ_PanoramaBrowser"
SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
TEMP_SUBFOLDER = "GJJ/panorama_browser"
INPUT_SUBFOLDER = "GJJ/panorama_browser"


def _hidden_widget(options: dict[str, Any]) -> dict[str, Any]:
    result = dict(options)
    result["hidden"] = True
    result["display"] = "hidden"
    return result


def _default_value(values: list[str]) -> str:
    return values[0] if values else ""


def _preferred_upscale_model(values: list[str]) -> str:
    if not values:
        return ""
    lowered = [(name, str(name or "").lower()) for name in values]
    for keyword in ("2x", "x2", "2_x", "scale2"):
        for original, text in lowered:
            if keyword in text:
                return original
    return values[0]


def _safe_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except Exception:
        return fallback


def _resolve_image_path(path_text: str) -> Path:
    raw = str(path_text or "").strip().strip('"')
    if not raw:
        raise ValueError("未填写全景图片路径，也没有连接 IMAGE 输入。")
    path = Path(os.path.expandvars(os.path.expanduser(raw)))
    candidates = [path] if path.is_absolute() else [
        Path(folder_paths.get_input_directory()) / path,
        Path(folder_paths.get_output_directory()) / path,
        Path(folder_paths.get_temp_directory()) / path,
    ]
    resolved = None
    for candidate in candidates:
        candidate = candidate.resolve()
        if candidate.is_file():
            resolved = candidate
            break
    if resolved is None:
        raise ValueError(f"找不到图片文件：{raw}")
    if resolved.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise ValueError("只支持 PNG/JPG/WEBP/BMP/TIFF 全景图片。")
    return resolved


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    image = ImageOps.exif_transpose(image).convert("RGB")
    data = torch.ByteTensor(torch.ByteStorage.from_buffer(image.tobytes()))
    data = data.reshape((image.height, image.width, 3)).float() / 255.0
    return data.unsqueeze(0).contiguous()


def _tensor_to_pil(images: torch.Tensor, index: int = 0) -> Image.Image:
    image = images[index].detach().cpu().clamp(0.0, 1.0)
    data = (image * 255.0).round().to(torch.uint8).numpy()
    return Image.fromarray(data, "RGB")


def _image_fingerprint(images: Any) -> str:
    if not isinstance(images, torch.Tensor):
        return ""
    with torch.no_grad():
        tensor = images.detach()
        shape = tuple(int(dim) for dim in tensor.shape)
        flat = tensor.reshape(-1)
        if flat.numel() == 0:
            return f"{shape}:empty"
        step = max(1, flat.numel() // 65536)
        sample = flat[::step][:65536].detach().cpu().contiguous()
        if sample.dtype != torch.float32:
            sample = sample.float()
        digest = hashlib.sha256(sample.numpy().tobytes()).hexdigest()[:20]
        mean = float(sample.mean().item())
        return f"{shape}:{sample.numel()}:{mean:.8f}:{digest}"


def _source_tensor_from_inputs(
    image_path: str,
    prefer_connected_image: bool,
    image: Any,
) -> torch.Tensor | None:
    has_image = isinstance(image, torch.Tensor)
    path_text = str(image_path or "").strip()
    if bool(prefer_connected_image) and has_image:
        return image
    if path_text:
        return _load_path_image(path_text)
    if has_image:
        return image
    return None


def _save_temp_tensor(images: torch.Tensor, prefix: str) -> dict[str, Any]:
    return _save_temp_pil(_tensor_to_pil(images), prefix)


def _load_path_image(path_text: str) -> torch.Tensor:
    path = _resolve_image_path(path_text)
    with Image.open(path) as image:
        return _pil_to_tensor(image)


def _decode_screenshot_pil(data_url: str) -> Image.Image:
    text = str(data_url or "").strip()
    if not text:
        raise ValueError("请先在全景浏览器里框选截图或点击当前视角截图，再执行节点。")
    if "," in text and text.lower().startswith("data:image/"):
        text = text.split(",", 1)[1]
    try:
        payload = base64.b64decode(text, validate=False)
        with Image.open(io.BytesIO(payload)) as image:
            if image.width >= 4096 or image.height >= 2048:
                raise ValueError(
                    "截图尺寸像是整张全景原图，请在浏览器画面里框选局部后再执行。"
                )
            return ImageOps.exif_transpose(image).convert("RGB")
    except Exception as exc:
        raise ValueError(f"截图数据解析失败：{exc}") from exc


def _decode_screenshot(data_url: str) -> torch.Tensor:
    return _pil_to_tensor(_decode_screenshot_pil(data_url))


def _load_screenshot_reference(value: str) -> torch.Tensor:
    text = str(value or "").strip()
    if text.lower().startswith("file:"):
        return _load_path_image(text.split(":", 1)[1])
    return _decode_screenshot(text)


def _resize_lanczos(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    if int(image.shape[2]) == int(width) and int(image.shape[1]) == int(height):
        return image
    samples = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(samples, int(width), int(height), "lanczos", "disabled")
    return resized.movedim(1, -1).clamp(0.0, 1.0)


def _apply_upscale_model(image: torch.Tensor, model_name: str) -> torch.Tensor:
    upscale_model = _load_upscale_model(model_name)
    device = model_management.get_torch_device()
    memory_required = model_management.module_size(upscale_model.model)
    memory_required += (512 * 512 * 3) * image.element_size() * max(upscale_model.scale, 1.0) * 384.0
    memory_required += image.nelement() * image.element_size()
    model_management.free_memory(memory_required, device)

    upscale_model.to(device)
    input_image = image.movedim(-1, -3).to(device)
    tile = 512
    overlap = 32
    try:
        while True:
            try:
                steps = input_image.shape[0] * comfy.utils.get_tiled_scale_steps(
                    input_image.shape[3],
                    input_image.shape[2],
                    tile_x=tile,
                    tile_y=tile,
                    overlap=overlap,
                )
                progress = comfy.utils.ProgressBar(steps)
                scaled = comfy.utils.tiled_scale(
                    input_image,
                    lambda tensor: upscale_model(tensor),
                    tile_x=tile,
                    tile_y=tile,
                    overlap=overlap,
                    upscale_amount=upscale_model.scale,
                    pbar=progress,
                )
                return torch.clamp(scaled.movedim(-3, -1), min=0.0, max=1.0)
            except Exception as exc:
                model_management.raise_non_oom(exc)
                tile //= 2
                if tile < 128:
                    raise exc
    finally:
        upscale_model.to("cpu")


def _upscale_image(
    image: torch.Tensor,
    enabled: bool,
    model_name: str,
    max_output_edge: int,
) -> torch.Tensor:
    if not bool(enabled):
        return image
    if not str(model_name or "").strip():
        raise ValueError("启用模型放大时必须选择放大模型。")
    upscaled = _apply_upscale_model(image, model_name)
    limit = max(512, _safe_int(max_output_edge, 8192))
    width = int(upscaled.shape[2])
    height = int(upscaled.shape[1])
    longest = max(width, height)
    if longest <= limit:
        return upscaled
    scale = limit / float(longest)
    return _resize_lanczos(upscaled, max(8, round(width * scale)), max(8, round(height * scale)))


def _save_temp_pil(image: Image.Image, prefix: str) -> dict[str, Any]:
    temp_root = Path(folder_paths.get_temp_directory()).resolve()
    subfolder = TEMP_SUBFOLDER
    target_dir = temp_root / subfolder
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{prefix}_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}.png"
    image = ImageOps.exif_transpose(image).convert("RGB")
    image.save(target_dir / filename, format="PNG")
    return {
        "filename": filename,
        "subfolder": subfolder,
        "type": "temp",
        "width": image.width,
        "height": image.height,
    }


def _save_input_pil(image: Image.Image, prefix: str) -> dict[str, Any]:
    input_root = Path(folder_paths.get_input_directory()).resolve()
    subfolder = INPUT_SUBFOLDER
    target_dir = input_root / subfolder
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{prefix}_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}.png"
    image = ImageOps.exif_transpose(image).convert("RGB")
    image.save(target_dir / filename, format="PNG")
    return {
        "filename": filename,
        "subfolder": subfolder,
        "type": "input",
        "image_path": f"{subfolder}/{filename}",
        "width": image.width,
        "height": image.height,
    }


def _register_preview_api() -> None:
    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(server, "_gjj_panorama_browser_api_registered", False):
        return

    @server.routes.get("/gjj/panorama_browser/preview")
    async def panorama_preview(request):
        try:
            path = _resolve_image_path(request.query.get("path", ""))
            with Image.open(path) as image:
                item = _save_temp_pil(image, "GJJ_PanoramaBrowser_path")
            return web.json_response({"ok": True, "image": item})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    @server.routes.post("/gjj/panorama_browser/screenshot")
    async def panorama_screenshot(request):
        try:
            payload = await request.json()
            image = _decode_screenshot_pil(str(payload.get("data") or ""))
            item = _save_input_pil(image, "GJJ_PanoramaBrowser_screenshot")
            return web.json_response({"ok": True, "image": item})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    server._gjj_panorama_browser_api_registered = True


_register_preview_api()


class GJJ_PanoramaBrowser:
    CATEGORY = "GJJ/🖼️ 图像/全景"
    FUNCTION = "browse"
    OUTPUT_NODE = True
    DESCRIPTION = "360 度全景图片浏览与截图节点：支持路径或 IMAGE 输入，前端可拖拽视角、滚轮缩放、框选截图，并内置模型放大输出。"
    SEARCH_ALIASES = ["全景", "360", "panorama", "pano", "vr preview", "全景预览", "全景截图", "模型放大"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("放大框选图",)
    OUTPUT_TOOLTIPS = ("前端框选后的当前视角截图，再经过 GJJ_ModelUpscaler 同款模型放大；不会放大整张全景原图。",)

    @classmethod
    def INPUT_TYPES(cls):
        upscale_models = _list_upscale_models() or [""]
        return {
            "required": {
                "image_path": ("STRING", _hidden_widget({
                    "default": "",
                    "multiline": False,
                    "display_name": "全景图片路径",
                    "tooltip": "可填写本地全景图片路径；如果连接了 IMAGE 输入，可留空。",
                })),
                "prefer_connected_image": ("BOOLEAN", _hidden_widget({
                    "default": True,
                    "display_name": "优先使用输入图像",
                    "tooltip": "开启时优先使用连接的 IMAGE；关闭时优先从路径加载。",
                })),
                "enable_upscale": ("BOOLEAN", _hidden_widget({
                    "default": True,
                    "display_name": "启用模型放大",
                    "tooltip": "开启后复用 GJJ_ModelUpscaler 的模型放大逻辑输出高清全景图。",
                })),
                "upscale_model_name": (upscale_models, _hidden_widget({
                    "default": _preferred_upscale_model(upscale_models),
                    "display_name": "放大模型",
                    "tooltip": "从 models/upscale_models 中选择单图超分模型；默认优先选择名称包含 2x / x2 的模型。",
                })),
                "max_output_edge": ("INT", _hidden_widget({
                    "default": 8192,
                    "min": 512,
                    "max": 32768,
                    "step": 64,
                    "display_name": "最大输出边长",
                    "tooltip": "模型放大后如果最长边超过该值，会用 Lanczos 等比缩回，避免全景图过大。",
                })),
                "viewer_height": ("INT", _hidden_widget({
                    "default": 360,
                    "min": 180,
                    "max": 900,
                    "step": 10,
                    "display_name": "浏览器高度",
                    "tooltip": "节点内 360 预览窗口高度。",
                })),
                "screenshot_data": ("STRING", _hidden_widget({
                    "default": "",
                    "multiline": True,
                    "display_name": "截图数据",
                    "tooltip": "前端框选截图后自动写入，通常不需要手动编辑。",
                })),
            },
            "optional": {
                "image": ("IMAGE", {
                    "display_name": "输入图像",
                    "tooltip": "可连接上游全景 IMAGE；连接后可不填写路径。",
                }),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        path = str(kwargs.get("image_path", "") or "").strip()
        stamp = ""
        try:
            resolved = _resolve_image_path(path) if path else None
            if resolved:
                stat = resolved.stat()
                stamp = f"{stat.st_mtime_ns}:{stat.st_size}"
        except Exception:
            stamp = path
        screenshot = str(kwargs.get("screenshot_data", "") or "")[:96]
        image = kwargs.get("image")
        image_stamp = _image_fingerprint(image)
        return f"{stamp}|{image_stamp}|{bool(kwargs.get('enable_upscale'))}|{kwargs.get('upscale_model_name')}|{kwargs.get('max_output_edge')}|{screenshot}"

    def browse(
        self,
        image_path,
        prefer_connected_image,
        enable_upscale,
        upscale_model_name,
        max_output_edge,
        viewer_height,
        screenshot_data,
        image=None,
        prompt=None,
        extra_pnginfo=None,
    ):
        source = _source_tensor_from_inputs(image_path, prefer_connected_image, image)
        screenshot_text = str(screenshot_data or "").strip()
        if not screenshot_text and source is None:
            raise ValueError("请先连接 IMAGE 输入、选择全景图，或在全景浏览器里框选截图。")

        result_image = source
        screenshot = None
        upscaled_screenshot = None
        if screenshot_text:
            screenshot = _load_screenshot_reference(screenshot_text)
            upscaled_screenshot = _upscale_image(screenshot, bool(enable_upscale), upscale_model_name, int(max_output_edge))
            result_image = upscaled_screenshot

        if result_image is None:
            raise ValueError("没有可输出的全景图或截图。")

        ui = {
            "panorama_viewer_height": (int(viewer_height),),
        }
        if source is not None:
            ui["panorama_source"] = (_save_temp_tensor(source, "GJJ_PanoramaBrowser_source"),)
            ui["panorama_source_size"] = (f"{int(source.shape[2])} x {int(source.shape[1])}",)
        if screenshot is not None and upscaled_screenshot is not None:
            ui["panorama_size"] = (f"{int(screenshot.shape[2])} x {int(screenshot.shape[1])}",)
            ui["panorama_upscaled"] = (_save_temp_tensor(upscaled_screenshot, "GJJ_PanoramaBrowser_upscaled"),)
            ui["panorama_output_size"] = (f"{int(upscaled_screenshot.shape[2])} x {int(upscaled_screenshot.shape[1])}",)
        return {"ui": ui, "result": (result_image,)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_PanoramaBrowser}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🌐 360全景浏览器"}
