from __future__ import annotations

import base64
import io as _io
import json
import logging
import math
import os
import types
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import folder_paths
import comfy.ldm.modules.attention
import comfy.model_management
import comfy.utils


log = logging.getLogger(__name__)

GUIDE_DATA_TYPE = "GUIDE_DATA"


def _conditioning_set_values(conditioning, values: dict[str, Any]):
    out = []
    for item in conditioning:
        if len(item) == 2:
            cond, pooled = item
            data = dict(pooled)
            data.update(values)
            out.append([cond, data])
        else:
            out.append(item)
    return out


def _build_temporal_cost(q_token_idx, lq, lk, device, dtype, tokens_per_frame):
    offset = torch.zeros(lq, lk, device=device, dtype=dtype)
    query_frames = torch.arange(lq, device=device, dtype=torch.long) // tokens_per_frame
    for seg in q_token_idx:
        local = seg["local_token_idx"].to(device=device)
        dist = (query_frames.float()[:, None] - seg["midpoint"]).abs()
        cost = seg.get("strength", 1.0) * (torch.relu(dist - seg["window"]) ** 2) / (2 * seg["sigma"] ** 2)
        offset[:, local] = cost.to(offset.dtype)
    return offset


def _build_temporal_cost_scaled(q_token_idx, lq, lk, device, dtype, latent_frames):
    offset = torch.zeros(lq, lk, device=device, dtype=dtype)
    query_frames = torch.arange(lq, device=device, dtype=torch.float32) * latent_frames / lq
    for seg in q_token_idx:
        local = seg["local_token_idx"].to(device=device)
        dist = (query_frames[:, None] - seg["midpoint"]).abs()
        sigma = seg.get("sigma_audio", seg["sigma"])
        window = seg.get("window_audio", seg["window"])
        strength = seg.get("strength_audio", 1.0)
        cost = strength * (torch.relu(dist - window) ** 2) / (2 * sigma ** 2)
        offset[:, local] = cost.to(offset.dtype)
    return offset


def _create_mask_fn(q_token_idx, fallback_tokens_per_frame, latent_frames):
    cache = {}
    max_token_idx = max(int(seg["local_token_idx"].max().item()) for seg in q_token_idx) + 1

    def mask_fn(q, k, transformer_options):
        lq, lk = q.shape[1], k.shape[1]
        if lq == lk:
            return None

        cond_or_uncond = transformer_options.get("cond_or_uncond", [])
        if 1 in cond_or_uncond and 0 not in cond_or_uncond:
            return None

        grid_sizes = transformer_options.get("grid_sizes", None)
        video_tpf = int(grid_sizes[1]) * int(grid_sizes[2]) if grid_sizes is not None else fallback_tokens_per_frame
        video_lq = latent_frames * video_tpf
        if lk == video_lq or lk < max_token_idx:
            return None

        mode = "video" if lq == video_lq else "scaled"
        key = (lq, lk, mode, q.device)
        if key not in cache:
            if mode == "video":
                cost = _build_temporal_cost(q_token_idx, lq, lk, q.device, q.dtype, video_tpf)
            else:
                cost = _build_temporal_cost_scaled(q_token_idx, lq, lk, q.device, q.dtype, latent_frames)
            cache[key] = -cost
        return cache[key].to(q.dtype)

    return mask_fn


