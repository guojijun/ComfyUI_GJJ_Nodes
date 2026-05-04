# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# Consolidated inference data utilities for SAM 3D Body.
# Sources: prepare_batch.py, common.py (transforms), bbox_utils.py, io.py

import logging
import math
import time
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

import cv2
import numpy as np
import torch
import torch.nn as nn
import torchvision.transforms.functional as TF
from PIL import Image
from torch.utils.data import default_collate

from .utils_model import to_2tuple

log = logging.getLogger("sam3dbody")


# =============================================================================
# bbox_utils.py — Bounding box conversion (inference-relevant subset)
# =============================================================================

def bbox_xyxy2cs(
    bbox: np.ndarray, padding: float = 1.0
) -> Tuple[np.ndarray, np.ndarray]:
    dim = bbox.ndim
    if dim == 1:
        bbox = bbox[None, :]
    x1, y1, x2, y2 = np.hsplit(bbox, [1, 2, 3])
    center = np.hstack([x1 + x2, y1 + y2]) * 0.5
    scale = np.hstack([x2 - x1, y2 - y1]) * padding
    if dim == 1:
        center = center[0]
        scale = scale[0]
    return center, scale


def bbox_xywh2cs(
    bbox: np.ndarray, padding: float = 1.0
) -> Tuple[np.ndarray, np.ndarray]:
    dim = bbox.ndim
    if dim == 1:
        bbox = bbox[None, :]
    x, y, w, h = np.hsplit(bbox, [1, 2, 3])
    center = np.hstack([x + w * 0.5, y + h * 0.5])
    scale = np.hstack([w, h]) * padding
    if dim == 1:
        center = center[0]
        scale = scale[0]
    return center, scale


def fix_aspect_ratio(bbox_scale: np.ndarray, aspect_ratio: float):
    dim = bbox_scale.ndim
    if dim == 1:
        bbox_scale = bbox_scale[None, :]
    w, h = np.hsplit(bbox_scale, [1])
    bbox_scale = np.where(
        w > h * aspect_ratio,
        np.hstack([w, w / aspect_ratio]),
        np.hstack([h * aspect_ratio, h]),
    )
    if dim == 1:
        bbox_scale = bbox_scale[0]
    return bbox_scale


def _rotate_point(pt: np.ndarray, angle_rad: float) -> np.ndarray:
    sn, cs = np.sin(angle_rad), np.cos(angle_rad)
    rot_mat = np.array([[cs, -sn], [sn, cs]])
    return rot_mat @ pt


def _get_3rd_point(a: np.ndarray, b: np.ndarray):
    direction = a - b
    c = b + np.r_[-direction[1], direction[0]]
    return c


def get_udp_warp_matrix(
    center: np.ndarray,
    scale: np.ndarray,
    rot: float,
    output_size: Tuple[int, int],
) -> np.ndarray:
    assert len(center) == 2
    assert len(scale) == 2
    assert len(output_size) == 2

    input_size = center * 2
    rot_rad = np.deg2rad(rot)
    warp_mat = np.zeros((2, 3), dtype=np.float32)
    scale_x = (output_size[0] - 1) / scale[0]
    scale_y = (output_size[1] - 1) / scale[1]
    warp_mat[0, 0] = math.cos(rot_rad) * scale_x
    warp_mat[0, 1] = -math.sin(rot_rad) * scale_x
    warp_mat[0, 2] = scale_x * (
        -0.5 * input_size[0] * math.cos(rot_rad)
        + 0.5 * input_size[1] * math.sin(rot_rad)
        + 0.5 * scale[0]
    )
    warp_mat[1, 0] = math.sin(rot_rad) * scale_y
    warp_mat[1, 1] = math.cos(rot_rad) * scale_y
    warp_mat[1, 2] = scale_y * (
        -0.5 * input_size[0] * math.sin(rot_rad)
        - 0.5 * input_size[1] * math.cos(rot_rad)
        + 0.5 * scale[1]
    )
    return warp_mat


