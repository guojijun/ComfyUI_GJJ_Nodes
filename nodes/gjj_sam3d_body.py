from __future__ import annotations

import os
import struct
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np
import torch

import folder_paths


GJJ_ROOT = Path(__file__).resolve().parents[1]
VENDOR_DIR = GJJ_ROOT / "vendor"
SAM3D_VENDOR_DIR = VENDOR_DIR / "sam_3d_body"
DEFAULT_MODEL_DIR = Path(folder_paths.models_dir) / "sam3dbody"
_MODEL_CACHE: dict[tuple[str, str, str, str], dict[str, Any]] = {}


def _ensure_vendor_path() -> None:
    vendor = str(VENDOR_DIR)
    if vendor not in sys.path:
        sys.path.insert(0, vendor)


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _require_runtime() -> None:
    _ensure_vendor_path()
    if not SAM3D_VENDOR_DIR.is_dir():
        raise RuntimeError("GJJ 缺少内置 sam_3d_body 运行包，请确认 GJJ/vendor/sam_3d_body 存在。")
    try:
        import sam_3d_body  # noqa: F401
    except Exception as exc:
        raise RuntimeError(
            "GJJ 内置 sam_3d_body 运行包导入失败。\n"
            "请确认当前 ComfyUI 环境具备 torch、torchvision、opencv、safetensors，并且 GJJ/vendor/roma 未被删除。\n"
            f"详细错误：{exc}"
        ) from exc


def _resolve_model_paths(model_path: str) -> tuple[str, str, str]:
    root = Path(str(model_path or "").strip() or DEFAULT_MODEL_DIR).expanduser()
    root = root.resolve()
    candidates = [
        root / "model.safetensors",
        root / "model.ckpt",
    ]
    ckpt_path = next((path for path in candidates if path.is_file()), candidates[0])
    mhr_path = root / "assets" / "mhr_model.pt"
    return str(root), str(ckpt_path), str(mhr_path)


def _missing_model_message(root: str, ckpt_path: str, mhr_path: str) -> str:
    return (
        "未找到 SAM 3D Body 模型文件。\n"
        f"模型目录：{root}\n"
        "请放置以下文件：\n"
        f"- {ckpt_path}\n"
        f"- {mhr_path}\n"
        "模型可从 Hugging Face 的 facebook/sam-3d-body-dinov3 或 apozz/sam-3d-body-safetensors 获取；"
        "该模型需要授权访问，GJJ 不会在后台静默下载。"
    )


def _resolve_dtype(precision: str) -> torch.dtype:
    if precision == "bf16":
        return torch.bfloat16
    if precision == "fp16":
        return torch.float16
    return torch.float32


def _auto_precision(precision: str) -> str:
    if precision != "auto":
        return str(precision or "fp32")
    try:
        import comfy.model_management as mm

        device = mm.get_torch_device()
        if mm.should_use_bf16(device):
            return "bf16"
        if mm.should_use_fp16(device):
            return "fp16"
    except Exception:
        pass
    return "fp32"


def _load_runtime(model_config: dict[str, Any]) -> dict[str, Any]:
    _require_runtime()
    root = str(model_config.get("model_path") or DEFAULT_MODEL_DIR)
    ckpt_path = str(model_config.get("ckpt_path") or "")
    mhr_path = str(model_config.get("mhr_path") or "")
    precision = _auto_precision(str(model_config.get("precision") or "fp32"))
    attn_backend = str(model_config.get("attn_backend") or "auto")
    if not os.path.isfile(ckpt_path) or not os.path.isfile(mhr_path):
        raise RuntimeError(_missing_model_message(root, ckpt_path, mhr_path))

    cache_key = (ckpt_path, mhr_path, precision, attn_backend)
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]

    import comfy.model_management as mm
    from sam_3d_body import load_sam_3d_body
    from sam_3d_body.attention import set_attn_backend

    set_attn_backend(attn_backend)
    dtype = _resolve_dtype(precision)
    device = mm.get_torch_device()
    model, model_cfg, _ = load_sam_3d_body(checkpoint_path=ckpt_path, mhr_path=mhr_path, dtype=dtype)
    model.to(device)
    model.eval()
    result = {"model": model, "model_cfg": model_cfg, "mhr_path": mhr_path, "device": device}
    _MODEL_CACHE[cache_key] = result
    return result


def _image_to_bgr(image: torch.Tensor, index: int = 0) -> np.ndarray:
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise RuntimeError(f"输入图像维度无效：{tuple(image.shape)}")
    frame = image[int(index)].detach().cpu().float().clamp(0.0, 1.0).numpy()
    return (frame[..., :3] * 255.0 + 0.5).astype(np.uint8)[..., ::-1].copy()


