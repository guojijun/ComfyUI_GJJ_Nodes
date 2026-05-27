from __future__ import annotations

import json
from typing import Any

import torch


NODE_NAME = "GJJ_LTXVAddGuideMulti"


class FlexibleGuideImageInputs(dict):
    """允许前端按 guide_count 动态添加 image_2、image_3 ... 输入。"""

    def __getitem__(self, key):
        if str(key).startswith("image_"):
            return (
                "IMAGE",
                {
                    "display_name": "引导图像",
                    "tooltip": "动态引导图像输入，由前端按引导数量自动增减。",
                },
            )
        raise KeyError(key)

    def __contains__(self, key):
        return str(key).startswith("image_")


def _to_int(value: Any, default: int = 0) -> int:
    try:
        if isinstance(value, (list, tuple)) and len(value) == 1:
            value = value[0]
        return int(float(value))
    except Exception:
        return default


def _to_float(value: Any, default: float = 1.0) -> float:
    try:
        if isinstance(value, (list, tuple)) and len(value) == 1:
            value = value[0]
        return float(value)
    except Exception:
        return default


def _parse_settings(raw: Any) -> dict[str, dict[str, Any]]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, (list, tuple)) and len(raw) == 1:
        raw = raw[0]
    try:
        data = json.loads(str(raw or "{}"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _runtime_ltx_tools():
    try:
        from comfy_extras.nodes_lt import LTXVAddGuide, get_noise_mask

        return LTXVAddGuide, get_noise_mask
    except Exception as exc:
        raise RuntimeError(
            f"无法加载 ComfyUI 内置 LTX 引导工具：{exc}。请确认当前 ComfyUI 版本包含 comfy_extras.nodes_lt。"
        ) from exc


def _check_image(index: int, value: Any) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise RuntimeError(f"引导图像 {index} 未连接 IMAGE。")
    if value.ndim != 4:
        raise RuntimeError(f"引导图像 {index} 格式不正确，应为 ComfyUI IMAGE：BHWC 张量。")
    return value


class GJJ_LTXVAddGuideMulti:
    CATEGORY = "GJJ/LTX"
    FUNCTION = "execute"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "视频Latent")
    OUTPUT_TOOLTIPS = (
        "已追加多图 guide keyframe 信息的正向 conditioning。",
        "已追加多图 guide keyframe 信息的负向 conditioning。",
        "插入多张 guide latent 与 noise_mask 后的视频 latent。",
    )
    DESCRIPTION = "复刻 KJNodes 的 LTXVAddGuideMulti：为 LTX 视频 latent 在多个帧位置插入多张引导图像。"
    SEARCH_ALIASES = [
        "LTXVAddGuideMulti",
        "LTXV Add Guide Multi",
        "ltx guide multi",
        "多图引导",
        "多帧引导",
        "LTX引导",
    ]
    GJJ_HELP = {
        "description": DESCRIPTION,
        "notes": [
            "不依赖 KJNodes；底层调用 ComfyUI 自带 comfy_extras.nodes_lt.LTXVAddGuide。",
            "引导数量会动态生成 image_1、image_2 ... 输入槽。",
            "每张图的帧序号和强度在节点面板中设置，帧序号支持负数从视频末尾计数。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正向条件",
                        "tooltip": "需要加入 guide keyframe 信息的正向 conditioning。",
                    },
                ),
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "负向条件",
                        "tooltip": "需要加入 guide keyframe 信息的负向 conditioning。",
                    },
                ),
                "vae": (
                    "VAE",
                    {
                        "display_name": "视频VAE",
                        "tooltip": "用于把引导图像编码到 LTX 视频 latent 空间的 VAE。",
                    },
                ),
                "latent": (
                    "LATENT",
                    {
                        "display_name": "视频Latent",
                        "tooltip": "要插入 guide 帧的视频 latent。",
                    },
                ),
                "guide_count": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 20,
                        "step": 1,
                        "display_name": "引导数量",
                        "tooltip": "需要使用的引导图像数量；前端会自动显示对应的 IMAGE 输入槽。",
                    },
                ),
                "guide_settings_json": (
                    "STRING",
                    {
                        "default": "{}",
                        "multiline": False,
                        "display_name": "引导设置",
                        "tooltip": "前端面板自动维护的帧序号和强度数据。",
                    },
                ),
                "image_1": (
                    "IMAGE",
                    {
                        "display_name": "引导图像 1",
                        "tooltip": "第 1 张要插入到 LTX 视频 latent 的引导图像。",
                    },
                ),
            },
            "optional": FlexibleGuideImageInputs(),
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def execute(
        self,
        positive,
        negative,
        vae,
        latent,
        guide_count=1,
        guide_settings_json="{}",
        image_1=None,
        **kwargs,
    ):
        if not isinstance(latent, dict) or "samples" not in latent:
            raise RuntimeError("视频 Latent 格式不正确，缺少 samples。")

        LTXVAddGuide, get_noise_mask = _runtime_ltx_tools()

        count = max(1, min(20, _to_int(guide_count, 1)))
        settings = _parse_settings(guide_settings_json)
        scale_factors = getattr(vae, "downscale_index_formula", None)
        if not scale_factors or len(scale_factors) < 3:
            raise RuntimeError("视频 VAE 缺少 downscale_index_formula，无法计算 LTX guide 位置。")

        latent_image = latent["samples"].clone()
        noise_mask = get_noise_mask(latent)
        if hasattr(noise_mask, "clone"):
            noise_mask = noise_mask.clone()

        if latent_image.ndim != 5:
            raise RuntimeError("LTX 视频 Latent 应为 5D 张量：(batch, channels, frames, height, width)。")
        _, _, latent_length, latent_height, latent_width = latent_image.shape

        for index in range(1, count + 1):
            image = image_1 if index == 1 else kwargs.get(f"image_{index}")
            image = _check_image(index, image)
            item = settings.get(str(index), {})
            if not isinstance(item, dict):
                item = {}
            frame_idx = _to_int(item.get("frame_idx"), 0)
            strength = max(0.0, min(1.0, _to_float(item.get("strength"), 1.0)))

            image_pixels, guide_latent = LTXVAddGuide.encode(
                vae,
                latent_width,
                latent_height,
                image,
                scale_factors,
            )
            keyframe_frame_idx, latent_idx = LTXVAddGuide.get_latent_index(
                positive,
                latent_length,
                len(image_pixels),
                frame_idx,
                scale_factors,
            )
            if latent_idx + guide_latent.shape[2] > latent_length:
                raise RuntimeError(
                    f"第 {index} 张引导图像超出 latent 长度：起始帧 {frame_idx}，"
                    f"latent 索引 {latent_idx}，引导长度 {guide_latent.shape[2]}，总长度 {latent_length}。"
                )

            positive, negative, latent_image, noise_mask = LTXVAddGuide.append_keyframe(
                positive,
                negative,
                keyframe_frame_idx,
                latent_image,
                noise_mask,
                guide_latent,
                strength,
                scale_factors,
            )

        output = dict(latent)
        output["samples"] = latent_image
        output["noise_mask"] = noise_mask
        return (positive, negative, output)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTXVAddGuideMulti}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 LTX多图引导"}
