from __future__ import annotations

import inspect
import logging
from typing import Any

import torch
from PIL import Image

import comfy.model_management as model_management
import comfy.model_sampling
import comfy.samplers
from nodes import common_ksampler

from .common_utils.progress import send_node_progress
from .common_utils.temp_files import gjjutils_write_temp_pil_sequence
from .gjj_wan_scail_to_video import GJJ_WanSCAILToVideo, _max_resolution


log = logging.getLogger(__name__)

NODE_NAME = "GJJ_WanSCAILInfinity"
NODE_DISPLAY_NAME = "🎬 SCAIL-2 Infinity 长视频单节点"
IMAGE_BATCH_TYPE = "GJJ_BATCH_IMAGE,IMAGE"

DESCRIPTION = (
    "零依赖复刻 SCAIL-2 Infinity：在单个节点内部循环构建 SCAIL 条件、采样、"
    "VAE 解码与重叠帧拼接，用固定窗口生成由姿态视频长度驱动的长视频。"
)


def _choice_default(choices: list[str], preferred: str, fallback: str) -> str:
    if preferred in choices:
        return preferred
    if fallback in choices:
        return fallback
    return choices[0] if choices else fallback


def _sampler_names() -> list[str]:
    choices = list(getattr(comfy.samplers.KSampler, "SAMPLERS", []) or [])
    return choices or ["uni_pc", "euler"]


def _scheduler_names() -> list[str]:
    choices = list(getattr(comfy.samplers.KSampler, "SCHEDULERS", []) or [])
    return choices or ["simple", "normal", "beta"]


def _status(message: str) -> None:
    text = f"[GJJ SCAIL2-Infinity] {message}"
    log.info(text)
    print(text, flush=True)


def _send_progress(unique_id: Any, message: str, progress: float | None = None, **extra: Any) -> None:
    _status(message)
    send_node_progress(unique_id, message, progress, **extra)


def _image_frame_count(value: Any) -> int | None:
    if value is None:
        return None
    if not isinstance(value, torch.Tensor):
        raise RuntimeError("姿态视频帧必须是 ComfyUI IMAGE 张量。")
    if value.ndim == 3:
        return 1
    if value.ndim != 4:
        raise RuntimeError(f"姿态视频帧维度无效：需要 [帧,高,宽,通道]，当前为 {tuple(value.shape)}。")
    return int(value.shape[0])


def _coerce_image_batch(value: Any, label: str) -> torch.Tensor | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        images: list[torch.Tensor] = []
        for index, item in enumerate(value, start=1):
            image = _coerce_image_batch(item, f"{label} 第 {index} 张")
            if image is not None:
                images.append(image)
        if not images:
            return None
        shape = tuple(images[0].shape[1:])
        if any(tuple(image.shape[1:]) != shape for image in images):
            raise RuntimeError(f"{label}批量图片尺寸不一致。请先用图片批量打包/缩放节点统一尺寸后再接入。")
        return torch.cat(images, dim=0).contiguous()
    if not isinstance(value, torch.Tensor):
        raise RuntimeError(f"{label}必须是 IMAGE / GJJ_BATCH_IMAGE 张量。")
    tensor = value.detach() if hasattr(value, "detach") else value
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4 or int(tensor.shape[-1]) < 3:
        raise RuntimeError(f"{label}维度无效：需要 [张数,高,宽,通道]，当前为 {tuple(tensor.shape)}。")
    return tensor.contiguous()


def _split_primary_and_extra_images(value: Any, label: str) -> tuple[Any, Any]:
    tensor = _coerce_image_batch(value, label)
    if tensor is None:
        return None, None
    if int(tensor.shape[0]) <= 1:
        return tensor, None
    return tensor[:1].contiguous(), tensor[1:].contiguous()


def _merge_image_batches(primary: Any, extra: Any, label: str) -> Any:
    if primary is None:
        return extra
    if extra is None:
        return primary
    if not isinstance(primary, torch.Tensor) or not isinstance(extra, torch.Tensor):
        log.warning("%s 同时收到批量拆分数据和旧版多参考输入，但其中一个不是张量；已优先使用批量拆分数据。", label)
        return primary
    if primary.ndim == 3:
        primary = primary.unsqueeze(0)
    if extra.ndim == 3:
        extra = extra.unsqueeze(0)
    if primary.ndim == 4 and extra.ndim == 4 and tuple(primary.shape[1:]) == tuple(extra.shape[1:]):
        return torch.cat([primary, extra], dim=0).contiguous()
    log.warning("%s 批量拆分数据和旧版多参考输入尺寸不一致，无法合并；已优先使用批量拆分数据。", label)
    return primary


