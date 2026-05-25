from __future__ import annotations

import contextlib
import math
from typing import Any

import comfy.ldm.modules.attention
import comfy.samplers
import comfy.utils
import torch
from comfy.model_patcher import ModelPatcher
from comfy.patcher_extension import CallbacksMP


NODE_NAME = "GJJ_LTXVMultimodalGuider"


class _GJJ_STGFlag:
    def __init__(self, do_skip: bool = False, skip_layers: list[int] | None = None):
        self.do_skip = do_skip
        self.skip_layers = skip_layers


class _GJJ_PatchAttention(contextlib.AbstractContextManager):
    def __init__(self, attn_idx: int | list[int] | None = None):
        self.current_idx = -1
        if isinstance(attn_idx, int):
            self.attn_idx = [attn_idx]
        elif attn_idx is None:
            self.attn_idx = [0]
        else:
            self.attn_idx = list(attn_idx)

    def __enter__(self):
        self.original_attention = comfy.ldm.modules.attention.optimized_attention
        self.original_attention_masked = comfy.ldm.modules.attention.optimized_attention_masked
        comfy.ldm.modules.attention.optimized_attention = self.stg_attention
        comfy.ldm.modules.attention.optimized_attention_masked = self.stg_attention_masked
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        comfy.ldm.modules.attention.optimized_attention = self.original_attention
        comfy.ldm.modules.attention.optimized_attention_masked = self.original_attention_masked
        self.original_attention = None
        self.original_attention_masked = None
        return False

    def stg_attention(self, q, k, v, heads, *args, **kwargs):
        self.current_idx += 1
        if self.current_idx in self.attn_idx:
            return v
        return self.original_attention(q, k, v, heads, *args, **kwargs)

    def stg_attention_masked(self, q, k, v, heads, *args, **kwargs):
        self.current_idx += 1
        if self.current_idx in self.attn_idx:
            return v
        return self.original_attention_masked(q, k, v, heads, *args, **kwargs)


class _GJJ_STGBlockWrapper:
    def __init__(self, block, stg_flag: _GJJ_STGFlag, idx: int):
        self.flag = stg_flag
        self.idx = idx
        self.block = block

    def __call__(self, args, extra_args):
        context_manager = contextlib.nullcontext()
        stg_indexes = args["transformer_options"].get("stg_indexes", [0])
        if self.flag.do_skip and self.flag.skip_layers and self.idx in self.flag.skip_layers:
            context_manager = _GJJ_PatchAttention(stg_indexes)

        with context_manager:
            hidden_state = extra_args["original_block"](args)
        return hidden_state


class _GJJ_GuiderParameters:
    def __init__(
        self,
        cfg_scale: float = 1.0,
        stg_scale: float = 0.0,
        perturb_attn: bool = True,
        rescale_scale: float = 0.0,
        modality_scale: float = 1.0,
        skip_step: int = 0,
        cross_attn: bool = True,
    ):
        self.cfg_scale = float(cfg_scale)
        self.stg_scale = float(stg_scale)
        self.perturb_attn = bool(perturb_attn)
        self.rescale_scale = float(rescale_scale)
        self.modality_scale = float(modality_scale)
        self.skip_step = int(skip_step)
        self.cross_attn = bool(cross_attn)

    def calculate(self, noise_pred_pos, noise_pred_neg, noise_pred_perturbed, noise_pred_modality):
        noise_pred = (
            noise_pred_pos
            + (self.cfg_scale - 1.0) * (noise_pred_pos - noise_pred_neg)
            + self.stg_scale * (noise_pred_pos - noise_pred_perturbed)
            + (self.modality_scale - 1.0) * (noise_pred_pos - noise_pred_modality)
        )

        if not math.isclose(self.rescale_scale, 0.0):
            std = noise_pred.std()
            if torch.is_tensor(std) and torch.all(std != 0):
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


def _parse_skip_blocks(skip_blocks: str) -> list[int]:
    blocks: list[int] = []
    for item in str(skip_blocks or "").replace("，", ",").split(","):
        item = item.strip()
        if item:
            blocks.append(int(item))
    return blocks


def _param_from_external(value: Any) -> _GJJ_GuiderParameters:
    if isinstance(value, _GJJ_GuiderParameters):
        return value

    return _GJJ_GuiderParameters(
        cfg_scale=getattr(value, "cfg_scale", 1.0),
        stg_scale=getattr(value, "stg_scale", 0.0),
        perturb_attn=getattr(value, "perturb_attn", True),
        rescale_scale=getattr(value, "rescale_scale", 0.0),
        modality_scale=getattr(value, "modality_scale", 1.0),
        skip_step=getattr(value, "skip_step", 0),
        cross_attn=getattr(value, "cross_attn", True),
    )


