"""Model loading utilities for Fish Audio S2 nodes.

Path resolution strategy
------------------------
We NEVER hardcode any path. Everything is resolved at runtime:

1.  folder_paths.models_dir  — ComfyUI's own path resolver.
    It reads from config.yaml / environment variables / CLI args, so it
    returns the correct directory regardless of:
      - OS  (Windows / Linux / macOS)
      - install type  (portable zip, pip, Docker, venv, conda)
      - ComfyUI location  (any drive, any folder, any user)

2.  Fallback for running outside ComfyUI (unit tests, etc.):
    <this_file>/../../checkpoints/

The dropdown widget shows only folder *names* (e.g. "s2-pro").
The full path is resolved from folder_paths at execution time,
so saved workflows are portable across machines.
"""

import io
import importlib
import logging
import sys
from pathlib import Path

import numpy as np
import torch
from .common_utils.dependency_checker import (
    get_report_from_exception,
    load_dependency_at_runtime,
    make_missing_model_spec,
    raise_dependency_model_error,
)

logger = logging.getLogger("GJJ.FishAudioS2")
NODE_DISPLAY_NAME = "📢 语音克隆TTS(FishAudioS2)"

# Sub-folder name inside ComfyUI/models/
MODELS_FOLDER_NAME = "fishaudioS2"
VENDOR_ROOT = Path(__file__).resolve().parent.parent / "vendor"
FISH_SPEECH_PACKAGE = VENDOR_ROOT / "fish_speech"
FISH_SPEECH_PROJECT_MARKER = FISH_SPEECH_PACKAGE / ".project-root"
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"
LOCAL_MODEL_PLACEHOLDER = "[未找到本地Fish S2模型]"
TEXT_MODEL_SUFFIXES = {".safetensors", ".bin"}
MIN_TEXT_MODEL_WEIGHT_BYTES = 512 * 1024 * 1024
DECODER_FILE_NAMES = (
    "codec.pth",
    "firefly-gan-vq-fsq-8x1024-21hz-generator.pth",
    "decoder.pth",
    "vocoder.pth",
)
RUNTIME_INSTALL_PACKAGES = [
    "transformers",
    "loguru",
    "pydantic",
    "tiktoken",
    "hydra-core",
    "descript-audio-codec",
    "descript-audiotools",
    "soundfile",
    "pyrootutils",
    "omegaconf",
    "huggingface_hub",
    "torchvision",
    "librosa",
    "pyarrow",
    "protobuf",
    "natsort",
    "loralib",
    "datasets",
    "imageio-ffmpeg",
]


def _ensure_vendor_fish_speech(unique_id=None) -> None:
    if not FISH_SPEECH_PACKAGE.is_dir():
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[{
                "module_name": "",
                "package_name": "",
                "display_name": "GJJ 内置 fish_speech 运行时",
                "description": "GJJ 自带的 Fish Speech 运行时目录缺失或损坏。",
            }],
            install_packages=[],
            description=f"未找到 GJJ 内置 Fish Speech 运行时目录：{FISH_SPEECH_PACKAGE}",
            unique_id=unique_id,
            copy_text="",
            copy_label="",
        )

    if not FISH_SPEECH_PROJECT_MARKER.exists():
        try:
            FISH_SPEECH_PROJECT_MARKER.write_text(
                "GJJ vendored Fish Speech project root marker.\n",
                encoding="utf-8",
            )
        except OSError as exc:
            raise_dependency_model_error(
                node_name=NODE_DISPLAY_NAME,
                missing_dependencies=[{
                    "module_name": "",
                    "package_name": "",
                    "display_name": "GJJ 内置 fish_speech 运行时",
                    "description": "内置运行时缺少 .project-root 标记，且自动修复失败。",
                }],
                install_packages=[],
                description=f"无法修复 Fish Speech 运行时标记文件：{FISH_SPEECH_PROJECT_MARKER}",
                original_error=str(exc),
                unique_id=unique_id,
                copy_text="",
                copy_label="",
            )

    vendor_root = str(VENDOR_ROOT)
    if vendor_root not in sys.path:
        sys.path.insert(0, vendor_root)

    package_root = str(FISH_SPEECH_PACKAGE).replace("\\", "/").lower()
    stale_keys = []
    for key, module in list(sys.modules.items()):
        if key != "fish_speech" and not key.startswith("fish_speech."):
            continue
        module_file = getattr(module, "__file__", None)
        if module_file and module_file.replace("\\", "/").lower().startswith(package_root):
            continue
        stale_keys.append(key)
    for key in stale_keys:
        del sys.modules[key]
    if stale_keys:
        importlib.invalidate_caches()
        logger.info(f"Evicted {len(stale_keys)} stale fish_speech module(s).")

    try:
        import fish_speech.models  # noqa: F401
    except ImportError as exc:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[{
                "module_name": "fish_speech",
                "package_name": "",
                "display_name": "Fish Speech 环境依赖",
                "description": "不要安装 fish-speech；GJJ 已内置源码，只需要补齐 Python 运行依赖。",
            }],
            install_packages=RUNTIME_INSTALL_PACKAGES,
            description="Fish Audio S2 运行时导入失败，请先补齐 Fish S2 的 Python 推理依赖。",
            original_error=str(exc),
            unique_id=unique_id,
        )


