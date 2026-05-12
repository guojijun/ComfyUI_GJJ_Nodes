"""GJJ 扩图工具 - 本地节点实现

包含 ComfyUI 核心库中可能缺失的节点实现。
"""

import torch
import node_helpers
import comfy.model_management


class ConditioningZeroOut:
    """将 conditioning 值归零"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"conditioning": ("CONDITIONING",)},
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "zero_out"
    CATEGORY = "advanced/conditioning"

    def zero_out(self, conditioning):
        c = []
        for t in conditioning:
            d = t[1].copy()
            pooled_output = d.get("pooled_output", None)
            if pooled_output is not None:
                d["pooled_output"] = torch.zeros_like(pooled_output)
            conditioning_lyrics = d.get("conditioning_lyrics", None)
            if conditioning_lyrics is not None:
                d["conditioning_lyrics"] = torch.zeros_like(conditioning_lyrics)
            c_vec = d.get("c_crossattn", None)
            if c_vec is not None:
                d["c_crossattn"] = torch.zeros_like(c_vec)
            c.append([torch.zeros_like(t[0]), d])
        return (c,)


class InpaintModelConditioning:
    """图像修复模型条件处理"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "vae": ("VAE",),
                "pixels": ("IMAGE",),
                "mask": ("MASK",),
                "noise_mask": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "latent")
    FUNCTION = "encode"
    CATEGORY = "conditioning/inpaint"

    def encode(self, positive, negative, pixels, vae, mask, noise_mask=True):
        x = (pixels.shape[1] // 8) * 8
        y = (pixels.shape[2] // 8) * 8
        mask = torch.nn.functional.interpolate(
            mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])),
            size=(pixels.shape[1], pixels.shape[2]),
            mode="bilinear"
        )

        orig_pixels = pixels
        pixels = orig_pixels.clone()
        if pixels.shape[1] != x or pixels.shape[2] != y:
            x_offset = (pixels.shape[1] % 8) // 2
            y_offset = (pixels.shape[2] % 8) // 2
            pixels = pixels[:, x_offset:x + x_offset, y_offset:y + y_offset, :]
            mask = mask[:, :, x_offset:x + x_offset, y_offset:y + y_offset]

        m = (1.0 - mask.round()).squeeze(1)
        for i in range(3):
            pixels[:, :, :, i] -= 0.5
            pixels[:, :, :, i] *= m
            pixels[:, :, :, i] += 0.5

        concat_latent = vae.encode(pixels)
        orig_latent = vae.encode(orig_pixels)

        out_latent = {}
        out_latent["samples"] = orig_latent
        if noise_mask:
            out_latent["noise_mask"] = mask

        out = []
        for conditioning in [positive, negative]:
            c = node_helpers.conditioning_set_values(
                conditioning,
                {"concat_latent_image": concat_latent, "concat_mask": mask}
            )
            out.append(c)
        return (out[0], out[1], out_latent)


class FluxGuidance:
    """Flux 引导值设置"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "conditioning": ("CONDITIONING",),
                "guidance": ("FLOAT", {"default": 3.5, "min": 0.0, "max": 100.0, "step": 0.1}),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "apply"
    CATEGORY = "advanced/conditioning/flux"

    def apply(self, conditioning, guidance):
        c = node_helpers.conditioning_set_values(conditioning, {"guidance": guidance})
        return (c,)


class FluxDisableGuidance:
    """禁用 Flux 引导"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"conditioning": ("CONDITIONING",)},
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "apply"
    CATEGORY = "advanced/conditioning/flux"

    def apply(self, conditioning):
        c = node_helpers.conditioning_set_values(conditioning, {"guidance": None})
        return (c,)


# DifferentialDiffusion 实现
class DifferentialDiffusion:
    """差分扩散"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "model_patches"

    def patch(self, model, strength):
        # 获取模型的内部结构
        inner_model = model.inner_model if hasattr(model, "inner_model") else model

        if not hasattr(inner_model, "model_sampling"):
            return (model,)

        # 计算阈值
        sigma_min = inner_model.model_sampling.sigma_min
        sigma_max = inner_model.model_sampling.sigma_max

        def denoise_mask_func(sigma, denoise_mask, extra_options):
            step_sigmas = extra_options.get("sigmas", None)
            if step_sigmas is not None and len(step_sigmas) > 0:
                sigma_from = step_sigmas[0]
                sigma_to = step_sigmas[-1]
                current_ts = inner_model.model_sampling.timestep(sigma[0] if isinstance(sigma, (list, torch.Tensor)) else sigma)
                ts_from = inner_model.model_sampling.timestep(sigma_from)
                ts_to = inner_model.model_sampling.timestep(sigma_to)
                threshold = (current_ts - ts_to) / (ts_from - ts_to)
                binary_mask = (denoise_mask >= threshold).to(denoise_mask.dtype)
                if strength < 1:
                    return strength * binary_mask + (1 - strength) * denoise_mask
                return binary_mask
            return denoise_mask

        # 克隆模型并应用补丁
        patched_model = model.clone()
        patched_model.set_model_denoise_mask_function(
            lambda *args, **kwargs: denoise_mask_func(*args, **kwargs)
        )
        return (patched_model,)


# 注册所有节点
NODE_CLASS_MAPPINGS = {
    "GJJ_ConditioningZeroOut": ConditioningZeroOut,
    "GJJ_InpaintModelConditioning": InpaintModelConditioning,
    "GJJ_FluxGuidance": FluxGuidance,
    "GJJ_FluxDisableGuidance": FluxDisableGuidance,
    "GJJ_DifferentialDiffusion": DifferentialDiffusion,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_ConditioningZeroOut": "GJJ ConditioningZeroOut",
    "GJJ_InpaintModelConditioning": "GJJ InpaintModelConditioning",
    "GJJ_FluxGuidance": "GJJ FluxGuidance",
    "GJJ_FluxDisableGuidance": "GJJ FluxDisableGuidance",
    "GJJ_DifferentialDiffusion": "GJJ DifferentialDiffusion",
}

__all__ = [
    "ConditioningZeroOut",
    "InpaintModelConditioning",
    "FluxGuidance",
    "FluxDisableGuidance",
    "DifferentialDiffusion",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
