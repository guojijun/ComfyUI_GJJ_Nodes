import torch
import comfy
import comfy_extras.nodes_lt as nodes_lt

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"


def _component_value(value, key):
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value):
    if not hasattr(value, "get_components"):
        return None
    try:
        components = value.get_components()
    except Exception:
        return None
    if isinstance(components, dict):
        return components
    return {
        "images": _component_value(components, "images"),
        "frames": _component_value(components, "frames"),
        "audio": _component_value(components, "audio"),
        "frame_rate": _component_value(components, "frame_rate"),
    }


def _iter_container_values(obj):
    if obj is None or isinstance(obj, (str, bytes, bytearray)) or torch.is_tensor(obj):
        return []
    if isinstance(obj, dict):
        return list(obj.values())
    if isinstance(obj, (list, tuple, set)):
        return list(obj)

    values = []
    for name in (
        "images", "image", "imgs", "frames", "frame", "batch", "queue", "items",
        "data", "samples", "outputs", "values", "selected", "selected_images",
        "image_list", "image_queue", "pictures", "pics",
    ):
        try:
            if hasattr(obj, name):
                value = getattr(obj, name)
                if value is not None and value is not obj:
                    values.append(value)
        except Exception:
            pass
    try:
        values.extend(vars(obj).values())
    except Exception:
        pass
    return values


def _normalize_image_tensor(tensor):
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"IC-LoRA Guide 输入帧必须是 [B,H,W,C] 或 [B,C,H,W]，实际为 {tuple(tensor.shape)}。")
    if tensor.shape[-1] not in (1, 2, 3, 4) and tensor.shape[1] in (1, 2, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 2:
        tensor = tensor[..., :1].repeat(1, 1, 1, 3)
    elif channels == 4:
        tensor = tensor[..., :3]
    elif channels > 4:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"IC-LoRA Guide 输入帧通道数无效：{tuple(tensor.shape)}。")
    return tensor.detach().float().clamp(0.0, 1.0).contiguous()


def _collect_single_frames(value, _seen=None):
    if _seen is None:
        _seen = set()
    if value is None:
        return []

    obj_id = id(value)
    if obj_id in _seen:
        return []
    _seen.add(obj_id)

    components = _video_components(value)
    if components is not None:
        frames = components.get("images", None)
        if frames is None:
            frames = components.get("frames", None)
        return _collect_single_frames(frames, _seen)

    if isinstance(value, torch.Tensor):
        tensor = _normalize_image_tensor(value)
        return [tensor[index:index + 1].contiguous() for index in range(int(tensor.shape[0]))]

    frames = []
    for item in _iter_container_values(value):
        frames.extend(_collect_single_frames(item, _seen))
    return frames


def _resize_frame(frame, target_width, target_height):
    if int(frame.shape[1]) == int(target_height) and int(frame.shape[2]) == int(target_width):
        return frame.contiguous()
    return comfy.utils.common_upscale(
        frame.movedim(-1, 1),
        int(target_width),
        int(target_height),
        "bilinear",
        crop="disabled",
    ).movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _expand_msr_frames(frames, frame_count):
    if not frames:
        return []
    frame_count = max(1, int(frame_count))
    base_count = frame_count // len(frames)
    remainder = frame_count % len(frames)
    output = []
    for index, frame in enumerate(frames):
        repeats = base_count + (1 if index < remainder else 0)
        output.extend([frame] * repeats)
    return output


def _normalize_frame_count(value):
    try:
        count = int(value)
    except Exception:
        count = 33
    if count not in (17, 25, 33, 41):
        count = 33
    return count


def _get_guide_attention_entries(conditioning):
    """从 conditioning 中读取当前的 guide_attention_entries 列表。"""
    for t in conditioning:
        entries = t[1].get("guide_attention_entries", None)
        if entries is not None:
            return entries
    return []


