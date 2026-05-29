from __future__ import annotations

import gc
from pathlib import Path
from typing import Any, Iterable, Optional

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None

try:
    from .dependency_checker import (
        build_dependency_model_report,
        get_report_from_exception,
        make_missing_model_spec,
        send_dependency_model_notice,
    )
except ImportError:
    from dependency_checker import (
        build_dependency_model_report,
        get_report_from_exception,
        make_missing_model_spec,
        send_dependency_model_notice,
    )


DEFAULT_TRANSLATION_NODE_NAME = "GJJ 公共提示词翻译"
COMMON_PROMPT_TRANSLATE_API_PATH = "/gjj/common_prompt_translate"
LEGACY_CLIP_PROMPT_TRANSLATE_API_PATH = "/gjj/clip_prompt_translate"
TRANSLATION_MODEL_NAME = "opus-mt-zh-en"
TRANSLATION_MODEL_SUBDIR = f"models/translation/{TRANSLATION_MODEL_NAME}"
TRANSLATION_MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d"

TRANSLATION_DEPENDENCY_SPECS = (
    {
        "module_name": "transformers",
        "package_name": "transformers",
        "display_name": "transformers",
        "description": "用于加载 Opus-MT 中英翻译模型和分词器。",
    },
    {
        "module_name": "sentencepiece",
        "package_name": "sentencepiece",
        "display_name": "sentencepiece",
        "description": "Opus-MT / Marian 分词器需要的 SentencePiece 运行依赖。",
    },
)

_MODEL_CACHE: dict[str, tuple[Any, Any]] = {}


def translation_model_path() -> Path:
    if folder_paths is not None:
        try:
            return Path(folder_paths.models_dir) / "translation" / TRANSLATION_MODEL_NAME
        except Exception:
            pass
    return Path("models") / "translation" / TRANSLATION_MODEL_NAME


def translation_model_complete(path: Path | None = None) -> bool:
    model_path = Path(path) if path is not None else translation_model_path()
    if not model_path.is_dir():
        return False
    has_config = (model_path / "config.json").is_file()
    has_weight = any(
        (model_path / name).is_file()
        for name in ("pytorch_model.bin", "model.safetensors", "tf_model.h5")
    )
    has_source_tokenizer = any(
        (model_path / name).is_file()
        for name in ("source.spm", "tokenizer.json", "spiece.model")
    )
    has_target_tokenizer = any(
        (model_path / name).is_file()
        for name in ("target.spm", "tokenizer.json", "spiece.model")
    )
    return has_config and has_weight and has_source_tokenizer and has_target_tokenizer


def _module_available(module_name: str) -> bool:
    try:
        __import__(module_name)
        return True
    except Exception:
        return False


def missing_translation_dependencies() -> list[dict[str, str]]:
    return [
        dict(spec)
        for spec in TRANSLATION_DEPENDENCY_SPECS
        if not _module_available(spec["module_name"])
    ]


def missing_translation_models() -> list[dict[str, str]]:
    if translation_model_complete():
        return []
    return [
        make_missing_model_spec(
            label="Opus-MT 中英翻译模型",
            subdir=TRANSLATION_MODEL_SUBDIR,
            filename="config.json + pytorch_model.bin/model.safetensors + source.spm + target.spm",
            description="本地 Helsinki-NLP/opus-mt-zh-en 中英翻译模型文件。",
        )
    ]


def build_translation_environment_report(
    *,
    node_name: str = DEFAULT_TRANSLATION_NODE_NAME,
    description: str | None = None,
    original_error: str = "",
) -> dict[str, Any]:
    missing_dependencies = missing_translation_dependencies()
    return build_dependency_model_report(
        node_name=node_name,
        missing_dependencies=missing_dependencies,
        missing_models=missing_translation_models(),
        install_packages=[spec["package_name"] for spec in missing_dependencies],
        description=description
        or (
            "需要本地 Opus-MT 中英翻译模型；模型请放到 "
            f"{TRANSLATION_MODEL_SUBDIR}。"
        ),
        original_error=original_error,
        model_download_url=TRANSLATION_MODEL_DOWNLOAD_URL,
    )


def raise_translation_environment_error(
    report: dict[str, Any],
    *,
    unique_id: Any = None,
) -> None:
    send_dependency_model_notice(report, unique_id=unique_id)
    error = RuntimeError(report.get("warning_message") or "翻译环境缺失")
    setattr(error, "gjj_report", report)
    raise error


def ensure_translation_environment(
    *,
    unique_id: Any = None,
    node_name: str = DEFAULT_TRANSLATION_NODE_NAME,
) -> dict[str, Any]:
    report = build_translation_environment_report(node_name=node_name)
    if not report.get("available", True):
        raise_translation_environment_error(report, unique_id=unique_id)
    return report


