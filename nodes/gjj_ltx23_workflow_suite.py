from __future__ import annotations

import math
from fractions import Fraction
from typing import Any, Iterable

import comfy.sd
import comfy.utils
import folder_paths
import torch
import torch.nn.functional as F
from comfy.ldm.lightricks.vae.audio_vae import AudioVAE
from comfy_api.latest import InputImpl, Types
from comfy_extras.nodes_custom_sampler import CFGGuider, KSamplerSelect, ManualSigmas, RandomNoise, SamplerCustomAdvanced
from comfy_extras.nodes_hunyuan import LatentUpscaleModelLoader
from comfy_extras.nodes_lt import EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVConditioning, LTXVCropGuides, LTXVSeparateAVLatent
from comfy_extras.nodes_lt_audio import LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAEEncode, LTXVAudioVAELoader, LTXVEmptyLatentAudio
from comfy_extras.nodes_lt_upsampler import LTXVLatentUpsampler
from comfy_extras.nodes_video import CreateVideo, GetVideoComponents
from nodes import CheckpointLoaderSimple, CLIPTextEncode, LoraLoaderModelOnly, VAEDecodeTiled

from .model_name_resolver import model_basename, pick_available_model_name
from .multi_lora_chain import apply_lora_chain_config, normalize_lora_chain_data


DEFAULT_CKPT_CANDIDATES = (
	"ltx-2.3-22b",
	"ltx-2.3-22b-dev-fp8.safetensors",
	"ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled.safetensors",
	"ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled_v3.safetensors",
	"ltx-2-3-22b-dev_transformer_only_fp8_input_scaled.safetensors",
)
DEFAULT_TEXT_ENCODER_CANDIDATES = (
	"gemma_3_12B_it_fp8_e4m3fn.safetensors",
	"gemma_3_12B_it_fp8_scaled.safetensors",
	"gemma_3_12B_it.safetensors",
	"gemma_3_12B_it_fp4_mixed.safetensors",
)
DEFAULT_TEXT_ENCODER_1 = DEFAULT_TEXT_ENCODER_CANDIDATES[0]
DEFAULT_TEXT_ENCODER_2 = "ltx-2.3_text_projection_bf16.safetensors"
DEFAULT_VIDEO_VAE = "LTX23_video_vae_bf16.safetensors"
DEFAULT_AUDIO_VAE = "LTX23_audio_vae_bf16.safetensors"
DEFAULT_UPSCALER = "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
DEFAULT_NEGATIVE = ""
DEFAULT_FPS = 24
DEFAULT_DURATION = 5.0
DEFAULT_LONG_EDGE = 1024
DEFAULT_CFG = 1.0
DEFAULT_STAGE1_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
DEFAULT_STAGE2_SIGMAS = "0.85, 0.7250, 0.4219, 0.0"
NO_LORA = "[不使用]"
AUTO_LORA = "[按工作流默认]"


PRESETS: dict[str, dict[str, Any]] = {
	"inpaint": {
		"prompt": "a motorcycle drifting",
		"lora_1": "LTX/ltx23_inpaint_masked_t2v_rank128_v1_10000steps-局部重绘.safetensors",
		"lora_1_strength": 1.0,
		"lora_2": "",
		"lora_2_strength": 0.0,
		"long_edge": 1280,
		"stage1_sampler": "euler_ancestral_cfg_pp",
		"stage2_sampler": "euler_cfg_pp",
		"two_pass": True,
		"compression": 18,
		"require_mask": False,
	},
	"masked_ref_inpaint": {
		"prompt": "Replace the selected object while preserving the original camera motion and lighting.",
		"lora_1": "LTX/ltx23_inpaint_masked_t2v_rank128_v1_10000steps-局部重绘.safetensors",
		"lora_1_strength": 1.0,
		"lora_2": "",
		"lora_2_strength": 0.0,
		"long_edge": 960,
		"stage1_sampler": "euler_ancestral_cfg_pp",
		"stage2_sampler": "euler_cfg_pp",
		"two_pass": True,
		"compression": 18,
		"require_mask": False,
	},
	"edit_anything": {
		"prompt": "Remove the car in the background",
		"lora_1": "LTX/ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
		"lora_1_strength": 0.5,
		"lora_2": "LTX/ltx23_edit_anything_global_rank128_v1_6000steps_prodigy.safetensors",
		"lora_2_strength": 1.0,
		"long_edge": 1024,
		"stage1_sampler": "euler_ancestral_cfg_pp",
		"stage2_sampler": "euler_cfg_pp",
		"two_pass": False,
		"compression": 0,
		"require_mask": False,
	},
	"anime2real": {
		"prompt": "Convert this video to a photorealistic style.",
		"lora_1": "LTX/ltx23_anime2real_rank64_v1_4500-动画变真实.safetensors",
		"lora_1_strength": 1.0,
		"lora_2": "",
		"lora_2_strength": 0.0,
		"long_edge": 1024,
		"stage1_sampler": "euler_ancestral_cfg_pp",
		"stage2_sampler": "euler_cfg_pp",
		"two_pass": False,
		"compression": 0,
		"require_mask": False,
	},
	"anime_real_switch": {
		"prompt": "Convert this video to a photorealistic style.",
		"lora_1": "LTX/ltx23_anime2real_rank64_v1_4500-动画变真实.safetensors",
		"lora_1_strength": 1.0,
		"lora_2": "",
		"lora_2_strength": 0.0,
		"long_edge": 1024,
		"stage1_sampler": "euler_ancestral_cfg_pp",
		"stage2_sampler": "euler_cfg_pp",
		"two_pass": False,
		"compression": 0,
		"require_mask": False,
	},
}


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
	if not unique_id:
		return
	try:
		from server import PromptServer

		payload = {"node": str(unique_id), "text": str(text or "")}
		if progress is not None:
			payload["progress"] = max(0.0, min(1.0, float(progress)))
		PromptServer.instance.send_sync("gjj_node_progress", payload)
	except Exception:
		pass


