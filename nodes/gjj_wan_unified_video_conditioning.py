from __future__ import annotations

from typing import Any

import torch

import comfy.clip_vision
import comfy.model_management
import comfy.utils


NODE_NAME = "GJJ_WanUnifiedVideoConditioning"
NODE_DISPLAY_NAME = "🎬 Wan三模式视频条件"

MODE_T2V = "文生"
MODE_I2V = "图生"
MODE_FLF = "首尾帧"
MODE_VALUES = (MODE_T2V, MODE_I2V, MODE_FLF)


def _conditioning_set_values(conditioning: Any, values: dict[str, Any]) -> Any:
    if conditioning is None:
        return conditioning
    result = []
    for item in conditioning:
        updated = [item[0], item[1].copy()]
        updated[1].update(values)
        result.append(updated)
    return result


def _normalize_mode(value: Any) -> str:
    text = str(value or "").strip()
    aliases = {
        "t2v": MODE_T2V,
        "text": MODE_T2V,
        "text_to_video": MODE_T2V,
        "txt2video": MODE_T2V,
        "文生": MODE_T2V,
        "文生视频": MODE_T2V,
        "i2v": MODE_I2V,
        "image": MODE_I2V,
        "image_to_video": MODE_I2V,
        "img2video": MODE_I2V,
        "图生": MODE_I2V,
        "图生视频": MODE_I2V,
        "flf": MODE_FLF,
        "first_last": MODE_FLF,
        "first_last_frame": MODE_FLF,
        "first_last_frame_to_video": MODE_FLF,
        "首尾帧": MODE_FLF,
    }
    return aliases.get(text.lower(), aliases.get(text, MODE_FLF))


