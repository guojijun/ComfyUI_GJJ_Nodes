from __future__ import annotations

import json
import logging
import math
import types

import torch
import comfy.ldm.modules.attention


log = logging.getLogger(__name__)


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
        x = comfy.ldm.modules.attention.optimized_attention(
            q, k, v, heads=self.num_heads, transformer_options=transformer_options
        )
    return self.o(x)


def _wan_i2v_forward(self, mask_fn, x, context, context_img_len, transformer_options=None, **kwargs):
    transformer_options = transformer_options or {}
    context_img = context[:, :context_img_len]
    context_text = context[:, context_img_len:]
    q = self.norm_q(self.q(x))

    k_img = self.norm_k_img(self.k_img(context_img))
    v_img = self.v_img(context_img)
    img_x = comfy.ldm.modules.attention.optimized_attention(
        q, k_img, v_img, heads=self.num_heads, transformer_options=transformer_options
    )

    k = self.norm_k(self.k(context_text))
    v = self.v(context_text)
    mask = mask_fn(q, k, transformer_options)
    if mask is not None:
        x = _masked_attention(q, k, v, heads=self.num_heads, mask=mask, transformer_options=transformer_options)
    else:
        x = comfy.ldm.modules.attention.optimized_attention(
            q, k, v, heads=self.num_heads, transformer_options=transformer_options
        )
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
        out = _masked_attention(
            q,
            k,
            v,
            self.heads,
            mask=mask,
            attn_precision=self.attn_precision,
            transformer_options=transformer_options,
        )

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
    raise ValueError(f"不支持的模型结构：{type(diff_model).__name__}。当前仅支持 Wan 和 LTX 视频模型。")


def _check_unpatched(model_clone, key):
    if key in getattr(model_clone, "object_patches", {}):
        raise RuntimeError(f"Prompt Relay 无法叠加补丁：`{key}` 已被其它节点修改。请移除冲突节点后再运行。")


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

    raise ValueError(f"未知模型结构：{arch}")


def _build_temporal_cost(q_token_idx, lq, lk, device, dtype, tokens_per_frame):
    offset = torch.zeros(lq, lk, device=device, dtype=dtype)
    query_frames = torch.arange(lq, device=device, dtype=torch.long) // tokens_per_frame
    for seg in q_token_idx:
        local = seg["local_token_idx"].to(device=device)
        distance = (query_frames.float()[:, None] - seg["midpoint"]).abs()
        cost = (torch.relu(distance - seg["window"]) ** 2) / (2 * seg["sigma"] ** 2)
        offset[:, local] = cost.to(offset.dtype)
    return offset


def _build_temporal_cost_scaled(q_token_idx, lq, lk, device, dtype, latent_frames):
    offset = torch.zeros(lq, lk, device=device, dtype=dtype)
    query_frames = torch.arange(lq, device=device, dtype=torch.float32) * latent_frames / lq
    for seg in q_token_idx:
        local = seg["local_token_idx"].to(device=device)
        distance = (query_frames[:, None] - seg["midpoint"]).abs()
        cost = (torch.relu(distance - seg["window"]) ** 2) / (2 * seg["sigma"] ** 2)
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
            log.info("[GJJ PromptRelay] penalty matrix: mode=%s, Lq=%d, Lk=%d", mode, lq, lk)
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
            }
        )
        frame_cursor += length
    if not q_token_idx:
        raise ValueError("局部提示词没有可用的时间片段，请检查分段长度。")
    return q_token_idx


def _get_raw_tokenizer(clip):
    tokenizer_wrapper = clip.tokenizer
    for attr_name in dir(tokenizer_wrapper):
        if attr_name.startswith("_"):
            continue
        inner = getattr(tokenizer_wrapper, attr_name, None)
        if inner is not None and hasattr(inner, "tokenizer"):
            return inner.tokenizer
    names = [name for name in dir(tokenizer_wrapper) if not name.startswith("_")]
    raise RuntimeError(f"无法在 CLIP 对象中找到原始 tokenizer。可见字段：{names}")


def _map_token_indices(raw_tokenizer, global_prompt, local_prompts):
    prefixed_locals = [" " + prompt for prompt in local_prompts]
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
            raise ValueError(f"局部提示词没有生成有效 token：{prompt.strip()}")
        token_ranges.append((prev_len, cur_len))
        prev_len = cur_len
    return full_prompt, token_ranges


def _distribute_segment_lengths(num_segments, latent_frames, specified_lengths=None):
    if specified_lengths:
        if len(specified_lengths) != num_segments:
            raise ValueError(f"分段长度数量（{len(specified_lengths)}）必须和局部提示词数量（{num_segments}）一致。")
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


