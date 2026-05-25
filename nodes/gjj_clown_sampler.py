from __future__ import annotations

from typing import Any

import comfy.samplers


NODE_NAME = "GJJ_ClownSampler"

SAMPLER_NAMES = [
    "explicit/res_2m",
    "explicit/res_3m",
    "explicit/res_2s",
    "explicit/res_3s",
    "exponential/res_2m",
    "exponential/res_3m",
    "exponential/res_2s",
    "exponential/res_3s",
    "multistep/res_2m",
    "multistep/res_3m",
    "multistep/res_2s",
    "multistep/res_3s",
    "res_2m",
    "res_3m",
    "res_2s",
    "res_3s",
    "dpmpp_2m",
    "dpmpp_3m",
    "deis_2m",
    "deis_3m",
    "euler",
    "heun_2s",
]

ETA_CAPABLE_SAMPLERS = {
    "euler_ancestral",
    "euler_ancestral_cfg_pp",
    "dpm_2_ancestral",
    "dpmpp_2s_ancestral",
    "dpmpp_2s_ancestral_cfg_pp",
    "dpmpp_sde",
    "dpmpp_sde_gpu",
    "dpmpp_2m_sde",
    "dpmpp_2m_sde_gpu",
    "dpmpp_2m_sde_heun",
    "dpmpp_2m_sde_heun_gpu",
    "dpmpp_3m_sde",
    "dpmpp_3m_sde_gpu",
    "res_multistep_ancestral",
    "res_multistep_ancestral_cfg_pp",
    "seeds_2",
    "seeds_3",
    "exp_heun_2_x0_sde",
}


def _available_samplers() -> list[str]:
    names = list(getattr(comfy.samplers, "SAMPLER_NAMES", []) or [])
    if names:
        return names
    return list(getattr(comfy.samplers.KSampler, "SAMPLERS", []) or [])


def _as_float(value: Any, default: float, min_value: float, max_value: float) -> float:
    try:
        result = float(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _as_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        result = int(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _strip_sampler_name(name: str) -> str:
    text = str(name or "").strip()
    if "/" in text:
        text = text.rsplit("/", 1)[-1]
    return text or "res_2m"


def _mapped_sampler_name(name: str) -> str:
    requested = _strip_sampler_name(name)
    available = set(_available_samplers())

    if requested in available:
        return requested

    aliases = {
        "res_2m": ("res_multistep", "dpmpp_2m", "euler"),
        "res_3m": ("res_multistep", "dpmpp_3m_sde", "dpmpp_2m", "euler"),
        "res_2s": ("res_multistep", "dpmpp_2s_ancestral", "euler"),
        "res_3s": ("res_multistep", "dpmpp_sde", "euler"),
        "dpmpp_3m": ("dpmpp_3m_sde", "dpmpp_2m", "euler"),
        "deis_2m": ("deis", "dpmpp_2m", "euler"),
        "deis_3m": ("deis", "dpmpp_2m", "euler"),
        "heun_2s": ("heun", "euler"),
    }

    for candidate in aliases.get(requested, (requested, "dpmpp_2m", "euler")):
        if candidate in available:
            return candidate

    return next(iter(available)) if available else "euler"


class GJJ_ClownSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "eta": (
                    "FLOAT",
                    {
                        "default": 0.25,
                        "min": -100.0,
                        "max": 100.0,
                        "step": 0.01,
                        "round": False,
                        "display_name": "eta",
                        "tooltip": "Calculated noise amount to be added, then removed, after each step.",
                    },
                ),
                "sampler_name": (
                    SAMPLER_NAMES,
                    {
                        "default": "exponential/res_2s",
                        "display_name": "sampler_name",
                        "tooltip": "RES4LYF ClownSampler sampler_name. The zero-dependency GJJ version maps it to an available ComfyUI sampler internally.",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 94,
                        "min": -1,
                        "max": 0xffffffffffffffff,
                        "control_after_generate": True,
                        "display_name": "seed",
                        "tooltip": "SDE noise seed compatibility value.",
                    },
                ),
                "bongmath": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "bongmath",
                        "tooltip": "Bongmath compatibility switch. Kept for workflow compatibility.",
                    },
                ),
            },
            "optional": {
                "guides": ("GUIDES", {"display_name": "guides", "tooltip": "Optional RES4LYF guides input kept for workflow compatibility."}),
                "options": ("OPTIONS", {"display_name": "options", "tooltip": "Optional RES4LYF options input kept for workflow compatibility."}),
            },
        }

    RETURN_TYPES = ("SAMPLER",)
    RETURN_NAMES = ("sampler",)
    OUTPUT_TOOLTIPS = ("Sampler output for SamplerCustomAdvanced and compatible sampler nodes.",)
    FUNCTION = "main"
    CATEGORY = "GJJ/采样器"
    DESCRIPTION = "零依赖 ClownSampler：界面和 RES4LYF ClownSampler_Beta 对齐，内部映射到当前 ComfyUI 可用 SAMPLER。"
    GJJ_HELP = {
        "title": "Clown 采样器",
        "description": "面板接口对齐 RES4LYF ClownSampler_Beta：guides、options、eta、sampler_name、seed、bongmath 和单个 sampler 输出。",
        "usage": [
            "把 sampler 输出连接到需要 SAMPLER 的采样节点。",
            "零依赖版不导入 RES4LYF 的 RK 求解器，会把 res_2m/res_2s 等名称映射到当前 ComfyUI 可用采样器。",
        ],
    }

    def main(self, eta=0.25, sampler_name="exponential/res_2s", seed=94, bongmath=True, guides=None, options=None):
        if isinstance(options, dict):
            eta = options.get("eta", eta)
            seed = options.get("noise_seed_sde", options.get("seed", seed))
            sampler_name = options.get("sampler_name", options.get("rk_type", sampler_name))
            bongmath = options.get("BONGMATH", options.get("bongmath", bongmath))

        eta = _as_float(eta, 0.25, -100.0, 100.0)
        seed = _as_int(seed, 94, -1, 0xffffffffffffffff)
        mapped_name = _mapped_sampler_name(str(sampler_name))

        if mapped_name in ETA_CAPABLE_SAMPLERS:
            sampler = comfy.samplers.ksampler(mapped_name, {"eta": eta})
        else:
            sampler = comfy.samplers.sampler_object(mapped_name)

        return (sampler,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ClownSampler}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎛️ Clown采样器"}
