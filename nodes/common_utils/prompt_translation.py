from __future__ import annotations

import base64
import gc
import hashlib
import json
import os
import shutil
from pathlib import Path, PurePosixPath
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
        DEFAULT_MODEL_URL,
        build_dependency_model_report,
        get_report_from_exception,
        make_missing_model_spec,
        send_dependency_model_notice,
    )
except ImportError:
    from dependency_checker import (
        DEFAULT_MODEL_URL,
        build_dependency_model_report,
        get_report_from_exception,
        make_missing_model_spec,
        send_dependency_model_notice,
    )


DEFAULT_TRANSLATION_NODE_NAME = "GJJ 公共提示词翻译"
COMMON_PROMPT_TRANSLATE_API_PATH = "/gjj/common_prompt_translate"
LEGACY_CLIP_PROMPT_TRANSLATE_API_PATH = "/gjj/clip_prompt_translate"
TRANSLATION_MODEL_NAME = "opus-mt-zh-en"
TRANSLATION_MODEL_SUBDIR = "models/translation"
TRANSLATION_LEGACY_MODEL_SUBDIR = f"{TRANSLATION_MODEL_SUBDIR}/{TRANSLATION_MODEL_NAME}"
TRANSLATION_BUNDLE_FILENAME = f"{TRANSLATION_MODEL_NAME}.safetensors"
TRANSLATION_BUNDLE_RELATIVE_PATH = f"{TRANSLATION_MODEL_SUBDIR}/{TRANSLATION_BUNDLE_FILENAME}"
TRANSLATION_MODEL_DOWNLOAD_URL = DEFAULT_MODEL_URL

TRANSLATION_BUNDLE_SCHEMA = "gjj.prompt_translation.bundle.v1"
_BUNDLE_SCHEMA_KEY = "gjj_bundle_schema"
_BUNDLE_MODEL_KEY = "gjj_bundle_model"
_BUNDLE_FILES_KEY = "gjj_bundle_files"
_BUNDLE_FILE_KEY_PREFIX = "gjj_bundle_file:"
_BUNDLE_CACHE_DIRNAME = ".gjj_translation_bundle_cache"
_BUNDLE_REQUIRED_FILES = ("config.json", "source.spm", "target.spm")
_BUNDLE_WEIGHT_FILENAMES = {
    "model.safetensors",
    "pytorch_model.bin",
    "rust_model.ot",
    "tf_model.h5",
    "flax_model.msgpack",
}

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
_SAFETENSORS_DEPENDENCY_SPEC = {
    "module_name": "safetensors",
    "package_name": "safetensors",
    "display_name": "safetensors",
    "description": "用于读取 GJJ 单文件翻译模型包。",
}

_MODEL_CACHE: dict[str, tuple[Any, Any]] = {}


def _translation_models_root() -> Path:
    if folder_paths is not None:
        try:
            return Path(folder_paths.models_dir) / "translation"
        except Exception:
            pass
    return Path("models") / "translation"


def translation_legacy_model_path() -> Path:
    return _translation_models_root() / TRANSLATION_MODEL_NAME


def _translation_bundle_candidates() -> list[Path]:
    root = _translation_models_root()
    legacy = root / TRANSLATION_MODEL_NAME
    return [
        root / TRANSLATION_BUNDLE_FILENAME,
        legacy / TRANSLATION_BUNDLE_FILENAME,
    ]


def translation_safetensors_bundle_path(path: Path | str | None = None) -> Path | None:
    if path is not None:
        candidate = Path(path)
        return candidate if candidate.is_file() else None
    for candidate in _translation_bundle_candidates():
        if candidate.is_file():
            return candidate
    return None


def _read_safetensors_bundle_header(path: Path) -> tuple[dict[str, str], list[str]]:
    from safetensors import safe_open

    with safe_open(str(path), framework="pt", device="cpu") as handle:
        metadata = dict(handle.metadata() or {})
        tensor_names = list(handle.keys())
    return metadata, tensor_names


