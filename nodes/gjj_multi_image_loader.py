from __future__ import annotations

import comfy.utils
import hashlib
import importlib.util
import json
import os
import re
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageFile, ImageOps
try:
    from server import PromptServer
except Exception:
    PromptServer = None

import folder_paths

from .common_utils.network_media import (
    gjjutils_detect_media_type,
    gjjutils_download_network_media_to_input,
    gjjutils_input_relative_media_path,
    gjjutils_is_network_url,
    gjjutils_media_file_starts_like_html,
)
from .common_utils.temp_files import (
    gjjutils_read_temp_pil_image,
    gjjutils_temp_root,
    gjjutils_write_temp_bytes,
    gjjutils_write_temp_file,
    gjjutils_write_temp_pil_image,
)
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_MultiImageLoader"
IMAGE_API_PATH = "/gjj/input_images"
THUMB_API_PATH = "/gjj/input_image_thumb"
DEFAULT_NETWORK_IMAGE_API_PATH = "/gjj/multi_image_loader/default_image"
TEMP_UPLOAD_API_PATH = "/gjj/multi_image_loader/upload_temp_images"
MAX_OUTPUT_IMAGES = 20
NETWORK_IMAGE_DOWNLOAD_TIMEOUT = 8
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".avif"}
INPUT_IMAGE_TYPES = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
SEQUENCE_RANGE_INPUT_TYPES = "INT,STRING,FLOAT"
_IMAGE_META_CACHE: dict[str, tuple[int, int, int, int]] = {}
_cv2 = None

# Some ComfyUI-generated PNGs contain browser-tolerated metadata CRC issues.
# Pillow rejects those by default, so keep this loader permissive.
ImageFile.LOAD_TRUNCATED_IMAGES = True


class AnyType(str):
    """ComfyUI socket type that accepts upstream values without pre-conversion."""

    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _load_cv2_optional():
    global _cv2
    if _cv2 is not None:
        return _cv2
    if importlib.util.find_spec("cv2") is None:
        return None
    try:
        import cv2
        _cv2 = cv2
        return _cv2
    except Exception:
        return None


def _decode_image_array_cv2(path: Path) -> np.ndarray:
    cv2 = _load_cv2_optional()
    if cv2 is None:
        raise RuntimeError("当前环境没有可用的 OpenCV(cv2) 解码兜底。")
    data = np.frombuffer(path.read_bytes(), dtype=np.uint8)
    decoded = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if decoded is None:
        raise RuntimeError("OpenCV 也无法识别该图片。")

    if decoded.ndim == 2:
        array = decoded[:, :, None]
    elif decoded.ndim == 3 and decoded.shape[2] == 4:
        array = cv2.cvtColor(decoded, cv2.COLOR_BGRA2RGBA)
    elif decoded.ndim == 3 and decoded.shape[2] == 3:
        array = cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB)
    elif decoded.ndim == 3 and decoded.shape[2] == 1:
        array = decoded
    else:
        raise RuntimeError(f"OpenCV 解码得到不支持的通道形状：{decoded.shape}")

    if array.dtype == np.uint8:
        scale = 255.0
    elif array.dtype == np.uint16:
        scale = 65535.0
    else:
        scale = float(np.max(array)) or 1.0
    array = array.astype(np.float32) / scale
    if array.shape[2] == 1:
        array = np.repeat(array, 3, axis=2)
    return np.clip(array, 0.0, 1.0)


def _load_image_array_pillow(path: Path) -> np.ndarray:
    with Image.open(path) as opened:
        opened.load()
        image = ImageOps.exif_transpose(opened)
        if image.mode == "RGBA":
            array = np.asarray(image).astype(np.float32) / 255.0
        else:
            image = image.convert("RGB")
            array = np.asarray(image).astype(np.float32) / 255.0
    return array


def _load_image_array(path: Path) -> np.ndarray:
    try:
        return _load_image_array_pillow(path)
    except Exception as pillow_error:
        try:
            return _decode_image_array_cv2(path)
        except Exception as cv2_error:
            raise RuntimeError(f"Pillow 读取失败：{pillow_error}；OpenCV 兜底失败：{cv2_error}") from pillow_error


def _probe_image_size(path: Path) -> tuple[int, int]:
    if gjjutils_media_file_starts_like_html(path):
        raise RuntimeError("缓存内容是网页 HTML，不是图片文件。")
    try:
        with Image.open(path) as image:
            width, height = image.size
            image.verify()
        return int(width), int(height)
    except Exception:
        array = _decode_image_array_cv2(path)
        height, width = array.shape[:2]
        return int(width), int(height)


def _thumbnail_image_from_path(path: Path) -> Image.Image:
    try:
        with Image.open(path) as opened:
            opened.load()
            return ImageOps.exif_transpose(opened).convert("RGB")
    except Exception:
        array = _decode_image_array_cv2(path)
        rgb = array[:, :, :3]
        return Image.fromarray((np.clip(rgb, 0.0, 1.0) * 255.0).round().astype(np.uint8))


