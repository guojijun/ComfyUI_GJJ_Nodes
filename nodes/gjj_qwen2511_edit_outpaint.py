from __future__ import annotations

from typing import Any

import comfy.controlnet
import comfy.sd
import comfy.utils
import folder_paths
import nodes
import torch
import torch.nn.functional as F
from .common_utils.mask_tools import GrowMask
from nodes import ImagePadForOutpaint, common_ksampler
from server import PromptServer

from .common_utils.text_tools import (
	gjjutils_normalize_text as _normalize_text,
	gjjutils_pick_available_name as _pick_available_name,
)
from .gjj_lazy_image_studio import (
	DEFAULT_UNET_DTYPE,
	_apply_cfg_norm,
	_load_clip_from_names,
	_load_model,
	_load_vae,
	_patch_model_sampling,
	_pick_available_lora_name,
	_safe_filename_list,
	list_clip_models,
	list_unet_models,
)
from .common_utils.model_family import (
	gjjutils_model_family_match_preset as match_model_family,
	gjjutils_model_family_resolve_clip_type as resolve_clip_type,
	gjjutils_model_family_resolve_clip_names as resolve_clip_names_for_preset,
	MODEL_FAMILY_PRESETS,
	DEFAULT_VAE_NAME as MODEL_DEFAULT_VAE,
)
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE
from .gjj_model_family_preset_table import load_model_family_presets, match_model_family_preset
from .gjj_multi_image_loader import (
	MAX_OUTPUT_IMAGES,
	build_uniform_batch,
	empty_image_tensor,
	load_image_tensor,
	parse_selected_images,
	resolve_input_image_path,
)


NODE_NAME = "GJJ_Qwen2511EditOutpaint"
DEFAULT_UNET = "qwen_image_fp8_e4m3fn.safetensors"
DEFAULT_CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
DEFAULT_VAE = "qwen_image_vae.safetensors"
DEFAULT_CONTROLNET = "Qwen-Image-InstantX-ControlNet-Inpainting.safetensors"
DEFAULT_LORA = "QWEN\\lighting\\Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors"
DEFAULT_OPTIONAL_LORA = "QWEN\\qwen-edit-remove-clothes_NSFW.safetensors"
DEFAULT_PROMPT = "按原图风格扩充，不要添加边框"
DEFAULT_FLUX_FILL_PROMPT = "A futuristic city under a glass shell in the center of the desert."
DEFAULT_FLUX_FILL_NEGATIVE = ""
DEFAULT_LEFT = 0
DEFAULT_TOP = 0
DEFAULT_RIGHT = 400
DEFAULT_BOTTOM = 0
DEFAULT_FEATHERING = 16
DEFAULT_FLUX_FILL_FEATHERING = 24
DEFAULT_LAYOUT_MODE = "按目标尺寸扩图"
DEFAULT_TARGET_WIDTH = 1344
DEFAULT_TARGET_HEIGHT = 1344
DEFAULT_EXPAND_METHOD = "按宽度占比"
DEFAULT_ORIGINAL_RATIO = 0.72
DEFAULT_EXPAND_DIRECTION = "居中四向扩展"
DEFAULT_LARGEST_SIZE = 1536
DEFAULT_MASK_GROW = 20
DEFAULT_MASK_BLUR = 31
DEFAULT_MASK_SIGMA = 1.0
DEFAULT_STEPS = 4
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "simple"
DEFAULT_DENOISE = 1.0
DEFAULT_SHIFT = 3.1
DEFAULT_FLUX_GUIDANCE = 30.0
DEFAULT_FLUX_FILL_STEPS = 20
DEFAULT_FLUX_FILL_CFG = 1.0
DEFAULT_FLUX_FILL_SAMPLER = "euler"
DEFAULT_FLUX_FILL_SCHEDULER = "normal"
DEFAULT_FLUX_FILL_DENOISE = 1.0
DEFAULT_FLUX_FILL_DIFF_STRENGTH = 1.0
ALLOWED_UNET_KEYWORDS = ("flux1-fill-dev", "qwen_image_fp")
LAYOUT_MODE_OPTIONS = ("按目标尺寸扩图", "按四边像素扩图")
EXPAND_METHOD_OPTIONS = ("按宽度占比", "按高度占比", "按最长边占比")
EXPAND_DIRECTION_OPTIONS = (
	"居中四向扩展",
	"向右扩展",
	"向左扩展",
	"向下扩展",
	"向上扩展",
	"向右下扩展",
	"向右上扩展",
	"向左下扩展",
	"向左上扩展",
)


def _send_status(unique_id: Any, text: str) -> None:
	if not unique_id:
		return
	try:
		PromptServer.instance.send_sync("gjj_node_progress", {"node": str(unique_id), "text": str(text or "")})
	except Exception:
		pass


