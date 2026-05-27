from __future__ import annotations

import json
import math

import torch

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE
from .gjj_ollama_common import (
    DEFAULT_OLLAMA_HOST,
    extract_final_answer,
    model_options_with_fallback,
    normalize_ollama_host,
    request_chat,
    resolve_model,
    send_ollama_status,
    tensor_to_png_base64,
    unload_model,
)

DEFAULT_OLLAMA_ASSISTANT_MODEL = "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:4b"
DEFAULT_USER_PROMPT = ""
NODE_NAME = "GJJ_OllamaAssistant"
DEFAULT_TEMPERATURE = 0.7
DEFAULT_MAX_TOKENS = 1024
OLLAMA_ASSISTANT_TIMEOUT = 300
IMAGE_INPUT_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
DEFAULT_SYSTEM_PROMPT_TEMPLATES = "\n\n".join([
    "【🧡图片反推】准确识别参考图片中的主体、人物外貌、服装、动作、场景结构、镜头构图、光线、色调、材质和关键细节，整理为可直接用于图像或视频生成的连贯画面描述。",
    "【🎬分镜延展】基于参考图片或输入描述生成连续分镜内容，保持人物身份、核心服装、场景和整体色调一致，同时推动镜头、构图、动作、表情与环境变化，使相邻画面自然衔接且具有叙事进展。",
    "【🌏中译英】将输入内容精准翻译为英文，保持原有语序结构、提示词权重符号、专有名词和画面语义；使用适合 AI 图像与视频生成的自然英文表达。",
])
DEFAULT_SYSTEM_PROMPT_OUTPUT_RULE = "只输出结果文字，不输出解释、分析过程、标题、Markdown 代码块或提示性前缀。"
DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT = (
    "准确识别参考图片中的主体、人物外貌、服装、动作、场景结构、镜头构图、光线、色调、材质和关键细节，"
    "整理为可直接用于图像或视频生成的连贯画面描述。\n"
    f"{DEFAULT_SYSTEM_PROMPT_OUTPUT_RULE}"
)


def _coerce_choice(value, allowed: tuple[str, ...], fallback: str) -> str:
    text = str(value or "").strip()
    return text if text in allowed else fallback


