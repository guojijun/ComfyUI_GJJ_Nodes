from __future__ import annotations

import os
from io import BytesIO
from typing import Any

import numpy as np
import torch
import comfy.utils
import folder_paths
from comfy import model_management as mm

from .common_utils.dependency_checker import (
    make_missing_model_spec,
    raise_dependency_model_error,
)
from .common_utils.temp_files import gjjutils_write_temp_bytes, gjjutils_write_temp_tensor_images


NODE_NAME = "GJJ_MidasDepthMapPreprocessor"
NODE_DISPLAY_NAME = "🕳️ 米达斯深度图预处理器"
DESCRIPTION = (
    "复刻米达斯深度图预处理器的 GJJ 零外部自定义节点版本。"
    "节点内加载米达斯深度模型，把图片、批量图片或 VIDEO 逐帧转换为深度视频帧序列，并使用 GJJ 公共临时文件缓存生成预览。"
)
MAX_RESOLUTION = 16384
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
FRAME_OUTPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
WEBP_PREVIEW_FPS = 8.0
WEBP_PREVIEW_MAX_FRAMES = 64
WEBP_PREVIEW_MAX_EDGE = 768

MODEL_CHOICES = {
    "混合版（推荐）": "Intel/dpt-hybrid-midas",
    "大模型": "Intel/dpt-large",
}
DEFAULT_MODEL_LABEL = "混合版（推荐）"
LOCAL_MODEL_DIR_NAMES = {
    "Intel/dpt-hybrid-midas": "dpt-hybrid-midas",
    "Intel/dpt-large": "dpt-large",
}

REQUIRED_MODELS = [
    make_missing_model_spec(
        label="米达斯混合版深度模型",
        subdir="models/midas",
        filename="dpt-hybrid-midas",
        description="可使用本地模型缓存，也可把完整模型目录放入 models/midas/dpt-hybrid-midas。",
    )
]


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _extract_image_tensor(value: Any, seen: set[int] | None = None) -> torch.Tensor | None:
    if value is None:
        return None
    if seen is None:
        seen = set()
    value_id = id(value)
    if value_id in seen:
        return None
    seen.add(value_id)

    if torch.is_tensor(value):
        return value

    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception as exc:
            raise RuntimeError(f"米达斯深度图读取 VIDEO 帧失败：{exc}") from exc
        tensor = _extract_image_tensor(_component_value(components, "images"), seen)
        if tensor is None:
            raise RuntimeError("米达斯深度图收到的 VIDEO 没有解析出可用图片帧。")
        return tensor

    if isinstance(value, dict):
        for key in ("images", "image", "frames", "batch", "samples", "items", "values"):
            if key not in value:
                continue
            tensor = _extract_image_tensor(value.get(key), seen)
            if tensor is not None:
                return tensor
        return None

    if isinstance(value, (list, tuple)):
        tensors: list[torch.Tensor] = []
        for item in value:
            tensor = _extract_image_tensor(item, seen)
            if tensor is None:
                continue
            if tensor.ndim == 3:
                tensor = tensor.unsqueeze(0)
            if tensor.ndim != 4:
                raise RuntimeError(f"米达斯深度图输入帧维度无效：{tuple(tensor.shape)}")
            tensors.append(tensor)
        if not tensors:
            return None
        try:
            return torch.cat(tensors, dim=0)
        except RuntimeError as exc:
            raise RuntimeError("米达斯深度图的视频帧序列必须保持相同宽高与通道数。") from exc

    for key in ("images", "image", "frames", "batch", "samples"):
        tensor = _extract_image_tensor(getattr(value, key, None), seen)
        if tensor is not None:
            return tensor
    return None


