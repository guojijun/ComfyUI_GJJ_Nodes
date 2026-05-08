# GJJ_FaceAnalysis 节点 - 模型扫描与路径适配说明

##  自动扫描机制

节点已实现**自动扫描**功能，会自动检测 `models/insightface` 目录下所有可用的 buffalo 模型。

### 📋 工作原理

#### 1. 路径适配

节点使用 ComfyUI 的标准路径接口：

```python
models_path = folder_paths.models_dir  # 自动获取映射后的路径
insightface_path = os.path.join(models_path, "insightface")
```

**✅ 支持所有路径映射方式：**
- extra_model_paths.yaml 配置
- 符号链接（symlink/junction）
- 自定义 models 目录
- 标准安装路径

**无需手动配置！** 节点会自动使用 ComfyUI 配置好的路径。

#### 2. 扫描逻辑

[scan_available_models()](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_face_analysis.py#L87-L143) 函数会：

1. 访问 `models/insightface/` 目录
2. 递归遍历所有子目录
3. 检测包含 buffalo 模型的文件夹（验证关键文件）：
   - `det_10g.onnx`（人脸检测）
   - `w600k_r50.onnx`（人脸识别）
4. 计算相对路径（相对于 `models/`）
5. 生成显示名称：`"buffalo_l (insightface\buffalo_l)"`

#### 3. 前端显示

在节点的"可选输入"中，您会看到：

```
人脸检测模型: [下拉菜单]
├── buffalo_l (insightface\buffalo_l)
├── buffalo_m (insightface\buffalo_m)
└── buffalo_s (insightface\buffalo_s)
```

**显示格式说明：**
- **buffalo_l** - 模型目录名
- **(insightface\buffalo_l)** - 相对于 models 的路径

#### 4. 路径解析

当用户选择模型后，[swap_faces](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_face_analysis.py#L609-L740) 方法会：

```python
# 用户选择: "buffalo_l (insightface\buffalo_l)"
rel_path = "insightface\buffalo_l"  # 提取相对路径
full_path = os.path.join(models_path, rel_path)
# 结果: D:\AI\MOD\models\insightface\buffalo_l ✅
```

## 🔍 调试日志

节点启动时会输出详细的扫描日志：

### ✅ 成功扫描示例

```
[GJJ FaceAnalysis] 🔍 开始扫描模型目录...
[GJJ FaceAnalysis]  models_path: D:\AI\MOD\models
[GJJ FaceAnalysis]  insightface_path: D:\AI\MOD\models\insightface
[GJJ FaceAnalysis]  insightface_path 存在: True
[GJJ FaceAnalysis] ✅ 发现模型: buffalo_l (insightface\buffalo_l)
[GJJ FaceAnalysis]    完整路径: D:\AI\MOD\models\insightface\buffalo_l
[GJJ FaceAnalysis]    包含文件: w600k_r50.onnx, 1k3d68.onnx, genderage.onnx, det_10g.onnx, 2d106det.onnx
[GJJ FaceAnalysis]  共找到 1 个可用模型
```

### ❌ 扫描失败示例

```
[GJJ FaceAnalysis] 🔍 开始扫描模型目录...
[GJJ FaceAnalysis] 📂 models_path: D:\AI\MOD\models
[GJJ FaceAnalysis]  insightface_path: D:\AI\MOD\models\insightface
[GJJ FaceAnalysis]  insightface_path 存在: True
[GJJ FaceAnalysis] ⚠️  未在 D:\AI\MOD\models\insightface 中找到有效的 buffalo 模型
[GJJ FaceAnalysis]  insightface 目录内容:
[GJJ FaceAnalysis]    - inswapper_128.onnx
```

**解决方案：** 需要在 `insightface` 目录下创建 `buffalo_l` 文件夹并放入模型文件。

## 📁 模型目录结构要求

### 标准结构

```
models/
└── insightface/
    ├── inswapper_128.onnx          ← 换脸模型
    └── buffalo_l/                   ← buffalo 检测模型
        ├── det_10g.onnx            ← 必需
        ├── w600k_r50.onnx          ← 必需
        ├── genderage.onnx
        ├── 1k3d68.onnx
        └── 2d106det.onnx
```

### 多模型结构

```
models/
└── insightface/
    ├── buffalo_l/
    │   ├── det_10g.onnx
    │   └── w600k_r50.onnx
    ├── buffalo_m/
    │   ├── det_10g.onnx
    │   └── w600k_r50.onnx
    └── buffalo_s/
        ├── det_10g.onnx
        ── w600k_r50.onnx
```

**节点会自动发现所有符合条件的模型！**

## 🚀 使用步骤

### 1. 确认模型位置

检查您的模型是否在正确位置：

```bash
# 根据您的实际路径调整
ls "D:\AI\MOD\models\insightface\buffalo_l\"

# 应该看到：
# det_10g.onnx
# w600k_r50.onnx
# genderage.onnx
# 1k3d68.onnx
# 2d106det.onnx
```

### 2. 重启 ComfyUI

重启后节点会自动扫描模型目录。

### 3. 查看控制台日志

在 ComfyUI 控制台查找：

```
[GJJ FaceAnalysis] 🔍 开始扫描模型目录...
[GJJ FaceAnalysis] ✅ 发现模型: buffalo_l (insightface\buffalo_l)
```

### 4. 在节点中选择模型

打开换脸节点，在"可选输入"中选择：

```
人脸检测模型: buffalo_l (insightface\buffalo_l)
```

### 5. 运行测试

连接图片并运行，查看控制台输出：

```
[GJJ FaceAnalysis] 📦 使用模型: buffalo_l (insightface\buffalo_l)
[GJJ FaceAnalysis] 📂 模型路径: D:\AI\MOD\models\insightface\buffalo_l
[GJJ FaceAnalysis] 🔧 使用指定模型: D:\AI\MOD\models\insightface\buffalo_l
[GJJ FaceAnalysis] ✅ 成功加载模型: D:\AI\MOD\models\insightface\buffalo_l
set det-size: (640, 640)
```

## 💡 常见问题

### Q1: 为什么显示"无可用模型"？

**可能原因：**
1. `models/insightface/` 目录不存在
2. 缺少 `det_10g.onnx` 或 `w600k_r50.onnx`
3. 文件夹名称拼写错误

**解决方法：**
```bash
# 检查目录是否存在
ls "D:\AI\MOD\models\insightface\"

# 检查 buffalo_l 文件夹
ls "D:\AI\MOD\models\insightface\buffalo_l\"

# 验证关键文件
test -f "D:\AI\MOD\models\insightface\buffalo_l\det_10g.onnx"
test -f "D:\AI\MOD\models\insightface\buffalo_l\w600k_r50.onnx"
```

### Q2: 路径映射不起作用？

**节点已自动适配！** 它使用 `folder_paths.models_dir`，这是 ComfyUI 的标准接口，会自动读取：
- `extra_model_paths.yaml` 配置
- 符号链接
- 自定义配置

无需额外设置。

### Q3: 多个 buffalo 模型如何选择？

在下拉菜单中会显示所有可用的模型：
- **buffalo_l** - 大型模型，精度最高，推荐
- **buffalo_m** - 中型模型，平衡性能和精度
- **buffalo_s** - 小型模型，速度最快

根据您的 GPU 性能选择合适的模型。

### Q4: 如何查看完整调试信息？

控制台会输出完整的路径信息：

```
[GJJ FaceAnalysis] 📂 models_path: D:\AI\MOD\models
[GJJ FaceAnalysis]  insightface_path: D:\AI\MOD\models\insightface
[GJJ FaceAnalysis]  insightface_path 存在: True
[GJJ FaceAnalysis] ✅ 发现模型: buffalo_l (insightface\buffalo_l)
[GJJ FaceAnalysis]    完整路径: D:\AI\MOD\models\insightface\buffalo_l
```

如果仍然无法加载，请复制这些日志并检查路径是否正确。

## 📊 路径适配对照表

| 您的配置 | folder_paths.models_dir | 节点实际使用路径 |
|---------|------------------------|----------------|
| 标准安装 | `D:\AI\CUI\ComfyUI\models` | `D:\AI\CUI\ComfyUI\models\insightface\buffalo_l` |
| extra_model_paths.yaml | `D:\AI\MOD\models` | `D:\AI\MOD\models\insightface\buffalo_l` ✅ |
| 符号链接 | `D:\AI\CUI\ComfyUI\models` (实际指向 D:\AI\MOD\models) | `D:\AI\MOD\models\insightface\buffalo_l` ✅ |

**✅ 所有情况都自动支持！**

## 🎉 总结

节点已完全适配您的路径映射配置：

1. ✅ 自动使用 `folder_paths.models_dir`
2. ✅ 支持所有路径映射方式
3. ✅ 自动扫描并枚举可用模型
4. ✅ 前端下拉菜单选择
5. ✅ 详细调试日志输出

**无需任何手动配置，重启 ComfyUI 即可使用！** 

---

**更新日期**：2026-05-05  
**版本**：v2.0.5  
**维护者**：GJJ Custom Nodes Team
