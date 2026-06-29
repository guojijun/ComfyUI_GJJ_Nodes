# GJJ internal GGUF loader wrapper.
# Portions mirror city96/ComfyUI-GGUF node glue under Apache-2.0.

from __future__ import annotations

import collections
import inspect
import json
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

from .dequant import dequantize_tensor, is_quantized, is_torch_compatible
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
    unet_path = _full_path_or_raise(("unet", "unet_gguf", "diffusion_models", "checkpoints"), unet_name)
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


def _real_tensor_for_aux(tensor: Any) -> Any:
    if is_quantized(tensor):
        return dequantize_tensor(tensor, dtype=torch.float32)
    return tensor


def _materialize_aux_tensors(sd: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in sd.items():
        if not _is_ltx_checkpoint_aux_key(key):
            result[key] = value
        else:
            result[key] = _real_tensor_for_aux(value)
    return result


def _is_ltx_checkpoint_aux_key(key: str) -> bool:
    return str(key).startswith(("vae.", "audio_vae.", "vocoder.", "text_encoders."))


def _diffusion_state_dict_from_checkpoint(sd: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in sd.items() if not _is_ltx_checkpoint_aux_key(key)}


def _shape_dim(sd: dict[str, Any], key: str, index: int, default: int | None = None) -> int | None:
    tensor = sd.get(key)
    if tensor is None:
        return default
    try:
        return int(tensor.shape[index])
    except Exception:
        return default


def _ensure_ltxav_metadata(metadata: dict[str, Any], sd: dict[str, Any]) -> dict[str, Any]:
    result = dict(metadata or {})
    try:
        config = json.loads(str(result.get("config") or "{}"))
    except Exception:
        config = {}
    transformer = dict(config.get("transformer") or {})
    if str(transformer.get("_class_name") or "") != "AVTransformer3DModel":
        if not any(
            str(key).startswith(("model.diffusion_model.audio_embeddings_connector.", "audio_embeddings_connector."))
            for key in sd
        ):
            return result
        transformer["_class_name"] = "AVTransformer3DModel"

    audio_dim = _shape_dim(sd, "model.diffusion_model.audio_embeddings_connector.learnable_registers", 1)
    audio_dim = _shape_dim(sd, "audio_embeddings_connector.learnable_registers", 1, audio_dim)
    video_dim = _shape_dim(sd, "model.diffusion_model.video_embeddings_connector.learnable_registers", 1)
    video_dim = _shape_dim(sd, "video_embeddings_connector.learnable_registers", 1, video_dim)
    scale_shift_count = _shape_dim(sd, "model.diffusion_model.transformer_blocks.0.scale_shift_table", 0)
    scale_shift_count = _shape_dim(sd, "transformer_blocks.0.scale_shift_table", 0, scale_shift_count)
    if audio_dim:
        transformer["audio_cross_attention_dim"] = audio_dim
        transformer["audio_connector_attention_head_dim"] = 64 if audio_dim == 2048 else min(128, audio_dim)
    if video_dim:
        transformer["cross_attention_dim"] = video_dim
    transformer.setdefault("caption_channels", 3840)
    if scale_shift_count == 9:
        transformer["cross_attention_adaln"] = True
    transformer.setdefault("audio_connector_num_attention_heads", 32)
    transformer.setdefault("connector_num_attention_heads", 32)
    transformer.setdefault("connector_num_layers", 8)
    transformer.setdefault("connector_num_learnable_registers", 128)
    transformer.setdefault("connector_attention_head_dim", 128)
    transformer.setdefault("connector_learnable_registers_std", 1)
    transformer.setdefault("connector_positional_embedding_max_pos", [4096])
    transformer.setdefault("connector_norm_output", True)
    transformer.setdefault("use_embeddings_connector", True)
    transformer.setdefault("caption_proj_before_connector", True)
    transformer.setdefault("use_middle_indices_grid", True)
    transformer.setdefault("apply_gated_attention", True)
    transformer.setdefault("connector_apply_gated_attention", True)
    transformer.setdefault("rope_type", "split")
    transformer.setdefault("frequencies_precision", "float64")

    config["transformer"] = transformer
    result["config"] = json.dumps(config)
    return result


def _audio_vae_state_dict_from_checkpoint(sd: dict[str, Any]) -> dict[str, Any]:
    audio_sd: dict[str, Any] = {}
    for key, value in sd.items():
        if key.startswith("audio_vae."):
            audio_sd["autoencoder." + key[len("audio_vae."):]] = _real_tensor_for_aux(value)
        elif key.startswith("vocoder."):
            audio_sd[key] = _real_tensor_for_aux(value)
    return audio_sd


def _video_vae_state_dict_from_checkpoint(sd: dict[str, Any]) -> dict[str, Any]:
    video_sd: dict[str, Any] = {}
    for key, value in sd.items():
        if key.startswith("vae."):
            video_sd[key[len("vae."):]] = _real_tensor_for_aux(value)
    return video_sd


def load_ltx_checkpoint_gguf(
    ckpt_name: str,
    *,
    dequant_dtype: str | None = None,
    patch_dtype: str | None = None,
    patch_on_device: bool | None = False,
) -> tuple[Any, Any, Any]:
    ops = _gguf_ops(dequant_dtype, patch_dtype)
    ckpt_path = _full_path_or_raise(("checkpoints", "unet", "unet_gguf", "diffusion_models"), ckpt_name)
    sd, extra = gguf_sd_loader(ckpt_path, handle_prefix=None)
    metadata = _ensure_ltxav_metadata(extra.get("metadata", {}), sd)
    video_sd = _video_vae_state_dict_from_checkpoint(sd)
    audio_sd = _audio_vae_state_dict_from_checkpoint(sd)
    if not video_sd or not audio_sd:
        missing = []
        if not video_sd:
            missing.append("video VAE")
        if not audio_sd:
            missing.append("audio VAE/vocoder")
        raise RuntimeError(
            "当前 GGUF 文件不是完整的 LTX checkpoint，无法从同一个文件拆出"
            f"{'、'.join(missing)} 权重：{ckpt_path}"
        )

    model_sd = _diffusion_state_dict_from_checkpoint(sd)

    model = comfy.sd.load_diffusion_model_state_dict(
        model_sd,
        model_options={"custom_operations": ops},
        metadata=metadata,
    )
    if model is None:
        raise RuntimeError(f"无法识别 GGUF LTX checkpoint 主模型：{ckpt_path}")
    model = GGUFModelPatcher.clone(model)
    model.patch_on_device = bool(patch_on_device)

    video_vae = comfy.sd.VAE(sd=video_sd, metadata=metadata)
    video_vae.throw_exception_if_invalid()

    audio_vae = comfy.sd.VAE(sd=audio_sd, metadata=metadata)
    audio_vae.throw_exception_if_invalid()

    return model, video_vae, audio_vae


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


def load_dual_clip_gguf(clip_name1: str, clip_name2: str, clip_type: str = "ltxv", device: str = "default") -> Any:
    state_dicts: list[dict[str, Any]] = []
    has_gguf = False
    for clip_name in (clip_name1, clip_name2):
        clip_path = _full_path_or_raise(("clip", "clip_gguf", "text_encoders"), clip_name)
        if str(clip_name or "").lower().endswith(".gguf"):
            state_dicts.append(gguf_clip_loader(clip_path))
            has_gguf = True
        else:
            state_dicts.append(comfy.utils.load_torch_file(clip_path, safe_load=True))

    model_options: dict[str, Any] = {}
    if has_gguf:
        model_options["custom_operations"] = GGMLOps
    if str(device or "default") == "cpu":
        cpu = torch.device("cpu")
        model_options["load_device"] = cpu
        model_options["offload_device"] = cpu

    clip = comfy.sd.load_text_encoder_state_dicts(
        clip_type=_clip_type(clip_type),
        state_dicts=state_dicts,
        model_options=model_options,
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
    )
    if has_gguf:
        clip.patcher = GGUFModelPatcher.clone(clip.patcher)
    return clip


def load_ltxav_text_encoder_gguf(text_encoder_name: str, ckpt_name: str, device: str = "default") -> Any:
    text_encoder_path = _full_path_or_raise(("text_encoders", "clip"), text_encoder_name)
    ckpt_path = _full_path_or_raise(("checkpoints", "unet", "unet_gguf", "diffusion_models"), ckpt_name)
    text_sd = comfy.utils.load_torch_file(text_encoder_path, safe_load=True)
    ckpt_sd, _extra = gguf_sd_loader(ckpt_path, handle_prefix=None)

    model_options: dict[str, Any] = {"custom_operations": GGMLOps}
    if str(device or "default") == "cpu":
        cpu = torch.device("cpu")
        model_options["load_device"] = cpu
        model_options["offload_device"] = cpu

    clip = comfy.sd.load_text_encoder_state_dicts(
        clip_type=comfy.sd.CLIPType.LTXV,
        state_dicts=[text_sd, ckpt_sd],
        model_options=model_options,
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
    )
    clip.patcher = GGUFModelPatcher.clone(clip.patcher)
    return clip
