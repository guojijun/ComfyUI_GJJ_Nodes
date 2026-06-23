from __future__ import annotations

import re
from typing import Any

import torch
import torch.nn.functional as F

NODE_NAME = "GJJ_ImageBatchMulti"
COMPAT_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
INPUT_MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"
ORIGINAL_SIZE_OPTION = "原始尺寸"
SIZE_PRESET_OPTIONS = ("320", "480", "720", "1024", "2K", "4K", ORIGINAL_SIZE_OPTION)
ORIENTATION_OPTIONS = ("原始比例", "横屏", "竖屏", "正方形")
PREPEND_FRAME_OPTIONS = ("无", "黑帧", "白帧")
DEFAULT_SIZE_PRESET = ORIGINAL_SIZE_OPTION
FALLBACK_SIZE_PRESET = "320"
DEFAULT_ORIENTATION = "原始比例"
DEFAULT_PREPEND_FRAME = "无"
DEFAULT_CUSTOM_SIZE = 0
DEFAULT_CUSTOM_RATIO = "1:1"
ALIGN_MULTIPLE_OPTIONS = ("2", "4", "8", "16", "32", "64")
DEFAULT_ALIGN_MULTIPLE = "16"
MAX_INPUTS = 16  # 固定最大输入口数量
ORIGINAL_RATIO_EDGE_MODES = {
    "320": ("short", 320),
    "480": ("short", 480),
    "720": ("short", 720),
    "1024": ("short", 1024),
    "2K": ("long", 2048),
    "4K": ("long", 3840),
}
SIZE_PRESET_DIMENSIONS = {
    "320": {"横屏": (576, 320), "竖屏": (320, 576), "正方形": (320, 320)},
    "480": {"横屏": (864, 480), "竖屏": (480, 864), "正方形": (480, 480)},
    "720": {"横屏": (1280, 720), "竖屏": (720, 1280), "正方形": (720, 720)},
    "1024": {"横屏": (1824, 1024), "竖屏": (1024, 1824), "正方形": (1024, 1024)},
    "2K": {"横屏": (2048, 1152), "竖屏": (1152, 2048), "正方形": (2048, 2048)},
    "4K": {"横屏": (3840, 2160), "竖屏": (2160, 3840), "正方形": (3840, 3840)},
}


def _image_input_index(name: str) -> int:
    match = re.match(r"^image_(\d+)$", str(name or ""))
    return int(match.group(1)) if match else 10**9


def _normalize_image_tensor(value: Any) -> torch.Tensor | None:
    if value is None or not isinstance(value, torch.Tensor):
        return None
    tensor = value.detach()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError("图片批量打包收到的图像张量维度不正确，应为 IMAGE 或 IMAGE batch。")
    return tensor.float().contiguous()


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _extract_media_tensor(value: Any) -> torch.Tensor | None:
    if isinstance(value, torch.Tensor):
        return _normalize_image_tensor(value)
    if isinstance(value, dict):
        for key in ("images", "image", "frames", "samples"):
            tensor = _extract_media_tensor(value.get(key))
            if tensor is not None:
                return tensor
    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception as exc:
            raise RuntimeError(f"图片批量打包读取 VIDEO 帧失败：{exc}") from exc
        tensor = _extract_media_tensor(_component_value(components, "images"))
        if tensor is None:
            tensor = _extract_media_tensor(_component_value(components, "frames"))
        if tensor is None:
            raise RuntimeError("图片批量打包收到的 VIDEO 没有解析出可用图片帧。")
        return tensor
    if hasattr(value, "images"):
        return _extract_media_tensor(getattr(value, "images"))
    if hasattr(value, "frames"):
        return _extract_media_tensor(getattr(value, "frames"))
    return None


def _first_value(value: Any, default: Any = None) -> Any:
    if isinstance(value, (list, tuple)):
        return _first_value(value[0], default) if value else default
    return default if value is None else value


def _first_scalar(value: Any, default: int) -> int:
    value = _first_value(value, default)
    try:
        return int(value)
    except Exception:
        return default


