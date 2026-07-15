from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import struct
import time
from pathlib import Path
from typing import Any

import folder_paths
import numpy as np
import torch
from PIL import Image

from .common_utils.temp_files import gjjutils_write_temp_file, gjjutils_write_temp_pil_image


NODE_NAME = "GJJ_SeeThroughAIO"
PACK_NODE_NAME = "GJJ_SeeThroughBundlePackager"
MODEL_CATEGORY = "seethrough"
DEFAULT_LAYER_BUNDLE = "seethroughv0.0.2_layerdiff3d.safetensors"
DEFAULT_DEPTH_BUNDLE = "seethroughv0.0.1_marigold.safetensors"
RUNTIME_DIR = Path(__file__).resolve().parents[1] / "vendor" / "gjj_seethrough"
CACHE_DIR = Path(__file__).resolve().parents[1] / "cache" / "seethrough_bundles"


def _register_model_folder() -> None:
    if hasattr(folder_paths, "add_model_folder_path"):
        try:
            folder_paths.add_model_folder_path(MODEL_CATEGORY, os.path.join(folder_paths.models_dir, "SeeThrough"))
        except Exception:
            pass
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    model_dir = os.path.join(folder_paths.models_dir, "SeeThrough")
    current = existing.get(MODEL_CATEGORY)
    if current:
        paths, exts = current
        path_list = list(paths) if isinstance(paths, (list, tuple, set)) else [paths]
        if model_dir not in path_list:
            path_list.append(model_dir)
        existing[MODEL_CATEGORY] = (path_list, set(exts or set()) | {".safetensors"})
    else:
        existing[MODEL_CATEGORY] = ([model_dir], {".safetensors"})
    os.makedirs(model_dir, exist_ok=True)


_register_model_folder()


def _safe_filename_list(category: str) -> list[str]:
    _register_model_folder()
    try:
        values = list(folder_paths.get_filename_list(category) or [])
    except Exception:
        values = []
    result: list[str] = []
    seen: set[str] = set()
    for item in values:
        text = str(item or "").replace("\\", "/").strip()
        if not text.lower().endswith(".safetensors"):
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def _bundle_choices(default_name: str, *keywords: str) -> list[str]:
    values = _safe_filename_list(MODEL_CATEGORY)
    lowered_keywords = [keyword.lower() for keyword in keywords if keyword]
    preferred = [
        value for value in values
        if all(keyword in value.lower().replace("-", "_") for keyword in lowered_keywords)
    ]
    result = preferred + [value for value in values if value not in preferred]
    if default_name not in result:
        result.append(default_name)
    return result or [default_name]


def _resolve_bundle_path(name: str) -> str:
    text = str(name or "").strip()
    if not text:
        raise RuntimeError("SeeThrough 单文件模型不能为空。")
    if os.path.isabs(text) and os.path.isfile(text):
        return text
    try:
        return folder_paths.get_full_path_or_raise(MODEL_CATEGORY, text)
    except Exception as exc:
        raise RuntimeError(
            f"未找到 SeeThrough 单文件模型：{text}\n"
            f"请把 .safetensors bundle 放到 ComfyUI/models/SeeThrough。"
        ) from exc


