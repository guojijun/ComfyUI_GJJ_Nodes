from __future__ import annotations

import os
from typing import Any

import comfy.controlnet
import comfy.sd
import comfy.utils
import folder_paths
from nodes import CLIPTextEncode, ControlNetApplyAdvanced, EmptyLatentImage, VAEDecode, common_ksampler
from server import PromptServer


NODE_NAME = "GJJ_DepthControlNetGenerator"
DEFAULT_CHECKPOINT = "architecturerealmix_v11.safetensors"
DEFAULT_CONTROLNET = "control_v11f1p_sd15_depth_fp16.safetensors"
CHECKPOINT_KEYWORDS = [
    "japaneseStyleRealistic",
    "dreamCreationVirtual3DECommerce",
    "ad_老王sd1.5_arch",
    "architecturerealmix_",
    "awpainting_",
    "dreamshaper_",
    "v1-5-pruned-emaonly",
    "interiordesignsuperm_",
    "majicmixrealistic_",
    "xsarchitectural_",
]
DEFAULT_POSITIVE = (
    "streamlined,special form building,white wall,curtain wall,window,"
    "indoor warm light,indoor spaces can be seen through the glass,front square,"
    "rain stains on the road,high saturation,masterpiece,high quality,8k,best quality,"
    "super Realistic,high detail,clean and tidy,"
)
DEFAULT_NEGATIVE = (
    "(hands), text, error, cropped, (worst quality:1.2), (low quality:1.2), normal quality, "
    "(jpeg artifacts:1.3), signature, watermark, username, blurry, artist name, monochrome, "
    "sketch, censorship, censor, (copyright:1.2),human"
)
DEFAULT_WIDTH = 1024
DEFAULT_HEIGHT = 1024
DEFAULT_BATCH_SIZE = 1
DEFAULT_STRENGTH = 1.0
DEFAULT_START_PERCENT = 0.0
DEFAULT_END_PERCENT = 1.0
DEFAULT_STEPS = 20
DEFAULT_CFG = 7.0
DEFAULT_SAMPLER = "euler_ancestral"
DEFAULT_SCHEDULER = "normal"
DEFAULT_DENOISE = 1.0


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        PromptServer.instance.send_progress_text(str(text or ""), unique_id)
    except Exception:
        return


def _list_checkpoints() -> list[str]:
    try:
        items = list(folder_paths.get_filename_list("checkpoints"))
    except Exception:
        return []
    filtered = _filter_checkpoint_names(items)
    return filtered or items


def _list_controlnets() -> list[str]:
    try:
        return list(folder_paths.get_filename_list("controlnet"))
    except Exception:
        return []


def _basename(name: str) -> str:
    return os.path.basename(str(name or "").replace("\\", "/"))


def _normalize_key(text: str) -> str:
    return str(text or "").replace("\\", "/").lower()


def _filter_checkpoint_names(candidates: list[str]) -> list[str]:
    matched: list[tuple[int, int, str]] = []
    for candidate in candidates:
        key = _normalize_key(candidate)
        keyword_index = next((i for i, keyword in enumerate(CHECKPOINT_KEYWORDS) if keyword in key), -1)
        if keyword_index < 0:
            continue
        has_subdir = 0 if ("/" in key or "\\" in str(candidate)) else 1
        matched.append((has_subdir, keyword_index, candidate))
    matched.sort(key=lambda item: (item[0], item[1], _normalize_key(item[2])))
    return [item[2] for item in matched]


def _resolve_default_name(candidates: list[str], preferred_name: str) -> str:
    if not candidates:
        return preferred_name

    if preferred_name in candidates:
        return preferred_name

    preferred_base = _basename(preferred_name).lower()
    for candidate in candidates:
        if _basename(candidate).lower() == preferred_base:
            return candidate

    return candidates[0]


def _load_checkpoint_runtime(ckpt_name: str):
    ckpt_path = folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)
    embedding_directory = folder_paths.get_folder_paths("embeddings")
    model, clip, vae = comfy.sd.load_checkpoint_guess_config(
        ckpt_path,
        output_vae=True,
        output_clip=True,
        embedding_directory=embedding_directory,
    )[:3]
    return model, clip, vae


def _load_controlnet_runtime(controlnet_name: str):
    controlnet_path = folder_paths.get_full_path_or_raise("controlnet", controlnet_name)
    controlnet = comfy.controlnet.load_controlnet(controlnet_path)
    if controlnet is None:
        raise RuntimeError("Depth ControlNet 文件无效，未能加载出可用的 ControlNet 模型。")
    return controlnet


