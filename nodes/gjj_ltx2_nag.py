import types
import comfy.model_management as mm
import comfy.ldm.modules.attention
import torch

NODE_NAME = "GJJ_LTX2NAG"
CATEGORY = "GJJ/LTX2"


def _compute_attention(self, query, context, attn_precision=None, transformer_options={}):
    k = self.k_norm(self.to_k(context)).to(query.dtype)
    v = self.to_v(context).to(query.dtype)
    x = comfy.ldm.modules.attention.optimized_attention(
        query, k, v, heads=self.heads, attn_precision=attn_precision, transformer_options=transformer_options
    ).flatten(2)
    del k, v
    return x


def nag_attention(self, query, context_positive, nag_context, attn_precision=None, transformer_options={}):
    x_positive = _compute_attention(self, query, context_positive, attn_precision, transformer_options)
    x_negative = _compute_attention(self, query, nag_context, attn_precision, transformer_options)
    return x_positive, x_negative


def normalized_attention_guidance(self, x_positive, x_negative):
    if self.inplace:
        nag_guidance = x_negative.mul_(self.nag_scale - 1).neg_().add_(x_positive, alpha=self.nag_scale)
    else:
        nag_guidance = x_positive * self.nag_scale - x_negative * (self.nag_scale - 1)

    del x_negative

    norm_positive = torch.norm(x_positive, p=1, dim=-1, keepdim=True)
    norm_guidance = torch.norm(nag_guidance, p=1, dim=-1, keepdim=True)

    scale = norm_guidance / norm_positive
    torch.nan_to_num_(scale, nan=10.0)
    mask = scale > self.nag_tau
    del scale

    adjustment = (norm_positive * self.nag_tau) / (norm_guidance + 1e-7)
    del norm_positive, norm_guidance

    nag_guidance.mul_(torch.where(mask, adjustment, 1.0))
    del mask, adjustment

    if self.inplace:
        nag_guidance.sub_(x_positive).mul_(self.nag_alpha).add_(x_positive)
    else:
        nag_guidance = nag_guidance * self.nag_alpha + x_positive * (1 - self.nag_alpha)
    del x_positive

    return nag_guidance


def ltxv_crossattn_forward_nag(self, x, context, mask=None, transformer_options={}, **kwargs):
    # Single or [pos, neg] pair
    if context.shape[0] == 1:
        x_pos, context_pos = x, context
        x_neg, context_neg = None, None
    else:
        x_pos, x_neg = torch.chunk(x, 2, dim=0)
        context_pos, context_neg = torch.chunk(context, 2, dim=0)

    # Positive
    q_pos = self.q_norm(self.to_q(x_pos))
    del x_pos

    x_positive, x_negative = nag_attention(self, q_pos, context_pos, self.nag_context,
                                            attn_precision=self.attn_precision,
                                            transformer_options=transformer_options)
    del context_pos, q_pos

    x_pos_out = normalized_attention_guidance(self, x_positive, x_negative)
    del x_positive, x_negative

    # Negative
    if x_neg is not None and context_neg is not None:
        q_neg = self.q_norm(self.to_q(x_neg))
        k_neg = self.k_norm(self.to_k(context_neg))
        v_neg = self.to_v(context_neg)

        x_neg_out = comfy.ldm.modules.attention.optimized_attention(
            q_neg, k_neg, v_neg, heads=self.heads,
            attn_precision=self.attn_precision,
            transformer_options=transformer_options
        )
        out = torch.cat([x_pos_out, x_neg_out], dim=0)
    else:
        out = x_pos_out

    if self.to_gate_logits is not None:
        gate_logits = self.to_gate_logits(x)  # (B, T, H)
        b, t, _ = out.shape
        out = out.view(b, t, self.heads, self.dim_head)
        gates = 2.0 * torch.sigmoid(gate_logits)  # zero-init -> identity
        out = out * gates.unsqueeze(-1)
        out = out.view(b, t, self.heads * self.dim_head)

    return self.to_out(out)


class LTXVCrossAttentionPatch:
    def __init__(self, context, nag_scale, nag_alpha, nag_tau, inplace=True):
        self.nag_context = context
        self.nag_scale = nag_scale
        self.nag_alpha = nag_alpha
        self.nag_tau = nag_tau
        self.inplace = inplace

    def __get__(self, obj, objtype=None):
        # Create bound method with stored parameters
        def wrapped_attention(self_module, *args, **kwargs):
            self_module.nag_context = self.nag_context
            self_module.nag_scale = self.nag_scale
            self_module.nag_alpha = self.nag_alpha
            self_module.nag_tau = self.nag_tau
            self_module.inplace = self.inplace

            return ltxv_crossattn_forward_nag(self_module, *args, **kwargs)

        return types.MethodType(wrapped_attention, obj)


