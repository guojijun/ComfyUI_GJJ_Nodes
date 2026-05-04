# Attention modules, FFN/MLP, and encoder/decoder layer classes.

import sys
from typing import Dict, Optional

import torch
import torch.nn as nn
import torch.nn.functional as F

import comfy.ops
from .attention import sam3d_attention

from .layers import DropPath, LayerScale, LayerNorm32, build_norm_layer

ops = comfy.ops.manual_cast


# =============================================================================
# Feed-forward networks
# =============================================================================

class FFN(nn.Module):
    """Implements feed-forward networks (FFNs) with identity connection."""

    def __init__(
        self,
        embed_dims=256,
        feedforward_channels=1024,
        output_dims=None,
        num_fcs=2,
        act_layer=nn.ReLU,
        ffn_drop=0.0,
        drop_path_rate=0.0,
        add_identity=True,
        layer_scale_init_value=0.0,
        dtype=None,
        device=None,
        operations=ops,
    ):
        super().__init__()
        self.embed_dims = embed_dims
        self.feedforward_channels = feedforward_channels
        self.output_dims = output_dims or embed_dims
        self.num_fcs = num_fcs

        layers = []
        in_channels = embed_dims
        for _ in range(num_fcs - 1):
            layers.append(
                nn.Sequential(
                    operations.Linear(in_channels, feedforward_channels, dtype=dtype, device=device),
                    act_layer(),
                    nn.Dropout(ffn_drop),
                )
            )
            in_channels = feedforward_channels
        layers.append(operations.Linear(in_channels, self.output_dims, dtype=dtype, device=device))
        layers.append(nn.Dropout(ffn_drop))
        self.layers = nn.Sequential(*layers)
        self.dropout_layer = (
            DropPath(drop_path_rate) if drop_path_rate > 0.0 else nn.Identity()
        )
        self.add_identity = add_identity

        if layer_scale_init_value > 0:
            self.gamma2 = LayerScale(embed_dims, layer_scale_init_value=layer_scale_init_value)
        else:
            self.gamma2 = nn.Identity()

    def forward(self, x, identity=None):
        out = self.layers(x)
        out = self.gamma2(out)
        if not self.add_identity:
            return self.dropout_layer(out)
        if identity is None:
            identity = x
        return identity + self.dropout_layer(out)


class MLP(nn.Module):
    """Very simple multi-layer perceptron (also called FFN)"""

    def __init__(self, input_dim, hidden_dim, output_dim, num_layers,
                 dtype=None, device=None, operations=ops):
        super().__init__()
        self.num_layers = num_layers
        h = [hidden_dim] * (num_layers - 1)
        self.layers = nn.ModuleList(
            operations.Linear(n, k, dtype=dtype, device=device)
            for n, k in zip([input_dim] + h, h + [output_dim])
        )

    def forward(self, x):
        for i, layer in enumerate(self.layers):
            x = F.relu(layer(x)) if i < self.num_layers - 1 else layer(x)
        return x


# =============================================================================
# SwiGLU FFN
# =============================================================================

class SwiGLUFFN(nn.Module):
    def __init__(
        self,
        embed_dims: int,
        feedforward_channels: Optional[int] = None,
        out_dims: Optional[int] = None,
        layer_scale_init_value: float = 0.0,
        bias: bool = True,
        drop_path_rate: float = 0.0,
        norm_layer: nn.Module = nn.LayerNorm,
        add_identity: bool = True,
        dtype=None,
        device=None,
        operations=ops,
    ) -> None:
        super().__init__()
        self.embed_dims = embed_dims
        self.out_dims = out_dims or embed_dims
        hidden_dims = feedforward_channels or embed_dims

        self.w12 = operations.Linear(self.embed_dims, 2 * hidden_dims, bias=bias, dtype=dtype, device=device)
        self.norm = norm_layer
        self.w3 = operations.Linear(hidden_dims, self.out_dims, bias=bias, dtype=dtype, device=device)

        if layer_scale_init_value > 0:
            self.gamma2 = LayerScale(
                dim=embed_dims, layer_scale_init_value=layer_scale_init_value
            )
        else:
            self.gamma2 = nn.Identity()

        self.dropout_layer = DropPath(drop_path_rate)
        self.add_identity = add_identity

    def forward(
        self, x: torch.Tensor, identity: Optional[torch.Tensor] = None
    ) -> torch.Tensor:
        x12 = self.w12(x)
        x1, x2 = x12.chunk(2, dim=-1)
        hidden = F.silu(x1) * x2
        hidden = self.norm(hidden)
        out = self.w3(hidden)
        out = self.gamma2(out)
        out = self.dropout_layer(out)

        if self.out_dims != self.embed_dims or not self.add_identity:
            return out

        if identity is None:
            identity = x
        return identity + out


