from __future__ import annotations

import json
import os
import time
from typing import Any

import folder_paths
import numpy as np
import torch
from .common_utils.dependency_checker import (
    build_dependency_model_report,
    check_dependencies,
    get_report_from_exception,
    load_dependency_at_runtime,
    make_missing_model_spec,
    raise_dependency_model_error,
    send_dependency_model_notice,
)

NODE_NAME = "GJJ_FasterWhisperASR"
MODEL_ROOT_NAME = "faster-whisper"
CATEGORY = "GJJ/Audio"
NODE_DISPLAY_NAME = "🎤 语音识别 (Faster Whisper)"
MODEL_DOWNLOAD_BASE_URL = "https://huggingface.co/Systran"

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
DEPENDENCY_SPECS = [
    {
        "module_name": "faster_whisper",
        "package_name": "faster-whisper",
        "display_name": "faster-whisper",
        "description": "Faster Whisper 语音识别主运行库。",
    },
    {
        "module_name": "soundfile",
        "package_name": "soundfile",
        "display_name": "soundfile",
        "description": "读取示例音频需要 soundfile。",
    },
]


# ═══════════════════════════════════════════════
# 运行时依赖加载（懒加载模式）
# ═══════════════════════════════════════════════
_DEPS = {}


def _collect_dependency_state() -> tuple[bool, list[dict[str, str]]]:
    missing_dependencies: list[dict[str, str]] = []
    for spec in DEPENDENCY_SPECS:
        available, _ = check_dependencies([spec["module_name"]], NODE_DISPLAY_NAME)
        if not available:
            missing_dependencies.append(spec)
    return (not missing_dependencies), missing_dependencies


_DEPENDENCIES_AVAILABLE, _MISSING_DEPENDENCIES = _collect_dependency_state()
_ENV_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_MISSING_DEPENDENCIES,
    missing_models=[],
    install_packages=[spec["package_name"] for spec in _MISSING_DEPENDENCIES],
    description="Faster Whisper 多语言语音识别节点，支持多模型尺寸、自动下载和 CPU/CUDA 切换。",
)
_HELP_NOTICE = (
    f"{_ENV_REPORT['warning_message']}\n请参考下方依赖、模型说明和安装命令。"
    if not _ENV_REPORT.get("available", True)
    else ""
)
_DESCRIPTION_READY = """
🎤 语音识别多语言场景 (Faster Whisper)

基于 faster-whisper 的多语言语音识别节点。

📁 模型目录：
models/faster-whisper/

🌏模型下载：
https://huggingface.co/Systran

💡 使用提示：
- 支持 tiny、base、small、medium、large-v3 多种模型尺寸
- 可开启自动下载，首次执行时自动拉取缺失模型
- CUDA 不稳定时建议切换为 CPU + int8
""".strip()
DESCRIPTION = (
    _DESCRIPTION_READY
    if _DEPENDENCIES_AVAILABLE
    else f"{_ENV_REPORT['warning_message']}\n\n{_DESCRIPTION_READY}"
)


def _load_faster_whisper_runtime(unique_id: Any = None):
    """运行时懒加载 faster-whisper 依赖库"""
    if _DEPS.get("_faster_whisper_loaded"):
        return _DEPS

    faster_whisper = load_dependency_at_runtime(
        module_name="faster_whisper",
        node_name=NODE_DISPLAY_NAME,
        package_name="faster-whisper",
        description="Faster Whisper 运行时需要 faster-whisper。",
        extra_packages=["soundfile"],
        unique_id=unique_id,
    )
    _DEPS["_faster_whisper_loaded"] = True
    _DEPS["WhisperModel"] = faster_whisper.WhisperModel
    return _DEPS


