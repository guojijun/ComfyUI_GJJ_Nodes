from __future__ import annotations

import hashlib
import os

import torch

# ============================================================================
# 导入公共依赖检查工具
# ============================================================================
try:
    from .common_utils.dependency_checker import (
        print_runtime_dependency_error,
        build_dependency_model_report,
        print_dependency_model_report,
    )
    from .common_utils.prompt_translation import (
        COMMON_PROMPT_TRANSLATE_API_PATH,
        TRANSLATION_MODEL_SUBDIR,
        as_bool,
        build_translation_environment_report,
        register_prompt_translation_api,
        send_translated_prompt,
        translate_prompt_pair,
    )
except ImportError:
    from common_utils.dependency_checker import (
        print_runtime_dependency_error,
        build_dependency_model_report,
        print_dependency_model_report,
    )
    from common_utils.prompt_translation import (
        COMMON_PROMPT_TRANSLATE_API_PATH,
        TRANSLATION_MODEL_SUBDIR,
        as_bool,
        build_translation_environment_report,
        register_prompt_translation_api,
        send_translated_prompt,
        translate_prompt_pair,
    )


NODE_NAME = "GJJ_WanVideoTextEncodeCached"
NODE_DISPLAY_NAME = "📝 WanVideo 文本编码（缓存版）"
TRANSLATED_EVENT = "gjj_wanvideo_text_prompt_translated"

USE_DISK_CACHE = True
ENCODE_DEVICE = "gpu"
FORCE_OFFLOAD_AFTER_ENCODE = False
NEGATIVE_PROMPT = ""

# ============================================================================
# 节点描述和帮助信息
# ============================================================================
_DESCRIPTION = "接收 Wan T5 编码器和正向提示词，输出打包好的 WanVideo 文本条件。"
_GJJ_HELP = {
    "title": "WanVideo 文本编码（缓存版）",
    "description": "接收 GJJ 视频模型加载器或 LoadWanVideoT5TextEncoder 输出的 WANTEXTENCODER，把正向提示词编码为 WanVideo 可读取的文本条件。",
    "usage": [
        "把 GJJ · 🎞️ Kijai视频模型加载 的 Wan T5 文本编码器输出接到本节点的 T5模型接口。",
        "在正向提示词中填写希望生成的画面内容；支持原版 WanVideo 的 | 分段和 [1] EchoShot 写法。",
        "翻译按钮会调用本地 Opus-MT 中英翻译模型，并把译文回填到正向提示词。",
        "节点内部使用空负向提示词，并把正向/负向嵌入打包成单个文本条件输出。",
        "输出的文本条件可直接连接到 GJJ WanVideo 采样器的文本条件输入。",
    ],
    "dependencies": [
        "transformers：WANTEXTENCODER 的加载器需要该运行库。",
    ],
    "notes": [
        "本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时，不依赖外部 ComfyUI-WanVideoWrapper 插件。",
        "本节点不再内部加载 T5 模型；模型加载统一交给 GJJ_VideoKijaiModelLoader 或原版 LoadWanVideoT5TextEncoder。",
        "磁盘缓存默认开启，相同正向提示词会复用已编码嵌入。",
        "缺失依赖时，节点面板会显示复制安装命令按钮，点击后可在 PowerShell 中直接执行安装。",
        "安装完成后请重启 ComfyUI 服务器。",
    ],
}


_TRANSLATION_ENVIRONMENT_REPORT = build_translation_environment_report(
    node_name=NODE_DISPLAY_NAME,
    description=(
        "WanVideo 文本编码本身可继续使用；只有点击翻译按钮时需要这些依赖和本地模型。"
        f"模型请放到 {TRANSLATION_MODEL_SUBDIR}。"
    ),
)
if not _TRANSLATION_ENVIRONMENT_REPORT.get("available", True):
    try:
        print_dependency_model_report(_TRANSLATION_ENVIRONMENT_REPORT, title="GJJ WanVideo 提示词翻译环境缺失")
    except Exception:
        pass
    _GJJ_HELP["translation_notice"] = _TRANSLATION_ENVIRONMENT_REPORT.get("help_message", "")
    _GJJ_HELP["translation_install_cmd"] = _TRANSLATION_ENVIRONMENT_REPORT.get("install_cmd", "")
    _GJJ_HELP["translation_copy_text"] = _TRANSLATION_ENVIRONMENT_REPORT.get("copy_text", "")
    _GJJ_HELP["translation_model_download_url"] = _TRANSLATION_ENVIRONMENT_REPORT.get("model_download_url", "")

