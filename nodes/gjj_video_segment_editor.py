"""
GJJ · ✂️ 可视化视频分段编辑器
支持加载视频、自动生成分段、可视化编辑起止时间、按时间段裁剪并输出多个视频片段
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Tuple

import folder_paths
import numpy as np
import torch


NODE_NAME = "GJJ_VideoSegmentEditor"
MAX_SEGMENTS = 99  # 最大分段数量
MIN_OUTPUTS = 1  # 最小输出数量


def is_video_object(value: Any) -> bool:
	"""检测是否为ComfyUI视频对象"""
	if value is None:
		return False
	# 检查是否有get_components方法（ComfyUI VIDEO对象的特征）
	return hasattr(value, "get_components") or (isinstance(value, dict) and "images" in value)


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


def video_to_frames_data(video: dict[str, Any]) -> tuple[np.ndarray, float, int, int]:
	"""将ComfyUI视频对象转换为帧数组、帧率、宽度和高度"""
	if hasattr(video, "get_components"):
		components = video.get_components()
		images = getattr(components, "images", None)
		frame_rate = float(getattr(components, "frame_rate", 24.0) or 24.0)

		if images is not None and isinstance(images, torch.Tensor):
			frames_np = images.detach().cpu().numpy()
			if frames_np.ndim == 4:
				if frames_np.shape[0] == 0:
					raise RuntimeError("视频对象包含0帧数据")
				height, width = frames_np.shape[1], frames_np.shape[2]
				return frames_np, frame_rate, width, height

	# 如果是字典格式
	if isinstance(video, dict) and "images" in video:
		images = video["images"]
		frame_rate = float(video.get("frame_rate", 24.0))

		if isinstance(images, torch.Tensor):
			frames_np = images.detach().cpu().numpy()
			if frames_np.ndim == 4:
				if frames_np.shape[0] == 0:
					raise RuntimeError("视频对象包含0帧数据")
				height, width = frames_np.shape[1], frames_np.shape[2]
				return frames_np, frame_rate, width, height

	raise RuntimeError("无法从视频对象中提取帧数据")


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
	start_time: float,
	end_time: float,
	output_path: str
) -> bool:
	"""使用FFmpeg裁剪视频片段"""
	try:
		duration = end_time - start_time

		cmd = [
			"ffmpeg", "-y", "-v", "error",
			"-ss", str(start_time),
			"-t", str(duration),
			"-i", video_path,
			"-c:v", "libx264",
			"-pix_fmt", "yuv420p",
			"-c:a", "aac",
			output_path,
		]

		result = subprocess.run(cmd, capture_output=True, text=True)
		return result.returncode == 0
	except Exception as e:
		print(f"[GJJ] FFmpeg裁剪失败: {e}")
		return False


def load_video_from_path(filepath: str):
	"""从绝对路径加载视频文件，返回标准VIDEO对象"""
	if not os.path.exists(filepath):
		raise RuntimeError(f"找不到视频文件: {filepath}")
	video_data = _decode_video_with_ffmpeg(filepath)
	return create_video_object(video_data["images"], video_data["frame_rate"])


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
			return create_video_object(video_data["images"], video_data["frame_rate"])

		# 尝试在子文件夹中查找
		for root, dirs, files in os.walk(search_dir):
			for f in files:
				if f == basename:
					filepath = os.path.join(root, f)
					video_data = _decode_video_with_ffmpeg(filepath)
					return create_video_object(video_data["images"], video_data["frame_rate"])

	raise RuntimeError(f"找不到视频文件: {filename} (已搜索目录: {search_dirs})")


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
	"""快速获取视频元数据（时长、帧率、分辨率），不解码帧"""
	try:
		cmd = [
			"ffprobe", "-v", "error",
			"-select_streams", "v:0",
			"-show_entries", "stream=r_frame_rate,width,height",
			"-show_entries", "format=duration",
			"-of", "json",
			video_path,
		]
		result = subprocess.run(cmd, capture_output=True, text=True)
		if result.returncode == 0:
			import json as json_module
			data = json_module.loads(result.stdout)

			stream = data.get("streams", [{}])[0]
			fmt = data.get("format", {})

			# 解析帧率
			fps_str = stream.get("r_frame_rate", "24/1")
			if "/" in fps_str:
				num, den = fps_str.split("/")
				fps = float(num) / float(den) if float(den) != 0 else 24.0
			else:
				fps = float(fps_str) if fps_str else 24.0

			# 获取其他信息
			duration = float(fmt.get("duration", 0))
			width = int(stream.get("width", 0))
			height = int(stream.get("height", 0))

			return {
				"duration": duration,
				"fps": fps,
				"width": width,
				"height": height,
			}
	except Exception as e:
		print(f"[GJJ] 获取视频元数据失败: {e}")

	# 回退方案
	return {
		"duration": 0,
		"fps": 24.0,
		"width": 0,
		"height": 0,
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


def extract_segment_frame(video_path: str, timestamp: float) -> np.ndarray | None:
	"""在指定时间点提取单帧用于分段预览"""
	try:
		import tempfile
		from pathlib import Path
		from PIL import Image

		with tempfile.TemporaryDirectory() as tmpdir:
			tmpdir_path = Path(tmpdir)
			frame_file = tmpdir_path / f"segment_frame_{int(timestamp * 1000)}.png"

			# 使用 ffmpeg 在指定时间点提取一帧
			cmd = [
				"ffmpeg", "-y", "-v", "error",
				"-ss", str(timestamp),  # 跳转到指定时间
				"-i", video_path,
				"-frames:v", "1",
				"-q:v", "2",  # 高质量
				str(frame_file),
			]

			result = subprocess.run(cmd, capture_output=True, text=True)
			if result.returncode == 0 and frame_file.exists():
				with Image.open(frame_file) as img:
					img_array = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
					return img_array

	except Exception as e:
		print(f"[GJJ] 提取分段帧失败 (timestamp={timestamp}): {e}")

	return None


def generate_auto_segments(duration: float, segment_count: int = 4) -> list[dict[str, Any]]:
	"""根据视频时长自动生成等分的时间段"""
	if duration <= 0:
		return []

	segment_duration = duration / segment_count
	segments = []

	for i in range(segment_count):
		start = i * segment_duration
		end = (i + 1) * segment_duration
		segments.append({
			"start": round(start, 3),
			"end": round(end, 3),
			"label": f"片段 {i + 1}",
		})

	return segments


def create_video_object(frames: torch.Tensor, fps: float):
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
				audio=None,
				frame_rate=Fraction(str(float(fps))).limit_denominator(1000),
			)
		)
	except Exception as e:
		# 回退方案：使用内置的 CreateVideo
		try:
			from .common_utils.video_tools import CreateVideo
			return CreateVideo.execute(frames.contiguous(), float(fps), None)[0]
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
	DESCRIPTION = """视频分段编辑器：加载视频后自动生成分段，可视化编辑起止时间，按时间段裁剪并输出多个视频片段。

