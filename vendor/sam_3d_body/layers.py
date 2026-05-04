# Primitive building blocks: drop path, layer scale, normalization layers.

from typing import Dict, Union

import torch
import torch.nn as nn

import comfy.ops

ops = comfy.ops.manual_cast


# =============================================================================
# Stochastic depth
# =============================================================================

def drop_path(
    x: torch.Tensor, drop_prob: float = 0.0, training: bool = False
) -> torch.Tensor:
    if not training:
        return x
    keep_prob = 1 - drop_prob
    shape = (x.shape[0],) + (1,) * (x.ndim - 1)
    random_tensor = keep_prob + torch.rand(shape, dtype=x.dtype, device=x.device)
    output = x.div(keep_prob) * random_tensor.floor()
    return output


class DropPath(nn.Module):
    def __init__(self, drop_prob: float = 0.1):
        super().__init__()
        self.drop_prob = drop_prob

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return drop_path(x, self.drop_prob, self.training)


# =============================================================================
# LayerScale
# =============================================================================

class LayerScale(nn.Module):
    def __init__(
        self,
        dim: int,
        layer_scale_init_value: Union[float, torch.Tensor] = 1e-5,
        inplace: bool = False,
        data_format: str = "channels_last",
    ):
        super().__init__()
        assert data_format in ("channels_last", "channels_first")
        self.inplace = inplace
        self.data_format = data_format
        self.weight = nn.Parameter(torch.ones(dim) * layer_scale_init_value)

    def forward(self, x):
        w = self.weight.to(x.dtype)
        if self.data_format == "channels_first":
            if self.inplace:
                return x.mul_(w.view(-1, 1, 1))
            else:
                return x * w.view(-1, 1, 1)
        return x.mul_(w) if self.inplace else x * w


# =============================================================================
# Normalization layers
# =============================================================================

class LayerNorm32(ops.LayerNorm):
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return super().forward(x.float()).type(x.dtype)


def build_norm_layer(cfg: Dict, num_features: int):
    if not isinstance(cfg, dict):
        raise TypeError("cfg must be a dict")
    if "type" not in cfg:
        raise KeyError('the cfg dict must contain the key "type"')
    cfg_ = cfg.copy()
    layer_type = cfg_.pop("type")
    if layer_type != "LN":
        raise ValueError("Unsupported norm layer: ", layer_type)
    requires_grad = cfg_.pop("requires_grad", True)
    cfg_.setdefault("eps", 1e-5)
    layer = LayerNorm32(num_features, **cfg_)
    for param in layer.parameters():
        param.requires_grad = requires_grad
    return layer


class LayerNorm2d(nn.Module):
    def __init__(self, num_channels: int, eps: float = 1e-6) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.ones(num_channels))
        self.bias = nn.Parameter(torch.zeros(num_channels))
        self.eps = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        u = x.mean(1, keepdim=True)
        s = (x - u).pow(2).mean(1, keepdim=True)
        x = (x - u) / torch.sqrt(s + self.eps)
        x = self.weight.to(x.dtype)[:, None, None] * x + self.bias.to(x.dtype)[:, None, None]
        return x
