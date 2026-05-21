from __future__ import annotations

import base64
import io
import json
import os
import re
import sys
import tempfile
import types
import ast
from contextlib import nullcontext
from typing import Any

import comfy.model_management as mm
import comfy.utils
import folder_paths
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from .common_utils.mask_tools import GrowMask_execute
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE
from .common_utils.dependency_checker import (
	DEFAULT_MODEL_DOWNLOAD_URL,
	build_dependency_model_report,
	load_dependency_at_runtime,
	print_dependency_model_report,
	send_dependency_model_notice,
)


NODE_NAME = "GJJ_SAM2PointMaskEditor"
NODE_DISPLAY_NAME = "GJJ · 🎯 点选遮罩队列"
NODE_DESCRIPTION_INTRO = "GJJ 零依赖点选遮罩节点：内置 SAM2 分割、遮罩扩张、块化与遮罩覆盖预览。"
VENDOR_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "vendor"))
if VENDOR_ROOT not in sys.path:
	sys.path.insert(0, VENDOR_ROOT)
SAM2_MODEL_CATEGORY = "sam2"
SAM2_MODEL_SUBDIR = "models/sam2"
SAM2_MODEL_EXTENSIONS = (".safetensors", ".pt", ".pth")
SAM2_REQUIRED_MODEL_FILES = (
	"sam2_hiera_base_plus.safetensors",
	"sam2.1_hiera_base_plus-fp16.safetensors",
	"sam2.1_hiera_large-fp16.safetensors",
)
SAM2_MODEL_DOWNLOAD_URL = DEFAULT_MODEL_DOWNLOAD_URL
DEPENDENCY_SPECS: list[dict[str, str]] = [
	{
		"module_name": "iopath.common.file_io",
		"package_name": "iopath",
		"display_name": "iopath",
		"description": "SAM2 内置运行时使用 iopath 进行文件路径管理。",
	},
]


SAM2_CONFIG_MAP = {
	"sam2_hiera_tiny": "sam2_hiera_tiny.yaml",
	"sam2_hiera_small": "sam2_hiera_small.yaml",
	"sam2_hiera_base_plus": "sam2_hiera_base_plus.yaml",
	"sam2_hiera_large": "sam2_hiera_large.yaml",
	"sam2.1_hiera_tiny": "sam2_1_hiera_tiny.yaml",
	"sam2.1_hiera_small": "sam2_1_hiera_small.yaml",
	"sam2.1_hiera_base_plus": "sam2_1_hiera_base_plus.yaml",
	"sam2.1_hiera_large": "sam2_1_hiera_large.yaml",
	"sam2_1_hiera_tiny": "sam2_1_hiera_tiny.yaml",
	"sam2_1_hiera_small": "sam2_1_hiera_small.yaml",
	"sam2_1_hiera_base_plus": "sam2_1_hiera_base_plus.yaml",
	"sam2_1_hiera_large": "sam2_1_hiera_large.yaml",
}

_MODEL_CACHE: dict[tuple[str, str, str, str], dict[str, Any]] = {}
_PRINTED_ENV_REPORT_KEYS: set[str] = set()


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
	if not unique_id:
		return
	try:
		from server import PromptServer
		payload = {"node": str(unique_id), "text": str(text or "")}
		if progress is not None:
			payload["progress"] = float(progress)
		PromptServer.instance.send_sync("gjj_node_progress", payload)
	except Exception:
		pass


def _normalize_key(value: str) -> str:
	return (
		str(value or "")
		.lower()
		.replace("\\", "")
		.replace("/", "")
		.replace("_", "")
		.replace("-", "")
		.replace(".", "")
		.replace(" ", "")
	)


def _ensure_sam2_model_folder() -> str:
	root = os.path.join(folder_paths.models_dir, SAM2_MODEL_CATEGORY)
	try:
		folder_paths.add_model_folder_path(SAM2_MODEL_CATEGORY, root)
	except Exception:
		pass
	return root


def _list_sam2_models() -> list[str]:
	root = _ensure_sam2_model_folder()
	results: list[str] = []
	seen: set[str] = set()
	try:
		for item in folder_paths.get_filename_list(SAM2_MODEL_CATEGORY):
			name = str(item or "").replace("/", "\\")
			if not name.lower().endswith(SAM2_MODEL_EXTENSIONS):
				continue
			key = name.lower()
			if key in seen:
				continue
			seen.add(key)
			results.append(name)
	except Exception:
		pass
	if os.path.isdir(root):
		for base, _, files in os.walk(root):
			for name in files:
				if not name.lower().endswith(SAM2_MODEL_EXTENSIONS):
					continue
				rel = os.path.relpath(os.path.join(base, name), root).replace("/", "\\")
				key = rel.lower()
				if key in seen:
					continue
				seen.add(key)
				results.append(rel)
	return sorted(results, key=lambda item: (item.count("\\"), item.lower()))


def _pick_available_name(requested: str, available: list[str], fallback: str = "sam2_hiera_base_plus.safetensors") -> str:
	if not available:
		return fallback
	for candidate in (requested, fallback):
		if candidate and candidate in available:
			return candidate
	for candidate in (requested, fallback):
		if not candidate:
			continue
		base = os.path.basename(candidate).lower()
		for item in available:
			if os.path.basename(item).lower() == base:
				return item
	target = _normalize_key(requested or fallback)
	if target:
		for item in available:
			if target in _normalize_key(item) or _normalize_key(item) in target:
				return item
	return available[0]


def _resolve_model_path(model_name: str) -> str:
	root = _ensure_sam2_model_folder()
	try:
		resolved = folder_paths.get_full_path(SAM2_MODEL_CATEGORY, str(model_name or ""))
		if resolved and os.path.isfile(resolved):
			return resolved
	except Exception:
		pass
	candidate = os.path.join(root, str(model_name or ""))
	if os.path.isfile(candidate):
		return candidate
	base = os.path.basename(str(model_name or "")).lower()
	if os.path.isdir(root):
		for dirpath, _, files in os.walk(root):
			for filename in files:
				if filename.lower() == base:
					return os.path.join(dirpath, filename)
	raise RuntimeError(f"未找到 SAM2 模型文件：models/sam2/{model_name}")


