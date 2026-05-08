"""GJJ 模型族工具模块。

提供模型族匹配、名称解析、预设加载等通用功能。
"""
from __future__ import annotations

import csv
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

# 从 text_tools 导入通用文本处理函数
from .text_tools import (
	gjjutils_normalize_text as _normalize_text,
	gjjutils_canonical_model_text as _canonical_model_text,
	gjjutils_pick_available_name as _pick_available_name,
	gjjutils_dedupe_keep_order as _dedupe_keep_order,
)

# ============================================================================
# 公共函数（供其他节点复用）
# ============================================================================

def gjjutils_model_family_match_preset(
	unet_name: str,
	presets: list[dict[str, Any]] | None = None,
	default_preset: dict[str, Any] | None = None,
) -> dict[str, Any]:
	"""根据 UNET 名称匹配对应的模型族预设。

	通过关键词模糊匹配找到最合适的预设配置，支持多关键词优先级排序。

	Args:
		unet_name: UNET 模型名称
		presets: 可选的预设列表，默认为全局 MODEL_FAMILY_PRESETS
		default_preset: 自定义默认预设，未匹配时使用。如果为 None，使用内置默认配置

	Returns:
		匹配的预设字典，包含 clip_type、clip_names、vae_name、采样参数等配置。

	Example:
		>>> # 基本用法
		>>> preset = gjjutils_model_family_match_preset("flux-2-klein-9b-nvfp4.safetensors")
		>>> print(preset["clip_type"])  # "flux2"

		>>> # 使用自定义预设列表
		>>> custom_presets = [{"keywords": ["my-model"], "clip_type": "custom"}]
		>>> preset = gjjutils_model_family_match_preset("my-model-v1", presets=custom_presets)

		>>> # 使用自定义默认配置
		>>> default = {"clip_type": "fallback", "steps": 30}
		>>> preset = gjjutils_model_family_match_preset("unknown-model", default_preset=default)
	"""
	normalized_name = _normalize_text(unet_name)
	canonical_name = _canonical_model_text(unet_name)
	best: dict[str, Any] | None = None
	best_length = -1

	target_presets = presets if presets is not None else MODEL_FAMILY_PRESETS

	for preset in target_presets:
		for keyword in preset.get("keywords", []):
			normalized_keyword = _normalize_text(keyword)
			canonical_keyword = _canonical_model_text(keyword)
			if not normalized_keyword:
				continue
			if (normalized_keyword in normalized_name
				or (canonical_keyword and canonical_keyword in canonical_name)) and len(canonical_keyword or normalized_keyword) > best_length:
				best = preset
				best_length = len(canonical_keyword or normalized_keyword)

	if best:
		return best

	# 使用自定义默认配置或内置默认配置
	if default_preset is not None:
		return default_preset

	return {
		"id": "generic",
		"clip_type": "stable_diffusion",
		"clip_names": [DEFAULT_CLIP_NAME],
		"vae_name": DEFAULT_VAE_NAME,
		"lora_1_name": "",
		"lora_1_strength": 0.0,
		"lora_2_name": "",
		"lora_2_strength": 0.0,
		"steps": 20,
		"cfg": 1.0,
		"sampler_name": "euler",
		"scheduler": "beta57",
		"denoise": 1.0,
		"model_sampling": "",
		"model_shift": 0.0,
		"cfg_norm_strength": 0.0,
		"supports_multi_image_edit": False,
		"main_long_edge": 1024,
		"vl_long_edge": 512,
		"width": 1024,
		"height": 1024,
	}


