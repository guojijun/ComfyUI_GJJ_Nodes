from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path
from typing import Any

import comfy.utils
import folder_paths
import numpy as np
import torch
import torch.nn.functional as F
from comfy.cli_args import args
from PIL import Image, ImageDraw, ImageFont
from PIL.PngImagePlugin import PngInfo
from nodes import VAEDecode, common_ksampler

from .common_utils.text_tools import (
	gjjutils_canonical_model_text as _canonical_model_text,
	gjjutils_normalize_text as _normalize_text,
	gjjutils_pick_available_name as _pick_available_name,
)
from .common_utils.model_loader import (
	DEFAULT_UNET_DTYPE,
	DEFAULT_UNET_NAME,
	DEFAULT_LIGHTNING_LORA,
	gjjutils_apply_cfg_norm as _apply_cfg_norm,
	gjjutils_patch_model_sampling as _patch_model_sampling,
	gjjutils_load_model,
	gjjutils_load_clip_from_names,
	gjjutils_load_vae,
)
from .common_utils.model_family import (
	DEFAULT_CLIP_NAME,
	DEFAULT_VAE_NAME,
	gjjutils_match_model_family_preset as match_model_family,
	gjjutils_model_family_resolve_clip_names as resolve_clip_names_for_preset,
	gjjutils_model_family_resolve_clip_type as resolve_clip_type,
)
from .gjj_model_bundle_loader import (
	list_clip_models,
	list_unet_models,
	list_vae_models,
)
from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .gjj_multi_lora_chain import normalize_lora_chain_data
from .common_utils.dependency_checker import (
	DEFAULT_MODEL_URL,
	build_dependency_model_report,
)



def _safe_filename_list(category: str) -> list[str]:
	"""安全获取文件名列表。"""
	try:
		return list(folder_paths.get_filename_list(category))
	except Exception:
		return []


def _should_skip_clip_lora_for_multiview_family() -> bool:
	"""判断多视图节点是否应该跳过 CLIP LoRA（Qwen Image 系列不需要）。"""
	return True  # 多视图节点主要针对 Qwen Image，默认跳过 CLIP LoRA


def _dedupe_keep_order(values: list[str]) -> list[str]:
	"""去重并保持顺序。"""
	result: list[str] = []
	seen: set[str] = set()
	for item in values:
		value = str(item or "").strip()
		if not value or value in seen:
			continue
		seen.add(value)
		result.append(value)
	return result


def input_index(name: str, prefix: str) -> int:
	"""获取输入索引。"""
	text = str(name or "")
	if not text.startswith(prefix):
		return 999999
	try:
		return int(text[len(prefix):])
	except Exception:
		return 999999


def sorted_dynamic_items(kwargs: dict[str, Any], prefix: str) -> list[tuple[str, Any]]:
	"""排序动态项。"""
	return sorted(
		[(key, value) for key, value in kwargs.items() if str(key).startswith(prefix)],
		key=lambda item: input_index(item[0], prefix),
	)


def _split_image_batch(value: Any) -> list[Any]:
	"""分割图像批次。"""
	if value is None:
		return []
	if not isinstance(value, torch.Tensor):
		return [value]
	if value.ndim == 3:
		return [value.unsqueeze(0).contiguous()]
	if value.ndim != 4:
		return [value]
	batch_size = max(0, int(value.shape[0]))
	if batch_size <= 1:
		return [value.contiguous()]
	return [value[index: index + 1].contiguous() for index in range(batch_size)]


def collect_image_pairs(
	kwargs: dict[str, Any],
	prompt_graph: Any = None,
	unique_id: Any = None,
	batch_source_images: Any = None,
) -> list[dict[str, Any]]:
	"""收集图像对。简化版本，仅处理基本逻辑。"""
	from .gjj_multi_image_loader import (
		load_image_tensor,
		parse_selected_images,
		resolve_input_image_path,
	)

	primary_value = kwargs.get("image_01")
	# 简化：不处理恢复逻辑，直接分割批次
	pairs: list[dict[str, Any]] = []
	for name, value in sorted_dynamic_items(kwargs, "image_"):
		input_slot = input_index(name, "image_")
		if input_slot >= 999999 or value is None:
			continue
		source_images = _split_image_batch(value)
		for batch_index, image in enumerate(source_images):
			pairs.append({
				"slot_index": len(pairs),
				"source_input_index": input_slot - 1,
				"source_batch_index": batch_index,
				"image": image,
			})
	return pairs


IMAGE_RATIO_EPSILON = 0.015


def _ensure_mask_bhw(mask: torch.Tensor | None) -> torch.Tensor | None:
	"""确保遮罩为 BHW 格式。"""
	if mask is None:
		return None
	if mask.ndim == 2:
		return mask.unsqueeze(0)
	if mask.ndim == 3:
		return mask
	if mask.ndim == 4:
		return mask[:, 0, :, :]
	raise RuntimeError(f"不支持的遮罩维度：{tuple(mask.shape)}")


def _resize_image_exact(
	image: torch.Tensor, target_width: int, target_height: int, upscale: str = "lanczos"
) -> torch.Tensor:
	"""精确调整图像尺寸。"""
	samples = image.movedim(-1, 1)
	resized = comfy.utils.common_upscale(
		samples, int(target_width), int(target_height), upscale, "disabled"
	)
	return resized.movedim(1, -1)


def _resize_mask_exact(
	mask: torch.Tensor | None,
	target_width: int,
	target_height: int,
	upscale: str = "bilinear",
) -> torch.Tensor | None:
	"""精确调整遮罩尺寸。"""
	mask_bhw = _ensure_mask_bhw(mask)
	if mask_bhw is None:
		return None
	mask_image = mask_bhw.unsqueeze(1)
	resized = comfy.utils.common_upscale(
		mask_image, int(target_width), int(target_height), upscale, "disabled"
	)
	return resized[:, 0, :, :].clamp(0.0, 1.0)


def _same_aspect_ratio(
	width_a: int,
	height_a: int,
	width_b: int,
	height_b: int,
	epsilon: float = IMAGE_RATIO_EPSILON,
) -> bool:
	"""检查宽高比是否相同。"""
	if min(width_a, height_a, width_b, height_b) <= 0:
		return False
	ratio_a = float(width_a) / float(height_a)
	ratio_b = float(width_b) / float(height_b)
	return abs((ratio_a / ratio_b) - 1.0) <= float(epsilon)