def list_input_images() -> list[dict[str, Any]]:
    input_dir = Path(folder_paths.get_input_directory()).resolve()
    items: list[dict[str, Any]] = []
    if not input_dir.exists():
        return items

    for file_path in sorted(input_dir.rglob("*")):
        # 检查是否存在路径遍历攻击
        try:
            resolved_path = file_path.resolve()
            if not resolved_path.is_relative_to(input_dir):
                continue  # 跳过不在目标目录下的文件
        except ValueError:
            continue  # 如果路径无法比较，跳过

        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        if gjjutils_media_file_starts_like_html(file_path):
            continue
        relative = file_path.relative_to(input_dir)
        filename = file_path.name
        subfolder = str(relative.parent).replace("\\", "/")
        if subfolder == ".":
            subfolder = ""
        width = 0
        height = 0
        try:
            stat = file_path.stat()
            mtime_ns = int(stat.st_mtime_ns)
            size_bytes = int(stat.st_size)
            cache_key = str(file_path)
            cached = _IMAGE_META_CACHE.get(cache_key)
            if cached and cached[0] == mtime_ns and cached[1] == size_bytes:
                width, height = cached[2], cached[3]
            else:
                # 只读取图片头部尺寸，不完整解码。完整 image.load() 在图片很多/很大时会明显拖慢前端刷新。
                width, height = _probe_image_size(file_path)
                _IMAGE_META_CACHE[cache_key] = (mtime_ns, size_bytes, int(width), int(height))
        except Exception as error:
            try:
                print(f"✖{file_path} ({error})")
            except Exception:
                pass
            continue

        items.append(
            {
                "filename": filename,
                "subfolder": subfolder,
                "label": f"{subfolder}/{filename}" if subfolder else filename,
                "width": width,
                "height": height,
                "mtime_ns": mtime_ns,
                "size_bytes": size_bytes,
            }
        )
    return items


async def get_gjj_input_images(request):
    return web.json_response({"images": list_input_images()})


def _input_image_item_from_path(file_path: str | Path) -> dict[str, Any]:
    path = Path(file_path).resolve()
    relative = Path(gjjutils_input_relative_media_path(str(path)))
    filename = relative.name
    subfolder = str(relative.parent).replace("\\", "/")
    if subfolder == ".":
        subfolder = ""

    width = 0
    height = 0
    try:
        width, height = _probe_image_size(path)
    except Exception as error:
        raise RuntimeError(f"网络图片已下载，但图片文件无法识别：{relative.as_posix()}。原始错误：{error}") from error

    stat = path.stat()
    return {
        "filename": filename,
        "subfolder": subfolder,
        "label": f"{subfolder}/{filename}" if subfolder else filename,
        "type": "input",
        "width": int(width),
        "height": int(height),
        "mtime_ns": int(stat.st_mtime_ns),
        "size_bytes": int(stat.st_size),
    }


def _clean_network_image_url(value: Any) -> str:
    return re.sub(
        r'^[\[\]({【「『]+|[,，;；。.!！?？\]\)}】」』]+$',
        "",
        str(value or "").strip().strip('"').strip("'").strip("“”‘’"),
    ).strip()


async def post_gjj_default_network_image(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}

    raw_urls = data.get("urls")
    if isinstance(raw_urls, list):
        urls = [_clean_network_image_url(item) for item in raw_urls]
    else:
        text = str(data.get("url") or "").strip()
        matches = re.findall(r'https?://[^\s<>"\'“”‘’]+', text, flags=re.IGNORECASE)
        urls = [_clean_network_image_url(part) for part in matches]
    urls = [url for url in urls if url]
    if not urls:
        return web.json_response({"ok": False, "error": "只支持 http/https 网络图片地址。"}, status=400)

    items: list[dict[str, Any]] = []
    errors: list[str] = []
    for index, url in enumerate(urls, start=1):
        if not gjjutils_is_network_url(url):
            errors.append(f"第 {index} 条不是 http/https 图片地址：{url}")
            continue
        detected_type = gjjutils_detect_media_type(url)
        if detected_type and detected_type != "IMAGE":
            errors.append(f"第 {index} 条不是图片地址：{url}")
            continue
        try:
            file_path = gjjutils_download_network_media_to_input(
                url,
                "IMAGE",
                timeout=NETWORK_IMAGE_DOWNLOAD_TIMEOUT,
                use_curl_fallback=False,
            )
            item = _input_image_item_from_path(file_path)
            item["source_url"] = url
            items.append(item)
        except Exception as error:
            errors.append(f"第 {index} 条下载失败：{error}")

    if not items:
        message = "；".join(errors[:5]) if errors else "设置默认网络图片失败。"
        return web.json_response({
            "ok": False,
            "error": message,
            "items": [],
            "errors": errors[:20],
        })

    return web.json_response({
        "ok": True,
        "item": items[0],
        "items": items,
        "errors": errors[:20],
    })


