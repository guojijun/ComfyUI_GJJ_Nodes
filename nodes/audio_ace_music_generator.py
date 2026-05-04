from __future__ import annotations

from typing import Any

import comfy.model_management
import comfy.model_sampling
import comfy.samplers
import comfy.sd
import comfy.utils
import folder_paths
import torch
from comfy_extras.nodes_audio import vae_decode_audio
from nodes import (
    CheckpointLoaderSimple,
    ConditioningZeroOut,
    DualCLIPLoader,
    UNETLoader,
    VAELoader,
    common_ksampler,
)


NODE_NAME = "GJJ_AudioAceMusicGenerator"

DEFAULT_MODEL_KEYWORD = "ace_step_1.5_turbo_aio"
DEFAULT_CHECKPOINT = "ace_step_1.5_turbo_aio.safetensors"
DEFAULT_UNET = "acestep_v1.5_turbo.safetensors"
DEFAULT_CLIP_1 = "qwen_0.6b_ace15.safetensors"
DEFAULT_CLIP_2 = "qwen_1.7b_ace15.safetensors"
DEFAULT_VAE = "ace_1.5_vae.safetensors"

DEFAULT_TAGS = "流行音乐，女声独唱，旋律抓耳，高音质，编曲完整。"
DEFAULT_LYRICS = ""
DEFAULT_DURATION = 120.0
DEFAULT_BPM = 120
DEFAULT_TIMESIGNATURE = "4"
DEFAULT_LANGUAGE = "zh"
DEFAULT_KEYSCALE = "C major"
DEFAULT_SHIFT = 3.0
DEFAULT_STEPS = 8
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "simple"
DEFAULT_DENOISE = 1.0
DEFAULT_TAIL_PADDING_SECONDS = 3.0
DEFAULT_FADE_OUT_SECONDS = 1.5


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": str(text or "")},
        )
    except Exception:
        pass


def _normalize_text(text: str) -> str:
    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _conditioning_set_values(conditioning, values: dict[str, Any]):
    updated = []
    for item in conditioning:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            updated.append(item)
            continue
        new_item = list(item)
        metadata = dict(new_item[1] or {})
        metadata.update(values)
        new_item[1] = metadata
        updated.append(new_item)
    return updated


def _safe_filename_list(category: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(category))
    except Exception:
        return []


def _pick_available_name(preferred: str, available: list[str], fallback: str = "") -> str:
    preferred = str(preferred or "").strip()
    fallback = str(fallback or "").strip()
    if preferred and preferred in available:
        return preferred

    preferred_base = preferred.replace("\\", "/").split("/")[-1] if preferred else ""
    if preferred_base:
        for name in available:
            if name.replace("\\", "/").split("/")[-1].lower() == preferred_base.lower():
                return name

    normalized = _normalize_text(preferred)
    if normalized:
        for name in available:
            if normalized in _normalize_text(name):
                return name

    if fallback:
        return _pick_available_name(fallback, available, "")
    return available[0] if available else ""


def _filter_ace_models(names: list[str], *, allow_checkpoint: bool) -> list[str]:
    filtered: list[str] = []
    for name in names:
        normalized = _normalize_text(name)
        if "xl" in normalized:
            continue
        if "ace" not in normalized:
            continue
        if "15" not in normalized and "step15" not in normalized and "step1" not in normalized:
            continue
        if allow_checkpoint:
            if "aio" in normalized or "checkpoint" in normalized or "turbo" in normalized:
                filtered.append(name)
        else:
            if "acestep" in normalized or "unet" in normalized or "turbo" in normalized:
                filtered.append(name)
    return filtered


def _list_visible_models() -> list[str]:
    checkpoints = _filter_ace_models(_safe_filename_list("checkpoints"), allow_checkpoint=True)
    diffusion_models = _filter_ace_models(_safe_filename_list("diffusion_models"), allow_checkpoint=False)
    ordered: list[str] = []
    seen: set[str] = set()
    for name in checkpoints + diffusion_models:
        if name not in seen:
            ordered.append(name)
            seen.add(name)
    if not ordered:
        ordered = [DEFAULT_CHECKPOINT, DEFAULT_UNET]
    return ordered


