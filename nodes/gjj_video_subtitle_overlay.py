from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Any


NODE_NAME = "GJJ_VideoSubtitleOverlay"
NODE_DISPLAY_NAME = "GJJ · 💬 视频字幕添加"
SRT_BLOCK_PATTERN = re.compile(
    r"(?ms)^\s*(?:\d+\s*\n)?"
    r"(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*"
    r"(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})[^\n]*\n"
    r"(.*?)(?=\n\s*\n|\Z)"
)


def _clean_srt(value: Any) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise RuntimeError("字幕 SRT 为空，请连接 GJJ_AudioAceMusicGenerator 的“原歌词SRT”输出。")
    if not re.search(
        r"\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}",
        text,
    ):
        raise RuntimeError("输入文本不是有效 SRT：没有找到字幕时间轴。")
    return text + "\n"


def _ass_color(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", text)
    rgb = match.group(1) if match else fallback.lstrip("#")
    red, green, blue = rgb[0:2], rgb[2:4], rgb[4:6]
    return f"&H00{blue}{green}{red}".upper()


def _escape_filter_path(path: Path) -> str:
    text = path.resolve().as_posix()
    text = text.replace("\\", "\\\\")
    text = text.replace(":", "\\:")
    text = text.replace("'", r"\'")
    text = text.replace(",", r"\,")
    text = text.replace("[", r"\[").replace("]", r"\]")
    return text


def _ass_time(value: str) -> str:
    parts = re.split(r"[:,.]", str(value or "").strip())
    if len(parts) != 4:
        return "0:00:00.00"
    hours, minutes, seconds, millis = (int(part) for part in parts)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{millis // 10:02d}"


def _srt_time_millis(value: str) -> int:
    parts = re.split(r"[:,.]", str(value or "").strip())
    if len(parts) != 4:
        return 0
    hours, minutes, seconds, millis = (int(part) for part in parts)
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def _millis_to_srt_time(value: int) -> str:
    total = max(0, int(value))
    hours, remainder = divmod(total, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def _extend_subtitle_ends(srt_text: str, video_duration: float) -> str:
    cues = [
        {
            "start": _srt_time_millis(match.group(1)),
            "end": _srt_time_millis(match.group(2)),
            "text": match.group(3).strip(),
        }
        for match in SRT_BLOCK_PATTERN.finditer(srt_text.strip())
        if match.group(3).strip()
    ]
    if not cues:
        return srt_text
    video_end = max(0, int(round(float(video_duration or 0.0) * 1000.0)))
    blocks: list[str] = []
    for index, cue in enumerate(cues):
        end = max(int(cue["start"]) + 10, int(cue["end"]))
        if index + 1 < len(cues):
            next_start = int(cues[index + 1]["start"])
            if next_start > int(cue["start"]):
                end = next_start
        elif video_end > int(cue["start"]):
            end = min(video_end, end + 1500)
        blocks.append(
            f"{index + 1}\n"
            f"{_millis_to_srt_time(int(cue['start']))} --> {_millis_to_srt_time(end)}\n"
            f"{cue['text']}"
        )
    return "\n\n".join(blocks) + "\n"


def _srt_to_ass(
    srt_text: str,
    width: int,
    height: int,
    font_name: str,
    font_size: int,
    font_color: str,
    outline_color: str,
    outline_width: float,
    bottom_margin: int,
) -> str:
    events: list[str] = []
    for match in SRT_BLOCK_PATTERN.finditer(srt_text.strip()):
        text = match.group(3).strip().replace("\\", r"\\")
        text = text.replace("{", r"\{").replace("}", r"\}")
        text = r"\N".join(line.strip() for line in text.splitlines() if line.strip())
        if text:
            events.append(
                f"Dialogue: 0,{_ass_time(match.group(1))},{_ass_time(match.group(2))},"
                f"Default,,0,0,0,,{text}"
            )
    if not events:
        raise RuntimeError("SRT 没有解析出可烧录的字幕段落。")
    style = (
        f"Style: Default,{font_name},{font_size},{font_color},&H000000FF,"
        f"{outline_color},&H00000000,0,0,0,0,100,100,0,0,1,"
        f"{outline_width:g},0,2,20,20,{bottom_margin},1"
    )
    return "\n".join([
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {int(width)}",
        f"PlayResY: {int(height)}",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,"
        "Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,"
        "Alignment,MarginL,MarginR,MarginV,Encoding",
        style,
        "",
        "[Events]",
        "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
        *events,
        "",
    ])


def _video_from_file(path: Path):
    """Create an official VIDEO object across ComfyUI API layouts."""
    errors: list[str] = []
    try:
        from comfy_api.latest import InputImpl

        return InputImpl.VideoFromFile(str(path))
    except Exception as exc:
        errors.append(f"comfy_api.latest: {exc}")
    try:
        from comfy_api.input_impl import InputImpl

        return InputImpl.VideoFromFile(str(path))
    except Exception as exc:
        errors.append(f"comfy_api.input_impl: {exc}")
    raise RuntimeError(
        "字幕视频已经保存，但当前 ComfyUI 无法构建 VIDEO 输出对象："
        + "；".join(errors)
    )


def _resolve_or_materialize_video(video: Any, suffixes: set[str]) -> tuple[Path, Path | None]:
    """Resolve file-backed VIDEO objects or temporarily encode in-memory VIDEO objects."""
    from .gjj_ffmpeg_tools import _resolve_media_path

    source_path = _resolve_media_path(video, suffixes)
    if source_path is not None:
        return source_path, None
    save_to = getattr(video, "save_to", None)
    if not callable(save_to):
        raise RuntimeError("无法读取输入 VIDEO：对象既没有源文件路径，也不支持 save_to()。")
    file_descriptor, temporary_name = tempfile.mkstemp(prefix="gjj_subtitle_source_", suffix=".mp4")
    os.close(file_descriptor)
    temporary_path = Path(temporary_name)
    try:
        save_to(str(temporary_path))
        if not temporary_path.is_file() or temporary_path.stat().st_size <= 0:
            raise RuntimeError("VIDEO 临时保存后文件为空。")
        return temporary_path.resolve(), temporary_path
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


class GJJ_VideoSubtitleOverlay:
    CATEGORY = "GJJ/视频/字幕"
    FUNCTION = "add_subtitles"
    OUTPUT_NODE = True
    DESCRIPTION = "将 SRT 按时间轴烧录到 VIDEO，生成带描边字幕的视频，并在视频旁保存完全同名的 SRT 文件。"
    SEARCH_ALIASES = [
        "字幕添加",
        "字幕烧录",
        "视频字幕",
        "SRT字幕",
        "subtitle overlay",
        "burn subtitles",
    ]
    RETURN_TYPES = ("VIDEO", "STRING", "STRING")
    RETURN_NAMES = ("字幕视频", "同名SRT", "保存路径")
    OUTPUT_TOOLTIPS = (
        "按 SRT 时间段烧录带描边字幕后的视频。",
        "原样输出的 SRT 文本，方便继续连接其他节点。",
        "已保存字幕视频的绝对路径；旁边同时保存同名 .srt。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": (
                    "VIDEO",
                    {
                        "display_name": "输入视频",
                        "tooltip": "连接 GJJ_VideoBackgroundAudioOverlay 的视频输出。",
                    },
                ),
                "srt": (
                    "STRING",
                    {
                        "forceInput": True,
                        "multiline": True,
                        "display_name": "字幕 SRT",
                        "tooltip": "连接 GJJ_AudioAceMusicGenerator 的“原歌词SRT”输出。",
                    },
                ),
                "filename_prefix": (
                    "STRING",
                    {
                        "default": "GJJ/字幕视频",
                        "display_name": "保存文件名前缀",
                        "tooltip": "保存到 ComfyUI output 目录；MP4 与 SRT 使用相同文件名主体。",
                    },
                ),
                "font_name": (
                    "STRING",
                    {
                        "default": "Microsoft YaHei",
                        "display_name": "字幕字体",
                    },
                ),
                "font_size": (
                    "INT",
                    {
                        "default": 48,
                        "min": 12,
                        "max": 160,
                        "step": 1,
                        "display_name": "旧版字幕字号",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "font_color": (
                    "STRING",
                    {
                        "default": "#FFFFFF",
                        "display_name": "字幕颜色",
                        "tooltip": "使用 #RRGGBB 格式。",
                    },
                ),
                "outline_color": (
                    "STRING",
                    {
                        "default": "#000000",
                        "display_name": "描边颜色",
                        "tooltip": "使用 #RRGGBB 格式。",
                    },
                ),
                "outline_width": (
                    "FLOAT",
                    {
                        "default": 3.0,
                        "min": 0.0,
                        "max": 12.0,
                        "step": 0.25,
                        "display_name": "旧版描边宽度",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "bottom_margin": (
                    "INT",
                    {
                        "default": 60,
                        "min": 0,
                        "max": 500,
                        "step": 1,
                        "display_name": "旧版底部边距",
                        "hidden": True,
                        "display": "hidden",
                        "advanced": True,
                    },
                ),
                "font_size_percent": (
                    "FLOAT",
                    {
                        "default": 5.0,
                        "min": 0.5,
                        "max": 20.0,
                        "step": 0.1,
                        "display_name": "字幕尺寸（画面高度%）",
                        "tooltip": "字幕字号按视频高度自动换算；不同分辨率的视频保持相近视觉比例。",
                    },
                ),
                "bottom_margin_percent": (
                    "FLOAT",
                    {
                        "default": 8.0,
                        "min": 0.0,
                        "max": 50.0,
                        "step": 0.1,
                        "display_name": "字幕距底部（画面高度%）",
                        "tooltip": "字幕基线与视频底边的距离，按画面高度百分比计算。",
                    },
                ),
                "outline_width_percent": (
                    "FLOAT",
                    {
                        "default": 6.0,
                        "min": 0.0,
                        "max": 30.0,
                        "step": 0.25,
                        "display_name": "描边宽度（字号%）",
                        "tooltip": "描边宽度按换算后的字幕字号计算，随视频分辨率同步缩放。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def add_subtitles(
        self,
        video,
        srt,
        filename_prefix="GJJ/字幕视频",
        font_name="Microsoft YaHei",
        font_size=48,
        font_color="#FFFFFF",
        outline_color="#000000",
        outline_width=3.0,
        bottom_margin=60,
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
        font_size_percent=5.0,
        bottom_margin_percent=8.0,
        outline_width_percent=6.0,
    ):
        from .gjj_ffmpeg_tools import (
            VIDEO_SUFFIXES,
            _ffmpeg,
            _ffprobe,
            _preview_item,
            _run,
            _safe_output_info,
            _unique_output_path,
        )
        from .gjj_video_combine_runtime import _render_filename_prefix_template

        subtitle_text = _clean_srt(srt)
        source_path, temporary_source_path = _resolve_or_materialize_video(video, VIDEO_SUFFIXES)
        ffmpeg_path = _ffmpeg("")
        ffprobe_path = _ffprobe("", ffmpeg_path)
        _, video_width, video_height, _, _, video_duration, _ = _safe_output_info(
            source_path,
            ffprobe_path,
            24.0,
        )
        subtitle_text = _extend_subtitle_ends(subtitle_text, video_duration)
        if int(video_height) <= 0:
            raise RuntimeError("无法读取输入视频高度，不能按百分比计算字幕尺寸与位置。")
        resolved_font_size = max(
            8,
            min(512, int(round(int(video_height) * max(0.5, min(20.0, float(font_size_percent))) / 100.0))),
        )
        resolved_bottom_margin = max(
            0,
            min(int(video_height), int(round(int(video_height) * max(0.0, min(50.0, float(bottom_margin_percent))) / 100.0))),
        )
        resolved_outline_width = max(
            0.0,
            min(32.0, resolved_font_size * max(0.0, min(30.0, float(outline_width_percent))) / 100.0),
        )

        rendered_prefix = _render_filename_prefix_template(
            str(filename_prefix or "GJJ/字幕视频"),
            prompt,
            extra_pnginfo=extra_pnginfo,
        )
        output_path = _unique_output_path(rendered_prefix, ".mp4", marker="Subtitle")
        srt_path = output_path.with_suffix(".srt")
        ass_path = output_path.with_suffix(".subtitle.ass")
        srt_path.write_text(subtitle_text, encoding="utf-8-sig")

        safe_font_name = str(font_name or "Microsoft YaHei").replace(",", " ").replace("'", " ").strip()
        ass_path.write_text(
            _srt_to_ass(
                subtitle_text,
                int(video_width),
                int(video_height),
                safe_font_name,
                resolved_font_size,
                _ass_color(font_color, "#FFFFFF"),
                _ass_color(outline_color, "#000000"),
                resolved_outline_width,
                resolved_bottom_margin,
            ),
            encoding="utf-8-sig",
        )
        subtitle_filter = f"ass=filename='{_escape_filter_path(ass_path)}'"
        command = [
            ffmpeg_path,
            "-y",
            "-i",
            str(source_path),
            "-vf",
            subtitle_filter,
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        try:
            _run(command)
        except Exception:
            output_path.unlink(missing_ok=True)
            srt_path.unlink(missing_ok=True)
            raise
        finally:
            ass_path.unlink(missing_ok=True)
            if temporary_source_path is not None:
                temporary_source_path.unlink(missing_ok=True)

        preview = _preview_item(output_path, "output", "video/mp4")
        return {
            "ui": {
                "preview_media": [preview],
                "preview_is_video": [True],
                "text": [
                    f"字幕添加完成：{output_path.name}\n"
                    f"同名字幕：{srt_path.name}\n"
                    f"视频尺寸：{video_width}×{video_height}；字幕字号：{resolved_font_size}px；"
                    f"距底部：{resolved_bottom_margin}px；描边：{resolved_outline_width:g}px"
                ],
            },
            "result": (
                _video_from_file(output_path),
                subtitle_text,
                str(output_path),
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoSubtitleOverlay}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
