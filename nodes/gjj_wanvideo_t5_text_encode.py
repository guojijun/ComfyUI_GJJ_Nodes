from __future__ import annotations

import gc

import folder_paths
import comfy.model_management as mm


NODE_NAME = "GJJ_WanVideoT5TextEncode"
NODE_DISPLAY_NAME = "📝 Wan T5文本编码"
LONGCAT_T5_MODEL = "umt5-xxl-enc-bf16.safetensors"

PRECISION_VALUES = ["bf16", "fp32"]
QUANTIZATION_VALUES = ["disabled", "fp8_e4m3fn"]
LOAD_DEVICE_VALUES = ["main_device", "offload_device"]
COMPUTE_DEVICE_VALUES = ["gpu", "cpu"]


def _scan_text_encoders(keyword: str = "umt5") -> tuple[list[str], str]:
    try:
        names = list(folder_paths.get_filename_list("text_encoders"))
    except Exception:
        names = []
    if not names:
        return ["[未找到模型]"], "[未找到模型]"

    lower_keyword = str(keyword or "").lower()
    matched = [name for name in names if lower_keyword in str(name).lower()]
    values = matched or names

    preferred = None
    for name in values:
        lower = str(name).replace("\\", "/").lower()
        if lower.endswith(LONGCAT_T5_MODEL.lower()):
            preferred = name
            break
        if "umt5" in lower and ("xxl" in lower or "t5" in lower):
            preferred = name
            break
    return values, preferred or values[0]


def _load_wanvideo_runtime():
    try:
        from ..vendor.wanvideo_wrapper import nodes as wan_nodes
        from ..vendor.wanvideo_wrapper import nodes_model_loading
    except Exception as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo T5 文本编码 runtime 加载失败。无需安装 WanVideoWrapper 插件本体；"
            f"如果是 pip 运行库缺失，请按 GJJ 的 WanVideo 运行时依赖方案安装。\n错误信息：{error}"
        ) from error
    return nodes_model_loading, wan_nodes


class GJJ_WanVideoT5TextEncode:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    DESCRIPTION = (
        "合并 WanVideo T5 Text Encoder Loader 与 WanVideo TextEncode 的 GJJ 零依赖节点。"
        "执行时从 models/text_encoders 加载 T5 文本编码器，并直接输出 WanVideo 文本条件。"
    )
    SEARCH_ALIASES = [
        "WanVideoT5TextEncoderLoader",
        "LoadWanVideoT5TextEncoder",
        "WanVideoTextEncode",
        "Wan T5 文本编码",
        "WanVideo 文本条件",
    ]

    RETURN_TYPES = ("WANVIDEOTEXTEMBEDS", "WANVIDEOTEXTEMBEDS", "STRING")
    RETURN_NAMES = ("文本条件", "负向文本条件", "正向提示词")
    OUTPUT_TOOLTIPS = (
        "正向和负向提示词组成的 WanVideo 文本条件，可接 WanVideo Sampler。",
        "只包含负向提示词的文本条件，供 NAG 等节点使用。",
        "实际参与编码的正向提示词。",
    )

    GJJ_HELP = {
        "title": "Wan T5 文本编码",
        "description": "把 T5 文本编码器加载和 WanVideo 文本编码合成一个节点。",
        "usage": [
            "模型从 models/text_encoders 中选择，通常使用 umt5-xxl 编码器。",
            "正向/负向提示词会直接编码为 WANVIDEOTEXTEMBEDS。",
            "输出的文本条件连接到 GJJ WanVideo Sampler 的文本条件输入。",
        ],
        "notes": [
            "本节点只使用 GJJ vendor/wanvideo_wrapper 内置 runtime。",
            "开启磁盘缓存时，复用原版 WanVideoTextEncode 的文本嵌入缓存逻辑。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        text_encoders, default_encoder = _scan_text_encoders("umt5")
        return {
            "required": {
                "model_name": (
                    text_encoders,
                    {
                        "default": default_encoder,
                        "display_name": "T5模型",
                        "tooltip": "从 models/text_encoders 读取。WanVideo 通常使用 umt5-xxl 文本编码器。",
                    },
                ),
                "precision": (
                    PRECISION_VALUES,
                    {
                        "default": "bf16",
                        "display_name": "精度",
                        "tooltip": "T5 编码器计算精度。bf16 通常更省显存，fp32 更高精度但更慢更占内存。",
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display_name": "正向提示词",
                        "tooltip": "描述希望生成的画面内容。支持原版的 | 分段和 [1] EchoShot 写法。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display_name": "负向提示词",
                        "tooltip": "描述不希望出现的内容。",
                    },
                ),
                "quantization": (
                    QUANTIZATION_VALUES,
                    {
                        "default": "disabled",
                        "display_name": "量化",
                        "tooltip": "可选 T5 量化方式。fp8_e4m3fn 可降低显存占用。",
                    },
                ),
                "load_device": (
                    LOAD_DEVICE_VALUES,
                    {
                        "default": "offload_device",
                        "display_name": "初始加载设备",
                        "tooltip": "offload_device 先放在卸载设备，编码时再移动；main_device 会直接加载到主设备。",
                    },
                ),
                "compute_device": (
                    COMPUTE_DEVICE_VALUES,
                    {
                        "default": "gpu",
                        "display_name": "编码设备",
                        "tooltip": "文本编码执行设备。gpu 更快，cpu 更省显存但明显更慢。",
                    },
                ),
                "force_offload": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "编码后卸载T5",
                        "tooltip": "编码完成后把 T5 移回卸载设备并清理缓存。",
                    },
                ),
                "use_disk_cache": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "使用磁盘缓存",
                        "tooltip": "复用原版 WanVideoTextEncode 的文本嵌入缓存。相同提示词下可跳过重新编码。",
                    },
                ),
            },
            "optional": {
                "model_to_offload": (
                    "WANVIDEOMODEL",
                    {
                        "display_name": "临时卸载模型",
                        "tooltip": "可选。编码前先把视频模型移到卸载设备，为 T5 腾出显存。",
                    },
                ),
            },
        }

    def process(
        self,
        model_name,
        precision,
        positive_prompt,
        negative_prompt,
        quantization="disabled",
        load_device="offload_device",
        compute_device="gpu",
        force_offload=True,
        use_disk_cache=False,
        model_to_offload=None,
    ):
        if str(model_name or "").strip() == "[未找到模型]":
            raise RuntimeError("未找到 T5 文本编码器。请把 umt5-xxl 模型放到 models/text_encoders。")

        nodes_model_loading, wan_nodes = _load_wanvideo_runtime()
        loader = nodes_model_loading.LoadWanVideoT5TextEncoder()
        encoder = wan_nodes.WanVideoTextEncode()

        t5 = None
        try:
            t5, = loader.loadmodel(
                model_name=model_name,
                precision=str(precision or "bf16"),
                load_device=str(load_device or "offload_device"),
                quantization=str(quantization or "disabled"),
            )
            text_embeds, = encoder.process(
                positive_prompt=str(positive_prompt or ""),
                negative_prompt=str(negative_prompt or ""),
                t5=t5,
                force_offload=bool(force_offload),
                model_to_offload=model_to_offload,
                use_disk_cache=bool(use_disk_cache),
                device=str(compute_device or "gpu"),
            )
        finally:
            if t5 is not None:
                del t5
            mm.soft_empty_cache()
            gc.collect()

        return (
            text_embeds,
            {"prompt_embeds": text_embeds.get("negative_prompt_embeds")},
            str(positive_prompt or ""),
        )


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoT5TextEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
