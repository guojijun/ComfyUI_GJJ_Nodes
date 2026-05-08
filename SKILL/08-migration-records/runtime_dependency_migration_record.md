# GJJ 节点运行时依赖改造记录

## 📋 改造目标

**消除所有启动时的模型和依赖检查**，统一改为**运行时按需加载**，大幅缩短 ComfyUI 启动时间。

### 问题背景

- ❌ 启动时扫描17个CLIP模型（`scan_models.py`）
- ❌ 启动时检查所有 Python 依赖（cv2, soundfile, insightface等）
- ❌ 启动时导入所有模块（包括重型模块如 SAM3、Face Analysis）
- ❌ 启动时间从 5秒 延长到 30+秒

### 改造后效果

- ✅ 启动时间从 30+秒 缩短到 <5秒
- ✅ 只在节点执行时才加载对应依赖
- ✅ 缺失依赖时提供友好提示和一键安装命令
- ✅ 不影响已安装依赖的节点正常运行

---

## 🔧 已完成改造的文件

### 1. `nodes/__init__.py` - 排除工具脚本自动导入

**改动内容**：
- 添加 `TOOL_SCRIPTS` 集合，列出所有不应被自动导入的工具脚本
- 在自动导入循环中跳过这些脚本

```python
# 这些是工具脚本（非节点模块），不应被自动导入
TOOL_SCRIPTS = {
    "scan_models",
    "scan_all_models",
    "merge_scanned_models",
    "analyze_official_workflows",
    "analyze_video_workflows",
    "fix_insightface_bug",
    "generate_node_docs",
}

# 在导入循环中跳过
if module_name in TOOL_SCRIPTS:
    continue
```

**影响**：
- `scan_models.py` 不再在启动时执行
- 其他分析脚本也不会被自动导入
- 启动时不再显示 "Scanning project for model usage..."

---

### 2. `nodes/gjj_sem2_point_segmenter.py` - SEM2点分割器

**改造前**：
```python
import cv2
from hydra import compose, initialize_config_dir
from hydra.core.global_hydra import GlobalHydra
from hydra.utils import instantiate
from sam2.sam2_image_predictor import SAM2ImagePredictor
```

**改造后**：
```python
# 延迟导入：运行时依赖检查
def _load_dependencies():
    """运行时加载 cv2、hydra 和 sam2，失败时提供友好提示"""
    from .common_utils.dependency_checker import load_dependency_at_runtime
    
    cv2 = load_dependency_at_runtime(
        module_name="cv2",
        node_name="GJJ · SEM2点分割器",
        package_name="opencv-python",
        description="该节点需要 OpenCV 进行图像处理"
    )
    
    hydra = load_dependency_at_runtime(
        module_name="hydra",
        node_name="GJJ · SEM2点分割器",
        package_name="hydra-core",
        description="该节点需要 Hydra 进行配置管理"
    )
    
    compose = hydra.compose
    initialize_config_dir = hydra.initialize_config_dir
    GlobalHydra = hydra.core.global_hydra.GlobalHydra
    instantiate = hydra.utils.instantiate
    
    # SAM2 从 vendor 目录导入
    try:
        from sam2.sam2_image_predictor import SAM2ImagePredictor
    except ImportError as exc:
        raise RuntimeError(
            f"\n 未找到 SAM2 运行库。\n"
            f"🔧 解决方案：\n"
            f"  1. 确保 vendor/sam2 目录存在且包含完整的 SAM2 代码\n"
            f"  2. 如果缺失，请从 https://github.com/facebookresearch/segment-anything-2 下载\n"
            f"原始导入错误：{exc}\n"
            f"💡 提示：安装后请重启 ComfyUI 服务器。"
        ) from exc
    
    return cv2, compose, initialize_config_dir, GlobalHydra, instantiate, SAM2ImagePredictor

# 在主函数中调用
def segment(self, ...):
    try:
        # 运行时加载依赖
        cv2, compose, initialize_config_dir, GlobalHydra, instantiate, SAM2ImagePredictor = _load_dependencies()
        # ... 后续逻辑
```

**依赖列表**：
- `opencv-python` (cv2)
- `hydra-core` (hydra)
- `sam2` (vendor 目录)

---

### 3. `nodes/gjj_face_detailer_runtime.py` - 人脸细节增强器运行库

**改造前**：
```python
import cv2
from segment_anything import SamPredictor, sam_model_registry
```

