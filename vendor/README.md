# GJJ Vendor 目录

本目录包含节点所需的第三方库，实现真正的**零依赖**部署。

##  集成的库

### insightface
- **版本**: 0.7.x（已修复 model_zoo bug）
- **来源**: 从系统 Python 环境复制
- **修复内容**: 
  - 修复 `model_zoo.py` 第 55 行的路由 bug
  - `router = ModelRouter(name)` → `router = ModelRouter(model_file)`

## 📁 目录结构

```
vendor/
└── insightface/
    ├── __init__.py
    ├── app/
    │   ├── __init__.py
    │   ├── common.py
    │   ├── face_analysis.py
    │   └── face_onnx_handler.py
    ├── model_zoo/
    │   ├── __init__.py
    │   ├── arcface_onnx.py
    │   ├── face_detection.py
    │   ├── face_genderage.py
    │   ├── face_recognition.py
    │   ├── model_store.py
    │   ├── model_zoo.py  ← 已修复 bug
    │   └── scrfd.py
    └── utils/
        ├── __init__.py
        ├── common.py
        ├── download.py
        ├── face_align.py
        ── filesystem.py
```

##  更新方法

如果需要更新 insightface 版本：

```bash
# 1. 备份当前版本
mv vendor/insightface vendor/insightface.backup

# 2. 复制新版本
xcopy "D:\AI\CUI\python_embeded\Lib\site-packages\insightface" "vendor\insightface\" /E /I /Y

# 3. 修复 bug（手动编辑 model_zoo/model_zoo.py 第 55 行）
# 将: router = ModelRouter(name)
# 改为: router = ModelRouter(model_file)
```

## ✅ 优势

1. **零依赖**：无需用户安装 insightface
2. **版本控制**：确保所有用户使用相同版本
3. **Bug 修复**：内置关键 bug 修复
4. **易于部署**：直接复制整个 GJJ 目录即可使用

## ⚠️ 注意事项

- 本目录仅包含 Python 代码，不包含模型文件
- 模型文件仍需放置在 `ComfyUI/models/insightface/` 目录
- 运行时仍需要 `onnxruntime` 或 `onnxruntime-gpu`（这是 ComfyUI 的依赖，不是节点的依赖）

---

**最后更新**: 2026-05-05  
**维护者**: GJJ Custom Nodes Team