def _mask_to_bbox(mask: torch.Tensor | None, index: int = 0) -> np.ndarray | None:
    if mask is None:
        return None
    mask_tensor = mask.detach().cpu().float()
    if mask_tensor.ndim == 2:
        mask_np = mask_tensor.numpy()
    elif mask_tensor.ndim == 3:
        mask_np = mask_tensor[min(index, int(mask_tensor.shape[0]) - 1)].numpy()
    else:
        raise RuntimeError(f"遮罩维度无效：{tuple(mask_tensor.shape)}")
    rows = np.any(mask_np > 0.5, axis=1)
    cols = np.any(mask_np > 0.5, axis=0)
    if not rows.any() or not cols.any():
        return None
    y0, y1 = np.where(rows)[0][[0, -1]]
    x0, x1 = np.where(cols)[0][[0, -1]]
    return np.array([[x0, y0, x1, y1]], dtype=np.float32)


def _bgr_to_image(image: np.ndarray) -> torch.Tensor:
    rgb = image[..., ::-1].copy().astype(np.float32) / 255.0
    return torch.from_numpy(rgb).unsqueeze(0)


def _process_frame(loaded: dict[str, Any], image_bgr: np.ndarray, bbox: np.ndarray | None, inference_type: str, bbox_threshold: float):
    import cv2
    from sam_3d_body import SAM3DBodyEstimator

    estimator = SAM3DBodyEstimator(
        sam_3d_body_model=loaded["model"],
        model_cfg=loaded["model_cfg"],
        human_detector=None,
        human_segmentor=None,
        fov_estimator=None,
    )
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as handle:
        temp_path = handle.name
    try:
        cv2.imwrite(temp_path, image_bgr)
        outputs = estimator.process_one_image(
            temp_path,
            bboxes=bbox,
            masks=None,
            bbox_thr=float(bbox_threshold),
            use_mask=bbox is not None,
            inference_type=str(inference_type or "full"),
        )
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass
    return outputs or [], estimator.faces


def _tensor_or_array_to_numpy(value: Any) -> np.ndarray | None:
    if value is None:
        return None
    if torch.is_tensor(value):
        return value.detach().cpu().numpy()
    return np.asarray(value)


def _coordinate_transform(vertices: np.ndarray, mode: str) -> np.ndarray:
    if mode == "rotate_x_180":
        result = vertices.copy()
        result[..., 1] = -result[..., 1]
        result[..., 2] = -result[..., 2]
        return result
    if mode == "rotate_y_180":
        result = vertices.copy()
        result[..., 0] = -result[..., 0]
        result[..., 2] = -result[..., 2]
        return result
    if mode == "rotate_z_180":
        result = vertices.copy()
        result[..., 0] = -result[..., 0]
        result[..., 1] = -result[..., 1]
        return result
    return vertices


def _moving_average(sequence: np.ndarray, window: int) -> np.ndarray:
    window = max(1, int(window))
    if window <= 1 or sequence.shape[0] <= 1:
        return sequence
    half = window // 2
    padded = np.pad(sequence, [(half, half), (0, 0), (0, 0)], mode="edge")
    output = np.empty_like(sequence)
    for index in range(sequence.shape[0]):
        output[index] = padded[index:index + window].mean(axis=0)
    return output


def _save_smpl_sequence(path: str, vertices: np.ndarray, faces: np.ndarray, fps: float) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    vertices = np.ascontiguousarray(vertices, dtype=np.float32)
    faces = np.ascontiguousarray(faces, dtype=np.uint32)
    with output.open("wb") as handle:
        handle.write(b"SMPL")
        handle.write(struct.pack("I", int(vertices.shape[0])))
        handle.write(struct.pack("I", int(vertices.shape[1])))
        handle.write(struct.pack("I", int(faces.shape[0])))
        handle.write(struct.pack("f", float(fps)))
        handle.write(vertices.reshape(-1).tobytes())
        handle.write(faces.reshape(-1).tobytes())


