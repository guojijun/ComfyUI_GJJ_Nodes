from __future__ import annotations

import json
import time
from typing import Any

from .gjj_ollama_common import (
    DEFAULT_OLLAMA_HOST,
    DEFAULT_SYSTEM_PROMPT,
    extract_final_answer,
    model_options_with_fallback,
    normalize_ollama_host,
    request_chat,
    resolve_model,
    send_ollama_status,
    unload_model,
)

NODE_NAME = "GJJ_PromptGeneration"


def build_messages(system_prompt: str, user_prompt: str):
    messages = []
    system_prompt = (system_prompt or "").strip()
    user_prompt = (user_prompt or "").strip()

    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    if user_prompt:
        messages.append({"role": "user", "content": user_prompt})
    if not messages:
        raise RuntimeError("系统提示词和用户提示词不能同时为空。")
    return messages


class GJJ_PromptGeneration:
    CATEGORY = "GJJ/LLM"
    FUNCTION = "generate"
    DESCRIPTION = "调用本地 Ollama 模型生成提示词或文本内容，适合快速草拟文生图提示词与创作方向。"
    SEARCH_ALIASES = ["prompt generation", "ollama", "提示词", "生成", "文本生成"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示生成结果",)
    OUTPUT_TOOLTIPS = ("模型生成的最终文本结果，通常为提示词正文。",)

    @classmethod
    def INPUT_TYPES(cls):
        model_options = model_options_with_fallback()
        default_model = model_options[0] if model_options else ""
        return {
            "required": {
                "model": (model_options, {
                    "default": default_model,
                    "display_name": "Ollama 模型",
                    "tooltip": "从本地 Ollama 已安装模型中选择一个用于文本生成。",
                }),
                "model_keep_alive": (["保持模型", "卸载模型"], {
                    "default": "保持模型",
                    "display_name": "模型处理",
                    "tooltip": "生成完成后保持模型常驻，或立即卸载模型。",
                }),
                "thinking_mode": (["关闭思考", "开启思考"], {
                    "default": "关闭思考",
                    "display_name": "思考模式",
                    "tooltip": "是否允许支持思考的模型先进行推理再输出结果。",
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 4294967294,
                    "display_name": "固定种子",
                    "tooltip": "填 0 表示随机种子；大于 0 表示固定种子。",
                }),
                "temperature": ("FLOAT", {
                    "default": 0.7,
                    "min": 0.0,
                    "max": 2.0,
                    "step": 0.1,
                    "display_name": "温度",
                    "tooltip": "数值越高结果越发散，越低越稳定。",
                }),
                "max_tokens": ("INT", {
                    "default": 512,
                    "min": 16,
                    "max": 8192,
                    "step": 1,
                    "display_name": "最大生成长度",
                    "tooltip": "限制模型最多生成多少 token。",
                }),
                "system_prompt": ("STRING", {
                    "default": DEFAULT_SYSTEM_PROMPT,
                    "multiline": True,
                    "display_name": "系统提示词",
                    "tooltip": "用于设定模型角色、规则和输出风格。",
                }),
                "user_prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "用户提示词",
                    "tooltip": "输入本次希望模型处理或生成的具体内容。",
                }),
                "ollama_host": ("STRING", {
                    "default": DEFAULT_OLLAMA_HOST,
                    "multiline": False,
                    "display_name": "Ollama 完整地址",
                    "tooltip": "整体填写完整地址，格式为 http://127.0.0.1:端口 。示例：http://127.0.0.1:11434",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, model, model_keep_alive, thinking_mode, seed, temperature, max_tokens, system_prompt, user_prompt, ollama_host):
        if int(seed or 0) == 0:
            return float("NaN")
        return "|".join(
            [
                str(model),
                str(model_keep_alive),
                str(thinking_mode),
                str(seed),
                str(temperature),
                str(max_tokens),
                str(system_prompt),
                str(user_prompt),
                str(ollama_host),
            ]
        )

    def generate(self, model, model_keep_alive, thinking_mode, seed, temperature, max_tokens, system_prompt, user_prompt, ollama_host, unique_id=None):
        send_ollama_status(unique_id, "1/3 检查参数与模型...", 0.08)
        configured_host = normalize_ollama_host(ollama_host or DEFAULT_OLLAMA_HOST)
        options: dict[str, Any] = {
            "temperature": float(temperature),
            "num_predict": int(max_tokens),
        }
        if int(seed) > 0:
            options["seed"] = int(seed)
        else:
            options["seed"] = int(time.time_ns() & 0xFFFFFFFF)

        chosen_model = resolve_model(model, host=configured_host)
        payload = {
            "model": chosen_model,
            "messages": build_messages(system_prompt, user_prompt),
            "stream": False,
            "think": thinking_mode == "开启思考",
            "options": options,
        }

        send_ollama_status(unique_id, "2/3 正在请求本机 Ollama 生成内容...", 0.56)
        response = request_chat(payload, error_label="Ollama 提示词生成请求", host=configured_host)
        content = extract_final_answer(response).strip()

        if not content and thinking_mode == "开启思考":
            fallback_payload = dict(payload)
            fallback_payload["think"] = False
            send_ollama_status(unique_id, "2/3 思考结果为空，正在回退为直出模式...", 0.72)
            fallback_response = request_chat(
                fallback_payload,
                error_label="Ollama 提示词生成回退请求",
                host=configured_host,
            )
            content = extract_final_answer(fallback_response).strip()

        if not content:
            content = json.dumps(response, ensure_ascii=False)

        if model_keep_alive == "卸载模型":
            try:
                send_ollama_status(unique_id, "3/3 正在卸载本次模型...", 0.9)
                unload_model(chosen_model, host=configured_host)
            except Exception as exc:
                raise RuntimeError(f"提示词已生成，但卸载模型失败：{exc}") from exc

        send_ollama_status(unique_id, "3/3 提示词生成完成", 1.0)
        return (content,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_PromptGeneration}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 💬 本机Ollama提示词生成器"}