def _uploaded_image_suffix(filename: str, content_type: str = "") -> str:
    suffix = Path(str(filename or "")).suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        return suffix
    content_type = str(content_type or "").lower()
    if "jpeg" in content_type or "jpg" in content_type:
        return ".jpg"
    if "png" in content_type:
        return ".png"
    if "webp" in content_type:
        return ".webp"
    if "bmp" in content_type:
        return ".bmp"
    if "gif" in content_type:
        return ".gif"
    if "avif" in content_type:
        return ".avif"
    return ".png"


def _write_uploaded_image_to_temp(content: bytes, filename: str = "", content_type: str = "") -> dict[str, Any]:
    if not content:
        raise ValueError("图片内容为空")
    suffix = _uploaded_image_suffix(filename, content_type)
    with Image.open(BytesIO(content)) as image:
        image.load()
        format_name = str(image.format or suffix.lstrip(".") or "PNG").lower()
    info = gjjutils_write_temp_bytes(content, suffix=suffix)
    saved_image = gjjutils_read_temp_pil_image(info)
    path = (Path(folder_paths.get_temp_directory()).resolve() / str(info.get("subfolder") or "") / str(info.get("filename") or "")).resolve()
    stat = path.stat() if path.exists() else None
    info.update(
        {
            "label": str(info.get("filename") or ""),
            "source": "drag_upload",
            "media_type": "image",
            "format": f"image/{format_name}",
            "width": int(saved_image.width),
            "height": int(saved_image.height),
            "mtime_ns": int(stat.st_mtime_ns) if stat else 0,
            "size_bytes": int(stat.st_size) if stat else 0,
            "original_name": Path(str(filename or "")).name,
        }
    )
    return info


async def post_gjj_multi_image_loader_upload_temp_images(request):
    try:
        reader = await request.multipart()
        uploaded: list[dict[str, Any]] = []
        errors: list[str] = []
        async for part in reader:
            if part.name not in {"image", "images", "file", "files"}:
                continue
            filename = str(part.filename or "")
            try:
                content = await part.read(decode=False)
                uploaded.append(
                    _write_uploaded_image_to_temp(
                        content,
                        filename=filename,
                        content_type=str(part.headers.get("Content-Type", "")),
                    )
                )
            except Exception as error:
                errors.append(f"{filename or '未命名图片'}: {error}")
        if not uploaded:
            message = "；".join(errors[:5]) if errors else "缺少图片"
            return web.json_response({"ok": False, "error": message, "items": [], "errors": errors[:20]}, status=400)
        return web.json_response({"ok": True, "items": uploaded, "images": uploaded, "errors": errors[:20]})
    except Exception as error:
        return web.json_response({"ok": False, "error": str(error), "items": []}, status=500)


def _safe_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        number = int(value)
    except Exception:
        return default
    return max(min_value, min(max_value, number))


def _thumbnail_cache_dir() -> Path:
    try:
        base = gjjutils_temp_root().resolve()
    except Exception:
        base = Path(folder_paths.get_input_directory()).resolve() / ".gjj_thumb_cache"
    path = base / "multi_image_loader_thumbs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _thumbnail_cache_path(source: Path, subfolder: str, filename: str, size: int) -> Path:
    stat = source.stat()
    key = f"{subfolder}/{filename}|{stat.st_mtime_ns}|{stat.st_size}|{size}"
    digest = hashlib.sha1(key.encode("utf-8", "ignore")).hexdigest()
    return _thumbnail_cache_dir() / f"{digest}.jpg"


async def get_gjj_input_image_thumb(request):
    filename = str(request.query.get("filename") or "").strip()
    subfolder = str(request.query.get("subfolder") or "").strip().replace("\\", "/")
    image_type = str(request.query.get("type") or "input").strip()
    size = _safe_int(request.query.get("size"), 192, 64, 512)
    if image_type != "input" or not filename:
        raise web.HTTPBadRequest(text="Only input images are supported.")

    source = resolve_input_image_path({"filename": filename, "subfolder": subfolder})
    cache_path = _thumbnail_cache_path(source, subfolder, filename, size)
    if not cache_path.exists():
        try:
            image = _thumbnail_image_from_path(source)
            image.thumbnail((size, size), Image.Resampling.LANCZOS)
            image.save(cache_path, "JPEG", quality=82, optimize=True, progressive=True)
        except Exception as error:
            try:
                print(f"[GJJ_MultiImageLoader] 缩略图生成失败，回退返回原图：{source} ({error})")
            except Exception:
                pass
            response = web.FileResponse(source)
            response.headers["Cache-Control"] = "no-cache"
            return response

    response = web.FileResponse(cache_path)
    response.headers["Cache-Control"] = "public, max-age=604800, immutable"
    return response


