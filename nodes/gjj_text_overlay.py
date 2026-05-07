import random
import re
import os
import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

import folder_paths
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE

FONT_EXTENSIONS = {".ttf", ".otf", ".ttc", ".otc"}
NODE_NAME = "GJJ_TextOverlay"
MIXED_BATCH_IMAGE_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"


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
    """
    解析位置值，兼容两种模式：
    - 0到1之间（含0和1）：按百分比位置处理（浮点数）
    - 大于1：按像素位置处理（整数）

    示例：
    - 0.5 → size * 0.5 (50%位置)
    - 1.0 → size * 1.0 (100%位置)
    - 50 → 50像素位置
    - 200 → 200像素位置
    """
    value = float(value)
    # 0到1之间（含边界）：按比例位置处理
    if 0.0 <= value <= 1.0:
        return value * size
    # 大于1：按像素位置处理
    return value


def is_vertical_direction(direction):
    value = str(direction or "").strip().lower()
    return value in {"v", "vertical", "纵", "纵向"}

def apply_opacity(image: Image.Image, opacity: float) -> Image.Image:
    """应用透明度到图像"""
    if opacity >= 1.0:
        return image

    # 分离通道
    r, g, b, a = image.split()

    # 调整alpha通道
    a = a.point(lambda x: int(x * opacity))

    # 合并通道
    return Image.merge('RGBA', (r, g, b, a))

def tensor_to_pil(tensor):
    """Convert torch tensor to PIL Image

    Args:
        tensor: [H, W, C] 或 [H, W] 格式的 tensor

    Returns:
        PIL Image: 保留原始通道（RGB 或 RGBA）
    """
    # Ensure tensor is on CPU and numpy
    np_img = tensor.cpu().numpy()

    # Scale from 0-1 to 0-255 if necessary
    if np_img.max() <= 1.0:
        np_img = (np_img * 255).astype(np.uint8)
    else:
        np_img = np_img.astype(np.uint8)

    # 根据通道数创建对应的 PIL Image
    if np_img.ndim == 2:
        # 灰度图
        return Image.fromarray(np_img, mode='L')
    elif np_img.shape[2] == 1:
        # 单通道
        return Image.fromarray(np_img[:, :, 0], mode='L')
    elif np_img.shape[2] == 3:
        # RGB
        return Image.fromarray(np_img, mode='RGB')
    elif np_img.shape[2] == 4:
        # RGBA - 保留 Alpha 通道
        return Image.fromarray(np_img, mode='RGBA')
    else:
        # 其他情况，尝试自动转换
        return Image.fromarray(np_img)

