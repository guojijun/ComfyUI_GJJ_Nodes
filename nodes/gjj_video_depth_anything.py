from __future__ import annotations

import gc
import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import torch

try:
    import comfy.model_management as model_management
except Exception:
    model_management = None


NODE_NAME = "GJJ_VideoDepthAnything"
MODEL_RELATIVE_PATH = Path("depth_anything") / "video_depth_anything_vits.pth"
GJJ_ROOT = Path(__file__).resolve().parents[1]
VENDOR_ROOT = GJJ_ROOT / "vendor"
NODES_ROOT = GJJ_ROOT / "nodes"
if str(GJJ_ROOT) not in sys.path:
    sys.path.insert(0, str(GJJ_ROOT))
if str(NODES_ROOT) not in sys.path:
    sys.path.insert(0, str(NODES_ROOT))

try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
    )
except ImportError:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
    )


_MODEL_CACHE: dict[tuple[str, str, bool], Any] = {}
_VDA_CLASS = None
_DESCRIPTION_INTRO = "三合一零依赖 Video Depth Anything：加载 vits 模型、处理视频帧并输出深度灰度图/伪彩图/遮罩。"
_DEPENDENCY_SPECS = [
    {
        "module_name": "cv2",
        "package_name": "opencv-python",
        "display_name": "OpenCV (cv2)",
        "description": "用于视频帧缩放和深度伪彩色输出。",
    },
    {
        "module_name": "torchvision",
        "package_name": "torchvision",
        "display_name": "torchvision",
        "description": "Video Depth Anything 模型预处理需要 torchvision.transforms。",
    },
    {
        "module_name": "einops",
        "package_name": "einops",
        "display_name": "einops",
        "description": "Video Depth Anything 时序模块需要 einops。",
    },
    {
        "module_name": "easydict",
        "package_name": "easydict",
        "display_name": "easydict",
        "description": "Video Depth Anything DPT 模块需要 easydict。",
    },
    {
        "module_name": "tqdm",
        "package_name": "tqdm",
        "display_name": "tqdm",
        "description": "Video Depth Anything 推理循环需要 tqdm。",
    },
]


def _missing_dependency_specs() -> list[dict[str, str]]:
    missing: list[dict[str, str]] = []
    for spec in _DEPENDENCY_SPECS:
        if importlib.util.find_spec(spec["module_name"]) is None:
            missing.append(spec)
    return missing


def _load_runtime_dependencies(unique_id=None):
    cv2_mod = load_dependency_at_runtime(
        "cv2",
        "GJJ · 🕳️ 视频深度估计",
        package_name="opencv-python",
        description="该节点需要 OpenCV 处理视频帧缩放和深度伪彩色输出。",
        unique_id=unique_id,
    )
    load_dependency_at_runtime(
        "torchvision",
        "GJJ · 🕳️ 视频深度估计",
        package_name="torchvision",
        description="Video Depth Anything 模型预处理需要 torchvision.transforms。",
        unique_id=unique_id,
    )
    load_dependency_at_runtime(
        "einops",
        "GJJ · 🕳️ 视频深度估计",
        package_name="einops",
        description="Video Depth Anything 时序模块需要 einops。",
        unique_id=unique_id,
    )
    load_dependency_at_runtime(
        "easydict",
        "GJJ · 🕳️ 视频深度估计",
        package_name="easydict",
        description="Video Depth Anything DPT 模块需要 easydict。",
        unique_id=unique_id,
    )
    load_dependency_at_runtime(
        "tqdm",
        "GJJ · 🕳️ 视频深度估计",
        package_name="tqdm",
        description="Video Depth Anything 推理循环需要 tqdm。",
        unique_id=unique_id,
    )
    return cv2_mod


def _video_depth_anything_class(unique_id=None):
    global _VDA_CLASS
    if _VDA_CLASS is not None:
        return _VDA_CLASS
    _load_runtime_dependencies(unique_id=unique_id)
    try:
        from vendor.gjj_video_depth_anything.video_depth_anything.video_depth import VideoDepthAnything
    except Exception as exc:
        raise RuntimeError(f"视频深度估计失败：GJJ 内置 Video Depth Anything 运行时代码导入失败：{exc}") from exc
    _VDA_CLASS = VideoDepthAnything
    return _VDA_CLASS


