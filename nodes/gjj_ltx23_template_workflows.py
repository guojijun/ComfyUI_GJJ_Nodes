from __future__ import annotations

import copy
import json
from typing import Any

import torch
from comfy_extras.nodes_video import GetVideoComponents

from .gjj_ltx23_image_to_video import GJJ_LTX23ImageToVideo
from .gjj_ltx23_multiref_image_to_video import (
    DEFAULT_DENOISE_STRENGTH,
    DEFAULT_SEGMENT_VIDEO_FORMAT,
    DEFAULT_TRANSITION_EARLY_TAIL_RATIO,
    DEFAULT_TRANSITION_EARLY_TAIL_STRENGTH,
    DEFAULT_TRANSITION_FINAL_GUIDE_STRENGTH,
    DEFAULT_TRANSITION_IMPLICIT_GUIDE_COUNT,
    DEFAULT_TRANSITION_IMPLICIT_GUIDE_STRENGTH,
    SEGMENT_SAVE_PRESETS,
    TRANSITION_CURVES,
    GJJ_LTX23ImageToVideoMultiRef,
)


def _chain(*items: tuple[str, float]) -> str:
    return json.dumps(
        [
            {"enabled": True, "name": str(name), "strength": float(strength)}
            for name, strength in items
            if str(name or "").strip() and abs(float(strength)) > 1e-6
        ],
        ensure_ascii=False,
    )


MULTIREF_LORAS = _chain(
    ("LTX\\ltx2.3-transition.safetensors", 1.0),
    ("head_swap_v1_13500_first_frame", 1.0),
    ("LTX\\ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors", 0.2),
    ("LTX\\ltx-2-19b-ic-lora-detailer.safetensors", 0.51),
)

DIGITAL_HUMAN_MULTIREF_LORAS = _chain(
    ("LTX\\ltx-2.3-22b-distilled-lora-384-1.1.safetensors", 0.5),
    ("LTX\\LTX-2.3-22b-AV-LoRA-talking-head-v1.safetensors", 0.8),
)

FOUR_PANEL_LORAS = _chain()

ALL_REFERENCE_LORAS = _chain(
    ("ltx\\Ltx2.3-Licon-VBVR-I2V-240K-R32.safetensors", 1.0),
    ("ltx\\VBVR-LTX2.3", 1.0),
    ("ltx\\双人分镜头对话增强LTX2.3-IC-LORA-Dual-Character.safetensors", 1.0),
)

RELAY_DEFAULT_PROMPT = "一个卡通男人和一个卡通女人在海边"
RELAY_DEFAULT_LOCAL_PROMPTS = "首先是旁白说话，男人和女人都不说话，只是喝着饮料\n|\n女人说话\n|\n男人说话"


def _set_required_default(spec: dict[str, Any], key: str, value: Any) -> None:
    try:
        field = spec["required"][key]
        options = dict(field[1])
        options["default"] = value
        spec["required"][key] = (field[0], options)
    except Exception:
        pass


def _set_optional_tooltip(spec: dict[str, Any], key: str, tooltip: str) -> None:
    try:
        field = spec["optional"][key]
        options = dict(field[1])
        options["tooltip"] = tooltip
        spec["optional"][key] = (field[0], options)
    except Exception:
        pass


class _PresetMultiRefBase(GJJ_LTX23ImageToVideoMultiRef):
    DEFAULT_LORA_CHAIN = ""
    DEFAULT_PROMPT = ""
    DEFAULT_NEGATIVE = ""
    DEFAULT_WIDTH = 1280
    DEFAULT_HEIGHT = 720
    DEFAULT_SEGMENT_SECONDS = 5.0
    DEFAULT_FPS = 24
    DEFAULT_SEGMENTED = False

    @classmethod
    def INPUT_TYPES(cls):
        spec = copy.deepcopy(super().INPUT_TYPES())
        _set_required_default(spec, "positive_prompt", cls.DEFAULT_PROMPT)
        _set_required_default(spec, "negative_prompt", cls.DEFAULT_NEGATIVE)
        _set_required_default(spec, "width", cls.DEFAULT_WIDTH)
        _set_required_default(spec, "height", cls.DEFAULT_HEIGHT)
        _set_required_default(spec, "segment_seconds", cls.DEFAULT_SEGMENT_SECONDS)
        _set_required_default(spec, "fps", cls.DEFAULT_FPS)
        _set_required_default(spec, "segmented_execution", cls.DEFAULT_SEGMENTED)
        return spec

    def generate(self, **kwargs):
        if not str(kwargs.get("lora_chain_config", "") or "").strip() and self.DEFAULT_LORA_CHAIN:
            kwargs["lora_chain_config"] = self.DEFAULT_LORA_CHAIN
        return super().generate(**kwargs)


