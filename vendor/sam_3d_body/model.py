# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# SAM 3D Body — main model.
# Submodules live in sibling files: layers, transformer, vit, prompt,
# decoder, sampling, heads.

import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional, Tuple

import numpy as np
import roma
import torch
import torch.nn as nn
import torch.nn.functional as F

import comfy.ops

from .utils_model import (
    cam_crop_to_full,
    fix_wrist_euler,
    get_intrinsic_matrix,
    perspective_projection,
    rot6d_to_rotmat,
    rotation_angle_difference,
    to_2tuple,
)
from .utils_data import prepare_batch
from .utils_model import recursive_to

# Submodule imports — each file is small and focused
from .layers import build_norm_layer, LayerNorm2d
from .transformer import FFN, MLP
from .vit import vit, vit_l, vit_b, vit256, vit512_384
from .prompt import CameraEncoder, PositionEmbeddingRandom, PromptEncoder
from .decoder import PromptableDecoder
from .sampling import build_keypoint_sampler
from .heads import MHRHead, PerspectiveHead

log = logging.getLogger("sam3dbody")

ops = comfy.ops.manual_cast


# =============================================================================
# Factory functions
# =============================================================================

def create_backbone(name, cfg=None, dtype=None, device=None, operations=ops):
    if name in ["vit_hmr"]:
        backbone = vit(cfg, dtype=dtype, device=device, operations=operations)
    elif name in ["vit_hmr_512_384"]:
        backbone = vit512_384(cfg, dtype=dtype, device=device, operations=operations)
    elif name in ["vit_l"]:
        backbone = vit_l(cfg, dtype=dtype, device=device, operations=operations)
    elif name in ["vit_b"]:
        backbone = vit_b(cfg, dtype=dtype, device=device, operations=operations)
    elif name in [
        "dinov3_vit7b",
        "dinov3_vith16plus",
        "dinov3_vits16",
        "dinov3_vits16plus",
        "dinov3_vitb16",
        "dinov3_vitl16",
    ]:
        from .model_dinov3 import Dinov3Backbone
        backbone = Dinov3Backbone(name, cfg=cfg, dtype=dtype, device=device, operations=operations)
    else:
        raise NotImplementedError("Backbone type is not implemented")
    return backbone


def build_decoder(cfg, context_dim=None, dtype=None, device=None, operations=ops):
    if cfg.TYPE == "sam":
        return PromptableDecoder(
            dims=cfg.DIM,
            context_dims=context_dim,
            depth=cfg.DEPTH,
            num_heads=cfg.HEADS,
            head_dims=cfg.DIM_HEAD,
            mlp_dims=cfg.MLP_DIM,
            layer_scale_init_value=cfg.LAYER_SCALE_INIT,
            drop_rate=cfg.DROP_RATE,
            attn_drop_rate=cfg.ATTN_DROP_RATE,
            drop_path_rate=cfg.DROP_PATH_RATE,
            ffn_type=cfg.FFN_TYPE,
            enable_twoway=cfg.ENABLE_TWOWAY,
            repeat_pe=cfg.REPEAT_PE,
            frozen=cfg.get("FROZEN", False),
            do_interm_preds=cfg.get("DO_INTERM_PREDS", False),
            do_keypoint_tokens=cfg.get("DO_KEYPOINT_TOKENS", False),
            keypoint_token_update=cfg.get("KEYPOINT_TOKEN_UPDATE", None),
            dtype=dtype,
            device=device,
            operations=operations,
        )
    else:
        raise ValueError("Invalid decoder type: ", cfg.TYPE)


def build_head(cfg, head_type="mhr", enable_hand_model=False, default_scale_factor=1.0,
               dtype=None, device=None, operations=ops):
    if head_type == "mhr":
        return MHRHead(
            input_dim=cfg.MODEL.DECODER.DIM,
            mlp_depth=cfg.MODEL.MHR_HEAD.get("MLP_DEPTH", 1),
            mhr_model_path=cfg.MODEL.MHR_HEAD.MHR_MODEL_PATH,
            mlp_channel_div_factor=cfg.MODEL.MHR_HEAD.get("MLP_CHANNEL_DIV_FACTOR", 1),
            enable_hand_model=enable_hand_model,
            dtype=dtype,
            device=device,
            operations=operations,
        )
    elif head_type == "perspective":
        return PerspectiveHead(
            input_dim=cfg.MODEL.DECODER.DIM,
            img_size=to_2tuple(cfg.MODEL.IMAGE_SIZE),
            mlp_depth=cfg.MODEL.get("CAMERA_HEAD", dict()).get("MLP_DEPTH", 1),
            mlp_channel_div_factor=cfg.MODEL.get("CAMERA_HEAD", dict()).get(
                "MLP_CHANNEL_DIV_FACTOR", 1
            ),
            default_scale_factor=default_scale_factor,
            dtype=dtype,
            device=device,
            operations=operations,
        )
    else:
        raise ValueError("Invalid head type: ", head_type)


# =============================================================================
# Base model
# =============================================================================

class BaseModel(nn.Module):
    def __init__(self, cfg, dtype=None, device=None, operations=ops, **kwargs):
        super().__init__()
        self.cfg = cfg
        self._initialze_model(dtype=dtype, device=device, operations=operations, **kwargs)
        self._max_num_person = None
        self._person_valid = None

    def get_dtype(self):
        """Return the model's working dtype (native ComfyUI pattern)."""
        return self.image_mean.dtype

    @abstractmethod
    def _initialze_model(self, dtype=None, device=None, operations=ops, **kwargs) -> None:
        pass

    def data_preprocess(
        self,
        inputs: torch.Tensor,
        crop_width: bool = False,
        is_full: bool = False,
        crop_hand: int = 0,
    ) -> torch.Tensor:
        image_mean = self.image_mean if not is_full else self.full_image_mean
        image_std = self.image_std if not is_full else self.full_image_std

        # Fix E: cast input to match buffer dtype so normalization stays in-dtype
        inputs = inputs.to(dtype=image_mean.dtype)

        if inputs.max() > 1 and image_mean.max() <= 1.0:
            inputs = inputs / 255.0
        elif inputs.max() <= 1.0 and image_mean.max() > 1:
            inputs = inputs * 255.0
        batch_inputs = (inputs - image_mean) / image_std

        if crop_width:
            if crop_hand > 0:
                batch_inputs = batch_inputs[:, :, :, crop_hand:-crop_hand]
            elif self.cfg.MODEL.BACKBONE.TYPE in ["vit_hmr", "vit"]:
                batch_inputs = batch_inputs[:, :, :, 32:-32]
            elif self.cfg.MODEL.BACKBONE.TYPE in ["vit_hmr_512_384"]:
                batch_inputs = batch_inputs[:, :, :, 64:-64]
            else:
                raise Exception

        return batch_inputs

    def _initialize_batch(self, batch: Dict) -> None:
        if batch["img"].dim() == 5:
            self._batch_size, self._max_num_person = batch["img"].shape[:2]
            self._person_valid = self._flatten_person(batch["person_valid"]) > 0
        else:
            self._batch_size = batch["img"].shape[0]
            self._max_num_person = 0
            self._person_valid = None

    def _flatten_person(self, x: torch.Tensor) -> torch.Tensor:
        assert self._max_num_person is not None
        if self._max_num_person:
            shape = x.shape
            x = x.view(self._batch_size * self._max_num_person, *shape[2:])
        return x

    def _unflatten_person(self, x: torch.Tensor) -> torch.Tensor:
        shape = x.shape
        if self._max_num_person:
            x = x.view(self._batch_size, self._max_num_person, *shape[1:])
        return x

    def _get_valid(self, x: torch.Tensor) -> torch.Tensor:
        assert self._max_num_person is not None
        if self._person_valid is not None:
            x = x[self._person_valid]
        return x

    def _full_to_crop(
        self, batch: Dict, pred_keypoints_2d: torch.Tensor
    ) -> torch.Tensor:
        pred_keypoints_2d_cropped = torch.cat(
            [pred_keypoints_2d, torch.ones_like(pred_keypoints_2d[:, :, [-1]])], dim=-1
        )
        affine_trans = self._flatten_person(batch["affine_trans"]).to(
            pred_keypoints_2d_cropped
        )
        img_size = self._flatten_person(batch["img_size"]).unsqueeze(1)
        pred_keypoints_2d_cropped = pred_keypoints_2d_cropped @ affine_trans.mT
        pred_keypoints_2d_cropped = pred_keypoints_2d_cropped[..., :2] / img_size - 0.5
        return pred_keypoints_2d_cropped

    def _cam_full_to_crop(
        self, batch: Dict, pred_cam_t: torch.Tensor, focal_length: torch.Tensor = None
    ) -> torch.Tensor:
        num_person = batch["img"].shape[1]
        cam_int = self._flatten_person(
            batch["cam_int"].unsqueeze(1).expand(-1, num_person, -1, -1).contiguous()
        )
        bbox_center = self._flatten_person(batch["bbox_center"])
        bbox_size = self._flatten_person(batch["bbox_scale"])[:, 0]
        img_size = self._flatten_person(batch["ori_img_size"])
        input_size = self._flatten_person(batch["img_size"])[:, 0]

        tx, ty, tz = pred_cam_t[:, 0], pred_cam_t[:, 1], pred_cam_t[:, 2]
        if focal_length is None:
            focal_length = cam_int[:, 0, 0]
        bs = 2 * focal_length / (tz + 1e-8)

        cx = 2 * (bbox_center[:, 0] - (cam_int[:, 0, 2])) / bs
        cy = 2 * (bbox_center[:, 1] - (cam_int[:, 1, 2])) / bs

        crop_cam_t = torch.stack(
            [tx - cx, ty - cy, tz * bbox_size / input_size], dim=-1
        )
        return crop_cam_t


# =============================================================================
# SAM3DBody — Main model class
# =============================================================================

# fmt: off
PROMPT_KEYPOINTS = {  # keypoint_idx: prompt_idx
    "mhr70": {
        i: i for i in range(70)
    },  # all 70 keypoints are supported for prompting
}
KEY_BODY = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 41, 62]  # key body joints for prompting
KEY_RIGHT_HAND = list(range(21, 42))
# fmt: on


