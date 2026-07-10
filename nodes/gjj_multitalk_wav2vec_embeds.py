from __future__ import annotations

from typing import Any

import folder_paths


NODE_NAME = "GJJ_MultiTalkWav2VecEmbeds"
NODE_DISPLAY_NAME = "🎤 MultiTalk音频条件"

BASE_PRECISION_VALUES = ["fp32", "bf16", "fp16"]
LOAD_DEVICE_VALUES = ["main_device", "offload_device"]
WAV2VEC_MODEL_EXTENSIONS = (".safetensors", ".gguf")


try:
    import os

    folder_paths.add_model_folder_path(
        "wav2vec2", os.path.join(folder_paths.models_dir, "wav2vec2")
    )
except Exception:
    pass


def _wav2vec_choices() -> list[str]:
    try:
        choices = [
            str(item).replace("\\", "/")
            for item in folder_paths.get_filename_list("wav2vec2")
            if str(item or "").strip()
            and str(item).lower().endswith(WAV2VEC_MODEL_EXTENSIONS)
        ]
    except Exception:
        choices = []
    return choices or ["[未找到模型]"]


def _valid_model_name(model_name: Any) -> str:
    text = str(model_name or "").strip()
    if not text or text == "[未找到模型]":
        raise RuntimeError(
            "未找到 MultiTalk Wav2Vec2 模型。请把模型文件放到 ComfyUI/models/wav2vec2 后重启或刷新模型列表。"
        )
    return text


_WAV2VEC_CACHE: dict[tuple[str, str, str], dict[str, Any]] = {}


def _load_multitalk_wav2vec(model_name: str, base_precision: str, load_device: str) -> dict[str, Any]:
    try:
        from ..vendor.wanvideo_wrapper.multitalk import nodes as multitalk_nodes
    except Exception as error:
        raise RuntimeError(
            "GJJ 内置 MultiTalk runtime 加载失败。无需安装外部 WanVideoWrapper 节点包；"
            f"如果是运行库缺失，请按 GJJ 的 WanVideo 依赖方案安装。\n错误信息：{error}"
        ) from error

    model_name = _valid_model_name(model_name)
    base_precision = str(base_precision or "fp16")
    load_device = str(load_device or "main_device")
    cache_key = (model_name.replace("\\", "/"), base_precision, load_device)
    cached = _WAV2VEC_CACHE.get(cache_key)
    if cached is not None:
        return cached

    try:
        payload = multitalk_nodes.Wav2VecModelLoader().loadmodel(
            model=model_name,
            base_precision=base_precision,
            load_device=load_device,
        )[0]
    except Exception as error:
        raise RuntimeError(
            "加载本地 MultiTalk Wav2Vec2 失败。请确认选择的是 Tencent/Chinese Wav2Vec2 单文件模型，"
            f"并且文件位于 ComfyUI/models/wav2vec2。\n模型：{model_name}\n错误信息：{error}"
        ) from error

    _WAV2VEC_CACHE[cache_key] = payload
    return payload


