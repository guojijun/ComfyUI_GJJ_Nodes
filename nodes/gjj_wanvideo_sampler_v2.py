from __future__ import annotations


def _load_sampler_runtime():
    try:
        from ..vendor.wanvideo_wrapper import nodes_sampler as sampler_runtime
    except ImportError as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo 采样 runtime 加载失败。\n"
            f"错误信息: {error}\n"
            "说明: 本节点不依赖 ComfyUI-WanVideoWrapper 插件本体；如果缺少 accelerate、tqdm、matplotlib、sageattention 等 pip 库，请按 GJJ SKILL 的运行时依赖方案安装。"
        ) from error
    return sampler_runtime


def _scheduler_choices():
    try:
        runtime = _load_sampler_runtime()
        choices = list(getattr(runtime, "scheduler_list", []) or [])
        return choices or ["unipc"]
    except Exception:
        return ["unipc"]


def _scheduler_default(preferred="dpm++_sde"):
    choices = _scheduler_choices()
    if preferred in choices:
        return preferred
    if "unipc" in choices:
        return "unipc"
    return choices[0] if choices else "unipc"


def _rope_choices():
    try:
        runtime = _load_sampler_runtime()
        choices = list(getattr(runtime, "rope_functions", []) or [])
        return choices or ["default", "comfy", "comfy_chunked"]
    except Exception:
        return ["default", "comfy", "comfy_chunked"]


class GJJ_WanVideoSchedulerV2:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scheduler": (_scheduler_choices(), {
                    "default": "unipc",
                    "display_name": "调度器",
                    "tooltip": "WanVideo 采样调度器。输出会连接到 GJJ WanVideo Sampler v2。",
                }),
                "steps": ("INT", {
                    "default": 30,
                    "min": 1,
                    "display_name": "步数",
                    "tooltip": "采样总步数。",
                }),
                "shift": ("FLOAT", {
                    "default": 5.0,
                    "min": 0.0,
                    "max": 1000.0,
                    "step": 0.01,
                    "display_name": "Shift",
                    "tooltip": "WanVideo flow shift 参数，常用默认值为 5.0。",
                }),
                "start_step": ("INT", {
                    "default": 0,
                    "min": 0,
                    "display_name": "起始步",
                    "tooltip": "从指定步开始采样；0 表示从头开始。",
                }),
                "end_step": ("INT", {
                    "default": -1,
                    "min": -1,
                    "display_name": "结束步",
                    "tooltip": "-1 表示采完整段；其它值表示提前结束。",
                }),
            },
            "optional": {
                "sigmas": ("SIGMAS", {
                    "display_name": "Sigmas",
                    "tooltip": "可选自定义 sigmas；不连接时由调度器自动生成。",
                }),
                "enhance_hf": ("BOOLEAN", {
                    "default": False,
                    "display_name": "增强高频",
                    "tooltip": "启用 WanVideoWrapper 的高频增强调度。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("WANVIDEOSCHEDULER",)
    RETURN_NAMES = ("调度器",)
    OUTPUT_TOOLTIPS = ("WanVideo Sampler v2 使用的调度器配置。",)
    FUNCTION = "process"
    CATEGORY = "GJJ/视频模型/WanVideo"
    DESCRIPTION = "GJJ WanVideo 调度器 v2：调用 GJJ 内置 vendored WanVideo runtime。"
    GJJ_HELP = {
        "title": "WanVideo 调度器 v2",
        "description": "生成 WanVideo Sampler v2 需要的调度器对象；GJJ 已 vendoring 核心 runtime，不需要安装 WanVideoWrapper 插件本体。",
        "runtime": "pip 运行时依赖仍按 GJJ SKILL 的 WanVideo 运行时依赖方案安装。",
    }

    def process(self, scheduler, steps, shift, start_step, end_step, unique_id=None, sigmas=None, enhance_hf=False):
        runtime = _load_sampler_runtime()
        node = runtime.WanVideoSchedulerv2()
        return node.process(
            scheduler=scheduler,
            steps=steps,
            shift=shift,
            start_step=start_step,
            end_step=end_step,
            unique_id=unique_id,
            sigmas=sigmas,
            enhance_hf=enhance_hf,
        )


class GJJ_WanVideoSamplerV2ExtraArgs:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "riflex_freq_index": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 1000,
                    "step": 1,
                    "display_name": "RIFLEX 频率索引",
                    "tooltip": "0 表示关闭；用于减少续帧循环感。",
                }),
                "feta_args": ("FETAARGS", {
                    "display_name": "FETA 参数",
                    "tooltip": "可选 FETA 增强参数。",
                }),
                "context_options": ("WANVIDCONTEXT", {
                    "display_name": "上下文窗口",
                    "tooltip": "可选长视频上下文窗口配置。",
                }),
                "cache_args": ("CACHEARGS", {
                    "display_name": "缓存参数",
                    "tooltip": "可选 TeaCache/MagCache/EasyCache 等缓存配置。",
                }),
                "slg_args": ("SLGARGS", {
                    "display_name": "SLG 参数",
                    "tooltip": "可选 Skip Layer Guidance 参数。",
                }),
                "rope_function": (["default", "comfy", "comfy_chunked"], {
                    "default": "comfy",
                    "display_name": "RoPE 函数",
                    "tooltip": "comfy 通常更快；comfy_chunked 峰值显存更低；特殊模型可用 default。",
                }),
                "loop_args": ("LOOPARGS", {
                    "display_name": "循环参数",
                    "tooltip": "可选循环视频参数。",
                }),
                "experimental_args": ("EXPERIMENTALARGS", {
                    "display_name": "实验参数",
                    "tooltip": "可选 WanVideoWrapper 实验参数。",
                }),
                "unianimate_poses": ("UNIANIMATE_POSE", {
                    "display_name": "UniAnimate 姿态",
                    "tooltip": "可选 UniAnimate 姿态控制。",
                }),
                "fantasytalking_embeds": ("FANTASYTALKING_EMBEDS", {
                    "display_name": "FantasyTalking 条件",
                    "tooltip": "可选 FantasyTalking 条件。",
                }),
                "uni3c_embeds": ("UNI3C_EMBEDS", {
                    "display_name": "Uni3C 条件",
                    "tooltip": "可选 Uni3C 条件。",
                }),
                "multitalk_embeds": ("MULTITALK_EMBEDS", {
                    "display_name": "MultiTalk 条件",
                    "tooltip": "可选 MultiTalk/InfiniteTalk 音频条件。",
                }),
            },
        }

    RETURN_TYPES = ("WANVIDSAMPLEREXTRAARGS",)
    RETURN_NAMES = ("扩展参数",)
    OUTPUT_TOOLTIPS = ("WanVideo Sampler v2 的可选扩展参数包。",)
    FUNCTION = "process"
    CATEGORY = "GJJ/视频模型/WanVideo"
    DESCRIPTION = "GJJ WanVideo Sampler v2 扩展参数：调用 GJJ 内置 vendored WanVideo runtime。"

    def process(self, **kwargs):
        runtime = _load_sampler_runtime()
        node = runtime.WanVideoSamplerExtraArgs()
        return node.process(**kwargs)


