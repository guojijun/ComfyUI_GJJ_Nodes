from __future__ import annotations

import importlib.util
import sys
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import soundfile as sf
from scipy import signal as sp_signal


NODE_NAME = "GJJ_LocalLipSync"

MODE_AUTO = "自动：图片用LTX，视频用LatentSync"
MODE_LTX23 = "LTX2.3 图片说话"
MODE_LATENTSYNC = "LatentSync1.6 视频口型"
MODE_WAN22 = "Wan2.2 S2V 环境检测"

DEFAULT_PROMPT = "真人半身近景，面对镜头自然说话，口型与输入音频同步，嘴部开合准确，头部轻微自然动作，电影感光影。"
DEFAULT_NEGATIVE = (
    "blurry, oversaturated, pixelated, low resolution, grainy, distorted, noise, "
    "compression artifacts, watermark, text, logo, subtitles, distorted mouth, bad lip sync"
)


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _gjj_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _custom_nodes_root() -> Path:
    return _gjj_root().parent


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        payload = {"node": str(unique_id), "text": str(text or "")}
        if progress is not None:
            payload["progress"] = max(0.0, min(1.0, float(progress)))
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


# ─── 图像/帧处理（numpy/cv2） ─────────────────────────────────────


def _ensure_image_batch(images: Any) -> np.ndarray:
    """验证图像/帧数据为 numpy ndarray [B, H, W, C] float32 0~1 格式。"""
    if images is None:
        raise RuntimeError("未收到有效图像。")
    if not isinstance(images, np.ndarray):
        raise RuntimeError(f"图像/视频帧不是有效 numpy 数组：{type(images)!r}")
    if images.ndim == 3:
        images = np.expand_dims(images, axis=0)
    if images.ndim != 4:
        raise RuntimeError(f"图像/视频帧维度无效：{tuple(images.shape)}，应为 [批次, 高, 宽, 通道]。")
    if int(images.shape[0]) <= 0:
        raise RuntimeError("输入图像/视频没有可处理的帧。")
    if int(images.shape[-1]) not in (3, 4):
        raise RuntimeError(f"图像/视频帧通道数无效：{int(images.shape[-1])}。")
    return images.astype(np.float32).clip(0.0, 1.0)


def _frames_to_torch(frames: np.ndarray) -> Any:
    """将 numpy 帧数组转为 torch.Tensor（ComfyUI IMAGE 格式）。"""
    import torch
    return torch.from_numpy(frames).float().contiguous()


def _audio_to_torch(audio: dict[str, Any]) -> dict[str, Any]:
    """将音频 dict 中的 waveform 从 numpy 转为 torch.Tensor（ComfyUI AUDIO 格式）。"""
    import torch
    waveform = audio.get("waveform")
    if isinstance(waveform, np.ndarray):
        result = dict(audio)
        result["waveform"] = torch.from_numpy(waveform).float().contiguous()
        return result
    return audio


# ─── 视频组件提取（入口处将 ComfyUI torch → numpy） ────────────


def _extract_video_components(video: Any) -> tuple[np.ndarray, Any, float]:
    """从 VIDEO 对象提取帧 numpy 数组、音频和帧率。"""
    if video is None:
        raise RuntimeError("视频口型同步需要连接输入视频。")
    if isinstance(video, np.ndarray):
        return _ensure_image_batch(video), None, 24.0
    if not hasattr(video, "get_components"):
        raise RuntimeError("输入视频不是有效 VIDEO 对象。请连接 ComfyUI 核心 Load Video 或其它 VIDEO 输出。")
    try:
        components = video.get_components()
        import torch
        torch_images = getattr(components, "images", None)
        if torch_images is not None:
            frames = _ensure_image_batch(torch_images.detach().cpu().numpy())
        else:
            raise RuntimeError("VIDEO 对象缺少 images 数据。")
        audio = getattr(components, "audio", None)
        frame_rate = float(getattr(components, "frame_rate", 24.0) or 24.0)
        return frames, audio, frame_rate
    except Exception as exc:
        raise RuntimeError(f"读取输入视频失败。\n详细错误：{exc}") from exc


def _is_video_object(value: Any) -> bool:
    return value is not None and hasattr(value, "get_components")


def _extract_video_first_frame(video: Any) -> tuple[np.ndarray | None, Any, float | None]:
    if video is None:
        return None, None, None
    frames, audio, frame_rate = _extract_video_components(video)
    return frames[:1].copy(), audio, frame_rate


