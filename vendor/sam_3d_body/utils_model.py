# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# Consolidated utility functions for SAM 3D Body inference.
# Sources: geometry_utils.py, mhr_utils.py, misc.py, fp16_utils.py, dist.py

import collections.abc
from itertools import repeat
from typing import Any, Optional

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


# =============================================================================
# misc.py — tuple utilities
# =============================================================================

def _ntuple(n):
    def parse(x):
        if isinstance(x, collections.abc.Iterable):
            return x
        return tuple(repeat(x, n))
    return parse

to_1tuple = _ntuple(1)
to_2tuple = _ntuple(2)
to_3tuple = _ntuple(3)
to_4tuple = _ntuple(4)
to_ntuple = _ntuple


# =============================================================================
# geometry_utils.py — Camera, rotation, and projection utilities
# =============================================================================

def cam_crop_to_full(cam_bbox, box_center, box_size, img_size, focal_length=5000.0):
    img_w, img_h = img_size[:, 0], img_size[:, 1]
    cx, cy, b = box_center[:, 0], box_center[:, 1], box_size
    w_2, h_2 = img_w / 2.0, img_h / 2.0
    bs = b * cam_bbox[:, 0] + 1e-9
    if type(focal_length) is float:
        focal_length = torch.ones_like(cam_bbox[:, 0]) * focal_length
    tz = 2 * focal_length / bs
    tx = (2 * (cx - w_2) / bs) + cam_bbox[:, 1]
    ty = (2 * (cy - h_2) / bs) + cam_bbox[:, 2]
    full_cam = torch.stack([tx, ty, tz], dim=-1)
    return full_cam


def aa_to_rotmat(theta: torch.Tensor):
    norm = torch.norm(theta + 1e-8, p=2, dim=1)
    angle = torch.unsqueeze(norm, -1)
    normalized = torch.div(theta, angle)
    angle = angle * 0.5
    v_cos = torch.cos(angle)
    v_sin = torch.sin(angle)
    quat = torch.cat([v_cos, v_sin * normalized], dim=1)
    return _quat_to_rotmat(quat)


def _quat_to_rotmat(quat: torch.Tensor) -> torch.Tensor:
    norm_quat = quat
    norm_quat = norm_quat / norm_quat.norm(p=2, dim=1, keepdim=True)
    w, x, y, z = norm_quat[:, 0], norm_quat[:, 1], norm_quat[:, 2], norm_quat[:, 3]

    B = quat.size(0)

    w2, x2, y2, z2 = w.pow(2), x.pow(2), y.pow(2), z.pow(2)
    wx, wy, wz = w * x, w * y, w * z
    xy, xz, yz = x * y, x * z, y * z

    rotMat = torch.stack(
        [
            w2 + x2 - y2 - z2,
            2 * xy - 2 * wz,
            2 * wy + 2 * xz,
            2 * wz + 2 * xy,
            w2 - x2 + y2 - z2,
            2 * yz - 2 * wx,
            2 * xz - 2 * wy,
            2 * wx + 2 * yz,
            w2 - x2 - y2 + z2,
        ],
        dim=1,
    ).view(B, 3, 3)
    return rotMat


def rot6d_to_rotmat(x: torch.Tensor) -> torch.Tensor:
    x = x.reshape(-1, 2, 3).permute(0, 2, 1).contiguous()
    a1 = x[:, :, 0]
    a2 = x[:, :, 1]
    b1 = F.normalize(a1)
    b2 = F.normalize(a2 - torch.einsum("bi,bi->b", b1, a2).unsqueeze(-1) * b1)
    b3 = torch.linalg.cross(b1, b2)
    return torch.stack((b1, b2, b3), dim=-1)


def rotmat_to_rot6d(x: torch.Tensor) -> torch.Tensor:
    batch_dim = x.size()[:-2]
    return x[..., :2, :].clone().reshape(batch_dim + (6,))


