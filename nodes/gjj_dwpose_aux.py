import json
import math
import os
from pathlib import Path

import numpy as np
import torch

import comfy.model_management as model_management
import comfy.utils
import folder_paths

from ..vendor.gjj_dwpose.types import BodyResult, Keypoint, PoseResult
from .common_utils.dependency_checker import (
    build_dependency_model_report,
    load_dependency_at_runtime,
    print_dependency_model_report,
    send_dependency_model_notice,
)


MAX_RESOLUTION = 16384
RESIZE_MODES = ["Just Resize", "Crop and Resize", "Resize and Fill"]
DEFAULT_DWPOSE_POSE = "dw-ll_ucoco_384_bs5.torchscript.pt"
DEFAULT_DWPOSE_DET = "yolox_l.onnx"
DWPOSE_MODEL_SUBDIR = "DWPose"
NODE_DISPLAY_NAME = "GJJ · 🦴 本地DWPose姿态检测"
DWPose_DEPENDENCY = {
    "module_name": "cv2",
    "package_name": "opencv-python",
    "display_name": "cv2",
    "description": "GJJ 本地 DWPose 需要 OpenCV 进行图像缩放、骨架绘制和 ONNX DNN 推理。",
}
REQUIRED_DWPOSE_POSE_MODEL = {
    "label": "DWPose 姿态模型",
    "subdir": f"models/controlnet/{DWPOSE_MODEL_SUBDIR}",
    "filename": DEFAULT_DWPOSE_POSE,
    "description": "DWPose 姿态估计 TorchScript 模型。",
}
OPTIONAL_DWPOSE_BBOX_MODEL = {
    "label": "DWPose 人体框检测器",
    "subdir": f"models/controlnet/{DWPOSE_MODEL_SUBDIR}",
    "filename": DEFAULT_DWPOSE_DET,
    "description": "可选人体框检测模型；选择 None 时按整图估计。",
}
_cv2 = None
_Wholebody = None
try:
    import importlib.util

    _DEPENDENCIES_AVAILABLE = importlib.util.find_spec("cv2") is not None
except Exception:
    _DEPENDENCIES_AVAILABLE = False
_MISSING_DEPENDENCIES = [] if _DEPENDENCIES_AVAILABLE else [DWPose_DEPENDENCY]


def _controlnet_model_exists(basename):
    try:
        folder_paths.add_model_folder_path("controlnet", str(Path(folder_paths.models_dir) / "controlnet"))
        candidates = [
            f"{DWPOSE_MODEL_SUBDIR}/{basename}",
            basename,
        ]
        return any(folder_paths.get_full_path("controlnet", candidate) for candidate in candidates)
    except Exception:
        return False


_MISSING_MODELS = [] if _controlnet_model_exists(DEFAULT_DWPOSE_POSE) else [REQUIRED_DWPOSE_POSE_MODEL]
_MODELS_AVAILABLE = not _MISSING_MODELS
cv2 = None
_DEPENDENCY_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_MISSING_DEPENDENCIES,
    missing_models=_MISSING_MODELS,
    install_packages=[DWPose_DEPENDENCY["package_name"]] if _MISSING_DEPENDENCIES else [],
)
_DWPOSE_DESCRIPTION = (
    "GJJ 本地 DWPose 姿态检测，运行时代码已内置到 GJJ，不依赖 comfyui_controlnet_aux。"
    if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
    else _DEPENDENCY_REPORT["warning_message"]
)


def _load_cv2_runtime():
    global _cv2, cv2
    if _cv2 is None:
        _cv2 = load_dependency_at_runtime(
            module_name="cv2",
            node_name=NODE_DISPLAY_NAME,
            package_name="opencv-python",
            description=DWPose_DEPENDENCY["description"],
        )
        cv2 = _cv2
    return _cv2


def _load_wholebody_runtime():
    global _Wholebody
    _load_cv2_runtime()
    if _Wholebody is None:
        try:
            from ..vendor.gjj_dwpose.wholebody import Wholebody as _LoadedWholebody
        except Exception as exc:
            report = build_dependency_model_report(
                node_name=NODE_DISPLAY_NAME,
                missing_dependencies=[DWPose_DEPENDENCY],
                install_packages=[DWPose_DEPENDENCY["package_name"]],
                original_error=str(exc),
            )
            err = RuntimeError(report["warning_message"])
            setattr(err, "gjj_report", report)
            raise err from exc
        _Wholebody = _LoadedWholebody
    return _Wholebody


