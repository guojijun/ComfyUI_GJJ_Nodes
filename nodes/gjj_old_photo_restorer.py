from __future__ import annotations

import math
from typing import Any

from comfy import model_management
import comfy.sd
import comfy.utils
import folder_paths
import torch
from nodes import VAEDecode, common_ksampler
from server import PromptServer

from .common_utils.text_tools import (
	gjjutils_normalize_text as _normalize_text,
	gjjutils_pick_available_name as _pick_available_name,
)
from .gjj_lazy_image_studio import (
	DEFAULT_UNET_DTYPE,
	DEFAULT_UNET_NAME,
	DEFAULT_VAE_NAME,
	_apply_cfg_norm,
	_load_clip_from_names,
	_load_model,
	_load_vae,
	_patch_model_sampling,
	_resize_to_long_edge,
	_safe_filename_list,
	list_clip_models,
	list_unet_models,
	list_vae_models,
)
from .common_utils.model_family import (
	gjjutils_model_family_match_preset as match_model_family,
	gjjutils_model_family_resolve_clip_type as resolve_clip_type,
	gjjutils_model_family_resolve_clip_names as resolve_clip_names_for_preset,
	MODEL_FAMILY_PRESETS,
	DEFAULT_VAE_NAME as MODEL_DEFAULT_VAE,
)
from .gjj_model_upscaler import _load_upscale_model, _list_upscale_models


NODE_NAME = "GJJ_OldPhotoRestorer"
DEFAULT_PROMPT = "Enhance image details for more realism."
DEFAULT_UNET = "qwen_image_edit_2511_fp8mixed.safetensors"
DEFAULT_CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
DEFAULT_VAE = "qwen_image_vae.safetensors"
DEFAULT_LORA_1 = "QWEN\\lighting\\Qwen-Image-Edit-Lightning-4steps-V1.0.safetensors"
DEFAULT_LORA_2 = "QWEN\\lighting\\Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors"
DEFAULT_STEPS = 8
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "simple"
DEFAULT_DENOISE = 1.0
DEFAULT_SHIFT = 3.1
DEFAULT_CFG_NORM = 1.0
DEFAULT_MEGAPIXELS = 1.0
DEFAULT_UPSCALE_MODEL = "1xSkinContrast-SuperUltraCompact.pth"


def _send_status(unique_id: Any, text: str) -> None:
	if not unique_id:
		return
	message = str(text or "")
	try:
		PromptServer.instance.send_sync(
			"gjj_node_progress",
			{"node": str(unique_id), "text": message},
		)
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


def _zero_out_conditioning(conditioning):
	result = []
	for item in conditioning:
		payload = dict(item[1] or {})
		pooled_output = payload.get("pooled_output")
		if pooled_output is not None:
			payload["pooled_output"] = torch.zeros_like(pooled_output)
		conditioning_lyrics = payload.get("conditioning_lyrics")
		if conditioning_lyrics is not None:
			payload["conditioning_lyrics"] = torch.zeros_like(conditioning_lyrics)
		result.append([torch.zeros_like(item[0]), payload])
	return result


def _allowed_unets() -> list[str]:
	models = list_unet_models() or [DEFAULT_UNET_NAME]
	allowed_keywords = (
		"qwen_image_edit_2511",
		"qwen_image_edit",
		"fireredimageedit",
		"realfire",
	)
	filtered = [
		name
		for name in models
		if any(keyword in _normalize_text(name) for keyword in allowed_keywords)
	]
	return filtered or models


def _resolve_basename_match(requested: str, available: list[str], fallback: str = "") -> str:
	return _pick_available_name(str(requested or "").strip(), available, str(fallback or "").strip())


def _require_lora_name(preferred: str, available: list[str], label: str) -> str:
	resolved = _resolve_basename_match(preferred, available, preferred)
	if not resolved:
		raise RuntimeError(f"未找到{label} LoRA：{preferred}")
	full_path = folder_paths.get_full_path("loras", resolved)
	if not full_path:
		raise RuntimeError(f"未找到{label} LoRA：{resolved}")
	return resolved


