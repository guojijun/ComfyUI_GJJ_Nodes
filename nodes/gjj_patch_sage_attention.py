from __future__ import annotations

import logging
import importlib

try:
    import torch
except Exception:
    torch = None


NODE_NAME = "GJJ_PatchSageAttentionKJ"
NODE_DISPLAY_NAME = "GJJ · ⚡ Sage注意力补丁"

SAGE_ATTENTION_MODES = [
    "关闭",
    "自动",
    "int8_fp16_cuda",
    "int8_fp16_triton",
    "int8_fp8_cuda",
    "int8_fp8_cuda_plus",
    "sageattn3",
    "sageattn3_分块均值",
]

SAGE_ATTENTION_MAP = {
    "关闭": "disabled",
    "自动": "auto",
    "int8_fp16_cuda": "sageattn_qk_int8_pv_fp16_cuda",
    "int8_fp16_triton": "sageattn_qk_int8_pv_fp16_triton",
    "int8_fp8_cuda": "sageattn_qk_int8_pv_fp8_cuda",
    "int8_fp8_cuda_plus": "sageattn_qk_int8_pv_fp8_cuda++",
    "sageattn3": "sageattn3",
    "sageattn3_分块均值": "sageattn3_per_block_mean",
}


def _load_runtime_dependency(module_name: str, package_name: str, description: str, unique_id=None):
    try:
        from .common_utils.dependency_checker import load_dependency_at_runtime

        return load_dependency_at_runtime(
            module_name,
            NODE_DISPLAY_NAME,
            package_name=package_name,
            description=description,
            unique_id=unique_id,
        )
    except Exception as helper_exc:
        try:
            return importlib.import_module(module_name)
        except Exception as exc:
            raise RuntimeError(
                f"{description}\n请先安装 {package_name}，然后重启 ComfyUI。原始错误：{exc}"
            ) from helper_exc


