from __future__ import annotations

import gc
import importlib.util
from pathlib import Path
from typing import Any, Optional

import torch
from aiohttp import web

try:
    import comfy.model_management
except Exception:
    comfy = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None

try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        get_report_from_exception,
        make_missing_model_spec,
        print_dependency_model_report,
        send_dependency_model_notice,
    )
except ImportError:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        get_report_from_exception,
        make_missing_model_spec,
        print_dependency_model_report,
        send_dependency_model_notice,
    )

NODE_NAME = "GJJ_CLIPPromptEncodePanel"
NODE_DISPLAY_NAME = "GJJ · 🧾 CLIP正负提示词编码"
TRANSLATE_API_PATH = "/gjj/clip_prompt_translate"
TRANSLATED_EVENT = "gjj_clip_prompt_translated"
TRANSLATION_MODEL_SUBDIR = "models/translation/opus-mt-zh-en"
TRANSLATION_MODEL_NAME = "opus-mt-zh-en"
_DESCRIPTION_INTRO = (
    "CLIP 编码统一面板：CLIP 输入，正面/负面提示词在一个面板里编辑；"
    "内置条件零化与 Opus-MT 中英翻译开关，翻译时保留中文引号中的原文，输出正负 CONDITIONING。"
)
_TRANSLATION_DEPENDENCY_SPECS = (
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


def _module_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def _translation_model_path() -> Path:
    try:
        import folder_paths

        return Path(folder_paths.models_dir) / "translation" / TRANSLATION_MODEL_NAME
    except Exception:
        return Path("models") / "translation" / TRANSLATION_MODEL_NAME


def _translation_model_complete(path: Path) -> bool:
    if not path.is_dir():
        return False
    has_config = (path / "config.json").is_file()
    has_weight = any((path / name).is_file() for name in ("pytorch_model.bin", "model.safetensors", "tf_model.h5"))
    has_source_tokenizer = any((path / name).is_file() for name in ("source.spm", "tokenizer.json", "spiece.model"))
    has_target_tokenizer = any((path / name).is_file() for name in ("target.spm", "tokenizer.json", "spiece.model"))
    return has_config and has_weight and has_source_tokenizer and has_target_tokenizer


def _missing_translation_dependencies() -> list[dict[str, str]]:
    return [spec for spec in _TRANSLATION_DEPENDENCY_SPECS if not _module_available(spec["module_name"])]


def _missing_translation_models() -> list[dict[str, str]]:
    if _translation_model_complete(_translation_model_path()):
        return []
    return [
        make_missing_model_spec(
            label="Opus-MT 中英翻译模型",
            subdir=TRANSLATION_MODEL_SUBDIR,
            filename="config.json + pytorch_model.bin/model.safetensors + source.spm + target.spm",
            description="翻译开关需要的本地 Helsinki-NLP/opus-mt-zh-en 模型文件。",
        )
    ]


def _build_translation_environment_report(original_error: str = "") -> dict[str, Any]:
    missing_dependencies = _missing_translation_dependencies()
    return build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=missing_dependencies,
        missing_models=_missing_translation_models(),
        install_packages=[spec["package_name"] for spec in missing_dependencies],
        description=(
            "CLIP 编码本身可继续使用；只有开启翻译开关时需要这些依赖和本地模型。"
            f"模型请放到 {TRANSLATION_MODEL_SUBDIR}。"
        ),
        original_error=original_error,
    )


_ENVIRONMENT_REPORT = _build_translation_environment_report()
_DEPENDENCIES_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("dependencies_available", True))
_MODELS_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("models_available", True))
_MISSING_DEPENDENCIES = list(_ENVIRONMENT_REPORT.get("missing_dependencies", []) or [])
_MISSING_MODELS = list(_ENVIRONMENT_REPORT.get("missing_models", []) or [])
if not _ENVIRONMENT_REPORT.get("available", True):
    print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ CLIP 提示词翻译环境缺失")


