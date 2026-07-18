from __future__ import annotations

import re
import inspect
import gc
from typing import Any

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    from .gjj_ollama_common import (
        DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE,
        DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT,
        DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT_TEMPLATES,
        ollama_assistant_output_rule,
        ollama_assistant_system_prompt,
        ollama_assistant_system_prompt_templates,
    )
except Exception:
    from gjj_ollama_common import (
        DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE,
        DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT,
        DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT_TEMPLATES,
        ollama_assistant_output_rule,
        ollama_assistant_system_prompt,
        ollama_assistant_system_prompt_templates,
    )

try:
    from .common_utils.dependency_checker import (
        DEFAULT_MODEL_URL,
        build_dependency_model_report,
        build_node_help_payload,
        make_missing_model_spec,
        print_dependency_model_report,
        raise_dependency_model_error,
        send_dependency_model_notice,
    )
except Exception:
    from common_utils.dependency_checker import (
        DEFAULT_MODEL_URL,
        build_dependency_model_report,
        build_node_help_payload,
        make_missing_model_spec,
        print_dependency_model_report,
        raise_dependency_model_error,
        send_dependency_model_notice,
    )


NODE_NAME = "GJJ_GemmaTextGenerate"
NODE_DISPLAY_NAME = "GJJ · 🧠 图像反推文本生成（Gemma）"
NODE_DESCRIPTION = "把官方“加载CLIP + TextGenerate”合并成一个 GJJ 零第三方依赖节点；适合 Ideogram4 / Gemma 文本生成、提示词扩写和多模态文本生成。"
DEFAULT_CLIP_NAME = "qwen3.5_4b_fp8_mixed.safetensors"
MODEL_DOWNLOAD_URL = DEFAULT_MODEL_URL
NO_THINK_OUTPUT_RULE = (
    "严格输出规则：不要输出思考过程、推理过程、分析过程、草稿、步骤说明、内心独白、"
    "<think> 标签或 thinking 内容。不要解释你如何理解任务，不要复述用户要求，不要写“我需要/首先/接下来”。"
    "如果必须组织答案，只输出最终正文。"
)


class AnyMediaType(str):
    def __ne__(self, _other: object) -> bool:
        return False


MEDIA_INPUT_TYPE = AnyMediaType("GJJ_BATCH_IMAGE,IMAGE,VIDEO,*")

CLIP_TYPES = [
    "ideogram4",
    "stable_diffusion",
    "stable_cascade",
    "sd3",
    "stable_audio",
    "mochi",
    "ltxv",
    "pixart",
    "cosmos",
    "lumina2",
    "wan",
    "hidream",
    "chroma",
    "ace",
    "omnigen2",
    "qwen_image",
    "hunyuan_image",
    "flux2",
    "ovis",
    "longcat_image",
    "cogvideox",
    "lens",
    "pixeldit",
]

GEMMA_TEXT_ENCODER_MODELS = [
    {
        "label": "推荐 Qwen3.5 4B FP8 mixed",
        "path": "models/text_encoders/qwen3.5_4b_fp8_mixed.safetensors",
        "required": True,
        "description": "默认加载的 Qwen3.5 / Gemma 兼容文本生成模型；推荐作为默认。",
    },
    {
        "label": "兼容 Gemma 3 12B FP8 scaled",
        "path": "models/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors",
        "required": False,
        "description": "兼容变体；本地只有该文件时也可以手动选择。",
    },
    {
        "label": "兼容 Gemma 3 12B 原始精度",
        "path": "models/text_encoders/gemma_3_12B_it.safetensors",
        "required": False,
        "description": "显存占用更高的兼容变体。",
    },
    {
        "label": "兼容 Gemma 3 12B FP4 mixed",
        "path": "models/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors",
        "required": False,
        "description": "低显存兼容变体，质量与速度取决于本地 ComfyUI 支持情况。",
    },
]


def _filename_list(category: str) -> list[str]:
    if folder_paths is None:
        return []
    try:
        return [str(item) for item in (folder_paths.get_filename_list(category) or []) if str(item or "").strip()]
    except Exception:
        return []


def _basename(path: str) -> str:
    return str(path or "").replace("\\", "/").rsplit("/", 1)[-1]