def _load_sage_attention_func(sage_attention: str, allow_compile: bool = False, unique_id=None):
    if torch is None:
        raise RuntimeError("PyTorch 未加载，无法启用 SageAttention。")

    try:
        from comfy.ldm.modules.attention import attention_pytorch, wrap_attn
    except Exception as exc:
        raise RuntimeError(f"无法导入 ComfyUI 注意力模块：{exc}") from exc

    logging.info("[GJJ] 使用 SageAttention 模式：%s", sage_attention)

    if sage_attention == "auto":
        sageattention = _load_runtime_dependency(
            "sageattention",
            package_name="sageattention",
            description="SageAttention 注意力补丁需要 sageattention 运行库。",
            unique_id=unique_id,
        )
        sageattn = sageattention.sageattn

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn(q, k, v, is_causal=is_causal, attn_mask=attn_mask, tensor_layout=tensor_layout)

    elif sage_attention == "sageattn_qk_int8_pv_fp16_cuda":
        sageattention = _load_runtime_dependency(
            "sageattention",
            package_name="sageattention",
            description="当前模式需要 sageattention 的 int8/fp16 CUDA 后端。",
            unique_id=unique_id,
        )
        try:
            sageattn_qk_int8_pv_fp16_cuda = sageattention.sageattn_qk_int8_pv_fp16_cuda
        except AttributeError as exc:
            raise RuntimeError("当前 sageattention 已安装，但缺少 int8/fp16 CUDA 后端；请升级或安装匹配 CUDA 的版本。") from exc

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp16_cuda(
                q, k, v, is_causal=is_causal, attn_mask=attn_mask, pv_accum_dtype="fp32", tensor_layout=tensor_layout
            )

    elif sage_attention == "sageattn_qk_int8_pv_fp16_triton":
        sageattention = _load_runtime_dependency(
            "sageattention",
            package_name="sageattention",
            description="当前模式需要 sageattention 的 int8/fp16 Triton 后端。",
            unique_id=unique_id,
        )
        try:
            sageattn_qk_int8_pv_fp16_triton = sageattention.sageattn_qk_int8_pv_fp16_triton
        except AttributeError as exc:
            raise RuntimeError("当前 sageattention 已安装，但缺少 int8/fp16 Triton 后端；请升级 sageattention。") from exc

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp16_triton(q, k, v, is_causal=is_causal, attn_mask=attn_mask, tensor_layout=tensor_layout)

    elif sage_attention == "sageattn_qk_int8_pv_fp8_cuda":
        sageattention = _load_runtime_dependency(
            "sageattention",
            package_name="sageattention",
            description="当前模式需要 sageattention 的 int8/fp8 CUDA 后端。",
            unique_id=unique_id,
        )
        try:
            sageattn_qk_int8_pv_fp8_cuda = sageattention.sageattn_qk_int8_pv_fp8_cuda
        except AttributeError as exc:
            raise RuntimeError("当前 sageattention 已安装，但缺少 int8/fp8 CUDA 后端；请升级或安装匹配 CUDA 的版本。") from exc

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp8_cuda(
                q, k, v, is_causal=is_causal, attn_mask=attn_mask, pv_accum_dtype="fp32+fp32", tensor_layout=tensor_layout
            )

    elif sage_attention == "sageattn_qk_int8_pv_fp8_cuda++":
        sageattention = _load_runtime_dependency(
            "sageattention",
            package_name="sageattention",
            description="当前模式需要 sageattention 的 int8/fp8 CUDA 后端。",
            unique_id=unique_id,
        )
        try:
            sageattn_qk_int8_pv_fp8_cuda = sageattention.sageattn_qk_int8_pv_fp8_cuda
        except AttributeError as exc:
            raise RuntimeError("当前 sageattention 已安装，但缺少 int8/fp8 CUDA 后端；请升级或安装匹配 CUDA 的版本。") from exc

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp8_cuda(
                q, k, v, is_causal=is_causal, attn_mask=attn_mask, pv_accum_dtype="fp32+fp16", tensor_layout=tensor_layout
            )

    elif "sageattn3" in sage_attention:
        sageattn3 = _load_runtime_dependency(
            "sageattn3",
            package_name="sageattn3",
            description="SageAttention 3 模式需要 sageattn3 运行库，通常只适合支持 Blackwell 后端的显卡环境。",
            unique_id=unique_id,
        )
        sageattn3_blackwell = sageattn3.sageattn3_blackwell

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD", **kwargs):
            q, k, v = [x.transpose(1, 2) if tensor_layout == "NHD" else x for x in (q, k, v)]
            out = sageattn3_blackwell(
                q,
                k,
                v,
                is_causal=is_causal,
                attn_mask=attn_mask,
                per_block_mean=(sage_attention == "sageattn3_per_block_mean"),
            )
            return out.transpose(1, 2) if tensor_layout == "NHD" else out

    else:
        raise RuntimeError(f"未知 SageAttention 模式：{sage_attention}")

    if not allow_compile and hasattr(torch, "compiler"):
        sage_func = torch.compiler.disable()(sage_func)

    @wrap_attn
    def attention_sage(q, k, v, heads, mask=None, attn_precision=None, skip_reshape=False, skip_output_reshape=False, **kwargs):
        if kwargs.get("low_precision_attention", True) is False:
            return attention_pytorch(
                q,
                k,
                v,
                heads,
                mask=mask,
                skip_reshape=skip_reshape,
                skip_output_reshape=skip_output_reshape,
                **kwargs,
            )

        input_dtype = v.dtype
        if q.dtype == torch.float32 or k.dtype == torch.float32 or v.dtype == torch.float32:
            q, k, v = q.to(torch.float16), k.to(torch.float16), v.to(torch.float16)

        if skip_reshape:
            batch, _, _, dim_head = q.shape
            tensor_layout = "HND"
        else:
            batch, _, dim_head = q.shape
            dim_head //= heads
            q, k, v = (tensor.view(batch, -1, heads, dim_head) for tensor in (q, k, v))
            tensor_layout = "NHD"

        if mask is not None:
            if mask.ndim == 2:
                mask = mask.unsqueeze(0)
            if mask.ndim == 3:
                mask = mask.unsqueeze(1)

        out = sage_func(q, k, v, attn_mask=mask, is_causal=False, tensor_layout=tensor_layout).to(input_dtype)
        if tensor_layout == "HND":
            if not skip_output_reshape:
                out = out.transpose(1, 2).reshape(batch, -1, heads * dim_head)
        elif skip_output_reshape:
            out = out.transpose(1, 2)
        else:
            out = out.reshape(batch, -1, heads * dim_head)
        return out

    return attention_sage


