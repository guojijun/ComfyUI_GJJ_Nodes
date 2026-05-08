"""GJJ 模型族专用加载器。

为不同模型族提供专门的模型加载逻辑，处理特殊的配套机制：

**LTX 2.3**：
- 双 VAE 架构：视频 VAE + 音频 VAE
- 需要同时加载两个 VAE 模型

**WAN 2.2**：
- 双 UNET 架构：主 UNET + 辅助 UNET
- 需要同时加载两个 UNET 模型

**使用示例**：
>>> # LTX 模型加载
>>> models = gjjutils_load_ltx23_models()
>>> video_vae = models["video_vae"]
>>> audio_vae = models["audio_vae"]

>>> # WAN 模型加载
>>> models = gjjutils_load_wan22_models()
>>> main_unet = models["main_unet"]
>>> aux_unet = models["aux_unet"]
"""
from __future__ import annotations

from typing import Any

import comfy.sd
import comfy.utils
import folder_paths
import torch


# ============================================================================
# LTX 2.3 模型加载
# ============================================================================

DEFAULT_LTX23_CKPT_CANDIDATES = (
    "ltx-2.3-22b",
    "ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled_v3.safetensors",
    "ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled.safetensors",
    "ltx-2.3-22b-dev-fp8.safetensors",
    "ltx-2.3-22b-dev.safetensors",
)

DEFAULT_LTX23_VIDEO_VAE_CANDIDATES = (
    "LTX23_video_vae_bf16.safetensors",
    "ltx23_video_vae_bf16.safetensors",
)

DEFAULT_LTX23_AUDIO_VAE_CANDIDATES = (
    "LTX23_audio_vae_bf16.safetensors",
    "ltx23_audio_vae_bf16.safetensors",
    # 回退到视频 VAE（如果音频 VAE 不可用）
    "LTX23_video_vae_bf16.safetensors",
    "ltx23_video_vae_bf16.safetensors",
)

DEFAULT_LTX23_TEXT_ENCODER_CANDIDATES = (
    "gemma_3_12B_it_fp8_scaled.safetensors",
    "gemma_3_12B_it_fp8_e4m3fn.safetensors",
    "gemma_3_12B_it.safetensors",
    "gemma_3_12B_it_fp4_mixed.safetensors",
)


def _pick_first_available(
    category: str,
    candidates: tuple[str, ...],
    label: str,
    required: bool = True
) -> str:
    """从候选列表中查找第一个可用的模型文件。

    Args:
        category: 模型类别 (checkpoints/vae/text_encoders)
        candidates: 候选文件名列表
        label: 模型描述（用于错误提示）
        required: 是否为必需模型

    Returns:
        找到的模型文件名

    Raises:
        FileNotFoundError: 如果 required=True 且未找到任何候选文件
    """
    available_files = folder_paths.get_filename_list(category)

    for candidate in candidates:
        if candidate in available_files:
            return candidate

    if not required:
        return ""

    candidate_list = ", ".join(candidates)
    raise FileNotFoundError(
        f"未找到{label}，候选文件：{candidate_list}。\n"
        f"请确认已将模型文件放置到 ComfyUI/models/{category}/ 目录。"
    )