def rot_aa(aa: np.array, rot: float) -> np.array:
    R = np.array(
        [
            [np.cos(np.deg2rad(-rot)), -np.sin(np.deg2rad(-rot)), 0],
            [np.sin(np.deg2rad(-rot)), np.cos(np.deg2rad(-rot)), 0],
            [0, 0, 1],
        ]
    )
    per_rdg, _ = cv2.Rodrigues(aa)
    resrot, _ = cv2.Rodrigues(np.dot(R, per_rdg))
    aa = (resrot.T)[0]
    return aa.astype(np.float32)


def transform_points(
    points: torch.Tensor,
    translation: Optional[torch.Tensor] = None,
    rotation: Optional[torch.Tensor] = None,
) -> torch.Tensor:
    if rotation is not None:
        points = torch.einsum("bij,bkj->bki", rotation, points)
    if translation is not None:
        points = points + translation.unsqueeze(1)
    return points


def get_intrinsic_matrix(
    focal_length: torch.Tensor, principle: torch.Tensor
) -> torch.Tensor:
    if isinstance(focal_length, float):
        fl_x = fl_y = focal_length
    elif len(focal_length) == 1:
        fl_x = fl_y = focal_length[0]
    else:
        fl_x, fl_y = focal_length[0], focal_length[1]
    K = torch.eye(3)
    K[0, 0] = fl_x
    K[1, 1] = fl_y
    K[0, -1] = principle[0]
    K[1, -1] = principle[1]
    return K


def perspective_projection(x, K):
    y = x / x[:, :, -1].unsqueeze(-1)
    y = torch.einsum("bij,bkj->bki", K, y)
    return y[:, :, :2]


def inverse_perspective_projection(points, K, distance):
    points = torch.cat([points, torch.ones_like(points[..., :1])], -1)
    points = torch.einsum("bij,bkj->bki", torch.inverse(K), points)
    if distance is None:
        return points
    points = points * distance
    return points


def get_cam_intrinsics(img_size, fov=55, p_x=None, p_y=None):
    K = np.eye(3)
    focal = get_focalLength_from_fieldOfView(fov=fov, img_size=img_size)
    K[0, 0], K[1, 1] = focal, focal
    if p_x is not None and p_y is not None:
        K[0, -1], K[1, -1] = p_x * img_size, p_y * img_size
    else:
        K[0, -1], K[1, -1] = img_size // 2, img_size // 2
    return K


def get_focalLength_from_fieldOfView(fov=60, img_size=512):
    focal = img_size / (2 * np.tan(np.radians(fov) / 2))
    return focal


def focal_length_normalization(x, f, fovn=60, img_size=448):
    fn = get_focalLength_from_fieldOfView(fov=fovn, img_size=img_size)
    y = x * (fn / f)
    return y


def undo_focal_length_normalization(y, f, fovn=60, img_size=448):
    fn = get_focalLength_from_fieldOfView(fov=fovn, img_size=img_size)
    x = y * (f / fn)
    return x


EPS_LOG = 1e-10


def log_depth(x, eps=EPS_LOG):
    return torch.log(x + eps)


def undo_log_depth(y, eps=EPS_LOG):
    return torch.exp(y) - eps


# =============================================================================
# mhr_utils.py — MHR body/hand rotation utilities
# =============================================================================

def rotation_angle_difference(A: torch.Tensor, B: torch.Tensor) -> torch.Tensor:
    R_rel = torch.matmul(A, B.transpose(-2, -1))
    trace = R_rel[..., 0, 0] + R_rel[..., 1, 1] + R_rel[..., 2, 2]
    cos_theta = (trace - 1) / 2
    cos_theta_clamped = torch.clamp(cos_theta, -1.0, 1.0)
    angle = torch.acos(cos_theta_clamped)
    return angle


