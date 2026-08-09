from __future__ import annotations

import hashlib
import os
import shutil
import uuid
from io import BytesIO
from pathlib import Path
from typing import Any, Callable

import numpy as np
from PIL import Image, ImageOps

import folder_paths


GJJ_TEMP_SUBFOLDER = "GJJ"
GJJ_PREVIEW_CACHE_SUBFOLDER = "GJJ/PreviewCache"
GJJ_PREVIEW_MAX_EDGE = 512
GJJ_PREVIEW_JPEG_QUALITY = 82
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif"}


def gjjutils_temp_root() -> Path:
    root = Path(folder_paths.get_temp_directory()) / GJJ_TEMP_SUBFOLDER
    root.mkdir(parents=True, exist_ok=True)
    return root


def gjjutils_preview_cache_root() -> Path:
    root = Path(folder_paths.get_output_directory()) / Path(GJJ_PREVIEW_CACHE_SUBFOLDER)
    root.mkdir(parents=True, exist_ok=True)
    return root


def gjjutils_hash_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def gjjutils_hash_file(path: str | os.PathLike[str], chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while True:
            chunk = handle.read(max(1, int(chunk_size or 1)))
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def gjjutils_hash_pil_image(image: Image.Image, mode: str = "RGBA") -> tuple[str, Image.Image]:
    normalized_mode = str(mode or "RGBA").upper()
    normalized = ImageOps.exif_transpose(image).convert(normalized_mode)
    digest = hashlib.sha256()
    digest.update(f"{normalized_mode}:{normalized.width}x{normalized.height}:".encode("ascii"))
    digest.update(normalized.tobytes())
    return digest.hexdigest(), normalized


def _prepare_pil_image_for_format(image: Image.Image, format: str) -> Image.Image:
    """Return an image mode supported by the requested Pillow encoder."""
    normalized_format = str(format or "PNG").upper()
    if normalized_format in {"JPEG", "JPG"} and image.mode not in {"RGB", "L"}:
        if "A" in image.getbands():
            rgba = image.convert("RGBA")
            background = Image.new("RGB", rgba.size, (255, 255, 255))
            background.paste(rgba, mask=rgba.getchannel("A"))
            return background
        return image.convert("RGB")
    return image


def gjjutils_temp_path(filename: str) -> Path:
    name = Path(str(filename or "")).name
    if not name:
        raise ValueError("临时文件名不能为空。")
    root = gjjutils_temp_root().resolve()
    path = (root / name).resolve()
    if path.parent != root:
        raise ValueError("临时文件路径必须位于 temp/GJJ。")
    return path


def gjjutils_unique_temp_path(prefix: str = "gjj_", suffix: str = ".bin") -> Path:
    clean_prefix = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(prefix or "gjj_"))
    clean_suffix = str(suffix or ".bin").strip()
    if not clean_suffix.startswith("."):
        clean_suffix = f".{clean_suffix}"
    filename = f"{clean_prefix}{uuid.uuid4().hex}{clean_suffix.lower()}"
    return gjjutils_temp_path(filename)


def _atomic_write_bytes(path: Path, content: bytes) -> None:
    if path.exists():
        return
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(content)
        try:
            os.replace(temporary, path)
        except FileExistsError:
            pass
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except Exception:
            pass


def gjjutils_temp_image_preview_filename(filename: str) -> str:
    """返回原图对应的稳定 JPG 预览名，并与所有原图扩展名隔离。"""
    name = Path(str(filename or "")).name
    if not name:
        raise ValueError("原图文件名不能为空。")
    return f"{Path(name).stem}_preview.jpg"


def _attach_jpeg_preview_metadata(
    info: dict[str, Any],
    preview_name: str,
    preview_size: tuple[int, int] | None = None,
) -> dict[str, Any]:
    original_filename = str(info.get("original_filename") or info.get("filename") or "")
    original_subfolder = str(info.get("original_subfolder") or info.get("subfolder") or GJJ_TEMP_SUBFOLDER)
    original_type = str(info.get("original_type") or info.get("type") or "temp")
    info.update(
        {
            "preview_filename": str(preview_name),
            "preview_subfolder": str(info.get("subfolder") or GJJ_TEMP_SUBFOLDER),
            "preview_type": str(info.get("type") or "temp"),
            "preview_format": "image/jpeg",
            "original_filename": original_filename,
            "original_subfolder": original_subfolder,
            "original_type": original_type,
        }
    )
    if preview_size:
        info["preview_width"] = int(preview_size[0])
        info["preview_height"] = int(preview_size[1])
    return info


