import importlib
import importlib.util
import json
import os
from pathlib import Path
from typing import Any

import numpy as np
import torch

import folder_paths
from comfy.utils import ProgressBar

from .common_utils.dependency_checker import (
    build_dependency_model_report,
    make_missing_model_spec,
    print_dependency_model_report,
    send_dependency_model_notice,
)


NODE_NAME = "GJJ_WanAnimatePoseFaceAIO"
NODE_DISPLAY_NAME = "GJJ · 🧍 WanAnimate姿态脸部一体"
CATEGORY = "GJJ/视频模型/万相视频"
MODEL_SUBDIR = "models/detection"
PLACEHOLDER_MODEL = "未找到 models/detection 下的 ONNX 模型"
MODEL_EXTENSIONS = {".onnx"}

DEPENDENCY_SPECS = [
    {
        "module_name": "onnxruntime",
        "package_name": "onnxruntime-gpu",
        "display_name": "onnxruntime",
        "description": "加载并运行 ViTPose / YOLO ONNX 模型；需要 CUDAExecutionProvider 时建议安装 onnxruntime-gpu。",
    },
    {
        "module_name": "cv2",
        "package_name": "opencv-python",
        "display_name": "cv2",
        "description": "用于图像缩放、人体框后处理、脸部裁剪和姿态图绘制。",
    },
]

REQUIRED_MODELS = [
    make_missing_model_spec(
        label="ViTPose WholeBody ONNX",
        subdir=MODEL_SUBDIR,
        filename="vitpose-l-wholebody.onnx",
        description="姿态关键点估计模型；可放在 models/detection 或其子目录。",
    ),
    make_missing_model_spec(
        label="YOLO ONNX 人体检测器",
        subdir=MODEL_SUBDIR,
        filename="yolov10m.onnx",
        description="人体框检测模型；可放在 models/detection 或其子目录。",
    ),
]

BASE_DESCRIPTION = (
    "把 GetImageSizeAndCount、OnnxDetectionModelLoader、PoseAndFaceDetection、DrawViTPose "
    "合并成一个 GJJ 内置节点：从 models/detection 扫描 ONNX 模型，输出姿态图、脸部图、原图宽高帧数、姿态数据和框信息。"
)


def _module_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def _missing_dependency_specs() -> list[dict[str, str]]:
    return [spec for spec in DEPENDENCY_SPECS if not _module_available(spec["module_name"])]


def _ensure_detection_folder() -> None:
    existing = getattr(folder_paths, "folder_names_and_paths", {})
    detection_dir = os.path.join(folder_paths.models_dir, "detection")
    current = existing.get("detection")
    if current:
        paths, extensions = current
        path_list = list(paths or [])
        if detection_dir not in path_list:
            path_list.append(detection_dir)
        ext_set = set(extensions or [])
        ext_set.update(MODEL_EXTENSIONS)
        existing["detection"] = (path_list, ext_set)
        return
    existing["detection"] = ([detection_dir], set(MODEL_EXTENSIONS))


def _normalize_relpath(value: Any) -> str:
    return str(value or "").strip().replace("\\", "/").strip("/")


def _strip_onnx(value: Any) -> str:
    text = _normalize_relpath(value)
    return text[:-5] if text.lower().endswith(".onnx") else text


def _display_model_name(value: Any) -> str:
    return _strip_onnx(value).replace("/", "\\")


def _detection_model_files() -> list[str]:
    _ensure_detection_folder()
    try:
        files = folder_paths.get_filename_list("detection")
    except Exception:
        files = []
    result: list[str] = []
    seen: set[str] = set()
    for filename in files or []:
        rel = _normalize_relpath(filename)
        if not rel.lower().endswith(".onnx"):
            continue
        key = rel.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(rel)
    return sorted(result, key=lambda item: item.lower())


def _detection_model_choices() -> list[str]:
    choices = [_display_model_name(filename) for filename in _detection_model_files()]
    return choices or [PLACEHOLDER_MODEL]


def _selected_filename_hint(selection: Any) -> str:
    text = str(selection or "").strip()
    if not text or text == PLACEHOLDER_MODEL:
        return "<模型名>.onnx"
    return text if text.lower().endswith(".onnx") else f"{text}.onnx"


