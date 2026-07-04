import re
import os
import json
import base64
import io
import urllib.parse
import urllib.request
import numpy as np
import torch
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

import folder_paths
from .common_utils import DEFAULT_MODEL_URL, build_node_help_payload, make_model_tree_item
from .common_utils.dependency_checker import make_missing_model_spec, raise_dependency_model_error
from .common_utils.temp_files import gjjutils_read_temp_pil_image, gjjutils_write_temp_bytes
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE

FONT_EXTENSIONS = {".ttf", ".otf", ".ttc", ".otc"}
NODE_NAME = "GJJ_TextOverlay"
NODE_DISPLAY_NAME = "GJJ · 👣 批量文本图片前景叠加"
MIXED_BATCH_IMAGE_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
MODEL_DOWNLOAD_URL = DEFAULT_MODEL_URL
RMBG14_MODEL_TREE = [
    make_model_tree_item(
        label="RMBG1.4 模型",
        folder="RMBG",
        filename="rmbg1.4.safetensors",
        description="前景自动抠图使用的本地 RMBG1.4 模型；默认读取 models/RMBG/rmbg1.4.safetensors，也会沿用综合抠图节点的模糊搜索。",
        kind="diffusion",
    )
]
RMBG14_MODEL_SPEC = make_missing_model_spec(
    label="RMBG1.4 模型",
    subdir="RMBG",
    filename="rmbg1.4.safetensors",
    description="前景自动抠图使用的本地 RMBG1.4 模型。",
)
RMBG14_PREVIEW_API = "/gjj/text_overlay/rmbg14_preview"
FETCH_LOGO_API = "/gjj/text_overlay/fetch_logo_url"
WRITE_TEMP_IMAGE_API = "/gjj/text_overlay/write_temp_image"


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


def clamp_ratio(value):
    value = float(value)
    return max(0.0, min(1.0, value))


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


