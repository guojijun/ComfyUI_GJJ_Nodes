"""
GJJ · 🎭 一键批量换脸
内联 ReActor 核心的零依赖换脸节点
将 ReActor 的关键功能直接嵌入节点，无需外部包依赖
"""

from __future__ import annotations

# ============================================================================
# 零依赖：必须在所有其他导入之前添加 vendor 路径！
# ============================================================================
import os
import sys
import base64
import hashlib
import io

# 将 vendor 目录添加到 Python 路径的最前面
vendor_path = os.path.join(os.path.dirname(__file__), '..', 'vendor')
if vendor_path not in sys.path:
    sys.path.insert(0, vendor_path)

# ============================================================================
# 强制清除 insightface 模块缓存（解决其他节点先加载的问题）
# ============================================================================
# 如果其他节点（如 comfyui-reactor-node）已经加载了系统 Python 的 insightface，
# 我们需要清除缓存并强制从 vendor 重新加载
insightface_modules = [key for key in sys.modules.keys() if key.startswith('insightface')]
if insightface_modules:
    for mod in insightface_modules:
        del sys.modules[mod]

# 现在导入其他模块（会使用 vendor 中的 insightface）
# import cv2  # 在函数内部延迟导入
import importlib.util
import numpy as np
from PIL import Image, ImageOps
from typing import Any, Dict, List, Optional, Tuple, Union

import folder_paths
import torch

try:
    from .common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
    )
    from .common_utils.progress import send_node_progress
except ImportError:
    from common_utils.dependency_checker import (
        build_dependency_model_report,
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
    )
    from common_utils.progress import send_node_progress

# ============================================================================
# 零依赖：集成 insightface 到 vendor 目录
# ============================================================================
# 将 vendor 目录添加到 Python 路径
vendor_path = os.path.join(os.path.dirname(__file__), '..', 'vendor')
if vendor_path not in sys.path:
    sys.path.insert(0, vendor_path)

NODE_NAME = "GJJ_FaceAnalysis"
NODE_DISPLAY_NAME = "GJJ · 🎭 一键批量换脸"
CATEGORY = "GJJ/图像"
MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d"
IDENTITY_SWAP_MODEL_OPTIONS = ["inswapper_128.onnx", "inswapper_128_fp16.onnx"]
RESTORE_MODEL_NONE = "无"
FACE_RESTORE_MODEL_OPTIONS = [RESTORE_MODEL_NONE, "GPEN-BFR-256.onnx", "GPEN-BFR-512.onnx"]
FACE_RESTORE_MODEL_FILENAMES = tuple(name for name in FACE_RESTORE_MODEL_OPTIONS if name != RESTORE_MODEL_NONE)
SWAP_MODEL_OPTIONS = IDENTITY_SWAP_MODEL_OPTIONS
FACE_DETECTION_OPTIONS = ["YOLOv5n", "retinaface_resnet50", "scrfd_34g_gnkps.onnx", "scrfd_10g_bnkps.onnx"]
OPTIONAL_FACE_DETECTION_MODEL_FILENAMES = ("scrfd_34g_gnkps.onnx", "scrfd_10g_bnkps.onnx")
DEPENDENCY_SPECS = [
    {"module_name": "cv2", "package_name": "opencv-python", "display_name": "OpenCV", "description": "用于图像颜色空间转换、编码和基础处理。"},
    {"module_name": "insightface", "package_name": "insightface", "display_name": "InsightFace", "description": "用于人脸检测、关键点提取和换脸模型封装。"},
    {"module_name": "onnx", "package_name": "onnx", "display_name": "ONNX", "description": "用于读取本地 InsightFace / ReActor ONNX 模型。"},
    {"module_name": "onnxruntime", "package_name": "onnxruntime-gpu", "display_name": "ONNX Runtime GPU", "description": "用于执行 buffalo_l、inswapper 与 GPEN ONNX 推理。无 CUDA 环境时可改装 onnxruntime。"},
]

# 延迟导入：运行时依赖检查
def _load_dependencies(unique_id=None):
	"""运行时加载 insightface、cv2 等依赖，失败时提供友好提示"""
	import sys
	global cv2, insightface, Face, PROVIDERS

	# 加载 cv2
	cv2_module = load_dependency_at_runtime(
		module_name="cv2",
		node_name=NODE_DISPLAY_NAME,
		package_name="opencv-python",
		description="该节点需要 OpenCV 进行图像处理",
		unique_id=unique_id,
	)

	load_dependency_at_runtime(
		module_name="onnx",
		node_name=NODE_DISPLAY_NAME,
		package_name="onnx",
		description="该节点需要 onnx 读取本地 InsightFace / ReActor 模型。",
		unique_id=unique_id,
	)
	load_dependency_at_runtime(
		module_name="onnxruntime",
		node_name=NODE_DISPLAY_NAME,
		package_name="onnxruntime-gpu",
		description="该节点需要 ONNX Runtime 执行本地人脸检测和换脸模型；无 CUDA 环境时可改装 onnxruntime。",
		unique_id=unique_id,
	)

	# 加载 insightface
	insightface_module = load_dependency_at_runtime(
		module_name="insightface",
		node_name=NODE_DISPLAY_NAME,
		package_name="insightface",
		description="该节点已内置 InsightFace 代码；运行时仍需要 onnx / onnxruntime-gpu 加载本地 ONNX 人脸模型",
		unique_id=unique_id,
	)

	# 从 insightface 导入 Face 类
	try:
		from insightface.app.common import Face
	except ImportError as exc:
		raise_dependency_model_error(
			node_name=NODE_DISPLAY_NAME,
			missing_dependencies=[DEPENDENCY_SPECS[1]],
			install_packages=["insightface", "onnx", "onnxruntime-gpu"],
			description="当前 InsightFace 包结构不完整，无法导入 insightface.app.common.Face。",
			original_error=str(exc),
			unique_id=unique_id,
			model_download_url=MODEL_DOWNLOAD_URL,
		)

	# 设置执行提供者
	try:
		import torch.cuda as cuda
		if cuda is not None and cuda.is_available():
			PROVIDERS = ["CUDAExecutionProvider"]
		else:
			PROVIDERS = ["CPUExecutionProvider"]
	except:
		PROVIDERS = ["CPUExecutionProvider"]

	cv2 = cv2_module
	insightface = insightface_module
	return cv2, insightface, Face, PROVIDERS


READY_DESCRIPTION = """内联 ReActor 核心的换脸节点：将源图的脸部特征迁移到目标图上。

【核心功能】
• 双批量输入 - 源图和目标图均支持单图或多图
• 智能配对 - 自动处理一对一、一对多、多对一场景
• 内联 ReActor - 直接使用 reactor 原版代码，无需安装额外包
• 批量输出 - 保持与输入对应的批量结构

【工作原理】
节点内置了 ReActor 的核心换脸逻辑：
1. 使用 insightface 进行人脸检测和关键点提取
2. 通过 inswapper_128 模型执行脸部特征交换
3. 可选使用 GPEN-BFR-256/512 进行换脸后人脸修复增强
4. 自动处理批量图片和尺寸适配

【输入说明】
• 目标图 - 需要被换脸的图片(可批量)
• 源图 - 提供脸部特征的图片(可批量)

【配对规则】
• 单图 + 单图 → 单张结果
• 单图 + 批量 → 源图应用到所有目标图
• 批量 + 单图 → 同一源脸应用到所有目标图
• 批量 + 批量 → 按最小数量一一配对

【技术细节】
• 支持 YOLOv5n、retinaface 与 SCRFD 检测选项
• inswapper_128 模型执行换脸
• 可选 GPEN-BFR 模型增强换脸后的面部细节
• 自动处理不同尺寸的图片
• 保持原始分辨率和色彩空间"""


def _missing_dependency_specs() -> list[dict[str, str]]:
    missing: list[dict[str, str]] = []
    for spec in DEPENDENCY_SPECS:
        if importlib.util.find_spec(spec["module_name"]) is None:
            missing.append(spec)
    return missing