def _build_parameters(
    parameters,
    video_cfg,
    video_stg,
    video_perturb_attn,
    video_rescale,
    video_modality_scale,
    video_skip_step,
    video_cross_attn,
    audio_cfg,
    audio_stg,
    audio_perturb_attn,
    audio_rescale,
    audio_modality_scale,
    audio_skip_step,
    audio_cross_attn,
) -> dict[str, _GJJ_GuiderParameters]:
    built = {
        "VIDEO": _GJJ_GuiderParameters(
            video_cfg,
            video_stg,
            video_perturb_attn,
            video_rescale,
            video_modality_scale,
            video_skip_step,
            video_cross_attn,
        ),
        "AUDIO": _GJJ_GuiderParameters(
            audio_cfg,
            audio_stg,
            audio_perturb_attn,
            audio_rescale,
            audio_modality_scale,
            audio_skip_step,
            audio_cross_attn,
        ),
    }

    if isinstance(parameters, dict):
        for key, value in parameters.items():
            modality = str(getattr(key, "value", key)).upper()
            if modality in built:
                built[modality] = _param_from_external(value)
    return built


def _set_temp_transformer_options(model_options: dict, values: dict[str, Any]) -> dict[str, Any]:
    transformer_options = model_options.setdefault("transformer_options", {})
    old_values = {}
    for key, value in values.items():
        old_values[key] = transformer_options.get(key, None)
        transformer_options[key] = value
    return old_values


def _restore_temp_transformer_options(model_options: dict, old_values: dict[str, Any]) -> None:
    transformer_options = model_options.get("transformer_options", {})
    for key, old_value in old_values.items():
        if old_value is None:
            transformer_options.pop(key, None)
        else:
            transformer_options[key] = old_value


