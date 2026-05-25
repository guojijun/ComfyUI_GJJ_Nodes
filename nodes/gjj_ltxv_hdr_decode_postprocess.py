from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

import torch
from torch import Tensor


NODE_NAME = "GJJ_LTXVHDRDecodePostprocess"
NODE_DISPLAY_NAME = "GJJ · 🌗 LTXV HDR解码后处理"
LOGGER = logging.getLogger(__name__)

# Must be set before cv2 import. This helps when no other node imported cv2 first.
os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")


class LogC3:
    """ARRI LogC3 EI 800 HDR compression/decompression."""

    A = 5.555556
    B = 0.052272
    C = 0.247190
    D = 0.385537
    E = 5.367655
    F = 0.092809
    CUT = 0.010591

    def decompress(self, z: Tensor) -> Tensor:
        logc = torch.clamp((z + 1.0) / 2.0, 0.0, 1.0)
        cut_log = self.E * self.CUT + self.F
        lin_from_log = (torch.pow(10.0, (logc - self.D) / self.C) - self.B) / self.A
        lin_from_lin = (logc - self.F) / self.E
        return torch.where(logc >= cut_log, lin_from_log, lin_from_lin)


_LOGC3 = LogC3()
_EXR_SUPPORT_CACHE: bool | None = None


def _hdr_decompress(decoded_01: Tensor) -> Tensor:
    raw = decoded_01.float() * 2.0 - 1.0
    return _LOGC3.decompress(raw)


def _linear_to_srgb(x: Tensor) -> Tensor:
    return torch.where(
        x <= 0.0031308,
        12.92 * x,
        1.055 * torch.pow(x.clamp(min=0.0031308), 1.0 / 2.4) - 0.055,
    ).clamp(0.0, 1.0)


def _resolve_output_dir(output_dir: str) -> Path:
    raw = str(output_dir or "hdr_exr").strip() or "hdr_exr"
    path = Path(raw)
    if path.is_absolute():
        return path

    try:
        import folder_paths

        output_root = Path(folder_paths.get_output_directory())
    except Exception:
        output_root = Path.cwd() / "output"

    parts = path.parts
    if parts and str(parts[0]).lower() == "output":
        path = Path(*parts[1:]) if len(parts) > 1 else Path("")
    return output_root / path


def _opencv_exr_available() -> bool:
    global _EXR_SUPPORT_CACHE
    if _EXR_SUPPORT_CACHE is not None:
        return _EXR_SUPPORT_CACHE

    try:
        import cv2
        import numpy as np
    except Exception as exc:
        LOGGER.warning("LTXV HDR EXR 保存跳过：未能导入 OpenCV/Numpy：%s", exc)
        _EXR_SUPPORT_CACHE = False
        return False

    probe_path = Path(tempfile.gettempdir()) / "gjj_opencv_exr_probe.exr"
    try:
        probe = np.zeros((1, 1, 3), dtype=np.float32)
        ok = bool(cv2.imwrite(str(probe_path), probe))
        _EXR_SUPPORT_CACHE = ok and probe_path.exists()
    except Exception as exc:
        LOGGER.warning(
            "LTXV HDR EXR 保存跳过：当前 OpenCV 不支持 EXR 写入。"
            "可在启动 ComfyUI 前设置 OPENCV_IO_ENABLE_OPENEXR=1 后重启。原始错误：%s",
            exc,
        )
        _EXR_SUPPORT_CACHE = False
    finally:
        try:
            probe_path.unlink(missing_ok=True)
        except Exception:
            pass
    return bool(_EXR_SUPPORT_CACHE)