def _attach_jpeg_preview(info: dict[str, Any], image: Image.Image) -> dict[str, Any]:
    filename = str(info.get("filename") or "").strip()
    if not filename:
        return info
    preview = ImageOps.exif_transpose(image).convert("RGB")
    preview.thumbnail(
        (GJJ_PREVIEW_MAX_EDGE, GJJ_PREVIEW_MAX_EDGE),
        Image.Resampling.LANCZOS,
    )
    preview_name = gjjutils_temp_image_preview_filename(filename)
    preview_path = gjjutils_temp_path(preview_name)
    if not preview_path.exists():
        buffer = BytesIO()
        preview.save(
            buffer,
            format="JPEG",
            quality=GJJ_PREVIEW_JPEG_QUALITY,
            optimize=True,
        )
        _atomic_write_bytes(preview_path, buffer.getvalue())
    return _attach_jpeg_preview_metadata(info, preview_name, preview.size)


def gjjutils_ensure_temp_image_preview(
    info_or_filename: dict[str, Any] | str,
    *,
    verify_existing: bool = False,
) -> dict[str, Any]:
    info = dict(info_or_filename) if isinstance(info_or_filename, dict) else {"filename": str(info_or_filename or "")}
    filename = str(info.get("filename") or "").strip()
    if not filename:
        raise ValueError("原图文件名不能为空。")
    source_path = gjjutils_temp_path(filename)
    if not source_path.is_file():
        raise FileNotFoundError(f"临时原图不存在：{filename}")
    info.setdefault("subfolder", GJJ_TEMP_SUBFOLDER)
    info.setdefault("type", "temp")
    preview_name = gjjutils_temp_image_preview_filename(filename)
    preview_path = gjjutils_temp_path(preview_name)
    if preview_path.exists():
        if not verify_existing:
            # 内容寻址文件名不可变：JPG 已存在时直接返回路径，绝不再打开大图。
            return _attach_jpeg_preview_metadata(info, preview_name)
        try:
            with Image.open(preview_path) as preview:
                preview.load()
                preview_size = preview.size
            return _attach_jpeg_preview_metadata(info, preview_name, preview_size)
        except Exception:
            preview_path.unlink(missing_ok=True)
    with Image.open(source_path) as source:
        normalized = ImageOps.exif_transpose(source).copy()
    return _attach_jpeg_preview(info, normalized)


def gjjutils_write_temp_bytes(
    content: bytes,
    suffix: str = ".bin",
    *,
    create_preview: bool = True,
) -> dict[str, Any]:
    data = bytes(content or b"")
    clean_suffix = str(suffix or ".bin").strip()
    if not clean_suffix.startswith("."):
        clean_suffix = f".{clean_suffix}"
    digest = gjjutils_hash_bytes(data)
    filename = f"{digest}{clean_suffix.lower()}"
    path = gjjutils_temp_path(filename)
    _atomic_write_bytes(path, data)
    info = {
        "filename": filename,
        "subfolder": GJJ_TEMP_SUBFOLDER,
        "type": "temp",
        "hash": digest,
    }
    if create_preview and clean_suffix.lower() in _IMAGE_SUFFIXES:
        try:
            with Image.open(BytesIO(data)) as image:
                _attach_jpeg_preview(info, image.copy())
        except Exception:
            pass
    return info