class GJJ_DepthControlNetGenerator:
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    DESCRIPTION = (
        "将官方 depth_controlnet 工作流封装成简洁单节点。"
        "前台只暴露深度图、正向提示词、底模、深度 ControlNet 和随机种子；"
        "CLIP、VAE 与采样参数在后台按官方默认流程处理。"
    )
    SEARCH_ALIASES = [
        "depth controlnet",
        "depth cn",
        "深度控制",
        "深度生图",
        "controlnet depth",
    ]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("深度生图结果",)
    OUTPUT_TOOLTIPS = ("按官方 depth_controlnet 工作流生成的最终图像。",)

    def __init__(self):
        self._runtime_cache_key: tuple[str, str] | None = None
        self._runtime_cache_value: tuple[Any, Any, Any, Any] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = _list_checkpoints() or [DEFAULT_CHECKPOINT]
        controlnets = _list_controlnets() or [DEFAULT_CONTROLNET]
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "深度图像",
                        "tooltip": "输入深度参考图，用作 Depth ControlNet 的控制图。",
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_POSITIVE,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "默认值来自官方 depth_controlnet 工作流。",
                    },
                ),
                "ckpt_name": (
                    checkpoints,
                    {
                        "default": DEFAULT_CHECKPOINT if DEFAULT_CHECKPOINT in checkpoints else checkpoints[0],
                        "display_name": "UNET 主模型",
                        "tooltip": "底模 checkpoint。列表只保留当前稳定可用的建筑类 SD1.5 模型，并优先显示子目录模型。",
                    },
                ),
                "controlnet_name": (
                    controlnets,
                    {
                        "default": _resolve_default_name(controlnets, DEFAULT_CONTROLNET),
                        "display_name": "深度控制模型",
                        "tooltip": "深度 ControlNet 模型；会自动搜索 controlnet 子目录里的同名文件。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 508527445193039,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "采样随机种子，默认值来自官方工作流。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, image, positive_prompt, ckpt_name, controlnet_name, seed, unique_id=None):
        return "|".join(
            [
                str(tuple(image.shape)) if hasattr(image, "shape") else "image",
                str(positive_prompt),
                str(ckpt_name),
                str(controlnet_name),
                str(seed),
            ]
        )

    def _load_runtime(self, ckpt_name: str, controlnet_name: str):
        cache_key = (str(ckpt_name or ""), str(controlnet_name or ""))
        if self._runtime_cache_key == cache_key and self._runtime_cache_value is not None:
            return self._runtime_cache_value

        model, clip, vae = _load_checkpoint_runtime(ckpt_name)
        controlnet = _load_controlnet_runtime(controlnet_name)

        self._runtime_cache_key = cache_key
        self._runtime_cache_value = (model, clip, vae, controlnet)
        return model, clip, vae, controlnet

    def generate(self, image, positive_prompt, ckpt_name, controlnet_name, seed, unique_id=None):
        _send_status(unique_id, "1/6 检查并加载底模与 Depth ControlNet...")
        try:
            model, clip, vae, controlnet = self._load_runtime(ckpt_name, controlnet_name)
        except Exception as exc:
            raise RuntimeError(
                "Depth ControlNet 节点加载模型失败。\n"
                f"Checkpoint: {ckpt_name}\n"
                f"ControlNet: {controlnet_name}\n"
                f"详细错误：{exc}"
            ) from exc

        _send_status(unique_id, "2/6 编码提示词...")
        positive = CLIPTextEncode().encode(clip, str(positive_prompt or "").strip() or DEFAULT_POSITIVE)[0]
        negative = CLIPTextEncode().encode(clip, DEFAULT_NEGATIVE)[0]

        _send_status(unique_id, "3/6 应用 Depth ControlNet...")
        positive, negative = ControlNetApplyAdvanced().apply_controlnet(
            positive,
            negative,
            controlnet,
            image,
            DEFAULT_STRENGTH,
            DEFAULT_START_PERCENT,
            DEFAULT_END_PERCENT,
            vae=None,
        )

        _send_status(unique_id, "4/6 构建 Latent...")
        latent = EmptyLatentImage().generate(DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_BATCH_SIZE)[0]

        _send_status(unique_id, "5/6 采样中...")
        sampled = common_ksampler(
            model,
            int(seed),
            DEFAULT_STEPS,
            DEFAULT_CFG,
            DEFAULT_SAMPLER,
            DEFAULT_SCHEDULER,
            positive,
            negative,
            latent,
            denoise=DEFAULT_DENOISE,
        )[0]

        _send_status(unique_id, "6/6 解码结果图像...")
        result = VAEDecode().decode(vae, sampled)[0]
        _send_status(unique_id, f"完成：{int(result.shape[2])} × {int(result.shape[1])}")
        return (result,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_DepthControlNetGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧭 深度ControlNet生图器"}
