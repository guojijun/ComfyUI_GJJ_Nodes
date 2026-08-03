from __future__ import annotations

import hashlib
import time
from typing import Any

import folder_paths
import torch

from .gjj_bernini_studio import (
    _basic_sigmas,
    _ksampler,
    _media_components,
    _node_output_first,
    _video_combine_result,
)
from .gjj_video_combine import GJJ_VideoCombine
from .gjj_video_universal_model_loader import _load_clip, _load_unet_model, _load_vae


NODE_NAME = "GJJ_MiniMaxH3Studio"
MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO,AUDIO"

DEFAULT_FL_MODEL = "minimax_h3_fl2va_pruned_nvfp4_base.safetensors"
DEFAULT_REF_MODEL = "minimax_h3_ref2va_pruned_nvfp4_base.safetensors"
DEFAULT_CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
DEFAULT_VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
DEFAULT_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"


def _choices(kind: str, preferred: str, contains: tuple[str, ...]) -> tuple[list[str], str]:
    try:
        names = sorted(str(x) for x in folder_paths.get_filename_list(kind))
    except Exception:
        names = []
    filtered = [x for x in names if all(part.lower() in x.lower() for part in contains)]
    values = filtered or names or [preferred]
    value = preferred if preferred in values else values[0]
    return values, value


def _unwrap_node_output(value: Any) -> tuple[Any, ...]:
    result = getattr(value, "result", None)
    if result is not None:
        return tuple(result)
    if isinstance(value, tuple):
        return value
    if isinstance(value, list):
        return tuple(value)
    return (value,)


def _is_audio(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get("waveform"), torch.Tensor) and value.get("sample_rate") is not None


def _walk_media(value: Any, out: dict[str, list[Any]], seen: set[int]) -> None:
    if value is None:
        return
    if not isinstance(value, (str, bytes, int, float, bool)):
        marker = id(value)
        if marker in seen:
            return
        seen.add(marker)
    if _is_audio(value):
        out["audios"].append(value)
        return
    if isinstance(value, dict):
        # A VIDEO-like dictionary may carry frames/fps/audio together.
        frames, audio, fps = _media_components(value)
        if frames is not None and (fps is not None or audio is not None):
            out["videos"].append((frames, audio, fps))
            return
        for item in value.values():
            _walk_media(item, out, seen)
        return
    if isinstance(value, (list, tuple, set)):
        for item in value:
            _walk_media(item, out, seen)
        return
    getter = getattr(value, "get_components", None)
    if callable(getter):
        frames, audio, fps = _media_components(value)
        if frames is not None:
            out["videos"].append((frames, audio, fps))
        elif audio is not None:
            out["audios"].append(audio)
        return
    if isinstance(value, torch.Tensor):
        frames, _audio, _fps = _media_components(value)
        if frames is not None:
            for index in range(int(frames.shape[0])):
                out["images"].append(frames[index : index + 1].contiguous())


def _collect_media(value: Any) -> dict[str, list[Any]]:
    result = {"images": [], "videos": [], "audios": []}
    _walk_media(value, result, set())
    return result


def _aligned_frames(duration: float, fps: float) -> int:
    value = max(5, round(float(duration) * float(fps)))
    while value % 17 != 5:
        value += 1
    return value


def _send_status(unique_id: Any, text: str, progress: float) -> None:
    if unique_id is None:
        return
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("gjj_node_progress", {"node": str(unique_id), "text": text, "progress": float(progress)})
    except Exception:
        pass


