from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from .batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .character_multiview_studio import DEFAULT_NEGATIVE_PROMPT, DEFAULT_SEED, _make_squareish_collage, _send_status
from .lazy_Image_studio import (
    DEFAULT_CLIP_NAME,
    DEFAULT_UNET_DTYPE,
    DEFAULT_UNET_NAME,
    DEFAULT_VAE_NAME,
    GJJ_LazyImageStudio,
    _apply_cfg_norm,
    _patch_model_sampling,
    _pick_available_name,
    _resolve_effective_steps,
    _safe_filename_list,
    list_clip_models,
    list_unet_models,
    list_vae_models,
    match_model_family,
    resolve_clip_names_for_preset,
    resolve_clip_type,
)


NODE_NAME = "GJJ_LoraFaceMaterialGenerator"
MATERIAL_TEMPLATE_OPTIONS = ("训练二十图", "训练三十图", "自定义")
DEFAULT_CAPTION_BASE_TAGS = ("solo", "photo")

MODEL_PRESETS: Dict[str, Dict[str, Any]] = {
    "SD1.5": {"size": (512, 512), "count": 20},
    "SDXL": {"size": (1024, 1024), "count": 20},
    "Qwen": {"size": (1344, 1344), "count": 20},
    "Flux": {"size": (1024, 1024), "count": 20},
    "自定义": {"size": (1024, 1024), "count": 20},
}

TRAINING_20_LINES = [
    "半身构图，现代休闲服，室内自然光，平静表情，训练素材。",
    "半身构图，现代休闲服，窗边柔光，轻微微笑，训练素材。",
    "半身构图，简洁深色上衣，白墙背景，认真表情，训练素材。",
    "半身构图，浅色外套，书店背景，平静表情，训练素材。",
    "半身构图，连帽外套，咖啡馆背景，轻微微笑，训练素材。",
    "半身构图，校服风格，教室背景，自然表情，训练素材。",
    "全身构图，休闲外套，城市街景背景，平静站姿，训练素材。",
    "全身构图，运动风服装，公园草地背景，平静站姿，训练素材。",
    "全身构图，简洁卫衣，室外树荫背景，轻微微笑，训练素材。",
    "全身构图，夹克外套，现代室内背景，认真站姿，训练素材。",
    "全身构图，白色上衣，简洁纯色背景，平静站姿，训练素材。",
    "全身构图，深色外套，走廊背景，平静站姿，训练素材。",
    "近景肖像构图，现代日常服装，柔和棚拍光，平静表情，训练素材。",
    "近景肖像构图，现代日常服装，自然窗光，轻微微笑，训练素材。",
    "近景肖像构图，现代日常服装，室外阴天光线，认真表情，训练素材。",
    "近景肖像构图，现代休闲服，暖色室内灯光，轻微微笑，训练素材。",
    "半身构图，不同服装搭配，户外自然光，平静表情，训练素材。",
    "半身构图，不同服装搭配，城市背景，轻微微笑，训练素材。",
    "全身构图，不同服装搭配，简洁背景，平静站姿，训练素材。",
    "近景肖像构图，不同服装搭配，干净背景，轻微微笑，训练素材。",
]

TRAINING_30_LINES = TRAINING_20_LINES + [
    "半身构图，牛仔外套，窗边逆光，平静表情，训练素材。",
    "半身构图，针织上衣，客厅背景，轻微微笑，训练素材。",
    "半身构图，宽松卫衣，楼梯背景，自然表情，训练素材。",
    "全身构图，白色球鞋与休闲裤，户外步道背景，平静站姿，训练素材。",
    "全身构图，背包造型，校园背景，平静站姿，训练素材。",
    "全身构图，夹克与长裤，城市广场背景，轻微微笑，训练素材。",
    "近景肖像构图，侧窗光，平静表情，训练素材。",
    "近景肖像构图，柔和暖光，认真表情，训练素材。",
    "近景肖像构图，干净浅背景，轻微笑意，训练素材。",
    "半身构图，简洁衬衫，不同室内背景，平静表情，训练素材。",
]

def _flatten_slot_images(value: torch.Tensor | None) -> List[torch.Tensor]:
    if value is None or not isinstance(value, torch.Tensor):
        return []
    if value.ndim == 3:
        value = value.unsqueeze(0)
    if value.ndim != 4:
        return []
    return [value[i : i + 1].detach().float() for i in range(value.shape[0])]


