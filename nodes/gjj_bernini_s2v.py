from __future__ import annotations

import inspect
import logging
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
    _encode_context_latent,
    _has_value,
    _ref_optional_input,
    _reference_index,
)
from .gjj_bernini_runtime_patch import apply_gjj_bernini_patches


log = logging.getLogger("GJJ-Bernini-S2V")
NODE_NAME = "GJJ_BerniniS2VConditioning"
_PATCHED_S2V = False


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
    return _encode_context_latent(vae, image).detach().to(device=torch.device("cpu")).contiguous()


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


def apply_gjj_wan_s2v_bernini_patch() -> bool:
    global _PATCHED_S2V
    try:
        apply_gjj_bernini_patches()
    except Exception as exc:
        log.warning("GJJ Bernini S2V: shared context_latents bridge patch failed: %s", exc)

    if _PATCHED_S2V:
        return True
    if _core_s2v_has_context():
        _PATCHED_S2V = True
        log.info("GJJ Bernini S2V: ComfyUI core already supports context_latents.")
        return True

    try:
        from comfy.ldm.wan.model import WanModel_S2V, sinusoidal_embedding_1d
    except Exception as exc:
        log.warning("GJJ Bernini S2V: WanModel_S2V runtime patch skipped: %s", exc)
        return False

    if getattr(WanModel_S2V.forward_orig, "__gjj_bernini_s2v_patch__", False):
        _PATCHED_S2V = True
        return True

    original = WanModel_S2V.forward_orig

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
        transformer_options=None,
        **kwargs,
    ):
        if transformer_options is None:
            transformer_options = {}

        if audio_embed is not None:
            num_embeds = x.shape[-3] * 4
            audio_emb_global, audio_emb = self.casual_audio_encoder(audio_embed[:, :, :, :num_embeds])
        else:
            audio_emb = None
            audio_emb_global = None

        _, _, time, _, _ = x.shape
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
                x = self.audio_injector(x, i, audio_emb, audio_emb_global, seq_len)
        x = self.head(x, e)
        x = self.unpatchify(x, grid_sizes)
        return x

    forward_orig.__gjj_bernini_s2v_patch__ = True
    forward_orig.__gjj_bernini_s2v_original__ = original
    WanModel_S2V.forward_orig = forward_orig
    _PATCHED_S2V = True
    log.info("GJJ Bernini S2V: patched WanModel_S2V.forward_orig for context_latents.")
    return True


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


try:
    apply_gjj_wan_s2v_bernini_patch()
except Exception as exc:
    log.warning("GJJ Bernini S2V: runtime patch failed during import: %s", exc)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJBerniniS2VConditioning}

NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · Bernini S2V条件构建"}
