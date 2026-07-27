from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import folder_paths


NODE_NAME = "GJJ_WorkflowTitle"
CONFIG_WIDGET = "config_json"
TITLE_INPUT = "title_text"
DEFAULT_TITLE_TEXT = "工作流标题"
FONT_EXTENSIONS = {".ttf", ".otf", ".ttc", ".otc"}
USER_STYLE_KEYS = {
    "font",
    "fontSize",
    "colorA",
    "colorB",
    "gradient",
    "gradientDirection",
    "opacity",
    "letterSpacing",
    "lineSpacing",
    "paddingX",
    "paddingY",
    "strokeWidth",
    "strokeMode",
    "strokeColor",
    "strokeOpacity",
    "backgroundColor",
    "borderMode",
    "borderColor",
    "borderOpacity",
    "shadowEnabled",
    "shadowColor",
    "shadowOpacity",
    "shadowBlur",
    "shadowX",
    "shadowY",
    "align",
}


def _register_fonts_folder() -> None:
    fonts_dir = os.path.join(folder_paths.models_dir, "fonts")
    folder_paths.folder_names_and_paths["fonts"] = ([fonts_dir], FONT_EXTENSIONS)


def _is_chinese_font_name(name: str) -> bool:
    text = str(name or "").lower()
    tokens = (
        "msyh",
        "simhei",
        "simsun",
        "simkai",
        "fangsong",
        "noto",
        "cjk",
        "sourcehan",
        "思源",
        "雅黑",
        "黑体",
        "宋体",
        "楷体",
        "仿宋",
    )
    return any(token in text for token in tokens)


def _system_font_candidates() -> list[str]:
    names = [
        "msyh.ttc",
        "msyh.ttf",
        "simhei.ttf",
        "simsun.ttc",
        "simkai.ttf",
        "simfang.ttf",
        "NotoSansCJK-Regular.ttc",
        "SourceHanSansSC-Regular.otf",
    ]
    result: list[str] = []
    win_fonts = Path(os.environ.get("WINDIR", "C:\\Windows")) / "Fonts"
    for name in names:
        if (win_fonts / name).is_file():
            result.append(name)
    return result


def get_font_choices() -> list[str]:
    _register_fonts_folder()
    try:
        fonts = list(folder_paths.get_filename_list("fonts"))
    except Exception:
        fonts = []

    seen: set[str] = set()
    choices: list[str] = []
    for name in sorted(fonts, key=lambda value: (not _is_chinese_font_name(value), str(value).lower())):
        text = str(name or "").strip()
        if text and text not in seen:
            seen.add(text)
            choices.append(text)

    for name in _system_font_candidates():
        if name not in seen:
            seen.add(name)
            choices.append(name)

    return choices or ["msyh.ttc", "simhei.ttf"]


def default_font_name() -> str:
    choices = get_font_choices()
    for name in choices:
        if _is_chinese_font_name(name):
            return name
    return choices[0]


def resolve_font_path(font_name: str) -> str | None:
    text = str(font_name or "").strip()
    if not text:
        text = default_font_name()
    if os.path.isfile(text):
        return text

    _register_fonts_folder()
    try:
        resolved = folder_paths.get_full_path("fonts", text)
        if resolved and os.path.isfile(resolved):
            return resolved
    except Exception:
        pass

    fonts_dir = os.path.join(folder_paths.models_dir, "fonts")
    direct = os.path.join(fonts_dir, text)
    if os.path.isfile(direct):
        return direct

    win_path = Path(os.environ.get("WINDIR", "C:\\Windows")) / "Fonts" / text
    if win_path.is_file():
        return str(win_path)

    return None


def _user_settings_path() -> Path:
    return Path(__file__).resolve().parents[1] / "presets" / "gjj_user_settings.json"


def _workflow_title_user_style() -> dict[str, Any]:
    path = _user_settings_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    section = data.get("workflow_title") if isinstance(data, dict) else {}
    if not isinstance(section, dict):
        return {}
    return {key: section[key] for key in USER_STYLE_KEYS if key in section}


