from __future__ import annotations

import base64
import io
import json
import os
import sys
from typing import Any

import cv2
import folder_paths
import numpy as np
import torch
import comfy.utils
from hydra import compose, initialize_config_dir
from hydra.core.global_hydra import GlobalHydra
from hydra.utils import instantiate


NODE_NAME = "GJJ_SEM2PointSegmenter"
VENDOR_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "vendor"))
if VENDOR_ROOT not in sys.path:
	sys.path.insert(0, VENDOR_ROOT)

from sam2.sam2_image_predictor import SAM2ImagePredictor  # type: ignore  # noqa: E402


SAM2_CONFIG_MAP = {
	"sam2_hiera_tiny": "sam2_hiera_tiny.yaml",
	"sam2_hiera_small": "sam2_hiera_small.yaml",
	"sam2_hiera_base_plus": "sam2_hiera_base_plus.yaml",
	"sam2_hiera_large": "sam2_hiera_large.yaml",
	"sam2_1_hiera_tiny": "sam2_1_hiera_tiny.yaml",
	"sam2_1_hiera_small": "sam2_1_hiera_small.yaml",
	"sam2_1_hiera_base_plus": "sam2_1_hiera_base_plus.yaml",
	"sam2_1_hiera_large": "sam2_1_hiera_large.yaml",
}


def _send_status(unique_id: Any, text: str) -> None:
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


def _list_sam2_models() -> list[str]:
	search_roots = [
		os.path.join(folder_paths.models_dir, "sam2"),
	]
	results: list[str] = []
	seen: set[str] = set()
	for root in search_roots:
		if not os.path.isdir(root):
			continue
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


def _pick_available_name(requested: str, available: list[str], fallback: str = "") -> str:
	if not available:
		return ""
	requested = str(requested or "").strip()
	fallback = str(fallback or "").strip()
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
	norm_target = _normalize_key(requested or fallback)
	if norm_target:
		for item in available:
			if norm_target in _normalize_key(item):
				return item
	return available[0]


def _resolve_model_path(model_name: str) -> str:
	search_roots = [
		os.path.join(folder_paths.models_dir, "sam2"),
	]
	for root in search_roots:
		candidate = os.path.join(root, model_name)
		if os.path.isfile(candidate):
			return candidate
	base = os.path.basename(model_name).lower()
	for root in search_roots:
		if not os.path.isdir(root):
			continue
		for dirpath, _, files in os.walk(root):
			for filename in files:
				if filename.lower() == base:
					return os.path.join(dirpath, filename)
	raise RuntimeError(f"未找到 SAM2 模型文件：{model_name}")


def _resolve_config_name(model_name: str) -> str:
	base = os.path.basename(model_name).lower()
	base = base.removesuffix(".safetensors").removesuffix(".pth").removesuffix(".pt")
	base = base.replace("2.1", "2_1")
	if base in SAM2_CONFIG_MAP:
		return SAM2_CONFIG_MAP[base]
	norm = _normalize_key(base)
	for key, value in SAM2_CONFIG_MAP.items():
		if _normalize_key(key) == norm:
			return value
	raise RuntimeError(f"未找到与模型匹配的 SAM2 配置：{model_name}")


def _build_sam2_model(model_path: str):
	config_name = _resolve_config_name(model_path)
	config_dir = os.path.join(VENDOR_ROOT, "sam2_configs")
	if GlobalHydra().is_initialized():
		GlobalHydra.instance().clear()
	initialize_config_dir(version_base=None, config_dir=config_dir)
	cfg = compose(config_name=config_name)
	model = instantiate(cfg.model, _recursive_=True)
	state_dict = comfy.utils.load_torch_file(model_path, safe_load=True)
	if isinstance(state_dict, dict) and "model" in state_dict and isinstance(state_dict["model"], dict):
		state_dict = state_dict["model"]
	missing, unexpected = model.load_state_dict(state_dict, strict=False)
	if unexpected:
		raise RuntimeError(f"SAM2 模型加载失败，存在未知权重：{unexpected[:5]}")
	if missing:
		raise RuntimeError(f"SAM2 模型加载失败，缺少权重：{missing[:5]}")
	device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
	model = model.to(device)
	model.eval()
	return model