def _raise_translation_environment_error(report: dict[str, Any], unique_id: Any = None) -> None:
    send_dependency_model_notice(report, unique_id=unique_id)
    error = RuntimeError(report.get("warning_message") or "翻译环境缺失")
    setattr(error, "gjj_report", report)
    raise error


def _ensure_translation_environment(unique_id: Any = None) -> dict[str, Any]:
    report = _build_translation_environment_report()
    if not report.get("available", True):
        _raise_translation_environment_error(report, unique_id=unique_id)
    return report


def _get_translation_module(unique_id: Any = None):
    _ensure_translation_environment(unique_id=unique_id)
    try:
        from . import gjj_opus_mt_zh_en_translation as trans
        return trans
    except Exception:
        try:
            import gjj_opus_mt_zh_en_translation as trans
            return trans
        except Exception as exc:
            report = _build_translation_environment_report(original_error=str(exc))
            if report.get("available", True):
                report = build_dependency_model_report(
                    node_name=NODE_DISPLAY_NAME,
                    missing_dependencies=list(_TRANSLATION_DEPENDENCY_SPECS),
                    install_packages=[spec["package_name"] for spec in _TRANSLATION_DEPENDENCY_SPECS],
                    description="导入 Opus-MT 翻译接口失败；请检查 transformers / sentencepiece 与翻译节点文件是否完整。",
                    original_error=str(exc),
                )
            _raise_translation_environment_error(report, unique_id=unique_id)


def _pick_translation_device(device: str = "auto") -> torch.device:
    device = str(device or "auto").lower()
    if device == "cpu":
        return torch.device("cpu")
    if device == "gpu":
        if not torch.cuda.is_available():
            raise RuntimeError("GPU 不可用，请选择 CPU 或 auto")
        return torch.device("cuda")
    try:
        import comfy.model_management
        return comfy.model_management.get_torch_device()
    except Exception:
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    return text in {"1", "true", "yes", "on", "开启", "启用", "开"}


def _split_chinese_quote_segments(text: str) -> list[tuple[str, bool]]:
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


def _translate_unprotected_text(
    trans,
    torch_device: torch.device,
    text: str,
    max_length: int,
    batch_size: int,
) -> str:
    if not str(text or "").strip():
        return str(text or "")

    pieces: list[str] = []
    for segment, protected in _split_chinese_quote_segments(str(text or "")):
        if protected or not segment.strip():
            pieces.append(segment)
            continue

        leading_len = len(segment) - len(segment.lstrip())
        trailing_len = len(segment) - len(segment.rstrip())
        leading = segment[:leading_len]
        trailing = segment[len(segment) - trailing_len:] if trailing_len else ""
        core = segment.strip()
        translated = trans.translate_text(
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
    max_length: int = 512,
    batch_size: int = 8,
    unload_after_use: bool = False,
    unique_id: Any = None,
) -> str:
    if not str(text or "").strip():
        return ""
    trans = _get_translation_module(unique_id=unique_id)
    torch_device = _pick_translation_device(device)
    result = _translate_unprotected_text(
        trans,
        torch_device,
        str(text or ""),
        max_length,
        batch_size,
    )
    if unload_after_use:
        trans.unload_model()
    return result


def _send_translated_prompt(unique_id: Any, positive: Optional[str] = None) -> None:
    if not unique_id or PromptServer is None or getattr(PromptServer, "instance", None) is None:
        return
    payload = {"node": str(unique_id)}
    if positive is not None:
        payload["positive"] = str(positive)
    try:
        PromptServer.instance.send_sync(TRANSLATED_EVENT, payload)
    except Exception:
        pass