class GJJ_LTX23WorkflowMultiImageReference(_PresetMultiRefBase):
    DESCRIPTION = "把 ltx-2.3-图生视频-多图参考版封装成 GJJ 零依赖预设节点，内置原工作流 LoRA 串联默认值。"
    SEARCH_ALIASES = ["ltx-2.3-图生视频-多图参考版", "ltx 多图参考版", "图生视频 多图参考"]
    DEFAULT_PROMPT = "多张参考图连续过渡，主体动作自然，镜头语言稳定，电影感光影，细节真实。"
    DEFAULT_NEGATIVE = "titles, subtitles, text, watermark, logo, blurry text, distorted text, overlay, out of focus, overexposed, underexposed, low contrast, excessive noise, motion blur, camera shake, inconsistent framing, AI artifacts."
    DEFAULT_WIDTH = 1280
    DEFAULT_HEIGHT = 720
    DEFAULT_SEGMENT_SECONDS = 5.0
    DEFAULT_FPS = 24
    DEFAULT_LORA_CHAIN = MULTIREF_LORAS


class GJJ_LTX23WorkflowDigitalHumanMultiRef(_PresetMultiRefBase):
    DESCRIPTION = "把 ltx-2.3-数字人-多图参考版封装成 GJJ 零依赖预设节点；接入音频后自动按数字人多图参考流程运行。"
    SEARCH_ALIASES = ["ltx-2.3-数字人-多图参考版", "ltx 数字人 多图参考", "talking head multiref"]
    DEFAULT_PROMPT = "主体自然说话，口型与输入音频同步，头部和上半身动作稳定，保留参考图身份和场景一致性。"
    DEFAULT_NEGATIVE = GJJ_LTX23WorkflowMultiImageReference.DEFAULT_NEGATIVE
    DEFAULT_WIDTH = 1280
    DEFAULT_HEIGHT = 720
    DEFAULT_SEGMENT_SECONDS = 5.0
    DEFAULT_FPS = 24
    DEFAULT_LORA_CHAIN = DIGITAL_HUMAN_MULTIREF_LORAS


def _ensure_video_frames(video: Any) -> tuple[torch.Tensor, dict[str, Any] | None, float | None]:
    if isinstance(video, torch.Tensor):
        frames = video
        audio = None
        frame_rate = None
    elif video is None:
        raise RuntimeError("参考视频为空。")
    else:
        try:
            frames, audio, frame_rate = GetVideoComponents.execute(video)[0:3]
        except Exception as exc:
            raise RuntimeError(f"读取参考视频失败，请连接 ComfyUI 核心 Load Video 或其他 VIDEO 输出。\n详细错误：{exc}") from exc
    if not isinstance(frames, torch.Tensor):
        raise RuntimeError("参考视频拆出的帧格式无效，应为 IMAGE 批次。")
    if frames.ndim == 3:
        frames = frames.unsqueeze(0)
    if frames.ndim != 4 or int(frames.shape[0]) <= 0:
        raise RuntimeError(f"参考视频拆出的帧维度无效：{tuple(frames.shape)}")
    return frames, audio, float(frame_rate) if frame_rate else None


def _sample_video_keyframes(frames: torch.Tensor, count: int) -> torch.Tensor:
    count = max(1, int(count))
    total = int(frames.shape[0])
    if total <= count:
        return frames.contiguous()
    if count == 1:
        indices = [0]
    else:
        indices = [round(index * (total - 1) / (count - 1)) for index in range(count)]
    return frames[indices].contiguous()


