"""GJJ 内置音频工具模块。

将 comfy_extras.nodes_lt_audio、nodes_audio 等音频相关节点功能内置，避免外部依赖。

包含：
- LTX 音频编解码 (LTXAVTextEncoderLoader, LTXVAudioVAEDecode/Encode, etc.)
- 通用音频处理 (vae_decode_audio)

注意：本模块为自包含实现，不导入任何节点相关代码。
"""

from __future__ import annotations

from typing import Any

import torch


# ============================================================================
# LTX 音频 VAE 相关
# ============================================================================

class gjjutils_LTXVEmptyLatentAudio:
	"""LTXVEmptyLatentAudio 节点功能内置实现。

	创建空的音频 latent，与 ComfyUI 原生接口完全兼容。
	必须提供有效的音频 VAE 以获取 latent 配置参数。
	"""

	@staticmethod
	def execute(
		frames_number: int = 1,
		frame_rate: int = 24,
		batch_size: int = 1,
		audio_vae: Any = None,
	) -> tuple[dict[str, Any]]:
		"""创建空音频 latent。

		使用音频 VAE 的 first_stage_model 获取 latent 配置，
		生成 4 维 latent: [B, z_channels, num_audio_latents, audio_freq]

		Args:
			frames_number: 目标帧数
			frame_rate: 帧率（默认 24）
			batch_size: 批次大小（默认 1）
			audio_vae: 音频 VAE 对象（必需，用于获取 latent 配置）

		Returns:
			包含 'samples'、'sample_rate'、'type' 键的字典的单元素元组
		"""
		import comfy.model_management

		if audio_vae is None:
			raise RuntimeError("LTXVEmptyLatentAudio: 音频 VAE 模型为必选项，请确保已下载并放置了对应的音频 VAE 模型。")

		z_channels = audio_vae.latent_channels
		audio_freq = audio_vae.first_stage_model.latent_frequency_bins
		sampling_rate = int(audio_vae.first_stage_model.sample_rate)
		num_audio_latents = audio_vae.first_stage_model.num_of_latents_from_frames(int(frames_number), int(frame_rate))

		audio_latents = torch.zeros(
			(int(batch_size), z_channels, num_audio_latents, audio_freq),
			device=comfy.model_management.intermediate_device(),
		)

		return ({"samples": audio_latents, "sample_rate": sampling_rate, "type": "audio"},)


class gjjutils_LTXVAudioVAELoader:
	"""LTXVAudioVAELoader 节点功能内置实现。

	加载音频 VAE 模型，与 ComfyUI 原生接口完全兼容。
	"""

	@staticmethod
	def execute(
		ckpt_name: str,
	) -> tuple[Any]:
		"""加载音频 VAE 模型。

		Args:
			ckpt_name: 音频 VAE checkpoint 文件名

		Returns:
			包含 VAE 对象的单元素元组
		"""
		import folder_paths
		import comfy.utils
		import comfy.sd

		ckpt_path = folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)
		sd, metadata = comfy.utils.load_torch_file(ckpt_path, return_metadata=True)
		sd = comfy.utils.state_dict_prefix_replace(sd, {"audio_vae.": "autoencoder.", "vocoder.": "vocoder."}, filter_keys=True)
		vae = comfy.sd.VAE(sd=sd, metadata=metadata)
		vae.throw_exception_if_invalid()
		return (vae,)


class gjjutils_LTXVAudioVAEEncode:
	"""LTXVAudioVAEEncode 节点功能内置实现。

	将音频波形编码为 latent，与 ComfyUI 原生接口完全兼容。
	"""

	@staticmethod
	def execute(
		audio: dict[str, Any],
		audio_vae: Any,
	) -> tuple[dict[str, Any]]:
		"""编码音频到 latent。

		Args:
			audio: 音频字典，包含 waveform [C, T] 和 sample_rate
			audio_vae: 音频 VAE 模型对象

		Returns:
			包含 'samples' 键的 latent 字典单元素元组
		"""
		import torchaudio

		sample_rate = audio["sample_rate"]
		vae_sample_rate = getattr(audio_vae, "audio_sample_rate", 44100)
		if vae_sample_rate != sample_rate:
			waveform = torchaudio.functional.resample(audio["waveform"], sample_rate, vae_sample_rate)
		else:
			waveform = audio["waveform"]

		t = audio_vae.encode(waveform.movedim(1, -1))
		return ({"samples": t},)


class gjjutils_LTXVAudioVAEDecode:
	"""LTXVAudioVAEDecode 节点功能内置实现。
	
	将音频 latent 解码为波形。
	"""
	
	@staticmethod
	def execute(
		vae: dict[str, Any],
		samples: dict[str, torch.Tensor],
	) -> dict[str, torch.Tensor]:
		"""解码 latent 到音频波形。
		
		Args:
			vae: 音频 VAE 模型
			samples: 音频 latent
			
		Returns:
			解码后的音频波形
		"""
		if "samples" not in samples:
			raise RuntimeError("LTXVAudioVAEDecode: 输入缺少 'samples' 键")
		
		# 这是一个占位实现
		# 实际需要加载 VAE 模型并执行解码
		raise NotImplementedError(
			"LTXVAudioVAEDecode: 完整实现需要集成音频 VAE 模型。"
			"当前版本建议使用 ComfyUI 原生的 LTXVAudioVAEDecode 节点。"
		)


