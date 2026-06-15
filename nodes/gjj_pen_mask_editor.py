from __future__ import annotations

import base64
import json
import os
from collections import deque
from io import BytesIO
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFilter


NODE_NAME = "GJJ_PenMaskEditor"
BLEND_MODES = ["替换", "添加", "减去"]


def _safe_json_loads(value: Any, fallback: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    text = str(value or "").strip()
    if not text:
        return fallback
    try:
        return json.loads(text)
    except Exception:
        return fallback


def _image_to_tensor(image: Image.Image) -> torch.Tensor:
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGB")
    array = np.asarray(image).astype(np.float32) / 255.0
    if array.ndim == 2:
        array = array[..., None]
    if array.shape[-1] == 4:
        array = array[..., :3]
    return torch.from_numpy(array).unsqueeze(0)


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    tensor = image[0] if image.ndim == 4 else image
    array = tensor.detach().cpu().float().clamp(0.0, 1.0).numpy()
    if array.ndim == 2:
        array = np.repeat(array[..., None], 3, axis=-1)
    if array.shape[-1] == 1:
        array = np.repeat(array, 3, axis=-1)
    if array.shape[-1] > 3:
        array = array[..., :3]
    return Image.fromarray((array * 255.0).astype(np.uint8), mode="RGB")


def _resolve_input_image(filename: str) -> Image.Image | None:
    name = str(filename or "").strip()
    if not name:
        return None
    try:
        import folder_paths

        input_dir = folder_paths.get_input_directory()
        path = os.path.abspath(os.path.join(input_dir, name))
        input_root = os.path.abspath(input_dir)
        if os.path.commonpath([input_root, path]) != input_root or not os.path.isfile(path):
            return None
        return Image.open(path).convert("RGB")
    except Exception as exc:
        raise RuntimeError(f"打开面板图片失败：{exc}") from exc


def _tensor_image_to_base64(image: torch.Tensor | None) -> str | None:
    if image is None:
        return None
    try:
        pil_image = _tensor_to_pil(image)
        buffer = BytesIO()
        pil_image.save(buffer, format="JPEG", quality=86)
        return base64.b64encode(buffer.getvalue()).decode("utf-8")
    except Exception as exc:
        print(f"[GJJ_PenMaskEditor] 预览图编码失败：{exc}")
        return None


def _cubic_point(p0: dict[str, float], p1: dict[str, float], p2: dict[str, float], p3: dict[str, float], t: float) -> tuple[float, float]:
    mt = 1.0 - t
    x = mt ** 3 * p0["x"] + 3 * mt ** 2 * t * p1["x"] + 3 * mt * t ** 2 * p2["x"] + t ** 3 * p3["x"]
    y = mt ** 3 * p0["y"] + 3 * mt ** 2 * t * p1["y"] + 3 * mt * t ** 2 * p2["y"] + t ** 3 * p3["y"]
    return x, y


def _sample_path(points: list[dict[str, Any]], width: int, height: int) -> list[tuple[float, float]]:
    cleaned: list[dict[str, float]] = []
    for point in points:
        try:
            cleaned.append({
                "x": max(0.0, min(float(width - 1), float(point.get("x", 0)))),
                "y": max(0.0, min(float(height - 1), float(point.get("y", 0)))),
                "h1x": max(0.0, min(float(width - 1), float(point.get("h1x", point.get("x", 0))))),
                "h1y": max(0.0, min(float(height - 1), float(point.get("h1y", point.get("y", 0))))),
                "h2x": max(0.0, min(float(width - 1), float(point.get("h2x", point.get("x", 0))))),
                "h2y": max(0.0, min(float(height - 1), float(point.get("h2y", point.get("y", 0))))),
            })
        except Exception:
            continue
    if len(cleaned) < 2:
        return []
    result: list[tuple[float, float]] = []
    for index in range(1, len(cleaned)):
        prev = cleaned[index - 1]
        cur = cleaned[index]
        c1 = {"x": prev["h2x"], "y": prev["h2y"]}
        c2 = {"x": cur["h1x"], "y": cur["h1y"]}
        steps = max(8, int(((abs(cur["x"] - prev["x"]) + abs(cur["y"] - prev["y"])) / 18) + 8))
        for step in range(steps):
            result.append(_cubic_point(prev, c1, c2, cur, step / float(steps)))
    result.append((cleaned[-1]["x"], cleaned[-1]["y"]))
    return result


def _apply_mask(base: Image.Image, candidate: Image.Image, mode: str) -> Image.Image:
    if mode == "减去":
        if not np.asarray(base, dtype=np.uint8).any():
            return candidate
        return Image.fromarray(np.maximum(0, np.asarray(base, dtype=np.int16) - np.asarray(candidate, dtype=np.int16)).astype(np.uint8), mode="L")
    if mode == "添加":
        return Image.fromarray(np.maximum(np.asarray(base, dtype=np.uint8), np.asarray(candidate, dtype=np.uint8)), mode="L")
    return candidate


def _draw_paths(paths: list[dict[str, Any]], width: int, height: int, feather: int) -> Image.Image:
    mask = Image.new("L", (width, height), 0)
    for path in paths:
        if not isinstance(path, dict) or not path.get("closed", True):
            continue
        polygon = _sample_path(path.get("points") or [], width, height)
        if len(polygon) < 3:
            continue
        candidate = Image.new("L", (width, height), 0)
        ImageDraw.Draw(candidate).polygon(polygon, fill=255)
        mask = _apply_mask(mask, candidate, str(path.get("mode") or "添加"))
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=max(0.0, float(feather))))
    return mask


