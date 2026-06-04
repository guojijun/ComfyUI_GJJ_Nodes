from __future__ import annotations

import base64
import io as bytes_io
import json
import math
import os
import re
from collections.abc import Mapping
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from typing import Any, List

import torch
from PIL import Image

DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"
REQUEST_TIMEOUT = 90
MODEL_LIST_TIMEOUT = 8
DEFAULT_SYSTEM_PROMPT = "请根据输入图片或文字反推出适合 AI 绘图的高质量提示词，只输出正面提示词正文。"
DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE = "只输出结果文字，不输出解释、分析过程、标题、Markdown 代码块或提示性前缀。台词用中文双引号包裹。"
DEFAULT_OLLAMA_ASSISTANT_SAMPLING = {
    "temperature": 0.7,
    "max_tokens": 1024,
    "seed_mode": "每次随机",
    "seed": 0,
    "top_k": 80,
    "top_p": 0.95,
    "min_p": 0.03,
    "presence_penalty": 0.3,
    "frequency_penalty": 0.2,
    "repeat_penalty": 1.15,
}
DEFAULT_OLLAMA_ASSISTANT_TEMPLATES = [
    {
        "title": "🧡反推",
        "prompt": "准确识别参考图片中的主体、人物外貌、服装、动作、场景结构、镜头构图、光线、色调、材质和关键细节，整理为可直接用于图像或视频生成的连贯画面描述。",
    },
    {
        "title": "🎬分镜",
        "prompt": "基于参考图片或输入描述生成连续四宫格分镜内容，保持人物身份、核心服装、场景和整体色调一致，同时推动镜头、构图、动作、表情与环境变化，使相邻画面自然衔接且具有叙事进展。",
    },
    {
        "title": "🌏翻译",
        "prompt": "将输入内容精准翻译为英文，保持原有语序结构、提示词权重符号、专有名词和画面语义；使用适合 AI 图像与视频生成的自然英文表达。",
    },
    {
        "title": "👕变装",
        "prompt": "给我 9 组图片的提示词，胸部以上特写，让主角留不同的发型，带不同的配饰，穿不同的服装，在中国不同5A景区的门口，天空地面都有描述，正对着镜头往前走，只保留上半身特效。写实风格。只给中文提示词。然后根据以上提示词，给我按顺序每两张图片写一组变装的视频提示词，如图 1 到图 2 写一组变装的视频提示词，图 2 到图 3 写一组变装的视频提示词，最后一张图变装到第一张图，要求有变化的细节。图片提示词和视频提示词分别在不同的列。提示词只用中文描述。每组一行，格式：序号||生成图片提示词||变装提示词(每组一行，两个||之间不要换行)",
    },
    {
        "title": "🎬故事",
        "prompt": "根据故事，生成动漫视频的分镜关键帧提示词和视频提示词。要求，首先生成分镜关键帧的图片的提示词，然后根据分镜关键帧生成视频主体动作和运镜的提示词；针对每个分镜要求有帮白或者主角的台词，台词标准旁白，或者男主角，或者女主角，每个分镜时长 5 秒左右。格式：序号||关键帧提示词||视频提示词||旁白或者主角的台词(每组一行，两个||之间不要换行)",
    },
]


def ollama_assistant_templates_to_text(templates: Any) -> str:
    blocks: list[str] = []
    source = templates if isinstance(templates, list) else DEFAULT_OLLAMA_ASSISTANT_TEMPLATES
    for index, item in enumerate(source, start=1):
        if not isinstance(item, Mapping):
            continue
        title = str(item.get("title") or item.get("label") or f"模板{index}").strip()
        prompt = str(item.get("prompt") or item.get("text") or "").strip()
        if title and prompt:
            blocks.append(f"【{title}】{prompt}")
    if not blocks and source is not DEFAULT_OLLAMA_ASSISTANT_TEMPLATES:
        return ollama_assistant_templates_to_text(DEFAULT_OLLAMA_ASSISTANT_TEMPLATES)
    return "\n\n".join(blocks)


