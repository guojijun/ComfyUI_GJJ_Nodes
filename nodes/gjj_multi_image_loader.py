from __future__ import annotations

import comfy.utils
import json
import os
from pathlib import Path
from typing import Any

import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageOps
try:
    from server import PromptServer
except Exception:
    PromptServer = None

import folder_paths
from nodes import PreviewImage

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_MultiImageLoader"
IMAGE_API_PATH = "/gjj/input_images"
MAX_OUTPUT_IMAGES = 20
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".avif"}
INPUT_IMAGE_TYPES = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"


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
        relative = file_path.relative_to(input_dir)
        filename = file_path.name
        subfolder = str(relative.parent).replace("\\", "/")
        if subfolder == ".":
            subfolder = ""
        width = 0
        height = 0
        try:
            # 仅获取图像尺寸而不完全加载图像数据以提高性能
            with Image.open(file_path) as image:
                # 获取图像尺寸，这是预览需要的关键信息
                width, height = image.size
        except (OSError, IOError):  # 更具体的异常类型
            # 记录错误但不中断处理其他文件
            width = 0
            height = 0

        items.append(
            {
                "filename": filename,
                "subfolder": subfolder,
                "label": f"{subfolder}/{filename}" if subfolder else filename,
                "width": width,
                "height": height,
            }
        )
    return items


async def get_gjj_input_images(request):
    return web.json_response({"images": list_input_images()})


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.get(IMAGE_API_PATH)(get_gjj_input_images)


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
    seen: set[tuple[str, str]] = set()
    for item in parsed:
        if not isinstance(item, dict):
            continue
        filename = str(item.get("filename") or "").strip()
        subfolder = str(item.get("subfolder") or "").strip().replace("\\", "/")
        if not filename:
            continue
        key = (subfolder, filename)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append({"filename": filename, "subfolder": subfolder})
    return cleaned[:MAX_OUTPUT_IMAGES]


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


def selected_images_signature(selected: list[dict[str, str]]) -> list[dict[str, Any]]:
    signature: list[dict[str, Any]] = []
    for entry in selected:
        item: dict[str, Any] = {
            "filename": str(entry.get("filename") or ""),
            "subfolder": str(entry.get("subfolder") or ""),
        }
        try:
            path = resolve_input_image_path(entry)
            stat = path.stat()
            item["size"] = int(stat.st_size)
            item["mtime_ns"] = int(stat.st_mtime_ns)
        except Exception:
            item["missing"] = True
        signature.append(item)
    return signature


def resolve_input_image_path(entry: dict[str, str]) -> Path:
    input_dir = Path(folder_paths.get_input_directory()).resolve()
    filename = str(entry.get("filename") or "").strip()
    subfolder = str(entry.get("subfolder") or "").strip().replace("\\", "/")
    candidate = (input_dir / subfolder / filename).resolve()
    try:
        candidate.relative_to(input_dir)
    except ValueError as error:
        raise RuntimeError(f"图片路径越界：{subfolder}/{filename}") from error
    if not candidate.exists():
        raise RuntimeError(f"未找到图片：{subfolder}/{filename}")
    return candidate


