from __future__ import annotations

import logging
import importlib.util
import traceback
import types

try:
    import torch
except Exception:
    torch = None

try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        print_dependency_model_report,
        raise_dependency_model_error,
        send_dependency_model_notice,
    )
except ImportError:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        print_dependency_model_report,
        raise_dependency_model_error,
        send_dependency_model_notice,
    )


NODE_NAME = "GJJ_ModelPatchBundle"
NODE_DISPLAY_NAME = "GJJ · ⚡ 模型补丁三合一(Wan2.2官方流)"
DESCRIPTION_INTRO = "把 SageAttention、FP16 累积设置、LTXV FeedForward 分块合并为一个零 KJ 依赖的 GJJ MODEL 补丁节点。支持高模、低模双通道分别输入输出，第二路可不接。"

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
    "选项说明：自动=调用 sageattention.sageattn，不支持当前 head_dim 时自动回退 ComfyUI 原生注意力；"
    "int8_fp16_cuda=CUDA int8 QK + fp16 PV 后端；"
    "int8_fp16_triton=Triton int8 QK + fp16 PV 后端；"
    "int8_fp8_cuda=CUDA int8 QK + fp8 PV 累积；"
    "int8_fp8_cuda_plus=fp8 后端 plus 累积策略；"
    "sageattn3=调用 sageattn3_blackwell；"
    "sageattn3分块均值=sageattn3 的 per_block_mean 模式。"
    "所选模式必须和本机显卡、CUDA、sageattention/sageattn3 包版本匹配。"
)

SAGE_ATTENTION_DEPENDENCY = {
    "module_name": "sageattention",
    "package_name": "sageattention",
    "display_name": "SageAttention",
    "description": "启用 SageAttention 的自动/int8/fp8 后端时需要；未启用 SageAttention 时节点仍可正常透传或使用其它补丁。",
}
SAGE_ATTN3_DEPENDENCY = {
    "module_name": "sageattn3",
    "package_name": "sageattn3",
    "display_name": "SageAttn3",
    "description": "选择 sageattn3 或 sageattn3分块均值模式时需要；请安装与显卡、CUDA 匹配的版本。",
}


MISSING_SAGE_HANDLING_MODES = [
    "自动跳过SageAttention继续运行",
    "提示安装并停止",
    "关闭SageAttention继续运行",
]


def _missing_optional_dependency_specs():
    missing = []
    if importlib.util.find_spec("sageattention") is None:
        missing.append(SAGE_ATTENTION_DEPENDENCY)
    if importlib.util.find_spec("sageattn3") is None:
        missing.append(SAGE_ATTN3_DEPENDENCY)
    return missing


_ENVIRONMENT_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    optional_dependencies=_missing_optional_dependency_specs(),
    optional_install_packages=[
        dep["package_name"]
        for dep in _missing_optional_dependency_specs()
        if dep.get("package_name")
    ],
    description="SageAttention/sageattn3 是按模式启用的可选依赖；不开 SageAttention 时不影响其它补丁和模型透传。",
)
_MISSING_OPTIONAL_DEPENDENCIES = list(_ENVIRONMENT_REPORT.get("optional_dependencies", []) or [])
if _MISSING_OPTIONAL_DEPENDENCIES:
    print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ 模型补丁可选依赖缺失")


def _required_sage_module_name(sage_attention: str) -> str:
    sage_mode = SAGE_ATTENTION_MAP.get(sage_attention, sage_attention)
    return "sageattn3" if "sageattn3" in sage_mode else "sageattention"


def _is_sage_dependency_available(sage_attention: str) -> bool:
    return importlib.util.find_spec(_required_sage_module_name(sage_attention)) is not None


