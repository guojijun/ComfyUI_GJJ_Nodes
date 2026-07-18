from __future__ import annotations

"""Runtime support for row-padded ConvRot W4A4 checkpoints.

Stock ConvRot W4A4 kernels require the physical input width to be divisible by
64.  Some otherwise compatible models use logical widths such as 3360.  Their
weights can be padded with zero columns to 3392 before quantization; this module
pads activations to the stored physical width immediately before the quantized
matrix multiplication.  Standard, unpadded ConvRot tensors keep the original
path because their logical and physical widths are identical.
"""

import dataclasses
from typing import Any


_PATCH_INSTALLED = False
_PATCH_ERROR = ""


def _install_padded_requantize(quantized_tensor_cls, linear_layout_cls, pad_fn) -> None:
    current = quantized_tensor_cls.requantize_from_float
    if getattr(current, "_gjj_padded_convrot", False):
        return
    layout_name = linear_layout_cls.__name__

    def _requantize_from_float(self, tensor, **kwargs):
        is_convrot = getattr(self, "_layout_cls", "") == layout_name
        params = getattr(self, "_params", None)
        qdata = getattr(self, "_qdata", None)
        if (
            is_convrot
            and params is not None
            and not getattr(params, "transposed", False)
            and qdata is not None
            and getattr(qdata, "ndim", 0) == 2
            and getattr(tensor, "ndim", 0) == 2
        ):
            physical_width = int(qdata.shape[-1]) * 2
            logical_width = int(tensor.shape[-1])
            if physical_width > logical_width:
                padded = pad_fn(tensor, (0, physical_width - logical_width))
                requantized = current(self, padded, **kwargs)
                restored_params = dataclasses.replace(
                    requantized._params,
                    orig_shape=tuple(int(value) for value in params.orig_shape),
                    transposed=getattr(params, "transposed", False),
                )
                return requantized._copy_with(params=restored_params, clone_params=False)
        return current(self, tensor, **kwargs)

    _requantize_from_float._gjj_padded_convrot = True
    quantized_tensor_cls.requantize_from_float = _requantize_from_float


def _install_padded_convrot_dispatch() -> bool:
    global _PATCH_INSTALLED, _PATCH_ERROR
    if _PATCH_INSTALLED:
        return True

    try:
        import torch
        import torch.nn.functional as F
        import comfy_kitchen as ck
        from comfy.quant_ops import (
            QuantizedTensor,
            TensorCoreConvRotW4A4Layout,
            register_layout_op,
        )
    except Exception as exc:  # pragma: no cover - depends on the host ComfyUI build
        _PATCH_ERROR = f"{type(exc).__name__}: {exc}"
        return False

    def _dequantize(value: Any):
        return value.dequantize() if isinstance(value, QuantizedTensor) else value

    def _pad_to_physical_width(input_tensor: torch.Tensor, weight: QuantizedTensor) -> torch.Tensor:
        physical_width = int(weight._qdata.shape[-1]) * 2
        logical_width = int(input_tensor.shape[-1])
        if physical_width < logical_width:
            raise RuntimeError(
                "ConvRot W4A4 physical input width is smaller than the logical input width: "
                f"physical={physical_width}, logical={logical_width}."
            )
        if physical_width == logical_width:
            return input_tensor
        return F.pad(input_tensor, (0, physical_width - logical_width))

    def _forward(input_tensor: torch.Tensor, weight: QuantizedTensor, bias: torch.Tensor | None):
        input_tensor = _pad_to_physical_width(input_tensor, weight)
        qweight, weight_scales = TensorCoreConvRotW4A4Layout.get_plain_tensors(weight)
        params = weight._params
        return ck.convrot_w4a4_linear(
            input_tensor,
            qweight,
            weight_scales,
            bias=bias,
            convrot_groupsize=params.convrot_groupsize,
            quant_group_size=params.quant_group_size,
            linear_dtype=params.linear_dtype,
        )

    @register_layout_op(torch.ops.aten.linear.default, TensorCoreConvRotW4A4Layout)
    def _handle_linear(_qt, args, kwargs):
        input_tensor, weight = args[0], args[1]
        bias = args[2] if len(args) > 2 else kwargs.get("bias")
        if not isinstance(weight, QuantizedTensor):
            return F.linear(_dequantize(input_tensor), weight, _dequantize(bias))
        input_tensor = _dequantize(input_tensor)
        if getattr(weight._params, "transposed", False):
            return F.linear(input_tensor, weight.dequantize(), bias)
        return _forward(input_tensor, weight, bias)

    @register_layout_op(torch.ops.aten.mm.default, TensorCoreConvRotW4A4Layout)
    def _handle_mm(_qt, args, _kwargs):
        left, right = args[0], args[1]
        if not isinstance(right, QuantizedTensor):
            return torch.mm(_dequantize(left), right)
        left = _dequantize(left)
        if not getattr(right._params, "transposed", False):
            raise RuntimeError("ConvRot W4A4 mm expects the quantized right-hand operand to be transposed.")
        return _forward(left, right, bias=None)

    @register_layout_op(torch.ops.aten.addmm.default, TensorCoreConvRotW4A4Layout)
    def _handle_addmm(_qt, args, _kwargs):
        bias, left, right = args[0], args[1], args[2]
        if not isinstance(right, QuantizedTensor):
            return torch.addmm(_dequantize(bias), _dequantize(left), right)
        left = _dequantize(left)
        if not getattr(right._params, "transposed", False):
            raise RuntimeError("ConvRot W4A4 addmm expects the quantized right-hand operand to be transposed.")
        return _forward(left, right, bias=bias)

    # 低显存分层加载和 LoRA 都会把量化权重临时还原后再量化。填充模型的
    # 逻辑宽度仍是 3360，因此重算前也必须补到磁盘中的 3392 物理宽度。
    _install_padded_requantize(QuantizedTensor, TensorCoreConvRotW4A4Layout, F.pad)

    _PATCH_INSTALLED = True
    _PATCH_ERROR = ""
    return True


PADDED_CONVROT_AVAILABLE = _install_padded_convrot_dispatch()

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