def _safe_int(value: Any, default: int) -> int:
    try:
        if isinstance(value, str) and any(token in value.lower() for token in (".safetensors", ".ckpt", "\\", "/")):
            return int(default)
        return int(value)
    except Exception:
        return int(default)


def _normalize_choice(value: Any, allowed: Tuple[str, ...] | List[str], default: str) -> str:
    text = str(value or "").strip()
    return text if text in allowed else default


def _safe_unet_models() -> List[str]:
    models = list_unet_models() or [DEFAULT_UNET_NAME]
    filtered = []
    for model_name in models:
        preset = match_model_family(model_name)
        if preset.get("supports_multi_image_edit"):
            filtered.append(model_name)
    return filtered or models


def _default_unet_name(unet_models: List[str]) -> str:
    for model_name in unet_models:
        if "qwen_image_edit_2511" in str(model_name).lower():
            return model_name
    return unet_models[0]


def _resolve_size(model_preset: str, custom_width: int, custom_height: int) -> Tuple[int, int]:
    if model_preset == "自定义":
        return max(64, _safe_int(custom_width, 1024)), max(64, _safe_int(custom_height, 1024))
    preset = MODEL_PRESETS.get(model_preset, MODEL_PRESETS["Qwen"])
    size = preset.get("size", (1024, 1024))
    return int(size[0]), int(size[1])


def _template_lines(template_name: str, custom_text: str) -> List[str]:
    lines = [line.strip() for line in str(custom_text or "").replace("\r\n", "\n").split("\n") if line.strip()]
    if template_name == "训练三十图":
        return lines or list(TRAINING_30_LINES)
    if template_name == "自定义":
        return lines or list(TRAINING_20_LINES)
    return lines or list(TRAINING_20_LINES)


def _minimum_material_count(template_name: str, model_preset: str) -> int:
    template_count = 30 if template_name == "训练三十图" else 20
    preset = MODEL_PRESETS.get(model_preset, MODEL_PRESETS["Qwen"])
    return max(template_count, int(preset.get("count", 20)))


def _expand_to_material_count(lines: List[str], minimum_count: int) -> List[str]:
    clean_lines = [str(line).strip() for line in lines if str(line or "").strip()]
    if not clean_lines:
        clean_lines = list(TRAINING_20_LINES)
    if len(clean_lines) >= minimum_count:
        return clean_lines[:minimum_count]

    expanded: List[str] = []
    cycle_index = 0
    while len(expanded) < minimum_count:
        base_line = clean_lines[cycle_index % len(clean_lines)]
        variant_round = cycle_index // len(clean_lines)
        if variant_round == 0:
            expanded.append(base_line)
        else:
            expanded.append(f"{base_line} 与前面素材保持同一人物，但换不同服装、不同背景、不同光线和轻微不同表情。")
        cycle_index += 1
    return expanded


def _compose_training_prompt(base_prompt: str, action_text: str) -> str:
    parts = [
        "Keep Picture 1 as the only identity reference.",
        "Preserve the same person, the same hairstyle, the same face angle, the same head direction, the same face shape, the same jawline, the same cheek structure, the same eye shape, the same nose, the same mouth, the same skin tone, and the same apparent age.",
        "Do not change age, do not change face shape, do not masculinize or feminize the face, and do not alter the child's facial proportions.",
        "Generate exactly one person only.",
        "Do not copy the original crop. Rebuild the composition as requested below.",
        "Vary clothing, background, lighting, and subtle facial expression while keeping the same person.",
        "No second person, no duplicate person, no collage, no tiled faces, no split screen.",
        str(base_prompt or "").strip(),
        str(action_text or "").strip(),
    ]
    return "\n".join(part for part in parts if part)


def _compose_negative_prompt(negative_prompt: str) -> str:
    extra_negative = (
        "multiple people, two people, group photo, crowd, duplicate person, clone, twin, "
        "extra face, extra head, extra body, merged body, cropped head, cut off feet, cut off hands, "
        "contact sheet, photo grid, collage, tiled faces, many faces, repeated face, split screen, watermark, text"
    )
    base = str(negative_prompt or "").strip() or DEFAULT_NEGATIVE_PROMPT
    return f"{base}, {extra_negative}" if base else extra_negative


