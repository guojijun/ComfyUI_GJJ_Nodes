from __future__ import annotations

from typing import Any

import comfy.model_sampling
import folder_paths
import torch
from nodes import CheckpointLoaderSimple, CLIPTextEncode, VAEDecode, common_ksampler
from server import PromptServer

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE
from .common_utils.dependency_checker import build_node_help_payload, make_missing_model_spec
from .gjj_multi_lora_chain import (
    apply_lora_chain_config,
    normalize_lora_chain_data,
)
from .gjj_video_combine_runtime import DEFAULT_FILENAME_PREFIX, DEFAULT_FORMAT, combine_video, list_supported_formats
from .gjj_wan22_rapid_aio_mega import _build_vace_control_frames, _build_vace_latent


NODE_NAME = "GJJ_Wan22FirstLastVideo"
DEFAULT_CHECKPOINT = "wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors"
DEFAULT_POSITIVE = "美女"
DEFAULT_NEGATIVE = "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
DEFAULT_SHIFT = 8.0
DEFAULT_STEPS = 4
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "ipndm"
DEFAULT_SCHEDULER = "beta"
DEFAULT_DENOISE = 1.0
DEFAULT_WIDTH = 768
DEFAULT_HEIGHT = 768
DEFAULT_LENGTH = 65
DEFAULT_FPS = 16.0
DEFAULT_DURATION_SECONDS = (DEFAULT_LENGTH - 1) / DEFAULT_FPS
DEFAULT_EMPTY_FRAME_LEVEL = 0.5
DEFAULT_FILENAME = f"{DEFAULT_FILENAME_PREFIX}/Wan22FirstLastVideo"
DEFAULT_AUDIO_MODE = "循环补足到视频长度"
MIXED_IMAGE_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
NODE_DESCRIPTION = (
    "将 Wan2.2 视频工作流封装成零外部依赖单节点：未接图走文生视频，"
    "1 张图走图生视频，2 张图走首尾帧，多张图按相邻图片循环首尾帧分段生成。"
)


class MultiInput(str):
    def __new__(cls, string: str, allowed_types="*"):
        instance = super().__new__(cls, string)
        instance.allowed_types = allowed_types
        return instance

    @staticmethod
    def _type_set(value):
        if isinstance(value, (list, tuple, set)):
            parts = []
            for item in value:
                parts.extend(str(item).split(","))
        else:
            parts = str(value).split(",")
        return {part.strip() for part in parts if part.strip()}

    def __ne__(self, other):
        if self.allowed_types == "*" or other == "*":
            return False
        allowed = self._type_set(self.allowed_types)
        incoming = self._type_set(other)
        return not (incoming.issubset(allowed) or allowed.issubset(incoming))


FLOAT_OR_INT = MultiInput("FLOAT", ["INT", "FLOAT"])

