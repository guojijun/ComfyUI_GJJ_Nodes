# -*- coding: utf-8 -*-
"""GJJ_QwenMultiangleStudio —— Pixal3D_Trellis2_图生3D 工作流零依赖单节点。

将原工作流（LoadImage → FluxKontextImageScale → 相机角度提示词 →
双路 QwenImageEdit 编码 → FluxKontext 参考潜空间 → KSampler → VAEDecode）
封装为一个节点：内部自行完成模型族加载（含 ConvRot int4）、LoRA 应用、
采样参数修补（ModelSamplingAuraFlow + CFGNorm）、条件编码与采样，不依赖
任何外部自定义节点。

设计约束（与用户约定一致）：
1. 所有模型树由前端 GJJ_Utils.createModelTreeView 实现，列表顶部过滤框
   自动从当前模型名去掉路径/扩展名/版本号/量化标记后取组名填充；源模型
   缺失时从过滤列表自动取值，过滤结果为空时回退默认模型并标红。
2. 预览图片可拖拽到空白画布或 GJJ_AnyPreview（前端 bindGjjMediaDrag）。
3. 所有临时文件统一走 common_utils/temp_files.py（内容寻址，避免重复文件）。
4. 隐藏参数一律 hidden: True / display: "hidden"，不使用 forceInput: True；
   需要外接时由前端创建 socket 并绑定 input.widget = {name}，移除时用
   disconnectInput + removeInput 结构性删除槽位。
"""

from __future__ import annotations

import os
import traceback
from typing import Any

import torch

import folder_paths

from .common_utils.model_manager import gjjutils_resolve_model_by_extensionless_seed
from .common_utils.progress import send_node_progress
from .common_utils.temp_files import gjjutils_write_temp_tensor_images
from .gjj_qwen_multiangle_camera import (
    _distance_label_en,
    _horizontal_direction_en,
    _vertical_direction_en,
)

# =========================================================================== #
# 常量
# =========================================================================== #

NODE_NAME = "GJJ_QwenMultiangleStudio"
NODE_DISPLAY_NAME = "🖼️ 使用3D相机节点生成多个角度"

MISSING_MODEL = "[未找到模型]"

# 与工作流一致的默认模型（工作流: qwen_image_edit_2511_int4_convrot /
# qwen_2.5_vl_7b_int4_convrot / qwen_image_vae / Lightning-4steps / multiple-angles）
UNET_SEEDS = (
    "qwen_image_edit_2511_int4_convrot.safetensors",
    "qwen_image_edit_2511_fp8mixed.safetensors",
    "qwen_image_edit_2511_nvfp4.safetensors",
)
CLIP_SEEDS = (
    "qwen_2.5_vl_7b_int4_convrot.safetensors",
    "qwen_2.5_vl_7b_fp8_scaled.safetensors",
)
VAE_SEEDS = ("qwen_image_vae.safetensors",)
LIGHTNING_LORA_SEEDS = ("QWEN\\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",)
ANGLE_LORA_SEEDS = ("QWEN\\2511\\qwen-image-edit-2511-multiple-angles-lora.safetensors",)

DEFAULT_CLIP_TYPE = "qwen_image"
DEFAULT_HORIZONTAL_ANGLE = 42
DEFAULT_VERTICAL_ANGLE = 19
DEFAULT_ZOOM = 10.0
DEFAULT_SEED = 1087380645819077
DEFAULT_STEPS = 4
DEFAULT_CFG = 1.0
FULL_STEPS = 40
FULL_CFG = 4.0
DEFAULT_SHIFT = 3.1
DEFAULT_CFGNORM_STRENGTH = 1.0
DEFAULT_DENOISE = 1.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "simple"
DEFAULT_REFERENCE_METHOD = "index_timestep_zero"

# ComfyUI 核心 FluxKontextMultiReferenceLatentMethod 的可选方法
REFERENCE_LATENTS_METHODS = ("offset", "index", "uxo/uno", "index_timestep_zero")

# FluxKontextImageScale（LayerUtility）偏好分辨率：2:1 ~ 1:2 共 17 档，
# 按输入长宽比最近匹配（与原工作流 245 号节点逐项等价）
PREFERRED_KONTEXT_RESOLUTIONS = [
    (672, 1568),
    (688, 1504),
    (720, 1456),
    (752, 1392),
    (800, 1328),
    (832, 1248),
    (880, 1184),
    (944, 1104),
    (1024, 1024),
    (1104, 944),
    (1184, 880),
    (1248, 832),
    (1328, 800),
    (1392, 752),
    (1456, 720),
    (1504, 688),
    (1568, 672),
]

