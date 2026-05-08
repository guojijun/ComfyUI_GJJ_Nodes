# GJJ 依赖检查工具使用指南

## 📦 工具位置

**文件**: `nodes/common_utils/dependency_checker.py`

这是一个通用的依赖检查工具，用于确保即使缺少 Python 依赖，GJJ 节点包也能正常注册。

---

## 🎯 功能说明

### 1. check_dependencies()

检查节点所需的依赖是否已安装。

**参数**:
- `required_packages`: 必需的 Python 包列表
- `node_name`: 节点名称（用于错误提示）
- `optional_packages`: 可选的 Python 包列表（缺失时只警告，不阻止）

**返回值**:
- `(bool, str)`: (是否所有必需依赖都已安装, 错误信息或成功消息)

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

### 2. create_fallback_node_class()

创建一个 fallback 节点类，用于在依赖缺失时占位。

**参数**:
- `node_name`: 节点类名
- `error_message`: 显示的错误信息
- `category`: 节点分类

**返回值**:
- fallback 节点类

**使用示例**:
```python
from .common_utils.dependency_checker import create_fallback_node_class

if not _DEP_AVAILABLE:
    FallbackClass = create_fallback_node_class(
        "MyNode",
        "❌ 缺少依赖...",
        "GJJ/Disabled"
    )
```

---

### 3. safe_import_with_fallback()

安全导入模块，如果失败则返回 fallback 节点。

**参数**:
- `module_name`: 要导入的模块名
- `node_name`: 节点类名
- `required_packages`: 必需的依赖包列表
- `category`: fallback 节点的分类

**返回值**:
- `(节点类, 是否成功导入)`

**使用示例**:
```python
from .common_utils.dependency_checker import safe_import_with_fallback

MyNode, success = safe_import_with_fallback(
    "my_module",
    "MyNode",
    ["some_package"],
    "GJJ/Audio"
)
```

---

## 🔧 最佳实践

### 在节点中使用依赖检查

#### 步骤 1: 模块顶部检查依赖

```python
# 检查关键依赖
try:
    import soundfile as sf
    _SOUNDFILE_AVAILABLE = True
except ImportError:
    _SOUNDFILE_AVAILABLE = False
```

#### 步骤 2: 根据依赖状态设置 DESCRIPTION

```python
class MyNode:
    CATEGORY = "GJJ/Audio"
    FUNCTION = "execute"
    OUTPUT_NODE = True
    
    # 如果缺少关键依赖，显示错误信息
    if not _SOUNDFILE_AVAILABLE:
        DESCRIPTION = """❌ 节点 XXX 缺少必需的 Python 依赖：

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

#### 步骤 3: 在函数执行时再次检查

```python
def execute(self, ...):
    if not _SOUNDFILE_AVAILABLE:
        raise RuntimeError("缺少必需依赖 soundfile，请先安装：pip install soundfile")
    
    # 正常执行逻辑
    import soundfile as sf
    ...
```

---

## 📝 已应用的节点

以下节点已使用依赖检查机制：

1. **Fish Audio S2** (`gjj_fish_audio_s2_generator.py`)
   - 检查: `soundfile`
   
2. **LongCat AudioDiT TTS** (`gjj_longcat_audiodit_tts.py`)
   - 检查: `soundfile`
   
3. **CosyVoice3** (`gjj_cosyvoice3_generator.py`)
   - 检查: `cosyvoice`
   
4. **Qwen3 ASR** (`gjj_qwen3_asr_text_formats.py`)
   - 已采用良好的延迟导入策略

---

## ✨ 优势

1. **优雅降级**: 即使缺少依赖，节点也能注册
2. **友好提示**: 清晰列出缺失的依赖、安装命令和重启提示
3. **不影响其他节点**: 单个节点的依赖问题不会影响整个 GJJ 包的加载
4. **保留完整信息**: 即使依赖缺失，用户仍能看到节点的完整功能介绍

---

## 🚀 未来扩展

可以考虑将此工具扩展为：

1. **自动依赖安装**: 检测缺失依赖并提示用户一键安装
2. **依赖版本检查**: 不仅检查是否安装，还检查版本是否符合要求
3. **依赖冲突检测**: 检测不同节点之间的依赖版本冲突
4. **图形化界面**: 在 ComfyUI 中提供依赖管理面板

---

## 📚 相关文档

- [DEPENDENCY_FAULT_TOLERANCE.md](./dependency_fault_tolerance.md) - 依赖容错机制详细说明
- [audio_loading_best_practices.md](../07-general-guides/audio_loading_best_practices.md) - 音频加载最佳实践
- [GJJ_CODING_CONVENTIONS.md](../../SKILL/GJJ_CODING_CONVENTIONS.md) - 项目编码规范