def _resolve_model_bundle(model_name: str) -> tuple[str, str]:
    checkpoints = _filter_ace_models(_safe_filename_list("checkpoints"), allow_checkpoint=True)
    diffusion_models = _filter_ace_models(_safe_filename_list("diffusion_models"), allow_checkpoint=False)

    model_name = str(model_name or "").strip()
    if model_name in checkpoints:
        return "checkpoint", model_name
    if model_name in diffusion_models:
        return "split", model_name

    checkpoint_match = _pick_available_name(model_name, checkpoints, DEFAULT_CHECKPOINT)
    if checkpoint_match:
        return "checkpoint", checkpoint_match

    diffusion_match = _pick_available_name(model_name, diffusion_models, DEFAULT_UNET)
    if diffusion_match:
        return "split", diffusion_match

    raise RuntimeError("未找到可用的 ACE 1.5 音乐模型。")


def _require_category_name(category: str, preferred: str, label: str, fallback: str = "") -> str:
    available = _safe_filename_list(category)
    resolved = _pick_available_name(preferred, available, fallback)
    if not resolved:
        raise RuntimeError(f"未找到{label}：{preferred or fallback}")
    full_path = folder_paths.get_full_path(category, resolved)
    if not full_path:
        raise RuntimeError(f"未找到{label}：{resolved}")
    return resolved


def _load_split_bundle(unet_name: str):
    resolved_unet = _require_category_name("diffusion_models", unet_name, "分体 UNET", DEFAULT_UNET)
    resolved_clip_1 = _require_category_name("text_encoders", DEFAULT_CLIP_1, "文本编码器 1", DEFAULT_CLIP_1)
    resolved_clip_2 = _require_category_name("text_encoders", DEFAULT_CLIP_2, "文本编码器 2", DEFAULT_CLIP_2)
    resolved_vae = _require_category_name("vae", DEFAULT_VAE, "VAE", DEFAULT_VAE)

    model = UNETLoader().load_unet(resolved_unet, "fp8_e4m3fn_fast")[0]
    clip = DualCLIPLoader().load_clip(resolved_clip_1, resolved_clip_2, "ace", "default")[0]
    vae = VAELoader().load_vae(resolved_vae)[0]
    return model, clip, vae


def _apply_aura_shift(model, shift: float):
    patched = model.clone()

    class ModelSamplingAdvanced(comfy.model_sampling.ModelSamplingDiscreteFlow, comfy.model_sampling.CONST):
        pass

    model_sampling = ModelSamplingAdvanced(patched.model.model_config)
    model_sampling.set_parameters(shift=float(shift), multiplier=1.0)
    patched.add_object_patch("model_sampling", model_sampling)
    return patched


def _encode_ace15_text(
    clip,
    tags: str,
    lyrics: str,
    seed: int,
    bpm: int,
    duration: float,
    timesignature: str,
    language: str,
    keyscale: str,
    generate_audio_codes: bool,
    cfg_scale: float,
    temperature: float,
    top_p: float,
    top_k: int,
    min_p: float,
):
    tokens = clip.tokenize(
        str(tags or ""),
        lyrics=str(lyrics or ""),
        bpm=int(bpm),
        duration=float(duration),
        timesignature=int(timesignature),
        language=str(language or DEFAULT_LANGUAGE),
        keyscale=str(keyscale or DEFAULT_KEYSCALE),
        seed=int(seed),
        generate_audio_codes=bool(generate_audio_codes),
        cfg_scale=float(cfg_scale),
        temperature=float(temperature),
        top_p=float(top_p),
        top_k=int(top_k),
        min_p=float(min_p),
    )
    return clip.encode_from_tokens_scheduled(tokens)


def _build_empty_ace15_latent(seconds: float, batch_size: int = 1):
    length = round((float(seconds) * 48000 / 1920))
    latent = torch.zeros([int(batch_size), 64, length], device=comfy.model_management.intermediate_device())
    return {"samples": latent, "type": "audio"}


