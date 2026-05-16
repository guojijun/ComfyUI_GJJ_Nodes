from __future__ import annotations

import json
import os
from typing import Any

import folder_paths
import numpy as np
import torch
from PIL import Image

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE

MAX_ROWS = 4
MAX_COLS = 4
MAX_BLOCKS = MAX_ROWS * MAX_COLS
NODE_NAME = "GJJ_ImageSplitter"

DEFAULT_STATE = json.dumps({
    "rows": 2,
    "cols": 2,
    "h_positions": [0.5],
    "v_positions": [0.5],
    "show_blocks": False,
    "align_px": 16,
})


class GJJ_ImageSplitter:
    CATEGORY = "GJJ"
    FUNCTION = "split"
    DESCRIPTION = """宫格图片分割器 —— 在节点内实时预览并拖拽分割线，自动裁剪每个区块，支持节点内部直接加载图片。

【核心功能】
🔲 实时预览图片，显示图片尺寸
📏 可拖拽的行列分割线（支持像素对齐 2/4/8/16/32px）
📐 实时调整行列数，分割线位置手动拖动
🎯 一键均分行列
📂 节点内部可直接加载图片
📦 分割后每个区块在节点内预览显示
🔗 区块独立 IMAGE 输出口默认隐藏，可在顶部 🔌 按钮中按需展开
📦 批量图片输出，一次输出所有区块

【使用说明】
1. 通过 IMAGE 输入口连接图片，或点击 📂 打开图片 按钮从节点内部加载
2. 在节点面板中拖拽分割线调整位置
3. 点击「均分」快速等分
4. 调整行列数后自动均分
5. 默认只显示「批量图片」输出口；需要独立区块输出时点击顶部 🔌 按钮展开
6. 执行节点即可获得每个区块的裁剪图片
7. 「批量图片」输出口一次输出所有区块，便于后续批量处理

【注意事项】
• 最多支持 4×4=16 个区块，独立区块输出口默认隐藏
• 点击顶部 🔌 按钮后，按实际行列数动态显示对应数量的输出口
• 分割线位置以图片尺寸的比例存储
• 对齐值单位为像素（px），拖拽时自动吸附到最近的像素倍数"""

    SEARCH_ALIASES = [
        "宫格图片分割器",
        "image splitter",
        "image crop",
        "图片分割",
        "图片裁剪",
        "九宫格",
        "grid split",
        "image grid",
        "分块",
        "切片",
        "图片拆分",
        "宫格",
        "网格分割",
        "等分",
    ]

    REQUIRED_PACKAGES = []
    REQUIRED_MODELS = []

    GJJ_HELP = {
        "title": "GJJ · 🔲 宫格图片分割器",
        "version": "1.2.0",
        "author": "GJJ Custom Nodes Team",
        "description": "在节点面板内实时预览并拖拽分割线，自动裁剪每个区块为独立图片输出，支持内部图片加载和批量图片输出",
        "features": [
            {"name": "实时预览", "description": "在节点内直接显示图片，可拖拽分割线调整裁剪区域"},
            {"name": "像素对齐", "description": "支持 2/4/8/16/32px 对齐值，拖拽分割线自动吸附到最近的像素倍数"},
            {"name": "一键均分", "description": "点击按钮快速等分行列，适合均匀网格切割"},
            {"name": "区块预览", "description": "分割后的每个区块在节点内缩略图预览"},
            {"name": "内部加载", "description": "节点内部可直接加载图片，无需依赖外部 IMAGE 输入"},
            {"name": "动态输出口", "description": "默认只保留批量图片输出口，点击顶部 🔌 按钮后按行列数展开独立区块输出口"},
            {"name": "批量图片输出", "description": "所有区块合并为一张批量图片输出，便于批量处理"},
        ],
        "inputs": {
            "image": {"type": "IMAGE", "required": False, "description": "输入待分割的图片"},
        },
        "outputs": {
            "批量图片": {"type": "GJJ_BATCH_IMAGE,IMAGE", "description": "所有裁剪区块合并为一张批量图片，便于后续批量处理"},
            "区块_1_1 ~ 区块_N_N": {"type": "IMAGE", "description": "按当前行列位置输出的裁剪区块；前端默认隐藏，可通过顶部 🔌 按钮展开"},
        },
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            # v6：split_state / internal_file 不再作为 STRING widget 暴露，
            # 避免 ComfyUI 布局中出现隐藏 widget 空行。
            # 前端把它们保存到 node.properties；后端通过 EXTRA_PNGINFO 的 workflow 读取。
            "required": {},
            "optional": {
                "image": ("IMAGE", {
                    "display_name": "输入图片",
                    "tooltip": "输入待分割的图片（可选）。不连接时可通过节点内的 📂 打开图片 按钮加载。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE",) + ("IMAGE",) * MAX_BLOCKS
    RETURN_NAMES = ("批量图片",) + tuple(
        f"区块_{i + 1}"
        for i in range(MAX_BLOCKS)
    )
    OUTPUT_TOOLTIPS = ("所有裁剪区块合并为一张批量图片，便于后续批量处理",) + tuple(
        f"第{i + 1}个裁剪区块"
        for i in range(MAX_BLOCKS)
    )

    def __init__(self):
        self._preview_filename = ""

    def split(
        self,
        image: torch.Tensor | None = None,
        unique_id: str | None = None,
        prompt: dict[str, Any] | None = None,
        extra_pnginfo: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        split_state = self._read_workflow_property(unique_id, prompt, extra_pnginfo, "split_state", DEFAULT_STATE)
        internal_file = self._read_workflow_property(unique_id, prompt, extra_pnginfo, "internal_file", "")

        source = image
        if source is None:
            source = self._load_internal(internal_file)
        if source is None:
            raise RuntimeError("请连接 IMAGE 输入，或点击 📂 打开图片 按钮从节点内部加载。")
        image = source

        state = self._parse_state(split_state)
        rows = int(state.get("rows", 2))
        cols = int(state.get("cols", 2))
        h_positions: list[float] = list(state.get("h_positions", []))
        v_positions: list[float] = list(state.get("v_positions", []))
        align_px = self._parse_align_px(state.get("align_px", 16))

        image = torch.clamp(image, 0.0, 1.0)
        if image.ndim == 3:
            image = image.unsqueeze(0)
        B, H, W, C = image.shape

        if len(h_positions) != max(rows - 1, 0):
            h_positions = self._default_positions(rows)
        if len(v_positions) != max(cols - 1, 0):
            v_positions = self._default_positions(cols)

        h_positions = sorted([max(0.0, min(1.0, p)) for p in h_positions])
        v_positions = sorted([max(0.0, min(1.0, p)) for p in v_positions])

        h_pixels = [0] + [int(H * p) for p in h_positions] + [H]
        v_pixels = [0] + [int(W * p) for p in v_positions] + [W]

        for i in range(1, len(h_pixels)):
            if h_pixels[i] <= h_pixels[i - 1]:
                h_pixels[i] = min(h_pixels[i - 1] + 1, H)
        for i in range(1, len(v_pixels)):
            if v_pixels[i] <= v_pixels[i - 1]:
                v_pixels[i] = min(v_pixels[i - 1] + 1, W)

        # 按当前行列数依次裁剪，行优先紧凑排列（与前端 syncOutputs 命名规则一致）
        active_blocks: list[torch.Tensor] = []
        for r in range(rows):
            for c in range(cols):
                y0 = h_pixels[r]
                y1 = h_pixels[r + 1]
                x0 = v_pixels[c]
                x1 = v_pixels[c + 1]
                if y1 > y0 and x1 > x0:
                    cropped = image[:, y0:y1, x0:x1, :].contiguous()
                    cropped = self._trim_to_multiple(cropped, align_px)
                    active_blocks.append(cropped)
                else:
                    active_blocks.append(torch.zeros((1, 1, 1, C), device=image.device, dtype=image.dtype))

        # 构建批量图片：所有有效区块在 batch 维度拼接
        if active_blocks:
            max_h = max(b.shape[1] for b in active_blocks)
            max_w = max(b.shape[2] for b in active_blocks)
            max_h = self._ceil_to_multiple(max_h, align_px)
            max_w = self._ceil_to_multiple(max_w, align_px)
            padded_blocks = []
            for b in active_blocks:
                pad_h = max_h - b.shape[1]
                pad_w = max_w - b.shape[2]
                if pad_h > 0 or pad_w > 0:
                    b = torch.nn.functional.pad(b, (0, 0, 0, pad_w, 0, pad_h), value=0)
                padded_blocks.append(b)
            batch_img = torch.cat(padded_blocks, dim=0)
        else:
            batch_img = torch.zeros((0, H, W, C))

        preview_file = self._save_preview(image)
        self._preview_filename = preview_file

        block_previews: list[dict[str, Any]] = []
        for r in range(rows):
            for c in range(cols):
                y0 = h_pixels[r]
                y1 = h_pixels[r + 1]
                x0 = v_pixels[c]
                x1 = v_pixels[c + 1]
                if y1 > y0 and x1 > x0:
                    block = image[:, y0:y1, x0:x1, :].contiguous()
                    block = self._trim_to_multiple(block, align_px)
                    block_file = self._save_block_preview(block, r, c)
                    block_previews.append({
                        "row": r,
                        "col": c,
                        "filename": block_file,
                        "w": int(block.shape[2]),
                        "h": int(block.shape[1]),
                        "align_px": int(align_px),
                    })

        ui: dict[str, Any] = {
            "preview": ({
                "filename": preview_file,
                "image_width": int(W),
                "image_height": int(H),
                "rows": rows,
                "cols": cols,
                "h_positions": h_positions,
                "v_positions": v_positions,
                "align_px": int(align_px),
                "blocks": block_previews,
            },),
        }

        # 对齐 RETURN_TYPES：补齐空张量到 1 + MAX_BLOCKS
        empty = torch.zeros((0, 1, 1, C), device=image.device, dtype=image.dtype)
        result = (batch_img,) + tuple(active_blocks)
        padding_needed = (1 + MAX_BLOCKS) - len(result)
        if padding_needed > 0:
            result = result + (empty,) * padding_needed

        return {
            "ui": ui,
            "result": result,
        }

    @staticmethod
    def _read_workflow_property(
        unique_id: str | None,
        prompt: dict[str, Any] | None,
        extra_pnginfo: dict[str, Any] | None,
        key: str,
        default: str,
    ) -> str:
        """读取前端保存在 node.properties 里的隐藏状态。

        这样可以从源头移除 split_state/internal_file 这两个 STRING widget，
        它们不再参与 ComfyUI 的 widget 排版，也就不会产生顶部/底部空行。
        """
        uid = str(unique_id) if unique_id is not None else ""

        # 兼容少数队列数据：如果 prompt 节点里仍然带 inputs。
        try:
            node_prompt = (prompt or {}).get(uid) or (prompt or {}).get(int(uid))
            value = (node_prompt or {}).get("inputs", {}).get(key)
            if value not in (None, ""):
                return str(value)
        except Exception:
            pass

        # UI 执行时 EXTRA_PNGINFO 通常包含完整 workflow，其中有 node.properties。
        try:
            workflow = (extra_pnginfo or {}).get("workflow") or {}
            for node in workflow.get("nodes", []) or []:
                if str(node.get("id")) == uid:
                    value = (node.get("properties") or {}).get(key)
                    if value not in (None, ""):
                        return str(value)
        except Exception:
            pass

        return default

    def _load_internal(self, filename: str) -> torch.Tensor | None:
        if not filename or not isinstance(filename, str) or not filename.strip():
            return None
        try:
            image_path = folder_paths.get_annotated_filepath(filename.strip())
            if not os.path.isfile(image_path):
                print(f"[GJJ_ImageSplitter] 内部图片文件不存在: {image_path}")
                return None
            pil_image = Image.open(image_path).convert("RGB")
            img_np = np.array(pil_image).astype(np.float32) / 255.0
            img_tensor = torch.from_numpy(img_np)
            if img_tensor.ndim == 2:
                img_tensor = img_tensor.unsqueeze(-1).expand(-1, -1, 3)
            if img_tensor.ndim == 3 and img_tensor.shape[-1] == 3:
                img_tensor = img_tensor.unsqueeze(0)
            return img_tensor
        except Exception as e:
            print(f"[GJJ_ImageSplitter] 内部图片加载失败: {e}")
            return None

    @staticmethod
    def _parse_align_px(raw: Any) -> int:
        try:
            v = int(raw)
        except Exception:
            v = 16
        return v if v in {2, 4, 8, 16, 32} else 16

    @staticmethod
    def _floor_to_multiple(value: int, align_px: int) -> int:
        value = int(value)
        align_px = max(1, int(align_px))
        if value <= 0 or value < align_px:
            return max(1, value)
        return max(align_px, (value // align_px) * align_px)

    @staticmethod
    def _ceil_to_multiple(value: int, align_px: int) -> int:
        value = int(value)
        align_px = max(1, int(align_px))
        if value <= 0 or value < align_px:
            return max(1, value)
        return ((value + align_px - 1) // align_px) * align_px

    @classmethod
    def _trim_to_multiple(cls, block: torch.Tensor, align_px: int) -> torch.Tensor:
        if block.ndim != 4:
            return block
        h = cls._floor_to_multiple(block.shape[1], align_px)
        w = cls._floor_to_multiple(block.shape[2], align_px)
        return block[:, :h, :w, :].contiguous()

    @staticmethod
    def _parse_state(raw: str) -> dict[str, Any]:
        try:
            state = json.loads(str(raw or "{}"))
            return state if isinstance(state, dict) else {}
        except Exception:
            return {}

    @staticmethod
    def _default_positions(count: int) -> list[float]:
        if count <= 1:
            return []
        return [round((i + 1) / count, 6) for i in range(count - 1)]

    def _save_preview(self, image: torch.Tensor) -> str:
        img_np = (image[0].cpu().numpy() * 255).astype(np.uint8)
        mode = "RGBA" if img_np.shape[-1] == 4 else "RGB"
        img_pil = Image.fromarray(img_np, mode=mode)
        output_dir = folder_paths.get_temp_directory()
        os.makedirs(output_dir, exist_ok=True)
        filename = f"GJJ_ImageSplitter_{id(self)}.png"
        img_pil.save(os.path.join(output_dir, filename), format="PNG")
        return filename

    def _save_block_preview(self, block: torch.Tensor, row: int, col: int) -> str:
        img_np = (block[0].cpu().numpy() * 255).astype(np.uint8)
        mode = "RGBA" if img_np.shape[-1] == 4 else "RGB"
        img_pil = Image.fromarray(img_np, mode=mode)
        output_dir = folder_paths.get_temp_directory()
        os.makedirs(output_dir, exist_ok=True)
        filename = f"GJJ_ImageSplitter_block_{id(self)}_{row}_{col}.png"
        img_pil.save(os.path.join(output_dir, filename), format="PNG")
        return filename


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageSplitter}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🔲 可视化宫格图片分割器"}