def default_ollama_assistant_system_prompt() -> str:
    first_prompt = DEFAULT_OLLAMA_ASSISTANT_TEMPLATES[0]["prompt"]
    return f"{first_prompt}\n{DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE}"


DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT_TEMPLATES = ollama_assistant_templates_to_text(DEFAULT_OLLAMA_ASSISTANT_TEMPLATES)
DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT = default_ollama_assistant_system_prompt()


def ollama_assistant_default_settings() -> dict[str, Any]:
    return {
        "version": 1,
        "templates": [dict(item) for item in DEFAULT_OLLAMA_ASSISTANT_TEMPLATES],
        "system_prompt_output_rule": DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE,
        "sampling": dict(DEFAULT_OLLAMA_ASSISTANT_SAMPLING),
    }


def _gjj_user_settings_path() -> Path:
    return Path(__file__).resolve().parents[1] / "presets" / "gjj_user_settings.json"


def _bounded_float(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(result):
        return fallback
    return max(minimum, min(maximum, result))


def _bounded_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        result = int(float(value))
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, result))


def normalize_ollama_assistant_sampling(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, Mapping) else {}
    defaults = DEFAULT_OLLAMA_ASSISTANT_SAMPLING
    seed_mode = str(source.get("seed_mode") or defaults["seed_mode"]).strip()
    if seed_mode not in {"每次随机", "固定种子"}:
        seed_mode = defaults["seed_mode"]
    return {
        "temperature": _bounded_float(source.get("temperature"), defaults["temperature"], 0.0, 2.0),
        "max_tokens": _bounded_int(source.get("max_tokens"), defaults["max_tokens"], 16, 8192),
        "seed_mode": seed_mode,
        "seed": _bounded_int(source.get("seed"), defaults["seed"], 0, 2147483647),
        "top_k": _bounded_int(source.get("top_k"), defaults["top_k"], 1, 1000),
        "top_p": _bounded_float(source.get("top_p"), defaults["top_p"], 0.0, 1.0),
        "min_p": _bounded_float(source.get("min_p"), defaults["min_p"], 0.0, 1.0),
        "presence_penalty": _bounded_float(source.get("presence_penalty"), defaults["presence_penalty"], -2.0, 2.0),
        "frequency_penalty": _bounded_float(source.get("frequency_penalty"), defaults["frequency_penalty"], -2.0, 2.0),
        "repeat_penalty": _bounded_float(source.get("repeat_penalty"), defaults["repeat_penalty"], 0.0, 3.0),
    }


def read_ollama_assistant_settings() -> dict[str, Any]:
    defaults = ollama_assistant_default_settings()
    path = _gjj_user_settings_path()
    if not path.is_file():
        return defaults
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return defaults
    section = data.get("ollama_assistant") if isinstance(data, dict) else {}
    if not isinstance(section, dict):
        return defaults

    settings = dict(defaults)
    raw_templates = section.get("system_prompt_templates")
    if isinstance(raw_templates, str) and raw_templates.strip():
        settings["system_prompt_templates"] = raw_templates.strip()

    templates = section.get("templates")
    if isinstance(templates, list) and templates:
        settings["templates"] = [
            {
                "title": str(item.get("title") or item.get("label") or "").strip(),
                "prompt": str(item.get("prompt") or item.get("text") or "").strip(),
            }
            for item in templates
            if isinstance(item, Mapping)
            and str(item.get("title") or item.get("label") or "").strip()
            and str(item.get("prompt") or item.get("text") or "").strip()
        ] or defaults["templates"]

    output_rule = str(section.get("system_prompt_output_rule") or "").strip()
    if output_rule:
        settings["system_prompt_output_rule"] = output_rule
    settings["sampling"] = normalize_ollama_assistant_sampling(section.get("sampling"))
    return settings


def ollama_assistant_system_prompt_templates() -> str:
    settings = read_ollama_assistant_settings()
    raw_text = settings.get("system_prompt_templates")
    if isinstance(raw_text, str) and raw_text.strip():
        return raw_text.strip()
    return ollama_assistant_templates_to_text(settings.get("templates"))


def ollama_assistant_output_rule() -> str:
    return str(
        read_ollama_assistant_settings().get("system_prompt_output_rule")
        or DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE
    ).strip()


