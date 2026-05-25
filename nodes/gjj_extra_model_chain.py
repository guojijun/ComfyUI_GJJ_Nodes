from __future__ import annotations

from typing import Any
import json

import folder_paths
from aiohttp import web

try:
    from server import PromptServer
except Exception:
    PromptServer = None


NODE_NAME = "GJJ_ExtraModelChainConfig"
EXTRA_MODEL_CHAIN = "EXTRA_MODEL_CHAIN"
VACEPATH = "VACEPATH"
FANTASYTALKINGMODEL = "FANTASYTALKINGMODEL"
MULTITALKMODEL = "MULTITALKMODEL"
FANTASYPORTRAITMODEL = "FANTASYPORTRAITMODEL"
LIST_API = "/gjj/extra_model_chain_lists"

EXTRA_MODEL_KIND_DEFS = [
    {
        "value": "vace",
        "label": "VACE",
        "icon": "🧩",
        "keywords": [["vace"]],
    },
    {
        "value": "fantasytalking",
        "label": "FantasyTalking",
        "icon": "🗣",
        "keywords": [["fantasytalking"], ["fantasy", "talk"]],
    },
    {
        "value": "multitalk",
        "label": "MultiTalk / InfiniteTalk",
        "icon": "🎤",
        "keywords": [["multitalk"], ["infinite", "talk"], ["infinitetalk"]],
    },
    {
        "value": "fantasyportrait",
        "label": "FantasyPortrait",
        "icon": "🧑",
        "keywords": [["fantasy"], ["fantasy", "portrait"], ["portrait"]],
    },
]
EXTRA_MODEL_KINDS = {item["value"] for item in EXTRA_MODEL_KIND_DEFS}
BRANCH_VALUES = {"both", "high", "low"}
PRECISION_VALUES = {"fp16", "bf16", "fp32"}


def hidden_extra_model_data_input() -> tuple[str, dict[str, Any]]:
    return (
        "STRING",
        {
            "default": "[]",
            "multiline": False,
            "display_name": "额外模型配置",
            "tooltip": "由前端动态界面自动维护的额外模型串联 JSON，一般无需手动编辑。",
            "hidden": True,
            "display": "hidden",
            "forceInput": False,
        },
    )


def _filename_list(kind: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(kind))
    except Exception:
        return []


def _dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value or "").strip()
        key = text.replace("\\", "/").lower()
        if not text or key in seen:
            continue
        result.append(text)
        seen.add(key)
    return result


def _all_wan_extra_model_names() -> list[str]:
    return _dedupe(_filename_list("unet_gguf") + _filename_list("diffusion_models"))


