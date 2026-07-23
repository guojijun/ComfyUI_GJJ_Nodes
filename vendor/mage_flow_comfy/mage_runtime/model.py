from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from typing import Any

import torch
import torch.nn as nn

import comfy.conds
import comfy.latent_formats
import comfy.model_base
import comfy.model_management
import comfy.model_patcher
import comfy.ops
import comfy.utils

from .transformer import (
    AdaLayerNormContinuous,
    MageFlowEmbedRope,
    MageFlowTimestepProjEmbeddings,
    MageFlowTransformerBlock,
    RMSNorm,
    TorchOps,
)


MAGE_TRANSFORMER_FORMAT = "mage_flow.transformer"
DEFAULT_AXES_DIM = [16, 56, 56]
DEFAULT_STATIC_SHIFT = 6.0


@dataclass(frozen=True)
class MageFlowParams:
    in_channels: int
    out_channels: int
    context_in_dim: int
    hidden_size: int
    num_heads: int
    depth: int
    axes_dim: list[int]
    checkpoint: bool = False
    patch_size: int = 1
    static_shift: float = DEFAULT_STATIC_SHIFT


class MageFlowLatentFormat(comfy.latent_formats.LatentFormat):
    scale_factor = 1.0
    latent_channels = 128
    latent_dimensions = 2
    spacial_downscale_ratio = 16

    def process_in(self, latent):
        return latent

    def process_out(self, latent):
        return latent


class MageFlowModelConfig:
    supported_inference_dtypes = [torch.bfloat16, torch.float16, torch.float32]
    memory_usage_factor = 2.0
    custom_operations = None
    quant_config = None

    def __init__(self, params: MageFlowParams):
        self.params = params
        self.latent_format = MageFlowLatentFormat()
        self.sampling_settings = {"shift": float(params.static_shift), "multiplier": 1000}
        self.optimizations = {"fp8": False}
        self.manual_cast_dtype = None
        self.unet_config = {
            "in_channels": params.in_channels,
            "out_channels": params.out_channels,
            "context_in_dim": params.context_in_dim,
            "hidden_size": params.hidden_size,
            "num_heads": params.num_heads,
            "depth": params.depth,
            "axes_dim": params.axes_dim,
            "checkpoint": params.checkpoint,
            "patch_size": params.patch_size,
        }

    def set_inference_dtype(self, dtype, manual_cast_dtype, device=None):
        self.unet_config["dtype"] = dtype
        self.manual_cast_dtype = manual_cast_dtype

    def process_unet_state_dict(self, state_dict):
        return state_dict


