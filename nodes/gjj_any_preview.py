from __future__ import annotations

import json
import os
from typing import Any

import comfy.utils
import folder_paths
import torch
from nodes import PreviewImage

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE
from .gjj_multi_image_loader import build_uniform_batch_by_longest_edge

NODE_NAME = "GJJ_AnyPreview"

class AnyType(str):
	"""始终可兼容任意类型的占位类型。"""

	def __ne__(self, __value: object) -> bool:
		return False


class FlexibleOptionalInputType(dict):
	"""允许节点接收动态数量与动态类型的可选输入。"""

	def __init__(self, input_type, data: dict[str, Any] | None = None):
		super().__init__()
		self.input_type = input_type
		self.data = data or {}
		for key, value in self.data.items():
			self[key] = value

	def __getitem__(self, key):
		if key in self.data:
			return self.data[key]
		return (self.input_type,)

	def __contains__(self, key):
		return True


any_type = AnyType("*")


def extract_input_index(name: str) -> int:
	text = str(name or "")
	if not text.startswith("any_"):
		return 999999
	try:
		return int(text[4:])
	except Exception:
		return 999999


def is_none(value: Any) -> bool:
	if value is None:
		return True
	if isinstance(value, dict) and "model" in value and "clip" in value:
		return not value or all(v is None for v in value.values())
	return False


def is_image_tensor(value: Any) -> bool:
	if not isinstance(value, torch.Tensor):
		return False
	shape = tuple(value.shape)
	if len(shape) == 4 and shape[-1] in (1, 3, 4):
		return True
	if len(shape) == 3 and shape[-1] in (1, 3, 4):
		return True
	return False


def normalize_image_tensor(value: torch.Tensor) -> torch.Tensor:
	if value.ndim == 3:
		return value.unsqueeze(0)
	return value


def resize_image_batch(images: torch.Tensor, width: int, height: int) -> torch.Tensor:
	samples = images.movedim(-1, 1)
	resized = comfy.utils.common_upscale(
		samples, int(width), int(height), "lanczos", "disabled"
	)
	return resized.movedim(1, -1)


def merge_images(values: list[torch.Tensor]) -> torch.Tensor:
	batches = [normalize_image_tensor(value) for value in values]
	# 使用长边缩放统一尺寸，而不是最大尺寸缩放
	# 这样可以避免小图被放大产生黑边
	return build_uniform_batch_by_longest_edge(batches, method="lanczos")


def serialize_preview(value: Any) -> str:
	if isinstance(value, str):
		return value
	if isinstance(value, (int, float, bool)):
		return str(value)
	if value is None:
		return "None"
	if isinstance(value, torch.Tensor):
		return f"Tensor(shape={tuple(value.shape)}, dtype={value.dtype})"
	try:
		return json.dumps(value, indent=2, ensure_ascii=False)
	except Exception:
		try:
			return str(value)
		except Exception:
			return "对象存在，但无法序列化为可预览文本。"


def is_audio_object(value: Any) -> bool:
	"""检测是否为ComfyUI音频对象"""
	if not isinstance(value, dict):
		return False
	return "waveform" in value and "sample_rate" in value


def is_video_object(value: Any) -> bool:
	"""检测是否为ComfyUI视频对象"""
	if value is None:
		return False
	# 检查是否有get_components方法（ComfyUI VIDEO对象的特征）
	return hasattr(value, "get_components") or (isinstance(value, dict) and "images" in value)


def serialize_audio_preview(value: dict[str, Any]) -> str:
	"""序列化音频对象为预览文本"""
	try:
		waveform = value.get("waveform")
		sample_rate = value.get("sample_rate", 0)
		if isinstance(waveform, torch.Tensor):
			duration = float(waveform.shape[-1]) / float(sample_rate) if sample_rate > 0 else 0
			return f"音频(时长: {duration:.2f}秒, 采样率: {sample_rate}Hz, 形状: {tuple(waveform.shape)})"
		return f"音频(采样率: {sample_rate}Hz)"
	except Exception:
		return "音频对象"


def serialize_video_preview(value: Any) -> str:
	"""序列化视频对象为预览文本"""
	try:
		components = value.get_components() if hasattr(value, "get_components") else None
		if components is None:
			return "视频对象"
		images = getattr(components, "images", None)
		frame_rate = getattr(components, "frame_rate", 0)
		if images is not None and isinstance(images, torch.Tensor):
			frame_count = int(images.shape[0])
			duration = frame_count / float(frame_rate) if frame_rate > 0 else 0
			return f"视频(时长: {duration:.2f}秒, 帧数: {frame_count}, 帧率: {frame_rate}, 形状: {tuple(images.shape)})"
		return "视频对象"
	except Exception:
		return "视频对象"


