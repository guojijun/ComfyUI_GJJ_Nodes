from __future__ import annotations

import re
import time
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

try:
    from .common_utils.model_loader import gjjutils_load_model
except Exception:
    try:
        from nodes.common_utils.model_loader import gjjutils_load_model
    except Exception:
        gjjutils_load_model = None


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
ACE_MODEL_TREE = [
    {
        "label": "AIO 整包模型（可选）",
        "folder": "checkpoints",
        "filename": DEFAULT_CHECKPOINT,
        "description": "ACE 1.5 checkpoint 整包；选择 checkpoints 下的 AIO 时不需要单独选择 CLIP/VAE。",
    },
    {
        "label": "ACE 主模型 / UNET",
        "folder": "diffusion_models",
        "filename": DEFAULT_UNET,
        "description": "ACE 1.5 分体主模型；列表按文件名同时包含 ace + step 过滤，支持 safetensors。",
    },
    {
        "label": "ACE GGUF 主模型",
        "folder": "diffusion_models",
        "filename": "acestep-v15-turbo-Q4_K_M.gguf",
        "description": "低显存 GGUF 主模型；与 safetensors 主模型互斥，同样放在 diffusion_models。",
    },
    {
        "label": "CLIP 1",
        "folder": "text_encoders",
        "filename": DEFAULT_CLIP_1,
        "description": "分体 safetensors / GGUF 主模型需要的 ACE 文本编码器 1。",
    },
    {
        "label": "CLIP 2",
        "folder": "text_encoders",
        "filename": DEFAULT_CLIP_2,
        "description": "分体 safetensors / GGUF 主模型需要的 ACE 文本编码器 2。",
    },
    {
        "label": "VAE",
        "folder": "vae",
        "filename": DEFAULT_VAE,
        "description": "ACE 音频 VAE；分体 safetensors / GGUF 主模型需要。",
    },
]
ACE_MODEL_TREE_TEXT = f"""models/
├─ checkpoints/
│  └─ {DEFAULT_CHECKPOINT}  # 可选 AIO 整包
├─ diffusion_models/
│  ├─ {DEFAULT_UNET}  # safetensors 主模型
│  ├─ acestep_v1.5_xl_turbo_bf16.safetensors  # XL safetensors 主模型
│  └─ acestep-v15-turbo-Q4_K_M.gguf  # GGUF 主模型，和 safetensors 互斥
├─ text_encoders/
│  ├─ {DEFAULT_CLIP_1}
│  └─ {DEFAULT_CLIP_2}
└─ vae/
   └─ {DEFAULT_VAE}"""
UI_PARAMETER_ORDER = (
    "model_name",
    "tags",
    "lyrics",
    "duration",
    "bpm",
    "timesignature",
    "language",
    "keyscale",
    "seed",
    "lyrics_strength",
    "generate_audio_codes",
    "cfg_scale",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "shift",
    "steps",
    "cfg",
    "sampler_name",
    "scheduler",
    "denoise",
    "clip_1_name",
    "clip_2_name",
    "vae_name",
    "model_test_mode",
)
HIDDEN_UI_PARAMETERS = tuple(
    name for name in UI_PARAMETER_ORDER
    if name not in {"tags", "lyrics"}
)
_TIMESTAMP_ASR_CACHE: dict[tuple[str, str, str, str], Any] = {}


def _mark_hidden_ui_parameters(input_data: dict[str, Any]) -> dict[str, Any]:
    hidden_names = set(HIDDEN_UI_PARAMETERS)
    for group_name in ("required", "optional"):
        group = input_data.get(group_name)
        if not isinstance(group, dict):
            continue
        for name, definition in group.items():
            if name not in hidden_names or not isinstance(definition, tuple) or len(definition) < 2:
                continue
            options = definition[1]
            if not isinstance(options, dict):
                continue
            options.setdefault("hidden", True)
            options.setdefault("display", "hidden")
            options.setdefault("advanced", True)
    return input_data


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


def _send_audio_preview(unique_id: Any, audio_ui: dict[str, Any]) -> None:
    if not unique_id or not audio_ui:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_node_audio",
            {"node": str(unique_id), "audio": audio_ui.get("audio", [])},
        )
    except Exception:
        pass


def _safe_output_name(value: Any) -> str:
    name = str(value or "ACE_Model").replace("\\", "/").rsplit("/", 1)[-1].rsplit(".", 1)[0]
    name = re.sub(r"[<>:\"/\\|?*\x00-\x1f]+", "_", name).strip(" ._")
    name = re.sub(r"\s+", "_", name)
    return name or "ACE_Model"


