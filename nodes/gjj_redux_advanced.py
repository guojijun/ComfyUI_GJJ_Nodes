from __future__ import annotations

import threading
import math

import torch
import torch.nn.functional as F

import comfy.clip_vision
import comfy.sd
import folder_paths
from node_helpers import conditioning_set_values


STYLE_MODEL_NAME = "fluxToolsRedux_reduxDev.safetensors"
CLIP_VISION_NAME = "sigclip_vision_patch14_384.safetensors"
GUIDANCE = 3.5
TARGET_SIZE = 384
IMAGE_MODES = ["居中裁剪（正方形）", "保持宽高比", "按遮罩自动裁剪"]
DOWNSAMPLE_MODES = {
    "最近邻": "nearest",
    "双线性": "bilinear",
    "双三次": "bicubic",
    "区域平均": "area",
    "精确最近邻": "nearest-exact",
}


def _resolve_model(folder: str, preferred: str) -> str:
    names = folder_paths.get_filename_list(folder)
    if preferred in names:
        return folder_paths.get_full_path_or_raise(folder, preferred)
    preferred_lower = preferred.lower()
    for name in names:
        if name.lower() == preferred_lower:
            return folder_paths.get_full_path_or_raise(folder, name)
    raise FileNotFoundError(
        f"GJJ ReduxAdvanced 缺少模型：models/{folder}/{preferred}"
    )


def _normalize_mask(mask: torch.Tensor, batch: int) -> torch.Tensor:
    if not isinstance(mask, torch.Tensor):
        raise TypeError("mask 必须是 ComfyUI MASK。")
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    elif mask.ndim == 4 and mask.shape[-1] == 1:
        mask = mask[..., 0]
    elif mask.ndim == 4 and mask.shape[1] == 1:
        mask = mask[:, 0]
    if mask.ndim != 3:
        raise ValueError(f"mask 维度应为 [B,H,W]，实际为 {tuple(mask.shape)}")
    if mask.shape[0] == 1 and batch > 1:
        mask = mask.repeat(batch, 1, 1)
    elif mask.shape[0] != batch:
        raise ValueError(f"image 与 mask 批次数不一致：{batch} != {mask.shape[0]}")
    return mask.float().clamp_(0.0, 1.0)


def _letterbox(image: torch.Tensor, mask: torch.Tensor, size: int):
    batch, height, width, channels = image.shape
    scale = size / max(height, width)
    resized_h = max(1, round(height * scale))
    resized_w = max(1, round(width * scale))
    offset_y = (size - resized_h) // 2
    offset_x = (size - resized_w) // 2

    resized_image = F.interpolate(
        image.movedim(-1, 1),
        size=(resized_h, resized_w),
        mode="bicubic",
        antialias=True,
    ).movedim(1, -1)
    output_image = image.new_zeros((batch, size, size, channels))
    output_image[:, offset_y:offset_y + resized_h, offset_x:offset_x + resized_w] = resized_image

    resized_mask = F.interpolate(
        mask.unsqueeze(1), size=(resized_h, resized_w), mode="bicubic", align_corners=False
    )
    output_mask = mask.new_zeros((batch, size, size))
    output_mask[:, offset_y:offset_y + resized_h, offset_x:offset_x + resized_w] = resized_mask[:, 0]
    return output_image.clamp_(0.0, 1.0), output_mask.clamp_(0.0, 1.0)


def _prepare_image(image, mask, mode, margin, size):
    batch, height, width, _ = image.shape
    if mode == "按遮罩自动裁剪":
        active = torch.nonzero(mask.amax(dim=0) > 0, as_tuple=False)
        if active.numel() == 0:
            raise ValueError("按遮罩自动裁剪时，遮罩中必须包含非零区域。")
        y1, x1 = active.amin(dim=0).tolist()
        y2, x2 = active.amax(dim=0).tolist()
        margin_x = math.ceil(width * margin)
        margin_y = math.ceil(height * margin)
        x1, x2 = max(0, x1 - margin_x), min(width, x2 + margin_x + 1)
        y1, y2 = max(0, y1 - margin_y), min(height, y2 + margin_y + 1)
        image, mask = image[:, y1:y2, x1:x2], mask[:, y1:y2, x1:x2]
        return _letterbox(image, mask, size)
    if mode == "保持宽高比":
        return _letterbox(image, mask, size)

    side = min(height, width)
    y1 = (height - side) // 2
    x1 = (width - side) // 2
    image = image[:, y1:y1 + side, x1:x1 + side]
    mask = mask[:, y1:y1 + side, x1:x1 + side]
    output_image = F.interpolate(
        image.movedim(-1, 1), size=(size, size), mode="bicubic", antialias=True
    ).movedim(1, -1)
    output_mask = F.interpolate(
        mask.unsqueeze(1), size=(size, size), mode="bicubic", align_corners=False
    )[:, 0]
    return output_image.clamp_(0.0, 1.0), output_mask.clamp_(0.0, 1.0)


