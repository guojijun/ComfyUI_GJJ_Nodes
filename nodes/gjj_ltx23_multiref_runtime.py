from __future__ import annotations

from contextlib import contextmanager
import datetime
from fractions import Fraction
from typing import Any, Iterable
import gc
import importlib
import inspect
import json
import math
import re
import sys
import types

# 零依赖导入模式：本文件在 ComfyUI 扫描节点时不再顶层导入 torch / comfy / comfy_extras / nodes。
# 所有第三方与 ComfyUI 运行时依赖都延迟到真正执行节点时由 _ensure_runtime_dependencies() 加载，
# 避免缺少某个可选节点或库时导致整个 GJJ 节点包导入失败。
DEFAULT_SEGMENT_VIDEO_FORMAT = "video/h264-mp4"
_RUNTIME_DEPS_READY = False


def _ensure_runtime_dependencies() -> None:
	global _RUNTIME_DEPS_READY
	if _RUNTIME_DEPS_READY:
		return
	global comfy, mm, folder_paths, torch, F
	global InputImpl, Types
	global CFGNorm, CFGGuider, KSamplerSelect, ManualSigmas, RandomNoise, SamplerCustomAdvanced
	global LatentUpscaleModelLoader
	global EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVConditioning, LTXVCropGuides, LTXVSeparateAVLatent, LTXVPreprocess, LTXVImgToVideoInplace
	global LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAEEncode, LTXVAudioVAELoader, LTXVEmptyLatentAudio
	global LTXVLatentUpsampler, CreateVideo
	global core_nodes, CheckpointLoaderSimple, CLIPTextEncode, VAEDecodeTiled
	global combine_video, list_supported_formats, pick_available_model_name
	global apply_lora_chain_config, normalize_lora_chain_data, parse_lora_data
	global DEFAULT_SEGMENT_VIDEO_FORMAT

	try:
		comfy = importlib.import_module("comfy")
		importlib.import_module("comfy.ldm.modules.attention")
		comfy.model_management = importlib.import_module("comfy.model_management")
		comfy.sd = importlib.import_module("comfy.sd")
		comfy.utils = importlib.import_module("comfy.utils")
		mm = comfy.model_management
		folder_paths = importlib.import_module("folder_paths")
		torch = importlib.import_module("torch")
		F = importlib.import_module("torch.nn.functional")

		latest = importlib.import_module("comfy_api.latest")
		InputImpl = latest.InputImpl
		Types = latest.Types

		CFGNorm = importlib.import_module("comfy_extras.nodes_cfg").CFGNorm
		custom_sampler = importlib.import_module("comfy_extras.nodes_custom_sampler")
		CFGGuider = custom_sampler.CFGGuider
		KSamplerSelect = custom_sampler.KSamplerSelect
		ManualSigmas = custom_sampler.ManualSigmas
		RandomNoise = custom_sampler.RandomNoise
		SamplerCustomAdvanced = custom_sampler.SamplerCustomAdvanced
		LatentUpscaleModelLoader = importlib.import_module("comfy_extras.nodes_hunyuan").LatentUpscaleModelLoader

		nodes_lt = importlib.import_module("comfy_extras.nodes_lt")
		EmptyLTXVLatentVideo = nodes_lt.EmptyLTXVLatentVideo
		LTXVAddGuide = nodes_lt.LTXVAddGuide
		LTXVConcatAVLatent = nodes_lt.LTXVConcatAVLatent
		LTXVConditioning = nodes_lt.LTXVConditioning
		LTXVCropGuides = nodes_lt.LTXVCropGuides
		LTXVSeparateAVLatent = nodes_lt.LTXVSeparateAVLatent
		LTXVPreprocess = getattr(nodes_lt, "LTXVPreprocess", None)
		LTXVImgToVideoInplace = getattr(nodes_lt, "LTXVImgToVideoInplace", None)

		nodes_lt_audio = importlib.import_module("comfy_extras.nodes_lt_audio")
		LTXAVTextEncoderLoader = nodes_lt_audio.LTXAVTextEncoderLoader
		LTXVAudioVAEDecode = nodes_lt_audio.LTXVAudioVAEDecode
		LTXVAudioVAEEncode = nodes_lt_audio.LTXVAudioVAEEncode
		LTXVAudioVAELoader = nodes_lt_audio.LTXVAudioVAELoader
		LTXVEmptyLatentAudio = nodes_lt_audio.LTXVEmptyLatentAudio
		LTXVLatentUpsampler = importlib.import_module("comfy_extras.nodes_lt_upsampler").LTXVLatentUpsampler
		CreateVideo = importlib.import_module("comfy_extras.nodes_video").CreateVideo

		core_nodes = importlib.import_module("nodes")
		CheckpointLoaderSimple = core_nodes.CheckpointLoaderSimple
		CLIPTextEncode = core_nodes.CLIPTextEncode
		VAEDecodeTiled = core_nodes.VAEDecodeTiled

		video_runtime = importlib.import_module(".gjj_video_combine_runtime", __package__)
		DEFAULT_SEGMENT_VIDEO_FORMAT = getattr(video_runtime, "DEFAULT_FORMAT", DEFAULT_SEGMENT_VIDEO_FORMAT)
		combine_video = video_runtime.combine_video
		list_supported_formats = video_runtime.list_supported_formats
		model_resolver = importlib.import_module(".gjj_model_name_resolver", __package__)
		pick_available_model_name = model_resolver.pick_available_model_name
		lora_chain = importlib.import_module(".gjj_multi_lora_chain", __package__)
		apply_lora_chain_config = lora_chain.apply_lora_chain_config
		normalize_lora_chain_data = lora_chain.normalize_lora_chain_data
		parse_lora_data = lora_chain.parse_lora_data
	except Exception as exc:
		raise RuntimeError(
			"LTX2.3 节点运行依赖加载失败。节点已启用零依赖导入模式，因此这个错误只会在执行时出现；"
			"请确认当前 ComfyUI 已安装 LTX/AV 所需的 comfy_extras、torch 与相关自定义节点。"
			f"原始错误：{exc}"
		) from exc
	_RUNTIME_DEPS_READY = True

GJJ_LTX23_RUNTIME_PATCH_VERSION = "workflow_v40_switch_fix_description"

DEFAULT_NEGATIVE_PROMPT = (
	"titles, subtitles, text, watermark, logo, blurry text, distorted text, overexposed, underexposed, "
	"low contrast, washed out colors, excessive noise, motion blur, camera shake, background clutter, "
	"unnatural skin tones, deformed facial features, extra limbs, disfigured hands, uncanny valley, "
	"mismatched lip sync, off-sync audio, jittery movement, awkward pauses, incorrect timing, AI artifacts"
)

DEFAULT_STAGE1_SAMPLER = "euler_ancestral_cfg_pp"
DEFAULT_STAGE2_SAMPLER = "euler_cfg_pp"
DEFAULT_STAGE1_SIGMAS = "1.0, 0.99375, 0.9875, 0.975, 0.935212, 0.909375, 0.881203, 0.863321, 0.841251, 0.820089, 0.655, 0.381875, 0.0"
DEFAULT_STAGE2_SIGMAS = "0.5, 0.45, 0.35, 0.20, 0.0"
DEFAULT_DENOISE_STRENGTH = 1.0
LTX_TRANSITION_LORA_TRIGGER = "zhuanchang"
DEFAULT_CFG = 1.0
DEFAULT_NAG_SCALE = 14.0
DEFAULT_NAG_ALPHA = 0.4
DEFAULT_NAG_TAU = 4.0
DEFAULT_FF_CHUNKS = 4
DEFAULT_FF_DIM_THRESHOLD = 4096
DEFAULT_AUDIO_TARGET_DB = -18.0
DEFAULT_AUDIO_MAX_SECONDS = 120.0
DEFAULT_AUDIO_START_SECONDS = 0.0
DEFAULT_AUDIO_SAFE_BASE_VRAM_GB = 32.0
DEFAULT_AUDIO_SAFE_PIXEL_FRAMES_AT_32GB = 160_000_000
DEFAULT_AUDIO_SAFE_FRAME_CAP_AT_32GB = 241
MIN_AUDIO_SAFE_PIXEL_FRAMES = 96_000_000
MAX_AUDIO_SAFE_PIXEL_FRAMES = 240_000_000
MIN_AUDIO_SAFE_FRAME_CAP = 97
MAX_AUDIO_SAFE_FRAME_CAP = 385
DEFAULT_AUDIO_SAFE_WARNING_RATIO = 0.85
DEFAULT_AUDIO_SPEED_TARGET_RATIO = 0.6
DEFAULT_AUDIO_FAST_LONG_EDGE_AT_32GB = 896
MIN_AUDIO_FAST_LONG_EDGE = 640
MAX_AUDIO_FAST_LONG_EDGE = 1152
DEFAULT_AUDIO_GUIDE_PENALTY = 0.06
DEFAULT_VAE_TILE_SIZE = 512
DEFAULT_VAE_OVERLAP = 64
DEFAULT_VAE_TEMPORAL_SIZE = 512
DEFAULT_VAE_TEMPORAL_OVERLAP = 4
DEFAULT_STAGE2_UPSCALE_FACTOR = 2

WORKFLOW_FIRST_LAST_IMG_COMPRESSION = 18
WORKFLOW_FIRST_LAST_GUIDE_STRENGTH = 0.7
WORKFLOW_FIRST_LAST_INPLACE_STRENGTH = 1.0
WORKFLOW_FIRST_LAST_STAGE1_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
WORKFLOW_FIRST_LAST_STAGE2_SIGMAS = "0.85, 0.7250, 0.4219, 0.0"
WORKFLOW_FIRST_LAST_NAG_SCALE = 11.0
WORKFLOW_FIRST_LAST_NAG_ALPHA = 0.25
WORKFLOW_FIRST_LAST_NAG_TAU = 2.5

MODE_GENERATED_AUDIO = "generated_audio"
MODE_AUDIO_CONDITIONED = "audio_conditioned"
PROGRESS_TEXT_RE = re.compile(r"(\d+)\s*/\s*(\d+)")


def _extract_progress_value(text: str) -> float | None:
	message = str(text or "")
	match = PROGRESS_TEXT_RE.search(message)
	if match:
		current = max(0, int(match.group(1) or 0))
		total = max(1, int(match.group(2) or 1))
		return max(0.0, min(1.0, float(current) / float(total)))
	if "完成" in message or "失败" in message:
		return 1.0
	return None


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
	if not unique_id:
		return
	try:
		from server import PromptServer

		payload = {"node": str(unique_id), "text": str(text or "")}
		resolved_progress = _extract_progress_value(text) if progress is None else progress
		if resolved_progress is not None:
			payload["progress"] = max(0.0, min(1.0, float(resolved_progress)))
		PromptServer.instance.send_sync(
			"gjj_node_progress",
			payload,
		)
	except Exception:
		pass


def _debug_tensor_info(value: Any) -> str:
	try:
		if isinstance(value, dict) and isinstance(value.get("samples"), torch.Tensor):
			t = value.get("samples")
			return f"LATENT samples.shape={tuple(t.shape)}, dtype={t.dtype}, device={t.device}"
	except Exception:
		pass
	try:
		if isinstance(value, torch.Tensor):
			return f"Tensor shape={tuple(value.shape)}, dtype={value.dtype}, device={value.device}"
	except Exception:
		pass
	try:
		return f"{type(value).__name__}"
	except Exception:
		return "(unknown)"


def _send_segment_preview(unique_id: Any, payload: dict[str, Any]) -> None:
	if not unique_id:
		return
	try:
		from server import PromptServer

		message = {"node": str(unique_id)}
		message.update(payload or {})
		PromptServer.instance.send_sync("gjj_ltx23_multiref_segment", message)
	except Exception:
		pass


def _normalize_text(text: str) -> str:
	return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _lookup_tokens(text: str) -> list[str]:
	return [
		_normalize_text(part)
		for part in str(text or "").replace("\\", "/").replace("_", " ").replace("-", " ").replace(".", " ").split()
		if _normalize_text(part)
	]


def _safe_filename_list(category: str) -> list[str]:
	_ensure_runtime_dependencies()
	try:
		return list(folder_paths.get_filename_list(category))
	except Exception:
		return []


def _pick_available_name(preferred: str, available: Iterable[str]) -> str:
	_ensure_runtime_dependencies()
	return pick_available_model_name(preferred, available, allow_first=False)
def _pick_first_candidate(category: str, candidates: Iterable[str], label: str, required: bool = True) -> str:
    available = _safe_filename_list(category)
    # 遍历候选模型
    for candidate in candidates:
        resolved = _pick_available_name(candidate, available)
        if resolved:
            full_path = folder_paths.get_full_path(category, resolved)
            if full_path:
                # ========== 彩色输出：成功找到模型 ==========
                print(f"\033[93m\033[1m[✓] 成功加载 {label}\033[0m")
                print(f"\033[0m  └─ 模型分类：{category}\033[0m")
                print(f"\033[0m  └─ 实际使用：{resolved}\033[0m")
                return resolved
    if not required:
        print(f"\033[92m[⚠] {label} 为非必需项，未找到任何可用模型\033[0m")
        return ""
    candidate_text = " / ".join(str(item) for item in candidates)
    error_msg = f"\033[91m\033[1m[✗] 未找到 {label}，候选项：{candidate_text}\033[0m"
    print(error_msg)
    raise RuntimeError(f"未找到{label}，候选项：{candidate_text}")

def _is_ltx_transition_lora_name(lora_name: Any) -> bool:
	normalized = _normalize_text(str(lora_name or ""))
	return ("ltx23transition" in normalized or ("ltx23" in normalized and "transition" in normalized) or ("ltx" in normalized and "zhuanchang" in normalized))


def _find_auto_transition_lora_name() -> tuple[str, str]:
	"""从 models/loras（含子目录）搜索关键词 ltx2.3-transition，不分大小写。返回 (loras_name, full_path)。"""
	keyword = "ltx2.3-transition"
	candidates: list[str] = []
	try:
		for name in folder_paths.get_filename_list("loras") or []:
			if keyword in str(name or "").lower():
				candidates.append(str(name))
	except Exception:
		pass
	if not candidates:
		try:
			for root in folder_paths.get_folder_paths("loras") or []:
				root_path = Path(root)
				if not root_path.exists():
					continue
				for file in root_path.rglob("*"):
					if file.is_file() and keyword in str(file.relative_to(root_path)).replace('\\','/').lower():
						candidates.append(str(file.relative_to(root_path)).replace('\\','/'))
		except Exception:
			pass
	if not candidates:
		return "", ""
	candidates = sorted(dict.fromkeys(candidates), key=lambda s: (len(s), s.lower()))
	name = candidates[0]
	full_path = ""
	try:
		full_path = folder_paths.get_full_path("loras", name) or ""
	except Exception:
		pass
	if not full_path:
		try:
			for root in folder_paths.get_folder_paths("loras") or []:
				probe = Path(root) / name
				if probe.exists():
					full_path = str(probe)
					break
		except Exception:
			pass
	return name, full_path


def _ensure_transition_lora_in_chain(lora_chain_config: Any, enable_auto: bool) -> tuple[str, bool, str, str]:
	"""若首尾帧分支需要，自动把转场 lora 注入 lora_chain_config。返回 (prepared_config, enabled, lora_name, lora_path)。"""
	items = parse_lora_data(lora_chain_config)
	if not items:
		items = []
	auto_name = ""
	auto_path = ""
	enabled = False
	for item in items:
		if item.get("enabled", True) is not False and _is_ltx_transition_lora_name(item.get("name", "")):
			enabled = True
			auto_name = str(item.get("name", "") or "")
			try:
				auto_path = folder_paths.get_full_path("loras", auto_name) or ""
			except Exception:
				auto_path = ""
			item["strength"] = 1.0
			break
	if (not enabled) and enable_auto:
		auto_name, auto_path = _find_auto_transition_lora_name()
		if auto_name:
			items.append({"name": auto_name, "strength": 1.0, "enabled": True})
			enabled = True
	prepared = normalize_lora_chain_data(json.dumps(items, ensure_ascii=False)) if items else normalize_lora_chain_data(lora_chain_config)
	return prepared, enabled, auto_name, auto_path


def _prepare_ltx_lora_chain_config(lora_chain_config: Any) -> tuple[str, bool, bool]:
	items = parse_lora_data(lora_chain_config)
	if not items:
		return normalize_lora_chain_data(lora_chain_config), False, False
	changed_strength = False
	transition_enabled = False
	prepared: list[dict[str, Any]] = []
	for item in items:
		copied = dict(item)
		enabled = copied.get("enabled", True) is not False
		name = str(copied.get("name", "") or "").strip()
		if enabled and name and _is_ltx_transition_lora_name(name):
			transition_enabled = True
			try:
				current_strength = float(copied.get("strength", 1.0))
			except Exception:
				current_strength = 1.0
			if abs(current_strength - 1.0) > 1e-6:
				changed_strength = True
			copied["strength"] = 1.0
		prepared.append(copied)
	return normalize_lora_chain_data(json.dumps(prepared, ensure_ascii=False)), transition_enabled, changed_strength


def _strip_transition_lora_from_chain(lora_chain_config: Any) -> str:
	items = parse_lora_data(lora_chain_config)
	if not items:
		return normalize_lora_chain_data(lora_chain_config)
	prepared: list[dict[str, Any]] = []
	for item in items:
		copied = dict(item)
		name = str(copied.get("name", "") or "").strip()
		if name and _is_ltx_transition_lora_name(name):
			continue
		prepared.append(copied)
	return normalize_lora_chain_data(json.dumps(prepared, ensure_ascii=False)) if prepared else ""


def _parse_transition_lora_switches(value: Any) -> list[str]:
	text = str(value or "").strip()
	if not text:
		return []
	return [str(part).strip() for part in text.split(",")]


