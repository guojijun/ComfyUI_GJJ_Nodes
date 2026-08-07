from __future__ import annotations

import logging
import inspect
import re
from typing import Any

import torch

import comfy.model_management
import comfy.utils


log = logging.getLogger(__name__)

MIXED_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
REFERENCE_IMAGE_TYPE = MIXED_IMAGE_TYPE
REF_PREFIX = "reference_image_"
FRAME_QUEUE_REQUIREMENT = "本节点只接收已经解码好的 IMAGE / GJJ_BATCH_IMAGE 帧队列；视频文件解码请放在上游视频加载节点完成。"


class FlexibleReferenceInputs(dict):
    def __getitem__(self, key):
        if _reference_index(key) is not None:
            return _ref_optional_input(_reference_index(key))
        return super().__getitem__(key)

    def __contains__(self, key):
        return _reference_index(key) is not None or super().__contains__(key)


def _reference_index(name: Any) -> int | None:
    match = re.match(rf"^(?:reference_images\.)?{re.escape(REF_PREFIX)}(\d+)$", str(name or ""))
    if not match:
        return None
    try:
        return int(match.group(1))
    except Exception:
        return None


def _conditioning_set_values(conditioning: Any, values: dict[str, Any]) -> Any:
    out = []
    for item in conditioning or []:
        if isinstance(item, (list, tuple)) and len(item) == 2:
            cond, pooled = item
            data = dict(pooled)
            data.update(values)
            out.append([cond, data])
        else:
            out.append(item)
    return out


def _resize_long_edge(image: torch.Tensor, max_size: int, stride: int = 16) -> torch.Tensor:
    h, w = int(image.shape[1]), int(image.shape[2])
    scale = min(float(max_size) / max(h, w), 1.0)
    nh = max(stride, round(h * scale / stride) * stride)
    nw = max(stride, round(w * scale / stride) * stride)
    return comfy.utils.common_upscale(image[:, :, :, :3].movedim(-1, 1), nw, nh, "area", "disabled").movedim(1, -1)


def _as_bhwc_tensor(value: Any) -> torch.Tensor | None:
    if value is None:
        return None
    if isinstance(value, torch.Tensor):
        tensor = value
    elif isinstance(value, dict):
        tensor = None
        for key in ("images", "frames", "image", "samples"):
            if isinstance(value.get(key), torch.Tensor):
                tensor = value.get(key)
                break
        if tensor is None:
            return None
    elif isinstance(value, (list, tuple)):
        tensors = [_as_bhwc_tensor(item) for item in value]
        tensors = [item for item in tensors if item is not None]
        return torch.cat(tensors, dim=0) if tensors else None
    else:
        return None

    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        return None
    if int(tensor.shape[0]) <= 0 or int(tensor.shape[1]) <= 0 or int(tensor.shape[2]) <= 0:
        return None
    if int(tensor.shape[-1]) < 3:
        return None
    return tensor[..., :3].float().clamp(0.0, 1.0).contiguous()


def _image_frames(value: Any) -> list[torch.Tensor]:
    tensor = _as_bhwc_tensor(value)
    if tensor is None:
        return []
    return [tensor[index : index + 1].contiguous() for index in range(int(tensor.shape[0]))]


def _reference_inputs(kwargs: dict[str, Any]) -> list[torch.Tensor]:
    refs: list[torch.Tensor] = []
    ref_keys = sorted(
        (key for key in kwargs if _reference_index(key) is not None),
        key=lambda key: _reference_index(key) or 0,
    )
    for key in ref_keys:
        refs.extend(_image_frames(kwargs.get(key)))
    return refs


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, (list, tuple, dict)):
        return bool(value)
    return True


def _validate_connected_frame_input(label: str, value: Any) -> torch.Tensor | None:
    tensor = _as_bhwc_tensor(value)
    if tensor is None and _has_value(value):
        raise RuntimeError(
            f"{label}没有解析出有效帧队列。{FRAME_QUEUE_REQUIREMENT}\n"
            "如果上游日志出现 Invalid NAL unit size / Error splitting the input into NAL units，"
            "说明视频文件在上游解码阶段已经失败；请先用视频加载/抽帧节点确认能输出 IMAGE 帧。"
        )
    return tensor


