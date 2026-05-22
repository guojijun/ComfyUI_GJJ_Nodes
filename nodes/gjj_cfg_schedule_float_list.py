from __future__ import annotations


NODE_NAME = "GJJ_CreateCFGScheduleFloatList"


class GJJ_CreateCFGScheduleFloatList:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "steps": (
                    "INT",
                    {
                        "default": 30,
                        "min": 2,
                        "max": 1000,
                        "step": 1,
                        "display_name": "步数",
                        "tooltip": "需要生成 CFG 调度的总步数。",
                    },
                ),
                "cfg_scale_start": (
                    "FLOAT",
                    {
                        "default": 5.0,
                        "min": 0.0,
                        "max": 30.0,
                        "step": 0.01,
                        "round": 0.01,
                        "display_name": "起始 CFG",
                        "tooltip": "调度范围起点使用的 CFG 值。",
                    },
                ),
                "cfg_scale_end": (
                    "FLOAT",
                    {
                        "default": 5.0,
                        "min": 0.0,
                        "max": 30.0,
                        "step": 0.01,
                        "round": 0.01,
                        "display_name": "结束 CFG",
                        "tooltip": "调度范围终点使用的 CFG 值。",
                    },
                ),
                "interpolation": (
                    ["linear", "ease_in", "ease_out"],
                    {
                        "default": "linear",
                        "display_name": "插值方式",
                        "tooltip": "linear 为线性；ease_in 前段变化慢；ease_out 后段变化慢。",
                    },
                ),
                "start_percent": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "round": 0.01,
                        "display_name": "起始百分比",
                        "tooltip": "从总步数的哪个百分比位置开始应用 CFG 调度。",
                    },
                ),
                "end_percent": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "round": 0.01,
                        "display_name": "结束百分比",
                        "tooltip": "到总步数的哪个百分比位置结束 CFG 调度。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("CFG列表",)
    OUTPUT_TOOLTIPS = ("每一步使用的 CFG 浮点列表；调度范围外为 1.0。",)
    FUNCTION = "process"
    CATEGORY = "GJJ/视频模型/WanVideo"
    DESCRIPTION = "GJJ 零依赖复刻 CreateCFGScheduleFloatList：生成 WanVideo Sampler 可用的逐步 CFG 浮点列表。"
    SEARCH_ALIASES = [
        "CreateCFGScheduleFloatList",
        "Create CFG Schedule Float List",
        "CFG Schedule",
        "cfg float list",
        "WanVideo CFG",
        "CFG调度",
    ]
    GJJ_HELP = {
        "title": "CFG 调度浮点列表",
        "description": "按 WanVideoWrapper 原版 CreateCFGScheduleFloatList 逻辑生成逐步 CFG 列表；范围外固定为 1.0。",
        "notes": [
            "linear、ease_in、ease_out 三种插值与原版一致。",
            "输出类型保持 FLOAT，实际值是 float list，可接入支持逐步 CFG 列表的 WanVideo 采样输入。",
            "本节点不依赖 WanVideoWrapper 插件或第三方 pip 库。",
        ],
    }

    def process(
        self,
        steps: int,
        cfg_scale_start: float,
        cfg_scale_end: float,
        interpolation: str,
        start_percent: float,
        end_percent: float,
        unique_id=None,
    ):
        cfg_list = [1.0] * int(steps)
        start_idx = min(int(steps * start_percent), steps - 1)
        end_idx = min(int(steps * end_percent), steps - 1)

        for i in range(start_idx, end_idx + 1):
            if i >= steps:
                break

            if end_idx == start_idx:
                t = 0
            else:
                t = (i - start_idx) / (end_idx - start_idx)

            if interpolation == "linear":
                factor = t
            elif interpolation == "ease_in":
                factor = t * t
            elif interpolation == "ease_out":
                factor = t * (2 - t)
            else:
                raise RuntimeError(f"未知插值方式：{interpolation}")

            cfg_list[i] = round(cfg_scale_start + factor * (cfg_scale_end - cfg_scale_start), 2)

        if start_percent > 0:
            cfg_list[0] = 1.0

        if unique_id:
            try:
                from server import PromptServer

                server = getattr(PromptServer, "instance", None)
                if server is not None:
                    server.send_progress_text(f"{cfg_list}", unique_id)
            except Exception:
                pass

        return (cfg_list,)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_CreateCFGScheduleFloatList,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "📈 CFG调度浮点列表",
}
