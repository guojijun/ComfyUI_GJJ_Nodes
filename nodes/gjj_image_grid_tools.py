from __future__ import annotations

import torch
import torch.nn.functional as F


def _resize_image(image: torch.Tensor, height: int, width: int) -> torch.Tensor:
    samples = image.movedim(-1, 1)
    resized = F.interpolate(samples, size=(int(height), int(width)), mode="bilinear", align_corners=False)
    return resized.movedim(1, -1)


def _match_frames(tensor: torch.Tensor, target: int) -> torch.Tensor:
    if int(tensor.shape[0]) == int(target):
        return tensor
    indices = torch.linspace(0, int(tensor.shape[0]) - 1, steps=int(target), device=tensor.device).round().long()
    return tensor[indices.clamp(0, int(tensor.shape[0]) - 1)]


def _optional_parts(kwargs: dict) -> list[torch.Tensor | None]:
    return [kwargs.get(f"part_{index}") for index in range(1, 10)]


class GJJ_ImageGridSplitter:
    CATEGORY = "GJJ/图像"
    FUNCTION = "split"
    DESCRIPTION = "把图片按网格切成最多 9 块，可带少量重叠，适合局部处理后重组。"
    SEARCH_ALIASES = ["split image", "grid", "切图", "九宫格", "切片"]
    RETURN_TYPES = ("IMAGE",) * 9 + ("INT", "INT", "IMAGE", "INT")
    RETURN_NAMES = tuple([f"图片块{i}" for i in range(1, 10)] + ["行数", "列数", "选中图片块", "选中序号"])
    OUTPUT_TOOLTIPS = tuple(["网格切分得到的图片块；超出实际网格的输出为空白图。"] * 9 + ["行数。", "列数。", "选中序号对应的图片块。", "选中序号，1 基。"])

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "图像", "tooltip": "需要切分的图片或帧序列。"}),
                "rows": ("INT", {"default": 1, "min": 1, "max": 3, "display_name": "行数", "tooltip": "切分网格的行数，最多 3。"}),
                "columns": ("INT", {"default": 1, "min": 1, "max": 3, "display_name": "列数", "tooltip": "切分网格的列数，最多 3。"}),
                "selected_index": ("INT", {"default": 1, "min": 1, "max": 9, "display_name": "选中序号", "tooltip": "额外输出哪一块图片，使用 1 基序号。"}),
                "overlap": ("INT", {"default": 2, "min": 0, "max": 128, "display_name": "重叠像素", "tooltip": "每块向相邻区域额外扩展的像素数，便于局部重绘衔接。"}),
            }
        }

    def split(self, image: torch.Tensor, rows: int, columns: int, selected_index: int, overlap: int):
        batch, height, width, channels = image.shape
        rows = max(1, min(3, int(rows)))
        columns = max(1, min(3, int(columns)))
        overlap = max(0, int(overlap))
        part_h = int(height) // rows
        part_w = int(width) // columns
        parts: list[torch.Tensor] = []
        for row in range(rows):
            for col in range(columns):
                y0 = max(0, row * part_h - overlap)
                y1 = min(int(height), (row + 1) * part_h + overlap if row < rows - 1 else int(height))
                x0 = max(0, col * part_w - overlap)
                x1 = min(int(width), (col + 1) * part_w + overlap if col < columns - 1 else int(width))
                parts.append(image[:, y0:y1, x0:x1, :])
        empty = torch.zeros((batch, max(1, part_h), max(1, part_w), channels), dtype=image.dtype, device=image.device)
        while len(parts) < 9:
            parts.append(empty)
        selected = max(1, min(rows * columns, int(selected_index)))
        return tuple(parts[:9] + [rows, columns, parts[selected - 1], selected])


