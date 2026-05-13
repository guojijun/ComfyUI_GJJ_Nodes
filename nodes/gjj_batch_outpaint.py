# v10: unwrap comfy_api.latest.io.NodeOutput for built-in V3 nodes
from __future__ import annotations

import hashlib
import inspect
import json
import os
import re
import traceback
from pathlib import Path
from typing import Any

import comfy.utils
import folder_paths
import numpy as np
import torch
from PIL import Image, PngImagePlugin
from nodes import ImagePadForOutpaint, VAEDecode, VAEEncode

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE

NODE_NAME = "GJJ_BatchOutpaint"

# 可选：如果你把 4 个工作流 json 放在这个目录，节点会自动读取里面的模型名/参数；
# 如果目录不存在，会使用下面 BUILTIN_WORKFLOW_PRESETS 的内置参数。
WORKFLOW_DIR = Path("D:/AI/MOD/user/default/workflows/扩图")

WORKFLOW_ORDER = [
    "512-inpainting-ema扩图",
    "Flux2-klein扩图",
    "Qwen_image_edit扩图",
    "flux_fill_dev扩图",
]

WORKFLOW_LABELS = {
    "512-inpainting-ema扩图": "SD1.5 Inpainting EMA",
    "Flux2-klein扩图": "Flux2 Klein",
    "Qwen_image_edit扩图": "Qwen Image Edit",
    "flux_fill_dev扩图": "Flux Fill Dev",
}

WORKFLOW_FILE_LABELS = {
    "512-inpainting-ema扩图": "SD15_Inpaint",
    "Flux2-klein扩图": "Flux2_Klein",
    "Qwen_image_edit扩图": "Qwen_Edit",
    "flux_fill_dev扩图": "Flux_Fill",
}


def _workflow_file_label(key: str) -> str:
    return WORKFLOW_FILE_LABELS.get(
        str(key or ""),
        re.sub(r"[^0-9A-Za-z_\-]+", "_", str(key or "workflow")).strip("_")
        or "workflow",
    )


# 根据你上传的 4 个工作流提取出的默认参数。
BUILTIN_WORKFLOW_PRESETS: dict[str, dict[str, Any]] = {
    "512-inpainting-ema扩图": {
        "key": "512-inpainting-ema扩图",
        "label": "SD1.5 Inpainting EMA",
        "checkpoint": "512-inpainting-ema.safetensors",
        "prompt": "a close-up of a delicate pink rose with velvety petals,reflecting soft ambient light,Dark green-toned light\n\nThe background consists of blurred pink roses and green foliage, creating a dreamy and harmonious depth. \n\n(soft lighting, dim background, cinematic lighting, realistic shading, gentle contrast, warm tones), ",
        "negative": "watermark, text",
        "steps": 20,
        "cfg": 7.0,
        "sampler": "dpmpp_2m",
        "scheduler": "karras",
        "denoise": 1.0,
        "feathering": 10,
        "grow_mask_by": 10,
    },
    "Flux2-klein扩图": {
        "key": "Flux2-klein扩图",
        "label": "Flux2 Klein",
        "unet": "flux-2-klein-base-9b.safetensors",
        "unet_dtype": "default",
        "clip": "qwen_3_8b.safetensors",
        "clip_type": "flux2",
        "vae": "flux2-vae.safetensors",
        "prompt": "移除蓝色区域，同时保持图像的其余部分不变",
        "negative": "",
        "steps": 6,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "simple",
        "denoise": 1.0,
        "feathering": 100,
        "use_flux_kontext_scale": True,
        "use_alpha_composite": True,
    },
    "Qwen_image_edit扩图": {
        "key": "Qwen_image_edit扩图",
        "label": "Qwen Image Edit",
        "unet": "qwen_image_edit_2511_fp8mixed.safetensors",
        "unet_dtype": "default",
        "clip": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
        "clip_type": "qwen_image",
        "vae": "qwen_image_vae.safetensors",
        "lora": "QWEN\\lighting\\Qwen-Image-Lightning-4steps-V2.0.safetensors",
        "lora_strength": 1.0,
        "shift": 3.1,
        "cfg_norm_strength": 1.0,
        "prompt": "移除灰色块区域",
        "negative": "",
        "steps": 4,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "simple",
        "denoise": 1.0,
        "feathering": 255,
        "largest_size": 1248,
        "upscale_method": "area",
    },
    "flux_fill_dev扩图": {
        "key": "flux_fill_dev扩图",
        "label": "Flux Fill Dev",
        "unet": "flux1-fill-dev_fp8.safetensors",
        "unet_dtype": "fp8_e4m3fn",
        "clip1": "clip_l.safetensors",
        "clip2": "t5xxl_fp16.safetensors",
        "clip_type": "flux",
        "vae": "ae.safetensors",
        "prompt": "Put the incomplete graph blueprint in front, let the AI fully complete all missing nodes, connections and layout strictly following the original style, keep the same visual logic, node type and arrangement rules without changing the existing content.",
        "negative": "",
        "steps": 20,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "normal",
        "denoise": 1.0,
        "feathering": 24,
        "guidance": 30.0,
        "differential_strength": 1.0,
        "noise_mask": False,
    },
}

OUTPAINT_MODES = ("像素扩图", "目标尺寸")
DIRECTIONS = ("居中扩展", "向右扩展", "向左扩展", "向上扩展", "向下扩展")

DEFAULT_LEFT = 60
DEFAULT_RIGHT = 60
DEFAULT_TOP = 60
DEFAULT_BOTTOM = 60
DEFAULT_TARGET_WIDTH = 768
DEFAULT_TARGET_HEIGHT = 1024
DEFAULT_DIRECTION = "居中扩展"
DEFAULT_SEED = 0
DEFAULT_PROMPT = ""
DEFAULT_STEPS = 20
DEFAULT_CFG = 1.0
DEFAULT_DENOISE = 1.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "normal"

RED = "\033[91m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload: dict[str, Any] = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _send_error(
    unique_id: Any, title: str, message: str, install_command: str = ""
) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_batch_outpaint_error",
            {
                "node": str(unique_id),
                "title": str(title),
                "message": str(message),
                "install_command": str(install_command),
            },
        )
    except Exception:
        pass


def _try_import(class_name: str, modules: tuple[str, ...]) -> Any | None:
    """
    解析 ComfyUI 原生节点类。

    关键点：
    很多“原生节点”在工作流里能用，但并不是 nodes.py 的同名 Python 属性，
    而是注册在 nodes.NODE_CLASS_MAPPINGS 里。embedded_docs 只是文档目录，
    不能作为 import 路径。

    所以必须优先从 NODE_CLASS_MAPPINGS 按工作流 node.type 查找，
    再尝试传统模块 import。
    """
    try:
        from nodes import NODE_CLASS_MAPPINGS

        obj = NODE_CLASS_MAPPINGS.get(class_name)
        if obj is not None:
            return obj
    except Exception:
        pass

    for module_name in modules:
        try:
            module = __import__(module_name, fromlist=[class_name])
            obj = getattr(module, class_name, None)
            if obj is not None:
                return obj
        except Exception:
            continue

    return None


def _try_import_conditioning_zero_out() -> Any | None:
    return _try_import("ConditioningZeroOut", ("comfy_extras.nodes_cond", "nodes"))


def _try_import_model_sampling_aura_flow() -> Any | None:
    return _try_import(
        "ModelSamplingAuraFlow",
        ("comfy_extras.nodes_model_advanced", "comfy_extras.nodes_flux", "nodes"),
    )


def _try_import_reference_latent() -> Any | None:
    return _try_import("ReferenceLatent", ("nodes", "comfy_extras.nodes_flux"))


def _require(obj: Any | None, message: str) -> Any:
    if obj is None:
        raise RuntimeError(message)
    return obj


def _is_model_like(obj: Any) -> bool:
    """KSampler 需要真实 MODEL 对象，不能是新版节点系统的 NodeOutput 包装。"""
    return (
        hasattr(obj, "get_model_object")
        or hasattr(obj, "model")
        or obj.__class__.__name__ in {"ModelPatcher"}
    )


def _looks_like_node_output(obj: Any) -> bool:
    name = obj.__class__.__name__ if obj is not None else ""
    return name == "NodeOutput" or (
        hasattr(obj, "node") and hasattr(obj, "output_index")
    )


def _unpack_node_output(out: Any) -> tuple[Any, ...]:
    """
    兼容 ComfyUI V3 / comfy_api.latest 的 io.NodeOutput。

    新版原生节点例如 CFGNorm、DifferentialDiffusion、FluxKontextImageScale
    直接调用 execute/patch/scale 时，返回的不是普通 tuple，而是 NodeOutput。
    NodeOutput 的真实数据在 .args 里；如果不展开，后面会把 NodeOutput 当成 MODEL/IMAGE，
    造成模型分支效果错误或提示“返回 NodeOutput 包装对象”。
    """
    if out is None:
        return (None,)
    if isinstance(out, tuple):
        return out
    if _looks_like_node_output(out) and hasattr(out, "args"):
        args = getattr(out, "args", ())
        if isinstance(args, tuple):
            return args
        if isinstance(args, list):
            return tuple(args)
        return (args,)
    return (out,)


def _maybe_use_model_result(original_model: Any, candidate: Any, node_name: str) -> Any:
    """
    某些新版本/自定义节点直接调用会返回 NodeOutput，而不是实际 MODEL。
    这种对象不能喂给 KSampler，所以这里自动跳过该补丁节点，保留原模型继续跑。
    """
    if candidate is None:
        return original_model
    if _looks_like_node_output(candidate):
        print(
            f"{YELLOW}[GJJ] {node_name} 返回 NodeOutput 包装对象，直接调用无法展开，已跳过该节点。{RESET}"
        )
        return original_model
    if _is_model_like(candidate):
        return candidate
    print(
        f"{YELLOW}[GJJ] {node_name} 返回的不是可采样 MODEL：{candidate.__class__.__name__}，已跳过。{RESET}"
    )
    return original_model


