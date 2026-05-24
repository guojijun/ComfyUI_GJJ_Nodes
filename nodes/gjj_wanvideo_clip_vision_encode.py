from __future__ import annotations


NODE_NAME = "GJJ_WanVideoClipVisionEncode"
NODE_DISPLAY_NAME = "🔍 Wan图像CLIP编码"

CROP_VALUES = ["center", "disabled"]
COMBINE_VALUES = ["average", "sum", "concat", "batch"]


def _load_wanvideo_runtime():
    try:
        from ..vendor.wanvideo_wrapper import nodes as wan_nodes
    except Exception as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo CLIP 图像编码 runtime 加载失败。无需安装 WanVideoWrapper 插件本体；"
            f"如果是 pip 运行库缺失，请按 GJJ 的 WanVideo 运行时依赖方案安装。\n错误信息：{error}"
        ) from error
    return wan_nodes


class GJJ_WanVideoClipVisionEncode:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    DESCRIPTION = (
        "WanVideo CLIP Vision 图像条件编码的 GJJ 零依赖节点。"
        "内部调用 GJJ vendor 中的 WanVideoClipVisionEncode，不依赖外部 ComfyUI-WanVideoWrapper 插件。"
    )
    SEARCH_ALIASES = [
        "WanVideoClipVisionEncode",
        "WanVideo ClipVision Encode",
        "wan clip vision",
        "Wan图像CLIP",
        "图像CLIP编码",
    ]

    RETURN_TYPES = ("WANVIDIMAGE_CLIPEMBEDS",)
    RETURN_NAMES = ("CLIP图像条件",)
    OUTPUT_TOOLTIPS = ("WanVideo 图生视频编码可读取的 CLIP 图像条件，包含正向和可选反向图像特征。",)

    GJJ_HELP = {
        "title": "Wan 图像 CLIP 编码",
        "description": "把参考图编码为 WanVideo I2V / Animate 流程可用的 CLIP 图像条件。",
        "usage": [
            "CLIP视觉模型可接 GJJ 通用模型加载器的 CLIP视觉输出，也可接 ComfyUI 官方 CLIP Vision Loader。",
            "图片 1 为必填参考图；图片 2 可选，用于双图参考或合并特征。",
            "输出连接到 GJJ Wan 图生视频编码或其它支持 WANVIDIMAGE_CLIPEMBEDS 的节点。",
        ],
        "notes": [
            "本节点只使用 GJJ vendor/wanvideo_wrapper 内置 runtime。",
            "tiles 大于 0 时走原版 tiled image encoding 逻辑，可改善大图细节但会更慢。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip_vision": (
                    "CLIP_VISION",
                    {
                        "display_name": "CLIP视觉模型",
                        "tooltip": "CLIP Vision 模型对象。可由 GJJ 通用模型加载器或 ComfyUI 官方 CLIP Vision Loader 加载。",
                    },
                ),
                "image_1": (
                    "IMAGE",
                    {
                        "display_name": "图片 1",
                        "tooltip": "主要参考图，会被编码为 WanVideo 图像 CLIP 条件。",
                    },
                ),
                "strength_1": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "display_name": "图片1强度",
                        "tooltip": "图片 1 的 CLIP 特征倍率。",
                    },
                ),
                "strength_2": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "display_name": "图片2强度",
                        "tooltip": "图片 2 的 CLIP 特征倍率。未连接图片 2 时不会生效。",
                    },
                ),
                "crop": (
                    CROP_VALUES,
                    {
                        "default": "center",
                        "display_name": "裁剪方式",
                        "tooltip": "center 会按原版逻辑中心裁剪到 CLIP 输入尺寸；disabled 保留缩放后的完整图。",
                    },
                ),
                "combine_embeds": (
                    COMBINE_VALUES,
                    {
                        "default": "average",
                        "display_name": "合并方式",
                        "tooltip": "多图特征合并方式：average 平均、sum 相加、concat 拼接、batch 批次。",
                    },
                ),
                "force_offload": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "编码后卸载CLIP",
                        "tooltip": "编码完成后把 CLIP Vision 模型移回卸载设备，降低显存占用。",
                    },
                ),
            },
            "optional": {
                "image_2": (
                    "IMAGE",
                    {
                        "display_name": "图片 2",
                        "tooltip": "可选第二张参考图。连接后会按合并方式和图片2强度参与编码。",
                    },
                ),
                "negative_image": (
                    "IMAGE",
                    {
                        "display_name": "反向图片",
                        "tooltip": "可选反向图像条件，用于 uncond / negative clip embeds。",
                    },
                ),
                "tiles": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 16,
                        "step": 2,
                        "display_name": "分块数量",
                        "tooltip": "大于 0 时启用原版 tiled 图像编码，细节更稳定但速度更慢。",
                    },
                ),
                "ratio": (
                    "FLOAT",
                    {
                        "default": 0.5,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "分块权重",
                        "tooltip": "tiled 编码中分块平均特征的混合比例。",
                    },
                ),
            },
        }

    def process(
        self,
        clip_vision,
        image_1,
        strength_1: float,
        strength_2: float,
        force_offload: bool,
        crop: str,
        combine_embeds: str,
        image_2=None,
        negative_image=None,
        tiles: int = 0,
        ratio: float = 0.5,
    ):
        wan_nodes = _load_wanvideo_runtime()
        encoder = wan_nodes.WanVideoClipVisionEncode()
        return encoder.process(
            clip_vision=clip_vision,
            image_1=image_1,
            strength_1=float(strength_1),
            strength_2=float(strength_2),
            force_offload=bool(force_offload),
            crop=str(crop or "center"),
            combine_embeds=str(combine_embeds or "average"),
            image_2=image_2,
            negative_image=negative_image,
            tiles=int(tiles),
            ratio=float(ratio),
        )


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoClipVisionEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