class GJJ_LTX2NAG:
    CATEGORY = CATEGORY
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"display_name": "模型"}),
                "nag_scale": ("FLOAT", {"default": 11.0, "min": 0.0, "max": 100.0, "step": 0.001, "display_name": "NAG强度", "tooltip": "负向引导效果的强度"}),
                "nag_alpha": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.001, "display_name": "NAG混合系数", "tooltip": "控制归一化引导表示与原始正向表示之间平衡的混合系数"}),
                "nag_tau": ("FLOAT", {"default": 2.5, "min": 0.0, "max": 10.0, "step": 0.001, "display_name": "NAG阈值", "tooltip": "控制引导注意力与正向注意力偏差程度的裁剪阈值"}),
            },
            "optional": {
                "nag_cond_video": ("CONDITIONING", {"display_name": "视频条件", "tooltip": "视频条件输入，用于 NAG 引导"}),
                "nag_cond_audio": ("CONDITIONING", {"display_name": "音频条件", "tooltip": "音频条件输入，用于 NAG 引导"}),
                "inplace": ("BOOLEAN", {"default": True, "display_name": "就地修改", "tooltip": "如果为 True，则就地修改张量以节省内存。可能导致数值结果略有不同"}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "apply_nag"

    def apply_nag(self, model, nag_scale, nag_alpha, nag_tau, nag_cond_video=None, nag_cond_audio=None, inplace=True):
        if nag_scale == 0:
            return (model,)

        device = mm.get_torch_device()
        offload_device = mm.unet_offload_device()
        dtype = model.model.manual_cast_dtype
        if dtype is None:
            dtype = model.model.diffusion_model.dtype

        model_clone = model.clone()
        diffusion_model = model_clone.get_model_object("diffusion_model")
        img_dim = diffusion_model.inner_dim
        audio_dim = diffusion_model.audio_inner_dim

        context_video = context_audio = None

        if nag_cond_video is not None:
            context_video = nag_cond_video[0][0].to(device, dtype)
            vid_split = getattr(diffusion_model, "cross_attention_dim", None)
            if vid_split is not None and context_video.shape[-1] == vid_split + diffusion_model.audio_cross_attention_dim:
                context_video = context_video[:, :, :vid_split]
            if diffusion_model.caption_proj_before_connector and diffusion_model.caption_projection_first_linear:
                diffusion_model.caption_projection.to(device)
                context_video = diffusion_model.caption_projection(context_video)
                diffusion_model.caption_projection.to(offload_device)
            if hasattr(diffusion_model, "video_embeddings_connector"):
                diffusion_model.video_embeddings_connector.to(device)
                context_video = diffusion_model.video_embeddings_connector(context_video)[0]
                diffusion_model.video_embeddings_connector.to(offload_device)
            context_video = context_video.view(1, -1, img_dim)
            for idx, block in enumerate(diffusion_model.transformer_blocks):
                patched_attn2 = LTXVCrossAttentionPatch(context_video, nag_scale, nag_alpha, nag_tau, inplace=inplace).__get__(block.attn2, block.__class__)
                model_clone.add_object_patch(f"diffusion_model.transformer_blocks.{idx}.attn2.forward", patched_attn2)

        if nag_cond_audio is not None and diffusion_model.audio_caption_projection is not None:
            context_audio = nag_cond_audio[0][0].to(device, dtype)
            vid_split = getattr(diffusion_model, "cross_attention_dim", None)
            if vid_split is not None and context_audio.shape[-1] == vid_split + diffusion_model.audio_cross_attention_dim:
                context_audio = context_audio[:, :, vid_split:]
            if diffusion_model.caption_proj_before_connector and diffusion_model.caption_projection_first_linear:
                diffusion_model.audio_caption_projection.to(device)
                context_audio = diffusion_model.audio_caption_projection(context_audio)
                diffusion_model.audio_caption_projection.to(offload_device)
            if hasattr(diffusion_model, "audio_embeddings_connector"):
                diffusion_model.audio_embeddings_connector.to(device)
                context_audio = diffusion_model.audio_embeddings_connector(context_audio)[0]
                diffusion_model.audio_embeddings_connector.to(offload_device)
            context_audio = context_audio.view(1, -1, audio_dim)
            for idx, block in enumerate(diffusion_model.transformer_blocks):
                patched_audio_attn2 = LTXVCrossAttentionPatch(context_audio, nag_scale, nag_alpha, nag_tau, inplace=inplace).__get__(block.audio_attn2, block.__class__)
                model_clone.add_object_patch(f"diffusion_model.transformer_blocks.{idx}.audio_attn2.forward", patched_audio_attn2)

        return (model_clone,)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTX2NAG}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · LTX2 NAG"}
