import torch
import torch.nn.functional as F
from typing import Any


NODE_NAME = "GJJ_Krea2EditRebalance"
IMAGE_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE"

SYS_TEMPLATE = (
    "<|im_start|>system\n"
    "Describe the key features of the input image (color, shape, size, texture, "
    "objects, background), then explain how the user's text instruction should "
    "alter or modify the image. Generate a new image that meets the user's "
    "requirements while maintaining consistency with the original input where "
    "appropriate.<|im_end|>\n"
    "<|im_start|>user\n{}<|im_end|>\n"
    "<|im_start|>assistant\n"
)

RESOLUTIONS = {
    "low": 256,
    "normal": 512,
    "high": 1024,
    "max": 1280,
}


def _unit_norm_dim(tensor, eps=1e-8):
    dtype = tensor.dtype
    value = tensor.float()
    norm = torch.sqrt(value.pow(2).sum(dim=-1, keepdim=True) + eps)
    return (value / norm).to(dtype)


def _split_bands(tensor, n_bands=12):
    flat = tensor.shape[-1]
    if n_bands > 1 and flat % n_bands == 0:
        band_dim = flat // n_bands
        return tensor.view(*tensor.shape[:-1], n_bands, band_dim), band_dim
    return None, None


def _merge_bands(tensor):
    n_bands = tensor.shape[-2]
    band_dim = tensor.shape[-1]
    return tensor.reshape(*tensor.shape[:-2], n_bands * band_dim)


def _extract_cond_tensor(item):
    if (
        isinstance(item, (list, tuple))
        and len(item) == 2
        and isinstance(item[0], torch.Tensor)
        and isinstance(item[1], dict)
    ):
        return item[0]
    if isinstance(item, torch.Tensor):
        return item
    return None


def _match_batch(ref_dir, target_batch):
    if ref_dir.shape[0] == 1 and target_batch != 1:
        return ref_dir.expand(target_batch, *ref_dir.shape[1:])
    if ref_dir.shape[0] != target_batch:
        return ref_dir.mean(dim=0, keepdim=True).expand(target_batch, *ref_dir.shape[1:])
    return ref_dir


def _parse_floats(text):
    if not text:
        return None
    raw = str(text).strip()
    if not raw:
        return None
    try:
        values = [float(item) for item in raw.replace(";", ",").split(",") if item.strip() != ""]
    except ValueError:
        return None
    if len(values) < 2:
        return None
    return values


def _scale_to_resolution(samples, target):
    batch, channels, height, width = samples.shape
    if height == target and width == target:
        return samples

    scale = target / max(height, width)
    new_height = max(1, round(height * scale))
    new_width = max(1, round(width * scale))
    dtype = samples.dtype
    scaled = F.interpolate(samples.float(), size=(new_height, new_width), mode="area")
    return scaled.to(dtype)


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _normalize_image_batch(value: torch.Tensor, label: str) -> torch.Tensor:
    tensor = value.detach()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim > 4 and int(tensor.shape[-1]) in (1, 2, 3, 4):
        tensor = tensor.reshape(-1, int(tensor.shape[-3]), int(tensor.shape[-2]), int(tensor.shape[-1]))
    if tensor.ndim != 4:
        raise RuntimeError(f"{label} 必须是 IMAGE / GJJ_BATCH_IMAGE 张量，实际维度为 {tuple(tensor.shape)}。")
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
        raise RuntimeError(f"{label} 图像通道数无效：{tuple(tensor.shape)}。")
    if int(tensor.shape[0]) <= 0:
        return tensor[:0]
    return tensor.float().clamp(0.0, 1.0).contiguous()


def _iter_nested_image_values(value: Any) -> list[Any]:
    if value is None or isinstance(value, (str, bytes, bytearray)) or torch.is_tensor(value):
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
        return [value[key] for key in ("images", "image", "frames", "frame", "batch", "samples", "items", "values") if key in value]
    if isinstance(value, (list, tuple)):
        return list(value)
    result = []
    for key in ("images", "image", "frames", "frame", "batch", "samples", "items", "values"):
        item = getattr(value, key, None)
        if item is not None and item is not value:
            result.append(item)
    return result


def _image_frames(value: Any, label: str = "参考图") -> list[torch.Tensor]:
    if value is None:
        return []
    if isinstance(value, torch.Tensor):
        tensor = _normalize_image_batch(value, label)
        return [tensor[index : index + 1].contiguous() for index in range(int(tensor.shape[0]))]
    frames = []
    for item in _iter_nested_image_values(value):
        frames.extend(_image_frames(item, label))
    return frames


