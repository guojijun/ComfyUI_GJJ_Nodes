from __future__ import annotations

import comfy.sd
import comfy.utils
import folder_paths
import torch

from .model_family_preset_table import load_model_family_presets, match_model_family_preset
from .model_bundle_loader import (
    UNET_DTYPE_OPTIONS,
    VAE_DTYPE_OPTIONS,
    _build_unet_model_options,
    _resolve_full_path,
    _torch_dtype_from_name,
    list_unet_models,
    list_vae_models,
)


NODE_NAME = "GJJ_Flux1DualCLIPLoader"
DEFAULT_UNET = "flux1-krea-dev_fp8_scaled.safetensors"
DEFAULT_CLIP_1 = "clip_l.safetensors"
DEFAULT_CLIP_2 = "t5xxl_fp8_e4m3fn.safetensors"
DEFAULT_VAE = "ae.safetensors"
MODEL_FAMILY_PRESETS = load_model_family_presets()


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


def _safe_filename_list(category: str) -> list[str]:
    try:
        return _dedupe_keep_order(list(folder_paths.get_filename_list(category)))
    except Exception:
        return []


def _preferred_default(values: list[str], preferred: str) -> str:
    preferred = str(preferred or "").strip()
    if preferred and preferred in values:
        return preferred
    return values[0] if values else ""


def list_clip_models() -> list[str]:
    values = _safe_filename_list("text_encoders")
    if values:
        return values
    return _safe_filename_list("clip")


def _match_flux_preset(unet_name: str) -> dict | None:
    preset = match_model_family_preset(unet_name, MODEL_FAMILY_PRESETS)
    if not preset:
        return None
    return preset if str(preset.get("clip_type") or "") == "flux" else None


def _default_flux_bundle(unet_name: str) -> tuple[str, str, str]:
    preset = _match_flux_preset(unet_name) or {}
    clip_names = list(preset.get("clip_names") or [])
    clip_1 = clip_names[0] if len(clip_names) >= 1 else DEFAULT_CLIP_1
    clip_2 = clip_names[1] if len(clip_names) >= 2 else DEFAULT_CLIP_2
    vae_name = str(preset.get("vae_name") or DEFAULT_VAE)
    return clip_1, clip_2, vae_name