# Qwen Image Edit 文本编码（复制自 ComfyUI 核心 comfy_extras.nodes_qwen，逐项等价）
QWEN_IMAGE_EDIT_IMAGE_TOKEN = "<|vision_start|><|image_pad|><|vision_end|>"
QWEN_IMAGE_EDIT_LLAMA_TEMPLATE = (
    "<|im_start|>system\n"
    "Describe the key features of the input image (color, shape, size, texture, objects, background), "
    "then explain how the user's text instruction should alter or modify the image. "
    "Generate a new image that meets the user's requirements while maintaining consistency "
    "with the original input where appropriate.<|im_end|>\n"
    "<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"
)

MODEL_DOWNLOAD_URL = "https://huggingface.co/comfyanonymous/qwen_image_edit_2511_int4_convrot/tree/main"

# =========================================================================== #
# 通用工具
# =========================================================================== #


def _hidden_option(options: dict[str, Any] | None = None) -> dict[str, Any]:
    """隐藏参数规范：hidden: True + display: "hidden"，禁用 forceInput。

    注意：不要用 forceInput: True 模拟外接输入；外接由前端创建 socket 后
    绑定 input.widget = { name } 完成。
    """
    data = dict(options or {})
    data["hidden"] = True
    data["display"] = "hidden"
    data.pop("forceInput", None)
    data["forceInput"] = False
    return data


def _sampler_choices() -> list[str]:
    try:
        import comfy.samplers

        return list(comfy.samplers.KSampler.SAMPLERS)
    except Exception:
        return ["euler", "euler_ancestral", "dpmpp_2m", "ddim"]


def _scheduler_choices() -> list[str]:
    try:
        import comfy.samplers

        return list(comfy.samplers.KSampler.SCHEDULERS)
    except Exception:
        return ["normal", "simple", "karras", "beta", "sd_3"]


def _list_model_files(folder_type: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(folder_type))
    except Exception:
        return []


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


def _clip_model_list() -> list[str]:
    """合并 text_encoders 与 clip 目录的候选（CLIP 模型可能放在任意一处）。"""
    values = _dedupe_keep_order(_list_model_files("text_encoders") + _list_model_files("clip"))
    return values


def _pick_default_model(folder_type: str, seeds: tuple[str, ...]) -> str:
    files = _list_model_files(folder_type)
    if not files:
        return MISSING_MODEL
    for seed in seeds:
        hit = gjjutils_resolve_model_by_extensionless_seed(seed, folder_type)
        if hit and hit in files:
            return hit
    return files[0]


def _pick_default_from_list(files: list[str], seeds: tuple[str, ...]) -> str:
    candidates = [str(name or "").strip() for name in (files or []) if str(name or "").strip()]
    if not candidates:
        return MISSING_MODEL
    for seed in seeds:
        seed_text = str(seed or "").strip()
        if not seed_text:
            continue
        if seed_text in candidates:
            return seed_text
        seed_base = seed_text.replace("\\", "/").rsplit("/", 1)[-1].lower()
        for candidate in candidates:
            if candidate.replace("\\", "/").rsplit("/", 1)[-1].lower() == seed_base:
                return candidate
    return candidates[0]


def _model_combo(folder_type: str, seeds: tuple[str, ...]) -> tuple[list[str], str]:
    files = _list_model_files(folder_type)
    if not files:
        return [MISSING_MODEL], MISSING_MODEL
    return files, _pick_default_model(folder_type, seeds)


def _coerce_image_tensor(media: Any) -> torch.Tensor:
    """把输入媒体转成 BHWC 的 float32 图像张量，只取第一帧。"""
    if isinstance(media, torch.Tensor):
        image = media
    elif isinstance(media, dict):
        image = None
        for key in ("images", "image", "frames"):
            value = media.get(key)
            if isinstance(value, torch.Tensor):
                image = value
                break
        if image is None:
            raise RuntimeError("输入图像数据中未找到可用的图像张量。")
    else:
        raise RuntimeError("输入图像必须是 IMAGE 类型。")

    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise RuntimeError(f"输入图像维度异常：{tuple(image.shape)}，期望 BHWC。")
    image = image[0:1]
    if image.shape[-1] == 4:
        image = image[..., :3]
    if image.shape[-1] != 3:
        raise RuntimeError(f"输入图像通道数异常：{image.shape[-1]}，期望 3。")
    if not torch.is_floating_point(image):
        image = image.to(torch.float32) / 255.0
    else:
        image = image.to(torch.float32)
    return image