def _register_multi_image_loader_routes() -> None:
    server = getattr(PromptServer, "instance", None) if PromptServer is not None else None
    routes = getattr(server, "routes", None)
    if server is None or routes is None:
        return
    if getattr(server, "_gjj_multi_image_loader_routes_registered", False):
        return
    setattr(server, "_gjj_multi_image_loader_routes_registered", True)
    routes.get(IMAGE_API_PATH)(get_gjj_input_images)
    routes.get(THUMB_API_PATH)(get_gjj_input_image_thumb)
    routes.post(DEFAULT_NETWORK_IMAGE_API_PATH)(post_gjj_default_network_image)
    routes.post(TEMP_UPLOAD_API_PATH)(post_gjj_multi_image_loader_upload_temp_images)


_register_multi_image_loader_routes()


def parse_selected_images(raw_value: Any) -> list[dict[str, str]]:
    if raw_value is None:
        return []
    text = str(raw_value).strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []

    cleaned: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in parsed:
        if not isinstance(item, dict):
            continue
        filename = str(item.get("filename") or "").strip()
        subfolder = str(item.get("subfolder") or "").strip().replace("\\", "/")
        image_type = str(item.get("type") or "input").strip().lower()
        if image_type not in {"input", "temp", "output"}:
            image_type = "input"
        if not filename:
            continue
        key = (image_type, subfolder, filename)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append({"filename": filename, "subfolder": subfolder, "type": image_type})
    # 批量队列不限制图片数量；单图输出仍由前端最多展开 20 个。
    return cleaned


def recover_selected_images(raw_value: Any, extra_pnginfo: Any = None, unique_id: Any = None) -> list[dict[str, str]]:
    selected = parse_selected_images(raw_value)
    if selected:
        return selected
    if not isinstance(extra_pnginfo, dict):
        return []
    workflow = extra_pnginfo.get("workflow")
    if not isinstance(workflow, dict):
        return []
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return []

    candidates: list[list[dict[str, str]]] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != NODE_NAME:
            continue
        if unique_id is not None and str(node.get("id")) != str(unique_id):
            continue
        properties = node.get("properties")
        if isinstance(properties, dict):
            from_property = parse_selected_images(properties.get("selected_images"))
            if from_property:
                candidates.append(from_property)
                continue
        widget_values = node.get("widgets_values")
        if isinstance(widget_values, list):
            for value in widget_values:
                from_widget = parse_selected_images(value)
                if from_widget:
                    candidates.append(from_widget)
                    break
    if unique_id is not None and candidates:
        return candidates[0]
    return candidates[0] if len(candidates) == 1 else []
def sequence_range_to_text(raw_value: Any) -> str:
    if isinstance(raw_value, (list, tuple)) and len(raw_value) == 1:
        raw_value = raw_value[0]
    if raw_value is None:
        return ""
    if isinstance(raw_value, bool):
        return "1" if raw_value else ""
    if isinstance(raw_value, int):
        return str(raw_value)
    if isinstance(raw_value, float):
        if not np.isfinite(raw_value):
            return ""
        return str(int(raw_value))
    return str(raw_value or "").strip()


def _sequence_range_int(value: str, raw_value: Any) -> int:
    try:
        return int(float(str(value).strip()))
    except ValueError as error:
        raise RuntimeError(f"序列范围只能包含整数，FLOAT 会先转换为整数：{raw_value}") from error


def recover_sequence_range(raw_value: Any = "", extra_pnginfo: Any = None, unique_id: Any = None) -> str:
    text = sequence_range_to_text(raw_value)
    if text:
        return text
    if not isinstance(extra_pnginfo, dict):
        return ""
    workflow = extra_pnginfo.get("workflow")
    if not isinstance(workflow, dict):
        return ""
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return ""

    candidates: list[str] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != NODE_NAME:
            continue
        if unique_id is not None and str(node.get("id")) != str(unique_id):
            continue
        properties = node.get("properties")
        if isinstance(properties, dict):
            value = str(properties.get("sequence_range") or "").strip()
            if value:
                candidates.append(value)
                continue
        widget_values = node.get("widgets_values")
        if isinstance(widget_values, list):
            for value in widget_values:
                text = str(value or "").strip()
                # 兼容旧工作流：序列范围通常是 [1:5] / [1,3,5] 这类短字符串，
                # selected_images 则是 JSON 数组对象，避免误判。
                if text and not text.startswith('[{"filename"') and not text.startswith("[{'"):
                    if ":" in text or "," in text or text.isdigit() or (text.startswith("[") and text.endswith("]")):
                        candidates.append(text)
                        break
    if unique_id is not None and candidates:
        return candidates[0]
    return candidates[0] if len(candidates) == 1 else ""


def selected_images_signature(selected: list[dict[str, str]]) -> list[dict[str, Any]]:
    signature: list[dict[str, Any]] = []
    for entry in selected:
        item: dict[str, Any] = {
            "filename": str(entry.get("filename") or ""),
            "subfolder": str(entry.get("subfolder") or ""),
            "type": str(entry.get("type") or "input"),
        }
        try:
            path = resolve_selected_image_path(entry)
            stat = path.stat()
            item["size"] = int(stat.st_size)
            item["mtime_ns"] = int(stat.st_mtime_ns)
        except Exception:
            item["missing"] = True
        signature.append(item)
    return signature


