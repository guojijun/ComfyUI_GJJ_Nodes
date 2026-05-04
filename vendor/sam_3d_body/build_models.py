# Copyright (c) Meta Platforms, Inc. and affiliates.
import logging
import torch
import comfy.model_management

from .model import SAM3DBody
from .configs import get_default_config

log = logging.getLogger("sam3dbody")


def load_sam_3d_body(checkpoint_path: str = "", device: str = None, mhr_path: str = "", dtype: torch.dtype = None):

    if device is None:
        device = str(comfy.model_management.get_torch_device())

    model_cfg = get_default_config()

    # Configure model
    model_cfg.defrost()
    model_cfg.MODEL.MHR_HEAD.MHR_MODEL_PATH = mhr_path
    model_cfg.freeze()

    # Load safetensors checkpoint to CPU
    from safetensors.torch import load_file
    state_dict = load_file(str(checkpoint_path), device="cpu")

    # Build model on meta device (zero memory, no random init)
    with torch.device("meta"):
        model = SAM3DBody(model_cfg)

    # Load checkpoint weights — assign=True replaces meta tensors with real data
    model.load_state_dict(state_dict, strict=False, assign=True)

    # Materialize any remaining meta tensors (params/buffers not in checkpoint)
    for name, param in list(model.named_parameters()):
        if param.device.type == 'meta':
            parts = name.split('.')
            mod = model
            for p in parts[:-1]:
                mod = getattr(mod, p)
            mod._parameters[parts[-1]] = torch.nn.Parameter(
                torch.zeros(param.shape, dtype=param.dtype, device='cpu'),
                requires_grad=param.requires_grad,
            )
    for name, buf in list(model.named_buffers()):
        if buf.device.type == 'meta':
            parts = name.split('.')
            mod = model
            for p in parts[:-1]:
                mod = getattr(mod, p)
            mod._buffers[parts[-1]] = torch.zeros(buf.shape, dtype=buf.dtype, device='cpu')

    # Fix C: Re-initialize persistent=False buffers with correct dtype
    model.image_mean = torch.tensor(model_cfg.MODEL.IMAGE_MEAN, dtype=dtype).view(-1, 1, 1)
    model.image_std = torch.tensor(model_cfg.MODEL.IMAGE_STD, dtype=dtype).view(-1, 1, 1)

    # Cast model weights to target dtype, then restore MHR JIT models to fp32
    # (sparse CUDA ops in MHR don't support bf16)
    if dtype is not None:
        model.to(dtype=dtype)
        model.head_pose.mhr.float()
        model.head_pose_hand.mhr.float()

    log.info(f" image_mean: {model.image_mean.flatten().tolist()}")
    log.info(f" image_std: {model.image_std.flatten().tolist()}")

    model.eval()
    return model, model_cfg, mhr_path
