"""Flux1 Fill Dev 工作流 - 严格按照 flux_fill_dev扩图.json 工作流实现。"""

import os
import sys
import traceback
import torch
from nodes import (
    ImagePadForOutpaint,
    CLIPTextEncode,
    KSampler,
    VAEDecode,
)

from .nodes_def import (
    ConditioningZeroOut,
    DifferentialDiffusion,
    InpaintModelConditioning,
    FluxGuidance,
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


def _ensure_latent_dict(result):
    """确保 latent 为 {"samples": torch.Tensor} 格式。

    如果已经是 dict 且包含 "samples"，直接返回；
    否则包装成 {"samples": tensor}。
    """
    if isinstance(result, dict) and "samples" in result:
        return result
    if isinstance(result, torch.Tensor):
        return {"samples": result}
    tensor = _unwrap_tensor(result)
    return {"samples": tensor}


def execute_flux1_workflow(
    model,
    vae,
    clip,
    padded_image: torch.Tensor,
    pad_amounts: dict[str, int],
    seed: int,
    config: dict = None,
) -> torch.Tensor:
    """Flux1 Fill Dev 工作流。

    工作流节点顺序：
    1. ImagePadForOutpaint - feathering=24
    2. CLIPTextEncode - 提示词编码
    3. FluxGuidance - guidance
    4. ConditioningZeroOut - negative归零
    5. DifferentialDiffusion - strength=1
    6. InpaintModelConditioning - pixels, vae, mask
    7. KSampler - 参数由 config 驱动
    8. VAEDecode - 解码输出
    """
    config = config or {}
    steps = config.get("steps", 20)
    cfg_val = config.get("cfg", 1.0)
    guidance = config.get("guidance", 3.5)
    sampler_name = config.get("sampler_name", "euler")
    scheduler = config.get("scheduler", "normal")
    unique_id = config.get("unique_id", "")

    if vae is None:
        raise RuntimeError(f"[{MODULE_FILE}] VAE 模型不可用")
    if clip is None:
        raise RuntimeError(f"[{MODULE_FILE}] CLIP 模型不可用")

    left = pad_amounts.get("left", 0)
    right = pad_amounts.get("right", 0)
    top = pad_amounts.get("top", 0)
    bottom = pad_amounts.get("bottom", 0)

    # ================================================
    # 步骤1: ImagePadForOutpaint - feathering=24
    # ================================================
    _send_status(unique_id, "🌀 Flux1 | ImagePadForOutpaint...")
    feathering = 24
    try:
        padded_out, mask_out = ImagePadForOutpaint().expand_image(
            padded_image, left, top, right, bottom, feathering
        )
        padded_image = padded_out
        raw_mask = mask_out
        print(f"[Flux1] ImagePadForOutpaint: feathering={feathering}")
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        line_num = tb[-1].lineno if tb else "?"
        raise RuntimeError(
            f"[{MODULE_FILE}:{line_num}] ImagePadForOutpaint 失败\n"
            f"  原因: {str(e)}\n"
            f"  提示: 检查 ComfyUI nodes 模块是否包含 ImagePadForOutpaint"
        ) from e

    # ================================================
    # 步骤2: CLIPTextEncode - 提示词编码
    # ================================================
    _send_status(unique_id, "🌀 Flux1 | CLIPTextEncode...")
    pos_prompt = "Put the incomplete graph blueprint in front, let the AI fully complete all missing nodes, connections and layout strictly following the original style, keep the same visual logic, node type and arrangement rules without changing the existing content."
    neg_prompt = ""

    clip_encoder = CLIPTextEncode()
    positive = clip_encoder.encode(clip, pos_prompt)[0]
    negative = clip_encoder.encode(clip, neg_prompt)[0]
    print(f"[Flux1] CLIPTextEncode 完成")

    # ================================================
    # 步骤3: FluxGuidance
    # 返回 (CONDITIONING,) 元组，取 [0] 得到 conditioning list
    # ================================================
    try:
        flux_guidance_node = FluxGuidance()
        positive = flux_guidance_node.apply(positive, guidance)[0]
        print(f"[Flux1] FluxGuidance: guidance={guidance}")
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        line_num = tb[-1].lineno if tb else "?"
        raise RuntimeError(
            f"[{MODULE_FILE}:{line_num}] FluxGuidance 失败\n"
            f"  原因: {str(e)}\n"
            f"  提示: 检查 gjj_outpaint_studio.nodes_def.FluxGuidance 是否正确定义"
        ) from e

    # ================================================
    # 步骤4: ConditioningZeroOut - negative归零
    # 返回 (CONDITIONING,) 元组，取 [0] 得到 conditioning list
    # ================================================
    try:
        zero_out_node = ConditioningZeroOut()
        negative = zero_out_node.zero_out(negative)[0]
        print(f"[Flux1] ConditioningZeroOut 完成")
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        line_num = tb[-1].lineno if tb else "?"
        raise RuntimeError(
            f"[{MODULE_FILE}:{line_num}] ConditioningZeroOut 失败\n"
            f"  原因: {str(e)}\n"
            f"  提示: 检查 gjj_outpaint_studio.nodes_def.ConditioningZeroOut 是否正确定义"
        ) from e

    # ================================================
    # 步骤5: DifferentialDiffusion - strength=1
    # 返回 (MODEL,) 元组，取 [0] 得到 MODEL 对象（不是 tensor！）
    # ================================================
    strength = 1.0
    try:
        diff_diff_node = DifferentialDiffusion()
        model = diff_diff_node.patch(model, strength)[0]
        print(f"[Flux1] DifferentialDiffusion: strength={strength}")
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        line_num = tb[-1].lineno if tb else "?"
        raise RuntimeError(
            f"[{MODULE_FILE}:{line_num}] DifferentialDiffusion 失败\n"
            f"  原因: {str(e)}\n"
            f"  提示: 检查 gjj_outpaint_studio.nodes_def.DifferentialDiffusion 是否正确定义"
        ) from e

    # ================================================
    # 步骤6: InpaintModelConditioning
    # 返回 (positive, negative, latent) → latent 是 dict: {"samples": ..., "noise_mask": ...}
    # ================================================
    try:
        inpaint_cond = InpaintModelConditioning()
        cond_out = inpaint_cond.encode(
            positive,
            negative,
            padded_image,  # pixels
            vae,
            raw_mask,
            noise_mask=False,
        )
        # encode 返回 (positive, negative, latent) 三元组
        final_positive = cond_out[0]
        final_negative = cond_out[1]
        latent = cond_out[2]  # dict: {"samples": tensor, "noise_mask": tensor}
        print(f"[Flux1] InpaintModelConditioning 完成")
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        line_num = tb[-1].lineno if tb else "?"
        raise RuntimeError(
            f"[{MODULE_FILE}:{line_num}] InpaintModelConditioning 失败\n"
            f"  原因: {str(e)}\n"
            f"  提示: 检查 gjj_outpaint_studio.nodes_def.InpaintModelConditioning 是否正确定义"
        ) from e

    # ================================================
    # 步骤7: KSampler - 参数由 config 驱动
    # ================================================
    _send_status(unique_id, f"🌀 Flux1 | KSampler 采样中 ({steps}步)...")
    # 【关键】确保 latent 是 {"samples": tensor} 格式，新版 ComfyUI KSampler 内部会执行 latent["samples"]
    latent = _ensure_latent_dict(latent)
    sampler = KSampler()
    sampler_result = sampler.sample(
        model,
        seed,
        steps,
        cfg_val,
        sampler_name,
        scheduler,
        final_positive,
        final_negative,
        latent,
        denoise=1.0,
    )
    sampled = _unwrap_tensor(sampler_result)
    print(f"[Flux1] KSampler 完成: steps=20, cfg=1")

    # ================================================
    # 步骤8: VAEDecode
    # ================================================
    _send_status(unique_id, "🌀 Flux1 | VAEDecode...")
    decoder = VAEDecode()
    decoded_result = decoder.decode(vae, sampled)
    decoded = _unwrap_tensor(decoded_result)
    print(f"[Flux1] VAEDecode 完成")

    return decoded