class GJJ_MiniMaxH3Studio:
    CATEGORY = "GJJ/💗 一键生成"
    FUNCTION = "generate"
    INPUT_IS_LIST = True
    OUTPUT_NODE = True
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("生成视频",)
    DESCRIPTION = "MiniMax H3 单节点工作室：无媒体自动 T2V；单图自动 I2V；多图、视频或音频递归解包后自动 Reference-to-Video。"
    SEARCH_ALIASES = ["MiniMax H3 Studio", "海螺单节点", "T2V I2V Ref2V"]
    GJJ_UI = {"style_reference": "GJJ_BerniniStudio", "model_keyword": "minimax_h3"}
    _MODEL_CACHE: dict[tuple[str, ...], tuple[Any, Any, Any, Any]] = {}

    @classmethod
    def INPUT_TYPES(cls):
        fl_models, fl_default = _choices("diffusion_models", DEFAULT_FL_MODEL, ("minimax_h3", "fl2va"))
        ref_models, ref_default = _choices("diffusion_models", DEFAULT_REF_MODEL, ("minimax_h3", "ref2va"))
        clips, clip_default = _choices("text_encoders", DEFAULT_CLIP, ("qwen3vl_32b", "minimax_h3"))
        video_vaes, video_vae_default = _choices("vae", DEFAULT_VIDEO_VAE, ("minimax_h3", "video_vae"))
        audio_vaes, audio_vae_default = _choices("vae", DEFAULT_AUDIO_VAE, ("minimax_h3", "audio_vae"))
        return {
            "required": {},
            "optional": {
                "reference_media": (MEDIA_TYPE, {"display_name": "参考媒体", "tooltip": "递归解包图片、VIDEO、音频、list/tuple/dict。未连接=T2V；单图=I2V；其它=参考生视频。"}),
                "prompt": ("STRING", {"default": "", "multiline": True, "display_name": "提示词"}),
                "width": ("INT", {"default": 864, "min": 352, "max": 1920, "step": 32, "display_name": "宽度"}),
                "height": ("INT", {"default": 480, "min": 352, "max": 1920, "step": 32, "display_name": "高度"}),
                "duration": ("FLOAT", {"default": 5.0, "min": 0.2, "max": 60.0, "step": 0.1, "display_name": "时长(秒)"}),
                "frame_rate": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 1.0, "display_name": "帧率"}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 100, "step": 1, "display_name": "步数"}),
                "seed": ("INT", {"default": 42, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "display_name": "种子"}),
                "randomize_seed": ("BOOLEAN", {"default": True, "display_name": "随机种子"}),
                "sampler_name": ("STRING", {"default": "res_multistep", "display_name": "采样器"}),
                "scheduler": ("STRING", {"default": "simple", "display_name": "调度器"}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "降噪"}),
                "ref_image_size": (["match", "max"], {"default": "match", "display_name": "参考图尺寸"}),
                "filename_prefix": ("STRING", {"default": "video/MiniMax_H3_Studio", "display_name": "文件名前缀"}),
                "format_name": ("STRING", {"default": "video/h264-mp4", "display_name": "输出格式"}),
                "fl_model": (fl_models, {"default": fl_default, "display_name": "T2V/I2V模型", "gjj_default_model": DEFAULT_FL_MODEL, "gjj_model_folder": "diffusion_models", "gjj_model_icon": "🟣"}),
                "ref_model": (ref_models, {"default": ref_default, "display_name": "参考模型", "gjj_default_model": DEFAULT_REF_MODEL, "gjj_model_folder": "diffusion_models", "gjj_model_icon": "🟣"}),
                "clip_name": (clips, {"default": clip_default, "display_name": "Qwen3-VL编码器", "gjj_default_model": DEFAULT_CLIP, "gjj_model_folder": "text_encoders", "gjj_model_icon": "🟡"}),
                "video_vae_name": (video_vaes, {"default": video_vae_default, "display_name": "视频VAE", "gjj_default_model": DEFAULT_VIDEO_VAE, "gjj_model_folder": "vae", "gjj_model_icon": "🔴"}),
                "audio_vae_name": (audio_vaes, {"default": audio_vae_default, "display_name": "音频VAE", "gjj_default_model": DEFAULT_AUDIO_VAE, "gjj_model_folder": "vae", "gjj_model_icon": "🔴"}),
                "keep_model": ("BOOLEAN", {"default": False, "display_name": "保持模型"}),
                "use_source_size": ("BOOLEAN", {"default": True, "display_name": "原图尺寸"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "prompt_info": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        if bool((kwargs.get("randomize_seed") or [True])[0] if isinstance(kwargs.get("randomize_seed"), list) else kwargs.get("randomize_seed", True)):
            return time.time_ns()
        digest = hashlib.sha256()
        for key in sorted(kwargs):
            digest.update(f"{key}={kwargs[key]}|".encode("utf-8", errors="replace"))
        return digest.hexdigest()

    def _load_models(self, model_name: str, clip_name: str, video_vae_name: str, audio_vae_name: str, keep: bool, unique_id: Any):
        key = (model_name, clip_name, video_vae_name, audio_vae_name)
        if keep and key in self._MODEL_CACHE:
            return self._MODEL_CACHE[key]
        model = _load_unet_model(model_name, "default", unique_id=unique_id)
        clip = _load_clip(clip_name, "minimax_h3", "default")
        video_vae = _load_vae(video_vae_name)
        audio_vae = _load_vae(audio_vae_name)
        value = (model, clip, video_vae, audio_vae)
        if keep:
            self._MODEL_CACHE[key] = value
        return value

    def generate(self, **kwargs):
        def first(name: str, default: Any = None):
            value = kwargs.get(name, default)
            return value[0] if isinstance(value, list) and value else value

        media = _collect_media(kwargs.get("reference_media"))
        image_count = len(media["images"])
        has_reference_av = bool(media["videos"] or media["audios"])
        mode = "T2V" if image_count == 0 and not has_reference_av else ("I2V" if image_count == 1 and not has_reference_av else "R2V")
        model_name = str(first("ref_model" if mode == "R2V" else "fl_model", DEFAULT_REF_MODEL if mode == "R2V" else DEFAULT_FL_MODEL))
        width, height = int(first("width", 864)), int(first("height", 480))
        if bool(first("use_source_size", True)):
            source = media["images"][0] if media["images"] else (media["videos"][0][0] if media["videos"] else None)
            if isinstance(source, torch.Tensor) and source.ndim >= 3:
                source_height, source_width = int(source.shape[-3]), int(source.shape[-2])
                width = max(352, min(1920, round(source_width / 32) * 32))
                height = max(352, min(1920, round(source_height / 32) * 32))
        fps = float(first("frame_rate", 24.0))
        length = _aligned_frames(float(first("duration", 5.0)), fps)
        seed = int(first("seed", 42))
        if bool(first("randomize_seed", True)):
            seed = int(torch.randint(0, 0x7FFFFFFF, (1,)).item())
        unique_id = first("unique_id")
        _send_status(unique_id, f"1/5 自动模式 {mode}：加载模型...", 0.05)
        model, clip, video_vae, audio_vae = self._load_models(
            model_name,
            str(first("clip_name", DEFAULT_CLIP)),
            str(first("video_vae_name", DEFAULT_VIDEO_VAE)),
            str(first("audio_vae_name", DEFAULT_AUDIO_VAE)),
            bool(first("keep_model", False)),
            unique_id,
        )
        prompt = str(first("prompt", "") or "")
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ImageToVideo, MiniMaxH3ReferenceToVideo
        if mode == "R2V":
            ref_images = {f"ref_image_{i}": value for i, value in enumerate(media["images"][:10])}
            ref_videos = {f"ref_video_{i}": value[0] for i, value in enumerate(media["videos"][:4])}
            ref_video_audios = {f"ref_video_audio_{i}": value[1] for i, value in enumerate(media["videos"][:4]) if value[1] is not None}
            ref_audios = {f"ref_audio_{i}": value for i, value in enumerate(media["audios"][:4])}
            positive, latent = _unwrap_node_output(MiniMaxH3ReferenceToVideo.execute(
                clip, video_vae, audio_vae, prompt, width, height, length,
                str(first("ref_image_size", "match")), ref_images, ref_videos, ref_video_audios, ref_audios,
            ))[:2]
        else:
            first_frame = media["images"][0] if mode == "I2V" else None
            positive, latent = _unwrap_node_output(MiniMaxH3ImageToVideo.execute(
                clip, video_vae, prompt, width, height, length, first_frame, None,
            ))[:2]
        _send_status(unique_id, "2/5 构建采样器...", 0.2)
        from comfy_extras.nodes_custom_sampler import BasicGuider, RandomNoise, SamplerCustomAdvanced
        guider = _node_output_first(BasicGuider.execute(model, positive))
        noise = _node_output_first(RandomNoise.execute(seed))
        sampler = _ksampler(str(first("sampler_name", "res_multistep")))
        sigmas = _basic_sigmas(model, str(first("scheduler", "simple")), int(first("steps", 20)), float(first("denoise", 1.0)))
        _send_status(unique_id, "3/5 MiniMax H3 视频与音频联合采样...", 0.3)
        sampled = _unwrap_node_output(SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, latent))[0]
        _send_status(unique_id, "4/5 解码视频与音频...", 0.85)
        import nodes
        from comfy_extras.nodes_audio import VAEDecodeAudio
        images = nodes.VAEDecode().decode(video_vae, sampled)[0]
        audio = _unwrap_node_output(VAEDecodeAudio.execute(audio_vae, sampled))[0]
        combined = GJJ_VideoCombine().combine(
            images=images,
            frame_rate=fps,
            loop_count=0,
            filename_prefix=str(first("filename_prefix", "video/MiniMax_H3_Studio")),
            format_name=str(first("format_name", "video/h264-mp4")),
            pingpong=False,
            save_output=True,
            use_source_fps=False,
            delete_tail_frame=False,
            save_metadata=True,
            trim_to_audio=False,
            pix_fmt="auto",
            crf="-1",
            vae=None,
            audio=audio,
            prompt=first("prompt_info"),
            extra_pnginfo=first("extra_pnginfo"),
            unique_id=unique_id,
        )
        video, output_path, _files = _video_combine_result(combined)
        _send_status(unique_id, f"5/5 {mode} 完成：{length} 帧", 1.0)
        return {"ui": {"mode": [mode], "frame_count": [length], "output_path": [str(output_path or "")]}, "result": (video,)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MiniMaxH3Studio}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧠MiniMax H3 多模态视频工作室"}
