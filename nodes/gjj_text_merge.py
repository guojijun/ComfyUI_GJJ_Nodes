from __future__ import annotations

import re
import json
from typing import Any


MAX_TEXT_INPUTS = 32
TEXT_INPUT_PREFIX = "text_"
NODE_NAME = "GJJ_TextMerge"
DEFAULT_TEMPLATE_TEXT = """【默认】You are a helpful assistant. #默认值
【T2I】You are a helpful assistant specialized in text-to-image generation.#文本到图片
【T2V】You are a helpful assistant specialized in text-to-video generation.#文本到视频
【I2I】You are a helpful assistant specialized in image editing.#图片到图片
【R2I】You are a helpful assistant specialized in subject-to-image generation.#参考主体到图片
【I2V】You are a helpful assistant specialized in image-to-video generation.#图片到视频
【V2V】You are a helpful assistant specialized in video editing.#视频到视频
【R2V】You are a helpful assistant specialized in subject-to-video generation.#参考主体到视频
【VI2V】You are a helpful assistant specialized in video editing on content propagation.#视频指令到视频
【RV2V】You are a helpful assistant specialized in video editing with reference.#参考视频到视频
【ADS2V】You are a helpful assistant specialized in ads insertion.#广告插入到视频
【VRC2V】You are a helpful assistant for editing. You may need to adjust the subject's action or position.#视频区域控制到视频
【MV2V】You are a helpful assistant for editing. You might need to adjust the video's style, lighting, colors, textures, and the subject's pose or action.#多维编辑到视频"""
BOOK_QUOTE_RE = re.compile(r"《([\s\S]*?)》")
CHOICE_GROUP_RE = re.compile(r"^【([^】]+)】\s*[：:]\s*[｛{]([\s\S]*?)[｝}]\s*(?:#(.*))?$")


def build_text_input_options(index: int) -> tuple[str, dict[str, Any]]:
    return (
        "STRING",
        {
            "default": "",
            "forceInput": True,
            "display_name": f"文本 {index}",
            "tooltip": f"第 {index} 路文本输入；未连接或内容为空时会自动跳过。",
        },
    )


def extract_input_index(name: str) -> int:
    raw_name = str(name or "")
    if not raw_name.startswith(TEXT_INPUT_PREFIX):
        return MAX_TEXT_INPUTS + 1

    try:
        return int(raw_name[len(TEXT_INPUT_PREFIX):])
    except ValueError:
        return MAX_TEXT_INPUTS + 1


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def join_template_parts(parts: list[str]) -> str:
    return "\n\n".join(part.strip() for part in parts if part and part.strip()).strip()


def join_prompt_parts(parts: list[str]) -> str:
    cleaned = []
    for part in parts:
        text = normalize_text(part)
        if text:
            cleaned.append(text.strip("，,。；; "))
    return "，".join(part for part in cleaned if part).strip()


def template_directives(template_text: Any) -> dict[str, Any]:
    source = normalize_text(template_text) or DEFAULT_TEMPLATE_TEXT
    required_parts: list[str] = []

    def collect_required(match: re.Match[str]) -> str:
        text = match.group(1).strip()
        if text and text not in required_parts:
            required_parts.append(text)
        return ""

    source = BOOK_QUOTE_RE.sub(collect_required, source)
    preview_parts: list[str] = []
    template_lines: list[str] = []
    for raw_line in source.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.strip()
        if line.startswith("#"):
            hint = line[1:].strip()
            if hint:
                preview_parts.append(hint)
            continue
        template_lines.append(raw_line)

    return {
        "required_text": join_prompt_parts(required_parts),
        "preview_hint": join_template_parts(preview_parts),
        "template_lines": template_lines,
    }


def parse_template_line(line: Any) -> dict[str, str] | None:
    text = str(line or "").strip()
    if CHOICE_GROUP_RE.match(text):
        return None
    if not text.startswith("【") or "】" not in text:
        return None

    label, rest = text[1:].split("】", 1)
    label = label.strip()
    if not label:
        return None

    tooltip = ""
    if "#" in rest:
        rest, tooltip = rest.rsplit("#", 1)
    placement = "suffix" if rest.startswith("⬛") else "prefix"
    if placement == "suffix":
        rest = rest[1:]
    content = rest.strip()
    if not content:
        return None
    return {"label": label, "content": content, "tooltip": tooltip.strip(), "placement": placement}


