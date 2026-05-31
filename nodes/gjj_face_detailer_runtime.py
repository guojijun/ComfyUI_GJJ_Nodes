from __future__ import annotations

import inspect
import logging
import os
import time
from typing import Any

import folder_paths
import numpy as np
import torch
import torch.nn.functional as F
import comfy
from comfy import model_management
from nodes import InpaintModelConditioning, MAX_RESOLUTION, VAEEncode, VAEEncodeTiled, VAEDecodeTiled, common_ksampler

from .gjj_ultralytics_runtime import SEG, available_ultralytics_bbox_models, ensure_ultralytics_model_paths, load_ultralytics_bbox_detector


_cv2 = None
_SamPredictor = None
_sam_model_registry = None


# 延迟导入：运行时依赖检查
def _load_cv2():
	"""运行时加载 cv2，失败时提供友好提示"""
	global _cv2
	if _cv2 is not None:
		return _cv2

	from .common_utils.dependency_checker import load_dependency_at_runtime

	_cv2 = load_dependency_at_runtime(
		module_name="cv2",
		node_name="GJJ · 人脸细节增强器",
		package_name="opencv-python",
		description="该节点需要 OpenCV 进行图像处理"
	)
	return _cv2


def _load_segment_anything():
	"""运行时加载 segment_anything，失败时提供友好提示"""
	global _SamPredictor, _sam_model_registry
	if _SamPredictor is not None and _sam_model_registry is not None:
		return _SamPredictor, _sam_model_registry

	try:
		from segment_anything import SamPredictor as _predictor, sam_model_registry as _registry
	except ImportError as exc:
		raise RuntimeError(
			f"\n 未找到 segment_anything 运行库。\n"
			f"\n"
			f"这个 GJJ 节点需要 segment-anything Python 包才能运行。\n"
			f"\n"
			f"🔧 安装命令：\n"
			f"  pip install git+https://github.com/facebookresearch/segment-anything.git\n"
			f"\n"
			f"原始导入错误：{exc}\n"
			f"\n"
			f"💡 提示：安装后请重启 ComfyUI 服务器。"
		) from exc

	_SamPredictor = _predictor
	_sam_model_registry = _registry
	return _SamPredictor, _sam_model_registry


def _load_dependencies():
	"""兼容旧调用：一次性加载 cv2 和 segment_anything。"""
	cv2_mod = _load_cv2()
	SamPredictor, sam_model_registry = _load_segment_anything()
	return cv2_mod, SamPredictor, sam_model_registry


SAM2_CONFIG_TABLE = {
    "sam2.1_hiera_base_plus.pt": "configs/sam2.1/sam2.1_hiera_b+.yaml",
    "sam2.1_hiera_large.pt": "configs/sam2.1/sam2.1_hiera_l.yaml",
    "sam2.1_hiera_small.pt": "configs/sam2.1/sam2.1_hiera_s.yaml",
    "sam2.1_hiera_tiny.pt": "configs/sam2.1/sam2.1_hiera_t.yaml",
    "sam2_hiera_tiny.pt": "configs/sam2/sam2_hiera_t.yaml",
    "sam2_hiera_small.pt": "configs/sam2/sam2_hiera_s.yaml",
    "sam2_hiera_base_plus.pt": "configs/sam2/sam2_hiera_b+.yaml",
    "sam2_hiera_large.pt": "configs/sam2/sam2_hiera_l.yaml",
}

try:
    from comfy_extras import nodes_differential_diffusion
except Exception:
    nodes_differential_diffusion = None

try:
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    from sam2.build_sam import build_sam2
    SAM2_AVAILABLE = True
except Exception:
    SAM2_AVAILABLE = False
    SAM2ImagePredictor = None
    build_sam2 = None


def get_schedulers() -> list[str]:
    return list(getattr(comfy.samplers.KSampler, "SCHEDULERS", []))


def ensure_model_paths() -> None:
    ensure_ultralytics_model_paths()
    try:
        folder_paths.add_model_folder_path("sams", os.path.join(folder_paths.models_dir, "sams"))
    except Exception:
        pass


def available_bbox_models() -> list[str]:
    ensure_model_paths()
    return available_ultralytics_bbox_models()


def available_sam_models() -> list[str]:
    ensure_model_paths()
    try:
        return [
            value for value in folder_paths.get_filename_list("sams")
            if "hq" not in value and (value.endswith(".pt") or value.endswith(".pth") or value.endswith(".safetensors"))
        ]
    except Exception:
        return []


def load_bbox_detector(model_name: str):
    return load_ultralytics_bbox_detector(model_name)


def _tensor_check_image(image):
    if image.ndim != 4:
        raise ValueError(f"Expected NHWC tensor, but found {image.ndim} dimensions")
    if image.shape[-1] not in (1, 3, 4):
        raise ValueError(f"Expected 1, 3 or 4 channels for image, but found {image.shape[-1]} channels")


