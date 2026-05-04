from __future__ import annotations

import hashlib
import json
import gc

import numpy as np
import torch

import comfy.model_management
import comfy.utils

from .gjj_sam3_runtime import (
	get_or_build_model,
	list_sam3_models,
	pick_available_name,
	comfy_image_to_pil,
	pil_to_comfy_image,
	masks_to_comfy_mask,
	tensor_to_list,
	visualize_masks_on_image,
	image_to_base64,
	send_status,
)


def _empty_point_prompt():
	return {"points": [], "labels": []}


def _empty_box_prompt():
	return {"boxes": [], "labels": []}


class GJJ_SAM3PointCollector:
	DESCRIPTION = "在节点面板直接点选前景与背景点位，输出给 SAM3 点选分割器使用。左键添加绿色前景点，右键添加红色背景点。"
	OUTPUT_NODE = True

	@classmethod
	def INPUT_TYPES(cls):
		return {
			"required": {
				"image": ("IMAGE", {
					"display_name": "输入图像",
					"tooltip": "执行一次后会把图像显示在面板里，左键点前景，右键点背景。",
				}),
				"points_store": ("STRING", {
					"default": "{}",
					"multiline": False,
					"display_name": "点位存储",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"coordinates": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display_name": "前景点位",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"neg_coordinates": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display_name": "背景点位",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
			}
		}

	RETURN_TYPES = ("SAM3_POINTS_PROMPT", "SAM3_POINTS_PROMPT")
	RETURN_NAMES = ("前景点集合", "背景点集合")
	OUTPUT_TOOLTIPS = (
		"前景点位提示，连接到 SAM3 点选分割器的前景点输入。",
		"背景点位提示，连接到 SAM3 点选分割器的背景点输入。",
	)
	FUNCTION = "collect"
	CATEGORY = "GJJ/SAM3"

	@classmethod
	def IS_CHANGED(cls, image, points_store, coordinates, neg_coordinates):
		h = hashlib.md5()
		h.update(str(tuple(image.shape)).encode())
		h.update(str(coordinates or "[]").encode())
		h.update(str(neg_coordinates or "[]").encode())
		return h.hexdigest()

	def collect(self, image, points_store, coordinates, neg_coordinates):
		try:
			pos_coords = json.loads(coordinates) if str(coordinates or "").strip() else []
			neg_coords = json.loads(neg_coordinates) if str(neg_coordinates or "").strip() else []
		except Exception:
			pos_coords = []
			neg_coords = []

		img_height, img_width = image.shape[1], image.shape[2]
		positive_points = {"points": [], "labels": []}
		negative_points = {"points": [], "labels": []}

		for item in pos_coords:
			x = float(item.get("x", 0.0)) / max(1, img_width)
			y = float(item.get("y", 0.0)) / max(1, img_height)
			positive_points["points"].append([x, y])
			positive_points["labels"].append(1)

		for item in neg_coords:
			x = float(item.get("x", 0.0)) / max(1, img_width)
			y = float(item.get("y", 0.0)) / max(1, img_height)
			negative_points["points"].append([x, y])
			negative_points["labels"].append(0)

		return {
			"ui": {"bg_image": [image_to_base64(image)]},
			"result": (positive_points, negative_points),
		}


class GJJ_SAM3BBoxCollector:
	DESCRIPTION = "在节点面板直接框选正向或反向区域，输出给 SAM3 点选分割器或文本分割器使用。左键拖拽添加正向框，右键拖拽添加反向框。"
	OUTPUT_NODE = True

	@classmethod
	def INPUT_TYPES(cls):
		return {
			"required": {
				"image": ("IMAGE", {
					"display_name": "输入图像",
					"tooltip": "执行一次后会把图像显示在面板里，左键拖拽正向框，右键拖拽反向框。",
				}),
				"bboxes": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display_name": "正向框",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
				"neg_bboxes": ("STRING", {
					"default": "[]",
					"multiline": False,
					"display_name": "反向框",
					"tooltip": "前端内部使用的隐藏数据，不需要手动填写。",
				}),
			}
		}

	RETURN_TYPES = ("SAM3_BOXES_PROMPT", "SAM3_BOXES_PROMPT")
	RETURN_NAMES = ("正向框选集", "反向框选集")
	OUTPUT_TOOLTIPS = (
		"正向框提示，连接到 SAM3 分割节点作为限制区域。",
		"反向框提示，连接到 SAM3 文本分割器排除区域。",
	)
	FUNCTION = "collect"
	CATEGORY = "GJJ/SAM3"

	@classmethod
	def IS_CHANGED(cls, image, bboxes, neg_bboxes):
		h = hashlib.md5()
		h.update(str(tuple(image.shape)).encode())
		h.update(str(bboxes or "[]").encode())
		h.update(str(neg_bboxes or "[]").encode())
		return h.hexdigest()

	def collect(self, image, bboxes, neg_bboxes):
		try:
			pos_boxes = json.loads(bboxes) if str(bboxes or "").strip() else []
			neg_boxes = json.loads(neg_bboxes) if str(neg_bboxes or "").strip() else []
		except Exception:
			pos_boxes = []
			neg_boxes = []

		img_height, img_width = image.shape[1], image.shape[2]
		positive_prompt = {"boxes": [], "labels": []}
		negative_prompt = {"boxes": [], "labels": []}

		for bbox in pos_boxes:
			x1 = float(bbox.get("x1", 0.0)) / max(1, img_width)
			y1 = float(bbox.get("y1", 0.0)) / max(1, img_height)
			x2 = float(bbox.get("x2", 0.0)) / max(1, img_width)
			y2 = float(bbox.get("y2", 0.0)) / max(1, img_height)
			cx = (x1 + x2) / 2.0
			cy = (y1 + y2) / 2.0
			w = x2 - x1
			h = y2 - y1
			positive_prompt["boxes"].append([cx, cy, w, h])
			positive_prompt["labels"].append(True)

		for bbox in neg_boxes:
			x1 = float(bbox.get("x1", 0.0)) / max(1, img_width)
			y1 = float(bbox.get("y1", 0.0)) / max(1, img_height)
			x2 = float(bbox.get("x2", 0.0)) / max(1, img_width)
			y2 = float(bbox.get("y2", 0.0)) / max(1, img_height)
			cx = (x1 + x2) / 2.0
			cy = (y1 + y2) / 2.0
			w = x2 - x1
			h = y2 - y1
			negative_prompt["boxes"].append([cx, cy, w, h])
			negative_prompt["labels"].append(False)

		return {
			"ui": {"bg_image": [image_to_base64(image)]},
			"result": (positive_prompt, negative_prompt),
		}


class GJJ_SAM3PointSegmenter:
	DESCRIPTION = "SAM3 点选分割器。内部自动加载 models/sam3 下的模型，支持前景点、背景点和可选框提示。"

	@classmethod
	def INPUT_TYPES(cls):
		available = list_sam3_models()
		default_model = pick_available_name("sam3.safetensors", available, "") or (available[0] if available else "sam3.safetensors")
		return {
			"required": {
				"image": ("IMAGE", {
					"display_name": "输入图像",
					"tooltip": "需要分割的图像。",
				}),
				"sam3_model": (available or ["sam3.safetensors"], {
					"display_name": "SAM3 模型",
					"tooltip": "自动搜索 models/sam3 及其子目录，支持子目录模糊匹配。",
					"default": default_model or "sam3.safetensors",
				}),
				"precision": (["auto", "bf16", "fp16", "fp32"], {
					"display_name": "精度",
					"tooltip": "auto 会根据显卡自动选择更合适的精度。",
					"default": "auto",
				}),
				"refinement_iterations": ("INT", {
					"default": 0,
					"min": 0,
					"max": 10,
					"step": 1,
					"display_name": "细化次数",
					"tooltip": "对最佳遮罩回喂细化的次数，适当增加可改善边缘。",
				}),
				"use_multimask": ("BOOLEAN", {
					"default": True,
					"display_name": "多候选遮罩",
					"tooltip": "开启后会尝试 3 个不同粒度的遮罩候选。",
				}),
				"output_best_mask": ("BOOLEAN", {
					"default": True,
					"display_name": "仅输出最佳遮罩",
					"tooltip": "开启后只输出得分最高的遮罩，否则输出所有候选。",
				}),
			},
			"optional": {
				"positive_points": ("SAM3_POINTS_PROMPT", {
					"display_name": "前景点位",
					"tooltip": "来自 SAM3 点位收集器的前景点。",
				}),
				"negative_points": ("SAM3_POINTS_PROMPT", {
					"display_name": "背景点位",
					"tooltip": "来自 SAM3 点位收集器的背景点。",
				}),
				"positive_boxes": ("SAM3_BOXES_PROMPT", {
					"display_name": "正向框",
					"tooltip": "来自 SAM3 框选收集器的正向框，只取第一组作为限制区域。",
				}),
			},
			"hidden": {
				"unique_id": "UNIQUE_ID",
			},
		}

	RETURN_TYPES = ("MASK", "MASK", "IMAGE", "STRING", "STRING")
	RETURN_NAMES = ("分割结果遮罩", "分割结果概率", "分割预览图像", "边框检测信息", "遮罩评分信息")
	OUTPUT_TOOLTIPS = (
		"最终输出的分割遮罩。",
		"低分辨率遮罩 logits，可用于高级后处理。",
		"带遮罩可视化叠加的预览图。",
		"所有遮罩边框的 JSON 文本。",
		"所有遮罩得分的 JSON 文本。",
	)
	FUNCTION = "segment"
	CATEGORY = "GJJ/SAM3"

	def segment(
		self,
		image,
		sam3_model,
		precision="auto",
		refinement_iterations=0,
		use_multimask=True,
		output_best_mask=True,
		positive_points=None,
		negative_points=None,
		positive_boxes=None,
		unique_id=None,
	):
		try:
			send_status(unique_id, "加载 SAM3 模型…")
			sam3 = get_or_build_model(sam3_model, precision=precision, compile_model=False)
			comfy.model_management.load_models_gpu([sam3])

			send_status(unique_id, "提取图像特征…")
			processor = sam3.processor
			model = processor.model
			if hasattr(processor, "sync_device_with_model"):
				processor.sync_device_with_model()

			if model.inst_interactive_predictor is None:
				raise RuntimeError("当前 SAM3 模型未启用交互分割预测器。")

			pil_image = comfy_image_to_pil(image)
			img_w, img_h = pil_image.size
			state = processor.set_image(pil_image)

			all_points = []
			all_point_labels = []
			if positive_points is not None:
				for pt in positive_points.get("points", []):
					all_points.append([pt[0] * img_w, pt[1] * img_h])
					all_point_labels.append(1)
			if negative_points is not None:
				for pt in negative_points.get("points", []):
					all_points.append([pt[0] * img_w, pt[1] * img_h])
					all_point_labels.append(0)

			box_array = None
			if positive_boxes is not None and len(positive_boxes.get("boxes", [])) > 0:
				b = positive_boxes["boxes"][0]
				cx, cy, w, h = b
				x1 = (cx - w / 2.0) * img_w
				y1 = (cy - h / 2.0) * img_h
				x2 = (cx + w / 2.0) * img_w
				y2 = (cy + h / 2.0) * img_h
				box_array = np.array([x1, y1, x2, y2], dtype=np.float32)

			point_coords = np.array(all_points, dtype=np.float32) if all_points else None
			point_labels = np.array(all_point_labels, dtype=np.int64) if all_point_labels else None
			if point_coords is None and box_array is None:
				raise RuntimeError("请至少提供一个前景点、背景点或正向框。")

			send_status(unique_id, "执行点选分割…")
			masks_np, scores_np, low_res_masks = model.predict_inst(
				state,
				point_coords=point_coords,
				point_labels=point_labels,
				box=box_array,
				mask_input=None,
				multimask_output=bool(use_multimask),
				normalize_coords=True,
			)

			if refinement_iterations > 0:
				pbar = comfy.utils.ProgressBar(refinement_iterations)
			for i in range(int(refinement_iterations)):
				comfy.model_management.throw_exception_if_processing_interrupted()
				best_idx = int(np.argmax(scores_np))
				masks_np, scores_np, low_res_masks = model.predict_inst(
					state,
					point_coords=point_coords,
					point_labels=point_labels,
					box=box_array,
					mask_input=low_res_masks[best_idx:best_idx + 1],
					multimask_output=bool(use_multimask),
					normalize_coords=True,
				)
				pbar.update(1)

			if output_best_mask:
				best_idx = int(np.argmax(scores_np))
				masks = torch.from_numpy(masks_np[best_idx]).unsqueeze(0).float()
				scores = torch.tensor([float(scores_np[best_idx])], dtype=torch.float32)
				low_res_tensor = torch.from_numpy(low_res_masks[best_idx]).unsqueeze(0).float()
			else:
				masks = torch.from_numpy(masks_np).float()
				scores = torch.from_numpy(scores_np).float()
				low_res_tensor = torch.from_numpy(low_res_masks).float()

			boxes_list = []
			for i in range(masks.shape[0]):
				mask_coords = torch.where(masks[i] > 0)
				if len(mask_coords[0]) > 0:
					y1 = mask_coords[0].min().item()
					y2 = mask_coords[0].max().item()
					x1 = mask_coords[1].min().item()
					x2 = mask_coords[1].max().item()
					boxes_list.append([x1, y1, x2, y2])
				else:
					boxes_list.append([0, 0, 0, 0])
			boxes = torch.tensor(boxes_list).float()
			comfy_masks = masks_to_comfy_mask(masks)
			vis_image = visualize_masks_on_image(pil_image, masks, boxes, scores, alpha=0.5)
			vis_tensor = pil_to_comfy_image(vis_image)

			del state
			gc.collect()
			comfy.model_management.soft_empty_cache()
			send_status(unique_id, f"完成：{img_w} × {img_h}")
			return (
				comfy_masks,
				low_res_tensor,
				vis_tensor,
				json.dumps(tensor_to_list(boxes), ensure_ascii=False, indent=2),
				json.dumps(tensor_to_list(scores), ensure_ascii=False, indent=2),
			)
		except Exception as exc:
			send_status(unique_id, "执行失败")
			raise RuntimeError(
				" SAM3 点选分割节点执行失败。\n"
				f"模型：{sam3_model}\n"
				f"详细错误：{exc}"
			) from exc


class GJJ_SAM3TextSegmenter:
	DESCRIPTION = "SAM3 文本分割器。输入自然语言描述，例如“人物”“红色汽车”，节点会尝试返回所有匹配目标的遮罩。"

	@classmethod
	def INPUT_TYPES(cls):
		available = list_sam3_models()
		default_model = pick_available_name("sam3.safetensors", available, "") or (available[0] if available else "sam3.safetensors")
		return {
			"required": {
				"image": ("IMAGE", {
					"display_name": "输入图像",
					"tooltip": "需要做开放词汇分割的图像。",
				}),
				"text_prompt": ("STRING", {
					"default": "person",
					"multiline": False,
					"display_name": "文本提示",
					"tooltip": "输入自然语言目标描述，例如：人、鞋子、红色汽车、树木。",
				}),
				"sam3_model": (available or ["sam3.safetensors"], {
					"display_name": "SAM3 模型",
					"tooltip": "自动搜索 models/sam3 及其子目录。",
					"default": default_model or "sam3.safetensors",
				}),
				"precision": (["auto", "bf16", "fp16", "fp32"], {
					"display_name": "精度",
					"tooltip": "auto 会根据显卡自动选择精度。",
					"default": "auto",
				}),
				"confidence_threshold": ("FLOAT", {
					"default": 0.2,
					"min": 0.0,
					"max": 1.0,
					"step": 0.01,
					"display_name": "置信度阈值",
					"tooltip": "阈值越低越容易保留更多结果，越高越保守。",
				}),
				"max_detections": ("INT", {
					"default": -1,
					"min": -1,
					"max": 100,
					"step": 1,
					"display_name": "最大检测数",
					"tooltip": "-1 为返回全部结果，其它值表示只保留前 N 个最高分结果。",
				}),
			},
			"optional": {
				"positive_boxes": ("SAM3_BOXES_PROMPT", {
					"display_name": "正向框",
					"tooltip": "可选，缩小文本检测的关注范围。",
				}),
				"negative_boxes": ("SAM3_BOXES_PROMPT", {
					"display_name": "反向框",
					"tooltip": "可选，排除某些区域不参与文本检测。",
				}),
			},
			"hidden": {
				"unique_id": "UNIQUE_ID",
			},
		}

	RETURN_TYPES = ("MASK", "IMAGE", "STRING", "STRING")
	RETURN_NAMES = ("分割结果遮罩", "分割预览图像", "边框检测信息", "遮罩评分信息")
	OUTPUT_TOOLTIPS = (
		"文本匹配到的所有遮罩。",
		"带遮罩叠加的预览图。",
		"所有边框的 JSON 文本。",
		"所有得分的 JSON 文本。",
	)
	FUNCTION = "segment"
	CATEGORY = "GJJ/SAM3"

	def segment(
		self,
		image,
		text_prompt,
		sam3_model,
		precision="auto",
		confidence_threshold=0.2,
		max_detections=-1,
		positive_boxes=None,
		negative_boxes=None,
		unique_id=None,
	):
		try:
			send_status(unique_id, "加载 SAM3 模型…")
			sam3 = get_or_build_model(sam3_model, precision=precision, compile_model=False)
			comfy.model_management.load_models_gpu([sam3])
			processor = sam3.processor
			if hasattr(processor, "sync_device_with_model"):
				processor.sync_device_with_model()
			processor.set_confidence_threshold(float(confidence_threshold))

			send_status(unique_id, "提取图像特征…")
			pil_image = comfy_image_to_pil(image)
			img_w, img_h = pil_image.size
			state = processor.set_image(pil_image)

			if str(text_prompt or "").strip():
				send_status(unique_id, "执行文本检测…")
				state = processor.set_text_prompt(str(text_prompt).strip(), state)

			if positive_boxes is not None and len(positive_boxes.get("boxes", [])) > 0:
				state = processor.add_multiple_box_prompts(positive_boxes["boxes"], positive_boxes["labels"], state)
			if negative_boxes is not None and len(negative_boxes.get("boxes", [])) > 0:
				state = processor.add_multiple_box_prompts(negative_boxes["boxes"], negative_boxes["labels"], state)

			masks = state.get("masks", None)
			boxes = state.get("boxes", None)
			scores = state.get("scores", None)

			if masks is None or len(masks) == 0:
				empty_mask = torch.zeros(1, img_h, img_w)
				send_status(unique_id, f"未检测到目标：{text_prompt}")
				return (
					empty_mask,
					pil_to_comfy_image(pil_image),
					"[]",
					"[]",
				)

			if scores is not None and len(scores) > 0:
				sorted_indices = torch.argsort(scores, descending=True)
				masks = masks[sorted_indices]
				boxes = boxes[sorted_indices] if boxes is not None else None
				scores = scores[sorted_indices]

			if max_detections > 0 and len(masks) > max_detections:
				masks = masks[:max_detections]
				boxes = boxes[:max_detections] if boxes is not None else None
				scores = scores[:max_detections] if scores is not None else None

			comfy_masks = masks_to_comfy_mask(masks)
			vis_image = visualize_masks_on_image(pil_image, masks, boxes, scores, alpha=0.5)
			vis_tensor = pil_to_comfy_image(vis_image)
			del state
			gc.collect()
			comfy.model_management.soft_empty_cache()
			send_status(unique_id, f"完成：{img_w} × {img_h}")
			return (
				comfy_masks,
				vis_tensor,
				json.dumps(tensor_to_list(boxes) if boxes is not None else [], ensure_ascii=False, indent=2),
				json.dumps(tensor_to_list(scores) if scores is not None else [], ensure_ascii=False, indent=2),
			)
		except Exception as exc:
			send_status(unique_id, "执行失败")
			raise RuntimeError(
				" SAM3 文本分割节点执行失败。\n"
				f"模型：{sam3_model}\n"
				f"提示词：{text_prompt}\n"
				f"详细错误：{exc}"
			) from exc


NODE_CLASS_MAPPINGS = {
	"GJJ_SAM3PointCollector": GJJ_SAM3PointCollector,
	"GJJ_SAM3BBoxCollector": GJJ_SAM3BBoxCollector,
	"GJJ_SAM3PointSegmenter": GJJ_SAM3PointSegmenter,
	"GJJ_SAM3TextSegmenter": GJJ_SAM3TextSegmenter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
	"GJJ_SAM3PointCollector": "GJJ · 📍 SAM3点位收集器",
	"GJJ_SAM3BBoxCollector": "GJJ · 🟦 SAM3框选收集器",
	"GJJ_SAM3PointSegmenter": "GJJ · ✂️ SAM3点选分割器",
	"GJJ_SAM3TextSegmenter": "GJJ · 📝 SAM3文本分割器",
}