def ollama_assistant_system_prompt() -> str:
    templates = read_ollama_assistant_settings().get("templates")
    first_prompt = ""
    if isinstance(templates, list) and templates:
        first = templates[0]
        if isinstance(first, Mapping):
            first_prompt = str(first.get("prompt") or first.get("text") or "").strip()
    if not first_prompt:
        first_prompt = DEFAULT_OLLAMA_ASSISTANT_TEMPLATES[0]["prompt"]
    return "\n".join(part for part in [first_prompt, ollama_assistant_output_rule()] if part)


def ollama_assistant_sampling_settings() -> dict[str, Any]:
    return normalize_ollama_assistant_sampling(read_ollama_assistant_settings().get("sampling"))


def normalize_ollama_host(raw_host: str | None) -> str:
    host = (raw_host or "").strip()
    if not host:
        return DEFAULT_OLLAMA_HOST
    if host.endswith("/"):
        host = host.rstrip("/")
    if host.endswith("/api"):
        host = host[:-4]
    if not host.startswith(("http://", "https://")):
        host = f"http://{host}"

    parsed = urlparse(host)
    scheme = parsed.scheme or "http"
    hostname = (parsed.hostname or "").strip().lower()
    port = parsed.port

    if hostname in {"", "0.0.0.0", "::", "[::]"}:
        hostname = "127.0.0.1"
    if port is None:
        port = 11434
    return f"{scheme}://{hostname}:{port}"


def compose_ollama_host(raw_host: str | None, port: int | str | None = None) -> str:
    host = normalize_ollama_host(raw_host)
    if port in (None, "", 0, "0"):
        return host

    parsed = urlparse(host)
    scheme = parsed.scheme or "http"
    hostname = (parsed.hostname or "127.0.0.1").strip().lower()
    if hostname in {"", "0.0.0.0", "::", "[::]"}:
        hostname = "127.0.0.1"

    try:
        resolved_port = int(port)
    except (TypeError, ValueError):
        resolved_port = parsed.port or 11434
    if resolved_port <= 0:
        resolved_port = parsed.port or 11434
    return f"{scheme}://{hostname}:{resolved_port}"


def value_get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, Mapping):
        return obj.get(key, default)
    return getattr(obj, key, default)


def request_json(
    method: str,
    path: str,
    payload: Mapping[str, Any] | None = None,
    timeout: int = REQUEST_TIMEOUT,
    host: str | None = None,
) -> Mapping[str, Any]:
    last_error: Exception | None = None
    tried_urls: List[str] = []
    if host:
        candidate_bases = [normalize_ollama_host(host)]
    else:
        candidate_bases = [normalize_ollama_host(os.environ.get("OLLAMA_HOST")), DEFAULT_OLLAMA_HOST]

    for base in candidate_bases:
        if base in tried_urls:
            continue
        tried_urls.append(base)

        url = f"{base}{path if path.startswith('/') else f'/{path}'}"
        data = None
        headers = {"Content-Type": "application/json"}
        if payload is not None:
            data = json.dumps(dict(payload)).encode("utf-8")

        request = Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise RuntimeError(f"Ollama 返回了非对象响应：{parsed!r}")
            return parsed
        except Exception as exc:
            last_error = exc

    raise RuntimeError(f"Ollama 请求失败：{last_error}") from last_error


def list_ollama_models(host: str | None = None) -> List[str]:
    try:
        data = request_json("GET", "/api/tags", timeout=MODEL_LIST_TIMEOUT, host=host)
    except Exception:
        return []

    models = value_get(data, "models", []) or []

    names: List[str] = []
    for item in models:
        name = str(value_get(item, "name") or value_get(item, "model") or "").strip()
        if name and name not in names:
            names.append(name)
    return sorted(names, key=model_sort_key)


def model_sort_key(model_name: str):
    text = str(model_name or "").strip()
    return (len(text), text.lower())


