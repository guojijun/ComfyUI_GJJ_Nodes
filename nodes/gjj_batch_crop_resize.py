from __future__ import annotations

import math
from typing import Any

import torch
import torch.nn.functional as F


NODE_NAME = "GJJ_BatchCropResize"
MAX_GROUPS = 16
DIM_TYPE = "INT,STRING,FLOAT"
INPUT_MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
OUTPUT_MEDIA_TYPE = "IMAGE"
CUDA_HEADROOM = 0.82


def _as_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    if isinstance(value, torch.Tensor):
        if value.numel() <= 0:
            return default
        value = value.flatten()[0].item()
    text = str(value).strip()
    if not text:
        return default
    try:
        return int(round(float(text)))
    except Exception:
        return default


def _align(value: int, multiple: int) -> int:
    multiple = max(1, int(multiple or 1))
    value = max(1, int(value or 1))
    return max(multiple, (value // multiple) * multiple)


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value: Any) -> dict[str, Any] | None:
    if not hasattr(value, "get_components"):
        return None
    try:
        components = value.get_components()
    except Exception:
        return None
    if isinstance(components, dict):
        return components
    return {
        "images": _component_value(components, "images"),
        "audio": _component_value(components, "audio"),
        "frame_rate": _component_value(components, "frame_rate"),
    }


def _normalize_bhwc_tensor(tensor: torch.Tensor) -> torch.Tensor:
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"批次裁剪失败：图片/视频帧必须是 [B,H,W,C] 或 [B,C,H,W]，实际为 {tuple(tensor.shape)}。")
    if tensor.shape[-1] not in (1, 2, 3, 4) and tensor.shape[1] in (1, 2, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    if int(tensor.shape[-1]) <= 0:
        raise RuntimeError("批次裁剪失败：输入通道数无效。")
    tensor = tensor.detach()
    if not torch.is_floating_point(tensor) or tensor.dtype != torch.float32:
        tensor = tensor.float()
    if not tensor.is_contiguous():
        tensor = tensor.contiguous()
    return tensor


def _convert_channels_for_cat(tensor: torch.Tensor, target_channels: int) -> torch.Tensor:
    channels = int(tensor.shape[-1])
    if channels == target_channels:
        return tensor
    if target_channels == 4:
        if channels >= 4:
            return tensor[..., :4].contiguous()
        if channels == 3:
            alpha = torch.ones((*tensor.shape[:-1], 1), dtype=tensor.dtype, device=tensor.device)
            return torch.cat((tensor, alpha), dim=-1).contiguous()
        if channels == 2:
            rgb = tensor[..., :1].repeat(1, 1, 1, 3)
            alpha = tensor[..., 1:2].clamp(0.0, 1.0)
            return torch.cat((rgb, alpha), dim=-1).contiguous()
        if channels == 1:
            rgb = tensor.repeat(1, 1, 1, 3)
            alpha = torch.ones((*tensor.shape[:-1], 1), dtype=tensor.dtype, device=tensor.device)
            return torch.cat((rgb, alpha), dim=-1).contiguous()
    if target_channels == 3:
        if channels >= 3:
            return tensor[..., :3].contiguous()
        return tensor[..., :1].repeat(1, 1, 1, 3).contiguous()
    if channels > target_channels:
        return tensor[..., :target_channels].contiguous()
    pad = torch.zeros((*tensor.shape[:-1], target_channels - channels), dtype=tensor.dtype, device=tensor.device)
    return torch.cat((tensor, pad), dim=-1).contiguous()


def _cat_with_channel_compat(tensors: list[torch.Tensor]) -> torch.Tensor:
    if not tensors:
        raise RuntimeError("批次裁剪失败：没有可合并的图片帧。")
    channels = [int(tensor.shape[-1]) for tensor in tensors]
    if len(set(channels)) == 1:
        return torch.cat(tensors, dim=0)
    target_channels = 4 if 4 in channels else 3 if 3 in channels else max(channels)
    return torch.cat([_convert_channels_for_cat(tensor, target_channels) for tensor in tensors], dim=0)


def _coerce_to_bhwc(value: Any) -> torch.Tensor:
    source = value
    components = _video_components(value)
    if components is not None:
        source = components.get("images")
    elif hasattr(source, "images"):
        source = getattr(source, "images", None)

    tensor = None
    if isinstance(source, torch.Tensor):
        tensor = source
    elif isinstance(source, dict):
        for key in ("images", "frames", "samples"):
            candidate = source.get(key)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
            if isinstance(candidate, (list, tuple)) and candidate and all(isinstance(item, torch.Tensor) for item in candidate):
                tensor = _cat_with_channel_compat([_normalize_bhwc_tensor(item) for item in candidate])
                break
    elif isinstance(source, (list, tuple)) and source and all(isinstance(item, torch.Tensor) for item in source):
        tensor = _cat_with_channel_compat([_normalize_bhwc_tensor(item) for item in source])

    if tensor is None:
        raise RuntimeError(f"批次裁剪失败：输入不是有效的 GJJ_BATCH_IMAGE / IMAGE / VIDEO：{type(value).__name__}。")
    return _normalize_bhwc_tensor(tensor)


def _unwrap_single(value: Any) -> Any:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    return value


def _coerce_media_items(value: Any) -> list[torch.Tensor]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        items: list[torch.Tensor] = []
        for item in value:
            items.extend(_coerce_media_items(item))
        return items
    tensor = _coerce_to_bhwc(value)
    return [
        tensor[index : index + 1].contiguous()
        for index in range(int(tensor.shape[0]))
    ]


def _resize_center_crop(frames: torch.Tensor, target_w: int, target_h: int) -> torch.Tensor:
    device = _choose_processing_device(int(frames.numel()), int(frames.shape[0]) * target_w * target_h * int(frames.shape[-1]))
    frames = frames.to(device=device, non_blocking=True, copy=False)
    batch, src_h, src_w, channels = frames.shape
    scale = max(float(target_w) / float(max(1, src_w)), float(target_h) / float(max(1, src_h)))
    resize_w = max(target_w, int(math.ceil(src_w * scale)))
    resize_h = max(target_h, int(math.ceil(src_h * scale)))
    nchw = frames.movedim(-1, 1)
    resized = F.interpolate(nchw, size=(resize_h, resize_w), mode="bilinear", align_corners=False)
    left = max(0, (resize_w - target_w) // 2)
    top = max(0, (resize_h - target_h) // 2)
    cropped = resized[:, :, top:top + target_h, left:left + target_w]
    if int(cropped.shape[-2]) != target_h or int(cropped.shape[-1]) != target_w:
        cropped = F.interpolate(cropped, size=(target_h, target_w), mode="bilinear", align_corners=False)
    return cropped.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _choose_processing_device(input_numel: int, output_numel: int) -> torch.device:
    if not torch.cuda.is_available():
        return torch.device("cpu")
    try:
        free_bytes, _total_bytes = torch.cuda.mem_get_info()
        needed_bytes = max(1, int(input_numel) + int(output_numel)) * 4
        if needed_bytes < int(free_bytes * CUDA_HEADROOM):
            return torch.device("cuda")
    except Exception:
        pass
    return torch.device("cpu")


class GJJ_BatchCropResize:
    CATEGORY = "GJJ/图像"
    FUNCTION = "crop_resize"
    DESCRIPTION = "按批次裁剪图片或视频帧序列：多路统一目标尺寸，每一路独立按短边等比缩放，再居中裁剪长边。"
    SEARCH_ALIASES = ["批次裁剪", "视频帧裁剪", "center crop", "batch crop", "resize crop"]
    RETURN_TYPES = (DIM_TYPE, DIM_TYPE) + tuple(OUTPUT_MEDIA_TYPE for _ in range(MAX_GROUPS))
    RETURN_NAMES = ("宽度", "高度") + tuple(f"结果 {i}" for i in range(1, MAX_GROUPS + 1))
    INPUT_IS_LIST = True
    OUTPUT_TOOLTIPS = (
        "统一实际输出宽度。",
        "统一实际输出高度。",
    ) + tuple("该线路裁剪后的图片帧（IMAGE）。" for _ in range(MAX_GROUPS))

    GJJ_HELP = {
        "title": "批次尺寸裁剪",
        "description": "动态多路图片/视频帧裁剪；宽度/高度统一，多路媒体各自走线，按短边覆盖目标尺寸后居中裁剪长边。",
        "usage": [
            "宽度、高度是全局统一尺寸口，可连接 INT / STRING / FLOAT。",
            "宽度或高度不连接时，按第一路媒体第一帧原尺寸对齐到\"对齐倍数\"。",
            "只有图片/视频帧口会动态扩展；连接最后一路媒体后，前端会自动扩展下一路空媒体口。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "width": (DIM_TYPE, {
                "forceInput": True,
                "display_name": "宽度",
                "tooltip": "统一目标宽度；不连接时按第一路第一帧宽度对齐倍数。",
            }),
            "height": (DIM_TYPE, {
                "forceInput": True,
                "display_name": "高度",
                "tooltip": "统一目标高度；不连接时按第一路第一帧高度对齐倍数。",
            }),
        }
        for i in range(1, MAX_GROUPS + 1):
            optional[f"media_{i:02d}"] = (INPUT_MEDIA_TYPE, {
                "forceInput": True,
                "display_name": f"图片/视频帧 {i}",
                "tooltip": "支持 GJJ_BATCH_IMAGE、IMAGE 批次和官方 VIDEO。",
            })
        return {
            "required": {
                "align_multiple": (
                    "INT",
                    {
                        "default": 16,
                        "min": 1,
                        "max": 256,
                        "step": 1,
                        "display_name": "对齐倍数",
                        "tooltip": "输出宽高会向下对齐到该倍数；不连接宽高时也用它对齐第一帧尺寸。",
                    },
                ),
            },
            "optional": optional,
        }

    def crop_resize(self, align_multiple: int = 16, **kwargs):
        multiple = max(1, _as_int(_unwrap_single(align_multiple), 16))
        media_indices = [
            index
            for index in range(1, MAX_GROUPS + 1)
            if _coerce_media_items(kwargs.get(f"media_{index:02d}", None))
        ]

        if not media_indices:
            return (None, None) + tuple(None for _ in range(MAX_GROUPS))

        first_index = min(media_indices)
        first_items = _coerce_media_items(kwargs.get(f"media_{first_index:02d}", None))
        first_frames = first_items[0]
        src_h = int(first_frames.shape[1])
        src_w = int(first_frames.shape[2])
        width = _as_int(_unwrap_single(kwargs.get("width", None)), 0)
        height = _as_int(_unwrap_single(kwargs.get("height", None)), 0)
        target_w = _align(width if width > 0 else src_w, multiple)
        target_h = _align(height if height > 0 else src_h, multiple)

        outputs: list[Any] = [target_w, target_h]
        for index in range(1, MAX_GROUPS + 1):
            if index not in media_indices:
                outputs.append(None)
                continue
            items = (
                first_items
                if index == first_index
                else _coerce_media_items(kwargs.get(f"media_{index:02d}", None))
            )
            cropped_items = [
                _resize_center_crop(item, target_w, target_h) for item in items
            ]
            outputs.append(_cat_with_channel_compat(cropped_items))
        return tuple(outputs)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_BatchCropResize}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ✂️ 批次尺寸裁剪"}
