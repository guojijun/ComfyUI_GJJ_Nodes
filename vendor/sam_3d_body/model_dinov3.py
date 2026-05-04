# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# DINOv3 backbone for SAM 3D Body — ComfyUI-native with operations= threading.
# Consolidated from: dinov3_repo/dinov3/layers/*, dinov3_repo/dinov3/models/vision_transformer.py,
#                     dinov3_repo/dinov3/utils/utils.py, backbones/dinov3.py

import logging
import math
from functools import partial
from typing import Any, Callable, Dict, List, Literal, Optional, Sequence, Tuple, Union

import numpy as np
import torch
import torch.nn.functional as F
from torch import Tensor, nn

import comfy.ops

ops = comfy.ops.manual_cast

logger = logging.getLogger("dinov3")


# =============================================================================
# Utility functions (from dinov3/utils/utils.py and dinov3/layers/attention.py)
# =============================================================================

def cat_keep_shapes(x_list: List[Tensor]) -> Tuple[Tensor, List[Tuple[int]], List[int]]:
    shapes = [x.shape for x in x_list]
    num_tokens = [x.select(dim=-1, index=0).numel() for x in x_list]
    flattened = torch.cat([x.flatten(0, -2) for x in x_list])
    return flattened, shapes, num_tokens


def uncat_with_shapes(flattened: Tensor, shapes: List[Tuple[int]], num_tokens: List[int]) -> List[Tensor]:
    outputs_splitted = torch.split_with_sizes(flattened, num_tokens, dim=0)
    shapes_adjusted = [shape[:-1] + torch.Size([flattened.shape[-1]]) for shape in shapes]
    outputs_reshaped = [o.reshape(shape) for o, shape in zip(outputs_splitted, shapes_adjusted)]
    return outputs_reshaped


def named_apply(
    fn: Callable,
    module: nn.Module,
    name: str = "",
    depth_first: bool = True,
    include_root: bool = False,
) -> nn.Module:
    if not depth_first and include_root:
        fn(module=module, name=name)
    for child_name, child_module in module.named_children():
        child_name = ".".join((name, child_name)) if name else child_name
        named_apply(fn=fn, module=child_module, name=child_name, depth_first=depth_first, include_root=True)
    if depth_first and include_root:
        fn(module=module, name=name)
    return module


def make_2tuple(x):
    if isinstance(x, tuple):
        assert len(x) == 2
        return x
    assert isinstance(x, int)
    return (x, x)


def rope_rotate_half(x: Tensor) -> Tensor:
    x1, x2 = x.chunk(2, dim=-1)
    return torch.cat([-x2, x1], dim=-1)


def rope_apply(x: Tensor, sin: Tensor, cos: Tensor) -> Tensor:
    return (x * cos) + (rope_rotate_half(x) * sin)


def _get_norm_factory(norm_name, operations):
    if norm_name == "layernorm":
        return partial(operations.LayerNorm, eps=1e-6)
    elif norm_name == "layernormbf16":
        return partial(operations.LayerNorm, eps=1e-5)
    elif norm_name == "rmsnorm":
        return RMSNorm
    else:
        raise ValueError(f"Unknown norm layer: {norm_name}")


dtype_dict = {
    "fp32": torch.float32,
    "fp16": torch.float16,
    "bf16": torch.bfloat16,
}


# =============================================================================
# RMSNorm (from dinov3/layers/rms_norm.py)
# =============================================================================

class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-5, dtype=None, device=None):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dim, dtype=dtype, device=device))
        self.eps = eps

    def reset_parameters(self) -> None:
        nn.init.constant_(self.weight, 1)

    def _norm(self, x: Tensor) -> Tensor:
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)

    def forward(self, x: Tensor) -> Tensor:
        output = self._norm(x.float()).type_as(x)
        return output * self.weight.to(x.dtype)


# =============================================================================
# Dinov3LayerScale (from dinov3/layers/layer_scale.py)
# =============================================================================

class Dinov3LayerScale(nn.Module):
    def __init__(self, dim: int, init_values: Union[float, Tensor] = 1e-5, inplace: bool = False, device=None):
        super().__init__()
        self.inplace = inplace
        self.gamma = nn.Parameter(torch.empty(dim, device=device))
        self.init_values = init_values

    def reset_parameters(self):
        nn.init.constant_(self.gamma, self.init_values)

    def forward(self, x: Tensor) -> Tensor:
        return x.mul_(self.gamma.to(x.dtype)) if self.inplace else x * self.gamma.to(x.dtype)


# =============================================================================
# RopePositionEmbedding (from dinov3/layers/rope_position_encoding.py)
# =============================================================================