def gjjutils_model_family_resolve_clip_type(
	unet_name: str,
	clip_names: list[str],
	preferred_type: str = "",
	custom_keywords: list[tuple[tuple[str, ...], str]] | None = None,
) -> str:
	"""根据 UNET 和 CLIP 名称智能推断 CLIP 类型。

	支持多种模型的自动识别，包括 Flux、Wan、HiDream、Qwen 等。

	Args:
		unet_name: UNET 模型名称
		clip_names: CLIP 模型名称列表
		preferred_type: 用户手动指定的 CLIP 类型（优先级最高）
		custom_keywords: 自定义关键词映射列表，格式为 ((keyword1, keyword2), clip_type)

	Returns:
		推断出的 CLIP 类型字符串，如 "flux2"、"wan"、"hidream" 等

	Example:
		>>> # 基本用法
		>>> clip_type = gjjutils_model_family_resolve_clip_type(
		...     "flux-2-klein-9b.safetensors",
		...     ["qwen_3_8b.safetensors"]
		... )
		>>> print(clip_type)  # "flux2"

		>>> # 使用自定义关键词
		>>> custom_kw = [(("my-custom-model",), "my_type")]
		>>> clip_type = gjjutils_model_family_resolve_clip_type(
		...     "my-custom-model-v1",
		...     [],
		...     custom_keywords=custom_kw
		... )
		>>> print(clip_type)  # "my_type"
	"""
	preferred_text = str(preferred_type or "").strip()
	if preferred_text and _normalize_text(preferred_text) not in ("", "stable_diffusion", "auto"):
		return preferred_text

	normalized_unet = _normalize_text(unet_name)
	canonical_unet = _canonical_model_text(unet_name)
	normalized_clips = " ".join(_normalize_text(name) for name in clip_names if str(name or "").strip())
	canonical_clips = " ".join(_canonical_model_text(name) for name in clip_names if str(name or "").strip())

	# 优先使用自定义关键词
	if custom_keywords:
		for keywords, clip_type in custom_keywords:
			if any(_normalize_text(keyword) in normalized_unet
				or _canonical_model_text(keyword) in canonical_unet
				for keyword in keywords):
				return clip_type

	# 基于 UNET 名称匹配（内置关键词）
	for keywords, clip_type in CLIP_TYPE_KEYWORDS:
		if any(_normalize_text(keyword) in normalized_unet
			or _canonical_model_text(keyword) in canonical_unet
			for keyword in keywords):
			return clip_type

	# 基于 CLIP 名称的特殊规则
	if "clip_l_hidream" in normalized_clips or "clipghidream" in canonical_clips:
		return "hidream"
	if "qwen_2.5_vl" in normalized_clips or "qwen25vl" in canonical_clips:
		return "qwen_image"
	if "qwen_3_8b" in normalized_clips or "qwen_3_4b" in normalized_clips or "qwen38b" in canonical_clips or "qwen34b" in canonical_clips:
		if "flux2" in normalized_unet or "klein" in normalized_unet:
			return "flux2"
		if "wan" in normalized_unet:
			return "wan"
		if "ace" in normalized_unet:
			return "ace"
		if "hunyuan" in normalized_unet:
			return "hunyuan_image"
	if "clip_l" in normalized_clips and "t5xxl" in normalized_clips:
		return "flux"

	return str(preferred_type or "stable_diffusion")


def gjjutils_model_family_get_flux_clip_candidates(
	clip_models: list[str],
	default_name: str = "",
	priority_list: list[str] | None = None,
) -> list[str]:
	"""获取 Flux 模型的可选 CLIP 候选列表。

	按优先级排序，返回实际存在的模型。

	Args:
		clip_models: 可用的 CLIP 模型列表
		default_name: 首选的 CLIP 名称
		priority_list: 自定义优先级列表，默认为标准 T5 系列

	Returns:
		过滤后的候选 CLIP 名称列表（仅包含实际存在的模型）

	Example:
		>>> # 基本用法
		>>> candidates = gjjutils_model_family_get_flux_clip_candidates(available_clips)

		>>> # 使用自定义优先级
		>>> priority = ["custom-t5.safetensors", "backup-t5.safetensors"]
		>>> candidates = gjjutils_model_family_get_flux_clip_candidates(
		...     available_clips,
		...     priority_list=priority
		... )
	"""
	if priority_list is None:
		priority_list = [
			default_name,
			"t5xxl_fp16.safetensors",
			"t5xxl_fp8_e4m3fn_scaled.safetensors",
			"t5xxl_fp8_e4m3fn.safetensors",
		]
	else:
		# 将 default_name 插入到优先级列表开头
		if default_name and default_name not in priority_list:
			priority_list = [default_name] + priority_list

	preferred = _dedupe_keep_order(priority_list)
	return [name for name in preferred if str(name or "").strip() and name in clip_models]


