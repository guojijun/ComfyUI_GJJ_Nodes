from __future__ import annotations

import folder_paths
import torch
import comfy.utils
from comfy import model_management

from .common_utils.dependency_checker import (
    DEFAULT_MODEL_URL,
    build_dependency_model_report,
    build_node_help_payload,
    make_missing_model_spec,
    print_dependency_model_report,
    raise_dependency_model_error,
)

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
NODE_DISPLAY_NAME = "GJJ · 🔍 载入模型图片放大器"
NODE_DESCRIPTION = (
    "使用 models/upscale_models 目录中的 .pth 单图超分模型放大图像，"
    "可按开关选择直接透传原图。"
)
MODEL_DOWNLOAD_URL = DEFAULT_MODEL_URL
UPSCALE_MODEL_SUBDIR = "models/upscale_models"
UPSCALE_MODEL_PATTERN = "*.pth"


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


def _list_pth_upscale_models() -> list[str]:
    return [
        model_name
        for model_name in _list_upscale_models()
        if str(model_name).lower().endswith(".pth")
    ]


def _default_value(values: list[str]) -> str:
    return values[0] if values else ""


def _upscale_model_spec(filename: str = UPSCALE_MODEL_PATTERN) -> dict[str, str]:
    return make_missing_model_spec(
        label="单图超分模型",
        subdir=UPSCALE_MODEL_SUBDIR,
        filename=filename or UPSCALE_MODEL_PATTERN,
        description="支持子目录；本节点声明并使用 .pth 格式的 Spandrel 单图超分模型。",
    )


_MISSING_DEPENDENCIES = [] if ModelLoader is not None and ImageModelDescriptor is not None else [
    {
        "module_name": "spandrel",
        "package_name": "spandrel",
        "display_name": "Spandrel",
        "description": "用于识别和加载 .pth 单图超分模型。",
    }
]
_MISSING_MODELS = [] if _list_pth_upscale_models() else [_upscale_model_spec()]
_ENVIRONMENT_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_MISSING_DEPENDENCIES,
    missing_models=_MISSING_MODELS,
    description=NODE_DESCRIPTION,
    model_download_url=MODEL_DOWNLOAD_URL,
)
_DEPENDENCIES_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("dependencies_available", True))
_MODELS_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("models_available", True))

if not (_DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE):
    print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ 模型图片放大器缺少运行环境")


def _raise_upscale_environment_error(
    model_name: str = "",
    unique_id=None,
    original_error: str = "",
    require_pth: bool = True,
) -> None:
    missing_dependencies = _MISSING_DEPENDENCIES if ModelLoader is None or ImageModelDescriptor is None else []
    missing_models = []
    requested = str(model_name or "").strip()
    available = _list_pth_upscale_models() if require_pth else _list_upscale_models()
    if not requested or requested not in available:
        missing_models = [
            _upscale_model_spec(requested or UPSCALE_MODEL_PATTERN)
            if require_pth
            else make_missing_model_spec(
                label="单图超分模型",
                subdir=UPSCALE_MODEL_SUBDIR,
                filename=requested or "请选择放大模型",
                description="通过 ComfyUI upscale_models 类别查找模型。",
            )
        ]

    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=missing_dependencies,
        missing_models=missing_models,
        description=(
            "请把 .pth 单图超分模型放入 models/upscale_models，"
            "刷新模型列表或重启 ComfyUI 后重新选择。"
        ),
        original_error=original_error,
        unique_id=unique_id,
        title="GJJ 模型图片放大器缺少模型或运行依赖",
        model_download_url=MODEL_DOWNLOAD_URL,
    )


