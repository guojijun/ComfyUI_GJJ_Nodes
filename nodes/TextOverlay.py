import random
import re
import os
import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

import folder_paths

FONT_EXTENSIONS = {".ttf", ".otf", ".ttc", ".otc"}
NODE_NAME = "GJJ_TextOverlay"


def get_font_choices():
    fonts_dir = os.path.join(folder_paths.models_dir, "fonts")
    folder_paths.folder_names_and_paths["fonts"] = ([fonts_dir], FONT_EXTENSIONS)
    try:
        font_list = folder_paths.get_filename_list("fonts")
    except:
        font_list = []
    return font_list or ["simhei.ttf"]


def resolve_font_path(font_name):
    if not font_name:
        return None
    if os.path.isfile(font_name):
        return font_name

    fonts_dir = os.path.join(folder_paths.models_dir, "fonts")
    full_path = os.path.join(fonts_dir, font_name)
    if os.path.isfile(full_path):
        return full_path

    try:
        resolved = folder_paths.get_full_path("fonts", font_name)
        if resolved:
            return resolved
    except:
        pass

    return font_name


def resolve_axis_position(value, size):
    value = float(value)
    # 兼容旧工作流：0-1 之间仍按比例位置处理；其他值按像素处理。
    if 0.0 <= value <= 1.0:
        return value * size
    return value


def is_vertical_direction(direction):
    value = str(direction or "").strip().lower()
    return value in {"v", "vertical", "纵", "纵向"}

# 工具函数
def hex2rgb(h, default):
    try:
        h = h.lstrip('#')
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except:
        return default

def parse_text_blob(texts, strip_empty=True):
    lines = [l.strip() for l in texts.split('\n')]
    if strip_empty:
        lines = [l for l in lines if l]
    return lines