def _fit_image_with_replicate_padding(
	image: torch.Tensor, target_width: int, target_height: int, upscale: str = "lanczos"
):
	"""使用复制填充适配图像。"""
	source_height = int(image.shape[1])
	source_width = int(image.shape[2])
	scale = min(
		float(target_width) / float(max(1, source_width)),
		float(target_height) / float(max(1, source_height)),
	)
	resized_width = max(8, int(round(source_width * scale)))
	resized_height = max(8, int(round(source_height * scale)))
	resized_width = min(int(target_width), resized_width)
	resized_height = min(int(target_height), resized_height)
	resized = _resize_image_exact(image, resized_width, resized_height, upscale)
	left = max(0, (int(target_width) - resized_width) // 2)
	top = max(0, (int(target_height) - resized_height) // 2)
	right = max(0, int(target_width) - resized_width - left)
	bottom = max(0, int(target_height) - resized_height - top)
	padded = F.pad(
		resized.movedim(-1, 1), (left, right, top, bottom), mode="replicate"
	).movedim(1, -1)
	mask = torch.ones(
		(image.shape[0], int(target_height), int(target_width)),
		dtype=image.dtype,
		device=image.device,
	)
	mask[:, top: top + resized_height, left: left + resized_width] = 0.0
	return padded, mask, left, top, resized_width, resized_height


def _prepare_primary_image_for_target(
	image: torch.Tensor,
	target_width: int,
	target_height: int,
	mask: torch.Tensor | None = None,
):
	"""准备主图以适应目标尺寸。"""
	source_height = int(image.shape[1])
	source_width = int(image.shape[2])
	target_width = max(8, int(target_width))
	target_height = max(8, int(target_height))
	if source_width == target_width and source_height == target_height:
		return image, _ensure_mask_bhw(mask), False
	if _same_aspect_ratio(source_width, source_height, target_width, target_height):
		return (
			_resize_image_exact(image, target_width, target_height, "lanczos"),
			_resize_mask_exact(mask, target_width, target_height),
			False,
		)
	padded_image, layout_mask, left, top, resized_width, resized_height = (
		_fit_image_with_replicate_padding(image, target_width, target_height, "lanczos")
	)
	composed_mask = layout_mask
	source_mask = _ensure_mask_bhw(mask)
	if source_mask is not None:
		resized_source_mask = _resize_mask_exact(
			source_mask, resized_width, resized_height
		)
		mask_canvas = torch.zeros_like(layout_mask)
		mask_canvas[:, top: top + resized_height, left: left + resized_width] = (
			resized_source_mask
		)
		composed_mask = torch.maximum(composed_mask, mask_canvas)
	return padded_image, composed_mask.clamp(0.0, 1.0), True


NODE_NAME = "GJJ_CharacterMultiViewStudio"
NODE_DISPLAY_NAME = "GJJ · 👤 主体一键多视图"
DEFAULT_MULTI_ANGLES_LORA = "qwen-image-edit-2511-multiple-angles-lora.safetensors"
DEFAULT_QWEN2511_UNET = "qwen_image_edit_2511_fp8mixed.safetensors"
DEFAULT_QWEN2511_CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
DEFAULT_QWEN2511_VAE = "qwen_image_vae.safetensors"
DEFAULT_QWEN2511_LIGHTNING_LORA = "QWEN\\lighting\\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
ACTION_MIGRATION_LORA_1 = "QWEN\\lighting\\FireRed-Image-Edit-1.0-Lightning-8steps-v1.1.safetensors"
ACTION_MIGRATION_LORA_1_STRENGTH = 1.0
ACTION_MIGRATION_LORA_2 = "QWEN\\2511\\edit_2511人景融合20.safetensors"
ACTION_MIGRATION_LORA_2_STRENGTH = 1.0
MAX_ACTION_REFERENCES = 9
DEFAULT_ACTION_LINES = [
	"白色背景。生成主体全身正视图。",
	"白色背景。生成主体全身正面右45°视图。",
	"白色背景。生成主体左侧视图。",
	"白色背景。生成主体右侧视图。",
	"白色背景。生成主体后视图。",
	"白色背景。生成主体半身正视图。",
]
DEFAULT_PRODUCT_ACTION_LINES = [
	"白色背景。生成产品正视图。",
	"白色背景。生成产品左侧视图。",
	"白色背景。生成产品后视图。",
	"白色背景。生成产品右侧视图。",
]
DEFAULT_EXTRA_PROMPT = "保持图一主体的类别、轮廓、材质、颜色、结构细节、标识与整体风格一致，单主体，白色背景。"
DEFAULT_NEGATIVE_PROMPT = ""
DEFAULT_SEED = 0
ALLOWED_PRESET_IDS = {
	"qwen_image_edit_2511",
	"qwen_image_edit",
	"flux1_fill_dev",
	"flux1_dev_kontext",
	"flux1_canny_dev",
	"lotus_depth",
}
SPECIAL_EDIT_KEYWORDS = ("fireredimageedit", "realfire")
CAPTION_HEIGHT = 48
CAPTION_PADDING_X = 8
CAPTION_PADDING_Y = 6
DEFAULT_SAVE_PREFIX = "主体多视图"
MAX_SAVE_FILENAME_LENGTH = 96
EMPTY_GRID_SLOT_PENALTY = 2.0
MODEL_DOWNLOAD_URL = DEFAULT_MODEL_URL

REQUIRED_MULTIVIEW_MODELS = [
	{
		"label": "Qwen Image Edit 2511 主模型",
		"subdir": "models/diffusion_models",
		"filename": DEFAULT_QWEN2511_UNET,
		"download_url": MODEL_DOWNLOAD_URL,
		"description": "主体多视图主生成模型；也可放在 ComfyUI 可识别的 unet/checkpoints 目录。",
	},
	{
		"label": "Qwen 2.5 VL 文本编码器",
		"subdir": "models/text_encoders",
		"filename": DEFAULT_QWEN2511_CLIP,
		"download_url": MODEL_DOWNLOAD_URL,
		"description": "Qwen Image Edit 系列 CLIP/VL 编码器。",
	},
	{
		"label": "Qwen Image VAE",
		"subdir": "models/vae",
		"filename": DEFAULT_QWEN2511_VAE,
		"download_url": MODEL_DOWNLOAD_URL,
		"description": "Qwen Image Edit 系列 VAE。",
	},
	{
		"label": "Qwen 2511 Lightning LoRA",
		"subdir": "models/loras/QWEN/lighting",
		"filename": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
		"download_url": MODEL_DOWNLOAD_URL,
		"description": "默认加速 LoRA；用于 4 步生成。",
	},
	{
		"label": "Qwen 2511 多角度 LoRA",
		"subdir": "models/loras/QWEN/2511",
		"filename": DEFAULT_MULTI_ANGLES_LORA,
		"download_url": MODEL_DOWNLOAD_URL,
		"description": "多视图角度一致性 LoRA。",
	},
]

OPTIONAL_ACTION_MODELS = [
	{
		"label": "FireRed 动作迁移 LoRA",
		"value": "models/loras/QWEN/lighting/FireRed-Image-Edit-1.0-Lightning-8steps-v1.1.safetensors",
		"tooltip": "仅在接入动作图并启用动作迁移模式时自动使用。",
	},
	{
		"label": "人景融合动作 LoRA",
		"value": "models/loras/QWEN/2511/edit_2511人景融合20.safetensors",
		"tooltip": "仅在接入动作图并启用动作迁移模式时自动使用。",
	},
	{
		"label": "OpenPose 模型",
		"value": "GJJ/ckpts/openpose/body_pose_model.pth、hand_pose_model.pth、facenet.pth",
		"tooltip": "仅当动作图不是骨架图、需要节点内部转 OpenPose 时使用；直接输入骨架图可不需要。",
	},
]


# ============================================================================
# 本地辅助函数（从 gjj_lazy_Image_studio 迁移）
# ============================================================================

def _resolve_effective_steps(
	requested_steps: int,
	preset: dict[str, Any],
	lora_1_name: str = "",
	lora_1_strength: float = 0.0,
	lora_2_name: str = "",
	lora_2_strength: float = 0.0,
) -> int:
	"""解析有效步数。"""
	base_steps = preset.get("base_steps")
	if base_steps is not None:
		return int(base_steps)
	return int(requested_steps)


def _resolve_native_sampler_scheduler(
	sampler_name: Any,
	scheduler: Any,
	unique_id: str | None = None,
) -> tuple[str, str]:
	"""Resolve sampler fields against ComfyUI core, with stable local fallbacks."""
	requested_sampler = str(sampler_name or "").strip() or "euler"
	requested_scheduler = str(scheduler or "").strip() or "simple"
	fallback_samplers = ("euler", "dpmpp_2m", "dpmpp_2m_sde", "lcm")
	fallback_schedulers = ("simple", "normal", "karras", "exponential", "sgm_uniform")

	try:
		import comfy.samplers

		samplers = list(getattr(comfy.samplers.KSampler, "SAMPLERS", []) or [])
		schedulers = list(getattr(comfy.samplers.KSampler, "SCHEDULERS", []) or [])
	except Exception:
		samplers = []
		schedulers = []

	if requested_sampler not in samplers:
		replacement = next((name for name in fallback_samplers if not samplers or name in samplers), "euler")
		if requested_sampler != replacement:
			_send_status(unique_id, f"⚠️ 采样器 {requested_sampler} 不可用，已回退为 {replacement}")
		requested_sampler = replacement
	if requested_scheduler not in schedulers:
		replacement = next((name for name in fallback_schedulers if not schedulers or name in schedulers), "simple")
		if requested_scheduler != replacement:
			_send_status(unique_id, f"⚠️ 调度器 {requested_scheduler} 不可用，已回退为 {replacement}")
		requested_scheduler = replacement
	return requested_sampler, requested_scheduler


PREFERED_KONTEXT_RESOLUTIONS = [
	(672, 1568),
	(688, 1504),
	(720, 1456),
	(752, 1392),
	(800, 1328),
	(832, 1248),
	(880, 1184),
	(944, 1104),
	(1024, 1024),
	(1104, 944),
	(1184, 880),
	(1248, 832),
	(1328, 800),
	(1392, 752),
	(1456, 720),
	(1504, 688),
	(1568, 672),
]


def _kontext_scale_image(image: torch.Tensor) -> torch.Tensor:
	"""将图像缩放到 FluxKontextImageScale 的最优尺寸。

	与 ComfyUI 内置 FluxKontextImageScale 行为一致：
	从 PREFERED_KONTEXT_RESOLUTIONS 中选择宽高比最接近的尺寸，
	使用 lanczos 缩放。
	"""
	if image is None:
		return image
	h = int(image.shape[1])
	w = int(image.shape[2])
	if w <= 0 or h <= 0:
		return image
	aspect_ratio = float(w) / float(h)
	_, best_w, best_h = min(
		(abs(aspect_ratio - float(pw) / float(ph)), pw, ph)
		for pw, ph in PREFERED_KONTEXT_RESOLUTIONS
	)
	result = comfy.utils.common_upscale(
		image.movedim(-1, 1), int(best_w), int(best_h), "lanczos", "center"
	).movedim(1, -1)
	return result


def _is_skeleton_image(image: torch.Tensor, threshold: float = 0.6):
	"""判断图像是否为骨架图（OpenPose格式），返回 (是否骨架图, 黑色占比)。

	骨架图特征：
	- 黑色背景占比很高（>60%的像素亮度<0.1）
	- 颜色分布非常集中（只有几种关键点颜色）
	"""
	if image is None:
		return False, 0.0

	if image.ndim == 4:
		img = image[0]
	else:
		img = image

	rgb = img[..., :3]
	brightness = rgb.mean(dim=-1)

	black_ratio = (brightness < 0.1).float().mean().item()

	return black_ratio > threshold, black_ratio


def _encode_multi_image_edit(
	clip,
	vae,
	prompt: str,
	negative_prompt: str,
	main_image_index: int,
	pairs: list[dict[str, Any]],
	main_mask=None,
	main_long_edge: int = 1024,
	vl_long_edge: int = 512,
	target_width: int = 1024,
	target_height: int = 1024,
):
	"""编码多图编辑条件。"""
	from nodes import node_helpers

	# 限制最大参考图数量以避免OOM
	MAX_REFERENCE_IMAGES = 5
	if len(pairs) > MAX_REFERENCE_IMAGES:
		print(
			f"[WARNING] 多图编辑参考图数量 ({len(pairs)}) 超过最大限制 ({MAX_REFERENCE_IMAGES})，仅使用前 {MAX_REFERENCE_IMAGES} 张"
		)
		# 确保主图在限制范围内
		main_slot = max(0, min(len(pairs) - 1, int(main_image_index) - 1))
		if main_slot >= MAX_REFERENCE_IMAGES:
			# 如果主图超出限制，将其包含在前MAX_REFERENCE_IMAGES张中
			selected_pairs = [pairs[main_slot]] + pairs[: MAX_REFERENCE_IMAGES - 1]
		else:
			selected_pairs = pairs[:MAX_REFERENCE_IMAGES]
		pairs = selected_pairs

	valid_length = len(pairs)
	main_slot = max(0, min(valid_length - 1, int(main_image_index) - 1))
	image_prompt = ""
	main_ref_latent = None
	noise_mask = None
	vl_images: list[torch.Tensor] = []

	# 降低VL处理分辨率以节省显存
	effective_vl_long_edge = min(vl_long_edge, 384)

	for slot, pair in enumerate(pairs):
		image = pair["image"]
		is_main = slot == main_slot
		if is_main:
			processed_image, prepared_mask, _ = _prepare_primary_image_for_target(
				image, int(target_width), int(target_height), main_mask
			)
			main_ref_latent = vae.encode(processed_image[:, :, :, :3])
			noise_mask = prepared_mask
			vl_image, _ignore_mask, _ignore_outpaint = (
				_prepare_primary_image_for_target(
					processed_image,
					int(effective_vl_long_edge),
					int(effective_vl_long_edge),
					None,
				)
			)
		else:
			vl_image, _ignore_mask, _ignore_outpaint = (
				_prepare_primary_image_for_target(
					image,
					int(effective_vl_long_edge),
					int(effective_vl_long_edge),
					None,
				)
			)
		vl_images.append(vl_image[:, :, :, :3])
		image_prompt += f"Picture {slot + 1}: "

		# 及时清理不需要的中间变量
		del vl_image

	if main_ref_latent is None:
		raise RuntimeError("主图参考 latent 生成失败，请检查主图输入是否有效。")
	full_prompt = image_prompt + str(prompt or "")
	tokens = clip.tokenize(full_prompt, images=vl_images)
	conditioning = clip.encode_from_tokens_scheduled(tokens)
	positive = node_helpers.conditioning_set_values(
		conditioning, {"reference_latents": [main_ref_latent]}, append=True
	)
	negative = [[torch.zeros_like(positive[0][0]), positive[0][1]]] if not str(negative_prompt or "").strip() else clip.encode_from_tokens_scheduled(clip.tokenize(str(negative_prompt)))
	latent_out = {"samples": main_ref_latent}
	if noise_mask is not None:
		latent_out["noise_mask"] = noise_mask

	# 清理VL图像列表以释放显存
	del vl_images

	return positive, negative, latent_out


def _build_latent(
	vae,
	width: int,
	height: int,
	batch_size: int,
	image_pairs: list[dict[str, Any]],
	mask,
	grow_mask_by: int,
	preset: dict[str, Any],
):
	"""构建 latent。"""
	from nodes import EmptyLatentImage, VAEEncode, VAEEncodeForInpaint

	# 检查是否为Flux2模型（32通道）
	is_flux2_model = False
	clip_type = preset.get("clip_type", "stable_diffusion")
	unet_name = preset.get("unet_name", "")

	# 通过UNET名称判断是否为Flux2模型
	normalized_unet = _normalize_text(unet_name)
	if "flux2" in normalized_unet:
		is_flux2_model = True

	# 或者通过clip_type判断
	if _normalize_text(clip_type) == "flux2":
		is_flux2_model = True

	if not image_pairs:
		if is_flux2_model:
			try:
				from nodes import EmptyFlux2LatentImage
				latent_dict = EmptyFlux2LatentImage(int(width), int(height), int(batch_size))
				return latent_dict
			except Exception:
				pass
		return EmptyLatentImage().generate(int(width), int(height), int(batch_size))[0]

	main_slot = max(0, min(len(image_pairs) - 1, 0))
	image = image_pairs[main_slot]["image"]
	prepared_image, prepared_mask, use_outpaint = _prepare_primary_image_for_target(
		image, int(width), int(height), mask
	)
	if prepared_mask is not None and (use_outpaint or mask is not None):
		return VAEEncodeForInpaint().encode(vae, prepared_image, prepared_mask, int(grow_mask_by))[0]
	return VAEEncode().encode(vae, prepared_image)[0]


def _send_status(unique_id: Any, text: str) -> None:
	if not unique_id:
		return
	message = str(text or "")
	try:
		from server import PromptServer
	except Exception:
		PromptServer = None
	try:
		if PromptServer is not None:
			PromptServer.instance.send_progress_text(message, unique_id)
	except Exception:
		pass


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
	try:
		if PromptServer is not None:
			PromptServer.instance.send_sync(
				"gjj_node_progress",
				{"node": str(unique_id), "text": message},
			)
	except Exception:
		pass


def _multiview_allowed_unets() -> list[str]:
	models = list_unet_models() or [DEFAULT_UNET_NAME]
	filtered: list[str] = []
	for model_name in models:
		preset = _match_multiview_family(model_name)
		if preset.get("id") in ALLOWED_PRESET_IDS or preset.get("supports_multi_image_edit"):
			filtered.append(model_name)
	return filtered or models


def _match_multiview_family(unet_name: str) -> dict[str, Any]:
	preset = match_model_family(unet_name)
	if preset is None:
		# 如果找不到预设，返回一个默认的 generic 预设
		return {"id": "generic", "clip_type": "stable_diffusion"}
	if preset.get("id") != "generic":
		return preset

	canonical = _canonical_model_text(unet_name)
	if any(keyword in canonical for keyword in SPECIAL_EDIT_KEYWORDS):
		fallback_preset = match_model_family("qwen_image_edit_2511")
		if fallback_preset is not None:
			override = dict(fallback_preset)
			override["id"] = "realfire_like_edit"
			return override
	return preset


def _pick_available_lora_name(candidates: list[str], preferred_name: str, fallback: str = "") -> str:
	preferred = str(preferred_name or "").strip()
	fallback = str(fallback or "").strip()
	if preferred and preferred in candidates:
		return preferred

	preferred_base = preferred.replace("\\", "/").split("/")[-1].lower()
	if preferred_base:
		for candidate in candidates:
			if candidate.replace("\\", "/").split("/")[-1].lower() == preferred_base:
				return candidate

	if fallback and fallback in candidates:
		return fallback
	fallback_base = fallback.replace("\\", "/").split("/")[-1].lower()
	if fallback_base:
		for candidate in candidates:
			if candidate.replace("\\", "/").split("/")[-1].lower() == fallback_base:
				return candidate

	return preferred or fallback


def _normalized_model_basename(value: str) -> str:
	return os.path.splitext(str(value or "").replace("\\", "/").split("/")[-1].lower())[0]


def _has_model_candidate(candidates: list[str], filenames: list[str]) -> bool:
	available = {_normalized_model_basename(candidate) for candidate in candidates}
	for filename in filenames:
		if _normalized_model_basename(filename) in available:
			return True
	return False


def _missing_multiview_models() -> list[dict[str, str]]:
	unet_models = list_unet_models() or []
	clip_models = list_clip_models() or []
	vae_models = list_vae_models() or []
	lora_models = _safe_filename_list("loras")
	missing: list[dict[str, str]] = []
	checks = [
		(REQUIRED_MULTIVIEW_MODELS[0], unet_models, [DEFAULT_QWEN2511_UNET, "qwen_image_edit_2511_nvfp4.safetensors"]),
		(REQUIRED_MULTIVIEW_MODELS[1], clip_models, [DEFAULT_QWEN2511_CLIP]),
		(REQUIRED_MULTIVIEW_MODELS[2], vae_models, [DEFAULT_QWEN2511_VAE]),
		(REQUIRED_MULTIVIEW_MODELS[3], lora_models, [DEFAULT_QWEN2511_LIGHTNING_LORA, "Qwen-Image-Edit-2511-Lightning"]),
		(REQUIRED_MULTIVIEW_MODELS[4], lora_models, [DEFAULT_MULTI_ANGLES_LORA]),
	]
	for model_info, candidates, filenames in checks:
		if not _has_model_candidate(candidates, filenames):
			missing.append(model_info)
	return missing


_MULTIVIEW_DESCRIPTION_READY = (
	"主体一键多视图：主图必选，动作可用图片参考、文字描述或按钮预设。"
	"节点会自动匹配 Qwen Image Edit 2511 为主线的图生图模型族，并将结果拼接成多视图图板。\n\n"
	"🌏模型下载：\n"
	f"{MODEL_DOWNLOAD_URL}\n\n"
	"📦 推荐模型：Qwen Image Edit 2511 主模型 + Qwen 2.5 VL CLIP + Qwen Image VAE + Lightning / 多角度 LoRA。\n"
	"🔧 Python 依赖：无需额外安装；使用 ComfyUI 官方模型加载、采样、VAE 与 GJJ 内部工具。\n"
	"💡 动作图模式：普通 RGB 动作图会尝试内部转 OpenPose；直接输入骨架图可跳过 OpenPose 模型。"
)
_MISSING_MULTIVIEW_MODELS = _missing_multiview_models()
_MULTIVIEW_MODEL_REPORT = build_dependency_model_report(
	node_name=NODE_DISPLAY_NAME,
	missing_models=_MISSING_MULTIVIEW_MODELS,
	description="主体一键多视图需要本地 Qwen Image Edit 2511 模型链。缺少模型时，节点仍会注册，但运行时可能加载失败。",
	model_download_url=MODEL_DOWNLOAD_URL,
)


def _parse_action_lines(action_prompts: str) -> list[str]:
	lines = [line.strip() for line in str(action_prompts or "").replace("\r\n", "\n").split("\n")]
	return [line for line in lines if line]


def _sanitize_prompt_filename(text: str, fallback: str = DEFAULT_SAVE_PREFIX) -> str:
	candidate = str(text or "").strip()
	candidate = re.sub(r'[<>:"/\\|?*%\x00-\x1F]+', "_", candidate)
	candidate = re.sub(r"\s+", " ", candidate).strip(" ._")
	if len(candidate) > MAX_SAVE_FILENAME_LENGTH:
		candidate = candidate[:MAX_SAVE_FILENAME_LENGTH].rstrip(" ._")
	return candidate or fallback


def _build_png_metadata(prompt: Any = None, extra_pnginfo: Any = None) -> PngInfo | None:
	if getattr(args, "disable_metadata", False):
		return None

	metadata = PngInfo()
	if prompt is not None:
		metadata.add_text("prompt", json.dumps(prompt, ensure_ascii=False))
	if isinstance(extra_pnginfo, dict):
		for key, value in extra_pnginfo.items():
			metadata.add_text(str(key), json.dumps(value, ensure_ascii=False))
	return metadata


def _save_multiview_batch_images(
	images: torch.Tensor,
	filename_prefixes: str | list[str],
	prompt: Any = None,
	extra_pnginfo: Any = None,
) -> list[dict[str, str]]:
	if images is None or len(images) == 0:
		return []

	output_dir = folder_paths.get_output_directory()
	if isinstance(filename_prefixes, str):
		prefix_list = [filename_prefixes] * len(images)
	else:
		prefix_list = list(filename_prefixes or [])
		fallback_prefix = prefix_list[-1] if prefix_list else DEFAULT_SAVE_PREFIX
		if len(prefix_list) < len(images):
			prefix_list.extend([fallback_prefix] * (len(images) - len(prefix_list)))
	results: list[dict[str, str]] = []

	for batch_number, image in enumerate(images, start=1):
		current_prefix = _sanitize_prompt_filename(prefix_list[batch_number - 1], DEFAULT_SAVE_PREFIX)
		full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
			current_prefix,
			output_dir,
			int(image.shape[1]),
			int(image.shape[0]),
		)
		os.makedirs(full_output_folder, exist_ok=True)
		pixels = 255.0 * image.cpu().numpy()
		pil_image = Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8))
		metadata = _build_png_metadata(prompt=prompt, extra_pnginfo=extra_pnginfo)
		file = f"{filename}_{counter:05}_{batch_number:02}.png"
		pil_image.save(
			os.path.join(full_output_folder, file),
			pnginfo=metadata,
			compress_level=4,
		)
		results.append(
			{
				"filename": file,
				"subfolder": subfolder,
				"type": "output",
			}
		)
		counter += 1

	return results


