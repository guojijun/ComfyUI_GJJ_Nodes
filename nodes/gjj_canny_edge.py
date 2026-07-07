from __future__ import annotations

import base64
import importlib.util
import struct
from typing import Any

import torch
import torch.nn.functional as F

try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        print_dependency_model_report,
        send_dependency_model_notice,
    )
    from .common_utils.progress import send_node_progress
except ImportError:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        print_dependency_model_report,
        send_dependency_model_notice,
    )
    from common_utils.progress import send_node_progress


NODE_NAME = "GJJ_CannyEdge"
NODE_DISPLAY_NAME = "GJJ · 🖊️ Canny边缘检测"
_DESCRIPTION_INTRO = "单节点 Canny 边缘检测：有 OpenCV 时自动走快速 Canny；没有 OpenCV 时走 PyTorch 原生零依赖实现，并支持实时进度与间隔预览。"
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
DEFAULT_LOW_THRESHOLD = 0.18
DEFAULT_HIGH_THRESHOLD = 0.36
_cv2 = None


def _missing_optional_dependency_specs() -> list[dict[str, str]]:
    if importlib.util.find_spec("cv2") is not None:
        return []
    return [
        {
            "module_name": "cv2",
            "package_name": "opencv-python",
            "display_name": "OpenCV (cv2)",
            "description": "可选加速依赖；安装后自动使用 OpenCV Canny，缺失时仍使用 PyTorch 原生实现。",
        }
    ]


_ENVIRONMENT_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    optional_dependencies=_missing_optional_dependency_specs(),
    optional_install_packages=["opencv-python"] if _missing_optional_dependency_specs() else [],
    description="OpenCV 是可选加速依赖；不安装也可以正常输出边缘图。",
)
_OPTIONAL_DEPENDENCIES_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("optional_dependencies_available", True))
_MISSING_OPTIONAL_DEPENDENCIES = list(_ENVIRONMENT_REPORT.get("optional_dependencies", []) or [])
if _MISSING_OPTIONAL_DEPENDENCIES:
    print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ Canny 可选加速依赖缺失")


def _load_cv2_optional():
    global _cv2
    if _cv2 is not None:
        return _cv2
    if importlib.util.find_spec("cv2") is None:
        return None
    try:
        import cv2

        _cv2 = cv2
        return _cv2
    except Exception:
        return None


def _as_float(value: Any, default: float, min_value: float, max_value: float) -> float:
    try:
        result = float(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _as_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        result = int(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _coerce_media_to_image_batch(value: Any) -> torch.Tensor:
    if value is None:
        raise RuntimeError("Canny边缘检测失败：请连接 GJJ_BATCH_IMAGE、IMAGE 或 VIDEO 输入。")

    source = value
    if hasattr(source, "get_components"):
        try:
            components = source.get_components()
        except Exception as exc:
            raise RuntimeError(f"Canny边缘检测失败：输入可识别为 VIDEO，但读取视频帧失败：{exc}") from exc
        source = _component_value(components, "images")
        if source is None:
            raise RuntimeError("Canny边缘检测失败：输入 VIDEO 没有解析出可用图片帧。")
    elif hasattr(source, "images"):
        source = getattr(source, "images", None)

    if isinstance(source, torch.Tensor):
        tensor = source
    elif isinstance(source, dict):
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = source.get(key)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
    elif isinstance(source, (list, tuple)) and source and all(isinstance(item, torch.Tensor) for item in source):
        tensor = torch.cat([item if item.ndim == 4 else item.unsqueeze(0) for item in source], dim=0)
    else:
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = getattr(source, key, None)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break

    if tensor is None:
        raise RuntimeError(f"Canny边缘检测失败：输入不是有效的 GJJ_BATCH_IMAGE / IMAGE / VIDEO：{type(value).__name__}。")
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"Canny边缘检测失败：输入图片/视频帧必须是 [B,H,W,C] 或 [B,C,H,W]，实际为 {tuple(tensor.shape)}。")
    if tensor.shape[-1] not in (1, 3, 4) and tensor.shape[1] in (1, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 4:
        rgb = tensor[..., :3]
        alpha = tensor[..., 3:4].clamp(0.0, 1.0)
        tensor = rgb * alpha
    elif channels > 4:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"Canny边缘检测失败：输入图片/视频帧通道数无效：{tuple(tensor.shape)}。")
    return tensor.detach().float().clamp(0.0, 1.0).contiguous()


def _image_to_gray(image: torch.Tensor) -> torch.Tensor:
    image = image.clamp(0.0, 1.0).to(dtype=torch.float32)
    if image.ndim != 3:
        raise RuntimeError(f"Canny边缘检测失败：单张图像应为 [H,W,C]，实际为 {tuple(image.shape)}。")
    channels = int(image.shape[-1])
    if channels == 1:
        gray = image[..., 0]
    elif channels >= 3:
        rgb = image[..., :3]
        weights = torch.tensor([0.299, 0.587, 0.114], dtype=rgb.dtype, device=rgb.device)
        gray = (rgb * weights).sum(dim=-1)
    else:
        raise RuntimeError(f"Canny边缘检测失败：不支持 {channels} 通道图像。")
    return gray[None, None, :, :]


def _gaussian_blur(gray: torch.Tensor) -> torch.Tensor:
    kernel = torch.tensor(
        [
            [1, 4, 6, 4, 1],
            [4, 16, 24, 16, 4],
            [6, 24, 36, 24, 6],
            [4, 16, 24, 16, 4],
            [1, 4, 6, 4, 1],
        ],
        dtype=gray.dtype,
        device=gray.device,
    )
    kernel = (kernel / kernel.sum()).view(1, 1, 5, 5)
    return F.conv2d(F.pad(gray, (2, 2, 2, 2), mode="reflect"), kernel)


def _sobel_edges(gray: torch.Tensor) -> torch.Tensor:
    sobel_x = torch.tensor(
        [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]],
        dtype=gray.dtype,
        device=gray.device,
    ).view(1, 1, 3, 3)
    sobel_y = torch.tensor(
        [[-1, -2, -1], [0, 0, 0], [1, 2, 1]],
        dtype=gray.dtype,
        device=gray.device,
    ).view(1, 1, 3, 3)
    padded = F.pad(gray, (1, 1, 1, 1), mode="reflect")
    gx = F.conv2d(padded, sobel_x)
    gy = F.conv2d(padded, sobel_y)
    magnitude = torch.sqrt(gx * gx + gy * gy + 1e-12)
    flat = magnitude.flatten()
    if flat.numel() >= 16:
        maximum = torch.quantile(flat, 0.985).clamp_min(1e-6)
    else:
        maximum = torch.amax(magnitude).clamp_min(1e-6)
    return magnitude / maximum