def _save_audio_mp3_ui(audio: dict[str, Any], filename_prefix: str = "audio/GJJ_ACEMusic", quality: str = "320k") -> dict[str, Any]:
    prefix = str(filename_prefix or "").strip() or "audio/GJJ_ACEMusic"
    selected_quality = str(quality or "320k").strip()
    try:
        from comfy_api.latest import UI

        return UI.AudioSaveHelper.get_save_audio_ui(
            audio,
            filename_prefix=prefix,
            cls=None,
            format="mp3",
            quality=selected_quality,
        ).as_dict()
    except Exception as exc:
        raise RuntimeError(f"保存 MP3 失败：{exc}") from exc


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


def _filter_ace_unet_models(names: list[str]) -> list[str]:
    filtered: list[str] = []
    for name in names:
        normalized = _normalize_text(name)
        if "ace" in normalized and "step" in normalized:
            filtered.append(name)
    return filtered


def _filter_ace_clip_models(names: list[str]) -> list[str]:
    filtered: list[str] = []
    for name in names:
        normalized = _normalize_text(name)
        if "ace" in normalized or "qwen" in normalized:
            filtered.append(name)
    return filtered or names


def _filter_ace_vae_models(names: list[str]) -> list[str]:
    filtered: list[str] = []
    for name in names:
        normalized = _normalize_text(name)
        if "ace" in normalized or "vae" in normalized:
            filtered.append(name)
    return filtered or names


def _list_visible_models() -> list[str]:
    checkpoints = _filter_ace_models(_safe_filename_list("checkpoints"), allow_checkpoint=True)
    diffusion_models = _filter_ace_unet_models(_safe_filename_list("diffusion_models"))
    ordered: list[str] = []
    seen: set[str] = set()
    for name in checkpoints + diffusion_models:
        if name not in seen:
            ordered.append(name)
            seen.add(name)
    if not ordered:
        ordered = [DEFAULT_CHECKPOINT, DEFAULT_UNET]
    return ordered


def _list_visible_clip_models() -> list[str]:
    ordered = _filter_ace_clip_models(_safe_filename_list("text_encoders"))
    if not ordered:
        ordered = [DEFAULT_CLIP_1, DEFAULT_CLIP_2]
    return ordered


def _list_visible_vae_models() -> list[str]:
    ordered = _filter_ace_vae_models(_safe_filename_list("vae"))
    if not ordered:
        ordered = [DEFAULT_VAE]
    return ordered


def _resolve_model_bundle(model_name: str) -> tuple[str, str]:
    checkpoints = _filter_ace_models(_safe_filename_list("checkpoints"), allow_checkpoint=True)
    diffusion_models = _filter_ace_unet_models(_safe_filename_list("diffusion_models"))

    model_name = str(model_name or "").strip()
    if model_name in checkpoints:
        return "checkpoint", model_name
    if model_name in diffusion_models:
        if model_name.replace("\\", "/").lower().endswith(".gguf"):
            return "gguf", model_name
        return "split", model_name

    checkpoint_match = _pick_available_name(model_name, checkpoints, DEFAULT_CHECKPOINT)
    if checkpoint_match:
        return "checkpoint", checkpoint_match

    diffusion_match = _pick_available_name(model_name, diffusion_models, DEFAULT_UNET)
    if diffusion_match:
        if diffusion_match.replace("\\", "/").lower().endswith(".gguf"):
            return "gguf", diffusion_match
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


def _load_ace_unet(unet_name: str):
    if str(unet_name or "").replace("\\", "/").lower().endswith(".gguf"):
        if gjjutils_load_model is None:
            raise RuntimeError("当前环境缺少 GJJ GGUF UNET 加载器，无法加载 GGUF 主模型。")
        return gjjutils_load_model(unet_name, "default")
    if gjjutils_load_model is not None:
        return gjjutils_load_model(unet_name, "fp8_e4m3fn_fast")
    return UNETLoader().load_unet(unet_name, "fp8_e4m3fn_fast")[0]