def _model_spec(label: str, selection: Any, description: str = "") -> dict[str, str]:
    return make_missing_model_spec(
        label=label,
        subdir=MODEL_SUBDIR,
        filename=_selected_filename_hint(selection),
        description=description or "请把 ONNX 模型放到 models/detection 或其子目录后刷新 ComfyUI。",
    )


def _missing_model_specs() -> list[dict[str, str]]:
    if _detection_model_files():
        return []
    return [
        make_missing_model_spec(
            label="ONNX 检测模型目录",
            subdir=MODEL_SUBDIR,
            filename="vitpose-l-wholebody.onnx / yolov10m.onnx",
            description="节点只扫描 models/detection 下的 .onnx 文件，支持中文子目录。",
        )
    ]


def _build_environment_report() -> dict[str, Any]:
    return build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=_missing_dependency_specs(),
        missing_models=_missing_model_specs(),
        install_packages=[spec["package_name"] for spec in DEPENDENCY_SPECS],
        description="GJJ 内置 WanAnimate 姿态脸部一体节点不依赖 KJNodes 或 ComfyUI-WanAnimatePreprocess，但需要 ONNX Runtime、OpenCV 和本地 detection 模型。",
        model_download_url="https://huggingface.co/models?search=vitpose-l-wholebody.onnx%20yolov10m.onnx",
    )


_ENV_REPORT = _build_environment_report()
DESCRIPTION = BASE_DESCRIPTION if _ENV_REPORT.get("available", False) else f"{_ENV_REPORT['warning_message']}\n\n{BASE_DESCRIPTION}"


def _raise_report(report: dict[str, Any], title: str, unique_id=None) -> None:
    print_dependency_model_report(report, title=title)
    send_dependency_model_notice(report, unique_id=unique_id)
    raise RuntimeError(report.get("warning_message") or report.get("panel_message") or "GJJ WanAnimate 姿态脸部节点运行失败。")


def _resolve_detection_model(selection: Any, label: str, unique_id=None) -> str:
    selected = _normalize_relpath(selection)
    if not selected or selected == _normalize_relpath(PLACEHOLDER_MODEL):
        report = build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[_model_spec(label, selection)],
            description="没有可用的 models/detection ONNX 模型可加载。",
            model_download_url="https://huggingface.co/models?search=vitpose-l-wholebody.onnx%20yolov10m.onnx",
        )
        _raise_report(report, "GJJ WanAnimate 模型缺失！", unique_id=unique_id)

    query = selected[:-5] if selected.lower().endswith(".onnx") else selected
    query_key = query.lower()
    for rel in _detection_model_files():
        stripped = _strip_onnx(rel)
        candidates = {
            rel.lower(),
            stripped.lower(),
            rel.replace("/", "\\").lower(),
            stripped.replace("/", "\\").lower(),
        }
        if query_key in candidates or selected.lower() in candidates:
            path = folder_paths.get_full_path("detection", rel)
            if path and os.path.exists(path):
                return path

    direct_candidates = [selected]
    if not selected.lower().endswith(".onnx"):
        direct_candidates.append(f"{selected}.onnx")
    checked: set[str] = set()
    for candidate in direct_candidates:
        rel = candidate.replace("\\", "/")
        if rel.lower() in checked:
            continue
        checked.add(rel.lower())
        path = folder_paths.get_full_path("detection", rel)
        if path and os.path.exists(path):
            return path

    report = build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[_model_spec(label, selection, "当前下拉选择没有解析到实际 .onnx 文件；请确认文件仍在 models/detection 下。")],
        description="已按去掉 .onnx 的显示名反查真实文件，但没有找到匹配项。",
        model_download_url="https://huggingface.co/models?search=vitpose-l-wholebody.onnx%20yolov10m.onnx",
    )
    _raise_report(report, "GJJ WanAnimate 模型缺失！", unique_id=unique_id)
    return ""