def _resolve_config_name(model_name: str) -> str:
	stem = os.path.basename(str(model_name or "")).lower()
	for suffix in (".safetensors", ".pth", ".pt", ".ckpt"):
		if stem.endswith(suffix):
			stem = stem[: -len(suffix)]
	stem = stem.replace("-fp16", "").replace("-bf16", "").replace("_fp16", "").replace("_bf16", "")
	if stem in SAM2_CONFIG_MAP:
		return SAM2_CONFIG_MAP[stem]
	norm = _normalize_key(stem)
	for key, config in SAM2_CONFIG_MAP.items():
		if _normalize_key(key) == norm:
			return config
		if _normalize_key(key) in norm:
			return config
	raise RuntimeError(f"未找到与模型匹配的 SAM2 配置：{model_name}")


def _strip_yaml_comment(line: str) -> str:
	in_single = False
	in_double = False
	for index, char in enumerate(line):
		if char == "'" and not in_double:
			in_single = not in_single
		elif char == '"' and not in_single:
			in_double = not in_double
		elif char == "#" and not in_single and not in_double:
			return line[:index]
	return line


def _parse_yaml_scalar(raw: str) -> Any:
	text = str(raw or "").strip()
	if text == "":
		return {}
	lower = text.lower()
	if lower in {"true", "false"}:
		return lower == "true"
	if lower in {"null", "none", "~"}:
		return None
	python_text = re.sub(r"\btrue\b", "True", text, flags=re.IGNORECASE)
	python_text = re.sub(r"\bfalse\b", "False", python_text, flags=re.IGNORECASE)
	python_text = re.sub(r"\bnull\b", "None", python_text, flags=re.IGNORECASE)
	try:
		return ast.literal_eval(python_text)
	except Exception:
		pass
	try:
		if re.fullmatch(r"[-+]?\d+", text):
			return int(text)
		if re.fullmatch(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:e[-+]?\d+)?", text, flags=re.IGNORECASE):
			return float(text)
	except Exception:
		pass
	return text.strip("\"'")


def _parse_simple_yaml_config(config_path: str) -> dict[str, Any]:
	root: dict[str, Any] = {}
	stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]
	with open(config_path, "r", encoding="utf-8") as stream:
		for raw_line in stream:
			line = _strip_yaml_comment(raw_line.rstrip())
			if not line.strip() or line.strip() in {"---", "..."}:
				continue
			indent = len(line) - len(line.lstrip(" "))
			text = line.strip()
			if ":" not in text:
				continue
			key, value_text = text.split(":", 1)
			key = key.strip().strip("\"'")
			while stack and indent <= stack[-1][0]:
				stack.pop()
			parent = stack[-1][1]
			value_text = value_text.strip()
			if value_text == "":
				value: dict[str, Any] = {}
				parent[key] = value
				stack.append((indent, value))
			else:
				parent[key] = _parse_yaml_scalar(value_text)
	return root


def _load_yaml_config(config_path: str) -> dict[str, Any]:
	try:
		import yaml
		with open(config_path, "r", encoding="utf-8") as stream:
			data = yaml.safe_load(stream)
		if isinstance(data, dict):
			return data
	except Exception:
		pass
	return _parse_simple_yaml_config(config_path)


def _is_under_path(path: str, root: str) -> bool:
	try:
		path_abs = os.path.abspath(path)
		root_abs = os.path.abspath(root)
		return path_abs == root_abs or path_abs.startswith(root_abs + os.sep)
	except Exception:
		return False


def _ensure_gjj_sam2_package() -> None:
	package_root = os.path.join(VENDOR_ROOT, "sam2")
	if not os.path.isdir(package_root):
		raise RuntimeError("GJJ 内置 SAM2 运行时不完整，请重新复制完整的 GJJ 节点包。")
	existing = sys.modules.get("sam2")
	existing_paths = [os.path.abspath(str(path)) for path in getattr(existing, "__path__", [])] if existing else []
	if os.path.abspath(package_root) in existing_paths:
		return
	for module_name, module in list(sys.modules.items()):
		if module_name != "sam2" and not module_name.startswith("sam2."):
			continue
		module_file = str(getattr(module, "__file__", "") or "")
		if not module_file or not _is_under_path(module_file, package_root):
			sys.modules.pop(module_name, None)
	package = types.ModuleType("sam2")
	package.__file__ = os.path.join(package_root, "__init__.py")
	package.__path__ = [package_root]
	package.__package__ = "sam2"
	sys.modules["sam2"] = package


def _load_sam2_runtime() -> dict[str, Any]:
	_ensure_gjj_sam2_package()

	# 运行时依赖检查（使用公共函数，从 DEPENDENCY_SPECS 读取）
	for spec in DEPENDENCY_SPECS:
		load_dependency_at_runtime(
			module_name=spec["module_name"],
			node_name=NODE_DISPLAY_NAME,
			package_name=spec["package_name"],
			description=spec["description"],
		)

	try:
		from sam2.modeling.sam2_base import SAM2Base
		from sam2.modeling.backbones.image_encoder import FpnNeck, ImageEncoder
		from sam2.modeling.backbones.hieradet import Hiera
		from sam2.modeling.memory_attention import MemoryAttention, MemoryAttentionLayer
		from sam2.modeling.memory_encoder import CXBlock, Fuser, MaskDownSampler, MemoryEncoder
		from sam2.modeling.position_encoding import PositionEmbeddingSine
		from sam2.modeling.sam.transformer import RoPEAttention
		from sam2.sam2_image_predictor import SAM2ImagePredictor
		from sam2.sam2_video_predictor import SAM2VideoPredictor
	except Exception as exc:
		raise RuntimeError(f"GJJ 内置 SAM2 运行时加载失败：{exc}") from exc
	return {
		"SAM2Base": SAM2Base,
		"FpnNeck": FpnNeck,
		"ImageEncoder": ImageEncoder,
		"Hiera": Hiera,
		"MemoryAttention": MemoryAttention,
		"MemoryAttentionLayer": MemoryAttentionLayer,
		"CXBlock": CXBlock,
		"Fuser": Fuser,
		"MaskDownSampler": MaskDownSampler,
		"MemoryEncoder": MemoryEncoder,
		"PositionEmbeddingSine": PositionEmbeddingSine,
		"RoPEAttention": RoPEAttention,
		"SAM2ImagePredictor": SAM2ImagePredictor,
		"SAM2VideoPredictor": SAM2VideoPredictor,
	}


