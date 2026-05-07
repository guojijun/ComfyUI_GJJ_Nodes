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
from .gjj_lazy_image_studio import (
    DEFAULT_UNET_DTYPE,
    _load_clip_from_names,
    _load_model,
    _load_vae,
)
from .gjj_model_bundle_loader import (
    list_clip_models,
    list_unet_models,
    list_vae_models,
)
# 移除外部依赖，在节点内部实现统一的缩放和补齐逻辑
from .gjj_multi_image_loader import build_uniform_batch_by_longest_edge


NODE_NAME = "GJJ_BatchWatermarkRemover"
DEFAULT_UNET = "flux-2-klein-4b-fp8.safetensors"
DEFAULT_CLIP = "qwen_3_4b.safetensors"
DEFAULT_VAE = "flux2-vae.safetensors"
DEFAULT_PROMPT = "clean all watermark,text,logo,signature,caption,overlay"
DEFAULT_NEGATIVE = ""
DEFAULT_FILENAME_PREFIX = "GJJ/批量去水印"
SIZE_MODES = ("保持输入尺寸", "使用工作尺寸")
UPSCALE_METHODS = ("nearest-exact", "bilinear", "bicubic", "lanczos", "area")

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
    batch = _ensure_image_batch(image)
    return [batch[index : index + 1].contiguous() for index in range(int(batch.shape[0]))]


def _resize_image_exact(image: torch.Tensor, width: int, height: int, method: str = "lanczos") -> torch.Tensor:
    width = max(1, int(width))
    height = max(1, int(height))
    samples = image.movedim(-1, 1)
    scaled = comfy.utils.common_upscale(samples, width, height, str(method or "lanczos"), "disabled")
    return scaled.movedim(1, -1).clamp(0.0, 1.0).contiguous()


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
from .common_utils.text_tools import gjjutils_pick_available_name


def _resolve_from_category(category: str, requested: str, label: str) -> str:
    """从指定类别中解析模型名称"""
    if category == "vae":
        available = list_vae_models() or [DEFAULT_VAE]
    elif category == "diffusion_models":
        available = list_unet_models() or [DEFAULT_UNET]
    elif category == "text_encoders":
        available = list_clip_models() or [DEFAULT_CLIP]
    else:
        # 回退到通用方法
        try:
            import folder_paths
            available = folder_paths.get_filename_list(category)
        except Exception:
            available = []

    from .common_utils.text_tools import gjjutils_pick_available_name
    resolved = gjjutils_pick_available_name(requested, available, requested)
    if not resolved:
        raise RuntimeError(f"未找到{label}模型：{requested}")
    return resolved


def _resolve_unet_name(requested: str) -> str:
    """解析 UNET 模型名称"""
    from .common_utils.text_tools import gjjutils_pick_available_name
    available = list_unet_models() or [DEFAULT_UNET]
    resolved = gjjutils_pick_available_name(requested, available, DEFAULT_UNET)
    if not resolved:
        raise RuntimeError(f"未找到 UNET 模型：{requested}")
    return resolved


