from __future__ import annotations

from typing import Any

import torch


NODE_NAME = "GJJ_LTXVSetAudioRefTokens"
COMPAT_NODE_NAME = "LTXVSetAudioRefTokens"
NODE_DISPLAY_NAME = "GJJ · 🎧 LTXV音频参考Token"


def _conditioning_set_values(conditioning, values: dict[str, Any]):
    output = []
    for item in conditioning:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            output.append(item)
            continue
        metadata = dict(item[1] or {})
        metadata.update(values)
        output.append([item[0], metadata])
    return output


def _audio_samples(audio_latent: dict[str, Any]) -> torch.Tensor:
    if not isinstance(audio_latent, dict):
        raise RuntimeError("LTXV音频参考Token失败：audio_latent 必须是 LATENT 字典。")
    samples = audio_latent.get("samples")
    if not torch.is_tensor(samples):
        raise RuntimeError("LTXV音频参考Token失败：audio_latent 缺少 samples tensor。")
    if samples.ndim != 4:
        raise RuntimeError(
            f"LTXV音频参考Token失败：音频 latent 应为 [B, C, T, F] 四维 tensor，当前为 {tuple(samples.shape)}。"
        )
    return samples


def _build_ref_audio(audio_latent: dict[str, Any]) -> dict[str, torch.Tensor]:
    samples = _audio_samples(audio_latent)
    batch, channels, frames, freq = samples.shape
    tokens = samples.permute(0, 2, 1, 3).reshape(batch, frames, channels * freq).contiguous()
    return {"tokens": tokens}


def _freeze_audio_latent(audio_latent: dict[str, Any]) -> dict[str, Any]:
    samples = _audio_samples(audio_latent)
    frozen = dict(audio_latent)
    frozen["samples"] = samples.clone()
    frozen["noise_mask"] = torch.zeros_like(samples)
    frozen["type"] = frozen.get("type", "audio")
    return frozen


class GJJ_LTXVSetAudioRefTokens:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正向条件",
                        "tooltip": "输入 LTXV 正向条件，节点会写入音频参考 token。",
                    },
                ),
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "负向条件",
                        "tooltip": "输入 LTXV 负向条件，节点会写入同一份音频参考 token。",
                    },
                ),
                "audio_latent": (
                    "LATENT",
                    {
                        "display_name": "音频Latent",
                        "tooltip": "LTXV 音频 VAE 编码或分离得到的音频 latent，形状应为 [B, C, T, F]。",
                    },
                ),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "冻结音频")
    OUTPUT_TOOLTIPS = (
        "已写入 ref_audio token 的正向条件。",
        "已写入 ref_audio token 的负向条件。",
        "复制输入音频 latent，并把 noise_mask 设为 0，用于后续阶段冻结/保留音频。",
    )
    FUNCTION = "set_audio_ref_tokens"
    CATEGORY = "GJJ/视频模型/LTX"
    DESCRIPTION = "为 LTXV 音频/口型流程把 audio_latent 转成 ref_audio tokens 写入 conditioning，并输出冻结音频 latent。兼容原 LTXVSetAudioRefTokens 工作流节点名。"
    GJJ_HELP = {
        "title": "LTXV音频参考Token",
        "description": "GJJ 本地实现 LTXVSetAudioRefTokens，解决工作流提示未知包的问题。",
        "usage": [
            "输入 positive/negative 和音频 latent，输出可继续接 CFGGuider 的条件。",
            "音频 latent 会按 [B, C, T, F] 转成 [B, T, C*F] 的 ref_audio tokens。",
            "冻结音频输出会把 noise_mask 设为 0，适合二阶段流程保留上一阶段音频。",
        ],
    }

    def set_audio_ref_tokens(self, positive, negative, audio_latent):
        ref_audio = _build_ref_audio(audio_latent)
        frozen_audio = _freeze_audio_latent(audio_latent)
        positive_out = _conditioning_set_values(positive, {"ref_audio": ref_audio})
        negative_out = _conditioning_set_values(negative, {"ref_audio": ref_audio})
        return (positive_out, negative_out, frozen_audio)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_LTXVSetAudioRefTokens,
    COMPAT_NODE_NAME: GJJ_LTXVSetAudioRefTokens,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
    COMPAT_NODE_NAME: NODE_DISPLAY_NAME,
}
