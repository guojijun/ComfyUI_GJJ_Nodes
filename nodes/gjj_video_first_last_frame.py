from typing import Any, Iterable, Optional

import torch


MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value: Any) -> Any:
    getter = getattr(value, "get_components", None)
    if callable(getter):
        try:
            return getter()
        except Exception:
            return None
    return None


def _looks_like_channel_count(size: int) -> bool:
    return int(size) in (1, 3, 4)


def _tensor_to_bhwc(value: torch.Tensor) -> Optional[torch.Tensor]:
    if value.numel() == 0:
        return None

    tensor = value
    if tensor.ndim == 5:
        # Common video forms: B,T,H,W,C or B,C,T,H,W.
        if _looks_like_channel_count(tensor.shape[-1]):
            tensor = tensor.reshape(-1, tensor.shape[-3], tensor.shape[-2], tensor.shape[-1])
        elif _looks_like_channel_count(tensor.shape[1]):
            tensor = tensor.permute(0, 2, 3, 4, 1).reshape(
                -1, tensor.shape[3], tensor.shape[4], tensor.shape[1]
            )
        else:
            return None

    if tensor.ndim == 4:
        # ComfyUI IMAGE is BHWC. Accept NCHW too for compatibility.
        if _looks_like_channel_count(tensor.shape[-1]):
            frames = tensor
        elif _looks_like_channel_count(tensor.shape[1]):
            frames = tensor.movedim(1, -1)
        else:
            return None
    elif tensor.ndim == 3:
        # Accept HWC and CHW single frames.
        if _looks_like_channel_count(tensor.shape[-1]):
            frames = tensor.unsqueeze(0)
        elif _looks_like_channel_count(tensor.shape[0]):
            frames = tensor.movedim(0, -1).unsqueeze(0)
        else:
            return None
    else:
        return None

    return frames.float().clamp(0.0, 1.0).contiguous()


def _iter_children(value: Any) -> Iterable[Any]:
    if isinstance(value, dict):
        preferred_keys = (
            "images",
            "image",
            "frames",
            "frame",
            "samples",
            "batch",
            "items",
            "value",
            "video",
        )
        for key in preferred_keys:
            if key in value:
                yield value[key]
        return

    components = _video_components(value)
    if components is not None:
        for key in ("images", "image", "frames", "frame"):
            child = _component_value(components, key)
            if child is not None:
                yield child
        return

    if isinstance(value, (list, tuple)):
        yield from value


def _collect_frame_batches(value: Any, batches: list[torch.Tensor]) -> None:
    if isinstance(value, torch.Tensor):
        frames = _tensor_to_bhwc(value)
        if frames is not None:
            batches.append(frames)
        return

    for child in _iter_children(value):
        _collect_frame_batches(child, batches)


def _as_frame_sequence(value: Any) -> torch.Tensor:
    batches: list[torch.Tensor] = []
    _collect_frame_batches(value, batches)

    if not batches:
        raise ValueError("未从输入中提取到图像帧。")

    first_shape = tuple(batches[0].shape[1:])
    if any(tuple(batch.shape[1:]) != first_shape for batch in batches):
        raise ValueError("输入图像序列尺寸不一致，无法合并首尾帧。")

    frames = torch.cat(batches, dim=0)
    if frames.shape[0] < 1:
        raise ValueError("输入图像序列为空。")
    return frames


class GJJ_VideoFirstLastFrame:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "media": (MEDIA_INPUT_TYPE, {"display_name": "视频/图像序列"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("首帧", "尾帧")
    FUNCTION = "extract"
    CATEGORY = "GJJ/视频"

    def extract(self, media):
        frames = _as_frame_sequence(media)
        first_frame = frames[:1]
        last_frame = frames[-1:]
        return (first_frame, last_frame)


NODE_CLASS_MAPPINGS = {
    "GJJ_VideoFirstLastFrame": GJJ_VideoFirstLastFrame,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_VideoFirstLastFrame": "GJJ · 视频首尾帧",
}
