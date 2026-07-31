from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import folder_paths


DOWNLOAD_URL = "https://pan.quark.cn/s/4b5a36d50e9c"
PLACEHOLDER_VALUES = {
    "none", "empty", "default", "auto", "automatic",
    "disabled", "enabled", "无", "空", "默认", "自动",
}
MODEL_FILE_EXTENSIONS = {
    ".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx",
    ".torchscript", ".engine", ".sft", ".vae", ".tflite", ".pb", ".h5",
}
CACHE_CATEGORIES = {"latency", "cache", "caches", "temp", "tmp"}
CACHE_PATH_PARTS = {"auxiliary", "__pycache__", ".cache", ".git"}
NON_MODEL_CATEGORIES = {"fonts"}
DIRECTORY_MODEL_CATEGORIES = {"asr", "translation"}

# Widget name -> (display folder, icon, folder_paths categories).
MODEL_WIDGETS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "diffusion": ("diffusion_models", "🟣", ("diffusion_models", "unet")),
    "checkpoint_model": ("checkpoints", "🟣", ("checkpoints",)),
    "wanvideo_model": ("diffusion_models", "🟣", ("diffusion_models", "unet")),
    "checkpoint_clip": ("text_encoders", "🟡", ("text_encoders", "clip")),
    "clip": ("text_encoders", "🟡", ("text_encoders", "clip")),
    "wan_t5_encoder": ("text_encoders", "🟡", ("text_encoders", "clip")),
    "vae": ("vae", "🔴", ("vae",)),
    "ltx_audio_vae": ("vae", "🔴", ("vae",)),
    "checkpoint_vae": ("vae", "🔴", ("vae",)),
    "wan_vae": ("vae", "🔴", ("vae",)),
    "clip_vision": ("clip_vision", "🔵", ("clip_vision",)),
    "audio_encoder": ("audio_encoders", "🔵", ("audio_encoders", "wav2vec2")),
    "asr": ("ASR", "🔵", ("ASR",)),
    "model_patch": ("model_patches", "🔵", ("model_patches",)),
    "loras": ("loras", "🟠", ("loras",)),
    "latent_upscale_model": ("latent_upscale_models", "🟤", ("latent_upscale_models", "upscale_models")),
    "name_any": ("latent_upscale_models", "🟤", ("latent_upscale_models", "upscale_models")),
    "geometry_estimation": ("geometry_estimation", "🟤", ("geometry_estimation",)),
    "translation": ("translation", "🌍", ("translation",)),
}

CATEGORY_DISPLAY_ALIASES = {
    "unet": "diffusion_models",
    "unet_gguf": "diffusion_models",
    "clip": "text_encoders",
    "clip_gguf": "text_encoders",
    "wav2vec2": "audio_encoders",
}


def _category_icon(category: str) -> str:
    key = str(category or "").strip().lower()
    if key in {
        "diffusion_models", "unet", "unet_gguf", "checkpoints",
        "rmbg", "birefnet", "background_removal",
    }:
        return "🟣"
    if key in {"text_encoders", "clip", "clip_gguf"}:
        return "🟡"
    if key == "vae":
        return "🔴"
    if key in {"clip_vision", "audio_encoders", "wav2vec2", "model_patches"}:
        return "🔵"
    if key == "asr":
        return "🔵"
    if key in {"loras", "lora"}:
        return "🟠"
    if key in {"latent_upscale_models", "upscale_models", "geometry_estimation"}:
        return "🟤"
    if key == "translation":
        return "🌍"
    return "⚪"


def _existing_category_names(categories: tuple[str, ...]) -> list[str]:
    registered = getattr(folder_paths, "folder_names_and_paths", {}) or {}
    return [category for category in categories if category in registered]


def _model_lookup_key(value: str) -> str:
    text = str(value or "").strip().strip("\"'").replace("\\", "/").strip("/")
    lowered = text.casefold()
    marker = "/models/"
    if marker in lowered:
        text = text[lowered.rfind(marker) + len(marker):]
    elif lowered.startswith("models/"):
        text = text[len("models/"):]
    return text.casefold()