def gjjutils_model_family_resolve_clip_names(
	preset: dict[str, Any],
	clip_models: list[str],
	exposed_clip_name: str = "",
	legacy_clip_names: list[str] | None = None,
	name_matcher: callable | None = None,
) -> list[str]:
	"""从预设中解析并匹配可用的 CLIP 模型名称列表。

	支持 Flux 双 CLIP 的特殊处理逻辑，以及通用模型的名称匹配。

	Args:
		preset: 模型族预设字典
		clip_models: 系统中可用的 CLIP 模型列表
		exposed_clip_name: 前端暴露的 CLIP 名称（用户手动选择）
		legacy_clip_names: 旧版 CLIP 名称列表（向后兼容）
		name_matcher: 自定义名称匹配函数，签名为 (requested, available, fallback) -> str

	Returns:
		解析后的 CLIP 名称列表，可用于加载 CLIP 模型

	Example:
		>>> # 基本用法
		>>> clip_names = gjjutils_model_family_resolve_clip_names(
		...     preset,
		...     available_clip_models,
		...     exposed_clip_name="custom_clip.safetensors"
		... )

		>>> # 使用自定义匹配器
		>>> def custom_matcher(requested, available, fallback):
		...     # 自定义匹配逻辑
		...     return available[0] if available else ""
		>>> clip_names = gjjutils_model_family_resolve_clip_names(
		...     preset,
		...     available_clip_models,
		...     name_matcher=custom_matcher
		... )
	"""
	matcher = name_matcher if name_matcher is not None else _pick_available_name

	recommended_clip_names = [name for name in list(preset.get("clip_names", [])) if str(name or "").strip()]

	# 无推荐名称时使用 legacy 名称
	if not recommended_clip_names:
		resolved: list[str] = []
		for manual_name in legacy_clip_names or []:
			chosen = matcher(manual_name, clip_models, "")
			if chosen:
				resolved.append(chosen)
		return resolved

	# Flux 特殊处理：clip_l + 可选 T5
	if (_normalize_text(preset.get("clip_type", "")) == "flux"
		and _normalize_text(recommended_clip_names[0]) == "clipl.safetensors"):
		clip_l_name = matcher("clip_l.safetensors", clip_models, recommended_clip_names[0])
		optional_candidates = gjjutils_model_family_get_flux_clip_candidates(
			clip_models,
			recommended_clip_names[1] if len(recommended_clip_names) > 1 else "",
		)
		optional_name = matcher(
			exposed_clip_name,
			optional_candidates,
			recommended_clip_names[1] if len(recommended_clip_names) > 1 else "",
		)
		resolved = [name for name in [clip_l_name, optional_name] if str(name or "").strip()]
		if resolved:
			return resolved

	# 通用处理：逐个匹配推荐名称
	resolved = []
	for recommended_name in recommended_clip_names:
		chosen = matcher(recommended_name, clip_models, recommended_name)
		if chosen:
			resolved.append(chosen)
	return resolved


