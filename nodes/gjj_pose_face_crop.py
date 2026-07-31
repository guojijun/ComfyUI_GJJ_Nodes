from __future__ import annotations

from typing import Any

import torch
import torch.nn.functional as F


NODE_NAME = "GJJ_PoseFaceCrop"
MAX_RESOLUTION = 16384


def _as_pose_frames(pose_kps: Any) -> list[dict[str, Any]]:
    if pose_kps is None:
        return []
    if isinstance(pose_kps, dict):
        return [pose_kps]
    if isinstance(pose_kps, (list, tuple)):
        return [frame for frame in pose_kps if isinstance(frame, dict)]
    return []


def _face_points(person: Any) -> torch.Tensor | None:
    if not isinstance(person, dict):
        return None
    raw = person.get("face_keypoints_2d")
    if raw is None:
        return None
    try:
        data = torch.as_tensor(raw, dtype=torch.float32).flatten()
    except Exception:
        return None
    if data.numel() < 3:
        return None
    count = int(data.numel() // 3)
    if count <= 0:
        return None
    return data[: count * 3].reshape(count, 3)[:, :2]


def _valid_center(person: Any) -> torch.Tensor | None:
    points = _face_points(person)
    if points is None or points.numel() == 0:
        return None
    if torch.all(points == 0):
        return None
    center = points.mean(dim=0)
    if not torch.isfinite(center).all():
        return None
    return center


def _select_person(pose_frame: dict[str, Any], person_index_or_center: Any) -> tuple[int, torch.Tensor | None]:
    people = pose_frame.get("people") or []
    if not isinstance(people, list):
        return -1, None

    centers: list[torch.Tensor] = []
    valid_indices: list[int] = []
    for idx, person in enumerate(people):
        center = _valid_center(person)
        if center is None:
            continue
        centers.append(center)
        valid_indices.append(idx)

    if not centers:
        return -1, None

    if isinstance(person_index_or_center, int):
        valid_pos = person_index_or_center if 0 <= person_index_or_center < len(valid_indices) else 0
        return valid_indices[valid_pos], centers[valid_pos]

    if person_index_or_center is not None:
        previous = torch.as_tensor(person_index_or_center, dtype=torch.float32)
        distances = [torch.linalg.vector_norm(center - previous).item() for center in centers]
        valid_pos = int(min(range(len(distances)), key=distances.__getitem__))
        return valid_indices[valid_pos], centers[valid_pos]

    return valid_indices[0], centers[0]


def _polygon_area(points: torch.Tensor) -> float:
    if points.shape[0] < 3:
        return 0.0
    x = points[:, 0]
    y = points[:, 1]
    return float(torch.abs(torch.sum(x * torch.roll(y, -1) - y * torch.roll(x, -1))) * 0.5)


def _fill_polygon(mask: torch.Tensor, points: torch.Tensor) -> None:
    height, width = int(mask.shape[0]), int(mask.shape[1])
    if height <= 0 or width <= 0 or points.shape[0] < 3:
        return

    min_x = max(0, int(torch.floor(points[:, 0].min()).item()))
    max_x = min(width - 1, int(torch.ceil(points[:, 0].max()).item()))
    min_y = max(0, int(torch.floor(points[:, 1].min()).item()))
    max_y = min(height - 1, int(torch.ceil(points[:, 1].max()).item()))
    if max_x < min_x or max_y < min_y:
        return

    device = mask.device
    xs = torch.arange(min_x, max_x + 1, device=device, dtype=torch.float32) + 0.5
    ys = torch.arange(min_y, max_y + 1, device=device, dtype=torch.float32) + 0.5
    yy, xx = torch.meshgrid(ys, xs, indexing="ij")
    inside = torch.zeros_like(xx, dtype=torch.bool)

    poly = points.to(device=device, dtype=torch.float32)
    count = int(poly.shape[0])
    for idx in range(count):
        nxt = (idx + 1) % count
        xi, yi = poly[idx, 0], poly[idx, 1]
        xj, yj = poly[nxt, 0], poly[nxt, 1]
        crosses = (yi > yy) != (yj > yy)
        x_at_y = (xj - xi) * (yy - yi) / (yj - yi + 1e-6) + xi
        inside = torch.logical_xor(inside, crosses & (xx < x_at_y))

    view = mask[min_y : max_y + 1, min_x : max_x + 1]
    view[inside] = 1.0


def _draw_face_mask(
    pose_frame: dict[str, Any],
    person_index: int,
    fallback_width: int,
    fallback_height: int,
    *,
    device: torch.device,
    dtype: torch.dtype,
) -> torch.Tensor:
    width = max(1, int(pose_frame.get("canvas_width") or fallback_width or 1))
    height = max(1, int(pose_frame.get("canvas_height") or fallback_height or 1))
    mask = torch.zeros((height, width), device=device, dtype=dtype)

    people = pose_frame.get("people") or []
    if not isinstance(people, list) or person_index < 0 or person_index >= len(people):
        return mask

    points = _face_points(people[person_index])
    if points is None or points.shape[0] < 17:
        return mask
    if torch.all(points == 0):
        return mask
    if not torch.isfinite(points).all():
        return mask
    if torch.any(points < 0):
        return mask

    min_margin = 5
    near_edge = (
        torch.any(points[:, 0] < min_margin)
        or torch.any(points[:, 1] < min_margin)
        or torch.any(points[:, 0] > width - min_margin)
        or torch.any(points[:, 1] > height - min_margin)
    )
    if near_edge:
        corner_points = torch.sum((points[:, 0] < min_margin) & (points[:, 1] < min_margin)).item()
        if corner_points > 3:
            return mask

    points = torch.trunc(points)
    points[:, 0] = torch.clamp(points[:, 0], 0, width - 1)
    points[:, 1] = torch.clamp(points[:, 1], 0, height - 1)
    outer_contour = points[:17]

    min_xy = outer_contour.min(dim=0).values
    max_xy = outer_contour.max(dim=0).values
    contour_width = float(max_xy[0] - min_xy[0])
    contour_height = float(max_xy[1] - min_xy[1])
    if contour_width > 0.8 * width or contour_height > 0.8 * height:
        return mask

    unique_points = torch.unique(outer_contour.to(torch.int64), dim=0)
    if unique_points.shape[0] < 3:
        return mask

    contour_area = _polygon_area(outer_contour)
    canvas_area = float(width * height)
    if not (0.001 * canvas_area <= contour_area <= 0.5 * canvas_area):
        return mask

    _fill_polygon(mask, outer_contour)
    return mask


def _resize_masks(mask: torch.Tensor, height: int, width: int) -> torch.Tensor:
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    if mask.shape[-2:] == (height, width):
        return mask
    resized = F.interpolate(mask.unsqueeze(1).float(), size=(height, width), mode="bilinear", align_corners=False)
    return resized[:, 0].to(dtype=mask.dtype)


def _face_masks_from_pose(
    pose_kps: Any,
    person_index: int,
    batch_size: int,
    height: int,
    width: int,
    *,
    device: torch.device,
    dtype: torch.dtype,
) -> torch.Tensor:
    frames = _as_pose_frames(pose_kps)
    if not frames:
        return torch.zeros((batch_size, height, width), device=device, dtype=dtype)

    masks: list[torch.Tensor] = []
    previous_center: torch.Tensor | None = None
    for batch_index in range(batch_size):
        frame = frames[min(batch_index, len(frames) - 1)]
        selected_idx, selected_center = _select_person(frame, int(person_index) if batch_index == 0 else previous_center)
        if selected_center is not None:
            previous_center = selected_center
        masks.append(
            _draw_face_mask(
                frame,
                selected_idx,
                width,
                height,
                device=device,
                dtype=dtype,
            )
        )

    stacked = torch.stack(masks)
    return _resize_masks(stacked, height, width).clamp(0.0, 1.0)


def _round_up_16(value: int) -> int:
    return max(16, int((max(1, int(value)) + 15) // 16 * 16))


def _crop_box_from_mask(
    mask: torch.Tensor,
    padding: int,
    min_crop_resolution: int,
    max_crop_resolution: int,
) -> tuple[int, int, int, int]:
    height, width = int(mask.shape[0]), int(mask.shape[1])
    binary = mask.round().clamp(0, 1)
    points = torch.nonzero(binary == 1, as_tuple=False)

    if points.numel() == 0:
        center_x = width / 2.0
        center_y = height / 2.0
        crop_w = 0
        crop_h = 0
    else:
        y_min = int(points[:, 0].min().item())
        y_max = int(points[:, 0].max().item())
        x_min = int(points[:, 1].min().item())
        x_max = int(points[:, 1].max().item())
        crop_w = x_max - x_min + 1
        crop_h = y_max - y_min + 1
        center_x = (x_min + x_max) / 2.0
        center_y = (y_min + y_max) / 2.0

    if min_crop_resolution > 0:
        crop_w = max(crop_w, int(min_crop_resolution))
        crop_h = max(crop_h, int(min_crop_resolution))
    if max_crop_resolution > 0:
        crop_w = min(crop_w, int(max_crop_resolution))
        crop_h = min(crop_h, int(max_crop_resolution))

    crop_w = min(max(1, int(crop_w)), width)
    crop_h = min(max(1, int(crop_h)), height)
    pad_x = max(0, min((width - crop_w) // 2, int(padding)))
    pad_y = max(0, min((height - crop_h) // 2, int(padding)))
    final_w = min(width, crop_w + 2 * pad_x)
    final_h = min(height, crop_h + 2 * pad_y)
    x0 = max(0, min(int(center_x - final_w / 2), width - final_w))
    y0 = max(0, min(int(center_y - final_h / 2), height - final_h))
    return x0, y0, final_w, final_h


def _resize_image(image: torch.Tensor, target_height: int, target_width: int) -> torch.Tensor:
    resized = F.interpolate(
        image.unsqueeze(0).permute(0, 3, 1, 2).float(),
        size=(target_height, target_width),
        mode="bicubic",
        align_corners=False,
    )
    return resized.permute(0, 2, 3, 1).squeeze(0).clamp(0.0, 1.0).to(dtype=image.dtype)


def _resize_mask(mask: torch.Tensor, target_height: int, target_width: int) -> torch.Tensor:
    resized = F.interpolate(
        mask.unsqueeze(0).unsqueeze(0).float(),
        size=(target_height, target_width),
        mode="bilinear",
        align_corners=False,
    )
    return resized[0, 0].clamp(0.0, 1.0).to(dtype=mask.dtype)


def _crop_resize_by_mask(
    image: torch.Tensor,
    mask: torch.Tensor,
    base_resolution: int,
    padding: int,
    min_crop_resolution: int,
    max_crop_resolution: int,
) -> tuple[torch.Tensor, torch.Tensor, list[tuple[int, int, int, int]]]:
    if image.ndim != 4:
        raise RuntimeError("图像输入必须是 ComfyUI IMAGE 批次格式。")
    batch_size, image_height, image_width, _ = image.shape
    if batch_size <= 0:
        raise RuntimeError("图像批次为空，无法裁剪。")

    mask = _resize_masks(mask, int(image_height), int(image_width))
    if int(mask.shape[0]) < batch_size:
        if int(mask.shape[0]) == 1:
            mask = mask.repeat(batch_size, 1, 1)
        else:
            pad_count = batch_size - int(mask.shape[0])
            mask = torch.cat([mask, mask[-1:].repeat(pad_count, 1, 1)], dim=0)
    elif int(mask.shape[0]) > batch_size:
        mask = mask[:batch_size]

    boxes: list[tuple[int, int, int, int]] = []
    aspect_ratios: list[float] = []
    for idx in range(batch_size):
        box = _crop_box_from_mask(mask[idx], int(padding), int(min_crop_resolution), int(max_crop_resolution))
        boxes.append(box)
        _, _, crop_w, crop_h = box
        aspect_ratios.append(max(1.0, float(crop_w)) / max(1.0, float(crop_h)))

    crop_w_uniform = min(int(image_width), _round_up_16(max(box[2] for box in boxes)))
    crop_h_uniform = min(int(image_height), _round_up_16(max(box[3] for box in boxes)))
    max_aspect_ratio = max(aspect_ratios) if aspect_ratios else 1.0

    base = max(16, int(base_resolution))
    if max_aspect_ratio > 1.0:
        target_width = base
        target_height = int(base / max_aspect_ratio)
    else:
        target_height = base
        target_width = int(base * max_aspect_ratio)
    target_width = _round_up_16(target_width)
    target_height = _round_up_16(target_height)

    image_list: list[torch.Tensor] = []
    mask_list: list[torch.Tensor] = []
    bbox_list: list[tuple[int, int, int, int]] = []

    for idx, (orig_x0, orig_y0, orig_w, orig_h) in enumerate(boxes):
        center_x = orig_x0 + orig_w / 2.0
        center_y = orig_y0 + orig_h / 2.0
        x0 = max(0, min(int(center_x - crop_w_uniform / 2), int(image_width) - crop_w_uniform))
        y0 = max(0, min(int(center_y - crop_h_uniform / 2), int(image_height) - crop_h_uniform))
        x1 = x0 + crop_w_uniform
        y1 = y0 + crop_h_uniform

        cropped_image = image[idx, y0:y1, x0:x1, :]
        cropped_mask = mask[idx, y0:y1, x0:x1]
        image_list.append(_resize_image(cropped_image, target_height, target_width))
        mask_list.append(_resize_mask(cropped_mask, target_height, target_width))
        bbox_list.append((x0, y0, x1, y1))

    return torch.stack(image_list), torch.stack(mask_list), bbox_list


class GJJ_PoseFaceCrop:
    CATEGORY = "GJJ/🖼️ 图像"
    FUNCTION = "crop_face"
    DESCRIPTION = "根据 POSE_KEYPOINT 的人脸关键点生成脸部遮罩，并按遮罩批量裁剪缩放图片。"
    SEARCH_ALIASES = [
        "FaceMaskFromPoseKeypoints",
        "ImageCropByMaskAndResize",
        "face mask from pose keypoints",
        "image crop by mask and resize",
        "姿态人脸遮罩",
        "人脸遮罩裁剪",
        "关键点裁剪人脸",
    ]

    RETURN_TYPES = ("IMAGE", "MASK", "BBOX", "MASK")
    RETURN_NAMES = ("裁剪图像", "裁剪遮罩", "裁剪框", "人脸遮罩")
    OUTPUT_TOOLTIPS = (
        "按人脸遮罩裁剪并缩放后的 IMAGE 批次。",
        "与裁剪图像尺寸一致的脸部遮罩。",
        "每帧在原图上的裁剪框，格式为 x0、y0、x1、y1。",
        "由姿态人脸关键点直接生成、已对齐原图尺寸的原始遮罩。",
    )

    GJJ_HELP = {
        "title": "姿态人脸遮罩裁剪",
        "description": "把 FaceMaskFromPoseKeypoints 和 ImageCropByMaskAndResize 合成一个零依赖 GJJ 节点：先从 POSE_KEYPOINT 的脸部外轮廓生成遮罩，再按遮罩统一裁剪并缩放图片批次。",
        "usage": [
            "把原图或视频帧接到“图像”，把 DWPose/OpenPose 输出的 POSE_KEYPOINT 接到“姿态关键点”。",
            "“人物序号”按检测到的有效人脸排序，从 0 开始；后续帧会自动跟踪上一帧最近的人脸中心。",
            "“基础分辨率”控制输出长边基准，最终宽高会向上取 16 的倍数，方便视频模型和采样节点继续使用。",
            "搜索 FaceMaskFromPoseKeypoints 或 ImageCropByMaskAndResize 也能找到这个合并节点。",
        ],
        "outputs": [
            "裁剪图像：已经裁剪并缩放后的图片批次。",
            "裁剪遮罩：与裁剪图像同尺寸的脸部遮罩。",
            "裁剪框：每帧原图上的 x0、y0、x1、y1。",
            "人脸遮罩：未裁剪前、对齐原图尺寸的脸部遮罩，便于调试或接其它遮罩节点。",
        ],
        "dependency": "不依赖 WanVideoWrapper、KJNodes、cv2、einops 或其它第三方自定义节点包。",
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "图像",
                        "tooltip": "需要裁剪的人像图片或视频帧批次。",
                    },
                ),
                "pose_kps": (
                    "POSE_KEYPOINT",
                    {
                        "display_name": "姿态关键点",
                        "tooltip": "OpenPose/DWPose 风格关键点数据，需要包含 face_keypoints_2d。",
                    },
                ),
                "person_index": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "display_name": "人物序号",
                        "tooltip": "第一帧选择第几个有效人脸，后续帧自动跟踪最近的人脸。",
                    },
                ),
                "base_resolution": (
                    "INT",
                    {
                        "default": 512,
                        "min": 16,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "基础分辨率",
                        "tooltip": "输出尺寸的基准分辨率；最终宽高会按裁剪比例并取 16 的倍数。",
                    },
                ),
                "padding": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": MAX_RESOLUTION,
                        "step": 1,
                        "display_name": "扩边像素",
                        "tooltip": "在人脸遮罩外额外保留的像素，节点会自动限制到图像边界内。",
                    },
                ),
                "min_crop_resolution": (
                    "INT",
                    {
                        "default": 128,
                        "min": 0,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "最小裁剪尺寸",
                        "tooltip": "裁剪框的最小宽高，避免脸部区域过小；0 表示不强制最小值。",
                    },
                ),
                "max_crop_resolution": (
                    "INT",
                    {
                        "default": 512,
                        "min": 0,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "最大裁剪尺寸",
                        "tooltip": "裁剪框的最大宽高，避免裁剪范围过大；0 表示不限制最大值。",
                    },
                ),
            },
        }

    def crop_face(
        self,
        image: torch.Tensor,
        pose_kps: Any,
        person_index: int,
        base_resolution: int,
        padding: int,
        min_crop_resolution: int,
        max_crop_resolution: int,
    ):
        if not isinstance(image, torch.Tensor) or image.ndim != 4:
            raise RuntimeError("图像输入必须是 ComfyUI IMAGE 批次格式。")
        batch_size, height, width, _ = image.shape
        face_mask = _face_masks_from_pose(
            pose_kps,
            int(person_index),
            int(batch_size),
            int(height),
            int(width),
            device=image.device,
            dtype=image.dtype,
        )
        cropped_image, cropped_mask, bbox = _crop_resize_by_mask(
            image,
            face_mask,
            int(base_resolution),
            int(padding),
            int(min_crop_resolution),
            int(max_crop_resolution),
        )
        return (cropped_image, cropped_mask, bbox, face_mask)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_PoseFaceCrop}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🙂 姿态人脸裁剪"}