def _encode_text(clip, text: str):
	return clip.encode_from_tokens_scheduled(clip.tokenize(str(text or "")))


def _conditioning_set_values(conditioning, values: dict[str, Any]):
	result = []
	for item in conditioning:
		payload = item[1].copy()
		payload.update(values)
		result.append([item[0], payload])
	return result


def _apply_flux_guidance(conditioning, guidance: float):
	return _conditioning_set_values(conditioning, {"guidance": float(guidance)})


def _resolve_name(preferred: str, available: list[str], fallback: str = "") -> str:
	return _pick_available_name(str(preferred or "").strip(), available, str(fallback or "").strip())


def _require_category_name(category: str, preferred: str, label: str) -> str:
	available = _safe_filename_list(category)
	resolved = _resolve_name(preferred, available, preferred)
	if not resolved:
		raise RuntimeError(f"未找到{label}模型：{preferred}")
	full_path = folder_paths.get_full_path(category, resolved)
	if not full_path:
		raise RuntimeError(f"未找到{label}模型：{resolved}")
	return resolved


def _resolve_optional_lora_name(preferred: str, available: list[str]) -> str:
	query = _normalize_text(preferred)
	if not query:
		return ""
	for name in available:
		if query in _normalize_text(name):
			if folder_paths.get_full_path("loras", name):
				return name
	return ""


def _allowed_unets() -> list[str]:
	models = list_unet_models() or [DEFAULT_UNET]
	filtered = []
	for name in models:
		normalized = _normalize_text(name)
		if any(_normalize_text(keyword) in normalized for keyword in ALLOWED_UNET_KEYWORDS):
			filtered.append(name)
	return filtered or models


def _resolve_model_bundle(unet_name: str) -> dict[str, Any]:
	preset = match_model_family(unet_name)
	clip_models = list_clip_models() or [DEFAULT_CLIP]
	clip_names = resolve_clip_names_for_preset(preset, clip_models, "", [])
	clip_type = resolve_clip_type(unet_name, clip_names, str(preset.get("clip_type") or "stable_diffusion"))
	preset_id = str(preset.get("id") or "")
	normalized_name = _normalize_text(unet_name)
	if clip_type == "qwen_image":
		route = "qwen"
	elif preset_id == "flux1_fill_dev" or "filldev" in normalized_name:
		route = "flux_fill"
	else:
		route = "generic"
	default_lora_1 = DEFAULT_LORA if clip_type == "qwen_image" else ""
	default_lora_2 = DEFAULT_OPTIONAL_LORA if clip_type == "qwen_image" else ""
	return {
		"preset_id": preset_id,
		"route": route,
		"clip_type": clip_type,
		"clip_names": clip_names or [DEFAULT_CLIP],
		"vae_name": str(preset.get("vae_name") or DEFAULT_VAE),
		"lora_1_name": str(preset.get("lora_1_name") or default_lora_1),
		"lora_1_strength": float(preset.get("lora_1_strength") or 0.0),
		"lora_2_name": str(preset.get("lora_2_name") or default_lora_2),
		"lora_2_strength": float(preset.get("lora_2_strength") or 0.0),
		"steps": int(preset.get("steps") or DEFAULT_STEPS),
		"cfg": float(preset.get("cfg") or DEFAULT_CFG),
		"sampler": str(preset.get("sampler_name") or DEFAULT_SAMPLER),
		"scheduler": str(preset.get("scheduler") or DEFAULT_SCHEDULER),
		"denoise": float(preset.get("denoise") or DEFAULT_DENOISE),
		"model_sampling": str(preset.get("model_sampling") or ""),
		"model_shift": float(preset.get("model_shift") or 0.0),
		"cfg_norm_strength": float(preset.get("cfg_norm_strength") or 0.0),
		"guidance": float(DEFAULT_FLUX_GUIDANCE if route == "flux_fill" else 0.0),
	}


def _apply_model_only_lora(model, clip, lora_name: str, strength: float):
	if not str(lora_name or "").strip() or abs(float(strength)) <= 1e-6:
		return model, clip
	full_path = folder_paths.get_full_path("loras", lora_name)
	if not full_path:
		raise RuntimeError(f"未找到 LoRA 文件：{lora_name}")
	lora_state = comfy.utils.load_torch_file(full_path, safe_load=True)
	patched_model, patched_clip = comfy.sd.load_lora_for_models(model, clip, lora_state, float(strength), float(strength))
	if patched_model is None:
		raise RuntimeError(f"LoRA 已读取但未成功应用：{lora_name}")
	return patched_model, patched_clip or clip


