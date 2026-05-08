# 运行时依赖检查最佳实践

## 📅 更新日期
2026-05-08

## 🎯 核心原则

**在运行时检查依赖，而不是在模块导入时检查**。这样即使缺少依赖，节点也能正常注册，只是在执行时会给出友好的错误提示和安装命令。

---

## ✅ 改进前的问题

### 模块顶部直接导入依赖

```python
# ❌ 错误做法
import soundfile as sf
from cosyvoice.cli.cosyvoice import AutoModel

class MyNode:
    ...
```

**问题**：
- 如果依赖缺失，整个模块无法加载
- 节点不会注册到 ComfyUI
- 用户看不到节点，也不知道需要安装什么依赖

---

## 🔧 改进后的方案

### 1. 延迟导入 + 运行时检查

```python
# ✅ 正确做法
# 模块顶部不导入，只注释说明
# import soundfile as sf  # 在函数内部导入

def _ensure_soundfile():
    """确保 soundfile 已安装"""
    try:
        import soundfile as sf
        return sf
    except ImportError as exc:
        raise RuntimeError(
            "CosyVoice3 需要 soundfile 库来处理音频文件。\n"
            "\n"
            "🔧 快速安装命令（使用国内镜像）：\n"
            "pip install soundfile -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
            "\n"
            f"原始错误：{exc}"
        ) from exc

def my_function():
    sf = _ensure_soundfile()  # 运行时检查
    audio_np, sample_rate = sf.read(path)
    ...
```

**优势**：
- ✅ 节点可以正常注册
- ✅ 用户在 ComfyUI 中能看到节点
- ✅ 点击节点帮助可以看到完整的依赖信息
- ✅ 执行时如果缺少依赖，会显示清晰的安装命令
- ✅ 使用国内镜像，下载速度快

---

## 📝 已应用的节点

### 1. Fish Audio S2

**文件**: `nodes/gjj_fish_audio_s2_loader.py`

**改进内容**：
- 在 `_ensure_vendor_fish_speech()` 函数中添加详细的错误提示
- 提供一键安装命令（使用清华镜像）
- 列出所有必需的依赖包

**错误提示示例**：
```
Fish Audio S2 运行时导入失败，请先补齐 Fish S2 的 Python 推理依赖。

不要 pip install fish-speech；GJJ 已内置 fish_speech 源码，只需要环境依赖。

🔧 快速安装命令（使用国内镜像）：
pip install transformers loguru pydantic tiktoken hydra-core descript-audio-codec descript-audiotools soundfile -i https://pypi.tuna.tsinghua.edu.cn/simple

或者逐个安装：
pip install transformers -i https://pypi.tuna.tsinghua.edu.cn/simple
pip install hydra-core -i https://pypi.tuna.tsinghua.edu.cn/simple
pip install descript-audio-codec descript-audiotools -i https://pypi.tuna.tsinghua.edu.cn/simple
pip install soundfile -i https://pypi.tuna.tsinghua.edu.cn/simple

原始导入错误：No module named 'hydra'
```

---

### 2. CosyVoice3

**文件**: `nodes/gjj_cosyvoice3_runtime.py`

**改进内容**：
- 将 `soundfile` 和 `cosyvoice` 的导入改为延迟导入
- 创建 `_ensure_soundfile()` 辅助函数
- 在 `load_cosyvoice_model()` 中检查 cosyvoice 依赖
- 在所有使用 `sf` 的地方调用 `_ensure_soundfile()`

**错误提示示例**：
```
CosyVoice3 运行时导入失败，请先补齐 CosyVoice3 的 Python 依赖。

🔧 快速安装命令（使用国内镜像）：
pip install cosyvoice soundfile -i https://pypi.tuna.tsinghua.edu.cn/simple

或者逐个安装：
pip install cosyvoice -i https://pypi.tuna.tsinghua.edu.cn/simple
pip install soundfile -i https://pypi.tuna.tsinghua.edu.cn/simple

原始导入错误：No module named 'cosyvoice'
```

---

## 🎨 彩色错误输出

**文件**: `nodes/__init__.py`

改进了 `_safe_import_node_module()` 函数，使用 ANSI 颜色代码：

```python
# ANSI 颜色代码
RED = '\033[91m'
YELLOW = '\033[93m'
CYAN = '\033[96m'
RESET = '\033[0m'
BOLD = '\033[1m'

print(f"\n{RED}{'=' * 80}{RESET}")
print(f"{YELLOW}[GJJ] {BOLD}跳过节点模块:{RESET} {CYAN}{module_name}{RESET}")
print(f"{YELLOW}[GJJ] {BOLD}原因:{RESET} {RED}{type(exc).__name__}:{RESET} {exc}")
print(f"{YELLOW}[GJJ]{RESET} 该模块中的节点不会注册，但其它 GJJ 节点会继续加载。")
print(f"{YELLOW}[GJJ] {BOLD}解决方案:{RESET} 请安装缺失的依赖后重启 ComfyUI")
print(f"{RED}{'=' * 80}{RESET}\n")
```