**改造后**：
```python
# 延迟导入：运行时依赖检查
def _load_dependencies():
    """运行时加载 cv2 和 segment_anything，失败时提供友好提示"""
    from .common_utils.dependency_checker import load_dependency_at_runtime
    
    cv2 = load_dependency_at_runtime(
        module_name="cv2",
        node_name="GJJ · 人脸细节增强器",
        package_name="opencv-python",
        description="该节点需要 OpenCV 进行图像处理"
    )
    
    try:
        from segment_anything import SamPredictor, sam_model_registry
    except ImportError as exc:
        raise RuntimeError(
            f"\n 未找到 segment_anything 运行库。\n"
            f"🔧 安装命令：\n"
            f"  pip install git+https://github.com/facebookresearch/segment-anything.git\n"
            f"原始导入错误：{exc}\n"
            f"💡 提示：安装后请重启 ComfyUI 服务器。"
        ) from exc
    
    return cv2, SamPredictor, sam_model_registry
```

**依赖列表**：
- `opencv-python` (cv2)
- `segment-anything` (SAM)

---

### 4. `nodes/gjj_ultralytics_runtime.py` - Ultralytics 运行库

**改造前**：
```python
import cv2
```

**改造后**：
```python
# 延迟导入：运行时依赖检查
def _load_cv2():
    """运行时加载 cv2，失败时提供友好提示"""
    from .common_utils.dependency_checker import load_dependency_at_runtime
    return load_dependency_at_runtime(
        module_name="cv2",
        node_name="GJJ · Ultralytics 运行库",
        package_name="opencv-python",
        description="该模块需要 OpenCV 进行图像处理"
    )

# 在使用 cv2 的函数中调用
def dilate_masks(segmasks, dilation_factor: int, iterations: int = 1):
    if dilation_factor == 0:
        return segmasks
    
    cv2 = _load_cv2()  # 运行时加载
    kernel = np.ones((abs(dilation_factor), abs(dilation_factor)), np.uint8)
    # ... 后续逻辑

def combine_masks(masks):
    if len(masks) == 0:
        return None
    
    cv2 = _load_cv2()  # 运行时加载
    # ... 后续逻辑

def inference_bbox(model, image: Image.Image, confidence: float = 0.3, device: str = ""):
    cv2 = _load_cv2()  # 运行时加载
    # ... 后续逻辑
```

**依赖列表**：
- `opencv-python` (cv2)

---

### 5. `nodes/gjj_face_analysis.py` - 🎭 换脸分析器

**问题**：启动时使用未定义的变量 `REACTOR_AVAILABLE`，导致节点加载失败。

**改造前**：
```python
# 模块顶部进行启动时依赖检查
try:
    import insightface
    from insightface.app.common import Face
    REACTOR_AVAILABLE = True
except ImportError as e:
    REACTOR_AVAILABLE = False
    _IMPORT_ERROR = str(e)

# 根据检查结果设置 DESCRIPTION
if not REACTOR_AVAILABLE:
    DESCRIPTION = """❌ 节点缺少必需的 Python 依赖..."""
else:
    DESCRIPTION = """内联 ReActor 核心的换脸节点..."""

# 在函数中再次检查
if not REACTOR_AVAILABLE:
    raise RuntimeError("运行时依赖缺失...")
```

**改造后**：
```python
# 延迟导入：运行时依赖检查
def _load_dependencies():
    """运行时加载 insightface、cv2 等依赖，失败时提供友好提示"""
    from .common_utils.dependency_checker import load_dependency_at_runtime
    import sys
    
    # 加载 cv2
    cv2 = load_dependency_at_runtime(
        module_name="cv2",
        node_name="GJJ · 🎭 换脸分析器",
        package_name="opencv-python",
        description="该节点需要 OpenCV 进行图像处理"
    )
    
    # 加载 insightface
    insightface = load_dependency_at_runtime(
        module_name="insightface",
        node_name="GJJ · 🎭 换脸分析器",
        package_name="insightface",
        extra_packages=["onnxruntime-gpu"],
        description="该节点需要 InsightFace 进行人脸识别和换脸"
    )
    
    # 从 insightface 导入 Face 类
    try:
        from insightface.app.common import Face
    except ImportError as exc:
        raise RuntimeError(
            f"\n 未找到 insightface.app.common.Face。\n"
            f"🔧 快速安装命令：\n"
            f"  {sys.executable} -m pip install insightface onnxruntime-gpu -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
            f"原始导入错误：{exc}\n"
            f"💡 提示：安装后请重启 ComfyUI 服务器。"
        ) from exc
    
    # 设置执行提供者
    try:
        import torch.cuda as cuda
        if cuda is not None and cuda.is_available():
            PROVIDERS = ["CUDAExecutionProvider"]
        else:
            PROVIDERS = ["CPUExecutionProvider"]
    except:
        PROVIDERS = ["CPUExecutionProvider"]
    
    return cv2, insightface, Face, PROVIDERS

# DESCRIPTION 统一为正常描述
DESCRIPTION = """内联 ReActor 核心的换脸节点..."""

# 在主函数中调用
def swap_faces(self, ...):
    """执行换脸操作"""
    # 运行时加载依赖
    cv2, insightface, Face, PROVIDERS = _load_dependencies()
    # ... 后续逻辑
```

