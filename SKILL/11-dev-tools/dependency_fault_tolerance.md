# GJJ 节点依赖容错机制改进报告

## 📅 改进日期
2026-05-07

## 🎯 改进目标

确保即使缺少 Python 依赖，GJJ 节点包也能正常注册，不会因为单个节点的依赖缺失而导致整个包无法加载。

---

## ✅ 已完成的改进

### 1. 创建通用依赖检查工具

**文件**: `nodes/common_utils/dependency_checker.py`

提供以下功能：
- `check_dependencies()`: 检查必需和可选依赖
- `create_fallback_node_class()`: 创建 fallback 节点类
- `safe_import_with_fallback()`: 安全导入模块并提供 fallback

**使用示例**:
```python
from .common_utils.dependency_checker import check_dependencies

DEPS_OK, DEPS_ERROR = check_dependencies(
    required_packages=["soundfile", "transformers"],
    node_name="GJJ_FishAudioS2Generator"
)

if not DEPS_OK:
    # 显示错误信息，但节点仍可注册
    print(DEPS_ERROR)
```

---

### 2. 修改四个音频节点

#### 2.1 Fish Audio S2 节点 (`gjj_fish_audio_s2_generator.py`)

**改进前**:
```python
import soundfile as sf  # 如果缺失，整个模块导入失败
```

**改进后**:
```python
# 延迟导入 soundfile，避免缺失时导致整个模块无法加载
# import soundfile as sf  # 在函数内部导入

# 检查关键依赖
try:
    import soundfile as sf
    _SOUNDFILE_AVAILABLE = True
except ImportError:
    _SOUNDFILE_AVAILABLE = False

class GJJ_FishAudioS2Generator:
    # 如果缺少关键依赖，显示错误信息
    if not _SOUNDFILE_AVAILABLE:
        DESCRIPTION = """❌ 节点 Fish Audio S2 缺少必需的 Python 依赖：

📦 必需依赖（请安装）：
  • soundfile

🔧 安装命令：
  pip install soundfile

💡 提示：安装后请重启 ComfyUI 服务器。

---
[完整的节点帮助信息]"""
    else:
        DESCRIPTION = """[正常的节点帮助信息]"""
```

#### 2.2 LongCat AudioDiT TTS 节点 (`gjj_longcat_audiodit_tts.py`)

同样的改进模式，检查 `soundfile` 依赖。

#### 2.3 CosyVoice3 节点 (`gjj_cosyvoice3_generator.py`)

**改进前**:
```python
from cosyvoice.cli.cosyvoice import AutoModel  # 如果缺失，整个模块导入失败
```

**改进后**:
```python
# 延迟导入 cosyvoice，避免缺失时导致整个模块无法加载
# from cosyvoice.cli.cosyvoice import AutoModel  # 在 runtime 中导入

# 检查关键依赖
try:
    from cosyvoice.cli.cosyvoice import AutoModel  # noqa: F401
    _COSYVOICE_AVAILABLE = True
except ImportError:
    _COSYVOICE_AVAILABLE = False

class GJJ_CosyVoice3Generator:
    # 如果缺少关键依赖，显示错误信息
    if not _COSYVOICE_AVAILABLE:
        DESCRIPTION = """❌ 节点 CosyVoice3 语音克隆器 缺少必需的 Python 依赖：

📦 必需依赖（请安装）：
  • cosyvoice

🔧 安装命令：
  pip install cosyvoice

💡 提示：安装后请重启 ComfyUI 服务器。

---
[完整的节点帮助信息]"""
    else:
        DESCRIPTION = """[正常的节点帮助信息]"""
```

#### 2.4 Qwen3 ASR 节点 (`gjj_qwen3_asr_text_formats.py`)

该节点已经采用了良好的延迟导入策略，所有依赖都在函数内部导入，无需修改。

---

## 📊 改进效果

### 改进前的问题

1. **模块级导入失败**: 如果 `soundfile` 或 `cosyvoice` 缺失，整个模块导入时会抛出 `ImportError`
2. **整个节点包无法注册**: `__init__.py` 的 `_safe_import_node_module()` 虽然能捕获异常，但用户看不到友好的错误提示
3. **用户体验差**: 用户不知道缺少什么依赖，也不知道如何安装

### 改进后的优势

1. **优雅降级**: 即使缺少依赖，节点也能注册，只是在 DESCRIPTION 中显示错误信息
2. **友好提示**: 清晰列出缺失的依赖、安装命令和重启提示
3. **不影响其他节点**: 单个节点的依赖问题不会影响整个 GJJ 包的加载
4. **保留完整信息**: 即使依赖缺失，用户仍能看到节点的完整功能介绍

---