class GJJ_WanVideoSamplerV2:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("WANVIDEOMODEL", {
                    "display_name": "WanVideo 模型",
                    "tooltip": "由 GJJ WanVideo 模型加载器输出的模型。",
                }),
                "image_embeds": ("WANVIDIMAGE_EMBEDS", {
                    "display_name": "图像条件",
                    "tooltip": "WanVideo 图像/空 latent 条件，例如 VACE、I2V 或空条件编码输出。",
                }),
                "steps": ("INT", {
                    "default": 6,
                    "min": 1,
                    "display_name": "采样步数",
                    "tooltip": "采样总步数。",
                }),
                "cfg": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 30.0,
                    "step": 0.01,
                    "display_name": "CFG",
                    "tooltip": "提示词引导强度。",
                }),
                "shift": ("FLOAT", {
                    "default": 8.0,
                    "min": 0.0,
                    "max": 1000.0,
                    "step": 0.01,
                    "display_name": "Shift",
                    "tooltip": "WanVideo flow shift 参数。Wan2.2 常见工作流会使用 8.0。",
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 0xffffffffffffffff,
                    "display_name": "种子",
                    "tooltip": "随机种子。",
                }),
                "force_offload": ("BOOLEAN", {
                    "default": True,
                    "display_name": "采样后卸载",
                    "tooltip": "采样后把模型移回卸载设备，减少显存占用。",
                }),
                "scheduler": (_scheduler_choices(), {
                    "default": _scheduler_default("dpm++_sde"),
                    "display_name": "调度器",
                    "tooltip": "采样调度器，直接在节点面板选择。",
                }),
                "riflex_freq_index": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 1000,
                    "step": 1,
                    "display_name": "RIFLEX 频率索引",
                    "tooltip": "0 表示关闭；用于减少续帧循环感。",
                }),
            },
            "optional": {
                "text_embeds": ("WANVIDEOTEXTEMBEDS", {
                    "display_name": "文本条件",
                    "tooltip": "可选 WanVideo 文本编码输出；不连接时使用空文本条件。",
                }),
                "samples": ("LATENT", {
                    "display_name": "初始 latent",
                    "tooltip": "视频转视频或续采样时使用的初始 latent。",
                }),
                "denoise_strength": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display_name": "降噪强度",
                    "tooltip": "视频转视频或续采样时的降噪强度。",
                }),
                "feta_args": ("FETAARGS", {
                    "display_name": "FETA 参数",
                    "tooltip": "对齐原版 WanVideo Sampler 的可选 FETA 增强参数。",
                }),
                "context_options": ("WANVIDCONTEXT", {
                    "display_name": "上下文窗口",
                    "tooltip": "对齐原版 WanVideo Sampler 的长视频上下文窗口参数。",
                }),
                "cache_args": ("CACHEARGS", {
                    "display_name": "缓存参数",
                    "tooltip": "对齐原版 WanVideo Sampler 的 TeaCache/MagCache/EasyCache 参数。",
                }),
                "teacache_args": ("CACHEARGS", {
                    "display_name": "TeaCache 兼容参数",
                    "tooltip": "对齐原版 process 的旧版兼容入口；连接后会按原版逻辑优先覆盖缓存参数。",
                }),
                "flowedit_args": ("FLOWEDITARGS", {
                    "display_name": "FlowEdit 参数",
                    "tooltip": "原版保留的旧接口；当前 WanVideoWrapper runtime 已废弃，连接后会按原版逻辑报错。",
                }),
                "batched_cfg": ("BOOLEAN", {
                    "default": False,
                    "display_name": "批量 CFG",
                    "tooltip": "将正负条件合批运行，可能更快但会占用更多显存。",
                }),
                "slg_args": ("SLGARGS", {
                    "display_name": "SLG 参数",
                    "tooltip": "对齐原版 WanVideo Sampler 的 Skip Layer Guidance 参数。",
                }),
                "rope_function": (_rope_choices(), {
                    "default": "comfy",
                    "display_name": "RoPE 函数",
                    "tooltip": "comfy 通常更快；comfy_chunked 峰值显存更低；特殊模型可用 default。",
                }),
                "loop_args": ("LOOPARGS", {
                    "display_name": "循环参数",
                    "tooltip": "对齐原版 WanVideo Sampler 的循环视频参数。",
                }),
                "experimental_args": ("EXPERIMENTALARGS", {
                    "display_name": "实验参数",
                    "tooltip": "对齐原版 WanVideo Sampler 的实验参数。",
                }),
                "sigmas": ("SIGMAS", {
                    "display_name": "Sigmas",
                    "tooltip": "对齐原版 WanVideo Sampler 的自定义 sigmas 输入；连接后会改变采样时间步。",
                }),
                "unianimate_poses": ("UNIANIMATE_POSE", {
                    "display_name": "UniAnimate 姿态",
                    "tooltip": "对齐原版 WanVideo Sampler 的 UniAnimate 姿态控制。",
                }),
                "fantasytalking_embeds": ("FANTASYTALKING_EMBEDS", {
                    "display_name": "FantasyTalking 条件",
                    "tooltip": "对齐原版 WanVideo Sampler 的 FantasyTalking 条件。",
                }),
                "uni3c_embeds": ("UNI3C_EMBEDS", {
                    "display_name": "Uni3C 条件",
                    "tooltip": "对齐原版 WanVideo Sampler 的 Uni3C 条件。",
                }),
                "multitalk_embeds": ("MULTITALK_EMBEDS", {
                    "display_name": "MultiTalk 条件",
                    "tooltip": "对齐原版 WanVideo Sampler 的 MultiTalk/InfiniteTalk 音频条件。",
                }),
                "freeinit_args": ("FREEINITARGS", {
                    "display_name": "FreeInit 参数",
                    "tooltip": "对齐原版 WanVideo Sampler 的 FreeInit 参数；连接后会改变初始噪声和迭代采样。",
                }),
                "start_step": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 10000,
                    "step": 1,
                    "display_name": "起始步",
                    "tooltip": "从指定步开始采样；0 表示完整采样。",
                }),
                "end_step": ("INT", {
                    "default": -1,
                    "min": -1,
                    "max": 10000,
                    "step": 1,
                    "display_name": "结束步",
                    "tooltip": "-1 表示完整采样；其它值表示采样到指定步结束。",
                }),
                "add_noise_to_samples": ("BOOLEAN", {
                    "default": False,
                    "display_name": "给 latent 加噪",
                    "tooltip": "视频转视频从干净 latent 开始时可启用。",
                }),
                "extra_args": ("WANVIDSAMPLEREXTRAARGS", {
                    "display_name": "扩展参数",
                    "tooltip": "连接 GJJ WanVideo 采样扩展参数；连接后会覆盖同名面板参数。",
                }),
            },
        }

    RETURN_TYPES = ("LATENT", "LATENT")
    RETURN_NAMES = ("采样 latent", "去噪 latent")
    OUTPUT_TOOLTIPS = ("采样结果 latent。", "去噪后的 latent，供预览或调试使用。")
    FUNCTION = "process"
    CATEGORY = "GJJ/视频模型/WanVideo"
    DESCRIPTION = "GJJ WanVideo 视频采样器 v2：调用 GJJ 内置 vendored WanVideoWrapper 核心 runtime。"
    GJJ_HELP = {
        "title": "WanVideo Sampler v2",
        "description": "复刻 WanVideoWrapper 的 Sampler v2 调用层，实际采样逻辑来自 GJJ/vendor/wanvideo_wrapper 内置 runtime。",
        "🌏模型下载": "复用本机 ComfyUI models/diffusion_models、models/unet_gguf、models/vae 等 WanVideo 模型目录。",
        "runtime": "无需安装 ComfyUI-WanVideoWrapper 插件本体；pip 依赖仍按 GJJ SKILL 的 WanVideo 运行时依赖方案安装。",
    }

    def process(
        self,
        model,
        image_embeds,
        steps,
        cfg,
        shift,
        seed,
        force_offload,
        scheduler,
        riflex_freq_index,
        denoise_strength,
        batched_cfg,
        rope_function,
        start_step,
        end_step,
        add_noise_to_samples,
        text_embeds=None,
        samples=None,
        feta_args=None,
        context_options=None,
        cache_args=None,
        teacache_args=None,
        flowedit_args=None,
        slg_args=None,
        loop_args=None,
        experimental_args=None,
        sigmas=None,
        unianimate_poses=None,
        fantasytalking_embeds=None,
        uni3c_embeds=None,
        multitalk_embeds=None,
        freeinit_args=None,
        extra_args=None,
    ):
        runtime = _load_sampler_runtime()
        node = runtime.WanVideoSampler()
        scheduler_choices = set(_scheduler_choices())
        if scheduler not in scheduler_choices:
            scheduler = _scheduler_default("dpm++_sde")
        rope_choices = set(_rope_choices())
        if rope_function not in rope_choices:
            rope_function = "comfy" if "comfy" in rope_choices else next(iter(rope_choices), "default")
        if not isinstance(force_offload, bool):
            force_offload = True
        if not isinstance(batched_cfg, bool):
            batched_cfg = False
        if not isinstance(add_noise_to_samples, bool):
            add_noise_to_samples = False
        args = {
            "model": model,
            "image_embeds": image_embeds,
            "steps": steps,
            "cfg": cfg,
            "shift": shift,
            "seed": seed,
            "force_offload": force_offload,
            "scheduler": scheduler,
            "riflex_freq_index": riflex_freq_index,
            "text_embeds": text_embeds,
            "samples": samples,
            "feta_args": feta_args,
            "denoise_strength": denoise_strength,
            "context_options": context_options,
            "cache_args": cache_args,
            "teacache_args": teacache_args,
            "flowedit_args": flowedit_args,
            "batched_cfg": batched_cfg,
            "slg_args": slg_args,
            "rope_function": rope_function,
            "loop_args": loop_args,
            "experimental_args": experimental_args,
            "sigmas": sigmas,
            "unianimate_poses": unianimate_poses,
            "fantasytalking_embeds": fantasytalking_embeds,
            "uni3c_embeds": uni3c_embeds,
            "multitalk_embeds": multitalk_embeds,
            "freeinit_args": freeinit_args,
            "start_step": start_step,
            "end_step": end_step,
            "add_noise_to_samples": add_noise_to_samples,
        }
        if extra_args is not None:
            args.update(extra_args)
        return node.process(**args)


NODE_CLASS_MAPPINGS = {
    "GJJ_WanVideoSchedulerV2": GJJ_WanVideoSchedulerV2,
    "GJJ_WanVideoSamplerV2ExtraArgs": GJJ_WanVideoSamplerV2ExtraArgs,
    "GJJ_WanVideoSamplerV2": GJJ_WanVideoSamplerV2,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WanVideoSchedulerV2": "GJJ · 🗓️ WanVideo 调度器 v2",
    "GJJ_WanVideoSamplerV2ExtraArgs": "GJJ · 🧰 WanVideo 采样扩展参数",
    "GJJ_WanVideoSamplerV2": "GJJ · 🎞️ WanVideo 视频采样器 v2",
}