def _load_runtime(unique_id=None) -> dict[str, Any]:
    missing_deps = _missing_dependency_specs()
    if missing_deps:
        report = build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=missing_deps,
            install_packages=[spec["package_name"] for spec in DEPENDENCY_SPECS],
            description="GJJ WanAnimate 姿态脸部一体节点需要 ONNX Runtime 与 OpenCV 才能运行本地模型。",
            model_download_url="",
        )
        _raise_report(report, "GJJ WanAnimate 运行依赖缺失！", unique_id=unique_id)

    try:
        cv2 = importlib.import_module("cv2")
        onnx_models = importlib.import_module(".vendor.gjj_wananimate.models.onnx_models", package=__package__)
        pose2d_utils = importlib.import_module(".vendor.gjj_wananimate.pose_utils.pose2d_utils", package=__package__)
        visualization = importlib.import_module(".vendor.gjj_wananimate.pose_utils.human_visualization", package=__package__)
        runtime_utils = importlib.import_module(".vendor.gjj_wananimate.utils", package=__package__)
        retarget_pose = importlib.import_module(".vendor.gjj_wananimate.retarget_pose", package=__package__)
    except Exception as exc:
        report = build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=DEPENDENCY_SPECS,
            install_packages=[spec["package_name"] for spec in DEPENDENCY_SPECS],
            description="GJJ 内置 WanAnimate runtime 导入失败。",
            original_error=str(exc),
            model_download_url="",
        )
        _raise_report(report, "GJJ WanAnimate 运行依赖缺失！", unique_id=unique_id)

    return {
        "cv2": cv2,
        "ViTPose": onnx_models.ViTPose,
        "Yolo": onnx_models.Yolo,
        "AAPoseMeta": pose2d_utils.AAPoseMeta,
        "bbox_from_detector": pose2d_utils.bbox_from_detector,
        "crop": pose2d_utils.crop,
        "load_pose_metas_from_kp2ds_seq": pose2d_utils.load_pose_metas_from_kp2ds_seq,
        "draw_aapose_by_meta_new": visualization.draw_aapose_by_meta_new,
        "get_face_bboxes": runtime_utils.get_face_bboxes,
        "padding_resize": runtime_utils.padding_resize,
        "resize_by_area": runtime_utils.resize_by_area,
        "resize_to_bounds": runtime_utils.resize_to_bounds,
        "get_retarget_pose": retarget_pose.get_retarget_pose,
    }


def _bbox_valid(bbox: Any) -> bool:
    if bbox is None:
        return False
    arr = np.asarray(bbox).reshape(-1)
    if arr.shape[0] < 4:
        return False
    if arr.shape[0] >= 5 and arr[4] <= 0:
        return False
    return bool((arr[2] - arr[0]) >= 10 and (arr[3] - arr[1]) >= 10)


def _full_bbox(width: int, height: int) -> np.ndarray:
    return np.array([0, 0, int(width), int(height)], dtype=np.float32)


def _bbox_xyxy_tuple(bbox: Any, width: int, height: int) -> tuple[int, int, int, int]:
    arr = np.asarray(bbox).reshape(-1)
    if arr.shape[0] < 4:
        arr = _full_bbox(width, height)
    x1 = max(0, min(int(round(float(arr[0]))), int(width)))
    y1 = max(0, min(int(round(float(arr[1]))), int(height)))
    x2 = max(0, min(int(round(float(arr[2]))), int(width)))
    y2 = max(0, min(int(round(float(arr[3]))), int(height)))
    if x2 <= x1 or y2 <= y1:
        return (0, 0, int(width), int(height))
    return (x1, y1, x2, y2)