def resolve_input_image_path(entry: dict[str, str]) -> Path:
    return resolve_selected_image_path({**entry, "type": "input"})


def resolve_selected_image_path(entry: dict[str, str]) -> Path:
    image_type = str(entry.get("type") or "input").strip().lower()
    if image_type == "output":
        root = Path(folder_paths.get_output_directory()).resolve()
    elif image_type == "temp":
        root = Path(folder_paths.get_temp_directory()).resolve()
    else:
        image_type = "input"
        root = Path(folder_paths.get_input_directory()).resolve()
    filename = str(entry.get("filename") or "").strip()
    subfolder = str(entry.get("subfolder") or "").strip().replace("\\", "/")
    candidate = (root / subfolder / filename).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise RuntimeError(f"图片路径越界：{subfolder}/{filename}") from error
    if not candidate.exists():
        label = f"{subfolder}/{filename}".strip("/")
        raise RuntimeError(f"未找到{image_type}图片：{label}")
    return candidate


def _display_image_path(path: Path) -> str:
    try:
        input_dir = Path(folder_paths.get_input_directory()).resolve()
        return str(path.resolve().relative_to(input_dir)).replace("\\", "/")
    except Exception:
        return str(path)


def load_image_tensor(path: Path) -> torch.Tensor:
    try:
        array = _load_image_array(path)
    except Exception as error:
        raise RuntimeError(f"图片文件无法识别或已损坏：{_display_image_path(path)}。请删除、重新导出或换一张图片。原始错误：{error}") from error

    return torch.from_numpy(array)[None, ...]


def _format_from_suffix(suffix: str) -> str:
    ext = str(suffix or "").lower().lstrip(".")
    if ext == "jpg":
        ext = "jpeg"
    return f"image/{ext or 'png'}"


def _image_tensor_to_pil(image: torch.Tensor) -> Image.Image:
    tensor = image.detach().cpu().float()
    if tensor.ndim == 4:
        tensor = tensor[0]
    if tensor.ndim != 3:
        raise RuntimeError(f"无法预览非图片 Tensor：shape={tuple(image.shape)}")
    array = tensor.clamp(0.0, 1.0).numpy()
    if array.shape[2] == 1:
        array = np.repeat(array, 3, axis=2)
    channels = int(array.shape[2])
    if channels >= 4:
        mode = "RGBA"
        array = array[:, :, :4]
    else:
        mode = "RGB"
        array = array[:, :, :3]
    return Image.fromarray((array * 255.0).round().astype(np.uint8), mode=mode)


def _preview_from_tensor(image: torch.Tensor) -> list[dict[str, Any]]:
    pil_image = _image_tensor_to_pil(image)
    return [gjjutils_write_temp_pil_image(pil_image, format="PNG", suffix=".png")]


def _preview_from_input_path(path: Path) -> list[dict[str, Any]]:
    info = gjjutils_write_temp_file(path, suffix=path.suffix or ".png")
    try:
        width, height = _probe_image_size(path)
        info.update({"width": int(width), "height": int(height)})
    except Exception:
        pass
    info.update({"format": _format_from_suffix(path.suffix), "media_type": "image"})
    return [info]


def empty_image_tensor(num_channels: int = 3) -> torch.Tensor:
    """创建空的占位图片 Tensor"""
    return torch.zeros((1, 64, 64, num_channels), dtype=torch.float32)


