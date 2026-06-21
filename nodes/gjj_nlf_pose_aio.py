from __future__ import annotations

import copy
import importlib
import importlib.util
import logging
import os
from typing import Any

import numpy as np
import torch

import comfy.model_management as model_management
import comfy.utils

from .common_utils.dependency_checker import (
    build_dependency_model_report,
    build_node_help_payload,
    make_missing_model_spec,
    print_dependency_model_report,
    send_dependency_model_notice,
)
from .common_utils.model_manager import (
    gjjutils_list_model_files,
    gjjutils_resolve_model_file,
)


NODE_NAME = "GJJ_NLFPoseAIO"
NODE_DISPLAY_NAME = "GJJ · 🧍 NLF姿态一体"
CATEGORY = "GJJ/姿态"

AUTO = "Auto"
DEFAULT_NLF = "nlf_l_multi_0.3.2.torchscript"
DEFAULT_VITPOSE = "vitpose-l-wholebody.onnx"
DEFAULT_YOLO = "yolov10m.onnx"
DEFAULT_DWPOSE_POSE = "dw-ll_ucoco_384_bs5.torchscript.pt"
DEFAULT_DWPOSE_DET = "yolox_l.onnx"
DEFAULT_SDPOSE = DEFAULT_DWPOSE_POSE

NLF_EXTENSIONS = (".torchscript", ".pt", ".pth")
DETECTION_EXTENSIONS = (".onnx",)
CHECKPOINT_EXTENSIONS = (".safetensors", ".ckpt", ".pt", ".pth")
DWPOSE_EXTENSIONS = (".torchscript.pt", ".onnx", ".pt")

DEPENDENCY_SPECS = [
    {
        "module_name": "onnxruntime",
        "package_name": "onnxruntime-gpu",
        "display_name": "onnxruntime",
        "description": "运行 ViTPose / YOLO ONNX 模型；CUDAExecutionProvider 需要 onnxruntime-gpu。",
    },
    {
        "module_name": "cv2",
        "package_name": "opencv-python",
        "display_name": "cv2",
        "description": "用于 ONNX 检测后处理、DWPose 绘制和 NLF 2D 姿态叠加。",
    },
]

MODEL_TREE = [
    {
        "label": "NLF 3D姿态模型",
        "folder": "nlf",
        "filename": DEFAULT_NLF,
        "required": True,
        "description": "TorchScript NLF 模型；节点会在 models/nlf 下递归智能查找。",
    },
    {
        "label": "ViTPose WholeBody",
        "folder": "detection",
        "filename": DEFAULT_VITPOSE,
        "required": False,
        "description": "可选参考 DWPose；连接参考图时用于和 NLF 姿态对齐。",
    },
    {
        "label": "YOLO 人体检测器",
        "folder": "detection",
        "filename": DEFAULT_YOLO,
        "required": False,
        "description": "ViTPose 参考姿态检测配套的人体框模型。",
    },
    {
        "label": "DWPose 姿态模型",
        "folder": "controlnet/DWPose",
        "filename": DEFAULT_DWPOSE_POSE,
        "required": False,
        "description": "可选 2D 手脸补充；启用 DWPose 补充时调用 GJJ_DWPoseEstimator 本地运行时。",
    },
    {
        "label": "DWPose 人体框检测器",
        "folder": "controlnet/DWPose",
        "filename": DEFAULT_DWPOSE_DET,
        "required": False,
        "description": "DWPose 配套人体框检测器；GJJ_DWPoseEstimator 默认使用。",
    },
]

REQUIRED_MODELS = [
    make_missing_model_spec(
        label="NLF 3D姿态模型",
        subdir="models/nlf",
        filename=DEFAULT_NLF,
        description="必需；用于从输入图像/视频帧预测 3D 人体姿态。",
    ),
    make_missing_model_spec(
        label="ViTPose WholeBody ONNX",
        subdir="models/detection",
        filename=DEFAULT_VITPOSE,
        description="可选；连接参考图时用于生成 ref_dw_pose。",
    ),
    make_missing_model_spec(
        label="YOLO ONNX 人体检测器",
        subdir="models/detection",
        filename=DEFAULT_YOLO,
        description="可选；ViTPose 配套人体检测器。",
    ),
    make_missing_model_spec(
        label="DWPose 姿态模型",
        subdir="models/controlnet/DWPose",
        filename=DEFAULT_DWPOSE_POSE,
        description="可选；启用 DWPose 补充时用于手部/面部关键点。",
    ),
    make_missing_model_spec(
        label="DWPose 人体框检测器",
        subdir="models/controlnet/DWPose",
        filename=DEFAULT_DWPOSE_DET,
        description="可选；GJJ_DWPoseEstimator 配套人体检测器。",
    ),
]


def _module_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def _missing_dependency_specs() -> list[dict[str, str]]:
    return [spec for spec in DEPENDENCY_SPECS if not _module_available(spec["module_name"])]


def _missing_model_specs() -> list[dict[str, str]]:
    missing: list[dict[str, str]] = []
    checks = [
        ("NLF 3D姿态模型", "nlf", "nlf", (DEFAULT_NLF, "nlf_l_multi_0.3.2"), NLF_EXTENSIONS),
    ]
    for label, folder_type, rel_dir, candidates, exts in checks:
        try:
            gjjutils_resolve_model_file(
                AUTO,
                folder_type,
                relative_dir=rel_dir,
                candidates=candidates,
                extensions=exts,
                label=label,
            )
        except Exception:
            subdir = "models/checkpoints" if folder_type == "checkpoints" else f"models/{rel_dir}"
            missing.append(make_missing_model_spec(label=label, subdir=subdir, filename=str(candidates[0])))
    return missing


_ENV_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_missing_dependency_specs(),
    missing_models=_missing_model_specs(),
    install_packages=[spec["package_name"] for spec in DEPENDENCY_SPECS],
    description="GJJ 内置 NLF Pose 一体节点不依赖 ComfyUI-SCAIL-Pose、ComfyUI-WanAnimatePreprocess 或外部 WanVideoWrapper 节点注册。",
    model_download_url="https://huggingface.co/models?search=nlf_l_multi_0.3.2.torchscript%20vitpose-l-wholebody.onnx%20yolov10m.onnx%20dw-ll_ucoco_384_bs5.torchscript.pt%20yolox_l.onnx",
)

