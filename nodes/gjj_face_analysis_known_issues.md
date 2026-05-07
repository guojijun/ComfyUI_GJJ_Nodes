# GJJ_FaceAnalysis 节点 - 已知问题和修复

## 🔧 已修复的问题

### 问题 1：buffalo_l 模型加载失败（AssertionError）

**错误信息：**
```
AssertionError: assert 'detection' in self.models
```

**根本原因：**
`insightface.app.FaceAnalysis` 在初始化时会在 `root/name` 目录下查找 `.onnx` 模型文件：
- 期望路径：`{root}/buffalo_l/*.onnx`
- 不同环境的实际路径可能不同

**解决方案：**
尝试多个可能的模型根目录路径（按优先级排序）：

```python
def get_analysis_model(det_size=(640, 640)):
    """获取人脸分析模型"""
    global ANALYSIS_MODELS
    
    models_path = folder_paths.models_dir
    insightface_path = os.path.join(models_path, "insightface")
    
    key = str(det_size[0])
    if key not in ANALYSIS_MODELS or ANALYSIS_MODELS[key] is None:
        # 尝试多个可能的路径（按优先级排序）
        possible_roots = [
            models_path,  # ComfyUI/models/ （镜像环境常用）
            os.path.join(insightface_path, "models"),  # ComfyUI/models/insightface/models
            insightface_path,  # ComfyUI/models/insightface
        ]
        
        model_loaded = False
        for root_path in possible_roots:
            if os.path.exists(root_path):
                try:
                    ANALYSIS_MODELS[key] = insightface.app.FaceAnalysis(
                        name="buffalo_l",
                        root=root_path
                    )
                    # 验证是否成功加载 detection 模型
                    if 'detection' in ANALYSIS_MODELS[key].models:
                        model_loaded = True
                        break
                    else:
                        print(f"[GJJ FaceAnalysis] ⚠️  {root_path} 中缺少 detection 模型")
                except Exception as e:
                    print(f"[GJJ FaceAnalysis] ❌ 从 {root_path} 加载失败: {e}")
        
        if not model_loaded:
            raise RuntimeError("无法加载 buffalo_l 人脸检测模型...")
    
    model = ANALYSIS_MODELS[key]
    # 在 prepare 时设置设备上下文
    try:
        import torch.cuda as cuda
        if cuda is not None and cuda.is_available():
            model.prepare(ctx_id=0, det_size=det_size)  # GPU
        else:
            model.prepare(ctx_id=-1, det_size=det_size)  # CPU
    except:
        model.prepare(ctx_id=-1, det_size=det_size)
    
    return model
```

**关键改进：**
1. ✅ **多路径尝试**：自动尝试 3 种常见的模型目录结构
2. ✅ **镜像环境支持**：优先尝试 `ComfyUI/models/` 根目录
3. ✅ **加载验证**：检查 `detection` 模型是否成功加载
4. ✅ **友好提示**：如果所有路径都失败，提供清晰的错误信息和下载链接
5. ✅ **日志输出**：打印详细的加载状态便于调试

**支持的模型目录结构：**
```
# 结构 1：镜像环境（最高优先级）
ComfyUI/models/
├── buffalo_l/          ← 直接放在 models 下
│   ├── 1k3d68.onnx
│   ├── 2d106det.onnx
│   ├── det_10g.onnx
│   ├── genderage.onnx
│   └── w600k_r50.onnx
└── insightface/
    └── inswapper_128.onnx

# 结构 2：标准安装（次优先级）
ComfyUI/models/insightface/
└── models/
    └── buffalo_l/      ← 在 insightface/models 下
        ├── 1k3d68.onnx
        ├── 2d106det.onnx
        ├── det_10g.onnx
        ├── genderage.onnx
        └── w600k_r50.onnx

# 结构 3：简化结构（最低优先级）
ComfyUI/models/insightface/
└── buffalo_l/          ← 直接在 insightface 下
    ├── 1k3d68.onnx
    ├── 2d106det.onnx
    ├── det_10g.onnx
    ├── genderage.onnx
    └── w600k_r50.onnx
```

**影响范围：**
- ✅ 兼容不同的模型目录结构
- ✅ 自动检测并选择正确的路径
- ✅ 提供清晰的错误提示
- ✅ 避免断言失败崩溃
- ✅ 支持镜像环境和标准安装

### 问题 2：FaceAnalysis 初始化参数错误（已废弃）

之前的 `providers` 参数问题已通过移除该参数解决，并在 v2.0.3 中合并到模型加载逻辑中。

## 📋 依赖版本建议

### 推荐版本
```bash
pip install insightface>=0.7.3 onnxruntime-gpu>=1.16.0 opencv-python>=4.8.0 pillow>=10.0.0
```

### 最低要求
```bash
pip install insightface>=0.5.0 onnxruntime>=1.14.0 opencv-python>=4.5.0 pillow>=9.0.0
```

## 🚀 性能优化建议

### GPU 加速
如果系统有 NVIDIA GPU，强烈建议使用 GPU 版本：

```bash
pip uninstall onnxruntime
pip install onnxruntime-gpu
```

节点会自动检测 GPU 可用性并使用最佳执行提供者。

### 模型缓存
节点会自动缓存人脸检测结果，相同图片不会重复分析。这对于批量处理非常有用：

```python
# 全局缓存变量
SOURCE_FACES = None          # 源图人脸缓存
SOURCE_IMAGE_HASH = None     # 源图哈希
TARGET_FACES = None          # 目标图人脸缓存
TARGET_IMAGE_HASH = None     # 目标图哈希
```

## ⚠️ 注意事项

1. **首次运行较慢**：首次加载模型需要时间，后续会使用缓存
2. **显存占用**：高分辨率图片会占用较多显存，建议批量大小不超过 10
3. **模型路径**：确保以下模型文件存在：
   - `ComfyUI/models/insightface/models/buffalo_l/*.onnx` （人脸检测）
   - `ComfyUI/models/insightface/inswapper_128.onnx` （换脸）
4. ** buffalo_l 模型**：如果缺失，可以从 https://github.com/deepinsight/insightface/releases 下载

## 📝 更新日志

### v2.0.3 (2026-05-05)
- ✅ 修复 buffalo_l 模型加载路径问题
- ✅ 添加多路径自动检测机制
- ✅ 增加模型加载验证逻辑
- ✅ 提供友好的错误提示信息

### v2.0.2 (2026-05-05)
- ~~修复 FaceAnalysis 初始化断言错误~~ (已合并到 v2.0.3)
- ~~采用 ReActor 原版参数传递方式~~ (已合并到 v2.0.3)

### v2.0.1 (2026-05-05)
- ~~修复 insightface 版本兼容性问题~~ (已废弃)

### v2.0.0 (2026-05-05)
- ✅ 内联 ReActor 核心代码
- ✅ 实现零外部节点依赖
- ✅ 添加批量处理支持

---

**最后更新**：2026-05-05  
**维护者**：GJJ Custom Nodes Team
