from __future__ import annotations

from fractions import Fraction
from typing import Any

import comfy.model_management
import comfy.model_sampling
import comfy.sd
import comfy.utils
import folder_paths
import torch
from comfy_api.latest import InputImpl, Types
from nodes import VAEDecode, common_ksampler
from server import PromptServer


NODE_NAME = "GJJ_Wan22FirstLastVideo"
DEFAULT_UNET = "Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v2.1.safetensors"
DEFAULT_CLIP = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
DEFAULT_VAE = "wan_2.1_vae.safetensors"
DEFAULT_HIGH_LORA = "WAN\\wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"
DEFAULT_LOW_LORA = "WAN\\wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"
DEFAULT_POSITIVE = "美女"
DEFAULT_NEGATIVE = "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
DEFAULT_SHIFT = 5.0
DEFAULT_STEPS = 4
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "simple"
DEFAULT_WIDTH = 832
DEFAULT_HEIGHT = 480
DEFAULT_LENGTH = 81
DEFAULT_FPS = 16.0


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": str(text or "")},
        )
    except Exception:
        pass


def _normalize_text(text: str) -> str:
    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _safe_filename_list(category: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(category))
    except Exception:
        return []


def _pick_available_name(preferred: str, available: list[str], fallback: str = "") -> str:
    preferred = str(preferred or "").strip()
    fallback = str(fallback or "").strip()
    if preferred and preferred in available:
        return preferred
    target_base = preferred.replace("\\", "/").split("/")[-1] if preferred else ""
    if target_base:
        for name in available:
            if name.replace("\\", "/").split("/")[-1].lower() == target_base.lower():
                return name
    normalized = _normalize_text(preferred)
    if normalized:
        for name in available:
            if normalized in _normalize_text(name):
                return name
    if fallback:
        return _pick_available_name(fallback, available, "")
    return available[0] if available else ""


def _require_model_name(category: str, preferred: str, label: str, fallback: str = "") -> str:
    available = _safe_filename_list(category)
    resolved = _pick_available_name(preferred, available, fallback)
    if not resolved:
        raise RuntimeError(f"未找到{label}：{preferred or fallback}")
    full_path = folder_paths.get_full_path(category, resolved)
    if not full_path:
        raise RuntimeError(f"未找到{label}：{resolved}")
    return resolved


def _conditioning_set_values(conditioning, values: dict[str, Any], append: bool = False):
    updated = []
    for item in conditioning:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            updated.append(item)
            continue
        new_item = list(item)
        metadata = dict(new_item[1] or {})
        for key, value in values.items():
            if append and key in metadata:
                existing = metadata.get(key)
                if isinstance(existing, list):
                    metadata[key] = existing + (value if isinstance(value, list) else [value])
                else:
                    metadata[key] = ([existing] if existing is not None else []) + (
                        value if isinstance(value, list) else [value]
                    )
            else:
                metadata[key] = value
        new_item[1] = metadata
        updated.append(new_item)
    return updated


def _load_vae(vae_name: str):
    vae_path = folder_paths.get_full_path("vae", vae_name)
    if not vae_path:
        raise RuntimeError(f"未找到 VAE：{vae_name}")
    sd, metadata = comfy.utils.load_torch_file(vae_path, return_metadata=True)
    vae = comfy.sd.VAE(sd=sd, metadata=metadata, dtype=None)
    vae.throw_exception_if_invalid()
    return vae


def _load_wan_clip(clip_name: str):
    clip_path = folder_paths.get_full_path("text_encoders", clip_name)
    if not clip_path:
        raise RuntimeError(f"未找到 CLIP：{clip_name}")
    try:
        embedding_directory = folder_paths.get_folder_paths("embeddings")
    except Exception:
        embedding_directory = []
    return comfy.sd.load_clip(
        ckpt_paths=[clip_path],
        embedding_directory=embedding_directory,
        clip_type=getattr(comfy.sd.CLIPType, "WAN", comfy.sd.CLIPType.STABLE_DIFFUSION),
        model_options={},
    )


def _apply_model_only_lora(model, lora_name: str, strength: float):
    if not str(lora_name or "").strip() or abs(float(strength)) <= 1e-6:
        return model
    full_path = folder_paths.get_full_path("loras", lora_name)
    if not full_path:
        raise RuntimeError(f"未找到 LoRA 文件：{lora_name}")
    lora_state = comfy.utils.load_torch_file(full_path, safe_load=True)
    patched_model, _ = comfy.sd.load_lora_for_models(model, None, lora_state, float(strength), 0.0)
    if patched_model is None:
        raise RuntimeError(f"LoRA 已读取但未成功应用：{lora_name}")
    return patched_model