BASE_DESCRIPTION = (
    "把 LoadNLFModel、NLFPredict、GJJ_DWPoseEstimator、ConvertOpenPoseKeypointsToDWPose、"
    "OnnxDetectionModelLoader、PoseDetectionVitPoseToDWPose、RenderNLFPoses 合并为一个 GJJ 内置单节点。"
)
DESCRIPTION = BASE_DESCRIPTION

GJJ_HELP_PAYLOAD = build_node_help_payload(
    description=DESCRIPTION,
    dependencies=[
        {
            "name": "torch / numpy",
            "type": "ComfyUI基础运行环境",
            "required": True,
            "description": "加载 NLF TorchScript、运行张量推理和渲染。",
        },
        {
            "name": "onnxruntime-gpu / onnxruntime",
            "type": "运行依赖",
            "required": True,
            "description": "运行 ViTPose 与 YOLO ONNX；不接参考图时可关闭参考 DWPose。",
        },
        {
            "name": "opencv-python",
            "type": "运行依赖",
            "required": True,
            "description": "ONNX 检测后处理和 DWPose 绘制。",
        },
        {
            "name": "taichi",
            "type": "可选渲染后端",
            "required": False,
            "description": "选择 taichi 后端时使用；缺失会自动回退 torch 后端。",
        },
    ],
    model_tree=MODEL_TREE,
    models=REQUIRED_MODELS,
    usage=[
        "只接图像即可输出 NLF 姿态图和遮罩。",
        "启用 DWPose 补充时会用 GJJ_DWPoseEstimator 生成 dw_poses，补充手部/脸部 2D 细节。",
        "连接参考图时会用 ViTPose + YOLO 生成 ref_dw_pose，用于对齐 NLF 渲染相机。",
    ],
    runtime=[
        "所有模型名都可以保持 Auto；节点会通过 common_utils.model_manager 在 models/ 下递归智能查找。",
        "默认使用 torch 渲染后端，避免强依赖 taichi。",
    ],
    model_download_url=_ENV_REPORT.get("model_download_url", ""),
    install_cmd=_ENV_REPORT.get("install_cmd", ""),
    copy_text=_ENV_REPORT.get("copy_text", ""),
    copy_label=_ENV_REPORT.get("copy_label", ""),
    notice="",
    extra={
        "warning_message": "",
        "model_tree_priority": "static",
    },
)


GJJ_UI_CONFIG = {
    "version": 1,
    "hidden_widgets": [
        {"name": "enable_sdpose", "aliases": ["enable_sdpose", "启用SDPose"]},
        {"name": "enable_reference_dwpose", "aliases": ["enable_reference_dwpose", "启用参考DWPose"]},
        {"name": "warmup_nlf", "aliases": ["warmup_nlf", "预热NLF"]},
        {"name": "draw_face", "aliases": ["draw_face", "绘制脸部"]},
        {"name": "draw_hands", "aliases": ["draw_hands", "绘制手部"]},
        {"name": "scale_hands", "aliases": ["scale_hands", "手部缩放"]},
    ],
    "bool_button_rows": [
        {
            "id": "pose_flags",
            "widget_name": "gjj_nlf_pose_bool_buttons",
            "height": 36,
            "items": [
                {"name": "enable_sdpose", "aliases": ["enable_sdpose", "启用DWPose补充", "启用SDPose"], "label": "DW", "title": "启用DWPose补充"},
                {"name": "enable_reference_dwpose", "aliases": ["enable_reference_dwpose", "启用参考DWPose"], "label": "参考", "title": "启用参考DWPose"},
                {"name": "warmup_nlf", "aliases": ["warmup_nlf", "预热NLF"], "label": "预热", "title": "预热NLF"},
                {"name": "draw_face", "aliases": ["draw_face", "绘制脸部"], "label": "脸", "title": "绘制脸部"},
                {"name": "draw_hands", "aliases": ["draw_hands", "绘制手部"], "label": "手", "title": "绘制手部"},
                {"name": "scale_hands", "aliases": ["scale_hands", "手部缩放"], "label": "缩手", "title": "手部缩放"},
            ],
        }
    ],
    "model_defaults": [
        {"name": "nlf_model", "aliases": ["nlf_model", "NLF模型"], "preferred": ["nlf_l_multi_0.3.2", "nlf_l_multi", "nlf"], "auto_values": [AUTO]},
        {"name": "sdpose_checkpoint", "aliases": ["sdpose_checkpoint", "DWPose模型", "SDPose模型"], "preferred": ["dw-ll_ucoco_384_bs5", "dw-", "ucoco"], "auto_values": [AUTO]},
        {"name": "vitpose_model", "aliases": ["vitpose_model", "ViTPose模型"], "preferred": ["vitpose-l-wholebody", "vitpose", "wholebody"], "auto_values": [AUTO]},
        {"name": "yolo_model", "aliases": ["yolo_model", "YOLO模型"], "preferred": ["yolov10m", "yolo"], "auto_values": [AUTO]},
    ],
}


def _gjj_ui_meta(name: str) -> dict[str, Any]:
    for row in GJJ_UI_CONFIG["bool_button_rows"]:
        for item in row.get("items", []):
            if item.get("name") == name:
                meta = copy.deepcopy(item)
                meta.update({
                    "control": "bool_button",
                    "hidden": True,
                    "button_row": row.get("id", ""),
                    "widget_name": row.get("widget_name", ""),
                    "height": row.get("height", 36),
                })
                return meta
    for item in GJJ_UI_CONFIG["model_defaults"]:
        if item.get("name") == name:
            meta = copy.deepcopy(item)
            meta.update({"control": "model_default", "auto_model_default": True})
            return meta
    for item in GJJ_UI_CONFIG["hidden_widgets"]:
        if item.get("name") == name:
            meta = copy.deepcopy(item)
            meta.update({"hidden": True})
            return meta
    return {}


