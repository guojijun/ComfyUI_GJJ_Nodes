from __future__ import annotations

from fractions import Fraction
from typing import Any

import torch
from comfy_api.latest import InputImpl, Types

from .gjj_flashvsr_runtime import (
    DEFAULT_MODEL_LAYOUT,
    MODEL_LAYOUTS,
    get_device_list,
    normalize_input_frames,
    upscale_frames,
)


NODE_NAME = "GJJ_FlashVSRVideoUpscaler"


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


PRESET_FAST = "快速 2x"
PRESET_BALANCED = "平衡质量"
PRESET_LONG = "长视频低显存"
PRESET_HIGH = "最高质量"
PRESET_MANUAL = "手动参数"
PRESETS = [PRESET_BALANCED, PRESET_FAST, PRESET_LONG, PRESET_HIGH, PRESET_MANUAL]

MODE_CHOICES = ["tiny", "tiny-long", "full"]
ATTENTION_COMPAT = "兼容注意力（零依赖）"
ATTENTION_BLOCK = "块稀疏注意力（实验）"
ATTENTION_CHOICES = [ATTENTION_COMPAT, ATTENTION_BLOCK]
FRAME_INPUT_PREFIX = "input_frames_"


class FlexibleFrameOptionalInputs(dict):
    def __init__(self, data: dict[str, Any]):
        super().__init__()
        self.data = data
        for key, value in data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        if str(key).startswith(FRAME_INPUT_PREFIX):
            return ("IMAGE", {
                "display_name": "输入图片",
                "tooltip": "动态图片输入；多路输入会按编号拼成帧序列。",
            })
        raise KeyError(key)

    def __contains__(self, key):
        return key in self.data or str(key).startswith(FRAME_INPUT_PREFIX)


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": str(text or "")},
        )
    except Exception:
        pass


def _frame_input_index(name: str) -> int:
    if name == "input_frames":
        return 1
    if name.startswith(FRAME_INPUT_PREFIX):
        try:
            return int(name[len(FRAME_INPUT_PREFIX):])
        except ValueError:
            return 9999
    return 9999


def _collect_frame_inputs(input_frames: Any, extra_inputs: dict[str, Any]) -> list[Any]:
    values: list[Any] = []
    if input_frames is not None and getattr(input_frames, "shape", None) is not None:
        values.append(input_frames)
    for name, value in sorted((extra_inputs or {}).items(), key=lambda item: _frame_input_index(str(item[0]))):
        if not str(name).startswith(FRAME_INPUT_PREFIX):
            continue
        if value is not None and getattr(value, "shape", None) is not None:
            values.append(value)
    return values


def _merge_frame_inputs(values: list[Any]) -> torch.Tensor:
    normalized: list[torch.Tensor] = []
    for value in values:
        tensor = normalize_input_frames(value)
        if int(tensor.shape[0]) > 0:
            normalized.append(tensor)
    if not normalized:
        raise RuntimeError("没有收到有效的图片或帧序列。")

    base_shape = tuple(normalized[0].shape[1:])
    for index, tensor in enumerate(normalized[1:], start=2):
        if tuple(tensor.shape[1:]) != base_shape:
            raise RuntimeError(
                f"第 {index} 路图片尺寸与第 1 路不一致：{tuple(tensor.shape[1:])} != {base_shape}。"
            )
    return torch.cat(normalized, dim=0)


def _resolve_preset(
    preset: str,
    mode: str,
    enable_tiling: bool,
    tile_size: int,
    tile_overlap: int,
    sparse_ratio: float,
    kv_ratio: float,
    local_range: int,
) -> dict[str, Any]:
    if preset == PRESET_FAST:
        return {
            "mode": "tiny",
            "enable_tiling": True,
            "tile_size": 256,
            "tile_overlap": 32,
            "sparse_ratio": 1.5,
            "kv_ratio": 1.0,
            "local_range": 9,
        }
    if preset == PRESET_LONG:
        return {
            "mode": "tiny-long",
            "enable_tiling": True,
            "tile_size": 256,
            "tile_overlap": 32,
            "sparse_ratio": 2.0,
            "kv_ratio": 2.0,
            "local_range": 11,
        }
    if preset == PRESET_HIGH:
        return {
            "mode": "full",
            "enable_tiling": True,
            "tile_size": 384,
            "tile_overlap": 48,
            "sparse_ratio": 2.0,
            "kv_ratio": 3.0,
            "local_range": 11,
        }
    if preset == PRESET_BALANCED:
        return {
            "mode": "tiny",
            "enable_tiling": True,
            "tile_size": 256,
            "tile_overlap": 32,
            "sparse_ratio": 2.0,
            "kv_ratio": 2.0,
            "local_range": 11,
        }
    return {
        "mode": mode,
        "enable_tiling": bool(enable_tiling),
        "tile_size": int(tile_size),
        "tile_overlap": int(tile_overlap),
        "sparse_ratio": float(sparse_ratio),
        "kv_ratio": float(kv_ratio),
        "local_range": int(local_range),
    }


