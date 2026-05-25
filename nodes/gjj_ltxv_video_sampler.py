from __future__ import annotations

import gc
import re
from typing import Any

import comfy.model_management
import comfy.nested_tensor
import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview
import torch


NODE_NAME = "GJJ_LTXVVideoSampler"


def _sampler_names() -> list[str]:
    names = list(getattr(comfy.samplers, "SAMPLER_NAMES", []) or [])
    if names:
        return names
    names = list(getattr(comfy.samplers.KSampler, "SAMPLERS", []) or [])
    return names or ["euler", "euler_cfg_pp"]


def _as_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        result = int(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _as_float(value: Any, default: float, min_value: float, max_value: float) -> float:
    try:
        result = float(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _parse_sigmas(sigmas: str) -> torch.Tensor:
    values = re.findall(r"[-+]?(?:\d*\.*\d+)", str(sigmas or ""))
    if not values:
        raise RuntimeError("LTX视频采样器：Sigmas 不能为空，例如 0.85, 0.7250, 0.4219, 0.0。")
    parsed = [float(item) for item in values]
    if len(parsed) < 2:
        raise RuntimeError("LTX视频采样器：Sigmas 至少需要两个数值。")
    return torch.FloatTensor(parsed)


class _RandomNoise:
    def __init__(self, seed: int):
        self.seed = seed

    def generate_noise(self, input_latent: dict[str, Any]):
        latent_image = input_latent["samples"]
        batch_inds = input_latent["batch_index"] if "batch_index" in input_latent else None
        return comfy.sample.prepare_noise(latent_image, self.seed, batch_inds)


def _concat_av_latent(video_latent: dict[str, Any], audio_latent: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(video_latent, dict) or "samples" not in video_latent:
        raise RuntimeError("LTX视频采样器：视频 latent 输入缺少 samples。")
    if not isinstance(audio_latent, dict) or "samples" not in audio_latent:
        raise RuntimeError("LTX视频采样器：音频 latent 输入缺少 samples。")

    output = {}
    output.update(video_latent)
    output.update(audio_latent)

    video_noise_mask = video_latent.get("noise_mask", None)
    audio_noise_mask = audio_latent.get("noise_mask", None)
    if video_noise_mask is not None or audio_noise_mask is not None:
        if video_noise_mask is None:
            video_noise_mask = torch.ones_like(video_latent["samples"])
        if audio_noise_mask is None:
            audio_noise_mask = torch.ones_like(audio_latent["samples"])
        output["noise_mask"] = comfy.nested_tensor.NestedTensor((video_noise_mask, audio_noise_mask))

    output["samples"] = comfy.nested_tensor.NestedTensor((video_latent["samples"], audio_latent["samples"]))
    return output


def _cleanup_cuda() -> None:
    gc.collect()
    try:
        comfy.model_management.soft_empty_cache()
    except TypeError:
        comfy.model_management.soft_empty_cache(force=True)
    except Exception:
        pass
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass
    except Exception:
        pass


class GJJ_LTXVVideoSampler:
    @classmethod
    def INPUT_TYPES(cls):
        samplers = _sampler_names()
        default_sampler = "euler_cfg_pp" if "euler_cfg_pp" in samplers else samplers[0]
        return {
            "required": {
                "model": (
                    "MODEL",
                    {
                        "display_name": "模型",
                        "tooltip": "连接 LTX/LTXV 模型。内部会构造 CFGGuider。",
                    },
                ),
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正向条件",
                        "tooltip": "正向提示词条件，等同原 CFGGuider 的 positive 输入。",
                    },
                ),
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "负向条件",
                        "tooltip": "负向提示词条件，等同原 CFGGuider 的 negative 输入。",
                    },
                ),
                "video_latent": (
                    "LATENT",
                    {
                        "display_name": "视频Latent",
                        "tooltip": "视频 latent，内部会与音频 latent 合并为 LTXV AV latent。",
                    },
                ),
                "audio_latent": (
                    "LATENT",
                    {
                        "display_name": "音频Latent",
                        "tooltip": "音频 latent，内部会与视频 latent 合并为 LTXV AV latent。",
                    },
                ),
                "noise_seed": (
                    "INT",
                    {
                        "default": 42,
                        "min": 0,
                        "max": 0xffffffffffffffff,
                        "control_after_generate": True,
                        "display_name": "噪波种子",
                        "tooltip": "等同原 RandomNoise 的 noise_seed。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "round": 0.01,
                        "display_name": "CFG",
                        "tooltip": "等同原 CFGGuider 的 cfg。",
                    },
                ),
                "sampler_name": (
                    samplers,
                    {
                        "default": default_sampler,
                        "display_name": "K采样器",
                        "tooltip": "等同原 KSamplerSelect 的 sampler_name。",
                    },
                ),
                "sigmas": (
                    "STRING",
                    {
                        "default": "0.85, 0.7250, 0.4219, 0.0",
                        "multiline": False,
                        "display_name": "Sigmas",
                        "tooltip": "等同原 ManualSigmas，支持逗号或空格分隔，例如 0.85, 0.7250, 0.4219, 0.0。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("LATENT", "LATENT")
    RETURN_NAMES = ("采样Latent", "降噪Latent")
    OUTPUT_TOOLTIPS = ("SamplerCustomAdvanced 的 output。", "SamplerCustomAdvanced 的 denoised_output。")
    FUNCTION = "sample"
    CATEGORY = "GJJ/视频模型/LTXV"
    DESCRIPTION = "把 RandomNoise、CFGGuider、KSamplerSelect、ManualSigmas、LTXVConcatAVLatent、SamplerCustomAdvanced 合并成一个 LTX 视频采样器。"
    GJJ_HELP = {
        "title": "LTX 视频采样器",
        "description": "零依赖 GJJ 单节点，内部复刻六个原生节点串联：随机噪波、CFG 引导器、K 采样器选择、自定义 Sigmas、LTXV 音视频 latent 合并和高级自定义采样。",
        "usage": [
            "输入模型、正负条件、视频 latent、音频 latent。",
            "面板中的 seed、CFG、采样器、Sigmas 对应原来四个控制节点。",
            "输出与 SamplerCustomAdvanced 一致：采样 Latent 和降噪 Latent。",
        ],
    }

    def sample(self, model, positive, negative, video_latent, audio_latent, noise_seed, cfg, sampler_name, sigmas):
        noise_seed = _as_int(noise_seed, 42, 0, 0xffffffffffffffff)
        cfg = _as_float(cfg, 1.0, 0.0, 100.0)
        sigmas_tensor = _parse_sigmas(sigmas)
        sampler = comfy.samplers.sampler_object(str(sampler_name))

        guider = comfy.samplers.CFGGuider(model)
        guider.set_conds(positive, negative)
        guider.set_cfg(cfg)

        latent = _concat_av_latent(video_latent, audio_latent)
        latent_image = comfy.sample.fix_empty_latent_channels(
            guider.model_patcher,
            latent["samples"],
            latent.get("downscale_ratio_spacial", None),
        )
        latent = latent.copy()
        latent["samples"] = latent_image
        noise_mask = latent.get("noise_mask", None)

        x0_output: dict[str, Any] = {}
        callback = latent_preview.prepare_callback(guider.model_patcher, sigmas_tensor.shape[-1] - 1, x0_output)
        disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

        try:
            noise = _RandomNoise(noise_seed).generate_noise(latent)
            samples = guider.sample(
                noise,
                latent_image,
                sampler,
                sigmas_tensor,
                denoise_mask=noise_mask,
                callback=callback,
                disable_pbar=disable_pbar,
                seed=noise_seed,
            )
            samples = samples.to(comfy.model_management.intermediate_device())

            out = latent.copy()
            out.pop("downscale_ratio_spacial", None)
            out["samples"] = samples

            if "x0" in x0_output:
                x0_out = guider.model_patcher.model.process_latent_out(x0_output["x0"].cpu())
                if samples.is_nested:
                    latent_shapes = [x.shape for x in samples.unbind()]
                    x0_out = comfy.nested_tensor.NestedTensor(comfy.utils.unpack_latents(x0_out, latent_shapes))
                out_denoised = latent.copy()
                out_denoised.pop("downscale_ratio_spacial", None)
                out_denoised["samples"] = x0_out
            else:
                out_denoised = out

            return (out, out_denoised)
        finally:
            _cleanup_cuda()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTXVVideoSampler}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ LTX视频采样器"}