def _ensure_transformer_options(model_clone):
    model_clone.model_options.setdefault("transformer_options", {})
    return model_clone.model_options["transformer_options"]


class GJJPatchSageAttentionKJ:
    CATEGORY = "GJJ/🧠 模型/优化"
    FUNCTION = "patch"
    RETURN_TYPES = ("MODEL", "MODEL")
    RETURN_NAMES = ("高模", "低模")
    OUTPUT_TOOLTIPS = (
        "应用或关闭 SageAttention 注意力覆盖后的高模 MODEL。",
        "应用或关闭 SageAttention 注意力覆盖后的低模 MODEL；未连接低模输入时输出为空。",
    )
    DESCRIPTION = "零 KJ 依赖复刻 PatchSageAttentionKJ：高模、低模双通道分别输入输出，并设置 SageAttention 注意力覆盖。关闭模式会原样输出输入模型。"
    SEARCH_ALIASES = [NODE_NAME]
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": "为 MODEL 设置 SageAttention 注意力覆盖。节点本身不依赖 KJNodes；选择 Sage 模式执行时，需要当前 Python 环境已安装 sageattention 或 sageattn3。",
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "high_model": ("MODEL", {"display_name": "高模", "tooltip": "需要应用 SageAttention 注意力覆盖的高模 MODEL。"}),
                "sage_attention": (
                    SAGE_ATTENTION_MODES,
                    {
                        "default": "关闭",
                        "display_name": "SageAttention模式",
                        "tooltip": "选择要使用的 SageAttention 后端。选择关闭时不应用补丁，直接输出输入模型。",
                    },
                ),
            },
            "optional": {
                "low_model": ("MODEL", {"display_name": "低模", "tooltip": "可选。需要应用同一 SageAttention 设置的低模 MODEL；未连接时低模输出为空。"}),
                "allow_compile": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "允许参与编译",
                        "tooltip": "允许 SageAttention 函数参与 torch.compile；通常保持关闭更稳，需要新版 sageattention 才建议开启。",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def _patch_one(self, model, sage_attention, new_attention=None):
        if model is None:
            return None
        if new_attention is None:
            return model

        model_clone = model.clone()

        def attention_override_sage(func, *args, **kwargs):
            return new_attention.__wrapped__(*args, **kwargs)

        transformer_options = _ensure_transformer_options(model_clone)
        transformer_options["optimized_attention_override"] = attention_override_sage
        logging.info("[GJJ] 已应用 SageAttention 注意力覆盖：%s", sage_attention)
        return model_clone

    def patch(self, high_model, sage_attention="关闭", low_model=None, allow_compile=False, unique_id=None):
        sage_mode = SAGE_ATTENTION_MAP.get(str(sage_attention), str(sage_attention))
        new_attention = None if sage_mode == "disabled" else _load_sage_attention_func(sage_mode, allow_compile=bool(allow_compile), unique_id=unique_id)
        high_out = self._patch_one(high_model, sage_attention, new_attention)
        low_out = self._patch_one(low_model, sage_attention, new_attention) if low_model is not None else None
        return (high_out, low_out)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJPatchSageAttentionKJ,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
