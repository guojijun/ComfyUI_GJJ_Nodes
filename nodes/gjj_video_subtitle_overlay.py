from __future__ import annotations

import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any


NODE_NAME = "GJJ_VideoSubtitleOverlay"
NODE_DISPLAY_NAME = "GJJ · 💬 视频字幕添加"
_FONT_CANDIDATE_CACHE: list[dict[str, str]] = []
_FONT_CANDIDATE_CACHE_TIME = 0.0
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


def _hidden_options(options: dict[str, Any]) -> dict[str, Any]:
    return {
        **options,
        "hidden": True,
        "display": "hidden",
        "advanced": True,
    }


def _font_file_candidates(refresh: bool = False) -> list[dict[str, str]]:
    global _FONT_CANDIDATE_CACHE, _FONT_CANDIDATE_CACHE_TIME
    if not refresh and _FONT_CANDIDATE_CACHE and time.time() - _FONT_CANDIDATE_CACHE_TIME < 60.0:
        return _FONT_CANDIDATE_CACHE
    results: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(path: Path, source: str, value: str | None = None) -> None:
        try:
            resolved = path.resolve()
        except Exception:
            resolved = path
        key = str(resolved).lower()
        if key in seen or not resolved.is_file() or resolved.suffix.lower() not in {".ttf", ".ttc", ".otf", ".otc"}:
            return
        seen.add(key)
        results.append({
            "name": resolved.name,
            "family": resolved.stem,
            "path": str(resolved),
            "source": source,
            "value": str(value or resolved),
        })

    try:
        import folder_paths

        for name in folder_paths.get_filename_list("fonts"):
            try:
                full_path = folder_paths.get_full_path("fonts", name)
            except Exception:
                full_path = None
            if full_path:
                add(Path(full_path), "models/fonts", str(name))
    except Exception:
        pass

    system_roots: list[Path] = []
    if os.name == "nt":
        system_roots.append(Path(os.environ.get("WINDIR", "C:\\Windows")) / "Fonts")
    elif os.sys.platform == "darwin":
        system_roots.extend([Path("/System/Library/Fonts"), Path("/Library/Fonts"), Path.home() / "Library/Fonts"])
    else:
        system_roots.extend([Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts"])
    for root in system_roots:
        if not root.is_dir():
            continue
        try:
            for path in root.rglob("*"):
                add(path, "系统字体")
        except Exception:
            continue
    _FONT_CANDIDATE_CACHE = sorted(results, key=lambda item: (item["source"] != "models/fonts", item["name"].lower()))
    _FONT_CANDIDATE_CACHE_TIME = time.time()
    return _FONT_CANDIDATE_CACHE


def _resolve_font_selection(value: Any) -> tuple[str, Path | None]:
    text = str(value or "").strip()
    if not text:
        return "Microsoft YaHei", None
    direct = Path(os.path.expandvars(os.path.expanduser(text)))
    if direct.is_file():
        family = direct.stem
        try:
            from PIL import ImageFont

            family = str(ImageFont.truetype(str(direct), 12).getname()[0] or family)
        except Exception:
            pass
        return family, direct.resolve().parent
    for item in _font_file_candidates():
        if text in {item["value"], item["name"], item["path"]}:
            return item["family"], Path(item["path"]).parent
    return text, None


def _unique_custom_output_path(directory: Any, filename_prefix: Any, suffix: str) -> Path:
    folder = Path(os.path.expandvars(os.path.expanduser(str(directory or "").strip()))).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    stem = Path(str(filename_prefix or "字幕视频").replace("\\", "/")).name.strip() or "字幕视频"
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", stem).strip(" .") or "字幕视频"
    stamp = time.strftime("%Y%m%d_%H%M%S")
    candidate = folder / f"Subtitle_{stem}_{stamp}{suffix}"
    index = 1
    while candidate.exists():
        candidate = folder / f"Subtitle_{stem}_{stamp}_{index:03d}{suffix}"
        index += 1
    return candidate


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
    CATEGORY = "GJJ/🎬 视频/字幕"
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
                    _hidden_options({
                        "default": "GJJ/字幕视频",
                        "display_name": "保存文件名前缀",
                        "tooltip": "保存到 ComfyUI output 目录；MP4 与 SRT 使用相同文件名主体。",
                    }),
                ),
                "font_name": (
                    "STRING",
                    _hidden_options({
                        "default": "Microsoft YaHei",
                        "display_name": "字幕字体",
                    }),
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
                    _hidden_options({
                        "default": "#FFFFFF",
                        "display_name": "字幕颜色",
                        "tooltip": "使用 #RRGGBB 格式。",
                    }),
                ),
                "outline_color": (
                    "STRING",
                    _hidden_options({
                        "default": "#000000",
                        "display_name": "描边颜色",
                        "tooltip": "使用 #RRGGBB 格式。",
                    }),
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
                "save_directory": (
                    "STRING",
                    _hidden_options({
                        "default": "",
                        "display_name": "自定义保存目录",
                        "tooltip": "留空时使用 ComfyUI output；设置绝对路径时保存到指定目录。",
                    }),
                ),
                "output_format": (
                    ["mp4", "mkv", "webm"],
                    _hidden_options({
                        "default": "mp4",
                        "display_name": "视频格式",
                    }),
                ),
                "video_codec": (
                    ["H.264", "H.265", "VP9"],
                    _hidden_options({
                        "default": "H.264",
                        "display_name": "视频编码",
                    }),
                ),
                "encoding_preset": (
                    ["ultrafast", "fast", "medium", "slow", "veryslow"],
                    _hidden_options({
                        "default": "medium",
                        "display_name": "编码预设",
                    }),
                ),
                "crf": (
                    "INT",
                    _hidden_options({
                        "default": 18,
                        "min": 0,
                        "max": 51,
                        "step": 1,
                        "display_name": "画质 CRF",
                    }),
                ),
                "save_srt": (
                    "BOOLEAN",
                    _hidden_options({
                        "default": True,
                        "display_name": "保存同名 SRT",
                    }),
                ),
                # Compatibility contract: percentage controls were added later,
                # so they must remain after every pre-existing widget.
                "font_size_percent": (
                    "FLOAT",
                    _hidden_options({
                        "default": 5.0,
                        "min": 0.5,
                        "max": 20.0,
                        "step": 0.1,
                        "display_name": "字幕尺寸（画面高度%）",
                        "tooltip": "字幕字号按视频高度自动换算；不同分辨率的视频保持相近视觉比例。",
                    }),
                ),
                "bottom_margin_percent": (
                    "FLOAT",
                    _hidden_options({
                        "default": 8.0,
                        "min": 0.0,
                        "max": 50.0,
                        "step": 0.1,
                        "display_name": "字幕距底部（画面高度%）",
                        "tooltip": "字幕基线与视频底边的距离，按画面高度百分比计算。",
                    }),
                ),
                "outline_width_percent": (
                    "FLOAT",
                    _hidden_options({
                        "default": 6.0,
                        "min": 0.0,
                        "max": 30.0,
                        "step": 0.25,
                        "display_name": "描边宽度（字号%）",
                        "tooltip": "描边宽度按换算后的字幕字号计算，随视频分辨率同步缩放。",
                    }),
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def add_subtitles(self, **kwargs):
        # 只允许 ComfyUI 按参数名传递，禁止依赖位置顺序；新增参数不会再让旧工作流错位。
        video = kwargs["video"]
        srt = kwargs["srt"]
        filename_prefix = kwargs.get("filename_prefix", "GJJ/字幕视频")
        font_name = kwargs.get("font_name", "Microsoft YaHei")
        font_size = kwargs.get("font_size", 48)
        font_color = kwargs.get("font_color", "#FFFFFF")
        outline_color = kwargs.get("outline_color", "#000000")
        outline_width = kwargs.get("outline_width", 3.0)
        bottom_margin = kwargs.get("bottom_margin", 60)
        save_directory = kwargs.get("save_directory", "")
        output_format = kwargs.get("output_format", "mp4")
        video_codec = kwargs.get("video_codec", "H.264")
        encoding_preset = kwargs.get("encoding_preset", "medium")
        crf = kwargs.get("crf", 18)
        save_srt = kwargs.get("save_srt", True)
        font_size_percent = kwargs.get("font_size_percent", 5.0)
        bottom_margin_percent = kwargs.get("bottom_margin_percent", 8.0)
        outline_width_percent = kwargs.get("outline_width_percent", 6.0)
        prompt = kwargs.get("prompt")
        extra_pnginfo = kwargs.get("extra_pnginfo")
        unique_id = kwargs.get("unique_id")
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
        output_format = str(output_format or "mp4").lower()
        if output_format not in {"mp4", "mkv", "webm"}:
            output_format = "mp4"
        suffix = f".{output_format}"
        output_path = (
            _unique_custom_output_path(save_directory, rendered_prefix, suffix)
            if str(save_directory or "").strip()
            else _unique_output_path(rendered_prefix, suffix, marker="Subtitle")
        )
        srt_path = output_path.with_suffix(".srt")
        ass_path = output_path.with_suffix(".subtitle.ass")
        if bool(save_srt):
            srt_path.write_text(subtitle_text, encoding="utf-8-sig")

        resolved_font_name, fonts_directory = _resolve_font_selection(font_name)
        safe_font_name = resolved_font_name.replace(",", " ").replace("'", " ").strip()
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
        if fonts_directory is not None:
            subtitle_filter += f":fontsdir='{_escape_filter_path(fonts_directory)}'"
        codec_name = str(video_codec or "H.264")
        if output_format == "webm":
            codec_name = "VP9"
        codec_args = {
            "H.264": ["-c:v", "libx264", "-preset", str(encoding_preset or "medium"), "-crf", str(max(0, min(51, int(crf))))],
            "H.265": ["-c:v", "libx265", "-preset", str(encoding_preset or "medium"), "-crf", str(max(0, min(51, int(crf))))],
            "VP9": ["-c:v", "libvpx-vp9", "-crf", str(max(0, min(51, int(crf)))), "-b:v", "0"],
        }.get(codec_name, ["-c:v", "libx264", "-preset", "medium", "-crf", "18"])
        audio_args = ["-c:a", "libopus"] if output_format == "webm" else ["-c:a", "copy"]
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
            *codec_args,
            "-pix_fmt",
            "yuv420p",
            *audio_args,
        ]
        if output_format == "mp4":
            command.extend(["-movflags", "+faststart"])
        command.append(str(output_path))
        try:
            _run(command)
        except Exception:
            output_path.unlink(missing_ok=True)
            if bool(save_srt):
                srt_path.unlink(missing_ok=True)
            raise
        finally:
            ass_path.unlink(missing_ok=True)
            if temporary_source_path is not None:
                temporary_source_path.unlink(missing_ok=True)

        preview_mime = {
            "mp4": "video/mp4",
            "mkv": "video/x-matroska",
            "webm": "video/webm",
        }[output_format]
        preview = _preview_item(output_path, "output", preview_mime)
        return {
            "ui": {
                "preview_media": [preview],
                "preview_is_video": [True],
                "text": [
                    f"字幕添加完成：{output_path.name}\n"
                    f"同名字幕：{srt_path.name if bool(save_srt) else '未保存'}\n"
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


def _register_video_subtitle_overlay_api() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return
    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(server, "_gjj_video_subtitle_overlay_api_registered", False):
        return

    @server.routes.get("/gjj/video_subtitle_overlay/fonts")
    async def gjj_video_subtitle_overlay_fonts(request):
        try:
            page = max(1, int(request.query.get("page") or 1))
            page_size = max(10, min(100, int(request.query.get("page_size") or 20)))
        except Exception:
            page, page_size = 1, 20
        query = str(request.query.get("search") or "").strip().lower()
        fonts = _font_file_candidates(refresh=str(request.query.get("refresh") or "") == "1")
        if query:
            fonts = [
                item for item in fonts
                if query in f"{item.get('name', '')} {item.get('family', '')} {item.get('source', '')}".lower()
            ]
        total = len(fonts)
        start = (page - 1) * page_size
        items = fonts[start:start + page_size]
        return web.json_response({
            "ok": True,
            "fonts": items,
            "page": page,
            "page_size": page_size,
            "total": total,
            "has_more": start + len(items) < total,
        })

    server._gjj_video_subtitle_overlay_api_registered = True


_register_video_subtitle_overlay_api()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoSubtitleOverlay}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
