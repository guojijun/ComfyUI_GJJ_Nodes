from __future__ import annotations

import datetime
import functools
import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path
from string import Template
from typing import Any, Iterable

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from comfy_api.latest import InputImpl, Types
from comfy_extras.nodes_video import CreateVideo
import folder_paths


LOGGER = logging.getLogger(__name__)
ENCODE_ARGS = ("utf-8", "backslashreplace")
DEFAULT_FILENAME_PREFIX = "video/GJJ"
DEFAULT_FORMAT = "video/h264-mp4"
DEFAULT_FRAME_RATE = 8
FORMATS_DIR = Path(__file__).resolve().parents[1] / "presets" / "video_formats"
IMAGE_FORMATS = ("image/gif", "image/webp")
SEQUENCE_PATTERN_RE = re.compile(r"%0?(\d*)d", re.IGNORECASE)


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _ffmpeg_suitability(path: str) -> int:
    try:
        version = subprocess.run(
            [path, "-version"],
            check=True,
            capture_output=True,
        ).stdout.decode(*ENCODE_ARGS)
    except Exception:
        return 0

    score = 0
    for criterion, value in (("libvpx", 20), ("264", 10), ("265", 3), ("svtav1", 5), ("libopus", 1)):
        if criterion in version:
            score += value

    copyright_index = version.find("2000-2")
    if copyright_index >= 0:
        year = version[copyright_index + 6:copyright_index + 9]
        if year.isnumeric():
            score += int(year)
    return score


@functools.lru_cache(maxsize=1)
def get_ffmpeg_path() -> str | None:
    candidates: list[str] = []

    for env_key in ("GJJ_FORCE_FFMPEG_PATH", "VHS_FORCE_FFMPEG_PATH"):
        forced = os.environ.get(env_key)
        if forced and os.path.isfile(forced):
            return forced

    try:
        from imageio_ffmpeg import get_ffmpeg_exe

        imageio_ffmpeg_path = get_ffmpeg_exe()
        if imageio_ffmpeg_path:
            candidates.append(imageio_ffmpeg_path)
    except Exception:
        pass

    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        candidates.append(system_ffmpeg)

    for local_name in ("ffmpeg.exe", "ffmpeg"):
        local_path = os.path.abspath(local_name)
        if os.path.isfile(local_path):
            candidates.append(local_path)

    deduped: list[str] = []
    for item in candidates:
        if item and item not in deduped:
            deduped.append(item)

    if not deduped:
        return None
    if len(deduped) == 1:
        return deduped[0]
    return max(deduped, key=_ffmpeg_suitability)


@functools.lru_cache(maxsize=1)
def get_gifski_path() -> str | None:
    for env_key in ("GJJ_GIFSKI", "VHS_GIFSKI", "JOV_GIFSKI"):
        candidate = os.environ.get(env_key)
        if candidate and os.path.isfile(candidate):
            return candidate
    return shutil.which("gifski")


def _flatten_list(items):
    result = []
    for item in items:
        if isinstance(item, list):
            result.extend(item)
        else:
            result.append(item)
    return result


def _iterate_format(video_format: dict[str, Any], for_widgets: bool = True):
    def indirector(container, index):
        if isinstance(container[index], list) and (
            not for_widgets or len(container[index]) > 1 and not isinstance(container[index][1], dict)
        ):
            replacement = yield container[index]
            if replacement is not None:
                container[index] = replacement
                yield

    for key in video_format:
        if key == "extra_widgets":
            if for_widgets:
                yield from video_format["extra_widgets"]
        elif key.endswith("_pass"):
            for index in range(len(video_format[key])):
                yield from indirector(video_format[key], index)
            if not for_widgets:
                video_format[key] = _flatten_list(video_format[key])
        else:
            yield from indirector(video_format, key)


def _load_video_format_json(format_name: str) -> dict[str, Any]:
    format_path = FORMATS_DIR / f"{format_name}.json"
    if not format_path.is_file():
        raise RuntimeError(f"未找到本地视频格式预设：{format_name}")
    with format_path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


@functools.lru_cache(maxsize=1)
def get_video_formats() -> tuple[list[str], dict[str, list]]:
    if not FORMATS_DIR.is_dir():
        return [], {}

    formats: list[str] = []
    format_widgets: dict[str, list] = {}

    for format_path in sorted(FORMATS_DIR.glob("*.json")):
        video_format = _load_video_format_json(format_path.stem)
        if "gifski_pass" in video_format and not get_gifski_path():
            continue
        widgets = list(_iterate_format(video_format))
        format_name = f"video/{format_path.stem}"
        formats.append(format_name)
        if widgets:
            format_widgets[format_name] = widgets
    return formats, format_widgets


def list_supported_formats() -> list[str]:
    return list(IMAGE_FORMATS) + list(get_video_formats()[0])