def _normalize_text(text: str) -> str:
	return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _lookup_tokens(text: str) -> list[str]:
	return [_normalize_text(part) for part in str(text or "").replace("\\", "/").replace("_", " ").replace("-", " ").replace(".", " ").split() if _normalize_text(part)]


def _safe_filename_list(category: str) -> list[str]:
	try:
		return list(folder_paths.get_filename_list(category))
	except Exception:
		return []


def _basename(name: str) -> str:
	return model_basename(name)


def _pick_available_name(preferred: str, available: Iterable[str], fallback: str = "") -> str:
	names = list(available or [])
	return pick_available_model_name(preferred, names, fallback, allow_first=False)


def _require_model_name(category: str, preferred: str, label: str, fallback: str = "") -> str:
	available = _safe_filename_list(category)
	resolved = _pick_available_name(preferred, available, fallback)
	if not resolved or not folder_paths.get_full_path(category, resolved):
		raise RuntimeError(f"未找到{label}：{preferred or fallback}。请确认文件在 models/{category} 或其子目录中。")
	return resolved


def _first_candidate(category: str, candidates: Iterable[str], label: str) -> str:
	available = _safe_filename_list(category)
	for candidate in candidates:
		resolved = _pick_available_name(candidate, available)
		if resolved and folder_paths.get_full_path(category, resolved):
			return resolved
	raise RuntimeError(f"未找到{label}，候选：{' / '.join(str(x) for x in candidates)}")


def _lora_choices(defaults: Iterable[str]) -> list[str]:
	available = _safe_filename_list("loras")
	filtered = [name for name in available if "ltx" in _normalize_text(name) or any(_normalize_text(_basename(d)) in _normalize_text(name) for d in defaults if d)] or available
	return [AUTO_LORA, NO_LORA] + filtered


def _default_lora_choice(default_name: str, available_choices: list[str]) -> str:
	default_name = str(default_name or "").strip()
	if not default_name:
		return NO_LORA
	candidates = [name for name in available_choices if name not in (AUTO_LORA, NO_LORA)]
	resolved = pick_available_model_name(default_name, candidates, "", allow_first=False)
	return resolved or AUTO_LORA


def _filtered_model_choices(category: str, keywords: Iterable[str], fallbacks: Iterable[str]) -> list[str]:
	available = _safe_filename_list(category)
	normalized_keywords = [_normalize_text(item) for item in keywords if _normalize_text(item)]
	if normalized_keywords:
		filtered = [
			name
			for name in available
			if any(keyword in _normalize_text(name) for keyword in normalized_keywords)
		]
	else:
		filtered = list(available)
	for fallback in fallbacks:
		resolved = _pick_available_name(str(fallback or ""), available, "")
		if resolved and resolved not in filtered:
			filtered.append(resolved)
	return filtered or list(fallbacks) or available or [""]


def _ltx_checkpoint_choices() -> list[str]:
	return _filtered_model_choices("checkpoints", ("ltx23", "ltx2.3", "ltx"), DEFAULT_CKPT_CANDIDATES)


def _ltx_text_encoder_choices() -> list[str]:
	return _filtered_model_choices("text_encoders", ("gemma3", "gemma_3"), DEFAULT_TEXT_ENCODER_CANDIDATES)