def _fit_audio_duration(audio: dict[str, Any], target_seconds: float) -> dict[str, Any]:
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate", 48000) or 48000)
    if waveform is None:
        return audio

    target_samples = max(1, int(round(float(target_seconds) * sample_rate)))
    current_samples = int(waveform.shape[-1])
    if current_samples == target_samples:
        return audio

    if current_samples > target_samples:
        waveform = waveform[..., :target_samples]
    else:
        pad_shape = list(waveform.shape)
        pad_shape[-1] = target_samples - current_samples
        padding = torch.zeros(pad_shape, dtype=waveform.dtype, device=waveform.device)
        waveform = torch.cat([waveform, padding], dim=-1)

    return {
        **audio,
        "waveform": waveform,
        "sample_rate": sample_rate,
    }


def _ensure_smooth_ending_prompt(tags: str, lyrics: str) -> tuple[str, str]:
    tags_text = str(tags or "").strip()
    lyrics_text = str(lyrics or "").strip()
    tags_norm = tags_text.lower()
    lyrics_norm = lyrics_text.lower()

    has_end_hint = any(
        hint in tags_norm or hint in lyrics_norm
        for hint in ["fade out", "[fade out]", "ending", "outro", "结尾", "淡出", "尾奏"]
    )
    if has_end_hint:
        return tags_text, lyrics_text

    if lyrics_text:
        lyrics_text = f"{lyrics_text}\n\n[Fade Out]"
    else:
        suffix = "fade-out ending, resolved cadence, complete musical ending"
        tags_text = f"{tags_text}, {suffix}" if tags_text else suffix
    return tags_text, lyrics_text


def _apply_fade_out(audio: dict[str, Any], fade_seconds: float) -> dict[str, Any]:
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate", 48000) or 48000)
    if waveform is None:
        return audio

    fade_samples = int(round(float(fade_seconds) * sample_rate))
    total_samples = int(waveform.shape[-1])
    if fade_samples <= 0 or total_samples <= 1:
        return audio

    fade_samples = min(fade_samples, total_samples)
    fade = torch.linspace(1.0, 0.0, fade_samples, device=waveform.device, dtype=waveform.dtype)
    waveform = waveform.clone()
    waveform[..., -fade_samples:] *= fade
    return {
        **audio,
        "waveform": waveform,
        "sample_rate": sample_rate,
    }


