from __future__ import annotations

import numpy as np
import torch

try:
    import cv2
except Exception:
    cv2 = None


NODE_NAME = "GJJ_CannyEdge"
MAX_RESOLUTION = 16384


def _as_int(value, default: int, min_value: int, max_value: int) -> int:
    try:
        result = int(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _hwc3(image: np.ndarray) -> np.ndarray:
    if image.dtype != np.uint8:
        image = np.clip(image, 0, 255).astype(np.uint8)
    if image.ndim == 2:
        image = image[:, :, None]
    if image.ndim != 3:
        raise RuntimeError(f"Canny 边缘检测失败：图像维度应为 HWC，实际为 {image.shape}。")

    channels = image.shape[2]
    if channels == 3:
        return image
    if channels == 1:
        return np.repeat(image, 3, axis=2)
    if channels == 4:
        color = image[:, :, 0:3].astype(np.float32)
        alpha = image[:, :, 3:4].astype(np.float32) / 255.0
        return np.clip(color * alpha + 255.0 * (1.0 - alpha), 0, 255).astype(np.uint8)
    raise RuntimeError(f"Canny 边缘检测失败：不支持 {channels} 通道图像。")


def _pad64(value: int) -> int:
    return int(np.ceil(float(value) / 64.0) * 64 - value)


def _resize_image_with_pad(image: np.ndarray, resolution: int) -> tuple[np.ndarray, callable]:
    image = _hwc3(image)
    raw_h, raw_w, _ = image.shape
    if resolution <= 0:
        return image, lambda x: x

    scale = float(resolution) / float(min(raw_h, raw_w))
    target_h = int(np.round(float(raw_h) * scale))
    target_w = int(np.round(float(raw_w) * scale))
    interpolation = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
    resized = cv2.resize(image, (target_w, target_h), interpolation=interpolation)

    pad_h = _pad64(target_h)
    pad_w = _pad64(target_w)
    padded = np.pad(resized, [[0, pad_h], [0, pad_w], [0, 0]], mode="edge")

    def remove_pad(x):
        return np.ascontiguousarray(x[:target_h, :target_w, ...].copy())

    return np.ascontiguousarray(padded.copy()), remove_pad


def _detect_canny(image: np.ndarray, low_threshold: int, high_threshold: int, resolution: int) -> np.ndarray:
    if cv2 is None:
        raise RuntimeError("Canny 边缘检测失败：当前 Python 环境缺少 OpenCV(cv2)。")

    resized, remove_pad = _resize_image_with_pad(image, resolution)
    edge = cv2.Canny(resized, low_threshold, high_threshold)
    edge = _hwc3(remove_pad(edge))
    return edge


class GJJ_CannyEdge:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "图像",
                        "tooltip": "输入需要提取 Canny 边缘的图像，支持批量。",
                    },
                ),
                "low_threshold": (
                    "INT",
                    {
                        "default": 100,
                        "min": 0,
                        "max": 255,
                        "step": 1,
                        "display_name": "低阈值",
                        "tooltip": "Canny 低阈值，越低越容易保留弱边缘。",
                    },
                ),
                "high_threshold": (
                    "INT",
                    {
                        "default": 200,
                        "min": 0,
                        "max": 255,
                        "step": 1,
                        "display_name": "高阈值",
                        "tooltip": "Canny 高阈值，越高越只保留强边缘。",
                    },
                ),
                "resolution": (
                    "INT",
                    {
                        "default": 512,
                        "min": 64,
                        "max": MAX_RESOLUTION,
                        "step": 64,
                        "display_name": "检测分辨率",
                        "tooltip": "先把图像短边缩放到该分辨率后检测边缘；输出尺寸会随该检测分辨率变化。",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    OUTPUT_TOOLTIPS = ("Canny 边缘图，三通道 IMAGE。",)
    FUNCTION = "execute"
    CATEGORY = "GJJ/图像处理/预处理"
    DESCRIPTION = "零依赖 Canny Edge：不导入 comfyui_controlnet_aux，直接使用当前环境 OpenCV 提取 Canny 边缘。"
    GJJ_HELP = {
        "title": "Canny 边缘",
        "description": "等价迁移 ControlNet Aux 的 Canny Edge 预处理器；使用 OpenCV Canny，保留低阈值、高阈值和检测分辨率。",
        "usage": [
            "输入图像，设置低阈值和高阈值。",
            "检测分辨率会把短边缩放到指定值，和 ControlNet Aux 原节点行为一致。",
            "输出为三通道边缘图，可接 ControlNet 或其它图像节点。",
        ],
    }

    def execute(self, image, low_threshold=100, high_threshold=200, resolution=512):
        low = _as_int(low_threshold, 100, 0, 255)
        high = _as_int(high_threshold, 200, 0, 255)
        detect_resolution = _as_int(resolution, 512, 64, MAX_RESOLUTION)

        if high < low:
            low, high = high, low

        if not torch.is_tensor(image) or image.ndim != 4:
            raise RuntimeError("Canny 边缘检测失败：输入图像必须是 [B,H,W,C] 的 IMAGE tensor。")

        results = []
        for frame in image:
            np_image = np.asarray(frame.detach().cpu().clamp(0, 1).numpy() * 255.0, dtype=np.uint8)
            edge = _detect_canny(np_image, low, high, detect_resolution)
            results.append(torch.from_numpy(edge.astype(np.float32) / 255.0))

        return (torch.stack(results, dim=0),)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_CannyEdge}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🖊️ Canny边缘"}
