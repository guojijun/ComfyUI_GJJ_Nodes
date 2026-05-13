from __future__ import annotations

import datetime
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
from typing import Any

import numpy as np
import torch

import folder_paths
import comfy
from comfy.utils import ProgressBar
from PIL import Image, ExifTags

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_VHSVideoCombine"


class MultiInput(str):
    def __new__(cls, string: str, allowed_types="*"):
        instance = super().__new__(cls, string)
        instance.allowed_types = allowed_types
        return instance

    def __ne__(self, other):
        if self.allowed_types == "*" or other == "*":
            return False
        return other not in self.allowed_types


class ContainsAll(dict):
    def __contains__(self, other):
        return True

    def __getitem__(self, key):
        return super().get(key, (None, {}))


imageOrLatent = MultiInput("IMAGE", ["IMAGE", "LATENT", GJJ_BATCH_IMAGE_TYPE, "VIDEO"])
floatOrInt = MultiInput("FLOAT", ["FLOAT", "INT"])


def tensor_to_bytes(image):
    if image.dtype == torch.float32:
        image = torch.clamp(image, 0.0, 1.0)
        image = 255.0 * image
    image = image.to(torch.uint8)
    return image.cpu().numpy()


def tensor_to_shorts(image):
    image = torch.clamp(image, 0.0, 1.0)
    image = 65535.0 * image
    image = image.to(torch.uint16)
    return image.cpu().numpy()


def to_pingpong(images):
    first = images[0]
    rest = images[1:]
    yield from images
    yield from reversed(rest)
    yield first


def get_ffmpeg_path():
    if "GJJ_FORCE_FFMPEG_PATH" in os.environ:
        return os.environ.get("GJJ_FORCE_FFMPEG_PATH")
    ffmpeg_paths = []
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        ffmpeg_paths.append(get_ffmpeg_exe())
    except ImportError:
        pass
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg is not None:
        ffmpeg_paths.append(system_ffmpeg)
    if os.path.isfile("ffmpeg"):
        ffmpeg_paths.append(os.path.abspath("ffmpeg"))
    if os.path.isfile("ffmpeg.exe"):
        ffmpeg_paths.append(os.path.abspath("ffmpeg.exe"))
    if ffmpeg_paths:
        return max(ffmpeg_paths, key=lambda p: 0)
    return None


def get_video_formats():
    return {
        "video/h264-mp4": {
            "extension": "mp4",
            "horizon_default": 8,
            "main_pass": [
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "22",
                "-pix_fmt", "yuv420p",
                "-color_range", "tv",
                "-colorspace", "bt709",
                "-color_primaries", "bt709",
                "-color_trc", "bt709",
            ],
            "fake_trc": "bt709",
        },
        "video/h264-mkv": {
            "extension": "mkv",
            "main_pass": [
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "22",
                "-pix_fmt", "yuv420p",
            ],
        },
        "video/proRes": {
            "extension": "mov",
            "main_pass": [
                "-c:v", "prores_ks",
                "-profile:v", "1",
                "-pix_fmt", "yuv422p10le",
            ],
            "input_color_depth": "16bit",
        },
        "video/av1-mp4": {
            "extension": "mp4",
            "main_pass": [
                "-c:v", "libaom-av1",
                "-crf", "30",
                "-pix_fmt", "yuv420p10le",
            ],
            "input_color_depth": "16bit",
        },
        "video/gif": {
            "extension": "gif",
            "main_pass": [
                "-vf", "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse,dither=sierra2_4a",
            ],
            "pre_pass": [
                "-lavfi", "palettegen=stats_mode=diff",
            ],
            "input_color_depth": "8bit",
        },
    }


ffmpeg_path = get_ffmpeg_path()


def apply_format_widgets(format_ext, kwargs):
    video_format = kwargs.get(format_ext, {})
    if isinstance(video_format, str):
        video_format = json.loads(video_format)
    video_format["extension"] = format_ext
    return video_format


def merge_filter_args(args, key="-filter_complex"):
    if key not in args:
        return
    index = args.index(key)
    if args[index + 1] == "":
        args.pop(index)
        args.pop(index)
    else:
        arg = args[index + 1]
        if not isinstance(arg, list):
            arg = [arg]
        args[index] = "-filter_complex"
        args[index + 1] = ";".join(filter(None, arg))


def ffmpeg_process(args, video_format, video_metadata, file_path, env):
    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.PIPE,
        env=env,
    )
    while True:
        image_data = yield
        if image_data is None:
            proc.stdin.write(b"")
            proc.stdin.close()
            break
        proc.stdin.write(image_data)
    proc.wait()
    stderr = proc.stderr.read()
    if proc.returncode != 0:
        raise Exception("Error in ffmpeg: " + stderr.decode())
    return video_format.get("total_frames", 0)


