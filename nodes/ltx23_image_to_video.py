from __future__ import annotations

import re
from fractions import Fraction
from typing import Any

import comfy.sd
import comfy.utils
import folder_paths
import torch
from comfy_api.latest import InputImpl, Types
from comfy_extras.nodes_custom_sampler import CFGGuider, KSamplerSelect, ManualSigmas, RandomNoise, SamplerCustomAdvanced
from comfy_extras.nodes_lt import (
    EmptyLTXVLatentVideo,
    LTXVConcatAVLatent,
    LTXVConditioning,
    LTXVCropGuides,
    LTXVImgToVideoInplace,
    LTXVPreprocess,
    LTXVSeparateAVLatent,
)
from comfy_extras.nodes_lt_audio import LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAEEncode, LTXVAudioVAELoader, LTXVEmptyLatentAudio
from comfy_extras.nodes_lt_upsampler import LTXVLatentUpsampler
from comfy_extras.nodes_video import CreateVideo
from comfy_extras.nodes_hunyuan import LatentUpscaleModelLoader
from nodes import CheckpointLoaderSimple, CLIPTextEncode, LoraLoaderModelOnly, VAEDecodeTiled

from .ltx23_multiref_runtime import _apply_ltx_nag
from .model_name_resolver import pick_available_model_name
from .multi_lora_chain import apply_lora_chain_config, normalize_lora_chain_data
from .prompt_relay_encoder import GJJ_PromptRelayEncoder


NODE_NAME = "GJJ_LTX23ImageToVideo"
DEFAULT_CKPT = "ltx-2.3-22b"
DEFAULT_LORA_1 = "LTX/ltx-2.3-22b-distilled-lora-384-1.1.safetensors"
DEFAULT_LORA_2 = "ltx23_gydboy.safetensors"
DEFAULT_TEXT_ENCODER = "gemma_3_12B_it_fp4_mixed.safetensors"
DEFAULT_LATENT_UPSCALER = "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
DEFAULT_PROMPT = "动感十足"
DEFAULT_NEGATIVE = "pc game, console game, video game, cartoon, childish, ugly"
DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 720
DEFAULT_DURATION_SECONDS = 5
DEFAULT_FPS = 25
DEFAULT_FRAME_COUNT = DEFAULT_DURATION_SECONDS * DEFAULT_FPS + 1
DEFAULT_SEED = 483811081311996
DEFAULT_DISTILLED_LORA_STRENGTH = 0.5
DEFAULT_GYDBOY_LORA_STRENGTH = 1.0
DEFAULT_LOWRES_INJECT_STRENGTH = 0.7
DEFAULT_HIGHRES_INJECT_STRENGTH = 1.0
DEFAULT_PREPROCESS_LONG_EDGE = 1536
DEFAULT_PREPROCESS_COMPRESSION = 35
DEFAULT_STAGE1_SAMPLER = "euler_ancestral_cfg_pp"
DEFAULT_STAGE2_SAMPLER = "euler_cfg_pp"
DEFAULT_STAGE1_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
DEFAULT_STAGE2_SIGMAS = "0.85, 0.7250, 0.4219, 0.0"
DEFAULT_CFG = 1.0
DEFAULT_AUDIO_TARGET_DB = -18.0
DEFAULT_NAG_SCALE = 11.0
DEFAULT_NAG_ALPHA = 0.25
DEFAULT_NAG_TAU = 2.5
DEFAULT_RELAY_EPSILON = 0.001
TIMESTAMP_LINE_RE = re.compile(
    r"^\s*[\[\(<]?\s*([0-9]+(?:\.[0-9]+)?)\s*s?\s*[-–—~至到]\s*([0-9]+(?:\.[0-9]+)?)\s*s?\s*[\]\)>]?\s*(.*)$",
    re.IGNORECASE,
)


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


