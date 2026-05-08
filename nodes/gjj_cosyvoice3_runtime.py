from __future__ import annotations

import io
import os
import random
import shutil
import sys
import tempfile
import urllib.request
from typing import Any

import folder_paths
import huggingface_hub
import numpy as np
import torch

# 延迟导入 soundfile，在函数内部使用
# import soundfile as sf

VENDOR_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "vendor", "cosyvoice3"))
if VENDOR_ROOT not in sys.path:
	sys.path.insert(0, VENDOR_ROOT)

# 延迟导入 cosyvoice，在函数内部使用
# from cosyvoice.cli.cosyvoice import AutoModel


COSYVOICE_ROOT = os.path.join(folder_paths.models_dir, "cosyvoice")
LOCAL_AUDIO_ROOT = os.path.join(folder_paths.models_dir, "mp3")
LEGACY_COSYVOICE_AUDIO_ROOT = os.path.join(COSYVOICE_ROOT, "mp3")
LEGACY_LOCAL_AUDIO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "mp3"))
DEFAULT_MODEL_NAME = "Fun-CosyVoice3-0.5B-2512"
HF_MIRROR = "https://hf-mirror.com"
LOCAL_AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"}
MODEL_REPOS = {
	"Fun-CosyVoice3-0.5B-2512": "FunAudioLLM/Fun-CosyVoice3-0.5B-2512",
}
DEMO_REFERENCES = {
	"官方示例·中文男声": {
		"url": "https://funaudiollm.github.io/cosyvoice3/audio/prompt/zero-shot/zh/prompt_audio_4.wav",
		"prompt_text": "转任福建路转运判官。",
		"filename": "demo_zh_male_prompt_audio_4.wav",
	},
	"官方示例·英文男声": {
		"url": "https://funaudiollm.github.io/cosyvoice3/audio/prompt/cross-lingual/en_m.wav",
		"prompt_text": "Hey look, a flying pig!",
		"filename": "demo_en_male_en_m.wav",
	},
	"官方示例·日文男声": {
		"url": "https://funaudiollm.github.io/cosyvoice3/audio/prompt/cross-lingual/ja_m.wav",
		"prompt_text": "コノ リョーリ ワ カテー デ ツクレ マス。",
		"filename": "demo_ja_male_ja_m.wav",
	},
}
_MODEL_CACHE: dict[str, dict[str, Any]] = {}
_WHISPER_MODEL = None


def send_status(unique_id: Any, text: str) -> None:
	if not unique_id:
		return
	try:
		from server import PromptServer

		PromptServer.instance.send_sync(
			"gjj_node_progress",
			{"node": str(unique_id), "text": str(text or "")},
		)
	except Exception:
		pass


def send_audio_preview(unique_id: Any, audio_ui: dict[str, Any]) -> None:
	if not unique_id or not audio_ui:
		return
	try:
		from server import PromptServer

		PromptServer.instance.send_sync(
			"gjj_node_audio",
			{"node": str(unique_id), "audio": audio_ui.get("audio", [])},
		)
	except Exception:
		pass


def send_audio_preview(unique_id: Any, audio_ui: dict[str, Any]) -> None:
	if not unique_id or not audio_ui:
		return
	try:
		from server import PromptServer

		PromptServer.instance.send_sync(
			"gjj_node_audio",
			{"node": str(unique_id), "audio": audio_ui.get("audio", [])},
		)
	except Exception:
		pass


def send_error_to_frontend(unique_id: Any, error_message: str, install_command: str = ""):
	"""将错误信息和安装命令发送给前端"""
	try:
		from server import PromptServer

		PromptServer.instance.send_sync("gjj_cosyvoice3_error", {
			"node": str(unique_id),
			"error": error_message,
			"install_command": install_command,
		})
	except Exception:
		pass


def _normalize_key(value: str) -> str:
	return (
		str(value or "")
		.lower()
		.replace("\\", "")
		.replace("/", "")
		.replace("_", "")
		.replace("-", "")
		.replace(".", "")
		.replace(" ", "")
	)