class GJJ_LoadSAM3DBodyModel:
    CATEGORY = "guojijun/内部引用"
    DEPRECATED = True
    FUNCTION = "load_model"
    RETURN_TYPES = ("SAM3D_MODEL",)
    RETURN_NAMES = ("SAM3D模型",)
    OUTPUT_TOOLTIPS = ("GJJ 内部 SAM 3D Body 模型配置；模型在处理节点中懒加载并缓存。",)
    DESCRIPTION = "GJJ 内置 SAM 3D Body 模型加载器，不依赖 ComfyUI-SAM3DBody 自定义节点包。"
    SEARCH_ALIASES = []

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_path": ("STRING", {"default": str(DEFAULT_MODEL_DIR), "display_name": "模型目录", "tooltip": "包含 model.safetensors 和 assets/mhr_model.pt 的目录，默认 models/sam3dbody。"}),
                "attn_backend": (["auto", "sdpa", "flash_attn", "sage_attn", "xformers"], {"default": "auto", "display_name": "注意力后端", "tooltip": "默认跟随 ComfyUI；兼容优先可选 sdpa。"}),
                "precision": (["auto", "fp32", "bf16", "fp16"], {"default": "auto", "display_name": "精度", "tooltip": "auto 会按当前设备选择；兼容性问题可改 fp32。"}),
            },
        }

    def load_model(self, model_path, attn_backend="auto", precision="auto"):
        root, ckpt_path, mhr_path = _resolve_model_paths(model_path)
        return ({
            "model_path": root,
            "ckpt_path": ckpt_path,
            "mhr_path": mhr_path,
            "attn_backend": str(attn_backend or "auto"),
            "precision": _auto_precision(str(precision or "auto")),
            "provider": "GJJ",
        },)