def _resolve_clip_name(requested: str) -> str:
    """解析 CLIP 模型名称"""
    from .common_utils.text_tools import gjjutils_pick_available_name
    available = list_clip_models() or [DEFAULT_CLIP]
    resolved = gjjutils_pick_available_name(requested, available, DEFAULT_CLIP)
    if not resolved:
        raise RuntimeError(f"未找到 CLIP 模型：{requested}")
    return resolved


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
    DESCRIPTION = "批量去除水印单节点。借鉴 Flux2 Klein 参考图重绘思路，不依赖 Florence、KJ、CropStitch、WAS 等第三方节点；输入和主输出均为 GJJ 专用批量图片。"
    SEARCH_ALIASES = ["批量去水印", "水印去除", "watermark remover", "klein", "Flux2 Klein", "文字去除", "logo去除"]
    RETURN_TYPES = (GJJ_BATCH_IMAGE_TYPE,)
    RETURN_NAMES = ("批量图片",)
    OUTPUT_TOOLTIPS = (
        "全部去水印结果打包成 GJJ 专用批量图片；尺寸不一致时会自动通过长边缩放统一为相同尺寸。需要单图时请接 GJJ 批量图片解包/预览类节点。",
    )
    FUNCTION = "remove"
    OUTPUT_NODE = True
    CATEGORY = "GJJ"

    @classmethod
    def INPUT_TYPES(cls):
        unet_models = list_unet_models() or [DEFAULT_UNET]
        clip_models = list_clip_models() or [DEFAULT_CLIP]
        vae_models = list_vae_models() or [DEFAULT_VAE]
        return {
            "required": {
                "image": (
                    GJJ_BATCH_IMAGE_TYPE,
                    {
                        "display_name": "批量图片",
                        "tooltip": "接入 GJJ · 批量多图片加载预览器 或 GJJ · 批量图片包装器 输出的 GJJ 批量图片。",
                    },
                ),
                "prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_PROMPT,
                        "multiline": False,
                        "display_name": "去水印提示词",
                        "tooltip": "描述要清理的覆盖物。默认按参考工作流清理 watermark、text、logo、signature、caption、overlay。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE,
                        "multiline": False,
                        "display_name": "反向提示词",
                        "tooltip": "可选。留空时使用参考工作流的 ConditioningZeroOut 方式。",
                    },
                ),
                "unet_name": (
                    unet_models,
                    {
                        "default": gjjutils_pick_available_name(DEFAULT_UNET, unet_models, DEFAULT_UNET),
                        "display_name": "🟣 UNET 主模型",
                        "tooltip": "默认对齐参考工作流的 flux-2-klein-4b-fp8.safetensors；会从本地 diffusion_models/checkpoints 列表中解析。",
                    },
                ),
                "clip_name": (
                    clip_models,
                    {
                        "default": gjjutils_pick_available_name(DEFAULT_CLIP, clip_models, DEFAULT_CLIP),
                        "display_name": "🔤 CLIP 文本编码器",
                        "tooltip": "默认对齐参考工作流的 qwen_3_4b.safetensors；类型固定按 flux2 加载。",
                    },
                ),
                "vae_name": (
                    vae_models,
                    {
                        "default": gjjutils_pick_available_name(DEFAULT_VAE, vae_models, DEFAULT_VAE),
                        "display_name": "🧩 VAE",
                        "tooltip": "默认对齐参考工作流的 flux2-vae.safetensors。",
                    },
                ),
                "working_megapixels": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.05,
                        "max": 16.0,
                        "step": 0.05,
                        "display_name": "工作像素量 MP",
                        "tooltip": "送入 Klein 重绘前的工作分辨率，参考工作流为 1 MP。数值越大越慢、显存占用越高。",
                    },
                ),
                "output_size_mode": (
                    SIZE_MODES,
                    {
                        "default": "保持输入尺寸",
                        "display_name": "输出尺寸",
                        "tooltip": "保持输入尺寸会在重绘后缩放回原图尺寸；使用工作尺寸则输出实际采样尺寸。",
                    },
                ),
                "scale_method": (
                    UPSCALE_METHODS,
                    {
                        "default": "nearest-exact",
                        "display_name": "缩放算法",
                        "tooltip": "用于工作分辨率缩放和可选的回原尺寸缩放；默认对齐参考 workflow。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 4,
                        "min": 1,
                        "max": 100,
                        "step": 1,
                        "display_name": "采样步数",
                        "tooltip": "参考 workflow 使用 4 步。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 20.0,
                        "step": 0.1,
                        "display_name": "CFG",
                        "tooltip": "参考 workflow 使用 1.0。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 352628917855609,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "批量处理时会按图片序号自动递增，避免每张图完全同噪声。",
                    },
                ),
                "auto_save": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "自动保存",
                        "label_on": "保存",
                        "label_off": "不保存",
                        "tooltip": "开启后会把每张去水印结果保存到 ComfyUI output 目录，并在节点面板显示保存预览。",
                    },
                ),
                "filename_prefix": (
                    "STRING",
                    {
                        "default": DEFAULT_FILENAME_PREFIX,
                        "multiline": False,
                        "display_name": "文件名前缀",
                        "tooltip": "保存到 output 下的相对前缀，支持子目录，例如 GJJ/批量去水印。",
                    },
                ),
                "filename_regex": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "来源名正则",
                        "tooltip": "可选。上游来自批量多图片加载预览器时，对原文件名应用此正则；有捕获组则用第一个非空捕获组作为保存名后缀。",
                    },
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
        workflow_prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        try:
            input_images = _split_images(image)

            _send_status(unique_id, "1/4 解析并加载 Klein / CLIP / VAE...")
            resolved_unet = _resolve_unet_name(unet_name)
            resolved_clip = _resolve_clip_name(clip_name)
            resolved_vae = _resolve_from_category("vae", vae_name, "VAE")
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
            if bool(auto_save):
                source_filenames = _resolve_source_filenames(workflow_prompt, extra_pnginfo, unique_id)
                preview_images, saved_paths = _save_result_images(
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
            return {"ui": {"preview_text": [f"已完成 {len(results)} 张去水印，未自动保存。"]}, "result": (result,)}
        except RuntimeError as exc:
            _send_status(unique_id, f"执行失败：{str(exc).splitlines()[0]}")
            raise
        except Exception as exc:
            _send_status(unique_id, "执行失败")
            raise RuntimeError(f"批量去水印执行失败。\n详细错误：{exc}") from exc


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_BatchWatermarkRemover}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧼 批量去水印"}