def parse_templates(template_text: Any) -> list[dict[str, str]]:
    directives = template_directives(template_text)
    templates: list[dict[str, str]] = []
    for line in directives["template_lines"]:
        parsed = parse_template_line(line)
        if parsed:
            templates.append(parsed)
    return templates


def selected_template_entry(template_text: Any, selected_template: Any) -> dict[str, str] | None:
    templates = parse_templates(template_text)
    if not templates:
        return None

    selected = normalize_text(selected_template)
    for entry in templates:
        if entry["label"] == selected:
            return entry
    return templates[0]


def apply_template(merged_text: str, template_text: Any, selected_template: Any) -> str:
    entry = selected_template_entry(template_text, selected_template)
    if not entry:
        return merged_text

    content = entry["content"].strip()
    text = normalize_text(merged_text)
    if not content:
        return text
    if not text:
        return content
    if entry.get("placement") == "suffix":
        return join_prompt_parts([text, content])
    return join_prompt_parts([content, text])


def parse_selected_groups(value: Any) -> list[str]:
    try:
        parsed = json.loads(str(value or "{}"))
    except Exception:
        parsed = {}
    if not isinstance(parsed, dict):
        return []
    lines: list[str] = []
    for label, choice in parsed.items():
        label_text = normalize_text(label)
        choice_text = normalize_text(choice)
        if label_text and choice_text:
            lines.append(f"{label_text}：{choice_text}")
    return lines


class GJJ_TextMerge:
    CATEGORY = "GJJ/📝 文本"
    FUNCTION = "merge"
    OUTPUT_NODE = True
    DESCRIPTION = "把多路文本按顺序直接拼接，并在节点内提供预览，方便提示词和文案整合。"
    SEARCH_ALIASES = ["text merge", "text join", "文本", "合并", "拼接"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本合并结果",)
    OUTPUT_TOOLTIPS = ("已去除每段首尾空白并按顺序直接拼接后的文本结果。",)

    @classmethod
    def INPUT_TYPES(cls):
        optional_inputs = {
            f"{TEXT_INPUT_PREFIX}{index}": build_text_input_options(index)
            for index in range(1, MAX_TEXT_INPUTS + 1)
        }
        return {
            "required": {
                "template_text": (
                    "STRING",
                    {
                        "default": DEFAULT_TEMPLATE_TEXT,
                        "multiline": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "隐藏模板",
                        "tooltip": "由前端 ⚙️ 设置按钮维护并保存到 presets/gjj_user_settings.json；只保存模板文本，当前按钮选择不保存。格式：《必填公共提示》；【按钮文字】模板内容#按钮提示；【分组】：｛选项1、选项2｝ 会生成互斥按钮；单独一行 #文字 可作为执行前预览提示。",
                    },
                ),
                "selected_template": (
                    "STRING",
                    {
                        "default": "默认",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "当前模板",
                        "tooltip": "当前选中的模板按钮文字，由前端维护。",
                    },
                ),
                "selected_groups": (
                    "STRING",
                    {
                        "default": "{}",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "当前分组选择",
                        "tooltip": "当前多分组互斥按钮选择，由前端维护；不会保存到用户设置。",
                    },
                ),
            },
            "optional": optional_inputs,
        }

    def merge(self, **kwargs):
        texts = []
        for name in sorted(kwargs.keys(), key=extract_input_index):
            if not name.startswith(TEXT_INPUT_PREFIX):
                continue

            content = normalize_text(kwargs.get(name))
            if content:
                texts.append(content)

        raw_text = "".join(texts)
        selected_group_lines = parse_selected_groups(kwargs.get("selected_groups"))
        required_text = str(template_directives(kwargs.get("template_text")).get("required_text") or "")
        body_text = join_prompt_parts([required_text, *selected_group_lines, raw_text])
        merged_text = apply_template(body_text, kwargs.get("template_text"), kwargs.get("selected_template"))
        return {
            "ui": {
                "text": (merged_text,),
                "base_text": (raw_text,),
                "selected_template": (normalize_text(kwargs.get("selected_template")) or "默认",),
            },
            "result": (merged_text,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TextMerge}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📝 文本合并预览"}