def gjjutils_model_family_pick_lora_name(
	requested: str,
	available: list[str],
	fallback: str = "",
	match_mode: str = "flexible",
) -> str:
	"""从可用 LoRA 列表中选择最匹配的名称（支持多种匹配模式）。

	Args:
		requested: 请求的 LoRA 名称
		available: 可用的 LoRA 名称列表
		fallback: 备选 LoRA 名称
		match_mode: 匹配模式
			- "exact": 仅精确匹配
			- "basename": 仅 basename 匹配
			- "flexible": 灵活匹配（默认，支持部分包含）

	Returns:
		最佳匹配的 LoRA 名称，未找到则返回空字符串

	Example:
		>>> # 基本用法（灵活匹配）
		>>> lora_name = gjjutils_model_family_pick_lora_name(
		...     "lightning-lora.safetensors",
		...     available_loras
		... )

		>>> # 严格精确匹配
		>>> lora_name = gjjutils_model_family_pick_lora_name(
		...     "exact-name.safetensors",
		...     available_loras,
		...     match_mode="exact"
		... )
	"""
	requested = str(requested or "").strip()
	if not requested:
		return ""

	if match_mode == "exact":
		# 仅精确匹配
		if requested in available:
			return requested
		fallback = str(fallback or "").strip()
		return fallback if fallback in available else ""

	# 灵活匹配模式（默认）
	if requested in available:
		return requested

	# 尝试 basename 精确匹配和部分包含匹配
	requested_basename = requested.replace("/", "\\").split("\\")[-1] if requested else ""
	requested_canonical = _canonical_model_text(requested_basename or requested)

	if requested_canonical:
		for candidate in available:
			candidate_text = str(candidate or "").strip()
			candidate_basename = candidate_text.replace("/", "\\").split("\\")[-1]
			candidate_canonical = _canonical_model_text(candidate_basename)
			full_canonical = _canonical_model_text(candidate_text)

			if match_mode == "basename":
				# 仅 basename 匹配
				if candidate_canonical == requested_canonical:
					return candidate_text
			else:  # flexible
				# 支持部分包含
				if (candidate_canonical == requested_canonical
					or requested_canonical in candidate_canonical
					or requested_canonical in full_canonical):
					return candidate_text

	# 尝试 fallback
	fallback = str(fallback or "").strip()
	if fallback and fallback in available:
		return fallback

	fallback_basename = fallback.replace("/", "\\").split("\\")[-1] if fallback else ""
	fallback_canonical = _canonical_model_text(fallback_basename or fallback)

	if fallback_canonical:
		for candidate in available:
			candidate_text = str(candidate or "").strip()
			candidate_basename = candidate_text.replace("/", "\\").split("\\")[-1]
			candidate_canonical = _canonical_model_text(candidate_basename)
			full_canonical = _canonical_model_text(candidate_text)

			if match_mode == "basename":
				if candidate_canonical == fallback_canonical:
					return candidate_text
			else:  # flexible
				if (candidate_canonical == fallback_canonical
					or fallback_canonical in candidate_canonical
					or fallback_canonical in full_canonical):
					return candidate_text

	return ""


def gjjutils_model_family_pick_model_name(
	requested: str,
	available: list[str],
	fallback: str = "",
	match_strategy: str = "basename",
) -> str:
	"""从可用模型列表中选择最匹配的名称（支持多种匹配策略）。

	Args:
		requested: 请求的模型名称
		available: 可用的模型名称列表
		fallback: 备选模型名称
		match_strategy: 匹配策略
			- "exact": 仅精确匹配
			- "basename": basename 匹配（默认）
			- "canonical": 规范化匹配（去除所有特殊字符）

	Returns:
		最佳匹配的模型名称

	Example:
		>>> # 基本用法（basename 匹配）
		>>> vae_name = gjjutils_model_family_pick_model_name(
		...     "flux2-vae.safetensors",
		...     available_vaes
		... )

		>>> # 使用规范化匹配
		>>> model_name = gjjutils_model_family_pick_model_name(
		...     "my-model_v1",
		...     available_models,
		...     match_strategy="canonical"
		... )
	"""
	requested = str(requested or "").strip()
	if not requested:
		return str(fallback or "").strip()

	if match_strategy == "exact":
		if requested in available:
			return requested
		fallback = str(fallback or "").strip()
		return fallback if fallback in available else ""

	# 使用内部实现（支持 basename 和 canonical 匹配）
	return _pick_available_name(requested, available, fallback)