def auto_remove_watermark_background(image: Image.Image) -> Image.Image:
    """自动把白底或黑底前景背景转成透明。"""
    background_threshold = 3.0
    rgba = image.convert("RGBA")
    arr = np.array(rgba).astype(np.float32)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3]
    height, width = alpha.shape
    if height < 2 or width < 2:
        return rgba

    border = max(1, min(6, height // 12, width // 12))
    edge_mask = np.zeros((height, width), dtype=bool)
    edge_mask[:border, :] = True
    edge_mask[-border:, :] = True
    edge_mask[:, :border] = True
    edge_mask[:, -border:] = True
    visible_edge = edge_mask & (alpha > 8)
    if not np.any(visible_edge):
        return rgba

    edge_rgb = rgb[visible_edge]
    white_dist = np.linalg.norm(edge_rgb - 255.0, axis=1)
    black_dist = np.linalg.norm(edge_rgb, axis=1)
    white_score = float(np.mean(white_dist < background_threshold))
    black_score = float(np.mean(black_dist < background_threshold))

    if max(white_score, black_score) < 0.35:
        return rgba

    target = 255.0 if white_score >= black_score else 0.0
    dist = np.linalg.norm(rgb - target, axis=2)
    hard = 18.0
    feather = 92.0
    keep = np.clip((dist - hard) / (feather - hard), 0.0, 1.0)
    keep = keep * keep * (3.0 - 2.0 * keep)
    keep[keep < 0.08] = 0.0

    # 白/黑底抗锯齿会把背景色混进边缘 RGB；先反混色再写 alpha，减少白边/黑边。
    safe_keep = np.maximum(keep[:, :, None], 0.001)
    arr[:, :, :3] = np.clip((rgb - target * (1.0 - keep[:, :, None])) / safe_keep, 0, 255)
    arr[:, :, 3] = alpha * keep
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGBA")


def image_has_transparency(image: Image.Image) -> bool:
    if "A" not in image.getbands():
        return False
    try:
        alpha_min, alpha_max = image.getchannel("A").getextrema()
        return alpha_min < 255
    except Exception:
        return False


def remove_watermark_background_rmbg14(image: Image.Image) -> Image.Image:
    from .gjj_comprehensive_matting import (
        METHOD_RMBG14,
        _load_rmbg14_model,
        _resolve_model_path,
        _run_rmbg14,
        _select_device,
    )

    rgba = image.convert("RGBA")
    try:
        weight_path = _resolve_model_path(METHOD_RMBG14)
        device = _select_device("自动")
        model = _load_rmbg14_model(weight_path, device)
    except Exception as exc:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[RMBG14_MODEL_SPEC],
            description="TextOverlay 的前景自动抠图需要本地 RMBG1.4 模型。",
            original_error=str(exc),
            title="GJJ TextOverlay 模型缺失！",
            model_download_url=MODEL_DOWNLOAD_URL,
        )
    mask = _run_rmbg14(model, [rgba], device, 1024)[0].convert("L")
    if mask.size != rgba.size:
        resample_lanczos = getattr(
            getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS
        )
        mask = mask.resize(rgba.size, resample_lanczos)
    original_alpha = rgba.getchannel("A")
    alpha = ImageChops.multiply(original_alpha, mask)
    rgba.putalpha(alpha)
    return auto_remove_watermark_background(rgba)


def resolve_input_image_path(filename):
    value = str(filename or "").replace("\\", "/").strip()
    if not value:
        return None
    if os.path.isfile(value):
        return value
    try:
        return folder_paths.get_annotated_filepath(value)
    except Exception:
        pass
    try:
        input_dir = folder_paths.get_input_directory()
    except Exception:
        input_dir = ""
    if not input_dir:
        return None
    candidate = os.path.abspath(os.path.join(input_dir, value))
    root = os.path.abspath(input_dir)
    if os.path.isfile(candidate) and os.path.commonpath([root, candidate]) == root:
        return candidate
    return None


def resolve_comfy_image_path(filename, image_type="input", subfolder=""):
    name = str(filename or "").replace("\\", "/").strip().lstrip("/")
    if not name:
        return None
    kind = str(image_type or "input").strip().lower()
    sub = str(subfolder or "").replace("\\", "/").strip().strip("/")
    if "/" in name and not sub:
        parts = name.split("/")
        name = parts[-1]
        sub = "/".join(parts[:-1])
    if kind == "temp":
        root = folder_paths.get_temp_directory()
    elif kind == "output":
        root = folder_paths.get_output_directory()
    else:
        return resolve_input_image_path("/".join(part for part in (sub, name) if part))
    candidate = os.path.abspath(os.path.join(root, sub, name))
    root_abs = os.path.abspath(root)
    if os.path.isfile(candidate) and os.path.commonpath([root_abs, candidate]) == root_abs:
        return candidate
    return None


def make_watermark_outline(alpha, width):
    width = max(0, int(width))
    if width <= 0:
        return None
    expanded = alpha.filter(ImageFilter.MaxFilter(width * 2 + 1))
    outline = Image.new("L", alpha.size, 0)
    outline.paste(expanded)
    outline = ImageChops.subtract(outline, alpha)
    return outline


def style_watermark_image(
    image: Image.Image,
    shadow_enabled: bool,
    shadow_blur: float,
    shadow_x: float,
    shadow_y: float,
    shadow_color_hex: str,
    stroke_enabled: bool,
    stroke_width: int,
    stroke_color_hex: str,
) -> Image.Image:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    layers = []

    if stroke_enabled and int(stroke_width) > 0:
        outline = make_watermark_outline(alpha, int(stroke_width))
        if outline is not None:
            color = (*hex2rgb(stroke_color_hex, (0, 0, 0)), 255)
            stroke = Image.new("RGBA", rgba.size, color)
            stroke.putalpha(outline)
            layers.append((stroke, 0, 0))

    if shadow_enabled:
        blur = max(0.0, float(shadow_blur))
        dx = int(round(float(shadow_x)))
        dy = int(round(float(shadow_y)))
        shadow_alpha = alpha.filter(ImageFilter.GaussianBlur(radius=blur))
        color = (*hex2rgb(shadow_color_hex, (0, 0, 0)), 190)
        shadow = Image.new("RGBA", rgba.size, color)
        shadow.putalpha(shadow_alpha)
        layers.insert(0, (shadow, dx, dy))

    if not layers:
        return rgba

    left = min(0, *(x for _, x, _ in layers))
    top = min(0, *(y for _, _, y in layers))
    right = max(rgba.width, *(x + layer.width for layer, x, _ in layers))
    bottom = max(rgba.height, *(y + layer.height for layer, _, y in layers))
    result = Image.new("RGBA", (right - left, bottom - top), (0, 0, 0, 0))
    for layer, x, yy in layers:
        result.alpha_composite(layer, (x - left, yy - top))
    result.alpha_composite(rgba, (-left, -top))
    return result


def _register_text_overlay_api():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    routes = PromptServer.instance.routes

    @routes.post(RMBG14_PREVIEW_API)
    async def rmbg14_preview(request):
        try:
            data = await request.json()
            filename = str(data.get("filename") or "").strip()
            if not filename:
                return web.json_response({"ok": False, "error": "缺少前景文件名"}, status=400)
            path = resolve_comfy_image_path(filename, data.get("type") or "input", data.get("subfolder") or "")
            if not path:
                return web.json_response({"ok": False, "error": "找不到前景文件"}, status=404)
            cutout = remove_watermark_background_rmbg14(Image.open(path).convert("RGBA"))
            buffer = io.BytesIO()
            cutout.save(buffer, format="PNG")
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
            return web.json_response({
                "ok": True,
                "src": f"data:image/png;base64,{encoded}",
                "width": cutout.width,
                "height": cutout.height,
            })
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post(FETCH_LOGO_API)
    async def fetch_logo_url(request):
        try:
            data = await request.json()
            url = str(data.get("url") or "").strip()
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                return web.json_response({"ok": False, "error": "只支持 http/https 前景地址"}, status=400)
            request_obj = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (ComfyUI_GJJ_TextOverlay)",
                    "Accept": "image/svg+xml,image/*,*/*;q=0.8",
                },
            )
            with urllib.request.urlopen(request_obj, timeout=20) as response:
                content_type = str(response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                raw = response.read(12 * 1024 * 1024 + 1)
            if len(raw) > 12 * 1024 * 1024:
                return web.json_response({"ok": False, "error": "前景文件超过 12MB"}, status=400)
            path_name = urllib.parse.unquote(os.path.basename(parsed.path or "logo")).strip() or "logo"
            lower_name = path_name.lower()
            if content_type in {"image/svg+xml", "text/xml", "application/xml"} or lower_name.endswith(".svg") or raw.lstrip().startswith(b"<svg"):
                mime = "image/svg+xml"
                filename = re.sub(r"\.[^.]+$", "", path_name) + ".png"
            else:
                try:
                    image = Image.open(io.BytesIO(raw))
                    image.verify()
                    mime = content_type if content_type.startswith("image/") else "image/png"
                except Exception:
                    return web.json_response({"ok": False, "error": "网络资源不是可识别图片"}, status=400)
                stem = re.sub(r"\.[^.]+$", "", path_name) or "logo"
                filename = f"{stem}.png"
            encoded = base64.b64encode(raw).decode("ascii")
            return web.json_response({
                "ok": True,
                "src": f"data:{mime};base64,{encoded}",
                "mime": mime,
                "filename": filename,
                "url": url,
            })
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post(WRITE_TEMP_IMAGE_API)
    async def write_temp_image(request):
        try:
            data = await request.json()
            src = str(data.get("src") or "")
            if not src.startswith("data:") or "," not in src:
                return web.json_response({"ok": False, "error": "缺少 dataURL 图片数据"}, status=400)
            header, body = src.split(",", 1)
            raw = base64.b64decode(body) if ";base64" in header else urllib.parse.unquote_to_bytes(body)
            if len(raw) > 24 * 1024 * 1024:
                return web.json_response({"ok": False, "error": "图片超过 24MB"}, status=400)
            suffix = os.path.splitext(str(data.get("name") or ""))[1].lower()
            if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
                mime = header.split(";", 1)[0].replace("data:", "").lower()
                suffix = {
                    "image/jpeg": ".jpg",
                    "image/webp": ".webp",
                    "image/bmp": ".bmp",
                }.get(mime, ".png")
            info = gjjutils_write_temp_bytes(raw, suffix=suffix)
            return web.json_response({"ok": True, **info})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)


