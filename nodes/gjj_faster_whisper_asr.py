"""
GJJ · 🎤 语音识别 (Faster Whisper)

基于 faster-whisper 的语音识别节点，支持多种模型尺寸和语言。
faster-whisper 使用 CTranslate2 实现，速度快，显存占用低。

 所需模型：
  • 模型目录: models/faster-whisper/
    - tiny (约 75MB, 最快，精度最低)
    - base (约 150MB, 快速，精度较低)
    - small (约 480MB, 平衡速度和精度)
    - medium (约 1.5GB, 较慢，精度高)
    - large-v3 (约 3GB, 最慢，精度最高，推荐)
  • 自动下载: 开启后首次执行时从 HuggingFace 下载（需 huggingface_hub）

🔧 Python 依赖：
  • faster-whisper (必需，CTranslate2 实现的 Whisper)
  • soundfile (音频读写)
  • huggingface_hub (可选，用于自动下载模型)
  • 安装命令: pip install faster-whisper soundfile huggingface_hub

✅ 优点：
  • 速度快，比官方 whisper 快 4-5 倍
  • 显存占用低，适合消费级显卡
  • 支持多种模型尺寸，灵活选择

📝 参考实现：
  • Qwen3 ASR: nodes/gjj_qwen3_asr_text_formats.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

import folder_paths
import numpy as np
import torch

NODE_NAME = "GJJ_FasterWhisperASR"
MODEL_ROOT_NAME = "faster-whisper"
CATEGORY = "GJJ/Audio"

# 可用模型列表
AVAILABLE_MODELS = ["tiny", "base", "small", "medium", "large-v3"]

# 语言列表
LANGUAGES = [
    "auto",
    "zh", "en", "ja", "ko", "fr", "de", "es", "ru",
    "it", "pt", "nl", "ar", "hi", "th", "vi", "tr",
]

# 设备选项
DEVICE_OPTIONS = ["auto", "cuda", "cpu"]

# 计算精度选项
COMPUTE_TYPE_OPTIONS = ["auto", "float16", "float32", "int8", "int8_float16"]

# HuggingFace 模型仓库
MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
}


# ═══════════════════════════════════════════════
# 运行时依赖加载（懒加载模式）
# ═══════════════════════════════════════════════
_DEPS = {}


def _load_faster_whisper_runtime(unique_id: Any = None):
    """运行时懒加载 faster-whisper 依赖库"""
    if _DEPS.get("_faster_whisper_loaded"):
        return _DEPS

    # 使用公共工具函数进行运行时依赖检查
    from .common_utils.dependency_checker import load_dependency_at_runtime

    try:
        # 加载 faster-whisper
        faster_whisper = load_dependency_at_runtime(
            module_name="faster_whisper",
            node_name="🎤 语音识别 (Faster Whisper)",
            package_name="faster-whisper",
            description="该节点需要 faster-whisper Python 包才能运行",
            extra_packages=["soundfile"],
        )
        _DEPS["_faster_whisper_loaded"] = True
        _DEPS["WhisperModel"] = faster_whisper.WhisperModel
        return _DEPS

    except Exception as exc:
        error_msg = str(exc)

        # 检测是否为 CUDA 库缺失错误（在导入阶段就可能发生）
        is_cuda_error = (
            "cublas64_12.dll" in error_msg or
            "CUDA error" in error_msg or
            "cuda" in error_msg.lower() or
            "cudnn" in error_msg.lower()
        )

        if is_cuda_error:
            # 发送友好的 CUDA 错误提示，告诉用户切换到 CPU
            cuda_error = (
                "❌ CUDA 库缺失：无法加载 cublas64_12.dll\n\n"
                "💡 解决方案：\n"
                "1. 💻 将节点中的「设备」参数改为 cpu\n"
                "2. 📦 安装 NVIDIA CUDA Toolkit 12.x\n"
                "3. 🔄 确保 PyTorch 安装了 CUDA 版本\n\n"
                "⚠️ 提示：即使切换到 CPU，仍然需要先安装依赖\n"
                "运行以下命令安装依赖：\n"
            )

            python_exe = sys.executable
            site_packages = os.path.join(os.path.dirname(python_exe), "Lib", "site-packages")
            from .common_utils.dependency_checker import get_pip_install_command_text
            install_cmd = get_pip_install_command_text("faster-whisper soundfile")

            _send_error_to_frontend(
                unique_id,
                error_message=cuda_error,
                install_command=install_cmd,
            )
        else:
            # 发送错误事件到前端（错误信息不含安装命令，安装命令单独发送）
            # 生成 PowerShell 格式的安装命令，安装到用户环境的 site-packages
            python_exe = sys.executable
            site_packages = os.path.join(os.path.dirname(python_exe), "Lib", "site-packages")
            from .common_utils.dependency_checker import get_pip_install_command_text
            install_cmd = get_pip_install_command_text("faster-whisper soundfile")
            _send_error_to_frontend(
                unique_id,
                error_message=f"未找到 faster-whisper 运行库。\n\n原始导入错误：{exc}",
                install_command=install_cmd,
            )

        raise


def _send_error_to_frontend(unique_id: Any, error_message: str, install_command: str = ""):
    """将错误信息和安装命令发送给前端"""
    try:
        from server import PromptServer

        PromptServer.instance.send_sync("gjj_faster_whisper_error", {
            "node": str(unique_id),
            "error": error_message,
            "install_command": install_command,
        })
    except Exception:
        pass


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    """发送进度状态到前端"""
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload: dict[str, Any] = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = float(progress)
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _audio_to_numpy(audio: Any) -> tuple[np.ndarray, int]:
    """将 ComfyUI 音频对象转换为 numpy 数组"""
    if audio is None:
        raise RuntimeError("输入音频为空。")

    if isinstance(audio, dict):
        waveform = audio.get("waveform")
        sample_rate = audio.get("sample_rate")

        if waveform is None or sample_rate is None:
            raise RuntimeError("输入音频格式无效，缺少 waveform 或 sample_rate。")

        # 转换 torch tensor 到 numpy
        if isinstance(waveform, torch.Tensor):
            waveform = waveform.cpu().numpy()

        # 确保是 2D 数组 [channels, samples]
        if waveform.ndim == 1:
            waveform = waveform.reshape(1, -1)

        # 取第一个声道（如果是立体声）
        if waveform.shape[0] > 1:
            waveform = waveform[0:1]

        # 展平为 1D 数组
        waveform = waveform.flatten()

        return waveform.astype(np.float32), int(sample_rate)

    raise RuntimeError(f"不支持的音频格式：{type(audio)}")


def _model_root() -> str:
    """获取模型根目录"""
    root = os.path.join(folder_paths.models_dir, MODEL_ROOT_NAME)
    os.makedirs(root, exist_ok=True)
    return root


def _is_model_dir(path: str) -> bool:
    """检查目录是否包含有效的模型文件"""
    if not os.path.isdir(path):
        return False
    try:
        names = set(os.listdir(path))
    except OSError:
        return False
    # 检查是否包含模型配置文件或权重文件
    return any(name.endswith((".bin", ".safetensors")) for name in names) or "config.json" in names


def _find_local_model_dir(model_name: str) -> str | None:
    """查找本地模型目录"""
    root = _model_root()
    requested = str(model_name or "").strip()

    # 直接检查
    if requested:
        if os.path.isabs(requested) and _is_model_dir(requested):
            return requested
        direct = os.path.join(root, requested)
        if _is_model_dir(direct):
            return direct

    # 模糊匹配
    requested_lower = requested.lower()
    for current, _, _ in os.walk(root):
        if current == root or not _is_model_dir(current):
            continue
        rel = os.path.relpath(current, root).replace("/", "\\")
        if rel.lower() == requested_lower or os.path.basename(rel).lower() == requested_lower:
            return current
    return None


def _download_model(model_name: str, unique_id: Any = None) -> str:
    """下载模型"""
    from .common_utils.dependency_checker import load_dependency_at_runtime

    try:
        # 使用标准方式加载 huggingface_hub
        huggingface_hub = load_dependency_at_runtime(
            module_name="huggingface_hub",
            node_name="🎤 语音识别 (Faster Whisper)",
            package_name="huggingface_hub",
            description="该节点需要 huggingface_hub 才能自动下载模型",
        )
        snapshot_download = huggingface_hub.snapshot_download
    except Exception as exc:
        from .common_utils.dependency_checker import get_pip_install_command_text
        install_cmd = get_pip_install_command_text("huggingface_hub")
        error_msg = (
            "未找到 huggingface_hub，无法自动下载 Faster Whisper 模型。\n"
            "请先把模型放到 ComfyUI/models/faster-whisper，或安装 huggingface_hub。\n"
            "\n"
            f"🔧 安装命令：\n{install_cmd}"
        )
        _send_error_to_frontend(unique_id, error_msg, install_cmd)
        raise RuntimeError(error_msg) from exc

    repo_id = MODEL_REPOS.get(model_name)
    if not repo_id:
        raise RuntimeError(f"未知的模型名称：{model_name}")

    target_dir = os.path.join(_model_root(), model_name)
    _send_status(unique_id, f"未找到本地模型，正在下载：{model_name}", 0.08)

    snapshot_download(
        repo_id=repo_id,
        local_dir=target_dir,
        local_dir_use_symlinks=False,
    )

    if not _is_model_dir(target_dir):
        raise RuntimeError(f"模型下载后仍不完整：{target_dir}")
    return target_dir


def _resolve_model_dir(model_name: str, auto_download: bool, unique_id: Any = None) -> str:
    """解析模型路径，支持自动下载"""
    found = _find_local_model_dir(model_name)
    if found:
        return found
    if auto_download:
        return _download_model(model_name, unique_id)
    root = os.path.join(folder_paths.models_dir, MODEL_ROOT_NAME)
    raise RuntimeError(f"未找到本地模型：{model_name}。请放到 {root}，或开启自动下载模型。")


class GJJ_FasterWhisperASR:
    """GJJ · 🎤 语音识别 (Faster Whisper)"""

    DESCRIPTION = __doc__
    CATEGORY = CATEGORY
    FUNCTION = "transcribe"
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("时间戳JSON", "分段文本", "开始时间列表", "结束时间列表")

    @classmethod
    def INPUT_TYPES(cls):
        # 读取 models/mp3 列表（下拉列表选项）
        mp3_dir = os.path.join(folder_paths.models_dir, "mp3")
        audio_choices = [""]  # 空选项
        if os.path.isdir(mp3_dir):
            for f in sorted(os.listdir(mp3_dir)):
                if f.lower().endswith((".mp3", ".wav", ".flac", ".m4a")):
                    audio_choices.append(f)

        # 如果列表为空，添加占位符
        if len(audio_choices) == 1:
            audio_choices.append("[无示例音频]")

        return {
            "required": {},
            "optional": {
                "audio": ("AUDIO", {
                    "display_name": "输入音频",
                    "tooltip": "连接 ComfyUI 的音频对象，例如 Load Audio 节点输出。",
                }),
                "example_audio": (audio_choices, {
                    "default": "",
                    "display_name": "示例音频",
                    "tooltip": "从 models/mp3 目录选择示例音频进行识别。",
                }),
                "model_name": (AVAILABLE_MODELS, {
                    "default": "large-v3",
                    "display_name": "模型名称",
                    "tooltip": "选择 Whisper 模型尺寸。large-v3 精度最高但速度最慢。",
                }),
                "language": (LANGUAGES, {
                    "default": "auto",
                    "display_name": "语言",
                    "tooltip": "选择音频语言。auto 表示自动检测。",
                }),
                "device": (DEVICE_OPTIONS, {
                    "default": "auto",
                    "display_name": "设备",
                    "tooltip": "选择运行设备。auto 会自动选择 GPU 或 CPU。",
                }),
                "compute_type": (COMPUTE_TYPE_OPTIONS, {
                    "default": "float16",
                    "display_name": "计算精度",
                    "tooltip": "float16 速度快，float32 精度高，int8 显存占用最低。",
                }),
                "beam_size": ("INT", {
                    "default": 5,
                    "min": 1,
                    "max": 10,
                    "display_name": "束搜索大小",
                    "tooltip": "束搜索大小，越大精度越高但速度越慢。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def transcribe(
        self,
        audio=None,
        example_audio="",
        model_name="large-v3",
        language="auto",
        device="auto",
        compute_type="float16",
        beam_size=5,
        unique_id=None,
        extra_pnginfo=None,
    ):
        # 从 properties 读取 Boolean 值（通过 extra_pnginfo + unique_id）
        props = {}
        try:
            if extra_pnginfo and isinstance(extra_pnginfo, dict):
                workflow = extra_pnginfo.get("workflow", {})
                if isinstance(workflow, dict):
                    nodes = workflow.get("nodes", [])
                    if isinstance(nodes, list):
                        uid = str(unique_id)
                        for n in nodes:
                            if isinstance(n, dict) and str(n.get("id")) == uid:
                                props = n.get("properties", {}) or {}
                                break
        except Exception:
            props = {}

        segment_by_sentence = bool(props.get("segment_by_sentence", True))
        auto_download = bool(props.get("auto_download", True))

        # 获取实际 Python 路径
        import sys
        python_executable = sys.executable

        try:
            start_time = time.time()

            # 步骤 1：准备输入音频
            _send_status(unique_id, "正在准备音频...", 0.1)
            if audio is None and example_audio != "[无示例音频]":
                mp3_dir = os.path.join(folder_paths.models_dir, "mp3")
                audio_path = os.path.join(mp3_dir, example_audio)
                if os.path.exists(audio_path):
                    try:
                        # 使用 soundfile 加载音频
                        import soundfile as sf
                        audio_np, sample_rate = sf.read(audio_path, always_2d=True)
                        # 转换为 torch tensor
                        if audio_np.ndim == 1:
                            audio_np = audio_np.reshape(1, -1)
                        else:
                            audio_np = audio_np.T
                        waveform = torch.from_numpy(audio_np).float()
                        audio = {"waveform": waveform.unsqueeze(0), "sample_rate": int(sample_rate)}
                    except Exception as e:
                        raise RuntimeError(f"加载示例音频失败: {e}")

            if audio is None:
                raise RuntimeError("请输入音频或选择示例音频。")

            # 转换音频
            waveform_np, sample_rate = _audio_to_numpy(audio)

            # 步骤 2：加载运行时
            _send_status(unique_id, "正在加载 faster-whisper 运行时...", 0.2)
            deps = _load_faster_whisper_runtime(unique_id)
            WhisperModel = deps["WhisperModel"]

            # 步骤 3：解析模型路径
            _send_status(unique_id, f"正在解析模型：{model_name}...", 0.3)
            model_path = _resolve_model_dir(model_name, auto_download, unique_id)
            _send_status(unique_id, f"模型路径：{model_path}", 0.4)

            # 步骤 4：加载模型
            _send_status(unique_id, "正在加载模型到设备...", 0.5)

            # 设备选择
            if device == "auto":
                device = "cuda" if torch.cuda.is_available() else "cpu"

            # 计算精度选择
            if compute_type == "auto":
                if device == "cuda":
                    # 检查 GPU 是否支持 float16
                    if torch.cuda.is_bf16_supported():
                        compute_type = "float16"
                    else:
                        compute_type = "float32"
                else:
                    compute_type = "int8"

            try:
                model = WhisperModel(model_path, device=device, compute_type=compute_type)
            except Exception as exc:
                error_msg = str(exc)

                # 检测是否为 CUDA 相关错误（包括 cublas64_12.dll 缺失）
                is_cuda_error = (
                    "CUDA error" in error_msg or
                    "cuda" in error_msg.lower() or
                    "cublas64_12.dll" in error_msg or
                    "cudnn" in error_msg.lower()
                )

                if is_cuda_error and device != "cpu":
                    _send_status(unique_id, "⚠️ 检测到 CUDA 错误，正在自动切换到 CPU 模式...", 0.55)
                    print(f"\n⚠️ [GJJ] 检测到 CUDA 错误，自动降级到 CPU 模式")
                    print(f"   原始错误：{error_msg[:200]}")
                    print(f"   请将节点中的「设备」参数改为 cpu，然后重新运行\n")
                    device = "cpu"
                    compute_type = "int8"
                    model = WhisperModel(model_path, device=device, compute_type=compute_type)
                else:
                    raise

            # 步骤 5：执行识别
            _send_status(unique_id, "正在执行语音识别...", 0.6)

            segments, info = model.transcribe(
                waveform_np,
                language=language if language != "auto" else None,
                beam_size=beam_size,
                vad_filter=True,
            )

            # 步骤 6：处理结果
            _send_status(unique_id, "正在处理识别结果...", 0.8)

            text_parts = []
            timestamps = []
            start_times = []
            end_times = []

            for segment in segments:
                text = segment.text.strip()
                if text:
                    text_parts.append(text)
                    start_times.append(segment.start)
                    end_times.append(segment.end)
                    timestamps.append({
                        "start": segment.start,
                        "end": segment.end,
                        "text": text,
                    })

            full_text = "\n".join(text_parts)
            timestamps_json = json.dumps(timestamps, ensure_ascii=False, indent=2)
            start_times_str = ", ".join(f"{t:.2f}" for t in start_times)
            end_times_str = ", ".join(f"{t:.2f}" for t in end_times)

            elapsed = time.time() - start_time
            _send_status(unique_id, f"识别完成！用时 {elapsed:.1f}s | {len(text_parts)} 个片段", 1.0)

            # 发送文本生成完成事件到前端
            try:
                from server import PromptServer
                PromptServer.instance.send_sync("gjj_faster_whisper_generated", {
                    "node": str(unique_id),
                    "text_list": full_text,
                })
            except Exception:
                pass

            return (timestamps_json, full_text, start_times_str, end_times_str)

        except Exception as exc:
            _send_status(unique_id, f"执行失败：{exc}", 1.0)

            error_msg = str(exc)

            # 检测是否为 CUDA 错误
            if ("CUDA error" in error_msg or "cuda" in error_msg.lower()) and torch.cuda.is_available():
                cuda_error = (
                    "🎤 Faster Whisper ASR 执行失败（CUDA 错误）\n"
                    f"模型：{model_name}\n\n"
                    "❌ CUDA 兼容性错误：您的 GPU 架构与当前 PyTorch/CUDA 版本不兼容。\n\n"
                    "💡 解决方案：\n"
                    "1. 检查 GPU 型号和 CUDA 版本是否匹配\n"
                    "2. 尝试使用 CPU 模式（在节点设置中切换设备为 cpu）\n"
                    "3. 更新 PyTorch 到最新版本以支持您的 GPU\n"
                    "4. 使用兼容 CUDA 架构的 PyTorch 版本\n\n"
                    f"原始错误：{error_msg}"
                )
                _send_error_to_frontend(unique_id, cuda_error)
                raise RuntimeError(cuda_error) from exc

            # 检测是否为依赖缺失错误
            elif "未找到" in error_msg or "ImportError" in error_msg or "ModuleNotFoundError" in error_msg or "No module named" in error_msg:
                # 根据缺失的模块名生成安装命令（PowerShell 格式，安装到用户环境）
                from .common_utils.dependency_checker import get_pip_install_command_text

                if "soundfile" in error_msg:
                    install_command = get_pip_install_command_text("soundfile")
                elif "faster_whisper" in error_msg:
                    install_command = get_pip_install_command_text("faster-whisper soundfile")

                # 如果没有匹配的模块，使用默认的安装命令
                if not install_command:
                    install_command = get_pip_install_command_text("faster-whisper soundfile")

                _send_error_to_frontend(unique_id, error_msg, install_command)
                raise

            # 其他错误
            else:
                detailed_error = (
                    f"🎤 Faster Whisper ASR 执行失败\n"
                    f"模型：{model_name}\n\n"
                    f"详细错误：{error_msg}"
                )
                _send_error_to_frontend(unique_id, detailed_error)
                raise RuntimeError(detailed_error) from exc


# ═══════════════════════════════════════════════
# 注册到全局映射
# ═══════════════════════════════════════════════
NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_FasterWhisperASR,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "🎤 语音识别多语言场景 (Faster Whisper)",
}