class _GJJ_LTXVMultimodalGuider(comfy.samplers.CFGGuider):
    def __init__(self, model: ModelPatcher, parameters: dict[str, _GJJ_GuiderParameters], skip_blocks: list[int]):
        patched_model = model.clone()
        self.current_step = 0
        self.last_denoised_v = None
        self.last_denoised_a = None

        try:
            patched_model.add_callback_with_key(CallbacksMP.ON_PRE_RUN, "gjj_mm_guider_on_pre_run", self.reset_current_step)
        except Exception:
            pass

        super().__init__(patched_model)
        self.stg_flag = _GJJ_STGFlag(do_skip=False, skip_layers=skip_blocks)
        self.patch_model(patched_model, self.stg_flag)
        self.parameters = parameters

    def reset_current_step(self, model_patcher=None):
        self.current_step = 0
        self.last_denoised_v = None
        self.last_denoised_a = None

    @classmethod
    def patch_model(cls, model: ModelPatcher, stg_flag: _GJJ_STGFlag) -> None:
        transformer_blocks = cls.get_transformer_blocks(model)
        for i, block in enumerate(transformer_blocks):
            model.set_model_patch_replace(_GJJ_STGBlockWrapper(block, stg_flag, i), "dit", "double_block", i)

    @staticmethod
    def get_transformer_blocks(model: ModelPatcher):
        diffusion_model = model.get_model_object("diffusion_model")
        key = "diffusion_model.transformer_blocks"
        if diffusion_model.__class__.__name__ == "LTXVTransformer3D":
            key = "diffusion_model.transformer.transformer_blocks"
        return model.get_model_object(key)

    def set_conds(self, positive, negative):
        self.inner_set_conds({"positive": positive, "negative": negative})

    def calc_stg_indexes(self, run_vx: bool, run_ax: bool, audio_ptb: bool, video_ptb: bool) -> list[int]:
        stg_indexes = set()
        num_self_attns = int(run_vx) + int(run_ax)
        video_attn_idx = 0
        audio_attn_idx = 0 if num_self_attns == 1 else 2

        if video_ptb:
            stg_indexes.add(video_attn_idx)
        if audio_ptb:
            stg_indexes.add(audio_attn_idx)
        return list(stg_indexes)

    def unpack_latents(self, x: torch.Tensor):
        latent_shapes = self.conds.get("positive", {})[0].get("model_conds", {}).get("latent_shapes", None).cond
        return comfy.utils.unpack_latents(x, latent_shapes)

    def pack_latents(self, vx: torch.Tensor, ax: torch.Tensor):
        return comfy.utils.pack_latents([vx, ax])

    def predict_noise(self, x: torch.Tensor, timestep: torch.Tensor, model_options: dict = {}, seed=None):
        current_step = self.current_step
        self.current_step = current_step + 1

        positive_cond = self.conds.get("positive", None)
        negative_cond = self.conds.get("negative", None)
        audio_params = self.parameters.get("AUDIO", _GJJ_GuiderParameters())
        video_params = self.parameters.get("VIDEO", _GJJ_GuiderParameters())

        run_vx = not video_params.do_skip(current_step)
        run_ax = not audio_params.do_skip(current_step)
        run_a2v = video_params.do_cross_attn(current_step)
        run_v2a = audio_params.do_cross_attn(current_step)

        vx, ax = self.unpack_latents(x)
        if not run_vx:
            vx = self.last_denoised_v
        if not run_ax:
            ax = self.last_denoised_a
        x, _ = self.pack_latents(vx, ax)

        if not run_vx and not run_ax:
            return x

        base_options = {
            "run_vx": run_vx,
            "run_ax": run_ax,
            "a2v_cross_attn": run_a2v,
            "v2a_cross_attn": run_v2a,
        }

        old_options = _set_temp_transformer_options(model_options, base_options)
        try:
            noise_pred_pos = comfy.samplers.calc_cond_batch(self.inner_model, [positive_cond], x, timestep, model_options)[0]
        finally:
            _restore_temp_transformer_options(model_options, old_options)
        v_noise_pred_pos, a_noise_pred_pos = self.unpack_latents(noise_pred_pos)

        a_noise_pred_neg = v_noise_pred_neg = 0
        a_noise_pred_perturbed = v_noise_pred_perturbed = 0
        a_noise_pred_modality = v_noise_pred_modality = 0
        noise_pred_neg = torch.zeros_like(noise_pred_pos)
        noise_pred_perturbed = torch.zeros_like(noise_pred_pos)

        if any(params.do_uncond() for params in (audio_params, video_params)):
            old_options = _set_temp_transformer_options(model_options, base_options)
            try:
                noise_pred_neg = comfy.samplers.calc_cond_batch(self.inner_model, [negative_cond], x, timestep, model_options)[0]
            finally:
                _restore_temp_transformer_options(model_options, old_options)
            v_noise_pred_neg, a_noise_pred_neg = self.unpack_latents(noise_pred_neg)

        if any(params.do_perturbed() for params in (audio_params, video_params)):
            perturbed_options = dict(base_options)
            perturbed_options["ptb_index"] = 0
            perturbed_options["stg_indexes"] = self.calc_stg_indexes(
                run_vx,
                run_ax and getattr(ax, "numel", lambda: 0)() > 0,
                audio_params.perturb_attn,
                video_params.perturb_attn,
            )
            old_options = _set_temp_transformer_options(model_options, perturbed_options)
            self.stg_flag.do_skip = True
            try:
                noise_pred_perturbed = comfy.samplers.calc_cond_batch(self.inner_model, [positive_cond], x, timestep, model_options)[0]
            finally:
                self.stg_flag.do_skip = False
                _restore_temp_transformer_options(model_options, old_options)
            v_noise_pred_perturbed, a_noise_pred_perturbed = self.unpack_latents(noise_pred_perturbed)

        if any(params.do_modality() for params in (audio_params, video_params)):
            modality_options = dict(base_options)
            modality_options["a2v_cross_attn"] = False
            modality_options["v2a_cross_attn"] = False
            old_options = _set_temp_transformer_options(model_options, modality_options)
            try:
                noise_pred_modality = comfy.samplers.calc_cond_batch(self.inner_model, [positive_cond], x, timestep, model_options)[0]
            finally:
                _restore_temp_transformer_options(model_options, old_options)
            v_noise_pred_modality, a_noise_pred_modality = self.unpack_latents(noise_pred_modality)

        vx = video_params.calculate(v_noise_pred_pos, v_noise_pred_neg, v_noise_pred_perturbed, v_noise_pred_modality) if run_vx else self.last_denoised_v
        ax = audio_params.calculate(a_noise_pred_pos, a_noise_pred_neg, a_noise_pred_perturbed, a_noise_pred_modality) if run_ax else self.last_denoised_a
        x, _ = self.pack_latents(vx, ax)

        for fn in model_options.get("sampler_post_cfg_function", []):
            x = fn(
                {
                    "denoised": x,
                    "cond": positive_cond,
                    "uncond": negative_cond,
                    "model": self.inner_model,
                    "uncond_denoised": noise_pred_neg,
                    "cond_denoised": noise_pred_pos,
                    "sigma": timestep,
                    "model_options": model_options,
                    "input": x,
                    "perturbed_cond": positive_cond,
                    "perturbed_cond_denoised": noise_pred_perturbed,
                }
            )

        self.last_denoised_v, self.last_denoised_a = self.unpack_latents(x)
        return x