def _ensure_mask_bhw(mask: torch.Tensor | None) -> torch.Tensor | None:
	if mask is None:
		return None
	if mask.ndim == 2:
		return mask.unsqueeze(0)
	if mask.ndim == 3:
		return mask
	if mask.ndim == 4:
		return mask[:, 0, :, :]
	raise RuntimeError(f"不支持的遮罩维度：{tuple(mask.shape)}")


def _scale_image_to_max_dimension(image: torch.Tensor, largest_size: int, upscale_method: str) -> torch.Tensor:
	height = int(image.shape[1])
	width = int(image.shape[2])
	if height > width:
		width = round((width / height) * int(largest_size))
		height = int(largest_size)
	elif width > height:
		height = round((height / width) * int(largest_size))
		width = int(largest_size)
	else:
		height = int(largest_size)
		width = int(largest_size)
	samples = image.movedim(-1, 1)
	scaled = comfy.utils.common_upscale(samples, width, height, upscale_method, "disabled")
	return scaled.movedim(1, -1)


def _scale_mask_to_max_dimension(mask: torch.Tensor, largest_size: int, upscale_method: str) -> torch.Tensor:
	mask = _ensure_mask_bhw(mask)
	height = int(mask.shape[-2])
	width = int(mask.shape[-1])
	if height > width:
		width = round((width / height) * int(largest_size))
		height = int(largest_size)
	elif width > height:
		height = round((height / width) * int(largest_size))
		width = int(largest_size)
	else:
		height = int(largest_size)
		width = int(largest_size)
	mask_image = mask.unsqueeze(1)
	scaled = comfy.utils.common_upscale(mask_image, width, height, upscale_method, "disabled")
	return scaled[:, 0, :, :]


def _gaussian_kernel(kernel_size: int, sigma: float, device) -> torch.Tensor:
	x = torch.linspace(-sigma, sigma, kernel_size, device=device)
	gaussian_1d = torch.exp(-(x ** 2) / (2 * sigma ** 2))
	gaussian_1d = gaussian_1d / gaussian_1d.sum()
	gaussian_2d = gaussian_1d[:, None] * gaussian_1d[None, :]
	gaussian_2d = gaussian_2d / gaussian_2d.sum()
	return gaussian_2d.unsqueeze(0).unsqueeze(0)


def _blur_mask(mask: torch.Tensor, blur_radius: int, sigma: float) -> torch.Tensor:
	mask = _ensure_mask_bhw(mask)
	if int(blur_radius) <= 0:
		return mask
	kernel_size = int(blur_radius) * 2 + 1
	kernel = _gaussian_kernel(kernel_size, float(sigma), mask.device)
	image = mask.unsqueeze(1)
	padded = F.pad(image, (int(blur_radius), int(blur_radius), int(blur_radius), int(blur_radius)), mode="reflect")
	blurred = F.conv2d(padded, kernel, padding=kernel_size // 2, groups=1)[:, :, int(blur_radius):-int(blur_radius), int(blur_radius):-int(blur_radius)]
	return blurred[:, 0, :, :].clamp(0.0, 1.0)


def _grow_and_blur_mask(mask: torch.Tensor) -> torch.Tensor:
	grown = GrowMask().expand_mask(_ensure_mask_bhw(mask), int(DEFAULT_MASK_GROW), True)[0]
	return _blur_mask(grown, int(DEFAULT_MASK_BLUR), float(DEFAULT_MASK_SIGMA))


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


def _apply_qwen_inpaint_controlnet(positive, negative, control_net, vae, image, mask):
	extra_concat = []
	if getattr(control_net, "concat_mask", False):
		mask_tensor = 1.0 - mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1]))
		mask_apply = comfy.utils.common_upscale(mask_tensor, image.shape[2], image.shape[1], "bilinear", "center").round()
		image = image * mask_apply.movedim(1, -1).repeat(1, 1, 1, image.shape[3])
		extra_concat = [mask_tensor]
	return nodes.ControlNetApplyAdvanced().apply_controlnet(
		positive,
		negative,
		control_net,
		image,
		1.0,
		0.0,
		1.0,
		vae=vae,
		extra_concat=extra_concat,
	)


def _resize_image_exact(image: torch.Tensor, width: int, height: int, upscale_method: str = "lanczos") -> torch.Tensor:
	width = max(1, int(width))
	height = max(1, int(height))
	samples = image.movedim(-1, 1)
	scaled = comfy.utils.common_upscale(samples, width, height, upscale_method, "disabled")
	return scaled.movedim(1, -1)