class MageFlow(nn.Module):
    def __init__(
        self,
        in_channels: int = 128,
        out_channels: int = 128,
        context_in_dim: int = 2560,
        hidden_size: int = 3072,
        num_heads: int = 24,
        depth: int = 12,
        axes_dim: list[int] | None = None,
        checkpoint: bool = False,
        patch_size: int = 1,
        dtype=None,
        device=None,
        operations=None,
        **_ignored,
    ):
        super().__init__()
        ops = operations or TorchOps
        axes_dim = axes_dim or DEFAULT_AXES_DIM
        attention_head_dim = hidden_size // num_heads
        if sum(axes_dim) != attention_head_dim:
            raise ValueError(f"MageFlow axes_dim {axes_dim} must sum to head dim {attention_head_dim}.")

        self.dtype = dtype
        self.checkpoint = checkpoint
        self.in_channels = in_channels
        self.out_channels = out_channels
        self.inner_dim = hidden_size
        self.axes_dim = list(axes_dim)
        self.num_attention_heads = num_heads
        self.attention_head_dim = attention_head_dim
        self.patch_size = patch_size

        self.pos_embed = MageFlowEmbedRope(theta=10000, axes_dim=self.axes_dim, scale_rope=True)
        self.img_in = ops.Linear(in_channels, self.inner_dim, bias=True, dtype=dtype, device=device)
        if hasattr(ops, "RMSNorm"):
            self.txt_norm = ops.RMSNorm(context_in_dim, eps=1e-6, dtype=dtype, device=device)
        else:
            self.txt_norm = RMSNorm(context_in_dim, eps=1e-6, dtype=dtype, device=device)
        self.txt_in = ops.Linear(context_in_dim, self.inner_dim, bias=True, dtype=dtype, device=device)
        self.time_text_embed = MageFlowTimestepProjEmbeddings(
            embedding_dim=self.inner_dim,
            dtype=dtype,
            device=device,
            operations=ops,
        )
        self.transformer_blocks = nn.ModuleList(
            [
                MageFlowTransformerBlock(
                    dim=self.inner_dim,
                    num_attention_heads=self.num_attention_heads,
                    attention_head_dim=self.attention_head_dim,
                    dtype=dtype,
                    device=device,
                    operations=ops,
                )
                for _ in range(depth)
            ]
        )
        self.norm_out = AdaLayerNormContinuous(
            self.inner_dim,
            self.inner_dim,
            elementwise_affine=False,
            eps=1e-6,
            dtype=dtype,
            device=device,
            operations=ops,
        )
        self.proj_out = ops.Linear(
            self.inner_dim,
            patch_size * patch_size * out_channels,
            bias=True,
            dtype=dtype,
            device=device,
        )

    def forward(
        self,
        img: torch.Tensor,
        txt: torch.Tensor,
        timesteps: torch.Tensor,
        img_shapes=None,
        img_cu_seqlens: torch.Tensor | None = None,
        txt_cu_seqlens: torch.Tensor | None = None,
        attention_kwargs: dict[str, Any] | None = None,
        **_ignored,
    ) -> torch.Tensor:
        if img.ndim != 3 or txt.ndim != 3:
            raise ValueError("MageFlow expects packed img and txt tensors with shape [1, total_tokens, dim].")

        ms_pe = self.pos_embed(img_shapes, device=img.device)
        img = self.img_in(img)
        txt = self.txt_norm(txt)
        timesteps = timesteps.to(img.dtype)
        temb = self.time_text_embed(timesteps, img)
        txt = self.txt_in(txt)
        attention_kwargs = attention_kwargs or {}

        for block in self.transformer_blocks:
            txt, img = block(
                hidden_states=img,
                encoder_hidden_states=txt,
                txt_cu_lens=txt_cu_seqlens,
                img_cu_lens=img_cu_seqlens,
                temb=temb,
                image_rotary_emb=ms_pe,
                joint_attention_kwargs=attention_kwargs,
            )

        img = self.norm_out(img, temb, cu_seqlens=img_cu_seqlens)
        return self.proj_out(img)


def _lens_to_cu(lens: list[int], device: torch.device) -> torch.Tensor:
    t = torch.tensor(lens, device=device, dtype=torch.int32)
    return torch.cat([torch.zeros(1, dtype=torch.int32, device=device), torch.cumsum(t, dim=0, dtype=torch.int32)])


def _pack_text(context: torch.Tensor, attention_mask: torch.Tensor | None) -> tuple[torch.Tensor, torch.Tensor, list[int]]:
    batch, text_len, _ = context.shape
    lens: list[int] = []
    pieces = []
    if attention_mask is not None:
        attention_mask = attention_mask.to(device=context.device)
        if attention_mask.ndim > 2:
            attention_mask = attention_mask.reshape(attention_mask.shape[0], -1)
    for i in range(batch):
        if attention_mask is None:
            length = text_len
        else:
            length = int(attention_mask[i].sum().item())
            length = max(1, min(length, text_len))
        lens.append(length)
        pieces.append(context[i, :length])
    return torch.cat(pieces, dim=0).unsqueeze(0), _lens_to_cu(lens, context.device), lens


def _flatten_latent(latent: torch.Tensor) -> torch.Tensor:
    return latent.movedim(1, -1).reshape(latent.shape[0], -1, latent.shape[1])


