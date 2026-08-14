from __future__ import annotations

from typing import Any

import folder_paths
from aiohttp import web

try:
    from server import PromptServer
except Exception:
    PromptServer = None

# 复用 GJJ_VideoUniversalModelLoader 的核心加载与解析工具，避免重复实现。
try:
    from .gjj_video_universal_model_loader import (
        S,
        _apply_name_derived_settings,
        _apply_slot_widget_settings,
        _filename_list,
        _filename_list_for_folders,
        _is_lora_slot,
        _is_visible_output_slot,
        _normalize_search_keywords,
        _output_class_for_slot,
        _output_slots_for_config,
        _preferred_output_index,
        _resolve_selected,
        _slot_branch,
        _slot_payload,
        _slot_search_folders,
        DTYPES,
        KIND_OUTPUT_TYPE,
        ICON_BY_KIND,
        _load_clip,
        _load_diffusion_model,
        _load_dual_clip,
        _load_vae,
    )
except Exception as _imp_exc:  # pragma: no cover - 仅在异常时打印，便于排查
    import traceback as _tb
    print(f"[GJJ AudioUniversalModelLoader] 复用视频加载器失败：{_imp_exc}")
    _tb.print_exc()
    raise


NODE_NAME = "GJJ_AudioUniversalModelLoader"
NODE_DISPLAY_NAME = "GJJ·🎵 智能音频模型加载🎧官方流"
LIST_API = "/gjj/audio_universal_loader_lists"
MAX_SLOTS = 8  # 音频模型槽位数较少，预留 8 个足够


# 预设模型文件名种子，用于在 models 目录中默认匹配。
MINIMAX_MUSIC3_MODEL_NAMES = ["minimax_music3_dit_int8_convrot.safetensors"]
MINIMAX_MUSIC3_TEXT_ENCODER_NAMES = ["minimax_music3_text_encoder_pruned_int8_convrot.safetensors"]
MINIMAX_MUSIC3_VAE_NAMES = ["minimax_music3_dav.safetensors"]

ACESTEP_MODEL_NAMES = ["acestep_v1.5_xl_turbo_int8_convrot.safetensors"]
ACESTEP_TEXT_ENCODER_1_NAMES = ["qwen_4b_ace15.safetensors"]
ACESTEP_TEXT_ENCODER_2_NAMES = ["qwen_0.6b_ace15.safetensors"]
ACESTEP_VAE_NAMES = ["ace_1.5_vae.safetensors"]


# 音频模型预设配置。结构与 VIDEO_MODEL_CONFIGS 保持一致，前端复用同一渲染逻辑。
AUDIO_MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    "minimax_music3": {
        "label": "MiniMax Music3 音乐生成",
        "clip_type": "minimax",
        "slots": [
            S(
                "diffusion_model",
                "主模型(DiT)",
                "diffusion_models",
                "diffusion",
                ["minimax_music3"],
                preferred_name=MINIMAX_MUSIC3_MODEL_NAMES[0],
                official_names=MINIMAX_MUSIC3_MODEL_NAMES,
            ),
            S(
                "text_encoder",
                "文本编码器",
                "text_encoders",
                "clip",
                ["minimax_music3"],
                preferred_name=MINIMAX_MUSIC3_TEXT_ENCODER_NAMES[0],
                official_names=MINIMAX_MUSIC3_TEXT_ENCODER_NAMES,
                clip_type="minimax",
            ),
            S(
                "vae",
                "音频VAE",
                "vae",
                "vae",
                ["minimax_music3"],
                preferred_name=MINIMAX_MUSIC3_VAE_NAMES[0],
                official_names=MINIMAX_MUSIC3_VAE_NAMES,
            ),
        ],
    },
    "acestep_1.5": {
        "label": "ACE-Step v1.5 音乐生成",
        "clip_type": "acestep",
        "slots": [
            S(
                "diffusion_model",
                "主模型(DiT)",
                "diffusion_models",
                "diffusion",
                ["acestep_v1.5"],
                preferred_name=ACESTEP_MODEL_NAMES[0],
                official_names=ACESTEP_MODEL_NAMES,
            ),
            S(
                "text_encoder",
                "双CLIP编码器",
                "text_encoders",
                "clip",
                ["qwen_4b_ace15"],
                loader="dual_clip",
                preferred_name=ACESTEP_TEXT_ENCODER_1_NAMES[0],
                official_names=ACESTEP_TEXT_ENCODER_1_NAMES,
                secondary_label="编码器2",
                secondary_name="qwen_0.6b_ace15.safetensors",
                secondary_keywords=["qwen_0.6b_ace15"],
                secondary_official_names=ACESTEP_TEXT_ENCODER_2_NAMES,
                clip_type="acestep",
                device="default",
            ),
            S(
                "vae",
                "音频VAE",
                "vae",
                "vae",
                ["ace_1.5_vae"],
                preferred_name=ACESTEP_VAE_NAMES[0],
                official_names=ACESTEP_VAE_NAMES,
            ),
        ],
    },
}


