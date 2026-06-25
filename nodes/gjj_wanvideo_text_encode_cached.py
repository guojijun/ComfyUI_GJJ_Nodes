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
        TRANSLATION_BUNDLE_FILENAME,
        TRANSLATION_BUNDLE_RELATIVE_PATH,
        TRANSLATION_MODEL_DOWNLOAD_URL,
        TRANSLATION_MODEL_SUBDIR,
        as_bool,
        build_translation_environment_report,
        register_prompt_translation_api,
        send_translated_prompt,
        translate_prompt_pair,
    )
    from .common_utils.lora_triggers import append_lora_triggers_to_positive_prompt
except ImportError:
    from common_utils.dependency_checker import (
        print_runtime_dependency_error,
        build_dependency_model_report,
        print_dependency_model_report,
    )
    from common_utils.prompt_translation import (
        COMMON_PROMPT_TRANSLATE_API_PATH,
        TRANSLATION_BUNDLE_FILENAME,
        TRANSLATION_BUNDLE_RELATIVE_PATH,
        TRANSLATION_MODEL_DOWNLOAD_URL,
        TRANSLATION_MODEL_SUBDIR,
        as_bool,
        build_translation_environment_report,
        register_prompt_translation_api,
        send_translated_prompt,
        translate_prompt_pair,
    )
    from common_utils.lora_triggers import append_lora_triggers_to_positive_prompt


NODE_NAME = "GJJ_WanVideoTextEncodeCached"
NODE_DISPLAY_NAME = "📝CLIP文本编码(Kijai版WanVideo专用)"
TRANSLATED_EVENT = "gjj_wanvideo_text_prompt_translated"

USE_DISK_CACHE = True
ENCODE_DEVICE = "gpu"
ENCODE_DEVICE_OPTIONS = ("gpu", "cpu", "disabled")
TRANSLATION_DEVICE = "auto"
TRANSLATION_DEVICE_OPTIONS = ("auto", "cpu", "gpu", False, True, "false", "true", "disabled")
FORCE_OFFLOAD_AFTER_ENCODE = False
NEGATIVE_PROMPT = ""

# ============================================================================
# 节点描述和帮助信息
# ============================================================================
_DESCRIPTION = "接收 Wan T5 编码器和正向提示词，输出打包好的 WanVideo 文本条件。"
_TRANSLATION_MODEL_TREE = [
    {
        "label": "翻译模型包",
        "folder": "translation",
        "filename": TRANSLATION_BUNDLE_FILENAME,
        "value": TRANSLATION_BUNDLE_RELATIVE_PATH,
        "description": "GJJ 单文件 Opus-MT 中英翻译模型包，内部已包含配置、权重与分词文件。",
        "icon": "🧠",
    },
]
_GJJ_HELP = {
    "title": "WanVideo 文本编码（缓存版）",
    "description": "接收 GJJ 视频模型加载器或 LoadWanVideoT5TextEncoder 输出的 WANTEXTENCODER，把正向提示词编码为 WanVideo 可读取的文本条件。",
    "usage": [
        "把 GJJ · 🎞️ Kijai视频模型加载 的 Wan T5 文本编码器输出接到本节点的 T5模型接口。",
        "在正向提示词中填写希望生成的画面内容；支持原版 WanVideo 的 | 分段和 [1] EchoShot 写法。",
        "翻译按钮会调用本地单文件 Opus-MT 中英翻译模型包，并把译文回填到正向提示词。",
        "负向提示词为空时按原版 WanVideo 的空负向编码；开启条件零化时会忽略负向文本并生成全零负向嵌入。",
        "输出的文本条件可直接连接到 GJJ WanVideo 采样器的文本条件输入。",
    ],
    "dependencies": [
        "transformers：WANTEXTENCODER 的加载器需要该运行库。",
    ],
    "notes": [
        "本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时，不依赖外部 ComfyUI-WanVideoWrapper 插件。",
        "本节点不再内部加载 T5 模型；模型加载统一交给 GJJ_VideoKijaiModelLoader 或原版 LoadWanVideoT5TextEncoder。",
        "磁盘缓存默认开启，相同正向/负向提示词会复用已编码嵌入。",
        "缺失依赖时，节点面板会显示复制安装命令按钮，点击后可在 PowerShell 中直接执行安装。",
        "安装完成后请重启 ComfyUI 服务器。",
    ],
    "model_download_url": TRANSLATION_MODEL_DOWNLOAD_URL,
    "static_model_tree_only": True,
    "model_tree_priority": "static",
    "model_tree": _TRANSLATION_MODEL_TREE,
    "models": _TRANSLATION_MODEL_TREE,
}