register_prompt_translation_api((COMMON_PROMPT_TRANSLATE_API_PATH,))


def _check_startup_dependencies():
    """启动时检查依赖，只跳过当前节点，不影响其他节点。"""
    global _DESCRIPTION

    required_deps = [
        ("transformers", "WANTEXTENCODER 的加载器需要 transformers。"),
    ]

    missing_deps = []
    for module_name, description in required_deps:
        try:
            __import__(module_name)
        except ImportError:
            missing_deps.append({
                "module_name": module_name,
                "package_name": module_name,
                "display_name": module_name,
                "description": description,
            })

    if missing_deps:
        report = build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=missing_deps,
            install_packages=[item["package_name"] for item in missing_deps],
        )

        _DESCRIPTION = report.get("warning_message", _DESCRIPTION)
        _GJJ_HELP["description"] = report.get("panel_message", _GJJ_HELP["description"])
        _GJJ_HELP["install_cmd"] = report.get("install_cmd", "")
        _GJJ_HELP["warning_message"] = report.get("warning_message", "")

        try:
            print_dependency_model_report(
                report,
                title="GJJ WanVideo 文本编码 启动时依赖缺失！",
            )
        except Exception:
            pass
    else:
        _DESCRIPTION = f"✅ {_DESCRIPTION}"


_check_startup_dependencies()


def _load_wanvideo_nodes():
    """懒加载 WanVideoWrapper 节点依赖。"""
    try:
        from ..vendor.wanvideo_wrapper import nodes as wan_nodes
    except ImportError as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo 文本编码加载失败。\n"
            f"错误信息: {error}\n"
            "说明: 本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时。"
        ) from error
    return wan_nodes


def _get_cache_dir():
    cache_dir = os.path.join(os.path.dirname(__file__), "..", "cache", "wanvideo_text_embeds")
    os.makedirs(cache_dir, exist_ok=True)
    return cache_dir


def _get_cache_path(prompt):
    cache_key = str(prompt or "").strip()
    cache_hash = hashlib.sha256(cache_key.encode("utf-8")).hexdigest()
    return os.path.join(_get_cache_dir(), f"{cache_hash}.pt")


def _get_cached_text_embeds(positive_prompt):
    context = None
    context_null = None

    pos_cache_path = _get_cache_path(positive_prompt)
    neg_cache_path = _get_cache_path(NEGATIVE_PROMPT)

    if os.path.exists(pos_cache_path):
        try:
            print(f"[GJJ WanVideoTextEncode] 从缓存加载正向提示词嵌入: {pos_cache_path}")
            context = torch.load(pos_cache_path, weights_only=False)
        except Exception as error:
            print(f"[GJJ WanVideoTextEncode] 正向缓存加载失败: {error}，将重新编码")

    if os.path.exists(neg_cache_path):
        try:
            print(f"[GJJ WanVideoTextEncode] 从缓存加载空负向提示词嵌入: {neg_cache_path}")
            context_null = torch.load(neg_cache_path, weights_only=False)
        except Exception as error:
            print(f"[GJJ WanVideoTextEncode] 负向缓存加载失败: {error}，将重新编码")

    return context, context_null


def _save_text_embeds(positive_prompt, prompt_embeds, negative_prompt_embeds):
    try:
        pos_cache_path = _get_cache_path(positive_prompt)
        neg_cache_path = _get_cache_path(NEGATIVE_PROMPT)

        torch.save(prompt_embeds, pos_cache_path)
        print(f"[GJJ WanVideoTextEncode] 正向提示词嵌入已缓存: {pos_cache_path}")

        if negative_prompt_embeds is not None:
            torch.save(negative_prompt_embeds, neg_cache_path)
            print(f"[GJJ WanVideoTextEncode] 空负向提示词嵌入已缓存: {neg_cache_path}")
    except Exception as error:
        print(f"[GJJ WanVideoTextEncode] 缓存保存失败: {error}")