def _model_choices(folder, preferred):
    names = list(folder_paths.get_filename_list(folder))
    if preferred in names:
        names.remove(preferred)
        names.insert(0, preferred)
    return names or [preferred]


class GJJ_ReduxAdvanced:
    _cache_lock = threading.Lock()
    _style_path = None
    _style_model = None
    _vision_path = None
    _clip_vision = None

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"display_name": "文本编码器", "tooltip": "用于生成基础文本条件的 CLIP 模型。"}),
                "image": ("IMAGE", {"display_name": "参考图像", "tooltip": "用于提取 Redux 图像特征的参考图。"}),
                "正面提示词": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "tooltip": "使用输入 CLIP 编码的正面提示词；可通过控件菜单转换为外接输入。"}),
                "引导强度": ("FLOAT", {"default": 3.5, "min": 0.0, "max": 100.0, "step": 0.1, "display": "hidden", "hidden": True, "tooltip": "写入 Flux conditioning 的 guidance 数值。"}),
                "风格模型": (_model_choices("style_models", STYLE_MODEL_NAME), {"display": "hidden", "hidden": True, "tooltip": "Redux 风格模型，通常使用 fluxToolsRedux_reduxDev.safetensors。"}),
                "视觉模型": (_model_choices("clip_vision", CLIP_VISION_NAME), {"display": "hidden", "hidden": True, "tooltip": "编码参考图的 CLIP Vision 模型。"}),
                "下采样倍率": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 9.0, "step": 0.1, "display": "hidden", "hidden": True, "tooltip": "压缩 Redux 图像条件 token；1 表示不压缩。"}),
                "下采样算法": (list(DOWNSAMPLE_MODES), {"default": "区域平均", "display": "hidden", "hidden": True, "tooltip": "图像条件标记下采样使用的插值算法。"}),
                "图像处理模式": (IMAGE_MODES, {"default": "保持宽高比", "display": "hidden", "hidden": True, "tooltip": "参考图进入视觉模型前的裁剪或补边方式。"}),
                "图像条件权重": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display": "hidden", "hidden": True, "tooltip": "Redux 图像条件的影响强度。"}),
                "自动裁剪边距": ("FLOAT", {"default": 0.1, "min": 0.0, "max": 1.0, "step": 0.01, "display": "hidden", "hidden": True, "tooltip": "按遮罩自动裁剪时向外扩展的边距比例。"}),
            },
            "optional": {
                "mask": ("MASK", {"display_name": "参考遮罩（可选）", "tooltip": "可选遮罩；未连接时自动使用覆盖整张参考图的全白遮罩。"}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "IMAGE", "MASK")
    RETURN_NAMES = ("条件", "处理后图像", "处理后遮罩")
    OUTPUT_TOOLTIPS = (
        "融合文本、Flux 引导和 Redux 图像特征后的条件。",
        "实际送入视觉模型的处理后参考图。",
        "与处理后参考图空间一致的遮罩。",
    )
    FUNCTION = "apply"
    CATEGORY = "GJJ/条件编码"
    DESCRIPTION = (
        "一体化 Redux 高级条件节点，默认只显示 CLIP、图像和遮罩接口；"
        "点击“⚙️设置”可调整全部参数。"
    )
    GJJ_HELP = {
        "标题": "Redux 高级条件",
        "说明": "自动完成文本编码、Flux 引导、视觉模型编码和 Redux 风格条件拼接。",
        "使用方法": [
            "连接 CLIP 和参考图；遮罩可选，未连接时自动使用全白遮罩。",
            "点击“🧠”管理模型；点击“⚙️”调整引导、下采样和图像处理参数。",
            "将“条件”输出连接到采样流程的正向条件输入。",
        ],
        "模型": {
            "风格模型": "默认使用 fluxToolsRedux_reduxDev.safetensors。",
            "视觉模型": "默认使用 sigclip_vision_patch14_384.safetensors。",
        },
        "提示": "保持宽高比模式会将图像等比缩放并补黑边到视觉模型分辨率。",
    }

    @classmethod
    def _load_models(cls, style_name, vision_name):
        style_path = _resolve_model("style_models", style_name)
        vision_path = _resolve_model("clip_vision", vision_name)
        with cls._cache_lock:
            if cls._style_model is None or cls._style_path != style_path:
                cls._style_model = comfy.sd.load_style_model(style_path)
                cls._style_path = style_path
            if cls._clip_vision is None or cls._vision_path != vision_path:
                cls._clip_vision = comfy.clip_vision.load(vision_path)
                cls._vision_path = vision_path
                if cls._clip_vision is None:
                    raise RuntimeError(f"CLIP Vision 模型无效：{vision_path}")
            return cls._style_model, cls._clip_vision

    def apply(self, clip, image, 正面提示词="", 引导强度=3.5, 风格模型=STYLE_MODEL_NAME,
              视觉模型=CLIP_VISION_NAME, 下采样倍率=1.0, 下采样算法="区域平均",
              图像处理模式="保持宽高比", 图像条件权重=1.0, 自动裁剪边距=0.1,
              mask=None):
        if clip is None:
            raise ValueError("clip 输入不能为空。")
        if not isinstance(image, torch.Tensor) or image.ndim != 4:
            raise ValueError("image 必须是形状为 [B,H,W,C] 的 ComfyUI IMAGE。")

        tokens = clip.tokenize(正面提示词)
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        conditioning = conditioning_set_values(conditioning, {"guidance": float(引导强度)})

        style_model, clip_vision = self._load_models(风格模型, 视觉模型)
        image = image.float().clamp(0.0, 1.0)
        if mask is None:
            mask = torch.ones(
                (image.shape[0], image.shape[1], image.shape[2]),
                dtype=image.dtype,
                device=image.device,
            )
        else:
            mask = _normalize_mask(mask, image.shape[0]).to(image.device)
        processed_image, processed_mask = _prepare_image(
            image, mask, 图像处理模式, float(自动裁剪边距), TARGET_SIZE
        )

        clip_vision_output = clip_vision.encode_image(processed_image)
        redux = style_model.get_cond(clip_vision_output).flatten(0, 1).unsqueeze(0)
        if float(下采样倍率) > 1.0:
            batch, token_count, channels = redux.shape
            side = math.isqrt(token_count)
            if side * side != token_count:
                raise ValueError(f"Redux token 数量 {token_count} 无法排列为正方形。")
            target = max(1, round(side / float(下采样倍率)))
            algorithm = DOWNSAMPLE_MODES[下采样算法]
            interpolate_args = {"size": (target, target), "mode": algorithm}
            if algorithm in {"bilinear", "bicubic"}:
                interpolate_args["align_corners"] = False
            redux = F.interpolate(
                redux.reshape(batch, side, side, channels).movedim(-1, 1),
                **interpolate_args,
            ).movedim(1, -1).reshape(batch, -1, channels)
        redux = redux * (float(图像条件权重) ** 2)

        output = []
        for cond, metadata in conditioning:
            batch_redux = redux.to(device=cond.device, dtype=cond.dtype)
            if batch_redux.shape[0] == 1 and cond.shape[0] > 1:
                batch_redux = batch_redux.repeat(cond.shape[0], 1, 1)
            elif cond.shape[0] == 1 and batch_redux.shape[0] > 1:
                cond = cond.repeat(batch_redux.shape[0], 1, 1)
            elif batch_redux.shape[0] != cond.shape[0]:
                raise ValueError(
                    f"文本 conditioning 与 Redux 图片批次数不兼容："
                    f"{cond.shape[0]} != {batch_redux.shape[0]}"
                )
            output.append([torch.cat((cond, batch_redux), dim=1), metadata.copy()])

        return output, processed_image, processed_mask


NODE_CLASS_MAPPINGS = {"GJJ_ReduxAdvanced": GJJ_ReduxAdvanced}
NODE_DISPLAY_NAME_MAPPINGS = {"GJJ_ReduxAdvanced": "GJJ Redux高级条件"}
