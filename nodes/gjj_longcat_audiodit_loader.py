import io
import logging
import re
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from .common_utils.dependency_checker import (
    load_dependency_at_runtime,
    make_missing_model_spec,
    raise_dependency_model_error,
)

logger = logging.getLogger("LongCatAudioDiT")
NODE_DISPLAY_NAME = "📢 语音克隆TTS(LongCat AudioDiT)"

VENDOR_ROOT = Path(__file__).resolve().parent.parent / "vendor"
if str(VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_ROOT))

# Suppress verbose transformers warnings about logits processors
logging.getLogger("transformers").setLevel(logging.ERROR)

MODELS_FOLDER_NAME = "audiodit"
HF_MODELS_FOLDER_NAME = MODELS_FOLDER_NAME
LOCAL_MODEL_PLACEHOLDER = "[未找到本地LongCat AudioDiT模型]"
RUNTIME_INSTALL_PACKAGES = [
    "transformers",
    "soundfile",
    "huggingface_hub",
    "librosa",
    "safetensors",
]


def _get_models_base() -> Path:
    try:
        import folder_paths

        base = Path(folder_paths.models_dir) / MODELS_FOLDER_NAME
    except ImportError:
        base = Path(__file__).resolve().parent.parent / "checkpoints"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _register_folder():
    try:
        import folder_paths

        base = str(_get_models_base())
        folder_paths.add_model_folder_path(MODELS_FOLDER_NAME, base)
        logger.info(f"Models folder registered: {base}")
    except ImportError:
        pass


HF_MODELS = {
    "LongCat-AudioDiT-1B": {
        "repo_id": "meituan-longcat/LongCat-AudioDiT-1B",
        "url": "https://huggingface.co/meituan-longcat/LongCat-AudioDiT-1B",
        "description": "1B params (FP32 ~6GB)",
    },
    "LongCat-AudioDiT-3.5B": {
        "repo_id": "meituan-longcat/LongCat-AudioDiT-3.5B",
        "url": "https://huggingface.co/meituan-longcat/LongCat-AudioDiT-3.5B",
        "description": "3.5B params (FP32 ~14GB)",
    },
    "LongCat-AudioDiT-3.5B-bf16": {
        "repo_id": "drbaph/LongCat-AudioDiT-3.5B-bf16",
        "url": "https://huggingface.co/drbaph/LongCat-AudioDiT-3.5B-bf16",
        "description": "3.5B params (~7GB VRAM, bf16 quantized)",
    },
    "LongCat-AudioDiT-3.5B-fp8": {
        "repo_id": "drbaph/LongCat-AudioDiT-3.5B-fp8",
        "url": "https://huggingface.co/drbaph/LongCat-AudioDiT-3.5B-fp8",
        "description": "3.5B params (~4GB VRAM, fp8 quantized, dequantized to bf16 at load)",
    },
}
HF_DEFAULT_MODEL_NAME = "LongCat-AudioDiT-3.5B-bf16"
HF_TOKENIZER_ID = "google/umt5-base"
_LOCAL_TOKENIZER_DIR = "umt5-base-tokenizer"


def _get_tokenizer_path() -> Path:
    """Return the local directory where the UMT5 tokenizer is cached."""
    return _get_models_base() / _LOCAL_TOKENIZER_DIR