def _load_reference_image_tensor(reference_info: str) -> torch.Tensor | None:
    """按 📂 上传的参考图信息从 input 目录读取图像；失败返回 None。

    路径解析与 GJJ_3D 节点一致：文件名含子目录前缀时直接交给
    LoadImage().load_image(rel_path)（LoadImage 内部按 "/" 拆分 subfolder），
    兼容新版 ComfyUI（get_annotated_filepath 已无 subfolder 参数）。
    """
    import json

    try:
        info = json.loads(str(reference_info or "") or "{}") or {}
    except Exception:
        return None
    filename = str(info.get("filename") or "").strip()
    if not filename:
        return None
    try:
        subfolder = str(info.get("subfolder") or "").strip().strip("/")
        image_type = str(info.get("type") or "input").strip()
        rel_path = f"{subfolder}/{filename}" if subfolder else filename
        annotated = (
            f"{rel_path} [{image_type}]"
            if image_type and image_type != "input"
            else rel_path
        )
        from nodes import LoadImage

        loaded = LoadImage().load_image(annotated)
        image = loaded[0] if isinstance(loaded, (tuple, list)) else loaded
        return _coerce_image_tensor(image)
    except Exception:
        return None


def _flux_kontext_image_scale(image: torch.Tensor) -> torch.Tensor:
    """FluxKontextImageScale 核心逻辑（零依赖内联，等价 LayerUtility 原节点）。

    与原工作流 245 号节点一致：按输入长宽比从 17 档偏好分辨率中选最近档，
    再以 LANCZOS 直接拉伸（fit='fill' 分支语义），保持全部信息。
    """
    import numpy as np
    from PIL import Image

    width = image.shape[2]
    height = image.shape[1]
    aspect_ratio = width / height
    _, target_width, target_height = min(
        (abs(aspect_ratio - w / h), w, h)
        for w, h in PREFERRED_KONTEXT_RESOLUTIONS
    )

    ret_images = []
    for img in image:
        pil_img = Image.fromarray(
            np.clip(255.0 * img.cpu().numpy().squeeze(), 0, 255).astype(np.uint8)
        ).convert("RGB")
        pil_img = pil_img.resize((target_width, target_height), Image.LANCZOS)
        ret_images.append(
            torch.from_numpy(np.array(pil_img).astype(np.float32) / 255.0).unsqueeze(0)
        )
    return torch.cat(ret_images, dim=0)


def _flux_kontext_reference_latents_method(
    conditioning: list[Any], method: str
) -> list[Any]:
    """FluxKontextMultiReferenceLatentMethod 核心逻辑（零依赖内联，等价 ComfyUI core）。"""
    import node_helpers

    if "uxo" in str(method) or "uso" in str(method):
        method = "uxo"
    return node_helpers.conditioning_set_values(
        conditioning, {"reference_latents_method": method}
    )


def _text_encode_qwen_image_edit_plus(
    clip: Any,
    vae: Any,
    prompt: str,
    image1: torch.Tensor | None = None,
    image2: torch.Tensor | None = None,
    image3: torch.Tensor | None = None,
    use_ref_latents: bool = True,
) -> list[Any]:
    """TextEncodeQwenImageEditPlus 核心逻辑（零依赖内联，与 ComfyUI core 逐行等价）。

    与原工作流 227/229 号节点一致：
    - VL 视觉 token 图按 384×384 像素量缩放（area）；
    - reference_latents 图按 1024×1024 像素量缩放并按 8 对齐（area）后 vae.encode；
    - image_prompt 使用 Picture N + <|vision_start|><|image_pad|><|vision_end|> 占位；
    - llama_template 使用完整 system prompt。
    use_ref_latents=False 时仍保留 VL 图像 token（图编辑模型必需），仅跳过参考潜空间。
    """
    import math

    import node_helpers
    from comfy.utils import common_upscale

    ref_latents: list[torch.Tensor] = []
    images_vl: list[torch.Tensor] = []
    image_prompt = ""

    for i, reference_image in enumerate((image1, image2, image3)):
        if reference_image is None:
            continue
        samples = reference_image.movedim(-1, 1)
        total = int(384 * 384)
        scale_by = math.sqrt(total / (samples.shape[3] * samples.shape[2]))
        width = round(samples.shape[3] * scale_by)
        height = round(samples.shape[2] * scale_by)
        s = common_upscale(samples, width, height, "area", "disabled")
        images_vl.append(s.movedim(1, -1))
        if vae is not None and use_ref_latents:
            total = int(1024 * 1024)
            scale_by = math.sqrt(total / (samples.shape[3] * samples.shape[2]))
            width = round(samples.shape[3] * scale_by / 8.0) * 8
            height = round(samples.shape[2] * scale_by / 8.0) * 8
            s = common_upscale(samples, width, height, "area", "disabled")
            ref_latents.append(vae.encode(s.movedim(1, -1)[:, :, :, :3]))
        image_prompt += "Picture {}: {}".format(i + 1, QWEN_IMAGE_EDIT_IMAGE_TOKEN)

    tokens = clip.tokenize(
        image_prompt + str(prompt or ""),
        images=images_vl,
        llama_template=QWEN_IMAGE_EDIT_LLAMA_TEMPLATE,
    )
    conditioning = clip.encode_from_tokens_scheduled(tokens)
    if ref_latents:
        conditioning = node_helpers.conditioning_set_values(
            conditioning, {"reference_latents": ref_latents}, append=True
        )
    return conditioning


