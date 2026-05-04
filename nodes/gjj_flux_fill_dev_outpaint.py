from __future__ import annotations

from typing import Any

import comfy.sd
import comfy.utils
import folder_paths
import node_helpers
import torch
from nodes import CLIPTextEncode, ImagePadForOutpaint, InpaintModelConditioning, VAEDecode, common_ksampler
from server import PromptServer

from .gjj_model_bundle_loader import UNET_DTYPE_OPTIONS, _build_unet_model_options, _resolve_full_path, list_unet_models


NODE_NAME = "GJJ_FluxFillDevOutpaint"
DEFAULT_UNET = "flux1-fill-dev.safetensors"
DEFAULT_UNET_DTYPE = "fp8_e4m3fn"
DEFAULT_CLIP_1 = "clip_l.safetensors"
DEFAULT_CLIP_2 = "t5xxl_fp16.safetensors"
DEFAULT_VAE = "ae.safetensors"
DEFAULT_POSITIVE = "A futuristic city under a glass shell in the center of the desert."
DEFAULT_NEGATIVE = ""
DEFAULT_GUIDANCE = 30.0
DEFAULT_STEPS = 20
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "normal"
DEFAULT_DENOISE = 1.0
DEFAULT_DIFF_STRENGTH = 1.0


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        PromptServer.instance.send_progress_text(str(text or ""), unique_id)
    except Exception:
        return


def _load_vae(vae_name: str):
    vae_path = _resolve_full_path(("vae",), vae_name)
    sd, metadata = comfy.utils.load_torch_file(vae_path, return_metadata=True)
    vae = comfy.sd.VAE(sd=sd, metadata=metadata, dtype=None)
    vae.throw_exception_if_invalid()
    return vae


def _load_flux_clip(clip_name1: str, clip_name2: str):
    clip_path1 = _resolve_full_path(("text_encoders", "clip"), clip_name1)
    clip_path2 = _resolve_full_path(("text_encoders", "clip"), clip_name2)
    try:
        embedding_directory = folder_paths.get_folder_paths("embeddings")
    except Exception:
        embedding_directory = []
    return comfy.sd.load_clip(
        ckpt_paths=[clip_path1, clip_path2],
        embedding_directory=embedding_directory,
        clip_type=getattr(comfy.sd.CLIPType, "FLUX", comfy.sd.CLIPType.STABLE_DIFFUSION),
        model_options={},
    )


def _apply_flux_guidance(conditioning, guidance: float):
    return node_helpers.conditioning_set_values(conditioning, {"guidance": float(guidance)})


def _apply_differential_diffusion(model, strength: float):
    patched = model.clone()

    def forward(sigma: torch.Tensor, denoise_mask: torch.Tensor, extra_options: dict, strength_value: float):
        inner_model = extra_options["model"]
        step_sigmas = extra_options["sigmas"]
        sigma_to = inner_model.inner_model.model_sampling.sigma_min
        if step_sigmas[-1] > sigma_to:
            sigma_to = step_sigmas[-1]
        sigma_from = step_sigmas[0]

        ts_from = inner_model.inner_model.model_sampling.timestep(sigma_from)
        ts_to = inner_model.inner_model.model_sampling.timestep(sigma_to)
        current_ts = inner_model.inner_model.model_sampling.timestep(sigma[0])
        threshold = (current_ts - ts_to) / (ts_from - ts_to)
        binary_mask = (denoise_mask >= threshold).to(denoise_mask.dtype)

        if strength_value and strength_value < 1:
            return strength_value * binary_mask + (1 - strength_value) * denoise_mask
        return binary_mask

    patched.set_model_denoise_mask_function(
        lambda *args, **kwargs: forward(*args, **kwargs, strength_value=float(strength))
    )
    return patched


