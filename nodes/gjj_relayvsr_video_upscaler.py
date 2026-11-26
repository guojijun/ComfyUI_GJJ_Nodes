# -*- coding: utf-8 -*-
"""
GJJ RelayVSR 视频超分单节点（同一节点内切 ×2 / ×4）。

对应官方工作流：
  utility_relayvsr_video_x4_upscale.json
  utility_relayvsr_video_x2_upscale.json

两个工作流内部链路完全一致（GetVideoComponents → UNETLoader →
RelayVSRConditioning → KSampler → VSRDecode → CreateVideo），仅默认权重配对不同。
因此合并为一个节点：节点内选择「放大倍率」，扩散模型与 VAE 按倍率自动配对。
"""
from __future__ import annotations

import os
from typing import Any

import comfy.samplers
import folder_paths

from .gjj_relayvsr_runtime import (
    MODEL_DOWNLOAD_URL,
    MODEL_HOME_URL,
    MODEL_KEYWORD,
    SCALE_PRESETS,
    UNET_FOLDER,
    VAE_FOLDER,
    align_model_to_scale,
    available_scale_keys,
    ensure_model_exists,
    official_combo_options,
    pick_scaled_model,
    resolve_scale_choice,
    run_relayvsr_upscale,
    scale_choice_label,
    scale_choice_values,
    validate_model_pair,
)

NODE_NAME = "GJJ_RelayVSRVideoUpscaler"

# 与前端 gjj_relayvsr_video_upscaler.js 的 PARAM_ORDER 必须完全一致（15 个 widget）。
# scale / video_file 放最后：更早版本的 widgets_values 前缀顺序保持不变，老工作流不会错位。
UI_PARAMETER_ORDER = (
    "unet_name",
    "vae_name",
    "steps",
    "cfg",
    "seed",
    "sampler_name",
    "scheduler",
    "detail",
    "weight_dtype",
    "bit_depth",
    "color_space",
    "chroma_subsampling",
    "codec",
    "scale",
    "video_file",
)


# ───────────────────────── 动态候选（不硬编码枚举） ─────────────────────────
def _sampler_choices() -> list[str]:
    return list(comfy.samplers.KSampler.SAMPLERS) or ["euler"]


def _scheduler_choices() -> list[str]:
    return list(comfy.samplers.KSampler.SCHEDULERS) or ["simple"]


def _weight_dtype_choices() -> list[str]:
    return official_combo_options("UNETLoader", "weight_dtype") or ["default"]


def _create_video_choices(input_name: str, fallback: list[Any]) -> list[Any]:
    """CreateVideo 的输出枚举直接向内核官方节点探测，内核升级增删选项自动跟随。"""
    choices = official_combo_options("CreateVideo", input_name)
    return choices if choices else list(fallback)


def _pick_default(choices: list[Any], preferred: Any) -> Any:
    """候选中含首选则用首选，否则取第一个候选（保证默认值始终合法）。"""
    if preferred in choices:
        return preferred
    return choices[0] if choices else preferred


def _resolve_video_file(value: str) -> str:
    """把 📁 上传/填写的文件名解析成 ComfyUI/input 下的真实路径，找不到返回空串。"""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        if folder_paths.exists_annotated_filepath(raw):
            return folder_paths.get_annotated_filepath(raw)
    except Exception:
        pass
    candidate = os.path.join(folder_paths.get_input_directory(), raw.replace("\\", "/"))
    return candidate if os.path.isfile(candidate) else ""


def _video_from_file(path: str):
    """用内核官方 InputImpl 把本地视频文件包装成 VIDEO 对象。"""
    try:
        from comfy_api.latest import InputImpl

        return InputImpl.VideoFromFile(path)
    except Exception:
        from comfy_api.input_impl import VideoFromFile

        return VideoFromFile(path)