def _get_models_base() -> Path:
    """
    Return the absolute path to ComfyUI/models/fishaudioS2/.

    Called every time it's needed so it always reflects the live
    folder_paths state — works on any OS, any install, any location.
    """
    try:
        import folder_paths
        base = Path(folder_paths.models_dir) / MODELS_FOLDER_NAME
    except ImportError:
        # Outside ComfyUI (tests / standalone use)
        base = Path(__file__).resolve().parent.parent / "checkpoints"

    base.mkdir(parents=True, exist_ok=True)
    return base


def _register_folder():
    """
    Tell ComfyUI's folder_paths system about our models folder.
    Called once at node registration time from __init__.py.
    Safe to call multiple times.
    """
    try:
        import folder_paths
        base = str(_get_models_base())
        # add_model_folder_path is idempotent — safe to call repeatedly
        folder_paths.add_model_folder_path(MODELS_FOLDER_NAME, base)
        logger.info(f"Models folder registered: {base}")
    except ImportError:
        pass  # not inside ComfyUI, nothing to register


HF_MODELS = {
    "s2-pro": {
        "repo_id": "fishaudio/s2-pro",
        "description": "Full precision (4B params, ~24GB VRAM)",
    },
    "s2-pro-fp8": {
        "repo_id": "drbaph/s2-pro-fp8",
        "description": "FP8 weight-only quantized (~12GB VRAM, requires RTX 4090/5090)",
    },
    "s2-pro-bnb-int8": {
        "repo_id": "fishaudio/s2-pro",
        "description": "BNB INT8 on-the-fly (~8-9GB VRAM, requires bitsandbytes)",
        "base_model": "s2-pro",
    },
    "s2-pro-bnb-nf4": {
        "repo_id": "fishaudio/s2-pro",
        "description": "BNB NF4 4-bit on-the-fly (~4-5GB VRAM, requires bitsandbytes)",
        "base_model": "s2-pro",
    },
}
HF_DEFAULT_MODEL_NAME = "s2-pro-fp8"