def _compute_target_layout(
	source_width: int,
	source_height: int,
	target_width: int,
	target_height: int,
	expand_method: str,
	original_ratio: float,
	expand_direction: str,
) -> tuple[int, int, int, int, int, int]:
	target_width = max(64, int(target_width))
	target_height = max(64, int(target_height))
	source_width = max(1, int(source_width))
	source_height = max(1, int(source_height))
	ratio = max(0.1, min(1.0, float(original_ratio)))

	if expand_method == "按高度占比":
		scale = (target_height * ratio) / float(source_height)
	elif expand_method == "按最长边占比":
		target_long = max(target_width, target_height)
		source_long = max(source_width, source_height)
		scale = (target_long * ratio) / float(source_long)
	else:
		scale = (target_width * ratio) / float(source_width)

	scale = min(scale, target_width / float(source_width), target_height / float(source_height))
	scaled_width = max(1, min(target_width, int(round(source_width * scale))))
	scaled_height = max(1, min(target_height, int(round(source_height * scale))))

	available_x = max(0, target_width - scaled_width)
	available_y = max(0, target_height - scaled_height)

	def center_pair(total: int) -> tuple[int, int]:
		first = total // 2
		return first, total - first

	if expand_direction == "向右扩展":
		left, right = 0, available_x
		top, bottom = center_pair(available_y)
	elif expand_direction == "向左扩展":
		left, right = available_x, 0
		top, bottom = center_pair(available_y)
	elif expand_direction == "向下扩展":
		left, right = center_pair(available_x)
		top, bottom = 0, available_y
	elif expand_direction == "向上扩展":
		left, right = center_pair(available_x)
		top, bottom = available_y, 0
	elif expand_direction == "向右下扩展":
		left, right = 0, available_x
		top, bottom = 0, available_y
	elif expand_direction == "向右上扩展":
		left, right = 0, available_x
		top, bottom = available_y, 0
	elif expand_direction == "向左下扩展":
		left, right = available_x, 0
		top, bottom = 0, available_y
	elif expand_direction == "向左上扩展":
		left, right = available_x, 0
		top, bottom = available_y, 0
	else:
		left, right = center_pair(available_x)
		top, bottom = center_pair(available_y)

	return scaled_width, scaled_height, left, top, right, bottom


def _compute_target_padding_keep_scale(
	source_width: int,
	source_height: int,
	target_width: int,
	target_height: int,
	expand_direction: str,
) -> tuple[int, int, int, int]:
	target_width = max(int(source_width), int(target_width))
	target_height = max(int(source_height), int(target_height))
	source_width = max(1, int(source_width))
	source_height = max(1, int(source_height))

	available_x = max(0, target_width - source_width)
	available_y = max(0, target_height - source_height)

	def center_pair(total: int) -> tuple[int, int]:
		first = total // 2
		return first, total - first

	if expand_direction == "向右扩展":
		left, right = 0, available_x
		top, bottom = center_pair(available_y)
	elif expand_direction == "向左扩展":
		left, right = available_x, 0
		top, bottom = center_pair(available_y)
	elif expand_direction == "向下扩展":
		left, right = center_pair(available_x)
		top, bottom = 0, available_y
	elif expand_direction == "向上扩展":
		left, right = center_pair(available_x)
		top, bottom = available_y, 0
	elif expand_direction == "向右下扩展":
		left, right = 0, available_x
		top, bottom = 0, available_y
	elif expand_direction == "向右上扩展":
		left, right = 0, available_x
		top, bottom = available_y, 0
	elif expand_direction == "向左下扩展":
		left, right = available_x, 0
		top, bottom = 0, available_y
	elif expand_direction == "向左上扩展":
		left, right = available_x, 0
		top, bottom = available_y, 0
	else:
		left, right = center_pair(available_x)
		top, bottom = center_pair(available_y)

	return left, top, right, bottom


def _ensure_image_batch(image: torch.Tensor) -> torch.Tensor:
	if not isinstance(image, torch.Tensor):
		raise RuntimeError("输入图片不能为空。")
	if image.ndim == 3:
		return image.unsqueeze(0).contiguous()
	if image.ndim == 4:
		return image.contiguous()
	raise RuntimeError(f"不支持的图片维度：{tuple(getattr(image, 'shape', ())) or type(image)}")


def _resolve_prompt_node(prompt_graph: Any, node_id: Any) -> dict[str, Any] | None:
	if not isinstance(prompt_graph, dict):
		return None
	text_id = str(node_id or "").strip()
	if text_id and isinstance(prompt_graph.get(text_id), dict):
		return prompt_graph[text_id]
	if node_id in prompt_graph and isinstance(prompt_graph[node_id], dict):
		return prompt_graph[node_id]
	return None


