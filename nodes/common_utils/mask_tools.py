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


def _normalize_mask(mask: torch.Tensor) -> tuple[torch.Tensor, bool]:
	"""把 MASK 规范成 [B, H, W]，并返回是否原本是 2D。"""
	if not isinstance(mask, torch.Tensor):
		raise ValueError("遮罩输入必须是 MASK。")
	was_2d = mask.ndim == 2
	if was_2d:
		mask = mask.unsqueeze(0)
	elif mask.ndim == 4 and mask.shape[-1] == 1:
		mask = mask[..., 0]
	elif mask.ndim == 4 and mask.shape[1] == 1:
		mask = mask[:, 0]
	elif mask.ndim != 3:
		raise ValueError("遮罩维度不正确。")
	return mask.detach().cpu().float().clamp(0.0, 1.0).contiguous(), was_2d


def _pad_mode(mask_2d: torch.Tensor) -> str:
	"""reflect 更接近 ComfyUI / SciPy 形态学默认边界；单像素边长时回退 replicate。"""
	if int(mask_2d.shape[-2]) <= 1 or int(mask_2d.shape[-1]) <= 1:
		return "replicate"
	return "reflect"


def _dilate_once(mask_2d: torch.Tensor, tapered_corners: bool) -> torch.Tensor:
	x = mask_2d.unsqueeze(0).unsqueeze(0)
	pad_mode = _pad_mode(mask_2d)
	x = F.pad(x, (1, 1, 1, 1), mode=pad_mode)
	if tapered_corners:
		center = x[:, :, 1:-1, 1:-1]
		up = x[:, :, :-2, 1:-1]
		down = x[:, :, 2:, 1:-1]
		left = x[:, :, 1:-1, :-2]
		right = x[:, :, 1:-1, 2:]
		out = torch.maximum(center, up)
		out = torch.maximum(out, down)
		out = torch.maximum(out, left)
		out = torch.maximum(out, right)
	else:
		out = F.max_pool2d(x, kernel_size=3, stride=1)
	return out[0, 0].clamp(0.0, 1.0)


def _erode_once(mask_2d: torch.Tensor, tapered_corners: bool) -> torch.Tensor:
	return (1.0 - _dilate_once(1.0 - mask_2d, tapered_corners)).clamp(0.0, 1.0)


def _grow_mask_single(mask_2d: torch.Tensor, expand: int, tapered_corners: bool) -> torch.Tensor:
	steps = abs(int(expand))
	if steps <= 0:
		return mask_2d.clamp(0.0, 1.0)
	out = mask_2d
	step_fn = _dilate_once if expand > 0 else _erode_once
	for _ in range(steps):
		out = step_fn(out, tapered_corners)
	return out.clamp(0.0, 1.0)


class gjjutils_GrowMask:
	"""GrowMask 节点功能内置实现。

	严格对齐 ComfyUI 原生 GrowMask 的逐步形态学膨胀语义。
	"""

	@staticmethod
	def execute(
		mask: torch.Tensor,
		expand: int = 0,
		tapered_corners: bool = True,
	) -> dict[str, torch.Tensor]:
		"""扩张或收缩遮罩。"""
		mask, was_2d = _normalize_mask(mask)
		if int(expand) == 0:
			return {"mask": mask[0] if was_2d else mask}

		processed = [_grow_mask_single(item, int(expand), bool(tapered_corners)) for item in mask]
		result = torch.stack(processed, dim=0).contiguous()
		return {"mask": result[0] if was_2d else result}


# ============================================================================
# 导出兼容接口（支持两种调用方式）
# ============================================================================

# 方式1：类方法调用（保持与 comfy_extras 一致）
GrowMask = gjjutils_GrowMask

# 方式2：函数调用（备用）
def GrowMask_execute(mask: torch.Tensor, expand: int = 0, tapered_corners: bool = True) -> dict[str, torch.Tensor]:
	"""GrowMask.execute 的兼容包装。"""
	return gjjutils_GrowMask.execute(mask, expand, tapered_corners)
