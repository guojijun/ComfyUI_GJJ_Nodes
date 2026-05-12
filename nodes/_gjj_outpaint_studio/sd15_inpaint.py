"""
SD1.5 局部重绘工作流 - 严格按照工作流 JSON 实现。

参考工作流: D:\\AI\\MOD\\user\\default\\workflows\\扩图\\512-inpainting-ema扩图.json

工作流节点链：
    1. LoadImage → ImagePadForOutpaint → VAEEncodeForInpaint → KSampler ← CLIPTextEncode(+/-) → VAEDecode

关键差异（与之前错误实现的对比）：
    - 必须使用 VAEEncodeForInpaint（不是 VAEEncode），需要传入 mask 和 grow_mask_by
    - CLIPTextEncode.encode() 返回 tuple，需要解包后才能传给 KSampler
"""

from __future__ import annotations

import torch
import comfy.model_management
from nodes import (
    ImagePadForOutpaint,
    VAEEncodeForInpaint,
    KSampler,
    VAEDecode,
    CLIPTextEncode,
)


from .utils import _send_status


def execute_sd15_workflow(
    model,
    vae,
    clip,
    expanded_img: torch.Tensor,
    pad_amounts: dict[str, int],
    seed: int,
    config: dict = None,
) -> torch.Tensor:
    """
    执行 SD1.5 局部重绘工作流。

    Args:
        model: SD1.5 inpainting 模型
        vae: VAE 模型
        clip: CLIP 模型
        expanded_img: 输入图像 [B, H, W, C]
        pad_amounts: dict with keys "left", "right", "top", "bottom"
        seed: 随机种子
        config: 统一参数包 (steps, cfg, sampler_name, scheduler, mask_expand, unique_id)
    """
    config = config or {}
    steps = config.get("steps", 20)
    cfg_val = config.get("cfg", 7.0)
    sampler_name = config.get("sampler_name", "euler")
    scheduler = config.get("scheduler", "normal")
    mask_expand = config.get("mask_expand", 10)
    unique_id = config.get("unique_id", "")
    feathering = 10  # 工作流中的羽化值

    _send_status(unique_id, "🎨 SD15 | ImagePadForOutpaint...")
    print("[SD15] ================================================")
    print(f"[SD15] 开始执行 SD15 工作流 · seed={seed}")
    print(
        f"[SD15] 参数: steps={steps}, cfg={cfg_val}, sampler={sampler_name}, scheduler={scheduler}"
    )
    print(f"[SD15] 输入图像 shape={expanded_img.shape}")
    print(f"[SD15] pad_amounts={pad_amounts}")

    # ============================================================
    # 步骤1: ImagePadForOutpaint
    #   参数: image, left, top, right, bottom, feathering
    #   返回: (新图像, mask)
    # ============================================================
    left = pad_amounts.get("left", 0)
    top = pad_amounts.get("top", 0)
    right = pad_amounts.get("right", 0)
    bottom = pad_amounts.get("bottom", 0)
    # 确保输出尺寸是 8 的倍数
    _, h, w, _ = expanded_img.shape
    target_h = ((h + top + bottom + 7) // 8) * 8
    target_w = ((w + left + right + 7) // 8) * 8
    right += target_w - (w + left + right)
    bottom += target_h - (h + top + bottom)

    print(
        f"[SD15] 调用 ImagePadForOutpaint: left={left} top={top} right={right} bottom={bottom} feather={feathering}"
    )
    # 确保输出尺寸是 8 的倍数
    _, h, w, _ = expanded_img.shape
    target_h = ((h + top + bottom + 7) // 8) * 8
    target_w = ((w + left + right + 7) // 8) * 8
    right += target_w - (w + left + right)
    bottom += target_h - (h + top + bottom)

    print(
        f"[SD15] 调用 ImagePadForOutpaint: left={left} top={top} right={right} bottom={bottom} feather={feathering}"
    )
    padder = ImagePadForOutpaint()
    padded_image, out_mask = padder.expand_image(
        expanded_img, left, top, right, bottom, feathering
    )
    print(
        f"[SD15] ImagePadForOutpaint 完成: padded={padded_image.shape} mask={out_mask.shape}"
    )

    # ============================================================
    # 步骤2: VAEEncodeForInpaint
    #   参数: pixels, vae, mask, grow_mask_by
    #   返回: ({"samples": t, "noise_mask": mask_erosion}, )
    # ============================================================
    _send_status(unique_id, "🎨 SD15 | VAEEncodeForInpaint...")
    print("[SD15] 调用 VAEEncodeForInpaint ...")
    encoder = VAEEncodeForInpaint()
    latent_result = encoder.encode(
        vae, padded_image, out_mask, grow_mask_by=mask_expand
    )

    # 提取 latent dict（保持 {"samples": ..., "noise_mask": ...} 格式）
    if isinstance(latent_result, (tuple, list)):
        latent = latent_result[0]
    else:
        latent = latent_result

    print(f"[SD15] VAEEncodeForInpaint 完成: samples shape={latent['samples'].shape}")

    # ============================================================
    # 步骤3: CLIPTextEncode（正向 + 负向）
    #   返回: ([[tensor, dict], ...], )  ← 注意外面有一层 tuple
    # ============================================================
    positive_text = (
        "seamless continuation of the scene, natural extension, "
        "maintaining original style and color palette, photorealistic, "
        "high quality, consistent lighting, coherent composition"
    )
    negative_text = (
        "watermark, text, logo, artifacts, blurry, distorted, "
        "inconsistent, ugly, low quality, unnatural edges, repeating patterns"
    )

    print("[SD15] 调用 CLIPTextEncode ...")
    clip_encoder = CLIPTextEncode()

    pos_raw = clip_encoder.encode(clip, positive_text)  # ([[tensor, dict]],)
    neg_raw = clip_encoder.encode(clip, negative_text)  # ([[tensor, dict]],)

    # CLIPTextEncode 返回 tuple，取 [0] 得到 conditioning 列表
    positive = pos_raw[0] if isinstance(pos_raw, (tuple, list)) else pos_raw
    negative = neg_raw[0] if isinstance(neg_raw, (tuple, list)) else neg_raw

    print(
        f"[SD15] CLIPTextEncode 完成: positive={len(positive)}条目, negative={len(negative)}条目"
    )

    # ============================================================
    # 步骤4: KSampler - 使用 config 驱动的参数
    # ============================================================
    _send_status(unique_id, "🎨 SD15 | KSampler 采样中...")
    print(
        f"[SD15] 调用 KSampler: steps={steps}, cfg={cfg_val}, sampler={sampler_name}, scheduler={scheduler} ..."
    )
    sampler = KSampler()
    k_result = sampler.sample(
        model,
        seed,
        steps,
        cfg_val,
        sampler_name,
        scheduler,
        positive,
        negative,
        latent,  # {"samples": ..., "noise_mask": ...}
        denoise=1.0,
    )

    # KSampler 返回 ({"samples": tensor}, )
    if isinstance(k_result, (tuple, list)):
        k_latent = k_result[0]
    else:
        k_latent = k_result

    print(f"[SD15] KSampler 完成: samples shape={k_latent['samples'].shape}")

    # ============================================================
    # 步骤5: VAEDecode
    # ============================================================
    print("[SD15] 调用 VAEDecode ...")
    decoder = VAEDecode()
    dec_result = decoder.decode(vae, k_latent)  # 返回 (image_tensor,)

    if isinstance(dec_result, (tuple, list)):
        decoded = dec_result[0]
    else:
        decoded = dec_result

    print(f"[SD15] VAEDecode 完成: image shape={decoded.shape}")
    print("[SD15] ================================================")

    return decoded