def _auto_download_model(model_name: str = HF_DEFAULT_MODEL_NAME, unique_id=None) -> bool:
    """
    Download a model from HuggingFace into models/fishaudioS2/<model_name>/
    using huggingface_hub.
    For BNB models, download to the base model folder (they share weights).
    Returns True if the model is present after the call.
    """
    if model_name not in HF_MODELS:
        logger.error(f"Unknown model: {model_name}")
        return False

    # BNB models share weights with the base model
    folder_name = HF_MODELS[model_name].get("base_model", model_name)
    repo_id = HF_MODELS[model_name]["repo_id"]
    dest = _get_models_base() / folder_name

    if dest.is_dir() and any(dest.iterdir()):
        return True

    logger.info(
        f"Downloading '{model_name}' ({HF_MODELS[model_name]['description']}) "
        f"from HuggingFace..."
    )
    logger.info(f"Repo: {repo_id}")
    logger.info(f"Destination: {dest}")

    huggingface_hub = load_dependency_at_runtime(
        module_name="huggingface_hub",
        node_name=NODE_DISPLAY_NAME,
        package_name="huggingface_hub",
        description="自动下载 Fish Audio S2 模型需要 huggingface_hub。",
        unique_id=unique_id,
    )
    snapshot_download = huggingface_hub.snapshot_download

    try:
        snapshot_download(
            repo_id=repo_id,
            endpoint=HF_MIRROR_ENDPOINT,
            local_dir=str(dest),
            ignore_patterns=["*.msgpack", "flax_model*", "tf_model*", "*.h5"],
        )
        logger.info(f"Model downloaded to: {dest}")
        return True
    except Exception as e:
        report = get_report_from_exception(e)
        if report:
            raise
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[
                make_missing_model_spec(
                    label=model_name,
                    subdir=MODELS_FOLDER_NAME,
                    filename=folder_name,
                    description="模型自动下载失败，请手动下载后放入对应目录。",
                )
            ],
            description=f"Fish Audio S2 模型下载失败：{dest}",
            original_error=str(e),
            unique_id=unique_id,
            title="GJJ 节点模型缺失！",
        )


def _has_complete_model_files(model_path: Path) -> bool:
    """Return True only when a local model folder looks complete enough to load."""
    if not model_path.is_dir():
        return False
    try:
        has_config = (model_path / "config.json").is_file()
        has_text_weights = any(
            f.suffix.lower() in TEXT_MODEL_SUFFIXES
            and f.stat().st_size >= MIN_TEXT_MODEL_WEIGHT_BYTES
            for f in model_path.iterdir()
            if f.is_file()
        )
    except OSError:
        return False
    return has_config and has_text_weights and _has_decoder_file(model_path)


def _has_decoder_file(model_path: Path) -> bool:
    for search in (model_path, model_path.parent):
        for name in DECODER_FILE_NAMES:
            if (search / name).is_file():
                return True
    return False


def _is_model_downloaded(model_name: str) -> bool:
    """Check whether a known model choice is backed by local files."""
    # BNB models use the base model's weights
    base_name = HF_MODELS.get(model_name, {}).get("base_model", model_name)
    return _has_complete_model_files(_get_models_base() / base_name)


def _model_sort_key(name: str) -> tuple[int, str]:
    lower = str(name or "").lower()
    if lower == "s2-pro-fp8":
        rank = 0
    elif "fp8" in lower:
        rank = 1
    elif lower == "s2-pro-bnb-nf4":
        rank = 2
    elif lower == "s2-pro-bnb-int8":
        rank = 3
    elif lower == "s2-pro":
        rank = 4
    else:
        rank = 20
    return rank, lower


def get_model_names() -> list[str]:
    """
    Return model names for the dropdown.
    Only complete local models are shown. FP8 variants are sorted first.
    """
    base = _get_models_base()
    names: list[str] = []

    for model_name in sorted(HF_MODELS.keys(), key=_model_sort_key):
        if _is_model_downloaded(model_name):
            names.append(model_name)

    # Add any custom models found in the folder
    try:
        for entry in sorted(base.iterdir()):
            if not entry.is_dir():
                continue
            if entry.name in HF_MODELS:
                continue  # already added above
            if _has_complete_model_files(entry):
                names.append(entry.name)
    except OSError:
        pass

    deduped = list(dict.fromkeys(names))
    if not deduped:
        return [LOCAL_MODEL_PLACEHOLDER]
    return sorted(deduped, key=_model_sort_key)


_AUTO_DOWNLOAD_SUFFIX = " (auto download)"


