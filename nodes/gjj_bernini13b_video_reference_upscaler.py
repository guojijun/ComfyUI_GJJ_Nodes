from __future__ import annotations

from pathlib import Path
import math
from typing import Any

import torch
import torch.nn.functional as F
import comfy.samplers
import folder_paths
from nodes import common_ksampler

from .gjj_bernini import GJJBerniniConditioning, _encode_context_latent
from .gjj_bernini13b_long_video_watermark_remover import (
    OUTPUT_TYPE,
    REFERENCE_RESOURCE_TYPE,
    _boolean,
    _first,
    _hidden,
    _integer,
    _number,
    _reference_resources,
    _selected_video_components,
)
from .gjj_bernini_studio import (
    _as_format_name,
    _coerce_audio_input,
    _decode_bernini_frames,
    _decode_prompt_linked_video,
    _decode_video_media_frames,
    _is_video_media,
    _media_components,
    _memory_cleanup,
    _model_choice_state,
    _require_model_choice,
    _send_segment_preview,
    _send_status,
    _video_combine_result,
)
from .gjj_clip_prompt_encode_panel import GJJ_CLIPPromptEncodePanel
from .gjj_inject_latent_noise_plus import GJJ_InjectLatentNoisePlus
from .gjj_memory_manager import _clean_all_resources
from .gjj_model_patch_bundle import GJJ_ModelPatchBundle
from .gjj_model_upscaler import GJJ_ModelUpscaler, _list_pth_upscale_models
from .gjj_multi_lora_chain import (
    apply_standard_lora,
    load_lora_file_with_metadata,
    resolve_lora_name_fuzzy,
)
from .gjj_video_combine import GJJ_VideoCombine
from .gjj_video_universal_model_loader import GJJ_VideoUniversalModelLoader


NODE_NAME = "GJJ_Bernini13BVideoReferenceUpscaler"
SOURCE_MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
DEFAULT_MODEL = "wan2.1_bernini_1.3B_int8_convrot.safetensors"
DEFAULT_CLIP = "umt5_xxl_int4_convrot.safetensors"
DEFAULT_VAE = "wan_2.1_vae.safetensors"
DEFAULT_UPSCALE_MODEL = "RealESRGAN_x2plus.pth"
DEFAULT_HIGHRES_LORA = "Wan2.1-1.3b-lora-highresfix-v1.safetensors"
EXPECTED_HIGHRES_LORA_PATCHES = 300
DEFAULT_PROMPT = "将视频改清晰，修复细节，特别是人物面部和手指，保持原视频内容、动作、构图和身份一致。"
DEFAULT_NEGATIVE = ""


def _preferred_upscale_model(models: list[str]) -> str:
    return next(
        (
            name
            for name in models
            if Path(str(name)).name.casefold() == DEFAULT_UPSCALE_MODEL.casefold()
        ),
        models[0] if models else "",
    )