def _load_split_bundle(unet_name: str, clip_1_name: str = DEFAULT_CLIP_1, clip_2_name: str = DEFAULT_CLIP_2, vae_name: str = DEFAULT_VAE):
    resolved_unet = _require_category_name("diffusion_models", unet_name, "分体 UNET", DEFAULT_UNET)
    resolved_clip_1 = _require_category_name("text_encoders", clip_1_name, "文本编码器 1", DEFAULT_CLIP_1)
    resolved_clip_2 = _require_category_name("text_encoders", clip_2_name, "文本编码器 2", DEFAULT_CLIP_2)
    resolved_vae = _require_category_name("vae", vae_name, "VAE", DEFAULT_VAE)

    model = _load_ace_unet(resolved_unet)
    clip = DualCLIPLoader().load_clip(resolved_clip_1, resolved_clip_2, "ace", "default")[0]
    vae = VAELoader().load_vae(resolved_vae)[0]
    return model, clip, vae


def _load_gguf_bundle(unet_name: str, clip_1_name: str = DEFAULT_CLIP_1, clip_2_name: str = DEFAULT_CLIP_2, vae_name: str = DEFAULT_VAE):
    resolved_unet = _require_category_name("diffusion_models", unet_name, "GGUF 主模型", unet_name)
    resolved_clip_1 = _require_category_name("text_encoders", clip_1_name, "文本编码器 1", DEFAULT_CLIP_1)
    resolved_clip_2 = _require_category_name("text_encoders", clip_2_name, "文本编码器 2", DEFAULT_CLIP_2)
    resolved_vae = _require_category_name("vae", vae_name, "VAE", DEFAULT_VAE)

    model = _load_ace_unet(resolved_unet)
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


def _clean_lyric_line(line: str) -> str:
    text = str(line or "").strip()
    if re.fullmatch(r"\[[^\]]+\]", text):
        return ""
    return text