def _as_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        result = int(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _as_float(value: Any, default: float, min_value: float, max_value: float) -> float:
    try:
        result = float(value)
    except Exception:
        result = default
    return max(min_value, min(max_value, result))


def _models_roots() -> list[Path]:
    roots: list[Path] = []
    try:
        import folder_paths

        models_dir = getattr(folder_paths, "models_dir", None)
        if models_dir:
            roots.append(Path(models_dir))
    except Exception:
        pass

    roots.extend(
        [
            Path("D:/AI/MOD/models"),
            Path("D:/AI/CUI/ComfyUI/models"),
            GJJ_ROOT.parents[1] / "models" if len(GJJ_ROOT.parents) > 1 else GJJ_ROOT / "models",
        ]
    )

    unique: list[Path] = []
    seen = set()
    for root in roots:
        try:
            resolved = root.resolve()
        except Exception:
            resolved = root
        key = str(resolved).lower()
        if key not in seen:
            seen.add(key)
            unique.append(resolved)
    return unique


def _resolve_model_path() -> Path:
    for root in _models_roots():
        candidate = root / MODEL_RELATIVE_PATH
        if candidate.exists():
            return candidate

    searched = "\n".join(str(root / MODEL_RELATIVE_PATH) for root in _models_roots())
    raise RuntimeError(
        "视频深度估计失败：未找到模型文件 models/depth_anything/video_depth_anything_vits.pth。\n"
        f"已搜索：\n{searched}"
    )


def _ensure_model_path(unique_id=None) -> Path:
    try:
        return _resolve_model_path()
    except RuntimeError as exc:
        raise_dependency_model_error(
            node_name="GJJ · 🕳️ 视频深度估计",
            missing_models=[
                make_missing_model_spec(
                    label="Video Depth Anything vits",
                    subdir="models/depth_anything",
                    filename="video_depth_anything_vits.pth",
                    description="视频深度估计模型。",
                )
            ],
            description="请把模型放到 models/depth_anything/video_depth_anything_vits.pth。",
            original_error=str(exc),
            unique_id=unique_id,
            copy_text="models/depth_anything/video_depth_anything_vits.pth",
            copy_label="📋 复制模型路径",
        )


def _missing_model_specs() -> list[dict[str, str]]:
    for root in _models_roots():
        if (root / MODEL_RELATIVE_PATH).exists():
            return []
    return [
        make_missing_model_spec(
            label="Video Depth Anything vits",
            subdir="models/depth_anything",
            filename="video_depth_anything_vits.pth",
            description="视频深度估计模型。",
        )
    ]


def _build_environment_report() -> dict[str, Any]:
    missing_dependencies = _missing_dependency_specs()
    missing_models = _missing_model_specs()
    return build_dependency_model_report(
        node_name="GJJ · 🕳️ 视频深度估计",
        missing_dependencies=missing_dependencies,
        missing_models=missing_models,
        install_packages=[spec["package_name"] for spec in missing_dependencies],
        description=(
            "该节点运行时代码已打包进 GJJ；如果缺少 Python 包，请先复制安装命令安装，"
            "如果缺少模型，请放到 models/depth_anything/video_depth_anything_vits.pth。"
        ),
    )


_ENVIRONMENT_REPORT = _build_environment_report()
_DESCRIPTION = (
    _DESCRIPTION_INTRO
    if _ENVIRONMENT_REPORT.get("available", True)
    else f"{_ENVIRONMENT_REPORT.get('warning_message', '')}\n\n{_DESCRIPTION_INTRO}"
)


def _torch_device() -> str:
    if model_management is not None:
        try:
            return str(model_management.get_torch_device())
        except Exception:
            pass
    return "cuda" if torch.cuda.is_available() else "cpu"


def _intermediate_device():
    if model_management is not None:
        try:
            return model_management.intermediate_device()
        except Exception:
            pass
    return torch.device("cpu")


def _load_model(device: str, fp32: bool, unique_id=None):
    model_path = str(_ensure_model_path(unique_id=unique_id))
    key = (model_path, device, bool(fp32))
    cached = _MODEL_CACHE.get(key)
    if cached is not None:
        if not fp32 and str(device).startswith("cuda"):
            _keep_fp32_output_head(cached)
        return cached

    configs = {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]}
    model_cls = _video_depth_anything_class(unique_id=unique_id)
    model = model_cls(**configs, metric=False)
    try:
        state_dict = torch.load(model_path, map_location="cpu", weights_only=True)
    except TypeError:
        state_dict = torch.load(model_path, map_location="cpu")
    model.load_state_dict(state_dict, strict=True)
    model = model.to(device).eval()
    if not fp32 and str(device).startswith("cuda"):
        model = model.half()
        _keep_fp32_output_head(model)

    _MODEL_CACHE[key] = model
    return model


