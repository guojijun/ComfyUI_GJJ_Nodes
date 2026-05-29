from __future__ import annotations

from typing import Any

try:
    from .common_utils.dependency_checker import (
        print_dependency_model_report,
    )
    from .common_utils.prompt_translation import (
        COMMON_PROMPT_TRANSLATE_API_PATH,
        LEGACY_CLIP_PROMPT_TRANSLATE_API_PATH,
        TRANSLATION_DEPENDENCY_SPECS,
        TRANSLATION_MODEL_SUBDIR,
        as_bool,
        build_translation_environment_report,
        register_prompt_translation_api,
        send_translated_prompt,
        translate_zh_to_en,
    )
except ImportError:
    from common_utils.dependency_checker import (
        print_dependency_model_report,
    )
    from common_utils.prompt_translation import (
        COMMON_PROMPT_TRANSLATE_API_PATH,
        LEGACY_CLIP_PROMPT_TRANSLATE_API_PATH,
        TRANSLATION_DEPENDENCY_SPECS,
        TRANSLATION_MODEL_SUBDIR,
        as_bool,
        build_translation_environment_report,
        register_prompt_translation_api,
        send_translated_prompt,
        translate_zh_to_en,
    )

NODE_NAME = "GJJ_CLIPPromptEncodePanel"
NODE_DISPLAY_NAME = "GJJ · 🧾 CLIP正负提示词编码"
TRANSLATE_API_PATH = LEGACY_CLIP_PROMPT_TRANSLATE_API_PATH
COMMON_TRANSLATE_API_PATH = COMMON_PROMPT_TRANSLATE_API_PATH
TRANSLATED_EVENT = "gjj_clip_prompt_translated"
_DESCRIPTION_INTRO = (
    "CLIP 编码统一面板：CLIP 输入，正面/负面提示词在一个面板里编辑；"
    "内置条件零化与 Opus-MT 中英翻译开关，翻译时保留中文引号中的原文，输出正负 CONDITIONING。"
)
_TRANSLATION_DEPENDENCY_SPECS = TRANSLATION_DEPENDENCY_SPECS


_ENVIRONMENT_REPORT = build_translation_environment_report(
    node_name=NODE_DISPLAY_NAME,
    description=(
        "CLIP 编码本身可继续使用；只有开启翻译开关时需要这些依赖和本地模型。"
        f"模型请放到 {TRANSLATION_MODEL_SUBDIR}。"
    ),
)
_DEPENDENCIES_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("dependencies_available", True))
_MODELS_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("models_available", True))
_MISSING_DEPENDENCIES = list(_ENVIRONMENT_REPORT.get("missing_dependencies", []) or [])
_MISSING_MODELS = list(_ENVIRONMENT_REPORT.get("missing_models", []) or [])
if not _ENVIRONMENT_REPORT.get("available", True):
    print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ CLIP 提示词翻译环境缺失")


register_prompt_translation_api((COMMON_TRANSLATE_API_PATH, TRANSLATE_API_PATH))


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
        translation_enabled = as_bool(kwargs.get("translation_enabled", False))
        translation_device = str(kwargs.get("translation_device", "auto") or "auto")
        translation_unload_after_use = as_bool(kwargs.get("translation_unload_after_use", False))
        unique_id = kwargs.get("unique_id", None)

        if external_positive is not None and translation_enabled:
            positive_text = translate_zh_to_en(
                str(external_positive or ""),
                translation_device,
                unload_after_use=translation_unload_after_use,
                unique_id=unique_id,
                node_name=NODE_DISPLAY_NAME,
            )
            send_translated_prompt(unique_id, positive=positive_text, event_name=TRANSLATED_EVENT)
        else:
            positive_text = str(external_positive if external_positive is not None else kwargs.get("positive_text", "") or "")
        negative_text = str(kwargs.get("negative_text", "") or "")
        zero_conditioning = as_bool(kwargs.get("zero_conditioning", False))

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