class MageFlowComfyModel(comfy.model_base.BaseModel):
    def __init__(self, model_config: MageFlowModelConfig, device=None):
        super().__init__(
            model_config,
            model_type=comfy.model_base.ModelType.FLOW,
            device=device,
            unet_model=MageFlow,
        )
        self.memory_usage_factor_conds = ("ref_latents",)

    def extra_conds(self, **kwargs):
        out = {}
        cross_attn = kwargs.get("cross_attn", None)
        if cross_attn is not None:
            out["c_crossattn"] = comfy.conds.CONDRegular(cross_attn)

        attention_mask = kwargs.get("attention_mask", None)
        if attention_mask is not None:
            out["attention_mask"] = comfy.conds.CONDRegular(attention_mask)

        ref_latents = kwargs.get("reference_latents", None)
        if ref_latents is not None:
            out["ref_latents"] = comfy.conds.CONDList([self.process_latent_in(lat) for lat in ref_latents])
        return out

    def extra_conds_shapes(self, **kwargs):
        ref_latents = kwargs.get("reference_latents", None)
        if ref_latents is None:
            return {}
        total = sum(math.prod(lat.size()[2:]) for lat in ref_latents)
        return {"ref_latents": [1, self.model_config.params.in_channels, total]}

    def _apply_model(self, x, t, c_concat=None, c_crossattn=None, control=None, transformer_options={}, **kwargs):
        if c_concat is not None:
            raise RuntimeError("MageFlow does not support concatenated latent conditioning on the native path.")
        if c_crossattn is None:
            raise RuntimeError("MageFlow requires conditioning from the MageFlow Conditioning node.")

        sigma = t
        xc = self.model_sampling.calculate_input(sigma, x)
        dtype = self.get_dtype_inference()
        device = xc.device
        xc = xc.to(dtype)
        context = comfy.model_management.cast_to_device(c_crossattn, device, dtype)

        attention_mask = kwargs.get("attention_mask", None)
        if attention_mask is not None:
            attention_mask = comfy.model_management.cast_to_device(attention_mask, device, None)

        txt, txt_cu, _txt_lens = _pack_text(context, attention_mask)

        batch, channels, h, w = xc.shape
        target_len = h * w
        target_tokens = _flatten_latent(xc)

        ref_latents = kwargs.get("ref_latents", None)
        img_pieces = []
        img_lens: list[int] = []
        img_shapes: list[tuple[int, int, int]] = []
        target_offsets: list[tuple[int, int]] = []
        running = 0
        for i in range(batch):
            start = running
            img_pieces.append(target_tokens[i])
            running += target_len
            img_shapes.append((1, h, w))
            sample_len = target_len
            if ref_latents is not None:
                for ref in ref_latents:
                    ref_i = comfy.model_management.cast_to_device(ref[i : i + 1], device, dtype)
                    _, _, rh, rw = ref_i.shape
                    ref_tokens = _flatten_latent(ref_i)[0]
                    img_pieces.append(ref_tokens)
                    running += rh * rw
                    sample_len += rh * rw
                    img_shapes.append((1, rh, rw))
            img_lens.append(sample_len)
            target_offsets.append((start, target_len))

        img = torch.cat(img_pieces, dim=0).unsqueeze(0)
        img_cu = _lens_to_cu(img_lens, device)
        sigma_vec = sigma.flatten().to(device=device, dtype=dtype)
        if sigma_vec.numel() == 1 and batch > 1:
            sigma_vec = sigma_vec.repeat(batch)

        velocity = self.diffusion_model(
            img=img,
            txt=txt,
            timesteps=sigma_vec,
            img_shapes=[img_shapes],
            img_cu_seqlens=img_cu,
            txt_cu_seqlens=txt_cu,
            transformer_options=transformer_options,
        )

        out = torch.empty_like(xc)
        for i, (start, length) in enumerate(target_offsets):
            out[i] = velocity[:, start : start + length, :].reshape(h, w, channels).permute(2, 0, 1)

        return self.model_sampling.calculate_denoised(sigma, out.float(), x)


def is_mage_flow_transformer_state_dict(sd: dict[str, torch.Tensor], metadata: dict[str, Any] | None = None) -> bool:
    if metadata and metadata.get("comfyui_mage.format") == MAGE_TRANSFORMER_FORMAT:
        return True
    required = (
        "img_in.weight",
        "txt_norm.weight",
        "txt_in.weight",
        "time_text_embed.timestep_embedder.linear_1.weight",
        "transformer_blocks.0.attn.to_q.weight",
        "transformer_blocks.0.attn.add_q_proj.weight",
        "norm_out.linear.weight",
        "proj_out.weight",
    )
    return all(k in sd for k in required) and sd["img_in.weight"].shape[1] == 128


