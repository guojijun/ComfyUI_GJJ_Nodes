"""Flux2 Klein 工作流 - 严格按照 Flux2-klein扩图.json 工作流实现。"""

import torch
from nodes import (
    ImagePadForOutpaint,
    JoinImageWithAlpha,
    ImageCompositeMasked,
    FluxKontextImageScale,
    VAEEncode,
    CLIPTextEncode,
    ReferenceLatent,
    KSampler,
    VAEDecode,
)

def conditioning_zero_out(conditioning):
    """ConditioningZeroOut - 将条件归零。"""
    result = []
    for t in conditioning:
        cond = torch.zeros_like(t[0])
        extra = t[1].copy()
        result.append([cond, extra])
    return result

def apply_reference_latent(conditioning, latent):
    """Apply ReferenceLatent - 将latent添加到conditioning。"""
    result = []
    for t in conditioning:
        cond = t[0]
        extra = t[1].copy()
        if isinstance(latent, dict) and "samples" in latent:
            extra["concat_latent_image"] = latent["samples"]
        elif isinstance(latent, torch.Tensor):
            extra["concat_latent_image"] = latent
        result.append([cond, extra])
    return result

def execute_flux2_workflow(
    model,
    vae,
    clip,
    padded_image: torch.Tensor,
    pad_amounts: dict[str, int],
    seed: int,
) -> torch.Tensor:
    """Flux2 Klein 工作流。
    
    工作流节点顺序：
    1. ImagePadForOutpaint - feathering=100
    2. EmptyImage -> JoinImageWithAlpha -> ImageCompositeMasked
    3. FluxKontextImageScale - 缩放图像
    4. VAEEncode - 编码
    5. CLIPTextEncode - 提示词编码
    6. ReferenceLatent - 结合conditioning和latent
    7. ConditioningZeroOut - negative归零
    8. KSampler - steps=6, cfg=1, euler, simple
    9. VAEDecode - 解码输出
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
    # 步骤1: ImagePadForOutpaint - feathering=100
    # ================================================
    feathering = 100
    try:
        padded_out, mask_out = ImagePadForOutpaint().expand_image(
            padded_image, left, top, right, bottom, feathering
        )
        padded_image = padded_out
        raw_mask = mask_out
        print(f"[Flux2] ImagePadForOutpaint: feathering={feathering}")
    except Exception as e:
        raise RuntimeError(f"ImagePadForOutpaint 失败: {e}")

    # ================================================
    # 步骤2: EmptyImage -> JoinImageWithAlpha -> ImageCompositeMasked
    # ================================================
    batch, img_h, img_w, _ = padded_image.shape
    empty_image = torch.ones_like(padded_image)

    try:
        from nodes import JoinImageWithAlpha
        join_node = JoinImageWithAlpha()
        joined_image = join_node.join(empty_image, raw_mask)
        joined_image = joined_image[0] if isinstance(joined_image, tuple) else joined_image
        print(f"[Flux2] JoinImageWithAlpha 完成")
    except Exception as e:
        alpha_channel = raw_mask.unsqueeze(-1).expand_as(empty_image)
        joined_image = torch.where(alpha_channel > 0.5, empty_image, empty_image * 0.5)
        print(f"[Flux2] JoinImageWithAlpha 降级: {e}")

    try:
        from nodes import ImageCompositeMasked
        composite_node = ImageCompositeMasked()
        composite_image = composite_node.composite(
            padded_image,       # destination
            joined_image,       # source
            raw_mask,           # mask
            0,                  # x
            0,                  # y
            False               # resize_source
        )
        composite_image = composite_image[0] if isinstance(composite_image, tuple) else composite_image
        print(f"[Flux2] ImageCompositeMasked 完成")
    except Exception as e:
        mask_expanded = raw_mask.unsqueeze(-1).expand_as(padded_image)
        composite_image = torch.where(mask_expanded > 0.5, joined_image, padded_image)
        print(f"[Flux2] ImageCompositeMasked 降级: {e}")

    # ================================================
    # 步骤3: FluxKontextImageScale
    # ================================================
    try:
        from nodes import FluxKontextImageScale
        scale_node = FluxKontextImageScale()
        scaled_image = scale_node.scale(composite_image)
        scaled_image = scaled_image[0] if isinstance(scaled_image, tuple) else scaled_image
        print(f"[Flux2] FluxKontextImageScale 完成")
    except Exception as e:
        scaled_image = composite_image
        print(f"[Flux2] FluxKontextImageScale 降级: {e}")

    # ================================================
    # 步骤4: VAEEncode
    # ================================================
    encoder = VAEEncode()
    x_tuple = encoder.encode(vae, scaled_image)
    x = x_tuple[0] if isinstance(x_tuple, tuple) else x_tuple
    print(f"[Flux2] VAEEncode 完成")

    # ================================================
    # 步骤5: CLIPTextEncode
    # ================================================
    pos_prompt = "移除蓝色区域，同时保持图像的其余部分不变"
    neg_prompt = ""

    clip_encoder = CLIPTextEncode()
    positive = clip_encoder.encode(clip, pos_prompt)[0]
    negative = clip_encoder.encode(clip, neg_prompt)[0]
    print(f"[Flux2] CLIPTextEncode 完成")

    # ================================================
    # 步骤6: ReferenceLatent
    # ================================================
    try:
        from nodes import ReferenceLatent
        ref_node = ReferenceLatent()
        positive = ref_node.reference(positive, x)
        positive = positive[0] if isinstance(positive, tuple) else positive
        print(f"[Flux2] ReferenceLatent 完成")
    except Exception as e:
        positive = apply_reference_latent(positive, x)
        print(f"[Flux2] ReferenceLatent 降级: {e}")

    # ================================================
    # 步骤7: ConditioningZeroOut
    # ================================================
    negative = conditioning_zero_out(negative)
    print(f"[Flux2] ConditioningZeroOut 完成")

    # ================================================
    # 步骤8: KSampler - steps=6, cfg=1, euler, simple
    # ================================================
    sampler = KSampler()
    sampler_result = sampler.sample(
        model, seed, 6, 1.0, "euler", "simple",
        positive, negative, x, denoise=1.0,
    )
    sampled = sampler_result[0] if isinstance(sampler_result, tuple) else sampler_result
    print(f"[Flux2] KSampler 完成: steps=6, cfg=1")

    # ================================================
    # 步骤9: VAEDecode
    # ================================================
    decoder = VAEDecode()
    decoded_tuple = decoder.decode(vae, sampled)
    decoded = decoded_tuple[0] if isinstance(decoded_tuple, tuple) else decoded_tuple
    print(f"[Flux2] VAEDecode 完成")

    return decoded
