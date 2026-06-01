from __future__ import annotations

import os
from typing import Any

import comfy.utils
import folder_paths
import torch
from nodes import ControlNetApplyAdvanced, ControlNetLoader

from .common_utils.dependency_checker import make_missing_model_spec, raise_dependency_model_error


NODE_NAME = "GJJ_AliMamaControlNetApply"
NODE_DISPLAY_NAME = "GJJ · 🩹 阿里妈妈ControlNet"
DESCRIPTION = (
    "合并 ControlNet 模型加载与官方阿里妈妈局部重绘 ControlNet 应用；"
    "VAE 与遮罩为可选输入，接入遮罩时按 inpaint ControlNet 逻辑处理，未接入时按普通 ControlNet 应用。"
)


def _list_controlnets() -> list[str]:
    try:
        return [str(item) for item in folder_paths.get_filename_list("controlnet")]
    except Exception:
        return []


def _basename(value: str) -> str:
    return os.path.basename(str(value or "").replace("\\", "/"))


def _missing_controlnet_spec(filename: str = "") -> dict[str, str]:
    return make_missing_model_spec(
        label="ControlNet 模型",
        subdir="models/controlnet",
        filename=filename or "请选择或放入任意 ControlNet 模型",
        description="节点会读取 ComfyUI 的 models/controlnet 模型列表，支持子目录相对路径。",
    )


def _raise_missing_controlnet(requested: str = "", unique_id: Any = None) -> None:
    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[_missing_controlnet_spec(requested)],
        description="没有找到可用的 ControlNet 模型。请把模型文件放入 models/controlnet 后刷新或重启 ComfyUI。",
        unique_id=unique_id,
        title="GJJ 阿里妈妈 ControlNet 缺少模型",
    )


def _resolve_controlnet_name(requested: Any, unique_id: Any = None) -> str:
    raw = str(requested or "").strip()
    available = _list_controlnets()

    if not raw:
        if available:
            return available[0]
        _raise_missing_controlnet(unique_id=unique_id)

    raw_key = raw.replace("\\", "/").lower()
    raw_base = _basename(raw).lower()
    for candidate in available:
        if candidate.replace("\\", "/").lower() == raw_key:
            return candidate
    for candidate in available:
        if _basename(candidate).lower() == raw_base:
            return candidate
    try:
        if folder_paths.get_full_path("controlnet", raw):
            return raw
    except Exception:
        pass

    _raise_missing_controlnet(raw, unique_id=unique_id)
    return raw


def _ensure_image(image: torch.Tensor) -> torch.Tensor:
    if not torch.is_tensor(image):
        raise RuntimeError("阿里妈妈 ControlNet 需要 IMAGE 图像输入。")
    tensor = image.float()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"阿里妈妈 ControlNet 图像维度无效：{tuple(tensor.shape)}")
    return tensor


def _normalize_mask(mask: Any) -> torch.Tensor | None:
    if mask is None or not torch.is_tensor(mask):
        return None
    tensor = mask.float()
    if tensor.ndim == 2:
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim == 4:
        if int(tensor.shape[-1]) == 1:
            tensor = tensor[..., 0]
        elif int(tensor.shape[1]) == 1:
            tensor = tensor[:, 0]
        else:
            tensor = tensor.mean(dim=-1)
    if tensor.ndim != 3:
        raise RuntimeError(f"阿里妈妈 ControlNet 遮罩维度无效：{tuple(tensor.shape)}")
    return tensor.clamp(0.0, 1.0)


def _repeat_to_batch(tensor: torch.Tensor, batch: int, label: str) -> torch.Tensor:
    current = int(tensor.shape[0])
    if current == batch:
        return tensor
    if current == 1:
        return tensor.repeat((batch,) + (1,) * (tensor.ndim - 1))
    raise RuntimeError(f"{label}批次数量为 {current}，图像批次数量为 {batch}，无法自动匹配。")


def _apply_optional_alimama_mask(control_net: Any, image: torch.Tensor, mask: Any) -> tuple[torch.Tensor, list[torch.Tensor]]:
    mask_tensor = _normalize_mask(mask)
    if mask_tensor is None or not bool(getattr(control_net, "concat_mask", False)):
        return image, []

    mask_tensor = _repeat_to_batch(mask_tensor, int(image.shape[0]), "遮罩")
    concat_mask = 1.0 - mask_tensor.reshape((-1, 1, mask_tensor.shape[-2], mask_tensor.shape[-1]))
    mask_apply = comfy.utils.common_upscale(
        concat_mask,
        int(image.shape[2]),
        int(image.shape[1]),
        "bilinear",
        "center",
    ).round()
    mask_apply = mask_apply.movedim(1, -1).repeat(1, 1, 1, int(image.shape[3]))
    return image * mask_apply, [concat_mask]