async def gjj_clip_prompt_translate_api(request):
    unique_id = None
    try:
        data = await request.json()
        unique_id = data.get("node", None) or data.get("unique_id", None)
        positive = str(data.get("positive", "") or "")
        negative = str(data.get("negative", "") or "")
        device = str(data.get("device", "auto") or "auto")
        max_length = int(data.get("max_length", 512) or 512)
        batch_size = int(data.get("batch_size", 8) or 8)
        unload_after_use = _as_bool(data.get("unload_after_use", False))

        result = {
            "positive": translate_zh_to_en(
                positive,
                device,
                max_length,
                batch_size,
                unload_after_use and not negative.strip(),
                unique_id=unique_id,
            ),
            "negative": translate_zh_to_en(
                negative,
                device,
                max_length,
                batch_size,
                unload_after_use,
                unique_id=unique_id,
            ),
        }
        return web.json_response({"ok": True, **result})
    except Exception as exc:
        report = get_report_from_exception(exc)
        if report:
            send_dependency_model_notice(report, unique_id=unique_id)
            return web.json_response(
                {"ok": False, "error": report.get("warning_message", str(exc)), "report": report},
                status=500,
            )
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.post(TRANSLATE_API_PATH)(gjj_clip_prompt_translate_api)


def _encode_clip(clip: Any, text: str):
    try:
        from nodes import CLIPTextEncode
        return CLIPTextEncode().encode(clip, str(text or ""))[0]
    except Exception as exc:
        raise RuntimeError(f"CLIP 编码失败：{exc}") from exc


def _zero_conditioning(conditioning: Any):
    try:
        from nodes import ConditioningZeroOut
        return ConditioningZeroOut().zero_out(conditioning)[0]
    except Exception:
        # 兼容兜底：CONDITIONING 通常是 [[tensor, metadata], ...]
        try:
            zeroed = []
            for item in conditioning:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    cond = item[0]
                    meta = item[1].copy() if isinstance(item[1], dict) else item[1]
                    if hasattr(cond, "clone"):
                        cond = cond.clone()
                    if hasattr(cond, "zero_"):
                        cond.zero_()
                    zeroed.append([cond, meta])
                else:
                    zeroed.append(item)
            return zeroed
        except Exception as exc:
            raise RuntimeError(f"条件零化失败：{exc}") from exc


