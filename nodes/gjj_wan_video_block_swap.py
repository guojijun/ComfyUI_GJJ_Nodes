from __future__ import annotations

from typing import Any


class GJJ_WanVideoBlockSwap:
    CATEGORY = "GJJ/视频"
    FUNCTION = "setargs"
    DESCRIPTION = (
        "WanVideo Block Swap 参数的 GJJ 零依赖复刻版。"
        "输出 BLOCKSWAPARGS 字典，用于让支持 WanVideo block_swap_args 的模型加载器或采样器降低显存占用。"
    )
    SEARCH_ALIASES = [
        "wan block swap",
        "wanvideo block swap",
        "WanVideoBlockSwap",
        "BLOCKSWAPARGS",
        "显存交换",
        "分块换入",
        "分块卸载",
    ]

    RETURN_TYPES = ("BLOCKSWAPARGS",)
    RETURN_NAMES = ("分块交换参数",)
    OUTPUT_TOOLTIPS = ("WanVideo 分块换入/卸载参数，可连接到支持 BLOCKSWAPARGS 的 WanVideo 模型加载或设置节点。",)

    GJJ_HELP = {
        "title": "WanVideo 分块交换",
        "description": "生成 WanVideo Block Swap 参数，减少生成时的显存压力。",
        "usage": [
            "blocks_to_swap 控制主 transformer 末尾多少个块换到 CPU/卸载设备。",
            "14B 常见为 40 个块，1.3B/5B 常见为 30 个块，LongCat-video 常见为 48 个块。",
            "VACE 模型可额外设置 vace_blocks_to_swap，VACE 通常有 15 个块。",
            "prefetch_blocks 可提前换入后续块，可能提速但会增加内存占用。",
        ],
        "notes": [
            "该节点只生成参数，不导入 ComfyUI-WanVideoWrapper。",
            "字段名保持与 WanVideoWrapper 原始采样器一致：blocks_to_swap、offload_img_emb、offload_txt_emb、use_non_blocking、vace_blocks_to_swap、prefetch_blocks、block_swap_debug。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "blocks_to_swap": (
                    "INT",
                    {
                        "default": 20,
                        "min": 0,
                        "max": 48,
                        "step": 1,
                        "display_name": "主块交换数量",
                        "tooltip": "要换到 CPU/卸载设备的 transformer 主块数量。14B 常见 40 块，1.3B/5B 常见 30 块，LongCat-video 常见 48 块。",
                    },
                ),
                "offload_img_emb": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "卸载图像嵌入",
                        "tooltip": "开启后把 img_emb 相关参数放到卸载设备，进一步降低显存占用。",
                    },
                ),
                "offload_txt_emb": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "卸载文本/时间嵌入",
                        "tooltip": "开启后把 txt_emb/time_emb 相关参数放到卸载设备，进一步降低显存占用。",
                    },
                ),
            },
            "optional": {
                "use_non_blocking": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "异步传输",
                        "tooltip": "使用 non-blocking 内存传输。可能更快，但会占用更多系统内存。",
                    },
                ),
                "vace_blocks_to_swap": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 15,
                        "step": 1,
                        "display_name": "VACE 块交换数量",
                        "tooltip": "VACE 模型额外交换的块数量。VACE 模型通常有 15 个块；不用 VACE 时保持 0。",
                    },
                ),
                "prefetch_blocks": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 40,
                        "step": 1,
                        "display_name": "预取块数量",
                        "tooltip": "提前换入后续块的数量。1 通常足以抵消部分速度损失，数值越大内存占用越高。",
                    },
                ),
                "block_swap_debug": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "调试日志",
                        "tooltip": "开启后让支持该参数的 WanVideo 运行时输出分块交换调试信息。",
                    },
                ),
            },
        }

    def setargs(
        self,
        blocks_to_swap: int,
        offload_img_emb: bool,
        offload_txt_emb: bool,
        use_non_blocking: bool = False,
        vace_blocks_to_swap: int = 0,
        prefetch_blocks: int = 0,
        block_swap_debug: bool = False,
    ) -> tuple[dict[str, Any]]:
        args = {
            "blocks_to_swap": max(0, min(48, int(blocks_to_swap))),
            "offload_img_emb": bool(offload_img_emb),
            "offload_txt_emb": bool(offload_txt_emb),
            "use_non_blocking": bool(use_non_blocking),
            "vace_blocks_to_swap": max(0, min(15, int(vace_blocks_to_swap))),
            "prefetch_blocks": max(0, min(40, int(prefetch_blocks))),
            "block_swap_debug": bool(block_swap_debug),
        }
        return (args,)


NODE_CLASS_MAPPINGS = {
    "GJJ_WanVideoBlockSwap": GJJ_WanVideoBlockSwap,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WanVideoBlockSwap": "🧱 Wan 分块交换",
}
