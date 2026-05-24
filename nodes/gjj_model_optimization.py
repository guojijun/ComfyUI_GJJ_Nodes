import os
import sys
import traceback
import logging

try:
    import torch
except ImportError:
    torch = None

try:
    import comfy.model_management as mm
    import comfy.utils
except ImportError:
    mm = None
    comfy_utils = None

try:
    from server import PromptServer
except ImportError:
    PromptServer = None

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def send_error_to_frontend(node_id, title, message, install_command=None):
    try:
        if PromptServer is not None:
            PromptServer.instance.send_sync(
                "gjj_model_opt_error",
                {
                    "node": node_id,
                    "title": title,
                    "message": message,
                    "install_command": install_command,
                },
            )
    except Exception as e:
        logging.error(f"发送错误信息失败: {e}")


def get_sage_func(sage_attention, allow_compile=False):
    try:
        from sageattention import sageattn
    except ImportError:
        raise RuntimeError("请先安装 sageattention 库")

    if sage_attention == "自动":

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn(
                q,
                k,
                v,
                is_causal=is_causal,
                attn_mask=attn_mask,
                tensor_layout=tensor_layout,
            )

    elif sage_attention == "int8_fp16_cuda":
        from sageattention import sageattn_qk_int8_pv_fp16_cuda

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp16_cuda(
                q,
                k,
                v,
                is_causal=is_causal,
                attn_mask=attn_mask,
                pv_accum_dtype="fp32",
                tensor_layout=tensor_layout,
            )

    elif sage_attention == "int8_fp16_triton":
        from sageattention import sageattn_qk_int8_pv_fp16_triton

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp16_triton(
                q,
                k,
                v,
                is_causal=is_causal,
                attn_mask=attn_mask,
                tensor_layout=tensor_layout,
            )

    elif sage_attention == "int8_fp8_cuda":
        from sageattention import sageattn_qk_int8_pv_fp8_cuda

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp8_cuda(
                q,
                k,
                v,
                is_causal=is_causal,
                attn_mask=attn_mask,
                pv_accum_dtype="fp32+fp32",
                tensor_layout=tensor_layout,
            )

    elif sage_attention == "int8_fp8_cuda_plus":
        from sageattention import sageattn_qk_int8_pv_fp8_cuda

        def sage_func(q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD"):
            return sageattn_qk_int8_pv_fp8_cuda(
                q,
                k,
                v,
                is_causal=is_causal,
                attn_mask=attn_mask,
                pv_accum_dtype="fp32+fp16",
                tensor_layout=tensor_layout,
            )

    elif "sageattn3" in sage_attention:
        from sageattn3 import sageattn3_blackwell

        def sage_func(
            q, k, v, is_causal=False, attn_mask=None, tensor_layout="NHD", **kwargs
        ):
            q, k, v = [
                x.transpose(1, 2) if tensor_layout == "NHD" else x for x in (q, k, v)
            ]
            out = sageattn3_blackwell(
                q,
                k,
                v,
                is_causal=is_causal,
                attn_mask=attn_mask,
                per_block_mean=(sage_attention == "sageattn3分块均值"),
            )
            return out.transpose(1, 2) if tensor_layout == "NHD" else out

    else:
        return None

    try:
        from comfy.ldm.modules.attention import wrap_attn, attention_pytorch
    except ImportError:
        raise RuntimeError("无法导入 ComfyUI 注意力模块")

    if not allow_compile:
        sage_func = (
            torch.compiler.disable()(sage_func)
            if hasattr(torch, "compiler")
            else sage_func
        )

    @wrap_attn
    def attention_sage(
        q,
        k,
        v,
        heads,
        mask=None,
        attn_precision=None,
        skip_reshape=False,
        skip_output_reshape=False,
        **kwargs,
    ):
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
        if (
            q.dtype == torch.float32
            or k.dtype == torch.float32
            or v.dtype == torch.float32
        ):
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
        out = sage_func(
            q, k, v, attn_mask=mask, is_causal=False, tensor_layout=tensor_layout
        ).to(in_dtype)
        if tensor_layout == "HND":
            if not skip_output_reshape:
                out = out.transpose(1, 2).reshape(b, -1, heads * dim_head)
        else:
            if skip_output_reshape:
                out = out.transpose(1, 2)
            else:
                out = out.reshape(b, -1, heads * dim_head)
        return out

    return attention_sage


SAGE_ATTENTION_MODES = [
    "关闭",
    "自动",
    "int8_fp16_cuda",
    "int8_fp16_triton",
    "int8_fp8_cuda",
    "int8_fp8_cuda_plus",
    "sageattn3",
    "sageattn3分块均值",
]

SAGE_ATTENTION_MAP = {
    "关闭": "disabled",
    "自动": "auto",
    "int8_fp16_cuda": "sageattn_qk_int8_pv_fp16_cuda",
    "int8_fp16_triton": "sageattn_qk_int8_pv_fp16_triton",
    "int8_fp8_cuda": "sageattn_qk_int8_pv_fp8_cuda",
    "int8_fp8_cuda_plus": "sageattn_qk_int8_pv_fp8_cuda++",
    "sageattn3": "sageattn3",
    "sageattn3分块均值": "sageattn3_per_block_mean",
}


# 前端选项卡使用 node.properties 保存参数；后端通过 extra_pnginfo 按 unique_id 读取。
# 这样可以从 Python INPUT_TYPES 中移除所有参数 widget，根治隐藏 widget 空行/错位问题。
DEFAULT_MODEL_OPT_CONFIG = {
    "enable_torch_compile": False,
    "compile_backend": "inductor",
    "compile_fullgraph": False,
    "compile_mode": "default",
    "compile_dynamic": "自动",
    "compile_transformer_blocks_only": True,
    "sage_attention": "关闭",
    "allow_sage_compile": False,
    "enable_fp16_accumulation": False,
    "dynamo_cache_size_limit": 64,
}


def _read_model_optimizer_config(unique_id=None, extra_pnginfo=None):
    config = dict(DEFAULT_MODEL_OPT_CONFIG)
    try:
        workflow = None
        if isinstance(extra_pnginfo, dict):
            workflow = extra_pnginfo.get("workflow") or extra_pnginfo.get("extra_pnginfo", {}).get("workflow")
        nodes = workflow.get("nodes", []) if isinstance(workflow, dict) else []
        uid_text = str(unique_id) if unique_id is not None else None
        for node in nodes:
            if uid_text is None or str(node.get("id")) == uid_text:
                props = node.get("properties") or {}
                saved = props.get("gjj_model_optimizer_config") or props.get("gjj_model_opt_config")
                if isinstance(saved, dict):
                    config.update(saved)
                    break
    except Exception as e:
        logging.warning(f"读取模型优化器前端配置失败，使用默认配置: {e}")

    # 类型与合法值兜底，避免旧工作流/手动编辑导致错值。
    compile_backends = ["inductor", "cudagraphs"] if torch is not None else ["inductor"]
    if config.get("compile_backend") not in compile_backends:
        config["compile_backend"] = "inductor"
    if config.get("compile_mode") not in ["default", "max-autotune", "max-autotune-no-cudagraphs", "reduce-overhead"]:
        config["compile_mode"] = "default"
    if config.get("compile_dynamic") not in ["自动", "启用", "关闭"]:
        config["compile_dynamic"] = "自动"
    if config.get("sage_attention") not in SAGE_ATTENTION_MODES:
        config["sage_attention"] = "关闭"
    for key in ["enable_torch_compile", "compile_fullgraph", "compile_transformer_blocks_only", "allow_sage_compile", "enable_fp16_accumulation"]:
        config[key] = bool(config.get(key, DEFAULT_MODEL_OPT_CONFIG[key]))
    try:
        config["dynamo_cache_size_limit"] = int(config.get("dynamo_cache_size_limit", 64))
    except Exception:
        config["dynamo_cache_size_limit"] = 64
    config["dynamo_cache_size_limit"] = max(0, min(1024, config["dynamo_cache_size_limit"]))
    return config


class GJJ_ModelOptimizer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "optimize"
    CATEGORY = "GJJ/模型优化"
    DESCRIPTION = "GJJ 模型综合优化器：TorchCompile + SageAttention + FP16 累积"

    def optimize(
        self,
        模型=None,
        model=None,
        unique_id=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        config = _read_model_optimizer_config(unique_id, extra_pnginfo)
        enable_torch_compile = config["enable_torch_compile"]
        compile_backend = config["compile_backend"]
        compile_fullgraph = config["compile_fullgraph"]
        compile_mode = config["compile_mode"]
        compile_dynamic = config["compile_dynamic"]
        compile_transformer_blocks_only = config["compile_transformer_blocks_only"]
        sage_attention = config["sage_attention"]
        allow_sage_compile = config["allow_sage_compile"]
        enable_fp16_accumulation = config["enable_fp16_accumulation"]
        dynamo_cache_size_limit = config["dynamo_cache_size_limit"]

        model = 模型 if 模型 is not None else model
        try:
            if torch is None:
                raise RuntimeError("PyTorch 未安装")
            if model is None:
                raise RuntimeError("未接入模型")

            model_clone = model.clone()

            if enable_fp16_accumulation:
                if hasattr(torch.backends.cuda.matmul, "allow_fp16_accumulation"):
                    torch.backends.cuda.matmul.allow_fp16_accumulation = True
                    logging.info("已启用 FP16 累积")
                else:
                    logging.warning("当前 PyTorch 版本不支持 FP16 累积（需要 2.7.1+）")
            else:
                if hasattr(torch.backends.cuda.matmul, "allow_fp16_accumulation"):
                    torch.backends.cuda.matmul.allow_fp16_accumulation = False

            if sage_attention != "关闭":
                try:
                    sage_mode = SAGE_ATTENTION_MAP.get(sage_attention, sage_attention)
                    new_attention = get_sage_func(
                        sage_mode, allow_compile=allow_sage_compile
                    )
                    if new_attention is not None:

                        def attention_override_sage(func, *args, **kwargs):
                            return new_attention.__wrapped__(*args, **kwargs)

                        if "transformer_options" not in model_clone.model_options:
                            model_clone.model_options["transformer_options"] = {}
                        model_clone.model_options["transformer_options"][
                            "optimized_attention_override"
                        ] = attention_override_sage
                        logging.info(f"已应用 SageAttention: {sage_attention}")
                except Exception as e:
                    logging.warning(f"SageAttention 应用失败: {e}")
                    send_error_to_frontend(
                        unique_id,
                        "SageAttention 加载失败",
                        "请安装 sageattention 库",
                        f'"{sys.executable}" -m pip install sageattention',
                    )

            if enable_torch_compile:
                try:
                    model_clone = self.apply_torch_compile(
                        model_clone,
                        compile_backend,
                        compile_fullgraph,
                        compile_mode,
                        compile_dynamic,
                        compile_transformer_blocks_only,
                        dynamo_cache_size_limit,
                    )
                except Exception as e:
                    logging.warning(f"TorchCompile 应用失败: {e}")

            return (model_clone,)
        except Exception as e:
            logging.error(f"模型优化失败: {e}")
            traceback.print_exc()
            send_error_to_frontend(unique_id, "优化失败", str(e))
            return (model,)

    def apply_torch_compile(
        self,
        model,
        backend,
        fullgraph,
        mode,
        dynamic,
        compile_transformer_blocks_only,
        cache_size_limit,
    ):
        if not hasattr(torch, "compile"):
            logging.warning("当前 PyTorch 版本不支持 torch.compile")
            return model

        m = model.clone()
        diffusion_model = m.get_model_object("diffusion_model")

        if hasattr(torch, "_dynamo"):
            torch._dynamo.config.cache_size_limit = cache_size_limit

        dynamic_kv = {"启用": True, "关闭": False, "自动": None}
        dynamic_val = dynamic_kv.get(dynamic, None)

        compile_key_list = []
        if compile_transformer_blocks_only:
            layer_types = [
                "double_blocks",
                "single_blocks",
                "layers",
                "transformer_blocks",
                "blocks",
                "visual_transformer_blocks",
                "text_transformer_blocks",
            ]
            for layer_name in layer_types:
                if hasattr(diffusion_model, layer_name):
                    blocks = getattr(diffusion_model, layer_name)
                    for i in range(len(blocks)):
                        compile_key_list.append(f"diffusion_model.{layer_name}.{i}")
            if not compile_key_list:
                logging.warning("未找到可编译的 Transformer 块，将编译整个模型")
                compile_key_list = ["diffusion_model"]
        else:
            compile_key_list = ["diffusion_model"]

        from comfy_api.torch_helpers import set_torch_compile_wrapper

        try:
            set_torch_compile_wrapper(
                model=m,
                keys=compile_key_list,
                backend=backend,
                mode=mode,
                dynamic=dynamic_val,
                fullgraph=fullgraph,
            )
            logging.info(f"TorchCompile 已应用: {backend}, {mode}")
        except Exception as e:
            logging.warning(f"TorchCompile 应用失败: {e}")

        return m


NODE_CLASS_MAPPINGS["GJJ_ModelOptimizer"] = GJJ_ModelOptimizer
NODE_DISPLAY_NAME_MAPPINGS["GJJ_ModelOptimizer"] = "GJJ.🚀模型综合优化器"


class GJJ_CFGZeroStar:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "use_zero_init": (
                    "BOOLEAN",
                    {"default": True, "tooltip": "启用零初始化，将初始步的预测置零"},
                ),
                "zero_init_steps": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "tooltip": "零初始化的步数（从第0步开始计算）",
                    },
                ),
            }
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "patch"
    CATEGORY = "GJJ/模型优化"
    DESCRIPTION = "CFG ZeroStar 优化：https://github.com/WeichenFan/CFG-Zero-star"

    def patch(
        self, model, use_zero_init=True, zero_init_steps=0, unique_id=None, **kwargs
    ):
        try:
            m = model.clone()

            def cfg_zerostar(args):
                cond = args["cond"]
                timestep = args["timestep"]
                sigmas = args["model_options"]["transformer_options"]["sample_sigmas"]
                matched_step_index = (sigmas == timestep[0]).nonzero()
                if len(matched_step_index) > 0:
                    current_step_index = matched_step_index.item()
                else:
                    current_step_index = 0
                    for i in range(len(sigmas) - 1):
                        if (sigmas[i] - timestep[0]) * (
                            sigmas[i + 1] - timestep[0]
                        ) <= 0:
                            current_step_index = i
                            break

                if current_step_index <= zero_init_steps and use_zero_init:
                    return cond * 0

                uncond = args["uncond"]
                cond_scale = args["cond_scale"]
                batch_size = cond.shape[0]

                positive_flat = cond.view(batch_size, -1)
                negative_flat = uncond.view(batch_size, -1)

                dot_product = torch.sum(
                    positive_flat * negative_flat, dim=1, keepdim=True
                )
                squared_norm = torch.sum(negative_flat**2, dim=1, keepdim=True) + 1e-8
                alpha = dot_product / squared_norm
                alpha = alpha.view(batch_size, *([1] * (len(cond.shape) - 1)))

                noise_pred = uncond * alpha + cond_scale * (cond - uncond * alpha)
                return noise_pred

            m.set_model_sampler_cfg_function(cfg_zerostar)
            logging.info("CFG ZeroStar 已应用")
            return (m,)
        except Exception as e:
            logging.error(f"CFG ZeroStar 应用失败: {e}")
            send_error_to_frontend(unique_id, "CFG ZeroStar 失败", str(e))
            return (model,)


