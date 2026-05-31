from __future__ import annotations

from typing import Any

import torch


NODE_NAME = "GJJ_ColorMatch"
METHODS = ["mkl", "hm", "reinhard", "mvgd", "hm-mvgd-hm", "hm-mkl-hm"]
MATRIX_EPS = 1e-6
MATRIX_JITTERS = (0.0, 1e-8, 1e-6, 1e-4, 1e-3)


def _to_float(value: Any, default: float = 1.0) -> float:
    try:
        if isinstance(value, (list, tuple)) and len(value) == 1:
            value = value[0]
        return float(value)
    except Exception:
        return default


def _check_image(name: str, value: Any) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise RuntimeError(f"{name} 未连接 IMAGE。")
    if value.ndim != 4 or value.shape[-1] < 3:
        raise RuntimeError(f"{name} 应为 ComfyUI IMAGE：BHWC，且至少包含 RGB 三通道。")
    return value.detach().float().cpu()


def _diagonal_matrix_sqrt(matrix: torch.Tensor, inverse: bool = False) -> torch.Tensor:
    diag = torch.diagonal(matrix).clamp_min(MATRIX_EPS)
    scale = torch.rsqrt(diag) if inverse else torch.sqrt(diag)
    return torch.diag(scale)


def _matrix_sqrt(matrix: torch.Tensor, inverse: bool = False) -> torch.Tensor:
    original_dtype = matrix.dtype
    work = torch.nan_to_num(matrix, nan=0.0, posinf=0.0, neginf=0.0).to(torch.float64)
    work = (work + work.T) * 0.5
    eye = torch.eye(work.shape[0], dtype=work.dtype, device=work.device)
    diag_scale = float(torch.diagonal(work).abs().mean().clamp_min(1.0).item())

    for jitter in MATRIX_JITTERS:
        try:
            stable = work + eye * (jitter * diag_scale)
            eigvals, eigvecs = torch.linalg.eigh(stable)
            eigvals = torch.nan_to_num(eigvals, nan=MATRIX_EPS, posinf=1.0, neginf=MATRIX_EPS).clamp_min(MATRIX_EPS)
            scale = torch.rsqrt(eigvals) if inverse else torch.sqrt(eigvals)
            result = eigvecs @ torch.diag(scale) @ eigvecs.T
            if torch.isfinite(result).all():
                return result.to(original_dtype)
        except torch._C._LinAlgError:
            continue
        except RuntimeError:
            continue

    # 极端退化帧兜底：只保留每个通道自身方差，避免 linalg.eigh 中断整条工作流。
    return _diagonal_matrix_sqrt(work, inverse=inverse).to(original_dtype)


