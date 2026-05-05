# GJJ_FaceAnalysis 节点 - 模型选择问题最终解决方案

##  问题根源

您的模型目录包含多个识别模型：
- **1k3d68.onnx**（192x192）- 非标准模型
- **w600k_r50.onnx**（112x112）- 标准 buffalo_l 识别模型

由于按字母排序，**1k3d68.onnx** 先被加载为 `recognition` 模型，但其输入尺寸是 192x192，而实际输入的图像是 112x112，导致断言失败：

```python
assert input_size==self.input_size  # (112, 112) == (192, 192) 
```

##  解决方案

修改了 `FaceAnalysis.__init__()` 逻辑，**优先选择 112x112 的标准识别模型**：

```python
# 记录所有识别模型
recognition_models = []

for onnx_file in onnx_files:
    model = model_zoo.get_model(onnx_file)
    if model.taskname == 'recognition':
        recognition_models.append((onnx_file, model))

# 优先选择 112x112 的标准模型
if recognition_models:
    preferred_model = None
    for onnx_file, model in recognition_models:
        if model.input_size == (112, 112):
            preferred_model = (onnx_file, model)
            print(f"✅ 选择标准识别模型 (112x112): {onnx_file}")
            break
    
    # 如果没有 112x112 的，使用第一个
    if preferred_model is None:
        preferred_model = recognition_models[0]
        print(f"⚠️  使用非标准识别模型: {preferred_model[0]}")
    
    self.models['recognition'] = preferred_model[1]
```

##  预期日志输出

重启后应该看到：

```
[GJJ ModelRouter] 🔍 开始加载模型: ...\1k3d68.onnx
[GJJ ModelRouter]  输入尺寸: 192x192
[GJJ FaceAnalysis]  找到识别模型: ...\1k3d68.onnx (输入尺寸: (192, 192))

[GJJ ModelRouter] 🔍 开始加载模型: ...\det_10g.onnx
[GJJ ModelRouter]  识别为 SCRFD 检测模型
[GJJ FaceAnalysis] ✅ 找到模型: ...\det_10g.onnx -> detection

[GJJ ModelRouter] 🔍 开始加载模型: ...\w600k_r50.onnx
[GJJ ModelRouter]  输入尺寸: 112x112
[GJJ FaceAnalysis] 📝 找到识别模型: ...\w600k_r50.onnx (输入尺寸: (112, 112))

[GJJ FaceAnalysis] ✅ 选择标准识别模型 (112x112): ...\w600k_r50.onnx

[GJJ FaceAnalysis] ✅ 成功加载模型: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l
set det-size: (640, 640)
```

**关键验证点**：
✅ 看到 `✅ 选择标准识别模型 (112x112): ...w600k_r50.onnx`  
✅ 看到 `set det-size: (640, 640)`  
✅ 没有看到 `AssertionError`  
✅ 换脸节点正常执行

##  相关文档

- 📄 [gjj_face_analysis_final_fix.md](gjj_face_analysis_final_fix.md) - 之前的路由逻辑修复
- 📄 [MODULE_CACHE_CLEARING.md](../MODULE_CACHE_CLEARING.md) - 模块缓存清除机制

---

**修复状态**: ✅ 已完成  
**代码修改**: ✅ vendor/insightface/app/face_analysis.py  
**缓存清除**: ✅ 已完成  
**下一步**: 🔄 **重启 ComfyUI**（必须！）
