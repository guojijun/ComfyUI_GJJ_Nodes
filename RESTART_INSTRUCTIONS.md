# 重要：重启 ComfyUI 说明

##  为什么需要完全重启？

Python 的模块导入机制会**缓存**已加载的模块。如果之前已经加载了系统 Python 的 insightface，即使我们修改了代码，Python 仍会使用缓存的版本。

##  重启步骤

### 方法 1：完全重启（推荐）

1. **关闭 ComfyUI**
   - 按 `Ctrl+C` 停止 ComfyUI 服务
   - 或者关闭命令行窗口

2. **确认进程已退出**
   ```bash
   # 在 PowerShell 中检查
   Get-Process | Where-Object {$_.ProcessName -like "*python*"}
   ```
   如果还有 python 进程，手动结束它。

3. **重新启动 ComfyUI**
   ```bash
   cd "D:\AI\CUI\ComfyUI"
   python main.py
   ```

### 方法 2：清理 Python 缓存

如果完全重启后仍有问题，清理 Python 缓存：

```bash
# 删除所有 __pycache__ 目录
Get-ChildItem "D:\AI\MOD\custom_nodes\GJJ" -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force

# 删除所有 .pyc 文件
Get-ChildItem "D:\AI\MOD\custom_nodes\GJJ" -Recurse -Filter "*.pyc" | Remove-Item -Force
```

然后重启 ComfyUI。

##  验证修复

重启后，查看控制台输出，应该看到：

```
✅ 正确输出（使用 vendor）：
[GJJ FaceAnalysis] 🔧 已添加 vendor 路径: D:\AI\MOD\custom_nodes\GJJ\vendor
[GJJ FaceAnalysis] ✅ 成功加载 vendor 中的 insightface
[GJJ FaceAnalysis]  insightface 路径: D:\AI\MOD\custom_nodes\GJJ\vendor\insightface\__init__.py

❌ 错误输出（仍使用系统）：
[GJJ FaceAnalysis]  insightface 路径: D:\AI\CUI\python_embeded\Lib\site-packages\insightface\__init__.py
```

##  如果仍然失败

如果重启后仍然报错 "error on model routing"，请检查：

1. **vendor 目录是否存在**
   ```bash
   ls "D:\AI\MOD\custom_nodes\GJJ\vendor\insightface"
   ```
   应该看到 `app/`, `model_zoo/`, `utils/` 等目录。

2. **model_zoo.py 是否已修复**
   打开 `D:\AI\MOD\custom_nodes\GJJ\vendor\insightface\model_zoo\model_zoo.py`
   检查第 55 行应该是：
   ```python
   router = ModelRouter(model_file)  # 不是 name
   ```

3. **手动测试导入**
   ```python
   # 在 ComfyUI 的 Python 环境中运行
   import sys
   sys.path.insert(0, r"D:\AI\MOD\custom_nodes\GJJ\vendor")
   import insightface
   print(insightface.__file__)
   # 应该输出: D:\AI\MOD\custom_nodes\GJJ\vendor\insightface\__init__.py
   ```

##  快速修复脚本

如果问题持续，运行这个脚本自动修复：

```bash
cd "D:\AI\MOD\custom_nodes\GJJ\nodes"
D:\AI\CUI\python_embeded\python.exe fix_insightface_bug.py
```

然后重启 ComfyUI。

---

**更新日期**: 2026-05-05  
**状态**: 需要完全重启才能生效
