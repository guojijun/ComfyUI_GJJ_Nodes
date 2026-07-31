from __future__ import annotations

import colorsys
import copy
import math
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageDraw

from .common_utils.temp_files import gjjutils_write_temp_tensor_images

NODE_NAME = "GJJ_WanFunCameraControl"
NODE_DISPLAY_NAME = "GJJ · 🎥 Wan相机控制合成"

WAN_LATENT_CHANNELS = 16
WAN_VAE_STRIDE = (4, 8, 8)
DEFAULT_FX = 0.474812461
DEFAULT_FY = 0.844111024
DEFAULT_CX = 0.5
DEFAULT_CY = 0.5
DEFAULT_POSE_WIDTH = 1280
DEFAULT_POSE_HEIGHT = 720
BASE_T_NORM = 1.5
BASE_ANGLE = math.pi / 3


class _CameraMotion:
    def __init__(self, rotate: tuple[float, float, float], translate: tuple[float, float, float]):
        self.rotate = np.array(rotate, dtype=np.float32)
        self.translate = np.array(translate, dtype=np.float32)

    def multiply(self, value: float) -> "_CameraMotion":
        if math.isclose(float(value), 1.0):
            return _CameraMotion(tuple(self.rotate), tuple(self.translate))
        return _CameraMotion(tuple(self.rotate * float(value)), tuple(self.translate * float(value)))

    @staticmethod
    def combine(items: list["_CameraMotion"]) -> "_CameraMotion":
        rotate = np.array([0.0, 0.0, 0.0], dtype=np.float32)
        translate = np.array([0.0, 0.0, 0.0], dtype=np.float32)
        for item in items:
            rotate += item.rotate
            translate += item.translate
        return _CameraMotion(tuple(rotate), tuple(translate))


MOTION_CHOICES = [
    "静止",
    "向上平移",
    "向下平移",
    "向左平移",
    "向右平移",
    "推近",
    "拉远",
    "顺时针滚转",
    "逆时针滚转",
    "向上俯仰",
    "向下俯仰",
    "向左偏航",
    "向右偏航",
]