def _has_buffalo_model() -> bool:
    try:
        insightface_path = os.path.join(folder_paths.models_dir, "insightface")
        if not os.path.exists(insightface_path):
            return False
        for _root, _dirs, files in os.walk(insightface_path):
            if "det_10g.onnx" in files and "w600k_r50.onnx" in files:
                return True
        return False
    except Exception:
        return False


def _has_swap_model() -> bool:
    try:
        insightface_path = os.path.join(folder_paths.models_dir, "insightface")
        return any(
            os.path.exists(os.path.join(insightface_path, name))
            for name in IDENTITY_SWAP_MODEL_OPTIONS
        )
    except Exception:
        return False


def _startup_missing_models() -> list[dict[str, str]]:
    missing: list[dict[str, str]] = []
    if not _has_buffalo_model():
        missing.append(make_missing_model_spec(
            label="buffalo_l 人脸检测模型",
            subdir="models/insightface",
            filename="buffalo_l",
            description="目录内至少需要 det_10g.onnx 和 w600k_r50.onnx。",
        ))
    if not _has_swap_model():
        missing.append(make_missing_model_spec(
            label="ReActor 换脸模型",
            subdir="models/insightface",
            filename="inswapper_128.onnx",
            description="用于执行脸部特征交换的 ONNX 模型。",
        ))
    return missing


_MISSING_DEPENDENCIES = _missing_dependency_specs()
_MISSING_MODELS = _startup_missing_models()
_ENVIRONMENT_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_MISSING_DEPENDENCIES,
    missing_models=_MISSING_MODELS,
    install_packages=[spec["package_name"] for spec in _MISSING_DEPENDENCIES],
    description="一键批量换脸需要 InsightFace / OpenCV / ONNX Runtime 运行时，以及本地 buffalo_l 与 inswapper 模型；GPEN-BFR 为可选换脸后修复模型。",
    model_download_url=MODEL_DOWNLOAD_URL,
)
_DEPENDENCIES_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("dependencies_available", True))
_MODELS_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("models_available", True))
DESCRIPTION = READY_DESCRIPTION if (_DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE) else _ENVIRONMENT_REPORT["warning_message"]


def _send_status(unique_id: Any, text: str, progress: Optional[float] = None) -> None:
    send_node_progress(unique_id, text, progress)


# ============================================================================
# 内联 ReActor 核心代码 - 从 comfyui-reactor-node 复制
# 使用 vendor 目录中的 insightface（零依赖）
# ============================================================================
# 注意：所有依赖已改为运行时加载，见 _load_dependencies() 函数


# 全局变量缓存
cv2 = None
insightface = None
Face = None
PROVIDERS = []
FS_MODEL = None
CURRENT_FS_MODEL_PATH = None
RESTORE_MODELS = {}
ANALYSIS_MODELS = {}
SOURCE_FACES = None
SOURCE_IMAGE_HASH = None
TARGET_FACES = None
TARGET_IMAGE_HASH = None


def scan_available_models():
    """扫描 models/insightface 目录下所有可用的 buffalo 模型"""
    models_path = folder_paths.models_dir
    insightface_path = os.path.join(models_path, "insightface")

    available_models = []

    if not os.path.exists(insightface_path):
        return ["无可用模型"]

    # 递归查找所有包含 buffalo 的目录
    for root, dirs, files in os.walk(insightface_path):
        # 检查是否是 buffalo 模型目录（包含 det_10g.onnx）
        if 'det_10g.onnx' in files or '1k3d68.onnx' in files:
            # 计算相对路径
            rel_path = os.path.relpath(root, models_path)
            # 提取目录名作为显示名称
            dir_name = os.path.basename(root)

            # 验证是否包含必要的模型文件
            required_files = ['det_10g.onnx', 'w600k_r50.onnx']
            has_required = all(f in files for f in required_files)

            if has_required:
                model_info = f"{dir_name} ({rel_path})"
                available_models.append(model_info)
    if not available_models:
        return ["无可用模型"]

    # 按名称排序
    available_models.sort()


    return available_models


def _ensure_cv2():
    """确保 cv2 已安装"""
    global cv2
    if cv2 is not None:
        return cv2
    cv2 = load_dependency_at_runtime(
        module_name="cv2",
        node_name=NODE_DISPLAY_NAME,
        package_name="opencv-python",
        description="该节点需要 OpenCV 进行图像处理。",
    )
    return cv2


def _ensure_insightface():
    """确保 InsightFace 已经加载到模块级缓存，避免辅助函数读到未定义全局变量。"""
    global insightface
    if insightface is None:
        _load_dependencies()
    return insightface


def _raise_missing_model(label: str, subdir: str, filename: str, description: str, unique_id=None):
    from .common_utils.dependency_checker import make_missing_model_spec, raise_dependency_model_error

    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[
            make_missing_model_spec(
                label=label,
                subdir=subdir,
                filename=filename,
                description=description,
            )
        ],
        description=description or "该节点需要本地 InsightFace 人脸检测模型、ReActor 换脸模型；选择 GPEN 时还需要对应换脸后修复模型。",
        unique_id=unique_id,
        title="GJJ 一键批量换脸缺少模型！",
        model_download_url=MODEL_DOWNLOAD_URL,
    )


def get_image_md5hash(img_data: np.ndarray) -> str:
    """计算图片的 MD5 哈希值"""
    import hashlib
    cv2 = _ensure_cv2()
    img_bytes = cv2.imencode('.png', img_data)[1].tobytes()
    return hashlib.md5(img_bytes).hexdigest()


def get_analysis_model(det_size=(640, 640), model_path=None):
    """获取人脸分析模型

    Args:
        det_size: 检测尺寸
        model_path: 模型目录的完整路径（如果为 None 则自动扫描）
    """
    global ANALYSIS_MODELS
    insightface_module = _ensure_insightface()

    models_path = folder_paths.models_dir

    key = str(det_size[0])

    # 如果指定了模型路径，直接使用
    if model_path and os.path.exists(model_path):

        try:
            # insightface 需要的是父目录，不是 buffalo_l 本身
            parent_dir = os.path.dirname(model_path)
            model_name = os.path.basename(model_path)

            # 直接初始化，不传递额外参数（遵循 ReActor 原版）
            ANALYSIS_MODELS[key] = insightface_module.app.FaceAnalysis(
                name=model_name,
                root=parent_dir
            )

            if 'detection' in ANALYSIS_MODELS[key].models:
                print(f"[GJJ FaceAnalysis] ✅ 成功加载模型: {model_path}")
            else:
                error_msg = f"在 {model_path} 中未找到 detection 模型\n"
                error_msg += f"已加载的模型: {list(ANALYSIS_MODELS[key].models.keys())}\n"
                error_msg += f"请检查模型文件是否完整且未损坏"
                raise RuntimeError(error_msg)

        except RuntimeError:
            # 重新抛出 RuntimeError
            raise
        except Exception as e:
            # 捕获其他异常并添加详细信息
            error_msg = f"从指定路径 {model_path} 加载失败: {e}\n"
            error_msg += f"父目录: {parent_dir}\n"
            error_msg += f"模型名称: {model_name}\n"
            error_msg += f"异常类型: {type(e).__name__}\n"
            import traceback
            error_msg += f"详细堆栈:\n{traceback.format_exc()}"
            raise RuntimeError(error_msg)

        model = ANALYSIS_MODELS[key]
        try:
            import torch.cuda as cuda
            if cuda is not None and cuda.is_available():
                model.prepare(ctx_id=0, det_size=det_size)
            else:
                model.prepare(ctx_id=-1, det_size=det_size)
        except:
            model.prepare(ctx_id=-1, det_size=det_size)
        return model

    # 自动检测模式：扫描所有可用模型并使用第一个
    if key not in ANALYSIS_MODELS or ANALYSIS_MODELS[key] is None:
        available_models = scan_available_models()

        if not available_models or available_models[0] == "无可用模型":
            _raise_missing_model(
                label="buffalo_l 人脸检测模型",
                subdir="models/insightface",
                filename="buffalo_l",
                description="目录内至少需要 det_10g.onnx 和 w600k_r50.onnx。",
            )

        # 使用第一个可用的模型
        first_model_info = available_models[0]
        # 提取相对路径部分
        rel_path = first_model_info.split('(')[1].rstrip(')')
        full_path = os.path.join(models_path, rel_path)

        try:
            parent_dir = os.path.dirname(full_path)
            model_name = os.path.basename(full_path)


            ANALYSIS_MODELS[key] = insightface_module.app.FaceAnalysis(
                name=model_name,
                root=parent_dir
            )
            if 'detection' in ANALYSIS_MODELS[key].models:
                print(f"[GJJ FaceAnalysis] ✅ 成功加载模型: {full_path}")
            else:
                raise RuntimeError("缺少 detection 模型")
        except Exception as e:
            import traceback
            raise RuntimeError(f"自动加载模型失败: {e}\n{traceback.format_exc()}")

    model = ANALYSIS_MODELS[key]
    # 在 prepare 时设置设备上下文
    try:
        import torch.cuda as cuda
        if cuda is not None and cuda.is_available():
            model.prepare(ctx_id=0, det_size=det_size)  # GPU
        else:
            model.prepare(ctx_id=-1, det_size=det_size)  # CPU
    except:
        model.prepare(ctx_id=-1, det_size=det_size)  # 降级到 CPU

    return model


