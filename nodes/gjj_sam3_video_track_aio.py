from __future__ import annotations

import hashlib
import json
from typing import Any

import torch
import torch.nn.functional as F

import comfy.model_management
import comfy.sd
import comfy.utils
import folder_paths

from .common_utils.dependency_checker import (
	build_dependency_model_report,
	build_node_help_payload,
	make_missing_model_spec,
	print_dependency_model_report,
	raise_dependency_model_error,
	send_dependency_model_notice,
)
from .common_utils.prompt_translation import (
	TRANSLATION_BUNDLE_FILENAME,
	TRANSLATION_DEPENDENCY_SPECS,
	TRANSLATION_MODEL_DOWNLOAD_URL,
	TRANSLATION_MODEL_SUBDIR,
	build_translation_environment_report,
	translate_zh_to_en,
)


NODE_NAME = "GJJ_SAM3VideoTrackAIO"
DISPLAY_NAME = "GJJ · 🎯 SAM3.1视频跟踪一体机"
MODEL_KEYWORD = "sam3.1_multiplex"
DEFAULT_CHECKPOINT = "sam3.1_multiplex_fp16.safetensors"
MAX_ROUTES = 8
TRACK_DATA_TYPE = "SAM3_TRACK_DATA"
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"


class MultiInput(str):
	def __new__(cls, string: str, allowed_types="*"):
		instance = super().__new__(cls, string)
		instance.allowed_types = allowed_types
		return instance

	@staticmethod
	def _type_set(value):
		if isinstance(value, (list, tuple, set)):
			parts = []
			for item in value:
				parts.extend(str(item).split(","))
		else:
			parts = str(value).split(",")
		return {part.strip() for part in parts if part.strip()}

	def __ne__(self, other):
		if self.allowed_types == "*" or other == "*":
			return False
		allowed = self._type_set(self.allowed_types)
		incoming = self._type_set(other)
		return not (incoming.issubset(allowed) or allowed.issubset(incoming))


MEDIA_INPUT = MultiInput(MEDIA_INPUT_TYPE, ["GJJ_BATCH_IMAGE", "IMAGE", "VIDEO"])


def _checkpoint_list() -> list[str]:
	try:
		return list(folder_paths.get_filename_list("checkpoints") or [])
	except Exception:
		return []


def _pick_default_checkpoint() -> str:
	models = _checkpoint_list()
	for name in models:
		if MODEL_KEYWORD.lower() in str(name).lower():
			return name
	return models[0] if models else DEFAULT_CHECKPOINT


def _missing_model_specs() -> list[dict[str, str]]:
	if any(MODEL_KEYWORD.lower() in str(name).lower() for name in _checkpoint_list()):
		return []
	return [
		make_missing_model_spec(
			label="SAM3.1 Multiplex checkpoint",
			subdir="models/checkpoints",
			filename=DEFAULT_CHECKPOINT,
			description="本节点内部用它加载 MODEL/CLIP，并执行官方 SAM3 视频跟踪。",
		)
	]


_ENVIRONMENT_REPORT = build_dependency_model_report(
	node_name=DISPLAY_NAME,
	missing_models=_missing_model_specs(),
	description="请把包含 sam3.1_multiplex 字样的 SAM3.1 Multiplex checkpoint 放到 models/checkpoints 或其子目录。",
)
if not _ENVIRONMENT_REPORT.get("available", True):
	print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ SAM3 视频跟踪模型缺失！")

_TRANSLATION_ENVIRONMENT_REPORT = build_translation_environment_report(
	node_name=DISPLAY_NAME,
	description=(
		"SAM3 视频跟踪会先把跟踪目标文本翻译为英文，因此需要这些依赖和本地翻译模型包。"
		f"模型包请放到 {TRANSLATION_MODEL_SUBDIR}。"
	),
)
if not _TRANSLATION_ENVIRONMENT_REPORT.get("available", True):
	print_dependency_model_report(_TRANSLATION_ENVIRONMENT_REPORT, title="GJJ SAM3 视频跟踪翻译环境缺失！")