def merge_values(values: list[Any]) -> tuple[str, Any, str]:
	if not values:
		return "other", None, "无可预览内容"

	if all(is_image_tensor(value) for value in values):
		merged = merge_images(
			[value for value in values if isinstance(value, torch.Tensor)]
		)
		preview_text = f"已合并 {int(merged.shape[0])} 张图片，尺寸 {int(merged.shape[2])} x {int(merged.shape[1])}"
		return "image", merged, preview_text

	if all(isinstance(value, str) for value in values):
		merged = "\n".join(str(value) for value in values if str(value) != "")
		return "text", merged, merged or "空文本"

	# 新增：音频检测
	if len(values) == 1 and is_audio_object(values[0]):
		value = values[0]
		preview_text = serialize_audio_preview(value)
		return "audio", value, preview_text

	# 新增：视频检测
	if len(values) == 1 and is_video_object(values[0]):
		value = values[0]
		preview_text = serialize_video_preview(value)
		return "video", value, preview_text

	if len(values) == 1:
		value = values[0]
		if isinstance(value, str):
			return "text", value, value
		return "other", value, serialize_preview(value)

	merged = values
	return "other", merged, serialize_preview(merged)


class GJJ_AnyPreview:
	CATEGORY = "GJJ"
	FUNCTION = "preview"
	OUTPUT_NODE = True
	DESCRIPTION = """动态接收任意类型输入的统一预览节点。

【核心功能】
• 图片预览：自动合并多张图片为批次，显示缩略图网格
• 文本预览：支持 Markdown 格式渲染，显示格式化文本
• 音频预览：内置播放器，支持 WAV/MP3 格式，显示波形控制条
• 视频预览：内置播放器，支持 MP4/H.264 格式，显示播放控件
• 对象预览：其他类型自动序列化为可读文本

【使用场景】
• 作为工作流最终输出的默认预览节点
• 调试时查看中间结果（图片、文本、音频、视频）
• 批量图片的可视化检查
• 音频/视频生成结果的即时预览

【交互功能】
• 图片：悬停查看详情，点击放大，滚轮缩放网格
• 音频：播放/暂停，进度拖拽，音量调节
• 视频：播放/暂停，进度拖拽，全屏切换
• 文本：自动换行，代码高亮，滚动查看

【注意事项】
• 音频/视频首次加载可能需要几秒生成预览文件
• 大尺寸图片会自动缩略显示以保持性能
• 建议配合 GJJ 批量图片节点使用以获得最佳体验"""
	
	# 依赖声明
	REQUIRED_PACKAGES = [
		"soundfile>=0.12.0",  # 音频文件读写
		"numpy>=1.20.0",      # 数组处理
	]
	
	# 使用的模型（本节点无需外部模型）
	REQUIRED_MODELS = []
	
	# 帮助文档
	GJJ_HELP = {
		"title": "GJJ · 👀 任意对象预览器",
		"version": "2.0.0",
		"author": "GJJ Custom Nodes Team",
		"description": "万能预览节点，支持图片、文本、音频、视频等多种数据类型的可视化",
		
		"features": [
			{
				"name": "图片预览",
				"description": "自动合并并显示图片批次，支持缩略图网格、悬停详情、点击放大",
				"supported_formats": ["PNG", "JPEG", "WEBP"],
				"max_batch_size": 100,
			},
			{
				"name": "文本预览",
				"description": "支持 Markdown 渲染、代码高亮、自动换行",
				"supported_formats": ["plain text", "markdown"],
				"max_length": 10000,
			},
			{
				"name": "音频预览",
				"description": "内置播放器，支持播放控制、进度拖拽、波形显示",
				"supported_formats": ["WAV", "MP3"],
				"sample_rates": [16000, 22050, 44100, 48000],
			},
			{
				"name": "视频预览",
				"description": "内置播放器，支持播放控制、进度拖拽、全屏模式",
				"supported_formats": ["MP4/H.264"],
				"max_resolution": "1920x1080",
			},
		],
		
		"inputs": {
			"batch_image": {
				"type": "GJJ_BATCH_IMAGE,IMAGE",
				"required": False,
				"description": "GJJ 专用批量图片接口，优先作为图片批次预览（兼容标准 IMAGE）",
			},
			"any_XX": {
				"type": "*",
				"required": False,
				"description": "动态插槽，可连接任意类型数据（自动编号 XX）",
			},
		},
		
		"outputs": {
			"统一预览结果": {
				"type": "*",
				"description": "合并后的结果；图片输出 IMAGE 批次，文本输出 STRING，其他输出原对象",
			},
		},
		
		"usage_examples": [
			{
				"title": "基础图片预览",
				"description": "连接单张或多张图片进行预览",
				"workflow": "[Load Image] → [GJJ Any Preview]",
			},
			{
				"title": "批量图片检查",
				"description": "使用 GJJ 批量图片节点进行批次预览",
				"workflow": "[GJJ Batch Image] → [GJJ Any Preview]",
			},
			{
				"title": "音频生成预览",
				"description": "预览 TTS 或音乐生成结果",
				"workflow": "[TTS Node] → [GJJ Any Preview]",
			},
			{
				"title": "视频合成预览",
				"description": "预览视频生成或合成结果",
				"workflow": "[Video Combine] → [GJJ Any Preview]",
			},
			{
				"title": "调试信息查看",
				"description": "查看任意对象的序列化文本表示",
				"workflow": "[Any Node Output] → [GJJ Any Preview]",
			},
		],
		
		"technical_notes": [
			"音频/视频预览会在首次执行时生成临时文件（位于 ComfyUI temp 目录）",
			"图片预览使用 ComfyUI 原生 PreviewImage 节点的能力",
			"文本预览支持基本的 Markdown 语法（标题、列表、代码块等）",
			"动态插槽数量根据连接情况自动调整，最多支持 99 个输入",
			"所有预览数据通过 ui 字典返回，遵循 ComfyUI 规范",
		],
		
		"troubleshooting": [
			{
				"problem": "音频/视频不显示播放器",
				"solution": "检查浏览器控制台是否有错误，确认文件格式正确，尝试刷新页面",
			},
			{
				"problem": "图片显示模糊",
				"solution": "这是缩略图效果，点击图片可全屏查看原始分辨率",
			},
			{
				"problem": "文本显示不完整",
				"solution": "向下滚动预览区域，或调整节点高度以显示更多内容",
			},
			{
				"problem": "预览数据为空",
				"solution": "确认已连接有效输入，检查后端日志是否有错误信息",
			},
		],
		
		"changelog": [
			{
				"version": "2.0.0",
				"date": "2026-05-04",
				"changes": [
					"✨ 新增音频预览功能（WAV/MP3 支持）",
					"✨ 新增视频预览功能（MP4/H.264 支持）",
					"🐛 修复 UI 数据格式问题（元组包裹规范）",
					"🔧 优化前端 onExecuted 数据解析逻辑",
				],
			},
			{
				"version": "1.0.0",
				"date": "2026-04-01",
				"changes": [
					"🎉 初始版本发布",
					"✨ 支持图片和文本预览",
					"✨ 动态插槽系统",
				],
			},
		],
	}
	
	SEARCH_ALIASES = [
		"any preview",
		"preview any",
		"inspect any",
		"任意预览",
		"对象预览",
		"调试预览",
		"最终生成图像",
		"扩图结果图像",
		"结果图像",
		"最终预览",
		"任意对象预览器",
		"audio preview",
		"video preview",
		"媒体预览",
	]
	RETURN_TYPES = (any_type,)
	RETURN_NAMES = ("统一预览结果",)
	OUTPUT_TOOLTIPS = (
		"合并后的结果；图片输出为 IMAGE 批次，文本输出为 STRING，其它对象输出为任意对象。",
	)

	@classmethod
	def INPUT_TYPES(cls):
		return {
			"required": {},
			"optional": FlexibleOptionalInputType(
				any_type,
				{
					"batch_image": (
						GJJ_BATCH_IMAGE_TYPE,
						{
							"display_name": "GJJ 批量图片",
							"tooltip": "第一行固定接口。接入 GJJ 专用批量图片后会优先作为图片批次预览和输出。",
						},
					),
				},
			),
			"hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
		}

	def __init__(self):
		self.preview_image = PreviewImage()

	def preview(self, prompt=None, extra_pnginfo=None, **kwargs):
		values = []
		batch_image = kwargs.get("batch_image")
		if not is_none(batch_image):
			values.append(batch_image)
		for key in sorted(kwargs.keys(), key=extract_input_index):
			if not key.startswith("any_"):
				continue
			value = kwargs.get(key)
			if is_none(value):
				continue
			values.append(value)

		preview_kind, merged, preview_text = merge_values(values)
		ui: dict[str, Any] = {
			"preview_text": (preview_text,),
			"preview_kind": (preview_kind,),
			"preview_item_count": (len(values),),
		}
		
		# 添加调试日志
		print(f"[GJJ] 开始构建ui数据 - preview_kind: {preview_kind}")

		if preview_kind == "image" and isinstance(merged, torch.Tensor):
			image_ui = self.preview_image.save_images(
				merged,
				filename_prefix="GJJ_AnyPreview",
				prompt=prompt,
				extra_pnginfo=extra_pnginfo,
			)
			ui["preview_images"] = image_ui.get("ui", {}).get("images", [])
			print(f"[GJJ] 图片ui数据: {ui['preview_images']}")

		# 新增：音频预览
		elif preview_kind == "audio" and is_audio_object(merged):
			try:
				import numpy as np
				import soundfile as sf
				
				# 获取音频数据
				waveform = merged.get("waveform")
				sample_rate = merged.get("sample_rate", 44100)
				
				print(f"[GJJ] 音频预览开始 - waveform类型: {type(waveform)}, sample_rate: {sample_rate}")
				
				if isinstance(waveform, torch.Tensor):
					# 转换为numpy数组
					audio_np = waveform.squeeze(0).cpu().numpy()
					# 如果是多声道，转置为[样本数, 通道数]
					if audio_np.ndim == 2:
						audio_np = audio_np.T
					
					# 保存到临时文件
					output_dir = folder_paths.get_temp_directory()
					filename = f"GJJ_AnyPreview_{hash(str(prompt))}.wav"
					filepath = os.path.join(output_dir, filename)
					
					# 确保目录存在
					os.makedirs(output_dir, exist_ok=True)
					
					# 保存WAV文件
					sf.write(filepath, audio_np, sample_rate)
					
					print(f"[GJJ] 音频文件已保存: {filepath}")
					
					# 构建预览数据
					preview_audio_data = [{
						"filename": filename,
						"subfolder": "",
						"type": "temp",
					}]
					ui["preview_audio"] = (preview_audio_data,)
					print(f"[GJJ] 音频预览数据: {preview_audio_data}")
			except Exception as e:
				print(f"[GJJ] 音频预览失败: {e}")
				import traceback
				traceback.print_exc()
				pass

		# 新增：视频预览
		elif preview_kind == "video" and is_video_object(merged):
			try:
				from .gjj_video_combine_runtime import combine_video
				
				# 获取视频组件
				components = merged.get_components()
				images = getattr(components, "images", None)
				audio = getattr(components, "audio", None)
				frame_rate = float(getattr(components, "frame_rate", 24.0) or 24.0)
				if images is not None and isinstance(images, torch.Tensor):
					# 使用combine_video函数生成视频预览
					video_result = combine_video(
						images=images,
						audio=audio,
						frame_rate=frame_rate,
						loop_count=0,
						filename_prefix="GJJ_AnyPreview",
						format_name="video/h264-mp4",
						pingpong=False,
						save_output=False,
						use_source_fps=False,
						vae=None,
						format_overrides_json="",
						prompt=prompt,
						extra_pnginfo=extra_pnginfo,
						unique_id=None,
					)
					
					# 提取预览媒体数据
					if isinstance(video_result, dict):
						video_ui = video_result.get("ui", {})
						preview_media = video_ui.get("preview_media") or video_ui.get("images") or []
						if preview_media:
							ui["preview_video"] = (preview_media,)
							print(f"[GJJ] 视频预览数据: {preview_media}")
			except Exception as e:
				print(f"[GJJ] 视频预览失败: {e}")
				import traceback
				traceback.print_exc()
				pass

		# 添加最终调试日志
		print(f"[GJJ] 最终返回的ui数据: {ui}")
		print(f"[GJJ] ui.keys: {list(ui.keys())}")
		
		# 确保返回的是原始输入值，而不是内部处理后的 merged 对象
		# 如果 values 只有一个元素，返回该元素；否则返回合并后的结果
		result_output = values[0] if len(values) == 1 else merged
		
		return {
			"ui": ui,
			"result": (result_output,),
		}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AnyPreview}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: " GJJ·👀 任意对象预览器"}