class GJJ_LTX23WorkflowAllReference(_PresetMultiRefBase):
    DESCRIPTION = "把 LTX2.3 全能参考 / AIEverything / RH 可用 / 多关键帧工作流合成一个 GJJ 零依赖预设节点。可接参考视频自动抽关键帧，也可接批量场景图和动态场景图；LoRA 走串联配置。"
    SEARCH_ALIASES = ["LTX2.3全能参考", "AIEverything", "RH可用", "多关键帧", "LTX all reference", "视频参考", "关键帧参考"]
    DEFAULT_PROMPT = "全局描述：保持参考视频/关键帧中的主体身份、服装、环境和镜头连续性，动作自然，光影稳定，电影感，细节真实。"
    DEFAULT_NEGATIVE = "titles, subtitles, text, watermark, logo, blurry text, distorted text, overlay, out of focus, overexposed, underexposed, low contrast, excessive noise, motion blur, camera shake, inconsistent framing, AI artifacts, distorted sound, saturated sound, loud."
    DEFAULT_WIDTH = 1280
    DEFAULT_HEIGHT = 704
    DEFAULT_SEGMENT_SECONDS = 5.0
    DEFAULT_FPS = 24
    DEFAULT_LORA_CHAIN = ALL_REFERENCE_LORAS

    @classmethod
    def INPUT_TYPES(cls):
        spec = super().INPUT_TYPES()
        spec["required"]["reference_keyframe_count"] = (
            "INT",
            {
                "default": 2,
                "min": 1,
                "max": 16,
                "step": 1,
                "display_name": "视频抽帧数量",
                "tooltip": "接入参考视频时，从整段视频均匀抽取多少张关键帧作为 LTX guide。多关键帧版可继续接批量场景图或动态场景图补充。",
            },
        )
        spec["required"]["use_reference_video_audio"] = (
            "BOOLEAN",
            {
                "default": False,
                "display_name": "使用参考视频音频",
                "tooltip": "开启后，如果参考视频自带音频且未单独接入驱动音频，会把参考视频音频作为输入音频使用。",
            },
        )
        spec["optional"]["reference_video"] = (
            "VIDEO",
            {
                "display_name": "参考视频",
                "tooltip": "可选。连接 Load Video 的 VIDEO 输出；节点会内部拆出关键帧，不需要手动先转成图片帧。",
            },
        )
        _set_optional_tooltip(
            spec,
            "batch_scenes",
            "可接批量关键帧/参考图。若同时接参考视频，会排在参考视频抽帧之后，作为补充多关键帧 guide。",
        )
        return spec

    def generate(self, **kwargs):
        reference_video = kwargs.pop("reference_video", None)
        keyframe_count = int(kwargs.pop("reference_keyframe_count", 2))
        use_video_audio = bool(kwargs.pop("use_reference_video_audio", False))
        if reference_video is not None:
            frames, audio, frame_rate = _ensure_video_frames(reference_video)
            keyframes = _sample_video_keyframes(frames, keyframe_count)
            existing_batch = kwargs.get("batch_scenes")
            if isinstance(existing_batch, torch.Tensor):
                if existing_batch.ndim == 3:
                    existing_batch = existing_batch.unsqueeze(0)
                if existing_batch.ndim == 4:
                    kwargs["batch_scenes"] = torch.cat([keyframes, existing_batch], dim=0)
                else:
                    kwargs["batch_scenes"] = keyframes
            elif existing_batch is None:
                kwargs["batch_scenes"] = keyframes
            else:
                kwargs["batch_scenes"] = keyframes
            if use_video_audio and kwargs.get("input_audio") is None and audio is not None:
                kwargs["input_audio"] = audio
            if frame_rate and not kwargs.get("fps"):
                kwargs["fps"] = int(round(frame_rate))
        return super().generate(**kwargs)