def _save_exr_frames(
    hdr_image: torch.Tensor,
    output_dir: str,
    filename_prefix: str,
    half_precision: bool,
) -> None:
    if not _opencv_exr_available():
        return

    import cv2
    import numpy as np

    out_dir = _resolve_output_dir(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    frames = hdr_image.detach().cpu().numpy()
    exr_type = cv2.IMWRITE_EXR_TYPE_HALF if half_precision else cv2.IMWRITE_EXR_TYPE_FLOAT
    params = [
        cv2.IMWRITE_EXR_TYPE,
        exr_type,
        cv2.IMWRITE_EXR_COMPRESSION,
        cv2.IMWRITE_EXR_COMPRESSION_ZIP,
    ]

    prefix = str(filename_prefix or "frame").strip() or "frame"
    saved = 0
    for i in range(frames.shape[0]):
        frame_bgr = frames[i][:, :, ::-1].astype(np.float32).copy()
        path = out_dir / f"{prefix}_{i:05d}.exr"
        try:
            if cv2.imwrite(str(path), frame_bgr, params):
                saved += 1
        except Exception as exc:
            LOGGER.warning("LTXV HDR EXR 保存中止：%s", exc)
            break

    LOGGER.info("LTXV HDR 已保存 %d/%d 个 EXR 帧到 %s", saved, frames.shape[0], out_dir)


class GJJ_LTXVHDRDecodePostprocess:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {
                        "display_name": "图像",
                        "tooltip": "VAE Decode 后的 HDR IC-LoRA 图像，范围通常为 [0, 1]。",
                    },
                ),
                "exposure": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": -10.0,
                        "max": 10.0,
                        "step": 0.1,
                        "display": "slider",
                        "display_name": "曝光",
                        "tooltip": "曝光档位 EV。0 不调整，+1 亮度加倍，-1 亮度减半。",
                    },
                ),
                "save_exr": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "保存EXR",
                        "tooltip": "开启后尝试保存线性 HDR EXR 序列；当前 OpenCV 不支持 EXR 时会自动跳过，不中断工作流。",
                    },
                ),
                "output_dir": (
                    "STRING",
                    {
                        "default": "hdr_exr",
                        "display_name": "输出目录",
                        "tooltip": "EXR 输出目录。相对路径会保存到 ComfyUI output 下；写 output/hdr_exr 也会自动归一为 output 目录内的 hdr_exr。",
                    },
                ),
                "filename_prefix": (
                    "STRING",
                    {
                        "default": "frame",
                        "display_name": "文件名前缀",
                        "tooltip": "EXR 文件名前缀，最终形如 frame_00000.exr。",
                    },
                ),
                "half_precision": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "半精度EXR",
                        "tooltip": "开启后保存 float16 EXR，体积更小；关闭后保存 float32 EXR。",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("色调映射图", "线性HDR")
    OUTPUT_TOOLTIPS = (
        "Reinhard 色调映射并转换到 sRGB 后的 SDR 预览图。",
        "LogC3 解压后的线性 HDR 图像，保留高动态范围数值。",
    )
    FUNCTION = "postprocess"
    CATEGORY = "GJJ/视频模型/LTX"
    OUTPUT_NODE = True
    DESCRIPTION = "GJJ 零外部节点依赖版 LTXVHDR Decode Postprocess：解压 LogC3 HDR、生成 SDR 预览，并可尽力保存 EXR。OpenCV EXR 不可用时不会报错中断。"
    GJJ_HELP = {
        "title": "LTXV HDR解码后处理",
        "description": "复刻 LTXVHDRDecodePostprocess。修复原节点在 save_exr=True 但 OpenCV EXR 未启用时直接 AssertionError 中断的问题。",
        "usage": [
            "放在 VAE Decode 后，用于 HDR IC-LoRA 工作流。",
            "色调映射图用于预览，线性HDR用于继续处理或保存。",
            "保存EXR开启但环境不支持 EXR 时会跳过保存并继续输出；要真正写 EXR，请在启动 ComfyUI 前设置 OPENCV_IO_ENABLE_OPENEXR=1。",
        ],
    }

    def postprocess(
        self,
        image: torch.Tensor,
        exposure: float = 0.0,
        save_exr: bool = False,
        output_dir: str = "hdr_exr",
        filename_prefix: str = "frame",
        half_precision: bool = True,
    ):
        if image is None or not torch.is_tensor(image) or image.ndim != 4:
            raise RuntimeError("LTXV HDR解码后处理失败：图像输入必须是 IMAGE tensor，形状为 [批次, 高, 宽, 通道]。")

        hdr = _hdr_decompress(image)
        hdr = torch.clamp(hdr, min=0.0, max=1e4)

        exposure_mult = 2.0 ** float(exposure or 0.0)
        hdr_exposed = hdr * exposure_mult
        tonemapped_linear = (hdr_exposed / (1.0 + hdr_exposed)).clamp(0.0, 1.0)
        tonemapped = _linear_to_srgb(tonemapped_linear)

        if bool(save_exr):
            _save_exr_frames(hdr, output_dir, filename_prefix, bool(half_precision))

        return (tonemapped, hdr)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTXVHDRDecodePostprocess}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
