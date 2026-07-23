from __future__ import annotations

from typing import Any

import torch

import comfy.model_management
import comfy.model_patcher

from .vae import MageVAE


MAGE_VAE_FORMAT = "mage_flow.vae"


def is_mage_vae_state_dict(sd: dict[str, torch.Tensor] | None, metadata: dict[str, Any] | None = None) -> bool:
    if sd is None:
        return False
    if metadata and metadata.get("comfyui_mage.format") == MAGE_VAE_FORMAT:
        return True
    return (
        any(k.startswith("student.dconv_encoder.") for k in sd)
        and any(k.startswith("pipeline.") for k in sd)
    )


class ComfyMageVAE:
    latent_channels = 128
    latent_dim = 2
    downscale_ratio = 16
    upscale_ratio = 16
    output_channels = 3
    working_dtypes = [torch.bfloat16, torch.float32]

    def __init__(self, sd, device=None, dtype=None, metadata=None, sample_posterior=False):
        self.first_stage_model = MageVAE(state_dict=sd, sample_posterior=sample_posterior).eval()
        if device is None:
            device = comfy.model_management.vae_device()
        self.device = device
        self.output_device = comfy.model_management.intermediate_device()
        self.vae_dtype = dtype or comfy.model_management.vae_dtype(self.device, self.working_dtypes)
        self.first_stage_model.to(dtype=self.vae_dtype)
        comfy.model_management.archive_model_dtypes(self.first_stage_model)
        self.disable_offload = False
        self.patcher = comfy.model_patcher.CoreModelPatcher(
            self.first_stage_model,
            load_device=self.device,
            offload_device=comfy.model_management.vae_offload_device(),
        )
        self._size = None

    def throw_exception_if_invalid(self):
        if self.first_stage_model is None:
            raise RuntimeError("ERROR: MageFlow VAE is invalid.")

    def model_size(self):
        if self._size is None:
            self._size = comfy.model_management.module_size(self.first_stage_model)
        return self._size

    def vae_output_dtype(self):
        return torch.float32

    def _batch_number(self, memory_used):
        free_memory = self.patcher.get_free_memory(self.device)
        return max(1, int(free_memory / max(1, memory_used)))

    def memory_used_decode(self, shape, dtype):
        return shape[0] * shape[2] * shape[3] * 16 * 16 * 900 * comfy.model_management.dtype_size(dtype)

    def memory_used_encode(self, shape, dtype):
        return shape[0] * shape[2] * shape[3] * 900 * comfy.model_management.dtype_size(dtype)

    def decode(self, samples_in, vae_options=None):
        self.throw_exception_if_invalid()
        vae_options = vae_options or {}
        if samples_in.ndim == 5:
            samples_in = samples_in[:, :, 0]
        memory_used = self.memory_used_decode(samples_in.shape, self.vae_dtype)
        with comfy.model_management.cuda_device_context(self.device):
            comfy.model_management.load_models_gpu([self.patcher], memory_required=memory_used)
            batch_number = self._batch_number(memory_used)
            pixel_samples = None
            for start in range(0, samples_in.shape[0], batch_number):
                samples = samples_in[start : start + batch_number].to(device=self.device, dtype=self.vae_dtype)
                out = self.first_stage_model.decode(samples)
                out = out.add(1.0).div(2.0).clamp(0.0, 1.0)
                out = out.to(device=self.output_device, dtype=self.vae_output_dtype(), copy=True)
                if pixel_samples is None:
                    pixel_samples = torch.empty(
                        (samples_in.shape[0],) + tuple(out.shape[1:]),
                        device=self.output_device,
                        dtype=self.vae_output_dtype(),
                    )
                pixel_samples[start : start + batch_number].copy_(out)
                del out
        return pixel_samples.movedim(1, -1)

    def encode(self, pixel_samples):
        self.throw_exception_if_invalid()
        h = (pixel_samples.shape[1] // self.downscale_ratio) * self.downscale_ratio
        w = (pixel_samples.shape[2] // self.downscale_ratio) * self.downscale_ratio
        pixel_samples = pixel_samples[:, :h, :w, : self.output_channels].movedim(-1, 1)
        memory_used = self.memory_used_encode(pixel_samples.shape, self.vae_dtype)
        with comfy.model_management.cuda_device_context(self.device):
            comfy.model_management.load_models_gpu([self.patcher], memory_required=memory_used)
            batch_number = self._batch_number(memory_used)
            latents = None
            for start in range(0, pixel_samples.shape[0], batch_number):
                pixels = pixel_samples[start : start + batch_number].to(device=self.device, dtype=self.vae_dtype)
                pixels = pixels.mul(2.0).sub(1.0)
                out = self.first_stage_model.encode(pixels)
                out = out.to(device=self.output_device, dtype=self.vae_output_dtype(), copy=True)
                if latents is None:
                    latents = torch.empty(
                        (pixel_samples.shape[0],) + tuple(out.shape[1:]),
                        device=self.output_device,
                        dtype=self.vae_output_dtype(),
                    )
                latents[start : start + batch_number].copy_(out)
                del out
        return latents

    def decode_tiled(self, samples, *args, **kwargs):
        return self.decode(samples)

    def encode_tiled(self, pixel_samples, *args, **kwargs):
        return self.encode(pixel_samples)

    def get_sd(self):
        return self.first_stage_model.state_dict()

    def spacial_compression_decode(self):
        return self.upscale_ratio

    def spacial_compression_encode(self):
        return self.downscale_ratio