def _normalize_conditioning(conditioning: Any) -> Any:
    """
    Comfy conditioning 标准结构是 [[tensor, dict], ...]。
    有些节点/版本可能返回 tuple、NodeOutput、[tensor]、[[tensor]]，
    InpaintModelConditioning 会直接访问 t[1].copy()，所以这里必须把每项补成二元结构。
    """
    if isinstance(conditioning, tuple) and len(conditioning) == 1:
        conditioning = conditioning[0]
    if not isinstance(conditioning, list):
        return conditioning

    fixed = []
    changed = False
    for item in conditioning:
        if isinstance(item, (list, tuple)):
            if len(item) >= 2 and isinstance(item[1], dict):
                fixed.append([item[0], dict(item[1])])
                if not isinstance(item, list):
                    changed = True
            elif len(item) == 1 and torch.is_tensor(item[0]):
                fixed.append([item[0], {}])
                changed = True
            elif len(item) >= 1 and torch.is_tensor(item[0]):
                fixed.append([item[0], {}])
                changed = True
            else:
                fixed.append(item)
        elif torch.is_tensor(item):
            fixed.append([item, {}])
            changed = True
        else:
            fixed.append(item)
    return fixed if changed else conditioning


def _node_call(node: Any, *fallback_args: Any, **kwargs: Any) -> tuple[Any, ...]:
    """兼容不同 ComfyUI 版本的节点调用。优先按函数签名传关键字，失败后再用位置参数。"""
    fn_name = getattr(node, "FUNCTION", None)
    candidates = []
    if fn_name and hasattr(node, fn_name):
        candidates.append(getattr(node, fn_name))
    for name in (
        "execute",
        "generate",
        "encode",
        "decode",
        "sample",
        "patch",
        "apply",
        "scale",
        "upscale",
        "composite",
        "join_image_with_alpha",
        "expand_image",
        "load_unet",
        "load_clip",
        "load_vae",
        "load_lora_model_only",
        "zero_out",
    ):
        if hasattr(node, name):
            fn = getattr(node, name)
            if fn not in candidates:
                candidates.append(fn)

    last_error: Exception | None = None
    for fn in candidates:
        try:
            sig = inspect.signature(fn)
            accepted: dict[str, Any] = {}
            has_var_kw = any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
            )
            for key, value in kwargs.items():
                if has_var_kw or key in sig.parameters:
                    accepted[key] = value
            if accepted:
                out = fn(**accepted)
            else:
                out = fn(*fallback_args)
            return _unpack_node_output(out)
        except TypeError as exc:
            last_error = exc
            try:
                out = fn(*fallback_args)
                return _unpack_node_output(out)
            except Exception as exc2:
                last_error = exc2
        except Exception as exc:
            last_error = exc
    if last_error is not None:
        raise last_error
    raise RuntimeError(f"无法调用节点：{node.__class__.__name__}")


def _call_method(
    obj: Any, method_names: tuple[str, ...], *args: Any, **kwargs: Any
) -> tuple[Any, ...]:
    last_error: Exception | None = None
    for name in method_names:
        fn = getattr(obj, name, None)
        if fn is None:
            continue
        try:
            out = fn(*args, **kwargs)
            return _unpack_node_output(out)
        except TypeError as exc:
            last_error = exc
            try:
                out = fn(*args)
                return _unpack_node_output(out)
            except Exception as exc2:
                last_error = exc2
        except Exception as exc:
            last_error = exc
    if last_error is not None:
        raise last_error
    raise RuntimeError(f"找不到可用方法：{obj.__class__.__name__}.{method_names}")


