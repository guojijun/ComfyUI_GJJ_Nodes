# GJJ_FaceAnalysis 节点 - "error on model routing" 故障排除

##  问题描述

错误信息：
```
RuntimeError: 从指定路径 D:\AI\CUI\ComfyUI\models\insightface\buffalo_l 加载失败: error on model routing
```

## 🔍 根本原因

这是 **insightface 库的一个已知 bug**，位于 `model_zoo/model_zoo.py` 第 54 行：

```python
def get_model(name, **kwargs):
    # ...
    router = ModelRouter(name)  # ← Bug：应该用 model_file 而不是 name
    model = router.get_model()
```

当 [name](file://d:\AI\CUI\ComfyUI\custom_nodes\comfyui-lora-selector\pysssss-workflows-workflow.py#L296-L296) 参数是完整的 ONNX 文件路径时，这个 bug 会导致模型路由失败。

## ✅ 解决方案

### 方案 1：确保使用正确的参数格式（推荐）

我们的节点已经修复了这个问题，确保传递正确的参数：

```python
# ✅ 正确：传递目录名和父目录
FaceAnalysis(
    name="buffalo_l",  # 目录名，不是完整路径
    root="D:\AI\CUI\ComfyUI\models\insightface"  # 父目录
)

#  错误：传递完整路径
FaceAnalysis(
    name="D:\AI\CUI\ComfyUI\models\insightface\buffalo_l",  # 完整路径会导致 bug
    root="..."
)
```

### 方案 2：修复 insightface 库（高级）

如果您想彻底修复这个 bug，可以修改 insightface 源码：

**文件位置：**
```
D:\AI\CUI\python_embeded\Lib\site-packages\insightface\model_zoo\model_zoo.py
```

**修改第 54 行：**
```python
# 修改前（有 bug）
router = ModelRouter(name)

# 修改后（修复）
router = ModelRouter(model_file)
```

### 方案 3：升级 insightface（如果可用）

检查是否有新版本修复了这个 bug：

```bash
pip show insightface
pip install --upgrade insightface
```

## 🔧 调试步骤

### 1. 启用详细日志

重启 ComfyUI 后，控制台会输出详细的调试信息：

```
[GJJ FaceAnalysis] 🔧 使用指定模型: D:\AI\CUI\ComfyUI\models\insightface\buffalo_l
[GJJ FaceAnalysis] 📂 父目录: D:\AI\CUI\ComfyUI\models\insightface
[GJJ FaceAnalysis] 模型名称: buffalo_l
[GJJ FaceAnalysis] 开始初始化 FaceAnalysis...
[GJJ FaceAnalysis] 参数: name='buffalo_l', root='D:\AI\CUI\ComfyUI\models\insightface'
```

**检查点：**
- ✅ [name](file://d:\AI\CUI\ComfyUI\custom_nodes\comfyui-lora-selector\pysssss-workflows-workflow.py#L296-L296) 应该是 `buffalo_l`（目录名）
- ✅ `root` 应该是 `D:\AI\CUI\ComfyUI\models\insightface`（父目录）
- ❌ 如果 [name](file://d:\AI\CUI\ComfyUI\custom_nodes\comfyui-lora-selector\pysssss-workflows-workflow.py#L296-L296) 包含完整路径，说明代码有问题

### 2. 验证模型文件

检查模型文件是否完整且未损坏：

```bash
# 检查文件大小
cd "D:\AI\CUI\ComfyUI\models\insightface\buffalo_l"
Get-ChildItem *.onnx | Select-Object Name, Length

# 预期大小：
# det_10g.onnx      ~16 MB
# w600k_r50.onnx    ~166 MB
# genderage.onnx    ~1.2 MB
# 1k3d68.onnx       ~137 MB
# 2d106det.onnx     ~4.8 MB
```

### 3. 测试 ONNX 模型

手动测试 ONNX 模型是否可以加载：

```python
import onnxruntime as ort

# 测试检测模型
session = ort.InferenceSession("det_10g.onnx")
print(f"输入: {session.get_inputs()[0].shape}")
print(f"输出数量: {len(session.get_outputs())}")

# 应该输出：
# 输入: [1, 3, '?', '?']
# 输出数量: 9
```

### 4. 检查 insightface 版本

```python
import insightface
print(f"insightface 版本: {insightface.__version__}")

# 预期：0.7.x 或更高版本
```

## 📊 常见错误对照表

| 错误信息 | 原因 | 解决方法 |
|---------|------|---------|
| `error on model routing` | insightface bug 或参数格式错误 | 确保 [name](file://d:\AI\CUI\ComfyUI\custom_nodes\comfyui-lora-selector\pysssss-workflows-workflow.py#L296-L296) 是目录名，不是完整路径 |
| `assert 'detection' in self.models` | 模型文件缺失或损坏 | 重新下载 buffalo_l 模型 |
| `model should be file` | ONNX 文件不存在 | 检查路径是否正确 |
| `Failed to load model` | ONNX Runtime 版本不兼容 | 升级 onnxruntime 或 onnxruntime-gpu |

## 🚀 快速修复脚本

如果您想快速修复 insightface 的 bug，可以运行这个脚本：

```python
# fix_insightface_bug.py
import os

file_path = r"D:\AI\CUI\python_embeded\Lib\site-packages\insightface\model_zoo\model_zoo.py"

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 修复 bug
old_line = "    router = ModelRouter(name)"
new_line = "    router = ModelRouter(model_file)"

if old_line in content:
    content = content.replace(old_line, new_line)
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("✅ 已修复 insightface model_zoo bug")
else:
    print("⚠️  未找到需要修复的代码，可能已经修复或版本不同")
```

## 💡 预防措施

1. **使用节点内置的模型扫描功能**：节点会自动处理路径问题
2. **不要手动修改模型路径**：让节点自动检测和加载
3. **定期检查模型文件完整性**：确保 .onnx 文件未损坏
4. **保持 insightface 更新**：新版本可能已修复此 bug

##  仍然无法解决？

如果以上方法都无效，请收集以下信息并报告问题：

1. **完整的控制台日志**（包括调试信息）
2. **insightface 版本**：`pip show insightface`
3. **ONNX Runtime 版本**：`pip show onnxruntime`
4. **模型文件列表和大小**：`ls -lh buffalo_l/`
5. **操作系统和 Python 版本**

---

**更新日期**：2026-05-05  
**影响版本**：insightface <= 0.7.x  
**修复状态**：✅ 节点已适配 workaround