def _strip_auto_download_suffix(name: str) -> str:
    """Remove ' (auto download)' suffix if present."""
    if name.endswith(_AUTO_DOWNLOAD_SUFFIX):
        return name[:-len(_AUTO_DOWNLOAD_SUFFIX)]
    return name


def resolve_model_path(name: str, unique_id=None) -> Path:
    """
    Resolve a model folder name → full absolute Path at execution time.
    Only local models are accepted; the node never downloads during generation.
    """
    # Strip the " (auto download)" suffix if present
    name = _strip_auto_download_suffix(name)
    if not name or name == LOCAL_MODEL_PLACEHOLDER:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[
                make_missing_model_spec(
                    label="Fish S2 模型",
                    subdir=MODELS_FOLDER_NAME,
                    filename="",
                    description=f"请把模型放到：{_get_models_base()}",
                )
            ],
            description="未找到本地 Fish S2 模型。",
            unique_id=unique_id,
            title="GJJ 节点模型缺失！",
        )

    path = _get_models_base() / name

    if not _has_complete_model_files(path):
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[
                make_missing_model_spec(
                    label=name,
                    subdir=MODELS_FOLDER_NAME,
                    filename=name,
                    description="请确认目录内至少包含 config.json、文本权重和 DAC 解码器文件。",
                )
            ],
            description=f"本地 Fish S2 模型不完整或不存在：{path}",
            unique_id=unique_id,
            title="GJJ 节点模型缺失！",
        )

    return path


def resolve_device(device_choice: str) -> tuple[str, torch.dtype]:
    """Return (device_str, dtype) for the user's device selection."""
    if device_choice == "auto":
        if torch.cuda.is_available():
            return "cuda", torch.bfloat16
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps", torch.float16
        logger.warning(
            "No CUDA or MPS GPU detected — falling back to CPU. "
            "Inference will be very slow. If you have an NVIDIA GPU, your "
            "PyTorch installation may be the CPU-only build. Restart ComfyUI; "
            "if the problem persists reinstall PyTorch with the correct CUDA "
            "index: https://pytorch.org/get-started/locally/"
        )
        return "cpu", torch.float32
    if device_choice == "cuda":
        return "cuda", torch.bfloat16
    if device_choice == "mps":
        return "mps", torch.float16
    return "cpu", torch.float32


def resolve_precision(precision_choice: str, model_name: str, device: str) -> torch.dtype:
    """
    Resolve precision to torch.dtype based on choice, model type, and device.

    - 'auto': bfloat16 for full model on CUDA, float16 for quantized model on CUDA
    - Otherwise use the specified precision
    """
    if precision_choice == "auto":
        is_fp8      = "fp8" in model_name.lower()
        is_quantized = any(x in model_name.lower() for x in ["int4", "4bit"])

        if device == "cuda":
            if is_fp8:
                # FP8 weights are self-scaling; activations run in bfloat16
                logger.info("Auto-detected FP8 model — using bfloat16 for activations")
                return torch.bfloat16
            if is_quantized:
                logger.info("Auto-detected quantized model — using float16")
                return torch.float16
            logger.info("Auto-detected full model — using bfloat16")
            return torch.bfloat16
        elif device == "mps":
            return torch.float16
        else:
            return torch.float32

    # Explicit precision choices
    if precision_choice == "bfloat16":
        return torch.bfloat16
    if precision_choice == "float16":
        return torch.float16
    return torch.float32


def resolve_bnb_mode(model_name: str) -> str | None:
    """
    Return 'int8', 'nf4', or None based on model_name.
    BNB models are: s2-pro-bnb-int8, s2-pro-bnb-nf4
    """
    name_lower = model_name.lower()
    if "bnb-int8" in name_lower or "bnb_int8" in name_lower:
        return "int8"
    if "bnb-nf4" in name_lower or "bnb_nf4" in name_lower:
        return "nf4"
    return None