class GJJ_LTX23WorkflowFourPanel(_PresetMultiRefBase):
    DESCRIPTION = "把 LTX2.3 四宫格完整工作流程封装成 GJJ 零依赖节点：接入四宫格拆出的 4 张图或一个 IMAGE batch 后，按四段参考生成整段视频。"
    SEARCH_ALIASES = ["LTX2.3四宫格完整工作流程", "四宫格", "四图参考", "storyboard four panel"]
    DEFAULT_PROMPT = "4K 电影质感，写实风格，四段画面按参考图顺序硬切推进，保持角色、环境、光影和镜头语言一致，画面真实自然，细节清晰。"
    DEFAULT_NEGATIVE = "singing, subtitles, blurry, out of focus, overexposed, underexposed, low contrast, excessive noise, grainy texture, poor lighting, flickering, motion blur, distorted proportions, deformed facial features, extra limbs, artifacts, watermark, text, logo, AI artifacts."
    DEFAULT_WIDTH = 960
    DEFAULT_HEIGHT = 544
    DEFAULT_SEGMENT_SECONDS = 3.0
    DEFAULT_FPS = 24
    DEFAULT_LORA_CHAIN = FOUR_PANEL_LORAS

    def __init__(self):
        self._gjj_internal_multiref_node = GJJ_LTX23ImageToVideoMultiRef()

    @classmethod
    def INPUT_TYPES(cls):
        spec = super().INPUT_TYPES()
        _set_optional_tooltip(
            spec,
            "batch_scenes",
            "推荐接入四宫格拆分后的 IMAGE batch。节点会按 batch 顺序作为第 1 到第 4 幅参考图。",
        )
        return spec

    @staticmethod
    def _split_batch_to_four(images: Any) -> torch.Tensor | None:
        if not isinstance(images, torch.Tensor):
            return None
        if images.ndim == 3:
            images = images.unsqueeze(0)
        if images.ndim != 4 or int(images.shape[0]) <= 0:
            return None
        return images[:4].contiguous()

    @staticmethod
    def _collect_socket_four(kwargs: dict[str, Any], remaining: int) -> list[torch.Tensor]:
        if remaining <= 0:
            return []
        items: list[tuple[int, torch.Tensor]] = []
        for key, value in kwargs.items():
            text = str(key or "")
            if text.startswith("scene_image_"):
                try:
                    index = int(text[len("scene_image_"):])
                except Exception:
                    index = 9999
            elif text.startswith("场景"):
                try:
                    index = int(text.replace("场景", "", 1))
                except Exception:
                    index = 9999
            elif text == "main_image":
                index = 0
            elif text.startswith("guide_image_"):
                try:
                    index = int(text[len("guide_image_"):]) + 1
                except Exception:
                    index = 9999
            else:
                continue
            if isinstance(value, torch.Tensor):
                image = value.unsqueeze(0) if value.ndim == 3 else value
                if image.ndim == 4 and int(image.shape[0]) > 0:
                    items.append((index, image[:1].contiguous()))
        return [image for _, image in sorted(items, key=lambda item: item[0])[:remaining]]

    @staticmethod
    def _is_scene_input_key(key: Any) -> bool:
        text = str(key or "")
        return (
            text == "main_image"
            or text.startswith("guide_image_")
            or text.startswith("scene_image_")
            or text.startswith("scene_")
            or text.startswith("场景")
        )

    def generate(self, **kwargs):
        if not str(kwargs.get("lora_chain_config", "") or "").strip() and self.DEFAULT_LORA_CHAIN:
            kwargs["lora_chain_config"] = self.DEFAULT_LORA_CHAIN

        batch = self._split_batch_to_four(kwargs.pop("batch_scenes", kwargs.pop("scene_batch", None)))
        parts: list[torch.Tensor] = []
        if batch is not None:
            parts.append(batch)
        current_count = sum(int(part.shape[0]) for part in parts)
        parts.extend(self._collect_socket_four(kwargs, 4 - current_count))
        if parts:
            kwargs["batch_scenes"] = torch.cat(parts, dim=0)[:4].contiguous()
        for key in list(kwargs.keys()):
            if self._is_scene_input_key(key):
                kwargs.pop(key, None)

        return self._gjj_internal_multiref_node.generate(
            positive_prompt=kwargs.pop("positive_prompt"),
            negative_prompt=kwargs.pop("negative_prompt"),
            segment_seconds=kwargs.pop("segment_seconds"),
            width=kwargs.pop("width"),
            height=kwargs.pop("height"),
            fps=kwargs.pop("fps"),
            seed=kwargs.pop("seed"),
            denoise_strength=kwargs.pop("denoise_strength", DEFAULT_DENOISE_STRENGTH),
            transition_enabled=kwargs.pop("transition_enabled", False),
            transition_curve=kwargs.pop("transition_curve", TRANSITION_CURVES[0]),
            transition_early_tail_ratio=kwargs.pop("transition_early_tail_ratio", DEFAULT_TRANSITION_EARLY_TAIL_RATIO),
            transition_implicit_guide_count=kwargs.pop("transition_implicit_guide_count", DEFAULT_TRANSITION_IMPLICIT_GUIDE_COUNT),
            transition_implicit_guide_strength=kwargs.pop("transition_implicit_guide_strength", DEFAULT_TRANSITION_IMPLICIT_GUIDE_STRENGTH),
            transition_early_tail_strength=kwargs.pop("transition_early_tail_strength", DEFAULT_TRANSITION_EARLY_TAIL_STRENGTH),
            transition_final_guide_strength=kwargs.pop("transition_final_guide_strength", DEFAULT_TRANSITION_FINAL_GUIDE_STRENGTH),
            segmented_execution=kwargs.pop("segmented_execution", False),
            segment_save_preset=kwargs.pop("segment_save_preset", SEGMENT_SAVE_PRESETS[0]),
            segment_video_format=kwargs.pop("segment_video_format", DEFAULT_SEGMENT_VIDEO_FORMAT),
            unique_id=kwargs.pop("unique_id", None),
            **kwargs,
        )