def _ensure_tokenizer_downloaded(tokenizer_model_id: str, unique_id=None) -> Path:
    """Download the tokenizer to a persistent local directory if not already present.

    Returns the local path from which the tokenizer can be loaded offline.
    """
    tok_path = _get_tokenizer_path()

    # Check for a valid local tokenizer (at minimum tokenizer_config.json)
    if tok_path.is_dir() and (tok_path / "tokenizer_config.json").is_file():
        return tok_path

    logger.info(
        f"Downloading tokenizer '{tokenizer_model_id}' for offline use..."
    )

    huggingface_hub = load_dependency_at_runtime(
        module_name="huggingface_hub",
        node_name=NODE_DISPLAY_NAME,
        package_name="huggingface_hub",
        description="自动下载 LongCat AudioDiT tokenizer 需要 huggingface_hub。",
        unique_id=unique_id,
    )
    snapshot_download = huggingface_hub.snapshot_download

    try:
        snapshot_download(
            repo_id=tokenizer_model_id,
            local_dir=str(tok_path),
            # Only download tokenizer files, not model weights
            allow_patterns=[
                "tokenizer*.json",
                "tokenizer_config.json",
                "special_tokens_map.json",
                "added_tokens.json",
                "spiece.model",
                "*.txt",
            ],
        )
        logger.info(f"Tokenizer cached locally at: {tok_path}")
        return tok_path
    except Exception as e:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[
                make_missing_model_spec(
                    label="UMT5 tokenizer",
                    subdir=MODELS_FOLDER_NAME,
                    filename=_LOCAL_TOKENIZER_DIR,
                    description="Tokenizer 下载失败，请手动补齐 tokenizer 文件。",
                )
            ],
            description=f"LongCat AudioDiT tokenizer 下载失败：{tok_path}",
            original_error=str(e),
            unique_id=unique_id,
            title="GJJ 节点模型缺失！",
        )


def _auto_download_model(model_name: str = HF_DEFAULT_MODEL_NAME, unique_id=None) -> bool:
    if model_name not in HF_MODELS:
        logger.error(f"Unknown model: {model_name}")
        return False

    cfg = HF_MODELS[model_name]
    repo_id = cfg["repo_id"]
    dest = _get_models_base() / model_name

    if dest.is_dir() and any(dest.iterdir()):
        return True

    logger.info(
        f"Downloading '{model_name}' ({cfg['description']}) from HuggingFace..."
    )
    logger.info(f"Repo: {repo_id}")
    logger.info(f"Destination: {dest}")

    huggingface_hub = load_dependency_at_runtime(
        module_name="huggingface_hub",
        node_name=NODE_DISPLAY_NAME,
        package_name="huggingface_hub",
        description="自动下载 LongCat AudioDiT 模型需要 huggingface_hub。",
        unique_id=unique_id,
    )
    snapshot_download = huggingface_hub.snapshot_download

    try:
        snapshot_download(
            repo_id=repo_id,
            local_dir=str(dest),
            ignore_patterns=["*.msgpack", "flax_model*", "tf_model*", "*.h5"],
        )
        logger.info(f"Model downloaded to: {dest}")
        return True
    except Exception as e:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=[
                make_missing_model_spec(
                    label=model_name,
                    subdir=MODELS_FOLDER_NAME,
                    filename=model_name,
                    description="模型自动下载失败，请手动下载后放入对应目录。",
                )
            ],
            description=f"LongCat AudioDiT 模型下载失败：{dest}",
            original_error=str(e),
            unique_id=unique_id,
            title="GJJ 节点模型缺失！",
        )


def _is_model_downloaded(model_name: str) -> bool:
    base = _get_models_base()
    model_path = base / model_name
    if not model_path.is_dir():
        return False
    has_config = (model_path / "config.json").is_file()
    has_weights = any(
        f.suffix in {".safetensors", ".pt", ".pth", ".ckpt", ".bin"}
        for f in model_path.iterdir()
        if f.is_file()
    )
    return has_config or has_weights


def get_model_names() -> list[str]:
    base = _get_models_base()
    names = []
    for model_name in HF_MODELS.keys():
        if _is_model_downloaded(model_name):
            names.append(model_name)
        else:
            names.append(f"{model_name} (auto download)")
    try:
        for entry in sorted(base.iterdir()):
            if not entry.is_dir():
                continue
            if entry.name in HF_MODELS:
                continue
            has_config = (entry / "config.json").is_file()
            has_weights = any(
                f.suffix in {".safetensors", ".pt", ".pth", ".ckpt", ".bin"}
                for f in entry.iterdir()
                if f.is_file()
            )
            if has_config or has_weights:
                names.append(entry.name)
    except OSError:
        pass
    return names


_AUTO_DOWNLOAD_SUFFIX = " (auto download)"