def _recover_multi_image_loader_inputs(prompt_graph: Any, unique_id: Any) -> list[torch.Tensor]:
	current_node = _resolve_prompt_node(prompt_graph, unique_id)
	if not isinstance(current_node, dict):
		return []
	current_inputs = current_node.get("inputs", {})
	image_ref = current_inputs.get("image")
	if not isinstance(image_ref, (list, tuple)) or len(image_ref) < 2:
		return []
	try:
		output_index = int(image_ref[1])
	except Exception:
		return []
	if output_index != 0:
		return []

	upstream_node = _resolve_prompt_node(prompt_graph, image_ref[0])
	if not isinstance(upstream_node, dict):
		return []
	if str(upstream_node.get("class_type") or "") != "GJJ_MultiImageLoader":
		return []

	upstream_inputs = upstream_node.get("inputs", {})
	if isinstance(upstream_inputs.get("input_images"), (list, tuple)):
		return []

	selected_images = parse_selected_images(upstream_inputs.get("selected_images"))
	if not selected_images:
		return []

	recovered: list[torch.Tensor] = []
	for entry in selected_images:
		try:
			recovered.append(load_image_tensor(resolve_input_image_path(entry)))
		except Exception:
			return []
	return recovered


def _split_input_images(image: torch.Tensor, prompt_graph: Any, unique_id: Any) -> tuple[list[torch.Tensor], str]:
	batch = _ensure_image_batch(image)
	recovered = _recover_multi_image_loader_inputs(prompt_graph, unique_id)
	if recovered:
		return recovered, "multi_image_loader_batch"
	return [batch[index:index + 1].contiguous() for index in range(int(batch.shape[0]))], "image_batch"


def _merge_output_images(images: list[torch.Tensor]) -> tuple[torch.Tensor, bool]:
	if not images:
		raise RuntimeError("没有可输出的结果图像。")
	normalized = [_ensure_image_batch(image) for image in images]
	size_set = {(int(image.shape[2]), int(image.shape[1])) for image in normalized}
	if len(size_set) == 1:
		return torch.cat(normalized, dim=0), False
	return build_uniform_batch(normalized), True


def _process_outpaint_image(
	image: torch.Tensor,
	prompt: str,
	bundle: dict[str, Any],
	model,
	clip,
	vae,
	control_net,
	layout_mode: str,
	target_width: int,
	target_height: int,
	expand_method: str,
	original_ratio: float,
	expand_direction: str,
	left: int,
	top: int,
	right: int,
	bottom: int,
	feathering: int,
	seed: int,
	unique_id: Any = None,
	status_suffix: str = "",
) -> torch.Tensor:
	working_image = _ensure_image_batch(image)

	_send_status(unique_id, f"4/8 计算扩图画布{status_suffix}...")
	if str(layout_mode or DEFAULT_LAYOUT_MODE) == "按目标尺寸扩图":
		source_height = int(working_image.shape[1])
		source_width = int(working_image.shape[2])
		scaled_width, scaled_height, left, top, right, bottom = _compute_target_layout(
			source_width,
			source_height,
			int(target_width),
			int(target_height),
			str(expand_method or DEFAULT_EXPAND_METHOD),
			float(original_ratio),
			str(expand_direction or DEFAULT_EXPAND_DIRECTION),
		)
		working_image = _resize_image_exact(working_image, scaled_width, scaled_height)

	left = int(left)
	top = int(top)
	right = int(right)
	bottom = int(bottom)

	feather_value = int(feathering)
	if bundle["route"] == "flux_fill" and feather_value <= 0:
		feather_value = DEFAULT_FLUX_FILL_FEATHERING

	_send_status(unique_id, f"5/8 扩边并生成遮罩{status_suffix}...")
	padded_image, raw_mask = ImagePadForOutpaint().expand_image(
		working_image,
		left,
		top,
		right,
		bottom,
		feather_value,
	)

	_send_status(unique_id, f"6/8 编码并构建采样条件{status_suffix}...")
	if bundle["route"] == "qwen":
		scaled_image = _scale_image_to_max_dimension(padded_image, DEFAULT_LARGEST_SIZE, "area")
		scaled_mask = _scale_mask_to_max_dimension(raw_mask, DEFAULT_LARGEST_SIZE, "area")
		processed_mask = _grow_and_blur_mask(scaled_mask)
		positive = _encode_text(clip, str(prompt or ""))
		negative = _encode_text(clip, "")
		positive, negative = _apply_qwen_inpaint_controlnet(
			positive,
			negative,
			control_net,
			vae,
			scaled_image,
			processed_mask,
		)
		latent = nodes.VAEEncode().encode(vae, scaled_image)[0]
		latent = nodes.SetLatentNoiseMask().set_mask(latent, processed_mask)[0]
		working_model = model
	else:
		positive_prompt_text = str(prompt or "").strip()
		if bundle["route"] == "flux_fill":
			positive_prompt_text = positive_prompt_text or DEFAULT_FLUX_FILL_PROMPT
		positive = _encode_text(clip, positive_prompt_text)
		negative = _encode_text(clip, DEFAULT_FLUX_FILL_NEGATIVE if bundle["route"] == "flux_fill" else "")
		if bundle["route"] == "flux_fill" and bundle["guidance"] > 0:
			positive = _apply_flux_guidance(positive, bundle["guidance"])
		positive, negative, latent = nodes.InpaintModelConditioning().encode(
			positive,
			negative,
			padded_image,
			vae,
			raw_mask,
			noise_mask=False,
		)
		working_model = _apply_differential_diffusion(model, DEFAULT_FLUX_FILL_DIFF_STRENGTH) if bundle["route"] == "flux_fill" else model

	_send_status(unique_id, f"7/8 采样中{status_suffix}...")
	sampled = common_ksampler(
		working_model,
		int(seed),
		bundle["steps"],
		bundle["cfg"],
		bundle["sampler"],
		bundle["scheduler"],
		positive,
		negative,
		latent,
		denoise=bundle["denoise"],
	)[0]

	_send_status(unique_id, f"8/8 解码结果图像{status_suffix}...")
	result = nodes.VAEDecode().decode(vae, sampled)[0]
	final_width = int(padded_image.shape[2])
	final_height = int(padded_image.shape[1])
	if int(result.shape[2]) != final_width or int(result.shape[1]) != final_height:
		result = _resize_image_exact(result, final_width, final_height)
	return result