WAN22_AIO_MODEL_SPEC = make_missing_model_spec(
    label="Wan2.2 Rapid/Mega/AIO Checkpoint",
    subdir="models/checkpoints",
    filename=DEFAULT_CHECKPOINT,
    description="AIO 单文件 checkpoint，节点只从 models/checkpoints 读取；不需要在 text_encoders 另放同名文件。",
)
WAN22_FIRST_LAST_DEPENDENCIES = [
    {
        "name": "ComfyUI 核心节点",
        "type": "内置运行时",
        "required": True,
        "description": "使用 CheckpointLoaderSimple、CLIPTextEncode、common_ksampler、VAEDecode 完成加载、编码、采样和解码。",
    },
    {
        "name": "GJJ Wan2.2 AIO/VACE 工具",
        "type": "GJJ 内置模块",
        "required": True,
        "description": "复用 GJJ_Wan22RapidAioMega 的 VACE 首尾帧控制帧和 latent 构建逻辑。",
    },
    {
        "name": "GJJ 视频合成运行时",
        "type": "GJJ 内置模块",
        "required": True,
        "description": "复用 GJJ video combine runtime 合成最终 VIDEO、写入预览和可选音轨。",
    },
    {
        "name": "LoRA 串联配置",
        "type": "可选输入",
        "required": False,
        "description": "连接 LORA_CHAIN_CONFIG 时，会按顺序加载 models/loras 下的 LoRA 并应用到模型与 CLIP。",
    },
    {
        "name": "AUDIO 音频输入",
        "type": "可选输入",
        "required": False,
        "description": "连接音频时，最终视频会按帧数和 FPS 截断、循环补足或静音补足后封入音轨。",
    },
]
WAN22_FIRST_LAST_MODEL_TREE = [
    {
        "label": DEFAULT_CHECKPOINT,
        "path": "models/checkpoints",
        "required": True,
        "description": "默认 AIO checkpoint；实际下拉会读取当前 ComfyUI checkpoints 列表，可使用子目录相对路径。",
    },
    {
        "label": "LoRA 串联配置中的 LoRA 文件",
        "path": "models/loras",
        "required": False,
        "description": "仅在连接 LoRA 串联配置时需要；保留原始子目录相对文件名。",
    },
    {
        "label": "输出视频与分段预览",
        "path": "output / temp",
        "required": False,
        "description": "save_output 开启时写入 output；关闭时写入 temp 供节点内预览。",
    },
]
WAN22_FIRST_LAST_RUNTIME_TREE = [
    "CheckpointLoaderSimple 读取单个 AIO checkpoint",
    "可选 LoRA_CHAIN_CONFIG -> 应用到 Model / CLIP",
    "图片输入数量决定路线：0 文生视频，1 图生视频，2 首尾帧，多图相邻分段",
    "VACE 控制帧 + latent -> common_ksampler -> VAEDecode",
    "多段帧序列拼接 -> 可选音频适配 -> combine_video",
]
WAN22_FIRST_LAST_USAGE = [
    "AIO模型（Checkpoint）来自 models/checkpoints，默认优先匹配 Wan2.2 Rapid/Mega/AIO 文件。",
    "图片/帧序列为空时按文生视频执行；多张图片会按 1-2、2-3、3-4 依次生成分段。",
    "连接 LoRA 串联配置时，LoRA 文件需位于 models/loras 下。",
    "分段保存只影响检查用分段视频，最终仍会合成一个完整视频。",
]
WAN22_FIRST_LAST_GJJ_HELP = build_node_help_payload(
    description=NODE_DESCRIPTION,
    notice="需要本地 Wan2.2 AIO checkpoint；GJJ 内置 VACE 构建、LoRA 串联和视频合成运行时。",
    dependencies=WAN22_FIRST_LAST_DEPENDENCIES,
    model_tree=WAN22_FIRST_LAST_MODEL_TREE,
    models=[WAN22_AIO_MODEL_SPEC],
    runtime=WAN22_FIRST_LAST_RUNTIME_TREE,
    usage=WAN22_FIRST_LAST_USAGE,
    copy_text="models/checkpoints/" + DEFAULT_CHECKPOINT,
    copy_label="📋 复制默认模型路径",
    extra={"static_model_tree_only": True},
)


def _send_status(unique_id: Any, text: str, progress: float | None = None, **extra: Any) -> None:
    if not unique_id:
        return
    try:
        payload = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        payload.update({key: value for key, value in extra.items() if value is not None})
        PromptServer.instance.send_sync(
            "gjj_node_progress",
            payload,
        )
    except Exception:
        pass


def _send_preview_status(unique_id: Any, text: str, progress: float | None, ui_payload: dict[str, Any]) -> None:
    if not isinstance(ui_payload, dict):
        _send_status(unique_id, text, progress)
        return
    _send_status(
        unique_id,
        text,
        progress,
        preview_media=ui_payload.get("preview_media"),
        preview_is_video=ui_payload.get("preview_is_video"),
        preview_width=ui_payload.get("preview_width"),
        preview_height=ui_payload.get("preview_height"),
    )


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
    target_base = preferred.replace("\\", "/").split("/")[-1] if preferred else ""
    if target_base:
        for name in available:
            if name.replace("\\", "/").split("/")[-1].lower() == target_base.lower():
                return name
    normalized = _normalize_text(preferred)
    if normalized:
        for name in available:
            if normalized in _normalize_text(name):
                return name
    if fallback:
        return _pick_available_name(fallback, available, "")
    return available[0] if available else ""


def _list_aio_checkpoints() -> list[str]:
    checkpoints = _safe_filename_list("checkpoints")
    filtered = []
    for name in checkpoints:
        normalized = _normalize_text(name)
        if "wan22" in normalized and ("aio" in normalized or "rapid" in normalized or "mega" in normalized):
            filtered.append(name)
    return filtered or checkpoints or [DEFAULT_CHECKPOINT]