def _make_video(frames: np.ndarray, audio: Any, fps: float):
    """将 numpy 帧数组封装为 ComfyUI VIDEO 对象（内部转回 torch.Tensor）。"""
    try:
        from comfy_api.latest import InputImpl, Types
        import torch

        return InputImpl.VideoFromComponents(
            Types.VideoComponents(
                images=torch.from_numpy(frames).float().contiguous(),
                audio=audio,
                frame_rate=Fraction(str(float(fps or 24.0))).limit_denominator(1000),
            )
        )
    except Exception as exc:
        raise RuntimeError(f"创建 VIDEO 输出失败。\n详细错误：{exc}") from exc


# ─── 音频处理（numpy / soundfile / scipy，替代 torchaudio） ─────


def _has_valid_audio(audio: Any) -> bool:
    """检查音频 dict 是否有效，支持 numpy 或 torch waveform。"""
    if not isinstance(audio, dict):
        return False
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate", 0) or 0)
    if isinstance(waveform, np.ndarray) and waveform.size > 0 and sample_rate > 0:
        return True
    import torch
    if isinstance(waveform, torch.Tensor) and waveform.numel() > 0 and sample_rate > 0:
        return True
    return False


def _audio_waveform_to_numpy(audio: dict[str, Any]) -> dict[str, Any]:
    """确保音频 dict 中的 waveform 为 numpy ndarray。"""
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate", 0) or 0)
    if isinstance(waveform, np.ndarray):
        result = dict(audio)
        result["sample_rate"] = sample_rate
        return result
    import torch
    if isinstance(waveform, torch.Tensor):
        result = dict(audio)
        result["waveform"] = waveform.detach().cpu().numpy()
        result["sample_rate"] = sample_rate
        return result
    raise RuntimeError("无法将音频 waveform 转为 numpy：未知格式。")


def _trim_audio(audio: dict[str, Any], max_seconds: float) -> dict[str, Any]:
    """裁切音频到指定秒数，内部使用 numpy waveform。"""
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate", 0) or 0)

    if not isinstance(waveform, np.ndarray) or sample_rate <= 0 or waveform.size == 0:
        raise RuntimeError("输入音频格式无效，缺少 waveform 或 sample_rate。")
    max_samples = max(1, int(round(float(max_seconds) * float(sample_rate))))
    if waveform.shape[-1] <= max_samples:
        result = dict(audio)
        result["waveform"] = waveform
        result["sample_rate"] = sample_rate
        return result
    result = dict(audio)
    result["waveform"] = waveform[..., :max_samples].copy()
    result["sample_rate"] = sample_rate
    return result


def _audio_duration_seconds(audio: dict[str, Any]) -> float:
    """计算音频时长（秒），支持 numpy waveform。"""
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate", 0) or 0)
    if not isinstance(waveform, np.ndarray) or sample_rate <= 0 or waveform.size == 0:
        raise RuntimeError("输入音频格式无效，缺少 waveform 或 sample_rate。")
    return float(waveform.shape[-1]) / float(sample_rate)


def _resample_audio(waveform: np.ndarray, orig_sr: int, target_sr: int = 16000) -> np.ndarray:
    """使用 scipy.signal.resample 对音频波形重采样（替代 torchaudio.transforms.Resample）。"""
    if orig_sr == target_sr:
        return waveform
    if waveform.ndim == 1:
        num_samples = int(round(len(waveform) * target_sr / orig_sr))
        return sp_signal.resample(waveform, num_samples).astype(np.float32)
    channels = []
    for ch in range(waveform.shape[0]):
        num_samples = int(round(waveform.shape[1] * target_sr / orig_sr))
        channels.append(sp_signal.resample(waveform[ch], num_samples).astype(np.float32))
    return np.stack(channels, axis=0)


# ─── 模块加载 ──────────────────────────────────────────────────


def _import_module_from_path(module_name: str, path: Path):
    spec = importlib.util.spec_from_file_location(module_name, str(path))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 GJJ 内部模块：{path}")
    module = importlib.util.module_from_spec(spec)
    old_path = list(sys.path)
    try:
        node_dir = str(path.parent)
        if node_dir not in sys.path:
            sys.path.insert(0, node_dir)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path[:] = old_path


