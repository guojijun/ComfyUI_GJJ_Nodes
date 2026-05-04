# Attention backend selection for SAM3DBody.
#
# By default uses ComfyUI's global `optimized_attention`.
# Can be overridden per-model via the attn_backend config.

import logging

from comfy.ldm.modules.attention import (
    optimized_attention,
    attention_pytorch,
)

log = logging.getLogger("sam3dbody")

# Module-level attention function — used by vit.py and transformer.py
_attn_fn = optimized_attention

_BACKEND_MAP = {
    "sdpa": "attention_pytorch",
    "flash_attn": "attention_flash",
    "sage_attn": "attention_sage",
    "xformers": "attention_xformers",
}


def set_attn_backend(backend: str = "auto"):
    """Set the attention backend for SAM3DBody.

    Args:
        backend: One of "auto", "flash_attn", "sage_attn", "sdpa", "xformers".
                 "auto" uses ComfyUI's global optimized_attention.
    """
    global _attn_fn

    if backend == "auto":
        from comfy.ldm.modules.attention import optimized_attention as fn
        _attn_fn = fn
        log.info(f" Attention backend: auto (ComfyUI global)")
        return

    fn_name = _BACKEND_MAP.get(backend)
    if fn_name is None:
        log.warning(f" Unknown attn_backend '{backend}', falling back to auto")
        from comfy.ldm.modules.attention import optimized_attention as fn
        _attn_fn = fn
        return

    try:
        import comfy.ldm.modules.attention as attn_module
        fn = getattr(attn_module, fn_name)
        _attn_fn = fn
        log.info(f" Attention backend: {backend} ({fn_name})")
    except (AttributeError, ImportError):
        log.warning(f" Attention backend '{backend}' not available, falling back to auto")
        from comfy.ldm.modules.attention import optimized_attention as fn
        _attn_fn = fn


def sam3d_attention(q, k, v, heads, mask=None, skip_reshape=False):
    """Dispatch attention using the configured backend."""
    return _attn_fn(q, k, v, heads=heads, mask=mask, skip_reshape=skip_reshape)