def _as_batched_image(image: Any) -> torch.Tensor:
    tensor = _extract_image_tensor(image)
    if tensor is None:
        raise RuntimeError(
            f"米达斯深度图需要 GJJ_BATCH_IMAGE、IMAGE 或 VIDEO 输入，实际收到：{type(image).__name__}。"
        )
    tensor = tensor.detach().float()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"输入图片/视频帧维度无效，应为 [B,H,W,C] 或 [B,C,H,W]，实际为：{tuple(tensor.shape)}")
    if tensor.shape[-1] not in (1, 3, 4) and tensor.shape[1] in (1, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 3:
        rgb = tensor
    elif channels == 4:
        alpha = tensor[..., 3:4].clamp(0.0, 1.0)
        rgb = tensor[..., :3] * alpha + (1.0 - alpha)
    elif channels == 1:
        rgb = tensor.repeat(1, 1, 1, 3)
    elif channels > 4:
        rgb = tensor[..., :3]
    else:
        raise RuntimeError(f"输入图片通道数无效：{channels}")
    return torch.nan_to_num(rgb, nan=0.0, posinf=1.0, neginf=0.0).clamp(0.0, 1.0).contiguous()


def _tensor_image_to_uint8(image: torch.Tensor) -> np.ndarray:
    array = image.detach().cpu().clamp(0.0, 1.0).numpy()
    return (array * 255.0).round().clip(0, 255).astype(np.uint8)


def _pad_to_multiple(value: int, multiple: int = 64) -> int:
    return int(np.ceil(float(value) / float(multiple)) * multiple - value)


def _resize_image_with_pad(input_image: np.ndarray, resolution: int):
    from PIL import Image

    image = input_image
    if image.ndim == 2:
        image = np.repeat(image[:, :, None], 3, axis=2)
    if image.ndim != 3:
        raise RuntimeError(f"输入图片数组维度无效：{tuple(image.shape)}")
    if image.shape[2] == 1:
        image = np.repeat(image, 3, axis=2)
    elif image.shape[2] == 4:
        color = image[:, :, :3].astype(np.float32)
        alpha = image[:, :, 3:4].astype(np.float32) / 255.0
        image = (color * alpha + 255.0 * (1.0 - alpha)).round().clip(0, 255).astype(np.uint8)
    elif image.shape[2] > 4:
        image = image[:, :, :3]
    elif image.shape[2] != 3:
        raise RuntimeError(f"输入图片数组通道数无效：{image.shape[2]}")

    height_raw, width_raw, _ = image.shape
    if resolution <= 0:
        return image, lambda value: value

    scale = float(resolution) / float(min(height_raw, width_raw))
    target_height = max(1, int(np.round(float(height_raw) * scale)))
    target_width = max(1, int(np.round(float(width_raw) * scale)))
    resample = Image.Resampling.BICUBIC if scale > 1.0 else Image.Resampling.BOX
    resized = np.asarray(Image.fromarray(image).resize((target_width, target_height), resample=resample), dtype=np.uint8)

    pad_height = _pad_to_multiple(target_height)
    pad_width = _pad_to_multiple(target_width)
    padded = np.pad(resized, [[0, pad_height], [0, pad_width], [0, 0]], mode="edge")

    def remove_pad(value: np.ndarray) -> np.ndarray:
        return np.ascontiguousarray(value[:target_height, :target_width, ...].copy())

    return np.ascontiguousarray(padded.copy()), remove_pad


def _resize_preview_frames(frames: torch.Tensor, width: int, height: int) -> torch.Tensor:
    samples = frames.movedim(-1, 1)
    resized = comfy.utils.common_upscale(samples, int(width), int(height), "lanczos", "disabled")
    return resized.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _save_depth_webp_preview(frames: torch.Tensor, fps: float = WEBP_PREVIEW_FPS) -> list[dict[str, Any]]:
    try:
        from PIL import Image

        preview = frames.detach().cpu().float().clamp(0.0, 1.0).contiguous()
        if preview.ndim == 3:
            preview = preview.unsqueeze(0)
        if preview.ndim != 4 or int(preview.shape[0]) <= 0:
            return []

        original_count = int(preview.shape[0])
        if original_count > WEBP_PREVIEW_MAX_FRAMES:
            indices = torch.linspace(0, original_count - 1, steps=WEBP_PREVIEW_MAX_FRAMES).round().to(torch.long)
            preview = preview.index_select(0, indices).contiguous()

        height = int(preview.shape[1])
        width = int(preview.shape[2])
        max_edge = max(width, height)
        if max_edge > WEBP_PREVIEW_MAX_EDGE:
            scale = float(WEBP_PREVIEW_MAX_EDGE) / float(max_edge)
            preview_width = max(1, int(round(width * scale)))
            preview_height = max(1, int(round(height * scale)))
            preview = _resize_preview_frames(preview, preview_width, preview_height)

        arrays = torch.round(preview * 255.0).to(torch.uint8).numpy()
        pil_frames: list[Image.Image] = []
        for array in arrays:
            if array.ndim == 2:
                pil_frames.append(Image.fromarray(array, mode="L").convert("RGB"))
                continue
            channels = int(array.shape[-1]) if array.ndim == 3 else 0
            if channels == 1:
                pil_frames.append(Image.fromarray(array[..., 0], mode="L").convert("RGB"))
            elif channels == 4:
                pil_frames.append(Image.fromarray(array, mode="RGBA"))
            else:
                pil_frames.append(Image.fromarray(array[..., :3], mode="RGB"))

        buffer = BytesIO()
        pil_frames[0].save(
            buffer,
            format="WEBP",
            save_all=True,
            append_images=pil_frames[1:],
            duration=max(1, round(1000.0 / max(0.01, float(fps)))),
            loop=0,
            lossless=False,
            quality=88,
            method=4,
        )
        info = gjjutils_write_temp_bytes(buffer.getvalue(), suffix=".webp")
        info.update(
            {
                "format": "image/webp",
                "media_type": "image",
                "is_sequence": True,
                "autoplay": True,
                "loop": True,
                "frame_rate": float(fps),
                "frame_count": original_count,
                "preview_frame_count": int(preview.shape[0]),
                "width": int(preview.shape[2]),
                "height": int(preview.shape[1]),
            }
        )
        return [info]
    except Exception as error:
        print(f"[GJJ 米达斯深度图] WebP 序列预览保存失败：{error}")
        return []


def _resolve_model_id(model_label: Any) -> str:
    label = str(model_label or DEFAULT_MODEL_LABEL).strip()
    return MODEL_CHOICES.get(label, MODEL_CHOICES[DEFAULT_MODEL_LABEL])


def _local_model_candidates(model_id: str) -> list[str]:
    folder_name = LOCAL_MODEL_DIR_NAMES.get(model_id, model_id.replace("/", "_"))
    roots: list[str] = []
    models_dir = str(getattr(folder_paths, "models_dir", "") or "").strip()
    if models_dir:
        roots.append(os.path.join(models_dir, "midas"))

    for category in ("midas", "controlnet", "diffusion_models", "checkpoints", "vae"):
        try:
            category_paths = folder_paths.get_folder_paths(category)
        except Exception:
            continue
        for category_path in category_paths:
            norm = os.path.normpath(str(category_path or ""))
            if not norm:
                continue
            if category == "midas":
                roots.append(norm)
            else:
                roots.append(os.path.join(os.path.dirname(norm), "midas"))
                roots.append(os.path.join(os.path.dirname(norm), "controlnet_aux"))
                roots.append(os.path.join(os.path.dirname(norm), "annotators"))

    unique: list[str] = []
    seen: set[str] = set()
    for root in roots:
        for path in (
            os.path.join(root, folder_name),
            os.path.join(root, model_id.replace("/", os.sep)),
        ):
            norm = os.path.normpath(path)
            key = norm.lower()
            if norm and key not in seen and os.path.isdir(norm):
                unique.append(norm)
                seen.add(key)
    return unique


def _format_model_display_path(local_dir: str) -> str:
    norm = os.path.normpath(str(local_dir or ""))
    folder_name = os.path.basename(norm)
    parent_name = os.path.basename(os.path.dirname(norm))
    if parent_name:
        return f"models/{parent_name}/{folder_name}"
    return folder_name


def _dedupe_errors(errors: list[str], limit: int = 3) -> str:
    result: list[str] = []
    seen: set[str] = set()
    for item in errors:
        text = str(item or "").strip()
        key = text.lower()
        if text and key not in seen:
            result.append(text)
            seen.add(key)
    return "\n".join(result[-limit:])


def _load_transformers_runtime(unique_id: Any = None):
    try:
        from transformers import DPTForDepthEstimation, DPTImageProcessor
    except Exception as exc:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[
                {
                    "module_name": "transformers",
                    "package_name": "transformers",
                    "display_name": "米达斯模型运行库（transformers）",
                    "description": "米达斯深度模型加载与图像处理需要该运行库。",
                }
            ],
            install_packages=["transformers"],
            description="当前环境缺少米达斯深度推理所需的 transformers。",
            original_error=str(exc),
            unique_id=unique_id,
            title="GJJ 米达斯深度图运行依赖缺失",
        )
    return DPTForDepthEstimation, DPTImageProcessor


