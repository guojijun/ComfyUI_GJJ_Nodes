from __future__ import annotations

import gc
import logging
from typing import Any

import torch


NODE_NAME = "GJJ_LTXVTiledVAEDecode"


def _as_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        result = int(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"true", "1", "yes", "on", "开启", "是"}:
            return True
        if text in {"false", "0", "no", "off", "关闭", "否"}:
            return False
    return default


def _target_dtype(samples: torch.Tensor, working_dtype: str) -> torch.dtype:
    if working_dtype == "float16":
        return torch.float16
    if working_dtype == "float32":
        return torch.float32
    return samples.dtype


def _target_device(samples: torch.Tensor, working_device: str) -> torch.device | str:
    return samples.device if working_device == "auto" else "cpu"


def _downscale_formula(vae: Any) -> tuple[int, int, int]:
    formula = getattr(vae, "downscale_index_formula", None)
    if isinstance(formula, (list, tuple)) and len(formula) >= 3:
        return int(formula[0]), int(formula[1]), int(formula[2])

    spatial = 8
    try:
        if callable(getattr(vae, "spacial_compression_decode", None)):
            spatial = int(vae.spacial_compression_decode())
    except Exception:
        spatial = 8
    return 1, spatial, spatial


def _normalize_decoded_tile(decoded: torch.Tensor, batch: int, frames: int, image_frames: int) -> torch.Tensor:
    if not isinstance(decoded, torch.Tensor):
        raise RuntimeError(f"LTXV 分块 VAE 解码失败：VAE 返回的不是 Tensor，而是 {type(decoded)!r}")

    if decoded.ndim == 5:
        return decoded

    if decoded.ndim == 4:
        if decoded.shape[0] == batch * image_frames:
            return decoded.view(batch, image_frames, decoded.shape[1], decoded.shape[2], decoded.shape[3])
        if batch == 1 and decoded.shape[0] == image_frames:
            return decoded.unsqueeze(0)
        if frames == 1 and decoded.shape[0] == batch:
            return decoded.unsqueeze(1)

    raise RuntimeError(
        "LTXV 分块 VAE 解码失败：VAE 输出维度异常，"
        f"期望 [B,T,H,W,C] 或 [B*T,H,W,C]，实际为 {tuple(decoded.shape)}"
    )


def _soft_empty_cache() -> None:
    try:
        from comfy import model_management as mm

        try:
            mm.soft_empty_cache()
        except TypeError:
            mm.soft_empty_cache(force=True)
    except Exception:
        pass
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass
    except Exception:
        pass


