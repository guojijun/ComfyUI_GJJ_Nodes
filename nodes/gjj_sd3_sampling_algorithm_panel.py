from __future__ import annotations

from typing import Any

NODE_NAME = "GJJ_SD3SamplingAlgorithmPanel"


def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "enable", "enabled", "开", "是", "真"}:
        return True
    if text in {"0", "false", "no", "off", "disable", "disabled", "关", "否", "假"}:
        return False
    return bool(value)


def _get_model_sampling_sd3_class():
    """兼容不同 ComfyUI 版本里的 ModelSamplingSD3 位置。"""
    # 新版 ComfyUI 通常在 comfy_extras.nodes_model_advanced
    try:
        from comfy_extras.nodes_model_advanced import ModelSamplingSD3

        return ModelSamplingSD3
    except Exception:
        pass

    # 少数旧版/整合包可能挂到 nodes.py
    try:
        from nodes import ModelSamplingSD3

        return ModelSamplingSD3
    except Exception:
        pass

    # 再从 NODE_CLASS_MAPPINGS 里找显示名/类名
    try:
        import nodes

        mapping = getattr(nodes, "NODE_CLASS_MAPPINGS", {}) or {}
        for key, cls in mapping.items():
            if str(key).lower() in {"modelsamplingsd3", "model_sampling_sd3"}:
                return cls
            if getattr(cls, "__name__", "").lower() == "modelsamplingsd3":
                return cls
    except Exception:
        pass

    raise ImportError(
        "找不到 ModelSamplingSD3。请确认当前 ComfyUI 版本包含“采样算法（SD3）/ModelSamplingSD3”节点。"
    )


def _patch_sd3_sampling(model: Any, shift: float):
    try:
        ModelSamplingSD3 = _get_model_sampling_sd3_class()
        return ModelSamplingSD3().patch(model, float(shift))[0]
    except Exception as exc:
        raise RuntimeError(f"SD3 采样算法补丁失败：shift={shift}\n{exc}") from exc


def _latent_details(latent_image: Any) -> str:
    samples = latent_image.get("samples") if isinstance(latent_image, dict) else None
    shape = getattr(samples, "shape", None)
    if shape is None:
        return "Latent 张量形状无法读取。"

    try:
        dimensions = tuple(int(value) for value in shape)
    except Exception:
        return f"Latent 张量形状：{shape}。"

    if len(dimensions) >= 5:
        return f"当前输入为视频 Latent，张量形状为 {dimensions}，时间维长度为 {dimensions[2]}。"
    return f"当前 Latent 张量形状为 {dimensions}。"


def _is_memory_error(exc: Exception) -> bool:
    message = str(exc).lower()
    markers = (
        "out of memory",
        "not enough memory",
        "can't allocate memory",
        "cannot allocate memory",
        "defaultcpuallocator",
        "内存不足",
        "显存不足",
    )
    return any(marker in message for marker in markers)


def _advanced_ksampler(
    model: Any,
    positive: Any,
    negative: Any,
    latent_image: Any,
    add_noise: bool,
    noise_seed: int,
    steps: int,
    cfg: float,
    denoise: float,
    sampler_name: str,
    scheduler: str,
    start_at_step: int,
    end_at_step: int,
    return_with_leftover_noise: bool,
):
    try:
        from nodes import KSamplerAdvanced

        return KSamplerAdvanced().sample(
            model,
            "enable" if add_noise else "disable",
            int(noise_seed),
            int(steps),
            float(cfg),
            str(sampler_name),
            str(scheduler),
            positive,
            negative,
            latent_image,
            int(start_at_step),
            int(end_at_step),
            "enable" if return_with_leftover_noise else "disable",
            float(denoise),
        )[0]
    except Exception as exc:
        context = (
            "K采样器（高级）执行失败：\n"
            f"add_noise={add_noise}, seed={noise_seed}, steps={steps}, cfg={cfg}, "
            f"denoise={denoise}, "
            f"sampler={sampler_name}, scheduler={scheduler}, start={start_at_step}, end={end_at_step}, "
            f"return_leftover={return_with_leftover_noise}\n"
        )
        if _is_memory_error(exc):
            context += (
                "\n检测到采样内存/显存溢出。\n"
                f"{_latent_details(latent_image)}\n"
                "本节点只封装 SD3 ModelSampling 与 ComfyUI 原生 KSamplerAdvanced，"
                "会把整段 Latent 一次送入模型，不提供长视频上下文窗口采样。\n"
                "长视频请改用支持 context_options 的「GJJ · 🎞️ WanVideo 视频采样器 v2」，"
                "或减少帧数/分辨率。系统内存容量不能替代 GPU 采样所需显存。\n"
            )
        raise RuntimeError(f"{context}原始错误：{exc}") from exc