def _build_help() -> dict[str, Any]:
    """按倍率预设数据驱动生成 GJJ_HELP，一个节点描述两套权重。"""
    model_tree: list[dict[str, Any]] = []
    for scale in available_scale_keys():
        preset = SCALE_PRESETS[scale]
        label = scale_choice_label(scale)
        unet_file = preset["unet"]
        vae_file = preset["vae"]
        model_tree.append(
            {
                "label": f"RelayVSR {label} 扩散模型（diffusion_models）",
                "folder": UNET_FOLDER,
                "filename": unet_file,
                "url": f"{MODEL_HOME_URL}/tree/main/{UNET_FOLDER}",
                "description": (
                    f"RelayVSR {label} 视频超分扩散权重；节点按所选倍率自动加载对应权重，"
                    "必须与同倍数 VAE 配对，x2/x4 不可混用。"
                ),
            }
        )
        model_tree.append(
            {
                "label": f"RelayVSR Flash {label} VAE（vae）",
                "folder": VAE_FOLDER,
                "filename": vae_file,
                "url": f"{MODEL_HOME_URL}/tree/main/{VAE_FOLDER}",
                "description": "RelayVSR Flash 解码器，读取低质帧还原全部视频帧；与扩散模型同倍数配对。",
            }
        )
    model_tree_text = "\n".join(
        f"{index}. {item['label']}\n   路径：models/{item['folder']}/{item['filename']}"
        for index, item in enumerate(model_tree, start=1)
    )
    scale_text = " / ".join(scale_choice_label(key) for key in available_scale_keys())
    return {
        "title": f"GJJ · 🎞️ RelayVSR 视频放大（{scale_text} 单节点）",
        "description": (
            "把官方 RelayVSR 视频超分工作流封装为单节点：输入 VIDEO 直接输出放大后的 VIDEO，"
            "自动保留原视频音频、帧率与色彩信息；节点内选择放大倍率，扩散模型与 VAE 按倍率自动配对。"
            "主面板 📁 可直接打开本机视频（上传到 ComfyUI/input 后作为输入），▶️ 单节点执行。"
            "内部等价于 GetVideoComponents → UNETLoader → RelayVSRConditioning → "
            "KSampler（1 步 / cfg 1）→ VSRDecode → CreateVideo。"
        ),
        "notice": (
            f"一个节点覆盖 {scale_text}：主面板 2️⃣→4️⃣ 一键切倍率，切换时扩散模型和 VAE 会自动换成同倍率权重，"
            "x2 与 x4 权重不可混用；手动换模时 🧠 模型树会按文件名倍数 token 自动配对并在后端二次校验。"
            "模型缺失时不会自动下载，请按下列地址手动放入对应目录。"
        ),
        "dependencies": [],
        "optional_dependencies": [],
        "model_tree": model_tree,
        "model_tree_text": (
            f"{model_tree_text}\n\n统一下载地址（夸克网盘）：{MODEL_DOWNLOAD_URL}\n"
            f"HuggingFace 主页：{MODEL_HOME_URL}\n"
            "ModelScope 主页：https://modelscope.cn/models/Comfy-Org/RelayVSR"
        ),
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "models": [
            {
                "label": item["label"],
                "subdir": f"models/{item['folder']}",
                "filename": item["filename"],
                "description": item["description"],
            }
            for item in model_tree
        ],
    }


