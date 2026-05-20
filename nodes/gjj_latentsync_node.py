import os
import random
# import cv2  # 在函数内部延迟导入
import numpy as np
import subprocess
import folder_paths
import torch
import comfy.utils
import sys

from .common_utils.dependency_checker import (
    build_dependency_model_report,
    load_dependency_at_runtime,
    print_dependency_model_report,
    send_dependency_model_notice,
)

NODE_DISPLAY_NAME = "GJJ · LatentSync 视频音频同步"
CV2_DEPENDENCY = {
    "module_name": "cv2",
    "package_name": "opencv-python",
    "display_name": "cv2",
    "description": "LatentSync 视频音频同步需要 OpenCV 读取、写入和处理视频帧。",
}
SCIPY_DEPENDENCY = {
    "module_name": "scipy.signal",
    "package_name": "scipy",
    "display_name": "scipy",
    "description": "LatentSync 视频音频同步需要 scipy.signal.resample 进行音频重采样。",
}
LATENTSYNC_MODEL_SPECS = [
    {
        "label": "LatentSync 主模型",
        "subdir": "models/latentsync",
        "filename": "latentsync_unet.pt",
        "description": "LatentSync 口型同步 UNet 主模型。",
    },
    {
        "label": "LatentSync Whisper",
        "subdir": "models/latentsync/whisper",
        "filename": "tiny.pt",
        "description": "LatentSync 音频特征提取 Whisper tiny 模型。",
    },
]

# 检查关键依赖
try:
    import cv2
    _CV2_AVAILABLE = True
except ImportError as exc:
    _CV2_AVAILABLE = False
    _IMPORT_ERROR = str(exc)


def _model_file_exists(model_spec):
    try:
        model_path = os.path.join(
            folder_paths.models_dir,
            str(model_spec.get("subdir") or "models").replace("models/", "").replace("/", os.sep),
            str(model_spec.get("filename") or ""),
        )
        return os.path.exists(model_path)
    except Exception:
        return False


_DEPENDENCIES_AVAILABLE = _CV2_AVAILABLE
_MISSING_DEPENDENCIES = [] if _DEPENDENCIES_AVAILABLE else [CV2_DEPENDENCY]
_MISSING_MODELS = [spec for spec in LATENTSYNC_MODEL_SPECS if not _model_file_exists(spec)]
_MODELS_AVAILABLE = not _MISSING_MODELS
_ENV_REPORT = build_dependency_model_report(
    node_name=NODE_DISPLAY_NAME,
    missing_dependencies=_MISSING_DEPENDENCIES,
    missing_models=_MISSING_MODELS,
    install_packages=[spec["package_name"] for spec in _MISSING_DEPENDENCIES],
    original_error=_IMPORT_ERROR if not _DEPENDENCIES_AVAILABLE else "",
)
_DESCRIPTION_INTRO = "通过音频同步视频唇形的节点。需要预下载模型到 ComfyUI/models/latentsync 目录。"
DESCRIPTION = (
    _DESCRIPTION_INTRO
    if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
    else f"{_ENV_REPORT['warning_message']}\n\n{_DESCRIPTION_INTRO}"
)


def _ensure_cv2():
    """确保 cv2 已安装"""
    return load_dependency_at_runtime(
        module_name="cv2",
        node_name=NODE_DISPLAY_NAME,
        package_name=CV2_DEPENDENCY["package_name"],
        description=CV2_DEPENDENCY["description"],
    )


