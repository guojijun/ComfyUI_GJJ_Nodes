from __future__ import annotations

import base64
import json
from io import BytesIO
from typing import Any

import numpy as np
import torch
from PIL import Image


NODE_NAME = "GJJ_SplineEditor"

SAMPLING_METHODS = ["time", "path", "controlpoints", "speed"]
INTERPOLATIONS = [
    "cardinal",
    "monotone",
    "basis",
    "linear",
    "step-before",
    "step-after",
    "bezier",
]
FLOAT_OUTPUT_TYPES = ["list", "tensor", "pandas series"]


def _default_coordinates(width: int, height: int) -> list[list[dict[str, float]]]:
    return [[
        {"x": 0.0, "y": float(height)},
        {"x": float(width) * 0.4, "y": float(height) * 0.5},
        {"x": float(width), "y": 0.0},
    ]]


def _safe_json_loads(value: Any) -> Any:
    if isinstance(value, (list, dict)):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception as exc:
        raise RuntimeError(f"曲线坐标 JSON 解析失败：{exc}") from exc


def _extract_points_from_store(points_store: Any) -> list[list[dict[str, Any]]] | None:
    parsed = _safe_json_loads(points_store)
    if not parsed:
        return None
    if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict) and "points" in parsed[0]:
        return [item.get("points") or [] for item in parsed if isinstance(item, dict)]
    return _normalize_coordinate_sets(parsed)


def _normalize_coordinate_sets(data: Any) -> list[list[dict[str, Any]]] | None:
    if not data:
        return None
    if isinstance(data, dict) and "x" in data and "y" in data:
        return [[data]]
    if isinstance(data, list):
        if not data:
            return None
        if isinstance(data[0], dict) and "x" in data[0] and "y" in data[0]:
            return [data]
        if isinstance(data[0], list):
            result: list[list[dict[str, Any]]] = []
            for item in data:
                if isinstance(item, list):
                    result.append([coord for coord in item if isinstance(coord, dict)])
            return result or None
    return None


def _coerce_coordinate_sets(
    coordinates: Any,
    points_store: Any,
    width: int,
    height: int,
) -> list[list[dict[str, int]]]:
    parsed = _safe_json_loads(coordinates)
    sets = _normalize_coordinate_sets(parsed)
    if sets is None:
        sets = _extract_points_from_store(points_store)
    if sets is None:
        sets = _default_coordinates(width, height)

    result: list[list[dict[str, int]]] = []
    for coord_set in sets:
        cleaned: list[dict[str, int]] = []
        for coord in coord_set:
            try:
                x = int(round(float(coord.get("x", 0))))
                y = int(round(float(coord.get("y", 0))))
            except Exception:
                continue
            cleaned.append({
                "x": max(0, min(width, x)),
                "y": max(0, min(height, y)),
            })
        if cleaned:
            result.append(cleaned)
    return result or _default_coordinates(width, height)


def _normalize_values(
    coordinate_sets: list[list[dict[str, int]]],
    mask_width: int,
    mask_height: int,
    min_value: float,
    max_value: float,
) -> tuple[list[list[dict[str, float]]], list[list[float]], list[float]]:
    all_normalized: list[list[dict[str, float]]] = []
    per_spline_y_values: list[list[float]] = []
    all_y_values: list[float] = []
    scale = float(max_value) - float(min_value)

    for coord_set in coordinate_sets:
        normalized: list[dict[str, float]] = []
        y_values: list[float] = []
        for coord in coord_set:
            x = float(coord["x"])
            y = float(coord["y"])
            norm_x = (1.0 - (x / max(1, mask_width))) * scale + float(min_value)
            norm_y = (1.0 - (y / max(1, mask_height))) * scale + float(min_value)
            normalized.append({"x": norm_x, "y": norm_y})
            y_values.append(norm_y)
        all_normalized.append(normalized)
        per_spline_y_values.append(y_values)
        all_y_values.extend(y_values)

    return all_normalized, per_spline_y_values, all_y_values


