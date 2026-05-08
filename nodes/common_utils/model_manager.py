"""GJJ 模型管理工具模块。

提供基于 TSV 文件的模型关键词索引、模糊搜索、子目录匹配等功能。
所有模型信息统一存储在 presets/model_keywords.tsv 中，方便维护。
"""

from __future__ import annotations

import csv
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import folder_paths

from .text_tools import gjjutils_normalize_text, gjjutils_extract_stem

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
# TSV 文件路径
MODEL_KEYWORDS_PATH = PRESET_ROOT / "model_keywords.tsv"


def _parse_tsv_row(row: dict[str, str]) -> dict[str, Any]:
    """解析 TSV 行数据。

    Args:
            row: CSV DictReader 返回的行字典

    Returns:
            解析后的模型信息字典
    """
    model_info: dict[str, Any] = {}

    for key, value in row.items():
        key = str(key or "").strip()
        if not key:
            continue

        value = str(value or "").strip()

        # 处理列表字段（keywords 和 tags）
        if key in ("keywords", "tags"):
            model_info[key] = [
                part.strip() for part in value.split("|") if part.strip()
            ]
        # 处理整数字段
        elif key == "priority":
            try:
                model_info[key] = int(value) if value else 0
            except ValueError:
                model_info[key] = 0
        else:
            model_info[key] = value

    return model_info


@lru_cache(maxsize=1)
def gjjutils_load_model_keywords() -> list[dict[str, Any]]:
    """加载模型关键词索引表（带缓存）。

    Returns:
            模型信息列表，每个元素包含 id, category, keywords, display_name 等字段

    Raises:
            FileNotFoundError: 如果 TSV 文件不存在
            RuntimeError: 如果 TSV 文件格式错误

    Example:
            >>> models = gjjutils_load_model_keywords()
            >>> print(len(models))  # 模型数量
            >>> print(models[0]["id"])  # 第一个模型的 ID
    """
    if not MODEL_KEYWORDS_PATH.exists():
        raise FileNotFoundError(f"模型关键词文件不存在: {MODEL_KEYWORDS_PATH}")

    with MODEL_KEYWORDS_PATH.open("r", encoding="utf-8-sig", newline="") as f:
        # 跳过注释行
        lines = []
        for line in f:
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                lines.append(line)

        if not lines:
            raise RuntimeError("模型关键词文件为空")

        reader = csv.DictReader(lines, delimiter="\t")
        return [_parse_tsv_row(row) for row in reader]


def gjjutils_search_models(
    query: str,
    category: str | None = None,
    limit: int = 10,
    min_priority: int = 0,
) -> list[dict[str, Any]]:
    """模糊搜索模型（支持子目录和关键词匹配）。

    Args:
            query: 搜索关键词（会自动规范化，支持部分匹配）
            category: 可选的类别过滤 (unet/clip/vae/lora/controlnet/upscaler/etc)
            limit: 返回结果数量限制
            min_priority: 最小优先级过滤

    Returns:
            匹配的模型列表，按相关性和优先级排序

    Example:
            >>> # 搜索 flux 相关模型
            >>> results = gjjutils_search_models("flux")
            >>> print(results[0]["display_name"])  # "Flux Dev"

            >>> # 搜索 CLIP 模型
            >>> clips = gjjutils_search_models("clip", category="clip")

            >>> # 搜索高优先级模型
            >>> top_models = gjjutils_search_models("wan", min_priority=90)
    """
    if not query or not query.strip():
        return []

    normalized_query = gjjutils_normalize_text(query)
    all_models = gjjutils_load_model_keywords()

    scored_results = []

    for model in all_models:
        # 类别过滤
        if category and model.get("category", "").lower() != category.lower():
            continue

        # 优先级过滤
        priority = model.get("priority", 0)
        if priority < min_priority:
            continue

        # 计算匹配分数
        score = 0
        keywords = model.get("keywords", [])

        for keyword in keywords:
            normalized_keyword = gjjutils_normalize_text(keyword)

            # 完全匹配：最高分
            if normalized_keyword == normalized_query:
                score += 1000
            # 包含匹配：中等分数
            elif normalized_query in normalized_keyword:
                score += 500 + len(normalized_query) * 10
            # 被包含匹配：较低分数
            elif normalized_keyword in normalized_query:
                score += 300 + len(normalized_keyword) * 5
            # 部分重叠：最低分数
            else:
                # 计算共同字符数
                common_chars = sum(
                    1 for c in normalized_query if c in normalized_keyword
                )
                if common_chars > len(normalized_query) * 0.5:
                    score += 100 + common_chars * 2

        # 加上优先级权重
        score += priority * 2

        if score > 0:
            scored_results.append((score, model))

    # 按分数降序排序
    scored_results.sort(key=lambda x: x[0], reverse=True)

    # 返回前 limit 个结果
    return [model for _, model in scored_results[:limit]]