def _load_unet(unet_name: str):
    model_path = folder_paths.get_full_path("diffusion_models", unet_name)
    if not model_path:
        raise RuntimeError(f"未找到 UNET：{unet_name}")
    return comfy.sd.load_diffusion_model(model_path, model_options={})


def _apply_sd3_shift(model, shift: float):
    patched = model.clone()

    class ModelSamplingAdvanced(comfy.model_sampling.ModelSamplingDiscreteFlow, comfy.model_sampling.CONST):
        pass

    model_sampling = ModelSamplingAdvanced(model.model.model_config)
    model_sampling.set_parameters(shift=float(shift), multiplier=1000)
    patched.add_object_patch("model_sampling", model_sampling)
    return patched


def _encode_text(clip, text: str):
    tokens = clip.tokenize(str(text or ""))
    return clip.encode_from_tokens_scheduled(tokens)


def _build_first_last_latent(positive, negative, vae, start_image, end_image, width, height, length, batch_size):
    spacial_scale = vae.spacial_compression_encode()
    latent = torch.zeros(
        [batch_size, vae.latent_channels, ((length - 1) // 4) + 1, height // spacial_scale, width // spacial_scale],
        device=comfy.model_management.intermediate_device(),
    )
    if start_image is not None:
        start_image = comfy.utils.common_upscale(start_image[:length].movedim(-1, 1), width, height, "bilinear", "center").movedim(1, -1)
    if end_image is not None:
        end_image = comfy.utils.common_upscale(end_image[-length:].movedim(-1, 1), width, height, "bilinear", "center").movedim(1, -1)

    image = torch.ones((length, height, width, 3), dtype=start_image.dtype if start_image is not None else (end_image.dtype if end_image is not None else torch.float32)) * 0.5
    mask = torch.ones((1, 1, latent.shape[2] * 4, latent.shape[-2], latent.shape[-1]))

    if start_image is not None:
        image[: start_image.shape[0]] = start_image
        mask[:, :, : start_image.shape[0] + 3] = 0.0

    if end_image is not None:
        image[-end_image.shape[0] :] = end_image
        mask[:, :, -end_image.shape[0] :] = 0.0

    concat_latent_image = vae.encode(image[:, :, :, :3])
    mask = mask.view(1, mask.shape[2] // 4, 4, mask.shape[3], mask.shape[4]).transpose(1, 2)
    positive = _conditioning_set_values(positive, {"concat_latent_image": concat_latent_image, "concat_mask": mask})
    negative = _conditioning_set_values(negative, {"concat_latent_image": concat_latent_image, "concat_mask": mask})
    return positive, negative, {"samples": latent}


class GJJ_Wan22FirstLastVideo:
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    DESCRIPTION = "将 Wan2.2 首尾帧生视频工作流封装成零外部依赖单节点，内部完成双阶段 4 步采样、解码与创建视频。"
    SEARCH_ALIASES = ["wan flf2v", "wan first last", "首尾帧", "首尾帧生视频", "wan 视频"]
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频生成结果",)
    OUTPUT_TOOLTIPS = ("按工作流默认参数生成的视频结果。",)

    @classmethod
    def INPUT_TYPES(cls):
        unet_models = _safe_filename_list("diffusion_models") or [DEFAULT_UNET]
        filtered_unets = [name for name in unet_models if "wan" in _normalize_text(name)] or unet_models
        return {
            "required": {
                "start_image": ("IMAGE", {"display_name": "首帧图像", "tooltip": "视频的起始帧。"}),
                "end_image": ("IMAGE", {"display_name": "尾帧图像", "tooltip": "视频的结束帧。"}),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_POSITIVE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "默认值来自工作流当前启用的首尾帧生视频模板。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "反向提示词",
                        "tooltip": "默认值来自工作流当前启用的首尾帧生视频模板。",
                    },
                ),
                "unet_name": (
                    filtered_unets,
                    {
                        "default": DEFAULT_UNET if DEFAULT_UNET in filtered_unets else filtered_unets[0],
                        "display_name": "主模型（UNET）",
                        "tooltip": "Wan2.2 首尾帧生视频的主模型；节点内部会自动配对 CLIP、VAE 和 4 步 LoRA。",
                    },
                ),
                "width": ("INT", {"default": DEFAULT_WIDTH, "min": 16, "max": 8192, "step": 16, "display_name": "宽度", "tooltip": "最终视频帧宽度。"}),
                "height": ("INT", {"default": DEFAULT_HEIGHT, "min": 16, "max": 8192, "step": 16, "display_name": "高度", "tooltip": "最终视频帧高度。"}),
                "length": ("INT", {"default": DEFAULT_LENGTH, "min": 1, "max": 4096, "step": 4, "display_name": "时长帧数", "tooltip": "视频总帧数。"}),
                "fps": ("FLOAT", {"default": DEFAULT_FPS, "min": 1.0, "max": 120.0, "step": 1.0, "display_name": "帧率", "tooltip": "输出视频的帧率。"}),
                "seed": (
                    "INT",
                    {
                        "default": 216136708794704,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "随机种子；改变后会得到不同的视频内容。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        start_image,
        end_image,
        positive_prompt,
        negative_prompt,
        unet_name,
        width,
        height,
        length,
        fps,
        seed,
        unique_id=None,
    ):
        _send_status(unique_id, "1/7 检查并加载 Wan 模型...")
        try:
            resolved_unet = _require_model_name("diffusion_models", unet_name, "UNET", DEFAULT_UNET)
            resolved_clip = _require_model_name("text_encoders", DEFAULT_CLIP, "CLIP", DEFAULT_CLIP)
            resolved_vae = _require_model_name("vae", DEFAULT_VAE, "VAE", DEFAULT_VAE)
            resolved_high_lora = _require_model_name("loras", DEFAULT_HIGH_LORA, "高噪 LoRA", DEFAULT_HIGH_LORA)
            resolved_low_lora = _require_model_name("loras", DEFAULT_LOW_LORA, "低噪 LoRA", DEFAULT_LOW_LORA)

            clip = _load_wan_clip(resolved_clip)
            vae = _load_vae(resolved_vae)
            model_high = _apply_sd3_shift(_apply_model_only_lora(_load_unet(resolved_unet), resolved_high_lora, 1.0), DEFAULT_SHIFT)
            model_low = _apply_sd3_shift(_apply_model_only_lora(_load_unet(resolved_unet), resolved_low_lora, 1.0), DEFAULT_SHIFT)
        except Exception as exc:
            raise RuntimeError(
                "首尾帧生视频节点加载模型失败。\n"
                f"UNET：{unet_name}\n"
                f"CLIP：{DEFAULT_CLIP}\n"
                f"VAE：{DEFAULT_VAE}\n"
                f"详细错误：{exc}"
            ) from exc

        _send_status(unique_id, "2/7 编码提示词...")
        positive = _encode_text(clip, str(positive_prompt or "").strip() or DEFAULT_POSITIVE)
        negative = _encode_text(clip, str(negative_prompt or "").strip() or DEFAULT_NEGATIVE)

        _send_status(unique_id, "3/7 构建首尾帧视频 latent...")
        positive, negative, latent = _build_first_last_latent(
            positive,
            negative,
            vae,
            start_image,
            end_image,
            int(width),
            int(height),
            int(length),
            1,
        )

        _send_status(unique_id, "4/7 第一阶段高噪采样...")
        stage1 = common_ksampler(
            model_high,
            int(seed),
            DEFAULT_STEPS,
            DEFAULT_CFG,
            DEFAULT_SAMPLER,
            DEFAULT_SCHEDULER,
            positive,
            negative,
            latent,
            denoise=1.0,
            disable_noise=False,
            start_step=0,
            last_step=2,
            force_full_denoise=False,
        )[0]

        _send_status(unique_id, "5/7 第二阶段低噪细化...")
        stage2 = common_ksampler(
            model_low,
            0,
            DEFAULT_STEPS,
            DEFAULT_CFG,
            DEFAULT_SAMPLER,
            DEFAULT_SCHEDULER,
            positive,
            negative,
            stage1,
            denoise=1.0,
            disable_noise=True,
            start_step=2,
            last_step=10000,
            force_full_denoise=True,
        )[0]

        _send_status(unique_id, "6/7 解码视频帧...")
        frames = VAEDecode().decode(vae, stage2)[0]

        _send_status(unique_id, "7/7 创建视频...")
        video = InputImpl.VideoFromComponents(
            Types.VideoComponents(
                images=frames,
                audio=None,
                frame_rate=Fraction(float(fps)),
            )
        )
        _send_status(unique_id, f"完成：视频 {int(width)} × {int(height)} / {int(length)} 帧")
        return (video,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Wan22FirstLastVideo}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 首尾帧生视频器"}
