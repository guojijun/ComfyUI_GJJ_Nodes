"""LTX-2.3 Identity OVERLAP — 100%-exact replica of ltx-trainer's overlap+source_phase reference.

Unlike the append_keyframe path (which makes the ref an I2V first-frame), this injects the
reference 潜空间 as SEPARATE tokens that share the target's frame-0 RoPE grid (overlap) and
are tagged with a per-source RoPE phase (source_phase), exactly as the ltx-trainer flexible
strategy did at train/validation time. The ref tokens are clean (timestep 0), attend to the
target in self-attention, and are sliced off the output (never rendered).

Model patch (installed idempotently on the LTX av_model), matching LTXBaseModel._forward:
  1) _process_input  : append ref video tokens (patchified ref 潜空间) with overlap positions;
  2) _prepare_positional_embeddings : rotate the ref tokens' RoPE freqs by source_phase;
  3) _prepare_timestep : give the ref tokens clean (0) timestep;
  4) _process_output : trim the ref tokens before unpatchify.
Plus the ArcFace IdentityProjector tokens on the text context (as trained).

Load the matching LoRA on MODEL first.
Set LTX_IDOVERLAP_DEBUG=1 to log shapes at each patch point for iteration.
"""
import logging
import os
import types

import numpy as np
import torch
import torch.nn.functional as F

log = logging.getLogger("LTXIdentityOverlap")
_USE_GPU = os.environ.get("LTX_IDPROJ_ARCFACE_GPU", "0") == "1"
_FACE_APP = None


def _shape(x):
    """Readable shape/structure of tensors, lists, tuples, CompressedTimestep, etc."""
    try:
        if hasattr(x, "shape"):
            return f"T{tuple(x.shape)}"
        if isinstance(x, (list, tuple)):
            return f"{type(x).__name__}[{', '.join(_shape(i) for i in x)}]"
        return type(x).__name__
    except Exception:
        return "?"


# Per-step debug logging. Off by default; toggled by the node's `调试日志` input
# (env var LTX_IDOVERLAP_DEBUG=1 sets the initial value).
_DEBUG_ENABLED = os.environ.get("LTX_IDOVERLAP_DEBUG", "0") == "1"


def _dbg(*a):
    if _DEBUG_ENABLED:
        print("[LTXIdOverlap] " + " ".join(str(x) for x in a), flush=True)


# ---------------- source_phase RoPE (port of ltx_core rope.apply_segment_phase) ----------------
def _rotate_ref_block(pe, start, length, seg_value, theta=10000.0):
    """为指定参考令牌叠加 source_phase，并兼容新旧 ComfyUI RoPE 表示。"""
    if length <= 0 or seg_value == 0.0:
        return pe

    # ComfyUI 0.28+：pe = (rotation_matrix, split_mode)，第二项是 bool。
    # rotation_matrix 的结构为 [B, T, heads, dims_per_head, 2, 2]。
    if (
        isinstance(pe, (list, tuple))
        and len(pe) >= 2
        and torch.is_tensor(pe[0])
        and isinstance(pe[1], bool)
        and pe[0].dim() >= 6
        and tuple(pe[0].shape[-2:]) == (2, 2)
    ):
        rotation = pe[0]
        rest = tuple(pe[1:])
        token_count = int(rotation.shape[1])
        block_start = max(0, min(int(start), token_count))
        block_end = max(block_start, min(block_start + int(length), token_count))
        if block_end <= block_start:
            return pe

        frequency_shape = tuple(rotation.shape[2:-2])
        # 旧版 split RoPE 的 cos/sin 为 [B, heads, T, dims_per_head]，
        # _rotate_ref_block 只沿最后的 dims_per_head 生成相位，并在所有 head 上复用。
        # 新版矩阵是 [B, T, heads, dims_per_head, 2, 2]，因此不能把 heads
        # 与 dims_per_head 展平，否则不同 head 会获得不同相位，生成结果会完全改变。
        frequency_count = int(frequency_shape[-1])
        d = torch.arange(frequency_count, device=rotation.device, dtype=torch.float32)
        phase = float(seg_value) * (
            float(theta) ** (-d / float(max(1, frequency_count)))
        )
        phase_broadcast_shape = (
            1, 1, *([1] * (len(frequency_shape) - 1)), frequency_count
        )
        phase = phase.reshape(phase_broadcast_shape)
        pc = phase.cos().to(dtype=rotation.dtype)
        ps = phase.sin().to(dtype=rotation.dtype)
        phase_matrix = torch.stack((pc, -ps, ps, pc), dim=-1)
        phase_matrix = phase_matrix.reshape((*phase_broadcast_shape, 2, 2))

        rotated = rotation.clone()
        rotated[:, block_start:block_end] = torch.matmul(
            rotation[:, block_start:block_end],
            phase_matrix,
        )
        _dbg(
            "rotate matrix ref block: start", block_start,
            "length", block_end - block_start,
            "seg", seg_value,
        )
        return (rotated, *rest)

    # 旧版 ComfyUI：pe = (cos, sin, ...)，令牌轴位于倒数第二维。
    if (
        not isinstance(pe, (list, tuple))
        or len(pe) < 2
        or not torch.is_tensor(pe[0])
        or not torch.is_tensor(pe[1])
    ):
        raise RuntimeError(
            "无法识别当前 ComfyUI 的 LTX RoPE 数据结构："
            f"{type(pe).__name__}。请更新 GJJ 节点或使用兼容的 ComfyUI LTX 版本。"
        )

    cos, sin = pe[0], pe[1]
    rest = tuple(pe[2:])
    L = cos.shape[-1]
    d = torch.arange(L, device=cos.device, dtype=torch.float32)
    rate = theta ** (-d / float(L))                      # (0,1], high-freq carries the tag
    phase = (seg_value * rate)                           # [L]
    pc = phase.cos().to(cos.dtype); ps = phase.sin().to(sin.dtype)
    # index the token axis (=-2)
    idx = [slice(None)] * cos.dim()
    idx[-2] = slice(start, start + length)
    idx = tuple(idx)
    c0, s0 = cos[idx], sin[idx]
    cos = cos.clone(); sin = sin.clone()
    cos[idx] = c0 * pc - s0 * ps
    sin[idx] = s0 * pc + c0 * ps
    _dbg("rotate ref block: L", L, "start", start, "length", length, "seg", seg_value)
    return (cos, sin, *rest)


