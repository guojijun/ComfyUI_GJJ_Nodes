# GJJ 节点运行时依赖加载指南

## 🎯 目标

**消除所有启动时依赖检查**，改为**运行时按需加载**，大幅缩短 ComfyUI 启动时间。

---

##  问题分析

### 当前问题
- ❌ 启动时扫描17个CLIP模型
- ❌ 启动时检查所有 Python 依赖
- ❌ 启动时导入所有模块（cv2, soundfile, insightface等）
- ❌ 启动时加载 SAM3、Face Analysis 等重型模块

### 改造后效果
- ✅ 启动时间从 30+秒 缩短到 <5秒
- ✅ 只在节点执行时才加载对应依赖
- ✅ 缺失依赖时提供友好提示和一键安装命令
- ✅ 不影响已安装依赖的节点正常运行

---

## 🏗️ 通用方案

### 使用 `load_dependency_at_runtime()` 函数

**位置**：`nodes/common_utils/dependency_checker.py`

**用法**：
```python
from .common_utils.dependency_checker import load_dependency_at_runtime

# 在需要依赖的函数内部调用
def my_function():
    # 运行时加载 cv2
    cv2 = load_dependency_at_runtime(
        module_name="cv2",
        node_name="GJJ · 我的节点",
        package_name="opencv-python",  # pip 包名（可选）
        description="该节点需要 OpenCV 进行图像处理",
        extra_packages=["opencv-contrib-python"]  # 额外包（可选）
    )
    
    # 使用 cv2...
    result = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
```

### 核心优势

1. **缓存机制**：首次加载后缓存，后续直接返回
2. **友好提示**：控制台彩色输出 + 详细错误信息
3. **自动安装命令**：使用实际 Python 路径 + 清华源
4. **统一规范**：所有节点使用相同错误提示风格

---

##  改造步骤

### 步骤1：移除启动时导入

**改造前**：
```python
import cv2
import soundfile as sf
import insightface
```

**改造后**：
```python
# 移除顶部的导入，改为在函数内部加载
# import cv2  # 删除
# import soundfile as sf  # 删除
# import insightface  # 删除
```

### 步骤2：在函数内部加载

**改造前**：
```python
def process_image(image):
    result = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    return result
```

**改造后**：
```python
from .common_utils.dependency_checker import load_dependency_at_runtime

def process_image(image):
    cv2 = load_dependency_at_runtime(
        module_name="cv2",
        node_name="GJJ · 我的节点",
        package_name="opencv-python",
        description="该节点需要 OpenCV 进行图像处理"
    )
    
    result = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    return result
```

### 步骤3：特殊模块处理

#### 3.1 soundfile
```python
from .common_utils.dependency_checker import load_dependency_at_runtime

def _load_audio(filepath):
    sf = load_dependency_at_runtime(
        module_name="soundfile",
        node_name="GJJ · 音频分段编辑器",
        description="该节点需要 soundfile 读写音频文件"
    )
    
    data, sample_rate = sf.read(filepath)
    return data, sample_rate
```

#### 3.2 cv2 (OpenCV)
```python
def process_with_opencv(image):
    cv2 = load_dependency_at_runtime(
        module_name="cv2",
        node_name="GJJ · 图像处理",
        package_name="opencv-python",
        description="该节点需要 OpenCV 进行图像处理",
        extra_packages=["opencv-contrib-python"]
    )
    
    # 使用 cv2...
```

#### 3.3 insightface (Face Analysis)
```python
def load_face_model():
    insightface = load_dependency_at_runtime(
        module_name="insightface",
        node_name="GJJ · 人脸分析",
        package_name="insightface",
        description="该节点需要 insightface 进行人脸识别",
        extra_packages=["onnxruntime-gpu"]
    )
    
    from insightface.app import FaceAnalysis
    app = FaceAnalysis()
    return app
```

#### 3.4 scipy
```python
def process_audio(audio):
    from scipy import signal
    signal = load_dependency_at_runtime(
        module_name="scipy",
        node_name="GJJ · 音频处理",
        description="该节点需要 scipy 进行信号处理"
    )
    
    filtered = signal.lfilter(b, a, audio)
    return filtered
```

---

##  节点改造示例

### 示例1：GJJ_LocalLipSync