def _ltx_projection_choices() -> list[str]:
	return _filtered_model_choices("text_encoders", ("textprojection", "projection"), (DEFAULT_TEXT_ENCODER_2,))


def _require_ltx_text_encoder_name(preferred: str, label: str) -> str:
	choices = _ltx_text_encoder_choices()
	resolved = _pick_available_name(preferred, choices, "")
	if not resolved:
		resolved = _pick_available_name(DEFAULT_TEXT_ENCODER_1, choices, DEFAULT_TEXT_ENCODER_CANDIDATES[1])
	if not resolved or not folder_paths.get_full_path("text_encoders", resolved):
		raise RuntimeError(f"未找到{label}：{DEFAULT_TEXT_ENCODER_1}。请确认 Gemma 文本编码器在 models/text_encoders 或其子目录中。")
	return resolved


def _round_to_multiple(value: float, step: int = 32, minimum: int = 64) -> int:
	return max(int(minimum), int(round(float(value) / float(step)) * int(step)))


def _frame_count_from_duration(duration: float, fps: int) -> int:
	frames = int((float(duration) * float(max(1, fps))) // 8) * 8 + 1
	return max(9, frames)


def _ensure_video_frames(video: torch.Tensor | None) -> torch.Tensor:
	if video is None:
		raise RuntimeError("请连接输入视频。")
	if not isinstance(video, torch.Tensor):
		raise RuntimeError("输入视频拆出的帧格式无效，应为 IMAGE 批次。")
	if video.ndim == 3:
		video = video.unsqueeze(0)
	if video.ndim != 4 or int(video.shape[0]) <= 0:
		raise RuntimeError(f"输入视频拆出的帧维度无效：{tuple(video.shape)}")
	return video


def _extract_video_components(video: Any) -> tuple[torch.Tensor, dict[str, Any] | None, float | None]:
	if isinstance(video, torch.Tensor):
		return _ensure_video_frames(video), None, None
	if video is None:
		raise RuntimeError("请连接输入视频。可使用 ComfyUI 核心 Load Video 或其他 VIDEO 输出接入。")
	try:
		frames, audio, frame_rate = GetVideoComponents.execute(video)[0:3]
	except Exception as exc:
		raise RuntimeError(f"读取 VIDEO 输入失败，请确认接入的是视频对象。\n详细错误：{exc}") from exc
	return _ensure_video_frames(frames), audio, float(frame_rate)


def _resize_video_long_edge(video: torch.Tensor, long_edge: int) -> tuple[torch.Tensor, int, int]:
	video = _ensure_video_frames(video)
	height = int(video.shape[1])
	width = int(video.shape[2])
	if width >= height:
		target_width = int(long_edge)
		target_height = max(64, round(height * (target_width / max(1, width))))
	else:
		target_height = int(long_edge)
		target_width = max(64, round(width * (target_height / max(1, height))))
	target_width = _round_to_multiple(target_width, 32, 64)
	target_height = _round_to_multiple(target_height, 32, 64)
	resized = comfy.utils.common_upscale(video.movedim(-1, 1), target_width, target_height, "lanczos", "center").movedim(1, -1)
	return resized.contiguous(), target_width, target_height


def _load_vae_from_category(name: str):
	path = folder_paths.get_full_path("vae", name)
	if not path:
		raise RuntimeError(f"未找到 VAE：{name}")
	sd, metadata = comfy.utils.load_torch_file(path, return_metadata=True)
	vae = comfy.sd.VAE(sd=sd, metadata=metadata, dtype=None)
	vae.throw_exception_if_invalid()
	return vae


def _load_audio_vae(name: str):
	path = folder_paths.get_full_path("vae", name)
	if not path:
		raise RuntimeError(f"未找到音频 VAE：{name}")
	sd, metadata = comfy.utils.load_torch_file(path, return_metadata=True)
	return AudioVAE(sd, metadata)


def _empty_audio() -> dict[str, Any]:
	return {"waveform": torch.zeros((1, 2, 1), dtype=torch.float32), "sample_rate": 44100}


def _has_audio(audio: Any) -> bool:
	return isinstance(audio, dict) and audio.get("waveform") is not None and int(audio.get("sample_rate", 0) or 0) > 0


def _prepare_mask(mask: Any, target_frames: int, target_height: int, target_width: int, device: torch.device, dtype: torch.dtype) -> torch.Tensor | None:
	if mask is None:
		return None
	if isinstance(mask, torch.Tensor):
		mask_tensor = mask.float()
	else:
		mask_tensor = torch.as_tensor(mask, dtype=torch.float32)
	if mask_tensor.ndim == 2:
		mask_tensor = mask_tensor.unsqueeze(0)
	if mask_tensor.ndim == 4:
		mask_tensor = mask_tensor[:, 0]
	if mask_tensor.ndim != 3:
		raise RuntimeError(f"遮罩维度无效：{tuple(mask_tensor.shape)}")
	if int(mask_tensor.shape[0]) == 1 and target_frames > 1:
		mask_tensor = mask_tensor.repeat(target_frames, 1, 1)
	elif int(mask_tensor.shape[0]) < target_frames:
		repeats = int(math.ceil(target_frames / max(1, int(mask_tensor.shape[0]))))
		mask_tensor = mask_tensor.repeat(repeats, 1, 1)[:target_frames]
	else:
		mask_tensor = mask_tensor[:target_frames]
	mask_tensor = F.interpolate(mask_tensor.unsqueeze(1), size=(target_height, target_width), mode="bilinear", align_corners=False)
	mask_tensor = mask_tensor.clamp(0.0, 1.0).to(device=device, dtype=dtype)
	return mask_tensor


def _apply_latent_mask(latent: dict[str, Any], mask: Any) -> dict[str, Any]:
	if mask is None:
		return latent
	samples = latent["samples"]
	if samples.ndim != 5:
		return latent
	batch, _, frames, height, width = samples.shape
	mask_tensor = _prepare_mask(mask, frames, height, width, samples.device, samples.dtype)
	if mask_tensor is None:
		return latent
	if int(mask_tensor.shape[0]) != frames:
		mask_tensor = mask_tensor[:frames]
	noise_mask = mask_tensor.movedim(0, 1).unsqueeze(0).expand(batch, -1, -1, -1, -1).contiguous()
	updated = dict(latent)
	updated["noise_mask"] = noise_mask
	return updated


class _LTX23WorkflowRunner:
	def __init__(self):
		self.loaded_lora: tuple[str, Any] | None = None

	def _load_models(self, unet_name: str, text_encoder_1: str, text_encoder_2: str, video_vae_name: str, audio_vae_name: str, upscaler_name: str):
		resolved_ckpt = _require_model_name("checkpoints", unet_name, "LTX 主模型 checkpoint", DEFAULT_CKPT_CANDIDATES[0])
		resolved_text_1 = _require_ltx_text_encoder_name(text_encoder_1, "Gemma 文本编码器")
		resolved_video_vae = _require_model_name("vae", video_vae_name, "视频 VAE", DEFAULT_VIDEO_VAE)
		resolved_upscaler = _require_model_name("latent_upscale_models", upscaler_name, "latent 放大模型", DEFAULT_UPSCALER)
		model, _, _ = CheckpointLoaderSimple().load_checkpoint(resolved_ckpt)
		clip = LTXAVTextEncoderLoader.execute(resolved_text_1, resolved_ckpt, "default")[0]
		video_vae = _load_vae_from_category(resolved_video_vae)
		audio_vae = LTXVAudioVAELoader.execute(resolved_ckpt)[0]
		upscaler = LatentUpscaleModelLoader.execute(resolved_upscaler)[0]
		return model, clip, video_vae, audio_vae, upscaler

	def _apply_loras(self, model, lora_1: str, strength_1: float, lora_2: str, strength_2: float, defaults: dict[str, Any]):
		available = _safe_filename_list("loras")
		loader = LoraLoaderModelOnly()
		for idx, (selection, strength, default_key) in enumerate(((lora_1, strength_1, "lora_1"), (lora_2, strength_2, "lora_2")), start=1):
			if str(selection or "").strip() == NO_LORA or float(strength) == 0:
				continue
			preferred = str(defaults.get(default_key, "") if str(selection or "").strip() in ("", AUTO_LORA) else selection)
			if not preferred:
				continue
			resolved = pick_available_model_name(preferred, available, allow_first=False)
			if not resolved or not folder_paths.get_full_path("loras", resolved):
				raise RuntimeError(f"未找到 LoRA {idx}：{preferred}。已按子目录、文件名和关键词模糊搜索。")
			model = loader.load_lora_model_only(model, resolved, float(strength))[0]
		return model

	def run(
		self,
		preset_key: str,
		prompt: str,
		negative_prompt: str,
		unet_name: str,
		text_encoder_1: str,
		text_encoder_2: str,
		video_vae_name: str,
		audio_vae_name: str,
		upscaler_name: str,
		lora_1_name: str,
		lora_1_strength: float,
		lora_2_name: str,
		lora_2_strength: float,
		duration_seconds: float,
		fps: int,
		long_edge: int,
		seed: int,
		input_video=None,
		input_mask=None,
		reference_image=None,
		input_audio=None,
		lora_chain_config="",
		unique_id=None,
	):
		preset = dict(PRESETS[preset_key])
		frames, video_audio, video_fps = _extract_video_components(input_video)
		fps = max(1, int(round(float(video_fps)))) if video_fps and video_fps > 0 else max(1, int(fps))
		if input_audio is None and _has_audio(video_audio):
			input_audio = video_audio
		frame_count = min(int(frames.shape[0]), _frame_count_from_duration(float(duration_seconds), fps))
		frame_count = max(1, frame_count)
		frames = frames[:frame_count]
		_send_status(unique_id, "1/8 加载 LTX 模型、VAE 和 LoRA...", 0.05)
		try:
			model, clip, video_vae, audio_vae, upscaler = self._load_models(unet_name, text_encoder_1, text_encoder_2, video_vae_name, audio_vae_name, upscaler_name)
			model = self._apply_loras(model, lora_1_name, lora_1_strength, lora_2_name, lora_2_strength, preset)
			if str(lora_chain_config or "").strip():
				model, clip, self.loaded_lora = apply_lora_chain_config(
					model,
					clip,
					lora_data=normalize_lora_chain_data(lora_chain_config),
					loaded_lora_cache=self.loaded_lora,
				)
		except Exception as exc:
			raise RuntimeError(f"LTX 工作流节点加载资源失败。\n详细错误：{exc}") from exc

		_send_status(unique_id, "2/8 预处理输入视频帧...", 0.16)
		try:
			control_video, out_width, out_height = _resize_video_long_edge(frames, int(long_edge))
			compression = int(preset.get("compression", 0))
			if compression > 0:
				from comfy_extras.nodes_lt import LTXVPreprocess

				control_video = LTXVPreprocess.execute(control_video, compression)[0]
			low_width = max(64, _round_to_multiple(out_width / (2 if preset.get("two_pass") else 1), 32, 64))
			low_height = max(64, _round_to_multiple(out_height / (2 if preset.get("two_pass") else 1), 32, 64))
		except Exception as exc:
			raise RuntimeError(f"LTX 工作流节点预处理视频失败。\n详细错误：{exc}") from exc

		_send_status(unique_id, "3/8 编码提示词与参考约束...", 0.28)
		try:
			positive_text = str(prompt or "").strip() or str(preset.get("prompt", ""))
			negative_text = str(negative_prompt or "").strip()
			positive = CLIPTextEncode().encode(clip, positive_text)[0]
			negative = CLIPTextEncode().encode(clip, negative_text)[0]
			positive, negative = LTXVConditioning.execute(positive, negative, float(fps))[0:2]
			video_latent = EmptyLTXVLatentVideo.execute(low_width, low_height, frame_count, 1)[0]
			positive, negative, video_latent = LTXVAddGuide.execute(positive, negative, video_vae, video_latent, control_video, 0, 1.0)[0:3]
			if reference_image is not None:
				ref = _ensure_video_frames(reference_image)[:1]
				positive, negative, video_latent = LTXVAddGuide.execute(positive, negative, video_vae, video_latent, ref, 0, 1.0)[0:3]
			positive, negative, video_latent = LTXVCropGuides.execute(positive, negative, video_latent)[0:3]
			video_latent = _apply_latent_mask(video_latent, input_mask)
		except Exception as exc:
			raise RuntimeError(f"LTX 工作流节点建立视频约束失败。\n详细错误：{exc}") from exc

		_send_status(unique_id, "4/8 构建音频 latent...", 0.38)
		try:
			if _has_audio(input_audio):
				audio_latent = LTXVAudioVAEEncode.execute(input_audio, audio_vae)[0]
				output_audio = input_audio
			else:
				audio_latent = LTXVEmptyLatentAudio.execute(frame_count, fps, 1, audio_vae)[0]
				output_audio = None
			av_latent = LTXVConcatAVLatent.execute(video_latent, audio_latent)[0]
		except Exception as exc:
			raise RuntimeError(f"LTX 工作流节点构建音频 latent 失败。\n详细错误：{exc}") from exc

		_send_status(unique_id, "5/8 第一阶段采样...", 0.50)
		try:
			guider = CFGGuider.execute(model, positive, negative, DEFAULT_CFG)[0]
			sampler = KSamplerSelect.execute(str(preset.get("stage1_sampler", "euler_ancestral_cfg_pp")))[0]
			sigmas = ManualSigmas.execute(DEFAULT_STAGE1_SIGMAS)[0]
			noise = RandomNoise.execute(int(seed))[0]
			av_latent = SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, av_latent)[0]
			video_latent, audio_latent = LTXVSeparateAVLatent.execute(av_latent)[0:2]
		except Exception as exc:
			raise RuntimeError(f"LTX 工作流节点第一阶段采样失败。\n详细错误：{exc}") from exc

		if bool(preset.get("two_pass", False)):
			_send_status(unique_id, "6/8 latent 放大并二次采样...", 0.68)
			try:
				video_latent = LTXVLatentUpsampler().upsample_latent(video_latent, upscaler, video_vae)[0]
				video_latent = _apply_latent_mask(video_latent, input_mask)
				av_latent = LTXVConcatAVLatent.execute(video_latent, audio_latent)[0]
				guider = CFGGuider.execute(model, positive, negative, DEFAULT_CFG)[0]
				sampler = KSamplerSelect.execute(str(preset.get("stage2_sampler", "euler_cfg_pp")))[0]
				sigmas = ManualSigmas.execute(DEFAULT_STAGE2_SIGMAS)[0]
				noise = RandomNoise.execute(42)[0]
				av_latent = SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, av_latent)[0]
				video_latent, audio_latent = LTXVSeparateAVLatent.execute(av_latent)[0:2]
			except Exception as exc:
				raise RuntimeError(f"LTX 工作流节点第二阶段采样失败。\n详细错误：{exc}") from exc
		else:
			_send_status(unique_id, "6/8 当前预设不启用二次放大采样。", 0.68)

		_send_status(unique_id, "7/8 解码视频帧与音频...", 0.86)
		try:
			decoded = VAEDecodeTiled().decode(video_vae, video_latent, 768, 64, 4096, 4)[0]
			if output_audio is None:
				output_audio = LTXVAudioVAEDecode.execute(audio_latent, audio_vae)[0]
		except Exception as exc:
			raise RuntimeError(f"LTX 工作流节点解码失败。\n详细错误：{exc}") from exc

		_send_status(unique_id, "8/8 创建视频对象...", 0.95)
		try:
			video = CreateVideo.execute(decoded, float(fps), output_audio or _empty_audio())[0]
		except Exception:
			video = InputImpl.VideoFromComponents(
				Types.VideoComponents(images=decoded, audio=output_audio or _empty_audio(), frame_rate=Fraction(fps, 1))
			)
		_send_status(unique_id, f"完成：{preset_key} / {int(decoded.shape[2])} x {int(decoded.shape[1])} / {int(decoded.shape[0])} 帧", 1.0)
		return (video,)


