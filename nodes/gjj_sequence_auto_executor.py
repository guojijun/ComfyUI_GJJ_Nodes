from __future__ import annotations


NODE_NAME = "GJJ_SequenceAutoExecutor"
MAX_INT = 0xFFFFFFFFFFFFFFFF


class GJJ_SequenceAutoExecutor:
    CATEGORY = "GJJ"
    FUNCTION = "check"
    OUTPUT_NODE = True
    DESCRIPTION = "根据当前数值和总数量，在前端执行完成后自动继续排队，直到序列结束。"
    SEARCH_ALIASES = ["sequence auto executor", "auto queue", "loop", "序列", "自动执行", "循环", "排队"]
    RETURN_TYPES = ()
    OUTPUT_TOOLTIPS = ()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "enabled": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用自动执行",
                        "tooltip": "启用后，本节点执行完成并判断未到总数量时，会自动再次加入队列。",
                    },
                ),
                "current_value": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": MAX_INT,
                        "step": 1,
                        "display_name": "当前数值",
                        "tooltip": "接入 GJJ · 递增数值 的“递增数值”输出；用于判断本轮从哪个序号开始。",
                    },
                ),
                "total_count": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": MAX_INT,
                        "step": 1,
                        "display_name": "总数量",
                        "tooltip": "序列总数；可接入 GJJ · 文本分行随机选择器 的“文本总行数量”。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(cls, enabled, current_value, total_count):
        return f"{enabled}:{int(current_value)}:{int(total_count)}"

    def check(self, enabled, current_value, total_count):
        current = int(current_value)
        total = max(0, int(total_count))
        should_continue = bool(enabled) and total > 0 and current < total
        status = "已关闭"
        if enabled:
            status = f"本轮 {current}，总数 {total}"
            if not should_continue:
                status = f"本轮 {current} 已到末尾，总数 {total}"

        return {
            "ui": {
                "gjj_sequence_auto_executor": [
                    {
                        "enabled": bool(enabled),
                        "current_value": current,
                        "total_count": total,
                        "should_continue": should_continue,
                        "status": status,
                    }
                ]
            },
            "result": (),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SequenceAutoExecutor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔁 序列自动执行器"}