class SwiGLUFFNFused(SwiGLUFFN):
    def __init__(
        self,
        embed_dims: int,
        feedforward_channels: Optional[int] = None,
        out_dims: Optional[int] = None,
        layer_scale_init_value: float = 0.0,
        bias: bool = True,
        dtype=None,
        device=None,
        operations=ops,
    ) -> None:
        out_dims = out_dims or embed_dims
        feedforward_channels = feedforward_channels or embed_dims
        feedforward_channels = (int(feedforward_channels * 2 / 3) + 7) // 8 * 8
        super().__init__(
            embed_dims=embed_dims,
            feedforward_channels=feedforward_channels,
            out_dims=out_dims,
            layer_scale_init_value=layer_scale_init_value,
            bias=bias,
            dtype=dtype,
            device=device,
            operations=operations,
        )


# =============================================================================
# Attention modules
# =============================================================================

class MultiheadAttention(nn.Module):
    """Multi-head Attention Module."""

    def __init__(
        self,
        embed_dims,
        num_heads,
        input_dims=None,
        attn_drop=0.0,
        proj_drop=0.0,
        drop_path_rate=0.0,
        qkv_bias=True,
        proj_bias=True,
        v_shortcut=False,
        layer_scale_init_value=0.0,
        dtype=None,
        device=None,
        operations=ops,
    ):
        super().__init__()

        self.input_dims = input_dims or embed_dims
        self.embed_dims = embed_dims
        self.num_heads = num_heads
        self.v_shortcut = v_shortcut

        self.head_dims = embed_dims // num_heads

        self.qkv = operations.Linear(self.input_dims, embed_dims * 3, bias=qkv_bias, dtype=dtype, device=device)
        self.attn_drop = attn_drop
        self.proj = operations.Linear(embed_dims, embed_dims, bias=proj_bias, dtype=dtype, device=device)
        self.proj_drop = nn.Dropout(proj_drop)

        self.out_drop = DropPath(drop_path_rate)

        if layer_scale_init_value > 0:
            layer_scale_init_value = layer_scale_init_value or 1e-5
            self.gamma1 = LayerScale(
                embed_dims, layer_scale_init_value=layer_scale_init_value
            )
        else:
            self.gamma1 = nn.Identity()

    def forward(self, x):
        B, N, _ = x.shape
        qkv = (
            self.qkv(x)
            .reshape(B, N, 3, self.num_heads, self.head_dims)
            .permute(2, 0, 3, 1, 4)
        )
        q, k, v = qkv[0], qkv[1], qkv[2]

        x = sam3d_attention(q, k, v, heads=self.num_heads, skip_reshape=True)

        x = self.proj(x)
        x = self.out_drop(self.gamma1(self.proj_drop(x)))

        if self.v_shortcut:
            x = v.squeeze(1) + x
        return x


class CrossAttention(nn.Module):
    """Multi-head Attention Module for both self and cross attention."""

    def __init__(
        self,
        embed_dims,
        num_heads,
        query_dims=None,
        key_dims=None,
        value_dims=None,
        attn_drop=0.0,
        proj_drop=0.0,
        drop_path_rate=0.0,
        qkv_bias=True,
        proj_bias=True,
        v_shortcut=False,
        layer_scale_init_value=0.0,
        dtype=None,
        device=None,
        operations=ops,
    ):
        super().__init__()

        self.query_dims = query_dims or embed_dims
        self.key_dims = key_dims or embed_dims
        self.value_dims = value_dims or embed_dims
        self.embed_dims = embed_dims
        self.num_heads = num_heads
        self.v_shortcut = v_shortcut

        self.head_dims = embed_dims // num_heads

        self.q_proj = operations.Linear(self.query_dims, embed_dims, bias=qkv_bias, dtype=dtype, device=device)
        self.k_proj = operations.Linear(self.key_dims, embed_dims, bias=qkv_bias, dtype=dtype, device=device)
        self.v_proj = operations.Linear(self.value_dims, embed_dims, bias=qkv_bias, dtype=dtype, device=device)
        self.attn_drop = attn_drop
        self.proj = operations.Linear(embed_dims, self.query_dims, bias=proj_bias, dtype=dtype, device=device)
        self.proj_drop = nn.Dropout(proj_drop)

        self.out_drop = DropPath(drop_path_rate)

        if layer_scale_init_value > 0:
            layer_scale_init_value = layer_scale_init_value or 1e-5
            self.gamma1 = LayerScale(
                embed_dims, layer_scale_init_value=layer_scale_init_value
            )
        else:
            self.gamma1 = nn.Identity()

    def _separate_heads(self, x: torch.Tensor) -> torch.Tensor:
        b, n, _ = x.shape
        x = x.reshape(b, n, self.num_heads, self.head_dims)
        return x.transpose(1, 2)

    def forward(
        self,
        q: torch.Tensor,
        k: torch.Tensor,
        v: torch.Tensor,
        attn_mask: Optional[torch.Tensor] = None,
    ):
        B, N, _ = q.shape
        q = self._separate_heads(self.q_proj(q))
        k = self._separate_heads(self.k_proj(k))
        v = self._separate_heads(self.v_proj(v))

        if attn_mask is not None:
            attn_mask = attn_mask.unsqueeze(1).expand(-1, self.num_heads, -1, -1)

        x = sam3d_attention(q, k, v, heads=self.num_heads, mask=attn_mask, skip_reshape=True)

        x = self.proj(x)
        x = self.out_drop(self.gamma1(self.proj_drop(x)))

        if self.v_shortcut:
            x = v.squeeze(1) + x
        return x