def _load_state_dict(model_path: str) -> dict[str, Any]:
	state = comfy.utils.load_torch_file(model_path, safe_load=True)
	if isinstance(state, dict) and "model" in state and isinstance(state["model"], dict):
		return state["model"]
	if isinstance(state, dict):
		return state
	raise RuntimeError(f"SAM2 模型权重格式无效：{os.path.basename(model_path)}")


def _position_encoding(config: dict[str, Any], runtime: dict[str, Any]):
	return runtime["PositionEmbeddingSine"](
		num_pos_feats=config["num_pos_feats"],
		normalize=bool(config["normalize"]),
		scale=config.get("scale"),
		temperature=config["temperature"],
	)


def _rope_attention(config: dict[str, Any], runtime: dict[str, Any]):
	return runtime["RoPEAttention"](
		rope_theta=config.get("rope_theta", 10000.0),
		feat_sizes=config.get("feat_sizes", (64, 64)),
		rope_k_repeat=bool(config.get("rope_k_repeat", False)),
		embedding_dim=config["embedding_dim"],
		num_heads=config["num_heads"],
		downsample_rate=config.get("downsample_rate", 1),
		dropout=config.get("dropout", 0.0),
		kv_in_dim=config.get("kv_in_dim"),
	)


def _build_sam2_components(model_config: dict[str, Any], runtime: dict[str, Any]) -> tuple[Any, Any, Any]:
	image_encoder_config = model_config["image_encoder"]
	trunk_config = image_encoder_config["trunk"]
	neck_config = image_encoder_config["neck"]
	neck = runtime["FpnNeck"](
		position_encoding=_position_encoding(neck_config["position_encoding"], runtime),
		d_model=neck_config["d_model"],
		backbone_channel_list=neck_config["backbone_channel_list"],
		fpn_top_down_levels=neck_config.get("fpn_top_down_levels"),
		fpn_interp_model=neck_config.get("fpn_interp_model", "nearest"),
	)
	trunk_keys = [
		"embed_dim",
		"num_heads",
		"drop_path_rate",
		"q_pool",
		"q_stride",
		"stages",
		"dim_mul",
		"head_mul",
		"window_pos_embed_bkg_spatial_size",
		"window_spec",
		"global_att_blocks",
		"return_interm_layers",
	]
	trunk_kwargs = {key: trunk_config[key] for key in trunk_keys if key in trunk_config}
	trunk = runtime["Hiera"](**trunk_kwargs)
	image_encoder = runtime["ImageEncoder"](
		scalp=image_encoder_config.get("scalp", 0),
		trunk=trunk,
		neck=neck,
	)

	memory_attention_config = model_config["memory_attention"]
	layer_config = memory_attention_config["layer"]
	memory_attention_layer = runtime["MemoryAttentionLayer"](
		activation=layer_config["activation"],
		dim_feedforward=layer_config["dim_feedforward"],
		dropout=layer_config["dropout"],
		pos_enc_at_attn=layer_config["pos_enc_at_attn"],
		self_attention=_rope_attention(layer_config["self_attention"], runtime),
		d_model=layer_config["d_model"],
		pos_enc_at_cross_attn_keys=layer_config["pos_enc_at_cross_attn_keys"],
		pos_enc_at_cross_attn_queries=layer_config["pos_enc_at_cross_attn_queries"],
		cross_attention=_rope_attention(layer_config["cross_attention"], runtime),
	)
	memory_attention = runtime["MemoryAttention"](
		d_model=memory_attention_config["d_model"],
		pos_enc_at_input=memory_attention_config["pos_enc_at_input"],
		layer=memory_attention_layer,
		num_layers=memory_attention_config["num_layers"],
	)

	memory_encoder_config = model_config["memory_encoder"]
	mask_downsampler_config = memory_encoder_config["mask_downsampler"]
	fuser_layer_config = memory_encoder_config["fuser"]["layer"]
	fuser_layer = runtime["CXBlock"](
		dim=fuser_layer_config["dim"],
		kernel_size=fuser_layer_config.get("kernel_size", 7),
		padding=fuser_layer_config.get("padding", 3),
		layer_scale_init_value=float(fuser_layer_config.get("layer_scale_init_value", 1e-6)),
		use_dwconv=bool(fuser_layer_config.get("use_dwconv", True)),
	)
	fuser = runtime["Fuser"](
		num_layers=memory_encoder_config["fuser"]["num_layers"],
		layer=fuser_layer,
	)
	memory_encoder = runtime["MemoryEncoder"](
		position_encoding=_position_encoding(memory_encoder_config["position_encoding"], runtime),
		mask_downsampler=runtime["MaskDownSampler"](
			kernel_size=mask_downsampler_config["kernel_size"],
			stride=mask_downsampler_config["stride"],
			padding=mask_downsampler_config["padding"],
		),
		fuser=fuser,
		out_dim=memory_encoder_config["out_dim"],
	)
	return image_encoder, memory_attention, memory_encoder