def _convert_to_latent_lengths(pixel_lengths, temporal_stride, latent_frames):
    if not pixel_lengths:
        return []
    total_pixel = sum(pixel_lengths)
    if total_pixel <= 0:
        return [1] * len(pixel_lengths)

    naive_total = max(1, round(total_pixel / temporal_stride))
    target_total = min(latent_frames, naive_total)
    if target_total >= latent_frames - 1:
        target_total = latent_frames

    exact = [length * target_total / total_pixel for length in pixel_lengths]
    result = [int(value) for value in exact]
    diff = target_total - sum(result)
    if diff > 0:
        order = sorted(range(len(exact)), key=lambda i: -(exact[i] - int(exact[i])))
        for idx in range(diff):
            result[order[idx % len(order)]] += 1

    for i, value in enumerate(result):
        if value >= 1:
            continue
        max_idx = max(range(len(result)), key=lambda j: result[j])
        if result[max_idx] > 1:
            result[max_idx] -= 1
            result[i] = 1
    return result


def _parse_segment_lengths(segment_lengths):
    text = str(segment_lengths or "").strip()
    if not text:
        return None
    try:
        values = [int(part.strip()) for part in text.split(",") if part.strip()]
    except Exception as exc:
        raise ValueError("分段长度必须是用英文逗号分隔的整数，例如：33,48,48。") from exc
    if any(value < 0 for value in values):
        raise ValueError("分段长度不能为负数。")
    return values


def _extract_timeline_payload(timeline_data):
    text = str(timeline_data or "").strip()
    if not text:
        return "", ""
    try:
        payload = json.loads(text)
    except Exception as exc:
        raise ValueError("时间轴数据不是有效 JSON，请重新调整任一片段后再运行。") from exc

    segments = payload.get("segments") if isinstance(payload, dict) else None
    if not isinstance(segments, list):
        return "", ""

    prompts = []
    lengths = []
    for item in segments:
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt") or "").strip()
        length = int(item.get("length") or 0)
        if prompt:
            prompts.append(prompt)
            lengths.append(str(max(1, length)))

    return " | ".join(prompts), ", ".join(lengths)


def _encode_relay(model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon):
    locals_list = [prompt.strip() for prompt in str(local_prompts or "").split("|") if prompt.strip()]
    if not locals_list:
        raise ValueError("至少需要一个局部提示词；多个片段请用 | 分隔。")

    samples = latent.get("samples")
    if samples is None or len(samples.shape) < 5:
        raise ValueError("输入 latent 必须是视频 latent，形状应包含帧数、高度和宽度。")

    arch, patch_size, temporal_stride = _detect_model_type(model)
    latent_frames = samples.shape[2]
    tokens_per_frame = (samples.shape[3] // patch_size[1]) * (samples.shape[4] // patch_size[2])

    parsed_lengths = _parse_segment_lengths(segment_lengths)
    if parsed_lengths:
        parsed_lengths = _convert_to_latent_lengths(parsed_lengths, temporal_stride, latent_frames)

    raw_tokenizer = _get_raw_tokenizer(clip)
    full_prompt, token_ranges = _map_token_indices(raw_tokenizer, str(global_prompt or ""), locals_list)
    conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(full_prompt))

    effective_lengths = _distribute_segment_lengths(len(locals_list), latent_frames, parsed_lengths)
    q_token_idx = _build_segments(token_ranges, effective_lengths, epsilon)
    mask_fn = _create_mask_fn(q_token_idx, tokens_per_frame, latent_frames)

    patched = model.clone()
    _apply_patches(patched, arch, mask_fn)
    return patched, conditioning


class GJJ_PromptRelayEncode:
    CATEGORY = "GJJ/视频/时序提示词"
    FUNCTION = "encode"
    RETURN_TYPES = ("MODEL", "CONDITIONING")
    RETURN_NAMES = ("时序控制模型", "正向条件")
    OUTPUT_TOOLTIPS = ("已注入 Prompt Relay 时序注意力补丁的模型。", "由全局提示词和局部提示词合成后的正向条件。")
    DESCRIPTION = "将全局提示词和按时间分段的局部提示词编码为视频时序控制条件，支持 Wan 与 LTX。"
    SEARCH_ALIASES = ["prompt relay", "temporal prompt", "局部提示词", "时间轴提示词", "wan", "ltx"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"display_name": "模型", "tooltip": "Wan 或 LTX 视频扩散模型。"}),
                "clip": ("CLIP", {"display_name": "CLIP", "tooltip": "与当前模型匹配的文本编码器。"}),
                "latent": ("LATENT", {"display_name": "视频 Latent", "tooltip": "用于读取帧数和空间尺寸的视频 latent。"}),
                "global_prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "display_name": "全局提示词",
                        "tooltip": "贯穿整段视频的角色、场景和风格描述。",
                    },
                ),
                "local_prompts": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "display_name": "局部提示词",
                        "tooltip": "按时间顺序填写片段提示词，多个片段用 | 分隔。",
                    },
                ),
                "segment_lengths": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "分段长度",
                        "tooltip": "像素帧长度，使用英文逗号分隔；留空时按局部提示词数量均分 latent 帧。",
                    },
                ),
                "epsilon": (
                    "FLOAT",
                    {
                        "default": 0.001,
                        "min": 0.000001,
                        "max": 0.99,
                        "step": 0.0001,
                        "display_name": "边界衰减",
                        "tooltip": "越小片段边界越硬；需要柔和过渡时可尝试 0.5 或更高。",
                    },
                ),
            }
        }

    def encode(self, model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon):
        return _encode_relay(model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon)