class _BaseLTX23WorkflowNode:
	CATEGORY = "GJJ/LTX"
	FUNCTION = "generate"
	RETURN_TYPES = ("VIDEO",)
	RETURN_NAMES = ("视频结果",)
	OUTPUT_TOOLTIPS = ("由 GJJ 本地 LTX2.3 零依赖工作流节点生成的视频。",)
	PRESET_KEY = "edit_anything"
	DESCRIPTION = "GJJ 本地 LTX2.3 工作流封装节点。"

	def __init__(self):
		self._runner = _LTX23WorkflowRunner()

	@classmethod
	def INPUT_TYPES(cls):
		preset = PRESETS[cls.PRESET_KEY]
		unets = _ltx_checkpoint_choices()
		default_unet = _pick_available_name(DEFAULT_CKPT_CANDIDATES[0], unets, DEFAULT_CKPT_CANDIDATES[1])
		texts = _ltx_text_encoder_choices()
		projections = _ltx_projection_choices()
		vaes = _safe_filename_list("vae") or [DEFAULT_VIDEO_VAE, DEFAULT_AUDIO_VAE]
		upscalers = _safe_filename_list("latent_upscale_models") or [DEFAULT_UPSCALER]
		loras = _lora_choices((preset.get("lora_1", ""), preset.get("lora_2", "")))
		default_lora_1 = _default_lora_choice(str(preset.get("lora_1", "")), loras)
		default_lora_2 = _default_lora_choice(str(preset.get("lora_2", "")), loras)
		required = {
			"input_video": ("VIDEO", {"display_name": "输入视频", "tooltip": "必接。连接 ComfyUI 核心 Load Video 或其他 VIDEO 输出；节点会内部拆出视频帧、音频和帧率。"}),
			"prompt": ("STRING", {"default": preset["prompt"], "multiline": True, "dynamicPrompts": True, "display_name": "正向提示词", "tooltip": "描述要执行的视频编辑、修复或风格转换任务。"}),
			"negative_prompt": ("STRING", {"default": DEFAULT_NEGATIVE, "multiline": True, "dynamicPrompts": True, "display_name": "反向提示词", "tooltip": "不需要的画面内容；原工作流默认留空。"}),
			"unet_name": (unets, {"default": default_unet or unets[0], "display_name": "LTX 主模型", "tooltip": "按 LTX2.3 原工作流从 models/checkpoints 加载 checkpoint；旧工作流里误选的 diffusion_models 会在运行时回退到可用 LTX checkpoint。"}),
			"text_encoder_1": (texts, {"default": _pick_available_name(DEFAULT_TEXT_ENCODER_1, texts, DEFAULT_TEXT_ENCODER_1) or texts[0], "display_name": "Gemma文本编码器", "tooltip": "LTX2.3 AV 文本编码器。只列出 Gemma 文本编码器，避免误选 EVA02 等视觉 CLIP 导致 invalid tokenizer。"}),
			"text_encoder_2": (projections, {"default": _pick_available_name(DEFAULT_TEXT_ENCODER_2, projections, DEFAULT_TEXT_ENCODER_2) or projections[0], "display_name": "文本投影兼容项", "tooltip": "兼容旧工作流保存的字段；当前按原 LTX2.3 AV loader 从 checkpoint 读取投影信息，此项不再直接参与加载。"}),
			"video_vae_name": (vaes, {"default": _pick_available_name(DEFAULT_VIDEO_VAE, vaes, DEFAULT_VIDEO_VAE) or vaes[0], "display_name": "视频 VAE", "tooltip": "LTX 视频 VAE，支持子目录。"}),
			"audio_vae_name": (vaes, {"default": _pick_available_name(DEFAULT_AUDIO_VAE, vaes, DEFAULT_AUDIO_VAE) or vaes[0], "display_name": "音频VAE兼容项", "tooltip": "兼容旧工作流保存的字段；当前按原 LTX2.3 AV loader 从主 checkpoint 内加载音频 VAE。"}),
			"upscaler_name": (upscalers, {"default": _pick_available_name(DEFAULT_UPSCALER, upscalers, DEFAULT_UPSCALER) or upscalers[0], "display_name": "latent 放大模型", "tooltip": "二阶段工作流使用的 LTX spatial upscaler。"}),
		}
		if str(preset.get("lora_1", "") or "").strip():
			required["lora_1_name"] = (loras, {"default": default_lora_1, "display_name": "第1组 LoRA", "tooltip": "已按原工作流标配 LoRA 名称做本地子目录/关键词模糊搜索；未找到时才显示 [按工作流默认]。"})
			required["lora_1_strength"] = ("FLOAT", {"default": float(preset.get("lora_1_strength", 1.0)), "min": 0.0, "max": 4.0, "step": 0.05, "display_name": "LoRA 1 强度", "tooltip": "第一条 LoRA 强度。"})
		if str(preset.get("lora_2", "") or "").strip():
			required["lora_2_name"] = (loras, {"default": default_lora_2, "display_name": "第2组 LoRA", "tooltip": "已按原工作流第二条标配 LoRA 名称做本地子目录/关键词模糊搜索。"})
			required["lora_2_strength"] = ("FLOAT", {"default": float(preset.get("lora_2_strength", 1.0)), "min": 0.0, "max": 4.0, "step": 0.05, "display_name": "LoRA 2 强度", "tooltip": "第二条 LoRA 强度。"})
		required.update({
			"duration_seconds": ("FLOAT", {"default": DEFAULT_DURATION, "min": 0.1, "max": 120.0, "step": 0.1, "display_name": "时长秒数", "tooltip": "目标处理时长；会换算为 8n+1 帧，但不会超过输入视频帧数。"}),
			"fps": ("INT", {"default": DEFAULT_FPS, "min": 1, "max": 120, "step": 1, "display_name": "帧率", "tooltip": "输出视频帧率。"}),
			"long_edge": ("INT", {"default": int(preset.get("long_edge", DEFAULT_LONG_EDGE)), "min": 256, "max": 4096, "step": 32, "display_name": "长边分辨率", "tooltip": "输入视频会按长边缩放并对齐到 32 的倍数。"}),
			"seed": ("INT", {"default": 42, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True, "display_name": "种子", "tooltip": "采样随机种子。"}),
		})
		return {
			"required": required,
			"optional": {
				"input_mask": ("MASK", {"display_name": "编辑遮罩", "tooltip": "可选。白色区域参与重绘；不接时走整段视频编辑。"}),
				"reference_image": ("IMAGE", {"display_name": "参考图片", "tooltip": "可选。用于 masked-ref inpaint 的物体或风格参考，也可作为普通参考帧。"}),
				"input_audio": ("AUDIO", {"display_name": "覆盖音频", "tooltip": "可选。留空时优先使用输入视频自带音频；接入后用这里的音频覆盖视频原音轨。"}),
				"lora_chain_config": ("LORA_CHAIN_CONFIG", {"display_name": "LoRA串联配置", "tooltip": "可选。接入 GJJ · LoRA串联配置 后，会在面板第1/第2组标配 LoRA 之后继续按顺序串联追加。"}),
			},
			"hidden": {"unique_id": "UNIQUE_ID"},
		}

	def generate(self, prompt, negative_prompt, unet_name, text_encoder_1, text_encoder_2, video_vae_name, audio_vae_name, upscaler_name, duration_seconds, fps, long_edge, seed, lora_1_name=NO_LORA, lora_1_strength=0.0, lora_2_name=NO_LORA, lora_2_strength=0.0, input_video=None, input_mask=None, reference_image=None, input_audio=None, lora_chain_config="", unique_id=None):
		return self._runner.run(
			self.PRESET_KEY,
			prompt,
			negative_prompt,
			unet_name,
			text_encoder_1,
			text_encoder_2,
			video_vae_name,
			audio_vae_name,
			upscaler_name,
			lora_1_name,
			float(lora_1_strength),
			lora_2_name,
			float(lora_2_strength),
			float(duration_seconds),
			int(fps),
			int(long_edge),
			int(seed),
			input_video=input_video,
			input_mask=input_mask,
			reference_image=reference_image,
			input_audio=input_audio,
			lora_chain_config=lora_chain_config,
			unique_id=unique_id,
		)


