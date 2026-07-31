from __future__ import annotations

import html
import json
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageFilter, ImageOps


NODE_NAME = "GJJ_ImageToSVGZero"
IMAGE_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
BRANCHES = ["彩色", "黑白", "线稿", "内嵌"]


def _hidden(options: dict[str, Any]) -> dict[str, Any]:
    result = dict(options)
    result["hidden"] = True
    result["display"] = "hidden"
    return result


def _first(value: Any) -> Any:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    return value


def _choice(value: Any, choices: list[str], fallback: str) -> str:
    text = str(_first(value) or "").strip()
    return text if text in choices else fallback


def _as_bool(value: Any, fallback: bool = False) -> bool:
    value = _first(value)
    if value is None:
        return fallback
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"0", "false", "off", "no", "关", "关闭", "否"}:
            return False
        if text in {"1", "true", "on", "yes", "开", "开启", "是"}:
            return True
    return bool(value)


def _as_int(value: Any, fallback: int, min_value: int, max_value: int) -> int:
    try:
        return max(min_value, min(max_value, int(float(_first(value)))))
    except Exception:
        return fallback


def _as_float(value: Any, fallback: float, min_value: float, max_value: float) -> float:
    try:
        return max(min_value, min(max_value, float(_first(value))))
    except Exception:
        return fallback


def _extract_image_tensor(image: Any) -> Any:
    image = _first(image)
    if isinstance(image, torch.Tensor):
        return image
    if isinstance(image, dict):
        for key in ("images", "image", "frames", "samples"):
            value = image.get(key)
            if isinstance(value, torch.Tensor):
                return value
    for attr in ("images", "image", "frames", "samples"):
        try:
            value = getattr(image, attr)
        except Exception:
            value = None
        if isinstance(value, torch.Tensor):
            return value
    return image


