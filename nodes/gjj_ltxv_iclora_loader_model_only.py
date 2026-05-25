from __future__ import annotations

import logging
from typing import Any

import comfy.sd
import comfy.utils
import folder_paths


NODE_NAME = "GJJ_LTXVICLoRALoaderModelOnly"
LOGGER = logging.getLogger(__name__)
PREFERRED_LORA = "LTX\\ltx-2.3-22b-ic-lora-union-control-ref0.5-多合一控制.safetensors"


def _lora_names() -> list[str]:
    try:
        names = list(folder_paths.get_filename_list("loras") or [])
    except Exception:
        names = []
    ic_lora_names = [name for name in names if "ic-lora" in str(name).lower()]
    return ic_lora_names or ["none"]


def _default_lora(names: list[str]) -> str:
    if PREFERRED_LORA in names:
        return PREFERRED_LORA

    preferred_basename = PREFERRED_LORA.rsplit("\\", 1)[-1].rsplit("/", 1)[-1]
    for name in names:
        if str(name).rsplit("\\", 1)[-1].rsplit("/", 1)[-1] == preferred_basename:
            return name

    keywords = ("ic-lora-union-control", "ic_lora_union_control", "ic-lora")
    lowered = [(name, str(name).lower()) for name in names]
    for keyword in keywords:
        for name, lower_name in lowered:
            if keyword in lower_name:
                return name

    return names[0]


def _load_lora_with_metadata(lora_path: str) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        loaded = comfy.utils.load_torch_file(lora_path, safe_load=True, return_metadata=True)
    except TypeError:
        lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
        return lora, {}

    if isinstance(loaded, tuple) and len(loaded) == 2:
        lora, metadata = loaded
        return lora, metadata or {}
    return loaded, {}


def _metadata_downscale_factor(metadata: dict[str, Any], lora_name: str) -> float:
    value = None
    for key in ("reference_downscale_factor", "latent_downscale_factor"):
        if isinstance(metadata, dict) and key in metadata:
            value = metadata.get(key)
            break

    try:
        factor = float(value)
    except (TypeError, ValueError):
        LOGGER.warning("IC-LoRA %s metadata missing reference_downscale_factor; using 1.0", lora_name)
        factor = 1.0

    if factor <= 0:
        LOGGER.warning("IC-LoRA %s metadata reference_downscale_factor is invalid: %r; using 1.0", lora_name, value)
        factor = 1.0
    return factor


class GJJ_LTXVICLoRALoaderModelOnly:
    @classmethod
    def INPUT_TYPES(cls):
        names = _lora_names()
        return {
            "required": {
                "model": (
                    "MODEL",
                    {
                        "display_name": "模型",
                        "tooltip": "输入 LTX/LTXV 模型；节点只把 IC-LoRA 应用到模型，不修改 CLIP。",
                    },
                ),
                "lora_name": (
                    names,
                    {
                        "default": _default_lora(names),
                        "display_name": "LoRA名称",
                        "tooltip": "从 ComfyUI 的 models/loras 列表选择文件名包含 ic-lora 的 IC-LoRA，支持子目录路径。",
                    },
                ),
                "strength_model": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": -100.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "模型强度",
                        "tooltip": "IC-LoRA 应用到模型的强度；0 时不加载 LoRA，但仍输出 metadata 中的 latent 缩放因子。",
                    },
                ),
            }
        }

    RETURN_TYPES = ("MODEL", "FLOAT")
    RETURN_NAMES = ("模型", "Latent缩放因子")
    OUTPUT_TOOLTIPS = (
        "应用 IC-LoRA 后的模型。",
        "从 safetensors metadata 的 reference_downscale_factor 读取；缺失时为 1.0。",
    )
    FUNCTION = "load_lora"
    CATEGORY = "GJJ/视频模型/LTXV"
    DESCRIPTION = "零依赖移植 LTXICLoRALoaderModelOnly：只给模型加载 IC-LoRA，并输出 latent_downscale_factor。"
    GJJ_HELP = {
        "title": "LTXV IC-LoRA 模型加载",
        "description": "从 ComfyUI-LTXVideo 的 IC-LoRA Loader Model Only 移植为 GJJ 单节点；不导入源插件，只依赖 ComfyUI 自带 LoRA 加载能力。",
        "usage": [
            "输入模型，选择 IC-LoRA，设置模型强度。",
            "下拉列表只显示路径或文件名包含 ic-lora 的 LoRA。",
            "输出模型接采样流程，Latent缩放因子接 IC-LoRA Guide 的 latent_downscale_factor。",
            "如果 LoRA metadata 没有 reference_downscale_factor，会自动使用 1.0。",
        ],
    }

    def load_lora(self, model, lora_name, strength_model):
        if not lora_name or str(lora_name) == "none":
            raise RuntimeError("IC-LoRA 模型加载失败：没有可用的 LoRA 文件。请把 IC-LoRA 放到 models/loras 下。")

        try:
            lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
        except Exception as exc:
            raise RuntimeError(f"IC-LoRA 模型加载失败：未找到 LoRA：{lora_name}") from exc

        try:
            lora, metadata = _load_lora_with_metadata(lora_path)
        except Exception as exc:
            raise RuntimeError(f"IC-LoRA 模型加载失败：无法读取 LoRA：{lora_name}") from exc

        latent_downscale_factor = _metadata_downscale_factor(metadata, str(lora_name))
        strength = float(strength_model)

        if strength == 0:
            return (model, latent_downscale_factor)

        try:
            model_lora, _ = comfy.sd.load_lora_for_models(model, None, lora, strength, 0)
        except Exception as exc:
            raise RuntimeError(f"IC-LoRA 模型加载失败：LoRA 与当前模型不匹配或无法应用：{lora_name}") from exc

        return (model_lora, latent_downscale_factor)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTXVICLoRALoaderModelOnly}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧬 LTXV IC-LoRA模型加载"}
