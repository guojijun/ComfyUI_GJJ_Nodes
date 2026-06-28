from __future__ import annotations

import base64
import gc
import importlib
import inspect
import io
import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

try:
    import comfy.model_management as mm
except Exception:
    mm = None

try:
    from aiohttp import web
    from server import PromptServer
except Exception:
    web = None
    PromptServer = None

try:
    from llama_cpp import Llama
except Exception:
    Llama = None

try:
    from llama_cpp import GGML_TYPE_Q8_0
except Exception:
    GGML_TYPE_Q8_0 = 8

try:
    from llama_cpp.llama_chat_format import Qwen3VLChatHandler
except Exception:
    Qwen3VLChatHandler = None

try:
    from llama_cpp.llama_chat_format import Qwen35ChatHandler
except Exception:
    Qwen35ChatHandler = None

try:
    from llama_cpp.llama_chat_format import Gemma4ChatHandler
except Exception:
    Gemma4ChatHandler = None

from .gjj_llama_common import (
    MISSING_LLM_MODEL,
    NO_MMPROJ,
    best_mmproj_for_main_model,
    llm_main_model_options,
    llm_mmproj_options,
    llm_model_catalog,
    resolve_llm_path,
)
from .common_utils.dependency_checker import (
    build_dependency_model_report,
    build_node_help_payload,
    get_pip_install_command_text,
    raise_dependency_model_error,
)
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_LlamaAssistant"
DEFAULT_IMAGE_PROMPT = ""
DEFAULT_TEXT_PROMPT = "请根据输入内容直接给出结果。"
DEFAULT_TEXT_SYSTEM_PROMPT = "你是一个严谨、直接的本地文本助手。请只输出最终结果。"
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
DEFAULT_ASSISTANT_TEMPLATES = [
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
DEFAULT_IMAGE_SYSTEM_PROMPT = f"{DEFAULT_ASSISTANT_TEMPLATES[0]['prompt']}\n{DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE}"
DEFAULT_SYSTEM_PROMPT_TEMPLATES = "\n\n".join(
    f"【{item['title']}】{item['prompt']}" for item in DEFAULT_ASSISTANT_TEMPLATES
)
DEFAULT_CACHE_TYPE = "默认(F16)"
Q8_CACHE_TYPE = "q8_0"
CACHE_TYPE_OPTIONS = [DEFAULT_CACHE_TYPE, Q8_CACHE_TYPE]


def _ollama_assistant_preset_value(key: str, fallback: str) -> str:
    try:
        path = Path(__file__).resolve().parents[1] / "presets" / "gjj_user_settings.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        section = data.get("ollama_assistant") if isinstance(data, dict) else {}
        value = section.get(key) if isinstance(section, dict) else None
        return str(value).strip() or fallback
    except Exception:
        return fallback


def _hidden_options(**options: Any) -> dict[str, Any]:
    result = dict(options)
    result["hidden"] = True
    result["display"] = "hidden"
    return result


LLAMA_CPP_DEPENDENCY = {
    "module_name": "llama_cpp",
    "package_name": "llama-cpp-python",
    "display_name": "llama-cpp-python",
    "description": "本地 GGUF/多模态 LLM 推理运行库；不依赖 Ollama，也不依赖第三方自定义节点。",
}
LLAMA_CPP_UPDATE_PACKAGE = '"llama-cpp-python>=0.3.40"'
LLAMA_CPP_UPDATE_COMMAND = get_pip_install_command_text(packages=[LLAMA_CPP_UPDATE_PACKAGE])
_LLAMA_DEPENDENCY_REPORT = build_dependency_model_report(
    node_name=NODE_NAME,
    missing_dependencies=[] if Llama is not None else [LLAMA_CPP_DEPENDENCY],
    install_packages=[LLAMA_CPP_DEPENDENCY["package_name"]],
    description=(
        "GJJ 零第三方自定义节点 LLAMA 工具只依赖当前 ComfyUI Python 环境中的运行库，"
        "不会调用 comfyUI-llama-TE 或其他第三方自定义节点。"
    ),
)
_GJJ_HELP = build_node_help_payload(
    description="不依赖 Ollama 服务、不依赖第三方自定义节点的单节点 LLAMA 助手；需要当前 Python 环境安装 llama-cpp-python 运行库。",
    dependencies=[
        {
            "name": "llama-cpp-python",
            "type": "运行依赖",
            "required": True,
            "description": "用于加载 models/LLM 下的 GGUF 主模型和 mmproj 视觉投影。",
        }
    ],
    model_tree=[
        {
            "label": "主模型",
            "path": "models/LLM",
            "kind": "LLM",
            "description": "支持 .gguf / .safetensors / .bin / .pth / .pt；主模型列表会排除 mmproj 文件。",
        },
        {
            "label": "视觉模型 mmproj",
            "path": "models/LLM",
            "kind": "mmproj",
            "required": False,
            "description": "文件名包含 mmproj 的 .gguf / .safetensors / .bin；选择主模型后前端会自动匹配。",
        },
    ],
    runtime=[
        "无第三方自定义节点依赖。",
        "模型扫描使用 GJJ 公共函数注册并读取 ComfyUI/models/LLM。",
        "缺少 llama-cpp-python 时使用 GJJ 公共依赖提示面板显示安装命令。",
    ],
    install_cmd=_LLAMA_DEPENDENCY_REPORT.get("install_cmd", ""),
    copy_text=_LLAMA_DEPENDENCY_REPORT.get("copy_text", ""),
    copy_label=_LLAMA_DEPENDENCY_REPORT.get("copy_label", ""),
    notice=_LLAMA_DEPENDENCY_REPORT.get("warning_message", ""),
    extra={
        "warning_message": _LLAMA_DEPENDENCY_REPORT.get("warning_message", ""),
        "panel_message": _LLAMA_DEPENDENCY_REPORT.get("panel_message", ""),
        "notice_level": _LLAMA_DEPENDENCY_REPORT.get("notice_level", ""),
    },
)


def _call_chat_completion(llm, *, messages, params: dict[str, Any]) -> dict[str, Any]:
    kwargs = dict(params or {})
    kwargs["messages"] = messages

    try:
        sig = inspect.signature(llm.create_chat_completion)
        allowed = sig.parameters
        has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in allowed.values())
    except Exception:
        allowed = {}
        has_var_kw = True

    if not has_var_kw:
        kwargs = {key: value for key, value in kwargs.items() if key in allowed}
    elif "presence_penalty" in kwargs and "presence_penalty" not in allowed and "present_penalty" in allowed:
        kwargs["present_penalty"] = kwargs.pop("presence_penalty")

    return llm.create_chat_completion(**kwargs)


