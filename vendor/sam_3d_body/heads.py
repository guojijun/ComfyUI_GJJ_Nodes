# Output heads: MHR pose head and perspective camera head.

import os
import warnings
from typing import Optional, Tuple

import roma
import torch
import torch.nn as nn

import comfy.model_management
import comfy.ops

from .transformer import FFN
from .utils_model import (
    compact_cont_to_model_params_body,
    compact_cont_to_model_params_hand,
    compact_model_params_to_cont_body,
    mhr_param_hand_mask,
    perspective_projection,
    rot6d_to_rotmat,
    to_2tuple,
)

ops = comfy.ops.manual_cast


# =============================================================================
# MHR (Momentum Human Rig) head
# =============================================================================

MOMENTUM_ENABLED = os.environ.get("MOMENTUM_ENABLED") is None
try:
    if MOMENTUM_ENABLED:
        from mhr.mhr import MHR
        MOMENTUM_ENABLED = True
        warnings.warn("Momentum is enabled")
    else:
        warnings.warn("Momentum is not enabled")
        raise ImportError
except Exception:
    MOMENTUM_ENABLED = False
    warnings.warn("Momentum is not enabled")


class MHRHead(nn.Module):
    def __init__(
        self,
        input_dim: int,
        mlp_depth: int = 1,
        mhr_model_path: str = "",
        extra_joint_regressor: str = "",
        ffn_zero_bias: bool = True,
        mlp_channel_div_factor: int = 8,
        enable_hand_model=False,
        dtype=None,
        device=None,
        operations=ops,
    ):
        super().__init__()

        self.num_shape_comps = 45
        self.num_scale_comps = 28
        self.num_hand_comps = 54
        self.num_face_comps = 72
        self.enable_hand_model = enable_hand_model

        self.body_cont_dim = 260
        self.npose = (
            6
            + self.body_cont_dim
            + self.num_shape_comps
            + self.num_scale_comps
            + self.num_hand_comps * 2
            + self.num_face_comps
        )

        self.proj = FFN(
            embed_dims=input_dim,
            feedforward_channels=input_dim // mlp_channel_div_factor,
            output_dims=self.npose,
            num_fcs=mlp_depth,
            ffn_drop=0.0,
            add_identity=False,
            dtype=dtype,
            device=device,
            operations=operations,
        )

        if ffn_zero_bias:
            torch.nn.init.zeros_(self.proj.layers[-2].bias)

        # MHR Parameters
        self.model_data_dir = mhr_model_path
        self.num_hand_scale_comps = self.num_scale_comps - 18
        self.num_hand_pose_comps = self.num_hand_comps

        # Buffers to be filled in by model state dict
        self.joint_rotation = nn.Parameter(torch.zeros(127, 3, 3), requires_grad=False)
        self.scale_mean = nn.Parameter(torch.zeros(68), requires_grad=False)
        self.scale_comps = nn.Parameter(torch.zeros(28, 68), requires_grad=False)
        self.faces = nn.Parameter(torch.zeros(36874, 3).long(), requires_grad=False)
        self.hand_pose_mean = nn.Parameter(torch.zeros(54), requires_grad=False)
        self.hand_pose_comps = nn.Parameter(torch.eye(54), requires_grad=False)
        self.hand_joint_idxs_left = nn.Parameter(
            torch.zeros(27).long(), requires_grad=False
        )
        self.hand_joint_idxs_right = nn.Parameter(
            torch.zeros(27).long(), requires_grad=False
        )
        self.keypoint_mapping = nn.Parameter(
            torch.zeros(308, 18439 + 127), requires_grad=False
        )
        self.right_wrist_coords = nn.Parameter(torch.zeros(3), requires_grad=False)
        self.root_coords = nn.Parameter(torch.zeros(3), requires_grad=False)
        self.local_to_world_wrist = nn.Parameter(torch.zeros(3, 3), requires_grad=False)
        self.nonhand_param_idxs = nn.Parameter(
            torch.zeros(145).long(), requires_grad=False
        )

        # Load MHR itself
        if MOMENTUM_ENABLED:
            self.mhr = MHR.from_files(
                device=comfy.model_management.get_torch_device(),
                lod=1,
            )
        else:
            self.mhr = torch.jit.load(
                mhr_model_path,
                map_location=comfy.model_management.get_torch_device(),
            )

        for param in self.mhr.parameters():
            param.requires_grad = False

    def get_zero_pose_init(self, factor=1.0):
        weights = torch.zeros(1, self.npose)
        weights[:, : 6 + self.body_cont_dim] = torch.cat(
            [
                torch.FloatTensor([1, 0, 0, 0, 1, 0]),
                compact_model_params_to_cont_body(torch.zeros(1, 133)).squeeze()
                * factor,
            ],
            dim=0,
        )
        return weights

    def replace_hands_in_pose(self, full_pose_params, hand_pose_params):
        assert full_pose_params.shape[1] == 136

        left_hand_params, right_hand_params = torch.split(
            hand_pose_params,
            [self.num_hand_pose_comps, self.num_hand_pose_comps],
            dim=1,
        )

        left_hand_params_model_params = compact_cont_to_model_params_hand(
            self.hand_pose_mean
            + torch.einsum("da,ab->db", left_hand_params, self.hand_pose_comps)
        )
        right_hand_params_model_params = compact_cont_to_model_params_hand(
            self.hand_pose_mean
            + torch.einsum("da,ab->db", right_hand_params, self.hand_pose_comps)
        )

        full_pose_params[:, self.hand_joint_idxs_left] = left_hand_params_model_params
        full_pose_params[:, self.hand_joint_idxs_right] = right_hand_params_model_params

        return full_pose_params

    def mhr_forward(
        self,
        global_trans,
        global_rot,
        body_pose_params,
        hand_pose_params,
        scale_params,
        shape_params,
        expr_params=None,
        return_keypoints=False,
        do_pcblend=True,
        return_joint_coords=False,
        return_model_params=False,
        return_joint_rotations=False,
        scale_offsets=None,
        vertex_offsets=None,
    ):
        if self.enable_hand_model:
            global_rot_ori = global_rot.clone()
            global_trans_ori = global_trans.clone()
            global_rot = roma.rotmat_to_euler(
                "xyz",
                roma.euler_to_rotmat("xyz", global_rot_ori) @ self.local_to_world_wrist,
            )
            global_trans = (
                -(
                    roma.euler_to_rotmat("xyz", global_rot)
                    @ (self.right_wrist_coords - self.root_coords)
                    + self.root_coords
                )
                + global_trans_ori
            )

        body_pose_params = body_pose_params[..., :130]

        if len(scale_params.shape) == 1:
            scale_params = scale_params[None]
        if len(shape_params.shape) == 1:
            shape_params = shape_params[None]
        scales = self.scale_mean[None, :] + scale_params @ self.scale_comps
        if scale_offsets is not None:
            scales = scales + scale_offsets

        full_pose_params = torch.cat(
            [global_trans * 10, global_rot, body_pose_params], dim=1
        )
        if hand_pose_params is not None:
            full_pose_params = self.replace_hands_in_pose(
                full_pose_params, hand_pose_params
            )
        model_params = torch.cat([full_pose_params, scales], dim=1)

        if self.enable_hand_model:
            model_params[:, self.nonhand_param_idxs] = 0

        # Cast to fp32 for MHR JIT model (sparse CUDA ops don't support bf16)
        input_dtype = shape_params.dtype
        curr_skinned_verts, curr_skel_state = self.mhr(
            shape_params.float(), model_params.float(),
            expr_params.float() if expr_params is not None else None
        )
        curr_skinned_verts = curr_skinned_verts.to(input_dtype)
        curr_skel_state = curr_skel_state.to(input_dtype)
        curr_joint_coords, curr_joint_quats, _ = torch.split(
            curr_skel_state, [3, 4, 1], dim=2
        )
        curr_skinned_verts = curr_skinned_verts / 100
        curr_joint_coords = curr_joint_coords / 100
        curr_joint_rots = roma.unitquat_to_rotmat(curr_joint_quats)

        to_return = [curr_skinned_verts]
        if return_keypoints:
            model_vert_joints = torch.cat(
                [curr_skinned_verts, curr_joint_coords], dim=1
            )
            model_keypoints_pred = (
                (
                    self.keypoint_mapping
                    @ model_vert_joints.permute(1, 0, 2).flatten(1, 2)
                )
                .reshape(-1, model_vert_joints.shape[0], 3)
                .permute(1, 0, 2)
            )

            if self.enable_hand_model:
                model_keypoints_pred[:, :21] = 0
                model_keypoints_pred[:, 42:] = 0

            to_return = to_return + [model_keypoints_pred]
        if return_joint_coords:
            to_return = to_return + [curr_joint_coords]
        if return_model_params:
            to_return = to_return + [model_params]
        if return_joint_rotations:
            to_return = to_return + [curr_joint_rots]

        if isinstance(to_return, list) and len(to_return) == 1:
            return to_return[0]
        else:
            return tuple(to_return)

    def forward(
        self,
        x: torch.Tensor,
        init_estimate: Optional[torch.Tensor] = None,
        do_pcblend=True,
        slim_keypoints=False,
    ):
        batch_size = x.shape[0]
        pred = self.proj(x)
        if init_estimate is not None:
            pred = pred + init_estimate

        count = 6
        global_rot_6d = pred[:, :count]
        global_rot_rotmat = rot6d_to_rotmat(global_rot_6d)
        global_rot_euler = roma.rotmat_to_euler("ZYX", global_rot_rotmat)
        global_trans = torch.zeros_like(global_rot_euler)

        pred_pose_cont = pred[:, count : count + self.body_cont_dim]
        count += self.body_cont_dim
        pred_pose_euler = compact_cont_to_model_params_body(pred_pose_cont)
        pred_pose_euler[:, mhr_param_hand_mask] = 0
        pred_pose_euler[:, -3:] = 0

        pred_shape = pred[:, count : count + self.num_shape_comps]
        count += self.num_shape_comps
        pred_scale = pred[:, count : count + self.num_scale_comps]
        count += self.num_scale_comps
        pred_hand = pred[:, count : count + self.num_hand_comps * 2]
        count += self.num_hand_comps * 2
        pred_face = pred[:, count : count + self.num_face_comps] * 0
        count += self.num_face_comps

        output = self.mhr_forward(
            global_trans=global_trans,
            global_rot=global_rot_euler,
            body_pose_params=pred_pose_euler,
            hand_pose_params=pred_hand,
            scale_params=pred_scale,
            shape_params=pred_shape,
            expr_params=pred_face,
            do_pcblend=do_pcblend,
            return_keypoints=True,
            return_joint_coords=True,
            return_model_params=True,
            return_joint_rotations=True,
        )

        verts, j3d, jcoords, mhr_model_params, joint_global_rots = output
        j3d = j3d[:, :70]

        if verts is not None:
            verts[..., [1, 2]] *= -1
        j3d[..., [1, 2]] *= -1
        if jcoords is not None:
            jcoords[..., [1, 2]] *= -1

        output = {
            "pred_pose_raw": torch.cat(
                [global_rot_6d, pred_pose_cont], dim=1
            ),
            "pred_pose_rotmat": None,
            "global_rot": global_rot_euler,
            "body_pose": pred_pose_euler,
            "shape": pred_shape,
            "scale": pred_scale,
            "hand": pred_hand,
            "face": pred_face,
            "pred_keypoints_3d": j3d.reshape(batch_size, -1, 3),
            "pred_vertices": (
                verts.reshape(batch_size, -1, 3) if verts is not None else None
            ),
            "pred_joint_coords": (
                jcoords.reshape(batch_size, -1, 3) if jcoords is not None else None
            ),
            "faces": self.faces.cpu().numpy(),
            "joint_global_rots": joint_global_rots,
            "mhr_model_params": mhr_model_params,
        }

        return output