SAM31_MODEL_SPEC = make_missing_model_spec(
	label="SAM3.1 Multiplex checkpoint",
	subdir="models/checkpoints",
	filename=DEFAULT_CHECKPOINT,
	description="3.1 版本官方 Multiplex checkpoint；节点内部用 CheckpointLoaderSimple 加载 MODEL/CLIP。",
)
SAM31_MODEL_TREE = [
	{
		"label": DEFAULT_CHECKPOINT,
		"path": "models/checkpoints",
		"required": True,
		"description": "默认 SAM3.1 Multiplex checkpoint；实际执行时会优先匹配 checkpoints 列表中第一个包含 sam3.1_multiplex 的文件。",
	},
	{
		"label": TRANSLATION_BUNDLE_FILENAME,
		"path": "models/translation",
		"filename": TRANSLATION_BUNDLE_FILENAME,
		"required": True,
		"description": "GJJ 单文件 Opus-MT 中英翻译模型包，跟踪目标文本编码前固定使用。",
	}
]
SAM31_HELP = build_node_help_payload(
	description="把官方 CheckpointLoaderSimple、CLIPTextEncode、SAM3_VideoTrack 合成一个 GJJ 单节点；跟踪目标文本会先后台翻译为英文再编码。",
	notice=(
		_ENVIRONMENT_REPORT.get("warning_message")
		or _TRANSLATION_ENVIRONMENT_REPORT.get("warning_message")
		or "需要本地 SAM3.1 Multiplex checkpoint 和 Opus-MT 翻译模型包；输入图片/视频帧后按文本目标执行视频跟踪。"
	),
	dependencies=TRANSLATION_DEPENDENCY_SPECS,
	model_tree=SAM31_MODEL_TREE,
	models=[SAM31_MODEL_SPEC],
	usage=[
		"模型放在 models/checkpoints 下，默认使用 sam3.1_multiplex_fp16.safetensors。",
		"跟踪目标会先用 models/translation/opus-mt-zh-en.safetensors 自动翻译为英文，没有单独开关。",
		"输入支持 GJJ_BATCH_IMAGE、IMAGE batch 和官方 VIDEO。",
		"每一路输入独立执行跟踪，并输出对应的 SAM3_TRACK_DATA。",
	],
	runtime=[
		"CheckpointLoaderSimple 加载 SAM3.1 checkpoint。",
		"需要 ComfyUI 本身支持 SAM3.1 Multiplex checkpoint；旧版无法识别时会显示中文兼容提示。",
		"CLIPTextEncode 编码跟踪目标文本。",
		"SAM3_VideoTrack 对每一路视频帧执行目标跟踪。",
	],
	model_download_url=_ENVIRONMENT_REPORT.get("model_download_url", ""),
	copy_text="models/checkpoints/" + DEFAULT_CHECKPOINT,
	copy_label="📋 复制默认模型路径",
	extra={
		"static_model_tree_only": True,
		"warning_message": _ENVIRONMENT_REPORT.get("warning_message", ""),
		"notice_level": _ENVIRONMENT_REPORT.get("notice_level", "ok"),
		"missing_models": _ENVIRONMENT_REPORT.get("missing_models", []),
		"install_cmd": _ENVIRONMENT_REPORT.get("install_cmd", ""),
		"optional_install_cmd": _ENVIRONMENT_REPORT.get("optional_install_cmd", ""),
		"translation_notice": _TRANSLATION_ENVIRONMENT_REPORT.get("help_message", "")
		if not _TRANSLATION_ENVIRONMENT_REPORT.get("available", True)
		else "",
		"translation_install_cmd": _TRANSLATION_ENVIRONMENT_REPORT.get("install_cmd", ""),
		"translation_copy_text": _TRANSLATION_ENVIRONMENT_REPORT.get("copy_text", ""),
		"translation_model_download_url": _TRANSLATION_ENVIRONMENT_REPORT.get("model_download_url", ""),
		"model_download_url": TRANSLATION_MODEL_DOWNLOAD_URL,
	},
)