# ============================================================================
# 模型名称解析工具（从 gjj_model_name_resolver.py 迁移）
# ============================================================================

MODEL_EXTENSIONS = (
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pth",
    ".bin",
    ".gguf",
    ".onnx",
)


def _model_basename(name: str) -> str:
    """获取模型文件的基础名称（不含路径）。"""
    return str(name or "").replace("\\", "/").split("/")[-1]


def _model_stem(name: str) -> str:
    """获取模型文件的 stem（不含扩展名）。"""
    base = _model_basename(name)
    lower_base = base.lower()
    for ext in MODEL_EXTENSIONS:
        if lower_base.endswith(ext):
            return base[: -len(ext)]
    return os.path.splitext(base)[0]


def _normalize_lookup_text(text: str) -> str:
    """规范化查找文本（去除特殊字符，转小写）。"""
    return "".join(ch for ch in str(text or "").casefold() if ch.isalnum())


def _longest_common_substring_length(left: str, right: str) -> int:
    """计算两个字符串的最长公共子串长度。"""
    left_norm = _normalize_lookup_text(left)
    right_norm = _normalize_lookup_text(right)
    if not left_norm or not right_norm:
        return 0

    previous = [0] * (len(right_norm) + 1)
    best = 0
    for left_index, left_char in enumerate(left_norm, start=1):
        current = [0] * (len(right_norm) + 1)
        for right_index, right_char in enumerate(right_norm, start=1):
            if left_char == right_char:
                value = previous[right_index - 1] + 1
                current[right_index] = value
                if value > best:
                    best = value
        previous = current
    return best