def _lyrics_to_srt_lines(lyrics: str) -> list[str]:
    lines: list[str] = []
    for raw_line in str(lyrics or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = _clean_lyric_line(raw_line)
        if line:
            lines.append(line)
    return lines


def _alignment_key(text: str) -> str:
    return re.sub(
        r"[\s\[\]（）(){}<>《》“”\"'.,，。!?！？;；:：、…~\-—_]+",
        "",
        str(text or "").lower(),
    )


def _srt_time(seconds: float) -> str:
    total_ms = max(0, int(round(float(seconds or 0.0) * 1000.0)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _format_srt(entries: list[tuple[float, float, str]]) -> str:
    blocks: list[str] = []
    for index, (start, end, text) in enumerate(entries, 1):
        blocks.append(f"{index}\n{_srt_time(start)} --> {_srt_time(end)}\n{text}")
    return "\n\n".join(blocks)


def _estimated_line_duration(text: str) -> float:
    char_count = max(1, len(_alignment_key(text)))
    return min(8.0, max(1.6, char_count * 0.22))


def _extract_first_time_from_text(text: str) -> float | None:
    values: list[float] = []
    for match in re.finditer(r"<\|(\d+(?:\.\d+)?)\|>|\[(\d+(?:\.\d+)?)\]", str(text or "")):
        try:
            value = float(match.group(1) or match.group(2))
        except (TypeError, ValueError):
            continue
        if value > 0.2:
            values.append(value)
    return min(values) if values else None


def _extract_first_time(value: Any, depth: int = 0) -> float | None:
    if depth > 5 or value is None:
        return None
    if isinstance(value, str):
        return _extract_first_time_from_text(value)
    if isinstance(value, dict):
        direct_values: list[float] = []
        for key in ("start", "start_time", "begin", "begin_time", "from", "timestamp"):
            if key not in value:
                continue
            try:
                start = float(value[key])
            except (TypeError, ValueError):
                continue
            if start > 0.2:
                direct_values.append(start)
        if direct_values:
            return min(direct_values)
        nested = [_extract_first_time(item, depth + 1) for item in value.values()]
        nested = [item for item in nested if item is not None]
        return min(nested) if nested else None
    if isinstance(value, (list, tuple)):
        nested = [_extract_first_time(item, depth + 1) for item in value]
        nested = [item for item in nested if item is not None]
        return min(nested) if nested else None

    direct_values = []
    for attr in ("start", "start_time", "begin", "begin_time"):
        if not hasattr(value, attr):
            continue
        try:
            start = float(getattr(value, attr))
        except (TypeError, ValueError):
            continue
        if start > 0.2:
            direct_values.append(start)
    if direct_values:
        return min(direct_values)

    nested_values = []
    for attr in ("items", "segments", "chunks", "timestamps", "time_stamps", "words", "text"):
        if hasattr(value, attr):
            nested = _extract_first_time(getattr(value, attr), depth + 1)
            if nested is not None:
                nested_values.append(nested)
    return min(nested_values) if nested_values else None


def _repair_srt_entries(entries: list[tuple[float, float, str]], vocal_start: float | None) -> list[tuple[float, float, str]]:
    if not entries:
        return entries

    repaired: list[tuple[float, float, str]] = []
    current = 0.0
    if vocal_start is not None and vocal_start > 0.5 and float(entries[0][0]) <= 0.5:
        current = float(vocal_start)

    for start, end, text in entries:
        start = max(0.0, float(start or 0.0))
        end = max(start, float(end or start))
        duration = end - start
        estimate = _estimated_line_duration(text)
        broken = (
            duration < 0.6
            or duration > max(12.0, estimate * 2.8)
            or (vocal_start is not None and vocal_start > 0.5 and start <= 0.5)
            or start < current - 0.2
        )

        if broken:
            start = max(current, float(vocal_start or 0.0))
            duration = estimate
            end = start + duration
        elif start < current:
            shift = current - start
            start += shift
            end += shift

        repaired.append((start, end, text))
        current = end + 0.12
    return repaired


def _load_timestamp_asr_model(asr_dir: str, aligner_dir: str, dtype_name: str, device_map: str, unique_id: Any = None):
    cache_key = (asr_dir, aligner_dir, dtype_name, device_map)
    if cache_key in _TIMESTAMP_ASR_CACHE:
        return _TIMESTAMP_ASR_CACHE[cache_key]

    try:
        from .gjj_qwen3_asr_text_formats import _dtype_from_name, _load_qwen_runtime
    except Exception:
        from gjj_qwen3_asr_text_formats import _dtype_from_name, _load_qwen_runtime

    Qwen3ASRModel, _ = _load_qwen_runtime(unique_id)
    dtype = _dtype_from_name(dtype_name)
    model = Qwen3ASRModel.from_pretrained(
        asr_dir,
        forced_aligner=aligner_dir,
        forced_aligner_kwargs={"dtype": dtype, "device_map": device_map},
        dtype=dtype,
        device_map=device_map,
        max_inference_batch_size=8,
        max_new_tokens=512,
    )
    _TIMESTAMP_ASR_CACHE[cache_key] = model
    return model


def _detect_first_vocal_start(
    waveform: Any,
    sample_rate: int,
    dtype_name: str,
    device_map: str,
    aligner_dir: str,
    unique_id: Any = None,
) -> tuple[float | None, Any | None]:
    try:
        from .gjj_qwen3_asr_text_formats import _find_local_model_dir
    except Exception:
        from gjj_qwen3_asr_text_formats import _find_local_model_dir

    for asr_model_name in ("Qwen3-ASR-1.7B", "Qwen3-ASR-0.6B"):
        asr_dir = _find_local_model_dir(asr_model_name, "asr")
        if not asr_dir:
            continue
        try:
            asr_model = _load_timestamp_asr_model(asr_dir, aligner_dir, dtype_name, device_map, unique_id)
            transcriptions = asr_model.transcribe(
                audio=(waveform, sample_rate),
                context="",
                language=None,
                return_time_stamps=True,
            )
            first_time = _extract_first_time(transcriptions)
            if first_time is not None:
                return first_time, getattr(asr_model, "forced_aligner", None)
        except Exception:
            continue
    return None, None


def _align_items_to_lyric_lines(items: list[Any], lines: list[str]) -> list[tuple[float, float, str]]:
    entries: list[tuple[float, float, str]] = []
    item_index = 0
    item_count = len(items)

    for line in lines:
        target_key = _alignment_key(line)
        if not target_key:
            continue

        matched = ""
        start_time = None
        end_time = None
        while item_index < item_count and len(_alignment_key(matched)) < len(target_key):
            item = items[item_index]
            item_text = str(getattr(item, "text", "") or "")
            if item_text:
                if start_time is None:
                    start_time = float(getattr(item, "start_time", 0.0) or 0.0)
                end_time = float(getattr(item, "end_time", start_time or 0.0) or 0.0)
                matched += item_text
            item_index += 1

        if start_time is not None and end_time is not None:
            if end_time <= start_time:
                end_time = start_time + 0.1
            entries.append((start_time, end_time, line))

    return entries


def _ace_language_to_qwen(language: str) -> str:
    mapping = {
        "zh": "Chinese",
        "cn": "Chinese",
        "en": "English",
        "ja": "Japanese",
        "jp": "Japanese",
        "ko": "Korean",
        "kr": "Korean",
        "es": "Spanish",
        "de": "German",
        "fr": "French",
        "pt": "Portuguese",
        "ru": "Russian",
        "it": "Italian",
        "ar": "Arabic",
        "tr": "Turkish",
        "vi": "Vietnamese",
        "id": "Indonesian",
    }
    return mapping.get(str(language or "").strip().lower(), "Chinese")


def _align_lyrics_to_srt(audio: dict[str, Any], lyrics: str, language: str, unique_id: Any = None) -> str:
    lines = _lyrics_to_srt_lines(lyrics)
    if not lines:
        return ""

    try:
        from .gjj_qwen3_asr_text_formats import (
            _audio_to_numpy,
            _load_aligner_model,
            _resolve_device_map,
            _resolve_dtype_name,
            _resolve_model_dir,
        )
    except Exception:
        from gjj_qwen3_asr_text_formats import (
            _audio_to_numpy,
            _load_aligner_model,
            _resolve_device_map,
            _resolve_dtype_name,
            _resolve_model_dir,
        )

    waveform, sample_rate = _audio_to_numpy(audio)
    dtype_name = _resolve_dtype_name("自动")
    device_map = _resolve_device_map()
    aligner_dir = _resolve_model_dir("Qwen3-ForcedAligner-0.6B", "aligner", unique_id)
    vocal_start, timestamp_aligner = _detect_first_vocal_start(
        waveform,
        sample_rate,
        dtype_name,
        device_map,
        aligner_dir,
        unique_id,
    )
    aligner = timestamp_aligner or _load_aligner_model(aligner_dir, dtype_name, device_map, unique_id)
    align_results = aligner.align(
        audio=(waveform, sample_rate),
        text="\n".join(lines),
        language=_ace_language_to_qwen(language),
    )
    if not align_results:
        raise RuntimeError("强制对齐没有返回时间戳结果。")

    entries = _align_items_to_lyric_lines(list(align_results[0]), lines)
    if not entries:
        raise RuntimeError("强制对齐没有匹配到可用的歌词时间戳。")
    entries = _repair_srt_entries(entries, vocal_start)
    return _format_srt(entries)


class GJJ_AudioAceMusicGenerator:
    CATEGORY = "GJJ/音频"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = "将 Audio ACE 1.5 两套工作流合并成单节点：优先使用整包 checkpoint，缺失时自动回退到 split 模型组，直接生成音乐音频。"
    SEARCH_ALIASES = ["ace 音乐", "music", "audio ace", "作曲", "音乐", "歌曲生成", "音频生成"]
    RETURN_TYPES = ("AUDIO", "STRING")
    RETURN_NAMES = ("音乐音频输出", "原歌词SRT")
    OUTPUT_TOOLTIPS = ("生成的音乐音频。", "使用 Qwen3-ForcedAligner 对齐原始歌词生成的 SRT 字幕文本。")
    GJJ_HELP = {
        "title": "GJJ · 🎵 ACE音乐生成器",
        "description": DESCRIPTION,
        "notice": (
            "模型选择规则：checkpoints 下的 AIO 整包自带 CLIP/VAE；"
            "diffusion_models 下的 safetensors 或 GGUF 主模型需要配套 text_encoders 与 vae。"
            "GGUF 主模型也放在 diffusion_models，与 safetensors 主模型互斥。"
        ),
        "model_tree": ACE_MODEL_TREE,
        "model_tree_text": ACE_MODEL_TREE_TEXT,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "models": [
            {
                "label": item["label"],
                "subdir": f"models/{item['folder']}",
                "filename": item["filename"],
                "description": item["description"],
            }
            for item in ACE_MODEL_TREE
        ],
    }
    GJJ_UI = {
        "toolbar": ["🔄", "🎲", "🌐", "🪄", "⚡", "🧠", "⚙️", "▶️", "🧪"],
        "parameter_order": list(UI_PARAMETER_ORDER),
        "hidden_parameters": list(HIDDEN_UI_PARAMETERS),
    }

    @classmethod
    def INPUT_TYPES(cls):
        models = _list_visible_models()
        clip_models = _list_visible_clip_models()
        vae_models = _list_visible_vae_models()
        return _mark_hidden_ui_parameters({
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
                        "multiline": False,
                        "dynamicPrompts": True,
                        "forceInput": False,
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
                        "forceInput": False,
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
                "clip_1_name": (
                    clip_models,
                    {
                        "default": _pick_available_name(DEFAULT_CLIP_1, clip_models, DEFAULT_CLIP_1),
                        "display_name": "CLIP 1",
                        "tooltip": "ACE 文本编码器 1，默认 qwen_0.6b_ace15。",
                    },
                ),
                "clip_2_name": (
                    clip_models,
                    {
                        "default": _pick_available_name(DEFAULT_CLIP_2, clip_models, DEFAULT_CLIP_2),
                        "display_name": "CLIP 2",
                        "tooltip": "ACE 文本编码器 2，默认 qwen_1.7b_ace15。",
                    },
                ),
                "vae_name": (
                    vae_models,
                    {
                        "default": _pick_available_name(DEFAULT_VAE, vae_models, DEFAULT_VAE),
                        "display_name": "VAE",
                        "tooltip": "ACE 音频 VAE。",
                    },
                ),
                "model_test_mode": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "模型测试模式",
                        "tooltip": "由 🧪 模型测试按钮自动控制；开启时输出文件名使用模型名和耗时。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        })

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
        clip_1_name=DEFAULT_CLIP_1,
        clip_2_name=DEFAULT_CLIP_2,
        vae_name=DEFAULT_VAE,
        model_test_mode=False,
        unique_id=None,
    ):
        started_at = time.perf_counter()
        _send_status(unique_id, "1/7 加载 ACE 音乐模型...")
        try:
            mode, resolved_name = _resolve_model_bundle(model_name)
            if mode == "checkpoint":
                model, clip, vae = CheckpointLoaderSimple().load_checkpoint(resolved_name)
            elif mode == "gguf":
                model, clip, vae = _load_gguf_bundle(resolved_name, clip_1_name, clip_2_name, vae_name)
            else:
                model, clip, vae = _load_split_bundle(resolved_name, clip_1_name, clip_2_name, vae_name)
            model = _apply_aura_shift(model, float(shift))
        except Exception as exc:
            raise RuntimeError(
                "ACE 音乐生成器加载模型失败。\n"
                f"主模型：{model_name}\n"
                f"详细错误：{exc}"
            ) from exc

        target_duration = float(duration)
        generation_duration = min(2000.0, target_duration + DEFAULT_TAIL_PADDING_SECONDS)
        source_lyrics = str(lyrics or "")
        tags, lyrics = _ensure_smooth_ending_prompt(tags, source_lyrics)

        _send_status(unique_id, "2/7 编码音乐提示词与歌词...")
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

        _send_status(unique_id, "3/7 构建音频 latent...")
        try:
            latent = _build_empty_ace15_latent(generation_duration, 1)
        except Exception as exc:
            raise RuntimeError(f"ACE 音乐生成器构建音频 latent 失败。\n详细错误：{exc}") from exc

        _send_status(unique_id, "4/7 采样生成音乐 latent...")
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

        _send_status(unique_id, "5/7 解码音频...")
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
        _send_status(unique_id, f"6/7 保存音乐：{summary}")

        elapsed_seconds = max(0.0, time.perf_counter() - started_at)
        if bool(model_test_mode):
            prefix = f"audio/{_safe_output_name(resolved_name)}+{elapsed_seconds:.1f}s"
        else:
            prefix = "audio/GJJ_ACEMusic"
        audio_ui = _save_audio_mp3_ui(audio, prefix, "320k")
        _send_audio_preview(unique_id, audio_ui)

        srt_text = ""
        if _lyrics_to_srt_lines(source_lyrics):
            _send_status(unique_id, "7/7 对齐原歌词 SRT...")
            try:
                srt_text = _align_lyrics_to_srt(audio, source_lyrics, str(language), unique_id)
                _send_status(unique_id, f"完成：已输出 {len(_lyrics_to_srt_lines(source_lyrics))} 行原歌词 SRT。")
            except Exception as exc:
                srt_text = f"SRT 对齐失败：{exc}"
                _send_status(unique_id, "完成：音乐已生成，SRT 对齐失败。")
        else:
            _send_status(unique_id, "完成：音乐已生成；没有歌词，SRT 留空。")

        return {"ui": audio_ui, "result": (audio, srt_text)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AudioAceMusicGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎵 ACE音乐生成器"}