def _resolve_transition_lora_switch_for_segment(value: Any, segment_index: int | None = None) -> bool:
	"""1=启用，0=关闭。默认不填/没数据/越界都启用。segment_index 从 1 开始。"""
	parts = _parse_transition_lora_switches(value)
	if not parts:
		return True
	idx = 0 if segment_index is None else max(0, int(segment_index) - 1)
	if idx >= len(parts):
		return True
	raw = str(parts[idx] or "").strip()
	if raw == "0":
		return False
	if raw == "1":
		return True
	return True

def _resolve_transition_lora_switch_any(value: Any, segment_count: int = 1) -> bool:
	"""是否需要全局加载转场 LoRA。

	默认：不填/越界/非法值都启用。
	如果用户明确填的可用段全部是 0，则不加载转场 LoRA。
	"""
	parts = _parse_transition_lora_switches(value)
	if not parts:
		return True
	limit = max(1, int(segment_count or 1))
	has_effective = False
	for index in range(1, limit + 1):
		if index <= len(parts):
			has_effective = True
		if _resolve_transition_lora_switch_for_segment(value, index):
			return True
	return not has_effective




def _append_ltx_transition_trigger(prompt_text: str, transition_lora_enabled: bool) -> tuple[str, bool]:
	text = str(prompt_text or "").strip()
	if not transition_lora_enabled:
		return text, False
	normalized_prompt = _normalize_text(text)
	normalized_trigger = _normalize_text(LTX_TRANSITION_LORA_TRIGGER)
	if normalized_trigger in normalized_prompt:
		return text, False
	if not text:
		return LTX_TRANSITION_LORA_TRIGGER, True
	return f"{LTX_TRANSITION_LORA_TRIGGER}, {text}", True


def _apply_chain_loras(model, clip, lora_chain_config: Any = ""):
	prepared_config, _, _ = _prepare_ltx_lora_chain_config(lora_chain_config)
	if not parse_lora_data(prepared_config):
		return model, clip
	current_model, current_clip, _ = apply_lora_chain_config(
		model,
		clip,
		lora_data=prepared_config,
		loaded_lora_cache=None,
	)
	return current_model, current_clip



def _load_ltx_main_model(model_name: str):
	"""Load LTX main model from diffusion_models.

	ComfyUI versions expose different loader class names/methods, so this helper first
	tries the public node loader and then falls back to comfy.sd.load_diffusion_model_guess_config.
	"""
	name = str(model_name or "").strip()
	if not name:
		raise RuntimeError("未指定 LTX 主模型。")
	errors: list[str] = []

	# Preferred: use ComfyUI's diffusion-model loader node when available.
	for class_name in ("UNETLoader", "DiffusionModelLoader", "LoadDiffusionModel"):
		loader_cls = getattr(core_nodes, class_name, None)
		if loader_cls is None:
			continue
		try:
			loader = loader_cls()
		except Exception as exc:
			errors.append(f"{class_name} 初始化失败：{exc}")
			continue
		for method_name in ("load_unet", "load_model", "load"):
			method = getattr(loader, method_name, None)
			if method is None:
				continue
			call_attempts = (
				lambda: method(name, "default"),
				lambda: method(name, "fp16"),
				lambda: method(name, weight_dtype="default"),
				lambda: method(name),
			)
			for call in call_attempts:
				try:
					out = call()
					model = out[0] if isinstance(out, (tuple, list)) else out
					if model is not None:
						print(f"[GJJ LTX2.3] 已从 diffusion_models 使用 {class_name}.{method_name} 加载主模型：{name}")
						return model
				except TypeError:
					continue
				except Exception as exc:
					errors.append(f"{class_name}.{method_name}：{exc}")
					break

	# Fallback: direct comfy.sd loader.
	try:
		path = folder_paths.get_full_path("diffusion_models", name)
		if not path:
			raise RuntimeError(f"未在 diffusion_models 中找到：{name}")
		embedding_directory = None
		try:
			embedding_directory = folder_paths.get_folder_paths("embeddings")
		except Exception:
			embedding_directory = None
		kwargs = {
			"output_vae": False,
			"output_clip": False,
			"embedding_directory": embedding_directory,
		}
		try:
			return comfy.sd.load_diffusion_model_guess_config(path, **kwargs)
		except TypeError:
			kwargs.pop("embedding_directory", None)
			try:
				return comfy.sd.load_diffusion_model_guess_config(path, **kwargs)
			except TypeError:
				return comfy.sd.load_diffusion_model_guess_config(path)
	except Exception as exc:
		errors.append(f"comfy.sd.load_diffusion_model_guess_config：{exc}")

	raise RuntimeError("LTX 主模型加载失败：" + "；".join(errors[-8:]))

def _load_video_vae(vae_name: str):
	_ensure_runtime_dependencies()
	vae_path = folder_paths.get_full_path("vae", vae_name)
	if not vae_path:
		raise RuntimeError(f"未找到视频 VAE：{vae_name}")
	sd, metadata = comfy.utils.load_torch_file(vae_path, return_metadata=True)
	vae = comfy.sd.VAE(sd=sd, metadata=metadata, dtype=None)
	vae.throw_exception_if_invalid()
	return vae
def _load_audio_vae(audio_vae_name: str):
	_ensure_runtime_dependencies()
	if not audio_vae_name:
		raise RuntimeError("未指定音频 VAE。")

	# 先确认文件在 vae 目录
	audio_vae_path = folder_paths.get_full_path("vae", audio_vae_name)
	if not audio_vae_path:
		raise RuntimeError(f"未在 vae 目录找到音频 VAE：{audio_vae_name}")

	# 临时把 vae 目录里的同名文件注册/映射给官方 Audio VAE Loader 使用
	try:
		original_get_full_path_or_raise = folder_paths.get_full_path_or_raise

		def patched_get_full_path_or_raise(folder_name, filename):
			if folder_name == "checkpoints" and filename == audio_vae_name:
				vae_path = folder_paths.get_full_path("vae", filename)
				if vae_path:
					return vae_path
			return original_get_full_path_or_raise(folder_name, filename)

		folder_paths.get_full_path_or_raise = patched_get_full_path_or_raise

		return LTXVAudioVAELoader.execute(audio_vae_name)[0]

	except AssertionError as exc:
		raise RuntimeError(
			f"音频 VAE 文件无效：{audio_vae_name}。"
			"该文件缺少 audio_vae_config / audio_config 元数据，不能作为 LTX Audio VAE 使用。"
		) from exc
	except Exception as exc:
		raise RuntimeError(f"加载音频 VAE 失败：{audio_vae_name}，原因：{exc}") from exc
	finally:
		try:
			folder_paths.get_full_path_or_raise = original_get_full_path_or_raise
		except Exception:
			pass


def _is_real_loader_class(candidate: Any) -> bool:
	"""过滤 torch.ops 这类动态命名空间，避免把它误判成 Comfy 节点类。"""
	if candidate is None:
		return False
	try:
		import types as _types
		if isinstance(candidate, _types.ModuleType):
			return False
	except Exception:
		pass
	module_name = str(getattr(candidate, "__module__", ""))
	class_name = str(getattr(candidate, "__name__", ""))
	text = f"{module_name}.{class_name}.{candidate!r}"
	if "torch.ops" in text or "_OpNamespace" in text:
		return False
	if isinstance(candidate, type):
		return True
	if callable(candidate):
		return True
	for method_name in ("load_model", "execute", "load", "load_clip"):
		if hasattr(candidate, method_name):
			return True
	return False


def _get_ltx_gemma_clip_loader_class():
	"""查找参考工作流使用的 LTXVGemmaCLIPModelLoader。

	兼容三种情况：
	1. 节点已经注册到 ComfyUI 的 NODE_CLASS_MAPPINGS；
	2. gemma_encoder.py 模块已经被其它扩展加载，但没有暴露到全局映射；
	3. 扩展存在于 custom_nodes 里，但模块还没被 import。
	"""
	# 1) 先从 ComfyUI 全局节点映射取，兼容已注册的情况。
	try:
		import nodes as comfy_nodes
		mapping = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}) or {}
		loader_cls = mapping.get("LTXVGemmaCLIPModelLoader")
		if _is_real_loader_class(loader_cls):
			return loader_cls
	except Exception:
		pass

	# 2) 再从已加载模块里找。部分自定义节点用自己的 registry，不一定写入 nodes.NODE_CLASS_MAPPINGS。
	try:
		for module_name, module in list(sys.modules.items()):
			if str(module_name).startswith("torch"):
				continue
			loader_cls = getattr(module, "LTXVGemmaCLIPModelLoader", None)
			if _is_real_loader_class(loader_cls):
				return loader_cls
	except Exception:
		pass

	# 3) 尝试常见模块名。不同 ComfyUI / fork 版本节点位置可能不同。
	for module_name in (
		"comfy_extras.nodes_lt_audio",
		"comfy_extras.nodes_lt",
		"comfy_extras.nodes_lt_advanced",
		"gemma_encoder",
		"ltx_video.gemma_encoder",
		"lightricks.gemma_encoder",
	):
		try:
			module = importlib.import_module(module_name)
		except Exception:
			continue
		loader_cls = getattr(module, "LTXVGemmaCLIPModelLoader", None)
		if _is_real_loader_class(loader_cls):
			return loader_cls

	# 4) 最后扫描 custom_nodes/**/gemma_encoder.py，并用临时 package 名动态导入。
	#    这样可以让 gemma_encoder.py 里的相对导入（.nodes_registry / .text_embeddings_connectors）继续生效。
	try:
		from pathlib import Path
		import hashlib
		import importlib.util
		import types as _types

		search_roots: list[Path] = []
		try:
			this_file = Path(__file__).resolve()
			for parent in this_file.parents:
				if parent.name == "custom_nodes":
					search_roots.append(parent)
					break
		except Exception:
			pass
		try:
			cwd_custom_nodes = Path.cwd() / "custom_nodes"
			if cwd_custom_nodes.exists():
				search_roots.append(cwd_custom_nodes)
		except Exception:
			pass

		seen_roots: set[str] = set()
		for root in search_roots:
			root_key = str(root)
			if root_key in seen_roots or not root.exists():
				continue
			seen_roots.add(root_key)
			for gemma_file in root.rglob("gemma_encoder.py"):
				try:
					# 不导入自身目录下的无关文件；只要文件里确实有目标类再执行。
					text = gemma_file.read_text(encoding="utf-8", errors="ignore")
					if "LTXVGemmaCLIPModelLoader" not in text:
						continue
					package_dir = gemma_file.parent
					pkg_name = "_gjj_dynamic_ltx_gemma_" + hashlib.md5(str(package_dir).encode("utf-8")).hexdigest()
					module_name = pkg_name + ".gemma_encoder"
					if module_name in sys.modules:
						module = sys.modules[module_name]
					else:
						pkg = sys.modules.get(pkg_name)
						if pkg is None:
							pkg = _types.ModuleType(pkg_name)
							pkg.__path__ = [str(package_dir)]
							pkg.__package__ = pkg_name
							sys.modules[pkg_name] = pkg
						spec = importlib.util.spec_from_file_location(module_name, str(gemma_file))
						if spec is None or spec.loader is None:
							continue
						module = importlib.util.module_from_spec(spec)
						module.__package__ = pkg_name
						sys.modules[module_name] = module
						spec.loader.exec_module(module)
					loader_cls = getattr(module, "LTXVGemmaCLIPModelLoader", None)
					if _is_real_loader_class(loader_cls):
						return loader_cls
				except Exception:
					continue
	except Exception:
		pass

	return None

def _call_comfy_loader(loader_cls: Any, preferred_kwargs: dict[str, Any], fallback_args: tuple[Any, ...]):
	"""按 Comfy 节点 FUNCTION / execute 等方式调用，尽量兼容不同版本签名。"""
	instance = loader_cls() if isinstance(loader_cls, type) else loader_cls
	method_names: list[str] = []
	function_name = getattr(instance, "FUNCTION", None) or getattr(loader_cls, "FUNCTION", None)
	if function_name:
		method_names.append(str(function_name))
	method_names.extend(["execute", "load", "load_clip", "load_model", "loadmodel"])

	last_error: Exception | None = None
	for method_name in method_names:
		method = getattr(instance, method_name, None) or getattr(loader_cls, method_name, None)
		if method is None:
			continue
		try:
			return method(**preferred_kwargs)
		except TypeError as exc:
			last_error = exc
		except Exception as exc:
			last_error = exc
		try:
			return method(*fallback_args)
		except Exception as exc:
			last_error = exc
	if last_error is not None:
		raise last_error
	raise RuntimeError(f"无法调用加载器：{loader_cls}")


def _clip_has_missing_projection(clip: Any) -> bool:
	"""检测当前报错里出现的 text_embedding_projection 权重为空问题。"""
	try:
		cond_stage_model = getattr(clip, "cond_stage_model", None)
		projection = getattr(cond_stage_model, "text_embedding_projection", None)
		if projection is None:
			return False
		return getattr(projection, "weight", None) is None
	except Exception:
		return False


def _pick_optional_candidate(category: str, candidates: Iterable[str]) -> str:
	try:
		available = _safe_filename_list(category)
		for candidate in candidates:
			resolved = _pick_available_name(candidate, available)
			if resolved:
				return resolved
	except Exception:
		pass
	return ""



def _import_ltx_text_embeddings_pipeline():
	"""加载 gemma_encoder.py 旁边的 text_embeddings_connectors.load_text_embeddings_pipeline。

	这里不依赖 LTXVGemmaCLIPModelLoader 节点注册，只借用官方/扩展里的 connector 逻辑。
	所有导入都发生在执行阶段，继续保持零依赖顶层导入。
	"""
	# 已加载模块优先。
	for module_name, module in list(sys.modules.items()):
		if str(module_name).startswith("torch"):
			continue
		func = getattr(module, "load_text_embeddings_pipeline", None)
		if callable(func):
			return func
	# 常见包名尝试。
	for module_name in (
		"text_embeddings_connectors",
		"ltx_video.text_embeddings_connectors",
		"lightricks.text_embeddings_connectors",
	):
		try:
			module = importlib.import_module(module_name)
		except Exception:
			continue
		func = getattr(module, "load_text_embeddings_pipeline", None)
		if callable(func):
			return func
	# 最后只扫描 text_embeddings_connectors.py，不再导入 gemma_encoder.py，避免触发其错误 root 扫描。
	try:
		from pathlib import Path
		import hashlib
		import importlib.util
		import types as _types

		search_roots: list[Path] = []
		try:
			this_file = Path(__file__).resolve()
			for parent in this_file.parents:
				if parent.name == "custom_nodes":
					search_roots.append(parent)
					break
		except Exception:
			pass
		try:
			cwd_custom_nodes = Path.cwd() / "custom_nodes"
			if cwd_custom_nodes.exists():
				search_roots.append(cwd_custom_nodes)
		except Exception:
			pass

		seen_roots: set[str] = set()
		for root in search_roots:
			root_key = str(root)
			if root_key in seen_roots or not root.exists():
				continue
			seen_roots.add(root_key)
			for connector_file in root.rglob("text_embeddings_connectors.py"):
				try:
					text = connector_file.read_text(encoding="utf-8", errors="ignore")
					if "load_text_embeddings_pipeline" not in text:
						continue
					package_dir = connector_file.parent
					pkg_name = "_gjj_dynamic_ltx_connector_" + hashlib.md5(str(package_dir).encode("utf-8")).hexdigest()
					module_name = pkg_name + ".text_embeddings_connectors"
					if module_name in sys.modules:
						module = sys.modules[module_name]
					else:
						pkg = sys.modules.get(pkg_name)
						if pkg is None:
							pkg = _types.ModuleType(pkg_name)
							pkg.__path__ = [str(package_dir)]
							pkg.__package__ = pkg_name
							sys.modules[pkg_name] = pkg
						spec = importlib.util.spec_from_file_location(module_name, str(connector_file))
						if spec is None or spec.loader is None:
							continue
						module = importlib.util.module_from_spec(spec)
						module.__package__ = pkg_name
						sys.modules[module_name] = module
						spec.loader.exec_module(module)
					func = getattr(module, "load_text_embeddings_pipeline", None)
					if callable(func):
						return func
				except Exception:
					continue
	except Exception:
		pass
	raise RuntimeError("未找到 text_embeddings_connectors.load_text_embeddings_pipeline")


def _find_first_matching_dir_limited(root: Any, pattern: str) -> str:
	from pathlib import Path
	root_path = Path(root)
	if not root_path.exists():
		raise FileNotFoundError(f"目录不存在：{root_path}")
	for item in root_path.rglob("*"):
		try:
			if item.match(pattern):
				return str(item.parent)
		except Exception:
			continue
	raise FileNotFoundError(f"在 {root_path} 下未找到 {pattern}")


