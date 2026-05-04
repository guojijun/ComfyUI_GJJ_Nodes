from __future__ import annotations

import json
import math

import torch

from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
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

DEFAULT_IMAGE_ANALYSIS_MODEL = "fredrezones55/Qwen3.5-Uncensored-HauhauCS-Aggressive:4b"
DEFAULT_IMAGE_ANALYSIS_SYSTEM_PROMPT = """
你是一名影视分镜与图生图提示词设计师，请根据输入图片生成连续分镜提示词，用于Qwen2.5图生图。

【核心目标】
在保持人物一致性的前提下，生成具有明显镜头变化、动作变化和画面差异的分镜，避免画面重复和同质化。

【强制输出规则】

1. 每个分镜仅一行
2. 分镜之间不得有空行
3. 不输出任何解释或多余内容
4. 严格按时间顺序
5. 每行必须使用格式：
   【分镜简介】：详细介绍：含人物、景别、视角、构图、背景、服装、动作、表情

【一致性要求（弱化版）】
以下必须保持一致：

* 人物身份与外貌
* 核心服装（允许细微变化，如褶皱、被风吹动）
* 基础场景（同一条路/同一辆车）

【变化驱动（关键）】
每个分镜必须至少变化2项：

* 视角变化（正面 / 侧面 / 背面 / 俯拍 / 仰拍）
* 构图变化（特写 / 过肩 / 主观视角 / 双人构图）
* 动作变化（转头 / 加速 / 停车 / 手部动作）
* 表情变化（微笑→兴奋→紧张等）
* 环境变化（光线、背景运动、风、速度感）

【强制要求（避免同质化）】

* 不允许连续两个分镜使用相同视角和构图
* 不允许连续静态镜头（必须有动作推进）
* 必须包含至少3种不同镜头类型（如：特写 / 侧面 / 主观视角 / 远景）

【图生图优化】

* 增加“动态细节”：风吹头发、背景运动模糊、光影变化
* 增加“空间变化”：车内→车外→远景
* 描述可视化，不抽象

【字段要求】

* 视角：如“侧面视角”“俯拍视角”“主观视角”
* 构图：如“过肩构图”“双人构图”“驾驶位构图”
* 动作必须具体

仅输出分镜内容，每行一个，前面用【】总结10个字左右分镜简介，后面跟详细分镜拆解，不要任何其它额外信息。
""".strip()
DEFAULT_USER_PROMPT = "请提炼图片中的主体、环境、风格、镜头、构图、光线、材质与细节，并整理成适合文生图模型直接使用的高质量提示词。"
NODE_NAME = "GJJ_ImageAnalysis"
DEFAULT_TEMPERATURE = 0.7
DEFAULT_MAX_TOKENS = 1024
IMAGE_ANALYSIS_TIMEOUT = 300


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


def _image_analysis_model_options() -> list[str]:
    models = [
        str(item or "").strip()
        for item in model_options_with_fallback()
        if str(item or "").strip()
    ]
    ordered = [DEFAULT_IMAGE_ANALYSIS_MODEL]
    for name in models:
        if name not in ordered:
            ordered.append(name)
    return ordered


def build_messages(system_prompt: str, user_prompt: str, image_b64: str):
    messages = []
    system_prompt = (system_prompt or "").strip()
    user_prompt = (user_prompt or "").strip() or DEFAULT_USER_PROMPT

    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({
        "role": "user",
        "content": user_prompt,
        "images": [image_b64],
    })
    return messages


def _collect_images(image=None, batch_image=None) -> list[torch.Tensor]:
    source = batch_image if isinstance(batch_image, torch.Tensor) else image
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