class GJJ_ImageGridReassembler:
    CATEGORY = "GJJ/图像"
    FUNCTION = "reassemble"
    DESCRIPTION = "把网格图片块贴回原图尺寸，支持指定替换块与自动缩放。"
    SEARCH_ALIASES = ["reassemble image", "grid", "重组", "切片还原"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("重组图像",)
    OUTPUT_TOOLTIPS = ("按原图尺寸重组后的图像。",)

    @classmethod
    def INPUT_TYPES(cls):
        optional = {f"part_{index}": ("IMAGE", {"display_name": f"图片块{index}", "tooltip": "来自网格切分器的图片块，可只连接需要替换的块。"}) for index in range(1, 10)}
        optional.update({
            "replacement": ("IMAGE", {"display_name": "替换图片块", "tooltip": "可选。连接后按替换序号覆盖对应图片块。"}),
        })
        return {
            "required": {
                "original": ("IMAGE", {"display_name": "原图", "tooltip": "提供目标尺寸与默认内容。"}),
                "rows": ("INT", {"default": 1, "min": 1, "max": 3, "display_name": "行数", "tooltip": "原切分网格的行数。"}),
                "columns": ("INT", {"default": 1, "min": 1, "max": 3, "display_name": "列数", "tooltip": "原切分网格的列数。"}),
                "replacement_index": ("INT", {"default": 0, "min": 0, "max": 9, "display_name": "替换序号", "tooltip": "替换图片块要放回的位置；0 表示不使用替换图片块。"}),
                "overlap": ("INT", {"default": 2, "min": 0, "max": 128, "display_name": "重叠像素", "tooltip": "应与切分时的重叠像素一致。"}),
                "auto_resize": ("BOOLEAN", {"default": True, "display_name": "自动缩放", "tooltip": "图片块尺寸不匹配时自动缩放到格子尺寸。"}),
            },
            "optional": optional,
        }

    def reassemble(self, original: torch.Tensor, rows: int, columns: int, replacement_index: int, overlap: int, auto_resize: bool, **kwargs):
        rows = max(1, min(3, int(rows)))
        columns = max(1, min(3, int(columns)))
        overlap = max(0, int(overlap))
        batch, height, width, _ = original.shape
        part_h = int(height) // rows
        part_w = int(width) // columns
        parts = _optional_parts(kwargs)
        replacement = kwargs.get("replacement")
        if replacement is not None and int(replacement_index) > 0:
            idx = max(1, min(9, int(replacement_index))) - 1
            parts[idx] = replacement
        result = original.clone()
        for index, part in enumerate(parts, start=1):
            if part is None or index > rows * columns:
                continue
            row = (index - 1) // columns
            col = (index - 1) % columns
            crop_top = overlap if row > 0 else 0
            crop_left = overlap if col > 0 else 0
            cropped = part[:, crop_top:, crop_left:, :]
            target_h = part_h if row < rows - 1 else int(height) - row * part_h
            target_w = part_w if col < columns - 1 else int(width) - col * part_w
            if cropped.shape[0] != batch:
                cropped = _match_frames(cropped, batch)
            if int(cropped.shape[1]) != target_h or int(cropped.shape[2]) != target_w:
                if not auto_resize:
                    raise RuntimeError(f"图片块 {index} 尺寸不匹配：需要 {target_w}x{target_h}。")
                cropped = _resize_image(cropped, target_h, target_w)
            y0 = row * part_h
            x0 = col * part_w
            result[:, y0:y0 + target_h, x0:x0 + target_w, :] = cropped
        return (result,)


class GJJ_ImageStacker:
    CATEGORY = "GJJ/图像"
    FUNCTION = "stack"
    DESCRIPTION = "把 2-4 张图片横向或纵向拼接。"
    SEARCH_ALIASES = ["merge image", "stack image", "横向合图", "纵向合图"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("拼接图像",)
    OUTPUT_TOOLTIPS = ("拼接后的图像。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image1": ("IMAGE", {"display_name": "图像1", "tooltip": "第一张图。"}),
                "image2": ("IMAGE", {"display_name": "图像2", "tooltip": "第二张图。"}),
                "direction": (["横向", "纵向"], {"default": "横向", "display_name": "拼接方向", "tooltip": "选择横向或纵向拼接。"}),
            },
            "optional": {
                "image3": ("IMAGE", {"display_name": "图像3", "tooltip": "可选第三张图。"}),
                "image4": ("IMAGE", {"display_name": "图像4", "tooltip": "可选第四张图。"}),
            },
        }

    def stack(self, image1: torch.Tensor, image2: torch.Tensor, direction: str, image3=None, image4=None):
        images = [img for img in (image1, image2, image3, image4) if img is not None]
        batch = max(int(img.shape[0]) for img in images)
        images = [_match_frames(img, batch) if int(img.shape[0]) != batch else img for img in images]
        channels = max(int(img.shape[-1]) for img in images)
        normalized = []
        for img in images:
            if int(img.shape[-1]) < channels:
                pad = torch.ones((*img.shape[:-1], channels - int(img.shape[-1])), dtype=img.dtype, device=img.device)
                img = torch.cat([img, pad], dim=-1)
            normalized.append(img)
        if direction == "横向":
            height = max(int(img.shape[1]) for img in normalized)
            padded = [F.pad(img, (0, 0, 0, 0, 0, height - int(img.shape[1])), value=0.0) for img in normalized]
            return (torch.cat(padded, dim=2),)
        width = max(int(img.shape[2]) for img in normalized)
        padded = [F.pad(img, (0, 0, 0, width - int(img.shape[2]), 0, 0), value=0.0) for img in normalized]
        return (torch.cat(padded, dim=1),)


NODE_CLASS_MAPPINGS = {
    "GJJ_ImageGridSplitter": GJJ_ImageGridSplitter,
    "GJJ_ImageGridReassembler": GJJ_ImageGridReassembler,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_ImageGridSplitter": "GJJ · 🔲 图像网格切分",
    "GJJ_ImageGridReassembler": "GJJ · 🧩 图像网格重组",
}