def _send_error_to_frontend(unique_id: Any, error_message: str):
    """将普通执行错误发送给前端结果区"""
    try:
        from server import PromptServer

        PromptServer.instance.send_sync("gjj_faster_whisper_error", {
            "node": str(unique_id),
            "error": error_message,
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


def _is_cuda_runtime_error(message: Any) -> bool:
    text = str(message or "").lower()
    return any(
        marker in text
        for marker in (
            "cuda error",
            "cuda",
            "cublas",
            "cublas64_12.dll",
            "cudnn",
            "cudart",
            "ctranslate2",
        )
    )


def _cuda_fallback_hint(error_message: str) -> str:
    if "cublas64_12.dll" in str(error_message).lower() or "cublas" in str(error_message).lower():
        return (
            "检测到 CUDA 12 的 cuBLAS DLL 缺失或无法加载。节点已尝试自动降级到 CPU + int8。\n"
            "如果你想继续使用 CUDA，请安装/修复匹配的 NVIDIA CUDA 12 运行时，"
            "并确保包含 cublas64_12.dll 的目录在 PATH 中；或者在节点里把设备固定为 cpu。"
        )
    return "检测到 CUDA 推理错误。节点已尝试自动降级到 CPU + int8；也可以在节点里把设备固定为 cpu。"


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
    try:
        # 使用标准方式加载 huggingface_hub
        huggingface_hub = load_dependency_at_runtime(
            module_name="huggingface_hub",
            node_name=NODE_DISPLAY_NAME,
            package_name="huggingface_hub",
            description="该节点需要 huggingface_hub 才能自动下载模型",
            unique_id=unique_id,
        )
        snapshot_download = huggingface_hub.snapshot_download
    except Exception as exc:
        report = get_report_from_exception(exc)
        if report:
            raise
        raise exc

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
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[
                make_missing_model_spec(
                    label=model_name,
                    subdir=MODEL_ROOT_NAME,
                    filename=model_name,
                    description="模型下载后目录仍不完整，请重新下载或手动补齐文件。",
                )
            ],
            description=f"模型下载后仍不完整：{target_dir}",
            unique_id=unique_id,
            title="GJJ 节点模型缺失！",
            copy_text=f"https://huggingface.co/{repo_id}",
            copy_label="🌏 复制下载网址",
        )
    return target_dir


def _resolve_model_dir(model_name: str, auto_download: bool, unique_id: Any = None) -> str:
    """解析模型路径，支持自动下载"""
    found = _find_local_model_dir(model_name)
    if found:
        return found
    if auto_download:
        return _download_model(model_name, unique_id)
    root = os.path.join(folder_paths.models_dir, MODEL_ROOT_NAME)
    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[
            make_missing_model_spec(
                label=model_name,
                subdir=MODEL_ROOT_NAME,
                filename=model_name,
                description=f"请放到 {root}，或开启自动下载模型。",
            )
        ],
        description=f"未找到本地模型：{model_name}",
        unique_id=unique_id,
        title="GJJ 节点模型缺失！",
        copy_text=f"https://huggingface.co/{MODEL_REPOS.get(model_name, '')}",
        copy_label="🌏 复制下载网址",
    )


