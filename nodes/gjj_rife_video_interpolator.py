from __future__ import annotations

from fractions import Fraction
from typing import Any

import comfy.utils
from comfy_api.latest import InputImpl, Types
import torch

from .gjj_rife_runtime import (
    DEFAULT_CKPT,
    get_torch_device,
    list_rife_models,
    postprocess_frames,
    preprocess_frames,
    resolve_rife_model_path,
    soft_empty_cache,
    interpolate_frames,
)


NODE_NAME = "GJJ_RifeVideoInterpolator"


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"


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


def _load_rife_model(model_name: str):
    from ..vendor.rife.rife_arch import IFNet

    model_path, arch_ver = resolve_rife_model_path(model_name)
    model = IFNet(arch_ver=arch_ver)
    state_dict = torch.load(model_path, map_location="cpu", weights_only=False)
    model.load_state_dict(state_dict)
    model.eval().to(get_torch_device())
    return model, arch_ver


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _float_value(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except Exception:
        return default
    return number if number == number else default


def _coerce_image_frames(value: Any) -> torch.Tensor | None:
    if value is None:
        return None
    if isinstance(value, torch.Tensor):
        tensor = value
    elif isinstance(value, dict):
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = value.get(key)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
    elif isinstance(value, (list, tuple)) and value and all(isinstance(item, torch.Tensor) for item in value):
        tensor = torch.cat([item if item.ndim == 4 else item.unsqueeze(0) for item in value], dim=0)
    else:
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = getattr(value, key, None)
            if isinstance(candidate, torch.Tensor):
                tensor = candidate
                break
    if tensor is None:
        return None
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        return None
    if tensor.shape[-1] not in (1, 3, 4) and tensor.shape[1] in (1, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    if tensor.shape[-1] not in (1, 3, 4):
        return None
    if tensor.shape[-1] == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif tensor.shape[-1] == 4:
        tensor = tensor[..., :3]
    return tensor.detach().float().clamp(0.0, 1.0).contiguous()


def _coerce_media_to_frames(value: Any) -> tuple[torch.Tensor, Any, float | None, bool]:
    if value is None:
        raise RuntimeError("请连接输入媒体：支持 GJJ_BATCH_IMAGE、IMAGE 或 VIDEO。")
    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception as exc:
            raise RuntimeError(f"输入可识别为 VIDEO，但读取视频帧失败：{exc}") from exc
        frames = _coerce_image_frames(_component_value(components, "images"))
        if frames is None:
            raise RuntimeError("输入 VIDEO 没有解析出有效图片帧。")
        return (
            frames,
            _component_value(components, "audio"),
            _float_value(_component_value(components, "frame_rate"), 0.0) or None,
            True,
        )

    frames = _coerce_image_frames(value)
    if frames is None:
        raise RuntimeError(f"输入不是有效的 GJJ_BATCH_IMAGE / IMAGE / VIDEO：{type(value).__name__}")
    source_audio = None
    source_fps = None
    is_video = False
    if isinstance(value, dict):
        source_audio = value.get("audio")
        for key in ("frame_rate", "fps", "source_fps"):
            if key in value:
                source_fps = _float_value(value.get(key), 0.0) or None
                is_video = True
                break
    return frames, source_audio, source_fps, is_video


class GJJ_RifeVideoInterpolator:
    CATEGORY = "GJJ"
    FUNCTION = "interpolate"
    DESCRIPTION = "将 RIFE VFI 迁移为 GJJ 零依赖单节点：支持图片队列或视频插帧，推荐使用 rife47 与 rife49。"
    SEARCH_ALIASES = ["RIFE", "RIFE VFI", "视频插帧", "插帧", "补帧", "视频补帧", "rife47", "rife49"]
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("插帧完成结果",)
    OUTPUT_TOOLTIPS = ("输入视频时输出带原音轨的新视频；输入图片队列时输出插帧后的图片队列。",)

    @classmethod
    def INPUT_TYPES(cls):
        model_choices = list_rife_models() or [DEFAULT_CKPT]
        default_model = DEFAULT_CKPT if DEFAULT_CKPT in model_choices else model_choices[0]
        return {
            "required": {
                "media": (
                    MEDIA_INPUT_TYPE,
                    {
                        "display_name": "输入媒体",
                        "tooltip": "单输入口兼容 GJJ_BATCH_IMAGE、IMAGE、VIDEO。接 VIDEO 时自动读取视频帧并尽量保留音频/源帧率；接普通图片或 GJJ 批量图片时自动整理为插帧帧序列。",
                    },
                ),
                "model_name": (
                    model_choices,
                    {
                        "default": default_model,
                        "display_name": "RIFE 模型",
                        "tooltip": "推荐使用 rife47 或 rife49；支持标准模型目录含子目录模糊匹配。",
                    },
                ),
                "multiplier": (
                    "INT",
                    {
                        "default": 2,
                        "min": 1,
                        "max": 16,
                        "step": 1,
                        "display_name": "插帧倍率",
                        "tooltip": "2 表示每相邻两帧之间补 1 帧；输出视频默认同步提升帧率以保持时长。",
                    },
                ),
                "clear_cache_after_n_frames": (
                    "INT",
                    {
                        "default": 10,
                        "min": 1,
                        "max": 1000,
                        "step": 1,
                        "display_name": "清缓存间隔",
                        "tooltip": "每处理多少个相邻帧对后清一次显存缓存；显存较小时可适当调低。",
                    },
                ),
                "fast_mode": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "快速模式",
                        "tooltip": "开启后速度更快；关闭可在部分场景下获得更稳的结果。",
                    },
                ),
                "ensemble": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "集成推理",
                        "tooltip": "双向集成推理，通常更稳但更慢。",
                    },
                ),
                "scale_factor": (
                    [0.25, 0.5, 1.0, 2.0, 4.0],
                    {
                        "default": 1.0,
                        "display_name": "尺度因子",
                        "tooltip": "按原插件逻辑传给 RIFE 的 scale 参数；通常保持 1.0 即可。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def interpolate(
        self,
        media=None,
        model_name=None,
        multiplier=2,
        clear_cache_after_n_frames=10,
        fast_mode=True,
        ensemble=True,
        scale_factor=1.0,
        input_video=None,
        input_frames=None,
        unique_id=None,
    ):
        media = media if media is not None else (input_video if input_video is not None else input_frames)
        _send_status(unique_id, "1/4 解析输入媒体...")
        input_frames, source_audio, source_fps, is_video_input = _coerce_media_to_frames(media)
        if int(input_frames.shape[0]) < 2:
            raise RuntimeError("RIFE 插帧至少需要 2 帧输入。")

        try:
            _send_status(unique_id, "2/4 加载 RIFE 模型...")
            model, arch_ver = _load_rife_model(model_name)
        except Exception as exc:
            raise RuntimeError(
                "RIFE 视频插帧节点加载模型失败。\n"
                f"模型：{model_name}\n"
                f"详细错误：{exc}"
            ) from exc

        try:
            frames = preprocess_frames(input_frames)
            pbar = comfy.utils.ProgressBar(max(1, int(frames.shape[0]) - 1))

            def progress_callback(current: int, total: int) -> None:
                pbar.update_absolute(current, total)
                _send_status(unique_id, f"3/4 插帧处理中：{current}/{total}")

            _send_status(unique_id, f"3/4 开始插帧：{frames.shape[0]} 帧，模型 {arch_ver}...")
            scale_list = [8 / float(scale_factor), 4 / float(scale_factor), 2 / float(scale_factor), 1 / float(scale_factor)]
            out = interpolate_frames(
                frames=frames,
                multiplier=int(multiplier),
                clear_cache_after_n_frames=int(clear_cache_after_n_frames),
                model=model,
                scale_list=scale_list,
                fast_mode=bool(fast_mode),
                ensemble=bool(ensemble),
                progress_callback=progress_callback,
            )
            result_frames = postprocess_frames(out)
        except Exception as exc:
            raise RuntimeError(f"RIFE 视频插帧节点执行失败。\n详细错误：{exc}") from exc
        finally:
            try:
                del model
            except Exception:
                pass
            soft_empty_cache()

        if is_video_input:
            _send_status(unique_id, "4/4 创建视频...")
            new_fps = (source_fps or 24.0) * max(1, int(multiplier))
            try:
                video_output = InputImpl.VideoFromComponents(
                    Types.VideoComponents(
                        images=result_frames,
                        audio=source_audio,
                        frame_rate=Fraction(str(new_fps)).limit_denominator(1000),
                    )
                )
            except Exception as exc:
                raise RuntimeError(f"RIFE 视频插帧节点创建输出视频失败。\n详细错误：{exc}") from exc

            _send_status(
                unique_id,
                f"完成：{int(result_frames.shape[0])} 帧 / 帧率 {new_fps:.3f} / 模型 {arch_ver}",
            )
            return (video_output,)

        _send_status(
            unique_id,
            f"完成：输出 {int(result_frames.shape[0])} 帧图像 / 模型 {arch_ver}",
        )
        return (result_frames,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_RifeVideoInterpolator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ 视频插帧（RIFE）"}
