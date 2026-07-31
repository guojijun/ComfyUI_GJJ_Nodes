"""ComfyUI-Krea2Edit — in-context edit forward for the Krea2 model.

ComfyUI's native Krea2 `_forward` is text-to-image only: it builds the sequence
`[text | target]`. The krea2_edit LoRA (trained in ai-toolkit) needs the *appearance
path*: the VAE-encoded SOURCE latent prepended as a block of clean tokens, distinguished
from the (noisy) target purely by the 3-axis RoPE frame index (source=1, target=0, h/w
aligned). This node adds that by wrapping the model's DIFFUSION_MODEL forward and rebuilding
the sequence as `[text | source(frame=1) | target(frame=0)]`, keeping only the target tokens
out — mirroring ai-toolkit's `predict_velocity_edit` exactly, using the model's own submodules.

Wiring:  LoadImage -> VAEEncode(source) --\
                                            Krea2EditModelPatch(model, source_latent) -> KSampler
         UNETLoader -> LoraLoaderModelOnly -/
KSampler.latent_image <- EmptySD3LatentImage (noise). Text: NATIVE krea2 CLIP + CLIPTextEncode.
"""
import math
import os

import folder_paths

import torch
import torch.nn.functional as F
from einops import rearrange

import comfy.patcher_extension
import comfy.sd
import comfy.utils
import comfy.ldm.common_dit
from comfy.ldm.flux.layers import timestep_embedding
from comfy.ldm.flux.math import apply_rope
from comfy.ldm.modules.attention import optimized_attention_masked


def _imgids(bs, frame, h_, w_, device):
    ids = torch.zeros(h_, w_, 3, device=device, dtype=torch.float32)
    ids[..., 0] = frame
    ids[..., 1] = torch.arange(h_, device=device, dtype=torch.float32)[:, None]
    ids[..., 2] = torch.arange(w_, device=device, dtype=torch.float32)[None, :]
    return ids.reshape(1, h_ * w_, 3).repeat(bs, 1, 1)