# 前端需要扫描的模型文件夹清单，用于初始化可搜索下拉。
FOLDERS = sorted({
    str(slot.get("folder", "")).strip()
    for cfg in AUDIO_MODEL_CONFIGS.values()
    for slot in cfg.get("slots", [])
    if str(slot.get("folder", "")).strip()
})


def _config_payload() -> dict[str, Any]:
    """构造下发给前端的配置描述，结构与 VideoUniversalModelLoader 保持一致。"""
    return {
        key: {
            "label": cfg.get("label", key),
            "clip_type": cfg.get("clip_type", "auto"),
            "uses_lora": any(_is_lora_slot(slot) for slot in cfg.get("slots", [])),
            "uses_extra_model_chain": False,
            "output_slots": _output_slots_for_config(cfg),
            "slots": [_slot_payload(slot) for slot in cfg.get("slots", [])],
        }
        for key, cfg in AUDIO_MODEL_CONFIGS.items()
    }


async def get_gjj_audio_universal_loader_lists(request):
    refresh = str(request.query.get("refresh") or "").strip().lower() in {"1", "true", "yes"}
    return web.json_response(
        {
            "configs": _config_payload(),
            "folders": {folder: _filename_list(folder, refresh=refresh) for folder in FOLDERS},
            "dtypes": DTYPES,
            "clip_types": ["auto", "minimax", "acestep"],
        },
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    if not getattr(PromptServer.instance, "_gjj_audio_universal_loader_api_registered", False):
        PromptServer.instance.routes.get(LIST_API)(get_gjj_audio_universal_loader_lists)
        PromptServer.instance._gjj_audio_universal_loader_api_registered = True


class GJJ_AudioUniversalModelLoader:
    CATEGORY = "GJJ/🧠 模型/加载"
    FUNCTION = "load_models"
    DESCRIPTION = (
        "音频通用模型加载器：按官方音频工作流配置扫描 models 子目录，"
        "动态显示模型下拉与输出槽。当前支持 MiniMax Music3 与 ACE-Step v1.5。"
    )
    SEARCH_ALIASES = ["AMM", "音频加载", "audio loader", "minimax music", "acestep"]
    REQUIRED_MODELS = []
    GJJ_HELP = {
        "model_tree": True,
        "dynamic_model_tree_only": True,
        "notice": "模型树按当前选择的音频预设和面板下拉动态生成；若刚刷新页面还没读取到模型列表，请先点一次节点或刷新模型列表。",
        "dependencies": [
            "ComfyUI 对应预设所需的官方模型加载节点",
            "torch（ComfyUI 运行时基础依赖）",
        ],
    }

    # 后端保留 8 个 ANYTYPE 返回位以兼容旧工作流；前端按 output_slots 结构化增删真实可见输出口。
    RETURN_TYPES = ("*",) * MAX_SLOTS
    RETURN_NAMES = tuple(f"output{i}" for i in range(1, MAX_SLOTS + 1))

    @classmethod
    def INPUT_TYPES(cls):
        config_keys = list(AUDIO_MODEL_CONFIGS.keys())
        inputs: dict[str, Any] = {
            "config": (
                config_keys,
                {
                    "default": config_keys[0],
                    "display_name": "⚫ 配置",
                    "tooltip": "选择音频工作流对应的模型组合。前端会按配置动态显示相关模型下拉列表和输出接口。",
                },
            ),
        }
        for i in range(1, MAX_SLOTS + 1):
            # file_i 必须是 STRING，避免前端动态列表校验错位。
            inputs[f"file_{i}"] = (
                "STRING",
                {
                    "default": "",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": f"模型{i}",
                    "tooltip": "由前端根据配置动态填充；使用 STRING 避免动态列表校验错位。",
                },
            )
            inputs[f"secondary_file_{i}"] = (
                "STRING",
                {
                    "default": "",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": f"另一个模型{i}",
                    "tooltip": "预留双 CLIP 配置；当前音频预设暂未使用。",
                },
            )
            inputs[f"dtype_{i}"] = (
                DTYPES,
                {
                    "default": "default",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": f"⚙dtype{i}",
                    "tooltip": "加载 dtype；default 使用 ComfyUI 默认策略。",
                },
            )
            inputs[f"weight_dtype_{i}"] = (
                ["default", "bf16", "fp16", "fp32"],
                {
                    "default": "bf16",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": f"权重精度{i}",
                    "tooltip": "根据模型文件名中的 bf16/fp16/fp32 后缀自动同步。",
                },
            )
        inputs["clip_type_override"] = (
            ["auto", "minimax", "acestep"],
            {
                "default": "auto",
                "display": "hidden",
                "hidden": True,
                "display_name": "CLIP类型",
                "tooltip": "auto 使用配置内置类型；需要特殊兼容时可手动覆盖。",
            },
        )
        return {
            "required": inputs,
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        keys = ["config", "clip_type_override"]
        for i in range(1, MAX_SLOTS + 1):
            keys += [
                f"file_{i}",
                f"secondary_file_{i}",
                f"dtype_{i}",
                f"weight_dtype_{i}",
            ]
        return "|".join(str(kwargs.get(k, "")) for k in keys)

    def load_models(self, *args, **kwargs):
        # 只按名称读取，故意忽略位置参数，避免动态面板/输入口/输出口变化引起参数错位。
        unique_id = kwargs.get("unique_id", None)
        config_key = str(kwargs.get("config", "") or "")
        if config_key not in AUDIO_MODEL_CONFIGS:
            config_key = next(iter(AUDIO_MODEL_CONFIGS.keys()))
        cfg = AUDIO_MODEL_CONFIGS[config_key]

        clip_type_override = str(kwargs.get("clip_type_override", "auto") or "auto")
        clip_type = cfg.get("clip_type", "auto") if clip_type_override == "auto" else clip_type_override

        slots: list[dict[str, Any]] = []
        for index, slot in enumerate(cfg.get("slots", []), start=1):
            current_slot = dict(slot)
            current_slot = _apply_slot_widget_settings(current_slot, index, kwargs)
            current_slot["_source_index"] = index
            slots.append(current_slot)

        output_layout = _output_slots_for_config({"slots": slots})
        output_index_by_source = {
            int(slot["_source_index"]): int(slot["output_index"])
            for slot in output_layout
            if "_source_index" in slot and "output_index" in slot
        }

        values: list[Any] = [None] * MAX_SLOTS
        resolved_names: dict[str, str] = {}

        for index, slot in enumerate(slots, start=1):
            if index > MAX_SLOTS:
                break
            folder = str(slot.get("folder", "") or "")
            search_folders = _slot_search_folders(slot, folder)
            kind = str(slot.get("kind", "name") or "name")
            keywords = _normalize_search_keywords(list(slot.get("keywords", []) or []))
            selected = str(kwargs.get(f"file_{index}", "") or "")
            dtype = str(kwargs.get(f"dtype_{index}", "default") or "default")
            file_extension = ""

            if kind == "empty":
                continue

            name = _resolve_selected(
                selected,
                search_folders,
                keywords,
                allow_any=False,
                strict=bool(slot.get("strict", False)),
                preferred=str(slot.get("preferred_name", "") or slot.get("required_name", "") or ""),
                official_names=list(slot.get("official_names", []) or []),
                file_extension=file_extension,
            )

            if not name:
                raise RuntimeError(
                    f"[{cfg.get('label', config_key)}] {slot.get('label', slot.get('id', f'slot_{index}'))} "
                    f"未找到匹配的本地模型文件。\n"
                    f"关键词：{', '.join(keywords) or '（无）'}\n"
                    f"需要文件：{slot.get('preferred_name', '') or slot.get('official_names', ['（未指定）'])[0]}"
                )

            slot_id = str(slot.get("id", f"slot_{index}"))
            resolved_names[slot_id] = name
            slot, dtype = _apply_name_derived_settings(slot, kind, name, dtype)

            output_index = output_index_by_source.get(index)
            is_visible_output = output_index is not None and 0 <= output_index < MAX_SLOTS

            try:
                if kind == "diffusion":
                    value = _load_diffusion_model(name, dtype, unique_id=unique_id)
                elif kind == "vae":
                    value = _load_vae(name)
                elif kind == "clip":
                    loader_kind = str(slot.get("loader", "") or "").lower()
                    if loader_kind == "dual_clip":
                        secondary_name = str(kwargs.get(f"secondary_file_{index}", "") or "").strip()
                        secondary_name = _resolve_selected(
                            secondary_name,
                            search_folders,
                            _normalize_search_keywords(
                                [slot.get("secondary_name", "")] + list(slot.get("secondary_keywords", []) or [])
                            ),
                            preferred=str(slot.get("secondary_name", "") or ""),
                            official_names=list(slot.get("secondary_official_names", []) or []),
                        )
                        if not secondary_name:
                            raise RuntimeError(
                                f"[{cfg.get('label', config_key)}] 双CLIP配置缺少另一个模型。"
                            )
                        value = _load_dual_clip(
                            name,
                            secondary_name,
                            str(slot.get("clip_type", clip_type) or clip_type),
                            str(slot.get("device", "default") or "default"),
                            unique_id=unique_id,
                        )
                    else:
                        value = _load_clip(name, clip_type, dtype)
                else:
                    value = name
            except Exception as exc:
                existing_text = str(exc or "")
                if existing_text.startswith(f"[{cfg.get('label', config_key)}]") and "需要文件：" in existing_text:
                    raise
                raise RuntimeError(
                    f"[{cfg.get('label', config_key)}] "
                    f"{slot.get('label', slot.get('id', f'slot_{index}'))} 加载失败：{exc}"
                ) from exc

            if is_visible_output:
                values[output_index] = value

        if len(values) < MAX_SLOTS:
            values.extend([None] * (MAX_SLOTS - len(values)))
        return tuple(values[:MAX_SLOTS])


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_AudioUniversalModelLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