def _strip_auto_download_suffix(name: str) -> str:
    if name.endswith(_AUTO_DOWNLOAD_SUFFIX):
        return name[: -len(_AUTO_DOWNLOAD_SUFFIX)]
    return name


def resolve_model_path(name: str, unique_id=None) -> Path:
    name = _strip_auto_download_suffix(name)
    path = _get_models_base() / name
    if not path.is_dir() or not any(path.iterdir() if path.exists() else []):
        if name in HF_MODELS:
            logger.info(
                f"Model '{name}' not found locally — "
                "downloading from HuggingFace at inference time..."
            )
            _auto_download_model(name, unique_id=unique_id)
        else:
            raise_dependency_model_error(
                node_name=NODE_DISPLAY_NAME,
                missing_models=[
                    make_missing_model_spec(
                        label=name,
                        subdir=MODELS_FOLDER_NAME,
                        filename=name,
                        description="请把模型目录放到 models/audiodit/ 下。",
                    )
                ],
                description=f"Model folder not found: {path}",
                unique_id=unique_id,
                title="GJJ 节点模型缺失！",
            )
    return path


def _supports_bfloat16() -> bool:
    if not torch.cuda.is_available():
        return False
    try:
        major, minor = torch.cuda.get_device_capability()
        return major >= 8
    except Exception:
        return False


def resolve_device(device_choice: str) -> tuple[str, torch.dtype]:
    if device_choice == "auto":
        if torch.cuda.is_available():
            dtype = torch.bfloat16 if _supports_bfloat16() else torch.float16
            return "cuda", dtype
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps", torch.float16
        logger.warning("No CUDA or MPS GPU detected — falling back to CPU.")
        return "cpu", torch.float32
    if device_choice == "cuda":
        dtype = torch.bfloat16 if _supports_bfloat16() else torch.float16
        return "cuda", dtype
    if device_choice == "mps":
        return "mps", torch.float16
    return "cpu", torch.float32


def resolve_precision(precision_choice: str, device: str) -> torch.dtype:
    if precision_choice == "auto":
        if device == "cuda":
            return torch.bfloat16 if _supports_bfloat16() else torch.float16
        elif device == "mps":
            return torch.float16
        else:
            return torch.float32
    if precision_choice == "bf16":
        if device == "cuda" and not _supports_bfloat16():
            logger.warning(
                "bfloat16 requested but GPU does not support it (compute capability < 8.0). "
                "Consider using 'fp16' instead."
            )
        return torch.bfloat16
    if precision_choice == "fp16":
        return torch.float16
    return torch.float32