NODE_CLASS_MAPPINGS["GJJ_CFGZeroStar"] = GJJ_CFGZeroStar
NODE_DISPLAY_NAME_MAPPINGS["GJJ_CFGZeroStar"] = "⭐ GJJ CFG ZeroStar"


GJJ_TEACACHE_WAN_MODEL_TYPES = {
    "Wan2.1 文生视频 1.3B": "wan2.1_t2v_1.3B",
    "Wan2.1 文生视频 14B": "wan2.1_t2v_14B",
    "Wan2.1 图生视频 480p 14B": "wan2.1_i2v_480p_14B",
    "Wan2.1 图生视频 720p 14B": "wan2.1_i2v_720p_14B",
    "Wan2.1 文生视频 1.3B ret_mode": "wan2.1_t2v_1.3B_ret_mode",
    "Wan2.1 文生视频 14B ret_mode": "wan2.1_t2v_14B_ret_mode",
    "Wan2.1 图生视频 480p 14B ret_mode": "wan2.1_i2v_480p_14B_ret_mode",
    "Wan2.1 图生视频 720p 14B ret_mode": "wan2.1_i2v_720p_14B_ret_mode",
    "1.3B": "wan2.1_t2v_1.3B",
    "14B": "wan2.1_t2v_14B",
    "图生视频480p": "wan2.1_i2v_480p_14B",
    "图生视频720p": "wan2.1_i2v_720p_14B",
}