class GJJ_FlashVSRVideoUpscaler:
    CATEGORY = "GJJ"
    FUNCTION = "upscale"
    DESCRIPTION = "综合 FlashVSR 与 FlashVSR Ultra-Fast 的 GJJ 零依赖单节点；支持视频直连保留音频，或帧序列超分输出。"
    SEARCH_ALIASES = [
        "FlashVSR",
        "FlashVSR Ultra Fast",
        "视频超分",
        "视频放大",
        "低显存超分",
        "口型同步视频增强",
    ]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("超分结果",)
    OUTPUT_TOOLTIPS = ("输入视频时输出带原音轨的视频；输入图片或帧序列时输出放大后的 IMAGE 批次。",)

    @classmethod
    def INPUT_TYPES(cls):
        devices = get_device_list()
        default_device = "auto" if "auto" in devices else devices[0]
        return {
            "required": {
                "preset": (PRESETS, {
                    "default": PRESET_BALANCED,
                    "display_name": "运行预设",
                    "tooltip": "快速、平衡、长视频、最高质量会自动套用推荐参数；选手动参数时才完全使用下面的高级参数。",
                }),
                "model_layout": (MODEL_LAYOUTS, {
                    "default": DEFAULT_MODEL_LAYOUT,
                    "display_name": "模型格式",
                    "tooltip": "自动检测会优先使用 models/FlashVSR 下的 safetensors 模型，也兼容 Ultra-Fast 的 JunhaoZhuang 模型目录。",
                }),
                "scale": ("INT", {
                    "default": 2,
                    "min": 2,
                    "max": 4,
                    "step": 2,
                    "display_name": "放大倍率",
                    "tooltip": "FlashVSR 支持 2x 或 4x；4x 更重，显存压力更大。",
                }),
                "mode": (MODE_CHOICES, {
                    "default": "tiny",
                    "display_name": "推理模式",
                    "tooltip": "手动参数预设下生效。tiny 更快，tiny-long 更省显存，full 质量最高但更吃显存。",
                }),
                "enable_tiling": ("BOOLEAN", {
                    "default": True,
                    "display_name": "DiT切块",
                    "tooltip": "按画面切块推理以降低显存占用；关闭会更快但更容易爆显存。",
                }),
                "tile_size": ("INT", {
                    "default": 256,
                    "min": 128,
                    "max": 1024,
                    "step": 32,
                    "display_name": "切块尺寸",
                    "tooltip": "输入分辨率上的切块尺寸。越大越快但更吃显存。",
                }),
                "tile_overlap": ("INT", {
                    "default": 32,
                    "min": 8,
                    "max": 256,
                    "step": 8,
                    "display_name": "切块重叠",
                    "tooltip": "切块之间的重叠宽度，用于减少边缘痕迹；必须小于切块尺寸的一半。",
                }),
                "color_fix": ("BOOLEAN", {
                    "default": True,
                    "display_name": "颜色校正",
                    "tooltip": "开启后尽量保持原视频色彩，减少超分后的偏色。",
                }),
                "tiled_vae": ("BOOLEAN", {
                    "default": True,
                    "display_name": "VAE切块",
                    "tooltip": "降低解码阶段显存占用，速度会略慢。",
                }),
                "unload_dit": ("BOOLEAN", {
                    "default": False,
                    "display_name": "解码前卸载DiT",
                    "tooltip": "解码前把主模型临时卸到 CPU，显存紧张时开启。",
                }),
                "force_offload": ("BOOLEAN", {
                    "default": True,
                    "display_name": "执行后卸载",
                    "tooltip": "每次执行后尽量把 FlashVSR 权重卸到 CPU，减少对后续节点的显存占用。",
                }),
                "sparse_ratio": ("FLOAT", {
                    "default": 2.0,
                    "min": 1.5,
                    "max": 2.0,
                    "step": 0.1,
                    "display": "slider",
                    "display_name": "稀疏比例",
                    "tooltip": "手动参数预设下生效。1.5 更快，2.0 通常更稳。",
                }),
                "kv_ratio": ("FLOAT", {
                    "default": 2.0,
                    "min": 1.0,
                    "max": 3.0,
                    "step": 0.1,
                    "display": "slider",
                    "display_name": "KV比例",
                    "tooltip": "手动参数预设下生效。数值越高质量倾向越强，但显存占用也更高。",
                }),
                "local_range": ([9, 11], {
                    "default": 11,
                    "display_name": "局部范围",
                    "tooltip": "手动参数预设下生效。9 可能更锐，11 通常时间稳定性更好。",
                }),
                "attention_mode": (ATTENTION_CHOICES, {
                    "default": ATTENTION_COMPAT,
                    "display_name": "注意力模式",
                    "tooltip": "默认使用 PyTorch SDPA，不调用 Triton、Sparse Sage 或 FlashAttention。实验模式需要额外环境支持。",
                }),
                "precision": (["bf16", "fp16"], {
                    "default": "bf16",
                    "display_name": "计算精度",
                    "tooltip": "现代 NVIDIA 显卡通常用 bf16；兼容性问题时可改 fp16。",
                }),
                "device": (devices, {
                    "default": default_device,
                    "display_name": "运行设备",
                    "tooltip": "auto 会优先使用 CUDA，其次 MPS，最后 CPU。CPU 会非常慢。",
                }),
                "seed": ("INT", {
                    "default": 1,
                    "min": 0,
                    "max": 0xFFFFFFFFFFFFFFFF,
                    "display_name": "随机种子",
                    "tooltip": "相同输入和参数下使用同一随机种子可复现输出。",
                }),
                "auto_download": ("BOOLEAN", {
                    "default": False,
                    "display_name": "自动下载缺失模型",
                    "tooltip": "缺模型时从 Hugging Face 下载；模型很大，默认关闭。",
                }),
            },
            "optional": FlexibleFrameOptionalInputs({
                "input_video": ("VIDEO", {
                    "display_name": "输入视频",
                    "tooltip": "可选。连接后自动提取帧，超分完成后按原帧率和原音轨输出视频。",
                }),
                "input_frames": ("IMAGE", {
                    "display_name": "输入图片/帧序列",
                    "tooltip": "可选。可接单张 IMAGE 或 IMAGE 批次；少于 21 帧时会自动重复最后一帧补足上下文。",
                }),
            }),
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def upscale(
        self,
        preset,
        model_layout,
        scale,
        mode,
        enable_tiling,
        tile_size,
        tile_overlap,
        color_fix,
        tiled_vae,
        unload_dit,
        force_offload,
        sparse_ratio,
        kv_ratio,
        local_range,
        attention_mode,
        precision,
        device,
        seed,
        auto_download,
        input_video=None,
        input_frames=None,
        unique_id=None,
        **extra_inputs,
    ):
        has_video = input_video is not None
        frame_values = _collect_frame_inputs(input_frames, extra_inputs)
        has_frames = bool(frame_values)
        if not has_video and not has_frames:
            raise RuntimeError("请至少连接“输入视频”或“输入图片/帧序列”其中之一。")

        source_audio = None
        source_fps = None
        output_mode = "image"
        if has_video:
            _send_status(unique_id, "读取输入视频...")
            try:
                components = input_video.get_components()
                frames = components.images
                source_audio = components.audio
                source_fps = float(components.frame_rate)
                output_mode = "video"
            except Exception as exc:
                raise RuntimeError(f"FlashVSR 无法读取输入视频。\n详细错误：{exc}") from exc
        else:
            frames = _merge_frame_inputs(frame_values)

        resolved = _resolve_preset(
            preset,
            mode,
            enable_tiling,
            tile_size,
            tile_overlap,
            sparse_ratio,
            kv_ratio,
            local_range,
        )

        def status(text: str) -> None:
            _send_status(unique_id, text)

        try:
            result_frames, bundle, elapsed = upscale_frames(
                frames,
                model_layout=model_layout,
                mode=resolved["mode"],
                scale=int(scale),
                enable_tiling=resolved["enable_tiling"],
                tile_size=resolved["tile_size"],
                tile_overlap=resolved["tile_overlap"],
                sparse_ratio=resolved["sparse_ratio"],
                kv_ratio=resolved["kv_ratio"],
                local_range=resolved["local_range"],
                color_fix=bool(color_fix),
                tiled_vae=bool(tiled_vae),
                unload_dit=bool(unload_dit),
                force_offload=bool(force_offload),
                attention_mode=attention_mode,
                device_name=device,
                precision=precision,
                seed=int(seed),
                auto_download=bool(auto_download),
                status=status,
            )
        except Exception as exc:
            _send_status(unique_id, f"失败：{exc}")
            raise RuntimeError(f"FlashVSR 超分失败。\n详细错误：{exc}") from exc

        if output_mode == "video":
            _send_status(unique_id, "创建输出视频...")
            try:
                video_output = InputImpl.VideoFromComponents(
                    Types.VideoComponents(
                        images=result_frames,
                        audio=source_audio,
                        frame_rate=Fraction(str(source_fps or 24.0)).limit_denominator(1000),
                    )
                )
            except Exception as exc:
                raise RuntimeError(f"FlashVSR 创建输出视频失败。\n详细错误：{exc}") from exc
            _send_status(
                unique_id,
                f"完成：{int(result_frames.shape[0])} 帧 / {scale}x / {bundle.name} / {elapsed:.1f} 秒",
            )
            return (video_output,)

        _send_status(
            unique_id,
            f"完成：{int(result_frames.shape[0])} 帧图像 / {scale}x / {bundle.name} / {elapsed:.1f} 秒",
        )
        return (result_frames,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_FlashVSRVideoUpscaler}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔍 FlashVSR视频超分放大器"}
