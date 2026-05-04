from __future__ import annotations

import re
from typing import Any


NODE_NAME = "GJJ_QwenTimestampToPromptRelay"

TIMESTAMP_LINE_RE = re.compile(
    r"^\s*[\[\(<]?\s*([0-9]+(?:\.[0-9]+)?)\s*s?\s*[-–—~至到]\s*([0-9]+(?:\.[0-9]+)?)\s*s?\s*[\]\)>]?\s*(.*)$",
    re.IGNORECASE,
)

DEFAULT_SPEECH_TEMPLATE = "说：“{text}”，口型与当前语音同步，嘴部开合自然准确。"
DEFAULT_GAP_PROMPT = "短暂停顿，嘴巴自然闭合，保持表情和姿态稳定。"


def _safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)


def _format_seconds(value: float) -> str:
    text = f"{float(value):.3f}".rstrip("0").rstrip(".")
    return text or "0"


def _apply_template(template: str, text: str) -> str:
    body = str(text or "").strip()
    prompt_template = str(template or "").strip() or "{text}"
    if "{text}" in prompt_template:
        return prompt_template.replace("{text}", body).strip()
    return f"{prompt_template}{body}".strip()


def _parse_timestamp_lines(timestamp_table: str) -> list[tuple[float, float, str]]:
    entries: list[tuple[float, float, str]] = []
    for raw_line in str(timestamp_table or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        match = TIMESTAMP_LINE_RE.match(line)
        if not match:
            continue
        start = _safe_float(match.group(1), 0.0)
        end = _safe_float(match.group(2), start)
        if end < start:
            start, end = end, start
        body = str(match.group(3) or "").strip()
        entries.append((start, end, body))
    entries.sort(key=lambda item: (item[0], item[1]))
    return entries


class GJJ_QwenTimestampToPromptRelay:
    CATEGORY = "GJJ/视频"
    FUNCTION = "convert"
    DESCRIPTION = "把 Qwen3-ASR 的 [开始s-结束s] 时间戳表转换为 PromptRelay 可用的 | 分段局部提示词和逐段帧数。"
    SEARCH_ALIASES = ["qwen timestamp relay", "asr prompt relay", "时间戳转中继", "口型同步"]
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("局部提示词", "分段帧数", "调试预览")
    OUTPUT_TOOLTIPS = (
        "用 | 分隔的 PromptRelay 局部提示词。",
        "按 fps 换算后的像素帧数，和局部提示词段数一一对应。",
        "便于核对每段起止时间、帧数和提示词的预览文本。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "timestamp_table": (
                    "STRING",
                    {
                        "forceInput": True,
                        "multiline": True,
                        "display_name": "时间戳表",
                        "tooltip": "连接 Qwen3 语音识别四文本节点的时间戳表输出，每行形如 [0.4s-2.9s] 台词。",
                    },
                ),
                "fps": (
                    "FLOAT",
                    {
                        "default": 25.0,
                        "min": 1.0,
                        "max": 120.0,
                        "step": 0.01,
                        "display_name": "帧率",
                        "tooltip": "用于把秒级时间戳换算成 PromptRelay 的像素帧数。",
                    },
                ),
                "speech_template": (
                    "STRING",
                    {
                        "default": DEFAULT_SPEECH_TEMPLATE,
                        "multiline": True,
                        "display_name": "说话段模板",
                        "tooltip": "每个台词段使用的提示词模板，{text} 会替换为识别文本。",
                    },
                ),
                "gap_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_GAP_PROMPT,
                        "multiline": True,
                        "display_name": "停顿段提示",
                        "tooltip": "时间戳之间存在空隙时插入的提示词，用于让嘴巴自然闭合。",
                    },
                ),
                "min_gap_seconds": (
                    "FLOAT",
                    {
                        "default": 0.08,
                        "min": 0.0,
                        "max": 5.0,
                        "step": 0.01,
                        "display_name": "最小停顿秒数",
                        "tooltip": "只有大于该时长的时间空隙才会生成停顿段。",
                    },
                ),
            }
        }

    def convert(self, timestamp_table, fps, speech_template, gap_prompt, min_gap_seconds):
        resolved_fps = max(1.0, _safe_float(fps, 25.0))
        min_gap = max(0.0, _safe_float(min_gap_seconds, 0.08))
        entries = _parse_timestamp_lines(timestamp_table)

        if not entries:
            lines = [
                line.strip()
                for line in str(timestamp_table or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
                if line.strip()
            ]
            local_prompts = " | ".join(lines)
            return (local_prompts, "", "未解析到时间戳，已退回为普通 | 分段。")

        prompts: list[str] = []
        lengths: list[int] = []
        preview_lines: list[str] = []
        cursor = 0.0

        for start, end, text in entries:
            if start > cursor + min_gap:
                gap_frames = max(1, int(round((start - cursor) * resolved_fps)))
                gap_text = str(gap_prompt or DEFAULT_GAP_PROMPT).strip()
                prompts.append(gap_text)
                lengths.append(gap_frames)
                preview_lines.append(
                    f"{len(prompts):02d} {_format_seconds(cursor)}s-{_format_seconds(start)}s {gap_frames}f | {gap_text}"
                )

            duration = max(1.0 / resolved_fps, end - start)
            speech_frames = max(1, int(round(duration * resolved_fps)))
            speech_text = _apply_template(str(speech_template or DEFAULT_SPEECH_TEMPLATE), text)
            prompts.append(speech_text)
            lengths.append(speech_frames)
            preview_lines.append(
                f"{len(prompts):02d} {_format_seconds(start)}s-{_format_seconds(end)}s {speech_frames}f | {speech_text}"
            )
            cursor = max(cursor, end)

        return (" | ".join(prompts), ",".join(str(item) for item in lengths), "\n".join(preview_lines))


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_QwenTimestampToPromptRelay}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ⏱️ Qwen时间戳转PromptRelay"}
