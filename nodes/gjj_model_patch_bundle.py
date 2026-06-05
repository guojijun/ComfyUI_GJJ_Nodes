from __future__ import annotations

import logging
import sys
import traceback
import types

try:
    import torch
except Exception:
    torch = None


NODE_NAME = "GJJ_ModelPatchBundle"

SAGE_ATTENTION_MODES = [
    "自动",
    "int8_fp16_cuda",
    "int8_fp16_triton",
    "int8_fp8_cuda",
    "int8_fp8_cuda_plus",
    "sageattn3",
    "sageattn3分块均值",
]

SAGE_ATTENTION_MAP = {
    "自动": "auto",
    "int8_fp16_cuda": "sageattn_qk_int8_pv_fp16_cuda",
    "int8_fp16_triton": "sageattn_qk_int8_pv_fp16_triton",
    "int8_fp8_cuda": "sageattn_qk_int8_pv_fp8_cuda",
    "int8_fp8_cuda_plus": "sageattn_qk_int8_pv_fp8_cuda++",
    "sageattn3": "sageattn3",
    "sageattn3分块均值": "sageattn3_per_block_mean",
}

SAGE_MODE_TOOLTIP = (
    "选择 SageAttention 后端模式；只有“启用SageAttention”打开时生效。"
    "选项说明：自动=调用 sageattention.sageattn；"
    "int8_fp16_cuda=CUDA int8 QK + fp16 PV 后端；"
    "int8_fp16_triton=Triton int8 QK + fp16 PV 后端；"
    "int8_fp8_cuda=CUDA int8 QK + fp8 PV 累积；"
    "int8_fp8_cuda_plus=fp8 后端 plus 累积策略；"
    "sageattn3=调用 sageattn3_blackwell；"
    "sageattn3分块均值=sageattn3 的 per_block_mean 模式。"
    "所选模式必须和本机显卡、CUDA、sageattention/sageattn3 包版本匹配。"
)

PATCH_BUNDLE_HELP = {
    "title": "GJJ · ⚡ 模型补丁三合一",
    "description": "把 SageAttention、FP16 累积设置、LTXV FeedForward 分块合并为一个双路 MODEL 补丁节点；高模和低模各自 clone、各走各线。",
    "requirements": [
        "SageAttention 需要安装 sageattention 或 sageattn3；未启用 SageAttention 时不需要该依赖。",
        "FP16 累积设置需要当前 PyTorch 支持 torch.backends.cuda.matmul.allow_fp16_accumulation。",
        "LTXV 前馈分块只适用于具有 transformer_blocks.*.ff.forward 的 LTXV 类 MODEL；其它模型启用后可能提示找不到可分块模块。",
        "低模输入可不接；不接时低模输出为空。高模输入必须接入 MODEL。",
    ],
    "usage": [
        "不开任何补丁时，节点会原样透传输入 MODEL，不 clone。",
        "启用任一补丁后，对接入的每一路 MODEL 独立 clone 并应用相同设置。",
        "SageAttention 负责替换注意力计算；FP16 累积负责运行前/清理时切换 matmul 累积设置；LTXV 分块负责降低 FeedForward 峰值显存。",
        "分块数量越大越省显存但越慢；分块阈值越小越容易触发分块，0 表示只要开关打开就尽量分块。",
    ],
    "install": [
        "SageAttention 缺失时可按当前 ComfyUI Python 环境安装，例如：",
        f"\"{sys.executable}\" -m pip install sageattention",
        "sageattn3 请按该项目官方说明安装与显卡/CUDA 匹配的版本。",
    ],
}


