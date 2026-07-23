from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file

from comfy.quant_ops import TensorCoreNVFP4Layout


LAYER_PATTERN = re.compile(
    r"^model\.layers\.(\d+)\."
    r"(?:mlp\.(?:down_proj|gate_proj|up_proj)|self_attn\.(?:k_proj|o_proj|q_proj|v_proj))"
    r"\.weight$"
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--first-layer", type=int, default=1)
    parser.add_argument("--last-layer", type=int, default=40)
    args = parser.parse_args()

    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    tensors: dict[str, torch.Tensor] = {}
    quantized_layers: dict[str, dict[str, str]] = {}
    quantized_source_bytes = 0
    quantized_storage_bytes = 0

    with safe_open(source, framework="pt", device="cpu") as handle:
        metadata = dict(handle.metadata() or {})
        keys = list(handle.keys())
        selected_layers = {
            key.removesuffix(".weight")
            for key in keys
            if (match := LAYER_PATTERN.match(key)) is not None
            and args.first_layer <= int(match.group(1)) <= args.last_layer
        }
        total = len(keys)
        for index, key in enumerate(keys, start=1):
            companion_layer = next(
                (
                    key.removesuffix(suffix)
                    for suffix in (".comfy_quant", ".weight_scale", ".weight_scale_2", ".input_scale")
                    if key.endswith(suffix)
                ),
                None,
            )
            if companion_layer in selected_layers:
                continue

            tensor = handle.get_tensor(key)
            match = LAYER_PATTERN.match(key)
            should_quantize = (
                match is not None
                and args.first_layer <= int(match.group(1)) <= args.last_layer
                and tensor.ndim == 2
                and tensor.is_floating_point()
            )
            if not should_quantize:
                tensors[key] = tensor
                continue

            layer_name = key.removesuffix(".weight")
            source_bytes = tensor.numel() * tensor.element_size()
            if tensor.dtype in (torch.float8_e4m3fn, torch.float8_e5m2):
                scale_key = f"{layer_name}.weight_scale"
                if scale_key not in keys:
                    raise KeyError(f"FP8 tensor is missing its scale: {scale_key}")
                source_scale = handle.get_tensor(scale_key).float()
                tensor = tensor.float() * source_scale
            weight = tensor.to(device="cuda", dtype=torch.bfloat16, non_blocking=False)
            qdata, params = TensorCoreNVFP4Layout.quantize(weight)
            torch.cuda.synchronize()

            qdata_cpu = qdata.cpu()
            block_scale_cpu = params.block_scale.cpu()
            tensor_scale_cpu = params.scale.cpu()
            tensors[key] = qdata_cpu
            tensors[f"{layer_name}.weight_scale"] = block_scale_cpu
            tensors[f"{layer_name}.weight_scale_2"] = tensor_scale_cpu
            tensors[f"{layer_name}.comfy_quant"] = torch.tensor(
                list(json.dumps({"format": "nvfp4"}).encode("utf-8")),
                dtype=torch.uint8,
            )
            quantized_layers[layer_name] = {"format": "nvfp4"}

            quantized_source_bytes += source_bytes
            quantized_storage_bytes += (
                qdata_cpu.numel() * qdata_cpu.element_size()
                + block_scale_cpu.numel() * block_scale_cpu.element_size()
                + tensor_scale_cpu.numel() * tensor_scale_cpu.element_size()
            )
            del weight, qdata, params
            if index % 25 == 0 or index == total:
                elapsed = time.perf_counter() - started
                print(
                    f"[{index}/{total}] quantized={len(quantized_layers)} "
                    f"elapsed={elapsed:.1f}s",
                    flush=True,
                )

    metadata["_quantization_metadata"] = json.dumps(
        {"format_version": "1.0", "layers": quantized_layers},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    metadata["converted_by"] = "ComfyUI_GJJ_Nodes NVFP4 mixed trial"
    metadata["source_model"] = source.name
    metadata["nvfp4_recipe"] = (
        f"model.layers.{args.first_layer}-{args.last_layer} attention+MLP; "
        "uncalibrated dynamic activation scale"
    )

    print(f"Saving {output}", flush=True)
    save_file(tensors, output, metadata=metadata)
    elapsed = time.perf_counter() - started
    print(
        f"Done: layers={len(quantized_layers)} "
        f"selected_source={quantized_source_bytes / 2**30:.2f}GiB "
        f"selected_output={quantized_storage_bytes / 2**30:.2f}GiB "
        f"file={output.stat().st_size / 2**30:.2f}GiB "
        f"elapsed={elapsed:.1f}s",
        flush=True,
    )


if __name__ == "__main__":
    main()
