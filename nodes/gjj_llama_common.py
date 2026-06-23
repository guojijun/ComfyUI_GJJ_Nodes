from __future__ import annotations

import os
import re
from typing import Any

try:
    import folder_paths
except Exception:
    folder_paths = None


LLM_FOLDER_NAME = "LLM"
NO_MMPROJ = "无"
MISSING_LLM_MODEL = "（请把模型放到 models/LLM）"
MAIN_MODEL_EXTS = {".gguf", ".safetensors", ".bin", ".pth", ".pt"}
MMPROJ_EXTS = {".gguf", ".safetensors", ".bin"}


def ensure_llm_folder_registered() -> None:
    if folder_paths is None:
        return

    llm_dir = os.path.join(folder_paths.models_dir, LLM_FOLDER_NAME)
    supported_exts = set(getattr(folder_paths, "supported_pt_extensions", set()) or set())
    llm_exts = supported_exts | MAIN_MODEL_EXTS | MMPROJ_EXTS

    try:
        folders = folder_paths.folder_names_and_paths
        if LLM_FOLDER_NAME not in folders:
            folders[LLM_FOLDER_NAME] = ([llm_dir], llm_exts)
            return

        paths, exts = folders[LLM_FOLDER_NAME]
        if llm_dir not in paths:
            paths.append(llm_dir)

        if isinstance(exts, set):
            exts.update(llm_exts)
        else:
            folders[LLM_FOLDER_NAME] = (paths, set(exts) | llm_exts)
    except Exception:
        return


def list_llm_files() -> list[str]:
    ensure_llm_folder_registered()
    if folder_paths is None:
        return []
    try:
        return folder_paths.get_filename_list(LLM_FOLDER_NAME)
    except Exception:
        return []


def _ext(name: str) -> str:
    return os.path.splitext(str(name or ""))[1].lower()


def is_mmproj_file(name: str) -> bool:
    text = str(name or "").lower()
    return "mmproj" in text and _ext(text) in MMPROJ_EXTS


def is_llm_main_model_file(name: str) -> bool:
    text = str(name or "").lower()
    return "mmproj" not in text and _ext(text) in MAIN_MODEL_EXTS


def llm_main_model_options() -> list[str]:
    models = [item for item in list_llm_files() if is_llm_main_model_file(item)]
    return sorted(models, key=_natural_model_key) or [MISSING_LLM_MODEL]


def llm_mmproj_options() -> list[str]:
    mmprojs = [item for item in list_llm_files() if is_mmproj_file(item)]
    return [NO_MMPROJ] + sorted(mmprojs, key=_natural_model_key)


def llm_model_catalog() -> dict[str, Any]:
    return {
        "ok": True,
        "main_models": llm_main_model_options(),
        "mmproj_models": llm_mmproj_options(),
        "missing_label": MISSING_LLM_MODEL,
        "none_label": NO_MMPROJ,
    }


def resolve_llm_path(relative_name: str) -> str:
    name = str(relative_name or "").strip()
    if not name or name == NO_MMPROJ or name == MISSING_LLM_MODEL:
        return ""
    if folder_paths is not None:
        try:
            full_path = folder_paths.get_full_path(LLM_FOLDER_NAME, name)
            if full_path:
                return full_path
        except Exception:
            pass
        base = getattr(folder_paths, "models_dir", "")
    else:
        base = ""
    return os.path.join(base, LLM_FOLDER_NAME, name)


def best_mmproj_for_main_model(main_model: str, mmproj_models: list[str] | None = None) -> str:
    choices = list(mmproj_models or llm_mmproj_options())
    candidates = [item for item in choices if item and item != NO_MMPROJ]
    if not candidates:
        return NO_MMPROJ

    tokens = _model_tokens(main_model)
    if not tokens:
        return candidates[0]

    scored: list[tuple[int, int, str]] = []
    for item in candidates:
        item_tokens = set(_model_tokens(item))
        score = 0
        for token in tokens:
            if token in item_tokens:
                score += 4 if token in {"qwen", "gemma", "llama", "vl", "vision", "3", "4"} else 2
            elif any(token in other or other in token for other in item_tokens):
                score += 1
        lowered = item.lower()
        if "mmproj" in lowered:
            score += 1
        scored.append((score, -len(item), item))

    scored.sort(key=lambda item: (item[0], item[1], item[2].lower()), reverse=True)
    return scored[0][2] if scored and scored[0][0] > 0 else candidates[0]


def _model_tokens(name: str) -> list[str]:
    stem = os.path.splitext(os.path.basename(str(name or "").lower()))[0]
    stem = stem.replace("mmproj", " ")
    parts = re.split(r"[^a-z0-9.]+", stem)
    tokens: list[str] = []
    for part in parts:
        if not part or part in {"model", "main", "instruct", "gguf", "bf16", "fp16", "q4", "q5", "q8"}:
            continue
        tokens.extend(item for item in re.split(r"(?<=\D)(?=\d)|(?<=\d)(?=\D)", part) if item)
    return tokens


def _natural_model_key(name: str):
    text = str(name or "").replace("\\", "/").lower()
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", text)]