def _text_encoder_options() -> list[str]:
    files = _filename_list("text_encoders")
    if not files:
        return [DEFAULT_CLIP_NAME]
    preferred = [item for item in files if _basename(item) == DEFAULT_CLIP_NAME]
    gemma = [item for item in files if "gemma" in _basename(item).lower()]
    rest = [item for item in files if item not in preferred and item not in gemma]
    return preferred + sorted(gemma, key=lambda item: _basename(item).lower()) + sorted(rest, key=lambda item: item.lower())


def _default_clip_name(options: list[str]) -> str:
    for item in options:
        if _basename(item) == DEFAULT_CLIP_NAME:
            return item
    for item in options:
        if "gemma" in _basename(item).lower():
            return item
    return options[0] if options else DEFAULT_CLIP_NAME


def _model_spec_for_clip(clip_name: str) -> dict[str, str]:
    filename = _basename(clip_name) or DEFAULT_CLIP_NAME
    # 确保 subdir 使用相对路径格式（不带 models/ 前缀）
    subdir = "text_encoders"
    return make_missing_model_spec(
        label="Gemma / Ideogram4 文本编码器",
        subdir=subdir,
        filename=filename,
        description=f"请把 {filename} 放到 ComfyUI/models/{subdir}/ 后重启或刷新模型列表。",
    )


def _find_text_encoder_path(clip_name: str) -> str | None:
    if folder_paths is None:
        return None
    try:
        return folder_paths.get_full_path("text_encoders", clip_name)
    except Exception:
        return None


def _qwen35_runtime_issue(clip_name: str) -> str:
    normalized_name = _basename(clip_name).lower().replace("_", "").replace("-", "")
    if "qwen3.5" not in normalized_name and "qwen35" not in normalized_name:
        return ""

    missing = []
    try:
        import comfy.sd as comfy_sd
        te_model = getattr(comfy_sd, "TEModel", None)
        if te_model is None or not hasattr(te_model, "QWEN35_4B"):
            missing.append("ComfyUI sd.py 未注册 QWEN35 文本编码器")
    except Exception as exc:
        missing.append(f"无法导入 ComfyUI 文本编码器注册表：{exc}")

    try:
        import comfy.text_encoders.qwen35  # noqa: F401
    except Exception as exc:
        missing.append(f"缺少 comfy.text_encoders.qwen35：{exc}")

    try:
        import comfy.text_encoders.qwen3vl  # noqa: F401
    except Exception as exc:
        missing.append(f"缺少 comfy.text_encoders.qwen3vl：{exc}")

    try:
        import accelerate  # noqa: F401
    except Exception as exc:
        missing.append(f"缺少 Python 依赖 accelerate：{exc}")

    if not missing:
        return ""
    details = "\n".join(f"- {item}" for item in missing)
    return (
        f"当前 ComfyUI 运行环境不支持 {clip_name}。\n"
        "该模型需要较新的 ComfyUI Qwen3.5/Qwen3VL 文本编码器实现和配套 Python 依赖；"
        "请更新 CUI77 的 ComfyUI 本体与 python_embeded 依赖，或改用 CUI78 运行。\n"
        f"{details}"
    )


def _available_runtime_report() -> dict[str, Any]:
    missing_models = []
    files = _filename_list("text_encoders")
    if not any(_basename(item) == DEFAULT_CLIP_NAME for item in files):
        missing_models.append(_model_spec_for_clip(DEFAULT_CLIP_NAME))
    return build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=[],
        missing_models=missing_models,
        description=NODE_DESCRIPTION,
        model_download_url=MODEL_DOWNLOAD_URL,
    )


_ENVIRONMENT_REPORT = _available_runtime_report()
_DEPENDENCIES_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("dependencies_available", True))
_MODELS_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("models_available", True))
_MISSING_DEPENDENCIES = list(_ENVIRONMENT_REPORT.get("missing_dependencies", []) or [])
_MISSING_MODELS = list(_ENVIRONMENT_REPORT.get("missing_models", []) or [])
if not (_DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE):
    print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ Gemma 文本生成模型提示")

_CLIP_CACHE: dict[str, Any] = {"key": None, "clip": None}


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "开启", "开", "是", "保持模型"}:
        return True
    if text in {"0", "false", "no", "off", "关闭", "关", "否", "不保持"}:
        return False
    return default


def _device_from_preference(clip_device: str, device_preference: str) -> str:
    if str(device_preference or "").strip().startswith("CPU"):
        return "cpu"
    if str(clip_device or "").strip().lower() == "cpu":
        return "cpu"
    return "default"


