from __future__ import annotations

import gc
import json
import logging
from typing import Any

import torch
import torch.nn.functional as F
import folder_paths
import comfy.samplers
import comfy.model_management

from .common_utils.progress import send_node_progress
from .gjj_multi_video_loader import (
    GJJ_MultiVideoLoader,
    decode_audio_ffmpeg,
    parse_selected_videos,
    resolve_input_video_path,
)
from .gjj_multi_image_loader import GJJ_MultiImageLoader
from .gjj_video_combine import GJJ_VideoCombine


NODE_NAME = "GJJ_WanAnimate2LongVideoAIO"
NODE_DISPLAY_NAME = "GJJ·🎭一键长视频动作迁移（Wan Animate2）"
log = logging.getLogger(__name__)


def _names(category: str) -> list[str]:
    try:
        values = list(folder_paths.get_filename_list(category))
    except Exception:
        values = []
    return values or ["未找到模型"]


def _preferred(values: list[str], needles: tuple[str, ...]) -> str:
    for value in values:
        low = value.lower().replace("-", "_")
        if all(token in low for token in needles):
            return value
    return values[0]


def _is_comfy_wan_clip_name(name: Any) -> bool:
    """Reject WanVideoWrapper UMT5 encoder weights masquerading as CLIP files."""
    filename = str(name or "").replace("\\", "/").rsplit("/", 1)[-1].lower()
    normalized = filename.replace("-", "_").replace(".", "_")
    return not (filename.endswith(".safetensors") and "umt5_xxl_enc_" in normalized)


def _wan_clip_names() -> list[str]:
    values = [name for name in _names("text_encoders") if _is_comfy_wan_clip_name(name)]
    preferred = (
        "umt5_xxl_int4_convrot.safetensors",
        "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        "umt5_xxl_fp16.safetensors",
    )
    values.sort(key=lambda name: (
        preferred.index(str(name).replace("\\", "/").rsplit("/", 1)[-1].lower())
        if str(name).replace("\\", "/").rsplit("/", 1)[-1].lower() in preferred else len(preferred),
        str(name).lower(),
    ))
    return values or ["未找到兼容的 Wan 文本编码器"]


def _progress(unique_id: Any, text: str, value: float | None = None, **extra: Any) -> None:
    message = f"[Wan Animate2 AIO] {text}"
    log.info(message)
    print(message, flush=True)
    send_node_progress(unique_id, text, value, **extra)


def _latest_preview(ui: Any) -> dict[str, Any] | None:
    if not isinstance(ui, dict):
        return None
    for key in ("preview_media", "preview_images", "images"):
        items = ui.get(key)
        if isinstance(items, list):
            for item in reversed(items):
                if isinstance(item, dict) and str(item.get("filename") or "").strip():
                    return dict(item)
    return None


def _unwrap(value: Any) -> tuple[Any, dict[str, Any]]:
    if value is not None and value.__class__.__name__ == "NodeOutput":
        result = getattr(value, "args", None)
        if result is None:
            result = getattr(value, "result", None)
        ui = getattr(value, "ui", None)
        return result, dict(ui) if isinstance(ui, dict) else {}
    if isinstance(value, dict) and "result" in value:
        return value.get("result"), dict(value.get("ui") or {})
    return value, {}


def _call(name: str, **kwargs: Any) -> tuple[Any, ...]:
    import nodes as comfy_nodes

    cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(name)
    if cls is None:
        raise RuntimeError(f"缺少 ComfyUI 节点 {name}。请升级到包含 Wan Animate 2 的 ComfyUI 版本。")
    obj = cls()
    fn = getattr(obj, str(getattr(cls, "FUNCTION", "")), None)
    if not callable(fn):
        raise RuntimeError(f"节点 {name} 没有可调用的执行函数。")
    allowed: set[str] = set()
    try:
        schema = cls.INPUT_TYPES()
        for section in ("required", "optional", "hidden"):
            allowed.update((schema.get(section) or {}).keys())
    except Exception:
        allowed = set(kwargs)
    result, _ui = _unwrap(fn(**{key: val for key, val in kwargs.items() if key in allowed}))
    return tuple(result) if isinstance(result, (list, tuple)) else (result,)