def _decode_video_latent(vae: Any, latent_samples: torch.Tensor, tiled: bool) -> torch.Tensor:
    if bool(tiled):
        decode_tiled = getattr(vae, "decode_tiled", None)
        if callable(decode_tiled):
            decode_kwargs: dict[str, Any] = {}
            if latent_samples.ndim == 5:
                try:
                    parameters = inspect.signature(decode_tiled).parameters
                except (TypeError, ValueError):
                    parameters = {}
                accepts_overlap = "overlap" in parameters or any(
                    parameter.kind == inspect.Parameter.VAR_KEYWORD
                    for parameter in parameters.values()
                )
                if accepts_overlap:
                    spatial_overlap = 8
                    decode_tiled_3d = getattr(vae, "decode_tiled_3d", None)
                    if callable(decode_tiled_3d):
                        try:
                            default_overlap = inspect.signature(decode_tiled_3d).parameters["overlap"].default
                            if isinstance(default_overlap, (tuple, list)) and len(default_overlap) >= 3:
                                spatial_overlap = min(int(default_overlap[-2]), int(default_overlap[-1]))
                            elif isinstance(default_overlap, int):
                                spatial_overlap = int(default_overlap)
                        except (KeyError, TypeError, ValueError):
                            pass
                    spatial_extent = min(int(latent_samples.shape[-2]), int(latent_samples.shape[-1]))
                    decode_kwargs["overlap"] = max(1, min(spatial_overlap, max(1, spatial_extent - 1)))
            images = decode_tiled(latent_samples, **decode_kwargs)
        else:
            log.warning("VAE 不支持 decode_tiled，已回退到普通解码。")
            images = vae.decode(latent_samples)
    else:
        images = vae.decode(latent_samples)

    if len(images.shape) == 5:
        images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
    return images


