from __future__ import annotations

import time
from typing import Any

import torch


START_NODE_NAME = "GJJ_QueueLoopStart"
END_NODE_NAME = "GJJ_QueueLoopEnd"
STATE_TYPE = "GJJ_QUEUE_LOOP_STATE"
MAX_INT = 0xFFFFFFFFFFFFFFFF

_LOOP_STATE: dict[str, dict[str, Any]] = {}


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "on", "启用", "是"}:
            return True
        if text in {"0", "false", "no", "off", "关闭", "否"}:
            return False
    return default


def _as_int(value: Any, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
    if isinstance(value, bool):
        result = default
    else:
        try:
            result = int(value)
        except (TypeError, ValueError):
            result = default
    if min_value is not None:
        result = max(min_value, result)
    if max_value is not None:
        result = min(max_value, result)
    return result


def _loop_key(loop_key: Any, unique_id: Any) -> str:
    text = str(loop_key or "").strip()
    if text:
        return text
    if unique_id is not None:
        return f"node:{unique_id}"
    return "default"


def _as_image_batch(value: Any, label: str) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise RuntimeError(f"{label} 必须是 IMAGE 图像批次。")
    if value.ndim == 3:
        value = value.unsqueeze(0)
    if value.ndim != 4:
        raise RuntimeError(f"{label} 维度不正确，应为 IMAGE 或 IMAGE batch。")
    if int(value.shape[0]) <= 0:
        raise RuntimeError(f"{label} 为空。")
    return value.detach().cpu().float().contiguous()


def _tail_frames(images: torch.Tensor, count: int) -> torch.Tensor:
    count = max(1, min(int(count), int(images.shape[0])))
    return images[-count:].detach().cpu().contiguous()


def _trim_head(images: torch.Tensor, count: int) -> torch.Tensor:
    count = max(0, int(count))
    if count <= 0 or int(images.shape[0]) <= count:
        return images
    return images[count:].contiguous()


def _merge_batches(left: torch.Tensor | None, right: torch.Tensor) -> torch.Tensor:
    if left is None or int(left.shape[0]) <= 0:
        return right.detach().cpu().contiguous()
    if tuple(left.shape[1:]) != tuple(right.shape[1:]):
        raise RuntimeError(
            f"累计帧尺寸不一致：已有 {tuple(left.shape[1:])}，本轮 {tuple(right.shape[1:])}。"
        )
    return torch.cat((left.detach().cpu(), right.detach().cpu()), dim=0).contiguous()


class GJJ_QueueLoopStart:
    CATEGORY = "GJJ/流程控制"
    FUNCTION = "start"
    RETURN_TYPES = ("IMAGE", STATE_TYPE, "INT", "BOOLEAN", "STRING")
    RETURN_NAMES = ("本轮输入图像", "循环状态", "当前轮次", "是否第一轮", "状态")
    OUTPUT_TOOLTIPS = (
        "本轮生成要使用的图像：第一轮为初始图像，后续轮次为上一轮保存的反馈帧。",
        "传给 GJJ 队列循环结束节点的内部状态。",
        "当前循环轮次，从 1 开始。",
        "当前是否为第一轮。",
        "当前循环状态文本。",
    )
    DESCRIPTION = "队列循环开始：读取上一轮反馈帧作为本轮输入，配合队列循环结束节点自动排队执行下一轮。"
    SEARCH_ALIASES = ["queue loop start", "loop start", "feedback loop", "队列循环", "循环开始", "尾帧续接"]
    GJJ_HELP = {
        "title": "队列循环开始",
        "description": "用队列多次执行同一工作流，避免在 ComfyUI 图中直接画回路。第一轮输出初始图像，后续轮次输出上一轮结束节点保存的反馈帧。",
        "usage": [
            "本节点放在工作流开头，输出“本轮输入图像”接到后续图生视频/续帧链路。",
            "把“循环状态”接到 GJJ · 🧷 队列循环结束。",
            "循环总轮数包含第一轮；例如填 5 表示总共执行 5 次队列。",
            "前端按钮“初始化循环”会递增重置令牌，让下一次执行从初始图像重新开始。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "enabled": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "启用队列循环",
                        "tooltip": "开启后，结束节点会在每轮完成后自动把工作流再次加入队列，直到达到循环总轮数。",
                    },
                ),
                "initial_images": (
                    "IMAGE",
                    {
                        "display_name": "初始图像",
                        "tooltip": "第一轮使用的输入图像或图像批次。",
                    },
                ),
                "total_loops": (
                    "INT",
                    {
                        "default": 3,
                        "min": 1,
                        "max": 10000,
                        "step": 1,
                        "display_name": "循环总轮数",
                        "tooltip": "总执行轮数，包含第一轮。",
                    },
                ),
                "loop_key": (
                    "STRING",
                    {
                        "default": "longcat_loop",
                        "multiline": False,
                        "display_name": "循环名称",
                        "tooltip": "同一组开始/结束节点使用同一个名称；留空时使用节点 ID。",
                    },
                ),
                "reset_token": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": MAX_INT,
                        "step": 1,
                        "display_name": "重置令牌",
                        "tooltip": "前端“初始化循环”按钮会自动递增；数值变化后从第一轮重新开始。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return time.time_ns()

    def start(self, enabled, initial_images, total_loops, loop_key, reset_token, unique_id=None):
        images = _as_image_batch(initial_images, "初始图像")
        enabled = _as_bool(enabled, False)
        total = _as_int(total_loops, 1, min_value=1, max_value=10000)
        reset = _as_int(reset_token, 0, min_value=0, max_value=MAX_INT)
        key = _loop_key(loop_key, unique_id)

        state = _LOOP_STATE.get(key)
        if (
            state is None
            or state.get("reset_token") != reset
            or state.get("finished")
            or not enabled
        ):
            state = {
                "round": 1,
                "feedback": None,
                "accumulated": None,
                "reset_token": reset,
                "finished": False,
            }
            _LOOP_STATE[key] = state

        current = _as_int(state.get("round"), 1, min_value=1, max_value=total)
        feedback = state.get("feedback")
        use_feedback = enabled and current > 1 and isinstance(feedback, torch.Tensor)
        source = feedback.detach().cpu().contiguous() if use_feedback else images
        is_first = current <= 1
        should_continue = bool(enabled and current < total)
        status = (
            f"第 {current}/{total} 轮：使用上一轮反馈帧"
            if use_feedback
            else f"第 {current}/{total} 轮：使用初始图像"
        )
        if not enabled:
            status = "队列循环未启用：输出初始图像，不自动排队"

        loop_state = {
            "enabled": enabled,
            "key": key,
            "start_node_id": str(unique_id or ""),
            "current_round": current,
            "total_loops": total,
            "reset_token": reset,
            "should_continue": should_continue,
            "status": status,
        }

        return {
            "ui": {
                "gjj_queue_loop_start": [loop_state],
            },
            "result": (source, loop_state, current, is_first, status),
        }


class GJJ_QueueLoopEnd:
    CATEGORY = "GJJ/流程控制"
    FUNCTION = "finish"
    OUTPUT_NODE = True
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "INT", "BOOLEAN", "STRING")
    RETURN_NAMES = ("本轮输出图像", "累计输出图像", "下轮反馈帧", "当前轮次", "是否继续", "状态")
    OUTPUT_TOOLTIPS = (
        "本轮生成的完整图像批次。",
        "跨队列累计后的图像批次；开启去除重叠时，第二轮起会删除每轮开头的反馈帧再追加。",
        "保存给下一轮使用的尾部反馈帧。",
        "当前完成的轮次。",
        "本轮结束后是否还会自动排队下一轮。",
        "当前循环状态文本。",
    )
    DESCRIPTION = "队列循环结束：保存本轮尾帧，累计输出帧，并在前端执行成功后自动排队下一轮。"
    SEARCH_ALIASES = ["queue loop end", "loop end", "auto queue", "feedback loop", "队列循环", "循环结束", "尾帧续接"]
    GJJ_HELP = {
        "title": "队列循环结束",
        "description": "放在工作流尾部，接收本轮输出帧，保存最后 N 帧给下一次队列执行，并通知前端继续排队。",
        "usage": [
            "循环状态接 GJJ · 🧵 队列循环开始 的“循环状态”。",
            "本轮输出图像接视频解码后的 IMAGE 批次。",
            "反馈帧数量填 13 时，会把本轮最后 13 帧作为下一轮输入。",
            "如果你已经用其它节点截好了尾帧，可接入“自定义反馈帧”。",
            "累计输出图像可接预览或视频合成；长视频会占用内存，必要时关闭“累计输出”。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "loop_state": (
                    STATE_TYPE,
                    {
                        "display_name": "循环状态",
                        "tooltip": "连接 GJJ · 🧵 队列循环开始 的循环状态输出。",
                    },
                ),
                "output_images": (
                    "IMAGE",
                    {
                        "display_name": "本轮输出图像",
                        "tooltip": "本轮生成并解码后的 IMAGE 批次。",
                    },
                ),
                "feedback_count": (
                    "INT",
                    {
                        "default": 13,
                        "min": 1,
                        "max": 4096,
                        "step": 1,
                        "display_name": "反馈帧数量",
                        "tooltip": "从本轮输出尾部取多少帧保存给下一轮；LongCat/Wan 常用 13。",
                    },
                ),
                "accumulate_output": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "累计输出",
                        "tooltip": "开启后跨队列保存并输出累计帧；长视频会占用内存。",
                    },
                ),
                "trim_overlap_from_append": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "追加时去除重叠",
                        "tooltip": "第二轮起追加到累计输出时，删除本轮开头的反馈帧，避免重复 13 帧。",
                    },
                ),
                "queue_delay_ms": (
                    "INT",
                    {
                        "default": 800,
                        "min": 0,
                        "max": 60000,
                        "step": 100,
                        "display_name": "排队延迟ms",
                        "tooltip": "每轮执行成功后等待多久再自动加入下一次队列。",
                    },
                ),
            },
            "optional": {
                "feedback_images": (
                    "IMAGE",
                    {
                        "display_name": "自定义反馈帧",
                        "tooltip": "可选。连接后直接用这里的图像作为下一轮输入；不连接时自动取本轮输出最后 N 帧。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return time.time_ns()

    def finish(
        self,
        loop_state,
        output_images,
        feedback_count,
        accumulate_output,
        trim_overlap_from_append,
        queue_delay_ms,
        feedback_images=None,
        unique_id=None,
    ):
        if not isinstance(loop_state, dict):
            output = _as_image_batch(output_images, "本轮输出图像")
            feedback = _tail_frames(output, _as_int(feedback_count, 13, min_value=1))
            status = "循环状态无效：已透传本轮输出，不会自动排队"
            return {
                "ui": {"gjj_queue_loop_scheduler": [{"enabled": False, "should_continue": False, "status": status}]},
                "result": (output, output, feedback, 1, False, status),
            }

        output = _as_image_batch(output_images, "本轮输出图像")
        feedback_n = _as_int(feedback_count, 13, min_value=1, max_value=4096)
        feedback = (
            _as_image_batch(feedback_images, "自定义反馈帧")
            if feedback_images is not None
            else _tail_frames(output, feedback_n)
        )

        key = str(loop_state.get("key") or "")
        if not key:
            status = "循环状态缺少 key，无法保存反馈帧。"
            return {
                "ui": {"gjj_queue_loop_scheduler": [{"enabled": False, "should_continue": False, "status": status}]},
                "result": (output, output, feedback, 1, False, status),
            }

        enabled = _as_bool(loop_state.get("enabled"), False)
        current = _as_int(loop_state.get("current_round"), 1, min_value=1)
        total = _as_int(loop_state.get("total_loops"), 1, min_value=1)
        delay = _as_int(queue_delay_ms, 800, min_value=0, max_value=60000)
        state = _LOOP_STATE.setdefault(key, {})

        append_images = output
        if current > 1 and _as_bool(trim_overlap_from_append, True):
            append_images = _trim_head(output, feedback_n)

        if _as_bool(accumulate_output, True):
            previous = state.get("accumulated")
            accumulated = _merge_batches(previous if isinstance(previous, torch.Tensor) else None, append_images)
        else:
            accumulated = output

        should_continue = bool(enabled and current < total)
        state.update(
            {
                "round": current + 1 if should_continue else current,
                "feedback": feedback.detach().cpu().contiguous(),
                "accumulated": accumulated.detach().cpu().contiguous() if _as_bool(accumulate_output, True) else None,
                "reset_token": loop_state.get("reset_token"),
                "finished": not should_continue,
            }
        )

        if should_continue:
            status = f"第 {current}/{total} 轮完成：已保存 {int(feedback.shape[0])} 帧，准备下一轮"
        else:
            status = f"第 {current}/{total} 轮完成：循环结束"

        ui_payload = {
            "enabled": enabled,
            "key": key,
            "start_node_id": str(loop_state.get("start_node_id") or ""),
            "end_node_id": str(unique_id or ""),
            "current_round": current,
            "next_round": current + 1 if should_continue else current,
            "total_loops": total,
            "feedback_count": int(feedback.shape[0]),
            "accumulated_count": int(accumulated.shape[0]),
            "queue_delay_ms": delay,
            "should_continue": should_continue,
            "status": status,
        }

        return {
            "ui": {
                "gjj_queue_loop_scheduler": [ui_payload],
            },
            "result": (output, accumulated, feedback, current, should_continue, status),
        }


NODE_CLASS_MAPPINGS = {
    START_NODE_NAME: GJJ_QueueLoopStart,
    END_NODE_NAME: GJJ_QueueLoopEnd,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    START_NODE_NAME: "GJJ · 🧵 队列循环开始",
    END_NODE_NAME: "GJJ · 🧷 队列循环结束",
}