def fix_wrist_euler(
    wrist_xzy, limits_x=(-2.2, 1.0), limits_z=(-2.2, 1.5), limits_y=(-1.2, 1.5)
):
    x, z, y = wrist_xzy[..., 0], wrist_xzy[..., 1], wrist_xzy[..., 2]

    x_alt = torch.atan2(torch.sin(x + torch.pi), torch.cos(x + torch.pi))
    z_alt = torch.atan2(torch.sin(-(z + torch.pi)), torch.cos(-(z + torch.pi)))
    y_alt = torch.atan2(torch.sin(y + torch.pi), torch.cos(y + torch.pi))

    def calc_violation(val, limits):
        below = torch.clamp(limits[0] - val, min=0.0)
        above = torch.clamp(val - limits[1], min=0.0)
        return below**2 + above**2

    violation_orig = (
        calc_violation(x, limits_x)
        + calc_violation(z, limits_z)
        + calc_violation(y, limits_y)
    )
    violation_alt = (
        calc_violation(x_alt, limits_x)
        + calc_violation(z_alt, limits_z)
        + calc_violation(y_alt, limits_y)
    )

    use_alt = violation_alt < violation_orig
    wrist_xzy_alt = torch.stack([x_alt, z_alt, y_alt], dim=-1)
    result = torch.where(use_alt.unsqueeze(-1), wrist_xzy_alt, wrist_xzy)
    return result


def batch6DFromXYZ(r, return_9D=False):
    rc = torch.cos(r)
    rs = torch.sin(r)
    cx = rc[..., 0]
    cy = rc[..., 1]
    cz = rc[..., 2]
    sx = rs[..., 0]
    sy = rs[..., 1]
    sz = rs[..., 2]

    result = torch.empty(list(r.shape[:-1]) + [3, 3], dtype=r.dtype).to(r.device)

    result[..., 0, 0] = cy * cz
    result[..., 0, 1] = -cx * sz + sx * sy * cz
    result[..., 0, 2] = sx * sz + cx * sy * cz
    result[..., 1, 0] = cy * sz
    result[..., 1, 1] = cx * cz + sx * sy * sz
    result[..., 1, 2] = -sx * cz + cx * sy * sz
    result[..., 2, 0] = -sy
    result[..., 2, 1] = sx * cy
    result[..., 2, 2] = cx * cy

    if not return_9D:
        return torch.cat([result[..., :, 0], result[..., :, 1]], dim=-1)
    else:
        return result


def batchXYZfrom6D(poses):
    x_raw = poses[..., :3]
    y_raw = poses[..., 3:]

    x = F.normalize(x_raw, dim=-1)
    z = torch.cross(x, y_raw, dim=-1)
    z = F.normalize(z, dim=-1)
    y = torch.cross(z, x, dim=-1)

    matrix = torch.stack([x, y, z], dim=-1)

    sy = torch.sqrt(
        matrix[..., 0, 0] * matrix[..., 0, 0] + matrix[..., 1, 0] * matrix[..., 1, 0]
    )
    singular = sy < 1e-6
    singular = singular.float()

    x = torch.atan2(matrix[..., 2, 1], matrix[..., 2, 2])
    y = torch.atan2(-matrix[..., 2, 0], sy)
    z = torch.atan2(matrix[..., 1, 0], matrix[..., 0, 0])

    xs = torch.atan2(-matrix[..., 1, 2], matrix[..., 1, 1])
    ys = torch.atan2(-matrix[..., 2, 0], sy)
    zs = matrix[..., 1, 0] * 0

    out_euler = torch.zeros_like(matrix[..., 0])
    out_euler[..., 0] = x * (1 - singular) + xs * singular
    out_euler[..., 1] = y * (1 - singular) + ys * singular
    out_euler[..., 2] = z * (1 - singular) + zs * singular

    return out_euler


def batch9Dfrom6D(poses):
    x_raw = poses[..., :3]
    y_raw = poses[..., 3:]

    x = F.normalize(x_raw, dim=-1)
    z = torch.cross(x, y_raw, dim=-1)
    z = F.normalize(z, dim=-1)
    y = torch.cross(z, x, dim=-1)

    matrix = torch.stack([x, y, z], dim=-1).flatten(-2, -1)
    return matrix


def batch4Dfrom2D(poses):
    poses_norm = F.normalize(poses, dim=-1)
    poses_4d = torch.stack(
        [
            poses_norm[..., 1],
            poses_norm[..., 0],
            -poses_norm[..., 0],
            poses_norm[..., 1],
        ],
        dim=-1,
    )
    return poses_4d