class GJJ_RelayVSRVideoUpscaler:
    CATEGORY = "GJJ/🔍 超分放大"
    FUNCTION = "upscale"
    OUTPUT_NODE = True
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("放大后视频",)
    OUTPUT_TOOLTIPS = ("RelayVSR 超分后的视频，自动保留原音频、帧率与色彩设置。",)

    # 默认倍率；节点内切换即可，不再额外注册专用节点。
    DEFAULT_SCALE = "x4"

    GJJ_HELP = _build_help()
    GJJ_UI = {
        "toolbar": ["🔄", "🎲", "🧠", "🎛️", "🎞️", "▶️"],
        "parameter_order": list(UI_PARAMETER_ORDER),
        "hidden_parameters": list(UI_PARAMETER_ORDER),
    }

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        default_scale = (
            cls.DEFAULT_SCALE if cls.DEFAULT_SCALE in SCALE_PRESETS else available_scale_keys()[0]
        )
        default_label = scale_choice_label(default_scale)
        preset = SCALE_PRESETS[default_scale]

        unet_choices = folder_paths.get_filename_list(UNET_FOLDER)
        vae_choices = folder_paths.get_filename_list(VAE_FOLDER)
        # 默认模型按默认倍率配对；目录为空时仍保证 combo 有合法值，由后端在执行时给中文缺失提示。
        default_unet = pick_scaled_model(UNET_FOLDER, default_scale, preset["unet"]) or (
            unet_choices[0] if unet_choices else preset["unet"]
        )
        default_vae = pick_scaled_model(VAE_FOLDER, default_scale, preset["vae"]) or (
            vae_choices[0] if vae_choices else preset["vae"]
        )

        samplers = _sampler_choices()
        schedulers = _scheduler_choices()
        weight_dtypes = _weight_dtype_choices()
        bit_depths = _create_video_choices("bit_depth", ["auto", 8, 10])
        color_spaces = _create_video_choices("color_space", ["sRGB", "HDR", "HDR PQ"])
        chroma_choices = _create_video_choices(
            "chroma_subsampling", ["auto", "444", "422", "420", "none"]
        )
        codec_choices = _create_video_choices(
            "codec", ["none", "auto", "h264", "av1", "prores"]
        )
        scale_choices = scale_choice_values()

        return {
            "required": {
                "unet_name": (
                    unet_choices or [preset["unet"]],
                    {
                        "default": default_unet,
                        "display_name": "RelayVSR 扩散模型",
                        "tooltip": (
                            f"models/{UNET_FOLDER} 下的 RelayVSR 扩散权重；"
                            "切换放大倍率时会自动切换到同倍数权重，🧠 模型树按 relayvsr 关键词过滤。"
                        ),
                    },
                ),
                "vae_name": (
                    vae_choices or [preset["vae"]],
                    {
                        "default": default_vae,
                        "display_name": "RelayVSR VAE",
                        "tooltip": f"models/{VAE_FOLDER} 下的 RelayVSR Flash VAE，须与扩散模型同倍数。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 100,
                        "step": 1,
                        "display_name": "采样步数",
                        "tooltip": "官方工作流固定 1 步；RelayVSR 为单步蒸馏采样，不建议调大。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 20.0,
                        "step": 0.05,
                        "display_name": "CFG 引导系数",
                        "tooltip": "官方工作流固定 1.0。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "随机种子",
                        "tooltip": "随机种子；工具栏 🎲 可切换每次执行自动随机。",
                    },
                ),
                "sampler_name": (
                    samplers,
                    {
                        "default": _pick_default(samplers, "euler"),
                        "display_name": "采样器",
                        "tooltip": "官方工作流使用 euler。",
                    },
                ),
                "scheduler": (
                    schedulers,
                    {
                        "default": _pick_default(schedulers, "simple"),
                        "display_name": "调度器",
                        "tooltip": "官方工作流使用 simple。",
                    },
                ),
                "detail": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "细节保留（detail）",
                        "tooltip": "VSR Decode 参数：解码器在双立方放大基础上保留多少模型细节，1 为完整模型输出。",
                    },
                ),
                "weight_dtype": (
                    weight_dtypes,
                    {
                        "default": _pick_default(weight_dtypes, "default"),
                        "display_name": "权重加载精度",
                        "tooltip": "透传官方 UNETLoader；default 按权重自身精度加载。",
                    },
                ),
                "bit_depth": (
                    bit_depths,
                    {
                        "default": _pick_default(bit_depths, "auto"),
                        "display_name": "输出位深",
                        "tooltip": "auto：sRGB 用 8 位、HDR 用 10 位；也可强制 8/10 位。",
                    },
                ),
                "color_space": (
                    color_spaces,
                    {
                        "default": _pick_default(color_spaces, "sRGB"),
                        "display_name": "色彩空间",
                        "tooltip": "sRGB / HDR（BT.2020 HLG）/ HDR PQ（BT.2020 PQ）。",
                    },
                ),
                "chroma_subsampling": (
                    chroma_choices,
                    {
                        "default": _pick_default(chroma_choices, "auto"),
                        "display_name": "色度子采样",
                        "tooltip": "444 保留完整色度分辨率，422/420 依次折减；auto 跟随编码器默认。",
                    },
                ),
                "codec": (
                    codec_choices,
                    {
                        "default": _pick_default(codec_choices, "none"),
                        "display_name": "输出编码",
                        "tooltip": "none 保持张量形式交给后续保存节点；也可在此直接指定编码器输出成片。",
                    },
                ),
                "scale": (
                    scale_choices,
                    {
                        "default": default_label,
                        "display_name": "放大倍率",
                        "tooltip": (
                            f"在 {default_label} / "
                            f"{' / '.join(item for item in scale_choices if item != default_label)} "
                            "之间切换：节点按倍率自动加载同倍率的扩散模型与 VAE，x2 / x4 权重不可混用。"
                        ),
                    },
                ),
            },
            "optional": {
                "video": (
                    "VIDEO",
                    {
                        "display_name": "输入视频",
                        "tooltip": "需要超分放大的源视频；不接上游时可用主面板 📁 直接选择本机视频。",
                    },
                ),
                "video_file": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "视频文件（📁 选择）",
                        "tooltip": "主面板 📁 按钮会把你本机选择的视频上传到 ComfyUI/input 并写入这里；已连接上游 VIDEO 时优先用输入口。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def upscale(
        self,
        unet_name: str,
        vae_name: str,
        steps: int,
        cfg: float,
        seed: int,
        sampler_name: str,
        scheduler: str,
        detail: float,
        weight_dtype: str,
        bit_depth: Any,
        color_space: str,
        chroma_subsampling: str,
        codec: str,
        scale: str = "×4",
        video_file: str = "",
        video: Any = None,
        unique_id: Any = None,
    ) -> tuple[Any]:
        # 视频来源：优先用上游 VIDEO 输入；没接上游时用主面板 📁 选择的本机视频。
        if video is None:
            video_path = _resolve_video_file(video_file)
            if not video_path:
                raise RuntimeError(
                    "没有可用的输入视频：\n"
                    "  1) 把 VIDEO 接到本节点的「输入视频」接口；或\n"
                    "  2) 用主面板 📁 按钮选择本机视频（会自动上传到 ComfyUI/input）。\n"
                    f"当前视频文件字段：{video_file or '（空）'}\n"
                    f"input 目录：{folder_paths.get_input_directory()}"
                )
            video = _video_from_file(video_path)

        # 倍率 → 模型：选了 ×2 就只认 x2 权重，选了 ×4 就只认 x4 权重。
        scale_key = resolve_scale_choice(scale, default=self.DEFAULT_SCALE)
        unet_name = align_model_to_scale(UNET_FOLDER, unet_name, scale_key, "扩散模型")
        vae_name = align_model_to_scale(VAE_FOLDER, vae_name, scale_key, "VAE")

        # 后端二次配对校验 + 缺失模型中文提示（不自动下载）。
        validate_model_pair(unet_name, vae_name)
        ensure_model_exists(UNET_FOLDER, unet_name, "扩散模型")
        ensure_model_exists(VAE_FOLDER, vae_name, "VAE")

        output = run_relayvsr_upscale(
            video=video,
            unet_name=unet_name,
            vae_name=vae_name,
            steps=int(steps),
            cfg=float(cfg),
            seed=int(seed),
            sampler_name=sampler_name,
            scheduler=scheduler,
            detail=float(detail),
            weight_dtype=weight_dtype,
            bit_depth=bit_depth,
            color_space=color_space,
            chroma_subsampling=chroma_subsampling,
            codec=codec,
            unique_id=unique_id,
        )
        return (output,)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_RelayVSRVideoUpscaler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "🎞️ RelayVSR 视频放大（×2 / ×4）",
}