def pick_translation_device(device: str = "auto") -> Any:
    import torch

    choice = str(device or "auto").lower()
    if choice == "cpu":
        return torch.device("cpu")
    if choice == "gpu":
        if not torch.cuda.is_available():
            raise RuntimeError("GPU 不可用，请选择 CPU 或 auto")
        return torch.device("cuda")
    try:
        import comfy.model_management

        return comfy.model_management.get_torch_device()
    except Exception:
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    return text in {"1", "true", "yes", "on", "开启", "启用", "开"}


def split_chinese_quote_segments(text: str) -> list[tuple[str, bool]]:
    segments: list[tuple[str, bool]] = []
    buffer: list[str] = []
    protected = False

    for char in str(text or ""):
        if char == "“":
            if buffer:
                segments.append(("".join(buffer), protected))
                buffer = []
            protected = True
            buffer.append(char)
            continue
        if char == "”" and protected:
            buffer.append(char)
            segments.append(("".join(buffer), True))
            buffer = []
            protected = False
            continue
        buffer.append(char)

    if buffer:
        segments.append(("".join(buffer), protected))
    return segments


def _load_model_and_tokenizer(device: Any) -> tuple[Any, Any]:
    cache_key = str(device)
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]

    try:
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
    except Exception as exc:
        report = build_translation_environment_report(original_error=str(exc))
        raise_translation_environment_error(report)

    model_path = translation_model_path()
    try:
        tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
        model = AutoModelForSeq2SeqLM.from_pretrained(model_path, local_files_only=True)
        model.to(device)
        model.eval()
    except Exception as exc:
        report = build_translation_environment_report(
            original_error=f"加载 {TRANSLATION_MODEL_NAME} 模型失败：{exc}"
        )
        raise_translation_environment_error(report)

    _MODEL_CACHE[cache_key] = (model, tokenizer)
    return model, tokenizer


def translate_plain_text(
    text: str,
    torch_device: Any,
    *,
    max_length: int = 512,
    batch_size: int = 8,
) -> str:
    if not str(text or "").strip():
        return ""

    import torch

    model, tokenizer = _load_model_and_tokenizer(torch_device)
    try:
        sentences = [item.strip() for item in str(text or "").split("\n") if item.strip()]
        translated_sentences: list[str] = []
        for index in range(0, len(sentences), int(batch_size)):
            batch = sentences[index : index + int(batch_size)]
            inputs = tokenizer(
                batch,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=int(max_length),
            ).to(torch_device)
            with torch.no_grad():
                outputs = model.generate(
                    **inputs,
                    max_length=int(max_length),
                    num_beams=4,
                    early_stopping=True,
                )
            translated_sentences.extend(tokenizer.batch_decode(outputs, skip_special_tokens=True))
        return "\n".join(translated_sentences)
    except Exception as exc:
        raise RuntimeError(f"翻译过程中发生错误：{exc}") from exc


def translate_unprotected_text(
    text: str,
    torch_device: Any,
    *,
    max_length: int = 512,
    batch_size: int = 8,
    preserve_chinese_quotes: bool = True,
) -> str:
    if not str(text or "").strip():
        return str(text or "")

    segments = (
        split_chinese_quote_segments(str(text or ""))
        if preserve_chinese_quotes
        else [(str(text or ""), False)]
    )
    pieces: list[str] = []
    for segment, protected in segments:
        if protected or not segment.strip():
            pieces.append(segment)
            continue

        leading_len = len(segment) - len(segment.lstrip())
        trailing_len = len(segment) - len(segment.rstrip())
        leading = segment[:leading_len]
        trailing = segment[len(segment) - trailing_len :] if trailing_len else ""
        core = segment.strip()
        translated = translate_plain_text(
            core,
            torch_device,
            max_length=max_length,
            batch_size=batch_size,
        )
        pieces.append(f"{leading}{translated}{trailing}")
    return "".join(pieces)


def translate_zh_to_en(
    text: str,
    device: str = "auto",
    *,
    max_length: int = 512,
    batch_size: int = 8,
    unload_after_use: bool = False,
    unique_id: Any = None,
    node_name: str = DEFAULT_TRANSLATION_NODE_NAME,
    preserve_chinese_quotes: bool = True,
) -> str:
    if not str(text or "").strip():
        return ""
    ensure_translation_environment(unique_id=unique_id, node_name=node_name)
    torch_device = pick_translation_device(device)
    result = translate_unprotected_text(
        str(text or ""),
        torch_device,
        max_length=max_length,
        batch_size=batch_size,
        preserve_chinese_quotes=preserve_chinese_quotes,
    )
    if unload_after_use:
        unload_translation_model()
    return result


