"""
GJJ · ✂️ 音频分段编辑器
支持加载音频、自动生成分段、可视化编辑起止时间、按时间段裁剪并输出多个音频片段
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Tuple

import folder_paths
import numpy as np
import torch


# 延迟导入：运行时依赖检查
_soundfile = None

def _load_soundfile():
	"""运行时加载 soundfile，失败时提供友好提示"""
	global _soundfile
	if _soundfile is not None:
		return _soundfile

	try:
		import soundfile as sf
		_soundfile = sf
		return sf
	except Exception as exc:
		import sys
		python_executable = sys.executable

		# ANSI 颜色代码（用于控制台彩色输出）
		RED = '\033[91m'
		YELLOW = '\033[93m'
		CYAN = '\033[96m'
		GREEN = '\033[92m'
		RESET = '\033[0m'
		BOLD = '\033[1m'

		# 构建安装命令
		from .common_utils.dependency_checker import get_pip_install_command_text
		install_cmd = get_pip_install_command_text("soundfile numpy")

		# 在控制台打印美观的错误提示
		print(f"\n{RED}{'=' * 80}{RESET}")
		print(f"{RED}{BOLD}  GJJ 节点运行时依赖缺失！{RESET}")
		print(f"{RED}{'=' * 80}{RESET}")
		print(f"{YELLOW}[GJJ] {BOLD}节点:{RESET} {CYAN}音频分段编辑器{RESET}")
		print(f"{YELLOW}[GJJ] {BOLD}缺失依赖:{RESET} {RED}{BOLD}soundfile{RESET}")
		print(f"{YELLOW}[GJJ]{RESET} 该节点需要 soundfile 和 numpy Python 包才能运行。\n")
		print(f"{YELLOW}{BOLD} 快速安装命令:{RESET}")
		print(f"{GREEN}{BOLD}  {install_cmd}{RESET}\n")
		print(f"{YELLOW}{BOLD} 提示:{RESET} 安装后请重启 ComfyUI 服务器")
		print(f"{RED}{'=' * 80}{RESET}\n")

		raise RuntimeError(
			"\n 未找到 soundfile 运行库。\n"
			"\n"
			"这个 GJJ 节点需要 soundfile 和 numpy Python 包才能运行。\n"
			"\n"
			" 必需依赖（请安装）：\n"
			"  • soundfile (音频/视频文件读写库)\n"
			"  • numpy (数值计算库)\n"
			"\n"
			"🔧 快速安装命令（使用实际 Python 路径）：\n"
			f"{install_cmd}\n"
			"\n"
			f"原始导入错误：{exc}\n"
			"\n"
			" 提示：安装后请重启 ComfyUI 服务器。"
		) from exc


NODE_NAME = "GJJ_AudioTimestampEditor"
BACKEND_VERSION = "V16"
MAX_SEGMENTS = 99  # 最大分段数量
MIN_OUTPUTS = 1  # 最小输出数量


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


def audio_to_waveform_data(audio: dict[str, Any]) -> tuple[np.ndarray, int]:
	"""将ComfyUI音频对象转换为numpy波形数据和采样率"""
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


def save_audio_for_preview(audio_np: np.ndarray, sample_rate: int, prompt: Any = None) -> tuple[str, str]:
	"""保存音频到临时文件用于预览"""
	sf = _load_soundfile()

	output_dir = folder_paths.get_temp_directory()
	filename = f"GJJ_AudioSegmentEditor_{hash(str(prompt))}.wav"
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
	DESCRIPTION = """音频分段编辑器：加载音频后自动生成分段，可视化编辑起止时间，按时间段裁剪并输出多个音频片段。

【核心功能】
• 节点内加载音频 - 支持从下拉列表选择音频/视频文件
• 自动生成分段 - 根据音频时长自动创建等分时间段
• 可视化编辑 - Canvas波形显示，拖拽调整起止时间标记
• 动态输出 - 根据分段数量自动扩展输出接口
• 批量裁剪 - 一次性输出所有分段的音频片段

【时间戳格式】
支持 start（开始时间）和 end（结束时间）：
[
  {"start": 0.0, "end": 2.5, "label": "片段 1"},
  {"start": 2.5, "end": 5.0, "label": "片段 2"}
]

