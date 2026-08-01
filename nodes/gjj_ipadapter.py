from __future__ import annotations

from ..vendor.gjj_ipadapter_plus.IPAdapterPlus import (
    IPAdapterSimple,
    IPAdapterUnifiedLoader,
)


class GJJ_IPAdapter:
    """在一个中文节点中加载并应用 IPAdapter。"""

    PRESETS = {
        "轻量（仅SD1.5，低强度）": "LIGHT - SD1.5 only (low strength)",
        "标准（中等强度）": "STANDARD (medium strength)",
        "ViT-G（中等强度）": "VIT-G (medium strength)",
        "增强（高强度）": "PLUS (high strength)",
        "增强人像": "PLUS FACE (portraits)",
        "完整人脸（仅SD1.5）": "FULL FACE - SD1.5 only (portraits stronger)",
    }
    WEIGHT_TYPES = {
        "标准": "standard",
        "提示词优先": "prompt is more important",
        "风格迁移": "style transfer",
    }

    def __init__(self):
        self._loader = IPAdapterUnifiedLoader()
        self._adapter = IPAdapterSimple()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"display_name": "模型", "tooltip": "需要应用 IPAdapter 的扩散模型。"}),
                "image": ("IMAGE", {"display_name": "参考图像", "tooltip": "IPAdapter 参考图像。"}),
                "预设": (list(cls.PRESETS), {"default": "标准（中等强度）", "display": "hidden", "hidden": True, "tooltip": "自动匹配并加载对应的 IPAdapter 与 CLIP Vision 模型。"}),
                "权重": ("FLOAT", {"default": 1.0, "min": -1.0, "max": 3.0, "step": 0.05, "display": "hidden", "hidden": True, "tooltip": "参考图对生成结果的影响强度。"}),
                "开始位置": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.001, "display": "hidden", "hidden": True, "tooltip": "IPAdapter 开始生效的采样进度。"}),
                "结束位置": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.001, "display": "hidden", "hidden": True, "tooltip": "IPAdapter 停止生效的采样进度。"}),
                "权重模式": (list(cls.WEIGHT_TYPES), {"default": "标准", "display": "hidden", "hidden": True, "tooltip": "控制图像条件在注意力层中的权重分布。"}),
            },
            "optional": {
                "mask": ("MASK", {"display_name": "作用遮罩（可选）", "tooltip": "可选注意力遮罩；未连接时 IPAdapter 对整张参考图生效。"}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("处理后模型",)
    OUTPUT_TOOLTIPS = ("已应用 IPAdapter 注意力补丁的模型。",)
    FUNCTION = "apply"
    CATEGORY = "GJJ/图像条件"
    DESCRIPTION = (
        "零依赖 IPAdapter 一体化节点；默认只显示模型、图像和遮罩接口，"
        "点击“⚙️设置”可调整全部参数。"
    )
    GJJ_HELP = {
        "标题": "IPAdapter 图像条件",
        "说明": "自动加载 IPAdapter 与 CLIP Vision，并把参考图条件应用到模型。",
        "使用方法": [
            "连接模型和参考图；遮罩可选，未连接时对整张参考图生效。",
            "点击“⚙️设置”选择预设并调整权重和生效区间。",
            "把“处理后模型”连接到采样器。",
        ],
        "提示": "标准预设同时适用于 SD1.5 和 SDXL；轻量与完整人脸预设仅适用于 SD1.5。",
    }

    def apply(self, model, image, 预设="标准（中等强度）", 权重=1.0,
              开始位置=0.0, 结束位置=1.0, 权重模式="标准", mask=None):
        loaded_model, pipeline = self._loader.load_models(
            model=model,
            preset=self.PRESETS[预设],
        )
        return self._adapter.apply_ipadapter(
            model=loaded_model,
            ipadapter=pipeline,
            image=image,
            weight=float(权重),
            start_at=float(开始位置),
            end_at=float(结束位置),
            weight_type=self.WEIGHT_TYPES[权重模式],
            attn_mask=mask,
        )


NODE_CLASS_MAPPINGS = {"GJJ_IPAdapter": GJJ_IPAdapter}
NODE_DISPLAY_NAME_MAPPINGS = {"GJJ_IPAdapter": "GJJ 图像适配器"}
