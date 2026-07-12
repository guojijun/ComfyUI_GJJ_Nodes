"""GJJ 模型管理工具模块。

提供基于 TSV 文件的模型关键词索引、模糊搜索、子目录匹配等功能。
所有模型信息统一存储在 presets/model_keywords.tsv 中，方便维护。
"""

from __future__ import annotations

import csv
import os
import re
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


_GJJ_MODEL_EXT_RE = re.compile(r"\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|engine|torchscript)$", re.IGNORECASE)
_GJJ_QUANT_TOKEN_RE = re.compile(
    r"(?i)(^|[_\-. ])("
    r"fp8mixed|fp8_scaled|fp8_e4m3fn|fp(?:8|16|32)|bf16|f16|f32|"
    r"q[2-8](?:_[a-z0-9]+)?|int(?:4|8)|"
    r"e4m3fn(?:_fast)?|e5m2|bnb(?:4|8)bit|scaled|mixed"
    r")(?=$|[_\-. ])"
)


def gjjutils_model_stem_without_quant(name: str) -> str:
    """去掉扩展名和常见量化标记后得到模型匹配 stem。"""
    text = str(name or "").replace("\\", "/").split("/")[-1].strip()
    text = _GJJ_MODEL_EXT_RE.sub("", text)
    text = _GJJ_QUANT_TOKEN_RE.sub(" ", text)
    text = re.sub(r"[_\-. ]+", " ", text).strip().lower()
    return text


def _gjjutils_longest_common_substring(a: str, b: str) -> int:
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    best = 0
    for ca in a:
        cur = [0]
        for j, cb in enumerate(b, 1):
            value = prev[j - 1] + 1 if ca == cb else 0
            if value > best:
                best = value
            cur.append(value)
        prev = cur
    return best


def gjjutils_resolve_model_by_extensionless_seed(seed_name: str, folder_type: str, min_fragment: int = 4) -> str | None:
    """按“去扩展名、去量化标记”的源文件名在 ComfyUI 模型目录里搜索。

    返回值保持 folder_paths 给出的子目录相对路径，方便直接传给原生 loader。
    """
    seed = str(seed_name or "").strip()
    seed_stem = gjjutils_model_stem_without_quant(seed)
    if not seed_stem:
        return None
    try:
        files = folder_paths.get_filename_list(folder_type)
    except Exception:
        return None
    if not files:
        return None

    seed_base = _GJJ_MODEL_EXT_RE.sub("", seed.replace("\\", "/").split("/")[-1]).lower()
    scored: list[tuple[int, int, int, str]] = []
    for file_name in files:
        file_base = file_name.replace("\\", "/").split("/")[-1]
        file_stem = gjjutils_model_stem_without_quant(file_base)
        file_base_no_ext = _GJJ_MODEL_EXT_RE.sub("", file_base).lower()
        if not file_stem:
            continue
        exact = int(file_name.lower().replace("\\", "/") == seed.lower().replace("\\", "/"))
        basename_exact = int(file_base.lower() == seed.replace("\\", "/").split("/")[-1].lower())
        contains = int(seed_stem in file_stem or file_stem in seed_stem)
        common = _gjjutils_longest_common_substring(seed_stem, file_stem)
        raw_common = _gjjutils_longest_common_substring(seed_base, file_base_no_ext)
        best_common = max(common, raw_common)
        if not (exact or basename_exact or contains or best_common >= min_fragment):
            continue
        scored.append((exact * 100000 + basename_exact * 50000 + contains * 10000 + best_common * 100, best_common, -len(file_name), file_name))

    if not scored:
        return None
    scored.sort(reverse=True)
    return scored[0][3]


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


_GJJ_COMMON_MODEL_EXTENSIONS = {
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pt2",
    ".pth",
    ".bin",
    ".gguf",
    ".sft",
    ".pkl",
    ".onnx",
    ".engine",
    ".torchscript",
}


def _gjjutils_normalize_extensions(extensions: Any = None) -> set[str]:
    values = extensions or _GJJ_COMMON_MODEL_EXTENSIONS
    result: set[str] = set()
    for item in values:
        text = str(item or "").strip().lower()
        if not text:
            continue
        result.add(text if text.startswith(".") else f".{text}")
    return result or set(_GJJ_COMMON_MODEL_EXTENSIONS)