def _normalize_align_multiple(value: Any) -> int:
    text = str(_first_value(value, DEFAULT_ALIGN_MULTIPLE) or DEFAULT_ALIGN_MULTIPLE).strip()
    if text not in ALIGN_MULTIPLE_OPTIONS:
        text = DEFAULT_ALIGN_MULTIPLE
    return int(text)


def _align_to_multiple(value: Any, multiple: Any = DEFAULT_ALIGN_MULTIPLE) -> int:
    step = max(1, _normalize_align_multiple(multiple))
    try:
        number = float(_first_value(value, step))
    except Exception:
        number = step
    return max(step, int(round(max(1.0, number) / float(step))) * step)


def _normalize_size_preset(value: Any) -> str:
    text = str(_first_value(value, DEFAULT_SIZE_PRESET) or "").strip()
    normalized = text.lower().replace(" ", "")
    aliases = {
        "3": "320",
        "3️⃣": "320",
        "320": "320",
        "4": "480",
        "4️⃣": "480",
        "480": "480",
        "7": "720",
        "7️⃣": "720",
        "720": "720",
        "1": "1024",
        "1️⃣": "1024",
        "1024": "1024",
        "2": "2K",
        "2️⃣": "2K",
        "2k": "2K",
        "#": "4K",
        "#️⃣": "4K",
        "4k": "4K",
        "原始尺寸": ORIGINAL_SIZE_OPTION,
        "原图尺寸": ORIGINAL_SIZE_OPTION,
        "原尺寸": ORIGINAL_SIZE_OPTION,
        "originalsize": ORIGINAL_SIZE_OPTION,
        "sourcesize": ORIGINAL_SIZE_OPTION,
        "source": ORIGINAL_SIZE_OPTION,
        "🖼️": ORIGINAL_SIZE_OPTION,
        "🖼": ORIGINAL_SIZE_OPTION,
    }
    if normalized in aliases:
        return aliases[normalized]
    if text == ORIGINAL_SIZE_OPTION:
        return ORIGINAL_SIZE_OPTION
    return text if text in SIZE_PRESET_DIMENSIONS else DEFAULT_SIZE_PRESET


def _normalize_orientation(value: Any) -> str:
    text = str(_first_value(value, DEFAULT_ORIENTATION) or "").strip()
    normalized = text.lower().replace(" ", "")
    if normalized in {"原始", "原始比例", "原图比例", "原比例", "original", "originalratio", "source", "sourceratio", "🟧"}:
        return "原始比例"
    if normalized in {"横", "横屏", "landscape", "horizontal", "wide", "⏩"}:
        return "横屏"
    if normalized in {"竖", "竖屏", "portrait", "vertical", "tall", "⏫"}:
        return "竖屏"
    if normalized in {"方", "正方形", "square", "1:1", "🟦"}:
        return "正方形"
    return DEFAULT_ORIENTATION


def _normalize_prepend_frame(value: Any) -> str:
    text = str(_first_value(value, DEFAULT_PREPEND_FRAME) or "").strip()
    normalized = text.lower().replace(" ", "")
    if normalized in {"黑", "黑帧", "前置黑帧", "black", "blackframe", "◼", "◼️"}:
        return "黑帧"
    if normalized in {"白", "白帧", "前置白帧", "white", "whiteframe", "⬜", "⬜️"}:
        return "白帧"
    return "无"


def _legacy_width_height(width_value: Any, height_value: Any, align_multiple: Any = DEFAULT_ALIGN_MULTIPLE) -> tuple[int, int] | None:
    try:
        width = int(_first_value(width_value))
        height = int(_first_value(height_value))
    except Exception:
        return None
    if width <= 0 or height <= 0:
        return None
    return _align_to_multiple(width, align_multiple), _align_to_multiple(height, align_multiple)


