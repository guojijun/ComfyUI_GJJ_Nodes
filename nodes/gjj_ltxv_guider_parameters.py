from __future__ import annotations

import math
from typing import Any


NODE_NAME = "GJJ_LTXVGuiderParameters"
MODALITIES = ["VIDEO", "AUDIO"]


class GJJ_LTXVGuiderParameterSet:
    def __init__(
        self,
        cfg_scale: float = 1.0,
        stg_scale: float = 1.0,
        perturb_attn: bool = True,
        rescale_scale: float = 0.7,
        modality_scale: float = 0.0,
        skip_step: int = 0,
        cross_attn: bool = True,
        cfg_zero_star: bool = False,
        zero_init_sigma: float = 1.0,
    ):
        self.cfg_scale = float(cfg_scale)
        self.stg_scale = float(stg_scale)
        self.perturb_attn = bool(perturb_attn)
        self.rescale_scale = float(rescale_scale)
        self.modality_scale = float(modality_scale)
        self.skip_step = int(skip_step)
        self.cross_attn = bool(cross_attn)
        self.cfg_zero_star = bool(cfg_zero_star)
        self.zero_init_sigma = float(zero_init_sigma)

    def __str__(self) -> str:
        return (
            f"cfg_scale: {self.cfg_scale}, stg_scale: {self.stg_scale}, "
            f"rescale_scale: {self.rescale_scale}, modality_scale: {self.modality_scale}"
        )

    def __repr__(self) -> str:
        return str(self)

    def calculate(self, noise_pred_pos, noise_pred_neg, noise_pred_perturbed, noise_pred_modality):
        noise_pred = (
            noise_pred_pos
            + (self.cfg_scale - 1.0) * (noise_pred_pos - noise_pred_neg)
            + self.stg_scale * (noise_pred_pos - noise_pred_perturbed)
            + (self.modality_scale - 1.0) * (noise_pred_pos - noise_pred_modality)
        )

        if not math.isclose(self.rescale_scale, 0.0):
            std = noise_pred.std()
            try:
                has_std = bool((std != 0).all().item())
            except Exception:
                has_std = std != 0
            if has_std:
                factor = noise_pred_pos.std() / std
                factor = self.rescale_scale * factor + (1.0 - self.rescale_scale)
                noise_pred = noise_pred * factor

        return noise_pred

    def do_uncond(self) -> bool:
        return not math.isclose(self.cfg_scale, 1.0)

    def do_perturbed(self) -> bool:
        return not math.isclose(self.stg_scale, 0.0)

    def do_modality(self) -> bool:
        return not math.isclose(self.modality_scale, 1.0)

    def do_skip(self, step: int) -> bool:
        if self.skip_step <= 0:
            return False
        return step % (self.skip_step + 1) != 0

    def do_cross_attn(self, step: int) -> bool:
        return self.cross_attn and not self.do_skip(step)


def _normalize_modality(modality: Any) -> str:
    value = str(getattr(modality, "value", modality)).upper()
    if value not in MODALITIES:
        raise RuntimeError(f"LTXV 引导参数：模态必须是 VIDEO 或 AUDIO，当前为 {modality!r}。")
    return value


class GJJ_LTXVGuiderParameters:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "modality": (
                    MODALITIES,
                    {
                        "default": "VIDEO",
                        "display_name": "模态",
                        "tooltip": "选择这组参数作用于视频 latent 还是音频 latent。VIDEO=视频，AUDIO=音频。",
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
                        "tooltip": "该模态的 CFG 强度。1 表示不额外计算负向条件。",
                    },
                ),
                "stg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "STG",
                        "tooltip": "该模态的 Spatio-Temporal Skip Guidance 强度。0 表示关闭扰动分支。",
                    },
                ),
                "perturb_attn": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "扰动注意力",
                        "tooltip": "开启后，STG 扰动分支会对该模态对应的注意力位置生效。",
                    },
                ),
                "rescale": (
                    "FLOAT",
                    {
                        "default": 0.7,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "重缩放",
                        "tooltip": "按正向预测的标准差重新缩放最终噪声预测；0 表示不重缩放。",
                    },
                ),
                "modality_scale": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "模态隔离比例",
                        "tooltip": "控制关闭音视频交叉注意力时的模态隔离引导强度。1 表示不使用该分支。",
                    },
                ),
                "skip_step": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "display_name": "跳步间隔",
                        "tooltip": "大于 0 时，该模态每隔指定步数才参与一次预测，可节省计算。",
                    },
                ),
                "cross_attn": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "跨模态注意力",
                        "tooltip": "开启该模态对应的音视频交叉注意力。跳步时会临时关闭。",
                    },
                ),
            },
            "optional": {
                "parameters": (
                    "GUIDER_PARAMETERS",
                    {
                        "default": None,
                        "display_name": "已有参数",
                        "tooltip": "可接上一组 LTXV 引导参数，用于链式添加 VIDEO 和 AUDIO 两组参数。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("GUIDER_PARAMETERS",)
    RETURN_NAMES = ("引导参数",)
    OUTPUT_TOOLTIPS = ("输出给 GJJ LTXV 多模态引导器或兼容 MultimodalGuider 的 GUIDER_PARAMETERS。",)
    FUNCTION = "get_parameters"
    CATEGORY = "GJJ/视频模型/LTXV"
    DESCRIPTION = "零依赖移植 ComfyUI-LTXVideo 的 GuiderParameters：为 LTXV 多模态引导器生成视频或音频引导参数。"
    GJJ_HELP = {
        "title": "LTXV 引导参数",
        "description": "生成兼容 MultimodalGuider 的 GUIDER_PARAMETERS。可先建 VIDEO，再把输出接到第二个节点生成 AUDIO。",
        "usage": [
            "模态选择 VIDEO 或 AUDIO。",
            "需要同时控制视频和音频时，串联两个本节点，第二个节点的“已有参数”接第一个输出。",
            "输出可直接接到 GJJ · 🎛️ LTXV多模态引导器 的“外部参数”。",
        ],
    }

    def get_parameters(
        self,
        modality,
        cfg,
        stg,
        perturb_attn,
        rescale,
        modality_scale,
        skip_step,
        cross_attn,
        parameters=None,
    ):
        modality_key = _normalize_modality(modality)
        merged = dict(parameters) if isinstance(parameters, dict) else {}

        normalized_existing = {_normalize_modality(key): key for key in merged.keys()}
        if modality_key in normalized_existing:
            raise RuntimeError(f"LTXV 引导参数：{modality_key} 已经存在，请不要重复添加同一模态。")

        merged[modality_key] = GJJ_LTXVGuiderParameterSet(
            cfg,
            stg,
            perturb_attn,
            rescale,
            modality_scale,
            skip_step,
            cross_attn,
        )
        return (merged,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTXVGuiderParameters}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎛️ LTXV引导参数"}
