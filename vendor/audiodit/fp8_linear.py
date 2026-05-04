"""FP8 Linear layer that dequantizes on-the-fly during forward pass.

Stores weights in FP8 (saving VRAM) while computing in BF16.
For users with limited VRAM who can't fit the bf16 model.
"""

import json
from pathlib import Path
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F


class FP8Linear(nn.Module):
    """Linear layer with FP8 weights that dequantizes to BF16 during forward.

    VRAM savings: weight stored as float8_e4m3fn (1 byte/param) vs bf16 (2 bytes/param).
    """

    __constants__ = ["in_features", "out_features"]
    in_features: int
    out_features: int

    def __init__(self, in_features: int, out_features: int, bias: bool = True,
                 device=None):
        super().__init__()
        self.in_features = in_features
        self.out_features = out_features

        self.weight_fp8 = nn.Parameter(
            torch.empty((out_features, in_features), device=device,
                        dtype=torch.float8_e4m3fn),
            requires_grad=False,
        )
        self.scale = nn.Parameter(
            torch.ones(1, device=device, dtype=torch.bfloat16),
            requires_grad=False,
        )
        if bias:
            self.bias = nn.Parameter(
                torch.empty(out_features, device=device, dtype=torch.bfloat16),
                requires_grad=False,
            )
        else:
            self.register_parameter("bias", None)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        weight_bf16 = self.weight_fp8.to(torch.bfloat16) * self.scale
        return F.linear(x, weight_bf16, self.bias)

    def extra_repr(self) -> str:
        return (f"in_features={self.in_features}, out_features={self.out_features}, "
                f"bias={self.bias is not None}, fp8=True")


def replace_linear_with_fp8(module, name, weight_fp8, scale, bias=None):
    """Replace a nn.Linear child with FP8Linear using provided fp8 tensor + scale."""
    linear = getattr(module, name)
    fp8_lin = FP8Linear(
        linear.in_features, linear.out_features,
        bias=(bias is not None),
        device=weight_fp8.device,
    )
    fp8_lin.weight_fp8.data = weight_fp8
    fp8_lin.scale.data = torch.tensor(scale, dtype=torch.bfloat16, device=weight_fp8.device)
    if bias is not None:
        fp8_lin.bias.data = bias
    elif linear.bias is not None:
        fp8_lin.bias.data = linear.bias.data.to(torch.bfloat16)
    setattr(module, name, fp8_lin)


def apply_fp8_to_transformer(model, model_path: Path) -> int:
    """Load fp8 weights directly from safetensors into transformer Linear layers.

    This avoids double-quantization (fp8→bf16→fp8) by loading fp8 tensors directly.
    """
    from safetensors.torch import load_file

    # Load scales
    scales_file = model_path / "fp8_scales.json"
    if not scales_file.exists():
        return 0
    with open(scales_file) as f:
        scales = json.load(f)

    # Load raw safetensors (fp8 + bf16 mixed)
    sd = load_file(str(model_path / "model.safetensors"))

    # Find transformer Linear layers and replace with FP8Linear
    converted = 0
    for full_name, scale_val in scales.items():
        # full_name like "transformer.blocks.0.attn.to_q.weight"
        if not full_name.startswith("transformer."):
            continue
        if full_name not in sd:
            continue

        weight_fp8 = sd[full_name]
        if weight_fp8.dtype != torch.float8_e4m3fn:
            continue

        # Get bias tensor if it exists
        bias_key = full_name.replace(".weight", ".bias")
        bias = sd.get(bias_key)
        if bias is not None:
            bias = bias.to(torch.bfloat16)

        # Navigate to the parent module using model's named_modules
        # e.g. "transformer.blocks.0.attn.to_q.weight" → find "transformer.blocks.0.attn.to_q"
        attr_path = full_name.removesuffix(".weight")

        # Walk the module tree: handle ModuleList indices via []
        parts = attr_path.split(".")
        parent = model
        for part in parts[:-1]:
            if part.isdigit():
                parent = parent[int(part)]
            else:
                parent = getattr(parent, part)

        attr_name = parts[-1]
        child = getattr(parent, attr_name)
        if isinstance(child, nn.Linear):
            replace_linear_with_fp8(parent, attr_name, weight_fp8, scale_val, bias)
            converted += 1

    return converted