def _compile_edit(clip, prompt, images_with_size=None):
    images_vl = []
    image_prompt = ""

    if images_with_size:
        for index, (image, tier) in enumerate(images_with_size):
            if image is None:
                continue
            target = RESOLUTIONS.get(tier, RESOLUTIONS["normal"])
            samples = image.movedim(-1, 1)
            scaled = _scale_to_resolution(samples, target)
            images_vl.append(scaled.movedim(1, -1))
            image_prompt += "Picture {}: <|vision_start|><|image_pad|><|vision_end|>".format(index + 1)

    full_prompt = image_prompt + prompt if image_prompt else prompt
    tokens = clip.tokenize(
        full_prompt,
        images=images_vl if images_vl else None,
        llama_template=SYS_TEMPLATE,
    )
    return clip.encode_from_tokens_scheduled(tokens)


def _scale_cond_tensor(tensor, scale, weights=None):
    if weights is None:
        return tensor * scale

    flat = tensor.shape[-1]
    n_layers = len(weights)
    if n_layers > 1 and flat % n_layers == 0:
        layer_dim = flat // n_layers
        orig_dtype = tensor.dtype
        value = tensor.float()
        value = value.view(*value.shape[:-1], n_layers, layer_dim)
        gains = torch.tensor(weights, dtype=value.dtype, device=value.device)
        value = value * gains.view(*([1] * (value.dim() - 2)), n_layers, 1)
        value = value.view(*value.shape[:-2], flat)
        return value.to(orig_dtype) * scale
    return tensor * scale


def _scale_conditioning(structure, scale, weights=None):
    if isinstance(structure, list):
        output = []
        for item in structure:
            if (
                isinstance(item, (list, tuple))
                and len(item) == 2
                and isinstance(item[0], torch.Tensor)
                and isinstance(item[1], dict)
            ):
                cond_t, extras = item
                output.append([_scale_cond_tensor(cond_t, scale, weights), dict(extras)])
            else:
                output.append(_scale_conditioning(item, scale, weights))
        return output
    if isinstance(structure, torch.Tensor):
        return _scale_cond_tensor(structure, scale, weights)
    if isinstance(structure, dict):
        return {key: _scale_conditioning(value, scale, weights) for key, value in structure.items()}
    return structure


def _refocus(conditioning, scale, weights):
    return _scale_conditioning(conditioning, scale, weights=_parse_floats(weights) if weights else None)


def _project_dissim_per_band(cond_bands, ref_bands, n_bands, strength, per_band_strengths, sign):
    batch = cond_bands.shape[0]
    cond_mean = cond_bands.float().mean(dim=1)
    ref_mean = ref_bands.float().mean(dim=1)
    ref_mean = _match_batch(ref_mean, batch)
    direction = _unit_norm_dim(cond_mean - ref_mean)

    if per_band_strengths is None:
        gains = [strength] * n_bands
    else:
        gains = list(per_band_strengths)
        if len(gains) < n_bands:
            gains = gains + [strength] * (n_bands - len(gains))
        elif len(gains) > n_bands:
            gains = gains[:n_bands]

    gains_t = torch.tensor(gains, dtype=cond_bands.float().dtype, device=cond_bands.device).view(1, 1, n_bands, 1)
    cond_f = cond_bands.float()
    dir_exp = direction.unsqueeze(1)
    proj = (cond_f * dir_exp).sum(dim=-1, keepdim=True)
    output = cond_f + sign * gains_t * proj * dir_exp
    return _merge_bands(output.to(cond_bands.dtype))


def _project_dissim_whole(cond_t, ref_t, strength, sign):
    batch = cond_t.shape[0]
    cond_mean = cond_t.float().mean(dim=1, keepdim=True)
    ref_mean = ref_t.float().mean(dim=1, keepdim=True)
    ref_mean = _match_batch(ref_mean, batch)
    direction = _unit_norm_dim(cond_mean - ref_mean)
    proj = (cond_t.float() * direction).sum(dim=-1, keepdim=True)
    output = cond_t.float() + sign * strength * proj * direction
    return output.to(cond_t.dtype)


def _apply_dissim(cond_t, ref_t, strength, per_band_strengths, n_bands=12):
    cond_bands, band_dim = _split_bands(cond_t, n_bands)
    ref_bands, ref_band_dim = _split_bands(ref_t, n_bands)
    if cond_bands is not None and ref_bands is not None and band_dim == ref_band_dim:
        return _project_dissim_per_band(cond_bands, ref_bands, n_bands, strength, per_band_strengths, sign=1)
    return _project_dissim_whole(cond_t, ref_t, strength, sign=1)


