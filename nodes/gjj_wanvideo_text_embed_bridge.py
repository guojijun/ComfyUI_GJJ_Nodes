from __future__ import annotations

from typing import Any


NODE_NAME = "GJJ_WanVideoTextEmbedBridge"
NODE_DISPLAY_NAME = "🔗 WanVideo文本条件桥接"


def _torch_device():
    try:
        import comfy.model_management as mm

        return mm.get_torch_device()
    except Exception:
        return None


def _conditioning_tensor(conditioning: Any, label: str):
    if not isinstance(conditioning, (list, tuple)) or not conditioning:
        raise RuntimeError(f"{label}不是有效的 CONDITIONING：请连接 CLIP 编码节点输出。")

    first = conditioning[0]
    if not isinstance(first, (list, tuple)) or not first:
        raise RuntimeError(f"{label}结构不完整：缺少 CONDITIONING tensor。")

    tensor = first[0]
    if not hasattr(tensor, "shape"):
        raise RuntimeError(f"{label}不是有效的 CONDITIONING tensor。")

    device = _torch_device()
    if device is not None and hasattr(tensor, "to"):
        try:
            return tensor.to(device)
        except Exception:
            pass
    return tensor


class GJJ_WanVideoTextEmbedBridge:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    DESCRIPTION = "把 ComfyUI 原生 CONDITIONING 转成 WanVideoWrapper 采样器需要的 WANVIDEOTEXTEMBEDS。"
    SEARCH_ALIASES = [
        "WanVideoTextEmbedBridge",
        "WanVideo TextEmbed Bridge",
        "WANVIDEOTEXTEMBEDS",
        "CONDITIONING to WanVideo",
        "文本条件桥接",
    ]

    RETURN_TYPES = ("WANVIDEOTEXTEMBEDS",)
    RETURN_NAMES = ("文本条件",)
    OUTPUT_TOOLTIPS = ("WanVideo 采样器可读取的文本条件字典，包含 prompt_embeds 和 negative_prompt_embeds。",)

    GJJ_HELP = {
        "title": "WanVideo文本条件桥接",
        "description": "零外部节点依赖复刻 WanVideoTextEmbedBridge：把原生 CONDITIONING 包装为 WANVIDEOTEXTEMBEDS。",
        "usage": [
            "正向条件连接 CLIP 文本编码节点的正向 CONDITIONING。",
            "负向条件可选；连接后会写入 negative_prompt_embeds。",
            "输出可连接 GJJ WanVideo 采样器的文本条件输入。",
        ],
        "notes": [
            "本节点不加载 T5，也不依赖 WanVideoWrapper 插件本体。",
            "如果你已经使用 GJJ · 📝 Wan T5文本编码，则不需要再接这个桥接节点。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正向条件",
                        "tooltip": "ComfyUI 原生正向 CONDITIONING，通常来自 CLIP 文本编码节点。",
                    },
                ),
            },
            "optional": {
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "负向条件",
                        "tooltip": "可选的 ComfyUI 原生负向 CONDITIONING；不连接时 negative_prompt_embeds 为 None。",
                    },
                ),
            },
        }

    def process(self, positive, negative=None):
        prompt_embeds = _conditioning_tensor(positive, "正向条件")
        negative_prompt_embeds = (
            _conditioning_tensor(negative, "负向条件")
            if negative is not None
            else None
        )
        return (
            {
                "prompt_embeds": prompt_embeds,
                "negative_prompt_embeds": negative_prompt_embeds,
            },
        )


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoTextEmbedBridge,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