def _gjjutils_normalize_model_relpath(value: Any) -> str:
    return str(value or "").strip().replace("\\", "/").strip("/")


def gjjutils_ensure_model_folder(
    folder_type: str,
    relative_dir: str | None = None,
    extensions: Any = None,
) -> Path:
    """Ensure a ComfyUI model folder exists and is known to folder_paths.

    This is the shared entry point for GJJ nodes that need a custom models/
    subdirectory such as models/nlf or models/detection.
    """
    folder_key = str(folder_type or "").strip()
    if not folder_key:
        raise ValueError("folder_type 不能为空。")
    rel_dir = _gjjutils_normalize_model_relpath(relative_dir or folder_key)
    base_dir = Path(getattr(folder_paths, "models_dir", Path.cwd() / "models"))
    model_dir = base_dir / rel_dir
    model_dir.mkdir(parents=True, exist_ok=True)

    ext_set = _gjjutils_normalize_extensions(extensions)
    try:
        folder_paths.add_model_folder_path(folder_key, str(model_dir))
    except Exception:
        pass

    try:
        registry = getattr(folder_paths, "folder_names_and_paths", {})
        current = registry.get(folder_key)
        if current:
            paths, known_exts = current
            path_list = [str(path) for path in (paths or [])]
            if str(model_dir) not in path_list:
                path_list.append(str(model_dir))
            registry[folder_key] = (path_list, set(known_exts or set()).union(ext_set))
        else:
            registry[folder_key] = ([str(model_dir)], ext_set)
    except Exception:
        pass
    return model_dir


def gjjutils_list_model_files(
    folder_type: str,
    relative_dir: str | None = None,
    extensions: Any = None,
) -> list[str]:
    """List model files from a ComfyUI models/ subdirectory, recursively.

    Returned names keep folder_paths-compatible relative subpaths.
    """
    ext_set = _gjjutils_normalize_extensions(extensions)
    model_dir = gjjutils_ensure_model_folder(folder_type, relative_dir, ext_set)

    names: list[str] = []
    seen: set[str] = set()

    def add_name(value: Any) -> None:
        rel = _gjjutils_normalize_model_relpath(value)
        if not rel:
            return
        if ext_set and Path(rel).suffix.lower() not in ext_set:
            return
        key = rel.lower()
        if key in seen:
            return
        seen.add(key)
        names.append(rel)

    try:
        for filename in folder_paths.get_filename_list(str(folder_type)):
            add_name(filename)
    except Exception:
        pass

    try:
        for path in model_dir.rglob("*"):
            if path.is_file():
                add_name(path.relative_to(model_dir).as_posix())
    except Exception:
        pass

    return sorted(names, key=lambda item: item.lower())


def _gjjutils_model_path_for_rel(folder_type: str, rel_name: str) -> str:
    rel = _gjjutils_normalize_model_relpath(rel_name)
    try:
        path = folder_paths.get_full_path(str(folder_type), rel)
        if path and os.path.exists(path):
            return os.path.abspath(path)
    except Exception:
        pass
    try:
        for base in (getattr(folder_paths, "folder_names_and_paths", {}).get(str(folder_type)) or ([], set()))[0]:
            path = Path(base) / rel
            if path.is_file():
                return str(path.resolve())
    except Exception:
        pass
    return ""


def _gjjutils_compact_model_key(value: Any) -> str:
    text = gjjutils_model_stem_without_quant(str(value or ""))
    return re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "", text.lower())


