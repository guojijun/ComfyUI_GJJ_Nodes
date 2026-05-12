"""GJJ 扩图工具 - 节点定义模块

包含可能在某些 ComfyUI 版本中缺失的节点实现。
"""

import torch
import numpy as np
from PIL import Image
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

    def encode(self, positive, negative, vae, pixels, mask, noise_mask=True):
        x = (pixels.shape[1] // 8) * 8
        y = (pixels.shape[2] // 8) * 8
        mask = torch.nn.functional.interpolate(
            mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])),
            size=(pixels.shape[1], pixels.shape[2]),
            mode="bilinear",
        )

        orig_pixels = pixels
        pixels = orig_pixels.clone()
        if pixels.shape[1] != x or pixels.shape[2] != y:
            x_offset = (pixels.shape[1] % 8) // 2
            y_offset = (pixels.shape[2] % 8) // 2
            pixels = pixels[:, x_offset : x + x_offset, y_offset : y + y_offset, :]
            mask = mask[:, :, x_offset : x + x_offset, y_offset : y + y_offset]

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
                {"concat_latent_image": concat_latent, "concat_mask": mask},
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
                "guidance": (
                    "FLOAT",
                    {"default": 3.5, "min": 0.0, "max": 100.0, "step": 0.1},
                ),
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