class GJJ_Flux1DualCLIPLoader:
    CATEGORY = "GJJ"
    FUNCTION = "load_models"
    DESCRIPTION = "为 Flux 1 系列模型一次性加载 UNET、双 CLIP 和 VAE，适合作为 Flux 1 工作流的基础模型入口。"
    SEARCH_ALIASES = [
        "flux1 dual clip",
        "flux1 loader",
        "双clip",
        "flux 1",
        "krea",
    ]
    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("扩散模型输出", "文本编码输出", "图像解码输出")
    OUTPUT_TOOLTIPS = (
        "Flux 1 主扩散模型输出。",
        "Flux 1 双 CLIP 合并后的编码器输出，可直接连接到提示词编码节点。",
        "Flux 1 对应的 VAE 输出。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        unet_models = list_unet_models() or [""]
        clip_models = list_clip_models() or [""]
        vae_models = list_vae_models() or [""]
        default_unet = _preferred_default(unet_models, DEFAULT_UNET)
        default_clip_1, default_clip_2, default_vae = _default_flux_bundle(default_unet)
        return {
            "required": {
                "unet_name": (
                    unet_models,
                    {
                        "default": default_unet,
                        "display_name": "UNET 模型",
                        "tooltip": "Flux 1 主扩散模型；默认使用 flux1-krea-dev_fp8_scaled.safetensors。",
                    },
                ),
                "unet_dtype": (
                    UNET_DTYPE_OPTIONS,
                    {
                        "default": "fp8_e4m3fn",
                        "display_name": "数据类型",
                        "tooltip": "Flux 1 默认使用 fp8_e4m3fn 精度加载。",
                    },
                ),
                "clip_name1": (
                    clip_models,
                    {
                        "default": _preferred_default(clip_models, default_clip_1),
                        "display_name": "CLIP 编码器 1",
                        "tooltip": "Flux 1 双 CLIP 的第一个编码器；默认 clip_l.safetensors。",
                    },
                ),
                "clip_name2": (
                    clip_models,
                    {
                        "default": _preferred_default(clip_models, default_clip_2),
                        "display_name": "CLIP 编码器 2",
                        "tooltip": "Flux 1 双 CLIP 的第二个编码器；默认 t5xxl_fp8_e4m3fn.safetensors。",
                    },
                ),
                "clip_device": (
                    ["default", "cpu"],
                    {
                        "default": "default",
                        "display_name": "CLIP 设备",
                        "tooltip": "默认跟随 ComfyUI；低显存时可以改成 cpu。",
                    },
                ),
                "vae_name": (
                    vae_models,
                    {
                        "default": _preferred_default(vae_models, default_vae),
                        "display_name": "VAE 模型",
                        "tooltip": "Flux 1 默认使用 ae.safetensors。",
                    },
                ),
                "vae_dtype": (
                    VAE_DTYPE_OPTIONS,
                    {
                        "default": "default",
                        "display_name": "VAE 精度",
                        "tooltip": "设置 VAE 加载精度；default 表示交给 ComfyUI 自动处理。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(cls, unet_name, unet_dtype, clip_name1, clip_name2, clip_device, vae_name, vae_dtype):
        return "|".join(
            [
                str(unet_name),
                str(unet_dtype),
                str(clip_name1),
                str(clip_name2),
                str(clip_device),
                str(vae_name),
                str(vae_dtype),
            ]
        )

    def _load_vae(self, vae_name: str, vae_dtype: str):
        vae_path = _resolve_full_path(("vae",), vae_name)
        sd, metadata = comfy.utils.load_torch_file(vae_path, return_metadata=True)
        dtype = _torch_dtype_from_name(vae_dtype)
        vae = comfy.sd.VAE(sd=sd, metadata=metadata, dtype=dtype)
        vae.throw_exception_if_invalid()
        return vae

    def load_models(self, unet_name, unet_dtype, clip_name1, clip_name2, clip_device, vae_name, vae_dtype):
        if not str(unet_name or "").strip():
            raise RuntimeError("UNET 模型不能为空。")
        preset_clip_1, preset_clip_2, preset_vae = _default_flux_bundle(unet_name)
        clip_name1 = str(clip_name1 or "").strip() or preset_clip_1
        clip_name2 = str(clip_name2 or "").strip() or preset_clip_2
        vae_name = str(vae_name or "").strip() or preset_vae
        if not clip_name1 or not clip_name2:
            raise RuntimeError("Flux 1 双 CLIP 的两个编码器都不能为空。")
        if not vae_name:
            raise RuntimeError("VAE 模型不能为空。")

        unet_path = _resolve_full_path(("diffusion_models",), unet_name)
        model = comfy.sd.load_diffusion_model(unet_path, model_options=_build_unet_model_options(unet_dtype))

        clip_path1 = _resolve_full_path(("text_encoders", "clip"), clip_name1)
        clip_path2 = _resolve_full_path(("text_encoders", "clip"), clip_name2)

        model_options = {}
        if str(clip_device or "") == "cpu":
            cpu = torch.device("cpu")
            model_options["load_device"] = cpu
            model_options["offload_device"] = cpu

        try:
            embedding_directory = folder_paths.get_folder_paths("embeddings")
        except Exception:
            embedding_directory = []

        clip = comfy.sd.load_clip(
            ckpt_paths=[clip_path1, clip_path2],
            embedding_directory=embedding_directory,
            clip_type=getattr(comfy.sd.CLIPType, "FLUX", comfy.sd.CLIPType.STABLE_DIFFUSION),
            model_options=model_options,
        )
        vae = self._load_vae(vae_name, vae_dtype)
        return (model, clip, vae)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Flux1DualCLIPLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧠 Flux1双CLIP加载器"}
