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
from comfy.cli_args import args
from PIL import Image, ImageDraw, ImageFont
from PIL.PngImagePlugin import PngInfo
from nodes import VAEDecode, common_ksampler

from .common_utils.text_tools import (
	gjjutils_canonical_model_text as _canonical_model_text,
	gjjutils_normalize_text as _normalize_text,
	gjjutils_pick_available_name as _pick_available_name,
)
from .gjj_lazy_image_studio import (
	DEFAULT_CLIP_NAME,
	DEFAULT_LIGHTNING_LORA,
	DEFAULT_UNET_DTYPE,
	DEFAULT_UNET_NAME,
	DEFAULT_VAE_NAME,
	GJJ_LazyImageStudio,
	_prepare_primary_image_for_target,
	_apply_cfg_norm,
	_patch_model_sampling,
	_resize_to_long_edge,
	_safe_filename_list,
	_resolve_effective_steps,
	collect_image_pairs,
	list_clip_models,
	list_unet_models,
	list_vae_models,
	match_model_family,
	resolve_clip_names_for_preset,
	resolve_clip_type,
)
from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .gjj_multi_lora_chain import normalize_lora_chain_data


NODE_NAME = "GJJ_CharacterMultiViewStudio"
DEFAULT_MULTI_ANGLES_LORA = "qwen-image-edit-2511-multiple-angles-lora.safetensors"
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
	if preset.get("id") != "generic":
		return preset

	canonical = _canonical_model_text(unet_name)
	if any(keyword in canonical for keyword in SPECIAL_EDIT_KEYWORDS):
		override = dict(match_model_family("qwen_image_edit_2511"))
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
	for key, value in kwargs.items():
		text = str(key or "")
		if not text.startswith("action_image_") or value is None:
			continue
		try:
			index = int(text.split("_")[-1])
		except Exception:
			continue
		items.append((index, value))
	items.sort(key=lambda item: item[0])
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
			return ("IMAGE",)
		raise KeyError(key)

	def __contains__(self, key):
		text = str(key or "")
		return key in self.data or text.startswith("action_image_")


class GJJ_CharacterMultiViewStudio(GJJ_LazyImageStudio):
	CATEGORY = "GJJ"
	FUNCTION = "generate"
	DESCRIPTION = (
		"主体一键多视图：主图必选，动作可用图片参考、文字描述或按钮预设。"
		"节点会自动匹配 qwen_image_edit_2511 为主线的图生图模型族，并将结果尽量方正地拼接成多视图图板。"
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
	RETURN_NAMES = ("多视图拼接图", "单图批量图片")
	OUTPUT_TOOLTIPS = (
		"自动拼接后的多视图成品图。",
		"按视角顺序输出的 GJJ 专用批量图片，可直接接入批量图片输入接口。",
	)

	@classmethod
	def INPUT_TYPES(cls):
		unet_models = _multiview_allowed_unets()
		clip_models = list_clip_models() or [DEFAULT_CLIP_NAME]
		vae_models = list_vae_models() or [DEFAULT_VAE_NAME]
		lora_models = [""] + (_safe_filename_list("loras") or [])
		default_preset = _match_multiview_family(DEFAULT_UNET_NAME)
		return {
			"required": {
				"main_image": (
					"IMAGE",
					{
						"display_name": "主图",
						"tooltip": "主体主参考图，必选。节点会始终以这张图作为类别、外观与风格一致性的主参考。",
					},
				),
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
					"action_image_01": (
						"IMAGE",
						{
							"display_name": "动作图 1",
							"tooltip": "第一张动作 / 姿势参考图。连上后会自动扩展出下一张动作图输入。",
						},
					),
					"lora_chain_config": (
						"LORA_CHAIN_CONFIG",
						{
							"display_name": "LoRA串联配置",
							"tooltip": "可选接入 GJJ · LoRA串联配置 的输出；会在面板 LoRA 1 / LoRA 2 之后继续按顺序串联应用多组 LoRA。",
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
	):
		target_width, target_height = _resolve_target_size_from_image(
			main_image,
			int(preset.get("main_long_edge", 1024)),
			int(preset.get("width", 1024)),
			int(preset.get("height", 1024)),
		)
		if bool(preset.get("supports_multi_image_edit")):
			if action_image is not None:
				identity_ref_image, identity_ref_latent = _prepare_qwen_ref_image(
					vae,
					main_image,
					target_width,
					target_height,
				)
				action_ref_image, action_ref_latent = _prepare_qwen_ref_image(
					vae,
					action_image,
					target_width,
					target_height,
				)
				vl_images = [
					_prepare_qwen_vl_image(identity_ref_image, int(preset.get("vl_long_edge", 384)), "bicubic", "center"),
					_prepare_qwen_vl_image(action_ref_image, int(preset.get("vl_long_edge", 384)), "bicubic", "center"),
				]
				prompt = (
					"Picture 1: "
					"Picture 2: "
					f"{view_prompt}"
				)
				tokens = clip.tokenize(prompt, images=vl_images)
				conditioning = clip.encode_from_tokens_scheduled(tokens)
				positive = _conditioning_set_values(
					conditioning,
					{"reference_latents": [identity_ref_latent, action_ref_latent]},
					append=True,
				)
				negative = self._encode_negative_conditioning(clip, positive, negative_prompt)
				latent_out = {"samples": action_ref_latent}
			else:
				pairs = [{"slot_index": 0, "image": main_image}]
				positive, negative, latent_out = self._encode_multi_image_edit(
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
			latent_out = self._build_latent(
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
		sampled_latent = common_ksampler(
			model,
			int(seed),
			effective_steps,
			float(preset.get("cfg", 1.0)),
			str(preset.get("sampler_name", "euler")),
			str(preset.get("scheduler", "normal")),
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
		total_steps = 6 if bool(save_each_image) else 5
		_send_status(unique_id, f"1/{total_steps} 检查模型配对并加载主链...")
		preset, resolved_clip_names, resolved_clip_type, resolved_vae_name = self._resolve_generation_bundle(
			unet_name,
			DEFAULT_CLIP_NAME,
			DEFAULT_VAE_NAME,
		)
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

		action_pairs = self._collect_action_pairs(kwargs)
		action_lines = _parse_action_lines(action_prompts)
		raw_job_count = max(len(action_lines), len(action_pairs), 1)
		jobs = _build_action_jobs(action_lines, action_pairs)
		use_action_reference_mode = any(job["image"] is not None for job in jobs)
		results: list[torch.Tensor] = []
		captions: list[str] = []

		if action_pairs and not bool(preset.get("supports_multi_image_edit")):
			_send_status(unique_id, "提示：当前底模不支持多图视觉参考，动作图将仅作为动作文本的辅助说明。")
		elif use_action_reference_mode:
			_send_status(unique_id, "提示：已切换到动作图驱动模式；动作文本不再参与姿态控制，多角度 LoRA 已停用。")
		if len(jobs) < raw_job_count:
			_send_status(unique_id, f"提示：已自动去除 {raw_job_count - len(jobs)} 个重复视角。")

		effective_lora_2_name = lora_2_name
		effective_lora_2_strength = lora_2_strength
		if use_action_reference_mode:
			effective_lora_2_name = ""
			effective_lora_2_strength = 0.0

		total = len(jobs)
		for index, job in enumerate(jobs, start=1):
			view_prompt = _compose_view_prompt(
				base_prompt=base_prompt,
				action_text=job["text"],
				has_action_image=job["image"] is not None,
				index=job["index"],
			)
			_send_status(unique_id, f"2/{total_steps} 生成第 {index}/{total} 张视图...")
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