**依赖列表**：
- `opencv-python` (cv2)
- `insightface` (人脸识别核心库)
- `onnxruntime-gpu` (GPU 加速，可选)

**关键改进**：
- ✅ 移除了启动时的 `try-except` 块
- ✅ 删除了未定义的 `REACTOR_AVAILABLE` 变量
- ✅ 使用统一的 `_load_dependencies()` 函数
- ✅ 提供了详细的安装命令和错误提示

---

## 📊 改造统计

| 文件 | 改造前导入数 | 改造后导入数 | 依赖类型 |
|------|------------|------------|---------|
| `__init__.py` | N/A | N/A | 工具脚本排除 |
| `gjj_sem2_point_segmenter.py` | 6 | 0 (运行时) | cv2, hydra, sam2 |
| `gjj_face_detailer_runtime.py` | 2 | 0 (运行时) | cv2, segment_anything |
| `gjj_ultralytics_runtime.py` | 1 | 0 (运行时) | cv2 |
| `gjj_face_analysis.py` | 3 | 0 (运行时) | cv2, insightface, onnxruntime-gpu |

**总计**：
- 移除启动时导入：**12 个模块**
- 改为运行时加载：**5 个文件**
- 预计启动时间缩短：**~30秒**

---

## 🎯 通用改造模式

### 模式 1：单依赖加载

适用于只依赖一个模块的情况：

```python
# 顶部定义加载函数
def _load_cv2():
    from .common_utils.dependency_checker import load_dependency_at_runtime
    return load_dependency_at_runtime(
        module_name="cv2",
        node_name="GJJ · 我的节点",
        package_name="opencv-python",
        description="该节点需要 OpenCV 进行图像处理"
    )

# 在使用处调用
def my_function():
    cv2 = _load_cv2()
    # 使用 cv2...
```

### 模式 2：多依赖加载

适用于依赖多个模块的情况：

```python
# 顶部定义加载函数
def _load_dependencies():
    from .common_utils.dependency_checker import load_dependency_at_runtime
    
    cv2 = load_dependency_at_runtime(
        module_name="cv2",
        node_name="GJJ · 我的节点",
        package_name="opencv-python",
        description="图像处理"
    )
    
    hydra = load_dependency_at_runtime(
        module_name="hydra",
        node_name="GJJ · 我的节点",
        package_name="hydra-core",
        description="配置管理"
    )
    
    return cv2, hydra

# 在主函数中一次性加载
def execute(self, ...):
    try:
        cv2, hydra = _load_dependencies()
        # 使用依赖...
    except Exception as exc:
        raise RuntimeError(f"依赖加载失败：{exc}") from exc
```

### 模式 3：第三方库特殊处理

适用于需要从 vendor 目录或 GitHub 安装的库：

```python
def _load_dependencies():
    from .common_utils.dependency_checker import load_dependency_at_runtime
    
    # 标准依赖
    cv2 = load_dependency_at_runtime(...)
    
    # 特殊依赖（手动处理）
    try:
        from my_special_lib import MyClass
    except ImportError as exc:
        raise RuntimeError(
            f"\n 未找到 my_special_lib 运行库。\n"
            f"🔧 解决方案：\n"
            f"  1. 确保 vendor/my_special_lib 目录存在\n"
            f"  2. 或者运行：pip install my-special-lib\n"
            f"原始错误：{exc}"
        ) from exc
    
    return cv2, MyClass
```

---

## ⚠️ 注意事项

### 1. 缓存机制

`load_dependency_at_runtime()` 内部使用 `sys` 属性缓存已加载的模块，避免重复导入：

```python
cache_key = f"_gjj_runtime_{module_name}"
if hasattr(sys, cache_key):
    return getattr(sys, cache_key)  # 直接返回缓存
```

### 2. 错误提示格式

所有运行时依赖错误都遵循统一格式：

```
================================================================================
  GJJ 节点运行时依赖缺失！
================================================================================
[GJJ] 节点: GJJ · 我的节点
[GJJ] 缺失依赖: cv2
[GJJ] 该节点需要 OpenCV 进行图像处理

[GJJ] 快速安装命令:
  D:\AI\MOD\python_embeded\python.exe -m pip install opencv-python -i https://pypi.tuna.tsinghua.edu.cn/simple

[GJJ] 提示: 安装后请重启 ComfyUI 服务器
================================================================================
```

### 3. 前端错误事件

对于需要在节点面板中显示错误的情况，还需要发送事件到前端：

```python
try:
    from server import PromptServer
    PromptServer.instance.send_sync("gjj_my_node_error", {
        "node": str(unique_id),
        "error": error_msg,
        "install_command": install_command,
    })
except Exception:
    pass
```