class GJJ_PromptRelayTimeline(GJJ_PromptRelayEncode):
    DESCRIPTION = "带可视化时间轴编辑器的 Prompt Relay 编码节点。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"display_name": "模型", "tooltip": "Wan 或 LTX 视频扩散模型。"}),
                "clip": ("CLIP", {"display_name": "CLIP", "tooltip": "与当前模型匹配的文本编码器。"}),
                "latent": ("LATENT", {"display_name": "视频 Latent", "tooltip": "用于读取帧数和空间尺寸的视频 latent。"}),
                "global_prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "display_name": "全局提示词",
                        "tooltip": "贯穿整段视频的角色、场景和风格描述。",
                    },
                ),
                "max_frames": (
                    "INT",
                    {
                        "default": 129,
                        "min": 1,
                        "max": 10000,
                        "step": 1,
                        "display_name": "时间轴总帧数",
                        "tooltip": "仅用于前端时间轴比例尺；实际 latent 帧数仍从输入 latent 读取。",
                        "gjj_frontend_hidden": True,
                        "hidden": True,
                    },
                ),
                "timeline_data": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "时间轴数据",
                        "tooltip": "前端自动维护的时间轴 JSON，通常不需要手动编辑。",
                        "gjj_frontend_hidden": True,
                        "hidden": True,
                    },
                ),
                "local_prompts": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "display_name": "局部提示词",
                        "tooltip": "由时间轴自动生成并传给后台，前端面板不显示，避免隐藏参数挤出空行。",
                        "gjj_frontend_hidden": True,
                        "hidden": True,
                    },
                ),
                "segment_lengths": (
                    "STRING",
                    {
                        "default": "",
                        "display_name": "分段长度",
                        "tooltip": "由时间轴自动生成并传给后台，前端面板不显示，避免隐藏参数挤出空行。",
                        "gjj_frontend_hidden": True,
                        "hidden": True,
                    },
                ),
                "epsilon": (
                    "FLOAT",
                    {
                        "default": 0.001,
                        "min": 0.000001,
                        "max": 0.99,
                        "step": 0.0001,
                        "display_name": "边界衰减",
                        "tooltip": "越小片段边界越硬；需要柔和过渡时可尝试 0.5 或更高。",
                        "gjj_frontend_hidden": True,
                        "hidden": True,
                    },
                ),
                "fps": (
                    "FLOAT",
                    {
                        "default": 24.0,
                        "min": 0.1,
                        "max": 240.0,
                        "step": 0.1,
                        "display_name": "帧率",
                        "tooltip": "只影响时间轴以秒显示时的换算。",
                        "gjj_frontend_hidden": True,
                        "hidden": True,
                    },
                ),
                "time_units": (
                    ["帧", "秒"],
                    {
                        "default": "帧",
                        "display_name": "显示单位",
                        "tooltip": "选择时间轴标尺显示为帧或秒；内部仍按帧保存。",
                        "gjj_frontend_hidden": True,
                        "hidden": True,
                    },
                ),
            }
        }

    def encode(
        self,
        model,
        clip,
        latent,
        global_prompt,
        max_frames,
        timeline_data,
        local_prompts,
        segment_lengths,
        epsilon,
        fps=24.0,
        time_units="帧",
    ):
        timeline_prompts, timeline_lengths = _extract_timeline_payload(timeline_data)
        if timeline_prompts:
            local_prompts = timeline_prompts
            segment_lengths = timeline_lengths
        return _encode_relay(model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon)


NODE_CLASS_MAPPINGS = {
    "GJJ_PromptRelayEncode": GJJ_PromptRelayEncode,
    "GJJ_PromptRelayEncodeTimeline": GJJ_PromptRelayTimeline,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_PromptRelayEncode": "GJJ · 🎞️ 时序提示词编码",
    "GJJ_PromptRelayEncodeTimeline": "GJJ · 🧭 时间轴提示词编码",
}