def _pop_modules(prefixes: tuple[str, ...]) -> dict[str, Any]:
    removed = {}
    for name in list(sys.modules):
        if any(name == prefix or name.startswith(prefix + ".") for prefix in prefixes):
            removed[name] = sys.modules.pop(name)
    return removed


def _restore_modules(modules: dict[str, Any]) -> None:
    for name, module in modules.items():
        sys.modules.setdefault(name, module)


# ─── LatentSync ────────────────────────────────────────────────


def _get_internal_latentsync_class():
    node_path = _gjj_root() / "vendor" / "latentsync_enhanced" / "nodes.py"
    if not node_path.is_file():
        raise RuntimeError("GJJ 内部 LatentSync 运行库不存在，请确认 vendor/latentsync_enhanced 已随 GJJ 一起复制。")
    removed = _pop_modules(("latentsync",))
    try:
        module = _import_module_from_path("gjj_internal_latentsync_enhanced", node_path)
        return getattr(module, "NODE_CLASS_MAPPINGS", {})["LatentSyncEnhanced"]
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "GJJ 内部 LatentSync 运行库已找到，但当前 Python 缺少必要包。\n"
            f"缺失模块：{exc.name}\n"
            "请安装 GJJ/vendor/latentsync_enhanced/requirements.txt 中的依赖。"
        ) from exc
    except Exception as exc:
        raise RuntimeError(f"加载 GJJ 内部 LatentSync 运行库失败。\n详细错误：{exc}") from exc
    finally:
        _restore_modules(removed)


# ─── 环境检测 ──────────────────────────────────────────────────


def _check_latentsync_models() -> list[str]:
    details: list[str] = []
    try:
        import folder_paths
        models_dir = Path(folder_paths.models_dir)
    except Exception:
        models_dir = None
    # Priority 1: models/latentsync/
    found_root = models_dir / "latentsync" if models_dir else None
    if found_root and found_root.is_dir():
        details.append(f"LatentSync 模型目录：{found_root}")
        for rel in ("latentsync_unet.pt", "whisper/tiny.pt", "vae/config.json", "vae/diffusion_pytorch_model.safetensors"):
            p = found_root / rel
            details.append(f"{rel}：{'已找到' if p.is_file() else '未找到'}")
        return details
    # Priority 2: checkpoints/LatentSync-1.6/
    try:
        roots = folder_paths.get_folder_paths("checkpoints")
        for root in roots:
            candidate = Path(root) / "LatentSync-1.6"
            if candidate.is_dir():
                found_root = candidate
                break
    except Exception:
        pass
    if found_root is None:
        details.append("LatentSync 模型目录：未找到，期望 models/latentsync/ 或 models/checkpoints/LatentSync-1.6/")
    else:
        details.append(f"LatentSync 模型目录：{found_root}")
        for rel in ("latentsync_unet.pt", "whisper/tiny.pt", "vae/config.json", "vae/diffusion_pytorch_model.safetensors"):
            p = found_root / rel
            details.append(f"{rel}：{'已找到' if p.is_file() else '未找到'}")
    return details


def _check_wan22_s2v_environment() -> str:
    details: list[str] = []
    try:
        import folder_paths

        diffusion_models = folder_paths.get_filename_list("diffusion_models")
        audio_encoders = folder_paths.get_filename_list("audio_encoders")
        has_s2v = any("wan2.2" in item.lower() and "s2v" in item.lower() for item in diffusion_models)
        has_wav2vec = any("wav2vec" in item.lower() for item in audio_encoders)
        details.append(f"Wan2.2 S2V 权重：{'已找到' if has_s2v else '未找到'}")
        details.append(f"音频编码器 wav2vec：{'已找到' if has_wav2vec else '未找到'}")
    except Exception as exc:
        details.append(f"模型目录检测失败：{exc}")
    raise RuntimeError(
        "Wan2.2 S2V 需要走真实音频条件链路，不能用普通 Wan I2V 假装口型同步。\n"
        "当前 GJJ 节点已保留环境检测入口；完整 Wan2.2 S2V 零外部节点需要单独迁移 Wan S2V 运行时。\n"
        + "\n".join(details)
    )


# ─── 主节点 ────────────────────────────────────────────────────