def _apply_model_only_lora(model, clip, lora_name: str, strength: float):
	if not str(lora_name or "").strip() or abs(float(strength)) <= 1e-6:
		return model, clip
	full_path = folder_paths.get_full_path("loras", lora_name)
	if not full_path:
		raise RuntimeError(f"未找到 LoRA 文件：{lora_name}")
	lora_state = comfy.utils.load_torch_file(full_path, safe_load=True)
	patched_model, patched_clip = comfy.sd.load_lora_for_models(
		model,
		clip,
		lora_state,
		float(strength),
		0.0,
	)
	if patched_model is None:
		raise RuntimeError(f"LoRA 已读取但未成功应用：{lora_name}")
	return patched_model, patched_clip or clip


def _scale_image_to_megapixels(image: torch.Tensor, megapixels: float = DEFAULT_MEGAPIXELS) -> torch.Tensor:
	if image is None:
		return image
	height = int(image.shape[1])
	width = int(image.shape[2])
	if height <= 0 or width <= 0:
		return image
	target_pixels = max(1.0, float(megapixels)) * 1_000_000.0
	current_pixels = float(height * width)
	if current_pixels <= 0:
		return image
	scale = math.sqrt(target_pixels / current_pixels)
	target_width = max(8, int(round(width * scale)))
	target_height = max(8, int(round(height * scale)))
	scaled = comfy.utils.common_upscale(
		image.movedim(-1, 1),
		target_width,
		target_height,
		"nearest-exact",
		"center",
	)
	return scaled.movedim(1, -1)


def _encode_qwen_edit_single_image(clip, vae, image: torch.Tensor, prompt: str, negative_prompt: str):
	samples = image.movedim(-1, 1)
	processed = _resize_to_long_edge(samples, 1024, "lanczos", "center")
	resized_height = int(processed.shape[2])
	resized_width = int(processed.shape[3])
	canvas_width = math.ceil(resized_width / 8.0) * 8
	canvas_height = math.ceil(resized_height / 8.0) * 8
	canvas = torch.zeros(
		(processed.shape[0], processed.shape[1], canvas_height, canvas_width),
		dtype=processed.dtype,
		device=processed.device,
	)
	canvas[:, :, :resized_height, :resized_width] = processed
	main_ref_image = canvas.movedim(1, -1)
	main_ref_latent = vae.encode(main_ref_image[:, :, :, :3])
	vl_tensor = _resize_to_long_edge(samples, 512, "bicubic", "center").movedim(1, -1)
	full_prompt = f"Picture 1: {str(prompt or '')}"
	tokens = clip.tokenize(full_prompt, images=[vl_tensor])
	conditioning = clip.encode_from_tokens_scheduled(tokens)
	positive = _conditioning_set_values(conditioning, {"reference_latents": [main_ref_latent]}, append=True)
	if str(negative_prompt or "").strip():
		negative = clip.encode_from_tokens_scheduled(clip.tokenize(str(negative_prompt or "")))
	else:
		negative = _zero_out_conditioning(positive)
	return positive, negative, {"samples": main_ref_latent}