class GJJ_AudioAceMusicGenerator:
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    DESCRIPTION = "将 Audio ACE 1.5 两套工作流合并成单节点：优先使用整包 checkpoint，缺失时自动回退到 split 模型组，直接生成音乐音频。"
    SEARCH_ALIASES = ["ace 音乐", "music", "audio ace", "作曲", "音乐", "歌曲生成", "音频生成"]
    RETURN_TYPES = ("AUDIO", "STRING")
    RETURN_NAMES = ("音乐音频输出", "音乐结果摘要")
    OUTPUT_TOOLTIPS = ("生成的音乐音频。", "当前生成任务的简要信息。")

    @classmethod
    def INPUT_TYPES(cls):
        models = _list_visible_models()
        return {
            "required": {
                "model_name": (
                    models,
                    {
                        "default": DEFAULT_CHECKPOINT if DEFAULT_CHECKPOINT in models else models[0],
                        "display_name": "主模型",
                        "tooltip": "优先加载整包 checkpoint；如果选的是分体 UNET，则自动配对内置 text encoder 与 VAE。",
                    },
                ),
                "tags": (
                    "STRING",
                    {
                        "default": DEFAULT_TAGS,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "音乐标签",
                        "tooltip": "描述曲风、编曲、情绪、声线和音质要求。",
                    },
                ),
                "lyrics": (
                    "STRING",
                    {
                        "default": DEFAULT_LYRICS,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "歌词",
                        "tooltip": "歌词内容；纯音乐可留空。",
                    },
                ),
                "duration": (
                    "FLOAT",
                    {
                        "default": DEFAULT_DURATION,
                        "min": 1.0,
                        "max": 2000.0,
                        "step": 0.1,
                        "display_name": "时长秒数",
                        "tooltip": "最终音乐时长，单位为秒。",
                    },
                ),
                "bpm": (
                    "INT",
                    {
                        "default": DEFAULT_BPM,
                        "min": 10,
                        "max": 300,
                        "display_name": "节拍速度（BPM）",
                        "tooltip": "控制音乐的整体速度与节奏快慢。",
                    },
                ),
                "timesignature": (
                    ["2", "3", "4", "6"],
                    {
                        "default": DEFAULT_TIMESIGNATURE,
                        "display_name": "拍号",
                        "tooltip": "控制每小节的拍数结构，例如 4 表示 4/4 拍。",
                    },
                ),
                "language": (
                    ["en", "ja", "zh", "es", "de", "fr", "pt", "ru", "it", "nl", "pl", "tr", "vi", "cs", "fa", "id", "ko", "uk", "hu", "ar", "sv", "ro", "el"],
                    {
                        "default": DEFAULT_LANGUAGE,
                        "display_name": "语言",
                        "tooltip": "歌词或演唱内容的主要语言。",
                    },
                ),
                "keyscale": (
                    [f"{root} {quality}" for quality in ["major", "minor"] for root in ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"]],
                    {
                        "default": DEFAULT_KEYSCALE,
                        "display_name": "调式",
                        "tooltip": "控制音乐的主调和大小调倾向。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 31,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "随机种子；改变后可得到不同编曲结果。",
                    },
                ),
            },
            "optional": {
                "lyrics_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.01,
                        "display_name": "歌词强度",
                        "tooltip": "仅在底层模型使用歌词强度时生效；ACE 1.5 主流程默认无需单独调大。",
                    },
                ),
                "generate_audio_codes": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "生成音频代码",
                        "tooltip": "开启后音质更好，但耗时更长。",
                    },
                ),
                "cfg_scale": (
                    "FLOAT",
                    {
                        "default": 2.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display_name": "文本引导（CFG）",
                        "tooltip": "文本编码阶段的引导强度，越高越贴近标签与歌词。",
                    },
                ),
                "temperature": (
                    "FLOAT",
                    {
                        "default": 0.85,
                        "min": 0.0,
                        "max": 2.0,
                        "step": 0.01,
                        "display_name": "温度",
                        "tooltip": "控制采样随机性；越高越发散，越低越稳定。",
                    },
                ),
                "top_p": (
                    "FLOAT",
                    {
                        "default": 0.9,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "累计概率（Top P）",
                        "tooltip": "限制采样候选的累计概率范围。",
                    },
                ),
                "top_k": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 100,
                        "display_name": "候选数量（Top K）",
                        "tooltip": "限制每一步可参与采样的候选数量；0 表示不限制。",
                    },
                ),
                "min_p": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.001,
                        "display_name": "最小 P",
                        "tooltip": "过滤概率过低的候选项，帮助减少随机噪声。",
                    },
                ),
                "shift": (
                    "FLOAT",
                    {
                        "default": DEFAULT_SHIFT,
                        "min": 0.0,
                        "max": 20.0,
                        "step": 0.1,
                        "display_name": "模型位移（Shift）",
                        "tooltip": "控制底层采样分布的位移参数，通常按工作流默认值使用。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": DEFAULT_STEPS,
                        "min": 1,
                        "max": 200,
                        "display_name": "步数",
                        "tooltip": "主采样步数；增加步数通常会提升细节但更耗时。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": DEFAULT_CFG,
                        "min": 0.0,
                        "max": 20.0,
                        "step": 0.1,
                        "display_name": "采样引导（CFG）",
                        "tooltip": "主采样阶段的提示词引导强度。",
                    },
                ),
                "sampler_name": (
                    comfy.samplers.KSampler.SAMPLERS,
                    {
                        "default": DEFAULT_SAMPLER,
                        "display_name": "采样器",
                        "tooltip": "主采样阶段使用的采样算法。",
                    },
                ),
                "scheduler": (
                    comfy.samplers.KSampler.SCHEDULERS,
                    {
                        "default": DEFAULT_SCHEDULER,
                        "display_name": "调度器",
                        "tooltip": "主采样阶段使用的噪声调度器。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": DEFAULT_DENOISE,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪",
                        "tooltip": "主采样阶段的降噪强度。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        model_name,
        tags,
        lyrics,
        duration,
        bpm,
        timesignature,
        language,
        keyscale,
        seed,
        lyrics_strength=1.0,
        generate_audio_codes=True,
        cfg_scale=2.0,
        temperature=0.85,
        top_p=0.9,
        top_k=0,
        min_p=0.0,
        shift=DEFAULT_SHIFT,
        steps=DEFAULT_STEPS,
        cfg=DEFAULT_CFG,
        sampler_name=DEFAULT_SAMPLER,
        scheduler=DEFAULT_SCHEDULER,
        denoise=DEFAULT_DENOISE,
        unique_id=None,
    ):
        _send_status(unique_id, "1/6 加载 ACE 音乐模型...")
        try:
            mode, resolved_name = _resolve_model_bundle(model_name)
            if mode == "checkpoint":
                model, clip, vae = CheckpointLoaderSimple().load_checkpoint(resolved_name)
            else:
                model, clip, vae = _load_split_bundle(resolved_name)
            model = _apply_aura_shift(model, float(shift))
        except Exception as exc:
            raise RuntimeError(
                "ACE 音乐生成器加载模型失败。\n"
                f"主模型：{model_name}\n"
                f"详细错误：{exc}"
            ) from exc

        target_duration = float(duration)
        generation_duration = min(2000.0, target_duration + DEFAULT_TAIL_PADDING_SECONDS)
        tags, lyrics = _ensure_smooth_ending_prompt(tags, lyrics)

        _send_status(unique_id, "2/6 编码音乐提示词与歌词...")
        try:
            positive = _encode_ace15_text(
                clip,
                tags,
                lyrics,
                int(seed),
                int(bpm),
                generation_duration,
                str(timesignature),
                str(language),
                str(keyscale),
                bool(generate_audio_codes),
                float(cfg_scale),
                float(temperature),
                float(top_p),
                int(top_k),
                float(min_p),
            )
            positive = _conditioning_set_values(positive, {"lyrics_strength": float(lyrics_strength)})
            negative = ConditioningZeroOut().zero_out(positive)[0]
        except Exception as exc:
            raise RuntimeError(f"ACE 音乐生成器编码提示词失败。\n详细错误：{exc}") from exc

        _send_status(unique_id, "3/6 构建音频 latent...")
        try:
            latent = _build_empty_ace15_latent(generation_duration, 1)
        except Exception as exc:
            raise RuntimeError(f"ACE 音乐生成器构建音频 latent 失败。\n详细错误：{exc}") from exc

        _send_status(unique_id, "4/6 采样生成音乐 latent...")
        try:
            samples = common_ksampler(
                model,
                int(seed),
                int(steps),
                float(cfg),
                str(sampler_name),
                str(scheduler),
                positive,
                negative,
                latent,
                denoise=float(denoise),
            )[0]
        except Exception as exc:
            raise RuntimeError(f"ACE 音乐生成器采样失败。\n详细错误：{exc}") from exc

        _send_status(unique_id, "5/6 解码音频...")
        try:
            audio = vae_decode_audio(vae, samples)
            audio = _fit_audio_duration(audio, target_duration)
            audio = _apply_fade_out(audio, min(DEFAULT_FADE_OUT_SECONDS, target_duration * 0.2))
        except Exception as exc:
            raise RuntimeError(f"ACE 音乐生成器解码音频失败。\n详细错误：{exc}") from exc

        actual_duration = float(audio["waveform"].shape[-1]) / float(audio["sample_rate"])
        summary = (
            f"{'整包checkpoint' if mode == 'checkpoint' else '分体模型'} / "
            f"目标 {target_duration:.1f}s / 输出 {actual_duration:.1f}s / "
            f"{int(bpm)} BPM / {str(language)}"
        )
        _send_status(unique_id, f"6/6 完成：{summary}")
        return (audio, summary)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AudioAceMusicGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎵 ACE音乐生成器"}