def _load_hf_model_pair(model_id: str, unique_id: Any = None):
    DPTForDepthEstimation, DPTImageProcessor = _load_transformers_runtime(unique_id=unique_id)
    load_errors: list[str] = []

    for local_dir in _local_model_candidates(model_id):
        try:
            processor = DPTImageProcessor.from_pretrained(local_dir, local_files_only=True)
            model = DPTForDepthEstimation.from_pretrained(local_dir, local_files_only=True)
            return processor, model, _format_model_display_path(local_dir)
        except Exception as exc:
            load_errors.append(f"{local_dir}: {exc}")

    try:
        processor = DPTImageProcessor.from_pretrained(model_id, local_files_only=True)
        model = DPTForDepthEstimation.from_pretrained(model_id, local_files_only=True)
        return processor, model, f"本地模型缓存/{model_id}"
    except Exception as exc:
        load_errors.append(f"本地缓存 {model_id}: {exc}")

    try:
        processor = DPTImageProcessor.from_pretrained(model_id)
        model = DPTForDepthEstimation.from_pretrained(model_id)
        return processor, model, model_id
    except Exception as exc:
        load_errors.append(f"在线加载 {model_id}: {exc}")

    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[
            make_missing_model_spec(
                label="米达斯深度模型",
                subdir="models/midas",
                filename=LOCAL_MODEL_DIR_NAMES.get(model_id, model_id),
                description="未能从本地模型目录、本地模型缓存或在线地址加载模型。",
            )
        ],
        install_packages=["transformers", "huggingface_hub", "safetensors"],
        description=(
            "未找到可用的米达斯深度模型。可以让 transformers 自动下载，"
            "也可以把完整模型目录放入 models/midas 后重启 ComfyUI。"
        ),
        original_error=_dedupe_errors(load_errors),
        unique_id=unique_id,
        title="GJJ 米达斯深度图缺少模型",
    )


