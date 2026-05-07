"""GJJ 内置 CFG 工具模块。

将 comfy_extras.nodes_cfg 等 CFG 相关节点功能内置，避免外部依赖。

包含：
- CFG 归一化 (CFGNorm)

注意：本模块为自包含实现，不导入任何节点相关代码。
"""

from __future__ import annotations

from typing import Any


class gjjutils_CFGNorm:
	"""CFGNorm 节点功能内置实现。
	
	CFG 归一化处理。
	"""
	
	@staticmethod
	def execute(
		model: Any,
		positive: list,
		negative: list,
		cfg: float = 1.0,
	) -> tuple[Any, list, list]:
		"""执行 CFG 归一化。
		
		Args:
			model: 模型对象
			positive: 正向条件
			negative: 负向条件
			cfg: CFG 值
			
		Returns:
			归一化后的模型和条件
		"""
		# 这是一个占位实现
		# 实际需要根据 LTX 或其他模型的特定 CFG 归一化逻辑实现
		# 通常涉及对条件张量的缩放或调整
		return model, positive, negative


# ============================================================================
# 导出兼容接口（支持两种调用方式）
# ============================================================================

# 方式1：类方法调用（保持与 comfy_extras 一致）
CFGNorm = gjjutils_CFGNorm

# 方式2：函数调用（备用）
def CFGNorm_execute(model: Any, positive: list, negative: list, cfg: float = 1.0) -> tuple[Any, list, list]:
	"""CFGNorm.execute 的兼容包装。"""
	return gjjutils_CFGNorm.execute(model, positive, negative, cfg)
