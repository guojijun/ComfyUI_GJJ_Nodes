from __future__ import annotations

import folder_paths
import torch
import comfy.utils
from comfy import model_management

try:
    from spandrel import ImageModelDescriptor, ModelLoader, MAIN_REGISTRY
except Exception:  # pragma: no cover - 依赖由 ComfyUI 自带环境提供
    ImageModelDescriptor = None
    ModelLoader = None
    MAIN_REGISTRY = None

try:
    from spandrel_extra_arches import EXTRA_REGISTRY
except Exception:  # pragma: no cover - 可选增强依赖
    EXTRA_REGISTRY = None


NODE_NAME = "GJJ_ModelUpscaler"


if MAIN_REGISTRY is not None and EXTRA_REGISTRY is not None:
    try:
        MAIN_REGISTRY.add(*EXTRA_REGISTRY)
    except Exception:
        pass


def _dedupe_keep_order(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in values:
        value = str(item or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _list_upscale_models() -> list[str]:
    try:
        return _dedupe_keep_order(list(folder_paths.get_filename_list("upscale_models")))
    except Exception:
        return []


def _default_value(values: list[str]) -> str:
    return values[0] if values else ""


def _load_upscale_model(model_name: str):
    if ModelLoader is None or ImageModelDescriptor is None:
        raise RuntimeError("当前环境缺少放大模型加载依赖 spandrel，无法加载放大模型。")

    if not str(model_name or "").strip():
        raise RuntimeError("放大模型不能为空。")

    model_path = folder_paths.get_full_path_or_raise("upscale_models", model_name)
    state_dict = comfy.utils.load_torch_file(model_path, safe_load=True)
    if "module.layers.0.residual_group.blocks.0.norm1.weight" in state_dict:
        state_dict = comfy.utils.state_dict_prefix_replace(state_dict, {"module.": ""})

    model = ModelLoader().load_from_state_dict(state_dict).eval()
    if not isinstance(model, ImageModelDescriptor):
        raise RuntimeError("放大模型必须是单图像超分模型。")
    return model


class GJJ_ModelUpscaler:
    CATEGORY = "GJJ"
    FUNCTION = "upscale"
    DESCRIPTION = "使用 models/upscale_models 目录中的单图超分模型放大图像，可按开关选择直接透传原图。"

    SEARCH_ALIASES = ["放大", "模型放大", "upscale", "upscaler", "super resolution", "图像放大"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("模型放大结果",)
    OUTPUT_TOOLTIPS = ("启用时输出经放大模型处理后的图像；关闭时直接透传原图。",)

    @classmethod
    def INPUT_TYPES(cls):
        upscale_models = _list_upscale_models() or [""]
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "输入图像", "tooltip": "需要进行模型放大的图像。"}),
                "enabled": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "启用放大器",
                        "tooltip": "关闭时不加载放大模型，直接输出原图。",
                    },
                ),
                "upscale_model_name": (
                    upscale_models,
                    {
                        "default": _default_value(upscale_models),
                        "display_name": "放大模型",
                        "tooltip": "从 models/upscale_models 目录中选择一个放大模型。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(cls, image, enabled, upscale_model_name):
        return f"{bool(enabled)}|{str(upscale_model_name or '').strip()}|{tuple(image.shape)}"

    def upscale(self, image, enabled, upscale_model_name):
        if not bool(enabled):
            return (image,)

        upscale_model = _load_upscale_model(upscale_model_name)
        device = model_management.get_torch_device()

        memory_required = model_management.module_size(upscale_model.model)
        memory_required += (512 * 512 * 3) * image.element_size() * max(upscale_model.scale, 1.0) * 384.0
        memory_required += image.nelement() * image.element_size()
        model_management.free_memory(memory_required, device)

        upscale_model.to(device)
        input_image = image.movedim(-1, -3).to(device)

        tile = 512
        overlap = 32

        try:
            while True:
                try:
                    steps = input_image.shape[0] * comfy.utils.get_tiled_scale_steps(
                        input_image.shape[3],
                        input_image.shape[2],
                        tile_x=tile,
                        tile_y=tile,
                        overlap=overlap,
                    )
                    progress = comfy.utils.ProgressBar(steps)
                    scaled = comfy.utils.tiled_scale(
                        input_image,
                        lambda tensor: upscale_model(tensor),
                        tile_x=tile,
                        tile_y=tile,
                        overlap=overlap,
                        upscale_amount=upscale_model.scale,
                        pbar=progress,
                    )
                    break
                except Exception as exc:
                    model_management.raise_non_oom(exc)
                    tile //= 2
                    if tile < 128:
                        raise exc
        finally:
            upscale_model.to("cpu")

        output_image = torch.clamp(scaled.movedim(-3, -1), min=0.0, max=1.0)
        return (output_image,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ModelUpscaler}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔍 载入模型图片放大器"}