def _flood_fill_mask(image: Image.Image, x: int, y: int, tolerance: int) -> Image.Image:
    rgb = np.asarray(image.convert("RGB"), dtype=np.int16)
    height, width = rgb.shape[:2]
    x = max(0, min(width - 1, int(x)))
    y = max(0, min(height - 1, int(y)))
    target = rgb[y, x].copy()
    visited = np.zeros((height, width), dtype=bool)
    out = np.zeros((height, width), dtype=np.uint8)
    queue: deque[tuple[int, int]] = deque([(x, y)])
    threshold = max(0, int(tolerance))
    while queue:
        cx, cy = queue.popleft()
        if cx < 0 or cy < 0 or cx >= width or cy >= height or visited[cy, cx]:
            continue
        visited[cy, cx] = True
        if int(np.max(np.abs(rgb[cy, cx] - target))) > threshold:
            continue
        out[cy, cx] = 255
        queue.append((cx + 1, cy))
        queue.append((cx - 1, cy))
        queue.append((cx, cy + 1))
        queue.append((cx, cy - 1))
    return Image.fromarray(out, mode="L")


def _draw_wand(image: Image.Image, wand_points: list[dict[str, Any]], feather: int) -> Image.Image:
    width, height = image.size
    mask = Image.new("L", (width, height), 0)
    for point in wand_points:
        if not isinstance(point, dict):
            continue
        try:
            candidate = _flood_fill_mask(image, int(point.get("x", 0)), int(point.get("y", 0)), int(point.get("tolerance", 28)))
        except Exception:
            continue
        mask = _apply_mask(mask, candidate, str(point.get("mode") or "添加"))
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=max(0.0, float(feather))))
    return mask


def _apply_brush_points(base: Image.Image, brush_points: list[dict[str, Any]], width: int, height: int, feather: int) -> Image.Image:
    mask = base
    for point in brush_points:
        if not isinstance(point, dict):
            continue
        try:
            x = max(0.0, min(float(width - 1), float(point.get("x", 0))))
            y = max(0.0, min(float(height - 1), float(point.get("y", 0))))
            radius = max(1.0, min(float(max(width, height)), float(point.get("r", 24))))
        except Exception:
            continue
        candidate = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(candidate)
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
        if feather > 0:
            candidate = candidate.filter(ImageFilter.GaussianBlur(radius=max(0.0, float(feather))))
        mask = _apply_mask(mask, candidate, str(point.get("mode") or "添加"))
    return mask


def _mask_to_tensor(mask: Image.Image) -> torch.Tensor:
    array = np.asarray(mask.convert("L"), dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0).clamp(0.0, 1.0)