def _resize(images: torch.Tensor, width: int, height: int, fit_mode: str = "裁剪", anchor: str = "中") -> torch.Tensor:
    if images.ndim == 3:
        images = images.unsqueeze(0)
    source_h, source_w = int(images.shape[1]), int(images.shape[2])
    tensor = images[..., :3].float().movedim(-1, 1)
    if fit_mode == "拉伸":
        return F.interpolate(tensor, (height, width), mode="area").movedim(1, -1).contiguous()
    contain = fit_mode in {"补边", "留边"}
    scale = (min if contain else max)(width / max(1, source_w), height / max(1, source_h))
    new_w, new_h = max(width, round(source_w * scale)), max(height, round(source_h * scale))
    if contain:
        new_w, new_h = min(width, round(source_w * scale)), min(height, round(source_h * scale))
    resized = F.interpolate(tensor, (new_h, new_w), mode="area")
    horizontal = {"左": 0, "右": 1}.get(anchor, 0.5)
    vertical = {"上": 0, "下": 1}.get(anchor, 0.5)
    if not contain:
        left = round((new_w - width) * horizontal)
        top = round((new_h - height) * vertical)
        return resized[:, :, top:top + height, left:left + width].movedim(1, -1).contiguous()
    pad_w, pad_h = width - new_w, height - new_h
    left, top = round(pad_w * horizontal), round(pad_h * vertical)
    pad = (left, pad_w - left, top, pad_h - top)
    padded = F.pad(resized, pad, mode="replicate") if fit_mode == "补边" else F.pad(resized, pad, mode="constant", value=0.0)
    return padded.movedim(1, -1).contiguous()


def _video_parts(video: Any) -> tuple[torch.Tensor, float, Any]:
    external = GJJ_MultiVideoLoader._coerce_external_video(video)
    if external is None or not isinstance(external.get("frames"), torch.Tensor):
        raise RuntimeError("动作视频没有解析出图像帧，请连接 Load Video 的 VIDEO 输出。")
    return external["frames"], float(external.get("fps") or 30.0), external.get("audio")