def gjjutils_write_temp_file(path: str | os.PathLike[str], suffix: str | None = None) -> dict[str, Any]:
    source = Path(path)
    clean_suffix = str(suffix or source.suffix or ".bin").strip()
    if not clean_suffix.startswith("."):
        clean_suffix = f".{clean_suffix}"
    digest = gjjutils_hash_file(source)
    filename = f"{digest}{clean_suffix.lower()}"
    target = gjjutils_temp_path(filename)
    if not target.exists():
        tmp_path = target.with_name(f".{filename}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        with source.open("rb") as src, tmp_path.open("wb") as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)
        try:
            os.replace(tmp_path, target)
        finally:
            tmp_path.unlink(missing_ok=True)
    info = {
        "filename": filename,
        "subfolder": GJJ_TEMP_SUBFOLDER,
        "type": "temp",
        "hash": digest,
        "source": "file",
    }
    if clean_suffix.lower() in _IMAGE_SUFFIXES:
        try:
            with Image.open(source) as image:
                _attach_jpeg_preview(info, image.copy())
        except Exception:
            pass
    return info


def gjjutils_write_temp_with_writer(
    writer: Callable[[Path], Any],
    *,
    suffix: str = ".bin",
) -> dict[str, Any]:
    """让只能写文件路径的第三方对象也统一进入内容寻址临时缓存。"""
    if not callable(writer):
        raise TypeError("临时文件写入器必须可调用。")
    clean_suffix = str(suffix or ".bin").strip()
    if not clean_suffix.startswith("."):
        clean_suffix = f".{clean_suffix}"
    root = gjjutils_temp_root().resolve()
    staging_dir = (root / f".gjj_stage_{os.getpid()}_{uuid.uuid4().hex}").resolve()
    if staging_dir.parent != root:
        raise ValueError("临时中转目录必须位于 temp/GJJ。")
    staging_dir.mkdir(parents=False, exist_ok=False)
    staging_path = staging_dir / f"payload{clean_suffix.lower()}"
    try:
        writer(staging_path)
        if not staging_path.is_file():
            raise FileNotFoundError("临时文件写入器没有生成文件。")
        return gjjutils_write_temp_file(staging_path, suffix=clean_suffix)
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)


def gjjutils_read_temp_bytes(info_or_filename: dict[str, Any] | str) -> bytes:
    filename = (
        str(info_or_filename.get("filename") or "")
        if isinstance(info_or_filename, dict)
        else str(info_or_filename or "")
    )
    return gjjutils_temp_path(filename).read_bytes()


def gjjutils_write_temp_pil_image(
    image: Image.Image,
    *,
    format: str = "PNG",
    suffix: str = ".png",
    media_type: str = "image",
) -> dict[str, Any]:
    normalized_format = str(format or "PNG").upper()
    digest, normalized = gjjutils_hash_pil_image(image)
    clean_suffix = str(suffix or ".png").strip()
    if not clean_suffix.startswith("."):
        clean_suffix = f".{clean_suffix}"
    filename = f"{digest}{clean_suffix.lower()}"
    path = gjjutils_temp_path(filename)
    needs_write = not path.exists()
    if not needs_write and clean_suffix.lower() in {".jpg", ".jpeg"}:
        # Older PNG previews used <hash>.jpg, which collides with a later JPG
        # original containing the same pixels. Repair that stale 512px preview
        # instead of treating it as the immutable full-resolution JPG.
        try:
            with Image.open(path) as existing:
                needs_write = tuple(existing.size) != tuple(normalized.size)
        except Exception:
            needs_write = True
    if needs_write:
        buffer = BytesIO()
        encoded = _prepare_pil_image_for_format(normalized, normalized_format)
        encoded.save(buffer, format=normalized_format)
        if path.exists():
            path.unlink(missing_ok=True)
        _atomic_write_bytes(path, buffer.getvalue())
    info = {
        "filename": filename,
        "subfolder": GJJ_TEMP_SUBFOLDER,
        "type": "temp",
        "hash": digest,
        "source": "pixels",
    }
    info.update(
        {
            "format": f"image/{normalized_format.lower()}",
            "media_type": media_type,
            "width": int(normalized.width),
            "height": int(normalized.height),
        }
    )
    _attach_jpeg_preview(info, normalized)
    return info


def gjjutils_write_persistent_pil_image(
    image: Image.Image,
    *,
    format: str = "PNG",
    suffix: str = ".png",
    media_type: str = "image",
) -> dict[str, Any]:
    normalized_format = str(format or "PNG").upper()
    digest, normalized = gjjutils_hash_pil_image(image)
    clean_suffix = str(suffix or ".png").strip()
    if not clean_suffix.startswith("."):
        clean_suffix = f".{clean_suffix}"
    filename = f"{digest}{clean_suffix.lower()}"
    root = gjjutils_preview_cache_root()
    path = root / filename
    if not path.exists():
        buffer = BytesIO()
        encoded = _prepare_pil_image_for_format(normalized, normalized_format)
        encoded.save(buffer, format=normalized_format)
        _atomic_write_bytes(path, buffer.getvalue())
    preview = ImageOps.exif_transpose(normalized).convert("RGB")
    preview.thumbnail((GJJ_PREVIEW_MAX_EDGE, GJJ_PREVIEW_MAX_EDGE), Image.Resampling.LANCZOS)
    preview_name = gjjutils_temp_image_preview_filename(filename)
    preview_path = root / preview_name
    if not preview_path.exists():
        buffer = BytesIO()
        preview.save(buffer, format="JPEG", quality=GJJ_PREVIEW_JPEG_QUALITY, optimize=True)
        _atomic_write_bytes(preview_path, buffer.getvalue())
    return {
        "filename": filename,
        "subfolder": GJJ_PREVIEW_CACHE_SUBFOLDER,
        "type": "output",
        "hash": digest,
        "source": "pixels",
        "format": f"image/{normalized_format.lower()}",
        "media_type": media_type,
        "width": int(normalized.width),
        "height": int(normalized.height),
        "preview_filename": preview_name,
        "preview_subfolder": GJJ_PREVIEW_CACHE_SUBFOLDER,
        "preview_type": "output",
        "preview_format": "image/jpeg",
        "preview_width": int(preview.width),
        "preview_height": int(preview.height),
        "original_filename": filename,
        "original_subfolder": GJJ_PREVIEW_CACHE_SUBFOLDER,
        "original_type": "output",
    }


