from __future__ import annotations

import time
from typing import Any, Iterable

import comfy.utils
import torch
from comfy_extras.nodes_custom_sampler import (
    CFGGuider,
    KSamplerSelect,
    ManualSigmas,
    RandomNoise,
    SamplerCustomAdvanced,
)
from comfy_extras.nodes_hunyuan import LatentUpscaleModelLoader
from comfy_extras.nodes_lt import (
    EmptyLTXVLatentVideo,
    LTXVAddGuide,
    LTXVConcatAVLatent,
    LTXVConditioning,
    LTXVCropGuides,
    LTXVImgToVideoInplace,
    LTXVPreprocess,
    LTXVSeparateAVLatent,
)
from comfy_extras.nodes_lt_audio import (
    LTXAVTextEncoderLoader,
    LTXVAudioVAEDecode,
    LTXVAudioVAELoader,
    LTXVEmptyLatentAudio,
)
from comfy_extras.nodes_lt_upsampler import LTXVLatentUpsampler
from nodes import (
    CheckpointLoaderSimple,
    CLIPTextEncode,
    LoraLoaderModelOnly,
    VAEDecodeTiled,
)

from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .gjj_ltx23_multiref_runtime import (
    _aggressive_purge_runtime,
    _apply_chain_loras,
    _apply_ff_chunking,
    _apply_ltx_nag,
    _create_video,
    _crop_frames_to_size,
    _load_vae,
    _pick_available_name,
    _pick_first_candidate,
    _safe_filename_list,
    _slice_output_frames,
)

NODE_NAME = "GJJ_LTX23FirstLastOutfit"

AUTO_LORA = "[自动匹配]"
DISABLE_LORA = "[不使用]"

DEFAULT_PROMPT = (
    "zhuanchang，人物保持正对镜头向前行走动作，服装和场景慢慢变化，"
    "黑色长直发渐变切换为羊毛卷短发，珍珠发箍消失替换为银色蝴蝶耳饰，"
    "白色针织上衣渐变过渡为黑色蕾丝吊带，丝滑无缝变装，主角不说话。"
)
DEFAULT_NEGATIVE = (
    "blurry, oversaturated, pixelated, low resolution, grainy, distorted, noise, "
    "compression artifacts, jpeg artifacts, glitches, watermark, text, logo, "
    "signature, copyright, subtitles, distorted sound, saturated sound, loud"
)

DEFAULT_CKPT_CANDIDATES = (
    "ltx-2.3-22b-dev-fp8.safetensors",
    "ltx-2.3-22b-dev.safetensors",
)
DEFAULT_VIDEO_VAE_CANDIDATES = (
    "LTX23_video_vae_bf16.safetensors",
    "ltx23_video_vae_bf16.safetensors",
)
DEFAULT_TEXT_ENCODER_CANDIDATES = (
    "gemma_3_12B_it_fp8_e4m3fn.safetensors",
    "gemma_3_12B_it_fp4_mixed.safetensors",
    "gemma_3_12B_it.safetensors",
)
DEFAULT_LATENT_UPSCALER_1_CANDIDATES = (
    "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    "ltx-2.3-spatial-upscaler-x2-1.0.safetensors",
)
DEFAULT_LATENT_UPSCALER_2_CANDIDATES = (
    "ltx-2.3-spatial-upscaler-x2-1.0.safetensors",
    "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
)
DEFAULT_TRANSITION_LORA_CANDIDATES = (
    "LTX\\ltx2.3-transition.safetensors",
    "ltx2.3-transition.safetensors",
)
DEFAULT_REFOCUS_LORA_CANDIDATES = (
    "LTX\\ltx-2.3-22b-ic-lora-refocus.safetensors",
    "ltx-2.3-22b-ic-lora-refocus.safetensors",
)
DEFAULT_DETAILER_LORA_CANDIDATES = (
    "LTX\\ltx-2-19b-ic-lora-detailer-ba1e0b4544bd.safetensors",
    "ltx-2-19b-ic-lora-detailer-ba1e0b4544bd.safetensors",
)

