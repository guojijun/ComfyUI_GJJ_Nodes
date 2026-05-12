"""Qwen Image Edit 工作流 - 严格按照 Qwen_image_edit扩图.json 工作流实现。"""

import torch
from nodes import (
    VAEEncode,
    CLIPTextEncode,
    KSampler,
    VAEDecode,
)
from .nodes_def import (
    ConstrainImage,
    ImagePadKJ,
    ReferenceLatent,
    ConditioningZeroOut,
    ModelSamplingAuraFlow,
    CFGNorm,
    LoraLoaderModelOnly,
    TextEncodeQwenImageEditPlus,
)
from .utils import _send_status


def _unwrap_tensor(result):
    """递归解包 ComfyUI 节点返回值，直到取出 tensor。"""
    x = result
    max_depth = 5
    for _ in range(max_depth):
        if isinstance(x, torch.Tensor):
            return x
        if isinstance(x, dict):
            if "samples" in x:
                x = x["samples"]
            elif "result" in x:
                x = x["result"]
            elif "latent" in x:
                x = x["latent"]
            else:
                x = next(iter(x.values()), x)
        elif isinstance(x, (tuple, list)):
            x = x[0] if len(x) > 0 else x
        else:
            break
    return x


def _unwrap_to_latent_dict(result):
    """解包到 {"samples": torch.Tensor} 格式，供 KSampler 使用。

    新版 ComfyUI KSampler 内部会执行 latent["samples"]，必须传入 dict。
    而 _unwrap_tensor 会解到纯 tensor 层，导致 IndexError。
    """
    tensor = _unwrap_tensor(result)
    return {"samples": tensor}


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
    config: dict = None,
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
    10. KSampler - 参数由 config 驱动
    11. VAEDecode
    """
    config = config or {}
    steps = config.get("steps", 4)
    cfg_val = config.get("cfg", 1.0)
    sampler_name = config.get("sampler_name", "euler")
    scheduler = config.get("scheduler", "simple")
    unique_id = config.get("unique_id", "")

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
        constrain_node = ConstrainImage()
        constrained_image = _unwrap_tensor(
            constrain_node.constrain_image(padded_image, max_size, max_size, 0, 0, "no")
        )
        print(f"[Qwen] ConstrainImage: max_size={max_size}")
    except Exception as e:
        constrained_image = padded_image
        print(f"[Qwen] ConstrainImage 降级: {e}")

    # ================================================
    # 步骤2: ImagePadKJ - 颜色填充扩图
    # ================================================
    try:
        pad_node = ImagePadKJ()
        pad_result = pad_node.pad(
            constrained_image,
            left,
            right,
            top,
            bottom,
            0,
            "128,128,128",
            "color",
        )
        padded_result = _unwrap_tensor(pad_result)
        print(
            f"[Qwen] ImagePadKJ: left={left}, right={right}, top={top}, bottom={bottom}"
        )
    except Exception as e:
        batch, img_h, img_w, _ = constrained_image.shape
        new_w = img_w + left + right
        new_h = img_h + top + bottom
        padded_result = (
            torch.ones(
                (batch, new_h, new_w, 3),
                dtype=constrained_image.dtype,
                device=constrained_image.device,
            )
            * 0.5
        )
        padded_result[:, top : top + img_h, left : left + img_w, :] = constrained_image
        print(f"[Qwen] ImagePadKJ 降级: {e}")

    # ================================================
    # 步骤3: VAEEncode
    # 【关键】必须保留 {"samples": tensor} 格式给 KSampler
    # ================================================
    _send_status(unique_id, "🌟 Qwen | VAEEncode...")
    encoder = VAEEncode()
    x = _unwrap_to_latent_dict(encoder.encode(vae, padded_result))
    print(f"[Qwen] VAEEncode 完成")

    # ================================================
    # 步骤4: TextEncodeQwenImageEditPlus
    # 返回 (CONDITIONING,) 元组，取 [0] 得到 conditioning list
    # ================================================
    pos_prompt = "移除蓝色区域"

    text_encoder = TextEncodeQwenImageEditPlus()
    positive = text_encoder.encode(clip, vae, padded_result, pos_prompt, None, None)[0]
    print(f"[Qwen] TextEncodeQwenImageEditPlus 完成")

    # ================================================
    # 步骤5: ReferenceLatent
    # 返回 (CONDITIONING,) 元组，取 [0] 得到 conditioning list
    # ================================================
    ref_node = ReferenceLatent()
    positive = ref_node.reference(positive, x)[0]
    print(f"[Qwen] ReferenceLatent 完成")

    # ================================================
    # 步骤6: ConditioningZeroOut
    # ================================================
    negative = ConditioningZeroOut().zero_out(positive)[0]
    print(f"[Qwen] ConditioningZeroOut 完成")

    # ================================================
    # 步骤7: LoraLoaderModelOnly
    # 返回 (MODEL,) 元组，取 [0] 得到 MODEL 对象（不是 tensor！）
    # ================================================
    patched_model = model
    if lora_name:
        lora_loader = LoraLoaderModelOnly()
        patched_model = lora_loader.load_lora(model, lora_name, strength_model=1.0)[0]
        print(f"[Qwen] LoraLoaderModelOnly: {lora_name}")

    # ================================================
    # 步骤8: ModelSamplingAuraFlow - shift=3.1
    # 返回 (MODEL,) 元组，取 [0] 得到 MODEL 对象（不是 tensor！）
    # ================================================
    aura_flow = ModelSamplingAuraFlow()
    patched_model = aura_flow.patch(patched_model, shift=3.1)[0]
    print(f"[Qwen] ModelSamplingAuraFlow: shift=3.1")

    # ================================================
    # 步骤9: CFGNorm - strength=1
    # 返回 (MODEL,) 元组，取 [0] 得到 MODEL 对象（不是 tensor！）
    # ================================================
    cfg_norm = CFGNorm()
    patched_model = cfg_norm.patch(patched_model, 1.0)[0]
    print(f"[Qwen] CFGNorm: strength=1")

    # ================================================
    # 步骤10: KSampler - 参数由 config 驱动
    # ================================================
    _send_status(unique_id, f"🌟 Qwen | KSampler 采样中 ({steps}步)...")
    sampler = KSampler()
    sampler_result = sampler.sample(
        patched_model,
        seed,
        steps,
        cfg_val,
        sampler_name,
        scheduler,
        positive,
        negative,
        x,
        denoise=1.0,
    )
    sampled = _unwrap_tensor(sampler_result)
    print(f"[Qwen] KSampler 完成: steps={steps}, cfg={cfg_val}")

    # ================================================
    # 步骤11: VAEDecode
    # ================================================
    decoder = VAEDecode()
    decoded_result = decoder.decode(vae, sampled)
    decoded = _unwrap_tensor(decoded_result)
    print(f"[Qwen] VAEDecode 完成")

    _free_vram()

    return decoded
