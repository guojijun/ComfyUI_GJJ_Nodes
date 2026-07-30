"""Small helpers for ComfyUI's native Mage-Flow implementation."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import torch

import comfy.model_management
import comfy.utils
import node_helpers


def is_mage_flow_name(value: Any) -> bool:
    text = str(value or "").replace("\\", "/").lower()
    return "mage-flow" in text or "mage_flow" in text or "mageflow" in text


@contextmanager
def safe_bf16_accumulation():
    """Keep the global FP16 accumulation option away from Mage BF16 sampling."""
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
            device=comfy.model_management.intermediate_device(),
        )
    }


def _resize_image(
    image: torch.Tensor,
    width: int,
    height: int,
) -> torch.Tensor:
    samples = image[:, :, :, :3].movedim(-1, 1)
    if samples.shape[3] != width or samples.shape[2] != height:
        samples = comfy.utils.common_upscale(
            samples,
            width,
            height,
            "bicubic",
            "disabled",
        )
    return samples.movedim(1, -1)


def _resize_for_vl(image: torch.Tensor, max_long_edge: int = 384) -> torch.Tensor:
    samples = image[:, :, :, :3].movedim(-1, 1)
    long_edge = max(samples.shape[3], samples.shape[2])
    if max_long_edge > 0 and long_edge > max_long_edge:
        scale = max_long_edge / long_edge
        samples = comfy.utils.common_upscale(
            samples,
            max(1, round(samples.shape[3] * scale)),
            max(1, round(samples.shape[2] * scale)),
            "bicubic",
            "disabled",
        )
    return samples.movedim(1, -1)


def encode_conditioning(
    clip: Any,
    vae: Any,
    prompt: str,
    images: list[torch.Tensor],
    target_width: int,
    target_height: int,
):
    references = [
        image
        for image in images[:3]
        if isinstance(image, torch.Tensor)
    ]
    visual_references = [_resize_for_vl(image) for image in references]
    conditioning = clip.encode_from_tokens_scheduled(
        clip.tokenize(str(prompt or " "), images=visual_references)
    )
    if references:
        reference_latents = [
            vae.encode(_resize_image(image, target_width, target_height))
            for image in references
        ]
        conditioning = node_helpers.conditioning_set_values(
            conditioning,
            {"reference_latents": reference_latents},
            append=True,
        )
    return conditioning
