"""SD1.5 局部重绘工作流 - 严格按照 512-inpainting-ema扩图.json 工作流实现。"""

import torch
from nodes import (
    ImagePadForOutpaint,
    VAEEncodeForInpaint,
    CLIPTextEncode,
    KSampler,
    VAEDecode,
)

def execute_sd15_workflow(
    model,
    vae,
    clip,
    expanded_img: torch.Tensor,
    pad_amounts: dict[str, int],
    seed: int,
) -> torch.Tensor:
    """SD1.5 局部重绘工作流。
    
    工作流节点顺序：
    1. ImagePadForOutpaint - feathering=10
    2. VAEEncodeForInpaint - grow_mask_by=10
    3. CLIPTextEncode - 提示词编码
    4. KSampler - steps=20, cfg=7, dpmpp_2m, karras
    5. VAEDecode - 解码输出
    """
    if vae is None:
        raise RuntimeError("VAE 模型不可用")
    if clip is None:
        raise RuntimeError("CLIP 模型不可用")

    left = pad_amounts.get("left", 0)
    right = pad_amounts.get("right", 0)
    top = pad_amounts.get("top", 0)
    bottom = pad_amounts.get("bottom", 0)

    # ================================================
    # 步骤1: ImagePadForOutpaint - feathering=10
    # ================================================
    feathering = 10
    try:
        padded_out, mask_out = ImagePadForOutpaint().expand_image(
            expanded_img, left, top, right, bottom, feathering
        )
        padded_image = padded_out
        raw_mask = mask_out
        print(f"[SD15] ImagePadForOutpaint: feathering={feathering}")
    except Exception as e:
        padded_image = expanded_img
        batch_size, img_h, img_w, _ = expanded_img.shape
        raw_mask = torch.zeros((batch_size, img_h, img_w), dtype=torch.float32, device=expanded_img.device)
        if top > 0:
            raw_mask[:, :top, :] = 1.0
        if bottom > 0:
            raw_mask[:, (img_h - bottom):, :] = 1.0
        if left > 0:
            raw_mask[:, :, :left] = 1.0
        if right > 0:
            raw_mask[:, :, (img_w - right):] = 1.0
        print(f"[SD15] ImagePadForOutpaint 降级: {e}")

    # ================================================
    # 步骤2: VAEEncodeForInpaint - grow_mask_by=10
    # ================================================
    grow_mask_by = 10
    encoder = VAEEncodeForInpaint()
    x_tuple = encoder.encode(vae, padded_image, raw_mask, grow_mask_by)
    x = x_tuple[0] if isinstance(x_tuple, tuple) else x_tuple
    print(f"[SD15] VAEEncodeForInpaint: grow_mask_by={grow_mask_by}")

    # ================================================
    # 步骤3: CLIPTextEncode - 通用扩图提示词
    # ================================================
    positive_text = "seamless continuation of the scene, natural extension, maintaining original style and color palette, photorealistic, high quality, consistent lighting, coherent composition"
    negative_text = "watermark, text, logo, artifacts, blurry, distorted, inconsistent, ugly, low quality, unnatural edges, repeating patterns"

    clip_encoder = CLIPTextEncode()
    positive = clip_encoder.encode(clip, positive_text)[0]
    negative = clip_encoder.encode(clip, negative_text)[0]
    print(f"[SD15] CLIPTextEncode 完成")

    # ================================================
    # 步骤4: KSampler - steps=20, cfg=7, dpmpp_2m, karras
    # ================================================
    sampler = KSampler()
    sampler_result = sampler.sample(
        model, seed, 20, 7.0, "dpmpp_2m", "karras",
        positive, negative, x, denoise=1.0
    )
    latent = sampler_result[0] if isinstance(sampler_result, tuple) else sampler_result
    print(f"[SD15] KSampler 完成: steps=20, cfg=7")

    # ================================================
    # 步骤5: VAEDecode
    # ================================================
    decoder = VAEDecode()
    decoded_tuple = decoder.decode(vae, latent)
    decoded = decoded_tuple[0] if isinstance(decoded_tuple, tuple) else decoded_tuple
    print(f"[SD15] VAEDecode 完成")

    return decoded
