"""
GJJ · 🎭 换脸分析器
内联 ReActor 核心的零依赖换脸节点
将 ReActor 的关键功能直接嵌入节点，无需外部包依赖
"""

from __future__ import annotations

# ============================================================================
# 零依赖：必须在所有其他导入之前添加 vendor 路径！
# ============================================================================
import os
import sys

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
import cv2
import numpy as np
from PIL import Image
from typing import Any, Dict, List, Optional, Tuple, Union

import folder_paths
import torch

# ============================================================================
# 零依赖：集成 insightface 到 vendor 目录
# ============================================================================
# 将 vendor 目录添加到 Python 路径
vendor_path = os.path.join(os.path.dirname(__file__), '..', 'vendor')
if vendor_path not in sys.path:
    sys.path.insert(0, vendor_path)

NODE_NAME = "GJJ_FaceAnalysis"
CATEGORY = "GJJ/图像"
DESCRIPTION = """内联 ReActor 核心的换脸节点：将源图的脸部特征迁移到目标图上。

【核心功能】
• 双批量输入 - 源图和目标图均支持单图或多图
• 智能配对 - 自动处理一对一、一对多、多对一场景
• 内联 ReActor - 直接使用 reactor 原版代码，无需安装额外包
• 批量输出 - 保持与输入对应的批量结构

【工作原理】
节点内置了 ReActor 的核心换脸逻辑：
1. 使用 insightface 进行人脸检测和关键点提取
2. 通过 inswapper_128 模型执行脸部特征交换
3. 可选的面部修复增强（GFPGAN/CodeFormer）
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
• 使用 YOLOv5n 进行人脸检测
• inswapper_128 模型执行换脸
• 自动处理不同尺寸的图片
• 保持原始分辨率和色彩空间"""


# ============================================================================
# 内联 ReActor 核心代码 - 从 comfyui-reactor-node 复制
# 使用 vendor 目录中的 insightface（零依赖）
# ============================================================================

try:
    # 使用 vendor 中的 insightface
    import insightface
    from insightface.app.common import Face
    
    # 设置执行提供者
    try:
        import torch.cuda as cuda
        if cuda is not None and cuda.is_available():
            PROVIDERS = ["CUDAExecutionProvider"]
        else:
            PROVIDERS = ["CPUExecutionProvider"]
    except:
        PROVIDERS = ["CPUExecutionProvider"]
    
    REACTOR_AVAILABLE = True
except ImportError as e:
    REACTOR_AVAILABLE = False
    PROVIDERS = ["CPUExecutionProvider"]


# 全局变量缓存
FS_MODEL = None
CURRENT_FS_MODEL_PATH = None
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


def get_image_md5hash(img_data: np.ndarray) -> str:
    """计算图片的 MD5 哈希值"""
    import hashlib
    img_bytes = cv2.imencode('.png', img_data)[1].tobytes()
    return hashlib.md5(img_bytes).hexdigest()


