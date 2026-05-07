"""GJJ 内置遮罩工具模块。

将 comfy_extras.nodes_mask 等遮罩相关节点功能内置，避免外部依赖。

包含：
- 遮罩操作 (GrowMask, etc.)

注意：本模块为自包含实现，不导入任何节点相关代码。
"""

from __future__ import annotations

import torch
import torch.nn.functional as F


# ============================================================================
# 遮罩操作
# ============================================================================

class gjjutils_GrowMask:
	"""GrowMask 节点功能内置实现。
	
	扩张或收缩遮罩。
	"""
	
	@staticmethod
	def execute(
		mask: torch.Tensor,
		expand: int = 0,
		tapered_corners: bool = True,
	) -> dict[str, torch.Tensor]:
		"""扩张或收缩遮罩。
		
		Args:
			mask: 输入遮罩 [B, H, W] 或 [H, W]
			expand: 扩张像素数（负数表示收缩）
			tapered_corners: 是否使用圆角
			
		Returns:
			处理后的遮罩
		"""
		# 确保 mask 是 3D 张量 [B, H, W]
		if mask.dim() == 2:
			mask = mask.unsqueeze(0)
		
		if expand == 0:
			return {"mask": mask}
		
		# 转换为 float 并添加通道维度用于卷积
		mask_float = mask.float().unsqueeze(1)  # [B, 1, H, W]
		
		# 创建卷积核
		kernel_size = abs(expand) * 2 + 1
		kernel = torch.ones((1, 1, kernel_size, kernel_size), dtype=torch.float32)
		
		if tapered_corners:
			# 创建圆形核
			center = kernel_size // 2
			y, x = torch.meshgrid(
				torch.arange(kernel_size, dtype=torch.float32) - center,
				torch.arange(kernel_size, dtype=torch.float32) - center,
				indexing="ij",
			)
			mask_circle = (x ** 2 + y ** 2) <= (center ** 2)
			kernel = kernel * mask_circle.float()
		
		# 归一化核
		kernel = kernel / kernel.sum()
		
		# 执行卷积
		padding = kernel_size // 2
		result = F.conv2d(mask_float, kernel, padding=padding)
		
		# 如果扩张，取最大值；如果收缩，取最小值
		if expand > 0:
			# 扩张：二值化
			result = (result > 0).float()
		else:
			# 收缩：侵蚀操作
			result = (result >= 1.0).float()
		
		# 移除通道维度
		result = result.squeeze(1)
		
		return {"mask": result}


# ============================================================================
# 导出兼容接口（支持两种调用方式）
# ============================================================================

# 方式1：类方法调用（保持与 comfy_extras 一致）
GrowMask = gjjutils_GrowMask

# 方式2：函数调用（备用）
def GrowMask_execute(mask: torch.Tensor, expand: int = 0, tapered_corners: bool = True) -> dict[str, torch.Tensor]:
	"""GrowMask.execute 的兼容包装。"""
	return gjjutils_GrowMask.execute(mask, expand, tapered_corners)
