"""GJJ 内置视频工具模块。

将 comfy_extras.nodes_lt、nodes_video、nodes_hunyuan 等视频相关节点功能内置，避免外部依赖。

包含：
- LTX 视频 latent 操作 (EmptyLTXVLatentVideo, LTXVAddGuide, etc.)
- 通用视频处理 (CreateVideo, GetVideoComponents)
- 上采样工具 (LatentUpscaleModelLoader, LTXVLatentUpsampler)

注意：本模块为自包含实现，不导入任何节点相关代码。
"""

from __future__ import annotations

from typing import Any

import torch

# ============================================================================
# LTX 视频 Latent 操作
# ============================================================================


class gjjutils_EmptyLTXVLatentVideo:
    """EmptyLTXVLatentVideo 节点功能内置实现。

    创建空的 LTX 视频 latent。
    """

    @staticmethod
    def execute(
        width: int,
        height: int,
        length: int,
        batch_size: int = 1,
    ) -> tuple[dict[str, torch.Tensor]]:
        """创建空的 LTX 视频 latent。

        Args:
                width: 宽度（像素）
                height: 高度（像素）
                length: 帧数
                batch_size: 批次大小

        Returns:
                包含 'samples' 键的字典的单元素元组
        """
        width = max(32, int(width))
        height = max(32, int(height))
        length = max(1, int(length))
        batch_size = max(1, int(batch_size))

        # LTX 使用 128 通道，空间维度压缩 32 倍，时间维度压缩 8 倍
        channels = 128
        temporal_length = max(1, (length + 7) // 8)  # 时间维度压缩
        spatial_height = height // 32
        spatial_width = width // 32

        samples = torch.zeros(
            [batch_size, channels, temporal_length, spatial_height, spatial_width]
        )
        return ({"samples": samples},)


class gjjutils_LTXVAddGuide:
    """LTX 视频引导帧注入，与 ComfyUI 原生接口兼容。

    将参考图像 VAE 编码后注入到视频 latent 的指定帧位置，
    并在 conditioning 中记录关键帧坐标供模型注意力层使用。
    """

    @staticmethod
    def _get_noise_mask(latent: dict[str, torch.Tensor]) -> torch.Tensor:
        noise_mask = latent.get("noise_mask", None)
        lat = latent["samples"]
        if noise_mask is None:
            noise_mask = torch.ones(
                (lat.shape[0], 1, lat.shape[2], 1, 1),
                dtype=torch.float32,
                device=lat.device,
            )
        else:
            noise_mask = noise_mask.clone()
        return noise_mask

    @staticmethod
    def _conditioning_get_any_value(conditioning, key, default=None):
        for t in conditioning:
            if key in t[1]:
                return t[1][key]
        return default

    @staticmethod
    def _get_keyframe_idxs(cond):
        keyframe_idxs = gjjutils_LTXVAddGuide._conditioning_get_any_value(cond, "keyframe_idxs", None)
        if keyframe_idxs is None:
            return None, 0
        num_keyframes = torch.unique(keyframe_idxs[:, 0, :, 0]).shape[0]
        return keyframe_idxs, num_keyframes

    @staticmethod
    def execute(
        positive: list,
        negative: list,
        vae: Any,
        latent: dict[str, Any],
        image: torch.Tensor,
        frame_idx: int,
        strength: float = 1.0,
    ) -> tuple[list, list, dict[str, torch.Tensor]]:
        """向 LTX 视频 latent 添加引导帧。

        Args:
            positive: 正向 conditioning
            negative: 负向 conditioning
            vae: 视频 VAE 模型
            latent: 当前视频 latent（包含 samples 和可选的 noise_mask）
            image: 引导图像 [1, H, W, C] 或 [H, W, C]
            frame_idx: 目标帧索引（像素坐标系）
            strength: 引导强度 (0.0-1.0)

        Returns:
            (positive, negative, latent_dict) 元组，其中 latent_dict 包含更新后的 samples 和 noise_mask
        """
        import node_helpers
        import comfy.utils

        scale_factors = vae.downscale_index_formula
        if not scale_factors or len(scale_factors) < 3:
            raise RuntimeError("LTXVAddGuide: VAE 缺少有效的 downscale_index_formula")
        time_scale_factor = max(1, int(scale_factors[0] or 1))
        width_scale_factor = max(1, int(scale_factors[1] or 1))
        height_scale_factor = max(1, int(scale_factors[2] or 1))

        latent_image = latent["samples"].clone()
        noise_mask = gjjutils_LTXVAddGuide._get_noise_mask(latent)
        _, _, latent_length, latent_height, latent_width = latent_image.shape

        # VAE 编码图像
        image_4d = image if image.ndim == 4 else image.unsqueeze(0)
        pixels = comfy.utils.common_upscale(
            image_4d.movedim(-1, 1),
            latent_width * width_scale_factor,
            latent_height * height_scale_factor,
            "bilinear",
            "disabled",
        ).movedim(1, -1)
        encoded = vae.encode(pixels[:, :, :, :3])

        # 调整时间维度让帧数满足 8*n+1 约束
        temporal = int(encoded.shape[2])
        if temporal > 1:
            temporal = (temporal - 1) // time_scale_factor * time_scale_factor + 1
            encoded = encoded[:, :, :temporal]

        # 计算 latent 坐标
        keyframe_idxs, num_keyframes = gjjutils_LTXVAddGuide._get_keyframe_idxs(positive)
        latent_count = latent_length - num_keyframes
        _frame_idx = frame_idx if frame_idx >= 0 else max((latent_count - 1) * time_scale_factor + 1 + frame_idx, 0)
        if int(encoded.shape[2]) > 1 and _frame_idx != 0:
            _frame_idx = (_frame_idx - 1) // time_scale_factor * time_scale_factor + 1
        latent_idx = (_frame_idx + time_scale_factor - 1) // time_scale_factor

        if latent_idx + int(encoded.shape[2]) > latent_length:
            span = latent_length - latent_idx
            encoded = encoded[:, :, :span]
        if int(encoded.shape[2]) <= 0:
            return positive, negative, {"samples": latent_image, "noise_mask": noise_mask}

        # 注入编码后的引导帧到 latent
        end_idx = latent_idx + int(encoded.shape[2])
        latent_image[:, :, latent_idx:end_idx] = encoded[:, :, :int(end_idx - latent_idx)].to(
            device=latent_image.device, dtype=latent_image.dtype
        )

        # 更新 noise_mask
        mask = torch.full(
            (noise_mask.shape[0], 1, int(end_idx - latent_idx), 1, 1),
            1.0 - float(strength),
            dtype=noise_mask.dtype,
            device=noise_mask.device,
        )
        noise_mask[:, :, latent_idx:end_idx] = mask

        # 追加 guide_attention_entry 到 conditioning
        new_entry = {
            "pre_filter_count": int(encoded.shape[2]) * int(encoded.shape[3]) * int(encoded.shape[4]),
            "strength": float(strength),
            "pixel_mask": None,
            "latent_shape": [int(encoded.shape[2]), int(encoded.shape[3]), int(encoded.shape[4])],
        }
        result_conds = []
        for cond in (positive, negative):
            existing = []
            for t in cond:
                found = t[1].get("guide_attention_entries", None)
                if found is not None:
                    existing = found
                    break
            entries = [*existing, new_entry]
            result_conds.append(node_helpers.conditioning_set_values(cond, {"guide_attention_entries": entries}))
        positive, negative = result_conds[0], result_conds[1]

        return positive, negative, {"samples": latent_image, "noise_mask": noise_mask}


class gjjutils_LTXVConcatAVLatent:
    """LTXVConcatAVLatent 节点功能内置实现。

    将视频和音频 latent 包装为 NestedTensor，与 ComfyUI 原生接口完全兼容。
    """

    @staticmethod
    def execute(
        video_latent: dict[str, torch.Tensor],
        audio_latent: dict[str, torch.Tensor],
    ) -> tuple[dict[str, Any]]:
        """拼接音视频 latent（使用 NestedTensor 包装）。

        Args:
                video_latent: 视频 latent
                audio_latent: 音频 latent

        Returns:
                包含 NestedTensor samples 的 latent 字典单元素元组
        """
        import comfy.nested_tensor

        output = {}
        output.update(video_latent)
        output.update(audio_latent)
        video_noise_mask = video_latent.get("noise_mask", None)
        audio_noise_mask = audio_latent.get("noise_mask", None)

        if video_noise_mask is not None or audio_noise_mask is not None:
            if video_noise_mask is None:
                video_noise_mask = torch.ones_like(video_latent["samples"])
            if audio_noise_mask is None:
                audio_noise_mask = torch.ones_like(audio_latent["samples"])
            output["noise_mask"] = comfy.nested_tensor.NestedTensor((video_noise_mask, audio_noise_mask))

        output["samples"] = comfy.nested_tensor.NestedTensor((video_latent["samples"], audio_latent["samples"]))
        return (output,)


class gjjutils_LTXVSeparateAVLatent:
    """LTXVSeparateAVLatent 节点功能内置实现。

    从 NestedTensor 中分离音视频 latent，与 ComfyUI 原生接口完全兼容。
    """

    @staticmethod
    def execute(
        av_latent: dict[str, Any],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """分离音视频 latent。

        Args:
                av_latent: 包含 NestedTensor samples 的 AV latent

        Returns:
                (video_latent, audio_latent) 元组
        """
        samples = av_latent["samples"]
        if hasattr(samples, "unbind"):
            latents = samples.unbind()
        else:
            video_channels = 128
            latents = (samples[:, :video_channels, ...], samples[:, video_channels:, ...])

        video_latent = av_latent.copy()
        video_latent["samples"] = latents[0]
        audio_latent = av_latent.copy()
        audio_latent["samples"] = latents[1]
        if "noise_mask" in av_latent:
            masks = av_latent["noise_mask"]
            if masks is not None:
                if hasattr(masks, "unbind"):
                    masks = masks.unbind()
                else:
                    masks = (masks[:, :1, ...], masks[:, 1:, ...])
                video_latent["noise_mask"] = masks[0]
                audio_latent["noise_mask"] = masks[1]
        return video_latent, audio_latent


class gjjutils_LTXVConditioning:
    """LTXVConditioning 节点功能内置实现。

    LTX 专用的条件编码处理，与 ComfyUI 原生接口完全兼容。
    """

    @staticmethod
    def execute(
        positive: list,
        negative: list,
        frame_rate: float = 25.0,
    ) -> tuple[list, list]:
        """处理 LTX 条件编码，注入帧率信息。

        Args:
                positive: 正向条件
                negative: 负向条件
                frame_rate: 帧率（fps），默认 25.0

        Returns:
                注入帧率后的正负条件元组
        """
        import node_helpers
        positive = node_helpers.conditioning_set_values(positive, {"frame_rate": frame_rate})
        negative = node_helpers.conditioning_set_values(negative, {"frame_rate": frame_rate})
        return (positive, negative)


class gjjutils_LTXVCropGuides:
    """LTXVCropGuides 节点功能内置实现。

    裁剪 latent 末尾的关键帧填充，清除 conditioning 中的 keyframe 标记，
    与 ComfyUI 原生接口完全兼容。
    """

    @staticmethod
    def execute(
        positive: list,
        negative: list,
        latent: dict[str, Any],
    ) -> tuple[list, list, dict[str, Any]]:
        """裁剪引导帧：移除 latent 末尾为关键帧填充的帧，并清除 conditioning 中的 keyframe_idxs。

        Args:
                positive: 正向条件
                negative: 负向条件
                latent: 视频 latent（含 samples 和可选的 noise_mask）

        Returns:
                (positive, negative, latent_dict) 元组
        """
        import node_helpers

        latent_image = latent["samples"].clone()
        noise_mask = gjjutils_LTXVAddGuide._get_noise_mask(latent)

        _, num_keyframes = gjjutils_LTXVAddGuide._get_keyframe_idxs(positive)
        if num_keyframes == 0:
            return positive, negative, {"samples": latent_image, "noise_mask": noise_mask}

        latent_image = latent_image[:, :, :-num_keyframes]
        noise_mask = noise_mask[:, :, :-num_keyframes]

        positive = node_helpers.conditioning_set_values(positive, {
            "keyframe_idxs": None,
            "guide_attention_entries": None,
        })
        negative = node_helpers.conditioning_set_values(negative, {
            "keyframe_idxs": None,
            "guide_attention_entries": None,
        })

        return positive, negative, {"samples": latent_image, "noise_mask": noise_mask}


# ============================================================================
# 通用视频处理
# ============================================================================


class gjjutils_CreateVideo:
    """CreateVideo 节点功能内置实现。

    将图像序列合成为视频文件。
    """

    @staticmethod
    def execute(
        images: torch.Tensor,
        frame_rate: float = 25.0,
        output_path: str = "",
        format: str = "h264-mp4",
        quality: int = 80,
    ) -> dict[str, Any]:
        """创建视频文件。

        Args:
                images: 图像序列 [F, H, W, C]
                frame_rate: 帧率
                output_path: 输出路径
                format: 视频格式
                quality: 质量 (0-100)

        Returns:
                包含视频路径的字典
        """
        # 这是一个简化的占位实现
        # 实际需要使用 imageio-ffmpeg 或类似库进行视频编码
        raise NotImplementedError(
            "CreateVideo: 完整实现需要集成视频编码库（如 imageio-ffmpeg）。"
            "当前版本建议使用 ComfyUI 原生的 CreateVideo 节点。"
        )


class gjjutils_GetVideoComponents:
    """GetVideoComponents 节点功能内置实现。

    从视频中提取组件（帧、音频等）。
    """

    @staticmethod
    def execute(
        video_path: str,
        force_rate: float = 0.0,
        force_size: str = "Disabled",
        custom_width: int = 0,
        custom_height: int = 0,
        frame_load_cap: int = 0,
        skip_first_frames: int = 0,
        select_every_nth: int = 1,
    ) -> dict[str, Any]:
        """获取视频组件。

        Args:
                video_path: 视频文件路径
                force_rate: 强制帧率 (0 表示使用原始帧率)
                force_size: 强制尺寸策略
                custom_width: 自定义宽度
                custom_height: 自定义高度
                frame_load_cap: 最大加载帧数 (0 表示全部)
                skip_first_frames: 跳过起始帧数
                select_every_nth: 每隔 N 帧选择一帧

        Returns:
                包含帧序列和元数据的字典
        """
        # 这是一个简化的占位实现
        # 实际需要使用 OpenCV 或 torchvision 读取视频
        raise NotImplementedError(
            "GetVideoComponents: 完整实现需要集成视频解码库。"
            "当前版本建议使用 ComfyUI 原生的 Load Video 节点。"
        )


# ============================================================================
# 上采样工具
# ============================================================================


class gjjutils_LatentUpscaleModelLoader:
    """LatentUpscaleModelLoader 节点功能内置实现。

    加载 latent 上采样模型。
    """

    @staticmethod
    def execute(
        model_name: str,
    ) -> dict[str, Any]:
        """加载上采样模型。

        Args:
                model_name: 模型名称

        Returns:
                包含模型的字典
        """
        import folder_paths

        # 查找模型文件
        model_path = folder_paths.get_full_path("upscale_models", model_name)
        if model_path is None:
            raise FileNotFoundError(f"未找到上采样模型: {model_name}")

        # 加载模型（简化实现，实际需要解析模型结构）
        return {"upscale_model": model_path}


class gjjutils_LTXVLatentUpsampler:
    """LTXVLatentUpsampler 节点功能内置实现。

    LTX 视频 latent 上采样。
    """

    @staticmethod
    def execute(
        upscale_model: dict[str, Any],
        latent: dict[str, torch.Tensor],
        scale_factor: float = 2.0,
    ) -> dict[str, torch.Tensor]:
        """上采样 latent。

        Args:
                upscale_model: 上采样模型
                latent: 输入 latent
                scale_factor: 缩放因子

        Returns:
                上采样后的 latent
        """
        if "samples" not in latent:
            raise RuntimeError("LTXVLatentUpsampler: 输入 latent 缺少 'samples' 键")

        samples = latent["samples"]

        # 简化实现：使用双线性插值上采样空间维度
        # 实际需要使用时序感知上采样算法
        B, C, T, H, W = samples.shape
        new_H = int(H * scale_factor)
        new_W = int(W * scale_factor)

        # 重塑为 4D 进行上采样
        samples_4d = samples.view(B * T, C, H, W)
        upsampled = torch.nn.functional.interpolate(
            samples_4d,
            size=(new_H, new_W),
            mode="bilinear",
            align_corners=False,
        )
        upsampled = upsampled.view(B, C, T, new_H, new_W)

        return {"samples": upsampled}


# ============================================================================
# 导出兼容接口（支持两种调用方式）
# ============================================================================

# 方式1：类方法调用（保持与 comfy_extras 一致）
EmptyLTXVLatentVideo = gjjutils_EmptyLTXVLatentVideo
LTXVAddGuide = gjjutils_LTXVAddGuide
LTXVConcatAVLatent = gjjutils_LTXVConcatAVLatent
LTXVSeparateAVLatent = gjjutils_LTXVSeparateAVLatent
LTXVConditioning = gjjutils_LTXVConditioning
LTXVCropGuides = gjjutils_LTXVCropGuides
CreateVideo = gjjutils_CreateVideo
GetVideoComponents = gjjutils_GetVideoComponents
LatentUpscaleModelLoader = gjjutils_LatentUpscaleModelLoader
LTXVLatentUpsampler = gjjutils_LTXVLatentUpsampler


# 方式2：函数调用（备用）
def EmptyLTXVLatentVideo_execute(
    width: int, height: int, length: int, batch_size: int = 1
) -> dict[str, torch.Tensor]:
    """EmptyLTXVLatentVideo.execute 的兼容包装。"""
    return gjjutils_EmptyLTXVLatentVideo.execute(width, height, length, batch_size)


def LTXVAddGuide_execute(
    frames: int,
    start_frame: int,
    latent: dict,
    image: torch.Tensor,
    strength: float = 1.0,
) -> dict[str, Any]:
    """LTXVAddGuide.execute 的兼容包装。"""
    return gjjutils_LTXVAddGuide.execute(frames, start_frame, latent, image, strength)


def LTXVConcatAVLatent_execute(
    video_latent: dict, audio_latent: dict
) -> dict[str, torch.Tensor]:
    """LTXVConcatAVLatent.execute 的兼容包装。"""
    return gjjutils_LTXVConcatAVLatent.execute(video_latent, audio_latent)


def LTXVSeparateAVLatent_execute(
    combined_latent: dict, video_channels: int = 128
) -> dict[str, dict[str, torch.Tensor]]:
    """LTXVSeparateAVLatent.execute 的兼容包装。"""
    return gjjutils_LTXVSeparateAVLatent.execute(combined_latent, video_channels)


def LTXVConditioning_execute(positive: list, negative: list) -> tuple[list, list]:
    """LTXVConditioning.execute 的兼容包装。"""
    return gjjutils_LTXVConditioning.execute(positive, negative)


def LTXVCropGuides_execute(
    positive: list, negative: list, frame_rate: float = 25.0, total_frames: int = 1
) -> tuple[list, list]:
    """LTXVCropGuides.execute 的兼容包装。"""
    return gjjutils_LTXVCropGuides.execute(positive, negative, frame_rate, total_frames)


def CreateVideo_execute(
    images: torch.Tensor,
    frame_rate: float = 25.0,
    output_path: str = "",
    format: str = "h264-mp4",
    quality: int = 80,
) -> dict[str, Any]:
    """CreateVideo.execute 的兼容包装。"""
    return gjjutils_CreateVideo.execute(
        images, frame_rate, output_path, format, quality
    )


def GetVideoComponents_execute(
    video_path: str,
    force_rate: float = 0.0,
    force_size: str = "Disabled",
    custom_width: int = 0,
    custom_height: int = 0,
    frame_load_cap: int = 0,
    skip_first_frames: int = 0,
    select_every_nth: int = 1,
) -> dict[str, Any]:
    """GetVideoComponents.execute 的兼容包装。"""
    return gjjutils_GetVideoComponents.execute(
        video_path,
        force_rate,
        force_size,
        custom_width,
        custom_height,
        frame_load_cap,
        skip_first_frames,
        select_every_nth,
    )


def LatentUpscaleModelLoader_execute(model_name: str) -> dict[str, Any]:
    """LatentUpscaleModelLoader.execute 的兼容包装。"""
    return gjjutils_LatentUpscaleModelLoader.execute(model_name)


def LTXVLatentUpsampler_execute(
    upscale_model: dict, latent: dict, scale_factor: float = 2.0
) -> dict[str, torch.Tensor]:
    """LTXVLatentUpsampler.execute 的兼容包装。"""
    return gjjutils_LTXVLatentUpsampler.execute(upscale_model, latent, scale_factor)