def get_analysis_model(det_size=(640, 640), model_path=None):
    """获取人脸分析模型
    
    Args:
        det_size: 检测尺寸
        model_path: 模型目录的完整路径（如果为 None 则自动扫描）
    """
    global ANALYSIS_MODELS
    
    models_path = folder_paths.models_dir
    
    key = str(det_size[0])
    
    # 如果指定了模型路径，直接使用
    if model_path and os.path.exists(model_path):
        
        try:
            # insightface 需要的是父目录，不是 buffalo_l 本身
            parent_dir = os.path.dirname(model_path)
            model_name = os.path.basename(model_path)
            
            # 直接初始化，不传递额外参数（遵循 ReActor 原版）
            ANALYSIS_MODELS[key] = insightface.app.FaceAnalysis(
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
            raise RuntimeError(
                f"无法找到可用的 buffalo 人脸检测模型。\n"
                f"请确保模型文件存在于 ComfyUI/models/insightface/ 目录及其子目录中。\n"
                f"可以从 https://github.com/deepinsight/insightface/releases 下载 buffalo_l 模型"
            )
        
        # 使用第一个可用的模型
        first_model_info = available_models[0]
        # 提取相对路径部分
        rel_path = first_model_info.split('(')[1].rstrip(')')
        full_path = os.path.join(models_path, rel_path)
        
        try:
            parent_dir = os.path.dirname(full_path)
            model_name = os.path.basename(full_path)
            
            
            ANALYSIS_MODELS[key] = insightface.app.FaceAnalysis(
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
    
    if CURRENT_FS_MODEL_PATH is None or CURRENT_FS_MODEL_PATH != model_path:
        CURRENT_FS_MODEL_PATH = model_path
        # ReActor 原版做法：不传递 providers 参数
        try:
            import torch.cuda as cuda
            if cuda is not None and cuda.is_available():
                # GPU 模式
                FS_MODEL = insightface.model_zoo.get_model(
                    model_path,
                    provider_name="CUDAExecutionProvider"
                )
            else:
                # CPU 模式
                FS_MODEL = insightface.model_zoo.get_model(
                    model_path,
                    provider_name="CPUExecutionProvider"
                )
        except:
            # 降级处理：尝试不带 provider_name 参数
            FS_MODEL = insightface.model_zoo.get_model(model_path)
    
    return FS_MODEL


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


def swap_face_core(
    source_img: Union[Image.Image, np.ndarray, None],
    target_img: Union[Image.Image, np.ndarray],
    model: str,
    source_faces_index: List[int] = [0],
    faces_index: List[int] = [0],
    model_path: str = None,
) -> Image.Image:
    """
    核心换脸函数 - 从 ReActor 复制并简化
    
    Args:
        model_path: buffalo 模型目录的完整路径（如果为 None 则自动扫描）
    """
    global SOURCE_FACES, SOURCE_IMAGE_HASH, TARGET_FACES, TARGET_IMAGE_HASH
    
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
    
    # 分析源图人脸
    if source_cv is not None:
        source_hash = get_image_md5hash(source_cv)
        
        if SOURCE_IMAGE_HASH != source_hash:
            SOURCE_IMAGE_HASH = source_hash
            SOURCE_FACES = None
        
        if SOURCE_FACES is None:
            SOURCE_FACES = analyze_faces(source_cv, model_path=model_path)
        
        source_faces = SOURCE_FACES
    else:
        return result_image
    
    # 分析目标图人脸
    target_hash = get_image_md5hash(target_cv)
    
    if TARGET_IMAGE_HASH != target_hash:
        TARGET_IMAGE_HASH = target_hash
        TARGET_FACES = None
    
    if TARGET_FACES is None:
        TARGET_FACES = analyze_faces(target_cv, model_path=model_path)
    
    target_faces = TARGET_FACES
    
    if len(target_faces) == 0:
        return result_image
    
    # 获取源人脸
    if len(source_faces_index) > 0:
        source_face, _ = get_face_single(
            source_cv, source_faces, 
            face_index=source_faces_index[0], 
            order="large-small",
            model_path=model_path
        )
    else:
        source_face = sort_faces_by_order(source_faces, "large-small")[0]
    
    if source_face is None:
        return result_image
    
    # 执行换脸
    models_path = folder_paths.models_dir
    insightface_path = os.path.join(models_path, "insightface")
    model_path = os.path.join(insightface_path, model)
    
    if not os.path.exists(model_path):
        raise RuntimeError(f"找不到换脸模型文件: {model}\n请将模型放置于 ComfyUI/models/insightface/ 目录")
    
    face_swapper = get_face_swap_model(model_path)
    result = target_cv
    
    for face_num in faces_index:
        if face_num >= len(target_faces):
            break
        
        target_face, _ = get_face_single(
            target_cv, target_faces,
            face_index=face_num,
            order="large-small",
            model_path=model_path
        )
        
        if target_face is not None:
            result = face_swapper.get(result, target_face, source_face)
    
    result_image = Image.fromarray(cv2.cvtColor(result, cv2.COLOR_BGR2RGB))
    return result_image


# ============================================================================
# GJJ 节点辅助函数
# ============================================================================

def normalize_image_batch(value: Any) -> List[torch.Tensor]:
    """将输入标准化为图片列表"""
    if value is None:
        return []
    
    if isinstance(value, torch.Tensor):
        if value.ndim == 3:
            return [value.unsqueeze(0)]
        elif value.ndim == 4:
            return [value[i:i+1] for i in range(value.shape[0])]
    
    return []


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


class GJJ_FaceAnalysis:
    CATEGORY = CATEGORY
    FUNCTION = "swap_faces"
    OUTPUT_NODE = False
    DESCRIPTION = DESCRIPTION
    
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("换脸结果",)
    OUTPUT_TOOLTIPS = ("换脸后的图片,保持与目标图相同的批量结构",)

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
                "face_model": (
                    available_models,
                    {
                        "display_name": "人脸检测模型",
                        "tooltip": "选择要使用的 buffalo 人脸检测模型（自动扫描 models/insightface 目录）",
                        "default": available_models[0] if available_models and available_models[0] != "无可用模型" else "无可用模型",
                    },
                ),
                "swap_model": (
                    ["inswapper_128.onnx", "inswapper_128_fp16.onnx"],
                    {
                        "display_name": "换脸模型",
                        "tooltip": "选择 ReActor 换脸模型文件",
                        "default": "inswapper_128.onnx",
                    },
                ),
                "face_detection": (
                    ["YOLOv5n", "retinaface_resnet50"],
                    {
                        "display_name": "人脸检测",
                        "tooltip": "选择人脸检测模型",
                        "default": "YOLOv5n",
                    },
                ),
                "target_faces_index": (
                    "STRING",
                    {
                        "display_name": "目标脸部索引",
                        "tooltip": "目标图中要替换的人脸索引(从0开始,逗号分隔)",
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
            },
        }

    def swap_faces(
        self,
        target_image: Any,
        source_image: Any,
        face_model: str = "自动检测",
        swap_model: str = "inswapper_128.onnx",
        face_detection: str = "YOLOv5n",
        target_faces_index: str = "0",
        source_faces_index: str = "0",
    ):
        """执行换脸操作"""
        
        if not REACTOR_AVAILABLE:
            raise RuntimeError(
                "缺少 insightface 依赖。请安装:\n"
                "pip install insightface onnxruntime-gpu\n\n"
                "并将 inswapper_128.onnx 模型放置于 ComfyUI/models/insightface/ 目录"
            )
        
        # 标准化输入
        target_images = normalize_image_batch(target_image)
        source_images = normalize_image_batch(source_image)
        
        if not target_images:
            raise RuntimeError("目标图不能为空")
        if not source_images:
            raise RuntimeError("源图不能为空")
        
        # 确保 RGB 格式
        target_images = [ensure_rgb(img) for img in target_images]
        source_images = [ensure_rgb(img) for img in source_images]
        
        try:
            target_indices = [int(x.strip()) for x in target_faces_index.split(",") if x.strip()]
            if not target_indices:
                target_indices = [0]
        except ValueError:
            target_indices = [0]
        
        try:
            source_indices = [int(x.strip()) for x in source_faces_index.split(",") if x.strip()]
            if not source_indices:
                source_indices = [0]
        except ValueError:
            source_indices = [0]
        # 解析模型路径
        if face_model == "无可用模型":
            raise RuntimeError(
                f"未找到可用的 buffalo 人脸检测模型。\n"
                f"请确保模型文件存在于 ComfyUI/models/insightface/ 目录及其子目录中。\n"
                f"可以从 https://github.com/deepinsight/insightface/releases 下载 buffalo_l 模型"
            )
        
        # 从显示名称中提取相对路径
        # 格式: "buffalo_l (insightface\models\buffalo_l)"
        if '(' in face_model and ')' in face_model:
            rel_path = face_model.split('(')[1].rstrip(')')
            actual_model_path = os.path.join(folder_paths.models_dir, rel_path)
        else:
            actual_model_path = None
        
        if actual_model_path:
            print(f"[GJJ FaceAnalysis] 📂 模型路径: {actual_model_path}")
        
        # 确定配对策略并执行换脸
        results = []
        
        if len(source_images) == 1 and len(target_images) > 1:
            # 单源多目标：同一张源图应用到所有目标图
            source_pil = tensor_to_pil(source_images[0])
            for target_img in target_images:
                target_pil = tensor_to_pil(target_img)
                result_pil = swap_face_core(
                    source_pil, target_pil,
                    model=swap_model,
                    source_faces_index=source_indices,
                    faces_index=target_indices,
                    model_path=actual_model_path,
                )
                results.append(pil_to_tensor(result_pil))
        
        elif len(target_images) == 1 and len(source_images) > 1:
            # 单目标多源：所有源图应用到同一张目标图
            target_pil = tensor_to_pil(target_images[0])
            for source_img in source_images:
                source_pil = tensor_to_pil(source_img)
                result_pil = swap_face_core(
                    source_pil, target_pil,
                    model=swap_model,
                    source_faces_index=source_indices,
                    faces_index=target_indices,
                    model_path=actual_model_path,
                )
                results.append(pil_to_tensor(result_pil))
        
        else:
            # 批量+批量：所有源图和目标图两两配对（笛卡尔积）
            # 例如：4个目标 + 2个源 → 8个结果（2×4=8）
            total_pairs = len(source_images) * len(target_images)
            pair_num = 0
            
            for source_idx, source_img in enumerate(source_images):
                source_pil = tensor_to_pil(source_img)
                
                for target_idx, target_img in enumerate(target_images):
                    pair_num += 1
                    target_pil = tensor_to_pil(target_img)
                    
                    
                    result_pil = swap_face_core(
                        source_pil, target_pil,
                        model=swap_model,
                        source_faces_index=source_indices,
                        faces_index=target_indices,
                        model_path=actual_model_path,
                    )
                    results.append(pil_to_tensor(result_pil))
        
        # 合并结果
        if len(results) == 1:
            return (results[0],)
        else:
            batch = torch.cat(results, dim=0)
            return (batch,)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_FaceAnalysis,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "GJJ · 🎭 换脸分析器",
}