def _upscale_image_with_model(image: torch.Tensor, upscale_model_name: str) -> torch.Tensor:
	if not str(upscale_model_name or "").strip():
		return image
	upscale_model = _load_upscale_model(upscale_model_name)
	device = model_management.get_torch_device()
	memory_required = model_management.module_size(upscale_model.model)
	memory_required += (512 * 512 * 3) * image.element_size() * max(upscale_model.scale, 1.0) * 384.0
	memory_required += image.nelement() * image.element_size()
	model_management.free_memory(memory_required, device)
	upscale_model.to(device)
	input_image = image.movedim(-1, -3).to(device)
	tile = 512
	overlap = 32
	try:
		while True:
			try:
				steps = input_image.shape[0] * comfy.utils.get_tiled_scale_steps(
					input_image.shape[3],
					input_image.shape[2],
					tile_x=tile,
					tile_y=tile,
					overlap=overlap,
				)
				progress = comfy.utils.ProgressBar(steps)
				scaled = comfy.utils.tiled_scale(
					input_image,
					lambda tensor: upscale_model(tensor),
					tile_x=tile,
					tile_y=tile,
					overlap=overlap,
					upscale_amount=upscale_model.scale,
					pbar=progress,
				)
				break
			except Exception as exc:
				model_management.raise_non_oom(exc)
				tile //= 2
				if tile < 128:
					raise exc
	finally:
		upscale_model.to("cpu")
	return torch.clamp(scaled.movedim(-3, -1), min=0.0, max=1.0)