def _build_segments(token_ranges, segment_lengths, epsilon=1e-3):
    sigma = 1.0 / math.log(1.0 / epsilon) if 0 < epsilon < 1 else 0.1448
    q_token_idx = []
    frame_cursor = 0
    for (tok_start, tok_end), length in zip(token_ranges, segment_lengths):
        if length <= 0:
            frame_cursor += length
            continue
        midpoint = (2 * frame_cursor + length) // 2
        window = max(length // 2 - 2, 0)
        q_token_idx.append(
            {
                "local_token_idx": torch.arange(tok_start, tok_end),
                "midpoint": midpoint,
                "window": window,
                "sigma": sigma,
                "strength": 1.0,
                "window_audio": window,
                "sigma_audio": sigma,
                "strength_audio": 1.0,
            }
        )
        frame_cursor += length
    return q_token_idx


def _get_raw_tokenizer(clip):
    tokenizer_wrapper = clip.tokenizer
    for attr_name in dir(tokenizer_wrapper):
        if attr_name.startswith("_"):
            continue
        inner = getattr(tokenizer_wrapper, attr_name, None)
        if inner is not None and hasattr(inner, "tokenizer"):
            return inner.tokenizer
    raise RuntimeError("无法在 CLIP 对象中找到原始 tokenizer，不能构建 LTX Director 分段提示词。")


def _map_token_indices(raw_tokenizer, global_prompt, local_prompts):
    prefixed_locals = [" " + lp for lp in local_prompts]
    full_prompt = global_prompt + "".join(prefixed_locals)
    has_eos = getattr(raw_tokenizer, "add_eos", False)
    eos_adj = 1 if has_eos else 0
    prev_len = len(raw_tokenizer(global_prompt)["input_ids"]) - eos_adj
    token_ranges = []
    built = global_prompt
    for prompt in prefixed_locals:
        built += prompt
        cur_len = len(raw_tokenizer(built)["input_ids"]) - eos_adj
        if cur_len <= prev_len:
            raise ValueError(f"局部提示词没有产生 token：{prompt.strip()}")
        token_ranges.append((prev_len, cur_len))
        prev_len = cur_len
    return full_prompt, token_ranges


def _distribute_segment_lengths(num_segments, latent_frames, specified_lengths=None):
    if specified_lengths:
        if len(specified_lengths) != num_segments:
            raise ValueError(f"时间线片段长度数量（{len(specified_lengths)}）与局部提示词数量（{num_segments}）不一致。")
        lengths = specified_lengths
    else:
        step = -(-latent_frames // num_segments)
        lengths = [step] * num_segments

    effective = []
    cursor = 0
    for length in lengths:
        end = min(cursor + length, latent_frames)
        effective.append(max(end - cursor, 0))
        cursor = end
    return effective


def _masked_attention(q, k, v, heads, mask, transformer_options=None, **kwargs):
    return comfy.ldm.modules.attention.attention_pytorch(
        q,
        k,
        v,
        heads,
        mask=mask,
        _inside_attn_wrapper=True,
        transformer_options=transformer_options or {},
        **kwargs,
    )


def _wan_t2v_forward(self, mask_fn, x, context, transformer_options=None, **kwargs):
    transformer_options = transformer_options or {}
    q = self.norm_q(self.q(x))
    k = self.norm_k(self.k(context))
    v = self.v(context)
    mask = mask_fn(q, k, transformer_options)
    if mask is not None:
        x = _masked_attention(q, k, v, heads=self.num_heads, mask=mask, transformer_options=transformer_options)
    else:
        x = comfy.ldm.modules.attention.optimized_attention(q, k, v, heads=self.num_heads, transformer_options=transformer_options)
    return self.o(x)


def _wan_i2v_forward(self, mask_fn, x, context, context_img_len, transformer_options=None, **kwargs):
    transformer_options = transformer_options or {}
    context_img = context[:, :context_img_len]
    context_text = context[:, context_img_len:]
    q = self.norm_q(self.q(x))
    k_img = self.norm_k_img(self.k_img(context_img))
    v_img = self.v_img(context_img)
    img_x = comfy.ldm.modules.attention.optimized_attention(q, k_img, v_img, heads=self.num_heads, transformer_options=transformer_options)
    k = self.norm_k(self.k(context_text))
    v = self.v(context_text)
    mask = mask_fn(q, k, transformer_options)
    if mask is not None:
        x = _masked_attention(q, k, v, heads=self.num_heads, mask=mask, transformer_options=transformer_options)
    else:
        x = comfy.ldm.modules.attention.optimized_attention(q, k, v, heads=self.num_heads, transformer_options=transformer_options)
    return self.o(x + img_x)


def _ltx_forward(self, mask_fn, x, context=None, mask=None, pe=None, k_pe=None, transformer_options=None):
    from comfy.ldm.lightricks.model import apply_rotary_emb

    transformer_options = transformer_options or {}
    is_self_attn = context is None
    context = x if is_self_attn else context
    q = self.q_norm(self.to_q(x))
    k = self.k_norm(self.to_k(context))
    v = self.to_v(context)
    if pe is not None:
        q = apply_rotary_emb(q, pe)
        k = apply_rotary_emb(k, pe if k_pe is None else k_pe)
    if not is_self_attn:
        temporal_mask = mask_fn(q, k, transformer_options)
        if temporal_mask is not None:
            mask = temporal_mask if mask is None else mask + temporal_mask
    if mask is None:
        out = comfy.ldm.modules.attention.optimized_attention(
            q, k, v, self.heads, attn_precision=self.attn_precision, transformer_options=transformer_options
        )
    else:
        out = _masked_attention(q, k, v, self.heads, mask=mask, attn_precision=self.attn_precision, transformer_options=transformer_options)
    if self.to_gate_logits is not None:
        gate_logits = self.to_gate_logits(x)
        batch, tokens, _ = out.shape
        out = out.view(batch, tokens, self.heads, self.dim_head)
        out = out * (2.0 * torch.sigmoid(gate_logits)).unsqueeze(-1)
        out = out.view(batch, tokens, self.heads * self.dim_head)
    return self.to_out(out)


class _CrossAttnPatch:
    def __init__(self, impl, mask_fn):
        self.impl = impl
        self.mask_fn = mask_fn

    def __get__(self, obj, objtype=None):
        impl, mask_fn = self.impl, self.mask_fn

        def wrapped(self_module, *args, **kwargs):
            return impl(self_module, mask_fn, *args, **kwargs)

        return types.MethodType(wrapped, obj)


def _detect_model_type(model):
    diff_model = model.model.diffusion_model
    if hasattr(diff_model, "patch_size") and not hasattr(diff_model, "patchifier"):
        return "wan", tuple(diff_model.patch_size), 4
    if hasattr(diff_model, "patchifier"):
        return "ltx", (1, 1, 1), int(diff_model.vae_scale_factors[0])
    raise ValueError(f"不支持的模型类型：{type(diff_model).__name__}。当前仅支持 Wan 与 LTX。")


def _check_unpatched(model_clone, key):
    if key in getattr(model_clone, "object_patches", {}):
        raise RuntimeError(f"LTX Director 的注意力补丁位置已被其它节点占用：{key}。请移除冲突节点后再试。")


def _apply_patches(model_clone, arch, mask_fn):
    diffusion_model = model_clone.get_model_object("diffusion_model")
    if arch == "wan":
        from comfy.ldm.wan.model import WanI2VCrossAttention

        for idx, block in enumerate(diffusion_model.blocks):
            key = f"diffusion_model.blocks.{idx}.cross_attn.forward"
            _check_unpatched(model_clone, key)
            cross_attn = block.cross_attn
            impl = _wan_i2v_forward if isinstance(cross_attn, WanI2VCrossAttention) else _wan_t2v_forward
            model_clone.add_object_patch(key, _CrossAttnPatch(impl, mask_fn).__get__(cross_attn, cross_attn.__class__))
        return
    if arch == "ltx":
        for idx, block in enumerate(diffusion_model.transformer_blocks):
            for attr in ("attn2", "audio_attn2"):
                module = getattr(block, attr, None)
                if module is None:
                    continue
                key = f"diffusion_model.transformer_blocks.{idx}.{attr}.forward"
                _check_unpatched(model_clone, key)
                model_clone.add_object_patch(key, _CrossAttnPatch(_ltx_forward, mask_fn).__get__(module, module.__class__))
        return
    raise ValueError(f"未知模型架构：{arch}")


def _load_image_tensor(seg: dict) -> torch.Tensor:
    if seg.get("imageFile"):
        file_path = os.path.join(folder_paths.get_input_directory(), seg["imageFile"])
        if os.path.exists(file_path):
            img = Image.open(file_path).convert("RGB")
            arr = np.array(img, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)

    b64_str = seg.get("imageB64", "")
    if not b64_str or b64_str.startswith("/view?"):
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]
    try:
        img_bytes = base64.b64decode(b64_str)
        img = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        arr = np.array(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)
    except Exception:
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)