DEFAULT_BASE_WIDTH = 736
DEFAULT_BASE_HEIGHT = 1280
DEFAULT_FRAME_COUNT = 197
DEFAULT_FPS = 24
DEFAULT_STAGE1_SEED = 23
DEFAULT_STAGE2_SEED = 42
DEFAULT_GUIDE_STRENGTH = 0.7
DEFAULT_TRANSITION_LORA_STRENGTH = 1.0
DEFAULT_REFOCUS_LORA_STRENGTH = 0.2
DEFAULT_DETAILER_LORA_STRENGTH = 0.5
DEFAULT_PREPROCESS_LONG_EDGE = 1536
DEFAULT_PREPROCESS_COMPRESSION = 18
DEFAULT_STAGE1_SAMPLER = "euler_ancestral_cfg_pp"
DEFAULT_STAGE2_SAMPLER = "euler_cfg_pp"
DEFAULT_STAGE1_SIGMAS = (
    "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
)
DEFAULT_STAGE2_SIGMAS = "0.85, 0.7250, 0.4219, 0.0"
DEFAULT_CFG = 1.0
DEFAULT_NAG_SCALE = 11.0
DEFAULT_NAG_ALPHA = 0.25
DEFAULT_NAG_TAU = 2.5
DEFAULT_VAE_TILE_SIZE = 768
DEFAULT_VAE_OVERLAP = 64
DEFAULT_VAE_TEMPORAL_SIZE = 4096
DEFAULT_VAE_TEMPORAL_OVERLAP = 4


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


def _normalize_text(text: str) -> str:
    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _filtered_ltx_names(category: str) -> list[str]:
    names = _safe_filename_list(category)
    return [name for name in names if "ltx" in _normalize_text(name)] or names


def _choices_with_auto(category: str) -> list[str]:
    choices = [AUTO_LORA, DISABLE_LORA]
    for name in _filtered_ltx_names(category):
        if name not in choices:
            choices.append(name)
    return choices


def _resolve_selected_lora(
    selection: str,
    strength: float,
    candidates: Iterable[str],
    label: str,
) -> tuple[str, float, str]:
    try:
        strength_value = float(strength)
    except Exception:
        strength_value = 0.0
    if abs(strength_value) <= 1e-6:
        return "", 0.0, ""

    selected = str(selection or "").strip()
    available = _safe_filename_list("loras")
    if not selected or selected == DISABLE_LORA:
        return "", 0.0, ""
    if selected == AUTO_LORA:
        for candidate in candidates:
            resolved = _pick_available_name(candidate, available)
            if resolved:
                return resolved, strength_value, ""
        return "", 0.0, f"{label}：未找到候选 LoRA，已跳过"

    resolved = _pick_available_name(selected, available)
    if resolved:
        return resolved, strength_value, ""
    return "", 0.0, f"{label}：{selected} 未找到，已跳过"


def _apply_loras(model, loras: Iterable[tuple[str, float]]):
    current = model
    for lora_name, strength in loras:
        if not lora_name or abs(float(strength)) <= 1e-6:
            continue
        current = LoraLoaderModelOnly().load_lora_model_only(
            current, lora_name, float(strength)
        )[0]
    return current


