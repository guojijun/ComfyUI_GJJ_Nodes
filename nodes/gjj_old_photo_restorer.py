from __future__ import annotations

import importlib.util
import math
import time
from datetime import datetime
from typing import Any

from comfy import model_management
import comfy.sd
import comfy.utils
import folder_paths
import torch
from nodes import VAEDecode, common_ksampler

from .common_utils.text_tools import (
	gjjutils_normalize_text as _normalize_text,
)
from .common_utils.model_loader import (
	DEFAULT_UNET_DTYPE,
	gjjutils_apply_cfg_norm as _apply_cfg_norm,
	gjjutils_load_clip_from_names as _load_clip_from_names,
	gjjutils_load_model as _load_model,
	gjjutils_load_vae as _load_vae,
	gjjutils_patch_model_sampling as _patch_model_sampling,
)
from .common_utils.model_family import (
	gjjutils_model_family_match_preset as match_model_family,
	gjjutils_pick_available_model_name as _pick_available_model_name,
	gjjutils_model_family_resolve_clip_type as resolve_clip_type,
	gjjutils_model_family_resolve_clip_names as resolve_clip_names_for_preset,
)
from .gjj_model_bundle_loader import (
	list_clip_models,
	list_unet_models,
	list_vae_models,
)
from .gjj_model_upscaler import _load_upscale_model, _list_upscale_models
from .common_utils.dependency_checker import (
	build_dependency_model_report,
	get_report_from_exception,
	make_missing_model_spec,
	print_dependency_model_report,
	raise_dependency_model_error,
	send_dependency_model_notice,
)
from .common_utils.progress import send_node_progress


NODE_NAME = "GJJ_OldPhotoRestorer"
NODE_DISPLAY_NAME = "GJJ · 🕰️ 一键批量修复老照片"
DEFAULT_PROMPT = "Enhance image details for more realism."
DEFAULT_UNET = "FireRed-Image-Edit-1.1_fp8mixed_comfy.safetensors"
DEFAULT_CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
DEFAULT_VAE = "qwen_image_vae.safetensors"
DEFAULT_LORA_1 = "QWEN\\lighting\\Qwen-Image-Edit-Lightning-4steps-V1.0.safetensors"
DEFAULT_LORA_2 = "QWEN\\lighting\\Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors"
FIRERED_UNET_KEYWORDS = ("fireredimageedit", "firered", "realfire")
DEFAULT_STEPS = 8
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "simple"
DEFAULT_DENOISE = 1.0
DEFAULT_SHIFT = 3.1
DEFAULT_CFG_NORM = 1.0
DEFAULT_MEGAPIXELS = 1.0
DEFAULT_UPSCALE_MODEL = "1xSkinContrast-SuperUltraCompact.pth"
MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d"
COMPAT_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
_DESCRIPTION_READY = (
	"将 FireRed Image Edit 老照片修复工作流封装为单节点。"
	"前台暴露输入图像、修复提示词、FireRed UNET、种子和放大开关，后台自动匹配 CLIP、VAE、双加速 LoRA，并通过公共状态栏显示中文进度。"
)
REQUIRED_OLD_PHOTO_MODELS = [
	make_missing_model_spec(
		label="FireRed Image Edit UNET",
		subdir="models/diffusion_models",
		filename=DEFAULT_UNET,
		description="老照片修复主模型；只支持 FireRed Image Edit。关键词：FireRed-Image-Edit、fireredimageedit、realfire。版本号和中文备注不影响模糊匹配。",
	),
	make_missing_model_spec(
		label="Qwen 2.5 VL CLIP",
		subdir="models/text_encoders",
		filename=DEFAULT_CLIP,
		description="Qwen Image Edit 图像编辑编码器；关键词：qwen_2.5_vl_7b_fp8_scaled、qwen 2.5 vl、qwen vl。",
	),
	make_missing_model_spec(
		label="Qwen Image VAE",
		subdir="models/vae",
		filename=DEFAULT_VAE,
		description="Qwen Image Edit 解码器；关键词：qwen_image_vae、qwen image vae。",
	),
	make_missing_model_spec(
		label="4步 Lightning LoRA",
		subdir="models/loras/QWEN/lighting",
		filename="Qwen-Image-Edit-Lightning-4steps-V1.0.safetensors",
		description="老照片工作流默认加速 LoRA；关键词：Qwen-Image-Edit-Lightning-4steps、4steps、lightning。",
	),
	make_missing_model_spec(
		label="8步 Lightning LoRA",
		subdir="models/loras/QWEN/lighting",
		filename="Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors",
		description="老照片工作流默认增强 LoRA；关键词：Qwen-Image-Edit-2509-Lightning-8steps、8steps、lightning。",
	),
	make_missing_model_spec(
		label="默认放大模型",
		subdir="models/upscale_models",
		filename=DEFAULT_UPSCALE_MODEL,
		description="默认结果增强模型；关键词：1xSkinContrast、SuperUltraCompact。关闭“启用放大”可跳过。",
	),
]


