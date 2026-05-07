from __future__ import annotations

import os
from typing import Any

import comfy.utils
import torch

# 延迟导入 cosyvoice，避免缺失时导致整个模块无法加载
# from cosyvoice.cli.cosyvoice import AutoModel  # 在 runtime 中导入

from .gjj_cosyvoice3_runtime import (
	DEFAULT_MODEL_NAME,
	audio_file_to_tempfile,
	cleanup_temp_file,
	comfy_audio_to_tempfile,
	ensure_demo_reference,
	local_example_audio_to_tempfile,
	list_cosyvoice_models,
	list_demo_references,
	list_local_example_audios,
	load_cosyvoice_model,
	pick_available_name,
	save_audio_mp3_ui,
	send_audio_preview,
	send_status,
	set_random_seed,
	tensor_to_comfy_audio,
	transcribe_audio,
)

# 检查关键依赖
try:
	from cosyvoice.cli.cosyvoice import AutoModel  # noqa: F401
	_COSYVOICE_AVAILABLE = True
except ImportError:
	_COSYVOICE_AVAILABLE = False


MODE_OPTIONS = ["零样本复刻", "跨语言复刻", "指令风格"]
MP3_QUALITY_OPTIONS = ["320k", "128k", "V0"]
MISSING_EXAMPLE_AUDIO = "[未找到示例音频]"
DEFAULT_REFERENCE_TEXT = "人生不如意十有八九。要么看得开，要么就认栽！"


def _list_example_audio_choices() -> list[str]:
	choices: list[str] = []
	for name in list_local_example_audios() + list_demo_references():
		if name not in choices:
			choices.append(name)
	return choices


def _has_valid_audio_input(audio: Any) -> bool:
	return isinstance(audio, dict) and audio.get("waveform") is not None and audio.get("sample_rate") is not None


