from __future__ import annotations

import json
import importlib
import secrets
from typing import Any

from aiohttp import web

from . import gjj_ltx23_multiref_image_to_video as ltx23
from .common_utils.model_manager import gjjutils_model_search_state


NODE_NAME = "GJJ_LTX25ImageToVideoMultiRef"
DEFAULT_MODEL = "ltx-2.5-22b-distilled-transformer-int4-convrot.safetensors"
DEFAULT_CLIP = "gemma4-12b-with-proj-ltx-2.5-int4-convrot.safetensors"
DEFAULT_VIDEO_VAE = "ltx-2.5-video-vae-bf16.safetensors"
DEFAULT_AUDIO_VAE = "ltx-2.5-audio-vae-bf16.safetensors"
DEFAULT_UPSCALER = "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"
_LAST_EXECUTION_SEEDS: dict[str, int] = {}


def _state(keywords, folders, default, mode="AND") -> dict[str, Any]:
    return gjjutils_model_search_state(keywords, folders, default, mode)


def _model_fields() -> list[dict[str, Any]]:
    definitions = (
        ("ltx_model_name", "LTX 2.5 主模型", "diffusion_models", ("ltx", "2.5", "22b"), DEFAULT_MODEL, "LTX 2.5 主扩散模型。"),
        ("ltx_text_encoder_name", "Gemma4 CLIP（含 Projection）", "text_encoders", ("gemma4", "ltx", "2.5"), DEFAULT_CLIP, "LTX 2.5 Gemma4 文本编码器，文件内已包含 Projection。"),
        ("ltx_video_vae_name", "LTX 2.5 视频 VAE", "vae", ("ltx", "2.5", "video", "vae"), DEFAULT_VIDEO_VAE, "LTX 2.5 视频 VAE。"),
        ("ltx_audio_vae_name", "LTX 2.5 音频 VAE", "vae", ("ltx", "2.5", "audio", "vae"), DEFAULT_AUDIO_VAE, "LTX 2.5 音频 VAE。"),
        ("ltx_latent_upscaler_name", "LTX 2.5 Latent 放大模型", "latent_upscale_models", ("ltx", "2.5", "spatial", "upscaler"), DEFAULT_UPSCALER, "LTX 2.5 latent 空间放大模型。"),
    )
    fields = []
    for name, label, folder, keywords, default, description in definitions:
        folders = (folder, "upscale_models") if folder == "latent_upscale_models" else folder
        state = _state(keywords, folders, default)
        fields.append({
            "name": name,
            "label": label,
            "folder": folder,
            "path": f"models/{folder}",
            "models": state["models"],
            "keywords": list(keywords),
            "fallback": state["value"],
            "filename": default,
            "required": True,
            "description": description,
            "defaultModel": state["default_model"],
            "missingDefault": state["missing"],
        })
    # 添加通用 LoRA 条目（不做关键词过滤，让前端自行按 "ltx" 过滤并允许手动输入任意名）
    try:
        import folder_paths as _fp
        _all_loras = list(_fp.get_filename_list("loras") or [])
    except Exception:
        _all_loras = []
    # 回退：如果 folder_paths 返回的列表太少，直接扫描磁盘补充
    if len(_all_loras) < 10:
        try:
            import os as _os
            _loras_dir = _os.path.join(
                str(getattr(_fp, "models_dir", "") or "models"),
                "loras",
            )
            if not _os.path.isabs(_loras_dir):
                _loras_dir = _os.path.join(os.getcwd(), "models", "loras")
            if _os.path.isdir(_loras_dir):
                _scanned = []
                for _root, _dirs, _files in _os.walk(_loras_dir):
                    for _f in _files:
                        if _f.endswith((".safetensors", ".gguf", ".pt", ".bin")):
                            _rel = _os.path.relpath(_os.path.join(_root, _f), _loras_dir).replace("\\", "/")
                            _scanned.append(_rel)
                if _scanned:
                    _existing = set(_all_loras)
                    for _item in _scanned:
                        if _item not in _existing:
                            _all_loras.append(_item)
                    print(f"[GJJ LTX2.5] LoRA 列表已从磁盘补充：{len(_all_loras)} 个文件", flush=True)
        except Exception:
            pass
    fields.append({
        "name": "ltx_general_loras",
        "label": "通用 LoRA",
        "folder": "loras",
        "path": "models/loras",
        "models": _all_loras,
        "keywords": [],
        "fallback": "",
        "filename": "",
        "required": False,
        "description": "通用 LoRA 列表；前端仅展示名称包含 ltx 的条目，未列出的文件可手动输入完整相对路径。",
        "defaultModel": "",
        "missingDefault": False,
    })
    return fields