def _normalize_action_text(text: str) -> str:
	normalized = _normalize_text(text)
	for phrase in (
		"白色背景",
		"生成角色",
		"生成主体",
		"生成产品",
		"生成图一人物",
		"生成图一主体",
		"生成人物",
		"生成主体",
		"图一人物",
		"图一主体",
		"角色",
		"人物",
		"主体",
		"产品",
		"姿势参考图二",
		"参考图二姿势",
		"参考图二",
		"姿势参考",
	):
		normalized = normalized.replace(_normalize_text(phrase), "")
	return normalized


MULTIVIEW_VIEW_RULES = [
	("front_right", ("frontrightquarterview", "正面右45", "前右45", "右前45", "正面45右", "正面45", "正面 45", "正面45°", "正面 45°", "front-right quarter")),
	("front_left", ("frontleftquarterview", "正面左45", "前左45", "左前45", "正面45左", "front-left quarter")),
	("back_right", ("backrightquarterview", "背面右45", "后右45", "右后45", "back-right quarter")),
	("back_left", ("backleftquarterview", "背面左45", "后左45", "左后45", "back-left quarter")),
	("right", ("rightsideview", "右侧", "右视", "面朝右", "朝右", "right side")),
	("left", ("leftsideview", "左侧", "左视", "面朝左", "朝左", "left side")),
	("back", ("backview", "背面", "后视", "后面", "back view")),
	("front", ("frontview", "正面", "正视", "前视", "朝前", "front view")),
]

MULTIVIEW_CAMERA_RULES = [
	("low", ("lowangleshot", "低机位", "低角度", "仰视", "low-angle")),
	("high", ("highangleshot", "高机位", "高角度", "俯视", "high-angle")),
	("elevated", ("elevatedshot", "抬高机位", "抬高角度", "elevated shot")),
	("eye", ("eyelevelshot", "平视", "eye-level")),
]

MULTIVIEW_FRAMING_RULES = [
	("closeup", ("closeup", "close-up", "近景", "特写", "人脸", "面部", "肖像", "头像")),
	("half", ("mediumshot", "medium shot", "半身", "中景")),
	("full", ("wideshot", "wide shot", "全身", "远景", "全景")),
]

MULTIVIEW_TRIGGER_VIEWS = {
	"front": "front view",
	"front_right": "front-right quarter view",
	"right": "right side view",
	"back_right": "back-right quarter view",
	"back": "back view",
	"back_left": "back-left quarter view",
	"left": "left side view",
	"front_left": "front-left quarter view",
}

MULTIVIEW_TRIGGER_CAMERAS = {
	"low": "low-angle shot",
	"eye": "eye-level shot",
	"elevated": "elevated shot",
	"high": "high-angle shot",
}

MULTIVIEW_TRIGGER_FRAMINGS = {
	"closeup": "close-up",
	"half": "medium shot",
	"full": "wide shot",
}


def _match_rule_value(normalized: str, rules: list[tuple[str, tuple[str, ...]]], default: str) -> str:
	for value, aliases in rules:
		if any(alias in normalized for alias in aliases):
			return value
	return default


def _parse_multiview_components(action_text: str) -> tuple[str, str, str, str]:
	normalized = _normalize_action_text(action_text)
	outfit = "base"
	if any(keyword in normalized for keyword in ("换装", "换一套", "不同服装", "新服装", "替换服装", "altoutfit")):
		outfit = "alt_outfit"

	view = _match_rule_value(normalized, MULTIVIEW_VIEW_RULES, "generic")
	camera = _match_rule_value(normalized, MULTIVIEW_CAMERA_RULES, "eye")
	framing = _match_rule_value(normalized, MULTIVIEW_FRAMING_RULES, "full")
	return view, camera, framing, outfit


