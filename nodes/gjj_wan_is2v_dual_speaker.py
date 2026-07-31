from __future__ import annotations

import math
import importlib
from typing import Any

import torch
import torch.nn.functional as F

import folder_paths
import comfy.model_management
import comfy.utils

from .gjj_sam3_face_crop_video_aio import (
    DEFAULT_CHECKPOINT,
    MAX_FACE_OUTPUTS,
    _checkpoint_list,
    _crop_audio_by_seconds,
    _encode_text,
    _ensure_audio_encoder_output,
    _extract_images,
    _load_checkpoint,
    _normalize_track_frame_count,
    _parse_speaker_face_map,
    _parse_timeline,
    _pick_default_checkpoint,
    _prepare_track_data,
    _safe_float,
    _safe_int,
    _speaker_direction_face_index,
    _speaker_stats,
    _timeline_frame_ranges,
    _track_route,
    _translate_prompts,
    _unpack_sam3_masks,
)


NODE_NAME = "GJJ_WanIS2VDualSpeaker"
AUTO_MODEL_CHOICE = "自动"
DEFAULT_CLIP_VISION_NAME = "clip_vision_h.safetensors"
DEFAULT_AUDIO_ENCODER_NAME = "wav2vec2_large_english_fp16.safetensors"

WAN_AUDIO_INPUT_FPS = 50
WAN_AUDIO_VIDEO_RATE = 30
WAN_AUDIO_FPS = 16
WAN_AUDIO_SAMPLE_RATE = 16000
WAN_VAE_SCALE = 8
WAN_PATCH_SPATIAL = 2


def _conditioning_set_values(conditioning: Any, values: dict[str, Any]) -> Any:
    if conditioning is None:
        return conditioning
    result = []
    for item in conditioning:
        if isinstance(item, (list, tuple)) and len(item) >= 2 and isinstance(item[1], dict):
            metadata = dict(item[1])
            metadata.update(values)
            result.append([item[0], metadata])
        else:
            result.append(item)
    return result


def _encoded_audio_layers(audio_encoder_output: Any) -> list[torch.Tensor]:
    layers = audio_encoder_output.get("encoded_audio_all_layers") if isinstance(audio_encoder_output, dict) else None
    if not layers:
        raise RuntimeError("AUDIO_ENCODER_OUTPUT 格式不正确：缺少 encoded_audio_all_layers，无法生成 Wan S2V 音频条件。")
    return list(layers)


def _linear_interpolation(features: torch.Tensor, input_fps: int, output_fps: int, output_len: int | None = None) -> torch.Tensor:
    features = features.transpose(1, 2)
    seq_len = features.shape[2] / float(input_fps)
    if output_len is None:
        output_len = int(seq_len * output_fps)
    output_features = F.interpolate(features, size=output_len, align_corners=True, mode="linear")
    return output_features.transpose(1, 2)


def _audio_feat(audio_encoder_output: Any) -> torch.Tensor:
    feat = torch.cat(_encoded_audio_layers(audio_encoder_output))
    return _linear_interpolation(feat, input_fps=WAN_AUDIO_INPUT_FPS, output_fps=WAN_AUDIO_VIDEO_RATE)


def _audio_encoder_output_video_frames(audio_encoder_output: Any, fps: int = WAN_AUDIO_FPS) -> int:
    if isinstance(audio_encoder_output, dict):
        audio_samples = audio_encoder_output.get("audio_samples")
        if audio_samples is not None:
            return max(1, int(round(float(audio_samples) / float(WAN_AUDIO_SAMPLE_RATE) * fps)))
    feat = _audio_feat(audio_encoder_output)
    audio_frame_num = feat.shape[1]
    return max(1, int(round(audio_frame_num * fps / WAN_AUDIO_VIDEO_RATE)))


def _sample_indices_fixed_start(original_fps: int, total_frames: int, target_fps: int, num_sample: int, fixed_start: int = 0) -> list[int]:
    indices = []
    for index in range(int(num_sample)):
        frame = int(round((float(fixed_start) / original_fps + index / float(target_fps)) * original_fps))
        indices.append(max(0, min(frame, int(total_frames) - 1)))
    return indices