def _defaults() -> dict[str, str]:
    result = {field["name"]: str(field["fallback"]) for field in _model_fields()}
    result.setdefault("msr_lora_name", "LTX/LTX-2.3-Licon-MSR-V2.safetensors")
    result.setdefault("msr_lora_strength", "1.0")
    return result


def _resolve_size_config(config: dict[str, Any], scenes: list[Any]) -> dict[str, Any]:
    resolved = dict(config)
    source = str(resolved.get("size_source") or "画板尺寸")
    if source == "首图尺寸" and scenes and hasattr(scenes[0], "shape"):
        resolved["width"] = int(scenes[0].shape[2])
        resolved["height"] = int(scenes[0].shape[1])
        resolved["size_source"] = "原视频尺寸"
    elif source == "视频尺寸":
        resolved["size_source"] = "原视频尺寸"
    else:
        resolved["size_source"] = "面板尺寸"
        if str(resolved.get("size_mode") or "宽高") == "百万像素":
            ratio = str(resolved.get("megapixel_aspect") or "16:9")
            try:
                rw, rh = (max(1.0, float(item)) for item in ratio.split(":", 1))
            except Exception:
                rw, rh = 16.0, 9.0
            pixels = max(0.2, min(2.0, float(resolved.get("megapixels") or 0.4))) * 1024.0 * 1024.0
            resolved["width"] = max(64, int(round((pixels * rw / rh) ** 0.5 / 32.0)) * 32)
            resolved["height"] = max(64, int(round((pixels * rh / rw) ** 0.5 / 32.0)) * 32)
    return resolved


def _zero_conditioning(positive):
    nodes = importlib.import_module("nodes")
    zero = getattr(nodes, "ConditioningZeroOut")()
    return zero.zero_out(positive)[0]


def _sample(rt, model, positive, negative, video_latent, audio_latent, seed, sampler_name, sigmas, dual_cfg=False, denoised_output=False):
    av_latent = rt.LTXVConcatAVLatent.execute(video_latent, audio_latent)[0]
    if dual_cfg:
        nodes_lt = importlib.import_module("comfy_extras.nodes_lt")
        dual = getattr(nodes_lt, "LTXVDualCFGGuider")
        guider = dual.execute(model, positive, negative, 1.0, 1.0)[0]
    else:
        guider = rt.CFGGuider.execute(model, positive, negative, 1.0)[0]
    if dual_cfg and sampler_name == "euler_ancestral":
        custom_sampler = importlib.import_module("comfy_extras.nodes_custom_sampler")
        sampler = custom_sampler.SamplerEulerAncestral.execute(0.0, 1.0)[0]
    else:
        sampler = rt.KSamplerSelect.execute(sampler_name)[0]
    sigma_values = rt.ManualSigmas.execute(sigmas)[0]
    noise = rt.RandomNoise.execute(int(seed))[0]
    sample_outputs = rt.SamplerCustomAdvanced.execute(noise, guider, sampler, sigma_values, av_latent)
    sampled = sample_outputs[1] if denoised_output else sample_outputs[0]
    return rt.LTXVSeparateAVLatent.execute(sampled)[0:2]