GJJ_TEACACHE_WAN_MODEL_CHOICES = [
    "Wan2.1 文生视频 1.3B",
    "Wan2.1 文生视频 14B",
    "Wan2.1 图生视频 480p 14B",
    "Wan2.1 图生视频 720p 14B",
    "Wan2.1 文生视频 1.3B ret_mode",
    "Wan2.1 文生视频 14B ret_mode",
    "Wan2.1 图生视频 480p 14B ret_mode",
    "Wan2.1 图生视频 720p 14B ret_mode",
]

GJJ_TEACACHE_WAN_COEFFICIENTS = {
    "wan2.1_t2v_1.3B": [2.39676752e03, -1.31110545e03, 2.01331979e02, -8.29855975e00, 1.37887774e-01],
    "wan2.1_t2v_14B": [-5784.54975374, 5449.50911966, -1811.16591783, 256.27178429, -13.02252404],
    "wan2.1_i2v_480p_14B": [-3.02331670e02, 2.23948934e02, -5.25463970e01, 5.87348440e00, -2.01973289e-01],
    "wan2.1_i2v_720p_14B": [-114.36346466, 65.26524496, -18.82220707, 4.91518089, -0.23412683],
    "wan2.1_t2v_1.3B_ret_mode": [-5.21862437e04, 9.23041404e03, -5.28275948e02, 1.36987616e01, -4.99875664e-02],
    "wan2.1_t2v_14B_ret_mode": [-3.03318725e05, 4.90537029e04, -2.65530556e03, 5.87365115e01, -3.15583525e-01],
    "wan2.1_i2v_480p_14B_ret_mode": [2.57151496e05, -3.54229917e04, 1.40286849e03, -1.35890334e01, 1.32517977e-01],
    "wan2.1_i2v_720p_14B_ret_mode": [8.10705460e03, 2.13393892e03, -3.72934672e02, 1.66203073e01, -4.17769401e-02],
}