def _normalize_caption_tag(text: str) -> str:
    value = str(text or "").strip()
    value = re.sub(r"[\r\n\t]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip(" ,，")
    return value


def _append_tag(target: List[str], tag: str) -> None:
    clean = str(tag or "").strip().strip(" ,")
    if clean and clean not in target:
        target.append(clean)


def _caption_tags_from_action(action_text: str) -> List[str]:
    text = str(action_text or "").strip()
    lowered = text.lower()
    tags: List[str] = []

    if any(token in text for token in ("特写", "肖像", "头像", "近景")):
        _append_tag(tags, "close-up portrait")
    elif "半身" in text:
        _append_tag(tags, "upper body")
    elif "全身" in text:
        _append_tag(tags, "full body")

    if "正面右45" in text or "front-right" in lowered:
        _append_tag(tags, "front-right three quarter view")
    elif "正面左45" in text or "front-left" in lowered:
        _append_tag(tags, "front-left three quarter view")
    elif "左侧" in text or "left side" in lowered:
        _append_tag(tags, "left side view")
    elif "右侧" in text or "right side" in lowered:
        _append_tag(tags, "right side view")
    elif "后视" in text or "back view" in lowered:
        _append_tag(tags, "back view")
    elif "正面" in text or "正视" in text or "front view" in lowered:
        _append_tag(tags, "front view")

    if "微笑" in text:
        _append_tag(tags, "slight smile")
    elif "认真" in text:
        _append_tag(tags, "serious expression")
    elif "平静" in text or "自然表情" in text:
        _append_tag(tags, "neutral expression")

    if any(token in text for token in ("白色背景", "纯色背景", "干净背景", "简洁背景")):
        _append_tag(tags, "plain background")
    elif any(token in text for token in ("室内", "客厅", "教室", "书店", "咖啡馆", "走廊")):
        _append_tag(tags, "indoors")
    elif any(token in text for token in ("室外", "户外", "街景", "城市", "广场", "公园", "草地", "步道", "树荫", "校园")):
        _append_tag(tags, "outdoors")

    if any(token in text for token in ("自然光", "窗边", "阴天")):
        _append_tag(tags, "natural light")
    elif any(token in text for token in ("柔光", "暖光", "灯光", "棚拍")):
        _append_tag(tags, "soft lighting")

    return tags


def _resolve_caption_text(action_text: str, index: int) -> str:
    text = str(action_text or "").strip()
    if "近景" in text or "肖像" in text:
        return f"近景 {index + 1}"
    if "半身" in text:
        return f"半身 {index + 1}"
    if "全身" in text:
        return f"全身 {index + 1}"
    return f"素材 {index + 1}"


def _build_training_caption(caption_tag: str, action_text: str) -> str:
    trigger = _normalize_caption_tag(caption_tag)
    if not trigger:
        raise RuntimeError("打标标签不能为空。请填写唯一触发词，例如 gydboy。")
    tags: List[str] = [trigger]
    for base_tag in DEFAULT_CAPTION_BASE_TAGS:
        _append_tag(tags, base_tag)
    for action_tag in _caption_tags_from_action(action_text):
        _append_tag(tags, action_tag)
    return ", ".join(tags)


def _slugify_label(text: str, index: int) -> str:
    clean = str(text or "").strip()
    clean = re.sub(r"[\\/:*?\"<>|]+", " ", clean)
    clean = re.sub(r"[\r\n\t]+", " ", clean)
    clean = re.sub(r"[，,。.;；!！?？()（）【】\\[\\]{}]+", "_", clean)
    clean = re.sub(r"\s+", "_", clean).strip("_")
    if not clean:
        clean = f"素材_{index:03d}"
    return clean[:48]


def _ensure_exact_size(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        return image
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        return image
    if int(image.shape[2]) == int(width) and int(image.shape[1]) == int(height):
        return image.contiguous()
    chw = image.permute(0, 3, 1, 2)
    resized = F.interpolate(chw, size=(int(height), int(width)), mode="bilinear", align_corners=False)
    return resized.permute(0, 2, 3, 1).contiguous()


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    if image.ndim == 4:
        image = image[0]
    array = image.detach().cpu().numpy()
    array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(array, mode="RGB")


def _save_dataset(
    save_directory: str,
    results: List[torch.Tensor],
    txt_labels: List[str],
    short_labels: List[str],
) -> int:
    target_dir = Path(str(save_directory or "").strip())
    if not str(target_dir):
        return 0
    target_dir.mkdir(parents=True, exist_ok=True)
    saved_count = 0
    for index, (image_tensor, txt_label, short_label) in enumerate(zip(results, txt_labels, short_labels), start=1):
        stem = f"{index:03d}_{_slugify_label(short_label or txt_label, index)}"
        image_path = target_dir / f"{stem}.png"
        text_path = target_dir / f"{stem}.txt"
        _tensor_to_pil(image_tensor).save(image_path)
        text_path.write_text(str(txt_label or "").strip() + "\n", encoding="utf-8")
        saved_count += 1
    return saved_count


class GJJLoraFaceMaterialGenerator(GJJ_LazyImageStudio):
    CATEGORY = "GJJ"
    FUNCTION = "generate_materials"
    DESCRIPTION = (
        "输入同一人物的多张参考图，默认使用 qwen_image_edit_2511 一致性编辑链批量生成可直接用于 LoRA 训练的单人素材。"
        "参考图只负责身份、发型和脸部角度，节点会重建近景 / 半身 / 全身构图，并自动输出指定训练模型推荐尺寸。"
    )
    SEARCH_ALIASES = ["LoRA素材", "训练图集", "人物训练素材", "随机多角度", "Qwen训练素材"]
    RETURN_TYPES = (GJJ_BATCH_IMAGE_TYPE, "IMAGE")
    RETURN_NAMES = ("训练素材队列", "素材拼接预览")
    OUTPUT_TOOLTIPS = ("按顺序输出的 GJJ 专用单人训练素材批量队列。", "自动拼接后的预览图板。")

    @classmethod
    def INPUT_TYPES(cls):
        unet_models = _safe_unet_models()
        return {
            "required": {
                "model_preset": (
                    tuple(MODEL_PRESETS.keys()),
                    {
                        "default": "Qwen",
                        "display_name": "训练模型",
                        "tooltip": "按目标训练模型推荐尺寸输出素材。",
                    },
                ),
                "material_template": (
                    MATERIAL_TEMPLATE_OPTIONS,
                    {
                        "default": "训练二十图",
                        "display_name": "素材模板",
                        "tooltip": "默认至少输出 20 张单人训练素材。",
                    },
                ),
                "base_prompt": (
                    "STRING",
                    {
                        "default": "真实摄影，单人，人物一致性训练素材，不同服装，不同背景，不同光线，适合 LoRA 训练。",
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "人物补充提示词",
                        "tooltip": "决定衣服风格、场景偏好、氛围和材质。",
                    },
                ),
                "caption_tag": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "打标标签",
                        "tooltip": "必填。训练用唯一触发词，会放在每个 TXT 标签的最前面，例如 gydboy。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "反向提示词",
                        "tooltip": "可选反向提示词；留空会自动补充单人训练素材专用反向词。",
                    },
                ),
                "custom_action_prompts": (
                    "STRING",
                    {
                        "default": "\n".join(TRAINING_20_LINES),
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "自定义素材列表",
                        "tooltip": "仅在素材模板=自定义时生效。每行一条构图 / 场景 / 服装要求。",
                    },
                ),
                "unet_name": (
                    unet_models,
                    {
                        "default": _default_unet_name(unet_models),
                        "display_name": "🟣 UNET 主模型",
                        "tooltip": "主生成模型。当前节点建议使用 qwen_image_edit_2511 系列。",
                    },
                ),
                "custom_width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 64,
                        "max": 4096,
                        "step": 8,
                        "display_name": "自定义宽度",
                        "tooltip": "仅在训练模型=自定义时生效。",
                    },
                ),
                "custom_height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 64,
                        "max": 4096,
                        "step": 8,
                        "display_name": "自定义高度",
                        "tooltip": "仅在训练模型=自定义时生效。",
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
                        "tooltip": "基础随机种子；每张素材会在此基础上自动递增。",
                    },
                ),
                "save_directory": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "保存目录",
                        "tooltip": "可选。填写本地目录后，会自动把生成素材保存为 PNG，并输出同名 TXT 标签文件。",
                    },
                ),
                "reference_batch": (
                    GJJ_BATCH_IMAGE_TYPE,
                    {
                        "display_name": "参考图队列",
                        "tooltip": "连接 GJJ 专用批量参考图队列；通常直接对接 GJJ · 多图片加载预览器 的批量图片输出。",
                    },
                ),
            },
            "optional": {},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def _collect_reference_images(self, kwargs: Dict[str, Any]) -> List[torch.Tensor]:
        return _flatten_slot_images(kwargs.get("reference_batch"))

    def _resolve_generation_bundle(self, unet_name: str):
        preset = match_model_family(unet_name)
        clip_models = list_clip_models() or [DEFAULT_CLIP_NAME]
        vae_models = list_vae_models() or [DEFAULT_VAE_NAME]
        resolved_clip_names = resolve_clip_names_for_preset(
            preset,
            clip_models,
            exposed_clip_name=DEFAULT_CLIP_NAME,
            legacy_clip_names=[DEFAULT_CLIP_NAME],
        )
        if not resolved_clip_names:
            resolved_clip_names = [_pick_available_name("", clip_models, DEFAULT_CLIP_NAME)]
        resolved_vae_name = _pick_available_name(preset.get("vae_name", DEFAULT_VAE_NAME), vae_models, DEFAULT_VAE_NAME)
        resolved_clip_type = resolve_clip_type(
            unet_name,
            resolved_clip_names,
            str(preset.get("clip_type", "stable_diffusion")),
        )
        return preset, resolved_clip_names, resolved_clip_type, resolved_vae_name

    def _generate_single_material(
        self,
        model,
        clip,
        vae,
        preset: Dict[str, Any],
        ref_image: torch.Tensor,
        view_prompt: str,
        negative_prompt: str,
        width: int,
        height: int,
        seed: int,
    ) -> torch.Tensor:
        positive, negative, _ = self._encode_multi_image_edit(
            clip=clip,
            vae=vae,
            prompt=view_prompt,
            negative_prompt=negative_prompt,
            main_image_index=1,
            pairs=[{"slot_index": 0, "image": ref_image}],
            main_mask=None,
            main_long_edge=int(preset.get("main_long_edge", 1024)),
            vl_long_edge=int(preset.get("vl_long_edge", 512)),
        )
        latent_out = self._build_latent(
            vae=vae,
            width=width,
            height=height,
            batch_size=1,
            image_pairs=[],
            mask=None,
            grow_mask_by=0,
            preset=preset,
        )
        effective_steps = _resolve_effective_steps(
            int(preset.get("steps", 4)),
            preset,
            str(preset.get("lora_1_name", "")),
            float(preset.get("lora_1_strength", 0.0)),
            str(preset.get("lora_2_name", "")),
            float(preset.get("lora_2_strength", 0.0)),
        )
        sampled_latent = self._generate_checkpoint_image(
            model=model,
            positive=positive,
            negative=negative,
            latent_out=latent_out,
            seed=seed,
            steps=effective_steps,
            cfg=float(preset.get("cfg", 1.0)),
            sampler_name=str(preset.get("sampler_name", "euler")),
            scheduler=str(preset.get("scheduler", "simple")),
            denoise=float(preset.get("denoise", 1.0)),
            vae=vae,
        )
        return sampled_latent

    def _generate_checkpoint_image(
        self,
        model,
        positive,
        negative,
        latent_out,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        vae,
    ) -> torch.Tensor:
        from nodes import VAEDecode, common_ksampler

        sampled_latent = common_ksampler(
            model,
            int(seed),
            int(steps),
            float(cfg),
            str(sampler_name),
            str(scheduler),
            positive,
            negative,
            latent_out,
            denoise=float(denoise),
        )[0]
        return VAEDecode().decode(vae, sampled_latent)[0]

    def generate_materials(
        self,
        model_preset,
        material_template,
        base_prompt,
        caption_tag,
        negative_prompt,
        custom_action_prompts,
        unet_name,
        custom_width,
        custom_height,
        seed,
        save_directory,
        unique_id=None,
        **kwargs,
    ):
        model_preset = _normalize_choice(model_preset, tuple(MODEL_PRESETS.keys()), "Qwen")
        material_template = _normalize_choice(material_template, MATERIAL_TEMPLATE_OPTIONS, "训练二十图")
        custom_width = _safe_int(custom_width, 1024)
        custom_height = _safe_int(custom_height, 1024)
        seed = _safe_int(seed, DEFAULT_SEED)
        caption_tag = _normalize_caption_tag(caption_tag)
        if not caption_tag:
            raise RuntimeError("LoRA人脸素材生成器需要填写【打标标签】。例如：gydboy")

        reference_images = self._collect_reference_images(kwargs)
        if not reference_images:
            raise RuntimeError("LoRA人脸素材生成器至少需要连接 1 张同一人物参考图。")

        action_lines = _expand_to_material_count(
            _template_lines(material_template, custom_action_prompts),
            _minimum_material_count(material_template, model_preset),
        )
        target_width, target_height = _resolve_size(model_preset, custom_width, custom_height)

        _send_status(unique_id, "1/5 加载 Qwen 一致性编辑主链...")
        try:
            preset, resolved_clip_names, resolved_clip_type, resolved_vae_name = self._resolve_generation_bundle(unet_name)
            if not bool(preset.get("supports_multi_image_edit")):
                raise RuntimeError("当前模型不支持多图一致性编辑，请改用 qwen_image_edit_2511 或 qwen_image_edit。")
            model, clip, vae = self._load_runtime_pipeline(
                unet_name,
                DEFAULT_UNET_DTYPE,
                resolved_clip_names,
                resolved_clip_type,
                resolved_vae_name,
            )
            model, clip = self._apply_loras(
                model,
                clip,
                str(preset.get("lora_1_name", "")),
                float(preset.get("lora_1_strength", 0.0)),
                str(preset.get("lora_2_name", "")),
                float(preset.get("lora_2_strength", 0.0)),
            )
            model = _patch_model_sampling(model, str(preset.get("model_sampling", "")), float(preset.get("model_shift", 0.0)))
            model = _apply_cfg_norm(model, float(preset.get("cfg_norm_strength", 0.0)))
        except Exception as exc:
            raise RuntimeError(
                "LoRA人脸素材生成器加载模型失败。\n"
                f"UNET：{unet_name}\n"
                f"详细错误：{exc}"
            ) from exc

        results: List[torch.Tensor] = []
        captions: List[str] = []
        txt_labels: List[str] = []
        total = len(action_lines)
        ref_count = len(reference_images)

        for index, action_text in enumerate(action_lines, start=1):
            ref_image = reference_images[(index - 1) % ref_count]
            view_prompt = _compose_training_prompt(base_prompt, action_text)
            _send_status(unique_id, f"2/5 生成第 {index}/{total} 张素材...")
            try:
                result = self._generate_single_material(
                    model=model,
                    clip=clip,
                    vae=vae,
                    preset=preset,
                    ref_image=ref_image,
                    view_prompt=view_prompt,
                    negative_prompt=_compose_negative_prompt(negative_prompt),
                    width=target_width,
                    height=target_height,
                    seed=seed + index - 1,
                )
            except Exception as exc:
                raise RuntimeError(
                    f"LoRA人脸素材生成器在生成第 {index} 张素材时失败。\n"
                    f"动作描述：{action_text}\n"
                    f"详细错误：{exc}"
                ) from exc
            result = _ensure_exact_size(result, target_width, target_height)
            results.append(result)
            captions.append(_resolve_caption_text(action_text, index - 1))
            txt_labels.append(_build_training_caption(caption_tag, action_text))

        _send_status(unique_id, "3/5 拼接预览图板...")
        collage = _make_squareish_collage(results, captions)
        batch_images = torch.cat(results, dim=0) if results else collage
        saved_count = 0
        if str(save_directory or "").strip():
            _send_status(unique_id, "4/5 保存图片和同名 TXT 标签...")
            try:
                saved_count = _save_dataset(save_directory, results, txt_labels, captions)
            except Exception as exc:
                raise RuntimeError(f"保存训练素材失败：{exc}") from exc
        else:
            _send_status(unique_id, f"4/5 输出 {len(results)} 张单人素材，尺寸 {target_width} × {target_height}")
        tail = f"，已保存 {saved_count} 组图片+TXT" if saved_count > 0 else ""
        _send_status(unique_id, f"5/5 完成：共使用 {len(reference_images)} 张参考图，生成 {len(results)} 张训练素材{tail}")
        return (batch_images, collage)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJLoraFaceMaterialGenerator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "GJJ · 🙂 LoRA人脸素材生成器",
}