# =============================================================================
# Perspective camera head
# =============================================================================

class PerspectiveHead(nn.Module):
    """Predict camera translation (s, tx, ty) and perform full-perspective
    2D reprojection."""

    def __init__(
        self,
        input_dim: int,
        img_size: Tuple[int, int],
        mlp_depth: int = 1,
        drop_ratio: float = 0.0,
        mlp_channel_div_factor: int = 8,
        default_scale_factor: float = 1,
        dtype=None,
        device=None,
        operations=ops,
    ):
        super().__init__()

        self.img_size = to_2tuple(img_size)
        self.ncam = 3
        self.default_scale_factor = default_scale_factor

        self.proj = FFN(
            embed_dims=input_dim,
            feedforward_channels=input_dim // mlp_channel_div_factor,
            output_dims=self.ncam,
            num_fcs=mlp_depth,
            ffn_drop=drop_ratio,
            add_identity=False,
            dtype=dtype,
            device=device,
            operations=operations,
        )

    def forward(
        self,
        x: torch.Tensor,
        init_estimate: Optional[torch.Tensor] = None,
    ):
        pred_cam = self.proj(x)
        if init_estimate is not None:
            pred_cam = pred_cam + init_estimate
        return pred_cam

    def perspective_projection(
        self,
        points_3d: torch.Tensor,
        pred_cam: torch.Tensor,
        bbox_center: torch.Tensor,
        bbox_size: torch.Tensor,
        img_size: torch.Tensor,
        cam_int: torch.Tensor,
        use_intrin_center: bool = False,
    ):
        batch_size = points_3d.shape[0]
        pred_cam = pred_cam.clone()
        pred_cam[..., [0, 2]] *= -1

        s, tx, ty = pred_cam[:, 0], pred_cam[:, 1], pred_cam[:, 2]
        bs = bbox_size * s * self.default_scale_factor + 1e-8
        focal_length = cam_int[:, 0, 0]
        tz = 2 * focal_length / bs

        if not use_intrin_center:
            cx = 2 * (bbox_center[:, 0] - (img_size[:, 0] / 2)) / bs
            cy = 2 * (bbox_center[:, 1] - (img_size[:, 1] / 2)) / bs
        else:
            cx = 2 * (bbox_center[:, 0] - (cam_int[:, 0, 2])) / bs
            cy = 2 * (bbox_center[:, 1] - (cam_int[:, 1, 2])) / bs

        pred_cam_t = torch.stack([tx + cx, ty + cy, tz], dim=-1)

        j3d_cam = points_3d + pred_cam_t.unsqueeze(1)
        j2d = perspective_projection(j3d_cam, cam_int)

        return {
            "pred_keypoints_2d": j2d.reshape(batch_size, -1, 2),
            "pred_cam_t": pred_cam_t,
            "focal_length": focal_length,
            "pred_keypoints_2d_depth": j3d_cam.reshape(batch_size, -1, 3)[:, :, 2],
        }
