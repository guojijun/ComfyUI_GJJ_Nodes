from __future__ import annotations

import json
import re
import inspect
import gc
import os
import secrets
import threading
from pathlib import Path
from typing import Any

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    from aiohttp import web
    from server import PromptServer
except Exception:
    web = None
    PromptServer = None

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
NODE_DISPLAY_NAME = "GJJ·💛Gemma🧠图片反推提示词推理"
NODE_DESCRIPTION = "把官方“加载CLIP + TextGenerate”合并成一个 GJJ 零第三方依赖节点；适合 Ideogram4 / Gemma 文本生成、提示词扩写和多模态文本生成。"
MODEL_FAMILY_KEYWORDS = ("qwen3.5", "qwen35", "gemma4", "qwen3vl","ernie")
MODEL_FILTER_EXPRESSION = "qwen3.5|gemma4|qwen3vl|ernie"
MISSING_CLIP_PLACEHOLDER = "未找到匹配的反推模型"
DEFAULT_CLIP_NAME = "Qwen3.5-4B-Uncensored-FP8_E4M3FN.safetensors"
MODEL_DOWNLOAD_URL = DEFAULT_MODEL_URL
_OFFICIAL_TEXT_GENERATE_LOCK = threading.RLock()


def _find_generation_sampler(clip: Any) -> Any:
    queue = [clip]
    visited: set[int] = set()
    while queue:
        current = queue.pop(0)
        if current is None or id(current) in visited:
            continue
        visited.add(id(current))
        if callable(getattr(current, "sample_token", None)):
            stop_tokens = getattr(getattr(getattr(current, "model", None), "config", None), "stop_tokens", None)
            if stop_tokens:
                return current
        for name in ("cond_stage_model", "transformer"):
            child = getattr(current, name, None)
            if child is not None:
                queue.append(child)
        dynamic_name = getattr(current, "clip", None)
        if isinstance(dynamic_name, str):
            child = getattr(current, dynamic_name, None)
            if child is not None:
                queue.append(child)
    return None