def _normalize_seed(value: Any) -> int | None:
    try:
        seed = int(value)
    except Exception:
        return None
    return seed if seed >= 0 else None


def _cache_type(value: str | None) -> int | None:
    if not value or value == DEFAULT_CACHE_TYPE:
        return None
    if value == Q8_CACHE_TYPE:
        return GGML_TYPE_Q8_0
    raise ValueError(f"未知 KV 缓存类型：{value}")


def _infer_model_family(main_model: Any, mmproj_model: Any = "") -> str:
    text = f"{main_model or ''} {mmproj_model or ''}".lower()
    normalized = re.sub(r"[^a-z0-9.]+", "", text)
    if "gemma" in normalized:
        return "Gemma4"
    if any(token in normalized for token in ("qwen3.6", "qwen36", "qwen3vl6", "qwen3.6vl")):
        return "Qwen3.6-VL"
    if any(token in normalized for token in ("qwen3.5", "qwen35", "qwen3vl5", "qwen3.5vl")):
        return "Qwen3.5-VL"
    if "qwen3" in normalized:
        return "Qwen3-VL"
    return "通用"


def _infer_input_mode(image: Any) -> str:
    if image is None:
        return "文本"
    try:
        count = int(image.shape[0])
    except Exception:
        count = 1
    return "图片" if count <= 1 else "逐帧"


def _llama_init_supports(param_name: str) -> bool | None:
    if Llama is None:
        return None
    try:
        return param_name in inspect.signature(Llama.__init__).parameters
    except Exception:
        return None