MOTION_MAP = {
    "静止": _CameraMotion((0.0, 0.0, 0.0), (0.0, 0.0, 0.0)),
    "向上平移": _CameraMotion((0.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
    "向下平移": _CameraMotion((0.0, 0.0, 0.0), (0.0, -1.0, 0.0)),
    "向左平移": _CameraMotion((0.0, 0.0, 0.0), (1.0, 0.0, 0.0)),
    "向右平移": _CameraMotion((0.0, 0.0, 0.0), (-1.0, 0.0, 0.0)),
    "推近": _CameraMotion((0.0, 0.0, 0.0), (0.0, 0.0, -2.0)),
    "拉远": _CameraMotion((0.0, 0.0, 0.0), (0.0, 0.0, 2.0)),
    "顺时针滚转": _CameraMotion((0.0, 0.0, -1.0), (0.0, 0.0, 0.0)),
    "逆时针滚转": _CameraMotion((0.0, 0.0, 1.0), (0.0, 0.0, 0.0)),
    "向上俯仰": _CameraMotion((-1.0, 0.0, 0.0), (0.0, 0.0, 0.0)),
    "向下俯仰": _CameraMotion((1.0, 0.0, 0.0), (0.0, 0.0, 0.0)),
    "向左偏航": _CameraMotion((0.0, 1.0, 0.0), (0.0, 0.0, 0.0)),
    "向右偏航": _CameraMotion((0.0, -1.0, 0.0), (0.0, 0.0, 0.0)),
}

LEGACY_MOTION_ALIASES = {
    "Static": "静止",
    "Pan Up": "向上平移",
    "Pan Down": "向下平移",
    "Pan Left": "向左平移",
    "Pan Right": "向右平移",
    "Zoom In": "推近",
    "Zoom Out": "拉远",
    "Roll Clockwise": "顺时针滚转",
    "Roll Anticlockwise": "逆时针滚转",
    "Tilt Up": "向上俯仰",
    "Tilt Down": "向下俯仰",
    "Tilt Left": "向左偏航",
    "Tilt Right": "向右偏航",
}


def _motion(value: str) -> _CameraMotion:
    key = LEGACY_MOTION_ALIASES.get(str(value), str(value))
    return MOTION_MAP.get(key, MOTION_MAP["静止"])


def _rotation_from_rad(angles: np.ndarray) -> np.ndarray:
    theta_x, theta_y, theta_z = [float(item) for item in angles]
    rx = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, math.cos(theta_x), -math.sin(theta_x)],
            [0.0, math.sin(theta_x), math.cos(theta_x)],
        ],
        dtype=np.float32,
    )
    ry = np.array(
        [
            [math.cos(theta_y), 0.0, math.sin(theta_y)],
            [0.0, 1.0, 0.0],
            [-math.sin(theta_y), 0.0, math.cos(theta_y)],
        ],
        dtype=np.float32,
    )
    rz = np.array(
        [
            [math.cos(theta_z), -math.sin(theta_z), 0.0],
            [math.sin(theta_z), math.cos(theta_z), 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float32,
    )
    return rz @ (ry @ rx)


def _camera_motion_to_rt(angle: np.ndarray, translate: np.ndarray, speed: float, frame_count: int, base: int = 16) -> np.ndarray:
    result = []
    for index in range(int(frame_count)):
        factor = (index / float(base)) * float(speed)
        rotation = _rotation_from_rad(factor * BASE_ANGLE * angle)
        offset = (factor * BASE_T_NORM * translate.reshape(3, 1)).astype(np.float32)
        result.append(np.concatenate([rotation, offset], axis=1))
    return np.stack(result).astype(np.float32)


def _poses_to_ndarray(poses: list[list[float]]) -> np.ndarray:
    return np.array([np.array(pose[7:], dtype=np.float32).reshape(3, 4) for pose in poses], dtype=np.float32)


def _ndarray_to_poses(rt: np.ndarray, fx: float = DEFAULT_FX, fy: float = DEFAULT_FY, cx: float = DEFAULT_CX, cy: float = DEFAULT_CY) -> list[list[float]]:
    poses = []
    for motion in rt.tolist():
        pose = [0.0, float(fx), float(fy), float(cx), float(cy), float(DEFAULT_POSE_WIDTH), float(DEFAULT_POSE_HEIGHT)]
        pose.extend(float(item) for row in motion for item in row)
        poses.append(pose)
    return poses


def _combine_rts(rt_0: np.ndarray, rt_1: np.ndarray) -> np.ndarray:
    anchor = copy.deepcopy(rt_0[-1])
    rotation = anchor[:, :3]
    rotation_inv = rotation.T
    translate = anchor[:, -1]
    combined = []
    for item in copy.deepcopy(rt_1):
        item[:, :3] = item[:, :3] @ rotation
        item[:, -1] = item[:, -1] + ((item[:, :3] @ rotation_inv) @ translate)
        combined.append(item)
    return np.concatenate([rt_0, np.stack(combined)], axis=0)


def _combine_poses(prev_poses: list[list[float]], poses: list[list[float]]) -> list[list[float]]:
    new_poses = copy.deepcopy(prev_poses) + copy.deepcopy(poses)
    merged_rt = _combine_rts(_poses_to_ndarray(prev_poses), _poses_to_ndarray(poses))
    merged_poses = _ndarray_to_poses(merged_rt)
    for index, pose in enumerate(new_poses):
        pose[7:] = merged_poses[index][7:]
    return new_poses


def _safe_frame_count(value: int) -> tuple[int, bool]:
    frame_count = max(1, int(value))
    remainder = (frame_count - 1) % 4
    if remainder == 0:
        return frame_count, False
    return frame_count + (4 - remainder), True


def _build_camera_poses(
    motion_type1: str,
    motion_type2: str,
    motion_type3: str,
    motion_type4: str,
    motion_type5: str,
    motion_type6: str,
    speed: float,
    frame_count: int,
    prev_poses: list[list[float]] | None = None,
) -> list[list[float]]:
    combined = _CameraMotion.combine(
        [
            _motion(motion_type1),
            _motion(motion_type2),
            _motion(motion_type3),
            _motion(motion_type4),
            _motion(motion_type5),
            _motion(motion_type6),
        ]
    )
    rt = _camera_motion_to_rt(combined.rotate, combined.translate, speed, frame_count)
    poses = _ndarray_to_poses(rt)
    if prev_poses:
        poses = _combine_poses(prev_poses, poses)
    return poses


class _Camera:
    def __init__(self, entry: list[float]):
        self.fx, self.fy, self.cx, self.cy = [float(item) for item in entry[1:5]]
        w2c = np.array(entry[7:], dtype=np.float32).reshape(3, 4)
        w2c_4x4 = np.eye(4, dtype=np.float32)
        w2c_4x4[:3, :] = w2c
        self.w2c_mat = w2c_4x4
        self.c2w_mat = np.linalg.inv(w2c_4x4).astype(np.float32)


def _relative_pose(cameras: list[_Camera]) -> np.ndarray:
    w2cs = [camera.w2c_mat for camera in cameras]
    c2ws = [camera.c2w_mat for camera in cameras]
    target = np.array(
        [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float32,
    )
    abs_to_rel = target @ w2cs[0]
    return np.array([target] + [abs_to_rel @ c2w for c2w in c2ws[1:]], dtype=np.float32)


def _meshgrid(y: torch.Tensor, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    try:
        return torch.meshgrid(y, x, indexing="ij")
    except TypeError:
        return torch.meshgrid(y, x)


def _ray_condition(k: torch.Tensor, c2w: torch.Tensor, height: int, width: int, device: str) -> torch.Tensor:
    batch = int(k.shape[0])
    y_grid, x_grid = _meshgrid(
        torch.linspace(0, height - 1, height, device=device, dtype=c2w.dtype),
        torch.linspace(0, width - 1, width, device=device, dtype=c2w.dtype),
    )
    x_grid = x_grid.reshape(1, 1, height * width).expand(batch, 1, height * width) + 0.5
    y_grid = y_grid.reshape(1, 1, height * width).expand(batch, 1, height * width) + 0.5

    fx, fy, cx, cy = k.chunk(4, dim=-1)
    zs = torch.ones_like(x_grid)
    xs = (x_grid - cx) / fx * zs
    ys = (y_grid - cy) / fy * zs
    zs = zs.expand_as(ys)
    directions = torch.stack((xs, ys, zs), dim=-1)
    directions = directions / directions.norm(dim=-1, keepdim=True).clamp_min(1e-8)
    rays_d = directions @ c2w[..., :3, :3].transpose(-1, -2)
    rays_o = c2w[..., :3, 3][:, :, None].expand_as(rays_d)
    rays_dxo = torch.cross(rays_o, rays_d, dim=-1)
    return torch.cat([rays_dxo, rays_d], dim=-1).reshape(batch, c2w.shape[1], height, width, 6)


def _poses_to_plucker(poses: list[list[float]], width: int, height: int, device: str = "cpu") -> torch.Tensor:
    cameras = [_Camera([float(item) for item in pose]) for pose in poses]
    sample_ratio = float(width) / max(1.0, float(height))
    pose_ratio = float(DEFAULT_POSE_WIDTH) / float(DEFAULT_POSE_HEIGHT)

    if pose_ratio > sample_ratio:
        resized_width = float(height) * pose_ratio
        for camera in cameras:
            camera.fx = resized_width * camera.fx / float(width)
    else:
        resized_height = float(width) / pose_ratio
        for camera in cameras:
            camera.fy = resized_height * camera.fy / float(height)

    intrinsic = np.asarray(
        [[camera.fx * width, camera.fy * height, camera.cx * width, camera.cy * height] for camera in cameras],
        dtype=np.float32,
    )
    k = torch.as_tensor(intrinsic, dtype=torch.float32, device=device)[None]
    c2ws = torch.as_tensor(_relative_pose(cameras), dtype=torch.float32, device=device)[None]
    return _ray_condition(k, c2ws, int(height), int(width), device=device)[0].contiguous()


def _fun_camera_embeds(
    poses: list[list[float]],
    width: int,
    height: int,
    strength: float,
    start_percent: float,
    end_percent: float,
) -> dict[str, Any]:
    num_frames = len(poses)
    plucker = _poses_to_plucker(poses, width, height)
    camera_video = plucker.permute(3, 0, 1, 2).unsqueeze(0)
    camera_latents = torch.cat(
        [
            torch.repeat_interleave(camera_video[:, :, 0:1], repeats=4, dim=2),
            camera_video[:, :, 1:],
        ],
        dim=2,
    ).transpose(1, 2)

    batch, frames, channels, latent_h, latent_w = camera_latents.shape
    if frames % 4 != 0:
        raise RuntimeError(
            f"Wan FunCamera 条件要求帧数满足 4n+1；当前补帧后为 {frames}，无法按 4 帧分组。"
        )
    camera_latents = camera_latents.contiguous().view(batch, frames // 4, 4, channels, latent_h, latent_w).transpose(2, 3)
    camera_latents = camera_latents.contiguous().view(batch, frames // 4, channels * 4, latent_h, latent_w).transpose(1, 2).contiguous()

    target_shape = (
        WAN_LATENT_CHANNELS,
        (num_frames - 1) // WAN_VAE_STRIDE[0] + 1,
        int(height) // WAN_VAE_STRIDE[1],
        int(width) // WAN_VAE_STRIDE[2],
    )
    return {
        "target_shape": target_shape,
        "num_frames": num_frames,
        "control_embeds": {
            "control_camera_latents": camera_latents * float(strength),
            "control_camera_start_percent": float(start_percent),
            "control_camera_end_percent": float(end_percent),
            "fun_ref_image": None,
        },
    }


def _w2c_to_preview_c2w(poses: list[list[float]], relative_c2w: bool) -> tuple[np.ndarray, list[float]]:
    last_row = np.zeros((1, 4), dtype=np.float32)
    last_row[0, -1] = 1.0
    w2cs = [np.concatenate((np.asarray(pose[7:], dtype=np.float32).reshape(3, 4), last_row), axis=0) for pose in poses]
    transform = np.asarray(
        [[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]],
        dtype=np.float32,
    )
    if relative_c2w:
        target = np.eye(4, dtype=np.float32)
        abs_to_rel = target @ w2cs[0]
        c2ws = [target] + [abs_to_rel @ np.linalg.inv(w2c) for w2c in w2cs[1:]]
    else:
        c2ws = [np.linalg.inv(w2c) for w2c in w2cs]
    return np.asarray([transform @ item for item in c2ws], dtype=np.float32), [float(pose[1]) for pose in poses]


def _rainbow(value: float) -> tuple[int, int, int]:
    red, green, blue = colorsys.hsv_to_rgb((0.78 - 0.78 * max(0.0, min(1.0, value))) % 1.0, 0.85, 1.0)
    return int(red * 255), int(green * 255), int(blue * 255)


def _project_points(points: np.ndarray, width: int, height: int, scale: float) -> list[tuple[int, int]]:
    theta = math.radians(42.0)
    phi = math.radians(28.0)
    projected = []
    for point in points:
        x, y, z = [float(item) for item in point[:3]]
        u = x * math.cos(theta) - y * math.sin(theta)
        v = x * math.sin(theta) * math.sin(phi) + y * math.cos(theta) * math.sin(phi) - z * math.cos(phi)
        projected.append((u, v))
    xs = [item[0] for item in projected]
    ys = [item[1] for item in projected]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span = max(max_x - min_x, max_y - min_y, float(scale) * 4.0, 1e-6)
    margin = 44
    factor = min((width - margin * 2) / span, (height - margin * 2) / span)
    center_x = (min_x + max_x) * 0.5
    center_y = (min_y + max_y) * 0.5
    return [
        (
            int(round(width * 0.5 + (x - center_x) * factor)),
            int(round(height * 0.52 + (y - center_y) * factor)),
        )
        for x, y in projected
    ]


def _pyramid_vertices(c2w: np.ndarray, base_xval: float, zval: float) -> np.ndarray:
    vertex_std = np.array(
        [
            [0, 0, 0, 1],
            [base_xval, -base_xval, zval, 1],
            [base_xval, base_xval, zval, 1],
            [-base_xval, base_xval, zval, 1],
            [-base_xval, -base_xval, zval, 1],
        ],
        dtype=np.float32,
    )
    return (vertex_std @ c2w.T)[:, :3]


def _draw_line(draw: ImageDraw.ImageDraw, points: list[tuple[int, int]], color: tuple[int, int, int], width: int = 1) -> None:
    if len(points) >= 2:
        draw.line(points, fill=color, width=width, joint="curve")


def _camera_preview_image(
    poses: list[list[float]],
    base_xval: float,
    zval: float,
    scale: float,
    use_exact_fx: bool,
    relative_c2w: bool,
) -> torch.Tensor:
    canvas_w, canvas_h = 720, 540
    scale = max(0.01, float(scale))
    base_xval = max(0.001, float(base_xval))
    zval = max(0.001, float(zval))
    c2ws, fxs = _w2c_to_preview_c2w(poses, relative_c2w)

    pyramids = [
        _pyramid_vertices(c2w, base_xval, max(0.02, float(fxs[index]) if use_exact_fx else zval))
        for index, c2w in enumerate(c2ws)
    ]
    cube = np.array(
        [
            [-2 * scale, -2 * scale, -2 * scale],
            [2 * scale, -2 * scale, -2 * scale],
            [2 * scale, 2 * scale, -2 * scale],
            [-2 * scale, 2 * scale, -2 * scale],
            [-2 * scale, -2 * scale, 2 * scale],
            [2 * scale, -2 * scale, 2 * scale],
            [2 * scale, 2 * scale, 2 * scale],
            [-2 * scale, 2 * scale, 2 * scale],
        ],
        dtype=np.float32,
    )
    axis_points = np.array([[0, 0, 0], [scale, 0, 0], [0, scale, 0], [0, 0, scale]], dtype=np.float32)
    points3d = np.concatenate([cube, axis_points] + pyramids, axis=0)
    points2d = _project_points(points3d, canvas_w, canvas_h, scale)
    cube2d = points2d[:8]
    axis2d = points2d[8:12]
    offset = 12

    image = Image.new("RGB", (canvas_w, canvas_h), (53, 53, 53))
    draw = ImageDraw.Draw(image, "RGBA")

    for a, b in [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5), (5, 6), (6, 7), (7, 4), (0, 4), (1, 5), (2, 6), (3, 7)]:
        draw.line([cube2d[a], cube2d[b]], fill=(150, 150, 150, 90), width=1)

    draw.line([axis2d[0], axis2d[1]], fill=(235, 85, 85, 190), width=2)
    draw.line([axis2d[0], axis2d[2]], fill=(95, 210, 120, 190), width=2)
    draw.line([axis2d[0], axis2d[3]], fill=(100, 150, 240, 190), width=2)
    draw.text((axis2d[1][0] + 4, axis2d[1][1]), "x", fill=(225, 120, 120, 220))
    draw.text((axis2d[2][0] + 4, axis2d[2][1]), "y", fill=(130, 230, 150, 220))
    draw.text((axis2d[3][0] + 4, axis2d[3][1]), "z", fill=(150, 180, 250, 220))

    camera_centers: list[tuple[int, int]] = []
    total = max(1, len(pyramids) - 1)
    for index, vertices in enumerate(pyramids):
        item2d = points2d[offset : offset + 5]
        offset += 5
        color = _rainbow(index / total)
        fill = (*color, 42)
        line = (*color, 210)
        for poly in ([0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1], [1, 2, 3, 4]):
            draw.polygon([item2d[i] for i in poly], fill=fill)
        for a, b in [(0, 1), (0, 2), (0, 3), (0, 4), (1, 2), (2, 3), (3, 4), (4, 1)]:
            draw.line([item2d[a], item2d[b]], fill=line, width=1)
        camera_centers.append(item2d[0])

    if len(camera_centers) >= 2:
        for index in range(len(camera_centers) - 1):
            color = _rainbow(index / total)
            draw.line([camera_centers[index], camera_centers[index + 1]], fill=(*color, 230), width=3)
    for index in [0, len(camera_centers) - 1]:
        if 0 <= index < len(camera_centers):
            x, y = camera_centers[index]
            color = _rainbow(index / total)
            draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=(*color, 255))

    bar_x0, bar_y0 = canvas_w - 34, 58
    bar_h = canvas_h - 126
    for y in range(bar_h):
        color = _rainbow(1.0 - y / max(1, bar_h - 1))
        draw.line([(bar_x0, bar_y0 + y), (bar_x0 + 9, bar_y0 + y)], fill=(*color, 255))
    draw.rectangle((bar_x0, bar_y0, bar_x0 + 9, bar_y0 + bar_h), outline=(190, 190, 190, 150), width=1)
    draw.text((bar_x0 - 4, bar_y0 - 18), "end", fill=(205, 205, 205, 210))
    draw.text((bar_x0 - 8, bar_y0 + bar_h + 5), "start", fill=(205, 205, 205, 210))
    draw.text((18, 14), f"CameraCtrl / Wan FunCamera  |  {len(poses)} frames", fill=(220, 230, 228, 230))

    array = np.asarray(image, dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0).contiguous()


def _save_preview_entries(image: torch.Tensor) -> list[dict[str, Any]]:
    try:
        return gjjutils_write_temp_tensor_images(image.detach().cpu())
    except Exception:
        return []


def _clamp_float(value: Any, default: float, low: float, high: float) -> float:
    try:
        result = float(value)
    except Exception:
        result = default
    return max(low, min(high, result))


def _summary_text(
    poses: list[list[float]],
    width: int,
    height: int,
    strength: float,
    start_percent: float,
    end_percent: float,
    aligned: bool,
    requested_frames: int,
    motions: list[str],
) -> str:
    motion_text = " + ".join(item for item in motions if LEGACY_MOTION_ALIASES.get(item, item) != "静止") or "静止"
    lines = [
        f"已生成 Wan FunCamera 相机条件：{len(poses)} 帧，{width}x{height}",
        f"动作：{motion_text}",
        f"控制强度：{strength:.2f}，生效区间：{start_percent:.2f} - {end_percent:.2f}",
    ]
    if aligned:
        lines.append(f"帧数已从 {requested_frames} 自动对齐到 {len(poses)}，以满足 Wan 4n+1 规则。")
    return "\n".join(lines)


class GJJ_WanFunCameraControl:
    CATEGORY = "GJJ/🎬 视频/生成"
    FUNCTION = "process"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "将 ADE_CameraPoseCombo、WanVideoFunCameraEmbeds、CameraPoseVisualizer 合并为一个 GJJ 零依赖单节点："
        "生成 CameraCtrl 姿态、Wan FunCamera 条件，并在节点面板预览相机轨迹。"
    )
    SEARCH_ALIASES = [
        "ADE_CameraPoseCombo",
        "Create CameraCtrl Poses Combo",
        "Create CameraCtrl Poses (Combo)",
        "CameraCtrl Poses",
        "WanVideoFunCameraEmbeds",
        "WanVideo FunCamera Embeds",
        "FunCamera",
        "CameraPoseVisualizer",
        "Camera Pose Visualizer",
        "相机控制",
        "相机姿态",
        "相机轨迹",
        "Wan相机",
        "Fun相机",
    ]
    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS", "CAMERACTRL_POSES", "IMAGE")
    RETURN_NAMES = ("Wan相机条件", "CameraCtrl姿态", "轨迹预览图")
    OUTPUT_TOOLTIPS = (
        "可直接连接 GJJ/WanVideo 采样器 image_embeds 输入的 FunCamera 相机控制条件。",
        "生成后的 CameraCtrl 姿态列表，兼容需要 CAMERACTRL_POSES 的旧节点或调试节点。",
        "零依赖绘制的相机轨迹预览图；执行后也会显示在节点面板底部。",
    )
    GJJ_HELP = {
        "title": "Wan 相机控制合成",
        "description": "一个节点替代 ADE_CameraPoseCombo、WanVideoFunCameraEmbeds、CameraPoseVisualizer。",
        "usage": [
            "选择最多 6 个相机动作，节点会将它们合成为同一段 CameraCtrl 姿态。",
            "Wan相机条件输出连接到 GJJ WanVideo Sampler 的图像条件/image_embeds 输入。",
            "轨迹预览图会在执行完成后自动出现在节点面板底部，也可从第三个输出继续连接预览或保存。",
            "如果连接了上游 CameraCtrl姿态，会先接续上游轨迹，再追加当前动作段。",
        ],
        "notes": [
            "不依赖 AnimateDiff-Evolved、WanVideoWrapper、KJNodes，也不需要 matplotlib/einops。",
            "默认帧数为 81；若输入帧数不满足 Wan 的 4n+1 规则，会自动向上对齐。",
            "预览只用于观察相机路径，不参与采样；采样真正使用的是 Wan相机条件输出。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        motion_tooltip = "选择一个相机动作；6 个动作会相加为同一段轨迹，静止表示该槽不参与。"
        return {
            "required": {
                "motion_type1": (MOTION_CHOICES, {"default": "拉远", "display_name": "动作1", "tooltip": motion_tooltip}),
                "motion_type2": (MOTION_CHOICES, {"default": "向左偏航", "display_name": "动作2", "tooltip": motion_tooltip}),
                "motion_type3": (MOTION_CHOICES, {"default": "静止", "display_name": "动作3", "tooltip": motion_tooltip}),
                "motion_type4": (MOTION_CHOICES, {"default": "静止", "display_name": "动作4", "tooltip": motion_tooltip}),
                "motion_type5": (MOTION_CHOICES, {"default": "静止", "display_name": "动作5", "tooltip": motion_tooltip}),
                "motion_type6": (MOTION_CHOICES, {"default": "静止", "display_name": "动作6", "tooltip": motion_tooltip}),
                "speed": (
                    "FLOAT",
                    {
                        "default": 0.2,
                        "min": -100.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "运动速度",
                        "tooltip": "控制相机运动幅度。数值越大运动越明显；负值会反向运动。",
                    },
                ),
                "frame_length": (
                    "INT",
                    {
                        "default": 81,
                        "min": 1,
                        "max": 4097,
                        "step": 4,
                        "display_name": "帧数",
                        "tooltip": "目标姿态帧数。Wan FunCamera 推荐 4n+1，例如 81、121；不满足时会自动向上对齐。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 832,
                        "min": 64,
                        "max": 4096,
                        "step": 8,
                        "display_name": "视频宽度",
                        "tooltip": "目标视频宽度，需与后续 WanVideo 采样/解码分辨率一致。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 480,
                        "min": 64,
                        "max": 4096,
                        "step": 8,
                        "display_name": "视频高度",
                        "tooltip": "目标视频高度，需与后续 WanVideo 采样/解码分辨率一致。",
                    },
                ),
                "strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 2.0,
                        "step": 0.01,
                        "display_name": "相机强度",
                        "tooltip": "写入 Wan FunCamera 条件的整体强度。1.0 为原始强度，0 会等于关闭控制。",
                    },
                ),
                "start_percent": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "开始百分比",
                        "tooltip": "采样进度到达该比例后开始应用相机控制。",
                    },
                ),
                "end_percent": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "结束百分比",
                        "tooltip": "采样进度到达该比例后停止应用相机控制。",
                    },
                ),
                "preview_base_xval": (
                    "FLOAT",
                    {
                        "default": 0.2,
                        "min": 0.001,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "预览相机宽度",
                        "tooltip": "预览图中相机锥体的横向大小，只影响显示，不影响采样。",
                    },
                ),
                "preview_zval": (
                    "FLOAT",
                    {
                        "default": 0.3,
                        "min": 0.001,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "预览相机深度",
                        "tooltip": "预览图中相机锥体的深度，只影响显示，不影响采样。",
                    },
                ),
                "preview_scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.01,
                        "max": 10.0,
                        "step": 0.01,
                        "display_name": "预览坐标范围",
                        "tooltip": "预览图的坐标盒范围。轨迹超出画面时可增大该值。",
                    },
                ),
                "use_exact_fx": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "预览使用真实焦距",
                        "tooltip": "开启后相机锥体深度使用姿态里的 fx；关闭时使用“预览相机深度”。仅影响预览图。",
                    },
                ),
                "relative_c2w": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "相对首帧预览",
                        "tooltip": "开启后以首帧为原点显示相对轨迹；关闭后按绝对相机位姿显示。",
                    },
                ),
            },
            "optional": {
                "prev_poses": (
                    "CAMERACTRL_POSES",
                    {
                        "display_name": "上游姿态",
                        "tooltip": "可选。连接后会接续已有 CameraCtrl 姿态，再追加当前动作段。",
                    },
                ),
            },
        }

    def process(
        self,
        motion_type1: str,
        motion_type2: str,
        motion_type3: str,
        motion_type4: str,
        motion_type5: str,
        motion_type6: str,
        speed: float,
        frame_length: int,
        width: int,
        height: int,
        strength: float,
        start_percent: float,
        end_percent: float,
        preview_base_xval: float,
        preview_zval: float,
        preview_scale: float,
        use_exact_fx: bool,
        relative_c2w: bool,
        prev_poses: list[list[float]] | None = None,
    ):
        width = max(64, int(width))
        height = max(64, int(height))
        requested_frames = max(1, int(frame_length))
        safe_frames, aligned = _safe_frame_count(requested_frames)
        start_percent = _clamp_float(start_percent, 0.0, 0.0, 1.0)
        end_percent = _clamp_float(end_percent, 1.0, 0.0, 1.0)
        if end_percent < start_percent:
            start_percent, end_percent = end_percent, start_percent
        strength = _clamp_float(strength, 1.0, 0.0, 2.0)

        motions = [motion_type1, motion_type2, motion_type3, motion_type4, motion_type5, motion_type6]
        poses = _build_camera_poses(
            motion_type1,
            motion_type2,
            motion_type3,
            motion_type4,
            motion_type5,
            motion_type6,
            float(speed),
            safe_frames,
            prev_poses=prev_poses,
        )
        embeds = _fun_camera_embeds(poses, width, height, strength, start_percent, end_percent)
        preview = _camera_preview_image(
            poses,
            preview_base_xval,
            preview_zval,
            preview_scale,
            bool(use_exact_fx),
            bool(relative_c2w),
        )
        preview_entries = _save_preview_entries(preview)
        summary = _summary_text(poses, width, height, strength, start_percent, end_percent, aligned, requested_frames, motions)

        return {
            "ui": {
                "preview_images": preview_entries,
                "images": [dict(item) for item in preview_entries],
                "preview_text": [summary],
                "gjj_fun_camera_status": [summary],
            },
            "result": (embeds, poses, preview),
        }


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanFunCameraControl,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
