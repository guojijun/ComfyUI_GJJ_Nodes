from __future__ import annotations

import re
from typing import Any

import comfy.model_management
import comfy.model_sampling
import comfy.utils
import folder_paths
import torch
import torch.nn.functional as F
from nodes import CheckpointLoaderSimple, CLIPTextEncode, VAEDecode, common_ksampler

from .batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .multi_lora_chain import apply_lora_chain_config, normalize_lora_chain_data


NODE_NAME = "GJJ_Wan22RapidAIOMega"
DEFAULT_CHECKPOINT = "wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors"
DEFAULT_POSITIVE = (
    "一个全身古装的中国美女"
)
DEFAULT_NEGATIVE = ""
DEFAULT_SHIFT = 8.0
DEFAULT_STEPS = 4
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "ipndm"
DEFAULT_SCHEDULER = "beta"
DEFAULT_DENOISE = 1.0
DEFAULT_WIDTH = 768
DEFAULT_HEIGHT = 768
DEFAULT_SEGMENT_FRAMES = 65
DEFAULT_EMPTY_FRAME_LEVEL = 0.5
SIZE_ALIGNMENT = 32


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _normalize_text(text: str) -> str:
    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _safe_filename_list(category: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(category))
    except Exception:
        return []


def _pick_available_name(preferred: str, available: list[str], fallback: str = "") -> str:
    preferred = str(preferred or "").strip()
    fallback = str(fallback or "").strip()
    if preferred and preferred in available:
        return preferred

    preferred_base = preferred.replace("\\", "/").split("/")[-1] if preferred else ""
    if preferred_base:
        for item in available:
            if item.replace("\\", "/").split("/")[-1].lower() == preferred_base.lower():
                return item

    normalized = _normalize_text(preferred)
    if normalized:
        for item in available:
            if normalized in _normalize_text(item):
                return item

    if fallback:
        return _pick_available_name(fallback, available, "")
    return available[0] if available else ""


def _list_rapid_checkpoints() -> list[str]:
    checkpoints = _safe_filename_list("checkpoints")
    filtered = []
    for item in checkpoints:
        normalized = _normalize_text(item)
        if "wan22" in normalized and "rapid" in normalized:
            filtered.append(item)
    return filtered or checkpoints or [DEFAULT_CHECKPOINT]


def _require_checkpoint_name(preferred: str) -> str:
    available = _list_rapid_checkpoints()
    resolved = _pick_available_name(preferred, available, DEFAULT_CHECKPOINT)
    if not resolved:
        raise RuntimeError(f"未找到 Wan Rapid-AIO Checkpoint：{preferred or DEFAULT_CHECKPOINT}")
    full_path = folder_paths.get_full_path("checkpoints", resolved)
    if not full_path:
        raise RuntimeError(f"未找到 Wan Rapid-AIO Checkpoint：{resolved}")
    return resolved


def _apply_sd3_shift(model, shift: float):
    patched = model.clone()

    class ModelSamplingAdvanced(comfy.model_sampling.ModelSamplingDiscreteFlow, comfy.model_sampling.CONST):
        pass

    model_sampling = ModelSamplingAdvanced(model.model.model_config)
    model_sampling.set_parameters(shift=float(shift), multiplier=1000)
    patched.add_object_patch("model_sampling", model_sampling)
    return patched


def _apply_chain_loras(model, clip, lora_chain_config: Any = "", loaded_lora_cache: tuple[str, Any] | None = None):
    if not str(lora_chain_config or "").strip():
        return model, clip, loaded_lora_cache
    current_model, current_clip, cache_entry = apply_lora_chain_config(
        model,
        clip,
        lora_data=normalize_lora_chain_data(lora_chain_config),
        loaded_lora_cache=loaded_lora_cache,
    )
    return current_model, current_clip, cache_entry


def _conditioning_set_values(conditioning, values: dict[str, Any], append: bool = False):
    updated = []
    for item in conditioning:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            updated.append(item)
            continue
        new_item = list(item)
        metadata = dict(new_item[1] or {})
        for key, value in values.items():
            if append and key in metadata:
                existing = metadata.get(key)
                if isinstance(existing, list):
                    metadata[key] = existing + (value if isinstance(value, list) else [value])
                else:
                    metadata[key] = ([existing] if existing is not None else []) + (
                        value if isinstance(value, list) else [value]
                    )
            else:
                metadata[key] = value
        new_item[1] = metadata
        updated.append(new_item)
    return updated