def _imgids_offset(bs, frame, gh, gw, th, tw, device):
    """Stride-1 integer positions at a centered integer offset. For `fit` refs the
    pixels are already resampled to target grid density, so the position grid is
    stride-1 BY CONSTRUCTION — scaling it again only manufactures skip/collision
    artifacts. Requires gh<=th, gw<=tw (guaranteed by the floor+cap in fit)."""
    off_h, off_w = max(0, (th - gh) // 2), max(0, (tw - gw) // 2)
    ids = torch.zeros(gh, gw, 3, device=device, dtype=torch.float32)
    ids[..., 0] = frame
    ids[..., 1] = (torch.arange(gh, device=device, dtype=torch.float32) + off_h)[:, None]
    ids[..., 2] = (torch.arange(gw, device=device, dtype=torch.float32) + off_w)[None, :]
    return ids.reshape(1, gh * gw, 3).repeat(bs, 1, 1)


def _to_4d(v):
    """(B,C,T,H,W) -> (B*T,C,H,W); pass 4D through. Images use T=1."""
    if v.ndim == 5:
        b, c, t, h, w = v.shape
        return v.reshape(b * t, c, h, w)
    return v


def _fit_src(src, H, W):
    """Fit a source latent to the target grid the way TRAINING did: center-crop to
    the target aspect ratio, then resize. A plain interpolate (the pre-fix behavior)
    STRETCHES mixed-AR sources — users saw stretched people whenever their input AR
    differed from the output resolution."""
    sh, sw = src.shape[-2:]
    if (sh, sw) == (H, W):
        return src
    s = max(H / sh, W / sw)
    ch, cw = min(sh, int(round(H / s))), min(sw, int(round(W / s)))
    y0, x0 = (sh - ch) // 2, (sw - cw) // 2
    src = src[..., y0:y0 + ch, x0:x0 + cw]
    return F.interpolate(src.float(), size=(H, W), mode="bilinear")


def _fit_encode_image(image, vae, H, W, cache, key, fit_mode="crop"):
    """Pixel-space source prep (blur-proof path): center-crop the IMAGE to the
    target AR, resize to the exact target pixel grid, VAE-encode. Latent-space
    resizing (the old fallback) softens VAE latents — this path never resizes
    latents at all. Cached per target resolution (encode once, not per step)."""
    key = key + (fit_mode,)
    if key in cache:
        return cache[key]
    print(f"[krea2edit] _fit_encode_image: mode={fit_mode} in={tuple(image.shape)} target_latent={H}x{W}", flush=True)
    px_h, px_w = H * 8, W * 8
    img = image.movedim(-1, 1)  # B,H,W,C -> B,C,H,W
    ih, iw = img.shape[-2:]
    if fit_mode == "fit":
        # "bilinear" answer to scale mismatch: resample CONTENT (pixel space, bicubic)
        # to the target's grid density instead of moving positions. AR-preserving
        # fit-inside, no crop, no grey canvas — the forward places it at an integer
        # centered offset (scaled-pos with s=1 -> stride 1, no rounding artifacts).
        sc = min(px_h / ih, px_w / iw)
        # NEAR-MATCHED AR: fill the target grid EXACTLY via a minimal center-crop.
        # Fit-inside margins of 1-2 tokens are not harmless: target edge columns
        # with no ref correspondence get filled by repeating adjacent ref content
        # (2026-07-14 edge-duplication bug: ref (74,54) vs target (74,56)).
        # This also restores the design promise fit == crop at matched AR.
        CROP_TOL = 0.08
        if ih * sc >= px_h * (1 - CROP_TOL) and iw * sc >= px_w * (1 - CROP_TOL):
            s = max(px_h / ih, px_w / iw)
            ch, cw = min(ih, int(round(px_h / s))), min(iw, int(round(px_w / s)))
            y0, x0 = (ih - ch) // 2, (iw - cw) // 2
            img = img[..., y0:y0 + ch, x0:x0 + cw]
            nh, nw = px_h, px_w
        else:
            # genuine AR mismatch: MUST match the trainer's _fit_prep EXACTLY
            # (krea2_edit.py) — /16 floor snap capped at the target's /16 floor.
            # The model is trained on this geometry; a /8-round node grid would
            # produce a different ref latent size -> different centered offset ->
            # a visible margin-boundary seam even from a well-trained model
            # (train/infer geometry must be byte-identical). 2026-07-15 alignment.
            nh = min(max(16, int(ih * sc) // 16 * 16), max(16, px_h // 16 * 16))
            nw = min(max(16, int(iw * sc) // 16 * 16), max(16, px_w // 16 * 16))
        img = F.interpolate(img.float(), size=(nh, nw), mode="bicubic", antialias=True)
        lat = vae.encode(img.movedim(1, -1)[..., :3].clamp(0, 1))
        cache[key] = lat
        return lat
    # crop (default / "v1 legacy"): center-crop to the target AR, then resize.
    s = max(px_h / ih, px_w / iw)
    ch, cw = min(ih, int(round(px_h / s))), min(iw, int(round(px_w / s)))
    y0, x0 = (ih - ch) // 2, (iw - cw) // 2
    img = img[..., y0:y0 + ch, x0:x0 + cw]
    img = F.interpolate(img.float(), size=(px_h, px_w), mode="bicubic", antialias=True)
    lat = vae.encode(img.movedim(1, -1)[..., :3].clamp(0, 1))
    cache[key] = lat
    return lat


def _ref_attn_bias(boosts, boost_mask, txtlen, slens, tgtlen, mask_hw, device, dtype):
    """Additive attention-logit bias on the [text | refs... | target] sequence.

    boosts: per-ref factor on target->ref attention, aligned with the source blocks
    (last entry = last ref = the subject by workflow convention). Equivalent to
    multiplying those keys' post-softmax attention weight before renormalization.
    boost_mask (ComfyUI MASK, ref-image pixel space) restricts the LAST ref's boost
    to a region (e.g. the face).
    """
    nsrc = len(slens)
    offs = [txtlen]
    for sl in slens:
        offs.append(offs[-1] + sl)
    rows0 = offs[-1]
    L = rows0 + tgtlen
    bias = torch.zeros(1, 1, L, L, device=device, dtype=dtype)
    for i, b in enumerate(boosts):
        if b == 1.0:
            continue
        off, sl = offs[i], slens[i]
        if boost_mask is not None and i == nsrc - 1 and mask_hw is not None:
            mask = boost_mask[:1]
            if mask.ndim == 2:
                mask = mask[None]
            mask = F.interpolate(mask[None].float(), size=mask_hw[i], mode="area")[0, 0]
            cols = off + torch.nonzero(mask.reshape(-1) > 0.5, as_tuple=True)[0].to(device)
        else:
            cols = torch.arange(off, off + sl, device=device)
        bias[:, :, rows0:, cols] = math.log(max(b, 1e-4))
    return bias


def krea2_edit_forward(m, x, timesteps, context, src_latent, transformer_options,
                       ref_boost=1.0, ref_boost_a=1.0, ref_boost_mask=None,
                       ref_native=False, pos_mode="anchor"):
    """Krea2 SingleStreamDiT._forward, but with source block(s) prepended.

    m           : the SingleStreamDiT (LoRA-patched at sample time)
    x           : (B,C,H,W) or (B,C,T,H,W) noisy TARGET latent
    src_latent  : clean SOURCE latent (VAE-encoded), 4D/5D — or a LIST of them
                  (multi-ref: [scene, subject], frames 1..N, training-matched)
    context     : (B, seq, txtlayers*txtdim) — the 12-layer Qwen3-VL stack
    """
    patch = m.patch

    # Mirror ComfyUI _forward: latents may arrive 5D (B,C,T,H,W) for this model.
    temporal = x.ndim == 5
    if temporal:
        b5, c5, t5, h5, w5 = x.shape
    x = _to_4d(x)
    bs, c, H_orig, W_orig = x.shape

    x = comfy.ldm.common_dit.pad_to_patch_size(x, (patch, patch), padding_mode="replicate")
    H, W = x.shape[-2], x.shape[-1]
    h_, w_ = H // patch, W // patch

    # source(s) -> (bs, C, H, W): flatten temporal, match batch, fit to the target grid
    # (center-crop to target AR then resize — training-matched; never stretch).
    src_list = src_latent if isinstance(src_latent, (list, tuple)) else [src_latent]
    srcs = []
    for sl in src_list:
        src = _to_4d(sl).to(x.device, x.dtype)
        if src.shape[0] != bs:
            src = src[:1].expand(bs, *src.shape[1:])
        if not ref_native and src.shape[-2:] != (H, W):
            print(f"[krea2edit] LATENT-PATH fit_src (crop): src={tuple(src.shape[-2:])} -> {H}x{W}", flush=True)
            src = _fit_src(src, H, W).to(x.dtype)
        srcs.append(comfy.ldm.common_dit.pad_to_patch_size(src, (patch, patch), padding_mode="replicate"))
    src_grids = [(s_.shape[-2] // patch, s_.shape[-1] // patch) for s_ in srcs]

    context = m._unpack_context(context)                       # (B, seq, 12, 2560)

    tgt_img = m.first(rearrange(x, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=patch, pw=patch))
    src_imgs = [m.first(rearrange(s_, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=patch, pw=patch))
                for s_ in srcs]

    t = m.tmlp(timestep_embedding(timesteps, m.tdim).unsqueeze(1).to(tgt_img.dtype))
    tvec = m.tproj(t)

    context = m.txtfusion(context, mask=None, transformer_options=transformer_options)
    context = m.txtmlp(context)

    txtlen, tgtlen = context.shape[1], tgt_img.shape[1]
    srclen = sum(si.shape[1] for si in src_imgs)
    combined = torch.cat([context] + src_imgs + [tgt_img], dim=1)  # [text | refs... | target]

    device = combined.device
    if pos_mode == "stride1" and ref_native:
        print(f"[krea2edit] STRIDE1-POS fit: ref grids {src_grids} centered in ({h_},{w_})", flush=True)
        if any(h_ - gh > 2 or w_ - gw > 2 for gh, gw in src_grids):
            print("[krea2edit] NOTE: fit margins >2 tokens (large source/output aspect-ratio "
                  "gap). fit is trained for matched/near-matched AR; for a big AR change "
                  "prefer 'crop', or set the output AR closer to the source.", flush=True)
        ref_ids = [_imgids_offset(bs, i + 1, gh, gw, h_, w_, device)
                   for i, (gh, gw) in enumerate(src_grids)]
    else:
        ref_ids = [_imgids(bs, i + 1, gh, gw, device) for i, (gh, gw) in enumerate(src_grids)]
    pos = torch.cat([
        torch.zeros(bs, txtlen, 3, device=device, dtype=torch.float32)]   # text @ 0
        + ref_ids
        + [_imgids(bs, 0, h_, w_, device)],                                    # target frame=0
        dim=1)
    freqs = m.pe_embedder(pos)

    attn_bias = None
    if ref_boost != 1.0 or ref_boost_a != 1.0:
        # last ref = subject (single-ref: the only ref); earlier refs (scene) get ref_boost_a
        boosts = [ref_boost_a] * (len(src_imgs) - 1) + [ref_boost]
        attn_bias = _ref_attn_bias(boosts, ref_boost_mask, txtlen,
                                   [si.shape[1] for si in src_imgs], tgtlen,
                                   src_grids, combined.device, combined.dtype)

    for block in m.blocks:
        combined = block(combined, tvec, freqs, attn_bias, transformer_options=transformer_options)

    final = m.last(combined, t)
    out = final[:, txtlen + srclen: txtlen + srclen + tgtlen, :]         # target tokens only
    out = rearrange(out, "b (h w) (c ph pw) -> b c (h ph) (w pw)",
                    h=h_, w=w_, ph=patch, pw=patch, c=m.channels)
    out = out[:, :, :H_orig, :W_orig]
    if temporal:
        out = out.reshape(b5, t5, m.channels, H_orig, W_orig).movedim(1, 2)
    return out



LORA_FILENAME = "krea2_identity_edit_v1_2.safetensors"
LORA_SEARCH_KEYWORDS = ("krea", "edit")
IMAGE_INPUT_TYPE = "IMAGE,GJJ_BATCH_IMAGE"


def _component_value(value, key):
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _nested_image_values(value):
    if value is None or torch.is_tensor(value) or isinstance(value, (str, bytes, bytearray)):
        return []
    if hasattr(value, "get_components"):
        try:
            components = value.get_components()
        except Exception:
            components = None
        if components is not None:
            return [
                _component_value(components, key)
                for key in ("images", "image", "frames", "frame", "batch", "samples", "items", "values")
                if _component_value(components, key) is not None
            ]
    if isinstance(value, dict):
        return [
            value[key]
            for key in ("images", "image", "frames", "frame", "batch", "samples", "items", "values")
            if key in value
        ]
    if isinstance(value, (list, tuple, set)):
        return list(value)
    result = []
    for key in ("images", "image", "frames", "frame", "batch", "samples", "items", "values"):
        item = getattr(value, key, None)
        if item is not None and item is not value:
            result.append(item)
    return result


def _normalize_image_tensor(value, label="输入图片"):
    tensor = value.detach()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim > 4 and int(tensor.shape[-1]) in (1, 2, 3, 4):
        tensor = tensor.reshape(-1, int(tensor.shape[-3]), int(tensor.shape[-2]), int(tensor.shape[-1]))
    if tensor.ndim != 4:
        raise RuntimeError(f"{label}必须是 IMAGE / GJJ_BATCH_IMAGE，实际张量维度为 {tuple(tensor.shape)}。")
    if int(tensor.shape[-1]) not in (1, 2, 3, 4) and int(tensor.shape[1]) in (1, 2, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 2:
        tensor = tensor[..., :1].repeat(1, 1, 1, 3)
    elif channels >= 4:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"{label}的通道数无效：{tuple(tensor.shape)}。")
    return tensor.float().clamp(0.0, 1.0).contiguous()


def _image_frames(value, label="输入图片"):
    if value is None:
        return []
    if torch.is_tensor(value):
        batch = _normalize_image_tensor(value, label)
        return [batch[index:index + 1].contiguous() for index in range(int(batch.shape[0]))]
    frames = []
    for item in _nested_image_values(value):
        frames.extend(_image_frames(item, label))
    return frames


def _first_input_value(value, default=None):
    current = value
    while isinstance(current, (list, tuple)) and len(current) == 1:
        current = current[0]
    if isinstance(current, (list, tuple)):
        return current[0] if current else default
    return default if current is None else current


def _matching_loras():
    matches = [
        str(name)
        for name in (folder_paths.get_filename_list("loras") or [])
        if all(keyword in str(name).lower() for keyword in LORA_SEARCH_KEYWORDS)
    ]
    return sorted(
        matches,
        key=lambda name: (
            os.path.basename(name).lower() != LORA_FILENAME.lower(),
            name.count("/") + name.count("\\"),
            name.lower(),
        ),
    )


def _resolve_required_lora():
    matches = _matching_loras()
    if not matches:
        keywords = ",".join(LORA_SEARCH_KEYWORDS)
        raise FileNotFoundError(
            f"未找到名称同时包含关键词 {keywords} 的 Krea2 编辑 LoRA。"
            "请放入 ComfyUI/models/loras（可位于任意子目录）后刷新模型列表。"
        )
    selected = matches[0]
    path = folder_paths.get_full_path("loras", selected)
    if not path:
        raise FileNotFoundError(f"已发现 LoRA 名称但无法解析文件路径：{selected}")
    return path


class GJJ_Krea2EditModelPatch:
    DESCRIPTION = "零外部节点依赖的 Krea2 图像编辑模型补丁：递归拆分输入图片、内部加载固定身份编辑 LoRA，并注入多参考图编辑路径。"
    CATEGORY = "GJJ/🧠 模型/补丁"
    FUNCTION = "patch"
    INPUT_IS_LIST = True
    RETURN_TYPES = ("MODEL", "VAE")
    RETURN_NAMES = ("已补丁模型", "VAE")
    OUTPUT_TOOLTIPS = (
        "已加载身份编辑 LoRA 并注入 Krea2 图像编辑 forward 的模型，可直接连接采样器。",
        "面板选择并由节点内部加载的 VAE，可直接连接 VAE 解码节点。",
    )

    GJJ_HELP = {
        "说明": "复刻 Krea2EditModelPatch 的核心模型 forward，并兼容 ComfyUI 新旧扩散模型调用签名。",
        "模型": "连接外部 Krea2 MODEL，节点内部仅应用身份编辑 LoRA 和扩散 forward 补丁。",
        "VAE": "连接外部配套 VAE；节点内部用它逐张编码参考图，并原样输出供最终解码。",
        "图片": "输入类型为 IMAGE,GJJ_BATCH_IMAGE。普通 IMAGE batch、嵌套列表、字典和 GJJ 批图容器都会递归解包；每一张图片作为独立参考图。",
        "LoRA": "LoRA 列表会递归搜索 models/loras，并显示名称中同时包含 krea、edit 的模型。",
        "零依赖": "不导入 comfyui-krea2edit，也不需要安装其他自定义节点；仅使用 ComfyUI 自带运行库。",
        "建议": "参考图与目标图宽高比接近时优先使用“适配”；旧版权重或需要中心裁切构图时使用“裁切（旧版）”。",
    }

    @classmethod
    def INPUT_TYPES(cls):
        lora_names = _matching_loras()
        if not lora_names:
            lora_names = [LORA_FILENAME]
        return {
            "required": {
                "model": ("MODEL", {
                    "display_name": "Krea2 模型",
                    "tooltip": "连接外部加载的 Krea2 MODEL。请勿提前重复加载面板所选的身份编辑 LoRA。",
                }),
                "vae": ("VAE", {
                    "display_name": "Krea2 VAE",
                    "tooltip": "连接 Krea2 配套 VAE。节点内部用它编码全部参考图，并将其原样输出供最终解码。",
                }),
                "source_image": (IMAGE_INPUT_TYPE, {
                    "display_name": "源图片",
                    "tooltip": "支持 IMAGE、GJJ_BATCH_IMAGE 与嵌套批图；所有图片都会递归拆成单图，并在节点内部完成 VAE 编码。",
                }),
                "lora_name": (lora_names, {
                    "display_name": "身份编辑 LoRA",
                    "tooltip": "模糊搜索名称中同时包含 krea、edit 的 LoRA，支持任意 LoRA 子目录。",
                }),
                "lora_strength": ("FLOAT", {
                    "default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01,
                    "display_name": "LoRA 强度",
                    "tooltip": f"{LORA_FILENAME} 的模型强度；1.0 为原始训练强度。",
                }),
                "fit_mode": (["适配", "裁切（旧版）"], {
                    "default": "适配",
                    "display_name": "图片适配方式",
                    "tooltip": "适配：保持宽高比并按训练几何放置；裁切（旧版）：中心裁切到目标宽高比后缩放。",
                }),
                "reference_strength": ("FLOAT", {
                    "default": 4.0, "min": 0.0, "max": 1000.0, "step": 0.01,
                    "display_name": "主参考强度",
                    "tooltip": "目标对最后一张参考图的注意力倍率。1.0 不额外增强，大于 1 更贴近参考。",
                }),
                "earlier_reference_strength": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1000.0, "step": 0.01,
                    "display_name": "前序参考强度",
                    "tooltip": "多图时对最后一张之前所有参考图的注意力倍率；单图时不生效。",
                }),
            },
        }

    def patch(
        self,
        model,
        vae,
        source_image,
        lora_name=LORA_FILENAME,
        lora_strength=1.0,
        fit_mode="适配",
        reference_strength=4.0,
        earlier_reference_strength=1.0,
    ):
        model = _first_input_value(model)
        vae = _first_input_value(vae)
        lora_name = _first_input_value(lora_name, LORA_FILENAME)
        lora_strength = float(_first_input_value(lora_strength, 1.0))
        fit_mode = _first_input_value(fit_mode, "适配")
        reference_strength = float(_first_input_value(reference_strength, 4.0))
        earlier_reference_strength = float(_first_input_value(earlier_reference_strength, 1.0))
        if model is None:
            raise RuntimeError("没有收到可用的 Krea2 MODEL。")
        if vae is None:
            raise RuntimeError("没有收到可用的 Krea2 VAE。")
        frames = _image_frames(source_image, "源图片")
        if not frames:
            raise RuntimeError("源图片中没有可用的单张 IMAGE。")
        if len(frames) > 2:
            raise RuntimeError(
                f"Krea2 身份编辑最多支持两张参考图，递归拆包后收到 {len(frames)} 张。"
                "请只保留需要使用的参考图 A 和参考图 B。"
            )

        lora_path = folder_paths.get_full_path("loras", lora_name)
        if not lora_path:
            lora_path = _resolve_required_lora()
        lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
        patched_model, _ = comfy.sd.load_lora_for_models(
            model, None, lora, float(lora_strength), 0.0
        )
        m = patched_model.clone()
        pixel_cache = {}
        model_inner = m.model
        mode = "fit" if fit_mode == "适配" else "crop"

        def wrapper(executor, x, timesteps, context, *wargs, **kwargs):
            transformer_options = kwargs.pop("transformer_options", None)
            if transformer_options is None:
                transformer_options = {}
                for argument in reversed(wargs):
                    if isinstance(argument, dict):
                        transformer_options = argument
                        break

            target = _to_4d(x)
            height, width = target.shape[-2:]
            sources = []
            for index, frame in enumerate(frames):
                latent = _fit_encode_image(
                    frame, vae, height, width, pixel_cache,
                    ("reference", index, height, width), mode,
                )
                sources.append(model_inner.process_latent_in(latent))

            return krea2_edit_forward(
                executor.class_obj,
                x,
                timesteps,
                context,
                sources,
                transformer_options,
                ref_boost=float(reference_strength),
                ref_boost_a=float(earlier_reference_strength),
                ref_native=(mode == "fit"),
                pos_mode=("stride1" if mode == "fit" else "anchor"),
            )

        transformer_options = m.model_options.setdefault("transformer_options", {})
        comfy.patcher_extension.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
            "gjj_krea2_identity_edit",
            wrapper,
            transformer_options,
        )
        return m, vae


NODE_CLASS_MAPPINGS = {
    "GJJ_Krea2EditModelPatch": GJJ_Krea2EditModelPatch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_Krea2EditModelPatch": "GJJ · Krea2身份编辑模型补丁",
}