def resolve_model(model: str, host: str | None = None) -> str:
    chosen = (model or "").strip()
    if chosen:
        return chosen

    models = list_ollama_models(host=host)
    if models:
        return models[0]

    raise RuntimeError(
        "未连接到 Ollama 或未发现可用模型。\n"
        "请先启动 Ollama，并确认 http://127.0.0.1:11434/api/tags 能返回模型列表。"
    )


def unload_model(model: str, host: str | None = None) -> Mapping[str, Any]:
    return request_json(
        "POST",
        "/api/generate",
        payload={
            "model": resolve_model(model, host=host),
            "keep_alive": 0,
            "stream": False,
        },
        timeout=MODEL_LIST_TIMEOUT,
        host=host,
    )


def extract_chat_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
                continue
            if isinstance(item, dict) or hasattr(item, "type"):
                item_type = str(value_get(item, "type") or "").strip().lower()
                if item_type in {"thinking", "thought", "reasoning"}:
                    continue
                text = value_get(item, "text")
                if text:
                    parts.append(str(text))
        return "\n".join(part for part in parts if part)
    return str(content or "")


def strip_thinking_markup(text: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        return ""

    patterns = [
        r"^\s*<think>.*?</think>\s*",
        r"^\s*<thinking>.*?</thinking>\s*",
    ]
    for pattern in patterns:
        cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE | re.DOTALL).strip()
    return cleaned


def extract_final_answer(response: Mapping[str, Any]) -> str:
    message = value_get(response, "message", {})
    candidates: List[str] = []
    if message:
        candidates.append(extract_chat_text(value_get(message, "content")))
    candidates.append(extract_chat_text(value_get(response, "response")))

    for candidate in candidates:
        final_text = strip_thinking_markup(candidate)
        if final_text:
            return final_text
    return ""


def request_chat(
    payload: Mapping[str, Any],
    error_label: str = "Ollama 请求",
    host: str | None = None,
    timeout: int = REQUEST_TIMEOUT,
) -> Mapping[str, Any]:
    try:
        return request_json("POST", "/api/chat", payload=payload, host=host, timeout=timeout)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore") if hasattr(exc, "read") else str(exc)
        raise RuntimeError(f"{error_label}失败：{body}") from exc
    except URLError as exc:
        raise RuntimeError(f"无法连接到 Ollama：{exc}") from exc
    except Exception as exc:
        message = str(exc or "").strip()
        if "timed out" in message.lower():
            raise RuntimeError(
                f"{error_label}失败：等待本机 Ollama 返回结果超时（{int(timeout)} 秒）。\n"
                "可以稍后重试，或改用更小的多模态模型、降低最大生成长度。"
            ) from exc
        raise RuntimeError(f"{error_label}失败：{exc}") from exc


def tensor_to_png_base64(image: torch.Tensor) -> str:
    tensor = image
    if tensor.ndim == 4:
        tensor = tensor[0]
    if tensor.ndim != 3:
        raise ValueError(f"不支持的图片形状: {tuple(tensor.shape)}")

    tensor = tensor.detach().cpu()
    if tensor.dtype != torch.uint8:
        tensor = (tensor.clamp(0.0, 1.0) * 255.0).to(torch.uint8)

    np_image = tensor.numpy()
    if np_image.shape[-1] == 1:
        np_image = np_image.repeat(3, axis=-1)
    elif np_image.shape[-1] == 4:
        np_image = np_image[..., :3]
    elif np_image.shape[-1] != 3:
        raise ValueError(f"不支持的通道数: {np_image.shape[-1]}")

    pil_image = Image.fromarray(np_image, mode="RGB")
    buffer = bytes_io.BytesIO()
    pil_image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def model_options_with_fallback(host: str | None = None) -> List[str]:
    models = list_ollama_models(host=host)
    return models if models else [""]


def send_ollama_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if not unique_id:
        return

    payload: dict[str, Any] = {
        "node": str(unique_id),
        "text": str(text or ""),
    }
    if progress is not None:
        try:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        except (TypeError, ValueError):
            pass

    try:
        from server import PromptServer
    except Exception:
        return

    try:
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        try:
            PromptServer.instance.send_progress_text(payload["text"], unique_id)
        except Exception:
            pass