# ---------------- 模型 patches (idempotent, on the av_model instance) ----------------
def _find_ltxv(模型):
    """解开 ComfyUI MODEL / ModelPatcherDynamic，取得真正的 LTX 扩散模型。"""
    current = 模型
    visited = set()
    chain = []

    for _ in range(8):
        if current is None or id(current) in visited:
            break
        visited.add(id(current))
        chain.append(type(current).__name__)

        if all(
            hasattr(current, name)
            for name in (
                "_process_input",
                "_prepare_timestep",
                "_prepare_positional_embeddings",
                "_process_output",
            )
        ):
            return current

        next_object = None
        for attribute in ("diffusion_model", "model"):
            candidate = getattr(current, attribute, None)
            if candidate is not None and candidate is not current:
                next_object = candidate
                break
        if next_object is None:
            break
        current = next_object

    path = " → ".join(chain) or type(模型).__name__
    raise RuntimeError(
        "LTX身份重叠条件无法定位支持参考令牌补丁的 LTX 扩散模型。"
        f"当前模型解包路径：{path}。请连接 ComfyUI 原生 LTX / LTX-AV MODEL；"
        "其他模型架构或未完整加载的模型包装器不受支持。"
    )


def _letterbox_resize(ref_img, tgt_w, tgt_h, pad_value=1.0):
    """Resize `ref_img` ([B,H,W,C]) to fit ENTIRELY inside tgt_w x tgt_h, preserving its own
    aspect ratio (no crop, no distortion), padding the leftover space with `pad_value`
    (default white, matching the composite sheet's own white background). Unlike
    common_upscale(..., crop="center") -- which center-crops to the target aspect ratio
    BEFORE resizing, silently discarding whatever isn't in the middle of the source image --
    this never discards any pixel of the reference."""
    import comfy.utils
    x = ref_img.movedim(-1, 1)  # [B,C,H,W]
    _, _, src_h, src_w = x.shape
    scale = min(tgt_w / src_w, tgt_h / src_h)
    new_w, new_h = max(1, round(src_w * scale)), max(1, round(src_h * scale))
    resized = comfy.utils.common_upscale(x, new_w, new_h, "bilinear", "disabled")
    pad_w, pad_h = tgt_w - new_w, tgt_h - new_h
    left, top = pad_w // 2, pad_h // 2
    right, bottom = pad_w - left, pad_h - top
    padded = F.pad(resized, (left, right, top, bottom), mode="constant", value=pad_value)
    return padded.movedim(1, -1)


def _anchored_crop_resize(ref_img, tgt_w, tgt_h, anchor="center"):
    """Like comfy.utils.common_upscale(..., crop="center") but with a configurable anchor
    for WHICH part of the source survives the crop when the aspect ratio doesn't match,
    instead of always the exact center (e.g. anchor="top" keeps the top of the sheet --
    useful when the face closeup panel isn't centered in your 布局模式). Returns the
    cropped+resized image plus the crop box (x0, y0, crop_w, crop_h) in SOURCE pixel
    coords, for drawing a preview overlay."""
    import comfy.utils
    x_img = ref_img.movedim(-1, 1)  # [B,C,H,W]
    _, _, old_h, old_w = x_img.shape
    old_aspect = old_w / old_h
    new_aspect = tgt_w / tgt_h
    x0, y0, crop_w, crop_h = 0, 0, old_w, old_h
    if old_aspect > new_aspect:
        # source wider than target -- crop width
        crop_w = max(1, round(old_w * (new_aspect / old_aspect)))
        if anchor == "left":
            x0 = 0
        elif anchor == "right":
            x0 = old_w - crop_w
        else:
            x0 = (old_w - crop_w) // 2
    elif old_aspect < new_aspect:
        # source taller than target -- crop height
        crop_h = max(1, round(old_h * (old_aspect / new_aspect)))
        if anchor == "top":
            y0 = 0
        elif anchor == "bottom":
            y0 = old_h - crop_h
        else:
            y0 = (old_h - crop_h) // 2
    cropped = x_img[:, :, y0:y0 + crop_h, x0:x0 + crop_w]
    out = comfy.utils.common_upscale(cropped, tgt_w, tgt_h, "bilinear", "disabled")
    return out.movedim(1, -1), (x0, y0, crop_w, crop_h)


