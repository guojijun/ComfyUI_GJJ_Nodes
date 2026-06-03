"""
GJJ · ✂️ 音频分段编辑器
支持加载音频、自动生成分段、可视化编辑起止时间、按时间段裁剪并输出多个音频片段
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

import folder_paths
import torch

try:
	from .common_utils.dependency_checker import (
		build_dependency_model_report,
		check_dependencies,
		load_dependency_at_runtime,
		print_dependency_model_report,
		send_dependency_model_notice,
	)
	from .common_utils.network_media import (
		gjjutils_detect_media_type,
		gjjutils_download_network_media_to_input,
		gjjutils_is_network_url,
	)
except ImportError:
	from common_utils.dependency_checker import (
		build_dependency_model_report,
		check_dependencies,
		load_dependency_at_runtime,
		print_dependency_model_report,
		send_dependency_model_notice,
	)
	from common_utils.network_media import (
		gjjutils_detect_media_type,
		gjjutils_download_network_media_to_input,
		gjjutils_is_network_url,
	)


NODE_NAME = "GJJ_AudioTimestampEditor"
NODE_DISPLAY_NAME = "GJJ · ✂️ 可视化音频分段编辑器"
BACKEND_VERSION = "V28_SILENT_VIDEO_NO_AUDIO_TRACK"
MAX_SEGMENTS = 99  # 最大分段数量
MIN_OUTPUTS = 1  # 最小输出数量
DEFAULT_AUDIO_URL = "https://raw.githubusercontent.com/Comfy-Org/example_workflows/refs/heads/main/video/wan/wan2.2_s2v/input_audio.MP3"
AUDIO_MEDIA_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".aiff", ".aif", ".opus"}
VIDEO_MEDIA_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".wmv", ".mpeg", ".mpg"}
DEPENDENCY_SPECS = [
	{
		"module_name": "soundfile",
		"package_name": "soundfile",
		"display_name": "soundfile",
		"description": "可视化音频分段编辑器需要 soundfile 读取、保存和预览音频文件。",
	},
	{
		"module_name": "numpy",
		"package_name": "numpy",
		"display_name": "numpy",
		"description": "可视化音频分段编辑器需要 numpy 处理波形数组并生成预览数据。",
	},
]


def _collect_dependency_state() -> tuple[bool, list[dict[str, str]], str]:
	missing_dependencies: list[dict[str, str]] = []
	messages: list[str] = []
	for spec in DEPENDENCY_SPECS:
		available, message = check_dependencies([spec["module_name"]], NODE_DISPLAY_NAME)
		if not available:
			missing_dependencies.append(spec)
			if message:
				messages.append(message)
	return (not missing_dependencies), missing_dependencies, "\n".join(messages)


_DEPENDENCIES_AVAILABLE, _MISSING_DEPENDENCIES, _IMPORT_ERROR = _collect_dependency_state()
_MODELS_AVAILABLE = True
_MISSING_MODELS: list[dict[str, str]] = []
_DEPENDENCY_REPORT = build_dependency_model_report(
	node_name=NODE_DISPLAY_NAME,
	missing_dependencies=_MISSING_DEPENDENCIES,
	missing_models=_MISSING_MODELS,
	install_packages=[spec["package_name"] for spec in _MISSING_DEPENDENCIES],
	original_error=_IMPORT_ERROR or "",
)
_numpy = None
_soundfile = None


# V19：后端缓存。避免前端为了刷新波形/下游预览而重复请求上游时，
# 本节点反复保存预览、裁剪音频或在二次请求缺少外部 AUDIO 时直接报错。
_RESULT_CACHE: dict[str, dict[str, Any]] = {}
_LAST_SUCCESS_BY_NODE: dict[str, dict[str, Any]] = {}
_MAX_RESULT_CACHE = 12


def _safe_float(value: Any, default: float = 0.0) -> float:
	try:
		return float(value)
	except Exception:
		return default


def _audio_fingerprint(audio: Any) -> str:
	"""生成轻量音频指纹。只抽样少量数据，避免为了判重整段 hash 大音频。"""
	if not is_audio_object(audio):
		return "no-audio"
	try:
		waveform = audio.get("waveform")
		sample_rate = int(audio.get("sample_rate", 0) or 0)
		if isinstance(waveform, torch.Tensor):
			w = waveform.detach()
			shape = tuple(int(x) for x in w.shape)
			numel = int(w.numel())
			if numel <= 0:
				return f"tensor|sr={sample_rate}|shape={shape}|empty"
			flat = w.reshape(-1)
			# 均匀抽样 64 个点；用于判断是否换了音频，不追求密码学 hash。
			count = min(64, numel)
			idx = torch.linspace(0, numel - 1, steps=count, device=flat.device).long()
			samples = flat.index_select(0, idx).float().cpu()
			sum_v = float(samples.sum().item())
			abs_v = float(samples.abs().sum().item())
			mean_v = float(samples.mean().item())
			return f"tensor|sr={sample_rate}|shape={shape}|sum={sum_v:.8f}|abs={abs_v:.8f}|mean={mean_v:.8f}"
		return f"array|sr={sample_rate}|shape={getattr(waveform, 'shape', None)}|id={id(waveform)}"
	except Exception as exc:
		return f"audio-fingerprint-error:{type(exc).__name__}:{id(audio)}"


def _configured_media_dirs() -> tuple[str, ...]:
	return (
		folder_paths.get_input_directory(),
		folder_paths.get_output_directory(),
		folder_paths.get_temp_directory(),
	)


def _resolve_media_path(filename: str, *, allow_download: bool = True) -> str | None:
	if not filename or filename == "[不加载]":
		return None

	raw = str(filename or "").strip()
	if gjjutils_is_network_url(raw):
		if not allow_download:
			return None
		media_type = gjjutils_detect_media_type(raw) or "AUDIO"
		if media_type not in {"AUDIO", "VIDEO"}:
			media_type = "AUDIO"
		return gjjutils_download_network_media_to_input(raw, media_type)

	path = Path(raw).expanduser()
	if path.is_file():
		return str(path)

	for search_dir in _configured_media_dirs():
		if not search_dir:
			continue
		candidate = Path(search_dir) / raw
		if candidate.is_file():
			return str(candidate)
	return None


def _is_video_media_value(value: Any) -> bool:
	text = str(value or "").strip()
	if not text:
		return False
	if gjjutils_detect_media_type(text) == "VIDEO":
		return True
	try:
		return Path(text.split("?", 1)[0]).suffix.lower() in VIDEO_MEDIA_EXTENSIONS
	except Exception:
		return False


def _audio_data_to_comfy(audio_data: Any, sample_rate: Any) -> dict[str, Any]:
	if audio_data.ndim == 1:
		audio_data = audio_data.reshape(1, -1)
	elif audio_data.ndim == 2:
		audio_data = audio_data.T
	waveform = torch.from_numpy(audio_data).float().unsqueeze(0)
	return {
		"waveform": waveform,
		"sample_rate": int(sample_rate),
	}


def _get_ffmpeg_executable() -> str:
	try:
		from .gjj_video_combine_runtime import get_ffmpeg_path
	except Exception:
		try:
			from gjj_video_combine_runtime import get_ffmpeg_path
		except Exception:
			get_ffmpeg_path = None

	if get_ffmpeg_path is not None:
		try:
			ffmpeg_path = get_ffmpeg_path()
			if ffmpeg_path:
				return str(ffmpeg_path)
		except Exception:
			pass

	try:
		from imageio_ffmpeg import get_ffmpeg_exe

		ffmpeg_path = get_ffmpeg_exe()
		if ffmpeg_path:
			return str(ffmpeg_path)
	except Exception:
		pass

	try:
		import shutil

		ffmpeg_path = shutil.which("ffmpeg")
		if ffmpeg_path:
			return str(ffmpeg_path)
	except Exception:
		pass

	for local_name in ("ffmpeg.exe", "ffmpeg"):
		local_path = Path(local_name).resolve()
		if local_path.is_file():
			return str(local_path)

	raise RuntimeError("当前环境未找到 ffmpeg，无法从视频文件中抽取音频轨道。请安装 ffmpeg，或安装 imageio-ffmpeg 后重启 ComfyUI。")


def _get_ffprobe_executable(ffmpeg_path: str | None = None) -> str | None:
	try:
		if ffmpeg_path:
			path = Path(ffmpeg_path)
			probe_name = "ffprobe.exe" if path.suffix.lower() == ".exe" else "ffprobe"
			candidate = path.with_name(probe_name)
			if candidate.is_file():
				return str(candidate)
	except Exception:
		pass
	try:
		import shutil

		ffprobe_path = shutil.which("ffprobe")
		if ffprobe_path:
			return str(ffprobe_path)
	except Exception:
		pass
	return None


def _probe_media_duration_seconds(filepath: str, ffmpeg_path: str | None = None) -> float:
	import subprocess

	ffprobe_path = _get_ffprobe_executable(ffmpeg_path)
	if ffprobe_path:
		try:
			proc = subprocess.run(
				[
					ffprobe_path,
					"-v", "error",
					"-show_entries", "format=duration",
					"-of", "default=noprint_wrappers=1:nokey=1",
					filepath,
				],
				capture_output=True,
				text=True,
				check=False,
			)
			value = float(str(proc.stdout or "").strip())
			if value > 0:
				return value
		except Exception:
			pass

	try:
		ffmpeg_path = ffmpeg_path or _get_ffmpeg_executable()
		proc = subprocess.run(
			[ffmpeg_path, "-hide_banner", "-i", filepath],
			capture_output=True,
			text=True,
			check=False,
		)
		text = f"{proc.stdout or ''}\n{proc.stderr or ''}"
		match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
		if match:
			hours = int(match.group(1))
			minutes = int(match.group(2))
			seconds = float(match.group(3))
			value = hours * 3600 + minutes * 60 + seconds
			if value > 0:
				return value
	except Exception:
		pass
	return 0.0


def _make_silent_audio(duration_seconds: float, sample_rate: int = 44100) -> dict[str, Any]:
	duration_seconds = max(0.05, _safe_float(duration_seconds, 3.0))
	sample_rate = max(1, int(sample_rate or 44100))
	samples = max(1, int(round(duration_seconds * sample_rate)))
	return {
		"waveform": torch.zeros((1, 2, samples), dtype=torch.float32),
		"sample_rate": sample_rate,
		"_gjj_silent_video_audio": True,
		"_gjj_silent_duration": float(samples) / float(sample_rate),
	}


def _looks_like_missing_audio_stream_error(text: str) -> bool:
	lower = str(text or "").lower()
	return any(
		pattern in lower
		for pattern in (
			"output file does not contain any stream",
			"matches no streams",
			"stream specifier",
			"no audio",
			"audio: none",
		)
	)


def _file_fingerprint(filename: str) -> str:
	try:
		path = _resolve_media_path(filename, allow_download=True)
	except Exception as exc:
		return f"file-resolve-error:{filename}:{type(exc).__name__}:{exc}"
	if not path:
		return f"file-missing:{filename}"
	try:
		st = os.stat(path)
		return f"file|{os.path.abspath(path)}|size={st.st_size}|mtime={st.st_mtime_ns}"
	except Exception:
		return f"file|{path}|stat-error"


def _segments_cache_text(segments: list[dict[str, Any]]) -> str:
	try:
		return json.dumps(segments, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
	except Exception:
		return str(segments)


def _remember_result(cache_key: str, node_key: str, payload: dict[str, Any]) -> None:
	_RESULT_CACHE[cache_key] = payload
	_LAST_SUCCESS_BY_NODE[node_key] = payload
	while len(_RESULT_CACHE) > _MAX_RESULT_CACHE:
		try:
			_RESULT_CACHE.pop(next(iter(_RESULT_CACHE)))
		except Exception:
			break


def _clone_payload(payload: dict[str, Any], status_suffix: str = "") -> dict[str, Any]:
	"""返回缓存结果。Tensor 不深拷贝，避免额外内存；UI 字典浅拷贝并补充状态。"""
	ui = dict(payload.get("ui") or {})
	if status_suffix:
		old = ""
		try:
			old = str((ui.get("preview_text") or ("",))[0])
		except Exception:
			old = ""
		ui["preview_text"] = (f"{old}\n{status_suffix}" if old else status_suffix,)
	return {"ui": ui, "result": payload.get("result")}

_DESCRIPTION_INTRO = """
🟢 音频分段编辑器：加载音频后自动生成分段，可视化编辑起止时间，按时间段裁剪并输出多个音频片段。

