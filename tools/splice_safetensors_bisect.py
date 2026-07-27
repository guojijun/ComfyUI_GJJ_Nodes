from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path


def read_header(path: Path) -> tuple[dict, int]:
    with path.open("rb") as handle:
        header_size = struct.unpack("<Q", handle.read(8))[0]
        header = json.loads(handle.read(header_size).rstrip(b" \0"))
    return header, 8 + header_size


def layer_metadata(header: dict) -> dict:
    metadata = header.get("__metadata__", {})
    return json.loads(metadata.get("_quantization_metadata", "{}")).get("layers", {})


def copy_range(source, output, start: int, length: int, chunk_size: int = 64 << 20) -> None:
    source.seek(start)
    remaining = length
    while remaining:
        block = source.read(min(chunk_size, remaining))
        if not block:
            raise EOFError(f"Unexpected EOF with {remaining} bytes left")
        output.write(block)
        remaining -= len(block)


def build_variant(
    int8_region_path: Path,
    int4_region_path: Path,
    output_path: Path,
    keep_int8_layers: set[str],
    partition: str,
) -> None:
    high_header, high_data_start = read_header(int8_region_path)
    low_header, low_data_start = read_header(int4_region_path)
    high_layers = layer_metadata(high_header)
    low_layers = layer_metadata(low_header)

    target_layers = {
        name
        for name, value in high_layers.items()
        if value.get("format") == "int8_tensorwise"
        and low_layers.get(name, {}).get("format") == "convrot_w4a4"
    }
    selected_header: dict = {}
    selections: list[tuple[Path, int, int]] = []
    offset = 0

    for key in sorted(name for name in high_header if name != "__metadata__"):
        layer = max(
            (name for name in target_layers if key == name or key.startswith(name + ".")),
            key=len,
            default="",
        )
        use_high = not layer or layer in keep_int8_layers
        source_header = high_header if use_high else low_header
        source_path = int8_region_path if use_high else int4_region_path
        source_data_start = high_data_start if use_high else low_data_start
        entry = dict(source_header[key])
        source_offsets = entry["data_offsets"]
        length = source_offsets[1] - source_offsets[0]
        entry["data_offsets"] = [offset, offset + length]
        selected_header[key] = entry
        selections.append((source_path, source_data_start + source_offsets[0], length))
        offset += length

    metadata = dict(high_header.get("__metadata__", {}))
    quant_metadata = json.loads(metadata.get("_quantization_metadata", "{}"))
    for layer in target_layers:
        quant_metadata["layers"][layer] = (
            high_layers[layer] if layer in keep_int8_layers else low_layers[layer]
        )
    metadata["_quantization_metadata"] = json.dumps(
        quant_metadata, ensure_ascii=False, separators=(",", ":")
    )
    metadata["bisect_partition"] = partition
    metadata["bisect_test_region_count"] = str(len(keep_int8_layers))
    metadata["bisect_test_last_layer"] = sorted(keep_int8_layers)[-1]
    selected_header["__metadata__"] = metadata

    encoded = json.dumps(
        selected_header, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    encoded += b" " * ((8 - len(encoded) % 8) % 8)
    temp_path = output_path.with_suffix(output_path.suffix + ".tmp")
    with (
        int8_region_path.open("rb") as high_file,
        int4_region_path.open("rb") as low_file,
        temp_path.open("wb") as output,
    ):
        output.write(struct.pack("<Q", len(encoded)))
        output.write(encoded)
        handles = {int8_region_path: high_file, int4_region_path: low_file}
        for source_path, start, length in selections:
            copy_range(handles[source_path], output, start, length)
    temp_path.replace(output_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("int8_region", type=Path)
    parser.add_argument("int4_region", type=Path)
    parser.add_argument("output_first", type=Path)
    parser.add_argument("output_second", type=Path)
    parser.add_argument("--prefix", default="A1a")
    args = parser.parse_args()

    high_header, _ = read_header(args.int8_region)
    low_header, _ = read_header(args.int4_region)
    high_layers = layer_metadata(high_header)
    low_layers = layer_metadata(low_header)
    target_layers = sorted(
        name
        for name, value in high_layers.items()
        if value.get("format") == "int8_tensorwise"
        and low_layers.get(name, {}).get("format") == "convrot_w4a4"
    )
    midpoint = (len(target_layers) + 1) // 2
    first = set(target_layers[:midpoint])
    second = set(target_layers[midpoint:])
    print(f"Splitting {len(target_layers)} layers into {len(first)} + {len(second)}")
    build_variant(
        args.int8_region, args.int4_region, args.output_first, first, args.prefix + "1"
    )
    build_variant(
        args.int8_region, args.int4_region, args.output_second, second, args.prefix + "2"
    )


if __name__ == "__main__":
    main()