def _image_to_base64(image_tensor, index: int, max_edge: int) -> str:
    if image_tensor is None:
        return ""
    if index < 0 or index >= int(image_tensor.shape[0]):
        return ""
    image = image_tensor[index].detach().cpu().numpy()
    image = np.clip(image * 255.0, 0, 255).astype(np.uint8)
    pil = Image.fromarray(image)
    if pil.mode != "RGB":
        pil = pil.convert("RGB")
    if max_edge > 0:
        width, height = pil.size
        long_edge = max(width, height)
        if long_edge > max_edge:
            scale = max_edge / float(long_edge)
            pil = pil.resize(
                (max(1, int(round(width * scale))), max(1, int(round(height * scale)))),
                resample=Image.BICUBIC,
            )
    buffer = io.BytesIO()
    pil.save(buffer, format="JPEG", quality=90)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _clear_llm_state(llm) -> None:
    for path, method in [
        ("_ctx", "memory_clear"),
        ("_hybrid_cache_mgr", "clear"),
        ("_batch", "reset"),
    ]:
        try:
            target = getattr(llm, path, None)
            action = getattr(target, method, None)
            if callable(action):
                action(True) if method == "memory_clear" else action()
        except Exception:
            pass
    try:
        reset = getattr(llm, "reset", None)
        if callable(reset):
            reset()
        elif hasattr(llm, "n_tokens"):
            llm.n_tokens = 0
    except Exception:
        pass


