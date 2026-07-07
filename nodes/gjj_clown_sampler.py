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
                        "display_name": "η 噪声量",
                        "tooltip": "每个采样步骤中临时加入再移除的噪声量。数值越大，随机扰动越明显；通常保持默认即可。",
                    },
                ),
                "sampler_name": (
                    SAMPLER_NAMES,
                    {
                        "default": "exponential/res_2s",
                        "display_name": "采样器名称",
                        "tooltip": "选择 Clown 采样器兼容名称。GJJ 零依赖版本会在后台自动映射到当前 ComfyUI 可用的采样器。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 94,
                        "min": -1,
                        "max": 0xffffffffffffffff,
                        "control_after_generate": True,
                        "display_name": "随机种子",
                        "tooltip": "用于兼容 SDE 噪声种子的数值。改变后可得到不同采样噪声。",
                    },
                ),
                "bongmath": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "Bongmath兼容",
                        "tooltip": "RES4LYF 工作流兼容开关。GJJ 零依赖版本保留该参数用于旧工作流兼容，通常保持开启。",
                    },
                ),
            },
            "optional": {
                "guides": ("GUIDES", {"display_name": "引导参数", "tooltip": "可选的 RES4LYF 引导参数输入。GJJ 零依赖版本保留该接口用于工作流兼容。"}),
                "options": ("OPTIONS", {"display_name": "采样选项", "tooltip": "可选的 RES4LYF 采样选项输入。连接后会优先读取其中的噪声量、种子、采样器名称和兼容开关。"}),
            },
        }

    RETURN_TYPES = ("SAMPLER",)
    RETURN_NAMES = ("采样器",)
    OUTPUT_TOOLTIPS = ("输出可连接到 SamplerCustomAdvanced 以及其它兼容 SAMPLER 输入的采样器对象。",)
    FUNCTION = "main"
    CATEGORY = "GJJ/视频/采样器"
    DESCRIPTION = "零依赖 Clown 采样器：界面兼容 RES4LYF ClownSampler_Beta，内部映射到当前 ComfyUI 可用的 SAMPLER。"
    GJJ_HELP = {
        "title": "Clown 采样器",
        "description": "面板接口兼容 RES4LYF ClownSampler_Beta：引导参数、采样选项、η 噪声量、采样器名称、随机种子、Bongmath 兼容和单个采样器输出。",
        "usage": [
            "把采样器输出连接到需要 SAMPLER 的采样节点。",
            "零依赖版不导入 RES4LYF 的 RK 求解器，会把 res_2m、res_2s 等名称映射到当前 ComfyUI 可用采样器。",
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