class DifferentialDiffusion:
    """差分扩散"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "strength": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
            }
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "model_patches"

    def patch(self, model, strength):
        inner_model = model.inner_model if hasattr(model, "inner_model") else model

        if not hasattr(inner_model, "model_sampling"):
            return (model,)

        sigma_min = inner_model.model_sampling.sigma_min
        sigma_max = inner_model.model_sampling.sigma_max

        def denoise_mask_func(sigma, denoise_mask, extra_options):
            step_sigmas = extra_options.get("sigmas", None)
            if step_sigmas is not None and len(step_sigmas) > 0:
                sigma_from = step_sigmas[0]
                sigma_to = step_sigmas[-1]
                current_ts = inner_model.model_sampling.timestep(
                    sigma[0] if isinstance(sigma, (list, torch.Tensor)) else sigma
                )
                ts_from = inner_model.model_sampling.timestep(sigma_from)
                ts_to = inner_model.model_sampling.timestep(sigma_to)
                threshold = (current_ts - ts_to) / (ts_from - ts_to)
                binary_mask = (denoise_mask >= threshold).to(denoise_mask.dtype)
                if strength < 1:
                    return strength * binary_mask + (1 - strength) * denoise_mask
                return binary_mask
            return denoise_mask

        patched_model = model.clone()
        patched_model.set_model_denoise_mask_function(
            lambda *args, **kwargs: denoise_mask_func(*args, **kwargs)
        )
        return (patched_model,)


class ConstrainImage:
    """将图像约束到最大/最小尺寸，保持宽高比。

    来自 comfyui-custom-scripts，此处内置为本地实现，零外部依赖。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "max_width": ("INT", {"default": 1024, "min": 0}),
                "max_height": ("INT", {"default": 1024, "min": 0}),
                "min_width": ("INT", {"default": 0, "min": 0}),
                "min_height": ("INT", {"default": 0, "min": 0}),
                "crop_if_required": (["yes", "no"], {"default": "no"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "constrain_image"
    CATEGORY = "image"
    OUTPUT_IS_LIST = (True,)

    def constrain_image(
        self, images, max_width, max_height, min_width, min_height, crop_if_required
    ):
        crop_if_required = crop_if_required == "yes"
        results = []
        for image in images:
            i = 255.0 * image.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8)).convert("RGB")

            current_width, current_height = img.size
            aspect_ratio = current_width / current_height

            constrained_width = min(max(current_width, min_width), max_width)
            constrained_height = min(max(current_height, min_height), max_height)

            if constrained_width / constrained_height > aspect_ratio:
                constrained_width = max(
                    int(constrained_height * aspect_ratio), min_width
                )
                if crop_if_required:
                    constrained_height = int(
                        current_height / (current_width / constrained_width)
                    )
            else:
                constrained_height = max(
                    int(constrained_width / aspect_ratio), min_height
                )
                if crop_if_required:
                    constrained_width = int(
                        current_width / (current_height / constrained_height)
                    )

            resized_image = img.resize(
                (constrained_width, constrained_height), Image.LANCZOS
            )

            if crop_if_required and (
                constrained_width > max_width or constrained_height > max_height
            ):
                left = max((constrained_width - max_width) // 2, 0)
                top = max((constrained_height - max_height) // 2, 0)
                right = min(constrained_width, max_width) + left
                bottom = min(constrained_height, max_height) + top
                resized_image = resized_image.crop((left, top, right, bottom))

            resized_image = np.array(resized_image).astype(np.float32) / 255.0
            resized_image = torch.from_numpy(resized_image)[None,]
            results.append(resized_image)

        return (results,)


class ImagePadKJ:
    """图像填充扩图（仅 color 模式）。

    来自 comfyui-kjnodes，此处内置为精简本地实现，零外部依赖。
    仅实现 qwen_image 工作流所需的 color 填充模式。
    """

    MAX_RESOLUTION = 16384

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "left": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "right": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "top": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "bottom": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "extra_padding": (
                    "INT",
                    {"default": 0, "min": 0, "max": 16384, "step": 1},
                ),
                "pad_mode": (["edge", "edge_pixel", "color"],),
                "color": ("STRING", {"default": "0, 0, 0"}),
            },
            "optional": {
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("images", "masks")
    FUNCTION = "pad"
    CATEGORY = "image"

    def pad(
        self, image, left, right, top, bottom, extra_padding, color, pad_mode, mask=None
    ):
        B, H, W, C = image.shape
        image = image.clone()

        # 解析颜色
        color_parts = [x.strip() for x in color.split(",")]
        if len(color_parts) == 1:
            v = float(color_parts[0])
            if v > 1.0:
                v = v / 255.0
            bg_color = torch.tensor([v, v, v], dtype=image.dtype, device=image.device)
        elif len(color_parts) >= 3:
            rgb = [float(x) for x in color_parts[:3]]
            if any(x > 1.0 for x in rgb):
                rgb = [x / 255.0 for x in rgb]
            bg_color = torch.tensor(rgb, dtype=image.dtype, device=image.device)
        else:
            bg_color = torch.zeros(3, dtype=image.dtype, device=image.device)

        # 计算最终尺寸
        pad_left = left + extra_padding
        pad_right = right + extra_padding
        pad_top = top + extra_padding
        pad_bottom = bottom + extra_padding
        padded_width = W + pad_left + pad_right
        padded_height = H + pad_top + pad_bottom

        out_image = torch.zeros(
            (B, padded_height, padded_width, C), dtype=image.dtype, device=image.device
        )
        for b in range(B):
            out_image[b, :, :, :] = bg_color.unsqueeze(0).unsqueeze(0)
            out_image[b, pad_top : pad_top + H, pad_left : pad_left + W, :] = image[b]

        # mask 处理：前景区域为 1（保留），填充区域为 0
        out_masks = torch.zeros(
            (B, padded_height, padded_width), dtype=image.dtype, device=image.device
        )
        out_masks[:, pad_top : pad_top + H, pad_left : pad_left + W] = 1.0

        return (out_image, out_masks)


class JoinImageWithAlpha:
    """合并图像和 alpha 遮罩。

    精简本地实现，用于 flux2_klein 工作流。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "alpha": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "join_image_with_alpha"
    CATEGORY = "image"

    def join_image_with_alpha(
        self, image: torch.Tensor, alpha: torch.Tensor
    ) -> tuple[torch.Tensor,]:
        batch_size = min(len(image), len(alpha))
        out_images = []
        alpha = 1.0 - (alpha / alpha.max() if alpha.max() > 0 else alpha)
        for i in range(batch_size):
            a = alpha[i].unsqueeze(2)
            out_images.append(torch.cat((image[i], a), dim=2))
        result = (torch.stack(out_images, dim=0),)
        return result


class ImageCompositeMasked:
    """遮罩图像合成。

    精简本地实现，用于 flux2_klein 工作流。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "destination": ("IMAGE",),
                "source": ("IMAGE",),
                "x": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "y": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "resize_source": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "composite"
    CATEGORY = "image"

    def composite(
        self,
        destination: torch.Tensor,
        source: torch.Tensor,
        x: int,
        y: int,
        resize_source: bool,
        mask: torch.Tensor = None,
    ) -> tuple[torch.Tensor,]:
        destination = destination.clone().movedim(-1, 1)
        source = source.movedim(-1, 1)

        if resize_source:
            source = torch.nn.functional.interpolate(
                source,
                size=(destination.shape[2], destination.shape[3]),
                mode="bilinear",
            )
            x = y = 0

        batch = max(len(destination), len(source))
        out = []
        for b in range(batch):
            dst = destination[b if b < len(destination) else -1]
            src = source[b if b < len(source) else -1]

            sx, sy = max(0, x), max(0, y)
            ex = min(sx + src.shape[2], dst.shape[2])
            ey = min(sy + src.shape[1], dst.shape[1])

            if mask is not None:
                m = mask[b if b < len(mask) else -1]
                m = (
                    torch.nn.functional.interpolate(
                        m.unsqueeze(0).unsqueeze(0),
                        size=(ey - sy, ex - sx),
                        mode="bilinear",
                    )
                    .squeeze(0)
                    .squeeze(0)
                )
                m = m.unsqueeze(0).expand(3, -1, -1)
                composite_region = src[:, : ey - sy, : ex - sx] * m + dst[
                    :, sy:ey, sx:ex
                ] * (1 - m)
                dst[:, sy:ey, sx:ex] = composite_region
            else:
                dst[:, sy:ey, sx:ex] = src[:, : ey - sy, : ex - sx]

            out.append(dst)
        result = torch.stack(out, dim=0).movedim(1, -1)
        return (result,)


class FluxKontextImageScale:
    """Flux Kontext 图像缩放。

    精简本地实现，用于 flux2_klein 工作流。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "scale"
    CATEGORY = "image"

    def scale(self, image: torch.Tensor) -> tuple[torch.Tensor,]:
        # 向下取到 8 的倍数
        B, H, W, C = image.shape
        new_h = (H // 8) * 8
        new_w = (W // 8) * 8
        if new_h != H or new_w != W:
            image = image[:, :new_h, :new_w, :]
        return (image,)


class ReferenceLatent:
    """ReferenceLatent - 将 latent 注入 conditioning。

    精简本地实现，用于 flux2_klein 和 qwen_image 工作流。
    从 ComfyUI 原生 nodes 中提取逻辑。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "conditioning": ("CONDITIONING",),
                "latent": ("LATENT",),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "reference"
    CATEGORY = "conditioning"

    def reference(self, conditioning, latent):
        c = node_helpers.conditioning_set_values(
            conditioning,
            {"concat_latent_image": latent["samples"]},
        )
        return (c,)


class ModelSamplingAuraFlow:
    """ModelSamplingAuraFlow - 设置 shift 参数。

    精简本地实现，用于 qwen_image 工作流。
    直接修改 model.model_sampling.shift。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "shift": (
                    "FLOAT",
                    {"default": 3.1, "min": 0.0, "max": 100.0, "step": 0.01},
                ),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "advanced/model"

    def patch(self, model, shift):
        m = model.clone()
        inner = m.inner_model if hasattr(m, "inner_model") else m
        if hasattr(inner, "model_sampling"):
            inner.model_sampling.shift = shift
        return (m,)


class CFGNorm:
    """CFGNorm - 设置 cfg_normalization 参数。

    精简本地实现，用于 qwen_image 工作流。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "strength": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01},
                ),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "advanced/model"

    def patch(self, model, strength):
        m = model.clone()
        m.set_model_cfg_normalization(strength)
        return (m,)