class GJJ_LTXVTiledVAEDecode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": (
                    "VAE",
                    {
                        "display_name": "VAE",
                        "tooltip": "连接 LTXV 使用的视频 VAE。节点不依赖 ComfyUI-LTXVideo，只调用传入 VAE 的 decode。",
                    },
                ),
                "latents": (
                    "LATENT",
                    {
                        "display_name": "Latent",
                        "tooltip": "需要解码的视频 latent，samples 维度应为 [批次, 通道, 帧, 高, 宽]。",
                    },
                ),
                "horizontal_tiles": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 6,
                        "step": 1,
                        "display_name": "横向分块",
                        "tooltip": "横向切成多少块。块数越多越省显存，但速度更慢。",
                    },
                ),
                "vertical_tiles": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 6,
                        "step": 1,
                        "display_name": "纵向分块",
                        "tooltip": "纵向切成多少块。块数越多越省显存，但速度更慢。",
                    },
                ),
                "overlap": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": 8,
                        "step": 1,
                        "display_name": "重叠",
                        "tooltip": "分块之间的 latent 重叠宽度，用于线性融合接缝。",
                    },
                ),
                "last_frame_fix": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "最后帧修正",
                        "tooltip": "开启后重复最后一个 latent 帧参与解码，再丢弃多出的输出帧，用于缓解末帧异常。",
                    },
                ),
                "working_device": (
                    ["auto", "cpu"],
                    {
                        "default": "auto",
                        "display_name": "工作设备",
                        "tooltip": "auto 表示输出融合张量跟随 latent 设备；cpu 表示融合张量放到 CPU，显存压力更低但更慢。",
                    },
                ),
                "working_dtype": (
                    ["auto", "float16", "float32"],
                    {
                        "default": "auto",
                        "display_name": "工作精度",
                        "tooltip": "融合张量使用的精度。auto 跟随 latent；float32 更稳但占用更高。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    OUTPUT_TOOLTIPS = ("解码后的视频帧序列，格式为 ComfyUI IMAGE。",)
    FUNCTION = "decode"
    CATEGORY = "GJJ/视频模型/LTXV"
    DESCRIPTION = "零依赖移植 LTXVTiledVAEDecode：对 LTXV latent 做空间分块 VAE 解码，并用重叠权重融合接缝。"
    GJJ_HELP = {
        "title": "LTXV 分块 VAE 解码",
        "description": "从 ComfyUI-LTXVideo 的 LTXVTiledVAEDecode 移植为 GJJ 单节点；不导入源插件，只依赖 ComfyUI 传入的 VAE 和 PyTorch。",
        "usage": [
            "横向/纵向分块越多，峰值显存越低，速度越慢。",
            "重叠用于消除分块边缘接缝；一般 1-2 即可。",
            "显存紧张时把工作设备设为 CPU。",
        ],
    }

    def decode(
        self,
        vae,
        latents,
        horizontal_tiles,
        vertical_tiles,
        overlap,
        last_frame_fix,
        working_device="auto",
        working_dtype="auto",
    ):
        if not isinstance(latents, dict) or "samples" not in latents:
            raise RuntimeError("LTXV 分块 VAE 解码失败：Latent 输入缺少 samples。")

        samples = latents["samples"]
        if not isinstance(samples, torch.Tensor):
            raise RuntimeError(f"LTXV 分块 VAE 解码失败：samples 不是 Tensor，而是 {type(samples)!r}")
        if samples.ndim != 5:
            raise RuntimeError(f"LTXV 分块 VAE 解码失败：samples 维度应为 [B,C,T,H,W]，实际为 {tuple(samples.shape)}")

        horizontal_tiles = _as_int(horizontal_tiles, 1, 1, 6)
        vertical_tiles = _as_int(vertical_tiles, 1, 1, 6)
        overlap = _as_int(overlap, 1, 0, 8)
        last_frame_fix = _as_bool(last_frame_fix, False)

        if last_frame_fix:
            samples = torch.cat([samples, samples[:, :, -1:, :, :]], dim=2)

        batch, _channels, frames, height, width = samples.shape
        time_scale_factor, width_scale_factor, height_scale_factor = _downscale_formula(vae)
        image_frames = 1 + (frames - 1) * time_scale_factor
        output_height = height * height_scale_factor
        output_width = width * width_scale_factor

        if horizontal_tiles > 1 and overlap >= width:
            raise RuntimeError("LTXV 分块 VAE 解码失败：横向重叠不能大于或等于 latent 宽度。")
        if vertical_tiles > 1 and overlap >= height:
            raise RuntimeError("LTXV 分块 VAE 解码失败：纵向重叠不能大于或等于 latent 高度。")

        base_tile_height = (height + (vertical_tiles - 1) * overlap) // vertical_tiles
        base_tile_width = (width + (horizontal_tiles - 1) * overlap) // horizontal_tiles
        if base_tile_height <= overlap and vertical_tiles > 1:
            raise RuntimeError("LTXV 分块 VAE 解码失败：纵向分块过多或重叠过大，导致有效块高度不足。")
        if base_tile_width <= overlap and horizontal_tiles > 1:
            raise RuntimeError("LTXV 分块 VAE 解码失败：横向分块过多或重叠过大，导致有效块宽度不足。")

        target_device = _target_device(samples, str(working_device or "auto"))
        target_dtype = _target_dtype(samples, str(working_dtype or "auto"))

        output = torch.zeros(
            (batch, image_frames, output_height, output_width, 3),
            device=target_device,
            dtype=target_dtype,
        )
        weights = torch.zeros(
            (batch, image_frames, output_height, output_width, 1),
            device=target_device,
            dtype=target_dtype,
        )

        try:
            for v in range(vertical_tiles):
                for h in range(horizontal_tiles):
                    h_start = h * (base_tile_width - overlap)
                    v_start = v * (base_tile_height - overlap)
                    h_end = min(h_start + base_tile_width, width) if h < horizontal_tiles - 1 else width
                    v_end = min(v_start + base_tile_height, height) if v < vertical_tiles - 1 else height

                    logging.info(
                        "[GJJ LTXV Tiled VAE Decode] tile row=%s col=%s latent=(%s:%s, %s:%s)",
                        v,
                        h,
                        v_start,
                        v_end,
                        h_start,
                        h_end,
                    )

                    tile = samples[:, :, :, v_start:v_end, h_start:h_end]
                    decoded_tile = _normalize_decoded_tile(
                        vae.decode(tile),
                        batch=batch,
                        frames=frames,
                        image_frames=image_frames,
                    )

                    out_h_start = v_start * height_scale_factor
                    out_h_end = v_end * height_scale_factor
                    out_w_start = h_start * width_scale_factor
                    out_w_end = h_end * width_scale_factor
                    tile_out_height = out_h_end - out_h_start
                    tile_out_width = out_w_end - out_w_start

                    tile_weights = torch.ones(
                        (batch, image_frames, tile_out_height, tile_out_width, 1),
                        device=decoded_tile.device,
                        dtype=decoded_tile.dtype,
                    )

                    overlap_out_h = overlap * height_scale_factor
                    overlap_out_w = overlap * width_scale_factor

                    if overlap_out_w > 0:
                        if h > 0:
                            h_blend = torch.linspace(0, 1, overlap_out_w, device=decoded_tile.device, dtype=decoded_tile.dtype)
                            tile_weights[:, :, :, :overlap_out_w, :] *= h_blend.view(1, 1, 1, -1, 1)
                        if h < horizontal_tiles - 1:
                            h_blend = torch.linspace(1, 0, overlap_out_w, device=decoded_tile.device, dtype=decoded_tile.dtype)
                            tile_weights[:, :, :, -overlap_out_w:, :] *= h_blend.view(1, 1, 1, -1, 1)

                    if overlap_out_h > 0:
                        if v > 0:
                            v_blend = torch.linspace(0, 1, overlap_out_h, device=decoded_tile.device, dtype=decoded_tile.dtype)
                            tile_weights[:, :, :overlap_out_h, :, :] *= v_blend.view(1, 1, -1, 1, 1)
                        if v < vertical_tiles - 1:
                            v_blend = torch.linspace(1, 0, overlap_out_h, device=decoded_tile.device, dtype=decoded_tile.dtype)
                            tile_weights[:, :, -overlap_out_h:, :, :] *= v_blend.view(1, 1, -1, 1, 1)

                    output[:, :, out_h_start:out_h_end, out_w_start:out_w_end, :] += (
                        decoded_tile * tile_weights
                    ).to(device=target_device, dtype=target_dtype)
                    weights[:, :, out_h_start:out_h_end, out_w_start:out_w_end, :] += tile_weights.to(
                        device=target_device,
                        dtype=target_dtype,
                    )

                    del tile, decoded_tile, tile_weights
                    _soft_empty_cache()

            output = output / (weights + 1e-8)
            output = output.view(batch * image_frames, output_height, output_width, output.shape[-1])

            if last_frame_fix:
                output = output[:-time_scale_factor, :, :, :]

            return (output.cpu().float(),)
        finally:
            gc.collect()
            _soft_empty_cache()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTXVTiledVAEDecode}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ LTXV分块VAE解码"}
