from __future__ import annotations

import csv
import fnmatch
import importlib.util
import json
import os
from typing import Any, NamedTuple

import numpy as np
import torch
import torch.nn.functional as F

import folder_paths
from comfy import model_management
from comfy.model_patcher import ModelPatcher

try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        make_missing_model_spec,
        send_dependency_model_notice,
    )
except Exception:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        make_missing_model_spec,
        send_dependency_model_notice,
    )


NODE_NAME = "GJJ · 🏷️ WD图片标签器"
CATEGORY = "GJJ/图像处理"
MODEL_CATEGORY = "wd_taggers"
MODEL_SUBDIR = "models/wd_taggers"
PLACEHOLDER_MODEL = "[未找到 WD Tagger 模型]"
DEFAULT_MODEL_ORDER = (
    "wd-eva02-large-tagger-v3",
    "wd-vit-large-tagger-v3",
    "wd-vit-tagger-v3",
    "wd-swinv2-tagger-v3",
    "wd-convnext-tagger-v3",
)
DTYPE_MAP = {"自动": None, "bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}
TAGGER_REQUIRED_FILES = ("config.json", "model.safetensors", "selected_tags.csv")
DEPENDENCY_SPECS = (
    {
        "module_name": "timm",
        "package_name": "timm",
        "display_name": "timm",
        "description": "用于创建 WD Tagger 的本地模型结构。",
    },
    {
        "module_name": "safetensors.torch",
        "package_name": "safetensors",
        "display_name": "safetensors",
        "description": "用于读取 WD Tagger 的 model.safetensors 权重文件。",
    },
)

try:
    WD_TAGGER_DIR = os.path.join(folder_paths.models_dir, "wd_taggers")
    folder_paths.add_model_folder_path(MODEL_CATEGORY, WD_TAGGER_DIR)
except Exception:
    WD_TAGGER_DIR = os.path.abspath(os.path.join(os.getcwd(), "models", "wd_taggers"))


class LabelData(NamedTuple):
    names: list[str]
    rating: list[int]
    general: list[int]
    character: list[int]


def _norm_rel(path: str) -> str:
    return str(path or "").replace("\\", "/").strip("/")


def _model_roots() -> list[str]:
    roots: list[str] = []
    try:
        roots.extend(folder_paths.get_folder_paths(MODEL_CATEGORY))
    except Exception:
        pass
    roots.append(WD_TAGGER_DIR)
    seen: set[str] = set()
    unique: list[str] = []
    for root in roots:
        if not root:
            continue
        full = os.path.abspath(root)
        key = os.path.normcase(full)
        if key in seen:
            continue
        seen.add(key)
        unique.append(full)
    return unique


def _is_tagger_dir(path: str) -> bool:
    return all(os.path.isfile(os.path.join(path, name)) for name in TAGGER_REQUIRED_FILES)


def _scan_model_dirs() -> list[str]:
    names: set[str] = set()
    for root in _model_roots():
        if not os.path.isdir(root):
            continue
        for current, dirs, _files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in {".git", "__pycache__", ".cache"}]
            if not _is_tagger_dir(current):
                continue
            rel = os.path.relpath(current, root)
            names.add("." if rel == "." else _norm_rel(rel))
    ordered = [name for name in DEFAULT_MODEL_ORDER if name in names]
    ordered.extend(sorted(name for name in names if name not in DEFAULT_MODEL_ORDER))
    return ordered or [PLACEHOLDER_MODEL]


def _resolve_model_dir(model_name: str) -> str:
    requested = _norm_rel(model_name)
    if not requested or requested == PLACEHOLDER_MODEL:
        raise RuntimeError(f"未找到 WD Tagger 模型。请把模型目录放到 {MODEL_SUBDIR}/ 下。")
    for root in _model_roots():
        candidate = os.path.abspath(os.path.join(root, requested))
        try:
            common = os.path.commonpath([os.path.abspath(root), candidate])
        except Exception:
            continue
        if os.path.normcase(common) != os.path.normcase(os.path.abspath(root)):
            continue
        if _is_tagger_dir(candidate):
            return candidate
    raise RuntimeError(
        f"未找到完整 WD Tagger 模型：{MODEL_SUBDIR}/{requested}。"
        "目录内需要 config.json、model.safetensors、selected_tags.csv。"
    )