def _draw_crop_overlay(ref_img, box):
    """Original reference with a green rectangle around the region that SURVIVES the crop
    (everything outside the rectangle gets discarded). box = (x0, y0, w, h) in source pixel
    coords, e.g. from _anchored_crop_resize. If box covers the whole image (no crop, as in
    letterbox/native_resolution modes), the rectangle just outlines the full frame."""
    from PIL import Image, ImageDraw
    x0, y0, cw, ch = box
    arr = (ref_img[0, :, :, :3].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
    pil = Image.fromarray(arr).convert("RGB")
    draw = ImageDraw.Draw(pil)
    w, h = pil.size
    lw = max(2, min(w, h) // 150)
    draw.rectangle([x0, y0, x0 + cw - 1, y0 + ch - 1], outline=(0, 255, 0), width=lw)
    out = torch.from_numpy(np.array(pil).astype(np.float32) / 255.0).unsqueeze(0)
    return out


# Seconds reserved per numbered strata slot -- MUST match ltx_trainer's
# training_strategies.tass.STRATA_SLOT_WIDTH for a strata-trained checkpoint's RoPE
# convention to line up at inference. Slot 0 (1st ref in the batch) lands at
# target_max_t + this value, slot 1 (2nd ref) at target_max_t + 2*this value, etc. --
# dynamic/target-relative, same as st_drc's own shift, so it stays correct for whatever
# video length is actually generated.
# CHANGED 2026-07-18 (0.5 -> 1.5): 0.5 caused a real slot0/slot1 collision -- a single-frame
# reference image (fps=1.0 convention) spans a full 1.0-SECOND range on the T axis, not a
# point, so width=0.5 let adjacent slots overlap. See tass.py's STRATA_SLOT_WIDTH docstring.
# Any checkpoint trained before this fix (e.g. phantom_stacked_r128/_p2) learned under the
# collided geometry; continuing training from one now adapts to the corrected spacing.
STRATA_SLOT_WIDTH = 1.5


def _apply_tass_layout(reference_positions, target_positions, 布局模式: str, strata_start: float | None = None):
    """Place reference pixel-coords in a non-overlapping TASS region -- mirrors
    ltx_trainer.training_strategies.tass.apply_tass_layout (kept in sync manually since this
    node can't import the trainer package), adapted to ComfyUI's own coordinate tensor shape
    [B, 3 (T/H/W), N] (one corner coordinate per token) instead of the trainer's [B, 3, N, 2]
    patch-bounds shape -- the shifts only need min/max per axis either way.
    布局模式='overlap' returns the input unchanged.
    布局模式='st_drc' shifts every axis (T, H, W) past the target's own extent.
    布局模式='strata' shifts ONLY the T axis to an absolute band start (`strata_start`, in the
    same raw pixel/frame units as `reference_positions` -- caller converts from seconds using
    the 模型's frame_rate), leaving H/W overlapping the target -- see STRATA_SLOT_WIDTH.
    """
    if 布局模式 == "overlap":
        return reference_positions
    if 布局模式 == "st_drc":
        target_extent = target_positions.amax(dim=2, keepdim=True)
        reference_origin = reference_positions.amin(dim=2, keepdim=True)
        return reference_positions + (target_extent - reference_origin)
    if 布局模式 == "strata":
        if strata_start is None:
            raise ValueError("布局模式='strata' requires strata_start")
        shifted = reference_positions.clone()
        ref_origin_t = shifted[:, 0:1, :].amin(dim=2, keepdim=True)
        shifted[:, 0:1, :] = shifted[:, 0:1, :] + (strata_start - ref_origin_t)
        return shifted
    raise ValueError(f"Unsupported TASS 布局模式 {布局模式!r}")


def _install_patches(ltxv):
    if getattr(ltxv, "_id_overlap_patched", False):
        return
    orig_process_input = ltxv._process_input
    orig_prepare_ts = ltxv._prepare_timestep
    orig_prepare_pe = ltxv._prepare_positional_embeddings
    orig_process_output = ltxv._process_output
    orig_forward_internal = getattr(ltxv, "_forward", None)
    try:
        import comfy.ldm.lightricks.model as _ltx_model_module

        # 新版 ComfyUI 使用 rotation_matrix + 联合量化 RoPE 内核；BFS 原版所在的
        # 旧版 ComfyUI 使用 cos/sin + 纯 PyTorch 且分别处理 Q/K。为复现原版结果，
        # 只在此补丁模型的单次前向期间启用新版内置的纯 PyTorch兼容路径。
        force_original_rope_path = hasattr(_ltx_model_module, "freqs_cis_matrix")
    except Exception:
        force_original_rope_path = False

    if orig_forward_internal is not None:
        def _forward_capture_fps(self, x, timestep, context, attention_mask, frame_rate=25,
                                  transformer_options={}, keyframe_idxs=None, denoise_mask=None, **kwargs):
            # _forward calls _process_input BEFORE _prepare_positional_embeddings (the only
            # other place frame_rate normally reaches) -- process_input needs it EARLIER, to
            # convert the seconds-scale STRATA_SLOT_WIDTH into this step's raw pixel/frame
            # units. Stash here so it's always current, never a step behind.
            self._id_frame_rate = float(frame_rate)
            if not force_original_rope_path:
                return orig_forward_internal(
                    x, timestep, context, attention_mask, frame_rate=frame_rate,
                    transformer_options=transformer_options, keyframe_idxs=keyframe_idxs,
                    denoise_mask=denoise_mask, **kwargs,
                )

            import comfy.model_management

            previous_training_state = bool(comfy.model_management.in_training)
            comfy.model_management.in_training = True
            try:
                return orig_forward_internal(
                    x, timestep, context, attention_mask, frame_rate=frame_rate,
                    transformer_options=transformer_options, keyframe_idxs=keyframe_idxs,
                    denoise_mask=denoise_mask, **kwargs,
                )
            finally:
                comfy.model_management.in_training = previous_training_state
        ltxv._forward = types.MethodType(_forward_capture_fps, ltxv)

    def process_input(self, x, keyframe_idxs, denoise_mask, **kw):
        # Reset per-forward state first so a stale value from a previous run can never leak
        # into this forward (e.g. if ref specs stop arriving after a Comfy update).
        self._id_ref_len = 0
        self._id_blocks = []
        out = orig_process_input(x, keyframe_idxs, denoise_mask, **kw)
        ref_specs = kw.get("_id_ref_specs")
        if ref_specs is None:
            ref_specs = (kw.get("transformer_options") or {}).get("_id_ref_specs")
        if not ref_specs:
            return out
        try:
            from comfy.ldm.lightricks.model import latent_to_pixel_coords
            xx, pix, add = out
            is_av = isinstance(xx, (list, tuple))
            vx = xx[0] if is_av else xx
            vco = pix[0] if is_av else pix
            target_len = vx.shape[1]
            self._id_target_len = target_len
            frame_rate = float(getattr(self, "_id_frame_rate", 25.0))
            # Raw pixel/frame units (pre frame_rate-division -- that happens later inside
            # _prepare_positional_embeddings) -- convert to seconds only for the strata math,
            # then back, since STRATA_SLOT_WIDTH is calibrated in seconds on the trainer side.
            target_max_t_raw = float(vco[:, 0, :].amax().item())
            _dbg("process_input IN: is_av", is_av, "| vx", _shape(vx), "| vco", _shape(vco),
                 "| n_refs", len(ref_specs), "| frame_rate", frame_rate)
            blocks = []  # (start, length, seg_value) per ref, in concatenation order
            offset = target_len
            for spec in ref_specs:
                ref_lat = spec["latent"]
                rt, rlc = self.patchifier.patchify(ref_lat.to(dtype=vx.dtype, device=vx.device))
                rpc = latent_to_pixel_coords(latent_coords=rlc, scale_factors=self.vae_scale_factors,
                                             causal_fix=self.causal_temporal_positioning)
                # downscale_factor: this ref was VAE-encoded at target_size/downscale_factor,
                # so its raw pixel-coords only span that smaller extent. Multiply the H/W axes
                # back up by downscale_factor to re-stretch them across the target's actual
                # coordinate range (fewer tokens, same spatial span) -- mirrors ltx_core's
                # VideoConditionByReferenceLatent.apply_to (positions[:,1:3,...] *= downscale_factor).
                dsf = spec.get("downscale_factor", 1)
                if dsf != 1:
                    rpc = rpc.clone()
                    rpc[:, 1, ...] *= dsf
                    rpc[:, 2, ...] *= dsf
                strata_start_raw = None
                if spec["layout"] == "strata":
                    slot = int(spec["strata_slot"])
                    strata_start_sec = target_max_t_raw / frame_rate + (slot + 1) * STRATA_SLOT_WIDTH
                    strata_start_raw = strata_start_sec * frame_rate
                rpc = _apply_tass_layout(rpc, vco, spec["layout"], strata_start=strata_start_raw)
                rt = self.patchify_proj(rt)
                if rt.shape[0] != vx.shape[0]:
                    rt = rt.expand(vx.shape[0], -1, -1)
                if rpc.shape[0] != vco.shape[0]:
                    rpc = rpc.expand(vco.shape[0], *([-1] * (rpc.dim() - 1)))
                rlen = rt.shape[1]
                vx = torch.cat([vx, rt], dim=1)
                vco = torch.cat([vco, rpc.to(vco)], dim=2)
                blocks.append((offset, rlen, float(spec["seg_value"])))
                offset += rlen
            ref_len = offset - target_len
            self._id_ref_len = ref_len
            self._id_blocks = blocks
            add = dict(add); add["_id_ref_len"] = ref_len
            _dbg("process_input OUT: blocks", blocks, "| target_len", target_len,
                 "| vx", _shape(vx), "| vco", _shape(vco))
            if is_av:
                xx = [vx, xx[1]]; pix = [vco, pix[1]]
            else:
                xx, pix = vx, vco
            return xx, pix, add
        except Exception as e:
            _dbg("ERROR process_input:", repr(e), "| out", _shape(out), "| n_refs", len(ref_specs) if ref_specs else 0)
            raise

    def prepare_timestep(self, timestep, batch_size, hidden_dtype, **kw):
        # Give the ref tokens clean (0) timestep by editing the timestep INPUT before the
        # 模型's per-frame compression/adaln (mirrors the audio-ref path in av_model).
        # Use ONLY the instance attribute, not kw["_id_ref_len"] — when multi-angle patches
        # are also installed, their process_input sets kw["_id_ref_len"] which we must NOT
        # consume here (that would double-extend the timestep and cause shape mismatches).
        ref_len = getattr(self, "_id_ref_len", 0)
        if ref_len:
            target_len = getattr(self, "_id_target_len", None)
            if timestep.dim() <= 1 and target_len is not None:
                timestep = timestep.view(-1, 1).expand(batch_size, target_len).contiguous()
            if timestep.dim() >= 2 and target_len is not None:
                cur = timestep.shape[1]
                _gm0 = kw.get("grid_mask")
                _full = _gm0.shape[-1] if (_gm0 is not None and hasattr(_gm0, "shape")) else None
                if _full is not None and cur == _full:
                    # Per-token timestep spans the grid-mask domain (video + IC-LoRA guide
                    # tokens, indexed later via timestep[:, grid_mask]). Do NOT trim — append
                    # ref zeros and let the grid_mask pad below keep everything in lockstep.
                    ref_ts = torch.zeros(batch_size, ref_len, *timestep.shape[2:], device=timestep.device, dtype=timestep.dtype)
                    timestep = torch.cat([timestep, ref_ts], dim=1)
                    _dbg("prepare_timestep: grid-domain cur", cur, "-> appended ref", ref_len)
                elif cur > target_len + ref_len:
                    _dbg("prepare_timestep: oversized", cur, "-> trimming to video-only", target_len)
                    timestep = timestep[:, :target_len]
                    cur = target_len
                if (_full is None or timestep.shape[1] != _full + ref_len) and cur == target_len:
                    ref_ts = torch.zeros(batch_size, ref_len, *timestep.shape[2:], device=timestep.device, dtype=timestep.dtype)
                    timestep = torch.cat([timestep, ref_ts], dim=1)
                    _dbg("prepare_timestep: ref_len", ref_len, "| timestep ->", _shape(timestep), "| target_len", target_len)
                else:
                    _dbg("prepare_timestep: skip (cur", cur, "!= target", target_len, ")")
                # Guide nodes (IC-LoRA Guide / Director Guide, etc.) inject a grid_mask that
                # FILTERS x tokens in _process_input (x = x[:, grid_mask]) and later indexes the
                # timestep (timestep[:, grid_mask]). Our ref tokens are appended AFTER that
                # filter, so extend the mask with True for them — keeps modulation and vx in
                # lockstep (False would drop our clean timesteps and desync again).
                gm = kw.get("grid_mask")
                if gm is not None and hasattr(gm, "shape"):
                    gap = timestep.shape[1] - gm.shape[-1]
                    if 0 < gap <= ref_len:
                        pad = torch.ones(*gm.shape[:-1], gap, dtype=gm.dtype, device=gm.device)
                        kw = dict(kw); kw["grid_mask"] = torch.cat([gm, pad], dim=-1)
                        _dbg("prepare_timestep: grid_mask extended by", gap)
        return orig_prepare_ts(timestep, batch_size, hidden_dtype, **kw)

    def prepare_pe(self, pixel_coords, frame_rate, x_dtype):
        pe = orig_prepare_pe(pixel_coords, frame_rate, x_dtype)
        blocks = getattr(self, "_id_blocks", [])
        theta = getattr(self, "_id_rope_theta", 10000.0)
        if not blocks:
            return pe
        try:
            _dbg("prepare_pe IN: pe struct", _shape(pe), "| blocks", blocks)

            def rot(v_pe):
                for start, length, seg in blocks:
                    v_pe = _rotate_ref_block(v_pe, start, length, seg, theta)
                return v_pe

            # av returns [(v_pe, av_cross_video), (a_pe, av_cross_audio)]; v_pe = (cos, sin, split).
            if isinstance(pe, list) and len(pe) and isinstance(pe[0], (list, tuple)) and isinstance(pe[0][0], (list, tuple)):
                v_pe, cross_v = pe[0][0], pe[0][1]
                v_pe = rot(v_pe)
                pe = [(v_pe, cross_v), pe[1]]
            else:
                pe = rot(pe)
            return pe
        except Exception as e:
            _dbg("ERROR prepare_pe:", repr(e), "| pe", _shape(pe))
            raise

    def process_output(self, x, embedded_timestep, keyframe_idxs, **kw):
        ref_len = getattr(self, "_id_ref_len", 0)
        if ref_len:
            try:
                from comfy.ldm.lightricks.av_model import CompressedTimestep
                _dbg("process_output IN: x", _shape(x), "| et", _shape(embedded_timestep), "| ref_len", ref_len)
                # trim ref tokens from the video stream
                if isinstance(x, (list, tuple)):
                    x = [x[0][:, :x[0].shape[1] - ref_len], *x[1:]]
                    import copy
                    et_list = list(embedded_timestep) if isinstance(embedded_timestep, (list, tuple)) else [embedded_timestep]
                    v_et = et_list[0]
                    if isinstance(v_et, CompressedTimestep):
                        # clone + edit slots directly (version-agnostic; some builds lack per_frame kwarg)
                        ppf = max(1, getattr(v_et, "patches_per_frame", 1) or 1)
                        n_ref_frames = max(1, ref_len // ppf)
                        v_et2 = copy.copy(v_et)
                        v_et2.data = v_et.data[:, : v_et.num_frames - n_ref_frames].contiguous()
                        v_et2.num_frames = v_et.num_frames - n_ref_frames
                        et_list[0] = v_et2
                    elif hasattr(v_et, "shape") and v_et.dim() >= 2 and v_et.shape[1] > 1:
                        et_list[0] = v_et[:, : v_et.shape[1] - ref_len]
                    embedded_timestep = et_list
                else:
                    x = x[:, :x.shape[1] - ref_len]
                    if hasattr(embedded_timestep, "shape") and embedded_timestep.dim() >= 2 and embedded_timestep.shape[1] > 1:
                        embedded_timestep = embedded_timestep[:, : embedded_timestep.shape[1] - ref_len]
                _dbg("process_output: trimmed -> x", _shape(x), "| et", _shape(embedded_timestep))
            except Exception as e:
                _dbg("ERROR process_output:", repr(e), "| x", _shape(x), "| et", _shape(embedded_timestep))
                raise
        return orig_process_output(x, embedded_timestep, keyframe_idxs, **kw)

    ltxv._process_input = types.MethodType(process_input, ltxv)
    ltxv._prepare_timestep = types.MethodType(prepare_timestep, ltxv)
    ltxv._prepare_positional_embeddings = types.MethodType(prepare_pe, ltxv)
    ltxv._process_output = types.MethodType(process_output, ltxv)
    ltxv._id_overlap_patched = True
    log.info("LTXIdentityOverlap patches installed on %s", type(ltxv).__name__)


class GJJ_LTXIdentityOverlapConditioning:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "模型": ("MODEL", {"tooltip": "需要注入身份参考令牌的 LTX 模型；建议先加载匹配的身份 LoRA。"}),
            "正面条件": ("CONDITIONING", {"tooltip": "采样使用的正面文本条件，节点会原样传递。"}),
            "负面条件": ("CONDITIONING", {"tooltip": "采样使用的负面文本条件，节点会原样传递。"}),
            "VAE": ("VAE", {"tooltip": "用于把参考图编码为 LTX 参考潜空间的 VAE。"}),
            "潜空间": ("LATENT", {
                "tooltip": "目标视频的潜空间；节点只注入参考令牌，不会修改这里的潜空间内容。"
            }),
            "参考图像": ("IMAGE", {
                "tooltip": "需要迁移到生成结果中的主体参考图，可为人物、动物或物体。支持批量图片；分层堆叠模式下，每张图片成为独立参考块，来源编号按批次索引递增。"
            }),
            "来源编号": ("FLOAT", {"default": 2.0, "min": 0.0, "max": 8.0, "step": 1.0,
                "tooltip": "source_phase 分段编号，训练常用值为 2；设为 0 表示不添加相位标记。"}),
            "相位强度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.1,
                "tooltip": "来源相位的缩放强度；通常保持 1.0，并与模型训练设置一致。"}),
            "参考图缩放模式": (["匹配目标（裁剪）", "匹配目标（留边）", "原生分辨率"], {"default": "匹配目标（裁剪）",
                "tooltip": "匹配目标（裁剪）：按目标比例裁剪后缩放；匹配目标（留边）：完整保留参考图并用白色补边；原生分辨率：按参考图自身尺寸编码。必须选择与模型训练方式一致的模式。"}),
            "调试日志": ("BOOLEAN", {"default": False,
                "tooltip": "启用后在控制台输出每一步的 LTX 参考令牌形状与补丁调试信息。"}),
        }, "optional": {
            "裁剪锚点": (["居中", "顶部", "底部", "左侧", "右侧"], {"default": "居中",
                "tooltip": "仅用于“匹配目标（裁剪）”，决定宽高比不一致时保留参考图的哪一侧；留边和原生分辨率模式不受影响。"}),
            "布局模式": (["重叠", "时空错位", "分层堆叠"], {"default": "重叠",
                "tooltip": "重叠：参考与目标共用 RoPE 坐标范围；时空错位：在时间和空间轴上移到目标范围之外；分层堆叠：仅沿时间轴为批量参考图分配独立槽位。必须与模型训练布局一致。"}),
            "参考引导强度": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 10.0, "step": 0.1,
                "tooltip": "ST-DRC 风格参考 CFG。1.0 为关闭；大于 1.0 会增加一次不含参考令牌的前向计算并强化参考影响，建议从 2～4 开始尝试。"}),
        }}

    RETURN_TYPES = ("MODEL", "CONDITIONING", "CONDITIONING", "LATENT", "STRING", "IMAGE", "IMAGE")
    RETURN_NAMES = ("模型", "正面条件", "负面条件", "潜空间", "调试信息", "参考图预览", "裁剪区域预览")
    OUTPUT_TOOLTIPS = (
        "已注入身份参考令牌的 LTX 模型。",
        "原样传递的正面条件。",
        "原样传递的负面条件。",
        "原样传递的目标潜空间。",
        "参考数量、编码尺寸、布局、相位与参考 CFG 状态。",
        "实际送入 VAE 编码的参考图。",
        "原始参考图及绿色保留区域框。",
    )
    FUNCTION = "apply"
    CATEGORY = "GJJ/视频/LTX身份控制"
    DESCRIPTION = "为 LTX 模型注入独立的身份参考令牌，支持重叠、时空错位与分层堆叠布局；参考图不是首帧 I2V 条件，并提供实际编码图与裁剪区域预览。"
    GJJ_HELP = {
        "title": "GJJ · 🧬 LTX身份重叠条件",
        "description": DESCRIPTION,
        "dependencies": [
            "仅依赖 ComfyUI 自带的 LTX 模型、采样器与图像缩放接口。",
            "无第三方自定义节点依赖。",
        ],
        "usage": [
            "先在模型上加载与身份参考训练方式匹配的 LoRA，再连接本节点。",
            "布局模式、来源编号、相位强度和参考图缩放方式必须与所用模型或 LoRA 的训练配置一致。",
            "单张参考图可直接使用；分层堆叠模型可输入图片批次，每张图会获得独立参考槽位。",
            "查看“参考图预览”和“裁剪区域预览”，确认实际编码内容没有丢失关键主体。",
            "参考引导强度为 1.0 时关闭额外参考 CFG；提高后每步会增加一次前向计算。",
        ],
        "notes": [
            "节点会克隆模型并安装幂等运行时补丁，不修改输入模型对象。",
            "不要与 LightX2V 组合使用；采样时建议连接负面条件并从 CFG 3～5 起步。",
        ],
    }

    def apply(self, 模型, 正面条件, 负面条件, VAE, 潜空间, 参考图像,
              来源编号=2.0, 相位强度=1.0,
              参考图缩放模式="匹配目标（裁剪）", 调试日志=False,
              裁剪锚点="居中", 布局模式="重叠", 参考引导强度=1.0):
        参考图缩放模式 = {"匹配目标（裁剪）": "match_target", "匹配目标（留边）": "match_target_letterbox", "原生分辨率": "native_resolution"}.get(参考图缩放模式, 参考图缩放模式)
        裁剪锚点 = {"居中": "center", "顶部": "top", "底部": "bottom", "左侧": "left", "右侧": "right"}.get(裁剪锚点, 裁剪锚点)
        布局模式 = {"重叠": "overlap", "时空错位": "st_drc", "分层堆叠": "strata"}.get(布局模式, 布局模式)
        import comfy.samplers
        import comfy.utils

        global _DEBUG_ENABLED
        _DEBUG_ENABLED = bool(调试日志)
        m = 模型.clone()
        ltxv = _find_ltxv(m)

        _, w_sf, h_sf = VAE.downscale_index_formula
        n_refs = 参考图像.shape[0]

        def _encode_one(img1):
            """Resize (per 参考图缩放模式/裁剪锚点) + VAE-encode ONE reference image
            ([1,H,W,C] slice). Byte-identical to the pre-batch code path when n_refs == 1."""
            if 参考图缩放模式 == "native_resolution":
                # Encode at the ref image's OWN resolution (rounded to nearest 32px),
                # independent of the output video size -- matches training when the ref used
                # a fixed/own bucket.
                _, src_h, src_w, _ = img1.shape
                tgt_w = max(w_sf, round(src_w / w_sf) * w_sf)
                tgt_h = max(h_sf, round(src_h / h_sf) * h_sf)
            else:
                # Legacy behavior: resize ref to match the target video's pixel size (correct
                # for recipes where the ref used the SAME resolution bucket as the video, e.g.
                # a small face crop -- resolution never mattered there).
                _, _, _, lat_h, lat_w = 潜空间["samples"].shape
                tgt_w, tgt_h = lat_w * w_sf, lat_h * h_sf
            _, src_h0, src_w0, _ = img1.shape
            crop_box = (0, 0, src_w0, src_h0)  # default: "nothing cropped" (letterbox/native modes)
            if 参考图缩放模式 == "match_target_letterbox":
                ref_px = _letterbox_resize(img1, tgt_w, tgt_h)[:1, :, :, :3]
            elif 参考图缩放模式 == "match_target" and 裁剪锚点 != "center":
                # non-default anchor: use the configurable-anchor crop (new in v1.10.13)
                ref_px, crop_box = _anchored_crop_resize(img1, tgt_w, tgt_h, anchor=裁剪锚点)
                ref_px = ref_px[:1, :, :, :3]
            else:
                # unchanged from before v1.10.13 -- exact original center-crop path, byte-identical
                ref_px = comfy.utils.common_upscale(img1.movedim(-1, 1), tgt_w, tgt_h, "bilinear", "center").movedim(1, -1)[:1, :, :, :3]
                if 参考图缩放模式 == "match_target":
                    _, crop_box = _anchored_crop_resize(img1, tgt_w, tgt_h, anchor="center")  # for the preview overlay only
            ref_lat = VAE.encode(ref_px)
            overlay = _draw_crop_overlay(img1[:1], crop_box)
            return ref_lat, ref_px.clone(), overlay, crop_box, src_w0, src_h0

        ref_specs, ref_previews, crop_overlays = [], [], []
        for i in range(n_refs):
            ref_lat_i, ref_px_i, overlay_i, crop_box, src_w0, src_h0 = _encode_one(参考图像[i:i + 1])
            ref_specs.append({"latent": ref_lat_i, "seg_value": (float(来源编号) + i) * float(相位强度),
                              "layout": 布局模式, "strata_slot": i})
            ref_previews.append(ref_px_i)
            crop_overlays.append(overlay_i)
        ref_lat = ref_specs[0]["latent"]  # for the debug string below (1st ref's shape)
        ref_preview = torch.cat(ref_previews, dim=0)
        crop_overlay = torch.cat(crop_overlays, dim=0)

        _install_patches(ltxv)
        ltxv._id_rope_theta = 10000.0
        m.model_options = dict(m.model_options)
        to = dict(m.model_options.get("transformer_options", {}))
        to["_id_ref_specs"] = ref_specs
        m.model_options["transformer_options"] = to

        if 参考引导强度 != 1.0:
            # ST-DRC reference-CFG: a third forward pass per step with the reference tokens
            # dropped isolates the reference's own contribution, the same way CFG isolates
            # the text prompt's (arxiv 2606.02441). `args["input_cond"]` is the exact
            # conditioning list KSampler passed for the 正面条件/"cond" branch (same prompt,
            # same batching) -- reuse it unchanged, only strip `_id_ref_specs` from the
            # model_options used for THIS extra call so process_input sees no reference.
            noref_to = dict(to)
            noref_to.pop("_id_ref_specs", None)
            ref_scale = float(参考引导强度)

            # NOTE: must take exactly ONE parameter -- set_model_sampler_cfg_function()
            # inspects the signature's parameter COUNT (regardless of defaults) and treats
            # anything with 3 params as the legacy (cond, uncond, cond_scale) calling
            # convention, silently passing those three tensors/floats positionally instead
            # of the `args` dict. Keep noref_to/ref_scale as plain closure vars, not defaults.
            def _ref_cfg_function(args):
                cond = args["cond"]
                uncond = args["uncond"]
                cond_scale = args["cond_scale"]
                denoised = uncond + (cond - uncond) * cond_scale
                noref_model_options = dict(args["model_options"])
                noref_model_options["transformer_options"] = noref_to
                (noref_pred,) = comfy.samplers.calc_cond_batch(
                    args["model"], [args["input_cond"]], args["input"], args["timestep"], noref_model_options,
                )
                noref_denoised = args["input"] - noref_pred
                denoised = denoised + (ref_scale - 1.0) * (cond - noref_denoised)
                return denoised

            m.set_model_sampler_cfg_function(_ref_cfg_function, disable_cfg1_optimization=True)

        seg_list = ", ".join(f"#{i}={s['seg_value']:g}" for i, s in enumerate(ref_specs))
        dbg = (
            "=== GJJ LTX 身份重叠条件 ===\n"
            f"参考图：{n_refs} 张；每张编码为 {ref_preview.shape[2]}×{ref_preview.shape[1]} 像素；"
            f"缩放模式={参考图缩放模式}"
            f"{f'，裁剪锚点={裁剪锚点}' if 参考图缩放模式 == 'match_target' else ''}\n"
            f"令牌布局={布局模式}；各参考图 source_phase 分段值：{seg_list}\n"
            f"已为 {type(ltxv).__name__} 安装输入、时间步、位置编码与输出补丁。\n"
            f"裁剪保留区域：原图 {src_w0}×{src_h0} 中的 {crop_box[2]}×{crop_box[3]} 像素；"
            "可查看“参考图预览”和“裁剪区域预览”。\n"
            f"参考 CFG：{'关闭' if 参考引导强度 == 1.0 else f'开启，强度={参考引导强度}（每步增加一次前向计算）'}\n"
            "需要逐步形状日志时启用“调试日志”。建议连接负面条件，CFG 从 3～5 起步，不要使用 LightX2V。"
        )
        log.info("\n" + dbg)
        # pass the 潜空间 through unchanged (the ref is injected inside the 模型, not here)
        # so the graph can chain Empty -> this node -> sampler without branching.
        return (m, 正面条件, 负面条件, 潜空间, dbg, ref_preview, crop_overlay)


# Public node id + display name. Keep the old key as an alias so existing workflows load.
NODE_CLASS_MAPPINGS = {
    "GJJ_LTXIdentityOverlapConditioning": GJJ_LTXIdentityOverlapConditioning,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_LTXIdentityOverlapConditioning": "GJJ · 🧬 LTX身份重叠条件",
}
