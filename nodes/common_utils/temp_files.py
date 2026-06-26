from __future__ import annotations

import hashlib
import os
import shutil
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

import folder_paths


GJJ_TEMP_SUBFOLDER = "GJJ"


def gjjutils_temp_root() -> Path:
    root = Path(folder_paths.get_temp_directory()) / GJJ_TEMP_SUBFOLDER
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


def gjjutils_temp_path(filename: str) -> Path:
    name = Path(str(filename or "")).name
    if not name:
        raise ValueError("临时文件名不能为空。")
    root = gjjutils_temp_root().resolve()
    path = (root / name).resolve()
    if path.parent != root:
        raise ValueError("临时文件路径必须位于 temp/GJJ。")
    return path


def gjjutils_write_temp_bytes(content: bytes, suffix: str = ".bin") -> dict[str, Any]:
    data = bytes(content or b"")
    clean_suffix = str(suffix or ".bin").strip()
    if not clean_suffix.startswith("."):
        clean_suffix = f".{clean_suffix}"
    digest = gjjutils_hash_bytes(data)
    filename = f"{digest}{clean_suffix.lower()}"
    path = gjjutils_temp_path(filename)
    if not path.exists():
        tmp_path = path.with_name(f".{filename}.{os.getpid()}.tmp")
        tmp_path.write_bytes(data)
        os.replace(tmp_path, path)
    return {
        "filename": filename,
        "subfolder": GJJ_TEMP_SUBFOLDER,
        "type": "temp",
        "hash": digest,
    }


def gjjutils_write_temp_file(path: str | os.PathLike[str], suffix: str | None = None) -> dict[str, Any]:
    source = Path(path)
    clean_suffix = str(suffix or source.suffix or ".bin").strip()
    if not clean_suffix.startswith("."):
        clean_suffix = f".{clean_suffix}"
    digest = gjjutils_hash_file(source)
    filename = f"{digest}{clean_suffix.lower()}"
    target = gjjutils_temp_path(filename)
    if not target.exists():
        tmp_path = target.with_name(f".{filename}.{os.getpid()}.tmp")
        with source.open("rb") as src, tmp_path.open("wb") as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)
        os.replace(tmp_path, target)
    return {
        "filename": filename,
        "subfolder": GJJ_TEMP_SUBFOLDER,
        "type": "temp",
        "hash": digest,
        "source": "file",
    }


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
    if not path.exists():
        buffer = BytesIO()
        normalized.save(buffer, format=normalized_format)
        tmp_path = path.with_name(f".{filename}.{os.getpid()}.tmp")
        tmp_path.write_bytes(buffer.getvalue())
        os.replace(tmp_path, path)
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


def gjjutils_read_temp_pil_image(info_or_filename: dict[str, Any] | str) -> Image.Image:
    data = gjjutils_read_temp_bytes(info_or_filename)
    with Image.open(BytesIO(data)) as image:
        return ImageOps.exif_transpose(image).copy()