_TRANSLATION_ENVIRONMENT_REPORT = build_translation_environment_report(
    node_name=NODE_DISPLAY_NAME,
    description=(
        "WanVideo 文本编码本身可继续使用；只有点击翻译按钮时需要这些依赖和本地翻译模型包。"
        f"模型包请放到 {TRANSLATION_MODEL_SUBDIR}。"
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


def _get_cached_text_embeds(positive_prompt, negative_prompt=NEGATIVE_PROMPT):
    context = None
    context_null = None

    pos_cache_path = _get_cache_path(positive_prompt)
    neg_cache_path = _get_cache_path(negative_prompt)

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


def _save_text_embeds(positive_prompt, prompt_embeds, negative_prompt_embeds, negative_prompt=NEGATIVE_PROMPT):
    try:
        pos_cache_path = _get_cache_path(positive_prompt)
        neg_cache_path = _get_cache_path(negative_prompt)

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


def _normalize_encode_device(value):
    device = str(value or ENCODE_DEVICE).strip().lower()
    if device == "cpu":
        return "cpu"
    # 兼容旧工作流里保存的 disabled；这里按默认 GPU 编码处理。
    return ENCODE_DEVICE


def _normalize_translation_device(value):
    device = str(value or TRANSLATION_DEVICE).strip().lower()
    if device in {"cpu", "gpu"}:
        return device
    # 兼容旧工作流里保存的 False / disabled；翻译设备回到默认自动选择。
    return TRANSLATION_DEVICE


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
        "包装好的 WanVideo 文本条件，包含正向提示词嵌入和负向提示词嵌入，可直接连接 WanVideo 采样器。",
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
                "negative_prompt": (
                    "STRING",
                    {
                        "default": NEGATIVE_PROMPT,
                        "multiline": True,
                        "display_name": "负向提示词",
                        "tooltip": "描述希望避免的画面内容。条件零化关闭时会按原版 WanVideo 正常编码；条件零化开启时此输入会被隐藏并忽略。",
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
                    list(ENCODE_DEVICE_OPTIONS),
                    {
                        "default": ENCODE_DEVICE,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "编码设备",
                        "tooltip": "按钮状态。文本编码计算设备。旧工作流里的 disabled 会自动按 gpu 处理。",
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
                    list(TRANSLATION_DEVICE_OPTIONS),
                    {
                        "default": TRANSLATION_DEVICE,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "翻译设备",
                        "tooltip": "翻译按钮使用的设备。auto 会自动选择 GPU 或 CPU。旧工作流里的 False / disabled 会自动按 auto 处理。",
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
            "optional": {
                "model_to_offload": (
                    "WANVIDEOMODEL",
                    {
                        "display_name": "临时卸载模型",
                        "tooltip": "可选。编码前先把视频模型移到卸载设备，为 T5 文本编码腾出显存；兼容旧版 Kijai WanVideo 工作流。",
                    },
                ),
                "lora_triggers": (
                    "STRING",
                    {
                        "forceInput": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "LoRA触发词",
                        "tooltip": "由 GJJ_LoraChainConfig 自动广播的 LoRA 触发词；有值时会添加到正向提示词。",
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
            "lora_triggers",
            "negative_prompt",
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
        text_encoder=None,
        positive_prompt="",
        force_offload=FORCE_OFFLOAD_AFTER_ENCODE,
        use_disk_cache=USE_DISK_CACHE,
        device=ENCODE_DEVICE,
        zero_conditioning=False,
        translation_device="auto",
        translation_unload_after_use=False,
        translation_enabled=False,
        model_to_offload=None,
        negative_prompt=NEGATIVE_PROMPT,
        lora_triggers="",
        extender_args=None,
        unique_id=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        if text_encoder is None:
            text_encoder = kwargs.get("t5", None)
        negative_prompt = str(negative_prompt or "")
        positive_prompt = str(positive_prompt or "")
        positive_prompt = append_lora_triggers_to_positive_prompt(positive_prompt, lora_triggers)
        force_offload = as_bool(force_offload)
        use_disk_cache = as_bool(use_disk_cache)
        device = _normalize_encode_device(device)
        zero_conditioning = as_bool(zero_conditioning)
        translation_enabled = as_bool(translation_enabled)
        translation_unload_after_use = as_bool(translation_unload_after_use)
        translation_device = _normalize_translation_device(translation_device)

        if translation_enabled:
            translated = translate_prompt_pair(
                positive=positive_prompt,
                negative=negative_prompt,
                device=translation_device,
                max_length=512,
                batch_size=8,
                unload_after_use=translation_unload_after_use,
                unique_id=unique_id,
                node_name=NODE_DISPLAY_NAME,
            )
            positive_prompt = str(translated.get("positive", "") or "")
            negative_prompt = str(translated.get("negative", "") or "")
            send_translated_prompt(unique_id, event_name=TRANSLATED_EVENT, positive=positive_prompt, negative=negative_prompt)

        print("[GJJ WanVideoTextEncode] ========== 开始编码文本 ==========")
        encoder_name = ""
        if isinstance(text_encoder, dict):
            encoder_name = str(text_encoder.get("name", "") or "")
        print(f"[GJJ WanVideoTextEncode] T5编码器: {encoder_name or 'WANTEXTENCODER'}")
        print("[GJJ WanVideoTextEncode] 使用空负向提示词" if not negative_prompt else "[GJJ WanVideoTextEncode] 使用外部负向提示词")
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
            context, context_null = _get_cached_text_embeds(positive_prompt, negative_prompt)
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
            negative_prompt=negative_prompt,
            t5=text_encoder,
            force_offload=force_offload,
            model_to_offload=model_to_offload,
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
                negative_prompt,
            )

        print("[GJJ WanVideoTextEncode] ========== 编码完成 ==========")
        return (prompt_embeds_dict,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanVideoTextEncodeCached}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
