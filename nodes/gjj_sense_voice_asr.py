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

NODE_NAME = "GJJ_SenseVoiceASR"
MODEL_ROOT_NAME = "ASR"
MODEL_NAME = "SenseVoice-small-nonx"
MODEL_DOWNLOAD_URL = "https://pan.quark.cn/s/6ec846f1f58d"

LANGUAGES = [
    "自动",
    "中文",
    "英文",
    "日文",
    "韩文",
    "粤语",
]

DEVICE_OPTIONS = ["自动", "CPU", "CUDA"]
PRECISION_OPTIONS = ["自动", "float16", "float32", "int8"]


_DEPS = {}
NODE_DISPLAY_NAME = "🎤 语音识别 (SenseVoice)"
DEPENDENCY_SPECS = [
    {
        "module_name": "funasr",
        "package_name": "funasr",
        "display_name": "funasr",
        "description": "SenseVoice 运行时需要 funasr 加载和执行语音识别模型。",
    },
    {
        "module_name": "soundfile",
        "package_name": "soundfile",
        "display_name": "soundfile",
        "description": "SenseVoice 需要 soundfile 读取示例音频文件。",
    },
]
REQUIRED_MODEL = make_missing_model_spec(
    label="SenseVoice-small-nonx",
    subdir=MODEL_ROOT_NAME,
    filename=MODEL_NAME,
    description="SenseVoice 本地模型目录，请放到 models/ASR/SenseVoice-small-nonx/。",
)


def _collect_dependency_state() -> tuple[bool, list[dict[str, str]]]:
    missing_dependencies: list[dict[str, str]] = []
    for spec in DEPENDENCY_SPECS:
        available, _ = check_dependencies([spec["module_name"]], NODE_DISPLAY_NAME)
        if not available:
            missing_dependencies.append(spec)
    return (not missing_dependencies), missing_dependencies


def _resolve_local_model_dir(model_name: str = MODEL_NAME) -> str:
    return os.path.join(folder_paths.models_dir, MODEL_ROOT_NAME, model_name)


def _collect_model_state() -> tuple[bool, list[dict[str, str]]]:
    model_dir = _resolve_local_model_dir()
    if os.path.isdir(model_dir):
        return True, []
    return False, [REQUIRED_MODEL]


_DEPENDENCIES_AVAILABLE, _MISSING_DEPENDENCIES = _collect_dependency_state()
_MODELS_AVAILABLE, _MISSING_MODELS = _collect_model_state()
_ENV_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_MISSING_DEPENDENCIES,
    missing_models=_MISSING_MODELS,
    install_packages=[spec["package_name"] for spec in _MISSING_DEPENDENCIES],
    description="SenseVoice 语音识别节点，支持中文、英文、日文、韩文、粤语等多语言识别。",
)
_HELP_NOTICE = (
    f"{_ENV_REPORT['warning_message']}\n请参考下方依赖、模型说明和安装命令。"
    if not _ENV_REPORT.get("available", True)
    else ""
)
_DESCRIPTION_READY = """
🎤 语音识别 (SenseVoice)

基于阿里巴巴达摩院 SenseVoice 的语音识别节点。

📁 模型目录：
models/ASR/SenseVoice-small-nonx/

🌏模型下载：
https://pan.quark.cn/s/6ec846f1f58d

💡 使用提示：
- 支持中文、英文、日文、韩文、粤语等多种语言
- 推荐使用 CPU + int8 模式获得最佳兼容性
- 本地模型缺失时，执行阶段可尝试自动下载
""".strip()
DESCRIPTION = (
    _DESCRIPTION_READY
    if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
    else f"{_ENV_REPORT['warning_message']}\n\n{_DESCRIPTION_READY}"
)


def _load_sense_voice_runtime(unique_id: Any = None) -> dict[str, Any]:
    """运行时懒加载 SenseVoice 依赖库"""
    if _DEPS.get("_sense_voice_loaded"):
        return _DEPS

    funasr = load_dependency_at_runtime(
        module_name="funasr",
        node_name=NODE_DISPLAY_NAME,
        package_name="funasr",
        description="SenseVoice 运行时需要 funasr。",
        extra_packages=["soundfile", "huggingface_hub"],
        unique_id=unique_id,
    )
    load_dependency_at_runtime(
        module_name="soundfile",
        node_name=NODE_DISPLAY_NAME,
        package_name="soundfile",
        description="SenseVoice 读取示例音频需要 soundfile。",
        extra_packages=["funasr"],
        unique_id=unique_id,
    )

    _DEPS["_sense_voice_loaded"] = True
    _DEPS["AutoModel"] = funasr.AutoModel

    return _DEPS


