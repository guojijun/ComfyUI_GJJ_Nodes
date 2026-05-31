from __future__ import annotations

from typing import Any
import time

import comfy.samplers
import folder_paths

from nodes import (
    CLIPTextEncode,
    CheckpointLoaderSimple,
    EmptyLatentImage,
    KSampler,
    VAEDecode,
    VAEEncode,
    PreviewImage,
)
from .gjj_multi_lora_chain import apply_lora_chain_config, normalize_lora_chain_data

NODE_NAME = "GJJ_CheckpointDirectGenerator"
DEFAULT_CHECKPOINT = ""
DEFAULT_POSITIVE = "masterpiece, best quality, ultra detailed, 1Chinese young girl, east asian facial features, fair skin, delicate face, black long hair, gentle eyes, sitting in modern cafe, holding ceramic coffee cup, sipping coffee, casual chinese style clothing, warm indoor light, cozy cafe interior, soft focus, natural expression, slim figure"
DEFAULT_NEGATIVE = "lowres, worst quality, low quality, deformed, blurry, ugly, foreigner, western face, big nose, deep eye socket, 3d render, cartoon, anime, illustration, extra limbs, bad hands, missing fingers"
DEFAULT_WIDTH = 512
DEFAULT_HEIGHT = 512
DEFAULT_BATCH_SIZE = 1
DEFAULT_SEED = 0
DEFAULT_STEPS = 20
DEFAULT_CFG = 7.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "normal"
DEFAULT_DENOISE = 1.0
UNSUPPORTED_CHECKPOINT_KEYWORDS = (
    "hunyuan",
    "ltx-",
    "supir",
    "supir-",
    "qwen-image-2512",
    "qwen_image_2512",
    "aisha_",
    "ace_step",
    "wan2.2",
)


def _preferred_default(values: list[str], preferred: str) -> str:
    preferred = str(preferred or "").strip()
    if preferred and preferred in values:
        return preferred
    return values[0] if values else ""


def _is_unsupported_checkpoint(name: str) -> bool:
    text = str(name or "").replace("\\", "/").lower()
    return any(keyword in text for keyword in UNSUPPORTED_CHECKPOINT_KEYWORDS)


def _list_supported_checkpoints() -> list[str]:
    checkpoints = list(folder_paths.get_filename_list("checkpoints")) or [""]
    filtered = [name for name in checkpoints if not _is_unsupported_checkpoint(name)]
    return filtered or checkpoints


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        status_text = str(text or "").strip()
        if not status_text:
            status_text = "处理中..."

        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": status_text},
        )
    except Exception:
        pass


def _send_lora_applied(unique_id: Any, payload: dict[str, Any]) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        data = dict(payload or {})
        data["node"] = str(unique_id)
        PromptServer.instance.send_sync("gjj_lora_applied", data)
    except Exception:
        pass


def _send_lora_failed(unique_id: Any, payload: dict[str, Any]) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        data = dict(payload or {})
        data["node"] = str(unique_id)
        PromptServer.instance.send_sync("gjj_lora_failed", data)
    except Exception:
        pass


def _stage_error(stage: str, ckpt_name: str, exc: Exception) -> RuntimeError:
    return RuntimeError(
        f"{stage}失败。\n" f"底模：{ckpt_name or '[未选择]'}\n" f"详细错误：{exc}"
    )


def _unsupported_checkpoint_error(ckpt_name: str) -> RuntimeError:
    return RuntimeError(
        "当前选择的文件不是可直接生图的底模 checkpoint。\n"
        f"底模：{ckpt_name or '[未选择]'}\n"
        "原因：SUPIR-v0F / SUPIR-v0Q 是 SUPIR 修复/超分专用权重，不能用普通 CheckpointLoaderSimple 加载。\n"
        "处理：请在本节点选择 SDXL/SD1.5 等真正的基础模型；SUPIR 权重请放到对应的 SUPIR 工作流或 SUPIR 节点中使用。"
    )