class SAM3DBody(BaseModel):
    pelvis_idx = [9, 10]  # left_hip, right_hip

    def _initialze_model(self, dtype=None, device=None, operations=ops, **kwargs):
        # Fix C: thread dtype to image_mean/image_std so they match model precision
        self.register_buffer(
            "image_mean", torch.tensor(self.cfg.MODEL.IMAGE_MEAN, dtype=dtype).view(-1, 1, 1), False
        )
        self.register_buffer(
            "image_std", torch.tensor(self.cfg.MODEL.IMAGE_STD, dtype=dtype).view(-1, 1, 1), False
        )

        # Create backbone feature extractor for human crops
        self.backbone = create_backbone(
            self.cfg.MODEL.BACKBONE.TYPE, self.cfg,
            dtype=dtype, device=device, operations=operations,
        )

        # Create header for pose estimation output
        self.head_pose = build_head(
            self.cfg, self.cfg.MODEL.PERSON_HEAD.POSE_TYPE,
            dtype=dtype, device=device, operations=operations,
        )
        self.head_pose.hand_pose_comps_ori = nn.Parameter(
            self.head_pose.hand_pose_comps.clone(), requires_grad=False
        )
        self.head_pose.hand_pose_comps.data = (
            torch.eye(54).to(self.head_pose.hand_pose_comps.data).float()
        )

        # Initialize pose token with learnable params
        self.init_pose = operations.Embedding(1, self.head_pose.npose, dtype=dtype, device=device)

        # Define header for hand pose estimation
        self.head_pose_hand = build_head(
            self.cfg, self.cfg.MODEL.PERSON_HEAD.POSE_TYPE, enable_hand_model=True,
            dtype=dtype, device=device, operations=operations,
        )
        self.head_pose_hand.hand_pose_comps_ori = nn.Parameter(
            self.head_pose_hand.hand_pose_comps.clone(), requires_grad=False
        )
        self.head_pose_hand.hand_pose_comps.data = (
            torch.eye(54).to(self.head_pose_hand.hand_pose_comps.data).float()
        )
        self.init_pose_hand = operations.Embedding(1, self.head_pose_hand.npose, dtype=dtype, device=device)

        self.head_camera = build_head(
            self.cfg, self.cfg.MODEL.PERSON_HEAD.CAMERA_TYPE,
            dtype=dtype, device=device, operations=operations,
        )
        self.init_camera = operations.Embedding(1, self.head_camera.ncam, dtype=dtype, device=device)
        nn.init.zeros_(self.init_camera.weight)

        self.head_camera_hand = build_head(
            self.cfg,
            self.cfg.MODEL.PERSON_HEAD.CAMERA_TYPE,
            default_scale_factor=self.cfg.MODEL.CAMERA_HEAD.get(
                "DEFAULT_SCALE_FACTOR_HAND", 1.0
            ),
            dtype=dtype, device=device, operations=operations,
        )
        self.init_camera_hand = operations.Embedding(1, self.head_camera_hand.ncam, dtype=dtype, device=device)
        nn.init.zeros_(self.init_camera_hand.weight)

        self.camera_type = "perspective"

        # Support conditioned information for decoder
        cond_dim = 3
        init_dim = self.head_pose.npose + self.head_camera.ncam + cond_dim
        self.init_to_token_mhr = operations.Linear(
            init_dim, self.cfg.MODEL.DECODER.DIM, dtype=dtype, device=device,
        )
        self.prev_to_token_mhr = operations.Linear(
            init_dim - cond_dim, self.cfg.MODEL.DECODER.DIM, dtype=dtype, device=device,
        )
        self.init_to_token_mhr_hand = operations.Linear(
            init_dim, self.cfg.MODEL.DECODER.DIM, dtype=dtype, device=device,
        )
        self.prev_to_token_mhr_hand = operations.Linear(
            init_dim - cond_dim, self.cfg.MODEL.DECODER.DIM, dtype=dtype, device=device,
        )

        # Create prompt encoder
        self.max_num_clicks = 0
        if self.cfg.MODEL.PROMPT_ENCODER.ENABLE:
            self.max_num_clicks = self.cfg.MODEL.PROMPT_ENCODER.MAX_NUM_CLICKS
            self.prompt_keypoints = PROMPT_KEYPOINTS[
                self.cfg.MODEL.PROMPT_ENCODER.PROMPT_KEYPOINTS
            ]

            self.prompt_encoder = PromptEncoder(
                embed_dim=self.backbone.embed_dims,
                num_body_joints=len(set(self.prompt_keypoints.values())),
                frozen=self.cfg.MODEL.PROMPT_ENCODER.get("frozen", False),
                mask_embed_type=self.cfg.MODEL.PROMPT_ENCODER.get(
                    "MASK_EMBED_TYPE", None
                ),
                dtype=dtype, device=device, operations=operations,
            )
            self.prompt_to_token = operations.Linear(
                self.backbone.embed_dims, self.cfg.MODEL.DECODER.DIM,
                dtype=dtype, device=device,
            )

            self.keypoint_prompt_sampler = build_keypoint_sampler(
                self.cfg.MODEL.PROMPT_ENCODER.get("KEYPOINT_SAMPLER", {}),
                prompt_keypoints=self.prompt_keypoints,
                keybody_idx=(
                    KEY_BODY
                    if not self.cfg.MODEL.PROMPT_ENCODER.get("SAMPLE_HAND", False)
                    else KEY_RIGHT_HAND
                ),
            )
            # To keep track of prompting history
            self.prompt_hist = np.zeros(
                (len(set(self.prompt_keypoints.values())) + 2, self.max_num_clicks),
                dtype=np.float32,
            )

            if self.cfg.MODEL.DECODER.FROZEN:
                for param in self.prompt_to_token.parameters():
                    param.requires_grad = False

        # Create promptable decoder
        self.decoder = build_decoder(
            self.cfg.MODEL.DECODER, context_dim=self.backbone.embed_dims,
            dtype=dtype, device=device, operations=operations,
        )
        # shared config for the two decoders
        self.decoder_hand = build_decoder(
            self.cfg.MODEL.DECODER, context_dim=self.backbone.embed_dims,
            dtype=dtype, device=device, operations=operations,
        )
        self.hand_pe_layer = PositionEmbeddingRandom(self.backbone.embed_dims // 2)

        # Fix A: removed backbone_dtype — operations system handles weight dtype

        self.ray_cond_emb = CameraEncoder(
            self.backbone.embed_dim,
            self.backbone.patch_size,
            dtype=dtype, device=device, operations=operations,
        )
        self.ray_cond_emb_hand = CameraEncoder(
            self.backbone.embed_dim,
            self.backbone.patch_size,
            dtype=dtype, device=device, operations=operations,
        )

        self.keypoint_embedding_idxs = list(range(70))
        self.keypoint_embedding = operations.Embedding(
            len(self.keypoint_embedding_idxs), self.cfg.MODEL.DECODER.DIM, dtype=dtype, device=device,
        )
        self.keypoint_embedding_idxs_hand = list(range(70))
        self.keypoint_embedding_hand = operations.Embedding(
            len(self.keypoint_embedding_idxs_hand), self.cfg.MODEL.DECODER.DIM, dtype=dtype, device=device,
        )

        if self.cfg.MODEL.DECODER.get("DO_HAND_DETECT_TOKENS", False):
            self.hand_box_embedding = operations.Embedding(
                2, self.cfg.MODEL.DECODER.DIM, dtype=dtype, device=device,
            )  # for two hands
            self.hand_cls_embed = operations.Linear(
                self.cfg.MODEL.DECODER.DIM, 2, dtype=dtype, device=device,
            )
            self.bbox_embed = MLP(
                self.cfg.MODEL.DECODER.DIM, self.cfg.MODEL.DECODER.DIM, 4, 3,
                dtype=dtype, device=device, operations=operations,
            )

        self.keypoint_posemb_linear = FFN(
            embed_dims=2,
            feedforward_channels=self.cfg.MODEL.DECODER.DIM,
            output_dims=self.cfg.MODEL.DECODER.DIM,
            num_fcs=2,
            add_identity=False,
            dtype=dtype, device=device, operations=operations,
        )
        self.keypoint_posemb_linear_hand = FFN(
            embed_dims=2,
            feedforward_channels=self.cfg.MODEL.DECODER.DIM,
            output_dims=self.cfg.MODEL.DECODER.DIM,
            num_fcs=2,
            add_identity=False,
            dtype=dtype, device=device, operations=operations,
        )
        self.keypoint_feat_linear = operations.Linear(
            self.backbone.embed_dims, self.cfg.MODEL.DECODER.DIM,
            dtype=dtype, device=device,
        )
        self.keypoint_feat_linear_hand = operations.Linear(
            self.backbone.embed_dims, self.cfg.MODEL.DECODER.DIM,
            dtype=dtype, device=device,
        )

        # Do all KPS
        self.keypoint3d_embedding_idxs = list(range(70))
        self.keypoint3d_embedding = operations.Embedding(
            len(self.keypoint3d_embedding_idxs), self.cfg.MODEL.DECODER.DIM, dtype=dtype, device=device,
        )

        # Assume always do full body for the hand decoder
        self.keypoint3d_embedding_idxs_hand = list(range(70))
        self.keypoint3d_embedding_hand = operations.Embedding(
            len(self.keypoint3d_embedding_idxs_hand), self.cfg.MODEL.DECODER.DIM, dtype=dtype, device=device,
        )

        self.keypoint3d_posemb_linear = FFN(
            embed_dims=3,
            feedforward_channels=self.cfg.MODEL.DECODER.DIM,
            output_dims=self.cfg.MODEL.DECODER.DIM,
            num_fcs=2,
            add_identity=False,
            dtype=dtype, device=device, operations=operations,
        )
        self.keypoint3d_posemb_linear_hand = FFN(
            embed_dims=3,
            feedforward_channels=self.cfg.MODEL.DECODER.DIM,
            output_dims=self.cfg.MODEL.DECODER.DIM,
            num_fcs=2,
            add_identity=False,
            dtype=dtype, device=device, operations=operations,
        )

    def _get_decoder_condition(self, batch: Dict) -> Optional[torch.Tensor]:
        num_person = batch["img"].shape[1]

        if self.cfg.MODEL.DECODER.CONDITION_TYPE == "cliff":
            # CLIFF-style condition info (cx/f, cy/f, b/f)
            cx, cy = torch.chunk(
                self._flatten_person(batch["bbox_center"]), chunks=2, dim=-1
            )
            img_w, img_h = torch.chunk(
                self._flatten_person(batch["ori_img_size"]), chunks=2, dim=-1
            )
            b = self._flatten_person(batch["bbox_scale"])[:, [0]]

            focal_length = self._flatten_person(
                batch["cam_int"]
                .unsqueeze(1)
                .expand(-1, num_person, -1, -1)
                .contiguous()
            )[:, 0, 0]
            if not self.cfg.MODEL.DECODER.get("USE_INTRIN_CENTER", False):
                condition_info = torch.cat(
                    [cx - img_w / 2.0, cy - img_h / 2.0, b], dim=-1
                )
            else:
                full_img_cxy = self._flatten_person(
                    batch["cam_int"]
                    .unsqueeze(1)
                    .expand(-1, num_person, -1, -1)
                    .contiguous()
                )[:, [0, 1], [2, 2]]
                condition_info = torch.cat(
                    [cx - full_img_cxy[:, [0]], cy - full_img_cxy[:, [1]], b], dim=-1
                )
            condition_info[:, :2] = condition_info[:, :2] / focal_length.unsqueeze(
                -1
            )  # [-1, 1]
            condition_info[:, 2] = condition_info[:, 2] / focal_length  # [-1, 1]
        elif self.cfg.MODEL.DECODER.CONDITION_TYPE == "none":
            return None
        else:
            raise NotImplementedError

        return condition_info.type(batch["img"].dtype)

    def forward_decoder(
        self,
        image_embeddings: torch.Tensor,
        init_estimate: Optional[torch.Tensor] = None,
        keypoints: Optional[torch.Tensor] = None,
        prev_estimate: Optional[torch.Tensor] = None,
        condition_info: Optional[torch.Tensor] = None,
        batch=None,
    ):
        batch_size = image_embeddings.shape[0]

        # Initial estimation for residual prediction.
        if init_estimate is None:
            init_pose = self.init_pose.weight.expand(batch_size, -1).unsqueeze(dim=1)
            if hasattr(self, "init_camera"):
                init_camera = self.init_camera.weight.expand(batch_size, -1).unsqueeze(
                    dim=1
                )

            init_estimate = (
                init_pose
                if not hasattr(self, "init_camera")
                else torch.cat([init_pose, init_camera], dim=-1)
            )

        if condition_info is not None:
            init_input = torch.cat(
                [condition_info.view(batch_size, 1, -1), init_estimate], dim=-1
            )
        else:
            init_input = init_estimate
        token_embeddings = self.init_to_token_mhr(init_input).view(
            batch_size, 1, -1
        )

        num_pose_token = token_embeddings.shape[1]
        assert num_pose_token == 1

        image_augment, token_augment, token_mask = None, None, None
        if hasattr(self, "prompt_encoder") and keypoints is not None:
            if prev_estimate is None:
                prev_estimate = init_estimate
            prev_embeddings = self.prev_to_token_mhr(prev_estimate).view(
                batch_size, 1, -1
            )

            if self.cfg.MODEL.BACKBONE.TYPE in [
                "vit_hmr",
                "vit",
                "vit_b",
                "vit_l",
            ]:
                image_augment = self.prompt_encoder.get_dense_pe((16, 16))[
                    :, :, :, 2:-2
                ]
            elif self.cfg.MODEL.BACKBONE.TYPE in [
                "vit_hmr_512_384",
            ]:
                image_augment = self.prompt_encoder.get_dense_pe((32, 32))[
                    :, :, :, 4:-4
                ]
            else:
                image_augment = self.prompt_encoder.get_dense_pe(
                    image_embeddings.shape[-2:]
                )

            image_embeddings = self.ray_cond_emb(image_embeddings, batch["ray_cond"])

            prompt_embeddings, prompt_mask = self.prompt_encoder(
                keypoints=keypoints
            )
            prompt_embeddings = self.prompt_to_token(prompt_embeddings)

            token_embeddings = torch.cat(
                [
                    token_embeddings,
                    prev_embeddings,
                    prompt_embeddings,
                ],
                dim=1,
            )

            token_augment = torch.zeros_like(token_embeddings)
            token_augment[:, [num_pose_token]] = prev_embeddings
            token_augment[:, (num_pose_token + 1) :] = prompt_embeddings
            token_mask = None

            if self.cfg.MODEL.DECODER.get("DO_HAND_DETECT_TOKENS", False):
                hand_det_emb_start_idx = token_embeddings.shape[1]
                token_embeddings = torch.cat(
                    [
                        token_embeddings,
                        self.hand_box_embedding.weight[None, :, :].repeat(
                            batch_size, 1, 1
                        ),
                    ],
                    dim=1,
                )
                token_augment = torch.cat(
                    [
                        token_augment,
                        torch.zeros_like(
                            token_embeddings[:, token_augment.shape[1] :, :]
                        ),
                    ],
                    dim=1,
                )

            assert self.cfg.MODEL.DECODER.get("DO_KEYPOINT_TOKENS", False)
            kps_emb_start_idx = token_embeddings.shape[1]
            token_embeddings = torch.cat(
                [
                    token_embeddings,
                    self.keypoint_embedding.weight[None, :, :].repeat(batch_size, 1, 1),
                ],
                dim=1,
            )
            token_augment = torch.cat(
                [
                    token_augment,
                    torch.zeros_like(token_embeddings[:, token_augment.shape[1] :, :]),
                ],
                dim=1,
            )
            if self.cfg.MODEL.DECODER.get("DO_KEYPOINT3D_TOKENS", False):
                kps3d_emb_start_idx = token_embeddings.shape[1]
                token_embeddings = torch.cat(
                    [
                        token_embeddings,
                        self.keypoint3d_embedding.weight[None, :, :].repeat(
                            batch_size, 1, 1
                        ),
                    ],
                    dim=1,
                )
                token_augment = torch.cat(
                    [
                        token_augment,
                        torch.zeros_like(
                            token_embeddings[:, token_augment.shape[1] :, :]
                        ),
                    ],
                    dim=1,
                )

        def token_to_pose_output_fn(tokens, prev_pose_output, layer_idx):
            pose_token = tokens[:, 0]

            prev_pose = init_pose.view(batch_size, -1)
            prev_camera = init_camera.view(batch_size, -1)

            pose_output = self.head_pose(pose_token, prev_pose)
            if hasattr(self, "head_camera"):
                pred_cam = self.head_camera(pose_token, prev_camera)
                pose_output["pred_cam"] = pred_cam
            pose_output = self.camera_project(pose_output, batch)

            pose_output["pred_keypoints_2d_cropped"] = self._full_to_crop(
                batch, pose_output["pred_keypoints_2d"], self.body_batch_idx
            )

            return pose_output

        kp_token_update_fn = self.keypoint_token_update_fn
        kp3d_token_update_fn = self.keypoint3d_token_update_fn

        def keypoint_token_update_fn_comb(*args):
            if kp_token_update_fn is not None:
                args = kp_token_update_fn(kps_emb_start_idx, image_embeddings, *args)
            if kp3d_token_update_fn is not None:
                args = kp3d_token_update_fn(kps3d_emb_start_idx, *args)
            return args

        pose_token, pose_output = self.decoder(
            token_embeddings,
            image_embeddings,
            token_augment,
            image_augment,
            token_mask,
            token_to_pose_output_fn=token_to_pose_output_fn,
            keypoint_token_update_fn=keypoint_token_update_fn_comb,
        )

        if self.cfg.MODEL.DECODER.get("DO_HAND_DETECT_TOKENS", False):
            return (
                pose_token[:, hand_det_emb_start_idx : hand_det_emb_start_idx + 2],
                pose_output,
            )
        else:
            return pose_token, pose_output

    def forward_decoder_hand(
        self,
        image_embeddings: torch.Tensor,
        init_estimate: Optional[torch.Tensor] = None,
        keypoints: Optional[torch.Tensor] = None,
        prev_estimate: Optional[torch.Tensor] = None,
        condition_info: Optional[torch.Tensor] = None,
        batch=None,
    ):
        batch_size = image_embeddings.shape[0]

        if init_estimate is None:
            init_pose = self.init_pose_hand.weight.expand(batch_size, -1).unsqueeze(
                dim=1
            )
            if hasattr(self, "init_camera_hand"):
                init_camera = self.init_camera_hand.weight.expand(
                    batch_size, -1
                ).unsqueeze(dim=1)

            init_estimate = (
                init_pose
                if not hasattr(self, "init_camera_hand")
                else torch.cat([init_pose, init_camera], dim=-1)
            )

        if condition_info is not None:
            init_input = torch.cat(
                [condition_info.view(batch_size, 1, -1), init_estimate], dim=-1
            )
        else:
            init_input = init_estimate
        token_embeddings = self.init_to_token_mhr_hand(init_input).view(
            batch_size, 1, -1
        )
        num_pose_token = token_embeddings.shape[1]

        image_augment, token_augment, token_mask = None, None, None
        if hasattr(self, "prompt_encoder") and keypoints is not None:
            if prev_estimate is None:
                prev_estimate = init_estimate
            prev_embeddings = self.prev_to_token_mhr_hand(prev_estimate).view(
                batch_size, 1, -1
            )

            if self.cfg.MODEL.BACKBONE.TYPE in [
                "vit_hmr",
                "vit",
                "vit_b",
                "vit_l",
            ]:
                image_augment = self.hand_pe_layer((16, 16)).unsqueeze(0)[:, :, :, 2:-2]
            elif self.cfg.MODEL.BACKBONE.TYPE in [
                "vit_hmr_512_384",
            ]:
                image_augment = self.hand_pe_layer((32, 32)).unsqueeze(0)[:, :, :, 4:-4]
            else:
                image_augment = self.hand_pe_layer(
                    image_embeddings.shape[-2:]
                ).unsqueeze(0)

            image_embeddings = self.ray_cond_emb_hand(
                image_embeddings, batch["ray_cond_hand"]
            )

            prompt_embeddings, prompt_mask = self.prompt_encoder(
                keypoints=keypoints
            )
            prompt_embeddings = self.prompt_to_token(prompt_embeddings)

            token_embeddings = torch.cat(
                [
                    token_embeddings,
                    prev_embeddings,
                    prompt_embeddings,
                ],
                dim=1,
            )

            token_augment = torch.zeros_like(token_embeddings)
            token_augment[:, [num_pose_token]] = prev_embeddings
            token_augment[:, (num_pose_token + 1) :] = prompt_embeddings
            token_mask = None

            if self.cfg.MODEL.DECODER.get("DO_HAND_DETECT_TOKENS", False):
                hand_det_emb_start_idx = token_embeddings.shape[1]
                token_embeddings = torch.cat(
                    [
                        token_embeddings,
                        self.hand_box_embedding.weight[None, :, :].repeat(
                            batch_size, 1, 1
                        ),
                    ],
                    dim=1,
                )
                token_augment = torch.cat(
                    [
                        token_augment,
                        torch.zeros_like(
                            token_embeddings[:, token_augment.shape[1] :, :]
                        ),
                    ],
                    dim=1,
                )

            assert self.cfg.MODEL.DECODER.get("DO_KEYPOINT_TOKENS", False)
            kps_emb_start_idx = token_embeddings.shape[1]
            token_embeddings = torch.cat(
                [
                    token_embeddings,
                    self.keypoint_embedding_hand.weight[None, :, :].repeat(
                        batch_size, 1, 1
                    ),
                ],
                dim=1,
            )
            token_augment = torch.cat(
                [
                    token_augment,
                    torch.zeros_like(token_embeddings[:, token_augment.shape[1] :, :]),
                ],
                dim=1,
            )

            if self.cfg.MODEL.DECODER.get("DO_KEYPOINT3D_TOKENS", False):
                kps3d_emb_start_idx = token_embeddings.shape[1]
                token_embeddings = torch.cat(
                    [
                        token_embeddings,
                        self.keypoint3d_embedding_hand.weight[None, :, :].repeat(
                            batch_size, 1, 1
                        ),
                    ],
                    dim=1,
                )
                token_augment = torch.cat(
                    [
                        token_augment,
                        torch.zeros_like(
                            token_embeddings[:, token_augment.shape[1] :, :]
                        ),
                    ],
                    dim=1,
                )

        def token_to_pose_output_fn(tokens, prev_pose_output, layer_idx):
            pose_token = tokens[:, 0]

            prev_pose = init_pose.view(batch_size, -1)
            prev_camera = init_camera.view(batch_size, -1)

            pose_output = self.head_pose_hand(pose_token, prev_pose)
            if hasattr(self, "head_camera_hand"):
                pred_cam = self.head_camera_hand(pose_token, prev_camera)
                pose_output["pred_cam"] = pred_cam
            pose_output = self.camera_project_hand(pose_output, batch)

            pose_output["pred_keypoints_2d_cropped"] = self._full_to_crop(
                batch, pose_output["pred_keypoints_2d"], self.hand_batch_idx
            )

            return pose_output

        kp_token_update_fn = self.keypoint_token_update_fn_hand
        kp3d_token_update_fn = self.keypoint3d_token_update_fn_hand

        def keypoint_token_update_fn_comb(*args):
            if kp_token_update_fn is not None:
                args = kp_token_update_fn(kps_emb_start_idx, image_embeddings, *args)
            if kp3d_token_update_fn is not None:
                args = kp3d_token_update_fn(kps3d_emb_start_idx, *args)
            return args

        pose_token, pose_output = self.decoder_hand(
            token_embeddings,
            image_embeddings,
            token_augment,
            image_augment,
            token_mask,
            token_to_pose_output_fn=token_to_pose_output_fn,
            keypoint_token_update_fn=keypoint_token_update_fn_comb,
        )

        if self.cfg.MODEL.DECODER.get("DO_HAND_DETECT_TOKENS", False):
            return (
                pose_token[:, hand_det_emb_start_idx : hand_det_emb_start_idx + 2],
                pose_output,
            )
        else:
            return pose_token, pose_output

    @torch.no_grad()
    def _get_keypoint_prompt(self, batch, pred_keypoints_2d, force_dummy=False):
        if self.camera_type == "perspective":
            pred_keypoints_2d = self._full_to_crop(batch, pred_keypoints_2d)

        gt_keypoints_2d = self._flatten_person(batch["keypoints_2d"]).clone()

        keypoint_prompt = self.keypoint_prompt_sampler.sample(
            gt_keypoints_2d,
            pred_keypoints_2d,
            is_train=self.training,
            force_dummy=force_dummy,
        )
        return keypoint_prompt

    def _get_mask_prompt(self, batch, image_embeddings):
        x_mask = self._flatten_person(batch["mask"])
        mask_embeddings, no_mask_embeddings = self.prompt_encoder.get_mask_embeddings(
            x_mask, image_embeddings.shape[0], image_embeddings.shape[2:]
        )
        if self.cfg.MODEL.BACKBONE.TYPE in [
            "vit_hmr",
            "vit",
        ]:
            mask_embeddings = mask_embeddings[:, :, :, 2:-2]
        elif self.cfg.MODEL.BACKBONE.TYPE in [
            "vit_hmr_512_384",
        ]:
            mask_embeddings = mask_embeddings[:, :, :, 4:-4]

        mask_score = self._flatten_person(batch["mask_score"]).view(-1, 1, 1, 1)
        mask_embeddings = torch.where(
            mask_score > 0,
            mask_score * mask_embeddings.to(image_embeddings),
            no_mask_embeddings.to(image_embeddings),
        )
        return mask_embeddings

    def _one_prompt_iter(self, batch, output, prev_prompt, full_output):
        image_embeddings = output["image_embeddings"]
        condition_info = output["condition_info"]

        if "mhr" in output and output["mhr"] is not None:
            pose_output = output["mhr"]
            prev_estimate = torch.cat(
                [
                    pose_output["pred_pose_raw"].detach(),
                    pose_output["shape"].detach(),
                    pose_output["scale"].detach(),
                    pose_output["hand"].detach(),
                    pose_output["face"].detach(),
                ],
                dim=1,
            ).unsqueeze(dim=1)
            if hasattr(self, "init_camera"):
                prev_estimate = torch.cat(
                    [prev_estimate, pose_output["pred_cam"].detach().unsqueeze(1)],
                    dim=-1,
                )
            prev_shape = prev_estimate.shape[1:]

            pred_keypoints_2d = output["mhr"]["pred_keypoints_2d"].detach().clone()
            kpt_shape = pred_keypoints_2d.shape[1:]

        if "mhr_hand" in output and output["mhr_hand"] is not None:
            pose_output_hand = output["mhr_hand"]
            prev_estimate_hand = torch.cat(
                [
                    pose_output_hand["pred_pose_raw"].detach(),
                    pose_output_hand["shape"].detach(),
                    pose_output_hand["scale"].detach(),
                    pose_output_hand["hand"].detach(),
                    pose_output_hand["face"].detach(),
                ],
                dim=1,
            ).unsqueeze(dim=1)
            if hasattr(self, "init_camera_hand"):
                prev_estimate_hand = torch.cat(
                    [
                        prev_estimate_hand,
                        pose_output_hand["pred_cam"].detach().unsqueeze(1),
                    ],
                    dim=-1,
                )
            prev_shape = prev_estimate_hand.shape[1:]

            pred_keypoints_2d_hand = (
                output["mhr_hand"]["pred_keypoints_2d"].detach().clone()
            )
            kpt_shape = pred_keypoints_2d_hand.shape[1:]

        all_prev_estimate = torch.zeros(
            (image_embeddings.shape[0], *prev_shape), device=image_embeddings.device,
            dtype=image_embeddings.dtype,
        )
        if "mhr" in output and output["mhr"] is not None:
            all_prev_estimate[self.body_batch_idx] = prev_estimate
        if "mhr_hand" in output and output["mhr_hand"] is not None:
            all_prev_estimate[self.hand_batch_idx] = prev_estimate_hand

        all_pred_keypoints_2d = torch.zeros(
            (image_embeddings.shape[0], *kpt_shape), device=image_embeddings.device,
            dtype=image_embeddings.dtype,
        )
        if "mhr" in output and output["mhr"] is not None:
            all_pred_keypoints_2d[self.body_batch_idx] = pred_keypoints_2d
        if "mhr_hand" in output and output["mhr_hand"] is not None:
            all_pred_keypoints_2d[self.hand_batch_idx] = pred_keypoints_2d_hand

        keypoint_prompt = self._get_keypoint_prompt(batch, all_pred_keypoints_2d)
        if len(prev_prompt):
            cur_keypoint_prompt = torch.cat(prev_prompt + [keypoint_prompt], dim=1)
        else:
            cur_keypoint_prompt = keypoint_prompt

        pose_output, pose_output_hand = None, None
        if len(self.body_batch_idx):
            tokens_output, pose_output = self.forward_decoder(
                image_embeddings[self.body_batch_idx],
                init_estimate=None,
                keypoints=cur_keypoint_prompt[self.body_batch_idx],
                prev_estimate=all_prev_estimate[self.body_batch_idx],
                condition_info=condition_info[self.body_batch_idx],
                batch=batch,
            )
            pose_output = pose_output[-1]

        output.update(
            {
                "mhr": pose_output,
                "mhr_hand": pose_output_hand,
            }
        )

        return output, keypoint_prompt

    def _full_to_crop(
        self,
        batch: Dict,
        pred_keypoints_2d: torch.Tensor,
        batch_idx: torch.Tensor = None,
    ) -> torch.Tensor:
        """Convert full-image keypoints coordinates to crop and normalize to [-0.5, 0.5]"""
        pred_keypoints_2d_cropped = torch.cat(
            [pred_keypoints_2d, torch.ones_like(pred_keypoints_2d[:, :, [-1]])], dim=-1
        )
        if batch_idx is not None:
            affine_trans = self._flatten_person(batch["affine_trans"])[batch_idx].to(
                pred_keypoints_2d_cropped
            )
            img_size = self._flatten_person(batch["img_size"])[batch_idx].unsqueeze(1)
        else:
            affine_trans = self._flatten_person(batch["affine_trans"]).to(
                pred_keypoints_2d_cropped
            )
            img_size = self._flatten_person(batch["img_size"]).unsqueeze(1)
        pred_keypoints_2d_cropped = pred_keypoints_2d_cropped @ affine_trans.mT
        pred_keypoints_2d_cropped = pred_keypoints_2d_cropped[..., :2] / img_size - 0.5

        return pred_keypoints_2d_cropped

    def camera_project(self, pose_output: Dict, batch: Dict) -> Dict:
        if hasattr(self, "head_camera"):
            head_camera = self.head_camera
            pred_cam = pose_output["pred_cam"]
        else:
            assert False

        cam_out = head_camera.perspective_projection(
            pose_output["pred_keypoints_3d"],
            pred_cam,
            self._flatten_person(batch["bbox_center"])[self.body_batch_idx],
            self._flatten_person(batch["bbox_scale"])[self.body_batch_idx, 0],
            self._flatten_person(batch["ori_img_size"])[self.body_batch_idx],
            self._flatten_person(
                batch["cam_int"]
                .unsqueeze(1)
                .expand(-1, batch["img"].shape[1], -1, -1)
                .contiguous()
            )[self.body_batch_idx],
            use_intrin_center=self.cfg.MODEL.DECODER.get("USE_INTRIN_CENTER", False),
        )

        if pose_output.get("pred_vertices", None) is not None:
            cam_out_vertices = head_camera.perspective_projection(
                pose_output["pred_vertices"],
                pred_cam,
                self._flatten_person(batch["bbox_center"])[self.body_batch_idx],
                self._flatten_person(batch["bbox_scale"])[self.body_batch_idx, 0],
                self._flatten_person(batch["ori_img_size"])[self.body_batch_idx],
                self._flatten_person(
                    batch["cam_int"]
                    .unsqueeze(1)
                    .expand(-1, batch["img"].shape[1], -1, -1)
                    .contiguous()
                )[self.body_batch_idx],
                use_intrin_center=self.cfg.MODEL.DECODER.get(
                    "USE_INTRIN_CENTER", False
                ),
            )
            pose_output["pred_keypoints_2d_verts"] = cam_out_vertices[
                "pred_keypoints_2d"
            ]

        pose_output.update(cam_out)

        return pose_output

    def camera_project_hand(self, pose_output: Dict, batch: Dict) -> Dict:
        if hasattr(self, "head_camera_hand"):
            head_camera = self.head_camera_hand
            pred_cam = pose_output["pred_cam"]
        else:
            assert False

        cam_out = head_camera.perspective_projection(
            pose_output["pred_keypoints_3d"],
            pred_cam,
            self._flatten_person(batch["bbox_center"])[self.hand_batch_idx],
            self._flatten_person(batch["bbox_scale"])[self.hand_batch_idx, 0],
            self._flatten_person(batch["ori_img_size"])[self.hand_batch_idx],
            self._flatten_person(
                batch["cam_int"]
                .unsqueeze(1)
                .expand(-1, batch["img"].shape[1], -1, -1)
                .contiguous()
            )[self.hand_batch_idx],
            use_intrin_center=self.cfg.MODEL.DECODER.get("USE_INTRIN_CENTER", False),
        )

        if pose_output.get("pred_vertices", None) is not None:
            cam_out_vertices = head_camera.perspective_projection(
                pose_output["pred_vertices"],
                pred_cam,
                self._flatten_person(batch["bbox_center"])[self.hand_batch_idx],
                self._flatten_person(batch["bbox_scale"])[self.hand_batch_idx, 0],
                self._flatten_person(batch["ori_img_size"])[self.hand_batch_idx],
                self._flatten_person(
                    batch["cam_int"]
                    .unsqueeze(1)
                    .expand(-1, batch["img"].shape[1], -1, -1)
                    .contiguous()
                )[self.hand_batch_idx],
                use_intrin_center=self.cfg.MODEL.DECODER.get(
                    "USE_INTRIN_CENTER", False
                ),
            )
            pose_output["pred_keypoints_2d_verts"] = cam_out_vertices[
                "pred_keypoints_2d"
            ]

        pose_output.update(cam_out)

        return pose_output

    def get_ray_condition(self, batch):
        B, N, _, H, W = batch["img"].shape
        meshgrid_xy = (
            torch.stack(
                torch.meshgrid(torch.arange(H), torch.arange(W), indexing="xy"), dim=2
            )[None, None, :, :, :]
            .repeat(B, N, 1, 1, 1)
            .to(device=self.image_mean.device, dtype=self.get_dtype())
        )
        meshgrid_xy = (
            meshgrid_xy / batch["affine_trans"][:, :, None, None, [0, 1], [0, 1]]
        )
        meshgrid_xy = (
            meshgrid_xy
            - batch["affine_trans"][:, :, None, None, [0, 1], [2, 2]]
            / batch["affine_trans"][:, :, None, None, [0, 1], [0, 1]]
        )

        meshgrid_xy = (
            meshgrid_xy - batch["cam_int"][:, None, None, None, [0, 1], [2, 2]]
        )
        meshgrid_xy = (
            meshgrid_xy / batch["cam_int"][:, None, None, None, [0, 1], [0, 1]]
        )

        return meshgrid_xy.permute(0, 1, 4, 2, 3)

    def forward_pose_branch(self, batch: Dict) -> Dict:
        """Run a forward pass for the crop-image (pose) branch."""
        # Cast batch tensors to model dtype at boundary (native ComfyUI pattern).
        # Batch data arrives as fp32 from numpy; model weights may be bf16/fp16.
        dtype = self.get_dtype()
        for key in list(batch.keys()):
            v = batch[key]
            if isinstance(v, torch.Tensor) and v.is_floating_point():
                batch[key] = v.to(dtype=dtype)

        batch_size, num_person = batch["img"].shape[:2]

        # Forward backbone encoder
        x = self.data_preprocess(
            self._flatten_person(batch["img"]),
            crop_width=(
                self.cfg.MODEL.BACKBONE.TYPE
                in [
                    "vit_hmr",
                    "vit",
                    "vit_b",
                    "vit_l",
                    "vit_hmr_512_384",
                ]
            ),
        )

        # Optionally get ray conditioning
        ray_cond = self.get_ray_condition(batch)
        ray_cond = self._flatten_person(ray_cond)
        if self.cfg.MODEL.BACKBONE.TYPE in [
            "vit_hmr",
            "vit",
            "vit_b",
            "vit_l",
        ]:
            ray_cond = ray_cond[:, :, :, 32:-32]
        elif self.cfg.MODEL.BACKBONE.TYPE in [
            "vit_hmr_512_384",
        ]:
            ray_cond = ray_cond[:, :, :, 64:-64]

        if len(self.body_batch_idx):
            batch["ray_cond"] = ray_cond[self.body_batch_idx].clone()
        if len(self.hand_batch_idx):
            batch["ray_cond_hand"] = ray_cond[self.hand_batch_idx].clone()
        ray_cond = None

        # Fix B: removed manual dtype casting — operations system handles it
        image_embeddings = self.backbone(x, extra_embed=ray_cond)

        if isinstance(image_embeddings, tuple):
            image_embeddings = image_embeddings[-1]

        # Mask condition if available
        if self.cfg.MODEL.PROMPT_ENCODER.get("MASK_EMBED_TYPE", None) is not None:
            if self.cfg.MODEL.PROMPT_ENCODER.get("MASK_PROMPT", "v1") == "v1":
                mask_embeddings = self._get_mask_prompt(batch, image_embeddings)
                image_embeddings = image_embeddings + mask_embeddings
            else:
                raise NotImplementedError

        # Prepare input for promptable decoder
        condition_info = self._get_decoder_condition(batch)

        # Initial estimate with a dummy prompt
        keypoints_prompt = torch.zeros((batch_size * num_person, 1, 3)).to(batch["img"])
        keypoints_prompt[:, :, -1] = -2

        # Forward promptable decoder to get updated pose tokens and regression output
        pose_output, pose_output_hand = None, None
        if len(self.body_batch_idx):
            tokens_output, pose_output = self.forward_decoder(
                image_embeddings[self.body_batch_idx],
                init_estimate=None,
                keypoints=keypoints_prompt[self.body_batch_idx],
                prev_estimate=None,
                condition_info=condition_info[self.body_batch_idx],
                batch=batch,
            )
            pose_output = pose_output[-1]
        if len(self.hand_batch_idx):
            tokens_output_hand, pose_output_hand = self.forward_decoder_hand(
                image_embeddings[self.hand_batch_idx],
                init_estimate=None,
                keypoints=keypoints_prompt[self.hand_batch_idx],
                prev_estimate=None,
                condition_info=condition_info[self.hand_batch_idx],
                batch=batch,
            )
            pose_output_hand = pose_output_hand[-1]

        output = {
            "mhr": pose_output,
            "mhr_hand": pose_output_hand,
            "condition_info": condition_info,
            "image_embeddings": image_embeddings,
        }

        if self.cfg.MODEL.DECODER.get("DO_HAND_DETECT_TOKENS", False):
            if len(self.body_batch_idx):
                output_hand_box_tokens = tokens_output
                hand_coords = self.bbox_embed(
                    output_hand_box_tokens
                ).sigmoid()
                hand_logits = self.hand_cls_embed(output_hand_box_tokens)

                output["mhr"]["hand_box"] = hand_coords
                output["mhr"]["hand_logits"] = hand_logits

            if len(self.hand_batch_idx):
                output_hand_box_tokens_hand_batch = tokens_output_hand

                hand_coords_hand_batch = self.bbox_embed(
                    output_hand_box_tokens_hand_batch
                ).sigmoid()
                hand_logits_hand_batch = self.hand_cls_embed(
                    output_hand_box_tokens_hand_batch
                )

                output["mhr_hand"]["hand_box"] = hand_coords_hand_batch
                output["mhr_hand"]["hand_logits"] = hand_logits_hand_batch

        return output

    def forward_step(
        self, batch: Dict, decoder_type: str = "body"
    ) -> Tuple[Dict, Dict]:
        batch_size, num_person = batch["img"].shape[:2]

        if decoder_type == "body":
            self.hand_batch_idx = []
            self.body_batch_idx = list(range(batch_size * num_person))
        elif decoder_type == "hand":
            self.hand_batch_idx = list(range(batch_size * num_person))
            self.body_batch_idx = []
        else:
            ValueError("Invalid decoder type: ", decoder_type)

        # Crop-image (pose) branch
        pose_output = self.forward_pose_branch(batch)

        return pose_output

    def run_inference(
        self,
        img,
        batch: Dict,
        inference_type: str = "full",
        transform_hand: Any = None,
        thresh_wrist_angle=1.4,
    ):
        height, width = img.shape[:2]
        cam_int = batch["cam_int"].clone()

        if inference_type == "body":
            pose_output = self.forward_step(batch, decoder_type="body")
            return pose_output
        elif inference_type == "hand":
            pose_output = self.forward_step(batch, decoder_type="hand")
            return pose_output
        elif not inference_type == "full":
            ValueError("Invalid inference type: ", inference_type)

        # Step 1. For full-body inference, we first inference with the body decoder.
        pose_output = self.forward_step(batch, decoder_type="body")
        left_xyxy, right_xyxy = self._get_hand_box(pose_output, batch)
        ori_local_wrist_rotmat = roma.euler_to_rotmat(
            "XZY",
            pose_output["mhr"]["body_pose"][:, [41, 43, 42, 31, 33, 32]].unflatten(
                1, (2, 3)
            ),
        )

        # Step 2. Re-run with each hand
        ## Left... Flip image & box
        flipped_img = img[:, ::-1]
        tmp = left_xyxy.copy()
        left_xyxy[:, 0] = width - tmp[:, 2] - 1
        left_xyxy[:, 2] = width - tmp[:, 0] - 1

        batch_lhand = prepare_batch(
            flipped_img, transform_hand, left_xyxy, cam_int=cam_int.clone()
        )
        batch_lhand = recursive_to(batch_lhand, self.image_mean.device)
        lhand_output = self.forward_step(batch_lhand, decoder_type="hand")

        # Unflip output
        ## Flip scale
        ### Get MHR values
        scale_r_hands_mean = self.head_pose.scale_mean[8].item()
        scale_l_hands_mean = self.head_pose.scale_mean[9].item()
        scale_r_hands_std = self.head_pose.scale_comps[8, 8].item()
        scale_l_hands_std = self.head_pose.scale_comps[9, 9].item()
        ### Apply
        lhand_output["mhr_hand"]["scale"][:, 9] = (
            (
                scale_r_hands_mean
                + scale_r_hands_std * lhand_output["mhr_hand"]["scale"][:, 8]
            )
            - scale_l_hands_mean
        ) / scale_l_hands_std
        ## Get the right hand global rotation, flip it, put it in as left.
        lhand_output["mhr_hand"]["joint_global_rots"][:, 78] = lhand_output["mhr_hand"][
            "joint_global_rots"
        ][:, 42].clone()
        lhand_output["mhr_hand"]["joint_global_rots"][:, 78, [1, 2], :] *= -1
        ### Flip hand pose
        lhand_output["mhr_hand"]["hand"][:, :54] = lhand_output["mhr_hand"]["hand"][
            :, 54:
        ]
        ### Unflip box
        batch_lhand["bbox_center"][:, :, 0] = (
            width - batch_lhand["bbox_center"][:, :, 0] - 1
        )

        ## Right...
        batch_rhand = prepare_batch(
            img, transform_hand, right_xyxy, cam_int=cam_int.clone()
        )
        batch_rhand = recursive_to(batch_rhand, self.image_mean.device)
        rhand_output = self.forward_step(batch_rhand, decoder_type="hand")

        # Step 3. replace hand pose estimation from the body decoder.
        ## CRITERIA 1: LOCAL WRIST POSE DIFFERENCE
        joint_rotations = pose_output["mhr"]["joint_global_rots"]
        ### Get lowarm
        lowarm_joint_idxs = torch.LongTensor([76, 40]).to(self.image_mean.device)
        lowarm_joint_rotations = joint_rotations[:, lowarm_joint_idxs]
        ### Get zero-wrist pose
        wrist_twist_joint_idxs = torch.LongTensor([77, 41]).to(self.image_mean.device)
        wrist_zero_rot_pose = (
            lowarm_joint_rotations
            @ self.head_pose.joint_rotation[wrist_twist_joint_idxs]
        )
        ### Get globals from left & right
        left_joint_global_rots = lhand_output["mhr_hand"]["joint_global_rots"]
        right_joint_global_rots = rhand_output["mhr_hand"]["joint_global_rots"]
        pred_global_wrist_rotmat = torch.stack(
            [
                left_joint_global_rots[:, 78],
                right_joint_global_rots[:, 42],
            ],
            dim=1,
        )
        ### Get the local poses that lead to the wrist being pred_global_wrist_rotmat
        fused_local_wrist_rotmat = torch.einsum(
            "kabc,kabd->kadc", pred_global_wrist_rotmat, wrist_zero_rot_pose
        )
        angle_difference = rotation_angle_difference(
            ori_local_wrist_rotmat, fused_local_wrist_rotmat
        )
        angle_difference_valid_mask = angle_difference < thresh_wrist_angle

        ## CRITERIA 2: hand box size
        hand_box_size_thresh = 64
        hand_box_size_valid_mask = torch.stack(
            [
                (batch_lhand["bbox_scale"].flatten(0, 1) > hand_box_size_thresh).all(
                    dim=1
                ),
                (batch_rhand["bbox_scale"].flatten(0, 1) > hand_box_size_thresh).all(
                    dim=1
                ),
            ],
            dim=1,
        )

        ## CRITERIA 3: all hand 2D KPS (including wrist) inside of box.
        hand_kps2d_thresh = 0.5
        hand_kps2d_valid_mask = torch.stack(
            [
                lhand_output["mhr_hand"]["pred_keypoints_2d_cropped"]
                .abs()
                .amax(dim=(1, 2))
                < hand_kps2d_thresh,
                rhand_output["mhr_hand"]["pred_keypoints_2d_cropped"]
                .abs()
                .amax(dim=(1, 2))
                < hand_kps2d_thresh,
            ],
            dim=1,
        )

        ## CRITERIA 4: 2D wrist distance.
        hand_wrist_kps2d_thresh = 0.25
        kps_right_wrist_idx = 41
        kps_left_wrist_idx = 62
        right_kps_full = rhand_output["mhr_hand"]["pred_keypoints_2d"][
            :, [kps_right_wrist_idx]
        ].clone()
        left_kps_full = lhand_output["mhr_hand"]["pred_keypoints_2d"][
            :, [kps_right_wrist_idx]
        ].clone()
        left_kps_full[:, :, 0] = width - left_kps_full[:, :, 0] - 1
        body_right_kps_full = pose_output["mhr"]["pred_keypoints_2d"][
            :, [kps_right_wrist_idx]
        ].clone()
        body_left_kps_full = pose_output["mhr"]["pred_keypoints_2d"][
            :, [kps_left_wrist_idx]
        ].clone()
        right_kps_dist = (right_kps_full - body_right_kps_full).flatten(0, 1).norm(
            dim=-1
        ) / batch_lhand["bbox_scale"].flatten(0, 1)[:, 0]
        left_kps_dist = (left_kps_full - body_left_kps_full).flatten(0, 1).norm(
            dim=-1
        ) / batch_rhand["bbox_scale"].flatten(0, 1)[:, 0]
        hand_wrist_kps2d_valid_mask = torch.stack(
            [
                left_kps_dist < hand_wrist_kps2d_thresh,
                right_kps_dist < hand_wrist_kps2d_thresh,
            ],
            dim=1,
        )
        ## Left-right
        hand_valid_mask = (
            angle_difference_valid_mask
            & hand_box_size_valid_mask
            & hand_kps2d_valid_mask
            & hand_wrist_kps2d_valid_mask
        )

        # Keypoint prompting with the body decoder.
        batch_size, num_person = batch["img"].shape[:2]
        self.hand_batch_idx = []
        self.body_batch_idx = list(range(batch_size * num_person))

        ## Get right & left wrist keypoints from crops; full image. Each are B x 1 x 2
        kps_right_wrist_idx = 41
        kps_left_wrist_idx = 62
        right_kps_full = rhand_output["mhr_hand"]["pred_keypoints_2d"][
            :, [kps_right_wrist_idx]
        ].clone()
        left_kps_full = lhand_output["mhr_hand"]["pred_keypoints_2d"][
            :, [kps_right_wrist_idx]
        ].clone()
        left_kps_full[:, :, 0] = width - left_kps_full[:, :, 0] - 1

        # Next, get them to crop-normalized space.
        right_kps_crop = self._full_to_crop(batch, right_kps_full)
        left_kps_crop = self._full_to_crop(batch, left_kps_full)

        # Get right & left elbow keypoints from crops; full image. Each are B x 1 x 2
        kps_right_elbow_idx = 8
        kps_left_elbow_idx = 7
        right_kps_elbow_full = pose_output["mhr"]["pred_keypoints_2d"][
            :, [kps_right_elbow_idx]
        ].clone()
        left_kps_elbow_full = pose_output["mhr"]["pred_keypoints_2d"][
            :, [kps_left_elbow_idx]
        ].clone()

        # Next, get them to crop-normalized space.
        right_kps_elbow_crop = self._full_to_crop(batch, right_kps_elbow_full)
        left_kps_elbow_crop = self._full_to_crop(batch, left_kps_elbow_full)

        # Assemble them into keypoint prompts
        keypoint_prompt = torch.cat(
            [right_kps_crop, left_kps_crop, right_kps_elbow_crop, left_kps_elbow_crop],
            dim=1,
        )
        keypoint_prompt = torch.cat(
            [keypoint_prompt, keypoint_prompt[..., [-1]]], dim=-1
        )
        keypoint_prompt[:, 0, -1] = kps_right_wrist_idx
        keypoint_prompt[:, 1, -1] = kps_left_wrist_idx
        keypoint_prompt[:, 2, -1] = kps_right_elbow_idx
        keypoint_prompt[:, 3, -1] = kps_left_elbow_idx

        if keypoint_prompt.shape[0] > 1:
            # Replace invalid keypoints to dummy prompts
            invalid_prompt = (
                (keypoint_prompt[..., 0] < -0.5)
                | (keypoint_prompt[..., 0] > 0.5)
                | (keypoint_prompt[..., 1] < -0.5)
                | (keypoint_prompt[..., 1] > 0.5)
                | (~hand_valid_mask[..., [1, 0, 1, 0]])
            ).unsqueeze(-1)
            dummy_prompt = torch.zeros((1, 1, 3)).to(keypoint_prompt)
            dummy_prompt[:, :, -1] = -2
            keypoint_prompt[:, :, :2] = torch.clamp(
                keypoint_prompt[:, :, :2] + 0.5, min=0.0, max=1.0
            )
            keypoint_prompt = torch.where(invalid_prompt, dummy_prompt, keypoint_prompt)
        else:
            # Only keep valid keypoints
            valid_keypoint = (
                torch.all(
                    (keypoint_prompt[:, :, :2] > -0.5)
                    & (keypoint_prompt[:, :, :2] < 0.5),
                    dim=2,
                )
                & hand_valid_mask[..., [1, 0, 1, 0]]
            ).squeeze()
            keypoint_prompt = keypoint_prompt[:, valid_keypoint]
            keypoint_prompt[:, :, :2] = torch.clamp(
                keypoint_prompt[:, :, :2] + 0.5, min=0.0, max=1.0
            )

        if keypoint_prompt.numel() != 0:
            pose_output, _ = self.run_keypoint_prompt(
                batch, pose_output, keypoint_prompt
            )

        ##############################################################################

        # Drop in hand pose
        left_hand_pose_params = lhand_output["mhr_hand"]["hand"][:, :54]
        right_hand_pose_params = rhand_output["mhr_hand"]["hand"][:, 54:]
        updated_hand_pose = torch.cat(
            [left_hand_pose_params, right_hand_pose_params], dim=1
        )

        # Drop in hand scales
        updated_scale = pose_output["mhr"]["scale"].clone()
        updated_scale[:, 9] = lhand_output["mhr_hand"]["scale"][:, 9]
        updated_scale[:, 8] = rhand_output["mhr_hand"]["scale"][:, 8]
        updated_scale[:, 18:] = (
            lhand_output["mhr_hand"]["scale"][:, 18:]
            + rhand_output["mhr_hand"]["scale"][:, 18:]
        ) / 2

        # Update hand shape
        updated_shape = pose_output["mhr"]["shape"].clone()
        updated_shape[:, 40:] = (
            lhand_output["mhr_hand"]["shape"][:, 40:]
            + rhand_output["mhr_hand"]["shape"][:, 40:]
        ) / 2

        ############################ Doing IK ############################

        # First, forward just FK
        joint_rotations = self.head_pose.mhr_forward(
            global_trans=pose_output["mhr"]["global_rot"] * 0,
            global_rot=pose_output["mhr"]["global_rot"],
            body_pose_params=pose_output["mhr"]["body_pose"],
            hand_pose_params=updated_hand_pose,
            scale_params=updated_scale,
            shape_params=updated_shape,
            expr_params=pose_output["mhr"]["face"],
            return_joint_rotations=True,
        )[1]

        # Get lowarm
        lowarm_joint_idxs = torch.LongTensor([76, 40]).to(self.image_mean.device)
        lowarm_joint_rotations = joint_rotations[:, lowarm_joint_idxs]

        # Get zero-wrist pose
        wrist_twist_joint_idxs = torch.LongTensor([77, 41]).to(self.image_mean.device)
        wrist_zero_rot_pose = (
            lowarm_joint_rotations
            @ self.head_pose.joint_rotation[wrist_twist_joint_idxs]
        )

        # Get globals from left & right
        left_joint_global_rots = lhand_output["mhr_hand"]["joint_global_rots"]
        right_joint_global_rots = rhand_output["mhr_hand"]["joint_global_rots"]
        pred_global_wrist_rotmat = torch.stack(
            [
                left_joint_global_rots[:, 78],
                right_joint_global_rots[:, 42],
            ],
            dim=1,
        )

        # Now we want to get the local poses that lead to the wrist being pred_global_wrist_rotmat
        fused_local_wrist_rotmat = torch.einsum(
            "kabc,kabd->kadc", pred_global_wrist_rotmat, wrist_zero_rot_pose
        )
        wrist_xzy = fix_wrist_euler(
            roma.rotmat_to_euler("XZY", fused_local_wrist_rotmat)
        )

        # Put it in.
        angle_difference = rotation_angle_difference(
            ori_local_wrist_rotmat, fused_local_wrist_rotmat
        )
        valid_angle = angle_difference < thresh_wrist_angle
        valid_angle = valid_angle & hand_valid_mask
        valid_angle = valid_angle.unsqueeze(-1)

        body_pose = pose_output["mhr"]["body_pose"][
            :, [41, 43, 42, 31, 33, 32]
        ].unflatten(1, (2, 3))
        updated_body_pose = torch.where(valid_angle, wrist_xzy, body_pose)
        pose_output["mhr"]["body_pose"][:, [41, 43, 42, 31, 33, 32]] = (
            updated_body_pose.flatten(1, 2)
        )

        hand_pose = pose_output["mhr"]["hand"].unflatten(1, (2, 54))
        pose_output["mhr"]["hand"] = torch.where(
            valid_angle, updated_hand_pose.unflatten(1, (2, 54)), hand_pose
        ).flatten(1, 2)

        hand_scale = torch.stack(
            [pose_output["mhr"]["scale"][:, 9], pose_output["mhr"]["scale"][:, 8]],
            dim=1,
        )
        updated_hand_scale = torch.stack(
            [updated_scale[:, 9], updated_scale[:, 8]], dim=1
        )
        masked_hand_scale = torch.where(
            valid_angle.squeeze(-1), updated_hand_scale, hand_scale
        )
        pose_output["mhr"]["scale"][:, 9] = masked_hand_scale[:, 0]
        pose_output["mhr"]["scale"][:, 8] = masked_hand_scale[:, 1]

        # Replace shared shape and scale
        pose_output["mhr"]["scale"][:, 18:] = torch.where(
            valid_angle.squeeze(-1).sum(dim=1, keepdim=True) > 0,
            (
                lhand_output["mhr_hand"]["scale"][:, 18:]
                * valid_angle.squeeze(-1)[:, [0]]
                + rhand_output["mhr_hand"]["scale"][:, 18:]
                * valid_angle.squeeze(-1)[:, [1]]
            )
            / (valid_angle.squeeze(-1).sum(dim=1, keepdim=True) + 1e-8),
            pose_output["mhr"]["scale"][:, 18:],
        )
        pose_output["mhr"]["shape"][:, 40:] = torch.where(
            valid_angle.squeeze(-1).sum(dim=1, keepdim=True) > 0,
            (
                lhand_output["mhr_hand"]["shape"][:, 40:]
                * valid_angle.squeeze(-1)[:, [0]]
                + rhand_output["mhr_hand"]["shape"][:, 40:]
                * valid_angle.squeeze(-1)[:, [1]]
            )
            / (valid_angle.squeeze(-1).sum(dim=1, keepdim=True) + 1e-8),
            pose_output["mhr"]["shape"][:, 40:],
        )

        ########################################################

        # Re-run forward
        with torch.no_grad():
            verts, j3d, jcoords, mhr_model_params, joint_global_rots = (
                self.head_pose.mhr_forward(
                    global_trans=pose_output["mhr"]["global_rot"] * 0,
                    global_rot=pose_output["mhr"]["global_rot"],
                    body_pose_params=pose_output["mhr"]["body_pose"],
                    hand_pose_params=pose_output["mhr"]["hand"],
                    scale_params=pose_output["mhr"]["scale"],
                    shape_params=pose_output["mhr"]["shape"],
                    expr_params=pose_output["mhr"]["face"],
                    return_keypoints=True,
                    return_joint_coords=True,
                    return_model_params=True,
                    return_joint_rotations=True,
                )
            )
            j3d = j3d[:, :70]
            verts[..., [1, 2]] *= -1
            j3d[..., [1, 2]] *= -1
            jcoords[..., [1, 2]] *= -1
            pose_output["mhr"]["pred_keypoints_3d"] = j3d
            pose_output["mhr"]["pred_vertices"] = verts
            pose_output["mhr"]["pred_joint_coords"] = jcoords
            pose_output["mhr"]["pred_pose_raw"][
                ...
            ] = 0  # pred_pose_raw is not valid anymore
            pose_output["mhr"]["mhr_model_params"] = mhr_model_params

        ########################################################
        # Project to 2D
        pred_keypoints_3d_proj = (
            pose_output["mhr"]["pred_keypoints_3d"]
            + pose_output["mhr"]["pred_cam_t"][:, None, :]
        )
        pred_keypoints_3d_proj[:, :, [0, 1]] *= pose_output["mhr"]["focal_length"][
            :, None, None
        ]
        pred_keypoints_3d_proj[:, :, [0, 1]] = (
            pred_keypoints_3d_proj[:, :, [0, 1]]
            + torch.FloatTensor([width / 2, height / 2]).to(pred_keypoints_3d_proj)[
                None, None, :
            ]
            * pred_keypoints_3d_proj[:, :, [2]]
        )
        pred_keypoints_3d_proj[:, :, :2] = (
            pred_keypoints_3d_proj[:, :, :2] / pred_keypoints_3d_proj[:, :, [2]]
        )
        pose_output["mhr"]["pred_keypoints_2d"] = pred_keypoints_3d_proj[:, :, :2]

        return pose_output, batch_lhand, batch_rhand, lhand_output, rhand_output

    def run_keypoint_prompt(self, batch, output, keypoint_prompt):
        image_embeddings = output["image_embeddings"]
        condition_info = output["condition_info"]
        pose_output = output["mhr"]  # body-only output
        # Use previous estimate as initialization
        prev_estimate = torch.cat(
            [
                pose_output["pred_pose_raw"].detach(),
                pose_output["shape"].detach(),
                pose_output["scale"].detach(),
                pose_output["hand"].detach(),
                pose_output["face"].detach(),
            ],
            dim=1,
        ).unsqueeze(dim=1)
        if hasattr(self, "init_camera"):
            prev_estimate = torch.cat(
                [prev_estimate, pose_output["pred_cam"].detach().unsqueeze(1)],
                dim=-1,
            )

        tokens_output, pose_output = self.forward_decoder(
            image_embeddings,
            init_estimate=None,
            keypoints=keypoint_prompt,
            prev_estimate=prev_estimate,
            condition_info=condition_info,
            batch=batch,
        )
        pose_output = pose_output[-1]

        output.update({"mhr": pose_output})
        return output, keypoint_prompt

    def _get_hand_box(self, pose_output, batch):
        """Get hand bbox from the hand detector"""
        pred_left_hand_box = (
            pose_output["mhr"]["hand_box"][:, 0].detach().cpu().float().numpy()
            * self.cfg.MODEL.IMAGE_SIZE[0]
        )
        pred_right_hand_box = (
            pose_output["mhr"]["hand_box"][:, 1].detach().cpu().float().numpy()
            * self.cfg.MODEL.IMAGE_SIZE[0]
        )

        # Change boxes into squares
        batch["left_center"] = pred_left_hand_box[:, :2]
        batch["left_scale"] = (
            pred_left_hand_box[:, 2:].max(axis=1, keepdims=True).repeat(2, axis=1)
        )
        batch["right_center"] = pred_right_hand_box[:, :2]
        batch["right_scale"] = (
            pred_right_hand_box[:, 2:].max(axis=1, keepdims=True).repeat(2, axis=1)
        )

        # Crop to full. batch["affine_trans"] is full-to-crop, right application
        affine = batch["affine_trans"].float()
        batch["left_scale"] = (
            batch["left_scale"]
            / affine[0, :, 0, 0].cpu().numpy()[:, None]
        )
        batch["right_scale"] = (
            batch["right_scale"]
            / affine[0, :, 0, 0].cpu().numpy()[:, None]
        )
        batch["left_center"] = (
            batch["left_center"]
            - affine[0, :, [0, 1], [2, 2]].cpu().numpy()
        ) / affine[0, :, 0, 0].cpu().numpy()[:, None]
        batch["right_center"] = (
            batch["right_center"]
            - affine[0, :, [0, 1], [2, 2]].cpu().numpy()
        ) / affine[0, :, 0, 0].cpu().numpy()[:, None]

        left_xyxy = np.concatenate(
            [
                (
                    batch["left_center"][:, 0] - batch["left_scale"][:, 0] * 1 / 2
                ).reshape(-1, 1),
                (
                    batch["left_center"][:, 1] - batch["left_scale"][:, 1] * 1 / 2
                ).reshape(-1, 1),
                (
                    batch["left_center"][:, 0] + batch["left_scale"][:, 0] * 1 / 2
                ).reshape(-1, 1),
                (
                    batch["left_center"][:, 1] + batch["left_scale"][:, 1] * 1 / 2
                ).reshape(-1, 1),
            ],
            axis=1,
        )
        right_xyxy = np.concatenate(
            [
                (
                    batch["right_center"][:, 0] - batch["right_scale"][:, 0] * 1 / 2
                ).reshape(-1, 1),
                (
                    batch["right_center"][:, 1] - batch["right_scale"][:, 1] * 1 / 2
                ).reshape(-1, 1),
                (
                    batch["right_center"][:, 0] + batch["right_scale"][:, 0] * 1 / 2
                ).reshape(-1, 1),
                (
                    batch["right_center"][:, 1] + batch["right_scale"][:, 1] * 1 / 2
                ).reshape(-1, 1),
            ],
            axis=1,
        )

        return left_xyxy, right_xyxy

    def keypoint_token_update_fn(
        self,
        kps_emb_start_idx,
        image_embeddings,
        token_embeddings,
        token_augment,
        pose_output,
        layer_idx,
    ):
        # It's already after the last layer, we're done.
        if layer_idx == len(self.decoder.layers) - 1:
            return token_embeddings, token_augment, pose_output, layer_idx

        # Clone
        token_embeddings = token_embeddings.clone()
        token_augment = token_augment.clone()

        num_keypoints = self.keypoint_embedding.weight.shape[0]

        # Get current 2D KPS predictions
        pred_keypoints_2d_cropped = pose_output[
            "pred_keypoints_2d_cropped"
        ].clone()
        pred_keypoints_2d_depth = pose_output["pred_keypoints_2d_depth"].clone()

        pred_keypoints_2d_cropped = pred_keypoints_2d_cropped[
            :, self.keypoint_embedding_idxs
        ]
        pred_keypoints_2d_depth = pred_keypoints_2d_depth[
            :, self.keypoint_embedding_idxs
        ]

        # Get 2D KPS to be 0 ~ 1
        pred_keypoints_2d_cropped_01 = pred_keypoints_2d_cropped + 0.5

        # Get a mask of those that are 1) beyond image boundaries or 2) behind the camera
        invalid_mask = (
            (pred_keypoints_2d_cropped_01[:, :, 0] < 0)
            | (pred_keypoints_2d_cropped_01[:, :, 0] > 1)
            | (pred_keypoints_2d_cropped_01[:, :, 1] < 0)
            | (pred_keypoints_2d_cropped_01[:, :, 1] > 1)
            | (pred_keypoints_2d_depth[:, :] < 1e-5)
        )

        # Run them through the prompt encoder's pos emb function
        token_augment[:, kps_emb_start_idx : kps_emb_start_idx + num_keypoints, :] = (
            self.keypoint_posemb_linear(pred_keypoints_2d_cropped)
            * (~invalid_mask[:, :, None])
        )

        # Also update token_embeddings with the grid sampled 2D feature.
        pred_keypoints_2d_cropped_sample_points = pred_keypoints_2d_cropped * 2
        if self.cfg.MODEL.BACKBONE.TYPE in [
            "vit_hmr",
            "vit",
            "vit_b",
            "vit_l",
            "vit_hmr_512_384",
        ]:
            pred_keypoints_2d_cropped_sample_points[:, :, 0] = (
                pred_keypoints_2d_cropped_sample_points[:, :, 0] / 12 * 16
            )

        pred_keypoints_2d_cropped_feats = (
            F.grid_sample(
                image_embeddings,
                pred_keypoints_2d_cropped_sample_points[:, :, None, :],
                mode="bilinear",
                padding_mode="zeros",
                align_corners=False,
            )
            .squeeze(3)
            .permute(0, 2, 1)
        )
        pred_keypoints_2d_cropped_feats = pred_keypoints_2d_cropped_feats * (
            ~invalid_mask[:, :, None]
        )
        token_embeddings = token_embeddings.clone()
        token_embeddings[
            :,
            kps_emb_start_idx : kps_emb_start_idx + num_keypoints,
            :,
        ] += self.keypoint_feat_linear(pred_keypoints_2d_cropped_feats)

        return token_embeddings, token_augment, pose_output, layer_idx

    def keypoint3d_token_update_fn(
        self,
        kps3d_emb_start_idx,
        token_embeddings,
        token_augment,
        pose_output,
        layer_idx,
    ):
        # It's already after the last layer, we're done.
        if layer_idx == len(self.decoder.layers) - 1:
            return token_embeddings, token_augment, pose_output, layer_idx

        num_keypoints3d = self.keypoint3d_embedding.weight.shape[0]

        # Get current 3D kps predictions
        pred_keypoints_3d = pose_output["pred_keypoints_3d"].clone()

        # Now, pelvis normalize
        pred_keypoints_3d = (
            pred_keypoints_3d
            - (
                pred_keypoints_3d[:, [self.pelvis_idx[0]], :]
                + pred_keypoints_3d[:, [self.pelvis_idx[1]], :]
            )
            / 2
        )

        # Get the kps we care about, _after_ pelvis norm
        pred_keypoints_3d = pred_keypoints_3d[:, self.keypoint3d_embedding_idxs]

        # Run through embedding MLP & put in
        token_augment = token_augment.clone()
        token_augment[
            :,
            kps3d_emb_start_idx : kps3d_emb_start_idx + num_keypoints3d,
            :,
        ] = self.keypoint3d_posemb_linear(pred_keypoints_3d)

        return token_embeddings, token_augment, pose_output, layer_idx

    def keypoint_token_update_fn_hand(
        self,
        kps_emb_start_idx,
        image_embeddings,
        token_embeddings,
        token_augment,
        pose_output,
        layer_idx,
    ):
        # It's already after the last layer, we're done.
        if layer_idx == len(self.decoder_hand.layers) - 1:
            return token_embeddings, token_augment, pose_output, layer_idx

        # Clone
        token_embeddings = token_embeddings.clone()
        token_augment = token_augment.clone()

        num_keypoints = self.keypoint_embedding_hand.weight.shape[0]

        # Get current 2D KPS predictions
        pred_keypoints_2d_cropped = pose_output[
            "pred_keypoints_2d_cropped"
        ].clone()
        pred_keypoints_2d_depth = pose_output["pred_keypoints_2d_depth"].clone()

        pred_keypoints_2d_cropped = pred_keypoints_2d_cropped[
            :, self.keypoint_embedding_idxs_hand
        ]
        pred_keypoints_2d_depth = pred_keypoints_2d_depth[
            :, self.keypoint_embedding_idxs_hand
        ]

        # Get 2D KPS to be 0 ~ 1
        pred_keypoints_2d_cropped_01 = pred_keypoints_2d_cropped + 0.5

        # Get a mask of those that are 1) beyond image boundaries or 2) behind the camera
        invalid_mask = (
            (pred_keypoints_2d_cropped_01[:, :, 0] < 0)
            | (pred_keypoints_2d_cropped_01[:, :, 0] > 1)
            | (pred_keypoints_2d_cropped_01[:, :, 1] < 0)
            | (pred_keypoints_2d_cropped_01[:, :, 1] > 1)
            | (pred_keypoints_2d_depth[:, :] < 1e-5)
        )

        # Run them through the prompt encoder's pos emb function
        token_augment[:, kps_emb_start_idx : kps_emb_start_idx + num_keypoints, :] = (
            self.keypoint_posemb_linear_hand(pred_keypoints_2d_cropped)
            * (~invalid_mask[:, :, None])
        )

        # Also update token_embeddings with the grid sampled 2D feature.
        pred_keypoints_2d_cropped_sample_points = pred_keypoints_2d_cropped * 2
        if self.cfg.MODEL.BACKBONE.TYPE in [
            "vit_hmr",
            "vit",
            "vit_b",
            "vit_l",
            "vit_hmr_512_384",
        ]:
            pred_keypoints_2d_cropped_sample_points[:, :, 0] = (
                pred_keypoints_2d_cropped_sample_points[:, :, 0] / 12 * 16
            )

        pred_keypoints_2d_cropped_feats = (
            F.grid_sample(
                image_embeddings,
                pred_keypoints_2d_cropped_sample_points[:, :, None, :],
                mode="bilinear",
                padding_mode="zeros",
                align_corners=False,
            )
            .squeeze(3)
            .permute(0, 2, 1)
        )
        pred_keypoints_2d_cropped_feats = pred_keypoints_2d_cropped_feats * (
            ~invalid_mask[:, :, None]
        )
        token_embeddings = token_embeddings.clone()
        token_embeddings[
            :,
            kps_emb_start_idx : kps_emb_start_idx + num_keypoints,
            :,
        ] += self.keypoint_feat_linear_hand(pred_keypoints_2d_cropped_feats)

        return token_embeddings, token_augment, pose_output, layer_idx

    def keypoint3d_token_update_fn_hand(
        self,
        kps3d_emb_start_idx,
        token_embeddings,
        token_augment,
        pose_output,
        layer_idx,
    ):
        # It's already after the last layer, we're done.
        if layer_idx == len(self.decoder_hand.layers) - 1:
            return token_embeddings, token_augment, pose_output, layer_idx

        num_keypoints3d = self.keypoint3d_embedding_hand.weight.shape[0]

        # Get current 3D kps predictions
        pred_keypoints_3d = pose_output["pred_keypoints_3d"].clone()

        # Now, pelvis normalize
        pred_keypoints_3d = (
            pred_keypoints_3d
            - (
                pred_keypoints_3d[:, [self.pelvis_idx[0]], :]
                + pred_keypoints_3d[:, [self.pelvis_idx[1]], :]
            )
            / 2
        )

        # Get the kps we care about, _after_ pelvis norm
        pred_keypoints_3d = pred_keypoints_3d[:, self.keypoint3d_embedding_idxs_hand]

        # Run through embedding MLP & put in
        token_augment = token_augment.clone()
        token_augment[
            :,
            kps3d_emb_start_idx : kps3d_emb_start_idx + num_keypoints3d,
            :,
        ] = self.keypoint3d_posemb_linear_hand(pred_keypoints_3d)

        return token_embeddings, token_augment, pose_output, layer_idx
