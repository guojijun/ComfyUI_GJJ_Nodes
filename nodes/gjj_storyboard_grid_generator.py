from __future__ import annotations

import json
import os
import re
import uuid
from typing import Any

import comfy.samplers
import folder_paths
import numpy as np
import torch
from PIL import Image

from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .common_utils.model_family import gjjutils_model_family_match_preset as _match_model_family_preset
from .gjj_lazy_image_studio import (
    DEFAULT_CLIP_NAME,
    DEFAULT_UNET_DTYPE,
    DEFAULT_UNET_NAME,
    DEFAULT_VAE_NAME,
    GJJ_LazyImageStudio,
    MAX_MAIN_IMAGE_INDEX,
    UNET_DTYPE_OPTIONS,
    _list_lazy_clip_models,
    _list_lazy_unet_models,
    _preferred_default,
)
from .gjj_model_bundle_loader import list_vae_models
from .gjj_reference_grid_generator import (
    FIT_MODES,
    LAYOUT_MODES,
    SIZE_ALIGN_MODES,
    UPSCALE_METHODS,
    _align_down,
    _alignment_multiple,
    _first_scalar,
    _fit_cell,
)


NODE_NAME = "GJJ_StoryboardGridGenerator"
IMAGE_INPUT_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
MIXED_IMAGE_OUTPUT = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
PREVIEW_SUBFOLDER = "gjj_storyboard_grid_generator"


def _send_status(unique_id: Any, text: str) -> None:
    if unique_id is None or _safe_text(unique_id).strip() == "":
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": _safe_text(text).strip() or "处理中..."},
        )
    except Exception:
        pass


def _send_live_preview(unique_id: Any, image: torch.Tensor, index: int, total: int) -> None:
    if unique_id is None or _safe_text(unique_id).strip() == "" or not isinstance(image, torch.Tensor):
        return
    try:
        preview = _ensure_bhwc_rgb(image)[:1].detach().float().clamp(0.0, 1.0).cpu()[0]
        array = (preview.numpy() * 255.0).round().astype(np.uint8)
        out_dir = os.path.join(folder_paths.get_temp_directory(), PREVIEW_SUBFOLDER)
        os.makedirs(out_dir, exist_ok=True)
        filename = f"storyboard_{uuid.uuid4().hex[:12]}_{int(index):03d}.png"
        Image.fromarray(array, "RGB").save(os.path.join(out_dir, filename), compress_level=4)

        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_storyboard_grid_preview",
            {
                "node": str(unique_id),
                "index": int(index),
                "total": int(total),
                "image": {
                    "filename": filename,
                    "subfolder": PREVIEW_SUBFOLDER,
                    "type": "temp",
                },
            },
        )
    except Exception as exc:
        print(f"[GJJ StoryboardGridGenerator] 发送实时预览失败: {exc}")


def _split_prompt_segments(prompt: Any) -> list[str]:
    text = _safe_text(prompt).strip()
    if not text:
        return []
    parts = re.split(r"(?:^\s*---+\s*$)|(?:\n\s*\n+)", text, flags=re.MULTILINE)
    return [part.strip() for part in parts if part.strip()]


def _split_media(value: Any) -> list[torch.Tensor]:
    if value is None:
        return []
    if isinstance(value, torch.Tensor):
        tensor = _ensure_bhwc_rgb(value)
        return [tensor[index : index + 1].contiguous() for index in range(int(tensor.shape[0]))]
    if isinstance(value, dict):
        images: list[torch.Tensor] = []
        for item in value.values():
            images.extend(_split_media(item))
        return images
    if isinstance(value, (list, tuple)):
        images: list[torch.Tensor] = []
        for item in value:
            images.extend(_split_media(item))
        return images
    return []


def _safe_text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, torch.Tensor):
        if value.numel() == 0:
            return default
        if value.numel() == 1:
            try:
                return str(value.detach().cpu().reshape(-1)[0].item())
            except Exception:
                return default
        return default
    return str(value)


def _ensure_bhwc_rgb(image: torch.Tensor) -> torch.Tensor:
    tensor = image.detach().float().clamp(0.0, 1.0)
    if tensor.ndim == 3:
        if int(tensor.shape[-1]) in (1, 3, 4):
            tensor = tensor.unsqueeze(0)
        elif int(tensor.shape[0]) in (1, 3, 4):
            tensor = tensor.movedim(0, -1).unsqueeze(0)
        else:
            raise RuntimeError(f"场景图维度不支持：{tuple(tensor.shape)}")
    if tensor.ndim != 4:
        raise RuntimeError(f"场景图维度不支持：{tuple(tensor.shape)}")
    if int(tensor.shape[-1]) not in (1, 3, 4) and int(tensor.shape[1]) in (1, 3, 4):
        tensor = tensor.movedim(1, -1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels > 3:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"场景图通道数不支持：{channels}")
    return tensor.contiguous()