def gjjutils_find_model_in_folders(
    query: str,
    folder_type: str = "checkpoints",
    category: str | None = None,
) -> str | None:
    """在 ComfyUI 文件夹中查找匹配的模型文件（支持子目录）。

    Args:
            query: 搜索关键词
            folder_type: ComfyUI 文件夹类型 (checkpoints/clip/vae/loras/controlnets/upscale_models)
            category: 可选的类别过滤

    Returns:
            匹配的模型文件名（含相对路径），未找到返回 None

    Example:
            >>> # 在 checkpoints 中查找 flux 模型
            >>> model = gjjutils_find_model_in_folders("flux", "checkpoints")
            >>> print(model)  # "flux-dev.safetensors" 或 "subdir/flux-model.ckpt"
    """
    # 先通过关键词搜索获取候选模型
    candidate_models = gjjutils_search_models(query, category=category, limit=20)

    if not candidate_models:
        return None

    # 获取文件夹中的所有文件（包括子目录）
    try:
        files = folder_paths.get_filename_list(folder_type)
    except Exception:
        return None

    if not files:
        return None

    # 为每个候选模型查找实际文件
    for model_info in candidate_models:
        keywords = model_info.get("keywords", [])
        model_id = model_info.get("id", "")

        # 尝试匹配关键词
        for keyword in keywords:
            normalized_keyword = gjjutils_normalize_text(keyword)

            for filename in files:
                normalized_filename = gjjutils_normalize_text(filename)

                # 检查是否包含关键词
                if (
                    normalized_keyword in normalized_filename
                    or normalized_filename in normalized_keyword
                ):
                    return filename

        # 尝试匹配 ID
        if model_id:
            normalized_id = gjjutils_normalize_text(model_id)
            for filename in files:
                normalized_filename = gjjutils_normalize_text(filename)
                if (
                    normalized_id in normalized_filename
                    or normalized_filename in normalized_id
                ):
                    return filename

    return None