def _hysteresis(edge: torch.Tensor, low: float, high: float) -> torch.Tensor:
    if high < low:
        low, high = high, low
    strong = edge >= high
    weak = edge >= low
    connected = strong
    for _ in range(4):
        grown = F.max_pool2d(connected.to(edge.dtype), kernel_size=3, stride=1, padding=1) > 0
        next_connected = weak & grown
        if torch.equal(next_connected, connected):
            break
        connected = next_connected
    return connected.to(edge.dtype)


def _detect_edges(image: torch.Tensor, low: float, high: float) -> torch.Tensor:
    gray = _image_to_gray(image)
    blurred = _gaussian_blur(gray)
    magnitude = _sobel_edges(blurred)
    local_max = F.max_pool2d(magnitude, kernel_size=3, stride=1, padding=1)
    thinned = torch.where(magnitude >= local_max * 0.995, magnitude, torch.zeros_like(magnitude))
    edge = _hysteresis(thinned, low, high)[0, 0]
    return edge[:, :, None].repeat(1, 1, 3).contiguous()


def _detect_edges_cv2(image: torch.Tensor, low: float, high: float) -> torch.Tensor:
    cv2 = _load_cv2_optional()
    if cv2 is None:
        return _detect_edges(image, low, high)
    if high < low:
        low, high = high, low
    data = (image.detach().float().clamp(0.0, 1.0).cpu().numpy() * 255.0).round().astype("uint8")
    if data.ndim != 3:
        raise RuntimeError(f"Canny边缘检测失败：单张图像应为 [H,W,C]，实际为 {tuple(data.shape)}。")
    if data.shape[-1] == 1:
        gray = data[:, :, 0]
    else:
        gray = cv2.cvtColor(data[:, :, :3], cv2.COLOR_RGB2GRAY)
    edge = cv2.Canny(gray, int(round(low * 255.0)), int(round(high * 255.0)))
    edge_tensor = torch.from_numpy(edge.astype("float32") / 255.0)
    return edge_tensor[:, :, None].repeat(1, 1, 3).contiguous()


def _preview_data_url(image: torch.Tensor, max_size: int = 360) -> str:
    preview = image.detach().float().clamp(0.0, 1.0)
    if preview.ndim == 2:
        preview = preview[:, :, None].repeat(1, 1, 3)
    preview = preview[..., :3]
    height, width = int(preview.shape[0]), int(preview.shape[1])
    scale = min(1.0, float(max_size) / float(max(height, width, 1)))
    if scale < 1.0:
        new_h = max(1, int(round(height * scale)))
        new_w = max(1, int(round(width * scale)))
        preview = F.interpolate(
            preview.permute(2, 0, 1)[None],
            size=(new_h, new_w),
            mode="bilinear",
            align_corners=False,
        )[0].permute(1, 2, 0)
        height, width = new_h, new_w
    data = (preview.cpu() * 255.0).round().byte().numpy()

    row_stride = ((width * 3 + 3) // 4) * 4
    pixel_size = row_stride * height
    file_size = 14 + 40 + pixel_size
    header = bytearray()
    header += b"BM"
    header += struct.pack("<IHHI", file_size, 0, 0, 54)
    header += struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, pixel_size, 2835, 2835, 0, 0)
    rows = bytearray()
    pad = b"\x00" * (row_stride - width * 3)
    for y in range(height - 1, -1, -1):
        row = data[y, :, :3][:, ::-1].tobytes()
        rows += row + pad
    return "data:image/bmp;base64," + base64.b64encode(bytes(header) + bytes(rows)).decode("ascii")