def _require_checkpoint_name(preferred: str) -> str:
    available = _list_aio_checkpoints()
    resolved = _pick_available_name(preferred, available, DEFAULT_CHECKPOINT)
    if not resolved:
        raise RuntimeError(f"未找到 Wan2.2 AIO Checkpoint：{preferred or DEFAULT_CHECKPOINT}")
    full_path = folder_paths.get_full_path("checkpoints", resolved)
    if not full_path:
        raise RuntimeError(f"未找到 Wan2.2 AIO Checkpoint：models/checkpoints/{resolved}")
    return resolved


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


def _apply_sd3_shift(model, shift: float):
    patched = model.clone()

    class ModelSamplingAdvanced(comfy.model_sampling.ModelSamplingDiscreteFlow, comfy.model_sampling.CONST):
        pass

    model_sampling = ModelSamplingAdvanced(model.model.model_config)
    model_sampling.set_parameters(shift=float(shift), multiplier=1000)
    patched.add_object_patch("model_sampling", model_sampling)
    return patched


def _is_empty_loader_placeholder(images: torch.Tensor) -> bool:
    if images is None or not isinstance(images, torch.Tensor) or images.ndim != 4:
        return False
    if tuple(int(x) for x in images.shape) != (1, 64, 64, 3):
        return False
    return bool(torch.count_nonzero(images).item() == 0)


def _extract_image_frames(images: Any) -> list[torch.Tensor]:
    if images is None:
        return []
    if isinstance(images, dict):
        for key in ("images", "frames", "image", "samples"):
            if key in images:
                return _extract_image_frames(images.get(key))
        raise RuntimeError(f"不支持的图片输入字典：{sorted(images.keys())}")
    if isinstance(images, (list, tuple)):
        frames: list[torch.Tensor] = []
        for item in images:
            frames.extend(_extract_image_frames(item))
        return frames
    if not isinstance(images, torch.Tensor):
        raise RuntimeError(f"不支持的图片输入类型：{type(images)!r}")

    batch = images
    if batch.ndim == 3:
        batch = batch.unsqueeze(0)
    if batch.ndim != 4:
        raise RuntimeError(f"图片输入维度无效：{tuple(batch.shape)}")
    if _is_empty_loader_placeholder(batch):
        return []
    if int(batch.shape[-1]) < 3:
        raise RuntimeError(f"图片输入通道数不足：{tuple(batch.shape)}")

    batch = batch[..., :3].detach().float().cpu().clamp(0.0, 1.0).contiguous()
    return [batch[index:index + 1].contiguous() for index in range(int(batch.shape[0]))]


def _build_route_name(image_count: int) -> str:
    if image_count <= 0:
        return "Wan 文生视频"
    if image_count == 1:
        return "Wan 图生视频"
    if image_count == 2:
        return "Wan 首尾帧"
    return "Wan 多图循环首尾帧"


def _segment_pairs(image_frames: list[torch.Tensor]) -> list[tuple[torch.Tensor | None, torch.Tensor | None]]:
    image_count = len(image_frames)
    if image_count <= 0:
        return [(None, None)]
    if image_count == 1:
        return [(image_frames[0], None)]
    return [(image_frames[index], image_frames[index + 1]) for index in range(image_count - 1)]


def _concat_segments(segments: list[torch.Tensor]) -> torch.Tensor:
    if not segments:
        return torch.zeros((0, 64, 64, 3), dtype=torch.float32)
    return torch.cat(segments, dim=0).detach().float().cpu().contiguous()


def _fit_audio_to_video(audio: Any, frame_count: int, fps: float, mode: str) -> dict[str, Any] | None:
    if audio is None:
        return None
    if not isinstance(audio, dict) or not isinstance(audio.get("waveform"), torch.Tensor):
        raise RuntimeError("音频输入必须是 ComfyUI AUDIO 对象。")

    waveform = audio["waveform"].detach().float().cpu()
    if waveform.ndim == 2:
        waveform = waveform.unsqueeze(0)
    if waveform.ndim != 3:
        raise RuntimeError(f"音频张量维度无效：{tuple(waveform.shape)}")

    sample_rate = int(audio.get("sample_rate") or 44100)
    target_samples = max(1, int(round(float(frame_count) / max(0.01, float(fps)) * sample_rate)))
    current_samples = int(waveform.shape[-1])
    if current_samples <= 0:
        return None

    mode_text = str(mode or DEFAULT_AUDIO_MODE)
    if current_samples >= target_samples:
        waveform = waveform[..., :target_samples].contiguous()
    elif "循环" in mode_text:
        repeats = (target_samples + current_samples - 1) // current_samples
        waveform = waveform.repeat(1, 1, repeats)[..., :target_samples].contiguous()
    else:
        padding = torch.zeros(
            waveform.shape[0],
            waveform.shape[1],
            target_samples - current_samples,
            dtype=waveform.dtype,
            device=waveform.device,
        )
        waveform = torch.cat([waveform, padding], dim=-1).contiguous()

    fitted = dict(audio)
    fitted["waveform"] = waveform
    fitted["sample_rate"] = sample_rate
    return fitted


