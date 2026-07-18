import importlib.machinery
import sys
import types


def _ensure_diffusers_gguf_optional() -> None:
    """
    Diffusers imports its own optional GGUF quantizer while loading ordinary VAE
    classes. Keep that optional path inert until SeedVR2 explicitly selects a
    .gguf model and imports the real Python gguf package. This path is
    self-contained inside the SeedVR2 runtime.
    """
    if "gguf" in sys.modules:
        return
    if "diffusers.quantizers.gguf" in sys.modules:
        return

    stub = types.ModuleType("diffusers.quantizers.gguf")
    stub.__spec__ = importlib.machinery.ModuleSpec("diffusers.quantizers.gguf", None)
    stub.__file__ = None

    class GGUFQuantizer:
        def __init__(self, *args, **kwargs):
            raise ImportError("GGUF quantization requires the optional gguf package.")

    stub.GGUFQuantizer = GGUFQuantizer
    sys.modules["diffusers.quantizers.gguf"] = stub


_ensure_diffusers_gguf_optional()
