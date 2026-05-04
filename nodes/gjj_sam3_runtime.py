from __future__ import annotations

import base64
import gc
import hashlib
import io
import json
import os
import sys
from typing import Any

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageDraw

import comfy.model_management
import comfy.utils
from comfy.model_patcher import ModelPatcher


VENDOR_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "vendor"))
if VENDOR_ROOT not in sys.path:
	sys.path.insert(0, VENDOR_ROOT)

# 清除其他自定义节点可能已缓存的同名 sam3 模块
sys.modules.pop("sam3", None)
for key in list(sys.modules):
	if key == "sam3" or key.startswith("sam3."):
		del sys.modules[key]

# 强制从 GJJ vendor 导入，不受其他包的 sam3 遮蔽
import importlib.util
_vendor_sam3 = os.path.abspath(os.path.join(VENDOR_ROOT, "sam3", "__init__.py"))
_spec = importlib.util.spec_from_file_location("sam3", _vendor_sam3)
_sam3 = importlib.util.module_from_spec(_spec)
sys.modules["sam3"] = _sam3
_spec.loader.exec_module(_sam3)
build_sam3_video_model = _sam3.build_sam3_video_model
_load_checkpoint_file = _sam3._load_checkpoint_file
remap_video_checkpoint = _sam3.remap_video_checkpoint  # type: ignore  # noqa: E402
from sam3.predictor import Sam3VideoPredictor  # type: ignore  # noqa: E402
from sam3.utils import Sam3Processor  # type: ignore  # noqa: E402
from sam3.attention import set_sam3_dtype  # type: ignore  # noqa: E402

from .gjj_model_name_resolver import pick_available_model_name  # noqa: E402


_SAM3_CACHE: dict[str, Any] = {"config_hash": None, "model": None}


def send_status(unique_id: Any, text: str) -> None:
	if not unique_id:
		return
	try:
		from server import PromptServer
		PromptServer.instance.send_sync(
			"gjj_node_progress",
			{"node": str(unique_id), "text": str(text or "")},
		)
	except Exception:
		pass


def normalize_key(value: str) -> str:
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


def list_sam3_models() -> list[str]:
	root = os.path.join(folder_paths.models_dir, "sam3")
	results: list[str] = []
	seen: set[str] = set()
	if not os.path.isdir(root):
		return results
	for base, _, files in os.walk(root):
		for name in files:
			if not name.lower().endswith((".pt", ".pth", ".safetensors")):
				continue
			rel = os.path.relpath(os.path.join(base, name), root).replace("/", "\\")
			key = rel.lower()
			if key in seen:
				continue
			seen.add(key)
			results.append(rel)
	return sorted(results, key=lambda item: (item.count("\\"), item.lower()))


def pick_available_name(requested: str, available: list[str], fallback: str = "") -> str:
	return pick_available_model_name(requested, available, fallback, allow_first=False)


def resolve_model_path(model_name: str) -> str:
	root = os.path.join(folder_paths.models_dir, "sam3")
	if not os.path.isdir(root):
		raise RuntimeError(f"未找到 models/sam3 目录，需要文件：models/sam3/{model_name or 'sam3.safetensors'}")
	available = list_sam3_models()
	resolved_name = pick_available_name(model_name, available, "")
	if not resolved_name:
		required = model_name or "sam3.safetensors"
		raise RuntimeError(f"未匹配到 SAM3 模型，需要文件：models/sam3/{required}")
	candidate = os.path.join(root, resolved_name)
	if os.path.isfile(candidate):
		return candidate
	raise RuntimeError(f"未找到 SAM3 模型文件，需要文件：models/sam3/{resolved_name}")


def _resolve_dtype(dtype_name: str) -> torch.dtype:
	if dtype_name == "auto":
		device = comfy.model_management.get_torch_device()
		if comfy.model_management.should_use_bf16(device):
			return torch.bfloat16
		if comfy.model_management.should_use_fp16(device):
			return torch.float16
		return torch.float32
	return {
		"bf16": torch.bfloat16,
		"fp16": torch.float16,
		"fp32": torch.float32,
	}.get(dtype_name, torch.float32)