def load_engine(
    model_name: str,
    device: str,
    precision: str,
    attention: str,
    compile_model: bool,
    unique_id=None,
):
    """
    Load the Fish Speech TTSInferenceEngine and apply the requested attention
    implementation.

    attention choices
    -----------------
    'auto'            — leave the model's default behaviour (sdpa + flash when
                        no mask, plain sdpa when mask present).
    'sdpa'            — force pure PyTorch SDPA on every call (no FlashAttn
                        backend hint).
    'flash_attention' — force SDPBackend.FLASH_ATTENTION on every call,
                        including the masked path.
    'sage_attention'  — monkey-patch every Attention layer with sageattn.
    """
    _ensure_vendor_fish_speech(unique_id)

    # Strip the " (auto download)" suffix before any HF_MODELS lookups or
    # bnb detection — the suffix is only display-layer metadata.
    model_name = _strip_auto_download_suffix(model_name)

    device_str, _ = resolve_device(device)
    bnb_mode = resolve_bnb_mode(model_name)

    # BNB guardrails: requires CUDA, force sdpa attention
    if bnb_mode is not None:
        if not torch.cuda.is_available():
            raise RuntimeError(
                f"BitsAndBytes quantization ({model_name}) requires CUDA. "
                "Set device to 'cuda' or use a non-BNB model variant."
            )
        if device_str != "cuda":
            raise RuntimeError(
                f"BitsAndBytes quantization ({model_name}) requires CUDA, "
                f"but device resolved to '{device_str}'. "
                "Set device to 'cuda' or 'auto' with a CUDA GPU available."
            )
        # Force sdpa for BNB - flash/sage can conflict with BNB's custom CUDA kernels
        if attention in ("flash_attention", "sage_attention"):
            logger.warning(
                f"BNB quantization forces attention to 'sdpa' for stability. "
                f"Ignoring user choice: {attention}"
            )
            attention = "sdpa"
        logger.info(f"BNB mode activated: {bnb_mode}")

    # Guard unsupported attention modes on non-CUDA devices
    if device_str != "cuda":
        if attention == "flash_attention":
            logger.warning(
                f"flash_attention is only supported on CUDA. "
                f"Falling back to sdpa on {device_str}."
            )
            attention = "sdpa"
        if attention == "sage_attention":
            logger.warning(
                f"sage_attention is only supported on CUDA. "
                f"Falling back to sdpa on {device_str}."
            )
            attention = "sdpa"
    try:
        from fish_speech.models.dac.inference import load_model as load_decoder_model
        from fish_speech.models.text2semantic import inference as text2semantic_inference
        from fish_speech.inference_engine import TTSInferenceEngine
    except ImportError as e:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[{
                "module_name": "fish_speech",
                "package_name": "",
                "display_name": "Fish Speech 环境依赖",
                "description": "不要安装 fish-speech；GJJ 已内置源码，只需要补齐 Python 运行依赖。",
            }],
            install_packages=RUNTIME_INSTALL_PACKAGES,
            description="Fish Audio S2 运行时导入失败，请先补齐依赖。",
            original_error=str(e),
            unique_id=unique_id,
        )

    launch_thread_safe_queue = text2semantic_inference.launch_thread_safe_queue
    try:
        from .gjj_fish_audio_s2_model_cache import cancel_event

        text2semantic_inference._cancel_event = cancel_event
    except Exception:
        pass

    # For BNB models, resolve path to the base s2-pro checkpoint
    # (BNB quantization is applied on-the-fly, not stored separately)
    if bnb_mode is not None:
        base_model_name = HF_MODELS.get(model_name, {}).get("base_model", "s2-pro")
        model_path = resolve_model_path(base_model_name, unique_id=unique_id)
        logger.info(f"BNB model '{model_name}' -> loading base weights from '{base_model_name}'")
    else:
        model_path = resolve_model_path(model_name, unique_id=unique_id)

    dtype = resolve_precision(precision, model_name, device_str)

    # Detect ComfyUI Dynamic VRAM mode (--fast dynamic_vram).
    # When active, keep the LLaMA model on CPU between generations to reduce
    # RAM pressure. The worker thread moves it to GPU only during inference.
    lazy_load = False
    if device_str == "cuda":
        try:
            import comfy.memory_management
            if getattr(comfy.memory_management, "aimdo_enabled", False):
                lazy_load = True
                logger.info("ComfyUI Dynamic VRAM detected — enabling lazy model loading to reduce RAM usage")
        except ImportError:
            pass

    logger.info(f"Loading Fish S2 LLaMA from: {model_path}")
    logger.info(f"Device: {device_str}, Precision: {dtype}, Lazy load: {lazy_load}")
    # Patch the Attention class before the worker thread runs init_model so
    # every Attention instance created during loading gets the patched forward.
    # launch_thread_safe_queue blocks until init_model finishes, so it is safe
    # to restore the class immediately afterwards.
    _orig_forward, _attn_cls = _patch_attention_class(attention)
    try:
        llama_queue, llama_thread = launch_thread_safe_queue(
            checkpoint_path=str(model_path),
            device=device_str,
            precision=dtype,
            compile=compile_model,
            bnb_mode=bnb_mode,
            lazy_load=lazy_load,
        )
    finally:
        _restore_attention_class(_orig_forward, _attn_cls)

    decoder_ckpt = _find_decoder(model_path, unique_id=unique_id)
    logger.info(f"Loading Fish S2 decoder from: {decoder_ckpt}")

    decoder_model = load_decoder_model(
        config_name="modded_dac_vq",
        checkpoint_path=str(decoder_ckpt),
        device=device_str,
    )

    engine = TTSInferenceEngine(
        llama_queue=llama_queue,
        decoder_model=decoder_model,
        precision=dtype,
        compile=compile_model,
    )
    # Store thread so unload_engine() can join it and guarantee the worker
    # (which holds model tensors in its closure) has fully exited before we
    # load a new model — prevents both models sitting in RAM simultaneously.
    engine._llama_thread = llama_thread
    # Store lazy_load flag so the cache system can adjust offload/resume behavior.
    engine._lazy_load = lazy_load

    logger.info(f"Fish S2 engine ready (attention={attention}).")
    return engine