class GJJ_WanAnimatePoseFaceAIO:
    DESCRIPTION = DESCRIPTION
    CATEGORY = CATEGORY
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "INT", "INT", "INT", "POSEDATA", "STRING", "BBOX", "BBOX")
    RETURN_NAMES = ("姿态图", "脸部图", "原图", "宽度", "高度", "帧数", "姿态数据", "关键帧身体点", "人体框", "脸部框")
    OUTPUT_TOOLTIPS = (
        "DrawViTPose 输出的姿态图批次。",
        "PoseAndFaceDetection 裁出的 512x512 脸部图批次。",
        "原图透传，等同 GetImageSizeAndCount 的 image 输出。",
        "输入图像宽度。",
        "输入图像高度。",
        "输入批次数量。",
        "内部姿态数据，保留给需要 POSEDATA 的后续节点。",
        "关键帧身体点 JSON 字符串。",
        "每帧人体框，格式 x0、y0、x1、y1。",
        "每帧脸部框，格式 x0、y0、x1、y1。",
    )
    FUNCTION = "process"
    SEARCH_ALIASES = [
        "GetImageSizeAndCount",
        "OnnxDetectionModelLoader",
        "PoseAndFaceDetection",
        "DrawViTPose",
        "ONNX Detection Model Loader",
        "Pose and Face Detection",
        "Draw ViT Pose",
        "WanAnimatePreprocess",
        "vitpose",
        "yolo",
        "姿态脸部检测",
        "WanAnimate姿态",
    ]
    REQUIRED_MODELS = REQUIRED_MODELS
    GJJ_HELP = {
        "description": DESCRIPTION,
        "notice": _ENV_REPORT["help_message"] if not _ENV_REPORT.get("available", True) else "",
        "install_cmd": _ENV_REPORT["install_cmd"] if not _ENV_REPORT.get("available", True) else "",
        "copy_text": _ENV_REPORT["copy_text"] if not _ENV_REPORT.get("available", True) else "",
        "copy_label": _ENV_REPORT["copy_label"] if not _ENV_REPORT.get("available", True) else "",
        "warning_message": _ENV_REPORT["warning_message"] if not _ENV_REPORT.get("available", True) else "",
        "models": REQUIRED_MODELS,
        "dependencies": [
            "onnxruntime-gpu / onnxruntime（运行 ViTPose 和 YOLO ONNX）",
            "opencv-python（cv2；图像缩放、NMS、裁剪和绘制）",
        ],
        "tips": [
            "这是 GJJ 内置合并节点，不需要安装 KJNodes 或 ComfyUI-WanAnimatePreprocess 插件本体。",
            "模型列表从 models/detection 扫描 .onnx 文件，显示时只去掉 .onnx 后缀，保留中文子目录。",
            "搜索 GetImageSizeAndCount、OnnxDetectionModelLoader、PoseAndFaceDetection、DrawViTPose 都能找到此节点。",
        ],
    }

    def __init__(self):
        self._model_key: tuple[str, str, str] | None = None
        self._model: dict[str, Any] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        model_choices = _detection_model_choices()
        default_model = model_choices[0]
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "图像", "tooltip": "需要检测姿态和脸部的输入图像或视频帧批次。"}),
                "vitpose_model": (model_choices, {"default": default_model, "display_name": "ViTPose模型", "tooltip": "从 models/detection 扫描 .onnx，显示名会去掉 .onnx 后缀并保留子目录。"}),
                "yolo_model": (model_choices, {"default": default_model, "display_name": "YOLO模型", "tooltip": "从 models/detection 扫描 .onnx，显示名会去掉 .onnx 后缀并保留子目录。"}),
                "onnx_device": (["CPUExecutionProvider", "CUDAExecutionProvider"], {"default": "CPUExecutionProvider", "display_name": "ONNX设备", "tooltip": "CPU 默认最稳；CUDAExecutionProvider 需要 onnxruntime-gpu 与 CUDA/cuDNN DLL 路径完整。"}),
                "width": ("INT", {"default": 832, "min": 64, "max": 4096, "step": 1, "display_name": "输出宽度", "tooltip": "姿态图输出宽度。"}),
                "height": ("INT", {"default": 480, "min": 64, "max": 4096, "step": 1, "display_name": "输出高度", "tooltip": "姿态图输出高度。"}),
                "retarget_padding": ("INT", {"default": 16, "min": 0, "max": 512, "step": 1, "display_name": "重定向留白", "tooltip": "有参考图时，按姿态非黑区域裁切后额外保留的像素。0 表示只做等比填充缩放。"}),
                "body_stick_width": ("INT", {"default": -1, "min": -1, "max": 20, "step": 1, "display_name": "身体线宽", "tooltip": "-1 自动，0 隐藏身体线，其它值为像素线宽。"}),
                "hand_stick_width": ("INT", {"default": -1, "min": -1, "max": 20, "step": 1, "display_name": "手部线宽", "tooltip": "-1 自动，0 隐藏手部，其它值为像素线宽。"}),
                "draw_head": ("BOOLEAN", {"default": True, "display_name": "绘制头部", "tooltip": "是否绘制头部关键点和连线。"}),
            },
            "optional": {
                "retarget_image": ("IMAGE", {"default": None, "display_name": "参考姿态图", "tooltip": "可选。接入后按参考图姿态比例重定向输出姿态。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def _get_model(self, runtime: dict[str, Any], vitpose_path: str, yolo_path: str, onnx_device: str, unique_id=None) -> dict[str, Any]:
        key = (str(vitpose_path), str(yolo_path), str(onnx_device))
        if self._model_key == key and self._model is not None:
            return self._model

        self._cleanup_model()
        try:
            model = {
                "vitpose": runtime["ViTPose"](vitpose_path, onnx_device),
                "yolo": runtime["Yolo"](yolo_path, onnx_device),
            }
        except Exception as exc:
            report = build_dependency_model_report(
                node_name=NODE_DISPLAY_NAME,
                missing_models=[
                    make_missing_model_spec("ViTPose模型", MODEL_SUBDIR, os.path.basename(vitpose_path), "ONNX Runtime 无法加载当前 ViTPose 模型。"),
                    make_missing_model_spec("YOLO模型", MODEL_SUBDIR, os.path.basename(yolo_path), "ONNX Runtime 无法加载当前 YOLO 模型。"),
                ],
                description="模型文件存在，但 ONNX Runtime 初始化失败；请检查模型类型、ONNX Runtime 版本和所选执行设备。",
                original_error=str(exc),
                model_download_url="https://huggingface.co/models?search=vitpose-l-wholebody.onnx%20yolov10m.onnx",
            )
            _raise_report(report, "GJJ WanAnimate ONNX 模型加载失败！", unique_id=unique_id)
        self._model_key = key
        self._model = model
        return model

    def _cleanup_model(self) -> None:
        if not self._model:
            return
        for item in self._model.values():
            cleanup = getattr(item, "cleanup", None)
            if callable(cleanup):
                try:
                    cleanup()
                except Exception:
                    pass
        self._model = None
        self._model_key = None

    def _detect_pose_and_face(self, runtime: dict[str, Any], model: dict[str, Any], images: torch.Tensor, width: int, height: int, retarget_image=None):
        cv2 = runtime["cv2"]
        detector = model["yolo"]
        pose_model = model["vitpose"]
        batch, image_h, image_w, channels = images.shape

        shape = np.array([image_h, image_w])[None]
        images_np = images.detach().cpu().numpy().astype(np.float32)

        img_norm_mean = np.array([0.485, 0.456, 0.406])
        img_norm_std = np.array([0.229, 0.224, 0.225])
        input_resolution = (256, 192)
        rescale = 1.25
        refer_img = None
        refer_pose_meta = None

        detector.reinit()
        pose_model.reinit()
        if retarget_image is not None:
            refer_img = runtime["resize_by_area"](retarget_image[0].detach().cpu().numpy() * 255.0, int(width) * int(height), divisor=16) / 255.0
            ref_shape = np.array([refer_img.shape[0], refer_img.shape[1]])[None]
            ref_bbox = detector(cv2.resize(refer_img.astype(np.float32), (640, 640)).transpose(2, 0, 1)[None], ref_shape)[0][0]["bbox"]
            if not _bbox_valid(ref_bbox):
                ref_bbox = _full_bbox(refer_img.shape[1], refer_img.shape[0])
            center, scale = runtime["bbox_from_detector"](ref_bbox, input_resolution, rescale=rescale)
            cropped_ref = runtime["crop"](refer_img, center, scale, (input_resolution[0], input_resolution[1]))[0]
            img_norm = (cropped_ref - img_norm_mean) / img_norm_std
            img_norm = img_norm.transpose(2, 0, 1).astype(np.float32)
            ref_keypoints = pose_model(img_norm[None], np.array(center)[None], np.array(scale)[None])
            refer_pose_meta = runtime["load_pose_metas_from_kp2ds_seq"](ref_keypoints, width=retarget_image.shape[2], height=retarget_image.shape[1])[0]

        pbar = ProgressBar(max(1, int(batch) * 3))
        bboxes_raw = []
        for img in images_np:
            bbox = detector(cv2.resize(img, (640, 640)).transpose(2, 0, 1)[None], shape)[0][0]["bbox"]
            bboxes_raw.append(bbox)
            pbar.update(1)
        detector.cleanup()

        kp2ds = []
        body_bboxes = []
        for img, bbox in zip(images_np, bboxes_raw):
            if not _bbox_valid(bbox):
                bbox = _full_bbox(img.shape[1], img.shape[0])
            body_bboxes.append(_bbox_xyxy_tuple(bbox, img.shape[1], img.shape[0]))
            center, scale = runtime["bbox_from_detector"](bbox, input_resolution, rescale=rescale)
            cropped_img = runtime["crop"](img, center, scale, (input_resolution[0], input_resolution[1]))[0]
            img_norm = (cropped_img - img_norm_mean) / img_norm_std
            img_norm = img_norm.transpose(2, 0, 1).astype(np.float32)
            keypoints = pose_model(img_norm[None], np.array(center)[None], np.array(scale)[None])
            kp2ds.append(keypoints)
            pbar.update(1)
        pose_model.cleanup()

        kp2ds = np.concatenate(kp2ds, 0)
        pose_metas = runtime["load_pose_metas_from_kp2ds_seq"](kp2ds, width=image_w, height=image_h)

        face_images = []
        face_bboxes = []
        for idx, meta in enumerate(pose_metas):
            try:
                x1, x2, y1, y2 = runtime["get_face_bboxes"](meta["keypoints_face"][:, :2], scale=1.3, image_shape=(image_h, image_w))
            except Exception:
                fallback_size = int(min(image_h, image_w) * 0.3)
                x1 = max(0, (image_w - fallback_size) // 2)
                x2 = min(image_w, x1 + fallback_size)
                y1 = max(0, int(image_h * 0.1))
                y2 = min(image_h, y1 + fallback_size)
            face_bboxes.append((int(x1), int(y1), int(x2), int(y2)))
            face_image = images_np[idx][int(y1):int(y2), int(x1):int(x2)]
            if face_image.size == 0 or face_image.shape[0] == 0 or face_image.shape[1] == 0:
                fallback_size = int(min(image_h, image_w) * 0.3)
                fallback_x1 = max(0, (image_w - fallback_size) // 2)
                fallback_y1 = max(0, int(image_h * 0.1))
                face_image = images_np[idx][fallback_y1:fallback_y1 + fallback_size, fallback_x1:fallback_x1 + fallback_size]
                if face_image.size == 0:
                    face_image = np.zeros((max(1, fallback_size), max(1, fallback_size), channels), dtype=images_np.dtype)
            face_images.append(cv2.resize(face_image, (512, 512)))

        face_images_tensor = torch.from_numpy(np.stack(face_images, 0)).float().clamp(0.0, 1.0)

        if retarget_image is not None and refer_pose_meta is not None:
            retarget_pose_metas = runtime["get_retarget_pose"](pose_metas[0], refer_pose_meta, pose_metas, None, None)
        else:
            retarget_pose_metas = [runtime["AAPoseMeta"].from_humanapi_meta(meta) for meta in pose_metas]

        key_frame_num = 4 if batch >= 4 else 1
        key_frame_step = max(1, len(pose_metas) // key_frame_num)
        key_points_index = [0, 1, 2, 5, 8, 11, 10, 13]
        points_dict_list = []
        for key_frame_index in list(range(0, len(pose_metas), key_frame_step))[:key_frame_num]:
            body_key_points = pose_metas[key_frame_index]["keypoints_body"]
            keypoints_body_list = [
                body_key_points[each_index]
                for each_index in key_points_index
                if body_key_points[each_index] is not None
            ]
            if not keypoints_body_list:
                continue
            keypoints_body = np.array(keypoints_body_list)[:, :2]
            wh = np.array([[pose_metas[0]["width"], pose_metas[0]["height"]]])
            for point in (keypoints_body * wh).astype(np.int32):
                points_dict_list.append({"x": int(point[0]), "y": int(point[1])})

        pose_data = {
            "retarget_image": refer_img if retarget_image is not None else None,
            "pose_metas": retarget_pose_metas,
            "refer_pose_meta": refer_pose_meta if retarget_image is not None else None,
            "pose_metas_original": pose_metas,
        }

        return pose_data, face_images_tensor, json.dumps(points_dict_list, ensure_ascii=False), body_bboxes, face_bboxes, pbar

    def _draw_pose_images(self, runtime: dict[str, Any], pose_data: dict[str, Any], width: int, height: int, retarget_padding: int, body_stick_width: int, hand_stick_width: int, draw_head: bool, pbar: ProgressBar):
        retarget_image = pose_data.get("retarget_image", None)
        pose_metas = pose_data["pose_metas"]
        draw_hand = int(hand_stick_width) != 0
        use_retarget_resize = int(retarget_padding) > 0 and retarget_image is not None
        crop_target_image = None
        pose_images = []

        for meta in pose_metas:
            canvas = np.zeros((int(height), int(width), 3), dtype=np.uint8)
            pose_image = runtime["draw_aapose_by_meta_new"](
                canvas,
                meta,
                draw_hand=draw_hand,
                draw_head=bool(draw_head),
                body_stick_width=int(body_stick_width),
                hand_stick_width=int(hand_stick_width),
            )
            if crop_target_image is None:
                crop_target_image = pose_image
            if use_retarget_resize:
                pose_image = runtime["resize_to_bounds"](pose_image, int(height), int(width), crop_target_image=crop_target_image, extra_padding=int(retarget_padding))
            else:
                pose_image = runtime["padding_resize"](pose_image, int(height), int(width))
            pose_images.append(pose_image)
            pbar.update(1)

        return torch.from_numpy(np.stack(pose_images, 0)).float() / 255.0

    def process(
        self,
        image,
        vitpose_model,
        yolo_model,
        onnx_device,
        width,
        height,
        retarget_padding,
        body_stick_width,
        hand_stick_width,
        draw_head,
        retarget_image=None,
        unique_id=None,
    ):
        runtime = _load_runtime(unique_id=unique_id)
        vitpose_path = _resolve_detection_model(vitpose_model, "ViTPose模型", unique_id=unique_id)
        yolo_path = _resolve_detection_model(yolo_model, "YOLO人体检测模型", unique_id=unique_id)
        model = self._get_model(runtime, vitpose_path, yolo_path, str(onnx_device), unique_id=unique_id)

        input_width = int(image.shape[2])
        input_height = int(image.shape[1])
        count = int(image.shape[0])

        try:
            pose_data, face_images, key_frame_body_points, bboxes, face_bboxes, pbar = self._detect_pose_and_face(
                runtime,
                model,
                image,
                int(width),
                int(height),
                retarget_image=retarget_image,
            )
            pose_images = self._draw_pose_images(
                runtime,
                pose_data,
                int(width),
                int(height),
                int(retarget_padding),
                int(body_stick_width),
                int(hand_stick_width),
                bool(draw_head),
                pbar,
            )
        except Exception as exc:
            report = getattr(exc, "gjj_report", None)
            if report:
                send_dependency_model_notice(report, unique_id=unique_id)
                raise RuntimeError(report.get("warning_message") or "GJJ WanAnimate 姿态脸部处理失败。") from None
            raise

        return {
            "ui": {
                "text": [
                    f"{count}x{input_width}x{input_height}",
                    f"ViTPose: {_selected_filename_hint(vitpose_model)}",
                    f"YOLO: {_selected_filename_hint(yolo_model)}",
                ]
            },
            "result": (
                pose_images,
                face_images,
                image,
                input_width,
                input_height,
                count,
                pose_data,
                key_frame_body_points,
                bboxes,
                face_bboxes,
            ),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanAnimatePoseFaceAIO}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