def _raise_report(report: dict[str, Any], title: str, unique_id=None) -> None:
    print_dependency_model_report(report, title=title)
    send_dependency_model_notice(report, unique_id=unique_id)
    raise RuntimeError(report.get("warning_message") or report.get("panel_message") or "GJJ NLF Pose 节点运行失败。")


def _model_choices(
    folder_type: str,
    rel_dir: str,
    extensions: tuple[str, ...],
    preferred: tuple[str, ...] = (),
    *,
    fallback_to_all: bool = True,
) -> list[str]:
    try:
        files = gjjutils_list_model_files(folder_type, relative_dir=rel_dir, extensions=extensions)
    except Exception:
        files = []
    if preferred:
        lowered = tuple(token.lower() for token in preferred)
        filtered = [name for name in files if any(token in name.lower() for token in lowered)]
        files = filtered or (files if fallback_to_all else [])
    values = []
    for name in files:
        if name not in values:
            values.append(name)
    values.append(AUTO)
    return values


def _default_model_choice(
    choices: list[str],
    folder_type: str,
    rel_dir: str,
    candidates: tuple[str, ...],
    extensions: tuple[str, ...],
    label: str,
) -> str:
    try:
        _path, rel_name = gjjutils_resolve_model_file(
            AUTO,
            folder_type,
            relative_dir=rel_dir,
            candidates=candidates,
            extensions=extensions,
            label=label,
        )
        if rel_name and rel_name in choices:
            return rel_name
    except Exception:
        pass
    return choices[0] if choices else AUTO


def _dwpose_pose_choices() -> list[str]:
    try:
        from .gjj_dwpose_aux import _combo_with_default, _list_dwpose_model_names
        return _combo_with_default(_list_dwpose_model_names("pose"), DEFAULT_DWPOSE_POSE)
    except Exception:
        return [DEFAULT_DWPOSE_POSE]


def _resolve_model_or_report(
    selection: Any,
    folder_type: str,
    *,
    relative_dir: str,
    candidates: tuple[str, ...],
    extensions: tuple[str, ...],
    label: str,
    unique_id=None,
) -> tuple[str, str]:
    try:
        return gjjutils_resolve_model_file(
            selection,
            folder_type,
            relative_dir=relative_dir,
            candidates=candidates,
            extensions=extensions,
            label=label,
        )
    except Exception as exc:
        subdir = "models/checkpoints" if folder_type == "checkpoints" else f"models/{relative_dir}"
        report = build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[
                make_missing_model_spec(
                    label=label,
                    subdir=subdir,
                    filename=str(selection or candidates[0] or AUTO),
                    description=str(exc),
                )
            ],
            description="公共模型查找函数已递归扫描对应 models/ 目录，但没有找到可用模型。",
            model_download_url=_ENV_REPORT.get("model_download_url", ""),
        )
        _raise_report(report, "GJJ NLF Pose 模型缺失！", unique_id=unique_id)
    return "", ""


def _check_jit_script_function() -> None:
    try:
        if torch.jit.script.__name__ != "script":
            logging.warning(
                "torch.jit.script 已被其它扩展替换，可能影响 NLF TorchScript 模型。当前函数：%s.%s",
                getattr(torch.jit.script, "__module__", "unknown"),
                getattr(torch.jit.script, "__qualname__", torch.jit.script.__name__),
            )
    except Exception:
        pass


def _jit_detect_smpl(model, batch_images: torch.Tensor, device: torch.device) -> dict[str, Any]:
    jit_prev_state = torch._C._jit_set_profiling_executor(True)
    try:
        return model.detect_smpl_batched(batch_images.permute(0, 3, 1, 2).to(device))
    finally:
        torch._C._jit_set_profiling_executor(jit_prev_state)


def _warmup_nlf_model(model, device: torch.device) -> None:
    dummy_input = torch.zeros(1, 3, 256, 256, device=device)
    jit_prev_state = torch._C._jit_set_profiling_executor(True)
    try:
        for _ in range(2):
            _ = model.detect_smpl_batched(dummy_input)
    finally:
        torch._C._jit_set_profiling_executor(jit_prev_state)