def translate_prompt_pair(
    *,
    positive: str = "",
    negative: str = "",
    device: str = "auto",
    max_length: int = 512,
    batch_size: int = 8,
    unload_after_use: bool = False,
    unique_id: Any = None,
    node_name: str = DEFAULT_TRANSLATION_NODE_NAME,
) -> dict[str, str]:
    positive_text = str(positive or "")
    negative_text = str(negative or "")
    return {
        "positive": translate_zh_to_en(
            positive_text,
            device,
            max_length=max_length,
            batch_size=batch_size,
            unload_after_use=unload_after_use and not negative_text.strip(),
            unique_id=unique_id,
            node_name=node_name,
        ),
        "negative": translate_zh_to_en(
            negative_text,
            device,
            max_length=max_length,
            batch_size=batch_size,
            unload_after_use=unload_after_use,
            unique_id=unique_id,
            node_name=node_name,
        ),
    }


def unload_translation_model() -> None:
    _MODEL_CACHE.clear()
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def send_translated_prompt(
    unique_id: Any,
    *,
    positive: Optional[str] = None,
    negative: Optional[str] = None,
    event_name: str = "gjj_common_prompt_translated",
) -> None:
    if not unique_id or PromptServer is None or getattr(PromptServer, "instance", None) is None:
        return
    payload = {"node": str(unique_id)}
    if positive is not None:
        payload["positive"] = str(positive)
    if negative is not None:
        payload["negative"] = str(negative)
    try:
        PromptServer.instance.send_sync(event_name, payload)
    except Exception:
        pass


async def prompt_translate_api_handler(request):
    unique_id = None
    try:
        from aiohttp import web

        data = await request.json()
        unique_id = data.get("node", None) or data.get("unique_id", None)
        positive = str(data.get("positive", "") or "")
        negative = str(data.get("negative", "") or "")
        text = str(data.get("text", "") or "")
        device = str(data.get("device", "auto") or "auto")
        max_length = int(data.get("max_length", 512) or 512)
        batch_size = int(data.get("batch_size", 8) or 8)
        unload_after_use = as_bool(data.get("unload_after_use", False))
        node_name = str(data.get("node_name", "") or DEFAULT_TRANSLATION_NODE_NAME)

        if text and not positive and not negative:
            result_text = translate_zh_to_en(
                text,
                device,
                max_length=max_length,
                batch_size=batch_size,
                unload_after_use=unload_after_use,
                unique_id=unique_id,
                node_name=node_name,
            )
            return web.json_response({"ok": True, "text": result_text})

        result = translate_prompt_pair(
            positive=positive,
            negative=negative,
            device=device,
            max_length=max_length,
            batch_size=batch_size,
            unload_after_use=unload_after_use,
            unique_id=unique_id,
            node_name=node_name,
        )
        return web.json_response({"ok": True, **result})
    except Exception as exc:
        from aiohttp import web

        report = get_report_from_exception(exc)
        if report:
            send_dependency_model_notice(report, unique_id=unique_id)
            return web.json_response(
                {
                    "ok": False,
                    "error": report.get("warning_message", str(exc)),
                    "report": report,
                },
                status=500,
            )
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


def register_prompt_translation_api(paths: Iterable[str] | None = None) -> None:
    if PromptServer is None or getattr(PromptServer, "instance", None) is None:
        return
    server = PromptServer.instance
    for path in paths or (COMMON_PROMPT_TRANSLATE_API_PATH,):
        key = "_gjj_prompt_translation_api_" + str(path).replace("/", "_")
        if getattr(server, key, False):
            continue
        server.routes.post(str(path))(prompt_translate_api_handler)
        setattr(server, key, True)


__all__ = [
    "COMMON_PROMPT_TRANSLATE_API_PATH",
    "DEFAULT_TRANSLATION_NODE_NAME",
    "LEGACY_CLIP_PROMPT_TRANSLATE_API_PATH",
    "TRANSLATION_DEPENDENCY_SPECS",
    "TRANSLATION_MODEL_DOWNLOAD_URL",
    "TRANSLATION_MODEL_NAME",
    "TRANSLATION_MODEL_SUBDIR",
    "as_bool",
    "build_translation_environment_report",
    "ensure_translation_environment",
    "missing_translation_dependencies",
    "missing_translation_models",
    "pick_translation_device",
    "prompt_translate_api_handler",
    "raise_translation_environment_error",
    "register_prompt_translation_api",
    "send_translated_prompt",
    "split_chinese_quote_segments",
    "translate_plain_text",
    "translate_prompt_pair",
    "translate_unprotected_text",
    "translate_zh_to_en",
    "translation_model_complete",
    "translation_model_path",
    "unload_translation_model",
]