def get_face_swap_model(model_path: str):
    """获取换脸模型"""
    global FS_MODEL, CURRENT_FS_MODEL_PATH
    insightface_module = _ensure_insightface()

    if CURRENT_FS_MODEL_PATH is None or CURRENT_FS_MODEL_PATH != model_path:
        CURRENT_FS_MODEL_PATH = model_path
        # ReActor 原版做法：不传递 providers 参数
        try:
            import torch.cuda as cuda
            if cuda is not None and cuda.is_available():
                # GPU 模式
                FS_MODEL = insightface_module.model_zoo.get_model(
                    model_path,
                    provider_name="CUDAExecutionProvider"
                )
            else:
                # CPU 模式
                FS_MODEL = insightface_module.model_zoo.get_model(
                    model_path,
                    provider_name="CPUExecutionProvider"
                )
        except:
            # 降级处理：尝试不带 provider_name 参数
            FS_MODEL = insightface_module.model_zoo.get_model(model_path)

    return FS_MODEL


def _is_no_restore_model(model_name: Optional[str]) -> bool:
    if model_name is None:
        return True
    return str(model_name).strip() in {"", RESTORE_MODEL_NONE, "None", "none", "禁用"}


def _resolve_insightface_or_facerestore_model(filename: str) -> str:
    """优先从 models/insightface 查找；兼容 ComfyUI 的 facerestore_models 目录。"""
    if os.path.isabs(filename) and os.path.exists(filename):
        return filename

    models_path = folder_paths.models_dir
    insightface_path = os.path.join(models_path, "insightface")
    direct_candidates = [
        os.path.join(insightface_path, filename),
        os.path.join(models_path, filename),
    ]

    for candidate in direct_candidates:
        if os.path.exists(candidate):
            return candidate

    if os.path.exists(insightface_path):
        target_name = os.path.basename(filename).lower()
        for root, _dirs, files in os.walk(insightface_path):
            for file_name in files:
                if file_name.lower() == target_name:
                    return os.path.join(root, file_name)

    try:
        full_path = folder_paths.get_full_path("facerestore_models", filename)
        if full_path and os.path.exists(full_path):
            return full_path
    except Exception:
        pass

    return os.path.join(insightface_path, filename)


def _resolve_available_identity_swap_model(default: str = "inswapper_128.onnx") -> str:
    insightface_path = os.path.join(folder_paths.models_dir, "insightface")
    for name in IDENTITY_SWAP_MODEL_OPTIONS:
        if os.path.exists(os.path.join(insightface_path, name)):
            return name
    return default


def _resolve_face_model_path(face_model: Optional[str]) -> Optional[str]:
    if not face_model or face_model == "无可用模型":
        return None
    face_model = str(face_model)
    if "(" in face_model and ")" in face_model:
        rel_path = face_model.split("(", 1)[1].rstrip(")")
        return os.path.join(folder_paths.models_dir, rel_path)
    return None