def _parse_ratio_pair(value: Any) -> tuple[float, float] | None:
    text = str(_first_value(value, DEFAULT_CUSTOM_RATIO) or "").strip().lower()
    if not text:
        text = DEFAULT_CUSTOM_RATIO
    aliases = {
        "横": "16:9",
        "横屏": "16:9",
        "landscape": "16:9",
        "horizontal": "16:9",
        "wide": "16:9",
        "⏩": "16:9",
        "竖": "9:16",
        "竖屏": "9:16",
        "portrait": "9:16",
        "vertical": "9:16",
        "tall": "9:16",
        "⏫": "9:16",
        "方": "1:1",
        "正方形": "1:1",
        "square": "1:1",
        "🟦": "1:1",
    }
    text = aliases.get(text, text)
    match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*[:/x×,，]\s*(\d+(?:\.\d+)?)\s*$", text)
    if match:
        left = float(match.group(1))
        right = float(match.group(2))
        if left > 0 and right > 0:
            return left, right
        return None
    try:
        ratio = float(text)
    except Exception:
        return None
    return (ratio, 1.0) if ratio > 0 else None


def _custom_size_ratio(custom_size: Any, custom_ratio: Any, align_multiple: Any = DEFAULT_ALIGN_MULTIPLE) -> tuple[int, int] | None:
    try:
        size = int(round(float(_first_value(custom_size, DEFAULT_CUSTOM_SIZE) or 0)))
    except Exception:
        size = 0
    if size <= 0:
        return None
    ratio = _parse_ratio_pair(custom_ratio)
    if ratio is None:
        raise RuntimeError("图片批量打包的自定义比例格式不正确，请填写类似 16:9、9:16、1:1 或 1.777。")
    ratio_width, ratio_height = ratio
    if ratio_width >= ratio_height:
        height = size
        width = size * ratio_width / ratio_height
    else:
        width = size
        height = size * ratio_height / ratio_width
    return _align_to_multiple(width, align_multiple), _align_to_multiple(height, align_multiple)


def _dimensions_from_original_ratio(size_preset: Any, images: list[torch.Tensor], align_multiple: Any = DEFAULT_ALIGN_MULTIPLE) -> tuple[int, int] | None:
    if not images:
        return None
    source_height = int(images[0].shape[1])
    source_width = int(images[0].shape[2])
    if source_width <= 0 or source_height <= 0:
        return None

    preset = _normalize_size_preset(size_preset)
    edge_mode, edge = ORIGINAL_RATIO_EDGE_MODES[preset]
    ratio = float(source_width) / float(source_height)
    if edge_mode == "long":
        if source_width >= source_height:
            width = edge
            height = edge / ratio
        else:
            height = edge
            width = edge * ratio
    elif source_width >= source_height:
        height = edge
        width = edge * ratio
    else:
        width = edge
        height = edge / ratio
    return _align_to_multiple(width, align_multiple), _align_to_multiple(height, align_multiple)


def _dimensions_from_original_size(images: list[torch.Tensor], align_multiple: Any) -> tuple[int, int] | None:
    if not images:
        return None
    source_height = int(images[0].shape[1])
    source_width = int(images[0].shape[2])
    if source_width <= 0 or source_height <= 0:
        return None
    return _align_to_multiple(source_width, align_multiple), _align_to_multiple(source_height, align_multiple)


def _resolve_canvas_size(size_preset: Any, orientation: Any, kwargs: dict[str, Any], images: list[torch.Tensor] | None = None) -> tuple[int, int]:
    align_multiple = kwargs.get("align_multiple", DEFAULT_ALIGN_MULTIPLE)
    preset = _normalize_size_preset(size_preset)
    if preset == ORIGINAL_SIZE_OPTION:
        original_size = _dimensions_from_original_size(images or [], align_multiple)
        if original_size is not None:
            return original_size
        return SIZE_PRESET_DIMENSIONS[FALLBACK_SIZE_PRESET]["正方形"]

    legacy_size = _legacy_width_height(kwargs.get("width"), kwargs.get("height"), align_multiple)
    if legacy_size is not None:
        return legacy_size

    custom_size = _custom_size_ratio(kwargs.get("custom_size"), kwargs.get("custom_ratio"), align_multiple)
    if custom_size is not None:
        return custom_size

    legacy_size = _legacy_width_height(size_preset, orientation, align_multiple)
    if legacy_size is not None:
        return legacy_size

    direction = _normalize_orientation(orientation)
    if direction == "原始比例":
        original_size = _dimensions_from_original_ratio(preset, images or [], align_multiple)
        if original_size is not None:
            return original_size
        return SIZE_PRESET_DIMENSIONS[preset]["正方形"]

    width, height = SIZE_PRESET_DIMENSIONS[preset][direction]
    return _align_to_multiple(width, align_multiple), _align_to_multiple(height, align_multiple)


