import gc
import logging
import threading
from typing import Any

import torch

logger = logging.getLogger("LongCatAudioDiT")

_cache_lock = threading.Lock()
_cached_model: Any = None
_cached_tokenizer: Any = None
_cached_key: tuple = ()
_keep_loaded: bool = False
_offloaded: bool = False

cancel_event: threading.Event = threading.Event()


def get_cache_key(
    model_path: str, device: str, precision: str, attention: str
) -> tuple:
    return (model_path, device, precision, attention)


def get_cached_model():
    return _cached_model, _cached_tokenizer, _cached_key


def set_cached_model(model: Any, tokenizer: Any, key: tuple, keep_loaded: bool = False):
    global _cached_model, _cached_tokenizer, _cached_key, _keep_loaded, _offloaded
    with _cache_lock:
        _cached_model = model
        _cached_tokenizer = tokenizer
        _cached_key = key
        _keep_loaded = keep_loaded
        _offloaded = False


def set_keep_loaded(keep_loaded: bool):
    global _keep_loaded
    with _cache_lock:
        _keep_loaded = keep_loaded


def is_offloaded() -> bool:
    with _cache_lock:
        return _offloaded


def offload_model_to_cpu() -> None:
    global _offloaded
    with _cache_lock:
        if _cached_model is None:
            return
        if _offloaded:
            return

        if getattr(_cached_model, "_vbar_active", False) or getattr(
            _cached_model, "_aimdo_auto", False
        ):
            _offloaded = True  # Mark as offloaded so subsequent calls are silent
            mode = "VBAR" if getattr(_cached_model, "_vbar_active", False) else "aimdo auto"
            logger.info(f"{mode} active — skipping manual CPU offload")
            return

        try:
            _cached_model.to("cpu")
            _offloaded = True
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            gc.collect()
            logger.info("Model offloaded to CPU. VRAM freed.")
        except Exception as e:
            logger.warning(f"Failed to offload model: {e}")


def resume_model_to_cuda(device: str = "cuda") -> None:
    global _offloaded
    with _cache_lock:
        if _cached_model is None:
            return
        if not _offloaded:
            return
        try:
            _cached_model.to(device)
            _offloaded = False
            logger.info(f"Model resumed to {device}.")
        except Exception as e:
            logger.warning(f"Failed to resume model: {e}")


def unload_model():
    global _cached_model, _cached_tokenizer, _cached_key, _keep_loaded, _offloaded
    with _cache_lock:
        if _cached_model is not None:
            logger.info("Unloading LongCat-AudioDiT model from memory...")
            # Move to CPU first so CUDA tensors are freed before deletion
            try:
                _cached_model.to("cpu")
            except Exception:
                pass
            del _cached_model
            del _cached_tokenizer
            _cached_model = None
            _cached_tokenizer = None
            _cached_key = ()
            _keep_loaded = False
            _offloaded = False
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
            gc.collect()
            logger.info("Model unloaded and VRAM freed.")


def _detect_vbar():
    """Detect if ComfyUI's dynamic VRAM management (VBAR/aimdo) is available.

    Returns:
        tuple: (vbar_available, aimdo_available)
            - vbar_available: True if ModelVBAR class can be imported (explicit VBAR mode)
            - aimdo_available: True if comfy_aimdo package is installed (auto memory management)
    """
    try:
        import comfy_aimdo
        from comfy_aimdo.model_vbar import ModelVBAR

        return True, True
    except ImportError:
        pass
    try:
        import comfy_aimdo

        return False, True
    except ImportError:
        pass
    return False, False


def _hook_comfy_model_management():
    try:
        import comfy.model_management as mm

        _original = mm.soft_empty_cache

        def _patched_soft_empty_cache(*args, **kwargs):
            # Only offload to CPU if keep_model_loaded is True, otherwise full unload
            if _keep_loaded and _cached_model is not None:
                offload_model_to_cpu()
            else:
                unload_model()
            return _original(*args, **kwargs)

        mm.soft_empty_cache = _patched_soft_empty_cache
        logger.debug(
            "Hooked comfy.model_management.soft_empty_cache for LongCat-AudioDiT unload."
        )
    except Exception:
        pass


_hook_comfy_model_management()
