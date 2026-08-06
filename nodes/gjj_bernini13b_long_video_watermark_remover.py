from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import torch
from nodes import common_ksampler

from .gjj_bernini import GJJBerniniConditioning
from .gjj_bernini_studio import (
    _as_format_name,
    _coerce_audio_input,
    _decode_bernini_frames,
    _decode_prompt_linked_video,
    _decode_video_media_frames,
    _load_audio_from_video_path,
    _media_components,
    _memory_cleanup,
    _model_choice_state,
    _require_model_choice,
    _send_segment_preview,
    _send_status,
    _video_combine_result,
)
from .gjj_clip_prompt_encode_panel import GJJ_CLIPPromptEncodePanel
from .gjj_video_combine import GJJ_VideoCombine
from .gjj_video_segment_queue import recover_selected_video, resolve_input_video_path
from .gjj_video_universal_model_loader import GJJ_VideoUniversalModelLoader
from .gjj_memory_manager import _clean_all_resources
from .gjj_model_upscaler import GJJ_ModelUpscaler, _list_pth_upscale_models


NODE_NAME = "GJJ_Bernini13BLongVideoWatermarkRemover"
MEDIA_TYPE = "VIDEO,IMAGE"
REFERENCE_RESOURCE_TYPE = "IMAGE,GJJ_BATCH_IMAGE"
OUTPUT_TYPE = "VIDEO,IMAGE"
DEFAULT_MODEL = "wan2.1_bernini_1.3B_int4_convrot.safetensors"
DEFAULT_CLIP = "umt5_xxl_int4_convrot.safetensors"
DEFAULT_VAE = "wan_2.1_vae.safetensors"
DEFAULT_UPSCALE_MODEL = "RealESRGAN_x2plus.pth"
DEFAULT_PROMPT = " You are a helpful assistant specialized in video editing.clean all watermark,text,logo,signature,caption,overlay"
DEFAULT_NEGATIVE = "bad video"


def _hidden(options: dict[str, Any]) -> dict[str, Any]:
    result = dict(options)
    result.update({"hidden": True, "display": "hidden"})
    return result


def _first(value: Any, default: Any = None) -> Any:
    if isinstance(value, (list, tuple)):
        return value[0] if value else default
    return default if value is None else value


def _number(value: Any, default: float) -> float:
    try:
        return float(_first(value, default))
    except Exception:
        return float(default)


def _integer(value: Any, default: int) -> int:
    return int(_number(value, default))


def _boolean(value: Any, default: bool = False) -> bool:
    value = _first(value, default)
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on", "开", "保持"}:
        return True
    if text in {"0", "false", "no", "off", "关", "释放"}:
        return False
    return bool(default)


def _segment_length(value: Any) -> int:
    raw = max(5, min(4097, _integer(value, 129)))
    return max(5, int(round((raw - 1) / 4.0)) * 4 + 1)


def _pad_segment(frames: torch.Tensor, length: int) -> torch.Tensor:
    if int(frames.shape[0]) >= length:
        return frames[:length].contiguous()
    tail = frames[-1:].repeat(length - int(frames.shape[0]), 1, 1, 1)
    return torch.cat([frames, tail], dim=0).contiguous()