def _ensure_controlnet_model_folder():
    model_dir = Path(folder_paths.models_dir) / "controlnet"
    folder_paths.add_model_folder_path("controlnet", str(model_dir))
    return model_dir


def _list_dwpose_model_names(kind):
    _ensure_controlnet_model_folder()
    suffixes = {
        "pose": (".torchscript.pt", ".onnx"),
        "bbox": (".onnx", ".torchscript.pt"),
    }[kind]
    keywords = {
        "pose": ("dw-", "ucoco"),
        "bbox": ("yolox", "yolo_nas"),
    }[kind]
    names = []
    for name in folder_paths.get_filename_list("controlnet"):
        lower = str(name).replace("\\", "/").lower()
        if not lower.endswith(suffixes):
            continue
        if all(keyword in lower for keyword in keywords[:1]) or any(keyword in lower for keyword in keywords):
            names.append(name)
    return sorted(set(names), key=lambda item: (DWPOSE_MODEL_SUBDIR.lower() not in item.replace("\\", "/").lower(), item.lower()))


def _combo_with_default(names, default):
    values = list(names)
    rel_default = f"{DWPOSE_MODEL_SUBDIR}/{default}"
    if rel_default not in values:
        values.insert(0, rel_default)
    if default not in values:
        values.append(default)
    return values


def _resolve_controlnet_file(name, role):
    if not name or name == "None":
        return None
    _ensure_controlnet_model_folder()
    candidates = [str(name)]
    basename = os.path.basename(str(name).replace("\\", "/"))
    candidates.extend([
        f"{DWPOSE_MODEL_SUBDIR}/{basename}",
        basename,
    ])
    for candidate in candidates:
        path = folder_paths.get_full_path("controlnet", candidate)
        if path and os.path.exists(path):
            return path
    report = build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[
            {
                "label": f"DWPose {role}模型",
                "subdir": f"models/controlnet/{DWPOSE_MODEL_SUBDIR}",
                "filename": basename,
                "description": f"当前选择的 DWPose {role}模型未找到。",
            }
        ],
    )
    err = RuntimeError(report.get("panel_message") or report.get("warning_message") or f"未找到 DWPose {role} 模型。")
    setattr(err, "gjj_report", report)
    raise err


def _hwc3(x):
    if x.ndim == 2:
        x = x[:, :, None]
    if x.shape[2] == 3:
        return x
    if x.shape[2] == 1:
        return np.concatenate([x, x, x], axis=2)
    if x.shape[2] == 4:
        color = x[:, :, 0:3].astype(np.float32)
        alpha = x[:, :, 3:4].astype(np.float32) / 255.0
        return (color * alpha + 255.0 * (1.0 - alpha)).clip(0, 255).astype(np.uint8)
    raise RuntimeError(f"不支持的图像通道数：{x.shape[2]}")


def _resize_image_with_pad(image, resolution, upscale_method="INTER_CUBIC"):
    image = _hwc3(image)
    h_raw, w_raw, _ = image.shape
    if int(resolution) <= 0:
        return np.ascontiguousarray(image.copy()), lambda x: x
    scale = float(resolution) / float(min(h_raw, w_raw))
    h_target = int(np.round(float(h_raw) * scale))
    w_target = int(np.round(float(w_raw) * scale))
    interpolation = getattr(cv2, upscale_method, cv2.INTER_CUBIC) if scale > 1 else cv2.INTER_AREA
    resized = cv2.resize(image, (w_target, h_target), interpolation=interpolation)
    h_pad = int(np.ceil(float(h_target) / 64.0) * 64 - h_target)
    w_pad = int(np.ceil(float(w_target) / 64.0) * 64 - w_target)
    padded = np.pad(resized, [[0, h_pad], [0, w_pad], [0, 0]], mode="edge")

    def remove_pad(x):
        return np.ascontiguousarray(x[:h_target, :w_target, ...].copy())

    return np.ascontiguousarray(padded.copy()), remove_pad


def _compress_keypoints(keypoints):
    if not keypoints:
        return None
    return [
        value
        for keypoint in keypoints
        for value in (
            [float(keypoint.x), float(keypoint.y), float(keypoint.score)]
            if keypoint is not None
            else [0.0, 0.0, 0.0]
        )
    ]


