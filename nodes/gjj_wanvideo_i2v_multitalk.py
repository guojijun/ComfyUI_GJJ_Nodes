from __future__ import annotations


NODE_NAME = "GJJ_WanVideoImageToVideoMultiTalk"
NODE_DISPLAY_NAME = "🎤 Wan MultiTalk长视频I2V"

COLOR_MATCH_VALUES = [
    "disabled",
    "mkl",
    "hm",
    "reinhard",
    "mvgd",
    "hm-mvgd-hm",
    "hm-mkl-hm",
]

MODE_VALUES = [
    "auto",
    "multitalk",
    "infinitetalk",
]


def _load_multitalk_runtime():
    try:
        from ..vendor.wanvideo_wrapper.multitalk import nodes as multitalk_nodes
    except Exception as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo MultiTalk runtime 加载失败。无需安装外部 WanVideoWrapper 节点包；"
            f"如果是运行库缺失，请按 GJJ 的 WanVideo 依赖方案安装。\n错误信息：{error}"
        ) from error
    return multitalk_nodes


class GJJ_WanVideoImageToVideoMultiTalk:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    DESCRIPTION = (
        "WanVideo MultiTalk / InfiniteTalk 长视频图生视频条件节点。"
        "内部调用 GJJ vendor 中的 WanVideoImageToVideoMultiTalk，不依赖外部 WanVideoWrapper 插件。"
    )
    SEARCH_ALIASES = [
        "WanVideoImageToVideoMultiTalk",
        "WanVideo Long I2V MultiTalk",
        "MultiTalk",
        "InfiniteTalk",
        "Wan MultiTalk",
        "长视频图生视频",
    ]

    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS", "STRING")
    RETURN_NAMES = ("图生视频条件", "输出目录")
    OUTPUT_TOOLTIPS = (
        "供 GJJ WanVideo Sampler 使用的 MultiTalk / InfiniteTalk 长视频 I2V 条件。",
        "如果设置了输出目录，这里返回按时间戳创建后的实际目录。",
    )

    GJJ_HELP = {
        "title": "Wan MultiTalk 长视频 I2V",
        "description": "为 MultiTalk / InfiniteTalk 采样循环生成图生视频条件，按窗口重叠方式制作长视频。",
        "usage": [
            "Wan VAE 接 GJJ WanVideo VAE 加载器输出。",
            "起始图接需要驱动的人物图片；输出接 GJJ WanVideo Sampler 的图像条件输入。",
            "配合 GJJ MultiTalk 音频条件和已加载 MultiTalk / InfiniteTalk 模型的 WanVideo 模型使用。",
        ],
        "notes": [
            "本节点只使用 GJJ vendor/wanvideo_wrapper 内置 runtime。",
            "不要再额外连接 context windows；原版 MultiTalk 长视频逻辑已经在采样循环里处理窗口。",
            "设置输出目录会把每个窗口结果保存到磁盘，并减少最终视频张量返回带来的内存压力。",
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
                        "tooltip": "接 GJJ WanVideo VAE 加载器输出。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 832,
                        "min": 64,
                        "max": 2048,
                        "step": 8,
                        "display_name": "宽度",
                        "tooltip": "生成宽度，建议与采样器宽度一致。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 480,
                        "min": 64,
                        "max": 29048,
                        "step": 8,
                        "display_name": "高度",
                        "tooltip": "生成高度，建议与采样器高度一致。",
                    },
                ),
                "frame_window_size": (
                    "INT",
                    {
                        "default": 81,
                        "min": 1,
                        "max": 10000,
                        "step": 4,
                        "display_name": "窗口帧数",
                        "tooltip": "每次窗口处理的帧数，会按 WanVideo 的 4n+1 规则自动对齐。",
                    },
                ),
                "motion_frame": (
                    "INT",
                    {
                        "default": 25,
                        "min": 1,
                        "max": 10000,
                        "step": 1,
                        "display_name": "运动重叠帧",
                        "tooltip": "长视频生成中相邻窗口的驱动/重叠帧长度。",
                    },
                ),
                "force_offload": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "循环中强制卸载",
                        "tooltip": "显存紧张时开启，会在循环中的 VAE 操作后卸载模型。",
                    },
                ),
                "colormatch": (
                    COLOR_MATCH_VALUES,
                    {
                        "default": "disabled",
                        "display_name": "窗口色彩匹配",
                        "tooltip": "用于减轻长视频窗口之间的颜色漂移。",
                    },
                ),
            },
            "optional": {
                "start_image": (
                    "IMAGE",
                    {
                        "display_name": "起始图",
                        "tooltip": "MultiTalk / InfiniteTalk 长视频的起始参考图。",
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
                "clip_embeds": (
                    "WANVIDIMAGE_CLIPEMBEDS",
                    {
                        "display_name": "CLIP图像条件",
                        "tooltip": "可选。由 WanVideo CLIP Vision 编码节点输出。",
                    },
                ),
                "mode": (
                    MODE_VALUES,
                    {
                        "default": "auto",
                        "display_name": "采样模式",
                        "tooltip": "auto 自动匹配；也可以手动指定 multitalk 或 infinitetalk。",
                    },
                ),
                "output_path": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "输出目录",
                        "tooltip": "可选。设置后保存每个窗口的结果帧，并禁用最终视频张量返回以节省内存。",
                    },
                ),
            },
        }

    def process(
        self,
        vae,
        width: int,
        height: int,
        frame_window_size: int,
        motion_frame: int,
        force_offload: bool,
        colormatch: str,
        start_image=None,
        tiled_vae: bool = False,
        clip_embeds=None,
        mode: str = "auto",
        output_path: str = "",
    ):
        multitalk_nodes = _load_multitalk_runtime()
        encoder = multitalk_nodes.WanVideoImageToVideoMultiTalk()
        return encoder.process(
            vae=vae,
            width=int(width),
            height=int(height),
            frame_window_size=int(frame_window_size),
            motion_frame=int(motion_frame),
            force_offload=bool(force_offload),
            colormatch=str(colormatch or "disabled"),
            start_image=start_image,
            tiled_vae=bool(tiled_vae),
            clip_embeds=clip_embeds,
            mode=str(mode or "auto"),
            output_path=str(output_path or ""),
        )


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoImageToVideoMultiTalk,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
