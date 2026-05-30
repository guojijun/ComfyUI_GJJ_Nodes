from __future__ import annotations

from typing import Any


def _apply_block_swap_to_model(model: Any, block_swap_args: dict[str, Any] | None):
    if model is None:
        return None
    if block_swap_args is None:
        return model
    if not hasattr(model, "clone"):
        raise TypeError("WanVideo 分块交换需要可 clone 的 WANVIDEOMODEL 模型对象。")

    patcher = model.clone()
    if not hasattr(patcher, "model_options") or patcher.model_options is None:
        patcher.model_options = {}
    if not isinstance(patcher.model_options, dict):
        raise TypeError("WanVideo 模型的 model_options 不是可写字典，无法写入 block_swap_args。")
    transformer_options = patcher.model_options.setdefault("transformer_options", {})
    if not isinstance(transformer_options, dict):
        transformer_options = {}
        patcher.model_options["transformer_options"] = transformer_options
    transformer_options["block_swap_args"] = block_swap_args
    return patcher


class GJJ_WanVideoBlockSwap:
    CATEGORY = "GJJ/视频"
    FUNCTION = "setargs"
    DESCRIPTION = (
        "WanVideo Block Swap 参数的 GJJ 零依赖复刻版。"
        "输出 BLOCKSWAPARGS 字典；可选接入 WANVIDEOMODEL 时，会在节点内复刻 WanVideoSetBlockSwap 逻辑并输出已写入参数的模型。"
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

    RETURN_TYPES = ("BLOCKSWAPARGS", "WANVIDEOMODEL")
    RETURN_NAMES = ("分块交换参数", "WanVideo模型")
    OUTPUT_TOOLTIPS = (
        "WanVideo 分块换入/卸载参数，可连接到支持 BLOCKSWAPARGS 的 WanVideo 模型加载器或采样器。",
        "当左侧 model 接入 WANVIDEOMODEL 时，输出已写入 block_swap_args 的克隆模型；未接入时为空。",
    )

    GJJ_HELP = {
        "title": "WanVideo 分块交换",
        "description": "生成 WanVideo Block Swap 参数，减少生成时的显存压力。",
        "usage": [
            "blocks_to_swap 控制主 transformer 末尾多少个块换到 CPU/卸载设备。",
            "14B 常见为 40 个块，1.3B/5B 常见为 30 个块，LongCat-video 常见为 48 个块。",
            "VACE 模型可额外设置 vace_blocks_to_swap，VACE 通常有 15 个块。",
            "prefetch_blocks 可提前换入后续块，可能提速但会增加内存占用。",
            "如果接入可选 model 输入，节点会直接输出已写入分块交换参数的 WANVIDEOMODEL。",
        ],
        "notes": [
            "该节点不导入 ComfyUI-WanVideoWrapper；model 接入时仅复刻 WanVideoSetBlockSwap 的 clone + model_options 写入逻辑。",
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
                "model": (
                    "WANVIDEOMODEL",
                    {
                        "display_name": "WanVideo模型",
                        "tooltip": "可选接入 WANVIDEOMODEL。接入后节点会 clone 模型并写入 transformer_options.block_swap_args，等同 WanVideoSetBlockSwap。",
                    },
                ),
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
        model=None,
        use_non_blocking: bool = False,
        vace_blocks_to_swap: int = 0,
        prefetch_blocks: int = 0,
        block_swap_debug: bool = False,
    ) -> tuple[dict[str, Any], Any]:
        args = {
            "blocks_to_swap": max(0, min(48, int(blocks_to_swap))),
            "offload_img_emb": bool(offload_img_emb),
            "offload_txt_emb": bool(offload_txt_emb),
            "use_non_blocking": bool(use_non_blocking),
            "vace_blocks_to_swap": max(0, min(15, int(vace_blocks_to_swap))),
            "prefetch_blocks": max(0, min(40, int(prefetch_blocks))),
            "block_swap_debug": bool(block_swap_debug),
        }
        return (args, _apply_block_swap_to_model(model, args) if model is not None else None)


class GJJ_WanVideoSetBlockSwap:
    CATEGORY = "GJJ/视频模型/WanVideo"
    FUNCTION = "loadmodel"
    DESCRIPTION = "GJJ 零依赖复刻 WanVideoSetBlockSwap：把 BLOCKSWAPARGS 写入 WanVideo 模型的 transformer_options。"
    SEARCH_ALIASES = [
        "wan set block swap",
        "wanvideo set block swap",
        "WanVideoSetBlockSwap",
        "设置分块交换",
        "模型分块交换",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("WANVIDEOMODEL,MODEL", {
                    "display_name": "WanVideo 模型",
                    "tooltip": "可接 WanVideo 模型，也可接 GJJ · WanVideo模型加载输出的普通 MODEL。节点会 clone 模型并写入分块交换参数，不直接修改输入模型。",
                }),
            },
            "optional": {
                "block_swap_args": ("BLOCKSWAPARGS", {
                    "display_name": "分块交换参数",
                    "tooltip": "连接 GJJ · Wan 分块交换 输出；不连接时原样返回模型。",
                }),
            },
        }

    RETURN_TYPES = ("WANVIDEOMODEL,MODEL",)
    RETURN_NAMES = ("WanVideo 模型",)
    OUTPUT_TOOLTIPS = ("已写入 block_swap_args 的 WanVideo / MODEL 兼容模型。",)
    GJJ_HELP = {
        "title": "WanVideo 设置分块交换",
        "description": "复刻源 WanVideoSetBlockSwap：将 BLOCKSWAPARGS 写入模型的 transformer_options.block_swap_args，供采样器在执行时启用分块换入/卸载。",
        "usage": [
            "上游可接 WanVideo 模型加载器，也可接 GJJ · WanVideo模型加载 的 MODEL 输出。",
            "block_swap_args 接 GJJ · Wan 分块交换。",
            "输出模型再接 WanVideo Sampler / GJJ WanVideo Sampler。",
        ],
        "notes": [
            "逻辑与源节点一致：无参数时直接返回原模型；有参数时 clone 模型后写入 model_options。",
            "不导入 ComfyUI-WanVideoWrapper 源插件，也不新增 pip 依赖。",
        ],
    }

    def loadmodel(self, model, block_swap_args=None):
        return (_apply_block_swap_to_model(model, block_swap_args),)


NODE_CLASS_MAPPINGS = {
    "GJJ_WanVideoBlockSwap": GJJ_WanVideoBlockSwap,
    "GJJ_WanVideoSetBlockSwap": GJJ_WanVideoSetBlockSwap,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WanVideoBlockSwap": "🧱 Wan 分块交换",
    "GJJ_WanVideoSetBlockSwap": "GJJ · 🧱 WanVideo 设置分块交换",
}