def load_image_tensor(path: Path) -> torch.Tensor:
    image = Image.open(path)
    image = ImageOps.exif_transpose(image)

    # 保留原始通道：如果是 RGBA 则输出 RGBA，否则输出 RGB
    if image.mode == "RGBA":
        array = np.asarray(image).astype(np.float32) / 255.0
    else:
        image = image.convert("RGB")
        array = np.asarray(image).astype(np.float32) / 255.0

    return torch.from_numpy(array)[None, ...]


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
    text = str(raw_value or "").strip()
    if not text:
        return None

    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1].strip()
    if not text:
        return []

    def clamp_index(value: int) -> int | None:
        if value < 1 or value > total:
            return None
        return value - 1

    if ":" in text:
        parts = [part.strip() for part in text.split(":")]
        if len(parts) not in (2, 3):
            raise RuntimeError(f"序列范围格式错误：{raw_value}")
        try:
            start = int(parts[0]) if parts[0] else 1
            end = int(parts[1]) if parts[1] else total
            step = int(parts[2]) if len(parts) == 3 and parts[2] else (1 if start <= end else -1)
        except ValueError as error:
            raise RuntimeError(f"序列范围只能包含整数：{raw_value}") from error
        if step == 0:
            raise RuntimeError("序列范围的步长不能为 0。")
        stop = end + (1 if step > 0 else -1)
        return [index for item in range(start, stop, step) if (index := clamp_index(item)) is not None]

    items = text.replace("，", ",").split(",")
    indices: list[int] = []
    for item in items:
        item = item.strip()
        if not item:
            continue
        try:
            index = clamp_index(int(item))
        except ValueError as error:
            raise RuntimeError(f"序列范围只能包含整数：{raw_value}") from error
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
    OUTPUT_TOOLTIPS = ("将所有已选图片按顺序打包成一个 GJJ 专用批量图片队列输出。",) + tuple(
        f"第 {index} 张已选图片的单独输出；未使用的尾部输出会在前端自动收起。"
        for index in range(1, MAX_OUTPUT_IMAGES + 1)
    )

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
            "6. （可选）合并外部图片：接入其他节点的 IMAGE 输出，会与本地图片合并",
            "7. 连接输出：将「批量图片队列」连接到批量处理节点，或使用单图输出",
        ],

        "tips": [
            "💡 图片命名建议：使用数字前缀（如 001_xxx.jpg）便于排序和序列筛选",
            "💡 支持的格式：PNG、JPG、JPEG、WEBP、BMP 等常见图片格式",
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
        return {
            "required": {
                "selected_images": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": False,
                        "display_name": "已选图片",
                        "tooltip": "前端多图片面板自动维护的选择清单；正常使用时会自动隐藏。",
                    },
                ),
            },
            "optional": {
                "sequence_range": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "序列范围",
                        "tooltip": "可接入 GJJ · 递增数值 的“序列范围”。支持 [1,2] 和闭区间 [1:2]，编号与预览里的图片 1、图片 2 对齐。",
                    },
                ),
                "input_images": (
                    INPUT_IMAGE_TYPES,
                    {
                        "display_name": "导入图片",
                        "tooltip": "可接入 GJJ 专用批量图片队列或普通 IMAGE batch；会与当前已选图片合并预览并一起输出。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def __init__(self):
        self.preview_image = PreviewImage()

    @classmethod
    def IS_CHANGED(cls, selected_images="[]", sequence_range="", input_images=None, prompt=None, extra_pnginfo=None, unique_id=None):
        selected = recover_selected_images(selected_images, extra_pnginfo, unique_id)
        input_shape = tuple(input_images.shape) if isinstance(input_images, torch.Tensor) else ()
        return json.dumps(
            {
                "selected": selected_images_signature(selected),
                "sequence_range": str(sequence_range or ""),
                "input_shape": input_shape,
            },
            ensure_ascii=False,
            sort_keys=True,
        )

    def load_images(self, selected_images="[]", sequence_range="", input_images=None, prompt=None, extra_pnginfo=None, unique_id=None):
        selected = recover_selected_images(selected_images, extra_pnginfo, unique_id)
        collected: list[dict[str, Any]] = []

        if isinstance(input_images, torch.Tensor):
            batch = input_images
            if batch.ndim == 3:
                batch = batch.unsqueeze(0)
            for index in range(int(batch.shape[0])):
                image_tensor = batch[index:index + 1].contiguous()
                preview_ui = self.preview_image.save_images(
                    image_tensor,
                    filename_prefix="GJJ_MultiImageLoader",
                    prompt=prompt,
                    extra_pnginfo=extra_pnginfo,
                )
                collected.append(
                    {
                        "image": image_tensor,
                        "preview": preview_ui.get("ui", {}).get("images", []),
                        "source": "external",
                    }
                )

        for entry in selected:
            image_tensor = load_image_tensor(resolve_input_image_path(entry))
            preview_ui = self.preview_image.save_images(
                image_tensor,
                filename_prefix="GJJ_MultiImageLoader",
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            collected.append(
                {
                    "image": image_tensor,
                    "preview": preview_ui.get("ui", {}).get("images", []),
                    "source": "selected",
                }
            )

        indices = parse_sequence_range(sequence_range, len(collected))
        if indices is not None:
            collected = [collected[index] for index in indices]

        # 如果超过20张，只保留批量图片队列输出（不创建单图输出）
        # 如果20张以内，保留原有的批量队列+单图输出
        exceeds_limit = len(collected) > MAX_OUTPUT_IMAGES

        outputs = [item["image"] for item in collected]
        preview_entries: list[dict[str, Any]] = []
        for item in collected:
            preview_entries.extend(item["preview"])

        batch_output = build_uniform_batch(outputs)

        # 获取批量图片的通道数（3 或 4）
        num_channels = int(batch_output.shape[3]) if len(outputs) > 0 else 3

        if exceeds_limit:
            # 超过20张：只返回批量图片队列
            return {
                "ui": {
                    "preview_images": preview_entries,
                    "external_image_count": [sum(1 for item in collected if item.get("source") == "external")],
                    "merged_image_count": [len(preview_entries)],
                },
                "result": (batch_output,),
            }
        else:
            # 20张以内：批量队列 + 单图输出
            preview_entries = preview_entries[:MAX_OUTPUT_IMAGES]
            while len(outputs) < MAX_OUTPUT_IMAGES:
                outputs.append(empty_image_tensor(num_channels))
            return {
                "ui": {
                    "preview_images": preview_entries,
                    "external_image_count": [sum(1 for item in collected if item.get("source") == "external")],
                    "merged_image_count": [len(preview_entries)],
                },
                "result": (batch_output, *tuple(outputs[:MAX_OUTPUT_IMAGES])),
            }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MultiImageLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🧡·📂 批量多图片加载浏览器"}