def _load_runtime_module():
    runtime_path = RUNTIME_DIR / "runtime.py"
    if not runtime_path.is_file():
        raise RuntimeError(f"GJJ SeeThrough 运行时缺失：{runtime_path}")
    module_name = "gjj_vendored_seethrough_runtime"
    import sys

    cached = sys.modules.get(module_name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(module_name, runtime_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 GJJ SeeThrough 运行时：{runtime_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _bundle_hash(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _read_bundle_metadata(path: str) -> dict[str, str]:
    from safetensors import safe_open

    with safe_open(path, framework="pt", device="cpu") as handle:
        return dict(handle.metadata() or {})


def _read_safetensors_header(path: str) -> tuple[int, dict[str, Any]]:
    with open(path, "rb") as handle:
        raw = handle.read(8)
        if len(raw) != 8:
            raise RuntimeError(f"safetensors 文件头无效：{path}")
        header_len = struct.unpack("<Q", raw)[0]
        header = json.loads(handle.read(header_len).decode("utf-8").rstrip())
    return 8 + int(header_len), header


def _copy_file_range(source_path: str, target_path: Path, start: int, end: int) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    remaining = max(0, int(end) - int(start))
    with open(source_path, "rb") as src, target_path.open("wb") as dst:
        src.seek(int(start))
        while remaining > 0:
            chunk = src.read(min(16 * 1024 * 1024, remaining))
            if not chunk:
                raise RuntimeError(f"读取 bundle 数据提前结束：{source_path}")
            dst.write(chunk)
            remaining -= len(chunk)


def _extract_bundle(path: str, expected_kind: str) -> str:
    from safetensors import safe_open
    from safetensors.torch import save_file

    metadata = _read_bundle_metadata(path)
    if metadata.get("gjj_bundle_type") != "seethrough_diffusers":
        raise RuntimeError(f"不是 GJJ SeeThrough Diffusers 单文件模型：{path}")
    kind = metadata.get("gjj_seethrough_kind", "")
    if expected_kind and kind and kind != expected_kind:
        raise RuntimeError(f"模型类型不匹配：需要 {expected_kind}，但文件标记为 {kind}。")

    digest = _bundle_hash(path)[:16]
    target = CACHE_DIR / digest
    marker = target / ".gjj_complete"
    if marker.is_file() and (target / "model_index.json").is_file():
        return str(target)

    tmp = CACHE_DIR / f".{digest}.{os.getpid()}.tmp"
    if tmp.exists():
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)

    file_keys = json.loads(metadata.get("gjj_files", "[]") or "[]")
    for rel in file_keys:
        payload = metadata.get(f"file:{rel}", "")
        if not payload:
            continue
        out_path = tmp / rel
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(base64.b64decode(payload.encode("ascii")))

    tensor_files = json.loads(metadata.get("gjj_tensor_files", "[]") or "[]")
    binary_files = json.loads(metadata.get("gjj_binary_files", "[]") or "[]")
    if binary_files:
        data_start, header = _read_safetensors_header(path)
        for rel in binary_files:
            tensor_name = f"file::{rel}"
            entry = header.get(tensor_name)
            if not isinstance(entry, dict):
                continue
            offsets = entry.get("data_offsets")
            if not isinstance(offsets, list) or len(offsets) != 2:
                raise RuntimeError(f"bundle 内部文件偏移无效：{rel}")
            start, end = int(offsets[0]), int(offsets[1])
            _copy_file_range(path, tmp / rel, data_start + start, data_start + end)

    grouped: dict[str, dict[str, torch.Tensor]] = {rel: {} for rel in tensor_files}
    with safe_open(path, framework="pt", device="cpu") as handle:
        for key in handle.keys():
            if "::" not in key:
                continue
            if key.startswith("file::"):
                continue
            rel, tensor_key = key.split("::", 1)
            if rel not in grouped:
                grouped[rel] = {}
            grouped[rel][tensor_key] = handle.get_tensor(key)

    for rel, tensors in grouped.items():
        if not tensors:
            continue
        out_path = tmp / rel
        out_path.parent.mkdir(parents=True, exist_ok=True)
        save_file(tensors, str(out_path))

    if target.exists():
        import shutil

        shutil.rmtree(target, ignore_errors=True)
    tmp.replace(target)
    marker.write_text(json.dumps({"source": os.path.abspath(path), "hash": digest}, ensure_ascii=False), encoding="utf-8")
    return str(target)


def _tensor_to_rgba_numpy(image: torch.Tensor) -> np.ndarray:
    tensor = image.detach().cpu().float().clamp(0.0, 1.0)
    if tensor.ndim == 4:
        tensor = tensor[0]
    if tensor.ndim != 3:
        raise RuntimeError("输入图像必须是 HWC 或 BHWC Tensor。")
    array = (tensor.numpy() * 255.0).round().clip(0, 255).astype(np.uint8)
    if array.shape[2] >= 4:
        return array[:, :, :4]
    alpha = np.full((array.shape[0], array.shape[1], 1), 255, dtype=np.uint8)
    return np.concatenate([array[:, :, :3], alpha], axis=2)


def _numpy_rgb_to_tensor(image: np.ndarray) -> torch.Tensor:
    arr = np.asarray(image)
    if arr.ndim == 2:
        arr = np.repeat(arr[:, :, None], 3, axis=2)
    if arr.shape[2] >= 4:
        arr = arr[:, :, :3]
    return torch.from_numpy(arr.astype(np.float32) / 255.0).unsqueeze(0)


def _layer_canvases(parts: dict[str, Any]) -> list[tuple[str, Image.Image]]:
    tag2pinfo = parts.get("tag2pinfo") or {}
    frame_h, frame_w = [int(v) for v in parts.get("frame_size", (0, 0))]
    if frame_w <= 0 or frame_h <= 0:
        frame_w = frame_h = 1024
    sorted_tags = sorted(tag2pinfo.keys(), key=lambda tag: tag2pinfo[tag].get("depth_median", 1), reverse=True)
    layers: list[tuple[str, Image.Image]] = []
    for tag in sorted_tags:
        pinfo = tag2pinfo[tag]
        img = pinfo.get("img")
        if img is None:
            continue
        rgba = Image.fromarray(np.asarray(img).astype(np.uint8), "RGBA")
        x1, y1, _x2, _y2 = [int(v) for v in pinfo.get("xyxy", [0, 0, rgba.width, rgba.height])]
        canvas = Image.new("RGBA", (frame_w, frame_h), (0, 0, 0, 0))
        canvas.alpha_composite(rgba, (max(0, x1), max(0, y1)))
        layers.append((str(tag), canvas))
    return layers


def _psd_pascal_name(name: str) -> bytes:
    raw = str(name or "Layer").encode("utf-8", "replace")[:255]
    data = bytes([len(raw)]) + raw
    while len(data) % 4:
        data += b"\0"
    return data


def _pack_rect(width: int, height: int) -> bytes:
    return struct.pack(">iiii", 0, 0, int(height), int(width))


def _write_layered_psd(named_layers: list[tuple[str, Image.Image]], out_path: str) -> None:
    if not named_layers:
        raise RuntimeError("没有可写入 PSD 的图层。")
    width, height = named_layers[0][1].size
    layer_records = bytearray()
    channel_data = bytearray()
    channel_ids = [0, 1, 2, -1]

    for name, layer in named_layers:
        rgba_image = layer.convert("RGBA").resize((width, height), Image.Resampling.LANCZOS)
        rgba = rgba_image.tobytes()
        channels = [rgba[i::4] for i in range(4)]
        layer_records += _pack_rect(width, height)
        layer_records += struct.pack(">H", 4)
        for channel_id, channel in zip(channel_ids, channels):
            layer_records += struct.pack(">hI", channel_id, 2 + len(channel))
        layer_records += b"8BIMnorm"
        layer_records += bytes([255, 0, 0, 0])
        extra = struct.pack(">I", 0) + struct.pack(">I", 0) + _psd_pascal_name(name)
        layer_records += struct.pack(">I", len(extra)) + extra
        for channel in channels:
            channel_data += struct.pack(">H", 0) + channel

    layer_info = struct.pack(">h", len(named_layers)) + layer_records + channel_data
    layer_mask_payload = struct.pack(">I", len(layer_info)) + layer_info + struct.pack(">I", 0)
    layer_mask_section = struct.pack(">I", len(layer_mask_payload)) + layer_mask_payload

    composite = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for _name, layer in named_layers:
        composite.alpha_composite(layer.convert("RGBA"))
    rgb = composite.convert("RGB").tobytes()
    flat_channels = [rgb[i::3] for i in range(3)]

    with open(out_path, "wb") as handle:
        handle.write(b"8BPS")
        handle.write(struct.pack(">H", 1))
        handle.write(b"\0" * 6)
        handle.write(struct.pack(">HIIHH", 3, height, width, 8, 3))
        handle.write(struct.pack(">I", 0))
        handle.write(struct.pack(">I", 0))
        handle.write(layer_mask_section)
        handle.write(struct.pack(">H", 0))
        for channel in flat_channels:
            handle.write(channel)


def _stream_pack_diffusers_bundle(source: Path, output: Path, kind: str, repo_id: str = "", sha: str = "") -> None:
    import shutil

    files = [path for path in sorted(source.rglob("*")) if path.is_file()]
    files = [path for path in files if ".cache" not in path.relative_to(source).parts]
    if not (source / "model_index.json").is_file():
        raise RuntimeError(f"不是合法 Diffusers 模型目录，缺少 model_index.json：{source}")
    if not any(path.name.endswith(".safetensors") for path in files):
        raise RuntimeError("目录里没有找到 safetensors 权重文件。")

    offsets: dict[str, tuple[int, int]] = {}
    rels: list[str] = []
    cursor = 0
    for path in files:
        rel = path.relative_to(source).as_posix()
        size = path.stat().st_size
        offsets[rel] = (cursor, cursor + size)
        cursor += size
        rels.append(rel)

    metadata = {
        "gjj_bundle_type": "seethrough_diffusers",
        "gjj_bundle_version": "2",
        "gjj_seethrough_kind": str(kind or "").strip(),
        "gjj_repo_id": str(repo_id or ""),
        "gjj_repo_sha": str(sha or ""),
        "gjj_binary_files": json.dumps(rels, ensure_ascii=False),
        "gjj_tensor_files": "[]",
        "gjj_files": "[]",
    }
    header: dict[str, Any] = {"__metadata__": metadata}
    for rel in rels:
        start, end = offsets[rel]
        header[f"file::{rel}"] = {"dtype": "U8", "shape": [end - start], "data_offsets": [start, end]}

    header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    header_bytes += b" " * ((8 - (len(header_bytes) % 8)) % 8)
    tmp = output.with_suffix(output.suffix + ".tmp")
    tmp.unlink(missing_ok=True)
    with tmp.open("wb") as out:
        out.write(struct.pack("<Q", len(header_bytes)))
        out.write(header_bytes)
        for path in files:
            with path.open("rb") as src:
                shutil.copyfileobj(src, out, length=16 * 1024 * 1024)
    os.replace(tmp, output)


def _output_path(prefix: str, suffix: str) -> str:
    output_dir = Path(folder_paths.get_output_directory()) / "GJJ" / "SeeThrough"
    output_dir.mkdir(parents=True, exist_ok=True)
    clean = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(prefix or "seethrough"))
    return str(output_dir / f"{clean}_{int(time.time() * 1000)}{suffix}")


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync("gjj_node_progress", {"node": str(unique_id), "text": str(text or "")})
    except Exception:
        pass


class GJJ_SeeThroughAIO:
    DESCRIPTION = "SeeThrough 单节点版：输入一张图，内部完成 LayerDiff 透明分层、Marigold 深度、后处理，并直接输出 PSD。模型只接受 GJJ 单文件 safetensors bundle。"
    GJJ_HELP = {
        "title": "GJJ · SeeThrough 透明分层 PSD",
        "description": DESCRIPTION,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "model_tree": [
            {
                "label": "LayerDiff 3D 单文件模型",
                "path": "models/SeeThrough",
                "filename": DEFAULT_LAYER_BUNDLE,
                "kind": "seethrough",
                "type": "SAFETENSORS_BUNDLE",
                "input": "layerdiff_bundle",
                "required": True,
                "description": "由 GJJ SeeThrough Bundle Packager 打包生成，不能使用 Diffusers 目录。",
            },
            {
                "label": "Marigold Depth 单文件模型",
                "path": "models/SeeThrough",
                "filename": DEFAULT_DEPTH_BUNDLE,
                "kind": "seethrough",
                "type": "SAFETENSORS_BUNDLE",
                "input": "depth_bundle",
                "required": True,
                "description": "由 GJJ SeeThrough Bundle Packager 打包生成，不能使用 Diffusers 目录。",
            },
        ],
    }
    CATEGORY = "GJJ/图像"
    FUNCTION = "generate"
    RETURN_TYPES = ("STRING", "IMAGE", "IMAGE")
    RETURN_NAMES = ("PSD路径", "预览图", "图层批次")
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        def hidden(options: dict[str, Any] | None = None) -> dict[str, Any]:
            data = dict(options or {})
            data["display"] = "hidden"
            data["hidden"] = True
            return data

        return {
            "required": {
                "image": ("IMAGE", {"display_name": "输入图片"}),
                "layerdiff_bundle": (_bundle_choices(DEFAULT_LAYER_BUNDLE, "layerdiff"), {"display_name": "LayerDiff单文件"}),
                "depth_bundle": (_bundle_choices(DEFAULT_DEPTH_BUNDLE, "marigold"), {"display_name": "Depth单文件"}),
                "seed": ("INT", {"default": 882882473, "min": 0, "max": 2**32 - 1, "display_name": "种子"}),
                "resolution": ("INT", {"default": 1024, "min": 512, "max": 2048, "step": 64, "display_name": "分层分辨率"}),
                "steps": ("INT", {"default": 30, "min": 1, "max": 100, "step": 1, "display_name": "步数"}),
                "resolution_depth": ("INT", {"default": -1, "min": -1, "max": 2048, "step": 64, "display_name": "深度分辨率"}),
                "tblr_split": ("BOOLEAN", {"default": True, "display_name": "左右拆分"}),
                "use_lama": ("BOOLEAN", {"default": True, "display_name": "使用LaMa拆发"}),
                "cache_tag_embeds": ("BOOLEAN", hidden({"default": True, "display_name": "缓存文本嵌入"})),
                "group_offload": ("BOOLEAN", hidden({"default": False, "display_name": "低显存卸载"})),
                "keep_model_loaded": ("BOOLEAN", hidden({"default": False, "display_name": "保持模型"})),
                "filename_prefix": ("STRING", hidden({"default": "seethrough", "display_name": "文件名前缀"})),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def __init__(self):
        self._cache_key = None
        self._cache = None

    def _load_models(self, layerdiff_bundle: str, depth_bundle: str, cache_tag_embeds: bool, group_offload: bool, keep: bool):
        layer_path = _resolve_bundle_path(layerdiff_bundle)
        depth_path = _resolve_bundle_path(depth_bundle)
        key = (layer_path, depth_path, bool(cache_tag_embeds), bool(group_offload))
        if keep and self._cache_key == key and self._cache is not None:
            return self._cache

        runtime = _load_runtime_module()
        layer_dir = _extract_bundle(layer_path, "layerdiff")
        depth_dir = _extract_bundle(depth_path, "depth")
        layer_model = runtime.SeeThrough_LoadLayerDiffModel().load_model(
            layer_dir,
            "",
            "",
            "none",
            bool(cache_tag_embeds),
            bool(group_offload),
            False,
        )[0]
        depth_model = runtime.SeeThrough_LoadDepthModel().load_model(
            depth_dir,
            "none",
            bool(cache_tag_embeds),
            bool(group_offload),
            False,
        )[0]
        value = (runtime, layer_model, depth_model)
        if keep:
            self._cache_key = key
            self._cache = value
        else:
            self._cache_key = None
            self._cache = None
        return value

    def generate(
        self,
        image,
        layerdiff_bundle,
        depth_bundle,
        seed,
        resolution,
        steps,
        resolution_depth,
        tblr_split,
        use_lama,
        cache_tag_embeds=True,
        group_offload=False,
        keep_model_loaded=False,
        filename_prefix="seethrough",
        unique_id=None,
    ):
        start = time.time()
        _send_status(unique_id, "1/6 加载 SeeThrough 单文件模型...")
        runtime, layer_model, depth_model = self._load_models(
            layerdiff_bundle,
            depth_bundle,
            bool(cache_tag_embeds),
            bool(group_offload),
            bool(keep_model_loaded),
        )

        input_rgba = _tensor_to_rgba_numpy(image)
        _send_status(unique_id, "2/6 生成透明图层...")
        layers, _layers_preview = runtime.SeeThrough_GenerateLayers().generate(
            input_rgba,
            layer_model,
            int(seed),
            int(resolution),
            int(steps),
        )

        _send_status(unique_id, "3/6 估计各图层深度...")
        layers_depth, _depth_preview = runtime.SeeThrough_GenerateDepth().generate(
            layers,
            depth_model,
            int(seed),
            int(resolution_depth),
        )

        _send_status(unique_id, "4/6 后处理与左右拆分...")
        parts, preview = runtime.SeeThrough_PostProcess().process(layers_depth, bool(tblr_split), bool(use_lama))

        _send_status(unique_id, "5/6 写出 PSD 和图层预览...")
        named_layers = _layer_canvases(parts)
        psd_path = _output_path(filename_prefix, ".psd")
        _write_layered_psd(named_layers, psd_path)
        psd_ref = gjjutils_write_temp_file(psd_path, ".psd")
        layer_refs = [gjjutils_write_temp_pil_image(layer, format="PNG", suffix=".png") for _name, layer in named_layers]

        layer_tensors = [
            torch.from_numpy(np.asarray(layer).astype(np.float32) / 255.0)
            for _name, layer in named_layers
        ]
        if layer_tensors:
            layer_batch = torch.stack(layer_tensors, dim=0).contiguous()
        else:
            layer_batch = torch.zeros((1, int(resolution), int(resolution), 4), dtype=torch.float32)

        preview_tensor = preview if isinstance(preview, torch.Tensor) else _numpy_rgb_to_tensor(np.asarray(preview))
        elapsed = time.time() - start
        _send_status(unique_id, f"6/6 完成：{len(named_layers)} 层，耗时 {elapsed:.1f}s")

        if not bool(keep_model_loaded):
            self._cache = None
            self._cache_key = None
            try:
                import comfy.model_management

                comfy.model_management.soft_empty_cache()
            except Exception:
                pass

        return {
            "ui": {
                "gjj_psd": [psd_ref | {"path": psd_path, "filename": os.path.basename(psd_path), "type": "output", "subfolder": "GJJ/SeeThrough"}],
                "images": layer_refs,
                "elapsed_time": [elapsed],
            },
            "result": (psd_path, preview_tensor, layer_batch),
        }


class GJJ_SeeThroughBundlePackager:
    DESCRIPTION = "把 Hugging Face Diffusers 目录打包成 GJJ SeeThrough 单文件 safetensors bundle。"
    CATEGORY = "GJJ/模型"
    FUNCTION = "pack"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("单文件模型路径",)
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source_dir": ("STRING", {"default": "", "display_name": "Diffusers模型目录"}),
                "kind": (["layerdiff", "depth"], {"default": "layerdiff", "display_name": "模型类型"}),
                "output_filename": ("STRING", {"default": DEFAULT_LAYER_BUNDLE, "display_name": "输出文件名"}),
            },
        }

    def pack(self, source_dir: str, kind: str, output_filename: str):
        source = Path(str(source_dir or "")).expanduser()
        if not source.is_dir():
            raise RuntimeError(f"模型目录不存在：{source}")

        name = Path(str(output_filename or "")).name
        if not name.lower().endswith(".safetensors"):
            name += ".safetensors"
        output_dir = Path(folder_paths.models_dir) / "SeeThrough"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / name
        _stream_pack_diffusers_bundle(source, output_path, str(kind or "").strip())
        return (str(output_path),)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_SeeThroughAIO,
    PACK_NODE_NAME: GJJ_SeeThroughBundlePackager,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "SeeThrough透明分层PSD（单文件模型）",
    PACK_NODE_NAME: "SeeThrough模型打包为单文件",
}
