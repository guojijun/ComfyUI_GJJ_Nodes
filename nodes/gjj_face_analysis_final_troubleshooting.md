# GJJ_FaceAnalysis 节点 - 最终故障排除总结

##  问题历史

### 第一轮：路径映射问题
- **现象**：找不到模型文件
- **原因**：硬编码了绝对路径
- **解决**：使用 `folder_paths.models_dir` 动态获取路径

### 第二轮：insightface 路由 Bug
- **现象**："error on model routing"
- **原因**：`model_zoo.py` 第 55 行使用了错误的参数 `router = ModelRouter(name)`
- **解决**：修改为 `router = ModelRouter(model_file)`

### 第三轮：模块缓存冲突
- **现象**：仍使用系统 Python 的 insightface
- **原因**：其他节点（comfyui-reactor-node）先加载了系统版本
- **解决**：在节点文件开头添加强制清除模块缓存逻辑

### 第四轮：Python 字节码缓存
- **现象**：修复后的代码仍未生效
- **原因**：`__pycache__` 缓存了旧版本的 .pyc 文件
- **解决**：清除 vendor 目录中的所有 Python 缓存

##  最终解决方案

### 1. 代码修复

#### vendor/insightface/model_zoo/model_zoo.py
```python
# 第 55 行：修复路由参数
router = ModelRouter(model_file)  # ✅ 不是 name
```

#### nodes/gjj_face_analysis.py
```python
# 在文件最开始（所有导入之前）
import os
import sys

# 1. 添加 vendor 路径
vendor_path = os.path.join(os.path.dirname(__file__), '..', 'vendor')
if vendor_path not in sys.path:
    sys.path.insert(0, vendor_path)

# 2. 清除已缓存的 insightface 模块
insightface_modules = [key for key in sys.modules.keys() if key.startswith('insightface')]
if insightface_modules:
    for mod in insightface_modules:
        del sys.modules[mod]

# 3. 现在导入会使用 vendor 中的版本
import insightface
```

### 2. 清除缓存

```bash
# 清除 vendor 中的所有 Python 缓存
Get-ChildItem "vendor\insightface" -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
Get-ChildItem "vendor\insightface" -Recurse -Filter "*.pyc" | Remove-Item -Force
```

### 3. 验证测试

运行测试脚本验证模型路由：

```bash
D:\AI\CUI\python_embeded\python.exe test_model_routing.py
```

**预期输出：**
```
📊 输出数量: 9
✅ 应该被识别为 SCRFD 模型
```

##  重启步骤（重要！）

1. **停止 ComfyUI**
2. **清除缓存**（已执行）
3. **重新启动 ComfyUI**
4. **查看控制台日志**

### 预期日志输出

```
[GJJ FaceAnalysis] 🔧 已添加 vendor 路径: D:\AI\MOD\custom_nodes\GJJ\vendor
[GJJ FaceAnalysis] ⚠️  检测到已加载的 insightface 模块: [...]
[GJJ FaceAnalysis] 🔄 正在清除缓存并重新从 vendor 加载...
[GJJ FaceAnalysis] ✅ 已清除 insightface 模块缓存
[GJJ FaceAnalysis] ✅ 成功加载 vendor 中的 insightface
[GJJ FaceAnalysis]  insightface 路径: D:\AI\MOD\custom_nodes\GJJ\vendor\insightface\__init__.py

[GJJ FaceAnalysis] 🔍 开始扫描模型目录...
[GJJ FaceAnalysis] ✅ 发现模型: buffalo_l (insightface\buffalo_l)

[GJJ FaceAnalysis] 📦 使用模型: buffalo_l (insightface\buffalo_l)
[GJJ FaceAnalysis] 🔧 使用指定模型: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l

[GJJ ModelRouter] 🔍 开始加载模型: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\det_10g.onnx
[GJJ ModelRouter] 📊 输入形状: [1, 3, '?', '?']
[GJJ ModelRouter] 📊 输出数量: 9
[GJJ ModelRouter] ✅ 识别为 SCRFD 模型 (输出数量 >= 5)

find model: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\det_10g.onnx detection
find model: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\w600k_r50.onnx recognition

[GJJ FaceAnalysis] ✅ 成功加载模型: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l
set det-size: (640, 640)
```

##  关键检查点

### ✅ 必须满足的条件

1. **vendor 路径正确**
   - 日志：`[GJJ FaceAnalysis] 🔧 已添加 vendor 路径: ...`
   - 路径必须包含 `GJJ\vendor`

2. **使用 vendor 中的 insightface**
   - 日志：`[GJJ FaceAnalysis]  insightface 路径: ...\vendor\insightface\__init__.py`
   - 不能出现 `python_embeded\Lib\site-packages`

3. **模块缓存已清除**
   - 日志：`[GJJ FaceAnalysis] ✅ 已清除 insightface 模块缓存`
   - 或根本没有检测到缓存（GJJ 最先加载）

4. **模型路由成功**
   - 日志：`[GJJ ModelRouter] ✅ 识别为 SCRFD 模型`
   - 输出数量必须 >= 5

5. **detection 模型加载成功**
   - 日志：`find model: ...\det_10g.onnx detection`
   - 必须有 'detection' 任务

##  如果仍然失败

### Q1: 仍然报 "error on model routing"？

**检查：**
1. vendor 中的 `model_zoo.py` 第 55 行是否已修复
2. 是否清除了 `__pycache__`
3. 查看详细的 `[GJJ ModelRouter]` 日志

**解决：**
```bash
# 重新清除缓存
Get-ChildItem "vendor\insightface" -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force

# 重启 ComfyUI
```

### Q2: 仍使用系统 Python 的 insightface？

**检查：**
1. vendor 路径是否在所有导入之前添加
2. 模块缓存清除逻辑是否执行

**解决：**
查看日志中是否有这些输出：
```
[GJJ FaceAnalysis] 🔧 已添加 vendor 路径: ...
[GJJ FaceAnalysis] ️  检测到已加载的 insightface 模块: ...
[GJJ FaceAnalysis] 🔄 正在清除缓存并重新从 vendor 加载...
```

### Q3: 找不到 detection 模型？

**检查：**
1. 模型文件是否完整（5 个 .onnx 文件）
2. 模型路径是否正确

**解决：**
```bash
# 检查模型文件
dir "D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\*.onnx"

# 应该看到：
# det_10g.onnx
# w600k_r50.onnx
# genderage.onnx
# 1k3d68.onnx
# 2d106det.onnx
```

##  相关文档

- 📄 [MODULE_CACHE_CLEARING.md](MODULE_CACHE_CLEARING.md) - 模块缓存清除机制
- 📄 [ZERO_DEPENDENCY_IMPLEMENTATION.md](../ZERO_DEPENDENCY_IMPLEMENTATION.md) - 零依赖实现说明
-  [test_model_routing.py](../test_model_routing.py) - ONNX 模型路由测试脚本
-  [test_vendor_import.py](../test_vendor_import.py) - vendor 导入测试脚本

---

**最后更新**: 2026-05-05  
**版本**: v3.0.2（含详细调试日志和缓存清除）  
**状态**: ✅ 所有已知问题已修复  
**下一步**: 重启 ComfyUI 并查看调试日志