def _load_upscale_model(model_name: str, unique_id=None, require_pth: bool = False):
    if ModelLoader is None or ImageModelDescriptor is None:
        _raise_upscale_environment_error(model_name, unique_id=unique_id, require_pth=require_pth)

    if not str(model_name or "").strip():
        _raise_upscale_environment_error(unique_id=unique_id, require_pth=require_pth)

    if require_pth and not str(model_name).lower().endswith(".pth"):
        _raise_upscale_environment_error(
            model_name,
            unique_id=unique_id,
            original_error="本节点只声明并使用 models/upscale_models 下的 .pth 文件。",
            require_pth=True,
        )

    try:
        model_path = folder_paths.get_full_path_or_raise("upscale_models", model_name)
    except Exception as exc:
        _raise_upscale_environment_error(
            model_name,
            unique_id=unique_id,
            original_error=str(exc),
            require_pth=require_pth,
        )
    state_dict = comfy.utils.load_torch_file(model_path, safe_load=True)
    if "module.layers.0.residual_group.blocks.0.norm1.weight" in state_dict:
        state_dict = comfy.utils.state_dict_prefix_replace(state_dict, {"module.": ""})

    model = ModelLoader().load_from_state_dict(state_dict).eval()
    if not isinstance(model, ImageModelDescriptor):
        raise RuntimeError("放大模型必须是单图像超分模型。")
    return model


class GJJ_ModelUpscaler:
    CATEGORY = "GJJ/图像/超分放大"
    FUNCTION = "upscale"
    DESCRIPTION = (
        NODE_DESCRIPTION
        if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
        else _ENVIRONMENT_REPORT.get("warning_message", NODE_DESCRIPTION)
    )

    SEARCH_ALIASES = ["放大", "模型放大", "upscale", "upscaler", "super resolution", "图像放大"]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("模型放大结果",)
    OUTPUT_TOOLTIPS = ("启用时输出经放大模型处理后的图像；关闭时直接透传原图。",)
    GJJ_HELP = build_node_help_payload(
        description=NODE_DESCRIPTION,
        dependencies=[
            {
                "name": "Spandrel",
                "type": "ComfyUI 内置运行时",
                "required": True,
                "description": "负责识别和加载 .pth 单图超分模型。",
            }
        ],
        model_tree=[
            {
                "label": UPSCALE_MODEL_PATTERN,
                "path": UPSCALE_MODEL_SUBDIR,
                "required": True,
                "description": "支持 models/upscale_models 的子目录相对路径。",
            }
        ],
        models=[_upscale_model_spec()],
        usage=[
            "把 .pth 放大模型放入 models/upscale_models，刷新模型列表或重启 ComfyUI。",
            "下拉框只显示 .pth 文件；启用放大器后按模型倍率执行分块超分。",
            "关闭启用放大器时不会加载模型，直接透传输入图像。",
        ],
        runtime=[
            "模型通过 ComfyUI folder_paths 的 upscale_models 类别查找。",
            "加载后使用 ComfyUI tiled_scale 分块处理，显存不足时自动缩小分块尺寸。",
        ],
        model_download_url=MODEL_DOWNLOAD_URL,
        copy_text=MODEL_DOWNLOAD_URL,
        copy_label="🌏 复制模型下载地址",
        notice=_ENVIRONMENT_REPORT.get("warning_message", ""),
        extra={
            "missing_models": _MISSING_MODELS,
            "notice_level": _ENVIRONMENT_REPORT.get("notice_level", "ok"),
            "static_model_tree_only": True,
            "model_tree_priority": "static",
        },
    )

    @classmethod
    def INPUT_TYPES(cls):
        upscale_models = _list_pth_upscale_models() or [""]
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
                        "tooltip": "从 models/upscale_models 目录及其子目录中选择一个 .pth 放大模型。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, image, enabled, upscale_model_name):
        return f"{bool(enabled)}|{str(upscale_model_name or '').strip()}|{tuple(image.shape)}"

    def upscale(self, image, enabled, upscale_model_name, unique_id=None):
        if not bool(enabled):
            return (image,)

        upscale_model = _load_upscale_model(upscale_model_name, unique_id=unique_id, require_pth=True)
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
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