【核心功能】
• 节点内加载音频 - 支持从下拉列表选择音频/视频文件
• 视频静默取音频 - 选择视频文件时自动抽取音频轨道；没有音轨的视频会生成同长度静音
• 自动生成分段 - 根据音频时长自动创建等分时间段
• 可视化编辑 - Canvas波形显示，拖拽调整起止时间标记
• 动态输出 - 根据分段数量自动扩展输出接口
• 批量裁剪 - 一次性输出所有分段的音频片段

📦 运行时依赖：
  • soundfile（音频文件读写库）
  • numpy（数值计算库）
"""

# 步骤3: 配置动态 DESCRIPTION
DESCRIPTION = (
	_DESCRIPTION_INTRO
	if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
	else f"{_DEPENDENCY_REPORT['warning_message']}\n\n{_DESCRIPTION_INTRO}"
)


def is_audio_object(value: Any) -> bool:
	"""检测是否为ComfyUI音频对象"""
	if not isinstance(value, dict):
		return False
	return "waveform" in value and "sample_rate" in value


def parse_segments_list(text: str) -> list[dict[str, Any]]:
	"""解析分段列表，支持多种格式，过滤非dict元素"""
	if not text or not text.strip():
		return []

	try:
		data = json.loads(text)
		if isinstance(data, list):
			# 过滤掉非dict元素，只保留带有start/end字段的字典
			return [
				item for item in data
				if isinstance(item, dict) and ("start" in item or "end" in item)
			]
		elif isinstance(data, dict) and ("start" in data or "end" in data):
			return [data]
	except json.JSONDecodeError:
		pass

	return []


def format_segments_list(segments: list[dict[str, Any]]) -> str:
	"""格式化分段列表为JSON字符串"""
	if not segments:
		return "[]"
	return json.dumps(segments, ensure_ascii=False, indent=2)

def _segments_from_workflow_properties(extra_pnginfo: Any, unique_id: Any) -> list[dict[str, Any]]:
	"""从工作流节点 properties 中读取前端最新分段。

	原因：隐藏 widget 在某些 ComfyUI 前端版本中可能不会及时把 widgets_values 缓存更新到 prompt，
	导致后端收到旧的 segments_json。properties.segments 由前端拖动时同步写入，作为更可靠的兜底。
	"""
	if unique_id is None or not isinstance(extra_pnginfo, dict):
		return []
	try:
		workflow = extra_pnginfo.get("workflow") or {}
		nodes = workflow.get("nodes") or []
		uid = str(unique_id)
		for node in nodes:
			if str(node.get("id")) != uid:
				continue
			props = node.get("properties") or {}
			text = props.get("segments") or props.get("segments_json") or ""
			return parse_segments_list(text)
	except Exception:
		return []
	return []


def _segments_from_prompt_inputs(prompt: Any, unique_id: Any) -> list[dict[str, Any]]:
	"""从当前 prompt 的节点输入里读取分段。

	部分前端版本在点击执行时会先生成 API prompt，再异步刷新 workflow extra_pnginfo。
	隐藏 widget 的 segments_json 如果已经进入 prompt inputs，应优先作为后端执行兜底。
	"""
	if unique_id is None or not isinstance(prompt, dict):
		return []
	node = prompt.get(str(unique_id)) or prompt.get(unique_id)
	if not isinstance(node, dict):
		return []
	inputs = node.get("inputs") or {}
	if not isinstance(inputs, dict):
		return []
	for key in ("segments_json", "分段列表JSON", "segments"):
		value = inputs.get(key)
		if isinstance(value, str):
			segments = parse_segments_list(value)
			if segments:
				return segments
	return []


def _prompt_input_is_linked(prompt: Any, unique_id: Any, key_names: tuple[str, ...]) -> bool:
	if unique_id is None or not isinstance(prompt, dict):
		return False
	node = prompt.get(str(unique_id)) or prompt.get(unique_id)
	if not isinstance(node, dict):
		return False
	inputs = node.get("inputs") or {}
	if not isinstance(inputs, dict):
		return False
	for key in key_names:
		value = inputs.get(key)
		if isinstance(value, (list, tuple)) and value:
			return True
	return False


def _segments_for_execution(prompt: Any, extra_pnginfo: Any, unique_id: Any, segments_json: str) -> list[dict[str, Any]]:
	"""选择本次执行要使用的分段。

	如果 segments_json 接了外部输入，优先使用真正执行时解析到的参数。
	否则优先使用 workflow properties：前端每次拖拽/改时长都会同步写入这里，
	可避免隐藏 widget 的旧 prompt 值把分段拉回默认 3 秒。
	"""
	widget_segments = parse_segments_list(segments_json)
	if _prompt_input_is_linked(prompt, unique_id, ("segments_json", "分段列表JSON", "segments")) and widget_segments:
		return widget_segments

	property_segments = _segments_from_workflow_properties(extra_pnginfo, unique_id)
	if property_segments:
		return property_segments

	prompt_segments = _segments_from_prompt_inputs(prompt, unique_id)
	if prompt_segments:
		return prompt_segments

	return widget_segments


def _load_numpy_runtime():
	global _numpy
	if _numpy is None:
		_numpy = load_dependency_at_runtime(
			"numpy",
			NODE_DISPLAY_NAME,
			package_name="numpy",
			description="音频分段编辑器需要 numpy 处理波形数组。",
		)
	return _numpy


def _load_soundfile_runtime(unique_id: Any = None):
	global _soundfile
	if _soundfile is None:
		_soundfile = load_dependency_at_runtime(
			"soundfile",
			NODE_DISPLAY_NAME,
			package_name="soundfile",
			description="音频文件读写库",
			unique_id=unique_id,
		)
	return _soundfile


def audio_to_waveform_data(audio: dict[str, Any]) -> tuple[Any, int]:
	"""将ComfyUI音频对象转换为numpy波形数据和采样率"""
	np = _load_numpy_runtime()
	waveform = audio.get("waveform")
	sample_rate = int(audio.get("sample_rate", 44100))

	if isinstance(waveform, torch.Tensor):
		audio_np = waveform.squeeze(0).cpu().numpy()
		if audio_np.ndim == 2:
			audio_np = audio_np.T
		elif audio_np.ndim == 1:
			audio_np = audio_np.reshape(-1, 1)
	else:
		audio_np = np.array(waveform)

	return audio_np, sample_rate


def save_audio_for_preview(audio_np: Any, sample_rate: int, prompt: Any = None, unique_id: Any = None) -> tuple[str, str]:
	"""保存音频到临时文件用于预览。

	注意：文件名必须每次执行都变化。
	上游 AUDIO 对象更新时，工作流 prompt 结构通常不变；如果继续使用 hash(prompt) 作为文件名，
	浏览器 /view 会命中旧缓存，前端拿到的还是旧音频，表现为“上游传入了音频但波形不刷新”。
	"""
	import time

	sf = _load_soundfile_runtime(unique_id=unique_id)

	output_dir = folder_paths.get_temp_directory()
	node_part = str(unique_id if unique_id is not None else hash(str(prompt)))
	filename = f"GJJ_AudioSegmentEditor_{node_part}_{time.time_ns()}.wav"
	filepath = os.path.join(output_dir, filename)

	os.makedirs(output_dir, exist_ok=True)
	sf.write(filepath, audio_np, sample_rate)

	return filepath, filename


def _send_status(unique_id: Any, text: str, progress: float = None) -> None:
	"""发送状态更新到前端"""
	if not unique_id:
		return
	try:
		from server import PromptServer
		data = {"node": str(unique_id), "text": str(text or "")}
		if progress is not None:
			data["progress"] = float(progress)
		PromptServer.instance.send_sync("gjj_node_progress", data)
	except Exception:
		pass


def crop_audio_segment(audio: dict[str, Any], start_time: float, end_time: float) -> dict[str, Any]:
	"""根据起止时间裁剪音频片段"""
	waveform = audio.get("waveform")
	sample_rate = int(audio.get("sample_rate", 44100))

	if not isinstance(waveform, torch.Tensor):
		raise RuntimeError("音频对象缺少有效的waveform数据")

	total_samples = waveform.shape[-1]
	start_sample = int(start_time * sample_rate)
	end_sample = int(end_time * sample_rate)

	# 边界检查
	start_sample = max(0, min(start_sample, total_samples - 1))
	end_sample = max(start_sample + 1, min(end_sample, total_samples))

	# 裁剪音频
	cropped_waveform = waveform[..., start_sample:end_sample].contiguous()

	return {
		"waveform": cropped_waveform,
		"sample_rate": sample_rate,
	}


def generate_auto_segments(duration: float, segment_count: int = 1, segment_duration: float = 3.0) -> list[dict[str, Any]]:
	"""根据音频时长生成默认时间段。默认只生成 1 段，并按单段时长截取。"""
	if duration <= 0:
		return []

	segment_count = max(1, int(segment_count or 1))
	segment_duration = max(0.05, float(segment_duration or 3.0))

	# 单段模式：从 0 秒开始，长度由“单段时长”决定，前端可拖动位置或拉长拉短。
	if segment_count <= 1:
		return [{
			"start": 0.0,
			"end": round(min(duration, segment_duration), 3),
			"label": "片段 1",
		}]

	# 多段模式：每段优先使用单段时长，不足时自动裁到音频尾部。
	segments = []
	for i in range(segment_count):
		start = min(duration, i * segment_duration)
		end = min(duration, start + segment_duration)
		if end <= start:
			break
		segments.append({
			"start": round(start, 3),
			"end": round(end, 3),
			"label": f"片段 {i + 1}",
		})

	return segments or [{"start": 0.0, "end": round(min(duration, segment_duration), 3), "label": "片段 1"}]


class GJJ_AudioSegmentEditor:
	CATEGORY = "GJJ/音频"
	FUNCTION = "edit_segments"
	OUTPUT_NODE = True
	DESCRIPTION = DESCRIPTION  # 引用模块级别的动态 DESCRIPTION

	# 依赖声明
	REQUIRED_PACKAGES = [
		"soundfile>=0.12.0",
		"numpy>=1.20.0",
	]

	REQUIRED_MODELS = []

	GJJ_HELP = {
		"title": "GJJ · ✂️ 音频分段编辑器",
		"version": "2.1.2",
		"author": "GJJ Custom Nodes Team",
		"description": DESCRIPTION,
		"notice": _DEPENDENCY_REPORT["help_message"] if not _DEPENDENCY_REPORT["available"] else "",
		"install_cmd": _DEPENDENCY_REPORT["install_cmd"] if not _DEPENDENCY_REPORT["available"] else "",
		"copy_text": _DEPENDENCY_REPORT["copy_text"] if not _DEPENDENCY_REPORT["available"] else "",
		"copy_label": _DEPENDENCY_REPORT["copy_label"] if not _DEPENDENCY_REPORT["available"] else "",
		"warning_message": _DEPENDENCY_REPORT["warning_message"] if not _DEPENDENCY_REPORT["available"] else "",

		"models": [],

		"dependencies": [
			"soundfile（音频文件读写库）",
			"numpy（数值计算库）",
		],

		"features": [
			{
				"name": "节点内音频加载",
				"description": "内置音频/视频文件选择器；默认可用网络音频，选择视频时会静默抽取音频轨道；无音轨视频会生成静音",
				"supported_formats": ["WAV", "MP3", "FLAC", "MP4", "MOV", "MKV", "WEBM"],
			},
			{
				"name": "自动分段生成",
				"description": "默认创建 1 个时间段；后续裁剪始终以面板中的开始/结束时间为准",
				"default_segments": 1,
				"customizable": True,
			},
			{
				"name": "可视化编辑",
				"description": "Canvas波形显示，拖拽调整起止时间",
				"precision": "millisecond",
			},
			{
				"name": "动态输出接口",
				"description": "根据分段数量自动扩展输出插槽",
				"max_outputs": MAX_SEGMENTS,
			},
			{
				"name": "批量裁剪",
				"description": "一次性输出所有分段的音频片段",
				"format": "AUDIO",
			},
		],

		"inputs": {
			"audio": {
				"type": "AUDIO",
				"required": False,
				"description": "可选：外部连接的音频对象（优先级高于内部加载）",
			},
			"audio_file": {
				"type": "COMBO",
				"required": False,
				"description": "节点内音频/视频文件选择器；默认使用 Comfy 官方 Wan2.2 S2V 示例音频 URL。网络资源会通过公共函数下载解析；选择视频时会静默抽取音频轨道。",
			},
			"segments_json": {
				"type": "STRING",
				"required": False,
				"default": "[]",
				"description": "分段列表JSON（可选，为空则自动生成）",
				"multiline": True,
			},
			"segment_count": {
				"type": "INT",
				"required": False,
				"default": 4,
				"description": "自动分段数量（当segments_json为空时生效）",
			},
		},

		"outputs": {
			"音频片段1...N": {
				"type": "AUDIO",
				"description": "动态输出，数量等于分段数量",
			},
			"分段列表": {
				"type": "STRING",
				"description": "编辑后的时间段JSON配置",
			},
		},

		"usage_examples": [
			{
				"title": "语音分段提取",
				"description": "将长语音自动分段，提取各个片段",
				"workflow": "[Load Audio] → [GJJ Audio Segment Editor] → [多个输出]",
			},
			{
				"title": "音乐片段裁剪",
				"description": "标记音乐的不同段落并分别输出",
				"workflow": "[Music File] → [GJJ Audio Segment Editor]",
			},
			{
				"title": "播客章节分离",
				"description": "按章节时间戳分离播客内容",
				"workflow": "[Podcast] → [GJJ Audio Segment Editor]",
			},
		],

		"technical_notes": [
			"音频裁剪使用 torch.Tensor 切片，保持原始采样率",
			"实际裁剪以面板写入的 start/end 分段列表为准；当前片段长度只用于调整面板",
			"视频文件通过 ffmpeg -vn 静默抽取音频轨道后再进入分段流程；没有音轨时按视频时长生成静音 AUDIO",
			"动态输出接口通过IS_CHANGED机制实现，前端根据分段数量动态调整",
			"时间段精度为毫秒级（小数点后3位）",
			"输出顺序与分段列表顺序一致",
		],

		"troubleshooting": [
			{
				"problem": "输出接口数量不对",
				"solution": "检查分段列表JSON，确保包含有效的start和end字段",
			},
			{
				"problem": "音频片段时长不正确",
				"solution": "检查起止时间是否重叠或超出音频总时长",
			},
			{
				"problem": "视频无法生成音频片段",
				"solution": "确认运行环境可调用 ffmpeg；如果视频本身没有音轨，节点会自动生成同长度静音。",
			},
		],

		"changelog": [
			{
				"version": "2.1.2",
				"date": "2026-06-03",
				"changes": [
					"🔇 无音轨视频自动生成同长度静音 AUDIO",
				],
			},
			{
				"version": "2.1.1",
				"date": "2026-06-03",
				"changes": [
					"✨ 默认音频支持网络 URL 并复用 GJJ_TemplateParams 公共下载逻辑",
					"🔧 选择视频文件时静默抽取音频轨道",
				],
			},
			{
				"version": "2.1.0",
				"date": "2026-05-04",
				"changes": [
					"✨ 重构为音频分段编辑器",
					"✨ 支持起止时间标记",
					"✨ 自动生成分段功能",
					"✨ 动态输出接口",
					"✨ 节点内音频加载",
					"🔧 批量音频裁剪输出",
				],
			},
		],
	}

	SEARCH_ALIASES = [
		"audio segment editor",
		"audio splitter",
		"audio cropper",
		"音频分段",
		"音频裁剪",
		"音频分割",
		"audio cutter",
		"segment extractor",
	]

	# 输出定义：必须与前端可见输出槽位顺序完全一致：
	# slot0 = 音频片段1，slot1 = 分段列表，slot2... = 音频片段2...
	# 之前把“分段列表”放在最后，会导致前端动态输出槽位和后端 result 槽位错位。
	RETURN_TYPES = ("AUDIO", "STRING") + ("AUDIO",) * (MAX_SEGMENTS - 1)
	RETURN_NAMES = ("音频片段1", "分段列表") + tuple(f"音频片段{i}" for i in range(2, MAX_SEGMENTS + 1))
	OUTPUT_TOOLTIPS = ("第1个时间段的音频片段", "编辑后的时间段JSON配置") + tuple(f"第{i}个时间段的音频片段" for i in range(2, MAX_SEGMENTS + 1))

	@classmethod
	def INPUT_TYPES(cls):
		# 获取音频/视频文件列表
		audio_files = cls._get_audio_files()

		return {
			"required": {
				"audio_file": (audio_files, {
					"display_name": "音频/视频文件",
					"tooltip": "节点内音频/视频文件选择器；默认是 Comfy 官方 Wan2.2 S2V 示例音频 URL。支持 http/https 网络音频；选择视频时后端会静默抽取音频轨道。",
				}),
			},
			"optional": {
				"audio": ("AUDIO", {
					"display_name": "外部音频",
					"tooltip": "可选：外部连接的音频对象；当上方文件为[不加载]时生效，避免界面显示文件波形但后端裁剪外部音频。",
				}),
				"segments_json": ("STRING", {
					"default": "[]",
					"multiline": True,
					"display_name": "分段列表JSON",
					"tooltip": "时间段列表，格式：[{\"start\": 0.0, \"end\": 2.5, \"label\": \"片段1\"}, ...]。前端会完整隐藏，不占空行。",
				}),
				"segment_duration": ("FLOAT", {
					"default": 3.0,
					"min": 0.05,
					"max": 3600.0,
					"step": 0.1,
					"display_name": "当前片段长度",
					"tooltip": "内部同步值：右上角数字只调整当前面板片段长度；实际输出始终以面板中的开始/结束时间为准。",
				}),
			},
			"hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID"},
		}

	@classmethod
	def _get_audio_files(cls) -> list[str]:
		"""获取可用的音频/视频文件列表"""
		files = [DEFAULT_AUDIO_URL, "[不加载]"]
		seen = set(files)

		# 从多个目录查找音频/视频文件
		search_dirs = [
			folder_paths.get_input_directory(),
			folder_paths.get_output_directory(),
		]

		media_extensions = AUDIO_MEDIA_EXTENSIONS | VIDEO_MEDIA_EXTENSIONS

		for search_dir in search_dirs:
			if not search_dir or not os.path.exists(search_dir):
				continue

			for root, dirs, filenames in os.walk(search_dir):
				for filename in filenames:
					if Path(filename).suffix.lower() in media_extensions:
						try:
							display_name = Path(root, filename).relative_to(search_dir).as_posix()
						except Exception:
							display_name = filename
						if display_name not in seen:
							seen.add(display_name)
							files.append(display_name)

		return files

	@classmethod
	def IS_CHANGED(cls, audio_file="[不加载]", audio=None, segments_json: str = "[]", segment_duration: float = 3.0, prompt=None, extra_pnginfo=None, unique_id=None, **kwargs):
		# V19：稳定缓存 key。不要再 time_ns 强制重跑；否则前端刷新波形/下游预览时会不断请求上游。
		segments = _segments_for_execution(prompt, extra_pnginfo, unique_id, segments_json)
		seg_text = _segments_cache_text(segments) if segments else str(segments_json or "[]")
		if audio_file and audio_file != "[不加载]":
			source_sig = _file_fingerprint(audio_file)
		elif is_audio_object(audio):
			source_sig = _audio_fingerprint(audio)
		else:
			source_sig = "no-input"
		return f"{BACKEND_VERSION}|src={source_sig}|segments={seg_text}|dur={_safe_float(segment_duration):.6f}"

	def __init__(self):
		self.preview_audio_path = None

	def edit_segments(
		self,
		audio_file: str = "[不加载]",
		audio = None,
		segments_json: str = "[]",
		segment_duration: float = 3.0,
		prompt=None,
		extra_pnginfo=None,
		unique_id=None,
	):
		try:
			node_key = str(unique_id if unique_id is not None else id(self))
			# 1. 加载音频。这里必须与前端可见波形一致：
			#    只要下拉框选择了文件，就裁剪该文件；文件为[不加载]时才使用外部 AUDIO。
			if audio_file != "[不加载]":
				current_audio = self._load_audio_from_file(audio_file, fallback_duration=segment_duration)
				source_sig = _file_fingerprint(audio_file)
				if isinstance(current_audio, dict) and current_audio.get("_gjj_silent_video_audio"):
					source_label = f"视频无音轨，已生成静音:{audio_file}"
				else:
					source_label = f"网络音频:{audio_file}" if gjjutils_is_network_url(str(audio_file or "")) else f"文件:{audio_file}"
			elif audio is not None and is_audio_object(audio):
				current_audio = audio
				source_sig = _audio_fingerprint(audio)
				source_label = "外部音频"
			else:
				last = _LAST_SUCCESS_BY_NODE.get(node_key)
				if last is not None:
					print(f"[GJJ] 音频分段编辑器 {BACKEND_VERSION} - 二次请求未携带输入，复用本节点上次成功输出")
					return _clone_payload(last, "♻️ 二次请求未携带输入，已复用上次成功输出")
				raise RuntimeError("请连接外部音频或在节点内选择音频/视频文件")

			# 2. 转换音频数据
			audio_np, sample_rate = audio_to_waveform_data(current_audio)
			duration = len(audio_np) / sample_rate if sample_rate > 0 else 0

			# 3. 解析或生成分段列表。实际裁剪以面板 start/end 为准；
			#    只有 segments_json 真正外部连线时，才让外部输入覆盖面板。
			segments = _segments_for_execution(prompt, extra_pnginfo, unique_id, segments_json)
			if not segments:
				# 默认只生成 1 段，按“单段时长”截取；前端可拖动高亮区域调整位置。
				segments = generate_auto_segments(duration, 1, segment_duration)
			else:
				# 边界兜底，避免前端传入超出总时长的时间段。
				normalized_segments = []
				for idx, seg in enumerate(segments):
					try:
						start = max(0.0, min(float(seg.get("start", 0.0)), max(0.0, duration - 0.001)))
						end = max(start + 0.001, min(float(seg.get("end", duration)), duration))
						normalized_segments.append({
							"start": round(start, 3),
							"end": round(end, 3),
							"label": seg.get("label") or f"片段 {idx + 1}",
							"color": seg.get("color"),
						})
					except Exception:
						pass
				segments = normalized_segments or generate_auto_segments(duration, 1, segment_duration)

			segments_sig = _segments_cache_text(segments)
			cache_key = f"{BACKEND_VERSION}|{source_sig}|segments={segments_sig}|segment_duration={_safe_float(segment_duration):.6f}"
			cached = _RESULT_CACHE.get(cache_key)
			if cached is not None:
				_LAST_SUCCESS_BY_NODE[node_key] = cached
				print(f"[GJJ] 音频分段编辑器 {BACKEND_VERSION} - 缓存命中，跳过预览保存和音频裁剪")
				return _clone_payload(cached, "♻️ 缓存命中：音频和分段未变化，跳过重复计算")

			# 4. 保存音频用于预览
			try:
				filepath, filename = save_audio_for_preview(audio_np, sample_rate, prompt, unique_id)
				self.preview_audio_path = filepath
			except Exception as e:
				print(f"[GJJ] 音频分段编辑器 - 保存预览文件失败: {e}")
				filename = ""

			# 5. 构建预览数据
			preview_audio_data = []
			if filename:
				preview_audio_data = [{
					"filename": filename,
					"subfolder": "",
					"type": "temp",
				}]

			# 6. 构建 UI数据（遵循ComfyUI规范：所有值必须用元组包裹）
			ui: dict[str, Any] = {
				"preview_text": (f"后端 {BACKEND_VERSION} | 来源: {source_label} | 音频时长: {duration:.2f}秒 | 采样率: {sample_rate}Hz | 分段数量: {len(segments)}",),
				"backend_version": (BACKEND_VERSION,),
				"preview_kind": ("audio_segment_editor",),
				"preview_audio": (preview_audio_data,) if preview_audio_data else (),
				"preview_segments": (format_segments_list(segments),),  # 字符串必须用元组包裹
				"preview_duration": (duration,),  # 数值必须用元组包裹
				"preview_sample_rate": (sample_rate,),  # 数值必须用元组包裹
				"preview_segment_count": (len(segments),),  # 数值必须用元组包裹
			}

			print(f"[GJJ] 音频分段编辑器 {BACKEND_VERSION} - 音频时长: {duration:.2f}秒, 分段数量: {len(segments)}")

			# 7. 按时间段裁剪音频
			audio_segments = []
			for i, segment in enumerate(segments):
				if not isinstance(segment, dict):
					print(f"[GJJ] 警告：分段{i+1}不是dict类型 ({type(segment).__name__})，跳过")
					continue
				start = float(segment.get("start", 0))
				end = float(segment.get("end", duration))

				# 确保时间范围有效
				if start >= end:
					print(f"[GJJ] 警告：分段{i+1}的时间范围无效 ({start}s - {end}s)，跳过")
					continue

				try:
					segment_audio = crop_audio_segment(current_audio, start, end)
					audio_segments.append(segment_audio)
				except Exception as e:
					print(f"[GJJ] 裁剪分段{i+1}失败: {e}")
					# 填充空音频
					audio_segments.append({
						"waveform": torch.zeros((1, 1, 1), dtype=torch.float32),
						"sample_rate": sample_rate,
					})

			# 8. 构建返回结果，必须按 RETURN_TYPES 槽位顺序返回：
			# slot0=音频片段1，slot1=分段列表JSON，slot2...=音频片段2...
			# 同时补齐到 RETURN_TYPES 长度，避免 ComfyUI 动态输出/缓存时错位。
			empty_audio = {
				"waveform": torch.zeros((1, 1, 1), dtype=torch.float32),
				"sample_rate": sample_rate,
			}
			first_audio = audio_segments[0] if audio_segments else empty_audio
			result_list = [first_audio, format_segments_list(segments)]
			for idx in range(1, MAX_SEGMENTS):
				result_list.append(audio_segments[idx] if idx < len(audio_segments) else empty_audio)

			# 调试日志：直接打印后端实际裁剪区间，方便核对前端高亮是否进入最终计算。
			first_samples = 0
			try:
				first_samples = int((first_audio.get("waveform")).shape[-1])
			except Exception:
				first_samples = 0
			ui["preview_output_duration"] = (round(first_samples / sample_rate, 3) if sample_rate else 0.0,)

			debug_ranges = ", ".join(
				f"{float(s.get('start', 0)):.3f}-{float(s.get('end', 0)):.3f}s"
				for s in segments if isinstance(s, dict)
			)
			print(f"[GJJ] 音频分段编辑器 {BACKEND_VERSION} - 输出: {len(audio_segments)}个音频片段 + 1个JSON；分段={debug_ranges}；slot0时长={ui['preview_output_duration'][0]}s")

			payload = {
				"ui": ui,
				"result": tuple(result_list),
			}
			_remember_result(cache_key, node_key, payload)
			return payload
		except Exception as exc:
			report = getattr(exc, "gjj_report", None)
			if report is not None:
				send_dependency_model_notice(report, unique_id=unique_id)
				raise RuntimeError(report.get("warning_message") or "运行时依赖缺失。") from exc
			# 其他错误使用标准格式
			raise RuntimeError(
				f"🎤 音频分段编辑器执行失败\n"
				f"参数：audio_file={audio_file}, segment_duration={segment_duration}\n\n"
				f"详细错误：{exc}"
			) from exc

	def _load_audio_from_file(self, filename: str, fallback_duration: float = 3.0) -> dict[str, Any]:
		"""从音频/视频文件加载音频；视频文件通过 ffmpeg 只提取音频"""
		import subprocess
		import tempfile

		sf = _load_soundfile_runtime()
		filepath = _resolve_media_path(filename, allow_download=True)
		if not filepath or not os.path.exists(filepath):
			raise RuntimeError(f"找不到音频/视频文件: {filename}")

		is_video = _is_video_media_value(filename) or _is_video_media_value(filepath)
		soundfile_error = None

		if not is_video:
			try:
				audio_data, sample_rate = sf.read(filepath)
				return _audio_data_to_comfy(audio_data, sample_rate)
			except Exception as exc:
				soundfile_error = exc
				print(f"[GJJ] soundfile 无法直接加载 {filename}，尝试 ffmpeg 解码音频... ({exc})")

		# ffmpeg 回退：转换成临时 WAV
		tmp_path = None
		try:
			with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
				tmp_path = tmp.name

			ffmpeg_path = _get_ffmpeg_executable()
			cmd = [
				ffmpeg_path, "-y", "-v", "error",
				"-i", filepath,
				"-vn",
				"-acodec", "pcm_s16le",
				"-ar", "44100",
				"-ac", "2",
				tmp_path,
			]
			subprocess.run(cmd, capture_output=True, text=True, check=True)

			audio_data, sample_rate = sf.read(tmp_path)
			if not is_video:
				print(f"[GJJ] ffmpeg 解码音频成功: {filename}")
			return _audio_data_to_comfy(audio_data, sample_rate)
		except Exception as exc:
			stderr_text = str(getattr(exc, "stderr", "") or getattr(exc, "output", "") or "").strip()
			if len(stderr_text) > 500:
				stderr_text = f"{stderr_text[:500]}..."
			detail = stderr_text or str(exc)
			if is_video:
				if _looks_like_missing_audio_stream_error(detail):
					duration = _probe_media_duration_seconds(filepath, ffmpeg_path if "ffmpeg_path" in locals() else None)
					if duration <= 0:
						duration = _safe_float(fallback_duration, 3.0)
					print(f"[GJJ] 视频没有音频轨道，已生成 {duration:.3f}s 静音音频: {filename}")
					return _make_silent_audio(duration, 44100)
				raise RuntimeError(f"视频中没有可解析的音频轨道，或 ffmpeg 无法读取音频轨道: {filename}；{detail}") from exc
			soundfile_detail = str(soundfile_error) if soundfile_error is not None else "未尝试"
			raise RuntimeError(f"加载音频/视频文件失败 {filename}: soundfile={soundfile_detail}; ffmpeg={detail}") from exc
		finally:
			if tmp_path:
				try:
					os.unlink(tmp_path)
				except OSError:
					pass


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AudioSegmentEditor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
