from __future__ import annotations

import json
import re
from textwrap import dedent

from .gjj_ollama_common import DEFAULT_OLLAMA_HOST, extract_final_answer, model_options_with_fallback, normalize_ollama_host, request_chat, resolve_model, send_ollama_status, unload_model

NODE_NAME = "GJJ_Translation"

SYSTEM_PROMPT_TEMPLATE = dedent(
    """
    Role
    你是一位精通 AI 绘画语法的提示词翻译专家，负责将 {src_lang} 准确转译为 {dst_lang}。你的核心任务是确保翻译后的内容在图像生成模型中具备最高的语义触发精度。
    最高指令 (Absolute Command)
    1. 风格镜像：严格保持原文的语感与书写结构。若原文是自然语言长句，则对应翻译为长句；若原文是逗号分隔的标签（Tags），则对应翻译为标签流。
    2. 符号保护：严禁改动任何权重符号与括号结构。必须保持半角格式，严格保留如 (word:1.2), [word], ((word)), {{word}} 等所有原始标点。
    3. Markdown 语法保护：严禁改动或删除原文中的 Markdown 格式符号。如果原文包含 Markdown 语法（如代码块、标题、加粗、表格等），必须在翻译后的对应位置严格保留这些符号及其结构。
    4. 专有名词锁定：严禁翻译英文人名、画师名、品牌名、动漫角色名以及已有的英文技术术语（如 LoRA, VAE, ControlNet, Checkpoint, Depth of field）。这些内容必须保持原始拼写。
    5. 术语精准：使用 AI 绘画领域地道的专业术语。严禁使用中文全角标点，输出结果必须全部使用英文半角标点。
    6. 目标语言强约束：
       - 当目标语言为 Chinese 时，最终输出必须是中文译文，允许保留必须锁定的英文专有名词，但主体表达必须为中文。
       - 当目标语言为 English 时，最终输出必须是英文译文，不得输出中文解释。
    7. 纯净输出：直接输出翻译结果。严禁包含任何前缀、解释、说明、额外注释。
    执行流程
    识别原文中的权重符号、专有名词和已有英文词汇，锁定不予翻译的部分，将剩余内容按原文风格转译为地道的 AI 绘画术语，最后按原排列顺序拼装输出。
    """
).strip()


def contains_chinese(text: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", text or ""))


def infer_source_language(text: str, target_language: str) -> str:
    if contains_chinese(text):
        return "Chinese"
    if re.search(r"[A-Za-z]", text or ""):
        return "English"
    return "English" if target_language == "Chinese" else "Chinese"


def build_user_prompt(source_text: str, source_language: str, target_language: str, strict: bool = False) -> str:
    strict_line = (
        f"最终输出必须为{target_language}译文, 如果输出语言不符合要求则视为失败。"
        if strict else ""
    )
    return dedent(
        f"""
        请将下面这段 AI 绘画提示词从 {source_language} 翻译为 {target_language}。
        只输出译文正文, 不要解释, 不要添加前缀, 不要重复原文。
        {strict_line}
        原文开始
        {source_text}
        原文结束
        """
    ).strip()


def matches_target_language(text: str, target_language: str) -> bool:
    text = (text or "").strip()
    if not text:
        return False
    if target_language == "Chinese":
        return contains_chinese(text)
    if target_language == "English":
        return not contains_chinese(text)
    return True


def translate_once(
    model: str,
    source_text: str,
    source_language: str,
    target_language: str,
    host: str | None = None,
    strict: bool = False,
) -> str:
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(src_lang=source_language, dst_lang=target_language)
    user_prompt = build_user_prompt(source_text, source_language, target_language, strict=strict)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
        "think": False,
        "options": {
            "temperature": 0.0 if strict else 0.2,
            "num_predict": 2048,
        },
    }
    if host is not None:
        response = request_chat(payload, error_label="Ollama 翻译请求", host=host)
    else:
        response = request_chat(payload, error_label="Ollama 翻译请求")
    result = extract_final_answer(response).strip()
    return result if result else json.dumps(response, ensure_ascii=False)


class GJJ_Translation:
    CATEGORY = "GJJ/LLM"
    FUNCTION = "translate"
    DESCRIPTION = "调用本地 Ollama 模型进行中英提示词翻译，并尽量保持 AI 绘画术语、权重符号和原始结构不变。"
    SEARCH_ALIASES = ["translation", "prompt translation", "翻译", "提示词翻译"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("翻译输出文本",)
    OUTPUT_TOOLTIPS = ("翻译后的提示词内容。",)

    @classmethod
    def INPUT_TYPES(cls):
        model_options = model_options_with_fallback()
        default_model = model_options[0] if model_options else ""
        return {
            "required": {
                "text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "原文",
                    "tooltip": "输入需要翻译的 AI 绘画提示词或自然语言文本。",
                }),
                "model": (model_options, {
                    "default": default_model,
                    "display_name": "Ollama 模型",
                    "tooltip": "从本地 Ollama 已安装模型中选择一个用于翻译。",
                }),
                "target_language": (["Chinese", "English"], {
                    "default": "English",
                    "display_name": "目标语言",
                    "tooltip": "选择最终希望输出的语言。",
                }),
                "model_keep_alive": (["保持模型", "卸载模型"], {
                    "default": "保持模型",
                    "display_name": "模型处理",
                    "tooltip": "生成完成后保持模型常驻，或立即卸载模型。",
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

    def translate(self, text, model, target_language, model_keep_alive, ollama_host, unique_id=None):
        send_ollama_status(unique_id, "1/3 检查语言方向与模型...", 0.08)
        source_text = (text or "").strip()
        if not source_text:
            raise RuntimeError("原文不能为空。")
        if target_language not in {"Chinese", "English"}:
            raise RuntimeError(f"不支持的目标语言: {target_language}")

        configured_host = normalize_ollama_host(ollama_host or DEFAULT_OLLAMA_HOST)
        chosen_model = resolve_model(model, host=configured_host)
        source_language = infer_source_language(source_text, target_language)

        send_ollama_status(unique_id, "2/3 正在请求本机 Ollama 翻译...", 0.56)
        content = translate_once(
            chosen_model,
            source_text,
            source_language,
            target_language,
            host=configured_host,
            strict=False,
        )
        if not matches_target_language(content, target_language):
            send_ollama_status(unique_id, "2/3 首次输出语言不符，正在严格重试...", 0.72)
            content = translate_once(
                chosen_model,
                source_text,
                source_language,
                target_language,
                host=configured_host,
                strict=True,
            )

        if model_keep_alive == "卸载模型":
            try:
                send_ollama_status(unique_id, "3/3 正在卸载本次模型...", 0.9)
                unload_model(chosen_model, host=configured_host)
            except Exception as exc:
                raise RuntimeError(f"翻译已完成，但卸载模型失败：{exc}") from exc

        send_ollama_status(unique_id, "3/3 翻译完成", 1.0)
        return (content,)


# 翻译能力已并入 GJJ_OllamaAssistant，旧节点不再出现在新增节点菜单。
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
