from __future__ import annotations


NODE_NAME = "GJJ_IncrementingInteger"
MAX_INT = 0xFFFFFFFFFFFFFFFF
RANGE_FORMATS = ["切片 [起始:结束]", "数组 [起始,起始+1]"]


class GJJ_IncrementingInteger:
    CATEGORY = "GJJ"
    FUNCTION = "output"
    DESCRIPTION = "输出一个可链接到多个随机种子或序列切片插槽的数值，并默认在每次生成后按“数量”推进到下一段。"
    SEARCH_ALIASES = ["incrementing integer", "increment value", "increment seed", "seed", "递增", "数值", "整数", "种子", "随机", "切片"]
    RETURN_TYPES = ("INT", "STRING")
    RETURN_NAMES = ("递增数值", "序列范围")
    OUTPUT_TOOLTIPS = (
        "当前递增数值；可同时连接到多个 INT 类型的随机种子或序列起点输入。",
        "按数量生成的序列表达式；可输出闭区间切片语法如 [1:2]，或数组语法如 [1,2]。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": MAX_INT,
                        "step": 1,
                        "control_after_generate": True,
                        "display_name": "起始数值",
                        "tooltip": "本次输出的数值；默认生成完成后会按“数量”推进到下一段，适合统一控制多个随机种子或序列起点插槽。",
                    },
                ),
                "count": (
                    "INT",
                    {
                        "default": 2,
                        "min": 0,
                        "max": MAX_INT,
                        "step": 1,
                        "display_name": "数量",
                        "tooltip": "需要连续取用的数量；第二个输出会按这个数量生成数组或闭区间范围，前端会按该数量推进下一轮起点。",
                    },
                ),
                "wrap_max": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": MAX_INT,
                        "step": 1,
                        "display_name": "循环最大编号",
                        "tooltip": "0 表示不循环；填入序列总数后，到达最大编号会从 1 继续，例如最大 6、起始 6、数量 2 输出 [6,1]。",
                    },
                ),
                "range_format": (
                    RANGE_FORMATS,
                    {
                        "default": RANGE_FORMATS[0],
                        "display_name": "范围格式",
                        "tooltip": "切片格式输出闭区间 [起始:结束]；数组格式输出实际序列，如起始 1、数量 2 时输出 [1,2]；可直接接入批量多图片加载预览器的“序列范围”。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(cls, value, count, wrap_max, range_format):
        return f"{int(value)}:{int(count)}:{int(wrap_max)}:{range_format}"

    def output(self, value: int, count: int, wrap_max: int, range_format: str):
        start_value = int(value)
        safe_count = max(0, int(count))
        safe_wrap_max = max(0, int(wrap_max))
        if safe_count <= 0:
            return (start_value, "[]")

        if safe_wrap_max > 0:
            normalized_start = ((max(1, start_value) - 1) % safe_wrap_max) + 1
            values = [((normalized_start + index - 1) % safe_wrap_max) + 1 for index in range(safe_count)]
            crosses_tail = any(values[index] <= values[index - 1] for index in range(1, len(values)))
            if str(range_format) == RANGE_FORMATS[1] or crosses_tail:
                return (start_value, f"[{','.join(str(item) for item in values)}]")
            return (start_value, f"[{values[0]}:{values[-1]}]")

        end_value = min(MAX_INT, start_value + safe_count - 1)
        if str(range_format) == RANGE_FORMATS[1]:
            sequence = ",".join(str(item) for item in range(start_value, end_value + 1))
            return (start_value, f"[{sequence}]")
        range_text = f"[{start_value}:{end_value}]"
        return (start_value, range_text)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_IncrementingInteger}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔢 递增数值"}