def _is_valid_model_dir(model_dir: str) -> bool:
	if not os.path.isdir(model_dir):
		return False
	config_ok = any(os.path.exists(os.path.join(model_dir, name)) for name in ("cosyvoice.yaml", "cosyvoice2.yaml", "cosyvoice3.yaml"))
	llm_ok = any(os.path.exists(os.path.join(model_dir, name)) for name in ("llm.pt", "llm.rl.pt"))
	flow_ok = os.path.exists(os.path.join(model_dir, "flow.pt"))
	hift_ok = os.path.exists(os.path.join(model_dir, "hift.pt"))
	return config_ok and llm_ok and flow_ok and hift_ok


def list_cosyvoice_models() -> list[str]:
	os.makedirs(COSYVOICE_ROOT, exist_ok=True)
	items: list[str] = []
	for root, dirs, _ in os.walk(COSYVOICE_ROOT):
		if _is_valid_model_dir(root):
			rel = os.path.relpath(root, COSYVOICE_ROOT).replace("/", "\\")
			if rel not in items:
				items.append(rel)
	for name in MODEL_REPOS:
		if name not in items:
			items.append(name)
	return sorted(items, key=lambda item: (item.count("\\"), item.lower()))


def pick_available_name(requested: str, available: list[str], fallback: str = "") -> str:
	if not available:
		return fallback or requested or DEFAULT_MODEL_NAME
	for candidate in (requested, fallback):
		candidate = str(candidate or "").strip()
		if candidate and candidate in available:
			return candidate
	for candidate in (requested, fallback):
		candidate = str(candidate or "").strip()
		if not candidate:
			continue
		base = os.path.basename(candidate).lower()
		for item in available:
			if os.path.basename(item).lower() == base:
				return item
	target = _normalize_key(requested or fallback)
	if target:
		for item in available:
			if target in _normalize_key(item):
				return item
	return fallback or available[0]


def ensure_model_dir(model_name: str, unique_id: Any = None) -> str:
	os.makedirs(COSYVOICE_ROOT, exist_ok=True)
	model_name = str(model_name or "").strip() or DEFAULT_MODEL_NAME
	direct = os.path.join(COSYVOICE_ROOT, model_name)
	if _is_valid_model_dir(direct):
		return direct
	base = os.path.basename(model_name).lower()
	for root, dirs, _ in os.walk(COSYVOICE_ROOT):
		for dirname in dirs:
			candidate = os.path.join(root, dirname)
			if dirname.lower() == base and _is_valid_model_dir(candidate):
				return candidate
	for root, dirs, _ in os.walk(COSYVOICE_ROOT):
		for dirname in dirs:
			candidate = os.path.join(root, dirname)
			if _normalize_key(base) in _normalize_key(dirname) and _is_valid_model_dir(candidate):
				return candidate
	repo_id = MODEL_REPOS.get(model_name) or MODEL_REPOS.get(DEFAULT_MODEL_NAME)
	target_dir = os.path.join(COSYVOICE_ROOT, model_name if model_name in MODEL_REPOS else DEFAULT_MODEL_NAME)
	send_status(unique_id, f"未找到本地模型，正在从国内镜像下载：{os.path.basename(target_dir)}")
	old_endpoint = os.environ.get("HF_ENDPOINT")
	try:
		os.environ["HF_ENDPOINT"] = HF_MIRROR
		huggingface_hub.snapshot_download(repo_id=repo_id, local_dir=target_dir)
	finally:
		if old_endpoint is None:
			os.environ.pop("HF_ENDPOINT", None)
		else:
			os.environ["HF_ENDPOINT"] = old_endpoint
	if not _is_valid_model_dir(target_dir):
		raise RuntimeError(f"CosyVoice3 模型下载后仍不完整：{target_dir}")
	return target_dir


