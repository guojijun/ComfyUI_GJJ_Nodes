from __future__ import annotations

import json
import subprocess
import tempfile
import time
import wave
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image

try:
    import folder_paths
except Exception:
    folder_paths = None


def _output_dir() -> Path:
    root = Path(folder_paths.get_output_directory()) if folder_paths is not None else Path.cwd() / "output"
    path = root / "GJJ" / "ffmpeg"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _run(command: list[str]) -> subprocess.CompletedProcess:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "FFmpeg 执行失败").strip())
    return result


def _write_audio_wav(audio: dict[str, Any], path: Path) -> None:
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate") or 44100)
    if not isinstance(waveform, torch.Tensor):
        raise RuntimeError("AUDIO 输入缺少 waveform。")
    value = waveform.detach().float().cpu()
    while value.ndim > 2:
        value = value[0]
    if value.ndim == 1:
        value = value.unsqueeze(0)
    if value.shape[0] > value.shape[1]:
        value = value.movedim(0, 1)
    samples = (value.clamp(-1, 1).numpy().T * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(int(samples.shape[1]) if samples.ndim == 2 else 1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(samples.tobytes())


def _write_frames(images: torch.Tensor, directory: Path) -> str:
    pattern = str(directory / "frame_%06d.png")
    value = images.detach().float().cpu().clamp(0, 1)
    for index, frame in enumerate(value, start=1):
        array = (frame[..., :3].numpy() * 255.0).astype(np.uint8)
        Image.fromarray(array).save(pattern % index)
    return pattern


class GJJ_VideoInfo:
    CATEGORY = "GJJ/视频"
    FUNCTION = "probe"
    DESCRIPTION = "调用 ffprobe 读取视频基本信息。"
    SEARCH_ALIASES = ["ffprobe", "video info", "视频信息"]
    RETURN_TYPES = ("STRING", "INT", "INT", "FLOAT", "INT", "FLOAT", "STRING")
    RETURN_NAMES = ("文件名", "宽度", "高度", "帧率", "总帧数", "时长秒", "完整JSON")
    OUTPUT_TOOLTIPS = ("文件名。", "视频宽度。", "视频高度。", "帧率。", "估算或读取到的总帧数。", "时长秒。", "ffprobe 完整 JSON。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_path": ("STRING", {"default": "", "display_name": "视频路径", "tooltip": "本地视频文件路径。"}),
                "ffprobe_path": ("STRING", {"default": "ffprobe", "display_name": "ffprobe路径", "tooltip": "ffprobe 可执行文件路径，默认使用 PATH。"}),
            }
        }

    def probe(self, video_path: str, ffprobe_path: str):
        path = Path(video_path)
        if not path.exists():
            raise RuntimeError(f"未找到视频文件：{video_path}")
        result = _run([ffprobe_path or "ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)])
        data = json.loads(result.stdout or "{}")
        width = height = total_frames = 0
        fps = 0.0
        for stream in data.get("streams", []):
            if stream.get("codec_type") != "video":
                continue
            width = int(stream.get("width") or 0)
            height = int(stream.get("height") or 0)
            rate = str(stream.get("r_frame_rate") or "0/1")
            try:
                numerator, denominator = rate.split("/")
                fps = float(numerator) / max(1.0, float(denominator))
            except Exception:
                fps = 0.0
            total_frames = int(stream.get("nb_frames") or 0)
            break
        duration = float(data.get("format", {}).get("duration") or 0.0)
        if total_frames <= 0 and fps > 0 and duration > 0:
            total_frames = int(round(duration * fps))
        return (path.name, width, height, fps, total_frames, duration, json.dumps(data, ensure_ascii=False, indent=2))


class GJJ_VideoFramesLoader:
    CATEGORY = "GJJ/视频"
    FUNCTION = "load"
    DESCRIPTION = "用 FFmpeg 抽取视频帧为 IMAGE 批次。"
    SEARCH_ALIASES = ["video frames", "ffmpeg", "视频抽帧"]
    RETURN_TYPES = ("IMAGE", "FLOAT", "FLOAT", "INT")
    RETURN_NAMES = ("视频帧", "原始帧率", "输出帧率", "总帧数")
    OUTPUT_TOOLTIPS = ("抽取出的 IMAGE 批次。", "原视频帧率。", "按间隔抽帧后的帧率。", "原视频总帧数估算。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_path": ("STRING", {"default": "", "display_name": "视频路径", "tooltip": "本地视频文件路径。"}),
                "frame_interval": ("INT", {"default": 1, "min": 1, "max": 1000, "display_name": "抽帧间隔", "tooltip": "每隔多少帧取一帧。"}),
                "max_frames": ("INT", {"default": 0, "min": 0, "max": 10000, "display_name": "最大帧数", "tooltip": "0 表示不限制。"}),
                "ffmpeg_path": ("STRING", {"default": "ffmpeg", "display_name": "ffmpeg路径", "tooltip": "ffmpeg 可执行文件路径，默认使用 PATH。"}),
                "ffprobe_path": ("STRING", {"default": "ffprobe", "display_name": "ffprobe路径", "tooltip": "ffprobe 可执行文件路径，默认使用 PATH。"}),
            }
        }

    def load(self, video_path: str, frame_interval: int, max_frames: int, ffmpeg_path: str, ffprobe_path: str):
        info = GJJ_VideoInfo().probe(video_path, ffprobe_path)
        fps = float(info[3])
        total = int(info[4])
        output_fps = fps / max(1, int(frame_interval)) if fps > 0 else 0.0
        with tempfile.TemporaryDirectory() as tmp:
            pattern = str(Path(tmp) / "frame_%06d.png")
            select = f"not(mod(n\\,{max(1, int(frame_interval))}))"
            command = [ffmpeg_path or "ffmpeg", "-y", "-i", str(video_path), "-vf", f"select='{select}'", "-vsync", "vfr"]
            if int(max_frames) > 0:
                command.extend(["-frames:v", str(int(max_frames))])
            command.append(pattern)
            _run(command)
            frames = []
            for frame_path in sorted(Path(tmp).glob("frame_*.png")):
                with Image.open(frame_path) as img:
                    frames.append(torch.from_numpy(np.asarray(img.convert("RGB")).astype(np.float32) / 255.0).unsqueeze(0))
            if not frames:
                raise RuntimeError("未能从视频中抽取到帧。")
            return (torch.cat(frames, dim=0), fps, output_fps, total)


class GJJ_FFmpegMuxAudioVideo:
    CATEGORY = "GJJ/视频"
    FUNCTION = "mux"
    DESCRIPTION = "用 FFmpeg 把图片帧或视频路径与音频合并为 MP4。"
    SEARCH_ALIASES = ["ffmpeg mux", "audio video", "音视频合并"]
    RETURN_TYPES = ("STRING", "FLOAT", "INT")
    RETURN_NAMES = ("输出视频路径", "视频时长", "总帧数")
    OUTPUT_TOOLTIPS = ("合并后视频文件路径。", "输出视频时长秒。", "输出视频帧数估算。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "fps": ("FLOAT", {"default": 30.0, "min": 1.0, "max": 240.0, "step": 0.1, "display_name": "帧率", "tooltip": "图片帧转视频时使用的帧率。"}),
                "filename_prefix": ("STRING", {"default": "GJJ/ffmpeg/mux", "display_name": "文件名前缀", "tooltip": "输出文件名前缀。"}),
                "ffmpeg_path": ("STRING", {"default": "ffmpeg", "display_name": "ffmpeg路径", "tooltip": "ffmpeg 可执行文件路径，默认使用 PATH。"}),
                "ffprobe_path": ("STRING", {"default": "ffprobe", "display_name": "ffprobe路径", "tooltip": "ffprobe 可执行文件路径，默认使用 PATH。"}),
            },
            "optional": {
                "images": ("IMAGE", {"display_name": "图片帧", "tooltip": "可选。连接后先编码成视频。"}),
                "audio": ("AUDIO", {"display_name": "音频", "tooltip": "可选 AUDIO 输入。"}),
                "video_path": ("STRING", {"default": "", "display_name": "视频路径", "tooltip": "可选。已有视频路径。"}),
                "audio_path": ("STRING", {"default": "", "display_name": "音频路径", "tooltip": "可选。已有音频路径。"}),
            },
        }

    def mux(self, fps: float, filename_prefix: str, ffmpeg_path: str, ffprobe_path: str, images=None, audio=None, video_path: str = "", audio_path: str = ""):
        out_dir = _output_dir()
        stamp = int(time.time())
        prefix = Path(str(filename_prefix or "mux").replace("\\", "/")).name or "mux"
        output_path = out_dir / f"{prefix}_{stamp}.mp4"
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            if video_path and Path(video_path).exists():
                source_video = Path(video_path)
            elif images is not None:
                frame_pattern = _write_frames(images, tmp_path)
                source_video = tmp_path / "source.mp4"
                _run([ffmpeg_path or "ffmpeg", "-y", "-framerate", str(float(fps)), "-i", frame_pattern, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source_video)])
            else:
                raise RuntimeError("请连接图片帧或填写视频路径。")

            if audio_path and Path(audio_path).exists():
                source_audio = Path(audio_path)
            elif audio is not None:
                source_audio = tmp_path / "source.wav"
                _write_audio_wav(audio, source_audio)
            else:
                raise RuntimeError("请连接 AUDIO 或填写音频路径。")

            _run([ffmpeg_path or "ffmpeg", "-y", "-i", str(source_video), "-i", str(source_audio), "-shortest", "-c:v", "copy", "-c:a", "aac", str(output_path)])
        info = GJJ_VideoInfo().probe(str(output_path), ffprobe_path)
        return (str(output_path), float(info[5]), int(info[4]))


NODE_CLASS_MAPPINGS = {
    "GJJ_VideoInfo": GJJ_VideoInfo,
    "GJJ_VideoFramesLoader": GJJ_VideoFramesLoader,
    "GJJ_FFmpegMuxAudioVideo": GJJ_FFmpegMuxAudioVideo,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_VideoInfo": "GJJ · 🎞️ 视频信息读取",
    "GJJ_VideoFramesLoader": "GJJ · 🎞️ 视频抽帧",
    "GJJ_FFmpegMuxAudioVideo": "GJJ · 🔊 音视频合并",
}