def _latent_size(length: int) -> int:
    return ((int(length) - 1) // 4) + 1


def _align_to_16(value: Any, minimum: int = 16) -> int:
    number = int(round(float(value)))
    return max(minimum, (number // 16) * 16)


def _empty_hunyuan_latent(width: int, height: int, length: int, batch_size: int) -> dict[str, Any]:
    latent = torch.zeros(
        [int(batch_size), 16, _latent_size(length), int(height) // 8, int(width) // 8],
        device=comfy.model_management.intermediate_device(),
    )
    return {"samples": latent, "downscale_ratio_spacial": 8}


def _empty_wan_i2v_latent(width: int, height: int, length: int, batch_size: int) -> dict[str, Any]:
    latent = torch.zeros(
        [int(batch_size), 16, _latent_size(length), int(height) // 8, int(width) // 8],
        device=comfy.model_management.intermediate_device(),
    )
    return {"samples": latent}


def _empty_flf_latent(vae: Any, width: int, height: int, length: int, batch_size: int) -> dict[str, Any]:
    spacial_scale = int(vae.spacial_compression_encode())
    latent_channels = int(getattr(vae, "latent_channels", 16))
    latent = torch.zeros(
        [int(batch_size), latent_channels, _latent_size(length), int(height) // spacial_scale, int(width) // spacial_scale],
        device=comfy.model_management.intermediate_device(),
    )
    return {"samples": latent}


def _require_vae(vae: Any, mode: str) -> Any:
    if vae is None:
        raise RuntimeError(f"{mode} 模式需要连接 VAE。请接入 Wan/Hunyuan 对应的 VAE 后再执行。")
    if not hasattr(vae, "encode"):
        raise RuntimeError(f"{mode} 模式收到的 VAE 无法编码图像。请检查 VAE 输入连接。")
    return vae


def _upscale_image(image: torch.Tensor, width: int, height: int, from_start: bool, length: int) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise RuntimeError("图像输入必须是 ComfyUI IMAGE 张量。")
    frames = image[:length] if from_start else image[-length:]
    return comfy.utils.common_upscale(frames.movedim(-1, 1), int(width), int(height), "bilinear", "center").movedim(1, -1)


def _combine_clip_vision(start_clip: Any = None, end_clip: Any = None) -> Any:
    if start_clip is None:
        return end_clip
    if end_clip is None:
        return start_clip
    if not hasattr(start_clip, "penultimate_hidden_states") or not hasattr(end_clip, "penultimate_hidden_states"):
        raise RuntimeError("CLIP视觉条件格式无效：需要包含 penultimate_hidden_states。")
    output = comfy.clip_vision.Output()
    output.penultimate_hidden_states = torch.cat(
        [start_clip.penultimate_hidden_states, end_clip.penultimate_hidden_states],
        dim=-2,
    )
    return output


class GJJ_WanUnifiedVideoConditioning:
    CATEGORY = "GJJ/🎬 视频/生成"
    FUNCTION = "generate"
    DESCRIPTION = (
        "将 EmptyHunyuanLatentVideo、WanImageToVideo、WanFirstLastFrameToVideo 合并为一个 GJJ 零依赖三模式条件节点。"
        "面板可在文生视频、图生视频、首尾帧之间切换，并自动隐藏当前模式不需要的接口。"
    )
    SEARCH_ALIASES = [
        "WanFirstLastFrameToVideo",
        "WanImageToVideo",
        "EmptyHunyuanLatentVideo",
        "wan unified video",
        "wan 三模式",
        "文生视频",
        "图生视频",
        "首尾帧",
    ]

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "反向条件", "latent")
    OUTPUT_TOOLTIPS = (
        "按当前模式写入图像/CLIP 条件后的正向 CONDITIONING；文生模式原样透传。",
        "按当前模式写入图像/CLIP 条件后的反向 CONDITIONING；文生模式原样透传。",
        "目标尺寸、帧数和批次数对应的空视频 latent。",
    )

    GJJ_HELP = {
        "title": "Wan 三模式视频条件",
        "description": "一个节点覆盖文生、图生、首尾帧三种条件准备。文生只输出空 latent 并透传正反条件；图生和首尾帧会写入参考图条件。",
        "usage": [
            "文生：生成 EmptyHunyuanLatentVideo 风格的空 latent，正向条件和反向条件原样透传，不需要 VAE 或图片。",
            "图生：使用起始图和起始 CLIP 视觉条件，逻辑对齐 WanImageToVideo。",
            "首尾帧：使用起始图、结束图以及两端 CLIP 视觉条件，逻辑对齐 WanFirstLastFrameToVideo。",
            "宽度、高度、帧数和批次数始终决定输出 latent 的形状，请与后续采样/解码链路保持一致。",
            "点击 ⚡参数 可从 GJJ_TemplateParams 读取 width/宽度、height/高度、duration/时长、frame_rate/fps/帧率；宽高按原版 16 倍数对齐，帧数按 int((时长*帧率//8)*8+1) 写入。",
            "启用 ⚡参数 后，宽度、高度、帧数面板控件会隐藏，按钮变为激活态；再次点击可更换模板参数来源或关闭联动。",
            "模板里可声明 模式 (wan_mode)：[文生, 图生, 首尾帧] # 枚举；也兼容文生视频、图生视频写法。启用 ⚡参数 后节点会侦听这个值切换模式，接线不断，当前不用的线路会灰显并在后端忽略。",
        ],
        "inputs": {
            "模式": "节点面板上的三选一按钮：文生、图生、首尾帧。",
            "positive / negative": "文生模式原样透传；图生和首尾帧模式会在其中写入图像条件。",
            "vae": "图生和首尾帧模式需要，用于把参考帧编码为 concat_latent_image；文生模式会隐藏并忽略。",
            "clip_vision_start_image": "图生模式作为单个 CLIP 图像条件；首尾帧模式作为起始图 CLIP 条件。",
            "clip_vision_end_image": "仅首尾帧模式使用，会与起始图 CLIP 条件拼接。",
            "start_image": "图生视频首帧，或首尾帧的起始帧。",
            "end_image": "仅首尾帧模式使用的结束帧。",
            "⚡参数": "从画布上的 GJJ_TemplateParams 节点读取尺寸和时长参数：width/宽度、height/高度、duration/时长、frame_rate/fps/帧率。宽高按原版 16 倍数对齐，启用后会隐藏宽度、高度、帧数面板控件。",
        },
        "mode_variables": {
            "文生": "使用 gjj_mode=文生；读取 positive、negative、width、height、length、batch_size，正反条件原样透传，并输出 EmptyHunyuanLatentVideo 风格 latent。",
            "图生": "使用 gjj_mode=图生；读取 positive、negative、vae、start_image、clip_vision_start_image，并生成 WanImageToVideo 风格 concat_latent_image / concat_mask。",
            "首尾帧": "使用 gjj_mode=首尾帧；读取 positive、negative、vae、start_image、end_image、clip_vision_start_image、clip_vision_end_image，并生成 WanFirstLastFrameToVideo 风格条件。",
            "模板模式字段": "GJJ_TemplateParams 支持 wan_mode、video_mode、mode、模式、视频模式、生成模式，值可写 文生 / 图生 / 首尾帧，也兼容 文生视频 / 图生视频。",
        },
        "notes": [
            "本节点只使用 ComfyUI 内置 torch/comfy 模块，不导入 comfy_api、node_helpers 或第三方自定义节点。",
            "文生分支按 EmptyHunyuanLatentVideo 输出 16 通道、空间 8 倍压缩的空 latent，并附带 downscale_ratio_spacial=8。",
            "图生分支沿用 WanImageToVideo 的 0.5 灰底填充和 concat_mask 规则。",
            "首尾帧分支沿用 WanFirstLastFrameToVideo 的起止帧遮罩和双 CLIP 拼接规则。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        try:
            import nodes as comfy_nodes

            max_resolution = int(getattr(comfy_nodes, "MAX_RESOLUTION", 16384))
        except Exception:
            max_resolution = 16384

        return {
            "required": {
                "width": (
                    "INT",
                    {
                        "default": 832,
                        "min": 16,
                        "max": max_resolution,
                        "step": 16,
                        "display_name": "宽度",
                        "tooltip": "目标视频宽度。会按原版 16 倍数对齐，并同时用于 latent 形状和参考图缩放。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 480,
                        "min": 16,
                        "max": max_resolution,
                        "step": 16,
                        "display_name": "高度",
                        "tooltip": "目标视频高度。会按原版 16 倍数对齐，并同时用于 latent 形状和参考图缩放。",
                    },
                ),
                "length": (
                    "INT",
                    {
                        "default": 81,
                        "min": 1,
                        "max": max_resolution,
                        "step": 4,
                        "display_name": "帧数",
                        "tooltip": "目标视频帧数。内部 latent 时间长度按 ((帧数 - 1) // 4) + 1 计算。",
                    },
                ),
                "batch_size": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 4096,
                        "display_name": "批次数",
                        "tooltip": "输出 latent 的 batch size。参考图条件仍按输入图片批次编码。",
                    },
                ),
                "gjj_mode": (
                    "STRING",
                    {
                        "default": MODE_FLF,
                        "display_name": "模式",
                        "tooltip": "由节点面板三选一按钮维护：文生、图生、首尾帧。",
                        "hidden": True,
                        "display": "hidden",
                    },
                ),
            },
            "optional": {
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正向条件",
                        "tooltip": "文生模式原样透传；图生和首尾帧模式会在其中写入图像条件。",
                    },
                ),
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "反向条件",
                        "tooltip": "文生模式原样透传；图生和首尾帧模式会在其中写入图像条件。",
                    },
                ),
                "vae": (
                    "VAE",
                    {
                        "display_name": "VAE",
                        "tooltip": "图生和首尾帧模式需要连接，用于把参考帧编码为视频条件；文生模式不使用。",
                    },
                ),
                "clip_vision_start_image": (
                    "CLIP_VISION_OUTPUT",
                    {
                        "display_name": "起始图CLIP视觉条件",
                        "tooltip": "图生模式使用的 CLIP 图像条件；首尾帧模式中代表起始图视觉条件。",
                    },
                ),
                "clip_vision_end_image": (
                    "CLIP_VISION_OUTPUT",
                    {
                        "display_name": "结束图CLIP视觉条件",
                        "tooltip": "仅首尾帧模式使用。连接后会与起始图 CLIP 视觉条件在 hidden states 维度拼接。",
                    },
                ),
                "start_image": (
                    "IMAGE",
                    {
                        "display_name": "起始图",
                        "tooltip": "图生视频首帧，或首尾帧模式的起始帧；会自动缩放到目标宽高。",
                    },
                ),
                "end_image": (
                    "IMAGE",
                    {
                        "display_name": "结束图",
                        "tooltip": "仅首尾帧模式使用的结束帧；会自动缩放到目标宽高并写入末尾遮罩区域。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
            },
        }

    def generate(
        self,
        width: int,
        height: int,
        length: int,
        batch_size: int,
        gjj_mode: str = MODE_FLF,
        positive: Any = None,
        negative: Any = None,
        vae: Any = None,
        clip_vision_start_image: Any = None,
        clip_vision_end_image: Any = None,
        start_image: Any = None,
        end_image: Any = None,
        prompt: Any = None,
    ):
        try:
            from .gjj_video_combine_runtime import collect_prompt_variables

            variables = collect_prompt_variables(prompt)

            def template_value(*names):
                return next(
                    (variables.get(name) for name in names if variables.get(name) not in (None, "")),
                    None,
                )

            template_width = template_value("width", "宽度")
            template_height = template_value("height", "高度")
            template_duration = template_value("duration", "时长")
            template_fps = template_value("frame_rate", "fps", "帧率")
            template_mode = template_value("wan_mode", "video_mode", "mode", "模式", "视频模式", "生成模式")

            if template_width is not None:
                width = int(float(template_width))
            if template_height is not None:
                height = int(float(template_height))
            if template_duration is not None and template_fps is not None:
                duration_value = max(0.0, float(template_duration))
                fps_value = max(0.01, float(template_fps))
                length = max(1, int((duration_value * fps_value // 8) * 8 + 1))
            if template_mode is not None:
                gjj_mode = str(template_mode)
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"GJJ 模板视频参数无效：{exc}") from exc

        mode = _normalize_mode(gjj_mode)
        width = _align_to_16(width)
        height = _align_to_16(height)

        if mode == MODE_T2V:
            return positive if positive is not None else [], negative if negative is not None else [], _empty_hunyuan_latent(width, height, length, batch_size)

        vae = _require_vae(vae, mode)
        if positive is None or negative is None:
            raise RuntimeError(f"{mode} 模式需要连接正向条件和反向条件。文生视频模式才可以不接正反条件。")

        if mode == MODE_I2V:
            latent = _empty_wan_i2v_latent(width, height, length, batch_size)
            if start_image is not None:
                start_image = _upscale_image(start_image, width, height, True, length)
                image = torch.ones(
                    (int(length), int(height), int(width), start_image.shape[-1]),
                    device=start_image.device,
                    dtype=start_image.dtype,
                ) * 0.5
                image[: start_image.shape[0]] = start_image
                concat_latent_image = vae.encode(image[:, :, :, :3])
                mask = torch.ones(
                    (1, 1, latent["samples"].shape[2], concat_latent_image.shape[-2], concat_latent_image.shape[-1]),
                    device=start_image.device,
                    dtype=start_image.dtype,
                )
                mask[:, :, : ((start_image.shape[0] - 1) // 4) + 1] = 0.0
                values = {"concat_latent_image": concat_latent_image, "concat_mask": mask}
                positive = _conditioning_set_values(positive, values)
                negative = _conditioning_set_values(negative, values)

            if clip_vision_start_image is not None:
                values = {"clip_vision_output": clip_vision_start_image}
                positive = _conditioning_set_values(positive, values)
                negative = _conditioning_set_values(negative, values)

            return positive, negative, latent

        latent = _empty_flf_latent(vae, width, height, length, batch_size)
        latent_samples = latent["samples"]

        if start_image is not None:
            start_image = _upscale_image(start_image, width, height, True, length)
        if end_image is not None:
            end_image = _upscale_image(end_image, width, height, False, length)

        image = torch.ones((int(length), int(height), int(width), 3)) * 0.5
        mask = torch.ones((1, 1, latent_samples.shape[2] * 4, latent_samples.shape[-2], latent_samples.shape[-1]))

        if start_image is not None:
            image[: start_image.shape[0]] = start_image
            mask[:, :, : start_image.shape[0] + 3] = 0.0

        if end_image is not None:
            image[-end_image.shape[0] :] = end_image
            mask[:, :, -end_image.shape[0] :] = 0.0

        concat_latent_image = vae.encode(image[:, :, :, :3])
        mask = mask.view(1, mask.shape[2] // 4, 4, mask.shape[3], mask.shape[4]).transpose(1, 2)
        values = {"concat_latent_image": concat_latent_image, "concat_mask": mask}
        positive = _conditioning_set_values(positive, values)
        negative = _conditioning_set_values(negative, values)

        clip_vision_output = _combine_clip_vision(clip_vision_start_image, clip_vision_end_image)
        if clip_vision_output is not None:
            values = {"clip_vision_output": clip_vision_output}
            positive = _conditioning_set_values(positive, values)
            negative = _conditioning_set_values(negative, values)

        return positive, negative, latent


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanUnifiedVideoConditioning}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