def _token_cycle_period(tokens: list[Any], max_period: int = 256) -> int:
    count = len(tokens)
    for period in range(1, min(max_period, count // 3) + 1):
        repetitions = 8 if period < 4 else 3
        width = period * repetitions
        if count < width:
            continue
        tail = tokens[-width:]
        unit = tail[:period]
        if all(tail[offset:offset + period] == unit for offset in range(period, width, period)):
            return period
    return 0


def _install_token_cycle_guard(clip: Any):
    sampler = _find_generation_sampler(clip)
    if sampler is None:
        return None
    original = sampler.sample_token
    had_instance_value = "sample_token" in vars(sampler)
    instance_value = vars(sampler).get("sample_token")
    base_history_length: int | None = None
    stopped = False

    def guarded(*args, **kwargs):
        nonlocal base_history_length, stopped
        history = kwargs.get("token_history")
        if history is None and len(args) > 6:
            history = args[6]
        if history is not None:
            if base_history_length is None:
                base_history_length = len(history)
            generated = list(history[base_history_length:])
            period = _token_cycle_period(generated)
            if period:
                import torch
                stop_tokens = list(getattr(sampler.model.config, "stop_tokens", []) or [])
                if stop_tokens:
                    if not stopped:
                        print(
                            f"[GJJ GemmaTextGenerate] 检测到 token 循环（周期={period}），已提前结束生成。",
                            flush=True,
                        )
                        stopped = True
                    logits = args[0] if args else kwargs["logits"]
                    return torch.full(
                        (int(logits.shape[0]), 1), int(stop_tokens[0]),
                        dtype=torch.long, device=logits.device,
                    )
        return original(*args, **kwargs)

    sampler.sample_token = guarded

    def restore():
        if had_instance_value:
            sampler.sample_token = instance_value
        else:
            delattr(sampler, "sample_token")

    return restore


class AnyMediaType(str):
    def __ne__(self, _other: object) -> bool:
        return False


MEDIA_INPUT_TYPE = AnyMediaType("IMAGE,GJJ_BATCH_IMAGE,VIDEO,AUDIO")

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

def _filename_list(category: str) -> list[str]:
    if folder_paths is None:
        return []
    try:
        return [str(item) for item in (folder_paths.get_filename_list(category) or []) if str(item or "").strip()]
    except Exception:
        return []


def _basename(path: str) -> str:
    return str(path or "").replace("\\", "/").rsplit("/", 1)[-1]


def _is_supported_text_encoder(name: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", "", _basename(name).lower())
    return any(re.sub(r"[^a-z0-9]+", "", keyword) in normalized for keyword in MODEL_FAMILY_KEYWORDS)


def _text_encoder_size(name: str) -> int:
    path = _find_text_encoder_path(name)
    try:
        return int(os.path.getsize(str(path)))
    except (OSError, TypeError, ValueError):
        return 2**63 - 1


def _text_encoder_options() -> list[str]:
    files = [item for item in _filename_list("text_encoders") if _is_supported_text_encoder(item)]
    return sorted(files, key=lambda item: (_text_encoder_size(item), _basename(item).lower()))


def _default_clip_name(options: list[str]) -> str:
    if not options:
        return MISSING_CLIP_PLACEHOLDER
    wanted = DEFAULT_CLIP_NAME.replace("\\", "/").casefold()
    wanted_base = wanted.rsplit("/", 1)[-1]
    for option in options:
        normalized = str(option or "").replace("\\", "/").casefold()
        if normalized == wanted or normalized.rsplit("/", 1)[-1] == wanted_base:
            return option
    return options[0]


def _resolve_available_clip_name(clip_name: str) -> str:
    requested = str(clip_name or "").strip()
    if requested and _find_text_encoder_path(requested):
        return requested

    compatible = [item for item in _text_encoder_options() if _find_text_encoder_path(item)]
    if not compatible:
        return requested or MISSING_CLIP_PLACEHOLDER

    requested_name = _basename(requested).lower()
    requested_tokens = {
        token for token in re.split(r"[^a-z0-9.]+", requested_name)
        if token and token not in {"safetensors", "mixed", "hybrid", "scaled"}
    }

    def score(candidate: str) -> tuple[int, int, int, int, str]:
        name = _basename(candidate).lower()
        tokens = {
            token for token in re.split(r"[^a-z0-9.]+", name)
            if token and token not in {"safetensors", "mixed", "hybrid", "scaled"}
        }
        same_family = 0
        if "gemma4" in requested_name and "gemma4" in name:
            same_family = 200
        elif (
            ("qwen3.5" in requested_name or "qwen35" in requested_name)
            and ("qwen3.5" in name or "qwen35" in name)
        ):
            same_family = 200
        return same_family, len(requested_tokens & tokens), -_text_encoder_size(candidate), 0, name

    replacement = max(compatible, key=score)
    if requested and replacement != requested:
        print(
            f"[GJJ GemmaTextGenerate] 模型名称已失效，自动替换："
            f"{requested} -> {replacement}",
            flush=True,
        )
    return replacement


def _model_spec_for_clip(clip_name: str) -> dict[str, str]:
    filename = _basename(clip_name)
    if not filename or filename == MISSING_CLIP_PLACEHOLDER:
        filename = MODEL_FILTER_EXPRESSION
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


def _format_model_size(path: str | None) -> str:
    try:
        size = float(os.path.getsize(str(path)))
    except (OSError, TypeError, ValueError):
        return "未知"
    units = ("B", "KB", "MB", "GB", "TB")
    unit = units[0]
    for unit in units:
        if size < 1024.0 or unit == units[-1]:
            break
        size /= 1024.0
    precision = 2 if size < 10 else 1
    return f"{size:.{precision}f} {unit}"


async def _get_text_encoder_model_sizes(_request):
    sizes = {}
    for name in _filename_list("text_encoders"):
        path = _find_text_encoder_path(name)
        try:
            sizes[name] = os.path.getsize(str(path))
        except (OSError, TypeError, ValueError):
            continue
    return web.json_response({"ok": True, "sizes": sizes})


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None and web is not None:
    _server = PromptServer.instance
    if not getattr(_server, "_gjj_text_encoder_sizes_api_registered", False):
        _server.routes.get("/gjj/text_encoder_model_sizes")(_get_text_encoder_model_sizes)
        _server._gjj_text_encoder_sizes_api_registered = True


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
    if not _text_encoder_options():
        missing_models.append(_model_spec_for_clip(""))
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
        clip_type_value = getattr(comfy.sd.CLIPType, str(clip_type or "stable_diffusion").upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
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
    add_output_rules: bool = True,
    anti_loop: bool = False,
) -> str:
    import time

    thinking_enabled = _as_bool(thinking, False)
    default_template_enabled = _as_bool(use_default_template, True)
    effective_prompt = str(prompt or "")
    try:
        from comfy_extras.nodes_textgen import TextGenerate
    except Exception as exc:
        raise RuntimeError(f"无法导入 ComfyUI 官方 TextGenerate：{exc}") from exc

    sampling_payload = {
        "sampling_mode": "on" if str(sampling_mode or "on") == "on" else "off",
        "temperature": float(temperature),
        "top_k": int(top_k),
        "top_p": float(top_p),
        "min_p": float(min_p),
        "repetition_penalty": float(repetition_penalty),
        "presence_penalty": float(presence_penalty),
        "seed": int(seed),
    }
    official_kwargs = {
        "clip": clip,
        "prompt": effective_prompt,
        "max_length": max(1, min(32768, int(max_length or 512))),
        "sampling_mode": sampling_payload,
        "image": image,
        "video": video,
        "audio": audio,
        "thinking": thinking_enabled,
        "use_default_template": default_template_enabled,
    }

    def execute_official(kwargs: dict[str, Any]) -> tuple[Any, float]:
        signature = inspect.signature(TextGenerate.execute)
        usable_kwargs = {key: value for key, value in kwargs.items() if key in signature.parameters}
        with _OFFICIAL_TEXT_GENERATE_LOCK:
            server = getattr(PromptServer, "instance", None) if PromptServer is not None else None
            had_prompt_id = bool(server is not None and hasattr(server, "last_prompt_id"))
            previous_prompt_id = getattr(server, "last_prompt_id", None) if had_prompt_id else None
            if server is not None and not previous_prompt_id:
                setattr(server, "last_prompt_id", f"gjj_gemma_{time.time_ns()}")
            try:
                official_started = time.perf_counter()
                restore_cycle_guard = _install_token_cycle_guard(clip) if anti_loop else None
                try:
                    output = TextGenerate.execute(**usable_kwargs)
                finally:
                    if restore_cycle_guard is not None:
                        restore_cycle_guard()
                official_seconds = time.perf_counter() - official_started
            finally:
                if server is not None:
                    if had_prompt_id:
                        setattr(server, "last_prompt_id", previous_prompt_id)
                    elif hasattr(server, "last_prompt_id"):
                        delattr(server, "last_prompt_id")
        return output, official_seconds

    try:
        official_output, official_seconds = execute_official(official_kwargs)
    except Exception as exc:
        raise RuntimeError(f"调用 ComfyUI 官方 TextGenerate 失败：{exc}") from exc

    def output_text(output: Any) -> str:
        result = getattr(output, "result", output)
        if isinstance(result, (tuple, list)):
            return str(result[0] if result else "")
        return str(result or "")

    raw_text = output_text(official_output)
    print(
        "[GJJ GemmaTextGenerate] 官方 TextGenerate 耗时: "
        f"total={official_seconds:.2f}s "
        f"thinking={thinking_enabled} "
        f"clip_type_call=official "
        f"raw_chars={len(raw_text)}",
        flush=True,
    )
    text = _strip_after_think_end(raw_text)
    if not thinking_enabled:
        text = _clean_no_think_output(text, effective_prompt)
    if not str(text or "").strip():
        recovered = _recover_generated_body(raw_text, effective_prompt)
        if recovered:
            print(
                "[GJJ GemmaTextGenerate] 清理结果为空，已从首次原始输出恢复正文，"
                f"recovered_chars={len(recovered)}。",
                flush=True,
            )
            return recovered
        _has_think_end = bool(re.search(r"</think\s*>", raw_text, flags=re.IGNORECASE))
        print(
            "[GJJ GemmaTextGenerate] 输出为空诊断: "
            f"raw_length={len(raw_text)} "
            f"has_think_end={_has_think_end} "
            f"official_output_type={type(official_output).__name__}",
            flush=True,
        )
        if raw_text.strip():
            raise RuntimeError("官方 TextGenerate 首次输出没有可恢复的最终正文。")
        raise RuntimeError("官方 TextGenerate 返回空内容，模型在生成首个正文 token 前提前结束。")
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


def _strip_after_think_end(text: str) -> str:
    cleaned = str(text or "")
    matches = list(re.finditer(r"</think\s*>", cleaned, flags=re.IGNORECASE))
    if matches:
        return cleaned[matches[-1].end():].lstrip()
    return cleaned


def _recover_generated_body(text: str, prompt: str = "") -> str:
    """Recover a structured final answer when an unclosed thinking tag hid valid output."""
    cleaned = str(text or "").replace("<|im_start|>", "").replace("<|im_end|>", "").strip()
    if not cleaned:
        return ""
    prompt_text = str(prompt or "").strip()
    if prompt_text and cleaned.startswith(prompt_text):
        cleaned = cleaned[len(prompt_text):].lstrip()
    final_markers = list(re.finditer(
        r"(?im)^\s*(?:最终答案|最终结果|最终输出|正文|提示词|final answer|final result|output)\s*[:：]\s*",
        cleaned,
    ))
    if final_markers:
        candidate = cleaned[final_markers[-1].end():].strip()
        if candidate:
            return candidate
    structured = re.search(
        r"(?im)^\s*(?:subject_definitions|integrated_multimodal_description|detailed_description)\s*:",
        cleaned,
    )
    if structured:
        return cleaned[structured.start():].strip()
    shot = re.search(r"(?i)\[Shot\s+1\]", cleaned)
    if shot:
        return cleaned[shot.start():].strip()
    return ""


def _clean_no_think_output(text: str, prompt: str = "") -> str:
    cleaned = _strip_after_think_end(text)
    cleaned = re.sub(r"<think\b[^>]*>.*?</think>", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"<think\b[^>]*>.*$", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"</?think\b[^>]*>", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"<thinking\b[^>]*>.*?</thinking>", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"<thinking\b[^>]*>.*$", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"</?thinking\b[^>]*>", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"<(?:analysis|reasoning|scratchpad)\b[^>]*>.*?</(?:analysis|reasoning|scratchpad)>", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"<(?:analysis|reasoning|scratchpad)\b[^>]*>.*$", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
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


def _is_audio_media(media: Any | None) -> bool:
    if media is None:
        return False
    if isinstance(media, dict):
        return "waveform" in media and ("sample_rate" in media or "sampling_rate" in media)
    return (
        getattr(media, "waveform", None) is not None
        and (
            getattr(media, "sample_rate", None) is not None
            or getattr(media, "sampling_rate", None) is not None
        )
    )

def _character_library_notes() -> dict[str, str]:
    if folder_paths is None:
        return {}
    root = Path(str(getattr(folder_paths, "models_dir", "") or "")) / "GJJ" / "character_library"
    if not root.is_dir():
        return {}
    result: dict[str, str] = {}
    for path in root.glob("*/manifest.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        name = re.sub(r"^\s*(?:♀️|♂️|♀|♂)\s*", "", str(data.get("name") or data.get("id") or path.parent.name)).strip()
        notes = re.sub(r"\s+", " ", str(data.get("notes") or "")).strip()
        for key in {name, str(data.get("id") or "").strip(), path.parent.name}:
            if key:
                result[key.casefold()] = notes
    return result


def _normalize_actor_name(value: Any) -> str:
    return re.sub(r"^\s*(?:♀️|♂️|♀|♂)\s*", "", str(value or "")).strip().lstrip("@")


def _scene_library_notes() -> dict[str, str]:
    if folder_paths is None:
        return {}
    root = Path(str(getattr(folder_paths, "models_dir", "") or "")) / "GJJ" / "scene_library"
    if not root.is_dir():
        return {}
    result: dict[str, str] = {}
    for path in root.glob("*/manifest.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        name = str(data.get("name") or data.get("id") or path.parent.name).strip().lstrip("@")
        notes = re.sub(r"\s+", " ", str(data.get("notes") or "")).strip()
        for key in {name, str(data.get("id") or "").strip(), path.parent.name}:
            if key:
                result[key.casefold()] = notes
    return result


def _inject_character_notes(prompt: str, selected_actors: Any = None) -> str:
    """把选中的角色名 + 备注隐性拼接到用户指令前面；不在原文中插入或替换 @名。

    返回值仅为最终发送给模型的 prompt，不再输出角色表。
    若选中角色为空，则原样返回 prompt。
    """
    user_text = str(prompt or "")
    actors = selected_actors if isinstance(selected_actors, list) else []
    names: list[str] = []
    seen: set[str] = set()
    for value in actors:
        name = _normalize_actor_name(value)
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        names.append(name)

    if not names:
        return user_text

    notes_by_name = _character_library_notes()
    actor_lines: list[str] = []
    for name in names:
        notes = notes_by_name.get(name.casefold(), "")
        actor_lines.append(f"@{name}{f'（{notes}）' if notes else ''}")

    actor_refs = "、".join(f"@{name}" for name in names)
    actor_block = "\n".join(actor_lines)
    preface = (
        "【参与演员参考】请参考以下人物描述和用户指令生成结果；"
        "所有牵涉到的角色必须用 @名字 形式表示，并让上述每一名演员明确参与并至少出现一次。"
        f"本次共有 {len(names)} 名演员：{actor_refs}。\n"
        f"{actor_block}\n"
        "人物括号内备注仅供理解角色外观，禁止在生成文本中单独输出人物表、角色备注或逐条复述这些备注。\n\n"
    )
    return f"{preface}{user_text}"


def _inject_scene_notes(prompt: str, selected_scenes: Any = None) -> str:
    user_text = str(prompt or "")
    names = list(dict.fromkeys(
        str(value or "").strip().lstrip("@")
        for value in (selected_scenes if isinstance(selected_scenes, list) else [])
        if str(value or "").strip().lstrip("@")
    ))
    if not names:
        return user_text
    notes_by_name = _scene_library_notes()
    scene_lines = [f"🏕️{name}{f'（{notes_by_name.get(name.casefold(), '')}）' if notes_by_name.get(name.casefold()) else ''}" for name in names]
    preface = (
        "【场景库参考】以下是本次引用的场景名称和备注。生成结果涉及这些地点时，"
        "必须按场景库引用方式使用 🏕️场景名，保持名称完全一致，不得另起近义名称；"
        "括号内备注只用于理解环境，不要单独输出场景资料表。\n"
        + "\n".join(scene_lines)
        + "\n\n"
    )
    return f"{preface}{user_text}"


class GJJ_GemmaTextGenerate:
    CATEGORY = "GJJ/🧠 图文推理"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = (
        NODE_DESCRIPTION
        if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
        else _ENVIRONMENT_REPORT.get("warning_message", NODE_DESCRIPTION)
    )
    SEARCH_ALIASES = ["TextGenerate", "Generate Text", "Gemma", "ideogram4", "文本生成", "加载CLIP"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("生成文本",)
    OUTPUT_TOOLTIPS = (
        "由内部加载的 Gemma/CLIP 文本生成模型生成的文本；角色库中选中的角色会按 @名字 形式隐性注入到用户指令之前，不在原文中插入名字。",
    )
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
        model_tree=[],
        models=[],
        usage=[
            "选择 CLIP 名称和类型后，直接填写提示词执行。",
            "可选连接统一媒体输入口：支持 IMAGE、GJJ_BATCH_IMAGE、官方 VIDEO 和 AUDIO，并按输入类型自动分流。",
            "默认 CLIP 类型 stable_diffusion，与 ComfyUI 系统 TextGenerate 搭配 Qwen3.5 时的加载方式一致。",
            "采样模式为 off 时会关闭随机采样，仅保留最大长度等基础参数。",
        ],
        runtime=[
            "内部等价于：CLIPLoader.load_clip(...) -> clip.tokenize(...) -> clip.generate(...) -> clip.decode(...)。",
            "VIDEO 会提取全部视频帧并压平为图片批次；灰度、RGBA、通道前置和常见高维张量会自动转换为 BHWC RGB 图片。",
            "AUDIO 保持 ComfyUI 原始音频对象，并通过 clip.tokenize(..., audio=audio) 交给模型处理。",
        ],
        model_download_url=MODEL_DOWNLOAD_URL,
        copy_text=MODEL_DOWNLOAD_URL,
        copy_label="🌏 复制模型下载地址",
        notice=_ENVIRONMENT_REPORT.get("warning_message", ""),
        extra={
            "static_model_tree_only": True,
            "model_tree_priority": "static",
        },
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
                    "display_name": "反推模型",
                    "tooltip": "列出名称匹配 qwen3.5、gemma4 或 qwen3vl 的反推模型，并按文件体积从小到大排序。",
                }),
                "clip_type": (CLIP_TYPES, {
                    "default": "stable_diffusion",
                    "display_name": "CLIP 类型",
                    "tooltip": "传给官方 CLIPLoader 的类型。Qwen3.5 参考系统 TextGenerate 使用 stable_diffusion，可正确应用 thinking=False 的系统模板。",
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
                    "default": 512,
                    "min": 1,
                    "max": 32768,
                    "step": 1,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "最大长度",
                    "tooltip": "限制本次输出最多生成多少 token。值越大越容易得到完整长文，但生成更慢、占用更多显存；过小可能截断正文或只留下思考段。",
                }),
                "sampling_mode": (["on", "off"], {
                    "default": "on",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "采样模式",
                    "tooltip": "开启时使用温度、Top K、Top P、Min P、惩罚和种子进行随机采样；关闭时采用确定性生成，并忽略这些随机采样参数。",
                }),
                "temperature": ("FLOAT", {
                    "default": 0.7,
                    "min": 0.01,
                    "max": 2.0,
                    "step": 0.000001,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "温度",
                    "tooltip": "控制随机程度。较低（约 0.2–0.7）更稳定、忠于指令；较高（约 0.8–1.2）更多样但更容易跑题。仅在随机采样开启时生效。",
                }),
                "top_k": ("INT", {
                    "default": 64,
                    "min": 0,
                    "max": 1000,
                    "step": 1,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "Top K",
                    "tooltip": "每一步只保留概率最高的 K 个候选 token。值小更保守稳定，值大更多样；0 表示不使用 Top K 限制。会与 Top P、Min P 共同过滤候选。",
                }),
                "top_p": ("FLOAT", {
                    "default": 0.95,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "Top P",
                    "tooltip": "按概率从高到低累加候选，累计达到该比例后截断。较低更集中稳定，接近 1.0 更多样；1.0 表示基本不使用 Top P 截断。",
                }),
                "min_p": ("FLOAT", {
                    "default": 0.05,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "最小概率",
                    "tooltip": "相对最高概率过滤候选：低于“最高概率 × Min P”的 token 会被排除。值越高越保守；0 表示关闭。通常 0.03–0.10，且会与 Top K、Top P 同时生效。",
                }),
                "repetition_penalty": ("FLOAT", {
                    "default": 1.05,
                    "min": 0.0,
                    "max": 5.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "重复惩罚",
                    "tooltip": "降低已经生成过的 token 再次出现的概率。1.0 不惩罚；略高于 1（如 1.05–1.15）可减少复读，过高可能破坏语句连贯性。",
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 0xFFFFFFFFFFFFFFFF,
                    "step": 1,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "种子",
                    "tooltip": "随机采样种子。设为 0 时每次执行自动使用新种子；非 0 时固定结果，便于复现。",
                }),
                "presence_penalty": ("STRING", {
                    "default": "0.0",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "出现惩罚",
                    "tooltip": "只要某个 token 已出现，就施加固定惩罚，鼓励引入新内容。0 表示关闭；值过高可能导致用词生硬或偏离主题。",
                }),
                "thinking": ("BOOLEAN", {
                    "default": False,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "思考模式",
                    "tooltip": "开启时允许模型输出推理过程；关闭时向模型明确禁用思考，并清除 thinking/analysis/reasoning 内容。清理结果为空时会从首次原始输出恢复正文，不重复推理。",
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
                    "default": True,
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
                "workflow_values_json": ("STRING", {
                    "default": "{}",
                    "multiline": False,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "前端参数存储",
                    "tooltip": "由 GJJ_GemmaTextGenerate 前端面板自动维护，不占用节点布局空间。",
                }),
                "model_filter_keywords": ("STRING", {
                    "default": MODEL_FILTER_EXPRESSION,
                    "multiline": False,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "反推模型关键词过滤",
                    "tooltip": "反推模型选择器的关键词过滤条件；随工作流保存。空格表示同时包含，| 表示任一包含。",
                }),
            },
            "optional": {
                "media": (MEDIA_INPUT_TYPE, {
                    "display_name": "媒体",
                    "tooltip": "统一输入口，支持 IMAGE、GJJ_BATCH_IMAGE、VIDEO、AUDIO；节点会按输入类型自动分流。",
                }),
                "external_prompt": ("STRING", {
                    "display_name": "指令 / 原文",
                    "forceInput": True,
                    "tooltip": "连接外部 STRING 后优先作为用户指令；未连接时使用节点内文本框。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **_kwargs):
        return True

    @classmethod
    def IS_CHANGED(cls, *args, sampling_mode: str = "on", seed: Any = 0, **kwargs):
        if str(sampling_mode or "on") == "on" and _coerce_int(seed, 0, 0, 0xFFFFFFFFFFFFFFFF) == 0:
            return float("NaN")
        return f"{sampling_mode}:{_coerce_int(seed, 0, 0, 0xFFFFFFFFFFFFFFFF)}"

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
        keep_model: bool = True,
        device_preference: str = "GPU优先",
        workflow_values_json: str = "{}",
        model_filter_keywords: str = MODEL_FILTER_EXPRESSION,
        external_prompt: Any = None,
        anti_loop: bool = False,
    ):
        received_thinking = thinking
        try:
            saved_values = json.loads(str(workflow_values_json or "{}"))
            if not isinstance(saved_values, dict):
                saved_values = {}
        except (TypeError, ValueError, json.JSONDecodeError):
            saved_values = {}
        thinking = saved_values.get("thinking", thinking)
        use_default_template = saved_values.get("use_default_template", use_default_template)
        sampling_mode = saved_values.get("sampling_mode", sampling_mode)
        thinking = _as_bool(thinking, False)
        use_default_template = _as_bool(use_default_template, True)
        if not thinking:
            # Qwen3.5/Qwen3VL 依靠默认聊天模板插入空思考通道来关闭推理。
            # skip_template=True 会绕过这段系统行为，因此关闭思考时必须保持模板开启。
            use_default_template = True
        print(
            "[GJJ GemmaTextGenerate] 执行状态: "
            f"received_thinking={received_thinking!r} "
            f"saved_thinking={saved_values.get('thinking', '<missing>')!r} "
            f"effective_thinking={thinking} "
            f"use_default_template={use_default_template}",
            flush=True,
        )
        clip_name = _resolve_available_clip_name(clip_name)
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
            
            audio_only = _is_audio_media(media) or (media is None and _is_audio_media(audio))
            if _is_audio_media(media):
                audio = media
                media_image = None
            else:
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
            clip, cache_hit = _load_clip_cached(str(clip_name), str(clip_type or "stable_diffusion"), effective_device, keep_loaded)
            load_time = time.time() - start_load
            print(
                f"[GJJ GemmaTextGenerate] CLIP 模型加载耗时: {load_time:.2f} 秒 | "
                f"model={_basename(clip_name)} clip_type={clip_type or 'stable_diffusion'} "
                f"device_preference={device_preference} effective_device={effective_device} "
                f"keep_model={keep_loaded} cache_hit={cache_hit}",
                flush=True,
            )
            
            start_gen = time.time()
            configured_seed = _coerce_int(seed, 0, 0, 0xFFFFFFFFFFFFFFFF)
            effective_seed = (
                secrets.randbits(64)
                if str(sampling_mode or "on") == "on" and configured_seed == 0
                else configured_seed
            )
            effective_user_prompt = prompt if external_prompt is None else str(external_prompt)
            # 选中的角色信息隐性注入到用户指令前面，原文不再插入 @名。
            injected_prompt = _inject_character_notes(
                effective_user_prompt,
                saved_values.get("selected_actors", []),
            )
            injected_prompt = _inject_scene_notes(
                injected_prompt,
                saved_values.get("selected_scenes", []),
            )
            text = _generate_text(
                clip,
                str(injected_prompt or "") if audio_only else _merged_generation_prompt(system_prompt, injected_prompt),
                _coerce_int(max_length, 512, 1, 32768),
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
                seed=effective_seed,
                presence_penalty=_coerce_float(presence_penalty, 0.0, 0.0, 5.0),
                add_output_rules=not audio_only,
                anti_loop=_as_bool(anti_loop, False),
            )
            if not str(text or "").strip():
                raise RuntimeError(
                    "官方 TextGenerate 首次输出没有可用正文。"
                    f"当前模型：{_basename(clip_name)}；CLIP 类型：{clip_type or 'stable_diffusion'}。"
                    "请确认模型文件与 CLIP 类型匹配，或改用已验证可工作的 Qwen3.5 文本编码器。"
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
            return {
                "ui": {
                    "gjj_gemma_result": [{
                        "text": str(text),
                        "model": os.path.splitext(_basename(clip_name))[0],
                        "elapsed": f"{total_time:.2f} 秒",
                        "model_size": _format_model_size(_find_text_encoder_path(clip_name)),
                    }],
                },
                "result": (text,),
            }
        except Exception as exc:
            report = getattr(exc, "gjj_report", None)
            if report:
                send_dependency_model_notice(report, unique_id=unique_id)
                raise RuntimeError(report.get("warning_message") or "运行环境缺失") from exc
            raise RuntimeError(f"Gemma 文本生成失败：{exc}") from exc


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_GemmaTextGenerate}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
