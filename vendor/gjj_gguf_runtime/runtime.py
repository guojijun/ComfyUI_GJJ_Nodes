# GJJ internal GGUF loader wrapper.
# Portions mirror city96/ComfyUI-GGUF node glue under Apache-2.0.

from __future__ import annotations

import collections
import inspect
import logging
from typing import Any

import comfy.float
import comfy.lora
import comfy.model_management
import comfy.model_patcher
import comfy.sd
import comfy.utils
import folder_paths
import torch

from .dequant import is_quantized, is_torch_compatible
from .loader import gguf_clip_loader, gguf_sd_loader
from .ops import GGMLOps, move_patch_to_device


class GGUFModelPatcher(comfy.model_patcher.ModelPatcher):
    patch_on_device = False
    mmap_released = False
    named_modules_to_munmap = {}

    def patch_weight_to_device(self, key, device_to=None, inplace_update=False):
        if key not in self.patches:
            return
        weight = comfy.utils.get_attr(self.model, key)
        patches = self.patches[key]
        if is_quantized(weight):
            out_weight = weight.to(device_to)
            patches = move_patch_to_device(patches, self.load_device if self.patch_on_device else self.offload_device)
            out_weight.patches = [(patches, key)]
        else:
            inplace_update = self.weight_inplace_update or inplace_update
            if key not in self.backup:
                self.backup[key] = collections.namedtuple("Dimension", ["weight", "inplace_update"])(
                    weight.to(device=self.offload_device, copy=inplace_update), inplace_update
                )
            if device_to is not None:
                temp_weight = comfy.model_management.cast_to_device(weight, device_to, torch.float32, copy=True)
            else:
                temp_weight = weight.to(torch.float32, copy=True)
            out_weight = comfy.lora.calculate_weight(patches, temp_weight, key)
            out_weight = comfy.float.stochastic_rounding(out_weight, weight.dtype)

        if inplace_update:
            comfy.utils.copy_to_param(self.model, key, out_weight)
        else:
            comfy.utils.set_attr_param(self.model, key, out_weight)

    def unpatch_model(self, device_to=None, unpatch_weights=True):
        if unpatch_weights:
            for param in self.model.parameters():
                if is_torch_compatible(param):
                    continue
                patches = getattr(param, "patches", [])
                if patches:
                    param.patches = []
        return super().unpatch_model(device_to=device_to, unpatch_weights=unpatch_weights)

    def pin_weight_to_device(self, key):
        op_key = key.rsplit(".", 1)[0]
        if not self.mmap_released and op_key in self.named_modules_to_munmap:
            self.named_modules_to_munmap[op_key].to(self.load_device).to(self.offload_device)
            del self.named_modules_to_munmap[op_key]
        super().pin_weight_to_device(key)

    def load(self, *args, force_patch_weights=False, **kwargs):
        if not self.mmap_released:
            self.named_modules_to_munmap = dict(self.model.named_modules())
        super().load(*args, force_patch_weights=True, **kwargs)
        if not self.mmap_released:
            linked = []
            if kwargs.get("lowvram_model_memory", 0) > 0:
                for name, module in self.named_modules_to_munmap.items():
                    if getattr(getattr(module, "weight", None), "device", None) == self.offload_device:
                        linked.append((name, module))
                        continue
                    if getattr(getattr(module, "bias", None), "device", None) == self.offload_device:
                        linked.append((name, module))
                        continue
            if linked and self.load_device != self.offload_device:
                logging.info("GJJ GGUF: attempting to release mmap (%s)", len(linked))
                for _name, module in linked:
                    module.to(self.load_device).to(self.offload_device)
            self.mmap_released = True
            self.named_modules_to_munmap = {}

    def clone(self, *args, **kwargs):
        src_cls = self.__class__
        self.__class__ = GGUFModelPatcher
        cloned = super().clone(*args, **kwargs)
        cloned.__class__ = GGUFModelPatcher
        self.__class__ = src_cls
        cloned.patch_on_device = getattr(self, "patch_on_device", False)
        cloned.mmap_released = getattr(self, "mmap_released", False)
        if src_cls != GGUFModelPatcher:
            cloned.size = 0
        return cloned


def _gguf_ops(dequant_dtype: str | None = None, patch_dtype: str | None = None) -> GGMLOps:
    ops = GGMLOps()
    for attr_name, value in (("dequant_dtype", dequant_dtype), ("patch_dtype", patch_dtype)):
        if value in ("default", None):
            setattr(ops.Linear, attr_name, None)
        elif value == "target":
            setattr(ops.Linear, attr_name, value)
        else:
            setattr(ops.Linear, attr_name, getattr(torch, str(value)))
    return ops


def _full_path(category: str, name: str) -> str | None:
    path = folder_paths.get_full_path(category, name)
    if path:
        return path
    return None


def _full_path_or_raise(categories: tuple[str, ...], name: str) -> str:
    for category in categories:
        path = _full_path(category, name)
        if path:
            return path
    raise RuntimeError(f"找不到 GGUF 模型文件：{name}")


def load_unet_gguf(
    unet_name: str,
    *,
    dequant_dtype: str | None = None,
    patch_dtype: str | None = None,
    patch_on_device: bool | None = False,
) -> Any:
    ops = _gguf_ops(dequant_dtype, patch_dtype)
    unet_path = _full_path_or_raise(("unet", "unet_gguf", "diffusion_models"), unet_name)
    sd, extra = gguf_sd_loader(unet_path)

    kwargs = {}
    valid_params = inspect.signature(comfy.sd.load_diffusion_model_state_dict).parameters
    if "metadata" in valid_params:
        kwargs["metadata"] = extra.get("metadata", {})
    model = comfy.sd.load_diffusion_model_state_dict(sd, model_options={"custom_operations": ops}, **kwargs)
    if model is None:
        raise RuntimeError(f"无法识别 GGUF UNET 模型类型：{unet_path}")
    model = GGUFModelPatcher.clone(model)
    model.patch_on_device = bool(patch_on_device)
    return model


def _clip_type(value: str):
    return getattr(comfy.sd.CLIPType, str(value or "stable_diffusion").upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)


def load_clip_gguf(clip_name: str, clip_type: str = "stable_diffusion") -> Any:
    clip_path = _full_path_or_raise(("clip", "clip_gguf", "text_encoders"), clip_name)
    sd = gguf_clip_loader(clip_path)
    clip = comfy.sd.load_text_encoder_state_dicts(
        clip_type=_clip_type(clip_type),
        state_dicts=[sd],
        model_options={
            "custom_operations": GGMLOps,
            "initial_device": comfy.model_management.text_encoder_offload_device(),
        },
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
    )
    clip.patcher = GGUFModelPatcher.clone(clip.patcher)
    return clip