def _encode_poses(poses, canvas_height, canvas_width):
    return {
        "people": [
            {
                "pose_keypoints_2d": _compress_keypoints(pose.body.keypoints),
                "face_keypoints_2d": _compress_keypoints(pose.face),
                "hand_left_keypoints_2d": _compress_keypoints(pose.left_hand),
                "hand_right_keypoints_2d": _compress_keypoints(pose.right_hand),
            }
            for pose in poses
        ],
        "canvas_height": int(canvas_height),
        "canvas_width": int(canvas_width),
    }


def _is_normalized(keypoints):
    points = [0 <= abs(k.x) <= 1 and 0 <= abs(k.y) <= 1 for k in keypoints if k is not None]
    return bool(points) and all(points)


def _draw_body(canvas, keypoints, xinsr_stick_scaling=False):
    if not keypoints:
        return canvas
    h, w, _ = canvas.shape if _is_normalized(keypoints) else (1.0, 1.0, 3)
    ch, cw, _ = canvas.shape
    stick_scale = 1
    if xinsr_stick_scaling:
        max_side = max(cw, ch)
        stick_scale = 1 if max_side < 500 else min(2 + (max_side // 1000), 7)
    limbs = [[2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10], [10, 11], [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18]]
    colors = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]]
    for (a, b), color in zip(limbs, colors):
        p1 = keypoints[a - 1]
        p2 = keypoints[b - 1]
        if p1 is None or p2 is None:
            continue
        y_vals = np.array([p1.x, p2.x]) * float(w)
        x_vals = np.array([p1.y, p2.y]) * float(h)
        m_x = np.mean(x_vals)
        m_y = np.mean(y_vals)
        length = ((x_vals[0] - x_vals[1]) ** 2 + (y_vals[0] - y_vals[1]) ** 2) ** 0.5
        angle = math.degrees(math.atan2(x_vals[0] - x_vals[1], y_vals[0] - y_vals[1]))
        polygon = cv2.ellipse2Poly((int(m_y), int(m_x)), (int(length / 2), 4 * stick_scale), int(angle), 0, 360, 1)
        cv2.fillConvexPoly(canvas, polygon, [int(float(c) * 0.6) for c in color])
    for keypoint, color in zip(keypoints, colors):
        if keypoint is None:
            continue
        cv2.circle(canvas, (int(keypoint.x * w), int(keypoint.y * h)), 4, color, thickness=-1)
    return canvas


def _draw_hand(canvas, keypoints):
    if not keypoints:
        return canvas
    h, w, _ = canvas.shape if _is_normalized(keypoints) else (1.0, 1.0, 3)
    edges = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20]]
    for idx, (a, b) in enumerate(edges):
        p1 = keypoints[a]
        p2 = keypoints[b]
        if p1 is None or p2 is None:
            continue
        color = (np.array(cv2.cvtColor(np.uint8([[[idx * 179 / len(edges), 255, 255]]]), cv2.COLOR_HSV2RGB)[0, 0])).tolist()
        cv2.line(canvas, (int(p1.x * w), int(p1.y * h)), (int(p2.x * w), int(p2.y * h)), color, thickness=2)
    for keypoint in keypoints:
        if keypoint is not None:
            cv2.circle(canvas, (int(keypoint.x * w), int(keypoint.y * h)), 4, (0, 0, 255), thickness=-1)
    return canvas


def _draw_face(canvas, keypoints):
    if not keypoints:
        return canvas
    h, w, _ = canvas.shape if _is_normalized(keypoints) else (1.0, 1.0, 3)
    for keypoint in keypoints:
        if keypoint is not None:
            cv2.circle(canvas, (int(keypoint.x * w), int(keypoint.y * h)), 3, (255, 255, 255), thickness=-1)
    return canvas


def _draw_poses(poses, height, width, draw_body=True, draw_hand=True, draw_face=True, xinsr_stick_scaling=False):
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    for pose in poses:
        if draw_body:
            canvas = _draw_body(canvas, pose.body.keypoints, xinsr_stick_scaling)
        if draw_hand:
            canvas = _draw_hand(canvas, pose.left_hand)
            canvas = _draw_hand(canvas, pose.right_hand)
        if draw_face:
            canvas = _draw_face(canvas, pose.face)
    return canvas


