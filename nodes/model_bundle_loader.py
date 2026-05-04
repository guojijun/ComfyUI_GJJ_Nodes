from __future__ import annotations

import folder_paths
import torch
import comfy.sd
import comfy.utils


UNET_DTYPE_OPTIONS = ["default", "float16", "bfloat16", "float32", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"]
CLIP_TYPE_OPTIONS = [
    "stable_diffusion",
    "stable_cascade",
    "sd3",
    "stable_audio",
    "mochi",
    "ltxv",
    "pixart",
    "cosmos",
    "lumina2",
    "wan",
    "hidream",
    "chroma",
    "ace",
    "omnigen2",
    "qwen_image",
    "hunyuan_image",
    "flux2",
    "ovis",
    "longcat_image",
]
CLIP_DTYPE_OPTIONS = ["default", "float16", "bfloat16", "float32"]
VAE_DTYPE_OPTIONS = ["default", "float16", "bfloat16", "float32"]
NODE_NAME = "GJJ_ModelBundleLoader"


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


def _default_value(values: list[str]) -> str:
    return values[0] if values else ""


def _normalize_text(value: str | None) -> str:
    return str(value or "").strip().lower()


def _resolve_full_path(categories: tuple[str, ...], filename: str) -> str:
    if not str(filename or "").strip():
        raise RuntimeError("模型文件名不能为空。")

    last_error: Exception | None = None
    for category in categories:
        try:
            return folder_paths.get_full_path_or_raise(category, filename)
        except Exception as exc:  # pragma: no cover - 依赖 ComfyUI 路径索引
            last_error = exc

    if last_error is not None:
        raise last_error
    raise RuntimeError(f"未找到模型文件：{filename}")


def list_unet_models() -> list[str]:
    return _safe_filename_list("diffusion_models")


def list_clip_models() -> list[str]:
    values = _safe_filename_list("text_encoders")
    if values:
        return values
    return _safe_filename_list("clip")


def list_vae_models() -> list[str]:
    return _safe_filename_list("vae")


def _torch_dtype_from_name(name: str) -> torch.dtype | None:
    value = _normalize_text(name)
    if value == "float16":
        return torch.float16
    if value == "bfloat16":
        return torch.bfloat16
    if value == "float32":
        return torch.float32
    if value == "fp8_e4m3fn" and hasattr(torch, "float8_e4m3fn"):
        return torch.float8_e4m3fn
    if value == "fp8_e5m2" and hasattr(torch, "float8_e5m2"):
        return torch.float8_e5m2
    return None


def _build_unet_model_options(weight_dtype: str) -> dict:
    model_options: dict = {}
    value = _normalize_text(weight_dtype)
    if value == "fp8_e4m3fn_fast" and hasattr(torch, "float8_e4m3fn"):
        model_options["dtype"] = torch.float8_e4m3fn
        model_options["fp8_optimizations"] = True
        return model_options

    dtype = _torch_dtype_from_name(weight_dtype)
    if dtype is not None:
        model_options["dtype"] = dtype
    return model_options


def _build_clip_model_options(dtype_name: str) -> dict:
    model_options: dict = {}
    dtype = _torch_dtype_from_name(dtype_name)
    if dtype is not None:
        model_options["dtype"] = dtype
    return model_options


class GJJ_ModelBundleLoader:
    CATEGORY = "GJJ"
    FUNCTION = "load_models"
    DESCRIPTION = "一次性加载 UNET、CLIP、VAE，并附带常用的步数、CFG、降噪参数输出，便于快速搭建基础采样链路。"
    SEARCH_ALIASES = ["简易加载器", "model loader", "easy loader", "UNET", "CLIP", "VAE", "KSampler", "采样参数"]
    RETURN_TYPES = ("MODEL", "CLIP", "VAE", "INT", "FLOAT", "FLOAT")
    RETURN_NAMES = ("扩散模型输出", "文本编码输出", "图像解码输出", "推荐采样步数", "推荐引导强度", "推荐降噪强度")
    OUTPUT_TOOLTIPS = (
        "当前节点加载完成后的 UNET / 扩散模型输出。",
        "当前节点加载完成后的 CLIP / 文本编码器输出。",
        "当前节点加载完成后的 VAE 模型输出。",
        "可直接连接到 KSampler 的 steps 输入。",
        "可直接连接到 KSampler 的 cfg 输入。",
        "可直接连接到 KSampler 的 denoise 输入。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        unet_models = list_unet_models() or [""]
        clip_models = list_clip_models() or [""]
        vae_models = list_vae_models() or [""]
        return {
            "required": {
                "unet_name": (
                    unet_models,
                    {
                        "default": _default_value(unet_models),
                        "display_name": "💜 UNET 模型",
                        "tooltip": "选择主扩散模型文件，风格上采用 easy-use 那种标准 ComfyUI 简洁加载器排版。",
                    },
                ),
                "unet_dtype": (
                    UNET_DTYPE_OPTIONS,
                    {
                        "default": "default",
                        "display_name": "💜 UNET 精度",
                        "tooltip": "设置 UNET 的加载精度；default 表示交给 ComfyUI 自动处理。",
                    },
                ),
                "clip_name": (
                    clip_models,
                    {
                        "default": _default_value(clip_models),
                        "display_name": "💛 CLIP 模型",
                        "tooltip": "选择文本编码器模型；自动兼容 text_encoders / clip 两类目录。",
                    },
                ),
                "clip_type": (
                    CLIP_TYPE_OPTIONS,
                    {
                        "default": "stable_diffusion",
                        "display_name": "💛 CLIP 类型",
                        "tooltip": "设置文本编码器架构类型，通常需要与所选 UNET 架构匹配。",
                    },
                ),
                "clip_dtype": (
                    CLIP_DTYPE_OPTIONS,
                    {
                        "default": "default",
                        "display_name": "💛 CLIP 精度",
                        "tooltip": "设置 CLIP 的加载精度；default 表示交给 ComfyUI 自动处理。",
                    },
                ),
                "vae_name": (
                    vae_models,
                    {
                        "default": _default_value(vae_models),
                        "display_name": "❤️ VAE 模型",
                        "tooltip": "选择 VAE 模型，建议优先使用与当前 UNET 同体系的版本。",
                    },
                ),
                "vae_dtype": (
                    VAE_DTYPE_OPTIONS,
                    {
                        "default": "default",
                        "display_name": "❤️ VAE 精度",
                        "tooltip": "设置 VAE 的加载精度；default 表示交给 ComfyUI 自动处理。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 20,
                        "min": 1,
                        "max": 10000,
                        "display_name": "步数",
                        "tooltip": "默认采样步数，可直接输出给 KSampler 的 steps。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display_name": "CFG 引导强度",
                        "tooltip": "默认提示词引导强度，可直接输出给 KSampler 的 cfg。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪",
                        "tooltip": "默认降噪强度，可直接输出给 KSampler 的 denoise。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(
        cls,
        unet_name,
        unet_dtype,
        clip_name,
        clip_type,
        clip_dtype,
        vae_name,
        vae_dtype,
        steps,
        cfg,
        denoise,
    ):
        return "|".join(
            [
                str(unet_name),
                str(unet_dtype),
                str(clip_name),
                str(clip_type),
                str(clip_dtype),
                str(vae_name),
                str(vae_dtype),
                str(steps),
                str(cfg),
                str(denoise),
            ]
        )

    def _load_vae(self, vae_name: str, vae_dtype: str):
        vae_path = _resolve_full_path(("vae",), vae_name)
        sd, metadata = comfy.utils.load_torch_file(vae_path, return_metadata=True)
        dtype = _torch_dtype_from_name(vae_dtype)
        vae = comfy.sd.VAE(sd=sd, metadata=metadata, dtype=dtype)
        vae.throw_exception_if_invalid()
        return vae

    def load_models(
        self,
        unet_name,
        unet_dtype,
        clip_name,
        clip_type,
        clip_dtype,
        vae_name,
        vae_dtype,
        steps,
        cfg,
        denoise,
    ):
        if not str(unet_name or "").strip():
            raise RuntimeError("UNET 模型不能为空。")
        if not str(clip_name or "").strip():
            raise RuntimeError("CLIP 模型不能为空。")
        if not str(vae_name or "").strip():
            raise RuntimeError("VAE 模型不能为空。")

        unet_path = _resolve_full_path(("diffusion_models",), unet_name)
        unet = comfy.sd.load_diffusion_model(unet_path, model_options=_build_unet_model_options(unet_dtype))

        clip_path = _resolve_full_path(("text_encoders", "clip"), clip_name)
        clip_enum = getattr(comfy.sd.CLIPType, str(clip_type or "").upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
        clip = comfy.sd.load_clip(
            ckpt_paths=[clip_path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=clip_enum,
            model_options=_build_clip_model_options(clip_dtype),
        )

        vae = self._load_vae(vae_name, vae_dtype)

        return (unet, clip, vae, int(steps), float(cfg), float(denoise))


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ModelBundleLoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 📦 简易模型加载器"}