class GJJ_CosyVoice3Generator:
	# 如果缺少关键依赖，显示错误信息
	if not _COSYVOICE_AVAILABLE:
		DESCRIPTION = """❌ 节点 CosyVoice3 语音克隆器 缺少必需的 Python 依赖：

📦 必需依赖（请安装）：
  • cosyvoice

🔧 安装命令：
  pip install cosyvoice

💡 提示：安装后请重启 ComfyUI 服务器。

---
CosyVoice3 一体式语音克隆器。内部自动加载本地 models/cosyvoice 模型，支持零样本复刻、跨语言复刻与指令风格控制。

📦 所需模型：
  • 模型目录: models/cosyvoice/
    - Fun-CosyVoice3-0.5B-2512 (默认，约 1GB)
  • 示例音频目录: models/mp3/ (存放参考音频)
  • 官方示例: 首次执行时自动下载到 models/cosyvoice/demo/
  • 自动下载: 开启后首次执行时从 HuggingFace 国内镜像下载（需 huggingface_hub）

🔧 Python 依赖：
  • cosyvoice (必需，CosyVoice3 运行时库)
  • huggingface_hub (可选，用于自动下载模型)
  • soundfile (音频读写)
  • 安装命令: pip install cosyvoice huggingface_hub soundfile

✅ 优点：
  • 支持三种合成模式：零样本复刻、跨语言复刻、指令风格
  • 音质自然，情感表达丰富
  • 支持自动转录参考音频文本（零样本模式下）
  • 内置官方示例音色，方便快速测试
  • 模型较小（0.5B 约 1GB），显存占用低
  • 支持语速调节和风格指令控制

⚠️ 缺点：
  • 仅支持单一说话人克隆（不支持多说话人）
  • 跨语言复刻效果可能不如母语自然
  • 指令风格模式需要手动编写风格描述
  • 依赖 cosyvoice 包，安装可能遇到兼容性问题
  • 不支持动态扩展输入口"""
	else:
		DESCRIPTION = """CosyVoice3 一体式语音克隆器。内部自动加载本地 models/cosyvoice 模型，支持零样本复刻、跨语言复刻与指令风格控制。

📦 所需模型：
  • 模型目录: models/cosyvoice/
    - Fun-CosyVoice3-0.5B-2512 (默认，约 1GB)
  • 示例音频目录: models/mp3/ (存放参考音频)
  • 官方示例: 首次执行时自动下载到 models/cosyvoice/demo/
  • 自动下载: 开启后首次执行时从 HuggingFace 国内镜像下载（需 huggingface_hub）

🔧 Python 依赖：
  • cosyvoice (必需，CosyVoice3 运行时库)
  • huggingface_hub (可选，用于自动下载模型)
  • soundfile (音频读写)
  • 安装命令: pip install cosyvoice huggingface_hub soundfile

✅ 优点：
  • 支持三种合成模式：零样本复刻、跨语言复刻、指令风格
  • 音质自然，情感表达丰富
  • 支持自动转录参考音频文本（零样本模式下）
  • 内置官方示例音色，方便快速测试
  • 模型较小（0.5B 约 1GB），显存占用低
  • 支持语速调节和风格指令控制

⚠️ 缺点：
  • 仅支持单一说话人克隆（不支持多说话人）
  • 跨语言复刻效果可能不如母语自然
  • 指令风格模式需要手动编写风格描述
  • 依赖 cosyvoice 包，安装可能遇到兼容性问题
  • 不支持动态扩展输入口"""

	@classmethod
	def INPUT_TYPES(cls):
		available = list_cosyvoice_models()
		default_model = pick_available_name(DEFAULT_MODEL_NAME, available, DEFAULT_MODEL_NAME)
		example_audios = _list_example_audio_choices()
		return {
			"required": {
				"mode": (MODE_OPTIONS, {
					"default": "零样本复刻",
					"display_name": "合成模式",
					"tooltip": "默认使用示例音频下拉框选择的音色；如果连接了参考音频，就自动优先使用输入音频。跨语言复刻会忽略参考文本；指令风格会额外使用风格指令。",
				}),
				"example_audio_name": (example_audios or [MISSING_EXAMPLE_AUDIO], {
					"default": example_audios[0] if example_audios else MISSING_EXAMPLE_AUDIO,
					"display_name": "示例音频",
					"tooltip": "不连接参考音频时，会直接使用这里选择的示例音频。本地音频读取共享目录 models/mp3；旧 models/cosyvoice/mp3 会自动迁移兼容。官方示例会在执行时自动下载到 models/cosyvoice/demo。",
				}),
				"model_name": (available or [DEFAULT_MODEL_NAME], {
					"default": default_model,
					"display_name": "CosyVoice3 模型",
					"tooltip": "自动搜索 models/cosyvoice 下的本地模型目录，找不到时会用国内镜像下载默认模型。",
				}),
				"text": ("STRING", {
					"default": "你好，这是一段使用 CosyVoice3 生成的语音。",
					"multiline": True,
					"display_name": "要说的话",
					"tooltip": "需要合成的文本内容。",
				}),
				"speed": ("FLOAT", {
					"default": 1.0,
					"min": 0.5,
					"max": 2.0,
					"step": 0.05,
					"display_name": "语速",
					"tooltip": "语音播放速度倍率。",
				}),
				"reference_text": ("STRING", {
					"default": DEFAULT_REFERENCE_TEXT,
					"multiline": False,
					"display_name": "参考文本",
					"tooltip": "参考音频对应的文字。零样本复刻模式下为空时可自动转录；本地示例音色同样支持自动转录。",
				}),
				"instruct_text": ("STRING", {
					"default": "请以自然、清晰、富有感情的语气朗读。",
					"multiline": False,
					"display_name": "风格指令",
					"tooltip": "在\"指令风格\"模式下用来描述语气、情绪和风格；其它模式可留空。",
				}),
				"seed": ("INT", {
					"default": 42,
					"min": -1,
					"max": 2147483647,
					"display_name": "随机种子",
					"tooltip": "随机种子，-1 表示随机。",
				}),
				"mp3_filename_prefix": ("STRING", {
					"default": "audio/GJJ_CosyVoice3",
					"display_name": "MP3文件名前缀",
					"tooltip": "生成后会自动保存 MP3，并在节点中间显示播放器。这里控制输出目录和文件名前缀。",
				}),
				"mp3_quality": (MP3_QUALITY_OPTIONS, {
					"default": "320k",
					"display_name": "MP3质量",
					"tooltip": "内置 MP3 保存质量。320k 体积较大但质量更高；128k 体积更小；V0 是可变码率。",
				}),
			},
			"optional": {
				"reference_audio": ("AUDIO", {
					"display_name": "参考音频（可选）",
					"tooltip": "可不连接。不连接时会直接使用上方示例音频；连接普通音频节点或 ComfyUI 内置录音节点后会优先使用输入音频。",
				}),
			},
			"hidden": {
				"unique_id": "UNIQUE_ID",
				"extra_pnginfo": "EXTRA_PNGINFO",
			},
		}

	RETURN_TYPES = ("AUDIO",)
	RETURN_NAMES = ("语音音频输出",)
	OUTPUT_TOOLTIPS = ("生成好的 ComfyUI 音频对象，可直接接保存音频或播放节点。",)
	FUNCTION = "generate"
	CATEGORY = "GJJ/Audio"
	OUTPUT_NODE = True

	def _validate_audio_duration(self, reference_audio: dict[str, Any]) -> float:
		ref_waveform = reference_audio["waveform"]
		ref_sample_rate = int(reference_audio["sample_rate"])
		return float(ref_waveform.shape[-1]) / float(ref_sample_rate)

	def generate(
		self,
		mode: str,
		model_name: str,
		text: str,
		speed: float = 1.0,
		reference_text: str = DEFAULT_REFERENCE_TEXT,
		example_audio_name: str = "[未找到示例音色]",
		instruct_text: str = "",
		seed: int = 42,
		mp3_filename_prefix: str = "audio/GJJ_CosyVoice3",
		mp3_quality: str = "320k",
		reference_audio: dict[str, Any] | None = None,
		unique_id: Any = None,
		extra_pnginfo: dict[str, Any] | None = None,
	):
		# 从 properties 读取 Boolean 值（通过 extra_pnginfo + unique_id）
		props = {}
		try:
			if extra_pnginfo and isinstance(extra_pnginfo, dict):
				workflow = extra_pnginfo.get("workflow", {})
				if isinstance(workflow, dict):
					nodes = workflow.get("nodes", [])
					if isinstance(nodes, list):
						uid = str(unique_id)
						for n in nodes:
							if isinstance(n, dict) and str(n.get("id")) == uid:
								props = n.get("properties", {}) or {}
								break
		except Exception:
			props = {}

		auto_transcribe = bool(props.get("auto_transcribe", True))
		text_frontend = bool(props.get("text_frontend", True))
		temp_file = None
		use_uploaded_audio = _has_valid_audio_input(reference_audio)
		reference_source = "输入音频" if use_uploaded_audio else "示例音频"
		try:
			if not str(text or "").strip():
				raise RuntimeError("要说的话不能为空。")
			duration = 0.0
			use_prompt_audio = True
			demo_prompt_text = ""
			if use_uploaded_audio:
				duration = self._validate_audio_duration(reference_audio)
				if duration > 30:
					raise RuntimeError(f"参考音频时长 {duration:.1f} 秒，超过 30 秒限制，请先裁剪到 30 秒以内。")
				send_status(unique_id, "正在准备参考音频")
				temp_file, _ = comfy_audio_to_tempfile(reference_audio)
			else:
				example_name = str(example_audio_name or "").strip()
				if not example_name or example_name == MISSING_EXAMPLE_AUDIO:
					raise RuntimeError("未选择可用的示例音频，也没有连接参考音频。")
				if example_name in list_demo_references():
					reference_source = f"官方示例音频：{example_name}"
					send_status(unique_id, f"正在准备官方示例音频：{example_name}")
					demo_info = ensure_demo_reference(example_name, unique_id)
					temp_file, duration = audio_file_to_tempfile(demo_info["path"])
					demo_prompt_text = str(demo_info.get("prompt_text") or "").strip()
				else:
					reference_source = f"本地示例音频：{example_name}"
					send_status(unique_id, f"正在准备本地示例音频：{example_name}")
					temp_file, duration = local_example_audio_to_tempfile(example_name)
				if duration > 30:
					raise RuntimeError(f"示例音频时长 {duration:.1f} 秒，超过 30 秒限制，请先换一段更短的示例音频。")

			send_status(unique_id, "正在加载 CosyVoice3 模型")
			model_info = load_cosyvoice_model(model_name, unique_id)
			cosyvoice_model = model_info["model"]
			sample_rate = int(model_info["sample_rate"])

			set_random_seed(seed)

			pbar = comfy.utils.ProgressBar(4)
			pbar.update_absolute(0, 4)

			prompt_text = str(reference_text or "").strip() or demo_prompt_text
			if use_prompt_audio and mode == "零样本复刻" and not prompt_text:
				if auto_transcribe:
					send_status(unique_id, "正在转录参考音频")
					prompt_text = transcribe_audio(temp_file)
				if not prompt_text:
					send_status(unique_id, "转录失败，改用跨语言复刻逻辑")
					mode = "跨语言复刻"

			pbar.update_absolute(1, 4)
			send_status(unique_id, f"正在执行{mode}")

			if mode == "指令风格":
				if not str(instruct_text or "").strip():
					raise RuntimeError("指令风格模式必须填写风格指令。")
				if not hasattr(cosyvoice_model, "inference_instruct2"):
					raise RuntimeError("当前模型不支持指令风格模式，请更换 CosyVoice2/3 模型。")
				raw_instruct = str(instruct_text).strip()
				end_token = "<|endofprompt|>"
				system_prompt = "You are a helpful assistant."
				if raw_instruct.startswith(system_prompt):
					raw_instruct = raw_instruct[len(system_prompt):].lstrip("\n")
				if raw_instruct.endswith(end_token):
					raw_instruct = raw_instruct[:-len(end_token)].rstrip()
				if model_info.get("is_cosyvoice3", False):
					formatted_instruct = system_prompt + "\n" + raw_instruct + end_token
				else:
					formatted_instruct = raw_instruct + end_token
				output = cosyvoice_model.inference_instruct2(
					tts_text=text,
					instruct_text=formatted_instruct,
					prompt_wav=temp_file,
					zero_shot_spk_id="",
					stream=False,
					speed=speed,
					text_frontend=text_frontend,
				)
			elif mode == "跨语言复刻":
				formatted_text = text
				if model_info.get("is_cosyvoice3", False):
					formatted_text = f"You are a helpful assistant.<|endofprompt|>{text}"
				output = cosyvoice_model.inference_cross_lingual(
					tts_text=formatted_text,
					prompt_wav=temp_file,
					stream=False,
					speed=speed,
					text_frontend=text_frontend,
				)
			else:
				if use_prompt_audio and not prompt_text:
					raise RuntimeError("零样本复刻模式需要参考文本，或开启自动转录。")
				output = cosyvoice_model.inference_zero_shot(
					tts_text=text,
					prompt_text=prompt_text,
					prompt_wav=temp_file,
					zero_shot_spk_id="",
					stream=False,
					speed=speed,
					text_frontend=text_frontend,
				)

			pbar.update_absolute(2, 4)
			send_status(unique_id, "正在整理输出音频")

			all_speech = []
			for chunk in output:
				if isinstance(chunk, dict) and "tts_speech" in chunk:
					all_speech.append(chunk["tts_speech"])
			if not all_speech:
				raise RuntimeError("没有生成有效音频，请检查参考音频或文本内容。")
			waveform = torch.cat(all_speech, dim=-1) if len(all_speech) > 1 else all_speech[0]
			if waveform.device != torch.device("cpu"):
				waveform = waveform.cpu()

			pbar.update_absolute(3, 4)
			audio = tensor_to_comfy_audio(waveform, sample_rate)
			result_duration = float(waveform.shape[-1]) / float(sample_rate)
			send_status(unique_id, "正在保存 MP3")
			audio_ui = save_audio_mp3_ui(audio, mp3_filename_prefix, mp3_quality)
			send_audio_preview(unique_id, audio_ui)
			send_status(unique_id, f"完成：{result_duration:.2f} 秒，{sample_rate} Hz")
			pbar.update_absolute(4, 4)
			return {"ui": audio_ui, "result": (audio,)}
		except Exception as exc:
			raise RuntimeError(
				f"CosyVoice3 语音克隆器执行失败。\n"
				f"模式：{mode}\n"
				f"参考来源：{reference_source}\n"
				f"模型：{model_name}\n"
				f"详细错误：{exc}"
			) from exc
		finally:
			cleanup_temp_file(temp_file)


NODE_CLASS_MAPPINGS = {
	"GJJ_CosyVoice3Generator": GJJ_CosyVoice3Generator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
	"GJJ_CosyVoice3Generator": "GJJ·📢[风格指令]语音克隆器TTS(CosyVoice3)",
}