class GJJ_WanAnimate2LongVideoAIO:
    CATEGORY = "GJJ/💗 一键生成"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    RETURN_TYPES = ("VIDEO", "IMAGE")
    RETURN_NAMES = ("参考动作视频", "生成帧")
    OUTPUT_TOOLTIPS = ("自动分段生成并合并后的官方 VIDEO。", "合并后的完整图像帧序列。")
    DESCRIPTION = "输入一张人物参考图和一段动作视频，内部按窗口执行 Wan Animate 2 动作迁移，自动续接、去重并合并输出。"
    SEARCH_ALIASES = ["Wan Animate2 AIO", "动作迁移", "动作模仿", "长视频动作迁移"]

    @classmethod
    def INPUT_TYPES(cls):
        unets = _names("diffusion_models")
        loras = _names("loras")
        clips = _wan_clip_names()
        visions = _names("clip_vision")
        vaes = _names("vae")
        samplers = list(comfy.samplers.KSampler.SAMPLERS) or ["lcm"]
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS) or ["simple"]
        sampler_default = "lcm" if "lcm" in samplers else samplers[0]
        scheduler_default = "simple" if "simple" in schedulers else schedulers[0]
        unet_keywords = ("wan_animate_2",)
        lora_keywords = ("lightx2v_i2v",)
        clip_keywords = ("umt5_xxl_",)
        vision_keywords = ("clip_vision_h",)
        vae_keywords = ("wan_2.1",)
        unet_default = _preferred(unets, unet_keywords)
        lora_default = _preferred(loras, lora_keywords)
        clip_default = _preferred(clips, clip_keywords)
        vision_default = _preferred(visions, vision_keywords)
        vae_default = _preferred(vaes, vae_keywords)
        return {
            "required": {
                "prompt": ("STRING", {"default": "Character follows the motion of the driving video.", "multiline": True, "display_name": "画面提示词"}),
                "negative_prompt": ("STRING", {"default": "色调艳丽，过曝，静态，细节模糊，字幕，水印，低质量，畸形，手指错误，脸部扭曲，动作僵硬", "multiline": True, "hidden": True, "display": "hidden", "display_name": "负面提示词"}),
                "pose_prompt": ("STRING", {"default": "A person performs the motion shown in the reference video.", "multiline": True, "hidden": True, "display": "hidden", "display_name": "动作提示词"}),
                "width": ("INT", {"default": 832, "min": 256, "max": 2048, "step": 16, "hidden": True, "display": "hidden", "display_name": "宽度"}),
                "height": ("INT", {"default": 480, "min": 256, "max": 2048, "step": 16, "hidden": True, "display": "hidden", "display_name": "高度"}),
                "segment_frames": ("INT", {"default": 81, "min": 5, "max": 241, "step": 4, "hidden": True, "display": "hidden", "display_name": "每段帧数"}),
                "overlap_frames": ("INT", {"default": 1, "min": 0, "max": 32, "step": 1, "hidden": True, "display": "hidden", "display_name": "续接重叠帧"}),
                "steps": ("INT", {"default": 6, "min": 1, "max": 100, "hidden": True, "display": "hidden", "display_name": "步数"}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "hidden": True, "display": "hidden", "display_name": "CFG"}),
                "seed": ("INT", {"default": 1, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True, "hidden": True, "display": "hidden", "display_name": "种子"}),
                "pose_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05, "hidden": True, "display": "hidden", "display_name": "动作强度"}),
                "reference_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05, "hidden": True, "display": "hidden", "display_name": "参考图强度"}),
                "unet_name": (unets, {"default": unet_default, "hidden": True, "display": "hidden", "display_name": "Animate2 模型", "gjj_model_folder": "diffusion_models", "gjj_default_model": unet_default, "gjj_model_keywords": unet_keywords, "gjj_model_icon": "🟣"}),
                "lora_name": (loras, {"default": lora_default, "hidden": True, "display": "hidden", "display_name": "加速 LoRA", "gjj_model_folder": "loras", "gjj_default_model": lora_default, "gjj_model_keywords": lora_keywords, "gjj_model_icon": "🟠"}),
                "clip_name": (clips, {"default": clip_default, "hidden": True, "display": "hidden", "display_name": "文本编码器", "gjj_model_folder": "text_encoders", "gjj_default_model": clip_default, "gjj_model_keywords": clip_keywords, "gjj_model_icon": "🟡"}),
                "clip_vision_name": (visions, {"default": vision_default, "hidden": True, "display": "hidden", "display_name": "CLIP Vision", "gjj_model_folder": "clip_vision", "gjj_default_model": vision_default, "gjj_model_keywords": vision_keywords, "gjj_model_icon": "🔵"}),
                "vae_name": (vaes, {"default": vae_default, "hidden": True, "display": "hidden", "display_name": "VAE", "gjj_model_folder": "vae", "gjj_default_model": vae_default, "gjj_model_keywords": vae_keywords, "gjj_model_icon": "🔴"}),
                "filename_prefix": ("STRING", {"default": "video/WanAnimate2_AIO", "hidden": True, "display": "hidden", "display_name": "文件名前缀"}),
                "size_source": (["画板尺寸", "首图尺寸", "视频尺寸", "百万像素"], {"default": "画板尺寸", "hidden": True, "display": "hidden", "display_name": "尺寸来源"}),
                "resize_fit_mode": (["拉伸", "补边", "留边", "裁剪"], {"default": "裁剪", "hidden": True, "display": "hidden", "display_name": "缩放方式"}),
                "resize_anchor": (["上", "下", "左", "右", "中"], {"default": "中", "hidden": True, "display": "hidden", "display_name": "保留位置"}),
                "megapixel_aspect": (["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"], {"default": "16:9", "hidden": True, "display": "hidden", "display_name": "百万像素比例"}),
                "megapixels": ("FLOAT", {"default": 0.4, "min": 0.2, "max": 2.0, "step": 0.1, "hidden": True, "display": "hidden", "display_name": "百万像素"}),
                "sampler_name": (samplers, {"default": sampler_default, "hidden": True, "display": "hidden", "display_name": "采样器"}),
                "scheduler_name": (schedulers, {"default": scheduler_default, "hidden": True, "display": "hidden", "display_name": "调度器"}),
                "selected_video_json": ("STRING", {"default": "[]", "hidden": True, "display": "hidden", "display_name": "面板动作视频"}),
                "selected_reference_json": ("STRING", {"default": "[]", "hidden": True, "display": "hidden", "display_name": "面板参考图"}),
                "megapixel_ratio_source": (["预设", "视频", "首图"], {"default": "预设", "hidden": True, "display": "hidden", "display_name": "百万像素比例来源"}),
                "preclean_resources": ("BOOLEAN", {"default": True, "hidden": True, "display": "hidden", "display_name": "预清理资源"}),
                "cache_clip": ("BOOLEAN", {"default": True, "hidden": True, "display": "hidden", "display_name": "缓存CLIP"}),
                "tiled_decode": ("BOOLEAN", {"default": True, "hidden": True, "display": "hidden", "display_name": "分块解码"}),
                "lora_data": ("STRING", {"default": "[]", "hidden": True, "display": "hidden", "display_name": "附加 LoRA 配置"}),
            },
            "optional": {
                "reference_image": ("IMAGE", {"display_name": "参考图"}),
                "action_video": ("VIDEO", {"display_name": "动作视频"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "prompt_info": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def generate(self, **kwargs):
        reference_image = kwargs.get("reference_image")
        action_video = kwargs.get("action_video")
        prompt = str(kwargs.get("prompt") or "")
        negative_prompt = str(kwargs.get("negative_prompt") or "")
        pose_prompt = str(kwargs.get("pose_prompt") or "")
        width = kwargs.get("width", 832)
        height = kwargs.get("height", 480)
        segment_frames = kwargs.get("segment_frames", 81)
        overlap_frames = kwargs.get("overlap_frames", 1)
        steps = kwargs.get("steps", 6)
        cfg = kwargs.get("cfg", 1.0)
        seed = kwargs.get("seed", 1)
        pose_strength = kwargs.get("pose_strength", 1.0)
        reference_strength = kwargs.get("reference_strength", 1.0)
        unet_name = str(kwargs.get("unet_name") or "")
        lora_name = str(kwargs.get("lora_name") or "")
        clip_name = str(kwargs.get("clip_name") or "")
        clip_vision_name = str(kwargs.get("clip_vision_name") or "")
        vae_name = str(kwargs.get("vae_name") or "")
        filename_prefix = str(kwargs.get("filename_prefix") or "video/WanAnimate2_AIO")
        size_source = str(kwargs.get("size_source") or "画板尺寸")
        resize_fit_mode = str(kwargs.get("resize_fit_mode") or "裁剪")
        resize_anchor = str(kwargs.get("resize_anchor") or "中")
        megapixel_aspect = str(kwargs.get("megapixel_aspect") or "16:9")
        megapixels = kwargs.get("megapixels", 0.4)
        sampler_name = str(kwargs.get("sampler_name") or "lcm")
        scheduler_name = str(kwargs.get("scheduler_name") or "simple")
        megapixel_ratio_source = str(kwargs.get("megapixel_ratio_source") or "预设")
        preclean_resources = bool(kwargs.get("preclean_resources", True))
        cache_clip = bool(kwargs.get("cache_clip", True))
        tiled_decode = bool(kwargs.get("tiled_decode", True))
        try:
            lora_rows = json.loads(str(kwargs.get("lora_data") or "[]"))
            if not isinstance(lora_rows, list):
                lora_rows = []
        except (TypeError, ValueError, json.JSONDecodeError):
            lora_rows = []
        unique_id = kwargs.get("unique_id")
        prompt_info = kwargs.get("prompt_info")
        extra_pnginfo = kwargs.get("extra_pnginfo")
        if not isinstance(reference_image, torch.Tensor):
            loaded = GJJ_MultiImageLoader().load_images(
                selected_images=str(kwargs.get("selected_reference_json") or "[]"),
                sequence_range="", input_images=None, prompt=prompt_info,
                extra_pnginfo=extra_pnginfo, unique_id=unique_id,
            )
            loaded_result, _loaded_ui = _unwrap(loaded)
            reference_image = loaded_result[0] if isinstance(loaded_result, (list, tuple)) and loaded_result else None
            if isinstance(reference_image, (list, tuple)):
                reference_image = next((item for item in reference_image if isinstance(item, torch.Tensor)), None)
        if not isinstance(reference_image, torch.Tensor):
            raise RuntimeError("请连接人物参考图，或点击 👤 选择一张参考图。")
        if action_video is None:
            loaded = GJJ_MultiVideoLoader().load_videos(
                frame_rate=30.0, width=0, height=0, video_format="auto",
                start_frame=0, end_frame=0, frame_stride=1, max_frames=100000,
                selected_videos_json=str(kwargs.get("selected_video_json") or "[]"),
                input_frames=None, prompt=prompt_info, extra_pnginfo=extra_pnginfo, unique_id=unique_id,
            )
            loaded_result, loaded_ui = _unwrap(loaded)
            loaded_frames = loaded_result[0] if isinstance(loaded_result, (list, tuple)) and loaded_result else None
            if isinstance(loaded_frames, torch.Tensor):
                fps_values = loaded_ui.get("frame_rate") or loaded_ui.get("source_fps") or [30.0]
                loaded_fps = float(fps_values[0] if isinstance(fps_values, (list, tuple)) else fps_values)
                loaded_audio = None
                selected_entries = parse_selected_videos(kwargs.get("selected_video_json"))
                if selected_entries:
                    try:
                        loaded_audio = decode_audio_ffmpeg(
                            resolve_input_video_path(selected_entries[0]),
                            0.0,
                            float(len(loaded_frames)) / max(1e-6, loaded_fps),
                        )
                    except Exception as exc:
                        log.warning("读取面板动作视频音频失败，继续生成无音频视频：%s", exc)
                action_video = {"frames": loaded_frames, "fps": loaded_fps, "audio": loaded_audio}
        frames, fps, audio = _video_parts(action_video)
        if size_source == "首图尺寸":
            height, width = int(reference_image.shape[1]), int(reference_image.shape[2])
        elif size_source == "视频尺寸":
            height, width = int(frames.shape[1]), int(frames.shape[2])
        elif size_source == "百万像素":
            if megapixel_ratio_source == "视频":
                ratio_w, ratio_h = int(frames.shape[2]), int(frames.shape[1])
            elif megapixel_ratio_source == "首图":
                ratio_w, ratio_h = int(reference_image.shape[2]), int(reference_image.shape[1])
            else:
                try:
                    ratio_w, ratio_h = (max(1.0, float(part)) for part in str(megapixel_aspect).split(":", 1))
                except Exception:
                    ratio_w, ratio_h = 16.0, 9.0
            pixels = max(0.2, min(2.0, float(megapixels))) * 1024 * 1024
            width = round((pixels * ratio_w / ratio_h) ** 0.5)
            height = round((pixels * ratio_h / ratio_w) ** 0.5)
        width = max(256, min(2048, round(int(width) / 16) * 16))
        height = max(256, min(2048, round(int(height) / 16) * 16))
        segment_frames = max(5, min(241, 5 + ((int(segment_frames) - 5 + 2) // 4) * 4))
        overlap_frames = min(max(0, int(overlap_frames)), segment_frames - 1)
        stride = max(1, segment_frames - overlap_frames)
        _progress(unique_id, f"1/7 输入准备完成：{len(frames)} 帧，{fps:.3g} fps", 0.02)

        if not _is_comfy_wan_clip_name(clip_name):
            compatible_clips = _wan_clip_names()
            if compatible_clips == ["未找到兼容的 Wan 文本编码器"]:
                raise RuntimeError(
                    f"文本编码器 {clip_name} 是 WanVideoWrapper 的 WANTEXTENCODER 权重，不能用于 ComfyUI CLIPTextEncode。"
                    "请在 models/text_encoders 中安装 umt5_xxl_int4_convrot.safetensors、"
                    "umt5_xxl_fp8_e4m3fn_scaled.safetensors 或 umt5_xxl_fp16.safetensors。"
                )
            replacement = _preferred(compatible_clips, ("umt5", "xxl"))
            _progress(unique_id, f"2/7 所选 T5 不兼容，已自动改用：{replacement}", 0.03)
            clip_name = replacement

        if preclean_resources:
            _progress(unique_id, "2/7 正在预清理内存和显存…", 0.03)
            gc.collect()
            comfy.model_management.soft_empty_cache()
        _progress(unique_id, "2/7 正在加载模型…", 0.035)
        model = _call("UNETLoader", unet_name=unet_name, weight_dtype="default")[0]
        if lora_name and lora_name != "未找到模型":
            model = _call("LoraLoaderModelOnly", model=model, lora_name=lora_name, strength_model=1.0)[0]
        for row in lora_rows:
            if not isinstance(row, dict) or row.get("enabled") is False:
                continue
            extra_lora_name = str(row.get("name") or "").strip()
            if not extra_lora_name or extra_lora_name == "未找到模型":
                continue
            try:
                extra_lora_strength = float(row.get("strength", 1.0))
            except (TypeError, ValueError):
                extra_lora_strength = 1.0
            model = _call(
                "LoraLoaderModelOnly",
                model=model,
                lora_name=extra_lora_name,
                strength_model=extra_lora_strength,
            )[0]
        clip = _call("CLIPLoader", clip_name=clip_name, type="wan", device="default")[0]
        vae = _call("VAELoader", vae_name=vae_name)[0]
        clip_vision = _call("CLIPVisionLoader", clip_name=clip_vision_name)[0]
        _progress(unique_id, "3/7 正在编码提示词和参考图…", 0.05)
        ref = _resize(reference_image[:1], width, height, resize_fit_mode, resize_anchor)
        positive = negative = positive_pose = ref_cv = None
        if cache_clip:
            positive = _call("CLIPTextEncode", clip=clip, text=prompt)[0]
            negative = _call("CLIPTextEncode", clip=clip, text=negative_prompt)[0]
            positive_pose = _call("CLIPTextEncode", clip=clip, text=pose_prompt)[0]
            ref_cv = _call("CLIPVisionEncode", clip_vision=clip_vision, image=ref, crop="none")[0]
        model = _call("WanAnimate2Cache", model=model, device="gpu", dtype="int8")[0]
        model = _call("ModelSamplingSD3", model=model, shift=5.0)[0]
        sampler = _call("KSamplerSelect", sampler_name=sampler_name)[0]
        generated: list[torch.Tensor] = []
        continuation = None
        offsets = range(0, len(frames), stride)
        total = max(1, (len(frames) + stride - 1) // stride)
        _progress(unique_id, f"4/7 条件准备完成，共 {total} 个分段", 0.08)
        for index, start in enumerate(offsets):
            _progress(unique_id, f"5/7 正在生成第 {index + 1}/{total} 段…", 0.08 + 0.82 * index / total)
            if not cache_clip:
                positive = _call("CLIPTextEncode", clip=clip, text=prompt)[0]
                negative = _call("CLIPTextEncode", clip=clip, text=negative_prompt)[0]
                positive_pose = _call("CLIPTextEncode", clip=clip, text=pose_prompt)[0]
                ref_cv = _call("CLIPVisionEncode", clip_vision=clip_vision, image=ref, crop="none")[0]
            pose = _resize(frames[start:start + segment_frames], width, height, resize_fit_mode, resize_anchor)
            if len(pose) == 0:
                break
            pose_cv = _call("CLIPVisionEncode", clip_vision=clip_vision, image=pose[:1], crop="none")[0]
            encoded = _call("WanAnimate2ToVideo", positive=positive, negative=negative, vae=vae,
                            reference_image=ref, pose_video=pose, clip_vision_output=ref_cv,
                            positive_pose=positive_pose, clip_vision_output_pose=pose_cv,
                            continue_motion=continuation, width=width, height=height, length=len(pose),
                            # pose_video is already the sliced current segment.  The official
                            # node applies video_frame_offset to the tensor it receives, so a
                            # global offset would slice this segment a second time.
                            batch_size=1, video_frame_offset=0, pose_strength=float(pose_strength),
                            pose_start_percent=0.0, pose_end_percent=1.0,
                            reference_image_strength=float(reference_strength))
            pos, neg, latent, trim_latent = encoded[:4]
            sigmas = _call("BasicScheduler", model=model, scheduler=scheduler_name, steps=int(steps), denoise=1.0)[0]
            sampled = _call("SamplerCustom", model=model, add_noise=True, noise_seed=int(seed) + index,
                            cfg=float(cfg), positive=pos, negative=neg, sampler=sampler, sigmas=sigmas,
                            latent_image=latent)[0]
            if int(trim_latent or 0) > 0:
                sampled = _call("TrimVideoLatent", samples=sampled, trim_amount=int(trim_latent))[0]
            if tiled_decode:
                try:
                    decoded = _call("VAEDecodeTiled", samples=sampled, vae=vae, tile_size=512, overlap=64, temporal_size=64, temporal_overlap=8)[0]
                except Exception as exc:
                    log.warning("分块解码不可用，自动改用普通 VAE 解码：%s", exc)
                    decoded = _call("VAEDecode", samples=sampled, vae=vae)[0]
            else:
                decoded = _call("VAEDecode", samples=sampled, vae=vae)[0]
            drop = overlap_frames if generated else 0
            if drop and len(decoded) > drop:
                decoded = decoded[drop:]
            decoded_cpu = decoded.cpu()
            generated.append(decoded_cpu)
            continuation = decoded[-max(1, overlap_frames):].to(frames.device)
            segment_ui: dict[str, Any] = {}
            try:
                segment_preview = GJJ_VideoCombine().combine(
                    images=decoded_cpu, frame_rate=fps, loop_count=0,
                    filename_prefix=f"GJJ/wan_animate2_aio_segments/segment_{index + 1:03d}",
                    format_name="video/h264-mp4", pingpong=False, save_output=False,
                    use_source_fps=True, delete_tail_frame=False, save_metadata=False,
                    trim_to_audio=False, pix_fmt="auto", crf="-1", prompt=prompt_info,
                    extra_pnginfo=extra_pnginfo, unique_id=unique_id, audio=None,
                )
                _segment_result, segment_ui = _unwrap(segment_preview)
            except Exception as exc:
                log.warning("第 %s 段临时预览生成失败，继续正式生成：%s", index + 1, exc)
            _progress(
                unique_id,
                f"6/7 第 {index + 1}/{total} 段完成，预览已更新",
                0.08 + 0.82 * (index + 1) / total,
                preview=_latest_preview(segment_ui),
                segment=index + 1,
                segment_total=total,
            )
            if start + segment_frames >= len(frames):
                break
        if not generated:
            raise RuntimeError("动作视频为空，无法生成。")
        output_frames = torch.cat(generated, dim=0)[:len(frames)].contiguous()
        _progress(unique_id, "7/7 正在合并视频并封装原音频…", 0.94)
        combined = GJJ_VideoCombine().combine(images=output_frames, frame_rate=fps, loop_count=0,
            filename_prefix=filename_prefix, format_name="video/h264-mp4", pingpong=False,
            save_output=True, use_source_fps=True, delete_tail_frame=False, save_metadata=True,
            trim_to_audio=False, pix_fmt="auto", crf="-1", prompt=prompt_info,
            extra_pnginfo=extra_pnginfo, unique_id=unique_id, audio=audio)
        result, combine_ui = _unwrap(combined)
        video = result[0] if isinstance(result, (list, tuple)) else result
        gc.collect()
        _progress(unique_id, f"完成：{len(output_frames)} 帧", 1.0)
        return {"ui": combine_ui, "result": (video, output_frames)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanAnimate2LongVideoAIO}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