def _gjj_teacache_resolve_cache_device(cache_device):
    if mm is None:
        raise RuntimeError("缺少 ComfyUI model_management，无法判断缓存设备。")
    return mm.get_torch_device() if cache_device == "主设备" else mm.unet_offload_device()


def _gjj_teacache_resolve_mode(mode, source_type):
    if mode == "自动":
        return "e0" if str(source_type).endswith("_ret_mode") else "e"
    return "e0" if mode == "e0" else "e"


def _gjj_teacache_coefficient_key(source_type, mode):
    source_type = str(source_type)
    if mode == "e0" and not source_type.endswith("_ret_mode"):
        candidate = f"{source_type}_ret_mode"
        if candidate in GJJ_TEACACHE_WAN_COEFFICIENTS:
            return candidate
    if mode == "e" and source_type.endswith("_ret_mode"):
        candidate = source_type[: -len("_ret_mode")]
        if candidate in GJJ_TEACACHE_WAN_COEFFICIENTS:
            return candidate
    return source_type


def _gjj_teacache_build_cache_args(rel_l1_thresh, start_step, end_step, cache_device, use_coefficients, mode):
    return {
        "cache_type": "TeaCache",
        "rel_l1_thresh": float(rel_l1_thresh),
        "start_step": int(start_step),
        "end_step": int(end_step),
        "cache_device": _gjj_teacache_resolve_cache_device(cache_device),
        "use_coefficients": bool(use_coefficients),
        "mode": mode,
    }