def _lookup_tokens(text: str) -> list[str]:
    return [
        _normalize_text(part)
        for part in str(text or "").replace("\\", "/").replace("_", " ").replace("-", " ").replace(".", " ").split()
        if _normalize_text(part)
    ]


def _safe_filename_list(category: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(category))
    except Exception:
        return []


def _pick_available_name(preferred: str, available: list[str], fallback: str = "") -> str:
    return pick_available_model_name(preferred, available, fallback, allow_first=False)


def _require_model_name(category: str, preferred: str, label: str, fallback: str = "") -> str:
    available = _safe_filename_list(category)
    resolved = _pick_available_name(preferred, available, fallback)
    if not resolved:
        raise RuntimeError(f"未找到{label}：{preferred or fallback}")
    full_path = folder_paths.get_full_path(category, resolved)
    if not full_path:
        raise RuntimeError(f"未找到{label}：{resolved}")
    return resolved


def _require_lora_name(preferred: str, label: str, fallback: str = "") -> str:
    available = _safe_filename_list("loras")
    resolved = pick_available_model_name(preferred, available, fallback, allow_first=False)
    if not resolved or not folder_paths.get_full_path("loras", resolved):
        raise RuntimeError(f"未找到{label}：{preferred or fallback}。已按源工作流文件名与本机文件名的最长共同片段模糊搜索。")
    return resolved


def _resolve_optional_name(category: str, preferred: str, fallback: str = "") -> str:
    available = _safe_filename_list(category)
    chosen = _pick_available_name(preferred, available, fallback)
    return chosen or ""