class GJJ_CannyEdge:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    MEDIA_INPUT_TYPE,
                    {
                        "display_name": "输入媒体",
                        "tooltip": "输入需要提取 Canny 风格边缘的媒体。支持 GJJ_BATCH_IMAGE、普通 IMAGE batch 和官方 VIDEO；接 VIDEO 时会自动读取视频帧。",
                    },
                ),
                "low_threshold": (
                    "FLOAT",
                    {
                        "default": DEFAULT_LOW_THRESHOLD,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "round": 0.01,
                        "display_name": "低阈值",
                        "tooltip": "统一阈值 0.0-1.0；OpenCV 路径会映射到 0-255，原生路径使用同等归一化强度。越低越容易保留弱边缘。",
                    },
                ),
                "high_threshold": (
                    "FLOAT",
                    {
                        "default": DEFAULT_HIGH_THRESHOLD,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "round": 0.01,
                        "display_name": "高阈值",
                        "tooltip": "统一阈值 0.0-1.0；OpenCV 路径会映射到 0-255，原生路径使用同等归一化强度。越高越只保留强边缘。",
                    },
                ),
                "preview_every": (
                    "INT",
                    {
                        "default": 4,
                        "min": 1,
                        "max": 256,
                        "step": 1,
                        "display_name": "预览间隔",
                        "tooltip": "批量处理时每隔多少张在节点面板刷新一次实时边缘预览。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    OUTPUT_TOOLTIPS = ("零依赖 Canny 风格边缘图，三通道 IMAGE。",)
    FUNCTION = "execute"
    CATEGORY = "GJJ/图像"
    DESCRIPTION = _DESCRIPTION_INTRO
    GJJ_HELP = {
        "title": "Canny 边缘检测",
        "description": _DESCRIPTION_INTRO,
        "usage": [
            "输入 GJJ_BATCH_IMAGE、IMAGE 或 VIDEO，调低阈值和高阈值。",
            "普通 IMAGE 会直接处理；GJJ_BATCH_IMAGE 会提取其中的图片队列；官方 VIDEO 会自动读取视频帧并输出边缘帧 IMAGE。",
            "低阈值和高阈值统一使用 0.0-1.0；OpenCV 路径映射到 0-255，原生路径使用稳健归一化后的同等强度。",
            "默认 0.18 / 0.36 更适合人物、街景和普通生成图，不容易像 0.4 / 0.8 那样丢掉大量轮廓。",
            "检测到 OpenCV(cv2) 时自动使用快速路径；没有 OpenCV 时使用 PyTorch 原生路径。",
            "预览间隔用于批量图像：例如 4 表示第 1、4、8... 张以及最后一张会刷新面板预览。",
        ],
        "notice": _ENVIRONMENT_REPORT.get("help_message", "") if _MISSING_OPTIONAL_DEPENDENCIES else "",
        "install_cmd": "",
        "optional_install_cmd": _ENVIRONMENT_REPORT.get("optional_install_cmd", ""),
        "copy_text": _ENVIRONMENT_REPORT.get("copy_text", ""),
        "copy_label": _ENVIRONMENT_REPORT.get("copy_label", ""),
        "warning_message": _ENVIRONMENT_REPORT.get("warning_message", ""),
        "notice_level": _ENVIRONMENT_REPORT.get("notice_level", "ok"),
    }

    def execute(self, image, low_threshold=DEFAULT_LOW_THRESHOLD, high_threshold=DEFAULT_HIGH_THRESHOLD, preview_every=4, unique_id=None):
        image = _coerce_media_to_image_batch(image)

        low = _as_float(low_threshold, DEFAULT_LOW_THRESHOLD, 0.0, 1.0)
        high = _as_float(high_threshold, DEFAULT_HIGH_THRESHOLD, 0.0, 1.0)
        interval = _as_int(preview_every, 4, 1, 256)
        total = int(image.shape[0])
        results = []
        cv2_available = _load_cv2_optional() is not None
        method = "OpenCV快速路径" if cv2_available else "PyTorch原生路径"

        if _MISSING_OPTIONAL_DEPENDENCIES:
            send_dependency_model_notice(_ENVIRONMENT_REPORT, unique_id=unique_id)
        send_node_progress(unique_id, f"Canny边缘检测：准备处理 {total} 张图像，当前使用 {method}...", 0.0)
        for index, frame in enumerate(image, start=1):
            edge = _detect_edges_cv2(frame, low, high) if cv2_available else _detect_edges(frame, low, high)
            results.append(edge.cpu())
            progress = index / max(1, total)
            should_preview = index == 1 or index == total or index % interval == 0
            preview = _preview_data_url(edge) if should_preview else None
            send_node_progress(
                unique_id,
                f"Canny边缘检测：已处理 {index}/{total} 张（{method}）",
                progress,
                preview_data_url=preview,
                preview_index=index,
                preview_total=total,
            )

        output = torch.stack(results, dim=0).to(dtype=torch.float32)
        send_node_progress(unique_id, f"Canny边缘检测完成：共 {total} 张", 1.0)
        return (output,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_CannyEdge}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
