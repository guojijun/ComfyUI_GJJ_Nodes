from __future__ import annotations

from typing import Any

import torch
import torch.nn.functional as F

try:
    import comfy.model_management as model_management
except Exception:
    model_management = None

try:
    from comfy.utils import ProgressBar
except Exception:
    ProgressBar = None


NODE_NAME = "GJJ_ImageConcanate"
MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,MASK,VIDEO"
IMAGE_PREFIX = "media_"
DIRECTIONS = ("right", "down", "left", "up")
DIRECTION_LABELS = {
    "up": "向上",
    "down": "向下",
    "left": "向左",
    "right": "向右",
}
BLACK_PLACEHOLDER_EPSILON = 1e-6


class FlexibleMediaInputs(dict):
    def __getitem__(self, key):
        if str(key or "").startswith(IMAGE_PREFIX):
            return (
                MEDIA_TYPE,
                {
                    "display_name": "媒体输入",
                    "tooltip": "连接 GJJ_BATCH_IMAGE、IMAGE、MASK 或 VIDEO；连接后会自动扩展下一个输入口。",
                },
            )
        return super().__getitem__(key)

    def __contains__(self, key):
        return str(key or "").startswith(IMAGE_PREFIX) or super().__contains__(key)


def _input_index(name: str) -> int:
    text = str(name or "")
    if not text.startswith(IMAGE_PREFIX):
        return 999999
    try:
        return int(text[len(IMAGE_PREFIX):])
    except Exception:
        return 999999


def _extract_video_frames(value: Any) -> Any:
    if isinstance(value, dict):
        for key in ("frames", "images", "image", "samples"):
            item = value.get(key)
            if item is not None:
                return item
    for attr in ("frames", "images", "image", "samples"):
        if hasattr(value, attr):
            item = getattr(value, attr)
            if item is not None:
                return item
    return value


def _as_media_tensor(value: Any) -> torch.Tensor | None:
    value = _extract_video_frames(value)
    if isinstance(value, (tuple, list)) and value:
        value = value[0]
    if not torch.is_tensor(value):
        return None
    tensor = value
    if tensor.dim() == 2:
        tensor = tensor.unsqueeze(0)
    if tensor.dim() not in (3, 4):
        return None
    return tensor.float().clamp(0.0, 1.0)


def _is_black_placeholder(tensor: torch.Tensor) -> bool:
    if tensor.numel() == 0:
        return True
    if not torch.is_floating_point(tensor):
        tensor = tensor.float()
    try:
        max_value = float(tensor.detach().abs().amax().cpu())
    except Exception:
        return False
    return max_value <= BLACK_PLACEHOLDER_EPSILON


def _intermediate_device():
    if model_management is not None:
        try:
            return model_management.intermediate_device()
        except Exception:
            pass
    return torch.device("cpu")


def _intermediate_dtype():
    if model_management is not None:
        try:
            return model_management.intermediate_dtype()
        except Exception:
            pass
    return torch.float32


def _torch_device():
    if model_management is not None:
        try:
            return model_management.get_torch_device()
        except Exception:
            pass
    return _intermediate_device()


def _resize_frame(frame: torch.Tensor, height: int, width: int) -> torch.Tensor:
    frame = frame.permute(0, 3, 1, 2)
    resized = F.interpolate(frame, size=(height, width), mode="bicubic", antialias=True)
    return resized.permute(0, 2, 3, 1).clamp(0.0, 1.0)


def _convert_to_base_type(base: torch.Tensor, other: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, bool]:
    output_is_mask = base.dim() == 3
    if output_is_mask and other.dim() == 4:
        channels = min(3, int(other.shape[-1]))
        other = other[..., :channels].mean(dim=-1)
    elif not output_is_mask and other.dim() == 3:
        channels = int(base.shape[-1])
        other = other.unsqueeze(-1).expand(-1, -1, -1, channels)
    if output_is_mask:
        base = base.unsqueeze(-1)
        other = other.unsqueeze(-1)
    return base, other, output_is_mask


def _write(dst: torch.Tensor, src: torch.Tensor, src_channels: int):
    # 确保 src 是独立的副本，避免与 dst 有内存重叠导致 copy_() 行为异常
    src = src.clone().to(device=dst.device, dtype=dst.dtype)
    if dst.shape[-1] == src_channels:
        dst.copy_(src)
        return
    dst[..., :src_channels].copy_(src)
    dst[..., src_channels:].fill_(1.0)