class GJJ_CLIPPromptEncodePanel:
    CATEGORY = "GJJ/条件编码"
    FUNCTION = "encode"
    DESCRIPTION = _DESCRIPTION_INTRO if _ENVIRONMENT_REPORT.get("available", True) else _ENVIRONMENT_REPORT.get("warning_message", "")
    GJJ_HELP = {
        "title": "CLIP正负提示词编码",
        "description": _DESCRIPTION_INTRO,
        "usage": [
            "连接 CLIP 后，在面板内编辑正面和负面提示词，输出对应 CONDITIONING。",
            "翻译开关开启时，会调用本地 Opus-MT 中英翻译模型；中文引号“...”中的内容会保持原文。",
            "正向提示词连接上游输入时，翻译开关开启后会在本节点正面文本框显示译文。",
            "翻译环境缺失时，关闭翻译开关仍可继续做普通 CLIP 编码。",
        ],
        "notice": _ENVIRONMENT_REPORT.get("help_message", "") if not _ENVIRONMENT_REPORT.get("available", True) else "",
        "install_cmd": _ENVIRONMENT_REPORT.get("install_cmd", "") if not _ENVIRONMENT_REPORT.get("available", True) else "",
        "copy_text": _ENVIRONMENT_REPORT.get("copy_text", "") if not _ENVIRONMENT_REPORT.get("available", True) else "",
        "copy_label": _ENVIRONMENT_REPORT.get("copy_label", "") if not _ENVIRONMENT_REPORT.get("available", True) else "",
        "warning_message": _ENVIRONMENT_REPORT.get("warning_message", "") if not _ENVIRONMENT_REPORT.get("available", True) else "",
        "model_download_url": _ENVIRONMENT_REPORT.get("model_download_url", "") if _MISSING_MODELS else "",
        "notice_level": _ENVIRONMENT_REPORT.get("notice_level", "ok"),
        "models": [
            {
                "label": "Opus-MT 中英翻译模型",
                "value": TRANSLATION_MODEL_SUBDIR,
                "description": "目录内至少需要 config.json、权重文件、source.spm 和 target.spm。",
            }
        ],
    }
    SEARCH_ALIASES = [
        "clip encode",
        "clip text encode",
        "prompt encode",
        "正负提示词",
        "条件零化",
        "翻译",
        "中英翻译",
    ]

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("正面条件", "负面条件")
    OUTPUT_TOOLTIPS = ("正面提示词编码后的 CONDITIONING。", "负面提示词编码后的 CONDITIONING。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": (
                    "CLIP",
                    {
                        "display_name": "CLIP",
                        "tooltip": "接入 CLIP / 文本编码器。",
                    },
                ),
                "positive_text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "正面提示词",
                        "tooltip": "由前端统一面板维护的正面提示词。",
                    },
                ),
                "negative_text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "负面提示词",
                        "tooltip": "由前端统一面板维护的负面提示词。",
                    },
                ),
                "zero_conditioning": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "条件零化",
                        "tooltip": "开启后输出零化后的正负条件。",
                    },
                ),
                "translation_device": (
                    ["auto", "cpu", "gpu"],
                    {
                        "default": "auto",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "翻译设备",
                        "tooltip": "翻译按钮使用的设备。auto 会自动选择 GPU 或 CPU。",
                    },
                ),
                "translation_unload_after_use": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "翻译后卸载",
                        "tooltip": "翻译完成后是否卸载 Opus-MT 模型。",
                    },
                ),
                "translation_enabled": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "翻译开关",
                        "tooltip": "开启后点击会立即翻译当前面板文本；连接上游正向提示词时会显示翻译后的文本。",
                    },
                ),
            },
            "optional": {
                "positive_prompt_input": (
                    "STRING",
                    {
                        "forceInput": True,
                        "display_name": "正向提示词",
                        "tooltip": "外部正向提示词输入；连接后优先使用此文本。翻译开关开启时，本节点面板会显示译文。",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        keys = [
            "positive_text",
            "positive_prompt_input",
            "negative_text",
            "zero_conditioning",
            "translation_device",
            "translation_unload_after_use",
            "translation_enabled",
        ]
        return "|".join(str(kwargs.get(key, "")) for key in keys)

    def encode(self, *args, **kwargs):
        clip = kwargs.get("clip", None)
        if clip is None:
            raise RuntimeError("请连接 CLIP 输入。")

        external_positive = kwargs.get("positive_prompt_input", None)
        translation_enabled = _as_bool(kwargs.get("translation_enabled", False))
        translation_device = str(kwargs.get("translation_device", "auto") or "auto")
        translation_unload_after_use = _as_bool(kwargs.get("translation_unload_after_use", False))
        unique_id = kwargs.get("unique_id", None)

        if external_positive is not None and translation_enabled:
            positive_text = translate_zh_to_en(
                str(external_positive or ""),
                translation_device,
                unload_after_use=translation_unload_after_use,
                unique_id=unique_id,
            )
            _send_translated_prompt(unique_id, positive_text)
        else:
            positive_text = str(external_positive if external_positive is not None else kwargs.get("positive_text", "") or "")
        negative_text = str(kwargs.get("negative_text", "") or "")
        zero_conditioning = _as_bool(kwargs.get("zero_conditioning", False))

        # 正向始终按正面提示词正常编码。
        positive = _encode_clip(clip, positive_text)

        if zero_conditioning:
            # 条件零化的正确逻辑：
            # 用“正向提示词编码结果”的结构生成一个全零负向条件。
            # 这样正向条件保持正常，负向条件维度/结构与当前 CLIP 输出完全对齐。
            # 不能把正向也 zero_out，否则正向条件会被清空，生成结果会完全不对。
            negative = _zero_conditioning(positive)
        else:
            negative = _encode_clip(clip, negative_text)

        return (positive, negative)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_CLIPPromptEncodePanel}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧾 CLIP正负提示词编码"}