def _clear_clip_cache() -> None:
    _CLIP_CACHE["key"] = None
    _CLIP_CACHE["clip"] = None
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _load_merged_clip(clip_name: str, clip_type: str, device: str = "default"):
    normalized_name = _basename(clip_name).lower()
    use_forced_fp8_e4m3fn = "gemma" in normalized_name and "fp8_e4m3fn" in normalized_name
    if use_forced_fp8_e4m3fn:
        try:
            import torch
            import comfy.sd
        except Exception as exc:
            raise RuntimeError(f"无法导入 ComfyUI fp8 CLIP 加载运行时：{exc}") from exc
        if folder_paths is None:
            raise RuntimeError("无法访问 ComfyUI 模型路径管理器。")
        clip_path = folder_paths.get_full_path("text_encoders", clip_name)
        if not clip_path:
            raise RuntimeError(f"未找到文本编码器：{clip_name}")
        clip_type_value = getattr(comfy.sd.CLIPType, str(clip_type or "ideogram4").upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
        model_options = {"dtype": torch.float8_e4m3fn}
        if device == "cpu":
            model_options["load_device"] = model_options["offload_device"] = torch.device("cpu")
        return comfy.sd.load_clip(
            ckpt_paths=[clip_path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=clip_type_value,
            model_options=model_options,
        )
    try:
        from nodes import CLIPLoader
    except Exception as exc:
        raise RuntimeError(f"无法导入 ComfyUI 官方 CLIPLoader：{exc}") from exc
    return CLIPLoader().load_clip(clip_name, clip_type, device)[0]


def _load_clip_cached(clip_name: str, clip_type: str, device: str, keep_model: bool):
    cache_key = f"{clip_name}\n{clip_type}\n{device}"
    if keep_model and _CLIP_CACHE.get("key") == cache_key and _CLIP_CACHE.get("clip") is not None:
        print(f"[GJJ GemmaTextGenerate] 复用保持模型缓存: {_basename(clip_name)} device={device}", flush=True)
        return _CLIP_CACHE["clip"], True
    if keep_model or _CLIP_CACHE.get("clip") is not None:
        _clear_clip_cache()
    clip = _load_merged_clip(clip_name, clip_type, device)
    if keep_model:
        _CLIP_CACHE["key"] = cache_key
        _CLIP_CACHE["clip"] = clip
    return clip, False


def _generate_text(
    clip: Any,
    prompt: str,
    max_length: int,
    sampling_mode: str,
    image: Any = None,
    video: Any = None,
    audio: Any = None,
    thinking: bool = False,
    use_default_template: bool = True,
    temperature: float = 0.7,
    top_k: int = 64,
    top_p: float = 0.95,
    min_p: float = 0.05,
    repetition_penalty: float = 1.05,
    seed: int = 0,
    presence_penalty: float = 0.0,
) -> str:
    effective_prompt = str(prompt or "")
    if not bool(thinking):
        assistant_rule = ollama_assistant_output_rule() or DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE
        effective_prompt = f"{NO_THINK_OUTPUT_RULE}\n{assistant_rule}\n\n{effective_prompt}".strip()
    tokens = clip.tokenize(
        effective_prompt,
        image=image,
        skip_template=not bool(use_default_template),
        min_length=1,
        thinking=bool(thinking),
        video=video,
        audio=audio,
    )
    do_sample = str(sampling_mode or "on") == "on"
    generated_ids = _clip_generate_compat(
        clip,
        tokens,
        do_sample=do_sample,
        max_length=max(1, min(2048, int(max_length or 256))),
        temperature=float(temperature),
        top_k=int(top_k),
        top_p=float(top_p),
        min_p=float(min_p),
        repetition_penalty=float(repetition_penalty),
        presence_penalty=float(presence_penalty),
        seed=int(seed),
    )
    text = str(clip.decode(generated_ids) or "")
    if not bool(thinking):
        text = _clean_no_think_output(text, effective_prompt)
    return text


def _clip_generate_compat(clip: Any, tokens: Any, **kwargs: Any) -> Any:
    generate = getattr(clip, "generate")
    usable_kwargs = dict(kwargs)
    try:
        signature = inspect.signature(generate)
        if not any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values()):
            usable_kwargs = {key: value for key, value in usable_kwargs.items() if key in signature.parameters}
    except (TypeError, ValueError):
        pass

    while True:
        try:
            return generate(tokens, **usable_kwargs)
        except TypeError as exc:
            match = re.search(r"unexpected keyword argument ['\"]([^'\"]+)['\"]", str(exc))
            if not match or match.group(1) not in usable_kwargs:
                raise
            usable_kwargs.pop(match.group(1), None)


def _clean_no_think_output(text: str, prompt: str = "") -> str:
    cleaned = str(text or "")
    cleaned = re.sub(r"<think\b[^>]*>.*?</think>", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    if re.search(r"</think>", cleaned, flags=re.IGNORECASE):
        cleaned = re.sub(r"^.*?</think>\s*", "", cleaned, count=1, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"</?think\b[^>]*>", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"<thinking\b[^>]*>.*?</thinking>", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"</?thinking\b[^>]*>", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"<(?:analysis|reasoning|scratchpad)\b[^>]*>.*?</(?:analysis|reasoning|scratchpad)>", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"</?(?:analysis|reasoning|scratchpad)\b[^>]*>", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"<\|im_(?:start|end)\|>", "", cleaned)
    cleaned = re.sub(r"<start_of_turn>\s*(?:model|assistant|user)?", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"<end_of_turn>", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^\s*(?:assistant|model)\s*[:：]\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^\s*\[\d+\]\s*", "", cleaned)

    prompt_text = str(prompt or "").strip()
    if prompt_text and cleaned.lstrip().startswith(prompt_text):
        cleaned = cleaned.lstrip()[len(prompt_text):]

    prompt_lines = {line.strip() for line in prompt_text.splitlines() if line.strip()}
    lines = cleaned.splitlines()
    while lines and lines[0].strip() in prompt_lines:
        lines.pop(0)
    cleaned = "\n".join(lines).strip()
    cleaned = _strip_labeled_thinking_block(cleaned)
    cleaned = _strip_common_preface(cleaned)
    return cleaned.strip()


def _strip_labeled_thinking_block(text: str) -> str:
    cleaned = str(text or "").strip()
    if not cleaned:
        return ""

    thinking_label = (
        r"(?:思考过程|思考|推理过程|推理|分析过程|分析|思路|草稿|内心独白|"
        r"reasoning|thought process|thinking|analysis|scratchpad|chain of thought)"
    )
    final_label = (
        r"(?:最终答案|最终结果|最终输出|答案|回答|回复|结果|输出|正文|改写结果|提示词|"
        r"final answer|final result|answer|response|result|output)"
    )

    starts_with_thinking = re.match(rf"^\s*(?:#+\s*)?{thinking_label}\s*[:：\n]", cleaned, flags=re.IGNORECASE)
    final_matches = list(re.finditer(rf"(?im)^\s*(?:#+\s*)?{final_label}\s*[:：]\s*", cleaned))
    if final_matches and final_matches[0].start() == 0:
        return cleaned[final_matches[0].end():].strip()
    if final_matches and (starts_with_thinking or final_matches[0].start() > 0):
        final = final_matches[-1]
        return cleaned[final.end():].strip()

    if starts_with_thinking:
        without_label = re.sub(rf"^\s*(?:#+\s*)?{thinking_label}\s*[:：]?\s*", "", cleaned, count=1, flags=re.IGNORECASE)
        stripped = _strip_to_last_final_marker(without_label)
        if stripped != without_label:
            return stripped.strip()
        parts = [part.strip() for part in re.split(r"\n\s*\n", without_label) if part.strip()]
        if len(parts) >= 2:
            return "\n\n".join(parts[1:]).strip()
    return _strip_unlabeled_thinking_prefix(cleaned)


def _strip_unlabeled_thinking_prefix(text: str) -> str:
    cleaned = str(text or "").strip()
    if not cleaned:
        return ""
    intro_patterns = (
        r"^\s*(?:好的|好|嗯|让我|我需要|我们需要|首先|先来|接下来|现在需要|用户(?:想|要|希望)|"
        r"Okay|Ok|Sure|Let me|I need to|We need to|First,|First I)\b"
    )
    if not re.search(intro_patterns, cleaned, flags=re.IGNORECASE):
        return cleaned
    stripped = _strip_to_last_final_marker(cleaned)
    if stripped != cleaned:
        return stripped.strip()
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", cleaned) if part.strip()]
    if len(paragraphs) >= 2:
        first = paragraphs[0]
        thinky = re.search(
            r"(?:我需要|我们需要|用户|任务|要求|分析|推理|思考|先|然后|应该|不能|需要确保|"
            r"让我|接下来|目标是|可以这样|Let's|I need|user wants|need to|the task)",
            first,
            flags=re.IGNORECASE,
        )
        if thinky and len(first) >= 20:
            return "\n\n".join(paragraphs[1:]).strip()
    return cleaned


def _strip_to_last_final_marker(text: str) -> str:
    cleaned = str(text or "").strip()
    if not cleaned:
        return ""
    final_markers = (
        r"(?:最终答案|最终结果|最终输出|答案|回答|回复|结果|输出|正文|改写结果|提示词|"
        r"final answer|final result|answer|response|result|output)\s*[:：]"
    )
    matches = list(re.finditer(final_markers, cleaned, flags=re.IGNORECASE))
    if matches:
        return cleaned[matches[-1].end():].strip()
    return cleaned


def _strip_common_preface(text: str) -> str:
    cleaned = str(text or "").strip()
    if not cleaned:
        return ""
    cleaned = re.sub(
        r"^\s*(?:好的|好|可以|当然|没问题|下面是|以下是|这里是|Sure|Okay|Ok)\s*[，,。:：-]*\s*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    return cleaned.strip()


def _coerce_float(value: Any, default: float, minimum: float | None = None, maximum: float | None = None) -> float:
    if isinstance(value, bool):
        number = default
    else:
        text = str(value).strip().lower()
        if text in {"", "none", "null", "false", "true"}:
            number = default
        else:
            try:
                number = float(value)
            except Exception:
                number = default
    if minimum is not None:
        number = max(minimum, number)
    if maximum is not None:
        number = min(maximum, number)
    return number


def _coerce_int(value: Any, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    number = int(_coerce_float(value, float(default), None, None))
    if minimum is not None:
        number = max(minimum, number)
    if maximum is not None:
        number = min(maximum, number)
    return number


def _merged_generation_prompt(system_prompt: str, user_prompt: str) -> str:
    system_text = str(system_prompt or "").strip()
    user_text = str(user_prompt or "").strip()
    if not system_text:
        return user_text
    if not user_text:
        return system_text
    return f"{system_text}\n\n{user_text}"


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _coerce_tensor_to_images(tensor: Any, source_label: str = "媒体"):
    try:
        import torch
    except Exception as exc:
        raise RuntimeError(f"{source_label}转换图片需要 PyTorch：{exc}") from exc

    if not isinstance(tensor, torch.Tensor):
        raise RuntimeError(f"{source_label}没有解析出可用张量。")

    image = tensor.detach()
    if image.ndim == 0:
        image = image.reshape(1, 1, 1, 1)
    elif image.ndim == 1:
        image = image.reshape(1, 1, int(image.shape[0]), 1)
    elif image.ndim == 2:
        image = image.unsqueeze(0).unsqueeze(-1)
    elif image.ndim == 3:
        if image.shape[-1] in (1, 3, 4):
            image = image.unsqueeze(0)
        elif image.shape[0] in (1, 3, 4):
            image = image.permute(1, 2, 0).unsqueeze(0)
        else:
            image = image.unsqueeze(-1)
    else:
        # VIDEO 和其它高维张量统一压平前置批次/时间维，最终得到 BHWC。
        if image.shape[-1] in (1, 3, 4):
            image = image.reshape(-1, image.shape[-3], image.shape[-2], image.shape[-1])
        elif image.shape[-3] in (1, 3, 4):
            image = image.reshape(-1, image.shape[-3], image.shape[-2], image.shape[-1])
            image = image.permute(0, 2, 3, 1)
        elif image.shape[1] in (1, 3, 4):
            if image.ndim > 4:
                image = image.movedim(1, -3)
            image = image.reshape(-1, image.shape[-3], image.shape[-2], image.shape[-1])
            image = image.permute(0, 2, 3, 1)
        else:
            height = int(image.shape[-2])
            width = int(image.shape[-1])
            image = image.reshape(-1, height, width).unsqueeze(-1)

    image = image.to(dtype=torch.float32)
    image = torch.nan_to_num(image, nan=0.0, posinf=1.0, neginf=0.0)
    if image.shape[-1] == 1:
        image = image.repeat(1, 1, 1, 3)
    elif image.shape[-1] >= 4:
        image = image[..., :3]
    elif image.shape[-1] == 2:
        image = torch.cat([image, image[..., :1]], dim=-1)

    if image.numel():
        minimum = float(image.amin().item())
        maximum = float(image.amax().item())
        if minimum < 0.0 or maximum > 1.0:
            span = maximum - minimum
            image = (image - minimum) / span if span > 1e-8 else torch.zeros_like(image)
    return image.clamp_(0.0, 1.0).contiguous()


def _coerce_media_for_textgen(media: Any | None):
    if media is None:
        return None

    source = media
    if hasattr(source, "get_components"):
        try:
            source = source.get_components()
        except Exception as exc:
            raise RuntimeError(f"读取 VIDEO 视频帧失败：{exc}") from exc
        source = _component_value(source, "images")
        if source is None:
            raise RuntimeError("输入 VIDEO 没有解析出可用图片帧。")
    elif hasattr(source, "images"):
        source = getattr(source, "images", None)

    tensor = source
    if isinstance(source, dict):
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = source.get(key)
            if candidate is not None:
                tensor = candidate
                break
    elif isinstance(source, (list, tuple)) and source:
        import torch
        if all(isinstance(item, torch.Tensor) for item in source):
            converted = [_coerce_tensor_to_images(item, "媒体列表") for item in source]
            tensor = torch.cat(converted, dim=0)
    else:
        for key in ("images", "frames", "samples"):
            candidate = getattr(source, key, None)
            if candidate is not None:
                tensor = candidate
                break

    return _coerce_tensor_to_images(tensor, "统一媒体输入")


class GJJ_GemmaTextGenerate:
    CATEGORY = "GJJ/视频/文本生成"
    FUNCTION = "generate"
    DESCRIPTION = (
        NODE_DESCRIPTION
        if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
        else _ENVIRONMENT_REPORT.get("warning_message", NODE_DESCRIPTION)
    )
    SEARCH_ALIASES = ["TextGenerate", "Generate Text", "Gemma", "ideogram4", "文本生成", "加载CLIP"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("生成文本",)
    OUTPUT_TOOLTIPS = ("由内部加载的 Gemma/CLIP 文本生成模型生成的文本。",)
    GJJ_HELP = build_node_help_payload(
        description=NODE_DESCRIPTION,
        dependencies=[
            {
                "name": "ComfyUI 官方 CLIPLoader / TextGenerate 运行时",
                "type": "内置运行时",
                "required": True,
                "description": "节点只调用 ComfyUI 自带 CLIP 对象的 tokenize / generate / decode，不依赖其它自定义节点包。",
            }
        ],
        model_tree=GEMMA_TEXT_ENCODER_MODELS,
        models=[_model_spec_for_clip(DEFAULT_CLIP_NAME)],
        usage=[
            "选择 CLIP 名称和类型后，直接填写提示词执行。",
            "可选连接统一媒体输入口：IMAGE、GJJ_BATCH_IMAGE、官方 VIDEO 和可识别张量都会统一转换为 RGB 图片批次。",
            "默认类型 ideogram4 对应截图中的加载 CLIP 类型。",
            "采样模式为 off 时会关闭随机采样，仅保留最大长度等基础参数。",
        ],
        runtime=[
            "内部等价于：CLIPLoader.load_clip(...) -> clip.tokenize(...) -> clip.generate(...) -> clip.decode(...)。",
            "VIDEO 会提取全部视频帧并压平为图片批次；灰度、RGBA、通道前置和常见高维张量会自动转换为 BHWC RGB 图片。",
        ],
        model_download_url=MODEL_DOWNLOAD_URL,
        copy_text=MODEL_DOWNLOAD_URL,
        copy_label="🌏 复制模型下载地址",
        notice=_ENVIRONMENT_REPORT.get("warning_message", ""),
    )

    @classmethod
    def INPUT_TYPES(cls):
        clip_options = _text_encoder_options()
        default_clip = _default_clip_name(clip_options)
        default_system_prompt = ollama_assistant_system_prompt() or DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT
        default_templates = ollama_assistant_system_prompt_templates() or DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT_TEMPLATES
        default_output_rule = ollama_assistant_output_rule() or DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE
        return {
            "required": {
                "clip_name": (clip_options, {
                    "default": default_clip,
                    "display_name": "CLIP 名称",
                    "tooltip": "选择 text_encoders 目录下的 Gemma / Ideogram4 文本编码器。默认优先 qwen3.5_4b_fp8_mixed.safetensors。",
                }),
                "clip_type": (CLIP_TYPES, {
                    "default": "ideogram4",
                    "display_name": "CLIP 类型",
                    "tooltip": "传给官方 CLIPLoader 的类型。截图中的类型为 ideogram4。",
                }),
                "clip_device": (["default", "cpu"], {
                    "default": "default",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "加载设备",
                    "tooltip": "default 使用 ComfyUI 默认设备；cpu 可强制把 CLIP 加载到 CPU。",
                }),
                "prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "dynamicPrompts": True,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "提示词",
                    "tooltip": "发送给文本生成模型的用户指令；前端同时提供内置多行文本框和可外接 STRING 输入口。",
                }),
                "max_length": ("INT", {
                    "default": 2048,
                    "min": 1,
                    "max": 2048,
                    "step": 1,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "最大长度",
                    "tooltip": "生成文本的最大 token 长度。",
                }),
                "sampling_mode": (["on", "off"], {
                    "default": "on",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "采样模式",
                    "tooltip": "on 开启随机采样参数；off 关闭随机采样。",
                }),
                "temperature": ("FLOAT", {
                    "default": 0.7,
                    "min": 0.01,
                    "max": 2.0,
                    "step": 0.000001,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "温度",
                    "tooltip": "采样温度。越高越发散，越低越稳定。",
                }),
                "top_k": ("INT", {
                    "default": 64,
                    "min": 0,
                    "max": 1000,
                    "step": 1,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "Top K",
                    "tooltip": "只从概率最高的 K 个 token 中采样；0 通常表示不限制。",
                }),
                "top_p": ("FLOAT", {
                    "default": 0.95,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "Top P",
                    "tooltip": "核采样阈值。",
                }),
                "min_p": ("FLOAT", {
                    "default": 0.05,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "最小概率",
                    "tooltip": "按最高概率 token 的相对比例过滤低概率候选。",
                }),
                "repetition_penalty": ("FLOAT", {
                    "default": 1.05,
                    "min": 0.0,
                    "max": 5.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "重复惩罚",
                    "tooltip": "抑制重复文本片段。1.0 基本不惩罚。",
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 0xFFFFFFFFFFFFFFFF,
                    "step": 1,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "种子",
                    "tooltip": "随机采样种子。",
                }),
                "presence_penalty": ("STRING", {
                    "default": "0.0",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "出现惩罚",
                    "tooltip": "降低已出现内容再次出现的概率。",
                }),
                "thinking": ("BOOLEAN", {
                    "default": False,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "思考模式",
                    "tooltip": "如果模型支持，允许模型以 thinking 模式生成。",
                }),
                "use_default_template": ("BOOLEAN", {
                    "default": True,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "使用默认模板",
                    "tooltip": "使用模型内置系统提示/模板；关闭时跳过默认模板。",
                }),
                "system_prompt": ("STRING", {
                    "default": default_system_prompt,
                    "multiline": True,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "系统提示词",
                    "tooltip": "由模板按钮快速填入，也可以自定义任务规则；执行时会放在用户提示词之前。",
                }),
                "system_prompt_templates": ("STRING", {
                    "default": default_templates,
                    "multiline": True,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "系统提示词模板",
                    "tooltip": "与 GJJ_OllamaAssistant 共用 presets/gjj_user_settings.json 中的同一套模板。",
                }),
                "system_prompt_output_rule": ("STRING", {
                    "default": default_output_rule,
                    "multiline": True,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "输出约束",
                    "tooltip": "点击模板按钮时追加到系统提示词正文之后；与 GJJ_OllamaAssistant 共用预设。",
                }),
                "keep_model": ("BOOLEAN", {
                    "default": False,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "保持模型",
                    "tooltip": "开启后保留已加载的 CLIP/Gemma 模型，后续执行复用，减少重复加载时间但会占用显存/内存。",
                }),
                "device_preference": (["GPU优先", "CPU优先"], {
                    "default": "GPU优先",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "GPU/CPU优先",
                    "tooltip": "GPU优先使用 ComfyUI 默认 GPU 加载策略；CPU优先强制把 CLIP/Gemma 加载到 CPU。",
                }),
            },
            "optional": {
                "media": (MEDIA_INPUT_TYPE, {
                    "display_name": "图片/视频",
                    "tooltip": "统一输入口。VIDEO 与其它可识别张量会自动转换、归一化为 BHWC RGB 图片批次后喂给 Gemma。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        clip_name: str,
        clip_type: str,
        clip_device: str,
        prompt: str,
        max_length: int,
        sampling_mode: str,
        temperature: float,
        top_k: int,
        top_p: float,
        min_p: float,
        repetition_penalty: float,
        seed: int,
        presence_penalty: Any,
        thinking: bool,
        use_default_template: bool,
        media: Any = None,
        image: Any = None,
        video: Any = None,
        audio: Any = None,
        unique_id: Any = None,
        system_prompt: str = "",
        system_prompt_templates: str = "",
        system_prompt_output_rule: str = "",
        keep_model: bool = False,
        device_preference: str = "GPU优先",
    ):
        if not _find_text_encoder_path(clip_name):
            missing = [_model_spec_for_clip(clip_name)]
            raise_dependency_model_error(
                NODE_DISPLAY_NAME,
                missing_models=missing,
                description=NODE_DESCRIPTION,
                unique_id=unique_id,
                model_download_url=MODEL_DOWNLOAD_URL,
                copy_text=MODEL_DOWNLOAD_URL,
                copy_label="🌏 复制模型下载地址",
            )
        runtime_issue = _qwen35_runtime_issue(clip_name)
        if runtime_issue:
            raise RuntimeError(runtime_issue)
        try:
            import time
            start_total = time.time()
            
            media_image = _coerce_media_for_textgen(media)
            if image is None:
                image = media_image
            elif media_image is not None:
                image = media_image
            if image is None and video is not None:
                image = _coerce_media_for_textgen(video)
            elif image is not None:
                image = _coerce_media_for_textgen(image)
            video = None
            
            start_load = time.time()
            effective_device = _device_from_preference(str(clip_device or "default"), str(device_preference or "GPU优先"))
            keep_loaded = _as_bool(keep_model, False)
            clip, cache_hit = _load_clip_cached(str(clip_name), str(clip_type or "ideogram4"), effective_device, keep_loaded)
            load_time = time.time() - start_load
            print(
                f"[GJJ GemmaTextGenerate] CLIP 模型加载耗时: {load_time:.2f} 秒 | "
                f"device_preference={device_preference} effective_device={effective_device} "
                f"keep_model={keep_loaded} cache_hit={cache_hit}",
                flush=True,
            )
            
            start_gen = time.time()
            text = _generate_text(
                clip,
                _merged_generation_prompt(system_prompt, prompt),
                _coerce_int(max_length, 2048, 1, 2048),
                sampling_mode,
                image=image,
                video=video,
                audio=audio,
                thinking=thinking,
                use_default_template=use_default_template,
                temperature=_coerce_float(temperature, 0.7, 0.01, 2.0),
                top_k=_coerce_int(top_k, 64, 0, 1000),
                top_p=_coerce_float(top_p, 0.95, 0.0, 1.0),
                min_p=_coerce_float(min_p, 0.05, 0.0, 1.0),
                repetition_penalty=_coerce_float(repetition_penalty, 1.05, 0.0, 5.0),
                seed=_coerce_int(seed, 0, 0, 0xFFFFFFFFFFFFFFFF),
                presence_penalty=_coerce_float(presence_penalty, 0.0, 0.0, 5.0),
            )
            gen_time = time.time() - start_gen
            total_time = time.time() - start_total
            print(f"[GJJ GemmaTextGenerate] 文本生成耗时: {gen_time:.2f} 秒 | 总耗时: {total_time:.2f} 秒 | thinking={thinking}", flush=True)
            if not keep_loaded:
                try:
                    del clip
                except Exception:
                    pass
                _clear_clip_cache()
            return (text,)
        except Exception as exc:
            report = getattr(exc, "gjj_report", None)
            if report:
                send_dependency_model_notice(report, unique_id=unique_id)
                raise RuntimeError(report.get("warning_message") or "运行环境缺失") from exc
            raise RuntimeError(f"Gemma 文本生成失败：{exc}") from exc


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_GemmaTextGenerate}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