def _tensor_check_mask(mask):
    if mask.ndim != 4:
        raise ValueError(f"Expected NHWC tensor for mask, but found {mask.ndim} dimensions")
    if mask.shape[-1] != 1:
        raise ValueError(f"Expected 1 channel for mask, but found {mask.shape[-1]} channels")


def tensor2pil(image):
    _tensor_check_image(image)
    return __import__("PIL.Image", fromlist=["Image"]).Image.fromarray(np.clip(255.0 * image.cpu().numpy().squeeze(0), 0, 255).astype(np.uint8))


def pil2tensor(image):
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)


def tensor_convert_rgba(image, prefer_copy=True):
    _tensor_check_image(image)
    channels = image.shape[-1]
    if channels == 4:
        return image.clone() if prefer_copy else image
    if channels == 3:
        alpha = torch.ones((*image.shape[:-1], 1), dtype=image.dtype, device=image.device)
        return torch.cat((image, alpha), dim=-1)
    if channels == 1:
        return image.repeat(1, 1, 1, 4)
    raise ValueError(f"illegal conversion (channels: {channels} -> 4)")


def tensor_convert_rgb(image, prefer_copy=True):
    _tensor_check_image(image)
    channels = image.shape[-1]
    if channels == 3:
        return image.clone() if prefer_copy else image
    if channels == 4:
        rgb = image[..., :3]
        return rgb.clone() if prefer_copy else rgb
    if channels == 1:
        return image.repeat(1, 1, 1, 3)
    raise ValueError(f"illegal conversion (channels: {channels} -> 3)")


def tensor_resize(image, w: int, h: int):
    _tensor_check_image(image)
    image = image.permute(0, 3, 1, 2)
    image = F.interpolate(image, size=(h, w), mode="bilinear", align_corners=False)
    return image.permute(0, 2, 3, 1)


def tensor_get_size(image):
    _tensor_check_image(image)
    _, h, w, _ = image.shape
    return w, h


def to_tensor(image):
    if isinstance(image, torch.Tensor):
        return image
    if isinstance(image, np.ndarray):
        return torch.from_numpy(image)
    raise ValueError(f"Cannot convert {type(image)} to torch.Tensor")


def resize_mask(mask, size_hw):
    if isinstance(mask, np.ndarray):
        mask = torch.from_numpy(mask)
    if mask.ndim == 2:
        mask = mask.unsqueeze(0).unsqueeze(0)
    elif mask.ndim == 3:
        mask = mask.unsqueeze(0)
    mask = F.interpolate(mask.float(), size=size_hw, mode="bilinear", align_corners=False)
    return mask.squeeze(0)


def tensor_putalpha(image, mask):
    _tensor_check_image(image)
    _tensor_check_mask(mask)
    image[..., -1] = mask[..., 0]


def tensor_paste(image1, image2, left_top, mask):
    _tensor_check_image(image1)
    _tensor_check_image(image2)
    _tensor_check_mask(mask)
    if image2.shape[1:3] != mask.shape[1:3]:
        mask = resize_mask(mask.squeeze(dim=3), image2.shape[1:3]).unsqueeze(dim=3)

    x, y = left_top
    _, h1, w1, c1 = image1.shape
    _, h2, w2, c2 = image2.shape
    w = min(w1, x + w2) - x
    h = min(h1, y + h2) - y
    if w <= 0 or h <= 0:
        return

    mask = mask[:, :h, :w, :]
    region1 = image1[:, y:y + h, x:x + w, :]
    region2 = image2[:, :h, :w, :]

    if c1 == 3 and c2 == 3:
        image1[:, y:y + h, x:x + w, :] = (1 - mask) * region1 + mask * region2
    elif c1 == 4 and c2 == 4:
        image1[:, y:y + h, x:x + w, :3] = (1 - mask) * region1[:, :, :, :3] + mask * region2[:, :, :, :3]
        a1 = region1[:, :, :, 3:4]
        a2 = region2[:, :, :, 3:4] * mask
        image1[:, y:y + h, x:x + w, 3:4] = a1 + a2 * (1 - a1)
    elif c1 == 4 and c2 == 3:
        image1[:, y:y + h, x:x + w, :3] = (1 - mask) * region1[:, :, :, :3] + mask * region2
        image1[:, y:y + h, x:x + w, 3:4] = region1[:, :, :, 3:4] * (1 - mask) + mask
    elif c1 == 3 and c2 == 4:
        effective_mask = mask * region2[:, :, :, 3:4]
        image1[:, y:y + h, x:x + w, :] = (1 - effective_mask) * region1 + effective_mask * region2[:, :, :, :3]