def normalize_text(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[\u0022\u201c\u201d\u2018\u2019]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text


def approx_duration_from_text(text: str, max_duration: float = 30.0) -> float:
    EN_DUR_PER_CHAR = 0.082
    ZH_DUR_PER_CHAR = 0.21
    text = re.sub(r"\s+", "", text)
    num_zh = num_en = num_other = 0
    for c in text:
        if "\u4e00" <= c <= "\u9fff":
            num_zh += 1
        elif c.isalpha():
            num_en += 1
        else:
            num_other += 1
    if num_zh > num_en:
        num_zh += num_other
    else:
        num_en += num_other
    return min(max_duration, num_zh * ZH_DUR_PER_CHAR + num_en * EN_DUR_PER_CHAR)


def patch_attention(model, attention: str, device: str):
    if attention == "auto":
        return

    if device != "cuda":
        if attention in ("sage_attention", "flash_attention"):
            logger.warning(
                f"{attention} is only supported on CUDA. "
                f"Falling back to sdpa on {device}."
            )
            attention = "sdpa"

    if attention == "sdpa":
        _patch_sdpa(model)
    elif attention == "flash_attention":
        _patch_flash_attention(model)
    elif attention == "sage_attention":
        _patch_sage_attention(model)


def _patch_sdpa(model):
    import torch.nn.functional as F

    def _self_attn_forward(self, x, mask=None, rope=None):
        batch_size = x.shape[0]
        query = self.to_q(x)
        key = self.to_k(x)
        value = self.to_v(x)
        if self.qk_norm:
            query = self.q_norm(query)
            key = self.k_norm(key)
        head_dim = self.inner_dim // self.heads
        query = query.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        key = key.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        value = value.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        if rope is not None:
            from audiodit.modeling_audiodit import _apply_rotary_emb

            query = _apply_rotary_emb(query, rope)
            key = _apply_rotary_emb(key, rope)
        attn_mask = None
        if mask is not None:
            attn_mask = (
                mask.unsqueeze(1)
                .unsqueeze(1)
                .expand(batch_size, self.heads, query.shape[-2], key.shape[-2])
            )
        x = F.scaled_dot_product_attention(
            query, key, value, attn_mask=attn_mask, dropout_p=0.0, is_causal=False
        )
        x = x.transpose(1, 2).reshape(batch_size, -1, self.inner_dim).to(query.dtype)
        x = self.to_out[0](x)
        x = self.to_out[1](x)
        return x

    def _cross_attn_forward(
        self, x, cond, mask=None, cond_mask=None, rope=None, cond_rope=None
    ):
        from audiodit.modeling_audiodit import _apply_rotary_emb

        batch_size = x.shape[0]
        query = self.to_q(x)
        key = self.to_k(cond)
        value = self.to_v(cond)
        if self.qk_norm:
            query = self.q_norm(query)
            key = self.k_norm(key)
        head_dim = self.inner_dim // self.heads
        query = query.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        key = key.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        value = value.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        if rope is not None:
            query = _apply_rotary_emb(query, rope)
        if cond_rope is not None:
            key = _apply_rotary_emb(key, cond_rope)
        attn_mask = None
        if mask is not None:
            attn_mask = (
                cond_mask.unsqueeze(1).expand(-1, mask.shape[1], -1).unsqueeze(1)
            )
            attn_mask = attn_mask.expand(
                batch_size, self.heads, query.shape[-2], key.shape[-2]
            )
        x = F.scaled_dot_product_attention(
            query, key, value, attn_mask=attn_mask, dropout_p=0.0, is_causal=False
        )
        x = x.transpose(1, 2).reshape(batch_size, -1, self.inner_dim).to(query.dtype)
        x = self.to_out[0](x)
        x = self.to_out[1](x)
        return x

    from audiodit.modeling_audiodit import AudioDiTSelfAttention, AudioDiTCrossAttention
    import types

    for module in model.modules():
        if isinstance(module, AudioDiTSelfAttention):
            module.forward = types.MethodType(_self_attn_forward, module)
        elif isinstance(module, AudioDiTCrossAttention):
            module.forward = types.MethodType(_cross_attn_forward, module)
    logger.info("Patched all attention modules with SDPA.")


def _patch_flash_attention(model):
    import torch.nn.functional as F

    # Try to import flash_attn package directly (more reliable than SDPA backend)
    try:
        from flash_attn import flash_attn_func
        _has_flash_attn = True
        logger.info("Using flash_attn package directly for FlashAttention.")
    except ImportError:
        _has_flash_attn = False

    # Also try to import SDPA kernel for fallback (needed when flash_attn doesn't support masks)
    _sdpa_kernel = None
    _SDPBackend = None
    try:
        from torch.nn.attention import SDPBackend, sdpa_kernel as _sdpa_kernel_impl
        _sdpa_kernel = _sdpa_kernel_impl
        _SDPBackend = SDPBackend
        if not _has_flash_attn:
            logger.info("Using SDPA with FlashAttention backend preference.")
    except ImportError:
        if not _has_flash_attn:
            logger.warning(
                "FlashAttention requested but neither flash_attn package nor "
                "torch.nn.attention.sdpa_kernel available. Falling back to default SDPA."
            )
            _patch_sdpa(model)
            return

    # Track if we've already warned about FlashAttention fallback
    _flash_fallback_warned = False

    def _self_attn_forward(self, x, mask=None, rope=None):
        nonlocal _flash_fallback_warned
        batch_size = x.shape[0]
        query = self.to_q(x)
        key = self.to_k(x)
        value = self.to_v(x)
        if self.qk_norm:
            query = self.q_norm(query)
            key = self.k_norm(key)
        head_dim = self.inner_dim // self.heads
        query = query.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        key = key.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        value = value.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        if rope is not None:
            from audiodit.modeling_audiodit import _apply_rotary_emb

            query = _apply_rotary_emb(query, rope)
            key = _apply_rotary_emb(key, rope)

        # FlashAttention from flash_attn package doesn't support attention masks
        # Fall back to SDPA if mask is provided
        if mask is not None:
            attn_mask = (
                mask.unsqueeze(1)
                .unsqueeze(1)
                .expand(batch_size, self.heads, query.shape[-2], key.shape[-2])
            )
            x = F.scaled_dot_product_attention(
                query, key, value, attn_mask=attn_mask, dropout_p=0.0, is_causal=False
            )
        elif _has_flash_attn:
            # Use flash_attn package directly - expects (batch, seqlen, nheads, headdim)
            q = query.transpose(1, 2)  # (batch, seqlen, nheads, headdim)
            k = key.transpose(1, 2)
            v = value.transpose(1, 2)
            x = flash_attn_func(q, k, v, dropout_p=0.0, causal=False)
            x = x.transpose(1, 2)  # Back to (batch, nheads, seqlen, headdim)
        elif _sdpa_kernel is not None:
            # Use SDPA with FlashAttention preference
            try:
                with _sdpa_kernel(_SDPBackend.FLASH_ATTENTION):
                    x = F.scaled_dot_product_attention(
                        query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False
                    )
            except RuntimeError as e:
                if "No available kernel" in str(e):
                    if not _flash_fallback_warned:
                        logger.warning(
                            "FlashAttention not available in this PyTorch build. "
                            "Falling back to default SDPA."
                        )
                        _flash_fallback_warned = True
                    x = F.scaled_dot_product_attention(
                        query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False
                    )
                else:
                    raise
        else:
            # Fallback to plain SDPA
            x = F.scaled_dot_product_attention(
                query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False
            )

        x = x.transpose(1, 2).reshape(batch_size, -1, self.inner_dim).to(query.dtype)
        x = self.to_out[0](x)
        x = self.to_out[1](x)
        return x

    def _cross_attn_forward(
        self, x, cond, mask=None, cond_mask=None, rope=None, cond_rope=None
    ):
        nonlocal _flash_fallback_warned
        from audiodit.modeling_audiodit import _apply_rotary_emb

        batch_size = x.shape[0]
        query = self.to_q(x)
        key = self.to_k(cond)
        value = self.to_v(cond)
        if self.qk_norm:
            query = self.q_norm(query)
            key = self.k_norm(key)
        head_dim = self.inner_dim // self.heads
        query = query.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        key = key.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        value = value.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        if rope is not None:
            query = _apply_rotary_emb(query, rope)
        if cond_rope is not None:
            key = _apply_rotary_emb(key, cond_rope)

        # Cross-attention often has masks
        attn_mask = None
        if mask is not None:
            attn_mask = (
                cond_mask.unsqueeze(1).expand(-1, mask.shape[1], -1).unsqueeze(1)
            )
            attn_mask = attn_mask.expand(
                batch_size, self.heads, query.shape[-2], key.shape[-2]
            )

        if attn_mask is not None:
            # flash_attn doesn't support masks, use plain SDPA
            x = F.scaled_dot_product_attention(
                query, key, value, attn_mask=attn_mask, dropout_p=0.0, is_causal=False
            )
        elif _has_flash_attn:
            # Use flash_attn package directly
            q = query.transpose(1, 2)
            k = key.transpose(1, 2)
            v = value.transpose(1, 2)
            x = flash_attn_func(q, k, v, dropout_p=0.0, causal=False)
            x = x.transpose(1, 2)
        elif _sdpa_kernel is not None:
            # Use SDPA with FlashAttention preference
            try:
                with _sdpa_kernel(_SDPBackend.FLASH_ATTENTION):
                    x = F.scaled_dot_product_attention(
                        query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False
                    )
            except RuntimeError as e:
                if "No available kernel" in str(e):
                    if not _flash_fallback_warned:
                        logger.warning(
                            "FlashAttention not available in this PyTorch build. "
                            "Falling back to default SDPA."
                        )
                        _flash_fallback_warned = True
                    x = F.scaled_dot_product_attention(
                        query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False
                    )
                else:
                    raise
        else:
            # Fallback to plain SDPA
            x = F.scaled_dot_product_attention(
                query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False
            )

        x = x.transpose(1, 2).reshape(batch_size, -1, self.inner_dim).to(query.dtype)
        x = self.to_out[0](x)
        x = self.to_out[1](x)
        return x

    from audiodit.modeling_audiodit import AudioDiTSelfAttention, AudioDiTCrossAttention
    import types

    patched = 0
    for module in model.modules():
        if isinstance(module, AudioDiTSelfAttention):
            module.forward = types.MethodType(_self_attn_forward, module)
            patched += 1
        elif isinstance(module, AudioDiTCrossAttention):
            module.forward = types.MethodType(_cross_attn_forward, module)
            patched += 1
    logger.info(f"Patched {patched} attention modules with FlashAttention.")


def _patch_sage_attention(model):
    sageattention_module = load_dependency_at_runtime(
        module_name="sageattention",
        node_name=NODE_DISPLAY_NAME,
        package_name="sageattention",
        description="LongCat AudioDiT 的 SageAttention 模式需要 sageattention。",
    )
    sageattn = sageattention_module.sageattn

    import torch.nn.functional as F

    def _self_attn_forward(self, x, mask=None, rope=None):
        from audiodit.modeling_audiodit import _apply_rotary_emb

        batch_size = x.shape[0]
        query = self.to_q(x)
        key = self.to_k(x)
        value = self.to_v(x)
        if self.qk_norm:
            query = self.q_norm(query)
            key = self.k_norm(key)
        head_dim = self.inner_dim // self.heads
        query = query.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        key = key.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        value = value.view(batch_size, -1, self.heads, head_dim).transpose(1, 2)
        if rope is not None:
            query = _apply_rotary_emb(query, rope)
            key = _apply_rotary_emb(key, rope)
        if mask is None:
            x = sageattn(query, key, value, is_causal=False)
        else:
            attn_mask = (
                mask.unsqueeze(1)
                .unsqueeze(1)
                .expand(batch_size, self.heads, query.shape[-2], key.shape[-2])
            )
            x = F.scaled_dot_product_attention(
                query, key, value, attn_mask=attn_mask, dropout_p=0.0, is_causal=False
            )
        x = x.transpose(1, 2).reshape(batch_size, -1, self.inner_dim).to(query.dtype)
        x = self.to_out[0](x)
        x = self.to_out[1](x)
        return x

    from audiodit.modeling_audiodit import AudioDiTSelfAttention
    import types

    patched = 0
    for module in model.modules():
        if isinstance(module, AudioDiTSelfAttention):
            module.forward = types.MethodType(_self_attn_forward, module)
            patched += 1
    logger.info(f"Patched {patched} self-attention modules with SageAttention.")


def _is_fp8_model(model_path: Path) -> bool:
    return (model_path / "fp8_scales.json").is_file()


def _has_safetensors_metadata(model_path: Path) -> bool:
    """Check if safetensors file has proper format metadata.

    Original meituan-longcat models have safetensors without metadata,
    which causes transformers.from_pretrained to fail.
    """
    safetensors_module = load_dependency_at_runtime(
        module_name="safetensors",
        node_name=NODE_DISPLAY_NAME,
        package_name="safetensors",
        description="LongCat AudioDiT 读取 safetensors 模型需要 safetensors。",
    )
    safe_open = safetensors_module.safe_open

    safetensors_path = model_path / "model.safetensors"
    if not safetensors_path.exists():
        return True  # No safetensors, let normal path handle it

    try:
        with safe_open(safetensors_path, framework="pt") as f:
            metadata = f.metadata()
            if metadata is None or metadata.get("format") is None:
                return False
            return True
    except Exception:
        return True  # If we can't check, assume it's fine


def _load_model_direct(model_path: Path, model_class, torch_dtype):
    """Load model by directly loading safetensors state dict.

    Fallback for safetensors files without format metadata.
    """
    safetensors_torch = load_dependency_at_runtime(
        module_name="safetensors.torch",
        node_name=NODE_DISPLAY_NAME,
        package_name="safetensors",
        description="LongCat AudioDiT 直接加载 safetensors 模型需要 safetensors。",
    )
    load_file = safetensors_torch.load_file

    # Load config
    config = model_class.config_class.from_pretrained(str(model_path))

    # Create model with config
    model = model_class(config)

    # Load state dict directly from safetensors
    safetensors_path = model_path / "model.safetensors"
    if safetensors_path.exists():
        state_dict = load_file(str(safetensors_path))
        model.load_state_dict(state_dict, strict=False)
        logger.info(f"Loaded model directly from safetensors (no metadata)")
    else:
        raise FileNotFoundError(f"No model.safetensors found in {model_path}")

    return model


def load_model(model_name: str, device: str, precision: str, attention: str, unique_id=None):
    model_name = _strip_auto_download_suffix(model_name)
    model_path = resolve_model_path(model_name, unique_id=unique_id)
    device_str, _ = resolve_device(device)
    dtype = resolve_precision(precision, device_str)

    transformers_module = load_dependency_at_runtime(
        module_name="transformers",
        node_name=NODE_DISPLAY_NAME,
        package_name="transformers",
        description="LongCat AudioDiT 运行时需要 transformers。",
        extra_packages=["huggingface_hub", "safetensors"],
        unique_id=unique_id,
    )
    AutoTokenizer = transformers_module.AutoTokenizer

    try:
        import audiodit
        from audiodit import AudioDiTModel
    except Exception as exc:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=[{
                "module_name": "",
                "package_name": "",
                "display_name": "GJJ 内置 audiodit 运行时",
                "description": "GJJ 自带的 LongCat AudioDiT 运行时代码缺失或损坏。",
            }],
            install_packages=["transformers", "huggingface_hub", "safetensors"],
            description="LongCat AudioDiT 运行时加载失败。",
            original_error=str(exc),
            unique_id=unique_id,
            copy_text="",
            copy_label="",
        )

    fp8 = _is_fp8_model(model_path)

    logger.info(f"Loading LongCat-AudioDiT from: {model_path}")
    if fp8:
        logger.info("FP8 model detected — will dequantize to BF16")
    logger.info(f"Device: {device_str}, Precision: {dtype}")

    torch_device = torch.device(device_str)

    import warnings
    import transformers
    prev_verbosity = transformers.logging.get_verbosity()
    transformers.logging.set_verbosity_error()

    # Check if safetensors has proper metadata (original meituan models don't)
    has_metadata = _has_safetensors_metadata(model_path)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if has_metadata:
            # Normal loading path - safetensors has proper metadata
            # torch_dtype=bfloat16 ensures fp8 tensors in safetensors are
            # properly converted to bf16 during loading by transformers
            model = AudioDiTModel.from_pretrained(
                str(model_path), torch_dtype=torch.bfloat16,
            )
        else:
            # Fallback for safetensors without metadata (original meituan models)
            logger.info("Safetensors has no format metadata — using direct loading")
            model = _load_model_direct(model_path, AudioDiTModel, torch.bfloat16)
    transformers.logging.set_verbosity(prev_verbosity)

    # Fix weight_norm params (weight_g/weight_v) that from_pretrained fails to load
    safetensors_path = model_path / "model.safetensors"
    if safetensors_path.exists():
        safetensors_torch = load_dependency_at_runtime(
            module_name="safetensors.torch",
            node_name=NODE_DISPLAY_NAME,
            package_name="safetensors",
            description="LongCat AudioDiT 读取 safetensors 模型需要 safetensors。",
            unique_id=unique_id,
        )
        load_file = safetensors_torch.load_file

        sd = load_file(str(safetensors_path))
        wn_keys = {k: v for k, v in sd.items() if "weight_g" in k or "weight_v" in k}
        if wn_keys:
            model.load_state_dict(wn_keys, strict=False)
            logger.info(f"Fixed {len(wn_keys)} weight_norm params")

        # Dequantize FP8 weights using per-tensor scales
        # from_pretrained does NOT convert fp8→bf16, leaving fp8 params that
        # can't do arithmetic. We dequantize: weight_bf16 = weight_fp8.to(bf16) * scale
        if fp8:
            import json
            scales_file = model_path / "fp8_scales.json"
            if scales_file.exists():
                with open(scales_file) as f:
                    fp8_scales = json.load(f)
                dequantized = 0
                for name, scale_val in fp8_scales.items():
                    if name not in sd:
                        continue
                    tensor = sd[name]
                    if tensor.dtype != torch.float8_e4m3fn:
                        continue
                    # Dequantize: cast to bf16 then multiply by scale
                    deq = tensor.to(torch.bfloat16) * scale_val
                    # Navigate to parent module and replace parameter
                    parts = name.split(".")
                    obj = model
                    for p in parts[:-1]:
                        if p.isdigit():
                            obj = obj[int(p)]
                        else:
                            obj = getattr(obj, p)
                    attr_name = parts[-1]
                    old_param = getattr(obj, attr_name)
                    # Must replace entire Parameter (not copy_) because
                    # old param is fp8 and copy_ would cast bf16→fp8
                    new_param = nn.Parameter(deq, requires_grad=False)
                    setattr(obj, attr_name, new_param)
                    dequantized += 1
                if dequantized > 0:
                    logger.info(
                        f"Dequantized {dequantized} FP8 tensors to BF16 "
                        f"(saves ~{dequantized * 2:.0f}MB download vs bf16 model)"
                    )

    # Always keep VAE in bf16 on CUDA to avoid precision loss in audio decoder
    vae_dtype = torch.bfloat16 if device_str == "cuda" else torch.float32

    # Convert text_encoder and transformer to requested dtype
    # Text encoder stays in bf16 minimum — UMT5 layer_norm overflows in fp16
    _DTYPE_RANK = {torch.float16: 1, torch.bfloat16: 2, torch.float32: 3}
    text_encoder_dtype = dtype if _DTYPE_RANK.get(dtype, 0) >= _DTYPE_RANK[torch.bfloat16] else torch.bfloat16
    if hasattr(model, "text_encoder"):
        model.text_encoder.to(text_encoder_dtype)
    if hasattr(model, "transformer"):
        model.transformer.to(dtype)
    # VAE always stays in bf16 on CUDA for audio quality
    if hasattr(model, "vae"):
        model.vae.to(vae_dtype)
    model.to(torch_device)

    model.eval()

    # Load tokenizer from persistent local cache (works fully offline after first download)
    tokenizer_source = _ensure_tokenizer_downloaded(model.config.text_encoder_model, unique_id=unique_id)
    tokenizer = AutoTokenizer.from_pretrained(
        tokenizer_source, local_files_only=isinstance(tokenizer_source, Path)
    )

    if attention != "auto":
        patch_attention(model, attention, device_str)

    model._vbar_active = False
    model._aimdo_auto = False
    if device_str == "cuda":
        try:
            from .gjj_longcat_audiodit_model_cache import _detect_vbar

            vbar_avail, aimdo_avail = _detect_vbar()
            if vbar_avail:
                model._vbar_active = True
                logger.info("ComfyUI Dynamic VRAM (VBAR explicit) detected")
            elif aimdo_avail:
                model._aimdo_auto = True
                logger.info("ComfyUI Dynamic VRAM (aimdo auto-allocator) detected")
        except Exception:
            pass

    return model, tokenizer


def numpy_audio_to_comfy(audio_np: np.ndarray, sample_rate: int) -> dict:
    if audio_np.ndim == 1:
        audio_np = audio_np[np.newaxis, np.newaxis, :]
    else:
        audio_np = audio_np.T[np.newaxis, :]
    waveform = torch.from_numpy(audio_np).float().contiguous()
    return {"waveform": waveform, "sample_rate": sample_rate}