def _empty_track_data(images=None) -> dict[str, Any]:
	height = int(images.shape[1]) if isinstance(images, torch.Tensor) and images.ndim >= 3 else 1
	width = int(images.shape[2]) if isinstance(images, torch.Tensor) and images.ndim >= 3 else 1
	frames = int(images.shape[0]) if isinstance(images, torch.Tensor) and images.ndim >= 1 else 0
	return {
		"packed_masks": None,
		"orig_size": (height, width),
		"n_frames": frames,
		"scores": [],
	}


def _extract_images(value: Any) -> torch.Tensor | None:
	if value is None:
		return None
	if isinstance(value, torch.Tensor):
		if value.ndim == 3:
			return value.unsqueeze(0)
		if value.ndim == 4:
			return value
	if isinstance(value, dict):
		for key in ("images", "image", "frames"):
			images = _extract_images(value.get(key))
			if images is not None:
				return images
	if hasattr(value, "get_components"):
		components = value.get_components()
		return _extract_images(getattr(components, "images", None))
	if hasattr(value, "images"):
		return _extract_images(getattr(value, "images"))
	return None


def _extract_text_prompts(conditioning, device, dtype):
	cond_meta = conditioning[0][1]
	multi = cond_meta.get("sam3_multi_cond")
	prompts = []
	if multi is not None:
		for entry in multi:
			emb = entry["cond"].to(device=device, dtype=dtype)
			mask = entry["attention_mask"].to(device) if entry["attention_mask"] is not None else None
			if mask is None:
				mask = torch.ones(emb.shape[0], emb.shape[1], dtype=torch.int64, device=device)
			prompts.append((emb, mask, entry.get("max_detections", 1)))
	else:
		emb = conditioning[0][0].to(device=device, dtype=dtype)
		mask = cond_meta.get("attention_mask")
		if mask is not None:
			mask = mask.to(device)
		else:
			mask = torch.ones(emb.shape[0], emb.shape[1], dtype=torch.int64, device=device)
		prompts.append((emb, mask, 1))
	return prompts


_CHECKPOINT_CACHE: dict[str, Any] = {"key": None, "model": None, "clip": None}


def _raise_sam31_compatibility_error(ckpt_path: str, original_error: Exception):
	message = str(original_error)
	if "Could not detect model type" not in message:
		raise original_error
	raise RuntimeError(
		"SAM3.1 Multiplex 模型已找到，当前 ComfyUI 版本无法识别这种 checkpoint。请升级你的comfyui\n"
		"这个节点使用的是官方 SAM3.1 Multiplex / CheckpointLoaderSimple / CLIPTextEncode / SAM3_VideoTrack 路线，"
		"不能自动替换成 models/sam3 下的 SAM3 模型，因为 sam3 和 sam3.1 是两套不同结构。\n"
		f"模型路径：{ckpt_path}\n"
		"处理方式：请升级到带原生 SAM3.1 支持的 ComfyUI，或在新版 ComfyUI 中使用该节点。"
	) from original_error