def _infer_view_signature(action_text: str, index: int) -> str:
	view, camera, framing, outfit = _parse_multiview_components(action_text)
	if view == "generic":
		normalized = _normalize_action_text(action_text)
		view = normalized or f"default_{index}"
	return f"{view}|{camera}|{framing}|{outfit}"


def _build_action_jobs(action_lines: list[str], action_pairs: list[dict[str, Any]]) -> list[dict[str, Any]]:
	if action_pairs:
		return [
			{
				"index": index,
				"text": action_lines[index] if index < len(action_lines) else "",
				"image": pair["image"],
				"signature": f"action_ref_{index}",
			}
			for index, pair in enumerate(action_pairs)
			if pair.get("image") is not None
		]

	count = max(len(action_lines), len(action_pairs), 1)
	jobs: list[dict[str, Any]] = []
	seen_signatures: set[str] = set()
	for index in range(count):
		action_text = action_lines[index] if index < len(action_lines) else ""
		action_image = action_pairs[index]["image"] if index < len(action_pairs) else None
		normalized_text = _normalize_text(action_text)
		if action_image is not None:
			signature = f"action_ref_{index}"
		elif normalized_text:
			signature = normalized_text
		else:
			signature = f"default_view_{_infer_view_signature(action_text, index)}_{index}"
		if signature in seen_signatures:
			continue
		seen_signatures.add(signature)
		jobs.append({
			"index": index,
			"text": action_text,
			"image": action_image,
			"signature": signature,
		})
	return jobs


def _resolve_image_hw(image: torch.Tensor, fallback_width: int = 1024, fallback_height: int = 1024) -> tuple[int, int]:
	try:
		shape = tuple(int(item) for item in image.shape)
	except Exception:
		return int(fallback_width), int(fallback_height)
	if len(shape) >= 3:
		height = int(shape[-3])
		width = int(shape[-2])
		if width > 0 and height > 0:
			return width, height
	return int(fallback_width), int(fallback_height)


def _align_size_multiple(value: int, step: int = 8) -> int:
	return max(int(step), int(round(float(value) / float(step)) * step))


def _resolve_target_size_from_image(
	image: torch.Tensor,
	longest_edge: int,
	fallback_width: int = 1024,
	fallback_height: int = 1024,
) -> tuple[int, int]:
	width, height = _resolve_image_hw(image, fallback_width, fallback_height)
	current_long_edge = max(width, height)
	if current_long_edge <= 0:
		return _align_size_multiple(fallback_width), _align_size_multiple(fallback_height)
	scale = float(longest_edge) / float(current_long_edge)
	target_width = _align_size_multiple(max(8, int(round(width * scale))))
	target_height = _align_size_multiple(max(8, int(round(height * scale))))
	return target_width, target_height


def _resolve_image_aspect(image: torch.Tensor, fallback: float = 1.0) -> float:
	width, height = _resolve_image_hw(image, 1, 1)
	if width <= 0 or height <= 0:
		return float(fallback)
	return float(width) / float(height)


def _sorted_action_items(kwargs: dict[str, Any]) -> list[tuple[int, torch.Tensor]]:
	items: list[tuple[int, torch.Tensor]] = []
	next_index = 1  # 下一个可用的动作图索引

	# 先收集所有动作图并按原始索引排序
	raw_items: list[tuple[int, Any]] = []
	for key, value in kwargs.items():
		text = str(key or "")
		if not text.startswith("action_image_") or value is None:
			continue
		try:
			index = int(text.split("_")[-1])
		except Exception:
			continue
		raw_items.append((index, value))

	# 按原始索引排序
	raw_items.sort(key=lambda item: item[0])

	# 展开批量图片并重新分配索引
	for original_index, value in raw_items:
		# 如果是 GJJ_BATCH_IMAGE（4D tensor），展开所有图片
		if isinstance(value, torch.Tensor) and value.ndim == 4:
			batch_size = int(value.shape[0])
			for i in range(batch_size):
				single_image = value[i:i+1].contiguous()
				items.append((next_index, single_image))
				next_index += 1
		else:
			# 单张图片，直接使用
			items.append((next_index, value))
			next_index += 1

	return items


def _compose_view_prompt(base_prompt: str, action_text: str, has_action_image: bool, index: int) -> str:
	default_line = DEFAULT_ACTION_LINES[index % len(DEFAULT_ACTION_LINES)]
	if has_action_image:
		chosen_line = (
			"Make the main subject in Picture 1 adopt the view angle, body direction, camera angle, framing, and composition of Picture 2. "
			"Preserve the subject category, silhouette, materials, colors, structure details, logos, and overall style of Picture 1. "
			"Do not replace the main subject in Picture 1 with the subject in Picture 2."
		)
	else:
		chosen_line = str(action_text or "").strip() or default_line
		trigger_line = _translate_multiview_trigger(chosen_line)
		if trigger_line and trigger_line not in chosen_line:
			chosen_line = f"{trigger_line}\n{chosen_line}"

	parts = [
		DEFAULT_EXTRA_PROMPT,
		str(base_prompt or "").strip(),
		chosen_line,
	]
	return "\n".join(part for part in parts if part)


def _translate_multiview_trigger(action_text: str) -> str:
	text = str(action_text or "").strip()
	if not text:
		return ""
	if "<sks>" in text.lower():
		return text

	view, camera, framing, _ = _parse_multiview_components(text)
	if view not in MULTIVIEW_TRIGGER_VIEWS:
		return ""

	return f"<sks> {MULTIVIEW_TRIGGER_VIEWS[view]} {MULTIVIEW_TRIGGER_CAMERAS.get(camera, 'eye-level shot')} {MULTIVIEW_TRIGGER_FRAMINGS.get(framing, 'wide shot')}"


def _prepare_qwen_ref_image(
	vae,
	image: torch.Tensor,
	target_width: int,
	target_height: int,
) -> tuple[torch.Tensor, torch.Tensor]:
	ref_image, _, _ = _prepare_primary_image_for_target(image, int(target_width), int(target_height), None)
	ref_latent = vae.encode(ref_image[:, :, :, :3])
	return ref_image, ref_latent


def _prepare_qwen_vl_image(image: torch.Tensor, target_size: int = 384, upscale: str = "bicubic", crop: str = "center") -> torch.Tensor:
	samples = image.movedim(-1, 1)
	total = int(target_size * target_size)
	current_total = max(1, int(samples.shape[3] * samples.shape[2]))
	scale_by = math.sqrt(float(total) / float(current_total))
	width = max(1, int(round(samples.shape[3] * scale_by)))
	height = max(1, int(round(samples.shape[2] * scale_by)))
	vl_samples = comfy.utils.common_upscale(samples, width, height, upscale, crop)
	return vl_samples.movedim(1, -1)


def _resolve_caption_text(action_text: str, index: int) -> str:
	text = str(action_text or "").strip() or DEFAULT_ACTION_LINES[index % len(DEFAULT_ACTION_LINES)]
	text = re.sub(r"^[<\s]*sks[>\s]*", "", text, flags=re.IGNORECASE).strip()
	text = re.sub(r"^白色背景[。,.，\s]*", "", text)
	text = re.sub(r"^生成(图一)?人物", "", text)
	text = re.sub(r"^生成角色", "", text)
	text = re.sub(r"^生成(图一)?主体", "", text)
	text = re.sub(r"^生成产品", "", text)
	text = re.sub(r"[。；;]+$", "", text).strip()
	if "，" in text:
		text = text.split("，", 1)[0].strip()
	if "," in text:
		text = text.split(",", 1)[0].strip()

	normalized = _normalize_action_text(text)
	view_parts: list[str] = []
	if "frontrightquarterview" in normalized or any(k in normalized for k in ("正面右45", "前右45", "右前45", "正面45", "正面 45", "正面45°", "正面 45°")):
		view_parts.append("正面右45°")
	elif "frontleftquarterview" in normalized or any(k in normalized for k in ("正面左45", "前左45", "左前45")):
		view_parts.append("正面左45°")
	elif "backrightquarterview" in normalized or any(k in normalized for k in ("背面右45", "后右45")):
		view_parts.append("背面右45°")
	elif "backleftquarterview" in normalized or any(k in normalized for k in ("背面左45", "后左45")):
		view_parts.append("背面左45°")
	elif "rightsideview" in normalized or "右侧" in normalized or "右视" in normalized:
		view_parts.append("右侧")
	elif "leftsideview" in normalized or "左侧" in normalized or "左视" in normalized:
		view_parts.append("左侧")
	elif "backview" in normalized or any(k in normalized for k in ("背面", "后视", "后面")):
		view_parts.append("背面")
	elif "frontview" in normalized or any(k in normalized for k in ("正面", "正视", "前视")):
		view_parts.append("正面")

	if "closeup" in normalized or any(k in normalized for k in ("近景", "特写", "人脸", "肖像", "头像")):
		view_parts.append("特写")
	elif "mediumshot" in normalized or "半身" in normalized:
		view_parts.append("半身")
	elif "wideshot" in normalized or "全身" in normalized:
		view_parts.append("全身")

	if any(k in normalized for k in ("换装", "新服装", "替换服装", "altoutfit")):
		view_parts.append("换装")
	elif any(k in normalized for k in ("不同配色", "新配色", "不同版本", "variant", "colorway")):
		view_parts.append("变体")

	if view_parts:
		return " · ".join(view_parts)

	return text[:18] if text else f"视图 {index + 1}"


