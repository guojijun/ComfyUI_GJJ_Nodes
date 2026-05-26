from __future__ import annotations

from typing import Any

import torch

try:
    import comfy.model_management as model_management
except Exception:
    model_management = None


NODE_NAME = "GJJ_LongCatAvatarExtendEmbeds"
NODE_DISPLAY_NAME = "🐱 LongCat数字人续帧条件"


def _device():
    if model_management is not None:
        try:
            return model_management.get_torch_device()
        except Exception:
            pass
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _offload_device():
    if model_management is not None:
        try:
            return model_management.unet_offload_device()
        except Exception:
            pass
    return torch.device("cpu")


def _soft_empty_cache():
    if model_management is not None:
        try:
            model_management.soft_empty_cache()
        except Exception:
            pass


def _copy_embed_dict(audio_embeds: Any) -> dict[str, Any]:
    if not isinstance(audio_embeds, dict):
        raise RuntimeError("LongCat 数字人续帧条件需要 MULTITALK_EMBEDS 字典输入，请连接 LongCat Avatar Whisper Embeds 类节点输出。")
    return dict(audio_embeds)


def _stack_audio_features(audio_features: Any):
    if audio_features is None:
        raise RuntimeError("音频嵌入缺少 audio_features，无法为 LongCat Avatar 生成续帧条件。")
    if isinstance(audio_features, torch.Tensor):
        if audio_features.ndim == 3:
            return audio_features.unsqueeze(0)
        if audio_features.ndim == 4:
            return audio_features
        raise RuntimeError(f"audio_features 维度无效，应为 [T, 5, C] 或 [N, T, 5, C]，实际为 {tuple(audio_features.shape)}。")
    try:
        values = list(audio_features)
    except Exception as error:
        raise RuntimeError("audio_features 需要是张量或张量列表。") from error
    if not values:
        raise RuntimeError("audio_features 为空，无法切片音频条件。")
    return torch.stack(values)


def _latent_samples(latent: Any, label: str):
    if not isinstance(latent, dict) or "samples" not in latent:
        raise RuntimeError(f"{label} 需要是 LATENT，并包含 samples。")
    samples = latent["samples"]
    if not isinstance(samples, torch.Tensor) or samples.ndim != 5:
        raise RuntimeError(f"{label} 的 samples 维度应为 [B, C, T, H, W]，实际为 {getattr(samples, 'shape', None)}。")
    return samples


