from __future__ import annotations

import inspect
import logging

import torch


log = logging.getLogger("GJJ-Bernini")
_PATCHED = False


def _core_has_bernini() -> bool:
    try:
        import comfy.ldm.wan.model as wan_model

        src = inspect.getsource(wan_model.WanModel.forward_orig)
        return "context_latents" in src
    except Exception:
        return False


def apply_gjj_bernini_patches() -> bool:
    """Apply RH-Bernini's native Wan runtime patch without requiring that node pack."""
    global _PATCHED
    if _PATCHED:
        return True

    if _core_has_bernini():
        log.info("GJJ Bernini: ComfyUI core already supports context_latents.")
        _PATCHED = True
        return True

    try:
        import comfy
        import comfy.conds
        import comfy.ldm.common_dit
        import comfy.ldm.wan.model as wan_model
        from comfy.ldm.flux.math import rope
        from comfy.model_base import WAN21
    except ImportError as exc:
        log.warning("GJJ Bernini: native Wan runtime patch skipped: %s", exc)
        return False

    WanModel = wan_model.WanModel

    def forward_orig(
        self,
        x,
        t,
        context,
        clip_fea=None,
        freqs=None,
        transformer_options={},
        **kwargs,
    ):
        x = self.patch_embedding(x.float()).to(x.dtype)
        grid_sizes = x.shape[2:]
        transformer_options["grid_sizes"] = grid_sizes
        x = x.flatten(2).transpose(1, 2)

        e = self.time_embedding(
            wan_model.sinusoidal_embedding_1d(self.freq_dim, t.flatten()).to(dtype=x[0].dtype)
        )
        e = e.reshape(t.shape[0], -1, e.shape[-1])
        e0 = self.time_projection(e).unflatten(2, (6, self.dim))

        full_ref = None
        if self.ref_conv is not None:
            full_ref = kwargs.get("reference_latent", None)
            if full_ref is not None:
                full_ref = self.ref_conv(full_ref).flatten(2).transpose(1, 2)
                x = torch.concat((full_ref, x), dim=1)

        context_latents = kwargs.get("context_latents", None)
        main_len = x.shape[1]
        if context_latents is not None:
            for lat in context_latents:
                cl = self.patch_embedding(lat.float().to(x.device)).to(x.dtype).flatten(2).transpose(1, 2)
                x = torch.cat([x, cl], dim=1)

        context = self.text_embedding(context)

        context_img_len = None
        if clip_fea is not None:
            if self.img_emb is not None:
                context_clip = self.img_emb(clip_fea)
                context = torch.concat([context_clip, context], dim=1)
            context_img_len = clip_fea.shape[-2]

        patches_replace = transformer_options.get("patches_replace", {})
        blocks_replace = patches_replace.get("dit", {})
        transformer_options["total_blocks"] = len(self.blocks)
        transformer_options["block_type"] = "double"
        for i, block in enumerate(self.blocks):
            transformer_options["block_index"] = i
            if ("double_block", i) in blocks_replace:

                def block_wrap(args):
                    out = {}
                    out["img"] = block(
                        args["img"],
                        context=args["txt"],
                        e=args["vec"],
                        freqs=args["pe"],
                        context_img_len=context_img_len,
                        transformer_options=args["transformer_options"],
                    )
                    return out

                out = blocks_replace[("double_block", i)](
                    {
                        "img": x,
                        "txt": context,
                        "vec": e0,
                        "pe": freqs,
                        "transformer_options": transformer_options,
                    },
                    {"original_block": block_wrap},
                )
                x = out["img"]
            else:
                x = block(
                    x,
                    e=e0,
                    freqs=freqs,
                    context=context,
                    context_img_len=context_img_len,
                    transformer_options=transformer_options,
                )

        x = self.head(x, e)

        if context_latents is not None:
            x = x[:, :main_len]

        if full_ref is not None:
            x = x[:, full_ref.shape[1] :]

        x = self.unpatchify(x, grid_sizes)
        return x

    def rope_encode(
        self,
        t,
        h,
        w,
        t_start=0,
        steps_t=None,
        steps_h=None,
        steps_w=None,
        device=None,
        dtype=None,
        transformer_options={},
        source_id=0,
    ):
        patch_size = self.patch_size
        t_len = ((t + (patch_size[0] // 2)) // patch_size[0])
        h_len = ((h + (patch_size[1] // 2)) // patch_size[1])
        w_len = ((w + (patch_size[2] // 2)) // patch_size[2])

        if steps_t is None:
            steps_t = t_len
        if steps_h is None:
            steps_h = h_len
        if steps_w is None:
            steps_w = w_len

        h_start = 0
        w_start = 0
        rope_options = transformer_options.get("rope_options", None)
        if rope_options is not None:
            t_len = (t_len - 1.0) * rope_options.get("scale_t", 1.0) + 1.0
            h_len = (h_len - 1.0) * rope_options.get("scale_y", 1.0) + 1.0
            w_len = (w_len - 1.0) * rope_options.get("scale_x", 1.0) + 1.0

            t_start += rope_options.get("shift_t", 0.0)
            h_start += rope_options.get("shift_y", 0.0)
            w_start += rope_options.get("shift_x", 0.0)

        img_ids = torch.zeros((steps_t, steps_h, steps_w, 3), device=device, dtype=dtype)
        img_ids[:, :, :, 0] = img_ids[:, :, :, 0] + torch.linspace(
            t_start, t_start + (t_len - 1), steps=steps_t, device=device, dtype=dtype
        ).reshape(-1, 1, 1)
        img_ids[:, :, :, 1] = img_ids[:, :, :, 1] + torch.linspace(
            h_start, h_start + (h_len - 1), steps=steps_h, device=device, dtype=dtype
        ).reshape(1, -1, 1)
        img_ids[:, :, :, 2] = img_ids[:, :, :, 2] + torch.linspace(
            w_start, w_start + (w_len - 1), steps=steps_w, device=device, dtype=dtype
        ).reshape(1, 1, -1)
        img_ids = img_ids.reshape(1, -1, img_ids.shape[-1])

        freqs = self.rope_embedder(img_ids).movedim(1, 2)

        if source_id:
            d = self.dim // self.num_heads
            pos = torch.tensor([[float(source_id)]], device=freqs.device, dtype=torch.float32)
            id_rot = rope(pos, d, self.rope_embedder.theta).reshape(1, 1, 1, d // 2, 2, 2).to(freqs.dtype)
            freqs = torch.einsum("...ij,...jk->...ik", freqs, id_rot)
        return freqs

    def _forward(self, x, timestep, context, clip_fea=None, time_dim_concat=None, transformer_options={}, **kwargs):
        _, _, t, h, w = x.shape
        x = comfy.ldm.common_dit.pad_to_patch_size(x, self.patch_size)

        t_len = t
        if time_dim_concat is not None:
            time_dim_concat = comfy.ldm.common_dit.pad_to_patch_size(time_dim_concat, self.patch_size)
            x = torch.cat([x, time_dim_concat], dim=2)
            t_len = x.shape[2]

        if self.ref_conv is not None and "reference_latent" in kwargs:
            t_len += 1

        freqs = self.rope_encode(t_len, h, w, device=x.device, dtype=x.dtype, transformer_options=transformer_options)

        context_latents = kwargs.get("context_latents", None)
        if context_latents is not None:
            context_latents = [
                comfy.ldm.common_dit.pad_to_patch_size(lat, self.patch_size) for lat in context_latents
            ]
            for i, lat in enumerate(context_latents):
                freqs = torch.cat(
                    [
                        freqs,
                        self.rope_encode(
                            lat.shape[-3],
                            lat.shape[-2],
                            lat.shape[-1],
                            device=x.device,
                            dtype=x.dtype,
                            transformer_options=transformer_options,
                            source_id=i + 1,
                        ),
                    ],
                    dim=1,
                )
            kwargs = {**kwargs, "context_latents": context_latents}

        return self.forward_orig(
            x, timestep, context, clip_fea=clip_fea, freqs=freqs, transformer_options=transformer_options, **kwargs
        )[:, :, :t, :h, :w]

    orig_extra_conds = WAN21.extra_conds
    orig_resize_cond = WAN21.resize_cond_for_context_window

    def extra_conds(self, **kwargs):
        out = orig_extra_conds(self, **kwargs)
        context_latents = kwargs.get("context_latents", None)
        if context_latents is not None:
            out["context_latents"] = comfy.conds.CONDList([self.process_latent_in(lat) for lat in context_latents])
        return out

    def resize_cond_for_context_window(self, cond_key, cond_value, window, x_in, device, retain_index_list=[]):
        if cond_key == "context_latents" and isinstance(getattr(cond_value, "cond", None), list):
            dim = window.dim
            out = []
            for lat in cond_value.cond:
                if lat.ndim > dim and lat.shape[dim] > 1 and lat.shape[dim] == x_in.shape[dim]:
                    idx = tuple([slice(None)] * dim + [window.index_list])
                    out.append(lat[idx].to(device))
                else:
                    out.append(lat.to(device))
            return cond_value._copy_with(out)
        return orig_resize_cond(self, cond_key, cond_value, window, x_in, device, retain_index_list=retain_index_list)

    WanModel.forward_orig = forward_orig
    WanModel.rope_encode = rope_encode
    WanModel._forward = _forward
    WAN21.extra_conds = extra_conds
    WAN21.resize_cond_for_context_window = resize_cond_for_context_window

    _PATCHED = True
    print("[GJJ] Bernini native Wan runtime patch applied: context_latents enabled.")
    log.info("GJJ Bernini: applied native Wan runtime patches for context_latents.")
    return True


try:
    apply_gjj_bernini_patches()
except Exception as exc:
    log.warning("GJJ Bernini: native Wan runtime patch failed during import: %s", exc)


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