class SAM3UnifiedModel(ModelPatcher):
	def __init__(self, video_predictor, processor, load_device, offload_device, dtype=None):
		self._video_predictor = video_predictor
		self._processor = processor
		self._load_device = load_device
		self._offload_device = offload_device
		self._model_dtype = dtype or torch.float32
		full_model = video_predictor.model
		model_size = comfy.model_management.module_size(full_model)
		super().__init__(
			model=full_model,
			load_device=load_device,
			offload_device=offload_device,
			size=model_size,
			weight_inplace_update=False,
		)

	@property
	def processor(self):
		return self._processor

	@property
	def current_device(self):
		return self.model.device

	def patch_model(self, device_to=None, lowvram_model_memory=0, load_weights=True, force_patch_weights=False):
		result = super().patch_model(device_to, lowvram_model_memory, load_weights, force_patch_weights)
		if device_to is None:
			device_to = self._load_device
		self._sync_processor_device(device_to)
		self._sync_model_device(device_to)
		return result

	def unpatch_model(self, device_to=None, unpatch_weights=True):
		super().unpatch_model(device_to, unpatch_weights)
		if device_to is None:
			device_to = self._offload_device
		self._sync_processor_device(device_to)
		self._sync_model_device(device_to)

	def clone(self):
		node = SAM3UnifiedModel(
			self._video_predictor,
			self._processor,
			self._load_device,
			self._offload_device,
			dtype=self._model_dtype,
		)
		node.patches = {}
		node.object_patches = {}
		node.model_options = {"transformer_options": {}}
		return node

	def model_size(self):
		return comfy.model_management.module_size(self.model)

	def memory_required(self, input_shape=None):
		base_memory = self.model_size()
		activation_memory = 1008 * 1008 * 256 * 4 * 10
		return base_memory + activation_memory

	def _sync_model_device(self, device):
		self.model.device = device
		if hasattr(self.model, "inst_interactive_predictor"):
			pred = self.model.inst_interactive_predictor
			if hasattr(pred, "model"):
				pred.model.device = device

	def _sync_processor_device(self, device):
		if hasattr(self._processor, "device"):
			self._processor.device = device
		if hasattr(self._processor, "find_stage") and self._processor.find_stage is not None:
			fs = self._processor.find_stage
			if hasattr(fs, "img_ids") and fs.img_ids is not None:
				fs.img_ids = fs.img_ids.to(device)
			if hasattr(fs, "text_ids") and fs.text_ids is not None:
				fs.text_ids = fs.text_ids.to(device)


def get_or_build_model(model_name: str, precision: str = "auto", compile_model: bool = False):
	model_path = resolve_model_path(model_name)
	dtype = _resolve_dtype(precision)
	config = {
		"checkpoint_path": model_path,
		"dtype": {torch.bfloat16: "bf16", torch.float16: "fp16", torch.float32: "fp32"}[dtype],
		"compile": bool(compile_model),
	}
	config_hash = hashlib.md5(json.dumps(config, sort_keys=True).encode("utf-8")).hexdigest()
	if _SAM3_CACHE["config_hash"] == config_hash and _SAM3_CACHE["model"] is not None:
		return _SAM3_CACHE["model"]

	load_device = comfy.model_management.get_torch_device()
	offload_device = comfy.model_management.unet_offload_device()

	with torch.device("meta"):
		model = build_sam3_video_model(
			checkpoint_path=None,
			load_from_HF=False,
			enable_inst_interactivity=True,
			compile=bool(compile_model),
			skip_checkpoint=True,
		)

	ckpt = _load_checkpoint_file(model_path)
	remapped_ckpt = remap_video_checkpoint(ckpt, enable_inst_interactivity=True)
	del ckpt
	missing_keys, unexpected_keys = model.load_state_dict(remapped_ckpt, strict=False, assign=True)
	del remapped_ckpt
	if unexpected_keys:
		raise RuntimeError(f"SAM3 模型加载失败，存在未知权重：{unexpected_keys[:5]}")

	for name, buf in list(model.named_buffers()):
		if buf.device.type == "meta":
			parts = name.split(".")
			parent = model
			for part in parts[:-1]:
				parent = getattr(parent, part)
			attr_name = parts[-1]
			if attr_name == "attn_mask" and hasattr(parent, "build_causal_mask"):
				parent._buffers[attr_name] = parent.build_causal_mask()
			else:
				parent._buffers[attr_name] = torch.zeros_like(buf, device="cpu")

	model.eval()

	video_predictor = Sam3VideoPredictor(
		enable_inst_interactivity=True,
		compile=bool(compile_model),
		model=model,
	)
	set_sam3_dtype(dtype if dtype != torch.float32 else None)

	if dtype != torch.float32:
		detector = video_predictor.model.detector
		for param in detector.backbone.parameters():
			param.data = param.data.to(dtype=dtype)
		if detector.inst_interactive_predictor is not None:
			for param in detector.inst_interactive_predictor.parameters():
				param.data = param.data.to(dtype=dtype)

	processor = Sam3Processor(
		model=video_predictor.model.detector,
		resolution=1008,
		device=str(load_device),
		confidence_threshold=0.2,
	)

	unified_model = SAM3UnifiedModel(
		video_predictor=video_predictor,
		processor=processor,
		load_device=load_device,
		offload_device=offload_device,
		dtype=dtype,
	)
	_SAM3_CACHE["config_hash"] = config_hash
	_SAM3_CACHE["model"] = unified_model
	return unified_model


