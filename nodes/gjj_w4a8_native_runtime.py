"""Native asymmetric W4A8 registration for compatible ComfyUI runtimes.

The checkpoint layout and integration contract follow the loader distributed
with AX1Y2JP/MiniMax-H3-W4A8-ConvRot and ComfyUI PR #15308.  The actual CUDA,
Triton, and eager kernels are provided by the official comfy-kitchen package.
"""

from __future__ import annotations

from typing import Any
import json
import threading

import torch
import comfy.ops
import comfy.quant_ops


_PATCH_LOCK = threading.Lock()
_ORIGINAL_LOAD_QUANTIZED_MODULE = None
_NATIVE_READY = False
_CUTLASS_READY = False
_PATCH_ERROR = ""


def _pop_tensor(state_dict: dict[str, Any], prefix: str, names: tuple[str, ...], device, dtype=None):
    for name in names:
        key = f"{prefix}{name}"
        value = state_dict.pop(key, None)
        if value is None:
            continue
        value = value.to(device=device)
        if dtype is not None:
            value = value.to(dtype=dtype)
        return key, value
    return "", None


def _patched_load_quantized_module(
    module,
    super_load,
    state_dict,
    prefix,
    local_metadata,
    strict,
    missing_keys,
    unexpected_keys,
    error_msgs,
    load_extra_params=False,
):
    marker_key = f"{prefix}comfy_quant"
    marker = state_dict.get(marker_key)
    if marker is None:
        return _ORIGINAL_LOAD_QUANTIZED_MODULE(
            module, super_load, state_dict, prefix, local_metadata, strict,
            missing_keys, unexpected_keys, error_msgs, load_extra_params,
        )
    try:
        config = json.loads(marker.detach().cpu().numpy().tobytes())
    except Exception:
        config = {}
    if str(config.get("format", "")).lower() not in {"asym_w4a8_int8", "w4a8_int8"}:
        return _ORIGINAL_LOAD_QUANTIZED_MODULE(
            module, super_load, state_dict, prefix, local_metadata, strict,
            missing_keys, unexpected_keys, error_msgs, load_extra_params,
        )

    device = module.factory_kwargs["device"]
    compute_dtype = module.factory_kwargs["dtype"]
    disabled_formats = module._disabled_formats
    consumed = [marker_key]
    state_dict.pop(marker_key, None)
    weight_key = f"{prefix}weight"
    weight = state_dict.pop(weight_key, None)
    consumed.append(weight_key)
    if weight is None:
        raise ValueError(f"W4A8 layer {prefix.rstrip('.')} is missing its packed weight")

    scale_key, scale = _pop_tensor(state_dict, prefix, ("scale", "s_rel", "weight_s_rel", "weight_scale"), device)
    channel_key, channel_scale = _pop_tensor(
        state_dict, prefix, ("s_channel", "weight_s_channel"), device, torch.float32,
    )
    correction_key, correction = _pop_tensor(
        state_dict, prefix, ("correction", "weight_correction"), device, torch.float32,
    )
    codebook_key, codebook = _pop_tensor(
        state_dict, prefix, ("codebook", "weight_codebook"), device, torch.float32,
    )
    consumed.extend(key for key in (scale_key, channel_key, correction_key, codebook_key) if key)
    if scale is None:
        raise ValueError(f"W4A8 layer {prefix.rstrip('.')} is missing its grouped relative scale")

    params_config = config.get("params", {})
    if not isinstance(params_config, dict):
        params_config = {}
    quant_format = str(config.get("format", "asym_w4a8_int8")).lower()
    module.quant_format = quant_format
    module._full_precision_mm_config = config.get("full_precision_matrix_mult", False)
    if not module._full_precision_mm:
        module._full_precision_mm = module._full_precision_mm_config
    if quant_format in disabled_formats:
        module._full_precision_mm = True

    qconfig = comfy.quant_ops.QUANT_ALGOS["asym_w4a8_int8"]
    module.layout_type = qconfig["comfy_tensor_layout"]
    layout_class = comfy.quant_ops.get_layout_class(module.layout_type)
    if layout_class is None:
        raise RuntimeError("asym_w4a8_int8 requires comfy-kitchen with AsymW4A8Int8Layout")
    params = layout_class.Params(
        scale=scale,
        s_channel=channel_scale,
        correction=correction,
        codebook=codebook,
        group_size=int(config.get("group_size", params_config.get("group_size", 16))),
        convrot_groupsize=int(config.get("convrot_groupsize", params_config.get("convrot_groupsize", 256))),
        orig_dtype=compute_dtype,
        orig_shape=module._orig_shape,
    )
    module.weight = torch.nn.Parameter(
        comfy.ops.QuantizedTensor(
            weight.to(device=device, dtype=qconfig["storage_t"]),
            module.layout_type,
            params,
        ),
        requires_grad=False,
    )
    super_load(state_dict, prefix, local_metadata, strict, missing_keys, unexpected_keys, error_msgs)
    for key in consumed:
        if key in missing_keys:
            missing_keys.remove(key)


def _verify_cutlass() -> bool:
    if not torch.cuda.is_available():
        return False
    try:
        from comfy_kitchen.backends.cuda import _C

        return callable(getattr(_C, "w4a8_codebook_gemm_chunked", None))
    except Exception:
        return False


def ensure_native_w4a8_runtime() -> bool:
    global _ORIGINAL_LOAD_QUANTIZED_MODULE, _NATIVE_READY, _CUTLASS_READY, _PATCH_ERROR
    if _NATIVE_READY:
        return True
    with _PATCH_LOCK:
        if _NATIVE_READY:
            return True
        try:
            from comfy_kitchen.tensor.w4a8_int8 import AsymW4A8Int8Layout

            comfy.quant_ops.register_layout_class("AsymW4A8Int8Layout", AsymW4A8Int8Layout)
            config = {
                "storage_t": torch.int8,
                "parameters": {"weight_scale", "scale", "s_channel", "correction", "codebook"},
                "comfy_tensor_layout": "AsymW4A8Int8Layout",
                "quantize_input": False,
            }
            comfy.quant_ops.QUANT_ALGOS["asym_w4a8_int8"] = config
            comfy.quant_ops.QUANT_ALGOS["w4a8_int8"] = config
            if _ORIGINAL_LOAD_QUANTIZED_MODULE is None:
                _ORIGINAL_LOAD_QUANTIZED_MODULE = comfy.ops._load_quantized_module
                comfy.ops._load_quantized_module = _patched_load_quantized_module
            _CUTLASS_READY = _verify_cutlass()
            _NATIVE_READY = True
            mode = "CUTLASS 融合内核" if _CUTLASS_READY else "便携回退内核"
            print(f"[GJJ W4A8] 原生运行时已启用：{mode}")
            return True
        except Exception as exc:
            _PATCH_ERROR = str(exc)
            return False


def native_w4a8_status() -> dict[str, Any]:
    return {
        "available": bool(_NATIVE_READY),
        "cutlass": bool(_CUTLASS_READY),
        "error": str(_PATCH_ERROR or ""),
    }