# ---------------------------------------------------------------------------
# Attention patching
# ---------------------------------------------------------------------------
# The LLaMA model lives inside launch_thread_safe_queue's worker thread
# closure — it is NOT accessible as an attribute on the returned queue.
# However, launch_thread_safe_queue() blocks (via init_event.wait()) until
# the worker has finished init_model(). We therefore patch the Attention
# *class* before calling launch_thread_safe_queue and restore it afterwards.
# Class-level patching affects all instances created during that window
# (i.e. this model), and since we restore it immediately after the blocking
# call returns, other models loaded concurrently are unaffected in practice
# (ComfyUI node execution is single-threaded per queue).
# ---------------------------------------------------------------------------

def _make_attention_forward(attention: str):
    """
    Return the forward function to install on fish-speech's Attention class,
    or None for 'auto' (keep the class unchanged).
    """
    if attention == "auto":
        return None

    if attention == "sdpa":
        def _forward(self, x, freqs_cis, mask, input_pos=None):
            from fish_speech.models.text2semantic.llama import apply_rotary_emb
            import torch.nn.functional as F
            bsz, seqlen, _ = x.shape
            q_size = self.n_head * self.head_dim
            kv_size = self.n_local_heads * self.head_dim
            q, k, v = self.wqkv(x).split([q_size, kv_size, kv_size], dim=-1)
            q = q.view(bsz, seqlen, self.n_head, self.head_dim)
            k = k.view(bsz, seqlen, self.n_local_heads, self.head_dim)
            v = v.view(bsz, seqlen, self.n_local_heads, self.head_dim)
            if self.attention_qk_norm:
                q = self.q_norm(q)
                k = self.k_norm(k)
            q = apply_rotary_emb(q, freqs_cis)
            k = apply_rotary_emb(k, freqs_cis)
            q, k, v = map(lambda t: t.transpose(1, 2), (q, k, v))
            if self.kv_cache is not None:
                k, v = self.kv_cache.update(input_pos, k, v)
            k = k.repeat_interleave(self.n_head // self.n_local_heads, dim=1)
            v = v.repeat_interleave(self.n_head // self.n_local_heads, dim=1)
            # Pure SDPA — no explicit backend hint, PyTorch picks best kernel.
            y = F.scaled_dot_product_attention(
                q, k, v,
                attn_mask=mask,
                dropout_p=self.dropout if self.training else 0.0,
                is_causal=(mask is None),
            )
            y = y.transpose(1, 2).contiguous().view(bsz, seqlen, q_size)
            return self.wo(y)
        return _forward

    if attention == "flash_attention":
        def _forward(self, x, freqs_cis, mask, input_pos=None):
            from fish_speech.models.text2semantic.llama import apply_rotary_emb
            from torch.nn.attention import SDPBackend, sdpa_kernel
            import torch.nn.functional as F
            bsz, seqlen, _ = x.shape
            q_size = self.n_head * self.head_dim
            kv_size = self.n_local_heads * self.head_dim
            q, k, v = self.wqkv(x).split([q_size, kv_size, kv_size], dim=-1)
            q = q.view(bsz, seqlen, self.n_head, self.head_dim)
            k = k.view(bsz, seqlen, self.n_local_heads, self.head_dim)
            v = v.view(bsz, seqlen, self.n_local_heads, self.head_dim)
            if self.attention_qk_norm:
                q = self.q_norm(q)
                k = self.k_norm(k)
            q = apply_rotary_emb(q, freqs_cis)
            k = apply_rotary_emb(k, freqs_cis)
            q, k, v = map(lambda t: t.transpose(1, 2), (q, k, v))
            if self.kv_cache is not None:
                k, v = self.kv_cache.update(input_pos, k, v)
            k = k.repeat_interleave(self.n_head // self.n_local_heads, dim=1)
            v = v.repeat_interleave(self.n_head // self.n_local_heads, dim=1)
            # Force FlashAttention backend on every call.
            with sdpa_kernel(SDPBackend.FLASH_ATTENTION):
                y = F.scaled_dot_product_attention(
                    q, k, v,
                    attn_mask=mask,
                    dropout_p=self.dropout if self.training else 0.0,
                    is_causal=(mask is None),
                )
            y = y.transpose(1, 2).contiguous().view(bsz, seqlen, q_size)
            return self.wo(y)
        return _forward

    if attention == "sage_attention":
        sageattention_module = load_dependency_at_runtime(
            module_name="sageattention",
            node_name=NODE_DISPLAY_NAME,
            package_name="sageattention",
            description="Fish Audio S2 的 SageAttention 模式需要 sageattention。",
        )
        sageattn = sageattention_module.sageattn

        def _forward(self, x, freqs_cis, mask, input_pos=None):
            from fish_speech.models.text2semantic.llama import apply_rotary_emb
            import torch.nn.functional as F
            bsz, seqlen, _ = x.shape
            q_size = self.n_head * self.head_dim
            kv_size = self.n_local_heads * self.head_dim
            q, k, v = self.wqkv(x).split([q_size, kv_size, kv_size], dim=-1)
            q = q.view(bsz, seqlen, self.n_head, self.head_dim)
            k = k.view(bsz, seqlen, self.n_local_heads, self.head_dim)
            v = v.view(bsz, seqlen, self.n_local_heads, self.head_dim)
            if self.attention_qk_norm:
                q = self.q_norm(q)
                k = self.k_norm(k)
            q = apply_rotary_emb(q, freqs_cis)
            k = apply_rotary_emb(k, freqs_cis)
            q, k, v = map(lambda t: t.transpose(1, 2), (q, k, v))
            if self.kv_cache is not None:
                k, v = self.kv_cache.update(input_pos, k, v)
            k = k.repeat_interleave(self.n_head // self.n_local_heads, dim=1)
            v = v.repeat_interleave(self.n_head // self.n_local_heads, dim=1)
            # sageattn does not support attn_mask; fall back to SDPA when
            # a mask is present (prefill with KV cache).
            if mask is None:
                y = sageattn(q, k, v, is_causal=True)
            else:
                y = F.scaled_dot_product_attention(
                    q, k, v, attn_mask=mask,
                    dropout_p=self.dropout if self.training else 0.0,
                )
            y = y.transpose(1, 2).contiguous().view(bsz, seqlen, q_size)
            return self.wo(y)
        return _forward

    raise ValueError(f"Unknown attention type: {attention!r}")


def _patch_attention_class(attention: str):
    """
    Temporarily replace Attention.forward on the class itself.
    Returns (original_forward, Attention_class) so the caller can restore it.
    Returns (None, None) for 'auto' — nothing to do.
    """
    if attention == "auto":
        return None, None

    try:
        from fish_speech.models.text2semantic.llama import Attention
    except ImportError as e:
        logger.warning(f"Cannot patch Attention class: {e}")
        return None, None

    forward_fn = _make_attention_forward(attention)
    original = Attention.forward
    Attention.forward = forward_fn
    logger.info(f"Attention class patched with: {attention}")
    return original, Attention


def _restore_attention_class(original_forward, attention_cls) -> None:
    """Restore Attention.forward to its original implementation."""
    if original_forward is not None and attention_cls is not None:
        attention_cls.forward = original_forward
        logger.info("Attention class restored to default.")


def _find_decoder(model_dir: Path, unique_id=None) -> Path:
    """
    Locate the DAC vocoder weight file near the LLaMA checkpoint.
    Fish Speech ships it as firefly-gan-vq-fsq-8x1024-21hz-generator.pth.
    We check inside the model folder first, then its parent (fishaudioS2/).
    """
    for search in (model_dir, model_dir.parent):
        for name in DECODER_FILE_NAMES:
            p = search / name
            if p.is_file():
                return p

    raise_dependency_model_error(
        node_name=NODE_DISPLAY_NAME,
        missing_models=[
            make_missing_model_spec(
                label="Fish S2 DAC 解码器",
                subdir=MODELS_FOLDER_NAME,
                filename=model_dir.name,
                description=f"目录附近需要包含以下任一文件：{', '.join(DECODER_FILE_NAMES)}",
            )
        ],
        description=f"DAC decoder checkpoint not found near: {model_dir}",
        unique_id=unique_id,
        title="GJJ 节点模型缺失！",
    )


def audio_bytes_from_comfy(audio_dict: dict) -> bytes:
    """
    Convert a ComfyUI AUDIO dict → WAV bytes for Fish Speech.
    ComfyUI format: {"waveform": Tensor[B, C, S], "sample_rate": int}
    """
    sf = load_dependency_at_runtime(
        module_name="soundfile",
        node_name=NODE_DISPLAY_NAME,
        package_name="soundfile",
        description="Fish Audio S2 导出参考音频需要 soundfile。",
    )

    waveform = audio_dict["waveform"]       # [B, C, S]
    sample_rate = audio_dict["sample_rate"]

    wav = waveform[0]                                       # [C, S]
    wav = wav.permute(1, 0).cpu().float().numpy()           # [S, C]

    if wav.ndim == 2 and wav.shape[1] == 1:
        wav = wav[:, 0]                                     # mono → 1-D

    buf = io.BytesIO()
    sf.write(buf, wav, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def numpy_audio_to_comfy(audio_np: np.ndarray, sample_rate: int) -> dict:
    """
    Convert numpy audio → ComfyUI AUDIO dict.
    Input:  1-D [S]  or  2-D [S, C]
    Output: {"waveform": Tensor[1, C, S], "sample_rate": int}
    """
    if audio_np.ndim == 1:
        audio_np = audio_np[np.newaxis, np.newaxis, :]      # [1, 1, S]
    else:
        audio_np = audio_np.T[np.newaxis, :]                # [1, C, S]

    waveform = torch.from_numpy(audio_np).float().contiguous()
    return {"waveform": waveform, "sample_rate": sample_rate}