# =============================================================================
# Transformer encoder / decoder layers
# =============================================================================

class TransformerEncoderLayer(nn.Module):
    """Implements one encoder layer in Vision Transformer."""

    def __init__(
        self,
        embed_dims,
        num_heads,
        feedforward_channels,
        layer_scale_init_value=0.0,
        drop_rate=0.0,
        attn_drop_rate=0.0,
        drop_path_rate=0.0,
        num_fcs=2,
        qkv_bias=True,
        ffn_type="origin",
        act_layer=nn.GELU,
        norm_cfg=dict(type="LN", eps=1e-6),
        dtype=None,
        device=None,
        operations=ops,
    ):
        super().__init__()

        self.embed_dims = embed_dims

        self.ln1 = build_norm_layer(norm_cfg, self.embed_dims)

        self.attn = MultiheadAttention(
            embed_dims=embed_dims,
            num_heads=num_heads,
            attn_drop=attn_drop_rate,
            proj_drop=drop_rate,
            drop_path_rate=drop_path_rate,
            qkv_bias=qkv_bias,
            layer_scale_init_value=layer_scale_init_value,
            dtype=dtype,
            device=device,
            operations=operations,
        )

        self.ln2 = build_norm_layer(norm_cfg, self.embed_dims)

        if ffn_type == "origin":
            self.ffn = FFN(
                embed_dims=embed_dims,
                feedforward_channels=feedforward_channels,
                num_fcs=num_fcs,
                ffn_drop=drop_rate,
                drop_path_rate=drop_path_rate,
                act_layer=act_layer,
                layer_scale_init_value=layer_scale_init_value,
                dtype=dtype,
                device=device,
                operations=operations,
            )
        elif ffn_type == "swiglu_fused":
            self.ffn = SwiGLUFFNFused(
                embed_dims=embed_dims,
                feedforward_channels=feedforward_channels,
                layer_scale_init_value=layer_scale_init_value,
                dtype=dtype,
                device=device,
                operations=operations,
            )
        else:
            raise NotImplementedError

    @property
    def norm1(self):
        return self.ln1

    @property
    def norm2(self):
        return self.ln2

    def forward(self, x):
        x = x + self.attn(self.ln1(x))
        x = self.ffn(self.ln2(x), identity=x)
        return x