def _keep_fp32_output_head(model) -> None:
    """Video Depth Anything casts the last head input to float before output_conv2."""
    try:
        output_conv2 = model.head.scratch.output_conv2
    except Exception:
        return
    try:
        output_conv2.float()
    except Exception:
        pass


def _resize_frames(frames: np.ndarray, max_res: int, cv2_mod) -> np.ndarray:
    if max_res <= 0:
        return frames
    height, width = frames.shape[1:3]
    largest = max(height, width)
    if largest <= max_res:
        return frames

    scale = max_res / float(largest)
    new_h = max(2, int(round(height * scale)))
    new_w = max(2, int(round(width * scale)))
    if new_h % 2:
        new_h += 1
    if new_w % 2:
        new_w += 1
    resized = [cv2_mod.resize(frame, (new_w, new_h), interpolation=cv2_mod.INTER_AREA) for frame in frames]
    return np.stack(resized, axis=0)


def _normalize_depths(depths: np.ndarray, invert: bool) -> np.ndarray:
    depth_min = float(np.min(depths))
    depth_max = float(np.max(depths))
    if depth_max <= depth_min:
        normalized = np.zeros_like(depths, dtype=np.float32)
    else:
        normalized = ((depths - depth_min) / (depth_max - depth_min)).astype(np.float32)
    if invert:
        normalized = 1.0 - normalized
    return np.clip(normalized, 0.0, 1.0)


def _to_gray_image(depth_norm: np.ndarray) -> torch.Tensor:
    gray = np.repeat(depth_norm[..., None], 3, axis=-1)
    return torch.from_numpy(gray.astype(np.float32))


def _to_color_image(depth_norm: np.ndarray, cv2_mod) -> torch.Tensor:
    color_frames = []
    for depth in depth_norm:
        depth_u8 = np.clip(depth * 255.0, 0, 255).astype(np.uint8)
        color_bgr = cv2_mod.applyColorMap(depth_u8, cv2_mod.COLORMAP_INFERNO)
        color_rgb = cv2_mod.cvtColor(color_bgr, cv2_mod.COLOR_BGR2RGB).astype(np.float32) / 255.0
        color_frames.append(color_rgb)
    return torch.from_numpy(np.stack(color_frames, axis=0).astype(np.float32))


def _cleanup_cuda() -> None:
    gc.collect()
    if model_management is not None:
        try:
            model_management.soft_empty_cache()
        except Exception:
            pass
    if torch.cuda.is_available():
        try:
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
        except Exception:
            pass