def _ensure_image_batch(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise RuntimeError("批量扩图需要接入有效的图片张量。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise RuntimeError(f"批量扩图收到不支持的图片维度：{tuple(image.shape)}")
    if int(image.shape[0]) <= 0:
        raise RuntimeError("批量扩图至少需要一张图片。")
    image = image.detach().float()
    channels = int(image.shape[-1])
    if channels == 1:
        image = image.repeat(1, 1, 1, 3)
    elif channels >= 3:
        image = image[..., :3]
    else:
        raise RuntimeError(f"批量扩图收到不支持的通道数：{channels}")
    return image.clamp(0.0, 1.0).contiguous()


def _split_images(image: torch.Tensor) -> list[torch.Tensor]:
    batch = _ensure_image_batch(image)
    return [batch[i : i + 1].contiguous() for i in range(int(batch.shape[0]))]


def _resize_image_exact(
    image: torch.Tensor, width: int, height: int, method: str = "lanczos"
) -> torch.Tensor:
    image = _ensure_image_batch(image)
    width = max(8, int(width))
    height = max(8, int(height))
    samples = image.movedim(-1, 1)
    scaled = comfy.utils.common_upscale(
        samples, width, height, str(method or "lanczos"), "disabled"
    )
    return scaled.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _resize_to_max_dimension(
    image: torch.Tensor, largest_size: int, method: str = "area"
) -> torch.Tensor:
    image = _ensure_image_batch(image)
    largest_size = int(largest_size or 0)
    if largest_size <= 0:
        return image
    h = int(image.shape[1])
    w = int(image.shape[2])
    current = max(w, h)
    if current <= largest_size:
        return image
    scale = largest_size / current
    new_w = _round_to_8(max(8, int(round(w * scale))))
    new_h = _round_to_8(max(8, int(round(h * scale))))
    return _resize_image_exact(image, new_w, new_h, method)


def _round_to_8(value: int) -> int:
    return max(8, ((int(value) + 7) // 8) * 8)


def _calculate_padding_pixel(
    left: int, right: int, top: int, bottom: int
) -> dict[str, int]:
    return {
        "left": max(0, int(left)),
        "right": max(0, int(right)),
        "top": max(0, int(top)),
        "bottom": max(0, int(bottom)),
    }


def _calculate_padding_target_size(
    image: torch.Tensor, target_width: int, target_height: int, direction: str
) -> tuple[torch.Tensor, dict[str, int]]:
    image = _ensure_image_batch(image)
    h = int(image.shape[1])
    w = int(image.shape[2])
    target_w = _round_to_8(target_width)
    target_h = _round_to_8(target_height)

    if target_w <= 0 or target_h <= 0:
        raise RuntimeError("目标宽高必须大于 0。")

    resized = image
    if target_w < w or target_h < h:
        scale = min(target_w / w, target_h / h)
        new_w = min(target_w, _round_to_8(max(8, int(w * scale))))
        new_h = min(target_h, _round_to_8(max(8, int(h * scale))))
        resized = _resize_image_exact(image, new_w, new_h)
        h = int(resized.shape[1])
        w = int(resized.shape[2])

    dw = max(0, target_w - w)
    dh = max(0, target_h - h)

    if direction in ("居中扩展", "center"):
        left = dw // 2
        right = dw - left
        top = dh // 2
        bottom = dh - top
    elif direction in ("向右扩展", "right"):
        left = 0
        right = dw
        top = dh // 2
        bottom = dh - top
    elif direction in ("向左扩展", "left"):
        left = dw
        right = 0
        top = dh // 2
        bottom = dh - top
    elif direction in ("向上扩展", "up"):
        left = dw // 2
        right = dw - left
        top = dh
        bottom = 0
    elif direction in ("向下扩展", "down"):
        left = dw // 2
        right = dw - left
        top = 0
        bottom = dh
    else:
        left = dw // 2
        right = dw - left
        top = dh // 2
        bottom = dh - top

    return resized, {"left": left, "right": right, "top": top, "bottom": bottom}


def _apply_padding(
    image: torch.Tensor, padding: dict[str, int], feathering: int = 24
) -> tuple[torch.Tensor, torch.Tensor]:
    image = _ensure_image_batch(image)
    left = int(padding.get("left", 0))
    right = int(padding.get("right", 0))
    top = int(padding.get("top", 0))
    bottom = int(padding.get("bottom", 0))
    feathering = max(0, int(feathering))

    if left == 0 and right == 0 and top == 0 and bottom == 0:
        h = int(image.shape[1])
        w = int(image.shape[2])
        mask = torch.zeros((1, h, w), dtype=torch.float32, device=image.device)
        return image, mask

    try:
        expanded, mask = ImagePadForOutpaint().expand_image(
            image, left, top, right, bottom, feathering
        )
        return _ensure_image_batch(expanded), mask.float().clamp(0.0, 1.0).contiguous()
    except Exception as exc:
        raise RuntimeError(f"图像扩边失败：{exc}") from exc


def _empty_image_like(image: torch.Tensor, color: int = 255) -> torch.Tensor:
    image = _ensure_image_batch(image)
    value = max(0.0, min(1.0, float(color) / 255.0))
    return torch.full_like(image, value)


def _composite_masked(
    destination: torch.Tensor, source: torch.Tensor, mask: torch.Tensor
) -> torch.Tensor:
    destination = _ensure_image_batch(destination)
    source = _ensure_image_batch(source)
    if source.shape[1:3] != destination.shape[1:3]:
        source = _resize_image_exact(
            source, int(destination.shape[2]), int(destination.shape[1])
        )
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    if mask.ndim == 3:
        mask4 = mask.unsqueeze(-1)
    elif mask.ndim == 4:
        mask4 = mask[..., :1]
    else:
        raise RuntimeError(f"遮罩维度不支持：{tuple(mask.shape)}")
    mask4 = mask4.to(device=destination.device, dtype=destination.dtype).clamp(0.0, 1.0)
    if mask4.shape[1:3] != destination.shape[1:3]:
        mask4 = torch.nn.functional.interpolate(
            mask4.movedim(-1, 1), size=destination.shape[1:3], mode="nearest"
        ).movedim(1, -1)
    return (destination * (1.0 - mask4) + source * mask4).clamp(0.0, 1.0).contiguous()


def _flux2_reference_image_exact(
    padded: torch.Tensor, mask: torch.Tensor
) -> torch.Tensor:
    """
    严格贴近 Flux2-klein扩图.json 的参考图链：

    ImagePadForOutpaint IMAGE/MASK
      -> GetImageSize
      -> EmptyImage(width, height, batch_size=1, color=255)
      -> JoinImageWithAlpha(empty, mask)
      -> ImageCompositeMasked(destination=padded, source=joined_rgba, mask=mask, x=0, y=0, resize_source=False)
      -> FluxKontextImageScale

    之前代码用 torch 手写白图混合，没有经过 JoinImageWithAlpha / ImageCompositeMasked 原生逻辑，
    这会让 Flux2 看到的参考图和 JSON 工作流不一致，输出就会不像原图。
    """
    padded = _ensure_image_batch(padded)
    h = int(padded.shape[1])
    w = int(padded.shape[2])

    EmptyImage = _try_import("EmptyImage", ("nodes",))
    JoinImageWithAlpha = _try_import("JoinImageWithAlpha", ("nodes",))
    ImageCompositeMasked = _try_import("ImageCompositeMasked", ("nodes",))

    try:
        if (
            EmptyImage is None
            or JoinImageWithAlpha is None
            or ImageCompositeMasked is None
        ):
            raise RuntimeError(
                "EmptyImage / JoinImageWithAlpha / ImageCompositeMasked 有节点未找到"
            )

        empty = _node_call(
            EmptyImage(),
            width=w,
            height=h,
            batch_size=1,
            color=255,
        )[0]
        empty = _ensure_image_batch(empty)

        joined = _node_call(
            JoinImageWithAlpha(),
            image=empty,
            alpha=mask,
        )[0]

        composed = _node_call(
            ImageCompositeMasked(),
            destination=padded,
            source=joined,
            mask=mask,
            x=0,
            y=0,
            resize_source=False,
        )[0]
        composed = _ensure_image_batch(composed)

        print(
            f"{GREEN}[GJJ] Flux2 原生参考图链已生效：EmptyImage -> JoinImageWithAlpha -> ImageCompositeMasked -> FluxKontextImageScale{RESET}"
        )
        return _apply_flux_kontext_scale(composed)

    except Exception as exc:
        print(f"{YELLOW}[GJJ] Flux2 原生参考图链调用失败，回退旧混合逻辑：{exc}{RESET}")
        white = _empty_image_like(padded, 255)
        ref_image = _composite_masked(padded, white, mask)
        return _apply_flux_kontext_scale(ref_image)


def _apply_flux_kontext_scale(image: torch.Tensor) -> torch.Tensor:
    FluxKontextImageScale = _try_import(
        "FluxKontextImageScale", ("comfy_extras.nodes_flux", "nodes")
    )
    if FluxKontextImageScale is None:
        return image
    try:
        out = _node_call(FluxKontextImageScale(), image=image)
        for item in out:
            if isinstance(item, torch.Tensor):
                return _ensure_image_batch(item)
        print(
            f"{YELLOW}[GJJ] FluxKontextImageScale 没有返回 IMAGE 张量，改用原图。{RESET}"
        )
        return image
    except Exception as exc:
        print(f"{YELLOW}[GJJ] FluxKontextImageScale 调用失败，改用原图：{exc}{RESET}")
        return image


def _encode_vae(vae: Any, image: torch.Tensor) -> dict[str, torch.Tensor]:
    latent = VAEEncode().encode(vae, image)[0]
    if not isinstance(latent, dict):
        raise RuntimeError("VAEEncode 输出不是 LATENT 字典。")
    return latent


def _conditioning_set_values_manual(conditioning: Any, values: dict[str, Any]) -> Any:
    """手动等价于 node_helpers.conditioning_set_values，但先修复 CONDITIONING 结构。"""
    conditioning = _normalize_conditioning(conditioning)
    if not isinstance(conditioning, list):
        return conditioning
    fixed = []
    for item in conditioning:
        if (
            isinstance(item, (list, tuple))
            and len(item) >= 1
            and torch.is_tensor(item[0])
        ):
            meta = dict(item[1]) if len(item) >= 2 and isinstance(item[1], dict) else {}
            meta.update(values)
            fixed.append([item[0], meta])
        elif torch.is_tensor(item):
            fixed.append([item, dict(values)])
        else:
            fixed.append(item)
    return fixed


def _append_reference_latent(conditioning: Any, latent: dict[str, torch.Tensor]) -> Any:
    """
    不再直接调用 ReferenceLatent 节点。

    直接调用新版节点时有些环境会返回 NodeOutput 或触发 list index out of range；
    但 Flux2/Qwen 采样真正需要的是 conditioning meta 里的 ref_latents: [Tensor]。
    这里手动写入，避免把 LATENT dict 传进去导致后面 a.size() 报错。
    """
    conditioning = _normalize_conditioning(conditioning)
    samples = None
    if isinstance(latent, dict) and torch.is_tensor(latent.get("samples")):
        samples = latent["samples"]
    elif torch.is_tensor(latent):
        samples = latent
    if samples is None:
        raise RuntimeError("构建 ReferenceLatent 失败：latent 中没有 samples 张量。")

    if not isinstance(conditioning, list):
        return conditioning

    fixed = []
    for item in conditioning:
        if (
            isinstance(item, (list, tuple))
            and len(item) >= 1
            and torch.is_tensor(item[0])
        ):
            meta = dict(item[1]) if len(item) >= 2 and isinstance(item[1], dict) else {}
            refs = meta.get("ref_latents") or []
            if isinstance(refs, dict) and torch.is_tensor(refs.get("samples")):
                refs = [refs["samples"]]
            elif torch.is_tensor(refs):
                refs = [refs]
            elif isinstance(refs, tuple):
                refs = list(refs)
            elif not isinstance(refs, list):
                refs = []
            refs = [
                (
                    r["samples"]
                    if isinstance(r, dict) and torch.is_tensor(r.get("samples"))
                    else r
                )
                for r in refs
            ]
            refs.append(samples)
            meta["ref_latents"] = refs
            fixed.append([item[0], meta])
        elif torch.is_tensor(item):
            fixed.append([item, {"ref_latents": [samples]}])
        else:
            fixed.append(item)
    return fixed


def _fix_reference_latent_tensors(conditioning: Any) -> Any:
    """Flux2 的 ref_latents 必须是 Tensor 列表；清理可能混入的 LATENT dict。"""
    conditioning = _normalize_conditioning(conditioning)
    if not isinstance(conditioning, list):
        return conditioning
    fixed = []
    for item in conditioning:
        if (
            not isinstance(item, (list, tuple))
            or len(item) < 1
            or not torch.is_tensor(item[0])
        ):
            fixed.append(item)
            continue
        meta = dict(item[1]) if len(item) >= 2 and isinstance(item[1], dict) else {}
        for key in ("ref_latents", "reference_latents"):
            value = meta.get(key)
            if isinstance(value, dict) and isinstance(
                value.get("samples"), torch.Tensor
            ):
                meta[key] = [value["samples"]]
            elif torch.is_tensor(value):
                meta[key] = [value]
            elif isinstance(value, (list, tuple)):
                new_value = []
                for v in value:
                    if isinstance(v, dict) and isinstance(
                        v.get("samples"), torch.Tensor
                    ):
                        new_value.append(v["samples"])
                    elif torch.is_tensor(v):
                        new_value.append(v)
                meta[key] = new_value
        fixed.append([item[0], meta])
    return fixed


def _reference_latent_native(conditioning: Any, latent: dict[str, torch.Tensor]) -> Any:
    """
    优先调用 ComfyUI 原生 ReferenceLatent。

    之前手动写 ref_latents 虽然能跑，但 Qwen/Flux2 对 conditioning 的内部字段比较敏感，
    手写结构容易导致图像退化成纹理/遮罩。这里改回原生节点，且通过 _node_call
    自动展开 ComfyUI V3 的 io.NodeOutput.args。
    """
    ReferenceLatent = _try_import_reference_latent()
    if ReferenceLatent is not None:
        try:
            out = _node_call(
                ReferenceLatent(),
                conditioning=_normalize_conditioning(conditioning),
                latent=latent,
            )[0]
            return _fix_reference_latent_tensors(_normalize_conditioning(out))
        except Exception as exc:
            print(
                f"{YELLOW}[GJJ] ReferenceLatent 原生节点调用失败，回退手动结构：{exc}{RESET}"
            )
    return _fix_reference_latent_tensors(_append_reference_latent(conditioning, latent))


def _conditioning_zero_out_native(conditioning: Any) -> Any:
    """
    优先调用 ComfyUI 原生 ConditioningZeroOut。
    原生节点会按当前 ComfyUI 版本保留/处理 conditioning 的内部字段。
    """
    ConditioningZeroOut = _try_import_conditioning_zero_out()
    if ConditioningZeroOut is not None:
        try:
            out = _node_call(
                ConditioningZeroOut(),
                conditioning=_normalize_conditioning(conditioning),
            )[0]
            return _normalize_conditioning(out)
        except Exception as exc:
            print(
                f"{YELLOW}[GJJ] ConditioningZeroOut 原生节点调用失败，回退手动清零：{exc}{RESET}"
            )
    return _zero_out(conditioning)


def _zero_out(conditioning: Any) -> Any:
    """
    手动实现 ConditioningZeroOut，避免直接调用原生节点时不同版本出现 list index out of range。
    这里按 ComfyUI 文档语义清零 pooled_output，同时保持 CONDITIONING 二元结构完整。
    """
    conditioning = _normalize_conditioning(conditioning)
    if not isinstance(conditioning, list):
        return conditioning
    fixed = []
    for item in conditioning:
        if (
            isinstance(item, (list, tuple))
            and len(item) >= 1
            and torch.is_tensor(item[0])
        ):
            meta = dict(item[1]) if len(item) >= 2 and isinstance(item[1], dict) else {}
            pooled = meta.get("pooled_output")
            if torch.is_tensor(pooled):
                meta["pooled_output"] = torch.zeros_like(pooled)
            fixed.append([item[0], meta])
        elif torch.is_tensor(item):
            fixed.append([item, {}])
        else:
            fixed.append(item)
    return fixed


def _apply_flux_guidance(conditioning: Any, guidance: float) -> Any:
    """
    FluxGuidance 本质是给 conditioning meta 添加 guidance。
    直接调用节点在部分新版 ComfyUI 会返回 NodeOutput，所以这里手动写入，结构更稳定。
    """
    return _conditioning_set_values_manual(conditioning, {"guidance": float(guidance)})


def _apply_differential_diffusion(model: Any, strength: float = 1.0) -> Any:
    DifferentialDiffusion = _try_import(
        "DifferentialDiffusion", ("comfy_extras.nodes_differential_diffusion", "nodes")
    )
    if DifferentialDiffusion is None:
        print(f"{YELLOW}[GJJ] DifferentialDiffusion 不可用，已跳过。{RESET}")
        return model
    try:
        candidate = _node_call(
            DifferentialDiffusion(), model=model, strength=float(strength)
        )[0]
        return _maybe_use_model_result(model, candidate, "DifferentialDiffusion")
    except Exception as exc:
        print(f"{YELLOW}[GJJ] DifferentialDiffusion 调用失败，已跳过：{exc}{RESET}")
        return model


def _apply_cfg_norm(model: Any, strength: float = 1.0) -> Any:
    CFGNorm = _try_import(
        "CFGNorm",
        ("comfy_extras.nodes_cfg", "comfy_extras.nodes_model_advanced", "nodes"),
    )
    if CFGNorm is None:
        print(f"{YELLOW}[GJJ] CFGNorm 不可用，已跳过。{RESET}")
        return model
    try:
        candidate = _node_call(CFGNorm(), model=model, strength=float(strength))[0]
        return _maybe_use_model_result(model, candidate, "CFGNorm")
    except Exception as exc:
        print(f"{YELLOW}[GJJ] CFGNorm 调用失败，已跳过：{exc}{RESET}")
        return model


def _apply_aura_flow_shift(model: Any, shift: float = 3.1) -> Any:
    ModelSamplingAuraFlow = _try_import_model_sampling_aura_flow()
    if ModelSamplingAuraFlow is None:
        print(
            f"{YELLOW}[GJJ] ModelSamplingAuraFlow 不可用，已跳过 shift={shift}。{RESET}"
        )
        return model
    try:
        candidate = _node_call(
            ModelSamplingAuraFlow(), model=model, shift=float(shift)
        )[0]
        return _maybe_use_model_result(model, candidate, "ModelSamplingAuraFlow")
    except Exception as exc:
        print(f"{YELLOW}[GJJ] ModelSamplingAuraFlow 调用失败，已跳过：{exc}{RESET}")
        return model


def _load_unet(unet_name: str, dtype: str = "default") -> Any:
    from nodes import UNETLoader

    return UNETLoader().load_unet(
        _resolve_model_name("diffusion_models", unet_name), dtype
    )[0]


def _load_clip(
    clip_name: str, clip_type: str = "default", device: str = "default"
) -> Any:
    from nodes import CLIPLoader

    resolved = _resolve_model_name("text_encoders", clip_name)
    try:
        return CLIPLoader().load_clip(resolved, clip_type, device)[0]
    except TypeError:
        return CLIPLoader().load_clip(resolved, clip_type)[0]


def _load_dual_clip(
    clip1: str, clip2: str, clip_type: str = "flux", device: str = "default"
) -> Any:
    from nodes import DualCLIPLoader

    resolved1 = _resolve_model_name("text_encoders", clip1)
    resolved2 = _resolve_model_name("text_encoders", clip2)
    try:
        return DualCLIPLoader().load_clip(resolved1, resolved2, clip_type, device)[0]
    except TypeError:
        return DualCLIPLoader().load_clip(resolved1, resolved2, clip_type)[0]


def _load_vae(vae_name: str) -> Any:
    from nodes import VAELoader

    return VAELoader().load_vae(_resolve_model_name("vae", vae_name))[0]


def _apply_lora_model_only(model: Any, lora_name: str, strength: float) -> Any:
    if not lora_name or lora_name == "[未找到模型]":
        return model
    from nodes import LoraLoaderModelOnly

    resolved = _resolve_model_name("loras", lora_name)
    loader = LoraLoaderModelOnly()
    try:
        return loader.load_lora_model_only(model, resolved, float(strength))[0]
    except TypeError:
        # 兼容少数自定义版本：可能要求关键字参数。
        return _node_call(
            loader, model=model, lora_name=resolved, strength_model=float(strength)
        )[0]


def _clip_text_encode(clip: Any, text: str) -> Any:
    from nodes import CLIPTextEncode

    return _normalize_conditioning(CLIPTextEncode().encode(clip, str(text or ""))[0])


def _qwen_image_edit_encode(
    clip: Any, vae: Any, image: torch.Tensor, prompt: str
) -> Any:
    """
    严格贴近 Qwen_image_edit扩图.json：

    TextEncodeQwenImageEditPlus 的 vae 输入在你的 JSON 里是“未连接”的，
    只有 clip + image1 + prompt 接入。之前代码强行传 vae，会改变该节点内部路径，
    导致 Qwen 输出变成纹理块/非原图。
    """
    TextEncodeQwenImageEditPlus = _try_import(
        "TextEncodeQwenImageEditPlus", ("nodes", "comfy_extras.nodes_qwen_image")
    )
    if TextEncodeQwenImageEditPlus is not None:
        node = TextEncodeQwenImageEditPlus()

        # 第一优先：完全按 JSON，不传 vae / image2 / image3。
        try:
            return _normalize_conditioning(
                _node_call(
                    node,
                    clip=clip,
                    image1=image,
                    prompt=str(prompt or ""),
                )[0]
            )
        except Exception as exc_no_vae:
            # 兼容极少数版本：如果函数签名硬要求 vae，再降级传入。
            try:
                return _normalize_conditioning(
                    _node_call(
                        node,
                        clip=clip,
                        vae=vae,
                        image1=image,
                        prompt=str(prompt or ""),
                    )[0]
                )
            except Exception as exc:
                print(
                    f"{YELLOW}[GJJ] TextEncodeQwenImageEditPlus 调用失败，回退 CLIPTextEncode：no_vae={exc_no_vae}; with_vae={exc}{RESET}"
                )

    return _clip_text_encode(clip, str(prompt or ""))


def _ksampler(
    model: Any,
    seed: int,
    steps: int,
    cfg: float,
    sampler: str,
    scheduler: str,
    positive: Any,
    negative: Any,
    latent: dict[str, torch.Tensor],
    denoise: float,
) -> dict[str, torch.Tensor]:
    from nodes import KSampler

    if _looks_like_node_output(model) or not _is_model_like(model):
        raise RuntimeError(
            f"KSampler 收到的 model 不是可采样 MODEL，而是：{model.__class__.__name__}"
        )
    positive = _normalize_conditioning(positive)
    negative = _normalize_conditioning(negative)
    sampled = KSampler().sample(
        model,
        int(seed),
        int(steps),
        float(cfg),
        str(sampler),
        str(scheduler),
        positive,
        negative,
        latent,
        float(denoise),
    )[0]
    if not isinstance(sampled, dict):
        raise RuntimeError("KSampler 输出不是 LATENT 字典。")
    return sampled


def _decode_vae(vae: Any, latent: dict[str, torch.Tensor]) -> torch.Tensor:
    return _ensure_image_batch(VAEDecode().decode(vae, latent)[0])


def _merge_output_images(images: list[torch.Tensor]) -> torch.Tensor:
    if not images:
        raise RuntimeError("没有可输出的扩图结果。")
    normalized = [_ensure_image_batch(img) for img in images]
    h_set = {int(img.shape[1]) for img in normalized}
    w_set = {int(img.shape[2]) for img in normalized}
    if len(h_set) > 1 or len(w_set) > 1:
        # Comfy 的 IMAGE batch 需要相同尺寸；多工作流输出尺寸不同则统一补到最大画布，避免 cat 报错。
        max_h = max(h_set)
        max_w = max(w_set)
        padded: list[torch.Tensor] = []
        for img in normalized:
            h = int(img.shape[1])
            w = int(img.shape[2])
            canvas = torch.zeros(
                (int(img.shape[0]), max_h, max_w, 3), dtype=img.dtype, device=img.device
            )
            y = (max_h - h) // 2
            x = (max_w - w) // 2
            canvas[:, y : y + h, x : x + w, :] = img
            padded.append(canvas)
        normalized = padded
    return torch.cat(normalized, dim=0).contiguous()


def _output_root() -> Path:
    return Path(folder_paths.get_output_directory()).resolve()


def _sanitize_part(value: Any, fallback: str = "") -> str:
    text = re.sub(r'[<>:"|?*\x00-\x1f]', "_", str(value or "").strip())
    text = text.replace("\\", "/")
    text = re.sub(r"/+", "/", text)
    return text.strip(" /.") or fallback


def _tensor_to_uint8_image(tensor: torch.Tensor) -> np.ndarray:
    value = _ensure_image_batch(tensor)[0].detach().cpu().float().numpy()
    return np.clip(value * 255.0, 0, 255).astype(np.uint8)


def _next_png_path(directory: Path, stem: str) -> Path:
    safe_stem = _sanitize_part(stem, "批量扩图").replace("/", "_")
    index = 1
    while True:
        path = directory / f"{safe_stem}_{index:05d}.png"
        if not path.exists():
            return path
        index += 1


def _png_metadata(prompt: Any, extra_pnginfo: Any) -> PngImagePlugin.PngInfo | None:
    metadata = PngImagePlugin.PngInfo()
    wrote = False
    if prompt is not None:
        try:
            metadata.add_text("prompt", json.dumps(prompt, ensure_ascii=False))
            wrote = True
        except Exception:
            pass
    if isinstance(extra_pnginfo, dict):
        for key, value in extra_pnginfo.items():
            try:
                metadata.add_text(str(key), json.dumps(value, ensure_ascii=False))
                wrote = True
            except Exception:
                pass
    return metadata if wrote else None


def _resolve_output_prefix(filename_prefix: str) -> tuple[Path, str]:
    raw = _sanitize_part(filename_prefix, "GJJ/批量扩图")
    parts = [part for part in raw.split("/") if part and part not in {".", ".."}]
    if not parts:
        parts = ["GJJ", "批量扩图"]
    root = _output_root()
    directory = (root / Path(*parts[:-1])).resolve() if len(parts) > 1 else root
    try:
        directory.relative_to(root)
    except ValueError as exc:
        raise RuntimeError(f"文件名前缀越界：{filename_prefix}") from exc
    directory.mkdir(parents=True, exist_ok=True)
    return directory, _sanitize_part(parts[-1], "批量扩图")


def _save_result_images(
    images: list[torch.Tensor],
    filename_prefix: str,
    workflow_prompt: Any,
    extra_pnginfo: Any,
    labels: list[str] | None = None,
) -> list[dict[str, str]]:
    directory, base_name = _resolve_output_prefix(filename_prefix)
    metadata = _png_metadata(workflow_prompt, extra_pnginfo)
    previews: list[dict[str, str]] = []
    output_root = _output_root()
    labels = labels or []
    for index, image in enumerate(images, start=1):
        label = labels[index - 1] if index - 1 < len(labels) else "workflow"
        safe_label = (
            re.sub(r"[^0-9A-Za-z_\-]+", "_", str(label or "workflow")).strip("_")
            or "workflow"
        )
        # 文件名形如：批量扩图_SD15_Inpaint_img001_001，方便区分模型分支。
        stem = f"{base_name}_{safe_label}_{index:03d}"
        path = _next_png_path(directory, stem)
        Image.fromarray(_tensor_to_uint8_image(image)).save(path, pnginfo=metadata)
        try:
            relative = path.resolve().relative_to(output_root)
            previews.append(
                {
                    "filename": relative.name,
                    "subfolder": (
                        str(relative.parent).replace("\\", "/")
                        if str(relative.parent) != "."
                        else ""
                    ),
                    "type": "output",
                    "path": str(path),
                    "label": safe_label,
                }
            )
        except Exception:
            previews.append(
                {
                    "filename": path.name,
                    "subfolder": "",
                    "type": "output",
                    "path": str(path),
                    "label": safe_label,
                }
            )
    return previews


def _resolve_model_name(category: str, preferred: str) -> str:
    preferred = str(preferred or "").strip()
    if not preferred or preferred == "[未找到模型]":
        raise RuntimeError(f"未指定 {category} 模型。")
    try:
        available = list(folder_paths.get_filename_list(category))
    except Exception:
        available = []
    if not available:
        return preferred
    if preferred in available:
        return preferred
    preferred_norm = preferred.replace("\\", "/")
    preferred_stem = Path(preferred_norm).stem.lower()
    for name in available:
        name_norm = str(name).replace("\\", "/")
        if preferred_norm.lower() == name_norm.lower():
            return name
        if preferred_stem and preferred_stem == Path(name_norm).stem.lower():
            return name
        if preferred_stem and preferred_stem in Path(name_norm).stem.lower():
            return name
    return preferred


def _extract_workflow_info(
    filename: str, nodes: list[dict], links: list[list[Any]] | None = None
) -> dict[str, Any]:
    key = Path(filename).stem
    info: dict[str, Any] = {
        "key": key,
        "label": WORKFLOW_LABELS.get(key, key),
        "file": filename,
    }

    link_to_origin: dict[int, tuple[int, int]] = {}
    if links:
        for link in links:
            try:
                link_to_origin[int(link[0])] = (int(link[1]), int(link[2]))
            except Exception:
                pass
    node_by_id = {int(n.get("id")): n for n in nodes if "id" in n}

    def text_from_link(link_id: Any) -> str | None:
        try:
            origin = link_to_origin.get(int(link_id))
            if not origin:
                return None
            node = node_by_id.get(origin[0])
            if not node:
                return None
            if node.get("type") in ("CLIPTextEncode", "TextEncodeQwenImageEditPlus"):
                wvals = node.get("widgets_values") or []
                return str(wvals[0]) if wvals else ""
        except Exception:
            return None
        return None

    for node in nodes:
        ntype = node.get("type", "")
        wvals = node.get("widgets_values") or []

        if ntype == "UNETLoader" and wvals:
            info["unet"] = str(wvals[0])
            if len(wvals) > 1:
                info["unet_dtype"] = str(wvals[1])
        elif ntype == "CheckpointLoaderSimple" and wvals:
            info["checkpoint"] = str(wvals[0])
        elif ntype == "CLIPLoader" and wvals:
            info["clip"] = str(wvals[0])
            if len(wvals) > 1:
                info["clip_type"] = str(wvals[1])
        elif ntype == "DualCLIPLoader" and wvals:
            info["clip1"] = str(wvals[0]) if len(wvals) > 0 else ""
            info["clip2"] = str(wvals[1]) if len(wvals) > 1 else ""
            info["clip_type"] = str(wvals[2]) if len(wvals) > 2 else "flux"
        elif ntype == "VAELoader" and wvals:
            info["vae"] = str(wvals[0])
        elif ntype == "LoraLoaderModelOnly" and wvals:
            info["lora"] = str(wvals[0])
            info["lora_strength"] = float(wvals[1]) if len(wvals) > 1 else 1.0
        elif ntype == "ModelSamplingAuraFlow" and wvals:
            info["shift"] = float(wvals[0])
        elif ntype == "CFGNorm" and wvals:
            info["cfg_norm_strength"] = float(wvals[0])
        elif ntype == "FluxGuidance" and wvals:
            info["guidance"] = float(wvals[0])
        elif ntype == "DifferentialDiffusion" and wvals:
            info["differential_strength"] = float(wvals[0])
        elif ntype == "ImageScaleToMaxDimension" and wvals:
            if len(wvals) > 0:
                info["upscale_method"] = str(wvals[0])
            if len(wvals) > 1:
                info["largest_size"] = int(wvals[1])
        elif ntype == "ImagePadForOutpaint" and wvals:
            if len(wvals) > 4:
                info["feathering"] = int(wvals[4])
        elif ntype == "VAEEncodeForInpaint" and wvals:
            info["grow_mask_by"] = int(wvals[0]) if wvals else 0
        elif ntype == "KSampler" and len(wvals) >= 7:
            info["seed"] = int(wvals[0]) if wvals[0] else 0
            info["steps"] = int(wvals[2]) if len(wvals) > 2 else DEFAULT_STEPS
            info["cfg"] = float(wvals[3]) if len(wvals) > 3 else DEFAULT_CFG
            info["sampler"] = str(wvals[4]) if len(wvals) > 4 else DEFAULT_SAMPLER
            info["scheduler"] = str(wvals[5]) if len(wvals) > 5 else DEFAULT_SCHEDULER
            info["denoise"] = float(wvals[6]) if len(wvals) > 6 else DEFAULT_DENOISE
            for inp in node.get("inputs") or []:
                if inp.get("name") == "positive":
                    txt = text_from_link(inp.get("link"))
                    if txt is not None:
                        info["prompt"] = txt
                elif inp.get("name") == "negative":
                    txt = text_from_link(inp.get("link"))
                    if txt is not None:
                        info["negative"] = txt
        elif ntype == "TextEncodeQwenImageEditPlus" and wvals:
            info["prompt"] = str(wvals[0])

    # workflow-specific flags
    types = {str(n.get("type", "")) for n in nodes}
    if "FluxKontextImageScale" in types:
        info["use_flux_kontext_scale"] = True
    if {"JoinImageWithAlpha", "ImageCompositeMasked", "EmptyImage"}.issubset(types):
        info["use_alpha_composite"] = True

    # 用内置默认补齐缺失项，避免工作流 JSON 部分参数没扫到。
    builtin = BUILTIN_WORKFLOW_PRESETS.get(key, {})
    merged = dict(builtin)
    merged.update(info)
    return merged


def _scan_workflow_presets() -> list[dict[str, Any]]:
    presets: dict[str, dict[str, Any]] = {
        k: dict(v) for k, v in BUILTIN_WORKFLOW_PRESETS.items()
    }
    if WORKFLOW_DIR.is_dir():
        for f in sorted(WORKFLOW_DIR.glob("*.json")):
            try:
                with open(f, "r", encoding="utf-8") as fp:
                    wf = json.load(fp)
                key = f.stem
                presets[key] = _extract_workflow_info(
                    f.name, wf.get("nodes", []), wf.get("links", [])
                )
            except Exception as exc:
                print(f"{YELLOW}[GJJ] 工作流解析失败：{f} -> {exc}{RESET}")
    return [presets[k] for k in WORKFLOW_ORDER if k in presets] + [
        v for k, v in presets.items() if k not in WORKFLOW_ORDER
    ]


def _get_node_properties(extra_pnginfo: Any, unique_id: Any) -> dict[str, Any]:
    try:
        workflow = (extra_pnginfo or {}).get("workflow") or {}
        for node in workflow.get("nodes") or []:
            if str(node.get("id")) == str(unique_id):
                return dict(node.get("properties") or {})
    except Exception:
        pass
    return {}


def _suggest_solution(exc: Exception) -> str:
    msg = str(exc)
    if "No module named" in msg:
        m = re.search(r"No module named ['\"]([^'\"]+)['\"]", msg)
        pkg = m.group(1) if m else "未知"
        return f"缺少 Python 依赖包 '{pkg}'，请执行：pip install {pkg}"
    if "CUDA" in msg or "cuda" in msg:
        return "CUDA 相关错误，请检查 GPU 驱动和 PyTorch CUDA 版本是否匹配。"
    if "out of memory" in msg.lower() or "OOM" in msg:
        return "显存不足（OOM），请降低图片分辨率、减少批处理数量或使用更小的模型。"
    if "FileNotFoundError" in msg or "No such file" in msg:
        return "文件未找到，请检查模型文件路径是否正确。"
    if "safetensors" in msg.lower() or "pth" in msg.lower() or "ckpt" in msg.lower():
        return "模型文件损坏或格式不兼容，请重新下载模型。"
    if "dimension" in msg.lower() or "size" in msg.lower() or "shape" in msg.lower():
        return "张量尺寸不匹配，请确认扩图后的宽高是 8 的倍数，并检查遮罩尺寸是否和图片一致。"
    return "请查看上方错误详情，检查模型、参数和依赖是否正确。"


# =========================== 4 个工作流执行链路 ===========================


def _execute_sd15_inpaint(
    image: torch.Tensor,
    padding: dict[str, int],
    preset: dict[str, Any],
    prompt: str,
    negative: str,
    seed: int,
    steps: int,
    cfg: float,
    denoise: float,
    sampler: str,
    scheduler: str,
    feathering: int,
    unique_id: Any,
    suffix: str,
) -> torch.Tensor:
    from nodes import CheckpointLoaderSimple, VAEEncodeForInpaint

    ckpt_name = preset.get("checkpoint", "512-inpainting-ema.safetensors")
    resolved = _resolve_model_name("checkpoints", ckpt_name)
    print(f"{CYAN}[GJJ] {suffix} | SD1.5 Inpaint | Checkpoint: {resolved}{RESET}")

    _send_status(unique_id, f"加载 SD1.5 模型{suffix}...")
    model, clip, vae = CheckpointLoaderSimple().load_checkpoint(resolved)

    _send_status(unique_id, f"扩边{suffix}...")
    padded, mask = _apply_padding(image, padding, feathering)

    pos_text = prompt or preset.get("prompt", "")
    neg_text = negative or preset.get("negative", "")
    _send_status(unique_id, f"编码提示词{suffix}...")
    positive = _clip_text_encode(clip, pos_text)
    negative_cond = _clip_text_encode(clip, neg_text)

    _send_status(unique_id, f"VAE Inpaint 编码{suffix}...")
    grow_mask = int(preset.get("grow_mask_by", 10))
    latent = VAEEncodeForInpaint().encode(vae, padded, mask, grow_mask)[0]

    _send_status(unique_id, f"采样{suffix}...")
    sampled = _ksampler(
        model,
        seed,
        steps,
        cfg,
        sampler,
        scheduler,
        positive,
        negative_cond,
        latent,
        denoise,
    )

    _send_status(unique_id, f"解码{suffix}...")
    return _decode_vae(vae, sampled)


def _execute_flux2_klein(
    image: torch.Tensor,
    padding: dict[str, int],
    preset: dict[str, Any],
    prompt: str,
    negative: str,
    seed: int,
    steps: int,
    cfg: float,
    denoise: float,
    sampler: str,
    scheduler: str,
    feathering: int,
    unique_id: Any,
    suffix: str,
) -> torch.Tensor:
    unet_name = preset.get("unet", "flux-2-klein-base-9b.safetensors")
    unet_dtype = preset.get("unet_dtype", "default")
    clip_name = preset.get("clip", "qwen_3_8b.safetensors")
    clip_type = preset.get("clip_type", "flux2")
    vae_name = preset.get("vae", "flux2-vae.safetensors")

    print(
        f"{CYAN}[GJJ] {suffix} | Flux2-Klein | UNet: {unet_name} | CLIP: {clip_name} | VAE: {vae_name}{RESET}"
    )
    _send_status(unique_id, f"加载 Flux2-Klein 模型{suffix}...")
    model = _load_unet(unet_name, unet_dtype)
    clip = _load_clip(clip_name, clip_type)
    vae = _load_vae(vae_name)

    _send_status(unique_id, f"扩边{suffix}...")
    padded, mask = _apply_padding(image, padding, feathering)

    # 严格贴近你上传的 Flux2 工作流：
    # ImagePadForOutpaint -> EmptyImage -> JoinImageWithAlpha -> ImageCompositeMasked -> FluxKontextImageScale -> VAEEncode
    if bool(preset.get("use_alpha_composite", True)):
        ref_image = _flux2_reference_image_exact(padded, mask)
    else:
        ref_image = (
            _apply_flux_kontext_scale(padded)
            if bool(preset.get("use_flux_kontext_scale", True))
            else padded
        )

    _send_status(unique_id, f"VAE 编码参考图{suffix}...")
    latent = _encode_vae(vae, ref_image)

    pos_text = prompt or preset.get("prompt", "")
    _send_status(unique_id, f"编码 Flux2 提示词{suffix}...")
    positive = _clip_text_encode(clip, pos_text)
    positive_ref = _reference_latent_native(positive, latent)
    negative_cond = _conditioning_zero_out_native(positive)

    _send_status(unique_id, f"采样{suffix}...")
    sampled = _ksampler(
        model,
        seed,
        steps,
        cfg,
        sampler,
        scheduler,
        positive_ref,
        negative_cond,
        latent,
        denoise,
    )

    _send_status(unique_id, f"解码{suffix}...")
    return _decode_vae(vae, sampled)


def _execute_qwen_image_edit(
    image: torch.Tensor,
    padding: dict[str, int],
    preset: dict[str, Any],
    prompt: str,
    negative: str,
    seed: int,
    steps: int,
    cfg: float,
    denoise: float,
    sampler: str,
    scheduler: str,
    feathering: int,
    unique_id: Any,
    suffix: str,
) -> torch.Tensor:
    unet_name = preset.get("unet", "qwen_image_edit_2511_fp8mixed.safetensors")
    unet_dtype = preset.get("unet_dtype", "default")
    clip_name = preset.get("clip", "qwen_2.5_vl_7b_fp8_scaled.safetensors")
    clip_type = preset.get("clip_type", "qwen_image")
    vae_name = preset.get("vae", "qwen_image_vae.safetensors")

    print(
        f"{CYAN}[GJJ] {suffix} | Qwen-Image-Edit | UNet: {unet_name} | CLIP: {clip_name} | VAE: {vae_name}{RESET}"
    )
    _send_status(unique_id, f"加载 Qwen Image Edit 模型{suffix}...")
    model = _load_unet(unet_name, unet_dtype)
    clip = _load_clip(clip_name, clip_type)
    vae = _load_vae(vae_name)

    lora_name = str(preset.get("lora", "") or "")
    if lora_name and lora_name != "[未找到模型]":
        _send_status(unique_id, f"加载 Qwen Lightning LoRA{suffix}...")
        try:
            model = _apply_lora_model_only(
                model, lora_name, float(preset.get("lora_strength", 1.0))
            )
        except Exception as exc:
            print(f"{YELLOW}[GJJ] LoRA 加载失败，跳过：{exc}{RESET}")

    _send_status(unique_id, f"应用 AuraFlow Shift / CFGNorm{suffix}...")
    model = _apply_aura_flow_shift(model, float(preset.get("shift", 3.1)))
    model = _apply_cfg_norm(model, float(preset.get("cfg_norm_strength", cfg)))

    work_image = image
    if int(preset.get("largest_size", 0) or 0) > 0:
        _send_status(unique_id, f"缩放到最大边{suffix}...")
        work_image = _resize_to_max_dimension(
            work_image,
            int(preset.get("largest_size", 1248)),
            str(preset.get("upscale_method", "area")),
        )

    _send_status(unique_id, f"扩边{suffix}...")
    padded, _mask = _apply_padding(work_image, padding, feathering)

    _send_status(unique_id, f"VAE 编码{suffix}...")
    latent = _encode_vae(vae, padded)

    pos_text = prompt or preset.get("prompt", "")
    _send_status(unique_id, f"TextEncodeQwenImageEditPlus 编码{suffix}...")
    positive = _qwen_image_edit_encode(clip, vae, padded, pos_text)
    positive_ref = _reference_latent_native(positive, latent)
    negative_cond = _conditioning_zero_out_native(positive_ref)

    _send_status(unique_id, f"采样{suffix}...")
    sampled = _ksampler(
        model,
        seed,
        steps,
        cfg,
        sampler,
        scheduler,
        positive_ref,
        negative_cond,
        latent,
        denoise,
    )

    _send_status(unique_id, f"解码{suffix}...")
    return _decode_vae(vae, sampled)


def _execute_flux_fill_dev(
    image: torch.Tensor,
    padding: dict[str, int],
    preset: dict[str, Any],
    prompt: str,
    negative: str,
    seed: int,
    steps: int,
    cfg: float,
    denoise: float,
    sampler: str,
    scheduler: str,
    feathering: int,
    unique_id: Any,
    suffix: str,
) -> torch.Tensor:
    from nodes import InpaintModelConditioning

    unet_name = preset.get("unet", "flux1-fill-dev_fp8.safetensors")
    unet_dtype = preset.get("unet_dtype", "fp8_e4m3fn")
    clip1 = preset.get("clip1", "clip_l.safetensors")
    clip2 = preset.get("clip2", "t5xxl_fp16.safetensors")
    clip_type = preset.get("clip_type", "flux")
    vae_name = preset.get("vae", "ae.safetensors")

    print(
        f"{CYAN}[GJJ] {suffix} | Flux-Fill-Dev | UNet: {unet_name} | VAE: {vae_name}{RESET}"
    )
    _send_status(unique_id, f"加载 Flux Fill Dev 模型{suffix}...")
    model = _load_unet(unet_name, unet_dtype)
    clip = _load_dual_clip(clip1, clip2, clip_type)
    vae = _load_vae(vae_name)

    _send_status(unique_id, f"应用 DifferentialDiffusion{suffix}...")
    model = _apply_differential_diffusion(
        model, float(preset.get("differential_strength", 1.0))
    )

    _send_status(unique_id, f"扩边{suffix}...")
    padded, mask = _apply_padding(image, padding, feathering)

    pos_text = prompt or preset.get("prompt", "")
    neg_text = negative or preset.get("negative", "")
    _send_status(unique_id, f"编码 Flux Fill 提示词{suffix}...")
    positive = _clip_text_encode(clip, pos_text)
    positive = _apply_flux_guidance(positive, float(preset.get("guidance", 30.0)))
    # 这里必须按你上传的 flux_fill_dev 工作流走：负面条件来自空/反向文本编码，
    # 不要对 FluxGuidance 后的 positive 做 zero_out，否则部分 ComfyUI 版本会 list index out of range。
    negative_cond = _clip_text_encode(clip, neg_text)

    _send_status(unique_id, f"构建 InpaintModelConditioning{suffix}...")
    noise_mask = bool(preset.get("noise_mask", False))
    # 用关键字调用，兼容当前 ComfyUI 原生签名：
    # encode(positive, negative, pixels, vae, mask, noise_mask)
    # 也避免不同版本参数顺序变化导致把 VAE 当成 pixels。
    positive = _normalize_conditioning(positive)
    negative_cond = _normalize_conditioning(negative_cond)
    cond = _node_call(
        InpaintModelConditioning(),
        positive=positive,
        negative=negative_cond,
        pixels=padded,
        vae=vae,
        mask=mask,
        noise_mask=noise_mask,
    )
    final_positive, final_negative, latent = cond[0], cond[1], cond[2]

    _send_status(unique_id, f"采样{suffix}...")
    sampled = _ksampler(
        model,
        seed,
        steps,
        cfg,
        sampler,
        scheduler,
        final_positive,
        final_negative,
        latent,
        denoise,
    )

    _send_status(unique_id, f"解码{suffix}...")
    return _decode_vae(vae, sampled)


WORKFLOW_EXECUTORS = {
    "512-inpainting-ema扩图": _execute_sd15_inpaint,
    "Flux2-klein扩图": _execute_flux2_klein,
    "Qwen_image_edit扩图": _execute_qwen_image_edit,
    "flux_fill_dev扩图": _execute_flux_fill_dev,
}


class GJJ_BatchOutpaint:
    DESCRIPTION = "批量扩图工具。支持 SD1.5 Inpainting、Flux2 Klein、Qwen Image Edit、Flux Fill Dev；支持像素扩图和目标尺寸扩图。"
    SEARCH_ALIASES = ["批量扩图", "outpaint", "扩图", "图像扩展", "batch outpaint"]
    # 输出标准 ComfyUI IMAGE 批量张量，才能被 PreviewImage / SaveImage / 预览器节点直接识别。
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图片列表",)
    OUTPUT_TOOLTIPS = (
        "标准 IMAGE 批量输出，可直接连接 PreviewImage / SaveImage / 预览器节点。",
    )
    OUTPUT_NODE = True
    FUNCTION = "generate"
    CATEGORY = "GJJ"

    GJJ_HELP = {
        "title": "GJJ · 🖼️ 批量扩图工具",
        "version": "v10",
        "author": "GJJ Custom Nodes Team",
        "description": "强大的批量扩图节点，支持同时使用多个 AI 模型工作流对图片进行智能扩展。可以一次性处理多张图片，自动应用不同的扩图算法，大幅提升工作效率。",

        "features": [
            {
                "name": "多工作流并行",
                "description": "支持 Ctrl/Shift 多选工作流，一次执行多个扩图算法",
            },
            {
                "name": "两种扩图模式",
                "description": "像素扩图（指定各方向扩展像素）和目标尺寸（指定最终图片大小）",
            },
            {
                "name": "4 种主流模型",
                "description": "SD1.5 Inpainting、Flux2 Klein、Qwen Image Edit、Flux Fill Dev",
            },
            {
                "name": "批量自动化",
                "description": "自动递增种子、进度显示、错误提示",
            },
            {
                "name": "动态参数面板",
                "description": "根据选择的扩图模式自动显示对应参数",
            },
        ],

        "models": [
            {
                "label": "📌 模型下载",
                "value": "夸克网盘: https://pan.quark.cn/s/6ec846f1f58d",
                "tooltip": "所有模型打包下载，解压后按目录结构放置到 models/ 文件夹",
            },
            {
                "label": "1️⃣ SD1.5 Inpainting EMA - Checkpoint",
                "value": "models/checkpoints/512-inpainting-ema.safetensors (~2GB)",
                "tooltip": "SD1.5 专用修复模型，用于基础扩图",
            },
            {
                "label": "2️⃣ Flux2 Klein - UNet",
                "value": "models/diffusion_models/flux-2-klein-base-9b.safetensors (~18GB)",
                "tooltip": "Flux2 基础模型，高质量扩图",
            },
            {
                "label": "2️⃣ Flux2 Klein - CLIP",
                "value": "models/text_encoders/qwen_3_8b.safetensors (~7.5GB)",
                "tooltip": "Qwen 3 文本编码器",
            },
            {
                "label": "2️⃣ Flux2 Klein - VAE",
                "value": "models/vae/flux2-vae.safetensors (~335MB)",
                "tooltip": "Flux2 专用 VAE",
            },
            {
                "label": "3️⃣ Qwen Image Edit - UNet",
                "value": "models/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors (~14GB)",
                "tooltip": "Qwen 图像编辑模型（FP8 精度）",
            },
            {
                "label": "3️⃣ Qwen Image Edit - CLIP",
                "value": "models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors (~14GB)",
                "tooltip": "Qwen 2.5 VL 视觉语言模型",
            },
            {
                "label": "3️⃣ Qwen Image Edit - VAE",
                "value": "models/vae/qwen_image_vae.safetensors (~335MB)",
                "tooltip": "Qwen 专用 VAE",
            },
            {
                "label": "3️⃣ Qwen Image Edit - LoRA (可选)",
                "value": "models/loras/QWEN/lighting/Qwen-Image-Lightning-4steps-V2.0.safetensors (~1.5GB)",
                "tooltip": "加速 LoRA，可实现 4 步快速出图",
            },
            {
                "label": "4️⃣ Flux Fill Dev - UNet",
                "value": "models/diffusion_models/flux1-fill-dev_fp8.safetensors (~11GB)",
                "tooltip": "Flux1 Fill 开发版（FP8 精度），推荐首选",
            },
            {
                "label": "4️⃣ Flux Fill Dev - CLIP1",
                "value": "models/text_encoders/clip_l.safetensors (~246MB)",
                "tooltip": "CLIP-L 文本编码器",
            },
            {
                "label": "4️⃣ Flux Fill Dev - CLIP2",
                "value": "models/text_encoders/t5xxl_fp16.safetensors (~9.5GB)",
                "tooltip": "T5-XXL 文本编码器",
            },
            {
                "label": "4️⃣ Flux Fill Dev - VAE",
                "value": "models/vae/ae.safetensors (~335MB)",
                "tooltip": "Flux 专用 VAE",
            },
        ],

        "usage": [
            "1. 加载图片：使用 GJJ · 批量多图片加载预览器 或 GJJ · 批量图片包装器 准备图片",
            "2. 连接节点：将批量图片输出连接到本节点的「批量图片」输入口",
            "3. 选择工作流：在「选择工作流」下拉框中按 Ctrl/Shift 多选需要的工作流",
            "4. 设置扩图模式：",
            "   • 像素扩图：设置左、右、上、下各方向的扩展像素数",
            "   • 目标尺寸：设置目标宽度、高度和扩展方向",
            "5. 调整参数：根据需要修改提示词、步数、CFG 等参数",
            "6. 执行：点击 Queue Prompt 开始批量扩图",
        ],

        "tips": [
            "💡 高质量扩图建议使用 Flux Fill Dev 或 Qwen Image Edit",
            "💡 提示词尽量详细描述需要填充的内容",
            "💡 Feathering（羽化）值设为 24-100，避免边缘生硬",
            "💡 先单张测试，确认参数合适后再批量处理",
            "💡 不同尺寸的图片建议使用「目标尺寸」模式",
            "💡 显存不足时可减少同时执行的工作流数量或使用 FP8 模型",
        ],

        "performance": {
            "SD1.5 Inpainting": "显存 ~4GB | 耗时 5-10秒 (RTX 4090) | 推荐分辨率 512x512",
            "Flux2 Klein": "显存 ~18GB | 耗时 30-60秒 (RTX 4090) | 推荐分辨率 1024x1024",
            "Qwen Image Edit": "显存 ~16GB | 耗时 20-40秒 (RTX 4090) | 推荐分辨率 1024x1024",
            "Flux Fill Dev": "显存 ~14GB | 耗时 25-50秒 (RTX 4090) | 推荐分辨率 1024x1024",
        },

        "dependencies": [],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    GJJ_BATCH_IMAGE_TYPE,
                    {
                        "display_name": "批量图片",
                        "tooltip": "接入 GJJ · 批量多图片加载预览器 或 GJJ · 批量图片包装器 输出的 GJJ 批量图片。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": DEFAULT_SEED,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "随机种子。批量处理时按任务序号自动递增。",
                    },
                ),
            },
            "hidden": {
                "workflow_prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        m = hashlib.sha256()
        for key in sorted(kwargs.keys()):
            m.update(str(kwargs[key]).encode("utf-8", errors="ignore"))
        return m.hexdigest()

    def generate(
        self,
        image,
        seed: int = DEFAULT_SEED,
        workflow_prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        props = _get_node_properties(extra_pnginfo, unique_id)
        outpaint_mode = str(props.get("outpaint_mode", "像素扩图") or "像素扩图")
        selected_workflows_str = str(props.get("selected_workflows", "") or "")
        selected_keys = [
            k.strip() for k in selected_workflows_str.split(",") if k.strip()
        ]

        try:
            if not selected_keys:
                # 首次放置节点但前端还没写入 properties 时，默认跑 Flux Fill Dev，避免直接报错。
                selected_keys = ["flux_fill_dev扩图"]

            presets_map = {p["key"]: p for p in _scan_workflow_presets()}
            valid_presets = []
            for key in selected_keys:
                preset = presets_map.get(key) or BUILTIN_WORKFLOW_PRESETS.get(key)
                if preset:
                    valid_presets.append(dict(preset))
                else:
                    print(f"{YELLOW}[GJJ] 跳过未知工作流：{key}{RESET}")
            if not valid_presets:
                raise RuntimeError("所选工作流均无效。")

            input_images = _split_images(image)
            total_workflows = len(valid_presets)
            total_images = len(input_images)
            total_tasks = total_workflows * total_images
            print(
                f"{CYAN}[GJJ] 批量扩图开始：{total_images} 张图片 x {total_workflows} 个工作流 = {total_tasks} 个任务{RESET}"
            )
            _send_status(
                unique_id,
                f"准备处理 {total_images} 张图片 x {total_workflows} 个工作流 = {total_tasks} 个任务",
                0.0,
            )

            # 计算扩图参数。目标尺寸模式按每张图片单独计算，避免批量不同尺寸时 padding 错位。
            pixel_padding = None
            if outpaint_mode == "像素扩图":
                left = int(props.get("left", DEFAULT_LEFT) or 0)
                right = int(props.get("right", DEFAULT_RIGHT) or 0)
                top = int(props.get("top", DEFAULT_TOP) or 0)
                bottom = int(props.get("bottom", DEFAULT_BOTTOM) or 0)
                pixel_padding = _calculate_padding_pixel(left, right, top, bottom)
                print(
                    f"{GREEN}[GJJ] 像素扩图：左{left} 右{right} 上{top} 下{bottom}{RESET}"
                )
            else:
                target_width = int(
                    props.get("target_width", DEFAULT_TARGET_WIDTH)
                    or DEFAULT_TARGET_WIDTH
                )
                target_height = int(
                    props.get("target_height", DEFAULT_TARGET_HEIGHT)
                    or DEFAULT_TARGET_HEIGHT
                )
                direction = str(
                    props.get("direction", DEFAULT_DIRECTION) or DEFAULT_DIRECTION
                )
                print(
                    f"{GREEN}[GJJ] 目标尺寸扩图：{target_width}x{target_height}，方向：{direction}{RESET}"
                )

            results: list[torch.Tensor] = []
            result_labels: list[str] = []
            task_index = 0

            for wf_idx, preset in enumerate(valid_presets, start=1):
                wf_key = preset["key"]
                executor = WORKFLOW_EXECUTORS.get(wf_key)
                if executor is None:
                    print(f"{YELLOW}[GJJ] 跳过不支持的工作流：{wf_key}{RESET}")
                    continue

                wf_steps = int(preset.get("steps", DEFAULT_STEPS))
                wf_cfg = float(preset.get("cfg", DEFAULT_CFG))
                wf_denoise = float(preset.get("denoise", DEFAULT_DENOISE))
                wf_sampler = str(preset.get("sampler", DEFAULT_SAMPLER))
                wf_scheduler = str(preset.get("scheduler", DEFAULT_SCHEDULER))
                wf_feathering = int(preset.get("feathering", 24))

                print(
                    f"{CYAN}[GJJ] 工作流 [{wf_idx}/{total_workflows}]：{wf_key}（steps={wf_steps}, cfg={wf_cfg}, sampler={wf_sampler}, scheduler={wf_scheduler}）{RESET}"
                )

                for img_idx, original_image in enumerate(input_images, start=1):
                    task_index += 1
                    suffix = f"（工作流 {wf_idx}/{total_workflows}，图片 {img_idx}/{total_images}）"
                    progress = (task_index - 1) / max(1, total_tasks)
                    _send_status(unique_id, f"处理{suffix}", progress)

                    try:
                        single_image = original_image
                        if outpaint_mode == "目标尺寸":
                            target_width = int(
                                props.get("target_width", DEFAULT_TARGET_WIDTH)
                                or DEFAULT_TARGET_WIDTH
                            )
                            target_height = int(
                                props.get("target_height", DEFAULT_TARGET_HEIGHT)
                                or DEFAULT_TARGET_HEIGHT
                            )
                            direction = str(
                                props.get("direction", DEFAULT_DIRECTION)
                                or DEFAULT_DIRECTION
                            )
                            single_image, padding = _calculate_padding_target_size(
                                single_image, target_width, target_height, direction
                            )
                        else:
                            padding = dict(pixel_padding or {})

                        result = executor(
                            single_image,
                            padding,
                            preset,
                            "",
                            "",
                            int(seed) + task_index - 1,
                            wf_steps,
                            wf_cfg,
                            wf_denoise,
                            wf_sampler,
                            wf_scheduler,
                            wf_feathering,
                            unique_id,
                            suffix,
                        )
                        results.append(result)
                        result_labels.append(
                            f"{_workflow_file_label(wf_key)}_img{img_idx:03d}"
                        )
                        print(f"{GREEN}[GJJ] 完成{suffix}{RESET}")
                    except RuntimeError as exc:
                        error_msg = str(exc)
                        print(f"{RED}[GJJ] 扩图失败{suffix}：{error_msg}{RESET}")
                        print(f"{YELLOW}[GJJ] 建议：{_suggest_solution(exc)}{RESET}")
                        _send_error(unique_id, f"扩图失败{suffix}", error_msg)
                        _send_status(unique_id, f"失败{suffix}：{error_msg}", progress)
                        continue
                    except Exception as exc:
                        error_msg = f"{type(exc).__name__}: {exc}"
                        print(f"{RED}[GJJ] 扩图异常{suffix}：{error_msg}{RESET}")
                        print(f"{YELLOW}[GJJ] 建议：{_suggest_solution(exc)}{RESET}")
                        traceback.print_exc()
                        _send_error(unique_id, f"扩图异常{suffix}", error_msg)
                        _send_status(unique_id, f"异常{suffix}", progress)
                        continue

            if not results:
                raise RuntimeError("所有扩图任务均失败。")

            merged = _merge_output_images(results)
            count = len(results)
            print(f"{GREEN}{BOLD}[GJJ] 批量扩图完成：共生成 {count} 张图片{RESET}")
            _send_status(unique_id, f"完成：{count} 张扩图结果", 1.0)

            previews = _save_result_images(
                results, "GJJ/批量扩图", workflow_prompt, extra_pnginfo, result_labels
            )

            # 不再把 images/preview_text 写回本节点面板，避免节点内部出现第二套预览。
            # 图片仍然通过标准 IMAGE 输出端口输出，连接右侧预览器/SaveImage 即可查看。
            return {
                "result": (merged,),
            }
        except RuntimeError as exc:
            print(f"{RED}[GJJ] 执行失败：{exc}{RESET}")
            _send_status(unique_id, f"执行失败：{str(exc).splitlines()[0]}")
            raise
        except Exception as exc:
            print(f"{RED}[GJJ] 执行异常：{type(exc).__name__}: {exc}{RESET}")
            print(f"{YELLOW}[GJJ] 建议：{_suggest_solution(exc)}{RESET}")
            traceback.print_exc()
            _send_status(unique_id, "执行失败")
            raise RuntimeError(f"批量扩图执行失败。\n详细错误：{exc}") from exc


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_BatchOutpaint}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🖼️ 批量扩图工具"}