class GJJ_ImageAnalysis:
    CATEGORY = "GJJ/LLM"
    FUNCTION = "analyze"
    DESCRIPTION = "调用本地 Ollama 多模态模型分析图片内容，并整理成适合文生图使用的反推提示词。"
    SEARCH_ALIASES = ["image analysis", "image prompt", "图片", "反推", "提示词", "分析"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("图像分析提示",)
    OUTPUT_TOOLTIPS = ("根据输入图片反推出的提示词结果。",)

    @classmethod
    def INPUT_TYPES(cls):
        model_options = _image_analysis_model_options()
        return {
            "required": {
                "ollama_host": ("STRING", {
                    "default": DEFAULT_OLLAMA_HOST,
                    "multiline": False,
                    "display_name": "Ollama 完整地址",
                    "tooltip": "整体填写完整地址，格式为 http://127.0.0.1:端口 。示例：http://127.0.0.1:11434",
                }),
                "model": (model_options, {
                    "default": DEFAULT_IMAGE_ANALYSIS_MODEL,
                    "display_name": "Ollama 模型",
                    "tooltip": "从本地 Ollama 已安装模型中选择一个支持图像理解的模型。",
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
                    "default": DEFAULT_IMAGE_ANALYSIS_SYSTEM_PROMPT,
                    "multiline": True,
                    "display_name": "系统提示词",
                    "tooltip": "用于规定图片反推任务的角色、约束和输出目标。",
                }),
                "user_prompt": ("STRING", {
                    "default": DEFAULT_USER_PROMPT,
                    "multiline": True,
                    "display_name": "用户提示词",
                    "tooltip": "补充你希望模型重点关注的分析方向或输出要求。",
                }),
            },
            "optional": {
                "image": ("IMAGE", {
                    "display_name": "图片",
                    "tooltip": "输入单张或普通 IMAGE batch 图片；未接入批量图片入口时使用这里。",
                }),
                "batch_image": (GJJ_BATCH_IMAGE_TYPE, {
                    "display_name": "GJJ 批量图片",
                    "tooltip": "接入 GJJ 批量图片队列后，会逐张调用本机 Ollama 图片反推，并把每张结果按图片序号合并成一个文本输出。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def analyze(
        self,
        ollama_host,
        model,
        model_keep_alive,
        thinking_mode,
        temperature,
        max_tokens,
        system_prompt,
        user_prompt,
        image=None,
        batch_image=None,
        unique_id=None,
        **_kwargs,
    ):
        send_ollama_status(unique_id, "1/3 检查地址、参数与模型...", 0.08)
        configured_host = normalize_ollama_host(ollama_host or DEFAULT_OLLAMA_HOST)
        model_keep_alive = _coerce_choice(model_keep_alive, ("保持模型", "卸载模型"), "保持模型")
        thinking_mode = _coerce_choice(thinking_mode, ("关闭思考", "开启思考"), "关闭思考")
        temperature = _coerce_float(temperature, DEFAULT_TEMPERATURE)
        max_tokens = _coerce_int(max_tokens, DEFAULT_MAX_TOKENS, minimum=16, maximum=8192)
        chosen_model = resolve_model(model, host=configured_host)
        images = _collect_images(image=image, batch_image=batch_image)
        if not images:
            raise RuntimeError("请接入单张图片或 GJJ 批量图片。")

        results: list[str] = []
        total = len(images)
        for index, item in enumerate(images, start=1):
            image_b64 = tensor_to_png_base64(item)
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
            send_ollama_status(unique_id, f"2/3 正在反推图片 {index}/{total}...", progress)
            response = request_chat(
                payload,
                error_label=f"Ollama 图片 {index} 反推请求",
                host=configured_host,
                timeout=IMAGE_ANALYSIS_TIMEOUT,
            )
            content = extract_final_answer(response).strip()

            if not content and thinking_mode == "开启思考":
                fallback_payload = dict(payload)
                fallback_payload["think"] = False
                send_ollama_status(unique_id, f"2/3 图片 {index}/{total} 思考结果为空，正在回退为直出模式...", progress + 0.03)
                fallback_response = request_chat(
                    fallback_payload,
                    error_label=f"Ollama 图片 {index} 反推回退请求",
                    host=configured_host,
                    timeout=IMAGE_ANALYSIS_TIMEOUT,
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
                raise RuntimeError(f"图片反推已完成，但卸载模型失败：{exc}") from exc

        send_ollama_status(unique_id, f"3/3 图片反推完成：{len(results)} 张", 1.0)
        return (content,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageAnalysis}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔎 本机Ollama图片反推"}
