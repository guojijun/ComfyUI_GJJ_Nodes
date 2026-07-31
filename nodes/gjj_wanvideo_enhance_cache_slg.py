from __future__ import annotations


NODE_NAME = "GJJ_WanVideoEnhanceCacheSLG"
NODE_DISPLAY_NAME = "🧰 WanVideo增强缓存与SLG"


def _parse_slg_blocks(value: str) -> list[int]:
    text = str(value or "").strip()
    if not text:
        raise ValueError("SLG跳过块不能为空，请输入块索引，例如：10 或 8,9,10。")

    blocks: list[int] = []
    seen: set[int] = set()
    for item in text.split(","):
        part = item.strip()
        if not part:
            continue
        try:
            block = int(part)
        except (TypeError, ValueError) as error:
            raise ValueError(
                "SLG跳过块格式错误，请使用英文逗号分隔非负整数，例如：8,9,10。"
            ) from error
        if block < 0:
            raise ValueError("SLG跳过块索引不能小于 0。")
        if block not in seen:
            blocks.append(block)
            seen.add(block)

    if not blocks:
        raise ValueError("未读取到有效的SLG跳过块索引。")
    return blocks


def _validate_percent_range(name: str, start_percent: float, end_percent: float) -> None:
    if float(start_percent) > float(end_percent):
        raise ValueError(
            f"{name}的开始比例不能大于结束比例："
            f"{float(start_percent):.2f} > {float(end_percent):.2f}。"
        )


def _resolve_cache_device(cache_device: str):
    try:
        from comfy import model_management
    except Exception as error:
        raise RuntimeError(
            "无法读取ComfyUI设备管理模块，不能生成EasyCache缓存设备参数。"
        ) from error

    if cache_device == "主设备":
        return model_management.get_torch_device()
    return model_management.unet_offload_device()