def load_cosyvoice_model(model_name: str, unique_id: Any = None) -> dict[str, Any]:
	# 运行时检查依赖
	try:
		from cosyvoice.cli.cosyvoice import AutoModel  # type: ignore  # noqa: F811
	except ImportError as exc:
		from .common_utils.dependency_checker import print_runtime_dependency_error, get_pip_install_command_text
		
		install_cmd = get_pip_install_command_text("cosyvoice==0.0.7 soundfile")
		
		description = (
			"CosyVoice3 节点需要以下依赖：\n"
			"• cosyvoice (语音合成模型)\n"
			"• soundfile (音频处理)\n\n"
			"📌 安装建议：\n"
			"1. 先升级 pip：\n"
			"   pip install --upgrade pip\n"
			"2. 安装构建工具（如果需要）：\n"
			"   pip install setuptools wheel\n"
			"3. 尝试安装指定版本：\n"
			"   pip install cosyvoice==0.0.7 soundfile\n"
			"4. 如果仍失败，从源码安装：\n"
			"   git clone https://github.com/modelscope/CosyVoice.git\n"
			"   cd CosyVoice && pip install -e .\n"
			"5. 确保已安装 PyTorch 和 CUDA"
		)

		# 打印美观的控制台错误提示
		print_runtime_dependency_error(
			node_name="CosyVoice3",
			dependency_name="cosyvoice",
			install_command=install_cmd,
			description=description,
			extra_info=f"原始导入错误：{exc}"
		)

		# 发送错误事件到前端
		send_error_to_frontend(unique_id, "运行时依赖缺失：cosyvoice", install_cmd)

		# 抛出简洁的错误信息（在前端显示）
		raise RuntimeError("运行时依赖缺失：cosyvoice。详细信息请查看控制台。") from exc

	model_dir = ensure_model_dir(model_name, unique_id)
	cache_key = model_dir
	if cache_key in _MODEL_CACHE:
		return _MODEL_CACHE[cache_key]
	send_status(unique_id, f"正在加载 CosyVoice3 模型：{os.path.basename(model_dir)}")
	model = AutoModel(model_dir=model_dir, load_trt=False, fp16=False)
	info = {
		"model": model,
		"model_dir": model_dir,
		"sample_rate": getattr(model, "sample_rate", 24000),
		"is_cosyvoice3": os.path.exists(os.path.join(model_dir, "cosyvoice3.yaml")),
	}
	_MODEL_CACHE[cache_key] = info
	return info


def _ensure_soundfile():
	"""确保 soundfile 已安装"""
	try:
		import soundfile as sf  # noqa: F811
		return sf
	except ImportError as exc:
		from .common_utils.dependency_checker import print_runtime_dependency_error, get_pip_install_command_text

		install_cmd = get_pip_install_command_text("soundfile")

		# 打印美观的控制台错误提示
		print_runtime_dependency_error(
			node_name="CosyVoice3",
			dependency_name="soundfile",
			install_command=install_cmd,
			description="该节点需要 soundfile 库来处理音频文件",
			extra_info=f"原始导入错误：{exc}"
		)

		# 抛出简洁的错误信息（在前端显示）
		raise RuntimeError("运行时依赖缺失：soundfile。详细信息请查看控制台。") from exc


def get_speaker_dir() -> str:
	speaker_dir = os.path.join(COSYVOICE_ROOT, "speaker")
	os.makedirs(speaker_dir, exist_ok=True)
	return speaker_dir


def get_demo_dir() -> str:
	demo_dir = os.path.join(COSYVOICE_ROOT, "demo")
	os.makedirs(demo_dir, exist_ok=True)
	return demo_dir


def get_local_audio_dir() -> str:
	os.makedirs(LOCAL_AUDIO_ROOT, exist_ok=True)
	return LOCAL_AUDIO_ROOT


def _legacy_audio_roots() -> list[str]:
	roots: list[str] = []
	primary = os.path.abspath(LOCAL_AUDIO_ROOT)
	for candidate in (LEGACY_COSYVOICE_AUDIO_ROOT, LEGACY_LOCAL_AUDIO_ROOT):
		candidate_abs = os.path.abspath(candidate)
		if candidate_abs != primary and candidate_abs not in roots:
			roots.append(candidate_abs)
	return roots


def _migrate_legacy_local_audios() -> None:
	root = get_local_audio_dir()
	for legacy_root in _legacy_audio_roots():
		if not os.path.isdir(legacy_root):
			continue
		for current_root, _, files in os.walk(legacy_root):
			for filename in files:
				if os.path.splitext(filename)[1].lower() not in LOCAL_AUDIO_EXTENSIONS:
					continue
				source_path = os.path.join(current_root, filename)
				relative_path = os.path.relpath(source_path, legacy_root)
				target_path = os.path.join(root, relative_path)
				if os.path.abspath(source_path) == os.path.abspath(target_path) or os.path.exists(target_path):
					continue
				try:
					os.makedirs(os.path.dirname(target_path), exist_ok=True)
					shutil.copy2(source_path, target_path)
				except Exception:
					pass