def _as_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on", "enable", "enabled", "是", "真", "开", "开启", "启用"}:
        return True
    if text in {"0", "false", "no", "n", "off", "disable", "disabled", "否", "假", "关", "关闭", "禁用", ""}:
        return False
    return bool(value)


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
        "如果启用了 SageAttention 但依赖缺失，会自动跳过 SageAttention 并继续执行其它补丁，同时在面板保留安装命令。",
        "分块数量越大越省显存但越慢；分块阈值越小越容易触发分块，0 表示只要开关打开就尽量分块。",
    ],
    "install": [
        "SageAttention/sageattn3 缺失时请使用节点面板的一键复制安装命令，命令会按当前 ComfyUI Python 环境生成。",
        "sageattn3 请按该项目官方说明安装与显卡/CUDA 匹配的版本。",
    ],
    "notice": _ENVIRONMENT_REPORT.get("help_message", "") if _MISSING_OPTIONAL_DEPENDENCIES else "",
    "install_cmd": "",
    "optional_install_cmd": _ENVIRONMENT_REPORT.get("optional_install_cmd", ""),
    "copy_text": _ENVIRONMENT_REPORT.get("copy_text", ""),
    "copy_label": _ENVIRONMENT_REPORT.get("copy_label", ""),
    "warning_message": _ENVIRONMENT_REPORT.get("warning_message", ""),
    "notice_level": _ENVIRONMENT_REPORT.get("notice_level", "ok"),
}


def _load_sage_callable(module_name: str, attr_name: str, package_name: str, description: str, unique_id=None):
    module = load_dependency_at_runtime(
        module_name,
        node_name=NODE_DISPLAY_NAME,
        package_name=package_name,
        description=description,
        unique_id=unique_id,
    )
    try:
        return getattr(module, attr_name)
    except Exception as exc:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[
                {
                    "module_name": module_name,
                    "package_name": package_name,
                    "display_name": package_name,
                    "description": f"已安装 {package_name}，但当前版本缺少 {attr_name} 接口，请升级或换成匹配版本。",
                }
            ],
            install_packages=[package_name],
            description=f"{attr_name} 接口缺失，当前 SageAttention 模式无法运行。",
            original_error=str(exc),
            unique_id=unique_id,
            title="GJJ 模型补丁依赖版本不兼容！",
        )