**改造前**（启动时导入）：
```python
# import cv2  # 在函数内部延迟导入
import numpy as np
# import soundfile as sf  # 在函数内部延迟导入
from scipy import signal as sp_signal
```

**改造后**（完全移除）：
```python
import numpy as np
# 完全移除 scipy 的启动时导入

from .common_utils.dependency_checker import load_dependency_at_runtime
```

**在函数中使用**：
```python
def process_lipsync(video_path, audio_path):
    # 运行时加载 scipy
    sp_signal = load_dependency_at_runtime(
        module_name="scipy.signal",
        node_name="GJJ · 本地口型同步",
        package_name="scipy",
        description="该节点需要 scipy 进行音频信号处理"
    )
    
    # 使用 sp_signal...
    filtered_audio = sp_signal.lfilter(b, a, audio)
```

### 示例2：GJJ_FaceAnalysis

**改造前**（启动时 try/except）：
```python
try:
    import insightface
    from insightface.app import FaceAnalysis
    # ... 设置 PROVIDERS
    REACTOR_AVAILABLE = True
except ImportError as e:
    REACTOR_AVAILABLE = False
    PROVIDERS = ["CPUExecutionProvider"]
    _IMPORT_ERROR = str(e)
```

**改造后**（完全移除启动检查）：
```python
# 完全移除启动时的 try/except
# 在需要时加载

from .common_utils.dependency_checker import load_dependency_at_runtime

def _load_face_analysis_model():
    insightface = load_dependency_at_runtime(
        module_name="insightface",
        node_name="GJJ · 人脸分析",
        package_name="insightface",
        description="该节点需要 insightface 进行人脸识别",
        extra_packages=["onnxruntime-gpu"]
    )
    
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(providers=['CUDAExecutionProvider'])
    return app
```

### 示例3：GJJ_BatchTextSegmenter

**改造前**（启动时导入翻译模块）：
```python
try:
    from ..utils.tsv_translation import translate_text_to_english, translate_to_english
except Exception:
    from utils.tsv_translation import translate_text_to_english, translate_to_english
```

**改造后**（按需导入）：
```python
# 在需要翻译的函数中导入
def _translate_target(target):
    try:
        from ..utils.tsv_translation import translate_to_english
    except ImportError:
        from utils.tsv_translation import translate_to_english
    
    return translate_to_english(target)
```

---

## ⚙️ 特殊场景处理

### 场景1：模块级全局常量

**问题**：有些节点在模块顶部定义全局常量需要依赖。

**解决方案**：延迟初始化

**改造前**：
```python
import cv2

# 全局常量
COLOR_MAP = {
    "red": cv2.COLOR_RGB2BGR,
    "blue": cv2.COLOR_RGB2HSV,
}
```

**改造后**：
```python
# 全局变量（初始为空）
_COLOR_MAP = None

def _get_color_map():
    global _COLOR_MAP
    if _COLOR_MAP is not None:
        return _COLOR_MAP
    
    cv2 = load_dependency_at_runtime(
        module_name="cv2",
        node_name="GJJ · 颜色处理",
        package_name="opencv-python"
    )
    
    _COLOR_MAP = {
        "red": cv2.COLOR_RGB2BGR,
        "blue": cv2.COLOR_RGB2HSV,
    }
    return _COLOR_MAP
```

### 场景2：类初始化需要依赖

**改造前**：
```python
import cv2

class MyNode:
    def __init__(self):
        self.processor = cv2.CascadeClassifier('face.xml')
```

**改造后**：
```python
from .common_utils.dependency_checker import load_dependency_at_runtime

class MyNode:
    def __init__(self):
        self._processor = None
    
    def _get_processor(self):
        if self._processor is not None:
            return self._processor
        
        cv2 = load_dependency_at_runtime(
            module_name="cv2",
            node_name="GJJ · 人脸检测",
            package_name="opencv-python"
        )
        
        self._processor = cv2.CascadeClassifier('face.xml')
        return self._processor
    
    def detect_faces(self, image):
        processor = self._get_processor()
        return processor.detectMultiScale(image)
```

### 场景3：INPUT_TYPES 需要依赖

**问题**：`INPUT_TYPES()` 需要扫描模型文件列表。

**解决方案**：改为动态列表（空列表启动，运行时填充）