class LoraLoaderModelOnly:
    """LoraLoaderModelOnly - 仅加载 LoRA 到模型。

    精简本地实现，用于 qwen_image 工作流。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_name": (
                    sorted(__import__("folder_paths").get_filename_list("loras")),
                ),
                "strength_model": (
                    "FLOAT",
                    {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01},
                ),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load_lora"
    CATEGORY = "loaders"

    def load_lora(self, model, lora_name, strength_model):
        import folder_paths

        lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
        lora_data = comfy.utils.load_torch_file(lora_path, safe_load=True)
        model_lora, _ = comfy.sd.load_lora_for_models(
            model, None, lora_data, strength_model, 0.0
        )
        return (model_lora,)


class TextEncodeQwenImageEditPlus:
    """TextEncodeQwenImageEditPlus - Qwen Image Edit 文本编码。

    精简本地实现，用于 qwen_image 工作流。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "image": ("IMAGE",),
                "text": (
                    "STRING",
                    {"multiline": True, "default": ""},
                ),
            },
            "optional": {
                "mask": ("MASK",),
                "image2": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "encode"
    CATEGORY = "conditioning"

    def encode(
        self,
        clip,
        vae,
        image,
        text,
        mask=None,
        image2=None,
    ):
        # 使用原生 CLIPTextEncode 编码文本
        from nodes import CLIPTextEncode

        encoder = CLIPTextEncode()
        cond = encoder.encode(clip, text)[0]

        # 注入 concat_latent_image
        import folder_paths, comfy.sd

        latent = vae.encode(image[:, :, :, :3])
        cond = node_helpers.conditioning_set_values(
            cond,
            {"concat_latent_image": latent},
        )
        return (cond,)


__all__ = [
    "ConditioningZeroOut",
    "InpaintModelConditioning",
    "FluxGuidance",
    "FluxDisableGuidance",
    "DifferentialDiffusion",
    "ConstrainImage",
    "ImagePadKJ",
    "JoinImageWithAlpha",
    "ImageCompositeMasked",
    "FluxKontextImageScale",
    "ReferenceLatent",
    "ModelSamplingAuraFlow",
    "CFGNorm",
    "LoraLoaderModelOnly",
    "TextEncodeQwenImageEditPlus",
]