def _apply_character_reference_branch(
    positive,
    negative,
    video_vae,
    video_latent,
    character_reference,
    background,
    rt,
):
    """Follow LTX2.3_MSR多图参考.json's character-reference branch literally."""
    references = [item for item in list(character_reference or []) if item is not None]
    if not references:
        return positive, negative, video_latent
    from .gjj_add_video_iclora_guide import GJJ_AddVideoICLoRAGuide
    from .gjj_batch_crop_resize import GJJ_BatchCropResize

    reference_batch = rt.torch.cat([rt._ensure_image_batch(item) for item in references], dim=0).contiguous()
    samples = video_latent["samples"]
    scale_factors = video_vae.downscale_index_formula
    target_width = int(samples.shape[-1] * scale_factors[1])
    target_height = int(samples.shape[-2] * scale_factors[2])
    processed = GJJ_BatchCropResize().crop_resize(
        align_multiple=16,
        width=target_width,
        height=target_height,
        media_01=reference_batch,
        media_02=background,
    )
    reference_images = processed[2]
    background_image = processed[3] if background is not None and len(processed) > 3 else None
    frame_count = rt._msr_guide_frame_count_for_latent(video_latent, video_vae, preferred=41)
    return GJJ_AddVideoICLoRAGuide().generate(
        positive=positive,
        negative=negative,
        vae=video_vae,
        latent=video_latent,
        image=reference_images,
        background=background_image,
        frame_idx=0,
        strength=1.0,
        latent_downscale_factor=1.0,
        crop="disabled",
        use_tiled_encode=False,
        tile_size=256,
        tile_overlap=64,
        bypass=False,
        frame_count=str(frame_count),
        guide_mode="写入Latent",
    )


def _apply_msr_guide(
    positive,
    negative,
    video_vae,
    video_latent,
    character_reference,
    scene_images,
    rt,
):
    """严格对齐 LTX2.5_MSR多图参考1.json 工作流拓扑。

    工作流映射（关键：人物参考是 image/引导帧，场景是 background）：
      GJJ_MultiImageLoader(人物参考) → BatchCropResize media_01 → result_01 → image(引导帧)
      GJJ_TemplateParams(场景)       → BatchCropResize media_02 → result_02 → background

    MSR LoRA 训练使得模型将 guide 帧作为身份参考令牌，而非画面主体内容。
    guide_mode="写入Latent" 将引导帧编码写入视频 Latent 前部，
    采样后由 LTXVCropGuides 裁掉引导帧区域，只保留生成内容。
    """
    from .gjj_add_video_iclora_guide import GJJ_AddVideoICLoRAGuide
    from .gjj_batch_crop_resize import GJJ_BatchCropResize

    character_items = [item for item in list(character_reference or []) if item is not None]
    scene_items = [item for item in list(scene_images or []) if item is not None]
    if not character_items and not scene_items:
        return positive, negative, video_latent

    samples = video_latent["samples"]
    scale_factors = video_vae.downscale_index_formula
    target_width = int(samples.shape[-1] * scale_factors[1])
    target_height = int(samples.shape[-2] * scale_factors[2])

    # 对齐工作流：media_01=人物参考, media_02=场景
    character_batch = None
    scene_batch = None
    if character_items:
        character_batch = rt.torch.cat([rt._ensure_image_batch(item) for item in character_items], dim=0).contiguous()
    if scene_items:
        scene_batch = rt.torch.cat([rt._ensure_image_batch(item) for item in scene_items], dim=0).contiguous()

    processed = GJJ_BatchCropResize().crop_resize(
        align_multiple=16,
        width=target_width,
        height=target_height,
        media_01=character_batch,
        media_02=scene_batch,
    )
    # result_01 (index 2) → image (人物参考引导帧)
    # result_02 (index 3) → background (场景)
    guide_image = processed[2] if character_batch is not None else None
    guide_background = processed[3] if scene_batch is not None and len(processed) > 3 else None

    # 工作流 widget_values 固定 frame_count=41，对齐 MSR LoRA 训练预期
    return GJJ_AddVideoICLoRAGuide().generate(
        positive=positive,
        negative=negative,
        vae=video_vae,
        latent=video_latent,
        image=guide_image,
        background=guide_background,
        frame_idx=0,
        strength=1.0,
        latent_downscale_factor=1.0,
        crop="disabled",
        use_tiled_encode=False,
        tile_size=256,
        tile_overlap=64,
        bypass=False,
        frame_count="41",
        guide_mode="写入Latent",
    )