class GJJ_VideoDepthAnything:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "frames": (
                    "IMAGE",
                    {
                        "display_name": "视频帧",
                        "tooltip": "输入视频帧批量 IMAGE，形状为 [帧数, 高, 宽, 3]。",
                    },
                ),
                "input_size": (
                    "INT",
                    {
                        "default": 518,
                        "min": 196,
                        "max": 1024,
                        "step": 14,
                        "display_name": "模型输入尺寸",
                        "tooltip": "Video Depth Anything 推理尺寸，通常 518。会按模型要求对齐到 14 的倍数。",
                    },
                ),
                "max_res": (
                    "INT",
                    {
                        "default": 1280,
                        "min": 0,
                        "max": 4096,
                        "step": 64,
                        "display_name": "最大输出边",
                        "tooltip": "推理前限制最长边，0 表示不缩放。输出深度图尺寸等于缩放后的帧尺寸。",
                    },
                ),
                "target_fps": (
                    "FLOAT",
                    {
                        "default": 24.0,
                        "min": 1.0,
                        "max": 240.0,
                        "step": 0.1,
                        "display_name": "输出帧率",
                        "tooltip": "输出给下游保存视频节点使用的帧率数值；模型推理只原样返回该值。",
                    },
                ),
                "fp32": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "FP32推理",
                        "tooltip": "开启后使用 FP32，显存占用更高但更稳；关闭时 CUDA 使用半精度。",
                    },
                ),
                "invert_depth": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "反相深度",
                        "tooltip": "反转归一化深度明暗，便于适配不同下游节点。",
                    },
                ),
                "offload_after": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "完成后卸载模型",
                        "tooltip": "执行完成后从缓存移除模型并清理显存。显存紧张时开启，重复运行会重新加载模型。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK", "FLOAT")
    RETURN_NAMES = ("深度灰度图", "深度伪彩图", "深度遮罩", "帧率")
    OUTPUT_TOOLTIPS = (
        "归一化后的三通道灰度深度图。",
        "使用 inferno 调色板生成的深度预览图。",
        "归一化单通道深度 MASK，适合给其它节点继续处理。",
        "输入的输出帧率数值，便于接视频合成节点。",
    )
    FUNCTION = "process"
    CATEGORY = "GJJ/视频模型/深度"
    DESCRIPTION = _DESCRIPTION
    GJJ_HELP = {
        "title": "Video Depth Anything",
        "description": "把 LoadVideoDepthAnythingModel、VideoDepthAnythingProcess、VideoDepthAnythingOutput 合并为 GJJ 单节点；运行时代码已 vendored 到 GJJ，不依赖外部 Video-Depth-Anything 节点包。",
        "usage": [
            "模型固定使用 models/depth_anything/video_depth_anything_vits.pth。",
            "输入视频帧 IMAGE 批量，输出灰度深度、伪彩深度、深度 MASK 和帧率。",
            "显存紧张可降低最大输出边或开启完成后卸载模型。",
        ],
        "notice": "" if _ENVIRONMENT_REPORT.get("available", True) else _ENVIRONMENT_REPORT.get("help_message", ""),
        "install_cmd": "" if _ENVIRONMENT_REPORT.get("available", True) else _ENVIRONMENT_REPORT.get("install_cmd", ""),
        "copy_text": "" if _ENVIRONMENT_REPORT.get("available", True) else _ENVIRONMENT_REPORT.get("copy_text", ""),
        "copy_label": "" if _ENVIRONMENT_REPORT.get("available", True) else _ENVIRONMENT_REPORT.get("copy_label", ""),
        "warning_message": "" if _ENVIRONMENT_REPORT.get("available", True) else _ENVIRONMENT_REPORT.get("warning_message", ""),
        "model_download_url": "" if _ENVIRONMENT_REPORT.get("available", True) else _ENVIRONMENT_REPORT.get("model_download_url", ""),
    }

    def process(self, frames, input_size=518, max_res=1280, target_fps=24.0, fp32=False, invert_depth=False, offload_after=False, unique_id=None):
        if not torch.is_tensor(frames) or frames.ndim != 4:
            raise RuntimeError("视频深度估计失败：视频帧输入必须是 [帧数, 高, 宽, 通道] 的 IMAGE tensor。")
        if frames.shape[0] < 1:
            raise RuntimeError("视频深度估计失败：至少需要 1 帧输入。")

        input_size = _as_int(input_size, 518, 196, 1024)
        input_size = max(196, int(round(input_size / 14.0)) * 14)
        max_res = _as_int(max_res, 1280, 0, 4096)
        fps = _as_float(target_fps, 24.0, 1.0, 240.0)
        device = _torch_device()
        missing_dependencies = _missing_dependency_specs()
        if missing_dependencies:
            raise_dependency_model_error(
                node_name="GJJ · 🕳️ 视频深度估计",
                missing_dependencies=missing_dependencies,
                install_packages=[spec["package_name"] for spec in missing_dependencies],
                description="请先安装缺失 Python 运行依赖；安装后重启 ComfyUI 再执行该节点。",
                unique_id=unique_id,
            )
        cv2_mod = _load_runtime_dependencies(unique_id=unique_id)

        np_frames = np.asarray(frames.detach().cpu().clamp(0, 1).numpy() * 255.0, dtype=np.uint8)
        np_frames = _resize_frames(np_frames, max_res, cv2_mod)

        try:
            model = _load_model(device, bool(fp32), unique_id=unique_id)
            depths, _ = model.infer_video_depth(np_frames, fps, input_size=input_size, device=device, fp32=bool(fp32))
            depth_norm = _normalize_depths(depths, bool(invert_depth))
            gray = _to_gray_image(depth_norm).to(_intermediate_device())
            color = _to_color_image(depth_norm, cv2_mod).to(_intermediate_device())
            mask = torch.from_numpy(depth_norm.astype(np.float32)).to(_intermediate_device())
            return (gray, color, mask, fps)
        except RuntimeError as exc:
            message = str(exc)
            if "out of memory" in message.lower():
                raise RuntimeError("视频深度估计失败：显存不足。请降低最大输出边或开启完成后卸载模型。") from exc
            raise
        finally:
            if offload_after:
                _MODEL_CACHE.clear()
            _cleanup_cuda()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoDepthAnything}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🕳️ 视频深度估计"}