**改造前**：
```python
import os

class MyNode:
    @classmethod
    def INPUT_TYPES(cls):
        models = cls._scan_models()  # 启动时扫描
        return {"required": {"model": (models,)}}
    
    @classmethod
    def _scan_models(cls):
        # 扫描文件夹...
        return ["model1", "model2"]
```

**改造后**：
```python
class MyNode:
    @classmethod
    def INPUT_TYPES(cls):
        # 启动时返回空列表或默认值
        return {"required": {"model": (["加载中..."],)}}
    
    def execute(self, model, ...):
        # 运行时再扫描
        if model == "加载中...":
            models = self._scan_models()
            # 提示用户重新选择
            raise RuntimeError(f"请选择模型：{', '.join(models)}")
        
        # 正常使用...
```

---

## 📋 改造清单

### 需要改造的节点

| 节点文件 | 依赖模块 | 优先级 |
|---------|---------|-------|
| `gjj_face_analysis.py` | insightface, onnxruntime | 🔴 高 |
| `gjj_local_lipsync.py` | cv2, scipy, soundfile | 🔴 高 |
| `gjj_latentsync_node.py` | cv2, torchcodec | 🔴 高 |
| `gjj_audio_timestamp_editor.py` | soundfile | ✅ 已完成 |
| `gjj_batch_text_segmenter.py` | SAM3 vendor | ✅ 已完成 |
| `gjj_lazy_image_studio.py` | EmptySD3LatentImage | 🟡 中 |
| `gjj_fish_audio_*.py` | fish-audio相关 | 🟡 中 |
| `gjj_cosyvoice3_*.py` | cosyvoice相关 | 🟡 中 |

### 改造优先级

1. **🔴 高优先级**：启动时明显卡顿的节点（Face Analysis, LocalLipSync, LatentSync）
2. **🟡 中优先级**：有 try/except 但影响较小的节点
3. **🟢 低优先级**：依赖已按需加载的节点

---

## ✅ 验证步骤

### 1. 启动时间测试
```bash
# 改造前
python main.py --listen  # 记录启动时间

# 改造后
python main.py --listen  # 对比启动时间
```

### 2. 依赖缺失测试
```bash
# 卸载某个依赖
pip uninstall opencv-python

# 运行使用该依赖的节点
# 检查是否显示友好的错误提示和安装命令
```

### 3. 正常功能测试
```bash
# 确保所有依赖已安装
pip install -r requirements.txt

# 测试各节点功能
# 确保改造后功能正常
```

---

##  错误提示效果

### 控制台输出（彩色）
```
================================================================================
  GJJ 节点运行时依赖缺失！
================================================================================
[GJJ] 节点: GJJ · 人脸分析
[GJJ] 缺失依赖: insightface
[GJJ] 该节点需要 insightface 进行人脸识别

[GJJ] 快速安装命令:
  D:\AI\CUI\python_embeded\python.exe -m pip install insightface onnxruntime-gpu -i https://pypi.tuna.tsinghua.edu.cn/simple

[GJJ] 提示: 安装后请重启 ComfyUI 服务器
================================================================================
```

### 节点面板（前端）
```
❌ 执行失败：

 未找到 insightface 运行库。

这个 GJJ 节点需要 insightface Python 包才能运行。

 必需依赖（请安装）：
 • insightface (人脸识别库)
 • onnxruntime-gpu (GPU加速)

🔧 快速安装命令（使用实际 Python 路径）：
D:\AI\CUI\python_embeded\python.exe -m pip install insightface onnxruntime-gpu -i https://pypi.tuna.tsinghua.edu.cn/simple

原始导入错误：No module named 'insightface'

 提示：安装后请重启 ComfyUI 服务器。

🔧 快速安装命令（点击按钮复制）：
[📋 复制安装命令]  ← 红色按钮
```

---

## 📚 参考资料

- 规范文档：`SKILL/07-general-guides/error_presentation_spec.md`
- 工具函数：`nodes/common_utils/dependency_checker.py`
- 参考实现：
  - `nodes/gjj_audio_timestamp_editor.py` (soundfile)
  - `nodes/gjj_sam3_runtime.py` (SAM3 vendor)
  - `nodes/gjj_qwen3_asr_text_formats.py` (qwen-asr)

---

##  更新记录

| 日期 | 版本 | 更新内容 |
|------|------|---------|
| 2026-05-07 | 1.0 | 初始版本，定义运行时依赖加载规范 |