def _models_tree_index() -> dict[str, tuple[str, str, str]]:
    root = Path(getattr(folder_paths, "models_dir", "") or "")
    if not root.is_dir():
        return {}
    index: dict[str, tuple[str, str, str]] = {}

    def add(relative: Path, full_path: Path) -> None:
        parts = relative.parts
        if len(parts) < 2:
            return
        lowered_parts = {str(part).casefold() for part in parts}
        if str(parts[0]).casefold() in CACHE_CATEGORIES or lowered_parts & CACHE_PATH_PARTS:
            return
        category = str(parts[0])
        if full_path.is_dir() and category.casefold() not in DIRECTORY_MODEL_CATEGORIES:
            return
        display_name = str(Path(*parts[1:])).replace("/", "\\")
        entry = (category, display_name, str(full_path))
        relative_key = _model_lookup_key(str(relative))
        basename_key = str(parts[-1]).casefold()
        index.setdefault(relative_key, entry)
        previous = index.get(basename_key)
        if previous is None or len(display_name) < len(previous[1]):
            index[basename_key] = entry

    try:
        for current, directory_names, file_names in os.walk(root):
            current_path = Path(current)
            for directory_name in directory_names:
                full_path = current_path / directory_name
                add(full_path.relative_to(root), full_path)
            for file_name in file_names:
                full_path = current_path / file_name
                add(full_path.relative_to(root), full_path)
    except (OSError, ValueError):
        return index
    return index


def _path_size(path_value: str) -> int:
    path = Path(path_value)
    try:
        if path.is_file():
            return max(0, int(path.stat().st_size))
        if path.is_dir():
            total = 0
            for current, _, file_names in os.walk(path):
                for file_name in file_names:
                    try:
                        total += max(0, int((Path(current) / file_name).stat().st_size))
                    except OSError:
                        continue
            return total
    except OSError:
        pass
    return 0


def _format_size(size_bytes: int) -> str:
    size = max(0, int(size_bytes))
    units = ("B", "KB", "MB", "GB", "TB")
    value = float(size)
    for unit in units:
        if value < 1024.0 or unit == units[-1]:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.2f} {unit}"
        value /= 1024.0
    return f"{size} B"


def _find_model(
    name: str,
    categories: tuple[str, ...],
    tree_index: dict[str, tuple[str, str, str]],
) -> tuple[bool, str, str, str]:
    clean_name = str(name or "").strip()
    if not clean_name or clean_name.casefold() in PLACEHOLDER_VALUES:
        return False, "", "", clean_name
    indexed = tree_index.get(_model_lookup_key(clean_name))
    if indexed is not None:
        category, display_name, full_path = indexed
        return True, full_path, category, display_name
    registered = getattr(folder_paths, "folder_names_and_paths", {}) or {}
    manual = [category for category in categories if str(category).lower() == "asr"]
    preferred = manual + [
        category for category in _existing_category_names(categories)
        if category not in manual
    ]
    search_categories = preferred + [
        str(category) for category in registered
        if str(category) not in preferred
    ]
    for category in search_categories:
        if str(category).lower() == "asr":
            models_dir = Path(getattr(folder_paths, "models_dir", "") or "")
            candidate = models_dir / "ASR" / clean_name
            if candidate.is_dir():
                return True, str(candidate), "ASR", clean_name
            continue
        try:
            full_path = folder_paths.get_full_path(category, clean_name)
        except Exception:
            full_path = None
        if full_path and Path(full_path).is_file():
            return True, str(full_path), str(category), clean_name
    return False, "", "", clean_name