def _gjj_teacache_poly1d(coefficients, x):
    result = torch.zeros_like(x)
    degree = len(coefficients) - 1
    for index, coeff in enumerate(coefficients):
        result += float(coeff) * (x ** (degree - index))
    return result


def _gjj_teacache_wan_forward(self, x, t, context, clip_fea=None, freqs=None, transformer_options=None, **kwargs):
    if transformer_options is None:
        transformer_options = {}
    try:
        from comfy.ldm.wan.model import sinusoidal_embedding_1d
    except Exception as error:
        raise RuntimeError("当前 ComfyUI 缺少 WanVideo 官方模型函数 sinusoidal_embedding_1d，无法启用 TeaCache。") from error

    patches_replace = transformer_options.get("patches_replace", {})
    rel_l1_thresh = transformer_options.get("rel_l1_thresh")
    coefficients = transformer_options.get("coefficients")
    cond_or_uncond = transformer_options.get("cond_or_uncond") or [0]
    model_type = transformer_options.get("model_type", "")
    enable_teacache = transformer_options.get("enable_teacache", True)
    cache_device = transformer_options.get("cache_device") or x.device
    use_coefficients = bool(transformer_options.get("use_coefficients", True))
    teacache_mode = transformer_options.get("teacache_mode") or _gjj_teacache_resolve_mode("自动", model_type)

    x = self.patch_embedding(x.float()).to(x.dtype)
    grid_sizes = x.shape[2:]
    x = x.flatten(2).transpose(1, 2)

    e = self.time_embedding(sinusoidal_embedding_1d(self.freq_dim, t).to(dtype=x[0].dtype))
    e0 = self.time_projection(e).unflatten(1, (6, self.dim))

    context = self.text_embedding(context)

    context_img_len = None
    if clip_fea is not None:
        if self.img_emb is not None:
            context_clip = self.img_emb(clip_fea)
            context = torch.concat([context_clip, context], dim=1)
        context_img_len = clip_fea.shape[-2]

    blocks_replace = patches_replace.get("dit", {})
    modulated_input = e.to(cache_device) if use_coefficients and teacache_mode == "e" else e0.to(cache_device)
    if not hasattr(self, "teacache_state"):
        self.teacache_state = {
            0: {"should_calc": True, "accumulated_rel_l1_distance": 0, "previous_modulated_input": None, "previous_residual": None},
            1: {"should_calc": True, "accumulated_rel_l1_distance": 0, "previous_modulated_input": None, "previous_residual": None},
        }

    def update_cache_state(cache, current_input):
        if cache["previous_modulated_input"] is not None:
            try:
                delta = (current_input - cache["previous_modulated_input"]).abs().mean() / cache["previous_modulated_input"].abs().mean()
                if use_coefficients:
                    cache["accumulated_rel_l1_distance"] += _gjj_teacache_poly1d(coefficients, delta)
                else:
                    cache["accumulated_rel_l1_distance"] += delta
                if cache["accumulated_rel_l1_distance"] < rel_l1_thresh:
                    cache["should_calc"] = False
                else:
                    cache["should_calc"] = True
                    cache["accumulated_rel_l1_distance"] = 0
            except Exception:
                cache["should_calc"] = True
                cache["accumulated_rel_l1_distance"] = 0
        cache["previous_modulated_input"] = current_input

    batch_per_branch = max(1, int(len(x) / max(1, len(cond_or_uncond))))
    for i, key in enumerate(cond_or_uncond):
        cache_key = int(key)
        if cache_key not in self.teacache_state:
            self.teacache_state[cache_key] = {"should_calc": True, "accumulated_rel_l1_distance": 0, "previous_modulated_input": None, "previous_residual": None}
        update_cache_state(self.teacache_state[cache_key], modulated_input[i * batch_per_branch:(i + 1) * batch_per_branch])

    if enable_teacache:
        should_calc = False
        for key in cond_or_uncond:
            should_calc = should_calc or self.teacache_state[int(key)]["should_calc"]
    else:
        should_calc = True

    if not should_calc:
        for i, key in enumerate(cond_or_uncond):
            previous_residual = self.teacache_state[int(key)].get("previous_residual")
            if previous_residual is None:
                should_calc = True
                break
            x[i * batch_per_branch:(i + 1) * batch_per_branch] += previous_residual.to(x.device)

    if should_calc:
        original_x = x.to(cache_device)
        for index, block in enumerate(self.blocks):
            if ("double_block", index) in blocks_replace:
                def block_wrap(args):
                    out = {}
                    out["img"] = block(args["img"], context=args["txt"], e=args["vec"], freqs=args["pe"], context_img_len=context_img_len)
                    return out

                out = blocks_replace[("double_block", index)](
                    {"img": x, "txt": context, "vec": e0, "pe": freqs},
                    {"original_block": block_wrap, "transformer_options": transformer_options},
                )
                x = out["img"]
            else:
                x = block(x, e=e0, freqs=freqs, context=context, context_img_len=context_img_len)
        for i, key in enumerate(cond_or_uncond):
            self.teacache_state[int(key)]["previous_residual"] = (x.to(cache_device) - original_x)[i * batch_per_branch:(i + 1) * batch_per_branch]

    x = self.head(x, e)
    return self.unpatchify(x, grid_sizes)


