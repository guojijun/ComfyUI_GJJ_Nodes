from __future__ import annotations

import torch


def _tensor_to_mask(t: torch.Tensor) -> torch.Tensor:
    """将 IMAGE 张量转换为 MASK 张量。

    - 如果是 RGBA，优先使用 Alpha 通道（如果有透明信息）
    - 否则转换为灰度作为遮罩
    """
    size = t.size()

    # 如果已经是 2D 或 3D，直接返回
    if len(size) < 4:
        return t

    # 处理 4D 张量 [B, H, W, C]
    if size[3] == 1:
        # 单通道，直接提取
        return t[:, :, :, 0]
    elif size[3] == 4:
        # RGBA：检查是否有真正的透明通道
        alpha_channel = t[:, :, :, 3]
        if torch.min(alpha_channel).item() != 1.0:
            # 有透明信息，使用 Alpha 通道
            return alpha_channel

    # RGB 或其他情况：转换为灰度
    # 使用标准亮度公式：0.299*R + 0.587*G + 0.114*B
    rgb = t[:, :, :, :3]
    grayscale = 0.299 * rgb[:, :, :, 0] + 0.587 * rgb[:, :, :, 1] + 0.114 * rgb[:, :, :, 2]
    return grayscale


class GJJ_ImageToMask:
    CATEGORY = "GJJ/图像"
    FUNCTION = "convert"
    DESCRIPTION = "🎭 将图像转换为遮罩。支持亮度、Alpha通道及RGB单通道转换。"
    SEARCH_ALIASES = ["image to mask", "img2mask", "图片转遮罩", "alpha mask", "通道提取"]
    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("🎭 遮罩", "🖼️ 遮罩图")
    OUTPUT_TOOLTIPS = (
        "标准 MASK 格式 [B, H, W]，可直接接入重绘节点。",
        "可视化的 IMAGE 格式 [B, H, W, 1]，方便预览遮罩效果。",
    )
    OUTPUT_NODE = True  # 允许作为输出节点独立执行

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "🖼️ 输入图像", "tooltip": "需要转换为遮罩的图像张量 [B, H, W, C]。"}),
                "method": (
                    ["💡 亮度", "🔳 Alpha通道", "🔴 红色通道", "🟢 绿色通道", "🔵 蓝色通道"],
                    {
                        "default": "💡 亮度",
                        "display_name": "🔄 转换方法",
                        "tooltip": "选择遮罩生成方式：\n" +
                                   "• 💡 亮度：根据灰度值生成遮罩，适合黑白图、线稿\n" +
                                   "• 🔳 Alpha通道：使用透明通道，适合PNG透明图\n" +
                                   "• 🔴 红色通道：提取R通道作为遮罩\n" +
                                   "• 🟢 绿色通道：提取G通道作为遮罩\n" +
                                   "• 🔵 蓝色通道：提取B通道作为遮罩"
                    }
                ),
                "output_mode": (
                    ["🎭 仅遮罩", "🖼️ 仅遮罩图", "✨ 两者都输出"],
                    {
                        "default": "✨ 两者都输出",
                        "display_name": "📤 输出方式",
                        "tooltip": "选择输出格式：\n" +
                                   "• 🎭 仅遮罩：只输出 MASK 格式（节省内存）\n" +
                                   "• 🖼️ 仅遮罩图：只输出 IMAGE 格式（方便预览）\n" +
                                   "• ✨ 两者都输出：同时输出两种格式（最灵活）\n\n" +
                                   "💡 提示：Ctrl/Shift 点击可快速切换"
                    }
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            }
        }

    def convert(self, image: torch.Tensor, method: str, output_mode: str, unique_id=None, extra_pnginfo=None):
        """将图像转换为遮罩。

        Args:
            image: 输入图像张量 [B, H, W, C]
            method: 转换方法
                - "💡 亮度": 将图像转为灰度，适合黑白图、线稿等
                - "🔳 Alpha通道": 使用 Alpha 通道，适合 PNG 透明图
                - "🔴 红色通道": 提取红色通道
                - "🟢 绿色通道": 提取绿色通道
                - "🔵 蓝色通道": 提取蓝色通道
            output_mode: 输出模式
                - "🎭 仅遮罩": 只返回 MASK
                - "🖼️ 仅遮罩图": 只返回 IMAGE
                - "✨ 两者都输出": 返回 (MASK, IMAGE)

        Returns:
            根据 output_mode 返回不同格式：
            - 仅遮罩: (MASK,)
            - 仅遮罩图: (IMAGE,)
            - 两者都输出: (MASK, IMAGE)
        """
        # 移除 emoji 前缀，获取实际方法名
        actual_method = method.split(" ", 1)[-1] if " " in method else method

        # 生成遮罩
        if actual_method == "Alpha通道":
            # 确保有 Alpha 通道
            if image.shape[-1] < 4:
                # 如果没有 Alpha 通道，返回全白遮罩
                b, h, w = image.shape[:3]
                mask = torch.ones((b, h, w), dtype=image.dtype, device=image.device)
            else:
                # 使用 Alpha 通道
                mask = image[:, :, :, 3]
        elif actual_method == "红色通道":
            # 提取红色通道
            mask = image[:, :, :, 0]
        elif actual_method == "绿色通道":
            # 提取绿色通道
            mask = image[:, :, :, 1]
        elif actual_method == "蓝色通道":
            # 提取蓝色通道
            mask = image[:, :, :, 2]
        else:
            # 亮度模式：转换为灰度
            mask = _tensor_to_mask(image)

        # 根据输出模式返回不同格式
        output_mode_clean = output_mode.split(" ", 1)[-1] if " " in output_mode else output_mode

        if output_mode_clean == "仅遮罩":
            # 只返回 MASK
            return (mask,)
        elif output_mode_clean == "仅遮罩图":
            # 将 MASK 转换为 IMAGE 格式 [B, H, W, 1]
            mask_image = mask.unsqueeze(-1)
            return (mask_image,)
        else:
            # 两者都输出：(MASK, IMAGE)
            mask_image = mask.unsqueeze(-1)
            return (mask, mask_image)


NODE_CLASS_MAPPINGS = {
    "GJJ_ImageToMask": GJJ_ImageToMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_ImageToMask": "GJJ · 🎭 图片转遮罩",
}