def _iter_image_frames(value: Any) -> list[torch.Tensor]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        frames: list[torch.Tensor] = []
        for item in value:
            frames.extend(_iter_image_frames(item))
        return frames

    tensor = _extract_media_tensor(value)
    if tensor is None:
        return []
    return [tensor[index:index + 1].contiguous() for index in range(int(tensor.shape[0]))]


def _resize_image_batch(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    if image.shape[1] == height and image.shape[2] == width:
        return image

    source_height = int(image.shape[1])
    source_width = int(image.shape[2])
    if source_height <= 0 or source_width <= 0:
        raise RuntimeError("图片批量打包收到的图像尺寸无效，无法等比缩放。")

    scale = max(float(width) / float(source_width), float(height) / float(source_height))
    resized_width = max(1, int(round(source_width * scale)))
    resized_height = max(1, int(round(source_height * scale)))
    resized = F.interpolate(
        image.movedim(-1, 1),
        size=(resized_height, resized_width),
        mode="bilinear",
        align_corners=False,
    ).movedim(1, -1)

    top = max(0, (resized_height - height) // 2)
    left = max(0, (resized_width - width) // 2)
    return resized[:, top:top + height, left:left + width, :].contiguous()


def _match_channels(image: torch.Tensor, channels: int) -> torch.Tensor:
    current = int(image.shape[-1])
    if current == channels:
        return image
    if current > channels:
        return image[..., :channels].contiguous()
    pad = torch.ones(
        (*image.shape[:-1], channels - current),
        dtype=image.dtype,
        device=image.device,
    )
    return torch.cat((image, pad), dim=-1).contiguous()


def _collect_images(kwargs: dict[str, Any]) -> list[torch.Tensor]:
    images: list[torch.Tensor] = []
    for i in range(1, MAX_INPUTS + 1):
        name = f"image_{i:02d}"
        images.extend(_iter_image_frames(kwargs.get(name)))
    return images


def _make_prepend_frame(mode: str, width: int, height: int, channels: int, dtype: torch.dtype, device: torch.device) -> torch.Tensor | None:
    if mode == "黑帧":
        return torch.zeros((1, height, width, channels), dtype=dtype, device=device)
    if mode == "白帧":
        return torch.ones((1, height, width, channels), dtype=dtype, device=device)
    return None


class GJJ_ImageBatchMulti:
    CATEGORY = "GJJ/图像"
    FUNCTION = "combine"
    INPUT_IS_LIST = True
    RETURN_TYPES = (COMPAT_BATCH_IMAGE_TYPE, "INT", "INT", "INT")
    RETURN_NAMES = ("批量图像", "宽度", "高度", "数量")
    OUTPUT_TOOLTIPS = (
        "输出兼容 GJJ 批量图片和普通 IMAGE batch。可选择前置黑帧或白帧；未选择时只输出已连接图片。",
        "最终输出图像的宽度；按尺寸档位、画幅方向或自定义尺寸解析后得到。",
        "最终输出图像的高度；按尺寸档位、画幅方向或自定义尺寸解析后得到。",
        "最终输出批量图像的帧数 / 张数，包含可选前置黑帧或白帧。",
    )
    DESCRIPTION = "零依赖图片/视频帧批量打包：用预设尺寸和画幅方向统一缩放图片或 VIDEO 帧，也可通过前端 ⚙️ 自定义尺寸 / 比例；可选前置黑帧或白帧。"
    GJJ_HELP = {
        "title": "GJJ · 🧺 图片批量打包到序列",
        "version": "1.2.1",
        "author": "GJJ Custom Nodes Team",
        "description": "把多路 IMAGE、GJJ 批量图片或 VIDEO 帧按顺序收集、统一缩放裁切到目标尺寸，并打包成连续图片序列输出。",
        "features": [
            {"name": "动态图片输入", "description": "默认只显示一个图片输入口，连接最后一个图片口后自动添加下一路输入。"},
            {"name": "尺寸图标按钮", "description": "默认使用第一张输入图的源尺寸，并按对齐倍数取整；也可切换 320、480、720、1024、2K、4K 预设和横屏、竖屏、正方形。"},
            {"name": "原生宽高设置", "description": "点击 ⚙️ 可设置原生宽度、高度和对齐倍数；宽高可外部拉线，最终尺寸会按对齐倍数取整。"},
            {"name": "前置帧", "description": "可一键添加黑帧或白帧到序列开头，再次点击当前前置帧按钮可取消。"},
            {"name": "扩展输出口", "description": "默认只显示批量图像输出；点击 🔌 可显示宽度、高度、数量三个 INT 输出口。"},
        ],
        "inputs": {
            "图片 1...N": {"type": INPUT_MEDIA_TYPE, "description": "动态图片输入；支持普通 IMAGE、GJJ 批量图片和官方 VIDEO，按输入口顺序展开为序列。"},
            "尺寸档位": {"type": "COMBO", "description": "由前端图标按钮控制的基础尺寸档位；原始尺寸会使用第一张输入图宽高，并按对齐倍数取整。"},
            "画幅方向": {"type": "COMBO", "description": "默认 🟧 原始比例；也可切换横屏、竖屏、正方形，与尺寸档位组合得到输出宽高。"},
            "前置帧": {"type": "COMBO", "description": "黑帧、白帧或无；前置帧会计入输出数量。"},
            "自定义宽度 / 高度 / 对齐倍数": {"type": "INT/COMBO", "description": "点击 ⚙️ 后显示原生宽度、高度和对齐倍数；宽高可外部拉线。"},
        },
        "outputs": {
            "批量图像": {"type": COMPAT_BATCH_IMAGE_TYPE, "description": "统一尺寸后的连续图片序列，兼容 GJJ_BATCH_IMAGE 和普通 IMAGE batch。"},
            "宽度": {"type": "INT", "description": "输出序列每张图片的最终宽度；前端默认隐藏，可通过 🔌 展开。"},
            "高度": {"type": "INT", "description": "输出序列每张图片的最终高度；前端默认隐藏，可通过 🔌 展开。"},
            "数量": {"type": "INT", "description": "输出序列总张数，包含可选前置帧；前端默认隐藏，可通过 🔌 展开。"},
        },
        "usage": [
            "把多张图片或多个批量图片连接到动态图片输入口，节点会按输入顺序输出连续序列。",
            "默认使用 🖼️ 原始尺寸：参考第一张输入图的源宽高，并按对齐倍数取整；没有输入图时退回 320 正方形。",
            "🟧 原始比例会按第一张输入图的宽高比计算目标尺寸；没有输入图时退回同档位正方形。",
            "🖼️ 原始尺寸会使用第一张输入图的真实宽高，并按对齐倍数取整；没有输入图时退回 320 正方形。",
            "需要统一视频帧尺寸时，先选择尺寸档位和方向；需要精确控制时点击 ⚙️ 设置原生宽度、高度和对齐倍数。",
            "需要把宽度、高度、数量接给下游循环、尺寸或保存节点时，点击 🔌 展开三个 INT 输出口。",
            "本节点不需要额外模型或第三方自定义节点依赖，只使用 ComfyUI 已有 torch 张量能力。",
        ],
    }
    SEARCH_ALIASES = [
        "image batch multi",
        "ImageBatchMulti",
        "图片批量",
        "批量图片",
        "原始比例",
        "空图像",
        "反转图像",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "size_preset": (
                list(SIZE_PRESET_OPTIONS),
                {
                    "default": DEFAULT_SIZE_PRESET,
                    "display_name": "尺寸档位",
                    "tooltip": "由前端图标按钮控制：原始尺寸、320、480、720、1024、2K、4K；原始尺寸使用第一张输入图宽高，所有模式最终宽高都会按对齐倍数取整。",
                },
            ),
            "orientation": (
                list(ORIENTATION_OPTIONS),
                {
                    "default": DEFAULT_ORIENTATION,
                    "display_name": "画幅方向",
                    "tooltip": "由前端图标按钮控制：原始比例、横屏、竖屏、正方形；与尺寸档位互相组合得到最终尺寸。默认原始比例会参考第一张输入图。",
                },
            ),
            "prepend_frame": (
                list(PREPEND_FRAME_OPTIONS),
                {
                    "default": DEFAULT_PREPEND_FRAME,
                    "display_name": "前置帧",
                    "tooltip": "由前端图标按钮控制。黑帧和白帧互斥；再次点击当前按钮可取消，不添加前置帧。",
                },
            ),
            "width": (
                "INT",
                {
                    "default": 0,
                    "min": 0,
                    "max": 8192,
                    "step": 16,
                    "display_name": "自定义宽度",
                    "tooltip": "点击 ⚙️ 后显示的原生宽度。0 表示使用尺寸档位和画幅方向；可外部拉线输入。",
                    "hidden": True,
                    "display": "hidden",
                },
            ),
            "height": (
                "INT",
                {
                    "default": 0,
                    "min": 0,
                    "max": 8192,
                    "step": 16,
                    "display_name": "自定义高度",
                    "tooltip": "点击 ⚙️ 后显示的原生高度。0 表示使用尺寸档位和画幅方向；可外部拉线输入。",
                    "hidden": True,
                    "display": "hidden",
                },
            ),
            "custom_size": (
                "INT",
                {
                    "default": DEFAULT_CUSTOM_SIZE,
                    "min": 0,
                    "max": 8192,
                    "step": 16,
                    "display_name": "自定义尺寸",
                    "tooltip": "由前端 ⚙️ 自定义面板保存的短边 / 方图边长；0 表示关闭自定义尺寸。",
                    "hidden": True,
                    "display": "hidden",
                },
            ),
            "custom_ratio": (
                "STRING",
                {
                    "default": DEFAULT_CUSTOM_RATIO,
                    "display_name": "自定义比例",
                    "tooltip": "由前端 ⚙️ 自定义面板保存，格式例如 16:9、9:16、1:1。",
                    "hidden": True,
                    "display": "hidden",
                },
            ),
            "align_multiple": (
                list(ALIGN_MULTIPLE_OPTIONS),
                {
                    "default": DEFAULT_ALIGN_MULTIPLE,
                    "display_name": "对齐倍数",
                    "tooltip": "最终输出宽度和高度按这个倍数对齐。默认 16，可选 2、4、8、16、32、64。",
                    "hidden": True,
                    "display": "hidden",
                },
            ),
        }
        
        optional = {}

        # 图片接口是动态可选输入。前端默认只显示一个尾部空槽，连接后再追加下一路。
        for i in range(1, MAX_INPUTS + 1):
            optional[f"image_{i:02d}"] = (
                INPUT_MEDIA_TYPE,
                {
                    "display_name": f"图片 {i}",
                    "tooltip": f"第 {i} 路图片输入；支持普通 IMAGE、GJJ 批量图片或官方 VIDEO。",
                    "forceInput": True,
                },
            )

        return {"required": required, "optional": optional}

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def combine(
        self,
        size_preset: str = DEFAULT_SIZE_PRESET,
        orientation: str = DEFAULT_ORIENTATION,
        prepend_frame: str = DEFAULT_PREPEND_FRAME,
        **kwargs,
    ):
        images = _collect_images(kwargs)
        width, height = _resolve_canvas_size(size_preset, orientation, kwargs, images)
        prepend_mode = _normalize_prepend_frame(prepend_frame)

        device = images[0].device if images else torch.device("cpu")
        dtype = images[0].dtype if images else torch.float32
        max_channels = max([3] + [int(image.shape[-1]) for image in images])

        batches: list[torch.Tensor] = []
        prepend = _make_prepend_frame(prepend_mode, width, height, max_channels, dtype, device)
        if prepend is not None:
            batches.append(prepend)

        for image in images:
            normalized = _resize_image_batch(image.to(device=device, dtype=dtype), width, height)
            normalized = _match_channels(normalized, max_channels)
            batches.append(normalized.clamp(0.0, 1.0))

        if not batches:
            raise RuntimeError("图片批量打包没有可输出内容：请连接至少一张图片，或选择前置黑帧/白帧。")

        output = torch.cat(batches, dim=0).contiguous().cpu()
        return (output, int(width), int(height), int(output.shape[0]))


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageBatchMulti}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧺 图片批量打包到序列"}