def _normalized_segment_frames(value: Any) -> int:
    frames = max(5, min(121, _integer(value, 121)))
    return max(5, min(121, ((frames - 1) // 4) * 4 + 1))


def _pad_segment_tail(frames: torch.Tensor, length: int) -> torch.Tensor:
    if int(frames.shape[0]) >= int(length):
        return frames[: int(length)].contiguous()
    repeated_tail = frames[-1:].repeat(int(length) - int(frames.shape[0]), 1, 1, 1)
    return torch.cat([frames, repeated_tail], dim=0).contiguous()


class GJJ_Bernini13BVideoReferenceUpscaler:
    CATEGORY = "GJJ/💗 一键生成"
    FUNCTION = "upscale_video"
    OUTPUT_NODE = True
    INPUT_IS_LIST = True
    RETURN_TYPES = (OUTPUT_TYPE,)
    RETURN_NAMES = ("视频参考放大结果",)
    OUTPUT_TOOLTIPS = ("Bernini 1.3B 参考重绘放大后的视频；保留源帧率和源音频。",)
    DESCRIPTION = "将 BERNINI.json 的 RealESRGAN ×2、VAE 注噪、Bernini 参考条件和视频封装流程合并为单节点。"
    SEARCH_ALIASES = ["Bernini 视频参考放大", "video reference upscale", "Bernini 1.3B upscale"]
    _MODEL_CACHE: dict[tuple[str, str, str], tuple[Any, Any, Any]] = {}

    @classmethod
    def INPUT_TYPES(cls):
        model = _model_choice_state("diffusion_models", ["wan2.1", "bernini", "1.3b"], DEFAULT_MODEL)
        clip = _model_choice_state("text_encoders", ["umt5", "xxl"], DEFAULT_CLIP)
        vae = _model_choice_state("vae", ["wan", "2.1", "vae"], DEFAULT_VAE)
        highres_lora = _model_choice_state(
            "loras",
            ["wan2.1", "1.3b", "lora", "highresfix", "v1"],
            DEFAULT_HIGHRES_LORA,
        )
        upscale_models = _list_pth_upscale_models() or [""]
        preferred_upscale = _preferred_upscale_model(upscale_models)
        samplers = list(comfy.samplers.KSampler.SAMPLERS) or ["euler"]
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS) or ["beta"]
        return {
            "required": {},
            "optional": {
                "media": (SOURCE_MEDIA_TYPE, {"display_name": "源视频/帧序列", "tooltip": "可选 VIDEO、IMAGE 或 GJJ_BATCH_IMAGE；连接后优先于节点内部视频。"}),
                "selected_video": ("STRING", _hidden({"default": "", "display_name": "内部视频"})),
                "prompt": ("STRING", _hidden({"default": DEFAULT_PROMPT, "multiline": True, "display_name": "增强提示词"})),
                "negative_prompt": ("STRING", _hidden({"default": DEFAULT_NEGATIVE, "multiline": True, "display_name": "反向提示词"})),
                "steps": ("INT", _hidden({"default": 4, "min": 1, "max": 100, "step": 1, "display_name": "采样步数"})),
                "cfg": ("FLOAT", _hidden({"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "display_name": "CFG"})),
                "seed": ("INT", _hidden({"default": 231116616039977, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "display_name": "采样种子"})),
                "sampler_name": (samplers, _hidden({"default": "euler" if "euler" in samplers else samplers[0], "display_name": "采样器"})),
                "scheduler": (schedulers, _hidden({"default": "beta" if "beta" in schedulers else schedulers[0], "display_name": "调度器"})),
                "denoise": ("FLOAT", _hidden({"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "降噪"})),
                "frame_rate": ("FLOAT", _hidden({"default": 24.0, "min": 1.0, "max": 240.0, "step": 1.0, "display_name": "无源帧率时使用"})),
                "filename_prefix": ("STRING", _hidden({"default": "video/Wan2.1_Bernini_1.3B_视频参考放大", "display_name": "文件名前缀"})),
                "format_name": ("STRING", _hidden({"default": "video/h264-mp4", "display_name": "输出格式"})),
                "keep_model": ("BOOLEAN", _hidden({"default": False, "display_name": "保持模型"})),
                "model_name": (model["models"], _hidden({"default": model["value"], "display_name": "Bernini 1.3B模型", "gjj_default_model": DEFAULT_MODEL, "gjj_missing_model": model["missing"]})),
                "clip_name": (clip["models"], _hidden({"default": clip["value"], "display_name": "UMT5 XXL", "gjj_default_model": DEFAULT_CLIP, "gjj_missing_model": clip["missing"]})),
                "vae_name": (vae["models"], _hidden({"default": vae["value"], "display_name": "Wan VAE", "gjj_default_model": DEFAULT_VAE, "gjj_missing_model": vae["missing"]})),
                "reference_resources": (REFERENCE_RESOURCE_TYPE, {"display_name": "参考资源", "tooltip": "递归接收参考图片或参考视频帧，按输入顺序写入 Bernini 条件。"}),
                "pre_cleanup_resources": ("BOOLEAN", _hidden({"default": True, "display_name": "预清理资源"})),
                "enable_pre_upscale": ("BOOLEAN", _hidden({"default": True, "display_name": "预放大源视频", "tooltip": "关闭时不检查、不加载放大模型。"})),
                "upscale_model_name": (upscale_models, _hidden({"default": preferred_upscale, "display_name": "放大模型", "gjj_default_model": preferred_upscale, "tooltip": "优先使用 RealESRGAN_x2plus.pth。"})),
                "noise_seed": ("INT", _hidden({"default": 28804529240705, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "display_name": "注噪种子"})),
                "noise_strength": ("FLOAT", _hidden({"default": 0.3, "min": -20.0, "max": 20.0, "step": 0.01, "display_name": "注噪强度"})),
                "normalize_noise": (["关闭", "开启"], _hidden({"default": "关闭", "display_name": "噪声归一化"})),
                "segment_duration": ("INT", _hidden({"default": 121, "min": 5, "max": 121, "step": 4, "display_name": "分段时长（帧）", "gjj_panel_control": "slider", "tooltip": "范围 5–121 帧，步长 4，始终满足 4n+1。"})),
                "enable_segmentation": ("BOOLEAN", _hidden({"default": False, "display_name": "启用分段", "tooltip": "默认关闭并整段处理；开启后按分段时长切分，相邻段使用尾帧衔接。"})),
                "highres_lora_name": (highres_lora["models"], _hidden({"default": highres_lora["value"], "display_name": "HighResFix LoRA", "gjj_default_model": DEFAULT_HIGHRES_LORA, "gjj_missing_model": highres_lora["missing"], "tooltip": "用于 Bernini 1.3B 视频高清修复，默认 Wan2.1-1.3b-lora-highresfix-v1.safetensors。"})),
                "highres_lora_strength": ("FLOAT", _hidden({"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.05, "display_name": "HighResFix LoRA 强度"})),
                "reference_max_size": ("INT", _hidden({"default": 1920, "min": 64, "max": 4096, "step": 32, "display_name": "参考资源最大尺寸", "tooltip": "参考工作流“Bernini 放大.json”使用 1920；过小会削弱人物与纹理参考细节。"})),
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
            dtype_1="fp16",
            dtype_2="default",
            dtype_3="default",
            clip_type_override="auto",
            unique_id=unique_id,
        )
        loaded = (result[0], result[1], result[2])
        if any(item is None for item in loaded):
            raise RuntimeError("Bernini 1.3B 模型、UMT5 XXL 或 Wan VAE 加载不完整。")
        if keep_model:
            self._MODEL_CACHE[key] = loaded
        return loaded

    def upscale_video(self, **kwargs):
        unique_id = _first(kwargs.get("unique_id"))
        prompt_info = _first(kwargs.get("prompt_info"))
        extra_pnginfo = _first(kwargs.get("extra_pnginfo"))
        keep_model = _boolean(kwargs.get("keep_model"), False)
        model_key = (
            str(_first(kwargs.get("model_name"), DEFAULT_MODEL)),
            str(_first(kwargs.get("clip_name"), DEFAULT_CLIP)),
            str(_first(kwargs.get("vae_name"), DEFAULT_VAE)),
        )
        if _boolean(kwargs.get("pre_cleanup_resources"), True):
            protected = self._MODEL_CACHE.get(model_key) if keep_model else None
            if protected is None:
                self._MODEL_CACHE.clear()
            _send_status(unique_id, "0/6 正在预清理资源...", 0.0)
            _clean_all_resources(protected_values=protected)

        # INPUT_IS_LIST 下，GJJ_BATCH_IMAGE 既可能是单个批量 tensor，也可能是逐帧
        # tensor 列表。必须把完整值交给媒体解析器，不能先 _first() 丢掉其余帧。
        media = kwargs.get("media")
        frames, audio, fps = _media_components(media)
        # GJJ_MultiVideoLoader 的“原视频纯透传旁路”会在 VIDEO components.images
        # 中放一个 64×64 单帧占位图，同时把真实视频保存在 stream source。此时必须
        # 从真实流重新解码，不能把占位图当作源视频。
        if _is_video_media(media) and (frames is None or int(frames.shape[0]) <= 1):
            decoded_frames, decoded_fps = _decode_video_media_frames(media)
            if decoded_frames is not None and int(decoded_frames.shape[0]) > int(frames.shape[0] if frames is not None else 0):
                frames = decoded_frames
                if decoded_fps is not None:
                    fps = decoded_fps
        if frames is None or int(frames.shape[0]) <= 1:
            linked_frames, linked_audio, linked_fps = _decode_prompt_linked_video(prompt_info, unique_id, "media")
            if linked_frames is not None and int(linked_frames.shape[0]) > int(frames.shape[0] if frames is not None else 0):
                frames = linked_frames
                audio = linked_audio if linked_audio is not None else audio
                fps = linked_fps if linked_fps is not None else fps
        if frames is None:
            frames, audio, fps = _selected_video_components(kwargs.get("selected_video"), extra_pnginfo, unique_id)
        if frames is None or int(frames.shape[0]) <= 0:
            raise RuntimeError("请连接 VIDEO/IMAGE 输入，或使用节点 📁 按钮选择视频。")
        frames = frames.detach().cpu().contiguous()
        if int(frames.shape[0]) < 5:
            raise RuntimeError(
                "源视频只解析到 "
                f"{int(frames.shape[0])} 帧（{int(frames.shape[2])}×{int(frames.shape[1])}），"
                "Bernini 视频参考放大至少需要 5 帧。"
                "请确认“源视频/帧序列”连接的是完整 VIDEO/GJJ_BATCH_IMAGE，"
                "不要误接参考图或单帧预览输出。"
            )

        if _boolean(kwargs.get("enable_pre_upscale"), True):
            _send_status(unique_id, "1/6 使用 RealESRGAN 预放大源视频...", 0.08)
            frames = GJJ_ModelUpscaler().upscale(
                frames,
                True,
                str(_first(kwargs.get("upscale_model_name"), "") or ""),
                unique_id=unique_id,
            )[0].detach().cpu().contiguous()

        height, width = int(frames.shape[1]), int(frames.shape[2])
        width = max(16, int(round(width / 16.0)) * 16)
        height = max(16, int(round(height / 16.0)) * 16)
        if int(frames.shape[2]) != width or int(frames.shape[1]) != height:
            frames = F.interpolate(
                frames[:, :, :, :3].movedim(-1, 1),
                size=(height, width),
                mode="bilinear",
                align_corners=False,
            ).movedim(1, -1).contiguous()
        total_frames = int(frames.shape[0])
        if not keep_model:
            self._MODEL_CACHE.clear()
        _memory_cleanup(unique_id, "运行前清理显存和内存...", clear_video_cache=False)

        _send_status(unique_id, "2/6 加载 Bernini 1.3B / UMT5 / VAE...", 0.18)
        model, vae, clip = self._load_models(*model_key, keep_model, unique_id)
        highres_lora_name = _require_model_choice(
            str(_first(kwargs.get("highres_lora_name"), DEFAULT_HIGHRES_LORA)),
            "HighResFix LoRA",
        )
        resolved_lora_name = resolve_lora_name_fuzzy(highres_lora_name)
        highres_lora_path = folder_paths.get_full_path("loras", resolved_lora_name)
        if not highres_lora_path:
            raise RuntimeError(f"HighResFix LoRA 文件未找到：{highres_lora_name}")
        highres_lora_state, _highres_lora_metadata = load_lora_file_with_metadata(highres_lora_path)
        model, _unused_clip, model_patch_count, _clip_patch_count, loaded_patch_count = apply_standard_lora(
            model,
            None,
            highres_lora_state,
            _number(kwargs.get("highres_lora_strength"), 1.0),
            0.0,
        )
        if model_patch_count < EXPECTED_HIGHRES_LORA_PATCHES:
            raise RuntimeError(
                "HighResFix LoRA 权重匹配不完整："
                f"成功应用 {model_patch_count}/{EXPECTED_HIGHRES_LORA_PATCHES} 组模型权重"
                f"（解析得到 {loaded_patch_count} 组）。"
                "请确认连接的是 Bernini/Wan 2.1 1.3B 底模，并重启 ComfyUI 后重试。"
            )
        _send_status(
            unique_id,
            f"2/6 HighResFix LoRA 已应用：{model_patch_count}/{EXPECTED_HIGHRES_LORA_PATCHES} 组权重",
            0.24,
        )
        model = GJJ_ModelPatchBundle().patch(
            model,
            启用SageAttention=True,
            SageAttention模式="自动",
            允许Sage编译=True,
            启用FP16累积设置=True,
            FP16累积=True,
            unique_id=unique_id,
        )[0]
        positive, negative = GJJ_CLIPPromptEncodePanel().encode(
            clip=clip,
            positive_text=str(_first(kwargs.get("prompt"), DEFAULT_PROMPT)),
            negative_text=str(_first(kwargs.get("negative_prompt"), DEFAULT_NEGATIVE)),
            zero_conditioning=True,
            translation_device="auto",
            translation_unload_after_use=False,
            translation_enabled=False,
            unique_id=unique_id,
        )

        effective_fps = float(fps or _number(kwargs.get("frame_rate"), 24.0))
        segmentation_enabled = _boolean(kwargs.get("enable_segmentation"), False)
        segment_frames = (
            _normalized_segment_frames(kwargs.get("segment_duration"))
            if segmentation_enabled else total_frames
        )
        segment_stride = max(1, segment_frames - 1)
        segment_count = (
            max(1, int(math.ceil(max(0, total_frames - 1) / float(segment_stride))))
            if segmentation_enabled else 1
        )
        reference_resources = _reference_resources(kwargs.get("reference_resources"))
        generated: list[torch.Tensor] = []
        preview: list[dict[str, Any]] = []
        for index in range(segment_count):
            start = index * segment_stride
            end = min(total_frames, start + segment_frames)
            source = frames[start:end]
            actual_length = int(source.shape[0])
            padded_source = _pad_segment_tail(source, segment_frames)
            _send_status(
                unique_id,
                (
                    f"3/6 处理第 {index + 1}/{segment_count} 段（{segment_frames} 帧，尾帧衔接）..."
                    if segmentation_enabled else
                    f"3/6 整段处理（{total_frames} 帧）..."
                ),
                0.32 + 0.5 * index / max(1, segment_count),
            )
            encoded = _encode_context_latent(vae, padded_source[:, :, :, :3])
            samples = encoded.unsqueeze(0) if encoded.ndim == 4 else encoded
            latent = GJJ_InjectLatentNoisePlus().inject_noise(
                {"samples": samples},
                _integer(kwargs.get("noise_seed"), 28804529240705) + index,
                _number(kwargs.get("noise_strength"), 0.3),
                str(_first(kwargs.get("normalize_noise"), "关闭")),
            )[0]
            segment_references = list(reference_resources)
            if segmentation_enabled and generated:
                segment_references.append(generated[-1][-1:].contiguous())
            seg_positive, seg_negative, _empty = GJJBerniniConditioning().build(
                positive=positive,
                negative=negative,
                vae=vae,
                width=width,
                height=height,
                length=segment_frames,
                batch_size=1,
                ref_max_size=max(64, _integer(kwargs.get("reference_max_size"), 1920)),
                reference_resources=segment_references,
            )
            sampled = common_ksampler(
                model,
                _integer(kwargs.get("seed"), 231116616039977) + index,
                max(1, _integer(kwargs.get("steps"), 4)),
                _number(kwargs.get("cfg"), 1.0),
                str(_first(kwargs.get("sampler_name"), "euler")),
                str(_first(kwargs.get("scheduler"), "beta")),
                seg_positive,
                seg_negative,
                latent,
                denoise=max(0.0, min(1.0, _number(kwargs.get("denoise"), 0.3))),
            )[0]
            decoded = _decode_bernini_frames(vae, sampled, {"vae_tiling": True, "tile_x": 272, "tile_y": 272})
            decoded = decoded[:actual_length].detach().cpu().contiguous()
            generated.append(decoded)
            segment_preview = GJJ_VideoCombine().combine(
                images=decoded,
                frame_rate=effective_fps,
                loop_count=0,
                filename_prefix=f"gjj_bernini13b_reference_upscale_{index + 1:04d}",
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
            preview = list(segment_preview.get("ui", {}).get("preview_media") or [])
            _send_segment_preview(unique_id, preview, index + 1, segment_count, "segment_video")

        stitched = [generated[0]]
        stitched.extend(segment[1:] for segment in generated[1:])
        decoded = torch.cat(stitched, dim=0)[:total_frames].contiguous()
        _send_status(
            unique_id,
            "5/6 删除段间重复帧并封装源音频..." if segmentation_enabled else "5/6 封装源音频...",
            0.86,
        )
        audio_input = media if callable(getattr(media, "get_components", None)) else _coerce_audio_input(audio)
        combined = GJJ_VideoCombine().combine(
            images=decoded,
            frame_rate=effective_fps,
            loop_count=0,
            filename_prefix=str(_first(kwargs.get("filename_prefix"), "video/Wan2.1_Bernini_1.3B_视频参考放大")),
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
        video, output_path, _files = _video_combine_result(combined)
        final_preview = list(combined.get("ui", {}).get("preview_media") or [])
        if final_preview:
            preview = final_preview
            _send_segment_preview(unique_id, preview, segment_count, segment_count, "final_video")
        _send_status(unique_id, f"6/6 完成：{total_frames} 帧 / {segment_count} 段 / 每段 {segment_frames} 帧 / {effective_fps:g} FPS", 1.0)
        if not keep_model:
            _memory_cleanup(unique_id, "完成并释放模型...", clear_video_cache=False)
        return {
            "ui": {
                "gjj_images": preview,
                "preview_label": ["final_video"],
                "segment_count": [segment_count],
                "frame_count": [total_frames],
                "output_path": [str(output_path or "")],
            },
            "result": (video,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Bernini13BVideoReferenceUpscaler}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ ·🎞️视频参考放大（Bernini 1.3B）"}