def _build_sam2_model(model_path: str, segmentor: str, device: torch.device, dtype: torch.dtype) -> dict[str, Any]:
	runtime = _load_sam2_runtime()
	config_dir = os.path.join(VENDOR_ROOT, "sam2_configs")
	config_name = _resolve_config_name(model_path)
	config_path = os.path.join(config_dir, config_name)
	if not os.path.isfile(config_path):
		raise RuntimeError("GJJ 内置 SAM2 配置不完整，请重新复制完整的 GJJ 节点包。")
	config = _load_yaml_config(config_path)
	model_config = config["model"]
	image_encoder, memory_attention, memory_encoder = _build_sam2_components(model_config, runtime)
	sam_mask_decoder_extra_args = {
		"dynamic_multimask_via_stability": True,
		"dynamic_multimask_stability_delta": 0.05,
		"dynamic_multimask_stability_thresh": 0.98,
	}
	model_kwargs = {
		"image_encoder": image_encoder,
		"memory_attention": memory_attention,
		"memory_encoder": memory_encoder,
		"sam_mask_decoder_extra_args": sam_mask_decoder_extra_args,
		"num_maskmem": model_config.get("num_maskmem", 7),
		"image_size": model_config.get("image_size", 1024),
		"sigmoid_scale_for_mem_enc": model_config.get("sigmoid_scale_for_mem_enc", 1.0),
		"sigmoid_bias_for_mem_enc": model_config.get("sigmoid_bias_for_mem_enc", 0.0),
		"use_mask_input_as_output_without_sam": model_config.get("use_mask_input_as_output_without_sam", False),
		"max_cond_frames_in_attn": model_config.get("max_cond_frames_in_attn", -1),
		"directly_add_no_mem_embed": model_config.get("directly_add_no_mem_embed", False),
		"use_high_res_features_in_sam": model_config.get("use_high_res_features_in_sam", False),
		"multimask_output_in_sam": model_config.get("multimask_output_in_sam", False),
		"multimask_min_pt_num": model_config.get("multimask_min_pt_num", 1),
		"multimask_max_pt_num": model_config.get("multimask_max_pt_num", 1),
		"multimask_output_for_tracking": model_config.get("multimask_output_for_tracking", False),
		"use_multimask_token_for_obj_ptr": model_config.get("use_multimask_token_for_obj_ptr", False),
		"iou_prediction_use_sigmoid": model_config.get("iou_prediction_use_sigmoid", False),
		"memory_temporal_stride_for_eval": model_config.get("memory_temporal_stride_for_eval", 1),
		"non_overlap_masks_for_mem_enc": model_config.get("non_overlap_masks_for_mem_enc", False),
		"use_obj_ptrs_in_encoder": model_config.get("use_obj_ptrs_in_encoder", False),
		"max_obj_ptrs_in_encoder": model_config.get("max_obj_ptrs_in_encoder", 16),
		"add_tpos_enc_to_obj_ptrs": model_config.get("add_tpos_enc_to_obj_ptrs", True),
		"proj_tpos_enc_in_obj_ptrs": model_config.get("proj_tpos_enc_in_obj_ptrs", False),
		"use_signed_tpos_enc_to_obj_ptrs": model_config.get("use_signed_tpos_enc_to_obj_ptrs", False),
		"only_obj_ptrs_in_the_past_for_eval": model_config.get("only_obj_ptrs_in_the_past_for_eval", False),
		"pred_obj_scores": model_config.get("pred_obj_scores", False),
		"pred_obj_scores_mlp": model_config.get("pred_obj_scores_mlp", False),
		"fixed_no_obj_ptr": model_config.get("fixed_no_obj_ptr", False),
		"soft_no_obj_ptr": model_config.get("soft_no_obj_ptr", False),
		"use_mlp_for_obj_ptr_proj": model_config.get("use_mlp_for_obj_ptr_proj", False),
		"no_obj_embed_spatial": model_config.get("no_obj_embed_spatial", False),
		"compile_image_encoder": False,
		"binarize_mask_from_pts_for_mem_enc": segmentor == "video",
	}
	if segmentor == "video":
		model = runtime["SAM2VideoPredictor"](fill_hole_area=0, **model_kwargs)
	else:
		model = runtime["SAM2Base"](**model_kwargs)
	state_dict = _load_state_dict(model_path)
	missing, unexpected = model.load_state_dict(state_dict, strict=False)
	if unexpected:
		raise RuntimeError(f"SAM2 模型加载失败，存在未知权重：{unexpected[:5]}")
	if missing:
		raise RuntimeError(f"SAM2 模型加载失败，缺少权重：{missing[:5]}")
	model = model.to(device=device, dtype=dtype).eval()
	if segmentor == "single_image":
		model = runtime["SAM2ImagePredictor"](model)
	version = "2.1" if "2.1" in os.path.basename(model_path).lower() else "2.0"
	return {"model": model, "dtype": dtype, "device": device, "segmentor": segmentor, "version": version}


def _model_cache_key(model_path: str, segmentor: str, device: torch.device, dtype: torch.dtype) -> tuple[str, str, str, str]:
	return (os.path.abspath(model_path), segmentor, str(device), str(dtype))


def _get_sam2_model(model_name: str, segmentor: str, device_name: str, precision: str, keep_model_loaded: bool) -> dict[str, Any]:
	if device_name == "auto":
		device = mm.get_torch_device()
	elif device_name == "cuda" and not torch.cuda.is_available():
		device = torch.device("cpu")
	else:
		device = torch.device(device_name)
	if device.type == "cpu" and precision != "fp32":
		precision = "fp32"
	dtype = {"fp16": torch.float16, "bf16": torch.bfloat16, "fp32": torch.float32}.get(precision, torch.float32)
	model_path = _resolve_model_path(model_name)
	key = _model_cache_key(model_path, segmentor, device, dtype)
	if keep_model_loaded and key in _MODEL_CACHE:
		return _MODEL_CACHE[key]
	container = _build_sam2_model(model_path, segmentor, device, dtype)
	if keep_model_loaded:
		_MODEL_CACHE[key] = container
	return container


def _ensure_image_batch(value: Any) -> torch.Tensor:
	if value is None:
		raise RuntimeError("请连接图片、批量图片或 VIDEO 输入。")
	if hasattr(value, "get_components"):
		components = value.get_components()
		value = getattr(components, "images", None)
	elif hasattr(value, "images"):
		value = getattr(value, "images", None)
	elif isinstance(value, dict) and isinstance(value.get("images"), torch.Tensor):
		value = value.get("images")
	if not isinstance(value, torch.Tensor):
		raise RuntimeError(f"输入不是有效的图片/视频帧张量：{type(value).__name__}")
	images = value
	if images.ndim == 3:
		images = images.unsqueeze(0)
	if images.ndim != 4:
		raise RuntimeError(f"图片/视频帧维度无效：{tuple(images.shape)}")
	if int(images.shape[-1]) == 4:
		rgb = images[..., :3]
		alpha = images[..., 3:4].clamp(0.0, 1.0)
		images = rgb * alpha
	elif int(images.shape[-1]) == 1:
		images = images.repeat(1, 1, 1, 3)
	elif int(images.shape[-1]) > 4:
		images = images[..., :3]
	return images.detach().float().clamp(0.0, 1.0).contiguous()


