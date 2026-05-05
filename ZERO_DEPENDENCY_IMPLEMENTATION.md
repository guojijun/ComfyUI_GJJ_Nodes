# GJJ_FaceAnalysis 节点 - 零依赖实现说明

##  实现真正的零依赖

现在节点已经实现了**真正的零依赖**，所有必需的库都集成在 `vendor` 目录中。

### 📦 集成内容

#### vendor/insightface/
- **来源**: 从系统 Python 环境复制
- **大小**: 约 500KB（纯代码，不含模型）
- **修复**: 已修复 model_zoo 路由 bug

###  工作原理

#### 1. 路径配置

```python
# 在节点启动时添加 vendor 到 Python 路径
vendor_path = os.path.join(os.path.dirname(__file__), '..', 'vendor')
if vendor_path not in sys.path:
    sys.path.insert(0, vendor_path)
```

#### 2. 导入机制

```python
# 现在导入的是 vendor 中的 insightface
import insightface  # ← 来自 vendor/insightface/
from insightface.app.common import Face
```

**优先级：**
1. ✅ `vendor/insightface/`（节点自带）
2. ❌ 系统 Python 的 insightface（不会使用）
3.  全局安装的 insightface（不会使用）

#### 3. Bug 修复

已修复 `vendor/insightface/model_zoo/model_zoo.py` 第 55 行：

```python
# 修复前（有 bug）
router = ModelRouter(name)

# 修复后（正确）
router = ModelRouter(model_file)
```

###  目录结构

```
GJJ/
├── nodes/
│   └── gjj_face_analysis.py      ← 主节点文件
├── vendor/                        ← 第三方库目录
│   ├── __init__.py
│   ├── README.md                  ← 说明文档
│   └── insightface/               ← 集成的 insightface
│       ├── app/
│       ├── model_zoo/
│       └── utils/
├── js/
├── examples/
└── __init__.py
```

###  用户环境要求

#### ✅ 必需的依赖（ComfyUI 已包含）
- `onnxruntime` 或 `onnxruntime-gpu`（ComfyUI 自带）
- `opencv-python`（ComfyUI 自带）
- `numpy`（ComfyUI 自带）
- `Pillow`（ComfyUI 自带）

#### ✅ 节点自带的依赖
- `insightface`（已集成在 vendor/ 目录）

#### ✅ 用户需要准备的
- 模型文件：`ComfyUI/models/insightface/buffalo_l/*.onnx`
- 换脸模型：`ComfyUI/models/insightface/inswapper_128.onnx`

###  部署方式

#### 方式 1：完整复制（推荐）
```bash
# 直接复制整个 GJJ 目录
xcopy "GJJ" "D:\AI\CUI\ComfyUI\custom_nodes\GJJ\" /E /I /Y

# 完成！无需任何额外安装
```

#### 方式 2：Git 克隆
```bash
cd "D:\AI\CUI\ComfyUI\custom_nodes"
git clone <repository-url> GJJ

# 完成！vendor 目录已包含
```

###  优势

| 特性 | 之前 | 现在 |
|------|------|------|
| insightface 安装 | ❌ 需要手动 pip install | ✅ 节点自带 |
| 版本兼容性 | ❌ 依赖用户环境 | ✅ 固定版本 |
| Bug 修复 | ❌ 需要用户手动修复 | ✅ 内置修复 |
| 部署复杂度 | ⚠️ 需要多个步骤 | ✅ 一键部署 |
| 零依赖 | ❌ 部分依赖 | ✅ 真正零依赖 |

###  维护更新

如果需要更新 insightface 版本：

1. **备份当前版本**
   ```bash
   mv vendor/insightface vendor/insightface.old
   ```

2. **复制新版本**
   ```bash
   xcopy "系统insightface路径" "vendor\insightface\" /E /I /Y
   ```

3. **修复 bug**
   编辑 `vendor/insightface/model_zoo/model_zoo.py` 第 55 行：
   ```python
   router = ModelRouter(model_file)  # 不是 name
   ```

4. **测试**
   重启 ComfyUI 并测试换脸功能

###  故障排除

#### Q1: 仍然提示找不到 insightface？

**检查 vendor 路径：**
```python
# 在节点中添加调试代码
print(f"vendor_path: {vendor_path}")
print(f"vendor 存在: {os.path.exists(vendor_path)}")
print(f"insightface 存在: {os.path.exists(os.path.join(vendor_path, 'insightface'))}")
```

#### Q2: 如何验证使用的是 vendor 中的 insightface？

查看控制台输出：
```
[GJJ FaceAnalysis] ✅ 成功加载 vendor 中的 insightface
[GJJ FaceAnalysis]  insightface 路径: D:\AI\MOD\custom_nodes\GJJ\vendor\insightface\__init__.py
```

#### Q3: 仍然需要安装其他依赖吗？

**不需要！** 所有 Python 依赖都已集成：
- ✅ insightface（vendor/ 目录）
- ✅ onnxruntime（ComfyUI 自带）
- ✅ opencv（ComfyUI 自带）
- ✅ numpy（ComfyUI 自带）
- ✅ Pillow（ComfyUI 自带）

### 🎉 总结

现在您的节点是**真正的零依赖**：

1. ✅ **无需 pip install**：所有依赖已集成
2. ✅ **版本固定**：确保一致性和稳定性
3. ✅ **Bug 已修复**：内置关键修复
4. ✅ **一键部署**：复制即用
5. ✅ **易于维护**：vendor 目录集中管理

**用户只需：**
1. 复制 GJJ 目录到 custom_nodes
2. 放置模型文件
3. 重启 ComfyUI
4. 开始使用！

---

**实现日期**: 2026-05-05  
**版本**: v3.0.0（零依赖版）  
**维护者**: GJJ Custom Nodes Team