def _clean_caption_source_text(action_text: str) -> str:
	text = str(action_text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
	if text:
		text = next((line.strip() for line in text.split("\n") if line.strip()), text)
	text = re.sub(r"^[<\s]*sks[>\s]*", "", text, flags=re.IGNORECASE).strip()
	text = re.sub(r"^白色背景[。,.，\s]*", "", text)
	text = re.sub(r"^生成(图一)?人物", "", text)
	text = re.sub(r"^生成角色", "", text)
	text = re.sub(r"^生成(图一)?主体", "", text)
	text = re.sub(r"^生成产品", "", text)
	return re.sub(r"[。；;]+$", "", text).strip()


def _split_caption_segments(text: str) -> list[str]:
	return [
		segment.strip()
		for segment in re.split(r"[，,；;。]+", str(text or ""))
		if segment.strip()
	]


def _common_leading_segment_count(segment_lists: list[list[str]]) -> int:
	non_empty_lists = [segments for segments in segment_lists if segments]
	if len(non_empty_lists) < 2:
		return 0
	limit = min(max(0, len(segments) - 1) for segments in non_empty_lists)
	count = 0
	for index in range(limit):
		first = _normalize_text(non_empty_lists[0][index])
		if first and all(_normalize_text(segments[index]) == first for segments in non_empty_lists[1:]):
			count += 1
		else:
			break
	return count


def _resolve_job_captions(jobs: list[dict[str, Any]]) -> list[str]:
	cleaned_lines = [
		_clean_caption_source_text(str(job.get("text", "") or ""))
		for job in jobs
	]
	segment_lists = [_split_caption_segments(line) for line in cleaned_lines]
	common_count = _common_leading_segment_count(segment_lists)
	captions: list[str] = []
	for job, cleaned, segments in zip(jobs, cleaned_lines, segment_lists):
		index = int(job.get("index", 0))
		if cleaned and "【" in cleaned:
			captions.append(_normalize_caption_line(cleaned))
			continue
		if common_count and len(segments) > common_count:
			caption = "，".join(segments[common_count:]).strip()
			captions.append(caption[:18] if caption else f"视图 {index + 1}")
			continue
		if cleaned:
			captions.append(_resolve_caption_text(cleaned, index))
			continue
		if job.get("image") is not None:
			captions.append(f"动作参考 {index + 1}")
			continue
		captions.append(_resolve_caption_text("", index))
	return captions


def _resolve_job_filename_prefix(job: dict[str, Any]) -> str:
	index = int(job.get("index", 0))
	text = str(job.get("text", "") or "").replace("\r\n", "\n").strip()
	if text:
		text = next((line.strip() for line in text.split("\n") if line.strip()), "")
		text = re.sub(r"^[<\s]*sks[>\s]*", "", text, flags=re.IGNORECASE).strip()
		text = re.sub(r"^白色背景[。,.，\s]*", "", text)
		text = re.sub(r"^生成(图一)?人物", "", text)
		text = re.sub(r"^生成角色", "", text)
		text = re.sub(r"^生成(图一)?主体", "", text)
		text = re.sub(r"^生成产品", "", text)
		text = re.sub(r"[。；;]+$", "", text).strip()
	if not text and job.get("image") is not None:
		text = f"动作参考 {index + 1}"
	if not text:
		text = _resolve_caption_text("", index)
	return _sanitize_prompt_filename(f"{index + 1:02d}_{text}", DEFAULT_SAVE_PREFIX)


def _resolve_job_caption(job: dict[str, Any]) -> str:
	index = int(job.get("index", 0))
	text = str(job.get("text", "") or "").replace("\r\n", "\n").replace("\r", "\n").strip()
	if text:
		line = next((line.strip() for line in text.split("\n") if line.strip()), text)
		if "【" in line:
			return _normalize_caption_line(line)
		return _resolve_caption_text(line, index)
	if job.get("image") is not None:
		return f"动作参考 {index + 1}"
	return _resolve_caption_text("", index)


def _best_grid(count: int, cell_width: int, cell_height: int, target_aspect: float = 1.0) -> tuple[int, int]:
	best_cols = 1
	best_rows = count
	best_score: tuple[float, int] | None = None
	target_ratio = max(0.1, float(target_aspect or 1.0))
	for cols in range(1, count + 1):
		rows = math.ceil(count / cols)
		total_width = cols * cell_width
		total_height = rows * (cell_height + CAPTION_HEIGHT)
		current_ratio = float(total_width) / float(max(1, total_height))
		empty_slots = max(0, rows * cols - count)
		score = (abs(current_ratio - target_ratio) + float(empty_slots) * EMPTY_GRID_SLOT_PENALTY, rows * cols)
		if best_score is None or score < best_score:
			best_score = score
			best_cols = cols
			best_rows = rows
	return best_cols, best_rows


def _resize_bchw(samples: torch.Tensor, width: int, height: int) -> torch.Tensor:
	return comfy.utils.common_upscale(samples, int(width), int(height), "lanczos", "center")


def _fit_bchw_to_height(samples: torch.Tensor, target_height: int) -> torch.Tensor:
	current_height = int(samples.shape[2])
	current_width = int(samples.shape[3])
	if current_height <= 0 or current_width <= 0:
		return samples
	scale = float(target_height) / float(current_height)
	target_width = max(1, int(round(current_width * scale)))
	return comfy.utils.common_upscale(samples, target_width, int(target_height), "lanczos", "disabled")


def _find_font_path() -> str | None:
	candidates = []
	windir = Path(str(Path.home().anchor or "C:\\"))
	try:
		import os
		win_fonts = Path(os.environ.get("WINDIR", "C:\\Windows")) / "Fonts"
		candidates.extend([
			win_fonts / "msyh.ttc",
			win_fonts / "msyh.ttf",
			win_fonts / "simhei.ttf",
		])
	except Exception:
		pass
	for candidate in candidates:
		if candidate.exists():
			return str(candidate)
	return None


def _load_caption_font(size: int):
	font_path = _find_font_path()
	if font_path:
		try:
			return ImageFont.truetype(font_path, size)
		except Exception:
			pass
	return ImageFont.load_default()


def _measure_caption_text(draw: ImageDraw.ImageDraw, text: str, font) -> tuple[int, int]:
	try:
		text_bbox = draw.textbbox((0, 0), str(text or ""), font=font)
		return (
			max(0, int(text_bbox[2] - text_bbox[0])),
			max(0, int(text_bbox[3] - text_bbox[1])),
		)
	except Exception:
		return (len(str(text or "")) * 10, 18)


def _trim_caption_to_width(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> str:
	content = str(text or "").rstrip()
	if not content:
		return ""
	width, _ = _measure_caption_text(draw, content, font)
	if width <= max_width:
		return content

	suffix = "..."
	while content:
		candidate = f"{content.rstrip()}{suffix}"
		candidate_width, _ = _measure_caption_text(draw, candidate, font)
		if candidate_width <= max_width:
			return candidate
		content = content[:-1]
	return suffix


def _normalize_caption_line(text: str) -> str:
	return re.sub(r"\s+", " ", str(text or "").replace("\r\n", " ").replace("\r", " ").replace("\n", " ")).strip()


def _draw_caption_on_canvas(canvas: np.ndarray, top: int, left: int, cell_width: int, caption_text: str, font) -> None:
	band = Image.fromarray(np.clip(canvas[top:top + CAPTION_HEIGHT, left:left + cell_width, :] * 255, 0, 255).astype(np.uint8))
	draw = ImageDraw.Draw(band)
	max_text_width = max(24, int(cell_width) - CAPTION_PADDING_X * 2)
	caption_text = _trim_caption_to_width(draw, _normalize_caption_line(caption_text), font, max_text_width)
	text_width, text_height = _measure_caption_text(draw, caption_text, font)
	text_x = max(CAPTION_PADDING_X, (cell_width - text_width) // 2)
	text_y = max(CAPTION_PADDING_Y, (CAPTION_HEIGHT - text_height) // 2)
	draw.text((text_x, text_y), caption_text, fill=(28, 38, 46), font=font)
	canvas[top:top + CAPTION_HEIGHT, left:left + cell_width, :] = np.asarray(band).astype(np.float32) / 255.0


def _paste_bchw_in_cell(canvas: np.ndarray, sample: torch.Tensor, top: int, left: int, cell_width: int, cell_height: int) -> None:
	image_np = sample[0].movedim(0, -1).detach().cpu().numpy().clip(0, 1).astype(np.float32)
	image_height = int(sample.shape[2])
	image_width = int(sample.shape[3])
	paste_y = top + max(0, (cell_height - image_height) // 2)
	paste_x = left + max(0, (cell_width - image_width) // 2)
	canvas[paste_y:paste_y + image_height, paste_x:paste_x + image_width, :] = image_np[:image_height, :image_width, :]


def _arrange_nine_view_order(images: list[torch.Tensor], captions: list[str]) -> tuple[list[torch.Tensor], list[str]]:
	if len(images) != 9:
		return images, captions

	def is_center_caption(text: str) -> bool:
		caption = str(text or "")
		return any(keyword in caption for keyword in ("特写", "头像", "肖像"))

	center_index = next((index for index, caption in enumerate(captions) if is_center_caption(caption)), None)
	if center_index is None:
		return images, captions

	ordered_images: list[torch.Tensor | None] = [None] * 9
	ordered_captions: list[str | None] = [None] * 9
	ordered_images[4] = images[center_index]
	ordered_captions[4] = captions[center_index]

	fill_positions = [0, 1, 2, 3, 5, 6, 7, 8]
	fill_iter = iter(fill_positions)
	for index, image in enumerate(images):
		if index == center_index:
			continue
		target = next(fill_iter)
		ordered_images[target] = image
		ordered_captions[target] = captions[index] if index < len(captions) else f"视图 {index + 1}"

	return (
		[image for image in ordered_images if image is not None],
		[str(caption or "") for caption in ordered_captions if caption is not None],
	)


def _best_fixed_grid(
	count: int,
	cell_width: int,
	cell_height: int,
	candidates: tuple[tuple[int, int], ...],
	target_aspect: float = 1.0,
) -> tuple[int, int]:
	target_ratio = max(0.1, float(target_aspect or 1.0))
	valid = [candidate for candidate in candidates if candidate[0] * candidate[1] >= count]
	if not valid:
		return _best_grid(count, cell_width, cell_height, target_aspect=target_aspect)
	return min(
		valid,
		key=lambda item: (
			abs(float(item[0] * cell_width) / float(max(1, item[1] * (cell_height + CAPTION_HEIGHT))) - target_ratio),
			item[0] * item[1],
		),
	)


def _make_character_asset_collage(images: list[torch.Tensor], captions: list[str]) -> torch.Tensor:
	"""创建人物资产 1x4 横向长图拼接。
	第一张图保持原图比例，后三张裁剪为竖版构图（9:16）。
	后三张图采用中心裁剪策略，从生成的方形图片中裁出竖版中心区域。
	"""
	if len(images) != 4:
		# 如果不是4张图，使用默认拼接方式
		return _make_squareish_collage(images, captions)

	bchw_images = [image[:1].movedim(-1, 1) for image in images]

	# 统一所有图片的高度（以第一张图为准）
	cell_height = int(bchw_images[0].shape[2])

	# 第一张图：保持原始宽高比，不裁剪
	first_cell_width = int(bchw_images[0].shape[3])
	fitted_first = bchw_images[0]

	# 后三张图：裁剪为竖版（9:16）
	# 策略：先缩放到统一高度，然后从中心裁剪出竖版宽度
	portrait_ratio = 9.0 / 16.0
	portrait_cell_width = int(cell_height * portrait_ratio)

	fitted_images = [fitted_first]  # 第一张图
	for i in range(1, 4):
		# 先缩放到统一高度，保持原始宽高比
		scaled = _fit_bchw_to_height(bchw_images[i], cell_height)
		# 从缩放后的图片中心裁剪出竖版宽度
		original_width = int(scaled.shape[3])
		if original_width > portrait_cell_width:
			# 从中心裁剪，保留人物主体
			crop_start = (original_width - portrait_cell_width) // 2
			fitted = scaled[:, :, :, crop_start:crop_start + portrait_cell_width]
		else:
			# 如果宽度不够，使用原始缩放后的图片（不拉伸）
			fitted = scaled
		fitted_images.append(fitted)

	# 计算画布尺寸：1行4列，横向排列
	total_width = first_cell_width + portrait_cell_width * 3
	total_height = cell_height + CAPTION_HEIGHT
	canvas = np.ones((total_height, total_width, 3), dtype=np.float32)
	font = _load_caption_font(18)

	# 排列第一张图（保持原比例）
	_paste_bchw_in_cell(canvas, fitted_images[0], 0, 0, first_cell_width, cell_height)
	caption_text = str(captions[0] if len(captions) > 0 else "视图 1")
	_draw_caption_on_canvas(canvas, cell_height, 0, first_cell_width, caption_text, font)

	# 横向排列后三张图（竖版构图，居中显示）
	for index in range(1, 4):
		left = first_cell_width + (index - 1) * portrait_cell_width
		_paste_bchw_in_cell(canvas, fitted_images[index], 0, left, portrait_cell_width, cell_height)
		caption_text = str(captions[index] if len(captions) > index else f"视图 {index + 1}")
		_draw_caption_on_canvas(canvas, cell_height, left, portrait_cell_width, caption_text, font)

	return torch.from_numpy(canvas).unsqueeze(0)


def _make_five_view_collage(images: list[torch.Tensor], captions: list[str]) -> torch.Tensor:
	bchw_images = [image[:1].movedim(-1, 1) for image in images]
	right_images = bchw_images[1:]
	small_cell_height = max(int(sample.shape[2]) for sample in right_images) if right_images else int(bchw_images[0].shape[2])
	small_fitted: list[torch.Tensor] = []
	small_cell_width = 0
	for sample in right_images:
		fitted = _fit_bchw_to_height(sample, small_cell_height)
		small_fitted.append(fitted)
		small_cell_width = max(small_cell_width, int(fitted.shape[3]))

	panel_height = small_cell_height * 2 + CAPTION_HEIGHT
	standard_image_height = max(1, panel_height)
	standard_fitted = _fit_bchw_to_height(bchw_images[0], standard_image_height)
	standard_cell_width = max(1, int(standard_fitted.shape[3]))
	total_height = panel_height + CAPTION_HEIGHT
	total_width = standard_cell_width + small_cell_width * 2
	canvas = np.ones((total_height, total_width, 3), dtype=np.float32)
	font = _load_caption_font(18)

	_paste_bchw_in_cell(canvas, standard_fitted, 0, 0, standard_cell_width, standard_image_height)
	_draw_caption_on_canvas(
		canvas,
		standard_image_height,
		0,
		standard_cell_width,
		str(captions[0] if captions else "标准照"),
		font,
	)

	for index, sample in enumerate(small_fitted):
		row = index // 2
		col = index % 2
		top = row * (small_cell_height + CAPTION_HEIGHT)
		left = standard_cell_width + col * small_cell_width
		_paste_bchw_in_cell(canvas, sample, top, left, small_cell_width, small_cell_height)
		caption_index = index + 1
		_draw_caption_on_canvas(
			canvas,
			top + small_cell_height,
			left,
			small_cell_width,
			str(captions[caption_index] if caption_index < len(captions) else f"视图 {caption_index + 1}"),
			font,
		)

	return torch.from_numpy(canvas).unsqueeze(0)


def _make_squareish_collage(images: list[torch.Tensor], captions: list[str], target_aspect: float = 1.0) -> torch.Tensor:
	if not images:
		raise RuntimeError("未生成任何视图结果，无法拼接多视图图板。")
	if len(images) == 5:
		return _make_five_view_collage(images, captions)
	if len(images) == 9:
		images, captions = _arrange_nine_view_order(images, captions)

	bchw_images: list[torch.Tensor] = []
	cell_height = 0
	for image in images:
		sample = image[:1].movedim(-1, 1)
		bchw_images.append(sample)
		cell_height = max(cell_height, int(sample.shape[2]))

	fitted_images: list[torch.Tensor] = []
	cell_width = 0
	for sample in bchw_images:
		fitted = _fit_bchw_to_height(sample, cell_height)
		fitted_images.append(fitted)
		cell_width = max(cell_width, int(fitted.shape[3]))

	font = _load_caption_font(18)
	if len(bchw_images) == 9:
		cols, rows = 3, 3
	elif len(bchw_images) == 6:
		cols, rows = _best_fixed_grid(6, cell_width, cell_height, ((2, 3), (3, 2)), target_aspect=target_aspect)
	else:
		cols, rows = _best_grid(len(bchw_images), cell_width, cell_height, target_aspect=target_aspect)
	total_height = rows * (cell_height + CAPTION_HEIGHT)
	canvas = np.ones((total_height, cols * cell_width, 3), dtype=np.float32)
	for index, sample in enumerate(fitted_images):
		row = index // cols
		col = index % cols
		top = row * (cell_height + CAPTION_HEIGHT)
		left = col * cell_width
		_paste_bchw_in_cell(canvas, sample, top, left, cell_width, cell_height)

		caption_text = str(captions[index] if index < len(captions) else f"视图 {index + 1}")
		_draw_caption_on_canvas(canvas, top + cell_height, left, cell_width, caption_text, font)

	return torch.from_numpy(canvas).unsqueeze(0)


class FlexibleMultiViewInputType(dict):
	"""允许节点接收动态数量与动态类型的可选输入。"""

	def __init__(self, data: dict[str, Any] | None = None):
		super().__init__()
		self.data = data or {}
		for key, value in self.data.items():
			self[key] = value

	def __getitem__(self, key):
		if key in self.data:
			return self.data[key]
		text = str(key or "")
		if text.startswith("action_image_"):
			# 与 action_image_01 保持一致的类型
			return ("GJJ_BATCH_IMAGE,IMAGE",)
		raise KeyError(key)

	def __contains__(self, key):
		text = str(key or "")
		return key in self.data or text.startswith("action_image_")


class GJJ_CharacterMultiViewStudio:
	CATEGORY = "GJJ"
	FUNCTION = "generate"
	DESCRIPTION = (
		_MULTIVIEW_DESCRIPTION_READY
		if _MULTIVIEW_MODEL_REPORT.get("available", True)
		else f"{_MULTIVIEW_MODEL_REPORT['warning_message']}\n\n{_MULTIVIEW_DESCRIPTION_READY}"
	)
	SEARCH_ALIASES = [
		"主体一键多视图",
		"人物一键多视图",
		"产品四视图",
		"多视图",
		"角色转面",
		"角色多角度",
		"character multiview",
		"qwen edit 2511",
	]
	RETURN_TYPES = ("IMAGE", GJJ_BATCH_IMAGE_TYPE)
	RETURN_NAMES = ("👤 多视图拼接图", "单图批量图片")
	OUTPUT_TOOLTIPS = (
		"自动拼接后的多视图成品图。",
		"按视角顺序输出的 GJJ 专用批量图片，可直接接入批量图片输入接口。",
	)
	REQUIRED_MODELS = REQUIRED_MULTIVIEW_MODELS
	GJJ_HELP = {
		"title": NODE_DISPLAY_NAME,
		"description": _MULTIVIEW_DESCRIPTION_READY,
		"notice": _MULTIVIEW_MODEL_REPORT["help_message"] if not _MULTIVIEW_MODEL_REPORT.get("available", True) else "",
		"warning_message": _MULTIVIEW_MODEL_REPORT["warning_message"] if not _MULTIVIEW_MODEL_REPORT.get("available", True) else "",
		"copy_text": _MULTIVIEW_MODEL_REPORT["copy_text"] if not _MULTIVIEW_MODEL_REPORT.get("available", True) else MODEL_DOWNLOAD_URL,
		"copy_label": _MULTIVIEW_MODEL_REPORT["copy_label"] if not _MULTIVIEW_MODEL_REPORT.get("available", True) else "🌏 复制模型下载网址",
		"model_download_url": MODEL_DOWNLOAD_URL,
		"install_cmd": "",
		"dependencies": [
			"无需额外 Python 依赖；依赖 ComfyUI 官方模型加载、采样、VAE 解码和 GJJ 内部工具。",
			"动作图不是骨架图时，会调用 GJJ 内置 OpenPose 转骨架；OpenPose 模型缺失时请改用骨架图或补齐可选模型。",
		],
		"models": REQUIRED_MULTIVIEW_MODELS,
		"optional_models": OPTIONAL_ACTION_MODELS,
		"tips": [
			"推荐使用 qwen_image_edit_2511_fp8mixed.safetensors；本地若有 nvfp4 版本也可在下拉框中选择。",
			"主图是主体身份和外观参考；动作文本每行生成一个视图。",
			"连入动作图后会切换动作迁移模式，并自动优先使用 FireRed 动作迁移 LoRA 与人景融合 LoRA。",
			"额外 LoRA 请接入 LoRA串联配置，节点会在面板 LoRA 之后继续串联应用。",
		],
	}

	@classmethod
	def INPUT_TYPES(cls):
		unet_models = _multiview_allowed_unets()
		clip_models = list_clip_models() or [DEFAULT_CLIP_NAME]
		vae_models = list_vae_models() or [DEFAULT_VAE_NAME]
		lora_models = [""] + (_safe_filename_list("loras") or [])
		default_preset = _match_multiview_family(DEFAULT_UNET_NAME)
		return {
			"required": {
				"base_prompt": (
					"STRING",
					{
						"default": DEFAULT_EXTRA_PROMPT,
						"multiline": False,
						"dynamicPrompts": True,
						"display_name": "主体补充提示词",
						"tooltip": "可补充主体的材质、结构、颜色、风格或背景氛围描述。",
					},
				),
				"negative_prompt": (
					"STRING",
					{
						"default": DEFAULT_NEGATIVE_PROMPT,
						"multiline": False,
						"dynamicPrompts": True,
						"display_name": "反向提示词",
						"tooltip": "反向提示词；留空时会自动生成零反向条件。",
					},
				),
				"action_prompts": (
					"STRING",
					{
						"default": "\n".join(DEFAULT_ACTION_LINES),
						"multiline": True,
						"dynamicPrompts": True,
						"display_name": "动作文本列表",
						"tooltip": "每行一个动作 / 视角描述。若对应动作图存在，会自动与该行配对。",
					},
				),
				"unet_name": (
					unet_models,
					{
						"default": DEFAULT_UNET_NAME if DEFAULT_UNET_NAME in unet_models else unet_models[0],
						"display_name": "🟣 UNET 主模型",
						"tooltip": "只显示图生图 / 编辑型主模型，不显示纯文生图底模。",
					},
				),
				"lora_1_name": (
					lora_models,
					{
						"default": _pick_available_name(default_preset.get("lora_1_name", DEFAULT_LIGHTNING_LORA), lora_models, DEFAULT_LIGHTNING_LORA),
						"display_name": "🟢 第1组 LoRA",
						"tooltip": "推荐的加速或编辑 LoRA；强度为 0 或未选择时不参与运算。",
					},
				),
				"lora_1_strength": (
					"FLOAT",
					{
						"default": float(default_preset.get("lora_1_strength", 1.0)),
						"min": 0.0,
						"max": 4.0,
						"step": 0.01,
						"display_name": "LoRA 1 强度",
						"tooltip": "第一组 LoRA 强度。",
					},
				),
				"lora_2_name": (
					lora_models,
					{
						"default": _pick_available_lora_name(
							lora_models,
							default_preset.get("lora_2_name", DEFAULT_MULTI_ANGLES_LORA),
							DEFAULT_MULTI_ANGLES_LORA,
						),
						"display_name": "🟢 第2组 LoRA",
						"tooltip": "第二组 LoRA；多视图节点默认推荐多角度 LoRA，支持从 loras 子目录自动匹配。",
					},
				),
				"lora_2_strength": (
					"FLOAT",
					{
						"default": 1.0,
						"min": 0.0,
						"max": 2.0,
						"step": 0.01,
						"display_name": "LoRA 2 强度",
						"tooltip": "第二组 LoRA 强度。",
					},
				),
				"seed": (
					"INT",
					{
						"default": DEFAULT_SEED,
						"min": 0,
						"max": 0xFFFFFFFFFFFFFFFF,
						"control_after_generate": False,
						"display_name": "种子",
						"tooltip": "基础随机种子。每个视图会在此基础上顺延 +1。",
					},
				),
				"save_each_image": (
					"BOOLEAN",
					{
						"default": True,
						"display_name": "保存每张图片",
						"label_on": "保存",
						"label_off": "不保存",
						"tooltip": "开启后会把每张单图保存到输出目录，并把当前工作流元数据写进 PNG。",
					},
				),
			},
			"optional": FlexibleMultiViewInputType(
				{
					"main_image": (
						"GJJ_BATCH_IMAGE,IMAGE",
						{
							"display_name": "👤 主图",
							"tooltip": "主体主参考图，必选。支持 GJJ_BATCH_IMAGE 和 IMAGE 两种类型，节点会始终以这张图作为类别、外观与风格一致性的主参考。",
						},
					),
					"lora_chain_config": (
						"LORA_CHAIN_CONFIG",
						{
							"display_name": "LoRA串联配置",
							"tooltip": "可选接入 GJJ · LoRA串联配置 的输出；会在面板 LoRA 1 / LoRA 2 之后继续按顺序串联应用多组 LoRA。",
						},
					),
					"action_image_01": (
						"GJJ_BATCH_IMAGE,IMAGE",
						{
							"display_name": "动作图 1",
							"tooltip": "第一张动作 / 姿势参考图。支持 GJJ_BATCH_IMAGE 和 IMAGE 两种类型。连上后会自动扩展出下一张动作图输入。",
						},
					),

				}
			),
			"hidden": {
				"prompt": "PROMPT",
				"extra_pnginfo": "EXTRA_PNGINFO",
				"unique_id": "UNIQUE_ID",
			},
		}

	@classmethod
	def IS_CHANGED(
		cls,
		main_image,
		base_prompt,
		negative_prompt,
		action_prompts,
		unet_name,
		lora_1_name,
		lora_1_strength,
		lora_2_name,
		lora_2_strength,
		seed,
		save_each_image,
		unique_id=None,
		**kwargs,
	):
		image_signature = str(tuple(main_image.shape)) if hasattr(main_image, "shape") else "main_image"
		action_signature = "|".join(
			str(tuple(pair["image"].shape))
			for pair in collect_image_pairs({key.replace("image_", "action_image_"): value for key, value in kwargs.items()})
			if hasattr(pair.get("image"), "shape")
		)
		return "|".join(
			[
				image_signature,
				action_signature,
				str(base_prompt),
				str(negative_prompt),
				str(action_prompts),
				str(unet_name),
				str(lora_1_name),
				str(lora_1_strength),
				str(lora_2_name),
				str(lora_2_strength),
				str(normalize_lora_chain_data(kwargs.get("lora_chain_config", ""))),
				str(seed),
				str(bool(save_each_image)),
			]
		)

	def _load_runtime_pipeline(
		self,
		unet_name: str,
		unet_dtype: str,
		clip_names: list[str],
		clip_type: str,
		vae_name: str,
	):
		"""加载运行时管道（模型、CLIP、VAE）。"""
		model = gjjutils_load_model(unet_name, unet_dtype)
		clip = gjjutils_load_clip_from_names(clip_names, clip_type)
		vae = gjjutils_load_vae(vae_name)
		return model, clip, vae

	def _apply_loras(
		self,
		model,
		clip,
		lora_1_name: str,
		lora_1_strength: float,
		lora_2_name: str,
		lora_2_strength: float,
		lora_chain_config: str = "",
	):
		"""应用 LoRA 到模型和 CLIP。"""
		from .gjj_multi_lora_chain import apply_standard_lora, apply_lora_chain_config

		current_model = model
		current_clip = clip

		# Qwen Image 系列使用 LoraLoaderModelOnly（只加载模型 LoRA，不加载 CLIP LoRA）
		use_model_only = _should_skip_clip_lora_for_multiview_family()

		if use_model_only:
			# 使用 LoraLoaderModelOnly 只加载模型 LoRA
			try:
				from nodes import LoraLoaderModelOnly
				loader = LoraLoaderModelOnly()
				if str(lora_1_name or "").strip() and abs(float(lora_1_strength)) > 1e-6:
					current_model = loader.load_lora_model_only(current_model, lora_1_name, float(lora_1_strength))[0]
				if str(lora_2_name or "").strip() and abs(float(lora_2_strength)) > 1e-6:
					current_model = loader.load_lora_model_only(current_model, lora_2_name, float(lora_2_strength))[0]
			except ImportError:
				# 降级方案：使用 apply_standard_lora，但 CLIP 强度设为 0
				clip_strength = 0.0
				if str(lora_1_name or "").strip() and abs(float(lora_1_strength)) > 1e-6:
					lora_state = self._load_lora_state(lora_1_name)
					current_model, current_clip, _, _, _ = apply_standard_lora(
						current_model,
						current_clip,
						lora_state,
						float(lora_1_strength),
						float(clip_strength),
					)
				if str(lora_2_name or "").strip() and abs(float(lora_2_strength)) > 1e-6:
					lora_state = self._load_lora_state(lora_2_name)
					current_model, current_clip, _, _, _ = apply_standard_lora(
						current_model,
						current_clip,
						lora_state,
						float(lora_2_strength),
						float(clip_strength),
					)
		else:
			# 非 Qwen Image 系列，使用标准的 LoRA 加载方式
			clip_strength = None
			if str(lora_1_name or "").strip() and abs(float(lora_1_strength)) > 1e-6:
				lora_state = self._load_lora_state(lora_1_name)
				current_model, current_clip, _, _, _ = apply_standard_lora(
					current_model,
					current_clip,
					lora_state,
					float(lora_1_strength),
					float(lora_1_strength) if clip_strength is None else float(clip_strength),
				)
			if str(lora_2_name or "").strip() and abs(float(lora_2_strength)) > 1e-6:
				lora_state = self._load_lora_state(lora_2_name)
				current_model, current_clip, _, _, _ = apply_standard_lora(
					current_model,
					current_clip,
					lora_state,
					float(lora_2_strength),
					float(lora_2_strength) if clip_strength is None else float(clip_strength),
				)

		# 应用 LoRA 链配置（如果有的话）
		if str(lora_chain_config or "").strip():
			current_model, current_clip, _ = apply_lora_chain_config(
				current_model,
				current_clip,
				lora_data=normalize_lora_chain_data(lora_chain_config),
				loaded_lora_cache=None,
			)
		return current_model, current_clip

	def _load_lora_state(self, lora_name: str):
		"""加载 LoRA 状态字典。"""
		import comfy.utils
		lora_path = folder_paths.get_full_path("loras", lora_name)
		if not lora_path:
			raise FileNotFoundError(f"LoRA 文件未找到: {lora_name}")
		return comfy.utils.load_torch_file(lora_path, safe_load=True)

	def _encode_text_conditioning(self, clip, text: str):
		"""编码文本条件。"""
		tokens = clip.tokenize(str(text or ""))
		return clip.encode_from_tokens_scheduled(tokens)

	def _encode_negative_conditioning(self, clip, positive, negative_prompt: str):
		"""编码负向条件。"""
		if str(negative_prompt or "").strip():
			return self._encode_text_conditioning(clip, negative_prompt)
		# 如果没有负向提示，使用零化条件
		import torch
		return [[torch.zeros_like(positive[0][0]), positive[0][1]]]

	def _collect_action_pairs(self, kwargs: dict[str, Any]) -> list[dict[str, Any]]:
		return [
			{"slot_index": index - 1, "image": image}
			for index, image in _sorted_action_items(kwargs)[:MAX_ACTION_REFERENCES]
		]

	def _resolve_generation_bundle(
		self,
		unet_name: str,
		exposed_clip_name: str,
		visible_vae_name: str,
	):
		preset = _match_multiview_family(unet_name)
		clip_models = list_clip_models() or [DEFAULT_CLIP_NAME]
		vae_models = list_vae_models() or [DEFAULT_VAE_NAME]
		resolved_clip_names = resolve_clip_names_for_preset(
			preset,
			clip_models,
			exposed_clip_name=exposed_clip_name,
			legacy_clip_names=[exposed_clip_name],
		)
		if not resolved_clip_names:
			resolved_clip_names.append(_pick_available_name("", clip_models, DEFAULT_CLIP_NAME))
		resolved_vae_name = _pick_available_name(
			preset.get("vae_name", DEFAULT_VAE_NAME),
			vae_models,
			visible_vae_name,
		)
		resolved_clip_type = resolve_clip_type(
			unet_name,
			resolved_clip_names,
			str(preset.get("clip_type", "stable_diffusion")),
		)
		return preset, resolved_clip_names, resolved_clip_type, resolved_vae_name

	def _generate_single_view(
		self,
		model,
		clip,
		vae,
		preset: dict[str, Any],
		main_image: torch.Tensor,
		view_prompt: str,
		negative_prompt: str,
		action_image: torch.Tensor | None,
		seed: int,
		lora_1_name: str,
		lora_1_strength: float,
		lora_2_name: str,
		lora_2_strength: float,
		unique_id: str | None = None,
	):
		target_width, target_height = _resolve_target_size_from_image(
			main_image,
			int(preset.get("main_long_edge", 1024)),
			int(preset.get("width", 1024)),
			int(preset.get("height", 1024)),
		)
		if bool(preset.get("supports_multi_image_edit")):
			if action_image is not None:
				is_skeleton, black_ratio = _is_skeleton_image(action_image)

				if is_skeleton:
					_send_status(unique_id, f"✅ 检测到骨架图（黑色占比 {black_ratio:.1%}），直接使用")
					action_ref_image_processed = action_image
				else:
					_send_status(unique_id, f"🔄 检测到RGB图（黑色占比 {black_ratio:.1%}），正在通过 GJJ_OpenPose 转换为骨架图...")
					try:
						from .gjj_openpose import GJJ_OpenPose
						opense_detector = GJJ_OpenPose()
						# 调用 OpenPose 节点生成骨架图
						action_ref_image_processed = opense_detector.estimate_pose(
							images=action_image,
							detect_hand="启用",
							detect_body="启用",
							detect_face="启用",
							resolution=512,
							xinsr_stick_scaling="禁用",
						)[0]
						_send_status(unique_id, "✅ 骨架图转换完成")
					except Exception as e:
						_send_status(unique_id, f"⚠️ OpenPose 转换失败：{e}，使用原始图像")
						action_ref_image_processed = action_image

				# 使用 TextEncodeQwenImageEditPlus 进行动作迁移编码
				from comfy_extras.nodes_qwen import TextEncodeQwenImageEditPlus
				_send_status(unique_id, "✅ 成功导入 TextEncodeQwenImageEditPlus")

				# 调试：查看原始图像形状
				_send_status(unique_id, f"🔍 主体图: {main_image.shape}, 动作图: {action_ref_image_processed.shape}")

				# 动作迁移使用固定提示词（与工作流一致）
				action_prompt = (
					"Preserve 100% of the subject's appearance, clothing, facial features, background, and environment from the first image. "
					"The only modification is to replicate the precise pose, standing position, arm gestures, and body orientation of the subject in the second image. "
					"No changes to the original subject, outfit, or background whatsoever. "
					"High-fidelity, photorealistic, sharp details, consistent lighting."
				)

				# 处理批量图像：遍历 batch 维度，逐张处理
				batch_size = main_image.shape[0] if main_image.ndim == 4 else 1
				_send_status(unique_id, f"🔍 批次大小: {batch_size}")

				if batch_size > 1:
					all_positive = []
					all_negative = []
					all_latents = []

					for i in range(batch_size):
						main_img = (main_image[i:i+1] if main_image.ndim == 4 else main_image.unsqueeze(0))[..., :3]
						action_img = (action_ref_image_processed[i:i+1] if action_ref_image_processed.ndim == 4 else action_ref_image_processed.unsqueeze(0))[..., :3]

						main_img_scaled = _kontext_scale_image(main_img)
						action_img_scaled = _kontext_scale_image(action_img)

						pos_result = TextEncodeQwenImageEditPlus.execute(
							clip=clip,
							prompt=action_prompt,
							vae=vae,
							image1=main_img_scaled,
							image2=action_img_scaled,
							image3=None
						)
						all_positive.append(pos_result[0])

						neg_result = TextEncodeQwenImageEditPlus.execute(
							clip=clip,
							prompt="",
							vae=vae,
							image1=main_img_scaled,
							image2=action_img_scaled,
							image3=None
						)
						all_negative.append(neg_result[0])

						latent_samples = vae.encode(action_img_scaled[:, :, :, :3])
						all_latents.append(latent_samples)

					positive = []
					for c in all_positive:
						positive.extend(c)
					negative = []
					for c in all_negative:
						negative.extend(c)
					latent_out_samples = torch.cat(all_latents, dim=0)
					latent_out = {"samples": latent_out_samples}
					_send_status(unique_id, f"✅ 批处理完成，共 {batch_size} 张图像")
				else:
					main_img = (main_image[0:1] if main_image.ndim == 4 else main_image.unsqueeze(0))[..., :3]
					action_img = (action_ref_image_processed[0:1] if action_ref_image_processed.ndim == 4 else action_ref_image_processed.unsqueeze(0))[..., :3]

					main_img_scaled = _kontext_scale_image(main_img)
					action_img_scaled = _kontext_scale_image(action_img)

					pos_result = TextEncodeQwenImageEditPlus.execute(
						clip=clip,
						prompt=action_prompt,
						vae=vae,
						image1=main_img_scaled,
						image2=action_img_scaled,
						image3=None
					)
					positive = pos_result[0]

					neg_result = TextEncodeQwenImageEditPlus.execute(
						clip=clip,
						prompt="",
						vae=vae,
						image1=main_img_scaled,
						image2=action_img_scaled,
						image3=None
					)
					negative = neg_result[0]

					latent_out_samples = vae.encode(action_img_scaled[:, :, :, :3])
					latent_out = {"samples": latent_out_samples}
					_send_status(unique_id, "✅ 使用 TextEncodeQwenImageEditPlus 编码动作迁移")
			else:
				pairs = [{"slot_index": 0, "image": main_image}]
				positive, negative, latent_out = _encode_multi_image_edit(
					clip=clip,
					vae=vae,
					prompt=view_prompt,
					negative_prompt=negative_prompt,
					main_image_index=1,
					pairs=pairs,
					main_mask=None,
					main_long_edge=int(preset.get("main_long_edge", 1024)),
					vl_long_edge=int(preset.get("vl_long_edge", 512)),
					target_width=target_width,
					target_height=target_height,
				)
		else:
			positive = self._encode_text_conditioning(clip, view_prompt)
			negative = self._encode_negative_conditioning(clip, positive, negative_prompt)
			latent_out = _build_latent(
				vae=vae,
				width=target_width,
				height=target_height,
				batch_size=1,
				image_pairs=[{"slot_index": 0, "image": main_image}],
				mask=None,
				grow_mask_by=0,
				preset=preset,
			)

		effective_steps = _resolve_effective_steps(
			int(preset.get("steps", 20)),
			preset,
			lora_1_name,
			lora_1_strength,
			lora_2_name,
			lora_2_strength,
		)
		sampler_name, scheduler = _resolve_native_sampler_scheduler(
			preset.get("sampler_name", "euler"),
			preset.get("scheduler", "simple"),
			unique_id,
		)
		_send_status(
			unique_id,
			f"采样参数：steps={effective_steps}, cfg={float(preset.get('cfg', 1.0)):g}, sampler={sampler_name}, scheduler={scheduler}",
		)
		sampled_latent = common_ksampler(
			model,
			int(seed),
			effective_steps,
			float(preset.get("cfg", 1.0)),
			sampler_name,
			scheduler,
			positive,
			negative,
			latent_out,
			denoise=float(preset.get("denoise", 1.0)),
		)[0]
		return VAEDecode().decode(vae, sampled_latent)[0]

	def generate(
		self,
		main_image,
		base_prompt,
		negative_prompt,
		action_prompts,
		unet_name,
		lora_1_name,
		lora_1_strength,
		lora_2_name,
		lora_2_strength,
		seed,
		save_each_image,
		prompt=None,
		extra_pnginfo=None,
		unique_id=None,
		**kwargs,
	):
		# 检测主图是否为批量输入（多维张量）
		main_image_batch = _split_image_batch(main_image) if main_image is not None else []
		is_batch_mode = len(main_image_batch) > 1

		# 如果是批量模式，对每张主图分别处理
		if is_batch_mode:
			_send_status(unique_id, f"检测到 {len(main_image_batch)} 张主图，启动批处理模式...")
			all_collages: list[torch.Tensor] = []
			all_batch_images: list[torch.Tensor] = []

			for batch_index, single_main_image in enumerate(main_image_batch, start=1):
				_send_status(unique_id, f"批处理 {batch_index}/{len(main_image_batch)}...")
				collage, batch_images = self._process_single_main(
					single_main_image,
					base_prompt,
					negative_prompt,
					action_prompts,
					unet_name,
					lora_1_name,
					lora_1_strength,
					lora_2_name,
					lora_2_strength,
					seed + batch_index - 1,
					save_each_image,
					prompt,
					extra_pnginfo,
					unique_id,
					**kwargs,
				)
				all_collages.append(collage)
				all_batch_images.append(batch_images)

			# 合并所有结果
			final_collage = torch.cat(all_collages, dim=0) if all_collages else all_collages[0]
			final_batch = torch.cat(all_batch_images, dim=0) if all_batch_images else all_batch_images[0]
			return (final_collage, final_batch)
		else:
			# 单图模式：原有逻辑
			return self._process_single_main(
				main_image,
				base_prompt,
				negative_prompt,
				action_prompts,
				unet_name,
				lora_1_name,
				lora_1_strength,
				lora_2_name,
				lora_2_strength,
				seed,
				save_each_image,
				prompt,
				extra_pnginfo,
				unique_id,
				**kwargs,
			)
	def _process_single_main(
		self,
		main_image,
		base_prompt,
		negative_prompt,
		action_prompts,
		unet_name,
		lora_1_name,
		lora_1_strength,
		lora_2_name,
		lora_2_strength,
		seed,
		save_each_image,
		prompt=None,
		extra_pnginfo=None,
		unique_id=None,
		**kwargs,
	):
		"""处理单张主图的多视图生成。"""
		total_steps = 6 if bool(save_each_image) else 5
		_send_status(unique_id, f"1/{total_steps} 检查模型配对并加载主链...")
		preset, resolved_clip_names, resolved_clip_type, resolved_vae_name = self._resolve_generation_bundle(
			unet_name,
			DEFAULT_CLIP_NAME,
			DEFAULT_VAE_NAME,
		)
		action_pairs = self._collect_action_pairs(kwargs)
		use_action_reference_mode = bool(action_pairs) and bool(preset.get("supports_multi_image_edit"))

		if use_action_reference_mode:
			lora_models = _safe_filename_list("loras")
			lora_1_name = _pick_available_lora_name(lora_models, ACTION_MIGRATION_LORA_1, ACTION_MIGRATION_LORA_1)
			lora_1_strength = ACTION_MIGRATION_LORA_1_STRENGTH
			lora_2_name = _pick_available_lora_name(lora_models, ACTION_MIGRATION_LORA_2, ACTION_MIGRATION_LORA_2)
			lora_2_strength = ACTION_MIGRATION_LORA_2_STRENGTH
			_send_status(unique_id, f"🔄 动作迁移模式：已切换 LoRA → {lora_1_name}（强度 {lora_1_strength}）+ {lora_2_name}（强度 {lora_2_strength}）")

		try:
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
				lora_1_name,
				lora_1_strength,
				lora_2_name,
				lora_2_strength,
				kwargs.get("lora_chain_config", ""),
			)
			model = _patch_model_sampling(
				model,
				str(preset.get("model_sampling", "")),
				float(preset.get("model_shift", 0.0)),
			)
			model = _apply_cfg_norm(model, float(preset.get("cfg_norm_strength", 0.0)))
		except Exception as exc:
			raise RuntimeError(
				"主体一键多视图节点加载模型失败。\n"
				f"UNET: {unet_name}\n"
				f"CLIP: {', '.join(resolved_clip_names)}\n"
				f"VAE: {resolved_vae_name}\n"
				f"详细错误：{exc}"
			) from exc

		action_lines = _parse_action_lines(action_prompts)
		action_keys = [k for k in kwargs.keys() if str(k).startswith("action_image_")]
		_send_status(unique_id, f"[DEBUG] 动作图接口: {action_keys} | kwargs 总数: {len(kwargs)}")
		if action_pairs:
			_send_status(unique_id, f"[DEBUG] ✅ 收到 {len(action_pairs)} 张动作图，切换到动作迁移！")
			action_lines = []
		else:
			_send_status(unique_id, "[DEBUG]  未收到动作图数据")
		raw_job_count = max(len(action_lines), len(action_pairs), 1)
		jobs = _build_action_jobs(action_lines, action_pairs)
		results: list[torch.Tensor] = []
		captions: list[str] = []

		if action_pairs and not bool(preset.get("supports_multi_image_edit")):
			_send_status(unique_id, "提示：当前底模不支持多图视觉参考，动作图将仅作为动作文本的辅助说明。")
		elif use_action_reference_mode:
			_send_status(unique_id, "提示：已切换到动作图驱动模式；动作文本不再参与姿态控制，已自动加载 FireRed 动作迁移 LoRA。")
		if len(jobs) < raw_job_count:
			_send_status(unique_id, f"提示：已自动去除 {raw_job_count - len(jobs)} 个重复视角。")

		effective_lora_2_name = lora_2_name
		effective_lora_2_strength = lora_2_strength

		total = len(jobs)
		for index, job in enumerate(jobs, start=1):
			view_prompt = _compose_view_prompt(
				base_prompt=base_prompt,
				action_text=job["text"],
				has_action_image=job["image"] is not None,
				index=job["index"],
			)
			# 根据当前模式显示不同的状态栏提示
			if job["image"] is not None:
				_send_status(unique_id, f" 动作迁移：生成第 {index}/{total} 张视图...")
			else:
				_send_status(unique_id, f"📝 文本描述：生成第 {index}/{total} 张视图...")
			try:
				result = self._generate_single_view(
					model=model,
					clip=clip,
					vae=vae,
					preset=preset,
					main_image=main_image,
					view_prompt=view_prompt,
					negative_prompt=negative_prompt,
					action_image=job["image"] if bool(preset.get("supports_multi_image_edit")) else None,
					seed=int(seed) + index - 1,
					lora_1_name=lora_1_name,
					lora_1_strength=lora_1_strength,
					lora_2_name=effective_lora_2_name,
					lora_2_strength=effective_lora_2_strength,
					unique_id=unique_id,
				)
			except Exception as exc:
				raise RuntimeError(
					f"主体一键多视图节点在生成第 {index} 张视图时失败。\n"
					f"动作描述：{job['text'] or '未填写，使用默认视角'}\n"
					f"详细错误：{exc}"
				) from exc
			results.append(result)

		captions = _resolve_job_captions(jobs)
		_send_status(unique_id, f"3/{total_steps} 计算最优拼图布局...")
		# 检测是否为4张图且使用了人物资产预设（通过检测动作文本中的关键词）
		is_character_asset = (
			len(results) == 4
			and any("人物资产" in str(job.get("text", "")) for job in jobs)
		)
		if is_character_asset:
			collage = _make_character_asset_collage(results, captions)
		else:
			collage = _make_squareish_collage(
				results,
				captions,
				target_aspect=_resolve_image_aspect(main_image, 1.0),
			)
		batch_images = torch.cat(results, dim=0) if results else collage
		saved_images: list[dict[str, str]] = []
		if bool(save_each_image) and len(batch_images) > 0:
			_send_status(unique_id, f"4/{total_steps} 正在保存每张单图...")
			filename_prefixes = [_resolve_job_filename_prefix(job) for job in jobs]
			saved_images = _save_multiview_batch_images(
				batch_images,
				filename_prefixes=filename_prefixes,
				prompt=prompt,
				extra_pnginfo=extra_pnginfo,
			)
		organize_step = 5 if bool(save_each_image) else 4
		_send_status(unique_id, f"{organize_step}/{total_steps} 整理最终多视图图板...")
		final_width = int(collage.shape[2])
		final_height = int(collage.shape[1])
		_send_status(unique_id, f"{total_steps}/{total_steps} 完成：{final_width} × {final_height}")
		return (collage, batch_images)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_CharacterMultiViewStudio}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 👤 主体一键多视图"}
