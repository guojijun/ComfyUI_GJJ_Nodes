from __future__ import annotations

import logging
from typing import Any

import torch


NODE_NAME = "GJJ_MiniMaxH3MemoryEfficientSageAttentionPatch"
LOG = logging.getLogger(__name__)


def _load_runtime():
    try:
        from sageattention import sageattn
    except Exception as exc:
        raise RuntimeError(
            "GJJ MiniMax H3 显存优化 SageAttention 补丁需要 sageattention，"
            "但当前 ComfyUI Python 环境无法导入其公开 sageattn 接口。"
        ) from exc

    try:
        import comfy.model_management as model_management
        from comfy.ldm.minimax.model import MiniMaxH3Model
        from comfy.quant_ops import ck
    except Exception as exc:
        raise RuntimeError(
            "当前 ComfyUI 版本缺少原生 MiniMax H3 或 fused RMSNorm/RoPE 支持，"
            "无法应用显存优化 SageAttention 补丁。"
        ) from exc
    return sageattn, model_management, MiniMaxH3Model, ck


def _make_memory_efficient_forward(sageattn, model_management, ck):
    def minimax_h3_memory_efficient_sage_attention_forward(
        self,
        x: torch.Tensor,
        rope_freqs: torch.Tensor | None = None,
        transformer_options: dict[str, Any] | None = None,
    ) -> torch.Tensor:
        del transformer_options
        dtype = x.dtype
        sequence_length = int(x.shape[0])

        # Keep q/k/v as views into the fused projection. SageAttention consumes
        # NHD tensors directly, avoiding ComfyUI's additional attention reshape
        # and full-size score buffers on long packed H3 sequences.
        q, k, v = self.qkv_proj(x).split(self.heads * self.head_dim, dim=-1)
        q = q.view(1, sequence_length, self.heads, self.head_dim)
        k = k.view(1, sequence_length, self.heads, self.head_dim)
        v = v.view(1, sequence_length, self.heads, self.head_dim)

        if rope_freqs is not None:
            q_weight = model_management.cast_to(self.q_norm.weight, device=x.device)
            k_weight = model_management.cast_to(self.k_norm.weight, device=x.device)
            ck.rms_rope_split_half_(
                q,
                k,
                rope_freqs,
                q_weight,
                k_weight,
                epsilon=self.q_norm.eps,
                rot_dim=rope_freqs.shape[-3] * 2,
            )
        else:
            q = self.q_norm(q)
            k = self.k_norm(k)

        input_dtype = v.dtype
        if q.dtype == torch.float32 or k.dtype == torch.float32 or v.dtype == torch.float32:
            q = q.to(torch.float16)
            k = k.to(torch.float16)
            v = v.to(torch.float16)

        output = sageattn(
            q,
            k,
            v,
            tensor_layout="NHD",
            is_causal=False,
        ).to(input_dtype)
        return self.out_proj(output.reshape(sequence_length, self.heads * self.head_dim)).to(dtype)

    return minimax_h3_memory_efficient_sage_attention_forward


class GJJ_MiniMaxH3MemoryEfficientSageAttentionPatch:
    CATEGORY = "GJJ/⚡ 模型优化"
    FUNCTION = "patch"
    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    DESCRIPTION = (
        "零 KJNodes 依赖复刻 MiniMax H3 Memory Efficient SageAttention："
        "逐块替换原生 H3 自注意力，以降低长序列注意力的峰值显存。"
    )
    SEARCH_ALIASES = [
        "MiniMax H3 Memory Efficient Sage Attention Patch",
        "MiniMax H3 显存优化",
        "H3 SageAttention",
    ]
    GJJ_HELP = {
        "title": "MiniMax H3 显存优化 SageAttention",
        "description": DESCRIPTION,
        "requirements": [
            "输入必须是 ComfyUI 原生 MiniMaxH3Model。",
            "运行环境需要可用的 sageattention；节点本身不依赖 KJNodes。",
            "此节点会覆盖模型已有的 MiniMax H3 block attention forward 补丁。",
        ],
        "usage": ["接在 MiniMax H3 模型加载器之后、采样器之前。"],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",)}}

    def patch(self, model):
        sageattn, model_management, minimax_h3_model, ck = _load_runtime()
        model_clone = model.clone()
        diffusion_model = model_clone.get_model_object("diffusion_model")
        if not isinstance(diffusion_model, minimax_h3_model):
            actual = f"{type(diffusion_model).__module__}.{type(diffusion_model).__name__}"
            raise TypeError(
                "GJJ MiniMax H3 显存优化 SageAttention 补丁只能应用于 "
                f"ComfyUI 原生 MiniMaxH3Model；当前模型为 {actual}。"
            )
        blocks = getattr(diffusion_model, "blocks", None)
        if not blocks:
            raise RuntimeError("MiniMax H3 模型没有可补丁的 Transformer blocks。")

        forward = _make_memory_efficient_forward(sageattn, model_management, ck)
        for index, block in enumerate(blocks):
            attention = getattr(block, "attn", None)
            if attention is None:
                raise RuntimeError(f"MiniMax H3 第 {index} 个 block 缺少 attn 模块。")
            model_clone.add_object_patch(
                f"diffusion_model.blocks.{index}.attn.forward",
                forward.__get__(attention, attention.__class__),
            )

        LOG.info("[GJJ] 已为 MiniMax H3 的 %d 个 Transformer blocks 应用显存优化 SageAttention。", len(blocks))
        return (model_clone,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MiniMaxH3MemoryEfficientSageAttentionPatch}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · MiniMax H3 显存优化 SageAttention"}