class GJJ_MidasDepthMapPreprocessor:
    CATEGORY = "GJJ/🖼️ 图像/控制网/预处理"
    FUNCTION = "estimate_depth"
    DESCRIPTION = DESCRIPTION
    RETURN_TYPES = (FRAME_OUTPUT_TYPE,)
    RETURN_NAMES = ("视频帧序列",)
    OUTPUT_TOOLTIPS = ("米达斯逐帧生成的三通道深度视频帧序列，兼容 GJJ_BATCH_IMAGE 与 IMAGE。",)
    OUTPUT_NODE = True
    SEARCH_ALIASES = ["米达斯深度图", "深度图预处理", "控制网深度图"]
    REQUIRED_MODELS = REQUIRED_MODELS
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": DESCRIPTION,
        "models": REQUIRED_MODELS,
        "dependencies": [
            "不依赖外部控制网预处理器插件。",
            "运行时需要当前 ComfyUI 环境可导入 transformers。",
        ],
        "usage": [
            "输入支持 GJJ_BATCH_IMAGE、普通 IMAGE batch 和官方 VIDEO；VIDEO 会自动解包为图片帧。",
            "节点会按输入顺序逐帧估计深度图，并输出 GJJ_BATCH_IMAGE,IMAGE 视频帧序列。",
            "检测分辨率与原版预处理器一致：以原图短边缩放到该尺寸，再补齐到 64 的倍数进行推理。",
            "执行后会使用 GJJ 公共临时文件缓存生成预览；多张深度图会合成一个 WebP 序列预览，避免预览区铺满单帧图片。",
        ],
    }

    def __init__(self):
        self._cache_key: tuple[str, str] | None = None
        self._cached_processor = None
        self._cached_model = None
        self._cached_source = ""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    MEDIA_INPUT_TYPE,
                    {
                        "display_name": "输入媒体",
                        "tooltip": "支持 GJJ_BATCH_IMAGE、普通 IMAGE batch 和官方 VIDEO；VIDEO 会自动读取全部视频帧。透明通道会先合成到白色背景。",
                    },
                ),
                "resolution": (
                    "INT",
                    {
                        "default": 512,
                        "min": 64,
                        "max": MAX_RESOLUTION,
                        "step": 64,
                        "display_name": "检测分辨率",
                        "tooltip": "预处理检测分辨率。节点会把输入图片短边缩放到该尺寸，再补齐到 64 的倍数。",
                    },
                ),
                "model_variant": (
                    list(MODEL_CHOICES.keys()),
                    {
                        "default": DEFAULT_MODEL_LABEL,
                        "display_name": "模型版本",
                        "tooltip": "选择米达斯深度模型。混合版速度和效果更均衡，大模型细节更强但更慢。",
                    },
                ),
                "post_offload": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "执行后卸载",
                        "tooltip": "开启后每次执行完把模型移到卸载设备，减少显存占用；再次执行会自动移回推理设备。",
                    },
                ),
                "a": (
                    "FLOAT",
                    {
                        "default": float(np.pi * 2.0),
                        "min": 0.0,
                        "max": float(np.pi * 5.0),
                        "step": 0.01,
                        "display_name": "法线强度兼容项",
                        "tooltip": "为兼容原版米达斯预处理器保留。深度图输出不使用该值，只有法线图模式才会用到。",
                    },
                ),
                "bg_threshold": (
                    "FLOAT",
                    {
                        "default": 0.1,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "背景阈值兼容项",
                        "tooltip": "为兼容原版米达斯预处理器保留。深度图输出不使用该值，只有法线图模式才会用到。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def _load_model(self, model_variant: str, unique_id: Any = None):
        model_id = _resolve_model_id(model_variant)
        device_key = str(mm.get_torch_device())
        cache_key = (model_id, device_key)
        if self._cache_key != cache_key or self._cached_processor is None or self._cached_model is None:
            processor, model, source = _load_hf_model_pair(model_id, unique_id=unique_id)
            model.eval()
            self._cache_key = cache_key
            self._cached_processor = processor
            self._cached_model = model
            self._cached_source = source
        return self._cached_processor, self._cached_model, self._cached_source

    def _estimate_single(self, image: torch.Tensor, processor: Any, model: Any, resolution: int, device: Any) -> torch.Tensor:
        from PIL import Image

        np_image = _tensor_image_to_uint8(image)
        padded, remove_pad = _resize_image_with_pad(np_image, int(resolution))
        pil_image = Image.fromarray(padded.astype(np.uint8), mode="RGB")

        with torch.no_grad():
            inputs = processor(images=pil_image, return_tensors="pt")
            inputs = {key: value.to(device) for key, value in inputs.items()}
            outputs = model(**inputs)
            depth = outputs.predicted_depth
            depth = torch.nn.functional.interpolate(
                depth.unsqueeze(1),
                size=(padded.shape[0], padded.shape[1]),
                mode="bicubic",
                align_corners=False,
            ).squeeze()

        depth = depth.detach().float()
        depth = depth - torch.min(depth)
        depth_max = torch.max(depth).clamp(min=1e-6)
        depth = depth / depth_max
        depth_image = (depth.cpu().numpy() * 255.0).round().clip(0, 255).astype(np.uint8)
        depth_image = np.repeat(depth_image[:, :, None], 3, axis=2)
        depth_image = remove_pad(depth_image)
        return torch.from_numpy(depth_image.astype(np.float32) / 255.0).unsqueeze(0).contiguous()

    def estimate_depth(
        self,
        image,
        resolution=512,
        model_variant=DEFAULT_MODEL_LABEL,
        post_offload=True,
        a=float(np.pi * 2.0),
        bg_threshold=0.1,
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        del a, bg_threshold
        images = _as_batched_image(image)
        resolution_value = max(64, min(MAX_RESOLUTION, int(resolution)))
        model_label = str(model_variant or DEFAULT_MODEL_LABEL)
        processor, model, source = self._load_model(model_label, unique_id=unique_id)

        device = mm.get_torch_device()
        model.to(device)
        pbar = comfy.utils.ProgressBar(int(images.shape[0]))
        outputs: list[torch.Tensor] = []
        try:
            for frame in images:
                outputs.append(self._estimate_single(frame, processor, model, resolution_value, device))
                pbar.update(1)
        finally:
            if bool(post_offload):
                try:
                    model.to(mm.unet_offload_device())
                except Exception:
                    pass
                mm.soft_empty_cache()

        depth_batch = torch.cat(outputs, dim=0).clamp(0.0, 1.0).contiguous()
        frame_count = int(depth_batch.shape[0])
        if frame_count > 1:
            preview_images = _save_depth_webp_preview(depth_batch, fps=WEBP_PREVIEW_FPS)
            preview_mode = "WebP序列预览"
            if not preview_images:
                preview_images = gjjutils_write_temp_tensor_images(depth_batch[:1])
                preview_mode = "首帧预览"
        else:
            preview_images = gjjutils_write_temp_tensor_images(depth_batch)
            preview_mode = "单图预览"
        summary = f"米达斯深度图完成：{frame_count} 张；{preview_mode}；检测分辨率 {resolution_value}；模型来源 {source}"
        return {
            "ui": {
                "images": preview_images,
                "preview_images": preview_images,
                "preview_text": [summary],
            },
            "result": (depth_batch,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MidasDepthMapPreprocessor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
