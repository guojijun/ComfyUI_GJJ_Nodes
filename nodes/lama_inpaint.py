from __future__ import annotations

from pathlib import Path
from threading import Lock

import folder_paths
import torch
import torch.nn.functional as F
from comfy import model_management


NODE_NAME = "GJJ_LaMaInpaint"
DEFAULT_MODEL_RELATIVE_PATH = Path("ckpts") / "big-lama.pt"

_MODEL_LOCK = Lock()
_TS_MODEL: torch.jit.ScriptModule | None = None
_LOADED_PATH: str | None = None


def _default_model_path() -> Path:
    return Path(folder_paths.models_dir) / DEFAULT_MODEL_RELATIVE_PATH


def _bhwc_to_nchw(tensor: torch.Tensor) -> torch.Tensor:
    return tensor.permute(0, 3, 1, 2).contiguous()


def _nchw_to_bhwc(tensor: torch.Tensor) -> torch.Tensor:
    return tensor.permute(0, 2, 3, 1).contiguous()


def _to_01_range(tensor: torch.Tensor) -> torch.Tensor:
    if tensor.dtype != torch.float32:
        tensor = tensor.float()
    if tensor.numel() > 0 and tensor.max().item() > 1.5:
        tensor = tensor / 255.0
    return tensor.clamp(0.0, 1.0)


def _prepare_image(images: torch.Tensor) -> torch.Tensor:
    image_bchw = _to_01_range(_bhwc_to_nchw(images))
    if image_bchw.shape[1] == 1:
        image_bchw = image_bchw.repeat(1, 3, 1, 1)
    elif image_bchw.shape[1] == 4:
        image_bchw = image_bchw[:, :3, :, :]
    if image_bchw.shape[1] != 3:
        raise ValueError(f"LaMa 仅支持 1/3/4 通道图像输入，当前图像形状为 {tuple(images.shape)}。")
    return image_bchw


def _prepare_mask(masks: torch.Tensor, invert_mask: bool) -> torch.Tensor:
    if masks.dim() == 3:
        mask_bchw = masks.unsqueeze(1)
    elif masks.dim() == 4:
        if masks.shape[-1] == 1:
            mask_bchw = masks.permute(0, 3, 1, 2).contiguous()
        else:
            mask_bchw = masks.permute(0, 3, 1, 2).contiguous().mean(dim=1, keepdim=True)
    else:
        raise ValueError(f"遮罩格式不受支持，当前遮罩形状为 {tuple(masks.shape)}。")

    mask_bchw = (_to_01_range(mask_bchw) >= 0.5).to(torch.float32)
    if invert_mask:
        mask_bchw = 1.0 - mask_bchw
    if mask_bchw.shape[1] != 1:
        mask_bchw = mask_bchw.mean(dim=1, keepdim=True)
    return mask_bchw


def _pad_to_multiple_of_8(tensor: torch.Tensor) -> tuple[torch.Tensor, tuple[int, int, int, int]]:
    _, _, height, width = tensor.shape
    pad_h = (8 - height % 8) % 8
    pad_w = (8 - width % 8) % 8
    left = pad_w // 2
    right = pad_w - left
    top = pad_h // 2
    bottom = pad_h - top
    if (left | right | top | bottom) == 0:
        return tensor, (0, 0, 0, 0)
    padded = F.pad(tensor, (left, right, top, bottom), mode="reflect")
    return padded, (left, right, top, bottom)


def _unpad(tensor: torch.Tensor, pads: tuple[int, int, int, int]) -> torch.Tensor:
    left, right, top, bottom = pads
    if (left | right | top | bottom) == 0:
        return tensor
    return tensor[..., top : tensor.shape[-2] - bottom, left : tensor.shape[-1] - right]


def _load_lama_model() -> torch.jit.ScriptModule:
    global _TS_MODEL, _LOADED_PATH

    model_path = _default_model_path()
    if not model_path.exists():
        raise FileNotFoundError(
            f"未找到 LaMa 模型文件，请将 big-lama.pt 放到: {model_path}"
        )

    if _TS_MODEL is not None and _LOADED_PATH == str(model_path):
        return _TS_MODEL

    with _MODEL_LOCK:
        if _TS_MODEL is not None and _LOADED_PATH == str(model_path):
            return _TS_MODEL

        device = model_management.get_torch_device()
        model = torch.jit.load(str(model_path), map_location=device)
        model.eval()
        for parameter in model.parameters():
            parameter.requires_grad_(False)

        _TS_MODEL = model
        _LOADED_PATH = str(model_path)
        return model


def _run_lama_forward(
    model: torch.jit.ScriptModule,
    image_bchw: torch.Tensor,
    mask_bchw: torch.Tensor,
) -> torch.Tensor:
    try:
        return model(image_bchw, mask_bchw)
    except RuntimeError as error:
        message = str(error)
        if ("expected input" in message and "to have 4 channels" in message) or (
            "Given groups=1, weight of size [64, 4" in message
        ):
            return model(mask_bchw, image_bchw)
        raise


class GJJ_LaMaInpaint:
    CATEGORY = "GJJ"
    FUNCTION = "inpaint"
    DESCRIPTION = "使用本地 big-lama.pt 对图像中被遮罩标记的区域进行修复，默认模型位置为 models/ckpts/big-lama.pt，适合去物、补边和背景补全。"
    SEARCH_ALIASES = ["lama", "inpaint", "修复", "去物", "补图", "图像修复", "局部重绘"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("修复完成图像",)
    OUTPUT_TOOLTIPS = ("输出经过 LaMa 修复后的图像，遮罩白色区域会被当作需要修复的洞区域。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "输入图像",
                        "tooltip": "需要进行 LaMa 修复的原始图像。",
                    },
                ),
                "mask": (
                    "MASK",
                    {
                        "display_name": "修复遮罩",
                        "tooltip": "白色区域表示需要修复的区域；默认按二值遮罩处理。",
                    },
                ),
                "invert_mask": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "反转遮罩",
                        "tooltip": "开启后会将黑白区域对调，再送入 LaMa 进行修复。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(cls, image, mask, invert_mask):
        return f"{tuple(image.shape)}|{tuple(mask.shape)}|{bool(invert_mask)}"

    @torch.inference_mode()
    def inpaint(self, image: torch.Tensor, mask: torch.Tensor, invert_mask: bool):
        image_bchw = _prepare_image(image)
        mask_bchw = _prepare_mask(mask, bool(invert_mask))

        device = model_management.get_torch_device()
        image_bchw = image_bchw.to(device, non_blocking=True)
        mask_bchw = mask_bchw.to(device, non_blocking=True)

        image_bchw, pads = _pad_to_multiple_of_8(image_bchw)
        mask_bchw, _ = _pad_to_multiple_of_8(mask_bchw)

        model = _load_lama_model()
        outputs: list[torch.Tensor] = []

        for index in range(image_bchw.shape[0]):
            current_image = image_bchw[index : index + 1]
            current_mask = mask_bchw[index : index + 1]
            outputs.append(_run_lama_forward(model, current_image, current_mask))

        output_bchw = torch.cat(outputs, dim=0) if outputs else image_bchw
        output_bchw = _unpad(output_bchw, pads).clamp(0.0, 1.0)
        output_bhwc = _nchw_to_bhwc(output_bchw)
        return (output_bhwc,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LaMaInpaint}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🩹 LaMa图像修复"}