def build_uniform_batch(images: list[torch.Tensor]) -> torch.Tensor:
    if not images:
        return empty_image_tensor()

    max_height = max(int(image.shape[1]) for image in images)
    max_width = max(int(image.shape[2]) for image in images)
    # 检查是否有任何图像是RGBA（4通道）
    has_rgba = any(int(image.shape[3]) == 4 for image in images)
    # 如果有RGBA图像，则统一使用4通道（RGBA），否则使用3通道（RGB）
    target_channels = 4 if has_rgba else 3

    padded: list[torch.Tensor] = []

    for image in images:
        batch_size = int(image.shape[0])  # 通常是1
        original_height = int(image.shape[1])
        original_width = int(image.shape[2])
        current_channels = int(image.shape[3])

        # 调整图像通道数以匹配目标通道数
        if current_channels != target_channels:
            if current_channels == 3 and target_channels == 4:
                # RGB to RGBA: 添加全不透明alpha通道（值为1.0）
                alpha = torch.ones((batch_size, original_height, original_width, 1), dtype=image.dtype, device=image.device)
                image = torch.cat([image, alpha], dim=3)  # 在通道维度拼接
            elif current_channels == 4 and target_channels == 3:
                # RGBA to RGB: 这种情况不应该发生，因为如果有RGBA我们会统一用RGBA
                # 但为了安全，还是处理一下：丢弃alpha通道
                image = image[:, :, :, :3]
            elif current_channels == 1 and target_channels == 3:
                # Grayscale to RGB: 复制单通道到三个通道
                image = image.repeat(1, 1, 1, 3)
            elif current_channels == 1 and target_channels == 4:
                # Grayscale to RGBA
                image_rgb = image.repeat(1, 1, 1, 3)
                alpha = torch.ones((batch_size, original_height, original_width, 1), dtype=image.dtype, device=image.device)
                image = torch.cat([image_rgb, alpha], dim=3)
            # 更新高度和宽度（虽然通常不变，但为了安全）
            height = int(image.shape[1])
            width = int(image.shape[2])
        else:
            height = original_height
            width = original_width

        # 检查是否已经是目标尺寸
        if height == max_height and width == max_width:
            padded.append(image.contiguous())
            continue

        # 根据目标通道数创建 canvas
        canvas = torch.zeros((batch_size, max_height, max_width, target_channels), dtype=image.dtype, device=image.device)
        top = max(0, (max_height - height) // 2)
        left = max(0, (max_width - width) // 2)
        canvas[:, top:top + height, left:left + width, :] = image
        padded.append(canvas)

    return torch.cat(padded, dim=0)


def build_uniform_batch_by_longest_edge(images: list[torch.Tensor], method: str = "lanczos") -> torch.Tensor:
    """通过长边缩放统一图片尺寸，而不是加黑边"""
    if not images:
        return empty_image_tensor()

    # 找到所有图片中的最大长边
    max_longest_edge = 0
    for image in images:
        height = int(image.shape[1])
        width = int(image.shape[2])
        longest_edge = max(height, width)
        max_longest_edge = max(max_longest_edge, longest_edge)

    if max_longest_edge == 0:
        return empty_image_tensor()

    # 将所有图片按长边缩放到统一尺寸
    scaled: list[torch.Tensor] = []
    for image in images:
        height = int(image.shape[1])
        width = int(image.shape[2])
        longest_edge = max(height, width)

        if longest_edge == max_longest_edge:
            # 已经是最大长边，无需缩放
            scaled.append(image.contiguous())
        else:
            # 计算缩放比例
            scale_factor = max_longest_edge / longest_edge
            new_width = max(16, int(round(width * scale_factor / 8.0) * 8))
            new_height = max(16, int(round(height * scale_factor / 8.0) * 8))

            # 缩放图片（保持原始通道数）
            samples = image.movedim(-1, 1)
            scaled_image = comfy.utils.common_upscale(samples, new_width, new_height, str(method or "lanczos"), "disabled")
            scaled_image = scaled_image.movedim(1, -1).clamp(0.0, 1.0).contiguous()
            scaled.append(scaled_image)

    return torch.cat(scaled, dim=0)


def parse_sequence_range(raw_value: Any, total: int) -> list[int] | None:
    text = sequence_range_to_text(raw_value)
    if not text:
        return None

    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1].strip()
    if not text:
        return []

    def wrap_index(value: int) -> int | None:
        if total <= 0:
            return None
        return (value - 1) % total

    if ":" in text:
        parts = [part.strip() for part in text.split(":")]
        if len(parts) not in (2, 3):
            raise RuntimeError(f"序列范围格式错误：{raw_value}")
        try:
            start = _sequence_range_int(parts[0], raw_value) if parts[0] else 1
            end = _sequence_range_int(parts[1], raw_value) if parts[1] else total
            step = _sequence_range_int(parts[2], raw_value) if len(parts) == 3 and parts[2] else (1 if start <= end else -1)
        except RuntimeError:
            raise
        if step == 0:
            raise RuntimeError("序列范围的步长不能为 0。")
        stop = end + (1 if step > 0 else -1)
        return [index for item in range(start, stop, step) if (index := wrap_index(item)) is not None]

    items = text.replace("，", ",").split(",")
    indices: list[int] = []
    for item in items:
        item = item.strip()
        if not item:
            continue
        index = wrap_index(_sequence_range_int(item, raw_value))
        if index is not None:
            indices.append(index)
    return indices


class GJJ_MultiImageLoader:
    CATEGORY = "GJJ"
    FUNCTION = "load_images"
    OUTPUT_NODE = False
    DESCRIPTION = "一次选择多张 input 目录里的图片，在节点中网格预览并按选择数量同步扩展图片输出接口。可作为主图图片、输入图像、原图来源的默认加载节点。"
    SEARCH_ALIASES = ["multi image loader", "image loader", "多图加载", "图片预览", "批量图片", "主图图片", "输入图像", "原图输入", "主图加载", "多图片加载预览器"]
    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE",) + tuple("IMAGE" for _ in range(MAX_OUTPUT_IMAGES))
    RETURN_NAMES = ("批量图片队列",) + tuple(f"导出图片{index:02d}" for index in range(1, MAX_OUTPUT_IMAGES + 1))
    OUTPUT_TOOLTIPS = ("将所有已选图片按顺序输出为图片列表，原图尺寸和通道不变，可被浏览器直接读取。",) + tuple(
        f"第 {index} 张已选图片的单独输出；未使用的尾部输出会在前端自动收起。"
        for index in range(1, MAX_OUTPUT_IMAGES + 1)
    )
    OUTPUT_IS_LIST = (True,) + tuple(False for _ in range(MAX_OUTPUT_IMAGES))

    GJJ_HELP = {
        "title": "GJJ · 🧡·📂 批量多图片加载浏览器",
        "version": "v3.0",
        "author": "GJJ Custom Nodes Team",
        "description": "强大的批量图片加载节点，支持从 ComfyUI input 目录中选择多张图片，提供网格预览、序列范围筛选、外部图片合并等功能。是 GJJ 批量处理工作流的核心输入节点。",

        "features": [
            {
                "name": "可视化网格预览",
                "description": "在节点面板内以网格形式预览所有已选图片，支持缩略图查看",
            },
            {
                "name": "动态输出口",
                "description": "根据选择的图片数量自动扩展输出接口（最多20个单图输出）",
            },
            {
                "name": "批量图片队列",
                "description": "将所有图片打包为 GJJ 专用批量格式，便于后续批量处理节点使用",
            },
            {
                "name": "序列范围筛选",
                "description": "支持 [1,2] 和 [1:2] 语法，精确控制输出哪些图片",
            },
            {
                "name": "外部图片合并",
                "description": "可接入其他节点的 IMAGE batch，与本地图片合并预览和输出",
            },
            {
                "name": "网络默认图片",
                "description": "更多工具里可输入一条或多条 http/https 图片地址，统一调用 GJJ 公共网络图片下载函数并设为默认已选图片",
            },
            {
                "name": "超大数量支持",
                "description": "超过20张图片时自动切换为纯批量模式，不限制图片数量",
            },
        ],

        "usage": [
            "1. 准备图片：将需要处理的图片放入 ComfyUI 的 input/ 目录",
            "2. 打开节点：点击节点面板中的「选择图片」按钮",
            "3. 多选图片：在文件浏览器中按住 Ctrl/Shift 多选需要的图片",
            "4. 确认选择：点击确定后，图片会以网格形式在节点内预览",
            "5. （可选）设置序列范围：如需只输出部分图片，在「序列范围」中输入如 [1:5]",
            "6. （可选）设置网络默认图：展开更多工具，点击「🌐」并输入一条或多条网络图片地址",
            "7. （可选）合并外部图片：接入其他节点的 IMAGE 输出，会与本地图片合并",
            "8. 连接输出：将「批量图片队列」连接到批量处理节点，或使用单图输出",
        ],

        "tips": [
            "💡 图片命名建议：使用数字前缀（如 001_xxx.jpg）便于排序和序列筛选",
            "💡 支持的格式：PNG、JPG、JPEG、WEBP、BMP 等常见图片格式",
            "💡 网络默认图片会先缓存到 ComfyUI input/GJJ_TemplateParams，再按普通 input 图片读取；可一次粘贴多条地址",
            "💡 序列范围语法：[1,3,5] 选择第1、3、5张；[1:5] 选择第1到5张",
            "💡 超过20张图片时，只会输出批量队列，不会创建单图输出口",
            "💡 外部图片和本地图片会合并预览，但会在 UI 中标记来源",
            "💡 作为批量工作流的起点，推荐配合 GJJ 批量扩图工具、批量抠图等节点使用",
        ],

        "performance": {
            "最大单图输出": "20 张（超过后自动切换为纯批量模式）",
            "批量队列限制": "无限制，可处理数百张图片",
            "内存占用": "取决于图片数量和分辨率，建议单次不超过 50 张高分辨率图片",
            "推荐场景": "批量扩图、批量抠图、批量风格转换等需要多图输入的工作流",
        },

        "dependencies": [],
    }

    @classmethod
    def INPUT_TYPES(cls):
        # selected_images 由前端 properties 维护。sequence_range 保留为隐藏原生
        # 参数，前端在展开序列范围时恢复它并绑定同名外部输入小圆点。
        return {
            "required": {
                "sequence_range": (
                    SEQUENCE_RANGE_INPUT_TYPES,
                    {
                        "default": "",
                        "display_name": "序列范围",
                        "tooltip": "留空输出全部；STRING 支持 [1,3,5] / [1:8]；INT/FLOAT 会转为序号，0 或超出范围时按图片总数取模。",
                        "hidden": True,
                        "display": "hidden",
                    },
                ),
            },
            "optional": {
                "input_images": (
                    INPUT_IMAGE_TYPES,
                    {
                        "display_name": "导入图片",
                        "tooltip": "可接入 GJJ 专用批量图片队列或普通 IMAGE batch；会与当前已选图片合并预览并一起输出。",
                        "forceInput": True,
                    },
                ),
                "slide_start_index": (
                    any_type,
                    {
                        "display_name": "滑动起始序号",
                        "tooltip": "更多工具展开时可连接：按 x mod 图片总数决定滑动输出起始序号，0 会映射到最后一张。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, selected_images="[]", sequence_range="", input_images=None, slide_start_index=None, prompt=None, extra_pnginfo=None, unique_id=None):
        # 这个节点的图片选择主要由前端面板属性维护。始终重新执行可确保上游面板换图后，
        # 下游节点拿到的是当前选择的真实图片张量，而不是上一轮缓存。
        return float("NaN")

    def load_images(self, selected_images="[]", sequence_range="", input_images=None, slide_start_index=None, prompt=None, extra_pnginfo=None, unique_id=None):
        selected = recover_selected_images(selected_images, extra_pnginfo, unique_id)
        sequence_range = recover_sequence_range(sequence_range, extra_pnginfo, unique_id)
        collected: list[dict[str, Any]] = []

        if isinstance(input_images, torch.Tensor):
            batch = input_images
            if batch.ndim == 3:
                batch = batch.unsqueeze(0)
            for index in range(int(batch.shape[0])):
                image_tensor = batch[index:index + 1].contiguous()
                collected.append(
                    {
                        "image": image_tensor,
                        "preview": _preview_from_tensor(image_tensor),
                        "source": "external",
                    }
                )

        skipped_errors: list[str] = []
        for entry in selected:
            try:
                image_path = resolve_selected_image_path(entry)
                image_tensor = load_image_tensor(image_path)
            except Exception as error:
                subfolder_label = str(entry.get("subfolder") or "").strip().replace("\\", "/")
                filename_label = str(entry.get("filename") or "").strip()
                label = f"{subfolder_label}/{filename_label}".strip("/")
                skipped_errors.append(f"{label}: {error}")
                try:
                    print(f"[GJJ_MultiImageLoader] 跳过无法读取的图片：{label} ({error})")
                except Exception:
                    pass
                continue
            collected.append(
                {
                    "image": image_tensor,
                    "preview": _preview_from_input_path(image_path),
                    "source": "selected",
                }
            )

        if skipped_errors and not collected:
            raise RuntimeError("所有已选图片都无法读取：" + "；".join(skipped_errors[:5]))

        if slide_start_index is not None and len(collected) > 0:
            try:
                x = int(slide_start_index)
                r = x % len(collected)
                r = len(collected) if r == 0 else r
                text = str(sequence_range or "").strip()
                output_count = 1
                if text.startswith("[") and text.endswith("]"):
                    output_count = max(1, len([part for part in text[1:-1].replace("，", ",").split(",") if part.strip()]))
                sequence_range = "[" + ",".join(str(((r - 1 + offset) % len(collected)) + 1) for offset in range(output_count)) + "]"
            except Exception:
                pass

        indices = parse_sequence_range(sequence_range, len(collected))
        if indices is not None:
            collected = [collected[index] for index in indices]

        # 直接输出原图列表，不做任何统一处理（尺寸、通道保持原样）
        # OUTPUT_IS_LIST = True 表示批量图片队列输出为图片列表
        batch_outputs = [item["image"] for item in collected]  # 批量队列只包含实际图片
        preview_entries: list[dict[str, Any]] = []
        for item in collected:
            preview_entries.extend(item["preview"])

        # 如果超过20张，只保留批量图片队列输出（不创建单图输出）
        # 如果20张以内，保留原有的批量队列+单图输出
        exceeds_limit = len(collected) > MAX_OUTPUT_IMAGES

        if exceeds_limit:
            # 超过20张：只返回批量图片队列（原图列表）
            return {
                "ui": {
                    "preview_images": preview_entries,
                    "external_image_count": [sum(1 for item in collected if item.get("source") == "external")],
                    "merged_image_count": [len(preview_entries)],
                    "skipped_image_errors": skipped_errors[:10],
                },
                "result": (batch_outputs,),
            }
        else:
            # 20张以内：批量队列（原图列表） + 单图输出（空白填充）
            preview_entries = preview_entries[:MAX_OUTPUT_IMAGES]
            # 单图输出需要填充到20个，但批量队列只包含实际图片
            single_outputs = batch_outputs.copy()
            while len(single_outputs) < MAX_OUTPUT_IMAGES:
                single_outputs.append(empty_image_tensor())
            return {
                "ui": {
                    "preview_images": preview_entries,
                    "external_image_count": [sum(1 for item in collected if item.get("source") == "external")],
                    "merged_image_count": [len(preview_entries)],
                    "skipped_image_errors": skipped_errors[:10],
                },
                "result": (batch_outputs, *tuple(single_outputs[:MAX_OUTPUT_IMAGES])),
            }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MultiImageLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🧡·📂 批量多图加载浏览,队列执行"}
