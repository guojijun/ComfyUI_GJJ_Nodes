# GJJ_FaceAnalysis 节点 - 添加 INSwapper 换脸模型支持

##  问题根源

vendor 中的 insightface 是**精简版**，缺少换脸模型（INSwapper）的实现，导致：

```
AttributeError: 'ArcFaceONNX' object has no attribute 'get'
```

当加载 inswapper_128.onnx 时，它被错误地识别为 ArcFaceONNX 模型，而 ArcFaceONNX 没有 [get()](file://d:\AI\CUI\python_embeded\Lib\site-packages\onnx\checker.py#L79-L88) 方法用于换脸。

##  解决方案

### 1. 创建 INSwapper 模型类

创建了 `vendor/insightface/model_zoo/inswapper.py`，实现完整的换脸功能：

```python
class INSwapper():
    def __init__(self, model_file=None, session=None):
        # 加载 ONNX 模型
        # 提取 embedding 映射表
        # 初始化输入输出
        
    def get(self, img, target_face, source_face, paste_back=True):
        # 执行换脸操作
        # 返回换脸后的图像
        
    def get_input(self, img, target_face):
        # 裁剪和对齐目标人脸
        
    def get_affine_matrix(self, target_face):
        # 计算仿射变换矩阵
```

### 2. 修改路由逻辑

在 `vendor/insightface/model_zoo/model_zoo.py` 中添加对换脸模型的识别：

```python
# 优先级 1：INSwapper 换脸模型
if len(inputs) == 2 and input_shape[2] == 128 and input_shape[3] == 128:
    return INSwapper(model_file=self.onnx_file, session=session)

# 优先级 2：SCRFD 检测模型
elif len(outputs) >= 5:
    return SCRFD(...)

# 优先级 3：ArcFace 识别模型
elif input_shape[2] is not None and input_shape[3] is not None:
    return ArcFaceONNX(...)
```

### 3. 导入 INSwapper

在 model_zoo.py 的导入部分添加：

```python
from .inswapper import INSwapper
```

##  模型识别逻辑

### INSwapper 换脸模型特征

- **输入数量**：2（图像 + 源人脸 embedding）
- **输入尺寸**：128x128
- **输出数量**：1
- **输出形状**：[1, 3, 128, 128]

### SCRFD 检测模型特征

- **输入数量**：1
- **输出数量**：>= 5
- **输出形状**：多个检测框和关键点

### ArcFace 识别模型特征

- **输入数量**：1
- **输出数量**：1
- **输入尺寸**：112x112 或其他固定尺寸

##  预期日志输出

重启后应该看到：

```
[GJJ ModelRouter] 🔍 开始加载模型: ...\inswapper_128.onnx
[GJJ ModelRouter] 📊 输入数量: 2
[GJJ ModelRouter] 📊 输入形状: [1, 3, 128, 128]
[GJJ ModelRouter] 📊 输出数量: 1
[GJJ ModelRouter] ✅ 识别为 INSwapper 换脸模型 (输入数量: 2, 尺寸: 128x128)
inswapper-shape: [1, 3, 128, 128]

[GJJ ModelRouter] 🔍 开始加载模型: ...\det_10g.onnx
[GJJ ModelRouter] 📊 输出数量: 9
[GJJ ModelRouter] ✅ 识别为 SCRFD 检测模型

[GJJ ModelRouter] 🔍 开始加载模型: ...\w600k_r50.onnx
[GJJ ModelRouter] 📊 输入尺寸: 112x112
[GJJ ModelRouter]  识别为 ArcFace 识别模型

[GJJ FaceAnalysis] ✅ 成功加载模型: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l
set det-size: (640, 640)
```

**关键验证点**：
✅ 看到 `✅ 识别为 INSwapper 换脸模型`  
✅ 看到 `inswapper-shape: [1, 3, 128, 128]`  
✅ 没有看到 `AttributeError: 'ArcFaceONNX' object has no attribute 'get'`  
✅ 换脸节点正常执行并输出结果

##  相关文档

- 📄 [gjj_face_analysis_model_selection_fix.md](gjj_face_analysis_model_selection_fix.md) - 模型选择修复
- 📄 [MODULE_CACHE_CLEARING.md](../MODULE_CACHE_CLEARING.md) - 模块缓存清除机制

---

**修复状态**: ✅ 已完成  
**代码修改**: ✅ vendor/insightface/model_zoo/inswapper.py (新建)  
**路由逻辑**: ✅ 已添加 INSwapper 识别  
**缓存清除**: ✅ 已完成  
**下一步**: 🔄 **重启 ComfyUI**（必须！）