def make_2d_mask(mask):
    if len(mask.shape) == 4:
        return mask.squeeze(0).squeeze(0)
    if len(mask.shape) == 3:
        return mask.squeeze(0)
    return mask


def make_3d_mask(mask):
    if len(mask.shape) == 4:
        return mask.squeeze(0)
    if len(mask.shape) == 2:
        return mask.unsqueeze(0)
    return mask


def center_of_bbox(bbox):
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    return bbox[0] + w / 2, bbox[1] + h / 2


def combine_masks2(masks):
    if len(masks) == 0:
        return None
    cv2_mod = _load_cv2()
    combined = np.array(masks[0]).astype(np.uint8)
    for mask in masks[1:]:
        cv2_mask = np.array(mask).astype(np.uint8)
        if combined.shape == cv2_mask.shape:
            combined = cv2_mod.bitwise_or(combined, cv2_mask)
    return torch.from_numpy(combined)


def is_same_device(a, b):
    a_device = torch.device(a) if isinstance(a, str) else a
    b_device = torch.device(b) if isinstance(b, str) else b
    return a_device.type == b_device.type and a_device.index == b_device.index


def dilate_mask(mask, dilation_factor, iterations=1):
    mask = make_2d_mask(mask)
    if dilation_factor == 0:
        return mask
    cv2_mod = _load_cv2()
    kernel = np.ones((abs(dilation_factor), abs(dilation_factor)), np.uint8)
    if dilation_factor > 0:
        return cv2_mod.dilate(mask, kernel, iterations)
    return cv2_mod.erode(mask, kernel, iterations)


def tensor_gaussian_blur_mask(mask, kernel_size, sigma=10.0):
    if isinstance(mask, np.ndarray):
        mask = torch.from_numpy(mask)
    if mask.ndim == 2:
        mask = mask[None, ..., None]
    elif mask.ndim == 3:
        mask = mask[..., None]
    _tensor_check_mask(mask)
    if kernel_size <= 0:
        return mask

    kernel_size = kernel_size * 2 + 1
    shortest = min(mask.shape[1], mask.shape[2])
    if shortest <= kernel_size:
        kernel_size = int(shortest / 2)
        if kernel_size % 2 == 0:
            kernel_size += 1
        if kernel_size < 3:
            return mask

    cv2_mod = _load_cv2()
    blurred_batch = []
    for item in mask:
        mask_np = item[..., 0].cpu().numpy().astype(np.float32)
        blurred = cv2_mod.GaussianBlur(mask_np, (kernel_size, kernel_size), sigmaX=sigma)
        blurred_batch.append(torch.from_numpy(blurred).unsqueeze(-1))
    return torch.stack(blurred_batch, dim=0).to(mask.dtype)


def normalize_region(limit, startp, size):
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


def make_crop_region(w, h, bbox, crop_factor, crop_min_size=None):
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
    new_x1, new_x2 = normalize_region(w, new_x1, crop_w)
    new_y1, new_y2 = normalize_region(h, new_y1, crop_h)
    return [new_x1, new_y1, new_x2, new_y2]


def crop_ndarray4(npimg, crop_region):
    x1, y1, x2, y2 = crop_region
    return npimg[:, y1:y2, x1:x2, :]


def crop_ndarray3(npimg, crop_region):
    x1, y1, x2, y2 = crop_region
    return npimg[:, y1:y2, x1:x2]


def crop_ndarray2(npimg, crop_region):
    x1, y1, x2, y2 = crop_region
    return npimg[y1:y2, x1:x2]


def to_latent_image(pixels, vae, vae_tiled_encode=False):
    start = time.time()
    if vae_tiled_encode:
        encoded = VAEEncodeTiled().encode(vae, pixels, 512, overlap=64)[0]
        logging.info(f"[GJJ] vae encoded (tiled) in {time.time() - start:.1f}s")
    else:
        encoded = VAEEncode().encode(vae, pixels)[0]
        logging.info(f"[GJJ] vae encoded in {time.time() - start:.1f}s")
    return encoded


def empty_pil_tensor(w=64, h=64):
    return torch.zeros((1, h, w, 3), dtype=torch.float32)


def crop_condition_mask(mask, image, crop_region):
    cond_scale = (mask.shape[1] / image.shape[1], mask.shape[2] / image.shape[2])
    mask_region = [round(value * cond_scale[index % 2]) for index, value in enumerate(crop_region)]
    return crop_ndarray3(mask, mask_region)


class SafeToGPU:
    def __init__(self, size):
        self.size = size

    def to_device(self, obj, device):
        if is_same_device(device, "cpu"):
            obj.to(device)
            return
        if is_same_device(obj.device, "cpu"):
            model_management.free_memory(self.size * 1.3, device)
            if model_management.get_free_memory(device) > self.size * 1.3:
                try:
                    obj.to(device)
                except Exception:
                    logging.warning(f"[GJJ] 模型未移动到 {device}，可能显存不足。")