class GJJ_SD3SamplingAlgorithmPanel:
    CATEGORY = "GJJ/采样"
    FUNCTION = "sample"
    DESCRIPTION = (
        "将“采样算法（SD3）”和“K采样器（高级）”合并到一个紧凑面板。"
        "先对模型应用 SD3 shift 采样算法，再执行高级 KSampler。"
    )
    SEARCH_ALIASES = [
        "sd3 sampling",
        "model sampling sd3",
        "ksampler advanced",
        "采样算法",
        "高级采样",
        "SD3",
    ]

    RETURN_TYPES = ("LATENT", "MODEL")
    RETURN_NAMES = ("Latent图像", "采样模型")
    OUTPUT_TOOLTIPS = (
        "高级 KSampler 采样后的 LATENT。",
        "应用 SD3 shift 采样算法后的模型，可继续传递给下游。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        try:
            import comfy.samplers

            sampler_names = comfy.samplers.KSampler.SAMPLERS
            scheduler_names = comfy.samplers.KSampler.SCHEDULERS
        except Exception:
            sampler_names = [
                "euler",
                "euler_cfg_pp",
                "dpmpp_2m",
                "dpmpp_2m_sde",
                "dpmpp_sde",
                "heun",
                "dpm_2",
            ]
            scheduler_names = [
                "simple",
                "normal",
                "karras",
                "exponential",
                "sgm_uniform",
            ]

        return {
            "required": {
                "model": (
                    "MODEL",
                    {
                        "display_name": "模型",
                        "tooltip": "输入基础模型。节点内部会先应用 SD3 采样算法 shift，再执行 KSampler Advanced。",
                    },
                ),
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正面条件",
                        "tooltip": "正面 CONDITIONING。",
                    },
                ),
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "负面条件",
                        "tooltip": "负面 CONDITIONING。",
                    },
                ),
                "latent_image": (
                    "LATENT",
                    {
                        "display_name": "Latent图像",
                        "tooltip": "输入初始 latent。",
                    },
                ),
                # 以下由前端统一面板维护，原生 widget 全部隐藏。
                "shift": (
                    "FLOAT",
                    {
                        "default": 5.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "移位",
                        "tooltip": "SD3 ModelSampling shift 值。",
                    },
                ),
                "add_noise": (
                    "STRING",
                    {
                        "default": "True",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "🔊 添加噪波",
                        "tooltip": "对应 KSampler Advanced 的 add_noise。原生输入隐藏，由面板底部按钮控制。",
                    },
                ),
                "noise_seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "display_name": "随机种",
                        "tooltip": "噪声随机种。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 4,
                        "min": 1,
                        "max": 10000,
                        "display_name": "步数",
                        "tooltip": "采样总步数。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display_name": "CFG",
                        "tooltip": "CFG scale。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": 1.00,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪数量",
                        "tooltip": "降噪强度，1.00 表示完全降噪，0.0 表示不降噪。",
                    },
                ),
                "sampler_name": (
                    sampler_names,
                    {
                        "default": (
                            "euler" if "euler" in sampler_names else sampler_names[0]
                        ),
                        "display_name": "采样器",
                        "tooltip": "KSampler 采样器名称。",
                    },
                ),
                "scheduler": (
                    scheduler_names,
                    {
                        "default": (
                            "simple"
                            if "simple" in scheduler_names
                            else scheduler_names[0]
                        ),
                        "display_name": "调度器",
                        "tooltip": "KSampler 调度器名称。",
                    },
                ),
                "start_at_step": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 10000,
                        "display_name": "开始步数",
                        "tooltip": "从第几步开始采样。",
                    },
                ),
                "end_at_step": (
                    "INT",
                    {
                        "default": 10000,
                        "min": 0,
                        "max": 10000,
                        "display_name": "结束步数",
                        "tooltip": "采样到第几步结束。可设为 steps。",
                    },
                ),
                "return_with_leftover_noise": (
                    "STRING",
                    {
                        "default": "false",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "↩️ 剩余噪波",
                        "tooltip": "对应 KSampler Advanced 的 return_with_leftover_noise。原生输入隐藏，由面板底部按钮控制。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        keys = [
            "shift",
            "add_noise",
            "noise_seed",
            "steps",
            "cfg",
            "denoise",
            "sampler_name",
            "scheduler",
            "start_at_step",
            "end_at_step",
            "return_with_leftover_noise",
        ]
        return "|".join(str(kwargs.get(key, "")) for key in keys)

    def sample(self, *args, **kwargs):
        model = kwargs.get("model")
        positive = kwargs.get("positive")
        negative = kwargs.get("negative")
        latent_image = kwargs.get("latent_image")

        if model is None:
            raise RuntimeError("请连接模型输入。")
        if positive is None:
            raise RuntimeError("请连接正面条件。")
        if negative is None:
            raise RuntimeError("请连接负面条件。")
        if latent_image is None:
            raise RuntimeError("请连接 Latent 图像。")

        shift = float(kwargs.get("shift", 5.0))
        add_noise = _as_bool(kwargs.get("add_noise", False))
        noise_seed = int(kwargs.get("noise_seed", 0))
        steps = int(kwargs.get("steps", 4))
        cfg = float(kwargs.get("cfg", 1.0))
        denoise = max(0.0, min(1.0, float(kwargs.get("denoise", 1.0))))
        sampler_name = str(kwargs.get("sampler_name", "euler") or "euler")
        scheduler = str(kwargs.get("scheduler", "simple") or "simple")
        start_at_step = int(kwargs.get("start_at_step", 0))
        end_at_step = int(kwargs.get("end_at_step", steps))
        return_with_leftover_noise = _as_bool(
            kwargs.get("return_with_leftover_noise", False)
        )

        if end_at_step <= 0:
            end_at_step = steps
        if end_at_step < start_at_step:
            end_at_step = start_at_step

        patched_model = _patch_sd3_sampling(model, shift)
        latent = _advanced_ksampler(
            patched_model,
            positive,
            negative,
            latent_image,
            add_noise,
            noise_seed,
            steps,
            cfg,
            denoise,
            sampler_name,
            scheduler,
            start_at_step,
            end_at_step,
            return_with_leftover_noise,
        )
        return (latent, patched_model)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SD3SamplingAlgorithmPanel}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ⚙️ SD3采样算法(Wan)"}