def _get_audio_embed_bucket_fps(
    audio_embed: torch.Tensor,
    fps: int = WAN_AUDIO_FPS,
    batch_frames: int = 81,
    m: int = 0,
    video_rate: int = WAN_AUDIO_VIDEO_RATE,
) -> tuple[torch.Tensor, int]:
    num_layers, audio_frame_num, audio_dim = audio_embed.shape
    return_all_layers = num_layers > 1
    scale = video_rate / fps
    min_batch_num = int(audio_frame_num / (batch_frames * scale)) + 1
    bucket_num = min_batch_num * batch_frames
    padd_audio_num = math.ceil(min_batch_num * batch_frames / fps * video_rate) - audio_frame_num
    batch_idx = _sample_indices_fixed_start(
        original_fps=video_rate,
        total_frames=audio_frame_num + padd_audio_num,
        target_fps=fps,
        num_sample=bucket_num,
        fixed_start=0,
    )
    batch_audio = []
    audio_sample_stride = int(video_rate / fps)
    for bi in batch_idx:
        if bi < audio_frame_num:
            chosen_idx = list(range(bi - m * audio_sample_stride, bi + (m + 1) * audio_sample_stride, audio_sample_stride))
            chosen_idx = [0 if c < 0 else c for c in chosen_idx]
            chosen_idx = [audio_frame_num - 1 if c >= audio_frame_num else c for c in chosen_idx]
            if return_all_layers:
                frame_audio_embed = audio_embed[:, chosen_idx].flatten(start_dim=-2, end_dim=-1)
            else:
                frame_audio_embed = audio_embed[0][chosen_idx].flatten()
        elif return_all_layers:
            frame_audio_embed = torch.zeros([num_layers, audio_dim * (2 * m + 1)], device=audio_embed.device, dtype=audio_embed.dtype)
        else:
            frame_audio_embed = torch.zeros([audio_dim * (2 * m + 1)], device=audio_embed.device, dtype=audio_embed.dtype)
        batch_audio.append(frame_audio_embed)
    return torch.cat([item.unsqueeze(0) for item in batch_audio], dim=0), min_batch_num


def _permute_audio_embed_bucket(audio_embed_bucket: torch.Tensor) -> torch.Tensor:
    audio_embed_bucket = audio_embed_bucket.unsqueeze(0)
    if len(audio_embed_bucket.shape) == 3:
        return audio_embed_bucket.permute(0, 2, 1)
    return audio_embed_bucket.permute(0, 2, 3, 1)