def _load_stored_image(raw: str) -> torch.Tensor | None:
	text = str(raw or "").strip()
	if not text:
		return None
	try:
		path = folder_paths.get_annotated_filepath(text)
	except Exception:
		path = text
	if not path or not os.path.exists(path):
		return None
	with Image.open(path) as img:
		img.load()
		array = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
	return torch.from_numpy(array).unsqueeze(0).float().contiguous()


def _safe_json(raw: Any, fallback: Any) -> Any:
	if isinstance(raw, (list, dict)):
		return raw
	try:
		return json.loads(str(raw or ""))
	except Exception:
		return fallback


def _parse_points(raw: Any, width: int, height: int, default_kind: str) -> list[tuple[int, int]]:
	data = _safe_json(raw, [])
	if isinstance(data, dict):
		for key in ("positive", "negative", "points", "coordinates", "neg_coordinates"):
			if isinstance(data.get(key), list):
				data = data[key]
				break
	points: list[tuple[int, int]] = []
	for item in data if isinstance(data, list) else []:
		if isinstance(item, dict):
			x, y = item.get("x"), item.get("y")
		elif isinstance(item, (list, tuple)) and len(item) >= 2:
			x, y = item[0], item[1]
		else:
			continue
		try:
			points.append((int(round(float(x))), int(round(float(y)))))
		except Exception:
			continue
	if points:
		return points
	if default_kind == "positive":
		return [(int(round(width / 2)), int(round(height / 2)))]
	if default_kind == "negative":
		return [(max(0, min(width, int(round(width * 0.05)))), max(0, min(height, int(round(height * 0.05)))))]
	return []


def _parse_boxes(raw: Any) -> list[list[float]]:
	data = _safe_json(raw, [])
	boxes: list[list[float]] = []
	for item in data if isinstance(data, list) else []:
		if isinstance(item, dict):
			values = [item.get("startX"), item.get("startY"), item.get("endX"), item.get("endY")]
		elif isinstance(item, (list, tuple)) and len(item) >= 4:
			values = list(item[:4])
		else:
			continue
		try:
			x1, y1, x2, y2 = [float(v) for v in values]
		except Exception:
			continue
		boxes.append([min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)])
	return boxes


def _points_and_labels(pos_points: list[tuple[int, int]], neg_points: list[tuple[int, int]]) -> tuple[np.ndarray, np.ndarray]:
	points = pos_points + neg_points
	labels = ([1] * len(pos_points)) + ([0] * len(neg_points))
	return np.asarray(points, dtype=np.float32), np.asarray(labels, dtype=np.int32)


def _segment_single_image(container: dict[str, Any], images: torch.Tensor, pos_points, neg_points, boxes) -> torch.Tensor:
	predictor = container["model"]
	device = container["device"]
	dtype = container["dtype"]
	coords, labels = _points_and_labels(pos_points, neg_points)
	input_box = np.asarray(boxes[0], dtype=np.float32) if boxes else None
	mask_list: list[torch.Tensor] = []
	image_np = (images.detach().cpu().contiguous() * 255.0).byte().numpy()
	autocast_condition = device.type not in {"cpu", "mps"}
	autocast_context = torch.autocast(mm.get_autocast_device(device), dtype=dtype) if autocast_condition else nullcontext()
	with torch.no_grad(), autocast_context:
		for index in range(int(image_np.shape[0])):
			predictor.set_image(image_np[index])
			out_masks, scores, _ = predictor.predict(
				point_coords=coords if len(coords) else None,
				point_labels=labels if len(labels) else None,
				box=input_box,
				multimask_output=True,
			)
			best_index = int(np.argsort(scores)[::-1][0]) if len(scores) else 0
			mask = torch.from_numpy(out_masks[best_index]).float()
			mask_list.append(mask)
	return torch.stack(mask_list, dim=0).cpu().float()


def _segment_video(container: dict[str, Any], images: torch.Tensor, pos_points, neg_points, boxes) -> torch.Tensor:
	model = container["model"]
	device = container["device"]
	dtype = container["dtype"]
	_, height, width, _ = images.shape
	coords, labels = _points_and_labels(pos_points, neg_points)
	input_box = np.asarray(boxes[0], dtype=np.float32) if boxes else None
	autocast_condition = device.type not in {"cpu", "mps"}
	autocast_context = torch.autocast(mm.get_autocast_device(device), dtype=dtype) if autocast_condition else nullcontext()
	model_input_image_size = int(getattr(model, "image_size", 1024))
	model_images = comfy.utils.common_upscale(
		images.movedim(-1, 1),
		model_input_image_size,
		model_input_image_size,
		"bilinear",
		"disabled",
	).movedim(1, -1)
	with torch.no_grad(), autocast_context:
		inference_state = model.init_state(
			model_images.permute(0, 3, 1, 2).contiguous(),
			int(height),
			int(width),
			device=device,
		)
		model.add_new_points_or_box(
			inference_state=inference_state,
			frame_idx=0,
			obj_id=1,
			points=coords if len(coords) else None,
			labels=labels if len(labels) else None,
			clear_old_points=True,
			box=input_box,
		)
		frame_masks: dict[int, torch.Tensor] = {}
		for frame_index, object_ids, mask_logits in model.propagate_in_video(inference_state):
			combined = torch.zeros((height, width), dtype=torch.float32, device="cpu")
			for idx, _object_id in enumerate(object_ids):
				mask = (mask_logits[idx] > 0.0).detach().float().cpu()
				while mask.ndim > 2:
					mask = mask.squeeze(0)
				if tuple(mask.shape) != (height, width):
					mask = F.interpolate(mask[None, None], size=(height, width), mode="nearest").squeeze(0).squeeze(0)
				combined = torch.maximum(combined, mask)
			frame_masks[int(frame_index)] = combined
		try:
			model.reset_state(inference_state)
		except Exception:
			pass
	out = [frame_masks.get(i, torch.zeros((height, width), dtype=torch.float32)) for i in range(int(images.shape[0]))]
	return torch.stack(out, dim=0).cpu().float()