class GJJ_AliMamaControlNetApply:
    CATEGORY = "GJJ/ControlNet"
    FUNCTION = "apply"
    DESCRIPTION = DESCRIPTION
    SEARCH_ALIASES = [
        "alimama controlnet",
        "controlnet inpaint",
        "ControlNet",
        "阿里妈妈",
        "局部重绘",
        "控制网",
    ]
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("正面条件", "负面条件")
    OUTPUT_TOOLTIPS = (
        "已附加 ControlNet 控制的正面条件。",
        "已附加 ControlNet 控制的负面条件。",
    )
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": DESCRIPTION,
        "model_download_url": "",
        "dependencies": [
            "ComfyUI 官方节点：ControlNetLoader / ControlNetApplyAdvanced",
            "无第三方自定义节点依赖。",
        ],
        "usage": [
            "ControlNet 模型下拉读取 models/controlnet；为空时自动使用列表第一个模型。",
            "VAE 未连接时按官方 ControlNet Apply 的默认路径执行；需要 VAE 辅助的模型可手动接入。",
            "遮罩未连接时忽略遮罩逻辑，等同普通 ControlNet 应用。",
            "遮罩已连接且模型需要 concat mask 时，按官方阿里妈妈局部重绘逻辑处理图片与 mask。",
        ],
    }

    def __init__(self):
        self._cache_key: str | None = None
        self._cached_controlnet = None

    @classmethod
    def INPUT_TYPES(cls):
        controlnets = _list_controlnets()
        choices = controlnets or [""]
        default_controlnet = choices[0] if choices else ""
        return {
            "required": {
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正面条件",
                        "tooltip": "来自 CLIP Text Encode 等节点的正面条件。",
                    },
                ),
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "负面条件",
                        "tooltip": "来自 CLIP Text Encode 等节点的负面条件。",
                    },
                ),
                "image": (
                    "IMAGE",
                    {
                        "display_name": "图像",
                        "tooltip": "ControlNet 控制图。接入遮罩时，阿里妈妈局部重绘逻辑会按遮罩处理这张图。",
                    },
                ),
                "control_net_name": (
                    choices,
                    {
                        "default": default_controlnet,
                        "display_name": "ControlNet模型",
                        "tooltip": "读取 models/controlnet 下的模型；当前值为空时自动选中列表第一个。",
                    },
                ),
                "strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.01,
                        "display_name": "强度",
                        "tooltip": "ControlNet 控制强度。0 会直接透传正负条件。",
                    },
                ),
                "start_percent": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.001,
                        "display_name": "开始百分比",
                        "tooltip": "ControlNet 生效的起始采样百分比。",
                    },
                ),
                "end_percent": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.001,
                        "display_name": "结束百分比",
                        "tooltip": "ControlNet 生效的结束采样百分比。",
                    },
                ),
            },
            "optional": {
                "vae": (
                    "VAE",
                    {
                        "display_name": "VAE",
                        "tooltip": "可选。传给官方 ControlNet Apply；部分 ControlNet 或局部重绘模型需要 VAE 编码辅助条件。",
                    },
                ),
                "mask": (
                    "MASK",
                    {
                        "display_name": "遮罩",
                        "tooltip": "可选。连接后按阿里妈妈局部重绘 ControlNet 逻辑处理；不连接则忽略遮罩。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def _load_controlnet(self, control_net_name: Any, unique_id: Any = None):
        resolved = _resolve_controlnet_name(control_net_name, unique_id=unique_id)
        if self._cache_key == resolved and self._cached_controlnet is not None:
            return self._cached_controlnet, resolved

        try:
            control_net = ControlNetLoader().load_controlnet(resolved)[0]
        except Exception as exc:
            raise RuntimeError(f"加载 ControlNet 模型失败：models/controlnet/{resolved}\n详细错误：{exc}") from exc
        if control_net is None:
            raise RuntimeError(f"ControlNet 模型无效：models/controlnet/{resolved}")

        self._cache_key = resolved
        self._cached_controlnet = control_net
        return control_net, resolved

    def apply(
        self,
        positive,
        negative,
        image,
        control_net_name="",
        strength=1.0,
        start_percent=0.0,
        end_percent=1.0,
        vae=None,
        mask=None,
        unique_id=None,
    ):
        strength_value = max(0.0, min(10.0, float(strength)))
        if strength_value <= 0.0:
            return (positive, negative)

        control_net, resolved_name = self._load_controlnet(control_net_name, unique_id=unique_id)
        image_tensor = _ensure_image(image)
        image_tensor, extra_concat = _apply_optional_alimama_mask(control_net, image_tensor, mask)
        start_value = max(0.0, min(1.0, float(start_percent)))
        end_value = max(0.0, min(1.0, float(end_percent)))

        positive_out, negative_out = ControlNetApplyAdvanced().apply_controlnet(
            positive,
            negative,
            control_net,
            image_tensor,
            strength_value,
            start_value,
            end_value,
            vae=vae,
            extra_concat=extra_concat,
        )
        mask_text = "启用遮罩" if extra_concat else "未使用遮罩"
        return {
            "ui": {
                "preview_text": [
                    f"阿里妈妈 ControlNet 已应用：{resolved_name}；强度 {strength_value:g}；范围 {start_value:g}-{end_value:g}；{mask_text}"
                ],
            },
            "result": (positive_out, negative_out),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AliMamaControlNetApply}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