def _resize_crop_short_edge(image: torch.Tensor, target_width: int, target_height: int) -> torch.Tensor:
    target_width = _align_down(target_width, 32, 64)
    target_height = _align_down(target_height, 32, 64)
    tensor = _ensure_bhwc_rgb(image)
    source_height = int(tensor.shape[1])
    source_width = int(tensor.shape[2])
    if source_width <= 0 or source_height <= 0:
        raise RuntimeError("场景图尺寸无效，无法短边缩放裁剪。")

    scale = max(target_width / source_width, target_height / source_height)
    resized_width = max(target_width, int(round(source_width * scale)))
    resized_height = max(target_height, int(round(source_height * scale)))
    nchw = tensor.movedim(-1, 1)
    resized = torch.nn.functional.interpolate(
        nchw,
        size=(resized_height, resized_width),
        mode="bilinear",
        align_corners=False,
        antialias=True,
    ).movedim(1, -1)

    top = max(0, (resized_height - target_height) // 2)
    left = max(0, (resized_width - target_width) // 2)
    return resized[:, top : top + target_height, left : left + target_width, :].clamp(0.0, 1.0).contiguous()


def _resize_fit_reference(image: torch.Tensor, target_width: int, target_height: int) -> torch.Tensor:
    target_width = _align_down(target_width, 32, 64)
    target_height = _align_down(target_height, 32, 64)
    tensor = _ensure_bhwc_rgb(image)
    source_height = int(tensor.shape[1])
    source_width = int(tensor.shape[2])
    if source_width <= 0 or source_height <= 0:
        raise RuntimeError("参考图尺寸无效，无法缩放到目标尺寸。")

    scale = min(target_width / source_width, target_height / source_height)
    resized_width = max(1, min(target_width, int(round(source_width * scale))))
    resized_height = max(1, min(target_height, int(round(source_height * scale))))
    resized = torch.nn.functional.interpolate(
        tensor.movedim(-1, 1),
        size=(resized_height, resized_width),
        mode="bilinear",
        align_corners=False,
        antialias=True,
    ).movedim(1, -1)
    canvas = torch.zeros((int(tensor.shape[0]), target_height, target_width, 3), dtype=resized.dtype, device=resized.device)
    top = max(0, (target_height - resized_height) // 2)
    left = max(0, (target_width - resized_width) // 2)
    canvas[:, top : top + resized_height, left : left + resized_width, :] = resized
    return canvas.clamp(0.0, 1.0).contiguous()


def _reference_signature(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, torch.Tensor):
        return [str(tuple(value.shape))]
    if isinstance(value, dict):
        result: list[str] = []
        for key in sorted(value, key=str):
            result.extend(_reference_signature(value[key]))
        return result
    if isinstance(value, (list, tuple)):
        result: list[str] = []
        for item in value:
            result.extend(_reference_signature(item))
        return result
    return [str(type(value).__name__)]


def _grid_geometry(
    count: int,
    width: int,
    height: int,
    layout_mode: str,
    gap: int,
    size_alignment: str,
) -> tuple[int, int, int, int, int, int]:
    width = max(64, int(width))
    height = max(64, int(height))
    gap = max(0, int(gap))
    count = max(1, int(count))
    storyboard_layouts = {
        1: (1, 1),
        2: (2, 1),
        3: (3, 1),
        4: (2, 2),
        5: (3, 2),
        6: (3, 2),
        7: (4, 2),
        8: (4, 2),
        9: (3, 3),
        10: (5, 2),
        11: (4, 3),
        12: (4, 3),
    }
    if count in storyboard_layouts:
        cols, rows = storyboard_layouts[count]
    else:
        cols = max(1, int(round(count ** 0.5)))
        while cols * cols < count:
            cols += 1
        rows = int((count + cols - 1) // cols)
        if rows > 1 and (cols - 1) * rows >= count:
            cols -= 1
        rows = int((count + cols - 1) // cols)
    multiple = _alignment_multiple(size_alignment)
    cell_w = _align_down(width, multiple, 64)
    cell_h = _align_down(height, multiple, 64)
    canvas_w = cell_w * cols + gap * (cols + 1)
    canvas_h = cell_h * rows + gap * (rows + 1)
    return cols, rows, cell_w, cell_h, canvas_w, canvas_h


def _make_grid(
    images: list[torch.Tensor],
    width: int,
    height: int,
    layout_mode: str,
    gap: int,
    fit_mode: str,
    resize_method: str,
    size_alignment: str,
) -> torch.Tensor:
    if not images:
        raise RuntimeError("没有生成到分镜图片，无法拼接智能宫格图。")
    cols, _rows, cell_w, cell_h, canvas_w, canvas_h = _grid_geometry(
        len(images), width, height, layout_mode, gap, size_alignment
    )
    first = images[0]
    canvas = torch.zeros((1, canvas_h, canvas_w, 3), dtype=first.dtype, device=first.device)
    gap = max(0, int(gap))
    for index, image in enumerate(images):
        cell = _fit_cell(
            image[:1].to(device=first.device, dtype=first.dtype).clamp(0.0, 1.0),
            cell_w,
            cell_h,
            _safe_text(fit_mode, "铺满裁切") or "铺满裁切",
            0.0,
            resize_method,
        )
        row = index // cols
        col = index % cols
        top = gap + row * (cell_h + gap)
        left = gap + col * (cell_w + gap)
        canvas[:, top : top + cell_h, left : left + cell_w, :] = cell
    return canvas.clamp(0.0, 1.0).contiguous()


def _lazy_optional_images(scene: Any, reference: Any, width: int, height: int) -> dict[str, torch.Tensor]:
    scene_images = [_resize_crop_short_edge(image, width, height) for image in _split_media(scene)]
    reference_images = [_resize_fit_reference(image, width, height) for image in _split_media(reference)]
    images = [*scene_images, *reference_images]
    if not images:
        return {}
    base = _ensure_bhwc_rgb(images[0])[:1].detach().float().clamp(0.0, 1.0).contiguous()
    one_each = [base]
    for image in images[1:]:
        one_each.append(
            _ensure_bhwc_rgb(image)[:1]
            .detach()
            .to(device=base.device, dtype=base.dtype)
            .clamp(0.0, 1.0)
            .contiguous()
        )
    return {"image_01": torch.cat(one_each, dim=0)}


def _normalize_strength(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except Exception:
        return float(fallback)


def _parse_enabled(value: Any, fallback: bool = True) -> bool:
    text = str(value if value is not None else "").strip().lower()
    if not text:
        return bool(fallback)
    if text in {"1", "true", "yes", "on", "enable", "enabled", "启用", "开"}:
        return True
    if text in {"0", "false", "no", "off", "disable", "disabled", "关闭", "关"}:
        return False
    return bool(fallback)


def _has_configured_lora_data(value: Any) -> bool:
    text = _safe_text(value).strip()
    if not text or text == "[]":
        return False
    try:
        rows = json.loads(text)
    except Exception:
        return True
    if not isinstance(rows, list):
        return False
    return any(str(row.get("name", "")).strip() for row in rows if isinstance(row, dict))


def _preset_lora_data(unet_name: Any) -> str:
    preset = _match_model_family_preset(_safe_text(unet_name))
    if not preset or _safe_text(preset.get("id", "generic")) == "generic":
        return "[]"
    rows: list[dict[str, Any]] = []
    lora1 = _safe_text(preset.get("lora_1_name", "")).strip()
    if lora1:
        rows.append(
            {
                "enabled": _parse_enabled(preset.get("lora_1_auto_enabled"), True),
                "name": lora1,
                "strength": _normalize_strength(preset.get("lora_1_strength"), 1.0),
            }
        )
    lora2 = _safe_text(preset.get("lora_2_name", "")).strip()
    if lora2:
        rows.append(
            {
                "enabled": True,
                "name": lora2,
                "strength": _normalize_strength(preset.get("lora_2_strength"), 0.7),
            }
        )
    return json.dumps(rows, ensure_ascii=False) if rows else "[]"


class GJJ_StoryboardGridGenerator:
    CATEGORY = "GJJ/Image"
    FUNCTION = "generate"
    DESCRIPTION = "分镜宫格生成器：复用懒人图文集成一键生图流程，正向提示词按空行或 --- 分段生成，并智能拼接为宫格图。"
    SEARCH_ALIASES = ["分镜生成器", "智能宫格", "storyboard grid", "storyboard generator"]
    RETURN_TYPES = ("IMAGE", MIXED_IMAGE_OUTPUT)
    RETURN_NAMES = ("智能宫格图", "分镜图片")
    OUTPUT_TOOLTIPS = (
        "按生成图片数量自动排列并拼接后的宫格图。",
        "每个提示词分段生成的一张分镜图片批次。",
    )
    INPUT_IS_LIST = True
    OUTPUT_NODE = True
    GJJ_HELP = {
        "description": DESCRIPTION,
        "model_tree": True,
        "dynamic_model_tree_only": True,
        "notice": "正向提示词按空行或单独一行 --- 分段；每段会调用一次懒人图文集成一键生图流程。",
    }

    def __init__(self):
        self._lazy = GJJ_LazyImageStudio()

    @classmethod
    def INPUT_TYPES(cls):
        raw_unet_models = _list_lazy_unet_models() or [DEFAULT_UNET_NAME]
        diffusion_keywords = ["flux", "f2k", "zimage", "z_image", "z-image", "zit", "qwen", "firered", "boogu", "gguf"]
        filtered = [m for m in raw_unet_models if any(k in str(m).lower() for k in diffusion_keywords)]
        diffusion_models = filtered if filtered else raw_unet_models
        clip_models = _list_lazy_clip_models() or [DEFAULT_CLIP_NAME]
        vae_models = list_vae_models() or [DEFAULT_VAE_NAME]
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "✨ 正向提示词",
                        "tooltip": "按空行或单独一行 --- 分段；每段生成一张分镜图片。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "🚫 反向提示词",
                    },
                ),
                "main_image_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": MAX_MAIN_IMAGE_INDEX,
                        "display_name": "🎯 主图序号",
                    },
                ),
                "width": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8, "display_name": "📐 宽度"}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8, "display_name": "📏 高度"}),
                "batch_size": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 1,
                        "display_name": "🔢 批次数",
                        "tooltip": "分镜宫格固定为每个提示词分段生成一张图片。",
                    },
                ),
                "unet_name": (
                    diffusion_models,
                    {"default": _preferred_default(diffusion_models, DEFAULT_UNET_NAME), "display_name": "🟣 UNET 主模型"},
                ),
                "unet_dtype": (
                    UNET_DTYPE_OPTIONS,
                    {"default": DEFAULT_UNET_DTYPE, "display_name": "⚙️ UNET 精度"},
                ),
                "clip_name1": (
                    clip_models,
                    {"default": _preferred_default(clip_models, DEFAULT_CLIP_NAME), "display_name": "🟡 CLIP 编码器"},
                ),
                "vae_name": (
                    vae_models,
                    {"default": _preferred_default(vae_models, DEFAULT_VAE_NAME), "display_name": "🔴 VAE 解码器"},
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "🎲 种子",
                    },
                ),
                "steps": ("INT", {"default": 4, "min": 1, "max": 10000, "display_name": "👣 步数"}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01, "display_name": "⚖️ CFG 引导强度"}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler", "display_name": "🌀 采样器"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple", "display_name": "📊 调度器"}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "🔧 降噪"}),
                "grow_mask_by": ("INT", {"default": 6, "min": 0, "max": 64, "display_name": "🎭 遮罩扩张"}),
                "layout_mode": (LAYOUT_MODES, {"default": "自动", "display_name": "🔲 宫格布局"}),
                "gap": ("INT", {"default": 8, "min": 0, "max": 128, "step": 1, "display_name": "➗ 黑色间隔"}),
                "cell_fit": (FIT_MODES, {"default": "铺满裁切", "display_name": "🖼️ 单元适配"}),
                "resize_method": (UPSCALE_METHODS, {"default": "lanczos", "display_name": "🔍 缩放算法"}),
                "size_alignment": (SIZE_ALIGN_MODES, {"default": "LTX 32倍数", "display_name": "📐 尺寸对齐"}),
            },
            "optional": {
                "scene": (IMAGE_INPUT_TYPE, {"display_name": "🏞️ 场景", "tooltip": "接收上游素材/背景作为参考图参与生成；不会启用自动局部蒙版。"}),
                "reference": (IMAGE_INPUT_TYPE, {"display_name": "🖼️ 参考图", "tooltip": "接收上游素材/背景作为参考图参与生成；不会启用自动局部蒙版。"}),
                "lora_chain_config": ("LORA_CHAIN_CONFIG", {"display_name": "🔗 LoRA串联配置"}),
                "lora_data": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": False,
                        "display_name": "LoRA 配置",
                        "hidden": True,
                        "display": "hidden",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "prompt_graph": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @classmethod
    def IS_CHANGED(cls, scene=None, reference=None, **kwargs):
        shapes = [*_reference_signature(scene), *_reference_signature(reference)]
        return "|".join(str(kwargs.get(key, "")) for key in sorted(kwargs)) + "|" + "|".join(shapes)

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def generate(
        self,
        prompt,
        negative_prompt,
        main_image_index,
        width,
        height,
        batch_size,
        unet_name,
        unet_dtype,
        clip_name1,
        vae_name,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        grow_mask_by,
        layout_mode,
        gap,
        cell_fit,
        resize_method,
        size_alignment,
        scene=None,
        reference=None,
        lora_chain_config="",
        lora_data="[]",
        unique_id=None,
        prompt_graph=None,
        extra_pnginfo=None,
    ):
        prompt = _first_scalar(prompt)
        negative_prompt = _first_scalar(negative_prompt)
        main_image_index = _first_scalar(main_image_index)
        width = int(_first_scalar(width))
        height = int(_first_scalar(height))
        batch_size = int(_first_scalar(batch_size))
        unet_name = _first_scalar(unet_name)
        unet_dtype = _first_scalar(unet_dtype)
        clip_name1 = _first_scalar(clip_name1)
        vae_name = _first_scalar(vae_name)
        seed = int(_first_scalar(seed))
        steps = int(_first_scalar(steps))
        cfg = float(_first_scalar(cfg))
        sampler_name = _first_scalar(sampler_name)
        scheduler = _first_scalar(scheduler)
        denoise = float(_first_scalar(denoise))
        grow_mask_by = int(_first_scalar(grow_mask_by))
        layout_mode = _first_scalar(layout_mode)
        gap = int(_first_scalar(gap))
        cell_fit = _first_scalar(cell_fit)
        resize_method = _first_scalar(resize_method)
        size_alignment = _first_scalar(size_alignment)
        lora_chain_config = _first_scalar(lora_chain_config)
        lora_data = _first_scalar(lora_data)
        unique_id = _first_scalar(unique_id)
        if not _has_configured_lora_data(lora_data):
            lora_data = _preset_lora_data(unet_name)

        prompts = _split_prompt_segments(prompt)
        if not prompts:
            raise RuntimeError("正向提示词为空。请填写分镜提示词；用空行或单独一行 --- 分段。")

        _cols, _rows, cell_w, cell_h, _canvas_w, _canvas_h = _grid_geometry(
            len(prompts), width, height, layout_mode, gap, size_alignment
        )
        refs = _lazy_optional_images(scene, reference, cell_w, cell_h)
        generated: list[torch.Tensor] = []
        _send_status(unique_id, f"准备生成 {len(prompts)} 张分镜图片...")

        for index, line in enumerate(prompts, start=1):
            _send_status(unique_id, f"按懒人一键生图流程生成分镜 {index}/{len(prompts)}")
            result = self._lazy.create_image(
                prompt=line,
                negative_prompt=negative_prompt,
                main_image_index=main_image_index,
                width=cell_w,
                height=cell_h,
                batch_size=1,
                unet_name=unet_name,
                unet_dtype=unet_dtype,
                clip_name1=clip_name1,
                vae_name=vae_name,
                seed=seed + index - 1,
                steps=steps,
                cfg=cfg,
                sampler_name=sampler_name,
                scheduler=scheduler,
                denoise=denoise,
                grow_mask_by=grow_mask_by,
                lora_chain_config=lora_chain_config,
                lora_data=lora_data,
                batch_source_images="[]",
                disable_reference_auto_mask=True,
                prompt_graph=prompt_graph,
                unique_id=unique_id,
                extra_pnginfo=extra_pnginfo,
                **refs,
            )
            image = result.get("result", (None,))[0] if isinstance(result, dict) else None
            if not isinstance(image, torch.Tensor):
                raise RuntimeError(f"分镜 {index} 没有返回有效图片。")
            current = image[:1].detach().float().clamp(0.0, 1.0).contiguous()
            generated.append(current)
            _send_live_preview(unique_id, current, index, len(prompts))

        cells = torch.cat(generated, dim=0).contiguous()
        grid = _make_grid(generated, width, height, layout_mode, gap, cell_fit, resize_method, size_alignment)
        _send_status(unique_id, f"完成：{len(generated)} 张分镜，智能宫格 {grid.shape[2]} x {grid.shape[1]}")
        return (grid, cells)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_StoryboardGridGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 分镜宫格生成器"}