def _set_guide_attention_entries(conditioning, entries):
    """将 guide_attention_entries 写入 conditioning（不可变更新）。"""
    import node_helpers
    return node_helpers.conditioning_set_values(
        conditioning, {"guide_attention_entries": entries}
    )


def append_guide_attention_entry(conditioning, pre_filter_count, latent_shape, attention_strength=1.0, attention_mask=None):
    """向 conditioning 元数据追加新的 guide attention 条目。"""
    existing_entries = _get_guide_attention_entries(conditioning)
    entries = [*existing_entries]
    entries.append({
        "pre_filter_count": pre_filter_count,
        "strength": attention_strength,
        "pixel_mask": attention_mask,
        "latent_shape": latent_shape,
    })
    return _set_guide_attention_entries(conditioning, entries)


def get_noise_mask(latent):
    """从 latent 中获取 noise_mask，如果不存在则创建全 1 的 mask。"""
    return nodes_lt.get_noise_mask(latent)


class GJJ_AddVideoICLoRAGuide:
    """
    向视频 latent 添加一个或多个条件帧，从指定帧索引开始。
    支持单帧图像和多帧视频。
    
    特性：
    - 将 IC-LoRA guide 条件添加到视频 latent
    - 支持 latent_downscale_factor 用于小网格上的 IC-LoRA
    - 自动处理时间缩放因子
    - 支持平铺 VAE 编码以减少内存使用
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "positive": ("CONDITIONING", {"display_name": "正向条件", "tooltip": "正向 conditioning"}),
                "negative": ("CONDITIONING", {"display_name": "负向条件", "tooltip": "负向 conditioning"}),
                "vae": ("VAE", {"display_name": "VAE", "tooltip": "用于编码图像的 VAE 模型"}),
                "latent": ("LATENT", {"display_name": "视频 Latent", "tooltip": "要条件化的视频 latent，必须是 5D 张量 (batch, channels, frames, height, width)"}),
                "frame_idx": ("INT", {"default": 0, "min": -9999, "max": 9999,
                                     "display_name": "起始帧索引", "tooltip": "开始条件化的帧索引。对于单帧视频，任何值都可接受。对于视频，值会被向下取整到最接近的 8 的倍数。负值从视频末尾计数。"}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                                      "display_name": "强度", "tooltip": "条件化强度"}),
                "latent_downscale_factor": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 10.0, "step": 1.0,
                                                      "display_name": "Latent 缩放因子", "tooltip": "用于小网格 IC-LoRA。1 表示原始尺寸，2 表示一半尺寸，3 表示三分之一，依此类推。"}),
            },
            "optional": {
                "image": (MEDIA_INPUT_TYPE, {"display_name": "引导图像", "tooltip": "可选。支持 GJJ_BATCH_IMAGE、普通 IMAGE 批次和 VIDEO；会先解包为单帧图片，再按 LiconMSR 逻辑生成 guide 帧序列。"}),
                "crop": (["disabled", "center"], {"default": "disabled", 
                                                  "display_name": "裁剪模式", "tooltip": "调整大小时的裁剪模式。'center' 裁剪以适应，'disabled' 拉伸以适应。"}),
                "use_tiled_encode": ("BOOLEAN", {"default": False, 
                                                 "display_name": "使用平铺编码", "tooltip": "启用平铺 VAE 编码以减少大分辨率/长视频的内存使用"}),
                "tile_size": ("INT", {"default": 256, "min": 64, "max": 512, "step": 32,
                                      "display_name": "平铺大小", "tooltip": "平铺编码的空间平铺大小，仅在启用平铺编码时使用"}),
                "tile_overlap": ("INT", {"default": 64, "min": 16, "max": 256, "step": 16,
                                         "display_name": "平铺重叠", "tooltip": "平铺编码时平铺之间的重叠，仅在启用平铺编码时使用"}),
                "bypass": ("BOOLEAN", {"default": False, "display_name": "跳过处理",
                                       "tooltip": "启用后直接返回原始输入，不应用任何条件化"}),
                "background": (MEDIA_INPUT_TYPE, {"display_name": "背景", "tooltip": "可选。支持 GJJ_BATCH_IMAGE、普通 IMAGE 批次和 VIDEO；连接后会作为 LiconMSR 式 guide 序列的背景/末尾图片参与分帧。"}),
                "frame_count": (["17", "25", "33", "41"], {"default": "33",
                                                           "display_name": "Guide帧数",
                                                           "tooltip": "连接引导图像或背景时，按 LiconMSR 逻辑生成的 guide 固定帧数。必须是 8N+1；帧数越大，VAE 编码显存占用越高。"}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "视频 Latent")
    OUTPUT_TOOLTIPS = (
        "添加了 IC-LoRA guide 的正向 conditioning",
        "添加了 IC-LoRA guide 的负向 conditioning",
        "应用了 guide 的视频 latent",
    )
    CATEGORY = "GJJ/视频"
    FUNCTION = "generate"
    DESCRIPTION = "向视频 latent 添加 IC-LoRA guide 条件。引导图像/背景支持 IMAGE、GJJ_BATCH_IMAGE 和 VIDEO，会按 LiconMSR 逻辑生成参考帧序列。"

    @classmethod
    def encode(cls, vae, latent_width, latent_height, images, scale_factors, 
               latent_downscale_factor, crop, use_tiled_encode, tile_size, tile_overlap):
        """
        将图像编码为 latent。
        
        参数：
            vae: VAE 模型
            latent_width: latent 宽度
            latent_height: latent 高度
            images: 输入图像张量
            scale_factors: 缩放因子 (time, width, height)
            latent_downscale_factor: latent 缩放因子
            crop: 裁剪模式
            use_tiled_encode: 是否使用平铺编码
            tile_size: 平铺大小
            tile_overlap: 平铺重叠
        
        返回：
            (编码后的像素, guide_latent)
        """
        time_scale_factor, width_scale_factor, height_scale_factor = scale_factors
        
        # 根据时间缩放因子保留合适数量的帧
        num_frames_to_keep = ((images.shape[0] - 1) // time_scale_factor) * time_scale_factor + 1
        images = images[:num_frames_to_keep]
        
        # 计算目标尺寸（考虑 latent_downscale_factor）
        target_width = int(latent_width * width_scale_factor / latent_downscale_factor)
        target_height = int(latent_height * height_scale_factor / latent_downscale_factor)
        
        # 调整图像大小
        pixels = comfy.utils.common_upscale(
            images.movedim(-1, 1), target_width, target_height, "bilinear", crop=crop
        ).movedim(1, -1)
        
        # 只编码 RGB 通道
        encode_pixels = pixels[:, :, :, :3]
        
        # 使用平铺编码或普通编码
        if use_tiled_encode:
            guide_latent = vae.encode_tiled(
                encode_pixels, tile_x=tile_size, tile_y=tile_size, overlap=tile_overlap
            )
        else:
            guide_latent = vae.encode(encode_pixels)
        
        return encode_pixels, guide_latent

    def dilate_latent(self, latent, horizontal_scale, vertical_scale):
        """
        扩张 latent（用于 latent_downscale_factor > 1 的情况）。
        
        参数：
            latent: 输入 latent 字典
            horizontal_scale: 水平缩放因子
            vertical_scale: 垂直缩放因子
        
        返回：
            (扩张后的 latent, noise_mask)
        """
        if horizontal_scale == 1 and vertical_scale == 1:
            return latent

        samples = latent["samples"]
        mask = latent.get("noise_mask", None)
        dilated_shape = samples.shape[:3] + (
            samples.shape[3] * vertical_scale,
            samples.shape[4] * horizontal_scale,
        )

        dilated_samples = torch.zeros(
            dilated_shape,
            device=samples.device,
            dtype=samples.dtype,
            requires_grad=False,
        )
        dilated_samples[..., ::vertical_scale, ::horizontal_scale] = samples

        dilated_mask_shape = (
            dilated_samples.shape[0],
            1,
            dilated_samples.shape[2],
            dilated_samples.shape[3],
            dilated_samples.shape[4],
        )
        dilated_mask = torch.full(
            dilated_mask_shape,
            -1.0,
            device=samples.device,
            dtype=samples.dtype,
            requires_grad=False,
        )
        dilated_mask[..., ::vertical_scale, ::horizontal_scale] = (
            mask if mask is not None else 1.0
        )

        return {"samples": dilated_samples, "noise_mask": dilated_mask}

    def get_latent_index(self, positive, latent_length, num_images, frame_idx, scale_factors):
        """
        计算 latent 索引。
        
        参数：
            positive: 正向 conditioning（用于获取时间步长信息）
            latent_length: latent 的帧数
            num_images: 图像数量
            frame_idx: 用户指定的帧索引
            scale_factors: 缩放因子
        
        返回：
            (调整后的 frame_idx, latent_idx)
        """
        return nodes_lt.LTXVAddGuide.get_latent_index(
            positive, latent_length, num_images, frame_idx, scale_factors
        )

    def append_keyframe(self, positive, negative, frame_idx, latent_image, noise_mask, 
                       guide_latent, strength, scale_factors, guide_mask=None, 
                       latent_downscale_factor=1, causal_fix=False):
        """
        将 guide latent 追加到视频 latent 和 conditioning 中。
        
        参数：
            positive: 正向 conditioning
            negative: 负向 conditioning
            frame_idx: 帧索引
            latent_image: 视频 latent samples
            noise_mask: 噪声 mask
            guide_latent: guide latent
            strength: 强度
            scale_factors: 缩放因子
            guide_mask: guide mask（可选）
            latent_downscale_factor: latent 缩放因子
            causal_fix: 是否应用因果修复
        
        返回：
            (positive, negative, latent_image, noise_mask)
        """
        return nodes_lt.LTXVAddGuide.append_keyframe(
            positive,
            negative,
            frame_idx,
            latent_image,
            noise_mask,
            guide_latent,
            strength,
            scale_factors,
            guide_mask=guide_mask,
            latent_downscale_factor=latent_downscale_factor,
            causal_fix=causal_fix,
        )

    def _build_msr_guide_frames(self, image, background, target_width, target_height, frame_count):
        """按 LiconMSR 的分帧方式，把输入媒体整理为固定帧数的 guide 视频帧。"""
        source_frames = []
        source_frames.extend(_collect_single_frames(image))
        source_frames.extend(_collect_single_frames(background))
        if not source_frames:
            return None

        prepared = [
            _resize_frame(frame, target_width, target_height)
            for frame in source_frames
        ]
        expanded = _expand_msr_frames(prepared, frame_count)
        if not expanded:
            return None
        return torch.cat(expanded, dim=0).contiguous()

    def generate(self, positive, negative, vae, latent, image=None, frame_idx=0, strength=1.0,
                 latent_downscale_factor=1.0, crop="disabled", use_tiled_encode=False,
                 tile_size=256, tile_overlap=64, bypass=False, background=None, frame_count="33"):
        """
        执行 IC-LoRA guide 添加操作。
        
        参数：
            positive: 正向 conditioning
            negative: 负向 conditioning
            vae: VAE 模型
            latent: 视频 latent
            frame_idx: 起始帧索引
            strength: 强度
            latent_downscale_factor: latent 缩放因子
            crop: 裁剪模式
            use_tiled_encode: 是否使用平铺编码
            tile_size: 平铺大小
            tile_overlap: 平铺重叠
            bypass: 是否跳过处理
            image: 可选引导图像、批量图像或视频
            background: 可选背景图像、批量图像或视频
            frame_count: LiconMSR 式 guide 固定帧数
        
        返回：
            (positive, negative, latent)
        """
        if bypass:
            return (positive, negative, latent)

        scale_factors = vae.downscale_index_formula
        latent_image = latent["samples"]
        noise_mask = get_noise_mask(latent)

        # 获取 latent 尺寸
        _, _, latent_length, latent_height, latent_width = latent_image.shape

        time_scale_factor = int(scale_factors[0])
        width_scale_factor = int(scale_factors[1])
        height_scale_factor = int(scale_factors[2])
        image = self._build_msr_guide_frames(
            image,
            background,
            int(latent_width * width_scale_factor),
            int(latent_height * height_scale_factor),
            _normalize_frame_count(frame_count),
        )
        if image is None:
            return (positive, negative, latent)
        
        # 计算要保留的帧数
        num_frames_to_keep = ((image.shape[0] - 1) // time_scale_factor) * time_scale_factor + 1
        causal_fix = frame_idx == 0 or num_frames_to_keep == 1
        
        # 非因果情况下的修复
        if not causal_fix:
            image = torch.cat([image[:1], image], dim=0)

        # 编码图像
        image, guide_latent = self.encode(
            vae, latent_width, latent_height, image, scale_factors,
            latent_downscale_factor, crop, use_tiled_encode, tile_size, tile_overlap
        )

        # 非因果情况下移除额外添加的帧
        if not causal_fix:
            guide_latent = guide_latent[:, :, 1:, :, :]
            image = image[1:]

        # 记录原始 guide latent 形状用于空间 mask 下采样
        guide_orig_shape = list(guide_latent.shape[2:])  # [F, H_small, W_small]
        guide_mask = None

        # 如果 latent_downscale_factor > 1，扩张 latent
        if latent_downscale_factor > 1:
            if latent_width % latent_downscale_factor != 0 or latent_height % latent_downscale_factor != 0:
                raise ValueError(
                    f"Latent 空间尺寸 {latent_width}x{latent_height} 必须能被 latent_downscale_factor {latent_downscale_factor} 整除"
                )

            dilated = self.dilate_latent(
                {"samples": guide_latent},
                horizontal_scale=int(latent_downscale_factor),
                vertical_scale=int(latent_downscale_factor),
            )
            guide_mask = dilated["noise_mask"]
            guide_latent = dilated["samples"]

        # 计算添加的 IC-LoRA token 数量
        iclora_tokens_added = guide_latent.shape[2] * guide_latent.shape[3] * guide_latent.shape[4]

        # 获取 latent 索引
        frame_idx, latent_idx = self.get_latent_index(
            positive, latent_length, len(image), frame_idx, scale_factors
        )
        
        # 验证条件帧不超过 latent 序列长度
        assert latent_idx + guide_latent.shape[2] <= latent_length, \
            "条件帧超过了 latent 序列的长度。"

        # 追加关键帧
        positive, negative, latent_image, noise_mask = self.append_keyframe(
            positive, negative, frame_idx, latent_image, noise_mask,
            guide_latent, strength, scale_factors,
            guide_mask=guide_mask,
            latent_downscale_factor=latent_downscale_factor,
            causal_fix=causal_fix,
        )

        # 跟踪 guide attention entry
        positive = append_guide_attention_entry(
            positive, iclora_tokens_added, guide_orig_shape
        )
        negative = append_guide_attention_entry(
            negative, iclora_tokens_added, guide_orig_shape
        )

        return (
            positive,
            negative,
            {"samples": latent_image, "noise_mask": noise_mask}
        )


NODE_CLASS_MAPPINGS["GJJ_AddVideoICLoRAGuide"] = GJJ_AddVideoICLoRAGuide
NODE_DISPLAY_NAME_MAPPINGS["GJJ_AddVideoICLoRAGuide"] = "🎬 添加视频 IC-LoRA Guide"