def get_warp_matrix(
    center: np.ndarray,
    scale: np.ndarray,
    rot: float,
    output_size: Tuple[int, int],
    shift: Tuple[float, float] = (0.0, 0.0),
    inv: bool = False,
) -> np.ndarray:
    assert len(center) == 2
    assert len(scale) == 2
    assert len(output_size) == 2
    assert len(shift) == 2

    shift = np.array(shift)
    src_w = scale[0]
    dst_w = output_size[0]
    dst_h = output_size[1]

    rot_rad = np.deg2rad(rot)
    src_dir = _rotate_point(np.array([0.0, src_w * -0.5]), rot_rad)
    dst_dir = np.array([0.0, dst_w * -0.5])

    src = np.zeros((3, 2), dtype=np.float32)
    src[0, :] = center + scale * shift
    src[1, :] = center + src_dir + scale * shift
    src[2, :] = _get_3rd_point(src[0, :], src[1, :])

    dst = np.zeros((3, 2), dtype=np.float32)
    dst[0, :] = [dst_w * 0.5, dst_h * 0.5]
    dst[1, :] = np.array([dst_w * 0.5, dst_h * 0.5]) + dst_dir
    dst[2, :] = _get_3rd_point(dst[0, :], dst[1, :])

    if inv:
        warp_mat = cv2.getAffineTransform(np.float32(dst), np.float32(src))
    else:
        warp_mat = cv2.getAffineTransform(np.float32(src), np.float32(dst))
    return warp_mat


# =============================================================================
# common.py — Inference transforms
# =============================================================================

class Compose:
    def __init__(self, transforms: Optional[List[Callable]] = None):
        if transforms is None:
            transforms = []
        self.transforms = transforms

    def __call__(self, data: dict) -> Optional[dict]:
        for t in self.transforms:
            data = t(data)
            if data is None:
                return None
        return data


class VisionTransformWrapper:
    def __init__(self, transform: Callable):
        self.transform = transform

    def __call__(self, results: Dict) -> Optional[dict]:
        results["img"] = self.transform(results["img"])
        return results


class GetBBoxCenterScale(nn.Module):
    def __init__(self, padding: float = 1.25) -> None:
        super().__init__()
        self.padding = padding

    def forward(self, results: Dict) -> Optional[dict]:
        if "bbox_center" in results and "bbox_scale" in results:
            results["bbox_scale"] *= self.padding
        else:
            bbox = results["bbox"]
            bbox_format = results.get("bbox_format", "none")
            if bbox_format == "xywh":
                center, scale = bbox_xywh2cs(bbox, padding=self.padding)
            elif bbox_format == "xyxy":
                center, scale = bbox_xyxy2cs(bbox, padding=self.padding)
            else:
                raise ValueError(
                    "Invalid bbox format: {}".format(results["bbox_format"])
                )
            results["bbox_center"] = center
            results["bbox_scale"] = scale
        return results


class TopdownAffine(nn.Module):
    def __init__(
        self,
        input_size: Union[int, Tuple[int, int]],
        use_udp: bool = False,
        aspect_ratio: float = 0.75,
        fix_square: bool = False,
    ) -> None:
        super().__init__()
        self.input_size = to_2tuple(input_size)
        self.use_udp = use_udp
        self.aspect_ratio = aspect_ratio
        self.fix_square = fix_square

    def forward(self, results: Dict) -> Optional[dict]:
        w, h = self.input_size
        warp_size = (int(w), int(h))

        results["orig_bbox_scale"] = results["bbox_scale"].copy()
        if self.fix_square and results["bbox_scale"][0] == results["bbox_scale"][1]:
            bbox_scale = fix_aspect_ratio(results["bbox_scale"], aspect_ratio=w / h)
        else:
            bbox_scale = fix_aspect_ratio(
                results["bbox_scale"], aspect_ratio=self.aspect_ratio
            )
            results["bbox_scale"] = fix_aspect_ratio(bbox_scale, aspect_ratio=w / h)
        results["bbox_expand_factor"] = (
            results["bbox_scale"].max() / results["orig_bbox_scale"].max()
        )
        rot = 0.0
        if results["bbox_center"].ndim == 2:
            assert results["bbox_center"].shape[0] == 1
            center = results["bbox_center"][0]
            scale = results["bbox_scale"][0]
            if "bbox_rotation" in results:
                rot = results["bbox_rotation"][0]
        else:
            center = results["bbox_center"]
            scale = results["bbox_scale"]
            if "bbox_rotation" in results:
                rot = results["bbox_rotation"]

        if self.use_udp:
            warp_mat = get_udp_warp_matrix(center, scale, rot, output_size=(w, h))
        else:
            warp_mat = get_warp_matrix(center, scale, rot, output_size=(w, h))

        if "img" not in results:
            pass
        elif isinstance(results["img"], list):
            results["img"] = [
                cv2.warpAffine(img, warp_mat, warp_size, flags=cv2.INTER_LINEAR)
                for img in results["img"]
            ]
            height, width = results["img"][0].shape[:2]
            results["ori_img_size"] = np.array([width, height])
        else:
            height, width = results["img"].shape[:2]
            results["ori_img_size"] = np.array([width, height])
            results["img"] = cv2.warpAffine(
                results["img"], warp_mat, warp_size, flags=cv2.INTER_LINEAR
            )

        if results.get("keypoints_2d", None) is not None:
            results["orig_keypoints_2d"] = results["keypoints_2d"].copy()
            transformed_keypoints = results["keypoints_2d"].copy()
            transformed_keypoints[:, :2] = cv2.transform(
                results["keypoints_2d"][None, :, :2], warp_mat
            )[0]
            results["keypoints_2d"] = transformed_keypoints

        if results.get("mask", None) is not None:
            results["mask"] = cv2.warpAffine(
                results["mask"], warp_mat, warp_size, flags=cv2.INTER_LINEAR
            )

        results["img_size"] = np.array([w, h])
        results["input_size"] = np.array([w, h])
        results["affine_trans"] = warp_mat
        return results


