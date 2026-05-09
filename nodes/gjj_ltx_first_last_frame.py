from __future__ import annotations

from typing import Any

import torch


NODE_NAME = "GJJ_LTX_FirstLastFrame"


def _get_ltxv_add_guide():
    try:
        from comfy_extras.nodes_lt import LTXVAddGuide
    except Exception as exc:
        raise RuntimeError(f"无法加载 ComfyUI 自带的 LTXVAddGuide：{exc}") from exc
    return LTXVAddGuide


class GJJ_LTX_FirstLastFrame:
    CATEGORY = "GJJ/视频"
    FUNCTION = "execute"
    DESCRIPTION = "为 LTX 视频潜空间添加首帧和尾帧引导，等价于串联两个 ComfyUI 自带 LTXVAddGuide。"
    SEARCH_ALIASES = [
        "ltx first last",
        "ltx first frame",
        "ltx last frame",
        "TS LTX First/Last Frame",
        "首尾帧",
        "LTX 首尾帧",
    ]
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "反向条件", "视频潜空间")
    OUTPUT_TOOLTIPS = (
        "已追加首帧/尾帧引导信息的正向条件。",
        "已追加首帧/尾帧引导信息的反向条件。",
        "写入首帧/尾帧参考 latent 和噪声遮罩后的视频潜空间。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": (
                    "VAE",
                    {
                        "display_name": "VAE",
                        "tooltip": "用于把首帧和尾帧图片编码为 LTX 引导潜空间。",
                    },
                ),
                "latent": (
                    "LATENT",
                    {
                        "display_name": "视频潜空间",
                        "tooltip": "接 EmptyLTXVLatentVideo 或上游视频 latent；输出会保留尺寸和批次。",
                    },
                ),
                "first_strength": (
                    "FLOAT",
                    {
                        "default": 0.7,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "首帧强度",
                        "tooltip": "首帧参考强度；0 表示跳过首帧引导。",
                    },
                ),
                "last_strength": (
                    "FLOAT",
                    {
                        "default": 0.7,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "尾帧强度",
                        "tooltip": "尾帧参考强度；0 表示跳过尾帧引导。",
                    },
                ),
            },
            "optional": {
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正向条件",
                        "tooltip": "接 LTXVConditioning 的正向输出；节点会在其中追加首帧/尾帧 guide 信息。",
                    },
                ),
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "反向条件",
                        "tooltip": "接 LTXVConditioning 的反向输出；会与正向条件同步追加 guide 信息。",
                    },
                ),
                "first_image": (
                    "IMAGE",
                    {
                        "display_name": "首帧图片",
                        "tooltip": "可选首帧参考图；连接后写入第 0 帧。",
                    },
                ),
                "last_image": (
                    "IMAGE",
                    {
                        "display_name": "尾帧图片",
                        "tooltip": "可选尾帧参考图；连接后写入最后一帧。",
                    },
                ),
            },
        }

    @staticmethod
    def _is_valid_image(value: Any) -> bool:
        return isinstance(value, torch.Tensor) and not GJJ_LTX_FirstLastFrame._is_empty_loader_placeholder(value)

    @staticmethod
    def _is_empty_loader_placeholder(value: Any) -> bool:
        if not isinstance(value, torch.Tensor):
            return False
        if value.ndim != 4:
            return False
        if int(value.shape[0]) != 1 or int(value.shape[1]) != 64 or int(value.shape[2]) != 64:
            return False
        try:
            return float(value.detach().abs().amax().item()) <= 1e-7
        except Exception:
            return False

    @staticmethod
    def _log(message: str) -> None:
        print(f"[GJJ_LTX_FirstLastFrame] {message}")

    @staticmethod
    def _clone_latent(latent: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(latent, dict) or "samples" not in latent:
            raise RuntimeError("视频潜空间无效：缺少 samples。")

        samples = latent["samples"]
        if not isinstance(samples, torch.Tensor):
            raise RuntimeError("视频潜空间无效：samples 不是张量。")

        cloned = {"samples": samples.clone()}
        if "noise_mask" in latent and latent["noise_mask"] is not None:
            noise_mask = latent["noise_mask"]
            cloned["noise_mask"] = noise_mask.clone() if isinstance(noise_mask, torch.Tensor) else noise_mask

        for key, value in latent.items():
            if key not in cloned:
                cloned[key] = value
        return cloned

    @staticmethod
    def _unpack_node_output(node_output):
        if hasattr(node_output, "result"):
            return node_output.result
        return node_output

    def execute(
        self,
        vae,
        latent: dict[str, Any],
        first_strength: float,
        last_strength: float,
        positive=None,
        negative=None,
        first_image: torch.Tensor | None = None,
        last_image: torch.Tensor | None = None,
    ):
        positive_out = positive
        negative_out = negative
        latent_out = self._clone_latent(latent)

        has_first = self._is_valid_image(first_image)
        has_last = self._is_valid_image(last_image)
        if self._is_empty_loader_placeholder(first_image):
            self._log("首帧图片是 64x64 空占位图，已忽略。")
        if self._is_empty_loader_placeholder(last_image):
            self._log("尾帧图片是 64x64 空占位图，已忽略。")

        if not has_first and not has_last:
            self._log("未连接首帧或尾帧，直接透传。")
            return (positive_out, negative_out, latent_out)

        if positive_out is None:
            self._log("未连接正向条件，跳过引导。")
            return (None, negative_out if negative_out is not None else None, latent_out)

        LTXVAddGuide = _get_ltxv_add_guide()

        try:
            if has_first and float(first_strength) > 0.0:
                self._log("写入首帧引导。")
                positive_out, negative_out, latent_out = self._unpack_node_output(
                    LTXVAddGuide.execute(
                        positive=positive_out,
                        negative=negative_out,
                        vae=vae,
                        latent=latent_out,
                        image=first_image,
                        frame_idx=0,
                        strength=float(first_strength),
                    )
                )

            if has_last and float(last_strength) > 0.0:
                self._log("写入尾帧引导。")
                positive_out, negative_out, latent_out = self._unpack_node_output(
                    LTXVAddGuide.execute(
                        positive=positive_out,
                        negative=negative_out,
                        vae=vae,
                        latent=latent_out,
                        image=last_image,
                        frame_idx=-1,
                        strength=float(last_strength),
                    )
                )
        except Exception as exc:
            raise RuntimeError(f"LTX 首尾帧引导失败：{exc}") from exc

        return (positive_out, negative_out, latent_out)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTX_FirstLastFrame}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 LTX 首尾帧引导"}