**颜色方案**：
- 🔴 红色：分隔线、异常类型
- 🟡 黄色：[GJJ] 标签、关键提示
- 🔵 青色：模块名称
- **加粗**：重要标签

---

## 📚 通用模式

### 模式 1: 简单依赖检查

适用于只有一个或少数几个依赖的情况：

```python
def my_function():
    try:
        import some_package
    except ImportError:
        raise RuntimeError(
            "节点 XXX 需要 some_package 库。\n"
            "\n"
            "🔧 安装命令（使用国内镜像）：\n"
            "pip install some_package -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
        )
    
    # 正常使用
    some_package.do_something()
```

### 模式 2: 辅助函数模式

适用于多个地方需要使用同一个依赖的情况：

```python
def _ensure_dependency():
    """确保依赖已安装"""
    try:
        import some_package
        return some_package
    except ImportError as exc:
        raise RuntimeError(
            "节点 XXX 需要 some_package 库。\n"
            "\n"
            "🔧 安装命令（使用国内镜像）：\n"
            "pip install some_package -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
            "\n"
            f"原始错误：{exc}"
        ) from exc

def function_a():
    pkg = _ensure_dependency()
    pkg.do_something()

def function_b():
    pkg = _ensure_dependency()
    pkg.do_another_thing()
```

### 模式 3: 复杂依赖检查

适用于有多个必需依赖的情况：

```python
def _ensure_all_dependencies():
    """确保所有依赖已安装"""
    missing = []
    
    try:
        import package_a
    except ImportError:
        missing.append("package_a")
    
    try:
        import package_b
    except ImportError:
        missing.append("package_b")
    
    if missing:
        packages = " ".join(missing)
        raise RuntimeError(
            f"节点 XXX 缺少以下依赖：{', '.join(missing)}\n"
            "\n"
            "🔧 快速安装命令（使用国内镜像）：\n"
            f"pip install {packages} -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
        )

def my_function():
    _ensure_all_dependencies()
    # 正常使用
```

---

## 💡 最佳实践建议

### 1. 始终使用国内镜像

```python
# ✅ 推荐
pip install package_name -i https://pypi.tuna.tsinghua.edu.cn/simple

# ❌ 不推荐（速度慢）
pip install package_name
```

### 2. 提供一键安装和逐个安装两种方式

```python
"🔧 快速安装命令（使用国内镜像）：\n"
"pip install pkg1 pkg2 pkg3 -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
"\n"
"或者逐个安装：\n"
"pip install pkg1 -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
"pip install pkg2 -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
"pip install pkg3 -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
```

### 3. 明确说明不要安装什么

```python
"不要 pip install fish-speech；GJJ 已内置 fish_speech 源码，只需要环境依赖。"
```

### 4. 保留原始错误信息

```python
f"原始导入错误：{exc}"
```

这样可以帮助高级用户调试问题。

### 5. 使用 emoji 提高可读性

- 🔧 表示工具/安装
- 📦 表示依赖包
- ⚠️ 表示警告
- ❌ 表示错误
- ✅ 表示成功

---

## 🚀 未来扩展

可以考虑将这些模式封装成通用工具：

```python
# nodes/common_utils/dependency_checker.py

def ensure_packages(packages: list[str], node_name: str) -> None:
    """确保指定的包已安装"""
    missing = []
    for pkg in packages:
        try:
            __import__(pkg.replace("-", "_"))
        except ImportError:
            missing.append(pkg)
    
    if missing:
        packages_str = " ".join(missing)
        raise RuntimeError(
            f"{node_name} 缺少以下依赖：{', '.join(missing)}\n"
            "\n"
            "🔧 快速安装命令（使用国内镜像）：\n"
            f"pip install {packages_str} -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
        )

# 使用示例
def my_function():
    ensure_packages(["soundfile", "cosyvoice"], "CosyVoice3")
    import soundfile as sf
    ...
```

---

## 📖 相关文档

- [DEPENDENCY_FAULT_TOLERANCE.md](./dependency_fault_tolerance.md) - 依赖容错机制详细说明
- [dependency_checker_usage.md](./dependency_checker_usage.md) - 依赖检查工具使用指南
- [audio_loading_best_practices.md](../07-general-guides/audio_loading_best_practices.md) - 音频加载最佳实践

---

**最后更新**: 2026-05-08