def _get_sage_func(sage_attention: str, allow_compile: bool = False):
    if torch is None:
        raise RuntimeError("PyTorch 未加载，无法启用 SageAttention。")

    try:
        from comfy.ldm.modules.attention import attention_pytorch, wrap_attn
    except Exception as exc:
        raise RuntimeError(f"无法导入 ComfyUI 注意力模块：{exc}") from exc

    logging.info("[GJJ] 使用 SageAttention 模式：%s", sage_attention)

    if sage_attention == "auto":
        try:
            from sageattention import sageattn
        except Exception as exc:
            raise RuntimeError(
                f"未找到 sageattention。安装命令：\"{sys.executable}\" -m pip install sageattention"
            ) from exc

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn(q, k, v, is_causal=is_causal, attn_mask=attn_mask, tensor_layout=tensor_layout)

    elif sage_attention == "sageattn_qk_int8_pv_fp16_cuda":
        try:
            from sageattention import sageattn_qk_int8_pv_fp16_cuda
        except Exception as exc:
            raise RuntimeError(
                f"当前环境缺少 sageattn_qk_int8_pv_fp16_cuda。安装命令：\"{sys.executable}\" -m pip install sageattention"
            ) from exc

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp16_cuda(
                q, k, v, is_causal=is_causal, attn_mask=attn_mask, pv_accum_dtype="fp32", tensor_layout=tensor_layout
            )

    elif sage_attention == "sageattn_qk_int8_pv_fp16_triton":
        try:
            from sageattention import sageattn_qk_int8_pv_fp16_triton
        except Exception as exc:
            raise RuntimeError(
                f"当前环境缺少 sageattn_qk_int8_pv_fp16_triton。安装命令：\"{sys.executable}\" -m pip install sageattention"
            ) from exc

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp16_triton(
                q, k, v, is_causal=is_causal, attn_mask=attn_mask, tensor_layout=tensor_layout
            )

    elif sage_attention == "sageattn_qk_int8_pv_fp8_cuda":
        try:
            from sageattention import sageattn_qk_int8_pv_fp8_cuda
        except Exception as exc:
            raise RuntimeError(
                f"当前环境缺少 sageattn_qk_int8_pv_fp8_cuda。安装命令：\"{sys.executable}\" -m pip install sageattention"
            ) from exc

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp8_cuda(
                q, k, v, is_causal=is_causal, attn_mask=attn_mask, pv_accum_dtype="fp32+fp32", tensor_layout=tensor_layout
            )

    elif sage_attention == "sageattn_qk_int8_pv_fp8_cuda++":
        try:
            from sageattention import sageattn_qk_int8_pv_fp8_cuda
        except Exception as exc:
            raise RuntimeError(
                f"当前环境缺少 sageattn_qk_int8_pv_fp8_cuda。安装命令：\"{sys.executable}\" -m pip install sageattention"
            ) from exc

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp8_cuda(
                q, k, v, is_causal=is_causal, attn_mask=attn_mask, pv_accum_dtype="fp32+fp16", tensor_layout=tensor_layout
            )

    elif "sageattn3" in sage_attention:
        try:
            from sageattn3 import sageattn3_blackwell
        except Exception as exc:
            raise RuntimeError(
                f"未找到 sageattn3。请先安装与你显卡匹配的 sageattn3 运行库。原始错误：{exc}"
            ) from exc

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

        in_dtype = v.dtype
        if q.dtype == torch.float32 or k.dtype == torch.float32 or v.dtype == torch.float32:
            q, k, v = q.to(torch.float16), k.to(torch.float16), v.to(torch.float16)

        if skip_reshape:
            b, _, _, dim_head = q.shape
            tensor_layout = "HND"
        else:
            b, _, dim_head = q.shape
            dim_head //= heads
            q, k, v = map(lambda t: t.view(b, -1, heads, dim_head), (q, k, v))
            tensor_layout = "NHD"

        if mask is not None:
            if mask.ndim == 2:
                mask = mask.unsqueeze(0)
            if mask.ndim == 3:
                mask = mask.unsqueeze(1)

        out = sage_func(q, k, v, attn_mask=mask, is_causal=False, tensor_layout=tensor_layout).to(in_dtype)
        if tensor_layout == "HND":
            if not skip_output_reshape:
                out = out.transpose(1, 2).reshape(b, -1, heads * dim_head)
        elif skip_output_reshape:
            out = out.transpose(1, 2)
        else:
            out = out.reshape(b, -1, heads * dim_head)
        return out

    return attention_sage