def _load_checkpoint(ckpt_name: str, unique_id=None):
	available = _checkpoint_list()
	if not any(MODEL_KEYWORD.lower() in str(name).lower() for name in available):
		send_dependency_model_notice(_ENVIRONMENT_REPORT, unique_id=unique_id)
		raise_dependency_model_error(
			node_name=DISPLAY_NAME,
			missing_models=_missing_model_specs(),
			description="未在 models/checkpoints 中找到 sam3.1_multiplex。节点不会自动替换成其它 checkpoint。",
			unique_id=unique_id,
			title="GJJ SAM3 视频跟踪模型缺失！",
		)
	resolved = ckpt_name if ckpt_name in available else _pick_default_checkpoint()
	ckpt_path = folder_paths.get_full_path_or_raise("checkpoints", resolved)
	cache_key = hashlib.md5(str(ckpt_path).encode("utf-8")).hexdigest()
	if _CHECKPOINT_CACHE["key"] == cache_key and _CHECKPOINT_CACHE["model"] is not None:
		return _CHECKPOINT_CACHE["model"], _CHECKPOINT_CACHE["clip"], resolved
	try:
		model, clip, _vae = comfy.sd.load_checkpoint_guess_config(
			ckpt_path,
			output_vae=True,
			output_clip=True,
			embedding_directory=folder_paths.get_folder_paths("embeddings"),
		)[:3]
	except RuntimeError as exc:
		_raise_sam31_compatibility_error(ckpt_path, exc)
	_CHECKPOINT_CACHE.update({"key": cache_key, "model": model, "clip": clip})
	return model, clip, resolved


def _encode_text(clip, text: str):
	if clip is None:
		raise RuntimeError("checkpoint 中没有可用 CLIP，无法执行文本编码。")
	tokens = clip.tokenize(str(text or "").strip())
	return clip.encode_from_tokens_scheduled(tokens)


def _track_route(images, model, conditioning, detection_threshold, max_objects, detect_interval):
	if images is None:
		return _empty_track_data()
	if not isinstance(images, torch.Tensor) or images.ndim != 4:
		raise RuntimeError("输入必须能解析为 IMAGE batch 或官方 VIDEO 帧序列。")
	if images.shape[0] <= 0:
		return _empty_track_data(images)

	n_frames, height, width, _channels = images.shape
	comfy.model_management.load_model_gpu(model)
	device = comfy.model_management.get_torch_device()
	dtype = model.model.get_dtype()
	sam3_model = model.model.diffusion_model
	frames_in = images[..., :3].movedim(-1, 1)
	pbar = comfy.utils.ProgressBar(n_frames)
	text_prompts = [(emb, mask) for emb, mask, _ in _extract_text_prompts(conditioning, device, dtype)]
	result = sam3_model.forward_video(
		images=frames_in,
		initial_masks=None,
		pbar=pbar,
		text_prompts=text_prompts,
		new_det_thresh=float(detection_threshold),
		max_objects=int(max_objects),
		detect_interval=max(1, int(detect_interval)),
		target_device=device,
		target_dtype=dtype,
	)
	result["orig_size"] = (height, width)
	return result