def _gjjutils_model_match_score(query: str, filename: str) -> int:
    raw_query = _gjjutils_normalize_model_relpath(query).lower()
    raw_file = _gjjutils_normalize_model_relpath(filename).lower()
    if not raw_query or not raw_file:
        return 0

    query_path = raw_query
    file_path = raw_file
    query_base = raw_query.rsplit("/", 1)[-1]
    file_base = raw_file.rsplit("/", 1)[-1]
    query_stem = gjjutils_model_stem_without_quant(query_base)
    file_stem = gjjutils_model_stem_without_quant(file_base)
    query_key = _gjjutils_compact_model_key(query_base)
    file_key = _gjjutils_compact_model_key(file_base)

    score = 0
    if file_path == query_path:
        score = max(score, 100000)
    if file_base == query_base:
        score = max(score, 95000)
    if file_stem and query_stem and file_stem == query_stem:
        score = max(score, 90000)
    if query_key and file_key and query_key == file_key:
        score = max(score, 85000)
    if query_key and file_key and (query_key in file_key or file_key in query_key):
        score = max(score, 70000 + min(len(query_key), len(file_key)))

    query_tokens = [token for token in re.split(r"[\s._\-/\\]+", query_stem) if token]
    if query_tokens and file_stem:
        hits = sum(1 for token in query_tokens if token in file_stem)
        if hits == len(query_tokens):
            score = max(score, 60000 + hits * 100 + len(query_key))
        elif hits:
            score = max(score, 40000 + hits * 100)

    common = _gjjutils_longest_common_substring(query_key, file_key)
    if common >= min(4, len(query_key), len(file_key)):
        score = max(score, 20000 + common * 100)
    return score


def _dedupe_keep_order(values: Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        text = str(value or "").strip()
        if not text:
            continue
        key = text.replace("\\", "/").lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def gjjutils_resolve_model_file(
    selection: Any,
    folder_type: str,
    *,
    relative_dir: str | None = None,
    candidates: Any = None,
    extensions: Any = None,
    label: str = "模型",
    auto_values: Any = None,
) -> tuple[str, str]:
    """Resolve a model selection to (absolute_path, relative_name).

    The resolver searches ComfyUI/models/<relative_dir or folder_type>
    recursively, supports "Auto" selections, and scores candidates by exact
    filename, extensionless filename, quantization-insensitive stem, and token
    overlap.
    """
    ext_set = _gjjutils_normalize_extensions(extensions)
    files = gjjutils_list_model_files(folder_type, relative_dir, ext_set)
    auto_set = {str(item).strip().lower() for item in (auto_values or ("", "auto", "自动", "智能查找"))}
    selected = str(selection or "").strip()

    direct = Path(os.path.expandvars(os.path.expanduser(selected))) if selected else None
    if direct is not None and direct.is_file():
        return str(direct.resolve()), direct.name

    seeds: list[str] = []
    if selected and selected.lower() not in auto_set and not selected.startswith("未找到"):
        seeds.append(selected)
        if Path(selected).suffix == "":
            for ext in ext_set:
                seeds.append(f"{selected}{ext}")
    for candidate in candidates or []:
        text = str(candidate or "").strip()
        if text:
            seeds.append(text)

    seeds = _dedupe_keep_order(seeds)
    scored: list[tuple[int, int, int, str]] = []
    for seed_index, seed in enumerate(seeds or files[:1]):
        for filename in files:
            score = _gjjutils_model_match_score(seed, filename)
            if score <= 0:
                continue
            scored.append((score - seed_index * 10, -filename.count("/"), -len(filename), filename))

    if scored:
        scored.sort(reverse=True)
        rel_name = scored[0][3]
        full_path = _gjjutils_model_path_for_rel(folder_type, rel_name)
        if full_path:
            return full_path, rel_name

    subdir = f"models/{_gjjutils_normalize_model_relpath(relative_dir or folder_type)}"
    hints = ", ".join(seeds[:8]) or "Auto"
    raise FileNotFoundError(f"未找到{label}：{hints}。请把模型放入 {subdir} 后刷新或重启 ComfyUI。")


def gjjutils_resolve_model_name(
    selection: Any,
    folder_type: str,
    *,
    relative_dir: str | None = None,
    candidates: Any = None,
    extensions: Any = None,
    label: str = "模型",
    auto_values: Any = None,
) -> str:
    """Resolve a model and return the folder_paths-compatible relative name."""
    return gjjutils_resolve_model_file(
        selection,
        folder_type,
        relative_dir=relative_dir,
        candidates=candidates,
        extensions=extensions,
        label=label,
        auto_values=auto_values,
    )[1]


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
