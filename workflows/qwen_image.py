"""Qwen Image Edit 工作流 - 严格按照 Qwen_image_edit扩图.json 工作流实现。"""

import torch
from nodes import (
    ConstrainImage,
    ImagePadKJ,
    VAEEncode,
    TextEncodeQwenImageEditPlus,
    CLIPTextEncode,
    ReferenceLatent,
    LoraLoaderModelOnly,
    ModelSamplingAuraFlow,
    CFGNorm,
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

def _free_vram():
    """释放显存。"""
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
    except:
        pass

def execute_qwen_workflow(
    model,
    vae,
    clip,
    padded_image: torch.Tensor,
    pad_amounts: dict[str, int],
    seed: int,
    lora_name: str = None,
) -> torch.Tensor:
    """Qwen Image Edit 工作流。
    
    工作流节点顺序：
    1. ConstrainImage - max_width=1248, max_height=1248
    2. ImagePadKJ - 颜色填充扩图
    3. VAEEncode
    4. TextEncodeQwenImageEditPlus
    5. ReferenceLatent
    6. ConditioningZeroOut
    7. LoraLoaderModelOnly
    8. ModelSamplingAuraFlow - shift=3.1
    9. CFGNorm - strength=1
    10. KSampler - steps=4, cfg=1, euler, simple
    11. VAEDecode
    """
    if vae is None:
        raise RuntimeError("VAE 模型不可用")
    if clip is None:
        raise RuntimeError("CLIP 模型不可用")

    _free_vram()

    left = pad_amounts.get("left", 0)
    right = pad_amounts.get("right", 0)
    top = pad_amounts.get("top", 0)
    bottom = pad_amounts.get("bottom", 0)

    # ================================================
    # 步骤1: ConstrainImage - max_width=1248, max_height=1248
    # ================================================
    max_size = 1248
    try:
        from nodes import ConstrainImage
        constrain_node = ConstrainImage()
        constrain_result = constrain_node.resize(padded_image, max_size, max_size, 0, 0, "no")
        constrained_image = constrain_result[0] if isinstance(constrain_result, tuple) else constrain_result
        print(f"[Qwen] ConstrainImage: max_size={max_size}")
    except Exception as e:
        constrained_image = padded_image
        print(f"[Qwen] ConstrainImage 降级: {e}")

    # ================================================
    # 步骤2: ImagePadKJ - 颜色填充扩图
    # ================================================
    try:
        from nodes import ImagePadKJ
        pad_node = ImagePadKJ()
        pad_result = pad_node.pad(
            constrained_image,
            None,      # mask
            None,      # target_width
            None,      # target_height
            left,      # left
            right,     # right
            top,       # top
            bottom,    # bottom
            0,         # extra_padding
            "color",   # pad_mode
            "128,128,128"  # color
        )
        padded_result = pad_result[0] if isinstance(pad_result, tuple) else pad_result
        print(f"[Qwen] ImagePadKJ: left={left}, right={right}, top={top}, bottom={bottom}")
    except Exception as e:
        batch, img_h, img_w, _ = constrained_image.shape
        new_w = img_w + left + right
        new_h = img_h + top + bottom
        padded_result = torch.ones((batch, new_h, new_w, 3), dtype=constrained_image.dtype, device=constrained_image.device) * 0.5
        padded_result[:, top:top+img_h, left:left+img_w, :] = constrained_image
        print(f"[Qwen] ImagePadKJ 降级: {e}")

    # ================================================
    # 步骤3: VAEEncode
    # ================================================
    encoder = VAEEncode()
    x_tuple = encoder.encode(vae, padded_result)
    x = x_tuple[0] if isinstance(x_tuple, tuple) else x_tuple
    print(f"[Qwen] VAEEncode 完成")

    # ================================================
    # 步骤4: TextEncodeQwenImageEditPlus
    # ================================================
    pos_prompt = "移除蓝色区域"
    
    try:
        from nodes import TextEncodeQwenImageEditPlus
        text_encoder = TextEncodeQwenImageEditPlus()
        positive = text_encoder.encode(clip, vae, padded_result, None, None, pos_prompt)[0]
        print(f"[Qwen] TextEncodeQwenImageEditPlus 完成")
    except ImportError:
        if CLIPTextEncode is not None:
            clip_encoder = CLIPTextEncode()
            positive = clip_encoder.encode(clip, pos_prompt)[0]
            print(f"[Qwen] CLIPTextEncode (降级) 完成")
        else:
            raise RuntimeError("TextEncodeQwenImageEditPlus 和 CLIPTextEncode 都不可用")

    # ================================================
    # 步骤5: ReferenceLatent
    # ================================================
    try:
        from nodes import ReferenceLatent
        ref_node = ReferenceLatent()
        positive = ref_node.reference(positive, x)
        positive = positive[0] if isinstance(positive, tuple) else positive
        print(f"[Qwen] ReferenceLatent 完成")
    except Exception as e:
        positive = apply_reference_latent(positive, x)
        print(f"[Qwen] ReferenceLatent 降级: {e}")

    # ================================================
    # 步骤6: ConditioningZeroOut
    # ================================================
    negative = conditioning_zero_out(positive)
    print(f"[Qwen] ConditioningZeroOut 完成")

    # ================================================
    # 步骤7: LoraLoaderModelOnly
    # ================================================
    patched_model = model
    if lora_name:
        try:
            from nodes import LoraLoaderModelOnly
            lora_loader = LoraLoaderModelOnly()
            lora_result = lora_loader.load_lora(model, lora_name, strength_model=1.0)
            patched_model = lora_result[0] if isinstance(lora_result, tuple) else lora_result
            print(f"[Qwen] LoraLoaderModelOnly: {lora_name}")
        except ImportError:
            print(f"[Qwen] LoraLoaderModelOnly: 当前版本不支持，跳过")
        except Exception as e:
            print(f"[Qwen] LoraLoaderModelOnly 失败: {e}，跳过")

    # ================================================
    # 步骤8: ModelSamplingAuraFlow - shift=3.1
    # ================================================
    try:
        from nodes import ModelSamplingAuraFlow
        aura_flow = ModelSamplingAuraFlow()
        aura_result = aura_flow.patch(patched_model, shift=3.1)
        patched_model = aura_result[0] if isinstance(aura_result, tuple) else aura_result
        print(f"[Qwen] ModelSamplingAuraFlow: shift=3.1")
    except ImportError:
        print(f"[Qwen] ModelSamplingAuraFlow: 当前版本不支持，跳过")
    except Exception as e:
        print(f"[Qwen] ModelSamplingAuraFlow 失败: {e}，跳过")

    # ================================================
    # 步骤9: CFGNorm - strength=1
    # ================================================
    try:
        from nodes import CFGNorm
        cfg_norm = CFGNorm()
        cfg_result = cfg_norm.patch(patched_model, 1.0)
        patched_model = cfg_result[0] if isinstance(cfg_result, tuple) else cfg_result
        print(f"[Qwen] CFGNorm: strength=1")
    except ImportError:
        print(f"[Qwen] CFGNorm: 当前版本不支持，跳过")
    except Exception as e:
        print(f"[Qwen] CFGNorm 失败: {e}，跳过")

    # ================================================
    # 步骤10: KSampler - steps=4, cfg=1, euler, simple
    # ================================================
    sampler = KSampler()
    sampler_result = sampler.sample(
        patched_model,
        seed,
        4,
        1.0,
        "euler",
        "simple",
        positive,
        negative,
        x,
        denoise=1.0,
    )
    sampled = sampler_result[0] if isinstance(sampler_result, tuple) else sampler_result
    print(f"[Qwen] KSampler 完成: steps=4, cfg=1")

    # ================================================
    # 步骤11: VAEDecode
    # ================================================
    decoder = VAEDecode()
    decoded_tuple = decoder.decode(vae, sampled)
    decoded = decoded_tuple[0] if isinstance(decoded_tuple, tuple) else decoded_tuple
    print(f"[Qwen] VAEDecode 完成")

    _free_vram()

    return decoded
