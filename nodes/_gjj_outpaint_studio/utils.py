"""GJJ 扩图工具 - 工具函数模块"""

import os
import gc
import torch


def _send_status(unique_id, status_text):
    """发送节点状态更新到前端进度条。"""
    if not unique_id:
        return
    try:
        from server import PromptServer

        status_text = str(status_text or "").strip()
        if not status_text:
            status_text = "处理中..."
        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": status_text},
        )
    except Exception:
        pass


# ================================================
# 模型解析函数
# ================================================


def _resolve_model_by_priority(model_path, model_name, priorities):
    """根据优先级列表解析模型路径。"""
    for priority in priorities:
        priority_name = priority.replace("*", model_name)
        priority_path = os.path.join(model_path, priority_name)
        if os.path.exists(priority_path):
            return priority_path
    return None


# ================================================
# 显存管理函数
# ================================================


def _free_vram():
    """释放显存。"""
    gc.collect()
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
    except:
        pass


# ================================================
# Flux 相关函数
# ================================================


def _apply_flux_guidance(conditioning, guidance_val):
    """Apply FluxGuidance。"""
    result = []
    for t in conditioning:
        cond = t[0]
        extra = t[1].copy()
        extra["guidance"] = float(guidance_val)
        result.append([cond, extra])
    return result


def _conditioning_zero_out(conditioning):
    """ConditioningZeroOut - 将条件归零。"""
    result = []
    for t in conditioning:
        cond = torch.zeros_like(t[0])
        extra = t[1].copy()
        result.append([cond, extra])
    return result


def _apply_differential_diffusion(model, strength_val):
    """Apply DifferentialDiffusion。"""
    patched = model.clone()

    def forward(sigma, denoise_mask, extra_options, strength_val):
        inner_model = extra_options.get("model")
        step_sigmas = extra_options.get("sigmas")
        sigma_to = (
            getattr(inner_model.inner_model, "model_sampling", None).sigma_min
            if hasattr(inner_model, "inner_model")
            and hasattr(inner_model.inner_model, "model_sampling")
            else 0
        )
        if step_sigmas is not None and len(step_sigmas) > 0:
            sigma_to = step_sigmas[-1] if sigma_to == 0 else sigma_to
            sigma_from = step_sigmas[0]
        else:
            sigma_from = sigma

        if hasattr(inner_model, "inner_model") and hasattr(
            inner_model.inner_model, "model_sampling"
        ):
            ts_from = inner_model.inner_model.model_sampling.timestep(sigma_from)
            ts_to = inner_model.inner_model.model_sampling.timestep(sigma_to)
            current_ts = inner_model.inner_model.model_sampling.timestep(
                sigma[0] if isinstance(sigma, (list, torch.Tensor)) else sigma
            )
            threshold = (current_ts - ts_to) / (ts_from - ts_to)
            binary_mask = (denoise_mask >= threshold).to(denoise_mask.dtype)

            if strength_val and strength_val < 1:
                return strength_val * binary_mask + (1 - strength_val) * denoise_mask
            return binary_mask
        return denoise_mask

    patched.set_model_denoise_mask_function(
        lambda *args, **kwargs: forward(
            *args, **kwargs, strength_val=float(strength_val)
        )
    )
    return patched


def _apply_reference_latent(conditioning, latent):
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


def _apply_controlnet(conditioning, controlnet, image, mask, vae, strength=1.0):
    """Apply ControlNet to conditioning."""
    result = []
    for t in conditioning:
        cond = t[0]
        extra = t[1].copy()
        if "control" not in extra:
            extra["control"] = []
        extra["control"].append(
            {
                "control_net": controlnet,
                "image": image,
                "mask": mask,
                "vae": vae,
                "strength": strength,
            }
        )
        result.append([cond, extra])
    return result


__all__ = [
    "_send_status",
    "_resolve_model_by_priority",
    "_free_vram",
    "_apply_flux_guidance",
    "_conditioning_zero_out",
    "_apply_differential_diffusion",
    "_apply_reference_latent",
    "_apply_controlnet",
]