_register_text_overlay_api()


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

    # 确保是3维数组 [H, W, C]
    if np_img.ndim == 2:
        # 如果是灰度图，扩展为3通道
        np_img = np.stack([np_img] * 3, axis=-1)
    elif np_img.ndim == 3 and np_img.shape[2] == 4:
        # 如果是 RGBA，转换为 RGB
        np_img = np_img[:, :, :3]

    # 转换为 float32 并归一化
    np_img = np_img.astype(np.float32) / 255.0

    tensor = torch.from_numpy(np_img)

    return tensor

def split_image_input(value):
    if value is None:
        return []
    if isinstance(value, torch.Tensor):
        if value.ndim == 3:
            return [value]
        if value.ndim == 4:
            return [value[i].contiguous() for i in range(int(value.shape[0]))]
        return [value]
    if isinstance(value, (list, tuple)):
        images = []
        for item in value:
            images.extend(split_image_input(item))
        return images
    return []

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
    DESCRIPTION = "将文本或前景图叠加到背景图上，支持批量处理；前景图可使用本地 RMBG1.4 模型自动抠图，并添加阴影、描边。"
    SEARCH_ALIASES = ["text overlay", "text image overlay", "前景", "叠加", "图片", "批量", "batch"]
    GJJ_HELP = build_node_help_payload(
        description=DESCRIPTION,
        dependencies=[
            {
                "name": "RMBG1.4",
                "type": "本地模型",
                "required": False,
                "description": "仅在启用前景自动抠图时需要。",
            },
            {
                "name": "torchvision",
                "type": "运行依赖",
                "required": False,
                "description": "RMBG1.4 推理链路依赖；通常随 ComfyUI/PyTorch 环境提供。",
            },
        ],
        model_tree=RMBG14_MODEL_TREE,
        models=[RMBG14_MODEL_SPEC],
        usage=[
            "背景图必填；文本为空时不会在画布上显示文字预览。",
            "前景图可连接前景图输入，也可通过面板按钮选择本地图片。",
            "启用 RMBG1.4 抠图后，执行时会用 models/RMBG/rmbg1.4.safetensors 生成前景透明通道。",
        ],
        runtime=[
            "前景阴影和描边会在 RMBG1.4 抠图之后应用。",
            "批量背景会保持同一相对文字和前景位置。",
        ],
        model_download_url=MODEL_DOWNLOAD_URL,
        notice="RMBG1.4 只在前景自动抠图开启时需要；模型按模型树放入对应目录后刷新或重启 ComfyUI。",
        extra={
            "model_tree": RMBG14_MODEL_TREE,
            "models_tree": RMBG14_MODEL_TREE,
            "static_model_tree_only": True,
            "model_tree_priority": "static",
        },
    )

    FUNCTION = "run"
    RETURN_TYPES = (MIXED_BATCH_IMAGE_TYPE,)
    RETURN_NAMES = ("叠加后图像",)
    OUTPUT_TOOLTIPS = ("文本或前景叠加后的图像队列；不同尺寸图片会保持原尺寸和同一相对位置。",)

    INPUT_IS_LIST = False
    OUTPUT_IS_LIST = (True,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
            },
            "optional": {
                "background_image": (MIXED_BATCH_IMAGE_TYPE, {
                    "display_name": "背景图",
                    "tooltip": "需要叠加文字或前景的背景图像；支持单图/批量图片输入。也可以用面板 📂 打开本地背景。",
                }),
                "texts": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "文本列表",
                    "tooltip": "支持多行文本，每行独立显示。可用分隔符和索引抽取第一行的部分内容。",
                }),
                "watermark_image": (MIXED_BATCH_IMAGE_TYPE, {
                    "display_name": "前景图",
                    "tooltip": "可选，前景图像；启用前景自动抠图时会使用本地 RMBG1.4 生成透明通道，支持单图/批量输入。",
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
                    "display_name": "前景透明度",
                    "tooltip": "前景的整体透明度（0.0=完全透明，1.0=完全不透明）",
                }),
                "watermark_width": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.1,
                    "max": 10.0,
                    "step": 0.1,
                    "display_name": "前景宽度",
                    "tooltip": "前景宽度缩放比例（1.0=原始尺寸，0.5=缩小一半，2.0=放大两倍）",
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
                    "max": 1,
                    "step": 0.01,
                    "display_name": "X位置",
                    "tooltip": "横向位置比例，0.0=最左，0.5=居中，1.0=最右；批量不同尺寸图片会保持同一相对位置。",
                }),
                "y": ("FLOAT", {
                    "default": 0.5,
                    "min": 0,
                    "max": 1,
                    "step": 0.01,
                    "display_name": "Y位置",
                    "tooltip": "纵向位置比例，0.0=最上，0.5=居中，1.0=最下；批量不同尺寸图片会保持同一相对位置。",
                }),
                "text_x": ("FLOAT", {
                    "default": -1.0,
                    "min": -1.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "文字X位置",
                    "tooltip": "内部使用：文字 X 位置。-1 表示沿用旧版 X位置。",
                }),
                "text_y": ("FLOAT", {
                    "default": -1.0,
                    "min": -1.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "文字Y位置",
                    "tooltip": "内部使用：文字 Y 位置。-1 表示沿用旧版 Y位置。",
                }),
                "watermark_x": ("FLOAT", {
                    "default": -1.0,
                    "min": -1.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "前景X位置",
                    "tooltip": "内部使用：前景 X 位置。-1 表示沿用旧版 X位置。",
                }),
                "watermark_y": ("FLOAT", {
                    "default": -1.0,
                    "min": -1.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "前景Y位置",
                    "tooltip": "内部使用：前景 Y 位置。-1 表示沿用旧版 Y位置。",
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
                "watermark_upload_name": ("STRING", {
                    "default": "",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "面板选择前景",
                    "tooltip": "内部使用：面板按钮上传并选择的前景图片。",
                }),
                "logo_remove_bg": ("BOOLEAN", {
                    "default": True,
                    "display_name": "前景自动抠图",
                    "tooltip": "启用后使用本地 RMBG1.4 模型自动去除前景背景。",
                }),
                "logo_shadow_enabled": ("BOOLEAN", {
                    "default": False,
                    "display_name": "前景阴影",
                    "tooltip": "启用后给前景增加阴影。",
                }),
                "logo_shadow_blur": ("FLOAT", {
                    "default": 8.0,
                    "min": 0.0,
                    "max": 64.0,
                    "step": 0.5,
                    "display_name": "前景阴影模糊",
                    "tooltip": "前景阴影的柔化半径。",
                }),
                "logo_shadow_x": ("FLOAT", {
                    "default": 4.0,
                    "min": -128.0,
                    "max": 128.0,
                    "step": 1.0,
                    "display_name": "前景阴影X",
                    "tooltip": "前景阴影横向偏移。",
                }),
                "logo_shadow_y": ("FLOAT", {
                    "default": 4.0,
                    "min": -128.0,
                    "max": 128.0,
                    "step": 1.0,
                    "display_name": "前景阴影Y",
                    "tooltip": "前景阴影纵向偏移。",
                }),
                "logo_shadow_color_hex": ("STRING", {
                    "default": "#000000",
                    "display_name": "前景阴影颜色",
                    "tooltip": "前景阴影颜色，例如 #000000。",
                }),
                "logo_stroke_enabled": ("BOOLEAN", {
                    "default": False,
                    "display_name": "前景描边",
                    "tooltip": "启用后给前景透明轮廓增加描边。",
                }),
                "logo_stroke_width": ("INT", {
                    "default": 3,
                    "min": 0,
                    "display_name": "前景描边宽度",
                    "tooltip": "前景描边宽度，填 0 表示不绘制。",
                }),
                "logo_stroke_color_hex": ("STRING", {
                    "default": "#FFFFFF",
                    "display_name": "前景描边颜色",
                    "tooltip": "前景描边颜色，例如 #FFFFFF。",
                }),
                "logo_default_url": ("STRING", {
                    "default": "",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "默认网络前景",
                    "tooltip": "内部使用：面板 🌏 按钮设置的网络默认前景地址。",
                }),
                "watermark_objects_json": ("STRING", {
                    "default": "[]",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "拖拽前景对象",
                    "tooltip": "内部使用：拖拽添加的多个前景对象、位置和缩放。",
                }),
                "background_image_ref_json": ("STRING", {
                    "default": "{}",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "面板背景图",
                    "tooltip": "内部使用：面板 📂 打开的临时背景图。",
                }),
            },
            "hidden": {
                "has_watermark_input": ("BOOLEAN", {
                    "default": False,
                    "display_name": "是否有前景输入",
                    "tooltip": "内部使用，用于控制参数显示",
                }),
            },
        }

    def run(self,
            background_image=None,
            texts="",
            watermark_image=None,
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
            x=0.5,
            y=0.5,
            text_x=-1.0,
            text_y=-1.0,
            watermark_x=-1.0,
            watermark_y=-1.0,
            color_hex="#FFD700",
            stroke_color_hex="#000000",
            use_stroke=True,
            stroke_width=2,
            watermark_upload_name="",
            logo_remove_bg=True,
            logo_shadow_enabled=False,
            logo_shadow_blur=8.0,
            logo_shadow_x=4.0,
            logo_shadow_y=4.0,
            logo_shadow_color_hex="#000000",
            logo_stroke_enabled=False,
            logo_stroke_width=3,
            logo_stroke_color_hex="#FFFFFF",
            logo_default_url="",
            watermark_objects_json="[]",
            background_image_ref_json="{}"):

        seed = int(seed)
        font_size = max(1, int(font_size))
        stroke_width = max(0, int(stroke_width))
        x = float(x)
        y = float(y)
        text_x = clamp_ratio(x if float(text_x) < 0 else text_x)
        text_y = clamp_ratio(y if float(text_y) < 0 else text_y)
        watermark_x = clamp_ratio(x if float(watermark_x) < 0 else watermark_x)
        watermark_y = clamp_ratio(y if float(watermark_y) < 0 else watermark_y)
        text_opacity = float(text_opacity)
        watermark_opacity = float(watermark_opacity)

        # 处理背景图（支持批量输入和 GJJ 图片队列列表）
        background_images = split_image_input(background_image)
        if not background_images:
            try:
                background_ref = json.loads(str(background_image_ref_json or "{}"))
                if isinstance(background_ref, dict) and background_ref.get("filename"):
                    bg_pil = gjjutils_read_temp_pil_image(background_ref).convert("RGB")
                    background_images = [pil_to_tensor(bg_pil)]
            except Exception:
                background_images = []
        if not background_images:
            raise RuntimeError("背景图输入为空，请连接背景图，或用面板 📂 打开本地背景图。")

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

        final_text = re.sub(r"\s*\n\s*", " ", final_text).strip()

        # 文件名
        filename = re.sub(r'[^a-zA-Z0-9\u4e00-\u9fff]', '_', final_text)[:150] or "text"

        batch_size = len(background_images)

        # 处理前景图（支持批量输入、GJJ 图片队列列表和面板拖拽对象）。多张时全部依次叠加到每张背景图。
        watermark_entries = []
        if watermark_image is not None:
            watermark_entries = [
                {"tensor": item, "x": watermark_x, "y": watermark_y, "scale": float(watermark_width)}
                for item in split_image_input(watermark_image)
            ]
        else:
            try:
                objects = json.loads(str(watermark_objects_json or "[]"))
                if not isinstance(objects, list):
                    objects = []
            except Exception:
                objects = []
            for item in objects:
                if not isinstance(item, dict):
                    continue
                try:
                    if str(item.get("type") or "").lower() == "temp":
                        upload_pil = gjjutils_read_temp_pil_image(item).convert("RGBA")
                    else:
                        upload_path = resolve_input_image_path(item.get("filename") or "")
                        if not upload_path:
                            continue
                        upload_pil = Image.open(upload_path).convert("RGBA")
                    watermark_entries.append({
                        "pil": upload_pil,
                        "x": clamp_ratio(item.get("x", watermark_x)),
                        "y": clamp_ratio(item.get("y", watermark_y)),
                        "scale": float(item.get("scale", watermark_width) or watermark_width),
                        "stroke_enabled": bool(item.get("stroke_enabled", False)),
                        "stroke_width": int(item.get("stroke_width", logo_stroke_width) or logo_stroke_width),
                        "stroke_color_hex": str(item.get("stroke_color_hex") or logo_stroke_color_hex),
                    })
                except Exception:
                    pass

        if watermark_image is None and watermark_upload_name:
            upload_path = resolve_input_image_path(watermark_upload_name)
            if upload_path:
                try:
                    upload_pil = Image.open(upload_path).convert("RGBA")
                    watermark_entries.append({"pil": upload_pil, "x": watermark_x, "y": watermark_y, "scale": float(watermark_width)})
                except Exception:
                    pass

        # 批量处理
        composite_outputs = []
        preview_meta = {
            "background_width": 0,
            "background_height": 0,
            "watermark_source_width": 0,
            "watermark_source_height": 0,
            "watermark_width": 0,
            "watermark_height": 0,
            "watermark_x": 0,
            "watermark_y": 0,
            "text_x": 0,
            "text_y": 0,
            "font_size": int(font_size),
        }

        # 颜色转换
        text_col_rgb = hex2rgb(color_hex, (255, 215, 0))
        stroke_col_rgb = hex2rgb(stroke_color_hex, (0, 0, 0))

        # 应用文本透明度到颜色
        text_alpha = int(255 * text_opacity)
        text_fill = (*text_col_rgb, text_alpha)
        stroke_fill = (*stroke_col_rgb, text_alpha) if use_stroke else None

        reference_height = max(1, int(background_images[0].shape[0]))
        reference_width = max(1, int(background_images[0].shape[1]))
        styled_watermarks = []
        for entry in watermark_entries:
            wm_pil = entry.get("pil")
            if wm_pil is None:
                wm_pil = tensor_to_pil(entry.get("tensor")).convert("RGBA")
            else:
                wm_pil = wm_pil.convert("RGBA")
            if logo_remove_bg and not image_has_transparency(wm_pil):
                wm_pil = remove_watermark_background_rmbg14(wm_pil)
            wm_pil = style_watermark_image(
                wm_pil,
                bool(logo_shadow_enabled),
                logo_shadow_blur,
                logo_shadow_x,
                logo_shadow_y,
                logo_shadow_color_hex,
                bool(entry.get("stroke_enabled", logo_stroke_enabled)),
                int(entry.get("stroke_width", logo_stroke_width) or logo_stroke_width),
                str(entry.get("stroke_color_hex") or logo_stroke_color_hex),
            )
            styled_watermarks.append({
                "image": wm_pil,
                "x": clamp_ratio(entry.get("x", watermark_x)),
                "y": clamp_ratio(entry.get("y", watermark_y)),
                "scale": float(entry.get("scale", watermark_width) or watermark_width),
            })

        for i, bg_tensor in enumerate(background_images):
            bg_pil = tensor_to_pil(bg_tensor).convert("RGBA")
            canvas_width, canvas_height = bg_pil.size
            style_scale = min(
                canvas_width / reference_width,
                canvas_height / reference_height,
            )
            scaled_font_size = max(1, int(round(font_size * style_scale)))
            scaled_spacing = float(spacing) * style_scale
            scaled_stroke_width = max(0, int(round(stroke_width * style_scale))) if use_stroke else 0
            scaled_line_gap = max(1, int(round(10 * style_scale)))
            scaled_column_gap = max(1, int(round(5 * style_scale)))
            try:
                font = ImageFont.truetype(resolve_font_path(font_path), scaled_font_size)
            except:
                font = ImageFont.load_default(size=scaled_font_size)
            if i == 0:
                preview_meta["background_width"] = int(canvas_width)
                preview_meta["background_height"] = int(canvas_height)
                preview_meta["font_size"] = int(scaled_font_size)

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
                line_height = ch + scaled_spacing + scaled_line_gap

                # 解析起始位置
                start_x = text_x * canvas_width
                start_y = text_y * canvas_height

                # 横竖排版绘制
                if is_vertical_direction(direction):
                    # 纵向：每行从上到下，多行从左到右排列
                    for line_idx, line in enumerate(lines):
                        cx = start_x + line_idx * (cw + scaled_spacing + scaled_column_gap)
                        cy = start_y
                        for c in line:
                            draw.text((cx, cy), c, font=font, fill=text_fill,
                                      stroke_width=scaled_stroke_width, stroke_fill=stroke_fill)
                            cy += ch + scaled_spacing
                else:
                    # 横向：每行从左到右，多行从上到下排列
                    for line_idx, line in enumerate(lines):
                        cx = start_x
                        cy = start_y + line_idx * line_height
                        for c in line:
                            draw.text((cx, cy), c, font=font, fill=text_fill,
                                      stroke_width=scaled_stroke_width, stroke_fill=stroke_fill)
                            cx += cw + scaled_spacing

            # 合成文本到背景
            composite = Image.alpha_composite(bg_pil, text_layer)

            # 处理前景叠加
            for wm_index, styled_wm in enumerate(styled_watermarks):
                wm_pil = styled_wm["image"].copy()
                orig_width, orig_height = wm_pil.size
                if i == 0 and wm_index == 0:
                    preview_meta["watermark_source_width"] = int(orig_width)
                    preview_meta["watermark_source_height"] = int(orig_height)

                # 应用前景宽度缩放；批量不同尺寸背景时，按第一张背景为参考等比协调。
                effective_watermark_width = float(styled_wm.get("scale", watermark_width)) * style_scale
                if effective_watermark_width != 1.0:
                    new_width = max(1, int(round(orig_width * effective_watermark_width)))
                    new_height = max(1, int(round(orig_height * effective_watermark_width)))
                    wm_pil = wm_pil.resize((new_width, new_height), Image.LANCZOS)

                # 应用前景透明度
                if watermark_opacity < 1.0:
                    wm_pil = apply_opacity(wm_pil, watermark_opacity)

                # 确定前景位置
                wx = int(round(float(styled_wm.get("x", watermark_x)) * canvas_width))
                wy = int(round(float(styled_wm.get("y", watermark_y)) * canvas_height))
                if i == 0 and wm_index == 0:
                    preview_meta["watermark_width"] = int(wm_pil.size[0])
                    preview_meta["watermark_height"] = int(wm_pil.size[1])
                    preview_meta["watermark_x"] = int(wx)
                    preview_meta["watermark_y"] = int(wy)
                    preview_meta["text_x"] = int(round(text_x * canvas_width))
                    preview_meta["text_y"] = int(round(text_y * canvas_height))

                # 创建前景图层以支持位置偏移
                watermark_layer = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
                watermark_layer.paste(wm_pil, (wx, wy), mask=wm_pil)

                composite = Image.alpha_composite(composite, watermark_layer)

            comp_out = pil_to_tensor(composite.convert("RGB")).unsqueeze(0)
            composite_outputs.append(comp_out)

        return {
            "ui": {
                "gjj_text_overlay": [preview_meta],
            },
            "result": (composite_outputs,),
        }

# 注册
NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_TextOverlay}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