def _ceil_to_multiple(value: float, step: int = 32, minimum: int = 64) -> int:
    numeric = max(1.0, float(value or 0))
    rounded = int(-(-int(numeric) // int(step)) * int(step))
    return max(int(minimum), rounded)


def _is_empty_loader_placeholder(image: Any) -> bool:
    if not isinstance(image, torch.Tensor):
        return False
    if image.ndim != 4:
        return False
    if int(image.shape[0]) != 1 or int(image.shape[1]) != 64 or int(image.shape[2]) != 64:
        return False
    try:
        return float(image.detach().abs().amax().item()) <= 1e-7
    except Exception:
        return False


def _has_valid_image(image: Any) -> bool:
    return (
        isinstance(image, torch.Tensor)
        and getattr(image, "shape", None) is not None
        and image.ndim == 4
        and int(image.shape[0]) > 0
        and not _is_empty_loader_placeholder(image)
    )


def _resolve_size_from_first_image(input_image: torch.Tensor | None, width: int, height: int, auto_size: bool) -> tuple[int, int, int, int]:
    if not auto_size or not _has_valid_image(input_image):
        resolved_width = _ceil_to_multiple(width)
        resolved_height = _ceil_to_multiple(height)
        return resolved_width, resolved_height, 0, 0
    source_height = int(input_image.shape[1])
    source_width = int(input_image.shape[2])
    if source_width <= 0 or source_height <= 0:
        resolved_width = _ceil_to_multiple(width)
        resolved_height = _ceil_to_multiple(height)
        return resolved_width, resolved_height, 0, 0
    return _ceil_to_multiple(source_width), _ceil_to_multiple(source_height), source_width, source_height


def _has_valid_audio(audio: Any) -> bool:
    return isinstance(audio, dict) and audio.get("waveform") is not None and int(audio.get("sample_rate", 0) or 0) > 0


def _audio_waveform_and_rate(audio: dict[str, Any]) -> tuple[torch.Tensor, int]:
    if not _has_valid_audio(audio):
        raise RuntimeError("输入音频格式无效，缺少 waveform 或 sample_rate。")
    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    if not isinstance(waveform, torch.Tensor):
        waveform = torch.as_tensor(waveform, dtype=torch.float32)
    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0).unsqueeze(0)
    elif waveform.ndim == 2:
        waveform = waveform.unsqueeze(0)
    elif waveform.ndim != 3:
        raise RuntimeError(f"无法识别的音频张量维度：{tuple(waveform.shape)}")
    return waveform.contiguous(), sample_rate


def _audio_duration_seconds(audio: dict[str, Any]) -> float:
    waveform, sample_rate = _audio_waveform_and_rate(audio)
    return float(waveform.shape[-1]) / float(sample_rate)


def _normalize_audio_rms(audio: dict[str, Any], target_db: float = DEFAULT_AUDIO_TARGET_DB) -> dict[str, Any]:
    waveform, sample_rate = _audio_waveform_and_rate(audio)
    waveform = waveform.float()
    rms = waveform.pow(2).mean(dim=-1, keepdim=True).sqrt().clamp(min=1e-8)
    current_db = 20.0 * torch.log10(rms)
    gain = torch.pow(torch.tensor(10.0, dtype=waveform.dtype, device=waveform.device), (float(target_db) - current_db) / 20.0)
    normalized = waveform * gain
    peak = normalized.abs().amax(dim=-1, keepdim=True).clamp(min=1.0)
    normalized = (normalized / peak).contiguous()
    result = dict(audio)
    result["waveform"] = normalized
    result["sample_rate"] = sample_rate
    return result


def _set_audio_latent_noise_mask(audio_latent: dict[str, Any], value: float = 0.0) -> dict[str, Any]:
    samples = audio_latent["samples"]
    mask = torch.full(
        (int(samples.shape[0]), 1, int(samples.shape[-2]), int(samples.shape[-1])),
        float(value),
        dtype=samples.dtype,
        device=samples.device,
    )
    updated = dict(audio_latent)
    updated["noise_mask"] = mask
    return updated


def _prepare_relay_prompts(local_prompts: str, segment_lengths: str, fps: int) -> tuple[str, str, bool]:
    text = str(local_prompts or "").strip()
    if not text:
        return "", str(segment_lengths or "").strip(), False
    if "|" in text:
        return text, str(segment_lengths or "").strip(), True

    lines = [line.strip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if line.strip()]
    if len(lines) <= 1:
        return text, str(segment_lengths or "").strip(), True

    cleaned: list[str] = []
    derived_lengths: list[str] = []
    all_timestamped = True
    for line in lines:
        match = TIMESTAMP_LINE_RE.match(line)
        if not match:
            all_timestamped = False
            cleaned.append(line)
            continue
        start = float(match.group(1))
        end = float(match.group(2))
        body = str(match.group(3) or "").strip()
        cleaned.append(body or line)
        derived_lengths.append(str(max(1, int(round(max(0.0, end - start) * float(max(1, int(fps))))))))
    resolved_lengths = str(segment_lengths or "").strip()
    if not resolved_lengths and all_timestamped and len(derived_lengths) == len(cleaned):
        resolved_lengths = ",".join(derived_lengths)
    return " | ".join(cleaned), resolved_lengths, True


def _resize_center_crop(images: torch.Tensor, width: int, height: int) -> torch.Tensor:
    if images is None or images.shape[0] == 0:
        raise RuntimeError("未提供有效的输入图像。")
    return comfy.utils.common_upscale(images.movedim(-1, 1), int(width), int(height), "lanczos", "center").movedim(1, -1)


def _resize_to_longer_edge(images: torch.Tensor, longer_edge: int) -> torch.Tensor:
    resized = []
    for image in images:
        h = int(image.shape[0])
        w = int(image.shape[1])
        if h <= 0 or w <= 0:
            continue
        if w >= h:
            target_w = int(longer_edge)
            target_h = max(1, round(h * (target_w / w)))
        else:
            target_h = int(longer_edge)
            target_w = max(1, round(w * (target_h / h)))
        scaled = comfy.utils.common_upscale(
            image.unsqueeze(0).movedim(-1, 1),
            target_w,
            target_h,
            "lanczos",
            "disabled",
        ).movedim(1, -1)
        resized.append(scaled)
    if not resized:
        raise RuntimeError("输入图像缩放失败。")
    return torch.cat(resized, dim=0)
class GJJ_LTX23ImageToVideo:
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    DESCRIPTION = "将 LTX-2.3 图生/文生视频工作流封装成零外部依赖单节点：接入图像时走图生视频；接入音频时切换到数字人音频驱动流程，时长按音频自动对齐。"
    SEARCH_ALIASES = ["ltx", "ltx2.3", "ltx i2v", "ltx t2v", "图生视频", "文生视频", "ltx 图生视频", "ltx 文生视频", "ltx 视频", "ltx 数字人", "talking head"]
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频生成结果",)
    OUTPUT_TOOLTIPS = ("按工作流默认参数生成的 LTX 图生/文生/数字人视频结果；接入音频时音频会参与采样并自动决定帧数。",)

    def __init__(self):
        self.loaded_lora: tuple[str, Any] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = _safe_filename_list("checkpoints") or [DEFAULT_CKPT]
        filtered_ckpts = [name for name in checkpoints if "ltx" in _normalize_text(name)] or checkpoints
        all_loras = _safe_filename_list("loras")
        filtered_loras = [name for name in all_loras if "ltx" in _normalize_text(name)] or all_loras
        lora_choices = ["[不使用]"] + filtered_loras if filtered_loras else ["[不使用]"]
        default_lora_1 = pick_available_model_name(DEFAULT_LORA_1, filtered_loras, allow_first=False) or "[不使用]"
        default_lora_2 = pick_available_model_name(DEFAULT_LORA_2, filtered_loras, allow_first=False) or "[不使用]"
        return {
            "required": {
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_PROMPT,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "用于描述视频内容、动作和镜头变化。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "反向提示词",
                        "tooltip": "默认值来自工作流当前启用的负向提示词。",
                    },
                ),
                "ckpt_name": (
                    filtered_ckpts,
                    {
                        "default": DEFAULT_CKPT if DEFAULT_CKPT in filtered_ckpts else filtered_ckpts[0],
                        "display_name": "主模型",
                        "tooltip": "LTX-2.3 的主 checkpoint；节点内部会自动配对文本编码器、蒸馏 LoRA、音频 VAE 和 latent 放大模型。",
                    },
                ),
                "lora_name_1": (
                    lora_choices,
                    {
                        "default": default_lora_1,
                        "display_name": "第1组 LoRA",
                        "tooltip": "第 1 条串联 LoRA。默认使用官方 4 步蒸馏 LoRA。",
                    },
                ),
                "lora_strength_1": (
                    "FLOAT",
                    {
                        "default": DEFAULT_DISTILLED_LORA_STRENGTH,
                        "min": 0.0,
                        "max": 4.0,
                        "step": 0.05,
                        "display_name": "LoRA 1 强度",
                        "tooltip": "第 1 条 LoRA 的生效强度；设为 0 则等同于关闭。",
                    },
                ),
                "lora_name_2": (
                    lora_choices,
                    {
                        "default": default_lora_2,
                        "display_name": "第2组 LoRA",
                        "tooltip": "第 2 条串联 LoRA。默认补充 ltx23_gydboy.safetensors。",
                    },
                ),
                "lora_strength_2": (
                    "FLOAT",
                    {
                        "default": DEFAULT_GYDBOY_LORA_STRENGTH,
                        "min": 0.0,
                        "max": 4.0,
                        "step": 0.05,
                        "display_name": "LoRA 2 强度",
                        "tooltip": "第 2 条 LoRA 的生效强度；设为 0 则等同于关闭。",
                    },
                ),
                "width": ("INT", {"default": DEFAULT_WIDTH, "min": 64, "max": 8192, "step": 32, "display_name": "宽度", "tooltip": "最终视频帧宽度。"}),
                "height": ("INT", {"default": DEFAULT_HEIGHT, "min": 64, "max": 8192, "step": 32, "display_name": "高度", "tooltip": "最终视频帧高度。"}),
                "frame_count": ("INT", {"default": DEFAULT_FRAME_COUNT, "min": 1, "max": 4096, "step": 1, "display_name": "帧数", "tooltip": "视频总帧数；可直接按需要的动画长度手动控制。"}),
                "fps": ("INT", {"default": DEFAULT_FPS, "min": 1, "max": 120, "step": 1, "display_name": "帧率", "tooltip": "输出视频的帧率。"}),
                "seed": (
                    "INT",
                    {
                        "default": DEFAULT_SEED,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "随机种子；改变后会得到不同的视频内容。",
                    },
                ),
                "auto_use_first_image_size": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "自动匹配首图尺寸",
                        "tooltip": "开启后，有输入图像时会把宽高自动更新为第一张图的尺寸并向上对齐到 32 的倍数；关闭后使用手动宽高。",
                    },
                ),
                "relay_local_prompts": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "时序提示词",
                        "tooltip": "音频数字人模式可选。支持 PromptRelay 的 | 分段，也支持 Qwen3 识别输出的 [0.4s-2.9s] 文本逐行时间戳表；留空则使用普通正向提示词。",
                    },
                ),
                "relay_segment_lengths": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "时序分段帧数",
                        "tooltip": "PromptRelay 分段帧数，英文逗号分隔。留空时，如果时序提示词是 [开始s-结束s] 格式，会按当前 fps 自动换算。",
                    },
                ),
                "relay_epsilon": (
                    "FLOAT",
                    {
                        "default": DEFAULT_RELAY_EPSILON,
                        "min": 0.000001,
                        "max": 0.99,
                        "step": 0.0001,
                        "display_name": "时序边界锐度",
                        "tooltip": "PromptRelay 的边界锐度，0.001 较锐利；数值越大过渡越软。",
                    },
                ),
            },
            "optional": {
                "input_image": ("IMAGE", {"display_name": "输入图像", "tooltip": "可选。接入图像时走图生视频；接入音频时必须提供，用第一张图作为数字人首帧并自动匹配尺寸。"}),
                "input_audio": ("AUDIO", {"display_name": "输入音频", "tooltip": "可选。接入后切换到数字人音频驱动流程，音频会编码进 LTX latent 并自动决定总帧数。"}),
                "relay_prompt_input": ("STRING", {"forceInput": True, "display_name": "时序提示词输入", "tooltip": "可选。连接 Qwen3 识别时间戳表或其它文本后，会覆盖面板里的时序提示词。"}),
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "display_name": "LoRA串联配置",
                        "tooltip": "可选。接入 GJJ · LoRA串联配置 的输出后，会在面板 LoRA 1 / LoRA 2 之后继续按顺序串联应用多组 LoRA。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        positive_prompt,
        negative_prompt,
        ckpt_name,
        lora_name_1,
        lora_strength_1,
        lora_name_2,
        lora_strength_2,
        width,
        height,
        frame_count,
        fps,
        seed,
        auto_use_first_image_size=True,
        relay_local_prompts="",
        relay_segment_lengths="",
        relay_epsilon=DEFAULT_RELAY_EPSILON,
        input_image=None,
        input_audio=None,
        relay_prompt_input="",
        lora_chain_config="",
        unique_id=None,
    ):
        if _is_empty_loader_placeholder(input_image):
            raise RuntimeError("输入图像接到了 64x64 空占位图。请连接 GJJ · 批量多图片加载预览器里已经选中的图片输出，或改接批量图片队列。")
        has_input_image = _has_valid_image(input_image)
        has_input_audio = _has_valid_audio(input_audio)
        if has_input_audio and not has_input_image:
            raise RuntimeError("LTX 数字人音频驱动模式需要连接输入图像，用第一张图作为人物首帧。")
        width, height, source_width, source_height = _resolve_size_from_first_image(
            input_image,
            int(width),
            int(height),
            bool(auto_use_first_image_size),
        )
        mode_text = "数字人音频驱动" if has_input_audio else ("图生视频" if has_input_image else "文生视频")
        fps = max(1, int(fps))

        _send_status(unique_id, "1/10 检查并加载 LTX 模型...")
        try:
            resolved_ckpt = _require_model_name("checkpoints", ckpt_name, "主模型", DEFAULT_CKPT)
            resolved_text_encoder = _require_model_name("text_encoders", DEFAULT_TEXT_ENCODER, "文本编码器", DEFAULT_TEXT_ENCODER)
            resolved_upscaler = _require_model_name("latent_upscale_models", DEFAULT_LATENT_UPSCALER, "latent 放大模型", DEFAULT_LATENT_UPSCALER)
            resolved_lora_1 = ""
            resolved_lora_2 = ""
            if str(lora_name_1 or "") != "[不使用]" and float(lora_strength_1) > 0:
                resolved_lora_1 = _require_lora_name(lora_name_1, "LoRA 1", DEFAULT_LORA_1)
            if str(lora_name_2 or "") != "[不使用]" and float(lora_strength_2) > 0:
                resolved_lora_2 = _require_lora_name(lora_name_2, "LoRA 2", DEFAULT_LORA_2)

            model, _, vae = CheckpointLoaderSimple().load_checkpoint(resolved_ckpt)
            if resolved_lora_1:
                model = LoraLoaderModelOnly().load_lora_model_only(model, resolved_lora_1, float(lora_strength_1))[0]
            if resolved_lora_2:
                model = LoraLoaderModelOnly().load_lora_model_only(model, resolved_lora_2, float(lora_strength_2))[0]
            audio_vae = LTXVAudioVAELoader.execute(resolved_ckpt)[0]
            clip = LTXAVTextEncoderLoader.execute(resolved_text_encoder, resolved_ckpt, "default")[0]
            if str(lora_chain_config or "").strip():
                model, clip, self.loaded_lora = apply_lora_chain_config(
                    model,
                    clip,
                    lora_data=normalize_lora_chain_data(lora_chain_config),
                    loaded_lora_cache=self.loaded_lora,
                )
            latent_upscaler = LatentUpscaleModelLoader.execute(resolved_upscaler)[0]
        except Exception as exc:
            raise RuntimeError(
                "LTX 图文生视频节点加载模型失败。\n"
                f"主模型：{ckpt_name}\n"
                f"LoRA 1：{lora_name_1}\n"
                f"LoRA 2：{lora_name_2}\n"
                f"LoRA 串联配置：{'已接入' if str(lora_chain_config or '').strip() else '未接入'}\n"
                f"详细错误：{exc}"
            ) from exc

        source_image = None
        if has_input_image:
            image_mode_text = "数字人首帧" if has_input_audio else "图生模式"
            _send_status(unique_id, f"2/10 处理输入图像（{image_mode_text}）...")
            try:
                source_image = input_image[:1]
                source_image = _resize_center_crop(source_image, int(width), int(height))
                source_image = _resize_to_longer_edge(source_image, DEFAULT_PREPROCESS_LONG_EDGE)
                source_image = LTXVPreprocess.execute(source_image, DEFAULT_PREPROCESS_COMPRESSION)[0]
            except Exception as exc:
                raise RuntimeError(f"LTX 图文生视频节点预处理输入图像失败。\n详细错误：{exc}") from exc
        else:
            _send_status(unique_id, "2/10 未检测到输入图像，切换到文生视频模式...")

        driving_audio = None
        audio_duration = 0.0
        if has_input_audio:
            _send_status(unique_id, "3/10 准备数字人驱动音频并对齐时长...")
            try:
                driving_audio = _normalize_audio_rms(input_audio, DEFAULT_AUDIO_TARGET_DB)
                audio_duration = _audio_duration_seconds(driving_audio)
                frame_count = max(1, int(round(audio_duration * float(fps))) + 1)
            except Exception as exc:
                raise RuntimeError(f"LTX 数字人音频驱动处理失败。\n详细错误：{exc}") from exc
        else:
            frame_count = max(1, int(frame_count))

        lowres_width = max(64, int(width) // 2)
        lowres_height = max(64, int(height) // 2)

        _send_status(unique_id, "4/10 构建低清 latent 与音频 latent...")
        try:
            empty_video_latent = EmptyLTXVLatentVideo.execute(lowres_width, lowres_height, frame_count, 1)[0]
            if has_input_image:
                lowres_video_latent = LTXVImgToVideoInplace.execute(
                    vae,
                    source_image,
                    empty_video_latent,
                    DEFAULT_LOWRES_INJECT_STRENGTH,
                    False,
                )[0]
            else:
                lowres_video_latent = empty_video_latent
            if has_input_audio:
                audio_latent = LTXVAudioVAEEncode.execute(driving_audio, audio_vae)[0]
                audio_latent = _set_audio_latent_noise_mask(audio_latent, 0.0)
            else:
                audio_latent = LTXVEmptyLatentAudio.execute(frame_count, int(fps), 1, audio_vae)[0]
        except Exception as exc:
            raise RuntimeError(f"LTX 图文生视频节点构建初始 latent 失败。\n详细错误：{exc}") from exc

        _send_status(unique_id, "5/10 编码提示词与数字人动作约束...")
        try:
            positive_text = str(positive_prompt or "").strip() or DEFAULT_PROMPT
            negative_text = str(negative_prompt or "").strip() or DEFAULT_NEGATIVE
            negative_base = CLIPTextEncode().encode(clip, negative_text)[0]
            relay_source = str(relay_prompt_input or "").strip() or str(relay_local_prompts or "").strip()
            relay_prompts, relay_lengths, use_relay = _prepare_relay_prompts(relay_source, str(relay_segment_lengths or ""), int(fps))
            if has_input_audio and use_relay:
                model, positive = GJJ_PromptRelayEncoder().encode(
                    model,
                    clip,
                    lowres_video_latent,
                    positive_text,
                    relay_prompts,
                    relay_lengths,
                    float(relay_epsilon),
                )
                _send_status(unique_id, "提示：已启用 PromptRelay 时序提示词；为避免注意力补丁冲突，本次优先保留时序控制。")
            else:
                positive = CLIPTextEncode().encode(clip, positive_text)[0]
                if has_input_audio:
                    model = _apply_ltx_nag(model, negative_base, DEFAULT_NAG_SCALE, DEFAULT_NAG_ALPHA, DEFAULT_NAG_TAU, inplace=True)
            positive, negative = LTXVConditioning.execute(positive, negative_base, float(fps))[0:2]
            positive, negative, cropped_video_latent = LTXVCropGuides.execute(positive, negative, lowres_video_latent)[0:3]
            av_latent_stage1 = LTXVConcatAVLatent.execute(cropped_video_latent, audio_latent)[0]
        except Exception as exc:
            raise RuntimeError(f"LTX 图文生视频节点提示词/数字人约束编码失败。\n详细错误：{exc}") from exc

        _send_status(unique_id, "6/10 第一阶段低清采样...")
        try:
            guider_stage1 = CFGGuider.execute(model, positive, negative, DEFAULT_CFG)[0]
            sampler_stage1 = KSamplerSelect.execute(DEFAULT_STAGE1_SAMPLER)[0]
            sigmas_stage1 = ManualSigmas.execute(DEFAULT_STAGE1_SIGMAS)[0]
            noise_stage1 = RandomNoise.execute(int(seed))[0]
            av_latent_stage1_result = SamplerCustomAdvanced.execute(
                noise_stage1,
                guider_stage1,
                sampler_stage1,
                sigmas_stage1,
                av_latent_stage1,
            )[0]
            video_latent_stage1, audio_latent_stage1 = LTXVSeparateAVLatent.execute(av_latent_stage1_result)[0:2]
        except Exception as exc:
            raise RuntimeError(f"LTX 图文生视频节点第一阶段采样失败。\n详细错误：{exc}") from exc

        _send_status(unique_id, "7/10 latent 放大并构建高清阶段...")
        try:
            upscaled_video_latent = LTXVLatentUpsampler().upsample_latent(video_latent_stage1, latent_upscaler, vae)[0]
            if has_input_image:
                highres_video_latent = LTXVImgToVideoInplace.execute(
                    vae,
                    source_image,
                    upscaled_video_latent,
                    DEFAULT_HIGHRES_INJECT_STRENGTH,
                    False,
                )[0]
            else:
                highres_video_latent = upscaled_video_latent
            av_latent_stage2 = LTXVConcatAVLatent.execute(highres_video_latent, audio_latent_stage1)[0]
        except Exception as exc:
            raise RuntimeError(f"LTX 图文生视频节点 latent 放大失败。\n详细错误：{exc}") from exc

        _send_status(unique_id, "8/10 第二阶段高清采样...")
        try:
            guider_stage2 = CFGGuider.execute(model, positive, negative, DEFAULT_CFG)[0]
            sampler_stage2 = KSamplerSelect.execute(DEFAULT_STAGE2_SAMPLER)[0]
            sigmas_stage2 = ManualSigmas.execute(DEFAULT_STAGE2_SIGMAS)[0]
            noise_stage2 = RandomNoise.execute(42)[0]
            av_latent_stage2_result = SamplerCustomAdvanced.execute(
                noise_stage2,
                guider_stage2,
                sampler_stage2,
                sigmas_stage2,
                av_latent_stage2,
            )[0]
            video_latent_stage2, audio_latent_stage2 = LTXVSeparateAVLatent.execute(av_latent_stage2_result)[0:2]
        except Exception as exc:
            raise RuntimeError(f"LTX 图文生视频节点第二阶段采样失败。\n详细错误：{exc}") from exc

        _send_status(unique_id, "9/10 解码视频帧与音频...")
        try:
            frames = VAEDecodeTiled().decode(vae, video_latent_stage2, 768, 64, 4096, 4)[0]
            generated_audio = LTXVAudioVAEDecode.execute(audio_latent_stage2, audio_vae)[0]
        except Exception as exc:
            raise RuntimeError(f"LTX 图文生视频节点解码失败。\n详细错误：{exc}") from exc

        chosen_audio = generated_audio

        _send_status(unique_id, "10/10 创建视频并合成音轨...")
        try:
            video = CreateVideo.execute(frames, float(fps), chosen_audio)[0]
        except Exception:
            video = InputImpl.VideoFromComponents(
                Types.VideoComponents(images=frames, audio=chosen_audio, frame_rate=Fraction(int(fps), 1))
            )

        audio_text = "音频驱动音轨" if has_input_audio else "模型音轨"
        audio_suffix = f" / 音频 {audio_duration:.2f} 秒" if has_input_audio else ""
        _send_status(unique_id, f"完成：{mode_text} / {int(width)} × {int(height)} / {frame_count} 帧 / {audio_text}{audio_suffix}")
        return {
            "ui": {
                "resolved_width": [int(width)],
                "resolved_height": [int(height)],
                "resolved_frame_count": [int(frame_count)],
                "source_width": [int(source_width)],
                "source_height": [int(source_height)],
                "source_image_count": [1 if has_input_image else 0],
                "audio_duration": [float(audio_duration)],
            },
            "result": (video,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTX23ImageToVideo}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 LTX图文生视频器"}