class _GpenFaceRestoreModel:
    """轻量 GPEN ONNX 推理封装，用于换脸后局部人脸修复。"""

    def __init__(self, model_path: str):
        ort = load_dependency_at_runtime(
            module_name="onnxruntime",
            node_name=NODE_DISPLAY_NAME,
            package_name="onnxruntime-gpu",
            description="该节点需要 ONNX Runtime 执行 GPEN-BFR 换脸后修复模型。",
        )
        providers = ["CPUExecutionProvider"]
        try:
            import torch.cuda as cuda
            available = set(ort.get_available_providers())
            if cuda is not None and cuda.is_available() and "CUDAExecutionProvider" in available:
                providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        except Exception:
            pass

        self.model_path = model_path
        self.session = ort.InferenceSession(model_path, providers=providers)
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        self.input_size = self._read_input_size()

    def _read_input_size(self) -> int:
        shape = list(self.session.get_inputs()[0].shape or [])
        if len(shape) >= 4:
            for value in (shape[2], shape[3]):
                if isinstance(value, int) and value > 0:
                    return int(value)
        lower_name = os.path.basename(self.model_path).lower()
        if "512" in lower_name:
            return 512
        return 256

    def _preprocess(self, bgr_face: np.ndarray) -> np.ndarray:
        cv2 = _ensure_cv2()
        rgb_face = cv2.cvtColor(bgr_face, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        blob = (rgb_face - 0.5) / 0.5
        return np.transpose(blob, (2, 0, 1))[None].astype(np.float32)

    def _postprocess(self, output: np.ndarray) -> np.ndarray:
        cv2 = _ensure_cv2()
        restored = output[0] if output.ndim == 4 else output
        if restored.ndim == 3 and restored.shape[0] in (1, 3):
            restored = np.transpose(restored, (1, 2, 0))

        restored = restored.astype(np.float32)
        if float(np.nanmin(restored)) < 0.0:
            restored = (restored + 1.0) * 0.5
        elif float(np.nanmax(restored)) > 1.5:
            restored = restored / 255.0

        restored = np.clip(restored * 255.0, 0, 255).astype(np.uint8)
        if restored.ndim == 2:
            restored = np.repeat(restored[:, :, None], 3, axis=2)
        elif restored.shape[2] == 1:
            restored = np.repeat(restored, 3, axis=2)
        elif restored.shape[2] > 3:
            restored = restored[:, :, :3]
        restored = cv2.cvtColor(restored, cv2.COLOR_RGB2BGR)
        if restored.shape[0] != self.input_size or restored.shape[1] != self.input_size:
            restored = cv2.resize(restored, (self.input_size, self.input_size), interpolation=cv2.INTER_LINEAR)
        return restored

    def _paste_back(self, image: np.ndarray, restored_face: np.ndarray, matrix: np.ndarray) -> np.ndarray:
        cv2 = _ensure_cv2()
        target_img = image.astype(np.float32)
        height, width = image.shape[:2]
        inverse_matrix = cv2.invertAffineTransform(matrix)

        warped_face = cv2.warpAffine(restored_face, inverse_matrix, (width, height), borderValue=0.0).astype(np.float32)
        mask = np.full((self.input_size, self.input_size), 255, dtype=np.float32)
        mask = cv2.warpAffine(mask, inverse_matrix, (width, height), borderValue=0.0)

        mask_y, mask_x = np.where(mask > 20)
        if len(mask_y) == 0 or len(mask_x) == 0:
            return image

        mask_h = max(1, int(np.max(mask_y) - np.min(mask_y)))
        mask_w = max(1, int(np.max(mask_x) - np.min(mask_x)))
        mask_size = max(16, int(np.sqrt(mask_h * mask_w)))
        erode_size = max(mask_size // 12, 8)
        blur_size = max(mask_size // 20, 5)
        blur_size = blur_size + 1 if blur_size % 2 == 0 else blur_size

        mask = cv2.erode(mask, np.ones((erode_size, erode_size), np.uint8), iterations=1)
        mask = cv2.GaussianBlur(mask, (blur_size, blur_size), 0)
        mask = np.clip(mask / 255.0, 0.0, 1.0)[:, :, None]

        blended = mask * warped_face + (1.0 - mask) * target_img
        return np.clip(blended, 0, 255).astype(np.uint8)

    def restore(self, image: np.ndarray, target_face) -> np.ndarray:
        from insightface.utils import face_align

        aligned_face, matrix = face_align.norm_crop2(image, target_face.kps, self.input_size)
        output = self.session.run([self.output_name], {self.input_name: self._preprocess(aligned_face)})[0]
        restored_face = self._postprocess(output)
        return self._paste_back(image, restored_face, matrix)


def get_face_restore_model(model_path: str) -> _GpenFaceRestoreModel:
    """获取并缓存 GPEN 换脸后修复模型。"""
    global RESTORE_MODELS
    if model_path not in RESTORE_MODELS:
        RESTORE_MODELS[model_path] = _GpenFaceRestoreModel(model_path)
    return RESTORE_MODELS[model_path]


def apply_face_restore_model(
    image: np.ndarray,
    target_faces,
    faces_index: List[int],
    restore_model: Optional[str],
    model_path: Optional[str] = None,
    unique_id=None,
) -> np.ndarray:
    """对已换脸结果中的目标脸区域执行 GPEN 修复。"""
    if _is_no_restore_model(restore_model) or not target_faces:
        return image

    restore_path = _resolve_insightface_or_facerestore_model(str(restore_model))
    if not os.path.exists(restore_path):
        _raise_missing_model(
            label="GPEN 换脸后修复模型",
            subdir="models/insightface",
            filename=str(restore_model),
            description="用于在完成身份换脸后修复和增强目标脸细节的 ONNX 模型。",
            unique_id=unique_id,
        )

    restorer = get_face_restore_model(restore_path)
    result = image

    for face_num in faces_index:
        if face_num >= len(target_faces):
            continue
        target_face, _ = get_face_single(
            result,
            target_faces,
            face_index=face_num,
            order="large-small",
            model_path=model_path,
        )
        if target_face is not None:
            result = restorer.restore(result, target_face)

    return result


def sort_faces_by_order(faces, order: str = "large-small"):
    """按指定顺序排序人脸"""
    if order == "left-right":
        return sorted(faces, key=lambda x: x.bbox[0])
    if order == "right-left":
        return sorted(faces, key=lambda x: x.bbox[0], reverse=True)
    if order == "top-bottom":
        return sorted(faces, key=lambda x: x.bbox[1])
    if order == "bottom-top":
        return sorted(faces, key=lambda x: x.bbox[1], reverse=True)
    if order == "small-large":
        return sorted(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
    # 默认 large-small
    return sorted(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]), reverse=True)


def analyze_faces(img_data: np.ndarray, det_size=(640, 640), model_path=None):
    """分析图片中的人脸

    Args:
        img_data: 图像数据
        det_size: 检测尺寸
        model_path: 模型目录的完整路径（如果为 None 则自动扫描）
    """
    face_analyser = get_analysis_model(det_size, model_path=model_path)
    faces = face_analyser.get(img_data)

    # 如果没找到人脸，尝试减小检测尺寸
    if len(faces) == 0 and det_size[0] > 320 and det_size[1] > 320:
        det_size_half = (det_size[0] // 2, det_size[1] // 2)
        return analyze_faces(img_data, det_size_half, model_path=model_path)

    return faces


def get_face_single(img_data: np.ndarray, faces, face_index=0, det_size=(640, 640),
                    order="large-small", model_path=None):
    """获取单个人脸"""
    buffalo_path = os.path.join(folder_paths.models_dir, "insightface", "models", "buffalo_l.zip")
    if os.path.exists(buffalo_path):
        os.remove(buffalo_path)

    # 无性别过滤
    if len(faces) == 0 and det_size[0] > 320 and det_size[1] > 320:
        det_size_half = (det_size[0] // 2, det_size[1] // 2)
        return get_face_single(img_data, analyze_faces(img_data, det_size_half, model_path=model_path),
                             face_index, det_size_half, order, model_path=model_path)

    try:
        faces_sorted = sort_faces_by_order(faces, order)
        return faces_sorted[face_index], 0
    except IndexError:
        return None, 0


def _parse_face_index_group(text: str) -> List[int]:
    text = str(text or "").strip()
    if not text or text in {"-", "none", "None", "无"}:
        return []
    indices: List[int] = []
    for part in text.replace("，", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            index = int(part)
        except ValueError:
            continue
        if index >= 0 and index not in indices:
            indices.append(index)
    return indices


def _parse_face_index_groups(value: Any) -> List[List[int]]:
    text = str(value or "").strip()
    if not text:
        return [[0]]
    if any(separator in text for separator in ("|", ";", "\n")):
        normalized = text.replace("；", ";").replace("\r", "\n").replace(";", "|").replace("\n", "|")
        groups = [_parse_face_index_group(part) for part in normalized.split("|")]
        return groups if groups else [[0]]
    group = _parse_face_index_group(text)
    if group or text in {"-", "none", "None", "无"}:
        return [group]
    return [[0]]


def _uses_ordered_target_faces(value: Any) -> bool:
    return ":" in str(value or "")


def _parse_target_face_sequence(value: Any, image_count: int) -> List[Tuple[int, int]]:
    text = str(value or "").strip()
    if not text or text in {"-", "none", "None", "无"}:
        return []

    entries: List[Tuple[int, int]] = []
    seen = set()
    if ":" in text:
        normalized = (
            text.replace("，", ",")
            .replace("；", ";")
            .replace("\r", "\n")
            .replace("\n", ",")
            .replace(";", ",")
            .replace("|", ",")
        )
        for token in normalized.split(","):
            token = token.strip()
            if ":" not in token:
                continue
            image_part, face_part = token.split(":", 1)
            try:
                image_index = int(image_part.strip())
                face_index = int(face_part.strip())
            except ValueError:
                continue
            if image_index < 0 or face_index < 0 or image_index >= max(1, image_count):
                continue
            key = (image_index, face_index)
            if key in seen:
                continue
            seen.add(key)
            entries.append(key)
        return entries

    groups = _parse_face_index_groups(text)
    for image_index in range(max(1, image_count)):
        for face_index in _indices_for_image(groups, image_index):
            key = (image_index, face_index)
            if face_index < 0 or key in seen:
                continue
            seen.add(key)
            entries.append(key)
    return entries


def _indices_for_image(groups: List[List[int]], index: int) -> List[int]:
    if not groups:
        return [0]
    if len(groups) == 1:
        return list(groups[0])
    safe_index = min(max(index, 0), len(groups) - 1)
    return list(groups[safe_index])


def _source_face_sequence(value: Any, groups: List[List[int]], image_count: int) -> List[Tuple[int, int]]:
    if ":" in str(value or ""):
        return _parse_target_face_sequence(value, image_count)

    sequence: List[Tuple[int, int]] = []
    seen = set()
    for image_index in range(max(1, image_count)):
        for face_index in _indices_for_image(groups, image_index):
            if face_index < 0:
                continue
            key = (image_index, face_index)
            if key in seen:
                continue
            seen.add(key)
            sequence.append(key)
    return sequence


def _detect_target_face_counts(target_pils: List[Image.Image], model_path: Optional[str]) -> List[int]:
    counts: List[int] = []
    for target_pil in target_pils:
        target_faces = analyze_faces(_pil_to_bgr(target_pil), model_path=model_path)
        counts.append(len(target_faces))
    return counts


def _expand_target_face_tasks(
    explicit_entries: List[Tuple[int, int]],
    face_counts: List[int],
) -> List[Tuple[int, int]]:
    if not face_counts:
        return []

    if not explicit_entries:
        return [
            (image_index, face_index)
            for image_index, face_count in enumerate(face_counts)
            for face_index in range(max(0, face_count))
        ]

    return [
        (image_index, face_index)
        for image_index, face_index in explicit_entries
        if 0 <= image_index < len(face_counts) and 0 <= face_index < face_counts[image_index]
    ]


def _target_face_groups_by_image(
    explicit_entries: List[Tuple[int, int]],
    face_counts: List[int],
) -> Dict[int, List[int]]:
    groups: Dict[int, List[int]] = {}
    if not face_counts:
        return groups

    if explicit_entries:
        for image_index, face_index in explicit_entries:
            if 0 <= image_index < len(face_counts) and 0 <= face_index < face_counts[image_index]:
                groups.setdefault(image_index, []).append(face_index)
        return groups

    for image_index, face_count in enumerate(face_counts):
        if face_count > 0:
            groups[image_index] = list(range(face_count))
    return groups


def _debug_face_sequence(label: str, sequence: List[Tuple[int, int]]) -> str:
    if not sequence:
        return f"{label}=空"
    one_based = [f"序号{i + 1}:图{image_index + 1}/脸{face_index}" for i, (image_index, face_index) in enumerate(sequence)]
    return f"{label}=" + "，".join(one_based)


def _debug_target_groups(groups: Dict[int, List[int]]) -> str:
    if not groups:
        return "目标分组=空"
    parts = []
    for image_index in sorted(groups):
        faces = ",".join(str(face_index) for face_index in groups[image_index])
        parts.append(f"图{image_index + 1}:[{faces}]")
    return "目标分组=" + "；".join(parts)


def _tensor_change_signature(value: Any) -> str:
    if not isinstance(value, torch.Tensor):
        return ""
    try:
        tensor = value.detach().contiguous()
        flat = tensor.reshape(-1)
        step = max(1, int(flat.numel()) // 4096)
        sample = flat[::step].float().cpu().numpy().tobytes()
        digest = hashlib.blake2b(digest_size=16)
        digest.update(str(tuple(tensor.shape)).encode("utf-8"))
        digest.update(str(tensor.dtype).encode("utf-8"))
        digest.update(sample)
        digest.update(str(float(tensor.float().mean().cpu())).encode("utf-8"))
        return digest.hexdigest()
    except Exception:
        return str(tuple(value.shape))


def swap_face_core(
    source_img: Union[Image.Image, np.ndarray, None],
    target_img: Union[Image.Image, np.ndarray],
    model: str,
    face_restore_model: str = RESTORE_MODEL_NONE,
    source_faces_index: List[int] = [0],
    faces_index: List[int] = [0],
    model_path: str = None,
    unique_id=None,
) -> Image.Image:
    """
    核心换脸函数 - 从 ReActor 复制并简化

    Args:
        model_path: buffalo 模型目录的完整路径（如果为 None 则自动扫描）
    """
    cv2 = _ensure_cv2()

    result_image = target_img if isinstance(target_img, Image.Image) else Image.fromarray(cv2.cvtColor(target_img, cv2.COLOR_RGB2BGR))

    if model is None:
        return result_image

    # 转换为目标格式
    if isinstance(target_img, Image.Image):
        target_cv = cv2.cvtColor(np.array(target_img), cv2.COLOR_RGB2BGR)
    else:
        target_cv = target_img

    source_cv = None
    if source_img is not None:
        if isinstance(source_img, Image.Image):
            source_cv = cv2.cvtColor(np.array(source_img), cv2.COLOR_RGB2BGR)
        else:
            source_cv = source_img

    # 分析源图人脸。这里不使用跨执行全局缓存，避免上游换图后复用旧脸框。
    if source_cv is not None:
        source_faces = analyze_faces(source_cv, model_path=model_path)
    else:
        return result_image

    # 分析目标图人脸。每次按当前目标图重新检测，确保上游图片改变后结果同步更新。
    target_faces = analyze_faces(target_cv, model_path=model_path)

    if len(target_faces) == 0:
        return result_image

    if not source_faces or not faces_index:
        return result_image

    # 执行换脸
    models_path = folder_paths.models_dir
    insightface_path = os.path.join(models_path, "insightface")
    swap_model_path = os.path.join(insightface_path, model)

    if not os.path.exists(swap_model_path):
        _raise_missing_model(
            label="ReActor 换脸模型",
            subdir="models/insightface",
            filename=model,
            description="用于执行脸部特征交换的 ONNX 模型。",
            unique_id=unique_id,
        )

    face_swapper = get_face_swap_model(swap_model_path)
    result = target_cv

    selected_source_indices = list(source_faces_index or [0])

    for pair_index, face_num in enumerate(faces_index):
        if face_num >= len(target_faces):
            break

        source_face_index = selected_source_indices[min(pair_index, len(selected_source_indices) - 1)]
        source_face, _ = get_face_single(
            source_cv, source_faces,
            face_index=source_face_index,
            order="large-small",
            model_path=model_path
        )
        if source_face is None:
            continue

        target_face, _ = get_face_single(
            target_cv, target_faces,
            face_index=face_num,
            order="large-small",
            model_path=model_path
        )

        if target_face is not None:
            result = face_swapper.get(result, target_face, source_face)

    result = apply_face_restore_model(
        result,
        target_faces,
        faces_index,
        face_restore_model,
        model_path=model_path,
        unique_id=unique_id,
    )

    result_image = Image.fromarray(cv2.cvtColor(result, cv2.COLOR_BGR2RGB))
    return result_image


def swap_face_sequence_core(
    target_img: Image.Image,
    pairs: List[Tuple[Image.Image, int, int]],
    model: str,
    face_restore_model: str = RESTORE_MODEL_NONE,
    model_path: str = None,
    unique_id=None,
) -> Image.Image:
    """在同一张目标图上按原始人脸索引连续执行一组一对一换脸。"""
    cv2 = _ensure_cv2()
    if model is None or not pairs:
        return target_img

    target_cv = cv2.cvtColor(np.array(target_img), cv2.COLOR_RGB2BGR)
    target_faces = sort_faces_by_order(analyze_faces(target_cv, model_path=model_path), "large-small")
    print(
        f"[GJJ FaceAnalysis DEBUG] 单目标执行：目标检测到 {len(target_faces)} 张脸；"
        f"待执行 {[(src_face, tgt_face) for _src_img, src_face, tgt_face in pairs]}",
        flush=True,
    )
    if not target_faces:
        return target_img

    models_path = folder_paths.models_dir
    insightface_path = os.path.join(models_path, "insightface")
    swap_model_path = os.path.join(insightface_path, model)
    if not os.path.exists(swap_model_path):
        _raise_missing_model(
            label="ReActor 换脸模型",
            subdir="models/insightface",
            filename=model,
            description="用于执行脸部特征交换的 ONNX 模型。",
            unique_id=unique_id,
        )

    face_swapper = get_face_swap_model(swap_model_path)
    result = target_cv.copy()
    restore_indices: List[int] = []

    for source_pil, source_face_index, target_face_index in pairs:
        if target_face_index < 0 or target_face_index >= len(target_faces):
            print(
                f"[GJJ FaceAnalysis DEBUG] 跳过：目标脸索引 {target_face_index} 超出检测数量 {len(target_faces)}",
                flush=True,
            )
            continue
        source_cv = cv2.cvtColor(np.array(source_pil), cv2.COLOR_RGB2BGR)
        source_faces = sort_faces_by_order(analyze_faces(source_cv, model_path=model_path), "large-small")
        if source_face_index < 0 or source_face_index >= len(source_faces):
            print(
                f"[GJJ FaceAnalysis DEBUG] 跳过：源脸索引 {source_face_index} 超出检测数量 {len(source_faces)}",
                flush=True,
            )
            continue
        print(
            f"[GJJ FaceAnalysis DEBUG] 执行：目标脸索引 {target_face_index} <- 源脸索引 {source_face_index}；"
            f"源图检测 {len(source_faces)} 张脸",
            flush=True,
        )
        result = face_swapper.get(result, target_faces[target_face_index], source_faces[source_face_index])
        if target_face_index not in restore_indices:
            restore_indices.append(target_face_index)

    result = apply_face_restore_model(
        result,
        target_faces,
        restore_indices,
        face_restore_model,
        model_path=model_path,
        unique_id=unique_id,
    )

    return Image.fromarray(cv2.cvtColor(result, cv2.COLOR_BGR2RGB))


# ============================================================================
# GJJ 节点辅助函数
# ============================================================================

def _unwrap_scalar_param(value: Any) -> Any:
    try:
        while isinstance(value, (list, tuple)) and len(value) == 1 and not isinstance(value[0], torch.Tensor):
            value = value[0]
    except Exception:
        pass
    return value


def _is_image_tensor(value: Any) -> bool:
    return isinstance(value, torch.Tensor) and value.ndim in (3, 4) and int(value.shape[-1]) in (1, 3, 4)


def _split_image_tensor(value: torch.Tensor) -> List[torch.Tensor]:
    if value.ndim == 3:
        return [value.unsqueeze(0).detach().float().contiguous()]
    return [value[index:index + 1].detach().float().contiguous() for index in range(int(value.shape[0]))]


def _iter_image_container_values(value: Any) -> List[Any]:
    if value is None or isinstance(value, (str, bytes, bytearray)) or torch.is_tensor(value):
        return []
    if isinstance(value, dict):
        return list(value.values())
    if isinstance(value, (list, tuple, set)):
        return list(value)
    values: List[Any] = []
    for name in ("images", "image", "imgs", "batch", "queue", "items", "values", "selected", "image_list", "image_queue"):
        try:
            child = getattr(value, name, None)
            if child is not None and child is not value:
                values.append(child)
        except Exception:
            pass
    try:
        values.extend(vars(value).values())
    except Exception:
        pass
    try:
        if hasattr(value, "__iter__"):
            values.extend(list(value))
    except Exception:
        pass
    return values


def normalize_image_batch(value: Any, _seen: Optional[set[int]] = None) -> List[torch.Tensor]:
    """将 IMAGE batch、GJJ_BATCH_IMAGE 列表或自定义容器标准化为单张图片列表。"""
    if _seen is None:
        _seen = set()
    if value is None:
        return []

    oid = id(value)
    if oid in _seen:
        return []
    _seen.add(oid)

    if _is_image_tensor(value):
        return _split_image_tensor(value)

    images: List[torch.Tensor] = []
    for child in _iter_image_container_values(value):
        images.extend(normalize_image_batch(child, _seen))
    return images


def ensure_rgb(image: torch.Tensor) -> torch.Tensor:
    """确保图片为 RGB 格式(3通道)"""
    if image.ndim != 4:
        raise RuntimeError(f"期望4维张量,收到 {image.ndim} 维")

    channels = int(image.shape[-1])
    if channels == 3:
        return image.contiguous()
    elif channels == 4:
        rgb = image[..., :3]
        alpha = image[..., 3:4].clamp(0.0, 1.0)
        return (rgb * alpha).contiguous()
    elif channels == 1:
        return image.repeat(1, 1, 1, 3).contiguous()
    else:
        raise RuntimeError(f"不支持的通道数: {channels}")


def tensor_to_pil(image: torch.Tensor) -> Image.Image:
    """将 torch.Tensor 转换为 PIL Image"""
    image_np = image.squeeze(0).cpu().numpy()
    image_np = np.clip(image_np * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(image_np)


def pil_to_tensor(image: Image.Image) -> torch.Tensor:
    """将 PIL Image 转换为 torch.Tensor"""
    image_np = np.array(image).astype(np.float32) / 255.0
    return torch.from_numpy(image_np).unsqueeze(0)


def _pil_to_bgr(image: Image.Image) -> np.ndarray:
    cv2 = _ensure_cv2()
    return cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2BGR)


class GJJ_FaceAnalysis:
    CATEGORY = CATEGORY
    FUNCTION = "swap_faces"
    INPUT_IS_LIST = True
    OUTPUT_NODE = False
    DESCRIPTION = DESCRIPTION
    GJJ_HELP = {
        "description": READY_DESCRIPTION if (_DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE) else _ENVIRONMENT_REPORT.get("panel_message", ""),
        "models": [
            {
                "label": "📍 人脸定位",
                "value": "models/insightface/scrfd_34g_gnkps.onnx",
                "tooltip": "可选 SCRFD 人脸定位模型。",
            },
            {
                "label": "📍 人脸定位",
                "value": "models/insightface/scrfd_10g_bnkps.onnx",
                "tooltip": "可选 SCRFD 人脸定位模型。",
            },
            {
                "label": "🪪 身份提取",
                "value": "models/insightface/buffalo_l",
                "tooltip": "用于人脸分析、关键点和身份特征提取。",
            },
            {
                "label": "🔁 换脸融合",
                "value": "models/insightface/inswapper_128.onnx",
                "tooltip": "用于执行身份换脸融合。",
            },
            {
                "label": "🔁 换脸融合",
                "value": "models/insightface/inswapper_128_fp16.onnx",
                "tooltip": "可选 FP16 换脸融合模型。",
            },
            {
                "label": "✨ 高清修复",
                "value": "models/insightface/GPEN-BFR-256.onnx",
                "tooltip": "可选换脸后高清修复模型。",
            },
            {
                "label": "✨ 高清修复",
                "value": "models/insightface/GPEN-BFR-512.onnx",
                "tooltip": "可选换脸后高清修复模型。",
            },
        ],
        "dependencies": [spec["display_name"] for spec in DEPENDENCY_SPECS],
        "notice": _ENVIRONMENT_REPORT.get("help_message", "") if not (_DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE) else "",
        "warning_message": _ENVIRONMENT_REPORT.get("warning_message", "") if not (_DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE) else "",
        "install_cmd": _ENVIRONMENT_REPORT.get("install_cmd", "") if not _DEPENDENCIES_AVAILABLE else "",
        "optional_install_cmd": _ENVIRONMENT_REPORT.get("optional_install_cmd", ""),
        "copy_text": _ENVIRONMENT_REPORT.get("copy_text", ""),
        "copy_label": _ENVIRONMENT_REPORT.get("copy_label", ""),
        "model_download_url": _ENVIRONMENT_REPORT.get("model_download_url", MODEL_DOWNLOAD_URL) or MODEL_DOWNLOAD_URL,
        "notice_level": _ENVIRONMENT_REPORT.get("notice_level", ""),
    }

    RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE",)
    RETURN_NAMES = ("换脸结果",)
    OUTPUT_TOOLTIPS = ("换脸后的图片列表，保持每张目标图的原始尺寸。",)
    OUTPUT_IS_LIST = (True,)

    @classmethod
    def INPUT_TYPES(cls):
        # 扫描可用的模型
        available_models = scan_available_models()

        return {
            "required": {
                "target_image": (
                    "GJJ_BATCH_IMAGE,IMAGE",
                    {
                        "display_name": "目标图",
                        "tooltip": "需要被换脸的图片,支持单图或批量输入",
                    },
                ),
                "source_image": (
                    "GJJ_BATCH_IMAGE,IMAGE",
                    {
                        "display_name": "源图",
                        "tooltip": "提供脸部特征的图片,支持单图或批量输入",
                    },
                ),
            },
            "optional": {
                "face_detection": (
                    FACE_DETECTION_OPTIONS,
                    {
                        "display_name": "📍 人脸定位",
                        "tooltip": "选择人脸定位策略；SCRFD 模型文件可放在 models/insightface。",
                        "default": "YOLOv5n",
                    },
                ),
                "face_model": (
                    available_models,
                    {
                        "display_name": "🪪 身份提取",
                        "tooltip": "选择用于身份特征提取的 buffalo 模型（自动扫描 models/insightface 目录）。",
                        "default": available_models[0] if available_models and available_models[0] != "无可用模型" else "无可用模型",
                    },
                ),
                "swap_model": (
                    SWAP_MODEL_OPTIONS,
                    {
                        "display_name": "🔁 换脸融合",
                        "tooltip": "选择负责身份交换和融合的 ReActor/inswapper 模型文件。",
                        "default": "inswapper_128.onnx",
                    },
                ),
                "face_restore_model": (
                    FACE_RESTORE_MODEL_OPTIONS,
                    {
                        "display_name": "✨ 高清修复",
                        "tooltip": "可选。选择 GPEN-BFR-256/512 后，会在完成身份换脸后增强目标脸细节；模型可放在 models/insightface。",
                        "default": RESTORE_MODEL_NONE,
                    },
                ),
                "target_faces_index": (
                    "STRING",
                    {
                        "display_name": "目标脸部索引",
                        "tooltip": "目标图中要替换的人脸索引(从0开始,逗号分隔)。也可直接点击面板生成人脸按钮自动填写。",
                        "default": "0",
                        "multiline": False,
                    },
                ),
                "source_faces_index": (
                    "STRING",
                    {
                        "display_name": "源图脸部索引",
                        "tooltip": "源图中用作替换源的人脸索引(从0开始,逗号分隔)",
                        "default": "0",
                        "multiline": False,
                    },
                ),
                "face_picker_signature": (
                    "STRING",
                    {
                        "display_name": "人脸选择签名",
                        "tooltip": "前端内部使用：记录上游图片和点选人脸变化，用于刷新执行缓存。",
                        "default": "",
                        "multiline": False,
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(
        cls,
        target_image=None,
        source_image=None,
        face_model: str = "",
        swap_model: str = "",
        face_detection: str = "",
        target_faces_index: str = "",
        source_faces_index: str = "",
        face_restore_model: str = RESTORE_MODEL_NONE,
        face_picker_signature: str = "",
        **_kwargs,
    ):
        # 人脸按钮和上游图片选择都可能由前端面板动态写入；这里强制每次队列都执行，
        # 避免 ComfyUI 复用上一轮换脸结果。
        return float("NaN")

    def swap_faces(
        self,
        target_image: Any,
        source_image: Any,
        face_model: str = "自动检测",
        swap_model: str = "inswapper_128.onnx",
        face_detection: str = "YOLOv5n",
        target_faces_index: str = "0",
        source_faces_index: str = "0",
        face_restore_model: str = RESTORE_MODEL_NONE,
        face_picker_signature: str = "",
        unique_id=None,
    ):
        """执行换脸操作"""
        face_model = str(_unwrap_scalar_param(face_model) or "自动检测")
        swap_model = str(_unwrap_scalar_param(swap_model) or "inswapper_128.onnx")
        face_detection = str(_unwrap_scalar_param(face_detection) or "YOLOv5n")
        target_faces_index = str(_unwrap_scalar_param(target_faces_index) or "")
        source_faces_index = str(_unwrap_scalar_param(source_faces_index) or "")
        face_restore_model = str(_unwrap_scalar_param(face_restore_model) or RESTORE_MODEL_NONE)
        face_picker_signature = str(_unwrap_scalar_param(face_picker_signature) or "")
        unique_id = _unwrap_scalar_param(unique_id)

        _send_status(unique_id, "1/5 加载换脸运行时...", 0.05)
        _ = face_detection
        # 运行时加载依赖
        cv2, insightface, Face, PROVIDERS = _load_dependencies(unique_id=unique_id)

        _send_status(unique_id, "2/5 整理目标图和源图...", 0.14)
        # 标准化输入
        target_images = normalize_image_batch(target_image)
        source_images = normalize_image_batch(source_image)
        print(
            f"[GJJ FaceAnalysis DEBUG] 输入标准化：目标 {len(target_images)} 张 / 源 {len(source_images)} 张；"
            f"target_type={type(target_image).__name__} source_type={type(source_image).__name__}",
            flush=True,
        )

        if not target_images:
            raise RuntimeError("目标图不能为空")
        if not source_images:
            raise RuntimeError("源图不能为空")

        # 确保 RGB 格式
        target_images = [ensure_rgb(img) for img in target_images]
        source_images = [ensure_rgb(img) for img in source_images]

        target_index_groups = _parse_face_index_groups(target_faces_index)
        source_index_groups = _parse_face_index_groups(source_faces_index)
        _send_status(
            unique_id,
            f"3/5 准备人脸检测模型和换脸模型：目标 {len(target_images)} 张 / 源 {len(source_images)} 张",
            0.22,
        )
        # 解析模型路径
        if face_model == "无可用模型":
            _raise_missing_model(
                label="buffalo_l 人脸检测模型",
                subdir="models/insightface",
                filename="buffalo_l",
                description="目录内至少需要 det_10g.onnx 和 w600k_r50.onnx。",
                unique_id=unique_id,
            )

        # 从显示名称中提取相对路径
        # 格式: "buffalo_l (insightface\models\buffalo_l)"
        actual_model_path = _resolve_face_model_path(face_model)

        if actual_model_path:
            print(f"[GJJ FaceAnalysis] 📂 模型路径: {actual_model_path}")
        if swap_model in FACE_RESTORE_MODEL_FILENAMES:
            if _is_no_restore_model(face_restore_model):
                face_restore_model = swap_model
            identity_swap_model = _resolve_available_identity_swap_model()
            print(
                "[GJJ FaceAnalysis] GPEN-BFR 是换脸后修复模型，"
                f"已启用 {face_restore_model}，身份交换模型使用 {identity_swap_model}"
            )
            swap_model = identity_swap_model
        if not _is_no_restore_model(face_restore_model):
            print(f"[GJJ FaceAnalysis] 已启用换脸后修复模型：{face_restore_model}")

        smart_target_mode = _uses_ordered_target_faces(target_faces_index) or (
            str(target_faces_index or "").strip() in {"", "-", "无", "none", "None"}
            and bool(face_picker_signature.strip())
        )
        if smart_target_mode:
            target_pils = [tensor_to_pil(img) for img in target_images]
            source_pils = [tensor_to_pil(img) for img in source_images]
            source_sequence = _source_face_sequence(source_faces_index, source_index_groups, len(source_pils))
            if not source_sequence:
                results = [pil_to_tensor(img) for img in target_pils]
                _send_status(unique_id, "5/5 完成：未选择源脸，输出原目标图", 1.0)
                return (results,)

            _send_status(unique_id, "3/5 智能整理目标脸顺序...", 0.24)
            face_counts = _detect_target_face_counts(target_pils, actual_model_path)
            explicit_targets = _parse_target_face_sequence(target_faces_index, len(target_pils))
            target_groups = _target_face_groups_by_image(explicit_targets, face_counts)
            target_task_count = sum(len(faces) for faces in target_groups.values())
            print(
                "\n".join([
                    "[GJJ FaceAnalysis DEBUG] ===== 智能换脸配对开始 =====",
                    f"[GJJ FaceAnalysis DEBUG] 原始 target_faces_index: {target_faces_index!r}",
                    f"[GJJ FaceAnalysis DEBUG] 原始 source_faces_index: {source_faces_index!r}",
                    f"[GJJ FaceAnalysis DEBUG] 目标图检测人脸数量: {face_counts}",
                    f"[GJJ FaceAnalysis DEBUG] {_debug_face_sequence('目标点击序列', explicit_targets)}",
                    f"[GJJ FaceAnalysis DEBUG] {_debug_target_groups(target_groups)}",
                    f"[GJJ FaceAnalysis DEBUG] {_debug_face_sequence('源点击序列', source_sequence)}",
                ]),
                flush=True,
            )
            if target_task_count <= 0:
                results = [pil_to_tensor(img) for img in target_pils]
                _send_status(unique_id, "5/5 完成：目标图未识别到可替换人脸", 1.0)
                return (results,)

            total_pairs = sum(
                min(len(target_groups.get(target_image_index, [])), len(source_sequence))
                for target_image_index in range(len(target_pils))
            )
            if total_pairs <= 0:
                results = [pil_to_tensor(img) for img in target_pils]
                _send_status(unique_id, "5/5 完成：目标脸和源脸没有可一一配对的序号", 1.0)
                return (results,)

            results = []
            processed_pairs = 0
            working_targets = [img.copy() for img in target_pils]
            for target_image_index in range(len(target_pils)):
                target_face_indices = target_groups.get(target_image_index, [])
                face_pairs: List[Tuple[Image.Image, int, int]] = []
                for local_index, target_face_index in enumerate(target_face_indices):
                    if local_index >= len(source_sequence):
                        print(
                            f"[GJJ FaceAnalysis DEBUG] 图{target_image_index + 1} 目标序号{local_index + 1} 没有对应源序号，跳过目标脸索引 {target_face_index}",
                            flush=True,
                        )
                        break
                    source_image_index, source_face_index = source_sequence[local_index]
                    processed_pairs += 1
                    progress = 0.28 + 0.62 * (processed_pairs / max(1, total_pairs))
                    _send_status(
                        unique_id,
                        f"4/5 按序号一一换脸：{processed_pairs}/{total_pairs}",
                        progress,
                    )
                    print(
                        f"[GJJ FaceAnalysis DEBUG] 配对：目标图{target_image_index + 1} 目标序号{local_index + 1}"
                        f"(目标脸索引 {target_face_index}) <- 源序号{local_index + 1}"
                        f"(源图{source_image_index + 1} 源脸索引 {source_face_index})",
                        flush=True,
                    )
                    face_pairs.append((source_pils[source_image_index], source_face_index, target_face_index))
                if face_pairs:
                    working_targets[target_image_index] = swap_face_sequence_core(
                        working_targets[target_image_index],
                        face_pairs,
                        swap_model,
                        face_restore_model,
                        model_path=actual_model_path,
                        unique_id=unique_id,
                    )
            print("[GJJ FaceAnalysis DEBUG] ===== 智能换脸配对结束 =====", flush=True)
            results.extend(pil_to_tensor(img) for img in working_targets)

            _send_status(unique_id, f"5/5 完成：输出 {len(results)} 张智能换脸结果", 1.0)
            return (results,)

        # 确定配对策略并执行换脸
        results = []
        if len(source_images) == 1 and len(target_images) > 1:
            total_pairs = len(target_images)
        elif len(target_images) == 1 and len(source_images) > 1:
            total_pairs = len(source_images)
        else:
            total_pairs = len(source_images) * len(target_images)
        processed_pairs = 0

        def _report_pair() -> None:
            nonlocal processed_pairs
            processed_pairs += 1
            progress = 0.28 + 0.62 * (processed_pairs / max(1, total_pairs))
            _send_status(unique_id, f"4/5 换脸处理中：{processed_pairs}/{total_pairs}", progress)

        if len(source_images) == 1 and len(target_images) > 1:
            # 单源多目标：同一张源图应用到所有目标图
            source_pil = tensor_to_pil(source_images[0])
            source_indices = _indices_for_image(source_index_groups, 0)
            for target_idx, target_img in enumerate(target_images):
                _report_pair()
                target_pil = tensor_to_pil(target_img)
                target_indices = _indices_for_image(target_index_groups, target_idx)
                result_pil = swap_face_core(
                    source_pil, target_pil,
                    model=swap_model,
                    face_restore_model=face_restore_model,
                    source_faces_index=source_indices,
                    faces_index=target_indices,
                    model_path=actual_model_path,
                    unique_id=unique_id,
                )
                results.append(pil_to_tensor(result_pil))

        elif len(target_images) == 1 and len(source_images) > 1:
            # 单目标多源：所有源图应用到同一张目标图
            target_pil = tensor_to_pil(target_images[0])
            target_indices = _indices_for_image(target_index_groups, 0)
            for source_idx, source_img in enumerate(source_images):
                _report_pair()
                source_pil = tensor_to_pil(source_img)
                source_indices = _indices_for_image(source_index_groups, source_idx)
                result_pil = swap_face_core(
                    source_pil, target_pil,
                    model=swap_model,
                    face_restore_model=face_restore_model,
                    source_faces_index=source_indices,
                    faces_index=target_indices,
                    model_path=actual_model_path,
                    unique_id=unique_id,
                )
                results.append(pil_to_tensor(result_pil))

        else:
            # 批量+批量：所有源图和目标图两两配对（笛卡尔积）
            # 例如：4个目标 + 2个源 → 8个结果（2×4=8）
            total_pairs = len(source_images) * len(target_images)
            pair_num = 0

            for source_idx, source_img in enumerate(source_images):
                source_pil = tensor_to_pil(source_img)
                source_indices = _indices_for_image(source_index_groups, source_idx)

                for target_idx, target_img in enumerate(target_images):
                    pair_num += 1
                    _report_pair()
                    target_pil = tensor_to_pil(target_img)
                    target_indices = _indices_for_image(target_index_groups, target_idx)

                    result_pil = swap_face_core(
                        source_pil, target_pil,
                        model=swap_model,
                        face_restore_model=face_restore_model,
                        source_faces_index=source_indices,
                        faces_index=target_indices,
                        model_path=actual_model_path,
                        unique_id=unique_id,
                    )
                    results.append(pil_to_tensor(result_pil))

        # 合并结果
        _send_status(unique_id, f"5/5 完成：输出 {len(results)} 张换脸结果", 1.0)
        return (results,)


def _safe_join_media_path(root: str, subfolder: str, filename: str) -> str:
    root_abs = os.path.abspath(root)
    candidate = os.path.abspath(os.path.join(root_abs, str(subfolder or ""), str(filename or "")))
    if os.path.commonpath([root_abs, candidate]) != root_abs:
        raise RuntimeError("图片路径越界")
    return candidate


def _resolve_ui_image_path(image_info: Dict[str, Any]) -> str:
    filename = str(image_info.get("filename") or "").strip()
    subfolder = str(image_info.get("subfolder") or "").strip("/\\")
    media_type = str(image_info.get("type") or "input").strip().lower()
    if not filename:
        raise RuntimeError("没有收到图片文件名")

    if media_type == "output":
        return _safe_join_media_path(folder_paths.get_output_directory(), subfolder, filename)
    if media_type == "temp":
        return _safe_join_media_path(folder_paths.get_temp_directory(), subfolder, filename)
    if media_type == "input":
        return _safe_join_media_path(folder_paths.get_input_directory(), subfolder, filename)

    try:
        return folder_paths.get_annotated_filepath(filename)
    except Exception:
        return _safe_join_media_path(folder_paths.get_input_directory(), subfolder, filename)


def _face_crop_data_url(image: Image.Image, bbox: List[int]) -> str:
    width, height = image.size
    x1, y1, x2, y2 = bbox
    face_w = max(1, x2 - x1)
    face_h = max(1, y2 - y1)
    pad_x = int(face_w * 0.25)
    pad_y = int(face_h * 0.25)
    crop_box = (
        max(0, x1 - pad_x),
        max(0, y1 - pad_y),
        min(width, x2 + pad_x),
        min(height, y2 + pad_y),
    )
    crop = image.crop(crop_box)
    resample_lanczos = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    crop.thumbnail((96, 96), resample_lanczos)
    buffer = io.BytesIO()
    crop.save(buffer, format="JPEG", quality=82)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def _detect_ui_faces(image_info: Dict[str, Any], face_model: Optional[str] = None) -> Dict[str, Any]:
    data_url = str(image_info.get("data_url") or "")
    if data_url.startswith("data:image/") and "," in data_url:
        _header, encoded = data_url.split(",", 1)
        image_bytes = base64.b64decode(encoded)
        image = Image.open(io.BytesIO(image_bytes))
    else:
        image_path = _resolve_ui_image_path(image_info)
        if not os.path.exists(image_path):
            raise RuntimeError(f"图片不存在：{os.path.basename(image_path)}")
        image = Image.open(image_path)

    image = ImageOps.exif_transpose(image).convert("RGB")
    model_path = _resolve_face_model_path(face_model)
    cv_image = _pil_to_bgr(image)
    faces = sort_faces_by_order(analyze_faces(cv_image, model_path=model_path), "large-small")
    width, height = image.size
    payload_faces = []

    for index, face in enumerate(faces):
        x1, y1, x2, y2 = [int(round(float(value))) for value in face.bbox[:4]]
        bbox = [
            max(0, min(width, x1)),
            max(0, min(height, y1)),
            max(0, min(width, x2)),
            max(0, min(height, y2)),
        ]
        payload_faces.append({
            "index": index,
            "label": f"脸 {index + 1}",
            "bbox": bbox,
            "thumbnail": _face_crop_data_url(image, bbox),
        })

    return {
        "ok": True,
        "width": width,
        "height": height,
        "faces": payload_faces,
    }


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/gjj/face_analysis/detect_faces")
    async def gjj_face_analysis_detect_faces(request):
        try:
            data = await request.json()
            image_info = data.get("image") if isinstance(data, dict) else None
            if not isinstance(image_info, dict):
                return web.json_response({"ok": False, "error": "请求缺少图片信息"}, status=400)
            return web.json_response(_detect_ui_faces(image_info, data.get("face_model")))
        except Exception as error:
            return web.json_response({"ok": False, "error": str(error), "faces": []}, status=500)

except Exception:
    pass


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_FaceAnalysis,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "GJJ · 🎭 一键批量换脸",
}