class GJJ_MultiTalkWav2VecEmbeds:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    DESCRIPTION = (
        "MultiTalk / InfiniteTalk 音频条件节点：内部从 models/wav2vec2 加载本地 Wav2Vec2，"
        "无需额外连接 Wav2VecModelLoader。"
    )
    SEARCH_ALIASES = [
        "MultiTalk",
        "InfiniteTalk",
        "Wav2Vec",
        "MultiTalk音频条件",
    ]

    RETURN_TYPES = ("MULTITALK_EMBEDS", "AUDIO", "INT")
    RETURN_NAMES = ("MultiTalk条件", "音频", "实际帧数")
    OUTPUT_TOOLTIPS = (
        "供 GJJ WanVideo Sampler 使用的 MultiTalk / InfiniteTalk 音频条件。",
        "裁剪、重采样并混合后的音频。",
        "根据音频实际长度修正后的帧数。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        wav2vec_models = _wav2vec_choices()
        return {
            "required": {
                "audio_1": (
                    "AUDIO",
                    {
                        "display_name": "音频1",
                        "tooltip": "第 1 路说话人音频。",
                    },
                ),
                "wav2vec_model": (
                    wav2vec_models,
                    {
                        "default": wav2vec_models[0],
                        "display_name": "Wav2Vec2模型",
                        "tooltip": "从本地 ComfyUI/models/wav2vec2 读取。MultiTalk 需要 Tencent/Chinese Wav2Vec2 单文件模型。",
                    },
                ),
                "base_precision": (
                    BASE_PRECISION_VALUES,
                    {
                        "default": "fp16",
                        "display_name": "Wav2Vec精度",
                        "tooltip": "Wav2Vec2 的加载精度，显存紧张时使用 fp16。",
                    },
                ),
                "load_device": (
                    LOAD_DEVICE_VALUES,
                    {
                        "default": "main_device",
                        "display_name": "初始加载设备",
                        "tooltip": "main_device 会先在主设备读入权重；offload_device 会先在卸载设备读入权重。",
                    },
                ),
                "normalize_loudness": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "响度标准化",
                        "tooltip": "将音频响度标准化到 -23 LUFS。",
                    },
                ),
                "num_frames": (
                    "INT",
                    {
                        "default": 81,
                        "min": 1,
                        "max": 10000,
                        "step": 1,
                        "display_name": "帧数",
                        "tooltip": "需要生成或采样的视频帧数。",
                    },
                ),
                "fps": (
                    "FLOAT",
                    {
                        "default": 25.0,
                        "min": 1.0,
                        "max": 60.0,
                        "step": 0.1,
                        "display_name": "帧率",
                    },
                ),
                "audio_scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "音频强度",
                        "tooltip": "MultiTalk 音频条件强度。",
                    },
                ),
                "audio_cfg_scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "音频CFG",
                        "tooltip": "不为 1 时会启用无音频条件的额外 CFG 分支，速度会变慢。",
                    },
                ),
                "multi_audio_type": (
                    ["para", "add"],
                    {
                        "default": "para",
                        "display_name": "多音频模式",
                        "tooltip": "para 为多说话人并行叠加；add 为按顺序拼接。",
                    },
                ),
            },
            "optional": {
                "audio_2": ("AUDIO", {"display_name": "音频2"}),
                "audio_3": ("AUDIO", {"display_name": "音频3"}),
                "audio_4": ("AUDIO", {"display_name": "音频4"}),
                "ref_target_masks": (
                    "MASK",
                    {
                        "display_name": "说话人遮罩",
                        "tooltip": "每个说话人的语义遮罩，用于指导嘴部区域分配。",
                    },
                ),
                "add_noise_floor": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "添加噪声底",
                        "tooltip": "添加很低的噪声底，减少静音间隙。",
                    },
                ),
                "smooth_transients": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "平滑瞬态",
                        "tooltip": "应用低通滤波，平滑音频瞬态。",
                    },
                ),
            },
        }

    def process(
        self,
        audio_1,
        wav2vec_model,
        base_precision,
        load_device,
        normalize_loudness,
        num_frames,
        fps,
        audio_scale,
        audio_cfg_scale,
        multi_audio_type,
        audio_2=None,
        audio_3=None,
        audio_4=None,
        ref_target_masks=None,
        add_noise_floor=False,
        smooth_transients=False,
    ):
        try:
            from ..vendor.wanvideo_wrapper.multitalk import nodes as multitalk_nodes
        except Exception as error:
            raise RuntimeError(f"GJJ 内置 MultiTalk runtime 加载失败：{error}") from error

        wav2vec_payload = _load_multitalk_wav2vec(
            wav2vec_model,
            base_precision=base_precision,
            load_device=load_device,
        )
        return multitalk_nodes.MultiTalkWav2VecEmbeds().process(
            wav2vec_model=wav2vec_payload,
            normalize_loudness=normalize_loudness,
            fps=fps,
            num_frames=num_frames,
            audio_1=audio_1,
            audio_scale=audio_scale,
            audio_cfg_scale=audio_cfg_scale,
            multi_audio_type=multi_audio_type,
            audio_2=audio_2,
            audio_3=audio_3,
            audio_4=audio_4,
            ref_target_masks=ref_target_masks,
            add_noise_floor=add_noise_floor,
            smooth_transients=smooth_transients,
        )


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_MultiTalkWav2VecEmbeds,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
