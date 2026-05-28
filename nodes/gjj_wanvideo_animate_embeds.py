from __future__ import annotations


NODE_NAME = "GJJ_WanVideoAnimateEmbeds"
NODE_DISPLAY_NAME = "🎭 WanAnimate条件编码"

COLORMATCH_VALUES = [
    "disabled",
    "mkl",
    "hm",
    "reinhard",
    "mvgd",
    "hm-mvgd-hm",
    "hm-mkl-hm",
]


def _load_wanvideo_runtime():
    try:
        from ..vendor.wanvideo_wrapper import nodes as wan_nodes
    except Exception as error:
        raise RuntimeError(
            "GJJ 内置 WanAnimate 条件编码 runtime 加载失败。无需安装外部 WanVideoWrapper 插件本体；"
            f"如果是 pip 运行库缺失，请按 GJJ 的 WanVideo 运行时依赖方案安装。\n错误信息：{error}"
        ) from error
    return wan_nodes


class GJJ_WanVideoAnimateEmbeds:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    DESCRIPTION = (
        "WanVideo Animate 条件编码的 GJJ 零依赖节点。"
        "内部调用 GJJ vendor 中的 WanVideoAnimateEmbeds，不依赖外部 ComfyUI-WanVideoWrapper 插件。"
    )
    SEARCH_ALIASES = [
        "WanVideoAnimateEmbeds",
        "WanVideo Animate Embeds",
        "WanAnimate",
        "Animate Embeds",
        "Wan动作条件",
        "动作条件编码",
    ]

    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS",)
    RETURN_NAMES = ("Animate条件",)
    OUTPUT_TOOLTIPS = ("WanVideo Animate 采样器可读取的图像/姿态/人脸/背景条件包。",)

    GJJ_HELP = {
        "title": "WanAnimate 条件编码",
        "description": "把参考图、姿态帧、人脸帧和背景帧编码为 WanVideo Animate 使用的条件输入。",
        "usage": [
            "Wan VAE 接 GJJ WanVideo VAE 加载器输出。",
            "姿态图、人脸图、背景图可按工作流需要分别连接；未连接的分支会按原版逻辑留空或补零。",
            "输出连接到 GJJ WanVideo Sampler 的图像条件输入。",
        ],
        "notes": [
            "本节点只使用 GJJ vendor/wanvideo_wrapper 内置 runtime。",
            "帧数会按 WanVideo 的 4n+1 规则自动对齐；循环窗口由“时间窗口”控制。",
            "开启分块 VAE 可降低显存占用，但会变慢。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": (
                    "WANVAE",
                    {
                        "display_name": "Wan VAE",
                        "tooltip": "GJJ WanVideo VAE 加载器输出的 WANVAE，用于编码 Animate 条件 latent。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 832,
                        "min": 64,
                        "max": 8096,
                        "step": 8,
                        "display_name": "宽度",
                        "tooltip": "编码目标宽度，建议与采样宽度一致，会自动对齐到 16 的倍数。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 480,
                        "min": 64,
                        "max": 8096,
                        "step": 8,
                        "display_name": "高度",
                        "tooltip": "编码目标高度，建议与采样高度一致，会自动对齐到 16 的倍数。",
                    },
                ),
                "num_frames": (
                    "INT",
                    {
                        "default": 81,
                        "min": 1,
                        "max": 10000,
                        "step": 4,
                        "display_name": "帧数",
                        "tooltip": "目标视频帧数，会按 WanVideo 的 4n+1 规则自动对齐。",
                    },
                ),
                "force_offload": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "编码后卸载VAE",
                        "tooltip": "编码完成后把 VAE 移回卸载设备，降低显存占用。",
                    },
                ),
                "frame_window_size": (
                    "INT",
                    {
                        "default": 77,
                        "min": 1,
                        "max": 10000,
                        "step": 1,
                        "display_name": "时间窗口",
                        "tooltip": "Animate 循环/长视频时每个窗口参与时序注意力的帧数。",
                    },
                ),
                "colormatch": (
                    COLORMATCH_VALUES,
                    {
                        "default": "disabled",
                        "display_name": "窗口颜色匹配",
                        "tooltip": "长视频窗口之间的颜色匹配方式；disabled 为不启用。",
                    },
                ),
                "pose_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "display_name": "姿态强度",
                        "tooltip": "姿态条件的额外倍率。",
                    },
                ),
                "face_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "display_name": "人脸强度",
                        "tooltip": "人脸条件的额外倍率。",
                    },
                ),
            },
            "optional": {
                "clip_embeds": (
                    "WANVIDIMAGE_CLIPEMBEDS",
                    {
                        "display_name": "CLIP图像条件",
                        "tooltip": "可选。由 Wan 图像 CLIP 编码节点输出。",
                    },
                ),
                "ref_images": (
                    "IMAGE",
                    {
                        "display_name": "参考图",
                        "tooltip": "可选参考图，会编码为参考 latent 并参与 Animate 条件。",
                    },
                ),
                "pose_images": (
                    "IMAGE",
                    {
                        "display_name": "姿态帧",
                        "tooltip": "可选姿态帧序列，会按目标尺寸编码为姿态 latent。",
                    },
                ),
                "face_images": (
                    "IMAGE",
                    {
                        "display_name": "人脸帧",
                        "tooltip": "可选人脸帧序列，会缩放到 512x512 后作为 Animate 人脸条件。",
                    },
                ),
                "bg_images": (
                    "IMAGE",
                    {
                        "display_name": "背景帧",
                        "tooltip": "可选背景帧序列。未连接时，非循环模式会按原版逻辑补空背景 latent。",
                    },
                ),
                "mask": (
                    "MASK",
                    {
                        "display_name": "背景遮罩",
                        "tooltip": "可选遮罩，用于控制参考图/背景区域的混合。",
                    },
                ),
                "start_ref_image": (
                    "IMAGE",
                    {
                        "display_name": "起始参考图",
                        "tooltip": "可选。连接后会启用循环/窗口式 Animate 处理。",
                    },
                ),
                "tiled_vae": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "分块VAE",
                        "tooltip": "开启后使用分块 VAE 编码以降低显存占用，速度会变慢。",
                    },
                ),
            },
        }

    def process(
        self,
        vae,
        width: int,
        height: int,
        num_frames: int,
        force_offload: bool,
        frame_window_size: int,
        colormatch: str,
        pose_strength: float,
        face_strength: float,
        ref_images=None,
        pose_images=None,
        face_images=None,
        clip_embeds=None,
        tiled_vae: bool = False,
        bg_images=None,
        mask=None,
        start_ref_image=None,
    ):
        wan_nodes = _load_wanvideo_runtime()
        encoder = wan_nodes.WanVideoAnimateEmbeds()
        return encoder.process(
            vae=vae,
            width=int(width),
            height=int(height),
            num_frames=int(num_frames),
            force_offload=bool(force_offload),
            frame_window_size=int(frame_window_size),
            colormatch=str(colormatch or "disabled"),
            pose_strength=float(pose_strength),
            face_strength=float(face_strength),
            ref_images=ref_images,
            pose_images=pose_images,
            face_images=face_images,
            clip_embeds=clip_embeds,
            tiled_vae=bool(tiled_vae),
            bg_images=bg_images,
            mask=mask,
            start_ref_image=start_ref_image,
        )


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoAnimateEmbeds,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