def _send_error_to_frontend(unique_id: Any, error_message: str) -> None:
    """将普通执行错误发送给前端结果区"""
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_sense_voice_error",
            {
                "node": str(unique_id),
                "error": error_message,
            },
        )
    except Exception:
        pass


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    """发送进度状态到前端"""
    try:
        from server import PromptServer

        payload: dict[str, Any] = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = float(progress)
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _send_result_to_frontend(unique_id: Any, text_list: str) -> None:
    """发送识别结果到前端"""
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_sense_voice_generated",
            {
                "node": str(unique_id),
                "text_list": text_list,
            },
        )
    except Exception:
        pass


def _get_example_audio_files() -> list[str]:
    """获取示例音频文件列表"""
    mp3_dir = os.path.join(folder_paths.models_dir, "mp3")
    audio_choices = [""]  # 空选项
    if os.path.isdir(mp3_dir):
        for f in sorted(os.listdir(mp3_dir)):
            if f.lower().endswith((".mp3", ".wav", ".flac", ".m4a", ".ogg")):
                audio_choices.append(f)

    # 如果列表为空，添加占位符
    if len(audio_choices) == 1:
        audio_choices.append("[无示例音频]")

    return audio_choices


def _resolve_model_path(model_name: str, auto_download: bool, unique_id: Any) -> str:
    """解析模型路径"""
    model_dir = os.path.join(folder_paths.models_dir, MODEL_ROOT_NAME, model_name)

    if os.path.exists(model_dir):
        return model_dir

    if auto_download:
        _send_status(unique_id, f"模型 {model_name} 未找到，正在自动下载...", 0.1)
        print(f"\n[GJJ] 正在下载模型: {model_name}")

        try:
            huggingface_hub = load_dependency_at_runtime(
                module_name="huggingface_hub",
                node_name=NODE_DISPLAY_NAME,
                package_name="huggingface_hub",
                description="自动下载 SenseVoice 模型需要 huggingface_hub。",
                unique_id=unique_id,
            )
            snapshot_download = huggingface_hub.snapshot_download

            os.makedirs(model_dir, exist_ok=True)
            snapshot_download(
                repo_id=f"alibaba-damo-academy/{model_name}",
                local_dir=model_dir,
                local_dir_use_symlinks=False,
            )
            return model_dir
        except Exception as exc:
            raise_dependency_model_error(
                node_name=NODE_DISPLAY_NAME,
                missing_models=[
                    make_missing_model_spec(
                        label=model_name,
                        subdir=MODEL_ROOT_NAME,
                        filename=model_name,
                        description="模型自动下载失败，请手动补齐对应目录。",
                    )
                ],
                description="SenseVoice 模型下载失败。",
                original_error=str(exc),
                unique_id=unique_id,
                title="GJJ 节点模型缺失！",
                copy_text=f"https://huggingface.co/alibaba-damo-academy/{model_name}",
                copy_label="🌏 复制下载网址",
            )
    else:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[
                make_missing_model_spec(
                    label=model_name,
                    subdir=MODEL_ROOT_NAME,
                    filename=model_name,
                    description="请手动下载，或开启自动下载。",
                )
            ],
            description=f"未找到 SenseVoice 模型：models/{MODEL_ROOT_NAME}/{model_name}/",
            unique_id=unique_id,
            title="GJJ 节点模型缺失！",
            copy_text=f"https://huggingface.co/alibaba-damo-academy/{model_name}",
            copy_label="🌏 复制下载网址",
        )


def _audio_to_numpy(audio: Any) -> tuple[np.ndarray, int]:
    """将音频转换为 numpy 数组"""
    if isinstance(audio, dict) and "waveform" in audio:
        waveform = audio["waveform"]
        sample_rate = audio.get("sample_rate", 16000)

        if isinstance(waveform, torch.Tensor):
            waveform = waveform.cpu().numpy()

        if waveform.ndim == 3:
            waveform = waveform.squeeze(0)

        if waveform.ndim == 2 and waveform.shape[0] > 1:
            waveform = np.mean(waveform, axis=0)

        return waveform, int(sample_rate)
    else:
        raise ValueError("不支持的音频格式")