def _get_sage_func(sage_attention: str, allow_compile: bool = False, unique_id=None):
    if torch is None:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[
                {
                    "module_name": "torch",
                    "package_name": "torch",
                    "display_name": "PyTorch",
                    "description": "启用 SageAttention 或 FP16 累积设置需要 PyTorch 正常加载。",
                }
            ],
            install_packages=["torch"],
            description="PyTorch 未加载，无法启用 SageAttention。",
            unique_id=unique_id,
        )

    try:
        from comfy.ldm.modules.attention import attention_pytorch, wrap_attn
    except Exception as exc:
        raise RuntimeError(f"无法导入 ComfyUI 注意力模块：{exc}") from exc

    logging.info("[GJJ] 使用 SageAttention 模式：%s", sage_attention)

    if sage_attention == "auto":
        sageattn = _load_sage_callable(
            "sageattention",
            "sageattn",
            "sageattention",
            "自动模式需要 sageattention.sageattn。",
            unique_id=unique_id,
        )

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn(q, k, v, is_causal=is_causal, attn_mask=attn_mask, tensor_layout=tensor_layout)

    elif sage_attention == "sageattn_qk_int8_pv_fp16_cuda":
        sageattn_qk_int8_pv_fp16_cuda = _load_sage_callable(
            "sageattention",
            "sageattn_qk_int8_pv_fp16_cuda",
            "sageattention",
            "int8_fp16_cuda 模式需要 sageattention.sageattn_qk_int8_pv_fp16_cuda。",
            unique_id=unique_id,
        )

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp16_cuda(
                q, k, v, is_causal=is_causal, attn_mask=attn_mask, pv_accum_dtype="fp32", tensor_layout=tensor_layout
            )

    elif sage_attention == "sageattn_qk_int8_pv_fp16_triton":
        sageattn_qk_int8_pv_fp16_triton = _load_sage_callable(
            "sageattention",
            "sageattn_qk_int8_pv_fp16_triton",
            "sageattention",
            "int8_fp16_triton 模式需要 sageattention.sageattn_qk_int8_pv_fp16_triton。",
            unique_id=unique_id,
        )

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp16_triton(
                q, k, v, is_causal=is_causal, attn_mask=attn_mask, tensor_layout=tensor_layout
            )

    elif sage_attention == "sageattn_qk_int8_pv_fp8_cuda":
        sageattn_qk_int8_pv_fp8_cuda = _load_sage_callable(
            "sageattention",
            "sageattn_qk_int8_pv_fp8_cuda",
            "sageattention",
            "int8_fp8_cuda 模式需要 sageattention.sageattn_qk_int8_pv_fp8_cuda。",
            unique_id=unique_id,
        )

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp8_cuda(
                q, k, v, is_causal=is_causal, attn_mask=attn_mask, pv_accum_dtype="fp32+fp32", tensor_layout=tensor_layout
            )

    elif sage_attention == "sageattn_qk_int8_pv_fp8_cuda++":
        sageattn_qk_int8_pv_fp8_cuda = _load_sage_callable(
            "sageattention",
            "sageattn_qk_int8_pv_fp8_cuda",
            "sageattention",
            "int8_fp8_cuda_plus 模式需要 sageattention.sageattn_qk_int8_pv_fp8_cuda。",
            unique_id=unique_id,
        )

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp8_cuda(
                q, k, v, is_causal=is_causal, attn_mask=attn_mask, pv_accum_dtype="fp32+fp16", tensor_layout=tensor_layout
            )

    elif "sageattn3" in sage_attention:
        sageattn3_blackwell = _load_sage_callable(
            "sageattn3",
            "sageattn3_blackwell",
            "sageattn3",
            "sageattn3 模式需要 sageattn3.sageattn3_blackwell，请安装与显卡/CUDA 匹配的版本。",
            unique_id=unique_id,
        )

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

    fallback_head_dims_logged = set()

    @wrap_attn
    def attention_sage(q, k, v, heads, mask=None, attn_precision=None, skip_reshape=False, skip_output_reshape=False, **kwargs):
        original_q, original_k, original_v, original_mask = q, k, v, mask

        def fallback_to_pytorch():
            return attention_pytorch(
                original_q,
                original_k,
                original_v,
                heads,
                mask=original_mask,
                attn_precision=attn_precision,
                skip_reshape=skip_reshape,
                skip_output_reshape=skip_output_reshape,
                **kwargs,
            )

        if kwargs.get("low_precision_attention", True) is False:
            return fallback_to_pytorch()

        if skip_reshape:
            dim_head = int(q.shape[-1])
        else:
            dim_head = int(q.shape[-1]) // int(heads)

        if sage_attention == "auto" and dim_head not in {64, 96, 128}:
            if dim_head not in fallback_head_dims_logged:
                logging.warning(
                    "[GJJ] SageAttention 自动模式不支持 head_dim=%s，已回退 ComfyUI 原生注意力。",
                    dim_head,
                )
                fallback_head_dims_logged.add(dim_head)
            return fallback_to_pytorch()

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

        try:
            out = sage_func(q, k, v, attn_mask=mask, is_causal=False, tensor_layout=tensor_layout).to(in_dtype)
        except Exception as exc:
            normalized_error = str(exc).lower().replace("_", "").replace(" ", "")
            is_head_dim_error = "headdim" in normalized_error and all(
                supported_dim in normalized_error for supported_dim in ("64", "96", "128")
            )
            if sage_attention != "auto" or not is_head_dim_error:
                raise
            if dim_head not in fallback_head_dims_logged:
                logging.warning(
                    "[GJJ] SageAttention 自动模式拒绝 head_dim=%s，已回退 ComfyUI 原生注意力：%s",
                    dim_head,
                    exc,
                )
                fallback_head_dims_logged.add(dim_head)
            return fallback_to_pytorch()
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


