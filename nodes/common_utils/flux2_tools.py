"""
Flux2 参考图工作流辅助函数

提供 Flux2 模型特有的条件编码和参考 latent 附加功能。
"""

import torch


def gjjutils_encode_text(clip, text: str):
    """
    编码文本条件

    Args:
        clip: CLIP 模型实例
        text: 提示词文本

    Returns:
        编码后的条件张量
    """
    tokens = clip.tokenize(str(text or ""))
    return clip.encode_from_tokens_scheduled(tokens)


def gjjutils_zero_out_conditioning(conditioning):
    """
    将条件归零（用于反向提示词为空时）

    Args:
        conditioning: 条件列表

    Returns:
        归零后的条件列表
    """
    result = []
    for item in conditioning:
        payload = item[1].copy()
        pooled_output = payload.get("pooled_output")
        if pooled_output is not None:
            payload["pooled_output"] = torch.zeros_like(pooled_output)
        result.append([torch.zeros_like(item[0]), payload])
    return result


def gjjutils_append_reference_latent(conditioning, reference_latent):
    """
    附加参考 latent 到条件（Flux2 参考图工作流的核心功能）

    Args:
        conditioning: 条件列表
        reference_latent: 参考图的 latent 表示

    Returns:
        附加了参考 latent 的条件列表
    """
    import node_helpers
    return node_helpers.conditioning_set_values(
        conditioning, {"reference_latents": [reference_latent]}, append=True
    )
