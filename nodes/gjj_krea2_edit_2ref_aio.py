from typing import Any

import torch
import torch.nn.functional as F
from einops import rearrange

import comfy.ldm.common_dit
import comfy.model_management
import comfy.patcher_extension
import comfy.sd
import comfy.utils
import folder_paths
from comfy.ldm.flux.layers import timestep_embedding

from .common_utils import build_node_help_payload, make_model_tree_item


NODE_NAME = "GJJ_Krea2Edit2RefAIO"
NODE_DISPLAY_NAME = "GJJ · Krea2 双参考编辑单节点"
WRAPPER_KEY = "gjj_krea2_edit_2ref"
IMAGE_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
DEFAULT_LORA_NAME = "Krea-2/krea2_identity_edit_v1_1.safetensors"
DEFAULT_LORA_KEYWORDS = ("krea2", "identity", "edit")
RESIZE_CHOICES = ["缩短边", "长边", "宽度", "高度", "不缩放"]
UPSCALE_CHOICES = ["最近邻精确", "区域", "双线性", "双三次", "兰索斯"]
RESIZE_VALUE_MAP = {
    "缩短边": "shorter",
    "scale shorter dimension": "shorter",
    "长边": "longer",
    "scale longer dimension": "longer",
    "宽度": "width",
    "height": "height",
    "高度": "height",
    "width": "width",
    "不缩放": "disabled",
    "disabled": "disabled",
}
UPSCALE_VALUE_MAP = {
    "最近邻精确": "nearest-exact",
    "区域": "area",
    "双线性": "bilinear",
    "双三次": "bicubic",
    "兰索斯": "lanczos",
    "nearest-exact": "nearest-exact",
    "area": "area",
    "bilinear": "bilinear",
    "bicubic": "bicubic",
    "lanczos": "lanczos",
}


MODEL_TREE = [
    make_model_tree_item(
        label="Krea2 identity edit LoRA",
        folder="loras/Krea-2",
        filename="krea2_identity_edit_v1_1.safetensors",
        kind="lora",
        icon="🟣",
        type="LORA",
        input="lora_name",
        description="双参考 Krea2 编辑默认 LoRA；放在 ComfyUI/models/loras/Krea-2/krea2_identity_edit_v1_1.safetensors。",
    )
]


def _list_loras():
    try:
        return [str(item) for item in folder_paths.get_filename_list("loras")]
    except Exception:
        return []


def _normalize_name(value):
    return str(value or "").replace("\\", "/").lower()


def _pick_default_lora(loras):
    if not loras:
        return DEFAULT_LORA_NAME
    target = _normalize_name(DEFAULT_LORA_NAME)
    for item in loras:
        if _normalize_name(item) == target:
            return item
    scored = []
    for index, item in enumerate(loras):
        key = _normalize_name(item)
        score = sum(1 for token in DEFAULT_LORA_KEYWORDS if token in key)
        if score:
            scored.append((score, -index, item))
    if scored:
        scored.sort(reverse=True)
        return scored[0][2]
    return loras[0]


def _imgids(bs, frame, h_, w_, device):
    ids = torch.zeros(h_, w_, 3, device=device, dtype=torch.float32)
    ids[..., 0] = frame
    ids[..., 1] = torch.arange(h_, device=device, dtype=torch.float32)[:, None]
    ids[..., 2] = torch.arange(w_, device=device, dtype=torch.float32)[None, :]
    return ids.reshape(1, h_ * w_, 3).repeat(bs, 1, 1)


def _to_4d(value):
    if value.ndim == 5:
        b, c, t, h, w = value.shape
        return value.reshape(b * t, c, h, w)
    return value