class RopePositionEmbedding(nn.Module):
    def __init__(
        self,
        embed_dim: int,
        *,
        num_heads: int,
        base: float | None = 100.0,
        min_period: float | None = None,
        max_period: float | None = None,
        normalize_coords: Literal["min", "max", "separate"] = "separate",
        shift_coords: float | None = None,
        jitter_coords: float | None = None,
        rescale_coords: float | None = None,
        dtype: torch.dtype | None = None,
        device: torch.device | None = None,
    ):
        super().__init__()
        assert embed_dim % (4 * num_heads) == 0
        both_periods = min_period is not None and max_period is not None
        if (base is None and not both_periods) or (base is not None and both_periods):
            raise ValueError("Either `base` or `min_period`+`max_period` must be provided.")

        D_head = embed_dim // num_heads
        self.base = base
        self.min_period = min_period
        self.max_period = max_period
        self.D_head = D_head
        self.normalize_coords = normalize_coords
        self.shift_coords = shift_coords
        self.jitter_coords = jitter_coords
        self.rescale_coords = rescale_coords
        self.dtype = dtype
        self.register_buffer("periods", torch.empty(D_head // 4, device=device, dtype=dtype), persistent=True)
        self._init_weights()

    def forward(self, *, H: int, W: int) -> tuple[Tensor, Tensor]:
        device = self.periods.device
        dtype = self.dtype
        dd = {"device": device, "dtype": dtype}

        if self.normalize_coords == "max":
            max_HW = max(H, W)
            coords_h = torch.arange(0.5, H, **dd) / max_HW
            coords_w = torch.arange(0.5, W, **dd) / max_HW
        elif self.normalize_coords == "min":
            min_HW = min(H, W)
            coords_h = torch.arange(0.5, H, **dd) / min_HW
            coords_w = torch.arange(0.5, W, **dd) / min_HW
        elif self.normalize_coords == "separate":
            coords_h = torch.arange(0.5, H, **dd) / H
            coords_w = torch.arange(0.5, W, **dd) / W
        else:
            raise ValueError(f"Unknown normalize_coords: {self.normalize_coords}")
        coords = torch.stack(torch.meshgrid(coords_h, coords_w, indexing="ij"), dim=-1)
        coords = coords.flatten(0, 1)
        coords = 2.0 * coords - 1.0

        if self.training and self.shift_coords is not None:
            shift_hw = torch.empty(2, **dd).uniform_(-self.shift_coords, self.shift_coords)
            coords += shift_hw[None, :]
        if self.training and self.jitter_coords is not None:
            jitter_max = np.log(self.jitter_coords)
            jitter_min = -jitter_max
            jitter_hw = torch.empty(2, **dd).uniform_(jitter_min, jitter_max).exp()
            coords *= jitter_hw[None, :]
        if self.training and self.rescale_coords is not None:
            rescale_max = np.log(self.rescale_coords)
            rescale_min = -rescale_max
            rescale_hw = torch.empty(1, **dd).uniform_(rescale_min, rescale_max).exp()
            coords *= rescale_hw

        angles = 2 * math.pi * coords[:, :, None] / self.periods[None, None, :]
        angles = angles.flatten(1, 2)
        angles = angles.tile(2)
        cos = torch.cos(angles)
        sin = torch.sin(angles)
        return (sin, cos)

    def _init_weights(self):
        device = self.periods.device
        dtype = self.dtype
        if self.base is not None:
            periods = self.base ** (
                2 * torch.arange(self.D_head // 4, device=device, dtype=dtype) / (self.D_head // 2)
            )
        else:
            base = self.max_period / self.min_period
            exponents = torch.linspace(0, 1, self.D_head // 4, device=device, dtype=dtype)
            periods = base**exponents
            periods = periods / base
            periods = periods * self.max_period
        self.periods.data = periods


# =============================================================================
# Dinov3PatchEmbed (from dinov3/layers/patch_embed.py)
# =============================================================================

class Dinov3PatchEmbed(nn.Module):
    def __init__(
        self,
        img_size: Union[int, Tuple[int, int]] = 224,
        patch_size: Union[int, Tuple[int, int]] = 16,
        in_chans: int = 3,
        embed_dim: int = 768,
        norm_layer: Callable | None = None,
        flatten_embedding: bool = True,
        dtype=None,
        device=None,
        operations=ops,
    ) -> None:
        super().__init__()
        image_HW = make_2tuple(img_size)
        patch_HW = make_2tuple(patch_size)
        patch_grid_size = (image_HW[0] // patch_HW[0], image_HW[1] // patch_HW[1])

        self.img_size = image_HW
        self.patch_size = patch_HW
        self.patches_resolution = patch_grid_size
        self.num_patches = patch_grid_size[0] * patch_grid_size[1]
        self.in_chans = in_chans
        self.embed_dim = embed_dim
        self.flatten_embedding = flatten_embedding

        self.proj = operations.Conv2d(in_chans, embed_dim, kernel_size=patch_HW, stride=patch_HW, dtype=dtype, device=device)
        self.norm = norm_layer(embed_dim) if norm_layer else nn.Identity()

    def forward(self, x: Tensor) -> Tensor:
        x = self.proj(x)
        H, W = x.size(2), x.size(3)
        x = x.flatten(2).transpose(1, 2)
        x = self.norm(x)
        if not self.flatten_embedding:
            x = x.reshape(-1, H, W, self.embed_dim)
        return x

    def reset_parameters(self):
        k = 1 / (self.in_chans * (self.patch_size[0] ** 2))
        nn.init.uniform_(self.proj.weight, -math.sqrt(k), math.sqrt(k))
        if self.proj.bias is not None:
            nn.init.uniform_(self.proj.bias, -math.sqrt(k), math.sqrt(k))


# =============================================================================
# LinearKMaskedBias (from dinov3/layers/attention.py)
# =============================================================================

class LinearKMaskedBias(nn.Linear):
    def __init__(self, *args, dtype=None, device=None, **kwargs):
        # Pass dtype/device to nn.Linear for meta-device construction
        super().__init__(*args, dtype=dtype, device=device, **kwargs)
        o = self.out_features
        assert o % 3 == 0
        if self.bias is not None:
            self.register_buffer("bias_mask", torch.full_like(self.bias, fill_value=math.nan))

    def forward(self, input: Tensor) -> Tensor:
        masked_bias = self.bias * self.bias_mask.to(self.bias.dtype) if self.bias is not None else None
        return F.linear(input, self.weight, masked_bias)


# =============================================================================
# ListForwardMixin (from dinov3/layers/ffn_layers.py)
# =============================================================================

class ListForwardMixin(object):
    def forward(self, x: Tensor):
        raise NotImplementedError

    def forward_list(self, x_list: List[Tensor]) -> List[Tensor]:
        x_flat, shapes, num_tokens = cat_keep_shapes(x_list)
        x_flat = self.forward(x_flat)
        return uncat_with_shapes(x_flat, shapes, num_tokens)


# =============================================================================
# Dinov3Mlp (from dinov3/layers/ffn_layers.py)
# =============================================================================

class Dinov3Mlp(nn.Module, ListForwardMixin):
    def __init__(
        self,
        in_features: int,
        hidden_features: Optional[int] = None,
        out_features: Optional[int] = None,
        act_layer: Callable[..., nn.Module] = nn.GELU,
        drop: float = 0.0,
        bias: bool = True,
        dtype=None,
        device=None,
        operations=ops,
    ) -> None:
        super().__init__()
        out_features = out_features or in_features
        hidden_features = hidden_features or in_features
        self.fc1 = operations.Linear(in_features, hidden_features, bias=bias, dtype=dtype, device=device)
        self.act = act_layer()
        self.fc2 = operations.Linear(hidden_features, out_features, bias=bias, dtype=dtype, device=device)
        self.drop = nn.Dropout(drop)

    def forward(self, x: Tensor) -> Tensor:
        x = self.fc1(x)
        x = self.act(x)
        x = self.drop(x)
        x = self.fc2(x)
        x = self.drop(x)
        return x


# =============================================================================
# Dinov3SwiGLUFFN (from dinov3/layers/ffn_layers.py)
# =============================================================================

class Dinov3SwiGLUFFN(nn.Module, ListForwardMixin):
    def __init__(
        self,
        in_features: int,
        hidden_features: Optional[int] = None,
        out_features: Optional[int] = None,
        act_layer: Optional[Callable[..., nn.Module]] = None,
        drop: float = 0.0,
        bias: bool = True,
        align_to: int = 8,
        dtype=None,
        device=None,
        operations=ops,
    ) -> None:
        super().__init__()
        out_features = out_features or in_features
        hidden_features = hidden_features or in_features
        d = int(hidden_features * 2 / 3)
        swiglu_hidden_features = d + (-d % align_to)
        self.w1 = operations.Linear(in_features, swiglu_hidden_features, bias=bias, dtype=dtype, device=device)
        self.w2 = operations.Linear(in_features, swiglu_hidden_features, bias=bias, dtype=dtype, device=device)
        self.w3 = operations.Linear(swiglu_hidden_features, out_features, bias=bias, dtype=dtype, device=device)

    def forward(self, x: Tensor) -> Tensor:
        x1 = self.w1(x)
        x2 = self.w2(x)
        hidden = F.silu(x1) * x2
        return self.w3(hidden)


# =============================================================================
# SelfAttention (from dinov3/layers/attention.py)
# =============================================================================

class SelfAttention(nn.Module):
    def __init__(
        self,
        dim: int,
        num_heads: int = 8,
        qkv_bias: bool = False,
        proj_bias: bool = True,
        attn_drop: float = 0.0,
        proj_drop: float = 0.0,
        mask_k_bias: bool = False,
        dtype=None,
        device=None,
        operations=ops,
    ) -> None:
        super().__init__()
        self.num_heads = num_heads
        head_dim = dim // num_heads
        self.scale = head_dim**-0.5

        if mask_k_bias:
            self.qkv = LinearKMaskedBias(dim, dim * 3, bias=qkv_bias, dtype=dtype, device=device)
        else:
            self.qkv = operations.Linear(dim, dim * 3, bias=qkv_bias, dtype=dtype, device=device)
        self.attn_drop = nn.Dropout(attn_drop)
        self.proj = operations.Linear(dim, dim, bias=proj_bias, dtype=dtype, device=device)
        self.proj_drop = nn.Dropout(proj_drop)

    def apply_rope(self, q: Tensor, k: Tensor, rope: Tensor | Tuple[Tensor, Tensor]) -> Tuple[Tensor, Tensor]:
        q_dtype = q.dtype
        k_dtype = k.dtype
        sin, cos = rope
        rope_dtype = sin.dtype
        q = q.to(dtype=rope_dtype)
        k = k.to(dtype=rope_dtype)
        N = q.shape[-2]
        prefix = N - sin.shape[-2]
        assert prefix >= 0
        q_prefix = q[:, :, :prefix, :]
        q = rope_apply(q[:, :, prefix:, :], sin, cos)
        q = torch.cat((q_prefix, q), dim=-2)
        k_prefix = k[:, :, :prefix, :]
        k = rope_apply(k[:, :, prefix:, :], sin, cos)
        k = torch.cat((k_prefix, k), dim=-2)
        q = q.to(dtype=q_dtype)
        k = k.to(dtype=k_dtype)
        return q, k

    def forward(self, x: Tensor, attn_bias=None, rope: Tensor = None) -> Tensor:
        qkv = self.qkv(x)
        attn_v = self.compute_attention(qkv=qkv, attn_bias=attn_bias, rope=rope)
        x = self.proj(attn_v)
        x = self.proj_drop(x)
        return x

    def forward_list(self, x_list, attn_bias=None, rope_list=None) -> List[Tensor]:
        assert len(x_list) == len(rope_list)
        x_flat, shapes, num_tokens = cat_keep_shapes(x_list)
        qkv_flat = self.qkv(x_flat)
        qkv_list = uncat_with_shapes(qkv_flat, shapes, num_tokens)
        att_out = []
        for _, (qkv, _, rope) in enumerate(zip(qkv_list, shapes, rope_list)):
            att_out.append(self.compute_attention(qkv, attn_bias=attn_bias, rope=rope))
        x_flat, shapes, num_tokens = cat_keep_shapes(att_out)
        x_flat = self.proj(x_flat)
        return uncat_with_shapes(x_flat, shapes, num_tokens)


    def compute_attention(self, qkv: Tensor, attn_bias=None, rope=None) -> Tensor:
        assert attn_bias is None
        B, N, _ = qkv.shape
        C = self.qkv.in_features

        qkv = qkv.reshape(B, N, 3, self.num_heads, C // self.num_heads)
        q, k, v = torch.unbind(qkv, 2)
        q, k, v = [t.transpose(1, 2) for t in [q, k, v]]
        if rope is not None:
            q, k = self.apply_rope(q, k, rope)

        try:
            from comfy_attn import dispatch_attention
            x = dispatch_attention(q, k, v)
        except ImportError:
            x = torch.nn.functional.scaled_dot_product_attention(q, k, v)
        x = x.transpose(1, 2)
        return x.reshape([B, N, C])


# =============================================================================
# SelfAttentionBlock (from dinov3/layers/block.py)
# =============================================================================

class SelfAttentionBlock(nn.Module):
    def __init__(
        self,
        dim: int,
        num_heads: int,
        ffn_ratio: float = 4.0,
        qkv_bias: bool = False,
        proj_bias: bool = True,
        ffn_bias: bool = True,
        drop: float = 0.0,
        attn_drop: float = 0.0,
        init_values=None,
        drop_path: float = 0.0,
        act_layer: Callable[..., nn.Module] = nn.GELU,
        norm_layer: Callable[..., nn.Module] = nn.LayerNorm,
        ffn_layer: Callable[..., nn.Module] = None,
        mask_k_bias: bool = False,
        dtype=None,
        device=None,
        operations=ops,
    ) -> None:
        super().__init__()
        if ffn_layer is None:
            ffn_layer = Dinov3Mlp

        self.norm1 = norm_layer(dim)
        self.attn = SelfAttention(
            dim,
            num_heads=num_heads,
            qkv_bias=qkv_bias,
            proj_bias=proj_bias,
            attn_drop=attn_drop,
            proj_drop=drop,
            mask_k_bias=mask_k_bias,
            dtype=dtype,
            device=device,
            operations=operations,
        )
        self.ls1 = Dinov3LayerScale(dim, init_values=init_values, device=device) if init_values else nn.Identity()

        self.norm2 = norm_layer(dim)
        mlp_hidden_dim = int(dim * ffn_ratio)
        self.mlp = ffn_layer(
            in_features=dim,
            hidden_features=mlp_hidden_dim,
            act_layer=act_layer,
            drop=drop,
            bias=ffn_bias,
            dtype=dtype,
            device=device,
            operations=operations,
        )
        self.ls2 = Dinov3LayerScale(dim, init_values=init_values, device=device) if init_values else nn.Identity()

        self.sample_drop_ratio = drop_path

    @staticmethod
    def _maybe_index_rope(rope, indices):
        if rope is None:
            return None
        sin, cos = rope
        assert sin.ndim == cos.ndim
        if sin.ndim == 4:
            return sin[indices], cos[indices]
        else:
            return sin, cos

    def _forward_list(self, x_list: List[Tensor], rope_list=None) -> List[Tensor]:
        if not self.training or self.sample_drop_ratio == 0.0:
            x_out = []
            for x, rope in zip(x_list, rope_list):
                x_attn = x + self.ls1(self.attn(self.norm1(x), rope=rope))
                x_ffn = x_attn + self.ls2(self.mlp(self.norm2(x_attn)))
                x_out.append(x_ffn)
            return x_out

        # Training path with stochastic depth
        b_list = [x.shape[0] for x in x_list]
        sample_subset_sizes = [max(int(b * (1 - self.sample_drop_ratio)), 1) for b in b_list]
        residual_scale_factors = [b / s for b, s in zip(b_list, sample_subset_sizes)]

        indices_1_list = [
            (torch.randperm(b, device=x.device))[:s]
            for x, b, s in zip(x_list, b_list, sample_subset_sizes)
        ]
        x_subset_1_list = [x[idx] for x, idx in zip(x_list, indices_1_list)]
        rope_subset_list = (
            [self._maybe_index_rope(rope, idx) for rope, idx in zip(rope_list, indices_1_list)]
            if rope_list is not None
            else rope_list
        )

        flattened, shapes, num_tokens = cat_keep_shapes(x_subset_1_list)
        norm1 = uncat_with_shapes(self.norm1(flattened), shapes, num_tokens)
        residual_1_list = self.attn.forward_list(norm1, rope_list=rope_subset_list)

        x_attn_list = [
            torch.index_add(x, dim=0, source=self.ls1(r), index=idx, alpha=scale)
            for x, r, idx, scale in zip(x_list, residual_1_list, indices_1_list, residual_scale_factors)
        ]

        indices_2_list = [
            (torch.randperm(b, device=x.device))[:s]
            for x, b, s in zip(x_list, b_list, sample_subset_sizes)
        ]
        x_subset_2_list = [x[idx] for x, idx in zip(x_attn_list, indices_2_list)]
        flattened, shapes, num_tokens = cat_keep_shapes(x_subset_2_list)
        norm2_list = uncat_with_shapes(self.norm2(flattened), shapes, num_tokens)
        residual_2_list = self.mlp.forward_list(norm2_list)

        x_ffn = [
            torch.index_add(x, dim=0, source=self.ls2(r), index=idx, alpha=scale)
            for x, r, idx, scale in zip(x_attn_list, residual_2_list, indices_2_list, residual_scale_factors)
        ]
        return x_ffn

    def forward(self, x_or_x_list, rope_or_rope_list=None) -> List[Tensor]:
        if isinstance(x_or_x_list, Tensor):
            return self._forward_list([x_or_x_list], rope_list=[rope_or_rope_list])[0]
        elif isinstance(x_or_x_list, list):
            if rope_or_rope_list is None:
                rope_or_rope_list = [None for _ in x_or_x_list]
            return self._forward_list(x_or_x_list, rope_list=rope_or_rope_list)
        else:
            raise AssertionError


# =============================================================================
# Weight initialization (from dinov3/models/vision_transformer.py)
# =============================================================================

def init_weights_vit(module: nn.Module, name: str = ""):
    if isinstance(module, nn.Linear):
        torch.nn.init.trunc_normal_(module.weight, std=0.02)
        if module.bias is not None:
            nn.init.zeros_(module.bias)
        if hasattr(module, "bias_mask") and module.bias_mask is not None:
            o = module.out_features
            module.bias_mask.fill_(1)
            module.bias_mask[o // 3 : 2 * o // 3].fill_(0)
    if isinstance(module, nn.LayerNorm):
        module.reset_parameters()
    if isinstance(module, Dinov3LayerScale):
        module.reset_parameters()
    if isinstance(module, Dinov3PatchEmbed):
        module.reset_parameters()
    if isinstance(module, RMSNorm):
        module.reset_parameters()


# =============================================================================
# DinoVisionTransformer (from dinov3/models/vision_transformer.py)
# =============================================================================

_ffn_layer_dict = {
    "mlp": Dinov3Mlp,
    "swiglu": Dinov3SwiGLUFFN,
    "swiglu32": partial(Dinov3SwiGLUFFN, align_to=32),
    "swiglu64": partial(Dinov3SwiGLUFFN, align_to=64),
    "swiglu128": partial(Dinov3SwiGLUFFN, align_to=128),
}


class DinoVisionTransformer(nn.Module):
    def __init__(
        self,
        *,
        img_size: int = 224,
        patch_size: int = 16,
        in_chans: int = 3,
        pos_embed_rope_base: float = 100.0,
        pos_embed_rope_min_period: float | None = None,
        pos_embed_rope_max_period: float | None = None,
        pos_embed_rope_normalize_coords: Literal["min", "max", "separate"] = "separate",
        pos_embed_rope_shift_coords: float | None = None,
        pos_embed_rope_jitter_coords: float | None = None,
        pos_embed_rope_rescale_coords: float | None = None,
        pos_embed_rope_dtype: str = "bf16",
        embed_dim: int = 768,
        depth: int = 12,
        num_heads: int = 12,
        ffn_ratio: float = 4.0,
        qkv_bias: bool = True,
        drop_path_rate: float = 0.0,
        layerscale_init: float | None = None,
        norm_layer: str = "layernorm",
        ffn_layer: str = "mlp",
        ffn_bias: bool = True,
        proj_bias: bool = True,
        n_storage_tokens: int = 0,
        mask_k_bias: bool = False,
        untie_cls_and_patch_norms: bool = False,
        untie_global_and_local_cls_norm: bool = False,
        dtype=None,
        device: Any | None = None,
        operations=ops,
        **ignored_kwargs,
    ):
        super().__init__()
        if len(ignored_kwargs) > 0:
            logger.warning(f"Ignored kwargs: {ignored_kwargs}")

        norm_layer_cls = _get_norm_factory(norm_layer, operations)
        ffn_layer_cls = _ffn_layer_dict[ffn_layer]

        self.num_features = self.embed_dim = embed_dim
        self.n_blocks = depth
        self.num_heads = num_heads
        self.patch_size = patch_size

        self.patch_embed = Dinov3PatchEmbed(
            img_size=img_size,
            patch_size=patch_size,
            in_chans=in_chans,
            embed_dim=embed_dim,
            flatten_embedding=False,
            dtype=dtype,
            device=device,
            operations=operations,
        )

        self.cls_token = nn.Parameter(torch.empty(1, 1, embed_dim, device=device))
        self.n_storage_tokens = n_storage_tokens
        if self.n_storage_tokens > 0:
            self.storage_tokens = nn.Parameter(torch.empty(1, n_storage_tokens, embed_dim, device=device))

        self.rope_embed = RopePositionEmbedding(
            embed_dim=embed_dim,
            num_heads=num_heads,
            base=pos_embed_rope_base,
            min_period=pos_embed_rope_min_period,
            max_period=pos_embed_rope_max_period,
            normalize_coords=pos_embed_rope_normalize_coords,
            shift_coords=pos_embed_rope_shift_coords,
            jitter_coords=pos_embed_rope_jitter_coords,
            rescale_coords=pos_embed_rope_rescale_coords,
            dtype=dtype_dict.get(pos_embed_rope_dtype, torch.bfloat16),
            device=device,
        )

        ffn_ratio_sequence = [ffn_ratio] * depth
        blocks_list = [
            SelfAttentionBlock(
                dim=embed_dim,
                num_heads=num_heads,
                ffn_ratio=ffn_ratio_sequence[i],
                qkv_bias=qkv_bias,
                proj_bias=proj_bias,
                ffn_bias=ffn_bias,
                drop_path=drop_path_rate,
                norm_layer=norm_layer_cls,
                act_layer=nn.GELU,
                ffn_layer=ffn_layer_cls,
                init_values=layerscale_init,
                mask_k_bias=mask_k_bias,
                dtype=dtype,
                device=device,
                operations=operations,
            )
            for i in range(depth)
        ]

        self.blocks = nn.ModuleList(blocks_list)
        self.norm = norm_layer_cls(embed_dim)

        self.untie_cls_and_patch_norms = untie_cls_and_patch_norms
        self.cls_norm = norm_layer_cls(embed_dim) if untie_cls_and_patch_norms else None

        self.untie_global_and_local_cls_norm = untie_global_and_local_cls_norm
        self.local_cls_norm = norm_layer_cls(embed_dim) if untie_global_and_local_cls_norm else None

        self.head = nn.Identity()
        self.mask_token = nn.Parameter(torch.empty(1, embed_dim, device=device))

    def init_weights(self):
        self.rope_embed._init_weights()
        nn.init.normal_(self.cls_token, std=0.02)
        if self.n_storage_tokens > 0:
            nn.init.normal_(self.storage_tokens, std=0.02)
        nn.init.zeros_(self.mask_token)
        named_apply(init_weights_vit, self)

    def prepare_tokens_with_masks(self, x: Tensor, masks=None) -> Tuple[Tensor, Tuple[int]]:
        x = self.patch_embed(x)
        B, H, W, _ = x.shape
        x = x.flatten(1, 2)

        if masks is not None:
            x = torch.where(masks.unsqueeze(-1), self.mask_token.to(x.dtype).unsqueeze(0), x)
            cls_token = self.cls_token.to(x.dtype)
        else:
            cls_token = self.cls_token.to(x.dtype) + 0 * self.mask_token.to(x.dtype)
        if self.n_storage_tokens > 0:
            storage_tokens = self.storage_tokens.to(x.dtype)
        else:
            storage_tokens = torch.empty(1, 0, cls_token.shape[-1], dtype=cls_token.dtype, device=cls_token.device)

        x = torch.cat([cls_token.expand(B, -1, -1), storage_tokens.expand(B, -1, -1), x], dim=1)
        return x, (H, W)

    def forward_features_list(self, x_list: List[Tensor], masks_list: List[Tensor]) -> List[Dict[str, Tensor]]:
        x = []
        rope = []
        for t_x, t_masks in zip(x_list, masks_list):
            t2_x, hw_tuple = self.prepare_tokens_with_masks(t_x, t_masks)
            x.append(t2_x)
            rope.append(hw_tuple)
        for _, blk in enumerate(self.blocks):
            rope_sincos = [self.rope_embed(H=H, W=W) for H, W in rope] if self.rope_embed is not None else [None for _ in rope]
            x = blk(x, rope_sincos)
        output = []
        for idx, (xi, masks) in enumerate(zip(x, masks_list)):
            if self.untie_cls_and_patch_norms or self.untie_global_and_local_cls_norm:
                if self.untie_global_and_local_cls_norm and self.training and idx == 1:
                    x_norm_cls_reg = self.local_cls_norm(xi[:, : self.n_storage_tokens + 1])
                elif self.untie_cls_and_patch_norms:
                    x_norm_cls_reg = self.cls_norm(xi[:, : self.n_storage_tokens + 1])
                else:
                    x_norm_cls_reg = self.norm(xi[:, : self.n_storage_tokens + 1])
                x_norm_patch = self.norm(xi[:, self.n_storage_tokens + 1 :])
            else:
                x_norm = self.norm(xi)
                x_norm_cls_reg = x_norm[:, : self.n_storage_tokens + 1]
                x_norm_patch = x_norm[:, self.n_storage_tokens + 1 :]
            output.append({
                "x_norm_clstoken": x_norm_cls_reg[:, 0],
                "x_storage_tokens": x_norm_cls_reg[:, 1:],
                "x_norm_patchtokens": x_norm_patch,
                "x_prenorm": xi,
                "masks": masks,
            })
        return output

    def forward_features(self, x: Tensor | List[Tensor], masks: Optional[Tensor] = None) -> List[Dict[str, Tensor]]:
        if isinstance(x, torch.Tensor):
            return self.forward_features_list([x], [masks])[0]
        else:
            return self.forward_features_list(x, masks)

    def _get_intermediate_layers_not_chunked(self, x: Tensor, n: int = 1) -> List[Tensor]:
        x, (H, W) = self.prepare_tokens_with_masks(x)
        output, total_block_len = [], len(self.blocks)
        blocks_to_take = range(total_block_len - n, total_block_len) if isinstance(n, int) else n
        for i, blk in enumerate(self.blocks):
            rope_sincos = self.rope_embed(H=H, W=W) if self.rope_embed is not None else None
            x = blk(x, rope_sincos)
            if i in blocks_to_take:
                output.append(x)
        assert len(output) == len(blocks_to_take)
        return output

    def get_intermediate_layers(
        self,
        x: torch.Tensor,
        *,
        n: Union[int, Sequence] = 1,
        reshape: bool = False,
        return_class_token: bool = False,
        return_extra_tokens: bool = False,
        norm: bool = True,
    ) -> Tuple[Union[torch.Tensor, Tuple[torch.Tensor, ...]]]:
        outputs = self._get_intermediate_layers_not_chunked(x, n)
        if norm:
            outputs_normed = []
            for out in outputs:
                if self.untie_cls_and_patch_norms:
                    x_norm_cls_reg = self.cls_norm(out[:, : self.n_storage_tokens + 1])
                    x_norm_patch = self.norm(out[:, self.n_storage_tokens + 1 :])
                    outputs_normed.append(torch.cat((x_norm_cls_reg, x_norm_patch), dim=1))
                else:
                    outputs_normed.append(self.norm(out))
            outputs = outputs_normed
        class_tokens = [out[:, 0] for out in outputs]
        extra_tokens = [out[:, 1 : self.n_storage_tokens + 1] for out in outputs]
        outputs = [out[:, self.n_storage_tokens + 1 :] for out in outputs]
        if reshape:
            B, _, h, w = x.shape
            outputs = [
                out.reshape(B, h // self.patch_size, w // self.patch_size, -1).permute(0, 3, 1, 2).contiguous()
                for out in outputs
            ]
        if not return_class_token and not return_extra_tokens:
            return tuple(outputs)
        elif return_class_token and not return_extra_tokens:
            return tuple(zip(outputs, class_tokens))
        elif not return_class_token and return_extra_tokens:
            return tuple(zip(outputs, extra_tokens))
        else:
            return tuple(zip(outputs, class_tokens, extra_tokens))

    def forward(self, *args, is_training: bool = False, **kwargs) -> List[Dict[str, Tensor]] | Tensor:
        ret = self.forward_features(*args, **kwargs)
        if is_training:
            return ret
        else:
            return self.head(ret["x_norm_clstoken"])


# =============================================================================
# Model configuration registry and factory (replaces torch.hub.load)
# =============================================================================

_DINOV3_CONFIGS = {
    "dinov3_vits16": dict(
        embed_dim=384, depth=12, num_heads=6, ffn_ratio=4,
        layerscale_init=1e-5, norm_layer="layernormbf16", ffn_layer="mlp",
        n_storage_tokens=4, mask_k_bias=True,
        pos_embed_rope_base=100, pos_embed_rope_normalize_coords="separate",
        pos_embed_rope_rescale_coords=2, pos_embed_rope_dtype="fp32",
    ),
    "dinov3_vits16plus": dict(
        embed_dim=384, depth=12, num_heads=6, ffn_ratio=6,
        layerscale_init=1e-5, norm_layer="layernormbf16", ffn_layer="swiglu",
        n_storage_tokens=4, mask_k_bias=True,
        pos_embed_rope_base=100, pos_embed_rope_normalize_coords="separate",
        pos_embed_rope_rescale_coords=2, pos_embed_rope_dtype="fp32",
    ),
    "dinov3_vitb16": dict(
        embed_dim=768, depth=12, num_heads=12, ffn_ratio=4,
        layerscale_init=1e-5, norm_layer="layernormbf16", ffn_layer="mlp",
        n_storage_tokens=4, mask_k_bias=True,
        pos_embed_rope_base=100, pos_embed_rope_normalize_coords="separate",
        pos_embed_rope_rescale_coords=2, pos_embed_rope_dtype="fp32",
    ),
    "dinov3_vitl16": dict(
        embed_dim=1024, depth=24, num_heads=16, ffn_ratio=4,
        layerscale_init=1e-5, norm_layer="layernormbf16", ffn_layer="mlp",
        n_storage_tokens=4, mask_k_bias=True,
        pos_embed_rope_base=100, pos_embed_rope_normalize_coords="separate",
        pos_embed_rope_rescale_coords=2, pos_embed_rope_dtype="fp32",
    ),
    "dinov3_vitl16plus": dict(
        embed_dim=1024, depth=24, num_heads=16, ffn_ratio=6.0,
        layerscale_init=1e-5, norm_layer="layernormbf16", ffn_layer="swiglu",
        n_storage_tokens=4, mask_k_bias=True,
        pos_embed_rope_base=100, pos_embed_rope_normalize_coords="separate",
        pos_embed_rope_rescale_coords=2, pos_embed_rope_dtype="fp32",
    ),
    "dinov3_vith16plus": dict(
        embed_dim=1280, depth=32, num_heads=20, ffn_ratio=6.0,
        layerscale_init=1e-5, norm_layer="layernormbf16", ffn_layer="swiglu",
        n_storage_tokens=4, mask_k_bias=True,
        pos_embed_rope_base=100, pos_embed_rope_normalize_coords="separate",
        pos_embed_rope_rescale_coords=2, pos_embed_rope_dtype="fp32",
    ),
    "dinov3_vit7b16": dict(
        embed_dim=4096, depth=40, num_heads=32, ffn_ratio=3,
        qkv_bias=False,
        layerscale_init=1e-5, norm_layer="layernormbf16", ffn_layer="swiglu64",
        n_storage_tokens=4, mask_k_bias=True,
        untie_global_and_local_cls_norm=True,
        pos_embed_rope_base=100, pos_embed_rope_normalize_coords="separate",
        pos_embed_rope_rescale_coords=2, pos_embed_rope_dtype="fp32",
    ),
}

# Also support "dinov2_*" aliases used by some configs
for _name in list(_DINOV3_CONFIGS.keys()):
    _alias = _name.replace("dinov3_", "dinov2_")
    _alias2 = _alias.replace("16plus", "14")  # dinov2_vitb14 style
    _alias3 = _name.replace("16plus", "14")
    _alias4 = _alias.replace("16", "14")
    for a in [_alias, _alias2, _alias3, _alias4]:
        if a not in _DINOV3_CONFIGS:
            _DINOV3_CONFIGS[a] = _DINOV3_CONFIGS[_name]


def _make_dinov3_encoder(name, drop_path_rate=0.0, dtype=None, device=None, operations=ops, **kwargs):
    if name not in _DINOV3_CONFIGS:
        raise ValueError(f"Unknown DINOv3 model: {name}. Available: {list(_DINOV3_CONFIGS.keys())}")

    config = dict(_DINOV3_CONFIGS[name])
    config["drop_path_rate"] = drop_path_rate
    config.update(kwargs)

    model = DinoVisionTransformer(
        dtype=dtype,
        device=device,
        operations=operations,
        **config,
    )
    model.init_weights()
    return model


# =============================================================================
# Dinov3Backbone wrapper (from backbones/dinov3.py)
# =============================================================================

class Dinov3Backbone(nn.Module):
    def __init__(self, name="dinov2_vitb14", pretrained_weight=None, cfg=None, dtype=None, device=None, operations=ops, *args, **kwargs):
        super().__init__()
        self.name = name
        self.cfg = cfg

        drop_path_rate = self.cfg.MODEL.BACKBONE.DROP_PATH_RATE if self.cfg is not None else 0.0

        self.encoder = _make_dinov3_encoder(
            name,
            drop_path_rate=drop_path_rate,
            dtype=dtype,
            device=device,
            operations=operations,
        )
        self.patch_size = self.encoder.patch_size
        self.embed_dim = self.embed_dims = self.encoder.embed_dim

    def forward(self, x, extra_embed=None):
        assert extra_embed is None, "Not Implemented Yet"
        y = self.encoder.get_intermediate_layers(x, n=1, reshape=True, norm=True)[-1]
        return y

    def get_layer_depth(self, param_name: str, prefix: str = "encoder."):
        num_layers = self.encoder.n_blocks + 2
        if not param_name.startswith(prefix):
            return num_layers - 1, num_layers
        param_name = param_name[len(prefix) :]
        if param_name in ("cls_token", "pos_embed", "storage_tokens"):
            layer_depth = 0
        elif param_name.startswith("patch_embed"):
            layer_depth = 0
        elif param_name.startswith("blocks"):
            layer_id = int(param_name.split(".")[1])
            layer_depth = layer_id + 1
        else:
            layer_depth = num_layers - 1
        return layer_depth, num_layers