# ============================================================================
# 本地辅助函数（从 gjj_lazy_Image_studio 迁移）
# ============================================================================

def _safe_filename_list(category: str) -> list[str]:
	"""安全获取文件名列表。"""
	try:
		return list(folder_paths.get_filename_list(category))
	except Exception:
		return []


def _resize_to_long_edge(
	samples: torch.Tensor, longest_edge: int, upscale: str, crop: str
) -> torch.Tensor:
	"""调整图像到指定长边。"""
	height = int(samples.shape[2])
	width = int(samples.shape[3])
	current_long_edge = max(height, width)
	if current_long_edge <= 0:
		return samples
	scale = float(longest_edge) / float(current_long_edge)
	target_width = max(8, int(round(width * scale)))
	target_height = max(8, int(round(height * scale)))
	return comfy.utils.common_upscale(
		samples, target_width, target_height, upscale, crop
	)


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
	send_node_progress(unique_id, text, progress)


def _format_elapsed(seconds: float) -> str:
	value = max(0.0, float(seconds or 0.0))
	if value < 10:
		return f"{value:.2f}秒"
	if value < 60:
		return f"{value:.1f}秒"
	minutes = int(value // 60)
	return f"{minutes}分{value % 60:.1f}秒"


def _now_label() -> str:
	return datetime.now().strftime("%H:%M:%S")


def _unwrap_scalar(value: Any) -> Any:
	try:
		while isinstance(value, (list, tuple)) and len(value) == 1:
			value = value[0]
	except Exception:
		pass
	return value


def _as_bool(value: Any, default: bool = False) -> bool:
	value = _unwrap_scalar(value)
	if value is None:
		return bool(default)
	if isinstance(value, str):
		normalized = value.strip().lower()
		if normalized in {"1", "true", "yes", "on", "enable", "enabled", "开启", "启用", "是"}:
			return True
		if normalized in {"0", "false", "no", "off", "disable", "disabled", "关闭", "禁用", "否"}:
			return False
	return bool(value)


def _as_int(value: Any, default: int = 0) -> int:
	value = _unwrap_scalar(value)
	try:
		return int(value)
	except Exception:
		return int(default)


def _send_batch_status(
	unique_id: Any,
	stage_index: int,
	stage_total: int,
	stage_name: str,
	image_index: int,
	total_images: int,
	started_at: float,
	start_label: str,
	progress: float | None = None,
) -> None:
	stage_index = max(1, min(int(stage_index), max(1, int(stage_total))))
	stage_total = max(1, int(stage_total))
	total_images = max(1, int(total_images))
	image_index = max(0, min(int(image_index), total_images))
	if progress is None:
		image_fraction = (image_index / total_images) if image_index else 0.0
		progress = ((stage_index - 1) + image_fraction) / stage_total
	image_text = f"当前第 {image_index}/{total_images} 张" if image_index else f"当前第 -/{total_images} 张"
	elapsed = _format_elapsed(time.perf_counter() - started_at)
	_send_status(
		unique_id,
		(
			f"步骤 {stage_index}/{stage_total}：{stage_name} · {image_text}\n"
			f"总步骤 {stage_total} · 总图片 {total_images} · 耗时 {elapsed}\n"
			f"开始 {start_label} · 当前 {_now_label()} · 设备 {_device_label()}"
		),
		progress,
	)


def _soft_empty_cache() -> None:
	try:
		model_management.soft_empty_cache()
	except Exception:
		pass


def _preferred_device() -> torch.device:
	try:
		device = model_management.get_torch_device()
		if getattr(device, "type", "cpu") != "cpu":
			return device
	except Exception:
		device = None
	if torch.cuda.is_available():
		return torch.device("cuda")
	return device or torch.device("cpu")


def _device_label() -> str:
	device = _preferred_device()
	device_type = str(getattr(device, "type", device) or "cpu")
	if device_type == "cuda":
		index = getattr(device, "index", None)
		if index is None:
			try:
				index = torch.cuda.current_device()
			except Exception:
				index = 0
		return f"GPU cuda:{index}"
	if device_type in {"mps", "xpu", "dml"}:
		return f"GPU {device_type}"
	return device_type.upper()


def _to_rgb_image(image: torch.Tensor) -> torch.Tensor:
	if not torch.is_tensor(image):
		raise RuntimeError("老照片修复增强节点需要 IMAGE 或 GJJ_BATCH_IMAGE 图像张量。")
	if image.ndim == 3:
		image = image.unsqueeze(0)
	if image.ndim != 4:
		raise RuntimeError("输入图像必须是 [B,H,W,C] 的 IMAGE / GJJ_BATCH_IMAGE 张量。")
	channels = int(image.shape[-1])
	if channels == 3:
		return image.detach().float().clamp(0.0, 1.0).contiguous()
	if channels == 4:
		rgb = image[..., :3].detach().float()
		alpha = image[..., 3:4].detach().float().clamp(0.0, 1.0)
		return (rgb * alpha).clamp(0.0, 1.0).contiguous()
	if channels == 1:
		return image.detach().float().repeat(1, 1, 1, 3).clamp(0.0, 1.0).contiguous()
	if channels > 4:
		return image[..., :3].detach().float().clamp(0.0, 1.0).contiguous()
	raise RuntimeError(f"输入图像通道数无效：{channels}")


def _iter_container_values(value: Any) -> list[Any]:
	if value is None or isinstance(value, (str, bytes, bytearray)) or torch.is_tensor(value):
		return []
	if isinstance(value, dict):
		return list(value.values())
	if isinstance(value, (list, tuple, set)):
		return list(value)
	values: list[Any] = []
	for name in (
		"images",
		"image",
		"batch",
		"batches",
		"queue",
		"items",
		"data",
		"frames",
		"outputs",
		"values",
		"selected_images",
		"image_list",
		"image_queue",
		"批量图片队列",
	):
		try:
			if hasattr(value, name):
				item = getattr(value, name)
				if item is not None and item is not value:
					values.append(item)
		except Exception:
			pass
	try:
		if hasattr(value, "__iter__"):
			values.extend(list(value))
	except Exception:
		pass
	return values


def _split_image_batch(value: Any, _seen: set[int] | None = None) -> list[torch.Tensor]:
	if value is None:
		return []
	if torch.is_tensor(value):
		image = _to_rgb_image(value)
		batch_size = max(0, int(image.shape[0]))
		return [image[index:index + 1].contiguous() for index in range(batch_size)]
	if _seen is None:
		_seen = set()
	identifier = id(value)
	if identifier in _seen:
		return []
	_seen.add(identifier)
	images: list[torch.Tensor] = []
	for item in _iter_container_values(value):
		images.extend(_split_image_batch(item, _seen))
	return images


def _build_uniform_image_batch(images: list[torch.Tensor]) -> torch.Tensor:
	if not images:
		raise RuntimeError("没有可输出的修复结果。")
	normalized = [_to_rgb_image(image).detach().float().cpu() for image in images]
	max_height = max(int(image.shape[1]) for image in normalized)
	max_width = max(int(image.shape[2]) for image in normalized)
	padded: list[torch.Tensor] = []
	for image in normalized:
		height = int(image.shape[1])
		width = int(image.shape[2])
		if height == max_height and width == max_width:
			padded.append(image.contiguous())
			continue
		canvas = torch.zeros((1, max_height, max_width, 3), dtype=image.dtype)
		top = max(0, (max_height - height) // 2)
		left = max(0, (max_width - width) // 2)
		canvas[:, top:top + height, left:left + width, :] = image
		padded.append(canvas)
	return torch.cat(padded, dim=0).contiguous()


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


def _firered_unets() -> list[str]:
	models = list_unet_models() or []
	filtered = [
		name
		for name in models
		if any(keyword in _normalize_text(name) for keyword in FIRERED_UNET_KEYWORDS)
	]
	return filtered


def _choices_with_default(available: list[str], default_name: str) -> list[str]:
	"""保留传入的模型选项，同时确保默认模型 seed 可显示在面板上。"""
	choices: list[str] = []
	default_name = str(default_name or "").strip()
	if default_name:
		choices.append(default_name)
	for item in available or []:
		value = str(item or "").strip()
		if value and value not in choices:
			choices.append(value)
	return choices or ([default_name] if default_name else [])


def _resolve_basename_match(requested: str, available: list[str], fallback: str = "") -> str:
	return _pick_available_model_name(
		str(requested or "").strip(),
		list(available or []),
		str(fallback or "").strip(),
		allow_first=False,
	)


def _has_any_model(candidates: tuple[str, ...], available: list[str]) -> bool:
	for candidate in candidates:
		if _resolve_basename_match(candidate, available, ""):
			return True
	return False


def _missing_optional_dependency_specs() -> list[dict[str, str]]:
	if importlib.util.find_spec("spandrel") is not None:
		return []
	return [
		{
			"module_name": "spandrel",
			"package_name": "spandrel",
			"display_name": "Spandrel",
			"description": "可选放大模型加载依赖；关闭“启用放大”后仍可完成基础修复。",
		}
	]


def _missing_old_photo_models() -> list[dict[str, str]]:
	unet_models = list_unet_models() or []
	clip_models = list_clip_models() or []
	vae_models = list_vae_models() or []
	lora_models = _safe_filename_list("loras")
	upscale_models = _list_upscale_models()
	missing: list[dict[str, str]] = []

	if not _firered_unets() and not _has_any_model((DEFAULT_UNET,), unet_models):
		missing.append(REQUIRED_OLD_PHOTO_MODELS[0])
	if not _has_any_model((DEFAULT_CLIP,), clip_models):
		missing.append(REQUIRED_OLD_PHOTO_MODELS[1])
	if not _has_any_model((DEFAULT_VAE,), vae_models):
		missing.append(REQUIRED_OLD_PHOTO_MODELS[2])
	if not _has_any_model((DEFAULT_LORA_1,), lora_models):
		missing.append(REQUIRED_OLD_PHOTO_MODELS[3])
	if not _has_any_model((DEFAULT_LORA_2,), lora_models):
		missing.append(REQUIRED_OLD_PHOTO_MODELS[4])
	if not _has_any_model((DEFAULT_UPSCALE_MODEL,), upscale_models):
		missing.append(REQUIRED_OLD_PHOTO_MODELS[5])
	return missing


def _raise_missing_model(
	label: str,
	subdir: str,
	filename: str,
	description: str,
	unique_id: Any = None,
	original_error: str = "",
) -> None:
	raise_dependency_model_error(
		node_name=NODE_DISPLAY_NAME,
		missing_models=[
			make_missing_model_spec(
				label=label,
				subdir=subdir,
				filename=filename,
				description=description,
			)
		],
		description="一键批量修复老照片需要本地 FireRed Image Edit 模型链。请补齐模型后重启 ComfyUI。",
		original_error=original_error,
		unique_id=unique_id,
		title="GJJ 一键批量修复老照片模型缺失！",
		model_download_url=MODEL_DOWNLOAD_URL,
	)


def _require_lora_name(preferred: str, available: list[str], label: str, unique_id: Any = None) -> str:
	resolved = _resolve_basename_match(preferred, available, "")
	if not resolved:
		preferred_keyword = preferred.replace("\\", "/").split("/")[-1].rsplit(".", 1)[0]
		_raise_missing_model(
			f"{label} LoRA",
			"models/loras/QWEN/lighting",
			preferred.replace("\\", "/").split("/")[-1],
			f"一键批量修复老照片默认使用的{label} LoRA。关键词：{preferred_keyword}。",
			unique_id=unique_id,
		)
	full_path = folder_paths.get_full_path("loras", resolved)
	if not full_path:
		_raise_missing_model(
			f"{label} LoRA",
			"models/loras/QWEN/lighting",
			resolved.replace("\\", "/").split("/")[-1],
			f"一键批量修复老照片默认使用的{label} LoRA。",
			unique_id=unique_id,
		)
	return resolved


_MISSING_OPTIONAL_DEPENDENCIES = _missing_optional_dependency_specs()
_MISSING_MODELS = _missing_old_photo_models()
_ENVIRONMENT_REPORT = build_dependency_model_report(
	node_name=NODE_DISPLAY_NAME,
	missing_dependencies=[],
	optional_dependencies=_MISSING_OPTIONAL_DEPENDENCIES,
	optional_install_packages=["spandrel"] if _MISSING_OPTIONAL_DEPENDENCIES else [],
	missing_models=_MISSING_MODELS,
	description="一键批量修复老照片需要本地 FireRed Image Edit 模型链；放大功能额外需要 Spandrel 与默认放大模型。",
	model_download_url=MODEL_DOWNLOAD_URL,
)
_DEPENDENCIES_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("dependencies_available", True))
_MODELS_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("models_available", True))
_MISSING_DEPENDENCIES = list(_ENVIRONMENT_REPORT.get("missing_dependencies", []) or [])
_OPTIONAL_DEPENDENCIES_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("optional_dependencies_available", True))
if _MISSING_MODELS:
	_ENVIRONMENT_REPORT["copy_text"] = MODEL_DOWNLOAD_URL
	_ENVIRONMENT_REPORT["copy_label"] = "🌏 复制模型下载网址"
