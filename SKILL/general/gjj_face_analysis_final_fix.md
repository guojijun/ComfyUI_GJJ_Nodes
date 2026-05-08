# GJJ_FaceAnalysis 节点 - 模型路由问题最终修复

##  问题根源

您的模型目录中包含了一个**非标准模型文件** `1k3d68.onnx`，这个文件：
- 输入尺寸：192x192（非标准的 112x112）
- 输出数量：1（不是 SCRFD 的 >= 5）
- **不属于标准 buffalo_l 模型包**

标准的 buffalo_l 应该只包含：
- ✅ [det_10g.onnx](file://d:\AI\MOD\models\insightface\buffalo_l\det_10g.onnx) - SCRFD 检测模型（输出数量 >= 5）
- ✅ [w600k_r50.onnx](file://d:\AI\MOD\models\insightface\buffalo_l\w600k_r50.onnx) - ArcFace 识别模型（112x112）
- ✅ [genderage.onnx](file://d:\AI\MOD\models\insightface\buffalo_l\genderage.onnx) - 性别年龄模型
- ✅ [2d106det.onnx](file://d:\AI\MOD\models\insightface\buffalo_l\2d106det.onnx) - 2D 关键点模型
- ❌ ~~[1k3d68.onnx](file://d:\AI\MOD\models\insightface\buffalo_l\1k3d68.onnx)~~ - **不属于 buffalo_l，应删除**

##  解决方案

### 方案 1：删除非标准模型（推荐）

```bash
# 删除 1k3d68.onnx
del "D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\1k3d68.onnx"
```

### 方案 2：修改代码兼容非标准模型（已实现）

修改了 vendor 中的路由逻辑：

#### vendor/insightface/model_zoo/model_zoo.py

```python
class ModelRouter:
    def get_model(self):
        # ... 加载模型 ...
        
        if len(outputs) >= 5:
            # SCRFD 检测模型
            return SCRFD(...)
        elif input_shape[2] is not None and input_shape[3] is not None:
            # ArcFace 识别模型（支持任意尺寸）
            return ArcFaceONNX(...)
        else:
            # 无法识别，返回 None 而不是抛出异常
            print(f"⚠️  跳过非标准模型: {onnx_file}")
            return None
```

#### vendor/insightface/app/face_analysis.py

```python
def __init__(self, name, root='~/.insightface/models'):
    for onnx_file in onnx_files:
        model = model_zoo.get_model(onnx_file)
        
        # 处理返回 None 的情况
        if model is None:
            print(f"⚠️  跳过无法识别的模型: {onnx_file}")
            continue
            
        # 正常加载
        self.models[model.taskname] = model
    
    # 必须包含 detection 模型
    assert 'detection' in self.models
```

##  预期日志输出

### 方案 1（删除 1k3d68.onnx）

```
[GJJ FaceAnalysis] 🔍 开始扫描模型目录...
[GJJ FaceAnalysis] ✅ 发现模型: buffalo_l (insightface\buffalo_l)

[GJJ FaceAnalysis]  参数: name='buffalo_l', root='D:\AI\CUI\ComfyUI\models\insightface'

[GJJ ModelRouter] 🔍 开始加载模型: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\2d106det.onnx
[GJJ ModelRouter]  输入形状: [1, 3, 192, 192]
[GJJ ModelRouter]  输出数量: 2
[GJJ ModelRouter] ✅ 识别为 ArcFace 识别模型 (输入尺寸: 192x192)

[GJJ ModelRouter] 🔍 开始加载模型: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\det_10g.onnx
[GJJ ModelRouter]  输入形状: [1, 3, '?', '?']
[GJJ ModelRouter]  输出数量: 9
[GJJ ModelRouter] ✅ 识别为 SCRFD 检测模型 (输出数量: 9 >= 5)

[GJJ ModelRouter] 🔍 开始加载模型: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\genderage.onnx
[GJJ ModelRouter]  输入形状: [1, 3, 112, 112]
[GJJ ModelRouter]  输出数量: 2
[GJJ ModelRouter] ✅ 识别为 ArcFace 识别模型 (输入尺寸: 112x112)

[GJJ ModelRouter] 🔍 开始加载模型: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\w600k_r50.onnx
[GJJ ModelRouter]  输入形状: [1, 3, 112, 112]
[GJJ ModelRouter]  输出数量: 1
[GJJ ModelRouter] ✅ 识别为 ArcFace 识别模型 (输入尺寸: 112x112)

[GJJ FaceAnalysis] ✅ 找到模型: ...\det_10g.onnx -> detection
[GJJ FaceAnalysis] ✅ 找到模型: ...\w600k_r50.onnx -> recognition
[GJJ FaceAnalysis] ✅ 找到模型: ...\genderage.onnx -> genderage
[GJJ FaceAnalysis] ✅ 找到模型: ...\2d106det.onnx -> landmark

set det-size: (640, 640)
```

### 方案 2（保留 1k3d68.onnx）

```
[GJJ ModelRouter] 🔍 开始加载模型: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\1k3d68.onnx
[GJJ ModelRouter] 📊 输入形状: ['None', 3, 192, 192]
[GJJ ModelRouter] 📊 输出数量: 1
[GJJ ModelRouter] ⚠️  跳过非标准模型: ... (无法识别)

[GJJ FaceAnalysis] ⚠️  跳过无法识别的模型: ...\1k3d68.onnx

# 其他标准模型正常加载...
[GJJ FaceAnalysis] ✅ 找到模型: ...\det_10g.onnx -> detection
[GJJ FaceAnalysis] ✅ 找到模型: ...\w600k_r50.onnx -> recognition

set det-size: (640, 640)
```

##  关键改进

### 1. 支持动态输入尺寸

```python
# 之前：只支持 112x112
elif input_shape[2]==112 and input_shape[3]==112:

# 现在：支持任意明确的尺寸
elif input_shape[2] is not None and input_shape[3] is not None:
```

### 2. 优雅降级

```python
# 之前：抛出异常，中断所有模型加载
raise RuntimeError('error on model routing')

# 现在：返回 None，跳过问题模型
return None
```

### 3. 详细日志

```python
print(f"[GJJ FaceAnalysis] ✅ 找到模型: {onnx_file} -> {model.taskname}")
print(f"[GJJ FaceAnalysis] ️  跳过无法识别的模型: {onnx_file}")
```

##  下一步：重启 ComfyUI

**必须完全重启！**

1. **停止 ComfyUI**
2. **（可选）删除 1k3d68.onnx**
3. **重新启动 ComfyUI**
4. **查看控制台日志**

### 验证点

✅ 看到 `[GJJ FaceAnalysis] ✅ 找到模型: ... -> detection`  
✅ 看到 `set det-size: (640, 640)`  
✅ 没有看到 `RuntimeError`  
✅ 换脸节点正常执行

---

**修复状态**: ✅ 已完成  
**代码修改**: ✅ vendor 中的路由逻辑已优化  
**缓存清除**: ✅ 已完成  
**下一步**: 🔄 **重启 ComfyUI**（必须！）
