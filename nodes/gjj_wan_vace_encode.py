from __future__ import annotations

import math
from typing import Any

import torch
import torch.nn.functional as F
from comfy import model_management as mm
from comfy.utils import ProgressBar, common_upscale


VAE_STRIDE = (4, 8, 8)


def _device():
    return mm.get_torch_device()


def _offload_device():
    return mm.unet_offload_device()


def _load_vace_runtime():
    try:
        from ..vendor.wanvideo_wrapper import nodes as wan_nodes
    except ImportError as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo VACE runtime 加载失败。\n"
            f"错误信息: {error}\n"
            "说明: 本节点不依赖 ComfyUI-WanVideoWrapper 插件本体；pip 运行时依赖仍按 GJJ WanVideo 运行时依赖方案安装。"
        ) from error
    return wan_nodes


def _vae_dtype(vae: Any):
    return getattr(vae, "dtype", torch.float32)


def _move_vae(vae: Any, device: Any) -> None:
    try:
        vae.to(device)
    except Exception:
        model = getattr(vae, "model", None)
        if model is not None:
            try:
                model.to(device)
            except Exception:
                pass


class _ComfyWanVAEAdapter:
    """Expose ComfyUI's native VAE object through the small WanVAE API VACE uses."""

    def __init__(self, vae: Any):
        self._vae = vae
        self.dtype = getattr(vae, "vae_dtype", torch.float32)

    def to(self, *_args, **_kwargs):
        return self

    def encode(self, videos, device: Any = None, tiled: bool = False, **_kwargs):
        target_device = device if device is not None else _device()
        if isinstance(videos, torch.Tensor):
            if videos.ndim == 4:
                videos = [videos]
            elif videos.ndim == 5:
                videos = [video for video in videos]
            else:
                raise RuntimeError(f"VAE 视频输入维度无效：{tuple(videos.shape)}")

        latents = []
        for video in videos:
            if not isinstance(video, torch.Tensor) or video.ndim != 4:
                raise RuntimeError(f"VAE 视频帧维度无效，应为 C/T/H/W，实际为：{getattr(video, 'shape', None)}")

            pixels = ((video.movedim(0, -1) + 1.0) / 2.0).clamp(0.0, 1.0)
            pixels = pixels.to(device=target_device, dtype=torch.float32)

            if tiled and hasattr(self._vae, "encode_tiled"):
                encoded = self._vae.encode_tiled(
                    pixels,
                    tile_x=512,
                    tile_y=512,
                    overlap=64,
                    tile_t=64,
                    overlap_t=8,
                )
            else:
                encoded = self._vae.encode(pixels)

            if encoded.ndim == 5 and int(encoded.shape[0]) == 1:
                encoded = encoded[0]
            elif encoded.ndim == 4:
                pass
            else:
                raise RuntimeError(f"VAE 编码结果维度异常：{tuple(encoded.shape)}")
            latents.append(encoded.to(device=target_device, dtype=torch.float32))

        return torch.stack(latents).to(device=target_device, dtype=torch.float32)


def _adapt_vae_for_vace(vae: Any) -> Any:
    if hasattr(vae, "dtype"):
        return vae
    if hasattr(vae, "first_stage_model") and hasattr(vae, "encode"):
        return _ComfyWanVAEAdapter(vae)
    return vae


def _as_batched_image(image: torch.Tensor | None) -> torch.Tensor | None:
    if image is None:
        return None
    if not isinstance(image, torch.Tensor):
        raise RuntimeError(f"图片输入类型无效：{type(image)!r}")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise RuntimeError(f"图片输入维度无效，应为 IMAGE 批次，实际为：{tuple(image.shape)}")
    return image


def _as_batched_mask(mask: torch.Tensor | None) -> torch.Tensor | None:
    if mask is None:
        return None
    if not isinstance(mask, torch.Tensor):
        raise RuntimeError(f"遮罩输入类型无效：{type(mask)!r}")
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    if mask.ndim == 4 and int(mask.shape[-1]) == 1:
        mask = mask.squeeze(-1)
    if mask.ndim != 3:
        raise RuntimeError(f"遮罩输入维度无效，应为 MASK 批次，实际为：{tuple(mask.shape)}")
    return mask