def _strip_think(text: str) -> str:
    cleaned = "" if text is None else str(text)
    cleaned = re.sub(r"<think\b[^>]*>.*?</think>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)
    if re.search(r"</think>", cleaned, flags=re.IGNORECASE):
        cleaned = re.sub(r"^.*?</think>\s*", "", cleaned, count=1, flags=re.DOTALL | re.IGNORECASE)
    return cleaned.replace("<think>", "").replace("</think>", "").strip()


def _extract_text(response: Mapping[str, Any]) -> str:
    try:
        return str(response["choices"][0]["message"]["content"])
    except Exception:
        return str(response)


def _create_qwen35_handler(mmproj_path: str, *, enable_thinking: bool, preserve_thinking: bool, unique_id: Any = None):
    handler_cls = Qwen35ChatHandler
    if handler_cls is None:
        handler_cls = _first_available_chat_handler(
            "Qwen2VLChatHandler",
            "Qwen25VLChatHandler",
            "Llava15ChatHandler",
            "Llava16ChatHandler",
        )
    if handler_cls is None:
        _raise_llama_cpp_version_error("Qwen3.5/3.6-VL 视觉 ChatHandler", unique_id=unique_id)
    for kwargs in [
        {"clip_model_path": mmproj_path, "enable_thinking": enable_thinking, "add_vision_id": True, "preserve_thinking": preserve_thinking, "verbose": False},
        {"clip_model_path": mmproj_path, "enable_thinking": enable_thinking, "preserve_thinking": preserve_thinking, "verbose": False},
        {"clip_model_path": mmproj_path, "enable_thinking": enable_thinking, "verbose": False},
        {"clip_model_path": mmproj_path, "verbose": False},
    ]:
        try:
            return handler_cls(**kwargs)
        except TypeError:
            continue
    return handler_cls(clip_model_path=mmproj_path, verbose=False)


def _first_available_chat_handler(*names: str):
    try:
        chat_format = importlib.import_module("llama_cpp.llama_chat_format")
    except Exception:
        return None
    for name in names:
        handler_cls = getattr(chat_format, name, None)
        if handler_cls is not None:
            return handler_cls
    return None


def _raise_llama_cpp_version_error(feature: str, *, unique_id: Any = None):
    raise_dependency_model_error(
        NODE_NAME,
        missing_dependencies=[
            {
                **LLAMA_CPP_DEPENDENCY,
                "display_name": f"llama-cpp-python >= 0.3.40（缺少 {feature}）",
                "description": "当前版本已安装但视觉模型接口不完整，需要更新运行库；不需要安装第三方自定义节点。",
            }
        ],
        install_packages=[LLAMA_CPP_UPDATE_PACKAGE],
        description=(
            "本节点是零第三方自定义节点依赖，但本地 GGUF/多模态推理必须依赖 "
            "llama-cpp-python 运行库。当前版本缺少所选模型族需要的视觉 ChatHandler。"
        ),
        original_error=f"缺少 {feature}",
        unique_id=unique_id,
        title="GJJ 节点运行库版本不兼容！",
        copy_text=LLAMA_CPP_UPDATE_COMMAND,
        copy_label="📋 复制更新命令",
    )


def _create_chat_handler(family: str, mmproj_path: str, thinking: bool, preserve_thinking: bool, *, unique_id: Any = None):
    if family == "Qwen3-VL":
        handler_cls = Qwen3VLChatHandler or _first_available_chat_handler(
            "Qwen25VLChatHandler",
            "Qwen2VLChatHandler",
            "Llava16ChatHandler",
            "Llava15ChatHandler",
        )
        if handler_cls is None:
            _raise_llama_cpp_version_error("Qwen3VLChatHandler", unique_id=unique_id)
        for kwargs in [
            {"clip_model_path": mmproj_path, "force_reasoning": thinking, "verbose": False},
            {"clip_model_path": mmproj_path, "use_think_prompt": thinking, "verbose": False},
            {"clip_model_path": mmproj_path, "verbose": False},
        ]:
            try:
                return handler_cls(**kwargs)
            except TypeError:
                continue
        return handler_cls(clip_model_path=mmproj_path, verbose=False)
    if family in {"Qwen3.5-VL", "Qwen3.6-VL"}:
        return _create_qwen35_handler(mmproj_path, enable_thinking=thinking, preserve_thinking=preserve_thinking, unique_id=unique_id)
    if family == "Gemma4":
        if Gemma4ChatHandler is None:
            raise RuntimeError("当前 llama-cpp-python 不支持 Gemma4ChatHandler，请安装带 Gemma4 支持的版本。")
        return Gemma4ChatHandler(clip_model_path=mmproj_path, verbose=False)
    handler_cls = _first_available_chat_handler(
        "Qwen35ChatHandler",
        "Qwen3VLChatHandler",
        "Qwen25VLChatHandler",
        "Qwen2VLChatHandler",
        "Llava16ChatHandler",
        "Llava15ChatHandler",
    )
    if handler_cls is None:
        _raise_llama_cpp_version_error("通用视觉 ChatHandler", unique_id=unique_id)
    for kwargs in [
        {"clip_model_path": mmproj_path, "enable_thinking": thinking, "preserve_thinking": preserve_thinking, "verbose": False},
        {"clip_model_path": mmproj_path, "force_reasoning": thinking, "verbose": False},
        {"clip_model_path": mmproj_path, "verbose": False},
    ]:
        try:
            return handler_cls(**kwargs)
        except TypeError:
            continue
    return handler_cls(clip_model_path=mmproj_path, verbose=False)


@dataclass
class _LoadedLlama:
    llm: object
    settings: dict[str, Any]
    chat_handler: object | None = None


class _LlamaStorage:
    model: _LoadedLlama | None = None

    @classmethod
    def unload(cls) -> None:
        try:
            close = getattr(getattr(cls.model, "llm", None), "close", None)
            if callable(close):
                close()
        except Exception:
            pass
        cls.model = None
        gc.collect()
        if mm is not None:
            try:
                mm.soft_empty_cache()
            except Exception:
                pass

    @classmethod
    def load(cls, config: dict[str, Any]) -> _LoadedLlama:
        if Llama is None:
            raise_dependency_model_error(
                NODE_NAME,
                missing_dependencies=[LLAMA_CPP_DEPENDENCY],
                install_packages=[LLAMA_CPP_DEPENDENCY["package_name"]],
                description=(
                    "本节点不依赖 Ollama 服务或第三方自定义节点，但需要 llama-cpp-python "
                    "作为本地 LLAMA/GGUF 推理运行库。"
                ),
                unique_id=config.get("unique_id"),
            )
        unique_id = config.get("unique_id")
        config = dict(config)
        config.pop("unique_id", None)
        if cls.model and cls.model.settings == config:
            return cls.model

        cls.unload()
        model_path = resolve_llm_path(config["model"])
        if not model_path or not os.path.exists(model_path):
            raise FileNotFoundError(f"找不到主模型：{model_path or config['model']}")

        mmproj_path = ""
        mmproj = str(config.get("mmproj") or NO_MMPROJ)
        if mmproj and mmproj != NO_MMPROJ:
            mmproj_path = resolve_llm_path(mmproj)
            if not mmproj_path or not os.path.exists(mmproj_path):
                raise FileNotFoundError(f"找不到视觉投影 mmproj：{mmproj_path or mmproj}")

        chat_handler = None
        if mmproj_path:
            chat_handler = _create_chat_handler(
                str(config.get("family") or "Qwen3.6-VL"),
                mmproj_path,
                bool(config.get("thinking")),
                bool(config.get("preserve_thinking")),
                unique_id=unique_id,
            )

        llama_kwargs = {
            "model_path": model_path,
            "n_ctx": int(config.get("n_ctx") or 8192),
            "n_gpu_layers": int(config.get("n_gpu_layers") or -1),
            "verbose": False,
        }
        if chat_handler is not None:
            llama_kwargs["chat_handler"] = chat_handler
        cache_k = _cache_type(config.get("cache_type_k"))
        cache_v = _cache_type(config.get("cache_type_v"))
        if cache_k is not None:
            llama_kwargs["type_k"] = cache_k
        if cache_v is not None:
            llama_kwargs["type_v"] = cache_v
        if config.get("family") == "Qwen3.6-VL" and _llama_init_supports("n_cpu_moe") and int(config.get("n_cpu_moe") or 0) > 0:
            llama_kwargs["n_cpu_moe"] = int(config.get("n_cpu_moe") or 0)
        if config.get("family") == "Qwen3.6-VL" and _llama_init_supports("cpu_moe"):
            llama_kwargs["cpu_moe"] = bool(config.get("cpu_moe"))

        cls.model = _LoadedLlama(Llama(**llama_kwargs), dict(config), chat_handler)
        return cls.model


async def _get_llama_models(_request):
    return web.json_response(llm_model_catalog())


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None and web is not None:
    server = PromptServer.instance
    if not getattr(server, "_gjj_llama_models_api_registered", False):
        server.routes.get("/gjj/llama_models")(_get_llama_models)
        server._gjj_llama_models_api_registered = True


class GJJ_LlamaAssistant:
    CATEGORY = "GJJ"
    FUNCTION = "run"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    OUTPUT_TOOLTIPS = ("本地 llama.cpp 模型生成的文本。",)
    DESCRIPTION = "零第三方自定义节点依赖的单节点 LLAMA 助手：从 models/LLM 选择主模型和 mmproj，支持文本、图片、逐帧与视频抽帧推理。"
    SEARCH_ALIASES = ["llama assistant", "llama cpp", "qwen vl", "gemma4", "本地llama", "零依赖llama"]
    GJJ_HELP = _GJJ_HELP

    @classmethod
    def INPUT_TYPES(cls):
        sampling = DEFAULT_OLLAMA_ASSISTANT_SAMPLING
        main_models = llm_main_model_options()
        mmprojs = llm_mmproj_options()
        default_main = main_models[0]
        default_mmproj = best_mmproj_for_main_model(default_main, mmprojs)
        return {
            "required": {
                "main_model": (main_models, _hidden_options(default=default_main, display_name="主模型", tooltip="读取 ComfyUI/models/LLM 下的主模型文件。")),
                "mmproj_model": (mmprojs, _hidden_options(default=default_mmproj, display_name="视觉模型 mmproj", tooltip="选择主模型后前端会自动切换更匹配的 mmproj；纯文本可选“无”。")),
                "model_keep_alive": (["保持模型", "卸载模型"], _hidden_options(default="保持模型", display_name="模型处理")),
                "thinking_mode": (["关闭思考", "开启思考"], _hidden_options(default="关闭思考", display_name="思考模式")),
                "temperature": ("FLOAT", _hidden_options(default=sampling["temperature"], min=0.0, max=2.0, step=0.01, display_name="温度")),
                "max_tokens": ("INT", _hidden_options(default=sampling["max_tokens"], min=16, max=8192, step=1, display_name="最大生成长度")),
                "seed_mode": (["每次随机", "固定种子"], _hidden_options(default=sampling["seed_mode"], display_name="种子模式")),
                "seed": ("INT", _hidden_options(default=sampling["seed"], min=0, max=2147483647, step=1, control_after_generate=True, display_name="固定种子")),
                "top_k": ("INT", _hidden_options(default=sampling["top_k"], min=0, max=1000, step=1, display_name="Top K")),
                "top_p": ("FLOAT", _hidden_options(default=sampling["top_p"], min=0.0, max=1.0, step=0.01, display_name="Top P")),
                "min_p": ("FLOAT", _hidden_options(default=sampling["min_p"], min=0.0, max=1.0, step=0.01, display_name="Min P")),
                "presence_penalty": ("FLOAT", _hidden_options(default=sampling["presence_penalty"], min=-2.0, max=2.0, step=0.05, display_name="出现惩罚")),
                "frequency_penalty": ("FLOAT", _hidden_options(default=sampling["frequency_penalty"], min=-2.0, max=2.0, step=0.05, display_name="频率惩罚")),
                "repeat_penalty": ("FLOAT", _hidden_options(default=sampling["repeat_penalty"], min=0.0, max=3.0, step=0.05, display_name="重复惩罚")),
                "context_length": ("INT", _hidden_options(default=8192, min=1024, max=327680, step=256, display_name="上下文长度")),
                "gpu_layers": ("INT", _hidden_options(default=-1, min=-1, max=9999, step=1, display_name="GPU层数")),
                "max_frames": ("INT", _hidden_options(default=24, min=2, max=1024, step=1, display_name="最多帧数")),
                "max_image_edge": ("INT", _hidden_options(default=1024, min=128, max=16384, step=64, display_name="最大边长")),
                "keep_think": ("BOOLEAN", _hidden_options(default=False, display_name="输出think块")),
                "preserve_history_think": ("BOOLEAN", _hidden_options(default=False, display_name="保留历史think")),
                "cache_type_k": (CACHE_TYPE_OPTIONS, _hidden_options(default=DEFAULT_CACHE_TYPE, display_name="KV缓存K类型")),
                "cache_type_v": (CACHE_TYPE_OPTIONS, _hidden_options(default=DEFAULT_CACHE_TYPE, display_name="KV缓存V类型")),
                "cpu_moe": ("BOOLEAN", _hidden_options(default=False, display_name="MoE专家上CPU")),
                "n_cpu_moe": ("INT", _hidden_options(default=0, min=0, max=256, step=1, display_name="前N层专家上CPU")),
                "system_prompt": ("STRING", _hidden_options(default=DEFAULT_IMAGE_SYSTEM_PROMPT, multiline=True, display_name="系统提示词")),
                "system_prompt_templates": ("STRING", _hidden_options(default=_ollama_assistant_preset_value("system_prompt_templates", DEFAULT_SYSTEM_PROMPT_TEMPLATES), multiline=True, display_name="系统提示词模板")),
                "system_prompt_output_rule": ("STRING", _hidden_options(default=_ollama_assistant_preset_value("system_prompt_output_rule", DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE), multiline=True, display_name="输出约束")),
                "user_prompt": ("STRING", _hidden_options(default=DEFAULT_IMAGE_PROMPT, multiline=True, display_name="指令 / 原文")),
            },
            "optional": {
                "image": (f"{GJJ_BATCH_IMAGE_TYPE},IMAGE", {"display_name": "图片"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def run(
        self,
        main_model,
        mmproj_model,
        model_keep_alive,
        thinking_mode,
        temperature,
        max_tokens,
        seed_mode,
        seed,
        top_k,
        top_p,
        min_p,
        presence_penalty,
        frequency_penalty,
        repeat_penalty,
        context_length,
        gpu_layers,
        max_frames,
        max_image_edge,
        keep_think,
        preserve_history_think,
        cache_type_k,
        cache_type_v,
        cpu_moe,
        n_cpu_moe,
        system_prompt,
        system_prompt_templates,
        system_prompt_output_rule,
        user_prompt,
        image=None,
        unique_id=None,
    ):
        if str(main_model or "").startswith("（请把模型放到"):
            raise RuntimeError("未找到可用模型文件。请把模型放到 ComfyUI/models/LLM/ 后刷新或重启。")

        inferred_family = _infer_model_family(main_model, mmproj_model)
        inferred_mode = _infer_input_mode(image)

        config = {
            "family": inferred_family,
            "model": str(main_model or ""),
            "mmproj": str(mmproj_model or NO_MMPROJ),
            "thinking": str(thinking_mode) == "开启思考",
            "preserve_thinking": bool(preserve_history_think),
            "n_ctx": int(context_length),
            "n_gpu_layers": int(gpu_layers),
            "cache_type_k": cache_type_k,
            "cache_type_v": cache_type_v,
            "cpu_moe": bool(cpu_moe),
            "n_cpu_moe": int(n_cpu_moe),
            "unique_id": unique_id,
        }
        loaded = _LlamaStorage.load(config)
        llm = loaded.llm

        mode = inferred_mode
        system_text = str(system_prompt or "").strip()
        if mode == "文本" and (not system_text or system_text == DEFAULT_IMAGE_SYSTEM_PROMPT):
            system_text = DEFAULT_TEXT_SYSTEM_PROMPT
        elif mode == "视频" and system_text:
            system_text = "请将输入的图片序列当做视频而不是静态帧序列, " + system_text

        messages: list[dict[str, Any]] = []
        if system_text:
            messages.append({"role": "system", "content": system_text})

        total_images = int(image.shape[0]) if image is not None else 0
        if mode in {"图片", "逐帧", "视频"} and total_images <= 0:
            raise ValueError("未检测到图片输入。")
        if mode in {"图片", "逐帧", "视频"} and loaded.chat_handler is None:
            raise RuntimeError("当前模型未加载 mmproj，无法进行图像推理。请为视觉模型 mmproj 选择匹配文件。")

        if mode == "图片":
            frame_indices = [0]
        elif mode == "逐帧":
            frame_indices = list(range(total_images))
        elif mode == "视频":
            if total_images <= 1:
                frame_indices = [0]
            else:
                count = min(max(int(max_frames), 2), total_images)
                frame_indices = np.linspace(0, total_images - 1, count, dtype=int).tolist()
        elif mode == "文本":
            frame_indices = []
        else:
            raise ValueError(f"未知输入模式：{mode}")

        prompt_text = str(user_prompt or "").strip()
        if mode == "文本" and not prompt_text:
            raise ValueError("文本模式下，指令 / 原文不能为空。")

        params = {
            "max_tokens": int(max_tokens),
            "temperature": float(temperature),
            "top_p": float(top_p),
            "top_k": int(top_k),
            "min_p": float(min_p),
            "repeat_penalty": float(repeat_penalty),
            "frequency_penalty": float(frequency_penalty),
            "presence_penalty": float(presence_penalty),
            "seed": None if str(seed_mode) == "每次随机" else _normalize_seed(seed),
            "stream": False,
            "stop": ["</s>"],
        }

        if mode == "文本":
            messages.append({"role": "user", "content": prompt_text})
            _clear_llm_state(llm)
            text = _extract_text(_call_chat_completion(llm, messages=messages, params=params))
        elif mode == "逐帧":
            user_content = [{"type": "text", "text": prompt_text}, {"type": "image_url", "image_url": {"url": ""}}]
            messages.append({"role": "user", "content": user_content})
            parts = []
            for index, frame_index in enumerate(frame_indices):
                if mm is not None and mm.processing_interrupted():
                    raise mm.InterruptProcessingException()
                image_b64 = _image_to_base64(image, frame_index, int(max_image_edge))
                user_content[1]["image_url"]["url"] = f"data:image/jpeg;base64,{image_b64}"
                _clear_llm_state(llm)
                part = _extract_text(_call_chat_completion(llm, messages=messages, params=params))
                parts.append(f"====== 第{index + 1}帧 ======\n{part}".strip() if len(frame_indices) > 1 else part.strip())
            text = "\n\n".join(part for part in parts if part)
        else:
            user_content = [{"type": "text", "text": prompt_text}]
            for frame_index in frame_indices:
                image_b64 = _image_to_base64(image, frame_index, int(max_image_edge))
                user_content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}})
            messages.append({"role": "user", "content": user_content})
            _clear_llm_state(llm)
            text = _extract_text(_call_chat_completion(llm, messages=messages, params=params))

        if not bool(keep_think):
            text = _strip_think(text)

        if mm is not None and mm.processing_interrupted():
            raise mm.InterruptProcessingException()
        if str(model_keep_alive) == "卸载模型":
            _LlamaStorage.unload()

        result = text.lstrip().removeprefix(": ").strip()
        return {
            "ui": {"preview_text": (result,), "preview_kind": ("text",)},
            "result": (result,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LlamaAssistant}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·💙图片反推提示词推理🧠LLAMA"}