def comfy_image_to_pil(image: torch.Tensor) -> Image.Image:
	if image.dim() == 4:
		image = image[0]
	img_np = np.clip(image.cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
	return Image.fromarray(img_np)


def pil_to_comfy_image(pil_image: Image.Image) -> torch.Tensor:
	if pil_image.mode != "RGB":
		pil_image = pil_image.convert("RGB")
	img_np = np.array(pil_image).astype(np.float32) / 255.0
	return torch.from_numpy(img_np).unsqueeze(0)


def masks_to_comfy_mask(masks: torch.Tensor | np.ndarray) -> torch.Tensor:
	if isinstance(masks, np.ndarray):
		masks = torch.from_numpy(masks)
	masks = masks.float()
	if masks.ndim == 4 and masks.shape[1] == 1:
		masks = masks.squeeze(1)
	return masks.cpu()


def tensor_to_list(tensor):
	if isinstance(tensor, torch.Tensor):
		return tensor.float().cpu().tolist()
	return tensor


def visualize_masks_on_image(image, masks, boxes=None, scores=None, alpha=0.5):
	if isinstance(image, torch.Tensor):
		image = comfy_image_to_pil(image)
	elif isinstance(image, np.ndarray):
		image = Image.fromarray((image * 255).astype(np.uint8) if image.max() <= 1.0 else image.astype(np.uint8))

	if isinstance(masks, torch.Tensor):
		masks_t = masks
	else:
		masks_t = torch.from_numpy(np.asarray(masks))

	device = masks_t.device if masks_t.is_cuda else torch.device("cpu")
	img_t = torch.from_numpy(np.array(image)).to(device=device, dtype=torch.float32) / 255.0
	height, width = img_t.shape[:2]
	overlay = img_t.clone()
	colors = torch.tensor([
		[0.0, 1.0, 1.0],
		[1.0, 1.0, 0.0],
		[1.0, 0.0, 1.0],
		[0.0, 1.0, 0.0],
		[1.0, 0.5, 0.0],
		[1.0, 0.412, 0.706],
		[0.255, 0.412, 0.882],
		[0.125, 0.698, 0.667],
	], device=device)

	for i in range(masks_t.shape[0]):
		mask = masks_t[i]
		while mask.ndim > 2:
			mask = mask.squeeze(0)
		if mask.shape[0] != height or mask.shape[1] != width:
			mask = torch.nn.functional.interpolate(mask[None, None].float(), size=(height, width), mode="nearest")[0, 0]
		mask_3d = (mask > 0.5).unsqueeze(-1)
		color = colors[i % len(colors)]
		overlay = torch.where(mask_3d, overlay * (1 - alpha) + color * alpha, overlay)

	result_np = (overlay.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
	result = Image.fromarray(result_np)

	if boxes is not None:
		draw = ImageDraw.Draw(result)
		boxes_np = boxes.float().cpu().numpy() if isinstance(boxes, torch.Tensor) else boxes
		colors_np = (colors.float().cpu().numpy() * 255).astype(int)
		for i, box in enumerate(boxes_np):
			x0, y0, x1, y1 = box
			color_int = tuple(colors_np[i % len(colors_np)].tolist())
			draw.rectangle([x0, y0, x1, y1], outline=color_int, width=3)
			if scores is not None:
				score = scores[i] if isinstance(scores, (list, np.ndarray)) else scores[i].item()
				draw.text((x0, max(0, y0 - 15)), f"{score:.2f}", fill=color_int)
	return result


def image_to_base64(image: torch.Tensor) -> str:
	array = np.clip(image[0].cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
	buffer = io.BytesIO()
	Image.fromarray(array).save(buffer, format="PNG")
	return base64.b64encode(buffer.getvalue()).decode("utf-8")