class GJJ_LTX23WorkflowPromptRelayTalkingHead(GJJ_LTX23ImageToVideo):
    DESCRIPTION = "把 LTX2.3+s2v 数字人 Prompt Relay 高动作遵从工作流封装成 GJJ 预设节点；复用 GJJ 本地 PromptRelay 编码器。"
    SEARCH_ALIASES = ["LTX2.3+s2v数字人-Prompt Relay", "Prompt Relay 数字人", "高动作遵从", "s2v talking head"]

    @classmethod
    def INPUT_TYPES(cls):
        spec = copy.deepcopy(super().INPUT_TYPES())
        _set_required_default(spec, "positive_prompt", RELAY_DEFAULT_PROMPT)
        _set_required_default(spec, "negative_prompt", "blurry, oversaturated, pixelated, low resolution, grainy, distorted, noise, compression artifacts, jpeg artifacts, glitches, watermark, text, logo, signature, copyright, subtitles, distorted sound, saturated sound, loud")
        _set_required_default(spec, "width", 1280)
        _set_required_default(spec, "height", 736)
        _set_required_default(spec, "frame_count", 121)
        _set_required_default(spec, "fps", 25)
        _set_required_default(spec, "relay_local_prompts", RELAY_DEFAULT_LOCAL_PROMPTS)
        _set_required_default(spec, "relay_epsilon", 0.001)
        return spec

    def generate(self, **kwargs):
        if not str(kwargs.get("relay_local_prompts", "") or "").strip():
            kwargs["relay_local_prompts"] = RELAY_DEFAULT_LOCAL_PROMPTS
        return super().generate(**kwargs)


NODE_CLASS_MAPPINGS = {
    "GJJ_LTX23WorkflowMultiImageReference": GJJ_LTX23WorkflowMultiImageReference,
    "GJJ_LTX23WorkflowPromptRelayTalkingHead": GJJ_LTX23WorkflowPromptRelayTalkingHead,
    "GJJ_LTX23WorkflowFourPanel": GJJ_LTX23WorkflowFourPanel,
    "GJJ_LTX23WorkflowDigitalHumanMultiRef": GJJ_LTX23WorkflowDigitalHumanMultiRef,
    "GJJ_LTX23WorkflowAllReference": GJJ_LTX23WorkflowAllReference,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_LTX23WorkflowMultiImageReference": "GJJ · 🖼️ LTX多图参考预设",
    "GJJ_LTX23WorkflowPromptRelayTalkingHead": "GJJ · 🗣️ LTX数字人Relay预设",
    "GJJ_LTX23WorkflowFourPanel": "GJJ · 🧱 LTX四宫格预设",
    "GJJ_LTX23WorkflowDigitalHumanMultiRef": "GJJ · 👤 LTX数字人多图预设",
    "GJJ_LTX23WorkflowAllReference": "GJJ · 🎞️ LTX全能参考预设",
}