def _dissim_guidance_conditioning(structure, ref_structure, strength, per_band_strengths=None):
    if isinstance(structure, list):
        output = []
        ref_iter = iter(ref_structure) if isinstance(ref_structure, list) else None
        for item in structure:
            ref_item = next(ref_iter, None) if ref_iter is not None else None
            if (
                isinstance(item, (list, tuple))
                and len(item) == 2
                and isinstance(item[0], torch.Tensor)
                and isinstance(item[1], dict)
            ):
                cond_t, extras = item
                ref_t = _extract_cond_tensor(ref_item) if ref_item is not None else None
                new_cond = _apply_dissim(cond_t, ref_t, strength, per_band_strengths) if ref_t is not None else cond_t
                output.append([new_cond, dict(extras)])
            else:
                output.append(_dissim_guidance_conditioning(item, ref_item, strength, per_band_strengths))
        return output
    if isinstance(structure, torch.Tensor):
        ref_t = _extract_cond_tensor(ref_structure) if ref_structure is not None else None
        return _apply_dissim(structure, ref_t, strength, per_band_strengths) if ref_t is not None else structure
    return structure


def _guidance(conditioning, reference, strength):
    return _dissim_guidance_conditioning(conditioning, reference, strength, per_band_strengths=None)


def _conditioning_set_values(conditioning, values):
    output = []
    for item in conditioning:
        cond_t, extras = item
        new_extras = dict(extras)
        new_extras.update(values)
        output.append([cond_t, new_extras])
    return output