def _apply_sage_attention(model_clone, sage_attention: str, allow_compile: bool, unique_id=None):
    sage_mode = SAGE_ATTENTION_MAP.get(sage_attention, sage_attention)
    new_attention = _get_sage_func(sage_mode, allow_compile=allow_compile, unique_id=unique_id)

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
    CATEGORY = "GJJ/🧠 模型/优化"
    FUNCTION = "patch"
    RETURN_TYPES = ("MODEL", "MODEL")
    RETURN_NAMES = ("高模", "低模")
    OUTPUT_TOOLTIPS = (
        "应用所选补丁后的高模 MODEL。",
        "应用所选补丁后的低模 MODEL；未连接低模输入时输出为空。",
    )
    DESCRIPTION = DESCRIPTION_INTRO
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
                "缺SageAttention处理": (
                    MISSING_SAGE_HANDLING_MODES,
                    {
                        "default": "自动跳过SageAttention继续运行",
                        "display_name": "缺SageAttention处理",
                        "tooltip": "启用 SageAttention 但本机缺少所选模式依赖时，会自动跳过 SageAttention，只继续应用 FP16 累积和 LTXV 分块，面板仍保留安装命令供之后复制。“提示安装并停止”为旧工作流兼容值，当前也会自动跳过。",
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
            "hidden": {
                "unique_id": "UNIQUE_ID",
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
        缺SageAttention处理="自动跳过SageAttention继续运行",
        unique_id=None,
        **kwargs,
    ):
        if _MISSING_OPTIONAL_DEPENDENCIES and _as_bool(启用SageAttention):
            send_dependency_model_notice(_ENVIRONMENT_REPORT, unique_id=unique_id)

        high_out = self._patch_one(
            MODEL,
            "高模",
            启用SageAttention=启用SageAttention,
            SageAttention模式=SageAttention模式,
            允许Sage编译=允许Sage编译,
            启用FP16累积设置=启用FP16累积设置,
            FP16累积=FP16累积,
            启用LTXV前馈分块=启用LTXV前馈分块,
            分块数量=分块数量,
            分块阈值=分块阈值,
            缺SageAttention处理=缺SageAttention处理,
            unique_id=unique_id,
        )
        low_out = None
        if 低模 is not None:
            low_out = self._patch_one(
                低模,
                "低模",
                启用SageAttention=启用SageAttention,
                SageAttention模式=SageAttention模式,
                允许Sage编译=允许Sage编译,
                启用FP16累积设置=启用FP16累积设置,
                FP16累积=FP16累积,
                启用LTXV前馈分块=启用LTXV前馈分块,
                分块数量=分块数量,
                分块阈值=分块阈值,
                缺SageAttention处理=缺SageAttention处理,
                unique_id=unique_id,
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
        缺SageAttention处理="自动跳过SageAttention继续运行",
        unique_id=None,
    ):
        if model is None:
            raise RuntimeError(f"未接入{channel_name} MODEL。")

        enable_sage = _as_bool(启用SageAttention)
        allow_compile = _as_bool(允许Sage编译)
        enable_fp16_accumulation = _as_bool(启用FP16累积设置)
        fp16_accumulation = _as_bool(FP16累积)
        enable_ltxv_chunk = _as_bool(启用LTXV前馈分块)

        skip_sage = False
        if enable_sage and not _is_sage_dependency_available(SageAttention模式):
            skip_sage = True
            logging.warning("[GJJ] %s缺少 %s，已自动跳过 SageAttention 并继续运行其它补丁。", channel_name, _required_sage_module_name(SageAttention模式))
            send_dependency_model_notice(_ENVIRONMENT_REPORT, unique_id=unique_id)

        effective_sage_attention = bool(enable_sage and not skip_sage)
        needs_clone = bool(effective_sage_attention or enable_fp16_accumulation or enable_ltxv_chunk)
        if not needs_clone:
            return model

        model_clone = model.clone()
        try:
            if effective_sage_attention:
                _apply_sage_attention(model_clone, SageAttention模式, allow_compile, unique_id=unique_id)

            if enable_fp16_accumulation:
                _apply_fp16_accumulation_callback(model_clone, fp16_accumulation)

            if enable_ltxv_chunk:
                _apply_ltxv_feedforward_chunk(model_clone, int(分块数量), int(分块阈值))

            return model_clone
        except Exception:
            logging.error("[GJJ] %s模型补丁三合一失败：\n%s", channel_name, traceback.format_exc())
            raise


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ModelPatchBundle}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ⚡ 模型补丁三合一"}