def _build_report(items: list[dict[str, Any]]) -> dict[str, Any]:
    groups: dict[str, dict[str, Any]] = {}
    models_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    tree_index = _models_tree_index()
    expanded_items = list(items)
    ace_markers = [
        item for item in items
        if (
        str(item.get("widget_name") or "") == "__implicit_ace_asr__"
        and bool(item.get("enabled"))
        )
    ]
    if ace_markers:
        preferred_asr = next(
            (
                name for name in ("Qwen3-ASR-1.7B", "Qwen3-ASR-0.6B")
                if _model_lookup_key(name) in tree_index
            ),
            "Qwen3-ASR-1.7B",
        )
        for marker in ace_markers:
            for dependency_name in (preferred_asr, "Qwen3-ForcedAligner-0.6B"):
                expanded_items.append({
                    "widget_name": "asr",
                    "name": dependency_name,
                    "node_id": marker.get("node_id"),
                    "node_type": marker.get("node_type") or "GJJ_AudioAceMusicGenerator",
                    "node_title": marker.get("node_title"),
                })
    matting_markers = [
        item for item in items
        if str(item.get("widget_name") or "") == "__implicit_matting_models__"
    ]
    if matting_markers:
        fallback_paths = {
            "RMBG1.4": ("RMBG", "rmbg1.4.safetensors"),
            "RMBG2": ("RMBG", "rmbg2.safetensors"),
            "官方背景移除": ("background_removal", "birefnet.safetensors"),
            "BiRefNet 通用": ("BiRefNet", "General.safetensors"),
            "BiRefNet 精细": ("BiRefNet", "Matting.safetensors"),
            "BEN2": ("RMBG", r"BEN2\BEN2_Base.pth"),
            "Inspyrenet": ("RMBG", "InSPyReNet_SwinB.pth"),
        }
        try:
            from .gjj_comprehensive_matting import _resolve_model_path
        except Exception:
            _resolve_model_path = None
        for marker in matting_markers:
            for raw_method in marker.get("methods") or []:
                method = str(raw_method or "").strip()
                if not method:
                    continue
                resolved_name = ""
                if _resolve_model_path is not None:
                    try:
                        resolved_name = str(_resolve_model_path(method))
                    except Exception:
                        resolved_name = ""
                folder, fallback_name = fallback_paths.get(method, ("RMBG", method))
                expanded_items.append({
                    "widget_name": "diffusion",
                    "name": resolved_name or fallback_name,
                    "folder": folder,
                    "node_id": marker.get("node_id"),
                    "node_type": marker.get("node_type") or "GJJ_ComprehensiveMatting",
                    "node_title": marker.get("node_title"),
                })

    for item in expanded_items:
        if str(item.get("widget_name") or "") in {
            "__implicit_ace_asr__",
            "__implicit_matting_models__",
        }:
            continue
        widget_name = str(item.get("widget_name") or "").strip().lower()
        definition = MODEL_WIDGETS.get(widget_name)
        if definition is None:
            folder, icon, categories = ("unknown", "⚪", ())
        else:
            folder, icon, categories = definition
        folder_hint = str(item.get("folder") or "").strip().strip("/\\")
        if folder_hint:
            folder = folder_hint
            categories = tuple(dict.fromkeys((folder_hint, *categories)))
        name = str(item.get("name") or "").strip()
        if not name or name.casefold() in PLACEHOLDER_VALUES:
            continue
        exists, full_path, matched_category, display_name = _find_model(
            name,
            categories,
            tree_index,
        )
        if str(matched_category or "").strip().casefold() in NON_MODEL_CATEGORIES:
            continue
        # Broad canvas scanning also sees prompts, Markdown previews and report
        # text.  An unresolved value without a known model kind is prose, not a
        # missing model.  Known model widgets still retain red missing entries.
        if definition is None and not matched_category:
            continue
        if (
            definition is not None
            and not matched_category
            and widget_name != "asr"
            and Path(name).suffix.casefold() not in MODEL_FILE_EXTENSIONS
            and "/" not in name
            and "\\" not in name
        ):
            # Values such as "ace", "default" or precision/mode choices can
            # live in widgets whose names mention a model type.  Without a
            # model extension, a path, or a real models/ match they are options.
            continue
        if matched_category:
            folder = CATEGORY_DISPLAY_ALIASES.get(matched_category, matched_category)
            icon = _category_icon(matched_category)
        dedupe_key = (folder.casefold(), display_name.casefold())
        usage_name = str(item.get("node_title") or item.get("node_type") or "").strip()
        existing_model = models_by_key.get(dedupe_key)
        if existing_model is not None:
            if usage_name and usage_name not in existing_model["used_by"]:
                existing_model["used_by"].append(usage_name)
            continue

        group = groups.setdefault(folder, {"folder": folder, "models": []})
        size_bytes = _path_size(full_path) if exists else 0
        model_entry = {
            "name": display_name,
            "icon": icon,
            "exists": exists,
            "empty": False,
            "path": full_path,
            "size_bytes": size_bytes,
            "size_text": _format_size(size_bytes) if exists else "",
            "widget_name": widget_name,
            "node_id": item.get("node_id"),
            "node_type": item.get("node_type"),
            "used_by": [usage_name] if usage_name else [],
        }
        group["models"].append(model_entry)
        models_by_key[dedupe_key] = model_entry

    ordered_groups = list(groups.values())
    for group in ordered_groups:
        group["models"].sort(key=lambda model: (model["empty"], model["name"].casefold()))
    ordered_groups.sort(key=lambda group: group["folder"].casefold())

    lines = [f"## [🌏 模型下载]({DOWNLOAD_URL})", "📁 ComfyUI/", "└──📁 models/"]
    for group in ordered_groups:
        lines.append(f"　　└──📁 {group['folder']}/")
        for model in group["models"]:
            suffix = "" if model["exists"] else "  ❌ 缺失"
            size_suffix = f"  [{model['size_text']}]" if model["size_text"] else ""
            lines.append(f"　　　　└──{model['icon']}{model['name']}{size_suffix}{suffix}")
    total_size_bytes = sum(
        int(model["size_bytes"])
        for group in ordered_groups
        for model in group["models"]
    )
    return {
        "download_url": DOWNLOAD_URL,
        "groups": ordered_groups,
        "text": "\n".join(lines),
        "model_count": sum(len(group["models"]) for group in ordered_groups),
        "missing_count": sum(
            1 for group in ordered_groups for model in group["models"]
            if not model["exists"]
        ),
        "total_size_bytes": total_size_bytes,
        "total_size_text": _format_size(total_size_bytes),
    }


