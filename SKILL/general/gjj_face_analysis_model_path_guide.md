# GJJ_FaceAnalysis 节点 - 模型路径调试指南

## 🎯 功能说明

为了帮助您诊断和解决 buffalo_l 模型加载问题，我们添加了**模型根路径选择器**。您可以在节点面板上手动选择不同的模型路径进行测试。

## 📋 可用的路径选项

在节点的"可选输入"中，您会看到一个新的参数：**模型根路径**

### 选项列表：

1. **自动检测**（默认）
   - 按优先级依次尝试以下路径：
     - `ComfyUI/models/` （镜像环境）
     - `ComfyUI/models/insightface/models/` （标准安装）
     - `ComfyUI/models/insightface/` （简化安装）
   - 适合大多数情况

2. **models/** 
   - 直接使用 `ComfyUI/models/buffalo_l/`
   - 适用于镜像环境或模型直接放在 models 根目录的情况

3. **models/insightface/models/**
   - 使用 `ComfyUI/models/insightface/models/buffalo_l/`
   - 适用于标准的分层目录结构

4. **models/insightface/**
   - 使用 `ComfyUI/models/insightface/buffalo_l/`
   - 适用于简化的单层目录结构

## 🔍 如何测试

### 步骤 1：确认模型文件位置

首先，检查您的模型文件实际在哪里：

```bash
# 在 PowerShell 中执行
Get-ChildItem "D:\AI\CUI\ComfyUI\models" -Recurse -Filter "*.onnx" | 
    Where-Object { $_.DirectoryName -like "*buffalo_l*" } |
    Select-Object FullName
```

**预期输出示例：**
```
FullName
--------
D:\AI\CUI\ComfyUI\models\buffalo_l\1k3d68.onnx
D:\AI\CUI\ComfyUI\models\buffalo_l\2d106det.onnx
D:\AI\CUI\ComfyUI\models\buffalo_l\det_10g.onnx
D:\AI\CUI\ComfyUI\models\buffalo_l\genderage.onnx
D:\AI\CUI\ComfyUI\models\buffalo_l\w600k_r50.onnx
```

### 步骤 2：在 ComfyUI 中测试

1. **打开 ComfyUI**
2. **添加节点**：`GJJ · 🎭 换脸分析器`
3. **连接图片**：
   - 目标图：需要换脸的图片
   - 源图：提供脸部特征的图片
4. **选择模型路径**：
   - 先尝试 **"自动检测"**
   - 如果失败，根据步骤 1 的结果选择对应的路径
5. **点击运行**
6. **查看控制台输出**

### 步骤 3：解读控制台输出

#### ✅ 成功加载示例：
```
[GJJ FaceAnalysis] 🔧 使用指定路径: D:\AI\CUI\ComfyUI\models
find model: D:\AI\CUI\ComfyUI\models\buffalo_l\det_10g.onnx detection
find model: D:\AI\CUI\ComfyUI\models\buffalo_l\w600k_r50.onnx recognition
find model: D:\AI\CUI\ComfyUI\models\buffalo_l\genderage.onnx genderage
[GJJ FaceAnalysis] ✅ 成功从 D:\AI\CUI\ComfyUI\models 加载 buffalo_l 模型
set det-size: (640, 640)
```

#### ❌ 失败示例：
```
[GJJ FaceAnalysis] 🔧 使用指定路径: D:\AI\CUI\ComfyUI\models\insightface\models
[GJJ FaceAnalysis] ❌ 从 D:\AI\CUI\ComfyUI\models\insightface\models 加载失败: ...
RuntimeError: 无法加载 buffalo_l 人脸检测模型。
请确保模型文件存在于以下目录之一：
...
```

## 🛠️ 常见问题排查

### 问题 1：所有路径都失败

**可能原因：**
- buffalo_l 文件夹名称错误（应该是 `buffalo_l`，不是 `buffalo_L` 或 `Buffalo_l`）
- 缺少关键的 `.onnx` 文件
- 文件权限问题

**解决方法：**
```bash
# 检查文件夹名称
ls "D:\AI\CUI\ComfyUI\models\" | Select-String "buffalo"

# 应该看到：buffalo_l

# 检查文件完整性
ls "D:\AI\CUI\ComfyUI\models\buffalo_l\" 

# 应该有这 5 个文件：
# 1k3d68.onnx
# 2d106det.onnx
# det_10g.onnx      ← 最关键
# genderage.onnx
# w600k_r50.onnx
```

### 问题 2：只有部分路径成功

**原因：** 不同部署方式的目录结构不同

**解决方法：** 
- 记录成功的路径
- 以后固定使用该路径选项
- 或者保持"自动检测"（它会找到第一个可用的路径）

### 问题 3：首次加载很慢

**原因：** 模型需要从磁盘加载到内存

**解决方法：**
- 这是正常现象，首次加载约需 5-15 秒
- 后续相同分辨率的图片会使用缓存，速度会快很多
- 可以重启 ComfyUI 清空缓存后重新测试

## 💡 最佳实践

### 推荐配置

根据您的环境选择合适的默认路径：

| 环境类型 | 推荐设置 | 原因 |
|---------|---------|------|
| 镜像部署 | `models/` | 模型通常在根目录 |
| 标准安装 | `自动检测` | 自动适配多种结构 |
| 自定义路径 | 对应选项 | 根据实际位置选择 |

### 性能优化

1. **GPU 加速**：
   ```bash
   pip install onnxruntime-gpu
   ```
   节点会自动检测并使用 GPU

2. **批量处理**：
   - 相同分辨率的图片会共享模型实例
   - 建议将相似尺寸的图片放在一起处理

3. **缓存利用**：
   - 节点会缓存人脸检测结果
   - 相同的图片不会重复分析

## 📊 路径对比表

| 路径选项 | 完整路径示例 | 适用场景 |
|---------|-------------|---------|
| 自动检测 | - | 通用，优先推荐 |
| models/ | `D:\AI\CUI\ComfyUI\models\buffalo_l\` | 镜像环境 |
| models/insightface/models/ | `D:\AI\CUI\ComfyUI\models\insightface\models\buffalo_l\` | 标准安装 |
| models/insightface/ | `D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\` | 简化安装 |

## 🚀 下一步

1. **重启 ComfyUI** 以加载新版本的节点
2. **打开工作流** 并添加换脸节点
3. **选择正确的路径** 并测试
4. **查看控制台** 确认加载成功
5. **享受换脸功能** 🎉

---

**更新日期**：2026-05-05  
**版本**：v2.0.4  
**维护者**：GJJ Custom Nodes Team