def _parse_points(raw: str) -> list[tuple[int, int]]:
	if not str(raw or "").strip():
		return []
	try:
		data = json.loads(raw)
	except Exception as exc:
		raise RuntimeError("点位数据格式无效，请重新点击标注。") from exc
	if isinstance(data, dict):
		if isinstance(data.get("positive"), list):
			data = data.get("positive")
		elif isinstance(data.get("points"), list):
			data = [{"x": point[0], "y": point[1]} for point in data.get("points") if isinstance(point, (list, tuple)) and len(point) >= 2]
		else:
			data = []
	points: list[tuple[int, int]] = []
	for item in data or []:
		if not isinstance(item, dict):
			continue
		x = item.get("x")
		y = item.get("y")
		if x is None or y is None:
			continue
		points.append((int(round(float(x))), int(round(float(y)))))
	return points


def _mask_to_image(mask: np.ndarray) -> torch.Tensor:
	mask_rgb = np.repeat(mask[:, :, None].astype(np.float32), 3, axis=2)
	return torch.from_numpy(mask_rgb).unsqueeze(0)


def _image_to_preview(image: torch.Tensor, mask: np.ndarray, points_pos, points_neg) -> torch.Tensor:
	frame = np.clip(image[0].cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
	overlay = frame.copy()
	overlay[mask > 0] = (
		0.55 * overlay[mask > 0] + 0.45 * np.array([255, 80, 60], dtype=np.float32)
	).astype(np.uint8)
	for x, y in points_pos:
		cv2.circle(overlay, (int(x), int(y)), 6, (60, 255, 120), -1)
		cv2.circle(overlay, (int(x), int(y)), 10, (15, 40, 15), 2)
	for x, y in points_neg:
		cv2.circle(overlay, (int(x), int(y)), 6, (255, 90, 90), -1)
		cv2.circle(overlay, (int(x), int(y)), 10, (60, 10, 10), 2)
	return torch.from_numpy(overlay.astype(np.float32) / 255.0).unsqueeze(0)


def _encode_preview_image(image: torch.Tensor) -> str:
	from PIL import Image

	array = np.clip(image[0].cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
	buffer = io.BytesIO()
	Image.fromarray(array).save(buffer, format="PNG")
	return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _grow_mask(mask: np.ndarray, expand: int) -> np.ndarray:
	if expand <= 0:
		return mask
	kernel = np.ones((expand, expand), np.uint8)
	return cv2.dilate(mask.astype(np.uint8), kernel, iterations=1)


def _blockify_mask(mask: np.ndarray, block_size: int) -> np.ndarray:
	if block_size <= 1:
		return mask.astype(np.uint8)
	height, width = mask.shape
	result = np.zeros_like(mask, dtype=np.uint8)
	for y in range(0, height, block_size):
		for x in range(0, width, block_size):
			block = mask[y:y + block_size, x:x + block_size]
			if np.any(block > 0):
				result[y:y + block_size, x:x + block_size] = 1
	return result


class GJJ_SEM2PointSegmenter:
	DESCRIPTION = "将工作流中的 SEM2 点选分割、遮罩膨胀、块化和预览收成单节点。连接首帧图像后执行一次即可在面板点击人物，输出角色遮罩与预览图。"

	@classmethod
	def INPUT_TYPES(cls):
		available = _list_sam2_models()
		default_model = _pick_available_name("sam2_hiera_base_plus.safetensors", available, "")
		return {
			"required": {
				"image": ("IMAGE", {
					"display_name": "输入图像",
					"tooltip": "接入视频首帧或任意角色图像，点选后会输出角色遮罩。",
				}),
				"sam2_model": (available or ["sam2_hiera_base_plus.safetensors"], {
					"display_name": "SEM2 模型",
					"tooltip": "自动搜索本地 models/sam2 目录及其子目录。",
					"default": default_model or "sam2_hiera_base_plus.safetensors",
				}),
				"expand": ("INT", {
					"default": 10,
					"min": 0,
					"max": 256,
					"step": 1,
					"display_name": "遮罩扩张",
					"tooltip": "对分割结果做向外膨胀，类似工作流中的 GrowMask。",
				}),
				"block_size": ("INT", {
					"default": 32,
					"min": 1,
					"max": 256,
					"step": 1,
					"display_name": "块化大小",
					"tooltip": "将遮罩按方块聚合，类似工作流中的 BlockifyMask。",
				}),
				"positive_points": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display_name": "正向点",
					"tooltip": "前端点击人物后自动写入，不需要手动编辑。",
				}),
				"negative_points": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display_name": "负向点",
					"tooltip": "前端右键点击背景后自动写入，不需要手动编辑。",
				}),
			},
		}

	RETURN_TYPES = ("MASK", "IMAGE")
	RETURN_NAMES = ("角色分割遮罩", "分割预览图像")
	OUTPUT_TOOLTIPS = (
		"适合直接接入 WanAnimateToVideo 的 character_mask。",
		"叠加了点位与遮罩的预览图，方便确认选区。",
	)
	FUNCTION = "segment"
	CATEGORY = "GJJ"

	def segment(
		self,
		image: torch.Tensor,
		sam2_model: str,
		expand: int,
		block_size: int,
		positive_points: str,
		negative_points: str,
		unique_id: Any = None,
	):
		try:
			_send_status(unique_id, "加载 SEM2 模型...")
			pos_points = _parse_points(positive_points)
			neg_points = _parse_points(negative_points)
			if not pos_points:
				raise RuntimeError("请先在面板图像上左键点击人物，至少添加一个正向点。")

			model_name = _pick_available_name(sam2_model, _list_sam2_models(), sam2_model)
			model_path = _resolve_model_path(model_name)
			model = _build_sam2_model(model_path)
			predictor = SAM2ImagePredictor(model)

			_send_status(unique_id, "执行点选分割...")
			frame = np.clip(image[0].cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
			frame_rgb = frame[:, :, :3]
			predictor.set_image(frame_rgb)
			point_coords = np.array(pos_points + neg_points, dtype=np.float32)
			point_labels = np.array(([1] * len(pos_points)) + ([0] * len(neg_points)), dtype=np.int32)
			masks, scores, _ = predictor.predict(
				point_coords=point_coords,
				point_labels=point_labels,
				box=None,
				multimask_output=True,
			)
			best_index = int(np.argmax(scores)) if len(scores) else 0
			mask = masks[best_index].astype(np.uint8)

			_send_status(unique_id, "整理遮罩...")
			mask = _grow_mask(mask, int(expand))
			mask = _blockify_mask(mask, int(block_size))
			preview = _image_to_preview(image, mask, pos_points, neg_points)
			mask_tensor = torch.from_numpy(mask.astype(np.float32)).unsqueeze(0)
			bg_b64 = _encode_preview_image(image)
			_send_status(unique_id, f"完成：{mask.shape[1]} × {mask.shape[0]}")
			return {
				"ui": {
					"bg_image": [bg_b64],
				},
				"result": (mask_tensor, preview),
			}
		except Exception as exc:
			raise RuntimeError(
				"SEM2 点选分割节点执行失败。\n"
				f"模型：{sam2_model}\n"
				f"详细错误：{exc}"
			) from exc


NODE_CLASS_MAPPINGS = {
	NODE_NAME: GJJ_SEM2PointSegmenter,
}


NODE_DISPLAY_NAME_MAPPINGS = {
	NODE_NAME: "GJJ · 📍 SEM2点选分割器",
}
