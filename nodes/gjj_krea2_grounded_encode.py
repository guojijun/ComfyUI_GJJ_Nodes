from typing import Any

import torch

import comfy.utils


NODE_NAME = "GJJ_Krea2EditGroundedEncode"
IMAGE_INPUT_TYPE = "IMAGE,GJJ_BATCH_IMAGE"


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _nested_image_values(value: Any) -> list[Any]:
    if value is None or torch.is_tensor(value) or isinstance(value, (str, bytes, bytearray)):
        return []
    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception:
            components = None
        if components is not None:
            return [
                _component_value(components, key)
                for key in ("images", "image", "frames", "frame", "batch", "samples", "items", "values")
                if _component_value(components, key) is not None
            ]
    if isinstance(value, dict):
        return [
            value[key]
            for key in ("images", "image", "frames", "frame", "batch", "samples", "items", "values")
            if key in value
        ]
    if isinstance(value, (list, tuple, set)):
        return list(value)
    result = []
    for key in ("images", "image", "frames", "frame", "batch", "samples", "items", "values"):
        item = getattr(value, key, None)
        if item is not None and item is not value:
            result.append(item)
    return result


def _normalize_image_tensor(value: torch.Tensor, label: str) -> torch.Tensor:
    tensor = value.detach()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim > 4 and int(tensor.shape[-1]) in (1, 2, 3, 4):
        tensor = tensor.reshape(
            -1,
            int(tensor.shape[-3]),
            int(tensor.shape[-2]),
            int(tensor.shape[-1]),
        )
    if tensor.ndim != 4:
        raise RuntimeError(
            f"{label}必须是 IMAGE / GJJ_BATCH_IMAGE，实际张量维度为 {tuple(tensor.shape)}。"
        )
    if int(tensor.shape[-1]) not in (1, 2, 3, 4) and int(tensor.shape[1]) in (1, 2, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 2:
        tensor = tensor[..., :1].repeat(1, 1, 1, 3)
    elif channels >= 4:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"{label}的通道数无效：{tuple(tensor.shape)}。")
    return tensor.float().clamp(0.0, 1.0).contiguous()


def _image_frames(value: Any, label: str = "输入图片") -> list[torch.Tensor]:
    if value is None:
        return []
    if torch.is_tensor(value):
        batch = _normalize_image_tensor(value, label)
        return [
            batch[index:index + 1].contiguous()
            for index in range(int(batch.shape[0]))
        ]
    frames = []
    for item in _nested_image_values(value):
        frames.extend(_image_frames(item, label))
    return frames


def _first_input_value(value: Any, default=None):
    current = value
    while isinstance(current, (list, tuple)) and len(current) == 1:
        current = current[0]
    if isinstance(current, (list, tuple)):
        return current[0] if current else default
    return default if current is None else current


