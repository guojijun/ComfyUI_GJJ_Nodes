from __future__ import annotations

import math
from typing import Any

import comfy.samplers
import comfy.utils
import torch
from comfy import model_management
from nodes import CLIPTextEncode, ConditioningZeroOut
from PIL import Image

from .gjj_ultimate_runtime import (
    USDUMode,
    USDUSFMode,
    UltimateRedrawProcessor,
    UltimateSDProcessing,
    UltimateSeamFixProcessor,
    count_total_jobs,
)
from .gjj_ultimate_utils import pil_to_tensor, tensor_to_pil
from .gjj_model_upscaler import _load_upscale_model, _list_upscale_models


NODE_NAME = "GJJ_UltimateArchitectureUpscaler"
DETAIL_PRESET_OPTIONS = ["通用", "建筑外立面", "室内硬装", "软装家具", "材质纹理"]
SIZE_MODE_OPTIONS = ["按倍率", "按尺寸"]
MODE_OPTIONS = {"Linear": USDUMode.LINEAR, "Chess": USDUMode.CHESS, "None": USDUMode.NONE}
SEAM_FIX_OPTIONS = {
    "None": USDUSFMode.NONE,
    "Band Pass": USDUSFMode.BAND_PASS,
    "Half Tile": USDUSFMode.HALF_TILE,
    "Half Tile + Intersections": USDUSFMode.HALF_TILE_PLUS_INTERSECTIONS,
}
DETAIL_PRESET_PROMPTS = {
    "通用": "",
    "建筑外立面": (
        "architectural facade, exterior elevation, crisp windows, clean wall edges, "
        "high detail building materials, realistic facade texture, sharp structural lines"
    ),
    "室内硬装": (
        "interior design, cabinetry, wall paneling, flooring, ceiling details, realistic room materials, "
        "clean architectural lines, photorealistic renovation detail"
    ),
    "软装家具": (
        "furniture detail, fabric texture, leather texture, wood grain, decorative objects, "
        "clean upholstery edges, realistic furnishing detail"
    ),
    "材质纹理": (
        "high detail material texture, wood grain, stone, marble, concrete, ceramic, metal, "
        "clean surface detail, realistic texture fidelity"
    ),
}
DEFAULT_NEGATIVE_PROMPT = (
    "lowres, blurry, noisy, soft focus, distorted perspective, warped lines, crooked edges, "
    "melted furniture, duplicate objects, broken windows, deformed architecture, text, watermark, logo"
)
DEFAULT_UPSCALE_MODEL = "2xNomosUni_span_multijpg_ldl.pth"


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


def _preferred_default(values: list[str], preferred: str) -> str:
    preferred = str(preferred or "").strip()
    if preferred and preferred in values:
        return preferred
    return values[0] if values else ""


def _join_prompt_parts(*parts: str) -> str:
    values = [str(item or "").strip() for item in parts if str(item or "").strip()]
    return ", ".join(values)


def _resolve_target_size(image, size_mode: str, upscale_by: float, target_width: int, target_height: int) -> tuple[int, int]:
    width = int(image.shape[2])
    height = int(image.shape[1])
    if str(size_mode or "") == "按尺寸":
        return (
            max(8, math.ceil(int(target_width) / 8) * 8),
            max(8, math.ceil(int(target_height) / 8) * 8),
        )
    return (
        max(8, math.ceil(width * float(upscale_by) / 8) * 8),
        max(8, math.ceil(height * float(upscale_by) / 8) * 8),
    )


def _resize_batch_lanczos(image, width: int, height: int):
    pil_images = [tensor_to_pil(image, index) for index in range(len(image))]
    resized = [img.resize((width, height), Image.Resampling.LANCZOS) for img in pil_images]
    return torch.cat([pil_to_tensor(img) for img in resized], dim=0)


def _apply_upscale_model(image, upscale_model):
    device = model_management.get_torch_device()
    memory_required = model_management.module_size(upscale_model.model)
    memory_required += (512 * 512 * 3) * image.element_size() * max(upscale_model.scale, 1.0) * 384.0
    memory_required += image.nelement() * image.element_size()
    model_management.free_memory(memory_required, device)

    upscale_model.to(device)
    input_image = image.movedim(-1, -3).to(device)
    tile = 512
    overlap = 32
    try:
        while True:
            try:
                steps = input_image.shape[0] * comfy.utils.get_tiled_scale_steps(
                    input_image.shape[3],
                    input_image.shape[2],
                    tile_x=tile,
                    tile_y=tile,
                    overlap=overlap,
                )
                progress = comfy.utils.ProgressBar(steps)
                scaled = comfy.utils.tiled_scale(
                    input_image,
                    lambda tensor: upscale_model(tensor),
                    tile_x=tile,
                    tile_y=tile,
                    overlap=overlap,
                    upscale_amount=upscale_model.scale,
                    pbar=progress,
                )
                return torch.clamp(scaled.movedim(-3, -1), min=0.0, max=1.0)
            except Exception as exc:
                model_management.raise_non_oom(exc)
                tile //= 2
                if tile < 128:
                    raise exc
    finally:
        upscale_model.to("cpu")