def _build_timeline_audio_embed(length: int, segments: list[dict[str, Any]]) -> torch.Tensor | None:
    if not segments:
        return None
    latent_t = ((int(length) - 1) // 4) + 1
    batch_frames = latent_t * 4
    total_feat_frames = int(math.ceil(batch_frames * WAN_AUDIO_VIDEO_RATE / WAN_AUDIO_FPS))

    composite = None
    cursor_auto = 0
    for segment in segments:
        feat = _audio_feat(segment["audio_encoder_output"])
        if composite is None:
            composite = torch.zeros(feat.shape[0], total_feat_frames, feat.shape[2], dtype=feat.dtype, device=feat.device)

        start_frame = segment.get("start_frame", -1)
        if start_frame is None or start_frame < 0:
            start_frame = cursor_auto
        else:
            start_frame = int(start_frame)

        start_feat = int(round(start_frame * WAN_AUDIO_VIDEO_RATE / WAN_AUDIO_FPS))
        copy_len = min(feat.shape[1], total_feat_frames - start_feat)
        if copy_len > 0 and start_feat < total_feat_frames:
            composite[:, start_feat:start_feat + copy_len, :] = feat[:, :copy_len, :]

        cursor_auto = start_frame + _audio_encoder_output_video_frames(segment["audio_encoder_output"])

    if composite is None:
        return None
    audio_embed_bucket, _ = _get_audio_embed_bucket_fps(
        composite, fps=WAN_AUDIO_FPS, batch_frames=batch_frames, m=0, video_rate=WAN_AUDIO_VIDEO_RATE
    )
    return _permute_audio_embed_bucket(audio_embed_bucket)[:, :, :, :batch_frames]


def _resolve_timeline_segment_ranges(length: int, segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    batch_frames = (((int(length) - 1) // 4) + 1) * 4
    resolved = []
    cursor_auto = 0
    for segment in segments:
        start_frame = segment.get("start_frame", -1)
        if start_frame is None or start_frame < 0:
            start_frame = cursor_auto
        else:
            start_frame = int(start_frame)
        duration = _audio_encoder_output_video_frames(segment["audio_encoder_output"])
        end_frame = min(batch_frames, start_frame + duration)
        resolved.append({**segment, "start_frame": start_frame, "end_frame": end_frame})
        cursor_auto = end_frame
    return resolved


def _padded_latent_dim(pixels: int) -> int:
    latent = int(pixels) // WAN_VAE_SCALE
    return latent + (WAN_PATCH_SPATIAL - latent % WAN_PATCH_SPATIAL) % WAN_PATCH_SPATIAL


def _token_grid_size(width: int, height: int) -> tuple[int, int]:
    return _padded_latent_dim(height) // WAN_PATCH_SPATIAL, _padded_latent_dim(width) // WAN_PATCH_SPATIAL


def _build_spatial_token_mask(width: int, height: int, mask_image: torch.Tensor | None = None) -> torch.Tensor:
    token_h, token_w = _token_grid_size(width, height)
    spatial = torch.zeros(1, 1, token_h, token_w)
    if mask_image is not None:
        mask = mask_image[0] if mask_image.ndim == 3 else mask_image
        mask = mask.unsqueeze(0).unsqueeze(0)
        mask = comfy.utils.common_upscale(mask, width, height, "area", "center")
        mask = comfy.utils.common_upscale(mask, token_w, token_h, "area", "center")
        spatial = (mask > 0.5).to(dtype=torch.float32)
    return spatial


def _latent_frame_weight(video_frame: int, start_frame: int, end_frame: int, crossfade_frames: int) -> float:
    if video_frame < start_frame or video_frame >= end_frame:
        return 0.0
    if crossfade_frames <= 0:
        return 1.0
    weight = 1.0
    if video_frame < start_frame + crossfade_frames:
        weight = min(weight, (video_frame - start_frame + 1) / crossfade_frames)
    if video_frame >= end_frame - crossfade_frames:
        weight = min(weight, (end_frame - video_frame) / crossfade_frames)
    return max(0.0, weight)


def _build_timeline_audio_inject_mask(
    width: int,
    height: int,
    length: int,
    segments: list[dict[str, Any]],
    crossfade_frames: int = 0,
    device: torch.device | None = None,
) -> torch.Tensor:
    latent_t = ((int(length) - 1) // 4) + 1
    token_h, token_w = _token_grid_size(width, height)
    mask = torch.zeros(1, latent_t, token_h * token_w, 1)

    for segment in segments:
        spatial = _build_spatial_token_mask(width, height, mask_image=segment.get("mask_image"))
        tokens = spatial.flatten(2).squeeze(1)
        start_frame = int(segment["start_frame"])
        end_frame = int(segment["end_frame"])
        for latent_idx in range(latent_t):
            vf0 = latent_idx * 4
            vf1 = min(vf0 + 4, latent_t * 4)
            weight = 0.0
            for video_frame in range(vf0, vf1):
                weight = max(weight, _latent_frame_weight(video_frame, start_frame, end_frame, crossfade_frames))
            if weight > 0.0:
                mask[:, latent_idx, :, 0] = torch.maximum(mask[:, latent_idx, :, 0], tokens * weight)

    if device is not None:
        mask = mask.to(device)
    return mask


def _apply_timeline_audio_conditioning(positive: Any, negative: Any, length: int, segments: list[dict[str, Any]]) -> tuple[Any, Any]:
    audio_embed_bucket = _build_timeline_audio_embed(length, segments)
    if audio_embed_bucket is None or audio_embed_bucket.shape[3] <= 0:
        return positive, negative
    positive = _conditioning_set_values(positive, {"audio_embed": audio_embed_bucket})
    negative = _conditioning_set_values(negative, {"audio_embed": audio_embed_bucket * 0.0})
    return positive, negative


def _apply_timeline_masked_audio(
    positive: Any,
    negative: Any,
    width: int,
    height: int,
    length: int,
    segments: list[dict[str, Any]],
    mask_crossfade_frames: int,
    audio_inject_scale: float,
) -> tuple[Any, Any]:
    positive, negative = _apply_timeline_audio_conditioning(positive, negative, length, segments)
    resolved_segments = _resolve_timeline_segment_ranges(length, segments)
    cond_values = {
        "audio_inject_scale": float(audio_inject_scale),
        "audio_inject_mask": _build_timeline_audio_inject_mask(
            width,
            height,
            length,
            resolved_segments,
            crossfade_frames=int(mask_crossfade_frames),
            device=comfy.model_management.intermediate_device(),
        ),
    }
    positive = _conditioning_set_values(positive, cond_values)
    negative_values = dict(cond_values)
    negative_values["audio_inject_mask"] = negative_values["audio_inject_mask"] * 0.0
    negative = _conditioning_set_values(negative, negative_values)
    return positive, negative


def _apply_i2v_start_image(
    positive: Any,
    negative: Any,
    vae: Any,
    width: int,
    height: int,
    length: int,
    batch_size: int,
    start_image: torch.Tensor | None,
) -> tuple[Any, Any, torch.Tensor]:
    latent = torch.zeros(
        [int(batch_size), 16, ((int(length) - 1) // 4) + 1, int(height) // 8, int(width) // 8],
        device=comfy.model_management.intermediate_device(),
    )
    if start_image is None:
        return positive, negative, latent

    start_image = comfy.utils.common_upscale(
        start_image[: int(length)].movedim(-1, 1), int(width), int(height), "bilinear", "center"
    ).movedim(1, -1)
    image = torch.ones(
        (int(length), int(height), int(width), start_image.shape[-1]),
        device=start_image.device,
        dtype=start_image.dtype,
    ) * 0.5
    image[: start_image.shape[0]] = start_image

    concat_latent_image = vae.encode(image[:, :, :, :3])
    mask = torch.ones(
        (1, 1, latent.shape[2], concat_latent_image.shape[-2], concat_latent_image.shape[-1]),
        device=start_image.device,
        dtype=start_image.dtype,
    )
    mask[:, :, : ((start_image.shape[0] - 1) // 4) + 1] = 0.0

    cond = {"concat_latent_image": concat_latent_image, "concat_mask": mask}
    positive = _conditioning_set_values(positive, cond)
    negative = _conditioning_set_values(negative, cond)
    return positive, negative, latent


def _first_audio(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict) and isinstance(value.get("waveform"), torch.Tensor):
        return value
    if isinstance(value, (list, tuple)):
        for item in value:
            audio = _first_audio(item)
            if audio is not None:
                return audio
    if isinstance(value, dict):
        for key in ("audio", "result", "output", "outputs"):
            audio = _first_audio(value.get(key))
            if audio is not None:
                return audio
    return None


def _model_choice_value(value: Any) -> str:
    text = str(value or "").strip()
    return "" if not text or text == AUTO_MODEL_CHOICE else text


def _model_filter_key(value: str) -> str:
    text = str(value or "").replace("\\", "/")
    text = "/".join(part.rsplit(".", 1)[0] for part in text.split("/") if part)
    return "".join(ch for ch in text.lower() if ch.isalnum())


def _filtered_model_choices(folder: str, keywords: list[str], preferred: str = "") -> tuple[list[str], str]:
    try:
        names = [str(item) for item in folder_paths.get_filename_list(folder) or []]
    except Exception:
        names = []
    keys = [_model_filter_key(item) for item in keywords if str(item or "").strip()]
    filtered = [name for name in names if all(key in _model_filter_key(name) for key in keys)]
    if preferred:
        preferred_matches = [name for name in names if name.replace("\\", "/").rsplit("/", 1)[-1].lower() == preferred.lower()]
        for item in reversed(preferred_matches):
            if item in filtered:
                filtered.remove(item)
            filtered.insert(0, item)
    choices = [AUTO_MODEL_CHOICE, *filtered]
    default = filtered[0] if filtered else AUTO_MODEL_CHOICE
    return choices, default


def _choices_with_default(folder: str, keywords: list[str], preferred: str) -> tuple[list[str], str]:
    choices, default = _filtered_model_choices(folder, keywords, preferred)
    usable = [item for item in choices if str(item or "").strip() and item != AUTO_MODEL_CHOICE]
    if usable:
        return usable, usable[0]
    return choices, default


def _unwrap_loader_output(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        for key in ("result", "output", "outputs", "values", "value"):
            if key in value:
                unwrapped = _unwrap_loader_output(value.get(key))
                if unwrapped is not None:
                    return unwrapped
        return value
    if isinstance(value, (list, tuple)) and value:
        return _unwrap_loader_output(value[0])
    for attr in ("result", "output", "outputs", "values", "value", "_values", "_outputs"):
        if hasattr(value, attr):
            try:
                unwrapped = _unwrap_loader_output(getattr(value, attr))
                if unwrapped is not None:
                    return unwrapped
            except Exception:
                pass
    if type(value).__name__ == "NodeOutput":
        try:
            items = list(value)
            if items:
                return _unwrap_loader_output(items[0])
        except Exception:
            pass
        try:
            return _unwrap_loader_output(value[0])
        except Exception:
            pass
    return value


def _extract_audio_encoder_output_compat(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, dict):
        if value.get("encoded_audio_all_layers"):
            return value
        for key in ("result", "output", "outputs", "values", "value", "audio_encoder_output", "AUDIO_ENCODER_OUTPUT"):
            if key in value:
                nested = _extract_audio_encoder_output_compat(value.get(key))
                if nested is not None:
                    return nested
        return None
    if isinstance(value, (list, tuple)):
        for item in value:
            nested = _extract_audio_encoder_output_compat(item)
            if nested is not None:
                return nested
        return None
    for attr in ("result", "output", "outputs", "values", "value", "_values", "_outputs"):
        if hasattr(value, attr):
            try:
                nested = _extract_audio_encoder_output_compat(getattr(value, attr))
                if nested is not None:
                    return nested
            except Exception:
                pass
    if type(value).__name__ == "NodeOutput":
        try:
            for item in value:
                nested = _extract_audio_encoder_output_compat(item)
                if nested is not None:
                    return nested
        except Exception:
            pass
        try:
            return _extract_audio_encoder_output_compat(value[0])
        except Exception:
            pass
    layers = getattr(value, "encoded_audio_all_layers", None)
    if layers:
        return {"encoded_audio_all_layers": layers}
    return None


def _call_loader_class(module_names: list[str], class_name: str, model_name: str) -> Any:
    errors: list[str] = []
    for module_name in module_names:
        try:
            module = importlib.import_module(module_name)
            cls = getattr(module, class_name, None)
            if cls is None:
                mappings = getattr(module, "NODE_CLASS_MAPPINGS", None)
                if isinstance(mappings, dict):
                    cls = mappings.get(class_name)
            if cls is None:
                continue
            try:
                instance = cls()
            except TypeError:
                instance = None
            candidates = []
            function_name = getattr(cls, "FUNCTION", None) or getattr(instance, "FUNCTION", None)
            if function_name:
                if instance is not None:
                    candidates.append(getattr(instance, function_name, None))
                candidates.append(getattr(cls, function_name, None))
            for method_name in ("execute", "load", "load_model", "load_audio_encoder"):
                if instance is not None:
                    candidates.append(getattr(instance, method_name, None))
                candidates.append(getattr(cls, method_name, None))
            last_error: Exception | None = None
            for method in candidates:
                if not callable(method):
                    continue
                try:
                    return _unwrap_loader_output(method(model_name))
                except Exception as exc:
                    last_error = exc
            if last_error is not None:
                raise last_error
        except Exception as exc:
            errors.append(f"{module_name}.{class_name}: {exc}")
    raise RuntimeError(f"无法调用加载器 {class_name}。尝试结果：" + " | ".join(errors[-8:]))


def _load_clip_vision(name: str) -> Any:
    try:
        import comfy.clip_vision
    except Exception as exc:
        raise RuntimeError("当前 ComfyUI 环境无法导入 comfy.clip_vision，不能加载视觉编码器。") from exc
    path = folder_paths.get_full_path_or_raise("clip_vision", name)
    return comfy.clip_vision.load(path)


def _load_audio_encoder(name: str) -> Any:
    return _call_loader_class(
        [
            "comfy_extras.nodes_audio_encoder",
            "comfy_extras.nodes_audio",
            "comfy_extras.nodes_wan",
            "nodes",
        ],
        "AudioEncoderLoader",
        name,
    )


def _encode_audio_encoder_output_compat(audio_encoder: Any, audio: dict[str, Any]) -> dict[str, Any]:
    audio_encoder = _unwrap_loader_output(audio_encoder)
    if callable(getattr(audio_encoder, "encode_audio", None)):
        output = audio_encoder.encode_audio(audio["waveform"], audio["sample_rate"])
        encoded = _extract_audio_encoder_output_compat(output)
        if encoded is not None:
            return encoded

    errors: list[str] = []
    for module_name in ("comfy_extras.nodes_audio_encoder", "comfy_extras.nodes_audio", "comfy_extras.nodes_wan", "nodes"):
        try:
            module = importlib.import_module(module_name)
            cls = getattr(module, "AudioEncoderEncode", None)
            if cls is None:
                mappings = getattr(module, "NODE_CLASS_MAPPINGS", None)
                if isinstance(mappings, dict):
                    cls = mappings.get("AudioEncoderEncode")
            if cls is None:
                continue
            try:
                instance = cls()
            except TypeError:
                instance = None
            for method_name in ("encode", "encode_audio", "execute"):
                methods = []
                if instance is not None:
                    methods.append(getattr(instance, method_name, None))
                methods.append(getattr(cls, method_name, None))
                for method in methods:
                    if not callable(method):
                        continue
                    calls = (
                        lambda method=method: method(audio_encoder=audio_encoder, audio=audio),
                        lambda method=method: method(audio_encoder, audio),
                        lambda method=method: method(audio, audio_encoder),
                    )
                    for call in calls:
                        try:
                            output = call()
                            encoded = _extract_audio_encoder_output_compat(output)
                            if encoded is not None:
                                return encoded
                            errors.append(f"{module_name}.{method_name}: 返回值缺少 encoded_audio_all_layers")
                        except TypeError as exc:
                            errors.append(f"{module_name}.{method_name}: {exc}")
                            continue
                        except Exception as exc:
                            errors.append(f"{module_name}.{method_name}: {exc}")
                            continue
        except Exception as exc:
            errors.append(f"{module_name}: {exc}")
    raise RuntimeError("无法生成有效 AUDIO_ENCODER_OUTPUT；返回值缺少 encoded_audio_all_layers。尝试结果：" + " | ".join(errors[-8:]))


def _load_named_clip_vision(name: Any) -> Any:
    resolved = _model_choice_value(name)
    if not resolved:
        choices, default = _choices_with_default("clip_vision", ["clip_vision"], DEFAULT_CLIP_VISION_NAME)
        resolved = _model_choice_value(default or (choices[0] if choices else ""))
    if not resolved:
        raise RuntimeError("没有找到可用的 CLIP视觉模型；请把 clip_vision_h.safetensors 放到 models/clip_vision。")
    return _load_clip_vision(resolved)


def _load_named_audio_encoder(name: Any) -> Any:
    resolved = _model_choice_value(name)
    if not resolved:
        choices, default = _choices_with_default("audio_encoders", ["wav2vec2"], DEFAULT_AUDIO_ENCODER_NAME)
        resolved = _model_choice_value(default or (choices[0] if choices else ""))
    if not resolved:
        raise RuntimeError("没有找到可用的音频编码器；请把 wav2vec2_large_english_fp16.safetensors 放到 models/audio_encoders。")
    return _load_audio_encoder(resolved)


def _encode_clip_vision_output(clip_vision: Any, image: torch.Tensor) -> Any:
    if not isinstance(image, torch.Tensor):
        raise RuntimeError("输入图片必须是 ComfyUI IMAGE 张量，无法进行 CLIP 视觉编码。")

    try:
        import nodes as comfy_nodes

        cls = getattr(comfy_nodes, "CLIPVisionEncode", None)
        if cls is not None:
            instance = cls()
            for method_name in ("encode", "clip_vision_encode", "execute"):
                method = getattr(instance, method_name, None) or getattr(cls, method_name, None)
                if not callable(method):
                    continue
                for call in (
                    lambda method=method: method(clip_vision=clip_vision, image=image, crop="center"),
                    lambda method=method: method(clip_vision, image, "center"),
                    lambda method=method: method(clip_vision, image),
                ):
                    try:
                        output = call()
                        if isinstance(output, (list, tuple)) and output:
                            return output[0]
                        return output
                    except TypeError:
                        continue
    except Exception:
        pass

    for method_name in ("encode_image", "encode", "process"):
        method = getattr(clip_vision, method_name, None)
        if not callable(method):
            continue
        for call in (
            lambda method=method: method(image),
            lambda method=method: method(image, crop="center"),
        ):
            try:
                output = call()
                if isinstance(output, (list, tuple)) and output:
                    return output[0]
                return output
            except TypeError:
                continue

    raise RuntimeError("无法使用当前 CLIP视觉模型编码输入图片；未找到兼容的 CLIPVisionEncode/encode_image 调用。")


def _mask_union_center_x(mask: torch.Tensor) -> float:
    if mask.ndim == 3:
        mask = mask.any(dim=0)
    ys, xs = torch.nonzero(mask > 0.5, as_tuple=True)
    if xs.numel() <= 0:
        return 0.0
    return float(xs.float().mean().item())


def _build_speaker_masks_from_image(
    input_image: Any,
    timeline_text: str,
    checkpoint: str,
    detection_threshold: str,
    max_faces: int,
    detect_interval: int,
    speaker_face_map: str,
    timeline_default_duration: str,
    frame_rate: str,
    sam3_text_prompt: str,
    length: int,
    unique_id: Any = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    images = _extract_images(input_image)
    if images is None or int(images.shape[0]) <= 0:
        raise RuntimeError("请连接输入图片：需要 IMAGE、GJJ_BATCH_IMAGE 或可提取图片帧的媒体。")

    frame_count, height, width, _channels = images.shape
    default_duration = _safe_float(timeline_default_duration, 2.0, 0.05, 60.0)
    fps = _safe_float(frame_rate, WAN_AUDIO_FPS, 0.01, 240.0)
    timeline_entries = _parse_timeline(timeline_text, default_duration)
    if not timeline_entries:
        raise RuntimeError("时间轴文本为空或无法解析；请连接 GJJ_UniversalTTS 的“时间轴文本”。")
    speakers, _stats = _speaker_stats(timeline_entries)
    if not speakers:
        raise RuntimeError("时间轴里没有解析到说话人标签，例如 [说话人1] 或 [右边的人]。")

    model, clip, resolved = _load_checkpoint(checkpoint, unique_id=unique_id)
    target = str(sam3_text_prompt or "face").strip() or "face"
    translated_target = (_translate_prompts([target], unique_id=unique_id)[0] or target).strip() or "face"
    conditioning = _encode_text(clip, translated_target)
    try:
        track_data = _track_route(
            images,
            model,
            conditioning,
            _safe_float(detection_threshold, 0.5, 0.0, 1.0),
            _safe_int(max_faces, 8, 1, MAX_FACE_OUTPUTS),
            _safe_int(detect_interval, 1, 1, 999),
        )
        track_data = _normalize_track_frame_count(track_data, images)
        track_data = _prepare_track_data(track_data, "", "从左到右")
    except Exception as exc:
        raise RuntimeError(
            f"SAM3 智能说话人遮罩失败。\n模型：{resolved}\n原始目标：{target}\n翻译目标：{translated_target}\n详细错误：{exc}"
        ) from exc

    masks = _unpack_sam3_masks(track_data)
    if masks is None:
        raise RuntimeError("SAM3 没有返回可用的人脸 mask，无法按说话人打遮罩。")
    masks = F.interpolate(
        masks.float().view(int(masks.shape[0]) * int(masks.shape[1]), 1, int(masks.shape[-2]), int(masks.shape[-1])),
        size=(int(height), int(width)),
        mode="nearest",
    ).view(int(masks.shape[0]), int(masks.shape[1]), int(height), int(width)) > 0.5

    face_count = min(max(1, len(speakers)), MAX_FACE_OUTPUTS, int(masks.shape[1]))
    if face_count <= 0:
        raise RuntimeError("没有检测到可用人脸。")

    face_masks = [masks[:, index].any(dim=0).float().unsqueeze(0) for index in range(face_count)]
    order = sorted(range(face_count), key=lambda index: _mask_union_center_x(face_masks[index]))
    face_masks = [face_masks[index] for index in order]

    manual_map = _parse_speaker_face_map(speaker_face_map, face_count)
    speaker_to_face: dict[str, int] = {}
    next_face = 0
    for speaker in speakers:
        if speaker in manual_map:
            speaker_to_face[speaker] = manual_map[speaker]
            continue
        direction_index = _speaker_direction_face_index(speaker, face_count)
        if direction_index is not None:
            speaker_to_face[speaker] = direction_index
            continue
        while next_face in set(speaker_to_face.values()):
            next_face += 1
        speaker_to_face[speaker] = next_face
        next_face += 1
    speaker_to_face = {speaker: index for speaker, index in speaker_to_face.items() if 0 <= int(index) < int(face_count)}

    ranges = _timeline_frame_ranges(timeline_entries, "", speaker_to_face, float(fps), int(length))
    if not ranges:
        raise RuntimeError("时间轴说话人没有匹配到可用人脸，请检查说话人-人脸映射。")

    segments = []
    for item in ranges:
        face_index = int(item["face_index"])
        segments.append(
            {
                "start": float(item["start"]),
                "end": float(item["end"]),
                "start_frame": int(item["start_frame"]),
                "end_frame": int(item["end_frame"]),
                "speaker": str(item.get("speaker") or ""),
                "mask_image": face_masks[face_index],
            }
        )

    info = {
        "source_frame_count": int(frame_count),
        "source_width": int(width),
        "source_height": int(height),
        "speakers": speakers,
        "speaker_to_face": speaker_to_face,
        "segment_count": len(segments),
        "frame_rate": float(fps),
    }
    return segments, info


class GJJ_WanIS2VDualSpeaker:
    CATEGORY = "GJJ/🎬 视频"
    FUNCTION = "build"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "视频潜空间")
    OUTPUT_TOOLTIPS = (
        "已写入起始图、Clip Vision 和双说话人音频遮罩条件的正向 CONDITIONING。",
        "已写入起始图、Clip Vision 和静音/空遮罩条件的负向 CONDITIONING。",
        "按宽高、帧数和批次数创建的 Wan IS2V 视频 latent。",
    )
    DESCRIPTION = "零依赖单节点复刻 WanIS2VDualSpeaker：为 Wan 2.2 I2V+S2V graft 模型构建双说话人唇同步条件。"
    SEARCH_ALIASES = ["WanIS2VDualSpeaker", "Wan IS2V", "双说话人", "双人唇同步", "I2V S2V"]
    GJJ_HELP = {
        "title": "Wan IS2V 双说话人",
        "description": "复刻 ComfyUI-WanIS2V 的 WanIS2VDualSpeaker，不依赖原插件包或 comfy_api，直接生成 Wan 2.2 I2V+S2V graft 模型需要的条件和 latent；可直接连接 GJJ_UniversalTTS 的合成音频和时间轴文本。",
        "usage": [
            "连接输入图片、GJJ_UniversalTTS 的合成音频和时间轴文本；节点会用 SAM3 自动识别人脸并给说话人分配遮罩。",
            "说话人默认按时间轴首次出现顺序绑定从左到右的人脸，也可以用“说话人-人脸映射”指定：张三=左1、李四=右1。",
            "合成音频会按时间轴切段后编码成 Wan S2V 音频条件，每段只注入对应说话人的人脸遮罩区域。",
            "遮罩过渡帧用于两个说话区域的淡入淡出，音频注入强度会写入 audio_inject_scale。",
        ],
        "notice": "本节点面向 *_s2v.safetensors 这类 I2V+S2V graft 检查点，不是普通 WanImageToVideo 条件节点。",
    }

    @classmethod
    def INPUT_TYPES(cls):
        available = _checkpoint_list()
        default_model = _pick_default_checkpoint()
        clip_vision_models, clip_vision_default = _choices_with_default(
            "clip_vision", ["clip_vision"], DEFAULT_CLIP_VISION_NAME
        )
        audio_encoder_models, audio_encoder_default = _choices_with_default(
            "audio_encoders", ["wav2vec2"], DEFAULT_AUDIO_ENCODER_NAME
        )
        return {
            "required": {
                "clip_vision_name": (clip_vision_models, {"default": clip_vision_default, "display_name": "视觉编码器", "tooltip": "从 models/clip_vision 搜索 clip_vision，节点内部加载并编码输入图片。"}),
                "audio_encoder_name": (audio_encoder_models, {"default": audio_encoder_default, "display_name": "音频编码器", "tooltip": "从 models/audio_encoders 搜索 wav2vec2，节点内部把合成音频编码为 Wan S2V 音频条件。"}),
                "checkpoint": (available or [DEFAULT_CHECKPOINT], {"default": default_model, "display_name": "SAM3.1模型", "tooltip": "用于从输入图片检测/分割说话人人脸。"}),
                "positive": ("CONDITIONING", {"display_name": "正向条件", "tooltip": "上游文本编码得到的正向 CONDITIONING。"}),
                "negative": ("CONDITIONING", {"display_name": "负向条件", "tooltip": "上游文本编码得到的负向 CONDITIONING。"}),
                "vae": ("VAE", {"display_name": "VAE", "tooltip": "用于编码起始图的 VAE；通常使用对应 Wan I2V/S2V 工作流里的 VAE。"}),
                "input_image": ("GJJ_BATCH_IMAGE,IMAGE", {"display_name": "输入图片", "tooltip": "作为 I2V 起始图，同时用于 SAM3 自动识别说话人人脸遮罩。"}),
                "audio": ("AUDIO", {"display_name": "合成音频", "tooltip": "连接 GJJ_UniversalTTS 的“合成音频”。"}),
                "timeline_text": ("STRING", {"default": "", "multiline": True, "forceInput": True, "display_name": "时间轴文本", "tooltip": "连接 GJJ_UniversalTTS 的“时间轴文本”；支持 SRT/VTT/LRC/JSON。"}),
                "width": ("INT", {"default": 832, "min": 16, "max": 8192, "step": 16, "display_name": "宽度", "tooltip": "生成视频宽度，建议为 16 的倍数。"}),
                "height": ("INT", {"default": 480, "min": 16, "max": 8192, "step": 16, "display_name": "高度", "tooltip": "生成视频高度，建议为 16 的倍数。"}),
                "length": ("INT", {"default": 81, "min": 1, "max": 8192, "step": 4, "display_name": "帧数", "tooltip": "生成视频总帧数；Wan 视频 latent 会按 4 帧时间压缩创建。"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096, "step": 1, "display_name": "批次数", "tooltip": "一次生成的 latent 批次数。"}),
                "mask_crossfade_frames": ("INT", {"default": 4, "min": 0, "max": 64, "step": 1, "display_name": "遮罩过渡帧", "tooltip": "说话人遮罩在开始和结束处的淡入淡出帧数；0 表示硬切换。"}),
                "audio_inject_scale": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01, "display_name": "音频注入强度", "tooltip": "写入 conditioning 的 audio_inject_scale，控制 S2V 音频注入强度。"}),
                "sam3_text_prompt": ("STRING", {"default": "face", "multiline": False, "display_name": "SAM3目标关键词", "tooltip": "SAM3.1 Multiplex 跟踪目标关键词。默认 face；可改为 head、person 等英文目标。"}),
                "detection_threshold": ("STRING", {"default": "0.5", "multiline": False, "display_name": "检测阈值"}),
                "max_faces": ("INT", {"default": 8, "min": 1, "max": MAX_FACE_OUTPUTS, "step": 1, "display_name": "最大人脸数"}),
                "detect_interval": ("INT", {"default": 1, "min": 1, "max": 999, "step": 1, "display_name": "检测间隔"}),
                "speaker_face_map": ("STRING", {"default": "", "multiline": False, "display_name": "说话人-人脸映射", "tooltip": "可写 张三=左1，或 左1:张三、右1:李四。留空时按说话人首次出现顺序绑定从左到右的人脸。"}),
                "timeline_default_duration": ("STRING", {"default": "2.0", "multiline": False, "display_name": "LRC默认时长"}),
                "frame_rate": ("STRING", {"default": "16", "multiline": False, "display_name": "帧率", "tooltip": "时间轴秒数换算为帧号时使用的帧率；默认 16。"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def build(
        self,
        clip_vision_name,
        audio_encoder_name,
        checkpoint,
        positive,
        negative,
        vae,
        input_image,
        audio,
        timeline_text,
        width,
        height,
        length,
        batch_size,
        mask_crossfade_frames=4,
        audio_inject_scale=1.0,
        sam3_text_prompt="face",
        detection_threshold="0.5",
        max_faces=8,
        detect_interval=1,
        speaker_face_map="",
        timeline_default_duration="2.0",
        frame_rate="16",
        unique_id=None,
    ):
        audio = _first_audio(audio)
        if audio is None:
            raise RuntimeError("请连接 GJJ_UniversalTTS 的合成音频。")
        images = _extract_images(input_image)
        if images is None or int(images.shape[0]) <= 0:
            raise RuntimeError("请连接输入图片：需要 GJJ_BATCH_IMAGE 或 IMAGE。")

        width = int(width)
        height = int(height)
        length = int(length)
        batch_size = int(batch_size)

        positive, negative, latent = _apply_i2v_start_image(positive, negative, vae, width, height, length, batch_size, images)

        clip_vision = _load_named_clip_vision(clip_vision_name)
        clip_vision_output = _encode_clip_vision_output(clip_vision, images[:1])
        positive = _conditioning_set_values(positive, {"clip_vision_output": clip_vision_output})
        negative = _conditioning_set_values(negative, {"clip_vision_output": clip_vision_output})

        audio_encoder = _load_named_audio_encoder(audio_encoder_name)

        speaker_segments, _info = _build_speaker_masks_from_image(
            images,
            timeline_text,
            checkpoint,
            detection_threshold,
            int(max_faces),
            int(detect_interval),
            speaker_face_map,
            timeline_default_duration,
            frame_rate,
            sam3_text_prompt,
            length,
            unique_id=unique_id,
        )
        segments = []
        for item in speaker_segments:
            segment_audio = _crop_audio_by_seconds(audio, float(item["start"]), float(item["end"]))
            audio_encoder_output = _ensure_audio_encoder_output(_encode_audio_encoder_output_compat(audio_encoder, segment_audio))
            segments.append(
                {
                    "audio_encoder_output": audio_encoder_output,
                    "start_frame": int(item["start_frame"]),
                    "mask_image": item["mask_image"],
                }
            )
        positive, negative = _apply_timeline_masked_audio(
            positive,
            negative,
            width,
            height,
            length,
            segments,
            int(mask_crossfade_frames),
            float(audio_inject_scale),
        )

        return (positive, negative, {"samples": latent})


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanIS2VDualSpeaker}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎭 Wan IS2V 双说话人"}
