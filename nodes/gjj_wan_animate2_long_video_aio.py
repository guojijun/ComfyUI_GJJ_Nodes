from __future__ import annotations

import gc
import logging
from typing import Any

import torch
import torch.nn.functional as F
import folder_paths

from .common_utils.progress import send_node_progress
from .gjj_multi_video_loader import GJJ_MultiVideoLoader
from .gjj_video_combine import GJJ_VideoCombine


NODE_NAME = "GJJ_WanAnimate2LongVideoAIO"
NODE_DISPLAY_NAME = "GJJ · 🎭 Wan Animate2 长视频动作迁移 AIO"
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


def _progress(unique_id: Any, text: str, value: float | None = None) -> None:
    message = f"[Wan Animate2 AIO] {text}"
    log.info(message)
    print(message, flush=True)
    send_node_progress(unique_id, text, value)


def _unwrap(value: Any) -> tuple[Any, dict[str, Any]]:
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


def _resize(images: torch.Tensor, width: int, height: int) -> torch.Tensor:
    if images.ndim == 3:
        images = images.unsqueeze(0)
    source_h, source_w = int(images.shape[1]), int(images.shape[2])
    scale = max(width / max(1, source_w), height / max(1, source_h))
    new_w, new_h = max(width, round(source_w * scale)), max(height, round(source_h * scale))
    resized = F.interpolate(images[..., :3].float().movedim(-1, 1), (new_h, new_w), mode="area").movedim(1, -1)
    left, top = (new_w - width) // 2, (new_h - height) // 2
    return resized[:, top:top + height, left:left + width].contiguous()


def _video_parts(video: Any) -> tuple[torch.Tensor, float, Any]:
    external = GJJ_MultiVideoLoader._coerce_external_video(video)
    if external is None or not isinstance(external.get("frames"), torch.Tensor):
        raise RuntimeError("动作视频没有解析出图像帧，请连接 Load Video 的 VIDEO 输出。")
    return external["frames"], float(external.get("fps") or 30.0), external.get("audio")