def _is_usable_model_name(name: str) -> bool:
    lower = str(name or "").replace("\\", "/").lower().strip()
    if not lower or lower.endswith(".metadata.json"):
        return False
    return lower.endswith((".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".bin", ".gguf"))


def _matches_keyword_group(name: str, group: list[str]) -> bool:
    text = str(name or "").replace("\\", "/").lower()
    return all(str(word or "").lower() in text for word in group if str(word or "").strip())


def _models_for_kind(kind: str, names: list[str]) -> list[str]:
    usable = [name for name in names if _is_usable_model_name(name)]
    kind_def = next((item for item in EXTRA_MODEL_KIND_DEFS if item["value"] == kind), None)
    if not kind_def:
        return usable
    matched = [
        name
        for name in usable
        if any(_matches_keyword_group(name, group) for group in kind_def.get("keywords", []))
    ]
    return matched or usable


async def get_gjj_extra_model_chain_lists(request):
    all_models = _all_wan_extra_model_names()
    return web.json_response(
        {
            "kinds": EXTRA_MODEL_KIND_DEFS,
            "branches": [
                {"value": "both", "label": "全部"},
                {"value": "high", "label": "High"},
                {"value": "low", "label": "Low"},
            ],
            "precisions": ["fp16", "bf16", "fp32"],
            "models": {kind: _models_for_kind(kind, all_models) for kind in EXTRA_MODEL_KINDS},
            "all_models": all_models,
        }
    )


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.get(LIST_API)(get_gjj_extra_model_chain_lists)


def _parse_raw_rows(raw_value: Any) -> list[dict[str, Any]]:
    if raw_value is None:
        return []
    if isinstance(raw_value, list):
        raw = raw_value
    else:
        try:
            raw = json.loads(str(raw_value or "[]"))
        except Exception:
            return []
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def normalize_extra_model_kind(value: Any) -> str:
    kind = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "fantasy_talking": "fantasytalking",
        "ft": "fantasytalking",
        "multi_talk": "multitalk",
        "infinite_talk": "multitalk",
        "infinitetalk": "multitalk",
        "fantasy_portrait": "fantasyportrait",
        "portrait": "fantasyportrait",
    }
    kind = aliases.get(kind, kind)
    return kind if kind in EXTRA_MODEL_KINDS else "vace"


def normalize_extra_model_branch(value: Any) -> str:
    branch = str(value or "both").strip().lower()
    aliases = {
        "all": "both",
        "全部": "both",
        "高": "high",
        "低": "low",
    }
    branch = aliases.get(branch, branch)
    return branch if branch in BRANCH_VALUES else "both"


def normalize_extra_model_precision(value: Any) -> str:
    precision = str(value or "fp16").strip().lower()
    return precision if precision in PRECISION_VALUES else "fp16"


def parse_extra_model_chain_data(raw_value: Any, *, enabled_only: bool = False) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in _parse_raw_rows(raw_value):
        name = str(item.get("name") or item.get("model") or item.get("file") or "").strip()
        if not name:
            continue
        enabled = item.get("enabled", True) is not False
        if enabled_only and not enabled:
            continue
        items.append(
            {
                "enabled": enabled,
                "kind": normalize_extra_model_kind(item.get("kind")),
                "name": name,
                "branch": normalize_extra_model_branch(item.get("branch")),
                "base_precision": normalize_extra_model_precision(
                    item.get("base_precision", item.get("precision", "fp16"))
                ),
            }
        )
    return items


def normalize_extra_model_chain_data(raw_value: Any) -> str:
    return json.dumps(parse_extra_model_chain_data(raw_value), ensure_ascii=False)


def _unwrap_loader_output(value: Any) -> Any:
    if isinstance(value, tuple) and len(value) == 1:
        return value[0]
    return value


def _get_full_path_any(categories: tuple[str, ...], model_name: str) -> str:
    last_error: Exception | None = None
    for category in categories:
        try:
            path = folder_paths.get_full_path(category, model_name)
            if path:
                return path
        except Exception as error:
            last_error = error
        try:
            return folder_paths.get_full_path_or_raise(category, model_name)
        except Exception as error:
            last_error = error
    raise RuntimeError(f"未找到模型文件：{model_name}") from last_error


def _valid_selected_model_name(model_name: Any) -> str:
    text = str(model_name or "").strip()
    if not text or text in {"[未找到模型]", "[未启用]", "未选择"}:
        return ""
    return text


def _make_vace_payload(model_name: str) -> list[dict[str, str]] | None:
    name = _valid_selected_model_name(model_name)
    if not name:
        return None
    return [{"path": _get_full_path_any(("diffusion_models", "unet_gguf"), name)}]


def _load_fantasytalking_model(model_name: str, base_precision: str):
    name = _valid_selected_model_name(model_name)
    if not name:
        return None
    try:
        from ..vendor.wanvideo_wrapper.fantasytalking import nodes as fantasytalking_nodes
    except Exception as error:
        raise RuntimeError(f"GJJ 内置 FantasyTalking runtime 加载失败：{error}") from error
    loader = fantasytalking_nodes.FantasyTalkingModelLoader()
    return _unwrap_loader_output(loader.loadmodel(model=name, base_precision=base_precision))


def _load_multitalk_model(model_name: str):
    name = _valid_selected_model_name(model_name)
    if not name:
        return None
    try:
        from ..vendor.wanvideo_wrapper.multitalk import nodes as multitalk_nodes
    except Exception as error:
        raise RuntimeError(f"GJJ 内置 MultiTalk runtime 加载失败：{error}") from error
    loader = multitalk_nodes.MultiTalkModelLoader()
    return _unwrap_loader_output(loader.loadmodel(model=name))


def _load_fantasyportrait_model(model_name: str, base_precision: str):
    name = _valid_selected_model_name(model_name)
    if not name:
        return None
    try:
        from ..vendor.wanvideo_wrapper.fantasyportrait import nodes as fantasyportrait_nodes
    except Exception as error:
        raise RuntimeError(f"GJJ 内置 FantasyPortrait runtime 加载失败：{error}") from error
    loader = fantasyportrait_nodes.FantasyPortraitModelLoader()
    return _unwrap_loader_output(loader.loadmodel(model=name, base_precision=base_precision))


class GJJ_ExtraModelChainConfig:
    CATEGORY = "GJJ"
    FUNCTION = "build_config"
    DESCRIPTION = (
        "GJJ 额外模型串联配置节点。用于把 VACE、FantasyTalking、MultiTalk/InfiniteTalk、"
        "FantasyPortrait 等 WanVideo 额外模型串成一个 EXTRA_MODEL_CHAIN 输入。"
    )
    SEARCH_ALIASES = [
        "额外模型串联配置",
        "EXTRA_MODEL_CHAIN",
        "VACE 串联",
        "FantasyTalking",
        "MultiTalk",
        "FantasyPortrait",
    ]
    RETURN_TYPES = (EXTRA_MODEL_CHAIN, "*", "*", "*", "*")
    RETURN_NAMES = ("额外模型串联配置", "启用模型1", "启用模型2", "启用模型3", "启用模型4")
    OUTPUT_TOOLTIPS = (
        "由前端动态界面维护的额外模型链，可接到 GJJ 视频通用模型加载的额外模型输入。",
        "按前端启用顺序输出的第 1 个额外模型；前端会显示真实 socket 类型。",
        "按前端启用顺序输出的第 2 个额外模型；前端会显示真实 socket 类型。",
        "按前端启用顺序输出的第 3 个额外模型；前端会显示真实 socket 类型。",
        "按前端启用顺序输出的第 4 个额外模型；前端会显示真实 socket 类型。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "extra_model_data": hidden_extra_model_data_input(),
            },
        }

    def build_config(self, extra_model_data="[]"):
        chain_data = normalize_extra_model_chain_data(extra_model_data)
        enabled_rows = parse_extra_model_chain_data(extra_model_data, enabled_only=True)
        by_kind = {str(item.get("kind", "vace") or "vace"): item for item in enabled_rows}
        dynamic_outputs: list[Any] = []

        for kind in ("vace", "fantasytalking", "multitalk", "fantasyportrait"):
            item = by_kind.get(kind)
            if not item:
                continue
            name = _valid_selected_model_name(item.get("name"))
            if not name:
                continue
            try:
                if kind == "vace":
                    dynamic_outputs.append(_make_vace_payload(name))
                elif kind == "fantasytalking":
                    dynamic_outputs.append(
                        _load_fantasytalking_model(
                            name,
                            str(item.get("base_precision", "fp16") or "fp16"),
                        )
                    )
                elif kind == "multitalk":
                    dynamic_outputs.append(_load_multitalk_model(name))
                elif kind == "fantasyportrait":
                    dynamic_outputs.append(
                        _load_fantasyportrait_model(
                            name,
                            str(item.get("base_precision", "fp16") or "fp16"),
                        )
                    )
            except Exception as error:
                raise RuntimeError(f"额外模型加载失败：{name}\n类型：{kind}\n错误信息：{error}") from error

        dynamic_outputs = [item for item in dynamic_outputs if item is not None]
        return tuple([chain_data, *dynamic_outputs, *([None] * (4 - len(dynamic_outputs)))][:5])


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_ExtraModelChainConfig,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "GJJ · 🧩 额外模型串联配置",
}
