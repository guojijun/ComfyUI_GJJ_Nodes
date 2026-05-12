"""Flux1 Fill Dev 工作流 - 严格按照 flux_fill_dev扩图.json 工作流实现。"""

import torch
from nodes import (
    ImagePadForOutpaint,
    CLIPTextEncode,
    FluxGuidance,
    ConditioningZeroOut,
    DifferentialDiffusion,
    InpaintModelConditioning,
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

def apply_flux_guidance(conditioning, guidance_val):
    """Apply FluxGuidance。"""
    result = []
    for t in conditioning:
        cond = t[0]
        extra = t[1].copy()
        extra["guidance"] = float(guidance_val)
        result.append([cond, extra])
    return result

def apply_differential_diffusion(model, strength_val):
    """Apply DifferentialDiffusion。"""
    patched = model.clone()

    def forward(sigma, denoise_mask, extra_options, strength_val):
        inner_model = extra_options.get("model")
        step_sigmas = extra_options.get("sigmas")
        sigma_to = getattr(inner_model.inner_model, "model_sampling", None).sigma_min if hasattr(inner_model, "inner_model") and hasattr(inner_model.inner_model, "model_sampling") else 0
        if step_sigmas is not None and len(step_sigmas) > 0:
            sigma_to = step_sigmas[-1] if sigma_to == 0 else sigma_to
            sigma_from = step_sigmas[0]
        else:
            sigma_from = sigma

        if hasattr(inner_model, "inner_model") and hasattr(inner_model.inner_model, "model_sampling"):
            ts_from = inner_model.inner_model.model_sampling.timestep(sigma_from)
            ts_to = inner_model.inner_model.model_sampling.timestep(sigma_to)
            current_ts = inner_model.inner_model.model_sampling.timestep(sigma[0] if isinstance(sigma, (list, torch.Tensor)) else sigma)
            threshold = (current_ts - ts_to) / (ts_from - ts_to)
            binary_mask = (denoise_mask >= threshold).to(denoise_mask.dtype)

            if strength_val and strength_val < 1:
                return strength_val * binary_mask + (1 - strength_val) * denoise_mask
            return binary_mask
        return denoise_mask

    patched.set_model_denoise_mask_function(
        lambda *args, **kwargs: forward(*args, **kwargs, strength_val=float(strength_val))
    )
    return patched

def execute_flux1_workflow(
    model,
    vae,
    clip,
    padded_image: torch.Tensor,
    pad_amounts: dict[str, int],
    seed: int,
) -> torch.Tensor:
    """Flux1 Fill Dev 工作流。
    
    工作流节点顺序：
    1. ImagePadForOutpaint - feathering=24
    2. CLIPTextEncode - 提示词编码
    3. FluxGuidance - guidance=30
    4. ConditioningZeroOut - negative归零
    5. DifferentialDiffusion - strength=1
    6. InpaintModelConditioning - pixels, vae, mask
    7. KSampler - steps=20, cfg=1, euler, normal
    8. VAEDecode - 解码输出
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
    # 步骤1: ImagePadForOutpaint - feathering=24
    # ================================================
    feathering = 24
    try:
        padded_out, mask_out = ImagePadForOutpaint().expand_image(
            padded_image, left, top, right, bottom, feathering
        )
        padded_image = padded_out
        raw_mask = mask_out
        print(f"[Flux1] ImagePadForOutpaint: feathering={feathering}")
    except Exception as e:
        raise RuntimeError(f"ImagePadForOutpaint 失败: {e}")

    # ================================================
    # 步骤2: CLIPTextEncode - 提示词编码
    # ================================================
    pos_prompt = "Put the incomplete graph blueprint in front, let the AI fully complete all missing nodes, connections and layout strictly following the original style, keep the same visual logic, node type and arrangement rules without changing the existing content."
    neg_prompt = ""

    clip_encoder = CLIPTextEncode()
    positive = clip_encoder.encode(clip, pos_prompt)[0]
    negative = clip_encoder.encode(clip, neg_prompt)[0]
    print(f"[Flux1] CLIPTextEncode 完成")

    # ================================================
    # 步骤3: FluxGuidance - guidance=30
    # ================================================
    guidance = 30.0
    try:
        from nodes import FluxGuidance
        flux_guidance_node = FluxGuidance()
        positive = flux_guidance_node.apply(positive, guidance)[0]
        print(f"[Flux1] FluxGuidance: guidance={guidance}")
    except Exception as e:
        positive = apply_flux_guidance(positive, guidance)
        print(f"[Flux1] FluxGuidance 降级: {e}")

    # ================================================
    # 步骤4: ConditioningZeroOut - negative归零
    # ================================================
    try:
        from nodes import ConditioningZeroOut
        zero_out_node = ConditioningZeroOut()
        negative = zero_out_node.apply(negative)[0]
        print(f"[Flux1] ConditioningZeroOut 完成")
    except Exception as e:
        negative = conditioning_zero_out(negative)
        print(f"[Flux1] ConditioningZeroOut 降级: {e}")

    # ================================================
    # 步骤5: DifferentialDiffusion - strength=1
    # ================================================
    strength = 1.0
    try:
        from nodes import DifferentialDiffusion
        diff_diff_node = DifferentialDiffusion()
        model = diff_diff_node.patch(model, strength)[0]
        print(f"[Flux1] DifferentialDiffusion: strength={strength}")
    except Exception as e:
        model = apply_differential_diffusion(model, strength)
        print(f"[Flux1] DifferentialDiffusion 降级: {e}")

    # ================================================
    # 步骤6: InpaintModelConditioning
    # 参数顺序: positive, negative, pixels, vae, mask, noise_mask
    # ================================================
    try:
        from nodes import InpaintModelConditioning
        inpaint_cond = InpaintModelConditioning()
        cond_out = inpaint_cond.encode(
            positive,
            negative,
            padded_image,  # pixels
            vae,
            raw_mask,
            noise_mask=False,
        )
        final_positive = cond_out[0] if isinstance(cond_out, tuple) else cond_out
        final_negative = cond_out[1] if isinstance(cond_out, tuple) and len(cond_out) > 1 else final_positive
        latent = cond_out[2] if isinstance(cond_out, tuple) and len(cond_out) > 2 else cond_out
        print(f"[Flux1] InpaintModelConditioning 完成")
    except Exception as e:
        raise RuntimeError(f"InpaintModelConditioning 失败: {e}")

    # ================================================
    # 步骤7: KSampler - steps=20, cfg=1, euler, normal
    # ================================================
    sampler = KSampler()
    sampler_result = sampler.sample(
        model,
        seed,
        20,
        1.0,
        "euler",
        "normal",
        final_positive,
        final_negative,
        latent,
        denoise=1.0,
    )
    sampled = sampler_result[0] if isinstance(sampler_result, tuple) else sampler_result
    print(f"[Flux1] KSampler 完成: steps=20, cfg=1")

    # ================================================
    # 步骤8: VAEDecode
    # ================================================
    decoder = VAEDecode()
    decoded_tuple = decoder.decode(vae, sampled)
    decoded = decoded_tuple[0] if isinstance(decoded_tuple, tuple) else decoded_tuple
    print(f"[Flux1] VAEDecode 完成")

    return decoded