def _resolve_gemma_encoder_roots(gemma_path: str) -> tuple[str, str, str]:
	"""返回 tokenizer_dir, gemma_model_dir, processor_dir。

	只处理真正的 Gemma 目录模型；不会再把裸 `model.safetensors` 解析到
	models/clip 或 models/text_encoders 根目录。扁平 safetensors 模型交给
	DualCLIPLoader 处理。
	"""
	from pathlib import Path
	full = folder_paths.get_full_path("text_encoders", gemma_path) or str(gemma_path or "")
	path = Path(full)
	if not path.exists():
		raise RuntimeError(f"未找到 Gemma 文本编码器文件：{gemma_path}")

	def _is_forbidden_root(root: Path) -> bool:
		name = root.name.lower()
		# 这些目录太宽，里面可能有 faster-whisper、clip 等无关模型，不能扫描。
		if name in {"models", "text_encoders", "clip", "checkpoints", "vae"}:
			return True
		try:
			parts = {part.lower() for part in root.parts}
			# 裸 model.safetensors 常会被 ComfyUI 解析到 models/clip/model.safetensors，必须跳过。
			if "clip" in parts and root.name.lower() == "clip":
				return True
		except Exception:
			pass
		return False

	candidate_roots: list[Path] = []
	if path.is_file():
		# 标准目录模型：.../gemma_xxx/model/model.safetensors -> root = .../gemma_xxx
		if path.parent.name.lower() == "model" and path.parent.parent.exists() and not _is_forbidden_root(path.parent.parent):
			candidate_roots.append(path.parent.parent)
		# 非标准目录：.../gemma_xxx/model.safetensors -> root = .../gemma_xxx
		if not _is_forbidden_root(path.parent):
			candidate_roots.append(path.parent)
	else:
		if not _is_forbidden_root(path):
			candidate_roots.append(path)

	# 如果用户传的是扁平的 gemma_3_12B_it_fp8_e4m3fn.safetensors，通常同目录没有 tokenizer.model，
	# 这里直接失败，让外层改走 DualCLIPLoader。
	seen: set[str] = set()
	roots: list[Path] = []
	for root in candidate_roots:
		try:
			key = str(root.resolve())
		except Exception:
			key = str(root)
		if key not in seen:
			seen.add(key)
			roots.append(root)

	last_error = ""
	for root in roots:
		try:
			tokenizer_dir = _find_first_matching_dir_limited(root, "tokenizer.model")
			model_dir = _find_first_matching_dir_limited(root, "model*.safetensors")
			try:
				processor_dir = _find_first_matching_dir_limited(root, "preprocessor_config.json")
			except Exception:
				processor_dir = tokenizer_dir
			return tokenizer_dir, model_dir, processor_dir
		except Exception as exc:
			last_error = str(exc)
			continue

	if not roots:
		last_error = f"{path} 不是可扫描的 Gemma 目录模型；扁平 safetensors 应使用 DualCLIPLoader"
	raise RuntimeError(
		"无法解析 Gemma 目录结构。需要类似："
		"models/text_encoders/gemma-3-12b.../model/model.safetensors，"
		"并且同一模型目录下包含 tokenizer.model / config.json / model*.safetensors。"
		f"最后错误：{last_error}"
	)


def _load_ltx_text_encoder_with_internal_gemma(text_encoder_name: str, ckpt_name: str) -> Any:
	"""内置迁移版 LTXVGemmaCLIPModelLoader。

	来源逻辑对应用户提供的 gemma_encoder.py：
	AutoTokenizer + Gemma3ForConditionalGeneration + load_text_embeddings_pipeline + comfy.sd.CLIP。
	改动：所有依赖延迟导入；目录查找限制在当前 Gemma 模型目录内。
	"""
	try:
		from pathlib import Path
		AutoImageProcessor = importlib.import_module("transformers").AutoImageProcessor
		AutoTokenizer = importlib.import_module("transformers").AutoTokenizer
		Gemma3ForConditionalGeneration = importlib.import_module("transformers").Gemma3ForConditionalGeneration
		Gemma3Processor = importlib.import_module("transformers").Gemma3Processor
		load_text_embeddings_pipeline = _import_ltx_text_embeddings_pipeline()

		tokenizer_dir, gemma_model_dir, processor_dir = _resolve_gemma_encoder_roots(text_encoder_name)
		ltxv_full_path = folder_paths.get_full_path("diffusion_models", ckpt_name)
		if not ltxv_full_path:
			ltxv_full_path = folder_paths.get_full_path("checkpoints", ckpt_name)
		if not ltxv_full_path:
			raise RuntimeError(f"未找到 LTX 主模型：{ckpt_name}")

		class _GJJLTXVGemmaTokenizer:
			def __init__(self, embedding_directory=None, tokenizer_data=None, max_length: int = 1024):
				self.tokenizer = AutoTokenizer.from_pretrained(
					tokenizer_dir,
					local_files_only=True,
					model_max_length=max_length,
				)
				self.tokenizer.padding_side = "left"
				if self.tokenizer.pad_token is None:
					self.tokenizer.pad_token = self.tokenizer.eos_token
				self.max_length = max_length

			def tokenize_with_weights(self, text: str, return_word_ids: bool = False):
				encoded = self.tokenizer(
					str(text or "").strip(),
					padding="max_length",
					max_length=self.max_length,
					truncation=True,
					return_tensors="pt",
				)
				input_ids = encoded.input_ids
				attention_mask = encoded.attention_mask
				tuples = [
					(token_id, attn, i)
					for i, (token_id, attn) in enumerate(zip(input_ids[0], attention_mask[0]))
				]
				out = {"gemma": tuples}
				if not return_word_ids:
					out = {k: [(t, w) for t, w, _ in v] for k, v in out.items()}
				return out

		class _GJJLTXVGemmaTextEncoderModel(torch.nn.Module):
			def __init__(self, device="cpu", dtype=None, model_options=None):
				super().__init__()
				dtype = torch.bfloat16
				self.model = Gemma3ForConditionalGeneration.from_pretrained(
					gemma_model_dir,
					local_files_only=True,
					torch_dtype=dtype,
				)
				feature_extractor, embeddings_processor = load_text_embeddings_pipeline(
					ltxv_full_path,
					dtype=dtype,
					fallback_proj_path=Path(gemma_model_dir) / "proj_linear.safetensors",
				)
				self.feature_extractor = feature_extractor.to(dtype=dtype)
				self.embeddings_processor = embeddings_processor.to(dtype=dtype)
				self.processor = None
				try:
					image_processor = AutoImageProcessor.from_pretrained(str(processor_dir), local_files_only=True)
					self.processor = Gemma3Processor(
						image_processor=image_processor,
						tokenizer=_GJJLTXVGemmaTokenizer().tokenizer,
					)
				except Exception as exc:
					print(f"[GJJ LTX2.3] Gemma processor 未加载，仅影响提示词增强，不影响 CLIP 编码：{exc}")
				self.dtypes = {dtype}
				try:
					self._model_memory_required = comfy.model_management.module_size(self.model) + 256 * 1024 * 1024
				except Exception:
					self._model_memory_required = 0

			def set_clip_options(self, options):
				pass

			def reset_clip_options(self):
				pass

			def forward(self, input_ids, attention_mask, padding_side="right"):
				outputs = self.model(
					input_ids=input_ids,
					attention_mask=attention_mask,
					output_hidden_states=True,
				)
				all_layer_hiddens = torch.stack(outputs.hidden_states, dim=-1)
				return self.feature_extractor(all_layer_hiddens, attention_mask, padding_side)

			def encode_token_weights(self, token_weight_pairs):
				token_pairs = token_weight_pairs["gemma"]
				input_ids = torch.tensor([[t[0] for t in token_pairs]], device=self.model.device)
				attention_mask = torch.tensor([[w[1] for w in token_pairs]], device=self.model.device)
				self.to(self.model.device)
				features = self(input_ids, attention_mask, padding_side="left")
				encoded_input_dtype = next(iter(features.values())).dtype
				connector_attention_mask = (attention_mask - 1).to(encoded_input_dtype).reshape(
					(attention_mask.shape[0], 1, -1, attention_mask.shape[-1])
				) * torch.finfo(encoded_input_dtype).max
				encoded, mask = self.embeddings_processor.create_embeddings(features, connector_attention_mask)
				return encoded, None, {"attention_mask": mask}

			def load_sd(self, sd):
				return self.model.load_state_dict(sd, strict=False)

			def memory_required(self, input_shape):
				return self._model_memory_required

		clip_target = comfy.supported_models_base.ClipTarget(
			tokenizer=lambda embedding_directory=None, tokenizer_data=None: _GJJLTXVGemmaTokenizer(max_length=1024),
			clip=_GJJLTXVGemmaTextEncoderModel,
		)
		clip = comfy.sd.CLIP(clip_target)
		print(f"[GJJ LTX2.3] 已使用内置迁移版 LTXVGemmaCLIPModelLoader：{text_encoder_name}")
		return clip
	except Exception as exc:
		raise RuntimeError(f"内置 LTXVGemmaCLIPModelLoader：{exc}") from exc

def _load_ltx_text_encoder_with_dual_clip(text_encoder_name: str) -> Any:
	"""按参考工作流优先使用 DualCLIPLoader：Gemma 主体 + LTX 文本投影。"""
	try:
		core_nodes = importlib.import_module("nodes")
		dual_cls = getattr(core_nodes, "DualCLIPLoader", None)
		if dual_cls is None:
			raise RuntimeError("当前 ComfyUI 没有 DualCLIPLoader")
		projection_name = _pick_optional_candidate(
			"text_encoders",
			(
				"ltx-2.3_text_projection_bf16.safetensors",
				"ltx2.3_text_projection_bf16.safetensors",
				"text_projection_bf16",
			),
		)
		if not projection_name:
			raise RuntimeError("未找到 ltx-2.3_text_projection_bf16.safetensors")
		loader = dual_cls() if isinstance(dual_cls, type) else dual_cls
		method = getattr(loader, "load_clip", None) or getattr(loader, "load", None) or getattr(loader, "execute", None)
		if method is None:
			function_name = getattr(loader, "FUNCTION", None) or getattr(dual_cls, "FUNCTION", None)
			method = getattr(loader, str(function_name), None) if function_name else None
		if method is None:
			raise RuntimeError("无法调用 DualCLIPLoader")
		try:
			result = method(text_encoder_name, projection_name, "ltxv", "default")
		except TypeError:
			result = method(clip_name1=text_encoder_name, clip_name2=projection_name, type="ltxv", device="default")
		clip = result[0] if isinstance(result, (tuple, list)) else result
		if clip is None:
			raise RuntimeError("DualCLIPLoader 返回空 CLIP")
		return clip
	except Exception as exc:
		raise RuntimeError(f"DualCLIPLoader：{exc}") from exc


def _load_ltx_text_encoder(text_encoder_name: str, ckpt_name: str):
	print(f"[GJJ LTX2.3] runtime patch: {GJJ_LTX23_RUNTIME_PATCH_VERSION}")
	_ensure_runtime_dependencies()
	"""加载 LTX-2.3 Gemma 文本编码器。

	规则：
	- 目录型 Gemma 模型（带 tokenizer.model）优先用内置迁移版 LTXVGemmaCLIPModelLoader。
	- 扁平 safetensors（参考工作流的 gemma_3_12B_it_fp8...）优先用 DualCLIPLoader。
	- 不再让裸 model.safetensors 抢先命中 models/clip/model.safetensors。
	"""
	attempt_errors: list[str] = []

	def _try_dual(name: str) -> Any | None:
		try:
			clip = _load_ltx_text_encoder_with_dual_clip(name)
			if clip is not None:
				# 参考工作流的 DualCLIPLoader 返回的 LTXV CLIP 会在真正 encode/load_model 时
				# 懒加载/绑定投影层。这里不能像旧 LTXAVTextEncoderLoader 一样提前检查
				# text_embedding_projection.weight，否则会把官方工作流可用的 CLIP 误判为无效。
				print(f"[GJJ LTX2.3] 已使用 DualCLIPLoader：{name}（已跳过投影层预检查）")
				return clip
			attempt_errors.append(f"DualCLIPLoader({name}) 返回空 CLIP")
		except Exception as exc:
			attempt_errors.append(str(exc))
		return None

	def _try_internal(name: str) -> Any | None:
		try:
			clip = _load_ltx_text_encoder_with_internal_gemma(name, ckpt_name)
			if clip is not None and not _clip_has_missing_projection(clip):
				return clip
			attempt_errors.append(f"内置 LTXVGemmaCLIPModelLoader({name}) 返回的 CLIP 无效或投影层为空")
		except Exception as exc:
			attempt_errors.append(f"{exc}")
		return None

	# 1) 如果当前选择的是参考工作流的扁平 Gemma safetensors，先走 DualCLIPLoader。
	lower_name = str(text_encoder_name or "").lower().replace("\\", "/")
	is_flat_safetensors = lower_name.endswith(".safetensors") and "/" not in lower_name and "model.safetensors" not in lower_name
	if is_flat_safetensors:
		clip = _try_dual(text_encoder_name)
		if clip is not None:
			return clip

	# 2) 尝试目录型 Gemma。只放明确目录结构候选，不再放裸 model.safetensors。
	internal_candidates: list[str] = []
	for candidate in (
		text_encoder_name,
		"gemma-3-12b-it-qat-q4_0-unquantized_readout_proj/model/model.safetensors",
		"gemma-3-12b-it-qat-q4_0-unquantized_readout_proj",
	):
		if not candidate or candidate in internal_candidates:
			continue
		if candidate == "model.safetensors":
			continue
		resolved = _pick_optional_candidate("text_encoders", (candidate,)) if candidate != text_encoder_name else candidate
		if resolved and resolved not in internal_candidates and resolved != "model.safetensors":
			internal_candidates.append(resolved)

	for candidate in internal_candidates:
		clip = _try_internal(candidate)
		if clip is not None:
			return clip

	# 3) 如果前面不是扁平模型，或者 Dual 第一次失败，再用当前选择重试 Dual。
	if not is_flat_safetensors:
		clip = _try_dual(text_encoder_name)
		if clip is not None:
			return clip

	# 4) 最后才走旧加载器。旧加载器在部分 LTX2.3 模型上会 invalid tokenizer 或投影层为空。
	try:
		clip = LTXAVTextEncoderLoader.execute(text_encoder_name, ckpt_name, "default")[0]
		if clip is not None and not _clip_has_missing_projection(clip):
			return clip
		attempt_errors.append("LTXAVTextEncoderLoader 返回的 CLIP 投影层为空")
	except Exception as exc:
		attempt_errors.append(f"LTXAVTextEncoderLoader：{exc}")

	raise RuntimeError("LTX 文本编码器加载失败：" + "；".join(attempt_errors[-10:]))

def _round_to_multiple(value: float, step: int, minimum: int) -> int:
	rounded = int(round(float(value) / float(step)) * step)
	return max(int(minimum), rounded)


def _ceil_to_multiple(value: float, step: int, minimum: int) -> int:
	rounded = int(math.ceil(float(value) / float(step)) * step)
	return max(int(minimum), rounded)


def _ensure_image_batch(image: torch.Tensor) -> torch.Tensor:
	if image is None:
		raise RuntimeError("未提供输入图像。")
	if image.ndim == 3:
		return image.unsqueeze(0)
	if image.ndim == 4:
		return image
	raise RuntimeError(f"无法识别的图像张量维度：{tuple(image.shape)}")


def _resize_preserve_aspect_to_long_edge(image: torch.Tensor, long_edge: int) -> tuple[torch.Tensor, int, int]:
	image = _ensure_image_batch(image)[:1]
	height = int(image.shape[1])
	width = int(image.shape[2])
	if height <= 0 or width <= 0:
		raise RuntimeError("输入图像尺寸无效。")

	if width >= height:
		target_width = int(long_edge)
		target_height = max(64, round(height * (target_width / width)))
	else:
		target_height = int(long_edge)
		target_width = max(64, round(width * (target_height / height)))

	target_width = _round_to_multiple(target_width, 32, 64)
	target_height = _round_to_multiple(target_height, 32, 64)

	resized = comfy.utils.common_upscale(
		image.movedim(-1, 1),
		target_width,
		target_height,
		"lanczos",
		"center",
	).movedim(1, -1)
	return resized.contiguous(), target_width, target_height