# =============================================================================
# io.py — Image loading (inference-relevant subset)
# =============================================================================

def _pil_load(path: str, image_format: str) -> Image.Image:
    with Image.open(path) as img:
        if img is not None and image_format.lower() == "rgb":
            img = img.convert("RGB")
    return img


def _cv2_load(path: str, image_format: str) -> np.ndarray:
    img = cv2.imread(path)
    if img is not None and image_format.lower() == "rgb":
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    return img


def load_image(
    path: str,
    backend: str = "pil",
    image_format: str = "rgb",
    retry: int = 10,
) -> Any:
    for i_try in range(retry):
        if backend == "pil":
            img = _pil_load(path, image_format)
        elif backend == "cv2":
            img = _cv2_load(path, image_format)
        else:
            raise ValueError("Invalid backend {} for loading image.".format(backend))
        if img is not None:
            return img
        else:
            log.warning("Reading {} failed. Will retry.".format(path))
            time.sleep(1.0)
        if i_try == retry - 1:
            raise Exception("Failed to load image {}".format(path))


# =============================================================================
# prepare_batch.py — Batch preparation for inference
# =============================================================================

class NoCollate:
    def __init__(self, data):
        self.data = data


def prepare_batch(
    img,
    transform,
    boxes,
    masks=None,
    masks_score=None,
    cam_int=None,
):
    height, width = img.shape[:2]

    data_list = []
    for idx in range(boxes.shape[0]):
        data_info = dict(img=img)
        data_info["bbox"] = boxes[idx]
        data_info["bbox_format"] = "xyxy"

        if masks is not None:
            data_info["mask"] = masks[idx].copy()
            if masks_score is not None:
                data_info["mask_score"] = masks_score[idx]
            else:
                data_info["mask_score"] = np.array(1.0, dtype=np.float32)
        else:
            data_info["mask"] = np.zeros((height, width, 1), dtype=np.uint8)
            data_info["mask_score"] = np.array(0.0, dtype=np.float32)

        data_list.append(transform(data_info))

    batch = default_collate(data_list)

    max_num_person = batch["img"].shape[0]
    for key in [
        "img",
        "img_size",
        "ori_img_size",
        "bbox_center",
        "bbox_scale",
        "bbox",
        "affine_trans",
        "mask",
        "mask_score",
    ]:
        if key in batch:
            batch[key] = batch[key].unsqueeze(0).float()
    if "mask" in batch:
        batch["mask"] = batch["mask"].unsqueeze(2)
    batch["person_valid"] = torch.ones((1, max_num_person))

    if cam_int is not None:
        batch["cam_int"] = cam_int.to(batch["img"])
    else:
        batch["cam_int"] = torch.tensor(
            [
                [
                    [(height**2 + width**2) ** 0.5, 0, width / 2.0],
                    [0, (height**2 + width**2) ** 0.5, height / 2.0],
                    [0, 0, 1],
                ]
            ],
        ).to(batch["img"])

    batch["img_ori"] = [NoCollate(img)]
    return batch