def list_local_example_audios() -> list[str]:
	root = get_local_audio_dir()
	_migrate_legacy_local_audios()
	items: list[str] = []
	search_roots = [root]
	for legacy_root in _legacy_audio_roots():
		if os.path.isdir(legacy_root):
			search_roots.append(legacy_root)
	for scan_root in search_roots:
		for current_root, _, files in os.walk(scan_root):
			for filename in files:
				if os.path.splitext(filename)[1].lower() not in LOCAL_AUDIO_EXTENSIONS:
					continue
				full_path = os.path.join(current_root, filename)
				rel = os.path.relpath(full_path, scan_root).replace("/", "\\")
				if rel not in items:
					items.append(rel)
	return sorted(items, key=lambda item: (item.count("\\"), item.lower()))


def list_demo_references() -> list[str]:
	return list(DEMO_REFERENCES.keys())


def ensure_demo_reference(name: str, unique_id: Any = None) -> dict[str, Any]:
	meta = DEMO_REFERENCES.get(name)
	if not meta:
		raise RuntimeError(f"未找到官方示例音色：{name}")
	demo_dir = get_demo_dir()
	local_path = os.path.join(demo_dir, meta["filename"])
	if not os.path.isfile(local_path):
		send_status(unique_id, f"正在下载官方示例音色：{name}")
		with urllib.request.urlopen(meta["url"]) as response, open(local_path, "wb") as output:
			output.write(response.read())
	sf = _ensure_soundfile()
	info = sf.info(local_path)
	return {
		"name": name,
		"path": local_path,
		"prompt_text": meta["prompt_text"],
		"duration": float(info.frames) / float(info.samplerate),
		"sample_rate": int(info.samplerate),
	}


def local_example_audio_to_tempfile(name: str) -> tuple[str, float]:
	if not name or name in {"[未找到示例音色]", "[未找到示例音频]"}:
		raise RuntimeError(f"未找到可用的本地示例音频，请把音频文件放到 {LOCAL_AUDIO_ROOT}。")
	root = get_local_audio_dir()
	_migrate_legacy_local_audios()
	relative_name = name.replace("/", os.sep).replace("\\", os.sep)
	source_path = os.path.join(root, relative_name)
	if not os.path.isfile(source_path):
		source_path = ""
		for legacy_root in _legacy_audio_roots():
			legacy_path = os.path.join(legacy_root, relative_name)
			if os.path.isfile(legacy_path):
				source_path = legacy_path
				break
	if not source_path or not os.path.isfile(source_path):
		raise RuntimeError(f"未找到本地示例音频：{name}")
	return audio_file_to_tempfile(source_path)


def audio_file_to_tempfile(source_path: str) -> tuple[str, float]:
	if not source_path or not os.path.isfile(source_path):
		raise RuntimeError(f"未找到音频文件：{source_path}")
	try:
		sf = _ensure_soundfile()
		audio_np, sample_rate = sf.read(source_path, always_2d=True)
	except Exception as sf_exc:
		try:
			audio_np, sample_rate = _decode_audio_with_av(source_path)
		except Exception as av_exc:
			raise RuntimeError(
				f"无法解码音频文件：{source_path}\n"
				f"建议使用 wav、flac、mp3、m4a、ogg 或 aac；如果文件扩展名是 mp3 但内部实际是其它编码，也会自动尝试兼容。\n"
				f"soundfile 错误：{sf_exc}\n"
				f"PyAV 错误：{av_exc}"
			) from av_exc
	temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
	temp_path = temp_file.name
	temp_file.close()
	sf = _ensure_soundfile()
	sf.write(temp_path, audio_np, int(sample_rate))
	duration = float(audio_np.shape[0]) / float(sample_rate)
	return temp_path, duration