def _duration_to_frame_count(duration_seconds: Any, fps: Any) -> int:
    duration = max(0.01, float(duration_seconds))
    frame_rate = max(0.01, float(fps))
    return max(1, int((duration * frame_rate // 4) * 4 + 1))


class GJJ_Wan22FirstLastVideo:
    CATEGORY = "GJJ/🎬 视频/生成/万相视频"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = NODE_DESCRIPTION
    REQUIRED_MODELS = [WAN22_AIO_MODEL_SPEC]
    GJJ_HELP = WAN22_FIRST_LAST_GJJ_HELP
    SEARCH_ALIASES = ["SSW","wan flf2v", "wan first last", "首尾帧", "首尾帧生视频", "wan 视频"]
    RETURN_TYPES = ("VIDEO", MIXED_IMAGE_TYPE)
    RETURN_NAMES = ("🎬 视频生成结果", "🖼️ 视频帧序列")
    OUTPUT_TOOLTIPS = (
        "按节点参数生成并合成后的官方 VIDEO 输出，可继续接视频处理节点。",
        "解码后的完整帧序列，类型兼容 GJJ_BATCH_IMAGE 与 IMAGE。",
    )

    def __init__(self):
        self.loaded_lora: tuple[str, Any] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = _list_aio_checkpoints()
        default_checkpoint = _pick_available_name(DEFAULT_CHECKPOINT, checkpoints, DEFAULT_CHECKPOINT)
        supported_formats = list_supported_formats()
        default_format = DEFAULT_FORMAT if DEFAULT_FORMAT in supported_formats else supported_formats[0]
        return {
            "required": {
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_POSITIVE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "📝 正向提示词",
                        "tooltip": "Wan2.2 AIO 视频生成正向提示词。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "🚫 反向提示词",
                        "tooltip": "Wan2.2 AIO 视频生成反向提示词。",
                    },
                ),
                "checkpoint_name": (
                    checkpoints,
                    {
                        "default": default_checkpoint,
                        "display_name": "🧠 Wan2.2 AIO单文件模型",
                        "tooltip": "从 models/checkpoints 选择 Wan2.2 Rapid / Mega / AIO 单文件 checkpoint；不需要在 text_encoders 另放同名文件。",
                    },
                ),
                "width": ("INT", {"default": DEFAULT_WIDTH, "min": 16, "max": 8192, "step": 16, "display_name": "📐 宽度", "tooltip": "最终视频帧宽度。"}),
                "height": ("INT", {"default": DEFAULT_HEIGHT, "min": 16, "max": 8192, "step": 16, "display_name": "📏 高度", "tooltip": "最终视频帧高度。"}),
                "duration_seconds": ("FLOAT", {"default": DEFAULT_DURATION_SECONDS, "min": 0.1, "max": 600.0, "step": 0.1, "display_name": "⏱️ 时长（秒）", "tooltip": "单段生成时长。后台按 int((时长 * 帧率 // 4) * 4 + 1) 计算内部帧数。"}),
                "fps": (FLOAT_OR_INT, {"default": DEFAULT_FPS, "min": 1.0, "max": 120.0, "step": 1.0, "display_name": "🎞️ 帧率", "tooltip": "输出视频的帧率。参考 GJJ_VideoCombine，支持接入 INT 或 FLOAT，执行时统一按浮点数计算。"}),
                "filename_prefix": (
                    "STRING",
                    {
                        "default": DEFAULT_FILENAME,
                        "display_name": "📁 文件名前缀",
                        "tooltip": "节点内合成/预览视频的保存前缀，支持子目录，例如 video/GJJ/Wan22。",
                    },
                ),
                "format_name": (
                    supported_formats,
                    {
                        "default": default_format,
                        "display_name": "🎞️ 输出格式",
                        "tooltip": "节点内合成与预览使用的格式；默认 video/h264-mp4。",
                    },
                ),
                "save_output": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "💾 保存最终视频",
                        "tooltip": "开启后写入 output 目录；关闭后写入 temp 目录用于节点内预览。",
                    },
                ),
                "save_segments": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "🧩 分段保存",
                        "tooltip": "多图循环首尾帧时，把每个分段也单独写出，便于检查转场。",
                    },
                ),
                "audio_fit_mode": (
                    [DEFAULT_AUDIO_MODE, "静音补足到视频长度"],
                    {
                        "default": DEFAULT_AUDIO_MODE,
                        "display_name": "🔊 音频适配",
                        "tooltip": "音频长于视频会截断；音频短于视频时可循环补足或静音补足。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 216136708794704,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "🎲 种子",
                        "tooltip": "随机种子；改变后会得到不同的视频内容。",
                    },
                ),
            },
            "optional": {
                "images": (
                    MIXED_IMAGE_TYPE,
                    {
                        "display_name": "🖼️ 图片/帧序列",
                        "tooltip": "可选。未接图走文生视频，1 张走图生视频，2 张走首尾帧，多张按相邻图片循环首尾帧分段生成。",
                    },
                ),
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "display_name": "🧬 LoRA串联配置",
                        "tooltip": "可选。接入后会在加载 models/checkpoints 里的 AIO checkpoint 后，按配置顺序应用到模型与 CLIP。",
                    },
                ),
                "audio": (
                    "AUDIO",
                    {
                        "display_name": "🔊 音频",
                        "tooltip": "可选。最终视频合成时会按视频长度截断或循环/补静音后封入音轨。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def generate(
        self,
        positive_prompt,
        negative_prompt,
        checkpoint_name,
        width,
        height,
        duration_seconds,
        fps,
        filename_prefix,
        format_name,
        save_output,
        save_segments,
        audio_fit_mode,
        seed,
        images=None,
        lora_chain_config="",
        audio=None,
        unique_id=None,
        prompt=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        image_frames = _extract_image_frames(images)
        if not image_frames and (kwargs.get("start_image") is not None or kwargs.get("end_image") is not None):
            legacy_frames = []
            if kwargs.get("start_image") is not None:
                legacy_frames.extend(_extract_image_frames(kwargs.get("start_image"))[:1])
            if kwargs.get("end_image") is not None:
                legacy_frames.extend(_extract_image_frames(kwargs.get("end_image"))[:1])
            image_frames = legacy_frames

        image_count = len(image_frames)
        route_name = _build_route_name(image_count)
        segment_pairs = _segment_pairs(image_frames)
        segment_count = len(segment_pairs)
        fps = max(0.01, float(fps))
        length = _duration_to_frame_count(duration_seconds, fps)

        checkpoint_name = checkpoint_name or kwargs.get("unet_name") or DEFAULT_CHECKPOINT

        _send_status(unique_id, f"1/8 检查并加载 Wan2.2 AIO Checkpoint：{route_name}...", 0.04)
        try:
            resolved_checkpoint = _require_checkpoint_name(checkpoint_name)
            model, clip, vae = CheckpointLoaderSimple().load_checkpoint(resolved_checkpoint)
            model = _apply_sd3_shift(model, DEFAULT_SHIFT)
            model, clip, self.loaded_lora = _apply_chain_loras(
                model,
                clip,
                lora_chain_config=lora_chain_config,
                loaded_lora_cache=self.loaded_lora,
            )
        except Exception as exc:
            raise RuntimeError(
                "Wan2.2 AIO 节点加载 Checkpoint 失败。\n"
                f"Checkpoint：models/checkpoints/{checkpoint_name}\n"
                f"详细错误：{exc}"
            ) from exc

        _send_status(unique_id, "2/8 编码提示词...", 0.14)
        positive = CLIPTextEncode().encode(clip, str(positive_prompt or "").strip() or DEFAULT_POSITIVE)[0]
        negative = CLIPTextEncode().encode(clip, str(negative_prompt or "").strip() or DEFAULT_NEGATIVE)[0]

        collected_segments: list[torch.Tensor] = []
        for segment_index, (segment_start, segment_end) in enumerate(segment_pairs):
            progress_base = 0.18 + 0.58 * (segment_index / max(1, segment_count))
            segment_label = f"第 {segment_index + 1}/{segment_count} 段"
            if image_count <= 0:
                mode_label = "文生视频"
            elif segment_end is None:
                mode_label = "图生视频"
            else:
                mode_label = "首尾帧"

            _send_status(unique_id, f"3/8 {segment_label}：构建 AIO/VACE {mode_label} 条件...", progress_base)
            strength = 0.0 if image_count <= 0 else 1.0
            control_images, control_masks = _build_vace_control_frames(
                num_frames=int(length),
                empty_frame_level=DEFAULT_EMPTY_FRAME_LEVEL,
                start_image=segment_start,
                end_image=segment_end,
            )
            segment_positive, segment_negative, latent, _ = _build_vace_latent(
                positive,
                negative,
                vae,
                int(width),
                int(height),
                int(length),
                1,
                strength,
                control_video=control_images,
                control_masks=control_masks,
                reference_image=None,
            )

            _send_status(unique_id, f"4/8 {segment_label}：AIO 采样中...", progress_base + 0.18)
            sampled = common_ksampler(
                model,
                int(seed),
                DEFAULT_STEPS,
                DEFAULT_CFG,
                DEFAULT_SAMPLER,
                DEFAULT_SCHEDULER,
                segment_positive,
                segment_negative,
                latent,
                denoise=DEFAULT_DENOISE,
            )[0]

            _send_status(unique_id, f"5/8 {segment_label}：VAE 解码视频帧...", progress_base + 0.38)
            decoded = VAEDecode().decode(vae, sampled)[0].detach().float().cpu().contiguous()
            if segment_index > 0 and int(decoded.shape[0]) > 1:
                decoded = decoded[1:].contiguous()
            collected_segments.append(decoded)

            if bool(save_segments):
                _send_status(unique_id, f"6/8 {segment_label}：保存分段预览...", progress_base + 0.48)
                segment_combined = combine_video(
                    images=decoded,
                    video_inputs=None,
                    frame_rate=float(fps),
                    loop_count=0,
                    filename_prefix=f"{str(filename_prefix or DEFAULT_FILENAME).strip()}_segment_{segment_index + 1:02d}",
                    format_name=format_name,
                    pingpong=False,
                    save_output=save_output,
                    use_source_fps=False,
                    delete_tail_frame=False,
                    audio=None,
                    vae=None,
                    prompt=prompt,
                    extra_pnginfo=extra_pnginfo,
                    unique_id=unique_id,
                )
                _send_preview_status(
                    unique_id,
                    f"{segment_label} 预览已更新",
                    progress_base + 0.5,
                    dict(segment_combined.get("ui") or {}),
                )

        _send_status(unique_id, "7/8 合并帧序列并处理音频...", 0.82)
        frames = _concat_segments(collected_segments)
        fitted_audio = _fit_audio_to_video(audio, int(frames.shape[0]), float(fps), str(audio_fit_mode))

        _send_status(unique_id, "8/8 合成最终视频并生成节点内预览...", 0.9)
        combined = combine_video(
            images=frames,
            video_inputs=None,
            frame_rate=float(fps),
            loop_count=0,
            filename_prefix=str(filename_prefix or DEFAULT_FILENAME).strip() or DEFAULT_FILENAME,
            format_name=format_name,
            pingpong=False,
            save_output=save_output,
            use_source_fps=False,
            delete_tail_frame=False,
            audio=fitted_audio,
            vae=None,
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
            unique_id=unique_id,
        )
        ui_payload = dict(combined.get("ui") or {})
        _send_preview_status(unique_id, "最终视频预览已更新", 0.96, ui_payload)
        ui_payload.update(
            {
                "mode_summary": [route_name],
                "frame_count": [int(frames.shape[0])],
                "frame_size": [f"{int(width)}x{int(height)}"],
                "source_image_count": [image_count],
                "segment_count": [segment_count],
                "has_audio": [fitted_audio is not None],
            }
        )
        video = combined.get("result", (None,))[0]
        _send_status(unique_id, f"完成：{route_name}，{segment_count} 段 / {int(frames.shape[0])} 帧", 1.0)
        return {
            "ui": ui_payload,
            "result": (video, frames),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Wan22FirstLastVideo}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·🎬多功能视频生成器(WAN2.2) 🧡"}