class GJJ_SAM3DBodyProcess:
    CATEGORY = "guojijun/内部引用"
    DEPRECATED = True
    FUNCTION = "process"
    RETURN_TYPES = ("SAM3D_OUTPUT", "SKELETON", "IMAGE")
    RETURN_NAMES = ("网格数据", "骨架数据", "调试图")
    OUTPUT_TOOLTIPS = ("SAM3D Body 输出的顶点、面和相机数据。", "人体骨架和姿态参数。", "调试预览图。")
    DESCRIPTION = "GJJ 内置 SAM 3D Body 单图人体网格恢复节点。"
    SEARCH_ALIASES = []

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("SAM3D_MODEL", {"display_name": "SAM3D模型", "tooltip": "内部 SAM3D Body 模型配置。"}),
                "image": ("IMAGE", {"display_name": "输入图像", "tooltip": "包含人体主体的图像。"}),
                "bbox_threshold": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.05, "display_name": "人体检测阈值", "tooltip": "没有遮罩时用于人体检测；接入遮罩时主要作为兜底阈值。"}),
                "inference_type": (["full", "body", "hand"], {"default": "full", "display_name": "推理类型", "tooltip": "full 为身体+手部，body 仅身体，hand 仅手部。"}),
            },
            "optional": {
                "mask": ("MASK", {"display_name": "人体遮罩", "tooltip": "可选。白色区域会转换为人体框，减少自动检测失败。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def process(self, model, image, bbox_threshold=0.8, inference_type="full", mask=None, unique_id=None):
        _send_status(unique_id, "加载 GJJ 内置 SAM3D Body 模型...", 0.05)
        loaded = _load_runtime(model)
        image_bgr = _image_to_bgr(image, 0)
        bbox = _mask_to_bbox(mask, 0)
        _send_status(unique_id, "恢复单图人体 3D 网格...", 0.35)
        outputs, faces = _process_frame(loaded, image_bgr, bbox, inference_type, float(bbox_threshold))
        if not outputs:
            raise RuntimeError("SAM3D Body 未检测到人体。请提供更清晰的全身图，或接入人体遮罩。")
        output = outputs[0]
        mesh_data = {
            "vertices": _tensor_or_array_to_numpy(output.get("pred_vertices")),
            "faces": _tensor_or_array_to_numpy(faces),
            "joints": _tensor_or_array_to_numpy(output.get("pred_keypoints_3d")),
            "joint_coords": _tensor_or_array_to_numpy(output.get("pred_joint_coords")),
            "joint_rotations": _tensor_or_array_to_numpy(output.get("pred_global_rots")),
            "camera": _tensor_or_array_to_numpy(output.get("pred_cam_t")),
            "focal_length": output.get("focal_length"),
            "bbox": _tensor_or_array_to_numpy(output.get("bbox")),
            "raw_output": output,
            "mhr_path": loaded.get("mhr_path"),
        }
        skeleton = {
            "joint_positions": mesh_data["joint_coords"],
            "joint_rotations": mesh_data["joint_rotations"],
            "camera": mesh_data["camera"],
            "focal_length": mesh_data["focal_length"],
        }
        _send_status(unique_id, "完成 SAM3D Body 单图恢复。", 1.0)
        return (mesh_data, skeleton, _bgr_to_image(image_bgr))


class GJJ_SAM3DMeshSequenceFromVideo:
    CATEGORY = "guojijun/内部引用"
    DEPRECATED = True
    FUNCTION = "generate_from_video_frames"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("SMPL序列文件",)
    OUTPUT_TOOLTIPS = ("保存到 output/Adv3DViewer_JK_tmp 的 SMPL 二进制序列路径，可接 3D 查看器。",)
    OUTPUT_NODE = True
    DESCRIPTION = "GJJ 内置 SAM3D Body 视频帧转人体网格序列节点，兼容 SAM3D From Video JK 的输出格式。"
    SEARCH_ALIASES = []

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("SAM3D_MODEL", {"display_name": "SAM3D模型", "tooltip": "内部 SAM3D Body 模型配置。"}),
                "image": ("IMAGE", {"display_name": "视频帧序列", "tooltip": "IMAGE batch，每张图作为一帧处理。"}),
                "output_filename": ("STRING", {"default": "mesh_sequence", "multiline": False, "display_name": "输出文件名", "tooltip": "不需要扩展名；会自动保存为 .bin。"}),
                "bbox_threshold": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.05, "display_name": "人体检测阈值", "tooltip": "检测人体框的置信度阈值。"}),
                "inference_type": (["full", "body", "hand"], {"default": "full", "display_name": "推理类型", "tooltip": "full 为身体+手部，body 仅身体，hand 仅手部。"}),
                "fps": ("FLOAT", {"default": 30.0, "min": 1.0, "max": 240.0, "step": 1.0, "display_name": "序列帧率", "tooltip": "写入 SMPL 序列文件的帧率。"}),
                "smoothing": ("BOOLEAN", {"default": True, "display_name": "时间平滑", "tooltip": "对成功帧顶点做简单移动平均，减少抖动。"}),
                "smoothing_window": ("INT", {"default": 5, "min": 1, "max": 31, "step": 2, "display_name": "平滑窗口", "tooltip": "移动平均窗口，建议使用奇数。"}),
                "coordinate_transform": (["rotate_z_180", "none", "rotate_y_180", "rotate_x_180"], {"default": "rotate_z_180", "display_name": "坐标变换", "tooltip": "用于兼容部分 3D 查看器的朝向。"}),
            },
            "optional": {
                "mask": ("MASK", {"display_name": "人体遮罩序列", "tooltip": "可选。单张遮罩会复用到所有帧，多张遮罩按帧对应。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def generate_from_video_frames(
        self,
        model,
        image,
        output_filename,
        bbox_threshold=0.8,
        inference_type="full",
        fps=30.0,
        smoothing=True,
        smoothing_window=5,
        coordinate_transform="rotate_z_180",
        mask=None,
        unique_id=None,
    ):
        frames = image.unsqueeze(0) if image.ndim == 3 else image
        if frames.ndim != 4 or int(frames.shape[0]) <= 0:
            raise RuntimeError(f"视频帧序列维度无效：{tuple(frames.shape)}")
        loaded = _load_runtime(model)
        output_dir = Path(folder_paths.get_output_directory()) / "Adv3DViewer_JK_tmp"
        output_dir.mkdir(parents=True, exist_ok=True)
        safe_name = "".join(ch for ch in str(output_filename or "mesh_sequence").strip() if ch not in '<>:"/\\|?*') or "mesh_sequence"
        output_path = output_dir / f"{safe_name}_{int(time.time() * 1000)}.bin"

        vertices_list: list[np.ndarray | None] = []
        faces = None
        valid_count = 0
        total = int(frames.shape[0])
        for index in range(total):
            _send_status(unique_id, f"处理 SAM3D 视频帧 {index + 1}/{total}...", 0.05 + 0.85 * ((index + 1) / total))
            try:
                outputs, current_faces = _process_frame(
                    loaded,
                    _image_to_bgr(frames, index),
                    _mask_to_bbox(mask, index),
                    str(inference_type),
                    float(bbox_threshold),
                )
                if faces is None:
                    faces = _tensor_or_array_to_numpy(current_faces)
                if outputs:
                    vertices = _tensor_or_array_to_numpy(outputs[0].get("pred_vertices"))
                    if vertices is not None:
                        vertices_list.append(vertices.astype(np.float32, copy=False))
                        valid_count += 1
                        continue
            except Exception:
                pass
            vertices_list.append(None)

        if valid_count <= 0 or faces is None:
            raise RuntimeError("SAM3D Body 没有在任何视频帧中恢复出人体网格。请检查图像、遮罩和模型文件。")
        template = next(item for item in vertices_list if item is not None)
        sequence = np.stack([item if item is not None else np.zeros_like(template) for item in vertices_list], axis=0)
        valid_indices = [index for index, item in enumerate(vertices_list) if item is not None]
        if bool(smoothing) and len(valid_indices) > 1:
            sequence[valid_indices] = _moving_average(sequence[valid_indices], int(smoothing_window))
        sequence = _coordinate_transform(sequence, str(coordinate_transform or "none"))
        _save_smpl_sequence(str(output_path), sequence, faces, float(fps))
        _send_status(unique_id, f"完成：{valid_count}/{total} 帧，已保存 {output_path.name}", 1.0)
        return (str(output_path),)


NODE_CLASS_MAPPINGS = {}

NODE_DISPLAY_NAME_MAPPINGS = {}