class GJJ_PenMaskEditor:
    CATEGORY = "GJJ/图像"
    FUNCTION = "make_mask"
    DESCRIPTION = "零依赖钢笔绘制遮罩。支持上游图片、面板打开图片、钢笔贝兹曲线和魔棒选区。"
    SEARCH_ALIASES = ["pen mask", "bezier mask", "magic wand", "钢笔遮罩", "贝兹遮罩", "魔棒"]
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("原图", "遮罩")
    OUTPUT_TOOLTIPS = (
        "上游输入图像或面板打开的原始图像。",
        "标准 MASK 输出，白色区域表示选中部分。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask_state": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "hidden": True,
                        "display": "hidden",
                        "display_name": "内部遮罩数据",
                        "tooltip": "前端钢笔和魔棒工具保存的路径数据，请不要手动编辑。",
                    },
                ),
                "image_file": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "hidden": True,
                        "display": "hidden",
                        "display_name": "面板图片文件",
                        "tooltip": "点击面板 📁 按钮上传后的图片文件名。",
                    },
                ),
                "blend_mode": (
                    BLEND_MODES,
                    {
                        "default": "添加",
                        "display_name": "新选区模式",
                        "tooltip": "后续钢笔闭合路径和魔棒点击默认以添加、减去或替换方式合成遮罩。",
                    },
                ),
                "wand_tolerance": (
                    "INT",
                    {
                        "default": 28,
                        "min": 0,
                        "max": 255,
                        "step": 1,
                        "display_name": "魔棒容差",
                        "tooltip": "魔棒选取相邻颜色的容差。数值越大，选区扩展越多。",
                    },
                ),
                "feather": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 128,
                        "step": 1,
                        "display_name": "遮罩羽化",
                        "tooltip": "对最终遮罩做高斯羽化，0 表示硬边。",
                    },
                ),
                "invert": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "反相遮罩",
                        "tooltip": "开启后输出黑白反相的遮罩。",
                    },
                ),
            },
            "optional": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "上游图像",
                        "tooltip": "可选输入图像。连接后优先使用上游图像；未连接时使用面板 📁 打开的图片。",
                    },
                ),
            },
        }

    def make_mask(
        self,
        mask_state: str,
        image_file: str,
        blend_mode: str,
        wand_tolerance: int,
        feather: int,
        invert: bool,
        image: torch.Tensor | None = None,
    ):
        source_tensor = image
        source_pil: Image.Image | None = _tensor_to_pil(image) if image is not None else None
        if source_pil is None:
            source_pil = _resolve_input_image(image_file)
            if source_pil is not None:
                source_tensor = _image_to_tensor(source_pil)
        if source_pil is None or source_tensor is None:
            source_pil = Image.new("RGB", (512, 512), (18, 24, 28))
            source_tensor = _image_to_tensor(source_pil)

        width, height = source_pil.size
        state = _safe_json_loads(mask_state, {})
        paths = state.get("paths") if isinstance(state, dict) else []
        wand_points = state.get("wand") if isinstance(state, dict) else []
        brush_points = state.get("brush") if isinstance(state, dict) else []
        base = _draw_paths(paths if isinstance(paths, list) else [], width, height, max(0, int(feather)))
        wand = _draw_wand(source_pil, wand_points if isinstance(wand_points, list) else [], max(0, int(feather)))
        mask = _apply_mask(base, wand, "添加")
        mask = _apply_brush_points(mask, brush_points if isinstance(brush_points, list) else [], width, height, max(0, int(feather)))
        if str(blend_mode or "") == "替换" and not paths and not wand_points and not brush_points:
            mask = Image.new("L", (width, height), 0)
        if invert:
            mask = Image.fromarray(255 - np.asarray(mask.convert("L"), dtype=np.uint8), mode="L")

        mask_tensor = _mask_to_tensor(mask).to(device=source_tensor.device)
        ui: dict[str, Any] = {}
        preview = _tensor_image_to_base64(source_tensor)
        if preview:
            ui["bg_image"] = [preview]
        result = (source_tensor, mask_tensor)
        return {"ui": ui, "result": result} if ui else result


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_PenMaskEditor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🖋 钢笔绘制遮罩"}