def _ltxv_ff_chunked_forward(self, x):
    if x.shape[1] > self.dim_threshold:
        effective_chunks = max(1, min(int(self.num_chunks), int(x.shape[1])))
        chunk_size = max(1, x.shape[1] // effective_chunks)
        for i in range(effective_chunks):
            start_idx = i * chunk_size
            end_idx = (i + 1) * chunk_size if i < effective_chunks - 1 else x.shape[1]
            x[:, start_idx:end_idx] = self.net(x[:, start_idx:end_idx])
        return x
    return self.net(x)


class _LTXVFeedForwardChunkPatch:
    def __init__(self, num_chunks: int, dim_threshold: int):
        self.num_chunks = int(num_chunks)
        self.dim_threshold = int(dim_threshold)

    def __get__(self, obj, objtype=None):
        def wrapped_forward(self_module, *args, **kwargs):
            self_module.num_chunks = self.num_chunks
            self_module.dim_threshold = self.dim_threshold
            return _ltxv_ff_chunked_forward(self_module, *args, **kwargs)

        return types.MethodType(wrapped_forward, obj)


def _ensure_transformer_options(model_clone):
    if "transformer_options" not in model_clone.model_options:
        model_clone.model_options["transformer_options"] = {}
    return model_clone.model_options["transformer_options"]


def _apply_sage_attention(model_clone, sage_attention: str, allow_compile: bool):
    sage_mode = SAGE_ATTENTION_MAP.get(sage_attention, sage_attention)
    new_attention = _get_sage_func(sage_mode, allow_compile=allow_compile)

    def attention_override_sage(func, *args, **kwargs):
        return new_attention.__wrapped__(*args, **kwargs)

    transformer_options = _ensure_transformer_options(model_clone)
    transformer_options["optimized_attention_override"] = attention_override_sage
    logging.info("[GJJ] 已应用 SageAttention：%s", sage_attention)


def _apply_fp16_accumulation_callback(model_clone, enable_value: bool):
    if torch is None:
        raise RuntimeError("PyTorch 未加载，无法设置 FP16 累积。")
    if not hasattr(torch.backends.cuda.matmul, "allow_fp16_accumulation"):
        raise RuntimeError("当前 PyTorch 不支持 allow_fp16_accumulation，需要 PyTorch 2.7.1 或更高版本。")

    try:
        from comfy.patcher_extension import CallbacksMP
    except Exception as exc:
        raise RuntimeError(f"无法导入 ComfyUI 模型回调接口：{exc}") from exc

    def set_fp16_accum_on(_model):
        logging.info("[GJJ] torch.backends.cuda.matmul.allow_fp16_accumulation = True")
        torch.backends.cuda.matmul.allow_fp16_accumulation = True

    def set_fp16_accum_off(_model):
        logging.info("[GJJ] torch.backends.cuda.matmul.allow_fp16_accumulation = False")
        torch.backends.cuda.matmul.allow_fp16_accumulation = False

    model_clone.add_callback(CallbacksMP.ON_PRE_RUN, set_fp16_accum_on if enable_value else set_fp16_accum_off)
    model_clone.add_callback(CallbacksMP.ON_CLEANUP, set_fp16_accum_off)


def _apply_ltxv_feedforward_chunk(model_clone, chunks: int, dim_threshold: int):
    if chunks <= 1:
        logging.info("[GJJ] LTXV FeedForward 分块数为 1，跳过分块补丁。")
        return

    diffusion_model = model_clone.get_model_object("diffusion_model")
    blocks = getattr(diffusion_model, "transformer_blocks", None)
    if not blocks:
        raise RuntimeError("当前 MODEL 没有 transformer_blocks，无法应用 LTXV FeedForward 分块补丁。")

    patched_count = 0
    for idx, block in enumerate(blocks):
        ff = getattr(block, "ff", None)
        if ff is None or not hasattr(ff, "forward") or not hasattr(ff, "net"):
            continue
        patched_ff = _LTXVFeedForwardChunkPatch(chunks, dim_threshold).__get__(ff, block.__class__)
        model_clone.add_object_patch(f"diffusion_model.transformer_blocks.{idx}.ff.forward", patched_ff)
        patched_count += 1

    if patched_count <= 0:
        raise RuntimeError("未找到可分块的 LTXV FeedForward 模块（transformer_blocks.*.ff.net）。")
    logging.info("[GJJ] 已应用 LTXV FeedForward 分块：%s 个 block，chunks=%s，阈值=%s", patched_count, chunks, dim_threshold)


class GJJ_ModelPatchBundle:
    CATEGORY = "GJJ/模型优化"
    FUNCTION = "patch"
    RETURN_TYPES = ("MODEL", "MODEL")
    RETURN_NAMES = ("高模", "低模")
    OUTPUT_TOOLTIPS = (
        "应用所选补丁后的高模 MODEL。",
        "应用所选补丁后的低模 MODEL；未连接低模输入时输出为空。",
    )
    DESCRIPTION = "把 SageAttention、FP16 累积设置、LTXV FeedForward 分块合并为一个零 KJ 依赖的 GJJ MODEL 补丁节点。支持高模、低模双通道分别输入输出，第二路可不接。"
    GJJ_HELP = PATCH_BUNDLE_HELP
    SEARCH_ALIASES = [
        "model patch",
        "sage attention",
        "fp16 accumulation",
        "ltxv chunk feedforward",
        "模型补丁",
        "模型优化",
        "分块前馈",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "MODEL": (
                    "MODEL",
                    {
                        "display_name": "高模",
                        "tooltip": "主模型输入。节点会按下方补丁开关对这一路 MODEL 独立处理；不开任何补丁时原样透传，启用任一补丁时 clone 后输出。",
                    },
                ),
                "启用SageAttention": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用SageAttention",
                        "tooltip": "是否为每一路接入的 MODEL 设置 SageAttention 注意力覆盖。关闭=不改注意力计算；开启=按“SageAttention模式”选择后端并写入 optimized_attention_override，需要已安装对应 sageattention 或 sageattn3 运行库。",
                    },
                ),
                "SageAttention模式": (
                    SAGE_ATTENTION_MODES,
                    {
                        "default": "自动",
                        "display_name": "SageAttention模式",
                        "tooltip": SAGE_MODE_TOOLTIP,
                    },
                ),
                "允许Sage编译": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "允许Sage编译",
                        "tooltip": "控制 SageAttention 函数是否允许参与 torch.compile。关闭=对 Sage 函数加 torch.compiler.disable，更稳，推荐默认；开启=允许一起编译，可能更快，但要求 SageAttention/sageattn3、PyTorch 与 CUDA 组合兼容。",
                    },
                ),
                "启用FP16累积设置": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用FP16累积设置",
                        "tooltip": "是否挂载 FP16 累积回调。关闭=不碰全局 matmul 累积开关；开启=模型运行前按“FP16累积”的值设置 torch.backends.cuda.matmul.allow_fp16_accumulation，并在模型清理时恢复关闭。需要较新的 PyTorch 支持该属性。",
                    },
                ),
                "FP16累积": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "FP16累积",
                        "tooltip": "启用“FP16累积设置”后才生效。开启=True 时运行前打开 torch.backends.cuda.matmul.allow_fp16_accumulation；关闭=False 时运行前明确关闭它。用于控制 FP16 矩阵乘的累积路径，具体收益取决于 PyTorch/显卡。",
                    },
                ),
                "启用LTXV前馈分块": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用LTXV前馈分块",
                        "tooltip": "是否对 LTXV 类模型的 transformer_blocks.*.ff.forward 应用分块前馈补丁。关闭=不处理 FeedForward；开启=把长序列按“分块数量”切块运行，用速度换更低峰值显存。仅适用于存在 transformer_blocks.*.ff.net 的模型。",
                    },
                ),
                "分块数量": (
                    "INT",
                    {
                        "default": 4,
                        "min": 1,
                        "max": 100,
                        "step": 1,
                        "display_name": "分块数量",
                        "tooltip": "LTXV 前馈分块数量，只有“启用LTXV前馈分块”打开时生效。1=不实际分块；2-4=常用折中；更大=更省显存但更慢，且可能增加调度开销。",
                    },
                ),
                "分块阈值": (
                    "INT",
                    {
                        "default": 4096,
                        "min": 0,
                        "max": 16384,
                        "step": 256,
                        "display_name": "分块阈值",
                        "tooltip": "LTXV 前馈分块触发阈值，只有“启用LTXV前馈分块”打开时生效。序列长度大于该值才分块；0=只要开关打开就尽量分块；4096=默认折中；值越高越少触发分块。",
                    },
                ),
            },
            "optional": {
                "低模": (
                    "MODEL",
                    {
                        "display_name": "低模",
                        "tooltip": "可选第二路模型输入。连接后会使用同一组 SageAttention、FP16 累积、LTXV 分块设置独立处理；不连接时第二个输出为空，不影响高模线路。",
                    },
                ),
            },
        }

    def patch(
        self,
        MODEL,
        低模=None,
        启用SageAttention=False,
        SageAttention模式="自动",
        允许Sage编译=False,
        启用FP16累积设置=False,
        FP16累积=True,
        启用LTXV前馈分块=False,
        分块数量=4,
        分块阈值=4096,
        **kwargs,
    ):
        high_out = self._patch_one(
            MODEL,
            "高模",
            启用SageAttention,
            SageAttention模式,
            允许Sage编译,
            启用FP16累积设置,
            FP16累积,
            启用LTXV前馈分块,
            分块数量,
            分块阈值,
        )
        low_out = None
        if 低模 is not None:
            low_out = self._patch_one(
                低模,
                "低模",
                启用SageAttention,
                SageAttention模式,
                允许Sage编译,
                启用FP16累积设置,
                FP16累积,
                启用LTXV前馈分块,
                分块数量,
                分块阈值,
            )
        return (high_out, low_out)

    def _patch_one(
        self,
        model,
        channel_name,
        启用SageAttention=False,
        SageAttention模式="自动",
        允许Sage编译=False,
        启用FP16累积设置=False,
        FP16累积=True,
        启用LTXV前馈分块=False,
        分块数量=4,
        分块阈值=4096,
    ):
        if model is None:
            raise RuntimeError(f"未接入{channel_name} MODEL。")

        needs_clone = bool(启用SageAttention or 启用FP16累积设置 or 启用LTXV前馈分块)
        if not needs_clone:
            return model

        model_clone = model.clone()
        try:
            if 启用SageAttention:
                _apply_sage_attention(model_clone, SageAttention模式, bool(允许Sage编译))

            if 启用FP16累积设置:
                _apply_fp16_accumulation_callback(model_clone, bool(FP16累积))

            if 启用LTXV前馈分块:
                _apply_ltxv_feedforward_chunk(model_clone, int(分块数量), int(分块阈值))

            return model_clone
        except Exception:
            logging.error("[GJJ] %s模型补丁三合一失败：\n%s", channel_name, traceback.format_exc())
            raise


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ModelPatchBundle}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ⚡ 模型补丁三合一"}