def infer_mage_flow_params(sd: dict[str, torch.Tensor], metadata: dict[str, Any] | None = None) -> MageFlowParams:
    if metadata:
        raw = metadata.get("comfyui_mage.transformer_config") or metadata.get("mage_flow.transformer_config")
        if raw:
            try:
                cfg = json.loads(raw)
                return MageFlowParams(
                    in_channels=int(cfg.get("in_channels", 128)),
                    out_channels=int(cfg.get("out_channels", 128)),
                    context_in_dim=int(cfg.get("context_in_dim", 2560)),
                    hidden_size=int(cfg.get("hidden_size", 3072)),
                    num_heads=int(cfg.get("num_heads", 24)),
                    depth=int(cfg.get("depth", 12)),
                    axes_dim=list(cfg.get("axes_dim", DEFAULT_AXES_DIM)),
                    checkpoint=bool(cfg.get("checkpoint", False)),
                    patch_size=int(cfg.get("patch_size", 1)),
                    static_shift=float(cfg.get("static_shift", DEFAULT_STATIC_SHIFT)),
                )
            except Exception as exc:
                logging.warning("Ignoring invalid MageFlow transformer metadata: %s", exc)

    hidden_size = int(sd["img_in.weight"].shape[0])
    in_channels = int(sd["img_in.weight"].shape[1])
    context_in_dim = int(sd["txt_norm.weight"].shape[0])
    head_dim = int(sd["transformer_blocks.0.attn.norm_q.weight"].shape[0])
    num_heads = hidden_size // head_dim
    depth = 0
    while f"transformer_blocks.{depth}.img_mod.1.weight" in sd:
        depth += 1
    out_channels = int(sd["proj_out.weight"].shape[0])
    axes_dim = DEFAULT_AXES_DIM if head_dim == sum(DEFAULT_AXES_DIM) else [head_dim // 8, head_dim * 7 // 16, head_dim * 7 // 16]
    return MageFlowParams(
        in_channels=in_channels,
        out_channels=out_channels,
        context_in_dim=context_in_dim,
        hidden_size=hidden_size,
        num_heads=num_heads,
        depth=depth,
        axes_dim=axes_dim,
        checkpoint=False,
        patch_size=1,
        static_shift=DEFAULT_STATIC_SHIFT,
    )


def load_mage_flow_diffusion_model_state_dict(sd, model_options=None, metadata=None, disable_dynamic=False):
    model_options = model_options or {}
    if model_options.get("custom_operations", None) is None:
        sd, metadata = comfy.utils.convert_old_quants(sd, "", metadata=metadata)
    params = infer_mage_flow_params(sd, metadata)
    model_config = MageFlowModelConfig(params)
    quant_config = comfy.utils.detect_layer_quantization(sd, "")
    if quant_config:
        model_config.quant_config = quant_config
        logging.info("MageFlow: detected mixed precision quantization.")

    parameters = comfy.utils.calculate_parameters(sd)
    weight_dtype = comfy.utils.weight_dtype(sd)
    load_device = model_options.get("load_device", comfy.model_management.get_torch_device())
    dtype = model_options.get("dtype", model_options.get("weight_dtype", None))
    if model_config.quant_config is not None:
        weight_dtype = None
    if dtype is None:
        dtype = comfy.model_management.unet_dtype(
            model_params=parameters,
            supported_dtypes=list(model_config.supported_inference_dtypes),
            weight_dtype=weight_dtype,
        )
    manual_cast_source = None if model_config.quant_config is not None else dtype
    manual_cast_dtype = comfy.model_management.unet_manual_cast(
        manual_cast_source,
        load_device,
        list(model_config.supported_inference_dtypes),
    )
    model_config.set_inference_dtype(dtype, manual_cast_dtype, device=load_device)

    custom_operations = model_options.get("custom_operations", None)
    if custom_operations is not None:
        model_config.custom_operations = custom_operations
    if model_options.get("fp8_optimizations", False):
        model_config.optimizations["fp8"] = True

    initial_device = comfy.model_management.unet_inital_load_device(parameters, dtype)
    model = MageFlowComfyModel(model_config, device=initial_device)
    ModelPatcher = comfy.model_patcher.ModelPatcher if disable_dynamic else comfy.model_patcher.CoreModelPatcher
    offload_device = model_options.get("offload_device", comfy.model_management.unet_offload_device())
    model_patcher = ModelPatcher(model, load_device=load_device, offload_device=offload_device)
    if not comfy.model_management.is_device_cpu(offload_device):
        model.to(offload_device)
    model.load_model_weights(sd, "", assign=model_patcher.is_dynamic())
    return model_patcher