class GJJ_SenseVoiceASR:
    CATEGORY = "GJJ/Audio"
    FUNCTION = "transcribe"
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("时间戳表", "分段文本", "开始时间列表", "结束时间列表")
    DESCRIPTION = DESCRIPTION
    GJJ_HELP = {
        "title": NODE_DISPLAY_NAME,
        "description": _DESCRIPTION_READY,
        "notice": _HELP_NOTICE,
        "warning_message": _ENV_REPORT["warning_message"] if not _ENV_REPORT.get("available", True) else "",
        "install_cmd": _ENV_REPORT["install_cmd"] if not _ENV_REPORT.get("available", True) else "",
        "copy_text": _ENV_REPORT["copy_text"] if not _ENV_REPORT.get("available", True) else "",
        "copy_label": _ENV_REPORT["copy_label"] if not _ENV_REPORT.get("available", True) else "",
        "model_download_url": MODEL_DOWNLOAD_URL,
        "missing_dependencies": _MISSING_DEPENDENCIES,
        "missing_models": _MISSING_MODELS,
        "models": [REQUIRED_MODEL],
        "dependencies": [
            "funasr（SenseVoice 主运行库）",
            "soundfile（读取示例音频）",
            "huggingface_hub（模型自动下载时按需使用）",
        ],
        "tips": [
            "推荐优先把模型放到 models/ASR/SenseVoice-small-nonx/，避免首次执行时在线下载失败。",
            "CPU + int8 兼容性最好；CUDA 环境不完整时请先切回 CPU。",
            "若只是测试流程，可先在 models/mp3/ 放一个示例音频供下拉框选择。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        example_audio_files = _get_example_audio_files()
        return {
            "required": {},
            "optional": {
                "audio": (
                    "AUDIO",
                    {
                        "display_name": "输入音频",
                        "tooltip": "连接 ComfyUI 的音频对象，例如 Load Audio 节点输出。",
                    },
                ),
                "example_audio": (
                    example_audio_files,
                    {
                        "default": example_audio_files[0],
                        "display_name": "示例音频",
                        "tooltip": "从 models/mp3 目录选择示例音频进行识别。",
                    },
                ),
                "language": (
                    LANGUAGES,
                    {
                        "default": "中文",
                        "display_name": "识别语言",
                        "tooltip": "选择要识别的语言。",
                    },
                ),
                "device": (
                    DEVICE_OPTIONS,
                    {
                        "default": "CPU",
                        "display_name": "设备",
                        "tooltip": "选择运行设备（推荐使用 CPU 以避免 CUDA 问题）。",
                    },
                ),
                "compute_type": (
                    PRECISION_OPTIONS,
                    {
                        "default": "int8",
                        "display_name": "计算精度",
                        "tooltip": "选择计算精度（CPU 推荐使用 int8）。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def transcribe(
        self,
        audio: Any = None,
        example_audio: str = "",
        language: str = "中文",
        device: str = "CPU",
        compute_type: str = "int8",
        unique_id: Any = None,
        extra_pnginfo: Any = None,
    ) -> tuple[str, str, str, str]:
        auto_download = True

        try:
            start_time = time.time()

            # 步骤 1: 运行时检查依赖
            _load_sense_voice_runtime(unique_id)

            # 步骤 2: 准备输入音频
            _send_status(unique_id, "正在准备音频...", 0.1)
            # 如果提供了 example_audio，加载它作为 audio
            # 支持空字符串、'[无示例音频]' 或实际文件名
            if audio is None and example_audio and example_audio != "[无示例音频]":
                mp3_dir = os.path.join(folder_paths.models_dir, "mp3")
                audio_path = os.path.join(mp3_dir, example_audio)
                if os.path.exists(audio_path):
                    try:
                        sf = load_dependency_at_runtime(
                            module_name="soundfile",
                            node_name=NODE_DISPLAY_NAME,
                            package_name="soundfile",
                            description="SenseVoice 读取示例音频需要 soundfile。",
                            unique_id=unique_id,
                        )

                        audio_np, sample_rate = sf.read(audio_path, always_2d=True)
                        # soundfile 返回 (samples, channels)，需要转为 (channels, samples)
                        if audio_np.ndim == 1:
                            audio_np = audio_np.reshape(1, -1)
                        else:
                            audio_np = audio_np.T
                        waveform = torch.from_numpy(audio_np).float()
                        audio = {
                            "waveform": waveform.unsqueeze(0),
                            "sample_rate": int(sample_rate),
                        }
                    except Exception as e:
                        # 加载失败时给出警告，但不中断执行
                        import warnings

                        warnings.warn(f"⚠️ 加载示例音频失败: {e}")
                        # 继续执行，等待用户连接音频
                else:
                    # 文件不存在时（可能是旧工作流缓存），给出友好提示
                    import warnings

                    warnings.warn(
                        f"⚠️ 示例音频文件不存在: {example_audio}\n"
                        f"💡 提示：请从下拉列表重新选择，或连接音频输入。"
                    )

            if audio is None:
                raise RuntimeError("请输入音频或选择示例音频。")

            # 步骤 3: 转换音频
            waveform_np, sample_rate = _audio_to_numpy(audio)

            # 步骤 4: 解析模型路径
            _send_status(unique_id, f"正在解析模型...", 0.2)
            model_path = _resolve_model_path(MODEL_NAME, auto_download, unique_id)
            _send_status(unique_id, f"模型路径：{model_path}", 0.3)

            # 步骤 5: 解析设备和精度
            _send_status(unique_id, "正在加载模型到设备...", 0.4)

            device_map = {"自动": "auto", "CPU": "cpu", "CUDA": "cuda"}
            target_device = device_map.get(device, "cpu")

            precision_map = {
                "自动": "float16" if target_device == "cuda" else "int8",
                "float16": "float16",
                "float32": "float32",
                "int8": "int8",
            }
            target_precision = precision_map.get(compute_type, "int8")

            # CPU 不支持 float16，自动降级
            if target_device == "cpu" and target_precision == "float16":
                target_precision = "int8"

            # 步骤 6: 加载模型
            try:
                deps = _load_sense_voice_runtime(unique_id)
                AutoModel = deps["AutoModel"]
                model = AutoModel(
                    model=model_path, device=target_device, disable_update=True
                )
            except Exception as exc:
                error_msg = str(exc)

                # 检测是否为 CUDA 错误
                is_cuda_error = (
                    "CUDA error" in error_msg
                    or "cuda" in error_msg.lower()
                    or "cublas64_12.dll" in error_msg
                    or "cudnn" in error_msg.lower()
                )

                if is_cuda_error and target_device != "cpu":
                    _send_status(
                        unique_id, "⚠️ 检测到 CUDA 错误，正在降级到 CPU...", 0.45
                    )
                    print(f"\n⚠️ [GJJ] 检测到 CUDA 错误，自动降级到 CPU 模式")
                    print(f"   原始错误：{error_msg[:200]}")

                    target_device = "cpu"
                    target_precision = "int8"
                    model = AutoModel(
                        model=model_path, device=target_device, disable_update=True
                    )
                else:
                    raise

            # 步骤 7: 执行识别
            _send_status(unique_id, "正在执行语音识别...", 0.5)

            result = model.generate(input=waveform_np, cache={})

            # 步骤 8: 处理结果
            _send_status(unique_id, "正在处理识别结果...", 0.8)

            text_parts = []
            timestamps = []
            start_times = []
            end_times = []

            # 解析结果
            if result and len(result) > 0:
                for res in result:
                    text = res.get("text", "").strip()
                    if text:
                        text_parts.append(text)
                        timestamps.append(
                            {
                                "start": 0.0,
                                "end": 0.0,
                                "text": text,
                            }
                        )

            full_text = "\n".join(text_parts)
            timestamps_json = json.dumps(timestamps, ensure_ascii=False, indent=2)
            start_times_str = ", ".join(
                f"{t.get('start', 0.0):.2f}" for t in timestamps
            )
            end_times_str = ", ".join(f"{t.get('end', 0.0):.2f}" for t in timestamps)

            elapsed = time.time() - start_time
            _send_status(
                unique_id,
                f"识别完成！用时 {elapsed:.1f}s | {len(text_parts)} 个片段",
                1.0,
            )

            # 发送结果到前端
            _send_result_to_frontend(unique_id, full_text)

            return (timestamps_json, full_text, start_times_str, end_times_str)

        except Exception as exc:
            report = get_report_from_exception(exc)
            if report:
                _send_status(unique_id, "执行失败，请查看上方面板", 1.0)
                send_dependency_model_notice(report, unique_id=unique_id)
                raise RuntimeError(report.get("warning_message") or "运行环境缺失。") from exc

            _send_status(unique_id, f"执行失败：{exc}", 1.0)
            error_msg = str(exc)

            # 检测是否为 CUDA 错误
            if (
                "CUDA error" in error_msg or "cuda" in error_msg.lower()
            ) and torch.cuda.is_available():
                cuda_error = (
                    "🎤 SenseVoice 执行失败（CUDA 错误）\n\n"
                    "❌ CUDA 兼容性错误：您的 GPU 架构与当前 PyTorch/CUDA 版本不兼容。\n\n"
                    "💡 解决方案：\n"
                    "1. 检查 GPU 型号和 CUDA 版本是否匹配\n"
                    "2. 尝试使用 CPU 模式（在节点设置中切换设备为 CPU）\n"
                    "3. 更新 PyTorch 到最新版本以支持您的 GPU\n\n"
                    f"原始错误：{error_msg}"
                )
                _send_error_to_frontend(unique_id, cuda_error)
                raise RuntimeError(cuda_error) from exc

            detailed_error = f"🎤 SenseVoice 执行失败\n\n详细错误：{error_msg}"
            _send_error_to_frontend(unique_id, detailed_error)
            raise RuntimeError(detailed_error) from exc


# ═══════════════════════════════════════════════
# 注册到全局映射
# ═══════════════════════════════════════════════
NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_SenseVoiceASR,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "🎤 语音识别 (SenseVoice)",
}