def _blockify_mask(mask: torch.Tensor, block_size: int) -> torch.Tensor:
	block_size = max(1, int(block_size))
	if block_size <= 1:
		return mask.float().clamp(0.0, 1.0)
	mask = mask.float().clamp(0.0, 1.0)
	result = torch.zeros_like(mask)
	for index in range(int(mask.shape[0])):
		mask_bool = mask[index] > 0
		if not bool(mask_bool.any()):
			continue
		y_indices = torch.nonzero(mask_bool.any(dim=1), as_tuple=True)[0]
		x_indices = torch.nonzero(mask_bool.any(dim=0), as_tuple=True)[0]
		y_min, y_max = int(y_indices[0]), int(y_indices[-1])
		x_min, x_max = int(x_indices[0]), int(x_indices[-1])
		bbox_width = x_max - x_min + 1
		bbox_height = y_max - y_min + 1
		w_divisions = max(1, bbox_width // block_size)
		h_divisions = max(1, bbox_height // block_size)
		w_slice = max(1, bbox_width // w_divisions)
		h_slice = max(1, bbox_height // h_divisions)
		for by in range(h_divisions):
			y0 = y_min + by * h_slice
			y1 = y_max + 1 if by == h_divisions - 1 else min(y_max + 1, y0 + h_slice)
			for bx in range(w_divisions):
				x0 = x_min + bx * w_slice
				x1 = x_max + 1 if bx == w_divisions - 1 else min(x_max + 1, x0 + w_slice)
				if bool(mask_bool[y0:y1, x0:x1].any()):
					result[index, y0:y1, x0:x1] = 1.0
	return result


def _parse_color(color: str) -> tuple[torch.Tensor, float]:
	text = str(color or "0, 0, 0").strip()
	values: list[float] = []
	if text.startswith("#"):
		hex_text = text[1:]
		if len(hex_text) in (3, 4):
			values = [int(char * 2, 16) / 255.0 for char in hex_text]
		elif len(hex_text) in (6, 8):
			values = [int(hex_text[i:i + 2], 16) / 255.0 for i in range(0, len(hex_text), 2)]
	else:
		for part in text.split(","):
			try:
				value = float(part.strip())
				values.append(value / 255.0 if value > 1.0 else value)
			except Exception:
				pass
	if len(values) < 3:
		values = [0.0, 0.0, 0.0]
	alpha = float(values[3]) if len(values) >= 4 else 1.0
	return torch.tensor(values[:3], dtype=torch.float32), max(0.0, min(alpha, 1.0))


def _cover_image_with_mask(images: torch.Tensor, masks: torch.Tensor, color: str) -> torch.Tensor:
	if tuple(masks.shape[-2:]) != tuple(images.shape[1:3]):
		masks = F.interpolate(masks[:, None], size=tuple(images.shape[1:3]), mode="nearest").squeeze(1)
	if int(masks.shape[0]) < int(images.shape[0]):
		repeat = (int(images.shape[0]) + int(masks.shape[0]) - 1) // max(1, int(masks.shape[0]))
		masks = masks.repeat(repeat, 1, 1)[: int(images.shape[0])]
	elif int(masks.shape[0]) > int(images.shape[0]):
		masks = masks[: int(images.shape[0])]
	fill_color, alpha = _parse_color(color)
	fill_color = fill_color.to(device=images.device, dtype=images.dtype)
	blend = masks.to(device=images.device, dtype=images.dtype).clamp(0.0, 1.0).unsqueeze(-1) * alpha
	return (images * (1.0 - blend) + fill_color.view(1, 1, 1, 3) * blend).detach().cpu().float().contiguous()


def _image_to_base64(image: torch.Tensor) -> str:
	array = np.clip(image[0].detach().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
	buffer = io.BytesIO()
	Image.fromarray(array).save(buffer, format="PNG")
	return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _missing_dependency_specs() -> list[dict[str, str]]:
	missing: list[dict[str, str]] = []
	for spec in DEPENDENCY_SPECS:
		module_name = str(spec.get("module_name") or "")
		if not module_name:
			continue
		try:
			__import__(module_name)
			continue
		except Exception:
			pass
		missing.append(spec)
	return missing


def _required_model_entries() -> list[dict[str, str]]:
	return [
		{
			"label": "SAM2 Base Plus",
			"name": "SAM2 Base Plus",
			"subdir": SAM2_MODEL_SUBDIR,
			"filename": "sam2_hiera_base_plus.safetensors",
			"path": f"{SAM2_MODEL_SUBDIR}/sam2_hiera_base_plus.safetensors",
			"download_url": SAM2_MODEL_DOWNLOAD_URL,
			"description": "默认优先匹配的 SAM2 点选遮罩模型。",
		},
		{
			"label": "SAM2.1 Base Plus FP16",
			"name": "SAM2.1 Base Plus FP16",
			"subdir": SAM2_MODEL_SUBDIR,
			"filename": "sam2.1_hiera_base_plus-fp16.safetensors",
			"path": f"{SAM2_MODEL_SUBDIR}/sam2.1_hiera_base_plus-fp16.safetensors",
			"download_url": SAM2_MODEL_DOWNLOAD_URL,
			"description": "推荐用于 video 模式和框选提示。",
		},
		{
			"label": "SAM2.1 Large FP16",
			"name": "SAM2.1 Large FP16",
			"subdir": SAM2_MODEL_SUBDIR,
			"filename": "sam2.1_hiera_large-fp16.safetensors",
			"path": f"{SAM2_MODEL_SUBDIR}/sam2.1_hiera_large-fp16.safetensors",
			"download_url": SAM2_MODEL_DOWNLOAD_URL,
			"description": "更高质量的 SAM2.1 大模型，可选。",
		},
	]


def _missing_model_specs() -> list[dict[str, str]]:
	available = _list_sam2_models()
	if available:
		return []
	required = _required_model_entries()
	return [required[0]]


def _report_key(report: dict[str, Any]) -> str:
	deps = ",".join(
		str(dep.get("module_name") or dep.get("package_name") or "")
		for dep in report.get("missing_dependencies", [])
	)
	models = ",".join(
		str(model.get("path") or model.get("filename") or model.get("label") or "")
		for model in report.get("missing_models", [])
	)
	return f"{deps}|{models}"


def _print_env_report_once(report: dict[str, Any], *, title: str = "GJJ 节点运行环境缺失！") -> None:
	key = _report_key(report)
	if key in _PRINTED_ENV_REPORT_KEYS:
		return
	_PRINTED_ENV_REPORT_KEYS.add(key)
	print_dependency_model_report(report, title=title)


def _build_env_report(original_error: str = "", *, include_runtime_dependencies: bool = False) -> dict[str, Any]:
	missing_dependencies = _missing_dependency_specs() if include_runtime_dependencies else []
	missing_models = _missing_model_specs()
	install_packages = [spec["package_name"] for spec in missing_dependencies if spec.get("package_name")]
	report = build_dependency_model_report(
		node_name=NODE_DISPLAY_NAME,
		missing_dependencies=missing_dependencies,
		missing_models=missing_models,
		install_packages=install_packages,
		description=NODE_DESCRIPTION_INTRO,
		original_error=original_error,
		model_download_url=SAM2_MODEL_DOWNLOAD_URL,
	)
	report["node_name"] = NODE_DISPLAY_NAME
	return report


_ENV_REPORT = _build_env_report()
_DEPENDENCIES_AVAILABLE = bool(_ENV_REPORT.get("dependencies_available"))
_MODELS_AVAILABLE = bool(_ENV_REPORT.get("models_available"))
_MISSING_DEPENDENCIES = list(_ENV_REPORT.get("missing_dependencies") or [])
_MISSING_MODELS = list(_ENV_REPORT.get("missing_models") or [])
if not (_DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE):
	_print_env_report_once(_ENV_REPORT)

_DESCRIPTION_READY = f"{NODE_DESCRIPTION_INTRO}\n\n🌏模型下载：{SAM2_MODEL_DOWNLOAD_URL}"
DESCRIPTION = (
	_DESCRIPTION_READY
	if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
	else f"{_ENV_REPORT['warning_message']}\n\n{_DESCRIPTION_READY}"
)


class GJJ_SAM2PointMaskEditor:
	DESCRIPTION = DESCRIPTION
	REQUIRED_MODELS = _required_model_entries()
	GJJ_HELP = {
		"title": NODE_DISPLAY_NAME,
		"description": DESCRIPTION,
		"🌏模型下载": SAM2_MODEL_DOWNLOAD_URL,
		"models": REQUIRED_MODELS,
		"dependencies": [
			{
				"name": spec["display_name"],
				"package": spec["package_name"],
				"description": spec["description"],
			}
			for spec in DEPENDENCY_SPECS
		],
		"help": (
			_ENV_REPORT["help_message"]
			if not _ENV_REPORT.get("available")
			else (
				"使用 GJJ 内置 SAM2 运行时。\n"
				"模型放在 models/sam2；默认优先匹配 sam2_hiera_base_plus.safetensors，"
				"video 模式带框选时建议使用 sam2.1_hiera_base_plus-fp16.safetensors。"
			)
		),
		"install_cmd": _ENV_REPORT.get("install_cmd", ""),
	}
	OUTPUT_NODE = True
	SEARCH_ALIASES = ["SAM2", "点选遮罩", "遮罩队列", "视频遮罩", "批量遮罩"]

	@classmethod
	def INPUT_TYPES(cls):
		available = _list_sam2_models()
		default_model = _pick_available_name("sam2_hiera_base_plus.safetensors", available)
		return {
			"required": {
				"sam2_model": (available or ["sam2_hiera_base_plus.safetensors"], {
					"default": default_model,
					"display_name": "SAM2 模型",
					"tooltip": "从 models/sam2 动态读取本地模型；默认优先匹配 sam2_hiera_base_plus.safetensors。",
				}),
				"segmentor": (["video", "single_image"], {
					"default": "video",
					"display_name": "分割模式",
					"tooltip": "video 会按首帧点位传播到整段图片/视频队列；single_image 会逐帧独立点选分割。",
				}),
				"device": (["auto", "cuda", "cpu", "mps"], {
					"default": "auto",
					"display_name": "运行设备",
					"tooltip": "auto 使用 ComfyUI 当前推理设备；CPU 会自动使用 fp32。",
				}),
				"precision": (["fp16", "bf16", "fp32"], {
					"default": "fp16",
					"display_name": "模型精度",
					"tooltip": "来自原工作流的 fp16；CPU 模式会自动回退到 fp32。",
				}),
				"expand": ("INT", {
					"default": 10,
					"min": -256,
					"max": 256,
					"step": 1,
					"display_name": "遮罩扩张",
					"tooltip": "内置 GrowMask；正数扩张，负数收缩。",
				}),
				"tapered_corners": ("BOOLEAN", {
					"default": True,
					"display_name": "圆角扩张",
					"tooltip": "对应原工作流 GrowMask 的 tapered_corners。",
				}),
				"block_size": ("INT", {
					"default": 32,
					"min": 1,
					"max": 512,
					"step": 1,
					"display_name": "块化大小",
					"tooltip": "内置 BlockifyMask；值越小，遮罩块越细。",
				}),
				"color": ("STRING", {
					"default": "0, 0, 0",
					"multiline": False,
					"display_name": "覆盖颜色",
					"tooltip": "内置 DrawMaskOnImage 的遮罩覆盖颜色，支持 R,G,B 或 R,G,B,A，也支持 #RRGGBB。",
				}),
				"keep_model_loaded": ("BOOLEAN", {
					"default": True,
					"display_name": "缓存模型",
					"tooltip": "开启后同模型重复执行会复用已加载模型，适合反复调点位。",
				}),
				"coordinates": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "正向点数据",
					"tooltip": "前端点选编辑器内部使用。",
				}),
				"neg_coordinates": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "负向点数据",
					"tooltip": "前端点选编辑器内部使用。",
				}),
				"bboxes": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "框选数据",
					"tooltip": "前端点选编辑器内部使用。",
				}),
				"editor_state": ("STRING", {
					"default": "{}",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "编辑器状态",
					"tooltip": "前端点选编辑器内部状态。",
				}),
				"image_store": ("STRING", {
					"default": "",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "本地图片存储",
					"tooltip": "前端按钮载入图片时使用。",
				}),
			},
			"optional": {
				"image": ("GJJ_BATCH_IMAGE,IMAGE,VIDEO", {
					"display_name": "输入图片/视频",
					"tooltip": "可接单张 IMAGE、IMAGE batch、GJJ_BATCH_IMAGE 或官方 VIDEO；输出会保持对应帧队列。也可用面板按钮临时载入单张图片。",
				}),
			},
			"hidden": {
				"unique_id": "UNIQUE_ID",
			},
		}

	RETURN_TYPES = ("MASK", "GJJ_BATCH_IMAGE,IMAGE")
	RETURN_NAMES = ("遮罩队列", "遮罩覆盖图像队列")
	OUTPUT_TOOLTIPS = (
		"输出 GrowMask 扩展后的单张遮罩或按输入帧数排列的遮罩队列。",
		"输出被遮罩颜色覆盖后的图片或图片队列，可直接预览或继续接 GJJ_BATCH_IMAGE/IMAGE。",
	)
	FUNCTION = "segment"
	CATEGORY = "GJJ/工具"

	def segment(
		self,
		sam2_model,
		segmentor,
		device,
		precision,
		expand,
		tapered_corners,
		block_size,
		color,
		keep_model_loaded,
		coordinates="[]",
		neg_coordinates="[]",
		bboxes="[]",
		editor_state="{}",
		image_store="",
		image=None,
		unique_id=None,
	):
		runtime_report = _build_env_report(include_runtime_dependencies=True)
		if not runtime_report.get("available"):
			_send_status(unique_id, runtime_report.get("warning_message", "运行环境缺失"), 0.0)
			_print_env_report_once(runtime_report, title="GJJ 节点运行时依赖或模型缺失！")
			send_dependency_model_notice(runtime_report, unique_id=unique_id)
			raise RuntimeError(runtime_report.get("panel_message") or runtime_report.get("warning_message") or "SAM2 运行环境缺失。")

		images = _ensure_image_batch(image if image is not None else _load_stored_image(image_store))
		_, height, width, _ = images.shape
		state = _safe_json(editor_state, {})
		if isinstance(state, dict):
			coordinates = state.get("positive", state.get("coordinates", coordinates))
			neg_coordinates = state.get("negative", state.get("neg_coordinates", neg_coordinates))
			bboxes = state.get("boxes", state.get("bboxes", bboxes))
		pos_points = _parse_points(coordinates, int(width), int(height), "positive")
		neg_points = _parse_points(neg_coordinates, int(width), int(height), "negative")
		box_list = _parse_boxes(bboxes)

		available = _list_sam2_models()
		model_name = _pick_available_name(sam2_model, available, "sam2_hiera_base_plus.safetensors")
		segmentor = "video" if str(segmentor) == "video" else "single_image"

		try:
			_send_status(unique_id, f"加载 SAM2 模型：{model_name}", 0.05)
			container = _get_sam2_model(model_name, segmentor, str(device), str(precision), bool(keep_model_loaded))
			if segmentor == "video" and box_list and "2.1" not in str(container.get("version", "")):
				raise RuntimeError("SAM2 2.0 的 video 分割模式不支持框选范围。请改用 sam2.1 模型，或把分割模式切到 single_image。")
			_send_status(unique_id, f"执行 {segmentor} 点选分割：{int(images.shape[0])} 帧", 0.28)
			if segmentor == "video":
				mask = _segment_video(container, images, pos_points, neg_points, box_list)
			else:
				mask = _segment_single_image(container, images, pos_points, neg_points, box_list)

			_send_status(unique_id, "执行遮罩扩张与块化...", 0.72)
			expanded_mask = GrowMask_execute(mask, int(expand), bool(tapered_corners))["mask"].float().clamp(0.0, 1.0)
			blockified_mask = _blockify_mask(expanded_mask, int(block_size))
			covered = _cover_image_with_mask(images, blockified_mask, str(color))
			_send_status(unique_id, f"完成：{int(expanded_mask.shape[0])} 张遮罩，尺寸 {int(expanded_mask.shape[2])} x {int(expanded_mask.shape[1])}", 1.0)
			return {
				"ui": {
					"bg_image": [_image_to_base64(images[:1])],
				},
				"result": (expanded_mask.detach().cpu().float().contiguous(), covered),
			}
		except RuntimeError as exc:
			report = getattr(exc, "gjj_report", None)
			if report:
				report["node_name"] = NODE_DISPLAY_NAME
				_send_status(unique_id, report.get("warning_message", "运行时依赖缺失"), 0.0)
				send_dependency_model_notice(report, unique_id=unique_id)
			raise
		finally:
			if not bool(keep_model_loaded):
				try:
					key_path = _resolve_model_path(model_name)
					device_obj = mm.get_torch_device() if str(device) == "auto" else torch.device(str(device))
					dtype = {"fp16": torch.float16, "bf16": torch.bfloat16, "fp32": torch.float32}.get(str(precision), torch.float32)
					_MODEL_CACHE.pop(_model_cache_key(key_path, segmentor, device_obj, dtype), None)
					mm.soft_empty_cache()
				except Exception:
					pass


NODE_CLASS_MAPPINGS = {
	NODE_NAME: GJJ_SAM2PointMaskEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
	NODE_NAME: "GJJ · 🎯 点选遮罩队列",
}
