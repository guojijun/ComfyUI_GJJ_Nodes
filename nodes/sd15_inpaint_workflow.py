from __future__ import annotations

import comfy.samplers
import folder_paths

from nodes import CLIPTextEncode, CheckpointLoaderSimple, KSampler, VAEDecode, VAEEncodeForInpaint


NODE_NAME = "GJJ_SD15InpaintWorkflow"
DEFAULT_CHECKPOINT = "512-inpainting-ema.safetensors"
DEFAULT_POSITIVE = "to apple"
DEFAULT_NEGATIVE = "watermark, text\n"
DEFAULT_SEED = 380822716303047
DEFAULT_STEPS = 20
DEFAULT_CFG = 8.0
DEFAULT_SAMPLER = "uni_pc_bh2"
DEFAULT_SCHEDULER = "normal"
DEFAULT_DENOISE = 1.0
DEFAULT_GROW_MASK_BY = 6


def _preferred_default(values: list[str], preferred: str) -> str:
    preferred = str(preferred or "").strip()
    if preferred and preferred in values:
        return preferred
    return values[0] if values else ""


class GJJ_SD15InpaintWorkflow:
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    DESCRIPTION = "把 sd1.5_inpaint 工作流收口成单节点，内部自动完成 checkpoint 加载、提示词编码、遮罩 VAE 编码、采样和解码。"
    SEARCH_ALIASES = [
        "sd15 inpaint",
        "sd1.5 inpaint",
        "inpaint workflow",
        "局部重绘",
        "修补",
        "遮罩重绘",
    ]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("重绘结果图像",)
    OUTPUT_TOOLTIPS = ("输出按当前 checkpoint、提示词和遮罩重绘参数生成的修复结果图像。",)

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = list(folder_paths.get_filename_list("checkpoints")) or [""]
        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "输入图像",
                        "tooltip": "需要执行 SD1.5 局部重绘的原始图像。",
                    },
                ),
                "mask": (
                    "MASK",
                    {
                        "display_name": "输入遮罩",
                        "tooltip": "白色区域表示需要重绘的区域。若想完全对齐原工作流，请传入和 LoadImage 遮罩输出相同语义的 MASK。",
                    },
                ),
                "ckpt_name": (
                    checkpoints,
                    {
                        "default": _preferred_default(checkpoints, DEFAULT_CHECKPOINT),
                        "display_name": "Checkpoint 模型",
                        "tooltip": "内部使用的 SD1.5 inpainting checkpoint，默认值来自工作流。",
                    },
                ),
                "positive": (
                    "STRING",
                    {
                        "default": DEFAULT_POSITIVE,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "用于描述想要生成内容的正向提示词，默认值来自工作流。",
                    },
                ),
                "negative": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "反向提示词",
                        "tooltip": "用于排除不想出现内容的反向提示词，默认值来自工作流。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": DEFAULT_SEED,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "随机种子，默认值来自工作流，可在每次生成后继续随机化。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": DEFAULT_STEPS,
                        "min": 1,
                        "max": 10000,
                        "display_name": "步数",
                        "tooltip": "采样步数，默认值来自工作流。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": DEFAULT_CFG,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "round": 0.01,
                        "display_name": "CFG 引导强度",
                        "tooltip": "提示词引导强度，默认值来自工作流。",
                    },
                ),
                "sampler_name": (
                    samplers,
                    {
                        "default": _preferred_default(samplers, DEFAULT_SAMPLER),
                        "display_name": "采样器",
                        "tooltip": "内部使用的采样器名称，默认值来自工作流。",
                    },
                ),
                "scheduler": (
                    schedulers,
                    {
                        "default": _preferred_default(schedulers, DEFAULT_SCHEDULER),
                        "display_name": "调度器",
                        "tooltip": "内部使用的调度器名称，默认值来自工作流。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": DEFAULT_DENOISE,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪",
                        "tooltip": "重绘时的降噪强度，默认值来自工作流。",
                    },
                ),
                "grow_mask_by": (
                    "INT",
                    {
                        "default": DEFAULT_GROW_MASK_BY,
                        "min": 0,
                        "max": 64,
                        "step": 1,
                        "display_name": "扩展遮罩",
                        "tooltip": "VAE 编码前额外扩展遮罩像素，默认值来自工作流。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(
        cls,
        image,
        mask,
        ckpt_name,
        positive,
        negative,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        grow_mask_by,
    ):
        return "|".join(
            [
                str(getattr(image, "shape", "")),
                str(getattr(mask, "shape", "")),
                str(ckpt_name),
                str(positive),
                str(negative),
                str(seed),
                str(steps),
                str(cfg),
                str(sampler_name),
                str(scheduler),
                str(denoise),
                str(grow_mask_by),
            ]
        )

    def generate(
        self,
        image,
        mask,
        ckpt_name,
        positive,
        negative,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        grow_mask_by,
    ):
        model, clip, vae = CheckpointLoaderSimple().load_checkpoint(ckpt_name)
        positive_conditioning = CLIPTextEncode().encode(clip, positive)[0]
        negative_conditioning = CLIPTextEncode().encode(clip, negative)[0]
        latent = VAEEncodeForInpaint().encode(vae, image, mask, grow_mask_by)[0]
        sampled = KSampler().sample(
            model,
            seed,
            steps,
            cfg,
            sampler_name,
            scheduler,
            positive_conditioning,
            negative_conditioning,
            latent,
            denoise,
        )[0]
        decoded = VAEDecode().decode(vae, sampled)[0]
        return (decoded,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SD15InpaintWorkflow}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🩹 SD1.5局部重绘工作流"}