def _decode_audio_with_av(source_path: str) -> tuple[np.ndarray, int]:
	import av

	with av.open(source_path) as container:
		if not container.streams.audio:
			raise RuntimeError("文件中没有可解码的音频流。")
		stream = container.streams.audio[0]
		sample_rate = int(stream.codec_context.sample_rate or 0)
		chunks: list[np.ndarray] = []
		for frame in container.decode(stream):
			if not sample_rate:
				sample_rate = int(frame.sample_rate or 0)
			chunk = frame.to_ndarray()
			if chunk.ndim == 1:
				chunk = chunk[:, None]
			elif chunk.shape[0] <= 8:
				chunk = chunk.T
			chunks.append(chunk.astype(np.float32, copy=False))
	if not chunks or not sample_rate:
		raise RuntimeError("音频解码后没有有效采样。")
	return np.concatenate(chunks, axis=0), sample_rate


def save_audio_mp3_ui(audio: dict[str, Any], filename_prefix: str, quality: str = "320k") -> dict[str, Any]:
	prefix = str(filename_prefix or "").strip() or "audio/GJJ_CosyVoice3"
	selected_quality = str(quality or "320k").strip()
	if selected_quality not in {"V0", "128k", "320k"}:
		selected_quality = "320k"
	try:
		from comfy_api.latest import UI

		return UI.AudioSaveHelper.get_save_audio_ui(
			audio,
			filename_prefix=prefix,
			cls=None,
			format="mp3",
			quality=selected_quality,
		).as_dict()
	except Exception as exc:
		raise RuntimeError(f"保存 MP3 失败：{exc}") from exc


def list_speaker_presets() -> list[str]:
	speaker_dir = get_speaker_dir()
	items = ["[不使用]"]
	if not os.path.isdir(speaker_dir):
		return items
	names = [
		os.path.splitext(f)[0]
		for f in sorted(os.listdir(speaker_dir))
		if f.endswith(".pt")
	]
	return items + names


def load_speaker_preset(preset_name: str, device: torch.device | None = None) -> tuple[str, dict[str, Any]]:
	if not preset_name or preset_name == "[不使用]":
		raise RuntimeError("未选择说话人预设。")
	speaker_dir = get_speaker_dir()
	pt_path = os.path.join(speaker_dir, f"{preset_name}.pt")
	if not os.path.isfile(pt_path):
		raise RuntimeError(f"未找到说话人预设：{preset_name}")
	load_device = device or torch.device("cuda" if torch.cuda.is_available() else "cpu")
	spk2info = torch.load(pt_path, map_location=load_device)
	spk_id = next(iter(spk2info))
	return spk_id, spk2info


def get_whisper_model():
	global _WHISPER_MODEL
	if _WHISPER_MODEL is None:
		import whisper

		_WHISPER_MODEL = whisper.load_model("base")
	return _WHISPER_MODEL


def transcribe_audio(audio_path: str) -> str:
	try:
		model = get_whisper_model()
		result = model.transcribe(audio_path, language=None)
		return str(result.get("text", "")).strip()
	except Exception:
		return ""


def comfy_audio_to_tempfile(audio: dict[str, Any], suffix: str = ".wav") -> tuple[str, float]:
	waveform = audio["waveform"]
	sample_rate = int(audio["sample_rate"])
	if waveform.ndim == 3:
		waveform = waveform.squeeze(0)
	if waveform.device != torch.device("cpu"):
		waveform = waveform.cpu()
	audio_np = waveform.numpy()
	if audio_np.ndim == 2:
		audio_np = audio_np.T
	temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
	temp_path = temp_file.name
	temp_file.close()
	sf = _ensure_soundfile()
	sf.write(temp_path, audio_np, sample_rate)
	duration = float(waveform.shape[-1]) / float(sample_rate)
	return temp_path, duration


def cleanup_temp_file(path: str | None) -> None:
	if path and os.path.exists(path):
		try:
			os.unlink(path)
		except Exception:
			pass


def tensor_to_comfy_audio(waveform: torch.Tensor, sample_rate: int) -> dict[str, Any]:
	if waveform.device != torch.device("cpu"):
		waveform = waveform.cpu()
	if waveform.ndim == 1:
		waveform = waveform.unsqueeze(0).unsqueeze(0)
	elif waveform.ndim == 2:
		waveform = waveform.unsqueeze(0)
	return {"waveform": waveform, "sample_rate": int(sample_rate)}


def set_random_seed(seed: int) -> None:
	if seed < 0:
		seed = random.randint(0, 2_147_483_647)
	torch.manual_seed(seed)
	random.seed(seed)
	if torch.cuda.is_available():
		torch.cuda.manual_seed_all(seed)