class GJJ_Krea2EditRebalance:
    DESCRIPTION = "零外部节点依赖复刻 Krea 2 Image Edit Rebalance：编码 Krea2 图像编辑提示词并重平衡多模态 CONDITIONING。"
    CATEGORY = "GJJ/conditioning/krea"
    FUNCTION = "main"
    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("conditioning",)
    OUTPUT_TOOLTIPS = ("重平衡后的 Krea2 图像编辑 CONDITIONING。",)

    GJJ_HELP = {
        "说明": "连接 Krea2/支持视觉 token 的 CLIP，输入编辑文本，可选单张或批量参考图；节点会把批量图拆成多张独立参考图，并在同一次编码里融合。",
        "分段模式": "开启后，前段使用纯文本条件，后段使用带图像条件；未连接图片时只输出纯文本条件。",
        "高级": "点击节点内【高级】按钮后显示 Krea2EditRebalanceC 的正向/反向重平衡参数；默认隐藏且不改变简化版行为。",
        "零依赖": "不依赖原 ComfyUI-Conditioning-Rebalance 扩展，不新增 requirements。",
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "dynamicPrompts": True,
                    "display_name": "编辑提示词",
                    "tooltip": "填写要对参考图进行的编辑指令。节点会自动加上 Krea2 编辑模板前缀。",
                }),
                "clip": ("CLIP", {
                    "display_name": "CLIP 编码器",
                    "tooltip": "连接 Krea2/支持视觉 token 的 CLIP 输出，用于编码文本和可选参考图。",
                }),
                "refocus_strength": ("FLOAT", {
                    "default": 0.80,
                    "min": 0.0,
                    "max": 1000.0,
                    "step": 0.01,
                    "display_name": "重聚焦强度",
                    "tooltip": "简化模式下的整体重平衡倍率。数值越高，对 Krea2 多层条件的放大越明显。",
                }),
                "guidance_strength": ("FLOAT", {
                    "default": 0.500,
                    "min": 0.0,
                    "max": 2.0,
                    "step": 0.01,
                    "display_name": "差异引导强度",
                    "tooltip": "控制主条件相对参考条件的差异方向增强力度；高级模式同样使用此参数。",
                }),
                "enable_split": ("BOOLEAN", {
                    "default": True,
                    "display_name": "启用分段条件",
                    "tooltip": "开启后前段使用纯文本条件，后段使用图文条件；适合 Krea2 图像编辑流程。",
                }),
            },
            "optional": {
                "image": (IMAGE_INPUT_TYPE, {
                    "display_name": "参考图 / 批量参考图",
                    "tooltip": "可选。支持 IMAGE 与 GJJ_BATCH_IMAGE；批量图片会递归拆成单张参考图，并在同一次 Krea2 编码中融合，不会拆成多个任务。",
                }),
                "image_tokens": (["low", "normal", "high", "max"], {
                    "default": "normal",
                    "display_name": "参考图精度",
                    "tooltip": "控制每张参考图的视觉 token 预算：low 更省显存，max 保留更多细节。批量输入时每张图使用同一档位。",
                }),
                "advanced_enabled": ("BOOLEAN", {
                    "default": False,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "启用高级",
                    "tooltip": "由节点内【高级】按钮自动控制。开启后使用 Krea2EditRebalanceC 的正向/反向层权重算法。",
                }),
                "positive_strength": ("FLOAT", {
                    "default": 1.00,
                    "min": 0.0,
                    "max": 1000.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "正向强度",
                    "tooltip": "高级模式下正向条件的整体倍率，对应 Krea2EditRebalanceC 的 positive_strength。",
                }),
                "negative_strength": ("FLOAT", {
                    "default": 1.00,
                    "min": 0.0,
                    "max": 1000.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "反向强度",
                    "tooltip": "高级模式下参考/反向条件的整体倍率，对应 Krea2EditRebalanceC 的 negative_strength。",
                }),
                "positive_layers": ("STRING", {
                    "default": "1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0",
                    "multiline": False,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "正向层权重",
                    "tooltip": "高级模式下 12 个 Krea2/Qwen-VL 条件层的正向权重，用英文逗号或分号分隔。",
                }),
                "negative_layers": ("STRING", {
                    "default": "1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0",
                    "multiline": False,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "反向层权重",
                    "tooltip": "高级模式下 12 个 Krea2/Qwen-VL 条件层的参考/反向权重，用英文逗号或分号分隔。",
                }),
                "enable_step": ("FLOAT", {
                    "default": 0.000,
                    "min": 0.000,
                    "max": 1.000,
                    "step": 0.001,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "高级分段起点",
                    "tooltip": "高级模式下图文条件开始生效的时间点。0 表示从采样开始使用图文条件，1 表示只使用纯文本段。",
                }),
            },
        }

    @staticmethod
    def _process_cond(conditioning, refocus_strength=1.00, guidance_strength=0.500):
        cond_ref = _refocus(
            conditioning,
            refocus_strength,
            "1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0",
        )
        cond_main = _refocus(
            conditioning,
            refocus_strength,
            "0.0,1.0,0.0,0.0,0.0,0.0,0.0,1.0,9.0,1.0,1.0,1.0",
        )
        return _guidance(cond_main, cond_ref, guidance_strength)

    @staticmethod
    def _process_cond_advanced(
        conditioning,
        positive_strength,
        negative_strength,
        positive_layers,
        negative_layers,
        guidance_strength,
    ):
        cond_negative = _refocus(conditioning, negative_strength, negative_layers)
        cond_positive = _refocus(conditioning, positive_strength, positive_layers)
        return _guidance(cond_positive, cond_negative, guidance_strength)

    def _process_selected(
        self,
        conditioning,
        advanced_enabled,
        refocus_strength,
        guidance_strength,
        positive_strength,
        negative_strength,
        positive_layers,
        negative_layers,
    ):
        if advanced_enabled:
            return self._process_cond_advanced(
                conditioning,
                positive_strength,
                negative_strength,
                positive_layers,
                negative_layers,
                guidance_strength,
            )
        return self._process_cond(conditioning, refocus_strength, guidance_strength)

    def main(
        self,
        text,
        clip,
        refocus_strength=0.80,
        guidance_strength=0.500,
        enable_split=True,
        image=None,
        image_tokens="normal",
        advanced_enabled=False,
        positive_strength=1.00,
        negative_strength=1.00,
        positive_layers="1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0",
        negative_layers="1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0",
        enable_step=0.000,
    ):
        prompt = "(Subject:2) {}".format(text)
        image_frames = _image_frames(image, "参考图")
        has_image = bool(image_frames)
        advanced_enabled = bool(advanced_enabled)
        split_point = float(enable_step) if advanced_enabled else 0.175
        split_point = max(0.0, min(1.0, split_point))

        if enable_split:
            cond_text = _compile_edit(clip, prompt, None)
            cond_text = self._process_selected(
                cond_text,
                advanced_enabled,
                refocus_strength,
                guidance_strength,
                positive_strength,
                negative_strength,
                positive_layers,
                negative_layers,
            )
            cond_text = _conditioning_set_values(cond_text, {"start_percent": 0.000, "end_percent": split_point})

            if has_image:
                cond_image = _compile_edit(clip, prompt, [(frame, image_tokens) for frame in image_frames])
                cond_image = self._process_selected(
                    cond_image,
                    advanced_enabled,
                    refocus_strength,
                    guidance_strength,
                    positive_strength,
                    negative_strength,
                    positive_layers,
                    negative_layers,
                )
                cond_image = _conditioning_set_values(cond_image, {"start_percent": split_point, "end_percent": 1.000})
                final = cond_image + cond_text
            else:
                final = cond_text
        else:
            final = _compile_edit(clip, prompt, [(frame, image_tokens) for frame in image_frames] if has_image else None)
            final = self._process_selected(
                final,
                advanced_enabled,
                refocus_strength,
                guidance_strength,
                positive_strength,
                negative_strength,
                positive_layers,
                negative_layers,
            )
            final = _conditioning_set_values(final, {"start_percent": 0.000, "end_percent": 1.000})

        return (final,)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_Krea2EditRebalance,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "GJJ · Krea2图像编辑重平衡",
}