def _minimum_common_length(preferred_stem: str) -> int:
    """计算最小公共长度阈值。"""
    normalized_length = len(_normalize_lookup_text(preferred_stem))
    if normalized_length <= 8:
        return max(4, normalized_length)
    return max(8, min(16, normalized_length // 3))


def _subdir_score(preferred: str, candidate: str) -> int:
    """计算子目录匹配分数。"""
    preferred_parts = str(preferred or "").replace("\\", "/").casefold().split("/")
    candidate_parts = str(candidate or "").replace("\\", "/").casefold().split("/")
    if len(preferred_parts) <= 1 or len(candidate_parts) <= 1:
        return 0
    return 50 if preferred_parts[0] == candidate_parts[0] else 0


def _candidate_score(preferred: str, candidate: str) -> int:
    """计算候选模型的匹配分数。"""
    preferred_stem = _model_stem(preferred)
    candidate_stem = _model_stem(candidate)
    preferred_norm = _normalize_lookup_text(preferred_stem)
    candidate_norm = _normalize_lookup_text(candidate_stem)
    if not preferred_norm or not candidate_norm:
        return 0

    score = _subdir_score(preferred, candidate)
    if preferred_norm == candidate_norm:
        return 1_000_000 + score + len(preferred_norm)
    if preferred_norm in candidate_norm:
        return 900_000 + score + len(preferred_norm)
    if candidate_norm in preferred_norm:
        return 800_000 + score + len(candidate_norm)

    common_len = _longest_common_substring_length(preferred_stem, candidate_stem)
    if common_len < _minimum_common_length(preferred_stem):
        return 0
    return score + common_len


def gjjutils_pick_available_model_name(
    preferred: str,
    available: list[str],
    fallback: str = "",
    *,
    allow_first: bool = False,
) -> str:
    """从可用模型列表中选择最匹配的名称。

    支持多种匹配策略：精确匹配、basename 匹配、模糊匹配。

    Args:
        preferred: 首选模型名称
        available: 可用的模型名称列表
        fallback: 备选模型名称
        allow_first: 如果为 True，无匹配时返回第一个可用模型

    Returns:
        最佳匹配的模型名称，未找到则返回空字符串或 fallback

    Example:
        >>> # 基本用法
        >>> model_name = gjjutils_pick_available_model_name(
        ...     "flux-dev.safetensors",
        ...     available_models
        ... )

        >>> # 允许返回第一个可用模型
        >>> model_name = gjjutils_pick_available_model_name(
        ...     "unknown-model.safetensors",
        ...     available_models,
        ...     allow_first=True
        ... )
    """
    preferred = str(preferred or "").strip()
    fallback = str(fallback or "").strip()
    names = list(available or [])
    if not names:
        return ""

    if preferred and preferred in names:
        return preferred

    preferred_base = _model_basename(preferred).casefold()
    if preferred_base:
        for name in names:
            if _model_basename(name).casefold() == preferred_base:
                return name

    if preferred:
        scored = [(_candidate_score(preferred, name), index, name) for index, name in enumerate(names)]
        scored = [item for item in scored if item[0] > 0]
        if scored:
            scored.sort(key=lambda item: (-item[0], item[1]))
            return scored[0][2]

    if fallback and fallback != preferred:
        resolved = gjjutils_pick_available_model_name(fallback, names, "", allow_first=False)
        if resolved:
            return resolved

    return names[0] if allow_first else ""


# 向后兼容的别名
gjjutils_model_basename = _model_basename
gjjutils_model_stem = _model_stem


# ============================================================================
# 模型族预设表加载工具（从 gjj_model_family_preset_table.py 迁移）
# ============================================================================

LIST_FIELDS = {"keywords", "clip_names"}
INT_FIELDS = {
	"steps",
	"base_steps",
	"main_long_edge",
	"vl_long_edge",
	"width",
	"height",
}
FLOAT_FIELDS = {
	"lora_1_strength",
	"lora_2_strength",
	"cfg",
	"denoise",
	"model_shift",
	"cfg_norm_strength",
}
BOOL_FIELDS = {"supports_multi_image_edit"}

# 查找预设文件路径：从当前文件向上查找，直到找到包含 presets 目录的位置
def _find_preset_root() -> Path:
	"""动态查找预设文件根目录。"""
	current = Path(__file__).resolve().parent
	# 向上最多查找5级目录
	for _ in range(5):
		presets_dir = current / "presets"
		if presets_dir.exists() and presets_dir.is_dir():
			return presets_dir
		current = current.parent
	# 如果找不到，回退到默认位置（相对于当前文件的三级父目录）
	return Path(__file__).resolve().parent.parent.parent / "presets"

PRESET_ROOT = _find_preset_root()
PRESET_TABLE_PATH = PRESET_ROOT / "model_family_presets.tsv"


def _parse_bool(value: str) -> bool:
	"""解析布尔值字符串。"""
	return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _parse_number(value: str, integer: bool) -> int | float | None:
	"""解析数字字符串。"""
	text = str(value or "").strip()
	if not text:
		return None
	number = float(text)
	return int(number) if integer else number


def _parse_preset_row(row: dict[str, str]) -> dict[str, Any]:
	"""解析预设表的一行数据。"""
	preset: dict[str, Any] = {}
	for key, raw_value in row.items():
		key = str(key or "").strip()
		if not key:
			continue
		value = str(raw_value or "").strip()
		if key in LIST_FIELDS:
			preset[key] = [part for part in value.split("|") if part]
		elif key in INT_FIELDS:
			parsed = _parse_number(value, integer=True)
			if parsed is not None:
				preset[key] = parsed
		elif key in FLOAT_FIELDS:
			parsed = _parse_number(value, integer=False)
			if parsed is not None:
				preset[key] = parsed
		elif key in BOOL_FIELDS:
			preset[key] = _parse_bool(value)
		else:
			preset[key] = value
	return preset


def _iter_preset_data_lines(handle):
	"""迭代预设表的有效数据行（跳过注释和空行）。"""
	for line in handle:
		text = str(line or "").strip()
		if not text or text.startswith("#"):
			continue
		yield line


def _read_preset_effective_lines() -> list[str]:
	"""读取预设表的有效行。"""
	with PRESET_TABLE_PATH.open("r", encoding="utf-8-sig", newline="") as handle:
		return list(_iter_preset_data_lines(handle))


def _split_preset_tsv_line(line: str) -> list[str]:
	"""分割 TSV 行。"""
	return [part.strip() for part in str(line or "").rstrip("\r\n").split("\t")]


def _find_preset_header_index(lines: list[str]) -> int:
	"""查找预设表的表头行索引。"""
	for index, line in enumerate(lines):
		columns = _split_preset_tsv_line(line)
		if len(columns) >= 2 and columns[0] == "id" and columns[1] == "keywords":
			return index
	raise RuntimeError(f"预设表缺少表头行：{PRESET_TABLE_PATH}")


@lru_cache(maxsize=1)
def gjjutils_load_model_family_presets() -> list[dict[str, Any]]:
	"""加载模型族预设表（带缓存）。

	Returns:
		预设列表，每个元素是一个包含配置项的字典

	Example:
		>>> presets = gjjutils_load_model_family_presets()
		>>> print(len(presets))  # 预设数量
	"""
	lines = _read_preset_effective_lines()
	header_index = _find_preset_header_index(lines)
	reader = csv.DictReader(lines[header_index:], delimiter="\t")
	return [_parse_preset_row(row) for row in reader]


def gjjutils_match_model_family_preset(
	unet_name: str,
	presets: list[dict[str, Any]] | None = None
) -> dict[str, Any] | None:
	"""根据 UNET 名称匹配模型族预设（简化版）。

	Args:
		unet_name: UNET 模型名称
		presets: 可选的预设列表，默认为加载的预设表

	Returns:
		匹配的预设字典，未匹配则返回 None

	Example:
		>>> preset = gjjutils_match_model_family_preset("flux-dev.safetensors")
		>>> if preset:
		...     print(preset["clip_type"])
	"""
	normalized_unet = _normalize_lookup_text(unet_name)
	if not normalized_unet:
		return None
	best: dict[str, Any] | None = None
	best_length = -1
	for preset in presets or gjjutils_load_model_family_presets():
		for keyword in preset.get("keywords", []) or []:
			normalized_keyword = _normalize_lookup_text(keyword)
			if normalized_keyword and normalized_keyword in normalized_unet and len(normalized_keyword) > best_length:
				best = preset
				best_length = len(normalized_keyword)
	return best


# ============================================================================
# 全局常量定义
# ============================================================================

# CLIP 类型关键词映射
CLIP_TYPE_KEYWORDS = [
	(("flux2", "klein"), "flux2"),
	(("wan", "wan2.1", "wan2.2"), "wan"),
	(("ltx", "ltx-2.3", "ltx23"), "ltx"),
	(("hidream", "hi_dream"), "hidream"),
	(("qwen_image", "qwenimage"), "qwen_image"),
	(("ace", "ace_step"), "ace"),
	(("hunyuan_video", "hunyuanvideo"), "hunyuan_video"),
	(("hunyuan_image", "hunyuanimage"), "hunyuan_image"),
	(("flux", "flux1"), "flux"),
]

# 默认 CLIP 名称
DEFAULT_CLIP_NAME = "clip_l.safetensors"

# 默认 VAE 名称
DEFAULT_VAE_NAME = "ae.safetensors"

# 模型族预设（从 TSV 文件加载，如果失败则使用空列表）
try:
	MODEL_FAMILY_PRESETS = gjjutils_load_model_family_presets()
except Exception:
	MODEL_FAMILY_PRESETS = []