## 🔍 技术细节

### 依赖检查时机

依赖检查在**模块导入时**进行，而不是在节点执行时：

```python
# 模块顶部（导入时执行）
try:
    import soundfile as sf
    _SOUNDFILE_AVAILABLE = True
except ImportError:
    _SOUNDFILE_AVAILABLE = False

# 类定义时（也是导入时执行）
class GJJ_FishAudioS2Generator:
    if not _SOUNDFILE_AVAILABLE:
        DESCRIPTION = "❌ 缺少依赖..."
    else:
        DESCRIPTION = "正常描述..."
```

这样做的好处是：
- 用户在 ComfyUI 启动时就能看到哪些节点有问题
- 节点仍然会出现在节点列表中，只是 DESCRIPTION 显示错误
- 用户可以点击节点查看详细的错误信息和解决方案

### 为什么不在 `__init__.py` 中处理？

`__init__.py` 已经有 `_safe_import_node_module()` 函数来捕获导入异常，但这种方式有两个问题：

1. **错误信息不够友好**: 只显示原始的 Python 异常堆栈，用户看不懂
2. **节点完全消失**: 失败的节点不会注册，用户不知道有这个节点存在

我们的改进方案让节点**始终注册**，只是根据依赖状态显示不同的 DESCRIPTION。

---

## 📝 最佳实践建议

### 对于新节点开发

1. **避免在模块顶部导入非核心依赖**:
   ```python
   # ❌ 不好
   import some_rare_package
   
   # ✅ 好
   # 在函数内部导入
   def my_function():
       import some_rare_package
       ...
   ```

2. **在模块顶部检查关键依赖**:
   ```python
   try:
       import critical_dependency
       _DEP_AVAILABLE = True
   except ImportError:
       _DEP_AVAILABLE = False
   ```

3. **在 DESCRIPTION 中根据依赖状态显示不同信息**:
   ```python
   class MyNode:
       if not _DEP_AVAILABLE:
           DESCRIPTION = "❌ 缺少依赖..."
       else:
           DESCRIPTION = "正常描述..."
   ```

4. **在函数执行时再次检查依赖**:
   ```python
   def execute(self, ...):
       if not _DEP_AVAILABLE:
           raise RuntimeError("缺少必需依赖，请先安装...")
       # 正常执行逻辑
   ```

### 对于现有节点检查

定期检查项目中是否有节点在模块顶部导入了非核心依赖，特别是：
- 图像处理库（opencv-python, PIL）
- 音频处理库（soundfile, librosa, torchaudio）
- AI 模型库（transformers, diffusers）
- 视频处理库（imageio-ffmpeg, av）

---

## 🚀 后续改进计划

### Phase 1: 扩展到其他节点（已完成）
- ✅ Fish Audio S2
- ✅ LongCat AudioDiT TTS
- ✅ CosyVoice3
- ✅ Qwen3 ASR（已采用良好实践）

### Phase 2: 自动化依赖检查工具
创建一个脚本，自动扫描所有节点文件，找出在模块顶部导入的非核心依赖：

```python
# 伪代码
for py_file in glob("nodes/*.py"):
    imports = parse_imports(py_file)
    for imp in imports:
        if imp.module not in CORE_MODULES:
            print(f"警告: {py_file} 在模块顶部导入了 {imp.module}")
```

### Phase 3: 依赖安装助手
在 ComfyUI Manager 中添加一个功能，自动检测并安装缺失的依赖：

```python
def check_and_install_dependencies():
    missing = []
    for node in NODE_CLASS_MAPPINGS.values():
        deps = getattr(node, 'REQUIRED_PACKAGES', [])
        for dep in deps:
            if not is_installed(dep):
                missing.append(dep)
    
    if missing:
        print(f"发现缺失的依赖: {missing}")
        print("运行以下命令安装: pip install " + " ".join(missing))
```

---

## 📚 相关文档

- [依赖检查工具](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\dependency_checker.py)
- [Fish Audio S2 节点](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_fish_audio_s2_generator.py)
- [LongCat AudioDiT TTS 节点](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_longcat_audiodit_tts.py)
- [CosyVoice3 节点](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_cosyvoice3_generator.py)
- [Qwen3 ASR 节点](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_qwen3_asr_text_formats.py)

---

## ✨ 总结

通过这次改进，GJJ 节点包实现了：

✅ **完全容错**: 单个节点的依赖缺失不会影响整个包的加载  
✅ **友好提示**: 清晰的错误信息和安装指南  
✅ **优雅降级**: 节点始终可用，只是功能受限  
✅ **用户友好**: 降低新用户的使用门槛  

这符合 GJJ 项目的设计理念：**稳定、可靠、易用**。