class gjjutils_LTXAVTextEncoderLoader:
	"""LTXAVTextEncoderLoader 节点功能内置实现。

	加载 LTXV 音频文本编码器（CLIP），与 ComfyUI 原生接口完全兼容。
	"""

	@staticmethod
	def execute(
		text_encoder: str,
		ckpt_name: str,
		device: str = "default",
	) -> tuple[Any]:
		"""加载 LTXV CLIP 模型。

		Args:
			text_encoder: 文本编码器文件名
			ckpt_name: 主模型 checkpoint 文件名
			device: 设备选项，"default" 或 "cpu"

		Returns:
			包含 clip 模型的单元素元组
		"""
		import folder_paths
		import comfy.sd

		clip_path1 = folder_paths.get_full_path_or_raise("text_encoders", text_encoder)
		clip_path2 = folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)

		model_options = {}
		if device == "cpu":
			model_options["load_device"] = model_options["offload_device"] = torch.device("cpu")

		clip = comfy.sd.load_clip(
			ckpt_paths=[clip_path1, clip_path2],
			embedding_directory=folder_paths.get_folder_paths("embeddings"),
			clip_type=comfy.sd.CLIPType.LTXV,
			model_options=model_options,
		)
		return (clip,)


# ============================================================================
# 通用音频处理
# ============================================================================

class gjjutils_vae_decode_audio:
	"""vae_decode_audio 节点功能内置实现。
	
	使用 VAE 解码音频。
	"""
	
	@staticmethod
	def execute(
		vae: dict[str, Any],
		samples: dict[str, torch.Tensor],
	) -> dict[str, torch.Tensor]:
		"""解码音频。
		
		Args:
			vae: VAE 模型
			samples: 音频 latent
			
		Returns:
			解码后的音频波形
		"""
		if "samples" not in samples:
			raise RuntimeError("vae_decode_audio: 输入缺少 'samples' 键")
		
		# 这是一个占位实现
		raise NotImplementedError(
			"vae_decode_audio: 完整实现需要集成音频 VAE 模型。"
			"当前版本建议使用 ComfyUI 原生的 vae_decode_audio 节点。"
		)


# ============================================================================
# 导出兼容接口（支持两种调用方式）
# ============================================================================

# 方式1：类方法调用（保持与 comfy_extras 一致）
LTXVEmptyLatentAudio = gjjutils_LTXVEmptyLatentAudio
LTXVAudioVAELoader = gjjutils_LTXVAudioVAELoader
LTXVAudioVAEEncode = gjjutils_LTXVAudioVAEEncode
LTXVAudioVAEDecode = gjjutils_LTXVAudioVAEDecode
LTXAVTextEncoderLoader = gjjutils_LTXAVTextEncoderLoader
vae_decode_audio = gjjutils_vae_decode_audio

# 方式2：函数调用（备用）
def LTXVEmptyLatentAudio_execute(frames_number: int = 1, frame_rate: int = 24, batch_size: int = 1, audio_vae: Any = None) -> tuple[dict[str, Any]]:
	"""LTXVEmptyLatentAudio.execute 的兼容包装。"""
	return gjjutils_LTXVEmptyLatentAudio.execute(frames_number, frame_rate, batch_size, audio_vae)


def LTXVAudioVAELoader_execute(ckpt_name: str) -> tuple[Any]:
	"""LTXVAudioVAELoader.execute 的兼容包装。"""
	return gjjutils_LTXVAudioVAELoader.execute(ckpt_name)


def LTXVAudioVAEEncode_execute(audio: dict[str, Any], audio_vae: Any) -> tuple[dict[str, Any]]:
	"""LTXVAudioVAEEncode.execute 的兼容包装。"""
	return gjjutils_LTXVAudioVAEEncode.execute(audio, audio_vae)


def LTXVAudioVAEDecode_execute(vae: dict, samples: dict) -> dict[str, torch.Tensor]:
	"""LTXVAudioVAEDecode.execute 的兼容包装。"""
	return gjjutils_LTXVAudioVAEDecode.execute(vae, samples)


def LTXAVTextEncoderLoader_execute(text_encoder: str, ckpt_name: str, device: str = "default") -> tuple[Any]:
	"""LTXAVTextEncoderLoader.execute 的兼容包装。"""
	return gjjutils_LTXAVTextEncoderLoader.execute(text_encoder, ckpt_name, device)


def vae_decode_audio_execute(vae: dict, samples: dict) -> dict[str, torch.Tensor]:
	"""vae_decode_audio.execute 的兼容包装。"""
	return gjjutils_vae_decode_audio.execute(vae, samples)