def _build_float_output(values: list[float], repeat_output: int, output_type: str) -> Any:
    repeated = values * max(1, int(repeat_output))
    if output_type == "tensor":
        return torch.tensor(repeated, dtype=torch.float32)
    if output_type == "pandas series":
        try:
            import pandas as pd  # type: ignore
            return pd.Series(repeated)
        except Exception:
            return repeated
    return repeated


def _build_mask_batch(values: list[float], width: int, height: int, repeat_output: int) -> torch.Tensor:
    if not values:
        values = [0.0]
    masks = [torch.full((height, width), float(value), dtype=torch.float32) for value in values]
    result = torch.stack(masks, dim=0)
    return result.repeat(max(1, int(repeat_output)), 1, 1).clamp(-10000.0, 10000.0)


def _tensor_image_to_base64(image: torch.Tensor | None) -> str | None:
    if image is None:
        return None
    try:
        tensor = image[0] if getattr(image, "ndim", 0) == 4 else image
        array = tensor.detach().cpu().float().clamp(0.0, 1.0).numpy()
        if array.ndim != 3:
            return None
        if array.shape[-1] > 3:
            array = array[..., :3]
        if array.shape[-1] == 1:
            array = np.repeat(array, 3, axis=-1)
        pil_image = Image.fromarray((array * 255.0).astype(np.uint8), mode="RGB")
        buffer = BytesIO()
        pil_image.save(buffer, format="JPEG", quality=82)
        return base64.b64encode(buffer.getvalue()).decode("utf-8")
    except Exception as exc:
        print(f"[GJJ_SplineEditor] 背景图编码失败：{exc}")
        return None