class GJJ_LocalLipSync:
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    DESCRIPTION = "GJJ 内部本地零 API 口型同步：图片+音频使用 GJJ 已有 LTX2.3 功能，视频+音频使用 GJJ 内部 LatentSync 或 LatentSync 功能；只引用 ComfyUI 官方能力和 GJJ 包内功能，不依赖其它自定义节点。"
    SEARCH_ALIASES = ["口型同步", "唇形同步", "数字人", "lipsync", "LatentSync", "LTX2.3", "Wan2.2"]
    GJJ_HELP = {
        "models": [
            {
                "label": "LTX2.3 主模型",
                "value": "models/checkpoints/ltx-2.3-22b 或 models/checkpoints/ltx-2.3-22b-dev-fp8.safetensors",
                "tooltip": "图片+音频分支使用；实际加载会按本机 checkpoints 列表做子目录感知匹配。",
            },
            {
                "label": "LTX2.3 文本编码器",
                "value": "models/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors",
                "tooltip": "LTX2.3 图片说话分支需要的文本编码器。",
            },
            {
                "label": "LTX2.3 蒸馏 LoRA",
                "value": "models/loras/LTX/ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
                "tooltip": "LTX2.3 图片说话分支默认 LoRA 1。",
            },
            {
                "label": "LTX2.3 口型同步 LoRA",
                "value": "models/loras/LTX/LTX-2.3-22b-AV-LoRA-talking-head-v1-音视频同步.safetensors",
                "tooltip": "LTX2.3 图片说话分支默认 LoRA 2，用于音视频口型同步。",
            },
            {
                "label": "LTX2.3 潜空间放大模型",
                "value": "models/upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
                "tooltip": "LTX2.3 高分辨率阶段可能使用的 latent upscaler。",
            },
            {
                "label": "LTX2.3 视频 VAE",
                "value": "models/vae/LTX23_video_vae_bf16.safetensors",
                "tooltip": "LTX2.3 音视频工作流常用的视频 VAE；本节点按本机 LTX 运行链路加载。",
            },
            {
                "label": "LTX2.3 音频 VAE",
                "value": "models/vae/LTX23_audio_vae_bf16.safetensors",
                "tooltip": "LTX2.3 音频驱动口型链路常用的音频 VAE。",
            },
            {
                "label": "LatentSync 1.6 主模型",
                "value": "models/checkpoints/LatentSync-1.6/latentsync_unet.pt",
                "tooltip": "视频+音频默认分支使用的口型扩散 UNet。",
            },
            {
                "label": "LatentSync 1.6 Whisper",
                "value": "models/checkpoints/LatentSync-1.6/whisper/tiny.pt",
                "tooltip": "LatentSync 音频特征提取模型。",
            },
            {
                "label": "LatentSync 1.6 VAE 配置",
                "value": "models/checkpoints/LatentSync-1.6/vae/config.json",
                "tooltip": "LatentSync VAE 目录配置文件。",
            },
            {
                "label": "LatentSync 1.6 VAE 权重",
                "value": "models/checkpoints/LatentSync-1.6/vae/diffusion_pytorch_model.safetensors",
                "tooltip": "LatentSync VAE 权重文件。",
            },
            {
            "label": "Wan2.2 S2V 主模型",
                "value": "models/diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors",
                "tooltip": "Wan2.2 S2V 检测分支需要的真实音频条件视频模型。",
            },
            {
                "label": "Wan2.2 S2V 音频编码器",
                "value": "models/audio_encoders/wav2vec2_large_english_fp16.safetensors",
                "tooltip": "Wan S2V 音频条件编码器。",
            },
        ],
        "dependencies": [
            "GJJ/vendor/latentsync_enhanced（GJJ 内部 LatentSync 运行库）",
            "diffusers / accelerate / omegaconf / einops / soundfile（LatentSync 推理依赖）",
            "ffmpeg（LatentSync 输出封装需要）",
        ],
    }
    RETURN_TYPES = ("VIDEO", "STRING")
    RETURN_NAMES = ("视频", "状态")
    OUTPUT_TOOLTIPS = ("本地生成或修正口型后的视频，可继续连接保存、合成或视频处理节点。", "本次执行使用的分支、帧数和关键状态。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": ([MODE_AUTO, MODE_LTX23, MODE_LATENTSYNC, MODE_WAN22], {
                    "default": MODE_AUTO,
                    "display_name": "本地同步方式",
                    "tooltip": "自动模式：输入 VIDEO 时使用 GJJ 内部 LatentSync；输入 IMAGE 时使用 GJJ 已有 LTX2.3 图片说话功能。LatentSync 是高质量视频方案。",
                }),
                "positive_prompt": ("STRING", {
                    "default": DEFAULT_PROMPT,
                    "multiline": False,
                    "dynamicPrompts": True,
                    "display_name": "正向提示词",
                    "tooltip": "仅 LTX2.3 图片说话分支使用，用于描述人物、镜头、动作和说话状态。",
                }),
                "negative_prompt": ("STRING", {
                    "default": DEFAULT_NEGATIVE,
                    "multiline": False,
                    "dynamicPrompts": True,
                    "display_name": "反向提示词",
                    "tooltip": "仅 LTX2.3 图片说话分支使用，用于压制低清、字幕、水印、嘴部畸变和口型错位。",
                }),
                "width": ("INT", {"default": 1280, "min": 64, "max": 8192, "step": 32, "display_name": "LTX宽度", "tooltip": "LTX2.3 图片说话分支的输出宽度。"}),
                "height": ("INT", {"default": 736, "min": 64, "max": 8192, "step": 32, "display_name": "LTX高度", "tooltip": "LTX2.3 图片说话分支的输出高度。"}),
                "fps": ("INT", {"default": 25, "min": 1, "max": 120, "step": 1, "display_name": "LTX帧率", "tooltip": "LTX2.3 图片说话分支的输出帧率；视频口型分支优先沿用输入视频帧率。"}),
                "seed": ("INT", {"default": 483811081311996, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True, "display_name": "种子", "tooltip": "随机种子。"}),
                "max_seconds": ("FLOAT", {"default": 12.0, "min": 0.5, "max": 120.0, "step": 0.5, "display_name": "最长音频秒数", "tooltip": "输入音频会按这个上限裁切，避免一次性视频过长。"}),
                "inference_steps": ("INT", {"default": 20, "min": 1, "max": 100, "step": 1, "display_name": "LatentSync步数", "tooltip": "LatentSync 扩散步数；官方默认 20。"}),
                "guidance_scale": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 3.0, "step": 0.1, "display_name": "LatentSync口型强度", "tooltip": "LatentSync 的 lips_expression/guidance scale。越高口型更强，但可能更抖。"}),
                "chunk_frames": ("INT", {"default": 80, "min": 16, "max": 512, "step": 16, "display_name": "LatentSync分段帧数", "tooltip": "显存不足时调低。24GB 可从 80 开始，16GB 建议 48，12GB 建议 32。"}),
            },
            "optional": {
                "input_media": (any_type, {"display_name": "输入图片/视频", "tooltip": "接图片时自动使用 LTX2.3 图片说话；接 VIDEO 时自动使用 LatentSync 视频口型。"}),
                "input_audio": ("AUDIO", {"display_name": "输入音频", "tooltip": "用于驱动口型；如果输入视频自带音轨，也可不单独连接。"}),
                "relay_prompt_input": ("STRING", {"forceInput": True, "display_name": "时序提示词输入", "tooltip": "可选。连接 ASR 时间戳文本，用于 LTX PromptRelay 分段提示。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def generate(
        self,
        mode,
        positive_prompt,
        negative_prompt,
        width,
        height,
        fps,
        seed,
        max_seconds,
        inference_steps,
        guidance_scale,
        chunk_frames,
        input_media=None,
        input_audio=None,
        relay_prompt_input="",
        unique_id=None,
    ):
        # torch 仅在 ComfyUI 边界处使用（输入转换 + 输出封装）
        import torch

        if mode == MODE_WAN22:
            _send_status(unique_id, "Wan2.2 S2V 环境检测中...", 0.05)
            _check_wan22_s2v_environment()

        if mode == MODE_AUTO:
            mode = MODE_LATENTSYNC if _is_video_object(input_media) else MODE_LTX23

        # ── 音频预处理：提取 → 统一为 numpy ──
        if not _has_valid_audio(input_audio):
            _, video_audio, _ = _extract_video_first_frame(input_media) if _is_video_object(input_media) else (None, None, None)
            if _has_valid_audio(video_audio):
                input_audio = video_audio
            else:
                raise RuntimeError("请连接输入音频，或连接带音轨的输入视频。")
        input_audio = _audio_waveform_to_numpy(input_audio)
        input_audio = _trim_audio(input_audio, float(max_seconds))

        # ── LatentSync 视频口型分支 ──
        if mode == MODE_LATENTSYNC:
            if not _is_video_object(input_media):
                raise RuntimeError("LatentSync 视频口型分支需要输入 VIDEO。图片+音频请使用自动模式或 LTX2.3 图片说话。")
            frames_np, _, source_fps = _extract_video_components(input_media)
            details = _check_latentsync_models()
            _send_status(unique_id, "GJJ 内部 LatentSync：加载运行库...", 0.08)
            try:
                node_cls = _get_internal_latentsync_class()
                # LatentSync 需要 torch.Tensor 输入，在边界处转换
                frames_torch = _frames_to_torch(frames_np)
                audio_torch = _audio_to_torch(input_audio)
                images_torch, audio_result = node_cls().inference(
                    images=frames_torch,
                    audio=audio_torch,
                    seed=int(seed) & 0xFFFFFFFF,
                    lips_expression=float(guidance_scale),
                    inference_steps=int(inference_steps),
                    chunk_frames=int(chunk_frames),
                    video_fps=float(source_fps or fps),
                )
            except Exception as exc:
                raise RuntimeError(
                    "GJJ 内部 LatentSync 视频口型分支执行失败。\n"
                    + "\n".join(details)
                    + f"\n详细错误：{exc}"
                ) from exc
            # 结果转回 numpy 后封装 VIDEO
            video = _make_video(images_torch.cpu().numpy(), audio_result, float(source_fps or fps))
            status = f"GJJ 内部 LatentSync 完成：{int(images_torch.shape[0])} 帧 / {float(source_fps or fps):.3f} fps / {int(inference_steps)} steps。"
            _send_status(unique_id, status, 1.0)
            return (video, status)

        # ── LTX2.3 图片说话分支 ──
        # 在调用 LTX workflow 前，将 numpy 转回 torch 以满足 LTX 接口要求
        video_frame_np, _, _video_fps = _extract_video_first_frame(input_media) if _is_video_object(input_media) else (None, None, None)
        source_image = video_frame_np if video_frame_np is not None else input_media
        if source_image is None:
            raise RuntimeError("LTX2.3 图片说话需要输入图片，或输入可读取首帧的视频。")
        # 统一为 torch.Tensor（ComfyUI IMAGE 格式）
        if isinstance(source_image, np.ndarray):
            source_image = _frames_to_torch(source_image)
        elif not isinstance(source_image, torch.Tensor):
            raise RuntimeError(f"输入图片类型无效：{type(source_image)!r}")

        duration = _audio_duration_seconds(input_audio)
        frame_count = max(1, int(round(duration * float(fps))) + 1)
        _send_status(unique_id, f"GJJ 内部 LTX2.3：{frame_count} 帧 / {fps} fps", 0.08)
        try:
            from .gjj_ltx23_template_workflows import GJJ_LTX23WorkflowPromptRelayTalkingHead

            # LTX workflow 需要 torch 音频
            audio_torch = _audio_to_torch(input_audio)

            result = GJJ_LTX23WorkflowPromptRelayTalkingHead().generate(
                positive_prompt=positive_prompt,
                negative_prompt=negative_prompt,
                ckpt_name="ltx-2.3-22b",
                lora_name_1="LTX/ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
                lora_strength_1=0.5,
                lora_name_2="LTX/LTX-2.3-22b-AV-LoRA-talking-head-v1-音视频同步.safetensors",
                lora_strength_2=1.0,
                width=int(width),
                height=int(height),
                frame_count=frame_count,
                fps=int(fps),
                seed=int(seed),
                auto_use_first_image_size=False,
                relay_local_prompts=str(relay_prompt_input or ""),
                relay_segment_lengths="",
                relay_epsilon=0.001,
                input_image=source_image,       # torch.Tensor [B,H,W,C]
                input_audio=audio_torch,        # dict with torch.Tensor waveform
                relay_prompt_input=relay_prompt_input,
                lora_chain_config="",
                unique_id=unique_id,
            )
        except Exception as exc:
            raise RuntimeError(f"GJJ 内部 LTX2.3 图片说话分支执行失败。\n详细错误：{exc}") from exc
        video = result["result"][0] if isinstance(result, dict) else result[0]
        status = f"GJJ 内部 LTX2.3 完成：{frame_count} 帧，音频驱动口型。"
        _send_status(unique_id, status, 1.0)
        return (video, status)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LocalLipSync}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 👄 本地口型同步"}
