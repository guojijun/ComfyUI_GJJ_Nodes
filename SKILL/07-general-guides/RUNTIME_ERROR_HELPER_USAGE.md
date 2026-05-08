# GJJ 运行时依赖错误提示公用函数使用指南

## 📋 概述

`print_runtime_dependency_error()` 是一个公用函数，用于在节点运行时遇到依赖缺失时，提供统一、美观的错误提示体验。

## 🎯 功能特点

1. **彩色控制台输出**：使用 ANSI 颜色代码，使错误信息更加醒目
2. **统一的视觉风格**：与 ComfyUI 启动时的错误提示保持一致
3. **一键复制安装命令**：安装命令格式统一，方便用户复制
4. **详细的错误信息**：包含节点名称、依赖名称、安装命令和原始错误

## 📦 导入方式

```python
from .common_utils.dependency_checker import print_runtime_dependency_error
import sys
```

## 🔧 函数签名

```python
def print_runtime_dependency_error(
    node_name: str,
    dependency_name: str,
    install_command: str,
    description: str = "",
    extra_info: str = ""
):
    """
    在控制台打印美观的运行时依赖缺失错误提示（带彩色输出）。
    
    Args:
        node_name: 节点名称（如 "语音识别四文本TTS(Qwen3)"）
        dependency_name: 缺失的依赖名称（如 "qwen-asr"）
        install_command: 完整的安装命令
        description: 依赖说明（可选）
        extra_info: 额外信息（可选，如原始错误信息）
    """
```

## 💡 使用示例

### 示例 1：基本用法

```python
def _ensure_cv2():
    """确保 cv2 已安装"""
    try:
        import cv2
        return cv2
    except ImportError as exc:
        python_executable = sys.executable
        install_cmd = f"{python_executable} -m pip install opencv-python -i https://pypi.tuna.tsinghua.edu.cn/simple"
        
        # 打印美观的控制台错误提示
        print_runtime_dependency_error(
            node_name="本地口型同步",
            dependency_name="opencv-python",
            install_command=install_cmd,
            description="该节点需要 opencv-python (cv2) 来处理图像",
            extra_info=f"原始导入错误：{exc}"
        )
        
        # 抛出简洁的错误信息（在前端显示）
        raise RuntimeError("运行时依赖缺失：opencv-python。详细信息请查看控制台。") from exc
```

### 示例 2：多个依赖

```python
def load_engine():
    """加载 Fish Audio S2 引擎"""
    try:
        from fish_speech.models.dac.inference import load_model
        from fish_speech.models.text2semantic import inference
        from fish_speech.inference_engine import TTSInferenceEngine
    except ImportError as e:
        python_executable = sys.executable
        install_cmd = f"{python_executable} -m pip install transformers loguru pydantic tiktoken hydra-core descript-audio-codec descript-audiotools soundfile -i https://pypi.tuna.tsinghua.edu.cn/simple"
        
        # 打印美观的控制台错误提示
        print_runtime_dependency_error(
            node_name="[语气]语音克隆TTS(FishAudioS2)",
            dependency_name="fish_speech",
            install_command=install_cmd,
            description="该节点需要以下 Python 依赖才能运行",
            extra_info=f"原始导入错误：{e}"
        )
        
        # 抛出简洁的错误信息
        raise RuntimeError("运行时依赖缺失：fish_speech。详细信息请查看控制台。") from e
```

### 示例 3：Qwen3 ASR 节点

```python
def _load_qwen_runtime():
    """加载 Qwen3 ASR 运行时"""
    try:
        from qwen_asr import Qwen3ASRModel, Qwen3ForcedAligner
        return Qwen3ASRModel, Qwen3ForcedAligner
    except Exception as exc:
        python_executable = sys.executable
        install_cmd = f"{python_executable} -m pip install qwen-asr -i https://pypi.tuna.tsinghua.edu.cn/simple"
        
        # 打印美观的控制台错误提示
        print_runtime_dependency_error(
            node_name="语音识别四文本TTS(Qwen3)",
            dependency_name="qwen-asr",
            install_command=install_cmd,
            description="该节点需要 qwen-asr Python 包才能运行",
            extra_info=f"原始导入错误：{exc}"
        )
        
        # 抛出简洁的错误信息
        raise RuntimeError("运行时依赖缺失：qwen-asr。详细信息请查看控制台。") from exc
```

## 🎨 输出效果

运行时会看到类似以下的彩色输出：

```
================================================================================
  GJJ 节点运行时依赖缺失！
================================================================================
[GJJ] 节点: 语音识别四文本TTS(Qwen3)
[GJJ] 该节点需要 qwen-asr Python 包才能运行

[GJJ] 快速安装命令:
  D:\AI\ComfyUINEW\python_embeded\python.exe -m pip install qwen-asr -i https://pypi.tuna.tsinghua.edu.cn/simple

[GJJ] 详细信息:
  原始导入错误：No module named 'qwen_asr'

[GJJ] 提示: 安装完成后请重启 ComfyUI 服务器
================================================================================
```

## 📝 最佳实践

1. **始终使用实际 Python 路径**：使用 `sys.executable` 获取当前 Python 解释器路径
2. **使用国内镜像源**：推荐使用清华镜像 `-i https://pypi.tuna.tsinghua.edu.cn/simple`
3. **提供简洁的前端错误信息**：RuntimeError 消息应该简洁，引导用户查看控制台
4. **保留原始错误信息**：通过 `extra_info` 参数传递原始 ImportError，便于调试
5. **一致性**：所有节点都使用相同的错误提示格式，提升用户体验

## ⚠️ 注意事项

1. **不要重复调用**：每个依赖检查只调用一次 `print_runtime_dependency_error()`
2. **保持简洁**：`description` 参数应该简短明了
3. **异常链**：使用 `raise ... from exc` 保持异常链完整
4. **前端配合**：如果需要在前端显示详细错误信息和一键复制按钮，需要配合前端 JavaScript 代码

## 🔗 相关文件

- **公用函数实现**：`nodes/common_utils/dependency_checker.py`
- **使用指南**：`SKILL/07-general-guides/RUNTIME_ERROR_HELPER_USAGE.md`
- **已应用的节点**：
  - `nodes/gjj_qwen3_asr_text_formats.py` - Qwen3 ASR 节点（qwen-asr）
  - `nodes/gjj_fish_audio_s2_loader.py` - Fish Audio S2 加载器（fish_speech）
  - `nodes/gjj_fish_audio_s2_generator.py` - Fish Audio S2 生成器（soundfile）
  - `nodes/gjj_longcat_audiodit_tts.py` - LongCat AudioDiT TTS（soundfile）
  - `nodes/gjj_local_lipsync.py` - 本地口型同步节点（opencv-python, soundfile）
  - `nodes/gjj_latentsync_node.py` - LatentSync 节点（opencv-python, scipy）
  - `nodes/gjj_cosyvoice3_runtime.py` - CosyVoice3 运行时（cosyvoice, soundfile）
  - `nodes/gjj_cosyvoice3_generator.py` - CosyVoice3 生成器（依赖 runtime）
  - `nodes/gjj_face_analysis.py` - 换脸分析器节点（opencv-python）
