import logging
import asyncio
import json
import base64
import io as _io
import math
import re

import numpy as np
import torch
import torch.nn.functional as F
import av
from PIL import Image

import os
import platform

import folder_paths
import comfy.model_management
from server import PromptServer
from aiohttp import web

from comfy_api.latest import io
from .gjj_ltx_director_prompt_relay import (
    get_raw_tokenizer,
    map_token_indices,
    build_segments,
    create_mask_fn,
    distribute_segment_lengths,
)

from .gjj_ltx_director_patches import detect_model_type, apply_patches
from .common_utils.prompt_translation import COMMON_PROMPT_TRANSLATE_API_PATH, register_prompt_translation_api

log = logging.getLogger(__name__)

register_prompt_translation_api((COMMON_PROMPT_TRANSLATE_API_PATH,))

# Setup global event loop exception handler to silence ConnectionResetError (WinError 10054/10053) on Windows
try:
    loop = None
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        try:
            loop = asyncio.get_event_loop_policy().get_event_loop()
        except Exception:
            pass

    if loop is not None:
        old_handler = loop.get_exception_handler()

        def silence_connection_reset_handler(loop, context):
            exception = context.get('exception')
            if (isinstance(exception, (ConnectionResetError, ConnectionAbortedError)) or
                (isinstance(exception, OSError) and getattr(exception, 'winerror', None) in (10054, 10053))):
                # Suppress WinError 10054 and WinError 10053 tracebacks in logging
                return
            if old_handler:
                old_handler(loop, context)
            else:
                loop.default_exception_handler(context)

        loop.set_exception_handler(silence_connection_reset_handler)
except Exception:
    pass

# Custom socket type shared with LTXSequencer
GuideData = io.Custom("GUIDE_DATA")
MotionGuideData = io.Custom("MOTION_GUIDE_DATA")
DirectorMediaInput = io.Custom("GJJ_BATCH_IMAGE,IMAGE,VIDEO,AUDIO")
DirectorGridInput = io.Custom("GJJ_BATCH_IMAGE,IMAGE")

# --- File Check Endpoint for Deduplication ---
@PromptServer.instance.routes.get("/gjj/ltx_director/check_file")
async def gjj_ltx_director_check_file(request):
    filename = request.query.get("filename", "")
    file_size = request.query.get("size", "")
    if not filename:
        return web.json_response({"exists": False})

    upload_dir = folder_paths.get_input_directory()
    temp_dir = os.path.join(upload_dir, "GJJ_LTXDirector")

    # 1. Check if the exact filename exists in the GJJ workspace or root input dir
    possible_paths = [
        os.path.join(temp_dir, filename),
        os.path.join(upload_dir, filename)
    ]

    found_path = None
    for p in possible_paths:
        if os.path.exists(p) and os.path.isfile(p):
            if file_size:
                try:
                    if os.path.getsize(p) == int(file_size):
                        found_path = p
                        break
                except ValueError:
                    found_path = p
                    break
            else:
                found_path = p
                break

    if found_path:
        rel_name = os.path.relpath(found_path, upload_dir).replace('\\', '/')
        return web.json_response({"exists": True, "name": rel_name})

    # 2. Suffix search if exact match not found
    base_name = os.path.basename(filename)
    suffix = f"_{base_name}"
    try:
        for search_dir in [temp_dir, upload_dir]:
            if os.path.exists(search_dir):
                for f_name in os.listdir(search_dir):
                    if f_name.endswith(suffix) or f_name == base_name:
                        pot_path = os.path.join(search_dir, f_name)
                        if os.path.isfile(pot_path):
                            if file_size:
                                try:
                                    if os.path.getsize(pot_path) == int(file_size):
                                        rel_name = os.path.relpath(pot_path, upload_dir).replace('\\', '/')
                                        return web.json_response({"exists": True, "name": rel_name})
                                except ValueError:
                                    pass
                            else:
                                rel_name = os.path.relpath(pot_path, upload_dir).replace('\\', '/')
                                return web.json_response({"exists": True, "name": rel_name})
    except Exception as e:
        log.warning(f"[LTXDirector] Error listing input directory: {e}")

    return web.json_response({"exists": False})


