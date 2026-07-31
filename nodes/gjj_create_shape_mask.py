from __future__ import annotations

import torch


NODE_NAME = "GJJ_CreateShapeMask"
NODE_DISPLAY_NAME = "GJJ · 🔷 形状遮罩生成"

SHAPE_OPTIONS = ["圆形", "方形", "三角形", "circle", "square", "triangle"]
SHAPE_ALIASES = {
    "圆形": "circle",
    "圆": "circle",
    "circle": "circle",
    "ellipse": "circle",
    "方形": "square",
    "矩形": "square",
    "正方形": "square",
    "square": "square",
    "rectangle": "square",
    "三角形": "triangle",
    "三角": "triangle",
    "triangle": "triangle",
}


def _shape_key(value: str) -> str:
    text = str(value or "圆形").strip().lower()
    return SHAPE_ALIASES.get(text, SHAPE_ALIASES.get(str(value or "").strip(), "circle"))


def _to_positive_int(value, default: int, minimum: int = 1, maximum: int = 16384) -> int:
    try:
        number = int(value)
    except Exception:
        number = default
    return max(minimum, min(maximum, number))


def _to_int(value, default: int, minimum: int = -16384, maximum: int = 16384) -> int:
    try:
        number = int(value)
    except Exception:
        number = default
    return max(minimum, min(maximum, number))


