from __future__ import annotations


NODE_NAME = "GJJ_WanVideoExperimentalArgs"
NODE_DISPLAY_NAME = "🧪 WanVideo Experimental Args 实验参数"


def _normalize_split_steps(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    for separator in ("，", "、", "；", ";"):
        text = text.replace(separator, ",")

    steps: list[str] = []
    for item in text.split(","):
        part = item.strip()
        if not part:
            continue
        try:
            step = int(part)
        except (TypeError, ValueError) as error:
            raise ValueError(
                "视频注意力拆分步数格式错误。请输入逗号分隔的非负整数，例如：0,5,10。"
            ) from error
        if step < 0:
            raise ValueError("视频注意力拆分步数不能小于 0。")
        steps.append(str(step))
    return ",".join(steps)


def _as_bool(value) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "是", "开启", "启用"}
    return bool(value)


class GJJ_WanVideoExperimentalArgs:
    CATEGORY = "GJJ/视频模型/WanVideo"
    FUNCTION = "build_args"
    EXPERIMENTAL = False
    DESCRIPTION = (
        "GJJ 零依赖复刻 WanVideoExperimentalArgs：生成 WanVideo 采样器使用的实验参数，"
        "包括多提示词注意力拆分、CFG-Zero*、FreSca、TCFG、RAAG、双向采样和 TSR。"
    )
    SEARCH_ALIASES = [
        "WanVideoExperimentalArgs",
        "WanVideo Experimental Args",
        "WanVideo Experimental",
        "Experimental Args",
        "experimental args",
        "WanVideo实验参数",
        "万相视频实验参数",
        "视频采样实验参数",
        "CFG Zero Star",
        "FreSca",
        "TCFG",
        "RAAG",
        "TSR",
        "双向采样",
        "时间分数重缩放",
    ]

    RETURN_TYPES = ("EXPERIMENTALARGS",)
    RETURN_NAMES = ("WanVideo实验参数",)
    OUTPUT_TOOLTIPS = (
        "与原版 WanVideoExperimentalArgs 字段完全兼容的 EXPERIMENTALARGS 配置字典，可连接到 WanVideo 采样器的“实验参数”输入。",
    )

    GJJ_HELP = {
        "title": "WanVideo 实验参数",
        "description": (
            "零依赖复刻 WanVideoExperimentalArgs，把 WanVideo 的实验采样功能集中封装为 "
            "EXPERIMENTALARGS 参数字典。"
        ),
        "notice": (
            "本节点只生成参数，不加载模型、不执行采样，也不依赖外部 "
            "ComfyUI-WanVideoWrapper 节点包。"
        ),
        "usage": [
            "默认设置等同于关闭全部实验增强，可直接连接后按需开启。",
            "输出连接到 GJJ WanVideo Sampler v2 或兼容采样器的“实验参数”输入。",
            "视频注意力拆分步数使用逗号分隔，例如 0,5,10；留空表示关闭。",
            "各实验功能可以独立开启，也可以组合使用。",
        ],
        "parameters": [
            "CFG-Zero*：减轻较高 CFG 下的过曝、过饱和等问题。",
            "FreSca：分别调节低频与高频引导强度，并通过频率截止值划分频段。",
            "TCFG：使用切向阻尼无分类器引导减少 CFG 伪影。",
            "RAAG：自适应引导强度为 0 时关闭，1.0 为原项目参考值。",
            "双向采样：结合正向与反向时间方向预测，会增加计算量。",
            "TSR：通过采样温度和介入时机调整视频时间一致性。",
        ],
        "notes": [
            "这些功能属于实验特性，不同模型、调度器和采样步数下效果可能不同。",
            "同时开启多个实验功能可能显著增加计算量或产生不可预期的组合效果。",
            "输出字段、默认值、类型和值域与原版 WanVideoExperimentalArgs 保持一致。",
        ],
        "dependencies": ["无外部自定义节点依赖，无新增 Python 依赖。"],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_attention_split_steps": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "视频注意力拆分步数",
                        "tooltip": (
                            "使用多个提示词时，在指定采样步拆分视频自注意力。"
                            "请输入逗号分隔的非负整数，例如 0,5,10；留空表示关闭。"
                        ),
                    },
                ),
                "cfg_zero_star": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用CFG-Zero*",
                        "tooltip": "启用 CFG-Zero* 无分类器引导，用于减轻较高 CFG 下的过曝、过饱和等问题。",
                    },
                ),
                "use_zero_init": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "使用零初始化预测",
                        "tooltip": "配合 CFG-Zero*，在指定的前期采样步数内使用零初始化预测。",
                    },
                ),
                "zero_star_steps": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "step": 1,
                        "display_name": "零初始化步数",
                        "tooltip": "CFG-Zero* 使用零初始化预测的前期采样步数；0 表示不应用。",
                    },
                ),
                "use_fresca": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用FreSca",
                        "tooltip": "启用 FreSca 频率感知引导，分别控制低频和高频引导强度。",
                    },
                ),
                "fresca_scale_low": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.01,
                        "display_name": "FreSca低频强度",
                        "tooltip": "FreSca 对低频成分使用的引导缩放强度，原版默认值为 1.0。",
                    },
                ),
                "fresca_scale_high": (
                    "FLOAT",
                    {
                        "default": 1.25,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.01,
                        "display_name": "FreSca高频强度",
                        "tooltip": "FreSca 对高频成分使用的引导缩放强度，原版默认值为 1.25。",
                    },
                ),
                "fresca_freq_cutoff": (
                    "INT",
                    {
                        "default": 20,
                        "min": 0,
                        "max": 10000,
                        "step": 1,
                        "display_name": "FreSca频率截止值",
                        "tooltip": "FreSca 划分低频与高频区域的截止值，原版默认值为 20。",
                    },
                ),
                "use_tcfg": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用TCFG",
                        "tooltip": "启用 TCFG 切向阻尼无分类器引导，用于减少较高 CFG 产生的伪影。",
                    },
                ),
                "raag_alpha": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.01,
                        "display_name": "RAAG引导强度",
                        "tooltip": "RAAG 的 Alpha 强度；0 表示关闭，原项目参考值为 1.0。",
                    },
                ),
                "bidirectional_sampling": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用双向采样",
                        "tooltip": "结合正向与反向时间方向进行预测。启用后会增加额外计算量。",
                    },
                ),
                "temporal_score_rescaling": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用TSR",
                        "tooltip": "启用 TSR 时间分数重缩放，用于调整视频时间维度的采样预测。",
                    },
                ),
                "tsr_k": (
                    "FLOAT",
                    {
                        "default": 0.95,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "TSR采样温度",
                        "tooltip": "TSR 的采样温度参数，原版默认值为 0.95。",
                    },
                ),
                "tsr_sigma": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "TSR介入时机",
                        "tooltip": "控制 TSR 在采样过程中介入的早晚，范围为 0 到 1，原版默认值为 1.0。",
                    },
                ),
            },
        }

    def build_args(
        self,
        video_attention_split_steps,
        cfg_zero_star,
        use_zero_init,
        zero_star_steps,
        use_fresca,
        fresca_scale_low,
        fresca_scale_high,
        fresca_freq_cutoff,
        use_tcfg,
        raag_alpha,
        bidirectional_sampling,
        temporal_score_rescaling,
        tsr_k,
        tsr_sigma,
    ):
        experimental_args = {
            "video_attention_split_steps": _normalize_split_steps(
                video_attention_split_steps
            ),
            "cfg_zero_star": _as_bool(cfg_zero_star),
            "use_zero_init": _as_bool(use_zero_init),
            "zero_star_steps": int(zero_star_steps),
            "use_fresca": _as_bool(use_fresca),
            "fresca_scale_low": float(fresca_scale_low),
            "fresca_scale_high": float(fresca_scale_high),
            "fresca_freq_cutoff": int(fresca_freq_cutoff),
            "use_tcfg": _as_bool(use_tcfg),
            "raag_alpha": float(raag_alpha),
            "bidirectional_sampling": _as_bool(bidirectional_sampling),
            "temporal_score_rescaling": _as_bool(temporal_score_rescaling),
            "tsr_k": float(tsr_k),
            "tsr_sigma": float(tsr_sigma),
        }
        return (experimental_args,)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoExperimentalArgs,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