class GJJ_TeaCacheWanVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "rel_l1_thresh": (
                    "FLOAT",
                    {
                        "default": 0.4,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.01,
                        "display_name": "缓存阈值",
                        "tooltip": "TeaCache 缓存强度。数值越大跳过越多、速度越快，但画面变化可能更大；0 表示关闭。",
                    },
                ),
                "start_percent": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "开始比例",
                        "tooltip": "从采样进度的哪个比例开始启用 TeaCache。0 表示从第一步开始。",
                    },
                ),
                "end_percent": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "结束比例",
                        "tooltip": "采样进度超过该比例后停止启用 TeaCache。1 表示一直启用到最后。",
                    },
                ),
                "cache_device": (
                    ["主设备", "卸载设备"],
                    {
                        "default": "主设备",
                        "display_name": "缓存设备",
                        "tooltip": "缓存存放位置。主设备速度更快但占显存；卸载设备更省显存。",
                    },
                ),
                "model_type": (
                    GJJ_TEACACHE_WAN_MODEL_CHOICES,
                    {
                        "default": "Wan2.1 图生视频 480p 14B",
                        "display_name": "模型类型",
                        "tooltip": "选择与当前 WanVideo 模型对应的 TeaCache 系数。旧工作流中的 1.3B/14B/图生视频480p/720p 会自动兼容。",
                    },
                ),
                "start_step": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": 9999,
                        "step": 1,
                        "display_name": "开始步数",
                        "tooltip": "输出缓存参数时使用：从第几步开始启用 TeaCache，连接到采样器 cache_args/teacache_args 时生效。",
                    },
                ),
                "end_step": (
                    "INT",
                    {
                        "default": -1,
                        "min": -1,
                        "max": 9999,
                        "step": 1,
                        "display_name": "结束步数",
                        "tooltip": "输出缓存参数时使用：-1 表示采样器自动使用最后一步。",
                    },
                ),
                "use_coefficients": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "使用系数",
                        "tooltip": "对齐原 WanVideo TeaCache 的 use_coefficients。关闭时阈值通常需要约缩小 10 倍。",
                    },
                ),
                "mode": (
                    ["自动", "e", "e0"],
                    {
                        "default": "自动",
                        "display_name": "嵌入模式",
                        "tooltip": "输出缓存参数时会转成原版 mode=e/e0；自动会按模型类型是否为 ret_mode 判断。",
                    },
                ),
            },
            "optional": {
                "model": (
                    "MODEL",
                    {
                        "display_name": "模型",
                        "tooltip": "可选。连接后输出挂载 TeaCache 的模型；不连接时仍可单独输出原 WanVideo TeaCache 的缓存参数。",
                    },
                ),
            }
        }

    RETURN_TYPES = ("MODEL", "CACHEARGS")
    RETURN_NAMES = ("模型", "缓存参数")
    OUTPUT_TOOLTIPS = (
        "已挂载 WanVideo TeaCache 的模型；用于 GJJ/ComfyUI 标准模型线。",
        "原 WanVideo TeaCache 兼容参数；连接到 WanVideo 采样器的 cache_args 或 teacache_args。",
    )
    FUNCTION = "patch"
    CATEGORY = "GJJ/模型优化"
    DESCRIPTION = "GJJ · 🍵 GJJ TeaCache (WanVideo)：支持模型直连 TeaCache，也可输出原 WanVideoWrapper 兼容的 CACHEARGS。"
    GJJ_HELP = {
        "title": "WanVideo TeaCache",
        "description": "同一个 GJJ 节点兼容两条链路：模型输出用于 GJJ/ComfyUI 标准模型线，缓存参数输出用于 WanVideoWrapper 风格采样器。",
        "🌏模型下载": "无需额外模型；复用已加载的 WanVideo 模型。",
        "requirements": [
            "模型直连模式需要当前 ComfyUI 内置 `comfy.ldm.wan.model.sinusoidal_embedding_1d`。",
            "模型直连模式需要输入模型本身是 Wan2.1/WanVideo 结构，否则模型没有对应 forward_orig 可挂载。",
            "缓存参数模式只生成本地 CACHEARGS 字典，不需要安装外部 WanVideoWrapper 节点包。",
        ],
        "usage": [
            "接第一个输出时，节点会在模型线路上挂载 TeaCache。",
            "接第二个输出时，把缓存参数连到 WanVideo 采样器的 cache_args 或 teacache_args。",
            "缓存阈值越大越快，但可能带来更多画面差异。",
            "开始比例/结束比例用于模型输出；开始步数/结束步数用于缓存参数输出。",
        ],
        "source": "GJJ 本地实现 + vendor/wanvideo_wrapper/cache_methods/nodes_cache.py",
    }

    def patch(
        self,
        rel_l1_thresh=0.4,
        start_percent=0.0,
        end_percent=1.0,
        start_step=1,
        end_step=-1,
        cache_device="主设备",
        use_coefficients=True,
        mode="自动",
        model_type="Wan2.1 图生视频 480p 14B",
        model=None,
        unique_id=None,
        **kwargs,
    ):
        cache_args = None
        try:
            source_type = GJJ_TEACACHE_WAN_MODEL_TYPES.get(model_type, str(model_type))
            resolved_mode = _gjj_teacache_resolve_mode(mode, source_type)
            cache_args = _gjj_teacache_build_cache_args(
                rel_l1_thresh,
                start_step,
                end_step,
                cache_device,
                use_coefficients,
                resolved_mode,
            )

            if model is None or rel_l1_thresh == 0:
                return (model, cache_args)

            if torch is None:
                raise RuntimeError("缺少 torch，无法启用 TeaCache。")

            coefficient_key = _gjj_teacache_coefficient_key(source_type, resolved_mode)
            coeffs = GJJ_TEACACHE_WAN_COEFFICIENTS.get(coefficient_key)
            if use_coefficients and not coeffs:
                raise RuntimeError(f"未找到模型类型 `{model_type}` 对应的 TeaCache 系数。")
            teacache_device = cache_args["cache_device"]

            model_clone = model.clone()
            if "transformer_options" not in model_clone.model_options:
                model_clone.model_options["transformer_options"] = {}
            model_clone.model_options["transformer_options"]["rel_l1_thresh"] = float(rel_l1_thresh)
            model_clone.model_options["transformer_options"]["cache_device"] = teacache_device
            model_clone.model_options["transformer_options"]["coefficients"] = coeffs
            model_clone.model_options["transformer_options"]["model_type"] = coefficient_key
            model_clone.model_options["transformer_options"]["use_coefficients"] = bool(use_coefficients)
            model_clone.model_options["transformer_options"]["teacache_mode"] = resolved_mode
            diffusion_model = model_clone.get_model_object("diffusion_model")
            if not hasattr(diffusion_model, "forward_orig"):
                raise RuntimeError("输入模型不是可识别的 WanVideo 模型：未找到 forward_orig。")

            def unet_wrapper_function(model_function, model_kwargs):
                input_value = model_kwargs["input"]
                timestep_value = model_kwargs["timestep"]
                c_value = model_kwargs["c"]
                sigmas = c_value["transformer_options"]["sample_sigmas"]
                cond_or_uncond = model_kwargs.get("cond_or_uncond", c_value["transformer_options"].get("cond_or_uncond", [0]))
                last_step_index = len(sigmas) - 1
                matched_step_index = (sigmas == timestep_value[0]).nonzero()
                if len(matched_step_index) > 0:
                    current_step_index = matched_step_index.item()
                else:
                    current_step_index = 0
                    for i in range(len(sigmas) - 1):
                        if (sigmas[i] - timestep_value[0]) * (sigmas[i + 1] - timestep_value[0]) <= 0:
                            current_step_index = i
                            break

                if current_step_index == 0:
                    if (
                        hasattr(diffusion_model, "teacache_state")
                        and diffusion_model.teacache_state.get(0, {}).get("previous_modulated_input") is not None
                        and diffusion_model.teacache_state.get(1, {}).get("previous_modulated_input") is not None
                    ):
                        delattr(diffusion_model, "teacache_state")

                current_percent = current_step_index / max(1, last_step_index)
                c_value["transformer_options"]["current_percent"] = current_percent
                c_value["transformer_options"]["enable_teacache"] = bool(start_percent <= current_percent <= end_percent)

                original_forward_orig = diffusion_model.forward_orig
                diffusion_model.forward_orig = _gjj_teacache_wan_forward.__get__(diffusion_model, diffusion_model.__class__)
                try:
                    return model_function(input_value, timestep_value, **c_value)
                finally:
                    diffusion_model.forward_orig = original_forward_orig

            model_clone.set_model_unet_function_wrapper(unet_wrapper_function)
            logging.info("GJJ TeaCache(WanVideo) 已应用：%s/%s", coefficient_key, resolved_mode)
            return (model_clone, cache_args)
        except Exception as e:
            logging.error(f"TeaCache 应用失败: {e}")
            traceback.print_exc()
            send_error_to_frontend(unique_id, "TeaCache 失败", f"{e}", None)
            return (model, cache_args)


NODE_CLASS_MAPPINGS["GJJ_TeaCacheWanVideo"] = GJJ_TeaCacheWanVideo
NODE_DISPLAY_NAME_MAPPINGS["GJJ_TeaCacheWanVideo"] = "GJJ · 🍵 GJJ TeaCache (WanVideo)"
