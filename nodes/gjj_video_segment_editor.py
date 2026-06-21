"""
GJJ · ✂️ 可视化视频分段编辑器
支持加载视频、自动生成分段、可视化编辑帧范围、按帧裁剪并输出多个视频片段
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple

import folder_paths
import numpy as np
import torch
from aiohttp import web
from server import PromptServer


NODE_NAME = "GJJ_VideoSegmentEditor"
MAX_SEGMENTS = 99  # 最大分段数量
MIN_OUTPUTS = 1  # 最小输出数量
UPLOAD_SUBFOLDER = "gjj_video_segment_editor"
VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv", ".wmv", ".m4v", ".mpeg", ".mpg"}
FRAME_SNAP = 8


def _safe_filename(name: str) -> str:
	text = Path(name or "video.mp4").name
	return "".join(ch if ch.isalnum() or ch in ".-_" else "_" for ch in text).strip("._") or "video.mp4"


def _unique_path(directory: Path, filename: str) -> Path:
	directory.mkdir(parents=True, exist_ok=True)
	stem = Path(filename).stem or "video"
	suffix = Path(filename).suffix or ".mp4"
	target = directory / f"{stem}{suffix}"
	counter = 1
	while target.exists():
		target = directory / f"{stem}_{counter}{suffix}"
		counter += 1
	return target


@PromptServer.instance.routes.post("/gjj/video_segment_editor/upload")
async def upload_video_segment_editor_video(request):
	reader = await request.multipart()
	upload_dir = Path(folder_paths.get_input_directory()) / UPLOAD_SUBFOLDER
	saved = None

	while True:
		field = await reader.next()
		if field is None:
			break
		if field.name not in {"video", "file", "image"}:
			continue
		filename = _safe_filename(field.filename or "video.mp4")
		if Path(filename).suffix.lower() not in VIDEO_EXTENSIONS:
			return web.json_response({"ok": False, "error": f"不支持的视频格式：{filename}"}, status=400)
		target = _unique_path(upload_dir, filename)
		with target.open("wb") as handle:
			while True:
				chunk = await field.read_chunk()
				if not chunk:
					break
				handle.write(chunk)
		saved = {
			"filename": target.name,
			"subfolder": UPLOAD_SUBFOLDER,
			"type": "input",
			"path": str(target),
		}
		try:
			saved.update(get_video_metadata(str(target)))
		except Exception:
			pass
		break

	if not saved:
		return web.json_response({"ok": False, "error": "没有收到视频文件。"}, status=400)
	return web.json_response({"ok": True, "video": saved})


def is_video_object(value: Any) -> bool:
	"""检测是否为ComfyUI视频对象"""
	if value is None:
		return False
	if isinstance(value, torch.Tensor):
		return value.ndim in (3, 4)
	# 检查是否有get_components方法（ComfyUI VIDEO对象的特征）
	return (
		hasattr(value, "get_components")
		or hasattr(value, "get_stream_source")
		or (isinstance(value, dict) and any(key in value for key in ("images", "frames", "samples")))
	)


def parse_segments_list(text: str) -> list[dict[str, Any]]:
	"""解析分段列表，支持多种格式，过滤非dict元素"""
	if not text or not text.strip():
		return []

	try:
		data = json.loads(text)
		if isinstance(data, list):
			# 过滤掉非dict元素，只保留带有 start_frame/end_frame 字段的字典
			return [
				item for item in data
				if isinstance(item, dict) and ("start_frame" in item or "end_frame" in item)
			]
		elif isinstance(data, dict) and ("start_frame" in data or "end_frame" in data):
			return [data]
	except json.JSONDecodeError:
		pass

	return []


def _snap_frame(value: Any) -> int:
	try:
		frame = int(round(float(value)))
	except Exception:
		frame = 1
	return max(1, 1 + int(round((frame - 1) / FRAME_SNAP)) * FRAME_SNAP)


def _max_ltx_anchor(frame_count: int) -> int:
	frame_count = max(1, int(frame_count or 1))
	return 1 + ((frame_count - 1) // FRAME_SNAP) * FRAME_SNAP


def normalize_segments_to_frames(
	segments: list[dict[str, Any]],
	total_frames: int,
) -> list[dict[str, Any]]:
	"""把分段规整为 1 基闭区间帧号；后续裁剪只使用帧号。"""
	max_anchor = _max_ltx_anchor(total_frames)
	normalized = []
	for index, item in enumerate(segments):
		if not isinstance(item, dict):
			continue
		if max_anchor <= 1:
			normalized.append({
				"start_frame": 1,
				"end_frame": 1,
				"frames": 1,
				"label": item.get("label") or f"片段 {index + 1}",
				**({"color": item.get("color")} if item.get("color") else {}),
			})
			continue

		start_frame = _snap_frame(item.get("start_frame", 1))
		end_frame = _snap_frame(item.get("end_frame", max_anchor))

		start_frame = min(max(int(start_frame), 1), max(1, max_anchor - FRAME_SNAP))
		end_frame = min(max_anchor, max(start_frame + FRAME_SNAP, int(end_frame)))

		normalized.append({
			"start_frame": int(start_frame),
			"end_frame": int(end_frame),
			"frames": int(end_frame - start_frame + 1),
			"label": item.get("label") or f"片段 {index + 1}",
			**({"color": item.get("color")} if item.get("color") else {}),
		})
	return normalized


def format_segments_list(segments: list[dict[str, Any]]) -> str:
	"""格式化分段列表为JSON字符串"""
	if not segments:
		return "[]"
	frame_segments = []
	for index, item in enumerate(segments):
		if not isinstance(item, dict):
			continue
		start_frame = int(item.get("start_frame", 1) or 1)
		end_frame = int(item.get("end_frame", FRAME_SNAP + 1) or (FRAME_SNAP + 1))
		entry = {
			"start_frame": start_frame,
			"end_frame": end_frame,
			"frames": int(end_frame - start_frame + 1),
			"label": item.get("label") or f"片段 {index + 1}",
		}
		if item.get("color"):
			entry["color"] = item.get("color")
		frame_segments.append(entry)
	return json.dumps(frame_segments, ensure_ascii=False, indent=2)


def get_ffmpeg_executable() -> str:
	"""获取可用 ffmpeg 路径，优先使用 imageio-ffmpeg 内置二进制。"""
	try:
		import imageio_ffmpeg
		return imageio_ffmpeg.get_ffmpeg_exe()
	except Exception:
		return "ffmpeg"


def _parse_int(value: Any, default: int = 0) -> int:
	try:
		text = str(value).strip()
		if not text or text.upper() == "N/A":
			return default
		return int(float(text))
	except Exception:
		return default


def _parse_fps(value: Any, default: float = 24.0) -> float:
	try:
		text = str(value or "").strip()
		if not text or text.upper() == "N/A":
			return default
		if "/" in text:
			num, den = text.split("/", 1)
			den_value = float(den)
			return float(num) / den_value if den_value != 0 else default
		return float(text)
	except Exception:
		return default


def _path_preview_entry(video_path: str) -> dict[str, str]:
	"""构建 /view 可访问的预览对象，自动判断 input/temp/output。"""
	path = Path(video_path).resolve()
	for type_name, base_getter in (
		("input", folder_paths.get_input_directory),
		("temp", folder_paths.get_temp_directory),
		("output", folder_paths.get_output_directory),
	):
		try:
			base = Path(base_getter()).resolve()
			relative = path.relative_to(base)
		except Exception:
			continue
		subfolder = relative.parent.as_posix()
		if subfolder == ".":
			subfolder = ""
		return {
			"filename": path.name,
			"subfolder": subfolder,
			"type": type_name,
		}
	return {
		"filename": path.name,
		"subfolder": "",
		"type": "input",
	}


def _temp_segment_path(segment_index: int, start_frame: int, end_frame: int, prompt: Any = None) -> Path:
	output_dir = Path(folder_paths.get_temp_directory())
	filename = (
		f"GJJ_VideoSegmentEditor_segment_{abs(hash(str(prompt)))}_"
		f"{time.time_ns()}_{int(segment_index):02d}_{int(start_frame)}-{int(end_frame)}.mp4"
	)
	return _unique_path(output_dir, filename)


def video_from_file_path(filepath: str | Path):
	"""返回指向实际视频文件的 ComfyUI VIDEO 对象。"""
	path = str(filepath)
	try:
		from comfy_api.latest import InputImpl

		return InputImpl.VideoFromFile(path)
	except Exception:
		from comfy_api.input_impl import VideoFromFile

		return VideoFromFile(path)


def _component_value(value: Any, key: str, default: Any = None) -> Any:
	if value is None:
		return default
	if isinstance(value, dict):
		return value.get(key, default)
	return getattr(value, key, default)


def _stream_source_path(value: Any) -> str | None:
	stream_source = None
	getter = getattr(value, "get_stream_source", None)
	if callable(getter):
		try:
			stream_source = getter()
		except Exception:
			stream_source = None

	if stream_source is None:
		for name in ("path", "filepath", "file_path", "filename", "video_path", "source", "src", "loaded_file", "full_path", "abs_path"):
			try:
				candidate = getattr(value, name, None)
				if callable(candidate):
					candidate = candidate()
				if candidate:
					stream_source = candidate
					break
			except Exception:
				pass

	if stream_source is None and isinstance(value, dict):
		for key in ("path", "filepath", "file_path", "filename", "video_path", "source", "src"):
			if value.get(key):
				stream_source = value.get(key)
				break

	if isinstance(stream_source, (str, os.PathLike)):
		raw_path = os.fspath(stream_source)
		try:
			if folder_paths.exists_annotated_filepath(raw_path):
				raw_path = folder_paths.get_annotated_filepath(raw_path)
			elif not os.path.exists(raw_path):
				annotated = folder_paths.get_annotated_filepath(raw_path)
				if annotated and os.path.exists(annotated):
					raw_path = annotated
		except Exception:
			pass
		if os.path.isfile(raw_path):
			return raw_path
	return None


def _video_audio_component(value: Any) -> dict[str, Any] | None:
	if value is None:
		return None
	if hasattr(value, "get_components"):
		try:
			components = value.get_components()
			audio = _component_value(components, "audio")
			if audio is not None:
				return audio
		except Exception:
			pass
	if isinstance(value, dict):
		audio = value.get("audio")
		if audio is not None:
			return audio
	return None


def _crop_audio_component(audio: dict[str, Any] | None, start_frame: int, end_frame: int, fps: float) -> dict[str, Any] | None:
	if not isinstance(audio, dict):
		return None
	waveform = audio.get("waveform")
	sample_rate = audio.get("sample_rate")
	if not isinstance(waveform, torch.Tensor) or not sample_rate or fps <= 0:
		return audio
	try:
		sr = int(sample_rate)
		start_time = max(0.0, (int(start_frame) - 1) / float(fps))
		end_time = max(start_time, int(end_frame) / float(fps))
		start_sample = max(0, int(round(start_time * sr)))
		end_sample = max(start_sample + 1, int(round(end_time * sr)))
		max_samples = int(waveform.shape[-1])
		start_sample = min(start_sample, max_samples)
		end_sample = min(end_sample, max_samples)
		if start_sample >= end_sample:
			return None
		cropped = waveform[..., start_sample:end_sample].contiguous()
		return {**audio, "waveform": cropped, "sample_rate": sr}
	except Exception:
		return audio


def _normalize_frames_array(images: Any) -> np.ndarray | None:
	if images is None:
		return None
	if isinstance(images, torch.Tensor):
		frames_np = images.detach().cpu().float().numpy()
	else:
		try:
			frames_np = np.asarray(images)
		except Exception:
			return None
	if frames_np.ndim == 3:
		frames_np = np.expand_dims(frames_np, axis=0)
	if frames_np.ndim != 4 or frames_np.shape[0] == 0:
		return None
	if frames_np.shape[-1] not in (1, 3, 4) and frames_np.shape[1] in (1, 3, 4):
		frames_np = np.transpose(frames_np, (0, 2, 3, 1))
	if frames_np.shape[-1] == 1:
		frames_np = np.repeat(frames_np, 3, axis=-1)
	elif frames_np.shape[-1] >= 4:
		frames_np = frames_np[..., :3]
	elif frames_np.shape[-1] != 3:
		return None
	if frames_np.dtype != np.float32:
		if np.issubdtype(frames_np.dtype, np.integer):
			frames_np = frames_np.astype(np.float32) / 255.0
		else:
			frames_np = frames_np.astype(np.float32)
	return np.clip(frames_np, 0.0, 1.0)


def video_to_frames_data(video: dict[str, Any]) -> tuple[np.ndarray, float, int, int]:
	"""将ComfyUI视频对象转换为帧数组、帧率、宽度和高度"""
	if hasattr(video, "get_components"):
		components = video.get_components()
		images = _component_value(components, "images")
		frame_rate = float(_component_value(components, "frame_rate", 24.0) or 24.0)
		frames_np = _normalize_frames_array(images)
		if frames_np is not None:
			height, width = frames_np.shape[1], frames_np.shape[2]
			return frames_np, frame_rate, width, height

	if isinstance(video, torch.Tensor):
		frames_np = _normalize_frames_array(video)
		if frames_np is not None:
			height, width = frames_np.shape[1], frames_np.shape[2]
			return frames_np, 24.0, width, height

	if isinstance(video, dict):
		images = video.get("images")
		if images is None:
			images = video.get("frames")
		if images is None:
			images = video.get("samples")
		frame_rate = float(video.get("frame_rate", video.get("fps", 24.0)) or 24.0)
		frames_np = _normalize_frames_array(images)
		if frames_np is not None:
			height, width = frames_np.shape[1], frames_np.shape[2]
			return frames_np, frame_rate, width, height

	stream_path = _stream_source_path(video)
	if stream_path:
		video_data = _decode_video_with_ffmpeg(stream_path)
		frames_np = _normalize_frames_array(video_data["images"])
		if frames_np is not None:
			return frames_np, float(video_data["frame_rate"]), int(video_data["width"]), int(video_data["height"])

	raise RuntimeError("无法从视频对象中提取帧数据")


def load_audio_from_media_file(filepath: str) -> dict[str, Any] | None:
	"""从音视频文件中解码音轨为 ComfyUI AUDIO。没有音轨时返回 None。"""
	try:
		from comfy_extras.nodes_audio import load as load_audio
		waveform, sample_rate = load_audio(filepath)
		return {"waveform": waveform.unsqueeze(0).contiguous(), "sample_rate": int(sample_rate)}
	except Exception as e:
		print(f"[GJJ] 视频分段编辑器 - 未读取到音轨: {e}")
		return None


def media_has_audio_stream(filepath: str) -> bool:
	"""检查媒体文件是否包含音频流。"""
	try:
		cmd = [
			"ffprobe", "-v", "error",
			"-select_streams", "a:0",
			"-show_entries", "stream=index",
			"-of", "csv=p=0",
			filepath,
		]
		result = subprocess.run(cmd, capture_output=True, text=True)
		return result.returncode == 0 and bool(result.stdout.strip())
	except Exception:
		return False


def save_frames_for_preview(frames: np.ndarray, prompt: Any = None, suffix: str = "") -> tuple[str, str]:
	"""保存首帧到临时文件用于预览，支持suffix参数避免文件名冲突"""
	output_dir = folder_paths.get_temp_directory()
	filename = f"GJJ_VideoSegmentEditor_{hash(str(prompt))}{suffix}.png"
	filepath = os.path.join(output_dir, filename)

	os.makedirs(output_dir, exist_ok=True)

	# 保存第一帧作为预览
	from PIL import Image
	first_frame = frames[0] if frames.ndim == 4 else frames
	if first_frame.ndim == 3:
		# 转换为RGB
		if first_frame.shape[-1] == 4:
			first_frame = first_frame[..., :3]
		img_array = (np.clip(first_frame, 0, 1) * 255).astype(np.uint8)
		img = Image.fromarray(img_array)
		img.save(filepath)

	return filepath, filename


def crop_video_segment_ffmpeg(
	video_path: str,
	start_frame: int,
	end_frame: int,
	output_path: str
) -> bool:
	"""使用 FFmpeg 按 1 基闭区间帧号裁剪视频片段。"""
	try:
		start_index = max(0, int(start_frame) - 1)
		end_index = max(start_index + 1, int(end_frame))
		trim_filter = f"trim=start_frame={start_index}:end_frame={end_index},setpts=PTS-STARTPTS"
		has_audio = media_has_audio_stream(video_path)

		if has_audio:
			fps = max(_get_video_fps(video_path), 0.001)
			start_time = start_index / fps
			end_time = end_index / fps
			filter_complex = (
				f"[0:v]{trim_filter}[v];"
				f"[0:a]atrim=start={start_time:.9f}:end={end_time:.9f},asetpts=PTS-STARTPTS[a]"
			)
			cmd = [
				get_ffmpeg_executable(), "-y", "-v", "error",
				"-i", video_path,
				"-filter_complex", filter_complex,
				"-map", "[v]",
				"-map", "[a]",
				"-c:v", "libx264",
				"-c:a", "aac",
				"-pix_fmt", "yuv420p",
				"-movflags", "+faststart",
				"-shortest",
				output_path,
			]
		else:
			cmd = [
				get_ffmpeg_executable(), "-y", "-v", "error",
				"-i", video_path,
				"-filter:v", trim_filter,
				"-an",
				"-c:v", "libx264",
				"-pix_fmt", "yuv420p",
				"-movflags", "+faststart",
				output_path,
			]

		result = subprocess.run(cmd, capture_output=True, text=True)
		if result.returncode != 0:
			print(f"[GJJ] FFmpeg按帧裁剪失败: {result.stderr.strip()}")
		return result.returncode == 0
	except Exception as e:
		print(f"[GJJ] FFmpeg裁剪失败: {e}")
		return False


def load_video_from_path(filepath: str):
	"""从绝对路径加载视频文件，返回标准VIDEO对象"""
	if not os.path.exists(filepath):
		raise RuntimeError(f"找不到视频文件: {filepath}")
	video_data = _decode_video_with_ffmpeg(filepath)
	audio = load_audio_from_media_file(filepath)
	return create_video_object(video_data["images"], video_data["frame_rate"], audio=audio)


def load_video_from_file(filename: str):
	"""从ComfyUI目录加载视频文件，返回标准VIDEO对象"""
	# 只取文件名部分（去掉路径）
	basename = os.path.basename(filename)

	search_dirs = [
		folder_paths.get_input_directory(),
		folder_paths.get_output_directory(),
	]

	for search_dir in search_dirs:
		if not search_dir or not os.path.exists(search_dir):
			continue

		# 尝试直接拼接文件名
		filepath = os.path.join(search_dir, basename)
		if os.path.exists(filepath):
			video_data = _decode_video_with_ffmpeg(filepath)
			# 创建标准VIDEO对象
			audio = load_audio_from_media_file(filepath)
			return create_video_object(video_data["images"], video_data["frame_rate"], audio=audio)

		# 尝试在子文件夹中查找
		for root, dirs, files in os.walk(search_dir):
			for f in files:
				if f == basename:
					filepath = os.path.join(root, f)
					video_data = _decode_video_with_ffmpeg(filepath)
					audio = load_audio_from_media_file(filepath)
					return create_video_object(video_data["images"], video_data["frame_rate"], audio=audio)

	raise RuntimeError(f"找不到视频文件: {filename} (已搜索目录: {search_dirs})")


def resolve_video_file_path(video_file: str) -> str | None:
	"""解析隐藏路径字段，支持 input 相对路径、上传子目录和绝对路径。"""
	text = str(video_file or "").strip()
	if not text or text == "[不加载]":
		return None
	if os.path.isabs(text) and os.path.isfile(text):
		return text

	candidates = []
	for base in [folder_paths.get_input_directory(), folder_paths.get_output_directory()]:
		if not base:
			continue
		candidates.append(os.path.join(base, text))
		candidates.append(os.path.join(base, os.path.basename(text)))

	for candidate in candidates:
		if os.path.isfile(candidate):
			return candidate
	return None


def input_preview_entry(video_path: str) -> dict[str, str]:
	"""构建 /view 可访问的预览对象。"""
	return _path_preview_entry(video_path)


def save_video_for_preview(frames: np.ndarray | torch.Tensor, fps: float, prompt: Any = None) -> tuple[str, str]:
	"""把外部 VIDEO 对象保存成前端 video 标签可播放的临时 mp4。"""
	output_dir = folder_paths.get_temp_directory()
	filename = f"GJJ_VideoSegmentEditor_preview_{hash(str(prompt))}_{time.time_ns()}.mp4"
	filepath = os.path.join(output_dir, filename)
	os.makedirs(output_dir, exist_ok=True)

	save_frames_to_video_file(frames, fps, filepath)
	return filepath, filename


def save_frames_to_video_file(frames: np.ndarray | torch.Tensor, fps: float, filepath: str | Path) -> None:
	"""把帧数组编码成 mp4 文件。"""
	if isinstance(frames, torch.Tensor):
		arr = frames.detach().cpu().numpy()
	else:
		arr = np.asarray(frames)
	if arr.dtype != np.uint8:
		arr = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
	if arr.ndim == 4 and arr.shape[-1] > 3:
		arr = arr[..., :3]

	try:
		import imageio.v2 as imageio
		writer = imageio.get_writer(str(filepath), fps=max(1.0, float(fps or 24.0)), codec="libx264", macro_block_size=2)
		try:
			for frame in arr:
				writer.append_data(frame)
		finally:
			writer.close()
	except Exception as e:
		print(f"[GJJ] 保存视频文件失败: {e}")
		raise


def save_audio_to_wav_file(audio: dict[str, Any], filepath: str | Path) -> bool:
	waveform = audio.get("waveform") if isinstance(audio, dict) else None
	sample_rate = audio.get("sample_rate") if isinstance(audio, dict) else None
	if not isinstance(waveform, torch.Tensor) or not sample_rate:
		return False
	try:
		import wave

		sr = int(sample_rate)
		data = waveform.detach().cpu().float()
		while data.ndim > 2:
			data = data.squeeze(0)
		if data.ndim == 1:
			data = data.unsqueeze(0)
		if data.shape[0] > data.shape[-1]:
			data = data.transpose(0, 1)
		channels = int(data.shape[0])
		pcm = (data.clamp(-1.0, 1.0).transpose(0, 1).numpy() * 32767.0).astype(np.int16)
		with wave.open(str(filepath), "wb") as wav:
			wav.setnchannels(channels)
			wav.setsampwidth(2)
			wav.setframerate(sr)
			wav.writeframes(pcm.tobytes())
		return True
	except Exception as e:
		print(f"[GJJ] 保存音频文件失败: {e}")
		return False


def mux_audio_into_video_file(video_path: str | Path, audio: dict[str, Any] | None) -> None:
	if not isinstance(audio, dict):
		return
	video_path = Path(video_path)
	audio_path = video_path.with_suffix(".wav")
	muxed_path = video_path.with_name(f"{video_path.stem}_audio{video_path.suffix}")
	if not save_audio_to_wav_file(audio, audio_path):
		return
	try:
		cmd = [
			get_ffmpeg_executable(), "-y", "-v", "error",
			"-i", str(video_path),
			"-i", str(audio_path),
			"-map", "0:v:0",
			"-map", "1:a:0",
			"-c:v", "copy",
			"-c:a", "aac",
			"-shortest",
			"-movflags", "+faststart",
			str(muxed_path),
		]
		result = subprocess.run(cmd, capture_output=True, text=True)
		if result.returncode != 0:
			print(f"[GJJ] 封入分段音频失败: {result.stderr.strip()}")
			return
		os.replace(muxed_path, video_path)
	finally:
		for path in (audio_path, muxed_path):
			try:
				if path.exists():
					path.unlink()
			except Exception:
				pass


def _decode_video_with_ffmpeg(video_path: str) -> dict[str, Any]:
	"""使用FFmpeg解码视频为帧序列"""

	try:
		import imageio.v3 as iio
		
		# 读取视频帧
		frames = iio.imread(video_path, plugin="pyav")

		if frames is None or len(frames) == 0:
			raise RuntimeError("未能从视频中读取到帧")

		# 获取视频信息
		with iio.immeta(video_path, plugin="pyav") as meta:
			fps = float(meta.get("fps", 24.0))

		# 转换为torch tensor
		if frames.dtype != np.float32:
			frames = frames.astype(np.float32) / 255.0

		frames_tensor = torch.from_numpy(frames).float()

		# 确保是4D张量 (B, H, W, C)
		if frames_tensor.ndim == 3:
			frames_tensor = frames_tensor.unsqueeze(0)

		# 获取尺寸
		height, width = frames_tensor.shape[1], frames_tensor.shape[2]

		return {
			"images": frames_tensor,
			"frame_rate": fps,
			"width": width,
			"height": height,
			"frame_count": len(frames),
			"path": video_path,
		}

	except Exception as e:
		# 回退到ffmpeg命令行
		print(f"[GJJ] imageio读取失败，尝试FFmpeg... ({e})")
		if "imageio" in str(e) or "imageio" in str(type(e).__name__).lower():
			from .common_utils.dependency_checker import get_pip_install_command_text
			cmd = get_pip_install_command_text("imageio imageio-ffmpeg")
			print(f"[GJJ] 提示：缺少 imageio 依赖，安装命令: {cmd}")
		return _decode_video_with_ffmpeg_cli(video_path)


def _decode_video_with_ffmpeg_cli(video_path: str) -> dict[str, Any]:
	"""使用FFmpeg命令行解码视频"""
	with tempfile.TemporaryDirectory() as tmpdir:
		tmpdir_path = Path(tmpdir)
		frame_pattern = str(tmpdir_path / "frame_%06d.png")

		# 提取所有帧
		cmd = [
			"ffmpeg", "-y", "-v", "error",
			"-i", video_path,
			"-vf", "fps=30",  # 默认30fps，后续会修正
			frame_pattern,
		]

		result = subprocess.run(cmd, capture_output=True, text=True)
		if result.returncode != 0:
			raise RuntimeError(f"FFmpeg提取帧失败: {result.stderr}")

		# 读取提取的帧
		frame_files = sorted(tmpdir_path.glob("frame_*.png"))
		if not frame_files:
			raise RuntimeError("FFmpeg未提取到任何帧")

		from PIL import Image
		frames = []
		for frame_file in frame_files:
			with Image.open(frame_file) as img:
				img_array = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
				frames.append(img_array)

		frames_np = np.stack(frames, axis=0)
		frames_tensor = torch.from_numpy(frames_np).float()

		# 获取实际帧率
		fps = _get_video_fps(video_path)
		height, width = frames_tensor.shape[1], frames_tensor.shape[2]

		return {
			"images": frames_tensor,
			"frame_rate": fps,
			"width": width,
			"height": height,
			"frame_count": len(frames),
			"path": video_path,
		}


def _get_video_fps(video_path: str) -> float:
	"""获取视频帧率"""
	try:
		cmd = [
			"ffprobe", "-v", "error",
			"-select_streams", "v:0",
			"-show_entries", "stream=r_frame_rate",
			"-of", "default=noprint_wrappers=1:nokey=1",
			video_path,
		]
		result = subprocess.run(cmd, capture_output=True, text=True)
		if result.returncode == 0 and result.stdout.strip():
			rate_str = result.stdout.strip()
			if "/" in rate_str:
				num, den = rate_str.split("/")
				return float(num) / float(den)
			return float(rate_str)
	except Exception:
		pass
	return 24.0  # 默认值


def get_video_metadata(video_path: str) -> dict[str, Any]:
	"""获取视频元数据和真实帧数。"""
	try:
		cmd = [
			"ffprobe", "-v", "error", "-count_frames",
			"-select_streams", "v:0",
			"-show_entries", "stream=r_frame_rate,avg_frame_rate,width,height,nb_frames,nb_read_frames",
			"-of", "json",
			video_path,
		]
		result = subprocess.run(cmd, capture_output=True, text=True)
		if result.returncode == 0:
			import json as json_module
			data = json_module.loads(result.stdout)

			stream = data.get("streams", [{}])[0]
			# 解析帧率
			fps = _parse_fps(stream.get("avg_frame_rate") or stream.get("r_frame_rate"), 24.0)
			if fps <= 0:
				fps = _parse_fps(stream.get("r_frame_rate"), 24.0)

			# 获取其他信息
			width = int(stream.get("width", 0))
			height = int(stream.get("height", 0))
			frame_count = _parse_int(stream.get("nb_read_frames"), 0)
			if frame_count <= 0:
				frame_count = _parse_int(stream.get("nb_frames"), 0)
			return {
				"fps": fps,
				"width": width,
				"height": height,
				"frame_count": frame_count,
			}
	except Exception as e:
		print(f"[GJJ] 获取视频元数据失败: {e}")

	# 回退方案
	return {
		"fps": 24.0,
		"width": 0,
		"height": 0,
		"frame_count": 0,
	}


def extract_first_frame(video_path: str) -> np.ndarray | None:
	"""快速提取视频首帧用于预览"""
	try:
		import imageio.v3 as iio

		# 只读取第一帧
		frame = iio.imread(video_path, index=0)

		if frame is not None:
			# 转换为 numpy 数组
			if hasattr(frame, '__array__'):
				frame_np = np.asarray(frame)

				# 如果是 RGB 格式，转换为 [H, W, 3]
				if frame_np.ndim == 3 and frame_np.shape[2] == 3:
					# 转换为 [0, 1] 范围的 float32
					frame_np = frame_np.astype(np.float32) / 255.0
					return frame_np
				elif frame_np.ndim == 3 and frame_np.shape[2] == 4:
					# RGBA 转 RGB
					frame_np = frame_np[:, :, :3].astype(np.float32) / 255.0
					return frame_np
				elif frame_np.ndim == 2:
					# 灰度图转 RGB
					frame_np = np.stack([frame_np] * 3, axis=-1).astype(np.float32) / 255.0
					return frame_np
	except ImportError:
		from .common_utils.dependency_checker import get_pip_install_command_text
		cmd = get_pip_install_command_text("imageio imageio-ffmpeg")
		print(f"[GJJ] imageio 未安装，跳过使用该库提取首帧。安装命令: {cmd}")
		# 如果没有 imageio，使用 ffmpeg 命令行
		try:
			import tempfile
			from pathlib import Path
			from PIL import Image

			with tempfile.TemporaryDirectory() as tmpdir:
				tmpdir_path = Path(tmpdir)
				frame_file = tmpdir_path / "first_frame.png"

				# 提取第一帧
				cmd = [
					"ffmpeg", "-y", "-v", "error",
					"-i", video_path,
					"-vf", r"select=eq(n\,0)",
					"-frames:v", "1",
					str(frame_file),
				]

				result = subprocess.run(cmd, capture_output=True, text=True)
				if result.returncode == 0 and frame_file.exists():
					with Image.open(frame_file) as img:
						img_array = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
						return img_array

		except Exception as e:
			print(f"[GJJ] 使用FFmpeg提取首帧失败: {e}")

	except Exception as e:
		print(f"[GJJ] 提取首帧失败: {e}")

	return None


def generate_auto_frame_segments(frame_count: int, segment_count: int = 3) -> list[dict[str, Any]]:
	frame_count = max(1, int(frame_count or 1))
	max_anchor = _max_ltx_anchor(frame_count)
	if max_anchor <= 1:
		return [{
			"start_frame": 1,
			"end_frame": 1,
			"frames": 1,
			"label": "片段 1",
		}]
	segment_count = max(1, int(segment_count or 3))
	step = max(FRAME_SNAP, int(round(((max_anchor - 1) / segment_count) / FRAME_SNAP)) * FRAME_SNAP)
	segments = []
	for i in range(segment_count):
		start_frame = min(max(1, max_anchor - FRAME_SNAP), 1 + i * step)
		end_frame = max_anchor if i == segment_count - 1 else min(max_anchor, max(start_frame + FRAME_SNAP, 1 + (i + 1) * step))
		segments.append({
			"start_frame": int(start_frame),
			"end_frame": int(end_frame),
			"frames": int(end_frame - start_frame + 1),
			"label": f"片段 {i + 1}",
		})
	return segments


def create_video_object(frames: torch.Tensor, fps: float, audio: dict[str, Any] | None = None):
	"""创建ComfyUI VIDEO对象"""
	try:
		from comfy_api.latest import InputImpl, Types
		from fractions import Fraction

		# 确保帧是torch.Tensor且形状正确 [N, H, W, C]
		if not isinstance(frames, torch.Tensor):
			frames = torch.from_numpy(frames).float()

		# 确保通道数是3（RGB）
		if frames.shape[-1] > 3:
			frames = frames[..., :3]

		return InputImpl.VideoFromComponents(
			Types.VideoComponents(
				images=frames.contiguous(),
				audio=audio,
				frame_rate=Fraction(str(float(fps))).limit_denominator(1000),
			)
		)
	except Exception as e:
		# 回退方案：使用内置的 CreateVideo
		try:
			from .common_utils.video_tools import CreateVideo
			return CreateVideo.execute(frames.contiguous(), float(fps), audio)[0]
		except Exception:
			# 最后回退：创建空视频
			empty_frames = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
			from comfy_api.latest import InputImpl, Types
			from fractions import Fraction
			return InputImpl.VideoFromComponents(
				Types.VideoComponents(
					images=empty_frames,
					audio=None,
					frame_rate=Fraction(24, 1),
				)
			)


class GJJ_VideoSegmentEditor:
	CATEGORY = "GJJ/视频"
	FUNCTION = "edit_segments"
	OUTPUT_NODE = True
	DESCRIPTION = """视频分段编辑器：加载视频后自动生成分段，可视化编辑起止帧，按帧裁剪并输出多个视频片段。

