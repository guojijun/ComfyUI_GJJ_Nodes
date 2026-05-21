# GJJ Vendor 目录

本目录包含节点所需的第三方库，实现真正的**零依赖**部署。

##  集成的库

### insightface
- **版本**: 0.7.3（已兼容 GJJ 本地模型目录）
- **来源**: `D:\Download\insightface 新.7z` 中的 `python-package/insightface`
- **修复内容**: 
  - 兼容 `ComfyUI/models/insightface/<model_name>` 本地模型目录
  - 兼容旧节点传入的 `provider_name` 参数
  - 优先使用本地模型，避免运行时自动下载

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
    │   ├── attribute.py
    │   ├── landmark.py
    │   ├── model_store.py
    │   ├── model_zoo.py  ← 已修复 bug
    │   └── retinaface.py
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

# 2. 复制新版本 Python 包
xcopy "D:\Download\insightface\python-package\insightface" "vendor\insightface\" /E /I /Y

# 3. 保留 GJJ 兼容补丁
# - utils/storage.py 支持 root/<model_name> 本地模型目录
# - model_zoo/model_zoo.py 支持 provider_name 和 root/<model_name>
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

**最后更新**: 2026-05-21  
**维护者**: GJJ Custom Nodes Team
