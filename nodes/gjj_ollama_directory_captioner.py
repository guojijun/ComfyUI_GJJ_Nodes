from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any
import re

from aiohttp import web
from .gjj_ollama_common import DEFAULT_OLLAMA_HOST, model_options_with_fallback, normalize_ollama_host

try:
    from server import PromptServer
except Exception:
    PromptServer = None


NODE_NAME = "GJJ_OllamaDirectoryCaptioner"
OLLAMA_CAPTION_API_PATH = "/gjj/ollama_caption_image"
DEFAULT_OLLAMA_MODEL = "qwen2.5vl:7b"
DEFAULT_PROMPT = (
    "请为这张图片生成适合后续 LoRA 训练的标签文本。"
    "只输出标签本身，不要解释，不要编号。"
    "尽量使用简洁、稳定、可复用的中文短语，并用英文逗号分隔。"
    "优先描述主体、外貌、服装、姿势、构图、场景、光线和风格。"
)


def _trim_text(value: Any) -> str:
    return str(value or "").strip()


def _is_descriptive_filename(filename: str) -> bool:
    stem = _trim_text(filename)
    if not stem:
        return False

    normalized = stem.lower()
    normalized = re.sub(r"\.[^.]+$", "", normalized)
    compact = re.sub(r"[\s._\-]+", "", normalized)

    if not compact:
        return False
    if re.fullmatch(r"\d+", compact):
        return False
    if re.fullmatch(r"[a-z]*\d+", compact):
        generic_prefixes = (
            "img",
            "image",
            "photo",
            "pic",
            "dsc",
            "p",
            "wechatimg",
            "mmexport",
            "screenshot",
            "snap",
            "camera",
            "vid",
            "video",
        )
        if compact.startswith(generic_prefixes):
            return False

    has_cjk = re.search(r"[\u4e00-\u9fff]", stem) is not None
    has_letters = re.search(r"[a-zA-Z]", stem) is not None
    return has_cjk or has_letters


def _extract_ollama_text(payload: dict[str, Any]) -> str:
    message = payload.get("message")
    if isinstance(message, dict):
        content = _trim_text(message.get("content"))
        if content:
            return content

    response_text = _trim_text(payload.get("response"))
    if response_text:
        return response_text

    raise RuntimeError("Ollama 没有返回可用文本内容。")


def _build_caption_prompt(prompt: str, filename: str) -> str:
    clean_prompt = _trim_text(prompt) or DEFAULT_PROMPT
    stem = _trim_text(filename)
    if not stem or not _is_descriptive_filename(stem):
        return clean_prompt
    return (
        f"{clean_prompt}\n\n"
        f"文件名参考（可能包含主体或风格线索）：{stem}\n"
        "请综合图片内容和文件名线索生成最终打标文本。"
    )


def _caption_with_ollama(host: str, model: str, prompt: str, image_base64: str, filename: str = "") -> str:
    request_url = f"{host.rstrip('/')}/api/chat"
    body = {
        "model": model,
        "stream": False,
        "messages": [
            {
                "role": "user",
                "content": _build_caption_prompt(prompt, filename),
                "images": [image_base64],
            }
        ],
    }
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        request_url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            detail = str(exc)
        raise RuntimeError(f"Ollama 请求失败：HTTP {exc.code}，{detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"无法连接到 Ollama：{host}。请确认本地 Ollama 已启动，并且模型 {model} 可用。"
        ) from exc
    except Exception as exc:
        raise RuntimeError(f"Ollama 调用失败：{exc}") from exc

    return _extract_ollama_text(payload)


