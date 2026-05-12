"""Flux2 Klein 工作流 - 严格按照 Flux2-klein扩图.json 工作流实现。"""

import os
import sys
import traceback
import torch
from nodes import (
    ImagePadForOutpaint,
    VAEEncode,
    CLIPTextEncode,
    KSampler,
    VAEDecode,
)
from .nodes_def import (
    JoinImageWithAlpha,
    ImageCompositeMasked,
    FluxKontextImageScale,
    ReferenceLatent,
    ConditioningZeroOut,
)
from .utils import _send_status

MODULE_FILE = os.path.basename(__file__)


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


def execute_flux2_workflow(
    model,
    vae,
    clip,
    padded_image: torch.Tensor,
    pad_amounts: dict[str, int],
    seed: int,
    config: dict = None,
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
    8. KSampler - 参数由 config 驱动
    9. VAEDecode - 解码输出
    """
    config = config or {}
    steps = config.get("steps", 6)
    cfg_val = config.get("cfg", 1.0)
    sampler_name = config.get("sampler_name", "euler")
    scheduler = config.get("scheduler", "simple")
    unique_id = config.get("unique_id", "")

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
    _send_status(unique_id, "✨ Flux2 | ImagePadForOutpaint...")
    feathering = 100
    try:
        padded_out, mask_out = ImagePadForOutpaint().expand_image(
            padded_image, left, top, right, bottom, feathering
        )
        padded_image = padded_out
        raw_mask = mask_out
        print(f"[Flux2] ImagePadForOutpaint: feathering={feathering}")
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        line_num = tb[-1].lineno if tb else "?"
        raise RuntimeError(
            f"[{MODULE_FILE}:{line_num}] ImagePadForOutpaint 失败\n"
            f"  原因: {str(e)}\n"
            f"  提示: 检查 ComfyUI nodes 模块是否包含 ImagePadForOutpaint"
        ) from e

    # ================================================
    # 步骤2: 创建空图像用于合成
    # ================================================
    batch, img_h, img_w, _ = padded_image.shape
    empty_image = torch.ones_like(padded_image)

    # ================================================
    # 步骤3: JoinImageWithAlpha
    # ================================================
    try:
        join_node = JoinImageWithAlpha()
        joined_image = _unwrap_tensor(
            join_node.join_image_with_alpha(empty_image, raw_mask)
        )
        # JoinImageWithAlpha 输出 4 通道 (RGBA)，取前 3 通道匹配 RGB
        if joined_image.shape[-1] == 4:
            joined_image = joined_image[..., :3]
        print(f"[Flux2] JoinImageWithAlpha 完成")
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        line_num = tb[-1].lineno if tb else "?"
        raise RuntimeError(
            f"[{MODULE_FILE}:{line_num}] JoinImageWithAlpha 失败\n"
            f"  原因: {str(e)}\n"
            f"  提示: 检查 ComfyUI nodes 模块是否包含 JoinImageWithAlpha"
        ) from e

    # ================================================
    # 步骤3: ImageCompositeMasked
    # ================================================
    try:
        composite_node = ImageCompositeMasked()
        composite_image = _unwrap_tensor(
            composite_node.composite(
                padded_image,  # destination
                joined_image,  # source
                0,  # x
                0,  # y
                False,  # resize_source
                raw_mask,  # mask (keyword arg)
            )
        )
        print(f"[Flux2] ImageCompositeMasked 完成")
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        line_num = tb[-1].lineno if tb else "?"
        raise RuntimeError(
            f"[{MODULE_FILE}:{line_num}] ImageCompositeMasked 失败\n"
            f"  原因: {str(e)}\n"
            f"  提示: 检查 ComfyUI nodes 模块是否包含 ImageCompositeMasked"
        ) from e

    # ================================================
    # 步骤4: FluxKontextImageScale
    # ================================================
    try:
        scale_node = FluxKontextImageScale()
        scaled_image = _unwrap_tensor(scale_node.scale(composite_image))
        print(f"[Flux2] FluxKontextImageScale 完成")
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        line_num = tb[-1].lineno if tb else "?"
        raise RuntimeError(
            f"[{MODULE_FILE}:{line_num}] FluxKontextImageScale 失败\n"
            f"  原因: {str(e)}\n"
            f"  提示: 检查 ComfyUI nodes 模块是否包含 FluxKontextImageScale"
        ) from e

    # ================================================
    # 步骤4: VAEEncode
    # ================================================
    _send_status(unique_id, "✨ Flux2 | VAEEncode...")
    encoder = VAEEncode()
    # 【关键】必须保留 {"samples": tensor} 格式给 KSampler
    x = _unwrap_to_latent_dict(encoder.encode(vae, scaled_image))
    print(f"[Flux2] VAEEncode 完成")

    # ================================================
    # 步骤5: CLIPTextEncode
    # ================================================
    pos_prompt = "移除蓝色区域，同时保持图像的其余部分不变"
    neg_prompt = ""

    clip_encoder = CLIPTextEncode()
    pos_raw = clip_encoder.encode(clip, pos_prompt)  # ([[tensor, dict], ...], )
    neg_raw = clip_encoder.encode(clip, neg_prompt)  # ([[tensor, dict], ...], )
    # CLIPTextEncode 返回 tuple，取 [0] 得到 conditioning 列表
    positive = pos_raw[0] if isinstance(pos_raw, (tuple, list)) else pos_raw
    negative = neg_raw[0] if isinstance(neg_raw, (tuple, list)) else neg_raw
    print(f"[Flux2] CLIPTextEncode 完成")

    # ================================================
    # 步骤6: ReferenceLatent
    # 返回 (CONDITIONING,) 元组，取 [0] 得到 conditioning list
    # ================================================
    ref_node = ReferenceLatent()
    positive = ref_node.reference(positive, x)[0]
    print(f"[Flux2] ReferenceLatent 完成")

    # ================================================
    # 步骤7: ConditioningZeroOut
    # ================================================
    negative = ConditioningZeroOut().zero_out(negative)[0]
    print(f"[Flux2] ConditioningZeroOut 完成")

    # ================================================
    # 步骤8: KSampler - 参数由 config 驱动
    # ================================================
    _send_status(unique_id, f"✨ Flux2 | KSampler 采样中 ({steps}步)...")
    sampler = KSampler()
    sampler_result = sampler.sample(
        model,
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
    print(f"[Flux2] KSampler 完成: steps={steps}, cfg={cfg_val}")

    # ================================================
    # 步骤9: VAEDecode
    # ================================================
    _send_status(unique_id, "✨ Flux2 | VAEDecode...")
    decoder = VAEDecode()
    decoded_result = decoder.decode(vae, sampled)
    decoded = _unwrap_tensor(decoded_result)
    print(f"[Flux2] VAEDecode 完成")

    return decoded