class GJJ_LongCatAvatarExtendEmbeds:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS", "LATENT")
    RETURN_NAMES = ("数字人条件", "采样切片")
    OUTPUT_TOOLTIPS = (
        "传给 GJJ WanVideo Sampler 的 LongCat Avatar 图像/音频续帧条件。",
        "从输入 samples 中按当前窗口裁切出的 latent；未连接 samples 时输出为空。",
    )
    DESCRIPTION = "LongCat Avatar 续帧条件节点：按当前窗口切片音频、复用上一段 latent，并可加入参考 latent 保持数字人一致性。"
    SEARCH_ALIASES = [
        "WanVideoLongCatAvatarExtendEmbeds",
        "LongCat Avatar Extend Embeds",
        "longcat avatar embeds",
        "数字人续帧",
        "LongCat续帧条件",
    ]
    GJJ_HELP = {
        "title": "LongCat 数字人续帧条件",
        "description": "克隆 WanVideoLongCatAvatarExtendEmbeds 的 GJJ 零外部插件依赖版本，用于 LongCat-Avatar 分段续帧和音频窗口切片。",
        "usage": [
            "上一段 latent 接前一段采样结果；音频嵌入接 LongCat Avatar Whisper Embeds 的 MULTITALK_EMBEDS。",
            "overlap 大于 0 时会把上一段尾部 latent 放入 extra_latents，供采样器做连续性条件。",
            "连接上一段图片和 WANVAE 时，会按 Avatar 1.5 逻辑重编码重叠帧，而不是直接切 latent。",
        ],
        "notes": [
            "本节点逻辑已内联在 GJJ，不依赖外部 ComfyUI-WanVideoWrapper 插件。",
            "输出类型保持 WANVIDIMAGE_EMBEDS，可直接连接 GJJ WanVideo Sampler v2 的图像条件输入。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prev_latents": (
                    "LATENT",
                    {
                        "display_name": "上一段latent",
                        "tooltip": "上一段完整 latent，用于续帧；overlap 会从它的尾部选择重叠条件。",
                    },
                ),
                "audio_embeds": (
                    "MULTITALK_EMBEDS",
                    {
                        "display_name": "音频嵌入",
                        "tooltip": "完整音频嵌入，通常来自 LongCat Avatar Whisper Embeds。",
                    },
                ),
                "num_frames": (
                    "INT",
                    {
                        "default": 93,
                        "min": 1,
                        "max": 256,
                        "step": 1,
                        "display_name": "本段帧数",
                        "tooltip": "本次窗口要生成的新帧数。",
                    },
                ),
                "overlap": (
                    "INT",
                    {
                        "default": 13,
                        "min": 0,
                        "max": 16,
                        "step": 1,
                        "display_name": "重叠帧数",
                        "tooltip": "从上一段尾部复用的重叠帧数；设为 0 时不追加续帧 latent 条件。",
                    },
                ),
                "frames_processed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 10000,
                        "step": 1,
                        "display_name": "已处理帧数",
                        "tooltip": "前面已经生成或处理过的帧数，用于定位本段音频窗口。",
                    },
                ),
                "if_not_enough_audio": (
                    ["pad_with_start", "mirror_from_end"],
                    {
                        "default": "pad_with_start",
                        "display_name": "音频不足策略",
                        "tooltip": "音频特征不足时的补齐方式：复制开头，或从末尾镜像补齐。",
                    },
                ),
                "ref_frame_index": (
                    "INT",
                    {
                        "default": 10,
                        "min": -1000,
                        "max": 1000,
                        "step": 1,
                        "display_name": "参考帧索引",
                        "tooltip": "0 到 24 通常更稳；负值或更大值可用于减轻重复动作。",
                    },
                ),
                "ref_mask_frame_range": (
                    "INT",
                    {
                        "default": 3,
                        "min": 0,
                        "max": 20,
                        "step": 1,
                        "display_name": "参考遮罩帧范围",
                        "tooltip": "较大范围可缓解重复动作，过大可能引入瑕疵。",
                    },
                ),
            },
            "optional": {
                "ref_latent": (
                    "LATENT",
                    {
                        "display_name": "参考latent",
                        "tooltip": "用于一致性的参考 latent，通常接初始图或第一段生成结果。",
                    },
                ),
                "samples": (
                    "LATENT",
                    {
                        "display_name": "待裁切samples",
                        "tooltip": "可选：为采样器 samples 输入裁切当前窗口的 latent。",
                    },
                ),
                "prev_images": (
                    "IMAGE",
                    {
                        "display_name": "上一段图片",
                        "tooltip": "Avatar 1.5 可选：连接后与 WANVAE 一起重编码 overlap 帧作为续帧条件。",
                    },
                ),
                "vae": (
                    "WANVAE",
                    {
                        "display_name": "Wan VAE",
                        "tooltip": "Avatar 1.5 可选：连接上一段图片时用于重编码重叠帧。",
                    },
                ),
            },
        }

    def process(
        self,
        prev_latents,
        audio_embeds,
        num_frames,
        overlap,
        frames_processed,
        if_not_enough_audio,
        ref_frame_index,
        ref_mask_frame_range,
        ref_latent=None,
        samples=None,
        prev_images=None,
        vae=None,
    ):
        num_frames = int(num_frames)
        overlap = int(overlap)
        frames_processed = int(frames_processed)
        ref_frame_index = int(ref_frame_index)
        ref_mask_frame_range = int(ref_mask_frame_range)

        if overlap > num_frames:
            raise RuntimeError("重叠帧数不能大于本段帧数。")

        new_audio_embed = _copy_embed_dict(audio_embeds)
        audio_features = _stack_audio_features(new_audio_embed.get("audio_features"))
        num_audio_features = int(audio_features.shape[1])

        required_audio_frames = frames_processed + num_frames
        if num_audio_features < required_audio_frames:
            deficit = required_audio_frames - num_audio_features
            if if_not_enough_audio == "pad_with_start":
                pad = audio_features[:, :1].repeat(1, deficit, 1, 1)
                audio_features = torch.cat([audio_features, pad], dim=1)
            elif if_not_enough_audio == "mirror_from_end":
                take = min(deficit, int(audio_features.shape[1]))
                mirrored = audio_features[:, -take:].flip(dims=[1])
                while int(mirrored.shape[1]) < deficit:
                    mirrored = torch.cat([mirrored, mirrored.flip(dims=[1])], dim=1)
                audio_features = torch.cat([audio_features, mirrored[:, :deficit]], dim=1)
            else:
                raise RuntimeError(f"未知音频不足策略：{if_not_enough_audio}")
            print(
                f"[GJJ LongCat Avatar] 音频特征不足，已按 {if_not_enough_audio} 从 "
                f"{num_audio_features} 补齐到 {audio_features.shape[1]} 帧。"
            )

        ref_target_masks = new_audio_embed.get("ref_target_masks")
        if ref_target_masks is not None:
            new_audio_embed["ref_target_masks"] = ref_target_masks[:, frames_processed : frames_processed + num_frames, :]

        prev_samples = _latent_samples(prev_latents, "上一段latent").clone()
        latent_overlap = (overlap - 1) // 4 + 1 if overlap > 0 else 0
        if overlap > 0:
            if prev_images is not None and vae is not None:
                img = prev_images[-overlap:]
                if img.shape[-1] == 4:
                    img = img[..., :3]
                device = _device()
                dtype = getattr(vae, "dtype", prev_samples.dtype)
                img = img.to(device=device, dtype=dtype) * 2.0 - 1.0
                img = img.permute(3, 0, 1, 2).unsqueeze(0).contiguous()
                try:
                    vae.to(device)
                except Exception:
                    pass
                prev_samples = vae.encode(img, device=device).to(prev_samples)
                try:
                    vae.to(_offload_device())
                except Exception:
                    pass
                _soft_empty_cache()
                print(f"[GJJ LongCat Avatar] 已重编码 {overlap} 个重叠帧，latent 形状：{tuple(prev_samples.shape)}")
            else:
                prev_samples = prev_samples[:, :, -latent_overlap:]

        ref_sample = None
        if ref_latent is not None:
            ref_samples = _latent_samples(ref_latent, "参考latent")
            ref_sample = ref_samples[0, :, :1].clone()
            print(
                f"[GJJ LongCat Avatar] 上一段 latent 形状：{tuple(prev_samples.shape)}；"
                f"使用 {latent_overlap} 个 latent 帧作为重叠条件。"
            )

        new_latent_frames = (num_frames - 1) // 4 + 1
        target_shape = (16, new_latent_frames, prev_samples.shape[-2], prev_samples.shape[-1])

        audio_stride = int(new_audio_embed.get("audio_stride", 2) or 2)
        indices = torch.arange(5, device=audio_features.device) - 2
        if frames_processed == 0:
            audio_start_idx = 0
        else:
            audio_start_idx = (frames_processed - overlap) * audio_stride
        audio_end_idx = audio_start_idx + num_frames * audio_stride
        print(f"[GJJ LongCat Avatar] 音频嵌入切片范围：{audio_start_idx} -> {audio_end_idx}")

        audio_slices = []
        device = _device()
        for human_idx in range(int(audio_features.shape[0])):
            center_indices = (
                torch.arange(audio_start_idx, audio_end_idx, audio_stride, device=audio_features.device).unsqueeze(1)
                + indices.unsqueeze(0)
            )
            center_indices = torch.clamp(center_indices, min=0, max=audio_features[human_idx].shape[0] - 1)
            audio_slices.append(audio_features[human_idx][center_indices].unsqueeze(0).to(device))
        audio_slice = torch.cat(audio_slices, dim=0)

        new_audio_embed["audio_features"] = None
        new_audio_embed["audio_emb_slice"] = audio_slice

        embeds = {
            "target_shape": target_shape,
            "num_frames": num_frames,
            "extra_latents": [{"samples": prev_samples, "index": 0}] if overlap != 0 else None,
            "multitalk_embeds": new_audio_embed,
            "longcat_avatar_options": {
                "longcat_ref_latent": ref_sample,
                "ref_frame_index": ref_frame_index,
                "ref_mask_frame_range": ref_mask_frame_range,
            },
        }

        samples_slice = None
        if samples is not None:
            source_samples = _latent_samples(samples, "待裁切samples")
            latent_start_index = (frames_processed - 1) // 4 + 1 if frames_processed > 0 else 0
            latent_end_index = latent_start_index + new_latent_frames
            samples_slice = dict(samples)
            samples_slice["samples"] = source_samples[:, :, latent_start_index:latent_end_index].clone()

        return (embeds, samples_slice)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LongCatAvatarExtendEmbeds}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