class GJJ_OldPhotoRestorer:
	DESCRIPTION = "将 qwen_image_edit_2511 老照片修复工作流封装为单节点。前台只暴露输入图像、修复提示词、UNET 与种子，后台自动匹配 CLIP、VAE、双加速 LoRA，并显示中文进度。"

	@classmethod
	def INPUT_TYPES(cls):
		unet_models = _allowed_unets()
		upscale_models = _list_upscale_models()
		return {
			"required": {
				"image": ("IMAGE", {
					"display_name": "输入图像",
					"tooltip": "需要修复或增强的老照片图像。",
				}),
				"prompt": ("STRING", {
					"default": DEFAULT_PROMPT,
					"multiline": False,
					"display_name": "修复提示词",
					"tooltip": "用于指导老照片修复增强的提示词，默认沿用官方工作流。",
				}),
				"unet_name": (unet_models, {
					"default": _resolve_basename_match(DEFAULT_UNET, unet_models, DEFAULT_UNET),
					"display_name": "🟣 UNET 主模型",
					"tooltip": "主修复模型。默认使用 qwen_image_edit_2511 老照片工作流同款底模。",
				}),
				"seed": ("INT", {
					"default": 1091911236774418,
					"min": 0,
					"max": 0xFFFFFFFFFFFFFFFF,
					"display_name": "种子",
					"tooltip": "控制采样随机性的种子值。",
				}),
				"enable_upscale": ("BOOLEAN", {
					"default": True,
					"display_name": "启用放大",
					"tooltip": "开启后会在生成完成后接着用超分模型做一次图像增强。",
				}),
				"upscale_model_name": (upscale_models or [DEFAULT_UPSCALE_MODEL], {
					"default": _resolve_basename_match(DEFAULT_UPSCALE_MODEL, upscale_models, DEFAULT_UPSCALE_MODEL),
					"display_name": "放大模型",
					"tooltip": "用于结果图像增强的放大模型，默认使用 1xSkinContrast-SuperUltraCompact。",
				}),
			},
			"hidden": {
				"unique_id": "UNIQUE_ID",
			},
		}

	RETURN_TYPES = ("IMAGE",)
	RETURN_NAMES = ("修复增强图像",)
	OUTPUT_TOOLTIPS = ("老照片修复增强后的图像结果。",)
	FUNCTION = "restore"
	CATEGORY = "GJJ"

	def restore(self, image, prompt, unet_name, seed, enable_upscale, upscale_model_name, unique_id=None):
		try:
			_send_status(unique_id, "检查模型...")
			unet_models = _allowed_unets()
			clip_models = list_clip_models() or [DEFAULT_CLIP]
			vae_models = list_vae_models() or [DEFAULT_VAE]
			lora_models = _safe_filename_list("loras")
			upscale_models = _list_upscale_models()

			resolved_unet = _resolve_basename_match(unet_name, unet_models, DEFAULT_UNET)
			if not resolved_unet:
				raise RuntimeError(f"未找到 UNET 模型：{unet_name}")

			# 根据 UNET 名称匹配模型预设
			preset = match_model_family(resolved_unet)
			
			# 根据预设自动匹配 CLIP 和 VAE
			resolved_clip_names = resolve_clip_names_for_preset(
				preset, 
				clip_models, 
				exposed_clip_name="",
				legacy_clip_names=[]
			)
			if not resolved_clip_names:
				# 如果预设匹配失败，回退到默认配置
				resolved_clip_names = [_pick_available_name(DEFAULT_CLIP, clip_models, DEFAULT_CLIP)]
			
			resolved_vae_name = _pick_available_name(
				preset.get("vae_name", DEFAULT_VAE),
				vae_models,
				DEFAULT_VAE
			)
			
			resolved_clip_type = resolve_clip_type(
				resolved_unet,
				resolved_clip_names,
				str(preset.get("clip_type", "qwen_image"))
			)

			resolved_lora_1 = _require_lora_name(DEFAULT_LORA_1, lora_models, "加速")
			resolved_lora_2 = _require_lora_name(DEFAULT_LORA_2, lora_models, "增强")
			resolved_upscale = _resolve_basename_match(upscale_model_name, upscale_models, DEFAULT_UPSCALE_MODEL) if bool(enable_upscale) else ""
			if bool(enable_upscale) and not resolved_upscale:
				raise RuntimeError(f"未找到放大模型：{upscale_model_name or DEFAULT_UPSCALE_MODEL}")

			_send_status(unique_id, "加载 UNET / CLIP / VAE...")
			model = _load_model(resolved_unet, DEFAULT_UNET_DTYPE)
			clip = _load_clip_from_names(resolved_clip_names, resolved_clip_type)
			vae = _load_vae(resolved_vae_name)

			_send_status(unique_id, "应用 LoRA...")
			model, clip = _apply_model_only_lora(model, clip, resolved_lora_1, 1.0)
			model, clip = _apply_model_only_lora(model, clip, resolved_lora_2, 1.0)
			model = _patch_model_sampling(model, "aura", DEFAULT_SHIFT)
			model = _apply_cfg_norm(model, DEFAULT_CFG_NORM)

			_send_status(unique_id, "预处理图像...")
			scaled_image = _scale_image_to_megapixels(image, DEFAULT_MEGAPIXELS)

			_send_status(unique_id, "编码条件...")
			positive, negative, latent = _encode_qwen_edit_single_image(
				clip,
				vae,
				scaled_image,
				str(prompt or DEFAULT_PROMPT),
				"",
			)

			_send_status(unique_id, "采样生成...")
			sampled = common_ksampler(
				model,
				int(seed),
				DEFAULT_STEPS,
				float(DEFAULT_CFG),
				DEFAULT_SAMPLER,
				DEFAULT_SCHEDULER,
				positive,
				negative,
				latent,
				denoise=float(DEFAULT_DENOISE),
			)[0]

			_send_status(unique_id, "解码图像...")
			result = VAEDecode().decode(vae, sampled)[0]
			if bool(enable_upscale) and resolved_upscale:
				_send_status(unique_id, f"模型放大：{resolved_upscale}")
				result = _upscale_image_with_model(result, resolved_upscale)
			width = int(result.shape[2]) if result is not None and result.ndim >= 3 else 0
			height = int(result.shape[1]) if result is not None and result.ndim >= 3 else 0
			_send_status(unique_id, f"完成：{width} × {height}")
			return (result,)
		except Exception as exc:
			raise RuntimeError(
				"老照片修复增强节点执行失败。\n"
				f"UNET：{unet_name}\n"
				f"详细错误：{exc}"
			) from exc


NODE_CLASS_MAPPINGS = {
	NODE_NAME: GJJ_OldPhotoRestorer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
	NODE_NAME: "GJJ · 🕰️ 老照片修复增强器",
}