def compact_cont_to_model_params_hand(hand_cont):
    assert hand_cont.shape[-1] == 54
    hand_dofs_in_order = torch.tensor([3, 1, 1, 3, 1, 1, 3, 1, 1, 3, 1, 1, 2, 3, 1, 1])
    assert sum(hand_dofs_in_order) == 27
    mask_cont_threedofs = torch.cat(
        [torch.ones(2 * k).bool() * (k in [3]) for k in hand_dofs_in_order]
    )
    mask_cont_onedofs = torch.cat(
        [torch.ones(2 * k).bool() * (k in [1, 2]) for k in hand_dofs_in_order]
    )
    mask_model_params_threedofs = torch.cat(
        [torch.ones(k).bool() * (k in [3]) for k in hand_dofs_in_order]
    )
    mask_model_params_onedofs = torch.cat(
        [torch.ones(k).bool() * (k in [1, 2]) for k in hand_dofs_in_order]
    )

    hand_cont_threedofs = hand_cont[..., mask_cont_threedofs].unflatten(-1, (-1, 6))
    hand_model_params_threedofs = batchXYZfrom6D(hand_cont_threedofs).flatten(-2, -1)
    hand_cont_onedofs = hand_cont[..., mask_cont_onedofs].unflatten(-1, (-1, 2))
    hand_model_params_onedofs = torch.atan2(
        hand_cont_onedofs[..., -2], hand_cont_onedofs[..., -1]
    )

    hand_model_params = torch.zeros(*hand_cont.shape[:-1], 27).to(hand_cont)
    hand_model_params[..., mask_model_params_threedofs] = hand_model_params_threedofs
    hand_model_params[..., mask_model_params_onedofs] = hand_model_params_onedofs
    return hand_model_params


def compact_model_params_to_cont_hand(hand_model_params):
    assert hand_model_params.shape[-1] == 27
    hand_dofs_in_order = torch.tensor([3, 1, 1, 3, 1, 1, 3, 1, 1, 3, 1, 1, 2, 3, 1, 1])
    assert sum(hand_dofs_in_order) == 27
    mask_cont_threedofs = torch.cat(
        [torch.ones(2 * k).bool() * (k in [3]) for k in hand_dofs_in_order]
    )
    mask_cont_onedofs = torch.cat(
        [torch.ones(2 * k).bool() * (k in [1, 2]) for k in hand_dofs_in_order]
    )
    mask_model_params_threedofs = torch.cat(
        [torch.ones(k).bool() * (k in [3]) for k in hand_dofs_in_order]
    )
    mask_model_params_onedofs = torch.cat(
        [torch.ones(k).bool() * (k in [1, 2]) for k in hand_dofs_in_order]
    )

    hand_model_params_threedofs = hand_model_params[
        ..., mask_model_params_threedofs
    ].unflatten(-1, (-1, 3))
    hand_cont_threedofs = batch6DFromXYZ(hand_model_params_threedofs).flatten(-2, -1)
    hand_model_params_onedofs = hand_model_params[..., mask_model_params_onedofs]
    hand_cont_onedofs = torch.stack(
        [hand_model_params_onedofs.sin(), hand_model_params_onedofs.cos()], dim=-1
    ).flatten(-2, -1)

    hand_cont = torch.zeros(*hand_model_params.shape[:-1], 54).to(hand_model_params)
    hand_cont[..., mask_cont_threedofs] = hand_cont_threedofs
    hand_cont[..., mask_cont_onedofs] = hand_cont_onedofs
    return hand_cont