class SafeToGPU_stub:
    def to_device(self, obj, device):
        return None


def sam_predict(predictor, points, plabs, bbox, threshold):
    point_coords = None if not points else np.array(points)
    point_labels = None if not plabs else np.array(plabs)
    box = np.array([bbox]) if bbox is not None else None
    cur_masks, scores, _ = predictor.predict(point_coords=point_coords, point_labels=point_labels, box=box)

    total_masks = []
    selected = False
    max_score = 0
    max_mask = None
    for index in range(len(scores)):
        if scores[index] > max_score:
            max_score = scores[index]
            max_mask = cur_masks[index]
        if scores[index] >= threshold:
            selected = True
            total_masks.append(cur_masks[index])
    if not selected and max_mask is not None:
        total_masks.append(max_mask)
    return total_masks


class SAMWrapper:
    def __init__(self, model, is_auto_mode, safe_to_gpu=None):
        self.model = model
        self.safe_to_gpu = safe_to_gpu if safe_to_gpu is not None else SafeToGPU_stub()
        self.is_auto_mode = is_auto_mode

    def prepare_device(self):
        if self.is_auto_mode:
            device = comfy.model_management.get_torch_device()
            self.safe_to_gpu.to_device(self.model, device=device)

    def release_device(self):
        if self.is_auto_mode:
            self.model.to(device="cpu")

    def predict(self, image, points, plabs, bbox, threshold):
        SamPredictor, _sam_registry = _load_segment_anything()
        predictor = SamPredictor(self.model)
        predictor.set_image(image, "RGB")
        return sam_predict(predictor, points, plabs, bbox, threshold)


class SAM2Wrapper:
    def __init__(self, config, modelname, is_auto_mode, safe_to_gpu=None, device_mode="AUTO"):
        if not SAM2_AVAILABLE:
            raise RuntimeError("当前环境未安装 sam2，无法加载 SAM2 模型。")
        self.config = config
        self.modelname = modelname
        self.image_predictor = None
        self.device_mode = device_mode
        self.safe_to_gpu = safe_to_gpu if safe_to_gpu is not None else SafeToGPU_stub()
        self.is_auto_mode = is_auto_mode

    def prepare_device(self):
        if self.image_predictor is None:
            self.image_predictor = SAM2ImagePredictor(build_sam2(self.config, self.modelname))
        if self.is_auto_mode:
            device = comfy.model_management.get_torch_device()
            self.safe_to_gpu.to_device(self.image_predictor.model, device=device)

    def release_device(self):
        if self.is_auto_mode and self.image_predictor is not None:
            self.image_predictor.model.to(device="cpu")

    def predict(self, image, points, plabs, bbox, threshold):
        self.prepare_device()
        self.image_predictor.set_image(image)
        return sam_predict(self.image_predictor, points, plabs, bbox, threshold)


def load_sam_model(model_name: str | None, device_mode: str = "AUTO"):
    if not model_name or model_name == "none":
        return None
    ensure_model_paths()
    model_path = folder_paths.get_full_path("sams", model_name)
    if not model_path:
        raise RuntimeError(f"未找到 SAM 模型：{model_name}")

    safe_to = SafeToGPU(os.path.getsize(model_path))
    if model_name in SAM2_CONFIG_TABLE:
        container = type("_SAM2Container", (), {})()
        container.sam_wrapper = SAM2Wrapper(
            config=SAM2_CONFIG_TABLE[model_name],
            modelname=model_path,
            is_auto_mode=device_mode == "AUTO",
            safe_to_gpu=safe_to,
            device_mode=device_mode,
        )
        return container

    if "vit_h" in model_name:
        model_kind = "vit_h"
    elif "vit_l" in model_name:
        model_kind = "vit_l"
    else:
        model_kind = "vit_b"

    _SamPredictor, sam_model_registry = _load_segment_anything()
    sam = sam_model_registry[model_kind](checkpoint=model_path)
    if device_mode == "Prefer GPU":
        device = comfy.model_management.get_torch_device()
        safe_to.to_device(sam, device)

    sam.sam_wrapper = SAMWrapper(sam, is_auto_mode=device_mode == "AUTO", safe_to_gpu=safe_to)
    return sam


def gen_detection_hints_from_mask_area(x, y, mask, threshold, use_negative):
    mask = make_2d_mask(mask)
    points = []
    plabs = []
    y_step = max(3, int(mask.shape[0] / 20))
    x_step = max(3, int(mask.shape[1] / 20))
    for row in range(0, len(mask), y_step):
        for col in range(0, len(mask[row]), x_step):
            if mask[row][col] > threshold:
                points.append((x + col, y + row))
                plabs.append(1)
            elif use_negative and mask[row][col] == 0:
                points.append((x + col, y + row))
                plabs.append(0)
    return points, plabs


