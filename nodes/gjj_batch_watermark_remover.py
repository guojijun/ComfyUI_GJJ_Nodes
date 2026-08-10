from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import comfy.utils
import node_helpers
import numpy as np
import torch
from comfy_extras.nodes_custom_sampler import CFGGuider, KSamplerSelect, RandomNoise, SamplerCustomAdvanced
from comfy_extras.nodes_flux import EmptyFlux2LatentImage, Flux2Scheduler
from PIL import Image, PngImagePlugin
from nodes import ConditioningZeroOut, VAEDecode, VAEEncode

from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .common_utils.temp_files import gjjutils_write_temp_tensor_images
from .common_utils.model_loader import (
    DEFAULT_UNET_DTYPE,
    gjjutils_load_clip_from_names as _load_clip_from_names,
    gjjutils_load_model as _load_model,
    gjjutils_load_vae as _load_vae,
)
from .gjj_model_bundle_loader import (
    list_clip_models,
    list_unet_models,
    list_vae_models,
)
# 移除外部依赖，在节点内部实现统一的缩放和补齐逻辑
from .gjj_multi_image_loader import build_uniform_batch_by_longest_edge


NODE_NAME = "GJJ_BatchWatermarkRemover"
MIXED_BATCH_IMAGE_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
DEFAULT_UNET = "flux-2-klein-4b"
DEFAULT_CLIP = "qwen_3_4b.safetensors"
DEFAULT_CLIP_FAMILY = Path(DEFAULT_CLIP).stem
DEFAULT_VAE = "flux2-vae.safetensors"
MODEL_FILTER_KEYWORDS = {
    "unet": ("flux-2-klein-4b", "flux-2-klein-base-4b", "f2k-4b", "f2k4b"),
    "clip": ("qwen_3_4b",),
    "vae": ("flux2-vae",),
}
DEFAULT_PROMPT = "clean all watermark,text,logo,signature,caption,overlay"
DEFAULT_NEGATIVE = ""
DEFAULT_FILENAME_PREFIX = "GJJ/批量去水印"
SIZE_MODES = ("保持输入尺寸", "使用工作尺寸")
UPSCALE_METHODS = ("nearest-exact", "bilinear", "bicubic", "lanczos", "area")
MODEL_CONFIGS = (
    {
        "label": "Flux2 Klein 4B",
        "unet": DEFAULT_UNET,
        "clip": DEFAULT_CLIP,
        "clip_family": DEFAULT_CLIP_FAMILY,
        "vae": DEFAULT_VAE,
    },
)
MISSING_MODEL_PREFIX = "缺失："

try:
    import folder_paths
except Exception:
    folder_paths = None


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync("gjj_node_progress", {"node": str(unique_id), "text": str(text or "")})
    except Exception:
        pass