def _latent_frame_count(frame_count: int) -> int:
    return ((max(1, int(frame_count)) - 1) // 4) + 1


def _window_seed(seed: int, window_index: int, vary_seed_per_window: bool) -> int:
    value = int(seed) + (int(window_index) if bool(vary_seed_per_window) else 0)
    return value & 0xFFFFFFFFFFFFFFFF


def _apply_model_sampling_sd3(model: Any, shift: float, multiplier: int = 1000) -> Any:
    if model is None or not callable(getattr(model, "clone", None)):
        raise RuntimeError("ModelSamplingSD3 需要有效的 MODEL 输入。")

    patched = model.clone()

    class ModelSamplingAdvanced(comfy.model_sampling.ModelSamplingDiscreteFlow, comfy.model_sampling.CONST):
        pass

    model_sampling = ModelSamplingAdvanced(model.model.model_config)
    model_sampling.set_parameters(shift=float(shift), multiplier=int(multiplier))
    try:
        original = patched.get_model_object("model_sampling")
        if hasattr(original, "noise_scale"):
            model_sampling.set_noise_scale(original.noise_scale)
    except Exception:
        pass
    patched.add_object_patch("model_sampling", model_sampling)
    return patched


def _save_segment_preview(tensor: torch.Tensor, title: str, fps: float = 8.0) -> dict[str, Any] | None:
    if not isinstance(tensor, torch.Tensor) or tensor.ndim != 4 or int(tensor.shape[0]) <= 0:
        return None
    try:
        preview = tensor.detach().cpu().float().clamp(0.0, 1.0).contiguous()
        max_frames = 48
        if int(preview.shape[0]) > max_frames:
            indices = torch.linspace(0, int(preview.shape[0]) - 1, steps=max_frames).round().to(torch.long)
            preview = preview.index_select(0, indices).contiguous()
        arrays = torch.round(preview[..., :3] * 255.0).to(torch.uint8).numpy()
        frames = [Image.fromarray(array, mode="RGB") for array in arrays]
        info = gjjutils_write_temp_pil_sequence(
            frames,
            format="WEBP",
            suffix=".webp",
            duration=max(1, round(1000.0 / max(0.01, float(fps)))),
            loop=0,
            save_options={"lossless": False, "quality": 82, "method": 3},
        )
        info.update({
            "title": title,
            "is_sequence": len(frames) > 1,
            "autoplay": len(frames) > 1,
            "loop": len(frames) > 1,
            "frame_rate": float(fps),
            "frame_count": int(tensor.shape[0]),
            "preview_frame_count": len(frames),
            "width": int(tensor.shape[2]),
            "height": int(tensor.shape[1]),
        })
        return info
    except Exception as exc:
        log.warning("SCAIL-2 分段预览保存失败：%s", exc)
        return None


class GJJ_WanSCAILInfinity:
    CATEGORY = "GJJ/🎬 视频/生成/SCAIL"
    FUNCTION = "generate"
    DESCRIPTION = DESCRIPTION
    RETURN_TYPES = ("IMAGE", "LATENT", "INT")
    RETURN_NAMES = ("完整视频帧", "完整视频Latent", "总帧数")
    OUTPUT_TOOLTIPS = (
        "拼接后的完整视频帧，已经自动丢弃每段开头的重叠锚定帧。",
        "拼接后的完整 latent，按视频帧数裁切到对应时间长度。",
        "最终输出的视频帧数。",
    )
    SEARCH_ALIASES = [
        "SCAIL-2 Infinity",
        "WanSCAILInfinity",
        "SCAIL2长视频",
        "SCAIL2循环长视频",
        "自动窗口",
    ]
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": DESCRIPTION,
        "dependencies": [
            "只依赖 ComfyUI 自带 PyTorch、KSampler、VAE 和 GJJ 内置 Wan SCAIL 条件构建逻辑。",
            "不导入 comfy_api.latest，也不依赖 comfy_extras/nodes_scail.py 或外部 scail2-infinity 自定义节点。",
        ],
        "usage": [
            "连接正向条件、负向条件、MODEL、VAE 和姿态视频帧；节点会按姿态视频长度自动循环生成。",
            "参考图片和参考图片彩色遮罩支持 IMAGE / GJJ_BATCH_IMAGE；批量输入时第 1 张作为主参考，后续图片自动作为多参考图/多参考图遮罩参与编码。",
            "默认每窗 121 帧、上一段锚定 5 帧；每个后续窗口只保留新增帧，最后自动裁切到目标帧数。",
            "默认启用内置 ModelSamplingSD3，SD3移位为 5，用来匹配常见 Wan/SCAIL 工作流中的模型采样补丁。",
            "max_frames 为 0 时跟随姿态视频长度；没有姿态视频时只生成一个窗口。",
        ],
        "notes": [
            "窗口帧数默认 121，上一段锚定默认 5；需要更短窗口时可手动调小。",
            "分块解码可降低 VAE 解码显存，但总耗时可能增加。",
            "如果上游模型已经做过 ModelSamplingSD3 或需要其它 flow shift，可以关闭本节点内置补丁或调整 SD3移位。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        max_resolution = _max_resolution()
        samplers = _sampler_names()
        schedulers = _scheduler_names()
        return {
            "required": {
                "positive": (
                    "CONDITIONING",
                    {"display_name": "正向条件", "tooltip": "来自 Wan 文本编码器的正向条件。"},
                ),
                "negative": (
                    "CONDITIONING",
                    {"display_name": "负向条件", "tooltip": "来自 Wan 文本编码器的负向条件。"},
                ),
                "model": (
                    "MODEL",
                    {"display_name": "模型", "tooltip": "用于每个窗口采样的 Wan/SCAIL 模型。"},
                ),
                "vae": (
                    "VAE",
                    {"display_name": "VAE", "tooltip": "用于编码 SCAIL 控制信息并解码每个窗口。"},
                ),
                "width": (
                    "INT",
                    {"default": 512, "min": 32, "max": max_resolution, "step": 32, "display_name": "宽度", "tooltip": "目标视频宽度。"},
                ),
                "height": (
                    "INT",
                    {"default": 896, "min": 32, "max": max_resolution, "step": 32, "display_name": "高度", "tooltip": "目标视频高度。"},
                ),
                "seed": (
                    "INT",
                    {"default": 1, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True, "display_name": "种子", "tooltip": "每个窗口采样使用的基础种子。"},
                ),
                "steps": (
                    "INT",
                    {"default": 6, "min": 1, "max": 10000, "display_name": "步数", "tooltip": "每个窗口的采样步数。"},
                ),
                "cfg": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01, "display_name": "CFG", "tooltip": "每个窗口采样使用的 CFG。"},
                ),
                "sampler_name": (
                    samplers,
                    {"default": _choice_default(samplers, "euler", "uni_pc"), "display_name": "采样器", "tooltip": "每个窗口采样使用的采样器。"},
                ),
                "scheduler": (
                    schedulers,
                    {"default": _choice_default(schedulers, "simple", "normal"), "display_name": "调度器", "tooltip": "每个窗口采样使用的调度器。"},
                ),
                "denoise": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "降噪", "tooltip": "每个窗口采样的 denoise 强度。"},
                ),
                "window_length": (
                    "INT",
                    {"default": 121, "min": 5, "max": max_resolution, "step": 4, "display_name": "窗口帧数", "tooltip": "每次采样的帧数。"},
                ),
                "previous_frame_count": (
                    "INT",
                    {"default": 5, "min": 1, "max": max_resolution, "step": 4, "display_name": "上一段锚定帧数", "tooltip": "后续窗口开头复用上一窗口末尾多少帧；SCAIL-2 通常使用 5。"},
                ),
                "max_frames": (
                    "INT",
                    {"default": 0, "min": 0, "max": max_resolution, "step": 1, "display_name": "最大帧数", "tooltip": "硬性限制最终输出帧数；0 表示跟随姿态视频长度，没有姿态视频时生成一个窗口。"},
                ),
                "decode_tiled": (
                    "BOOLEAN",
                    {"default": False, "display_name": "分块解码", "tooltip": "使用 VAE tiled decode 降低高分辨率解码显存。"},
                ),
                "vary_seed_per_window": (
                    "BOOLEAN",
                    {"default": True, "display_name": "每窗口递增种子", "tooltip": "开启后每个窗口用 seed + 窗口序号；关闭时所有窗口使用同一种子。"},
                ),
                "pose_strength": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01, "display_name": "姿态强度", "tooltip": "姿态 latent 的强度倍率。"},
                ),
                "pose_start": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "姿态开始比例", "tooltip": "姿态条件开始生效的采样比例。"},
                ),
                "pose_end": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "姿态结束比例", "tooltip": "姿态条件结束生效的采样比例。"},
                ),
                "replacement_mode": (
                    "BOOLEAN",
                    {"default": False, "display_name": "替换模式", "tooltip": "关闭为动画模式，开启为人物替换模式。"},
                ),
                "enable_model_sampling_sd3": (
                    "BOOLEAN",
                    {"default": True, "display_name": "启用ModelSamplingSD3", "tooltip": "采样前在节点内部对模型应用 ComfyUI 内置 ModelSamplingSD3 等价补丁。"},
                ),
                "model_sampling_sd3_shift": (
                    "FLOAT",
                    {"default": 5.0, "min": 0.0, "max": 100.0, "step": 0.01, "display_name": "SD3移位", "tooltip": "ModelSamplingSD3 的 shift 参数；常见 Wan/SCAIL 工作流通常使用 5。"},
                ),
            },
            "optional": {
                "pose_video": (
                    "IMAGE",
                    {"display_name": "姿态视频帧", "tooltip": "驱动姿态视频帧队列；连接后它的长度决定默认输出帧数。"},
                ),
                "pose_video_mask": (
                    "IMAGE",
                    {"display_name": "姿态彩色遮罩", "tooltip": "SCAIL-2 彩色身份遮罩帧队列，应与姿态视频同步。"},
                ),
                "reference_image": (
                    IMAGE_BATCH_TYPE,
                    {"display_name": "参考图片", "tooltip": "角色参考图。支持 IMAGE / GJJ_BATCH_IMAGE；多图输入时第 1 张作为主参考，后续图片自动作为多参考图。"},
                ),
                "reference_image_mask": (
                    IMAGE_BATCH_TYPE,
                    {"display_name": "参考图片彩色遮罩", "tooltip": "参考图片对应的 SCAIL-2 彩色身份遮罩。支持 IMAGE / GJJ_BATCH_IMAGE；多图输入时第 1 张作为主遮罩，后续图片自动作为多参考图遮罩。"},
                ),
                "clip_vision_output": (
                    "CLIP_VISION_OUTPUT",
                    {"display_name": "CLIP视觉条件", "tooltip": "可选 CLIP Vision 输出，用于增强参考图语义一致性。"},
                ),
                "background_image": (
                    "IMAGE",
                    {"display_name": "背景图", "tooltip": "GJJ 扩展：动画模式下可用于参考图按遮罩合成背景。"},
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        positive,
        negative,
        model,
        vae,
        width: int,
        height: int,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        window_length: int,
        previous_frame_count: int,
        max_frames: int,
        decode_tiled: bool,
        vary_seed_per_window: bool,
        pose_strength: float,
        pose_start: float,
        pose_end: float,
        replacement_mode: bool = False,
        enable_model_sampling_sd3: bool = True,
        model_sampling_sd3_shift: float = 5.0,
        pose_video: Any = None,
        pose_video_mask: Any = None,
        reference_image: Any = None,
        reference_image_mask: Any = None,
        clip_vision_output: Any = None,
        background_image: Any = None,
        multi_reference_images: Any = None,
        multi_reference_masks: Any = None,
        unique_id: Any = None,
    ):
        width = int(width)
        height = int(height)
        window_length = max(1, int(window_length))
        previous_frame_count = max(1, int(previous_frame_count))
        max_frames = max(0, int(max_frames))
        if previous_frame_count >= window_length:
            raise RuntimeError("上一段锚定帧数必须小于窗口帧数，否则后续窗口不会产生新帧。")

        pose_len = _image_frame_count(pose_video)
        target = window_length if pose_len is None and max_frames <= 0 else max_frames
        if pose_len is not None:
            target = pose_len if max_frames <= 0 else min(pose_len, max_frames)
        if target <= 0:
            raise RuntimeError("目标帧数为 0。请连接非空姿态视频，或把最大帧数设为大于 0。")

        lat_drop = _latent_frame_count(previous_frame_count)
        step = max(1, window_length - previous_frame_count)
        extra = max(0, int(target) - window_length)
        total_windows = 1 if pose_len is None else 1 + (extra + step - 1) // step

        _send_progress(
            unique_id,
            f"目标 {target} 帧 | 窗口 {window_length} | 重叠 {previous_frame_count} | "
            f"步进 {step} -> {total_windows} 个窗口",
            0.02,
        )

        sample_model = model
        if bool(enable_model_sampling_sd3):
            sample_model = _apply_model_sampling_sd3(model, float(model_sampling_sd3_shift))
            _send_progress(unique_id, f"已应用 ModelSamplingSD3：shift={float(model_sampling_sd3_shift):.4g}", 0.04)

        reference_image, batch_multi_reference_images = _split_primary_and_extra_images(reference_image, "参考图片")
        reference_image_mask, batch_multi_reference_masks = _split_primary_and_extra_images(reference_image_mask, "参考图片彩色遮罩")
        multi_reference_images = _merge_image_batches(batch_multi_reference_images, multi_reference_images, "多参考图")
        multi_reference_masks = _merge_image_batches(batch_multi_reference_masks, multi_reference_masks, "多参考图遮罩")

        scail_builder = GJJ_WanSCAILToVideo()
        stitched_imgs: list[torch.Tensor] = []
        stitched_latents: list[torch.Tensor] = []
        preview_images: list[dict[str, Any]] = []
        prev_anchor: torch.Tensor | None = None
        offset = 0
        window_index = 0

        while offset < target:
            first_window = window_index == 0
            anchor = 0 if first_window else previous_frame_count
            effective_start = max(0, offset - anchor)
            pose_hi = min(effective_start + window_length, pose_len) if pose_len is not None else effective_start + window_length
            previous_offset = offset
            window_base = 0.05 + 0.90 * (window_index / max(1, total_windows))
            window_next = 0.05 + 0.90 * ((window_index + 1) / max(1, total_windows))
            window_span = max(0.0, window_next - window_base)

            _send_progress(
                unique_id,
                f"窗口 {window_index + 1}/{total_windows}: 输出 [{offset}..{effective_start + window_length}) | "
                f"姿态 [{effective_start}..{pose_hi}) | 锚定 {anchor} 帧",
                window_base,
            )

            _send_progress(
                unique_id,
                f"窗口 {window_index + 1}/{total_windows}：构建 SCAIL 条件与 latent...",
                window_base + window_span * 0.06,
            )
            pos, neg, latent, offset = scail_builder.build(
                positive=positive,
                negative=negative,
                vae=vae,
                width=width,
                height=height,
                length=window_length,
                batch_size=1,
                pose_strength=float(pose_strength),
                pose_start=float(pose_start),
                pose_end=float(pose_end),
                video_frame_offset=offset,
                previous_frame_count=previous_frame_count,
                replacement_mode=bool(replacement_mode),
                reference_image=reference_image,
                clip_vision_output=clip_vision_output,
                pose_video=pose_video,
                pose_video_mask=pose_video_mask,
                background_image=background_image,
                reference_image_mask=reference_image_mask,
                multi_reference_images=multi_reference_images,
                multi_reference_masks=multi_reference_masks,
                previous_frames=prev_anchor,
            )

            chunk_seed = _window_seed(seed, window_index, vary_seed_per_window)
            _send_progress(
                unique_id,
                f"窗口 {window_index + 1}/{total_windows}：采样中 seed={chunk_seed}, steps={int(steps)}",
                window_base + window_span * 0.14,
            )
            sampled = common_ksampler(
                sample_model,
                chunk_seed,
                int(steps),
                float(cfg),
                str(sampler_name),
                str(scheduler),
                pos,
                neg,
                latent,
                denoise=float(denoise),
            )[0]
            chunk_latent = sampled["samples"]
            _send_progress(
                unique_id,
                f"窗口 {window_index + 1}/{total_windows}：采样完成，正在解码...",
                window_base + window_span * 0.78,
            )
            images = _decode_video_latent(vae, chunk_latent, bool(decode_tiled))

            new_images = images[anchor:]
            if int(new_images.shape[0]) <= 0:
                raise RuntimeError("当前窗口没有新增帧。请减少上一段锚定帧数或增大窗口帧数。")
            segment_preview = _save_segment_preview(new_images, f"SCAIL2 第 {window_index + 1} 段")
            if segment_preview is not None:
                preview_images.append(segment_preview)
            kept_latent = chunk_latent[:, :, (0 if first_window else lat_drop):]
            stitched_imgs.append(new_images.detach().cpu())
            stitched_latents.append(kept_latent.detach().cpu())
            total_so_far = sum(int(item.shape[0]) for item in stitched_imgs)
            _send_progress(
                unique_id,
                f"窗口 {window_index + 1}/{total_windows}：解码 {int(images.shape[0])} 帧，保留 {int(new_images.shape[0])} 帧，累计 {total_so_far} 帧",
                window_next,
                preview=segment_preview,
            )

            prev_anchor = images[-previous_frame_count:].detach().cpu()
            del sampled, latent, chunk_latent, images, new_images, kept_latent, pos, neg
            model_management.soft_empty_cache()

            window_index += 1
            if pose_len is None:
                break
            if offset <= previous_offset:
                _send_progress(unique_id, "偏移没有继续推进，已停止以避免无限循环。", window_next)
                break

        if not stitched_imgs or not stitched_latents:
            raise RuntimeError("没有生成任何窗口。请检查输入帧数和最大帧数设置。")

        result_images = torch.cat(stitched_imgs, dim=0)
        result_latent = torch.cat(stitched_latents, dim=2)

        if int(result_images.shape[0]) > target:
            result_images = result_images[:target]
            result_latent = result_latent[:, :, :_latent_frame_count(target)]

        _send_progress(unique_id, f"完成：输出 {int(result_images.shape[0])} 帧，共 {window_index} 个窗口。", 1.0, done=True)
        return {
            "ui": {
                "images": preview_images,
                "frame_count": [int(result_images.shape[0])],
                "segment_count": [int(window_index)],
            },
            "result": (result_images, {"samples": result_latent}, int(result_images.shape[0])),
        }


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanSCAILInfinity,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
