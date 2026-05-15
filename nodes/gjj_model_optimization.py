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


class GJJ_TeaCacheWanVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "rel_l1_thresh": (
                    "FLOAT",
                    {
                        "default": 0.275,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "tooltip": "TeaCache 阈值，越大跳过越多但可能失真。使用系数时推荐 0.2-0.4",
                    },
                ),
                "start_percent": (
                    "FLOAT",
                    {
                        "default": 0.1,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "开始启用 TeaCache 的步数百分比（避免前期跳过）",
                    },
                ),
                "end_percent": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "停止启用 TeaCache 的步数百分比",
                    },
                ),
                "cache_device": (
                    ["主设备", "卸载设备"],
                    {
                        "default": "卸载设备",
                        "tooltip": "缓存存储设备：主设备（快但占显存）或卸载设备（省显存）",
                    },
                ),
                "coefficients": (
                    ["关闭", "1.3B", "14B", "图生视频480p", "图生视频720p"],
                    {
                        "default": "图生视频480p",
                        "tooltip": "模型对应的系数预设，正确选择可提高缓存准确性",
                    },
                ),
            }
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "patch"
    CATEGORY = "GJJ/模型优化"
    DESCRIPTION = "TeaCache for WanVideo：加速 WanVideo 模型推理，https://github.com/ali-vilab/TeaCache"

    def patch(
        self,
        model,
        rel_l1_thresh=0.275,
        start_percent=0.1,
        end_percent=1.0,
        cache_device="卸载设备",
        coefficients="图生视频480p",
        unique_id=None,
        **kwargs,
    ):
        try:
            import numpy as np
            from unittest.mock import patch as mock_patch
        except ImportError:
            send_error_to_frontend(
                unique_id,
                "缺少依赖",
                "请安装 numpy",
                f'"{sys.executable}" -m pip install numpy',
            )
            return (model,)

        if rel_l1_thresh == 0:
            return (model,)

        coef_map = {
            "关闭": "disabled",
            "1.3B": "1.3B",
            "14B": "14B",
            "图生视频480p": "i2v_480",
            "图生视频720p": "i2v_720",
        }
        dev_map = {"主设备": "main_device", "卸载设备": "offload_device"}

        try:
            teacache_coefficients_map = {
                "disabled": [],
                "1.3B": [2396.76752, -1311.10545, 201.331979, -8.29855975, 0.137887774],
                "14B": [
                    -5784.54975374,
                    5449.50911966,
                    -1811.16591783,
                    256.27178429,
                    -13.02252404,
                ],
                "i2v_480": [
                    -302.33167,
                    223.948934,
                    -52.546397,
                    5.8734844,
                    -0.201973289,
                ],
                "i2v_720": [
                    -114.36346466,
                    65.26524496,
                    -18.82220707,
                    4.91518089,
                    -0.23412683,
                ],
            }
            coef_key = coef_map.get(coefficients, coefficients)
            coeffs = teacache_coefficients_map.get(coef_key, [])

            dev_key = dev_map.get(cache_device, cache_device)
            teacache_device = (
                mm.get_torch_device()
                if dev_key == "main_device"
                else mm.unet_offload_device()
            )

            model_clone = model.clone()
            if "transformer_options" not in model_clone.model_options:
                model_clone.model_options["transformer_options"] = {}
            model_clone.model_options["transformer_options"][
                "rel_l1_thresh"
            ] = rel_l1_thresh
            model_clone.model_options["transformer_options"][
                "teacache_device"
            ] = teacache_device
            model_clone.model_options["transformer_options"]["coefficients"] = coeffs
            diffusion_model = model_clone.get_model_object("diffusion_model")

            def relative_l1_distance(last_tensor, current_tensor):
                l1_distance = torch.abs(last_tensor - current_tensor).mean()
                norm = torch.abs(last_tensor).mean()
                relative_l1_distance = l1_distance / norm
                return relative_l1_distance.to(torch.float32)

            @torch.compiler.disable() if hasattr(torch, "compiler") else lambda f: f
            def tea_cache(self_obj, x, e0, e, transformer_options):
                rel_l1_thresh_val = transformer_options["rel_l1_thresh"]
                is_cond = (
                    True if transformer_options["cond_or_uncond"] == [0] else False
                )
                should_calc = True
                suffix = "cond" if is_cond else "uncond"

                if not hasattr(self_obj, "teacache_state"):
                    self_obj.teacache_state = {
                        "cond": {
                            "accumulated_rel_l1_distance": 0,
                            "prev_input": None,
                            "teacache_skipped_steps": 0,
                            "previous_residual": None,
                        },
                        "uncond": {
                            "accumulated_rel_l1_distance": 0,
                            "prev_input": None,
                            "teacache_skipped_steps": 0,
                            "previous_residual": None,
                        },
                    }

                cache = self_obj.teacache_state[suffix]

                if cache["prev_input"] is not None:
                    if transformer_options["coefficients"] == []:
                        temb_relative_l1 = relative_l1_distance(cache["prev_input"], e0)
                        curr_acc_dist = (
                            cache["accumulated_rel_l1_distance"] + temb_relative_l1
                        )
                    else:
                        rescale_func = np.poly1d(transformer_options["coefficients"])
                        curr_acc_dist = cache[
                            "accumulated_rel_l1_distance"
                        ] + rescale_func(
                            (
                                (e - cache["prev_input"]).abs().mean()
                                / cache["prev_input"].abs().mean()
                            )
                            .cpu()
                            .item()
                        )
                    try:
                        if curr_acc_dist < rel_l1_thresh_val:
                            should_calc = False
                            cache["accumulated_rel_l1_distance"] = curr_acc_dist
                        else:
                            should_calc = True
                            cache["accumulated_rel_l1_distance"] = 0
                    except:
                        should_calc = True
                        cache["accumulated_rel_l1_distance"] = 0

                if transformer_options["coefficients"] == []:
                    cache["prev_input"] = e0.clone().detach()
                else:
                    cache["prev_input"] = e.clone().detach()

                if not should_calc:
                    x += cache["previous_residual"].to(x.device)
                    cache["teacache_skipped_steps"] += 1
                return should_calc, cache

            def create_wrapper(diff_mod, start_p, end_p):
                def outer(func, kwargs):
                    input_val = kwargs["input"]
                    timestep_val = kwargs["timestep"]
                    c_val = kwargs["c"]
                    sigmas_val = c_val["transformer_options"]["sample_sigmas"]
                    cond_or_uncond_val = kwargs["cond_or_uncond"]
                    last_step_idx = len(sigmas_val) - 1

                    matched_idx = (sigmas_val == timestep_val[0]).nonzero()
                    if len(matched_idx) > 0:
                        current_step = matched_idx.item()
                    else:
                        current_step = 0
                        for i in range(len(sigmas_val) - 1):
                            if (sigmas_val[i] - timestep_val[0]) * (
                                sigmas_val[i + 1] - timestep_val[0]
                            ) <= 0:
                                current_step = i
                                break

                    if current_step == 0:
                        if (
                            len(cond_or_uncond_val) == 1 and cond_or_uncond_val[0] == 1
                        ) or len(cond_or_uncond_val) == 2:
                            if hasattr(diff_mod, "teacache_state"):
                                delattr(diff_mod, "teacache_state")

                    current_percent = current_step / (len(sigmas_val) - 1)
                    c_val["transformer_options"]["current_percent"] = current_percent
                    if start_p <= current_percent <= end_p:
                        c_val["transformer_options"]["teacache_enabled"] = True

                    original_forward = diff_mod.forward

                    def patched_forward(*args, **forward_kwargs):
                        forward_kwargs["transformer_options"] = c_val[
                            "transformer_options"
                        ]
                        return original_forward(*args, **forward_kwargs)

                    diff_mod.forward = patched_forward

                    result = func(input_val, timestep_val, **c_val)

                    if current_step + 1 == last_step_idx and hasattr(
                        diff_mod, "teacache_state"
                    ):
                        skipped_cond = diff_mod.teacache_state["cond"][
                            "teacache_skipped_steps"
                        ]
                        skipped_uncond = diff_mod.teacache_state["uncond"][
                            "teacache_skipped_steps"
                        ]
                        logging.info(
                            f"TeaCache 已跳过: cond={skipped_cond}, uncond={skipped_uncond}"
                        )

                    diff_mod.forward = original_forward
                    return result

                return outer

            wrapper_func = create_wrapper(diffusion_model, start_percent, end_percent)
            model_clone.set_model_unet_function_wrapper(wrapper_func)
            logging.info("TeaCache 已应用")
            return (model_clone,)
        except Exception as e:
            logging.error(f"TeaCache 应用失败: {e}")
            traceback.print_exc()
            send_error_to_frontend(unique_id, "TeaCache 失败", str(e))
            return (model,)


NODE_CLASS_MAPPINGS["GJJ_TeaCacheWanVideo"] = GJJ_TeaCacheWanVideo
NODE_DISPLAY_NAME_MAPPINGS["GJJ_TeaCacheWanVideo"] = "🍵 GJJ TeaCache (WanVideo)"