class GJJ_PixelPerfectResolution:
    DESCRIPTION = "按 ControlNet Pixel Perfect 规则，根据原图和生成尺寸计算预处理分辨率。"
    CATEGORY = "GJJ/ControlNet"
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("分辨率",)
    OUTPUT_TOOLTIPS = ("建议填入预处理器 resolution 的整数分辨率。",)
    FUNCTION = "execute"
    SEARCH_ALIASES = ["Pixel Perfect Resolution", "像素完美分辨率", "controlnet"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": ("IMAGE", {"display_name": "原始图像", "tooltip": "用于读取原图宽高的输入图像。"}),
                "image_gen_width": ("INT", {"default": 512, "min": 64, "max": 8192, "step": 8, "display_name": "生成宽度", "tooltip": "最终生成图像的目标宽度。"}),
                "image_gen_height": ("INT", {"default": 512, "min": 64, "max": 8192, "step": 8, "display_name": "生成高度", "tooltip": "最终生成图像的目标高度。"}),
                "resize_mode": (RESIZE_MODES, {"default": "Just Resize", "display_name": "缩放模式", "tooltip": "与 ControlNet 预处理器一致：直接缩放、裁剪适配或填充适配。"}),
            }
        }

    def execute(self, original_image, image_gen_width, image_gen_height, resize_mode):
        _, raw_h, raw_w, _ = original_image.shape
        k0 = float(image_gen_height) / float(raw_h)
        k1 = float(image_gen_width) / float(raw_w)
        if resize_mode == "Resize and Fill":
            estimation = min(k0, k1) * float(min(raw_h, raw_w))
        else:
            estimation = max(k0, k1) * float(min(raw_h, raw_w))
        return (int(np.round(estimation)),)