class TransformerDecoderLayer(nn.Module):
    """Implements one decoder layer in cross-attention Transformer."""

    def __init__(
        self,
        token_dims: int,
        context_dims: int,
        num_heads: int = 8,
        head_dims: int = 64,
        mlp_dims: int = 1024,
        layer_scale_init_value: float = 0.0,
        drop_rate: float = 0.0,
        attn_drop_rate: float = 0.0,
        drop_path_rate: float = 0.0,
        ffn_type: str = "origin",
        act_layer: nn.Module = nn.GELU,
        norm_cfg: Dict = dict(type="LN", eps=1e-6),
        enable_twoway: bool = False,
        repeat_pe: bool = False,
        skip_first_pe: bool = False,
        dtype=None,
        device=None,
        operations=ops,
    ):
        super().__init__()
        self.repeat_pe = repeat_pe
        self.skip_first_pe = skip_first_pe
        if self.repeat_pe:
            self.ln_pe_1 = build_norm_layer(norm_cfg, token_dims)
            self.ln_pe_2 = build_norm_layer(norm_cfg, context_dims)

        self.ln1 = build_norm_layer(norm_cfg, token_dims)

        self.self_attn = CrossAttention(
            embed_dims=num_heads * head_dims,
            num_heads=num_heads,
            query_dims=token_dims,
            key_dims=token_dims,
            value_dims=token_dims,
            attn_drop=attn_drop_rate,
            proj_drop=drop_rate,
            drop_path_rate=drop_path_rate,
            layer_scale_init_value=layer_scale_init_value,
            dtype=dtype,
            device=device,
            operations=operations,
        )

        self.ln2_1 = build_norm_layer(norm_cfg, token_dims)
        self.ln2_2 = build_norm_layer(norm_cfg, context_dims)

        self.cross_attn = CrossAttention(
            embed_dims=num_heads * head_dims,
            num_heads=num_heads,
            query_dims=token_dims,
            key_dims=context_dims,
            value_dims=context_dims,
            attn_drop=attn_drop_rate,
            proj_drop=drop_rate,
            drop_path_rate=drop_path_rate,
            layer_scale_init_value=layer_scale_init_value,
            dtype=dtype,
            device=device,
            operations=operations,
        )

        self.ln3 = build_norm_layer(norm_cfg, token_dims)

        if ffn_type == "origin":
            self.ffn = FFN(
                embed_dims=token_dims,
                feedforward_channels=mlp_dims,
                ffn_drop=drop_rate,
                drop_path_rate=drop_path_rate,
                act_layer=act_layer,
                layer_scale_init_value=layer_scale_init_value,
                dtype=dtype,
                device=device,
                operations=operations,
            )
        elif ffn_type == "swiglu_fused":
            self.ffn = SwiGLUFFNFused(
                embed_dims=token_dims,
                feedforward_channels=mlp_dims,
                layer_scale_init_value=layer_scale_init_value,
                dtype=dtype,
                device=device,
                operations=operations,
            )
        else:
            raise NotImplementedError

        self.enable_twoway = enable_twoway
        if self.enable_twoway:
            self.ln4_1 = build_norm_layer(norm_cfg, context_dims)
            self.ln4_2 = build_norm_layer(norm_cfg, token_dims)

            self.cross_attn_2 = CrossAttention(
                embed_dims=num_heads * head_dims,
                num_heads=num_heads,
                query_dims=context_dims,
                key_dims=token_dims,
                value_dims=token_dims,
                attn_drop=attn_drop_rate,
                proj_drop=drop_rate,
                drop_path_rate=drop_path_rate,
                layer_scale_init_value=layer_scale_init_value,
                dtype=dtype,
                device=device,
                operations=operations,
            )

    def forward(
        self,
        x: torch.Tensor,
        context: torch.Tensor,
        x_pe: Optional[torch.Tensor] = None,
        context_pe: Optional[torch.Tensor] = None,
        x_mask: Optional[torch.Tensor] = None,
    ):
        if self.repeat_pe and context_pe is not None:
            x_pe = self.ln_pe_1(x_pe)
            context_pe = self.ln_pe_2(context_pe)

        # Self attention block for tokens
        if self.repeat_pe and not self.skip_first_pe and x_pe is not None:
            q = k = self.ln1(x) + x_pe
            v = self.ln1(x)
        else:
            q = k = v = self.ln1(x)

        attn_mask = None
        if x_mask is not None:
            attn_mask = x_mask[:, :, None] @ x_mask[:, None, :]
            attn_mask.diagonal(dim1=1, dim2=2).fill_(1)
            attn_mask = attn_mask > 0
        x = x + self.self_attn(q=q, k=k, v=v, attn_mask=attn_mask)

        # Cross attention block, tokens attending to image embedding
        if self.repeat_pe and context_pe is not None:
            q = self.ln2_1(x) + x_pe
            k = self.ln2_2(context) + context_pe
            v = self.ln2_2(context)
        else:
            q = self.ln2_1(x)
            k = v = self.ln2_2(context)
        x = x + self.cross_attn(q=q, k=k, v=v)

        # MLP block
        x = self.ffn(self.ln3(x), identity=x)

        # (Optional) Cross attention block, image embeddings attending to tokens
        if self.enable_twoway:
            if self.repeat_pe and context_pe is not None:
                q = self.ln4_1(context) + context_pe
                k = self.ln4_2(x) + x_pe
                v = self.ln4_2(x)
            else:
                q = self.ln4_1(context)
                k = v = self.ln4_2(x)
            attn_mask = (
                (x_mask[:, None, :].repeat(1, context.shape[1], 1)) > 0
                if x_mask is not None
                else None
            )
            context = context + self.cross_attn_2(q=q, k=k, v=v, attn_mask=attn_mask)

        return x, context