def gen_negative_hints(w, h, x1, y1, x2, y2):
    npoints = []
    nplabs = []
    y_step = max(3, int(w / 20))
    x_step = max(3, int(h / 20))
    for row in range(10, h - 10, y_step):
        for col in range(10, w - 10, x_step):
            if not (x1 - 10 <= col <= x2 + 10 and y1 - 10 <= row <= y2 + 10):
                npoints.append((col, row))
                nplabs.append(0)
    return npoints, nplabs


def generate_detection_hints(image, seg, center, detection_hint, dilated_bbox, mask_hint_threshold, use_small_negative, mask_hint_use_negative):
    x1, y1, x2, y2 = dilated_bbox
    points = []
    plabs = []
    if detection_hint == "center-1":
        points.append(center)
        plabs = [1]
    elif detection_hint == "horizontal-2":
        gap = (x2 - x1) / 3
        points.append((x1 + gap, center[1]))
        points.append((x1 + gap * 2, center[1]))
        plabs = [1, 1]
    elif detection_hint == "vertical-2":
        gap = (y2 - y1) / 3
        points.append((center[0], y1 + gap))
        points.append((center[0], y1 + gap * 2))
        plabs = [1, 1]
    elif detection_hint == "rect-4":
        x_gap = (x2 - x1) / 3
        y_gap = (y2 - y1) / 3
        points.append((x1 + x_gap, center[1]))
        points.append((x1 + x_gap * 2, center[1]))
        points.append((center[0], y1 + y_gap))
        points.append((center[0], y1 + y_gap * 2))
        plabs = [1, 1, 1, 1]
    elif detection_hint == "diamond-4":
        x_gap = (x2 - x1) / 3
        y_gap = (y2 - y1) / 3
        points.append((x1 + x_gap, y1 + y_gap))
        points.append((x1 + x_gap * 2, y1 + y_gap))
        points.append((x1 + x_gap, y1 + y_gap * 2))
        points.append((x1 + x_gap * 2, y1 + y_gap * 2))
        plabs = [1, 1, 1, 1]
    elif detection_hint == "mask-point-bbox":
        points.append(center)
        plabs = [1]
    elif detection_hint == "mask-area":
        points, plabs = gen_detection_hints_from_mask_area(seg.crop_region[0], seg.crop_region[1], seg.cropped_mask, mask_hint_threshold, use_small_negative)

    if mask_hint_use_negative == "Outter":
        npoints, nplabs = gen_negative_hints(image.shape[0], image.shape[1], seg.crop_region[0], seg.crop_region[1], seg.crop_region[2], seg.crop_region[3])
        points += npoints
        plabs += nplabs
    return points, plabs


def make_sam_mask(sam, segs, image, detection_hint, dilation, threshold, bbox_expansion, mask_hint_threshold, mask_hint_use_negative):
    if not hasattr(sam, "sam_wrapper"):
        raise RuntimeError("无效的 SAM 模型输入。请使用 GJJ 的 SAM 模型加载器。")
    sam_obj = sam.sam_wrapper
    sam_obj.prepare_device()
    try:
        image_np = np.clip(255.0 * image.cpu().numpy().squeeze(), 0, 255).astype(np.uint8)
        total_masks = []
        use_small_negative = mask_hint_use_negative == "Small"
        seg_items = segs[1]

        if detection_hint == "mask-points":
            points = []
            plabs = []
            for seg in seg_items:
                bbox = seg.bbox
                center = center_of_bbox(bbox)
                points.append(center)
                plabs.append(0 if (use_small_negative and bbox[2] - bbox[0] < 10) else 1)
            total_masks += sam_obj.predict(image_np, points, plabs, None, threshold)
        else:
            for seg in seg_items:
                bbox = seg.bbox
                center = center_of_bbox(bbox)
                x1 = max(bbox[0] - bbox_expansion, 0)
                y1 = max(bbox[1] - bbox_expansion, 0)
                x2 = min(bbox[2] + bbox_expansion, image_np.shape[1])
                y2 = min(bbox[3] + bbox_expansion, image_np.shape[0])
                dilated_bbox = [x1, y1, x2, y2]
                points, plabs = generate_detection_hints(image_np, seg, center, detection_hint, dilated_bbox, mask_hint_threshold, use_small_negative, mask_hint_use_negative)
                total_masks += sam_obj.predict(image_np, points, plabs, dilated_bbox, threshold)

        mask = combine_masks2(total_masks)
    finally:
        sam_obj.release_device()

    if mask is not None:
        mask = torch.from_numpy(dilate_mask(mask.float().cpu().numpy(), dilation)).float()
    else:
        size = image_np.shape[0], image_np.shape[1]
        mask = torch.zeros(size, dtype=torch.float32, device="cpu")
    return make_3d_mask(mask)