【核心功能】
• 节点内加载视频 - 支持从下拉列表选择视频文件
• 自动生成分段 - 根据视频时长自动创建等分时间段
• 可视化编辑 - Canvas帧预览显示，拖拽调整起止时间标记
• 动态输出 - 根据分段数量自动扩展输出接口
• 批量裁剪 - 一次性输出所有分段的视频片段

【时间戳格式】
支持 start（开始时间）和 end（结束时间）：
[
  {"start": 0.0, "end": 2.5, "label": "片段 1"},
  {"start": 2.5, "end": 5.0, "label": "片段 2"}
]

【交互操作】
• 左键拖拽蓝色标记 - 调整开始时间
• 左键拖拽红色标记 - 调整结束时间
• 滚轮缩放 - 查看帧细节
• 右键菜单 - 添加/删除/自动生成分段

【输出说明】
• 视频片段1...N - 按时间段裁剪的视频
• 分段列表JSON - 编辑后的时间段配置"""

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
				"description": "根据视频时长自动创建等分时间段",
				"default_segments": 4,
				"customizable": True,
			},
			{
				"name": "可视化编辑",
				"description": "Canvas帧预览显示，拖拽调整起止时间",
				"precision": "millisecond",
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
			"视频片段1...N": {
				"type": "VIDEO",
				"description": "动态输出，数量等于分段数量",
			},
			"分段列表": {
				"type": "STRING",
				"description": "编辑后的时间段JSON配置",
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
				"description": "按知识点时间戳分离教学内容",
				"workflow": "[Tutorial Video] → [GJJ Video Segment Editor]",
			},
		],

		"technical_notes": [
			"视频裁剪使用FFmpeg进行快速分割，保持原始编码",
			"动态输出接口通过IS_CHANGED机制实现，前端根据分段数量动态调整",
			"时间段精度为毫秒级（小数点后3位）",
			"输出顺序与分段列表顺序一致",
			"需要安装FFmpeg才能正常工作",
		],

		"troubleshooting": [
			{
				"problem": "输出接口数量不对",
				"solution": "检查分段列表JSON，确保包含有效的start和end字段",
			},
			{
				"problem": "视频片段时长不正确",
				"solution": "检查起止时间是否重叠或超出视频总时长",
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
					"✨ 支持起止时间标记",
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
	OUTPUT_TOOLTIPS = ("编辑后的时间段JSON配置",) + tuple(f"第{i}个时间段的视频片段" for i in range(1, MAX_SEGMENTS + 1))

	@classmethod
	def INPUT_TYPES(cls):
		# 获取视频文件列表
		video_files = cls._get_video_files()

		return {
			"required": {
				"video_file": (video_files, {
					"display_name": "视频文件",
					"tooltip": "节点内视频文件选择器",
				}),
			},
			"optional": {
				"video": ("VIDEO", {
					"display_name": "外部视频",
					"tooltip": "可选：外部连接的视频对象（优先级高于内部加载）",
				}),
				"segments_json": ("STRING", {
					"default": "[]",
					"multiline": True,
					"display_name": "分段列表JSON",
					"tooltip": "时间段列表，格式：[{\"start\": 0.0, \"end\": 2.5, \"label\": \"片段1\"}, ...]",
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
		video_file: str = "[不加载]",
		video = None,
		segments_json: str = "[]",
		prompt=None,
		extra_pnginfo=None,
		unique_id=None,
	):
		# 1. 加载视频（优先使用外部连接，其次使用内部加载）
		video_path = None
		current_video = None
		frames = None
		frame_rate = 24.0
		width = 0
		height = 0
		total_frames = 0
		duration = 0

		if video is not None and is_video_object(video):
			# 外部连接的视频对象
			current_video = video
			frames, frame_rate, width, height = video_to_frames_data(current_video)
			total_frames = len(frames)
			duration = total_frames / frame_rate if frame_rate > 0 else 0
		elif video_file != "[不加载]":
			# 从文件加载 - 先快速获取元数据
			search_dirs = [
				folder_paths.get_input_directory(),
				folder_paths.get_output_directory(),
			]
			for search_dir in search_dirs:
				if not search_dir or not os.path.exists(search_dir):
					continue
				filepath = os.path.join(search_dir, video_file)
				if os.path.exists(filepath):
					video_path = filepath
					break

			if video_path:
				# 快速获取视频元数据（毫秒级，不解码帧）
				metadata = get_video_metadata(video_path)
				duration = metadata["duration"]
				frame_rate = metadata["fps"]
				width = metadata["width"]
				height = metadata["height"]
				total_frames = int(duration * frame_rate) if duration > 0 and frame_rate > 0 else 0

				print(f"[GJJ] 视频分段编辑器 - 快速加载元数据: {duration:.2f}秒, {frame_rate}fps, {width}x{height}")

				# 快速提取首帧用于预览（不加载全部帧）
				first_frame = extract_first_frame(video_path)
				if first_frame is not None:
					frames = np.array([first_frame])  # 包装成 [1, H, W, 3] 格式
					print(f"[GJJ] 视频分段编辑器 - 成功提取首帧用于预览")
		else:
			raise RuntimeError("请连接外部视频或在节点内选择视频文件")

		# 3. 解析或生成分段列表（默认4段）
		segments = parse_segments_list(segments_json)
		if not segments:
			# 自动生成分段
			segments = generate_auto_segments(duration, 4)

		# 4. 构建预览数据 - 优先使用原始视频文件（快速）
		preview_video_data = []
		if video_path:
			# 直接使用原始视频文件作为预览（毫秒级，无需解码）
			preview_video_data = [{
				"filename": os.path.basename(video_path),
				"subfolder": os.path.relpath(os.path.dirname(video_path), folder_paths.get_input_directory()) if video_path.startswith(folder_paths.get_input_directory()) else "",
				"type": "input",
			}]
			print(f"[GJJ] 视频分段编辑器 - 使用原始视频文件作为预览: {preview_video_data[0]['filename']}")
		elif frames is not None:
			# 如果没有原始文件路径但有帧数据，保存首帧用于预览
			try:
				filepath, filename = save_frames_for_preview(frames, prompt)
				self.preview_video_path = filepath
				preview_video_data = [{
					"filename": filename,
					"subfolder": "",
					"type": "temp",
				}]
				print(f"[GJJ] 视频分段编辑器 - 使用首帧图片作为预览: {filename}")
			except Exception as e:
				print(f"[GJJ] 视频分段编辑器 - 保存预览文件失败: {e}")

		# 5. 构建UI数据（遵循ComfyUI规范：所有值必须用元组包裹）
		# 为每个分段提取中段帧作为缩略图
		segment_thumbnails = []
		if video_path and segments:
			print(f"[GJJ] 视频分段编辑器 - 开始提取分段缩略图，共 {len(segments)} 个分段")
			for i, segment in enumerate(segments):
				try:
					start = float(segment.get("start", 0))
					end = float(segment.get("end", duration))
					mid_time = (start + end) / 2.0  # 分段中点时间

					# 提取中段帧
					frame = extract_segment_frame(video_path, mid_time)
					if frame is not None:
						# 保存帧为临时文件
						from PIL import Image
						output_dir = folder_paths.get_temp_directory()
						filename = f"segment_{i}_{int(mid_time * 1000)}.png"
						filepath = os.path.join(output_dir, filename)

						os.makedirs(output_dir, exist_ok=True)

						# 转换为 PIL Image 并保存
						img = Image.fromarray((frame * 255).astype(np.uint8))
						img.save(filepath)

						segment_thumbnails.append({
							"filename": filename,
							"subfolder": "",
							"type": "temp",
						})
						print(f"[GJJ] 分段{i+1} 缩略图已生成: {filename} (时间点: {mid_time:.2f}s)")
					else:
						print(f"[GJJ] 分段{i+1} 缩略图提取失败 (时间点: {mid_time:.2f}s)")
				except Exception as e:
					print(f"[GJJ] 分段{i+1} 缩略图生成异常: {e}")

		ui: dict[str, Any] = {
			"preview_text": (f"视频时长: {duration:.2f}秒 | 帧数: {total_frames} | 帧率: {frame_rate}Hz | 分辨率: {width}x{height} | 分段数量: {len(segments)}",),
			"preview_kind": ("video_segment_editor",),
			"preview_video": (preview_video_data,) if preview_video_data else (),
			"preview_segments": (format_segments_list(segments),),  # 字符串必须用元组包裹
			"preview_duration": (duration,),  # 数值必须用元组包裹
			"preview_frame_rate": (frame_rate,),  # 数值必须用元组包裹
			"preview_total_frames": (total_frames,),  # 数值必须用元组包裹
			"preview_segment_count": (len(segments),),  # 数值必须用元组包裹
			"segment_thumbnails": (json.dumps(segment_thumbnails),),  # 分段缩略图
		}

		print(f"[GJJ] 视频分段编辑器 - 视频时长: {duration:.2f}秒, 总帧数: {total_frames}, 分段数量: {len(segments)}")
		print(f"[GJJ] 视频分段编辑器 - preview_video_data: {preview_video_data}")
		print(f"[GJJ] 视频分段编辑器 - video_path: {video_path}, frames_loaded: {frames is not None}")

		# 7. 按时间段裁剪视频
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
				start = float(segment.get("start", 0))
				end = float(segment.get("end", duration))

				# 确保时间范围有效
				if start >= end:
					print(f"[GJJ] 警告：分段{i+1}的时间范围无效 ({start}s - {end}s)，跳过")
					continue

				try:
					if video_path:
						# 如果有原始文件路径，使用FFmpeg裁剪
						segment_video = self._crop_video_with_ffmpeg(video_path, start, end, frame_rate)
					else:
						# 否则从帧数组中裁剪
						segment_video = self._crop_video_from_frames(frames, start, end, frame_rate)

					video_segments.append(segment_video)
					print(f"[GJJ] 成功裁剪分段{i+1}: {start}s - {end}s")
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

	def _crop_video_with_ffmpeg(self, video_path: str, start: float, end: float, fps: float) -> dict[str, Any]:
		"""使用FFmpeg裁剪视频并重新加载为VIDEO对象"""
		tmpdir = tempfile.TemporaryDirectory()
		try:
			output_path = os.path.join(tmpdir.name, "segment.mp4")

			if not crop_video_segment_ffmpeg(video_path, start, end, output_path):
				raise RuntimeError("FFmpeg裁剪失败")

			# 检查输出文件是否存在且有内容
			if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
				raise RuntimeError("FFmpeg裁剪后文件为空")

			# 使用load_video_from_path加载临时文件
			return load_video_from_path(output_path)
		finally:
			tmpdir.cleanup()

	def _crop_video_from_frames(self, frames: np.ndarray, start: float, end: float, fps: float) -> dict[str, Any]:
		"""从帧数组中裁剪视频片段"""
		total_frames = len(frames)
		if total_frames == 0:
			raise RuntimeError("无法从空帧数组裁剪视频片段")

		start_frame = int(start * fps)
		end_frame = int(end * fps)

		# 边界检查
		start_frame = max(0, min(start_frame, total_frames - 1))
		end_frame = max(start_frame + 1, min(end_frame, total_frames))

		# 裁剪帧
		cropped_frames = frames[start_frame:end_frame]

		if len(cropped_frames) == 0:
			raise RuntimeError(f"裁剪后帧数为0 (start_frame={start_frame}, end_frame={end_frame}, total={total_frames})")

		# 转换为tensor
		frames_tensor = torch.from_numpy(cropped_frames).float()

		return create_video_object(frames_tensor, fps)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoSegmentEditor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ✂️ 可视化视频分段编辑器"}