class GJJ_CreateShapeMask:
    CATEGORY = "GJJ/🖼️ 图像/遮罩"
    FUNCTION = "create_shape_mask"
    DESCRIPTION = "零额外依赖形状遮罩生成：复刻 KJNodes CreateShapeMask，可生成圆形、方形、三角形遮罩批次，并按帧递增或递减尺寸。"
    SEARCH_ALIASES = [
        "CreateShapeMask",
        "KJ CreateShapeMask",
        "shape mask",
        "circle mask",
        "square mask",
        "triangle mask",
        "形状遮罩",
        "圆形遮罩",
        "方形遮罩",
        "三角形遮罩",
    ]
    RETURN_TYPES = ("MASK", "MASK")
    RETURN_NAMES = ("遮罩", "反相遮罩")
    OUTPUT_TOOLTIPS = (
        "生成的形状遮罩批次，白色区域为 1，黑色区域为 0。",
        "1 - 遮罩 的反相结果。",
    )
    GJJ_HELP = {
        "title": "形状遮罩生成",
        "description": DESCRIPTION,
        "source": "复刻 ComfyUI-KJNodes / CreateShapeMask 的核心行为，不依赖 KJNodes。",
        "dependencies": [
            {"name": "torch", "required": True, "type": "ComfyUI 内置依赖", "description": "生成并输出 MASK tensor。"},
        ],
        "dependency_note": "不依赖 KJNodes、Pillow、OpenCV、numpy 或其它第三方节点包。",
        "usage": [
            "位置 X / 位置 Y 是形状中心点坐标。",
            "增长量会在每一帧累加到形状宽度和高度上；负数会逐帧缩小。",
            "输出批次数量等于帧数。",
        ],
        "compatibility": [
            "circle / square / triangle 三个英文形状名仍可用，方便照抄 KJNodes 参数。",
            "方形行为与 KJNodes square 一致，按宽高绘制矩形框。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "shape": (
                    SHAPE_OPTIONS,
                    {
                        "default": "圆形",
                        "display_name": "形状",
                        "tooltip": "选择要绘制的形状；英文 circle/square/triangle 也保留兼容。",
                    },
                ),
                "frames": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 4096,
                        "step": 1,
                        "display_name": "帧数",
                        "tooltip": "生成多少张遮罩。大于 1 时会输出 MASK 批次。",
                    },
                ),
                "location_x": (
                    "INT",
                    {
                        "default": 256,
                        "min": -4096,
                        "max": 4096,
                        "step": 1,
                        "display_name": "位置 X",
                        "tooltip": "形状中心点的 X 坐标，可超出画布以生成局部进入/离开画面的遮罩。",
                    },
                ),
                "location_y": (
                    "INT",
                    {
                        "default": 256,
                        "min": -4096,
                        "max": 4096,
                        "step": 1,
                        "display_name": "位置 Y",
                        "tooltip": "形状中心点的 Y 坐标，可超出画布以生成局部进入/离开画面的遮罩。",
                    },
                ),
                "grow": (
                    "INT",
                    {
                        "default": 0,
                        "min": -512,
                        "max": 512,
                        "step": 1,
                        "display_name": "逐帧增长量",
                        "tooltip": "每一帧额外增加到形状宽度和高度上的像素值；负数会逐帧缩小。",
                    },
                ),
                "frame_width": (
                    "INT",
                    {
                        "default": 512,
                        "min": 16,
                        "max": 4096,
                        "step": 1,
                        "display_name": "画布宽度",
                        "tooltip": "输出遮罩宽度。",
                    },
                ),
                "frame_height": (
                    "INT",
                    {
                        "default": 512,
                        "min": 16,
                        "max": 4096,
                        "step": 1,
                        "display_name": "画布高度",
                        "tooltip": "输出遮罩高度。",
                    },
                ),
                "shape_width": (
                    "INT",
                    {
                        "default": 128,
                        "min": 0,
                        "max": 4096,
                        "step": 1,
                        "display_name": "形状宽度",
                        "tooltip": "第一帧形状宽度；后续帧会叠加逐帧增长量。",
                    },
                ),
                "shape_height": (
                    "INT",
                    {
                        "default": 128,
                        "min": 0,
                        "max": 4096,
                        "step": 1,
                        "display_name": "形状高度",
                        "tooltip": "第一帧形状高度；后续帧会叠加逐帧增长量。",
                    },
                ),
            }
        }

    def create_shape_mask(
        self,
        shape: str,
        frames: int,
        location_x: int,
        location_y: int,
        grow: int,
        frame_width: int,
        frame_height: int,
        shape_width: int,
        shape_height: int,
    ):
        frame_count = _to_positive_int(frames, 1, 1, 4096)
        width = _to_positive_int(frame_width, 512, 16, 4096)
        height = _to_positive_int(frame_height, 512, 16, 4096)
        center_x = _to_int(location_x, 256, -4096, 4096)
        center_y = _to_int(location_y, 256, -4096, 4096)
        base_width = _to_positive_int(shape_width, 128, 0, 4096)
        base_height = _to_positive_int(shape_height, 128, 0, 4096)
        grow_step = _to_int(grow, 0, -512, 512)
        shape_name = _shape_key(shape)
        yy = torch.arange(height, dtype=torch.float32).view(height, 1)
        xx = torch.arange(width, dtype=torch.float32).view(1, width)

        masks = []
        for index in range(frame_count):
            current_width = max(0, base_width + index * grow_step)
            current_height = max(0, base_height + index * grow_step)
            mask = torch.zeros((height, width), dtype=torch.float32)
            if current_width <= 0 or current_height <= 0:
                masks.append(mask)
                continue

            half_width = current_width / 2.0
            half_height = current_height / 2.0

            if shape_name == "circle":
                inside = ((xx - center_x) / half_width).pow(2) + ((yy - center_y) / half_height).pow(2) <= 1.0
                mask = inside.float()
            elif shape_name == "square":
                inside = (
                    (xx >= center_x - current_width // 2)
                    & (xx <= center_x + current_width // 2)
                    & (yy >= center_y - current_height // 2)
                    & (yy <= center_y + current_height // 2)
                )
                mask = inside.float()
            else:
                x1, y1 = float(center_x), float(center_y - current_height // 2)
                x2, y2 = float(center_x - current_width // 2), float(center_y + current_height // 2)
                x3, y3 = float(center_x + current_width // 2), float(center_y + current_height // 2)
                edge1 = (xx - x2) * (y1 - y2) - (x1 - x2) * (yy - y2)
                edge2 = (xx - x3) * (y2 - y3) - (x2 - x3) * (yy - y3)
                edge3 = (xx - x1) * (y3 - y1) - (x3 - x1) * (yy - y1)
                inside = ((edge1 >= 0) & (edge2 >= 0) & (edge3 >= 0)) | (
                    (edge1 <= 0) & (edge2 <= 0) & (edge3 <= 0)
                )
                mask = inside.float()

            masks.append(mask)

        mask = torch.stack(masks, dim=0).clamp(0.0, 1.0)
        return (mask, 1.0 - mask)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_CreateShapeMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