def _krea2_edit_forward(model, x, timesteps, context, source_latent, transformer_options):
    patch = model.patch
    temporal = x.ndim == 5
    if temporal:
        b5, _c5, t5, _h5, _w5 = x.shape
    x = _to_4d(x)
    bs, _c, height_orig, width_orig = x.shape

    x = comfy.ldm.common_dit.pad_to_patch_size(x, (patch, patch))
    height, width = x.shape[-2], x.shape[-1]
    h_tokens, w_tokens = height // patch, width // patch

    source_list = source_latent if isinstance(source_latent, (list, tuple)) else [source_latent]
    source_images = []
    for item in source_list:
        source = _to_4d(item).to(x.device, x.dtype)
        if source.shape[0] != bs:
            source = source[:1].expand(bs, *source.shape[1:])
        if source.shape[-2:] != (height, width):
            source = F.interpolate(source.float(), size=(height, width), mode="bilinear").to(x.dtype)
        source = comfy.ldm.common_dit.pad_to_patch_size(source, (patch, patch))
        source_images.append(
            model.first(rearrange(source, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=patch, pw=patch))
        )

    context = model._unpack_context(context)
    target_img = model.first(rearrange(x, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=patch, pw=patch))

    t = model.tmlp(timestep_embedding(timesteps, model.tdim).unsqueeze(1).to(target_img.dtype))
    tvec = model.tproj(t)
    context = model.txtfusion(context, mask=None, transformer_options=transformer_options)
    context = model.txtmlp(context)

    text_len = context.shape[1]
    target_len = target_img.shape[1]
    source_len = sum(item.shape[1] for item in source_images)
    combined = torch.cat([context] + source_images + [target_img], dim=1)

    device = combined.device
    pos = torch.cat(
        [torch.zeros(bs, text_len, 3, device=device, dtype=torch.float32)]
        + [_imgids(bs, index + 1, h_tokens, w_tokens, device) for index in range(len(source_images))]
        + [_imgids(bs, 0, h_tokens, w_tokens, device)],
        dim=1,
    )
    freqs = model.pe_embedder(pos)

    for block in model.blocks:
        combined = block(combined, tvec, freqs, None, transformer_options=transformer_options)

    final = model.last(combined, t)
    output = final[:, text_len + source_len : text_len + source_len + target_len, :]
    output = rearrange(
        output,
        "b (h w) (c ph pw) -> b c (h ph) (w pw)",
        h=h_tokens,
        w=w_tokens,
        ph=patch,
        pw=patch,
        c=model.channels,
    )
    output = output[:, :, :height_orig, :width_orig]
    if temporal:
        output = output.reshape(b5, t5, model.channels, height_orig, width_orig).movedim(1, 2)
    return output


def _normalize_image(image, label):
    if image.ndim != 4:
        raise RuntimeError(f"{label} 必须是 IMAGE 张量 [B,H,W,C]，当前形状为 {tuple(image.shape)}。")
    if image.shape[-1] == 1:
        image = image.repeat(1, 1, 1, 3)
    elif image.shape[-1] >= 3:
        image = image[..., :3]
    else:
        raise RuntimeError(f"{label} 图像通道数无效：{tuple(image.shape)}。")
    return image.float().clamp(0.0, 1.0).contiguous()


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
    return _normalize_image(tensor, label)


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


def _image_frames(value: Any, label: str) -> list[torch.Tensor]:
    if value is None:
        return []
    if isinstance(value, torch.Tensor):
        tensor = _normalize_image_batch(value, label)
        return [tensor[index : index + 1].contiguous() for index in range(int(tensor.shape[0]))]
    frames = []
    for item in _iter_nested_image_values(value):
        frames.extend(_image_frames(item, label))
    return frames


def _resize_image(image, resize_type, size, upscale_method):
    resize_type = RESIZE_VALUE_MAP.get(str(resize_type), str(resize_type))
    upscale_method = UPSCALE_VALUE_MAP.get(str(upscale_method), str(upscale_method))
    if resize_type == "disabled":
        return image

    batch, height, width, _channels = image.shape
    size = max(64, int(round(float(size) / 8.0)) * 8)
    if resize_type == "shorter":
        scale = size / max(1, min(height, width))
    elif resize_type == "longer":
        scale = size / max(1, max(height, width))
    elif resize_type == "width":
        scale = size / max(1, width)
    elif resize_type == "height":
        scale = size / max(1, height)
    else:
        raise RuntimeError(f"未知缩放模式：{resize_type}")

    new_width = max(1, round(width * scale))
    new_height = max(1, round(height * scale))
    if new_width == width and new_height == height:
        return image
    samples = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(samples, new_width, new_height, upscale_method, "disabled")
    return resized.movedim(1, -1).clamp(0.0, 1.0).reshape(batch, new_height, new_width, 3)


def _encode_image(vae, image):
    samples = vae.encode(image[:, :, :, :3])
    output = {"samples": samples}
    if hasattr(vae, "spacial_compression_encode"):
        output["downscale_ratio_spacial"] = vae.spacial_compression_encode()
    return output


def _encode_frame_latents(vae, frames):
    return [_encode_image(vae, frame) for frame in frames]


