from __future__ import annotations

import base64
import io
import json
import os
from typing import Any

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageOps


STATE_PROPERTY = "gjj_points_editor_state"
IMAGE_STORE_PROPERTY = "gjj_points_editor_image_store"


def _image_to_base64(image: torch.Tensor) -> str:
	array = np.clip(image[0].cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
	buffer = io.BytesIO()
	Image.fromarray(array).save(buffer, format="PNG")
	return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _safe_parse_points(raw: Any) -> list[dict[str, float]]:
	try:
		value = json.loads(str(raw or "[]"))
		return value if isinstance(value, list) else []
	except Exception:
		return []


def _safe_parse_boxes(raw: Any) -> list[dict[str, float]]:
	try:
		value = json.loads(str(raw or "[]"))
		return value if isinstance(value, list) else []
	except Exception:
		return []


def _safe_parse_state(raw: Any) -> dict[str, Any]:
	try:
		value = json.loads(str(raw or "{}"))
		return value if isinstance(value, dict) else {}
	except Exception:
		return {}


def _state_score(value: Any) -> int:
	if not isinstance(value, dict):
		return 0
	score = 0
	for key in ("positive", "negative", "boxes", "coordinates", "neg_coordinates", "bboxes"):
		field = value.get(key)
		if isinstance(field, list):
			score += 2 + min(len(field), 20)
	for key in ("image_store", "width", "height", "bbox_format", "normalize"):
		if key in value:
			score += 1
	return score


def _find_editor_state(*raw_values: Any) -> dict[str, Any]:
	best: dict[str, Any] = {}
	best_score = 0
	for raw in raw_values:
		if isinstance(raw, dict):
			value = raw
		else:
			try:
				value = json.loads(str(raw or "{}"))
			except Exception:
				continue
		score = _state_score(value)
		if score > 0 and score >= best_score:
			best = value
			best_score = score
	return best


def _state_list(state: dict[str, Any], *keys: str) -> list[dict[str, float]] | None:
	for key in keys:
		value = state.get(key)
		if isinstance(value, list):
			return value
	return None


def _safe_parse_workflow(value: Any) -> dict[str, Any]:
	if isinstance(value, dict):
		return value
	try:
		parsed = json.loads(str(value or "{}"))
		return parsed if isinstance(parsed, dict) else {}
	except Exception:
		return {}


def _workflow_state(extra_pnginfo: Any, unique_id: Any) -> dict[str, Any]:
	extra = extra_pnginfo if isinstance(extra_pnginfo, dict) else {}
	workflow = _safe_parse_workflow(extra.get("workflow"))
	nodes = workflow.get("nodes")
	if not isinstance(nodes, list):
		return {}
	node_id = str(unique_id or "")
	for node in nodes:
		if not isinstance(node, dict) or str(node.get("id", "")) != node_id:
			continue
		properties = node.get("properties")
		if not isinstance(properties, dict):
			return {}
		state = _safe_parse_state(properties.get(STATE_PROPERTY))
		if _state_score(state) > 0:
			return state
		image_store = properties.get(IMAGE_STORE_PROPERTY)
		if isinstance(image_store, str) and image_store:
			return {"image_store": image_store}
	return {}


def _blank_image(width: int, height: int) -> torch.Tensor:
	return torch.zeros((1, int(height), int(width), 3), dtype=torch.float32)


def _coerce_int(value: Any, fallback: int) -> int:
	try:
		coerced = int(round(float(value)))
	except Exception:
		coerced = int(fallback)
	return max(1, coerced)


def _coerce_bool(value: Any, fallback: bool = False) -> bool:
	if isinstance(value, bool):
		return value
	if value is None:
		return fallback
	if isinstance(value, (int, float)):
		return bool(value)
	text = str(value).strip().lower()
	if text in {"true", "1", "yes", "on"}:
		return True
	if text in {"false", "0", "no", "off", ""}:
		return False
	return fallback


def _default_positive_point(width: int, height: int) -> dict[str, int]:
	return {"x": int(round(width / 2)), "y": int(round(height / 2))}


def _default_negative_point(width: int, height: int) -> dict[str, int]:
	return {
		"x": max(0, min(width, int(round(width * 0.05)))),
		"y": max(0, min(height, int(round(height * 0.05)))),
	}


def _load_image_from_path(file_path: str) -> torch.Tensor:
	with Image.open(file_path) as img:
		img.load()
		img = ImageOps.exif_transpose(img)
		if img.mode == "RGBA":
			array = np.asarray(img).astype(np.float32) / 255.0
		else:
			array = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
	return torch.from_numpy(array)[None, ...]


def _resolve_annotated_image(raw: str) -> str | None:
	text = str(raw or "").strip()
	if not text:
		return None
	try:
		path = folder_paths.get_annotated_filepath(text)
		if path and os.path.exists(path):
			return path
	except Exception:
		pass
	if text and folder_paths.exists_annotated_filepath(text):
		try:
			path = folder_paths.get_annotated_filepath(text)
			return path if path and os.path.exists(path) else None
		except Exception:
			pass
	return text if text and os.path.exists(text) else None


class GJJ_PointsEditor:
	DESCRIPTION = "图形化点位编辑器。可在面板上添加前景点、背景点和框选区域，输出坐标、边框、边框遮罩和裁切图。"
	OUTPUT_NODE = True

	@classmethod
	def INPUT_TYPES(cls):
		return {
			"required": {
				"points_store": ("STRING", {
					"default": "{}",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "点位存储",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"coordinates": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "前景点位",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"neg_coordinates": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "背景点位",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"bbox_store": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "框选存储",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"bboxes": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "框选数据",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"bbox_format": (["xyxy", "xywh"], {
					"display_name": "边框格式",
					"tooltip": "xyxy 输出左上和右下角坐标；xywh 输出左上角和宽高。",
					"default": "xyxy",
				}),
				"width": ("INT", {
					"default": 512,
					"min": 8,
					"max": 4096,
					"step": 8,
					"display_name": "宽度",
					"tooltip": "未接背景图时的画布宽度，也用于归一化计算。",
				}),
				"height": ("INT", {
					"default": 512,
					"min": 8,
					"max": 4096,
					"step": 8,
					"display_name": "高度",
					"tooltip": "未接背景图时的画布高度，也用于归一化计算。",
				}),
				"normalize": ("BOOLEAN", {
					"default": False,
					"display_name": "归一化坐标",
					"tooltip": "开启后输出 0 到 1 的相对坐标，否则输出像素坐标。",
				}),
				"image_store": ("STRING", {
					"default": "",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "图片存储",
					"tooltip": "前端内部使用的隐藏数据，用于保存通过按钮载入的图片。",
				}),
				"editor_state": ("STRING", {
					"default": "{}",
					"multiline": False,
					"display": "hidden",
					"hidden": True,
					"socketless": True,
					"advanced": True,
					"display_name": "编辑器状态",
					"tooltip": "前端内部使用的隐藏数据，保存当前点位、框选和图片状态。",
				}),
			},
			"optional": {
				"bg_image": ("IMAGE", {
					"display_name": "背景图像",
					"tooltip": "可选。接入后会显示在编辑面板，并用于裁切输出。",
				}),
			},
			"hidden": {
				"unique_id": "UNIQUE_ID",
				"extra_pnginfo": "EXTRA_PNGINFO",
			},
	}

	RETURN_TYPES = ("STRING", "STRING", "BBOX", "MASK", "IMAGE")
	RETURN_NAMES = ("前景点坐标", "背景点坐标", "框选范围信息", "框选遮罩图像", "首个裁切图像")
	OUTPUT_TOOLTIPS = (
		"前景点位坐标 JSON 文本。",
		"背景点位坐标 JSON 文本。",
		"框选结果，按所选格式输出为边框数组。",
		"根据边框填充得到的遮罩。",
		"若接了背景图则输出第一组边框裁切图，否则输出当前背景图或空白画布。",
	)
	FUNCTION = "pointdata"
	CATEGORY = "GJJ/工具"

	def pointdata(
		self,
		points_store="{}",
		coordinates="[]",
		neg_coordinates="[]",
		bbox_store="[]",
		bboxes="[]",
		bbox_format="xyxy",
		width=512,
		height=512,
		normalize=False,
		image_store="",
		editor_state="{}",
		bg_image=None,
		unique_id=None,
		extra_pnginfo=None,
		**kwargs,
	):
		workflow_state = _workflow_state(extra_pnginfo, unique_id)
		state = _find_editor_state(
			editor_state,
			points_store,
			coordinates,
			neg_coordinates,
			bbox_store,
			bboxes,
			image_store,
			workflow_state,
			*kwargs.values(),
		)
		store_state = _safe_parse_state(points_store)
		pos_source = _state_list(state, "positive", "coordinates") or _state_list(store_state, "positive")
		neg_source = _state_list(state, "negative", "neg_coordinates") or _state_list(store_state, "negative")
		bbox_source = _state_list(state, "boxes", "bboxes")

		if pos_source is not None:
			coordinates = json.dumps(pos_source, ensure_ascii=False)
		if neg_source is not None:
			neg_coordinates = json.dumps(neg_source, ensure_ascii=False)
		if bbox_source is not None:
			bboxes = json.dumps(bbox_source, ensure_ascii=False)
		if isinstance(state.get("image_store"), str) and (not image_store or _state_score(_safe_parse_state(image_store)) > 0):
			image_store = state.get("image_store", "")

		if state.get("width") is not None:
			width = state.get("width")
		if state.get("height") is not None:
			height = state.get("height")
		if state.get("bbox_format") in ("xyxy", "xywh"):
			bbox_format = state.get("bbox_format")
		if state.get("normalize") is not None:
			normalize = state.get("normalize")
		width = _coerce_int(width, 512)
		height = _coerce_int(height, 512)
		bbox_format = bbox_format if bbox_format in ("xyxy", "xywh") else "xyxy"
		normalize = _coerce_bool(normalize, _coerce_bool(state.get("normalize"), False))
		pos_input = _safe_parse_points(coordinates)
		neg_input = _safe_parse_points(neg_coordinates)
		if not pos_input:
			pos_input = [_default_positive_point(width, height)]
		if not neg_input:
			neg_input = [_default_negative_point(width, height)]
		bbox_input = _safe_parse_boxes(bboxes) or _safe_parse_boxes(bbox_store)
		stored_image = _resolve_annotated_image(image_store)

		pos_output = []
		for coord in pos_input:
			if not isinstance(coord, dict):
				continue
			x = int(round(float(coord.get("x", 0))))
			y = int(round(float(coord.get("y", 0))))
			if normalize:
				pos_output.append({"x": x / max(1, width), "y": y / max(1, height)})
			else:
				pos_output.append({"x": x, "y": y})

		neg_output = []
		for coord in neg_input:
			if not isinstance(coord, dict):
				continue
			x = int(round(float(coord.get("x", 0))))
			y = int(round(float(coord.get("y", 0))))
			if normalize:
				neg_output.append({"x": x / max(1, width), "y": y / max(1, height)})
			else:
				neg_output.append({"x": x, "y": y})

		mask = np.zeros((height, width), dtype=np.uint8)
		valid_boxes = []
		for bbox in bbox_input:
			if not isinstance(bbox, dict):
				continue
			if any(bbox.get(key) is None for key in ("startX", "startY", "endX", "endY")):
				continue
			x_min = min(int(round(float(bbox["startX"]))), int(round(float(bbox["endX"]))))
			y_min = min(int(round(float(bbox["startY"]))), int(round(float(bbox["endY"]))))
			x_max = max(int(round(float(bbox["startX"]))), int(round(float(bbox["endX"]))))
			y_max = max(int(round(float(bbox["startY"]))), int(round(float(bbox["endY"]))))
			x_min = max(0, min(x_min, width))
			y_min = max(0, min(y_min, height))
			x_max = max(0, min(x_max, width))
			y_max = max(0, min(y_max, height))
			if x_max <= x_min or y_max <= y_min:
				continue
			valid_boxes.append((x_min, y_min, x_max, y_max))
			mask[y_min:y_max, x_min:x_max] = 1

		if bbox_format == "xywh":
			bbox_output = [(x1, y1, x2 - x1, y2 - y1) for x1, y1, x2, y2 in valid_boxes]
		else:
			bbox_output = list(valid_boxes)

		mask_tensor = torch.from_numpy(mask).unsqueeze(0).float().cpu()

		if bg_image is not None:
			base_image = bg_image
			preview_b64 = _image_to_base64(bg_image)
		elif stored_image:
			base_image = _load_image_from_path(stored_image)
			preview_b64 = _image_to_base64(base_image)
		else:
			base_image = _blank_image(width, height)
			preview_b64 = _image_to_base64(base_image)

		cropped_image = base_image
		if valid_boxes:
			x_min, y_min, x_max, y_max = valid_boxes[0]
			cropped_image = base_image[:, y_min:y_max, x_min:x_max, :]

		return {
			"ui": {"bg_image": [preview_b64]},
			"result": (
				json.dumps(pos_output, ensure_ascii=False),
				json.dumps(neg_output, ensure_ascii=False),
				bbox_output,
				mask_tensor,
				cropped_image,
			),
		}


NODE_CLASS_MAPPINGS = {
	"GJJ_PointsEditor": GJJ_PointsEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
	"GJJ_PointsEditor": "GJJ · 📍 点位编辑器",
}
