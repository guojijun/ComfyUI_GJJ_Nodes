from __future__ import annotations

import base64
import io
import json
from typing import Any

import numpy as np
import torch
from PIL import Image


def _image_to_base64(image: torch.Tensor) -> str:
	array = np.clip(image[0].cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
	buffer = io.BytesIO()
	Image.fromarray(array).save(buffer, format="PNG")
	return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _safe_parse_points(raw: str) -> list[dict[str, float]]:
	try:
		value = json.loads(str(raw or "[]"))
		return value if isinstance(value, list) else []
	except Exception:
		return []


def _safe_parse_boxes(raw: str) -> list[dict[str, float]]:
	try:
		value = json.loads(str(raw or "[]"))
		return value if isinstance(value, list) else []
	except Exception:
		return []


def _blank_image(width: int, height: int) -> torch.Tensor:
	return torch.zeros((1, int(height), int(width), 3), dtype=torch.float32)


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
					"socketless": True,
					"advanced": True,
					"display_name": "点位存储",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"coordinates": ("STRING", {
					"default": "[]",
					"multiline": False,
					"socketless": True,
					"advanced": True,
					"display_name": "前景点位",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"neg_coordinates": ("STRING", {
					"default": "[]",
					"multiline": False,
					"socketless": True,
					"advanced": True,
					"display_name": "背景点位",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"bbox_store": ("STRING", {
					"default": "[]",
					"multiline": False,
					"socketless": True,
					"advanced": True,
					"display_name": "框选存储",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"bboxes": ("STRING", {
					"default": "[]",
					"multiline": False,
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
			},
			"optional": {
				"bg_image": ("IMAGE", {
					"display_name": "背景图像",
					"tooltip": "可选。接入后会显示在编辑面板，并用于裁切输出。",
				}),
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
		points_store,
		coordinates,
		neg_coordinates,
		bbox_store,
		bboxes,
		bbox_format,
		width,
		height,
		normalize,
		bg_image=None,
	):
		width = int(width)
		height = int(height)
		pos_input = _safe_parse_points(coordinates)
		neg_input = _safe_parse_points(neg_coordinates)
		bbox_input = _safe_parse_boxes(bboxes)

		pos_output = []
		for coord in pos_input:
			x = int(round(float(coord.get("x", 0))))
			y = int(round(float(coord.get("y", 0))))
			if normalize:
				pos_output.append({"x": x / max(1, width), "y": y / max(1, height)})
			else:
				pos_output.append({"x": x, "y": y})

		neg_output = []
		for coord in neg_input:
			x = int(round(float(coord.get("x", 0))))
			y = int(round(float(coord.get("y", 0))))
			if normalize:
				neg_output.append({"x": x / max(1, width), "y": y / max(1, height)})
			else:
				neg_output.append({"x": x, "y": y})

		mask = np.zeros((height, width), dtype=np.uint8)
		valid_boxes = []
		for bbox in bbox_input:
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
		else:
			base_image = _blank_image(width, height)
			preview_b64 = _image_to_base64(base_image)

		cropped_image = base_image
		if bg_image is not None and valid_boxes:
			x_min, y_min, x_max, y_max = valid_boxes[0]
			cropped_image = bg_image[:, y_min:y_max, x_min:x_max, :]

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