class GJJ_LTXVMultimodalGuider:
    @classmethod
    def INPUT_TYPES(cls):
        float_opts = {"min": 0.0, "max": 100.0, "step": 0.01}
        return {
            "required": {
                "model": ("MODEL", {"display_name": "模型", "tooltip": "连接 LTX/LTXV 模型。节点内部克隆并打 STG patch，不依赖 ComfyUI-LTXVideo。"}),
                "positive": ("CONDITIONING", {"display_name": "正向条件", "tooltip": "正向条件。"}),
                "negative": ("CONDITIONING", {"display_name": "负向条件", "tooltip": "负向条件。"}),
                "skip_blocks": ("STRING", {"default": "", "multiline": True, "display_name": "STG跳过块", "tooltip": "逗号分隔的 transformer block 索引，例如 14, 19。"}),
                "video_cfg": ("FLOAT", {**float_opts, "default": 1.0, "display_name": "视频CFG"}),
                "video_stg": ("FLOAT", {**float_opts, "default": 0.0, "display_name": "视频STG"}),
                "video_perturb_attn": ("BOOLEAN", {"default": True, "display_name": "视频扰动注意力"}),
                "video_rescale": ("FLOAT", {**float_opts, "max": 1.0, "default": 0.0, "display_name": "视频Rescale"}),
                "video_modality_scale": ("FLOAT", {**float_opts, "default": 1.0, "display_name": "视频模态比例"}),
                "video_skip_step": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1, "display_name": "视频跳步"}),
                "video_cross_attn": ("BOOLEAN", {"default": True, "display_name": "视频跨注意力"}),
                "audio_cfg": ("FLOAT", {**float_opts, "default": 1.0, "display_name": "音频CFG"}),
                "audio_stg": ("FLOAT", {**float_opts, "default": 0.0, "display_name": "音频STG"}),
                "audio_perturb_attn": ("BOOLEAN", {"default": True, "display_name": "音频扰动注意力"}),
                "audio_rescale": ("FLOAT", {**float_opts, "max": 1.0, "default": 0.0, "display_name": "音频Rescale"}),
                "audio_modality_scale": ("FLOAT", {**float_opts, "default": 1.0, "display_name": "音频模态比例"}),
                "audio_skip_step": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1, "display_name": "音频跳步"}),
                "audio_cross_attn": ("BOOLEAN", {"default": True, "display_name": "音频跨注意力"}),
            },
            "optional": {
                "parameters": ("GUIDER_PARAMETERS", {"default": None, "display_name": "外部参数", "tooltip": "可接原 MultimodalGuider 的 GUIDER_PARAMETERS；未连接时使用面板里的视频/音频参数。"}),
            },
        }

    RETURN_TYPES = ("GUIDER",)
    RETURN_NAMES = ("引导器",)
    OUTPUT_TOOLTIPS = ("兼容 SamplerCustomAdvanced / GJJ LTX视频采样器 的 GUIDER。",)
    FUNCTION = "get_guider"
    CATEGORY = "GJJ/视频模型/LTXV"
    DESCRIPTION = "零依赖移植 ComfyUI-LTXVideo 的 MultimodalGuider：对 LTXV 音视频 latent 分别执行 CFG、STG、跨模态和跳步引导。"
    GJJ_HELP = {
        "title": "LTXV 多模态引导器",
        "description": "从 ComfyUI-LTXVideo 的 MultimodalGuider 移植为 GJJ 单节点；内置 STG patch、参数结构和音视频 latent 拆分逻辑，不导入源插件。",
        "usage": [
            "接入 LTX/LTXV 模型、正负条件，输出 GUIDER 给自定义采样器。",
            "没有外部 GUIDER_PARAMETERS 时，直接使用面板中的视频/音频参数。",
            "需要复刻源工作流时，可以把源参数接到“外部参数”，同名 VIDEO/AUDIO 参数会覆盖面板值。",
        ],
    }

    def get_guider(
        self,
        model,
        positive,
        negative,
        skip_blocks,
        video_cfg,
        video_stg,
        video_perturb_attn,
        video_rescale,
        video_modality_scale,
        video_skip_step,
        video_cross_attn,
        audio_cfg,
        audio_stg,
        audio_perturb_attn,
        audio_rescale,
        audio_modality_scale,
        audio_skip_step,
        audio_cross_attn,
        parameters=None,
    ):
        parsed_skip_blocks = _parse_skip_blocks(skip_blocks)
        built_parameters = _build_parameters(
            parameters,
            video_cfg,
            video_stg,
            video_perturb_attn,
            video_rescale,
            video_modality_scale,
            video_skip_step,
            video_cross_attn,
            audio_cfg,
            audio_stg,
            audio_perturb_attn,
            audio_rescale,
            audio_modality_scale,
            audio_skip_step,
            audio_cross_attn,
        )
        guider = _GJJ_LTXVMultimodalGuider(model, built_parameters, parsed_skip_blocks)
        guider.set_conds(positive, negative)
        guider.raw_conds = (positive, negative)
        return (guider,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTXVMultimodalGuider}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎛️ LTXV多模态引导器"}