class GJJ_Qwen2511EditOutpaint:
	DESCRIPTION = "通用外扩图片填充编辑器。默认使用 GJJ 专用批量图片口；接入 GJJ 多图片加载预览器 的“批量图片”输出时会优先按原始选图逐张外扩。普通 IMAGE 如需接入，请先经过批量图片包装器。默认按目标尺寸、原图占比和扩图方向自动计算扩边，也可切回传统四边像素扩图。节点会根据预设表自动匹配 UNET 对应的 CLIP、VAE、LoRA 与采样参数，并按模型族分流到 Qwen 外扩链、Flux Fill 外扩链或通用 Inpaint 外扩链。"

	@classmethod
	def INPUT_TYPES(cls):
		unet_models = _allowed_unets()
		return {
			"required": {
				"image": (GJJ_BATCH_IMAGE_TYPE, {
					"display_name": "批量图片",
					"tooltip": "默认对接 GJJ 多图片加载预览器 的“批量图片”输出，作为 GJJ 专用批量图片口使用；普通 IMAGE 如需接入，请先经过批量图片包装器。",
				}),
				"prompt": ("STRING", {
					"default": DEFAULT_PROMPT,
					"multiline": False,
					"display_name": "编辑提示词",
					"tooltip": "扩图提示词。留空时按工作流默认方式仅根据图像内容进行外扩。",
				}),
				"unet_name": (unet_models, {
					"default": _resolve_name(DEFAULT_UNET, unet_models, DEFAULT_UNET),
					"display_name": "🟣 UNET 主模型",
					"tooltip": "外扩主模型；会根据预设表自动匹配 CLIP、VAE、LoRA 和默认采样参数。",
				}),
				"layout_mode": (LAYOUT_MODE_OPTIONS, {
					"default": DEFAULT_LAYOUT_MODE,
					"display_name": "扩图方案",
					"tooltip": "默认按目标尺寸自动计算扩边；也可切换回传统四边像素扩图。",
				}),
				"target_width": ("INT", {
					"default": DEFAULT_TARGET_WIDTH,
					"min": 64,
					"max": 8192,
					"step": 8,
					"display_name": "目标宽度",
					"tooltip": "在“按目标尺寸扩图”模式下，最终希望得到的成品宽度。",
				}),
				"target_height": ("INT", {
					"default": DEFAULT_TARGET_HEIGHT,
					"min": 64,
					"max": 8192,
					"step": 8,
					"display_name": "目标高度",
					"tooltip": "在“按目标尺寸扩图”模式下，最终希望得到的成品高度。",
				}),
				"expand_method": (EXPAND_METHOD_OPTIONS, {
					"default": DEFAULT_EXPAND_METHOD,
					"display_name": "扩图方式",
					"tooltip": "原图占比是按宽度、高度还是最长边来计算。",
				}),
				"original_ratio": ("FLOAT", {
					"default": DEFAULT_ORIGINAL_RATIO,
					"min": 0.1,
					"max": 1.0,
					"step": 0.01,
					"display_name": "原图占比",
					"tooltip": "原图在最终成品中的占比，数值越小，留给扩图区域的空间越大。",
				}),
				"expand_direction": (EXPAND_DIRECTION_OPTIONS, {
					"default": DEFAULT_EXPAND_DIRECTION,
					"display_name": "扩图方向",
					"tooltip": "在按目标尺寸扩图时，决定原图停留位置以及新扩展区域出现的方向。",
				}),
				"left": ("INT", {
					"default": DEFAULT_LEFT,
					"min": 0,
					"max": 8192,
					"step": 8,
					"display_name": "左扩",
					"tooltip": "向左扩展的像素值。",
				}),
				"top": ("INT", {
					"default": DEFAULT_TOP,
					"min": 0,
					"max": 8192,
					"step": 8,
					"display_name": "上扩",
					"tooltip": "向上扩展的像素值。",
				}),
				"right": ("INT", {
					"default": DEFAULT_RIGHT,
					"min": 0,
					"max": 8192,
					"step": 8,
					"display_name": "右扩",
					"tooltip": "向右扩展的像素值。",
				}),
				"bottom": ("INT", {
					"default": DEFAULT_BOTTOM,
					"min": 0,
					"max": 8192,
					"step": 8,
					"display_name": "下扩",
					"tooltip": "向下扩展的像素值。",
				}),
				"feathering": ("INT", {
					"default": DEFAULT_FEATHERING,
					"min": 0,
					"max": 1024,
					"step": 1,
					"display_name": "羽化",
					"tooltip": f"原始扩边遮罩羽化值。当前默认值为 {DEFAULT_FEATHERING}。",
				}),
				"seed": ("INT", {
					"default": 326477531988575,
					"min": 0,
					"max": 0xFFFFFFFFFFFFFFFF,
					"control_after_generate": True,
					"display_name": "种子",
					"tooltip": "采样随机种子。默认值对齐工作流。",
				}),
			},
			"hidden": {
				"prompt_graph": "PROMPT",
				"unique_id": "UNIQUE_ID",
			},
		}

	RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE",) + tuple("IMAGE" for _ in range(MAX_OUTPUT_IMAGES))
	RETURN_NAMES = ("批量图片",) + tuple(f"输入 {index}" for index in range(1, MAX_OUTPUT_IMAGES + 1))
	OUTPUT_TOOLTIPS = (
		"将全部外扩结果按顺序打包成一个 GJJ 专用批量图片输出；如果单图尺寸不一致，会自动补齐到统一尺寸。",
	) + tuple(
		f"第 {index} 张外扩结果的单图输出；命名风格与 GJJ · 任意对象预览器 的多输入接口保持一致。"
		for index in range(1, MAX_OUTPUT_IMAGES + 1)
	)
	FUNCTION = "generate"
	CATEGORY = "GJJ"

	def generate(
		self,
		image,
		prompt,
		unet_name,
		layout_mode,
		target_width,
		target_height,
		expand_method,
		original_ratio,
		expand_direction,
		left,
		top,
		right,
		bottom,
		feathering,
		seed,
		prompt_graph=None,
		unique_id=None,
	):
		try:
			_send_status(unique_id, "1/8 解析模型配套...")
			bundle = _resolve_model_bundle(unet_name)
			unet_models = _allowed_unets()
			clip_models = list_clip_models() or [DEFAULT_CLIP]
			lora_models = _safe_filename_list("loras")

			resolved_unet = _resolve_name(unet_name, unet_models, DEFAULT_UNET)
			if not resolved_unet:
				raise RuntimeError(f"未找到 UNET 模型：{unet_name}")
			resolved_clip_names = resolve_clip_names_for_preset(
				{
					"clip_names": bundle["clip_names"],
					"clip_type": bundle["clip_type"],
				},
				clip_models,
				"",
				[],
			)
			if not resolved_clip_names:
				raise RuntimeError(f"未找到与当前模型配套的 CLIP：{unet_name}")
			resolved_clip_names = [
				_require_category_name("text_encoders", clip_name, f"CLIP {index + 1}")
				for index, clip_name in enumerate(resolved_clip_names)
			]
			resolved_vae = _require_category_name("vae", bundle["vae_name"], "VAE")
			resolved_lora = _pick_available_lora_name(bundle["lora_1_name"], lora_models, bundle["lora_1_name"])
			if bundle["lora_1_name"] and (not resolved_lora or not folder_paths.get_full_path("loras", resolved_lora)):
				raise RuntimeError(f"未找到 LoRA 文件：{bundle['lora_1_name']}")
			resolved_optional_lora = _pick_available_lora_name(bundle["lora_2_name"], lora_models, bundle["lora_2_name"])

			if bundle["route"] == "flux_fill":
				bundle["steps"] = DEFAULT_FLUX_FILL_STEPS
				bundle["cfg"] = DEFAULT_FLUX_FILL_CFG
				bundle["sampler"] = DEFAULT_FLUX_FILL_SAMPLER
				bundle["scheduler"] = DEFAULT_FLUX_FILL_SCHEDULER
				bundle["denoise"] = DEFAULT_FLUX_FILL_DENOISE
				bundle["guidance"] = DEFAULT_FLUX_GUIDANCE

			resolved_controlnet = ""
			if bundle["route"] == "qwen":
				controlnet_models = _safe_filename_list("controlnet")
				resolved_controlnet = _resolve_name(DEFAULT_CONTROLNET, controlnet_models, DEFAULT_CONTROLNET)
				if not resolved_controlnet or not folder_paths.get_full_path("controlnet", resolved_controlnet):
					raise RuntimeError(f"未找到 ControlNet 模型：{DEFAULT_CONTROLNET}")

			_send_status(unique_id, "2/8 加载 UNET / CLIP / VAE...")
			model = _load_model(resolved_unet, DEFAULT_UNET_DTYPE)
			clip = _load_clip_from_names(resolved_clip_names, bundle["clip_type"])
			vae = _load_vae(resolved_vae)
			control_net = None
			if resolved_controlnet:
				control_net = comfy.controlnet.load_controlnet(
					folder_paths.get_full_path("controlnet", resolved_controlnet),
					model,
				)

			_send_status(unique_id, "3/8 应用采样补丁与 LoRA...")
			model, clip = _apply_model_only_lora(model, clip, resolved_lora, bundle["lora_1_strength"])
			if resolved_optional_lora:
				model, clip = _apply_model_only_lora(model, clip, resolved_optional_lora, bundle["lora_2_strength"])
			model = _patch_model_sampling(model, bundle["model_sampling"], bundle["model_shift"])
			model = _apply_cfg_norm(model, bundle["cfg_norm_strength"])

			input_images, input_source = _split_input_images(image, prompt_graph, unique_id)
			if len(input_images) > MAX_OUTPUT_IMAGES:
				_send_status(unique_id, f"提示：批量图片超过 {MAX_OUTPUT_IMAGES} 张，已截取前 {MAX_OUTPUT_IMAGES} 张执行。")
				input_images = input_images[:MAX_OUTPUT_IMAGES]
			total_images = len(input_images)
			if total_images > 1:
				if input_source == "multi_image_loader_batch":
					_send_status(unique_id, f"提示：已识别多图片加载预览器批量图片，将按原始选图逐张外扩，共 {total_images} 张。")
				else:
					_send_status(unique_id, f"提示：检测到批量图片输入，将逐张外扩，共 {total_images} 张。")

			results: list[torch.Tensor] = []
			for index, single_image in enumerate(input_images, start=1):
				suffix = f"（第 {index}/{total_images} 张）" if total_images > 1 else ""
				results.append(
					_process_outpaint_image(
						single_image,
						prompt,
						bundle,
						model,
						clip,
						vae,
						control_net,
						layout_mode,
						target_width,
						target_height,
						expand_method,
						original_ratio,
						expand_direction,
						left,
						top,
						right,
						bottom,
						feathering,
						seed,
						unique_id=unique_id,
						status_suffix=suffix,
					)
				)

			result, used_uniform_padding = _merge_output_images(results)
			single_outputs = [_ensure_image_batch(item) for item in results[:MAX_OUTPUT_IMAGES]]
			while len(single_outputs) < MAX_OUTPUT_IMAGES:
				single_outputs.append(empty_image_tensor())
			width = int(result.shape[2]) if result is not None and result.ndim >= 3 else 0
			height = int(result.shape[1]) if result is not None and result.ndim >= 3 else 0
			if used_uniform_padding:
				_send_status(unique_id, f"完成：{int(result.shape[0])} 张，已自动补齐到统一尺寸 {width} × {height}")
			elif int(result.shape[0]) > 1:
				_send_status(unique_id, f"完成：{int(result.shape[0])} 张，单张尺寸 {width} × {height}")
			else:
				_send_status(unique_id, f"完成：{width} × {height}")
			return {
				"ui": {
					"result_image_count": [len(results)],
					"used_uniform_padding": [1 if used_uniform_padding else 0],
				},
				"result": (result, *tuple(single_outputs[:MAX_OUTPUT_IMAGES])),
			}
		except Exception as exc:
			raise RuntimeError(
				"外扩图片填充节点执行失败。\n"
				f"UNET：{unet_name}\n"
				f"详细错误：{exc}"
			) from exc


NODE_CLASS_MAPPINGS = {
	NODE_NAME: GJJ_Qwen2511EditOutpaint,
}

NODE_DISPLAY_NAME_MAPPINGS = {
	NODE_NAME: "GJJ · 🖼️ 外扩图片填充编辑器",
}