def _default_config() -> dict[str, Any]:
    config = {
        "version": 5,
        "text": DEFAULT_TITLE_TEXT,
        "font": default_font_name(),
        "width": 512,
        "fontSize": 72,
        "colorA": "#F8FFF7",
        "colorB": "#55C685",
        "gradient": True,
        "gradientDirection": "水平",
        "opacity": 1.0,
        "letterSpacing": 1.0,
        "lineSpacing": 0.0,
        "paddingX": 0.0,
        "paddingY": 0.0,
        "strokeWidth": 2.0,
        "strokeMode": "自定义",
        "strokeColor": "#2E7D62",
        "strokeOpacity": 1.0,
        "backgroundColor": "#1E5A48",
        "borderMode": "透明",
        "borderColor": "#55C685",
        "borderOpacity": 0.0,
        "shadowEnabled": True,
        "shadowColor": "#F2FF04",
        "shadowOpacity": 0.42,
        "shadowBlur": 8.0,
        "shadowX": 2.0,
        "shadowY": 4.0,
        "align": "居中",
    }
    config.update(_workflow_title_user_style())
    config["version"] = 5
    config["text"] = DEFAULT_TITLE_TEXT
    config["width"] = 512
    return config


def _default_config_json() -> str:
    return json.dumps(_default_config(), ensure_ascii=False, separators=(",", ":"))


class GJJ_WorkflowTitle:
    CATEGORY = "GJJ/Image"
    FUNCTION = "noop"
    DESCRIPTION = "仅用于画布显示的工作流标题；保留一个默认标题内容输入口，标题宽度跟随节点面板宽度，样式偏好会保存到 presets/gjj_user_settings.json。"
    SEARCH_ALIASES = ["workflow title", "title", "标题", "工作流标题", "透明标题", "文字标题"]
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    OUTPUT_TOOLTIPS = ()
    GJJ_HELP = {
        "title": "GJJ · 🏷️ 工作流标题",
        "description": "无背景、无边框、无标题栏的工作流标题显示节点。双击标题打开可拖动的浮动窗口，编辑文字、字体、渐变、阴影、间距和描边。",
        "features": [
            "默认使用字体库中优先匹配到的中文字体",
            "默认显示“标题内容”输入口，避免无插槽透明节点在新建放置时无法落点",
            "标题宽度跟随节点面板宽度，直接拖动节点边缘即可调整显示长度",
            "颜色、描边、边框、阴影、间距和字体偏好会保存到 presets/gjj_user_settings.json 的 workflow_title 段",
            "支持纯色或渐变文字、描边透明度、背景色描边、节点边框透明/背景色、阴影、字间距、行间距和内边距",
            "仅作为工作流画布标题显示，不生成输出口",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                CONFIG_WIDGET: (
                    "STRING",
                    {
                        "default": _default_config_json(),
                        "multiline": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "内部标题配置",
                        "tooltip": "前端设置面板维护的标题样式配置；通常不需要手动编辑。",
                    },
                ),
            },
            "optional": {
                TITLE_INPUT: (
                    "STRING",
                    {
                        "forceInput": True,
                        "display_name": "标题内容",
                        "tooltip": "可连接外部文本作为标题内容引用；未连接时使用节点设置面板中的标题文字。",
                    },
                ),
            },
        }

    def noop(self, config_json: str = "", title_text: str = ""):
        return ()


def _register_workflow_title_api() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(server, "_gjj_workflow_title_api_registered", False):
        return

    @server.routes.get("/gjj/workflow_title/fonts")
    async def gjj_workflow_title_fonts(_request):
        choices = get_font_choices()
        return web.json_response({
            "fonts": choices,
            "default": default_font_name(),
        })

    server._gjj_workflow_title_api_registered = True


_register_workflow_title_api()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WorkflowTitle}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🏷️ 工作流标题"}