def _encode_context_latent(vae, image: torch.Tensor) -> torch.Tensor:
    if image.ndim != 4:
        raise RuntimeError("Bernini 上下文编码需要 [帧,高,宽,通道] 的 IMAGE 帧队列。")

    device = comfy.model_management.get_torch_device()
    encode_fn = getattr(vae, "encode", None)
    is_wan_vae = False
    if callable(encode_fn):
        try:
            is_wan_vae = "device" in inspect.signature(encode_fn).parameters
        except (TypeError, ValueError):
            is_wan_vae = hasattr(vae, "model") and hasattr(vae, "z_dim")

    if is_wan_vae:
        vae_dtype = getattr(vae, "dtype", torch.bfloat16)
        video = (image[:, :, :, :3].permute(3, 0, 1, 2) * 2.0 - 1.0).to(device=device, dtype=vae_dtype)
        try:
            encoded = vae.encode([video], device, tiled=False, pbar=False)[0]
        except TypeError:
            encoded = vae.encode([video], device)[0]
        return encoded

    if callable(encode_fn) and int(getattr(vae, "latent_dim", 0) or 0) == 3:
        encoded = vae.encode(image[:, :, :, :3])
        if isinstance(encoded, torch.Tensor) and encoded.ndim == 5 and int(encoded.shape[0]) == 1:
            return encoded[0]
        if isinstance(encoded, torch.Tensor) and encoded.ndim == 4:
            return encoded
        raise RuntimeError(
            f"普通 Comfy VAE 已执行编码，但输出维度不是 Bernini/Wan 期望的 4D/5D latent：{getattr(encoded, 'shape', type(encoded))}。"
        )

    raise RuntimeError(
        "Bernini 需要 Wan 视频 VAE。可连接原版普通 VAE Loader 加载出的 Wan VAE，"
        "或连接 GJJ WanVideo VAE 加载器输出的 WANVAE。当前 VAE 不是可识别的 Wan 视频 VAE。"
    )


def _cpu_context_latent(latent: torch.Tensor) -> torch.Tensor:
    return latent.detach().to(device=torch.device("cpu")).contiguous()


def _build_bernini_context(
    vae,
    length: int,
    width: int,
    height: int,
    source_video: Any = None,
    reference_video: Any = None,
    reference_images: list[torch.Tensor] | None = None,
    reference_resources: list[torch.Tensor] | None = None,
    ref_max_size: int = 848,
) -> dict[str, Any]:
    context: dict[str, Any] = {"refs": []}
    source = _validate_connected_frame_input("源视频帧", source_video)
    if source is not None:
        vid = comfy.utils.common_upscale(
            source[: int(length), :, :, :3].movedim(-1, 1),
            int(width),
            int(height),
            "area",
            "center",
        ).movedim(1, -1)
        context["video"] = _cpu_context_latent(_encode_context_latent(vae, vid[:, :, :, :3]))

    ordered_resources = list(reference_resources or [])
    if ordered_resources:
        for resource in ordered_resources:
            frames = _validate_connected_frame_input("参考资源", resource)
            if frames is None:
                continue
            # 多帧批次使用 Bernini 参考视频语义；单帧使用参考图片语义。
            selected = frames[: int(length)] if int(frames.shape[0]) > 1 else frames[:1]
            resized = comfy.utils.common_upscale(
                selected[:, :, :, :3].movedim(-1, 1),
                int(width),
                int(height),
                "area",
                "center",
            ).movedim(1, -1)
            context["refs"].append(_cpu_context_latent(_encode_context_latent(vae, resized[:, :, :, :3])))
    else:
        ref_video = _validate_connected_frame_input("参考视频帧", reference_video)
        if ref_video is not None:
            ref_vid = comfy.utils.common_upscale(
                ref_video[: int(length), :, :, :3].movedim(-1, 1),
                int(width),
                int(height),
                "area",
                "center",
            ).movedim(1, -1)
            context["refs"].append(_cpu_context_latent(_encode_context_latent(vae, ref_vid[:, :, :, :3])))

        for img in reference_images or []:
            ref_img = comfy.utils.common_upscale(
                img[:, :, :, :3].movedim(-1, 1),
                int(width),
                int(height),
                "area",
                "center",
            ).movedim(1, -1)
            context["refs"].append(_cpu_context_latent(_encode_context_latent(vae, ref_img[:, :, :, :3])))

    return context