def gjjutils_write_temp_pil_sequence(
    images: list[Image.Image],
    *,
    format: str = "WEBP",
    suffix: str = ".webp",
    duration: int = 125,
    loop: int = 0,
    media_type: str = "image",
    save_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    frames = [ImageOps.exif_transpose(image).convert("RGB") for image in images or []]
    if not frames:
        raise ValueError("临时图片序列不能为空。")
    buffer = BytesIO()
    options = dict(save_options or {})
    frames[0].save(
        buffer,
        format=str(format or "WEBP").upper(),
        save_all=len(frames) > 1,
        append_images=frames[1:],
        duration=max(1, int(duration or 1)),
        loop=max(0, int(loop or 0)),
        **options,
    )
    info = gjjutils_write_temp_bytes(
        buffer.getvalue(),
        suffix=suffix,
        create_preview=False,
    )
    info.update({
        "source": "pixels",
        "format": f"image/{str(format or 'WEBP').lower()}",
        "media_type": media_type,
        "width": int(frames[0].width),
        "height": int(frames[0].height),
        "frame_count": len(frames),
    })
    _attach_jpeg_preview(info, frames[0])
    return info


def gjjutils_tensor_to_pil_images(images: Any) -> list[Image.Image]:
    tensor = images
    if hasattr(tensor, "detach"):
        tensor = tensor.detach().cpu().float().clamp(0.0, 1.0)
    if hasattr(tensor, "ndim") and int(tensor.ndim) == 3:
        tensor = tensor.unsqueeze(0)
    if not hasattr(tensor, "ndim") or int(tensor.ndim) != 4:
        raise ValueError("图片 Tensor 必须是 BHWC 或 HWC 格式。")

    result: list[Image.Image] = []
    count = int(tensor.shape[0])
    for index in range(count):
        frame = tensor[index]
        array = frame.numpy() if hasattr(frame, "numpy") else np.asarray(frame)
        if array.ndim != 3:
            raise ValueError(f"图片 Tensor 第 {index + 1} 张不是 HWC 格式。")
        if array.shape[2] == 1:
            array = np.repeat(array, 3, axis=2)
        if array.shape[2] >= 4:
            mode = "RGBA"
            array = array[:, :, :4]
        else:
            mode = "RGB"
            array = array[:, :, :3]
        result.append(Image.fromarray((np.clip(array, 0.0, 1.0) * 255.0).round().astype(np.uint8), mode=mode))
    return result


def gjjutils_write_temp_tensor_images(
    images: Any,
    *,
    format: str = "PNG",
    suffix: str = ".png",
    media_type: str = "image",
) -> list[dict[str, Any]]:
    return [
        gjjutils_write_temp_pil_image(image, format=format, suffix=suffix, media_type=media_type)
        for image in gjjutils_tensor_to_pil_images(images)
    ]


def gjjutils_write_persistent_tensor_images(
    images: Any,
    *,
    format: str = "PNG",
    suffix: str = ".png",
    media_type: str = "image",
) -> list[dict[str, Any]]:
    return [
        gjjutils_write_persistent_pil_image(image, format=format, suffix=suffix, media_type=media_type)
        for image in gjjutils_tensor_to_pil_images(images)
    ]


def gjjutils_read_temp_pil_image(info_or_filename: dict[str, Any] | str) -> Image.Image:
    filename = (
        str(info_or_filename.get("filename") or "")
        if isinstance(info_or_filename, dict)
        else str(info_or_filename or "")
    )
    with Image.open(gjjutils_temp_path(filename)) as image:
        return ImageOps.exif_transpose(image).copy()