---

## 🔄 待改造的文件清单

以下文件仍需在后续改造中处理：

### 高优先级（常用节点）
- [ ] `gjj_latentsync_node.py` - LatentSync 唇形同步
- [ ] `gjj_cosyvoice3_runtime.py` - CosyVoice3 TTS
- [ ] `gjj_local_lipsync.py` - 本地唇形同步
- [ ] `gjj_lazy_image_studio.py` - 懒加载图像工作室

### 中优先级（功能节点）
- [ ] `gjj_face_analysis.py` - 人脸分析（已在之前改造过部分）
- [ ] `gjj_batch_text_segmenter.py` - 批量文本分段（已在之前改造过）
- [ ] `gjj_audio_timestamp_editor.py` - 音频时间戳编辑器（已在之前改造过）

### 低优先级（辅助节点）
- [ ] 其他使用 `cv2`、`soundfile`、`insightface` 等的节点

---

## 📝 改造步骤总结

### 步骤 1：识别启动时导入

搜索文件顶部的 `import` 语句：
```bash
grep "^import \(cv2\|soundfile\|insightface\)" nodes/*.py
```

### 步骤 2：移除顶部导入

删除文件顶部的 `import` 语句。

### 步骤 3：添加加载函数

根据依赖数量选择模式 1、2 或 3，添加 `_load_dependencies()` 或 `_load_xxx()` 函数。

### 步骤 4：在使用处调用

在需要使用依赖的函数开头添加加载调用：
```python
def my_function(self, ...):
    try:
        cv2 = _load_cv2()  # 或 cv2, hydra = _load_dependencies()
        # 后续逻辑...
    except Exception as exc:
        raise RuntimeError(f"依赖加载失败：{exc}") from exc
```

### 步骤 5：测试验证

1. 重启 ComfyUI
2. 确认启动时间缩短
3. 执行节点，验证依赖加载正常
4. 模拟依赖缺失，验证错误提示友好

---

## 🎉 预期收益

### 性能提升
- **启动时间**：从 30+秒 → <5秒（提升 **83%**）
- **内存占用**：减少约 200-500MB（未使用的模块不加载）

### 用户体验
- ✅ 更快的 ComfyUI 启动速度
- ✅ 清晰的依赖缺失提示
- ✅ 一键复制安装命令
- ✅ 彩色控制台输出

### 维护性
- ✅ 统一的依赖加载机制
- ✅ 标准化的错误提示格式
- ✅ 易于扩展新节点

---

## 📚 相关文档

- [`SKILL/07-general-guides/runtime_dependency_loading_guide.md`](../SKILL/07-general-guides/runtime_dependency_loading_guide.md) - 运行时依赖加载指南
- [`SKILL/07-general-guides/error_presentation_spec.md`](../SKILL/07-general-guides/error_presentation_spec.md) - 错误提示实现规范
- [`nodes/common_utils/dependency_checker.py`](../nodes/common_utils/dependency_checker.py) - 依赖检查工具

---

**最后更新**：2026-05-07  
**改造进度**：5/20 文件完成（25%）

---

## 🆕 最新动态列表改造

### `nodes/gjj_lazy_image_studio.py` - 🖼️ 懒人图文集成一键生图

**问题**：LoRA 列表在启动时生成，新增 LoRA 后需要重启 ComfyUI 才能看到。

**改造前**：
```python
@classmethod
def INPUT_TYPES(cls):
    # ... 其他模型列表 ...
    lora_models = [""] + (_safe_filename_list("loras") or [])
    # ⬆️ _safe_filename_list 只在模块加载时执行一次
```

**改造后**：
```python
@classmethod
def INPUT_TYPES(cls):
    # ... 其他模型列表 ...
    
    # 实时动态生成 LoRA 列表（每次调用 INPUT_TYPES 时重新扫描）
    try:
        lora_list = folder_paths.get_filename_list("loras")
        lora_models = [""] + sorted(lora_list) if lora_list else [""]
    except Exception:
        lora_models = [""]
```

**同时在 execute() 中也使用实时列表**：
```python
def create_image(self, ...):
    try:
        # 实时动态生成 LoRA 列表（与 INPUT_TYPES 保持一致）
        try:
            lora_list = folder_paths.get_filename_list("loras")
            lora_models = sorted(lora_list) if lora_list else []
        except Exception:
            lora_models = []
        # ... 后续逻辑
```

**关键改进**：
- ✅ 每次打开节点面板时都会重新扫描 `models/loras` 目录
- ✅ 新增 LoRA 后无需重启 ComfyUI
- ✅ 使用 `folder_paths.get_filename_list("loras")` 官方 API
- ✅ 添加了异常保护，确保即使扫描失败也不会崩溃
- ✅ 列表已排序，便于查找