def gifski_process(args, dimensions, frame_rate, video_format, file_path, env):
    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.PIPE,
        env=env,
    )
    while True:
        image_data = yield
        if image_data is None:
            proc.stdin.write(b"")
            proc.stdin.close()
            break
        proc.stdin.write(image_data)
    proc.wait()
    stderr = proc.stderr.read()
    if proc.returncode != 0:
        raise Exception("Error in gifski: " + stderr.decode())
    return video_format.get("total_frames", 0)


ENCODE_ARGS = ("ascii", "replace")


class GJJ_VHSVideoCombine:
    CATEGORY = "GJJ/视频"
    FUNCTION = "combine_video"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "复刻 Video Helper Suite 的 Video Combine 🎥🅥🅗🅢 节点："
        "支持将 IMAGE/LATENT 序列合成为 GIF、WEBP 或 FFmpeg 视频格式，"
        "支持音频嵌入，产出官方 VIDEO 对象。"
    )
    SEARCH_ALIASES = [
        "Video Combine",
        "VHS Video Combine",
        "视频合成",
        "图片合成视频",
        "视频合并",
        "导出视频",
        "导出GIF",
    ]
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频",)
    OUTPUT_TOOLTIPS = ("官方 VIDEO 输出，可继续接到 Save Video、视频裁切或其它视频节点。",)

    @classmethod
    def INPUT_TYPES(cls):
        ffmpeg_formats = list(get_video_formats().keys())
        format_widgets = {}
        format_widgets["image/webp"] = [["lossless", "BOOLEAN", {"default": True}]]
        return {
            "required": {
                "images": (
                    imageOrLatent,
                    {"display_name": "图像", "tooltip": "支持 IMAGE batch、LATENT、VIDEO。"},
                ),
                "frame_rate": (
                    floatOrInt,
                    {"default": 8, "min": 1, "step": 1, "display_name": "帧率"},
                ),
                "loop_count": (
                    "INT",
                    {"default": 0, "min": 0, "max": 100, "step": 1, "display_name": "循环次数"},
                ),
                "filename_prefix": (
                    "STRING",
                    {"default": "AnimateDiff", "display_name": "文件名前缀"},
                ),
                "format": (
                    ["image/gif", "image/webp"] + ffmpeg_formats,
                    {"formats": format_widgets, "display_name": "输出格式"},
                ),
                "pingpong": (
                    "BOOLEAN",
                    {"default": False, "display_name": "往返播放"},
                ),
                "save_output": (
                    "BOOLEAN",
                    {"default": True, "display_name": "保存到输出目录"},
                ),
            },
            "optional": {
                "audio": ("AUDIO", {"display_name": "音频"}),
                "vae": ("VAE", {"display_name": "VAE 解码器"}),
            },
            "hidden": ContainsAll({
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            }),
        }

    def combine_video(
        self,
        frame_rate: int,
        loop_count: int,
        images=None,
        latents=None,
        filename_prefix="AnimateDiff",
        format="image/gif",
        pingpong=False,
        save_output=True,
        prompt=None,
        extra_pnginfo=None,
        audio=None,
        unique_id=None,
        manual_format_widgets=None,
        vae=None,
        **kwargs
    ):
        if latents is not None:
            images = latents
        if images is None:
            return ((),)
        if vae is not None:
            if isinstance(images, dict):
                images = images["samples"]
            else:
                vae = None

        if isinstance(images, torch.Tensor) and images.size(0) == 0:
            return ((),)
        num_frames = len(images)
        pbar = ProgressBar(num_frames)

        if vae is not None:
            downscale_ratio = getattr(vae, "downscale_ratio", 8)
            width = images.size(-1) * downscale_ratio
            height = images.size(-2) * downscale_ratio
            frames_per_batch = (1920 * 1080 * 16) // (width * height) or 1

            def batched(it, n):
                while batch := tuple(itertools.islice(it, n)):
                    yield batch

            def batched_encode(images, vae, frames_per_batch):
                for batch in batched(iter(images), frames_per_batch):
                    image_batch = torch.from_numpy(np.array(batch))
                    yield from vae.decode(image_batch)

            images = batched_encode(images, vae, frames_per_batch)
            first_image = next(images)
            images = itertools.chain([first_image], images)
            while len(first_image.shape) > 3:
                first_image = first_image[0]
        else:
            first_image = images[0]
            images = iter(images)

        output_dir = (
            folder_paths.get_output_directory()
            if save_output
            else folder_paths.get_temp_directory()
        )
        (
            full_output_folder,
            filename,
            _,
            subfolder,
            _,
        ) = folder_paths.get_save_image_path(filename_prefix, output_dir)
        output_files = []

        metadata = Image.Exif()
        video_metadata = {}
        if prompt is not None:
            metadata.add_text("prompt", json.dumps(prompt))
            video_metadata["prompt"] = json.dumps(prompt)
        if extra_pnginfo is not None:
            for x in extra_pnginfo:
                metadata.add_text(x, json.dumps(extra_pnginfo[x]))
                video_metadata[x] = extra_pnginfo[x]
            extra_options = extra_pnginfo.get("workflow", {}).get("extra", {})
        else:
            extra_options = {}
        metadata.add_text("CreationTime", datetime.datetime.now().isoformat(" ")[:19])

        max_counter = 0
        matcher = re.compile(f"{re.escape(filename)}_(\\d+)\\D*\\..+", re.IGNORECASE)
        for existing_file in os.listdir(full_output_folder):
            match = matcher.fullmatch(existing_file)
            if match:
                file_counter = int(match.group(1))
                if file_counter > max_counter:
                    max_counter = file_counter
        counter = max_counter + 1

        first_image_file = f"{filename}_{counter:05}.png"
        file_path = os.path.join(full_output_folder, first_image_file)
        if extra_options.get("GJJ_MetadataImage", True) != False:
            Image.fromarray(tensor_to_bytes(first_image)).save(
                file_path,
                pnginfo=metadata,
                compress_level=4,
            )
        output_files.append(file_path)

        format_type, format_ext = format.split("/")
        if format_type == "image":
            image_kwargs = {}
            if format_ext == "gif":
                image_kwargs["disposal"] = 2
            if format_ext == "webp":
                exif = Image.Exif()
                exif[ExifTags.IFD.Exif] = {36867: datetime.datetime.now().isoformat(" ")[:19]}
                image_kwargs["exif"] = exif
                image_kwargs["lossless"] = kwargs.get("lossless", True)
            file = f"{filename}_{counter:05}.{format_ext}"
            file_path = os.path.join(full_output_folder, file)
            if pingpong:
                images = to_pingpong(list(images))
            def frames_gen(images):
                for i in images:
                    pbar.update(1)
                    yield Image.fromarray(tensor_to_bytes(i))
            frames = frames_gen(images)
            next(frames).save(
                file_path,
                format=format_ext.upper(),
                save_all=True,
                append_images=list(frames),
                duration=round(1000 / frame_rate),
                loop=loop_count,
                compress_level=4,
                **image_kwargs
            )
            output_files.append(file_path)
        else:
            if ffmpeg_path is None:
                raise ProcessLookupError(
                    "ffmpeg is required for video outputs and could not be found.\n"
                    "In order to use video outputs, you must either:\n"
                    "- Install imageio-ffmpeg with pip,\n"
                    "- Place a ffmpeg executable in the current directory, or\n"
                    "- Install ffmpeg and add it to the system path."
                )

            if manual_format_widgets is not None:
                kwargs.update(manual_format_widgets)

            has_alpha = first_image.shape[-1] == 4
            kwargs["has_alpha"] = has_alpha
            video_format = apply_format_widgets(format_ext, kwargs)
            dim_alignment = video_format.get("dim_alignment", 2)

            if (first_image.shape[1] % dim_alignment) or (first_image.shape[0] % dim_alignment):
                to_pad = (-first_image.shape[1] % dim_alignment, -first_image.shape[0] % dim_alignment)
                padding = (to_pad[0] // 2, to_pad[0] - to_pad[0] // 2, to_pad[1] // 2, to_pad[1] - to_pad[1] // 2)
                padfunc = torch.nn.ReplicationPad2d(padding)

                def pad(image):
                    image = image.permute((2, 0, 1))
                    padded = padfunc(image.to(dtype=torch.float32))
                    return padded.permute((1, 2, 0))

                images = map(pad, images)
                dimensions = (-first_image.shape[1] % dim_alignment + first_image.shape[1],
                             -first_image.shape[0] % dim_alignment + first_image.shape[0])
            else:
                dimensions = (first_image.shape[1], first_image.shape[0])

            if pingpong:
                images = to_pingpong(list(images))
                if num_frames > 2:
                    num_frames += num_frames - 2
                    pbar.total = num_frames

            if loop_count > 0:
                loop_args = ["-vf", "loop=loop=" + str(loop_count) + ":size=" + str(num_frames)]
            else:
                loop_args = []

            if video_format.get("input_color_depth", "8bit") == "16bit":
                images = map(tensor_to_shorts, images)
                i_pix_fmt = "rgba64" if has_alpha else "rgb48"
            else:
                images = map(tensor_to_bytes, images)
                i_pix_fmt = "rgba" if has_alpha else "rgb24"

            file = f"{filename}_{counter:05}.{video_format['extension']}"
            file_path = os.path.join(full_output_folder, file)
            bitrate_arg = []
            bitrate = video_format.get("bitrate")
            if bitrate is not None:
                bitrate_arg = ["-b:v", str(bitrate) + "M" if video_format.get("megabit") == "True" else str(bitrate) + "K"]

            args = [
                ffmpeg_path, "-v", "error", "-f", "rawvideo", "-pix_fmt", i_pix_fmt,
                "-color_range", "pc", "-colorspace", "rgb", "-color_primaries", "bt709",
                "-color_trc", video_format.get("fake_trc", "iec61966-2-1"),
                "-s", f"{dimensions[0]}x{dimensions[1]}", "-r", str(frame_rate), "-i", "-"
            ] + loop_args

            images = map(lambda x: x.tobytes(), images)
            env = os.environ.copy()
            if "environment" in video_format:
                env.update(video_format["environment"])

            if "pre_pass" in video_format:
                images = [b"".join(images)]
                os.makedirs(folder_paths.get_temp_directory(), exist_ok=True)
                in_args_len = args.index("-i") + 2
                pre_pass_args = args[:in_args_len] + video_format["pre_pass"]
                merge_filter_args(pre_pass_args)
                try:
                    subprocess.run(pre_pass_args, input=images[0], env=env, capture_output=True, check=True)
                except subprocess.CalledProcessError as e:
                    raise Exception("An error occurred in the ffmpeg prepass:\n" + e.stderr.decode(*ENCODE_ARGS))

            if "inputs_main_pass" in video_format:
                in_args_len = args.index("-i") + 2
                args = args[:in_args_len] + video_format["inputs_main_pass"] + args[in_args_len:]

            if "gifski_pass" in video_format:
                format = "image/gif"
                output_process = gifski_process(args, dimensions, frame_rate, video_format, file_path, env)
                audio = None
            else:
                args += video_format["main_pass"] + bitrate_arg
                merge_filter_args(args)
                output_process = ffmpeg_process(args, video_format, video_metadata, file_path, env)

            output_process.send(None)
            for image in images:
                pbar.update(1)
                output_process.send(image)
            try:
                total_frames_output = output_process.send(None)
                output_process.send(None)
            except StopIteration:
                pass

            output_files.append(file_path)

            a_waveform = None
            if audio is not None:
                try:
                    a_waveform = audio["waveform"]
                except:
                    pass
            if a_waveform is not None:
                output_file_with_audio = f"{filename}_{counter:05}-audio.{video_format['extension']}"
                output_file_with_audio_path = os.path.join(full_output_folder, output_file_with_audio)
                if "audio_pass" not in video_format:
                    video_format["audio_pass"] = ["-c:a", "libopus"]

                channels = audio["waveform"].size(1)
                min_audio_dur = total_frames_output / frame_rate + 1
                if video_format.get("trim_to_audio", "False") != "False":
                    apad = []
                else:
                    apad = ["-af", "apad=whole_dur=" + str(min_audio_dur)]

                mux_args = [
                    ffmpeg_path, "-v", "error", "-n", "-i", file_path,
                    "-ar", str(audio["sample_rate"]), "-ac", str(channels),
                    "-f", "f32le", "-i", "-", "-c:v", "copy"
                ] + video_format["audio_pass"] + apad + ["-shortest", output_file_with_audio_path]

                audio_data = audio["waveform"].squeeze(0).transpose(0, 1).numpy().tobytes()
                merge_filter_args(mux_args, "-af")
                try:
                    res = subprocess.run(mux_args, input=audio_data, env=env, capture_output=True, check=True)
                except subprocess.CalledProcessError as e:
                    raise Exception("An error occurred in the ffmpeg subprocess:\n" + e.stderr.decode(*ENCODE_ARGS))
                if res.stderr:
                    print(res.stderr.decode(*ENCODE_ARGS), end="", file=sys.stderr)
                output_files.append(output_file_with_audio_path)
                file = output_file_with_audio

        if extra_options.get("GJJ_KeepIntermediate", True) == False:
            for intermediate in output_files[1:-1]:
                if os.path.exists(intermediate):
                    os.remove(intermediate)

        preview = {
            "filename": file,
            "subfolder": subfolder,
            "type": "output" if save_output else "temp",
            "format": format,
            "frame_rate": frame_rate,
            "workflow": first_image_file,
            "fullpath": output_files[-1],
        }
        if num_frames == 1 and "png" in format and "%03d" in file:
            preview["format"] = "image/png"
            preview["filename"] = file.replace("%03d", "001")

        return {"ui": {"gifs": [preview]}, "result": (output_files,)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VHSVideoCombine}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🎥🅥🅗🅢 Video Combine"}
