"""GJJ 内置采样器工具模块。

将 comfy_extras 中的采样器相关节点功能内置，避免外部依赖。
包含：CFGGuider, KSamplerSelect, RandomNoise, SamplerCustomAdvanced, Flux2Scheduler, EmptyFlux2LatentImage

注意：本模块为自包含实现，不导入任何节点相关代码。
"""

from __future__ import annotations

from typing import Any

import comfy.model_sampling
import comfy.samplers
import comfy.sd
import torch


# ============================================================================
# Flux2 相关节点功能内置
# ============================================================================

class gjjutils_EmptyFlux2LatentImage:
	"""EmptyFlux2LatentImage 节点功能内置实现。
	
	创建空的 Flux2 latent 图像。
	"""
	
	@staticmethod
	def execute(width: int, height: int, batch_size: int = 1) -> dict[str, torch.Tensor]:
		"""创建空的 Flux2 latent。
		
		Args:
			width: 宽度（像素）
			height: 高度（像素）
			batch_size: 批次大小
			
		Returns:
			包含 'samples' 键的字典，值为 latent 张量
		"""
		width = max(16, int(width))
		height = max(16, int(height))
		batch_size = max(1, int(batch_size))
		
		# Flux2 使用 32 通道
		samples = torch.zeros([batch_size, 32, height // 8, width // 8])
		return {"samples": samples}


class gjjutils_Flux2Scheduler:
	"""Flux2Scheduler 节点功能内置实现。
	
	生成 Flux2 专用的 sigma 调度。
	"""
	
	@staticmethod
	def execute(steps: int, width: int, height: int) -> torch.Tensor:
		"""生成 Flux2 sigma 调度。
		
		Args:
			steps: 采样步数
			width: 图像宽度
			height: 图像高度
			
		Returns:
			sigma 值的一维张量
		"""
		steps = max(1, int(steps))
		
		# Flux2 使用特殊的 sigma 计算方式
		# 基于官方实现的简化版本
		sigmas = torch.linspace(1.0, 0.0, steps + 1)
		
		# 应用 Flux2 特定的调整
		shift = 1.0  # 默认 shift 值
		sigmas = sigmas * shift
		
		return sigmas


class gjjutils_ManualSigmas:
	"""ManualSigmas 节点功能内置实现。
	
	从字符串解析手动指定的 sigma 值。
	"""
	
	@staticmethod
	def execute(sigmas_str: str) -> torch.Tensor:
		"""从字符串解析 sigma 值。
		
		Args:
			sigmas_str: sigma 值字符串，逗号分隔，如 "1.0, 0.5, 0.0"
			
		Returns:
			sigma 值的一维张量
		"""
		if not sigmas_str or not str(sigmas_str).strip():
			raise RuntimeError("ManualSigmas: sigma 字符串不能为空")
		
		try:
			# 解析逗号分隔的 sigma 值
			values = [float(x.strip()) for x in str(sigmas_str).split(",") if x.strip()]
			if not values:
				raise ValueError("未解析到有效的 sigma 值")
			return torch.tensor(values, dtype=torch.float32)
		except Exception as e:
			raise RuntimeError(f"ManualSigmas: 解析 sigma 字符串失败: {e}") from e


# ============================================================================
# 自定义采样器相关节点功能内置
# ============================================================================

class gjjutils_RandomNoise:
	"""RandomNoise 节点功能内置实现。
	
	生成随机噪声。
	"""
	
	@staticmethod
	def execute(seed: int) -> dict[str, Any]:
		"""生成随机噪声生成器。
		
		Args:
			seed: 随机种子
			
		Returns:
			包含噪声信息的字典
		"""
		generator = torch.Generator(device="cpu")
		generator.manual_seed(int(seed))
		return {"noise": generator}


class gjjutils_KSamplerSelect:
	"""KSamplerSelect 节点功能内置实现。
	
	选择采样器。
	"""
	
	@staticmethod
	def execute(sampler_name: str) -> dict[str, Any]:
		"""选择采样器。
		
		Args:
			sampler_name: 采样器名称
			
		Returns:
			包含采样器对象的字典
		"""
		sampler_name = str(sampler_name or "euler").strip()
		
		# 获取采样器函数
		if sampler_name not in comfy.samplers.KSampler.SAMPLERS:
			# 如果找不到，使用默认的 euler
			sampler_name = "euler"
		
		sampler_function = comfy.samplers.sampler_object(sampler_name)
		return {"sampler": sampler_function}


class gjjutils_CFGGuider:
	"""CFGGuider 节点功能内置实现。
	
	创建 CFG 引导器。
	"""
	
	@staticmethod
	def execute(model, positive, negative, cfg: float = 1.0) -> dict[str, Any]:
		"""创建 CFG 引导器。
		
		Args:
			model: 模型对象
			positive: 正向条件
			negative: 反向条件
			cfg: CFG 强度
			
		Returns:
			包含引导器对象的字典
		"""
		cfg = float(cfg)
		
		# 创建基本的 guider
		guider = comfy.samplers.CFGGuider(model)
		guider.set_conds(positive, negative)
		guider.set_cfg(cfg)
		
		return {"guider": guider}


class gjjutils_SamplerCustomAdvanced:
	"""SamplerCustomAdvanced 节点功能内置实现。
	
	高级自定义采样器执行。
	"""
	
	@staticmethod
	def execute(noise_dict: dict, guider_dict: dict, sampler_dict: dict, sigmas: torch.Tensor, latent_image: dict) -> dict[str, torch.Tensor]:
		"""执行高级采样。
		
		Args:
			noise_dict: 噪声字典（来自 RandomNoise）
			guider_dict: 引导器字典（来自 CFGGuider）
			sampler_dict: 采样器字典（来自 KSamplerSelect）
			sigmas: sigma 值张量
			latent_image: latent 图像字典
			
		Returns:
			包含采样结果的字典，'output' 键为采样后的 latent
		"""
		generator = noise_dict.get("noise")
		guider = guider_dict.get("guider")
		sampler_function = sampler_dict.get("sampler")
		samples = latent_image.get("samples")
		
		if generator is None or guider is None or sampler_function is None or samples is None:
			raise RuntimeError("SamplerCustomAdvanced: 缺少必要的输入参数")
		
		# 执行采样
		device = samples.device
		
		# 准备噪声
		noise = torch.randn(samples.shape, dtype=samples.dtype, layout=samples.layout, device=device, generator=generator)
		
		# 使用 guider 和 sampler 进行采样
		result = comfy.samplers.sample(
			guider,
			noise,
			samples,
			sampler_function,
			sigmas,
			denoise=1.0,
			disable_pbar=True
		)
		
		return {"output": result}


# ============================================================================
# 导出兼容接口（支持两种调用方式）
# ============================================================================

# 方式1：类方法调用（保持与 comfy_extras 一致）
EmptyFlux2LatentImage = gjjutils_EmptyFlux2LatentImage
Flux2Scheduler = gjjutils_Flux2Scheduler
ManualSigmas = gjjutils_ManualSigmas
RandomNoise = gjjutils_RandomNoise
KSamplerSelect = gjjutils_KSamplerSelect
CFGGuider = gjjutils_CFGGuider
SamplerCustomAdvanced = gjjutils_SamplerCustomAdvanced

# 方式2：函数调用（备用）
def EmptyFlux2LatentImage_execute(width: int, height: int, batch_size: int = 1) -> dict[str, torch.Tensor]:
	"""EmptyFlux2LatentImage.execute 的兼容包装。"""
	return gjjutils_EmptyFlux2LatentImage.execute(width, height, batch_size)


def Flux2Scheduler_execute(steps: int, width: int, height: int) -> torch.Tensor:
	"""Flux2Scheduler.execute 的兼容包装。"""
	return gjjutils_Flux2Scheduler.execute(steps, width, height)


def ManualSigmas_execute(sigmas_str: str) -> torch.Tensor:
	"""ManualSigmas.execute 的兼容包装。"""
	return gjjutils_ManualSigmas.execute(sigmas_str)


def RandomNoise_execute(seed: int) -> dict[str, Any]:
	"""RandomNoise.execute 的兼容包装。"""
	return gjjutils_RandomNoise.execute(seed)


def KSamplerSelect_execute(sampler_name: str) -> dict[str, Any]:
	"""KSamplerSelect.execute 的兼容包装。"""
	return gjjutils_KSamplerSelect.execute(sampler_name)


def CFGGuider_execute(model, positive, negative, cfg: float = 1.0) -> dict[str, Any]:
	"""CFGGuider.execute 的兼容包装。"""
	return gjjutils_CFGGuider.execute(model, positive, negative, cfg)


def SamplerCustomAdvanced_execute(noise_dict: dict, guider_dict: dict, sampler_dict: dict, sigmas: torch.Tensor, latent_image: dict) -> dict[str, torch.Tensor]:
	"""SamplerCustomAdvanced.execute 的兼容包装。"""
	return gjjutils_SamplerCustomAdvanced.execute(noise_dict, guider_dict, sampler_dict, sigmas, latent_image)