class GJJ_SplineEditor:
    CATEGORY = "GJJ/逻辑控制"
    FUNCTION = "splinedata"
    DESCRIPTION = (
        "零依赖样条曲线编辑器。可在节点面板绘制一条或多条曲线，输出采样坐标、"
        "按 Y 值生成的遮罩批次，以及可用于权重调度的浮点序列。"
    )
    SEARCH_ALIASES = ["spline", "curve", "schedule", "mask batch", "曲线", "样条", "调度", "权重"]

    RETURN_TYPES = ("MASK", "STRING", "FLOAT", "INT", "STRING")
    RETURN_NAMES = ("遮罩批次", "坐标JSON", "浮点序列", "单曲线数量", "归一化JSON")
    OUTPUT_TOOLTIPS = (
        "按第一条曲线的采样 Y 值生成的灰度遮罩批次。",
        "当前采样坐标 JSON；单曲线输出坐标列表，多曲线输出嵌套列表。",
        "所有曲线采样 Y 值映射到最小值/最大值后的序列。",
        "第一条曲线的采样点数量。",
        "所有采样点映射后的归一化坐标 JSON。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "points_store": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "hidden": True,
                        "display": "hidden",
                        "display_name": "内部控制点",
                        "tooltip": "前端曲线编辑器保存的控制点数据，请不要手动修改。",
                    },
                ),
                "coordinates": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "hidden": True,
                        "display": "hidden",
                        "display_name": "内部采样坐标",
                        "tooltip": "前端曲线编辑器生成的采样坐标，请不要手动修改。",
                    },
                ),
                "mask_width": (
                    "INT",
                    {
                        "default": 512,
                        "min": 8,
                        "max": 4096,
                        "step": 8,
                        "display_name": "画布宽度",
                        "tooltip": "曲线坐标空间和输出遮罩的宽度。",
                    },
                ),
                "mask_height": (
                    "INT",
                    {
                        "default": 512,
                        "min": 8,
                        "max": 4096,
                        "step": 8,
                        "display_name": "画布高度",
                        "tooltip": "曲线坐标空间和输出遮罩的高度。",
                    },
                ),
                "points_to_sample": (
                    "INT",
                    {
                        "default": 16,
                        "min": 2,
                        "max": 1000,
                        "step": 1,
                        "display_name": "采样点数",
                        "tooltip": "从曲线中采样多少个点。控制点模式下会直接使用控制点。",
                    },
                ),
                "sampling_method": (
                    SAMPLING_METHODS,
                    {
                        "default": "time",
                        "display_name": "采样方式",
                        "tooltip": "time 按 X 轴均分，path 按路径长度均分，controlpoints 直接输出控制点，speed 按控制点间速度权重采样。",
                    },
                ),
                "interpolation": (
                    INTERPOLATIONS,
                    {
                        "default": "cardinal",
                        "display_name": "插值方式",
                        "tooltip": "曲线绘制和采样使用的插值算法。",
                    },
                ),
                "tension": (
                    "FLOAT",
                    {
                        "default": 0.5,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "曲线张力",
                        "tooltip": "cardinal 插值的张力参数。",
                    },
                ),
                "repeat_output": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 4096,
                        "step": 1,
                        "display_name": "重复输出",
                        "tooltip": "遮罩批次和浮点序列的重复次数。",
                    },
                ),
                "float_output_type": (
                    FLOAT_OUTPUT_TYPES,
                    {
                        "default": "list",
                        "display_name": "浮点输出类型",
                        "tooltip": "默认输出 Python list；tensor 输出 torch.Tensor；pandas series 仅在环境已有 pandas 时生效，否则回退为 list。",
                    },
                ),
            },
            "optional": {
                "min_value": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": -10000.0,
                        "max": 10000.0,
                        "step": 0.01,
                        "display_name": "最小值",
                        "tooltip": "曲线底部映射到的浮点值。",
                    },
                ),
                "max_value": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": -10000.0,
                        "max": 10000.0,
                        "step": 0.01,
                        "display_name": "最大值",
                        "tooltip": "曲线顶部映射到的浮点值。",
                    },
                ),
                "bg_image": (
                    "IMAGE",
                    {
                        "display_name": "背景图像",
                        "tooltip": "可选参考图，执行后会显示到曲线编辑器背景中。",
                    },
                ),
            },
        }

    def splinedata(
        self,
        points_store: str,
        coordinates: str,
        mask_width: int,
        mask_height: int,
        points_to_sample: int,
        sampling_method: str,
        interpolation: str,
        tension: float,
        repeat_output: int,
        float_output_type: str,
        min_value: float = 0.0,
        max_value: float = 1.0,
        bg_image: torch.Tensor | None = None,
    ):
        del points_to_sample, sampling_method, interpolation, tension

        width = max(8, int(mask_width))
        height = max(8, int(mask_height))
        repeat = max(1, int(repeat_output))
        coordinate_sets = _coerce_coordinate_sets(coordinates, points_store, width, height)
        normalized_sets, per_spline_y_values, all_y_values = _normalize_values(
            coordinate_sets,
            width,
            height,
            float(min_value),
            float(max_value),
        )

        first_values = per_spline_y_values[0] if per_spline_y_values else []
        masks_out = _build_mask_batch(first_values, width, height, repeat)
        out_floats = _build_float_output(all_y_values, repeat, str(float_output_type or "list"))
        single_spline_count = len(coordinate_sets[0]) if coordinate_sets else 0
        coord_payload: Any = coordinate_sets if len(coordinate_sets) > 1 else coordinate_sets[0]

        result = (
            masks_out,
            json.dumps(coord_payload, ensure_ascii=False),
            out_floats,
            int(single_spline_count),
            json.dumps(normalized_sets, ensure_ascii=False),
        )

        ui: dict[str, Any] = {}
        bg_base64 = _tensor_image_to_base64(bg_image)
        if bg_base64:
            ui["bg_image"] = [bg_base64]
        if float_output_type == "pandas series" and out_floats.__class__.__name__ != "Series":
            ui["text"] = ("当前环境没有 pandas，浮点输出已回退为 list。",)

        if ui:
            return {"ui": ui, "result": result}
        return result


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SplineEditor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📈 样条曲线编辑器"}
