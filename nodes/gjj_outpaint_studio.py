"""GJJ 多功能扩图工具节点。

整合四种扩图工作流：
1. SD 1.5 Inpainting (512-inpainting-ema)
2. Flux1 Fill Dev
3. Flux2 Klein
4. Qwen Image Edit

支持两种扩图方式：
- 目标尺寸扩图：指定各边扩图像素
- 四边像素扩图：指定目标尺寸，智能计算扩图

三层循环架构：
- 第一层：四种模型工作流
- 第二层：输入图片队列
- 第三层：两种扩图方式（像素扩图 + 目标尺寸扩图）
- 中途报错不中断，结果递增累加
"""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path
from typing import Any

import comfy.model_management
import comfy.samplers
import comfy.sd
import comfy.utils
import folder_paths
import node_helpers
import torch

from nodes import (
    EmptyLatentImage,
    VAEDecode,
    VAEEncode,
    VAEEncodeForInpaint,
    KSampler,
    PreviewImage,
)

try:
    from nodes import EmptySD3LatentImage
except ImportError:
    EmptySD3LatentImage = None

try:
    from nodes import CLIPTextEncode
except ImportError:
    CLIPTextEncode = None

from .common_utils.sampler_tools import (
    EmptyFlux2LatentImage_execute as EmptyFlux2LatentImage,
    Flux2Scheduler_execute as Flux2Scheduler,
    RandomNoise_execute as RandomNoise,
    KSamplerSelect_execute as KSamplerSelect,
    CFGGuider_execute as CFGGuider,
    SamplerCustomAdvanced_execute as SamplerCustomAdvanced,
)

from .common_utils import model_manager

from .common_utils.image_tools import (
    gjjutils_expand_image_with_padding,
    gjjutils_calculate_expand_size,
    gjjutils_split_image_batch,
)

from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE

from .gjj_multi_image_loader import (
    load_image_tensor,
    parse_selected_images,
    resolve_input_image_path,
)

NODE_NAME = "GJJ_OutpaintStudio"

OUTPAINT_MODES = {
    "sd15_inpaint": {
        "name": "SD1.5局部重绘",
        "icon": "🎨",
        "model_categories": {
            "checkpoints": ["512-inpainting-ema"],
        },
        "description": "经典 SD1.5 局部重绘，适合简单场景",
        "pros": "兼容性好、速度快、资源需求低",
        "cons": "质量相对较低",
        "default_params": {
            "steps": 25,
            "cfg": 7.0,
            "sampler": "euler",
            "scheduler": "normal",
        },
    },
    "flux1_fill": {
        "name": "Flux1-Fill填充",
        "icon": "🌀",
        "model_categories": {
            "diffusion_models": ["flux1-fill-dev"],
            "vae": ["ae"],
            "text_encoders": ["t5xxl", "clip_l"],
        },
        "description": "Flux1 填充模型，高质量扩图",
        "pros": "质量高、细节丰富、边缘自然",
        "cons": "资源需求高、速度较慢",
        "default_params": {"steps": 20, "guidance": 3.5, "sampler": "euler"},
        "flux_mode": True,
    },
    "flux2_klein": {
        "name": "Flux2-Klein增强",
        "icon": "✨",
        "model_categories": {
            "diffusion_models": ["flux-2-klein-9b"],
            "vae": ["flux2-vae"],
            "text_encoders": ["qwen_3_8b"],
        },
        "description": "Flux2 Klein 增强版，极高质量",
        "pros": "质量极高、细节保留好",
        "cons": "显存需求大、速度最慢",
        "default_params": {"steps": 8, "guidance": 35, "sampler": "euler"},
        "flux_mode": True,
    },
    "qwen_image": {
        "name": "Qwen-Image智绘",
        "icon": "🌟",
        "model_categories": {
            "diffusion_models": ["qwen_image_edit"],
            "vae": ["qwen_image_vae"],
            "text_encoders": ["qwen_2.5_vl_7b"],
            "controlnet": ["Qwen-Image-InstantX-ControlNet-Inpainting"],
            "loras": ["Qwen-Image-Lightning"],
        },
        "description": "通义千问图像编辑，智能扩图",
        "pros": "智能理解、语义准确",
        "cons": "配置复杂、需要特定模型",
        "default_params": {"steps": 4, "guidance": 40, "sampler": "euler"},
        "flux_mode": True,
    },
}

DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d"


def _send_status(unique_id, status_text):
    """发送节点状态更新。"""
    try:
        from server import PromptServer

        status_text = str(status_text or "").strip()
        if not status_text:
            status_text = "处理中..."
        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": status_text},
        )
    except Exception as e:
        print(f"[GJJ Outpaint] 发送状态失败: {e}")


# 从子目录导入工具函数和核心函数
from ._gjj_outpaint_studio.utils import (
    _free_vram,
    _apply_flux_guidance,
    _conditioning_zero_out,
    _apply_differential_diffusion,
    _apply_reference_latent,
    _apply_controlnet,
)
from ._gjj_outpaint_studio.core import (
    _parse_config,
    _scan_mode_models,
    _validate_mode,
    _expand_by_pixels,
    _compute_target_padding_keep_scale,
    _expand_to_target_size,
    _load_mode_models,
)

EXPAND_METHODS = [
    {
        "id": "pixel_expand",
        "name": "像素扩图",
        "icon": "📏",
        "description": "指定四边各扩多少像素",
    },
    {
        "id": "target_size",
        "name": "目标尺寸扩图",
        "icon": "🎯",
        "description": "指定最终目标尺寸，自动计算扩图量",
    },
]


class GJJ_OutpaintStudio:
    """GJJ 多功能扩图工具节点。"""

    CATEGORY = "GJJ/Image"
    FUNCTION = "outpaint_image"
    OUTPUT_NODE = True

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("扩图结果",)
    OUTPUT_TOOLTIPS = ("扩图后的图像批次。",)

    SEARCH_ALIASES = [
        "扩图",
        "outpaint",
        "expand",
        "inpaint",
        "填充",
        "延展",
        "多功能扩图",
        "智能扩图",
    ]

    GJJ_HELP = {
        "title": "GJJ · 🖼️ 多功能扩图工具",
        "version": "1.0.0",
        "author": "GJJ Custom Nodes Team",
        "description": "整合四种扩图工作流的智能扩图工具",
        "workflows": [
            {
                "id": mode_id,
                "name": f"{cfg['icon']} {cfg['name']}",
                "model_requirements": {
                    cat: {"keywords": kws, "description": f"{cat} 模型"}
                    for cat, kws in cfg["model_categories"].items()
                },
                "pros": cfg["pros"],
                "cons": cfg["cons"],
                "recommended_params": cfg["default_params"],
            }
            for mode_id, cfg in OUTPAINT_MODES.items()
        ],
        "download_info": {"url": DOWNLOAD_URL},
    }

    def __init__(self):
        self.preview_image = PreviewImage()
        self._model_cache: dict[str, Any] = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "image_01": (
                    "GJJ_BATCH_IMAGE,IMAGE",
                    {
                        "display_name": "🖼️ 输入图片",
                        "tooltip": "要扩图的原始图片，支持批量处理",
                    },
                ),
                "outpaint_config": (
                    "STRING",
                    {
                        "default": json.dumps(
                            {
                                "pixel_left": 0,
                                "pixel_right": 128,
                                "pixel_top": 0,
                                "pixel_bottom": 128,
                                "target_width": 1024,
                                "target_height": 1024,
                                "target_scale_mode": "by_width",
                                "target_direction": "center",
                                "seed": 0,
                                "upscale_method": "lanczos",
                                "mask_expand": 10,
                            },
                            ensure_ascii=False,
                        ),
                        "multiline": True,
                        "display_name": "扩图配置",
                        "tooltip": "由前端自动维护的配置JSON",
                    },
                ),
            },
            "hidden": {
                "prompt_graph": "PROMPT",
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def _split_batch(self, value):
        """拆分批次图像。"""
        return gjjutils_split_image_batch(value)

    def _execute_outpaint(
        self,
        mode: str,
        expanded_img: torch.Tensor,
        orig_size: tuple[int, int],
        pad_amounts: dict[str, int],
        seed: int,
        steps: int,
        cfg: float,
        guidance: float,
        sampler_name: str,
        scheduler: str,
        mask_expand: int,
        unique_id: str = "",
        **kwargs,
    ) -> torch.Tensor:
        """执行扩图采样，按模式分支。"""
        print(f"[GJJ Outpaint] 开始执行: mode={mode}, seed={seed}, steps={steps}")

        try:
            models = _load_mode_models(
                mode, OUTPAINT_MODES, self._model_cache, model_manager, _free_vram
            )
            print(f"[GJJ Outpaint] 模型加载成功: {list(models.keys())}")
        except Exception as e:
            print(
                f"\033[91m[GJJ Outpaint] ❌ 模型加载失败: {type(e).__name__}: {e}\033[0m"
            )
            raise RuntimeError(f"模型加载失败: {type(e).__name__}: {e}")

        if not models.get("model"):
            error_msg = f"模式 {mode} 缺少主模型"
            print(f"\033[91m[GJJ Outpaint] ❌ {error_msg}\033[0m")
            raise RuntimeError(error_msg)

        # 构建统一的 config 参数包
        config_params = {
            "steps": steps,
            "cfg": cfg,
            "guidance": guidance,
            "sampler_name": sampler_name,
            "scheduler": scheduler,
            "mask_expand": mask_expand,
            "unique_id": unique_id,
        }

        if mode == "sd15_inpaint":
            from ._gjj_outpaint_studio.sd15_inpaint import execute_sd15_workflow

            result = execute_sd15_workflow(
                models["model"],
                models.get("vae"),
                models.get("clip"),
                expanded_img,
                pad_amounts,
                seed,
                config=config_params,
            )
        elif mode == "flux1_fill":
            from ._gjj_outpaint_studio.flux1_fill import execute_flux1_workflow

            result = execute_flux1_workflow(
                models["model"],
                models.get("vae"),
                models.get("clip"),
                expanded_img,
                pad_amounts,
                seed,
                config=config_params,
            )
        elif mode == "flux2_klein":
            from ._gjj_outpaint_studio.flux2_klein import execute_flux2_workflow

            result = execute_flux2_workflow(
                models["model"],
                models.get("vae"),
                models.get("clip"),
                expanded_img,
                pad_amounts,
                seed,
                config=config_params,
            )
        elif mode == "qwen_image":
            from ._gjj_outpaint_studio.qwen_image import execute_qwen_workflow

            result = execute_qwen_workflow(
                models["model"],
                models.get("vae"),
                models.get("clip"),
                expanded_img,
                pad_amounts,
                seed,
                config=config_params,
            )
        else:
            raise RuntimeError(f"未知模式: {mode}")

        return result

    def _expand_for_mode(
        self,
        mode: str,
        img_tensor: torch.Tensor,
        expand_method: str,
        pixel_left: int,
        pixel_right: int,
        pixel_top: int,
        pixel_bottom: int,
        target_width: int,
        target_height: int,
        target_scale_mode: str,
        target_direction: str,
    ) -> tuple[torch.Tensor, dict[str, int], int, int]:
        """计算扩图参数，返回 (expanded_img, pad_amounts, effective_orig_w, effective_orig_h)。"""
        _, orig_h, orig_w, _ = img_tensor.shape

        if mode in ("sd15_inpaint", "flux2_klein", "qwen_image"):
            # 这些模式内部使用 ImagePadForOutpaint，不提前扩图
            if expand_method == "pixel_expand":
                left = pixel_left
                right = pixel_right
                top = pixel_top
                bottom = pixel_bottom
            else:
                raw_w = int(target_width)
                raw_h = int(target_height)
                target_w = ((raw_w + 7) // 8) * 8
                target_h = ((raw_h + 7) // 8) * 8
                total_pad_w = max(0, target_w - orig_w)
                total_pad_h = max(0, target_h - orig_h)
                if target_w != raw_w or target_h != raw_h:
                    print(
                        f"[GJJ Outpaint] 目标尺寸8倍对齐: {raw_w}x{raw_h} -> {target_w}x{target_h}"
                    )
                if target_direction in ("left",):
                    left = total_pad_w
                    right = 0
                elif target_direction in ("right",):
                    left = 0
                    right = total_pad_w
                else:
                    left = total_pad_w // 2
                    right = total_pad_w - left
                if target_direction in ("top",):
                    top = total_pad_h
                    bottom = 0
                elif target_direction in ("bottom",):
                    top = 0
                    bottom = total_pad_h
                else:
                    top = total_pad_h // 2
                    bottom = total_pad_h - top
                print(
                    f"[GJJ Outpaint] 目标尺寸扩图: orig={orig_w}x{orig_h} -> target={target_w}x{target_h}"
                )

            expanded = img_tensor
            pad_amounts = {"left": left, "right": right, "top": top, "bottom": bottom}
            effective_orig_w = orig_w
            effective_orig_h = orig_h
            print(
                f"[GJJ Outpaint] pad_amounts: left={left}, right={right}, top={top}, bottom={bottom}"
            )
        else:
            # flux1_fill 等：需要提前扩图
            if expand_method == "pixel_expand":
                left = pixel_left
                right = pixel_right
                top = pixel_top
                bottom = pixel_bottom

                new_w = orig_w + left + right
                new_h = orig_h + top + bottom
                final_w = ((new_w + 7) // 8) * 8
                final_h = ((new_h + 7) // 8) * 8

                extra_w = final_w - new_w
                extra_h = final_h - new_h
                right += extra_w
                bottom += extra_h

                print(
                    f"[GJJ Outpaint] 像素扩图: orig={orig_w}x{orig_h}, left={left}, right={right}, top={top}, bottom={bottom}"
                )
                print(f"[GJJ Outpaint] 目标尺寸: {final_w}x{final_h}")

                try:
                    expanded = _expand_by_pixels(img_tensor, left, right, top, bottom)
                    print(f"[GJJ Outpaint] 扩图后尺寸: {expanded.shape}")
                except Exception as e:
                    print(f"[GJJ Outpaint] _expand_by_pixels 失败: {e}")
                    raise

                pad_amounts = {
                    "left": left,
                    "right": right,
                    "top": top,
                    "bottom": bottom,
                }
                effective_orig_w = orig_w
                effective_orig_h = orig_h
            else:
                print(
                    f"[GJJ Outpaint] 目标尺寸扩图: orig={orig_w}x{orig_h}, target={target_width}x{target_height}, mode={target_scale_mode}, direction={target_direction}"
                )
                expanded, pad_amounts = _expand_to_target_size(
                    img_tensor,
                    target_width,
                    target_height,
                    target_scale_mode,
                    target_direction,
                )
                print(
                    f"[GJJ Outpaint] 扩图后尺寸: {expanded.shape}, pad_amounts={pad_amounts}"
                )
                effective_orig_w = pad_amounts.get("orig_w", orig_w)
                effective_orig_h = pad_amounts.get("orig_h", orig_h)

        return expanded, pad_amounts, effective_orig_w, effective_orig_h

    def outpaint_image(
        self,
        image_01=None,
        outpaint_config="{}",
        prompt_graph=None,
        unique_id=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        """执行扩图操作（单层循环：遍历输入图片）。

        模式选择和扩图方式由前端 config 中的 outpaint_mode / expand_method 控制。
        前端通过反复修改 config 重新提交队列来实现多模式/多方式的批量执行。
        """
        start_time = time.time()

        config = _parse_config(outpaint_config)

        # 前端选定要执行的单个模式和方式（由 JS 批量调度逐次提交）
        outpaint_mode = config.get("outpaint_mode", "sd15_inpaint")
        expand_method = config.get("expand_method", "pixel_expand")

        pixel_left = config.get("pixel_left", 0)
        pixel_right = config.get("pixel_right", 0)
        pixel_top = config.get("pixel_top", 0)
        pixel_bottom = config.get("pixel_bottom", 0)
        target_width = config.get("target_width", 512)
        target_height = config.get("target_height", 512)
        target_scale_mode = config.get("target_scale_mode", "cover")
        target_direction = config.get("target_direction", "center")
        base_seed = config.get("seed", 0)
        upscale_method = config.get("upscale_method", "nearest-exact")
        mask_expand = config.get("mask_expand", 10)

        # ============================================================
        # 加载输入图像
        # ============================================================
        _send_status(unique_id, "📷 加载图像...")
        source_images = []

        if image_01 is not None:
            if isinstance(image_01, torch.Tensor):
                source_images = self._split_batch(image_01)
            elif isinstance(image_01, str):
                selected = parse_selected_images(image_01)
                for entry in selected:
                    try:
                        img = load_image_tensor(resolve_input_image_path(entry))
                        source_images.append(img)
                    except Exception as e:
                        print(f"[GJJ Outpaint] 加载图片失败: {entry} - {e}")

        if not source_images:
            _send_status(unique_id, "❌ 未检测到图像")
            raise RuntimeError("请先加载要扩图的图片")

        _send_status(unique_id, f"🖼️ 检测到 {len(source_images)} 张图片")
        print(
            f"[GJJ Outpaint] 单次执行: 模式={outpaint_mode}, 方式={expand_method}, {len(source_images)} 张图片"
        )

        # ============================================================
        # 解析当前模式和方法标签
        # ============================================================
        mode_cfg = OUTPAINT_MODES.get(outpaint_mode)
        if mode_cfg is None:
            raise RuntimeError(f"未知扩图模式: {outpaint_mode}")

        method_label = expand_method
        method_icon_map = {"pixel_expand": "📏", "target_size": "🎯"}
        for m in EXPAND_METHODS:
            if m["id"] == expand_method:
                method_label = m["icon"] + " " + m["name"]
                break

        mode_name = mode_cfg["icon"] + " " + mode_cfg["name"]

        # ============================================================
        # 检查模型是否可用
        # ============================================================
        _send_status(unique_id, f"🔍 检查 {mode_name} 模型...")
        models_ok, model_msg = _validate_mode(
            outpaint_mode, OUTPAINT_MODES, DOWNLOAD_URL, model_manager
        )
        if not models_ok:
            raise RuntimeError(f"模式 {outpaint_mode} 缺少模型: {model_msg}")

        # 清除旧模型缓存
        self._model_cache.clear()
        _free_vram()

        # 获取该模式的默认参数
        default_params = mode_cfg.get("default_params", {})
        steps = config.get("steps", default_params.get("steps", 20))
        cfg_val = config.get("cfg", default_params.get("cfg", 7.0))
        guidance = config.get("guidance", default_params.get("guidance", 3.5))
        sampler_name = config.get(
            "sampler_name", default_params.get("sampler", "euler")
        )
        scheduler = config.get("scheduler", default_params.get("scheduler", "normal"))

        # ============================================================
        # 单层循环：遍历输入图片
        # ============================================================
        all_results = []  # 累加所有结果
        all_errors = []  # 累加所有错误信息

        for img_idx, img_tensor in enumerate(source_images):
            _, orig_h, orig_w, _ = img_tensor.shape
            print(
                f"[GJJ Outpaint] 图片 {img_idx + 1}/{len(source_images)}: size={orig_w}x{orig_h}"
            )

            label = f"{outpaint_mode}_{expand_method}_{img_idx + 1}"
            seed = base_seed + img_idx

            _send_status(
                unique_id,
                f"🎨 {mode_name} | {method_label} | 图{img_idx + 1}/{len(source_images)}",
            )
            print(
                f"[GJJ Outpaint] --- {label}: mode={outpaint_mode}, method={expand_method}, seed={seed} ---"
            )

            try:
                # 计算扩图参数
                expanded, pad_amounts, eff_w, eff_h = self._expand_for_mode(
                    outpaint_mode,
                    img_tensor,
                    expand_method,
                    pixel_left,
                    pixel_right,
                    pixel_top,
                    pixel_bottom,
                    target_width,
                    target_height,
                    target_scale_mode,
                    target_direction,
                )

                # 执行推理
                result = self._execute_outpaint(
                    outpaint_mode,
                    expanded.contiguous(),
                    (eff_w, eff_h),
                    pad_amounts,
                    seed,
                    steps,
                    cfg_val,
                    guidance,
                    sampler_name,
                    scheduler,
                    mask_expand,
                    unique_id,
                    **kwargs,
                )

                print(f"[GJJ Outpaint] ✅ {label}: result shape={result.shape}")
                all_results.append(result)

            except Exception as e:
                err_info = {
                    "mode": outpaint_mode,
                    "image_index": img_idx + 1,
                    "method": expand_method,
                    "error_type": type(e).__name__,
                    "error_message": str(e),
                }
                all_errors.append(err_info)
                error_msg = (
                    f"\033[91m[GJJ Outpaint] ❌ {label} 失败: "
                    f"{type(e).__name__}: {e}\033[0m"
                )
                print(f"\n{error_msg}")
                _send_status(
                    unique_id,
                    f"❌ {label}: {type(e).__name__}",
                )
                continue

        # ============================================================
        # 汇总结果
        # ============================================================
        print(f"\n[GJJ Outpaint] {'=' * 60}")
        print(
            f"[GJJ Outpaint] 单次执行完成: 成功 {len(all_results)}, 失败 {len(all_errors)}"
        )
        for err in all_errors:
            print(
                f"[GJJ Outpaint] 🔍 失败: mode={err['mode']} img={err['image_index']} "
                f"method={err['method']} -> {err['error_type']}: {err['error_message']}"
            )
        print(f"[GJJ Outpaint] {'=' * 60}")

        if not all_results:
            error_str = "; ".join(
                [
                    f"[{err['mode']}][图{err['image_index']}][{err['method']}] {err['error_type']}"
                    for err in all_errors
                ]
            )
            _send_status(unique_id, f"❌ 全部失败: {error_str}")
            return (torch.zeros((1, 256, 256, 3)),)

        final_images = (
            torch.cat(all_results, dim=0) if len(all_results) > 1 else all_results[0]
        )

        elapsed = time.time() - start_time
        _send_status(
            unique_id,
            f"✅ {final_images.shape[0]}张 {final_images.shape[2]}x{final_images.shape[1]} ⏱️ {elapsed:.1f}s",
        )

        # ============================================================
        # 保存图片
        # ============================================================
        preview_images = []
        try:
            import os
            from PIL import Image
            import numpy as np

            output_dir = folder_paths.get_output_directory()
            os.makedirs(output_dir, exist_ok=True)

            full_output_folder, filename, counter, subfolder, filename_prefix = (
                folder_paths.get_save_image_path(
                    "GJJ_Outpaint",
                    output_dir,
                    final_images.shape[2],
                    final_images.shape[1],
                )
            )

            print(f"[GJJ Outpaint] 保存图片到: {full_output_folder}")
            print(f"[GJJ Outpaint] 图片数量: {final_images.shape[0]}")

            for i in range(final_images.shape[0]):
                img_np = (
                    (255.0 * final_images[i].cpu().numpy()).round().astype(np.uint8)
                )
                img = Image.fromarray(img_np)
                filename_with_counter = f"{filename}_{counter:05}_.png"
                filepath = os.path.join(full_output_folder, filename_with_counter)
                img.save(filepath)
                preview_images.append(
                    {
                        "filename": filename_with_counter,
                        "subfolder": subfolder,
                        "type": "output",
                    }
                )
                print(f"[GJJ Outpaint] 已保存: {filename_with_counter}")
                counter += 1
        except Exception as e:
            print(f"[GJJ Outpaint] 保存图片失败: {e}")
            _send_status(unique_id, f"❌ 保存失败: {str(e)}")

        return {
            "ui": {"images": preview_images, "elapsed_time": [elapsed]},
            "result": (final_images,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_OutpaintStudio}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🖼️ GJJ·多功能扩图工具"}

try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/gjj/outpaint_models")
    async def get_outpaint_models(request):
        mode = request.query.get("mode", "sd15_inpaint")
        result = _scan_mode_models(mode, OUTPAINT_MODES, model_manager)
        return web.json_response(result)

    print(f"[GJJ Outpaint] API 路由注册成功")
except Exception as e:
    print(f"[GJJ Outpaint] API 路由注册失败: {e}")