【核心功能】
• 节点内加载视频 - 支持从下拉列表选择视频文件
• 自动生成分段 - 根据视频总帧数自动创建等分帧段
• 可视化编辑 - Canvas帧预览显示，拖拽调整起止帧标记
• 动态输出 - 根据分段数量自动扩展输出接口
• 批量裁剪 - 一次性输出所有分段的视频片段

【分段格式】
使用 1 基闭区间帧号：
[
  {"start_frame": 1, "end_frame": 81, "frames": 81, "label": "片段 1"},
  {"start_frame": 81, "end_frame": 161, "frames": 81, "label": "片段 2"}
]

【交互操作】
• 左键拖拽标记 - 调整分段边界帧
• 滚轮缩放 - 查看帧细节
• 右键菜单 - 添加/删除/自动生成分段

【输出说明】
• 视频片段1...N - 按帧裁剪后写入 ComfyUI temp 的分段视频
• 分段列表JSON - 编辑后的帧段配置"""

	# 依赖声明
	REQUIRED_PACKAGES = [
		"imageio>=2.28.0",
		"imageio-ffmpeg>=0.4.8",
		"numpy>=1.20.0",
	]

	REQUIRED_MODELS = []

	GJJ_HELP = {
		"title": "GJJ · ✂️ 视频分段编辑器",
		"version": "1.0.0",
		"author": "GJJ Custom Nodes Team",
		"description": "可视化视频分段裁剪工具，支持动态输出多个视频片段",

		"features": [
			{
				"name": "节点内视频加载",
				"description": "内置视频文件选择器，无需外部节点连接",
				"supported_formats": ["MP4", "AVI", "MOV", "MKV"],
			},
			{
				"name": "自动分段生成",
				"description": "根据视频总帧数自动创建等分帧段",
				"default_segments": 4,
				"customizable": True,
			},
			{
				"name": "可视化编辑",
				"description": "Canvas帧预览显示，拖拽调整起止帧",
				"precision": "frame",
			},
			{
				"name": "动态输出接口",
				"description": "根据分段数量自动扩展输出插槽",
				"max_outputs": MAX_SEGMENTS,
			},
			{
				"name": "批量裁剪",
				"description": "一次性输出所有分段的视频片段",
				"format": "VIDEO",
			},
		],

		"inputs": {
			"video": {
				"type": "VIDEO",
				"required": False,
				"description": "可选：外部连接的视频对象（优先级高于内部加载）",
			},
			"video_file": {
				"type": "COMBO",
				"required": False,
				"description": "节点内视频文件选择器",
			},
			"segments_json": {
				"type": "STRING",
				"required": False,
				"default": "[]",
				"description": "帧段列表JSON（可选，为空则自动生成）",
				"multiline": True,
			},
			"segment_count": {
				"type": "INT",
				"required": False,
				"default": 3,
				"description": "自动分段数量（当segments_json为空时生效）",
			},
		},

		"outputs": {
			"视频片段1...N": {
				"type": "VIDEO",
				"description": "动态输出，数量等于分段数量",
			},
			"分段列表": {
				"type": "STRING",
				"description": "编辑后的帧段JSON配置",
			},
		},

		"usage_examples": [
			{
				"title": "视频章节分离",
				"description": "将长视频按章节分段，提取各个片段",
				"workflow": "[Load Video] → [GJJ Video Segment Editor] → [多个输出]",
			},
			{
				"title": "精彩片段剪辑",
				"description": "标记视频的精彩时刻并分别输出",
				"workflow": "[Video File] → [GJJ Video Segment Editor]",
			},
			{
				"title": "教学视频分段",
				"description": "按知识点帧段分离教学内容",
				"workflow": "[Tutorial Video] → [GJJ Video Segment Editor]",
			},
		],

		"technical_notes": [
			"视频裁剪使用FFmpeg trim 按帧裁剪，并把每段写入 ComfyUI temp",
			"动态输出接口通过IS_CHANGED机制实现，前端根据分段数量动态调整",
			"分段精度为帧号，JSON 只保存 start_frame/end_frame/frames",
			"输出顺序与分段列表顺序一致",
			"需要安装FFmpeg才能正常工作",
		],

		"troubleshooting": [
			{
				"problem": "输出接口数量不对",
				"solution": "检查分段列表JSON，确保包含有效的 start_frame 和 end_frame 字段",
			},
			{
				"problem": "视频片段帧数不正确",
				"solution": "检查 start_frame/end_frame 是否超出视频总帧数",
			},
			{
				"problem": "FFmpeg未找到",
				"solution": "请确保系统已安装FFmpeg并添加到PATH环境变量",
			},
		],

		"changelog": [
			{
				"version": "1.0.0",
				"date": "2026-05-05",
				"changes": [
					"✨ 初始版本发布",
					"✨ 支持起止帧标记",
					"✨ 自动生成分段功能",
					"✨ 动态输出接口",
					"✨ 节点内视频加载",
					"🔧 批量视频裁剪输出",
				],
			},
		],
	}

	SEARCH_ALIASES = [
		"video segment editor",
		"video splitter",
		"video cropper",
		"视频分段",
		"视频裁剪",
		"视频分割",
		"video cutter",
		"segment extractor",
	]

	# 输出定义：第一个是分段列表JSON（STRING），第二个及之后是视频片段（VIDEO）
	# 由前端动态添加更多VIDEO输出
	RETURN_TYPES = ("STRING",) + ("VIDEO",) * MAX_SEGMENTS
	RETURN_NAMES = ("分段列表",) + tuple(f"视频片段{i}" for i in range(1, MAX_SEGMENTS + 1))
	OUTPUT_TOOLTIPS = ("编辑后的帧段JSON配置",) + tuple(f"第{i}个帧段的视频片段" for i in range(1, MAX_SEGMENTS + 1))

	@classmethod
	def INPUT_TYPES(cls):
		return {
			"required": {},
			"optional": {
				"video": ("VIDEO", {
					"display_name": "外部视频",
					"tooltip": "可选：外部连接的视频对象（优先级高于内部加载）",
				}),
				"video_file": ("STRING", {
					"default": "",
					"display_name": "视频文件",
					"tooltip": "由 📁打开 按钮写入，文件会复制到 ComfyUI input 目录。",
					"hidden": True,
					"display": "hidden",
				}),
				"segments_json": ("STRING", {
					"default": "[]",
					"multiline": True,
					"display_name": "分段列表JSON",
					"tooltip": "分段列表JSON，1基闭区间帧号：[{\"start_frame\": 1, \"end_frame\": 41, \"frames\": 41, \"label\": \"片段1\"}, ...]，每段严格满足 8N+1。",
				}),
				"refresh_nonce": ("STRING", {
					"default": "",
					"display_name": "刷新标记",
					"hidden": True,
					"display": "hidden",
				}),
			},
			"hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID"},
		}

	@classmethod
	def _get_video_files(cls) -> list[str]:
		"""获取可用的视频文件列表"""
		files = ["[不加载]"]

		# 从多个目录查找视频文件
		search_dirs = [
			folder_paths.get_input_directory(),
			folder_paths.get_output_directory(),
		]

		video_extensions = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv", ".wmv"}

		for search_dir in search_dirs:
			if not search_dir or not os.path.exists(search_dir):
				continue

			for root, dirs, filenames in os.walk(search_dir):
				for filename in filenames:
					if Path(filename).suffix.lower() in video_extensions:
						files.append(filename)

		return files

	def __init__(self):
		self.preview_video_path = None

	def edit_segments(
		self,
		video_file: str = "",
		video = None,
		segments_json: str = "[]",
		refresh_nonce: str = "",
		prompt=None,
		extra_pnginfo=None,
		unique_id=None,
	):
		# 1. 加载视频（优先使用外部连接，其次使用内部加载）
		video_path = None
		current_video = None
		frames = None
		source_audio = None
		frame_rate = 24.0
		width = 0
		height = 0
		total_frames = 0

		if video is not None and is_video_object(video):
			# 外部连接的视频对象
			current_video = video
			source_audio = _video_audio_component(current_video)
			video_path = _stream_source_path(current_video)
			frames, frame_rate, width, height = video_to_frames_data(current_video)
			total_frames = len(frames)
		else:
			video_path = resolve_video_file_path(video_file)

		if video is None and video_path:
			# 从文件加载 - 先快速获取元数据
			metadata = get_video_metadata(video_path)
			frame_rate = metadata["fps"]
			width = metadata["width"]
			height = metadata["height"]
			total_frames = int(metadata.get("frame_count") or 0)

			print(f"[GJJ] 视频分段编辑器 - 加载元数据: {total_frames}帧, {frame_rate}fps, {width}x{height}")

			# 快速提取首帧用于预览（不加载全部帧）
			first_frame = extract_first_frame(video_path)
			if first_frame is not None:
				frames = np.array([first_frame])  # 包装成 [1, H, W, 3] 格式
				print(f"[GJJ] 视频分段编辑器 - 成功提取首帧用于预览")

		if video is None and not video_path:
			raise RuntimeError("请连接外部视频或在节点内选择视频文件")

		# 3. 解析或生成分段列表（默认3段）
		segments = parse_segments_list(segments_json)
		if not segments:
			# 自动生成分段
			segments = generate_auto_frame_segments(total_frames, 3)
		else:
			segments = normalize_segments_to_frames(segments, total_frames)

		# 4. 构建预览数据 - 优先使用原始视频文件（快速）
		preview_video_data = []
		if video_path:
			# 直接使用原始视频文件作为预览，无需解码整段视频
			preview_video_data = [input_preview_entry(video_path)]
			try:
				preview_video_data[0]["mtime_ns"] = os.stat(video_path).st_mtime_ns
			except Exception:
				pass
			print(f"[GJJ] 视频分段编辑器 - 使用原始视频文件作为预览: {preview_video_data[0]['filename']}")
		elif frames is not None:
			# 外部 VIDEO 对象没有原始路径，保存临时 mp4 供前端 video 标签播放。
			try:
				filepath, filename = save_video_for_preview(frames, frame_rate, prompt)
				self.preview_video_path = filepath
				preview_video_data = [{
					"filename": filename,
					"subfolder": "",
					"type": "temp",
					"mtime_ns": os.stat(filepath).st_mtime_ns,
				}]
				print(f"[GJJ] 视频分段编辑器 - 使用外部VIDEO临时视频作为预览: {filename}")
			except Exception as e:
				print(f"[GJJ] 视频分段编辑器 - 保存预览文件失败: {e}")

		# 5. 构建UI数据（遵循ComfyUI规范：所有值必须用元组包裹）
		# 预览已由前端 video 元素直接读取源视频；这里不再为每段同步抽帧，避免刷新时额外卡顿。
		segment_thumbnails = []

		ui: dict[str, Any] = {
			"preview_text": (f"视频帧数: {total_frames} | 帧率: {frame_rate}Hz | 分辨率: {width}x{height} | 分段数量: {len(segments)}",),
			"preview_kind": ("video_segment_editor",),
			"preview_video": (preview_video_data,) if preview_video_data else (),
			"preview_segments": (format_segments_list(segments),),  # 字符串必须用元组包裹
			"preview_frame_rate": (frame_rate,),  # 数值必须用元组包裹
			"preview_total_frames": (total_frames,),  # 数值必须用元组包裹
			"preview_segment_count": (len(segments),),  # 数值必须用元组包裹
			"segment_thumbnails": (json.dumps(segment_thumbnails),),  # 分段缩略图
		}

		print(f"[GJJ] 视频分段编辑器 - 总帧数: {total_frames}, 分段数量: {len(segments)}")
		print(f"[GJJ] 视频分段编辑器 - preview_video_data: {preview_video_data}")
		print(f"[GJJ] 视频分段编辑器 - video_path: {video_path}, frames_loaded: {frames is not None}")

		# 7. 按帧裁剪视频
		video_segments = []
		has_valid_source = video_path is not None or (frames is not None and len(frames) > 0)

		if not has_valid_source:
			print(f"[GJJ] 错误：没有有效的视频源 (video_path={video_path}, frames={frames is not None})")
			# 填充空视频
			empty_frames = torch.zeros((1, max(height, 1), max(width, 1), 3), dtype=torch.float32)
			for _ in segments:
				video_segments.append(create_video_object(empty_frames, frame_rate))
		else:
			for i, segment in enumerate(segments):
				if not isinstance(segment, dict):
					print(f"[GJJ] 警告：分段{i+1}不是dict类型 ({type(segment).__name__})，跳过")
					continue
				start_frame = int(segment.get("start_frame", 1) or 1)
				end_frame = int(segment.get("end_frame", start_frame) or start_frame)

				# 确保帧范围有效
				if start_frame > end_frame:
					print(f"[GJJ] 警告：分段{i+1}的帧范围无效 ({start_frame}f - {end_frame}f)，跳过")
					continue

				try:
					if video_path:
						# 如果有原始文件路径，使用 FFmpeg 按帧裁剪到 ComfyUI temp
						segment_video = self._crop_video_with_ffmpeg(video_path, start_frame, end_frame, i + 1, prompt)
					else:
						# 否则从帧数组中裁剪并保存为 temp 视频
						segment_video = self._crop_video_from_frames(frames, start_frame, end_frame, frame_rate, i + 1, prompt, source_audio)

					video_segments.append(segment_video)
					print(f"[GJJ] 成功按帧裁剪分段{i+1}: {start_frame}f - {end_frame}f")
				except Exception as e:
					print(f"[GJJ] 裁剪分段{i+1}失败: {e}")
					# 填充空视频
					empty_frames = torch.zeros((1, max(height, 1), max(width, 1), 3), dtype=torch.float32)
					video_segments.append(create_video_object(empty_frames, frame_rate))

		# 8. 构建返回结果：
		# 第一个输出 = 分段列表JSON（STRING）
		# 后续输出 = 各视频片段（VIDEO）
		result_list = [format_segments_list(segments)]
		result_list.extend(video_segments)

		# 调试日志
		print(f"[GJJ] 视频分段编辑器 - 输出: 1个JSON + {len(video_segments)}个视频片段")

		return {
			"ui": ui,
			"result": tuple(result_list),
		}

	def _crop_video_with_ffmpeg(self, video_path: str, start_frame: int, end_frame: int, segment_index: int, prompt: Any = None):
		"""使用 FFmpeg 按帧裁剪到 ComfyUI temp，并返回该分段文件的 VIDEO 对象。"""
		output_path = _temp_segment_path(segment_index, start_frame, end_frame, prompt)

		if not crop_video_segment_ffmpeg(video_path, start_frame, end_frame, str(output_path)):
			raise RuntimeError("FFmpeg按帧裁剪失败")

		# 检查输出文件是否存在且有内容
		if not output_path.exists() or output_path.stat().st_size == 0:
			raise RuntimeError("FFmpeg裁剪后文件为空")

		return video_from_file_path(output_path)

	def _crop_video_from_frames(self, frames: np.ndarray, start_frame: int, end_frame: int, fps: float, segment_index: int, prompt: Any = None, audio: dict[str, Any] | None = None):
		"""从帧数组中按帧裁剪，保存到 ComfyUI temp，并返回该分段文件的 VIDEO 对象。"""
		total_frames = len(frames)
		if total_frames == 0:
			raise RuntimeError("无法从空帧数组裁剪视频片段")

		# 边界检查
		start_index = max(0, min(int(start_frame) - 1, total_frames - 1))
		end_index = max(start_index + 1, min(int(end_frame), total_frames))

		# 裁剪帧
		cropped_frames = frames[start_index:end_index]

		if len(cropped_frames) == 0:
			raise RuntimeError(f"裁剪后帧数为0 (start_frame={start_frame}, end_frame={end_frame}, total={total_frames})")

		output_path = _temp_segment_path(segment_index, start_frame, end_frame, prompt)
		save_frames_to_video_file(cropped_frames, fps, output_path)
		cropped_audio = _crop_audio_component(audio, start_frame, end_frame, fps)
		mux_audio_into_video_file(output_path, cropped_audio)
		return video_from_file_path(output_path)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoSegmentEditor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ✂️ 可视化视频分段编辑器"}
