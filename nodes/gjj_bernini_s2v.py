from __future__ import annotations

import inspect
import logging
import math
from typing import Any

import torch

import comfy.model_management
import comfy.utils

from .gjj_bernini import (
    FRAME_QUEUE_REQUIREMENT,
    MIXED_IMAGE_TYPE,
    REF_PREFIX,
    FlexibleReferenceInputs,
    _as_bhwc_tensor,
    _conditioning_set_values,
    _has_value,
    _ref_optional_input,
    _reference_index,
)


log = logging.getLogger("GJJ-Bernini-S2V")
NODE_NAME = "GJJ_BerniniS2VConditioning"
NODE_NAME_V2 = "GJJ_BerniniS2VConditioningV2"
_PATCHED_S2V = False
S2V_PATCH_VERSION = 7
ENABLE_S2V_RUNTIME_PATCH = True

WAN_AUDIO_INPUT_FPS = 50
WAN_AUDIO_VIDEO_RATE = 30
WAN_AUDIO_FPS = 16
WAN_AUDIO_SAMPLE_RATE = 16000
WAN_VAE_SCALE = 8
WAN_PATCH_SPATIAL = 2


def _resize_long_edge(image: torch.Tensor, max_size: int, stride: int = 16) -> torch.Tensor:
    h, w = int(image.shape[1]), int(image.shape[2])
    scale = min(float(max_size) / max(h, w), 1.0)
    nh = max(stride, round(h * scale / stride) * stride)
    nw = max(stride, round(w * scale / stride) * stride)
    return comfy.utils.common_upscale(image[:, :, :, :3].movedim(-1, 1), nw, nh, "area", "disabled").movedim(1, -1)


def _validate_frame_input(label: str, value: Any) -> torch.Tensor | None:
    tensor = _as_bhwc_tensor(value)
    if tensor is None and _has_value(value):
        raise RuntimeError(
            f"{label}没有解析出有效帧队列。{FRAME_QUEUE_REQUIREMENT}\n"
            "请先在上游视频加载/抽帧节点确认能输出 IMAGE 帧。"
        )
    return tensor


def _reference_images_from_kwargs(kwargs: dict[str, Any]) -> list[torch.Tensor]:
    refs: list[torch.Tensor] = []
    ref_images = kwargs.get("reference_images")
    if isinstance(ref_images, dict):
        for key in sorted(ref_images):
            tensor = _as_bhwc_tensor(ref_images.get(key))
            if tensor is not None:
                refs.extend(tensor[index : index + 1] for index in range(int(tensor.shape[0])))
    elif ref_images is not None:
        tensor = _as_bhwc_tensor(ref_images)
        if tensor is not None:
            refs.extend(tensor[index : index + 1] for index in range(int(tensor.shape[0])))

    ref_keys = sorted(
        (key for key in kwargs if _reference_index(key) is not None),
        key=lambda key: _reference_index(key) or 0,
    )
    for key in ref_keys:
        tensor = _as_bhwc_tensor(kwargs.get(key))
        if tensor is not None:
            refs.extend(tensor[index : index + 1] for index in range(int(tensor.shape[0])))
    return refs


def _encoded_cpu(vae: Any, image: torch.Tensor) -> torch.Tensor:
    return vae.encode(image)


def _build_s2v_context(
    vae: Any,
    length: int,
    width: int,
    height: int,
    source_video: Any = None,
    reference_video: Any = None,
    reference_images: list[torch.Tensor] | None = None,
    ref_max_size: int = 848,
) -> list[torch.Tensor]:
    context: list[torch.Tensor] = []

    source = _validate_frame_input("源视频帧", source_video)
    if source is not None:
        vid = comfy.utils.common_upscale(
            source[: int(length), :, :, :3].movedim(-1, 1),
            int(width),
            int(height),
            "area",
            "center",
        ).movedim(1, -1)
        context.append(_encoded_cpu(vae, vid[:, :, :, :3]))

    ref_video = _validate_frame_input("参考视频帧", reference_video)
    if ref_video is not None:
        ref_vid = _resize_long_edge(ref_video[: int(length)], int(ref_max_size))
        context.append(_encoded_cpu(vae, ref_vid[:, :, :, :3]))

    for img in reference_images or []:
        ref_img = _resize_long_edge(img, int(ref_max_size))
        context.append(_encoded_cpu(vae, ref_img[:, :, :, :3]))

    return context


def _reference_images_dict_from_kwargs(kwargs: dict[str, Any]) -> dict[str, torch.Tensor]:
    refs: dict[str, torch.Tensor] = {}
    ref_images = kwargs.get("reference_images")
    if isinstance(ref_images, dict):
        for key in sorted(ref_images):
            tensor = _as_bhwc_tensor(ref_images.get(key))
            if tensor is not None:
                refs[str(key)] = tensor
    elif ref_images is not None:
        tensor = _as_bhwc_tensor(ref_images)
        if tensor is not None:
            refs["reference_image_0"] = tensor

    ref_keys = sorted(
        (key for key in kwargs if _reference_index(key) is not None),
        key=lambda key: _reference_index(key) or 0,
    )
    for key in ref_keys:
        tensor = _as_bhwc_tensor(kwargs.get(key))
        if tensor is not None:
            refs[str(key).removeprefix("reference_images.")] = tensor
    return refs