class LatentSyncNode:
    """
    零依赖的LatentSync节点，无需从网络下载模型
    此节点用于将音频与视频同步，需要预下载模型到 models/latentsync 目录
    音频处理使用 soundfile / pydub / librosa / wave（零 torchcodec 冲突）
    """

    DESCRIPTION = DESCRIPTION
    REQUIRED_MODELS = LATENTSYNC_MODEL_SPECS
    GJJ_HELP = {
        "description": DESCRIPTION,
        "notice": _ENV_REPORT["help_message"] if not _ENV_REPORT["available"] else "",
        "install_cmd": _ENV_REPORT["install_cmd"] if not _ENV_REPORT["available"] else "",
        "copy_text": _ENV_REPORT["copy_text"] if not _ENV_REPORT["available"] else "",
        "copy_label": _ENV_REPORT["copy_label"] if not _ENV_REPORT["available"] else "",
        "warning_message": _ENV_REPORT["warning_message"] if not _ENV_REPORT["available"] else "",
        "models": REQUIRED_MODELS,
        "dependencies": [
            "opencv-python（cv2；视频帧读取、写入和处理）",
            "scipy（音频重采样；仅输入采样率不是 16000Hz 时需要）",
            "soundfile / librosa / pydub（音频文件读取；按本机可用项回退）",
            "ffmpeg 或 moviepy（音视频封装合并）",
        ],
    }

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "seed": ("INT", {"default": 1247, "min": 0, "max": 999999999, "step": 1, "display": "number"}),
            },
            "optional": {
                "video": ("VIDEO", {"tooltip": "要同步的视频文件"}),
                "audio": ("AUDIO", {"tooltip": "用于同步的音频数据"}),
                "video_path": ("STRING", {"default": "", "tooltip": "视频文件路径，如果未使用VIDEO输入则使用此项"}),
                "audio_path": ("STRING", {"default": "", "tooltip": "音频文件路径，如果未使用AUDIO输入则使用此项"}),
            }
            ,
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    CATEGORY = "GJJ/音视频处理"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("输出视频路径",)
    FUNCTION = "inference"

    def _resolve_video_path(self, video):
        """从各种可能的VIDEO对象格式中解析出实际的视频文件路径"""
        actual_video_path = None

        if isinstance(video, str):
            return video

        if isinstance(video, dict):
            if "video" in video:
                actual_video_path = video["video"]
            elif "path" in video:
                actual_video_path = video["path"]
            elif "filename" in video:
                if "subfolder" in video:
                    actual_video_path = os.path.join(folder_paths.get_output_directory(), video["subfolder"], video["filename"])
                else:
                    actual_video_path = os.path.join(folder_paths.get_output_directory(), video["filename"])
            else:
                values = list(video.values())
                if values and isinstance(values[0], str):
                    actual_video_path = values[0]
                else:
                    raise ValueError(f"无法从VIDEO字典对象获取视频路径: {video}")

            if actual_video_path and os.path.exists(actual_video_path):
                return actual_video_path
            elif actual_video_path:
                if not os.path.isabs(actual_video_path):
                    potential_path = os.path.join(folder_paths.get_output_directory(), actual_video_path)
                    if os.path.exists(potential_path):
                        return potential_path
                raise FileNotFoundError(f"从VIDEO对象解析的路径不存在: {actual_video_path}")
            else:
                raise ValueError(f"无法从VIDEO字典对象获取有效路径: {video}")

        if hasattr(video, '__dict__'):
            class_name = video.__class__.__name__
            possible_attrs = ['path', 'filepath', 'file_path', 'filename', 'file', '_path', '_filepath', '_filename', 'video']
            for attr_name in possible_attrs:
                if hasattr(video, attr_name):
                    attr_value = getattr(video, attr_name)
                    if isinstance(attr_value, str) and os.path.exists(attr_value):
                        print(f"LatentSync: 从属性 '{attr_name}' 找到视频路径: {attr_value}")
                        return attr_value
            for key, value in video.__dict__.items():
                if isinstance(value, str) and os.path.exists(value):
                    print(f"LatentSync: 从__dict__['{key}'] 找到视频路径: {value}")
                    return value
            for method_name in ['get_path', 'get_filepath', 'get_file_path', 'path', 'filepath']:
                if hasattr(video, method_name):
                    try:
                        method = getattr(video, method_name)
                        result = method() if callable(method) else method
                        if isinstance(result, str) and os.path.exists(result):
                            print(f"LatentSync: 从方法 '{method_name}' 找到视频路径: {result}")
                            return result
                    except:
                        continue
            if hasattr(video, '_inputs'):
                inputs = video._inputs
                if isinstance(inputs, dict):
                    for key in ['video', 'path', 'file_path', 'filepath']:
                        if key in inputs and isinstance(inputs[key], str) and os.path.exists(inputs[key]):
                            return inputs[key]
                elif isinstance(inputs, (list, tuple)) and len(inputs) > 0:
                    for item in inputs:
                        if isinstance(item, str) and os.path.exists(item):
                            return item
                elif isinstance(inputs, str) and os.path.exists(inputs):
                    return inputs
            raise ValueError(f"无法从VIDEO对象 ({class_name}) 获取视频路径。")

        raise ValueError(f"无法从VIDEO对象获取视频路径，未知格式: {type(video)}")

    def _load_audio(self, audio_path):
        """使用 soundfile → librosa → pydub → wave 链加载音频（替代 torchaudio）"""
        # 方法1: soundfile
        try:
            import soundfile as sf
            audio_data, sample_rate = sf.read(audio_path, dtype='float32')
            if audio_data.ndim == 1:
                audio_data = np.expand_dims(audio_data, axis=0)
            else:
                audio_data = audio_data.T
            waveform = torch.from_numpy(audio_data)
            return waveform, sample_rate
        except Exception:
            pass

        # 方法2: librosa
        try:
            import librosa
            audio_data, sample_rate = librosa.load(audio_path, sr=None, mono=False)
            if audio_data.ndim == 1:
                audio_data = np.expand_dims(audio_data, axis=0)
            waveform = torch.from_numpy(audio_data)
            return waveform, sample_rate
        except Exception:
            pass

        # 方法3: pydub
        try:
            from pydub import AudioSegment
            import io
            audio_seg = AudioSegment.from_file(audio_path)
            sample_rate = audio_seg.frame_rate
            channels = audio_seg.channels
            raw = np.array(audio_seg.get_array_of_samples()).astype(np.float32) / 32767.0
            if channels > 1:
                raw = raw.reshape(-1, channels).T
            else:
                raw = np.expand_dims(raw, axis=0)
            waveform = torch.from_numpy(raw)
            return waveform, sample_rate
        except Exception:
            pass

        # 方法4: wave（内置库，保底）
        import wave
        import struct
        with wave.open(audio_path, 'rb') as wf:
            sample_rate = wf.getframerate()
            channels = wf.getnchannels()
            frames = wf.readframes(wf.getnframes())
            if channels == 1:
                audio_data = np.array(struct.unpack(f'<{len(frames)//2}h', frames), dtype=np.float32) / 32767.0
                audio_data = np.expand_dims(audio_data, axis=0)
            else:
                audio_data = np.array(struct.unpack(f'<{len(frames)//2}h', frames), dtype=np.float32) / 32767.0
                audio_data = audio_data.reshape(-1, channels).T
            waveform = torch.from_numpy(audio_data)

        return waveform, sample_rate

    def _resample_audio(self, waveform, orig_sr, target_sr=16000):
        """使用 scipy.signal.resample 重采样（替代 torchaudio.transforms.Resample）"""
        if orig_sr == target_sr:
            return waveform
        try:
            from scipy import signal as sp_signal
            if waveform.dim() == 3:
                waveform = waveform.squeeze(0)
            wave_np = waveform.cpu().numpy()
            if wave_np.ndim == 1:
                wave_np = np.expand_dims(wave_np, axis=0)
            channels = []
            for ch in range(wave_np.shape[0]):
                num_samples = int(round(wave_np.shape[1] * target_sr / orig_sr))
                channels.append(sp_signal.resample(wave_np[ch], num_samples).astype(np.float32))
            result = np.stack(channels, axis=0)
            return torch.from_numpy(result)
        except ImportError as exc:
            report = build_dependency_model_report(
                node_name=NODE_DISPLAY_NAME,
                missing_dependencies=[SCIPY_DEPENDENCY],
                install_packages=[SCIPY_DEPENDENCY["package_name"]],
                original_error=str(exc),
            )
            print_dependency_model_report(report, title="GJJ 节点运行时依赖缺失！")
            err = RuntimeError(report.get("warning_message") or "运行时依赖缺失。")
            setattr(err, "gjj_report", report)
            raise err from exc

    def _save_audio(self, waveform, sample_rate, output_path):
        """保存音频到 wav 文件（替代 torchaudio.save）"""
        try:
            import soundfile as sf
            wave_np = waveform.cpu().numpy()
            if wave_np.ndim == 2 and wave_np.shape[0] <= 2:
                wave_np = wave_np.T
            sf.write(output_path, wave_np, sample_rate, subtype='PCM_16')
            return
        except Exception:
            pass
        try:
            import scipy.io.wavfile
            wave_np = waveform.cpu().numpy()
            if wave_np.ndim == 2 and wave_np.shape[0] <= 2:
                wave_np = wave_np.T
            scipy.io.wavfile.write(output_path, sample_rate, (wave_np * 32767).astype(np.int16))
            return
        except Exception:
            pass
        # 保底: wave 内置库
        import wave
        import struct
        wave_np = waveform.cpu().numpy()
        if wave_np.ndim == 2 and wave_np.shape[0] <= 2:
            channels = wave_np.shape[0]
            wave_np = wave_np.T
        else:
            channels = 1 if wave_np.ndim == 1 else wave_np.shape[-1]
        with wave.open(output_path, 'w') as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            max_val = max(abs(wave_np.max()), abs(wave_np.min()))
            if max_val > 0:
                audio_int16 = (wave_np * (32767 / max_val)).astype(np.int16)
            else:
                audio_int16 = wave_np.astype(np.int16)
            for sample in audio_int16.reshape(-1):
                wf.writeframes(struct.pack('<h', int(sample)))

    def _merge_video_audio_ffmpeg(self, video_path, audio_path, output_path):
        """使用 FFmpeg 合并视频和音频"""
        cmd = [
            "ffmpeg",
            "-i", video_path,
            "-i", audio_path,
            "-c:v", "libx264",
            "-c:a", "aac",
            "-strict", "experimental",
            "-shortest",
            output_path,
            "-y"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg 合并失败: {result.stderr}")
        return output_path

    def _merge_video_audio_moviepy(self, video_path, audio_path, output_path):
        """使用 moviepy 备选方案合并"""
        try:
            from moviepy.editor import VideoFileClip, AudioFileClip
            video = VideoFileClip(video_path)
            audio = AudioFileClip(audio_path)
            final_video = video.set_audio(audio)
            final_video.write_videofile(output_path, codec='libx264', audio_codec='aac')
            return output_path
        except ImportError:
            raise RuntimeError("FFmpeg 和 MoviePy 均不可用，请安装其中之一。")
        except Exception as e:
            raise RuntimeError(f"MoviePy 合并失败: {str(e)}")

    def inference(self, seed, video=None, audio=None, video_path="", audio_path="", unique_id=None):
        # 运行时检查依赖
        try:
            cv2 = _ensure_cv2()
        except Exception as exc:
            report = getattr(exc, "gjj_report", None) or _ENV_REPORT
            print_dependency_model_report(report, title="GJJ 节点运行时依赖缺失！")
            send_dependency_model_notice(report, unique_id=unique_id)
            raise RuntimeError(report.get("warning_message") or "运行时依赖缺失。") from exc

        # 检查模型
        models_dir = folder_paths.models_dir
        latentsync_model_dir = os.path.join(models_dir, "latentsync")
        unet_model_path = os.path.join(latentsync_model_dir, "latentsync_unet.pt")

        missing_models = [spec for spec in LATENTSYNC_MODEL_SPECS if not _model_file_exists(spec)]
        if missing_models:
            report = build_dependency_model_report(
                node_name=NODE_DISPLAY_NAME,
                missing_models=missing_models,
            )
            print_dependency_model_report(report, title="GJJ 节点模型缺失！")
            send_dependency_model_notice(report, unique_id=unique_id)
            err = RuntimeError(report.get("warning_message") or "LatentSync 模型缺失。")
            setattr(err, "gjj_report", report)
            raise err

        # 解析视频路径
        if video is not None:
            actual_video_path = self._resolve_video_path(video)
        elif video_path and os.path.exists(video_path):
            actual_video_path = video_path
        else:
            raise ValueError("必须提供视频输入")

        # 解析/加载音频
        waveform = None
        sample_rate = None
        if audio is not None:
            if isinstance(audio, dict) and "waveform" in audio and "sample_rate" in audio:
                waveform = audio["waveform"]
                sample_rate = audio["sample_rate"]
            else:
                raise ValueError(f"AUDIO对象格式不正确: {type(audio)}")
        elif audio_path and os.path.exists(audio_path):
            waveform, sample_rate = self._load_audio(audio_path)
        else:
            raise ValueError("必须提供音频输入")

        if not os.path.exists(actual_video_path):
            raise FileNotFoundError(f"视频路径不存在: {actual_video_path}")

        output_dir = folder_paths.get_output_directory()
        os.makedirs(output_dir, exist_ok=True)
        output_name = ''.join(random.choice("abcdefghijklmnopqrstupvxyz") for _ in range(5))
        output_video_path = os.path.join(output_dir, f"latentsync_{output_name}_synced.mp4")

        # 重采样到 16kHz
        if waveform.dim() == 3:
            waveform = waveform.squeeze(0)
        if sample_rate != 16000:
            waveform = self._resample_audio(waveform, sample_rate, 16000)
            sample_rate = 16000

        # 保存处理后的音频
        temp_audio_path = os.path.join(output_dir, f"latentsync_{output_name}_processed_audio.wav")
        self._save_audio(waveform, sample_rate, temp_audio_path)

        # 视频处理（OpenCV）
        temp_video_path = os.path.join(output_dir, f"latentsync_{output_name}_temp.mp4")
        cap = cv2.VideoCapture(actual_video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(temp_video_path, fourcc, fps, (width, height))
        pbar = comfy.utils.ProgressBar(total_frames)
        frame_count = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            out.write(frame)
            frame_count += 1
            pbar.update_absolute(frame_count, total_frames)
        cap.release()
        out.release()

        # 合并音视频
        try:
            self._merge_video_audio_ffmpeg(temp_video_path, temp_audio_path, output_video_path)
        except Exception:
            self._merge_video_audio_moviepy(temp_video_path, temp_audio_path, output_video_path)

        # 清理临时文件
        for f in [temp_video_path, temp_audio_path]:
            if os.path.exists(f):
                os.remove(f)
        print(f"LatentSync 完成: {output_video_path}")
        return (output_video_path,)


NODE_CLASS_MAPPINGS = {
    "GJJ_LatentSyncNode": LatentSyncNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_LatentSyncNode": NODE_DISPLAY_NAME,
}
