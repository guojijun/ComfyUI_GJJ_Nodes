# 模块缓存清除机制说明

##  问题背景

在 ComfyUI 环境中，多个节点可能依赖同一个第三方库（如 insightface）。Python 的模块导入机制会**缓存**首次加载的模块，导致：

1. **comfyui-reactor-node** 先启动，加载了系统 Python 的 insightface
2. **GJJ 节点**后启动，即使添加了 vendor 路径，Python 仍使用缓存的系统版本
3. 结果：vendor 中的修复版本无法生效

##  解决方案

在节点文件最开始（所有其他导入之前），**强制清除 insightface 模块缓存**：

```python
# 1. 添加 vendor 路径
vendor_path = os.path.join(os.path.dirname(__file__), '..', 'vendor')
if vendor_path not in sys.path:
    sys.path.insert(0, vendor_path)

# 2. 清除已缓存的 insightface 模块
insightface_modules = [key for key in sys.modules.keys() if key.startswith('insightface')]
if insightface_modules:
    print(f"[GJJ FaceAnalysis] ⚠️  检测到已加载的 insightface 模块: {insightface_modules}")
    print(f"[GJJ FaceAnalysis] 🔄 正在清除缓存并重新从 vendor 加载...")
    for mod in insightface_modules:
        del sys.modules[mod]
    print(f"[GJJ FaceAnalysis] ✅ 已清除 insightface 模块缓存")

# 3. 现在导入会使用 vendor 中的版本
import insightface
```

##  工作原理

### Python 模块缓存机制

Python 使用 `sys.modules` 字典缓存已加载的模块：

```python
sys.modules = {
    'insightface': <module 'insightface' from 'D:\\AI\\CUI\\python_embeded\\Lib\\site-packages\\insightface\\__init__.py'>,
    'insightface.app': <module 'insightface.app' from '...'>,
    'insightface.model_zoo': <module 'insightface.model_zoo' from '...'>,
    # ...
}
```

当执行 `import insightface` 时：
1. Python 首先检查 `sys.modules` 中是否已有缓存
2. 如果有，直接返回缓存的模块
3. 如果没有，才从 `sys.path` 中搜索并加载

### 清除缓存的逻辑

```python
# 查找所有 insightface 相关的模块
insightface_modules = [key for key in sys.modules.keys() if key.startswith('insightface')]
# 结果: ['insightface', 'insightface.app', 'insightface.model_zoo', ...]

# 逐个删除缓存
for mod in insightface_modules:
    del sys.modules[mod]

# 现在 sys.modules 中不再有 insightface
# 下次 import insightface 时会重新从 sys.path 加载
```

##  预期日志输出

### 场景 1：其他节点已加载 insightface

```
[GJJ FaceAnalysis]  已添加 vendor 路径: D:\AI\MOD\custom_nodes\GJJ\vendor
[GJJ FaceAnalysis] ⚠️  检测到已加载的 insightface 模块: ['insightface', 'insightface.app', 'insightface.app.common', 'insightface.model_zoo']
[GJJ FaceAnalysis] 🔄 正在清除缓存并重新从 vendor 加载...
[GJJ FaceAnalysis] ✅ 已清除 insightface 模块缓存
[GJJ FaceAnalysis] ✅ 成功加载 vendor 中的 insightface
[GJJ FaceAnalysis]  insightface 路径: D:\AI\MOD\custom_nodes\GJJ\vendor\insightface\__init__.py
```

### 场景 2：GJJ 节点最先加载

```
[GJJ FaceAnalysis] 🔧 已添加 vendor 路径: D:\AI\MOD\custom_nodes\GJJ\vendor
[GJJ FaceAnalysis] ✅ 成功加载 vendor 中的 insightface
[GJJ FaceAnalysis]  insightface 路径: D:\AI\MOD\custom_nodes\GJJ\vendor\insightface\__init__.py
```

##  注意事项

### ✅ 优势

1. **强制使用 vendor 版本**：无论其他节点是否已加载，都能确保使用 vendor 中的版本
2. **自动检测**：智能检测是否已有缓存，只在必要时清除
3. **详细日志**：提供清晰的调试信息

### ⚠️ 潜在影响

1. **其他节点可能受影响**：如果其他节点依赖系统 Python 的 insightface，清除缓存后它们可能会失败
2. **解决方案**：其他节点应在 GJJ 节点之前加载，或者也使用 vendor 机制

###  最佳实践

1. **节点加载顺序**：确保 GJJ 节点在其他使用 insightface 的节点之前加载
2. **配置 extra_model_paths.yaml**：在 ComfyUI 启动配置中优先加载 GJJ 节点
3. **监控日志**：启动时检查控制台日志，确认使用的是 vendor 版本

##  验证方法

重启 ComfyUI 后，检查控制台输出：

```bash
# 应该看到这些日志（按顺序）
[GJJ FaceAnalysis] 🔧 已添加 vendor 路径: ...
[GJJ FaceAnalysis] ⚠️  检测到已加载的 insightface 模块: ...  (如果有)
[GJJ FaceAnalysis] 🔄 正在清除缓存并重新从 vendor 加载...  (如果有)
[GJJ FaceAnalysis] ✅ 成功加载 vendor 中的 insightface
[GJJ FaceAnalysis]  insightface 路径: D:\AI\MOD\custom_nodes\GJJ\vendor\insightface\__init__.py
```

**关键验证点：**
- ✅ insightface 路径必须包含 `vendor`
- ✅ 不应该出现 `python_embeded\Lib\site-packages\insightface`

##  故障排除

### Q1: 仍然显示系统 Python 的路径？

**可能原因：**
- 清除缓存后，其他代码又导入了 insightface
- sys.path 顺序不正确

**解决方法：**
```python
# 在清除缓存后立即验证
import insightface
assert 'vendor' in insightface.__file__, f"错误的路径: {insightface.__file__}"
```

### Q2: 其他节点报错？

**原因：** 其他节点依赖系统 Python 的 insightface

**解决方法：**
1. 在 ComfyUI 配置中调整节点加载顺序
2. 或修改其他节点也使用 vendor 机制
3. 或保留两个版本（不推荐）

---

**更新日期**: 2026-05-05  
**版本**: v3.0.1（含模块缓存清除机制）  
**维护者**: GJJ Custom Nodes Team