async def post_gjj_ollama_caption_image(request):
    try:
        payload = await request.json()
    except Exception as exc:
        return web.json_response({"ok": False, "error": f"请求体不是有效 JSON：{exc}"}, status=400)

    host = normalize_ollama_host(_trim_text(payload.get("host")) or DEFAULT_OLLAMA_HOST)
    model = _trim_text(payload.get("model")) or DEFAULT_OLLAMA_MODEL
    prompt = _trim_text(payload.get("prompt")) or DEFAULT_PROMPT
    image_base64 = _trim_text(payload.get("image"))
    filename = _trim_text(payload.get("filename"))

    if not image_base64:
        return web.json_response({"ok": False, "error": "缺少图片内容。"}, status=400)

    try:
        caption = _caption_with_ollama(host, model, prompt, image_base64, filename=filename)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)

    return web.json_response({"ok": True, "caption": caption})


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.post(OLLAMA_CAPTION_API_PATH)(post_gjj_ollama_caption_image)


class GJJ_OllamaDirectoryCaptioner:
    CATEGORY = "GJJ"
    FUNCTION = "get_summary"
    OUTPUT_NODE = True
    DESCRIPTION = "通过浏览器选择任意本地目录，调用本地 Ollama 多模态模型为目录中的图片生成同名 txt 打标文件。适合后续 LoRA 数据预标注。"
    SEARCH_ALIASES = [
        "ollama directory caption",
        "ollama image caption",
        "目录打标",
        "图片打标",
        "lora 打标",
        "自动打标",
    ]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("打标结果摘要",)
    OUTPUT_TOOLTIPS = ("最近一次目录打标任务的执行摘要。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ollama_host": (
                    "STRING",
                    {
                        "default": DEFAULT_OLLAMA_HOST,
                        "display_name": "Ollama 完整地址",
                        "tooltip": "整体填写完整地址，格式为 http://127.0.0.1:端口 。示例：http://127.0.0.1:11434",
                    },
                ),
                "ollama_model": (
                    model_options_with_fallback(),
                    {
                        "default": DEFAULT_OLLAMA_MODEL,
                        "display_name": "Ollama 模型",
                        "tooltip": "列出本地 Ollama 已安装模型；如果列表为空，请先启动 Ollama 并安装多模态模型。",
                    },
                ),
                "prompt_template": (
                    "STRING",
                    {
                        "default": DEFAULT_PROMPT,
                        "multiline": True,
                        "display_name": "打标提示词",
                        "tooltip": "发送给 Ollama 的图片打标提示词。建议输出简洁、稳定、逗号分隔的 LoRA 训练标签。",
                    },
                ),
                "overwrite_existing": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "覆盖已有 txt",
                        "tooltip": "关闭时遇到同名 txt 会跳过；打开后会覆盖已有 txt。",
                    },
                ),
                "include_subdirectories": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "包含子目录",
                        "tooltip": "打开后会递归处理所选目录下的所有子目录图片。",
                    },
                ),
                "selected_directory": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "已选目录",
                        "tooltip": "由前端目录选择器自动维护，一般无需手动填写。",
                    },
                ),
                "last_summary": (
                    "STRING",
                    {
                        "default": "等待执行",
                        "multiline": True,
                        "display_name": "最近结果",
                        "tooltip": "由前端自动维护的最近一次批量打标结果摘要。",
                    },
                ),
            }
        }

    def get_summary(
        self,
        ollama_host,
        ollama_model,
        prompt_template,
        overwrite_existing,
        include_subdirectories,
        selected_directory,
        last_summary,
    ):
        host = normalize_ollama_host(_trim_text(ollama_host) or DEFAULT_OLLAMA_HOST)
        model = _trim_text(ollama_model) or DEFAULT_OLLAMA_MODEL
        directory_text = _trim_text(selected_directory) or "未选择目录"
        summary_text = _trim_text(last_summary) or "等待执行"
        summary = (
            f"目录：{directory_text}\n"
            f"Ollama：{host}\n"
            f"模型：{model}\n"
            f"覆盖已有 txt：{'是' if overwrite_existing else '否'}\n"
            f"包含子目录：{'是' if include_subdirectories else '否'}\n"
            f"状态：{summary_text}"
        )
        return {
            "ui": {
                "preview_text": (summary,),
                "preview_kind": ("text",),
            },
            "result": (summary,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_OllamaDirectoryCaptioner}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🏷️ 本机Ollama目录图片打标器"}