class GJJ_WanAnimate2LongVideoAIO:
    CATEGORY = "GJJ/🎬 视频/生成"
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
        return {
            "required": {
                "reference_image": ("IMAGE", {"display_name": "参考图"}),
                "action_video": ("VIDEO", {"display_name": "动作视频"}),
                "prompt": ("STRING", {"default": "Character follows the motion of the driving video.", "multiline": True, "display_name": "画面提示词"}),
                "negative_prompt": ("STRING", {"default": "色调艳丽，过曝，静态，细节模糊，字幕，水印，低质量，畸形，手指错误，脸部扭曲，动作僵硬", "multiline": True, "hidden": True, "display": "hidden", "display_name": "负面提示词"}),
                "pose_prompt": ("STRING", {"default": "A person performs the motion shown in the reference video.", "multiline": True, "hidden": True, "display": "hidden", "display_name": "动作提示词"}),
                "width": ("INT", {"default": 832, "min": 256, "max": 2048, "step": 16, "hidden": True, "display": "hidden", "display_name": "宽度"}),
                "height": ("INT", {"default": 480, "min": 256, "max": 2048, "step": 16, "hidden": True, "display": "hidden", "display_name": "高度"}),
                "segment_frames": ("INT", {"default": 81, "min": 9, "max": 241, "step": 4, "hidden": True, "display": "hidden", "display_name": "每段帧数"}),
                "overlap_frames": ("INT", {"default": 1, "min": 0, "max": 32, "step": 1, "hidden": True, "display": "hidden", "display_name": "续接重叠帧"}),
                "steps": ("INT", {"default": 6, "min": 1, "max": 100, "hidden": True, "display": "hidden", "display_name": "步数"}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "hidden": True, "display": "hidden", "display_name": "CFG"}),
                "seed": ("INT", {"default": 1, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True, "hidden": True, "display": "hidden", "display_name": "种子"}),
                "pose_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05, "hidden": True, "display": "hidden", "display_name": "动作强度"}),
                "reference_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05, "hidden": True, "display": "hidden", "display_name": "参考图强度"}),
                "unet_name": (unets, {"default": _preferred(unets, ("animate", "2")), "hidden": True, "display": "hidden", "display_name": "Animate2 模型"}),
                "lora_name": (loras, {"default": _preferred(loras, ("lightx2v",)), "hidden": True, "display": "hidden", "display_name": "加速 LoRA"}),
                "clip_name": (clips, {"default": _preferred(clips, ("umt5",)), "hidden": True, "display": "hidden", "display_name": "文本编码器"}),
                "clip_vision_name": (visions, {"default": _preferred(visions, ("clip_vision_h",)), "hidden": True, "display": "hidden", "display_name": "CLIP Vision"}),
                "vae_name": (vaes, {"default": _preferred(vaes, ("wan",)), "hidden": True, "display": "hidden", "display_name": "VAE"}),
                "filename_prefix": ("STRING", {"default": "video/WanAnimate2_AIO", "hidden": True, "display": "hidden", "display_name": "文件名前缀"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "prompt_info": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def generate(self, reference_image, action_video, prompt, negative_prompt, pose_prompt, width, height,
                 segment_frames, overlap_frames, steps, cfg, seed, pose_strength, reference_strength,
                 unet_name, lora_name, clip_name, clip_vision_name, vae_name, filename_prefix,
                 unique_id=None, prompt_info=None, extra_pnginfo=None):
        frames, fps, audio = _video_parts(action_video)
        width, height = int(width) // 16 * 16, int(height) // 16 * 16
        segment_frames = max(9, int(segment_frames))
        overlap_frames = min(max(0, int(overlap_frames)), segment_frames - 1)
        stride = max(1, segment_frames - overlap_frames)
        _progress(unique_id, f"读取动作视频：{len(frames)} 帧，{fps:.3g} fps", 0.02)

        if not _is_comfy_wan_clip_name(clip_name):
            compatible_clips = _wan_clip_names()
            if compatible_clips == ["未找到兼容的 Wan 文本编码器"]:
                raise RuntimeError(
                    f"文本编码器 {clip_name} 是 WanVideoWrapper 的 WANTEXTENCODER 权重，不能用于 ComfyUI CLIPTextEncode。"
                    "请在 models/text_encoders 中安装 umt5_xxl_int4_convrot.safetensors、"
                    "umt5_xxl_fp8_e4m3fn_scaled.safetensors 或 umt5_xxl_fp16.safetensors。"
                )
            replacement = _preferred(compatible_clips, ("umt5", "xxl"))
            _progress(unique_id, f"所选 T5 不兼容 CLIP 编码，已自动改用：{replacement}", 0.03)
            clip_name = replacement

        model = _call("UNETLoader", unet_name=unet_name, weight_dtype="default")[0]
        if lora_name and lora_name != "未找到模型":
            model = _call("LoraLoaderModelOnly", model=model, lora_name=lora_name, strength_model=1.0)[0]
        clip = _call("CLIPLoader", clip_name=clip_name, type="wan", device="default")[0]
        vae = _call("VAELoader", vae_name=vae_name)[0]
        clip_vision = _call("CLIPVisionLoader", clip_name=clip_vision_name)[0]
        positive = _call("CLIPTextEncode", clip=clip, text=prompt)[0]
        negative = _call("CLIPTextEncode", clip=clip, text=negative_prompt)[0]
        positive_pose = _call("CLIPTextEncode", clip=clip, text=pose_prompt)[0]
        ref = _resize(reference_image[:1], width, height)
        ref_cv = _call("CLIPVisionEncode", clip_vision=clip_vision, image=ref, crop="none")[0]
        model = _call("WanAnimate2Cache", model=model, device="gpu", dtype="int8")[0]
        model = _call("ModelSamplingSD3", model=model, shift=5.0)[0]
        sampler = _call("KSamplerSelect", sampler_name="lcm")[0]
        generated: list[torch.Tensor] = []
        continuation = None
        offsets = range(0, len(frames), stride)
        total = max(1, (len(frames) + stride - 1) // stride)
        for index, start in enumerate(offsets):
            pose = _resize(frames[start:start + segment_frames], width, height)
            if len(pose) == 0:
                break
            pose_cv = _call("CLIPVisionEncode", clip_vision=clip_vision, image=pose[:1], crop="none")[0]
            encoded = _call("WanAnimate2ToVideo", positive=positive, negative=negative, vae=vae,
                            reference_image=ref, pose_video=pose, clip_vision_output=ref_cv,
                            positive_pose=positive_pose, clip_vision_output_pose=pose_cv,
                            continue_motion=continuation, width=width, height=height, length=len(pose),
                            batch_size=1, video_frame_offset=start, pose_strength=float(pose_strength),
                            pose_start_percent=0.0, pose_end_percent=1.0,
                            reference_image_strength=float(reference_strength))
            pos, neg, latent, trim_latent = encoded[:4]
            sigmas = _call("BasicScheduler", model=model, scheduler="simple", steps=int(steps), denoise=1.0)[0]
            sampled = _call("SamplerCustom", model=model, add_noise=True, noise_seed=int(seed) + index,
                            cfg=float(cfg), positive=pos, negative=neg, sampler=sampler, sigmas=sigmas,
                            latent_image=latent)[0]
            if int(trim_latent or 0) > 0:
                sampled = _call("TrimVideoLatent", samples=sampled, trim_amount=int(trim_latent))[0]
            decoded = _call("VAEDecode", samples=sampled, vae=vae)[0]
            drop = overlap_frames if generated else 0
            if drop and len(decoded) > drop:
                decoded = decoded[drop:]
            generated.append(decoded.cpu())
            continuation = decoded[-max(1, overlap_frames):].to(frames.device)
            _progress(unique_id, f"完成第 {index + 1}/{total} 段", 0.08 + 0.82 * (index + 1) / total)
            if start + segment_frames >= len(frames):
                break
        if not generated:
            raise RuntimeError("动作视频为空，无法生成。")
        output_frames = torch.cat(generated, dim=0)[:len(frames)].contiguous()
        _progress(unique_id, "正在合并视频并封装原音频…", 0.94)
        combined = GJJ_VideoCombine().combine(images=output_frames, frame_rate=fps, loop_count=0,
            filename_prefix=filename_prefix, format_name="video/h264-mp4", pingpong=False,
            save_output=True, use_source_fps=True, delete_tail_frame=False, save_metadata=True,
            trim_to_audio=False, pix_fmt="auto", crf="-1", prompt=prompt_info,
            extra_pnginfo=extra_pnginfo, unique_id=unique_id, audio=audio)
        result, _ui = _unwrap(combined)
        video = result[0] if isinstance(result, (list, tuple)) else result
        gc.collect()
        _progress(unique_id, f"完成：{len(output_frames)} 帧", 1.0)
        return (video, output_frames)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanAnimate2LongVideoAIO}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