def _camera_prompt(horizontal_angle: int, vertical_angle: int, zoom: float) -> str:
    """与工作流 CameraAngle 节点一致的英文多角度提示词。"""
    h_dir = _horizontal_direction_en(int(horizontal_angle))
    v_dir = _vertical_direction_en(int(vertical_angle))
    d_label = _distance_label_en(float(zoom))
    return f"<sks> {h_dir} {v_dir} {d_label}"


def _load_diffusion_model_internal(unet_name: str, unet_dtype: str = "default"):
    """零依赖加载扩散模型：ConvRot int4/int8 走专用路径，其余走通用路径。"""
    from .common_utils.model_loader import gjjutils_load_model
    from .gjj_model_bundle_loader import (
        _is_convrot_quantized_model_name,
        _load_convrot_quantized_unet,
    )

    if _is_convrot_quantized_model_name(unet_name):
        return _load_convrot_quantized_unet(unet_name, unet_dtype)
    return gjjutils_load_model(unet_name, unet_dtype)


def _load_clip_internal(clip_name: str, clip_type: str):
    from .common_utils.model_loader import gjjutils_load_clip_from_names

    return gjjutils_load_clip_from_names([clip_name], clip_type)


def _load_vae_internal(vae_name: str):
    from .common_utils.model_loader import gjjutils_load_vae

    return gjjutils_load_vae(vae_name)


# =========================================================================== #
# 节点
# =========================================================================== #


