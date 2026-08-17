from __future__ import annotations

import torch
import torchaudio
import comfy.nested_tensor


NODE_NAME = "GJJ_VRGDG_MiniMaxH3AudioDrive"


def _nested_av_parts(av_latent):
    """从 AV LATENT 中分离视频 latent 与音频 latent 两部分。"""
    if not isinstance(av_latent, dict) or "samples" not in av_latent:
        raise RuntimeError("MiniMax H3 音频驱动需要输入 AV LATENT（视频+音频联合潜在空间）。")

    samples = av_latent["samples"]
    if not getattr(samples, "is_nested", False):
        raise RuntimeError(
            "MiniMax H3 音频驱动期望输入联合视频+音频 latent，请连接 MiniMax H3 "
            "条件节点的 LATENT 输出口（Reference/Image to Video 等）。"
        )

    parts = list(samples.unbind())
    if len(parts) < 2:
        raise RuntimeError("无法从 AV latent 中解析出音频部分，请确认输入来自 MiniMax H3 条件节点。")
    return parts[0], parts[1]


def _fit_audio_latent(encoded_audio, template_audio):
    """
    将编码后的音频 latent 对齐到模板音频 latent 的 batch、通道、立体声和时间维度。
    布局：[batch, channels, stereo, time]
    """
    if encoded_audio.ndim != 4 or template_audio.ndim != 4:
        raise RuntimeError(
            "MiniMax H3 音频 latent 必须使用 [batch, channels, stereo, time] 四维布局。"
        )
    if encoded_audio.shape[1:-1] != template_audio.shape[1:-1]:
        raise RuntimeError(
            "源音频编码后的通道/立体声维度与 MiniMax H3 音频 latent 不匹配："
            f"得到 {tuple(encoded_audio.shape)}，期望中间维度 {tuple(template_audio.shape[1:-1])}。"
        )

    target_batch = template_audio.shape[0]
    if encoded_audio.shape[0] == 1 and target_batch > 1:
        encoded_audio = encoded_audio.repeat(target_batch, 1, 1, 1)
    elif encoded_audio.shape[0] != target_batch:
        encoded_audio = encoded_audio[:target_batch]
        if encoded_audio.shape[0] != target_batch:
            raise RuntimeError(
                f"源音频 batch 维度 {encoded_audio.shape[0]} 无法匹配 latent batch {target_batch}。"
            )

    target_t = template_audio.shape[-1]
    current_t = encoded_audio.shape[-1]
    if current_t > target_t:
        encoded_audio = encoded_audio[..., :target_t]
    elif current_t < target_t:
        padding = encoded_audio.new_zeros((*encoded_audio.shape[:-1], target_t - current_t))
        encoded_audio = torch.cat((encoded_audio, padding), dim=-1)

    return encoded_audio.to(device=template_audio.device, dtype=template_audio.dtype)