def _load_labels(path: str) -> LabelData:
    csv_path = os.path.join(path, "selected_tags.csv")
    with open(csv_path, "r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    names = [row.get("name", "") for row in rows]
    categories = [int(row.get("category", 0)) for row in rows]
    return LabelData(
        names=names,
        rating=[idx for idx, cat in enumerate(categories) if cat == 9],
        general=[idx for idx, cat in enumerate(categories) if cat == 0],
        character=[idx for idx, cat in enumerate(categories) if cat == 4],
    )


def _parse_notes(pretrained_cfg: dict[str, Any]) -> dict[str, Any]:
    for note in pretrained_cfg.get("notes", []):
        try:
            return json.loads(note)
        except (json.JSONDecodeError, TypeError):
            continue
    return {}


def _normalize_tag(name: str) -> str:
    return str(name or "").replace("_", " ").replace("(", "\\(").replace(")", "\\)")


def _dtype_value(dtype_name: str):
    return DTYPE_MAP.get(dtype_name, None)


def _module_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def _missing_dependency_specs() -> list[dict[str, str]]:
    return [spec for spec in DEPENDENCY_SPECS if not _module_available(spec["module_name"])]


def _missing_model_specs() -> list[dict[str, str]]:
    models = _scan_model_dirs()
    if models and models[0] != PLACEHOLDER_MODEL:
        return []
    return [
        make_missing_model_spec(
            label="WD Tagger 模型目录",
            subdir=MODEL_SUBDIR,
            filename="<模型名>/config.json + model.safetensors + selected_tags.csv",
            description="默认使用本地已有模型，不会联网下载。",
        )
    ]


def _build_environment_report() -> dict[str, Any]:
    return build_dependency_model_report(
        node_name=NODE_NAME,
        missing_dependencies=_missing_dependency_specs(),
        missing_models=_missing_model_specs(),
        install_packages=[spec["package_name"] for spec in DEPENDENCY_SPECS],
        description="WD 图片标签器需要本地模型目录，并需要当前 ComfyUI Python 能导入 timm 与 safetensors。",
        model_download_url="",
    )


def _build_missing_model_report() -> dict[str, Any]:
    return build_dependency_model_report(
        node_name=NODE_NAME,
        missing_models=_missing_model_specs(),
        description="WD 图片标签器只扫描本地模型目录。",
        model_download_url="",
    )


def _description() -> str:
    report = _build_environment_report()
    if report.get("available", False):
        return "本地 WD Timm 图片标签器：扫描 models/wd_taggers 下已有模型，输出 Danbooru 风格标签和原始置信度字典。"
    return report["warning_message"]


_ENV_REPORT = _build_environment_report()


class GJJWDTimmTagger:
    DESCRIPTION = _description()
    CATEGORY = CATEGORY
    RETURN_TYPES = ("STRING", "DICT")
    RETURN_NAMES = ("标签文本", "原始结果")
    OUTPUT_TOOLTIPS = (
        "按阈值筛出的标签文本。批量输入时每张图输出一条文本。",
        "包含 rating、character、general 三类置信度的原始字典。",
    )
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "tag"
    GJJ_HELP = {
        "description": DESCRIPTION,
        "notice": _ENV_REPORT["help_message"] if not _ENV_REPORT.get("available", True) else "",
        "install_cmd": _ENV_REPORT["install_cmd"] if not _ENV_REPORT.get("available", True) else "",
        "copy_text": _ENV_REPORT["copy_text"] if not _ENV_REPORT.get("available", True) else "",
        "copy_label": _ENV_REPORT["copy_label"] if not _ENV_REPORT.get("available", True) else "",
        "warning_message": _ENV_REPORT["warning_message"] if not _ENV_REPORT.get("available", True) else "",
        "models": [
            {
                "label": "WD Tagger 模型",
                "value": MODEL_SUBDIR,
                "description": "每个模型一个子目录，目录内放 config.json、model.safetensors、selected_tags.csv。",
            }
        ],
        "notes": [
            "节点不会从 HuggingFace 自动下载模型。",
            "默认优先选择 models/wd_taggers 下已存在的 SmilingWolf WD v3 模型。",
            "运行时需要当前 ComfyUI 环境可导入 timm 与 safetensors；GJJ requirements.txt 已列出这些通用依赖。",
        ],
    }

    def __init__(self):
        self.model_patcher: ModelPatcher | None = None
        self.labels: LabelData | None = None
        self.pad_color: float | None = None
        self.config: dict[str, Any] | None = None
        self.current_model_name: str | None = None
        self.current_dtype: str | None = None

    @classmethod
    def INPUT_TYPES(cls):
        models = _scan_model_dirs()
        default_model = models[0]
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "图像", "tooltip": "需要自动打标签的图像或图像批次。"}),
                "model_name": (models, {"default": default_model, "display_name": "WD模型", "tooltip": f"从 {MODEL_SUBDIR} 扫描到的本地模型目录。"}),
                "dtype": (list(DTYPE_MAP.keys()), {"default": "自动", "display_name": "模型精度", "tooltip": "自动会沿用权重精度；显存紧张可选 fp16 或 bf16。"}),
                "general_threshold": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "通用标签阈值", "tooltip": "general 标签置信度高于该值时输出。"}),
                "character_threshold": ("FLOAT", {"default": 0.75, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "角色标签阈值", "tooltip": "character 标签置信度高于该值时输出。"}),
                "add_rating": ("BOOLEAN", {"default": False, "display_name": "加入分级标签", "tooltip": "开启后把最高置信度 rating 标签放到最前面。"}),
                "exclude_tags": ("STRING", {"default": "", "display_name": "排除标签", "tooltip": "用英文逗号分隔要排除的标签，支持 * 和 ? 通配符。"}),
                "batch_size": ("INT", {"default": 4, "min": 1, "max": 32, "step": 1, "display_name": "批处理大小", "tooltip": "处理图像批次时每次送入模型的张数。显存不足时调小。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def _load_model(self, model_name: str, dtype: str, unique_id=None) -> None:
        if self.current_model_name == model_name and self.current_dtype == dtype and self.model_patcher is not None:
            return

        if model_name == PLACEHOLDER_MODEL:
            report = _build_missing_model_report()
            send_dependency_model_notice(report, unique_id=unique_id)
            raise RuntimeError(report["warning_message"])

        missing_deps = _missing_dependency_specs()
        if missing_deps:
            report = build_dependency_model_report(
                node_name=NODE_NAME,
                missing_dependencies=missing_deps,
                install_packages=[spec["package_name"] for spec in DEPENDENCY_SPECS],
                description="WD Timm Tagger 需要 timm 与 safetensors 才能加载本地模型。",
                model_download_url="",
            )
            send_dependency_model_notice(report, unique_id=unique_id)
            raise RuntimeError(report["warning_message"])

        model_dir = _resolve_model_dir(model_name)
        timm = load_dependency_at_runtime(
            "timm",
            node_name=NODE_NAME,
            package_name="timm",
            description="WD Timm Tagger 需要 timm 读取本地 tagger 网络结构。",
            unique_id=unique_id,
        )
        safetensors_torch = load_dependency_at_runtime(
            "safetensors.torch",
            node_name=NODE_NAME,
            package_name="safetensors",
            description="WD Timm Tagger 需要 safetensors 读取 model.safetensors。",
            unique_id=unique_id,
        )

        device = model_management.get_torch_device()
        try:
            base_model = timm.create_model(f"local-dir:{model_dir}").eval()
            state_dict = safetensors_torch.load_file(os.path.join(model_dir, "model.safetensors"))
            dtype_to = _dtype_value(dtype) or next(iter(state_dict.values())).dtype
            base_model = base_model.to(dtype_to)
            base_model.load_state_dict(state_dict)
            self.model_patcher = ModelPatcher(
                base_model,
                load_device=device,
                offload_device=model_management.intermediate_device(),
            )
            self.labels = _load_labels(model_dir)
            self.config = timm.data.resolve_data_config(base_model.pretrained_cfg, model=base_model)
            meta = _parse_notes(base_model.pretrained_cfg)
            pad = meta.get("pad_color", 255)
            self.pad_color = None if pad is None else float(pad) / 255.0
            self.current_model_name = model_name
            self.current_dtype = dtype
        except Exception as exc:
            raise RuntimeError(f"加载 WD Tagger 模型失败：{MODEL_SUBDIR}/{_norm_rel(model_name)}。{exc}") from exc

    def tag(
        self,
        image,
        model_name,
        dtype,
        general_threshold,
        character_threshold,
        add_rating,
        exclude_tags,
        batch_size,
        unique_id=None,
    ):
        self._load_model(model_name, dtype, unique_id=unique_id)
        if self.model_patcher is None or self.labels is None or self.config is None:
            raise RuntimeError("WD Tagger 模型尚未正确加载。")

        device = model_management.get_torch_device()
        img_tensor = image.permute(0, 3, 1, 2).to(torch.float32)
        batch_count, channels, height, width = img_tensor.shape
        if channels != 3:
            raise RuntimeError(f"WD Tagger 需要 RGB 图像，当前通道数为 {channels}。")

        _, target_h, target_w = self.config["input_size"]
        if self.pad_color is None:
            inputs = F.interpolate(img_tensor, size=(target_h, target_w), mode="bicubic", align_corners=False)
        else:
            scale = min(target_w / width, target_h / height, 1.0)
            new_w, new_h = max(1, int(width * scale)), max(1, int(height * scale))
            interp_mode = self.config.get("interpolation", "bicubic")
            resized = F.interpolate(img_tensor, size=(new_h, new_w), mode=interp_mode, align_corners=False)
            inputs = torch.full(
                (batch_count, channels, target_h, target_w),
                float(self.pad_color),
                dtype=img_tensor.dtype,
                device=img_tensor.device,
            )
            pad_y, pad_x = (target_h - new_h) // 2, (target_w - new_w) // 2
            inputs[:, :, pad_y : pad_y + new_h, pad_x : pad_x + new_w] = resized

        mean = torch.tensor(self.config["mean"], dtype=inputs.dtype, device=inputs.device).view(1, 3, 1, 1)
        std = torch.tensor(self.config["std"], dtype=inputs.dtype, device=inputs.device).view(1, 3, 1, 1)
        inputs = (inputs - mean) / std
        inputs = inputs[:, [2, 1, 0]]

        required_mem = int(batch_size) * int(np.prod(self.config["input_size"])) * 4 * 8
        model_management.free_memory(required_mem, device, keep_loaded=[self.model_patcher])
        model_management.load_model_gpu(self.model_patcher)

        exclude_patterns = [part.strip().lower() for part in str(exclude_tags or "").split(",") if part.strip()]
        results: list[str] = []
        raws: list[dict[str, Any]] = []
        model_dtype = next(self.model_patcher.model.parameters()).dtype

        def process_category(probs: np.ndarray, indices: list[int], threshold: float) -> dict[str, float]:
            subset = {
                self.labels.names[idx]: float(probs[idx].item())
                for idx in indices
                if probs[idx] > threshold and self.labels.names[idx]
            }
            return dict(sorted(subset.items(), key=lambda item: item[1], reverse=True))

        def is_excluded(name: str) -> bool:
            lower = name.lower()
            return any(fnmatch.fnmatchcase(lower, pattern) for pattern in exclude_patterns)

        for batch in torch.split(inputs, max(1, int(batch_size))):
            with torch.inference_mode():
                logits = self.model_patcher.model(batch.to(device=device, dtype=model_dtype))
                batch_probs = F.sigmoid(logits).detach().cpu()

            for probs in batch_probs:
                probs_np = probs.to(torch.float32).numpy()
                ratings = {self.labels.names[idx]: float(probs_np[idx].item()) for idx in self.labels.rating}
                character = process_category(probs_np, self.labels.character, float(character_threshold))
                general = process_category(probs_np, self.labels.general, float(general_threshold))
                top_rating = [max(ratings, key=ratings.get)] if add_rating and ratings else []
                combined_tags = top_rating + list(character.keys()) + list(general.keys())
                taglist = ", ".join(
                    normalized
                    for raw in combined_tags
                    if (normalized := _normalize_tag(raw)) and not is_excluded(normalized)
                )
                results.append(taglist + (", " if taglist else ""))
                raws.append({"ratings": ratings, "character": character, "general": general})

        return (results, raws)


NODE_CLASS_MAPPINGS = {
    "GJJ_WDTimmTagger": GJJWDTimmTagger,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WDTimmTagger": "🏷️ WD图片标签器",
}