class GJJ_LTX23InpaintWorkflow(_BaseLTX23WorkflowNode):
	PRESET_KEY = "inpaint"
	DESCRIPTION = "将 ltx23_inpaint_v1 工作流封装为 GJJ 零外部自定义节点依赖的视频 inpaint 节点。"
	SEARCH_ALIASES = ["ltx23 inpaint", "视频重绘", "inpaint video"]


class GJJ_LTX23MaskedRefInpaintWorkflow(_BaseLTX23WorkflowNode):
	PRESET_KEY = "masked_ref_inpaint"
	DESCRIPTION = "将 ltx23_masked_ref_inpaint_v1 工作流封装为 GJJ 零外部自定义节点依赖的参考物体遮罩重绘节点。"
	SEARCH_ALIASES = ["ltx23 masked ref", "参考物体重绘", "masked reference inpaint"]


class GJJ_LTX23EditAnythingWorkflow(_BaseLTX23WorkflowNode):
	PRESET_KEY = "edit_anything"
	DESCRIPTION = "将 ltx23_edit_anything_v1.1 工作流封装为 GJJ 零外部自定义节点依赖的视频任意编辑节点。"
	SEARCH_ALIASES = ["ltx23 edit anything", "任意编辑", "视频编辑"]


class GJJ_LTX23Anime2RealWorkflow(_BaseLTX23WorkflowNode):
	PRESET_KEY = "anime2real"
	DESCRIPTION = "将 ltx23_anime2real_v1 工作流封装为 GJJ 零外部自定义节点依赖的动漫转写实视频节点。"
	SEARCH_ALIASES = ["anime2real", "动漫转写实", "动漫转真人"]