def segs_scale_match(segs, target_shape):
    h, w = segs[0]
    th = target_shape[1]
    tw = target_shape[2]
    if (h == th and w == tw) or h == 0 or w == 0:
        return segs

    rh = th / h
    rw = tw / w
    new_segs = []
    for seg in segs[1]:
        cropped_image = seg.cropped_image
        cropped_mask = seg.cropped_mask
        x1, y1, x2, y2 = seg.crop_region
        bx1, by1, bx2, by2 = seg.bbox
        crop_region = int(x1 * rw), int(y1 * rh), int(x2 * rw), int(y2 * rh)
        bbox = int(bx1 * rw), int(by1 * rh), int(bx2 * rw), int(by2 * rh)
        new_w = crop_region[2] - crop_region[0]
        new_h = crop_region[3] - crop_region[1]

        if isinstance(cropped_mask, np.ndarray):
            cropped_mask_t = torch.from_numpy(cropped_mask).unsqueeze(0).unsqueeze(0)
        else:
            cropped_mask_t = cropped_mask.unsqueeze(0).unsqueeze(0) if cropped_mask.ndim == 2 else cropped_mask.unsqueeze(0)
        cropped_mask_t = F.interpolate(cropped_mask_t.float(), size=(new_h, new_w), mode="bilinear", align_corners=False)
        cropped_mask_new = cropped_mask_t.squeeze().cpu().numpy()

        if cropped_image is not None:
            cropped_image_t = cropped_image if isinstance(cropped_image, torch.Tensor) else torch.from_numpy(cropped_image)
            if cropped_image_t.ndim == 3:
                cropped_image_t = cropped_image_t.unsqueeze(0)
            cropped_image_new = tensor_resize(cropped_image_t, new_w, new_h).cpu().numpy()
        else:
            cropped_image_new = None

        new_segs.append(SEG(cropped_image_new, cropped_mask_new, seg.confidence, crop_region, bbox, seg.label, seg.control_net_wrapper))
    return (th, tw), new_segs


def segs_bitwise_and_mask(segs, mask):
    mask = make_2d_mask(mask)
    if mask is None:
        logging.warning("[GJJ] 无法执行 SEGS 遮罩过滤：MASK 为空。")
        return ([],)
    items = []
    mask_np = (mask.cpu().numpy() * 255).astype(np.uint8)
    for seg in segs[1]:
        cropped_mask = (seg.cropped_mask * 255).astype(np.uint8)
        crop_region = seg.crop_region
        cropped_mask2 = mask_np[crop_region[1]:crop_region[3], crop_region[0]:crop_region[2]]
        new_mask = np.bitwise_and(cropped_mask.astype(np.uint8), cropped_mask2).astype(np.float32) / 255.0
        items.append(SEG(seg.cropped_image, new_mask, seg.confidence, seg.crop_region, seg.bbox, seg.label, None))
    return segs[0], items


def segs_to_combined_mask(segs):
    h, w = segs[0]
    mask = np.zeros((h, w), dtype=np.uint8)
    for seg in segs[1]:
        crop_region = seg.crop_region
        mask[crop_region[1]:crop_region[3], crop_region[0]:crop_region[2]] |= (seg.cropped_mask * 255).astype(np.uint8)
    return torch.from_numpy(mask.astype(np.float32) / 255.0)


def _maybe_apply_differential_diffusion(model, noise_mask_feather):
    if noise_mask_feather <= 0 or nodes_differential_diffusion is None:
        return model
    if "denoise_mask_function" not in getattr(model, "model_options", {}):
        try:
            return nodes_differential_diffusion.DifferentialDiffusion().execute(model)[0]
        except Exception:
            return model
    return model


def _call_detailer_hook(obj, method_name, *args):
    if obj is None or not hasattr(obj, method_name):
        return None, False
    return getattr(obj, method_name)(*args), True