def _ceil_to_multiple(value: float, step: int = 32, minimum: int = 64) -> int:
    numeric = max(1.0, float(value or 0))
    return max(int(minimum), int(-(-int(numeric) // int(step)) * int(step)))


def _round_to_multiple(value: float, step: int = 32, minimum: int = 64) -> int:
    numeric = max(1.0, float(value or 0))
    return max(int(minimum), int(round(numeric / float(step)) * int(step)))


def _ensure_image(image: torch.Tensor, label: str) -> torch.Tensor:
    if image is None or getattr(image, "shape", None) is None:
        raise RuntimeError(f"未连接{label}。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4 or int(image.shape[0]) <= 0:
        raise RuntimeError(f"{label}不是有效的 IMAGE 张量。")
    if _is_empty_loader_placeholder(image):
        raise RuntimeError(
            f"{label}接到了 64x64 空占位图。请优先连接多图片加载器的“批量图片队列”，或连接已经选中的单图输出。"
        )
    return image[:1].contiguous()


def _split_image_batch(value: Any) -> list[torch.Tensor]:
    if value is None or not isinstance(value, torch.Tensor):
        return []
    if value.ndim == 3:
        return [value.unsqueeze(0).contiguous()]
    if value.ndim != 4:
        return []
    return [
        value[index : index + 1].contiguous() for index in range(int(value.shape[0]))
    ]


def _filter_valid_images(images: Iterable[Any]) -> tuple[list[torch.Tensor], int]:
    valid: list[torch.Tensor] = []
    skipped = 0
    for image in images:
        if not isinstance(image, torch.Tensor):
            continue
        if image.ndim == 3:
            image = image.unsqueeze(0)
        if image.ndim != 4 or int(image.shape[0]) <= 0:
            continue
        if _is_empty_loader_placeholder(image):
            skipped += 1
            continue
        valid.append(image[:1].contiguous())
    return valid, skipped


def _resolve_first_last_images(
    image_queue: Any, first_image: Any, last_image: Any
) -> tuple[torch.Tensor, torch.Tensor, int, int]:
    queue_images, skipped_queue = _filter_valid_images(_split_image_batch(image_queue))
    direct_images, skipped_direct = _filter_valid_images([first_image, last_image])

    if len(queue_images) >= 2:
        return (
            queue_images[0],
            queue_images[1],
            len(queue_images),
            skipped_queue + skipped_direct,
        )

    first = queue_images[0] if len(queue_images) >= 1 else None
    last = None
    if len(queue_images) >= 2:
        last = queue_images[1]

    if first is None and len(direct_images) >= 1:
        first = direct_images[0]
    if last is None:
        if len(direct_images) >= 2:
            last = direct_images[1]
        elif (
            len(queue_images) >= 1
            and len(direct_images) >= 1
            and direct_images[0] is not first
        ):
            last = direct_images[0]

    if first is None or last is None:
        raise RuntimeError(
            "未收到有效的首帧和尾帧图片。推荐把 GJJ · 批量多图片加载预览器 的“批量图片队列”输出接到本节点“首尾帧队列”，"
            "并至少选择 2 张图片；也可以分别连接“首帧图片”和“尾帧图片”。"
        )
    return (
        _ensure_image(first, "首帧图片"),
        _ensure_image(last, "尾帧图片"),
        len(queue_images),
        skipped_queue + skipped_direct,
    )


def _is_empty_loader_placeholder(image: Any) -> bool:
    if not isinstance(image, torch.Tensor):
        return False
    if image.ndim != 4:
        return False
    if (
        int(image.shape[0]) != 1
        or int(image.shape[1]) != 64
        or int(image.shape[2]) != 64
    ):
        return False
    try:
        return float(image.detach().abs().amax().item()) <= 1e-7
    except Exception:
        return False


def _resize_center_crop(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    return (
        comfy.utils.common_upscale(
            image.movedim(-1, 1),
            int(width),
            int(height),
            "lanczos",
            "center",
        )
        .movedim(1, -1)
        .contiguous()
    )


def _resize_to_long_edge(image: torch.Tensor, long_edge: int) -> torch.Tensor:
    if int(long_edge) <= 0:
        return image.contiguous()
    height = int(image.shape[1])
    width = int(image.shape[2])
    if width <= 0 or height <= 0:
        raise RuntimeError("输入图片尺寸无效。")
    if width >= height:
        target_width = int(long_edge)
        target_height = max(64, int(round(height * (target_width / float(width)))))
    else:
        target_height = int(long_edge)
        target_width = max(64, int(round(width * (target_height / float(height)))))
    target_width = _round_to_multiple(target_width, 32, 64)
    target_height = _round_to_multiple(target_height, 32, 64)
    return (
        comfy.utils.common_upscale(
            image.movedim(-1, 1),
            target_width,
            target_height,
            "lanczos",
            "center",
        )
        .movedim(1, -1)
        .contiguous()
    )


def _prepare_reference_image(
    image: torch.Tensor, width: int, height: int, long_edge: int, compression: int
) -> torch.Tensor:
    resized = _resize_center_crop(image, width, height)
    resized = _resize_to_long_edge(resized, int(long_edge))
    return LTXVPreprocess.execute(resized, int(compression))[0]


class GJJ_LTX23FirstLastOutfit:
    CATEGORY = "GJJ/视频"
    FUNCTION = "generate"
    DESCRIPTION = "LTX-2.3 首尾帧变装转场一体化节点：输入首帧和尾帧，内部完成 LTX guide、过渡 LoRA、两段采样、latent 放大和视频输出，不依赖 KJ/VHS/ComfyMath 等外部自定义节点。"
    SEARCH_ALIASES = [
        "ltx2.3 首尾帧",
        "ltx first last outfit",
        "ltx first last transition",
        "首尾帧变装",
        "变装转场",
        "zhuanchang",
    ]
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频生成结果",)
    OUTPUT_TOOLTIPS = (
        "由首帧到尾帧连续变装过渡的视频结果，内部使用 ComfyUI 自带 VIDEO 输出。",
    )

    def __init__(self):
        self.loaded_lora: tuple[str, Any] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        ckpts = _filtered_ltx_names("checkpoints") or list(DEFAULT_CKPT_CANDIDATES)
        default_ckpt = (
            _pick_available_name(DEFAULT_CKPT_CANDIDATES[0], ckpts) or ckpts[0]
        )
        lora_choices = _choices_with_auto("loras")
        return {
            "required": {
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_PROMPT,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "描述从首帧到尾帧的连续变化、人物动作、服装发型和镜头方式。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "反向提示词",
                        "tooltip": "用于压制水印、文字、噪声、畸变和音频异常等问题。",
                    },
                ),
                "ckpt_name": (
                    ckpts,
                    {
                        "default": default_ckpt,
                        "display_name": "LTX主模型",
                        "tooltip": "LTX-2.3 主 checkpoint；文本编码器、视频 VAE、音频 VAE 和 latent 放大模型会自动匹配。",
                    },
                ),
                "transition_lora": (
                    lora_choices,
                    {
                        "default": AUTO_LORA,
                        "display_name": "过渡LoRA",
                        "tooltip": "默认自动匹配 ltx2.3-transition.safetensors；找不到时会跳过并在状态栏提示。",
                    },
                ),
                "transition_lora_strength": (
                    "FLOAT",
                    {
                        "default": DEFAULT_TRANSITION_LORA_STRENGTH,
                        "min": 0.0,
                        "max": 4.0,
                        "step": 0.05,
                        "display_name": "过渡LoRA强度",
                        "tooltip": "控制变装/转场 LoRA 的强度；设为 0 可关闭。",
                    },
                ),
                "refocus_lora": (
                    lora_choices,
                    {
                        "default": DISABLE_LORA,
                        "display_name": "辅助聚焦LoRA",
                        "tooltip": "可选项，默认关闭；可用于手动接入参考工作流里的 refocus LoRA。",
                    },
                ),
                "refocus_lora_strength": (
                    "FLOAT",
                    {
                        "default": DEFAULT_REFOCUS_LORA_STRENGTH,
                        "min": 0.0,
                        "max": 4.0,
                        "step": 0.05,
                        "display_name": "聚焦LoRA强度",
                        "tooltip": "辅助聚焦 LoRA 的强度；只有选择了 LoRA 且强度大于 0 时才生效。",
                    },
                ),
                "detailer_lora": (
                    lora_choices,
                    {
                        "default": DISABLE_LORA,
                        "display_name": "辅助细节LoRA",
                        "tooltip": "可选项，默认关闭；可用于手动接入参考工作流里的 detailer LoRA。",
                    },
                ),
                "detailer_lora_strength": (
                    "FLOAT",
                    {
                        "default": DEFAULT_DETAILER_LORA_STRENGTH,
                        "min": 0.0,
                        "max": 4.0,
                        "step": 0.05,
                        "display_name": "细节LoRA强度",
                        "tooltip": "辅助细节 LoRA 的强度；只有选择了 LoRA 且强度大于 0 时才生效。",
                    },
                ),
                "base_width": (
                    "INT",
                    {
                        "default": DEFAULT_BASE_WIDTH,
                        "min": 64,
                        "max": 4096,
                        "step": 32,
                        "display_name": "工作宽度",
                        "tooltip": "首尾参考图先适配到此宽度；开启二次放大后最终视频宽度约为它的 2 倍。",
                    },
                ),
                "base_height": (
                    "INT",
                    {
                        "default": DEFAULT_BASE_HEIGHT,
                        "min": 64,
                        "max": 4096,
                        "step": 32,
                        "display_name": "工作高度",
                        "tooltip": "首尾参考图先适配到此高度；开启二次放大后最终视频高度约为它的 2 倍。",
                    },
                ),
                "frame_count": (
                    "INT",
                    {
                        "default": DEFAULT_FRAME_COUNT,
                        "min": 9,
                        "max": 1000,
                        "step": 1,
                        "display_name": "帧数",
                        "tooltip": "视频 latent 的总帧数，参考工作流默认 197。",
                    },
                ),
                "fps": (
                    "INT",
                    {
                        "default": DEFAULT_FPS,
                        "min": 1,
                        "max": 120,
                        "step": 1,
                        "display_name": "帧率",
                        "tooltip": "LTX 条件帧率和输出视频帧率。",
                    },
                ),
                "stage1_seed": (
                    "INT",
                    {
                        "default": DEFAULT_STAGE1_SEED,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "低清种子",
                        "tooltip": "第一阶段低清采样种子，参考工作流默认 23。",
                    },
                ),
                "stage2_seed": (
                    "INT",
                    {
                        "default": DEFAULT_STAGE2_SEED,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "高清种子",
                        "tooltip": "第二阶段高清采样种子，参考工作流默认 42。",
                    },
                ),
                "first_strength": (
                    "FLOAT",
                    {
                        "default": DEFAULT_GUIDE_STRENGTH,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "首帧强度",
                        "tooltip": "首帧 guide 强度，参考工作流默认 0.7。",
                    },
                ),
                "last_strength": (
                    "FLOAT",
                    {
                        "default": DEFAULT_GUIDE_STRENGTH,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "尾帧强度",
                        "tooltip": "尾帧 guide 强度，参考工作流默认 0.7。",
                    },
                ),
                "double_latent_upscale": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "二次latent放大",
                        "tooltip": "开启后按参考工作流连续使用两次 LTX latent 放大，输出约为工作宽高的 2 倍；显存不足时可关闭。",
                    },
                ),
                "decode_generated_audio": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "生成模型音频",
                        "tooltip": "开启后解码 LTX 音频 latent 并随视频输出；关闭可降低一点后处理开销。",
                    },
                ),
            },
            "optional": {
                "image_queue": (
                    f"{GJJ_BATCH_IMAGE_TYPE},IMAGE",
                    {
                        "display_name": "首尾帧队列",
                        "tooltip": "推荐直接连接 GJJ · 批量多图片加载预览器 的“批量图片队列”；节点会自动取第 1 张为首帧、第 2 张为尾帧，并忽略未选中的 64x64 空占位图。",
                    },
                ),
                "first_image": (
                    "IMAGE",
                    {
                        "display_name": "首帧图片",
                        "tooltip": "备用单图输入。接首帧图片；如果已连接首尾帧队列，队列优先。",
                    },
                ),
                "last_image": (
                    "IMAGE",
                    {
                        "display_name": "尾帧图片",
                        "tooltip": "备用单图输入。接尾帧图片；如果已连接首尾帧队列，队列优先。",
                    },
                ),
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "display_name": "LoRA串联配置",
                        "tooltip": "可选。接入 GJJ · LoRA串联配置 后，会在面板 LoRA 之后继续串联应用。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        positive_prompt,
        negative_prompt,
        ckpt_name,
        transition_lora,
        transition_lora_strength,
        refocus_lora,
        refocus_lora_strength,
        detailer_lora,
        detailer_lora_strength,
        base_width,
        base_height,
        frame_count,
        fps,
        stage1_seed,
        stage2_seed,
        first_strength,
        last_strength,
        double_latent_upscale=True,
        decode_generated_audio=True,
        image_queue=None,
        first_image=None,
        last_image=None,
        lora_chain_config="",
        unique_id=None,
    ):
        started_at = time.perf_counter()
        try:
            return self._generate(
                first_image=first_image,
                last_image=last_image,
                positive_prompt=positive_prompt,
                negative_prompt=negative_prompt,
                ckpt_name=ckpt_name,
                transition_lora=transition_lora,
                transition_lora_strength=transition_lora_strength,
                refocus_lora=refocus_lora,
                refocus_lora_strength=refocus_lora_strength,
                detailer_lora=detailer_lora,
                detailer_lora_strength=detailer_lora_strength,
                base_width=base_width,
                base_height=base_height,
                frame_count=frame_count,
                fps=fps,
                stage1_seed=stage1_seed,
                stage2_seed=stage2_seed,
                first_strength=first_strength,
                last_strength=last_strength,
                double_latent_upscale=double_latent_upscale,
                decode_generated_audio=decode_generated_audio,
                image_queue=image_queue,
                lora_chain_config=lora_chain_config,
                unique_id=unique_id,
                started_at=started_at,
            )
        finally:
            _aggressive_purge_runtime()

    def _generate(
        self,
        *,
        first_image,
        last_image,
        positive_prompt,
        negative_prompt,
        ckpt_name,
        transition_lora,
        transition_lora_strength,
        refocus_lora,
        refocus_lora_strength,
        detailer_lora,
        detailer_lora_strength,
        base_width,
        base_height,
        frame_count,
        fps,
        stage1_seed,
        stage2_seed,
        first_strength,
        last_strength,
        double_latent_upscale,
        decode_generated_audio,
        image_queue,
        lora_chain_config,
        unique_id,
        started_at,
    ):
        prompt_text = str(positive_prompt or "").strip() or DEFAULT_PROMPT
        negative_text = str(negative_prompt or "").strip() or DEFAULT_NEGATIVE
        base_width = _ceil_to_multiple(base_width, 32, 64)
        base_height = _ceil_to_multiple(base_height, 32, 64)
        lowres_width = _round_to_multiple(base_width / 2.0, 32, 64)
        lowres_height = _round_to_multiple(base_height / 2.0, 32, 64)
        frame_count = max(9, int(frame_count))
        fps = max(1, int(fps))
        upscale_count = 2 if bool(double_latent_upscale) else 1
        final_width = base_width * (2 if bool(double_latent_upscale) else 1)
        final_height = base_height * (2 if bool(double_latent_upscale) else 1)

        first_image, last_image, queue_count, skipped_placeholders = (
            _resolve_first_last_images(image_queue, first_image, last_image)
        )
        if skipped_placeholders:
            _send_status(
                unique_id,
                f"提示：已忽略 {skipped_placeholders} 张 64x64 空占位图。建议连接“批量图片队列”输出。",
                0.01,
            )
        if queue_count >= 2:
            _send_status(
                unique_id,
                f"提示：已从首尾帧队列读取 {queue_count} 张图片，使用第 1 张作为首帧、第 2 张作为尾帧。",
                0.01,
            )

        _send_status(
            unique_id, "1/9 加载 LTX 模型、VAE、文本编码器和 latent 放大模型...", 0.02
        )
        try:
            resolved_ckpt = _pick_available_name(
                str(ckpt_name or ""), _safe_filename_list("checkpoints")
            )
            if not resolved_ckpt:
                resolved_ckpt = _pick_first_candidate(
                    "checkpoints", DEFAULT_CKPT_CANDIDATES, "LTX 主模型"
                )
            resolved_video_vae = _pick_first_candidate(
                "vae", DEFAULT_VIDEO_VAE_CANDIDATES, "LTX 视频 VAE"
            )
            resolved_text_encoder = _pick_first_candidate(
                "text_encoders", DEFAULT_TEXT_ENCODER_CANDIDATES, "LTX 文本编码器"
            )
            resolved_upscaler_1 = _pick_first_candidate(
                "latent_upscale_models",
                DEFAULT_LATENT_UPSCALER_1_CANDIDATES,
                "LTX latent 放大模型 1",
            )
            resolved_upscaler_2 = ""
            if bool(double_latent_upscale):
                resolved_upscaler_2 = _pick_first_candidate(
                    "latent_upscale_models",
                    DEFAULT_LATENT_UPSCALER_2_CANDIDATES,
                    "LTX latent 放大模型 2",
                )

            model, _, _ = CheckpointLoaderSimple().load_checkpoint(resolved_ckpt)
            video_vae = _load_vae(resolved_video_vae)
            audio_vae = LTXVAudioVAELoader.execute(resolved_ckpt)[0]
            clip = LTXAVTextEncoderLoader.execute(
                resolved_text_encoder, resolved_ckpt, "default"
            )[0]
            latent_upscaler_1 = LatentUpscaleModelLoader.execute(resolved_upscaler_1)[0]
            latent_upscaler_2 = (
                LatentUpscaleModelLoader.execute(resolved_upscaler_2)[0]
                if resolved_upscaler_2
                else None
            )
        except Exception as exc:
            raise RuntimeError(f"LTX 首尾帧变装节点加载模型失败：{exc}") from exc

        _send_status(unique_id, "2/9 匹配并应用过渡 LoRA...", 0.12)
        try:
            lora_items = []
            notices = []
            for selection, strength, candidates, label in (
                (
                    transition_lora,
                    transition_lora_strength,
                    DEFAULT_TRANSITION_LORA_CANDIDATES,
                    "过渡LoRA",
                ),
                (
                    refocus_lora,
                    refocus_lora_strength,
                    DEFAULT_REFOCUS_LORA_CANDIDATES,
                    "辅助聚焦LoRA",
                ),
                (
                    detailer_lora,
                    detailer_lora_strength,
                    DEFAULT_DETAILER_LORA_CANDIDATES,
                    "辅助细节LoRA",
                ),
            ):
                name, resolved_strength, notice = _resolve_selected_lora(
                    selection, strength, candidates, label
                )
                if name:
                    lora_items.append((name, resolved_strength))
                if notice:
                    notices.append(notice)
            if notices:
                _send_status(unique_id, "提示：" + "；".join(notices), 0.14)
            model = _apply_loras(model, lora_items)
            if str(lora_chain_config or "").strip():
                model, clip = _apply_chain_loras(model, clip, lora_chain_config)
            model = _apply_ff_chunking(model)
        except Exception as exc:
            raise RuntimeError(f"LTX 首尾帧变装节点应用 LoRA 失败：{exc}") from exc

        _send_status(unique_id, "3/9 处理首帧和尾帧参考图...", 0.22)
        try:
            first_ref = _prepare_reference_image(
                first_image,
                base_width,
                base_height,
                DEFAULT_PREPROCESS_LONG_EDGE,
                DEFAULT_PREPROCESS_COMPRESSION,
            )
            last_ref = _prepare_reference_image(
                last_image,
                base_width,
                base_height,
                DEFAULT_PREPROCESS_LONG_EDGE,
                DEFAULT_PREPROCESS_COMPRESSION,
            )
        except Exception as exc:
            raise RuntimeError(f"LTX 首尾帧变装节点预处理图片失败：{exc}") from exc

        _send_status(unique_id, "4/9 编码提示词并注入首尾帧 guide...", 0.32)
        try:
            positive_base = CLIPTextEncode().encode(clip, prompt_text)[0]
            negative_base = CLIPTextEncode().encode(clip, negative_text)[0]
            model_nag = _apply_ltx_nag(
                model,
                negative_base,
                DEFAULT_NAG_SCALE,
                DEFAULT_NAG_ALPHA,
                DEFAULT_NAG_TAU,
                inplace=True,
            )
            positive, negative = LTXVConditioning.execute(
                positive_base, negative_base, float(fps)
            )[0:2]
            video_latent = EmptyLTXVLatentVideo.execute(
                lowres_width, lowres_height, frame_count, 1
            )[0]
            if float(first_strength) > 0:
                positive, negative, video_latent = LTXVAddGuide.execute(
                    positive,
                    negative,
                    video_vae,
                    video_latent,
                    first_ref,
                    0,
                    float(first_strength),
                )[0:3]
            if float(last_strength) > 0:
                positive, negative, video_latent = LTXVAddGuide.execute(
                    positive,
                    negative,
                    video_vae,
                    video_latent,
                    last_ref,
                    -1,
                    float(last_strength),
                )[0:3]
            audio_latent = LTXVEmptyLatentAudio.execute(frame_count, fps, 1, audio_vae)[
                0
            ]
            av_latent_stage1 = LTXVConcatAVLatent.execute(video_latent, audio_latent)[0]
        except Exception as exc:
            raise RuntimeError(
                f"LTX 首尾帧变装节点构建初始 latent 失败：{exc}"
            ) from exc

        _send_status(unique_id, "5/9 第一阶段低清采样...", 0.42)
        try:
            guider_stage1 = CFGGuider.execute(
                model_nag, positive, negative, DEFAULT_CFG
            )[0]
            sampler_stage1 = KSamplerSelect.execute(DEFAULT_STAGE1_SAMPLER)[0]
            sigmas_stage1 = ManualSigmas.execute(DEFAULT_STAGE1_SIGMAS)[0]
            noise_stage1 = RandomNoise.execute(int(stage1_seed))[0]
            stage1_result = SamplerCustomAdvanced.execute(
                noise_stage1,
                guider_stage1,
                sampler_stage1,
                sigmas_stage1,
                av_latent_stage1,
            )[0]
            video_latent_stage1, audio_latent_stage1 = LTXVSeparateAVLatent.execute(
                stage1_result
            )[0:2]
        except Exception as exc:
            raise RuntimeError(f"LTX 首尾帧变装节点第一阶段采样失败：{exc}") from exc

        _send_status(
            unique_id, f"6/9 latent 放大 {upscale_count} 次并准备高清阶段...", 0.58
        )
        try:
            positive_stage2, negative_stage2, video_latent_stage1_cropped = (
                LTXVCropGuides.execute(
                    positive,
                    negative,
                    video_latent_stage1,
                )[0:3]
            )
            video_latent_high = LTXVLatentUpsampler().upsample_latent(
                video_latent_stage1_cropped, latent_upscaler_1, video_vae
            )[0]
            if latent_upscaler_2 is not None:
                video_latent_high = LTXVLatentUpsampler().upsample_latent(
                    video_latent_high, latent_upscaler_2, video_vae
                )[0]
            video_latent_high = LTXVImgToVideoInplace.execute(
                video_vae, first_ref, video_latent_high, 1.0, False
            )[0]
            av_latent_stage2 = LTXVConcatAVLatent.execute(
                video_latent_high, audio_latent_stage1
            )[0]
        except Exception as exc:
            raise RuntimeError(
                f"LTX 首尾帧变装节点高清 latent 准备失败：{exc}"
            ) from exc

        _send_status(unique_id, "7/9 第二阶段高清采样...", 0.70)
        try:
            guider_stage2 = CFGGuider.execute(
                model_nag, positive_stage2, negative_stage2, DEFAULT_CFG
            )[0]
            sampler_stage2 = KSamplerSelect.execute(DEFAULT_STAGE2_SAMPLER)[0]
            sigmas_stage2 = ManualSigmas.execute(DEFAULT_STAGE2_SIGMAS)[0]
            noise_stage2 = RandomNoise.execute(int(stage2_seed))[0]
            stage2_result = SamplerCustomAdvanced.execute(
                noise_stage2,
                guider_stage2,
                sampler_stage2,
                sigmas_stage2,
                av_latent_stage2,
            )[0]
            video_latent_stage2, audio_latent_stage2 = LTXVSeparateAVLatent.execute(
                stage2_result
            )[0:2]
        except Exception as exc:
            raise RuntimeError(f"LTX 首尾帧变装节点第二阶段采样失败：{exc}") from exc

        _send_status(unique_id, "8/9 解码视频帧与模型音频...", 0.88)
        try:
            frames = VAEDecodeTiled().decode(
                video_vae,
                video_latent_stage2,
                DEFAULT_VAE_TILE_SIZE,
                DEFAULT_VAE_OVERLAP,
                DEFAULT_VAE_TEMPORAL_SIZE,
                DEFAULT_VAE_TEMPORAL_OVERLAP,
            )[0]
            frames = _slice_output_frames(frames, 0, frame_count)
            frames = _crop_frames_to_size(frames, final_width, final_height)
            output_audio = (
                LTXVAudioVAEDecode.execute(audio_latent_stage2, audio_vae)[0]
                if bool(decode_generated_audio)
                else None
            )
        except Exception as exc:
            raise RuntimeError(f"LTX 首尾帧变装节点解码失败：{exc}") from exc

        _send_status(unique_id, "9/9 创建 VIDEO 输出...", 0.96)
        video = _create_video(frames, float(fps), output_audio)
        elapsed = time.perf_counter() - started_at
        audio_text = "模型音频" if output_audio is not None else "无音频"
        _send_status(
            unique_id,
            f"完成：{final_width}x{final_height} / {frame_count} 帧 / {fps}fps / {audio_text} / 耗时 {elapsed:.1f} 秒",
            1.0,
        )
        return {
            "ui": {
                "resolved_width": [int(final_width)],
                "resolved_height": [int(final_height)],
                "resolved_frame_count": [int(frame_count)],
                "resolved_fps": [int(fps)],
            },
            "result": (video,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTX23FirstLastOutfit}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 LTX首尾帧变装转场"}