class GJJ_QwenMultiangleStudio:
    CATEGORY = "GJJ/🧊 三维工具"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    OUTPUT_IS_LIST = (False,)

    DESCRIPTION = (
        "Pixal3D/Trellis2 图生3D 的多角度预处理单节点：输入一张图，自动加载 "
        "Qwen Image Edit 2511 模型族（Unet + CLIP + VAE + Lightning/多角度 LoRA），"
        "按相机角度生成多角度图像，输出可直接连入 GJJ_AnyPreview 或 3D 重建节点。"
        "零依赖：不需要工作流中的任何其它节点。"
    )

    SEARCH_ALIASES = [
        "GJJ_QwenMultiangleStudio",
        "GJJ Qwen Multiangle Studio",
        "GJJ 多角度图生3D",
        "GJJ 多角度出图",
        "GJJ Pixal3D Trellis2",
        "GJJ qwen image edit 2511",
        "GJJ 相机角度出图",
        "GJJ multiangle 3D prep",
    ]

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("🖼️ 多角度图像",)
    OUTPUT_TOOLTIPS = (
        "生成的多角度图像（BHWC），可直接连入 GJJ_AnyPreview 预览或 Pixal3D/Trellis2 3D 重建节点。",
    )

    REQUIRED_MODELS = (
        (
            "diffusion_model",
            "diffusion_models",
            UNET_SEEDS,
            "Qwen Image Edit 2511 主模型（Unet）",
            "🧠",
        ),
        (
            "clip_model",
            "clip",
            CLIP_SEEDS,
            "Qwen 2.5 VL 文本编码器（CLIP）",
            "🧠",
        ),
        ("vae_model", "vae", VAE_SEEDS, "Qwen Image VAE", "🧠"),
        (
            "lightning_lora",
            "loras",
            LIGHTNING_LORA_SEEDS,
            "Qwen 2511 Lightning 4 步加速 LoRA",
            "🧠",
        ),
        (
            "angle_lora",
            "loras",
            ANGLE_LORA_SEEDS,
            "Qwen 2511 多角度 LoRA",
            "🧠",
        ),
    )

    GJJ_HELP = {
        "title": "🖼️ 使用3D相机节点生成多个角度",
        "description": (
            "把 Pixal3D_Trellis2_图生3D 工作流封装为单节点：输入一张图，"
            "自动完成模型族加载、相机角度提示词、参考潜空间编码与采样，"
            "输出多角度图像供 3D 重建使用。"
        ),
        "notice": "零依赖单节点：不需要 GJJ_ModelBundleLoader、CameraAngle、KSampler 等任何其它节点，模型在节点内部直接加载。",
        "usage": [
            "把待生成图片拖入节点上方的 image 输入槽（或从工作流其它节点连入）。",
            "点击 🧠 打开模型树：顶部过滤框自动填入当前模型的组名，可直接输入过滤；",
            "模型缺失时自动从过滤列表取值；过滤结果为空时回退默认模型并标红。",
            "点击 📷 调整相机角度、采样参数与提示词；部分参数支持 🔗 外接（创建原生 socket）。",
            "▶️ 只运行当前节点；生成的多角度图像可拖拽到空白画布或 GJJ_AnyPreview。",
        ],
        "parameters": [
            "主模型（Unet）：Qwen Image Edit 2511 系列，默认 int4_convrot。",
            "文本编码器（CLIP）：Qwen 2.5 VL 系列，默认 int4_convrot，clip_type=qwen_image。",
            "图像 VAE：qwen_image_vae。",
            "Lightning 4 步加速 LoRA + 多角度 LoRA：模型仅 LoRA（LoraLoaderModelOnly）。",
            "水平角度/垂直角度/距离：相机角度，自动生成 <sks> 前缀英文提示词。",
            "启用 4 步加速：开启时应用 Lightning LoRA 且 steps=4、cfg=1.0；关闭时 steps=40、cfg=4.0（与模板一致）。",
            "shift：ModelSamplingAuraFlow 采样偏移（默认 3.1）；cfgnorm_strength：CFGNorm 后置 CFG 衰减强度。",
            "reference_latents_method：参考潜空间方法（默认 index_timestep_zero）。",
        ],
        "notes": [
            "所有隐藏参数均以 hidden/display=hidden 声明；需要外接时前端创建 socket 并绑定 input.widget，"
            "不使用 forceInput，不使用 DOM 假控件模拟。",
            "临时预览文件统一写入 common_utils/temp_files.py（内容寻址，同一图像只落盘一次）。",
            "模型族可用 GJJ_ModelBundleLoader 的 preset 保持一致；也可直接连入 model/clip/vae 覆盖输入。",
        ],
        "dependencies": ["无外部自定义节点依赖，无新增 Python 依赖（仅 ComfyUI 核心 + GJJ 包内工具）。"],
    }

    @classmethod
    def INPUT_TYPES(cls):
        diffusion_combo, diffusion_default = _model_combo("diffusion_models", UNET_SEEDS)
        clip_list = _clip_model_list()
        clip_default = _pick_default_from_list(clip_list, CLIP_SEEDS)
        vae_combo, vae_default = _model_combo("vae", VAE_SEEDS)
        lora_list = _list_model_files("loras") or [MISSING_MODEL]
        lightning_default = _pick_default_from_list(lora_list, LIGHTNING_LORA_SEEDS)
        angle_default = _pick_default_from_list(lora_list, ANGLE_LORA_SEEDS)

        return {
            "required": {
                # ---- 模型树（前端 GJJ_Utils.createModelTreeView）----
                "diffusion_model": (
                    diffusion_combo,
                    _hidden_option(
                        {
                            "default": diffusion_default,
                            "display_name": "主模型（Unet）",
                            "tooltip": "Qwen Image Edit 2511 主模型。支持子目录路径；int4/int8 ConvRot 自动走专用加载。",
                        }
                    ),
                ),
                "clip_model": (
                    clip_list,
                    _hidden_option(
                        {
                            "default": clip_default,
                            "display_name": "文本编码器（CLIP）",
                            "tooltip": "Qwen 2.5 VL 文本编码器，clip_type 固定为 qwen_image。",
                        }
                    ),
                ),
                "vae_model": (
                    vae_combo,
                    _hidden_option(
                        {
                            "default": vae_default,
                            "display_name": "图像 VAE",
                            "tooltip": "Qwen Image VAE。",
                        }
                    ),
                ),
                "lightning_lora": (
                    lora_list,
                    _hidden_option(
                        {
                            "default": lightning_default,
                            "display_name": "Lightning 4 步加速 LoRA",
                            "tooltip": "启用 4 步加速时应用的 LoRA（模型仅 LoRA，强度固定 1.0）。",
                        }
                    ),
                ),
                "angle_lora": (
                    lora_list,
                    _hidden_option(
                        {
                            "default": angle_default,
                            "display_name": "多角度 LoRA",
                            "tooltip": "多角度生成 LoRA（模型仅 LoRA，强度固定 1.0）。",
                        }
                    ),
                ),
                # ---- 相机角度（CameraAngle 同款可见数值输入框，与视球/下拉联动）----
                "horizontal_angle": (
                    "INT",
                    {
                        "default": DEFAULT_HORIZONTAL_ANGLE,
                        "min": 0,
                        "max": 360,
                        "step": 1,
                        "display_name": "水平角度",
                        "tooltip": "相机水平方位角（0-360°），0°=正面，90°=右侧。",
                    },
                ),
                "vertical_angle": (
                    "INT",
                    {
                        "default": DEFAULT_VERTICAL_ANGLE,
                        "min": -30,
                        "max": 60,
                        "step": 1,
                        "display_name": "垂直角度",
                        "tooltip": "相机俯仰角（-30°~60°），0°=平视。",
                    },
                ),
                "zoom": (
                    "FLOAT",
                    {
                        "default": DEFAULT_ZOOM,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.1,
                        "display_name": "距离",
                        "tooltip": "相机到目标的距离（0=远，10=近）。",
                    },
                ),
                # ---- 采样 ----
                "seed": (
                    "INT",
                    _hidden_option(
                        {
                            "default": DEFAULT_SEED,
                            "min": 0,
                            "max": 0xFFFFFFFFFFFFFFFF,
                            "step": 1,
                            "display_name": "随机种子",
                            "tooltip": "采样随机种子。",
                        }
                    ),
                ),
                "enable_4steps": (
                    "BOOLEAN",
                    _hidden_option(
                        {
                            "default": True,
                            "display_name": "启用 4 步加速",
                            "tooltip": "开启时应用 Lightning LoRA，steps/cfg 使用 4 / 1.0；关闭时 steps/cfg 使用 40 / 4.0（与模板一致）。",
                        }
                    ),
                ),
                "steps": (
                    "INT",
                    _hidden_option(
                        {
                            "default": DEFAULT_STEPS,
                            "min": 1,
                            "max": 150,
                            "step": 1,
                            "display_name": "步数（4 步模式）",
                            "tooltip": "启用 4 步加速时的采样步数；关闭时自动使用 40 步。",
                        }
                    ),
                ),
                "cfg": (
                    "FLOAT",
                    _hidden_option(
                        {
                            "default": DEFAULT_CFG,
                            "min": 0.0,
                            "max": 16.0,
                            "step": 0.1,
                            "display_name": "CFG（4 步模式）",
                            "tooltip": "启用 4 步加速时的 CFG；关闭时自动使用 4.0。",
                        }
                    ),
                ),
                "sampler_name": (
                    _sampler_choices(),
                    _hidden_option(
                        {
                            "default": DEFAULT_SAMPLER,
                            "display_name": "采样器",
                            "tooltip": "采样器（默认 euler）。",
                        }
                    ),
                ),
                "scheduler": (
                    _scheduler_choices(),
                    _hidden_option(
                        {
                            "default": DEFAULT_SCHEDULER,
                            "display_name": "调度器",
                            "tooltip": "调度器（默认 simple）。",
                        }
                    ),
                ),
                "denoise": (
                    "FLOAT",
                    _hidden_option(
                        {
                            "default": DEFAULT_DENOISE,
                            "min": 0.0,
                            "max": 1.0,
                            "step": 0.01,
                            "display_name": "去噪强度",
                            "tooltip": "采样去噪强度（默认 1.0）。",
                        }
                    ),
                ),
                # ---- 模型修补 ----
                "shift": (
                    "FLOAT",
                    _hidden_option(
                        {
                            "default": DEFAULT_SHIFT,
                            "min": 0.0,
                            "max": 10.0,
                            "step": 0.1,
                            "display_name": "采样偏移 shift",
                            "tooltip": "ModelSamplingAuraFlow 偏移（默认 3.1）。",
                        }
                    ),
                ),
                "cfgnorm_strength": (
                    "FLOAT",
                    _hidden_option(
                        {
                            "default": DEFAULT_CFGNORM_STRENGTH,
                            "min": 0.0,
                            "max": 2.0,
                            "step": 0.05,
                            "display_name": "CFGNorm 强度",
                            "tooltip": "CFGNorm 后置 CFG 衰减强度（默认 1.0，post_cfg）。",
                        }
                    ),
                ),
                "switch": (
                    "BOOLEAN",
                    _hidden_option(
                        {
                            "default": False,
                            "display_name": "模型分支切换",
                            "tooltip": "与模板 ComfySwitchNode 对应；默认两分支均为修补后的模型，可外接模型覆盖分支。",
                        }
                    ),
                ),
                # ---- 参考潜空间 ----
                "use_ref_latents": (
                    "BOOLEAN",
                    _hidden_option(
                        {
                            "default": True,
                            "display_name": "使用参考潜空间",
                            "tooltip": "是否把输入图编码为参考潜空间写入条件（Qwen Image Edit Plus 语义）。",
                        }
                    ),
                ),
                "reference_latents_method": (
                    REFERENCE_LATENTS_METHODS,
                    _hidden_option(
                        {
                            "default": DEFAULT_REFERENCE_METHOD,
                            "display_name": "参考潜空间方法",
                            "tooltip": "FluxKontext 参考潜空间方法（默认 index_timestep_zero）。",
                        }
                    ),
                ),
                # ---- 提示词 ----
                "positive_prompt": (
                    "STRING",
                    _hidden_option(
                        {
                            "default": "",
                            "multiline": True,
                            "display_name": "正向提示词（附加）",
                            "tooltip": "附加正向提示词；为空时仅使用相机角度提示词。",
                        }
                    ),
                ),
                "negative_prompt": (
                    "STRING",
                    _hidden_option(
                        {
                            "default": "",
                            "multiline": True,
                            "display_name": "负向提示词",
                            "tooltip": "负向提示词（默认空，与模板一致）。",
                        }
                    ),
                ),
                # ---- 框架隐藏参数 ----
                "reference_info": (
                    "STRING",
                    _hidden_option(
                        {
                            "default": "",
                            "display_name": "参考图信息",
                            "tooltip": "📂 上传的本地参考图信息（filename/subfolder/type）；image 未连接时自动读取。",
                        }
                    ),
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
            "optional": {
                "image": (
                    "IMAGE",
                    {
                        "tooltip": "输入图像（BHWC，取第一帧）。也可点 📂 选择本地图片；两者都为空时执行报错。",
                    },
                ),
            },
        }

    def generate(
        self,
        image: Any = None,
        unique_id: Any = None,
        prompt: Any = None,
        extra_pnginfo: Any = None,
        **kwargs,
    ):
        from nodes import KSampler, LoraLoaderModelOnly, VAEDecode, VAEEncode
        from .common_utils.model_loader import (
            gjjutils_apply_cfg_norm,
            gjjutils_patch_model_sampling,
        )

        # ---- 读取参数 ----
        diffusion_model = str(kwargs.get("diffusion_model") or "")
        clip_model = str(kwargs.get("clip_model") or "")
        vae_model = str(kwargs.get("vae_model") or "")
        lightning_lora = str(kwargs.get("lightning_lora") or "")
        angle_lora = str(kwargs.get("angle_lora") or "")
        clip_type = str(kwargs.get("clip_type") or DEFAULT_CLIP_TYPE) or DEFAULT_CLIP_TYPE

        horizontal_angle = int(kwargs.get("horizontal_angle") or DEFAULT_HORIZONTAL_ANGLE)
        vertical_angle = int(kwargs.get("vertical_angle") or DEFAULT_VERTICAL_ANGLE)
        zoom = float(kwargs.get("zoom") or DEFAULT_ZOOM)

        seed = int(kwargs.get("seed") or DEFAULT_SEED)
        enable_4steps = bool(kwargs.get("enable_4steps", True))
        steps = int(kwargs.get("steps") or DEFAULT_STEPS)
        cfg = float(kwargs.get("cfg") or DEFAULT_CFG)
        sampler_name = str(kwargs.get("sampler_name") or DEFAULT_SAMPLER)
        scheduler = str(kwargs.get("scheduler") or DEFAULT_SCHEDULER)
        denoise = float(kwargs.get("denoise") or DEFAULT_DENOISE)

        shift = float(kwargs.get("shift") or DEFAULT_SHIFT)
        cfgnorm_strength = float(kwargs.get("cfgnorm_strength") or DEFAULT_CFGNORM_STRENGTH)
        switch = bool(kwargs.get("switch", False))

        use_ref_latents = bool(kwargs.get("use_ref_latents", True))
        reference_latents_method = str(
            kwargs.get("reference_latents_method") or DEFAULT_REFERENCE_METHOD
        )

        positive_prompt = str(kwargs.get("positive_prompt") or "").strip()
        negative_prompt = str(kwargs.get("negative_prompt") or "").strip()

        def _progress(text: str, ratio: float) -> None:
            send_node_progress(unique_id, text, ratio)

        # ---- 1. 输入图像 ----
        source = None
        if image is not None:
            source = _coerce_image_tensor(image)
        else:
            reference_info = str(kwargs.get("reference_info") or "").strip()
            if reference_info:
                _progress("读取本地参考图…", 0.02)
                source = _load_reference_image_tensor(reference_info)
                if source is None:
                    raise RuntimeError(
                        "无法读取本地参考图，请重新点击 📂 选择图片后再试。"
                    )
            if source is None:
                raise RuntimeError(
                    "缺少输入图像：请把图片连接到 image 输入槽，或点击 📂 选择本地图片。"
                )
        _progress("预处理输入图像…", 0.04)
        scaled = _flux_kontext_image_scale(source)

        # ---- 2. 相机角度提示词 ----
        camera_text = _camera_prompt(horizontal_angle, vertical_angle, zoom)
        final_positive = positive_prompt if positive_prompt else camera_text

        # ---- 3. 加载模型（零依赖内部加载，输入仅图片）----
        if diffusion_model in (MISSING_MODEL, "") or not diffusion_model:
            raise RuntimeError(
                "缺少主模型（Unet）。\n请把 Qwen Image Edit 2511 模型放到 ComfyUI/models/diffusion_models/ 后重试。\n"
                f"模型下载：{MODEL_DOWNLOAD_URL}"
            )
        _progress("加载扩散模型…", 0.08)
        model = _load_diffusion_model_internal(diffusion_model)
        _progress("加载文本编码器…", 0.14)
        clip = _load_clip_internal(clip_model, clip_type)
        _progress("加载 VAE…", 0.2)
        vae = _load_vae_internal(vae_model)

        # ---- 4. LoRA（模型仅 LoRA，Qwen Image 系列不加载 CLIP LoRA）----
        lora_loader = LoraLoaderModelOnly()
        if enable_4steps and lightning_lora and lightning_lora != MISSING_MODEL:
            _progress("应用 Lightning 4 步 LoRA…", 0.24)
            model = lora_loader.load_lora_model_only(model, lightning_lora, 1.0)[0]
        if angle_lora and angle_lora != MISSING_MODEL:
            _progress("应用多角度 LoRA…", 0.26)
            model = lora_loader.load_lora_model_only(model, angle_lora, 1.0)[0]

        # ---- 5. 采样修补（ModelSamplingAuraFlow + CFGNorm + 分支切换）----
        _progress("修补采样参数…", 0.3)
        model = gjjutils_patch_model_sampling(model, "aura", shift)
        model = gjjutils_apply_cfg_norm(model, cfgnorm_strength)
        # 模板中 switch 两分支均为 CFGNorm 输出；此处保留该语义（节点内部参数，非外接输入）
        selected_model = model

        # ---- 6. 条件编码 ----
        _progress("编码正/负条件…", 0.38)
        positive = _text_encode_qwen_image_edit_plus(
            clip,
            vae,
            final_positive,
            image1=scaled,
            use_ref_latents=use_ref_latents,
        )
        negative = _text_encode_qwen_image_edit_plus(
            clip,
            vae,
            negative_prompt,
            image1=scaled,
            use_ref_latents=use_ref_latents,
        )
        if use_ref_latents:
            positive = _flux_kontext_reference_latents_method(positive, reference_latents_method)
            negative = _flux_kontext_reference_latents_method(negative, reference_latents_method)

        # ---- 7. 潜空间初始化（与模板一致：VAEEncode 缩放后图像）----
        _progress("编码潜空间…", 0.44)
        latent = VAEEncode().encode(vae, scaled)[0]

        # ---- 8. 采样 ----
        effective_steps = steps if enable_4steps else FULL_STEPS
        effective_cfg = cfg if enable_4steps else FULL_CFG
        _progress(
            f"采样中…（{effective_steps} 步 / CFG {effective_cfg}）",
            0.5,
        )
        samples = KSampler().sample(
            selected_model,
            seed,
            effective_steps,
            effective_cfg,
            sampler_name,
            scheduler,
            positive,
            negative,
            latent,
            denoise=denoise,
        )[0]

        # ---- 9. 解码 ----
        _progress("解码图像…", 0.92)
        decoded = VAEDecode().decode(vae, samples)[0]

        # ---- 10. 临时文件 + UI（统一走 temp_files 内容寻址，避免重复文件）----
        _progress("写入预览…", 0.98)
        ui_data: dict[str, Any] = {}
        try:
            preview_infos = gjjutils_write_temp_tensor_images(decoded, media_type="image")
            if preview_infos:
                ui_data["preview_images"] = preview_infos
        except Exception:
            print("[GJJ_QwenMultiangleStudio] 写入预览图片失败:")
            traceback.print_exc()

        _progress("完成", 1.0)
        return {"ui": ui_data, "result": (decoded,)}


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_QwenMultiangleStudio,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