def compact_cont_to_rotmat_body(body_pose_cont, inflate_trans=False):
    # fmt: off
    all_param_3dof_rot_idxs = torch.LongTensor([(0, 2, 4), (6, 8, 10), (12, 13, 14), (15, 16, 17), (18, 19, 20), (21, 22, 23), (24, 25, 26), (27, 28, 29), (34, 35, 36), (37, 38, 39), (44, 45, 46), (53, 54, 55), (64, 65, 66), (85, 69, 73), (86, 70, 79), (87, 71, 82), (88, 72, 76), (91, 92, 93), (112, 96, 100), (113, 97, 106), (114, 98, 109), (115, 99, 103), (130, 131, 132)])
    all_param_1dof_rot_idxs = torch.LongTensor([1, 3, 5, 7, 9, 11, 30, 31, 32, 33, 40, 41, 42, 43, 47, 48, 49, 50, 51, 52, 56, 57, 58, 59, 60, 61, 62, 63, 67, 68, 74, 75, 77, 78, 80, 81, 83, 84, 89, 90, 94, 95, 101, 102, 104, 105, 107, 108, 110, 111, 116, 117, 118, 119, 120, 121, 122, 123])
    all_param_1dof_trans_idxs = torch.LongTensor([124, 125, 126, 127, 128, 129])
    # fmt: on
    num_3dof_angles = len(all_param_3dof_rot_idxs) * 3
    num_1dof_angles = len(all_param_1dof_rot_idxs)
    num_1dof_trans = len(all_param_1dof_trans_idxs)
    assert body_pose_cont.shape[-1] == (
        2 * num_3dof_angles + 2 * num_1dof_angles + num_1dof_trans
    )
    body_cont_3dofs = body_pose_cont[..., : 2 * num_3dof_angles]
    body_cont_1dofs = body_pose_cont[
        ..., 2 * num_3dof_angles : 2 * num_3dof_angles + 2 * num_1dof_angles
    ]
    body_cont_trans = body_pose_cont[..., 2 * num_3dof_angles + 2 * num_1dof_angles :]
    body_cont_3dofs = body_cont_3dofs.unflatten(-1, (-1, 6))
    body_rotmat_3dofs = batch9Dfrom6D(body_cont_3dofs).flatten(-2, -1)
    body_cont_1dofs = body_cont_1dofs.unflatten(-1, (-1, 2))
    body_rotmat_1dofs = batch4Dfrom2D(body_cont_1dofs).flatten(-2, -1)
    if inflate_trans:
        assert False, "inflate_trans not supported"
    else:
        body_rotmat_trans = body_cont_trans
    body_rotmat_params = torch.cat(
        [body_rotmat_3dofs, body_rotmat_1dofs, body_rotmat_trans], dim=-1
    )
    return body_rotmat_params


def compact_cont_to_model_params_body(body_pose_cont):
    # fmt: off
    all_param_3dof_rot_idxs = torch.LongTensor([(0, 2, 4), (6, 8, 10), (12, 13, 14), (15, 16, 17), (18, 19, 20), (21, 22, 23), (24, 25, 26), (27, 28, 29), (34, 35, 36), (37, 38, 39), (44, 45, 46), (53, 54, 55), (64, 65, 66), (85, 69, 73), (86, 70, 79), (87, 71, 82), (88, 72, 76), (91, 92, 93), (112, 96, 100), (113, 97, 106), (114, 98, 109), (115, 99, 103), (130, 131, 132)])
    all_param_1dof_rot_idxs = torch.LongTensor([1, 3, 5, 7, 9, 11, 30, 31, 32, 33, 40, 41, 42, 43, 47, 48, 49, 50, 51, 52, 56, 57, 58, 59, 60, 61, 62, 63, 67, 68, 74, 75, 77, 78, 80, 81, 83, 84, 89, 90, 94, 95, 101, 102, 104, 105, 107, 108, 110, 111, 116, 117, 118, 119, 120, 121, 122, 123])
    all_param_1dof_trans_idxs = torch.LongTensor([124, 125, 126, 127, 128, 129])
    # fmt: on
    num_3dof_angles = len(all_param_3dof_rot_idxs) * 3
    num_1dof_angles = len(all_param_1dof_rot_idxs)
    num_1dof_trans = len(all_param_1dof_trans_idxs)
    assert body_pose_cont.shape[-1] == (
        2 * num_3dof_angles + 2 * num_1dof_angles + num_1dof_trans
    )
    body_cont_3dofs = body_pose_cont[..., : 2 * num_3dof_angles]
    body_cont_1dofs = body_pose_cont[
        ..., 2 * num_3dof_angles : 2 * num_3dof_angles + 2 * num_1dof_angles
    ]
    body_cont_trans = body_pose_cont[..., 2 * num_3dof_angles + 2 * num_1dof_angles :]
    body_cont_3dofs = body_cont_3dofs.unflatten(-1, (-1, 6))
    body_params_3dofs = batchXYZfrom6D(body_cont_3dofs).flatten(-2, -1)
    body_cont_1dofs = body_cont_1dofs.unflatten(-1, (-1, 2))
    body_params_1dofs = torch.atan2(body_cont_1dofs[..., -2], body_cont_1dofs[..., -1])
    body_params_trans = body_cont_trans
    body_pose_params = torch.zeros(*body_pose_cont.shape[:-1], 133).to(body_pose_cont)
    body_pose_params[..., all_param_3dof_rot_idxs.flatten()] = body_params_3dofs
    body_pose_params[..., all_param_1dof_rot_idxs] = body_params_1dofs
    body_pose_params[..., all_param_1dof_trans_idxs] = body_params_trans
    return body_pose_params