def read_wav_peaks(wav_path):
    import wave
    peaks = []
    with wave.open(wav_path, 'rb') as w:
        n_frames = w.getnframes()
        if n_frames > 0:
            frames_bytes = w.readframes(n_frames)
            samples = np.frombuffer(frames_bytes, dtype=np.int16)
            num_peaks = 200
            step = max(1, len(samples) // num_peaks)
            for i in range(num_peaks):
                chunk = samples[i * step : (i + 1) * step]
                if len(chunk) > 0:
                    max_val = np.max(np.abs(chunk)) / 32767.0
                    peaks.append(float(max_val))
                else:
                    peaks.append(0.0)
        else:
            peaks = [0.0] * 200
    return peaks


def extract_audio_from_video(video_path):
    import wave
    try:
        base, _ = os.path.splitext(video_path)
        output_wav = base + "_extracted_audio.wav"

        # Check if already exists, is not empty, and has the correct 44100Hz sample rate
        if os.path.exists(output_wav) and os.path.getsize(output_wav) > 44:
            try:
                with wave.open(output_wav, 'rb') as w_check:
                    if w_check.getframerate() == 44100:
                        peaks = read_wav_peaks(output_wav)
                        input_dir = folder_paths.get_input_directory()
                        rel_output = os.path.relpath(output_wav, input_dir).replace('\\', '/')
                        return rel_output, peaks
            except Exception:
                pass

        # Decode the video using PyAV
        with av.open(video_path) as container:
            if not container.streams.audio:
                return None, None
            stream = container.streams.audio[0]

            # Setup resampler to 44100Hz, Mono, signed 16-bit integer (s16)
            resampler = av.AudioResampler(
                format='s16',
                layout='mono',
                rate=44100,
            )

            audio_bytes = bytearray()

            for frame in container.decode(stream):
                for resampled_frame in resampler.resample(frame):
                    arr = resampled_frame.to_ndarray()
                    audio_bytes.extend(arr.tobytes())

            # Flush resampler
            for resampled_frame in resampler.resample(None):
                arr = resampled_frame.to_ndarray()
                audio_bytes.extend(arr.tobytes())

            if not audio_bytes:
                return None, None

            # Write WAV file
            with wave.open(output_wav, 'wb') as w:
                w.setnchannels(1)
                w.setsampwidth(2) # 16-bit
                w.setframerate(44100)
                w.writeframes(audio_bytes)

        # Calculate peaks
        peaks = []
        samples = np.frombuffer(audio_bytes, dtype=np.int16)
        num_peaks = 200
        step = max(1, len(samples) // num_peaks)
        for i in range(num_peaks):
            chunk = samples[i * step : (i + 1) * step]
            if len(chunk) > 0:
                max_val = np.max(np.abs(chunk)) / 32767.0
                peaks.append(float(max_val))
            else:
                peaks.append(0.0)

        input_dir = folder_paths.get_input_directory()
        rel_output = os.path.relpath(output_wav, input_dir).replace('\\', '/')
        return rel_output, peaks
    except Exception as e:
        print(f"[LTXDirector] Server audio extraction failed: {e}")
        return None, None


def get_audio_peaks(audio_path):
    import wave
    # If it is already a WAV file, read peaks directly
    _, ext = os.path.splitext(audio_path)
    if ext.lower() == ".wav":
        try:
            return read_wav_peaks(audio_path)
        except Exception:
            pass # fallback to PyAV

    # Use PyAV to decode and resample the audio file
    try:
        with av.open(audio_path) as container:
            if not container.streams.audio:
                return None
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(
                format='s16',
                layout='mono',
                rate=8000,
            )
            audio_bytes = bytearray()
            for frame in container.decode(stream):
                for resampled_frame in resampler.resample(frame):
                    arr = resampled_frame.to_ndarray()
                    audio_bytes.extend(arr.tobytes())
            for resampled_frame in resampler.resample(None):
                arr = resampled_frame.to_ndarray()
                audio_bytes.extend(arr.tobytes())

            if not audio_bytes:
                return None

            peaks = []
            samples = np.frombuffer(audio_bytes, dtype=np.int16)
            num_peaks = 200
            step = max(1, len(samples) // num_peaks)
            for i in range(num_peaks):
                chunk = samples[i * step : (i + 1) * step]
                if len(chunk) > 0:
                    max_val = np.max(np.abs(chunk)) / 32767.0
                    peaks.append(float(max_val))
                else:
                    peaks.append(0.0)
            return peaks
    except Exception as e:
        print(f"[LTXDirector] Failed to get audio peaks via PyAV: {e}")
        return None


@PromptServer.instance.routes.get("/gjj/ltx_director/get_audio")
async def gjj_ltx_director_get_audio(request):
    filename = request.query.get("filename")
    if not filename:
        return web.json_response({"error": "Missing filename"}, status=400)

    upload_dir = folder_paths.get_input_directory()

    clean_filename = filename.replace('\\', '/')
    file_path = os.path.join(upload_dir, clean_filename)
    if not os.path.exists(file_path):
        basename = os.path.basename(clean_filename)
        temp_path = os.path.join(upload_dir, "GJJ_LTXDirector", basename)
        if os.path.exists(temp_path):
            file_path = temp_path
        else:
            file_path = os.path.join(upload_dir, basename)

    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        return web.json_response({"error": "File not found"}, status=404)

    _, ext = os.path.splitext(file_path)
    is_audio = ext.lower() in [".wav", ".mp3", ".ogg", ".flac", ".m4a"]

    if is_audio:
        peaks = None
        try:
            peaks = get_audio_peaks(file_path)
        except Exception as e:
            print(f"[LTXDirector] Failed to get audio peaks for audio file: {e}")

        rel_path = os.path.relpath(file_path, upload_dir).replace('\\', '/')
        return web.json_response({
            "audio_file": rel_path,
            "peaks": peaks
        })

    audio_file, peaks = None, None
    try:
        loop = asyncio.get_event_loop()
        audio_file, peaks = await loop.run_in_executor(None, extract_audio_from_video, file_path)
    except Exception as e:
        print(f"[LTXDirector] Error extracting audio: {e}")

    return web.json_response({
        "audio_file": audio_file,
        "peaks": peaks
    })


@PromptServer.instance.routes.get("/gjj/ltx_director/open_folder")
async def gjj_ltx_director_open_folder(request):
    upload_dir = os.path.join(folder_paths.get_input_directory(), "GJJ_LTXDirector")
    os.makedirs(upload_dir, exist_ok=True)
    try:
        if hasattr(os, "startfile"):
            os.startfile(upload_dir)
        else:
            import webbrowser
            webbrowser.open(os.path.abspath(upload_dir))
        return web.json_response({"success": True})
    except Exception as e:
        print(f"[LTXDirector] Failed to open workspace folder: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


def _read_and_write_file_chunk(file, file_path, mode):
    chunk_bytes = file.file.read()
    with open(file_path, mode) as f:
        f.write(chunk_bytes)


# --- LTX Director Chunked Video Upload Endpoint ---
# Bypasses the 413 Payload Too Large error for large video files.
# This endpoint is self-contained and independent of any other node.
@PromptServer.instance.routes.post("/gjj/ltx_director/upload_chunk")
async def gjj_ltx_director_upload_chunk(request):
    post = await request.post()
    file = post.get("file")
    filename = post.get("filename")
    chunk_index = int(post.get("chunk_index"))
    total_chunks = int(post.get("total_chunks"))

    upload_dir = os.path.join(folder_paths.get_input_directory(), "GJJ_LTXDirector")
    os.makedirs(upload_dir, exist_ok=True)

    # Sanitize filename to prevent path traversal attacks (e.g. ../../etc/passwd)
    filename = os.path.basename(filename)
    file_path = os.path.join(upload_dir, filename)

    # Belt-and-suspenders: confirm the resolved path is still inside the upload directory
    if not os.path.realpath(file_path).startswith(os.path.realpath(upload_dir)):
        return web.json_response({"error": "Invalid filename"}, status=400)

    # Append chunk to file (write fresh on first chunk, append on subsequent)
    mode = "ab" if chunk_index > 0 else "wb"

    # Offload the blocking read/write disk I/O to a thread executor
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _read_and_write_file_chunk, file, file_path, mode)

    if chunk_index == total_chunks - 1:
        audio_file, peaks = None, None
        try:
            audio_file, peaks = await loop.run_in_executor(None, extract_audio_from_video, file_path)
        except Exception as e:
            print(f"[LTXDirector] Error in final chunk audio extraction: {e}")

        return web.json_response({
            "name": f"GJJ_LTXDirector/{filename}",
            "audio_file": audio_file,
            "peaks": peaks
        })
    return web.json_response({"status": "ok"})



def _load_image_tensor(seg: dict) -> torch.Tensor:
    """Decode an image from the ComfyUI input folder (if imageFile provided) or fallback to base64
    to a ComfyUI-style image tensor of shape [1, H, W, 3], float32 in [0, 1]."""
    if seg.get("imageFile"):
        file_path = os.path.join(folder_paths.get_input_directory(), seg["imageFile"])
        if os.path.exists(file_path):
            img = Image.open(file_path).convert("RGB")
            arr = np.array(img, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)

    b64_str = seg.get("imageB64", "")
    if not b64_str or b64_str.startswith("/view?"):
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)

    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]

    try:
        img_bytes = base64.b64decode(b64_str)
        img = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        arr = np.array(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)
    except:
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)

def _load_video_tensor(seg: dict, frame_rate: float) -> torch.Tensor:
    """Extracts a sequence of frames from a video file based on the segment's trim parameters,
    and returns them as an [N, H, W, 3] float32 tensor."""
    file_path = os.path.join(folder_paths.get_input_directory(), seg.get("imageFile", ""))

    if not os.path.exists(file_path):
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)

    trim_start_frames = float(seg.get("trimStart", 0))
    length_frames = float(seg.get("length", 1))
    start_sec = trim_start_frames / frame_rate

    frames = []
    try:
        with av.open(file_path) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"

            # Seek slightly before target to hit a keyframe
            if stream.time_base:
                seek_pts = int((max(0, start_sec - 0.5)) / float(stream.time_base))
            else:
                seek_pts = int((max(0, start_sec - 0.5)) * av.time_base)

            container.seek(seek_pts, stream=stream, backward=True)

            for frame in container.decode(stream):
                frame_time = frame.time
                if frame_time is None and frame.pts is not None and stream.time_base:
                    frame_time = float(frame.pts * stream.time_base)

                if frame_time is None:
                    frame_time = 0.0

                if frame_time < start_sec - 0.01:
                    continue

                frames.append(frame.to_ndarray(format='rgb24'))

                if len(frames) >= int(length_frames):
                    break
    except Exception as e:
        log.warning(f"[PromptRelay] Video extract error: {e}")

    if not frames:
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)

    frames_np = np.array(frames, dtype=np.float32) / 255.0
    return torch.from_numpy(frames_np)


def _ensure_bhwc_rgb_tensor(value: torch.Tensor) -> torch.Tensor:
    tensor = value.detach().float().clamp(0.0, 1.0)
    if tensor.ndim == 3:
        if int(tensor.shape[-1]) in (1, 3, 4):
            tensor = tensor.unsqueeze(0)
        elif int(tensor.shape[0]) in (1, 3, 4):
            tensor = tensor.movedim(0, -1).unsqueeze(0)
        else:
            raise RuntimeError(f"素材图维度不支持：{tuple(tensor.shape)}")
    if tensor.ndim != 4:
        raise RuntimeError(f"素材图维度不支持：{tuple(tensor.shape)}")
    if int(tensor.shape[-1]) not in (1, 3, 4) and int(tensor.shape[1]) in (1, 3, 4):
        tensor = tensor.movedim(1, -1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels > 3:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"素材图通道数不支持：{channels}")
    return tensor.contiguous()


def _split_runtime_images(value) -> list[torch.Tensor]:
    if value is None:
        return []
    if isinstance(value, torch.Tensor):
        tensor = _ensure_bhwc_rgb_tensor(value)
        return [tensor[index:index + 1].contiguous() for index in range(int(tensor.shape[0]))]
    if isinstance(value, dict):
        images: list[torch.Tensor] = []
        for item in value.values():
            images.extend(_split_runtime_images(item))
        return images
    if isinstance(value, (list, tuple)):
        images: list[torch.Tensor] = []
        for item in value:
            images.extend(_split_runtime_images(item))
        return images
    return []


def _parse_grid_layout_value(value) -> tuple[int, int]:
    match = re.match(r"^\s*(\d+)\s*x\s*(\d+)\s*$", str(value or ""), re.I)
    if not match:
        return 2, 2
    return max(1, int(match.group(1))), max(1, int(match.group(2)))