def _encode_bernini_reference_resources(
    vae,
    length: int,
    width: int,
    height: int,
    reference_resources: list[torch.Tensor] | None,
) -> list[torch.Tensor]:
    """Encode reusable Bernini references once for callers processing several segments."""
    if not reference_resources:
        return []
    context = _build_bernini_context(
        vae,
        length,
        width,
        height,
        reference_resources=reference_resources,
    )
    return list(context.get("refs") or [])


def _ref_optional_input(index: int):
    return (
        REFERENCE_IMAGE_TYPE,
        {
            "display_name": f"reference_image_{index}",
            "tooltip": f"可选参考图片或批量图片。支持 IMAGE 与 GJJ_BATCH_IMAGE；批量图片会在后台拆成多张参考图统一处理。{FRAME_QUEUE_REQUIREMENT}",
        },
    )


class GJJBerniniConditioning:
    CATEGORY = "GJJ/🎬 视频"
    FUNCTION = "build"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "latent")
    OUTPUT_TOOLTIPS = (
        "已附加 Bernini 上下文 latent 的正向条件。",
        "已附加同一 Bernini 上下文 latent 的负向条件，便于采样器兼容。",
        "按帧数、宽高和批次数创建的 Wan 视频 latent。",
    )
    DESCRIPTION = f"零依赖复刻 Bernini Conditioning：把已解码的视频帧和参考图片编码为上下文 latent，并写入正负条件。{FRAME_QUEUE_REQUIREMENT}"
    GJJ_HELP = (
        "使用说明：\n"
        "- 原版 Bernini 使用普通 ComfyUI VAE Loader 的 VAE 输入，并把编码后的 context_latents 写入正负 CONDITIONING。\n"
        "- 原版 ComfyUI-RH-Bernini 还依赖 bernini_patches.py 的运行时补丁，把 CONDITIONING 里的 context_latents 注入 Wan 模型；GJJ 已在本地 WanVideo 采样链路中补齐这条注入。\n"
        "- Bernini 条件节点本身不解码视频文件，也不依赖 imageio_ffmpeg / cv2 / decord。\n"
        "- 源视频帧、参考视频帧必须来自上游已成功抽帧的 IMAGE / GJJ_BATCH_IMAGE。\n"
        "- 如果上游控制台出现 Invalid NAL unit size、missing picture 或 Error splitting the input into NAL units，"
        "但预览/任意对象里已经能看到正确 IMAGE_SEQUENCE，通常不影响 Bernini 的帧输入，应优先检查 context_latents 是否被桥接和采样器保留。"
    )
    SEARCH_ALIASES = ["bernini", "bernini conditioning", "Bernini条件", "参考视频条件"]

    @classmethod
    def INPUT_TYPES(cls):
        optional = FlexibleReferenceInputs({
            "source_video": (MIXED_IMAGE_TYPE, {"display_name": "源视频帧", "tooltip": f"可选。作为要编辑或风格迁移的基础视频帧，会缩放到目标宽高。支持 IMAGE 与 GJJ_BATCH_IMAGE。{FRAME_QUEUE_REQUIREMENT}"}),
            "reference_video": (MIXED_IMAGE_TYPE, {"display_name": "参考视频帧", "tooltip": f"可选。作为视频植入或运动内容参考，会保持宽高比并限制最长边。支持 IMAGE 与 GJJ_BATCH_IMAGE。{FRAME_QUEUE_REQUIREMENT}"}),
            f"{REF_PREFIX}0": _ref_optional_input(0),
        })
        return {
            "required": {
                "positive": ("CONDITIONING", {"display_name": "正向条件", "tooltip": "来自 Wan 文本编码器的正向条件；节点会在其中附加 Bernini 上下文 latent。"}),
                "negative": ("CONDITIONING", {"display_name": "负向条件", "tooltip": "来自 Wan 文本编码器的负向条件；节点会附加同一上下文 latent 以保持采样器兼容。"}),
                "vae": ("WANVAE,VAE", {"display_name": "VAE / WANVAE", "tooltip": "连接原版普通 VAE Loader 加载出的 Wan VAE，或 GJJ WanVideo VAE 加载器输出的 WANVAE；节点会按实际编码结果判断是否可用于 Bernini。"}),
                "width": ("INT", {"default": 832, "min": 16, "max": 8192, "step": 16, "display_name": "宽度", "tooltip": "输出 latent 的像素宽度；源视频会缩放到此宽度。"}),
                "height": ("INT", {"default": 480, "min": 16, "max": 8192, "step": 16, "display_name": "高度", "tooltip": "输出 latent 的像素高度；源视频会缩放到此高度。"}),
                "length": ("INT", {"default": 81, "min": 1, "max": 8192, "step": 4, "display_name": "帧数", "tooltip": "生成或条件控制的视频帧数；源视频和参考视频会裁切到此长度。"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096, "step": 1, "display_name": "批次数", "tooltip": "创建多少个 latent 样本用于采样。"}),
                "ref_max_size": ("INT", {"default": 848, "min": 16, "max": 8192, "step": 16, "display_name": "参考最长边", "tooltip": "参考视频和参考图片的最长边上限；保持宽高比且不会放大。"}),
            },
            "optional": optional,
        }

    def build(self, positive, negative, vae, width, height, length, batch_size, ref_max_size=848, source_video=None, reference_video=None, **kwargs):
        width = int(width)
        height = int(height)
        length = int(length)
        latent = torch.zeros(
            [int(batch_size), 16, ((length - 1) // 4) + 1, height // 8, width // 8],
            device=comfy.model_management.intermediate_device(),
        )
        reference_images = _reference_inputs(kwargs)
        reference_resources = kwargs.get("reference_resources")
        encoded_reference_latents = kwargs.get("encoded_reference_latents") or []
        if any(_has_value(value) for key, value in kwargs.items() if _reference_index(key) is not None) and not reference_images:
            raise RuntimeError(f"参考图输入没有解析出有效图片。{FRAME_QUEUE_REQUIREMENT}")
        context_parts = _build_bernini_context(
            vae,
            length,
            width,
            height,
            source_video=source_video,
            reference_video=reference_video,
            reference_images=reference_images,
            reference_resources=reference_resources,
            ref_max_size=int(ref_max_size),
        )
        context = []
        context.extend(
            item for item in encoded_reference_latents
            if isinstance(item, torch.Tensor)
        )
        context.extend(context_parts.get("refs") or [])
        if "video" in context_parts:
            context.append(context_parts["video"])

        if context:
            positive = _conditioning_set_values(positive, {"context_latents": context})
            negative = _conditioning_set_values(negative, {"context_latents": context})
            shape_text = ", ".join(str(tuple(item.shape)) for item in context if isinstance(item, torch.Tensor))
            log.info("GJJ Bernini: encoded %s context latent(s): %s", len(context), shape_text or "无有效 tensor")

        wan_context = [
            item for item in context
            if isinstance(item, torch.Tensor) and item.ndim == 4 and int(item.shape[0]) in (16, 48)
        ]
        if context and not wan_context:
            raise RuntimeError(
                "Bernini 已收到参考帧，但没有生成 WanVideo 可用的 16/48 通道 context_latents。"
                "请确认 VAE 输入是 Wan 视频 VAE，而不是 SD/FLUX 等图片 VAE。"
            )
        return (positive, negative, {"samples": latent})


NODE_CLASS_MAPPINGS = {
    "GJJ_BerniniConditioning": GJJBerniniConditioning,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_BerniniConditioning": "GJJ · 🎞️ Bernini条件构建",
}