def _upscale_to_target(image, enable_upscale_model: bool, upscale_model_name: str, target_width: int, target_height: int):
    if not bool(enable_upscale_model) or not str(upscale_model_name or "").strip():
        return _resize_batch_lanczos(image, target_width, target_height)

    scaled = _apply_upscale_model(image, _load_upscale_model(upscale_model_name))
    if int(scaled.shape[2]) == int(target_width) and int(scaled.shape[1]) == int(target_height):
        return scaled
    return _resize_batch_lanczos(scaled, target_width, target_height)


class GJJ_UltimateArchitectureUpscaler:
    CATEGORY = "GJJ"
    FUNCTION = "upscale"
    DESCRIPTION = "将基础超分、建筑装饰细节增强提示词、Ultimate 分块重绘与接缝修复整合成单节点放大流程。"
    SEARCH_ALIASES = [
        "ultimate sd upscale",
        "终极放大",
        "建筑放大",
        "室内设计放大",
        "tile upscale",
        "建筑装饰放大",
    ]
    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("基础放大结果", "终极放大结果")
    OUTPUT_TOOLTIPS = (
        "先经过内部放大模型或 Lanczos 放大的基础图像，可用于检查底图放大质量。",
        "再经过 Ultimate 分块重绘和接缝修复后的最终图像。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        upscale_models = _list_upscale_models() or [""]
        return {
            "required": {
                "image": ("IMAGE", {
                    "display_name": "输入图像",
                    "tooltip": "需要执行建筑装饰放大的输入图像。",
                }),
                "model": ("MODEL", {
                    "display_name": "MODEL 输入",
                    "tooltip": "外部主扩散模型输入；建议连接 Flux1双CLIP加载器 或其它模型加载节点的 MODEL。",
                }),
                "clip": ("CLIP", {
                    "display_name": "CLIP 输入",
                    "tooltip": "外部 CLIP 输入；当前节点会在内部把提示词编码成条件。",
                }),
                "vae": ("VAE", {
                    "display_name": "VAE 输入",
                    "tooltip": "外部 VAE 输入，用于图像编解码。",
                }),
                "detail_preset": (DETAIL_PRESET_OPTIONS, {
                    "default": "室内硬装",
                    "display_name": "细节预设",
                    "tooltip": "给建筑外立面、室内硬装、软装家具和材质纹理补上更合适的放大增强提示词。",
                }),
                "positive": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "dynamicPrompts": True,
                    "display_name": "正向提示词",
                    "tooltip": "会与上面的建筑装饰细节预设一起编码成正面条件。",
                    "placeholder": "请输入建筑或室内细节增强提示词",
                }),
                "negative": ("STRING", {
                    "default": DEFAULT_NEGATIVE_PROMPT,
                    "multiline": False,
                    "dynamicPrompts": True,
                    "display_name": "反向提示词",
                    "tooltip": "用于约束变形、糊化、透视错误和建筑结构崩坏等问题。",
                    "placeholder": "请输入需要排除的瑕疵",
                }),
                "enable_upscale_model": ("BOOLEAN", {
                    "default": True,
                    "display_name": "启用基础放大模型",
                    "tooltip": "开启时先用 models/upscale_models 里的超分模型放大，再进入 Ultimate 分块重绘；关闭时改用 Lanczos。",
                }),
                "upscale_model_name": (upscale_models, {
                    "default": _preferred_default(upscale_models, DEFAULT_UPSCALE_MODEL),
                    "display_name": "基础放大模型",
                    "tooltip": "从 models/upscale_models 目录中选择一个基础放大模型。",
                }),
                "size_mode": (SIZE_MODE_OPTIONS, {
                    "default": "按倍率",
                    "display_name": "目标尺寸模式",
                    "tooltip": "可按倍率放大，也可直接指定目标宽高。",
                }),
                "upscale_by": ("FLOAT", {
                    "default": 2.0,
                    "min": 1.0,
                    "max": 8.0,
                    "step": 0.05,
                    "display_name": "放大倍率",
                    "tooltip": "当目标尺寸模式为按倍率时使用。",
                }),
                "target_width": ("INT", {
                    "default": 2048,
                    "min": 64,
                    "max": 16384,
                    "step": 8,
                    "display_name": "目标宽度",
                    "tooltip": "当目标尺寸模式为按尺寸时使用。",
                }),
                "target_height": ("INT", {
                    "default": 2048,
                    "min": 64,
                    "max": 16384,
                    "step": 8,
                    "display_name": "目标高度",
                    "tooltip": "当目标尺寸模式为按尺寸时使用。",
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 0xFFFFFFFFFFFFFFFF,
                    "display_name": "随机种子",
                    "tooltip": "分块重绘的随机种子。",
                }),
                "steps": ("INT", {
                    "default": 20,
                    "min": 1,
                    "max": 10000,
                    "display_name": "步数",
                    "tooltip": "每个 tile 的采样步数。",
                }),
                "cfg": ("FLOAT", {
                    "default": 7.0,
                    "min": 0.0,
                    "max": 100.0,
                    "step": 0.1,
                    "display_name": "CFG 引导强度",
                    "tooltip": "每个 tile 的提示词引导强度。",
                }),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {
                    "display_name": "采样器",
                    "tooltip": "Ultimate 分块重绘时使用的采样器。",
                }),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {
                    "display_name": "调度器",
                    "tooltip": "Ultimate 分块重绘时使用的调度器。",
                }),
                "denoise": ("FLOAT", {
                    "default": 0.28,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display_name": "重绘降噪",
                    "tooltip": "数值越高，tile 重绘幅度越大；建筑装饰放大通常建议 0.18~0.35。",
                }),
                "mode_type": (list(MODE_OPTIONS.keys()), {
                    "default": "Chess",
                    "display_name": "重绘模式",
                    "tooltip": "Chess 一般更稳，Linear 更直接，None 则只做基础放大。",
                }),
                "tile_width": ("INT", {
                    "default": 1024,
                    "min": 64,
                    "max": 8192,
                    "step": 8,
                    "display_name": "Tile 宽度",
                    "tooltip": "建筑和室内图常用 768~1280；越大越吃显存。",
                }),
                "tile_height": ("INT", {
                    "default": 1024,
                    "min": 64,
                    "max": 8192,
                    "step": 8,
                    "display_name": "Tile 高度",
                    "tooltip": "建议与 Tile 宽度相近，保持稳定细节分布。",
                }),
                "mask_blur": ("INT", {
                    "default": 8,
                    "min": 0,
                    "max": 64,
                    "display_name": "重绘遮罩模糊",
                    "tooltip": "tile 边缘过渡模糊半径；能缓和接缝。",
                }),
                "tile_padding": ("INT", {
                    "default": 32,
                    "min": 0,
                    "max": 1024,
                    "step": 8,
                    "display_name": "重绘边缘补偿",
                    "tooltip": "每个 tile 额外带入的上下文范围。",
                }),
                "seam_fix_mode": (list(SEAM_FIX_OPTIONS.keys()), {
                    "default": "Half Tile",
                    "display_name": "接缝修复模式",
                    "tooltip": "建筑装饰图建议用 Half Tile 或 Half Tile + Intersections。",
                }),
                "seam_fix_denoise": ("FLOAT", {
                    "default": 0.35,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display_name": "接缝修复降噪",
                    "tooltip": "接缝修复阶段的降噪强度。",
                }),
                "seam_fix_width": ("INT", {
                    "default": 64,
                    "min": 0,
                    "max": 1024,
                    "step": 8,
                    "display_name": "Band 宽度",
                    "tooltip": "Band Pass 模式使用的条带宽度。",
                }),
                "seam_fix_mask_blur": ("INT", {
                    "default": 4,
                    "min": 0,
                    "max": 64,
                    "display_name": "接缝遮罩模糊",
                    "tooltip": "接缝修复遮罩的模糊半径。",
                }),
                "seam_fix_padding": ("INT", {
                    "default": 16,
                    "min": 0,
                    "max": 1024,
                    "step": 8,
                    "display_name": "接缝边缘补偿",
                    "tooltip": "接缝修复时额外带入的上下文范围。",
                }),
                "force_uniform_tiles": ("BOOLEAN", {
                    "default": True,
                    "display_name": "强制统一 Tile 尺寸",
                    "tooltip": "开启后所有 tile 都按同一尺寸处理，建筑和室内图通常更稳定。",
                }),
                "tiled_decode": ("BOOLEAN", {
                    "default": False,
                    "display_name": "启用分块解码",
                    "tooltip": "显存紧张时可开启 VAE 分块解码。",
                }),
                "tile_batch_size": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 64,
                    "display_name": "Tile 批大小",
                    "tooltip": "一次并行处理多少个 tile；大于 1 时需要开启统一 Tile 尺寸。",
                }),
            }
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        values = [str(kwargs.get(name, "")) for name in sorted(kwargs.keys())]
        return "|".join(values)

    def upscale(
        self,
        image,
        model,
        clip,
        vae,
        detail_preset,
        positive,
        negative,
        enable_upscale_model,
        upscale_model_name,
        size_mode,
        upscale_by,
        target_width,
        target_height,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        mode_type,
        tile_width,
        tile_height,
        mask_blur,
        tile_padding,
        seam_fix_mode,
        seam_fix_denoise,
        seam_fix_width,
        seam_fix_mask_blur,
        seam_fix_padding,
        force_uniform_tiles,
        tiled_decode,
        tile_batch_size,
    ):
        if model is None:
            raise RuntimeError("MODEL 输入不能为空。")
        if clip is None:
            raise RuntimeError("CLIP 输入不能为空。")
        if vae is None:
            raise RuntimeError("VAE 输入不能为空。")
        if int(tile_batch_size) > 1 and not bool(force_uniform_tiles):
            raise RuntimeError("Tile 批大小大于 1 时，请开启“强制统一 Tile 尺寸”。")

        preset_prompt = DETAIL_PRESET_PROMPTS.get(str(detail_preset or "通用"), "")
        positive_text = _join_prompt_parts(preset_prompt, _normalize_text(positive))
        negative_text = _normalize_text(negative)

        positive_conditioning = CLIPTextEncode().encode(clip, positive_text)[0]
        if negative_text:
            negative_conditioning = CLIPTextEncode().encode(clip, negative_text)[0]
        else:
            negative_conditioning = ConditioningZeroOut().zero_out(positive_conditioning)[0]

        resolved_width, resolved_height = _resolve_target_size(image, size_mode, upscale_by, target_width, target_height)
        base_upscaled = _upscale_to_target(
            image,
            enable_upscale_model=enable_upscale_model,
            upscale_model_name=upscale_model_name,
            target_width=resolved_width,
            target_height=resolved_height,
        )

        base_pils = [tensor_to_pil(base_upscaled, index) for index in range(len(base_upscaled))]
        rows = math.ceil(resolved_height / max(8, int(tile_height)))
        cols = math.ceil(resolved_width / max(8, int(tile_width)))
        redraw_mode_value = MODE_OPTIONS[str(mode_type)]
        seam_fix_mode_value = SEAM_FIX_OPTIONS[str(seam_fix_mode)]

        processing = UltimateSDProcessing(
            batch=base_pils,
            init_size=(int(image.shape[2]), int(image.shape[1])),
            model=model,
            positive=positive_conditioning,
            negative=negative_conditioning,
            vae=vae,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            denoise=denoise,
            target_width=resolved_width,
            target_height=resolved_height,
            tile_width=tile_width,
            tile_height=tile_height,
            force_uniform_tiles=force_uniform_tiles,
            tiled_decode=tiled_decode,
            tile_batch_size=tile_batch_size,
            total_jobs=count_total_jobs(redraw_mode_value, seam_fix_mode_value, rows, cols),
        )

        UltimateRedrawProcessor(
            mode=redraw_mode_value,
            tile_width=int(tile_width),
            tile_height=int(tile_height),
            padding=int(tile_padding),
            mask_blur=int(mask_blur),
        ).start(processing, rows, cols)

        UltimateSeamFixProcessor(
            mode=seam_fix_mode_value,
            tile_width=int(tile_width),
            tile_height=int(tile_height),
            padding=int(seam_fix_padding),
            denoise=float(seam_fix_denoise),
            mask_blur=int(seam_fix_mask_blur),
            band_width=int(seam_fix_width),
        ).start(processing, rows, cols)

        final_tensor = torch.cat([pil_to_tensor(img) for img in processing.batch], dim=0)
        return (base_upscaled, final_tensor)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_UltimateArchitectureUpscaler}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🏛️ 建筑装饰终极放大器"}