class GJJ_SAM3VideoTrackAIO:
	DESCRIPTION = (
		"把官方 CheckpointLoaderSimple、CLIPTextEncode、SAM3_VideoTrack 合成一个 GJJ 单节点。"
		if _ENVIRONMENT_REPORT.get("available", True)
		else _ENVIRONMENT_REPORT.get("warning_message", "⚠️缺失模型，点击❓按钮了解详情。")
	)
	GJJ_HELP = {
		**SAM31_HELP,
	}
	CATEGORY = "GJJ/🖼️ 图像/分割/SAM3"
	FUNCTION = "track"
	RETURN_TYPES = tuple([TRACK_DATA_TYPE] * MAX_ROUTES)
	RETURN_NAMES = tuple([f"跟踪数据 {index}" for index in range(1, MAX_ROUTES + 1)])
	OUTPUT_TOOLTIPS = tuple(["SAM3 视频跟踪数据，可接官方 SAM3 Track Preview / Track To Mask 等后续节点。"] * MAX_ROUTES)

	@classmethod
	def INPUT_TYPES(cls):
		available = _checkpoint_list()
		default_model = _pick_default_checkpoint()
		return {
			"required": {
				"media_01": (MEDIA_INPUT, {
					"display_name": "图片/视频 1",
					"tooltip": "第一路输入，支持 GJJ_BATCH_IMAGE、普通 IMAGE batch 和官方 VIDEO。",
				}),
				"text_prompt": ("STRING", {
					"default": "person",
					"multiline": False,
					"display_name": "跟踪目标",
					"tooltip": "内部用 CLIPTextEncode 编码后交给 SAM3_VideoTrack，例如 person、car、dog。",
				}),
				"checkpoint": (available or [DEFAULT_CHECKPOINT], {
					"default": default_model,
					"display_name": "SAM3.1模型",
					"tooltip": "自动搜索 models/checkpoints 下第一个包含 sam3.1_multiplex 的模型作为默认值。",
				}),
				"detection_threshold": ("FLOAT", {
					"default": 0.5,
					"min": 0.0,
					"max": 1.0,
					"step": 0.01,
					"display_name": "检测阈值",
					"tooltip": "文本检测的新目标阈值，越高越保守。",
				}),
				"max_objects": ("INT", {
					"default": 4,
					"min": 0,
					"max": 64,
					"step": 1,
					"display_name": "最大对象数",
					"tooltip": "最多跟踪的对象数量；0 表示使用官方内部上限。",
				}),
				"detect_interval": ("INT", {
					"default": 1,
					"min": 1,
					"max": 999,
					"step": 1,
					"display_name": "检测间隔",
					"tooltip": "每隔多少帧重新执行一次文本检测，1 表示每帧检测。",
				}),
			},
			"optional": {
				**{
					f"media_{index:02d}": (MEDIA_INPUT, {
						"display_name": f"图片/视频 {index}",
						"tooltip": f"第 {index} 路独立输入，接上后前端会继续扩展下一路。",
					})
					for index in range(2, MAX_ROUTES + 1)
				},
			},
			"hidden": {
				"unique_id": "UNIQUE_ID",
			},
		}

	@classmethod
	def IS_CHANGED(cls, text_prompt, checkpoint, detection_threshold, max_objects, detect_interval, **kwargs):
		route_shapes = []
		for index in range(1, MAX_ROUTES + 1):
			images = _extract_images(kwargs.get(f"media_{index:02d}"))
			route_shapes.append(tuple(images.shape) if isinstance(images, torch.Tensor) else None)
		return json.dumps([text_prompt, checkpoint, detection_threshold, max_objects, detect_interval, route_shapes], ensure_ascii=False)

	def track(self, media_01, text_prompt, checkpoint, detection_threshold=0.5, max_objects=4, detect_interval=1, unique_id=None, **kwargs):
		source_text_prompt = str(text_prompt or "").strip()
		translated_text_prompt = source_text_prompt
		if source_text_prompt:
			translated_text_prompt = translate_zh_to_en(
				source_text_prompt,
				"auto",
				max_length=512,
				batch_size=8,
				unload_after_use=False,
				unique_id=unique_id,
				node_name=DISPLAY_NAME,
				preserve_chinese_quotes=False,
			).strip()
		model, clip, resolved = _load_checkpoint(checkpoint, unique_id=unique_id)
		conditioning = _encode_text(clip, translated_text_prompt)
		results = []
		for index in range(1, MAX_ROUTES + 1):
			media = media_01 if index == 1 else kwargs.get(f"media_{index:02d}")
			images = _extract_images(media)
			if images is None:
				results.append(_empty_track_data())
				continue
			try:
				results.append(_track_route(images, model, conditioning, detection_threshold, max_objects, detect_interval))
			except Exception as exc:
				raise RuntimeError(
					f"SAM3 视频跟踪第 {index} 路执行失败。\n"
					f"模型：{resolved}\n"
					f"原始目标：{source_text_prompt}\n"
					f"翻译目标：{translated_text_prompt}\n"
					f"详细错误：{exc}"
				) from exc
		return tuple(results)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SAM3VideoTrackAIO}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: DISPLAY_NAME}