def gjjutils_find_model_list(
    keyword: str | list[str],
    folder_type: str,
    match_mode: str = "AND",
) -> list[str]:
    """在指定模型目录下模糊搜索匹配关键词的文件列表。

    直接扫描 ComfyUI 模型文件夹文件系统，不依赖 TSV 预设索引表。
    对文件名进行规范化后做子串匹配，支持多关键词逻辑与/逻辑或。

    Args:
            keyword: 搜索关键词（如 "ltx"）或关键词列表（如 ["ltx", "video"]）
            folder_type: ComfyUI 目录类型标识
                    (checkpoints/clip/vae/loras/controlnets/upscale_models/
                     diffusion_models/text_encoders/unet 等)
            match_mode: 多关键词匹配模式
                    - "AND": 文件名必须包含所有关键词（默认）
                    - "OR":  文件名包含任一关键词即匹配

    Returns:
            匹配的文件名列表（含子目录相对路径），未匹配时返回空列表

    Example:
            >>> # 单个关键词
            >>> gjjutils_find_model_list("ltx", "loras")
            ['ltx_video/ltx_conditional.safetensors']

            >>> # 多关键词 AND → 同时包含 "wan" 和 "14B"
            >>> gjjutils_find_model_list(["wan", "14B"], "diffusion_models", "AND")
            ['wan2.2/Wan2.2_T2V_14B_fp8_e4m3fn.safetensors']

            >>> # 多关键词 OR → 包含 "sd15" 或 "xl"
            >>> gjjutils_find_model_list(["sd15", "xl"], "checkpoints", "OR")
            ['sd_xl_base_1.0.safetensors', 'v1-5-pruned-emaonly.safetensors']

            >>> # 搜索 controlnet 下的 depth 模型
            >>> gjjutils_find_model_list("depth", "controlnet")
            ['depth_anything_v2.safetensors', 'control_v11p_sd15_depth.pth']
    """
    # 统一规范化关键词为列表
    if isinstance(keyword, str):
        keywords = [keyword] if keyword.strip() else []
    else:
        keywords = [str(k).strip() for k in keyword if k and str(k).strip()]

    if not keywords:
        return []

    normalized_keywords = [gjjutils_normalize_text(k) for k in keywords]
    normalized_keywords = [k for k in normalized_keywords if k]
    if not normalized_keywords:
        return []

    try:
        files = folder_paths.get_filename_list(folder_type)
    except Exception:
        return []

    if not files:
        return []

    mode = match_mode.upper()
    matched: list[str] = []
    for filename in files:
        normalized_filename = gjjutils_normalize_text(filename)
        if mode == "AND":
            # 逻辑与：所有关键词都必须出现在文件名中
            if all(kw in normalized_filename for kw in normalized_keywords):
                matched.append(filename)
        else:
            # 逻辑或（默认兜底）：任一关键词出现在文件名中即匹配
            if any(kw in normalized_filename for kw in normalized_keywords):
                matched.append(filename)

    return matched


def gjjutils_get_available_models_by_category(
    category: str,
    folder_type: str | None = None,
) -> list[str]:
    """获取指定类别的所有可用模型（从文件系统扫描）。

    Args:
            category: 模型类别 (unet/clip/vae/lora/controlnet/upscaler)
            folder_type: ComfyUI 文件夹类型，如不指定则自动推断

    Returns:
            模型文件名列表（含相对路径）

    Example:
            >>> # 获取所有 CLIP 模型
            >>> clips = gjjutils_get_available_models_by_category("clip", "clip")
    """
    # 自动推断文件夹类型
    if folder_type is None:
        folder_map = {
            "unet": "checkpoints",
            "clip": "clip",
            "vae": "vae",
            "lora": "loras",
            "controlnet": "controlnets",
            "upscaler": "upscale_models",
        }
        folder_type = folder_map.get(category.lower(), "checkpoints")

    try:
        files = folder_paths.get_filename_list(folder_type)
    except Exception:
        return []

    # 过滤出匹配类别的模型
    matching_models = []
    for filename in files:
        # 使用关键词搜索验证是否属于该类别
        stem = gjjutils_extract_stem(filename)
        results = gjjutils_search_models(stem, category=category, limit=1)

        if results:
            matching_models.append(filename)

    return matching_models


def gjjutils_build_model_choices(
    query: str,
    category: str | None = None,
    include_auto: bool = True,
    auto_label: str = "Auto",
    disable_label: str = "Disable",
) -> list[str]:
    """构建模型选择列表（用于 UI 下拉菜单）。

    Args:
            query: 搜索关键词
            category: 可选的类别过滤
            include_auto: 是否包含 "Auto" 选项
            auto_label: "Auto" 选项的标签
            disable_label: "Disable" 选项的标签

    Returns:
            选择列表，如 ["Auto", "Disable", "model1.safetensors", ...]

    Example:
            >>> choices = gjjutils_build_model_choices("flux", "unet")
            >>> print(choices)  # ["Auto", "Disable", "flux-dev.safetensors", ...]
    """
    choices = []

    if include_auto:
        choices.append(auto_label)

    choices.append(disable_label)

    # 搜索匹配的模型
    matched_files = gjjutils_find_model_in_folders(query, category=category)

    # 这里需要扩展：实际应该返回多个匹配结果
    # 暂时简化实现

    return choices