def _normalize_bundle_relpath(value: Any) -> str:
    text = str(value or "").replace("\\", "/").strip("/")
    posix = PurePosixPath(text)
    if not text or posix.is_absolute() or any(part in {"", ".", ".."} for part in posix.parts):
        raise ValueError(f"非法的翻译模型包内路径：{value}")
    return posix.as_posix()


def _bundle_metadata_files(metadata: dict[str, str]) -> list[str]:
    files: list[str] = []
    raw_files = metadata.get(_BUNDLE_FILES_KEY, "")
    if raw_files:
        try:
            loaded = json.loads(raw_files)
            if isinstance(loaded, list):
                files.extend(str(item) for item in loaded)
        except Exception:
            pass
    for key in metadata:
        if key.startswith(_BUNDLE_FILE_KEY_PREFIX):
            files.append(key[len(_BUNDLE_FILE_KEY_PREFIX) :])

    result: list[str] = []
    seen: set[str] = set()
    for item in files:
        try:
            relpath = _normalize_bundle_relpath(item)
        except Exception:
            continue
        if relpath not in seen:
            seen.add(relpath)
            result.append(relpath)
    return result


def translation_safetensors_bundle_complete(path: Path | str | None = None) -> bool:
    bundle_path = translation_safetensors_bundle_path(path)
    if bundle_path is None:
        return False
    try:
        metadata, tensor_names = _read_safetensors_bundle_header(bundle_path)
    except Exception:
        return False
    if metadata.get(_BUNDLE_SCHEMA_KEY) != TRANSLATION_BUNDLE_SCHEMA:
        return False
    if metadata.get(_BUNDLE_MODEL_KEY) not in {"", None, TRANSLATION_MODEL_NAME}:
        return False
    files = set(_bundle_metadata_files(metadata))
    return bool(tensor_names) and all(name in files for name in _BUNDLE_REQUIRED_FILES)


def _translation_legacy_model_complete(path: Path | None = None) -> bool:
    model_path = Path(path) if path is not None else translation_legacy_model_path()
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


def translation_model_complete(path: Path | str | None = None) -> bool:
    if path is not None:
        candidate = Path(path)
        if candidate.is_file() and candidate.suffix.lower() == ".safetensors":
            return translation_safetensors_bundle_complete(candidate)
        return _translation_legacy_model_complete(candidate)
    return translation_safetensors_bundle_complete() or _translation_legacy_model_complete()


def _bundle_cache_path(bundle_path: Path) -> Path:
    stat = bundle_path.stat()
    source = str(bundle_path.resolve())
    digest = hashlib.sha256(f"{source}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8")).hexdigest()[:16]
    return bundle_path.parent / _BUNDLE_CACHE_DIRNAME / f"{TRANSLATION_MODEL_NAME}-{digest}"


def _decode_bundle_metadata_file(metadata: dict[str, str], relpath: str) -> bytes:
    raw = metadata.get(_BUNDLE_FILE_KEY_PREFIX + relpath)
    if raw is None:
        raise RuntimeError(f"翻译模型包缺少内置文件：{relpath}")
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {"encoding": "base64", "data": raw}
    if not isinstance(payload, dict):
        raise RuntimeError(f"翻译模型包内置文件格式无效：{relpath}")

    encoding = str(payload.get("encoding") or "base64").lower()
    data = str(payload.get("data") or "")
    if encoding == "base64":
        content = base64.b64decode(data.encode("ascii"))
    elif encoding in {"utf8", "utf-8", "text"}:
        content = data.encode("utf-8")
    else:
        raise RuntimeError(f"翻译模型包不支持的内置文件编码：{relpath} ({encoding})")

    expected_sha = str(payload.get("sha256") or "").strip().lower()
    if expected_sha:
        actual_sha = hashlib.sha256(content).hexdigest()
        if actual_sha != expected_sha:
            raise RuntimeError(f"翻译模型包内置文件校验失败：{relpath}")
    return content


def _link_or_copy_bundle_weight(bundle_path: Path, target_path: Path) -> None:
    if target_path.exists():
        return
    target_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(str(bundle_path), str(target_path))
        return
    except Exception:
        pass
    try:
        os.symlink(str(bundle_path), str(target_path))
        return
    except Exception:
        pass
    shutil.copy2(str(bundle_path), str(target_path))