def _ensure_image_batch(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise RuntimeError("批量去水印需要接入有效的 GJJ 批量图片张量。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise RuntimeError(f"批量去水印收到不支持的图片维度：{tuple(image.shape)}")
    if int(image.shape[0]) <= 0:
        raise RuntimeError("批量去水印至少需要一张图片。")
    image = image.detach().float()
    channels = int(image.shape[-1])
    if channels == 1:
        image = image.repeat(1, 1, 1, 3)
    elif channels >= 3:
        image = image[..., :3]
    else:
        raise RuntimeError(f"批量去水印收到不支持的通道数：{channels}")
    return image.clamp(0.0, 1.0).contiguous()


def _split_images(image: torch.Tensor) -> list[torch.Tensor]:
    values = list(image) if isinstance(image, (list, tuple)) else [image]
    images: list[torch.Tensor] = []
    for value in values:
        batch = _ensure_image_batch(value)
        images.extend(batch[index : index + 1].contiguous() for index in range(int(batch.shape[0])))
    return images


def _resize_image_exact(image: torch.Tensor, width: int, height: int, method: str = "lanczos") -> torch.Tensor:
    width = max(1, int(width))
    height = max(1, int(height))
    samples = image.movedim(-1, 1)
    scaled = comfy.utils.common_upscale(samples, width, height, str(method or "lanczos"), "disabled")
    return scaled.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _align_input_images(images: list[torch.Tensor], method: str = "lanczos") -> list[torch.Tensor]:
    """把所有输入图自动缩放到同一 W/H/C，避免批量路径因维度不同而中断。"""
    normalized = [_ensure_image_batch(image) for image in images]
    if not normalized:
        raise RuntimeError("批量去水印至少需要一张图片。")
    target_width = max(int(image.shape[2]) for image in normalized)
    target_height = max(int(image.shape[1]) for image in normalized)
    aligned: list[torch.Tensor] = []
    for image in normalized:
        if int(image.shape[2]) != target_width or int(image.shape[1]) != target_height:
            image = _resize_image_exact(image, target_width, target_height, method)
        aligned.append(image.contiguous())
    return aligned


def _hidden_widget(options: dict[str, Any]) -> dict[str, Any]:
    result = dict(options)
    result["hidden"] = True
    result["display"] = "hidden"
    return result


def _scale_to_total_pixels(image: torch.Tensor, megapixels: float, method: str) -> torch.Tensor:
    """按总像素数缩放图像"""
    target_pixels = max(0.05, float(megapixels)) * 1_000_000.0
    width = max(1, int(image.shape[2]))
    height = max(1, int(image.shape[1]))
    current_pixels = float(width * height)
    if current_pixels <= 0:
        return image
    scale = (target_pixels / current_pixels) ** 0.5
    new_width = max(16, int(round(width * scale / 8.0) * 8))
    new_height = max(16, int(round(height * scale / 8.0) * 8))
    if new_width == width and new_height == height:
        return image
    return _resize_image_exact(image, new_width, new_height, method)


def _pad_image_height(image: torch.Tensor, target_height: int, padding_mode: str = "center") -> torch.Tensor:
    """居中补齐图像高度"""
    current_height = int(image.shape[1])
    if current_height >= target_height:
        return image

    # 计算需要补齐的像素数
    pad_height = target_height - current_height
    pad_top = pad_height // 2 if padding_mode == "center" else 0
    pad_bottom = pad_height - pad_top

    # 创建黑色填充（RGB全0）
    batch_size = int(image.shape[0])
    width = int(image.shape[2])
    channels = int(image.shape[3])

    # 创建填充张量
    top_pad = torch.zeros(batch_size, pad_top, width, channels, device=image.device, dtype=image.dtype) if pad_top > 0 else None
    bottom_pad = torch.zeros(batch_size, pad_bottom, width, channels, device=image.device, dtype=image.dtype) if pad_bottom > 0 else None

    # 拼接
    parts = []
    if top_pad is not None:
        parts.append(top_pad)
    parts.append(image)
    if bottom_pad is not None:
        parts.append(bottom_pad)

    return torch.cat(parts, dim=1)


def _merge_output_images(images: list[torch.Tensor]) -> tuple[torch.Tensor, bool]:
    """合并输出图片，先按最大长边缩放，再居中补齐高度"""
    if not images:
        raise RuntimeError("没有可输出的去水印结果。")

    normalized = [_ensure_image_batch(image) for image in images]

    # 检查尺寸是否一致
    size_set = {(int(image.shape[2]), int(image.shape[1])) for image in normalized}
    if len(size_set) == 1:
        return torch.cat(normalized, dim=0).contiguous(), False

    # 尺寸不一致，需要统一处理
    # 第一遍：找到所有图片的最大长边
    max_longest_edge = 0
    for image in normalized:
        height = int(image.shape[1])
        width = int(image.shape[2])
        max_longest_edge = max(max_longest_edge, max(height, width))

    # 第二遍：按最大长边缩放，然后居中补齐高度
    scaled = []
    for image in normalized:
        height = int(image.shape[1])
        width = int(image.shape[2])
        longest_edge = max(height, width)

        # 按长边缩放到统一尺寸
        if longest_edge != max_longest_edge:
            scale_factor = max_longest_edge / longest_edge
            new_width = int(round(width * scale_factor / 8.0) * 8)
            new_height = int(round(height * scale_factor / 8.0) * 8)
            image = _resize_image_exact(image, new_width, new_height, "lanczos")

        # 如果高度不一致，居中补齐
        current_height = int(image.shape[1])
        if current_height < max_longest_edge:
            image = _pad_image_height(image, max_longest_edge, "center")

        scaled.append(image)

    return torch.cat(scaled, dim=0).contiguous(), True


def _output_root() -> Path:
    if folder_paths is not None:
        return Path(folder_paths.get_output_directory()).resolve()
    return Path.cwd().resolve() / "output"


def _sanitize_part(value: Any, fallback: str = "") -> str:
    text = re.sub(r'[<>:"|?*\x00-\x1f]', "_", str(value or "").strip())
    text = text.replace("\\", "/")
    text = re.sub(r"/+", "/", text)
    return text.strip(" /.") or fallback


def _resolve_output_prefix(filename_prefix: str) -> tuple[Path, str]:
    raw = _sanitize_part(filename_prefix, DEFAULT_FILENAME_PREFIX)
    parts = [part for part in raw.split("/") if part and part not in {".", ".."}]
    if not parts:
        parts = ["GJJ", "批量去水印"]
    directory = (_output_root() / Path(*parts[:-1])).resolve() if len(parts) > 1 else _output_root()
    root = _output_root()
    try:
        directory.relative_to(root)
    except ValueError as error:
        raise RuntimeError(f"文件名前缀越界：{filename_prefix}") from error
    directory.mkdir(parents=True, exist_ok=True)
    return directory, _sanitize_part(parts[-1], "批量去水印")


def _parse_selected_images(raw_value: Any) -> list[dict[str, str]]:
    try:
        parsed = json.loads(str(raw_value or "").strip() or "[]")
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    selected: list[dict[str, str]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        filename = str(item.get("filename") or "").strip()
        if filename:
            selected.append({"filename": filename, "subfolder": str(item.get("subfolder") or "").strip()})
    return selected


def _workflow_nodes_by_id(extra_pnginfo: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(extra_pnginfo, dict):
        return {}
    workflow = extra_pnginfo.get("workflow")
    if not isinstance(workflow, dict):
        return {}
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return {}
    return {str(node.get("id")): node for node in nodes if isinstance(node, dict) and node.get("id") is not None}


def _selected_images_from_workflow_node(node: dict[str, Any]) -> list[dict[str, str]]:
    properties = node.get("properties")
    if isinstance(properties, dict):
        selected = _parse_selected_images(properties.get("selected_images"))
        if selected:
            return selected
    widget_values = node.get("widgets_values")
    if isinstance(widget_values, list):
        for value in widget_values:
            selected = _parse_selected_images(value)
            if selected:
                return selected
    return []


def _resolve_source_filenames(workflow_prompt: Any, extra_pnginfo: Any, unique_id: Any) -> list[str]:
    if not isinstance(workflow_prompt, dict) or unique_id is None:
        return []
    current = workflow_prompt.get(str(unique_id)) or workflow_prompt.get(unique_id)
    if not isinstance(current, dict):
        return []
    inputs = current.get("inputs")
    if not isinstance(inputs, dict):
        return []
    image_link = inputs.get("image")
    if not isinstance(image_link, (list, tuple)) or not image_link:
        return []
    source_id = str(image_link[0])
    workflow_node = _workflow_nodes_by_id(extra_pnginfo).get(source_id)
    if not workflow_node:
        return []
    selected = _selected_images_from_workflow_node(workflow_node)
    return [str(item.get("filename") or "").strip() for item in selected if item.get("filename")]


def _name_from_regex(source_name: str, filename_regex: str, fallback: str) -> str:
    stem = Path(str(source_name or "")).stem or fallback
    pattern = str(filename_regex or "").strip()
    if not pattern:
        return _sanitize_part(stem, fallback)
    try:
        match = re.search(pattern, stem)
    except re.error as error:
        raise RuntimeError(f"文件名正则无效：{error}") from error
    if not match:
        return _sanitize_part(stem, fallback)
    if match.groups():
        value = next((group for group in match.groups() if group), match.group(0))
    else:
        value = match.group(0)
    return _sanitize_part(value, fallback)


def _tensor_to_uint8_image(tensor: torch.Tensor) -> np.ndarray:
    value = _ensure_image_batch(tensor)[0].detach().cpu().float().numpy()
    return np.clip(value * 255.0, 0, 255).astype(np.uint8)


def _next_png_path(directory: Path, stem: str) -> Path:
    safe_stem = _sanitize_part(stem, "批量去水印").replace("/", "_")
    index = 1
    while True:
        path = directory / f"{safe_stem}_{index:05d}.png"
        if not path.exists():
            return path
        index += 1


def _png_metadata(prompt: Any, extra_pnginfo: Any) -> PngImagePlugin.PngInfo | None:
    metadata = PngImagePlugin.PngInfo()
    wrote = False
    if prompt is not None:
        try:
            metadata.add_text("prompt", json.dumps(prompt, ensure_ascii=False))
            wrote = True
        except Exception:
            pass
    if isinstance(extra_pnginfo, dict):
        for key, value in extra_pnginfo.items():
            try:
                metadata.add_text(str(key), json.dumps(value, ensure_ascii=False))
                wrote = True
            except Exception:
                pass
    return metadata if wrote else None


def _save_result_images(
    images: list[torch.Tensor],
    filename_prefix: str,
    filename_regex: str,
    source_filenames: list[str],
    workflow_prompt: Any,
    extra_pnginfo: Any,
) -> tuple[list[dict[str, str]], list[str]]:
    directory, base_name = _resolve_output_prefix(filename_prefix)
    metadata = _png_metadata(workflow_prompt, extra_pnginfo)
    previews: list[dict[str, str]] = []
    saved_paths: list[str] = []
    output_root = _output_root()
    for index, image in enumerate(images, start=1):
        source_name = source_filenames[index - 1] if index - 1 < len(source_filenames) else ""
        suffix = _name_from_regex(source_name, filename_regex, f"{index:03d}")
        stem = f"{base_name}_{suffix}" if suffix else f"{base_name}_{index:03d}"
        path = _next_png_path(directory, stem)
        Image.fromarray(_tensor_to_uint8_image(image)).save(path, pnginfo=metadata)
        saved_paths.append(str(path))
        try:
            relative = path.resolve().relative_to(output_root)
            previews.append(
                {
                    "filename": relative.name,
                    "subfolder": str(relative.parent).replace("\\", "/") if str(relative.parent) != "." else "",
                    "type": "output",
                    "path": str(path),
                }
            )
        except Exception:
            pass
    return previews, saved_paths


from .common_utils.flux2_tools import (
    gjjutils_append_reference_latent,
    gjjutils_encode_text,
    gjjutils_zero_out_conditioning,
)


def _model_basename(value: Any) -> str:
    return str(value or "").replace("\\", "/").split("/")[-1].strip()


def _model_stem(value: Any) -> str:
    name = _model_basename(value)
    lower = name.lower()
    for extension in (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf"):
        if lower.endswith(extension):
            return name[: -len(extension)]
    return name


def _model_key(value: Any) -> str:
    return _model_stem(value).lower()


def _is_keyword_model_name(value: Any) -> bool:
    name = _model_basename(value).lower()
    return not name.endswith((".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf"))


def _model_matches_required(candidate: Any, required_name: str) -> bool:
    candidate_key = _model_key(candidate)
    required_key = _model_key(required_name)
    if not candidate_key or not required_key:
        return False
    if candidate_key == required_key:
        return True
    if not _is_keyword_model_name(required_name):
        return False
    # Qwen3-VL and the text-only Qwen3 encoder are different architectures.
    # A loose token match (qwen + 3 + 4b) used to admit qwen3vl_4b here,
    # which then failed inside the text encoder with incompatible matrix sizes.
    candidate_compact = re.sub(r"[^a-z0-9]+", "", candidate_key)
    required_compact = re.sub(r"[^a-z0-9]+", "", required_key)
    if "qwen3vl" in candidate_compact and "qwen3vl" not in required_compact:
        return False
    if required_key in candidate_key:
        return True
    tokens = [token.lower() for token in re.split(r"[^A-Za-z0-9]+", str(required_name or "")) if token]
    return bool(tokens) and all(token in candidate_key for token in tokens)


def _strip_missing_model_label(value: Any) -> str:
    text = str(value or "").strip()
    if text.startswith(MISSING_MODEL_PREFIX):
        return text[len(MISSING_MODEL_PREFIX) :].strip()
    return text


def _find_required_model(available: list[str], required_name: str) -> str:
    for candidate in available or []:
        candidate_text = str(candidate or "").strip()
        if _model_matches_required(candidate_text, required_name):
            return candidate_text
    return ""


def _required_model_choices(available: list[str], required_names: tuple[str, ...]) -> list[str]:
    choices = [
        str(candidate or "").strip()
        for candidate in available or []
        if any(_model_matches_required(candidate, required_name) for required_name in required_names)
    ]
    choices = list(dict.fromkeys(item for item in choices if item))
    return choices or [f"{MISSING_MODEL_PREFIX}{required_names[0]}"]


def _selected_required_name(requested: Any, required_names: tuple[str, ...]) -> str:
    requested_text = _strip_missing_model_label(requested)
    for required_name in required_names:
        if _model_matches_required(requested_text, required_name):
            return required_name
    return ""


def _default_required_choice(choices: list[str], preferred: str) -> str:
    for choice in choices:
        if not str(choice).startswith(MISSING_MODEL_PREFIX) and _model_matches_required(choice, preferred):
            return choice
    for choice in choices:
        if not str(choice).startswith(MISSING_MODEL_PREFIX):
            return choice
    return choices[0] if choices else f"{MISSING_MODEL_PREFIX}{preferred}"


def _allowed_required_names(key: str) -> tuple[str, ...]:
    return MODEL_FILTER_KEYWORDS[key]


def _resolve_required_model(requested: Any, available: list[str], required_names: tuple[str, ...], label: str, folder: str) -> str:
    requested_text = _strip_missing_model_label(requested)
    required_name = _selected_required_name(requested_text, required_names)
    if not required_name:
        allowed = "、".join(required_names)
        raise RuntimeError(f"{label} 只能使用指定模型：{allowed}；当前选择：{requested_text or '空'}。")
    for candidate in available or []:
        candidate_text = str(candidate or "").strip()
        if _model_key(candidate_text) == _model_key(requested_text) and _model_matches_required(candidate_text, required_name):
            return candidate_text
    resolved = _find_required_model(available, required_name)
    if resolved:
        return resolved
    raise RuntimeError(
        f"未找到 {label} 模型：{required_name}\n"
        f"请放到 ComfyUI/models/{folder}/ 后刷新模型列表；本节点不会使用其它模型替代。"
    )


def _selected_config_for_unet(unet_name: Any) -> dict[str, str]:
    selected = _strip_missing_model_label(unet_name)
    if any(_model_matches_required(selected, keyword) for keyword in _allowed_required_names("unet")):
        return MODEL_CONFIGS[0]
    allowed = "、".join(_allowed_required_names("unet"))
    raise RuntimeError(f"UNET 主模型只能使用指定模型：{allowed}。")


def _validate_model_config(unet_name: Any, clip_name: Any, vae_name: Any) -> dict[str, str]:
    config = _selected_config_for_unet(unet_name)
    if not any(
        _model_matches_required(_strip_missing_model_label(clip_name), keyword)
        for keyword in _allowed_required_names("clip")
    ):
        raise RuntimeError(
            f"{config['label']} 必须搭配 {config['clip_family']} 模型族的 CLIP（量化后缀不限）；"
            f"当前选择：{_strip_missing_model_label(clip_name) or '空'}。"
        )
    if not any(
        _model_matches_required(_strip_missing_model_label(vae_name), keyword)
        for keyword in _allowed_required_names("vae")
    ):
        raise RuntimeError(
            f"{config['label']} 必须搭配 VAE：{config['vae']}；"
            f"当前选择：{_strip_missing_model_label(vae_name) or '空'}。"
        )
    return config


def _process_single_image(
    image: torch.Tensor,
    model,
    clip,
    vae,
    prompt: str,
    negative_prompt: str,
    working_megapixels: float,
    scale_method: str,
    output_size_mode: str,
    target_longest_edge: int | None,
    steps: int,
    cfg: float,
    seed: int,
    unique_id: Any,
    suffix: str,
) -> torch.Tensor:
    source = _ensure_image_batch(image)
    source_width = int(source.shape[2])
    source_height = int(source.shape[1])
    working = _scale_to_total_pixels(source, working_megapixels, scale_method)
    width = int(working.shape[2])
    height = int(working.shape[1])

    _send_status(unique_id, f"编码参考图{suffix}...")
    reference_latent = VAEEncode().encode(vae, working)[0]["samples"]
    positive = gjjutils_append_reference_latent(gjjutils_encode_text(clip, prompt), reference_latent)
    negative_base = gjjutils_encode_text(clip, negative_prompt) if str(negative_prompt or "").strip() else gjjutils_zero_out_conditioning(gjjutils_encode_text(clip, prompt))
    negative = gjjutils_append_reference_latent(negative_base, reference_latent)

    _send_status(unique_id, f"采样去水印{suffix}...")
    latent = EmptyFlux2LatentImage.execute(width, height, 1)[0]
    sigmas = Flux2Scheduler.execute(int(steps), width, height)[0]
    sampler = KSamplerSelect.execute("euler")[0]
    noise = RandomNoise.execute(int(seed))[0]
    guider = CFGGuider.execute(model, positive, negative, float(cfg))[0]
    sampled = SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, latent)[0]

    _send_status(unique_id, f"解码结果{suffix}...")
    result = VAEDecode().decode(vae, sampled)[0]

    # 如果指定了目标长边，则缩放到该尺寸
    if target_longest_edge is not None and output_size_mode == "保持输入尺寸":
        result_height = int(result.shape[1])
        result_width = int(result.shape[2])
        result_longest_edge = max(result_height, result_width)

        if result_longest_edge != target_longest_edge:
            # 计算缩放比例
            scale_factor = target_longest_edge / result_longest_edge
            new_width = max(16, int(round(result_width * scale_factor / 8.0) * 8))
            new_height = max(16, int(round(result_height * scale_factor / 8.0) * 8))
            result = _resize_image_exact(result, new_width, new_height, scale_method)

    return result.clamp(0.0, 1.0).contiguous()


class GJJ_BatchWatermarkRemover:
    DESCRIPTION = "批量去除水印单节点。借鉴 Flux2 Klein 参考图重绘思路，不依赖 Florence、KJ、CropStitch、WAS 等第三方节点；输入和主输出兼容 GJJ 批量图片与普通 IMAGE 批量。"
    SEARCH_ALIASES = ["批量去水印", "水印去除", "watermark remover", "klein", "Flux2 Klein", "文字去除", "logo去除"]
    RETURN_TYPES = (MIXED_BATCH_IMAGE_TYPE,)
    RETURN_NAMES = ("批量图片",)
    OUTPUT_TOOLTIPS = (
        "全部去水印结果输出为兼容 GJJ_BATCH_IMAGE 与 IMAGE 的批量图片；尺寸不一致时会自动通过长边缩放统一为相同尺寸。",
    )
    FUNCTION = "remove"
    OUTPUT_NODE = True
    CATEGORY = "GJJ/💗 一键生成"
    MODEL_TREE = [
        {
            "label": "4B UNET 主模型",
            "filename": DEFAULT_UNET,
            "folder": "models/diffusion_models",
            "input": "unet_name",
            "type": "UNET",
            "kind": "Flux2 Klein",
            "tooltip": "可放在 diffusion_models 子目录下；文件名需包含允许的 Flux2 Klein 4B 关键词之一，量化后缀不限。",
        },
        {
            "label": "4B CLIP 文本编码器",
            "filename": DEFAULT_CLIP,
            "folder": "models/text_encoders",
            "input": "clip_name",
            "type": "CLIP",
            "kind": "Flux2",
            "tooltip": "可放在 text_encoders 子目录下；匹配 qwen_3_4b 模型族，支持原精度与兼容量化版本，并按 flux2 文本编码器加载。",
        },
        {
            "label": "Flux2 VAE",
            "filename": DEFAULT_VAE,
            "folder": "models/vae",
            "input": "vae_name",
            "type": "VAE",
            "kind": "Flux2",
            "tooltip": "可放在 vae 子目录下；用于编码输入参考图并解码去水印结果。",
        },
    ]
    GJJ_HELP = {
        "title": "GJJ · 🧼 批量去水印",
        "description": DESCRIPTION,
        "notice": "仅支持 Flux2 Klein 4B + qwen_3_4b 模型族 + flux2-vae。qwen_3_4b 文本编码器可选择原精度、FP8、INT4/INT8 ConvRot 或 GGUF 版本。",
        "model_download_url": "",
        "models": [
            {
                "label": "4B UNET 主模型",
                "filename": DEFAULT_UNET,
                "folder": "diffusion_models",
                "input": "unet_name",
                "type": "UNET",
                "kind": "Flux2 Klein",
                "tooltip": "4B 去水印重绘主模型；严格匹配允许的 Flux2 Klein 4B 关键词之一，量化后缀不限。",
            },
            {
                "label": "4B CLIP 文本编码器",
                "filename": DEFAULT_CLIP,
                "folder": "text_encoders",
                "input": "clip_name",
                "type": "CLIP",
                "kind": "Flux2",
                "tooltip": "4B 配置专用 Qwen 文本编码器；节点按 flux2 类型加载。",
            },
            {
                "label": "Flux2 VAE",
                "filename": DEFAULT_VAE,
                "folder": "vae",
                "input": "vae_name",
                "type": "VAE",
                "kind": "Flux2",
                "tooltip": "Flux2 VAE，用于参考图编码和结果解码。",
            },
        ],
        "model_tree": MODEL_TREE,
        "models_tree": MODEL_TREE,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "dependencies": [
            "ComfyUI 内置 Flux2 采样相关节点：EmptyFlux2LatentImage、Flux2Scheduler、SamplerCustomAdvanced。",
            "无 Florence、KJ、CropStitch、WAS 等第三方自定义节点依赖。",
        ],
        "usage": [
            "输入兼容 GJJ_BATCH_IMAGE 与普通 IMAGE 批量；可接 GJJ 批量多图片加载预览器、批量图片包装器或普通 IMAGE 输出。",
            "UNET 下拉只列出匹配 flux-2-klein-4b、flux-2-klein-base-4b、f2k-4b 或 f2k4b 的模型；CLIP 下拉只列出 qwen_3_4b 模型族，并支持不同量化后缀。",
            "工作像素量越大，去水印细节可能更稳，但显存和耗时也会增加。",
            "自动保存开启后，会把结果写入 ComfyUI output 下的文件名前缀目录。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        available_unets = list_unet_models() or []
        available_clips = list_clip_models() or []
        available_vaes = list_vae_models() or []
        unet_models = _required_model_choices(available_unets, _allowed_required_names("unet"))
        clip_families = tuple(str(config["clip_family"]) for config in MODEL_CONFIGS)
        clip_models = _required_model_choices(available_clips, clip_families)
        vae_models = _required_model_choices(available_vaes, _allowed_required_names("vae"))
        complete_config = next(
            (
                config
                for config in MODEL_CONFIGS
                if _find_required_model(available_unets, config["unet"])
                and _find_required_model(available_clips, config["clip"])
                and _find_required_model(available_vaes, config["vae"])
            ),
            MODEL_CONFIGS[0],
        )
        return {
            "required": {
                "image": (
                    MIXED_BATCH_IMAGE_TYPE,
                    {
                        "display_name": "批量图片",
                        "tooltip": "兼容 GJJ_BATCH_IMAGE 与普通 IMAGE 批量；可接 GJJ 批量多图片加载预览器、批量图片包装器或普通 IMAGE 输出。",
                    },
                ),
                "prompt": (
                    "STRING",
                    _hidden_widget({
                        "default": DEFAULT_PROMPT,
                        "multiline": False,
                        "display_name": "去水印提示词",
                        "tooltip": "描述要清理的覆盖物。默认按参考工作流清理 watermark、text、logo、signature、caption、overlay。",
                    }),
                ),
                "negative_prompt": (
                    "STRING",
                    _hidden_widget({
                        "default": DEFAULT_NEGATIVE,
                        "multiline": False,
                        "display_name": "反向提示词",
                        "tooltip": "可选。留空时使用参考工作流的 ConditioningZeroOut 方式。",
                    }),
                ),
                "unet_name": (
                    unet_models,
                    _hidden_widget({
                        "default": _default_required_choice(unet_models, complete_config["unet"]),
                        "gjj_default_model": complete_config["unet"],
                        "display_name": "🟣 UNET 主模型",
                        "tooltip": "只允许文件名包含 flux-2-klein-4b、flux-2-klein-base-4b、f2k-4b 或 f2k4b。显示“缺失：名称”表示未在 models/diffusion_models 找到，节点不会用无关文件替代。",
                    }),
                ),
                "clip_name": (
                    clip_models,
                    _hidden_widget({
                        "default": _default_required_choice(clip_models, complete_config["clip"]),
                        "gjj_default_model": complete_config["clip"],
                        "display_name": "🔤 CLIP 文本编码器",
                        "tooltip": "仅显示 qwen_3_4b 模型族；支持原精度、FP8、INT4/INT8 ConvRot 与 GGUF 量化文件。",
                    }),
                ),
                "vae_name": (
                    vae_models,
                    _hidden_widget({
                        "default": _default_required_choice(vae_models, complete_config["vae"]),
                        "gjj_default_model": complete_config["vae"],
                        "display_name": "🧩 VAE",
                        "tooltip": "只允许文件名包含 flux2-vae。显示“缺失：文件名”表示未在 models/vae 找到。",
                    }),
                ),
                "working_megapixels": (
                    "FLOAT",
                    _hidden_widget({
                        "default": 1.0,
                        "min": 0.05,
                        "max": 16.0,
                        "step": 0.05,
                        "display_name": "工作像素量 MP",
                        "tooltip": "送入 Klein 重绘前的工作分辨率，参考工作流为 1 MP。数值越大越慢、显存占用越高。",
                    }),
                ),
                "output_size_mode": (
                    SIZE_MODES,
                    _hidden_widget({
                        "default": "保持输入尺寸",
                        "display_name": "输出尺寸",
                        "tooltip": "保持输入尺寸会在重绘后缩放回原图尺寸；使用工作尺寸则输出实际采样尺寸。",
                    }),
                ),
                "scale_method": (
                    UPSCALE_METHODS,
                    _hidden_widget({
                        "default": "nearest-exact",
                        "display_name": "缩放算法",
                        "tooltip": "用于工作分辨率缩放和可选的回原尺寸缩放；默认对齐参考 workflow。",
                    }),
                ),
                "steps": (
                    "INT",
                    _hidden_widget({
                        "default": 4,
                        "min": 1,
                        "max": 100,
                        "step": 1,
                        "display_name": "采样步数",
                        "tooltip": "参考 workflow 使用 4 步。",
                    }),
                ),
                "cfg": (
                    "FLOAT",
                    _hidden_widget({
                        "default": 1.0,
                        "min": 0.0,
                        "max": 20.0,
                        "step": 0.1,
                        "display_name": "CFG",
                        "tooltip": "参考 workflow 使用 1.0。",
                    }),
                ),
                "seed": (
                    "INT",
                    _hidden_widget({
                        "default": 352628917855609,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "批量处理时会按图片序号自动递增，避免每张图完全同噪声。",
                    }),
                ),
                "auto_save": (
                    "BOOLEAN",
                    _hidden_widget({
                        "default": False,
                        "display_name": "自动保存",
                        "label_on": "保存",
                        "label_off": "不保存",
                        "tooltip": "开启后会把每张去水印结果保存到 ComfyUI output 目录，并在节点面板显示保存预览。",
                    }),
                ),
                "filename_prefix": (
                    "STRING",
                    _hidden_widget({
                        "default": DEFAULT_FILENAME_PREFIX,
                        "multiline": False,
                        "display_name": "文件名前缀",
                        "tooltip": "保存到 output 下的相对前缀，支持子目录，例如 GJJ/批量去水印。",
                    }),
                ),
                "filename_regex": (
                    "STRING",
                    _hidden_widget({
                        "default": "",
                        "multiline": False,
                        "display_name": "来源名正则",
                        "tooltip": "可选。上游来自批量多图片加载预览器时，对原文件名应用此正则；有捕获组则用第一个非空捕获组作为保存名后缀。",
                    }),
                ),
                "keep_model": (
                    "BOOLEAN",
                    _hidden_widget({
                        "default": False,
                        "display_name": "保持模型",
                        "label_on": "保持",
                        "label_off": "释放",
                        "tooltip": "开启后保留已加载的 Klein、CLIP 和 VAE，连续执行更快但会继续占用显存；关闭后执行结束即释放模型。",
                    }),
                ),
            },
            "hidden": {
                "workflow_prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def remove(
        self,
        image,
        prompt,
        negative_prompt,
        unet_name,
        clip_name,
        vae_name,
        working_megapixels,
        output_size_mode,
        scale_method,
        steps,
        cfg,
        seed,
        auto_save=False,
        filename_prefix=DEFAULT_FILENAME_PREFIX,
        filename_regex="",
        keep_model=False,
        workflow_prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        try:
            input_images = _align_input_images(_split_images(image), scale_method)

            _send_status(unique_id, "1/4 解析并加载 Klein / CLIP / VAE...")
            _validate_model_config(unet_name, clip_name, vae_name)
            resolved_unet = _resolve_required_model(
                unet_name,
                list_unet_models() or [],
                _allowed_required_names("unet"),
                "UNET 主模型",
                "diffusion_models",
            )
            resolved_clip = _resolve_required_model(
                clip_name,
                list_clip_models() or [],
                tuple(str(config["clip_family"]) for config in MODEL_CONFIGS),
                "CLIP 文本编码器",
                "text_encoders",
            )
            resolved_vae = _resolve_required_model(
                vae_name,
                list_vae_models() or [],
                _allowed_required_names("vae"),
                "VAE",
                "vae",
            )
            model = _load_model(resolved_unet, DEFAULT_UNET_DTYPE)
            clip = _load_clip_from_names([resolved_clip], "flux2")
            vae = _load_vae(resolved_vae)

            total = len(input_images)
            results: list[torch.Tensor] = []

            # 计算所有输入图片在工作尺寸下的最大长边（用于统一输出尺寸）
            max_longest_edge = 0
            if output_size_mode == "保持输入尺寸":
                for single_image in input_images:
                    source = _ensure_image_batch(single_image)
                    # 先缩放到工作尺寸
                    working = _scale_to_total_pixels(source, working_megapixels, scale_method)
                    work_height = int(working.shape[1])
                    work_width = int(working.shape[2])
                    max_longest_edge = max(max_longest_edge, max(work_height, work_width))

            for index, single_image in enumerate(input_images, start=1):
                suffix = f"（第 {index}/{total} 张）" if total > 1 else ""
                _send_status(unique_id, f"2/4 准备图片{suffix}...")
                results.append(
                    _process_single_image(
                        single_image,
                        model,
                        clip,
                        vae,
                        prompt,
                        negative_prompt,
                        working_megapixels,
                        scale_method,
                        output_size_mode,
                        max_longest_edge if output_size_mode == "保持输入尺寸" else None,
                        steps,
                        cfg,
                        int(seed) + index - 1,
                        unique_id,
                        suffix,
                    )
                )

            result, used_padding = _merge_output_images(results)
            width = int(result.shape[2])
            height = int(result.shape[1])
            if used_padding:
                _send_status(unique_id, f"4/4 完成：{len(results)} 张，已缩放统一尺寸到 {width} x {height}")
            else:
                _send_status(unique_id, f"4/4 完成：{len(results)} 张，尺寸 {width} x {height}")
            preview_images = gjjutils_write_temp_tensor_images(result)
            if bool(auto_save):
                source_filenames = _resolve_source_filenames(workflow_prompt, extra_pnginfo, unique_id)
                _saved_output_images, saved_paths = _save_result_images(
                    results,
                    filename_prefix,
                    filename_regex,
                    source_filenames,
                    workflow_prompt,
                    extra_pnginfo,
                )
                _send_status(unique_id, f"已自动保存 {len(saved_paths)} 张结果图。")
                return {
                    "ui": {
                        "preview_images": preview_images,
                        "preview_text": [
                            "已自动保存 "
                            + str(len(saved_paths))
                            + " 张结果图。\n"
                            + "\n".join(f"{index}. {path}" for index, path in enumerate(saved_paths[:20], start=1))
                        ],
                        "saved_paths": saved_paths,
                    },
                    "result": (result,),
                }
            return {
                "ui": {
                    "preview_images": preview_images,
                    "preview_text": [f"已完成 {len(results)} 张去水印，未自动保存。"],
                },
                "result": (result,),
            }
        except RuntimeError as exc:
            _send_status(unique_id, f"执行失败：{str(exc).splitlines()[0]}")
            raise
        except Exception as exc:
            _send_status(unique_id, "执行失败")
            raise RuntimeError(f"批量去水印执行失败。\n详细错误：{exc}") from exc
        finally:
            if not bool(keep_model):
                try:
                    import comfy.model_management as model_management

                    model_management.unload_all_models()
                    model_management.soft_empty_cache()
                except Exception as release_exc:
                    print(f"[GJJ BatchWatermarkRemover] 释放模型失败: {release_exc}")


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_BatchWatermarkRemover}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧼 一键批量去图片水印（Flux2-4b）"}