# 节点主体
class GJJ_TextOverlay:
    NAME = "GJJ_TextOverlay"
    DISPLAY_NAME = "文本叠加"
    CATEGORY = "GJJ"
    DESCRIPTION = "将随机或指定文本绘制到透明图层上，并可进一步与背景图合成，适合做标题、水印和标注。"
    SEARCH_ALIASES = ["text overlay", "text image overlay", "文字", "文本", "叠加", "图片"]
    
    FUNCTION = "run"
    RETURN_TYPES = ("STRING", "INT", "STRING", "IMAGE", "IMAGE")
    RETURN_NAMES = ("文本叠加结果", "文本总行数量", "来源文件名称", "透明文字图像", "文字合成图像")
    OUTPUT_TOOLTIPS = (
        "按当前随机规则选中并抽取后的最终文本。",
        "参与随机选择的有效文本总行数。",
        "根据最终文本清洗后的文件名字符串，可用于保存命名。",
        "仅包含透明背景与文字图层的图像输出。",
        "文字图层与可选背景图合成后的最终图片。",
    )
    
    INPUT_IS_LIST = False
    OUTPUT_IS_LIST = (False, False, False, False, False)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "texts": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "文本列表",
                    "tooltip": "一行一个，按种子随机选取",
                }),
                "split_char": ("STRING", {
                    "default": "_",
                    "display_name": "分隔符",
                    "tooltip": "用于切分单行文本",
                }),
                "indexes": ("STRING", {
                    "default": "1,2",
                    "display_name": "取词索引(0,1,2)",
                    "tooltip": "用逗号分隔，从分段中抽取对应位置",
                }),
                "direction": (["横向", "纵向"], {
                    "default": "横向",
                    "display_name": "文字方向",
                    "tooltip": "选择横向或纵向排版",
                }),
                "spacing": ("FLOAT", {
                    "default": 0,
                    "min": -5,
                    "max": 50,
                    "step": 0.1,
                    "display_name": "字间距",
                    "tooltip": "控制字符之间的额外间距，负值会让字符更紧凑。",
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "display_name": "种子值",
                    "tooltip": "控制随机选行",
                }),
                "strip_empty": ("BOOLEAN", {
                    "default": True,
                    "display_name": "过滤空行",
                    "tooltip": "启用后会跳过空白行，避免随机到没有内容的文本。",
                }),
                "width": ("INT", {
                    "default": 1024,
                    "min": 1,
                    "display_name": "画布宽度",
                    "tooltip": "无背景图时生效；接入背景图后运行一次会自动显示实际宽度",
                }),
                "height": ("INT", {
                    "default": 128,
                    "min": 1,
                    "display_name": "画布高度",
                    "tooltip": "无背景图时生效；接入背景图后运行一次会自动显示实际高度",
                }),
                "font_path": (get_font_choices(), {
                    "default": "simhei.ttf",
                    "display_name": "字体",
                    "tooltip": "枚举 models/fonts 目录中的字体文件",
                }),
                "font_size": ("INT", {
                    "default": 48,
                    "min": 1,
                    "display_name": "字体大小",
                    "tooltip": "控制绘制文字时使用的字号大小。",
                }),
                "x": ("FLOAT", {
                    "default": 50,
                    "step": 1,
                    "display_name": "X位置",
                    "tooltip": "支持像素位置；0-1 之间的小数会兼容按宽度比例计算",
                }),
                "y": ("FLOAT", {
                    "default": 64,
                    "step": 1,
                    "display_name": "Y位置",
                    "tooltip": "支持像素位置；0-1 之间的小数会兼容按高度比例计算",
                }),
                "color_hex": ("STRING", {
                    "default": "#FFD700",
                    "display_name": "文字颜色",
                    "tooltip": "使用十六进制颜色值设置正文颜色，例如 #FFD700。",
                }),
                "stroke_color_hex": ("STRING", {
                    "default": "#000000",
                    "display_name": "描边颜色",
                    "tooltip": "使用十六进制颜色值设置描边颜色，例如 #000000。",
                }),
                "use_stroke": ("BOOLEAN", {
                    "default": True,
                    "display_name": "启用描边",
                    "tooltip": "启用后会为文字增加描边，提升复杂背景上的可读性。",
                }),
                "stroke_width": ("INT", {
                    "default": 2,
                    "min": 0,
                    "display_name": "描边宽度",
                    "tooltip": "设置文字描边的粗细；填 0 表示不绘制描边。",
                }),
            },
            "optional": {
                "background_image": ("IMAGE", {
                    "display_name": "背景图",
                    "tooltip": "可选，不接则生成透明底文字图；接入后画布宽高会跟随背景图",
                }),
            }
        }

    def run(self,
            background_image=None,
            texts="",
            split_char="_",
            indexes="1,2",
            direction="h",
            spacing=0,
            seed=0,
            strip_empty=True,
            width=1024,
            height=128,
            font_path="simhei.ttf",
            font_size=48,
            x=50,
            y=64,
            color_hex="#FFD700",
            stroke_color_hex="#000000",
            use_stroke=True,
            stroke_width=2):

        seed = int(seed)
        width = max(1, int(width))
        height = max(1, int(height))
        font_size = max(1, int(font_size))
        stroke_width = max(0, int(stroke_width))
        x = float(x)
        y = float(y)

        items = parse_text_blob(texts, strip_empty=strip_empty) or [""]
        line = items[seed % len(items)].strip()
        final_text = line

        # 分段 + 索引抽取
        if split_char and split_char in line:
            parts = line.split(split_char)
            try:
                idx_list = [int(i.strip()) for i in indexes.split(",") if i.strip().isdigit()]
                selected = [parts[i].strip() for i in idx_list if 0 <= i < len(parts)]
                final_text = " ".join(selected)
            except:
                final_text = parts[1].strip() if len(parts) > 1 else line

        # 文件名
        filename = re.sub(r'[^a-zA-Z0-9\u4e00-\u9fff]', '_', final_text)[:150] or "text"

        # 背景图
        if background_image is not None:
            bg_np = background_image[0].cpu().numpy()
            bg = Image.fromarray((bg_np * 255).astype(np.uint8)).convert("RGBA")
            width, height = bg.size
        else:
            bg = Image.new("RGBA", (width, height), (0, 0, 0, 0))

        # 文字图层
        text_layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(text_layer)

        # 字体
        try:
            font = ImageFont.truetype(resolve_font_path(font_path), font_size)
        except:
            font = ImageFont.load_default(size=font_size)

        text_col = hex2rgb(color_hex, (255, 215, 0))
        stroke_col = hex2rgb(stroke_color_hex, (0, 0, 0))

        if not final_text:
            final_text = " "

        bbox = draw.textbbox((0, 0), final_text[0], font=font)
        cw = bbox[2] - bbox[0]
        ch = bbox[3] - bbox[1]
        cx = resolve_axis_position(x, width)
        cy = resolve_axis_position(y, height)
        sw = stroke_width if use_stroke else 0
        sf = stroke_col if use_stroke else None

        # 横竖排版
        if is_vertical_direction(direction):
            for c in final_text:
                draw.text((cx, cy), c, font=font, fill=(*text_col, 255),
                          stroke_width=sw, stroke_fill=sf)
                cy += ch + spacing
        else:
            for c in final_text:
                draw.text((cx, cy), c, font=font, fill=(*text_col, 255),
                          stroke_width=sw, stroke_fill=sf)
                cx += cw + spacing

        composite = Image.alpha_composite(bg, text_layer)

        # 转 tensor
        def to_tensor(img):
            arr = np.array(img).astype(np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)

        text_out = to_tensor(text_layer)
        comp_out = to_tensor(composite.convert("RGB"))

        return {
            "ui": {
                "canvas_width": [width],
                "canvas_height": [height],
            },
            "result": (final_text, len(items), filename, text_out, comp_out),
        }

# 注册
NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TextOverlay}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📝 文本图片叠加"}
