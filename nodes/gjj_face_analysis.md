# GJJ · 🎭 换脸分析器

内联 ReActor 核心的零依赖换脸节点，支持批量图片输入输出。

## ✨ 核心功能

- **双批量输入** - 源图和目标图均支持单图或多图
- **智能配对** - 自动处理一对一、一对多、多对一场景
- **内联 ReActor** - 直接集成 reactor 原版代码，无需安装外部包
- **批量输出** - 保持与输入对应的批量结构

## 📥 输入接口

### 必需输入

1. **目标图** (`GJJ_BATCH_IMAGE,IMAGE`)
   - 需要被换脸的图片
   - 支持单张 IMAGE 或批量 GJJ_BATCH_IMAGE
   - 可以是来自 LoadImage、GJJ_MultiImageLoader 等节点的输出

2. **源图** (`GJJ_BATCH_IMAGE,IMAGE`)
   - 提供脸部特征的图片
   - 支持单张 IMAGE 或批量 GJJ_BATCH_IMAGE
   - 可以是来自 LoadImage、GJJ_MultiImageLoader 等节点的输出

### 可选参数

- **换脸模型** - 选择 ReActor 换脸模型文件（默认：inswapper_128.onnx）
- **人脸检测** - 选择人脸检测模型（默认：YOLOv5n）
- **目标性别过滤** - 仅对指定性别的目标执行人脸替换（默认：no）
- **源图性别过滤** - 仅使用指定性别的源脸部（默认：no）
- **目标脸部索引** - 目标图中要替换的人脸索引，从0开始，逗号分隔（默认：0）
- **源图脸部索引** - 源图中用作替换源的人脸索引，从0开始，逗号分隔（默认：0）

## 📤 输出

- **换脸结果** (`IMAGE`) - 换脸后的图片，保持与目标图相同的批量结构

## 🔄 配对规则

| 目标图 | 源图 | 结果 |
|--------|------|------|
| 单图 | 单图 | 单张结果 |
| 单图 | 批量 (N张) | N张结果（同一源脸应用到所有目标） |
| 批量 (M张) | 单图 | M张结果（单张源脸应用到所有目标） |
| 批量 (M张) | 批量 (N张) | min(M,N) 张结果（一一配对） |

## 💡 使用示例

### 基础用法：单图换单图

```
LoadImage (目标图) → GJJ_FaceAnalysis (target_image)
LoadImage (源图) → GJJ_FaceAnalysis (source_image)
GJJ_FaceAnalysis → PreviewImage
```

### 批量应用：一张源脸换多张目标图

```
GJJ_MultiImageLoader (多张目标图) → GJJ_FaceAnalysis (target_image)
LoadImage (单张源图) → GJJ_FaceAnalysis (source_image)
GJJ_FaceAnalysis → PreviewImage (输出多张换脸结果)
```

### 多脸源：多张源脸换一张目标图

```
LoadImage (单张目标图) → GJJ_FaceAnalysis (target_image)
GJJ_MultiImageLoader (多张源图) → GJJ_FaceAnalysis (source_image)
GJJ_FaceAnalysis → PreviewImage (输出多张不同脸的换脸结果)
```

## ⚙️ 技术细节

- **人脸检测**：使用 YOLOv5n 或 retinaface_resnet50 进行高精度人脸检测
- **换脸模型**：基于 inswapper_128 ONNX 模型
- **色彩空间**：自动处理 RGB/RGBA/Grayscale，统一转换为 RGB
- **尺寸适配**：保持原始分辨率，不进行缩放
- **缓存优化**：自动缓存人脸检测结果，相同图片不重复分析

## 📦 依赖要求

### Python 包

```bash
pip install insightface onnxruntime-gpu opencv-python pillow
```

**注意**：这些是 ReActor 的核心依赖，节点已内联 ReActor 代码，但底层仍需要 insightface 库。

### 模型文件

需要将以下模型文件放置于 `ComfyUI/models/insightface/` 目录：

- `inswapper_128.onnx` - 主要换脸模型
- `inswapper_128_fp16.onnx` - FP16 精度版本（可选，速度更快）

模型下载地址：
- [inswapper_128.onnx](https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/inswapper_128.onnx)

## 🛠️ 故障排除

### 问题：缺少 insightface 依赖

**解决方案**：
```bash
pip install insightface onnxruntime-gpu opencv-python pillow
```

### 问题：找不到换脸模型文件

**解决方案**：
1. 下载 `inswapper_128.onnx` 模型
2. 将模型文件放置于 `ComfyUI/models/insightface/` 目录
3. 重启 ComfyUI

### 问题：检测到多张人脸但只换了一张

**解决方案**：
- 调整"目标脸部索引"参数，例如设置为 "0,1,2" 来换前三张脸
- 或使用"目标性别过滤"来筛选特定性别的人脸

### 问题：首次运行速度慢

**说明**：
- 首次运行需要加载 insightface 模型到内存
- 后续相同图片会使用缓存，速度会显著提升
- 建议使用 GPU 版本的 onnxruntime-gpu 加速

## 📝 注意事项

1. **隐私与伦理**：请仅在授权范围内使用换脸技术，尊重他人肖像权
2. **性能优化**：批量处理大量图片时建议使用 GPU 版本的 onnxruntime-gpu
3. **内存管理**：处理高分辨率图片时注意显存占用，可适当降低批量大小
4. **模型选择**：FP16 模型在支持的 GPU 上速度更快，但精度略有损失
5. **零依赖说明**：节点已内联 ReActor 核心代码，无需安装 ComfyUI-ReActor-Node，但仍需要 insightface 基础库

## 🔗 相关节点

- [`GJJ_MultiImageLoader`](./nodes/gjj_multi_image_loader.py) - 批量加载多张图片
- [`GJJ_BatchImageToImage`](./nodes/gjj_batch_image_bridge.py) - 批量图片类型转换
- [`PreviewImage`](https://docs.comfy.org/) - ComfyUI 原生图片预览节点

## 📄 许可证

本节点遵循 GJJ Custom Nodes 项目的许可证条款。

---

**版本**：2.0.0  
**最后更新**：2026-05-05  
**更新内容**：内联 ReActor 核心代码，实现真正的零外部节点依赖