class GJJ_Krea2EditGroundedEncode:
    DEFAULT_SYSTEM_PROMPT = (
        "Describe the image by detailing the color, shape, size, texture, quantity, "
        "text, spatial relationships of the objects and background:"
    )

    DESCRIPTION = (
        "Krea2 图像编辑语义接地编码：把正面、负面提示词分别与全部参考图一起交给 "
        "Qwen3-VL 编码，输出可直接用于 CFG 的正面和负面条件。"
    )
    CATEGORY = "GJJ/📝 文本/条件编码/Krea"
    FUNCTION = "encode"
    INPUT_IS_LIST = True
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("正面条件", "负面条件")
    OUTPUT_TOOLTIPS = (
        "参考图与正面提示词共同编码得到的 Krea2 正面条件。",
        "使用相同参考图与负面提示词共同编码得到的 Krea2 负面条件；留空负面提示词即匹配训练时的无条件分支。",
    )

    GJJ_HELP = {
        "说明": "复刻 Krea2EditGroundedEncode 的图像语义接地路径，并在一个节点中同时生成正面和负面条件。",
        "图片": "输入支持 IMAGE,GJJ_BATCH_IMAGE。递归拆包后，第 1 张固定映射为 image（参考图 A），第 2 张固定映射为 image_b（参考图 B），分别生成独立视觉块；两张图可以是人物、场景、商品或任意其他参考内容。",
        "正面条件": "使用全部参考图和正面提示词共同编码，用于采样器的正面输入。",
        "负面条件": "使用相同参考图和负面提示词共同编码。负面提示词留空时，对应训练时的图像接地无条件分支。",
        "编码器": "需要连接带视觉塔、支持图像输入的 Krea2 / Qwen3-VL CLIP。",
        "零依赖": "不导入 comfyui-krea2edit，也不依赖其他自定义节点，仅使用 ComfyUI 自带能力。",
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {
                    "display_name": "视觉文本编码器",
                    "tooltip": "连接带视觉塔的 Krea2 / Qwen3-VL CLIP，用于同时理解参考图和编辑提示词。",
                }),
                "image": (IMAGE_INPUT_TYPE, {
                    "display_name": "输入图片",
                    "tooltip": "支持 IMAGE、GJJ_BATCH_IMAGE 与嵌套批图。拆包后第 1 张进入 image（参考图 A），第 2 张进入 image_b（参考图 B）；不限定图片内容，最多两张且不按队列执行。",
                }),
                "positive_prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "dynamicPrompts": True,
                    "display_name": "正面编辑提示词",
                    "tooltip": "描述希望对参考图执行的编辑操作，用于生成正面条件。",
                }),
                "negative_prompt": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "dynamicPrompts": True,
                    "display_name": "负面提示词",
                    "tooltip": "用于生成负面条件。建议留空，以匹配 Krea2 图像编辑训练时的无条件分支。",
                }),
                "grounding_px": ("INT", {
                    "default": 768,
                    "min": 0,
                    "max": 4096,
                    "step": 64,
                    "display_name": "视觉接地分辨率",
                    "tooltip": "限制每张图送入视觉编码器的最长边；0 表示保持原始分辨率，768 接近训练分布。",
                }),
            },
            "optional": {
                "system_prompt": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "display_name": "系统提示词",
                    "tooltip": "可选。留空使用训练默认系统提示词；填写后可引导视觉编码器重点关注身份、面部或材质等信息。",
                }),
            },
        }

    @classmethod
    def _template(cls, image_count: int, system_prompt: str = "") -> str:
        prompt = str(system_prompt or "").strip() or cls.DEFAULT_SYSTEM_PROMPT
        vision_blocks = "<|vision_start|><|image_pad|><|vision_end|>" * image_count
        return (
            "<|im_start|>system\n"
            + prompt
            + "<|im_end|>\n<|im_start|>user\n"
            + vision_blocks
            + "{}<|im_end|>\n<|im_start|>assistant\n"
        )

    @staticmethod
    def _prepare_image(image: torch.Tensor, grounding_px: int) -> torch.Tensor:
        samples = image.movedim(-1, 1)
        height, width = int(samples.shape[2]), int(samples.shape[3])
        limit = int(grounding_px)
        if limit > 0 and max(height, width) > limit:
            scale = limit / max(height, width)
            samples = comfy.utils.common_upscale(
                samples,
                max(1, round(width * scale)),
                max(1, round(height * scale)),
                "area",
                "disabled",
            )
        return samples.movedim(1, -1)[..., :3].contiguous()

    @staticmethod
    def _encode_conditioning(clip, prompt: str, images: list[torch.Tensor], template: str):
        tokens = clip.tokenize(
            str(prompt or ""),
            images=images,
            llama_template=template,
        )
        return clip.encode_from_tokens_scheduled(tokens)

    def encode(
        self,
        clip,
        image,
        positive_prompt="",
        negative_prompt="",
        grounding_px=768,
        system_prompt="",
    ):
        clip = _first_input_value(clip)
        positive_prompt = _first_input_value(positive_prompt, "")
        negative_prompt = _first_input_value(negative_prompt, "")
        grounding_px = _first_input_value(grounding_px, 768)
        system_prompt = _first_input_value(system_prompt, "")
        if clip is None:
            raise RuntimeError("没有收到可用的视觉文本编码器。")
        frames = _image_frames(image)
        if not frames:
            raise RuntimeError("输入图片中没有可用于视觉接地编码的单张 IMAGE。")
        if len(frames) > 2:
            raise RuntimeError(
                f"Krea2 图像接地最多支持两张参考图，递归拆包后收到 {len(frames)} 张。"
                "请只保留需要使用的参考图 A 和参考图 B。"
            )
        image_primary = self._prepare_image(frames[0], grounding_px)
        image_b = self._prepare_image(frames[1], grounding_px) if len(frames) == 2 else None
        images = [image_primary]
        if image_b is not None:
            images.append(image_b)
        template = self._template(len(images), system_prompt)
        positive = self._encode_conditioning(clip, positive_prompt, images, template)
        negative = self._encode_conditioning(clip, negative_prompt, images, template)
        return positive, negative


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_Krea2EditGroundedEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "GJJ · 🎯 Krea2图像定位正负面编码",
}
