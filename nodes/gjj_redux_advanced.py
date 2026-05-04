from __future__ import annotations

import math
from typing import Any

import comfy.clip_vision
import comfy.sd
import folder_paths
import numpy as np
import torch


NODE_NAME = "GJJ_ReduxAdvanced"
DEFAULT_CLIP_VISION = "sigclip_vision_patch14_384.safetensors"
DEFAULT_STYLE_MODEL = "flux1-redux-dev.safetensors"
IMAGE_MODES = [
    "center crop (square)",
    "keep aspect ratio",
    "autocrop with mask",
]
DOWN_SAMPLE_MODES = ["nearest", "bilinear", "bicubic", "area", "nearest-exact"]


def _dedupe_keep_order(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in values:
        value = str(item or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _safe_filename_list(category: str) -> list[str]:
    try:
        return _dedupe_keep_order(list(folder_paths.get_filename_list(category)))
    except Exception:
        return []


def _preferred_default(values: list[str], preferred: str) -> str:
    preferred = str(preferred or "").strip()
    if preferred and preferred in values:
        return preferred
    return values[0] if values else ""


def _standardize_mask(mask):
    if mask is None:
        return None
    if len(mask.shape) == 2:
        h, w = mask.shape
        mask = mask.view(1, 1, h, w)
    elif len(mask.shape) == 3:
        b, h, w = mask.shape
        mask = mask.view(b, 1, h, w)
    return mask


def _crop(img, mask, box, desired_size):
    ox, oy, w, h = box
    if mask is not None:
        mask = torch.nn.functional.interpolate(mask, size=(h, w), mode="bicubic").view(-1, h, w, 1)
    img = torch.nn.functional.interpolate(img.transpose(-1, 1), size=(w, h), mode="bicubic", antialias=True)
    cropped_img = img[:, :, ox:(desired_size + ox), oy:(desired_size + oy)].transpose(1, -1)
    cropped_mask = None if mask is None else mask[:, oy:(desired_size + oy), ox:(desired_size + ox), :]
    return cropped_img, cropped_mask


def _letterbox(img, mask, w, h, desired_size):
    b, _, _, c = img.shape
    img = torch.nn.functional.interpolate(img.transpose(-1, 1), size=(w, h), mode="bicubic", antialias=True).transpose(1, -1)
    letterbox = torch.zeros(size=(b, desired_size, desired_size, c), device=img.device, dtype=img.dtype)
    offsetx = (desired_size - w) // 2
    offsety = (desired_size - h) // 2
    letterbox[:, offsety:(offsety + h), offsetx:(offsetx + w), :] += img
    img = letterbox
    if mask is not None:
        mask = torch.nn.functional.interpolate(mask, size=(h, w), mode="bicubic")
        letterbox_mask = torch.zeros(size=(b, 1, desired_size, desired_size), device=mask.device, dtype=mask.dtype)
        letterbox_mask[:, :, offsety:(offsety + h), offsetx:(offsetx + w)] += mask
        mask = letterbox_mask.view(b, 1, desired_size, desired_size)
    return img, mask


def _get_bounding_box(mask, w, h, relative_margin, desired_size):
    mask = mask.view(h, w)
    margin_w = math.ceil(relative_margin * w)
    margin_h = math.ceil(relative_margin * h)
    indices = torch.nonzero(mask, as_tuple=False)
    y_min, x_min = indices.min(dim=0).values
    y_max, x_max = indices.max(dim=0).values
    x_min = max(0, x_min.item() - margin_w)
    y_min = max(0, y_min.item() - margin_h)
    x_max = min(w, x_max.item() + margin_w)
    y_max = min(h, y_max.item() + margin_h)

    box_width = x_max - x_min
    box_height = y_max - y_min
    larger_edge = max(box_width, box_height, desired_size)

    if box_width < larger_edge:
        delta = larger_edge - box_width
        left_space = x_min
        right_space = w - x_max
        expand_left = min(delta // 2, left_space)
        expand_right = min(delta - expand_left, right_space)
        expand_left += min(delta - (expand_left + expand_right), left_space - expand_left)
        x_min -= expand_left
        x_max += expand_right

    if box_height < larger_edge:
        delta = larger_edge - box_height
        top_space = y_min
        bottom_space = h - y_max
        expand_top = min(delta // 2, top_space)
        expand_bottom = min(delta - expand_top, bottom_space)
        expand_top += min(delta - (expand_top + expand_bottom), top_space - expand_top)
        y_min -= expand_top
        y_max += expand_bottom

    return max(0, x_min), max(0, y_min), min(w, x_max), min(h, y_max)


def _patchify_mask(mask, patch_size=14):
    if mask is None:
        return None
    b, img_size, _, _ = mask.shape
    toks = img_size // patch_size
    return torch.nn.MaxPool2d(kernel_size=(patch_size, patch_size), stride=patch_size)(mask.view(b, img_size, img_size)).view(b, toks, toks, 1)


def _prepare_image_and_mask(clip_vision, image, mask, mode, autocrop_margin, desired_size=384):
    mode_index = IMAGE_MODES.index(mode)
    batch, height, width, _ = image.shape
    if mode_index == 0:
        img_size = min(height, width)
        ratio = desired_size / img_size
        resized_w, resized_h = round(width * ratio), round(height * ratio)
        image, mask = _crop(image, _standardize_mask(mask), ((resized_w - desired_size) // 2, (resized_h - desired_size) // 2, resized_w, resized_h), desired_size)
    elif mode_index == 1:
        if mask is None:
            mask = torch.ones(size=(batch, height, width), device=image.device, dtype=image.dtype)
        img_size = max(height, width)
        ratio = desired_size / img_size
        resized_w, resized_h = round(width * ratio), round(height * ratio)
        image, mask = _letterbox(image, _standardize_mask(mask), resized_w, resized_h, desired_size)
    else:
        if mask is None:
            raise RuntimeError("模式为“autocrop with mask”时必须接入遮罩。")
        bx, by, bx2, by2 = _get_bounding_box(mask, width, height, autocrop_margin, desired_size)
        image = image[:, by:by2, bx:bx2, :]
        mask = mask[:, by:by2, bx:bx2]
        img_size = max(bx2 - bx, by2 - by)
        ratio = desired_size / img_size
        resized_w, resized_h = round((bx2 - bx) * ratio), round((by2 - by) * ratio)
        image, mask = _letterbox(image, _standardize_mask(mask), resized_w, resized_h, desired_size)
    return image, mask


class GJJ_ReduxAdvanced:
    CATEGORY = "GJJ"
    FUNCTION = "apply_redux"
    DESCRIPTION = "内部加载 CLIP Vision 与 Redux 风格模型，将图像风格特征编码后拼接到 conditioning，并支持遮罩与自动裁切。"
    SEARCH_ALIASES = ["redux", "advanced redux", "style model", "advanced reflux control"]
    RETURN_TYPES = ("CONDITIONING", "IMAGE", "MASK")
    RETURN_NAMES = ("重绘条件输出", "重绘图像输出", "重绘遮罩输出")
    OUTPUT_TOOLTIPS = (
        "将 Redux 风格条件拼接到原 conditioning 后输出。",
        "传出实际用于 Redux 编码的图像。",
        "传出实际用于 Redux 编码的遮罩；如果未使用遮罩则为空。",
    )

    def __init__(self):
        self._clip_vision_cache_name = None
        self._clip_vision_cache = None
        self._style_model_cache_name = None
        self._style_model_cache = None

    @classmethod
    def INPUT_TYPES(cls):
        clip_vision_models = _safe_filename_list("clip_vision") or [""]
        style_models = _safe_filename_list("style_models") or [""]
        return {
            "required": {
                "conditioning": ("CONDITIONING", {
                    "display_name": "条件输入",
                    "tooltip": "接入原始正向条件，节点会把 Redux 条件拼接到其后。",
                }),
                "image": ("IMAGE", {
                    "display_name": "图像输入",
                    "tooltip": "接入需要提取 Redux 风格特征的图像。",
                }),
                "clip_vision_name": (clip_vision_models, {
                    "default": _preferred_default(clip_vision_models, DEFAULT_CLIP_VISION),
                    "display_name": "CLIP视觉模型",
                    "tooltip": "默认使用 sigclip_vision_patch14_384.safetensors。",
                }),
                "style_model_name": (style_models, {
                    "default": _preferred_default(style_models, DEFAULT_STYLE_MODEL),
                    "display_name": "风格模型",
                    "tooltip": "默认使用 flux1-redux-dev.safetensors。",
                }),
                "downsampling_factor": ("FLOAT", {
                    "default": 3.0,
                    "min": 1.0,
                    "max": 9.0,
                    "step": 0.1,
                    "display_name": "下采样倍率",
                    "tooltip": "Redux 条件 token 的压缩倍率，越大越精简。",
                }),
                "downsampling_function": (DOWN_SAMPLE_MODES, {
                    "default": "area",
                    "display_name": "下采样方式",
                    "tooltip": "Redux 条件下采样时使用的插值算法。",
                }),
                "mode": (IMAGE_MODES, {
                    "default": "center crop (square)",
                    "display_name": "图像模式",
                    "tooltip": "控制图像如何被裁切或补边后送入 CLIP Vision。",
                }),
                "weight": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display_name": "权重",
                    "tooltip": "Redux 条件整体强度。",
                }),
            },
            "optional": {
                "mask": ("MASK", {
                    "display_name": "遮罩输入",
                    "tooltip": "可选遮罩。使用 autocrop with mask 模式时必须接入。",
                }),
                "autocrop_margin": ("FLOAT", {
                    "default": 0.1,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display_name": "自动裁切边距",
                    "tooltip": "autocrop with mask 模式下，遮罩框额外向外扩张的比例。",
                }),
            },
        }

    def _load_clip_vision(self, clip_vision_name: str):
        if self._clip_vision_cache_name == clip_vision_name and self._clip_vision_cache is not None:
            return self._clip_vision_cache
        clip_path = folder_paths.get_full_path_or_raise("clip_vision", clip_vision_name)
        clip_vision = comfy.clip_vision.load(clip_path)
        if clip_vision is None:
            raise RuntimeError("CLIP视觉模型无效，未能加载有效的 vision 模型。")
        self._clip_vision_cache_name = clip_vision_name
        self._clip_vision_cache = clip_vision
        return clip_vision

    def _load_style_model(self, style_model_name: str):
        if self._style_model_cache_name == style_model_name and self._style_model_cache is not None:
            return self._style_model_cache
        style_model_path = folder_paths.get_full_path_or_raise("style_models", style_model_name)
        style_model = comfy.sd.load_style_model(style_model_path)
        self._style_model_cache_name = style_model_name
        self._style_model_cache = style_model
        return style_model

    def apply_redux(
        self,
        conditioning,
        image,
        clip_vision_name,
        style_model_name,
        downsampling_factor,
        downsampling_function,
        mode,
        weight,
        mask=None,
        autocrop_margin=0.0,
    ):
        clip_vision = self._load_clip_vision(clip_vision_name)
        style_model = self._load_style_model(style_model_name)

        desired_size = 384
        patch_size = 14
        try:
            if clip_vision.model.vision_model.embeddings.position_embedding.weight.shape[0] == 1024:
                desired_size = 512
                patch_size = 16
        except Exception:
            pass

        prepared_image, output_mask = _prepare_image_and_mask(
            clip_vision,
            image,
            mask,
            mode,
            float(autocrop_margin),
            desired_size,
        )
        clip_vision_output = clip_vision.encode_image(prepared_image)
        patched_mask = _patchify_mask(output_mask, patch_size)

        cond = style_model.get_cond(clip_vision_output).flatten(start_dim=0, end_dim=1).unsqueeze(dim=0)
        b, t, h = cond.shape
        m = int(np.sqrt(t))

        if float(downsampling_factor) > 1:
            cond = cond.view(b, m, m, h)
            if patched_mask is not None:
                cond = cond * patched_mask
            downsampled_size = (round(m / float(downsampling_factor)), round(m / float(downsampling_factor)))
            cond = torch.nn.functional.interpolate(
                cond.transpose(1, -1),
                size=downsampled_size,
                mode=downsampling_function,
            )
            cond = cond.transpose(1, -1).reshape(b, -1, h)
            if patched_mask is not None:
                patched_mask = torch.nn.functional.interpolate(
                    patched_mask.view(b, m, m, 1).transpose(1, -1),
                    size=downsampled_size,
                    mode="area",
                ).transpose(-1, 1)

        cond = cond * (float(weight) * float(weight))
        if patched_mask is not None:
            keep_mask = (patched_mask > 0).reshape(b, -1)
            max_len = keep_mask.sum(dim=1).max().item()
            padded_embeddings = torch.zeros((b, max_len, h), dtype=cond.dtype, device=cond.device)
            for index in range(b):
                filtered = cond[index][keep_mask[index]]
                padded_embeddings[index, :filtered.size(0)] = filtered
            cond = padded_embeddings

        output_conditioning = []
        for item in conditioning:
            output_conditioning.append([torch.cat((item[0], cond), dim=1), item[1].copy()])

        return (
            output_conditioning,
            prepared_image,
            output_mask.squeeze(-1) if output_mask is not None else None,
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ReduxAdvanced}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧠 Redux高级条件器"}