class GJJ_FasterWhisperASR:
    """GJJ · 🎤 语音识别 (Faster Whisper)"""

    DESCRIPTION = DESCRIPTION
    CATEGORY = CATEGORY
    FUNCTION = "transcribe"
    OUTPUT_NODE = True
    RETURN_TYPES = ("WHISPER_OUTPUT", "STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("Whisper输出", "时间戳JSON", "分段文本", "开始时间列表", "结束时间列表")
    GJJ_HELP = {
        "title": "🎤 语音识别多语言场景 (Faster Whisper)",
        "description": _DESCRIPTION_READY,
        "notice": _HELP_NOTICE,
        "warning_message": _ENV_REPORT["warning_message"] if not _ENV_REPORT.get("available", True) else "",
        "install_cmd": _ENV_REPORT["install_cmd"] if not _ENV_REPORT.get("available", True) else "",
        "copy_text": _ENV_REPORT["copy_text"] if not _ENV_REPORT.get("available", True) else "",
        "copy_label": _ENV_REPORT["copy_label"] if not _ENV_REPORT.get("available", True) else "",
        "model_download_url": MODEL_DOWNLOAD_BASE_URL,
        "missing_dependencies": _MISSING_DEPENDENCIES,
        "missing_models": [],
        "dependencies": [
            "faster-whisper（主识别运行库）",
            "soundfile（读取示例音频）",
            "huggingface_hub（自动下载模型时按需使用）",
        ],
        "models": [
            make_missing_model_spec(label="tiny", subdir=MODEL_ROOT_NAME, filename="tiny", description="最快，精度最低。"),
            make_missing_model_spec(label="base", subdir=MODEL_ROOT_NAME, filename="base", description="快速，精度较低。"),
            make_missing_model_spec(label="small", subdir=MODEL_ROOT_NAME, filename="small", description="速度与精度平衡。"),
            make_missing_model_spec(label="medium", subdir=MODEL_ROOT_NAME, filename="medium", description="较慢，精度高。"),
            make_missing_model_spec(label="large-v3", subdir=MODEL_ROOT_NAME, filename="large-v3", description="最慢，精度最高，推荐。"),
        ],
        "tips": [
            "首次运行可开启自动下载；若不想联网，请先手动把模型放到 models/faster-whisper/ 下。",
            "CPU 模式推荐 int8，CUDA 模式可优先 float16。",
            "只做快速预览时可先选 tiny 或 base，正式转写再换 large-v3。",
        ],
    }

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
                        sf = load_dependency_at_runtime(
                            module_name="soundfile",
                            node_name=NODE_DISPLAY_NAME,
                            package_name="soundfile",
                            description="读取示例音频需要 soundfile。",
                            extra_packages=["faster-whisper"],
                            unique_id=unique_id,
                        )
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
                is_cuda_error = _is_cuda_runtime_error(error_msg)

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

            try:
                segments, info = model.transcribe(
                    waveform_np,
                    language=language if language != "auto" else None,
                    beam_size=beam_size,
                    vad_filter=True,
                )
            except Exception as exc:
                error_msg = str(exc)
                if device != "cpu" and _is_cuda_runtime_error(error_msg):
                    _send_status(unique_id, "⚠️ CUDA 推理失败，正在改用 CPU + int8 重试...", 0.62)
                    print(f"\n⚠️ [GJJ] Faster Whisper CUDA 推理失败，自动降级到 CPU + int8")
                    print(f"   原始错误：{error_msg[:300]}")
                    try:
                        del model
                    except Exception:
                        pass
                    try:
                        torch.cuda.empty_cache()
                    except Exception:
                        pass
                    device = "cpu"
                    compute_type = "int8"
                    model = WhisperModel(model_path, device=device, compute_type=compute_type)
                    _send_status(unique_id, "已切换 CPU + int8，正在重新执行语音识别...", 0.66)
                    segments, info = model.transcribe(
                        waveform_np,
                        language=language if language != "auto" else None,
                        beam_size=beam_size,
                        vad_filter=True,
                    )
                    _send_status(unique_id, _cuda_fallback_hint(error_msg), 0.72)
                else:
                    raise

            # 步骤 6：处理结果
            _send_status(unique_id, "正在处理识别结果...", 0.8)

            text_parts = []
            timestamps = []
            start_times = []
            end_times = []
            mtb_tokens = []

            for segment in segments:
                text = segment.text.strip()
                if text:
                    text_parts.append(text)
                    start_times.append(segment.start)
                    end_times.append(segment.end)
                    mtb_tokens.append(f"<|{float(segment.start):.2f}|>")
                    mtb_tokens.append(text)
                    mtb_tokens.append(f"<|{float(segment.end):.2f}|>")
                    timestamps.append({
                        "start": segment.start,
                        "end": segment.end,
                        "text": text,
                    })

            full_text = "\n".join(text_parts)
            timestamps_json = json.dumps(timestamps, ensure_ascii=False, indent=2)
            start_times_str = ", ".join(f"{t:.2f}" for t in start_times)
            end_times_str = ", ".join(f"{t:.2f}" for t in end_times)
            whisper_output = {
                "text": full_text,
                "language": getattr(info, "language", language if language != "auto" else ""),
                "tokens": mtb_tokens,
                "audio": audio,
                "chunk_offsets": [0.0],
                "segments": timestamps,
                "language_probability": float(getattr(info, "language_probability", 0.0) or 0.0),
                "duration": float(getattr(info, "duration", 0.0) or (len(waveform_np) / max(1, sample_rate))),
                "model": model_name,
                "backend": "faster-whisper",
                "device": device,
                "compute_type": compute_type,
                "timestamps_json": timestamps_json,
                "start_times": start_times,
                "end_times": end_times,
                "start_times_text": start_times_str,
                "end_times_text": end_times_str,
            }

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

            return (whisper_output, timestamps_json, full_text, start_times_str, end_times_str)

        except Exception as exc:
            report = get_report_from_exception(exc)
            if report:
                _send_status(unique_id, "执行失败，请查看上方面板", 1.0)
                send_dependency_model_notice(report, unique_id=unique_id)
                raise RuntimeError(report.get("warning_message") or "运行环境缺失。") from exc

            _send_status(unique_id, f"执行失败：{exc}", 1.0)
            error_msg = str(exc)

            # 检测是否为 CUDA 错误
            if _is_cuda_runtime_error(error_msg) and torch.cuda.is_available():
                cuda_error = (
                    "🎤 Faster Whisper ASR 执行失败（CUDA 错误）\n"
                    f"模型：{model_name}\n\n"
                    "❌ CUDA 运行时错误：当前环境无法完成 Faster Whisper 的 CUDA 推理。\n\n"
                    "💡 解决方案：\n"
                    "1. 最稳妥：在节点设置中把设备改为 cpu，计算精度改为 int8\n"
                    "2. 如果要用 CUDA，请安装/修复 CUDA 12 运行时，并确认 cublas64_12.dll 所在目录已加入 PATH\n"
                    "3. 检查 faster-whisper / ctranslate2 / PyTorch 的 CUDA 版本是否匹配\n"
                    "4. 修复后重启 ComfyUI\n\n"
                    f"原始错误：{error_msg}"
                )
                _send_error_to_frontend(unique_id, cuda_error)
                raise RuntimeError(cuda_error) from exc

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
