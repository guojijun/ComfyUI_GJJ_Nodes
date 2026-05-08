from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path
from typing import Any

from aiohttp import web

try:
    from server import PromptServer
except Exception:
    PromptServer = None

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
PRESET_TABLE_API_PATH = "/gjj/model_family_presets"


def _normalize_lookup_text(value: str) -> str:
    return "".join(ch for ch in str(value or "").strip().lower() if ch.isalnum())


def _parse_bool(value: str) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _parse_number(value: str, integer: bool) -> int | float | None:
    text = str(value or "").strip()
    if not text:
        return None
    number = float(text)
    return int(number) if integer else number


def _parse_row(row: dict[str, str]) -> dict[str, Any]:
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


def _iter_data_lines(handle):
    for line in handle:
        text = str(line or "").strip()
        if not text or text.startswith("#"):
            continue
        yield line


def _read_effective_lines() -> list[str]:
    with PRESET_TABLE_PATH.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(_iter_data_lines(handle))


def _split_tsv_line(line: str) -> list[str]:
    return [part.strip() for part in str(line or "").rstrip("\r\n").split("\t")]


def _find_header_index(lines: list[str]) -> int:
    for index, line in enumerate(lines):
        columns = _split_tsv_line(line)
        if len(columns) >= 2 and columns[0] == "id" and columns[1] == "keywords":
            return index
    raise RuntimeError(f"预设表缺少表头行：{PRESET_TABLE_PATH}")


@lru_cache(maxsize=1)
def load_model_family_presets() -> list[dict[str, Any]]:
    lines = _read_effective_lines()
    header_index = _find_header_index(lines)
    reader = csv.DictReader(lines[header_index:], delimiter="\t")
    return [_parse_row(row) for row in reader]


async def get_model_family_presets_api(request):
    return web.json_response({"presets": load_model_family_presets()})


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.get(PRESET_TABLE_API_PATH)(
        get_model_family_presets_api
    )


def match_model_family_preset(
    unet_name: str, presets: list[dict[str, Any]] | None = None
) -> dict[str, Any] | None:
    normalized_unet = _normalize_lookup_text(unet_name)
    if not normalized_unet:
        return None
    best: dict[str, Any] | None = None
    best_length = -1
    for preset in presets or load_model_family_presets():
        for keyword in preset.get("keywords", []) or []:
            normalized_keyword = _normalize_lookup_text(keyword)
            if (
                normalized_keyword
                and normalized_keyword in normalized_unet
                and len(normalized_keyword) > best_length
            ):
                best = preset
                best_length = len(normalized_keyword)
    return best