def _covariance_transfer(target: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    src = target.reshape(-1, target.shape[-1])
    ref = reference.reshape(-1, reference.shape[-1])
    src_mean = src.mean(dim=0, keepdim=True)
    ref_mean = ref.mean(dim=0, keepdim=True)
    src_centered = src - src_mean
    ref_centered = ref - ref_mean
    denom_src = max(1, src_centered.shape[0] - 1)
    denom_ref = max(1, ref_centered.shape[0] - 1)
    src_cov = (src_centered.T @ src_centered) / denom_src
    ref_cov = (ref_centered.T @ ref_centered) / denom_ref
    transform = _matrix_sqrt(src_cov, inverse=True) @ _matrix_sqrt(ref_cov, inverse=False)
    out = src_centered @ transform + ref_mean
    if not torch.isfinite(out).all():
        return _reinhard_transfer(target, reference)
    return out.reshape_as(target)


def _reinhard_transfer(target: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    src = target.reshape(-1, target.shape[-1])
    ref = reference.reshape(-1, reference.shape[-1])
    src_mean = src.mean(dim=0)
    ref_mean = ref.mean(dim=0)
    src_std = src.std(dim=0, unbiased=False).clamp_min(1e-6)
    ref_std = ref.std(dim=0, unbiased=False)
    out = (src - src_mean) * (ref_std / src_std) + ref_mean
    return out.reshape_as(target)


def _match_channel_histogram(source: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    flat = source.reshape(-1)
    ref = reference.reshape(-1)
    if flat.numel() <= 1 or ref.numel() <= 1:
        return source
    order = torch.argsort(flat)
    ref_sorted = torch.sort(ref).values
    ref_pos = torch.linspace(0, ref_sorted.numel() - 1, flat.numel(), dtype=torch.float32)
    low = torch.floor(ref_pos).long()
    high = torch.ceil(ref_pos).long()
    alpha = (ref_pos - low.float()).to(ref_sorted.dtype)
    mapped_sorted = ref_sorted[low] * (1.0 - alpha) + ref_sorted[high] * alpha
    out = torch.empty_like(flat)
    out[order] = mapped_sorted.to(out.dtype)
    return out.reshape_as(source)


def _histogram_transfer(target: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    channels = []
    for channel in range(target.shape[-1]):
        channels.append(_match_channel_histogram(target[..., channel], reference[..., channel]))
    return torch.stack(channels, dim=-1)


def _transfer_rgb(target_rgb: torch.Tensor, ref_rgb: torch.Tensor, method: str) -> torch.Tensor:
    if method == "hm":
        return _histogram_transfer(target_rgb, ref_rgb)
    if method == "reinhard":
        return _reinhard_transfer(target_rgb, ref_rgb)
    if method in ("mvgd", "mkl"):
        return _covariance_transfer(target_rgb, ref_rgb)
    if method == "hm-mvgd-hm":
        first = _histogram_transfer(target_rgb, ref_rgb)
        second = _covariance_transfer(first, ref_rgb)
        return _histogram_transfer(second, ref_rgb)
    if method == "hm-mkl-hm":
        first = _histogram_transfer(target_rgb, ref_rgb)
        second = _covariance_transfer(first, ref_rgb)
        return _histogram_transfer(second, ref_rgb)
    return _covariance_transfer(target_rgb, ref_rgb)


class GJJ_ColorMatch:
    CATEGORY = "GJJ/图像"
    FUNCTION = "colormatch"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    OUTPUT_TOOLTIPS = ("颜色匹配后的 IMAGE。",)
    DESCRIPTION = "零依赖颜色匹配：复刻 KJ ColorMatch 的接口，用本地 torch 实现直方图匹配、Reinhard 和协方差颜色迁移。"
    SEARCH_ALIASES = ["ColorMatch", "color match", "color transfer", "颜色匹配", "颜色迁移", "色彩匹配"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_ref": (
                    "IMAGE",
                    {
                        "display_name": "参考图像",
                        "tooltip": "提供目标颜色风格的参考 IMAGE；若只有一张，会应用到所有目标图。",
                    },
                ),
                "image_target": (
                    "IMAGE",
                    {
                        "display_name": "目标图像",
                        "tooltip": "需要进行颜色匹配的目标 IMAGE batch。",
                    },
                ),
                "method": (
                    METHODS,
                    {
                        "default": "mkl",
                        "display_name": "匹配方法",
                        "tooltip": "mkl/mvgd 使用协方差颜色迁移；hm 使用逐通道直方图匹配；reinhard 使用均值方差匹配；组合方法会串联处理。",
                    },
                ),
            },
            "optional": {
                "strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.01,
                        "display_name": "强度",
                        "tooltip": "0 返回原图；1 使用完整匹配结果；大于 1 会增强匹配效果。",
                    },
                ),
                "multithread": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "多线程兼容开关",
                        "tooltip": "为兼容 KJ 原节点保留。GJJ 零依赖版使用 torch 本地计算，此开关不改变结果。",
                    },
                ),
            },
        }

    def colormatch(self, image_ref, image_target, method="mkl", strength=1.0, multithread=True):
        amount = _to_float(strength, 1.0)
        target = _check_image("目标图像", image_target)
        reference = _check_image("参考图像", image_ref)
        if amount == 0:
            return (target,)
        method = str(method or "mkl")
        if method not in METHODS:
            method = "mkl"

        out_images = []
        ref_count = int(reference.shape[0])
        for index in range(int(target.shape[0])):
            src = target[index]
            ref = reference[min(index, ref_count - 1)]
            src_rgb = src[..., :3]
            ref_rgb = ref[..., :3]
            matched_rgb = _transfer_rgb(src_rgb, ref_rgb, method)
            mixed_rgb = src_rgb + amount * (matched_rgb - src_rgb)
            if src.shape[-1] > 3:
                result = torch.cat([mixed_rgb, src[..., 3:]], dim=-1)
            else:
                result = mixed_rgb
            out_images.append(result)

        return (torch.stack(out_images, dim=0).to(torch.float32).clamp_(0.0, 1.0),)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ColorMatch}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎨 颜色匹配"}