class GJJ_WanVACEEncode:
    CATEGORY = "GJJ/视频"
    FUNCTION = "process"
    DESCRIPTION = (
        "WanVideo VACE 条件编码的 GJJ 零依赖复刻版。"
        "节点不导入 ComfyUI-WanVideoWrapper，只使用传入的 Wan VAE 对象完成视频帧、遮罩和参考图编码。"
    )
    SEARCH_ALIASES = [
        "wan vace",
        "wanvideo vace",
        "vace encode",
        "WanVideoVACEEncode",
        "VACE编码",
        "Wan控制编码",
    ]

    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS",)
    RETURN_NAMES = ("VACE编码",)
    OUTPUT_TOOLTIPS = ("WanVideo 采样器可读取的 VACE embeds 字典，包含 vace_context、强度、作用区间和串联输入。",)

    GJJ_HELP = {
        "title": "Wan VACE 编码",
        "description": "把输入视频帧、遮罩和可选参考图编码为 WanVideo VACE 控制条件。",
        "usage": [
            "vae 接 WanVideo VAE 加载器输出。",
            "控制视频帧可不接；不接时会生成空白控制帧。",
            "遮罩白色区域表示需要 VACE 作用的区域；不接时默认全区域生效。",
            "上一组 VACE 编码可接入 prev_vace_embeds，用于串联多组控制。",
        ],
        "notes": [
            "该节点不引用 ComfyUI-WanVideoWrapper 的 Python 模块。",
            "输出类型保持 WANVIDIMAGE_EMBEDS，方便连接支持该类型的 WanVideo 采样节点。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": (
                    "WANVAE,VAE",
                    {
                        "display_name": "Wan VAE",
                        "tooltip": "可接 WanVideo VAE，也可接 GJJ WanVideo模型加载输出的普通 VAE；普通 VAE 会自动按 Wan VACE 编码方式适配。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 832,
                        "min": 64,
                        "max": 8096,
                        "step": 8,
                        "display_name": "宽度",
                        "tooltip": "编码目标宽度，会自动向下对齐到 16 的倍数。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 480,
                        "min": 64,
                        "max": 8096,
                        "step": 8,
                        "display_name": "高度",
                        "tooltip": "编码目标高度，会自动向下对齐到 16 的倍数。",
                    },
                ),
                "num_frames": (
                    "INT",
                    {
                        "default": 81,
                        "min": 1,
                        "max": 10000,
                        "step": 4,
                        "display_name": "帧数",
                        "tooltip": "要编码的控制视频帧数量。输入帧过长会截断，过短不会自动补帧。",
                    },
                ),
                "strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.001,
                        "display_name": "控制强度",
                        "tooltip": "VACE 控制强度，通常 1.0 为正常强度。",
                    },
                ),
                "vace_start_percent": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "开始比例",
                        "tooltip": "采样进度到达该比例后开始应用 VACE。",
                    },
                ),
                "vace_end_percent": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "结束比例",
                        "tooltip": "采样进度到达该比例后停止应用 VACE。",
                    },
                ),
            },
            "optional": {
                "input_frames": (
                    "IMAGE",
                    {
                        "display_name": "控制视频帧",
                        "tooltip": "VACE 控制用图片批次，按帧顺序输入。",
                    },
                ),
                "ref_images": (
                    "IMAGE",
                    {
                        "display_name": "参考图",
                        "tooltip": "可选参考图。多张参考图会横向拼接后按目标比例补边并编码。",
                    },
                ),
                "input_masks": (
                    "MASK",
                    {
                        "display_name": "控制遮罩",
                        "tooltip": "控制作用遮罩。白色区域参与 reactive 编码，黑色区域进入 inactive 编码。",
                    },
                ),
                "prev_vace_embeds": (
                    "WANVIDIMAGE_EMBEDS",
                    {
                        "display_name": "上一组 VACE 编码",
                        "tooltip": "可选。用于串联上一组 VACE 控制输入。",
                    },
                ),
                "tiled_vae": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "分块 VAE",
                        "tooltip": "开启后调用 Wan VAE 的 tiled 编码以降低显存占用，速度会变慢。",
                    },
                ),
            },
        }

    def process(
        self,
        vae,
        width: int,
        height: int,
        num_frames: int,
        strength: float,
        vace_start_percent: float,
        vace_end_percent: float,
        input_frames: torch.Tensor | None = None,
        ref_images: torch.Tensor | None = None,
        input_masks: torch.Tensor | None = None,
        prev_vace_embeds: dict[str, Any] | None = None,
        tiled_vae: bool = False,
    ):
        vae = _adapt_vae_for_vace(vae)
        return self._process_local(
            vae=vae,
            width=width,
            height=height,
            num_frames=num_frames,
            strength=strength,
            vace_start_percent=vace_start_percent,
            vace_end_percent=vace_end_percent,
            input_frames=input_frames,
            ref_images=ref_images,
            input_masks=input_masks,
            prev_vace_embeds=prev_vace_embeds,
            tiled_vae=tiled_vae,
        )

    def _process_local(
        self,
        vae,
        width: int,
        height: int,
        num_frames: int,
        strength: float,
        vace_start_percent: float,
        vace_end_percent: float,
        input_frames: torch.Tensor | None = None,
        ref_images: torch.Tensor | None = None,
        input_masks: torch.Tensor | None = None,
        prev_vace_embeds: dict[str, Any] | None = None,
        tiled_vae: bool = False,
    ):
        width = max(16, (int(width) // 16) * 16)
        height = max(16, (int(height) // 16) * 16)
        num_frames = max(1, int(num_frames))
        device = _device()
        dtype = _vae_dtype(vae)

        target_shape = (
            16,
            (num_frames - 1) // VAE_STRIDE[0] + 1,
            height // VAE_STRIDE[1],
            width // VAE_STRIDE[2],
        )

        input_frames = self._prepare_frames(input_frames, num_frames, width, height, dtype, device)
        input_masks = self._prepare_masks(input_masks, input_frames, num_frames, width, height, dtype, device)
        ref_images = self._prepare_ref_images(ref_images, width, height, dtype, device)

        _move_vae(vae, device)
        try:
            z0 = self._vace_encode_frames(vae, input_frames, ref_images, masks=input_masks, tiled_vae=bool(tiled_vae), device=device)
            m0 = self._vace_encode_masks(input_masks, ref_images)
            z = self._vace_latent(z0, m0)
        finally:
            _move_vae(vae, _offload_device())

        vace_input = {
            "vace_context": z,
            "vace_scale": float(strength),
            "has_ref": ref_images is not None,
            "num_frames": num_frames,
            "target_shape": target_shape,
            "vace_start_percent": float(vace_start_percent),
            "vace_end_percent": float(vace_end_percent),
            "vace_seq_len": math.ceil((z[0].shape[2] * z[0].shape[3]) / 4 * z[0].shape[1]),
            "additional_vace_inputs": [],
        }

        if isinstance(prev_vace_embeds, dict):
            previous = prev_vace_embeds.get("additional_vace_inputs")
            if previous:
                vace_input["additional_vace_inputs"] = list(previous)
            vace_input["additional_vace_inputs"].append(prev_vace_embeds)

        return (vace_input,)

    @staticmethod
    def _prepare_frames(
        input_frames: torch.Tensor | None,
        num_frames: int,
        width: int,
        height: int,
        dtype: torch.dtype,
        device: Any,
    ) -> torch.Tensor:
        input_frames = _as_batched_image(input_frames)
        if input_frames is None:
            return torch.zeros((1, 3, num_frames, height, width), device=device, dtype=dtype)

        input_frames = input_frames.clone()[:num_frames, :, :, :3]
        input_frames = common_upscale(input_frames.movedim(-1, 1), width, height, "lanczos", "disabled").movedim(1, -1)
        input_frames = input_frames.to(device=device, dtype=dtype).unsqueeze(0).permute(0, 4, 1, 2, 3)
        return input_frames * 2 - 1

    @staticmethod
    def _prepare_masks(
        input_masks: torch.Tensor | None,
        input_frames: torch.Tensor,
        num_frames: int,
        width: int,
        height: int,
        dtype: torch.dtype,
        device: Any,
    ) -> torch.Tensor:
        input_masks = _as_batched_mask(input_masks)
        if input_masks is None:
            return torch.ones_like(input_frames, device=device)

        input_masks = input_masks[:num_frames]
        input_masks = common_upscale(input_masks.clone().unsqueeze(1), width, height, "nearest-exact", "disabled").squeeze(1)
        input_masks = input_masks.to(device=device, dtype=dtype)
        return input_masks.unsqueeze(-1).unsqueeze(0).permute(0, 4, 1, 2, 3).repeat(1, 3, 1, 1, 1)

    @staticmethod
    def _prepare_ref_images(
        ref_images: torch.Tensor | None,
        width: int,
        height: int,
        dtype: torch.dtype,
        device: Any,
    ) -> torch.Tensor | None:
        ref_images = _as_batched_image(ref_images)
        if ref_images is None:
            return None

        ref_images = ref_images.clone()[..., :3]
        if int(ref_images.shape[0]) > 1:
            ref_images = torch.cat([ref_images[i] for i in range(int(ref_images.shape[0]))], dim=1).unsqueeze(0)

        batch, image_h, image_w, channels = ref_images.shape
        current_aspect = image_w / image_h
        target_aspect = width / height
        if current_aspect > target_aspect:
            new_h = int(image_w / target_aspect)
            pad_h = (new_h - image_h) // 2
            padded = torch.ones(batch, new_h, image_w, channels, device=ref_images.device, dtype=ref_images.dtype)
            padded[:, pad_h : pad_h + image_h, :, :] = ref_images
            ref_images = padded
        elif current_aspect < target_aspect:
            new_w = int(image_h * target_aspect)
            pad_w = (new_w - image_w) // 2
            padded = torch.ones(batch, image_h, new_w, channels, device=ref_images.device, dtype=ref_images.dtype)
            padded[:, :, pad_w : pad_w + image_w, :] = ref_images
            ref_images = padded

        ref_images = common_upscale(ref_images.movedim(-1, 1), width, height, "lanczos", "center").movedim(1, -1)
        ref_images = ref_images.to(device=device, dtype=dtype).unsqueeze(0).permute(0, 4, 1, 2, 3).unsqueeze(0)
        return ref_images * 2 - 1

    @staticmethod
    def _vace_encode_frames(
        vae,
        frames: torch.Tensor,
        ref_images: torch.Tensor | None,
        masks: torch.Tensor | None = None,
        tiled_vae: bool = False,
        device: Any = None,
    ) -> list[torch.Tensor]:
        if ref_images is None:
            ref_images = [None] * len(frames)
        else:
            if len(frames) != len(ref_images):
                raise RuntimeError("VACE 参考图批次与视频帧批次数量不一致。")

        pbar = ProgressBar(len(frames))
        if masks is None:
            latents = vae.encode(frames, device=device, tiled=tiled_vae)
        else:
            inactive = [i * (1 - m) + 0 * m for i, m in zip(frames, masks)]
            reactive = [i * m + 0 * (1 - m) for i, m in zip(frames, masks)]
            del frames
            inactive = vae.encode(inactive, device=device, tiled=tiled_vae)
            reactive = vae.encode(reactive, device=device, tiled=tiled_vae)
            latents = [torch.cat((u, c), dim=0) for u, c in zip(inactive, reactive)]

        cat_latents = []
        for latent, refs in zip(latents, ref_images):
            if refs is not None:
                ref_latent = vae.encode(refs, device=device, tiled=tiled_vae)
                if masks is not None:
                    ref_latent = [torch.cat((u, torch.zeros_like(u)), dim=0) for u in ref_latent]
                if not all(int(x.shape[1]) == 1 for x in ref_latent):
                    raise RuntimeError("VACE 参考图编码结果帧数异常。")
                ref_latent = [item.to(device=latent.device, dtype=latent.dtype) for item in ref_latent]
                latent = torch.cat([*ref_latent, latent], dim=1)
            cat_latents.append(latent)
            pbar.update(1)
        return cat_latents

    @staticmethod
    def _vace_encode_masks(masks: torch.Tensor, ref_images: torch.Tensor | None = None) -> list[torch.Tensor]:
        if ref_images is None:
            ref_images = [None] * len(masks)
        else:
            if len(masks) != len(ref_images):
                raise RuntimeError("VACE 参考图批次与遮罩批次数量不一致。")

        result_masks = []
        pbar = ProgressBar(len(masks))
        for mask, refs in zip(masks, ref_images):
            _channels, depth, height, width = mask.shape
            new_depth = int((depth + 3) // VAE_STRIDE[0])
            height = 2 * (int(height) // (VAE_STRIDE[1] * 2))
            width = 2 * (int(width) // (VAE_STRIDE[2] * 2))

            mask = mask[0, :, :, :]
            mask = mask.view(depth, height, VAE_STRIDE[1], width, VAE_STRIDE[1])
            mask = mask.permute(2, 4, 0, 1, 3)
            mask = mask.reshape(VAE_STRIDE[1] * VAE_STRIDE[2], depth, height, width)
            mask = F.interpolate(mask.unsqueeze(0), size=(new_depth, height, width), mode="nearest-exact").squeeze(0)

            if refs is not None:
                length = len(refs)
                mask_pad = torch.zeros_like(mask[:, :length, :, :])
                mask = torch.cat((mask_pad, mask), dim=1)
            result_masks.append(mask)
            pbar.update(1)
        return result_masks

    @staticmethod
    def _vace_latent(z: list[torch.Tensor], m: list[torch.Tensor]) -> list[torch.Tensor]:
        return [torch.cat([zz, mm.to(device=zz.device, dtype=zz.dtype)], dim=0) for zz, mm in zip(z, m)]


NODE_CLASS_MAPPINGS = {
    "GJJ_WanVACEEncode": GJJ_WanVACEEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_WanVACEEncode": "🧬 Wan VACE 编码",
}