def _walk_reference_resources(
    value: Any,
    result: list[torch.Tensor],
    seen: set[int],
    depth: int = 0,
) -> None:
    """递归解包参考资源，保留容器顺序和每个单帧/多帧资源组。"""
    if value is None or depth > 24:
        return
    if not isinstance(value, (str, bytes, int, float, bool)):
        marker = id(value)
        if marker in seen:
            return
        seen.add(marker)
    if isinstance(value, torch.Tensor):
        tensor = value.detach()
        if tensor.ndim == 3:
            tensor = tensor.unsqueeze(0)
        elif tensor.ndim > 4 and int(tensor.shape[-1]) in (1, 2, 3, 4):
            tensor = tensor.reshape(-1, int(tensor.shape[-3]), int(tensor.shape[-2]), int(tensor.shape[-1]))
        if tensor.ndim != 4 or int(tensor.shape[0]) <= 0:
            return
        if int(tensor.shape[-1]) not in (1, 2, 3, 4) and int(tensor.shape[1]) in (1, 2, 3, 4):
            tensor = tensor.permute(0, 2, 3, 1)
        channels = int(tensor.shape[-1])
        if channels == 1:
            tensor = tensor.repeat(1, 1, 1, 3)
        elif channels == 2:
            tensor = tensor[..., :1].repeat(1, 1, 1, 3)
        elif channels >= 4:
            tensor = tensor[..., :3]
        if int(tensor.shape[-1]) == 3:
            result.append(tensor.float().clamp(0.0, 1.0).contiguous())
        return
    if isinstance(value, dict):
        for item in value.values():
            _walk_reference_resources(item, result, seen, depth + 1)
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            _walk_reference_resources(item, result, seen, depth + 1)
        return
    for key in ("images", "image", "frames", "frame", "batch", "samples", "items", "values"):
        item = getattr(value, key, None)
        if item is not None and item is not value:
            _walk_reference_resources(item, result, seen, depth + 1)


def _reference_resources(value: Any) -> list[torch.Tensor]:
    result: list[torch.Tensor] = []
    _walk_reference_resources(value, result, set())
    return result


def _selected_video_components(selected_video: Any, extra_pnginfo: Any, unique_id: Any):
    entry = recover_selected_video(str(_first(selected_video, "") or ""), extra_pnginfo, unique_id)
    if not entry:
        return None, None, None
    path = resolve_input_video_path(entry)
    frames, fps = _decode_video_media_frames(str(path))
    audio = _load_audio_from_video_path(str(path), unique_id)
    return frames, audio, fps