def _make_empty_sd3_latent(width, height, batch_size, vae):
    compression = vae.spacial_compression_encode() if hasattr(vae, "spacial_compression_encode") else 8
    latent_channels = getattr(vae, "latent_channels", None)
    if latent_channels is None:
        latent_channels = getattr(getattr(vae, "first_stage_model", None), "latent_channels", 16)
    latent = torch.zeros(
        [int(batch_size), int(latent_channels), max(1, int(height) // compression), max(1, int(width) // compression)],
        device=comfy.model_management.intermediate_device(),
    )
    return {"samples": latent}


def _prep_grounding_image(image, grounding_px):
    samples = image.movedim(-1, 1)
    height, width = samples.shape[2], samples.shape[3]
    if grounding_px and max(height, width) > grounding_px:
        scale = grounding_px / max(height, width)
        samples = comfy.utils.common_upscale(samples, round(width * scale), round(height * scale), "area", "disabled")
    return samples.movedim(1, -1)[:, :, :, :3]


def _grounding_template(image_count):
    template = (
        "<|im_start|>system\nDescribe the image by detailing the color, shape, size, "
        "texture, quantity, text, spatial relationships of the objects and background:"
        "<|im_end|>\n<|im_start|>user\n<|vision_start|><|image_pad|><|vision_end|>"
        "{}<|im_end|>\n<|im_start|>assistant\n"
    )
    if int(image_count) <= 1:
        return template
    image_tokens = "<|vision_start|><|image_pad|><|vision_end|>" * int(image_count)
    return (
        "<|im_start|>system\nDescribe the image by detailing the color, shape, size, "
        "texture, quantity, text, spatial relationships of the objects and background:"
        f"<|im_end|>\n<|im_start|>user\n{image_tokens}"
        "{}<|im_end|>\n<|im_start|>assistant\n"
    )


def _encode_grounded(clip, prompt, images, grounding_px):
    if not images:
        tokens = clip.tokenize(prompt)
        return clip.encode_from_tokens_scheduled(tokens)
    images = [_prep_grounding_image(image, int(grounding_px)) for image in images]
    selected_template = _grounding_template(len(images))
    tokens = clip.tokenize(prompt, images=images, llama_template=selected_template)
    return clip.encode_from_tokens_scheduled(tokens)


class GJJ_Krea2Edit2RefAIO:
    CATEGORY = "GJJ/图像编辑/Krea2"
    FUNCTION = "generate"
    DESCRIPTION = "把 Krea2 单图/双参考编辑中的缩放、VAE 编码、identity edit LoRA、source patch、正负 grounded encode 和采样 latent 合并为零第三方节点依赖的 GJJ 单节点。"
    RETURN_TYPES = ("MODEL", "CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("模型", "正向条件", "负向条件", "采样Latent")
    OUTPUT_TOOLTIPS = (
        "已加载 identity edit LoRA 并安装 source patch 的 Krea2 模型。",
        "用主图/参考图和提示词编码得到的正向条件。",
        "用主图/参考图和负向提示词编码得到的负向条件。",
        "按缩放后主图尺寸创建的 SD3/Krea2 采样 latent。",
    )
    SEARCH_ALIASES = ["Krea2 Edit 2 Ref", "Krea2 identity edit", "Krea2双参考", "Krea2编辑单节点"]
    GJJ_HELP = build_node_help_payload(
        description=DESCRIPTION,
        dependencies=[
            {
                "name": "ComfyUI 内置 torch/comfy/folder_paths",
                "type": "内置运行环境",
                "required": True,
                "description": "不依赖 comfyui-krea2edit、ResizeImageMaskNode、GetImageSize 或 LoraLoaderModelOnly 节点。",
            }
        ],
        model_tree=MODEL_TREE,
        usage=[
            "接入 GJJ_ModelBundleLoader 的 model/clip/vae，输入主图即可做单图编辑；可选接入第二参考图作为双参考编辑。",
            "主图和第二参考图都支持 GJJ_BATCH_IMAGE,IMAGE；如果传入 GJJ_BATCH_IMAGE 或嵌套批量对象，会递归拆成单图作为多参考。",
            "默认复刻工作流：主图缩短边 1024、nearest-exact、identity edit LoRA 强度 1、grounding_px 768。",
            "输出模型接采样器 model，正/负条件接采样器 positive/negative，采样Latent 接 latent_image。",
            "主图会先缩放再用于第一路 VAE、grounded encode 和采样 latent 尺寸；第二参考图默认只用于 source_latent_b，和截图工作流一致。",
            "如需让第二参考图也进入 Qwen3-VL 视觉文本编码，可打开“第二参考参与文本编码”。",
        ],
        notice="这是本地移植版 Krea2 Edit source patch，不需要安装原 comfyui-krea2edit 扩展。",
        extra={"title": NODE_DISPLAY_NAME, "default_model": DEFAULT_LORA_NAME, "model_keywords": list(DEFAULT_LORA_KEYWORDS)},
    )

    def __init__(self):
        self.loaded_lora = None

    @classmethod
    def INPUT_TYPES(cls):
        loras = _list_loras()
        choices = loras or [DEFAULT_LORA_NAME]
        default_lora = _pick_default_lora(loras)
        return {
            "required": {
                "model": ("MODEL", {"display_name": "模型"}),
                "clip": ("CLIP", {"display_name": "CLIP"}),
                "vae": ("VAE", {"display_name": "VAE"}),
                "image": (IMAGE_INPUT_TYPE, {"display_name": "主图 / 场景图"}),
                "prompt": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "display_name": "正向提示词"}),
                "negative_prompt": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "display_name": "负向提示词"}),
                "lora_name": (choices, {"default": default_lora, "display_name": "Identity Edit LoRA"}),
                "lora_strength": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01, "display_name": "LoRA强度"}),
                "resize_type": (RESIZE_CHOICES, {"default": "缩短边", "display_name": "主图缩放"}),
                "resize_size": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 8, "display_name": "缩放尺寸"}),
                "scale_method": (UPSCALE_CHOICES, {"default": "最近邻精确", "display_name": "缩放算法"}),
                "grounding_px": ("INT", {"default": 768, "min": 0, "max": 4096, "step": 64, "display_name": "视觉编码最长边"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096, "step": 1, "display_name": "采样批量"}),
                "ground_image_b": ("BOOLEAN", {"default": False, "display_name": "第二参考参与文本编码"}),
            },
            "optional": {
                "image_b": (IMAGE_INPUT_TYPE, {"display_name": "第二参考图 / 主体图"}),
            }
        }

    def _load_lora(self, lora_name):
        lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
        if self.loaded_lora is not None and self.loaded_lora[0] == lora_path:
            return self.loaded_lora[1]
        lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
        self.loaded_lora = (lora_path, lora)
        return lora

    def _apply_lora(self, model, lora_name, strength):
        if float(strength) == 0.0:
            return model
        if not str(lora_name or "").strip():
            raise RuntimeError("没有可用的 Krea2 identity edit LoRA。请把模型放到 models/loras 后刷新或重启 ComfyUI。")
        lora = self._load_lora(lora_name)
        patched_model, _patched_clip = comfy.sd.load_lora_for_models(model, None, lora, float(strength), 0.0)
        return patched_model

    def _patch_source(self, model, source_latents):
        if model.get_attachment(WRAPPER_KEY) is not None:
            raise RuntimeError("这个模型已经加载过 GJJ Krea2 编辑 patch。请确保同一路径只使用一个该节点。")
        if not source_latents:
            raise RuntimeError("至少需要一张主图作为 Krea2 编辑参考。")
        patched = model.clone()
        src_samples = [patched.model.process_latent_in(item["samples"]) for item in source_latents]
        if len(src_samples) == 1:
            src_samples = src_samples[0]

        def wrapper(executor, x, timesteps, context, attention_mask=None, transformer_options={}, **kwargs):
            diffusion_model = executor.class_obj
            return _krea2_edit_forward(diffusion_model, x, timesteps, context, src_samples, transformer_options)

        transformer_options = patched.model_options.setdefault("transformer_options", {})
        comfy.patcher_extension.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
            WRAPPER_KEY,
            wrapper,
            transformer_options,
        )
        patched.set_attachments(WRAPPER_KEY, {"sources": len(source_latents)})
        return patched

    def generate(
        self,
        model,
        clip,
        vae,
        image,
        prompt,
        negative_prompt,
        lora_name,
        lora_strength,
        resize_type,
        resize_size,
        scale_method,
        grounding_px,
        batch_size,
        ground_image_b,
        image_b=None,
    ):
        image_frames = _image_frames(image, "主图")
        if not image_frames:
            raise RuntimeError("主图输入为空。请接入 IMAGE 或 GJJ_BATCH_IMAGE。")
        image_b_frames = _image_frames(image_b, "第二参考图")
        resized_frames = [_resize_image(frame, resize_type, resize_size, scale_method) for frame in image_frames]
        source_latents = _encode_frame_latents(vae, resized_frames)
        source_latents.extend(_encode_frame_latents(vae, image_b_frames))
        width = int(resized_frames[0].shape[2])
        height = int(resized_frames[0].shape[1])
        latent_image = _make_empty_sd3_latent(width, height, batch_size, vae)

        lora_model = self._apply_lora(model, lora_name, lora_strength)
        patched_model = self._patch_source(lora_model, source_latents)
        grounded_images = list(resized_frames)
        if ground_image_b:
            grounded_images.extend(image_b_frames)
        positive = _encode_grounded(clip, prompt, grounded_images, grounding_px)
        negative = _encode_grounded(clip, negative_prompt, grounded_images, grounding_px)
        return patched_model, positive, negative, latent_image


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Krea2Edit2RefAIO}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
