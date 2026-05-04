from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

try:
    import folder_paths
except Exception:
    folder_paths = None


def _output_dir() -> Path:
    root = Path(folder_paths.get_output_directory()) if folder_paths is not None else Path.cwd() / "output"
    path = root / "GJJ" / "pdf"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _tensor_to_pil_images(images: torch.Tensor) -> list[Image.Image]:
    value = images.detach().float().cpu().clamp(0, 1)
    result = []
    for frame in value:
        array = (frame[..., :3].numpy() * 255.0).astype(np.uint8)
        result.append(Image.fromarray(array).convert("RGB"))
    return result


class GJJ_ImagesToPDF:
    CATEGORY = "GJJ/PDF"
    FUNCTION = "save"
    DESCRIPTION = "把 IMAGE 批次保存为多页 PDF。"
    SEARCH_ALIASES = ["pdf", "images to pdf", "图片转PDF"]
    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("PDF路径", "页数")
    OUTPUT_TOOLTIPS = ("保存后的 PDF 文件路径。", "PDF 页数。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"display_name": "图片", "tooltip": "要写入 PDF 的 IMAGE 批次。"}),
                "filename_prefix": ("STRING", {"default": "GJJ/pdf/images", "display_name": "文件名前缀", "tooltip": "输出 PDF 文件名前缀。"}),
            }
        }

    def save(self, images: torch.Tensor, filename_prefix: str):
        pages = _tensor_to_pil_images(images)
        if not pages:
            raise RuntimeError("没有可写入 PDF 的图片。")
        stem = Path(str(filename_prefix or "images").replace("\\", "/")).name or "images"
        path = _output_dir() / f"{stem}_{int(time.time())}.pdf"
        pages[0].save(path, save_all=True, append_images=pages[1:])
        return (str(path), len(pages))


class GJJ_PDFToImages:
    CATEGORY = "GJJ/PDF"
    FUNCTION = "load"
    DESCRIPTION = "把 PDF 页面渲染为 IMAGE 批次，需要当前环境安装 PyMuPDF。"
    SEARCH_ALIASES = ["pdf", "pdf to images", "PDF转图片"]
    RETURN_TYPES = ("IMAGE", "INT")
    RETURN_NAMES = ("页面图片", "页数")
    OUTPUT_TOOLTIPS = ("PDF 页面渲染结果。", "实际渲染页数。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pdf_path": ("STRING", {"default": "", "display_name": "PDF路径", "tooltip": "本地 PDF 文件路径。"}),
                "start_page": ("INT", {"default": 1, "min": 1, "max": 100000, "display_name": "起始页", "tooltip": "1 基页码。"}),
                "page_count": ("INT", {"default": 1, "min": 1, "max": 1000, "display_name": "页数", "tooltip": "要渲染多少页。"}),
                "dpi": ("INT", {"default": 144, "min": 36, "max": 600, "display_name": "DPI", "tooltip": "渲染分辨率。"}),
            }
        }

    def load(self, pdf_path: str, start_page: int, page_count: int, dpi: int):
        path = Path(pdf_path)
        if not path.exists():
            raise RuntimeError(f"未找到 PDF 文件：{pdf_path}")
        try:
            import fitz  # PyMuPDF
        except Exception as exc:
            raise RuntimeError("PDF 转图片需要 PyMuPDF（fitz）。当前环境未安装，图片转 PDF 仍可使用。") from exc
        frames = []
        doc = fitz.open(str(path))
        try:
            start = max(0, int(start_page) - 1)
            end = min(len(doc), start + int(page_count))
            scale = float(dpi) / 72.0
            matrix = fitz.Matrix(scale, scale)
            for page_index in range(start, end):
                pix = doc[page_index].get_pixmap(matrix=matrix, alpha=False)
                array = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
                if pix.n > 3:
                    array = array[..., :3]
                frames.append(torch.from_numpy(array.astype(np.float32) / 255.0).unsqueeze(0))
        finally:
            doc.close()
        if not frames:
            raise RuntimeError("没有渲染到 PDF 页面。")
        return (torch.cat(frames, dim=0), len(frames))


NODE_CLASS_MAPPINGS = {
    "GJJ_ImagesToPDF": GJJ_ImagesToPDF,
    "GJJ_PDFToImages": GJJ_PDFToImages,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_ImagesToPDF": "GJJ · 📄 图片转PDF",
    "GJJ_PDFToImages": "GJJ · 📄 PDF转图片",
}