def _resize_preserve_native_frame_size(image: torch.Tensor) -> tuple[torch.Tensor, int, int]:
	image = _ensure_image_batch(image)[:1]
	height = int(image.shape[1])
	width = int(image.shape[2])
	if height <= 0 or width <= 0:
		raise RuntimeError("输入图像尺寸无效。")

	target_width = _ceil_to_multiple(width, 32, 64)
	target_height = _ceil_to_multiple(height, 32, 64)
	if target_width == width and target_height == height:
		return image.contiguous(), target_width, target_height

	pad_left = max(0, (target_width - width) // 2)
	pad_right = max(0, target_width - width - pad_left)
	pad_top = max(0, (target_height - height) // 2)
	pad_bottom = max(0, target_height - height - pad_top)
	padded = F.pad(
		image.movedim(-1, 1),
		(pad_left, pad_right, pad_top, pad_bottom),
		mode="replicate",
	).movedim(1, -1)
	return padded.contiguous(), target_width, target_height


def _resolve_stage1_sample_size(output_width: int, output_height: int, sample_long_edge: int | None = None) -> tuple[int, int]:
	output_width = max(64, int(output_width))
	output_height = max(64, int(output_height))
	if sample_long_edge is not None and int(sample_long_edge) > 0:
		scale = min(1.0, float(sample_long_edge) / float(max(output_width, output_height)))
	else:
		scale = 1.0 / float(DEFAULT_STAGE2_UPSCALE_FACTOR)
	sample_width = _ceil_to_multiple(output_width * scale, 32, 64)
	sample_height = _ceil_to_multiple(output_height * scale, 32, 64)
	return sample_width, sample_height


def _resize_guide_to_size(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
	image = _ensure_image_batch(image)[:1]
	target_width = max(1, int(width))
	target_height = max(1, int(height))
	current_height = int(image.shape[1])
	current_width = int(image.shape[2])
	if current_width <= 0 or current_height <= 0:
		return image.contiguous()
	if current_width == target_width and current_height == target_height:
		return image.contiguous()

	# 安全网：保持比例缩放到目标画幅内，再居中补边，避免 guide 图被强行拉伸。
	scale = min(float(target_width) / float(current_width), float(target_height) / float(current_height))
	resized_width = max(1, int(round(float(current_width) * scale)))
	resized_height = max(1, int(round(float(current_height) * scale)))
	resized = comfy.utils.common_upscale(
		image.movedim(-1, 1),
		resized_width,
		resized_height,
		"lanczos",
		"disabled",
	)
	pad_left = max(0, (target_width - resized_width) // 2)
	pad_right = max(0, target_width - resized_width - pad_left)
	pad_top = max(0, (target_height - resized_height) // 2)
	pad_bottom = max(0, target_height - resized_height - pad_top)
	if pad_left or pad_right or pad_top or pad_bottom:
		resized = F.pad(resized, (pad_left, pad_right, pad_top, pad_bottom), mode="replicate")
	return resized.movedim(1, -1)[:, :target_height, :target_width, :].contiguous()


def _call_node_with_fallback(node_obj: Any, method_names: tuple[str, ...], *args):
	last_error = None
	candidates = []
	if node_obj is None:
		raise RuntimeError("目标节点未加载")
	candidates.append(node_obj)
	if inspect.isclass(node_obj):
		try:
			candidates.append(node_obj())
		except Exception:
			pass
	for candidate in candidates:
		for method_name in method_names:
			func = getattr(candidate, method_name, None)
			if callable(func):
				try:
					return func(*args)
				except Exception as exc:
					last_error = exc
	if last_error is not None:
		raise last_error
	raise RuntimeError(f"无法调用节点：{getattr(node_obj, '__name__', type(node_obj).__name__)}")


def _ltx_preprocess_image(image: torch.Tensor | None, compression: int = WORKFLOW_FIRST_LAST_IMG_COMPRESSION) -> torch.Tensor | None:
	if image is None:
		return None
	batch = _ensure_image_batch(image)[:1]
	if LTXVPreprocess is None:
		return batch
	try:
		result = _call_node_with_fallback(LTXVPreprocess, ("execute", "preprocess"), batch, int(compression))
		if isinstance(result, (tuple, list)) and result:
			return _ensure_image_batch(result[0])[:1]
		return _ensure_image_batch(result)[:1]
	except Exception:
		return batch


def _find_node_class_by_name(class_name: str):
	"""从已加载模块 / NODE_CLASS_MAPPINGS 中寻找真实自定义节点类。"""
	try:
		for module in list(sys.modules.values()):
			if module is None:
				continue
			mapping = getattr(module, "NODE_CLASS_MAPPINGS", None)
			if isinstance(mapping, dict) and class_name in mapping:
				return mapping[class_name]
	except Exception:
		pass
	try:
		for module_name in (
			"GJJ",
			"custom_nodes.GJJ",
			"GJJ.nodes",
			"custom_nodes.GJJ.nodes",
		):
			try:
				module = importlib.import_module(module_name)
				mapping = getattr(module, "NODE_CLASS_MAPPINGS", None)
				if isinstance(mapping, dict) and class_name in mapping:
					return mapping[class_name]
			except Exception:
				pass
	except Exception:
		pass
	try:
		for module in list(sys.modules.values()):
			if module is None:
				continue
			obj = getattr(module, class_name, None)
			if inspect.isclass(obj):
				return obj
	except Exception:
		pass
	return None


def _call_real_comfy_node(node_class: Any, **kwargs):
	"""按节点 FUNCTION 调用真实 ComfyUI 节点；自动过滤不支持的参数。"""
	if node_class is None:
		raise RuntimeError("node_class is None")
	instance = node_class() if inspect.isclass(node_class) else node_class
	func_name = getattr(instance, "FUNCTION", None) or getattr(node_class, "FUNCTION", None)
	method_candidates = []
	if func_name:
		method_candidates.append(str(func_name))
	method_candidates.extend(["execute", "run", "process", "apply", "generate", "forward"])
	last_error = None
	for name in dict.fromkeys(method_candidates):
		func = getattr(instance, name, None)
		if not callable(func):
			continue
		try:
			sig = inspect.signature(func)
			accepted = {}
			has_var_kwargs = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
			for key, value in kwargs.items():
				if has_var_kwargs or key in sig.parameters:
					accepted[key] = value
			return func(**accepted)
		except TypeError as exc:
			last_error = exc
			# 再试一次按常见顺序位置参数。
			try:
				order = [
					"model", "nag_cond_video", "nag_cond_audio", "nag_scale", "nag_alpha", "nag_tau", "inplace",
					"vae", "latent", "positive", "negative", "image_01", "image_02", "image_03",
					"guide_config_json", "image_names_json",
				]
				args = [kwargs[k] for k in order if k in kwargs]
				return func(*args)
			except Exception as exc2:
				last_error = exc2
		except Exception as exc:
			last_error = exc
	if last_error is not None:
		raise last_error
	raise RuntimeError(f"无法调用真实节点 {node_class}")


def _apply_real_gjj_ltx_first_last_frame(
	*,
	video_vae: Any,
	latent: dict[str, Any],
	positive: Any,
	negative: Any,
	main_image: torch.Tensor | None,
	guide_images: Iterable[torch.Tensor | None],
) -> tuple[Any, Any, dict[str, Any], bool]:
	"""优先调用用户本地真实 GJJ_LTX_FirstLastFrame 节点，失败则返回原 latent。"""
	node_class = _find_node_class_by_name("GJJ_LTX_FirstLastFrame")
	if node_class is None:
		print("[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] real node not found, fallback to internal injection.", flush=True)
		return positive, negative, latent, False
	images = [img for img in list(guide_images or []) if img is not None]
	image_01 = _ltx_preprocess_image(main_image) if main_image is not None else None
	image_02 = _ltx_preprocess_image(images[0]) if images else None
	config = json.dumps([{"frame": 0, "strength": 0.7}, {"frame": -1, "strength": 0.7}], ensure_ascii=False)
	try:
		result = _call_real_comfy_node(
			node_class,
			vae=video_vae,
			latent=latent,
			positive=positive,
			negative=negative,
			image_01=image_01,
			image_02=image_02,
			image_03=None,
			guide_config_json=config,
			image_names_json="",
		)
		if not isinstance(result, (tuple, list)):
			result = (result,)
		out_positive = positive
		out_negative = negative
		out_latent = latent
		# 源工作流只连接第 3 个输出“视频潜空间”；前两个 conditioning 输出未接。
		if len(result) >= 3 and isinstance(result[2], dict):
			out_latent = result[2]
		elif len(result) >= 1 and isinstance(result[0], dict):
			out_latent = result[0]
		if len(result) >= 1 and not isinstance(result[0], dict):
			out_positive = result[0]
		if len(result) >= 2 and not isinstance(result[1], dict):
			out_negative = result[1]
		print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] REAL node called: class={node_class.__name__ if hasattr(node_class, '__name__') else node_class}; result_len={len(result)}; latent={_debug_tensor_info(out_latent)}", flush=True)
		return out_positive, out_negative, out_latent, True
	except Exception as exc:
		print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] REAL node call failed, fallback to internal injection: {exc}", flush=True)
		return positive, negative, latent, False


def _apply_real_gjj_ltx2nag(
	*,
	model: Any,
	positive: Any,
	negative: Any,
	nag_scale: float,
	nag_alpha: float,
	nag_tau: float,
	inplace: bool = True,
) -> tuple[Any, bool]:
	"""优先调用用户本地真实 GJJ_LTX2NAG 节点，失败再用内部 patch。"""
	node_class = _find_node_class_by_name("GJJ_LTX2NAG")
	if node_class is None:
		print("[GJJ LTX2.3 Clean v40][GJJ_LTX2NAG] real node not found, fallback to internal patch.", flush=True)
		return model, False
	try:
		result = _call_real_comfy_node(
			node_class,
			model=model,
			nag_cond_video=positive,
			nag_cond_audio=negative,
			nag_scale=float(nag_scale),
			nag_alpha=float(nag_alpha),
			nag_tau=float(nag_tau),
			inplace=bool(inplace),
		)
		if isinstance(result, (tuple, list)) and result:
			out_model = result[0]
		else:
			out_model = result
		print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX2NAG] REAL node called: class={node_class.__name__ if hasattr(node_class, '__name__') else node_class}; output_model_type={type(out_model).__name__}", flush=True)
		return out_model, True
	except Exception as exc:
		print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX2NAG] REAL node call failed, fallback to internal patch: {exc}", flush=True)
		return model, False


def _build_first_last_reference_guides(
	main_image: torch.Tensor | None,
	guide_images: Iterable[torch.Tensor | None],
	total_duration_seconds: float,
	fps: int,
	output_frame_count: int,
) -> list[tuple[torch.Tensor, float, float]]:
	items: list[tuple[torch.Tensor, float, float]] = []
	main = _ltx_preprocess_image(main_image)
	if main is not None:
		items.append((main, 0.0, float(WORKFLOW_FIRST_LAST_GUIDE_STRENGTH)))
	# 关键修正：源工作流是 frame=-1，不是 seconds=duration。
	# 这里改成最后一帧对应的秒数 (frame_count-1)/fps，避免尾帧越界被跳过。
	# Clean v40：严格复刻 GJJ_LTX_FirstLastFrame 的 frame=-1。
	# 之前为了避免 seconds=duration 越界，做了 duration-1/fps，结果 241 帧时会落到 frame 239，
	# 再除以 LTX 时间压缩因子后注入到 latent index 29，而不是最后一个 latent index 30。
	# 这里必须直接使用最后一帧：(output_frame_count - 1) / fps。
	last_frame_seconds = max(0.0, (max(1, int(output_frame_count)) - 1) / max(1, int(fps)))
	for image in list(guide_images or []):
		if image is None:
			continue
		guide = _ltx_preprocess_image(image)
		if guide is not None:
			items.append((guide, float(last_frame_seconds), float(WORKFLOW_FIRST_LAST_GUIDE_STRENGTH)))
		break
	return items


def _apply_img_to_video_inplace_exact(
	*,
	video_vae: Any,
	latent: dict[str, Any],
	anchor_image: torch.Tensor | None,
	strength: float = WORKFLOW_FIRST_LAST_INPLACE_STRENGTH,
) -> dict[str, Any]:
	if anchor_image is None:
		return latent
	image = _ltx_preprocess_image(anchor_image)
	if image is None:
		return latent
	if LTXVImgToVideoInplace is not None:
		for methods in (("execute", "img_to_video_inplace", "run"), ("execute",)):
			try:
				result = _call_node_with_fallback(LTXVImgToVideoInplace, methods, video_vae, image, latent, float(strength), False)
				if isinstance(result, (tuple, list)) and result:
					return result[0]
				if isinstance(result, dict):
					return result
			except Exception:
				pass
	fallback_guides = [(image, 0.0, float(strength))]
	latent2, _ = _inject_ltxv_images_inplace(
		video_vae=video_vae,
		latent=latent,
		reference_guides=fallback_guides,
		fps=1,
		output_frame_count=max(1, int(latent.get("samples").shape[2]) if isinstance(latent, dict) and isinstance(latent.get("samples"), torch.Tensor) else 1),
		trim_start=0,
	)
	return latent2


def _build_latent_inplace_guides(
	main_image: torch.Tensor | None,
	guide_images: Iterable[torch.Tensor | None],
	guide_times: Iterable[float],
	guide_strengths: Iterable[float] | None,
) -> list[tuple[torch.Tensor, float, float]]:
	items: list[tuple[torch.Tensor, float, float]] = []
	if main_image is not None:
		items.append((main_image, 0.0, 1.0))
	strength_values = list(guide_strengths or [])
	for index, (image, seconds) in enumerate(zip(list(guide_images or []), list(guide_times or []))):
		if image is None:
			continue
		strength = _clamp_float(strength_values[index] if index < len(strength_values) else 1.0, 1.0, 0.0, 1.0)
		items.append((image, float(seconds), strength))
	items.sort(key=lambda item: float(item[1]))
	return items


def _inject_ltxv_images_inplace(
	*,
	video_vae: Any,
	latent: dict[str, Any],
	reference_guides: Iterable[tuple[torch.Tensor, float, float]],
	fps: int,
	output_frame_count: int,
	trim_start: int,
) -> tuple[dict[str, Any], int]:
	if not isinstance(latent, dict) or "samples" not in latent:
		return latent, 0
	samples = latent["samples"].clone()
	if samples.ndim != 5:
		return latent, 0

	scale_factors = getattr(video_vae, "downscale_index_formula", None)
	if not scale_factors or len(scale_factors) < 3:
		return latent, 0
	time_scale_factor = max(1, int(scale_factors[0] or 1))
	height_scale_factor = max(1, int(scale_factors[1] or 1))
	width_scale_factor = max(1, int(scale_factors[2] or 1))

	batch, _, latent_frames, latent_height, latent_width = samples.shape
	target_width = int(latent_width) * width_scale_factor
	target_height = int(latent_height) * height_scale_factor
	if "noise_mask" in latent and isinstance(latent["noise_mask"], torch.Tensor):
		conditioning_mask = latent["noise_mask"].clone().to(device=samples.device)
	else:
		conditioning_mask = None
	if conditioning_mask is None or conditioning_mask.ndim != 5 or int(conditioning_mask.shape[2]) != int(latent_frames):
		conditioning_mask = torch.ones(
			(int(batch), 1, int(latent_frames), 1, 1),
			dtype=torch.float32,
			device=samples.device,
		)

	injected_count = 0
	pixel_frame_count = (int(latent_frames) - 1) * time_scale_factor + 1
	for image, seconds, strength in list(reference_guides or []):
		if image is None:
			continue
		try:
			source = _ensure_image_batch(image)[:1]
			if int(source.shape[1]) != target_height or int(source.shape[2]) != target_width:
				pixels = comfy.utils.common_upscale(
					source.movedim(-1, 1),
					target_width,
					target_height,
					"bilinear",
					"center",
				).movedim(1, -1)
			else:
				pixels = source
			encoded = video_vae.encode(pixels[:, :, :, :3]).to(device=samples.device, dtype=samples.dtype)
			if encoded.ndim != 5 or int(encoded.shape[2]) <= 0:
				continue
			if int(encoded.shape[0]) != int(batch):
				if int(encoded.shape[0]) == 1 and int(batch) > 1:
					encoded = encoded.repeat(int(batch), 1, 1, 1, 1)
				else:
					encoded = encoded[: int(batch)]

			frame_index = _guide_frame_index(seconds, fps, output_frame_count, trim_start)
			frame_index = max(0, min(int(pixel_frame_count) - 1, int(frame_index)))
			latent_index = max(0, min(frame_index // time_scale_factor, int(latent_frames) - 1))
			end_index = min(latent_index + int(encoded.shape[2]), int(latent_frames))
			if end_index <= latent_index:
				continue
			span = end_index - latent_index
			samples[:, :, latent_index:end_index] = encoded[:, :, :span]
			conditioning_mask[:, :, latent_index:end_index] = 1.0 - _clamp_float(strength, 1.0, 0.0, 1.0)
			injected_count += 1
		except Exception:
			continue

	if injected_count <= 0:
		return latent, 0
	updated = dict(latent)
	updated["samples"] = samples.contiguous()
	updated["noise_mask"] = conditioning_mask.contiguous()
	return updated, injected_count


def _audio_waveform_and_rate(audio: dict[str, Any]) -> tuple[torch.Tensor, int]:
	if not isinstance(audio, dict):
		raise RuntimeError("输入音频格式无效。")
	waveform = audio.get("waveform")
	sample_rate = int(audio.get("sample_rate", 0) or 0)
	if waveform is None or sample_rate <= 0:
		raise RuntimeError("输入音频缺少 waveform 或 sample_rate。")
	if waveform.ndim == 1:
		waveform = waveform.unsqueeze(0).unsqueeze(0)
	elif waveform.ndim == 2:
		waveform = waveform.unsqueeze(0)
	elif waveform.ndim != 3:
		raise RuntimeError(f"无法识别的音频张量维度：{tuple(waveform.shape)}")
	return waveform, sample_rate


def _trim_audio(audio: dict[str, Any], start_seconds: float = DEFAULT_AUDIO_START_SECONDS, max_seconds: float = DEFAULT_AUDIO_MAX_SECONDS) -> dict[str, Any]:
	waveform, sample_rate = _audio_waveform_and_rate(audio)
	total_samples = int(waveform.shape[-1])
	start_sample = max(0, int(round(float(start_seconds) * sample_rate)))
	if start_sample >= total_samples:
		raise RuntimeError("音频起始时间超出音频总长度。")

	end_sample = total_samples
	if max_seconds and max_seconds > 0:
		end_sample = min(total_samples, start_sample + int(round(float(max_seconds) * sample_rate)))
	trimmed = waveform[..., start_sample:end_sample].contiguous()
	if trimmed.shape[-1] <= 0:
		raise RuntimeError("裁切后的音频为空。")
	result = dict(audio)
	result["waveform"] = trimmed
	result["sample_rate"] = sample_rate
	return result


def _normalize_audio_rms(audio: dict[str, Any], target_db: float = DEFAULT_AUDIO_TARGET_DB) -> dict[str, Any]:
	waveform, sample_rate = _audio_waveform_and_rate(audio)
	rms = waveform.pow(2).mean(dim=-1, keepdim=True).sqrt().clamp(min=1e-8)
	current_db = 20.0 * torch.log10(rms)
	gain = torch.pow(10.0, (float(target_db) - current_db) / 20.0)
	normalized = waveform * gain
	peak = normalized.abs().amax(dim=-1, keepdim=True).clamp(min=1.0)
	normalized = (normalized / peak).contiguous()

	result = dict(audio)
	result["waveform"] = normalized
	result["sample_rate"] = sample_rate
	return result


def _audio_duration_seconds(audio: dict[str, Any]) -> float:
	waveform, sample_rate = _audio_waveform_and_rate(audio)
	return float(waveform.shape[-1]) / float(sample_rate)


def _requested_frame_count(seconds: float, fps: int) -> int:
	return max(1, int(round(max(0.0, float(seconds)) * float(max(1, int(fps))))) + 1)


def _ltx_internal_frame_count(output_frame_count: int, trim_start: int = 0) -> int:
	needed = max(1, int(output_frame_count) + max(0, int(trim_start)))
	if needed <= 1:
		return 1
	return int(math.ceil(float(needed - 1) / 8.0) * 8 + 1)


def _guide_frame_index(seconds: float, fps: int, output_frame_count: int, trim_start: int = 0) -> int:
	last_output_index = max(0, int(output_frame_count) - 1)
	index = int(round(max(0.0, float(seconds)) * float(max(1, int(fps)))))
	index = max(0, min(last_output_index, index))
	return index + max(0, int(trim_start))


def _set_audio_latent_noise_mask(audio_latent: dict[str, Any], value: float = 0.0) -> dict[str, Any]:
	samples = audio_latent["samples"]
	mask = torch.full(
		(int(samples.shape[0]), 1, int(samples.shape[-2]), int(samples.shape[-1])),
		float(value),
		dtype=samples.dtype,
		device=samples.device,
	)
	updated = dict(audio_latent)
	updated["noise_mask"] = mask
	return updated


def _slice_output_frames(frames: torch.Tensor, start_index: int, frame_count: int) -> torch.Tensor:
	frames = _ensure_image_batch(frames)
	total = int(frames.shape[0])
	if total <= 0:
		raise RuntimeError("VAE 未解码出任何视频帧。")
	start_index = max(0, int(start_index))
	frame_count = max(1, int(frame_count))
	if start_index >= total:
		start_index = max(0, total - frame_count)
	end_index = min(total, start_index + frame_count)
	sliced = frames[start_index:end_index].contiguous()
	if int(sliced.shape[0]) <= 0:
		raise RuntimeError("裁切输出视频帧后为空。")
	return sliced



def _resize_frames_to_size(frames: torch.Tensor, width: int, height: int) -> torch.Tensor:
	if not isinstance(frames, torch.Tensor) or frames.ndim != 4:
		return frames
	target_width = max(1, int(width))
	target_height = max(1, int(height))
	if int(frames.shape[2]) == target_width and int(frames.shape[1]) == target_height:
		return frames
	resized = F.interpolate(
		frames.movedim(-1, 1),
		size=(target_height, target_width),
		mode="bilinear",
		align_corners=False,
	).movedim(1, -1)
	return resized.clamp(0.0, 1.0).contiguous()


def _crop_frames_to_size(frames: torch.Tensor, width: int, height: int) -> torch.Tensor:
	frames = _ensure_image_batch(frames)
	target_width = max(1, int(width))
	target_height = max(1, int(height))
	current_height = int(frames.shape[1])
	current_width = int(frames.shape[2])
	if current_width == target_width and current_height == target_height:
		return frames.contiguous()
	if target_width > current_width or target_height > current_height:
		resized = comfy.utils.common_upscale(
			frames.movedim(-1, 1),
			target_width,
			target_height,
			"lanczos",
			"center",
		).movedim(1, -1)
		return resized.contiguous()

	left = max(0, (current_width - target_width) // 2)
	top = max(0, (current_height - target_height) // 2)
	right = left + target_width
	bottom = top + target_height
	return frames[:, top:bottom, left:right, :].contiguous()


def _guide_output_frame_index(seconds: float, fps: int, output_frame_count: int) -> int:
	last_output_index = max(0, int(output_frame_count) - 1)
	index = int(round(max(0.0, float(seconds)) * float(max(1, int(fps)))))
	return max(0, min(last_output_index, index))


def _stamp_original_guide_frames(
	frames: torch.Tensor,
	main_image: torch.Tensor | None,
	guide_images: Iterable[torch.Tensor | None],
	guide_times: Iterable[float],
	fps: int,
	width: int,
	height: int,
) -> torch.Tensor:
	frames = _ensure_image_batch(frames).clone()
	output_frame_count = int(frames.shape[0])
	entries: list[tuple[torch.Tensor | None, float]] = []
	if main_image is not None:
		entries.append((main_image, 0.0))
	entries.extend(zip(list(guide_images or []), list(guide_times or [])))
	for image, seconds in entries:
		if image is None:
			continue
		try:
			source = _resize_guide_to_size(image, int(width), int(height))[0]
		except Exception:
			continue
		frame_index = _guide_output_frame_index(seconds, fps, output_frame_count)
		frames[frame_index] = source.to(device=frames.device, dtype=frames.dtype)
	return frames.contiguous()


def _maybe_purge_vram() -> None:
	try:
		comfy.model_management.soft_empty_cache()
	except Exception:
		pass


def _aggressive_purge_runtime() -> None:
	try:
		cleanup_models = getattr(comfy.model_management, "cleanup_models", None)
		if callable(cleanup_models):
			cleanup_models()
	except Exception:
		pass
	try:
		unload_all_models = getattr(comfy.model_management, "unload_all_models", None)
		if callable(unload_all_models):
			unload_all_models()
	except Exception:
		pass
	try:
		gc.collect()
	except Exception:
		pass
	try:
		if torch.cuda.is_available():
			torch.cuda.empty_cache()
			torch.cuda.ipc_collect()
	except Exception:
		pass
	_maybe_purge_vram()


@contextmanager
def _fp16_accumulation(enabled: bool = True):
	backend = getattr(getattr(torch.backends, "cuda", None), "matmul", None)
	previous = getattr(backend, "allow_fp16_accumulation", None)
	if not enabled or previous is None:
		yield
		return
	backend.allow_fp16_accumulation = True
	try:
		yield
	finally:
		backend.allow_fp16_accumulation = previous


def _compute_attention(self, query, context, attn_precision=None, transformer_options=None):
	transformer_options = transformer_options or {}
	key = self.k_norm(self.to_k(context)).to(query.dtype)
	value = self.to_v(context).to(query.dtype)
	result = comfy.ldm.modules.attention.optimized_attention(
		query,
		key,
		value,
		heads=self.heads,
		attn_precision=attn_precision,
		transformer_options=transformer_options,
	).flatten(2)
	del key, value
	return result


def _nag_attention(self, query, context_positive, nag_context, attn_precision=None, transformer_options=None):
	transformer_options = transformer_options or {}
	positive = _compute_attention(self, query, context_positive, attn_precision, transformer_options)
	negative = _compute_attention(self, query, nag_context, attn_precision, transformer_options)
	return positive, negative


def _normalized_attention_guidance(self, x_positive, x_negative):
	if self.inplace:
		nag_guidance = x_negative.mul_(self.nag_scale - 1).neg_().add_(x_positive, alpha=self.nag_scale)
	else:
		nag_guidance = x_positive * self.nag_scale - x_negative * (self.nag_scale - 1)

	del x_negative

	norm_positive = torch.norm(x_positive, p=1, dim=-1, keepdim=True)
	norm_guidance = torch.norm(nag_guidance, p=1, dim=-1, keepdim=True)

	scale = norm_guidance / norm_positive
	torch.nan_to_num_(scale, nan=10.0)
	mask = scale > self.nag_tau
	del scale

	adjustment = (norm_positive * self.nag_tau) / (norm_guidance + 1e-7)
	del norm_positive, norm_guidance

	nag_guidance.mul_(torch.where(mask, adjustment, 1.0))
	del mask, adjustment

	if self.inplace:
		nag_guidance.sub_(x_positive).mul_(self.nag_alpha).add_(x_positive)
	else:
		nag_guidance = nag_guidance * self.nag_alpha + x_positive * (1 - self.nag_alpha)
	del x_positive

	return nag_guidance


def _ltxv_crossattn_forward_nag(self, x, context, mask=None, transformer_options=None, **kwargs):
	transformer_options = transformer_options or {}

	if context.shape[0] == 1:
		x_pos, context_pos = x, context
		x_neg = context_neg = None
	else:
		x_pos, x_neg = torch.chunk(x, 2, dim=0)
		context_pos, context_neg = torch.chunk(context, 2, dim=0)

	query_positive = self.q_norm(self.to_q(x_pos))
	del x_pos

	x_positive, x_negative = _nag_attention(
		self,
		query_positive,
		context_pos,
		self.nag_context,
		attn_precision=self.attn_precision,
		transformer_options=transformer_options,
	)
	del context_pos, query_positive

	x_pos_out = _normalized_attention_guidance(self, x_positive, x_negative)
	del x_positive, x_negative

	if x_neg is not None and context_neg is not None:
		query_negative = self.q_norm(self.to_q(x_neg))
		key_negative = self.k_norm(self.to_k(context_neg))
		value_negative = self.to_v(context_neg)
		x_neg_out = comfy.ldm.modules.attention.optimized_attention(
			query_negative,
			key_negative,
			value_negative,
			heads=self.heads,
			attn_precision=self.attn_precision,
			transformer_options=transformer_options,
		)
		out = torch.cat([x_pos_out, x_neg_out], dim=0)
	else:
		out = x_pos_out

	if self.to_gate_logits is not None:
		gate_logits = self.to_gate_logits(x)
		batch, tokens, _ = out.shape
		out = out.view(batch, tokens, self.heads, self.dim_head)
		gates = 2.0 * torch.sigmoid(gate_logits)
		out = out * gates.unsqueeze(-1)
		out = out.view(batch, tokens, self.heads * self.dim_head)

	return self.to_out(out)


class _LTXVCrossAttentionPatch:
	def __init__(self, context, nag_scale: float, nag_alpha: float, nag_tau: float, inplace: bool = True):
		self.nag_context = context
		self.nag_scale = float(nag_scale)
		self.nag_alpha = float(nag_alpha)
		self.nag_tau = float(nag_tau)
		self.inplace = bool(inplace)

	def __get__(self, obj, objtype=None):
		def wrapped_attention(self_module, *args, **kwargs):
			self_module.nag_context = self.nag_context
			self_module.nag_scale = self.nag_scale
			self_module.nag_alpha = self.nag_alpha
			self_module.nag_tau = self.nag_tau
			self_module.inplace = self.inplace
			return _ltxv_crossattn_forward_nag(self_module, *args, **kwargs)

		return types.MethodType(wrapped_attention, obj)


def _apply_ltx_nag(model, nag_conditioning, nag_scale: float, nag_alpha: float, nag_tau: float, inplace: bool = True):
	if nag_conditioning is None or abs(float(nag_scale)) <= 1e-6:
		return model

	model_clone = model.clone()
	diffusion_model = model_clone.get_model_object("diffusion_model")

	dtype = model.model.manual_cast_dtype
	if dtype is None:
		dtype = model.model.diffusion_model.dtype

	context_video = nag_conditioning[0][0].to(mm.get_torch_device(), dtype)
	video_dim = diffusion_model.inner_dim
	cross_attention_dim = getattr(diffusion_model, "cross_attention_dim", None)
	audio_cross_attention_dim = getattr(diffusion_model, "audio_cross_attention_dim", 0)
	if cross_attention_dim is not None and context_video.shape[-1] == cross_attention_dim + audio_cross_attention_dim:
		context_video = context_video[:, :, :cross_attention_dim]

	offload_device = mm.unet_offload_device()
	if getattr(diffusion_model, "caption_proj_before_connector", False) and getattr(diffusion_model, "caption_projection_first_linear", False):
		diffusion_model.caption_projection.to(mm.get_torch_device())
		context_video = diffusion_model.caption_projection(context_video)
		diffusion_model.caption_projection.to(offload_device)

	if hasattr(diffusion_model, "video_embeddings_connector"):
		diffusion_model.video_embeddings_connector.to(mm.get_torch_device())
		context_video = diffusion_model.video_embeddings_connector(context_video)[0]
		diffusion_model.video_embeddings_connector.to(offload_device)

	context_video = context_video.view(1, -1, video_dim)
	for index, block in enumerate(diffusion_model.transformer_blocks):
		patched = _LTXVCrossAttentionPatch(context_video, nag_scale, nag_alpha, nag_tau, inplace=inplace).__get__(block.attn2, block.__class__)
		model_clone.add_object_patch(f"diffusion_model.transformer_blocks.{index}.attn2.forward", patched)
	return model_clone


def _ffn_chunked_forward(self, x):
	if x.shape[1] > self.dim_threshold:
		chunk_size = max(1, x.shape[1] // self.num_chunks)
		for index in range(self.num_chunks):
			start_idx = index * chunk_size
			end_idx = (index + 1) * chunk_size if index < self.num_chunks - 1 else x.shape[1]
			x[:, start_idx:end_idx] = self.net(x[:, start_idx:end_idx])
		return x
	return self.net(x)


class _LTXVFeedForwardChunkPatch:
	def __init__(self, num_chunks: int, dim_threshold: int):
		self.num_chunks = int(num_chunks)
		self.dim_threshold = int(dim_threshold)

	def __get__(self, obj, objtype=None):
		def wrapped_forward(self_module, *args, **kwargs):
			self_module.num_chunks = self.num_chunks
			self_module.dim_threshold = self.dim_threshold
			return _ffn_chunked_forward(self_module, *args, **kwargs)

		return types.MethodType(wrapped_forward, obj)


def _apply_ff_chunking(model, chunks: int = DEFAULT_FF_CHUNKS, dim_threshold: int = DEFAULT_FF_DIM_THRESHOLD):
	if int(chunks) <= 1:
		return model
	model_clone = model.clone()
	diffusion_model = model_clone.get_model_object("diffusion_model")
	for index, block in enumerate(diffusion_model.transformer_blocks):
		patched = _LTXVFeedForwardChunkPatch(chunks, dim_threshold).__get__(block.ff, block.__class__)
		model_clone.add_object_patch(f"diffusion_model.transformer_blocks.{index}.ff.forward", patched)
	return model_clone


def _create_video(frames: torch.Tensor, fps: float, audio: dict[str, Any] | None):
	try:
		return CreateVideo.execute(frames, float(fps), audio)[0]
	except Exception:
		frame_rate = Fraction(float(fps)).limit_denominator(1000)
		return InputImpl.VideoFromComponents(Types.VideoComponents(images=frames, audio=audio, frame_rate=frame_rate))


def _supported_segment_video_format(format_name: Any) -> str:
	requested = str(format_name or DEFAULT_SEGMENT_VIDEO_FORMAT).strip() or DEFAULT_SEGMENT_VIDEO_FORMAT
	try:
		supported = set(list_supported_formats())
	except Exception:
		supported = {DEFAULT_SEGMENT_VIDEO_FORMAT}
	if requested in supported and requested.startswith("video/"):
		return requested
	return DEFAULT_SEGMENT_VIDEO_FORMAT


def _format_segment_save_prefix(preset: Any, unique_id: Any, segment_index: int, start_index: int, end_index: int) -> str:
	now = datetime.datetime.now()
	base = str(preset or "").strip() or "video/GJJ_LTX多图分段"
	replacements = {
		"{date}": now.strftime("%Y%m%d"),
		"{time}": now.strftime("%H%M%S"),
		"{node}": str(unique_id or "node"),
		"{segment}": f"{int(segment_index):02d}",
		"{start}": f"{int(start_index):02d}",
		"{end}": f"{int(end_index):02d}",
	}
	for key, value in replacements.items():
		base = base.replace(key, value)
	base = base.replace("\\", "/").strip("/")
	if not base:
		base = "video/GJJ_LTX多图分段"
	return f"{base}/段{int(segment_index):02d}_场景{int(start_index):02d}-{int(end_index):02d}"


def _concat_audio_segments(audio_segments: list[dict[str, Any] | None]) -> dict[str, Any] | None:
	valid = [item for item in audio_segments if isinstance(item, dict) and item.get("waveform") is not None]
	if not valid:
		return None
	sample_rate = int(valid[0].get("sample_rate", 0) or 0)
	if sample_rate <= 0:
		return None
	waveforms: list[torch.Tensor] = []
	for item in valid:
		if int(item.get("sample_rate", 0) or 0) != sample_rate:
			return None
		waveform = item.get("waveform")
		if not isinstance(waveform, torch.Tensor):
			waveform = torch.as_tensor(waveform, dtype=torch.float32)
		if waveform.ndim == 1:
			waveform = waveform.unsqueeze(0).unsqueeze(0)
		elif waveform.ndim == 2:
			waveform = waveform.unsqueeze(0)
		elif waveform.ndim != 3:
			return None
		waveforms.append(waveform.detach().cpu())
	if not waveforms:
		return None
	result = dict(valid[0])
	result["sample_rate"] = sample_rate
	result["waveform"] = torch.cat(waveforms, dim=-1).contiguous()
	return result


def _save_segment_video_preview(
	*,
	frames: torch.Tensor,
	audio: dict[str, Any] | None,
	fps: int,
	save_preset: Any,
	format_name: Any,
	unique_id: Any,
	segment_index: int,
	segment_count: int,
	start_index: int,
	end_index: int,
	output_width: int,
	output_height: int,
) -> dict[str, Any]:
	prefix = _format_segment_save_prefix(save_preset, unique_id, segment_index, start_index, end_index)
	resolved_format = _supported_segment_video_format(format_name)
	saved = combine_video(
		images=frames,
		frame_rate=float(fps),
		loop_count=0,
		filename_prefix=prefix,
		format_name=resolved_format,
		pingpong=False,
		save_output=True,
		audio=audio,
		unique_id=None,
	)
	ui = saved.get("ui", {}) if isinstance(saved, dict) else {}
	media_items = ui.get("preview_media") or ui.get("images") or []
	media_item = dict(media_items[0]) if media_items else {}
	main_path = ""
	raw_path = ui.get("preview_main_path")
	if isinstance(raw_path, (list, tuple)) and raw_path:
		main_path = str(raw_path[0] or "")
	elif isinstance(raw_path, str):
		main_path = raw_path
	payload = {
		"index": int(segment_index),
		"total": int(segment_count),
		"label": f"第 {int(segment_index)}/{int(segment_count)} 段：场景{int(start_index)} → 场景{int(end_index)}",
		"path": main_path,
		"media": media_item,
		"width": int(output_width),
		"height": int(output_height),
		"frame_count": int(frames.shape[0]),
		"format": resolved_format,
	}
	_send_segment_preview(unique_id, payload)
	return payload


def _resolve_output_dimension(value: int | None, fallback: int) -> int:
	try:
		numeric = int(value) if value is not None else 0
	except Exception:
		numeric = 0
	if numeric > 0:
		return max(64, numeric)
	return max(64, int(fallback))


def _clamp_float(value: Any, default: float, minimum: float, maximum: float) -> float:
	try:
		numeric = float(value)
	except Exception:
		numeric = float(default)
	return max(float(minimum), min(float(maximum), numeric))


def _clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
	try:
		numeric = int(value)
	except Exception:
		numeric = int(default)
	return max(int(minimum), min(int(maximum), numeric))


def _apply_denoise_to_sigmas(sigmas: torch.Tensor, denoise: Any) -> torch.Tensor:
	strength = _clamp_float(denoise, DEFAULT_DENOISE_STRENGTH, 0.0, 1.0)
	if strength >= 0.999:
		return sigmas
	if not isinstance(sigmas, torch.Tensor) or int(sigmas.numel()) <= 1:
		return sigmas
	if strength <= 0.0:
		return sigmas[-2:].contiguous()
	step_count = max(1, int(sigmas.numel()) - 1)
	keep_steps = max(1, int(math.ceil(float(step_count) * float(strength))))
	if keep_steps >= step_count:
		return sigmas
	return sigmas[-(keep_steps + 1):].contiguous()


def _transition_curve_alpha(position: float, curve: str) -> float:
	p = _clamp_float(position, 0.5, 0.0, 1.0)
	text = str(curve or "").strip()
	if text == "前置过渡":
		return 1.0 - (1.0 - p) * (1.0 - p)
	if text == "后置过渡":
		return p * p
	if text == "平滑过渡":
		return p * p * (3.0 - 2.0 * p)
	return p


def _blend_reference_images(start_image: torch.Tensor, end_image: torch.Tensor, amount: float) -> torch.Tensor:
	start = _ensure_image_batch(start_image)[:1]
	height = int(start.shape[1])
	width = int(start.shape[2])
	end = _resize_guide_to_size(end_image, width, height).to(device=start.device, dtype=start.dtype)
	alpha = _clamp_float(amount, 0.5, 0.0, 1.0)
	return (start * (1.0 - alpha) + end * alpha).clamp(0.0, 1.0).contiguous()


def _resolve_transition_options(options: Any) -> dict[str, Any]:
	data = options if isinstance(options, dict) else {}
	return {
		"enabled": bool(data.get("enabled", False)),
		"curve": str(data.get("curve") or "前置过渡"),
		"early_tail_ratio": _clamp_float(data.get("early_tail_ratio"), 0.75, 0.10, 0.95),
		"implicit_guide_count": _clamp_int(data.get("implicit_guide_count"), 2, 0, 4),
		"implicit_guide_strength": _clamp_float(data.get("implicit_guide_strength"), 0.55, 0.0, 1.0),
		"early_tail_strength": _clamp_float(data.get("early_tail_strength"), 0.75, 0.0, 1.0),
		"final_guide_strength": _clamp_float(data.get("final_guide_strength"), 1.0, 0.0, 1.0),
	}


def _build_transition_conditioning_guides(
	main_image: torch.Tensor | None,
	guide_images: Iterable[torch.Tensor | None],
	guide_times: Iterable[float],
	transition_options: Any,
) -> tuple[list[torch.Tensor], list[float], list[float]]:
	original_images = list(guide_images or [])
	original_times = [float(item) for item in list(guide_times or [])]
	base_strengths = [1.0 for _ in original_images]
	options = _resolve_transition_options(transition_options)
	if main_image is None or not options["enabled"] or not original_images:
		return original_images, original_times, base_strengths

	scenes: list[tuple[torch.Tensor, float]] = [(main_image, 0.0)]
	for image, seconds in zip(original_images, original_times):
		if image is not None:
			scenes.append((image, float(seconds)))
	scenes.sort(key=lambda item: float(item[1]))
	if len(scenes) < 2:
		return original_images, original_times, base_strengths

	guides: list[tuple[torch.Tensor, float, float]] = []
	implicit_count = int(options["implicit_guide_count"])
	early_ratio = float(options["early_tail_ratio"])
	for index in range(len(scenes) - 1):
		start_image, start_time = scenes[index]
		end_image, end_time = scenes[index + 1]
		duration = float(end_time) - float(start_time)
		if duration <= 0:
			guides.append((end_image, float(end_time), float(options["final_guide_strength"])))
			continue

		for guide_index in range(1, implicit_count + 1):
			position = float(guide_index) / float(implicit_count + 1)
			time_ratio = early_ratio * position
			blend_alpha = _transition_curve_alpha(position, str(options["curve"]))
			try:
				blended = _blend_reference_images(start_image, end_image, blend_alpha)
			except Exception:
				continue
			guides.append(
				(
					blended,
					float(start_time) + duration * time_ratio,
					float(options["implicit_guide_strength"]),
				)
			)

		guides.append(
			(
				end_image,
				float(start_time) + duration * early_ratio,
				float(options["early_tail_strength"]),
			)
		)
		guides.append((end_image, float(end_time), float(options["final_guide_strength"])))

	guides.sort(key=lambda item: float(item[1]))
	return [item[0] for item in guides], [float(item[1]) for item in guides], [float(item[2]) for item in guides]


def _prepare_guides(
	main_image: torch.Tensor | None,
	guide_images: Iterable[torch.Tensor | None],
	guide_times: Iterable[float],
	guide_strengths: Iterable[float] | None,
	output_long_edge: int | None,
	fallback_width: int | None = None,
	fallback_height: int | None = None,
):
	guides: list[tuple[torch.Tensor, float, float]] = []
	if main_image is None:
		source_width = 1280
		source_height = 720
	else:
		main_image = _ensure_image_batch(main_image)[:1]
		source_width = int(main_image.shape[2])
		source_height = int(main_image.shape[1])

	# Clean v40：如果上层已明确给了 target_width / target_height，就强制以它们为最终输出尺寸，
	# 不再回退到参考图原始尺寸，避免出现“面板设 512x512，结果仍按 1280x720 输出”的问题。
	if fallback_width is not None and fallback_height is not None:
		try:
			output_width = max(64, int(round(float(fallback_width))))
		except Exception:
			output_width = _resolve_output_dimension(None, source_width)
		try:
			output_height = max(64, int(round(float(fallback_height))))
		except Exception:
			output_height = _resolve_output_dimension(None, source_height)
	else:
		output_width = _resolve_output_dimension(fallback_width, source_width)
		output_height = _resolve_output_dimension(fallback_height, source_height)
	width, height = _resolve_stage1_sample_size(output_width, output_height, output_long_edge)

	if main_image is not None:
		anchor_image = _resize_guide_to_size(main_image, width, height)
		guides.append((anchor_image, 0.0, 1.0))
	strength_values = list(guide_strengths or [])
	for index, (image, seconds) in enumerate(zip(list(guide_images or []), list(guide_times or []))):
		if image is None:
			continue
		strength = _clamp_float(strength_values[index] if index < len(strength_values) else 1.0, 1.0, 0.0, 1.0)
		guides.append((_resize_guide_to_size(image, width, height), float(seconds), strength))
	guides.sort(key=lambda item: float(item[1]))
	return guides, width, height, output_width, output_height


def _resolve_visual_route_label(main_image: torch.Tensor | None, guide_images: Iterable[torch.Tensor | None]) -> str:
	scene_count = 0
	if main_image is not None:
		scene_count += 1
	scene_count += sum(1 for image in list(guide_images or []) if image is not None)
	if scene_count <= 0:
		return "文生视频"
	if scene_count == 1:
		return "图生视频"
	return f"多图参考（{scene_count}张）"


def _detect_total_vram_gb(default_gb: float = DEFAULT_AUDIO_SAFE_BASE_VRAM_GB) -> float:
	try:
		device = mm.get_torch_device()
		if not isinstance(device, torch.device):
			device = torch.device(str(device))
		if device.type != "cuda":
			return float(default_gb)
		total_memory = int(torch.cuda.get_device_properties(device).total_memory)
		if total_memory <= 0:
			return float(default_gb)
		return max(1.0, float(total_memory) / float(1024 ** 3))
	except Exception:
		return float(default_gb)


def _resolve_audio_conditioned_budget(width: int, height: int, fps: int) -> tuple[int, int, float]:
	total_vram_gb = _detect_total_vram_gb()
	budget_scale = max(0.5, float(total_vram_gb) / float(DEFAULT_AUDIO_SAFE_BASE_VRAM_GB))
	pixel_frame_budget = int(round(float(DEFAULT_AUDIO_SAFE_PIXEL_FRAMES_AT_32GB) * budget_scale))
	pixel_frame_budget = max(MIN_AUDIO_SAFE_PIXEL_FRAMES, min(MAX_AUDIO_SAFE_PIXEL_FRAMES, pixel_frame_budget))
	frame_cap = int(round(float(DEFAULT_AUDIO_SAFE_FRAME_CAP_AT_32GB) * budget_scale))
	frame_cap = max(MIN_AUDIO_SAFE_FRAME_CAP, min(MAX_AUDIO_SAFE_FRAME_CAP, frame_cap))

	area = max(1, int(width) * int(height))
	frames_from_pixels = max(1, pixel_frame_budget // area)
	safe_frame_count = max(1, min(frame_cap, frames_from_pixels))
	safe_seconds = max(0.1, float(max(0, safe_frame_count - 1)) / float(max(1, int(fps))))
	return safe_frame_count, pixel_frame_budget, safe_seconds


def _format_seconds(value: float) -> str:
	seconds = float(value)
	if abs(seconds - round(seconds)) <= 0.05:
		return f"{int(round(seconds))}秒"
	return f"{seconds:.1f}秒"


def _resolve_audio_speed_sampling_size(
	width: int,
	height: int,
	fps: int,
	frame_count: int,
	guide_count: int,
) -> tuple[int, int]:
	current_width = max(64, int(width))
	current_height = max(64, int(height))
	current_area = max(1, current_width * current_height)

	total_vram_gb = _detect_total_vram_gb()
	vram_scale = max(0.65, float(total_vram_gb) / float(DEFAULT_AUDIO_SAFE_BASE_VRAM_GB))
	target_pixel_frames = float(DEFAULT_AUDIO_SAFE_PIXEL_FRAMES_AT_32GB) * float(vram_scale) * float(DEFAULT_AUDIO_SPEED_TARGET_RATIO)
	guide_penalty = max(0.6, 1.0 - max(0, int(guide_count) - 1) * DEFAULT_AUDIO_GUIDE_PENALTY)
	target_pixel_frames *= guide_penalty

	current_pixel_frames = float(current_area) * float(max(1, int(frame_count)))
	area_scale = 1.0
	if current_pixel_frames > target_pixel_frames > 0:
		area_scale = math.sqrt(float(target_pixel_frames) / float(current_pixel_frames))

	base_long_edge = int(round(float(DEFAULT_AUDIO_FAST_LONG_EDGE_AT_32GB) * float(vram_scale)))
	base_long_edge = max(MIN_AUDIO_FAST_LONG_EDGE, min(MAX_AUDIO_FAST_LONG_EDGE, base_long_edge))
	current_long_edge = max(current_width, current_height)
	long_edge_scale = min(1.0, float(base_long_edge) / float(max(1, current_long_edge)))

	final_scale = min(1.0, area_scale, long_edge_scale)
	if final_scale >= 0.999:
		return current_width, current_height

	target_width = _round_to_multiple(int(round(float(current_width) * final_scale)), 32, 64)
	target_height = _round_to_multiple(int(round(float(current_height) * final_scale)), 32, 64)
	target_width = min(current_width, target_width)
	target_height = min(current_height, target_height)
	return target_width, target_height


def _check_audio_conditioned_budget(
	*,
	width: int,
	height: int,
	fps: int,
	frame_count: int,
	audio_duration: float,
	route_label: str,
	guide_count: int,
):
	safe_frame_count, pixel_frame_budget, safe_seconds = _resolve_audio_conditioned_budget(width, height, fps)
	estimated_pixel_frames = int(width) * int(height) * int(frame_count)

	if int(frame_count) > int(safe_frame_count):
		raise RuntimeError(
			f"当前 {route_label} + 音频驱动任务预计显存压力过高：采样尺寸 {int(width)}x{int(height)}，"
			f"{int(fps)}fps，音频时长 {_format_seconds(audio_duration)}，约 {int(frame_count)} 帧，"
			f"{int(guide_count)} 张参考图。按当前显卡建议控制在约 {safe_frame_count} 帧 / {_format_seconds(safe_seconds)} 以内，"
			"否则很容易卡在 “Model Initializing” 并持续占用共享显存。请优先缩短音频，其次降低面板宽高或 fps 后再试。"
		)

	usage_ratio = float(frame_count) / float(max(1, safe_frame_count))
	if usage_ratio >= DEFAULT_AUDIO_SAFE_WARNING_RATIO:
		return (
			f"提示：当前任务显存压力较高，采样尺寸 {int(width)}x{int(height)}，"
			f"{int(fps)}fps，约 {int(frame_count)} 帧，像素帧负载 {estimated_pixel_frames / 1_000_000:.1f}M / "
			f"{pixel_frame_budget / 1_000_000:.1f}M。"
		)


def run_ltx23_multiref_video(
	*,
	mode: str,
	checkpoint_name: Any = "",
	positive_prompt: str = "",
	negative_prompt: str,
	main_image: torch.Tensor | None,
	guide_images: Iterable[torch.Tensor | None],
	guide_times: Iterable[float],
	fps: int,
	output_long_edge: int | None,
	target_width: int | None,
	target_height: int | None,
	seed: int,
	duration_seconds: float | None,
	input_audio: dict[str, Any] | None,
	lora_chain_config: Any = "",
	decode_generated_audio: bool = True,
	frame_trim_start: int,
	segmented_execution: bool = False,
	segment_save_preset: Any = "",
	segment_video_format: Any = DEFAULT_SEGMENT_VIDEO_FORMAT,
	transition_options: Any = None,
	denoise_strength: Any = DEFAULT_DENOISE_STRENGTH,
	branch_debug: Any = None,
	unique_id: Any = None,
):
	_ensure_runtime_dependencies()
	prompt_text = str(positive_prompt or "").strip() or "电影感视频，主体自然运动，镜头稳定，细节清晰。"
	negative_text = str(negative_prompt or "").strip() or DEFAULT_NEGATIVE_PROMPT
	fps = max(1, int(fps))
	try:
		target_width = max(64, int(round(float(target_width)))) if target_width is not None else None
	except Exception:
		target_width = None
	try:
		target_height = max(64, int(round(float(target_height)))) if target_height is not None else None
	except Exception:
		target_height = None
	if target_width is not None and target_height is not None:
		_send_status(unique_id, f"Clean v40 入口尺寸：target_width={target_width} / target_height={target_height}")
		try:
			print(f"[GJJ LTX2.3 Clean v40] runtime entry: target_width={target_width}, target_height={target_height}, fps={fps}, seed={seed}", flush=True)
		except Exception:
			pass
	base_guide_images = list(guide_images or [])
	base_guide_times = list(guide_times or [])
	visual_scene_count = (1 if main_image is not None else 0) + sum(1 for image in base_guide_images if image is not None)
	if mode == MODE_AUDIO_CONDITIONED and visual_scene_count <= 0:
		route_label = "音频生视频"
	elif mode == MODE_AUDIO_CONDITIONED:
		route_label = "数字人" if visual_scene_count == 1 else f"数字人多图参考（{visual_scene_count}张）"
	elif visual_scene_count == 2:
		route_label = "首尾帧"
	else:
		route_label = _resolve_visual_route_label(main_image, base_guide_images)
	# Clean v40：多图模式也需要转场 LoRA。
	# 之前只在 exactly 2 张图的“首尾帧”分支自动启用，>=3 张多图分段时没有自动加载转场 LoRA，
	# 所以多图转场会明显不如双图丝滑。
	segment_switch_text = ""
	try:
		segment_switch_text = str(_resolve_transition_options(transition_options).get("lora_switches") or "").strip()
	except Exception:
		segment_switch_text = ""
	segment_count_for_switch = max(1, visual_scene_count - 1) if visual_scene_count >= 2 else 1
	global_transition_lora_enabled_by_switch = _resolve_transition_lora_switch_any(segment_switch_text, segment_count_for_switch)
	auto_enable_transition_lora = (visual_scene_count >= 2) and bool(global_transition_lora_enabled_by_switch)
	prepared_lora_chain_source = lora_chain_config if global_transition_lora_enabled_by_switch else _strip_transition_lora_from_chain(lora_chain_config)
	prepared_lora_chain_config, transition_lora_enabled, auto_transition_lora_name, auto_transition_lora_path = _ensure_transition_lora_in_chain(prepared_lora_chain_source, auto_enable_transition_lora)
	prepared_lora_chain_config, transition_lora_enabled2, transition_strength_changed = _prepare_ltx_lora_chain_config(prepared_lora_chain_config)
	transition_lora_enabled = bool(global_transition_lora_enabled_by_switch and (transition_lora_enabled or transition_lora_enabled2))
	# prompt 是否添加 zhuanchang 改到 _render_once 内按段处理；这里仅记录全局是否加载 LoRA。
	transition_trigger_added = False
	try:
		print(f"[GJJ LTX2.3 Clean v40] transition-lora global check: visual_scene_count={visual_scene_count}, route={route_label}, switch_seq={segment_switch_text or '(default all on)'}, global_lora_enabled={global_transition_lora_enabled_by_switch}, auto_enable_transition_lora={auto_enable_transition_lora}", flush=True)
		print(f"[GJJ LTX2.3 Clean v40] transition lora search result: name={auto_transition_lora_name or '(none)'} path={auto_transition_lora_path or '(none)'}", flush=True)
	except Exception:
		pass
	resolved_denoise_strength = _clamp_float(denoise_strength, DEFAULT_DENOISE_STRENGTH, 0.0, 1.0)
	debug_route_key = ""
	debug_source_summary = ""
	if isinstance(branch_debug, dict):
		debug_route_key = str(branch_debug.get("route_key") or "").strip()
		debug_source_summary = str(branch_debug.get("source_summary") or "").strip()
		# Clean v40：双图首尾帧时，route_label 必须稳定保持“首尾帧”，
		# 不能再被 debug_route_key=multi_frame 覆盖。只有 3 张及以上时才显示多帧参考。
		if debug_route_key == "multi_frame" and visual_scene_count > 2:
			route_label = f"多帧参考（{visual_scene_count}张）"

	def _branch_status_text() -> str:
		key_text = f" / {debug_route_key}" if debug_route_key else ""
		source_text = f" / {debug_source_summary}" if debug_source_summary else ""
		return f"当前分支：{route_label}{key_text} / 有效场景 {visual_scene_count} 张{source_text}"

	def _execute():
		_send_status(unique_id, _branch_status_text())
		_send_status(unique_id, f"1/8 加载 LTX 模型与默认资源...（{route_label} / {visual_scene_count}张）")
		try:
			selected_ckpt = str(checkpoint_name or "").strip()
			ckpt_candidates = []
			if selected_ckpt and not selected_ckpt.startswith("未找到"):
				ckpt_candidates.append(selected_ckpt)
			for fallback_ckpt in ("ltx-2.3-22b", "ltx23", "ltx"):
				if fallback_ckpt not in ckpt_candidates:
					ckpt_candidates.append(fallback_ckpt)
			resolved_ckpt = _pick_first_candidate("diffusion_models", tuple(ckpt_candidates), "LTX 主模型")
			resolved_video_vae = _pick_first_candidate("vae",("video_vae",), "LTX 视频 VAE")
			resolved_audio_vae = _pick_first_candidate("vae",("audio_vae",), "LTX 音频 VAE")
			resolved_text_encoder = _pick_first_candidate("text_encoders",("gemma_3_12B_it_fp8_e4m3fn.safetensors", "gemma_3_12B_it.safetensors", "gemma-3-12b-it-qat-q4_0-unquantized_readout_proj/model/model.safetensors", "gemma-3-12b-it-qat-q4_0-unquantized_readout_proj", "gemma_3_12B_it"), "LTX 文本编码器")
			resolved_latent_upscaler = _pick_first_candidate("latent_upscale_models",("ltx-2.3-spatial-upscaler",), "LTX latent 放大模型")

			model = _load_ltx_main_model(resolved_ckpt)
			clip = _load_ltx_text_encoder(resolved_text_encoder, resolved_ckpt)
			video_vae = _load_video_vae(resolved_video_vae)
			audio_vae = _load_audio_vae(resolved_audio_vae)
			latent_upscaler = LatentUpscaleModelLoader.execute(resolved_latent_upscaler)[0]

			model, clip = _apply_chain_loras(model, clip, prepared_lora_chain_config)
			if transition_lora_enabled:
				details = []
				if transition_strength_changed:
					details.append("强度已按 1.00 应用")
				if transition_lora_enabled:
					details.append("触发词按段自动处理")
				if auto_transition_lora_name:
					details.append(f"自动启用 LoRA={auto_transition_lora_name}")
				_send_status(unique_id, f"提示：检测到/启用了 LTX 转场 LoRA，{'，'.join(details) if details else '已启用'}。")
				try:
					print(f"[GJJ LTX2.3 Clean v40] transition lora enabled: name={auto_transition_lora_name or '(from chain)'} path={auto_transition_lora_path or '(unknown)'} trigger_added={transition_trigger_added} strength_fixed={transition_strength_changed}", flush=True)
					print(f"[GJJ LTX2.3 Clean v40] final lora chain config: {prepared_lora_chain_config}", flush=True)
				except Exception:
					pass
			else:
				try:
					print(f"[GJJ LTX2.3 Clean v40] no transition lora enabled for this run. switch_seq={segment_switch_text or '(default all on)'} global_lora_enabled={global_transition_lora_enabled_by_switch}", flush=True)
				except Exception:
					pass
			model = _apply_ff_chunking(model, DEFAULT_FF_CHUNKS, DEFAULT_FF_DIM_THRESHOLD)
		except Exception as exc:
			raise RuntimeError(f"LTX 多图参考节点加载模型失败：{exc}") from exc

		def _branch_kind_label(branch_kind: str) -> str:
			if branch_kind == "first_last_workflow":
				return "首尾帧-源工作流复刻"
			if branch_kind == "multiframe_workflow_segment":
				return "多图参考-逐段复刻源工作流"
			return "默认分支"

		def _render_once(
			*,
			render_main_image: torch.Tensor | None,
			render_guide_images: Iterable[torch.Tensor | None],
			render_guide_times: Iterable[float],
			render_duration_seconds: float | None,
			render_mode: str,
			render_input_audio: dict[str, Any] | None,
			render_seed: int,
			render_frame_trim_start: int,
			render_route_label: str,
			render_branch_kind: str = "default",
			render_segment_index: int | None = None,
			status_prefix: str = "",
		) -> dict[str, Any]:
			prefix = f"{status_prefix} · " if status_prefix else ""
			render_segment_lora_enabled = _resolve_transition_lora_switch_for_segment(segment_switch_text, render_segment_index)
			render_segment_label = "启用" if render_segment_lora_enabled else "关闭"
			render_prompt_text = prompt_text
			render_trigger_added = False
			if transition_lora_enabled and render_segment_lora_enabled:
				render_prompt_text, render_trigger_added = _append_ltx_transition_trigger(prompt_text, True)
			_send_status(unique_id, f"{prefix}Clean v40 当前分支：{_branch_kind_label(str(render_branch_kind or 'default'))} / route={render_route_label}")
			_send_status(unique_id, f"{prefix}Clean v40 转场LoRA段控制：序列={segment_switch_text or '默认全启用'}；当前段={render_segment_index or 1}；本段={render_segment_label}")
			try:
				print(f"[GJJ LTX2.3 Clean v40] render_once branch={render_branch_kind} route={render_route_label}", flush=True)
			except Exception:
				pass
			original_guide_images = list(render_guide_images or [])
			original_guide_times = list(render_guide_times or [])
			workflow_first_last = str(render_branch_kind or "") == "first_last_workflow"
			if workflow_first_last:
				render_guide_images = original_guide_images
				render_guide_times = original_guide_times
				render_guide_strengths = [float(WORKFLOW_FIRST_LAST_GUIDE_STRENGTH) for _ in original_guide_images if _ is not None]
				_send_status(unique_id, f"{prefix}Clean v40 首尾帧：严格按最新工作流复刻（不使用面板转场参数）。")
				try:
					main_shape = tuple(render_main_image.shape) if hasattr(render_main_image, 'shape') else '(unknown)'
					guide_shapes = [tuple(x.shape) if hasattr(x, 'shape') else '(unknown)' for x in original_guide_images if x is not None]
					print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] using original scene tensors: main={main_shape}, guides={guide_shapes}", flush=True)
				except Exception:
					pass
			else:
				render_guide_images, render_guide_times, render_guide_strengths = _build_transition_conditioning_guides(
					render_main_image,
					original_guide_images,
					original_guide_times,
					transition_options,
				)
				try:
					opts = _resolve_transition_options(transition_options)
					if opts.get("enabled"):
						_send_status(unique_id, f"{prefix}Clean v40 转场guide：原始guide={len(original_guide_images)}，增强后guide={len(render_guide_images)}，强度={','.join(f'{float(x):.2f}' for x in render_guide_strengths[:6])}")
				except Exception:
					pass

			_send_status(unique_id, f"{prefix}2/8 处理{render_route_label}输入...")
			try:
				guides, sample_width, sample_height, output_width, output_height = _prepare_guides(
					render_main_image,
					render_guide_images,
					render_guide_times,
					render_guide_strengths,
					output_long_edge,
					fallback_width=target_width,
					fallback_height=target_height,
				)
				# Clean v40：
				# 这里还不知道 output_frame_count，不能构建 frame=-1 对应的尾帧 guide。
				# 先占位，等音频/空音频 latent 创建完成、output_frame_count 确定后再构建。
				latent_reference_guides = []
				if not workflow_first_last:
					latent_reference_guides = _build_latent_inplace_guides(
						render_main_image,
						render_guide_images,
						render_guide_times,
						render_guide_strengths,
					)
				_send_status(unique_id, f"{prefix}Clean v40 尺寸锁定：target={target_width}x{target_height} / sample={sample_width}x{sample_height} / output={output_width}x{output_height}")
				try:
					print(f"[GJJ LTX2.3 Clean v40] size lock: target={target_width}x{target_height}, sample={sample_width}x{sample_height}, output={output_width}x{output_height}, guides={len(guides)}", flush=True)
				except Exception:
					pass
			except Exception as exc:
				raise RuntimeError(f"LTX 多图参考节点处理参考图失败：{exc}") from exc

			output_audio = None
			if render_mode == MODE_AUDIO_CONDITIONED:
				if render_input_audio is None:
					raise RuntimeError("数字人多图参考节点需要接入音频。")
				_send_status(unique_id, f"{prefix}3/8 裁切并编码输入音频...")
				try:
					output_audio = _normalize_audio_rms(_trim_audio(render_input_audio, DEFAULT_AUDIO_START_SECONDS, DEFAULT_AUDIO_MAX_SECONDS), DEFAULT_AUDIO_TARGET_DB)
					audio_duration = _audio_duration_seconds(output_audio)
					output_frame_count = _requested_frame_count(audio_duration, fps)
					frame_count = _ltx_internal_frame_count(output_frame_count, render_frame_trim_start)
					tuned_sample_width, tuned_sample_height = _resolve_audio_speed_sampling_size(
						sample_width,
						sample_height,
						fps,
						output_frame_count,
						len(guides),
					)
					if tuned_sample_width != sample_width or tuned_sample_height != sample_height:
						current_long_edge = max(sample_width, sample_height)
						tuned_long_edge = max(tuned_sample_width, tuned_sample_height)
						tuned_guides, tuned_width, tuned_height, output_width, output_height = _prepare_guides(
							render_main_image,
							render_guide_images,
							render_guide_times,
							render_guide_strengths,
							tuned_long_edge if tuned_long_edge < current_long_edge else output_long_edge,
							fallback_width=output_width,
							fallback_height=output_height,
						)
						guides = tuned_guides
						sample_width = tuned_width
						sample_height = tuned_height
						_send_status(
							unique_id,
							f"提示：音频驱动已自动降采样到 {sample_width}x{sample_height} 提速，最终输出仍保持 {output_width}x{output_height}。",
						)
					pressure_notice = _check_audio_conditioned_budget(
						width=sample_width,
						height=sample_height,
						fps=fps,
						frame_count=output_frame_count,
						audio_duration=audio_duration,
						route_label=render_route_label,
						guide_count=len(guides),
					)
					if pressure_notice:
						_send_status(unique_id, pressure_notice)
					audio_latent = LTXVAudioVAEEncode.execute(output_audio, audio_vae)[0]
					audio_latent = _set_audio_latent_noise_mask(audio_latent, 0.0)
				except Exception as exc:
					raise RuntimeError(f"LTX 音频驱动节点处理输入音频失败：{exc}") from exc
			else:
				_send_status(unique_id, f"{prefix}3/8 构建空白音频 latent...")
				try:
					total_duration = float(render_duration_seconds or 0.0)
					if total_duration <= 0:
						raise RuntimeError("图生视频时长必须大于 0 秒。")
					output_frame_count = _requested_frame_count(total_duration, fps)
					frame_count = _ltx_internal_frame_count(output_frame_count, render_frame_trim_start)
					audio_latent = LTXVEmptyLatentAudio.execute(frame_count, fps, 1, audio_vae)[0]
				except Exception as exc:
					raise RuntimeError(f"LTX 图生视频节点初始化音频 latent 失败：{exc}") from exc

			if workflow_first_last:
				reference_duration = float(render_duration_seconds or 0.0)
				latent_reference_guides = _build_first_last_reference_guides(
					render_main_image,
					render_guide_images,
					reference_duration,
					fps,
					output_frame_count,
				)
				try:
					guide_desc = []
					for gi, (gimg, gsec, gstrength) in enumerate(latent_reference_guides, start=1):
						shape = tuple(gimg.shape) if hasattr(gimg, "shape") else "(unknown)"
						frame_idx = _guide_frame_index(float(gsec), fps, output_frame_count, render_frame_trim_start)
						guide_desc.append(f"guide{gi}: seconds={gsec}, frame_index={frame_idx}, strength={gstrength}, shape={shape}")
					print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] guide_config_json=[{{\"frame\":0,\"strength\":0.7}},{{\"frame\":-1,\"strength\":0.7}}]", flush=True)
					print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] main_image={_debug_tensor_info(render_main_image)}", flush=True)
					print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] guide_images_count={len([x for x in list(render_guide_images or []) if x is not None])}; output_frame_count={output_frame_count}; true_last_frame={max(0, int(output_frame_count)-1)}; fps={fps}; render_frame_trim_start={render_frame_trim_start}; duration={render_duration_seconds}", flush=True)
					print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] latent guides: {'; '.join(guide_desc) if guide_desc else '(none)'}", flush=True)
					if len(latent_reference_guides) >= 2:
						expected_last = max(0, int(output_frame_count) - 1)
						actual_last = _guide_frame_index(float(latent_reference_guides[1][1]), fps, output_frame_count, render_frame_trim_start)
						print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] last_frame_check: expected={expected_last}, actual={actual_last}, ok={expected_last == actual_last}", flush=True)
				except Exception:
					pass

			if workflow_first_last:
				try:
					print("[GJJ LTX2.3 Clean v40][WorkflowCompare] 源工作流关键参数：优先调用真实GJJ_LTX_FirstLastFrame；frame0=0 strength=0.7 / frame2=-1 strength=0.7; NAG=11,0.25,2.5,inplace=True，优先调用真实GJJ_LTX2NAG；NAG输入使用原始CLIPTextEncode正/负；NAG输出同时连接Stage1/Stage2两个CFGGuider; Stage1 sigmas=1.0,0.99375,0.9875,0.98125,0.975,0.909375,0.725,0.421875,0.0; Stage2 sigmas=0.85,0.7250,0.4219,0.0; ImgToVideoInplace strength=1,bypass=False; LTXVPreprocess img_compression=18", flush=True)
					print(f"[GJJ LTX2.3 Clean v40][WorkflowCompare] 当前关键参数：target={target_width}x{target_height}; sample={sample_width}x{sample_height}; output={output_width}x{output_height}; output_frame_count={output_frame_count}; true_last_frame={max(0, int(output_frame_count)-1)}; latent_guides={len(latent_reference_guides)}", flush=True)
				except Exception:
					pass

			original_guide_count = (1 if render_main_image is not None else 0) + sum(1 for image in original_guide_images if image is not None)
			transition_guide_count = max(0, len(guides) - original_guide_count)
			guide_text = f"{len(guides)}张guide"
			if transition_guide_count:
				guide_text += f"，含{transition_guide_count}张转场guide"
			if latent_reference_guides:
				guide_text += f"，latent锚定{len(latent_reference_guides)}帧位"
			_send_status(unique_id, f"{prefix}4/8 编码提示词并注入时间参考图...（采样 {sample_width}x{sample_height} -> 输出 {output_width}x{output_height} / 输出{output_frame_count}帧 / LTX内部{frame_count}帧 / 降噪{resolved_denoise_strength:.2f} / {guide_text}）")
			try:
				raw_positive = CLIPTextEncode().encode(clip, render_prompt_text)[0]
				raw_negative = CLIPTextEncode().encode(clip, negative_text)[0]
				# 源工作流连线：
				#   CLIPTextEncode 正/负 -> GJJ_LTX2NAG
				#   CLIPTextEncode 正/负 -> LTXVConditioning -> CFGGuider / LTXVCropGuides
				# 所以 NAG 必须吃 raw_positive/raw_negative，CFG/CropGuides 才吃 LTXVConditioning 后的 positive/negative。
				positive, negative = LTXVConditioning.execute(raw_positive, raw_negative, float(fps))[0:2]
				try:
					print(f"[GJJ LTX2.3 Clean v40][WorkflowWiring] raw CLIPTextEncode -> GJJ_LTX2NAG; LTXVConditioning -> CFGGuiders/CropGuides", flush=True)
					print(f"[GJJ LTX2.3 Clean v40][WorkflowWiring] raw_positive_type={type(raw_positive).__name__}, conditioned_positive_type={type(positive).__name__}", flush=True)
				except Exception:
					pass

				video_latent = EmptyLTXVLatentVideo.execute(sample_width, sample_height, frame_count, 1)[0]
				if workflow_first_last:
					try:
						print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] before latent injection: {_debug_tensor_info(video_latent)}", flush=True)
					except Exception:
						pass
					real_positive, real_negative, real_latent, used_real_firstlast = _apply_real_gjj_ltx_first_last_frame(
						video_vae=video_vae,
						latent=video_latent,
						# 源工作流中 GJJ_LTX_FirstLastFrame 的 positive/negative 输入未连接，
						# 只使用 latent + image_01/image_02 输出视频潜空间。
						positive=None,
						negative=None,
						main_image=render_main_image,
						guide_images=render_guide_images,
					)
					if used_real_firstlast:
						video_latent = real_latent
						# 源工作流不接 FirstLast 的 positive/negative 输出，这里只记录，不覆盖后续 conditioning。
						injected_count = 2
						print("[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] REAL node path used; conditioning outputs intentionally not connected, matching source workflow.", flush=True)
					else:
						video_latent, injected_count = _inject_ltxv_images_inplace(
							video_vae=video_vae,
							latent=video_latent,
							reference_guides=latent_reference_guides,
							fps=fps,
							output_frame_count=output_frame_count,
							trim_start=render_frame_trim_start,
						)
					try:
						print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX_FirstLastFrame] after latent injection: {_debug_tensor_info(video_latent)}; injected_count={injected_count}; used_real_node={used_real_firstlast}", flush=True)
					except Exception:
						pass
					_send_status(unique_id, f"{prefix}Clean v40 首尾帧 latent 注入：{injected_count} 个关键帧位（frame 0 / frame -1，strength=0.7，real_node={used_real_firstlast}）。")
					try:
						print(f"[GJJ LTX2.3 Clean v40] first/last latent injection count={injected_count}, frame0_strength={WORKFLOW_FIRST_LAST_GUIDE_STRENGTH}, last_strength={WORKFLOW_FIRST_LAST_GUIDE_STRENGTH}", flush=True)
						if int(injected_count) < 2:
							print("[GJJ LTX2.3 Clean v40] WARNING: expected 2 first/last injections but got less than 2.", flush=True)
					except Exception:
						pass
				else:
					for guide_image, seconds, strength in guides:
						frame_index = _guide_frame_index(seconds, fps, output_frame_count, render_frame_trim_start)
						if frame_index >= frame_count:
							continue
						positive, negative, video_latent = LTXVAddGuide.execute(
							positive,
							negative,
							video_vae,
							video_latent,
							guide_image,
							frame_index,
							float(strength),
						)[0:3]
					video_latent, _ = _inject_ltxv_images_inplace(
						video_vae=video_vae,
						latent=video_latent,
						reference_guides=latent_reference_guides,
						fps=fps,
						output_frame_count=output_frame_count,
						trim_start=render_frame_trim_start,
					)
				av_latent_stage1 = LTXVConcatAVLatent.execute(video_latent, audio_latent)[0]
			except Exception as exc:
				raise RuntimeError(f"LTX 多图参考节点构建初始 latent 失败：{exc}") from exc

			_send_status(unique_id, f"{prefix}5/8 第一阶段低清采样...")
			try:
				stage1_nag_scale = WORKFLOW_FIRST_LAST_NAG_SCALE if workflow_first_last else DEFAULT_NAG_SCALE
				stage1_nag_alpha = WORKFLOW_FIRST_LAST_NAG_ALPHA if workflow_first_last else DEFAULT_NAG_ALPHA
				stage1_nag_tau = WORKFLOW_FIRST_LAST_NAG_TAU if workflow_first_last else DEFAULT_NAG_TAU
				stage1_sigmas_text = WORKFLOW_FIRST_LAST_STAGE1_SIGMAS if workflow_first_last else DEFAULT_STAGE1_SIGMAS
				try:
					print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX2NAG] workflow_first_last={workflow_first_last}; nag_scale={stage1_nag_scale}; nag_alpha={stage1_nag_alpha}; nag_tau={stage1_nag_tau}; inplace=True", flush=True)
					print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX2NAG] source wiring: nag_cond_video=raw_positive; nag_cond_audio=raw_negative; stage1_sigmas={stage1_sigmas_text}", flush=True)
				except Exception:
					pass
				nag_model, used_real_nag = _apply_real_gjj_ltx2nag(
					model=model,
					positive=raw_positive,
					negative=raw_negative,
					nag_scale=stage1_nag_scale,
					nag_alpha=stage1_nag_alpha,
					nag_tau=stage1_nag_tau,
					inplace=True,
				)
				if not used_real_nag:
					# fallback 内部等价实现：同样使用 raw_positive，严格对齐源工作流的 GJJ_LTX2NAG 输入。
					nag_model = _apply_ltx_nag(model, raw_positive, stage1_nag_scale, stage1_nag_alpha, stage1_nag_tau, inplace=True)
				try:
					print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX2NAG] source_exact=using RAW CLIP positive as nag_cond_video, RAW CLIP negative as nag_cond_audio; used_real_node={used_real_nag}", flush=True)
					print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX2NAG] raw_positive_type={type(raw_positive).__name__}, conditioned_positive_type={type(positive).__name__}", flush=True)
					print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX2NAG] output_model_type={type(nag_model).__name__}", flush=True)
				except Exception:
					pass
				# Clean v40：严格对齐源工作流。
				# GJJ_LTX2NAG 的输出直接一分二连接到两个 CFGGuider：
				#   1) 第一阶段 CFGGuider
				#   2) 第二阶段 CFGGuider
				# 源工作流没有额外 CFGNorm，所以这里不再包 CFGNorm。
				stage1_model = nag_model
				guider_stage1 = CFGGuider.execute(stage1_model, positive, negative, DEFAULT_CFG)[0]
				try:
					print("[GJJ LTX2.3 Clean v40][GJJ_LTX2NAG] output connected to Stage1 CFGGuider directly; CFGNorm removed to match source workflow.", flush=True)
				except Exception:
					pass
				sampler_stage1 = KSamplerSelect.execute(DEFAULT_STAGE1_SAMPLER)[0]
				sigmas_stage1 = _apply_denoise_to_sigmas(ManualSigmas.execute(stage1_sigmas_text)[0], resolved_denoise_strength)
				noise_stage1 = RandomNoise.execute(int(render_seed))[0]
				with _fp16_accumulation(True):
					stage1_result = SamplerCustomAdvanced.execute(
						noise_stage1,
						guider_stage1,
						sampler_stage1,
						sigmas_stage1,
						av_latent_stage1,
					)[0]
				_maybe_purge_vram()
				video_latent_stage1, audio_latent_stage1 = LTXVSeparateAVLatent.execute(stage1_result)[0:2]
				positive_stage2, negative_stage2, video_latent_stage1 = LTXVCropGuides.execute(
					positive,
					negative,
					video_latent_stage1,
				)[0:3]
			except Exception as exc:
				raise RuntimeError(f"LTX 多图参考节点第一阶段采样失败：{exc if str(exc) else repr(exc)}") from exc

			_send_status(unique_id, f"{prefix}6/8 latent 放大并进入第二阶段采样...")
			try:
				upscaled_video_latent = LTXVLatentUpsampler().upsample_latent(video_latent_stage1, latent_upscaler, video_vae)[0]
				if workflow_first_last:
					try:
						print(f"[GJJ LTX2.3 Clean v40][LTXVLatentUpsampler] before_inplace={_debug_tensor_info(upscaled_video_latent)}", flush=True)
					except Exception:
						pass
					upscaled_video_latent = _apply_img_to_video_inplace_exact(
						video_vae=video_vae,
						latent=upscaled_video_latent,
						anchor_image=render_main_image,
						strength=WORKFLOW_FIRST_LAST_INPLACE_STRENGTH,
					)
					_send_status(unique_id, f"{prefix}Clean v40 二阶段：按源工作流执行 LTXVImgToVideoInplace（strength=1）。")
					try:
						print(f"[GJJ LTX2.3 Clean v40][LTXVImgToVideoInplace] after_inplace={_debug_tensor_info(upscaled_video_latent)}", flush=True)
					except Exception:
						pass
					try:
						anchor_shape = tuple(render_main_image.shape) if hasattr(render_main_image, 'shape') else '(unknown)'
						print(f"[GJJ LTX2.3 Clean v40] LTXVImgToVideoInplace applied: strength={WORKFLOW_FIRST_LAST_INPLACE_STRENGTH}, anchor_shape={anchor_shape}", flush=True)
					except Exception:
						pass
				else:
					upscaled_video_latent, _ = _inject_ltxv_images_inplace(
						video_vae=video_vae,
						latent=upscaled_video_latent,
						reference_guides=latent_reference_guides,
						fps=fps,
						output_frame_count=output_frame_count,
						trim_start=render_frame_trim_start,
					)
				av_latent_stage2 = LTXVConcatAVLatent.execute(upscaled_video_latent, audio_latent_stage1)[0]

				stage2_model = nag_model if workflow_first_last else model
				guider_stage2 = CFGGuider.execute(stage2_model, positive_stage2, negative_stage2, DEFAULT_CFG)[0]
				try:
					print(f"[GJJ LTX2.3 Clean v40][GJJ_LTX2NAG] output connected to Stage2 CFGGuider: using_nag_model={workflow_first_last}; model_type={type(stage2_model).__name__}", flush=True)
				except Exception:
					pass
				sampler_stage2 = KSamplerSelect.execute(DEFAULT_STAGE2_SAMPLER)[0]
				stage2_sigmas_text = WORKFLOW_FIRST_LAST_STAGE2_SIGMAS if workflow_first_last else DEFAULT_STAGE2_SIGMAS
				try:
					print(f"[GJJ LTX2.3 Clean v40][Stage2] sampler={DEFAULT_STAGE2_SAMPLER}; sigmas={stage2_sigmas_text}; cfg={DEFAULT_CFG}", flush=True)
				except Exception:
					pass
				sigmas_stage2 = _apply_denoise_to_sigmas(ManualSigmas.execute(stage2_sigmas_text)[0], resolved_denoise_strength)
				noise_stage2 = RandomNoise.execute(int(render_seed) + 1)[0]
				with _fp16_accumulation(True):
					stage2_result = SamplerCustomAdvanced.execute(
						noise_stage2,
						guider_stage2,
						sampler_stage2,
						sigmas_stage2,
						av_latent_stage2,
					)[0]
				_maybe_purge_vram()
				video_latent_stage2, audio_latent_stage2 = LTXVSeparateAVLatent.execute(stage2_result)[0:2]
			except Exception as exc:
				raise RuntimeError(f"LTX 多图参考节点第二阶段采样失败：{exc if str(exc) else repr(exc)}") from exc

			_send_status(unique_id, f"{prefix}7/8 解码视频帧与音频...")
			try:
				frames = VAEDecodeTiled().decode(
					video_vae,
					video_latent_stage2,
					DEFAULT_VAE_TILE_SIZE,
					DEFAULT_VAE_OVERLAP,
					DEFAULT_VAE_TEMPORAL_SIZE,
					DEFAULT_VAE_TEMPORAL_OVERLAP,
				)[0]
				frames = _slice_output_frames(frames, render_frame_trim_start, output_frame_count)
				frames = _crop_frames_to_size(frames, output_width, output_height)
				frames = _stamp_original_guide_frames(
					frames,
					render_main_image,
					original_guide_images,
					original_guide_times,
					fps,
					output_width,
					output_height,
				)
				# Clean v40：最后一道保险，确保视频帧尺寸等于最终输出目标。
				if target_width is not None and target_height is not None:
					forced_width = max(64, int(target_width))
					forced_height = max(64, int(target_height))
					if int(output_width) != forced_width or int(output_height) != forced_height or int(frames.shape[2]) != forced_width or int(frames.shape[1]) != forced_height:
						_send_status(unique_id, f"Clean v40 尺寸保险：{int(frames.shape[2])}x{int(frames.shape[1])} / 输出声明 {output_width}x{output_height} -> 强制 {forced_width}x{forced_height}")
						frames = _resize_frames_to_size(frames, forced_width, forced_height)
						output_width = forced_width
						output_height = forced_height
				if render_mode == MODE_GENERATED_AUDIO and bool(decode_generated_audio):
					output_audio = LTXVAudioVAEDecode.execute(audio_latent_stage2, audio_vae)[0]
			except Exception as exc:
				raise RuntimeError(f"LTX 多图参考节点解码失败：{exc}") from exc

			try:
				print(f"[GJJ LTX2.3 Clean v40] final frames before video: {int(frames.shape[2])}x{int(frames.shape[1])}, declared={output_width}x{output_height}", flush=True)
			except Exception:
				pass
			_send_status(unique_id, f"{prefix}8/8 创建视频...")
			video = _create_video(frames, float(fps), output_audio)
			return {
				"video": video,
				"frames": frames.detach().float().cpu().clamp(0.0, 1.0).contiguous(),
				"audio": output_audio,
				"output_width": int(output_width),
				"output_height": int(output_height),
				"output_frame_count": int(output_frame_count),
			}

		scene_images = [main_image] + [image for image in base_guide_images if image is not None] if main_image is not None else []
		auto_workflow_multiframe = mode == MODE_GENERATED_AUDIO and len(scene_images) >= 3
		use_segmented = (bool(segmented_execution) and mode == MODE_GENERATED_AUDIO and len(scene_images) >= 2) or auto_workflow_multiframe
		if bool(segmented_execution) and mode == MODE_AUDIO_CONDITIONED:
			_send_status(unique_id, "提示：接入驱动音频时已自动关闭分段执行，避免外部音频被错误切段。")
		if auto_workflow_multiframe:
			_send_status(unique_id, f"Clean v40 多图参考：检测到 {len(scene_images)} 张去重后场景图，自动按相邻两图分段；每段强制走首尾帧源工作流，并自动启用转场 LoRA（共 {len(scene_images)-1} 段）。")
			try:
				print(f"[GJJ LTX2.3 Clean v40] auto segmented workflow: deduped_scene_count={len(scene_images)}", flush=True)
			except Exception:
				pass

		if use_segmented:
			segment_count = len(scene_images) - 1
			_send_status(unique_id, f"准备分段执行：共 {segment_count} 段，将逐段保存并推送预览。")
			segment_frames: list[torch.Tensor] = []
			segment_audios: list[dict[str, Any] | None] = []
			segment_previews: list[dict[str, Any]] = []
			previous_time = 0.0
			fallback_segment_duration = max(0.1, float(duration_seconds or 0.0) / float(max(1, segment_count)))

			for segment_index in range(1, segment_count + 1):
				end_time = float(base_guide_times[segment_index - 1]) if segment_index - 1 < len(base_guide_times) else previous_time + fallback_segment_duration
				segment_duration = max(0.1, end_time - previous_time)
				previous_time = end_time
				segment_label = f"分段 第{segment_index}段（共{segment_count}段）"
				segment_route_label = f"首尾帧分段（场景{segment_index}→场景{segment_index + 1}）"
				# Clean v40：多图分段的每一段本质都是“相邻两张图首尾帧”。
				# 必须走 first_last_workflow，才能调用真实 GJJ_LTX_FirstLastFrame / GJJ_LTX2NAG、
				# LTXVImgToVideoInplace、源工作流 sigmas 和自动转场 LoRA。
				segment_branch_kind = "first_last_workflow"
				try:
					print(f"[GJJ LTX2.3 Clean v40] multiframe segment {segment_index}/{segment_count}: forcing first_last_workflow + transition LoRA", flush=True)
				except Exception:
					pass
				result = _render_once(
					render_main_image=scene_images[segment_index - 1],
					render_guide_images=[scene_images[segment_index]],
					render_guide_times=[segment_duration],
					render_duration_seconds=segment_duration,
					render_mode=mode,
					render_input_audio=None,
					render_seed=int(seed) + (segment_index - 1) * 2,
					render_frame_trim_start=frame_trim_start,
					render_route_label=segment_route_label,
					render_branch_kind=segment_branch_kind,
					render_segment_index=segment_index,
					status_prefix=segment_label,
				)
				segment_frames.append(result["frames"])
				segment_audios.append(result["audio"])
				preview = _save_segment_video_preview(
					frames=result["frames"],
					audio=result["audio"],
					fps=fps,
					save_preset=segment_save_preset,
					format_name=segment_video_format,
					unique_id=unique_id,
					segment_index=segment_index,
					segment_count=segment_count,
					start_index=segment_index,
					end_index=segment_index + 1,
					output_width=result["output_width"],
					output_height=result["output_height"],
				)
				segment_previews.append(preview)
				_send_status(unique_id, f"已保存第 {segment_index} 段（共 {segment_count} 段）：{preview.get('path') or '输出文件'}")
				_maybe_purge_vram()

			combined_frames = torch.cat(segment_frames, dim=0).contiguous()
			combined_audio = _concat_audio_segments(segment_audios)
			final_video = _create_video(combined_frames, float(fps), combined_audio)
			audio_label = "模型生成音轨" if combined_audio is not None else "静音输出"
			output_width = int(combined_frames.shape[2])
			output_height = int(combined_frames.shape[1])
			_send_status(unique_id, f"完成：{route_label}（分段执行 {segment_count} 段）/ 合并输出 {output_width}x{output_height} / {int(combined_frames.shape[0])} 帧 / {audio_label}")
			_send_status(unique_id, f"最终输出尺寸：{output_width}x{output_height}")
			return {
				"ui": {
					"segment_videos": segment_previews,
					"preview_segments": segment_previews,
				},
				"result": (final_video,),
			}

		resolved_branch_kind = "first_last_workflow" if (mode != MODE_AUDIO_CONDITIONED and visual_scene_count == 2) else "default"
		try:
			print(f"[GJJ LTX2.3 Clean v40] resolved_branch_kind={resolved_branch_kind}, visual_scene_count={visual_scene_count}, route_label={route_label}", flush=True)
		except Exception:
			pass
		result = _render_once(
			render_main_image=main_image,
			render_guide_images=base_guide_images,
			render_guide_times=base_guide_times,
			render_duration_seconds=duration_seconds,
			render_mode=mode,
			render_input_audio=input_audio,
			render_seed=int(seed),
			render_frame_trim_start=frame_trim_start,
			render_route_label=route_label,
			render_branch_kind=resolved_branch_kind,
		)
		if mode == MODE_AUDIO_CONDITIONED:
			audio_label = "外部音频驱动"
		elif bool(decode_generated_audio):
			audio_label = "模型生成音轨"
		else:
			audio_label = "静音输出"
		_send_status(unique_id, f"完成：{route_label} / 有效场景 {visual_scene_count} 张 / {result['output_width']}x{result['output_height']} / {result['output_frame_count']} 帧 / {audio_label}")
		_send_status(unique_id, f"最终输出尺寸：{result['output_width']}x{result['output_height']}")
		return (result["video"],)

	try:
		return _execute()
	finally:
		_aggressive_purge_runtime()
