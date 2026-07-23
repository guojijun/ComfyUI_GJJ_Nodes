"""Helpers for the bundled, ComfyUI-native Mage-Flow runtime."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import torch
import torch.nn.functional as F

import comfy.utils


def is_mage_flow_name(value: Any) -> bool:
    text = str(value or "").replace("\\", "/").lower()
    return "mage-flow" in text or "mage_flow" in text or "mageflow" in text


@contextmanager
def safe_bf16_accumulation():
    """Prevent the global --fast fp16_accumulation flag from corrupting Mage."""
    matmul = getattr(getattr(torch.backends, "cuda", None), "matmul", None)
    has_option = matmul is not None and hasattr(matmul, "allow_fp16_accumulation")
    previous = getattr(matmul, "allow_fp16_accumulation", None) if has_option else None
    try:
        if has_option:
            matmul.allow_fp16_accumulation = False
        yield
    finally:
        if has_option:
            matmul.allow_fp16_accumulation = previous


def make_empty_latent(width: int, height: int, batch_size: int) -> dict[str, Any]:
    width = max(16, (int(width) // 16) * 16)
    height = max(16, (int(height) // 16) * 16)
    return {
        "samples": torch.zeros(
            [max(1, int(batch_size)), 128, height // 16, width // 16],
            device=torch.device("cpu"),
        ),
        "downscale_ratio_spacial": 16,
        "width": width,
        "height": height,
    }


def fit_reference(
    image: torch.Tensor,
    target_width: int,
    target_height: int,
) -> torch.Tensor:
    """Aspect-fit and pad a ComfyUI IMAGE tensor to the Mage latent canvas."""
    samples = image[:, :, :, :3]
    _, height, width, channels = samples.shape
    if height == target_height and width == target_width:
        return samples
    scale = min(target_height / max(1, height), target_width / max(1, width))
    resized_height = min(target_height, max(1, round(height * scale)))
    resized_width = min(target_width, max(1, round(width * scale)))
    resized = F.interpolate(
        samples.movedim(-1, 1),
        size=(resized_height, resized_width),
        mode="bicubic",
        align_corners=False,
    )
    padded = torch.zeros(
        (samples.shape[0], channels, target_height, target_width),
        device=resized.device,
        dtype=resized.dtype,
    )
    top = max(0, (target_height - resized_height) // 2)
    left = max(0, (target_width - resized_width) // 2)
    padded[:, :, top : top + resized_height, left : left + resized_width] = resized
    return padded.movedim(1, -1)


def resize_for_vl(image: torch.Tensor, max_long_edge: int = 384) -> torch.Tensor:
    samples = image.movedim(-1, 1)
    _, _, height, width = samples.shape
    long_edge = max(height, width)
    if max_long_edge <= 0 or long_edge <= max_long_edge:
        return image
    scale = max_long_edge / max(1, long_edge)
    resized_width = max(1, round(width * scale))
    resized_height = max(1, round(height * scale))
    return comfy.utils.common_upscale(
        samples,
        resized_width,
        resized_height,
        "bicubic",
        "disabled",
    ).movedim(1, -1)


def encode_conditioning(
    clip: Any,
    vae: Any,
    prompt: str,
    images: list[torch.Tensor],
    target_width: int,
    target_height: int,
):
    canonical = [
        fit_reference(image, target_width, target_height)
        for image in images[:3]
        if isinstance(image, torch.Tensor)
    ]
    visual = [resize_for_vl(image) for image in canonical]
    tokens = clip.tokenize(str(prompt or " "), images=visual)
    conditioning = clip.encode_from_tokens_scheduled(tokens)
    if canonical:
        reference_latents = [vae.encode(image) for image in canonical]
        conditioned = []
        for cond, data in conditioning:
            copied = data.copy()
            copied["reference_latents"] = reference_latents
            conditioned.append([cond, copied])
        conditioning = conditioned
    return conditioning
