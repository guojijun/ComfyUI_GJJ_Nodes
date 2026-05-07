"""GJJ 文本处理工具模块。

提供通用的文本规范化、匹配、去重等工具函数。
"""
from __future__ import annotations

from typing import Any


def gjjutils_normalize_text(text: str) -> str:
	"""规范化文本（转小写，保留字母数字）。
	
	用于模型名称、关键词等的模糊匹配。
	
	Args:
		text: 原始文本
		
	Returns:
		规范化后的文本（仅包含小写字母和数字）
		
	Example:
		>>> gjjutils_normalize_text("Flux-2_Klein.safetensors")
		'flux2kleinsafetensors'
	"""
	return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def gjjutils_canonical_model_text(text: str) -> str:
	"""获取模型的规范化文本（与 normalize_text 功能相同，语义更明确）。
	
	Args:
		text: 模型名称或路径
		
	Returns:
		规范化后的文本
		
	Example:
		>>> gjjutils_canonical_model_text("/path/to/My_Model_V1.ckpt")
		'pathtomymodelv1ckpt'
	"""
	return gjjutils_normalize_text(text)


def gjjutils_pick_available_name(
	requested: str,
	available: list[str],
	fallback: str = "",
	match_strategy: str = "basename",
) -> str:
	"""从可用列表中选择最佳匹配的名称。
	
	支持多种匹配策略：精确匹配、basename 匹配、规范化匹配。
	
	Args:
		requested: 请求的名称
		available: 可用的名称列表
		fallback: 备选名称
		match_strategy: 匹配策略
			- "exact": 仅精确匹配
			- "basename": basename 匹配（默认）
			- "canonical": 规范化匹配（去除所有特殊字符）
		
	Returns:
		最佳匹配的名称，未找到则返回 fallback
		
	Example:
		>>> available = ["model-v1.safetensors", "model_v2.safetensors"]
		>>> gjjutils_pick_available_name("model-v1", available)
		'model-v1.safetensors'
	"""
	requested = str(requested or "").strip()
	if not requested:
		return str(fallback or "").strip()
	
	# 精确匹配
	if match_strategy == "exact":
		if requested in available:
			return requested
		fallback = str(fallback or "").strip()
		return fallback if fallback in available else ""
	
	# Basename 匹配（默认）
	if requested in available:
		return requested
	
	requested_basename = requested.replace("/", "\\").split("\\")[-1] if requested else ""
	requested_canonical = gjjutils_canonical_model_text(requested_basename or requested)
	
	if requested_canonical:
		for candidate in available:
			candidate_text = str(candidate or "").strip()
			candidate_basename = candidate_text.replace("/", "\\").split("\\")[-1]
			candidate_canonical = gjjutils_canonical_model_text(candidate_basename)
			
			if match_strategy == "basename":
				if candidate_canonical == requested_canonical:
					return candidate_text
			else:  # canonical
				full_canonical = gjjutils_canonical_model_text(candidate_text)
				if (candidate_canonical == requested_canonical
					or requested_canonical in full_canonical):
					return candidate_text
	
	# Fallback
	fallback = str(fallback or "").strip()
	if fallback and fallback in available:
		return fallback
	
	return ""


def gjjutils_dedupe_keep_order(items: list[Any]) -> list[Any]:
	"""去重并保持顺序。
	
	Args:
		items: 需要去重的列表
		
	Returns:
		去重后的列表（保持原始顺序）
		
	Example:
		>>> gjjutils_dedupe_keep_order(["a", "b", "a", "c", "b"])
		['a', 'b', 'c']
	"""
	seen = set()
	result = []
	for item in items:
		key = str(item) if not isinstance(item, (int, float, bool)) else item
		if key not in seen:
			seen.add(key)
			result.append(item)
	return result


def gjjutils_extract_basename(path: str) -> str:
	"""从路径中提取基础文件名。
	
	Args:
		path: 文件路径或名称
		
	Returns:
		基础文件名（不含路径）
		
	Example:
		>>> gjjutils_extract_basename("/path/to/model.safetensors")
		'model.safetensors'
	"""
	return str(path or "").replace("\\", "/").split("/")[-1]


def gjjutils_extract_stem(name: str, extensions: tuple[str, ...] = None) -> str:
	"""从文件名中提取 stem（不含扩展名）。
	
	Args:
		name: 文件名
		extensions: 支持的扩展名列表，默认为常见模型格式
		
	Returns:
		不含扩展名的文件名
		
	Example:
		>>> gjjutils_extract_stem("model-v1.safetensors")
		'model-v1'
	"""
	if extensions is None:
		extensions = (
			".safetensors", ".ckpt", ".pt", ".pth",
			".bin", ".gguf", ".onnx",
		)
	
	base = gjjutils_extract_basename(name)
	lower_base = base.lower()
	for ext in extensions:
		if lower_base.endswith(ext):
			return base[:-len(ext)]
	
	# 如果都不匹配，使用标准 splitext
	import os
	return os.path.splitext(base)[0]
