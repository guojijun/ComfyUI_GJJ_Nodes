from __future__ import annotations

import logging
import os
from collections import namedtuple
from typing import Any

import folder_paths
import numpy as np
import torch
from PIL import Image

# 延迟导入：运行时依赖检查
def _load_cv2():
	"""运行时加载 cv2，失败时提供友好提示"""
	from .common_utils.dependency_checker import load_dependency_at_runtime
	return load_dependency_at_runtime(
		module_name="cv2",
		node_name="GJJ · Ultralytics 运行库",
		package_name="opencv-python",
		description="该模块需要 OpenCV 进行图像处理"
	)


SEG = namedtuple(
    "SEG",
    ["cropped_image", "cropped_mask", "confidence", "crop_region", "bbox", "label", "control_net_wrapper"],
    defaults=[None],
)


def ensure_ultralytics_model_paths() -> None:
    bbox_dir = os.path.join(folder_paths.models_dir, "ultralytics", "bbox")
    try:
        folder_paths.add_model_folder_path("ultralytics_bbox", bbox_dir)
    except Exception:
        pass

    if "ultralytics_bbox" in folder_paths.folder_names_and_paths:
        paths, extensions = folder_paths.folder_names_and_paths["ultralytics_bbox"]
        folder_paths.folder_names_and_paths["ultralytics_bbox"] = (
            paths,
            extensions | set(folder_paths.supported_pt_extensions),
        )


def available_ultralytics_bbox_models() -> list[str]:
    ensure_ultralytics_model_paths()
    try:
        return list(folder_paths.get_filename_list("ultralytics_bbox"))
    except Exception:
        return []


def _normalize_region(limit: int, startp: float, size: float) -> tuple[int, int]:
    if startp < 0:
        new_endp = min(limit, size)
        new_startp = 0
    elif startp + size > limit:
        new_startp = max(0, limit - size)
        new_endp = limit
    else:
        new_startp = startp
        new_endp = min(limit, startp + size)

    return int(new_startp), int(new_endp)


def make_crop_region(w: int, h: int, bbox, crop_factor: float, crop_min_size: int | None = None):
    x1, y1, x2, y2 = bbox
    bbox_w = x2 - x1
    bbox_h = y2 - y1
    crop_w = bbox_w * crop_factor
    crop_h = bbox_h * crop_factor

    if crop_min_size is not None:
        crop_w = max(crop_min_size, crop_w)
        crop_h = max(crop_min_size, crop_h)

    kernel_x = x1 + bbox_w / 2
    kernel_y = y1 + bbox_h / 2
    new_x1 = int(kernel_x - crop_w / 2)
    new_y1 = int(kernel_y - crop_h / 2)
    new_x1, new_x2 = _normalize_region(w, new_x1, crop_w)
    new_y1, new_y2 = _normalize_region(h, new_y1, crop_h)
    return [new_x1, new_y1, new_x2, new_y2]


def crop_ndarray2(npimg, crop_region):
    x1, y1, x2, y2 = crop_region
    return npimg[y1:y2, x1:x2]


def crop_ndarray4(npimg, crop_region):
    x1, y1, x2, y2 = crop_region
    return npimg[:, y1:y2, x1:x2, :]


def crop_image(image, crop_region):
    return crop_ndarray4(image, crop_region)


def tensor2pil(image):
    if image.ndim != 4:
        raise ValueError(f"Expected NHWC tensor, but found {image.ndim} dimensions")
    if image.shape[-1] not in (1, 3, 4):
        raise ValueError(f"Expected 1, 3 or 4 channels for image, but found {image.shape[-1]} channels")
    return Image.fromarray(np.clip(255.0 * image.cpu().numpy().squeeze(0), 0, 255).astype(np.uint8))


def create_segmasks(results):
    bboxs = results[1]
    segms = results[2]
    confidence = results[3]
    items = []
    for index in range(len(segms)):
        items.append((bboxs[index], segms[index].astype(np.float32), confidence[index]))
    return items


def dilate_masks(segmasks, dilation_factor: int, iterations: int = 1):
	if dilation_factor == 0:
		return segmasks

	cv2 = _load_cv2()
	kernel = np.ones((abs(dilation_factor), abs(dilation_factor)), np.uint8)
	result = []
	for item_bbox, item_mask, confidence in segmasks:
		if dilation_factor > 0:
			new_mask = cv2.dilate(item_mask, kernel, iterations)
		else:
			new_mask = cv2.erode(item_mask, kernel, iterations)
		result.append((item_bbox, new_mask, confidence))
	return result