def _run_source_workflow(*, config: dict[str, Any], scenes: list[Any], character_reference=None, unique_id: Any = None):
    """Execute the supplied LTX2.5 T2V or FLF2V graph literally.

    I2V deliberately stays on its already-working path. This function contains no
    LTX2.3 route, NAG, transition LoRA, guide synthesis, or second FLF sampling pass.
    """
    rt = importlib.import_module(".gjj_ltx23_multiref_runtime", __package__)
    loader = importlib.import_module(".gjj_video_universal_model_loader", __package__)
    rt._ensure_runtime_dependencies()

    model = loader._load_unet_model(str(config["ltx_model_name"]), "fp16", unique_id=unique_id)
    clip = loader._load_clip(str(config["ltx_text_encoder_name"]), "ltxv", "bf16")
    video_vae = loader._load_gjj_vae(str(config["ltx_video_vae_name"]), "main_device", "bf16")
    audio_vae = loader._load_gjj_vae(str(config["ltx_audio_vae_name"]), "main_device", "bf16")

    fps = max(1, int(round(float(config["fps"]))))
    duration = max(0.1, float(config["segment_seconds"]))
    output_width = max(64, int(config["width"]))
    output_height = max(64, int(config["height"]))
    if len(scenes) == 2:
        # FLF source: x1 * x2 + 1; latent width/height come from the resized first image.
        frame_count = max(2, int(fps * duration) + 1)
        sample_width = max(64, int(round(output_width / 32.0)) * 32)
        sample_height = max(64, int(round(output_height / 32.0)) * 32)
    else:
        # T2V source: int((duration * fps // 4) * 4 + 1), width/height are halved.
        frame_count = max(5, int((duration * fps // 4) * 4 + 1))
        sample_width, sample_height = rt._resolve_stage1_sample_size(output_width, output_height, None)

    positive_raw = rt.CLIPTextEncode().encode(clip, str(config["positive_prompt"]))[0]
    negative_raw = _zero_conditioning(positive_raw)
    positive, negative = rt.LTXVConditioning.execute(positive_raw, negative_raw, float(fps))[0:2]
    video_latent = rt.EmptyLTXVLatentVideo.execute(sample_width, sample_height, frame_count, 1)[0]
    audio_latent = rt.LTXVEmptyLatentAudio.execute(frame_count, fps, 1, audio_vae)[0]
    positive, negative, video_latent = _apply_character_reference_branch(
        positive,
        negative,
        video_vae,
        video_latent,
        character_reference,
        scenes[0] if scenes else None,
        rt,
    )
    seed = int(config["seed"])

    if len(scenes) == 2:
        # Exact FLF2V graph: Preprocess(18) -> AddGuide(frame 0, .7) ->
        # AddGuide(frame -1, .7) -> one ancestral sample -> CropGuides -> decode.
        def resize_source(image):
            from .gjj_minimax_h3_studio import _resize_visual
            resized = _resize_visual(
                rt._ensure_image_batch(image)[:1],
                sample_width,
                sample_height,
                str(config.get("resize_fit_mode") or "裁剪"),
                str(config.get("resize_anchor") or "上"),
            )
            return rt._ltx_preprocess_image(resized.contiguous(), 18)

        first = resize_source(scenes[0])
        last = resize_source(scenes[1])
        positive, negative, video_latent = rt.LTXVAddGuide.execute(
            positive, negative, video_vae, video_latent, first, 0, 0.7
        )[0:3]
        positive, negative, video_latent = rt.LTXVAddGuide.execute(
            positive, negative, video_vae, video_latent, last, -1, 0.7
        )[0:3]
        video_result, audio_result = _sample(
            rt, model, positive, negative, video_latent, audio_latent, seed,
            "euler_ancestral",
            "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
            dual_cfg=True,
            denoised_output=True,
        )
        _, _, video_result = rt.LTXVCropGuides.execute(positive, negative, video_result)[0:3]
        temporal_overlap = 64
    else:
        # Exact T2V graph: empty AV latent -> ancestral first pass -> separate ->
        # spatial latent upsample -> cfg++ short second pass -> decode.
        video_stage1, audio_stage1 = _sample(
            rt, model, positive, negative, video_latent, audio_latent, seed,
            "euler_ancestral",
            "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
        )
        upscale_name = str(config["ltx_latent_upscaler_name"])
        upscale_model = rt.LatentUpscaleModelLoader.execute(upscale_name)[0]
        video_upscaled = rt.LTXVLatentUpsampler().upsample_latent(video_stage1, upscale_model, video_vae)[0]
        video_result, audio_result = _sample(
            rt, model, positive, negative, video_upscaled, audio_stage1, seed,
            "euler_cfg_pp", "0.85, 0.7250, 0.4219, 0.0",
        )
        temporal_overlap = 32

    frames = rt.VAEDecodeTiled().decode(video_vae, video_result, 768, 64, 4096, temporal_overlap)[0]
    try:
        audio = rt.LTXVAudioVAEDecode.execute(audio_result, audio_vae)[0]
    except Exception:
        audio = None
    video = rt._create_video(frames, float(fps), audio)
    preview = rt._save_final_video_preview(
        frames=frames,
        audio=audio,
        fps=float(fps),
        save_preset=config.get("segment_save_preset") or "video/GJJ_LTX多图分段",
        format_name=config.get("segment_video_format") or "video/h264-mp4",
        unique_id=unique_id,
        output_width=int(frames.shape[2]),
        output_height=int(frames.shape[1]),
        model_name=config.get("ltx_model_name") or "",
    )
    return {
        "ui": {
            "preview_main_path": (preview.get("path") or "",),
            "preview_media": (preview.get("media") or {},),
            "preview_is_video": (True,),
            "final_video": (preview,),
        },
        "result": (video, frames),
    }


def _build_lora_chain_config_from_name(lora_name: str, strength: float = 1.0) -> str:
    """从单个 LoRA 文件名构建 LoRA 串联配置 JSON。"""
    name = str(lora_name or "").strip()
    if not name:
        return ""
    import json as _json
    return _json.dumps([{
        "enabled": True,
        "name": name,
        "strength": float(strength),
    }], ensure_ascii=False)


def _run_msr_workflow(*, config: dict[str, Any], scenes: list[Any], character_reference, lora_chain_config: Any = "", msr_lora_name: str = "", msr_lora_strength: float = 1.0, unique_id: Any = None):
    """当【人物参考】有链接时，按 LTX2.5_MSR多图参考.json 字面执行。

    单阶段 euler 采样（sigmas 1.0→0）→ LTXVSeparateAVLatent → LTXVCropGuides →
    VAEDecode → 音频解码 → 合成。不做二阶段 latent 放大，也不走 FLF ancestral。
    支持两种 LoRA 传入方式：
      1. lora_chain_config：外部 GJJ_LoraChainConfig 节点输出的 JSON 配置
      2. msr_lora_name：直接指定 LoRA 文件名，自动构建串联配置
      优先使用 lora_chain_config；为空时回退到 msr_lora_name。
    """
    rt = importlib.import_module(".gjj_ltx23_multiref_runtime", __package__)
    loader = importlib.import_module(".gjj_video_universal_model_loader", __package__)
    rt._ensure_runtime_dependencies()

    model = loader._load_unet_model(str(config["ltx_model_name"]), "fp16", unique_id=unique_id)
    clip = loader._load_clip(str(config["ltx_text_encoder_name"]), "ltxv", "bf16")

    # 合并 LoRA 配置：优先 lora_chain_config，其次 msr_lora_name 直接指定
    effective_lora_config = str(lora_chain_config or "").strip()
    if not effective_lora_config:
        effective_lora_config = _build_lora_chain_config_from_name(
            str(msr_lora_name or ""),
            float(msr_lora_strength),
        )
    if effective_lora_config:
        print(f"[GJJ LTX2.5 MSR] 加载 LoRA 配置: {effective_lora_config}", flush=True)
        model, clip = rt._apply_chain_loras(model, clip, effective_lora_config)
    else:
        print("[GJJ LTX2.5 MSR] ⚠️ 未加载任何 MSR LoRA！人物参考可能作为画面主体出现，请检查 msr_lora_name 或 lora_chain_config 是否配置。", flush=True)

    video_vae = loader._load_gjj_vae(str(config["ltx_video_vae_name"]), "main_device", "bf16")
    audio_vae = loader._load_gjj_vae(str(config["ltx_audio_vae_name"]), "main_device", "bf16")

    fps = max(1, int(round(float(config["fps"]))))
    duration = max(0.1, float(config["segment_seconds"]))
    output_width = max(64, int(config["width"]))
    output_height = max(64, int(config["height"]))
    # MSR 帧数公式严格对齐 LTX2.5_MSR多图参考1.json 的 GJJ_MultifunctionCalculator：
    #   widget formula = "int(x1 *x2 )+1"，x1=帧率，x2=时长 → int(fps*duration)+1
    frame_count = max(9, int(fps * duration) + 1)
    # 单阶段全分辨率采样，latent 像素尺寸按 32 对齐。
    sample_width = max(64, int(round(output_width / 32.0)) * 32)
    sample_height = max(64, int(round(output_height / 32.0)) * 32)

    positive_raw = rt.CLIPTextEncode().encode(clip, str(config["positive_prompt"]))[0]
    negative_raw = _zero_conditioning(positive_raw)
    positive, negative = rt.LTXVConditioning.execute(positive_raw, negative_raw, float(fps))[0:2]
    video_latent = rt.EmptyLTXVLatentVideo.execute(sample_width, sample_height, frame_count, 1)[0]
    audio_latent = rt.LTXVEmptyLatentAudio.execute(frame_count, fps, 1, audio_vae)[0]
    print(f"[GJJ LTX2.5 MSR] fps={fps} duration={duration}s frame_count={frame_count} sample={sample_width}x{sample_height}", flush=True)
    # 严格对齐 LTX2.5_MSR多图参考1.json 工作流：
    # 人物参考 → BatchCropResize media_01 → result_01 → image(引导帧)
    # 场景图   → BatchCropResize media_02 → result_02 → background
    # 两者经 GJJ_AddVideoICLoRAGuide 写入 Latent，MSR LoRA 使模型将其作为身份参考。
    print(f"[GJJ LTX2.5 MSR] character_reference={len(list(character_reference or []))}张 scenes={len(list(scenes or []))}张", flush=True)
    positive, negative, video_latent = _apply_msr_guide(
        positive, negative, video_vae, video_latent,
        character_reference, scenes, rt,
    )
    seed = int(config["seed"])

    # 单阶段 euler 采样，sigmas 与 LTX2.5_MSR多图参考.json 的 GJJ_LTXVVideoSampler 一致。
    video_result, audio_result = _sample(
        rt, model, positive, negative, video_latent, audio_latent, seed,
        "euler",
        "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
    )
    # LTXVCropGuides 去掉 guide 引导帧区域，对齐源工作流。
    _, _, video_result = rt.LTXVCropGuides.execute(positive, negative, video_result)[0:3]

    frames = rt.VAEDecodeTiled().decode(video_vae, video_result, 768, 64, 4096, 64)[0]
    try:
        audio = rt.LTXVAudioVAEDecode.execute(audio_result, audio_vae)[0]
    except Exception:
        audio = None
    video = rt._create_video(frames, float(fps), audio)
    preview = rt._save_final_video_preview(
        frames=frames,
        audio=audio,
        fps=float(fps),
        save_preset=config.get("segment_save_preset") or "video/GJJ_LTX多图分段",
        format_name=config.get("segment_video_format") or "video/h264-mp4",
        unique_id=unique_id,
        output_width=int(frames.shape[2]),
        output_height=int(frames.shape[1]),
        model_name=config.get("ltx_model_name") or "",
    )
    return {
        "ui": {
            "preview_main_path": (preview.get("path") or "",),
            "preview_media": (preview.get("media") or {},),
            "preview_is_video": (True,),
            "final_video": (preview,),
        },
        "result": (video, frames),
    }


class GJJ_LTX25ImageToVideoMultiRef(ltx23.GJJ_LTX23ImageToVideoMultiRef):
    DESCRIPTION = "LTX-2.5 多功能视频生成器：交互、输入输出与 LTX2.3 MultiRef 版一致；模型链全部切换为 LTX2.5。"
    SEARCH_ALIASES = ["ltx2.5", "ltx25", "LTX 2.5 图生视频", "LTX 2.5 文生视频", "LTX 2.5 首尾帧", "LTX 2.5 多图参考"]
    GJJ_HELP = {
        "models": [
            {"label": field["label"], "value": f"📁{field['path']}/{field['filename']}", "tooltip": field["description"]}
            for field in _model_fields()
        ],
        "dependencies": ["torch（深度学习框架）", "numpy（数值计算）"],
    }

    @classmethod
    def INPUT_TYPES(cls):
        result = super().INPUT_TYPES()
        main = _state(("ltx", "2.5", "22b"), ("diffusion_models", "unet_gguf"), DEFAULT_MODEL)
        result["required"]["ltx_model_name"] = (
            main["models"] or [DEFAULT_MODEL],
            {
                "default": main["value"],
                "display_name": "🧠 LTX2.5主模型",
                "tooltip": "models/diffusion_models；按 LTX 2.5 模型族自动过滤。",
            },
        )
        return result

    @classmethod
    def IS_CHANGED(cls, seed=None, config_json="{}", unique_id=None, **_kwargs):
        raw = ltx23._unwrap_single_value(config_json)
        try:
            config = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
        except Exception:
            config = {}
        mode = str(config.get("seed_mode") or "固定")
        if mode != "固定":
            # Non-fixed modes must never reuse ComfyUI's cached output.
            return float("nan")
        return int(ltx23._unwrap_single_value(seed) or config.get("seed") or 0)

    def generate(
        self,
        ltx_model_name=None,
        positive_prompt=None,
        negative_prompt=None,
        segment_seconds=None,
        width=None,
        height=None,
        fps=None,
        seed=None,
        denoise_strength=None,
        image_sequence=None,
        config_json="{}",
        extra_pnginfo=None,
        unique_id=None,
        **kwargs,
    ):
        raw = ltx23._unwrap_single_value(config_json)
        try:
            config = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
        except Exception:
            config = {}
        for key, value in _defaults().items():
            if not str(config.get(key) or "").strip() or "2.3" in str(config.get(key)) or "LTX23" in str(config.get(key)):
                config[key] = value
        # LTX2.5 的 Gemma4 文件自带 Projection，不再沿用 2.3 的独立 connector。
        config["ltx_text_projection_name"] = ""
        config["transition_lora_name"] = ""
        config["transition_lora_enabled"] = False
        config["test_lora_name"] = ""
        config["test_lora_enabled"] = False
        # 对齐用户提供的 LTX2.5 T2V/I2V 工作流。第一阶段负责主体构图，
        # 第二阶段只用较短 sigma 尾段做放大细化。
        config["stage1_sampler"] = "euler_ancestral"
        config["stage2_sampler"] = "euler_cfg_pp"
        config["stage1_sigmas"] = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
        config["stage2_sigmas"] = "0.85, 0.7250, 0.4219, 0.0"
        config["cfg"] = 1.0
        # 三份 LTX2.5 源工作流均未使用旧版 GJJ_LTX2NAG。沿用 2.3 的默认
        # NAG=14 会强烈改写 Gemma4 条件，表现就是画面流畅但与提示词无关。
        config["nag_scale"] = 0.0
        config["nag_alpha"] = 0.0
        config["nag_tau"] = 0.0
        explicit = ltx23._unwrap_main_params({
            "ltx_model_name": ltx_model_name,
            "positive_prompt": positive_prompt,
            "negative_prompt": negative_prompt,
            "segment_seconds": segment_seconds,
            "width": width,
            "height": height,
            "fps": fps,
            "seed": seed,
            "denoise_strength": denoise_strength,
        })
        config = ltx23._resolve_clean_config(
            config_json=ltx23._apply_external_param_overrides(config, explicit),
            extra_pnginfo=ltx23._unwrap_single_value(extra_pnginfo),
            unique_id=ltx23._unwrap_single_value(unique_id),
        )
        config.update({key: value for key, value in _defaults().items() if not str(config.get(key) or "").strip()})
        seed_mode = str(config.get("seed_mode") or "固定")
        seed_key = str(ltx23._unwrap_single_value(unique_id) or "node")
        current_seed = max(0, int(config.get("seed") or 0))
        if seed_mode == "随机":
            current_seed = secrets.randbits(63)
        elif seed_mode == "递增" and _LAST_EXECUTION_SEEDS.get(seed_key) == current_seed:
            current_seed = min(0xFFFFFFFFFFFFFFFF, current_seed + 1)
        elif seed_mode == "递减" and _LAST_EXECUTION_SEEDS.get(seed_key) == current_seed:
            current_seed = max(0, current_seed - 1)
        config["seed"] = current_seed
        _LAST_EXECUTION_SEEDS[seed_key] = current_seed

        raw_sequence = ltx23._unwrap_single_value(image_sequence if image_sequence is not None else kwargs.get("image_sequence"))
        scenes = ltx23._split_scene_batch(raw_sequence)
        scenes.extend(ltx23._flatten_scene_values([value for _, _, value in ltx23._collect_scene_items(kwargs)]))
        scenes, _ = ltx23._filter_valid_scene_images(scenes)
        scenes, _ = ltx23._dedupe_scene_images(scenes)
        config = _resolve_size_config(config, scenes)
        character_reference, _ = ltx23._filter_valid_scene_images(
            ltx23._split_scene_batch(kwargs.get("character_reference"))
        )

        # 当【人物参考】有链接且携带有效图片时，走 LTX2.5_MSR多图参考.json 分支：
        # 单阶段 euler 采样 + LTXVCropGuides，不做二阶段 latent 放大。
        if character_reference:
            return _run_msr_workflow(
                config=config,
                scenes=scenes,
                character_reference=character_reference,
                lora_chain_config=kwargs.get("lora_chain_config", ""),
                msr_lora_name=str(config.get("msr_lora_name", "") or ""),
                msr_lora_strength=float(config.get("msr_lora_strength", 1.0) or 1.0),
                unique_id=ltx23._unwrap_single_value(unique_id),
            )

        if len(scenes) in (0, 2):
            return _run_source_workflow(
                config=config,
                scenes=scenes,
                character_reference=character_reference,
                unique_id=ltx23._unwrap_single_value(unique_id),
            )

        if len(scenes) == 1 and raw_sequence is not None and config.get("size_source") == "面板尺寸":
            from .gjj_minimax_h3_studio import _resize_visual
            image_sequence = _resize_visual(
                scenes[0],
                int(config["width"]),
                int(config["height"]),
                str(config.get("resize_fit_mode") or "裁剪"),
                str(config.get("resize_anchor") or "上"),
            )

        # The supplied I2V graph is already verified working. Keep that isolated path
        # unchanged; multi-image segmentation continues to pair adjacent frames there.
        return super().generate(
            ltx_model_name=ltx_model_name,
            positive_prompt=positive_prompt,
            negative_prompt=negative_prompt,
            segment_seconds=segment_seconds,
            width=config["width"],
            height=config["height"],
            fps=fps,
            seed=seed,
            denoise_strength=denoise_strength,
            image_sequence=image_sequence,
            config_json=json.dumps(config, ensure_ascii=False),
            extra_pnginfo=extra_pnginfo,
            unique_id=unique_id,
            **kwargs,
        )


async def _models_endpoint(_request):
    fields = _model_fields()
    main = fields[0]
    return web.json_response({
        "models": main["models"],
        "default": main["fallback"],
        "missing": main["missingDefault"],
        "fields": fields,
    })


def _register_api() -> None:
    try:
        from server import PromptServer
        server = PromptServer.instance
        if server is None or getattr(server, "_gjj_ltx25_multiref_api_registered", False):
            return
        server.routes.get("/gjj/ltx25/models")(_models_endpoint)
        server._gjj_ltx25_multiref_api_registered = True
    except Exception:
        return


_register_api()

NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTX25ImageToVideoMultiRef}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·🎬多功能视频生成器(LTX2.5) 🧡"}
