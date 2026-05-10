"""GJJ 多功能扩图工具节点。

整合四种扩图工作流：
1. SD 1.5 Inpainting (512-inpainting-ema)
2. Flux1 Fill Dev
3. Flux2 Klein
4. Qwen Image Edit

支持两种扩图方式：
- 目标尺寸扩图：指定各边扩图像素
- 四边像素扩图：指定目标尺寸，智能计算扩图

特点：
- 按钮式扩图模式选择
- 动态参数显示
- 自动模型匹配
- 批处理支持
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

from .common_utils.model_manager import gjjutils_find_model_list

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
        "default_params": {"steps": 25, "cfg": 7.0, "sampler": "euler", "scheduler": "normal"},
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


def _send_status(unique_id: Any, text: str) -> None:
    """发送节点状态到前端。"""
    if not unique_id:
        return
    try:
        from server import PromptServer
        status_text = str(text or "").strip()
        if not status_text:
            status_text = "处理中..."
        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": status_text},
        )
    except Exception:
        pass


def _resolve_model_by_priority(
    folder_type: str, keywords: list[str]
) -> tuple[str | None, list[str]]:
    """根据优先级解析模型。"""
    matched = gjjutils_find_model_list(keywords, folder_type, "OR")
    if not matched:
        return None, []

    sorted_matched = sorted(matched, key=lambda x: len(os.path.basename(x)))
    return sorted_matched[0], sorted_matched


class GJJ_OutpaintStudio:
    """GJJ 多功能扩图工具节点。"""

    CATEGORY = "GJJ/Image"
    FUNCTION = "outpaint_image"
    OUTPUT_NODE = True

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("扩图结果",)
    OUTPUT_TOOLTIPS = ("扩图后的图像批次。",)

    SEARCH_ALIASES = [
        "扩图", "outpaint", "expand", "inpaint", "填充", "延展",
        "多功能扩图", "智能扩图",
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
        outpaint_modes = list(OUTPAINT_MODES.keys())
        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
        upscale_methods = ["lanczos", "bilinear", "nearest", "bicubic"]
        scale_modes = ["by_width", "by_height"]

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
                        "default": json.dumps({
                            "outpaint_mode": "sd15_inpaint",
                            "expand_method": "pixel_expand",
                            "pixel_left": 0,
                            "pixel_right": 128,
                            "pixel_top": 0,
                            "pixel_bottom": 128,
                            "target_width": 1024,
                            "target_height": 1024,
                            "target_scale_mode": "by_width",
                            "target_direction": "left+right",
                            "seed": 0,
                            "steps": 25,
                            "cfg": 7.0,
                            "guidance": 3.5,
                            "sampler_name": "euler",
                            "scheduler": "normal",
                            "upscale_method": "lanczos",
                        }, ensure_ascii=False),
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

    def _parse_config(self, config_json):
        """解析配置JSON"""
        try:
            config = json.loads(config_json)
        except Exception:
            config = {}

        defaults = {
            "outpaint_mode": "sd15_inpaint",
            "expand_method": "pixel_expand",
            "pixel_left": 0,
            "pixel_right": 128,
            "pixel_top": 0,
            "pixel_bottom": 128,
            "target_width": 1024,
            "target_height": 1024,
            "target_scale_mode": "by_width",
            "target_direction": "left+right",
            "seed": 0,
            "steps": 25,
            "cfg": 7.0,
            "guidance": 3.5,
            "sampler_name": "euler",
            "scheduler": "normal",
            "upscale_method": "lanczos",
        }

        return {**defaults, **config}

    def _scan_mode_models(self, mode: str) -> dict[str, Any]:
        """扫描模式下可用的模型。"""
        config = OUTPAINT_MODES.get(mode, OUTPAINT_MODES["sd15_inpaint"])
        categories = config.get("model_categories", {})

        available = {}
        for cat, keywords in categories.items():
            if isinstance(keywords, str):
                keywords = [keywords]
            best, all_matches = _resolve_model_by_priority(cat, keywords)
            available[cat] = {
                "best": best,
                "all": all_matches,
                "keyword": keywords[0] if keywords else "",
            }

        missing = [cat for cat, data in available.items() if not data["best"]]
        return {"available": available, "missing": missing, "complete": len(missing) == 0}

    def _validate_mode(self, mode: str) -> tuple[bool, str]:
        """验证模式所需模型。"""
        result = self._scan_mode_models(mode)
        if result["complete"]:
            return True, "✅ 所有模型已就绪"

        lines = ["⚠️ 部分模型缺失："]
        for cat in result["missing"]:
            kw = result["available"].get(cat, {}).get("keyword", "")
            lines.append(f"  • {cat}: 需要 '{kw}'")
            lines.append(f"    下载：{DOWNLOAD_URL}")
        return False, "\n".join(lines)

    def _split_batch(self, value):
        """拆分批次图像。"""
        return gjjutils_split_image_batch(value)

    def _expand_by_pixels(
        self,
        image: torch.Tensor,
        left: int,
        right: int,
        top: int,
        bottom: int,
    ) -> torch.Tensor:
        """按像素扩展图像。"""
        return gjjutils_expand_image_with_padding(
            image, left, right, top, bottom, "replicate"
        )

    def _expand_to_target_size(
        self,
        image: torch.Tensor,
        target_w: int,
        target_h: int,
        scale_mode: str,
        direction: str,
    ) -> tuple[torch.Tensor, dict[str, int]]:
        """扩展到目标尺寸。"""
        _, orig_h, orig_w, _ = image.shape

        if scale_mode == "by_width":
            scale = target_w / orig_w
            new_h = int(orig_h * scale)
            new_w = target_w
        else:
            scale = target_h / orig_h
            new_w = int(orig_w * scale)
            new_h = target_h

        # 先缩放图像
        samples = image.movedim(-1, 1)
        scaled = comfy.utils.common_upscale(
            samples, new_w, new_h, "lanczos", "disabled"
        )
        scaled_img = scaled.movedim(1, -1)

        # 这里的原始尺寸应该是缩放后的尺寸
        effective_orig_w = new_w
        effective_orig_h = new_h

        if direction == "all":
            left = max(0, (target_w - effective_orig_w) // 2)
            right = max(0, target_w - effective_orig_w - left)
            top = max(0, (target_h - effective_orig_h) // 2)
            bottom = max(0, target_h - effective_orig_h - top)
        elif direction == "left+right":
            left = max(0, (target_w - effective_orig_w) // 2)
            right = max(0, target_w - effective_orig_w - left)
            top = 0
            bottom = 0
        elif direction == "top+bottom":
            top = max(0, (target_h - effective_orig_h) // 2)
            bottom = max(0, target_h - effective_orig_h - top)
            left = 0
            right = 0
        elif direction == "left_right":
            left = max(0, target_w - effective_orig_w)
            right = 0
            top = 0
            bottom = 0
        elif direction == "top_bottom":
            top = max(0, target_h - effective_orig_h)
            bottom = 0
            left = 0
            right = 0
        elif direction == "left":
            left = max(0, target_w - effective_orig_w)
            right = top = bottom = 0
        elif direction == "right":
            right = max(0, target_w - effective_orig_w)
            left = top = bottom = 0
        elif direction == "top":
            top = max(0, target_h - effective_orig_h)
            bottom = left = right = 0
        elif direction == "bottom":
            bottom = max(0, target_h - effective_orig_h)
            top = left = right = 0
        else:
            left = right = top = bottom = 0

        if left > 0 or right > 0 or top > 0 or bottom > 0:
            expanded = self._expand_by_pixels(scaled_img, left, right, top, bottom)
        else:
            expanded = scaled_img

        # 返回原始尺寸 - 这里是缩放后的尺寸作为有效原始尺寸
        return expanded, {"left": left, "right": right, "top": top, "bottom": bottom, "orig_w": effective_orig_w, "orig_h": effective_orig_h}

    def _load_mode_models(self, mode: str):
        """加载模式所需的模型。"""
        config = OUTPAINT_MODES.get(mode, OUTPAINT_MODES["sd15_inpaint"])
        categories = config.get("model_categories", {})
        cache_key = f"mode_{mode}"

        if cache_key in self._model_cache:
            return self._model_cache[cache_key]

        models = {}

        for cat in ["checkpoints", "diffusion_models"]:
            if cat in categories:
                kw = categories[cat]
                if isinstance(kw, str):
                    kw = [kw]
                best, _ = _resolve_model_by_priority(cat, kw)
                if best:
                    try:
                        if cat == "checkpoints":
                            from nodes import CheckpointLoaderSimple
                            m, c, v = CheckpointLoaderSimple().load_checkpoint(best)
                            models["model"] = m
                            models["clip"] = c
                            models["vae"] = v
                        else:
                            models["model"] = comfy.sd.load_diffusion_model(
                                folder_paths.get_full_path(cat, best)
                            )
                    except Exception as exc:
                        raise RuntimeError(f"加载 {cat} 失败：{best}\n{exc}") from exc

        for cat in ["vae"]:
            if cat in categories:
                kw = categories[cat]
                if isinstance(kw, str):
                    kw = [kw]
                best, _ = _resolve_model_by_priority(cat, kw)
                if best and "vae" not in models:
                    try:
                        vae_path = folder_paths.get_full_path(cat, best)
                        sd, meta = comfy.utils.load_torch_file(vae_path, return_metadata=True)
                        models["vae"] = comfy.sd.VAE(sd=sd, metadata=meta)
                    except Exception:
                        pass

        for cat in ["text_encoders", "clip"]:
            if cat in categories:
                kw = categories[cat]
                if isinstance(kw, str):
                    kw = [kw]
                best, _ = _resolve_model_by_priority(cat, kw)
                if best and "clip" not in models:
                    try:
                        clip_path = folder_paths.get_full_path(cat, best)
                        models["clip"] = comfy.sd.load_clip(
                            ckpt_paths=[clip_path],
                            clip_type=comfy.sd.CLIPType.STABLE_DIFFUSION,
                        )
                    except Exception:
                        pass

        self._model_cache[cache_key] = models
        return models

    def _execute_sd15_inpainting(
        self,
        models: dict,
        expanded_img: torch.Tensor,
        orig_size: tuple[int, int],
        pad_amounts: dict[str, int],
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
    ) -> torch.Tensor:
        """SD1.5 局部重绘工作流。"""
        model = models["model"]
        vae = models.get("vae")
        clip = models.get("clip")

        if vae is None:
            raise RuntimeError("VAE 模型不可用")

        batch_size, img_h, img_w, _ = expanded_img.shape

        orig_w, orig_h = orig_size

        left = pad_amounts.get("left", 0)
        right = pad_amounts.get("right", 0)
        top = pad_amounts.get("top", 0)
        bottom = pad_amounts.get("bottom", 0)

        # 创建 mask - [batch_size, height, width]
        mask_float = torch.zeros((batch_size, img_h, img_w), dtype=torch.float32, device=expanded_img.device)

        # 标记需要重绘的扩展区域
        if top > 0:
            mask_float[:, :top, :] = 1.0
        if bottom > 0:
            mask_float[:, (img_h - bottom):, :] = 1.0
        if left > 0:
            mask_float[:, :, :left] = 1.0
        if right > 0:
            mask_float[:, :, (img_w - right):] = 1.0

        # VAE 编码（使用 VAEEncodeForInpaint）
        encoder = VAEEncodeForInpaint()
        x_tuple = encoder.encode(vae, expanded_img, mask_float)
        # 元组返回，取第一个元素 (latent_dict, )
        x = x_tuple[0] if isinstance(x_tuple, tuple) else x_tuple

        # 提示词编码
        positive_text = "masterpiece, best quality, highres, highly detailed, extension, seamless"
        negative_text = "lowres, blurry, low quality, worst quality, bad anatomy, bad hands, text, error"

        if CLIPTextEncode is not None and clip is not None:
            clip_encoder = CLIPTextEncode()
            positive = clip_encoder.encode(clip, positive_text)[0]
            negative = clip_encoder.encode(clip, negative_text)[0]
        else:
            positive = [[torch.zeros(1, 77, 768), {}]]
            negative = positive

        # KSampler
        sampler = KSampler()
        sampler_result = sampler.sample(
            model, seed, steps, cfg, sampler_name, scheduler,
            positive, negative, x, denoise=1.0
        )
        latent = sampler_result[0] if isinstance(sampler_result, tuple) else sampler_result

        # VAE 解码
        decoder = VAEDecode()
        decoded_tuple = decoder.decode(vae, latent)
        decoded = decoded_tuple[0] if isinstance(decoded_tuple, tuple) else decoded_tuple

        return decoded

    def _execute_flux_fill(
        self,
        models: dict,
        expanded_img: torch.Tensor,
        orig_size: tuple[int, int],
        pad_amounts: dict[str, int],
        seed: int,
        steps: int,
        guidance: float,
        sampler_name: str,
    ) -> torch.Tensor:
        """Flux1 Fill 工作流。"""
        model = models["model"]
        vae = models.get("vae")
        clip = models.get("clip")

        if vae is None:
            raise RuntimeError("VAE 模型不可用")

        new_w, new_h = expanded_img.shape[2], expanded_img.shape[1]

        # VAE 编码
        encoder = VAEEncode()
        x_tuple = encoder.encode(vae, expanded_img)
        x = x_tuple[0] if isinstance(x_tuple, tuple) else x_tuple

        # 创建 mask - 只在 latent 空间
        latent_shape = x["samples"].shape
        mask = torch.ones((1, 1, latent_shape[2], latent_shape[3]), device=x["samples"].device)

        left_pad = pad_amounts.get("left", 0) // 8
        top_pad = pad_amounts.get("top", 0) // 8
        orig_latent_w = max(1, orig_size[0] // 8)
        orig_latent_h = max(1, orig_size[1] // 8)

        end_x = min(left_pad + orig_latent_w, latent_shape[3])
        end_y = min(top_pad + orig_latent_h, latent_shape[2])

        if left_pad < end_x and top_pad < end_y:
            mask[:, :, top_pad:end_y, left_pad:end_x] = 0.0

        x["noise_mask"] = mask

        # Flux 风格编码
        pos_text = "masterpiece, best quality, high resolution, detailed"
        neg_text = "low quality, blurry, ugly, distorted"

        if clip is not None and hasattr(clip, "encode_from_tokens_scheduled"):
            pos_cond = clip.encode_from_tokens_scheduled(clip.tokenize(pos_text))
            neg_cond = clip.encode_from_tokens_scheduled(clip.tokenize(neg_text))
        else:
            pos_cond = [[torch.zeros(1, 77, 2048), {}]]
            neg_cond = pos_cond

        # Flux 采样
        noise = RandomNoise(int(seed))
        sampler = KSamplerSelect(str(sampler_name or "euler").strip())
        sigmas = Flux2Scheduler(int(steps), new_w, new_h)
        guider = CFGGuider(model, pos_cond, neg_cond, float(guidance))

        result = SamplerCustomAdvanced(noise, guider, sampler, sigmas, x)
        sampled = result.get("output", x)

        # VAE 解码
        decoder = VAEDecode()
        decoded_tuple = decoder.decode(vae, sampled)
        decoded = decoded_tuple[0] if isinstance(decoded_tuple, tuple) else decoded_tuple
        return decoded

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
        **kwargs,
    ) -> torch.Tensor:
        """执行扩图采样，按模式分支。"""
        models = self._load_mode_models(mode)

        if not models.get("model"):
            raise RuntimeError(f"模式 {mode} 缺少主模型")

        if mode == "sd15_inpaint":
            # SD1.5 局部重绘
            result = self._execute_sd15_inpainting(
                models, expanded_img, orig_size, pad_amounts,
                seed, steps, cfg, sampler_name, scheduler
            )
        elif mode in ["flux1_fill", "flux2_klein", "qwen_image"]:
            # Flux 系列
            result = self._execute_flux_fill(
                models, expanded_img, orig_size, pad_amounts,
                seed, steps, guidance, sampler_name
            )
        else:
            raise RuntimeError(f"未知模式: {mode}")

        return result

    def outpaint_image(
        self,
        image_01=None,
        outpaint_config="{}",
        prompt_graph=None,
        unique_id=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        """执行扩图操作。"""
        start_time = time.time()

        config = self._parse_config(outpaint_config)

        outpaint_mode = config["outpaint_mode"]
        expand_method = config["expand_method"]
        pixel_left = config["pixel_left"]
        pixel_right = config["pixel_right"]
        pixel_top = config["pixel_top"]
        pixel_bottom = config["pixel_bottom"]
        target_width = config["target_width"]
        target_height = config["target_height"]
        target_scale_mode = config["target_scale_mode"]
        target_direction = config["target_direction"]
        seed = config["seed"]
        steps = config["steps"]
        cfg = config["cfg"]
        guidance = config["guidance"]
        sampler_name = config["sampler_name"]
        scheduler = config["scheduler"]
        upscale_method = config["upscale_method"]

        _send_status(unique_id, "🔍 检查模型...")
        models_ok, model_msg = self._validate_mode(outpaint_mode)
        if not models_ok:
            _send_status(unique_id, f"⚠️ {outpaint_mode}")
            raise RuntimeError(model_msg)

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
                    except Exception:
                        pass

        if not source_images:
            _send_status(unique_id, "❌ 未检测到图像")
            raise RuntimeError("请先加载要扩图的图片")

        _send_status(unique_id, f"🖼️ 检测到 {len(source_images)} 张图片")

        results = []
        batch_idx = 0

        for img_tensor in source_images:
            batch_idx += 1
            if len(source_images) > 1:
                _send_status(unique_id, f"🔄 处理 {batch_idx}/{len(source_images)}...")

            _, orig_h, orig_w, _ = img_tensor.shape

            effective_orig_w = orig_w
            effective_orig_h = orig_h

            if expand_method == "pixel_expand":
                left = pixel_left
                right = pixel_right
                top = pixel_top
                bottom = pixel_bottom

                new_w = orig_w + left + right
                new_h = orig_h + top + bottom
                new_w = max(64, (new_w // 8) * 8)
                new_h = max(64, (new_h // 8) * 8)

                left = min(left, new_w - orig_w)
                right = min(right, new_w - orig_w - left)
                top = min(top, new_h - orig_h)
                bottom = min(bottom, new_h - orig_h - top)

                expanded = self._expand_by_pixels(img_tensor, left, right, top, bottom)
                pad_amounts = {"left": left, "right": right, "top": top, "bottom": bottom}

            else:
                _send_status(unique_id, f"📐 目标尺寸: {target_width}x{target_height}")
                expanded, pad_amounts = self._expand_to_target_size(
                    img_tensor, target_width, target_height, target_scale_mode, target_direction
                )
                # 从 pad_amounts 中获取有效原始尺寸
                effective_orig_w = pad_amounts.get("orig_w", orig_w)
                effective_orig_h = pad_amounts.get("orig_h", orig_h)

            # 确保尺寸是 8 的倍数（避免张量操作错误）
            final_h = (expanded.shape[1] // 8) * 8
            final_w = (expanded.shape[2] // 8) * 8

            if final_h != expanded.shape[1] or final_w != expanded.shape[2]:
                samples = expanded.movedim(-1, 1)
                resized = comfy.utils.common_upscale(samples, final_w, final_h, upscale_method, "disabled")
                expanded = resized.movedim(1, -1)

            _send_status(unique_id, f"🎨 模式: {OUTPAINT_MODES[outpaint_mode]['icon']} {OUTPAINT_MODES[outpaint_mode]['name']}")

            result = self._execute_outpaint(
                outpaint_mode,
                expanded.contiguous(),
                (effective_orig_w, effective_orig_h),
                pad_amounts,
                seed + batch_idx - 1,
                steps,
                cfg,
                guidance,
                sampler_name,
                scheduler,
                **kwargs,
            )

            results.append(result)

        final_images = torch.cat(results, dim=0) if len(results) > 1 else results[0]

        elapsed = time.time() - start_time
        _send_status(unique_id, f"✅ 完成 {final_images.shape[2]}x{final_images.shape[1]} ⏱️ {elapsed:.1f}s")

        preview_ui = self.preview_image.save_images(
            final_images,
            filename_prefix="GJJ_Outpaint",
            prompt=kwargs.get("prompt", ""),
            extra_pnginfo=extra_pnginfo,
        )
        preview_images = preview_ui.get("ui", {}).get("images", [])

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
        node = GJJ_OutpaintStudio()
        result = node._scan_mode_models(mode)
        return web.json_response(result)

except Exception:
    pass