def enhance_detail(
    image,
    model,
    clip,
    vae,
    guide_size,
    guide_size_for_bbox,
    max_size,
    bbox,
    seed,
    steps,
    cfg,
    sampler_name,
    scheduler,
    positive,
    negative,
    denoise,
    noise_mask,
    force_inpaint,
    wildcard_opt=None,
    wildcard_opt_concat_mode=None,
    detailer_hook=None,
    refiner_ratio=None,
    refiner_model=None,
    refiner_clip=None,
    refiner_positive=None,
    refiner_negative=None,
    control_net_wrapper=None,
    cycle=1,
    inpaint_model=False,
    noise_mask_feather=0,
    scheduler_func=None,
    vae_tiled_encode=False,
    vae_tiled_decode=False,
):
    if noise_mask is not None:
        noise_mask = tensor_gaussian_blur_mask(noise_mask, noise_mask_feather).squeeze(3)
        model = _maybe_apply_differential_diffusion(model, noise_mask_feather)

    h = image.shape[1]
    w = image.shape[2]
    bbox_h = bbox[3] - bbox[1]
    bbox_w = bbox[2] - bbox[0]

    if not force_inpaint and bbox_h >= guide_size and bbox_w >= guide_size:
        logging.info("[GJJ] Detailer: segment skip (enough big)")
        return None, None

    if guide_size_for_bbox:
        upscale = guide_size / min(bbox_w, bbox_h)
    else:
        upscale = guide_size / min(w, h)

    new_w = int(w * upscale)
    new_h = int(h * upscale)
    if new_w > max_size or new_h > max_size:
        upscale *= max_size / max(new_w, new_h)
        new_w = int(w * upscale)
        new_h = int(h * upscale)

    if not force_inpaint:
        if upscale <= 1.0 or new_w == 0 or new_h == 0:
            logging.info(f"[GJJ] Detailer: segment skip [determined upscale factor={upscale}]")
            return None, None
    else:
        if upscale <= 1.0 or new_w == 0 or new_h == 0:
            logging.info("[GJJ] Detailer: force inpaint")
            upscale = 1.0
            new_w = w
            new_h = h

    if detailer_hook is not None and hasattr(detailer_hook, "touch_scaled_size"):
        new_w, new_h = detailer_hook.touch_scaled_size(new_w, new_h)

    upscaled_image = tensor_resize(image, new_w, new_h)
    if detailer_hook is not None and hasattr(detailer_hook, "post_upscale"):
        upscaled_image = detailer_hook.post_upscale(upscaled_image, noise_mask)

    cnet_pils = []
    if detailer_hook is not None and hasattr(detailer_hook, "get_skip_sampling") and detailer_hook.get_skip_sampling():
        refined_image = upscaled_image
    else:
        if noise_mask is not None and inpaint_model:
            encode_fn = InpaintModelConditioning().encode
            if "noise_mask" in inspect.signature(encode_fn).parameters:
                positive, negative, latent_image = encode_fn(positive, negative, upscaled_image, vae, mask=noise_mask, noise_mask=True)
            else:
                positive, negative, latent_image = encode_fn(positive, negative, upscaled_image, vae, noise_mask)
        else:
            latent_image = to_latent_image(upscaled_image, vae, vae_tiled_encode=vae_tiled_encode)
            if noise_mask is not None:
                latent_image["noise_mask"] = noise_mask

        if detailer_hook is not None and hasattr(detailer_hook, "post_encode"):
            latent_image = detailer_hook.post_encode(latent_image)

        refined_latent = latent_image
        for cycle_index in range(cycle):
            if detailer_hook is not None and hasattr(detailer_hook, "cycle_latent"):
                refined_latent = detailer_hook.cycle_latent(refined_latent)
            if detailer_hook is not None and hasattr(detailer_hook, "pre_ksample"):
                model2, seed2, steps2, cfg2, sampler_name2, scheduler2, positive2, negative2, _upscaled_latent2, denoise2 = detailer_hook.pre_ksample(
                    model, seed + cycle_index, steps, cfg, sampler_name, scheduler, positive, negative, latent_image, denoise
                )
            else:
                model2, seed2, steps2, cfg2, sampler_name2, scheduler2, positive2, negative2, denoise2 = (
                    model,
                    seed + cycle_index,
                    steps,
                    cfg,
                    sampler_name,
                    scheduler,
                    positive,
                    negative,
                    denoise,
                )
            refined_latent = common_ksampler(model2, seed2, steps2, cfg2, sampler_name2, scheduler2, positive2, negative2, refined_latent, denoise=denoise2)[0]

        if detailer_hook is not None and hasattr(detailer_hook, "pre_decode"):
            refined_latent = detailer_hook.pre_decode(refined_latent)

        start = time.time()
        if vae_tiled_decode:
            refined_image = VAEDecodeTiled().decode(vae, refined_latent, 512)[0]
            logging.info(f"[GJJ] vae decoded (tiled) in {time.time() - start:.1f}s")
        else:
            try:
                refined_image = vae.decode(refined_latent["samples"])
            except Exception:
                logging.warning(f"[GJJ] failed after {time.time() - start:.1f}s, retry vae.decode_tiled 64...")
                refined_image = vae.decode_tiled(refined_latent["samples"], tile_x=64, tile_y=64)
            logging.info(f"[GJJ] vae decoded in {time.time() - start:.1f}s")

    if detailer_hook is not None and hasattr(detailer_hook, "post_decode"):
        refined_image = detailer_hook.post_decode(refined_image)

    if len(refined_image.shape) == 5:
        refined_image = refined_image.squeeze(0)

    refined_image = tensor_resize(refined_image, w, h).cpu()
    return refined_image, cnet_pils