def apply_format_widgets(format_name: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    video_format = _load_video_format_json(format_name)

    for widget in _iterate_format(video_format):
        if widget[0] in kwargs:
            continue
        if len(widget) > 2 and isinstance(widget[2], dict) and "default" in widget[2]:
            default = widget[2]["default"]
        elif isinstance(widget[1], list):
            default = widget[1][0]
        else:
            default = {"BOOLEAN": False, "INT": 0, "FLOAT": 0, "STRING": ""}.get(widget[1], "")
        kwargs[widget[0]] = default

    iterator = _iterate_format(video_format, False)
    for widget in iterator:
        resolved = widget
        while isinstance(resolved, list):
            if len(resolved) == 1:
                resolved = [Template(value).substitute(**kwargs) for value in resolved[0]]
                break
            if isinstance(resolved[1], dict):
                resolved = resolved[1][str(kwargs[resolved[0]])]
            elif len(resolved) > 3:
                resolved = Template(resolved[3]).substitute(val=kwargs[resolved[0]])
            else:
                resolved = str(kwargs[resolved[0]])
        iterator.send(resolved)
    return video_format


def parse_format_overrides(text: str | None) -> dict[str, Any]:
    raw = str(text or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"格式高级参数(JSON) 解析失败：{exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("格式高级参数(JSON) 必须是 JSON 对象。")
    return data


def _create_video_output(frames: torch.Tensor, fps: float, audio: dict[str, Any] | None):
    safe_frames = _ensure_image_batch(frames)
    if int(safe_frames.shape[-1]) > 3:
        safe_frames = safe_frames[..., :3].contiguous()
    try:
        return CreateVideo.execute(safe_frames, float(fps), audio)[0]
    except Exception:
        frame_rate = Fraction(float(fps)).limit_denominator(1000)
        return InputImpl.VideoFromComponents(Types.VideoComponents(images=safe_frames, audio=audio, frame_rate=frame_rate))


def _normalize_fps(value: Any, fallback: float = DEFAULT_FRAME_RATE) -> float:
    try:
        if isinstance(value, Fraction):
            return float(value)
        return float(value)
    except Exception:
        return float(fallback)


def _ensure_image_batch(images: torch.Tensor) -> torch.Tensor:
    if images is None:
        raise RuntimeError("未提供输入图像。")
    if not isinstance(images, torch.Tensor):
        raise RuntimeError(f"不支持的图像输入类型：{type(images)!r}")
    if images.ndim == 3:
        images = images.unsqueeze(0)
    if images.ndim != 4:
        raise RuntimeError(f"图像张量维度无效：{tuple(images.shape)}")
    if images.shape[-1] not in (3, 4):
        raise RuntimeError(f"图像通道数无效：{int(images.shape[-1])}")
    if int(images.shape[0]) <= 0:
        raise RuntimeError("输入图像批次为空。")
    return images.detach().float().cpu().clamp(0.0, 1.0).contiguous()


def _pad_frame_batches_to_uniform(frames_list: list[torch.Tensor]) -> list[torch.Tensor]:
    cleaned = [_ensure_image_batch(frames) for frames in frames_list if frames is not None]
    if not cleaned:
        return []

    max_height = max(int(frames.shape[1]) for frames in cleaned)
    max_width = max(int(frames.shape[2]) for frames in cleaned)
    padded: list[torch.Tensor] = []
    for frames in cleaned:
        height = int(frames.shape[1])
        width = int(frames.shape[2])
        channels = int(frames.shape[-1])
        if height == max_height and width == max_width:
            padded.append(frames.contiguous())
            continue
        canvas = torch.zeros((int(frames.shape[0]), max_height, max_width, channels), dtype=frames.dtype)
        top = max(0, (max_height - height) // 2)
        left = max(0, (max_width - width) // 2)
        canvas[:, top:top + height, left:left + width, :] = frames
        padded.append(canvas.contiguous())
    return padded


def _combine_frame_segments(frames_list: list[torch.Tensor]) -> torch.Tensor:
    padded = _pad_frame_batches_to_uniform(frames_list)
    if not padded:
        raise RuntimeError("未提供可合成的视频帧或图像帧。")
    return torch.cat(padded, dim=0).contiguous()


def _is_video_object(value: Any) -> bool:
    return value is not None and hasattr(value, "get_components")


def _extract_video_components(source: Any) -> tuple[list[dict[str, Any]], float | None]:
    if source is None:
        return [], None
    if isinstance(source, (dict, list, tuple)) and len(source) == 0:
        return [], None

    items: list[tuple[int, str, Any]] = []
    if isinstance(source, dict):
        iterable = source.items()
    elif isinstance(source, (list, tuple)) and all(_is_video_object(value) for value in source if value is not None):
        iterable = ((f"video_{index:02d}", value) for index, value in enumerate(source, start=1))
    elif _is_video_object(source):
        iterable = (("video_01", source),)
    else:
        return [], None

    for key, value in iterable:
        text = str(key or "")
        if value is None:
            continue
        try:
            index = int(text.split("_", 1)[1]) if "_" in text else len(items) + 1
        except Exception:
            index = 999999
        items.append((index, text, value))

    components_list: list[dict[str, Any]] = []
    first_fps: float | None = None
    for _, key, video in sorted(items, key=lambda item: item[0]):
        if not hasattr(video, "get_components"):
            raise RuntimeError(f"合并视频输入 {key} 不是有效 VIDEO 对象。")
        try:
            components = video.get_components()
            images = _ensure_image_batch(components.images)
            fps = _normalize_fps(getattr(components, "frame_rate", None), DEFAULT_FRAME_RATE)
            audio = getattr(components, "audio", None)
        except Exception as exc:
            raise RuntimeError(f"读取合并视频输入 {key} 失败：{exc}") from exc
        if first_fps is None:
            first_fps = fps
        components_list.append({"key": key, "images": images, "audio": audio, "fps": fps})
    return components_list, first_fps


def _concat_video_audios(video_segments: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not video_segments:
        return None
    waveforms: list[torch.Tensor] = []
    sample_rate: int | None = None
    channels: int | None = None
    for segment in video_segments:
        audio = segment.get("audio")
        if not isinstance(audio, dict) or not isinstance(audio.get("waveform"), torch.Tensor):
            return None
        rate = int(audio.get("sample_rate") or 0)
        waveform = audio["waveform"].detach().cpu().float()
        if waveform.ndim == 2:
            waveform = waveform.unsqueeze(0)
        if waveform.ndim != 3:
            return None
        if sample_rate is None:
            sample_rate = rate
            channels = int(waveform.shape[1])
        if rate != sample_rate or int(waveform.shape[1]) != int(channels or 0):
            return None
        waveforms.append(waveform)
    if not waveforms or sample_rate is None:
        return None
    return {"waveform": torch.cat(waveforms, dim=-1), "sample_rate": sample_rate}


def _decode_latents(latents: dict[str, Any], vae, unique_id: Any = None) -> torch.Tensor:
    if vae is None:
        raise RuntimeError("输入为 LATENT 时必须连接 VAE。")
    if not isinstance(latents, dict) or "samples" not in latents:
        raise RuntimeError("LATENT 输入缺少 samples。")

    samples = latents["samples"]
    if not isinstance(samples, torch.Tensor):
        raise RuntimeError("LATENT samples 不是有效张量。")
    if samples.ndim == 3:
        samples = samples.unsqueeze(0)
    if samples.ndim != 4:
        raise RuntimeError(f"LATENT 维度无效：{tuple(samples.shape)}")

    total = int(samples.shape[0])
    downscale_ratio = int(getattr(vae, "downscale_ratio", 8) or 8)
    width = int(samples.shape[-1]) * downscale_ratio
    height = int(samples.shape[-2]) * downscale_ratio
    frames_per_batch = max(1, (1920 * 1080 * 16) // max(1, width * height))

    decoded_batches: list[torch.Tensor] = []
    for start in range(0, total, frames_per_batch):
        end = min(total, start + frames_per_batch)
        _send_status(
            unique_id,
            f"2/5 解码 latent 帧 {start + 1}-{end}/{total}...",
            0.18 + (0.18 * (end / max(1, total))),
        )
        batch = samples[start:end]
        try:
            decoded = vae.decode(batch)
        except Exception:
            if hasattr(vae, "decode_tiled"):
                decoded = vae.decode_tiled(batch, tile_x=64, tile_y=64)
            else:
                raise
        decoded_batches.append(_ensure_image_batch(decoded))
    return torch.cat(decoded_batches, dim=0)


def _apply_pingpong(frames: torch.Tensor) -> torch.Tensor:
    frames = _ensure_image_batch(frames)
    if int(frames.shape[0]) <= 2:
        return frames
    reverse_frames = torch.flip(frames[1:-1], dims=[0])
    return torch.cat([frames, reverse_frames], dim=0).contiguous()


def _repeat_frames(frames: torch.Tensor, repeat_count: int) -> torch.Tensor:
    frames = _ensure_image_batch(frames)
    if repeat_count <= 1:
        return frames
    return torch.cat([frames] * int(repeat_count), dim=0).contiguous()


def tensor_to_int(tensor: torch.Tensor, bits: int) -> np.ndarray:
    array = tensor.detach().cpu().numpy() * (2**bits - 1) + 0.5
    return np.clip(array, 0, (2**bits - 1))


def tensor_to_shorts(tensor: torch.Tensor) -> np.ndarray:
    return tensor_to_int(tensor, 16).astype(np.uint16)


def tensor_to_bytes(tensor: torch.Tensor) -> np.ndarray:
    return tensor_to_int(tensor, 8).astype(np.uint8)


def _pad_frames_to_alignment(frames: torch.Tensor, alignment: int) -> tuple[torch.Tensor, tuple[int, int]]:
    frames = _ensure_image_batch(frames)
    alignment = max(1, int(alignment))
    height = int(frames.shape[1])
    width = int(frames.shape[2])
    if width % alignment == 0 and height % alignment == 0:
        return frames, (width, height)

    pad_width = (-width) % alignment
    pad_height = (-height) % alignment
    pad_left = pad_width // 2
    pad_right = pad_width - pad_left
    pad_top = pad_height // 2
    pad_bottom = pad_height - pad_top
    padded = F.pad(frames.permute(0, 3, 1, 2), (pad_left, pad_right, pad_top, pad_bottom), mode="replicate")
    return padded.permute(0, 2, 3, 1).contiguous(), (width + pad_width, height + pad_height)


def _encode_metadata(prompt: Any = None, extra_pnginfo: Any = None) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    if prompt is not None:
        metadata["prompt"] = prompt
    if isinstance(extra_pnginfo, dict):
        metadata.update(extra_pnginfo)
    metadata["CreationTime"] = datetime.datetime.now().isoformat(" ")[:19]
    return metadata


def _write_ffmpeg_metadata_file(metadata: dict[str, Any]) -> str:
    def escape_value(key: str, value: Any) -> str:
        text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
        text = text.replace("\\", "\\\\").replace(";", "\\;").replace("#", "\\#").replace("=", "\\=").replace("\n", "\\\n")
        return f"{key}={text}"

    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as handle:
        handle.write(";FFMETADATA1\n")
        for key, value in metadata.items():
            handle.write(escape_value(str(key), value) + "\n")
        return handle.name


def _iter_frame_bytes(frames: torch.Tensor, color_depth: str) -> Iterable[bytes]:
    use_16bit = str(color_depth or "8bit") == "16bit"
    converter = tensor_to_shorts if use_16bit else tensor_to_bytes
    for frame in frames:
        yield converter(frame).tobytes()


def _decode_subprocess_output(payload: bytes | None) -> str:
    if not payload:
        return ""
    return payload.decode(*ENCODE_ARGS).strip()


def _format_command_preview(args: list[str], limit: int = 800) -> str:
    try:
        text = subprocess.list2cmdline([str(item) for item in args])
    except Exception:
        text = " ".join(str(item) for item in args)
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def _close_process_stdin(process: subprocess.Popen) -> None:
    stream = getattr(process, "stdin", None)
    if stream is None:
        return
    try:
        stream.close()
    except OSError:
        pass


def _format_ffmpeg_stream_error(
    stderr: bytes | None,
    args: list[str],
    exc: BaseException | None = None,
) -> str:
    output_path = str(args[-1]) if args else ""
    command_preview = _format_command_preview(args)
    stderr_text = _decode_subprocess_output(stderr)
    if stderr_text:
        details = stderr_text
    elif output_path and os.path.exists(output_path):
        details = f"目标文件已存在或写入中断：{output_path}"
    elif exc is not None:
        details = f"ffmpeg 编码进程提前退出：{exc}"
    else:
        details = "ffmpeg 编码进程提前退出，但没有返回可用的错误信息。"

    return "\n".join(
        [
            "ffmpeg 编码失败。",
            f"输出文件：{output_path or '未知'}",
            f"命令：{command_preview or '未知'}",
            f"错误：{details}",
        ]
    )


def _run_ffmpeg_stream(args: list[str], frames: torch.Tensor, color_depth: str, env: dict[str, str]) -> int:
    with subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        env=env,
    ) as process:
        stderr = b""
        return_code = None
        try:
            frame_count = 0
            assert process.stdin is not None
            for frame_bytes in _iter_frame_bytes(frames, color_depth):
                process.stdin.write(frame_bytes)
                frame_count += 1
            process.stdin.flush()
            process.stdin.close()
            stderr = process.stderr.read() if process.stderr is not None else b""
            return_code = process.wait()
        except (BrokenPipeError, OSError) as exc:
            _close_process_stdin(process)
            stderr = process.stderr.read() if process.stderr is not None else b""
            return_code = process.wait()
            raise RuntimeError(_format_ffmpeg_stream_error(stderr, args, exc=exc)) from exc
    if return_code != 0:
        raise RuntimeError(_format_ffmpeg_stream_error(stderr, args))
    return frame_count


def _run_gifski_stream(
    ffmpeg_args: list[str],
    frames: torch.Tensor,
    color_depth: str,
    dimensions: tuple[int, int],
    frame_rate: float,
    video_format: dict[str, Any],
    file_path: str,
    env: dict[str, str],
) -> None:
    gifski_path = get_gifski_path()
    if not gifski_path:
        raise RuntimeError("当前环境缺少 gifski，无法使用 gifski 动图格式。")

    ffmpeg_cmd = ffmpeg_args + video_format["main_pass"] + ["-f", "yuv4mpegpipe", "-"]
    gifski_cmd = [
        gifski_path,
        *video_format["gifski_pass"],
        "-W",
        str(dimensions[0]),
        "-H",
        str(dimensions[1]),
        "-r",
        str(frame_rate),
        "-q",
        "-o",
        file_path,
        "-",
    ]

    with subprocess.Popen(
        ffmpeg_cmd,
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdout=subprocess.PIPE,
        env=env,
    ) as ffmpeg_process:
        with subprocess.Popen(
            gifski_cmd,
            stdin=ffmpeg_process.stdout,
            stderr=subprocess.PIPE,
            stdout=subprocess.PIPE,
            env=env,
        ) as gifski_process:
            try:
                assert ffmpeg_process.stdin is not None
                for frame_bytes in _iter_frame_bytes(frames, color_depth):
                    ffmpeg_process.stdin.write(frame_bytes)
                ffmpeg_process.stdin.flush()
                ffmpeg_process.stdin.close()
                ffmpeg_stderr = ffmpeg_process.stderr.read() if ffmpeg_process.stderr is not None else b""
                gifski_stderr = gifski_process.stderr.read() if gifski_process.stderr is not None else b""
                gifski_stdout = gifski_process.stdout.read() if gifski_process.stdout is not None else b""
            except BrokenPipeError as exc:
                ffmpeg_stderr = ffmpeg_process.stderr.read() if ffmpeg_process.stderr is not None else b""
                gifski_stderr = gifski_process.stderr.read() if gifski_process.stderr is not None else b""
                raise RuntimeError(
                    "创建 gifski 输出失败。\n"
                    f"ffmpeg: {ffmpeg_stderr.decode(*ENCODE_ARGS)}\n"
                    f"gifski: {gifski_stderr.decode(*ENCODE_ARGS)}"
                ) from exc

    if ffmpeg_process.wait() != 0:
        raise RuntimeError(ffmpeg_stderr.decode(*ENCODE_ARGS))
    if gifski_process.wait() != 0:
        raise RuntimeError(gifski_stderr.decode(*ENCODE_ARGS))
    if gifski_stdout:
        LOGGER.debug(gifski_stdout.decode(*ENCODE_ARGS))


def _merge_filter_args(args: list[str], flag: str = "-vf") -> None:
    try:
        start_index = args.index(flag) + 1
        index = start_index
        while True:
            index = args.index(flag, index)
            args[start_index] += "," + args[index + 1]
            args.pop(index)
            args.pop(index)
    except ValueError:
        return


def _build_ffmpeg_base_args(
    ffmpeg_path: str,
    frame_rate: float,
    dimensions: tuple[int, int],
    input_pix_fmt: str,
    fake_trc: str,
) -> list[str]:
    return [
        ffmpeg_path,
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        input_pix_fmt,
        "-color_range",
        "pc",
        "-colorspace",
        "rgb",
        "-color_primaries",
        "bt709",
        "-color_trc",
        fake_trc,
        "-s",
        f"{dimensions[0]}x{dimensions[1]}",
        "-r",
        str(frame_rate),
        "-i",
        "-",
    ]


def _encode_ffmpeg_video(
    frames: torch.Tensor,
    frame_rate: float,
    video_format: dict[str, Any],
    file_path: str,
    metadata: dict[str, Any],
) -> None:
    ffmpeg_path = get_ffmpeg_path()
    if not ffmpeg_path:
        raise RuntimeError(
            "当前环境未找到 ffmpeg。要使用 video/* 格式，请安装 ffmpeg 或让 imageio_ffmpeg 可用。"
        )

    has_alpha = int(frames.shape[-1]) == 4
    extension = str(video_format.get("extension", "") or "")
    default_alignment = 1 if "%" in extension else 2
    dim_alignment = int(video_format.get("dim_alignment", default_alignment) or default_alignment)
    padded_frames, dimensions = _pad_frames_to_alignment(frames, dim_alignment)
    color_depth = str(video_format.get("input_color_depth", "8bit") or "8bit")
    input_pix_fmt = "rgba64" if color_depth == "16bit" and has_alpha else (
        "rgb48" if color_depth == "16bit" else ("rgba" if has_alpha else "rgb24")
    )

    env = os.environ.copy()
    if isinstance(video_format.get("environment"), dict):
        env.update({str(key): str(value) for key, value in video_format["environment"].items()})

    base_args = _build_ffmpeg_base_args(
        ffmpeg_path=ffmpeg_path,
        frame_rate=frame_rate,
        dimensions=dimensions,
        input_pix_fmt=input_pix_fmt,
        fake_trc=str(video_format.get("fake_trc", "iec61966-2-1") or "iec61966-2-1"),
    )

    if "inputs_main_pass" in video_format:
        insert_index = base_args.index("-i") + 2
        base_args = base_args[:insert_index] + list(video_format["inputs_main_pass"]) + base_args[insert_index:]

    if "gifski_pass" in video_format:
        _run_gifski_stream(base_args, padded_frames, color_depth, dimensions, frame_rate, video_format, file_path, env)
        return

    encode_args = base_args + list(video_format.get("main_pass", []))
    _merge_filter_args(encode_args)

    metadata_temp_path = None
    use_metadata = bool(metadata) and str(video_format.get("save_metadata", "False")) != "False"
    output_existed_before_encode = os.path.exists(file_path)
    try:
        if use_metadata:
            metadata_temp_path = _write_ffmpeg_metadata_file(metadata)
            metadata_args = encode_args[:1] + ["-f", "ffmetadata", "-i", metadata_temp_path] + encode_args[1:] + [
                "-metadata",
                "creation_time=now",
                "-movflags",
                "use_metadata_tags",
            ]
            try:
                _run_ffmpeg_stream(metadata_args + [file_path], padded_frames, color_depth, env)
                return
            except Exception:
                if not output_existed_before_encode and os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except OSError:
                        LOGGER.debug("删除失败的元数据输出文件失败：%s", file_path, exc_info=True)
                LOGGER.warning("视频元数据写入失败，已自动回退为无元数据输出。", exc_info=True)

        if not output_existed_before_encode and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except OSError:
                LOGGER.debug("删除失败的旧输出文件失败：%s", file_path, exc_info=True)
        try:
            _run_ffmpeg_stream(encode_args + [file_path], padded_frames, color_depth, env)
        except RuntimeError as exc:
            format_name = str(video_format.get("extension", "") or "video")
            raise RuntimeError(
                "\n".join(
                    [
                        f"GJJ Video合成器编码失败：{format_name}",
                        f"输出尺寸：{dimensions[0]}x{dimensions[1]}",
                        f"输入像素格式：{input_pix_fmt}",
                        str(exc),
                    ]
                )
            ) from exc
    finally:
        if metadata_temp_path and os.path.exists(metadata_temp_path):
            try:
                os.remove(metadata_temp_path)
            except OSError:
                pass


def _extract_audio_waveform(audio: dict[str, Any]) -> tuple[np.ndarray, int, int]:
    if audio is None:
        raise RuntimeError("未提供音频。")
    try:
        waveform = audio["waveform"]
        sample_rate = int(audio["sample_rate"])
    except Exception as exc:
        message = str(exc)
        if (
            "Output file does not contain any stream" in message
            or "does not contain any stream" in message
            or "Stream map" in message
            or "audio" in message.lower() and "stream" in message.lower()
        ):
            raise RuntimeError("输入音频对象没有可提取的音轨。") from exc
        raise
    if waveform.ndim == 2:
        waveform = waveform.unsqueeze(0)
    if waveform.ndim != 3:
        raise RuntimeError(f"音频张量维度无效：{tuple(waveform.shape)}")
    channels = int(waveform.shape[1])
    audio_data = waveform.squeeze(0).transpose(0, 1).contiguous().cpu().numpy().astype(np.float32, copy=False)
    return audio_data, sample_rate, channels


def _resolve_audio_or_none(audio: Any, unique_id: Any = None) -> dict[str, Any] | None:
    if audio is None:
        return None
    try:
        _extract_audio_waveform(audio)
        return audio
    except RuntimeError as exc:
        message = str(exc)
        if "没有可提取的音轨" in message:
            LOGGER.info("GJJ Video合成器：输入视频没有音轨，已跳过音频封装。")
            _send_status(unique_id, "输入视频没有音轨，按无声视频输出。", 0.34)
            return None
        raise


def _format_supports_audio(extension: str) -> bool:
    lowered = str(extension or "").lower()
    if "%" in lowered:
        return False
    return lowered not in {"gif", "png", "webp", "jpg", "jpeg"}


def _mux_audio_into_video(
    input_video_path: str,
    output_video_path: str,
    audio: dict[str, Any],
    video_format: dict[str, Any],
    frame_count: int,
    frame_rate: float,
) -> None:
    ffmpeg_path = get_ffmpeg_path()
    if not ffmpeg_path:
        raise RuntimeError("当前环境未找到 ffmpeg，无法封入音频。")

    audio_data, sample_rate, channels = _extract_audio_waveform(audio)
    audio_pass = list(video_format.get("audio_pass", ["-c:a", "aac"]))
    trim_to_audio = str(video_format.get("trim_to_audio", "False")) != "False"
    min_audio_duration = float(frame_count) / float(frame_rate) + 1.0
    apad_args = [] if trim_to_audio else ["-af", f"apad=whole_dur={min_audio_duration}"]

    mux_args = [
        ffmpeg_path,
        "-v",
        "error",
        "-i",
        input_video_path,
        "-ar",
        str(sample_rate),
        "-ac",
        str(channels),
        "-f",
        "f32le",
        "-i",
        "-",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-map_metadata",
        "0",
        "-c:v",
        "copy",
        *audio_pass,
        *apad_args,
        "-shortest",
        "-movflags",
        "use_metadata_tags",
        output_video_path,
    ]
    _merge_filter_args(mux_args, "-af")

    try:
        result = subprocess.run(
            mux_args,
            input=audio_data.tobytes(),
            capture_output=True,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(exc.stderr.decode(*ENCODE_ARGS)) from exc

    if result.stderr:
        LOGGER.debug(result.stderr.decode(*ENCODE_ARGS))


def _save_webp_or_gif(
    frames: torch.Tensor,
    frame_rate: float,
    loop_count: int,
    file_path: str,
    format_name: str,
    overrides: dict[str, Any],
) -> None:
    frames = _ensure_image_batch(frames)
    pil_frames = [Image.fromarray(tensor_to_bytes(frame)) for frame in frames]
    if not pil_frames:
        raise RuntimeError("没有可写出的图像帧。")

    duration_ms = max(1, round(1000.0 / float(frame_rate)))
    save_kwargs: dict[str, Any] = {
        "save_all": True,
        "append_images": pil_frames[1:],
        "duration": duration_ms,
        "loop": int(loop_count),
    }

    if format_name == "gif":
        save_kwargs["format"] = "GIF"
        save_kwargs["disposal"] = 2
    else:
        save_kwargs["format"] = "WEBP"
        save_kwargs["lossless"] = bool(overrides.get("lossless", True))
        if "quality" in overrides:
            try:
                save_kwargs["quality"] = int(overrides["quality"])
            except Exception:
                pass

    pil_frames[0].save(file_path, **save_kwargs)


def _sequence_glob(path_pattern: str) -> list[str]:
    parent = Path(path_pattern).parent
    name = Path(path_pattern).name
    glob_name = SEQUENCE_PATTERN_RE.sub("*", name)
    return sorted(str(path) for path in parent.glob(glob_name))


def _find_next_output_counter(full_output_folder: str, filename: str) -> int:
    os.makedirs(full_output_folder, exist_ok=True)
    max_counter = 0
    matcher = re.compile(rf"{re.escape(str(filename))}_(\d+)\D*\..+", re.IGNORECASE)
    try:
        existing_files = os.listdir(full_output_folder)
    except FileNotFoundError:
        return 1

    for existing_file in existing_files:
        match = matcher.fullmatch(existing_file)
        if not match:
            continue
        try:
            file_counter = int(match.group(1))
        except Exception:
            continue
        if file_counter > max_counter:
            max_counter = file_counter
    return max_counter + 1


def _save_video_with_av(video_output, file_path: str, metadata: dict[str, Any]) -> None:
    video_output.save_to(file_path, metadata=metadata or None)


def combine_video(
    *,
    images=None,
    video_inputs=None,
    frame_rate,
    loop_count,
    filename_prefix,
    format_name,
    pingpong,
    save_output,
    use_source_fps=False,
    audio=None,
    vae=None,
    format_overrides_json="",
    prompt=None,
    extra_pnginfo=None,
    unique_id=None,
):
    resolved_format = str(format_name or DEFAULT_FORMAT).strip() or DEFAULT_FORMAT
    if resolved_format not in list_supported_formats():
        raise RuntimeError(f"不支持的输出格式：{resolved_format}")

    video_segments, source_video_fps = _extract_video_components(images)
    if not video_segments and video_inputs:
        video_segments, source_video_fps = _extract_video_components(video_inputs)
    has_image_input = images is not None and not video_segments
    has_video_input = bool(video_segments)
    if not has_image_input and not has_video_input:
        raise RuntimeError("请连接“图像/视频/Latent”。")

    fps = max(0.01, float(source_video_fps if (bool(use_source_fps) and source_video_fps) else frame_rate))
    loop_count = max(0, int(loop_count))
    prefix = str(filename_prefix or "").strip() or DEFAULT_FILENAME_PREFIX

    _send_status(unique_id, "1/5 整理输入帧序列...", 0.05)
    frame_segments: list[torch.Tensor] = []
    if has_image_input:
        if isinstance(images, dict):
            frame_segments.append(_decode_latents(images, vae, unique_id=unique_id))
        else:
            frame_segments.append(_ensure_image_batch(images))
    frame_segments.extend(segment["images"] for segment in video_segments)
    frames = _combine_frame_segments(frame_segments)
    effective_audio = audio
    if effective_audio is None and not has_image_input and has_video_input:
        effective_audio = _concat_video_audios(video_segments)
    effective_audio = _resolve_audio_or_none(effective_audio, unique_id)

    _send_status(unique_id, f"2/5 组装播放时间线：{int(frames.shape[0])} 帧...", 0.32)
    playback_frames = _apply_pingpong(frames) if bool(pingpong) else frames
    is_video_format = resolved_format.startswith("video/")
    save_frames = _repeat_frames(playback_frames, loop_count + 1) if (is_video_format and loop_count > 0) else playback_frames
    video_output_frames = save_frames if is_video_format and loop_count > 0 else playback_frames

    _send_status(unique_id, "3/5 准备输出路径与格式参数...", 0.48)
    output_dir = folder_paths.get_output_directory() if bool(save_output) else folder_paths.get_temp_directory()
    full_output_folder, filename, _, subfolder, _ = folder_paths.get_save_image_path(
        prefix,
        output_dir,
        int(frames.shape[2]),
        int(frames.shape[1]),
    )
    os.makedirs(full_output_folder, exist_ok=True)
    counter = _find_next_output_counter(full_output_folder, filename)

    overrides = parse_format_overrides(format_overrides_json)
    metadata = _encode_metadata(prompt=prompt, extra_pnginfo=extra_pnginfo)
    output_files: list[str] = []

    if resolved_format.startswith("image/"):
        format_ext = resolved_format.split("/", 1)[1]
        main_output_path = os.path.join(full_output_folder, f"{filename}_{counter:05}.{format_ext}")
        _send_status(unique_id, f"4/5 正在写出 {format_ext.upper()}...", 0.68)
        _save_webp_or_gif(
            frames=playback_frames,
            frame_rate=fps,
            loop_count=loop_count,
            file_path=main_output_path,
            format_name=format_ext,
            overrides=overrides,
        )
        output_files = [main_output_path]
    else:
        format_ext = resolved_format.split("/", 1)[1]
        video_format = apply_format_widgets(format_ext, dict(overrides))
        extension = str(video_format.get("extension", "") or "")
        main_output_path = os.path.join(full_output_folder, f"{filename}_{counter:05}.{extension}")

        _send_status(unique_id, f"4/5 正在编码 {extension or format_ext}...", 0.68)
        ffmpeg_path = get_ffmpeg_path()
        can_use_av_fallback = format_ext == "h264-mp4" and ffmpeg_path is None

        if can_use_av_fallback:
            video_output = _create_video_output(video_output_frames, fps, effective_audio)
            _save_video_with_av(video_output, main_output_path, metadata)
            output_files = [main_output_path]
        else:
            temp_no_audio_path = main_output_path
            if effective_audio is not None and _format_supports_audio(extension):
                file_descriptor, temp_no_audio_path = tempfile.mkstemp(
                    suffix=f".{extension}" if extension else ".mp4",
                    dir=full_output_folder,
                )
                os.close(file_descriptor)
                try:
                    os.remove(temp_no_audio_path)
                except OSError:
                    pass

            _encode_ffmpeg_video(
                frames=save_frames,
                frame_rate=fps,
                video_format=video_format,
                file_path=temp_no_audio_path,
                metadata=metadata,
            )

            if effective_audio is not None and _format_supports_audio(extension):
                _send_status(unique_id, "4/5 正在封入音频...", 0.82)
                _mux_audio_into_video(
                    input_video_path=temp_no_audio_path,
                    output_video_path=main_output_path,
                    audio=effective_audio,
                    video_format=video_format,
                    frame_count=int(save_frames.shape[0]),
                    frame_rate=fps,
                )
                try:
                    os.remove(temp_no_audio_path)
                except OSError:
                    pass
            elif temp_no_audio_path != main_output_path:
                shutil.move(temp_no_audio_path, main_output_path)

            output_files = _sequence_glob(main_output_path) if "%" in extension else [main_output_path]
            if not output_files:
                output_files = [main_output_path]

    _send_status(unique_id, "5/5 构建官方 VIDEO 输出...", 0.92)
    video_output = _create_video_output(video_output_frames, fps, effective_audio)
    main_path = output_files[0] if output_files else ""
    output_files_json = json.dumps(output_files, ensure_ascii=False)
    preview_item = None
    if main_path:
        preview_item = {
            "filename": os.path.basename(main_path),
            "subfolder": str(subfolder or ""),
            "type": "output" if bool(save_output) else "temp",
            "format": resolved_format,
            "frame_rate": fps,
        }
    _send_status(unique_id, f"完成：{int(video_output_frames.shape[0])} 帧，输出 {len(output_files)} 个文件", 1.0)
    ui_payload = {
        "preview_main_path": (main_path,),
        "preview_format": (resolved_format,),
        "preview_is_video": (resolved_format.startswith("video/"),),
    }
    if preview_item is not None:
        ui_payload["preview_media"] = [preview_item]
        ui_payload["images"] = [preview_item]
        ui_payload["animated"] = (True,)
    return {
        "ui": ui_payload,
        "result": (video_output, main_path, output_files_json),
    }