if not _ENVIRONMENT_REPORT.get("available", True) or _MISSING_OPTIONAL_DEPENDENCIES:
	print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ 一键批量修复老照片运行环境提示")


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
	image = _to_rgb_image(image).to(device=_preferred_device(), dtype=torch.float32)
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


def _upscale_image_with_loaded_model(image: torch.Tensor, upscale_model) -> torch.Tensor:
	device = _preferred_device()
	memory_required = model_management.module_size(upscale_model.model)
	memory_required += (512 * 512 * 3) * image.element_size() * max(upscale_model.scale, 1.0) * 384.0
	memory_required += image.nelement() * image.element_size()
	model_management.free_memory(memory_required, device)
	upscale_model.to(device)
	input_image = image.movedim(-1, -3).to(device)
	tile = 512
	overlap = 32
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
	return torch.clamp(scaled.movedim(-3, -1), min=0.0, max=1.0).detach().cpu()


def _upscale_image_with_model(image: torch.Tensor, upscale_model_name: str) -> torch.Tensor:
	if not str(upscale_model_name or "").strip():
		return image
	upscale_model = _load_upscale_model(upscale_model_name)
	try:
		return _upscale_image_with_loaded_model(image, upscale_model)
	finally:
		try:
			upscale_model.to("cpu")
		except Exception:
			pass