class GJJ_WorkflowModelStatistics:
    CATEGORY = "GJJ/工作流辅助"
    FUNCTION = "format_report"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("模型统计文本",)
    OUTPUT_TOOLTIPS = ("当前执行提示中识别到的模型目录树文本。画布面板可直接统计整个当前工作流。",)
    DESCRIPTION = "直接扫描当前工作流全部节点使用的模型，按目录显示并检查缺失文件。"
    SEARCH_ALIASES = ["工作流模型统计", "模型统计", "模型清单", "workflow models", "model statistics"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {
                "prompt": "PROMPT",
            },
        }

    def format_report(self, prompt=None):
        items: list[dict[str, Any]] = []
        if isinstance(prompt, dict):
            for node_id, node_data in prompt.items():
                if not isinstance(node_data, dict):
                    continue
                node_type = str(node_data.get("class_type") or "")
                inputs = node_data.get("inputs")
                if not isinstance(inputs, dict):
                    continue
                for widget_name, value in inputs.items():
                    if str(widget_name).lower() not in MODEL_WIDGETS:
                        continue
                    if isinstance(value, str):
                        items.append({
                            "node_id": node_id,
                            "node_type": node_type,
                            "widget_name": widget_name,
                            "name": value,
                        })
        return (_build_report(items)["text"],)


def _register_api() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return
    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(server, "_gjj_workflow_model_statistics_api_registered", False):
        return

    @server.routes.post("/gjj/workflow_model_statistics")
    async def workflow_model_statistics(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        items = data.get("items") if isinstance(data, dict) else []
        if not isinstance(items, list):
            items = []
        return web.json_response(_build_report([item for item in items if isinstance(item, dict)]))

    server._gjj_workflow_model_statistics_api_registered = True


_register_api()

NODE_CLASS_MAPPINGS = {
    "GJJ_WorkflowModelStatistics": GJJ_WorkflowModelStatistics,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WorkflowModelStatistics": "🔢 工作流模型统计",
}
