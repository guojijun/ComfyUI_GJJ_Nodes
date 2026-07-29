from __future__ import annotations

import json
from pathlib import Path
from typing import Any


SECTION = "mtv_ltx_prompt_bridge"
SETTINGS_PATH = Path(__file__).resolve().parents[2] / "presets" / "gjj_user_settings.json"


def read_mtv_ltx_prompt_settings() -> dict[str, str]:
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    section = data.get(SECTION) if isinstance(data, dict) else {}
    if not isinstance(section, dict):
        return {}
    return {str(key): str(value or "") for key, value in section.items()}


def prompt_setting(name: str, fallback: Any = "") -> str:
    value = read_mtv_ltx_prompt_settings().get(str(name))
    return str(fallback if value is None else value)
