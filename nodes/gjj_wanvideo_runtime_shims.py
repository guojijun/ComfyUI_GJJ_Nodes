from __future__ import annotations

import importlib
import importlib.machinery
import sys
import types


_GGUF_QUANTIZATION_VALUES = {
    "F32": 0,
    "F16": 1,
    "BF16": 2,
    "Q8_0": 3,
    "Q5_1": 4,
    "Q5_0": 5,
    "Q4_1": 6,
    "Q4_0": 7,
    "Q6_K": 8,
    "Q5_K": 9,
    "Q4_K": 10,
    "Q3_K": 11,
    "Q2_K": 12,
}


def _module_spec(name: str) -> importlib.machinery.ModuleSpec:
    return importlib.machinery.ModuleSpec(name, loader=None)


def _set_minimal_module_metadata(module, name: str):
    if getattr(module, "__spec__", None) is None:
        module.__spec__ = _module_spec(name)
    if not hasattr(module, "__loader__"):
        module.__loader__ = None
    if not hasattr(module, "__package__"):
        module.__package__ = ""
    return module


def _looks_like_old_gjj_stub(module) -> bool:
    return (
        module is not None
        and getattr(module, "__spec__", None) is None
        and not getattr(module, "__file__", None)
    )


def _import_real_module_or_stub(name: str, build_stub):
    existing = sys.modules.get(name)
    if (
        existing is not None
        and not getattr(existing, "_GJJ_OPTIONAL_RUNTIME_STUB", False)
        and not _looks_like_old_gjj_stub(existing)
    ):
        return _set_minimal_module_metadata(existing, name)

    previous = existing
    if existing is not None:
        sys.modules.pop(name, None)

    try:
        return importlib.import_module(name)
    except Exception:
        if previous is not None and not _looks_like_old_gjj_stub(previous):
            sys.modules[name] = _set_minimal_module_metadata(previous, name)
            return previous

    stub = build_stub()
    sys.modules[name] = stub
    return stub


def _build_gguf_stub():
    stub = types.ModuleType("gguf")
    stub._GJJ_OPTIONAL_RUNTIME_STUB = True
    stub.GGML_QUANT_SIZES = {}
    stub.GGMLQuantizationType = type("GGMLQuantizationType", (), dict(_GGUF_QUANTIZATION_VALUES))

    class GGUFReader:
        def __init__(self, *args, **kwargs):
            raise RuntimeError(
                "当前模型使用 GGUF 权重，需要先安装 gguf；普通 safetensors/fp16 模型不需要此依赖。"
            )

    stub.GGUFReader = GGUFReader
    return _set_minimal_module_metadata(stub, "gguf")


def ensure_optional_gguf_module():
    """Prefer the real gguf package, otherwise install a find_spec-safe placeholder."""
    return _import_real_module_or_stub("gguf", _build_gguf_stub)


def _build_huggingface_hub_stub():
    stub = types.ModuleType("huggingface_hub")
    stub._GJJ_OPTIONAL_RUNTIME_STUB = True

    def _stub_func(*args, **kwargs):
        raise NotImplementedError("huggingface_hub 占位模块不支持此函数，请安装完整的 huggingface_hub 包。")

    stub.cached_download = _stub_func
    stub.snapshot_download = _stub_func
    stub.hf_hub_download = _stub_func
    stub.HfApi = type("HfApi", (), {})
    stub.HfFolder = type("HfFolder", (), {"get_token": staticmethod(lambda: None)})
    return _set_minimal_module_metadata(stub, "huggingface_hub")


def ensure_huggingface_hub_cached_download():
    """Keep old WanVideo/gguf import paths compatible with newer huggingface_hub."""
    hub_module = _import_real_module_or_stub("huggingface_hub", _build_huggingface_hub_stub)
    if not hasattr(hub_module, "cached_download"):
        def _stub_cached_download(*args, **kwargs):
            raise NotImplementedError(
                "huggingface_hub.cached_download 已弃用。\n"
                "请使用 huggingface_hub.hf_hub_download 替代。"
            )

        hub_module.cached_download = _stub_cached_download
    return hub_module