class GJJ_WanVideoEnhanceCacheSLG:
    CATEGORY = "GJJ/🎬 视频/模型/WanVideo"
    FUNCTION = "build_args"
    DESCRIPTION = (
        "将 WanVideoEnhanceAVideo、WanVideoEasyCache 和 WanVideoSLG "
        "合并为一个零外部节点依赖的三输出参数节点。"
    )
    SEARCH_ALIASES = [
        "WanVideoEnhanceAVideo",
        "WanVideo Enhance A Video",
        "WanVideo Enhance-A-Video",
        "WanVideoEasyCache",
        "WanVideo EasyCache",
        "WanVideoSLG",
        "WanVideo SLG",
        "EnhanceAVideo",
        "EasyCache",
        "SLG",
        "视频增强",
        "视频缓存",
        "跳层引导",
    ]

    RETURN_TYPES = ("FETAARGS", "CACHEARGS", "SLGARGS")
    RETURN_NAMES = ("视频增强参数", "EasyCache缓存参数", "SLG跳层参数")
    OUTPUT_TOOLTIPS = (
        "兼容 WanVideoEnhanceAVideo 的 FETAARGS 参数，连接到采样器的视频增强参数输入。",
        "兼容 WanVideoEasyCache 的 CACHEARGS 参数，连接到采样器的缓存参数输入。",
        "兼容 WanVideoSLG 的 SLGARGS 参数，连接到采样器的 SLG 参数输入。",
    )

    GJJ_HELP = {
        "标题": "WanVideo增强、缓存与SLG",
        "说明": (
            "把视频增强、EasyCache缓存和SLG跳层引导集中到一个节点，"
            "并分别输出三个与原版节点兼容的参数接口。"
        ),
        "使用方法": [
            "视频增强参数输出连接到WanVideo采样器的FETA参数输入。",
            "EasyCache缓存参数输出连接到WanVideo采样器的缓存参数输入。",
            "SLG跳层参数输出连接到WanVideo采样器的SLG参数输入。",
            "三个输出互不捆绑，只连接需要使用的功能即可。",
        ],
        "视频增强": [
            "增强权重越高，时间注意力增强效果越强。",
            "开始比例和结束比例控制增强生效的采样区间。",
        ],
        "EasyCache缓存": [
            "缓存阈值越高，跳过计算通常越积极，速度可能更快，但画面偏差也可能增加。",
            "缓存开始步数建议避开采样最初几步，原版默认从第10步开始。",
            "结束步数为-1时，由采样器使用最后一个采样步。",
        ],
        "SLG跳层引导": [
            "跳过块使用从0开始的Transformer块索引。",
            "多个索引使用英文逗号分隔，例如8,9,10。",
            "SLG仅在指定采样比例区间内跳过无条件分支的目标块。",
        ],
        "注意事项": [
            "本节点只生成参数字典，不执行采样，也不加载模型。",
            "输出字段、默认值和数据类型与三个原版WanVideoWrapper节点保持兼容。",
            "本节点不依赖外部ComfyUI-WanVideoWrapper节点包，也不新增第三方运行依赖。",
        ],
        "搜索关键词": [
            "WanVideoEnhanceAVideo",
            "WanVideoEasyCache",
            "WanVideoSLG",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "enhance_weight": (
                    "FLOAT",
                    {
                        "default": 2.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "增强权重",
                        "tooltip": "视频增强的FETA权重；数值越高，时间注意力增强越强。",
                    },
                ),
                "enhance_start_percent": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "增强开始比例",
                        "tooltip": "视频增强开始生效的采样进度，0表示从采样开始。",
                    },
                ),
                "enhance_end_percent": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "增强结束比例",
                        "tooltip": "视频增强停止生效的采样进度，1表示持续到采样结束。",
                    },
                ),
                "easycache_thresh": (
                    "FLOAT",
                    {
                        "default": 0.015,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.001,
                        "display_name": "缓存阈值",
                        "tooltip": (
                            "EasyCache判断是否复用扩散模型输出的阈值。"
                            "数值越高通常越积极，但可能增加画面偏差。"
                        ),
                    },
                ),
                "cache_start_step": (
                    "INT",
                    {
                        "default": 10,
                        "min": 0,
                        "max": 9999,
                        "step": 1,
                        "display_name": "缓存开始步数",
                        "tooltip": "EasyCache开始参与采样的步数，原版默认从第10步开始。",
                    },
                ),
                "cache_end_step": (
                    "INT",
                    {
                        "default": -1,
                        "min": -1,
                        "max": 9999,
                        "step": 1,
                        "display_name": "缓存结束步数",
                        "tooltip": "EasyCache停止参与采样的步数；-1表示使用最后一个采样步。",
                    },
                ),
                "cache_device": (
                    ["卸载设备", "主设备"],
                    {
                        "default": "卸载设备",
                        "display_name": "缓存设备",
                        "tooltip": (
                            "选择EasyCache状态保存位置。卸载设备通常节省显存，"
                            "主设备可能减少数据传输。"
                        ),
                    },
                ),
                "slg_blocks": (
                    "STRING",
                    {
                        "default": "10",
                        "multiline": False,
                        "display_name": "SLG跳过块",
                        "tooltip": (
                            "需要跳过无条件分支的Transformer块索引，从0开始；"
                            "多个索引使用英文逗号分隔，例如8,9,10。"
                        ),
                    },
                ),
                "slg_start_percent": (
                    "FLOAT",
                    {
                        "default": 0.1,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "SLG开始比例",
                        "tooltip": "SLG跳层引导开始生效的采样进度。",
                    },
                ),
                "slg_end_percent": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "SLG结束比例",
                        "tooltip": "SLG跳层引导停止生效的采样进度。",
                    },
                ),
            },
        }

    def build_args(
        self,
        enhance_weight,
        enhance_start_percent,
        enhance_end_percent,
        easycache_thresh,
        cache_start_step,
        cache_end_step,
        cache_device,
        slg_blocks,
        slg_start_percent,
        slg_end_percent,
    ):
        _validate_percent_range(
            "视频增强",
            enhance_start_percent,
            enhance_end_percent,
        )
        _validate_percent_range(
            "SLG跳层引导",
            slg_start_percent,
            slg_end_percent,
        )

        feta_args = {
            "weight": float(enhance_weight),
            "start_percent": float(enhance_start_percent),
            "end_percent": float(enhance_end_percent),
        }
        cache_args = {
            "cache_type": "EasyCache",
            "easycache_thresh": float(easycache_thresh),
            "start_step": int(cache_start_step),
            "end_step": int(cache_end_step),
            "cache_device": _resolve_cache_device(str(cache_device)),
        }
        slg_args = {
            "blocks": _parse_slg_blocks(slg_blocks),
            "start_percent": float(slg_start_percent),
            "end_percent": float(slg_end_percent),
        }
        return feta_args, cache_args, slg_args


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoEnhanceCacheSLG,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