class GJJ_DWPoseEstimator:
    DESCRIPTION = _DWPOSE_DESCRIPTION
    CATEGORY = "GJJ/ControlNet"
    RETURN_TYPES = ("IMAGE", "POSE_KEYPOINT")
    RETURN_NAMES = ("姿态图", "姿态关键点")
    OUTPUT_TOOLTIPS = ("绘制好的 OpenPose 风格姿态图，可接 ControlNet。", "OpenPose JSON 兼容结构，可被支持 POSE_KEYPOINT 的节点使用。")
    FUNCTION = "estimate_pose"
    SEARCH_ALIASES = ["DWPose Estimator", "DWPreprocessor", "openpose", "controlnet"]
    REQUIRED_MODELS = [
        REQUIRED_DWPOSE_POSE_MODEL,
        OPTIONAL_DWPOSE_BBOX_MODEL,
    ]
    GJJ_HELP = {
        "description": _DWPOSE_DESCRIPTION,
        "notice": _DEPENDENCY_REPORT["help_message"] if not _DEPENDENCY_REPORT["available"] else "",
        "install_cmd": _DEPENDENCY_REPORT["install_cmd"] if not _DEPENDENCY_REPORT["available"] else "",
        "copy_text": _DEPENDENCY_REPORT["copy_text"] if not _DEPENDENCY_REPORT["available"] else "",
        "copy_label": _DEPENDENCY_REPORT["copy_label"] if not _DEPENDENCY_REPORT["available"] else "",
        "warning_message": _DEPENDENCY_REPORT["warning_message"] if not _DEPENDENCY_REPORT["available"] else "",
        "models": REQUIRED_MODELS,
        "dependencies": [
            "opencv-python（cv2；图像缩放、骨架绘制和 ONNX DNN 推理）",
        ],
        "tips": [
            "这是 GJJ 内置运行时版本，不需要安装 comfyui_controlnet_aux。",
            "默认姿态模型使用 TorchScript，可走当前 PyTorch 设备。",
            "bbox 检测模型 yolox_l.onnx 依赖当前环境的 OpenCV DNN 或 onnxruntime；如果加载失败，可把 bbox 检测器设为 None。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        pose_models = _combo_with_default(_list_dwpose_model_names("pose"), DEFAULT_DWPOSE_POSE)
        bbox_models = ["None"] + _combo_with_default(_list_dwpose_model_names("bbox"), DEFAULT_DWPOSE_DET)
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "图像", "tooltip": "需要检测姿态的输入图像，支持批量。"}),
                "detect_body": (["enable", "disable"], {"default": "enable", "display_name": "检测身体", "tooltip": "是否输出身体骨架关键点。"}),
                "detect_hand": (["enable", "disable"], {"default": "enable", "display_name": "检测手部", "tooltip": "是否输出手部关键点。"}),
                "detect_face": (["enable", "disable"], {"default": "enable", "display_name": "检测面部", "tooltip": "是否输出面部关键点。"}),
                "resolution": ("INT", {"default": 512, "min": 64, "max": MAX_RESOLUTION, "step": 64, "display_name": "预处理分辨率", "tooltip": "姿态图输出的短边分辨率；可接像素完美分辨率节点。"}),
                "bbox_detector": (bbox_models, {"default": f"{DWPOSE_MODEL_SUBDIR}/{DEFAULT_DWPOSE_DET}", "display_name": "人体框检测器", "tooltip": "用于先找人物位置。设为 None 时按整张图估计，可避免 ONNX 检测器加载问题。"}),
                "pose_estimator": (pose_models, {"default": f"{DWPOSE_MODEL_SUBDIR}/{DEFAULT_DWPOSE_POSE}", "display_name": "姿态模型", "tooltip": "DWPose 姿态估计模型；推荐 TorchScript bs5 版本。"}),
                "scale_stick_for_xinsr_cn": (["disable", "enable"], {"default": "disable", "display_name": "Xinsir骨架加粗", "tooltip": "为 Xinsir OpenPose ControlNet 放大骨架线宽。"}),
            }
            ,
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def estimate_pose(self, image, detect_body="enable", detect_hand="enable", detect_face="enable", resolution=512, bbox_detector=f"{DWPOSE_MODEL_SUBDIR}/{DEFAULT_DWPOSE_DET}", pose_estimator=f"{DWPOSE_MODEL_SUBDIR}/{DEFAULT_DWPOSE_POSE}", scale_stick_for_xinsr_cn="disable", unique_id=None):
        try:
            Wholebody = _load_wholebody_runtime()
        except Exception as exc:
            report = getattr(exc, "gjj_report", None) or _DEPENDENCY_REPORT
            if report:
                print_dependency_model_report(report, title="GJJ 节点运行环境缺失！")
                send_dependency_model_notice(report, unique_id=unique_id)
            raise RuntimeError(report.get("warning_message") or "DWPose 运行时依赖缺失。") from None
        try:
            det_path = _resolve_controlnet_file(bbox_detector, "人体框检测")
            pose_path = _resolve_controlnet_file(pose_estimator, "姿态估计")
        except Exception as exc:
            report = getattr(exc, "gjj_report", None)
            if report:
                print_dependency_model_report(report, title="GJJ 节点模型缺失！")
                send_dependency_model_notice(report, unique_id=unique_id)
                raise RuntimeError(report.get("warning_message") or "DWPose 模型缺失。") from None
            raise
        runtime = Wholebody(det_path, pose_path, torchscript_device=model_management.get_torch_device())
        batch_size = image.shape[0]
        pbar = comfy.utils.ProgressBar(batch_size)
        outputs = []
        openpose_dicts = []
        include_body = detect_body == "enable"
        include_hand = detect_hand == "enable"
        include_face = detect_face == "enable"
        xinsr = scale_stick_for_xinsr_cn == "enable"
        for tensor_image in image:
            np_image = np.asarray(tensor_image.cpu() * 255.0, dtype=np.uint8)
            np_image, _ = _resize_image_with_pad(np_image, 0)
            with torch.no_grad():
                keypoints_info = runtime(np_image.copy())
            poses = Wholebody.format_result(keypoints_info)
            filtered = [
                PoseResult(
                    body=pose.body if include_body else BodyResult([None] * 18, 0.0, 0),
                    left_hand=pose.left_hand if include_hand else None,
                    right_hand=pose.right_hand if include_hand else None,
                    face=pose.face if include_face else None,
                )
                for pose in poses
            ]
            canvas = _draw_poses(filtered, np_image.shape[0], np_image.shape[1], include_body, include_hand, include_face, xinsr)
            canvas, remove_pad = _resize_image_with_pad(canvas, int(resolution))
            canvas = _hwc3(remove_pad(canvas))
            openpose_dicts.append(_encode_poses(filtered, np_image.shape[0], np_image.shape[1]))
            outputs.append(torch.from_numpy(canvas.astype(np.float32) / 255.0))
            pbar.update(1)
        del runtime
        return {
            "ui": {"openpose_json": [json.dumps(openpose_dicts, ensure_ascii=False, indent=2)]},
            "result": (torch.stack(outputs, dim=0), openpose_dicts),
        }


NODE_CLASS_MAPPINGS = {
    "GJJ_PixelPerfectResolution": GJJ_PixelPerfectResolution,
    "GJJ_DWPoseEstimator": GJJ_DWPoseEstimator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_PixelPerfectResolution": "🧮 像素完美分辨率",
    "GJJ_DWPoseEstimator": NODE_DISPLAY_NAME,
}
