from __future__ import annotations

import json
import os
from typing import Any

import folder_paths
from aiohttp import web

try:
    from server import PromptServer
except Exception:
    PromptServer = None


NODE_NAME = "GJJ_WanVideoHighLowLora"
LORA_API_PATH = "/gjj/wanvideo_loras"


def _hidden_string(default: str = "[]") -> tuple[str, dict[str, Any]]:
    return (
        "STRING",
        {
            "default": default,
            "multiline": False,
            "display_name": "WanVideo LoRA配置",
            "tooltip": "由前端动态面板保存的 WanVideo High/Low LoRA 配置 JSON。",
            "hidden": True,
            "display": "hidden",
            "forceInput": False,
        },
    )


def _hidden_bool(default: bool, label: str, tooltip: str) -> tuple[str, dict[str, Any]]:
    return (
        "BOOLEAN",
        {
            "default": bool(default),
            "display_name": label,
            "tooltip": tooltip,
            "hidden": True,
            "display": "hidden",
            "forceInput": False,
        },
    )


async def _get_wanvideo_lora_list(_request):
    loras = [""] + list(folder_paths.get_filename_list("loras"))
    return web.json_response({"loras": loras})


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    server = PromptServer.instance
    if not getattr(server, "_gjj_wanvideo_loras_api_registered", False):
        server.routes.get(LORA_API_PATH)(_get_wanvideo_lora_list)
        server._gjj_wanvideo_loras_api_registered = True


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in {"1", "true", "yes", "on", "开", "开启"}


def _parse_rows(raw_value: Any) -> list[dict[str, Any]]:
    if raw_value is None:
        return []
    try:
        parsed = json.loads(str(raw_value or "[]"))
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []

    rows: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        branch = str(item.get("branch", "high")).strip().lower()
        if branch not in {"high", "low"}:
            branch = "high"
        name = str(item.get("name", "") or "").strip()
        if not name or name.lower() in {"none", "未选择"}:
            continue
        try:
            strength = round(float(item.get("strength", 1.0)), 4)
        except (TypeError, ValueError):
            strength = 1.0
        rows.append(
            {
                "branch": branch,
                "name": name,
                "strength": strength,
                "enabled": item.get("enabled", True) is not False,
            }
        )
    return rows


def _resolve_lora_path(lora_name: str) -> str:
    try:
        return folder_paths.get_full_path_or_raise("loras", lora_name)
    except Exception as exc:
        raise RuntimeError(
            f"未找到 WanVideo LoRA 文件：{lora_name}\n"
            "请确认文件位于 models/loras 下，并在节点面板点击“刷新列表”。"
        ) from exc


def _build_wan_loras(
    rows: list[dict[str, Any]],
    branch: str,
    *,
    low_mem_load: bool,
    merge_loras: bool,
) -> list[dict[str, Any]]:
    loras: list[dict[str, Any]] = []
    for row in rows:
        if row.get("branch") != branch or row.get("enabled") is False:
            continue
        strength = float(row.get("strength", 1.0))
        if abs(strength) < 1e-8:
            continue
        lora_name = str(row.get("name", "") or "").strip()
        if not lora_name:
            continue
        loras.append(
            {
                "path": _resolve_lora_path(lora_name),
                "strength": round(strength, 4),
                "name": os.path.splitext(lora_name)[0],
                "blocks": {},
                "layer_filter": "",
                "low_mem_load": bool(low_mem_load and merge_loras),
                "merge_loras": bool(merge_loras),
            }
        )
    return loras


def _apply_wan_set_loras(model: Any, loras: list[dict[str, Any]], branch_label: str):
    if not loras:
        return model

    merge_requested = any(item.get("merge_loras", False) for item in loras)
    if merge_requested:
        raise RuntimeError(
            f"{branch_label} 路 LoRA 已打开“合并”开关，但当前节点是 WANVIDEOMODEL 后置应用节点，"
            "底层 WanVideoSetLoRAs 只支持非合并 LoRA。请关闭“合并”后再执行。"
        )

    try:
        from ..vendor.wanvideo_wrapper.nodes_model_loading import WanVideoSetLoRAs
    except Exception as exc:
        raise RuntimeError(
            "加载 GJJ 内置 WanVideo runtime 失败，无法应用 WanVideo LoRA。\n"
            f"{type(exc).__name__}: {exc}"
        ) from exc

    try:
        result = WanVideoSetLoRAs().setlora(model, loras)
    except Exception as exc:
        names = "、".join(str(item.get("name", "")) for item in loras)
        raise RuntimeError(f"{branch_label} 路 WanVideo LoRA 应用失败：{names}\n{exc}") from exc

    return result[0] if isinstance(result, (tuple, list)) else result


class GJJ_WanVideoHighLowLora:
    CATEGORY = "GJJ/视频模型/WanVideo"
    FUNCTION = "apply_loras"
    RETURN_TYPES = ("WANVIDEOMODEL", "WANVIDEOMODEL")
    RETURN_NAMES = ("High模型", "Low模型")
    OUTPUT_TOOLTIPS = (
        "已在节点内部应用 High 路 LoRA 的 WanVideo 模型。",
        "已在节点内部应用 Low 路 LoRA 的 WanVideo 模型。",
    )
    DESCRIPTION = (
        "WanVideo High/Low 双路 LoRA 节点。面板内可扩充多组 LoRA 对，"
        "High 输入只输出 High 模型，Low 输入只输出 Low 模型。"
    )
    SEARCH_ALIASES = [
        "WanVideoLoraSelect",
        "WanVideoSetLoRAs",
        "WanVideo LoRA",
        "High Low LoRA",
        "双路LoRA",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "high_model": (
                    "WANVIDEOMODEL",
                    {
                        "display_name": "🔺 High模型",
                        "tooltip": "Wan2.2 High / 高噪声分支模型输入。",
                    },
                ),
                "low_model": (
                    "WANVIDEOMODEL",
                    {
                        "display_name": "🔻 Low模型",
                        "tooltip": "Wan2.2 Low / 低噪声分支模型输入。",
                    },
                ),
                "wan_lora_data": _hidden_string(),
                "low_mem_load": _hidden_bool(
                    False,
                    "低显存加载",
                    "对齐 WanVideoLoraSelect 的 low_mem_load；仅合并加载路径有效，本节点后置应用默认无效。",
                ),
                "merge_loras": _hidden_bool(
                    False,
                    "合并LoRA",
                    "对齐 WanVideoLoraSelect 的 merge_loras。当前后置 WANVIDEOMODEL 节点不支持合并，开启后会给出中文错误。",
                ),
            },
        }

    def apply_loras(
        self,
        high_model,
        low_model,
        wan_lora_data="[]",
        low_mem_load=False,
        merge_loras=False,
    ):
        rows = _parse_rows(wan_lora_data)
        low_mem = _truthy(low_mem_load)
        merge = _truthy(merge_loras)

        high_loras = _build_wan_loras(rows, "high", low_mem_load=low_mem, merge_loras=merge)
        low_loras = _build_wan_loras(rows, "low", low_mem_load=low_mem, merge_loras=merge)

        high_out = _apply_wan_set_loras(high_model, high_loras, "High")
        low_out = _apply_wan_set_loras(low_model, low_loras, "Low")
        return (high_out, low_out)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanVideoHighLowLora,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "🎬 WanVideo双路LoRA",
}