class GJJ_Bernini13BLongVideoWatermarkRemover:
    CATEGORY = "GJJ/💗 一键生成"
    FUNCTION = "remove"
    OUTPUT_NODE = True
    INPUT_IS_LIST = True
    RETURN_TYPES = (OUTPUT_TYPE,)
    RETURN_NAMES = ("完整去水印视频",)
    OUTPUT_TOOLTIPS = ("完整 VIDEO 输出；保留源视频帧率和音频。未连接输出口也可单独执行并保存。",)
    DESCRIPTION = "Bernini 1.3B 长视频分段去字幕/水印单节点：逐段生成与预览，最终按源帧率合并并保留源音频。"
    SEARCH_ALIASES = ["Bernini 1.3B 去水印", "长视频去字幕", "video watermark remover", "视频去水印"]
    _MODEL_CACHE: dict[tuple[str, str, str], tuple[Any, Any, Any]] = {}

    @classmethod
    def INPUT_TYPES(cls):
        model = _model_choice_state("diffusion_models", ["wan2.1", "bernini", "1.3b"], DEFAULT_MODEL)
        clip = _model_choice_state("text_encoders", ["umt5", "xxl"], DEFAULT_CLIP)
        vae = _model_choice_state("vae", ["wan", "2.1", "vae"], DEFAULT_VAE)
        upscale_models = _list_pth_upscale_models() or [""]
        preferred_upscale_model = next(
            (
                name for name in upscale_models
                if Path(str(name)).name.casefold() == DEFAULT_UPSCALE_MODEL.casefold()
            ),
            upscale_models[0],
        )
        return {
            "required": {},
            "optional": {
                "media": (MEDIA_TYPE, {"display_name": "源视频/帧序列", "tooltip": "可选 VIDEO 或 IMAGE batch；连接后优先于节点内 📁 视频。"}),
                "selected_video": ("STRING", _hidden({"default": "", "display_name": "内部视频"})),
                "prompt": ("STRING", _hidden({"default": DEFAULT_PROMPT, "multiline": True, "display_name": "去字幕/水印提示词"})),
                "negative_prompt": ("STRING", _hidden({"default": DEFAULT_NEGATIVE, "multiline": True, "display_name": "反向提示词"})),
                "segment_frames": ("INT", _hidden({"default": 129, "min": 5, "max": 4097, "step": 4, "display_name": "每段帧数"})),
                "steps": ("INT", _hidden({"default": 4, "min": 1, "max": 100, "step": 1, "display_name": "采样步数"})),
                "cfg": ("FLOAT", _hidden({"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "display_name": "CFG"})),
                "seed": ("INT", _hidden({"default": 26448381970222, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "display_name": "种子"})),
                "sampler_name": ("STRING", _hidden({"default": "res_multistep", "display_name": "采样器"})),
                "scheduler": ("STRING", _hidden({"default": "simple", "display_name": "调度器"})),
                "denoise": ("FLOAT", _hidden({"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "降噪"})),
                "frame_rate": ("FLOAT", _hidden({"default": 8.0, "min": 1.0, "max": 240.0, "step": 1.0, "display_name": "无源帧率时使用"})),
                "filename_prefix": ("STRING", _hidden({"default": "video/Bernini_1.3B_长视频去水印", "display_name": "文件名前缀"})),
                "format_name": ("STRING", _hidden({"default": "video/h264-mp4", "display_name": "输出格式"})),
                "keep_model": ("BOOLEAN", _hidden({"default": False, "display_name": "保持模型"})),
                "model_name": (model["models"], _hidden({"default": model["value"], "display_name": "Bernini 1.3B模型", "gjj_default_model": DEFAULT_MODEL, "gjj_missing_model": model["missing"]})),
                "clip_name": (clip["models"], _hidden({"default": clip["value"], "display_name": "UMT5 XXL", "gjj_default_model": DEFAULT_CLIP, "gjj_missing_model": clip["missing"]})),
                "vae_name": (vae["models"], _hidden({"default": vae["value"], "display_name": "Wan VAE", "gjj_default_model": DEFAULT_VAE, "gjj_missing_model": vae["missing"]})),
                "reference_resources": (REFERENCE_RESOURCE_TYPE, {"display_name": "参考资源", "tooltip": "递归解包 IMAGE / GJJ_BATCH_IMAGE；按输入顺序将多帧批次作为参考视频、单帧作为参考图片传入 BerniniConditioning。"}),
                "pre_cleanup_resources": ("BOOLEAN", _hidden({"default": True, "display_name": "预清理资源", "tooltip": "开启后，在执行其它操作前按 GJJ_MemoryManager 的强力清理逻辑释放系统内存、显存和模型缓存。"})),
                "enable_pre_upscale": ("BOOLEAN", _hidden({"default": False, "display_name": "预放大源视频", "tooltip": "开启后先使用 GJJ_ModelUpscaler 放大源视频帧，再执行 Bernini 分段去水印；关闭时不会检查或加载放大模型。"})),
                "upscale_model_name": (upscale_models, _hidden({"default": preferred_upscale_model, "display_name": "放大模型", "gjj_default_model": preferred_upscale_model, "tooltip": "仅在启用预放大源视频时使用；优先选择 RealESRGAN_x2plus.pth。"})),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "prompt_info": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return float("NaN")

    def _load_models(self, model_name: str, clip_name: str, vae_name: str, keep_model: bool, unique_id: Any):
        key = (model_name, clip_name, vae_name)
        if keep_model and key in self._MODEL_CACHE:
            return self._MODEL_CACHE[key]
        result = GJJ_VideoUniversalModelLoader().load_models(
            config="wan21_bernini_13b_lightx2v",
            use_accel_lora=True,
            file_1=_require_model_choice(model_name, "Bernini 1.3B 模型"),
            file_2=_require_model_choice(clip_name, "UMT5 XXL"),
            file_3=_require_model_choice(vae_name, "Wan VAE"),
            dtype_1="fp8_e4m3fn",
            dtype_2="fp8_e4m3fn",
            dtype_3="default",
            clip_type_override="auto",
            unique_id=unique_id,
        )
        model, vae, clip = result[0], result[1], result[2]
        if model is None or vae is None or clip is None:
            raise RuntimeError("Bernini 1.3B 模型、UMT5 XXL 或 Wan VAE 加载不完整。")
        loaded = (model, vae, clip)
        if keep_model:
            self._MODEL_CACHE[key] = loaded
        return loaded

    def remove(self, **kwargs):
        unique_id = _first(kwargs.get("unique_id"))
        prompt_info = _first(kwargs.get("prompt_info"))
        extra_pnginfo = _first(kwargs.get("extra_pnginfo"))
        keep_model_requested = _boolean(kwargs.get("keep_model"), False)
        requested_model_key = (
            str(_first(kwargs.get("model_name"), DEFAULT_MODEL)),
            str(_first(kwargs.get("clip_name"), DEFAULT_CLIP)),
            str(_first(kwargs.get("vae_name"), DEFAULT_VAE)),
        )
        if _boolean(kwargs.get("pre_cleanup_resources"), True):
            _send_status(unique_id, "0/5 正在预清理显存、内存和模型缓存...", 0.0)
            protected_models = self._MODEL_CACHE.get(requested_model_key) if keep_model_requested else None
            if protected_models is None:
                self._MODEL_CACHE.clear()
            cleanup_result = _clean_all_resources(protected_values=protected_models)
            _send_status(
                unique_id,
                (
                    "0/5 预清理完成（已保护 Bernini 1.3B / UMT5 / VAE）："
                    if protected_models is not None else
                    "0/5 预清理完成："
                ) + cleanup_result.get("message", "资源已清理"),
                0.01,
            )
        media = _first(kwargs.get("media"))
        frames, audio, fps = _media_components(media)
        if frames is None:
            linked_frames, linked_audio, linked_fps = _decode_prompt_linked_video(prompt_info, unique_id, "media")
            frames, audio, fps = linked_frames, linked_audio, linked_fps
        if frames is None:
            frames, audio, fps = _selected_video_components(kwargs.get("selected_video"), extra_pnginfo, unique_id)
        if frames is None or int(frames.shape[0]) <= 0:
            raise RuntimeError("请连接 VIDEO/IMAGE 输入，或点击节点第一个 📁 按钮选择视频。")

        frames = frames.detach().cpu().contiguous()
        if _boolean(kwargs.get("enable_pre_upscale"), False):
            _send_status(unique_id, "1/6 正在使用 GJJ_ModelUpscaler 预放大源视频...", 0.015)
            frames = GJJ_ModelUpscaler().upscale(
                frames,
                True,
                str(_first(kwargs.get("upscale_model_name"), "") or ""),
                unique_id=unique_id,
            )[0].detach().cpu().contiguous()
        reference_resources = _reference_resources(kwargs.get("reference_resources"))
        total_frames = int(frames.shape[0])
        height, width = int(frames.shape[1]), int(frames.shape[2])
        width = max(16, int(round(width / 16.0)) * 16)
        height = max(16, int(round(height / 16.0)) * 16)
        segment_frames = _segment_length(kwargs.get("segment_frames"))
        segment_count = max(1, int(math.ceil(total_frames / float(segment_frames))))
        keep_model = _boolean(kwargs.get("keep_model"), False)
        if not keep_model:
            self._MODEL_CACHE.clear()
        _memory_cleanup(unique_id, "运行前清理显存和内存...", clear_video_cache=False)
        _send_status(unique_id, "1/5 加载 Bernini 1.3B / UMT5 / VAE...", 0.02)
        model, vae, clip = self._load_models(
            str(_first(kwargs.get("model_name"), DEFAULT_MODEL)),
            str(_first(kwargs.get("clip_name"), DEFAULT_CLIP)),
            str(_first(kwargs.get("vae_name"), DEFAULT_VAE)),
            keep_model,
            unique_id,
        )
        positive, negative = GJJ_CLIPPromptEncodePanel().encode(
            clip=clip,
            positive_text=str(_first(kwargs.get("prompt"), DEFAULT_PROMPT)),
            negative_text=str(_first(kwargs.get("negative_prompt"), DEFAULT_NEGATIVE)),
            zero_conditioning=False,
            translation_device="gpu",
            translation_unload_after_use=True,
            translation_enabled=False,
            unique_id=unique_id,
        )

        generated: list[torch.Tensor] = []
        latest_preview: list[dict[str, Any]] = []
        effective_fps = float(fps or _number(kwargs.get("frame_rate"), 8.0))
        for index in range(segment_count):
            start = index * segment_frames
            end = min(total_frames, start + segment_frames)
            source = frames[start:end]
            desired = int(source.shape[0])
            generation_length = _segment_length(desired)
            source = _pad_segment(source, generation_length)
            _send_status(unique_id, f"2/5 生成第 {index + 1}/{segment_count} 段（源帧 {start + 1}-{end}）...", 0.08 + 0.76 * index / max(1, segment_count))
            seg_positive, seg_negative, latent = GJJBerniniConditioning().build(
                positive=positive,
                negative=negative,
                vae=vae,
                width=width,
                height=height,
                length=generation_length,
                batch_size=1,
                ref_max_size=max(width, height),
                source_video=source,
                reference_resources=reference_resources,
            )
            sampled = common_ksampler(
                model,
                _integer(kwargs.get("seed"), 26448381970222) + index,
                max(1, _integer(kwargs.get("steps"), 4)),
                _number(kwargs.get("cfg"), 1.0),
                str(_first(kwargs.get("sampler_name"), "res_multistep")),
                str(_first(kwargs.get("scheduler"), "simple")),
                seg_positive,
                seg_negative,
                latent,
                denoise=max(0.0, min(1.0, _number(kwargs.get("denoise"), 1.0))),
            )[0]
            decoded = _decode_bernini_frames(vae, sampled, {"vae_tiling": True, "tile_x": 272, "tile_y": 272})
            decoded = decoded[:desired].detach().cpu().contiguous()
            generated.append(decoded)
            preview_result = GJJ_VideoCombine().combine(
                images=decoded,
                frame_rate=effective_fps,
                loop_count=0,
                filename_prefix=f"gjj_bernini13b_segment_{index + 1:04d}",
                format_name="video/h264-mp4",
                pingpong=False,
                save_output=False,
                use_source_fps=False,
                delete_tail_frame=False,
                save_metadata=False,
                trim_to_audio=False,
                pix_fmt="auto",
                crf="-1",
                vae=None,
                audio=None,
                prompt=None,
                extra_pnginfo=None,
                unique_id=None,
            )
            latest_preview = list(preview_result.get("ui", {}).get("preview_media") or [])
            _send_segment_preview(unique_id, latest_preview, index + 1, segment_count, "segment_video")

        _send_status(unique_id, "4/5 合并片段并封装源音频...", 0.9)
        all_frames = torch.cat(generated, dim=0)[:total_frames].contiguous()
        audio_input = media if callable(getattr(media, "get_components", None)) else _coerce_audio_input(audio)
        final_combine = GJJ_VideoCombine().combine(
                images=all_frames,
                frame_rate=effective_fps,
                loop_count=0,
                filename_prefix=str(_first(kwargs.get("filename_prefix"), "video/Bernini_1.3B_长视频去水印")),
                format_name=_as_format_name(str(_first(kwargs.get("format_name"), "video/h264-mp4"))),
                pingpong=False,
                save_output=True,
                use_source_fps=True,
                delete_tail_frame=False,
                save_metadata=True,
                trim_to_audio=False,
                pix_fmt="auto",
                crf="-1",
                vae=None,
                audio=audio_input,
                prompt=prompt_info,
                extra_pnginfo=extra_pnginfo,
                unique_id=unique_id,
            )
        video, output_path, _files = _video_combine_result(final_combine)
        final_preview = list(final_combine.get("ui", {}).get("preview_media") or [])
        if final_preview:
            latest_preview = final_preview
            _send_segment_preview(unique_id, final_preview, segment_count, segment_count, "final_video")
        _send_status(unique_id, f"5/5 完成：{total_frames} 帧 / {segment_count} 段 / {effective_fps:g} FPS", 1.0)
        if not keep_model:
            _memory_cleanup(unique_id, "完成并释放模型...", clear_video_cache=False)
        return {
            "ui": {"gjj_images": latest_preview, "preview_label": ["final_video"], "segment_count": [segment_count], "frame_count": [total_frames], "output_path": [str(output_path or "")]},
            "result": (video,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Bernini13BLongVideoWatermarkRemover}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ ·🎞️一键去长视频字幕/水印（Bernini 1.3B）"}