class GJJ_FluxFillDevOutpaint:
    CATEGORY = "GJJ"
    FUNCTION = "outpaint"
    DESCRIPTION = (
        "将官方 flux_fill_dev_outpaint 工作流封装成简洁单节点。"
        "前台只暴露底图、正向提示词、UNET、外扩边距和种子；"
        "CLIP、VAE、Flux 引导、差分扩散和采样参数在后台按官方默认流程处理。"
    )
    SEARCH_ALIASES = [
        "flux fill",
        "flux fill dev",
        "outpaint",
        "外扩",
        "外扩绘制",
        "outpainting",
    ]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("外扩生成图像",)
    OUTPUT_TOOLTIPS = ("按官方 Flux Fill Dev Outpaint 工作流生成的最终外扩结果图像。",)

    def __init__(self):
        self._runtime_cache_key: tuple[str, str] | None = None
        self._runtime_cache_value: tuple[Any, Any, Any] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        unet_models = [DEFAULT_UNET] or list_unet_models()
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "输入图像",
                        "tooltip": "需要做外扩的原始底图。",
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_POSITIVE,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "默认值来自官方 flux_fill_dev_outpaint 工作流。",
                    },
                ),
                "unet_name": (
                    unet_models,
                    {
                        "default": DEFAULT_UNET if DEFAULT_UNET in unet_models else unet_models[0],
                        "display_name": "UNET 主模型",
                        "tooltip": "主扩散模型。默认使用官方工作流中的 flux1-fill-dev.safetensors。",
                    },
                ),
                "left": (
                    "INT",
                    {
                        "default": 400,
                        "min": 0,
                        "max": 8192,
                        "step": 8,
                        "display_name": "左扩",
                        "tooltip": "向左扩展的像素值。",
                    },
                ),
                "top": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 8192,
                        "step": 8,
                        "display_name": "上扩",
                        "tooltip": "向上扩展的像素值。",
                    },
                ),
                "right": (
                    "INT",
                    {
                        "default": 400,
                        "min": 0,
                        "max": 8192,
                        "step": 8,
                        "display_name": "右扩",
                        "tooltip": "向右扩展的像素值。",
                    },
                ),
                "bottom": (
                    "INT",
                    {
                        "default": 400,
                        "min": 0,
                        "max": 8192,
                        "step": 8,
                        "display_name": "下扩",
                        "tooltip": "向下扩展的像素值。",
                    },
                ),
                "feathering": (
                    "INT",
                    {
                        "default": 24,
                        "min": 0,
                        "max": 1024,
                        "step": 1,
                        "display_name": "羽化",
                        "tooltip": "外扩边缘的羽化过渡，默认值来自官方工作流。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 50915499055174,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "采样随机种子，默认值来自官方工作流。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, image, positive_prompt, unet_name, left, top, right, bottom, feathering, seed, unique_id=None):
        return "|".join(
            [
                str(tuple(image.shape)) if hasattr(image, "shape") else "image",
                str(positive_prompt),
                str(unet_name),
                str(left),
                str(top),
                str(right),
                str(bottom),
                str(feathering),
                str(seed),
            ]
        )

    def _load_runtime(self, unet_name: str):
        cache_key = (str(unet_name or ""), DEFAULT_UNET_DTYPE)
        if self._runtime_cache_key == cache_key and self._runtime_cache_value is not None:
            return self._runtime_cache_value

        model_path = _resolve_full_path(("diffusion_models", "checkpoints"), unet_name)
        model = comfy.sd.load_diffusion_model(model_path, model_options=_build_unet_model_options(DEFAULT_UNET_DTYPE))
        clip = _load_flux_clip(DEFAULT_CLIP_1, DEFAULT_CLIP_2)
        vae = _load_vae(DEFAULT_VAE)

        self._runtime_cache_key = cache_key
        self._runtime_cache_value = (model, clip, vae)
        return model, clip, vae

    def outpaint(
        self,
        image,
        positive_prompt,
        unet_name,
        left,
        top,
        right,
        bottom,
        feathering,
        seed,
        unique_id=None,
    ):
        _send_status(unique_id, "1/6 检查并加载 Flux Fill 模型...")
        try:
            model, clip, vae = self._load_runtime(unet_name)
        except Exception as exc:
            raise RuntimeError(
                "Flux Fill Dev 外扩节点加载模型失败。\n"
                f"UNET: {unet_name}\n"
                f"CLIP: {DEFAULT_CLIP_1} + {DEFAULT_CLIP_2}\n"
                f"VAE: {DEFAULT_VAE}\n"
                f"详细错误：{exc}"
            ) from exc

        _send_status(unique_id, "2/6 编码提示词...")
        positive = CLIPTextEncode().encode(clip, str(positive_prompt or "").strip() or DEFAULT_POSITIVE)[0]
        negative = CLIPTextEncode().encode(clip, DEFAULT_NEGATIVE)[0]
        positive = _apply_flux_guidance(positive, DEFAULT_GUIDANCE)

        _send_status(unique_id, "3/6 扩展画布并生成遮罩...")
        padded_image, mask = ImagePadForOutpaint().expand_image(
            image,
            int(left),
            int(top),
            int(right),
            int(bottom),
            int(feathering),
        )

        _send_status(unique_id, "4/6 构建 Inpaint 条件...")
        positive, negative, latent = InpaintModelConditioning().encode(
            positive,
            negative,
            padded_image,
            vae,
            mask,
            noise_mask=False,
        )
        model = _apply_differential_diffusion(model, DEFAULT_DIFF_STRENGTH)

        _send_status(unique_id, "5/6 采样中...")
        sampled = common_ksampler(
            model,
            int(seed),
            DEFAULT_STEPS,
            DEFAULT_CFG,
            DEFAULT_SAMPLER,
            DEFAULT_SCHEDULER,
            positive,
            negative,
            latent,
            denoise=DEFAULT_DENOISE,
        )[0]

        _send_status(unique_id, "6/6 解码结果图像...")
        result = VAEDecode().decode(vae, sampled)[0]
        _send_status(unique_id, f"完成：{int(result.shape[2])} × {int(result.shape[1])}")
        return (result,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_FluxFillDevOutpaint}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🖼️ Flux外扩图片填充编辑器"}