class GJJ_OldPhotoRestorer:
	DESCRIPTION = (
		_DESCRIPTION_READY
		if _ENVIRONMENT_REPORT.get("available", True)
		else _ENVIRONMENT_REPORT.get("warning_message", _DESCRIPTION_READY)
	)
	REQUIRED_MODELS = REQUIRED_OLD_PHOTO_MODELS
	GJJ_HELP = {
		"title": NODE_DISPLAY_NAME,
		"description": _DESCRIPTION_READY,
		"notice": _ENVIRONMENT_REPORT.get("help_message", "") if (not _ENVIRONMENT_REPORT.get("available", True) or _MISSING_OPTIONAL_DEPENDENCIES) else "",
		"warning_message": _ENVIRONMENT_REPORT.get("warning_message", "") if (not _ENVIRONMENT_REPORT.get("available", True) or _MISSING_OPTIONAL_DEPENDENCIES) else "",
		"install_cmd": _ENVIRONMENT_REPORT.get("install_cmd", ""),
		"optional_install_cmd": _ENVIRONMENT_REPORT.get("optional_install_cmd", ""),
		"copy_text": _ENVIRONMENT_REPORT.get("copy_text", "") if (not _ENVIRONMENT_REPORT.get("available", True) or _MISSING_OPTIONAL_DEPENDENCIES) else MODEL_DOWNLOAD_URL,
		"copy_label": _ENVIRONMENT_REPORT.get("copy_label", "") if (not _ENVIRONMENT_REPORT.get("available", True) or _MISSING_OPTIONAL_DEPENDENCIES) else "🌏 复制模型下载网址",
		"model_download_url": MODEL_DOWNLOAD_URL,
		"notice_level": _ENVIRONMENT_REPORT.get("notice_level", "ok"),
		"dependencies": [
			"基础修复无需额外 Python 依赖；使用 ComfyUI 官方模型加载、采样、VAE 解码和 GJJ 内部工具。",
			"启用放大时需要 ComfyUI 环境具备 Spandrel，并需要 models/upscale_models 下的默认放大模型。",
		],
		"models": REQUIRED_OLD_PHOTO_MODELS,
	}

	@classmethod
	def INPUT_TYPES(cls):
		available_unets = _firered_unets()
		available_upscale_models = _list_upscale_models()
		default_unet = _resolve_basename_match(DEFAULT_UNET, available_unets, "") or DEFAULT_UNET
		default_upscale = _resolve_basename_match(DEFAULT_UPSCALE_MODEL, available_upscale_models, "") or DEFAULT_UPSCALE_MODEL
		unet_models = _choices_with_default(available_unets, default_unet)
		upscale_models = _choices_with_default(available_upscale_models, default_upscale)
		return {
			"required": {
				"image": (COMPAT_BATCH_IMAGE_TYPE, {
					"display_name": "🖼️ 输入图像",
					"tooltip": "需要修复或增强的老照片图像。支持普通 IMAGE 或 GJJ_BATCH_IMAGE 批量图像。",
				}),
				"prompt": ("STRING", {
					"default": DEFAULT_PROMPT,
					"multiline": False,
					"display_name": "📝 修复提示词",
					"tooltip": "用于指导老照片修复增强的提示词，默认沿用官方工作流。",
				}),
				"unet_name": (unet_models, {
					"default": default_unet,
					"display_name": "🟣 UNET 主模型",
					"tooltip": "主修复模型。此节点只支持 FireRed Image Edit；面板只显示 models/diffusion_models 下匹配 FireRed 的模型，搜索不要求版本号。",
				}),
				"seed": ("INT", {
					"default": 1091911236774418,
					"min": 0,
					"max": 0xFFFFFFFFFFFFFFFF,
					"display_name": "🎲 种子",
					"tooltip": "控制采样随机性的种子值。",
				}),
				"enable_upscale": ("BOOLEAN", {
					"default": True,
					"display_name": "🔍 启用放大",
					"tooltip": "开启后会在生成完成后接着用超分模型做一次图像增强。",
				}),
				"upscale_model_name": (upscale_models, {
					"default": default_upscale,
					"display_name": "🔎 放大模型",
					"tooltip": "用于结果图像增强的放大模型。面板保留 models/upscale_models 下的全部模型选项，默认按 1xSkinContrast 关键词模糊匹配。",
				}),
			},
			"hidden": {
				"unique_id": "UNIQUE_ID",
			},
		}

	RETURN_TYPES = (COMPAT_BATCH_IMAGE_TYPE,)
	RETURN_NAMES = ("🕰️ 修复增强图像",)
	OUTPUT_TOOLTIPS = ("老照片修复增强后的图像结果，兼容 GJJ_BATCH_IMAGE 和 IMAGE 连接。",)
	FUNCTION = "restore"
	CATEGORY = "GJJ"
	INPUT_IS_LIST = True

	def restore(self, image, prompt, unet_name, seed, enable_upscale, upscale_model_name, unique_id=None):
		started_at = time.perf_counter()
		start_label = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
		try:
			prompt = _unwrap_scalar(prompt)
			unet_name = _unwrap_scalar(unet_name)
			seed = _as_int(seed, 1091911236774418)
			enable_upscale = _as_bool(enable_upscale, True)
			upscale_model_name = _unwrap_scalar(upscale_model_name)
			unique_id = _unwrap_scalar(unique_id)

			input_images = _split_image_batch(image)
			if not input_images:
				raise RuntimeError("没有检测到有效输入图像，请连接 IMAGE 或 GJJ_BATCH_IMAGE。")
			total_images = len(input_images)
			stage_total = 5 + (1 if enable_upscale else 0)
			_send_batch_status(
				unique_id,
				1,
				stage_total,
				"解包合并输入 / 检查模型",
				0,
				total_images,
				started_at,
				start_label,
				0.03,
			)
			if enable_upscale and _MISSING_OPTIONAL_DEPENDENCIES:
				raise_dependency_model_error(
					node_name=NODE_DISPLAY_NAME,
					missing_dependencies=_MISSING_OPTIONAL_DEPENDENCIES,
					install_packages=["spandrel"],
					description="启用放大需要 Spandrel 读取超分模型；关闭“启用放大”可跳过这一步。",
					unique_id=unique_id,
					title="GJJ 一键批量修复老照片可选增强依赖缺失！",
				)
			unet_models = _firered_unets()
			clip_models = list_clip_models() or []
			vae_models = list_vae_models() or []
			lora_models = _safe_filename_list("loras")
			upscale_models = _list_upscale_models()

			resolved_unet = _resolve_basename_match(unet_name, unet_models, "") or _resolve_basename_match(DEFAULT_UNET, unet_models, "")
			if not resolved_unet:
				_raise_missing_model(
					"FireRed Image Edit UNET",
					"models/diffusion_models",
					str(unet_name or DEFAULT_UNET),
					"一键批量修复老照片只支持 FireRed Image Edit。请放入 models/diffusion_models，关键词：FireRed-Image-Edit、fireredimageedit、realfire；版本号可省略。",
					unique_id=unique_id,
				)

			# 根据 UNET 名称匹配模型预设
			preset = match_model_family(resolved_unet)
			if preset is None:
				# 如果找不到预设，使用默认值
				preset = {"id": "generic", "clip_type": "stable_diffusion", "vae_name": DEFAULT_VAE}

			# 根据预设自动匹配 CLIP 和 VAE
			resolved_clip_names = resolve_clip_names_for_preset(
				preset,
				clip_models,
				exposed_clip_name="",
				legacy_clip_names=[]
			)
			resolved_clip_names = [name for name in resolved_clip_names if str(name or "").strip()]
			if not resolved_clip_names:
				# 如果预设匹配失败，回退到默认配置
				fallback_clip = _resolve_basename_match(DEFAULT_CLIP, clip_models, "")
				resolved_clip_names = [fallback_clip] if fallback_clip else []
			if not resolved_clip_names:
				_raise_missing_model(
					"Qwen 2.5 VL CLIP",
					"models/text_encoders",
					DEFAULT_CLIP,
					"Qwen Image Edit 图像编辑编码器缺失。",
					unique_id=unique_id,
				)

			resolved_vae_name = _resolve_basename_match(
				preset.get("vae_name", DEFAULT_VAE),
				vae_models,
				""
			)
			if not resolved_vae_name:
				_raise_missing_model(
					"Qwen Image VAE",
					"models/vae",
					str(preset.get("vae_name", DEFAULT_VAE) or DEFAULT_VAE),
					"Qwen Image Edit VAE 解码器缺失。",
					unique_id=unique_id,
				)

			resolved_clip_type = resolve_clip_type(
				resolved_unet,
				resolved_clip_names,
				str(preset.get("clip_type", "qwen_image"))
			)

			resolved_lora_1 = _require_lora_name(DEFAULT_LORA_1, lora_models, "加速", unique_id=unique_id)
			resolved_lora_2 = _require_lora_name(DEFAULT_LORA_2, lora_models, "增强", unique_id=unique_id)
			resolved_upscale = _resolve_basename_match(upscale_model_name, upscale_models, "") if enable_upscale else ""
			if enable_upscale and not resolved_upscale:
				_raise_missing_model(
					"默认放大模型",
					"models/upscale_models",
					str(upscale_model_name or DEFAULT_UPSCALE_MODEL),
					"默认结果增强模型缺失；关闭“启用放大”可跳过。",
					unique_id=unique_id,
				)

			_send_batch_status(
				unique_id,
				2,
				stage_total,
				"加载 UNET / CLIP / VAE 并应用 LoRA",
				0,
				total_images,
				started_at,
				start_label,
			)
			model = _load_model(resolved_unet, DEFAULT_UNET_DTYPE)
			clip = _load_clip_from_names(resolved_clip_names, resolved_clip_type)
			vae = _load_vae(resolved_vae_name)

			model, clip = _apply_model_only_lora(model, clip, resolved_lora_1, 1.0)
			model, clip = _apply_model_only_lora(model, clip, resolved_lora_2, 1.0)
			model = _patch_model_sampling(model, "aura", DEFAULT_SHIFT)
			model = _apply_cfg_norm(model, DEFAULT_CFG_NORM)

			encoded_jobs: list[dict[str, Any]] = []
			for index, single_image in enumerate(input_images, start=1):
				_send_batch_status(
					unique_id,
					3,
					stage_total,
					"CLIP / VAE 编码并存储条件",
					index,
					total_images,
					started_at,
					start_label,
				)
				scaled_image = _scale_image_to_megapixels(single_image, DEFAULT_MEGAPIXELS)
				positive, negative, latent = _encode_qwen_edit_single_image(
					clip,
					vae,
					scaled_image,
					str(prompt or DEFAULT_PROMPT),
					"",
				)
				encoded_jobs.append({
					"positive": positive,
					"negative": negative,
					"latent": latent,
				})
			del clip
			_soft_empty_cache()

			sampled_jobs: list[dict[str, Any]] = []
			try:
				model_management.load_models_gpu([model])
			except Exception:
				pass
			for index, job in enumerate(encoded_jobs, start=1):
				_send_batch_status(
					unique_id,
					4,
					stage_total,
					"UNET 采样并存储 latent",
					index,
					total_images,
					started_at,
					start_label,
				)
				sampled = common_ksampler(
					model,
					seed,
					DEFAULT_STEPS,
					float(DEFAULT_CFG),
					DEFAULT_SAMPLER,
					DEFAULT_SCHEDULER,
					job["positive"],
					job["negative"],
					job["latent"],
					denoise=float(DEFAULT_DENOISE),
				)[0]
				sampled_jobs.append(sampled)
				encoded_jobs[index - 1] = {}
			del model
			_soft_empty_cache()

			decoded_images: list[torch.Tensor] = []
			vae_decoder = VAEDecode()
			for index, sampled in enumerate(sampled_jobs, start=1):
				_send_batch_status(
					unique_id,
					5,
					stage_total,
					"VAE 解码并存储图像",
					index,
					total_images,
					started_at,
					start_label,
				)
				decoded = vae_decoder.decode(vae, sampled)[0]
				decoded_images.append(_to_rgb_image(decoded).detach())
				sampled_jobs[index - 1] = {}
			del vae
			_soft_empty_cache()

			if enable_upscale and resolved_upscale:
				upscale_model = _load_upscale_model(resolved_upscale)
				try:
					upscaled_images: list[torch.Tensor] = []
					for index, decoded in enumerate(decoded_images, start=1):
						_send_batch_status(
							unique_id,
							6,
							stage_total,
							f"超分模型放大：{resolved_upscale}",
							index,
							total_images,
							started_at,
							start_label,
						)
						upscaled_images.append(_upscale_image_with_loaded_model(decoded, upscale_model))
					decoded_images = upscaled_images
				finally:
					try:
						upscale_model.to("cpu")
					except Exception:
						pass
					_soft_empty_cache()

			result = _build_uniform_image_batch(decoded_images)
			width = int(result.shape[2]) if result is not None and result.ndim >= 3 else 0
			height = int(result.shape[1]) if result is not None and result.ndim >= 3 else 0
			_send_batch_status(
				unique_id,
				stage_total,
				stage_total,
				f"完成输出 {total_images} 张 · {width} × {height}",
				total_images,
				total_images,
				started_at,
				start_label,
				1.0,
			)
			return (result,)
		except Exception as exc:
			report = get_report_from_exception(exc)
			if report:
				send_dependency_model_notice(report, unique_id=unique_id)
				raise RuntimeError(report.get("warning_message") or "一键批量修复老照片运行环境缺失。") from exc
			raise RuntimeError(
				"老照片修复增强节点执行失败。\n"
				f"UNET：{unet_name}\n"
				f"详细错误：{exc}"
			) from exc


NODE_CLASS_MAPPINGS = {
	NODE_NAME: GJJ_OldPhotoRestorer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
	NODE_NAME: NODE_DISPLAY_NAME,
}