【交互操作】
• 左键拖拽蓝色标记 - 调整开始时间
• 左键拖拽红色标记 - 调整结束时间
• 滚轮缩放 - 查看波形细节
• 右键菜单 - 添加/删除/自动生成分段

【输出说明】
• 音频片段1...N - 按时间段裁剪的音频
• 分段列表JSON - 编辑后的时间段配置"""

	# 依赖声明
	REQUIRED_PACKAGES = [
		"soundfile>=0.12.0",
		"numpy>=1.20.0",
	]

	REQUIRED_MODELS = []

	GJJ_HELP = {
		"title": "GJJ · ✂️ 音频分段编辑器",
		"version": "2.1.0",
		"author": "GJJ Custom Nodes Team",
		"description": "可视化音频分段裁剪工具，支持动态输出多个音频片段",

		"features": [
			{
				"name": "节点内音频加载",
				"description": "内置音频/视频文件选择器，无需外部节点连接",
				"supported_formats": ["WAV", "MP3", "FLAC"],
			},
			{
				"name": "自动分段生成",
				"description": "默认创建 1 个按单段时长截取的时间段，也可手动添加多段",
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
				"description": "节点内音频/视频文件选择器；视频会自动只提取音频",
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
		],

		"changelog": [
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
					"tooltip": "节点内音频/视频文件选择器；视频会自动只提取音频",
				}),
			},
			"optional": {
				"audio": ("AUDIO", {
					"display_name": "外部音频",
					"tooltip": "可选：外部连接的音频对象（优先级高于内部加载）",
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
					"display_name": "单段时长",
					"tooltip": "默认只生成 1 段，并按这个时长截取；前端可在波形区拖动位置或拉长拉短。",
				}),
			},
			"hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID"},
		}

	@classmethod
	def _get_audio_files(cls) -> list[str]:
		"""获取可用的音频/视频文件列表"""
		files = ["[不加载]"]

		# 从多个目录查找音频/视频文件
		search_dirs = [
			folder_paths.get_input_directory(),
			folder_paths.get_output_directory(),
		]

		audio_extensions = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".aiff", ".aif", ".opus", ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".wmv", ".mpeg", ".mpg"}

		for search_dir in search_dirs:
			if not search_dir or not os.path.exists(search_dir):
				continue

			for root, dirs, filenames in os.walk(search_dir):
				for filename in filenames:
					if Path(filename).suffix.lower() in audio_extensions:
						files.append(filename)

		return files

	@classmethod
	def IS_CHANGED(cls, audio_file="[不加载]", audio=None, segments_json: str = "[]", segment_duration: float = 3.0, **kwargs):
		# V15：这个节点的分段信息主要由前端 Canvas 写入隐藏 widget / workflow properties。
		# 不同 ComfyUI 版本对隐藏 widget、properties、widgets_values 的缓存策略不一致，
		# 只返回 segments_json 可能会复用旧结果，导致界面高亮已变但输出仍是 0:00 或旧片段。
		# 因此作为 OUTPUT_NODE，每次队列执行都强制重新计算一次，保证输出音频一定来自当前高亮分段。
		import time
		return f"{audio_file}|{segments_json}|{float(segment_duration or 0):.6f}|v12|{time.time_ns()}"

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
			# 1. 加载音频（优先使用外部连接，其次使用内部加载）
			if audio is not None and is_audio_object(audio):
				current_audio = audio
			elif audio_file != "[不加载]":
				# 从文件加载音频
				current_audio = self._load_audio_from_file(audio_file)
			else:
				raise RuntimeError("请连接外部音频或在节点内选择音频/视频文件")

			# 2. 转换音频数据
			audio_np, sample_rate = audio_to_waveform_data(current_audio)
			duration = len(audio_np) / sample_rate if sample_rate > 0 else 0

			# 3. 解析或生成分段列表。优先使用前端拖动后写入 workflow properties 的最新分段，
			#    再使用隐藏 widget 传入的 segments_json，最后才自动生成默认单段。
			property_segments = _segments_from_workflow_properties(extra_pnginfo, unique_id)
			segments = property_segments or parse_segments_list(segments_json)
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

			# 4. 保存音频用于预览
			try:
				filepath, filename = save_audio_for_preview(audio_np, sample_rate, prompt)
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
				"preview_text": (f"后端 {BACKEND_VERSION} | 音频时长: {duration:.2f}秒 | 采样率: {sample_rate}Hz | 分段数量: {len(segments)}",),
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

			return {
				"ui": ui,
				"result": tuple(result_list),
			}
		except Exception as exc:
			_send_status(unique_id, f"执行失败：{exc}", 1.0)

			# 如果原始错误包含详细安装命令（来自 _load_soundfile），则保留它
			if isinstance(exc, RuntimeError) and "未找到 soundfile 运行库" in str(exc):
				# 提取安装命令
				error_str = str(exc)
				install_command = ""
				# 尝试从错误信息中提取安装命令（包含 pip install 的行）
				import re
				match = re.search(r'(.+?python\.exe.*?pip install soundfile.*?)\n', error_str)
				if match:
					install_command = match.group(1).strip()

				# 发送错误事件到前端
				try:
					from server import PromptServer
					PromptServer.instance.send_sync("gjj_audio_timestamp_error", {
						"node": str(unique_id),
						"error": error_str,
						"install_command": install_command,
					})
				except Exception:
					pass

				# 抛出简洁的错误信息（在默认错误区域显示）
				raise RuntimeError("运行时依赖缺失：soundfile。详细信息请查看节点前端面板。") from exc
			else:
				# 其他错误使用标准格式
				raise RuntimeError(
					f"🎤 音频分段编辑器执行失败\n"
					f"参数：audio_file={audio_file}, segment_duration={segment_duration}\n\n"
					f"详细错误：{exc}"
				) from exc

	def _load_audio_from_file(self, filename: str) -> dict[str, Any]:
		"""从音频/视频文件加载音频；视频文件通过 ffmpeg 只提取音频"""
		import subprocess
		import tempfile

		sf = _load_soundfile()

		# 在多个目录中查找文件
		search_dirs = [
			folder_paths.get_input_directory(),
			folder_paths.get_output_directory(),
		]

		for search_dir in search_dirs:
			if not search_dir or not os.path.exists(search_dir):
				continue

			filepath = os.path.join(search_dir, filename)
			if os.path.exists(filepath):
				# 尝试直接加载
				try:
					audio_data, sample_rate = sf.read(filepath)

					# 转换为torch tensor
					if audio_data.ndim == 1:
						audio_data = audio_data.reshape(1, -1)
					elif audio_data.ndim == 2:
						audio_data = audio_data.T

					waveform = torch.from_numpy(audio_data).float().unsqueeze(0)

					return {
						"waveform": waveform,
						"sample_rate": sample_rate,
					}
				except Exception as e:
					# soundfile 不支持时尝试 ffmpeg 解码
					print(f"[GJJ] soundfile 无法直接加载 {filename}，尝试 ffmpeg 提取/解码音频... ({e})")

				# ffmpeg 回退：转换成临时 WAV
				try:
					with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
						tmp_path = tmp.name

					cmd = [
						"ffmpeg", "-y", "-v", "error",
						"-i", filepath,
						"-acodec", "pcm_s16le",
						"-ar", "44100",
						"-ac", "2",
						tmp_path,
					]
					subprocess.run(cmd, capture_output=True, text=True, check=True)

					audio_data, sample_rate = sf.read(tmp_path)

					# 清理临时文件
					try:
						os.unlink(tmp_path)
					except OSError:
						pass

					# 转换为torch tensor
					if audio_data.ndim == 1:
						audio_data = audio_data.reshape(1, -1)
					elif audio_data.ndim == 2:
						audio_data = audio_data.T

					waveform = torch.from_numpy(audio_data).float().unsqueeze(0)

					print(f"[GJJ] ffmpeg 提取音频成功: {filename}")
					return {
						"waveform": waveform,
						"sample_rate": sample_rate,
					}
				except Exception as e2:
					# 清理临时文件
					try:
						os.unlink(tmp_path)
					except (OSError, NameError):
						pass
					raise RuntimeError(f"加载音频/视频文件失败 {filename}: soundfile={e}, ffmpeg={e2}")

		raise RuntimeError(f"找不到音频/视频文件: {filename}")


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AudioSegmentEditor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · ✂️ 可视化音频分段编辑器"}
