from __future__ import annotations

from typing import Any

import torch


NODE_NAME = "GJJ_GetImageRangeFromBatch"
IMAGE_BATCH_TYPE = "GJJ_BATCH_IMAGE,IMAGE"


def _normalize_image_batch(value: Any) -> torch.Tensor | None:
	if value is None:
		return None
	if isinstance(value, dict):
		for key in ("images", "image", "frames", "samples"):
			if key in value:
				result = _normalize_image_batch(value.get(key))
				if result is not None:
					return result
		return None
	if not isinstance(value, torch.Tensor):
		return None
	tensor = value
	if tensor.ndim == 3:
		tensor = tensor.unsqueeze(0)
	if tensor.ndim != 4:
		raise RuntimeError("图片范围截取失败：图片输入必须是 IMAGE 或 IMAGE batch，形状应为 [B,H,W,C]。")
	if int(tensor.shape[-1]) == 1:
		tensor = tensor.repeat(1, 1, 1, 3)
	if int(tensor.shape[-1]) > 4:
		tensor = tensor[..., :4]
	return tensor.float().contiguous()


def _normalize_mask_batch(value: Any) -> torch.Tensor | None:
	if value is None:
		return None
	if isinstance(value, dict):
		for key in ("masks", "mask", "samples"):
			if key in value:
				result = _normalize_mask_batch(value.get(key))
				if result is not None:
					return result
		return None
	if not isinstance(value, torch.Tensor):
		return None
	tensor = value
	if tensor.ndim == 4:
		if int(tensor.shape[-1]) in (1, 3, 4):
			tensor = tensor[..., :3].mean(dim=-1)
		elif int(tensor.shape[1]) in (1, 3, 4):
			tensor = tensor[:, :3].mean(dim=1)
		else:
			raise RuntimeError("图片范围截取失败：遮罩输入必须是 MASK batch，或可转为遮罩的图像张量。")
	if tensor.ndim == 2:
		tensor = tensor.unsqueeze(0)
	if tensor.ndim != 3:
		raise RuntimeError("图片范围截取失败：遮罩输入必须是 MASK 或 MASK batch，形状应为 [B,H,W]。")
	return tensor.float().contiguous()


def _slice_batch(tensor: torch.Tensor, start_index: int, num_frames: int, label: str) -> torch.Tensor:
	total = int(tensor.shape[0])
	count = max(1, int(num_frames))
	start = int(start_index)
	if start == -1:
		start = max(0, total - count)
	if start < 0 or start >= total:
		raise RuntimeError(f"图片范围截取失败：{label}起始帧超出范围。当前批量共有 {total} 帧，起始帧为 {start_index}。")
	end = min(start + count, total)
	return tensor[start:end].contiguous()


class GJJ_GetImageRangeFromBatch:
	DESCRIPTION = "从图片或遮罩批量中截取指定范围；复刻 KJNodes 的 GetImageRangeFromBatch，零外部依赖。"
	CATEGORY = "GJJ/图像"
	FUNCTION = "images_from_batch"
	RETURN_TYPES = (IMAGE_BATCH_TYPE, "MASK")
	RETURN_NAMES = ("图片范围", "遮罩范围")
	OUTPUT_TOOLTIPS = (
		"从输入图片批量中截取出的连续图片范围。start_index=-1 时输出最后 num_frames 张。",
		"从输入遮罩批量中截取出的连续遮罩范围。start_index=-1 时输出最后 num_frames 张。",
	)
	SEARCH_ALIASES = ["GetImageRangeFromBatch", "image range", "batch range", "图片范围", "批量截取", "截取帧"]

	@classmethod
	def INPUT_TYPES(cls):
		return {
			"required": {
				"start_index": ("INT", {
					"default": 0,
					"min": -1,
					"max": 4096,
					"step": 1,
					"display_name": "起始帧",
					"tooltip": "从第几帧开始截取。0 表示第一帧；-1 表示从末尾倒推 num_frames 帧。",
				}),
				"num_frames": ("INT", {
					"default": 1,
					"min": 1,
					"max": 4096,
					"step": 1,
					"display_name": "截取帧数",
					"tooltip": "要截取的连续帧数。超过批量末尾时会自动截到最后一帧。",
				}),
			},
			"optional": {
				"images": (IMAGE_BATCH_TYPE, {
					"display_name": "图片批量",
					"tooltip": "可选。支持普通 IMAGE batch 或 GJJ_BATCH_IMAGE 图片队列。",
				}),
				"masks": ("MASK", {
					"display_name": "遮罩批量",
					"tooltip": "可选。支持 MASK 或 MASK batch。",
				}),
			},
		}

	def images_from_batch(self, start_index: int, num_frames: int, images=None, masks=None):
		image_batch = _normalize_image_batch(images)
		mask_batch = _normalize_mask_batch(masks)
		if image_batch is None and mask_batch is None:
			raise RuntimeError("图片范围截取失败：请至少连接图片批量或遮罩批量。")

		chosen_images = _slice_batch(image_batch, start_index, num_frames, "图片") if image_batch is not None else None
		chosen_masks = _slice_batch(mask_batch, start_index, num_frames, "遮罩") if mask_batch is not None else None
		return (chosen_images, chosen_masks)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_GetImageRangeFromBatch}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ 批量图片范围截取"}