def _zero_like_text_embeds(value):
    if value is None:
        return None
    if torch.is_tensor(value):
        return torch.zeros_like(value)
    if isinstance(value, list):
        return [_zero_like_text_embeds(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_zero_like_text_embeds(item) for item in value)
    if isinstance(value, dict):
        return {key: _zero_like_text_embeds(item) for key, item in value.items()}
    try:
        clone = value.clone()
        if hasattr(clone, "zero_"):
            clone.zero_()
            return clone
    except Exception:
        pass
    return value


class GJJ_WanVideoTextEncodeCached:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    DESCRIPTION = _DESCRIPTION
    SEARCH_ALIASES = [
        "WanVideo Text Encode",
        "Wan T5 文本编码",
        "提示词嵌入",
        "WanVideo 文本条件",
        "Wan2.1 文本编码器",
    ]

    RETURN_TYPES = ("WANVIDEOTEXTEMBEDS",)
    RETURN_NAMES = ("文本条件",)
    OUTPUT_TOOLTIPS = (
        "包装好的 WanVideo 文本条件，包含正向提示词嵌入和空负向提示词嵌入，可直接连接 WanVideo 采样器。",
    )

    GJJ_HELP = _GJJ_HELP

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text_encoder": (
                    "WANTEXTENCODER",
                    {
                        "display_name": "T5模型接口",
                        "tooltip": "连接 GJJ_VideoKijaiModelLoader 的 Wan T5 文本编码器输出，或原版 LoadWanVideoT5TextEncoder 的 WANTEXTENCODER 输出。",
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display_name": "正向提示词",
                        "tooltip": "描述希望生成的画面内容。支持原版 WanVideo 的 | 分段和 [1] EchoShot 写法。",
                    },
                ),
                "force_offload": (
                    "BOOLEAN",
                    {
                        "default": FORCE_OFFLOAD_AFTER_ENCODE,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "编码后卸载T5",
                        "tooltip": "按钮状态。开启后编码完成会把 T5 移回卸载设备；关闭更适合连续循环生成。",
                    },
                ),
                "use_disk_cache": (
                    "BOOLEAN",
                    {
                        "default": USE_DISK_CACHE,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "使用磁盘缓存",
                        "tooltip": "按钮状态。开启后将文本嵌入缓存到磁盘，下次使用时无需重新编码。",
                    },
                ),
                "device": (
                    ["gpu", "cpu"],
                    {
                        "default": ENCODE_DEVICE,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "编码设备",
                        "tooltip": "按钮状态。文本编码计算设备。",
                    },
                ),
                "zero_conditioning": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "条件零化",
                        "tooltip": "按钮状态。开启后正向正常编码，负向嵌入按正向结构生成全零张量。",
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
                        "tooltip": "翻译按钮状态。翻译完成后是否卸载 Opus-MT 模型。",
                    },
                ),
                "translation_enabled": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "翻译开关",
                        "tooltip": "翻译按钮状态。开启时按钮会把当前正向提示词翻译并回填。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        keys = [
            "positive_prompt",
            "force_offload",
            "use_disk_cache",
            "device",
            "zero_conditioning",
            "translation_device",
            "translation_unload_after_use",
            "translation_enabled",
        ]
        return "|".join(str(kwargs.get(key, "")) for key in keys)

    def process(
        self,
        text_encoder,
        positive_prompt,
        force_offload=FORCE_OFFLOAD_AFTER_ENCODE,
        use_disk_cache=USE_DISK_CACHE,
        device=ENCODE_DEVICE,
        zero_conditioning=False,
        translation_device="auto",
        translation_unload_after_use=False,
        translation_enabled=False,
        unique_id=None,
        extra_pnginfo=None,
    ):
        positive_prompt = str(positive_prompt or "")
        force_offload = as_bool(force_offload)
        use_disk_cache = as_bool(use_disk_cache)
        device = str(device or ENCODE_DEVICE)
        zero_conditioning = as_bool(zero_conditioning)
        translation_enabled = as_bool(translation_enabled)
        translation_unload_after_use = as_bool(translation_unload_after_use)

        if translation_enabled:
            translated = translate_prompt_pair(
                positive=positive_prompt,
                negative="",
                device=str(translation_device or "auto"),
                max_length=512,
                batch_size=8,
                unload_after_use=translation_unload_after_use,
                unique_id=unique_id,
                node_name=NODE_DISPLAY_NAME,
            )
            positive_prompt = str(translated.get("positive", "") or "")
            send_translated_prompt(unique_id, event_name=TRANSLATED_EVENT, positive=positive_prompt)

        print("[GJJ WanVideoTextEncode] ========== 开始编码文本 ==========")
        encoder_name = ""
        if isinstance(text_encoder, dict):
            encoder_name = str(text_encoder.get("name", "") or "")
        print(f"[GJJ WanVideoTextEncode] T5编码器: {encoder_name or 'WANTEXTENCODER'}")
        print(f"[GJJ WanVideoTextEncode] 使用空负向提示词")
        print(f"[GJJ WanVideoTextEncode] 设备: {device}")
        print(f"[GJJ WanVideoTextEncode] 编码后卸载T5: {force_offload}")
        print(f"[GJJ WanVideoTextEncode] 使用磁盘缓存: {use_disk_cache}")
        print(f"[GJJ WanVideoTextEncode] 条件零化: {zero_conditioning}")

        if not isinstance(text_encoder, dict) or "model" not in text_encoder or "dtype" not in text_encoder:
            raise RuntimeError(
                "Wan T5编码器输入无效。\n"
                "请从 GJJ_VideoKijaiModelLoader 的 Wan T5 文本编码器输出，"
                "或原版 LoadWanVideoT5TextEncoder 的 WANTEXTENCODER 输出连接到本节点。"
            )

        try:
            wan_nodes = _load_wanvideo_nodes()
        except RuntimeError as error:
            print_runtime_dependency_error(
                node_name=NODE_DISPLAY_NAME,
                dependency_name="WanVideo runtime",
                description=str(error),
                unique_id=unique_id,
            )
            raise
        except Exception as error:
            print_runtime_dependency_error(
                node_name=NODE_DISPLAY_NAME,
                dependency_name="WanVideo runtime",
                description=str(error),
                unique_id=unique_id,
            )
            raise RuntimeError(
                "GJJ 内置 WanVideo 文本编码加载失败。\n"
                f"错误信息: {error}\n"
                "说明: 本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时。"
            ) from error

        echoshot = "[1]" in positive_prompt

        if use_disk_cache:
            context, context_null = _get_cached_text_embeds(positive_prompt)
            if context is not None and (context_null is not None or zero_conditioning):
                if zero_conditioning:
                    context_null = _zero_like_text_embeds(context)
                print("[GJJ WanVideoTextEncode] ========== 使用缓存，跳过编码 ==========")
                return ({
                    "prompt_embeds": context,
                    "negative_prompt_embeds": context_null,
                    "echoshot": echoshot,
                },)

        print("[GJJ WanVideoTextEncode] 正在编码文本提示词...")
        prompt_embeds_dict, = wan_nodes.WanVideoTextEncode().process(
            positive_prompt=positive_prompt,
            negative_prompt=NEGATIVE_PROMPT,
            t5=text_encoder,
            force_offload=force_offload,
            model_to_offload=None,
            use_disk_cache=False,
            device=device,
        )
        print("[GJJ WanVideoTextEncode] 文本编码完成")

        if zero_conditioning:
            prompt_embeds_dict = dict(prompt_embeds_dict)
            prompt_embeds_dict["negative_prompt_embeds"] = _zero_like_text_embeds(prompt_embeds_dict.get("prompt_embeds"))
            print("[GJJ WanVideoTextEncode] 负向文本嵌入已按正向结构零化")

        if use_disk_cache:
            _save_text_embeds(
                positive_prompt,
                prompt_embeds_dict.get("prompt_embeds"),
                None if zero_conditioning else prompt_embeds_dict.get("negative_prompt_embeds"),
            )

        print("[GJJ WanVideoTextEncode] ========== 编码完成 ==========")
        return (prompt_embeds_dict,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanVideoTextEncodeCached}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