def _coerce_float(value, fallback: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def _coerce_int(value, fallback: int, minimum: int = 1, maximum: int = 8192) -> int:
    try:
        result = int(float(value))
    except (TypeError, ValueError):
        return fallback
    if result < minimum:
        return minimum
    if result > maximum:
        return maximum
    return result


def _ollama_assistant_model_options() -> list[str]:
    models = [
        str(item or "").strip()
        for item in model_options_with_fallback()
        if str(item or "").strip()
    ]
    ordered = [DEFAULT_OLLAMA_ASSISTANT_MODEL]
    for name in models:
        if name not in ordered:
            ordered.append(name)
    return ordered or [""]


def build_messages(system_prompt: str, user_prompt: str, image_b64: str | None = None):
    messages = []
    system_prompt = (system_prompt or "").strip()
    user_prompt = (user_prompt or "").strip()

    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    if not user_prompt and image_b64:
        user_prompt = "请根据提供的参考图片完成所选任务。"
    if not user_prompt:
        raise RuntimeError("请填写指令或原文；视觉任务也可以接入图片后直接执行。")
    user_message = {"role": "user", "content": user_prompt}
    if image_b64:
        user_message["images"] = [image_b64]
    messages.append(user_message)
    return messages


def _collect_images(image=None) -> list[torch.Tensor]:
    source = image
    if not isinstance(source, torch.Tensor):
        return []
    tensor = source.detach()
    if tensor.ndim == 3:
        return [tensor]
    if tensor.ndim != 4:
        return []
    return [tensor[index : index + 1] for index in range(int(tensor.shape[0]))]


def _format_batch_content(results: list[str]) -> str:
    if not results:
        return ""
    if len(results) == 1:
        return results[0]
    sections: list[str] = []
    for index, content in enumerate(results, start=1):
        sections.append(f"【图片 {index}】\n{content.strip()}")
    return "\n\n".join(sections)


class GJJ_OllamaAssistant:
    CATEGORY = "GJJ/LLM"
    FUNCTION = "run"
    DESCRIPTION = "统一调用本机 Ollama 完成文本生成、提示词翻译与可选图片理解任务；通过模板按钮快速切换系统提示词。"
    SEARCH_ALIASES = ["ollama", "assistant", "提示词", "翻译", "图片反推", "文本生成"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("生成文本",)
    OUTPUT_TOOLTIPS = ("Ollama 根据当前模板、指令与可选图片生成的文本结果。",)

    @classmethod
    def INPUT_TYPES(cls):
        model_options = _ollama_assistant_model_options()
        default_model = model_options[0] if model_options else ""
        return {
            "required": {
                "ollama_host": ("STRING", {
                    "default": DEFAULT_OLLAMA_HOST,
                    "multiline": False,
                    "display_name": "Ollama 完整地址",
                    "tooltip": "整体填写完整地址，格式为 http://127.0.0.1:端口 。示例：http://127.0.0.1:11434",
                }),
                "model": (model_options, {
                    "default": default_model,
                    "display_name": "Ollama 模型",
                    "tooltip": "从本地 Ollama 已安装模型中选择一个模型；接入图片时需要模型支持视觉理解。",
                }),
                "model_keep_alive": (["保持模型", "卸载模型"], {
                    "default": "保持模型",
                    "display_name": "模型处理",
                    "tooltip": "分析完成后保持模型常驻，或立即卸载模型。",
                }),
                "thinking_mode": (["关闭思考", "开启思考"], {
                    "default": "关闭思考",
                    "display_name": "思考模式",
                    "tooltip": "是否允许支持思考的多模态模型先推理再输出结果。",
                }),
                "temperature": ("FLOAT", {
                    "default": DEFAULT_TEMPERATURE,
                    "min": 0.0,
                    "max": 2.0,
                    "step": 0.1,
                    "display_name": "温度",
                    "tooltip": "数值越高结果越发散，越低越稳定。",
                }),
                "max_tokens": ("INT", {
                    "default": DEFAULT_MAX_TOKENS,
                    "min": 16,
                    "max": 8192,
                    "step": 1,
                    "display_name": "最大生成长度",
                    "tooltip": "限制模型最多生成多少 token。",
                }),
                "system_prompt": ("STRING", {
                    "default": DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT,
                    "multiline": True,
                    "display_name": "系统提示词",
                    "tooltip": "由模板按钮快速填入，也可以自定义任务规则与输出目标。",
                }),
                "system_prompt_templates": ("STRING", {
                    "default": DEFAULT_SYSTEM_PROMPT_TEMPLATES,
                    "multiline": True,
                    "display_name": "系统提示词模板",
                    "tooltip": "格式为【按钮标题】系统提示词正文；用空行或单独一行 --- 分隔不同模板，增删块即可增删前台按钮。",
                    "hidden": True,
                    "display": "hidden",
                }),
                "system_prompt_output_rule": ("STRING", {
                    "default": DEFAULT_SYSTEM_PROMPT_OUTPUT_RULE,
                    "multiline": True,
                    "display_name": "输出约束",
                    "tooltip": "点击模板按钮时，会把这段文字追加到系统提示词正文之后；可按需要修改或留空。",
                    "hidden": True,
                    "display": "hidden",
                }),
                "user_prompt": ("STRING", {
                    "default": DEFAULT_USER_PROMPT,
                    "multiline": True,
                    "display_name": "指令 / 原文",
                    "tooltip": "输入需要生成、翻译或结合图片处理的内容；只接图片时可以留空。",
                }),
            },
            "optional": {
                "image": (IMAGE_INPUT_TYPE, {
                    "display_name": "可选图片 / 批量图片",
                    "tooltip": "可选。兼容普通 IMAGE 与 GJJ 批量图片；多张输入会逐张处理并按图片序号合并文本。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def run(
        self,
        ollama_host,
        model,
        model_keep_alive,
        thinking_mode,
        temperature,
        max_tokens,
        system_prompt,
        system_prompt_templates,
        system_prompt_output_rule,
        user_prompt,
        image=None,
        unique_id=None,
        **_kwargs,
    ):
        send_ollama_status(unique_id, "1/3 检查 Ollama 参数与任务...", 0.08)
        configured_host = normalize_ollama_host(ollama_host or DEFAULT_OLLAMA_HOST)
        model_keep_alive = _coerce_choice(model_keep_alive, ("保持模型", "卸载模型"), "保持模型")
        thinking_mode = _coerce_choice(thinking_mode, ("关闭思考", "开启思考"), "关闭思考")
        temperature = _coerce_float(temperature, DEFAULT_TEMPERATURE)
        max_tokens = _coerce_int(max_tokens, DEFAULT_MAX_TOKENS, minimum=16, maximum=8192)
        chosen_model = resolve_model(model, host=configured_host)
        images = _collect_images(image=image)
        task_items: list[torch.Tensor | None] = images if images else [None]

        results: list[str] = []
        total = len(task_items)
        has_images = bool(images)
        for index, item in enumerate(task_items, start=1):
            image_b64 = tensor_to_png_base64(item) if isinstance(item, torch.Tensor) else None
            payload = {
                "model": chosen_model,
                "messages": build_messages(system_prompt, user_prompt, image_b64),
                "stream": False,
                "think": thinking_mode == "开启思考",
                "options": {
                    "temperature": float(temperature),
                    "num_predict": int(max_tokens),
                },
            }

            progress = 0.12 + 0.76 * ((index - 1) / max(1, total))
            task_label = f"图片 {index}/{total}" if has_images else "文本任务"
            send_ollama_status(unique_id, f"2/3 正在处理{task_label}...", progress)
            response = request_chat(
                payload,
                error_label=f"Ollama {task_label}请求",
                host=configured_host,
                timeout=OLLAMA_ASSISTANT_TIMEOUT,
            )
            content = extract_final_answer(response).strip()

            if not content and thinking_mode == "开启思考":
                fallback_payload = dict(payload)
                fallback_payload["think"] = False
                send_ollama_status(unique_id, f"2/3 {task_label}思考结果为空，正在回退为直出模式...", progress + 0.03)
                fallback_response = request_chat(
                    fallback_payload,
                    error_label=f"Ollama {task_label}回退请求",
                    host=configured_host,
                    timeout=OLLAMA_ASSISTANT_TIMEOUT,
                )
                content = extract_final_answer(fallback_response).strip()

            if not content:
                content = json.dumps(response, ensure_ascii=False)
            results.append(content)

        content = _format_batch_content(results)

        if model_keep_alive == "卸载模型":
            try:
                send_ollama_status(unique_id, "3/3 正在卸载本次模型...", 0.9)
                unload_model(chosen_model, host=configured_host)
            except Exception as exc:
                raise RuntimeError(f"Ollama 任务已完成，但卸载模型失败：{exc}") from exc

        completion = f"图片任务完成：{len(results)} 张" if has_images else "文本任务完成"
        send_ollama_status(unique_id, f"3/3 {completion}", 1.0)
        return (content,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_OllamaAssistant}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🤖 本机Ollama助手"}