def _resize_image(tensor: torch.Tensor, target_w: int, target_h: int, method: str, divisible_by: int) -> torch.Tensor:
    def snap(val, div):
        return max(div, (int(val) // div) * div)

    tw = snap(target_w, divisible_by)
    th = snap(target_h, divisible_by)
    img_np = (tensor[0].cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    pil = Image.fromarray(img_np)
    src_w, src_h = pil.size

    if method == "stretch to fit":
        resized = pil.resize((tw, th), Image.LANCZOS)
    elif method == "pad":
        ratio = min(tw / src_w, th / src_h)
        new_w = snap(src_w * ratio, divisible_by)
        new_h = snap(src_h * ratio, divisible_by)
        inner = pil.resize((new_w, new_h), Image.LANCZOS)
        resized = Image.new("RGB", (tw, th), (0, 0, 0))
        resized.paste(inner, ((tw - new_w) // 2, (th - new_h) // 2))
    elif method == "crop":
        ratio = max(tw / src_w, th / src_h)
        new_w = int(src_w * ratio)
        new_h = int(src_h * ratio)
        inner = pil.resize((new_w, new_h), Image.LANCZOS)
        left = (new_w - tw) // 2
        top = (new_h - th) // 2
        resized = inner.crop((left, top, left + tw, top + th))
    elif method == "maintain aspect ratio":
        ratio = min(tw / src_w, th / src_h)
        new_w = snap(src_w * ratio, divisible_by)
        new_h = snap(src_h * ratio, divisible_by)
        resized = pil.resize((new_w, new_h), Image.LANCZOS)
    else:
        resized = pil.resize((tw, th), Image.LANCZOS)

    arr = np.array(resized, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _compress_image(tensor: torch.Tensor, crf: int) -> torch.Tensor:
    if crf <= 0:
        return tensor
    try:
        import av
    except Exception:
        log.warning("[GJJ LTX Director] 当前环境缺少 PyAV，已跳过 guide 图像压缩。")
        return tensor

    img = tensor[0]
    height = (img.shape[0] // 2) * 2
    width = (img.shape[1] // 2) * 2
    img_np = (img[:height, :width] * 255.0).byte().cpu().numpy()
    try:
        buf = _io.BytesIO()
        container = av.open(buf, mode="w", format="mp4")
        stream = container.add_stream("libx264", rate=1)
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": str(crf), "preset": "ultrafast"}
        frame = av.VideoFrame.from_ndarray(img_np, format="rgb24")
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
        container.close()

        buf.seek(0)
        container_r = av.open(buf, mode="r")
        decoded = None
        for frame_r in container_r.decode(video=0):
            decoded = frame_r.to_ndarray(format="rgb24")
            break
        container_r.close()
        if decoded is None:
            return tensor
        arr = torch.from_numpy(decoded.astype(np.float32) / 255.0).to(tensor.device, tensor.dtype)
        out = tensor.clone()
        out[0, :height, :width] = arr
        return out
    except Exception as exc:
        log.warning("[GJJ LTX Director] guide 图像压缩失败：%s", exc)
        return tensor


def _build_combined_audio(timeline_data_str: str, duration_frames: int, frame_rate: float) -> dict:
    target_sr = 44100
    total_samples = max(1, int(math.ceil(duration_frames / frame_rate * target_sr)))
    empty_audio = {"waveform": torch.zeros((1, 2, total_samples), dtype=torch.float32), "sample_rate": target_sr}
    if not timeline_data_str:
        return empty_audio
    try:
        audio_segs = json.loads(timeline_data_str).get("audioSegments", [])
    except Exception:
        return empty_audio
    if not audio_segs:
        return empty_audio
    try:
        import av
    except Exception as exc:
        raise RuntimeError("时间线包含音频片段，但当前环境缺少 PyAV，无法合成时间线音频。") from exc

    out_waveform = torch.zeros((2, total_samples), dtype=torch.float32)
    for seg in audio_segs:
        buffer = None
        if seg.get("audioFile"):
            file_path = os.path.join(folder_paths.get_input_directory(), seg["audioFile"])
            if os.path.exists(file_path):
                with open(file_path, "rb") as handle:
                    buffer = _io.BytesIO(handle.read())
        if not buffer and seg.get("audioB64"):
            audio_b64 = seg.get("audioB64")
            if "," in audio_b64:
                audio_b64 = audio_b64.split(",", 1)[1]
            try:
                buffer = _io.BytesIO(base64.b64decode(audio_b64))
            except Exception:
                pass
        if not buffer:
            continue
        try:
            clip_frames = []
            with av.open(buffer) as container:
                stream = container.streams.audio[0]
                resampler = av.AudioResampler(format="fltp", layout="stereo", rate=target_sr)
                for frame in container.decode(stream):
                    for resampled_frame in resampler.resample(frame):
                        clip_frames.append(torch.from_numpy(resampled_frame.to_ndarray()))
                for resampled_frame in resampler.resample(None):
                    clip_frames.append(torch.from_numpy(resampled_frame.to_ndarray()))
            if not clip_frames:
                continue
            waveform = torch.cat(clip_frames, dim=1)
            trim_start_frames = float(seg.get("trimStart", 0))
            length_frames = float(seg.get("length", 1))
            start_frames = float(seg.get("start", 0))
            start_sample_src = max(0, int(trim_start_frames / frame_rate * target_sr))
            end_sample_src = min(waveform.shape[1], start_sample_src + int(length_frames / frame_rate * target_sr))
            actual_length = end_sample_src - start_sample_src
            if actual_length <= 0:
                continue
            clip_waveform = waveform[:, start_sample_src:end_sample_src]
            start_sample_dst = int(start_frames / frame_rate * target_sr)
            if start_sample_dst >= out_waveform.shape[1]:
                continue
            end_sample_dst = start_sample_dst + actual_length
            if end_sample_dst > out_waveform.shape[1]:
                actual_length = out_waveform.shape[1] - start_sample_dst
                clip_waveform = clip_waveform[:, :actual_length]
                end_sample_dst = start_sample_dst + actual_length
            if actual_length > 0:
                out_waveform[:, start_sample_dst:end_sample_dst] += clip_waveform
        except Exception as exc:
            log.warning("[GJJ LTX Director] 音频片段处理失败：%s", exc)
            continue
    return {"waveform": out_waveform.unsqueeze(0), "sample_rate": target_sr}


def _convert_to_latent_lengths(pixel_lengths, temporal_stride, latent_frames):
    if not pixel_lengths:
        return []
    total_pixel = sum(pixel_lengths)
    if total_pixel <= 0:
        return [1] * len(pixel_lengths)
    target_total = min(latent_frames, max(1, round(total_pixel / temporal_stride)))
    if target_total >= latent_frames - 1:
        target_total = latent_frames
    exact = [length * target_total / total_pixel for length in pixel_lengths]
    result = [int(item) for item in exact]
    diff = target_total - sum(result)
    if diff > 0:
        order = sorted(range(len(exact)), key=lambda i: -(exact[i] - int(exact[i])))
        for idx in range(diff):
            result[order[idx % len(order)]] += 1
    for idx, value in enumerate(result):
        if value < 1:
            max_idx = max(range(len(result)), key=lambda j: result[j])
            if result[max_idx] > 1:
                result[max_idx] -= 1
                result[idx] = 1
    return result


def _encode_relay(model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon):
    locals_list = [prompt.strip() for prompt in str(local_prompts or "").split("|")]
    for prompt in locals_list:
        if not prompt:
            raise ValueError("时间线上有片段缺少提示词。")
    if not locals_list or (len(locals_list) == 1 and not locals_list[0]):
        raise ValueError("LTX Director 至少需要一个局部提示词片段。")

    arch, patch_size, temporal_stride = _detect_model_type(model)
    samples = latent["samples"]
    latent_frames = samples.shape[2]
    tokens_per_frame = (samples.shape[3] // patch_size[1]) * (samples.shape[4] // patch_size[2])

    parsed_lengths = None
    if str(segment_lengths or "").strip():
        pixel_lengths = [int(float(x.strip())) for x in str(segment_lengths).split(",") if x.strip()]
        parsed_lengths = _convert_to_latent_lengths(pixel_lengths, temporal_stride, latent_frames)

    raw_tokenizer = _get_raw_tokenizer(clip)
    full_prompt, token_ranges = _map_token_indices(raw_tokenizer, str(global_prompt or ""), locals_list)
    conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(full_prompt))
    effective_lengths = _distribute_segment_lengths(len(locals_list), latent_frames, parsed_lengths)
    q_token_idx = _build_segments(token_ranges, effective_lengths, epsilon)
    mask_fn = _create_mask_fn(q_token_idx, tokens_per_frame, latent_frames)
    patched = model.clone()
    _apply_patches(patched, arch, mask_fn)
    return patched, conditioning


class GJJLTXDirector:
    CATEGORY = "GJJ/LTX"
    FUNCTION = "execute"
    RETURN_TYPES = ("MODEL", "CONDITIONING", "LATENT", "LATENT", GUIDE_DATA_TYPE, "FLOAT", "AUDIO")
    RETURN_NAMES = ("补丁模型", "正向条件", "视频Latent", "音频Latent", "Guide数据", "帧率", "合成音频")
    OUTPUT_TOOLTIPS = (
        "已写入 Prompt Relay 时间线注意力补丁的模型。",
        "由全局提示词和时间线局部提示词编码出的正向条件。",
        "连接外部 latent 时透传；未连接时按时间线尺寸自动创建 LTX 视频 latent。",
        "连接音频 VAE 时生成的音频 latent；未连接时为空字典。",
        "时间线 guide 图片、插入帧和强度数据，可连接到支持 GUIDE_DATA 的 guide 节点。",
        "时间线使用的帧率。",
        "按时间线音频轨合成后的 AUDIO；无音频片段时输出静音。",
    )
    DESCRIPTION = "GJJ 版 LTX Director：1:1 复刻时间线编辑、Prompt Relay 分段注意力补丁、guide 数据与时间线音频输出，不依赖 WhatDreamsCost 原插件。"
    SEARCH_ALIASES = [
        "ltx director",
        "director timeline",
        "LTX导演",
        "导演时间线",
        "时间线",
        "Prompt Relay",
        "GUIDE_DATA",
    ]
    GJJ_HELP = {
        "description": DESCRIPTION,
        "notes": [
            "前端时间线状态保存在 timeline_data/local_prompts/segment_lengths/guide_strength 隐藏控件中。",
            "图像 guide 数据输出为 GUIDE_DATA，可接 LTX Director Guide 类节点或其它兼容节点。",
            "时间线音频合成需要当前 ComfyUI 环境可导入 PyAV；无音频片段时不需要。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"display_name": "模型", "tooltip": "LTX 或 Wan 模型；节点会在 cross-attention 上写入时间线分段注意力补丁。"}),
                "clip": ("CLIP", {"display_name": "CLIP", "tooltip": "用于编码全局提示词和时间线局部提示词。"}),
                "global_prompt": ("STRING", {"default": "", "multiline": True, "display_name": "全局提示词", "tooltip": "作用于整段视频，用于稳定角色、物体和场景上下文。"}),
                "duration_frames": ("INT", {"default": 120, "min": 1, "max": 10000, "step": 1, "display_name": "总帧数", "tooltip": "时间线显示用的总帧数；实际 latent 帧数仍由视频 latent 决定。"}),
                "duration_seconds": ("FLOAT", {"default": 5.0, "min": 0.1, "max": 1000.0, "step": 0.01, "display_name": "总秒数", "tooltip": "时间线总时长，会与帧数和帧率同步。"}),
                "timeline_data": ("STRING", {"default": "", "display_name": "时间线数据", "tooltip": "前端时间线编辑器自动维护的 JSON，请勿手动编辑。"}),
                "local_prompts": ("STRING", {"default": "", "multiline": True, "display_name": "局部提示词", "tooltip": "前端时间线自动汇总的局部提示词，用竖线分隔。"}),
                "segment_lengths": ("STRING", {"default": "", "display_name": "片段长度", "tooltip": "前端时间线自动汇总的片段帧长，用逗号分隔。"}),
                "epsilon": ("FLOAT", {"default": 0.001, "min": 0.0001, "max": 0.99, "step": 0.0001, "display_name": "边界衰减", "tooltip": "Prompt Relay 分段边界衰减参数；越大过渡越软。"}),
                "frame_rate": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 1.0, "display_name": "帧率", "tooltip": "时间线显示和音频对齐使用的 FPS。"}),
                "display_mode": (["seconds", "frames"], {"default": "seconds", "display_name": "显示单位", "tooltip": "时间线标尺显示秒数或帧数。"}),
                "guide_strength": ("STRING", {"default": "", "display_name": "Guide强度", "tooltip": "前端时间线自动汇总的图像 guide 强度，用逗号分隔。"}),
                "custom_width": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1, "display_name": "Guide宽度", "tooltip": "图像 guide 目标宽度；0 表示跟随原图或默认宽度。"}),
                "custom_height": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1, "display_name": "Guide高度", "tooltip": "图像 guide 目标高度；0 表示跟随原图或默认高度。"}),
                "resize_method": (["maintain aspect ratio", "stretch to fit", "pad", "crop"], {"default": "maintain aspect ratio", "display_name": "缩放方式", "tooltip": "图像 guide 适配目标尺寸的方式。"}),
                "divisible_by": ("INT", {"default": 32, "min": 1, "max": 256, "step": 1, "display_name": "尺寸整除", "tooltip": "输出 guide 尺寸会吸附到该数值的整数倍。"}),
                "img_compression": ("INT", {"default": 18, "min": 0, "max": 100, "step": 1, "display_name": "图像压缩CRF", "tooltip": "对 guide 图像模拟 H.264 压缩；0 表示不压缩。"}),
                "use_custom_audio": ("BOOLEAN", {"default": False, "display_name": "使用时间线音频", "tooltip": "开启后若连接音频 VAE，会把时间线音频编码为音频 latent；关闭则创建空音频 latent。"}),
            },
            "optional": {
                "audio_vae": ("VAE", {"display_name": "音频VAE", "tooltip": "可选。连接后生成 LTX 音频 latent。"}),
                "optional_latent": ("LATENT", {"display_name": "外部视频Latent", "tooltip": "可选。连接后使用外部 latent，否则按时间线自动创建 LTX 视频 latent。"}),
            },
        }

    def execute(
        self,
        model,
        clip,
        global_prompt,
        duration_frames,
        duration_seconds,
        timeline_data,
        local_prompts,
        segment_lengths,
        epsilon=1e-3,
        frame_rate=24.0,
        display_mode="seconds",
        guide_strength="",
        custom_width=0,
        custom_height=0,
        resize_method="maintain aspect ratio",
        divisible_by=32,
        img_compression=18,
        use_custom_audio=False,
        audio_vae=None,
        optional_latent=None,
    ):
        guide_data = {"images": [], "insert_frames": [], "strengths": [], "frame_rate": float(frame_rate)}
        derived_w, derived_h = int(custom_width), int(custom_height)
        try:
            tdata = json.loads(timeline_data) if timeline_data else {}
            img_segs = [
                seg
                for seg in tdata.get("segments", [])
                if seg.get("type", "image") == "image"
                and (seg.get("imageFile") or seg.get("imageB64"))
                and int(seg.get("start", 0)) < int(duration_frames)
            ]
            img_segs.sort(key=lambda item: item["start"])
            strengths = [float(x.strip()) for x in str(guide_strength or "").split(",") if x.strip()]
            for idx, seg in enumerate(img_segs):
                tensor = _load_image_tensor(seg)
                src_h, src_w = tensor.shape[1], tensor.shape[2]

                def snap(val, div):
                    return max(div, (int(val) // div) * div)

                if custom_width > 0 and custom_height > 0:
                    tensor = _resize_image(tensor, custom_width, custom_height, resize_method, divisible_by)
                elif custom_width > 0:
                    tgt_w = snap(custom_width, divisible_by)
                    tgt_h = snap(src_h * tgt_w / src_w, divisible_by)
                    tensor = _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
                elif custom_height > 0:
                    tgt_h = snap(custom_height, divisible_by)
                    tgt_w = snap(src_w * tgt_h / src_h, divisible_by)
                    tensor = _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
                else:
                    tensor = _resize_image(tensor, src_w, src_h, "maintain aspect ratio", divisible_by)
                tensor = _compress_image(tensor, int(img_compression))
                if idx == 0:
                    derived_h, derived_w = tensor.shape[1], tensor.shape[2]
                guide_data["images"].append(tensor)
                guide_data["insert_frames"].append(int(seg["start"]))
                guide_data["strengths"].append(float(strengths[idx] if idx < len(strengths) else 1.0))
            if not guide_data["images"]:
                width = max(32, ((derived_w if derived_w > 0 else 768) // 32) * 32)
                height = max(32, ((derived_h if derived_h > 0 else 512) // 32) * 32)
                guide_data["images"].append(torch.zeros((1, height, width, 3), dtype=torch.float32))
                guide_data["insert_frames"].append(0)
                guide_data["strengths"].append(0.0)
                derived_w, derived_h = width, height
        except Exception as exc:
            raise RuntimeError(f"构建 LTX Director guide 数据失败：{exc}") from exc

        ltxv_length = int(duration_frames) + 1
        if optional_latent is None:
            latent_w = max(32, (int(derived_w or 768) // 32) * 32)
            latent_h = max(32, (int(derived_h or 512) // 32) * 32)
            latent_t = ((ltxv_length - 1) // 8) + 1
            samples = torch.zeros(
                [1, 128, latent_t, latent_h // 32, latent_w // 32],
                device=comfy.model_management.intermediate_device(),
            )
            latent = {"samples": samples}
        else:
            latent = optional_latent

        patched, conditioning = _encode_relay(model, clip, latent, global_prompt, local_prompts, segment_lengths, float(epsilon))
        audio_out = _build_combined_audio(timeline_data, ltxv_length, float(frame_rate))
        audio_latent = {}
        if audio_vae is not None:
            def get_empty_latent():
                inner = getattr(audio_vae, "first_stage_model", audio_vae)
                z_channels = audio_vae.latent_channels
                audio_freq = inner.latent_frequency_bins
                num_audio_latents = inner.num_of_latents_from_frames(ltxv_length, float(frame_rate))
                audio_latents = torch.zeros((1, z_channels, num_audio_latents, audio_freq), device=comfy.model_management.intermediate_device())
                return {"samples": audio_latents, "type": "audio"}

            if use_custom_audio:
                waveform = audio_out["waveform"]
                if waveform.ndim == 2:
                    waveform = waveform.unsqueeze(0)
                if waveform.ndim != 3:
                    raise RuntimeError(f"时间线音频波形维度不正确：{tuple(waveform.shape)}")
                if hasattr(audio_vae, "first_stage_model"):
                    latent_samples = audio_vae.encode(waveform.movedim(1, -1))
                else:
                    latent_samples = audio_vae.encode({"waveform": waveform, "sample_rate": audio_out["sample_rate"]})
                if latent_samples.numel() == 0:
                    raise RuntimeError("时间线音频编码得到空 latent。")
                mask = torch.full(
                    (1, latent_samples.shape[-2], latent_samples.shape[-1]),
                    0.0,
                    dtype=torch.float32,
                    device=comfy.model_management.intermediate_device(),
                )
                audio_latent = {"samples": latent_samples, "type": "audio", "noise_mask": mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1]))}
            else:
                audio_latent = get_empty_latent()

        return (patched, conditioning, latent, audio_latent, guide_data, float(frame_rate), audio_out)


class GJJLTXDirectorGuide:
    CATEGORY = "GJJ/LTX"
    FUNCTION = "execute"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "Guide视频Latent")
    OUTPUT_TOOLTIPS = (
        "已追加 LTX guide keyframe 信息的正向条件。",
        "已追加 LTX guide keyframe 信息的负向条件。",
        "插入 guide latent 与 noise_mask 后的视频 latent。",
    )
    DESCRIPTION = "GJJ 版 LTX Director Guide：读取 LTX导演时间线 输出的 GUIDE_DATA，按时间线插入 guide 图像关键帧。"
    SEARCH_ALIASES = [
        "ltx director guide",
        "director guide",
        "ltx guide",
        "LTX导演Guide",
        "LTX导演引导",
        "导演Guide",
        "导演引导",
        "引导",
        "Guide数据",
        "GUIDE_DATA",
        "LTXVAddGuide",
    ]
    GJJ_HELP = {
        "description": DESCRIPTION,
        "notes": [
            "连接 GJJ · 🎬 LTX导演时间线 的 Guide数据 输出。",
            "逻辑复刻 LTX Director Guide，底层使用 ComfyUI 内置 LTXVAddGuide 的编码和 keyframe 方法。",
            "支持按 scale_by 缩放 latent，并同步调整已有 noise_mask。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("CONDITIONING", {"display_name": "正向条件", "tooltip": "需要加入 guide keyframe 信息的正向 conditioning。"}),
                "negative": ("CONDITIONING", {"display_name": "负向条件", "tooltip": "需要加入 guide keyframe 信息的负向 conditioning。"}),
                "vae": ("VAE", {"display_name": "视频VAE", "tooltip": "用于把 guide 图片编码到 LTX 视频 latent 空间的 VAE。"}),
                "latent": ("LATENT", {"display_name": "视频Latent", "tooltip": "要插入 guide 帧的视频 latent，通常来自 LTX导演时间线。"}),
                "guide_data": (GUIDE_DATA_TYPE, {"display_name": "Guide数据", "tooltip": "来自 GJJ · 🎬 LTX导演时间线 的 GUIDE_DATA 输出。"}),
                "scale_by": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 8.0, "step": 0.01, "display_name": "Latent缩放", "tooltip": "在写入 guide 前按比例缩放 latent 空间宽高。1 表示不缩放。"}),
                "upscale_method": (["nearest-exact", "bilinear", "area", "bicubic", "bislerp"], {"default": "bicubic", "display_name": "缩放算法", "tooltip": "Latent 缩放使用的算法。"}),
            }
        }

    def execute(self, positive, negative, vae, latent, guide_data, scale_by=1.0, upscale_method="bicubic"):
        from comfy_extras.nodes_lt import LTXVAddGuide

        if not isinstance(guide_data, dict):
            raise RuntimeError("Guide数据格式不正确，请连接 GJJ · 🎬 LTX导演时间线 的 Guide数据 输出。")

        scale_factors = vae.downscale_index_formula
        latent_image = latent["samples"].clone()

        if "noise_mask" in latent:
            noise_mask = latent["noise_mask"].clone()
        else:
            batch, _, latent_frames, _, _ = latent_image.shape
            noise_mask = torch.ones(
                (batch, 1, latent_frames, 1, 1),
                dtype=torch.float32,
                device=latent_image.device,
            )

        if float(scale_by) != 1.0:
            batch, channels, frames, height, width = latent_image.shape
            new_width = round(width * float(scale_by))
            new_height = round(height * float(scale_by))
            latent_4d = latent_image.permute(0, 2, 1, 3, 4).reshape(batch * frames, channels, height, width)
            latent_resized_4d = comfy.utils.common_upscale(latent_4d, new_width, new_height, upscale_method, "disabled")
            latent_image = latent_resized_4d.reshape(batch, frames, channels, new_height, new_width).permute(0, 2, 1, 3, 4)

            if noise_mask.shape[-1] > 1 or noise_mask.shape[-2] > 1:
                mask_4d = noise_mask.permute(0, 2, 1, 3, 4).reshape(batch * frames, 1, height, width)
                mask_resized_4d = comfy.utils.common_upscale(mask_4d, new_width, new_height, upscale_method, "disabled")
                noise_mask = mask_resized_4d.reshape(batch, frames, 1, new_height, new_width).permute(0, 2, 1, 3, 4)

        _, _, latent_length, latent_height, latent_width = latent_image.shape
        images = guide_data.get("images", [])
        insert_frames = guide_data.get("insert_frames", [])
        strengths = guide_data.get("strengths", [])

        for idx, img_tensor in enumerate(images):
            frame_idx = insert_frames[idx] if idx < len(insert_frames) else 0
            strength = strengths[idx] if idx < len(strengths) else 1.0
            _image_pixels, guiding_latent = LTXVAddGuide.encode(vae, latent_width, latent_height, img_tensor, scale_factors)
            keyframe_frame_idx, latent_idx = LTXVAddGuide.get_latent_index(
                positive,
                latent_length,
                len(_image_pixels),
                int(frame_idx),
                scale_factors,
            )
            if latent_idx + guiding_latent.shape[2] > latent_length:
                raise RuntimeError(f"第 {idx + 1} 个 Guide 图像超出 latent 长度，请缩短时间线或调整插入帧。")
            positive, negative, latent_image, noise_mask = LTXVAddGuide.append_keyframe(
                positive,
                negative,
                keyframe_frame_idx,
                latent_image,
                noise_mask,
                guiding_latent,
                float(strength),
                scale_factors,
            )

        return (positive, negative, {"samples": latent_image, "noise_mask": noise_mask})


NODE_CLASS_MAPPINGS = {
    "GJJ_LTXDirector": GJJLTXDirector,
    "GJJ_LTXDirectorGuide": GJJLTXDirectorGuide,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_LTXDirector": "🎬 LTX导演时间线",
    "GJJ_LTXDirectorGuide": "🧭 LTX导演Guide引导",
}