def _concat_pair(base: torch.Tensor, other: torch.Tensor, direction: str, match_image_size: bool, first_shape=None) -> torch.Tensor:
    direction = direction if direction in DIRECTIONS else "right"
    base, other, output_is_mask = _convert_to_base_type(base, other)

    bs1 = int(base.shape[0])
    bs2 = int(other.shape[0])
    batch = max(bs1, bs2)

    h1, w1 = int(base.shape[1]), int(base.shape[2])
    c1, c2 = int(base.shape[-1]), int(other.shape[-1])
    out_channels = max(c1, c2)

    if match_image_size:
        target_shape = first_shape if first_shape is not None else base.shape
        aspect = float(other.shape[2]) / max(1.0, float(other.shape[1]))
        if direction in ("left", "right"):
            h2 = int(target_shape[1])
            w2 = max(1, int(round(h2 * aspect)))
        else:
            w2 = int(target_shape[2])
            h2 = max(1, int(round(w2 / aspect)))
    else:
        h2, w2 = int(other.shape[1]), int(other.shape[2])

    if direction in ("right", "left"):
        out_h, out_w = max(h1, h2), w1 + w2
    else:
        out_h, out_w = h1 + h2, max(w1, w2)

    if direction == "right":
        y1, x1, y2, x2 = (out_h - h1) // 2, 0, (out_h - h2) // 2, w1
    elif direction == "left":
        y1, x1, y2, x2 = (out_h - h1) // 2, w2, (out_h - h2) // 2, 0
    elif direction == "down":
        y1, x1, y2, x2 = 0, (out_w - w1) // 2, h1, (out_w - w2) // 2
    else:
        y1, x1, y2, x2 = h2, (out_w - w1) // 2, 0, (out_w - w2) // 2

    output = torch.zeros(
        (batch, out_h, out_w, out_channels),
        dtype=_intermediate_dtype(),
        device=_intermediate_device(),
    )

    slot1 = output[:, y1:y1 + h1, x1:x1 + w1, :]
    if bs1 == batch:
        _write(slot1, base, c1)
    else:
        _write(slot1[:bs1], base, c1)
        _write(slot1[bs1:], base[-1:].expand(batch - bs1, -1, -1, -1), c1)

    slot2 = output[:, y2:y2 + h2, x2:x2 + w2, :]
    if match_image_size:
        pbar = ProgressBar(batch) if ProgressBar is not None else None
        device = _torch_device()
        for index in range(batch):
            src_index = min(index, bs2 - 1)
            frame = other[src_index:src_index + 1].to(device, non_blocking=True)
            resized = _resize_frame(frame, h2, w2)
            _write(slot2[index:index + 1], resized, c2)
            if pbar is not None:
                pbar.update(1)
    elif bs2 == batch:
        _write(slot2, other, c2)
    else:
        _write(slot2[:bs2], other, c2)
        _write(slot2[bs2:], other[-1:].expand(batch - bs2, -1, -1, -1), c2)

    return output.squeeze(-1) if output_is_mask else output


class GJJ_ImageConcanate:
    CATEGORY = "GJJ/图像"
    FUNCTION = "concatenate"
    DESCRIPTION = "GJJ 零依赖媒体拼接节点：动态接收 GJJ_BATCH_IMAGE、IMAGE、MASK、VIDEO，按方向依次拼接，可选择匹配首图尺寸。"
    SEARCH_ALIASES = ["image concatenate", "image concat", "图片拼接", "图像拼接", "媒体拼接", "ImageConcanate"]
    RETURN_TYPES = (MEDIA_TYPE,)
    RETURN_NAMES = ("拼接结果",)
    OUTPUT_TOOLTIPS = ("按输入顺序拼接后的结果；首个有效输入是 MASK 时输出 MASK，否则输出 IMAGE/GJJ 批量图片。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "direction": (
                    DIRECTIONS,
                    {
                        "default": "right",
                        "display_name": "拼接方向",
                        "tooltip": "第二张及之后的媒体相对当前结果放置的方向；前端按钮会同步这个值。",
                    },
                ),
                "match_image_size": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "匹配首图尺寸",
                        "tooltip": "开启后后续媒体会按首个输入的共享边缩放并保持比例；关闭时尺寸不一致会居中补黑。",
                    },
                ),
            },
            "optional": FlexibleMediaInputs(),
        }

    def concatenate(self, direction="right", match_image_size=True, **kwargs):
        media_items: list[torch.Tensor] = []
        for key in sorted(kwargs.keys(), key=_input_index):
            if not str(key).startswith(IMAGE_PREFIX):
                continue
            tensor = _as_media_tensor(kwargs.get(key))
            if tensor is not None and not _is_black_placeholder(tensor):
                media_items.append(tensor)

        if not media_items:
            raise RuntimeError("GJJ 图片拼接失败：请至少连接一个非全黑占位的 GJJ_BATCH_IMAGE、IMAGE、MASK 或 VIDEO 输入。")

        result = media_items[0]
        first_shape = result.shape
        for tensor in media_items[1:]:
            result = _concat_pair(result, tensor, str(direction), bool(match_image_size), first_shape=first_shape)
        return (result,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageConcanate}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧩 图片拼接（简易）"}