def pil_to_tensor(image):
    """Convert PIL Image to torch tensor

    Args:
        image: PIL Image (RGB or RGBA)

    Returns:
        torch.Tensor: [H, W, C] format, range [0, 1]
    """
    # 确保是RGB格式
    if image.mode != 'RGB':
        image = image.convert('RGB')

    # 转换为numpy数组
    np_img = np.array(image)

    # 调试：打印 numpy 数组信息
    print(f"[DEBUG pil_to_tensor] np_img.shape: {np_img.shape}, np_img.ndim: {np_img.ndim}, dtype: {np_img.dtype}")

    # 确保是3维数组 [H, W, C]
    if np_img.ndim == 2:
        # 如果是灰度图，扩展为3通道
        print(f"[WARNING] 检测到2D图像，扩展为3通道")
        np_img = np.stack([np_img] * 3, axis=-1)
    elif np_img.ndim == 3 and np_img.shape[2] == 4:
        # 如果是 RGBA，转换为 RGB
        print(f"[DEBUG] RGBA 转 RGB")
        np_img = np_img[:, :, :3]
    elif np_img.ndim == 3 and np_img.shape[2] != 3:
        print(f"[WARNING] 通道数异常: {np_img.shape[2]}")

    # 转换为 float32 并归一化
    np_img = np_img.astype(np.float32) / 255.0

    tensor = torch.from_numpy(np_img)
    print(f"[DEBUG pil_to_tensor] 返回 Tensor shape: {tensor.shape}")

    return tensor

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
    DISPLAY_NAME = "GJJ · 📝 文本图片叠加"
    CATEGORY = "GJJ"
    DESCRIPTION = "将文本或 RGBA 水印叠加到背景图上，支持批量处理。覆盖文本可设置透明度。"
    SEARCH_ALIASES = ["text overlay", "text image overlay", "水印", "叠加", "图片", "批量", "batch"]

    FUNCTION = "run"
    RETURN_TYPES = (MIXED_BATCH_IMAGE_TYPE,)
    RETURN_NAMES = ("叠加后图像",)
    OUTPUT_TOOLTIPS = ("文本或水印叠加后的合成图像（自动匹配输入类型）。",)

    INPUT_IS_LIST = False
    OUTPUT_IS_LIST = (True,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "background_image": (MIXED_BATCH_IMAGE_TYPE, {
                    "display_name": "背景图",
                    "tooltip": "必选，需要叠加文字或水印的背景图像；支持单图/批量图片输入",
                }),
            },
            "optional": {
                "texts": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "文本列表",
                    "tooltip": "支持多行文本，每行独立显示。可用分隔符和索引抽取第一行的部分内容。",
                }),
                "watermark_image": (MIXED_BATCH_IMAGE_TYPE, {
                    "display_name": "水印图",
                    "tooltip": "可选，水印图像（RGB 格式）；支持单图/批量输入",
                }),
                "watermark_mask": ("MASK", {
                    "display_name": "水印透明通道",
                    "tooltip": "可选，水印图像的 Alpha 透明通道（灰度 MASK）；与水印图配合使用实现透明叠加",
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
                "text_opacity": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display_name": "文本透明度",
                    "tooltip": "覆盖文本的透明度（0.0=完全透明，1.0=完全不透明）",
                }),
                "watermark_opacity": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display_name": "水印透明度",
                    "tooltip": "水印的整体透明度（0.0=完全透明，1.0=完全不透明）",
                }),
                "watermark_width": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.1,
                    "max": 10.0,
                    "step": 0.1,
                    "display_name": "水印宽度",
                    "tooltip": "水印宽度缩放比例（1.0=原始尺寸，0.5=缩小一半，2.0=放大两倍）",
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
                    "tooltip": "已废弃：多行文本模式下不再随机选行，所有行都会显示。",
                }),
                "strip_empty": ("BOOLEAN", {
                    "default": True,
                    "display_name": "过滤空行",
                    "tooltip": "启用后会跳过空白行，避免随机到没有内容的文本。",
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
                    "default": 0.5,
                    "min": 0,
                    "step": 0.01,
                    "display_name": "X位置",
                    "tooltip": "位置模式：0.0-1.0=百分比（如0.5=50%位置），>1.0=像素（如100=100像素）",
                }),
                "y": ("FLOAT", {
                    "default": 0.5,
                    "min": 0,
                    "step": 0.01,
                    "display_name": "Y位置",
                    "tooltip": "位置模式：0.0-1.0=百分比（如0.5=50%位置），>1.0=像素（如100=100像素）",
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
            "hidden": {
                "has_watermark_input": ("BOOLEAN", {
                    "default": False,
                    "display_name": "是否有水印输入",
                    "tooltip": "内部使用，用于控制参数显示",
                }),
            },
        }

    def run(self,
            background_image,
            texts="",
            watermark_image=None,
            watermark_mask=None,
            split_char="_",
            indexes="1,2",
            text_opacity=1.0,
            watermark_opacity=1.0,
            watermark_width=1.0,
            direction="h",
            spacing=0,
            seed=0,
            strip_empty=True,
            font_path="simhei.ttf",
            font_size=48,
            x=50,
            y=64,
            color_hex="#FFD700",
            stroke_color_hex="#000000",
            use_stroke=True,
            stroke_width=2):

        seed = int(seed)
        font_size = max(1, int(font_size))
        stroke_width = max(0, int(stroke_width))
        x = float(x)
        y = float(y)
        text_opacity = float(text_opacity)
        watermark_opacity = float(watermark_opacity)

        # 处理背景图（支持批量输入）
        # 确保是4D张量 [B, H, W, C]
        if background_image.ndim == 3:
            background_image = background_image.unsqueeze(0)

        batch_size = background_image.shape[0]
        background_images = [background_image[i] for i in range(batch_size)]

        # 自动检测背景图尺寸，用于动态UI
        # 如果是批量，使用最小尺寸以确保安全区域或统一参考
        min_height = int(background_images[0].shape[0])
        min_width = int(background_images[0].shape[1])

        for bg_tensor in background_images:
            h = int(bg_tensor.shape[0])
            w = int(bg_tensor.shape[1])
            min_height = min(min_height, h)
            min_width = min(min_width, w)

        # 解析文本 - 保留所有行，支持多行显示
        items = parse_text_blob(texts, strip_empty=strip_empty)

        # 如果有文本内容，使用完整的多行文本
        if items and items != [""]:
            # 分段 + 索引抽取（仅在第一行应用）
            first_line = items[0]
            if split_char and split_char in first_line:
                parts = first_line.split(split_char)
                try:
                    idx_list = [int(i.strip()) for i in indexes.split(",") if i.strip().isdigit()]
                    selected = [parts[i].strip() for i in idx_list if 0 <= i < len(parts)]
                    final_text = " ".join(selected)
                    # 保留其他行
                    if len(items) > 1:
                        final_text = final_text + "\n" + "\n".join(items[1:])
                except:
                    final_text = parts[1].strip() if len(parts) > 1 else first_line
                    if len(items) > 1:
                        final_text = final_text + "\n" + "\n".join(items[1:])
            else:
                # 没有分隔符，直接使用所有行
                final_text = "\n".join(items)
        else:
            final_text = ""

        # 文件名
        filename = re.sub(r'[^a-zA-Z0-9\u4e00-\u9fff]', '_', final_text)[:150] or "text"

        # 处理背景图（支持批量输入）
        # 确保是4D张量 [B, H, W, C]
        if background_image.ndim == 3:
            background_image = background_image.unsqueeze(0)

        batch_size = background_image.shape[0]
        background_images = [background_image[i] for i in range(batch_size)]

        # 处理水印图（支持批量输入）
        watermark_images = []
        if watermark_image is not None:
            if watermark_image.ndim == 3:
                watermark_image = watermark_image.unsqueeze(0)
            if watermark_image.ndim == 4:
                # 如果水印是批量的，且数量与背景一致，则一一对应；否则只取第一张或循环使用
                if watermark_image.shape[0] == batch_size:
                    watermark_images = [watermark_image[i] for i in range(batch_size)]
                else:
                    # 简单处理：如果数量不匹配，只取第一张作为全局水印，或者按需扩展
                    # 这里假设如果数量不一致，就只用第一张重复使用，或者如果只有一张
                    wm_single = watermark_image[0]
                    watermark_images = [wm_single] * batch_size

        # 批量处理
        composite_outputs = []

        # 预加载字体以避免在循环中重复加载
        try:
            font = ImageFont.truetype(resolve_font_path(font_path), font_size)
        except:
            font = ImageFont.load_default(size=font_size)

        # 颜色转换
        text_col_rgb = hex2rgb(color_hex, (255, 215, 0))
        stroke_col_rgb = hex2rgb(stroke_color_hex, (0, 0, 0))

        # 应用文本透明度到颜色
        text_alpha = int(255 * text_opacity)
        text_fill = (*text_col_rgb, text_alpha)
        stroke_fill = (*stroke_col_rgb, text_alpha) if use_stroke else None

        sw = stroke_width if use_stroke else 0

        for i, bg_tensor in enumerate(background_images):
            bg_pil = tensor_to_pil(bg_tensor).convert("RGBA")
            canvas_width, canvas_height = bg_pil.size

            # 调试：打印输入图像信息
            print(f"[DEBUG] 输入图像 {i}: PIL mode={bg_pil.mode}, size={bg_pil.size}")

            # 创建文字图层
            text_layer = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
            draw = ImageDraw.Draw(text_layer)

            # 处理空文本
            current_text = final_text if final_text else ""

            if current_text:
                # 支持多行文本：按换行符分割
                lines = current_text.split('\n')

                # 计算字符尺寸用于间距计算
                sample_char = current_text[0] if current_text else 'A'
                bbox = draw.textbbox((0, 0), sample_char, font=font)
                cw = bbox[2] - bbox[0]
                ch = bbox[3] - bbox[1]

                # 计算行高（字体大小 + 额外间距）
                line_height = ch + spacing + 10  # 10px 额外行间距

                # 解析起始位置
                start_x = resolve_axis_position(x, canvas_width)
                start_y = resolve_axis_position(y, canvas_height)

                # 横竖排版绘制
                if is_vertical_direction(direction):
                    # 纵向：每行从上到下，多行从左到右排列
                    for line_idx, line in enumerate(lines):
                        cx = start_x + line_idx * (cw + spacing + 5)  # 行间距
                        cy = start_y
                        for c in line:
                            draw.text((cx, cy), c, font=font, fill=text_fill,
                                      stroke_width=sw, stroke_fill=stroke_fill)
                            cy += ch + spacing
                else:
                    # 横向：每行从左到右，多行从上到下排列
                    for line_idx, line in enumerate(lines):
                        cx = start_x
                        cy = start_y + line_idx * line_height
                        for c in line:
                            draw.text((cx, cy), c, font=font, fill=text_fill,
                                      stroke_width=sw, stroke_fill=stroke_fill)
                            cx += cw + spacing

            # 合成文本到背景
            composite = Image.alpha_composite(bg_pil, text_layer)

            # 处理水印叠加
            if i < len(watermark_images):
                wm_tensor = watermark_images[i]
                wm_pil = tensor_to_pil(wm_tensor).convert("RGBA")

                # 关键修复：如果有 watermark_mask，将其合成到水印的 Alpha 通道
                if watermark_mask is not None:
                    # 获取当前图片对应的 mask
                    mask_tensor = watermark_mask

                    # 处理 mask 的批次维度
                    if mask_tensor.ndim == 4:
                        # 批量 mask，取对应的索引
                        mask_idx = i if mask_tensor.shape[0] > 1 else 0
                        mask_tensor = mask_tensor[mask_idx]

                    # mask 可能是 [H, W] 或 [H, W, 1]
                    if mask_tensor.ndim == 3:
                        mask_tensor = mask_tensor.squeeze(-1)

                    # 转换为 numpy 数组
                    mask_np = mask_tensor.cpu().numpy()

                    # 归一化到 0-255
                    if mask_np.max() <= 1.0:
                        mask_np = (mask_np * 255).astype(np.uint8)
                    else:
                        mask_np = mask_np.astype(np.uint8)

                    # 调整 mask 尺寸到水印大小
                    mask_pil = Image.fromarray(mask_np, mode="L")
                    mask_pil = mask_pil.resize(wm_pil.size, Image.LANCZOS)

                    # 将 mask 设置为水印的 Alpha 通道
                    wm_pil.putalpha(mask_pil)

                # 应用水印宽度缩放
                if watermark_width != 1.0:
                    orig_width, orig_height = wm_pil.size
                    new_width = max(1, int(orig_width * watermark_width))
                    new_height = max(1, int(orig_height * watermark_width))
                    wm_pil = wm_pil.resize((new_width, new_height), Image.LANCZOS)

                # 应用水印透明度
                if watermark_opacity < 1.0:
                    wm_pil = apply_opacity(wm_pil, watermark_opacity)

                # 确定水印位置
                wx = int(resolve_axis_position(x, canvas_width))
                wy = int(resolve_axis_position(y, canvas_height))

                # 创建水印图层以支持位置偏移
                watermark_layer = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
                watermark_layer.paste(wm_pil, (wx, wy), mask=wm_pil)

                composite = Image.alpha_composite(composite, watermark_layer)

            # 转换为tensor
            # 调试：打印图像信息
            print(f"[DEBUG] 合成后图像 {i}: PIL mode={composite.mode}, size={composite.size}")

            comp_out = pil_to_tensor(composite.convert("RGB"))

            # 调试：打印 Tensor 形状
            print(f"[DEBUG] 输出 Tensor {i} shape: {comp_out.shape}, ndim: {comp_out.ndim}")

            composite_outputs.append(comp_out)

        # 批量输出：直接返回批量图片队列，不拼接
        # 每张输入图片对应一张输出图片
        if len(composite_outputs) == 1:
            # 单张图片：返回 4D Tensor [1, H, W, C]
            composite_out = composite_outputs[0]
            if composite_out.ndim == 3:
                composite_out = composite_out.unsqueeze(0)
        else:
            # 多张图片：批量输出，保持每张独立
            composite_out = torch.stack(composite_outputs, dim=0)

        # 只返回结果，不包含 UI 数据
        return (composite_out,)

# 注册
NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TextOverlay}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 👣 批量文本图片水印叠加"}