def _split_runtime_grid_images(value, grid_layout="2x2", grid_edge_cut=0) -> list[torch.Tensor]:
    columns, rows = _parse_grid_layout_value(grid_layout)
    edge = max(0.0, min(45.0, float(grid_edge_cut or 0))) / 100.0
    crops: list[torch.Tensor] = []
    for image in _split_runtime_images(value):
        h = int(image.shape[1])
        w = int(image.shape[2])
        cell_w = w / columns
        cell_h = h / rows
        for row in range(rows):
            for col in range(columns):
                cut_x = cell_w * edge
                cut_y = cell_h * edge
                left = max(0, min(w - 1, int(round(col * cell_w + cut_x))))
                top = max(0, min(h - 1, int(round(row * cell_h + cut_y))))
                right = max(left + 1, min(w, int(round((col + 1) * cell_w - cut_x))))
                bottom = max(top + 1, min(h, int(round((row + 1) * cell_h - cut_y))))
                crops.append(image[:, top:bottom, left:right, :].contiguous())
    return crops


def _runtime_material_segments(material_1=None, material_2=None, grid_material=None, duration_frames=1,
                               grid_layout="2x2", grid_edge_cut=0) -> list[dict]:
    grid_images = _split_runtime_grid_images(grid_material, grid_layout, grid_edge_cut)
    material_images = [*_split_runtime_images(material_1), *_split_runtime_images(material_2)]
    # Follow the visible input order: material 1 -> material 2 -> grid cells.
    # Tensor batches retain their original frame/image order inside each input.
    images = [*material_images, *grid_images]
    if not images:
        return []
    total = max(1, int(duration_frames or 1))
    length = max(1, total // max(1, len(images)))
    segments: list[dict] = []
    cursor = 0
    for index, image in enumerate(images):
        seg_len = length if index < len(images) - 1 else max(1, total - cursor)
        segments.append({
            "id": f"runtime_upstream_{index + 1}",
            "type": "image",
            "start": cursor,
            "length": seg_len,
            "gjjUpstream": True,
            "_runtime_tensor": image,
        })
        cursor += seg_len
    return segments


def _strip_runtime_tensors(value):
    if isinstance(value, torch.Tensor):
        return None
    if isinstance(value, dict):
        return {
            key: _strip_runtime_tensors(item)
            for key, item in value.items()
            if key != "_runtime_tensor"
        }
    if isinstance(value, (list, tuple)):
        return [_strip_runtime_tensors(item) for item in value]
    return value


def _resize_image(tensor: torch.Tensor, target_w: int, target_h: int, method: str, divisible_by: int) -> torch.Tensor:
    """Resize an [N, H, W, 3] float32 tensor to target dimensions using the given method,
    then snap the final dimensions to be divisible by `divisible_by`."""

    def snap(val, div):
        return max(div, (val // div) * div)

    tw = snap(target_w, divisible_by)
    th = snap(target_h, divisible_by)

    N, H, W, C = tensor.shape
    if H == th and W == tw:
        return tensor

    t_nchw = tensor.permute(0, 3, 1, 2)

    if method == "stretch to fit":
        resized = F.interpolate(t_nchw, size=(th, tw), mode="bilinear", align_corners=False)

    elif method == "maintain aspect ratio":
        ratio = min(tw / W, th / H)
        new_w = snap(int(W * ratio), divisible_by)
        new_h = snap(int(H * ratio), divisible_by)
        resized = F.interpolate(t_nchw, size=(new_h, new_w), mode="bilinear", align_corners=False)

    elif method == "pad" or method == "pad green":
        ratio = min(tw / W, th / H)
        new_w = snap(int(W * ratio), divisible_by)
        new_h = snap(int(H * ratio), divisible_by)
        inner = F.interpolate(t_nchw, size=(new_h, new_w), mode="bilinear", align_corners=False)

        pad_l = (tw - new_w) // 2
        pad_t = (th - new_h) // 2

        if method == "pad green":
            resized = torch.zeros((N, C, th, tw), dtype=t_nchw.dtype, device=t_nchw.device)
            # #66FF00 is roughly R: 102/255, G: 255/255, B: 0
            resized[:, 0, :, :] = 102 / 255.0
            resized[:, 1, :, :] = 1.0
            resized[:, 2, :, :] = 0.0
            resized[:, :, pad_t:pad_t+new_h, pad_l:pad_l+new_w] = inner
        else:
            resized = F.pad(inner, (pad_l, tw - new_w - pad_l, pad_t, th - new_h - pad_t), mode="constant", value=0)

    elif method == "crop":
        ratio = max(tw / W, th / H)
        new_w = int(W * ratio)
        new_h = int(H * ratio)
        inner = F.interpolate(t_nchw, size=(new_h, new_w), mode="bilinear", align_corners=False)

        left = (new_w - tw) // 2
        top = (new_h - th) // 2
        resized = inner[:, :, top:top+th, left:left+tw]

    else:
        resized = F.interpolate(t_nchw, size=(th, tw), mode="bilinear", align_corners=False)

    return resized.permute(0, 2, 3, 1)


def _compress_image(tensor: torch.Tensor, crf: int) -> torch.Tensor:
    """Apply H.264 compression artefacts to an [N, H, W, 3] float32 tensor (ComfyUI image format).
    crf=0 means no compression. Uses PyAV to encode/decode frames in-memory."""
    if crf == 0:
        return tensor

    N, H, W, C = tensor.shape

    # Dimensions must be even for H.264
    h = (H // 2) * 2
    w = (W // 2) * 2

    # uint8 [N, H, W, 3]
    tensor_bytes = (tensor[:, :h, :w, :] * 255.0).byte().cpu().numpy()

    try:
        buf = _io.BytesIO()
        container = av.open(buf, mode="w", format="mp4")
        stream = container.add_stream("libx264", rate=24)
        stream.width = w
        stream.height = h
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": str(crf), "preset": "ultrafast"}

        for i in range(N):
            frame = av.VideoFrame.from_ndarray(tensor_bytes[i], format="rgb24")
            for pkt in stream.encode(frame):
                container.mux(pkt)

        for pkt in stream.encode(None):
            container.mux(pkt)

        container.close()

        buf.seek(0)
        container_r = av.open(buf, mode="r")
        decoded = [frame_r.to_ndarray(format="rgb24") for frame_r in container_r.decode(video=0)]
        container_r.close()

        if not decoded:
            return tensor

        decoded_np = np.stack(decoded).astype(np.float32) / 255.0

        # Re-embed into original tensor shape (may have been cropped by even-rounding)
        out = tensor.clone()
        dec_N = min(N, len(decoded))
        out[:dec_N, :h, :w] = torch.from_numpy(decoded_np[:dec_N]).to(tensor.device, tensor.dtype)

        return out

    except Exception as e:
        log.warning("[PromptRelay] img_compression encode/decode failed: %s", e)
        return tensor


def _build_combined_audio(timeline_data_str: str, start_frame: int, duration_frames: int, frame_rate: float, override_audio: bool = False) -> dict:
    """Parses timeline JSON, loads/trims audio directly from memory using PyAV,
    and aligns to a global timeline yielding ComfyUI's format.
    Output length explicitly mimics the timeline's duration_frames length."""
    target_sr = 44100
    total_samples = max(1, int(math.ceil(duration_frames / frame_rate * target_sr)))
    empty_audio = {"waveform": torch.zeros((1, 2, total_samples), dtype=torch.float32), "sample_rate": target_sr}

    if not timeline_data_str:
        return empty_audio

    try:
        data = json.loads(timeline_data_str)
        is_retake = data.get("retakeMode", False)
        if is_retake and data.get("retakeVideo"):
            retake_vid = data.get("retakeVideo")
            audio_segs = [{
                "videoFile": retake_vid.get("imageFile") or retake_vid.get("fileName"),
                "audioFile": retake_vid.get("imageFile") or retake_vid.get("fileName"),
                "start": 0,
                "length": retake_vid.get("videoDurationFrames", duration_frames),
                "trimStart": 0
            }]
            override_audio = True
        elif override_audio:
            audio_segs = data.get("motionSegments", [])
        else:
            audio_segs = data.get("audioSegments", [])
    except Exception:
        return empty_audio

    if not audio_segs:
        return empty_audio

    out_waveform = torch.zeros((2, total_samples), dtype=torch.float32)

    for seg in audio_segs:
        buffer = None
        file_key = "videoFile" if override_audio else "audioFile"
        if seg.get(file_key):
            file_path = os.path.join(folder_paths.get_input_directory(), seg[file_key])
            if not os.path.exists(file_path):
                # Try fallback under the GJJ workspace subfolder
                basename = os.path.basename(seg[file_key])
                fallback_path = os.path.join(folder_paths.get_input_directory(), "GJJ_LTXDirector", basename)
                if os.path.exists(fallback_path):
                    file_path = fallback_path

            if os.path.exists(file_path):
                with open(file_path, "rb") as f:
                    buffer = _io.BytesIO(f.read())

        if not override_audio and not buffer and seg.get("audioB64"):
            b64 = seg.get("audioB64")
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            try:
                audio_bytes = base64.b64decode(b64)
                buffer = _io.BytesIO(audio_bytes)
            except:
                pass

        if not buffer:
            continue

        try:
            clip_frames = []

            # Use PyAV to decode directly from memory buffer
            with av.open(buffer) as container:
                if not container.streams.audio:
                    continue
                stream = container.streams.audio[0]

                # Setup resampler to ensure output is 44.1kHz, Stereo, Float32 Planar
                resampler = av.AudioResampler(
                    format='fltp',
                    layout='stereo',
                    rate=target_sr,
                )

                for frame in container.decode(stream):
                    for resampled_frame in resampler.resample(frame):
                        # to_ndarray() on fltp gives shape (channels, samples)
                        arr = resampled_frame.to_ndarray()
                        clip_frames.append(torch.from_numpy(arr))

                # Flush the resampler to get any remaining samples
                for resampled_frame in resampler.resample(None):
                    arr = resampled_frame.to_ndarray()
                    clip_frames.append(torch.from_numpy(arr))

            if not clip_frames:
                continue

            # Concatenate all frame blocks along the samples dimension (dim 1)
            waveform = torch.cat(clip_frames, dim=1) # Shape: [2, total_clip_samples]

            # Calculate interactive trim boundaries
            trim_start_frames = float(seg.get("trimStart", 0))
            length_frames = float(seg.get("length", 1))
            start_frames = float(seg.get("start", 0))

            if start_frames + length_frames <= start_frame:
                continue

            offset = max(0, start_frame - start_frames)
            trim_start_frames += offset
            length_frames = max(1, length_frames - offset)
            start_frames = max(0, start_frames - start_frame)

            start_sample_src = int(trim_start_frames / frame_rate * target_sr)
            length_samples = int(length_frames / frame_rate * target_sr)
            end_sample_src = start_sample_src + length_samples

            if start_sample_src < 0: start_sample_src = 0
            if end_sample_src > waveform.shape[1]:
                end_sample_src = waveform.shape[1]

            actual_length = end_sample_src - start_sample_src
            if actual_length <= 0: continue

            # Extract the correct segment of the audio
            clip_waveform = waveform[:, start_sample_src:end_sample_src]

            # Position onto the timeline
            start_sample_dst = int(start_frames / frame_rate * target_sr)

            if start_sample_dst >= out_waveform.shape[1]:
                continue

            end_sample_dst = start_sample_dst + actual_length

            # Clip any trailing overflow so we don't index past the timeline bounds
            if end_sample_dst > out_waveform.shape[1]:
                actual_length = out_waveform.shape[1] - start_sample_dst
                clip_waveform = clip_waveform[:, :actual_length]
                end_sample_dst = start_sample_dst + actual_length

            if actual_length <= 0:
                continue

            # Additive composite (allows clips overlapping to sum together naturally)
            out_waveform[:, start_sample_dst:end_sample_dst] += clip_waveform

        except Exception as e:
            log.warning("[PromptRelay] Audio process error for segment %s: %s", seg.get("fileName"), e)
            continue

    return {"waveform": out_waveform.unsqueeze(0), "sample_rate": target_sr}


def _pad_waveform_for_vae(waveform: torch.Tensor, audio_vae) -> torch.Tensor:
    """Keep short audio from being cropped to zero by ComfyUI's VAE wrapper."""
    compression = 1
    compression_getter = getattr(audio_vae, "spacial_compression_encode", None)
    if callable(compression_getter):
        try:
            compression = max(1, int(math.ceil(float(compression_getter()))))
        except (TypeError, ValueError, OverflowError):
            compression = 1

    sample_count = int(waveform.shape[-1])
    minimum_samples = compression
    if sample_count >= minimum_samples:
        return waveform

    padding = minimum_samples - sample_count
    log.warning(
        "[PromptRelay] 音频仅有 %d 个采样，低于当前音频 VAE 的最小编码块 %d；已在末尾补零。",
        sample_count,
        minimum_samples,
    )
    return F.pad(waveform, (0, padding))


def _convert_to_latent_lengths(pixel_lengths, temporal_stride, latent_frames):
    """Convert pixel-space segment lengths to integer latent-space lengths using the
    largest-remainder method. Targets the full `latent_frames` when the pixel sum looks
    like full coverage (within one stride of latent_frames * stride). Otherwise targets
    round(total_pixel / temporal_stride) so partial-coverage timelines stay partial.
    """
    if not pixel_lengths:
        return []
    total_pixel = sum(pixel_lengths)
    if total_pixel <= 0:
        return [1] * len(pixel_lengths)

    naive_total = max(1, round(total_pixel / temporal_stride))
    target_total = min(latent_frames, naive_total)
    # Within one frame of full → user clearly intended full coverage; pin to latent_frames.
    if target_total >= latent_frames - 1:
        target_total = latent_frames

    exact = [p * target_total / total_pixel for p in pixel_lengths]
    result = [int(e) for e in exact]
    diff = target_total - sum(result)
    if diff > 0:
        order = sorted(range(len(exact)), key=lambda i: -(exact[i] - int(exact[i])))
        for k in range(diff):
            result[order[k % len(order)]] += 1

    # Ensure every segment has ≥ 1 latent frame (steal from the largest if needed).
    for i in range(len(result)):
        if result[i] < 1:
            max_idx = max(range(len(result)), key=lambda j: result[j])
            if result[max_idx] > 1:
                result[max_idx] -= 1
                result[i] = 1

    return result


def _encode_relay(model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon):
    for name, val in (("global_prompt", global_prompt),
                      ("local_prompts", local_prompts),
                      ("segment_lengths", segment_lengths)):
        if val is None:
            raise ValueError(
                f"PromptRelay: '{name}' arrived as None. "
                "Likely causes: a stale workflow JSON saved with null, the timeline "
                "editor's web extension failing to load, or an upstream node returning None. "
                "Set the field to an empty string or fix the upstream connection."
            )

    # Split prompts but do NOT filter out empty ones yet, so we can detect them
    locals_list = [p.strip() for p in local_prompts.split("|")]

    # If there are no visual segments on the timeline (e.g., only using IC-LoRA motion track),
    # bypass the local prompt chunking entirely and just use the global prompt.
    if not locals_list or (len(locals_list) == 1 and not locals_list[0]):
        log.info("[PromptRelay] No local segments found. Using global prompt exclusively.")
        conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(global_prompt))
        return model.clone(), conditioning

    # Check if any specific segment is empty and apply fallbacks
    for i, p in enumerate(locals_list):
        if not p:
            fallback = global_prompt.strip() if global_prompt else "video"
            if not fallback:
                fallback = "video"
            locals_list[i] = fallback

    arch, patch_size, temporal_stride = detect_model_type(model)

    samples = latent["samples"]
    latent_frames = samples.shape[2]
    tokens_per_frame = (samples.shape[3] // patch_size[1]) * (samples.shape[4] // patch_size[2])
    if latent_frames <= 0 or tokens_per_frame <= 0:
        raise ValueError(f"LTX导演时间线收到无效视频潜空间尺寸：{tuple(samples.shape)}。请检查时长和外部 Latent。")

    parsed_lengths = None
    if segment_lengths.strip():
        pixel_lengths = [int(float(x.strip())) for x in segment_lengths.split(",") if x.strip()]
        parsed_lengths = _convert_to_latent_lengths(pixel_lengths, temporal_stride, latent_frames)

    raw_tokenizer = get_raw_tokenizer(clip)
    full_prompt, token_ranges = map_token_indices(raw_tokenizer, global_prompt, locals_list)

    log.info("[PromptRelay] Global: tokens [0:%d] (%d tokens)", token_ranges[0][0], token_ranges[0][0])
    for i, (s, e) in enumerate(token_ranges):
        log.info("[PromptRelay] Segment %d: tokens [%d:%d] (%d tokens)", i, s, e, e - s)

    conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(full_prompt))

    effective_lengths = distribute_segment_lengths(len(locals_list), latent_frames, parsed_lengths)

    log.info(
        "[PromptRelay] Latent: %d frames, %d tokens/frame, segments: %s",
        latent_frames, tokens_per_frame, effective_lengths,
    )

    q_token_idx = build_segments(token_ranges, effective_lengths, epsilon, None)
    if not q_token_idx:
        log.info("[PromptRelay] No effective local prompt frames after clipping. Using prompt encoding without attention mask.")
        return model.clone(), conditioning

    mask_fn = create_mask_fn(q_token_idx, tokens_per_frame, latent_frames)

    patched = model.clone()
    apply_patches(patched, arch, mask_fn)

    return patched, conditioning


def _parse_external_prompt_script(value: str) -> tuple[str, list[str]]:
    """解析《全局提示词》+ 分镜块；分镜以 --- 或空行分隔。"""
    text = str(value or "").strip()
    if not text:
        return "", []
    match = re.match(r"^\s*《([\s\S]*?)》\s*([\s\S]*)$", text)
    if match:
        header = match.group(1).strip()
        remainder = match.group(2).strip()
        blocks = [item.strip() for item in re.split(r"(?:\r?\n\s*---+\s*\r?\n|\r?\n\s*\r?\n+)", remainder) if item.strip()]
        if header in {"全局提示词", "全局", "global prompt", "global_prompt"}:
            return (blocks[0] if blocks else ""), blocks[1:]
        return header, blocks

    normalized = text.replace("\r\n", "\n")
    numbered = re.findall(
        r"(?:^|\n)\s*(?:[\(\[（【]\s*\d+\s*[\)\]）】]|\d+\s*[:：.、])\s*([\s\S]*?)(?=\n\s*(?:[\(\[（【]\s*\d+\s*[\)\]）】]|\d+\s*[:：.、])\s*|$)",
        normalized,
    )
    if numbered:
        return "", [item.strip() for item in numbered if item.strip()]

    if re.search(r"\n\s*---+\s*\n|\n\s*\n+", normalized):
        blocks = [item.strip() for item in re.split(r"(?:\n\s*---+\s*\n|\n\s*\n+)", normalized) if item.strip()]
        if len(blocks) > 1:
            return "", blocks

    return text, []


class GJJLTXDirector(io.ComfyNode):
    """WYSIWYG timeline variant — segments and lengths come from a visual editor in the node UI."""

    DESCRIPTION = (
        "GJJ 版 LTX Director 2.0.2 可视化时间线编辑器，支持图像、视频、音频、"
        "IC-LoRA Motion Guide、Prompt Relay 分段注意力和 Retake 局部重做。"
    )
    SEARCH_ALIASES = [
        "LTX Director",
        "LTX Director 2",
        "LTX Director Timeline",
        "GJJ LTX Director",
        "LTX导演",
        "导演时间线",
        "视频时间线",
        "Prompt Relay",
        "Motion Guide",
        "Retake",
    ]
    GJJ_HELP = {
        "title": "LTX 导演时间线",
        "version": "2.0.2",
        "description": DESCRIPTION,
        "features": [
            "在节点内编辑图像、视频和音频片段，并同步帧数、秒数和时间线范围。",
            "按局部提示词分段生成 Prompt Relay 注意力遮罩，控制不同时间段的语义。",
            "输出图像 Guide、Motion Guide、视频/音频 Latent、合成音频和实际帧率。",
            "支持 IC-LoRA 运动视频、音频空白补绘以及 Retake 指定区间重做。",
        ],
        "usage": [
            "连接 LTX 模型和 CLIP；需要音频生成时再连接音频 VAE。",
            "在时间线面板添加图像、视频或音频片段，并为画面片段填写局部提示词。",
            "将补丁模型和正向条件连接到采样链；视频/音频 Latent 可直接用于 LTX 采样。",
            "需要关键帧图像或运动引导时，把 Guide 数据输出连接到 LTX Director Guide 节点。",
        ],
        "notes": [
            "时间线数据、局部提示词、分段帧数和 Guide 强度由前端自动维护，不建议手动编辑。",
            "显示单位只影响时间线界面，内部始终以像素空间帧数保存。",
            "图像压缩 CRF 为 0 时不压缩；数值越高，压缩痕迹越明显。",
            "本节点不依赖 WhatDreamsCost-ComfyUI，可与原插件并存。",
        ],
    }

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="GJJ_LTXDirector",
            display_name="🎬 LTX导演时间线",
            category="GJJ/🎬 视频/LTX",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Model.Input("model", display_name="模型", tooltip="要写入提示词接力时间线注意力补丁的 LTX 模型。"),
                io.Clip.Input("clip", display_name="文本编码器", tooltip="用于编码全局提示词和各时间线片段局部提示词。"),
                io.Vae.Input("audio_vae", display_name="音频解码器", optional=True, tooltip="可选。连接后生成或编码 LTX 音频潜空间数据。"),
                io.Latent.Input("optional_latent", display_name="外部视频潜空间", optional=True, tooltip="可选。连接后使用外部视频潜空间数据；未连接时按时间线尺寸自动创建。"),
                io.String.Input(
                    "global_prompt", display_name="全局提示词", multiline=False, default="", optional=True,
                    tooltip="作用于整段视频，可外接文本。脚本语法：用《全局提示词内容》声明全局提示词，后续分镜提示词使用 --- 或空行分隔。",
                ),
                io.Float.Input(
                    "start_second", display_name="起始秒", default=0.0, min=0.0, max=1000.0, step=0.01,
                    tooltip="本次生成区间在完整时间线中的起始时间（秒）。",
                ),
                io.Float.Input(
                    "end_second", display_name="结束秒", default=5.0, min=0.0, max=1000.0, step=0.01,
                    tooltip="本次生成区间在完整时间线中的结束时间（秒）。",
                ),
                io.Float.Input(
                    "duration_seconds", display_name="时长（秒）", default=5.0, min=0.1, max=1000.0, step=0.01,
                    tooltip="时间线总时长（秒），会根据总帧数和帧率自动同步。",
                ),
                io.Int.Input(
                    "start_frame", display_name="起始帧", default=0, min=0, max=10000, step=1,
                    tooltip="本次生成区间在完整时间线中的起始帧。",
                ),
                io.Int.Input(
                    "end_frame", display_name="结束帧", default=120, min=1, max=10000, step=1,
                    tooltip="本次生成区间在完整时间线中的结束帧。",
                ),
                io.Int.Input(
                    "duration_frames", display_name="时长（帧）", default=120, min=1, max=10000, step=1,
                    tooltip="时间线在像素空间中的总帧数，用于编辑器刻度和片段范围。",
                ),
                io.String.Input(
                    "timeline_data", display_name="时间线数据", default="",
                    tooltip="时间线编辑器自动维护的 JSON 状态，请勿手动编辑。",
                ),
                io.Boolean.Input(
                    "use_custom_audio", display_name="使用时间线音频", default=False, optional=True,
                    tooltip="开启后使用时间线音频片段；关闭后从零生成音频。",
                ),
                io.Boolean.Input(
                    "use_custom_motion", display_name="使用运动引导", default=True, optional=True,
                    tooltip="开启后输出时间线运动视频片段作为 Motion Guide；关闭后忽略运动视频轨。",
                ),
                io.Boolean.Input(
                    "inpaint_audio", display_name="补绘音频空白", default=True, optional=True,
                    tooltip="开启后用生成音频填补时间线音频轨中的空白区间。",
                ),
                io.String.Input(
                    "local_prompts", display_name="局部提示词", multiline=True, default="",
                    tooltip="由时间线编辑器自动汇总的分段局部提示词。",
                ),
                io.String.Input(
                    "segment_lengths", display_name="分段帧数", default="",
                    tooltip="由时间线编辑器自动生成的各提示词片段帧数，以逗号分隔。",
                ),
                io.Float.Input(
                    "epsilon", display_name="边界衰减", default=0.001, min=0.0001, max=0.99, step=0.0001,
                    tooltip="提示词分段边界的惩罚衰减参数。默认 0.001 边界清晰；0.5 以上可获得更柔和的过渡。",
                ),
                io.Float.Input(
                    "frame_rate", display_name="帧率", default=24, min=1, max=240, step=1, optional=True,
                    tooltip="每秒帧数，用于帧与秒的换算、时间线显示和音频对齐。",
                ),
                io.Combo.Input(
                    "display_mode", display_name="时间显示单位", options=["frames", "seconds"], default="frames", optional=True,
                    tooltip="时间线刻度使用帧或秒显示；内部数据始终以像素空间帧数保存。",
                ),
                io.String.Input(
                    "guide_strength", display_name="引导强度", default="",
                    tooltip="时间线编辑器自动维护的图像片段引导强度，以逗号分隔。",
                ),
                io.Int.Input(
                    "custom_width", display_name="引导宽度", default=0, min=0, max=8192, step=1, optional=True,
                    tooltip="所有图像引导素材的目标宽度；0 表示使用原图宽度。",
                ),
                io.Int.Input(
                    "custom_height", display_name="引导高度", default=0, min=0, max=8192, step=1, optional=True,
                    tooltip="所有图像引导素材的目标高度；0 表示使用原图高度。",
                ),
                io.Combo.Input(
                    "resize_method",
                    display_name="缩放方式",
                    options=["maintain aspect ratio", "stretch to fit", "pad", "pad green", "crop"],
                    default="maintain aspect ratio",
                    optional=True,
                    tooltip="图像引导素材适配目标宽高的方式：保持比例、拉伸、填充、绿底填充或裁剪。",
                ),
                io.Int.Input(
                    "divisible_by", display_name="尺寸整除", default=32, min=1, max=256, step=1, optional=True,
                    tooltip="最终引导素材宽高吸附到该数值的整数倍；LTX 通常使用 32。",
                ),
                io.Int.Input(
                    "img_compression", display_name="图像压缩CRF", default=18, min=0, max=100, step=1, optional=True,
                    tooltip="对每张 Guide 图像模拟 H.264 CRF 压缩；0 为不压缩，数值越高压缩痕迹越明显。",
                ),
                io.Boolean.Input(
                    "override_audio", display_name="使用运动视频音频", default=False, optional=True,
                    tooltip="开启后使用 IC-LoRA 运动视频中的音频，替代独立音频轨。",
                ),
                io.Combo.Input(
                    "grid_layout", display_name="宫格布局",
                    options=["2x2", "2x3", "3x2", "3x3", "3x4", "4x3", "4x4"],
                    default="2x2", optional=True,
                    tooltip="🪟宫格导入时采用的行列布局；每个格子会拆成独立图片片段并均分总帧数。",
                ),
                io.Int.Input(
                    "grid_edge_cut", display_name="宫格切边强度", default=0, min=0, max=45, step=1, optional=True,
                    tooltip="裁掉每个宫格四周的百分比，用于去除格子边框；0 不裁边，最大 45%。",
                ),
                DirectorMediaInput.Input(
                    "material_1", display_name="素材入口 1", optional=True,
                    tooltip="可选。接入 GJJ_BATCH_IMAGE、IMAGE、VIDEO 或 AUDIO；点击前端刷新按钮后会尝试同步上游素材到时间线。",
                ),
                DirectorMediaInput.Input(
                    "material_2", display_name="素材入口 2", optional=True,
                    tooltip="可选。第二路素材输入；点击前端刷新按钮后会尝试同步上游素材到时间线。",
                ),
                DirectorGridInput.Input(
                    "grid_material", display_name="宫格输入", optional=True,
                    tooltip="可选。接入 GJJ_BATCH_IMAGE 或 IMAGE；点击前端刷新按钮后会按宫格设置拆分并导入。",
                ),
            ],
            outputs=[
                io.Model.Output(display_name="补丁模型", tooltip="已写入提示词接力时间线注意力补丁的模型。"),
                io.Conditioning.Output(display_name="正向条件", tooltip="由全局提示词和时间线局部提示词编码出的正向条件。"),
                io.Latent.Output(display_name="视频潜空间", tooltip="外部潜空间数据的透传结果，或按时间线尺寸自动创建的 LTX 视频潜空间数据。"),
                io.Latent.Output(display_name="音频潜空间", tooltip="根据时间线音频生成的 LTX 音频潜空间数据，或用于从零生成的空音频潜空间数据。"),
                GuideData.Output(display_name="图像引导数据", tooltip="包含图像引导素材、插入帧位置和强度，可连接 LTX 导演引导节点。"),
                MotionGuideData.Output(display_name="运动引导数据", tooltip="包含时间线运动视频片段及其范围，可连接支持运动引导的节点。"),
                io.Float.Output(display_name="帧率", tooltip="当前时间线实际使用的帧率。"),
                io.Audio.Output(display_name="合成音频", tooltip="按时间线位置、裁剪范围和覆盖设置合成后的音频。"),
            ],
        )

    @classmethod
    def execute(cls, model, clip, start_second, end_second, duration_seconds, start_frame, end_frame, duration_frames,
                timeline_data, local_prompts, segment_lengths, global_prompt="", guide_strength="", epsilon=1e-3,
                frame_rate=24, display_mode="frames",
                custom_width=768, custom_height=512, resize_method="maintain aspect ratio",
                divisible_by=32, img_compression=0, audio_vae=None, optional_latent=None,
                use_custom_audio=False, inpaint_audio=True, use_custom_motion=True, override_audio=False,
                grid_layout="2x2", grid_edge_cut=0, material_1=None, material_2=None, grid_material=None) -> io.NodeOutput:
        # Parse timeline data
        try:
            tdata = json.loads(timeline_data) if timeline_data else {}
        except Exception as e:
            log.error(f"[LTXDirector] execute timeline_data parse error: {e}")
            tdata = {}

        try:
            start_frame = int(start_frame)
        except Exception:
            start_frame = 0
        try:
            requested_duration_frames = max(1, int(duration_frames))
        except Exception:
            requested_duration_frames = 1

        # Old/stale workflows can carry duration_frames=1 while the other
        # synchronized duration fields still contain the real timeline length.
        # Recover only the degenerate value so an intentionally configured
        # one-frame timeline remains valid when all fields agree.
        if requested_duration_frames <= 1:
            duration_candidates = [requested_duration_frames]
            try:
                duration_candidates.append(max(1, int(end_frame) - start_frame))
            except Exception:
                pass
            try:
                duration_candidates.append(max(1, int(round(float(duration_seconds) * float(frame_rate)))))
            except Exception:
                pass
            if isinstance(tdata, dict):
                for key in ("durationFrames", "duration_frames", "normalDurationFrames"):
                    try:
                        duration_candidates.append(max(1, int(tdata.get(key))))
                    except (TypeError, ValueError):
                        pass
                try:
                    saved_segments = [
                        *tdata.get("segments", []),
                        *tdata.get("audioSegments", []),
                        *tdata.get("motionSegments", []),
                    ]
                    saved_end = max(
                        (int(seg.get("start", 0)) + int(seg.get("length", 0)) for seg in saved_segments),
                        default=1,
                    )
                    duration_candidates.append(max(1, saved_end - start_frame))
                except (TypeError, ValueError):
                    pass
            recovered_duration = max(duration_candidates)
            if recovered_duration > requested_duration_frames:
                log.warning(
                    "[LTXDirector] 检测到时长字段不一致：duration_frames=%d，已从其它时间轴字段恢复为 %d 帧。",
                    requested_duration_frames,
                    recovered_duration,
                )
                requested_duration_frames = recovered_duration

        # LTXV requires pixel frame counts to be 8n+1. Snap once at the
        # entrance and make the snapped value authoritative for the whole run.
        ltxv_length = int(math.ceil((requested_duration_frames - 1) / 8.0) * 8) + 1
        if ltxv_length != requested_duration_frames:
            log.info(
                "[LTXDirector] duration_frames %d 已按 LTX 8N+1 对齐为 %d。",
                requested_duration_frames,
                ltxv_length,
            )
        duration_frames = ltxv_length
        end_frame = start_frame + duration_frames
        try:
            duration_seconds = duration_frames / float(frame_rate)
        except Exception:
            pass

        if isinstance(tdata, dict):
            tdata["durationFrames"] = int(duration_frames)
            tdata["duration_frames"] = int(duration_frames)
            tdata["startFrame"] = int(start_frame)
            tdata["start_frame"] = int(start_frame)
            tdata["endFrame"] = int(end_frame)
            tdata["end_frame"] = int(end_frame)
            if isinstance(duration_seconds, (int, float)):
                tdata["durationSeconds"] = float(duration_seconds)
                tdata["duration_seconds"] = float(duration_seconds)

        is_retake_mode = tdata.get("retakeMode", False)
        is_retake_active = is_retake_mode and tdata.get("retakeVideo") is not None

        # Resolve and split the external prompt before constructing runtime
        # material segments. This makes the timeline the authoritative binding
        # between ordered input images and ordered `---` scene prompts.
        if not global_prompt:
            if is_retake_mode:
                global_prompt = tdata.get("retake_global_prompt", "")
            else:
                global_prompt = tdata.get("global_prompt", "")
        parsed_global_prompt, storyboard_prompts = _parse_external_prompt_script(global_prompt)
        if storyboard_prompts:
            global_prompt = parsed_global_prompt

        runtime_segments = _runtime_material_segments(
            material_1=material_1,
            material_2=material_2,
            grid_material=grid_material,
            duration_frames=duration_frames,
            grid_layout=grid_layout,
            grid_edge_cut=grid_edge_cut,
        )
        if runtime_segments:
            manual_segments = [
                seg for seg in tdata.get("segments", [])
                if not (
                    isinstance(seg, dict)
                    and (seg.get("gjjUpstream") or seg.get("gjjPromptUpstream"))
                )
            ]
            runtime_segments.sort(key=lambda seg: (int(seg.get("start", 0)), str(seg.get("id", ""))))
            if storyboard_prompts:
                for index, seg in enumerate(runtime_segments):
                    seg["prompt"] = storyboard_prompts[min(index, len(storyboard_prompts) - 1)]
                    seg["gjjPromptUpstream"] = True
                local_prompts = "|".join(str(seg.get("prompt") or "video") for seg in runtime_segments)
                segment_lengths = ",".join(str(max(1, int(seg.get("length", 1)))) for seg in runtime_segments)
                log.info(
                    "[LTXDirector] 已按时间线绑定 %d 张素材与 %d 段提示词。",
                    len(runtime_segments),
                    len(storyboard_prompts),
                )
            elif not str(local_prompts or "").strip():
                fallback_prompt = str(global_prompt or tdata.get("global_prompt", "") or "video").strip() or "video"
                local_prompts = "|".join(fallback_prompt for _ in runtime_segments)
            if not storyboard_prompts and not str(segment_lengths or "").strip():
                segment_lengths = ",".join(str(max(1, int(seg.get("length", 1)))) for seg in runtime_segments)
            tdata["segments"] = sorted(
                [*manual_segments, *runtime_segments],
                key=lambda seg: (int(seg.get("start", 0)), str(seg.get("id", ""))),
            )
            log.info("[LTXDirector] 使用运行时上游素材刷新时间线：%d 个图片片段。", len(runtime_segments))

        if isinstance(tdata, dict):
            timeline_data = json.dumps(_strip_runtime_tensors(tdata), ensure_ascii=False)

        if storyboard_prompts and not runtime_segments:
            local_prompts = "|".join(storyboard_prompts)
            segment_lengths = ""

        log.info(f"[LTXDirector] execute RECEIVED global_prompt: {repr(global_prompt)}")

        # --- Build guide_data from image segments FIRST (to derive output dimensions) ---
        guide_data = {"images": [], "insert_frames": [], "strengths": [], "frame_rate": frame_rate}
        derived_w, derived_h = custom_width, custom_height
        try:
            img_segs = [
                s for s in tdata.get("segments", [])
                if s.get("type", "image") in ("image", "video")
                and (s.get("imageFile") or s.get("imageB64") or isinstance(s.get("_runtime_tensor"), torch.Tensor))
                and int(s.get("start", 0)) < start_frame + duration_frames
                and int(s.get("start", 0)) + int(s.get("length", 1)) > start_frame
            ]
            img_segs.sort(key=lambda s: s["start"])

            strengths = []
            if guide_strength.strip():
                strengths = [float(x.strip()) for x in guide_strength.split(",") if x.strip()]

            for idx, seg in enumerate(img_segs):
                seg_start = int(seg.get("start", 0))
                offset = max(0, start_frame - seg_start)

                if seg.get("type") == "video":
                    if offset > 0:
                        seg["trimStart"] = float(seg.get("trimStart", 0)) + offset
                        seg["length"] = max(1, int(seg.get("length", 1)) - offset)
                    tensor = _load_video_tensor(seg, float(frame_rate))
                elif isinstance(seg.get("_runtime_tensor"), torch.Tensor):
                    tensor = _ensure_bhwc_rgb_tensor(seg["_runtime_tensor"])
                else:
                    tensor = _load_image_tensor(seg)

                # Apply resize
                src_h, src_w = tensor.shape[1], tensor.shape[2]

                def snap(val, div):
                    return max(div, (val // div) * div)

                if custom_width > 0 and custom_height > 0:
                    # Both dimensions set — apply selected resize_method (pad, crop, stretch, maintain AR)
                    tensor = _resize_image(tensor, custom_width, custom_height, resize_method, divisible_by)
                elif custom_width > 0:
                    # Width only — scale height from AR, snap both, then resize to exact dimensions
                    tgt_w = snap(custom_width, divisible_by)
                    tgt_h = snap(int(src_h * tgt_w / src_w), divisible_by)
                    tensor = _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
                elif custom_height > 0:
                    # Height only — scale width from AR, snap both, then resize to exact dimensions
                    tgt_h = snap(custom_height, divisible_by)
                    tgt_w = snap(int(src_w * tgt_h / src_h), divisible_by)
                    tensor = _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
                else:
                    # Both zero — keep original dimensions, just snap to divisible_by
                    tensor = _resize_image(tensor, src_w, src_h, "maintain aspect ratio", divisible_by)


                # Apply compression
                if img_compression > 0:
                    tensor = _compress_image(tensor, img_compression)

                # Record dimensions of the first processed image for latent generation
                if idx == 0:
                    derived_h = tensor.shape[1]
                    derived_w = tensor.shape[2]

                if seg.get("isEndFrame"):
                    insert_frame = max(0, seg_start + int(seg.get("length", 1)) - 1 - start_frame)
                else:
                    insert_frame = max(0, seg_start - start_frame)
                strength = strengths[idx] if idx < len(strengths) else 1.0
                guide_data["images"].append(tensor)
                guide_data["insert_frames"].append(insert_frame)
                guide_data["strengths"].append(float(strength))

            # If no images were loaded from the timeline, create a dummy image at strength 0
            # to prevent artifacts in text-to-video mode.
            if not guide_data["images"] and optional_latent is None:
                src_w = derived_w if derived_w > 0 else 768
                src_h = derived_h if derived_h > 0 else 512

                # If there's an IC-LoRA video or retake base video on the timeline, extract its dimensions for accurate aspect ratio scaling
                tdata_motion = json.loads(timeline_data) if timeline_data else {}
                found_dims = False

                # Check for retake base video first
                is_retake = tdata_motion.get("retakeMode", False)
                retake_vid = tdata_motion.get("retakeVideo") or {}
                retake_file = retake_vid.get("imageFile", "") if isinstance(retake_vid, dict) else ""
                if is_retake and retake_file:
                    r_path = os.path.join(folder_paths.get_input_directory(), retake_file)
                    if not os.path.exists(r_path):
                        basename = os.path.basename(retake_file)
                        fallback_path = os.path.join(folder_paths.get_input_directory(), "GJJ_LTXDirector", basename)
                        if os.path.exists(fallback_path):
                            r_path = fallback_path
                    if os.path.exists(r_path):
                        try:
                            with av.open(r_path) as container:
                                stream = container.streams.video[0]
                                src_w = stream.width or stream.codec_context.width
                                src_h = stream.height or stream.codec_context.height
                                found_dims = True
                        except:
                            pass

                # Fallback to normal motion segments
                if not found_dims:
                    for mseg in tdata_motion.get("motionSegments", []):
                        v_file = mseg.get("videoFile")
                        if v_file:
                            v_path = os.path.join(folder_paths.get_input_directory(), v_file)
                            if not os.path.exists(v_path):
                                basename = os.path.basename(v_file)
                                fallback_path = os.path.join(folder_paths.get_input_directory(), "GJJ_LTXDirector", basename)
                                if os.path.exists(fallback_path):
                                    v_path = fallback_path
                            if os.path.exists(v_path):
                                try:
                                    with av.open(v_path) as container:
                                        stream = container.streams.video[0]
                                        src_w = stream.width or stream.codec_context.width
                                        src_h = stream.height or stream.codec_context.height
                                        found_dims = True
                                        break
                                except:
                                    pass

                # Create a dummy tensor of the exact source dimensions
                tensor = torch.zeros((1, src_h, src_w, 3), dtype=torch.float32)

                def snap(val, div):
                    return max(div, (val // div) * div)

                # Route the dummy tensor through the exact same resizing pipeline
                if custom_width > 0 and custom_height > 0:
                    tensor = _resize_image(tensor, custom_width, custom_height, resize_method, divisible_by)
                elif custom_width > 0:
                    tgt_w = snap(custom_width, divisible_by)
                    tgt_h = snap(int(src_h * tgt_w / src_w), divisible_by)
                    tensor = _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
                elif custom_height > 0:
                    tgt_h = snap(custom_height, divisible_by)
                    tgt_w = snap(int(src_w * tgt_h / src_h), divisible_by)
                    tensor = _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
                else:
                    tensor = _resize_image(tensor, src_w, src_h, "maintain aspect ratio", divisible_by)

                guide_data["images"].append(tensor)
                guide_data["insert_frames"].append(0)
                guide_data["strengths"].append(0.0)

                derived_w = tensor.shape[2]
                derived_h = tensor.shape[1]

        except Exception as e:
            log.warning("[PromptRelay] Could not build guide_data: %s", e)

        # --- Auto-generate LTXV latent if none was provided ---
        if optional_latent is None:
            latent_w = max(32, (derived_w // 32) * 32)
            latent_h = max(32, (derived_h // 32) * 32)
            # LTXV temporal: ((length - 1) // 8) + 1 latent frames; invert to get pixel frames -> length
            latent_t = ((ltxv_length - 1) // 8) + 1
            samples = torch.zeros(
                [1, 128, latent_t, latent_h // 32, latent_w // 32],
                device=comfy.model_management.intermediate_device(),
            )
            latent = {"samples": samples}
            log.info(
                "[PromptRelay] Auto-generated LTXV latent: %dx%d, %d pixel frames (%d latent frames)",
                latent_w, latent_h, ltxv_length, latent_t,
            )
        else:
            latent = optional_latent

        patched, conditioning = _encode_relay(
            model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon,
        )

        # --- Build Audio Output ---
        audio_out = _build_combined_audio(timeline_data, start_frame, ltxv_length, float(frame_rate), override_audio=override_audio)

        # --- Audio Latent Generation ---
        audio_latent = {}

        if audio_vae is not None:
            class _UseEmptyAudioLatent(Exception):
                pass

            # Helper to generate empty latent
            def get_empty_latent():
                # Support both raw AudioVAE objects and ComfyUI VAE wrappers.
                inner = getattr(audio_vae, "first_stage_model", audio_vae)
                z_channels = audio_vae.latent_channels
                audio_freq = inner.latent_frequency_bins
                num_audio_latents = max(1, int(inner.num_of_latents_from_frames(ltxv_length, float(frame_rate))))
                audio_latents = torch.zeros(
                    (1, z_channels, num_audio_latents, audio_freq),
                    device=comfy.model_management.intermediate_device(),
                )
                return {"samples": audio_latents, "type": "audio"}

            if use_custom_audio or override_audio or is_retake_active:
                try:
                    if audio_out is not None:
                        # 1. Encode audio waveform into latent space
                        waveform = audio_out["waveform"]
                        if waveform.ndim == 2:
                            waveform = waveform.unsqueeze(0)
                        if waveform.ndim != 3:
                            raise ValueError(
                                f"Expected custom audio waveform with 2 or 3 dims, got shape {tuple(waveform.shape)}"
                            )
                        waveform = _pad_waveform_for_vae(waveform, audio_vae)

                        # Wrapped ComfyUI VAE expects (batch, samples, channels);
                        # raw AudioVAE expects a dict with waveform in (batch, channels, samples).
                        if hasattr(audio_vae, "first_stage_model"):
                            latent_samples = audio_vae.encode(waveform.movedim(1, -1))
                        else:
                            latent_samples = audio_vae.encode({
                                "waveform": waveform,
                                "sample_rate": audio_out["sample_rate"],
                            })

                        if latent_samples.numel() == 0 or latent_samples.shape[2] <= 0:
                            log.warning(
                                "[PromptRelay] Encoded audio latent is empty; falling back to a safe empty audio latent."
                            )
                            audio_latent = get_empty_latent()
                            raise _UseEmptyAudioLatent

                        # 2. Create a 3D gap mask [B, F, H] to avoid accidental broadcasting to the 5D video latent
                        # which also has 128 channels. A 4D audio mask [1, 128, F, H] confuses ComfyUI's KSampler
                        # into masking the video latent as well, causing black frames.
                        B, C, F_len, H_len = latent_samples.shape

                        if is_retake_active:
                            gap_mask = torch.zeros((B, F_len, H_len), dtype=torch.float32, device=latent_samples.device)

                            retake_start = float(tdata.get("retakeStart", 0))
                            retake_len = float(tdata.get("retakeLength", 0))

                            overlap_start = max(start_frame, retake_start)
                            overlap_end = min(start_frame + ltxv_length, retake_start + retake_len)

                            if overlap_end > overlap_start:
                                rel_start = overlap_start - start_frame
                                rel_len = overlap_end - overlap_start

                                start_sec = rel_start / float(frame_rate)
                                len_sec = rel_len / float(frame_rate)
                                total_sec = ltxv_length / float(frame_rate)

                                start_idx = int((start_sec / total_sec) * F_len)
                                end_idx = int(((start_sec + len_sec) / total_sec) * F_len)

                                start_idx = max(0, min(F_len, start_idx))
                                end_idx = max(0, min(F_len, end_idx))

                                gap_mask[:, start_idx:end_idx, :] = 1.0
                        else:
                            gap_mask = torch.ones((B, F_len, H_len), dtype=torch.float32, device=latent_samples.device)

                            audio_segs_key = "motionSegments" if override_audio else "audioSegments"
                            file_key = "videoFile" if override_audio else "audioFile"
                            for seg in tdata.get(audio_segs_key, []):
                                if not seg.get(file_key):
                                    continue

                                seg_start = float(seg.get("start", 0))
                                seg_len = float(seg.get("length", 1))

                                if seg_start + seg_len <= start_frame or seg_start >= start_frame + ltxv_length:
                                    continue

                                offset = max(0, start_frame - seg_start)
                                seg_len = max(1.0, seg_len - offset)
                                seg_start = max(0, seg_start - start_frame)

                                start_sec = seg_start / float(frame_rate)
                                len_sec = seg_len / float(frame_rate)
                                total_sec = ltxv_length / float(frame_rate)

                                start_idx = int((start_sec / total_sec) * F_len)
                                end_idx = int(((start_sec + len_sec) / total_sec) * F_len)
                                gap_mask[:, start_idx:end_idx, :] = 0.0

                        if inpaint_audio:
                            # Generate new audio in the gaps, preserve custom audio segments
                            mask = gap_mask
                        else:
                            # Preserve the entire audio latent (no generation).
                            # We use a 3D zeros mask to prevent video blackouts.
                            mask = torch.zeros((B, F_len, H_len), dtype=torch.float32, device=latent_samples.device)

                        audio_latent = {
                            "samples": latent_samples,
                            "type": "audio",
                            "noise_mask": mask
                        }
                        log.info("[PromptRelay] Generated custom audio latent with dynamic noise mask.")
                    else:
                        raise ValueError("No audio waveform to encode.")
                except _UseEmptyAudioLatent:
                    pass
                except Exception as e:
                    log.error("[PromptRelay] Failed to generate custom audio latent: %s", e)
                    raise e
            else:
                # Generate empty latent
                try:
                    audio_latent = get_empty_latent()
                    log.info("[PromptRelay] Auto-generated empty audio latent.")
                except Exception as e:
                    log.error("[PromptRelay] Could not generate empty audio latent: %s", e)
                    raise e

        # --- Motion guide output from timeline video segments ---
        motion_guide_data = {"segments": [], "frame_rate": float(frame_rate), "duration_frames": int(duration_frames), "resize_method": resize_method}
        try:
            tdata = json.loads(timeline_data) if timeline_data else {}
            if use_custom_motion:
                motion_segments = tdata.get("motionSegments", [])
            else:
                motion_segments = []
            for seg in motion_segments:
                seg_start = int(seg.get("start", 0))
                length = int(seg.get("length", 1))
                if seg_start >= start_frame + duration_frames or seg_start + length <= start_frame:
                    continue
                if not seg.get("videoFile"):
                    continue

                offset = max(0, start_frame - seg_start)
                new_start = max(0, seg_start - start_frame)

                # Trim length so it doesn't extend beyond duration_frames
                clipped_len = min(length - offset, duration_frames - new_start)
                if clipped_len <= 0:
                    continue

                clean = dict(seg)
                clean["start"] = new_start
                clean["length"] = clipped_len
                clean["trimStart"] = float(seg.get("trimStart", 0)) + offset
                motion_guide_data["segments"].append(clean)
        except Exception as e:
            log.warning("[LTXDirector] Could not build motion_guide_data: %s", e)

        # Inject raw timeline details for downstream masking in Retake Mode
        guide_data["timeline_data"] = timeline_data
        guide_data["start_frame"] = start_frame
        guide_data["duration_frames"] = duration_frames
        guide_data["resize_method"] = resize_method

        return io.NodeOutput(
            patched,
            conditioning,
            latent,
            audio_latent,
            guide_data,
            motion_guide_data,
            float(frame_rate),
            audio_out,
        )


NODE_CLASS_MAPPINGS = {
    "GJJ_LTXDirector": GJJLTXDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_LTXDirector": "🎬 LTX导演时间线",
}