def gjjutils_load_ltx23_models(
    ckpt_candidates: tuple[str, ...] = DEFAULT_LTX23_CKPT_CANDIDATES,
    video_vae_candidates: tuple[str, ...] = DEFAULT_LTX23_VIDEO_VAE_CANDIDATES,
    audio_vae_candidates: tuple[str, ...] = DEFAULT_LTX23_AUDIO_VAE_CANDIDATES,
    text_encoder_candidates: tuple[str, ...] = DEFAULT_LTX23_TEXT_ENCODER_CANDIDATES,
    require_audio_vae: bool = True,
) -> dict[str, Any]:
    """加载 LTX 2.3 模型族的所有必需模型。

    LTX 2.3 需要加载：
    - 主检查点（checkpoint）
    - 视频 VAE（video VAE）
    - 音频 VAE（audio VAE）- 可选
    - 文本编码器（text encoder）

    Args:
        ckpt_candidates: 主检查点候选列表
        video_vae_candidates: 视频 VAE 候选列表
        audio_vae_candidates: 音频 VAE 候选列表
        text_encoder_candidates: 文本编码器候选列表
        require_audio_vae: 是否强制要求音频 VAE（默认 True）

    Returns:
        包含所有加载模型的字典：
        {
            "ckpt": str,              # 主检查点文件名
            "video_vae": str,         # 视频 VAE 文件名
            "audio_vae": str,         # 音频 VAE 文件名（可能为空字符串）
            "text_encoder": str,      # 文本编码器文件名
            "model": object,          # 加载的模型对象
            "clip": object,           # 加载的 CLIP 对象
            "video_vae_obj": object,  # 视频 VAE 对象
            "audio_vae_obj": object,  # 音频 VAE 对象（可能为 None）
        }

    Raises:
        FileNotFoundError: 如果任何必需模型未找到
    """
    # 1. 查找模型文件
    ckpt_name = _pick_first_available("checkpoints", ckpt_candidates, "LTX 主模型")
    video_vae_name = _pick_first_available("vae", video_vae_candidates, "LTX 视频 VAE")
    audio_vae_name = _pick_first_available("checkpoints", audio_vae_candidates, "LTX 音频 VAE", required=require_audio_vae)
    text_encoder_name = _pick_first_available("text_encoders", text_encoder_candidates, "LTX 文本编码器")

    # 2. 加载主模型
    from nodes import CheckpointLoaderSimple
    model, _, _ = CheckpointLoaderSimple().load_checkpoint(ckpt_name)

    # 3. 加载 CLIP
    from .audio_tools import LTXAVTextEncoderLoader
    clip = LTXAVTextEncoderLoader.execute(text_encoder_name, ckpt_name, "default")[0]

    # 4. 加载视频 VAE
    video_vae_path = folder_paths.get_full_path_or_raise("vae", video_vae_name)
    sd, metadata = comfy.utils.load_torch_file(video_vae_path, return_metadata=True)
    video_vae_obj = comfy.sd.VAE(sd=sd, metadata=metadata, dtype=None)
    video_vae_obj.throw_exception_if_invalid()

    # 5. 加载音频 VAE（可选 — 使用 LTXVAudioVAELoader 以获取正确的 prefix replacement）
    audio_vae_obj = None
    if audio_vae_name:
        from .audio_tools import LTXVAudioVAELoader
        audio_vae_obj = LTXVAudioVAELoader.execute(audio_vae_name)[0]

    return {
        "ckpt": ckpt_name,
        "video_vae": video_vae_name,
        "audio_vae": audio_vae_name,
        "text_encoder": text_encoder_name,
        "model": model,
        "clip": clip,
        "video_vae_obj": video_vae_obj,
        "audio_vae_obj": audio_vae_obj,
    }


# ============================================================================
# WAN 2.2 模型加载
# ============================================================================

DEFAULT_WAN22_CKPT_CANDIDATES = (
    "wan2.2-i2v-high-noise",
    "wan2.2-i2v-high-noise-720p",
    "wan2.2-t2v-high-noise",
    "wan2.2-t2v-high-noise-720p",
)

DEFAULT_WAN22_MAIN_UNET_CANDIDATES = (
    "wan2.2_main_unet_fp8.safetensors",
    "wan2.2_main_unet.safetensors",
)

DEFAULT_WAN22_AUX_UNET_CANDIDATES = (
    "wan2.2_aux_unet_fp8.safetensors",
    "wan2.2_aux_unet.safetensors",
)

DEFAULT_WAN22_CLIP_CANDIDATES = (
    "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    "umt5_xxl_fp16.safetensors",
)

DEFAULT_WAN22_VAE_CANDIDATES = (
    "wan_2.1_vae.safetensors",
    "wan2.1_vae.safetensors",
)