def _load_pose_runtime(unique_id=None) -> dict[str, Any]:
    missing_deps = _missing_dependency_specs()
    if missing_deps:
        report = build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=missing_deps,
            install_packages=[spec["package_name"] for spec in DEPENDENCY_SPECS],
            description="GJJ NLF Pose 一体节点需要 ONNX Runtime 与 OpenCV 才能运行本地 ViTPose / YOLO 模型。",
        )
        _raise_report(report, "GJJ NLF Pose 运行依赖缺失！", unique_id=unique_id)
    try:
        cv2 = importlib.import_module("cv2")
        onnx_models = importlib.import_module(".vendor.gjj_wananimate.models.onnx_models", package=__package__)
        pose2d_utils = importlib.import_module(".vendor.gjj_wananimate.pose_utils.pose2d_utils", package=__package__)
    except Exception as exc:
        report = build_dependency_model_report(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=DEPENDENCY_SPECS,
            install_packages=[spec["package_name"] for spec in DEPENDENCY_SPECS],
            description="GJJ 内置 WanAnimate/ViTPose runtime 导入失败。",
            original_error=str(exc),
        )
        _raise_report(report, "GJJ NLF Pose 运行依赖缺失！", unique_id=unique_id)
    return {
        "cv2": cv2,
        "ViTPose": onnx_models.ViTPose,
        "Yolo": onnx_models.Yolo,
        "bbox_from_detector": pose2d_utils.bbox_from_detector,
        "crop": pose2d_utils.crop,
        "load_pose_metas_from_kp2ds_seq": pose2d_utils.load_pose_metas_from_kp2ds_seq,
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


def _aaposemeta_to_dwpose_scail(meta: dict[str, Any]) -> dict[str, Any]:
    candidate_body = np.asarray(meta["keypoints_body"][:-2][:, :2], dtype=np.float32)
    score_body = np.asarray(meta["keypoints_body"][:-2][:, 2], dtype=np.float32)
    subset_body = np.arange(len(candidate_body), dtype=np.float32)
    subset_body[score_body <= 0.3] = -1.0
    hands_coords = np.stack(
        [
            np.asarray(meta["keypoints_right_hand"][:, :2], dtype=np.float32),
            np.asarray(meta["keypoints_left_hand"][:, :2], dtype=np.float32),
        ],
        axis=0,
    )
    hands_score = np.stack(
        [
            np.asarray(meta["keypoints_right_hand"][:, 2], dtype=np.float32),
            np.asarray(meta["keypoints_left_hand"][:, 2], dtype=np.float32),
        ],
        axis=0,
    )
    face = np.asarray(meta["keypoints_face"], dtype=np.float32)
    if face.shape[0] > 68:
        face = face[1:]
    return {
        "bodies": {
            "candidate": np.expand_dims(candidate_body, axis=0),
            "subset": np.expand_dims(subset_body, axis=0),
        },
        "hands": hands_coords,
        "faces": np.expand_dims(face[:, :2], axis=0),
        "body_score": np.expand_dims(score_body, axis=0),
        "hand_score": hands_score,
        "face_score": np.expand_dims(face[:, 2], axis=0),
    }


def _convert_openpose_to_dwpose(frames: Any, max_people: int = 2) -> dict[str, Any]:
    num_body = 18
    num_face = 70
    num_hand = 21
    results = []
    for frame in frames or []:
        if not isinstance(frame, dict):
            continue
        canvas_width = max(1.0, float(frame.get("canvas_width") or 1.0))
        canvas_height = max(1.0, float(frame.get("canvas_height") or 1.0))
        people = list(frame.get("people") or [])[: max(1, int(max_people))]
        bodies, hands, faces = [], [], []
        body_scores, hand_scores, face_scores = [], [], []
        for person in people:
            pose_raw = person.get("pose_keypoints_2d") or []
            if len(pose_raw) != num_body * 3:
                continue
            pose = np.asarray(pose_raw, dtype=np.float32).reshape(-1, 3)
            bodies.append(np.stack([pose[:, 0] / canvas_width, pose[:, 1] / canvas_height], axis=1))
            body_scores.append(pose[:, 2])

            face_raw = person.get("face_keypoints_2d") or []
            if len(face_raw) == num_face * 3:
                face = np.asarray(face_raw, dtype=np.float32).reshape(-1, 3)
                faces.append(np.stack([face[:, 0] / canvas_width, face[:, 1] / canvas_height], axis=1))
                face_scores.append(face[:, 2])

            for key in ("hand_left_keypoints_2d", "hand_right_keypoints_2d"):
                hand_raw = person.get(key) or []
                if len(hand_raw) != num_hand * 3:
                    continue
                hand = np.asarray(hand_raw, dtype=np.float32).reshape(-1, 3)
                hands.append(np.stack([hand[:, 0] / canvas_width, hand[:, 1] / canvas_height], axis=1))
                hand_scores.append(hand[:, 2])

        results.append(
            {
                "bodies": {
                    "candidate": np.asarray(bodies, dtype=np.float32),
                    "subset": np.asarray([np.arange(num_body) for _ in bodies], dtype=np.float32) if bodies else np.asarray([], dtype=np.float32),
                },
                "hands": np.asarray(hands, dtype=np.float32),
                "faces": np.asarray(faces, dtype=np.float32),
                "body_score": np.asarray(body_scores, dtype=np.float32),
                "hand_score": np.asarray(hand_scores, dtype=np.float32),
                "face_score": np.asarray(face_scores, dtype=np.float32),
            }
        )
    return {"poses": results, "swap_hands": False}


def _scale_faces(poses: list[dict[str, Any]], pose_2d_ref: list[dict[str, Any]]) -> float:
    try:
        face_0 = np.asarray(poses[0]["faces"][0], dtype=np.float32)
        face_ref = np.asarray(pose_2d_ref[0]["faces"][0], dtype=np.float32)
        center_idx = min(30, face_0.shape[0] - 1, face_ref.shape[0] - 1)
        center_0 = face_0[center_idx]
        center_ref = face_ref[center_idx]
        dist = np.delete(np.linalg.norm(face_0 - center_0, axis=1), center_idx)
        dist_ref = np.delete(np.linalg.norm(face_ref - center_ref, axis=1), center_idx)
        scale_n = 1.0 if np.mean(dist) < 1e-6 else float(np.mean(dist_ref) / np.mean(dist))
        scale_n = float(np.clip(scale_n, 0.8, 1.5))
        for pose in poses:
            face = np.asarray(pose["faces"][0], dtype=np.float32)
            center = face[min(center_idx, face.shape[0] - 1)]
            pose["faces"][0] = (face - center) * scale_n + center
            candidate = np.asarray(pose["bodies"]["candidate"][0], dtype=np.float32)
            body_center = candidate[0]
            pose["bodies"]["candidate"][0] = (candidate - body_center) * scale_n + body_center
        return scale_n
    except Exception as exc:
        logging.warning("GJJ NLF Pose 参考脸部缩放失败，继续使用原比例：%s", exc)
        return 1.0


class GJJ_NLFPoseAIO:
    DESCRIPTION = DESCRIPTION
    CATEGORY = CATEGORY
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("姿态图", "遮罩")
    OUTPUT_TOOLTIPS = (
        "RenderNLFPoses 等价输出的姿态图。",
        "姿态图 alpha 区域生成的遮罩。",
    )
    FUNCTION = "process"
    SEARCH_ALIASES = [
        "NLF",
        "RenderNLFPoses",
        "LoadNLFModel",
        "NLFPredict",
        "GJJ_DWPoseEstimator",
        "ConvertOpenPoseKeypointsToDWPose",
        "PoseDetectionVitPoseToDWPose",
        "OnnxDetectionModelLoader",
        "SCAIL Pose",
        "NLF姿态",
    ]
    REQUIRED_MODELS = REQUIRED_MODELS
    GJJ_HELP = GJJ_HELP_PAYLOAD
    GJJ_UI = GJJ_UI_CONFIG

    def __init__(self) -> None:
        self._nlf_key: str | None = None
        self._nlf_model: Any = None
        self._onnx_key: tuple[str, str, str] | None = None
        self._onnx_model: dict[str, Any] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        nlf_models = _model_choices("nlf", "nlf", NLF_EXTENSIONS, ("nlf",), fallback_to_all=False)
        vitpose_models = _model_choices("detection", "detection", DETECTION_EXTENSIONS, ("vitpose", "wholebody"), fallback_to_all=False)
        yolo_models = _model_choices("detection", "detection", DETECTION_EXTENSIONS, ("yolov10", "yolo"), fallback_to_all=False)
        sdpose_models = _dwpose_pose_choices()
        nlf_default = _default_model_choice(
            nlf_models,
            "nlf",
            "nlf",
            (DEFAULT_NLF, "nlf_l_multi_0.3.2", "nlf_l_multi"),
            NLF_EXTENSIONS,
            "NLF 3D姿态模型",
        )
        sdpose_default = _default_model_choice(
            sdpose_models,
            "controlnet",
            "controlnet/DWPose",
            (DEFAULT_DWPOSE_POSE, "dw-ll_ucoco_384_bs5", "dw-", "ucoco"),
            DWPOSE_EXTENSIONS,
            "DWPose 姿态模型",
        )
        vitpose_default = _default_model_choice(
            vitpose_models,
            "detection",
            "detection",
            (DEFAULT_VITPOSE, "vitpose wholebody", "vitpose"),
            DETECTION_EXTENSIONS,
            "ViTPose WholeBody ONNX",
        )
        yolo_default = _default_model_choice(
            yolo_models,
            "detection",
            "detection",
            (DEFAULT_YOLO, "yolov10m", "yolo"),
            DETECTION_EXTENSIONS,
            "YOLO ONNX 人体检测器",
        )
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "图像/视频帧", "tooltip": "输入图像批次；视频请先拆成 IMAGE 帧。"}),
                "width": ("INT", {"default": 720, "min": 64, "max": 8192, "step": 8, "display_name": "输出宽度", "tooltip": "最终 NLF 姿态图宽度。"}),
                "height": ("INT", {"default": 1280, "min": 64, "max": 8192, "step": 8, "display_name": "输出高度", "tooltip": "最终 NLF 姿态图高度。"}),
                "nlf_model": (nlf_models, {"default": nlf_default, "display_name": "NLF模型", "tooltip": "默认显示已找到的模型；也可改回 Auto 让节点运行时重新智能查找。", "gjj_ui": _gjj_ui_meta("nlf_model")}),
                "sdpose_checkpoint": (sdpose_models, {"default": sdpose_default, "display_name": "DWPose模型", "tooltip": "使用 GJJ_DWPoseEstimator 同款本地姿态模型，默认从 models/controlnet/DWPose 查找。", "gjj_ui": _gjj_ui_meta("sdpose_checkpoint")}),
                "vitpose_model": (vitpose_models, {"default": vitpose_default, "display_name": "ViTPose模型", "tooltip": "默认显示已找到的模型；也可改回 Auto 让节点运行时重新智能查找。", "gjj_ui": _gjj_ui_meta("vitpose_model")}),
                "yolo_model": (yolo_models, {"default": yolo_default, "display_name": "YOLO模型", "tooltip": "默认显示已找到的模型；也可改回 Auto 让节点运行时重新智能查找。", "gjj_ui": _gjj_ui_meta("yolo_model")}),
                "onnx_device": (["CUDAExecutionProvider", "CPUExecutionProvider"], {"default": "CUDAExecutionProvider", "display_name": "ONNX设备", "tooltip": "CUDA 需要 onnxruntime-gpu；CPU 最稳。"}),
            },
            "optional": {
                "reference_image": ("IMAGE", {"default": None, "display_name": "参考图", "tooltip": "可选。连接后用 ViTPose 生成 ref_dw_pose 并对齐 NLF 渲染相机。"}),
                "enable_sdpose": ("BOOLEAN", {"default": True, "display_name": "启用DWPose补充", "tooltip": "开启后调用 GJJ_DWPoseEstimator，再转换为 NLF 渲染使用的 DWPose 手脸补充。", "gjj_ui": _gjj_ui_meta("enable_sdpose")}),
                "enable_reference_dwpose": ("BOOLEAN", {"default": True, "display_name": "启用参考DWPose", "tooltip": "连接参考图时是否运行 ViTPose/YOLO 生成 ref_dw_pose。", "gjj_ui": _gjj_ui_meta("enable_reference_dwpose")}),
                "warmup_nlf": ("BOOLEAN", {"default": False, "display_name": "预热NLF", "tooltip": "首次加载后用 256x256 空输入预热两次；更慢但可减少第一次正式推理抖动。", "gjj_ui": _gjj_ui_meta("warmup_nlf")}),
                "nlf_per_batch": ("INT", {"default": 30, "min": -1, "max": 10000, "step": 1, "display_name": "NLF批大小", "tooltip": "-1 表示一次处理全部帧。"}),
                "sdpose_batch_size": ("INT", {"default": 30, "min": 1, "max": 10000, "step": 1, "display_name": "DWPose批大小", "tooltip": "保留兼容参数；GJJ_DWPoseEstimator 内部按输入 batch 逐帧处理。"}),
                "max_people": ("INT", {"default": 1, "min": 1, "max": 100, "step": 1, "display_name": "最多人数", "tooltip": "OpenPose 关键点转 DWPose 时每帧最多保留的人数。"}),
                "draw_face": ("BOOLEAN", {"default": True, "display_name": "绘制脸部", "tooltip": "是否叠加 DWPose 脸部关键点。", "gjj_ui": _gjj_ui_meta("draw_face")}),
                "draw_hands": ("BOOLEAN", {"default": True, "display_name": "绘制手部", "tooltip": "是否叠加 DWPose 手部关键点。", "gjj_ui": _gjj_ui_meta("draw_hands")}),
                "scale_hands": ("BOOLEAN", {"default": True, "display_name": "手部缩放", "tooltip": "参考对齐时是否按 NLF 相机比例缩放手部关键点。", "gjj_ui": _gjj_ui_meta("scale_hands")}),
                "render_backend": (["torch", "taichi"], {"default": "torch", "display_name": "渲染后端", "tooltip": "默认 torch 零额外依赖；taichi 可选，缺失时自动回退 torch。"}),
                "render_device": (["gpu", "cpu", "cuda", "opengl", "vulkan", "metal"], {"default": "gpu", "display_name": "Taichi设备", "tooltip": "仅 taichi 后端使用。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def _load_nlf_model(self, nlf_path: str, warmup: bool) -> Any:
        if self._nlf_key == nlf_path and self._nlf_model is not None:
            return self._nlf_model
        _check_jit_script_function()
        model = torch.jit.load(nlf_path).eval()
        device = model_management.get_torch_device()
        if warmup:
            model = model.to(device)
            _warmup_nlf_model(model, device)
        model = model.to(model_management.unet_offload_device())
        self._nlf_key = nlf_path
        self._nlf_model = model
        return model

    def _predict_nlf(self, model: Any, images: torch.Tensor, per_batch: int) -> tuple[dict[str, Any], list[list[float]]]:
        _check_jit_script_function()
        device = model_management.get_torch_device()
        offload_device = model_management.unet_offload_device()
        model = model.to(device)
        num_images = int(images.shape[0])
        batch_size = num_images if int(per_batch) <= 0 else max(1, int(per_batch))
        all_boxes = []
        all_joints3d_nonparam = []
        pbar = comfy.utils.ProgressBar(num_images)
        for start in range(0, num_images, batch_size):
            end = min(start + batch_size, num_images)
            pred = _jit_detect_smpl(model, images[start:end], device)
            if "boxes" in pred:
                all_boxes.extend(pred["boxes"])
            if "joints3d_nonparam" in pred:
                all_joints3d_nonparam.extend(pred["joints3d_nonparam"])
            pbar.update(end - start)
        model = model.to(offload_device)
        pose_results = {
            "joints3d_nonparam": [[pose.to(offload_device) for pose in all_joints3d_nonparam]],
        }
        formatted_boxes = []
        for box in all_boxes:
            if box.numel() == 0 or box.shape[0] == 0:
                formatted_boxes.append([0.0, 0.0, 0.0, 0.0])
            else:
                formatted_boxes.append([float(v) for v in box[0, :4].detach().cpu().tolist()])
        return pose_results, formatted_boxes

    def _get_onnx_model(self, runtime: dict[str, Any], vitpose_path: str, yolo_path: str, onnx_device: str, unique_id=None) -> dict[str, Any]:
        key = (str(vitpose_path), str(yolo_path), str(onnx_device))
        if self._onnx_key == key and self._onnx_model is not None:
            return self._onnx_model
        self._cleanup_onnx_model()
        try:
            model = {
                "vitpose": runtime["ViTPose"](vitpose_path, onnx_device),
                "yolo": runtime["Yolo"](yolo_path, onnx_device),
            }
        except Exception as exc:
            report = build_dependency_model_report(
                node_name=NODE_DISPLAY_NAME,
                missing_models=[
                    make_missing_model_spec("ViTPose模型", "models/detection", os.path.basename(vitpose_path), "ONNX Runtime 无法加载当前 ViTPose 模型。"),
                    make_missing_model_spec("YOLO模型", "models/detection", os.path.basename(yolo_path), "ONNX Runtime 无法加载当前 YOLO 模型。"),
                ],
                description="模型文件存在，但 ONNX Runtime 初始化失败；请检查模型类型、ONNX Runtime 版本和所选设备。",
                original_error=str(exc),
                model_download_url=_ENV_REPORT.get("model_download_url", ""),
            )
            _raise_report(report, "GJJ NLF Pose ONNX 模型加载失败！", unique_id=unique_id)
        self._onnx_key = key
        self._onnx_model = model
        return model

    def _cleanup_onnx_model(self) -> None:
        if not self._onnx_model:
            return
        for item in self._onnx_model.values():
            cleanup = getattr(item, "cleanup", None)
            if callable(cleanup):
                try:
                    cleanup()
                except Exception:
                    pass
        self._onnx_key = None
        self._onnx_model = None

    def _detect_vitpose_dwpose(self, runtime: dict[str, Any], model: dict[str, Any], images: torch.Tensor) -> dict[str, Any]:
        cv2 = runtime["cv2"]
        detector = model["yolo"]
        pose_model = model["vitpose"]
        batch, height, width, _channels = images.shape
        shape = np.array([height, width])[None]
        images_np = images.detach().cpu().numpy().astype(np.float32)
        img_norm_mean = np.array([0.485, 0.456, 0.406])
        img_norm_std = np.array([0.229, 0.224, 0.225])
        input_resolution = (256, 192)
        rescale = 1.25
        detector.reinit()
        pose_model.reinit()
        pbar = comfy.utils.ProgressBar(max(1, int(batch) * 2))
        bboxes = []
        for img in images_np:
            bbox = detector(cv2.resize(img, (640, 640)).transpose(2, 0, 1)[None], shape)[0][0]["bbox"]
            bboxes.append(bbox)
            pbar.update(1)
        detector.cleanup()

        kp2ds = []
        for img, bbox in zip(images_np, bboxes):
            if not _bbox_valid(bbox):
                bbox = _full_bbox(img.shape[1], img.shape[0])
            center, scale = runtime["bbox_from_detector"](bbox, input_resolution, rescale=rescale)
            cropped_img = runtime["crop"](img, center, scale, (input_resolution[0], input_resolution[1]))[0]
            img_norm = (cropped_img - img_norm_mean) / img_norm_std
            img_norm = img_norm.transpose(2, 0, 1).astype(np.float32)
            keypoints = pose_model(img_norm[None], np.array(center)[None], np.array(scale)[None])
            kp2ds.append(keypoints)
            pbar.update(1)
        pose_model.cleanup()
        pose_metas = runtime["load_pose_metas_from_kp2ds_seq"](np.concatenate(kp2ds, 0), width=width, height=height)
        return {"poses": [_aaposemeta_to_dwpose_scail(meta) for meta in pose_metas], "swap_hands": True}

    def _run_sdpose(self, pose_estimator: str, image: torch.Tensor, batch_size: int, max_people: int, unique_id=None) -> tuple[Any, dict[str, Any]]:
        try:
            from .gjj_dwpose_aux import DEFAULT_DWPOSE_DET as AUX_DEFAULT_DWPOSE_DET
            from .gjj_dwpose_aux import DEFAULT_DWPOSE_POSE as AUX_DEFAULT_DWPOSE_POSE
            from .gjj_dwpose_aux import GJJ_DWPoseEstimator

            selected_pose = str(pose_estimator or "").strip()
            selected_lower = selected_pose.lower()
            if not selected_pose or selected_lower == AUTO.lower() or "sdpose" in selected_lower or "wholebody" in selected_lower:
                selected_pose = AUX_DEFAULT_DWPOSE_POSE
            raw = GJJ_DWPoseEstimator().estimate_pose(
                image,
                detect_hand=True,
                detect_body=True,
                detect_face=True,
                resolution=512,
                bbox_detector=AUX_DEFAULT_DWPOSE_DET,
                pose_estimator=selected_pose,
                scale_stick_for_xinsr_cn=False,
                unique_id=unique_id,
            )
            result = raw.get("result") if isinstance(raw, dict) and "result" in raw else raw
            keypoints = result[1] if isinstance(result, (tuple, list)) and len(result) > 1 else result
        except Exception as exc:
            report = build_dependency_model_report(
                node_name=NODE_DISPLAY_NAME,
                missing_models=[
                    make_missing_model_spec("DWPose 姿态模型", "models/controlnet/DWPose", str(pose_estimator or DEFAULT_DWPOSE_POSE), "GJJ_DWPoseEstimator 加载或推理失败。")
                ],
                description="GJJ_DWPoseEstimator 调用失败；可关闭“启用DWPose补充”仅输出 NLF 骨架。",
                original_error=str(exc),
            )
            _raise_report(report, "GJJ NLF Pose DWPose 运行失败！", unique_id=unique_id)
        return keypoints, _convert_openpose_to_dwpose(keypoints, max_people=max_people)

    def _render_nlf_pose(
        self,
        nlf_poses: dict[str, Any],
        width: int,
        height: int,
        dw_poses: dict[str, Any] | None,
        ref_dw_pose: dict[str, Any] | None,
        draw_face: bool,
        draw_hands: bool,
        render_device: str,
        scale_hands: bool,
        render_backend: str,
        unique_id=None,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        try:
            render_mod = importlib.import_module(".vendor.gjj_scail_pose.NLFPoseExtract.nlf_render", package=__package__)
        except Exception as exc:
            report = build_dependency_model_report(
                node_name=NODE_DISPLAY_NAME,
                missing_dependencies=DEPENDENCY_SPECS,
                install_packages=[spec["package_name"] for spec in DEPENDENCY_SPECS],
                description="GJJ 内置 SCAIL NLF 渲染 runtime 导入失败。",
                original_error=str(exc),
            )
            _raise_report(report, "GJJ NLF Pose 渲染依赖缺失！", unique_id=unique_id)

        backend = str(render_backend or "torch").lower()
        if backend == "taichi":
            try:
                ti = importlib.import_module("taichi")
                device_map = {
                    "cpu": ti.cpu,
                    "gpu": ti.gpu,
                    "opengl": ti.opengl,
                    "cuda": ti.cuda,
                    "vulkan": ti.vulkan,
                    "metal": ti.metal,
                }
                ti.init(arch=device_map.get(str(render_device or "gpu").lower()))
            except Exception:
                logging.warning("Taichi 后端不可用，GJJ NLF Pose 自动回退 torch 渲染。")
                backend = "torch"

        pose_input = nlf_poses["joints3d_nonparam"][0] if isinstance(nlf_poses, dict) and "joints3d_nonparam" in nlf_poses else nlf_poses
        dw_pose_input = copy.deepcopy(dw_poses["poses"]) if dw_poses and dw_poses.get("poses") else None
        swap_hands = bool(dw_poses.get("swap_hands", False)) if dw_poses else False

        intrinsic_matrix = render_mod.intrinsic_matrix_from_field_of_view([height, width])
        ori_camera_pose = intrinsic_matrix
        ori_focal = ori_camera_pose[0, 0]
        num_people = 0
        if dw_pose_input and dw_pose_input[0].get("bodies"):
            num_people = int(np.asarray(dw_pose_input[0]["bodies"].get("candidate", [])).shape[0])

        if dw_pose_input is not None and ref_dw_pose and ref_dw_pose.get("poses") and num_people == 1:
            try:
                align_mod = importlib.import_module(".vendor.gjj_scail_pose.NLFPoseExtract.align3d", package=__package__)
            except Exception as exc:
                report = build_dependency_model_report(
                    node_name=NODE_DISPLAY_NAME,
                    description="GJJ 内置 NLF 参考 DWPose 对齐 runtime 导入失败；可断开参考图或关闭“启用参考DWPose”跳过对齐。",
                    original_error=str(exc),
                )
                _raise_report(report, "GJJ NLF Pose 参考对齐失败！", unique_id=unique_id)

            ref_dw_pose_input = copy.deepcopy(ref_dw_pose["poses"])
            pose_3d_first = None
            for pose in pose_input:
                if pose.shape[0] == 0:
                    continue
                candidate = pose[0].detach().cpu().numpy() if isinstance(pose[0], torch.Tensor) else np.asarray(pose[0])
                if np.any(candidate):
                    pose_3d_first = candidate
                    break
            if pose_3d_first is not None:
                pose_3d_coco = render_mod.process_data_to_COCO_format(pose_3d_first)
                poses_2d_ref = np.asarray(ref_dw_pose_input[0]["bodies"]["candidate"][0][:14], dtype=np.float32).copy()
                poses_2d_ref[:, 0] *= float(width)
                poses_2d_ref[:, 1] *= float(height)
                poses_2d_subset = np.asarray(ref_dw_pose_input[0]["bodies"]["subset"][0][:14], dtype=np.float32)
                pose_3d_coco = pose_3d_coco[:14]
                valid_upper_indices: list[int] = []
                valid_lower_indices: list[int] = []
                upper_body_indices = [0, 2, 3, 5, 6]
                lower_body_indices = [9, 10, 12, 13]
                for idx in range(len(poses_2d_subset)):
                    if poses_2d_subset[idx] != -1.0 and np.sum(pose_3d_coco[idx]) != 0:
                        if idx in upper_body_indices:
                            valid_upper_indices.append(idx)
                        if idx in lower_body_indices:
                            valid_lower_indices.append(idx)
                valid_indices = [1] + valid_lower_indices if len(valid_upper_indices) < 4 else [1] + valid_lower_indices + valid_upper_indices
                if len(valid_indices) >= 2:
                    pose_2d_ref = poses_2d_ref[valid_indices]
                    pose_3d_subset = pose_3d_coco[valid_indices]
                    if len(valid_lower_indices) >= 4:
                        new_camera_intrinsics, scale_m, scale_s = align_mod.solve_new_camera_params_down(
                            pose_3d_subset, ori_focal, [height, width], pose_2d_ref
                        )
                    else:
                        new_camera_intrinsics, scale_m, scale_s = align_mod.solve_new_camera_params_central(
                            pose_3d_subset, ori_focal, [height, width], pose_2d_ref
                        )
                    _scale_faces(list(dw_pose_input), list(ref_dw_pose_input))
                    render_mod.shift_dwpose_according_to_nlf(
                        pose_input,
                        dw_pose_input,
                        ori_camera_pose,
                        new_camera_intrinsics,
                        height,
                        width,
                        swap_hands=swap_hands,
                        scale_hands=scale_hands,
                        scale_x=scale_m,
                        scale_y=scale_m * scale_s,
                    )
                    intrinsic_matrix = new_camera_intrinsics

        if pose_input[0].shape[0] > 1:
            frames_np = render_mod.render_multi_nlf_as_images(
                pose_input,
                dw_pose_input,
                height,
                width,
                len(pose_input),
                intrinsic_matrix=intrinsic_matrix,
                draw_face=draw_face,
                draw_hands=draw_hands,
                render_backend=backend,
            )
        else:
            frames_np = render_mod.render_nlf_as_images(
                pose_input,
                dw_pose_input,
                height,
                width,
                len(pose_input),
                intrinsic_matrix=intrinsic_matrix,
                draw_face=draw_face,
                draw_hands=draw_hands,
                render_backend=backend,
            )
        frames_tensor = torch.from_numpy(np.stack(frames_np, axis=0)).contiguous() / 255.0
        image_tensor = frames_tensor[..., :3].cpu().float()
        mask = (frames_tensor[..., -1] > 0.5).cpu().float()
        return image_tensor, mask

    def process(
        self,
        image,
        width,
        height,
        nlf_model,
        sdpose_checkpoint,
        vitpose_model,
        yolo_model,
        onnx_device,
        reference_image=None,
        enable_sdpose=True,
        enable_reference_dwpose=True,
        warmup_nlf=False,
        nlf_per_batch=30,
        sdpose_batch_size=30,
        max_people=1,
        draw_face=True,
        draw_hands=True,
        scale_hands=True,
        render_backend="torch",
        render_device="gpu",
        unique_id=None,
    ):
        width = int(width)
        height = int(height)
        nlf_path, _nlf_rel = _resolve_model_or_report(
            nlf_model,
            "nlf",
            relative_dir="nlf",
            candidates=(DEFAULT_NLF, "nlf_l_multi_0.3.2", "nlf_l_multi"),
            extensions=NLF_EXTENSIONS,
            label="NLF 3D姿态模型",
            unique_id=unique_id,
        )
        nlf_runtime = self._load_nlf_model(nlf_path, bool(warmup_nlf))
        nlf_poses, _nlf_bboxes = self._predict_nlf(nlf_runtime, image, int(nlf_per_batch))

        sdpose_dwposes: dict[str, Any] = {"poses": [], "swap_hands": False}
        if bool(enable_sdpose):
            _sdpose_keypoints, sdpose_dwposes = self._run_sdpose(
                str(sdpose_checkpoint or DEFAULT_DWPOSE_POSE),
                image,
                int(sdpose_batch_size),
                int(max_people),
                unique_id=unique_id,
            )

        ref_dwpose: dict[str, Any] = {"poses": [], "swap_hands": True}
        if bool(enable_reference_dwpose) and reference_image is not None:
            runtime = _load_pose_runtime(unique_id=unique_id)
            vitpose_path, _vitpose_rel = _resolve_model_or_report(
                vitpose_model,
                "detection",
                relative_dir="detection",
                candidates=(DEFAULT_VITPOSE, "vitpose wholebody", "vitpose"),
                extensions=DETECTION_EXTENSIONS,
                label="ViTPose WholeBody ONNX",
                unique_id=unique_id,
            )
            yolo_path, _yolo_rel = _resolve_model_or_report(
                yolo_model,
                "detection",
                relative_dir="detection",
                candidates=(DEFAULT_YOLO, "yolov10m", "yolo"),
                extensions=DETECTION_EXTENSIONS,
                label="YOLO ONNX 人体检测器",
                unique_id=unique_id,
            )
            onnx_model = self._get_onnx_model(runtime, vitpose_path, yolo_path, str(onnx_device), unique_id=unique_id)
            ref_dwpose = self._detect_vitpose_dwpose(runtime, onnx_model, reference_image)

        pose_image, pose_mask = self._render_nlf_pose(
            nlf_poses,
            width,
            height,
            sdpose_dwposes if sdpose_dwposes.get("poses") else None,
            ref_dwpose if ref_dwpose.get("poses") else None,
            bool(draw_face),
            bool(draw_hands),
            str(render_device),
            bool(scale_hands),
            str(render_backend),
            unique_id=unique_id,
        )
        return (pose_image, pose_mask)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_NLFPoseAIO}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
