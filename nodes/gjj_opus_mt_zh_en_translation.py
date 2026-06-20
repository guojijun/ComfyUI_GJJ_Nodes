from __future__ import annotations

from typing import Any, Optional

try:
    from .common_utils.dependency_checker import print_dependency_model_report
    from .common_utils.prompt_translation import (
        TRANSLATION_BUNDLE_FILENAME,
        TRANSLATION_MODEL_DOWNLOAD_URL,
        TRANSLATION_MODEL_SUBDIR,
        build_translation_environment_report,
        translate_plain_text,
        translate_zh_to_en,
        unload_translation_model,
    )
except ImportError:
    from common_utils.dependency_checker import print_dependency_model_report
    from common_utils.prompt_translation import (
        TRANSLATION_BUNDLE_FILENAME,
        TRANSLATION_MODEL_DOWNLOAD_URL,
        TRANSLATION_MODEL_SUBDIR,
        build_translation_environment_report,
        translate_plain_text,
        translate_zh_to_en,
        unload_translation_model,
    )


NODE_NAME = "GJJ_OpusMTZhEnTranslation"
NODE_DISPLAY_NAME = "🌐 Opus-MT中英翻译器 🌍"

_ENVIRONMENT_REPORT = build_translation_environment_report(
    node_name=NODE_DISPLAY_NAME,
    description=(
        "需要 GJJ 单文件 Opus-MT 中英翻译模型包；"
        f"请将 {TRANSLATION_BUNDLE_FILENAME} 放到 {TRANSLATION_MODEL_SUBDIR}。"
    ),
)
if not _ENVIRONMENT_REPORT.get("available", True):
    try:
        print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ Opus-MT 翻译环境缺失")
    except Exception:
        pass


def send_status(unique_id: Any, text: str) -> None:
    """发送状态更新到 ComfyUI 界面。"""
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


def translate_text(
    text: str,
    device: Any,
    max_length: int = 512,
    batch_size: int = 8,
) -> str:
    """兼容旧调用：使用已选 torch device 执行纯文本翻译。"""
    return translate_plain_text(
        text,
        device,
        max_length=max_length,
        batch_size=batch_size,
    )


def unload_model() -> None:
    """兼容内存管理器：卸载公共翻译模型缓存。"""
    unload_translation_model()


class GJJ_OpusMTZhEnTranslation:
    CATEGORY = "GJJ/翻译"
    FUNCTION = "translate"
    DESCRIPTION = (
        "使用 GJJ 单文件 Opus-MT 中英翻译模型包将中文翻译为英文。"
        f"模型放在 {TRANSLATION_MODEL_SUBDIR}/{TRANSLATION_BUNDLE_FILENAME}。"
    )
    SEARCH_ALIASES = ["translation", "opus mt", "中英翻译", "translation", "chinese to english"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("英文翻译结果",)
    OUTPUT_TOOLTIPS = ("翻译后的英文文本内容。",)
    GJJ_HELP = {
        "title": "Opus-MT中英翻译器",
        "description": DESCRIPTION,
        "usage": [
            "输入中文文本后输出英文译文。",
            "模型使用 GJJ 单文件 safetensors 包，内部已包含配置、权重与分词文件。",
            "旧的 models/translation/opus-mt-zh-en 多文件目录仍兼容。",
            "可选择使用后卸载模型以释放显存。",
        ],
        "model_download_url": TRANSLATION_MODEL_DOWNLOAD_URL,
        "install_cmd": _ENVIRONMENT_REPORT.get("install_cmd", ""),
        "copy_text": _ENVIRONMENT_REPORT.get("copy_text", ""),
        "copy_label": _ENVIRONMENT_REPORT.get("copy_label", ""),
        "warning_message": _ENVIRONMENT_REPORT.get("warning_message", ""),
        "notice_level": _ENVIRONMENT_REPORT.get("notice_level", "ok"),
        "models": _ENVIRONMENT_REPORT.get("missing_models", []),
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "chinese_text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "中文输入文本",
                    "tooltip": "输入需要翻译的中文文本。",
                }),
                "device": (["auto", "cpu", "gpu"], {
                    "default": "auto",
                    "display_name": "设备选择",
                    "tooltip": "选择运行模型的设备。auto 会自动选择 GPU 或 CPU。",
                }),
                "max_length": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 1024,
                    "step": 64,
                    "display_name": "最大长度",
                    "tooltip": "输入和输出的最大 token 长度。",
                }),
                "batch_size": ("INT", {
                    "default": 8,
                    "min": 1,
                    "max": 32,
                    "step": 1,
                    "display_name": "批处理大小",
                    "tooltip": "同时处理的句子数量，影响内存使用和速度。",
                }),
                "unload_after_use": ("BOOLEAN", {
                    "default": False,
                    "display_name": "使用后卸载模型",
                    "tooltip": "翻译完成后是否卸载模型以释放显存。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def translate(
        self,
        chinese_text: str,
        device: str,
        max_length: int,
        batch_size: int,
        unload_after_use: bool,
        unique_id: Optional[str] = None,
    ) -> tuple[str]:
        try:
            send_status(unique_id, "正在加载翻译模型...")
            result = translate_zh_to_en(
                chinese_text,
                device,
                max_length=max_length,
                batch_size=batch_size,
                unload_after_use=unload_after_use,
                unique_id=unique_id,
                node_name=NODE_DISPLAY_NAME,
                preserve_chinese_quotes=False,
            )
            send_status(unique_id, "翻译完成！")
            return (result,)
        except Exception as exc:
            if unload_after_use:
                unload_translation_model()
            raise RuntimeError(f"翻译失败: {exc}") from exc


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_OpusMTZhEnTranslation}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
