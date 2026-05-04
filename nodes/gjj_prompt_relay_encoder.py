from __future__ import annotations

import logging
import math
import types

import torch

import comfy.ldm.modules.attention

NODE_NAME = "GJJ_PromptRelayEncoder"
LOGGER = logging.getLogger(__name__)


def _masked_attention(q, k, v, heads, mask, transformer_options=None, **kwargs):
    transformer_options = transformer_options or {}
    return comfy.ldm.modules.attention.attention_pytorch(
        q,
        k,
        v,
        heads,
        mask=mask,
        _inside_attn_wrapper=True,
        transformer_options=transformer_options,
        **kwargs,
    )


def _wan_t2v_forward(self, mask_fn, x, context, transformer_options=None, **kwargs):
    transformer_options = transformer_options or {}

    q = self.norm_q(self.q(x))
    k = self.norm_k(self.k(context))
    v = self.v(context)

    mask = mask_fn(q, k, transformer_options)
    if mask is not None:
        x = _masked_attention(
            q,
            k,
            v,
            heads=self.num_heads,
            mask=mask,
            transformer_options=transformer_options,
        )
    else:
        x = comfy.ldm.modules.attention.optimized_attention(
            q,
            k,
            v,
            heads=self.num_heads,
            transformer_options=transformer_options,
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
        q,
        k_img,
        v_img,
        heads=self.num_heads,
        transformer_options=transformer_options,
    )

    k = self.norm_k(self.k(context_text))
    v = self.v(context_text)

    mask = mask_fn(q, k, transformer_options)
    if mask is not None:
        x = _masked_attention(
            q,
            k,
            v,
            heads=self.num_heads,
            mask=mask,
            transformer_options=transformer_options,
        )
    else:
        x = comfy.ldm.modules.attention.optimized_attention(
            q,
            k,
            v,
            heads=self.num_heads,
            transformer_options=transformer_options,
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
            q,
            k,
            v,
            self.heads,
            attn_precision=self.attn_precision,
            transformer_options=transformer_options,
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
        batch_size, tokens, _ = out.shape
        out = out.view(batch_size, tokens, self.heads, self.dim_head)
        out = out * (2.0 * torch.sigmoid(gate_logits)).unsqueeze(-1)
        out = out.view(batch_size, tokens, self.heads * self.dim_head)

    return self.to_out(out)


class _CrossAttentionPatch:
    def __init__(self, impl, mask_fn):
        self.impl = impl
        self.mask_fn = mask_fn

    def __get__(self, obj, objtype=None):
        impl = self.impl
        mask_fn = self.mask_fn

        def wrapped(self_module, *args, **kwargs):
            return impl(self_module, mask_fn, *args, **kwargs)

        return types.MethodType(wrapped, obj)


def _detect_model_type(model):
    diffusion_model = model.model.diffusion_model

    if hasattr(diffusion_model, "patch_size") and not hasattr(diffusion_model, "patchifier"):
        return "wan", tuple(diffusion_model.patch_size), 4

    if hasattr(diffusion_model, "patchifier"):
        return "ltx", (1, 1, 1), int(diffusion_model.vae_scale_factors[0])

    raise RuntimeError(
        f"暂不支持当前模型类型：{type(diffusion_model).__name__}。"
        " 目前仅支持 Wan 与 LTX 系列视频模型。"
    )


def _check_unpatched(model_clone, key):
    if key in getattr(model_clone, "object_patches", {}):
        raise RuntimeError(
            f"提示词中继检测到交叉注意力已被其它节点补丁占用：{key}。"
            " 请移除冲突节点后再试。"
        )


def _apply_patches(model_clone, arch, mask_fn):
    diffusion_model = model_clone.get_model_object("diffusion_model")

    if arch == "wan":
        from comfy.ldm.wan.model import WanI2VCrossAttention

        for index, block in enumerate(diffusion_model.blocks):
            key = f"diffusion_model.blocks.{index}.cross_attn.forward"
            _check_unpatched(model_clone, key)
            cross_attn = block.cross_attn
            impl = _wan_i2v_forward if isinstance(cross_attn, WanI2VCrossAttention) else _wan_t2v_forward
            model_clone.add_object_patch(
                key,
                _CrossAttentionPatch(impl, mask_fn).__get__(cross_attn, cross_attn.__class__),
            )
        return

    if arch == "ltx":
        for index, block in enumerate(diffusion_model.transformer_blocks):
            for attr_name in ("attn2", "audio_attn2"):
                module = getattr(block, attr_name, None)
                if module is None:
                    continue
                key = f"diffusion_model.transformer_blocks.{index}.{attr_name}.forward"
                _check_unpatched(model_clone, key)
                model_clone.add_object_patch(
                    key,
                    _CrossAttentionPatch(_ltx_forward, mask_fn).__get__(module, module.__class__),
                )
        return

    raise RuntimeError(f"未知模型架构：{arch}")


def _build_temporal_cost(q_token_idx, query_length, key_length, device, dtype, tokens_per_frame):
    offset = torch.zeros(query_length, key_length, device=device, dtype=dtype)
    query_frames = torch.arange(query_length, device=device, dtype=torch.long) // tokens_per_frame

    for seg in q_token_idx:
        local = seg["local_token_idx"].to(device=device)
        distance = (query_frames.float()[:, None] - seg["midpoint"]).abs()
        cost = (torch.relu(distance - seg["window"]) ** 2) / (2 * seg["sigma"] ** 2)
        offset[:, local] = cost.to(offset.dtype)

    return offset


def _build_temporal_cost_scaled(q_token_idx, query_length, key_length, device, dtype, latent_frames):
    offset = torch.zeros(query_length, key_length, device=device, dtype=dtype)
    query_frames = torch.arange(query_length, device=device, dtype=torch.float32) * latent_frames / query_length

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
        query_length = q.shape[1]
        key_length = k.shape[1]

        if query_length == key_length:
            return None

        cond_or_uncond = transformer_options.get("cond_or_uncond", [])
        if 1 in cond_or_uncond and 0 not in cond_or_uncond:
            return None

        grid_sizes = transformer_options.get("grid_sizes", None)
        video_tokens_per_frame = (
            int(grid_sizes[1]) * int(grid_sizes[2]) if grid_sizes is not None else fallback_tokens_per_frame
        )
        video_query_length = latent_frames * video_tokens_per_frame

        if key_length == video_query_length or key_length < max_token_idx:
            return None

        mode = "video" if query_length == video_query_length else "scaled"
        key = (query_length, key_length, mode, q.device)
        if key not in cache:
            if mode == "video":
                cost = _build_temporal_cost(
                    q_token_idx,
                    query_length,
                    key_length,
                    q.device,
                    q.dtype,
                    video_tokens_per_frame,
                )
            else:
                cost = _build_temporal_cost_scaled(
                    q_token_idx,
                    query_length,
                    key_length,
                    q.device,
                    q.dtype,
                    latent_frames,
                )
            LOGGER.info(
                "[GJJ PromptRelay] built penalty matrix (%s): Lq=%d, Lk=%d, nonzero=%d/%d",
                mode,
                query_length,
                key_length,
                (cost > 0).sum().item(),
                cost.numel(),
            )
            cache[key] = -cost

        return cache[key].to(q.dtype)

    return mask_fn


def _build_segments(token_ranges, segment_lengths, epsilon=1e-3):
    sigma = 1.0 / math.log(1.0 / epsilon) if 0 < epsilon < 1 else 0.1448
    segments = []
    frame_cursor = 0

    for (token_start, token_end), length in zip(token_ranges, segment_lengths):
        if length <= 0:
            frame_cursor += length
            continue
        midpoint = (2 * frame_cursor + length) // 2
        window = max(length // 2 - 2, 0)
        segments.append(
            {
                "local_token_idx": torch.arange(token_start, token_end),
                "midpoint": midpoint,
                "window": window,
                "sigma": sigma,
            }
        )
        frame_cursor += length

    return segments


def _get_raw_tokenizer(clip):
    tokenizer_wrapper = clip.tokenizer
    for attr_name in dir(tokenizer_wrapper):
        if attr_name.startswith("_"):
            continue
        inner = getattr(tokenizer_wrapper, attr_name, None)
        if inner is not None and hasattr(inner, "tokenizer"):
            return inner.tokenizer

    visible_attrs = [attr for attr in dir(tokenizer_wrapper) if not attr.startswith("_")]
    raise RuntimeError(f"无法从 CLIP 对象中提取原始 tokenizer，可见属性：{visible_attrs}")


def _map_token_indices(raw_tokenizer, global_prompt, local_prompts):
    prefixed_locals = [" " + prompt for prompt in local_prompts]
    full_prompt = global_prompt + "".join(prefixed_locals)
    has_eos = getattr(raw_tokenizer, "add_eos", False)
    eos_adjust = 1 if has_eos else 0

    previous_length = len(raw_tokenizer(global_prompt)["input_ids"]) - eos_adjust
    token_ranges = []
    built_prompt = global_prompt

    for prompt in prefixed_locals:
        built_prompt += prompt
        current_length = len(raw_tokenizer(built_prompt)["input_ids"]) - eos_adjust
        if current_length <= previous_length:
            raise RuntimeError(f"以下局部提示词没有产生有效 token：{prompt.strip()}")
        token_ranges.append((previous_length, current_length))
        previous_length = current_length

    return full_prompt, token_ranges


def _distribute_segment_lengths(num_segments, latent_frames, specified_lengths=None):
    if specified_lengths:
        if len(specified_lengths) != num_segments:
            raise RuntimeError(
                f"局部提示词共有 {num_segments} 段，但段长只提供了 {len(specified_lengths)} 段。"
            )
        lengths = specified_lengths
    else:
        step = -(-latent_frames // num_segments)
        lengths = [step] * num_segments

    effective_lengths = []
    cursor = 0
    for length in lengths:
        end = min(cursor + length, latent_frames)
        effective_lengths.append(max(end - cursor, 0))
        cursor = end
    return effective_lengths


class GJJ_PromptRelayEncoder:
    CATEGORY = "GJJ/视频"
    FUNCTION = "encode"
    DESCRIPTION = "将全局提示词和多段时序局部提示词编码到 Wan 或 LTX 视频模型中，用于一段视频内按时间切换内容。"
    SEARCH_ALIASES = [
        "prompt relay",
        "视频局部提示词",
        "时序提示词",
        "wan temporal prompt",
        "ltx temporal prompt",
    ]
    RETURN_TYPES = ("MODEL", "CONDITIONING")
    RETURN_NAMES = ("时序补丁模型", "时序正向条件")
    OUTPUT_TOOLTIPS = (
        "已经注入时序局部提示词控制补丁的视频模型。",
        "全局提示词与局部提示词合成后的正向条件。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {
                    "display_name": "视频模型",
                    "tooltip": "输入 Wan 或 LTX 系列视频模型。节点会在交叉注意力层上注入时序提示词补丁。",
                }),
                "clip": ("CLIP", {
                    "display_name": "文本编码器",
                    "tooltip": "用于编码全局提示词与局部提示词的 CLIP 或文本编码器。",
                }),
                "latent": ("LATENT", {
                    "display_name": "视频 latent",
                    "tooltip": "输入空 latent 视频或目标视频 latent，节点会从其中读取总帧数和空间尺寸。",
                }),
                "global_prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "全局提示词",
                    "tooltip": "作用于整段视频的主提示词，用于定义持续存在的人物、主体、场景与整体风格。",
                }),
                "local_prompts": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "局部提示词",
                    "tooltip": "按时间分段的局部提示词，多段之间用 | 分隔，例如：第一段 | 第二段 | 第三段。",
                }),
                "segment_lengths": ("STRING", {
                    "default": "",
                    "display_name": "分段长度",
                    "tooltip": "按原始像素帧数填写每段时长，用英文逗号分隔。留空表示按总帧数平均分配。",
                }),
                "epsilon": ("FLOAT", {
                    "default": 0.001,
                    "min": 0.000001,
                    "max": 0.99,
                    "step": 0.0001,
                    "display_name": "边界锐度",
                    "tooltip": "控制局部提示词切换边界的惩罚衰减。越小边界越硬，越大过渡越柔和。",
                }),
            }
        }

    def encode(self, model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon):
        try:
            local_list = [prompt.strip() for prompt in (local_prompts or "").split("|") if prompt.strip()]
            if not local_list:
                raise RuntimeError("至少需要填写一段局部提示词，并使用 | 分隔多段内容。")

            arch, patch_size, temporal_stride = _detect_model_type(model)

            parsed_lengths = None
            if (segment_lengths or "").strip():
                pixel_lengths = [int(value.strip()) for value in segment_lengths.split(",") if value.strip()]
                parsed_lengths = [max(1, round(length / temporal_stride)) for length in pixel_lengths]

            raw_tokenizer = _get_raw_tokenizer(clip)
            full_prompt, token_ranges = _map_token_indices(raw_tokenizer, (global_prompt or "").strip(), local_list)

            conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(full_prompt))

            samples = latent["samples"]
            latent_frames = samples.shape[2]
            tokens_per_frame = (samples.shape[3] // patch_size[1]) * (samples.shape[4] // patch_size[2])
            effective_lengths = _distribute_segment_lengths(len(local_list), latent_frames, parsed_lengths)

            q_token_idx = _build_segments(token_ranges, effective_lengths, float(epsilon))
            mask_fn = _create_mask_fn(q_token_idx, tokens_per_frame, latent_frames)

            patched_model = model.clone()
            _apply_patches(patched_model, arch, mask_fn)

            return (patched_model, conditioning)
        except Exception as exc:
            raise RuntimeError(f"提示词中继编码失败：{exc}") from exc


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_PromptRelayEncoder}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎞️ 视频提示词中继编码器"}