def _build_v2_context_latents(
    vae,
    width,
    height,
    length,
    source_video=None,
    reference_video=None,
    reference_images=None,
    ref_max_size=848,
):
    context = []
    if source_video is not None:
        vid = comfy.utils.common_upscale(
            source_video[:length, :, :, :3].movedim(-1, 1), width, height, "area", "center"
        ).movedim(1, -1)
        context.append(vae.encode(vid[:, :, :, :3]))

    if reference_video is not None:
        ref_vid = _resize_long_edge(reference_video[:length], ref_max_size)
        context.append(vae.encode(ref_vid[:, :, :, :3]))

    if reference_images:
        for name in sorted(reference_images):
            imgs = reference_images[name]
            if imgs is None:
                continue
            for i in range(imgs.shape[0]):
                img = _resize_long_edge(imgs[i : i + 1], ref_max_size)
                context.append(vae.encode(img[:, :, :, :3]))
    return context


def _apply_wan_s2v_audio_conditioning(
    positive: Any,
    negative: Any,
    length: int,
    audio_encoder_output: Any = None,
    frame_offset: int = 0,
) -> tuple[Any, Any, int]:
    if audio_encoder_output is None:
        return positive, negative, frame_offset

    try:
        from comfy_extras.nodes_wan import get_audio_embed_bucket_fps, linear_interpolation
    except Exception as exc:
        raise RuntimeError("当前 ComfyUI 缺少官方 Wan S2V 音频工具，无法处理 AUDIO_ENCODER_OUTPUT。") from exc

    encoded_layers = audio_encoder_output.get("encoded_audio_all_layers") if isinstance(audio_encoder_output, dict) else None
    if not encoded_layers:
        raise RuntimeError("AUDIO_ENCODER_OUTPUT 中没有 encoded_audio_all_layers，无法生成 Wan S2V 音频条件。")

    latent_t = ((int(length) - 1) // 4) + 1
    feat = torch.cat(encoded_layers)
    feat = linear_interpolation(feat, input_fps=50, output_fps=30)
    batch_frames = latent_t * 4
    audio_embed_bucket, _ = get_audio_embed_bucket_fps(feat, fps=16, batch_frames=batch_frames, m=0, video_rate=30)
    audio_embed_bucket = audio_embed_bucket.unsqueeze(0)
    if len(audio_embed_bucket.shape) == 3:
        audio_embed_bucket = audio_embed_bucket.permute(0, 2, 1)
    elif len(audio_embed_bucket.shape) == 4:
        audio_embed_bucket = audio_embed_bucket.permute(0, 2, 3, 1)

    audio_embed_bucket = audio_embed_bucket[:, :, :, frame_offset : frame_offset + batch_frames]
    if audio_embed_bucket.shape[3] > 0:
        positive = _conditioning_set_values(positive, {"audio_embed": audio_embed_bucket})
        negative = _conditioning_set_values(negative, {"audio_embed": audio_embed_bucket * 0.0})
        frame_offset += batch_frames
    return positive, negative, frame_offset


def _audio_feat(audio_encoder_output: Any) -> torch.Tensor:
    try:
        from comfy_extras.nodes_wan import linear_interpolation
    except Exception as exc:
        raise RuntimeError("当前 ComfyUI 缺少官方 Wan S2V 音频工具，无法处理 AUDIO_ENCODER_OUTPUT。") from exc

    encoded_layers = audio_encoder_output.get("encoded_audio_all_layers") if isinstance(audio_encoder_output, dict) else None
    if not encoded_layers:
        raise RuntimeError("AUDIO_ENCODER_OUTPUT 中没有 encoded_audio_all_layers，无法生成 Wan S2V 音频条件。")
    feat = torch.cat(encoded_layers)
    return linear_interpolation(feat, input_fps=WAN_AUDIO_INPUT_FPS, output_fps=WAN_AUDIO_VIDEO_RATE)


def _audio_encoder_output_video_frames(audio_encoder_output: Any, fps: int = WAN_AUDIO_FPS) -> int:
    if isinstance(audio_encoder_output, dict):
        samples = audio_encoder_output.get("audio_samples")
        if samples is not None:
            return max(1, int(round(samples / float(WAN_AUDIO_SAMPLE_RATE) * fps)))
    feat = _audio_feat(audio_encoder_output)
    return max(1, int(round(feat.shape[1] * fps / WAN_AUDIO_VIDEO_RATE)))


def _permute_audio_embed_bucket(audio_embed_bucket: torch.Tensor) -> torch.Tensor:
    audio_embed_bucket = audio_embed_bucket.unsqueeze(0)
    if len(audio_embed_bucket.shape) == 3:
        return audio_embed_bucket.permute(0, 2, 1)
    return audio_embed_bucket.permute(0, 2, 3, 1)


def _build_timeline_audio_embed(length: int, segments: list[dict[str, Any]]) -> torch.Tensor:
    try:
        from comfy_extras.nodes_wan import get_audio_embed_bucket_fps
    except Exception as exc:
        raise RuntimeError("当前 ComfyUI 缺少官方 Wan S2V 音频工具，无法处理 AUDIO_ENCODER_OUTPUT。") from exc

    latent_t = ((int(length) - 1) // 4) + 1
    batch_frames = latent_t * 4
    total_feat_frames = int(math.ceil(batch_frames * WAN_AUDIO_VIDEO_RATE / WAN_AUDIO_FPS))

    composite = None
    cursor_auto = 0
    for segment in segments:
        feat = _audio_feat(segment["audio_encoder_output"])
        if composite is None:
            composite = torch.zeros(
                feat.shape[0],
                total_feat_frames,
                feat.shape[2],
                dtype=feat.dtype,
                device=feat.device,
            )

        start_frame = segment.get("start_frame", -1)
        if start_frame is None or start_frame < 0:
            start_frame = cursor_auto
        else:
            start_frame = int(start_frame)

        start_feat = int(round(start_frame * WAN_AUDIO_VIDEO_RATE / WAN_AUDIO_FPS))
        copy_len = min(feat.shape[1], total_feat_frames - start_feat)
        if copy_len > 0 and start_feat < total_feat_frames:
            composite[:, start_feat : start_feat + copy_len, :] = feat[:, :copy_len, :]

        cursor_auto = start_frame + _audio_encoder_output_video_frames(segment["audio_encoder_output"])

    audio_embed_bucket, _ = get_audio_embed_bucket_fps(
        composite, fps=WAN_AUDIO_FPS, batch_frames=batch_frames, m=0, video_rate=WAN_AUDIO_VIDEO_RATE
    )
    return _permute_audio_embed_bucket(audio_embed_bucket)[:, :, :, :batch_frames]


def _apply_timeline_audio_conditioning(positive: Any, negative: Any, length: int, segments: list[dict[str, Any]]):
    audio_embed_bucket = _build_timeline_audio_embed(length, segments)
    if audio_embed_bucket is None or audio_embed_bucket.shape[3] <= 0:
        return positive, negative
    positive = _conditioning_set_values(positive, {"audio_embed": audio_embed_bucket})
    negative = _conditioning_set_values(negative, {"audio_embed": audio_embed_bucket * 0.0})
    return positive, negative


def _resolve_timeline_segment_ranges(length: int, segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    batch_frames = (((int(length) - 1) // 4) + 1) * 4
    resolved: list[dict[str, Any]] = []
    cursor_auto = 0
    for segment in segments:
        start_frame = segment.get("start_frame", -1)
        if start_frame is None or start_frame < 0:
            start_frame = cursor_auto
        else:
            start_frame = int(start_frame)
        end_frame = min(batch_frames, start_frame + _audio_encoder_output_video_frames(segment["audio_encoder_output"]))
        resolved.append({**segment, "start_frame": start_frame, "end_frame": end_frame})
        cursor_auto = end_frame
    return resolved


def _padded_latent_dim(pixels: int) -> int:
    latent = int(pixels) // WAN_VAE_SCALE
    return latent + (WAN_PATCH_SPATIAL - latent % WAN_PATCH_SPATIAL) % WAN_PATCH_SPATIAL


def _token_grid_size(width: int, height: int) -> tuple[int, int]:
    return _padded_latent_dim(height) // WAN_PATCH_SPATIAL, _padded_latent_dim(width) // WAN_PATCH_SPATIAL


def _mask_to_token_grid(mask_image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    token_h, token_w = _token_grid_size(width, height)
    mask = mask_image[0] if mask_image.ndim == 3 else mask_image
    mask = mask.unsqueeze(0).unsqueeze(0)
    mask = comfy.utils.common_upscale(mask, width, height, "area", "center")
    mask = comfy.utils.common_upscale(mask, token_w, token_h, "area", "center")
    return (mask > 0.5).to(dtype=torch.float32).flatten(2).squeeze(1)


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
    n_tokens = token_h * token_w
    mask = torch.zeros(1, latent_t, n_tokens, 1)

    for segment in segments:
        tokens = _mask_to_token_grid(segment["mask_image"], width, height)
        start_frame = int(segment["start_frame"])
        end_frame = int(segment["end_frame"])
        for latent_idx in range(latent_t):
            vf0 = latent_idx * 4
            vf1 = vf0 + 4
            weight = 0.0
            for video_frame in range(vf0, vf1):
                weight = max(weight, _latent_frame_weight(video_frame, start_frame, end_frame, crossfade_frames))
            if weight > 0.0:
                mask[:, latent_idx, :, 0] = torch.maximum(mask[:, latent_idx, :, 0], tokens * weight)

    if device is not None:
        mask = mask.to(device)
    return mask


def _append_context_latents(self, x: torch.Tensor, kwargs: dict[str, Any]) -> torch.Tensor:
    context_latents = kwargs.get("context_latents", None)
    if context_latents is None:
        return x
    for lat in context_latents:
        cl = self.patch_embedding(lat.float().to(x.device)).to(x.dtype).flatten(2).transpose(1, 2)
        x = torch.cat([x, cl], dim=1)
    return x


def _core_s2v_has_context() -> bool:
    try:
        from comfy.ldm.wan.model import WanModel_S2V

        return "context_latents" in inspect.getsource(WanModel_S2V.forward_orig)
    except Exception:
        return False


def apply_gjj_wan_s2v_bernini_patch(include_shared_patch: bool = True) -> bool:
    global _PATCHED_S2V
    if not ENABLE_S2V_RUNTIME_PATCH:
        return False
    if include_shared_patch:
        try:
            from .gjj_bernini_runtime_patch import apply_gjj_bernini_patches

            apply_gjj_bernini_patches()
        except Exception as exc:
            log.warning("GJJ Bernini S2V: shared context_latents bridge patch failed: %s", exc)

    try:
        from comfy.ldm.wan.model import WanModel_S2V
    except Exception as exc:
        log.warning("GJJ Bernini S2V: WanModel_S2V runtime patch skipped: %s", exc)
        return False

    forward_patched = (
        getattr(WanModel_S2V.forward_orig, "__gjj_bernini_s2v_exact_v2_patch__", False)
        and getattr(WanModel_S2V.forward_orig, "__gjj_bernini_s2v_exact_v2_patch_version__", 0) == S2V_PATCH_VERSION
    )

    try:
        source = inspect.getsource(WanModel_S2V.forward_orig)
    except (OSError, TypeError):
        source = ""
    if not forward_patched and "context_latents" in source and getattr(WanModel_S2V.forward_orig, "__wan_bernini_s2v_patch__", False):
        WanModel_S2V.forward_orig.__gjj_bernini_s2v_v2_patch__ = True
        forward_patched = True

    if not forward_patched:
        original = getattr(WanModel_S2V.forward_orig, "__gjj_bernini_s2v_original__", WanModel_S2V.forward_orig)

        def forward_orig(
            self,
            x,
            t,
            context,
            audio_embed=None,
            reference_latent=None,
            control_video=None,
            reference_motion=None,
            clip_fea=None,
            freqs=None,
            transformer_options={},
            **kwargs,
        ):
            if audio_embed is not None:
                num_embeds = x.shape[-3] * 4
                audio_emb_global, audio_emb = self.casual_audio_encoder(audio_embed[:, :, :, :num_embeds])
            else:
                audio_emb = None
                audio_emb_global = None

            bs, _, time, height, width = x.shape
            x = self.patch_embedding(x.float()).to(x.dtype)
            if control_video is not None:
                x = x + self.cond_encoder(control_video)

            if t.ndim == 1:
                t = t.unsqueeze(1).repeat(1, x.shape[2])

            grid_sizes = x.shape[2:]
            x = x.flatten(2).transpose(1, 2)
            seq_len = x.size(1)

            cond_mask_weight = comfy.model_management.cast_to(
                self.trainable_cond_mask.weight, dtype=x.dtype, device=x.device
            ).unsqueeze(1).unsqueeze(1)
            x = x + cond_mask_weight[0]
            x = _append_context_latents(self, x, kwargs)

            if reference_latent is not None:
                ref = self.patch_embedding(reference_latent.float()).to(x.dtype)
                ref = ref.flatten(2).transpose(1, 2)
                freqs_ref = self.rope_encode(
                    reference_latent.shape[-3],
                    reference_latent.shape[-2],
                    reference_latent.shape[-1],
                    t_start=max(30, time + 9),
                    device=x.device,
                    dtype=x.dtype,
                )
                ref = ref + cond_mask_weight[1]
                x = torch.cat([x, ref], dim=1)
                freqs = torch.cat([freqs, freqs_ref], dim=1)
                t = torch.cat(
                    [t, torch.zeros((t.shape[0], reference_latent.shape[-3]), device=t.device, dtype=t.dtype)],
                    dim=1,
                )

            if reference_motion is not None:
                motion_encoded, freqs_motion = self.frame_packer(reference_motion, self)
                motion_encoded = motion_encoded + cond_mask_weight[2]
                x = torch.cat([x, motion_encoded], dim=1)
                freqs = torch.cat([freqs, freqs_motion], dim=1)
                t = torch.repeat_interleave(t, 2, dim=1)
                t = torch.cat([t, torch.zeros((t.shape[0], 3), device=t.device, dtype=t.dtype)], dim=1)

            from comfy.ldm.wan.model import sinusoidal_embedding_1d

            e = self.time_embedding(sinusoidal_embedding_1d(self.freq_dim, t.flatten()).to(dtype=x[0].dtype))
            e = e.reshape(t.shape[0], -1, e.shape[-1])
            e0 = self.time_projection(e).unflatten(2, (6, self.dim))

            context = self.text_embedding(context)

            patches_replace = transformer_options.get("patches_replace", {})
            blocks_replace = patches_replace.get("dit", {})
            transformer_options["total_blocks"] = len(self.blocks)
            transformer_options["block_type"] = "double"
            for i, block in enumerate(self.blocks):
                transformer_options["block_index"] = i
                if ("double_block", i) in blocks_replace:

                    def block_wrap(args):
                        out = {}
                        out["img"] = block(
                            args["img"],
                            context=args["txt"],
                            e=args["vec"],
                            freqs=args["pe"],
                            transformer_options=args["transformer_options"],
                        )
                        return out

                    out = blocks_replace[("double_block", i)](
                        {
                            "img": x,
                            "txt": context,
                            "vec": e0,
                            "pe": freqs,
                            "transformer_options": transformer_options,
                        },
                        {"original_block": block_wrap},
                    )
                    x = out["img"]
                else:
                    x = block(x, e=e0, freqs=freqs, context=context, transformer_options=transformer_options)
                if audio_emb is not None:
                    inject_scale = kwargs.get("audio_inject_scale", 1.0)
                    if isinstance(inject_scale, torch.Tensor):
                        inject_scale = inject_scale.reshape(-1)[0].item()
                    x = self.audio_injector(
                        x,
                        i,
                        audio_emb,
                        audio_emb_global,
                        seq_len,
                        scale=inject_scale,
                        token_mask=kwargs.get("audio_inject_mask", None),
                    )
            x = self.head(x, e)
            x = self.unpatchify(x, grid_sizes)
            return x

        forward_orig.__gjj_bernini_s2v_v2_patch__ = True
        forward_orig.__gjj_bernini_s2v_exact_v2_patch__ = True
        forward_orig.__gjj_bernini_s2v_exact_v2_patch_version__ = S2V_PATCH_VERSION
        forward_orig.__gjj_bernini_s2v_patch__ = True
        forward_orig.__wan_bernini_s2v_v2_patch__ = True
        forward_orig.__wan_bernini_s2v_patch__ = True
        forward_orig.__gjj_bernini_s2v_original__ = original
        WanModel_S2V.forward_orig = forward_orig

    _patch_wan_s2v_audio_injector()
    _patch_wan_s2v_extra_conds()
    _PATCHED_S2V = True
    log.info("GJJ Bernini S2V: applied Bernini S2V V2 model patches.")
    return True


def _patch_wan_s2v_audio_injector() -> bool:
    try:
        from comfy.ldm.wan.model import AudioInjector_WAN
    except Exception as exc:
        log.warning("GJJ Bernini S2V: AudioInjector_WAN patch skipped: %s", exc)
        return False

    if (
        getattr(AudioInjector_WAN.forward, "__gjj_bernini_s2v_exact_v2_masked_patch__", False)
        and getattr(AudioInjector_WAN.forward, "__gjj_bernini_s2v_exact_v2_patch_version__", 0) == S2V_PATCH_VERSION
    ):
        return True

    original_forward = getattr(
        AudioInjector_WAN.forward,
        "__gjj_bernini_s2v_masked_original__",
        getattr(AudioInjector_WAN.forward, "__gjj_bernini_s2v_original__", AudioInjector_WAN.forward),
    )

    def forward(self, x, block_id, audio_emb, audio_emb_global, seq_len, scale=1.0, token_mask=None):
        if token_mask is None:
            return original_forward(self, x, block_id, audio_emb, audio_emb_global, seq_len, scale=scale)

        audio_attn_id = self.injected_block_id.get(block_id, None)
        if audio_attn_id is None:
            return x

        from einops import rearrange

        num_frames = audio_emb.shape[1]
        input_hidden_states = rearrange(x[:, :seq_len], "b (t n) c -> (b t) n c", t=num_frames)
        if self.enable_adain and self.adain_mode == "attn_norm":
            audio_emb_global = rearrange(audio_emb_global, "b t n c -> (b t) n c")
            adain_hidden_states = self.injector_adain_layers[audio_attn_id](
                input_hidden_states, temb=audio_emb_global[:, 0]
            )
            attn_hidden_states = adain_hidden_states
        else:
            attn_hidden_states = self.injector_pre_norm_feat[audio_attn_id](input_hidden_states)

        if audio_emb.dim() == 3:
            attn_audio_emb = rearrange(audio_emb, "b t c -> (b t) 1 c", t=num_frames)
        else:
            attn_audio_emb = rearrange(audio_emb, "b t n c -> (b t) n c", t=num_frames)

        residual_out = self.injector[audio_attn_id](x=attn_hidden_states, context=attn_audio_emb)
        residual_out = rearrange(residual_out, "(b t) n c -> b (t n) c", t=num_frames)

        if token_mask.ndim == 4:
            token_mask = token_mask.flatten(1, 2)
        if token_mask.shape[1] == residual_out.shape[1]:
            residual_out = residual_out * token_mask.to(device=residual_out.device, dtype=residual_out.dtype)
        else:
            log.warning(
                "GJJ Bernini S2V: mask length %s does not match token count %s; using global audio injection",
                token_mask.shape[1],
                residual_out.shape[1],
            )

        x[:, :seq_len] = x[:, :seq_len] + residual_out * scale
        return x

    forward.__gjj_bernini_s2v_v2_masked_patch__ = True
    forward.__gjj_bernini_s2v_exact_v2_masked_patch__ = True
    forward.__gjj_bernini_s2v_exact_v2_patch_version__ = S2V_PATCH_VERSION
    forward.__gjj_bernini_s2v_masked_patch__ = True
    forward.__wan_bernini_s2v_v2_masked_patch__ = True
    forward.__wan_bernini_s2v_masked_patch__ = True
    forward.__gjj_bernini_s2v_masked_original__ = original_forward
    AudioInjector_WAN.forward = forward
    return True


def _patch_wan_s2v_extra_conds() -> bool:
    try:
        import comfy.conds
        from comfy.model_base import WAN22_S2V
    except Exception as exc:
        log.warning("GJJ Bernini S2V: WAN22_S2V extra_conds patch skipped: %s", exc)
        return False

    if (
        getattr(WAN22_S2V.extra_conds, "__gjj_bernini_s2v_exact_v2_masked_patch__", False)
        and getattr(WAN22_S2V.extra_conds, "__gjj_bernini_s2v_exact_v2_patch_version__", 0) == S2V_PATCH_VERSION
    ):
        return True

    original_extra_conds = getattr(
        WAN22_S2V.extra_conds,
        "__gjj_bernini_s2v_masked_original__",
        getattr(WAN22_S2V.extra_conds, "__gjj_bernini_s2v_original__", WAN22_S2V.extra_conds),
    )

    def extra_conds(self, **kwargs):
        out = original_extra_conds(self, **kwargs)
        audio_inject_mask = kwargs.get("audio_inject_mask", None)
        if audio_inject_mask is not None:
            out["audio_inject_mask"] = comfy.conds.CONDRegular(audio_inject_mask)
        audio_inject_scale = kwargs.get("audio_inject_scale", None)
        if audio_inject_scale is not None:
            out["audio_inject_scale"] = comfy.conds.CONDRegular(torch.FloatTensor([audio_inject_scale]))
        return out

    extra_conds.__gjj_bernini_s2v_v2_masked_patch__ = True
    extra_conds.__gjj_bernini_s2v_exact_v2_masked_patch__ = True
    extra_conds.__gjj_bernini_s2v_exact_v2_patch_version__ = S2V_PATCH_VERSION
    extra_conds.__gjj_bernini_s2v_masked_patch__ = True
    extra_conds.__wan_bernini_s2v_v2_masked_patch__ = True
    extra_conds.__wan_bernini_s2v_masked_patch__ = True
    extra_conds.__gjj_bernini_s2v_masked_original__ = original_extra_conds
    WAN22_S2V.extra_conds = extra_conds

    original_resize = getattr(
        WAN22_S2V.resize_cond_for_context_window,
        "__gjj_bernini_s2v_masked_original__",
        getattr(WAN22_S2V.resize_cond_for_context_window, "__gjj_bernini_s2v_original__", WAN22_S2V.resize_cond_for_context_window),
    )

    def resize_cond_for_context_window(self, cond_key, cond_value, window, x_in, device, retain_index_list=[]):
        if cond_key == "audio_inject_mask":
            mask = cond_value.cond
            if mask.ndim == 4 and mask.shape[1] == x_in.shape[2]:
                return cond_value._copy_with(window.get_tensor(mask, device, dim=1))
        return original_resize(self, cond_key, cond_value, window, x_in, device, retain_index_list=retain_index_list)

    resize_cond_for_context_window.__gjj_bernini_s2v_v2_masked_patch__ = True
    resize_cond_for_context_window.__gjj_bernini_s2v_exact_v2_masked_patch__ = True
    resize_cond_for_context_window.__gjj_bernini_s2v_exact_v2_patch_version__ = S2V_PATCH_VERSION
    resize_cond_for_context_window.__gjj_bernini_s2v_masked_patch__ = True
    resize_cond_for_context_window.__wan_bernini_s2v_v2_masked_patch__ = True
    resize_cond_for_context_window.__wan_bernini_s2v_masked_patch__ = True
    resize_cond_for_context_window.__gjj_bernini_s2v_masked_original__ = original_resize
    WAN22_S2V.resize_cond_for_context_window = resize_cond_for_context_window

    return True


def _restore_gjj_wan_s2v_bernini_patch() -> bool:
    restored = False
    try:
        from comfy.ldm.wan.model import AudioInjector_WAN, WanModel_S2V

        original_forward_orig = getattr(WanModel_S2V.forward_orig, "__gjj_bernini_s2v_original__", None)
        if original_forward_orig is not None:
            WanModel_S2V.forward_orig = original_forward_orig
            restored = True

        original_audio_forward = getattr(AudioInjector_WAN.forward, "__gjj_bernini_s2v_original__", None)
        if original_audio_forward is not None:
            AudioInjector_WAN.forward = original_audio_forward
            restored = True
    except Exception as exc:
        log.warning("GJJ Bernini S2V: restore Wan S2V runtime patch skipped: %s", exc)

    try:
        from comfy.model_base import WAN22_S2V

        original_extra_conds = getattr(WAN22_S2V.extra_conds, "__gjj_bernini_s2v_original__", None)
        if original_extra_conds is not None:
            WAN22_S2V.extra_conds = original_extra_conds
            restored = True

        original_resize = getattr(WAN22_S2V.resize_cond_for_context_window, "__gjj_bernini_s2v_original__", None)
        if original_resize is not None:
            WAN22_S2V.resize_cond_for_context_window = original_resize
            restored = True
    except Exception as exc:
        log.warning("GJJ Bernini S2V: restore WAN22_S2V runtime patch skipped: %s", exc)

    if restored:
        global _PATCHED_S2V
        _PATCHED_S2V = False
        log.info("GJJ Bernini S2V: restored previous GJJ Wan S2V runtime patch.")
    return restored


class GJJBerniniS2VConditioning:
    CATEGORY = "GJJ/视频"
    FUNCTION = "build"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "latent")
    OUTPUT_TOOLTIPS = (
        "已附加 Wan S2V 音频和 Bernini 上下文 latent 的正向条件。",
        "已附加静音音频负向条件和同一 Bernini 上下文 latent 的负向条件。",
        "按帧数、宽高和批次数创建的 Wan S2V latent。",
    )
    DESCRIPTION = "零依赖复刻 Wan Bernini S2V Conditioning：把音频编码输出和 Bernini 上下文 latent 写入 CONDITIONING。"
    GJJ_HELP = (
        "使用说明：\n"
        "- 复刻 ComfyUI-WanBerniniS2V 的 BerniniS2VConditioning，不依赖 comfy_api / typing_extensions / 原插件包。\n"
        "- 可选 AUDIO_ENCODER_OUTPUT 会转换为 Wan S2V audio_embed，正向使用原音频，负向使用静音音频。\n"
        "- 源视频帧会缩放到输出宽高；参考视频和参考图片按最长边限制缩放，与原插件行为一致。\n"
        "- 节点导入时会尝试给 ComfyUI 的 WanModel_S2V 打 context_latents 补丁；若核心已支持则自动跳过。"
    )
    SEARCH_ALIASES = ["bernini s2v", "WanBerniniS2V", "S2V条件", "音频驱动视频", "参考视频条件"]

    @classmethod
    def INPUT_TYPES(cls):
        optional = FlexibleReferenceInputs(
            {
                "audio_encoder_output": (
                    "AUDIO_ENCODER_OUTPUT",
                    {"display_name": "音频编码输出", "tooltip": "可选。连接官方 AudioEncoderLoader/音频编码节点输出。"},
                ),
                "source_video": (
                    MIXED_IMAGE_TYPE,
                    {"display_name": "源视频帧", "tooltip": f"可选。会缩放到目标宽高。{FRAME_QUEUE_REQUIREMENT}"},
                ),
                "reference_video": (
                    MIXED_IMAGE_TYPE,
                    {"display_name": "参考视频帧", "tooltip": f"可选。会按参考最长边缩放。{FRAME_QUEUE_REQUIREMENT}"},
                ),
                f"{REF_PREFIX}0": _ref_optional_input(0),
            }
        )
        return {
            "required": {
                "positive": ("CONDITIONING", {"display_name": "正向条件"}),
                "negative": ("CONDITIONING", {"display_name": "负向条件"}),
                "vae": ("WANVAE,VAE", {"display_name": "VAE / WANVAE"}),
                "width": ("INT", {"default": 832, "min": 16, "max": 8192, "step": 16, "display_name": "宽度"}),
                "height": ("INT", {"default": 480, "min": 16, "max": 8192, "step": 16, "display_name": "高度"}),
                "length": ("INT", {"default": 81, "min": 1, "max": 8192, "step": 4, "display_name": "帧数"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096, "step": 1, "display_name": "批次数"}),
                "ref_max_size": (
                    "INT",
                    {"default": 848, "min": 16, "max": 8192, "step": 16, "display_name": "参考最长边"},
                ),
            },
            "optional": optional,
        }

    def build(
        self,
        positive,
        negative,
        vae,
        width,
        height,
        length,
        batch_size,
        ref_max_size=848,
        audio_encoder_output=None,
        source_video=None,
        reference_video=None,
        **kwargs,
    ):
        apply_gjj_wan_s2v_bernini_patch()

        width = int(width)
        height = int(height)
        length = int(length)
        positive, negative, _ = _apply_wan_s2v_audio_conditioning(
            positive, negative, length, audio_encoder_output=audio_encoder_output
        )

        latent = torch.zeros(
            [int(batch_size), 16, ((length - 1) // 4) + 1, height // 8, width // 8],
            device=comfy.model_management.intermediate_device(),
        )

        reference_images = _reference_images_from_kwargs(kwargs)
        if any(_has_value(value) for key, value in kwargs.items() if _reference_index(key) is not None) and not reference_images:
            raise RuntimeError(f"参考图输入没有解析出有效图片。{FRAME_QUEUE_REQUIREMENT}")

        context = _build_s2v_context(
            vae,
            length,
            width,
            height,
            source_video=source_video,
            reference_video=reference_video,
            reference_images=reference_images,
            ref_max_size=int(ref_max_size),
        )
        if context:
            positive = _conditioning_set_values(positive, {"context_latents": context})
            negative = _conditioning_set_values(negative, {"context_latents": context})
            log.info("GJJ Bernini S2V: encoded %s context latent(s).", len(context))

        return (positive, negative, {"samples": latent})


class GJJBerniniS2VConditioningV2:
    CATEGORY = "GJJ/视频"
    FUNCTION = "build"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "latent")
    OUTPUT_TOOLTIPS = (
        "已附加 Wan S2V 时间线音频、音频注入遮罩和 Bernini 上下文 latent 的正向条件。",
        "已附加静音音频、空音频注入遮罩和同一 Bernini 上下文 latent 的负向条件。",
        "按帧数、宽高和批次数创建的 Wan S2V latent。",
    )
    DESCRIPTION = "Bernini in-context conditioning with masked S2V audio for one or two speakers. Requires a Wan 2.2 S2V grafted Bernini-R model."
    GJJ_HELP = (
        "使用说明：\n"
        "- 零依赖单节点复刻 ComfyUI-WanBerniniS2V_v2 的 BerniniS2VConditioningV2。\n"
        "- audio_1 和 mask_1 必填；audio_2 可选，连接 audio_2 时必须连接 mask_2。\n"
        "- mask 白色区域表示对应说话人的唇同步区域；reference_image_0 对应提示词里的 image0。"
    )
    SEARCH_ALIASES = ["BerniniS2VConditioningV2", "WanBerniniS2V V2", "S2V双音频", "说话人遮罩"]

    @classmethod
    def INPUT_TYPES(cls):
        optional = FlexibleReferenceInputs(
            {
                "audio_2": (
                    "AUDIO_ENCODER_OUTPUT",
                    {"display_name": "音频 2", "tooltip": "可选。第二个说话人或第二段音频。"},
                ),
                "mask_2": ("MASK", {"display_name": "遮罩 2", "tooltip": "可选。第二段音频对应的画面区域。"}),
                "source_video": (
                    MIXED_IMAGE_TYPE,
                    {"display_name": "源视频帧", "tooltip": f"可选。会缩放到目标宽高。{FRAME_QUEUE_REQUIREMENT}"},
                ),
                "reference_video": (
                    MIXED_IMAGE_TYPE,
                    {"display_name": "参考视频帧", "tooltip": f"可选。会按参考最长边缩放。{FRAME_QUEUE_REQUIREMENT}"},
                ),
                f"{REF_PREFIX}0": _ref_optional_input(0),
            }
        )
        return {
            "required": {
                "positive": ("CONDITIONING", {"display_name": "正向条件"}),
                "negative": ("CONDITIONING", {"display_name": "负向条件"}),
                "vae": ("WANVAE,VAE", {"display_name": "VAE / WANVAE"}),
                "width": ("INT", {"default": 832, "min": 16, "max": 8192, "step": 16, "display_name": "宽度"}),
                "height": ("INT", {"default": 480, "min": 16, "max": 8192, "step": 16, "display_name": "高度"}),
                "length": ("INT", {"default": 81, "min": 1, "max": 8192, "step": 4, "display_name": "帧数"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096, "step": 1, "display_name": "批次数"}),
                "audio_1": ("AUDIO_ENCODER_OUTPUT", {"display_name": "音频 1"}),
                "mask_1": ("MASK", {"display_name": "遮罩 1"}),
                "speaker_2_start_frame": (
                    "INT",
                    {"default": -1, "min": -1, "max": 8192, "step": 1, "display_name": "音频2起始帧"},
                ),
                "ref_max_size": (
                    "INT",
                    {"default": 848, "min": 16, "max": 8192, "step": 16, "display_name": "参考最长边"},
                ),
                "mask_crossfade_frames": (
                    "INT",
                    {"default": 4, "min": 0, "max": 64, "step": 1, "display_name": "遮罩过渡帧"},
                ),
                "audio_inject_scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.01,
                        "display_name": "音频注入强度",
                    },
                ),
            },
            "optional": optional,
        }

    def build(
        self,
        positive,
        negative,
        vae,
        width,
        height,
        length,
        batch_size,
        audio_1,
        mask_1,
        audio_2=None,
        mask_2=None,
        speaker_2_start_frame=-1,
        source_video=None,
        reference_video=None,
        ref_max_size=848,
        mask_crossfade_frames=4,
        audio_inject_scale=1.0,
        **kwargs,
    ):
        apply_gjj_wan_s2v_bernini_patch(include_shared_patch=False)

        width = int(width)
        height = int(height)
        length = int(length)
        batch_size = int(batch_size)

        if audio_1 is None or mask_1 is None:
            raise RuntimeError("Bernini S2V V2 需要 audio_1 和 mask_1。")

        segments = [{"audio_encoder_output": audio_1, "start_frame": 0, "mask_image": mask_1}]
        if audio_2 is not None:
            if mask_2 is None:
                raise RuntimeError("连接 audio_2 时也需要连接 mask_2。")
            segments.append(
                {
                    "audio_encoder_output": audio_2,
                    "start_frame": int(speaker_2_start_frame),
                    "mask_image": mask_2,
                }
            )

        latent = torch.zeros(
            [batch_size, 16, ((length - 1) // 4) + 1, height // 8, width // 8],
            device=comfy.model_management.intermediate_device(),
        )

        reference_images = _reference_images_from_kwargs(kwargs)
        if any(_has_value(value) for key, value in kwargs.items() if _reference_index(key) is not None) and not reference_images:
            raise RuntimeError(f"参考图输入没有解析出有效图片。{FRAME_QUEUE_REQUIREMENT}")

        context = _build_s2v_context(
            vae,
            length,
            width,
            height,
            source_video=source_video,
            reference_video=reference_video,
            reference_images=reference_images,
            ref_max_size=int(ref_max_size),
        )
        if context:
            positive = _conditioning_set_values(positive, {"context_latents": context})
            negative = _conditioning_set_values(negative, {"context_latents": context})
            log.info("GJJ Bernini S2V V2: encoded %s context latent(s).", len(context))

        positive, negative = _apply_timeline_audio_conditioning(positive, negative, length, segments)
        resolved_segments = _resolve_timeline_segment_ranges(length, segments)
        cond_values = {
            "audio_inject_scale": audio_inject_scale,
            "audio_inject_mask": _build_timeline_audio_inject_mask(
                width,
                height,
                length,
                resolved_segments,
                crossfade_frames=mask_crossfade_frames,
                device=comfy.model_management.intermediate_device(),
            ),
        }
        positive = _conditioning_set_values(positive, cond_values)
        negative_values = dict(cond_values)
        negative_values["audio_inject_mask"] = negative_values["audio_inject_mask"] * 0.0
        negative = _conditioning_set_values(negative, negative_values)

        return (positive, negative, {"samples": latent})


if not ENABLE_S2V_RUNTIME_PATCH:
    _restore_gjj_wan_s2v_bernini_patch()
else:
    try:
        apply_gjj_wan_s2v_bernini_patch(include_shared_patch=False)
    except Exception as exc:
        log.warning("GJJ Bernini S2V: V2 model patch failed during import: %s", exc)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJBerniniS2VConditioning, NODE_NAME_V2: GJJBerniniS2VConditioningV2}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "GJJ · Bernini S2V条件构建",
    NODE_NAME_V2: "GJJ · Bernini S2V条件构建V2",
}