def gjjutils_load_wan22_models(
    ckpt_candidates: tuple[str, ...] = DEFAULT_WAN22_CKPT_CANDIDATES,
    main_unet_candidates: tuple[str, ...] = DEFAULT_WAN22_MAIN_UNET_CANDIDATES,
    aux_unet_candidates: tuple[str, ...] = DEFAULT_WAN22_AUX_UNET_CANDIDATES,
    clip_candidates: tuple[str, ...] = DEFAULT_WAN22_CLIP_CANDIDATES,
    vae_candidates: tuple[str, ...] = DEFAULT_WAN22_VAE_CANDIDATES,
) -> dict[str, Any]:
    """加载 WAN 2.2 模型族的所有必需模型。

    WAN 2.2 需要加载：
    - 主检查点（checkpoint，包含基础配置）
    - 主 UNET（main UNET，负责主要推理）
    - 辅助 UNET（aux UNET，负责辅助功能）
    - CLIP 文本编码器
    - VAE

    Args:
        ckpt_candidates: 主检查点候选列表
        main_unet_candidates: 主 UNET 候选列表
        aux_unet_candidates: 辅助 UNET 候选列表
        clip_candidates: CLIP 候选列表
        vae_candidates: VAE 候选列表

    Returns:
        包含所有加载模型的字典：
        {
            "ckpt": str,              # 主检查点文件名
            "main_unet": str,         # 主 UNET 文件名
            "aux_unet": str,          # 辅助 UNET 文件名
            "clip": str,              # CLIP 文件名
            "vae": str,               # VAE 文件名
            "model": object,          # 加载的模型对象
            "clip_obj": object,       # CLIP 对象
            "vae_obj": object,        # VAE 对象
            "main_unet_obj": object,  # 主 UNET 对象
            "aux_unet_obj": object,   # 辅助 UNET 对象
        }

    Raises:
        FileNotFoundError: 如果任何必需模型未找到
    """
    # 1. 查找模型文件
    ckpt_name = _pick_first_available("checkpoints", ckpt_candidates, "WAN 主模型")
    main_unet_name = _pick_first_available("diffusion_models", main_unet_candidates, "WAN 主 UNET")
    aux_unet_name = _pick_first_available("diffusion_models", aux_unet_candidates, "WAN 辅助 UNET")
    clip_name = _pick_first_available("text_encoders", clip_candidates, "WAN CLIP")
    vae_name = _pick_first_available("vae", vae_candidates, "WAN VAE")

    # 2. 加载主模型
    from nodes import CheckpointLoaderSimple
    model, _, _ = CheckpointLoaderSimple().load_checkpoint(ckpt_name)

    # 3. 加载 CLIP
    clip_path = folder_paths.get_full_path_or_raise("text_encoders", clip_name)
    clip_obj = comfy.sd.load_clip(
        ckpt_paths=[clip_path],
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
        clip_type=comfy.sd.CLIPType.STABLE_DIFFUSION,
    )

    # 4. 加载 VAE
    vae_path = folder_paths.get_full_path_or_raise("vae", vae_name)
    sd, metadata = comfy.utils.load_torch_file(vae_path, return_metadata=True)
    vae_obj = comfy.sd.VAE(sd=sd, metadata=metadata, dtype=None)
    vae_obj.throw_exception_if_invalid()

    # 5. 加载主 UNET
    main_unet_path = folder_paths.get_full_path_or_raise("diffusion_models", main_unet_name)
    main_unet_obj = comfy.sd.load_diffusion_model(main_unet_path)

    # 6. 加载辅助 UNET
    aux_unet_path = folder_paths.get_full_path_or_raise("diffusion_models", aux_unet_name)
    aux_unet_obj = comfy.sd.load_diffusion_model(aux_unet_path)

    return {
        "ckpt": ckpt_name,
        "main_unet": main_unet_name,
        "aux_unet": aux_unet_name,
        "clip": clip_name,
        "vae": vae_name,
        "model": model,
        "clip_obj": clip_obj,
        "vae_obj": vae_obj,
        "main_unet_obj": main_unet_obj,
        "aux_unet_obj": aux_unet_obj,
    }


# ============================================================================
# 通用工具函数
# ============================================================================

def gjjutils_detect_model_family(ckpt_name: str) -> str | None:
    """根据检查点文件名检测模型族。

    Args:
        ckpt_name: 检查点文件名

    Returns:
        模型族标识 ("ltx", "wan", "flux", etc.)，未识别返回 None
    """
    normalized = ckpt_name.lower().replace("_", "").replace("-", "").replace(".", "")

    if "ltx" in normalized or "ltx23" in normalized:
        return "ltx"
    elif "wan" in normalized or "wan2" in normalized:
        return "wan"
    elif "flux" in normalized or "flux1" in normalized or "flux2" in normalized:
        return "flux"
    elif "hidream" in normalized:
        return "hidream"
    elif "qwen" in normalized:
        return "qwen"

    return None


def gjjutils_get_model_loader(model_family: str):
    """根据模型族标识获取对应的加载器函数。

    Args:
        model_family: 模型族标识 ("ltx", "wan", etc.)

    Returns:
        对应的加载器函数，未找到返回 None

    Example:
        >>> loader = gjjutils_get_model_loader("ltx")
        >>> models = loader()  # 调用加载器
    """
    loaders = {
        "ltx": gjjutils_load_ltx23_models,
        "wan": gjjutils_load_wan22_models,
    }

    return loaders.get(model_family.lower())


# ============================================================================
# 通用模型加载函数（从 gjj_lazy_Image_studio 迁移）
# ============================================================================