def detailer_for_each_do_detail(
    image,
    segs,
    model,
    clip,
    vae,
    guide_size,
    guide_size_for_bbox,
    max_size,
    seed,
    steps,
    cfg,
    sampler_name,
    scheduler,
    positive,
    negative,
    denoise,
    feather,
    noise_mask,
    force_inpaint,
    wildcard_opt=None,
    detailer_hook=None,
    cycle=1,
    inpaint_model=False,
    noise_mask_feather=0,
    scheduler_func_opt=None,
    tiled_encode=False,
    tiled_decode=False,
):
    if len(image) > 1:
        raise RuntimeError("[GJJ] DetailerForEach 不支持批量图片输入，请逐张处理。")

    image = image.clone()
    enhanced_alpha_list = []
    enhanced_list = []
    cropped_list = []
    cnet_pil_list = []
    segs = segs_scale_match(segs, image.shape)
    new_segs = []

    model = _maybe_apply_differential_diffusion(model, noise_mask_feather)

    for index, seg in enumerate(segs[1]):
        cropped_image = to_tensor(crop_ndarray4(image.cpu().numpy(), seg.crop_region))
        if cropped_image.ndim == 3:
            cropped_image = cropped_image.unsqueeze(0)
        mask = to_tensor(seg.cropped_mask)
        mask = tensor_gaussian_blur_mask(mask, feather)

        is_mask_all_zeros = (seg.cropped_mask == 0).all().item() if hasattr((seg.cropped_mask == 0), "all") else bool(np.all(seg.cropped_mask == 0))
        if is_mask_all_zeros:
            logging.info("[GJJ] Detailer: segment skip [empty mask]")
            continue

        cropped_mask = seg.cropped_mask if noise_mask else None
        if not isinstance(positive, str):
            cropped_positive = [
                [condition, {key: crop_condition_mask(value, image, seg.crop_region) if key == "mask" else value for key, value in details.items()}]
                for condition, details in positive
            ]
        else:
            cropped_positive = positive

        if not isinstance(negative, str):
            cropped_negative = [
                [condition, {key: crop_condition_mask(value, image, seg.crop_region) if key == "mask" else value for key, value in details.items()}]
                for condition, details in negative
            ]
        else:
            cropped_negative = negative

        orig_cropped_image = cropped_image.clone()
        enhanced_image, cnet_pils = enhance_detail(
            cropped_image,
            model,
            clip,
            vae,
            guide_size,
            guide_size_for_bbox,
            max_size,
            seg.bbox,
            seed + index,
            steps,
            cfg,
            sampler_name,
            scheduler,
            cropped_positive,
            cropped_negative,
            denoise,
            cropped_mask,
            force_inpaint,
            wildcard_opt=wildcard_opt,
            detailer_hook=detailer_hook,
            cycle=cycle,
            inpaint_model=inpaint_model,
            noise_mask_feather=noise_mask_feather,
            scheduler_func=scheduler_func_opt,
            vae_tiled_encode=tiled_encode,
            vae_tiled_decode=tiled_decode,
        )

        if cnet_pils:
            cnet_pil_list.extend(cnet_pils)

        if enhanced_image is not None:
            image = image.cpu()
            enhanced_image = enhanced_image.cpu()
            tensor_paste(image, enhanced_image, (seg.crop_region[0], seg.crop_region[1]), mask)
            enhanced_list.append(enhanced_image)
            if detailer_hook is not None and hasattr(detailer_hook, "post_paste"):
                image = detailer_hook.post_paste(image)

        if enhanced_image is not None:
            enhanced_image_alpha = tensor_convert_rgba(enhanced_image)
            new_seg_image = enhanced_image.numpy()
            mask_for_alpha = tensor_resize(mask, *tensor_get_size(enhanced_image))
            tensor_putalpha(enhanced_image_alpha, mask_for_alpha)
            enhanced_alpha_list.append(enhanced_image_alpha)
        else:
            new_seg_image = None

        cropped_list.append(orig_cropped_image)
        new_segs.append(SEG(new_seg_image, seg.cropped_mask, seg.confidence, seg.crop_region, seg.bbox, seg.label, seg.control_net_wrapper))

    image_tensor = tensor_convert_rgb(image)
    cropped_list.sort(key=lambda value: value.shape, reverse=True)
    enhanced_list.sort(key=lambda value: value.shape, reverse=True)
    enhanced_alpha_list.sort(key=lambda value: value.shape, reverse=True)
    return image_tensor, cropped_list, enhanced_list, enhanced_alpha_list, cnet_pil_list, (segs[0], new_segs)