def compact_model_params_to_cont_body(body_pose_params):
    # fmt: off
    all_param_3dof_rot_idxs = torch.LongTensor([(0, 2, 4), (6, 8, 10), (12, 13, 14), (15, 16, 17), (18, 19, 20), (21, 22, 23), (24, 25, 26), (27, 28, 29), (34, 35, 36), (37, 38, 39), (44, 45, 46), (53, 54, 55), (64, 65, 66), (85, 69, 73), (86, 70, 79), (87, 71, 82), (88, 72, 76), (91, 92, 93), (112, 96, 100), (113, 97, 106), (114, 98, 109), (115, 99, 103), (130, 131, 132)])
    all_param_1dof_rot_idxs = torch.LongTensor([1, 3, 5, 7, 9, 11, 30, 31, 32, 33, 40, 41, 42, 43, 47, 48, 49, 50, 51, 52, 56, 57, 58, 59, 60, 61, 62, 63, 67, 68, 74, 75, 77, 78, 80, 81, 83, 84, 89, 90, 94, 95, 101, 102, 104, 105, 107, 108, 110, 111, 116, 117, 118, 119, 120, 121, 122, 123])
    all_param_1dof_trans_idxs = torch.LongTensor([124, 125, 126, 127, 128, 129])
    # fmt: on
    num_3dof_angles = len(all_param_3dof_rot_idxs) * 3
    num_1dof_angles = len(all_param_1dof_rot_idxs)
    num_1dof_trans = len(all_param_1dof_trans_idxs)
    assert body_pose_params.shape[-1] == (
        num_3dof_angles + num_1dof_angles + num_1dof_trans
    )
    body_params_3dofs = body_pose_params[..., all_param_3dof_rot_idxs.flatten()]
    body_params_1dofs = body_pose_params[..., all_param_1dof_rot_idxs]
    body_params_trans = body_pose_params[..., all_param_1dof_trans_idxs]
    body_cont_3dofs = batch6DFromXYZ(body_params_3dofs.unflatten(-1, (-1, 3))).flatten(
        -2, -1
    )
    body_cont_1dofs = torch.stack(
        [body_params_1dofs.sin(), body_params_1dofs.cos()], dim=-1
    ).flatten(-2, -1)
    body_cont_trans = body_params_trans
    body_pose_cont = torch.cat(
        [body_cont_3dofs, body_cont_1dofs, body_cont_trans], dim=-1
    )
    return body_pose_cont


# fmt: off
mhr_param_hand_idxs = [62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115]
mhr_cont_hand_idxs = [72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237]
mhr_param_hand_mask = torch.zeros(133).bool(); mhr_param_hand_mask[mhr_param_hand_idxs] = True
mhr_cont_hand_mask = torch.zeros(260).bool(); mhr_cont_hand_mask[mhr_cont_hand_idxs] = True
# fmt: on


# =============================================================================
# dist.py — recursive device/numpy transfer
# =============================================================================

def recursive_to(x: Any, target):
    """Recursively transfer a batch of data to the target device or numpy."""
    if isinstance(x, dict):
        return {k: recursive_to(v, target) for k, v in x.items()}
    elif isinstance(x, torch.Tensor):
        if target == "numpy":
            return x.float().numpy() if x.is_floating_point() else x.numpy()
        else:
            return x.to(target)
    elif isinstance(x, list):
        return [recursive_to(i, target) for i in x]
    else:
        return x