DEFAULT_UNET_DTYPE = "default"


def _normalize_text(value: str | None) -> str:
    """规范化文本（转小写）。"""
    return str(value or "").strip().lower()


def _canonical_model_text(text: str) -> str:
    """获取模型的规范化文本。"""
    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _dedupe_keep_order(values: list[str]) -> list[str]:
    """去重并保持顺序。"""
    result: list[str] = []
    seen: set[str] = set()
    for item in values:
        value = str(item or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _build_unet_model_options(unet_dtype: str) -> dict[str, Any]:
    """构建 UNET 模型选项。"""
    dtype_map = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
        "fp8_e4m3fn": torch.float8_e4m3fn,
        "fp8_e5m2": torch.float8_e5m2,
    }
    normalized = _normalize_text(unet_dtype)
    if normalized == "default" or normalized not in dtype_map:
        return {}
    return {"dtype": dtype_map[normalized]}


def _resolve_full_path(categories: tuple[str, ...], filename: str) -> str:
    """解析模型的完整路径。"""
    if not str(filename or "").strip():
        raise RuntimeError("模型文件名不能为空。")

    last_error: Exception | None = None
    for category in categories:
        try:
            return folder_paths.get_full_path_or_raise(category, filename)
        except Exception as exc:
            last_error = exc

    if last_error is not None:
        raise last_error
    raise RuntimeError(f"未找到模型文件：{filename}")


def _format_model_missing_error(
    label: str, filename: str, categories: tuple[str, ...], exc: Exception | None = None
) -> RuntimeError:
    """格式化模型缺失错误信息。"""
    model_dirs = " / ".join(f"models\\{category}" for category in categories)
    detail = f"\n详细错误：{exc}" if exc else ""
    return RuntimeError(
        f"缺少{label}模型。\n"
        f"当前选择：{filename or '[未填写]'}\n"
        f"查找目录：{model_dirs}{detail}"
    )


def _format_runtime_error(stage: str, exc: Exception) -> RuntimeError:
    """格式化运行时错误信息。"""
    return RuntimeError(f"{stage}失败。\n详细错误：{exc}")


def _clip_type_enum(name: str):
    """获取 CLIP 类型枚举值。"""
    return getattr(
        comfy.sd.CLIPType, str(name or "").upper(), comfy.sd.CLIPType.STABLE_DIFFUSION
    )


def gjjutils_load_vae(vae_name: str):
    """加载 VAE 模型。

    Args:
        vae_name: VAE 模型文件名

    Returns:
        加载的 VAE 对象

    Example:
        >>> vae = gjjutils_load_vae("flux2-vae.safetensors")
    """
    try:
        vae_path = _resolve_full_path(("vae",), vae_name)
    except Exception as exc:
        raise _format_model_missing_error("VAE", vae_name, ("vae",), exc) from exc

    sd, metadata = comfy.utils.load_torch_file(vae_path, return_metadata=True)
    try:
        vae = comfy.sd.VAE(sd=sd, metadata=metadata, dtype=None)
        vae.throw_exception_if_invalid()
        return vae
    except Exception as exc:
        requested_canonical = _canonical_model_text(vae_name)
        if requested_canonical == _canonical_model_text(
            "full_encoder_small_decoder.safetensors"
        ):
            for fallback_name in ("flux2-vae.safetensors", "Flux2-DEV-ae.safetensors"):
                try:
                    fallback_path = _resolve_full_path(("vae",), fallback_name)
                    fallback_sd, fallback_metadata = comfy.utils.load_torch_file(
                        fallback_path, return_metadata=True
                    )
                    vae = comfy.sd.VAE(
                        sd=fallback_sd, metadata=fallback_metadata, dtype=None
                    )
                    vae.throw_exception_if_invalid()
                    return vae
                except Exception:
                    pass
            raise RuntimeError(
                "当前 ComfyUI 核心无法加载 full_encoder_small_decoder.safetensors，且可回退的 Flux2 VAE 也不可用。"
                "请升级 ComfyUI，或改用 flux2-vae.safetensors / Flux2-DEV-ae.safetensors。"
            ) from exc
        raise _format_runtime_error("VAE 加载", exc) from exc