def _align_up(value: int, alignment: int = SIZE_ALIGNMENT) -> int:
    alignment = max(1, int(alignment))
    value = max(1, int(value))
    return ((value + alignment - 1) // alignment) * alignment


def _is_empty_loader_placeholder(images: torch.Tensor) -> bool:
    if images is None or not isinstance(images, torch.Tensor) or images.ndim != 4:
        return False
    if tuple(int(x) for x in images.shape) != (1, 64, 64, 3):
        return False
    return bool(torch.count_nonzero(images).item() == 0)


def _extract_image_frames(images: torch.Tensor | None) -> list[torch.Tensor]:
    if images is None:
        return []
    if not isinstance(images, torch.Tensor):
        raise RuntimeError(f"不支持的图片输入类型：{type(images)!r}")

    batch = images
    if batch.ndim == 3:
        batch = batch.unsqueeze(0)
    if batch.ndim != 4:
        raise RuntimeError(f"图片输入维度无效：{tuple(batch.shape)}")
    if _is_empty_loader_placeholder(batch):
        return []

    batch = batch.detach().float().cpu().clamp(0.0, 1.0).contiguous()
    return [batch[index:index + 1].contiguous() for index in range(int(batch.shape[0]))]


def _resolve_generation_size(image_frames: list[torch.Tensor], width: int, height: int, auto_use_first_image_size: bool) -> tuple[int, int]:
    if auto_use_first_image_size and image_frames:
        first = image_frames[0]
        source_height = int(first.shape[1])
        source_width = int(first.shape[2])
        return _align_up(source_width), _align_up(source_height)
    return _align_up(width), _align_up(height)


def _build_vace_control_frames(
    num_frames: int,
    empty_frame_level: float,
    start_image: torch.Tensor | None = None,
    end_image: torch.Tensor | None = None,
    control_images: torch.Tensor | None = None,
    inpaint_mask: torch.Tensor | None = None,
    start_index: int = 0,
    end_index: int = -1,
) -> tuple[torch.Tensor | None, torch.Tensor | None]:
    if start_image is None and end_image is None and control_images is None:
        return None, None

    if start_image is None and end_image is None and control_images is not None:
        if int(control_images.shape[0]) >= int(num_frames):
            trimmed = control_images[:num_frames]
        else:
            padding = torch.ones(
                (num_frames - int(control_images.shape[0]), int(control_images.shape[1]), int(control_images.shape[2]), int(control_images.shape[3])),
                dtype=control_images.dtype,
                device=control_images.device,
            ) * float(empty_frame_level)
            trimmed = torch.cat([control_images, padding], dim=0)
        masks = torch.zeros_like(trimmed[:, :, :, 0])
        return trimmed.detach().float().cpu(), masks.detach().float().cpu()

    source = start_image if start_image is not None else end_image
    if source is None:
        raise RuntimeError("构建 VACE 控制帧失败：未提供起始图或结束图。")

    _, height, width, _ = source.shape
    device = source.device

    if end_index < 0:
        end_index = int(num_frames) + int(end_index)

    out_batch = torch.ones((num_frames, height, width, 3), device=device, dtype=source.dtype) * float(empty_frame_level)
    masks = torch.ones((num_frames, height, width), device=device, dtype=source.dtype)

    if end_image is not None and (int(end_image.shape[1]) != int(height) or int(end_image.shape[2]) != int(width)):
        end_image = comfy.utils.common_upscale(end_image.movedim(-1, 1), width, height, "lanczos", "disabled").movedim(1, -1)

    if control_images is not None and (int(control_images.shape[1]) != int(height) or int(control_images.shape[2]) != int(width)):
        control_images = comfy.utils.common_upscale(control_images.movedim(-1, 1), width, height, "lanczos", "disabled").movedim(1, -1)

    if start_image is not None:
        frames_to_copy = min(int(start_image.shape[0]), int(num_frames) - int(start_index))
        if frames_to_copy > 0:
            out_batch[start_index:start_index + frames_to_copy] = start_image[:frames_to_copy]
            masks[start_index:start_index + frames_to_copy] = 0

    if end_image is not None:
        end_start = int(end_index) - int(end_image.shape[0]) + 1
        if end_start < 0:
            end_image = end_image[abs(end_start):]
            end_start = 0
        frames_to_copy = min(int(end_image.shape[0]), int(num_frames) - int(end_start))
        if frames_to_copy > 0:
            out_batch[end_start:end_start + frames_to_copy] = end_image[:frames_to_copy]
            masks[end_start:end_start + frames_to_copy] = 0

    if control_images is not None:
        empty_frames = masks.sum(dim=(1, 2)) > 0.5 * int(height) * int(width)
        if bool(empty_frames.any()):
            control_length = int(control_images.shape[0])
            for frame_index in range(int(num_frames)):
                if bool(empty_frames[frame_index]) and frame_index < control_length:
                    out_batch[frame_index] = control_images[frame_index]

    if inpaint_mask is not None:
        inpaint_mask = comfy.utils.common_upscale(inpaint_mask.unsqueeze(1), width, height, "nearest-exact", "disabled").squeeze(1).to(device)
        if int(inpaint_mask.shape[0]) > int(num_frames):
            inpaint_mask = inpaint_mask[:num_frames]
        elif int(inpaint_mask.shape[0]) < int(num_frames):
            repeat_factor = (int(num_frames) + int(inpaint_mask.shape[0]) - 1) // int(inpaint_mask.shape[0])
            inpaint_mask = inpaint_mask.repeat(repeat_factor, 1, 1)[:num_frames]
        masks = inpaint_mask * masks

    return out_batch.detach().float().cpu(), masks.detach().float().cpu()


def _build_vace_latent(
    positive,
    negative,
    vae,
    width: int,
    height: int,
    length: int,
    batch_size: int,
    strength: float,
    control_video: torch.Tensor | None = None,
    control_masks: torch.Tensor | None = None,
    reference_image: torch.Tensor | None = None,
):
    latent_length = ((int(length) - 1) // 4) + 1
    if control_video is not None:
        control_video = comfy.utils.common_upscale(control_video[:length].movedim(-1, 1), width, height, "bilinear", "center").movedim(1, -1)
        if int(control_video.shape[0]) < int(length):
            control_video = F.pad(control_video, (0, 0, 0, 0, 0, 0, 0, int(length) - int(control_video.shape[0])), value=0.5)
    else:
        control_video = torch.ones((length, height, width, 3), dtype=torch.float32) * 0.5

    if reference_image is not None:
        reference_image = comfy.utils.common_upscale(reference_image[:1].movedim(-1, 1), width, height, "bilinear", "center").movedim(1, -1)
        reference_image = vae.encode(reference_image[:, :, :, :3])
        reference_image = torch.cat([reference_image, torch.zeros_like(reference_image)], dim=1)

    if control_masks is None:
        mask = torch.ones((length, height, width, 1), dtype=control_video.dtype)
    else:
        mask = control_masks
        if mask.ndim == 3:
            mask = mask.unsqueeze(1)
        mask = comfy.utils.common_upscale(mask[:length], width, height, "bilinear", "center").movedim(1, -1)
        if int(mask.shape[0]) < int(length):
            mask = F.pad(mask, (0, 0, 0, 0, 0, 0, 0, int(length) - int(mask.shape[0])), value=1.0)

    control_video = control_video - 0.5
    inactive = (control_video * (1 - mask)) + 0.5
    reactive = (control_video * mask) + 0.5

    inactive = vae.encode(inactive[:, :, :, :3])
    reactive = vae.encode(reactive[:, :, :, :3])
    control_video_latent = torch.cat((inactive, reactive), dim=1)

    trim_latent = 0
    if reference_image is not None:
        control_video_latent = torch.cat((reference_image, control_video_latent), dim=2)

    vae_stride = 8
    height_mask = height // vae_stride
    width_mask = width // vae_stride
    mask = mask.view(length, height_mask, vae_stride, width_mask, vae_stride)
    mask = mask.permute(2, 4, 0, 1, 3)
    mask = mask.reshape(vae_stride * vae_stride, length, height_mask, width_mask)
    mask = F.interpolate(mask.unsqueeze(0), size=(latent_length, height_mask, width_mask), mode="nearest-exact").squeeze(0)

    if reference_image is not None:
        mask_pad = torch.zeros_like(mask[:, : reference_image.shape[2], :, :])
        mask = torch.cat((mask_pad, mask), dim=1)
        latent_length += int(reference_image.shape[2])
        trim_latent = int(reference_image.shape[2])

    mask = mask.unsqueeze(0)

    positive = _conditioning_set_values(
        positive,
        {"vace_frames": [control_video_latent], "vace_mask": [mask], "vace_strength": [float(strength)]},
        append=True,
    )
    negative = _conditioning_set_values(
        negative,
        {"vace_frames": [control_video_latent], "vace_mask": [mask], "vace_strength": [float(strength)]},
        append=True,
    )

    latent = torch.zeros(
        [int(batch_size), 16, latent_length, int(height) // 8, int(width) // 8],
        device=comfy.model_management.intermediate_device(),
    )
    return positive, negative, {"samples": latent}, trim_latent


def _concat_segments(segments: list[torch.Tensor]) -> torch.Tensor:
    if not segments:
        return torch.zeros((0, 64, 64, 3), dtype=torch.float32)
    return torch.cat(segments, dim=0).contiguous()


def _build_route_name(image_count: int) -> str:
    if image_count <= 0:
        return "T2V 流畅"
    if image_count == 1:
        return "I2V 流畅"
    if image_count == 2:
        return "首尾帧"
    return "多图串接"


class GJJ_Wan22RapidAIOMega:
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    DESCRIPTION = (
        "将 Wan2.2_Rapid-AIO-Mega 工作流封装为 GJJ 零依赖本地节点。"
        "未接图走 T2V，接 1 张图走 I2V，接 2 张图走首尾帧，多张图会按相邻图片自动串接生成整段帧序列。"
    )
    SEARCH_ALIASES = [
        "wan rapid",
        "wan2.2 rapid",
        "rapid aio mega",
        "wan t2v",
        "wan i2v",
        "首尾帧",
        "多图串接",
    ]
    RETURN_TYPES = (GJJ_BATCH_IMAGE_TYPE,)
    RETURN_NAMES = ("视频帧序列",)
    OUTPUT_TOOLTIPS = ("解码后的视频帧序列；这里复用 GJJ_BATCH_IMAGE 类型，可直接连接 GJJ · 视频合成器 的 图像/Latent 输入。",)

    def __init__(self):
        self.loaded_lora: tuple[str, Any] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = _list_rapid_checkpoints()
        default_checkpoint = _pick_available_name(DEFAULT_CHECKPOINT, checkpoints, DEFAULT_CHECKPOINT)
        return {
            "required": {
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_POSITIVE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "默认值直接来自 Wan2.2_Rapid-AIO-Mega 工作流当前提示词。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "反向提示词",
                        "tooltip": "默认留空，按原工作流的 1 CFG 用法保持极简负向条件。",
                    },
                ),
                "checkpoint_name": (
                    checkpoints,
                    {
                        "default": default_checkpoint,
                        "display_name": "Wan 基础模型",
                        "tooltip": "优先筛出本机已有的 Wan2.2 Rapid / AIO / Mega 系列 checkpoint。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": DEFAULT_WIDTH,
                        "min": 32,
                        "max": 8192,
                        "step": 32,
                        "display_name": "无图时宽度",
                        "tooltip": "未接图片时使用的输出宽度；接图后可自动改为首图尺寸并按 32 对齐。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": DEFAULT_HEIGHT,
                        "min": 32,
                        "max": 8192,
                        "step": 32,
                        "display_name": "无图时高度",
                        "tooltip": "未接图片时使用的输出高度；接图后可自动改为首图尺寸并按 32 对齐。",
                    },
                ),
                "segment_frames": (
                    "INT",
                    {
                        "default": DEFAULT_SEGMENT_FRAMES,
                        "min": 1,
                        "max": 1024,
                        "step": 4,
                        "display_name": "每段帧数",
                        "tooltip": "单图/双图时就是整段帧数；多图串接时表示每一段相邻图片之间的帧数。",
                    },
                ),
                "auto_use_first_image_size": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "接图后跟随首图尺寸",
                        "tooltip": "开启后，只要接入图片就自动按首图尺寸推导生成尺寸，并做 32 倍数对齐。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 6456545463455,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "统一控制所有分段的随机种子；多图串接时会复用同一个种子保持整体观感一致。",
                    },
                ),
            },
            "optional": {
                "images": (
                    GJJ_BATCH_IMAGE_TYPE,
                    {
                        "display_name": "批量图片",
                        "tooltip": "推荐直接连接 GJJ · 多图片加载预览器 的 批量图片队列。未接图走 T2V，1 张走 I2V，2 张走首尾帧，多张走相邻两图依次串接。",
                    },
                ),
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "display_name": "LoRA串联配置",
                        "tooltip": "可选接入 GJJ · LoRA串联配置 的输出；会在加载 checkpoint 后按配置顺序串联应用到 Wan 模型与 CLIP。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        positive_prompt,
        negative_prompt,
        checkpoint_name,
        width,
        height,
        segment_frames,
        auto_use_first_image_size,
        seed,
        images=None,
        lora_chain_config="",
        unique_id=None,
    ):
        try:
            image_frames = _extract_image_frames(images)
            image_count = len(image_frames)
            route_name = _build_route_name(image_count)
            resolved_width, resolved_height = _resolve_generation_size(
                image_frames,
                int(width),
                int(height),
                bool(auto_use_first_image_size),
            )

            _send_status(unique_id, "1/7 加载 Wan Rapid-AIO Checkpoint...", 0.06)
            resolved_checkpoint = _require_checkpoint_name(checkpoint_name)
            model, clip, vae = CheckpointLoaderSimple().load_checkpoint(resolved_checkpoint)
            model = _apply_sd3_shift(model, DEFAULT_SHIFT)

            _send_status(unique_id, "2/7 应用 LoRA串联配置...", 0.14)
            model, clip, self.loaded_lora = _apply_chain_loras(
                model,
                clip,
                lora_chain_config=lora_chain_config,
                loaded_lora_cache=self.loaded_lora,
            )

            _send_status(unique_id, "3/7 编码提示词...", 0.2)
            positive = CLIPTextEncode().encode(clip, str(positive_prompt or "").strip() or DEFAULT_POSITIVE)[0]
            negative = CLIPTextEncode().encode(clip, str(negative_prompt or "").strip() or DEFAULT_NEGATIVE)[0]

            segment_count = 1 if image_count <= 1 else image_count - 1
            _send_status(
                unique_id,
                f"4/7 当前模式：{route_name}，共 {segment_count} 段，输出尺寸 {resolved_width}x{resolved_height}...",
                0.28,
            )

            collected_segments: list[torch.Tensor] = []
            for segment_index in range(segment_count):
                if image_count <= 0:
                    segment_start = None
                    segment_end = None
                    strength = 0.0
                elif image_count == 1:
                    segment_start = image_frames[0]
                    segment_end = None
                    strength = 1.0
                else:
                    segment_start = image_frames[segment_index]
                    segment_end = image_frames[segment_index + 1]
                    strength = 1.0

                progress_base = 0.28 + (0.48 * (segment_index / max(1, segment_count)))
                _send_status(
                    unique_id,
                    f"5/7 第 {segment_index + 1}/{segment_count} 段：构建 VACE 条件...",
                    progress_base + 0.05,
                )
                control_images, control_masks = _build_vace_control_frames(
                    num_frames=int(segment_frames),
                    empty_frame_level=DEFAULT_EMPTY_FRAME_LEVEL,
                    start_image=segment_start,
                    end_image=segment_end,
                )
                segment_positive, segment_negative, segment_latent, _ = _build_vace_latent(
                    positive,
                    negative,
                    vae,
                    resolved_width,
                    resolved_height,
                    int(segment_frames),
                    1,
                    strength,
                    control_video=control_images,
                    control_masks=control_masks,
                    reference_image=None,
                )

                _send_status(
                    unique_id,
                    f"5/7 第 {segment_index + 1}/{segment_count} 段：采样中...",
                    progress_base + 0.18,
                )
                sampled = common_ksampler(
                    model,
                    int(seed),
                    DEFAULT_STEPS,
                    DEFAULT_CFG,
                    DEFAULT_SAMPLER,
                    DEFAULT_SCHEDULER,
                    segment_positive,
                    segment_negative,
                    segment_latent,
                    denoise=DEFAULT_DENOISE,
                )[0]

                _send_status(
                    unique_id,
                    f"6/7 第 {segment_index + 1}/{segment_count} 段：VAE 解码...",
                    progress_base + 0.34,
                )
                decoded = VAEDecode().decode(vae, sampled)[0].detach().float().cpu().contiguous()
                if segment_index > 0 and int(decoded.shape[0]) > 1:
                    decoded = decoded[1:].contiguous()
                collected_segments.append(decoded)

            _send_status(unique_id, "7/7 合并全部帧序列...", 0.88)
            frames = _concat_segments(collected_segments)
            total_frames = int(frames.shape[0])
            _send_status(unique_id, f"完成：{route_name}，共 {total_frames} 帧", 1.0)
            return {
                "ui": {
                    "mode_summary": [route_name],
                    "frame_count": [total_frames],
                    "frame_size": [f"{resolved_width}x{resolved_height}"],
                    "resolved_width": [resolved_width],
                    "resolved_height": [resolved_height],
                    "source_image_count": [image_count],
                },
                "result": (frames,),
            }
        except RuntimeError as exc:
            _send_status(unique_id, f"执行失败：{str(exc).splitlines()[0]}", 0.0)
            raise
        except Exception as exc:
            _send_status(unique_id, "执行失败", 0.0)
            raise RuntimeError(
                "Wan2.2 Rapid-AIO Mega 节点执行失败。\n"
                f"Checkpoint：{checkpoint_name}\n"
                f"详细错误：{exc}"
            ) from exc


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Wan22RapidAIOMega}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 Wan多合一合成视频流畅器"}