class GJJ_LTX23AnimeRealSwitchWorkflow(_BaseLTX23WorkflowNode):
	PRESET_KEY = "anime_real_switch"
	DESCRIPTION = "将 ltx23_anime2real_or_real2anime_v1 工作流封装为 GJJ 零外部自定义节点依赖的动漫/写实互转视频节点。"
	SEARCH_ALIASES = ["anime real switch", "动漫写实互转", "real2anime"]


NODE_CLASS_MAPPINGS = {
	"GJJ_LTX23InpaintWorkflow": GJJ_LTX23InpaintWorkflow,
	"GJJ_LTX23MaskedRefInpaintWorkflow": GJJ_LTX23MaskedRefInpaintWorkflow,
	"GJJ_LTX23EditAnythingWorkflow": GJJ_LTX23EditAnythingWorkflow,
	"GJJ_LTX23Anime2RealWorkflow": GJJ_LTX23Anime2RealWorkflow,
	"GJJ_LTX23AnimeRealSwitchWorkflow": GJJ_LTX23AnimeRealSwitchWorkflow,
}

NODE_DISPLAY_NAME_MAPPINGS = {
	"GJJ_LTX23InpaintWorkflow": "GJJ · 🎞️ LTX视频重绘",
	"GJJ_LTX23MaskedRefInpaintWorkflow": "GJJ · 🧩 LTX参考物体重绘",
	"GJJ_LTX23EditAnythingWorkflow": "GJJ · ✏️ LTX任意编辑",
	"GJJ_LTX23Anime2RealWorkflow": "GJJ · 🎨 LTX动漫转写实",
	"GJJ_LTX23AnimeRealSwitchWorkflow": "GJJ · 🔁 LTX动漫写实互转",
}