class GJJ_CheckpointDirectGenerator:
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    OUTPUT_NODE = True  # ✅ 标记为输出节点，允许单节点执行
    DESCRIPTION = "单节点加载底模 checkpoint 直接出图，内部自动完成提示词编码、latent 创建、采样和 VAE 解码。"
    SEARCH_ALIASES = [
        "checkpoint",
        "ckpt",
        "直接生图",
        "一键生图",
        "文生图",
        "txt2img",
    ]
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("🖼️ 生成图像",)
    OUTPUT_TOOLTIPS = (
        "输出按当前底模和节点内部参数直接生成的图片批次。无输入图片时走文生图，有输入图片时走图生图。",
    )

    def __init__(self):
        self.loaded_lora: tuple[str, Any] | None = None
        self.preview_image = PreviewImage()

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = _list_supported_checkpoints() or [""]
        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
        return {
            "required": {
                "ckpt_name": (
                    checkpoints,
                    {
                        "default": _preferred_default(checkpoints, DEFAULT_CHECKPOINT),
                        "display_name": "🎨 底模模型",
                        "tooltip": "直接从 ComfyUI 的 checkpoints 列表中选择要加载的主模型，支持子目录条目。",
                    },
                ),
                "positive": (
                    "STRING",
                    {
                        "default": DEFAULT_POSITIVE,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "✨ 正向提示词",
                        "tooltip": "描述想要生成内容的正向提示词。",
                    },
                ),
                "negative": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "🚫 反向提示词",
                        "tooltip": "描述不希望出现内容的反向提示词；留空时会按空白提示词编码。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": DEFAULT_WIDTH,
                        "min": 64,
                        "max": 8192,
                        "step": 8,
                        "display_name": "📐 宽度",
                        "tooltip": "输出图片宽度，建议按当前 checkpoint 的推荐分辨率设置。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": DEFAULT_HEIGHT,
                        "min": 64,
                        "max": 8192,
                        "step": 8,
                        "display_name": "📏 高度",
                        "tooltip": "输出图片高度，建议按当前 checkpoint 的推荐分辨率设置。",
                    },
                ),
                "batch_size": (
                    "INT",
                    {
                        "default": DEFAULT_BATCH_SIZE,
                        "min": 1,
                        "max": 64,
                        "display_name": "🔢 批次数",
                        "tooltip": "一次采样输出的图片批次数，返回值仍是标准 IMAGE 批量张量。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": DEFAULT_SEED,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "🎲 种子",
                        "tooltip": "随机种子；开启生成后自动变化时可快速连刷不同结果。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": DEFAULT_STEPS,
                        "min": 1,
                        "max": 10000,
                        "display_name": "👣 步数",
                        "tooltip": "扩散采样步数，通常步数越高越稳定，但耗时也越长。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": DEFAULT_CFG,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "round": 0.01,
                        "display_name": "⚖️ CFG 引导强度",
                        "tooltip": "提示词引导强度；数值越高，结果越贴近提示词，但也更容易过拟合。",
                    },
                ),
                "sampler_name": (
                    samplers,
                    {
                        "default": _preferred_default(samplers, DEFAULT_SAMPLER),
                        "display_name": "🌀 采样器",
                        "tooltip": "选择本次采样使用的采样算法。",
                    },
                ),
                "scheduler": (
                    schedulers,
                    {
                        "default": _preferred_default(schedulers, DEFAULT_SCHEDULER),
                        "display_name": "📊 调度器",
                        "tooltip": "选择噪声调度策略；不同 checkpoint 的最佳搭配可能不同。",
                    },
                ),
            },
            "optional": {
                "image": (
                    "GJJ_BATCH_IMAGE,IMAGE",
                    {
                        "display_name": "🖼️ 参考图片",
                        "tooltip": "可选。接入后节点自动切换为图生图模式；不接入则为文生图模式。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": DEFAULT_DENOISE,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "round": 0.01,
                        "display_name": "🔧 降噪强度",
                        "tooltip": "图生图模式下的降噪强度；1.0=完全重绘，0.0=保持原图。文生图模式下此参数无效。",
                    },
                ),
                "lora_chain_config": (
                    "LORA_CHAIN_CONFIG",
                    {
                        "display_name": "🔗 LoRA串联配置",
                        "tooltip": "可选。接入 GJJ · LoRA串联配置 的输出后，会按顺序串联应用多组 LoRA，并同时作用到底模与 CLIP。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        ckpt_name,
        positive,
        negative,
        width,
        height,
        batch_size,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        image=None,
        denoise=DEFAULT_DENOISE,
        lora_chain_config="",
        unique_id=None,
    ):
        return "|".join(
            [
                str(ckpt_name),
                str(positive),
                str(negative),
                str(width),
                str(height),
                str(batch_size),
                str(seed),
                str(steps),
                str(cfg),
                str(sampler_name),
                str(scheduler),
                str(denoise),
                str(normalize_lora_chain_data(lora_chain_config)),
            ]
        )

    def generate(
        self,
        ckpt_name,
        positive,
        negative,
        width,
        height,
        batch_size,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        image=None,
        denoise=DEFAULT_DENOISE,
        lora_chain_config="",
        unique_id=None,
    ):
        start_time = time.time()
        checkpoint_name = str(ckpt_name or "").strip()
        if not checkpoint_name:
            raise RuntimeError(
                "未找到可用 checkpoint 模型，请先把模型放到 models\\checkpoints 目录。"
            )
        if _is_unsupported_checkpoint(checkpoint_name):
            raise _unsupported_checkpoint_error(checkpoint_name)

        # 判断是否为图生图模式
        has_input_image = image is not None
        is_img2img = has_input_image
        mode_text = "图生图" if is_img2img else "文生图"

        try:
            _send_status(unique_id, f"⏳ 1/5 加载 checkpoint... ({mode_text}模式)")
            try:
                model, clip, vae = CheckpointLoaderSimple().load_checkpoint(
                    checkpoint_name
                )
            except Exception as exc:
                raise _stage_error("加载 checkpoint", checkpoint_name, exc) from exc

            if str(lora_chain_config or "").strip():
                _send_status(
                    unique_id, f"⏳ 2/6 应用 LoRA 串联配置... ({mode_text}模式)"
                )
                try:
                    model, clip, self.loaded_lora = apply_lora_chain_config(
                        model,
                        clip,
                        lora_data=normalize_lora_chain_data(lora_chain_config),
                        loaded_lora_cache=self.loaded_lora,
                        on_lora_applied=lambda payload: _send_lora_applied(
                            unique_id, payload
                        ),
                        on_lora_failed=lambda payload: _send_lora_failed(
                            unique_id, payload
                        ),
                    )
                except Exception as exc:
                    raise _stage_error("LoRA 串联应用", checkpoint_name, exc) from exc

                if is_img2img:
                    encode_step_text = " 3/6 编码参考图片..."
                    encode_prompt_step_text = "⏳ 4/6 编码提示词..."
                    sample_step_text = "⏳ 5/6 采样生成..."
                    decode_step_text = " 6/6 VAE 解码..."
                else:
                    encode_step_text = " 3/6 编码提示词..."
                    latent_step_text = "⏳ 4/6 创建 latent..."
                    sample_step_text = "⏳ 5/6 采样生成..."
                    decode_step_text = "⏳ 6/6 VAE 解码..."
            else:
                if is_img2img:
                    encode_step_text = "⏳ 2/5 编码参考图片..."
                    encode_prompt_step_text = "⏳ 3/5 编码提示词..."
                    sample_step_text = " 4/5 采样生成..."
                    decode_step_text = "⏳ 5/5 VAE 解码..."
                else:
                    encode_step_text = "⏳ 2/5 编码提示词..."
                    latent_step_text = "⏳ 3/5 创建 latent..."
                    sample_step_text = "⏳ 4/5 采样生成..."
                    decode_step_text = "⏳ 5/5 VAE 解码..."

            _send_status(unique_id, encode_step_text)
            if is_img2img:
                # 图生图模式：编码输入图片为 latent
                try:
                    # 确保图片是 4D 张量
                    input_image = image
                    if input_image.ndim == 3:
                        input_image = input_image.unsqueeze(0)
                    # 取第一张图片（如果是批量图片）
                    single_image = input_image[:1]
                    # 缩放到目标尺寸
                    samples = single_image.movedim(-1, 1)
                    resized = comfy.utils.common_upscale(
                        samples, int(width), int(height), "lanczos", "disabled"
                    )
                    resized = resized.movedim(1, -1)
                    latent = VAEEncode().encode(vae, resized)[0]
                except Exception as exc:
                    raise _stage_error("参考图片编码", checkpoint_name, exc) from exc

                _send_status(unique_id, encode_prompt_step_text)
            else:
                # 文生图模式：创建空 latent
                _send_status(unique_id, latent_step_text)
                try:
                    latent = EmptyLatentImage().generate(
                        int(width), int(height), int(batch_size)
                    )[0]
                except Exception as exc:
                    raise _stage_error("创建 latent", checkpoint_name, exc) from exc

            try:
                positive_conditioning = CLIPTextEncode().encode(
                    clip, str(positive or "")
                )[0]
                negative_conditioning = CLIPTextEncode().encode(
                    clip, str(negative or "")
                )[0]
            except Exception as exc:
                raise _stage_error("提示词编码", checkpoint_name, exc) from exc

            _send_status(unique_id, sample_step_text)
            try:
                sampled = KSampler().sample(
                    model,
                    int(seed),
                    int(steps),
                    float(cfg),
                    sampler_name,
                    scheduler,
                    positive_conditioning,
                    negative_conditioning,
                    latent,
                    float(denoise) if is_img2img else 1.0,
                )[0]
            except Exception as exc:
                raise _stage_error("采样", checkpoint_name, exc) from exc

            _send_status(unique_id, decode_step_text)
            try:
                image = VAEDecode().decode(vae, sampled)[0]
            except Exception as exc:
                raise _stage_error("VAE 解码", checkpoint_name, exc) from exc

            elapsed_time = time.time() - start_time
            _send_status(
                unique_id,
                f"✅ 完成：{image.shape[2]} x {image.shape[1]} | {mode_text} | 降噪: {denoise:.2f} | 耗时: {elapsed_time:.2f}s",
            )

            # 保存预览图片并返回 UI 数据
            preview_ui = self.preview_image.save_images(
                image,
                filename_prefix="GJJ_CheckpointDirectGenerator",
            )
            preview_images = preview_ui.get("ui", {}).get("images", [])

            return {"ui": {"images": preview_images}, "result": (image,)}
        except RuntimeError as exc:
            elapsed_time = time.time() - start_time
            _send_status(
                unique_id,
                f"❌ 执行失败：{str(exc).splitlines()[0]} | 耗时: {elapsed_time:.2f}s",
            )
            raise


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_CheckpointDirectGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🖼️ 底模一键生图"}
