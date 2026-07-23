from __future__ import annotations

import logging

import comfy.sd
import comfy.text_encoders.long_clipl
import comfy.utils

from .mage_runtime.comfy_vae import ComfyMageVAE, is_mage_vae_state_dict
from .mage_runtime.model import is_mage_flow_transformer_state_dict, load_mage_flow_diffusion_model_state_dict
from .mage_runtime.text_encoder import MageFlowTokenizer, is_mage_text_encoder_metadata, te as mage_flow_te


_APPLIED = False


def _load_mage_text_encoder_clip(ckpt_paths, embedding_directory=None, model_options=None, disable_dynamic=False):
    if len(ckpt_paths) != 1:
        return None

    model_options = model_options or {}
    sd, metadata = comfy.utils.load_torch_file(ckpt_paths[0], safe_load=True, return_metadata=True)
    if not is_mage_text_encoder_metadata(metadata):
        return None

    logging.info("ComfyUI-Mage: loading MageFlow Qwen3VL text encoder through native CLIPLoader.")
    if model_options.get("custom_operations", None) is None:
        sd, metadata = comfy.utils.convert_old_quants(sd, model_prefix="", metadata=metadata)

    sd = comfy.utils.state_dict_prefix_replace(
        sd,
        {
            "model.language_model.": "model.",
            "model.visual.": "visual.",
            "lm_head.": "model.lm_head.",
        },
    )
    clip_data = [sd]

    class ClipTarget:
        pass

    clip_target = ClipTarget()
    clip_target.params = {}
    clip_target.clip = mage_flow_te(**comfy.sd.llama_detect(clip_data))
    clip_target.tokenizer = MageFlowTokenizer

    parameters = comfy.utils.calculate_parameters(sd)
    tokenizer_data = {}
    tokenizer_data, model_options = comfy.text_encoders.long_clipl.model_options_long_clip(sd, tokenizer_data, model_options)
    return comfy.sd.CLIP(
        clip_target,
        embedding_directory=embedding_directory,
        parameters=parameters,
        tokenizer_data=tokenizer_data,
        state_dict=clip_data,
        model_options=model_options,
        disable_dynamic=disable_dynamic,
    )


def apply() -> None:
    global _APPLIED
    if _APPLIED:
        return
    _APPLIED = True

    if not hasattr(comfy.sd, "_comfyui_mage_original_load_diffusion_model_state_dict"):
        comfy.sd._comfyui_mage_original_load_diffusion_model_state_dict = comfy.sd.load_diffusion_model_state_dict

        def load_diffusion_model_state_dict_patched(sd, model_options={}, metadata=None, disable_dynamic=False):
            if is_mage_flow_transformer_state_dict(sd, metadata):
                logging.info("ComfyUI-Mage: loading MageFlow transformer through native Load Diffusion Model.")
                return load_mage_flow_diffusion_model_state_dict(
                    sd,
                    model_options=model_options,
                    metadata=metadata,
                    disable_dynamic=disable_dynamic,
                )
            return comfy.sd._comfyui_mage_original_load_diffusion_model_state_dict(
                sd,
                model_options=model_options,
                metadata=metadata,
                disable_dynamic=disable_dynamic,
            )

        comfy.sd.load_diffusion_model_state_dict = load_diffusion_model_state_dict_patched

    if not hasattr(comfy.sd, "_comfyui_mage_original_load_clip"):
        comfy.sd._comfyui_mage_original_load_clip = comfy.sd.load_clip

        def load_clip_patched(ckpt_paths, embedding_directory=None, clip_type=comfy.sd.CLIPType.STABLE_DIFFUSION, model_options={}, disable_dynamic=False):
            clip = _load_mage_text_encoder_clip(
                ckpt_paths,
                embedding_directory=embedding_directory,
                model_options=model_options,
                disable_dynamic=disable_dynamic,
            )
            if clip is not None:
                clip.patcher.cached_patcher_init = (
                    comfy.sd.load_clip_model_patcher,
                    (ckpt_paths, embedding_directory, clip_type, model_options),
                )
                return clip
            return comfy.sd._comfyui_mage_original_load_clip(
                ckpt_paths,
                embedding_directory=embedding_directory,
                clip_type=clip_type,
                model_options=model_options,
                disable_dynamic=disable_dynamic,
            )

        comfy.sd.load_clip = load_clip_patched

    if not hasattr(comfy.sd, "_comfyui_mage_original_vae_class"):
        comfy.sd._comfyui_mage_original_vae_class = comfy.sd.VAE
        original_vae = comfy.sd.VAE

        class MagePatchedVAE(original_vae):
            def __init__(self, sd=None, device=None, config=None, dtype=None, metadata=None):
                if config is None and is_mage_vae_state_dict(sd, metadata):
                    logging.info("ComfyUI-Mage: loading MageFlow VAE through native VAELoader.")
                    wrapper = ComfyMageVAE(sd, device=device, dtype=dtype, metadata=metadata)
                    self._comfyui_mage_wrapper = wrapper
                    for attr in ("latent_channels", "latent_dim", "downscale_ratio", "upscale_ratio", "output_channels"):
                        setattr(self, attr, getattr(wrapper, attr))
                    self.__dict__.update(wrapper.__dict__)
                    return
                super().__init__(sd=sd, device=device, config=config, dtype=dtype, metadata=metadata)

            def _mage(self):
                return self.__dict__.get("_comfyui_mage_wrapper")

            def throw_exception_if_invalid(self):
                wrapper = self._mage()
                if wrapper is not None:
                    return wrapper.throw_exception_if_invalid()
                return super().throw_exception_if_invalid()

            def model_size(self):
                wrapper = self._mage()
                if wrapper is not None:
                    return wrapper.model_size()
                return super().model_size()

            def decode(self, samples_in, vae_options={}):
                wrapper = self._mage()
                if wrapper is not None:
                    return wrapper.decode(samples_in, vae_options=vae_options)
                return super().decode(samples_in, vae_options=vae_options)

            def encode(self, pixel_samples):
                wrapper = self._mage()
                if wrapper is not None:
                    return wrapper.encode(pixel_samples)
                return super().encode(pixel_samples)

            def decode_tiled(self, samples, *args, **kwargs):
                wrapper = self._mage()
                if wrapper is not None:
                    return wrapper.decode_tiled(samples, *args, **kwargs)
                return super().decode_tiled(samples, *args, **kwargs)

            def encode_tiled(self, pixel_samples, *args, **kwargs):
                wrapper = self._mage()
                if wrapper is not None:
                    return wrapper.encode_tiled(pixel_samples, *args, **kwargs)
                return super().encode_tiled(pixel_samples, *args, **kwargs)

            def get_sd(self):
                wrapper = self._mage()
                if wrapper is not None:
                    return wrapper.get_sd()
                return super().get_sd()

            def spacial_compression_decode(self):
                wrapper = self._mage()
                if wrapper is not None:
                    return wrapper.spacial_compression_decode()
                return super().spacial_compression_decode()

            def spacial_compression_encode(self):
                wrapper = self._mage()
                if wrapper is not None:
                    return wrapper.spacial_compression_encode()
                return super().spacial_compression_encode()

        comfy.sd.VAE = MagePatchedVAE

