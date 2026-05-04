from __future__ import annotations

import base64
import io as bytes_io
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from typing import Any, List, Mapping

import torch
from PIL import Image

DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"
REQUEST_TIMEOUT = 90
MODEL_LIST_TIMEOUT = 8
DEFAULT_SYSTEM_PROMPT = "请根据输入图片或文字反推出适合 AI 绘图的高质量提示词，只输出正面提示词正文。"


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


def parse_model_size_billions(model_name: str) -> float:
    name = (model_name or "").strip().lower()
    if not name:
        return float("inf")

    matches = re.findall(r"(?:^|[:/\-_])(?:e)?(\d+(?:\.\d+)?)b(?:$|[:/\-_])", name)
    if not matches:
        return float("inf")

    try:
        return min(float(item) for item in matches)
    except ValueError:
        return float("inf")


def model_sort_key(model_name: str):
    size = parse_model_size_billions(model_name)
    return (size, str(model_name or "").lower())


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