def gjjutils_load_model(unet_name: str, unet_dtype: str = DEFAULT_UNET_DTYPE):
    """加载 UNET 扩散模型。

    Args:
        unet_name: UNET 模型文件名
        unet_dtype: UNET 数据类型

    Returns:
        加载的 UNET 模型对象

    Example:
        >>> model = gjjutils_load_model("flux-2-klein-9b-nvfp4.safetensors", "default")
    """
    try:
        unet_path = _resolve_full_path(("diffusion_models", "checkpoints"), unet_name)
    except Exception as exc:
        raise _format_model_missing_error(
            "UNET", unet_name, ("diffusion_models", "checkpoints"), exc
        ) from exc

    try:
        return comfy.sd.load_diffusion_model(
            unet_path, model_options=_build_unet_model_options(unet_dtype)
        )
    except Exception as exc:
        raise _format_runtime_error("UNET 加载", exc) from exc


def gjjutils_load_clip_from_names(clip_names: list[str], clip_type: str):
    """从名称列表加载 CLIP 文本编码器。

    Args:
        clip_names: CLIP 模型文件名列表
        clip_type: CLIP 类型（如 "stable_diffusion", "flux", "qwen_image" 等）

    Returns:
        加载的 CLIP 对象

    Example:
        >>> clip = gjjutils_load_clip_from_names(
        ...     ["qwen_2.5_vl_7b_fp8_scaled.safetensors"],
        ...     "qwen_image"
        ... )
    """
    clean_names = [
        str(name or "").strip() for name in clip_names if str(name or "").strip()
    ]
    if not clean_names:
        raise RuntimeError("至少需要一个文本编码器模型。")

    try:
        clip_paths = [
            _resolve_full_path(("text_encoders", "clip"), name) for name in clean_names
        ]
    except Exception as exc:
        raise _format_model_missing_error(
            "CLIP", " + ".join(clean_names), ("text_encoders", "clip"), exc
        ) from exc

    try:
        embedding_directory = folder_paths.get_folder_paths("embeddings")
    except Exception:
        embedding_directory = []

    normalized_type = _normalize_text(clip_type)
    try:
        if normalized_type == "hidream":
            return comfy.sd.load_clip(
                ckpt_paths=clip_paths,
                embedding_directory=embedding_directory,
                model_options={},
            )
        return comfy.sd.load_clip(
            ckpt_paths=clip_paths,
            embedding_directory=embedding_directory,
            clip_type=_clip_type_enum(clip_type),
            model_options={},
        )
    except Exception as exc:
        raise _format_runtime_error("CLIP 加载", exc) from exc


# ============================================================================
# 额外常量（从 gjj_lazy_Image_studio 迁移）
# ============================================================================

DEFAULT_UNET_NAME = "flux-2-klein-9b-nvfp4.safetensors"
DEFAULT_LIGHTNING_LORA = ""
DEFAULT_NSFW_LORA = ""


def gjjutils_apply_cfg_norm(model, strength: float):
    """应用 CFG 规范化到模型。

    Args:
        model: 模型对象
        strength: 强度值

    Returns:
        补丁后的模型
    """
    if abs(float(strength)) <= 1e-6:
        return model
    patched = model.clone()

    def cfg_norm(args):
        cond_p = args["cond_denoised"]
        pred_text = args["denoised"]
        norm_full_cond = torch.norm(cond_p, dim=1, keepdim=True)
        norm_pred_text = torch.norm(pred_text, dim=1, keepdim=True)
        scale = (norm_full_cond / (norm_pred_text + 1e-8)).clamp(min=0.0, max=1.0)
        return pred_text * scale * float(strength)

    patched.set_model_sampler_post_cfg_function(cfg_norm)
    return patched


def gjjutils_patch_model_sampling(model, sampling_mode: str, shift: float):
    """修补模型采样参数。

    Args:
        model: 模型对象
        sampling_mode: 采样模式（如 "aura", "sd3"）
        shift: 偏移量

    Returns:
        补丁后的模型
    """
    mode = _normalize_text(sampling_mode)
    if not mode or abs(float(shift)) <= 1e-6:
        return model
    patched = model.clone()
    if mode == "aura":
        sampling_base = comfy.model_sampling.ModelSamplingDiscreteFlow
        sampling_type = comfy.model_sampling.CONST
        multiplier = 1.0
    elif mode == "sd3":
        sampling_base = comfy.model_sampling.ModelSamplingDiscreteFlow
        sampling_type = comfy.model_sampling.CONST
        multiplier = 1000.0
    else:
        return model

    class ModelSamplingAdvanced(sampling_base, sampling_type):
        pass

    model_sampling = ModelSamplingAdvanced(patched.model.model_config)
    model_sampling.set_parameters(shift=float(shift), multiplier=multiplier)
    patched.add_object_patch("model_sampling", model_sampling)
    return patched