def prepare_translation_safetensors_model(path: Path | str | None = None) -> Path:
    """Extract the GJJ one-file Opus-MT bundle into a HF-compatible cache dir."""
    bundle_path = translation_safetensors_bundle_path(path)
    if bundle_path is None:
        raise FileNotFoundError(f"未找到翻译模型包：{TRANSLATION_BUNDLE_RELATIVE_PATH}")

    metadata, tensor_names = _read_safetensors_bundle_header(bundle_path)
    if metadata.get(_BUNDLE_SCHEMA_KEY) != TRANSLATION_BUNDLE_SCHEMA:
        raise RuntimeError(
            f"{bundle_path.name} 不是 GJJ 翻译模型包，请使用带 {TRANSLATION_BUNDLE_SCHEMA} 元数据的 safetensors。"
        )
    if metadata.get(_BUNDLE_MODEL_KEY) not in {"", None, TRANSLATION_MODEL_NAME}:
        raise RuntimeError(f"{bundle_path.name} 不是 {TRANSLATION_MODEL_NAME} 翻译模型包。")
    if not tensor_names:
        raise RuntimeError(f"{bundle_path.name} 中没有模型权重张量。")

    files = _bundle_metadata_files(metadata)
    missing = [name for name in _BUNDLE_REQUIRED_FILES if name not in files]
    if missing:
        raise RuntimeError(f"{bundle_path.name} 缺少内置文件：{', '.join(missing)}")

    cache_path = _bundle_cache_path(bundle_path)
    weight_path = cache_path / "model.safetensors"
    stat = bundle_path.stat()
    manifest = {
        "schema": TRANSLATION_BUNDLE_SCHEMA,
        "source": str(bundle_path.resolve()),
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "files": files,
    }
    manifest_path = cache_path / "manifest.json"
    if manifest_path.is_file() and weight_path.exists():
        try:
            old_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if old_manifest == manifest and all((cache_path / relpath).is_file() for relpath in files):
                return cache_path
        except Exception:
            pass

    if cache_path.exists():
        shutil.rmtree(cache_path, ignore_errors=True)
    cache_path.mkdir(parents=True, exist_ok=True)
    cache_root = cache_path.resolve()

    for relpath in files:
        normalized = _normalize_bundle_relpath(relpath)
        target = cache_path / normalized
        resolved = target.resolve()
        if cache_root not in (resolved, *resolved.parents):
            raise RuntimeError(f"翻译模型包内路径越界：{relpath}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(_decode_bundle_metadata_file(metadata, normalized))

    _link_or_copy_bundle_weight(bundle_path, weight_path)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return cache_path


def translation_model_path() -> Path:
    bundle_path = translation_safetensors_bundle_path()
    if bundle_path is not None and translation_safetensors_bundle_complete(bundle_path):
        return prepare_translation_safetensors_model(bundle_path)
    return translation_legacy_model_path()


def _bundle_auxiliary_files(source_dir: Path, extra_files: Iterable[str] | None = None) -> list[Path]:
    if extra_files is not None:
        return [source_dir / _normalize_bundle_relpath(item) for item in extra_files]
    files: list[Path] = []
    for path in source_dir.rglob("*"):
        if not path.is_file():
            continue
        relpath = path.relative_to(source_dir)
        if any(part == _BUNDLE_CACHE_DIRNAME for part in relpath.parts):
            continue
        if path.name in _BUNDLE_WEIGHT_FILENAMES:
            continue
        files.append(path)
    return sorted(files, key=lambda item: item.relative_to(source_dir).as_posix())


def _shared_tensor_signature(value: Any) -> tuple[Any, ...] | None:
    try:
        storage = value.untyped_storage()
        return (
            storage.data_ptr(),
            value.storage_offset(),
            tuple(value.shape),
            tuple(value.stride()),
            str(value.dtype),
        )
    except Exception:
        return None


def _preferred_shared_tensor_key(keys: list[str]) -> str:
    def score(key: str) -> tuple[int, int, str]:
        lowered = key.lower()
        shared = ".shared." in lowered or lowered.endswith("shared.weight")
        return (0 if shared else 1, len(key), key)

    return sorted(keys, key=score)[0]


def _dedupe_shared_state_dict_tensors(state: dict[str, Any]) -> dict[str, Any]:
    groups: dict[tuple[Any, ...], list[str]] = {}
    for key, value in state.items():
        signature = _shared_tensor_signature(value)
        if signature is not None:
            groups.setdefault(signature, []).append(str(key))

    keep_keys = set(state.keys())
    for keys in groups.values():
        if len(keys) <= 1:
            continue
        keep = _preferred_shared_tensor_key(keys)
        for key in keys:
            if key != keep:
                keep_keys.discard(key)

    return {
        str(key): value.detach().clone().contiguous()
        for key, value in state.items()
        if key in keep_keys
    }


def build_translation_safetensors_bundle(
    source_dir: Path | str | None = None,
    output_path: Path | str | None = None,
    *,
    extra_files: Iterable[str] | None = None,
) -> Path:
    """Pack an opus-mt-zh-en HuggingFace folder into one GJJ safetensors bundle."""
    source = Path(source_dir) if source_dir is not None else translation_legacy_model_path()
    if not source.is_dir():
        raise FileNotFoundError(f"未找到翻译模型目录：{source}")

    output = Path(output_path) if output_path is not None else _translation_models_root() / TRANSLATION_BUNDLE_FILENAME
    output.parent.mkdir(parents=True, exist_ok=True)

    weight_path = source / "model.safetensors"
    use_safetensors_weight = weight_path.is_file()
    if not use_safetensors_weight:
        weight_path = source / "pytorch_model.bin"
    if not weight_path.is_file():
        raise FileNotFoundError("翻译模型目录中缺少 model.safetensors 或 pytorch_model.bin。")
    if output.resolve() == weight_path.resolve():
        raise RuntimeError("输出包不能覆盖正在读取的权重文件。")

    if use_safetensors_weight:
        from safetensors.torch import load_file, save_file

        tensors = load_file(str(weight_path), device="cpu")
    else:
        import torch
        from safetensors.torch import save_file

        state = torch.load(str(weight_path), map_location="cpu")
        if isinstance(state, dict) and isinstance(state.get("state_dict"), dict):
            state = state["state_dict"]
        if not isinstance(state, dict):
            raise RuntimeError("pytorch_model.bin 不是可识别的 state_dict。")
        tensor_state = {str(key): value for key, value in state.items() if torch.is_tensor(value)}
        tensors = _dedupe_shared_state_dict_tensors(tensor_state)
    if not tensors:
        raise RuntimeError("翻译模型权重为空，无法打包。")

    metadata: dict[str, str] = {
        _BUNDLE_SCHEMA_KEY: TRANSLATION_BUNDLE_SCHEMA,
        _BUNDLE_MODEL_KEY: TRANSLATION_MODEL_NAME,
    }
    bundled_files: list[str] = []
    for path in _bundle_auxiliary_files(source, extra_files=extra_files):
        relpath = _normalize_bundle_relpath(path.relative_to(source).as_posix())
        content = path.read_bytes()
        bundled_files.append(relpath)
        metadata[_BUNDLE_FILE_KEY_PREFIX + relpath] = json.dumps(
            {
                "encoding": "base64",
                "sha256": hashlib.sha256(content).hexdigest(),
                "data": base64.b64encode(content).decode("ascii"),
            },
            separators=(",", ":"),
        )
    missing = [name for name in _BUNDLE_REQUIRED_FILES if name not in bundled_files]
    if missing:
        raise RuntimeError(f"翻译模型目录缺少必要文件，无法打包：{', '.join(missing)}")
    metadata[_BUNDLE_FILES_KEY] = json.dumps(bundled_files, ensure_ascii=False, separators=(",", ":"))

    save_file(tensors, str(output), metadata=metadata)
    return output


def _module_available(module_name: str) -> bool:
    try:
        __import__(module_name)
        return True
    except Exception:
        return False


def _translation_needs_safetensors_package() -> bool:
    if translation_safetensors_bundle_path() is not None:
        return True
    legacy_path = translation_legacy_model_path()
    return (
        (legacy_path / "model.safetensors").is_file()
        and not (legacy_path / "pytorch_model.bin").is_file()
        and not (legacy_path / "tf_model.h5").is_file()
    )


def missing_translation_dependencies() -> list[dict[str, str]]:
    specs = [
        dict(spec)
        for spec in TRANSLATION_DEPENDENCY_SPECS
        if not _module_available(spec["module_name"])
    ]
    if _translation_needs_safetensors_package() and not _module_available("safetensors"):
        specs.append(dict(_SAFETENSORS_DEPENDENCY_SPEC))
    return specs


def missing_translation_models() -> list[dict[str, str]]:
    if translation_model_complete():
        return []
    if translation_safetensors_bundle_path() is not None and not _module_available("safetensors"):
        return []
    return [
        make_missing_model_spec(
            label="翻译模型包",
            subdir=TRANSLATION_MODEL_SUBDIR,
            filename=TRANSLATION_BUNDLE_FILENAME,
            description=(
                "GJJ 单文件 Opus-MT 中英翻译模型包；旧的 "
                f"{TRANSLATION_LEGACY_MODEL_SUBDIR} 多文件目录仍兼容。"
            ),
        ),
    ]


def build_translation_environment_report(
    *,
    node_name: str = DEFAULT_TRANSLATION_NODE_NAME,
    description: str | None = None,
    original_error: str = "",
) -> dict[str, Any]:
    missing_dependencies = missing_translation_dependencies()
    report = build_dependency_model_report(
        node_name=node_name,
        missing_dependencies=missing_dependencies,
        missing_models=missing_translation_models(),
        install_packages=[spec["package_name"] for spec in missing_dependencies],
        description=description
        or (
            "需要本地 Opus-MT 中英翻译模型包；模型包请放到 "
            f"{TRANSLATION_MODEL_SUBDIR}。"
        ),
        original_error=original_error,
        model_download_url=TRANSLATION_MODEL_DOWNLOAD_URL,
    )
    if original_error and report.get("available", True):
        report["available"] = False
        report["models_available"] = False
        report["notice_level"] = "error"
        report["warning_message"] = "⚠️翻译模型加载失败，点击❓按钮了解详情。"
        report["description_message"] = report["warning_message"]
        report["copy_text"] = report.get("copy_text") or TRANSLATION_MODEL_DOWNLOAD_URL
        report["copy_label"] = report.get("copy_label") or "📋 复制下载地址"
    return report


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
    try:
        return translate_unprotected_text(
            str(text or ""),
            torch_device,
            max_length=max_length,
            batch_size=batch_size,
            preserve_chinese_quotes=preserve_chinese_quotes,
        )
    finally:
        if unload_after_use:
            unload_translation_model()


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
    "TRANSLATION_BUNDLE_FILENAME",
    "TRANSLATION_BUNDLE_RELATIVE_PATH",
    "TRANSLATION_BUNDLE_SCHEMA",
    "TRANSLATION_DEPENDENCY_SPECS",
    "TRANSLATION_LEGACY_MODEL_SUBDIR",
    "TRANSLATION_MODEL_DOWNLOAD_URL",
    "TRANSLATION_MODEL_NAME",
    "TRANSLATION_MODEL_SUBDIR",
    "as_bool",
    "build_translation_safetensors_bundle",
    "build_translation_environment_report",
    "ensure_translation_environment",
    "missing_translation_dependencies",
    "missing_translation_models",
    "pick_translation_device",
    "prepare_translation_safetensors_model",
    "prompt_translate_api_handler",
    "raise_translation_environment_error",
    "register_prompt_translation_api",
    "send_translated_prompt",
    "split_chinese_quote_segments",
    "translate_plain_text",
    "translate_prompt_pair",
    "translate_unprotected_text",
    "translate_zh_to_en",
    "translation_legacy_model_path",
    "translation_model_complete",
    "translation_model_path",
    "translation_safetensors_bundle_complete",
    "translation_safetensors_bundle_path",
    "unload_translation_model",
]