def _ensure_bhwc(image: Any) -> torch.Tensor | None:
    image = _extract_image_tensor(image)
    if not isinstance(image, torch.Tensor):
        return None
    tensor = image.detach().float().clamp(0.0, 1.0)
    if tensor.ndim == 3:
        if int(tensor.shape[-1]) in (1, 3, 4):
            tensor = tensor.unsqueeze(0)
        elif int(tensor.shape[0]) in (1, 3, 4):
            tensor = tensor.movedim(0, -1).unsqueeze(0)
    if tensor.ndim != 4:
        return None
    if int(tensor.shape[-1]) not in (1, 3, 4) and int(tensor.shape[1]) in (1, 3, 4):
        tensor = tensor.movedim(1, -1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels > 4:
        tensor = tensor[..., :4]
    return tensor.contiguous()


def _tensor_to_images(image: Any) -> list[Image.Image]:
    tensor = _ensure_bhwc(image)
    if tensor is None:
        return []
    result: list[Image.Image] = []
    for frame in tensor.cpu():
        array = (frame.numpy() * 255.0).round().astype(np.uint8)
        mode = "RGBA" if array.shape[-1] == 4 else "RGB"
        result.append(Image.fromarray(array[..., :4 if mode == "RGBA" else 3], mode=mode))
    return result


def _extract_mask_tensor(mask: Any) -> Any:
    mask = _first(mask)
    if isinstance(mask, torch.Tensor):
        return mask
    if isinstance(mask, dict):
        for key in ("mask", "masks", "alpha"):
            value = mask.get(key)
            if isinstance(value, torch.Tensor):
                return value
    for attr in ("mask", "masks", "alpha"):
        try:
            value = getattr(mask, attr)
        except Exception:
            value = None
        if isinstance(value, torch.Tensor):
            return value
    return mask


def _ensure_bhw_mask(mask: Any) -> torch.Tensor | None:
    mask = _extract_mask_tensor(mask)
    if not isinstance(mask, torch.Tensor):
        return None
    tensor = mask.detach().float().clamp(0.0, 1.0)
    if tensor.ndim == 2:
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim == 3:
        if int(tensor.shape[0]) in (1, 3, 4) and int(tensor.shape[-1]) not in (1, 3, 4):
            tensor = tensor[:1]
        elif int(tensor.shape[-1]) in (1, 3, 4):
            tensor = tensor[..., 0]
    elif tensor.ndim == 4:
        if int(tensor.shape[-1]) in (1, 3, 4):
            tensor = tensor[..., 0]
        elif int(tensor.shape[1]) in (1, 3, 4):
            tensor = tensor[:, 0, :, :]
    if tensor.ndim != 3:
        return None
    return tensor.contiguous()


def _apply_transparency_masks(images: list[Image.Image], mask: Any) -> list[Image.Image]:
    masks = _ensure_bhw_mask(mask)
    if masks is None or not images:
        return images
    result: list[Image.Image] = []
    resample = getattr(getattr(Image, "Resampling", Image), "BILINEAR", Image.BILINEAR)
    mask_frames = masks.cpu()
    for index, image in enumerate(images):
        rgba = image.convert("RGBA")
        mask_frame = mask_frames[min(index, int(mask_frames.shape[0]) - 1)]
        mask_array = (mask_frame.numpy() * 255.0).round().astype(np.uint8)
        mask_image = Image.fromarray(mask_array, mode="L")
        if mask_image.size != rgba.size:
            mask_image = mask_image.resize(rgba.size, resample)
        # ComfyUI Load Image outputs mask as white for transparent pixels.
        visible_alpha = ImageOps.invert(mask_image)
        existing_alpha = rgba.getchannel("A")
        combined_alpha = Image.fromarray(np.minimum(np.asarray(existing_alpha), np.asarray(visible_alpha)).astype(np.uint8), mode="L")
        rgba.putalpha(combined_alpha)
        result.append(rgba)
    return result


def _input_file_path(item: dict[str, Any]) -> Path | None:
    filename = str(item.get("filename") or item.get("name") or item.get("file") or "").strip()
    if not filename:
        return None
    subfolder = str(item.get("subfolder") or "").strip().strip("/\\")
    image_type = str(item.get("type") or "input").strip().lower() or "input"
    if image_type != "input":
        return None
    annotated = f"{subfolder}/{filename}" if subfolder else filename
    try:
        if folder_paths.exists_annotated_filepath(annotated):
            return Path(folder_paths.get_annotated_filepath(annotated)).resolve()
    except Exception:
        pass
    root = Path(folder_paths.get_input_directory()).resolve()
    path = (root / subfolder / filename).resolve() if subfolder else (root / filename).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path if path.is_file() else None


def _load_reference_images(file_references: str) -> list[Image.Image]:
    text = str(_first(file_references) or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except Exception:
        data = []
    if isinstance(data, dict):
        data = [data]
    result: list[Image.Image] = []
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict):
            continue
        path = _input_file_path(item)
        if path is None:
            continue
        with Image.open(path) as image:
            result.append(ImageOps.exif_transpose(image).convert("RGBA"))
    return result


def _fit_image(image: Image.Image, max_size: int) -> Image.Image:
    clean = ImageOps.exif_transpose(image).convert("RGBA")
    limit = max(16, int(max_size))
    if max(clean.size) <= limit:
        return clean
    resized = clean.copy()
    resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    resized.thumbnail((limit, limit), resample)
    return resized


def _hex(rgb: tuple[int, int, int]) -> str:
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def _clean_color(value: Any) -> str:
    text = str(_first(value) or "").strip()
    if not text or text in {"{}", "[]", "None", "none", "null"}:
        return ""
    if re.fullmatch(r"#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?", text):
        if len(text) == 4:
            return "#" + "".join(ch * 2 for ch in text[1:]).lower()
        return text[:7].lower()
    named = {
        "black": "#000000",
        "white": "#ffffff",
        "red": "#ff0000",
        "green": "#008000",
        "blue": "#0000ff",
        "yellow": "#ffff00",
        "transparent": "",
    }
    return named.get(text.lower(), text)


def _median_color(arr: np.ndarray, mask: np.ndarray) -> str:
    pixels = arr[np.asarray(mask, dtype=bool)]
    if pixels.size == 0:
        return ""
    rgb = np.median(pixels.reshape(-1, 3), axis=0).round().astype(np.uint8)
    return _hex((int(rgb[0]), int(rgb[1]), int(rgb[2])))


def _auto_foreground(src: Image.Image, foreground: Any, mask: np.ndarray) -> str:
    rgb = np.asarray(src.convert("RGB"))
    alpha = np.asarray(src.getchannel("A")) > 0
    fg = _clean_color(foreground)
    if not fg:
        fg = _median_color(rgb, np.asarray(mask, dtype=bool) & alpha) or "#111111"
    return fg


def _minority_mask(mask: np.ndarray, visible: np.ndarray, invert: bool) -> np.ndarray:
    result = np.asarray(mask, dtype=bool) & np.asarray(visible, dtype=bool)
    visible_count = int(np.count_nonzero(visible))
    if visible_count <= 0:
        return result
    coverage = float(np.count_nonzero(result)) / float(visible_count)
    if bool(invert):
        return (~result) & visible
    if coverage > 0.5:
        return (~result) & visible
    return result


def _remove_border_background(mask: np.ndarray, visible: np.ndarray) -> np.ndarray:
    result = np.asarray(mask, dtype=bool) & np.asarray(visible, dtype=bool)
    if not result.any():
        return result
    h, w = result.shape
    border = np.zeros_like(result, dtype=bool)
    border[0, :] = result[0, :]
    border[h - 1, :] = result[h - 1, :]
    border[:, 0] = result[:, 0]
    border[:, w - 1] = result[:, w - 1]
    if not border.any():
        return result

    connected = np.zeros_like(result, dtype=bool)
    stack = [(int(y), int(x)) for y, x in np.argwhere(border)]
    while stack:
        y, x = stack.pop()
        if y < 0 or y >= h or x < 0 or x >= w or connected[y, x] or not result[y, x]:
            continue
        connected[y, x] = True
        stack.append((y - 1, x))
        stack.append((y + 1, x))
        stack.append((y, x - 1))
        stack.append((y, x + 1))

    mask_count = int(np.count_nonzero(result))
    visible_count = int(np.count_nonzero(visible))
    connected_count = int(np.count_nonzero(connected))
    if mask_count <= 0 or visible_count <= 0:
        return result
    connected_ratio = connected_count / float(mask_count)
    visible_ratio = connected_count / float(visible_count)
    if connected_ratio < 0.35 and visible_ratio < 0.20:
        return result
    cleaned = result & ~connected
    if np.count_nonzero(cleaned) >= max(8, int(visible_count * 0.001)):
        return cleaned
    return result


def _filter_speckles(mask: np.ndarray, min_area: int) -> np.ndarray:
    result = np.asarray(mask, dtype=bool)
    threshold = max(0, int(min_area))
    if threshold <= 1 or not result.any():
        return result
    h, w = result.shape
    seen = np.zeros_like(result, dtype=bool)
    cleaned = np.zeros_like(result, dtype=bool)
    for y0, x0 in np.argwhere(result):
        y = int(y0)
        x = int(x0)
        if seen[y, x]:
            continue
        stack = [(y, x)]
        seen[y, x] = True
        component: list[tuple[int, int]] = []
        while stack:
            cy, cx = stack.pop()
            component.append((cy, cx))
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and result[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        if len(component) >= threshold:
            for cy, cx in component:
                cleaned[cy, cx] = True
    return cleaned


def _border_mask(shape: tuple[int, int]) -> np.ndarray:
    h, w = shape
    result = np.zeros((h, w), dtype=bool)
    if h <= 0 or w <= 0:
        return result
    result[0, :] = True
    result[h - 1, :] = True
    result[:, 0] = True
    result[:, w - 1] = True
    return result


def _remove_border_connected(mask: np.ndarray) -> np.ndarray:
    result = np.asarray(mask, dtype=bool)
    if not result.any():
        return result
    h, w = result.shape
    border = _border_mask((h, w)) & result
    if not border.any():
        return result
    connected = np.zeros_like(result, dtype=bool)
    stack = [(int(y), int(x)) for y, x in np.argwhere(border)]
    while stack:
        y, x = stack.pop()
        if y < 0 or y >= h or x < 0 or x >= w or connected[y, x] or not result[y, x]:
            continue
        connected[y, x] = True
        stack.append((y - 1, x))
        stack.append((y + 1, x))
        stack.append((y, x - 1))
        stack.append((y, x + 1))
    return result & ~connected


def _keep_inside_subject_band(mask: np.ndarray, x_margin: float = 0.30, y_margin: float = 0.03) -> np.ndarray:
    result = np.asarray(mask, dtype=bool)
    if not result.any():
        return result
    h, w = result.shape
    x0 = int(round(w * x_margin))
    x1 = int(round(w * (1.0 - x_margin)))
    y0 = int(round(h * y_margin))
    y1 = int(round(h * (1.0 - y_margin)))
    keep = np.zeros_like(result, dtype=bool)
    keep[max(0, y0): min(h, y1), max(0, x0): min(w, x1)] = True
    return result & keep


def _looks_like_edge_background(color: np.ndarray, mask: np.ndarray, border: np.ndarray, visible: np.ndarray) -> bool:
    border_visible = border & visible
    border_count = int(np.count_nonzero(border_visible))
    mask_count = int(np.count_nonzero(mask))
    visible_count = int(np.count_nonzero(visible))
    border_hits = int(np.count_nonzero(mask & border_visible))
    if border_count <= 0 or mask_count <= 0 or visible_count <= 0 or border_hits <= 0:
        return False
    border_ratio = border_hits / float(border_count)
    area_ratio = mask_count / float(visible_count)
    rgb = np.asarray(color, dtype=np.int16)
    spread = int(rgb.max() - rgb.min())
    brightness = float(rgb.mean())
    near_neutral = spread <= 36
    near_white = near_neutral and brightness >= 210.0
    near_black = near_neutral and brightness <= 32.0
    dominant_on_border = border_ratio >= 0.18 and area_ratio >= 0.015
    neutral_border = (near_white or near_black) and border_ratio >= 0.035 and area_ratio >= 0.01
    return dominant_on_border or neutral_border


def _looks_like_transparent_rgb_background(color: np.ndarray, mask: np.ndarray, border: np.ndarray, visible: np.ndarray) -> bool:
    if not mask.any():
        return False
    rgb = np.asarray(color, dtype=np.int16)
    spread = int(rgb.max() - rgb.min())
    brightness = float(rgb.mean())
    near_white = spread <= 58 and brightness >= 178.0
    near_black = spread <= 42 and brightness <= 48.0
    if not (near_white or near_black):
        return False
    visible_count = max(1, int(np.count_nonzero(visible)))
    area_ratio = int(np.count_nonzero(mask)) / float(visible_count)
    border_visible = border & visible
    border_count = max(1, int(np.count_nonzero(border_visible)))
    border_ratio = int(np.count_nonzero(mask & border_visible)) / float(border_count)
    return area_ratio >= 0.012 or border_ratio >= 0.004


def _outline_mask(mask: np.ndarray, visible: np.ndarray) -> np.ndarray:
    result = np.asarray(mask, dtype=bool) & np.asarray(visible, dtype=bool)
    if not result.any():
        return result
    padded = np.pad(result, 1, mode="constant", constant_values=False)
    eroded = (
        padded[1:-1, 1:-1]
        & padded[:-2, 1:-1]
        & padded[2:, 1:-1]
        & padded[1:-1, :-2]
        & padded[1:-1, 2:]
    )
    return result & ~eroded


def _rects_from_mask(mask: np.ndarray) -> list[tuple[int, int, int, int]]:
    h, w = mask.shape
    rects: list[tuple[int, int, int, int]] = []
    open_runs: dict[tuple[int, int], tuple[int, int, int]] = {}
    for y in range(h):
        row = mask[y]
        runs: list[tuple[int, int]] = []
        x = 0
        while x < w:
            while x < w and not row[x]:
                x += 1
            if x >= w:
                break
            start = x
            while x < w and row[x]:
                x += 1
            runs.append((start, x - start))
        current: dict[tuple[int, int], tuple[int, int, int]] = {}
        for run in runs:
            if run in open_runs:
                sx, sy, height = open_runs[run]
                current[run] = (sx, sy, height + 1)
            else:
                current[run] = (run[0], y, 1)
        for run, (sx, sy, height) in open_runs.items():
            if run not in current:
                rects.append((sx, sy, run[1], height))
        open_runs = current
    for run, (sx, sy, height) in open_runs.items():
        rects.append((sx, sy, run[1], height))
    return rects


def _mask_to_path(mask: np.ndarray, mode: str = "spline", precision: int = 3, simplify_tolerance: float = 0.0) -> str:
    active = np.asarray(mask, dtype=bool)
    if not active.any():
        return ""
    edges: set[tuple[tuple[int, int], tuple[int, int]]] = set()

    def add_edge(start: tuple[int, int], end: tuple[int, int]) -> None:
        reverse = (end, start)
        if reverse in edges:
            edges.remove(reverse)
        else:
            edges.add((start, end))

    ys, xs = np.nonzero(active)
    for y_raw, x_raw in zip(ys, xs):
        x = int(x_raw)
        y = int(y_raw)
        add_edge((x, y), (x + 1, y))
        add_edge((x + 1, y), (x + 1, y + 1))
        add_edge((x + 1, y + 1), (x, y + 1))
        add_edge((x, y + 1), (x, y))

    outgoing: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for start, end in edges:
        outgoing.setdefault(start, []).append(end)

    def take_next(current: tuple[int, int], previous: tuple[int, int]) -> tuple[int, int] | None:
        candidates = outgoing.get(current) or []
        candidates[:] = [point for point in candidates if (current, point) in edges]
        if not candidates:
            return None
        dx = current[0] - previous[0]
        dy = current[1] - previous[1]
        same_direction = (current[0] + dx, current[1] + dy)
        if same_direction in candidates and (current, same_direction) in edges:
            candidates.remove(same_direction)
            return same_direction
        return candidates.pop()

    def simplify(points: list[tuple[int, int]]) -> list[tuple[int, int]]:
        if len(points) <= 3:
            return points
        result = [points[0]]
        for index in range(1, len(points) - 1):
            prev = result[-1]
            curr = points[index]
            next_point = points[index + 1]
            if (curr[0] - prev[0], curr[1] - prev[1]) == (next_point[0] - curr[0], next_point[1] - curr[1]):
                continue
            result.append(curr)
        result.append(points[-1])
        return result

    def point_line_distance(point: tuple[int, int], start: tuple[int, int], end: tuple[int, int]) -> float:
        px, py = point
        sx, sy = start
        ex, ey = end
        dx = ex - sx
        dy = ey - sy
        if dx == 0 and dy == 0:
            return float(((px - sx) ** 2 + (py - sy) ** 2) ** 0.5)
        return abs(dy * px - dx * py + ex * sy - ey * sx) / float((dx * dx + dy * dy) ** 0.5)

    def rdp(points: list[tuple[int, int]], tolerance: float) -> list[tuple[int, int]]:
        if len(points) <= 2 or tolerance <= 0:
            return points
        start = points[0]
        end = points[-1]
        best_index = -1
        best_distance = -1.0
        for index in range(1, len(points) - 1):
            distance = point_line_distance(points[index], start, end)
            if distance > best_distance:
                best_distance = distance
                best_index = index
        if best_distance > tolerance and best_index > 0:
            left = rdp(points[: best_index + 1], tolerance)
            right = rdp(points[best_index:], tolerance)
            return left[:-1] + right
        return [start, end]

    def simplify_loop(points: list[tuple[int, int]], tolerance: float) -> list[tuple[int, int]]:
        if tolerance <= 0 or len(points) < 8:
            return points
        closed = points[:-1] if points[0] == points[-1] else points
        if len(closed) < 8:
            return points
        anchor = min(range(len(closed)), key=lambda index: (closed[index][0], closed[index][1]))
        rotated = closed[anchor:] + closed[:anchor] + [closed[anchor]]
        simplified = rdp(rotated, tolerance)
        if len(simplified) < 4:
            return points
        if simplified[0] != simplified[-1]:
            simplified.append(simplified[0])
        return simplified

    decimals = max(0, min(6, int(precision)))

    def format_number(value: float) -> str:
        text = f"{value:.{decimals}f}".rstrip("0").rstrip(".")
        return text or "0"

    def midpoint(left: tuple[int, int], right: tuple[int, int]) -> tuple[float, float]:
        return ((left[0] + right[0]) / 2.0, (left[1] + right[1]) / 2.0)

    def smooth_loop_path(points: list[tuple[int, int]]) -> str:
        if len(points) < 4:
            return ""
        closed = points[:-1] if points[0] == points[-1] else points
        if len(closed) < 3:
            return ""
        start = midpoint(closed[-1], closed[0])
        commands = [f"M{format_number(start[0])} {format_number(start[1])}"]
        for index, control in enumerate(closed):
            end = midpoint(control, closed[(index + 1) % len(closed)])
            commands.append(
                "Q"
                f"{format_number(control[0])} {format_number(control[1])} "
                f"{format_number(end[0])} {format_number(end[1])}"
            )
        commands.append("Z")
        return " ".join(commands)

    segments: list[str] = []
    while edges:
        start, end = edges.pop()
        loop = [start, end]
        previous = start
        current = end
        guard = 0
        while current != start and guard < 1000000:
            guard += 1
            next_point = take_next(current, previous)
            if next_point is None:
                break
            edge = (current, next_point)
            if edge in edges:
                edges.remove(edge)
            previous, current = current, next_point
            loop.append(current)
        if len(loop) >= 3 and loop[-1] == start:
            points = simplify(loop)
            points = simplify_loop(points, max(0.0, float(simplify_tolerance)))
            if str(mode or "spline").lower() == "spline":
                path = smooth_loop_path(points)
                if path:
                    segments.append(path)
            else:
                commands = [f"M{points[0][0]} {points[0][1]}"]
                commands.extend(f"L{x} {y}" for x, y in points[1:-1])
                commands.append("Z")
                segments.append(" ".join(commands))
    return " ".join(segments)


def _append_mask_path(lines: list[str], mask: np.ndarray, fill: str, mode: str = "spline", precision: int = 3, simplify_tolerance: float = 0.0) -> None:
    path = _mask_to_path(mask, mode, precision, simplify_tolerance)
    if path:
        lines.append(f'<path d="{path}" fill="{fill}" fill-rule="evenodd"/>')


def _svg_header(width: int, height: int) -> list[str]:
    return [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" shape-rendering="geometricPrecision">',
        "<metadata>Generated by GJJ zero-dependency SVG node</metadata>",
    ]


def _svg_footer() -> str:
    return "</svg>"


def _color_rect_svg(
    image: Image.Image,
    max_size: int,
    colors: int,
    background: str,
    min_alpha: int,
    trace_mode: str = "spline",
    filter_speckle: int = 4,
    path_precision: int = 3,
    simplify_tolerance: float = 4.0,
) -> str:
    src = _fit_image(image, max_size)
    rgb = src.convert("RGB")
    alpha = np.asarray(src.getchannel("A"))
    quantized = rgb.quantize(colors=max(2, min(256, int(colors))), method=Image.Quantize.MEDIANCUT).convert("RGB")
    arr = np.asarray(quantized)
    h, w = arr.shape[:2]
    lines = _svg_header(w, h)
    flat_colors = np.unique(arr.reshape(-1, 3), axis=0)
    visible = alpha >= int(min_alpha)
    border = _border_mask((h, w))
    for color in flat_colors:
        mask = visible & np.all(arr == color, axis=2)
        if _looks_like_edge_background(color, mask, border, visible):
            mask = _remove_border_connected(mask)
        if _looks_like_transparent_rgb_background(color, mask, border, visible):
            mask = _keep_inside_subject_band(mask)
        mask = _filter_speckles(mask, filter_speckle)
        if not mask.any():
            continue
        fill = _hex(tuple(int(v) for v in color))
        _append_mask_path(lines, mask, fill, trace_mode, path_precision, simplify_tolerance)
    lines.append(_svg_footer())
    return "\n".join(lines)


def _bw_rect_svg(
    image: Image.Image,
    max_size: int,
    threshold: int,
    foreground: str,
    background: str,
    invert: bool,
    trace_mode: str = "spline",
    filter_speckle: int = 4,
    path_precision: int = 3,
    simplify_tolerance: float = 4.0,
) -> str:
    src = _fit_image(image, max_size)
    gray = np.asarray(src.convert("L"))
    alpha = np.asarray(src.getchannel("A"))
    visible = alpha > 0
    mask = _minority_mask(gray < int(threshold), visible, invert)
    cleaned = _remove_border_background(mask, visible)
    if int(np.count_nonzero(cleaned)) < int(np.count_nonzero(mask)) * 0.08:
        mask = _outline_mask(mask, visible)
    else:
        mask = cleaned
    mask = _filter_speckles(mask, filter_speckle)
    h, w = gray.shape
    lines = _svg_header(w, h)
    fill = _auto_foreground(src, foreground, mask)
    fill = html.escape(fill or "#000000")
    _append_mask_path(lines, mask, fill, trace_mode, path_precision, simplify_tolerance)
    lines.append(_svg_footer())
    return "\n".join(lines)


def _line_svg(
    image: Image.Image,
    max_size: int,
    threshold: int,
    stroke: str,
    background: str,
    invert: bool,
    trace_mode: str = "spline",
    filter_speckle: int = 4,
    path_precision: int = 3,
    simplify_tolerance: float = 4.0,
) -> str:
    src = _fit_image(image, max_size)
    edges = ImageOps.autocontrast(ImageOps.grayscale(src).filter(ImageFilter.FIND_EDGES))
    arr = np.asarray(edges)
    alpha = np.asarray(src.getchannel("A"))
    visible = alpha > 0
    mask = _minority_mask(arr >= int(threshold), visible, invert)
    mask = _remove_border_background(mask, visible)
    mask = _filter_speckles(mask, filter_speckle)
    h, w = arr.shape
    lines = _svg_header(w, h)
    fill = _auto_foreground(src, stroke, mask)
    fill = html.escape(fill or "#111111")
    _append_mask_path(lines, mask, fill, trace_mode, path_precision, simplify_tolerance)
    lines.append(_svg_footer())
    return "\n".join(lines)


def _embedded_svg(image: Image.Image, max_size: int, background: str) -> str:
    return _color_rect_svg(image, max_size, 64, "", 0)


def _svg_size(svg: str) -> tuple[int, int]:
    match = re.search(r'viewBox="0 0 ([0-9]+) ([0-9]+)"', svg)
    if match:
        return int(match.group(1)), int(match.group(2))
    return 1, 1


def _combine_svgs(items: list[str], gap: int = 16) -> str:
    if len(items) <= 1:
        return items[0] if items else ""
    sizes = [_svg_size(item) for item in items]
    width = max(w for w, _h in sizes)
    height = sum(h for _w, h in sizes) + gap * (len(items) - 1)
    lines = _svg_header(width, height)
    y = 0
    for index, svg in enumerate(items):
        w, h = sizes[index]
        body = re.sub(r"^.*?<metadata>.*?</metadata>", "", svg, flags=re.S)
        body = re.sub(r"</svg>\s*$", "", body, flags=re.S).strip()
        body = re.sub(r"^<svg[^>]*>", "", body, flags=re.S).strip()
        x = max(0, (width - w) // 2)
        lines.append(f'<g transform="translate({x},{y})">{body}</g>')
        y += h + gap
    lines.append(_svg_footer())
    return "\n".join(lines)


def _svg_to_preview_item(svg: str) -> dict[str, Any]:
    from .common_utils.temp_files import gjjutils_write_temp_bytes

    return gjjutils_write_temp_bytes(svg.encode("utf-8"), suffix=".svg")


def _save_svg_files(svg_items: list[str], combined: str, save_directory: str, prefix: str) -> list[str]:
    raw = str(save_directory or "").strip().strip('"')
    if not raw:
        return []
    path = Path(os.path.expandvars(os.path.expanduser(raw)))
    if not path.is_absolute():
        path = Path(folder_paths.get_output_directory()) / path
    path.mkdir(parents=True, exist_ok=True)
    clean_prefix = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", str(prefix or "GJJ_ToSVG")).strip("._") or "GJJ_ToSVG"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    saved: list[str] = []
    if len(svg_items) <= 1:
        target = path / f"{clean_prefix}_{stamp}_{uuid.uuid4().hex[:8]}.svg"
        target.write_text(combined, encoding="utf-8")
        return [str(target)]
    for index, svg in enumerate(svg_items, start=1):
        target = path / f"{clean_prefix}_{stamp}_{index:03d}_{uuid.uuid4().hex[:6]}.svg"
        target.write_text(svg, encoding="utf-8")
        saved.append(str(target))
    target = path / f"{clean_prefix}_{stamp}_combined_{uuid.uuid4().hex[:6]}.svg"
    target.write_text(combined, encoding="utf-8")
    saved.append(str(target))
    return saved


class GJJ_ImageToSVGZero:
    CATEGORY = "GJJ/🖼️ 图像/图片转svg"
    FUNCTION = "convert"
    DESCRIPTION = "零依赖图片转 SVG 单节点：可选接入 GJJ_BATCH_IMAGE/IMAGE，也可从顶部按钮上传一个或多个文件；输出 SVG 字符串并在节点内预览。"
    SEARCH_ALIASES = ["to svg", "svg", "image to svg", "图片转svg", "零依赖svg"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("SVG_STRING",)
    OUTPUT_TOOLTIPS = ("生成的 SVG 字符串；多图输入时输出竖向合并 SVG。",)
    OUTPUT_NODE = True
    INPUT_IS_LIST = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "branch": (BRANCHES, _hidden({"default": "彩色", "display_name": "分支"})),
                "max_size": ("INT", _hidden({"default": 384, "min": 16, "max": 4096, "step": 8, "display_name": "最大尺寸"})),
                "color_count": ("INT", _hidden({"default": 16, "min": 2, "max": 256, "step": 1, "display_name": "颜色数"})),
                "threshold": ("INT", _hidden({"default": 128, "min": 0, "max": 255, "step": 1, "display_name": "阈值"})),
                "background": ("STRING", _hidden({"default": "", "display_name": "背景颜色"})),
                "foreground": ("STRING", _hidden({"default": "#111111", "display_name": "前景/线条颜色"})),
                "invert": ("BOOLEAN", _hidden({"default": False, "display_name": "反相"})),
                "min_alpha": ("INT", _hidden({"default": 64, "min": 0, "max": 255, "step": 1, "display_name": "透明阈值"})),
                "filename_prefix": ("STRING", _hidden({"default": "GJJ_ToSVG", "display_name": "文件名前缀"})),
                "save_directory": ("STRING", _hidden({"default": "", "display_name": "SVG保存路径"})),
                "file_references": ("STRING", _hidden({"default": "[]", "multiline": True, "display_name": "上传文件"})),
                "hierarchical": (["stacked", "cutout"], _hidden({"default": "stacked", "display_name": "hierarchical"})),
                "trace_mode": (["spline", "polygon", "none"], _hidden({"default": "spline", "display_name": "mode"})),
                "filter_speckle": ("INT", _hidden({"default": 2, "min": 0, "max": 4096, "step": 1, "display_name": "filter_speckle"})),
                "color_precision": ("INT", _hidden({"default": 7, "min": 1, "max": 8, "step": 1, "display_name": "color_precision"})),
                "layer_difference": ("INT", _hidden({"default": 16, "min": 0, "max": 255, "step": 1, "display_name": "layer_difference"})),
                "corner_threshold": ("INT", _hidden({"default": 60, "min": 0, "max": 180, "step": 1, "display_name": "corner_threshold"})),
                "length_threshold": ("FLOAT", _hidden({"default": 2.5, "min": 0.0, "max": 100.0, "step": 0.1, "display_name": "length_threshold"})),
                "max_iterations": ("INT", _hidden({"default": 10, "min": 1, "max": 100, "step": 1, "display_name": "max_iterations"})),
                "splice_threshold": ("INT", _hidden({"default": 45, "min": 0, "max": 180, "step": 1, "display_name": "splice_threshold"})),
                "path_precision": ("INT", _hidden({"default": 3, "min": 0, "max": 6, "step": 1, "display_name": "path_precision"})),
                "input_foreground": (["Black on White", "White on Black"], _hidden({"default": "Black on White", "display_name": "input_foreground"})),
                "turnpolicy": (["minority", "majority", "black", "white", "left", "right"], _hidden({"default": "minority", "display_name": "turnpolicy"})),
                "turdsize": ("INT", _hidden({"default": 2, "min": 0, "max": 4096, "step": 1, "display_name": "turdsize"})),
                "zero_sharp_corners": ("BOOLEAN", _hidden({"default": False, "display_name": "zero_sharp_corners"})),
                "opttolerance": ("FLOAT", _hidden({"default": 0.45, "min": 0.0, "max": 10.0, "step": 0.01, "display_name": "opttolerance"})),
                "optimize_curve": ("BOOLEAN", _hidden({"default": True, "display_name": "optimize_curve"})),
                "stroke_color": ("STRING", _hidden({"default": "#111111", "display_name": "stroke_color"})),
                "stroke_width": ("FLOAT", _hidden({"default": 1.0, "min": 0.1, "max": 64.0, "step": 0.1, "display_name": "stroke_width"})),
            },
            "optional": {
                "image": (IMAGE_INPUT_TYPE, {"display_name": "输入图像", "tooltip": "可选。支持 GJJ_BATCH_IMAGE 或 IMAGE；不连接时可用顶部 📂 按钮上传文件。"}),
                "mask": ("MASK", {"display_name": "透明遮罩", "tooltip": "可选。连接“加载图像”的遮罩输出，用来恢复 PNG 透明背景；白色遮罩会被视为透明区域。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **_kwargs):
        return True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        payload = {
            key: str(value)
            for key, value in kwargs.items()
            if key not in {"unique_id", "image"}
        }
        tensor = _ensure_bhwc(kwargs.get("image"))
        if tensor is not None:
            payload["image_shape"] = str(tuple(int(v) for v in tensor.shape))
            sample = tensor.detach().cpu().reshape(-1)[:: max(1, tensor.numel() // 4096)][:4096]
            payload["image_sum"] = f"{float(sample.sum()):.8f}"
        mask_tensor = _ensure_bhw_mask(kwargs.get("mask"))
        if mask_tensor is not None:
            payload["mask_shape"] = str(tuple(int(v) for v in mask_tensor.shape))
            mask_sample = mask_tensor.detach().cpu().reshape(-1)[:: max(1, mask_tensor.numel() // 4096)][:4096]
            payload["mask_sum"] = f"{float(mask_sample.sum()):.8f}"
        return json.dumps(payload, ensure_ascii=False, sort_keys=True)

    def convert(
        self,
        branch="彩色",
        max_size=384,
        color_count=16,
        threshold=128,
        background="",
        foreground="#111111",
        invert=False,
        min_alpha=64,
        filename_prefix="GJJ_ToSVG",
        save_directory="",
        file_references="[]",
        hierarchical="stacked",
        trace_mode="spline",
        filter_speckle=2,
        color_precision=7,
        layer_difference=16,
        corner_threshold=60,
        length_threshold=2.5,
        max_iterations=10,
        splice_threshold=45,
        path_precision=3,
        input_foreground="Black on White",
        turnpolicy="minority",
        turdsize=2,
        zero_sharp_corners=False,
        opttolerance=0.45,
        optimize_curve=True,
        stroke_color="#111111",
        stroke_width=1.0,
        image=None,
        mask=None,
        unique_id=None,
    ):
        branch = _choice(branch, BRANCHES, "彩色")
        images = _tensor_to_images(image)
        has_mask = _ensure_bhw_mask(mask) is not None
        if images:
            images = _apply_transparency_masks(images, mask)
        source_label = "输入图像"
        if not images:
            images = _load_reference_images(str(_first(file_references) or "[]"))
            source_label = "上传文件"
        if not images:
            message = "请连接 IMAGE/GJJ_BATCH_IMAGE，或点击 📂 上传一个或多个图片。"
            return {"ui": {"preview_text": (message,), "gjj_image_to_svg_zero": [{"status": message, "svg": "", "items": []}]}, "result": ("",)}

        svg_items: list[str] = []
        mode_value = _choice(trace_mode, ["spline", "polygon", "none"], "spline")
        speckle_value = _as_int(filter_speckle, 2, 0, 4096)
        precision_value = _as_int(path_precision, 3, 0, 6)
        color_precision_value = _as_int(color_precision, 7, 1, 8)
        effective_color_count = max(2, min(256, 2 ** color_precision_value))
        smooth_value = max(0.0, _as_float(length_threshold, 2.5, 0.0, 100.0), _as_float(opttolerance, 0.45, 0.0, 10.0) * 2.0)
        bw_invert = _as_bool(invert) or str(_first(input_foreground) or "").strip().lower() == "white on black"
        bw_speckle = max(speckle_value, _as_int(turdsize, 2, 0, 4096))
        for img in images:
            if branch == "黑白":
                svg_items.append(_bw_rect_svg(img, _as_int(max_size, 384, 16, 4096), _as_int(threshold, 128, 0, 255), foreground, background, bw_invert, mode_value, bw_speckle, precision_value, smooth_value))
            elif branch == "线稿":
                line_color = stroke_color if str(_first(stroke_color) or "").strip() else foreground
                svg_items.append(_line_svg(img, _as_int(max_size, 384, 16, 4096), _as_int(threshold, 128, 0, 255), line_color, background, _as_bool(invert), mode_value, speckle_value, precision_value, smooth_value))
            elif branch == "内嵌":
                svg_items.append(_color_rect_svg(img, _as_int(max_size, 384, 16, 4096), effective_color_count, background, _as_int(min_alpha, 8, 0, 255), mode_value, speckle_value, precision_value, smooth_value))
            else:
                svg_items.append(_color_rect_svg(img, _as_int(max_size, 384, 16, 4096), effective_color_count, background, _as_int(min_alpha, 8, 0, 255), mode_value, speckle_value, precision_value, smooth_value))

        combined = _combine_svgs(svg_items)
        saved = _save_svg_files(svg_items, combined, str(_first(save_directory) or ""), str(_first(filename_prefix) or "GJJ_ToSVG"))
        preview_item = _svg_to_preview_item(combined) if combined else {}
        size_kb = len(combined.encode("utf-8")) / 1024.0
        status = f"{source_label} {len(images)} 张；分支：{branch}；SVG {size_kb:.1f} KB"
        if source_label == "输入图像" and not has_mask:
            status += "；建议连接透明遮罩"
        if saved:
            status += f"；已保存 {len(saved)} 个文件"
        return {
            "ui": {
                "preview_text": (status,),
                "gjj_image_to_svg_zero": [
                    {
                        "status": status,
                        "svg": combined,
                        "items": [preview_item] if preview_item else [],
                        "saved": saved,
                        "branch": branch,
                        "count": len(images),
                    }
                ],
            },
            "result": (combined,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageToSVGZero}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧩 零依赖图片转SVG"}