class GJJ_VRGDG_MiniMaxH3AudioDrive:
    """
    将源音频锁定到 MiniMax H3 的联合 AV latent 中，在视频生成时保持音频不变。

    核心原理：
      1. 将 AUDIO 通过 MiniMax H3 音频 VAE 编码为音频 latent；
      2. 替换 AV latent 中原先空白的音频生成部分；
      3. 用 zero noise mask 锁住音频 latent（不去噪、不修改）；
      4. 原封不动返回原始 AUDIO 供后续视频封装（mux）使用。
    """

    CATEGORY = "GJJ/🎬 视频/条件控制"
    FUNCTION = "apply_audio_drive"
    RETURN_TYPES = ("LATENT", "AUDIO")
    RETURN_NAMES = ("音频驱动后的 AV Latent", "原始音频")
    OUTPUT_TOOLTIPS = (
        "已锁定源音频的 MiniMax H3 联合 AV latent，可直接送入采样器。",
        "未经 VAE 编解码循环的原始 AUDIO，用于最终视频封装，避免音质损失。",
    )
    DESCRIPTION = (
        "将源音频锁定到 MiniMax H3 的联合 AV latent：用音频 VAE 编码源音频并替换空白音频 latent，"
        "同时用零去噪掩码锁住音频区域，保证生成视频时音频完全不变；并原封不动返回原始 AUDIO 供 mux 使用。"
    )
    SEARCH_ALIASES = [
        "MiniMax H3 音频驱动",
        "音频锁定",
        "Audio Drive",
        "音频驱动视频",
        "音画同步",
    ]

    GJJ_HELP = {
        "title": "🎵 MiniMax H3 音频驱动",
        "description": (
            "把用户指定的源音频“钉”进 MiniMax H3 的视频+音频联合 latent，让视频生成时：\n"
            "  • 视频部分正常采样；\n"
            "  • 音频部分完全不动，保持源音频原样；\n"
            "  • 最终 mux 时使用未经过 VAE 编解码循环的原始波形，避免音质劣化。"
        ),
        "用法步骤": [
            "① 在 MiniMax H3 条件节点（Image/Reference to Video）后连接本节点。",
            "② 将希望保留的 AUDIO 同时连接到：条件节点的 ref_audio_0 口 + 本节点的源音频口。",
            "③ 在提示词中引用该音频，例如「<Audio 1>」。",
            "④ 本节点输出的 LATENT 送入采样器，输出的 AUDIO 直接送入 Video Combine 进行封装。",
        ],
        "注意事项": [
            "• 必须连接 MiniMax H3 条件节点输出的联合 AV LATENT（NESTED 结构），不能是普通 LATENT。",
            "• audio_vae 必须使用配套的 MiniMax H3 音频 VAE，采样率通常为 32000 Hz。",
            "• 源音频时长与视频时长不匹配时，节点会自动裁剪或补零到目标长度。",
            "• 最终输出请使用本节点返回的「原始音频」口进行 mux，避免 VAE 往返带来的音质损失。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "av_latent": (
                    "LATENT",
                    {
                        "display_name": "联合 AV Latent",
                        "tooltip": (
                            "MiniMax H3 条件节点（Reference to Video / Image to Video）"
                            "输出的视频+音频联合 LATENT（NESTED 结构）。"
                        ),
                    },
                ),
                "source_audio": (
                    "AUDIO",
                    {
                        "display_name": "源音频",
                        "tooltip": (
                            "希望驱动视频并在最终成片中保持不变的 AUDIO。"
                            "请同时连接到 MiniMax H3 条件节点的 ref_audio_0，并在提示词中使用 <Audio 1>。"
                        ),
                    },
                ),
                "audio_vae": (
                    "VAE",
                    {
                        "display_name": "MiniMax H3 音频 VAE",
                        "tooltip": (
                            "MiniMax H3 配套的音频 VAE，用于把源音频编码进 AV latent 的音频部分。"
                            "通常采样率为 32000 Hz。"
                        ),
                    },
                ),
            }
        }

    def apply_audio_drive(self, av_latent, source_audio, audio_vae,
                          unique_id=None, extra_pnginfo=None, **kwargs):
        # 校验 AUDIO 输入
        if not isinstance(source_audio, dict):
            raise RuntimeError("请连接有效的 AUDIO 到「源音频」输入口。")
        waveform = source_audio.get("waveform")
        sample_rate = source_audio.get("sample_rate")
        if waveform is None or sample_rate is None:
            raise RuntimeError("AUDIO 输入缺少 waveform 或 sample_rate 数据，请确认输入为有效音频。")
        if waveform.ndim != 3:
            raise RuntimeError(
                f"源音频波形应为 [batch, channels, samples] 三维，实际为 {tuple(waveform.shape)}。"
            )

        # 拆分 AV latent -> 视频 latent + 音频 latent 模板
        video_latent, template_audio = _nested_av_parts(av_latent)

        # 读取音频 VAE 采样率，不一致时自动重采样
        vae_sample_rate = int(getattr(audio_vae, "audio_sample_rate", 32000))
        if int(sample_rate) != vae_sample_rate:
            waveform_for_vae = torchaudio.functional.resample(
                waveform, int(sample_rate), vae_sample_rate
            )
        else:
            waveform_for_vae = waveform

        # 用 VAE 编码源音频（只取 batch 0，后续再 repeat 对齐；最后一维通道放末尾适配 encode API）
        encoded_audio = audio_vae.encode(waveform_for_vae[:1].movedim(1, -1))
        encoded_audio = _fit_audio_latent(encoded_audio, template_audio)

        # 重建 AV latent：替换音频部分为源音频编码
        output = av_latent.copy()
        output["samples"] = comfy.nested_tensor.NestedTensor((video_latent, encoded_audio))
        # noise_mask：视频部分允许去噪（1），音频部分锁住不去噪（0）
        output["noise_mask"] = comfy.nested_tensor.NestedTensor((
            torch.ones_like(video_latent),
            torch.zeros_like(encoded_audio),
        ))

        # 注意：刻意返回原始 AUDIO 对象，避免 VAE 往返编解码造成的音质损失
        return output, source_audio


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_VRGDG_MiniMaxH3AudioDrive,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "🎵 MiniMax H3 音频驱动",
}