def combine_masks(masks):
	if len(masks) == 0:
		return None

	cv2 = _load_cv2()
	combined_cv2_mask = np.array(masks[0][1])
	for index in range(1, len(masks)):
		cv2_mask = np.array(masks[index][1])
		if combined_cv2_mask.shape == cv2_mask.shape:
			combined_cv2_mask = cv2.bitwise_or(combined_cv2_mask, cv2_mask)
	return torch.from_numpy(combined_cv2_mask)


def _load_ultralytics_yolo():
    try:
        from ultralytics import YOLO
    except Exception as exc:
        raise RuntimeError(
            "当前环境缺少 ultralytics，无法加载 bbox 检测模型。请确认 comfyui-impact-subpack 或 ultralytics 依赖已安装。"
        ) from exc
    return YOLO


def load_yolo(model_path: str):
    YOLO = _load_ultralytics_yolo()
    return YOLO(model_path)


def load_ultralytics_bbox_detector(model_name: str):
    ensure_ultralytics_model_paths()
    if not str(model_name or "").strip():
        raise RuntimeError("未选择 bbox 检测模型。请先在 ComfyUI/models/ultralytics/bbox 中放入人脸检测模型。")

    model_path = folder_paths.get_full_path("ultralytics_bbox", model_name)
    if not model_path:
        raise RuntimeError(f"未找到 bbox 检测模型：{model_name}")

    return UltraBBoxDetector(load_yolo(model_path))


def inference_bbox(model, image: Image.Image, confidence: float = 0.3, device: str = ""):
	cv2 = _load_cv2()
	pred = model(image, conf=confidence, device=device)
	bboxes = pred[0].boxes.xyxy.cpu().numpy()

	cv2_image = np.array(image)
	if len(cv2_image.shape) == 3:
		cv2_image = cv2_image[:, :, ::-1].copy()
	else:
		cv2_image = cv2.cvtColor(cv2_image, cv2.COLOR_GRAY2BGR)
	cv2_gray = cv2.cvtColor(cv2_image, cv2.COLOR_BGR2GRAY)

	segms = []
	for x0, y0, x1, y1 in bboxes:
		cv2_mask = np.zeros(cv2_gray.shape, np.uint8)
		cv2.rectangle(cv2_mask, (int(x0), int(y0)), (int(x1), int(y1)), 255, -1)
		segms.append(cv2_mask.astype(bool))

	if len(bboxes) == 0:
		return [[], [], [], []]

	results = [[], [], [], []]
	for index in range(len(bboxes)):
		results[0].append(pred[0].names[int(pred[0].boxes[index].cls.item())])
		results[1].append(bboxes[index])
		results[2].append(segms[index])
		results[3].append(pred[0].boxes[index].conf.cpu().numpy())
	return results


class UltraBBoxDetector:
    def __init__(self, bbox_model):
        self.bbox_model = bbox_model
        self.aux = None

    def detect(self, image, threshold, dilation, crop_factor, drop_size=1, detailer_hook=None):
        drop_size = max(int(drop_size), 1)
        detected_results = inference_bbox(self.bbox_model, tensor2pil(image), float(threshold))
        segmasks = create_segmasks(detected_results)
        if dilation != 0:
            segmasks = dilate_masks(segmasks, int(dilation))

        items = []
        h = image.shape[1]
        w = image.shape[2]

        for segmask_item, label in zip(segmasks, detected_results[0]):
            item_bbox = segmask_item[0]
            item_mask = segmask_item[1]
            y1, x1, y2, x2 = item_bbox

            if x2 - x1 > drop_size and y2 - y1 > drop_size:
                crop_region = make_crop_region(w, h, item_bbox, crop_factor)
                if detailer_hook is not None:
                    crop_region = detailer_hook.post_crop_region(w, h, item_bbox, crop_region)

                cropped_image = crop_image(image, crop_region)
                cropped_mask = crop_ndarray2(item_mask, crop_region)
                confidence = segmask_item[2]
                items.append(SEG(cropped_image, cropped_mask, confidence, crop_region, item_bbox, label, None))

        segs = ((image.shape[1], image.shape[2]), items)
        if detailer_hook is not None and hasattr(detailer_hook, "post_detection"):
            segs = detailer_hook.post_detection(segs)
        return segs

    def detect_combined(self, image, threshold, dilation):
        detected_results = inference_bbox(self.bbox_model, tensor2pil(image), float(threshold))
        segmasks = create_segmasks(detected_results)
        if dilation != 0:
            segmasks = dilate_masks(segmasks, int(dilation))
        return combine_masks(segmasks)

    def setAux(self, value: Any):
        self.aux = value
        logging.debug(f"[GJJ] UltraBBoxDetector aux set to: {value}")
