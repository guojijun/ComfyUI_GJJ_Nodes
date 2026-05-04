from __future__ import annotations

import gc
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import comfy.utils
import folder_paths
import torch
import torch.nn.functional as F
from einops import rearrange


MODEL_DIR_NAME = "FlashVSR"
MODEL_CATEGORY = "flashvsr"
DEFAULT_MODEL_LAYOUT = "自动检测"
MODEL_LAYOUTS = [
    "自动检测",
    "1038lab safetensors",
    "JunhaoZhuang FlashVSR-v1.1",
    "JunhaoZhuang FlashVSR",
]


@dataclass(frozen=True)
class FlashVSRModelBundle:
    name: str
    root: Path
    checkpoint: Path
    vae: Path | None
    lq: Path
    tcdecoder: Path
    prompt: Path
    lq_projection: str


@dataclass(frozen=True)
class _ModelCandidate:
    name: str
    path: Path


def get_device_list() -> list[str]:
    devices = ["auto"]
    try:
        if torch.cuda.is_available():
            devices.extend([f"cuda:{index}" for index in range(torch.cuda.device_count())])
    except Exception:
        pass
    try:
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            devices.append("mps")
    except Exception:
        pass
    if "cpu" not in devices:
        devices.append("cpu")
    return devices


def clean_vram() -> None:
    gc.collect()
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass
    try:
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass


def log(message: str, level: str = "info") -> None:
    print(f"[GJJ FlashVSR] {message}")


def _model_base_dirs() -> list[Path]:
    bases = [Path(folder_paths.models_dir)]
    try:
        mod_root = Path(__file__).resolve().parents[3]
        local_models = mod_root / "models"
        if local_models.exists():
            bases.append(local_models)
    except Exception:
        pass

    deduped = []
    seen = set()
    for base in bases:
        try:
            key = str(base.resolve()).lower()
        except Exception:
            key = str(base).lower()
        if key not in seen:
            seen.add(key)
            deduped.append(base)
    return deduped


def _models_root(base: Path | None = None) -> Path:
    return (base or _model_base_dirs()[0]) / MODEL_DIR_NAME


def _normalize_model_text(value: str | Path | None) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _path_key(path: Path) -> str:
    try:
        return str(path.resolve()).lower()
    except Exception:
        return str(path).lower()


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False


def _dedupe_paths(paths: list[Path]) -> list[Path]:
    deduped: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        key = _path_key(path)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(path)
    return deduped


def _flashvsr_model_dirs() -> list[Path]:
    candidates: list[Path] = []
    for base in _model_base_dirs():
        candidates.extend([
            base / MODEL_DIR_NAME,
            base / "FlashVSR-v1.1",
            base / "diffusion_models",
            base / "unet",
            base / "ckpts",
        ])
        try:
            for child in base.iterdir():
                if child.is_dir() and "flashvsr" in _normalize_model_text(child.name):
                    candidates.append(child)
        except Exception:
            pass
    return _dedupe_paths(candidates)


def _ensure_flashvsr_model_paths() -> None:
    paths = [str(path) for path in _flashvsr_model_dirs()]
    extensions = tuple(sorted(set(getattr(folder_paths, "supported_pt_extensions", set())) | {
        ".safetensors",
        ".ckpt",
        ".pth",
        ".pt",
    }))
    if MODEL_CATEGORY not in folder_paths.folder_names_and_paths:
        folder_paths.folder_names_and_paths[MODEL_CATEGORY] = (paths, extensions)
        return

    current_paths, current_exts = folder_paths.folder_names_and_paths[MODEL_CATEGORY]
    merged_paths: list[str] = []
    for item in list(current_paths) + paths:
        if item not in merged_paths:
            merged_paths.append(item)
    merged_exts = tuple(sorted(set(current_exts or extensions) | set(extensions)))
    folder_paths.folder_names_and_paths[MODEL_CATEGORY] = (merged_paths, merged_exts)


def _resolve_registered_file(name: str) -> Path | None:
    try:
        full_path = folder_paths.get_full_path(MODEL_CATEGORY, name)
    except Exception:
        full_path = None
    if full_path:
        path = Path(full_path)
        if path.is_file():
            return path

    normalized = str(name or "").replace("\\", "/")
    basename = Path(normalized).name.lower()
    for root in _flashvsr_model_dirs():
        if not root.exists():
            continue
        direct = root / normalized
        if direct.is_file():
            return direct
        for path in root.rglob("*"):
            if path.is_file() and path.name.lower() == basename:
                return path
    return None


def _registered_model_candidates() -> list[_ModelCandidate]:
    _ensure_flashvsr_model_paths()
    candidates: list[_ModelCandidate] = []
    seen: set[str] = set()

    try:
        names = list(folder_paths.get_filename_list(MODEL_CATEGORY))
    except Exception:
        names = []

    for name in names:
        path = _resolve_registered_file(str(name))
        if not path or not path.is_file():
            continue
        key = _path_key(path)
        if key in seen:
            continue
        seen.add(key)
        candidates.append(_ModelCandidate(str(name), path))

    for root in _flashvsr_model_dirs():
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in {".safetensors", ".ckpt", ".pth", ".pt"}:
                continue
            key = _path_key(path)
            if key in seen:
                continue
            seen.add(key)
            try:
                rel = str(path.relative_to(root)).replace("/", "\\")
            except Exception:
                rel = path.name
            candidates.append(_ModelCandidate(rel, path))

    return sorted(candidates, key=lambda item: (item.path.parent.as_posix().lower(), item.path.name.lower()))


def _scope_candidates(candidates: list[_ModelCandidate], roots: list[Path]) -> list[_ModelCandidate]:
    scoped: list[_ModelCandidate] = []
    seen: set[str] = set()
    existing_roots = [root for root in roots if root]
    for candidate in candidates:
        if existing_roots and not any(_is_relative_to(candidate.path, root) for root in existing_roots):
            continue
        key = _path_key(candidate.path)
        if key in seen:
            continue
        seen.add(key)
        scoped.append(candidate)
    return scoped


def _candidate_score(
    candidate: _ModelCandidate,
    names: list[str],
    *,
    include_all: tuple[str, ...] = (),
    include_any: tuple[str, ...] = (),
    exclude_any: tuple[str, ...] = (),
    require_path_any: tuple[str, ...] = (),
    prefer_fp8: bool = False,
    match_filters: bool = True,
) -> int | None:
    base = candidate.path.name.lower()
    rel = candidate.name.replace("\\", "/").lower()
    full = str(candidate.path).replace("\\", "/").lower()
    canonical_base = _normalize_model_text(base)
    canonical_full = _normalize_model_text(full)
    canonical_rel = _normalize_model_text(rel)

    if any(_normalize_model_text(term) in canonical_full for term in exclude_any):
        return None
    if require_path_any and not any(_normalize_model_text(term) in canonical_full for term in require_path_any):
        return None
    if include_all and not all(_normalize_model_text(term) in canonical_full for term in include_all):
        return None
    if include_any and not any(_normalize_model_text(term) in canonical_full for term in include_any):
        return None

    score = 0
    matched = False
    for index, name in enumerate(names):
        desired = str(name or "").replace("\\", "/").lower()
        desired_base = Path(desired).name.lower()
        desired_canonical = _normalize_model_text(desired_base)
        if not desired:
            continue
        if rel == desired or full.endswith("/" + desired):
            score = max(score, 1000 - index)
            matched = True
        if base == desired_base:
            score = max(score, 900 - index)
            matched = True
        if desired_canonical and canonical_base == desired_canonical:
            score = max(score, 800 - index)
            matched = True
        if desired_canonical and desired_canonical in canonical_rel:
            score = max(score, 700 - index)
            matched = True

    if match_filters and (include_all or include_any):
        matched = True
        score = max(score, 500)

    if not matched:
        return None

    if prefer_fp8 and any(token in canonical_full for token in ("fp8", "float8", "e4m3", "e5m2")):
        score += 1200
    if "flashvsr" in canonical_full:
        score += 80
    if "v11" in canonical_full or "11" in canonical_base:
        score += 20
    return score


def _pick_model_file(
    candidates: list[_ModelCandidate],
    names: list[str],
    *,
    include_all: tuple[str, ...] = (),
    include_any: tuple[str, ...] = (),
    exclude_any: tuple[str, ...] = (),
    require_path_any: tuple[str, ...] = (),
    prefer_fp8: bool = False,
    match_filters: bool = True,
) -> Path | None:
    ranked: list[tuple[int, str, Path]] = []
    for candidate in candidates:
        score = _candidate_score(
            candidate,
            names,
            include_all=include_all,
            include_any=include_any,
            exclude_any=exclude_any,
            require_path_any=require_path_any,
            prefer_fp8=prefer_fp8,
            match_filters=match_filters,
        )
        if score is None:
            continue
        ranked.append((-score, str(candidate.path).lower(), candidate.path))
    if not ranked:
        return None
    ranked.sort()
    return ranked[0][2]


def _find_bundle(root: Path, name: str, main_names: list[str], *, require_vae: bool, lq_projection: str) -> FlashVSRModelBundle | None:
    all_candidates = _registered_model_candidates()
    root_candidates = _scope_candidates(all_candidates, [root])
    main_excludes = ("lq", "lqproj", "tcdecoder", "tcdecoder", "vae", "prompt", "lora", "adapter", "metadata")
    checkpoint = _pick_model_file(
        root_candidates,
        main_names,
        include_any=("flashvsr", "streamingdmd"),
        exclude_any=main_excludes,
        prefer_fp8=True,
    )
    if not checkpoint:
        checkpoint = _pick_model_file(
            all_candidates,
            main_names,
            include_any=("flashvsr",),
            exclude_any=main_excludes,
            prefer_fp8=True,
            match_filters=False,
        )

    helper_roots = [root]
    if checkpoint:
        helper_roots.append(checkpoint.parent)
    for base in _model_base_dirs():
        helper_roots.extend([base / MODEL_DIR_NAME, base / "FlashVSR-v1.1"])
    helper_candidates = _scope_candidates(all_candidates, _dedupe_paths(helper_roots))

    if lq_projection == "causal":
        lq_names = [
            "LQ_proj_in.ckpt",
            "LQ_proj_in.safetensors",
            "Wan2_1_FlashVSR_LQ_proj_model_bf16.safetensors",
        ]
        tcdecoder_names = [
            "TCDecoder.ckpt",
            "TCDecoder.safetensors",
            "Wan2_1_FlashVSR_TCDecoder_fp32.safetensors",
        ]
        vae_names = [
            "Wan2.1_VAE.pth",
            "Wan2.1_VAE.safetensors",
        ]
    else:
        lq_names = [
            "LQ_proj_in.safetensors",
            "Wan2_1_FlashVSR_LQ_proj_model_bf16.safetensors",
            "LQ_proj_in.ckpt",
        ]
        tcdecoder_names = [
            "TCDecoder.safetensors",
            "Wan2_1_FlashVSR_TCDecoder_fp32.safetensors",
            "TCDecoder.ckpt",
        ]
        vae_names = [
            "Wan2.1_VAE.safetensors",
            "Wan2.1_VAE.pth",
        ]

    lq = _pick_model_file(helper_candidates, lq_names, include_any=("lqproj", "lq"))
    tcdecoder = _pick_model_file(helper_candidates, tcdecoder_names, include_any=("tcdecoder",))
    prompt = _pick_model_file(helper_candidates, [
        "Prompt.safetensors",
        "posi_prompt.pth",
    ], include_any=("prompt", "posiprompt")) or (Path(__file__).resolve().parents[1] / "vendor" / "flashvsr" / "posi_prompt.pth")
    vae = _pick_model_file(helper_candidates, vae_names, include_all=("vae",), exclude_any=("wan22", "wan2.2"))

    if not checkpoint or not lq or not tcdecoder or not prompt.exists():
        return None
    if require_vae and not vae:
        return None

    return FlashVSRModelBundle(
        name=name,
        root=root,
        checkpoint=checkpoint,
        vae=vae,
        lq=lq,
        tcdecoder=tcdecoder,
        prompt=prompt,
        lq_projection=lq_projection,
    )


def _download_layout(layout: str) -> None:
    try:
        from huggingface_hub import snapshot_download
    except Exception as exc:
        raise RuntimeError("未安装 huggingface_hub，无法自动下载 FlashVSR 模型。请手动把模型放到 ComfyUI/models/FlashVSR。") from exc

    if layout == "JunhaoZhuang FlashVSR-v1.1":
        repo_id = "JunhaoZhuang/FlashVSR-v1.1"
        local_dir = Path(folder_paths.models_dir) / "FlashVSR-v1.1"
    elif layout == "JunhaoZhuang FlashVSR":
        repo_id = "JunhaoZhuang/FlashVSR"
        local_dir = _models_root()
    else:
        repo_id = "1038lab/FlashVSR"
        local_dir = _models_root()
    local_dir.mkdir(parents=True, exist_ok=True)
    snapshot_download(repo_id=repo_id, local_dir=str(local_dir), local_dir_use_symlinks=False, resume_download=True)


def resolve_model_bundle(layout: str, mode: str, auto_download: bool = False) -> FlashVSRModelBundle:
    require_vae = mode == "full"
    roots_and_specs = []

    for models_dir in _model_base_dirs():
        if layout in ("自动检测", "JunhaoZhuang FlashVSR-v1.1"):
            roots_and_specs.append((
                models_dir / "FlashVSR-v1.1",
                "JunhaoZhuang FlashVSR-v1.1",
                ["diffusion_pytorch_model_streaming_dmd.safetensors"],
                "causal",
            ))
        if layout in ("自动检测", "1038lab safetensors"):
            roots_and_specs.append((
                _models_root(models_dir),
                "1038lab safetensors",
                [
                    "FlashVSR1_1.safetensors",
                    "Wan2_1-T2V-1.1_3B_FlashVSR_fp32.safetensors",
                    "Wan2_1-T2V-1_3B_FlashVSR_fp32.safetensors",
                ],
                "buffer",
            ))
        if layout in ("自动检测", "JunhaoZhuang FlashVSR"):
            roots_and_specs.append((
                _models_root(models_dir),
                "JunhaoZhuang FlashVSR",
                ["diffusion_pytorch_model_streaming_dmd.safetensors"],
                "buffer",
            ))

    for root, bundle_name, main_names, projection in roots_and_specs:
        bundle = _find_bundle(root, bundle_name, main_names, require_vae=require_vae, lq_projection=projection)
        if bundle:
            return bundle

    if auto_download:
        _download_layout(layout)
        return resolve_model_bundle(layout, mode, auto_download=False)

    checked_paths = _dedupe_paths([root for root, _, _, _ in roots_and_specs] + _flashvsr_model_dirs())
    checked = "\n".join(f"- {root}" for root in checked_paths)
    raise FileNotFoundError(
        "未找到可用的 FlashVSR 模型文件。\n"
        f"已检查：\n{checked}\n"
        "会按精确名、basename、规范化模糊匹配搜索子目录；主模型候选优先 fp8/e4m3/e5m2。\n"
        "1038lab safetensors 目录至少需要主模型、LQ、TCDecoder、Prompt；Full 模式还需要 VAE。\n"
        "常见主模型名：FlashVSR1_1.safetensors、Wan2_1-T2V-1.1_3B_FlashVSR_fp32.safetensors、"
        "diffusion_pytorch_model_streaming_dmd.safetensors。"
    )


def _setup_device(device_name: str) -> str:
    device = device_name
    if device_name == "auto":
        if torch.cuda.is_available():
            device = "cuda:0"
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    if str(device).startswith("cuda"):
        torch.cuda.set_device(device)
    return device


def _dtype_from_name(precision: str) -> torch.dtype:
    return torch.float16 if precision == "fp16" else torch.bfloat16


def _load_torch_state(path: Path, device: str = "cpu") -> dict[str, torch.Tensor]:
    if path.suffix.lower() == ".safetensors":
        from safetensors.torch import load_file

        return load_file(str(path), device=device)
    return torch.load(str(path), map_location=device, weights_only=False)


def _load_prompt_tensor(path: Path, device: str) -> torch.Tensor:
    loaded = _load_torch_state(path, device=device)
    if isinstance(loaded, torch.Tensor):
        return loaded
    if not isinstance(loaded, dict):
        raise RuntimeError(f"FlashVSR Prompt 文件格式无法识别：{path}")
    for key in ("posi_prompt", "context"):
        value = loaded.get(key)
        if isinstance(value, torch.Tensor):
            return value
    tensor_values = [value for value in loaded.values() if isinstance(value, torch.Tensor)]
    if len(tensor_values) == 1:
        return tensor_values[0]
    raise RuntimeError(f"FlashVSR Prompt 文件中没有唯一的文本条件张量：{path}")


def _clean_lq_state(state: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
    prefix = "LQ_proj_in."
    cleaned = {}
    for key, value in state.items():
        cleaned[key[len(prefix):] if key.startswith(prefix) else key] = value
    return cleaned


def _strip_prefix_state(state: dict[str, torch.Tensor], prefix: str) -> dict[str, torch.Tensor]:
    if not any(key.startswith(prefix) for key in state):
        return state
    return {key[len(prefix):] if key.startswith(prefix) else key: value for key, value in state.items()}


def _patch_wan_video_dit(wan_video_dit: Any) -> None:
    if getattr(wan_video_dit, "_gjj_flashvsr_dtype_patch", False):
        return

    def sinusoidal_embedding_1d(dim, position):
        work_dtype = torch.float32
        half_dim = max(dim // 2, 1)
        scale = torch.arange(half_dim, dtype=work_dtype, device=position.device)
        inv_freq = torch.pow(10000.0, -scale / half_dim)
        sinusoid = torch.outer(position.to(work_dtype), inv_freq)
        x = torch.cat([torch.cos(sinusoid), torch.sin(sinusoid)], dim=1)
        return x.to(position.dtype)

    def precompute_freqs_cis(dim: int, end: int = 1024, theta: float = 10000.0):
        work_dtype = torch.float32
        half_dim = max(dim // 2, 1)
        base = torch.arange(0, dim, 2, dtype=work_dtype)[:half_dim]
        freqs = torch.pow(theta, -base / max(dim, 1))
        steps = torch.arange(end, dtype=work_dtype)
        angles = torch.outer(steps, freqs)
        return torch.polar(torch.ones_like(angles), angles)

    def rope_apply(x, freqs, num_heads):
        x = rearrange(x, "b s (n d) -> b s n d", n=num_heads)
        original_dtype = x.dtype
        work_dtype = torch.float32 if original_dtype in (torch.float16, torch.bfloat16) else original_dtype
        reshaped = x.to(work_dtype).reshape(x.shape[0], x.shape[1], x.shape[2], -1, 2)
        x_complex = torch.view_as_complex(reshaped)
        freqs = freqs.to(dtype=x_complex.dtype, device=x_complex.device)
        x_out = torch.view_as_real(x_complex * freqs).flatten(2)
        return x_out.to(original_dtype)

    wan_video_dit.sinusoidal_embedding_1d = sinusoidal_embedding_1d
    wan_video_dit.precompute_freqs_cis = precompute_freqs_cis
    wan_video_dit.rope_apply = rope_apply
    wan_video_dit._gjj_flashvsr_dtype_patch = True


def _import_flashvsr_runtime() -> dict[str, Any]:
    from ..vendor.flashvsr import FlashVSRFullPipeline, FlashVSRTinyLongPipeline, FlashVSRTinyPipeline, ModelManager
    from ..vendor.flashvsr.models import wan_video_dit
    from ..vendor.flashvsr.models.TCDecoder import build_tcdecoder
    from ..vendor.flashvsr.models.utils import Buffer_LQ4x_Proj, Causal_LQ4x_Proj

    _patch_wan_video_dit(wan_video_dit)
    return {
        "ModelManager": ModelManager,
        "FlashVSRFullPipeline": FlashVSRFullPipeline,
        "FlashVSRTinyPipeline": FlashVSRTinyPipeline,
        "FlashVSRTinyLongPipeline": FlashVSRTinyLongPipeline,
        "build_tcdecoder": build_tcdecoder,
        "Buffer_LQ4x_Proj": Buffer_LQ4x_Proj,
        "Causal_LQ4x_Proj": Causal_LQ4x_Proj,
        "wan_video_dit": wan_video_dit,
    }


def _configure_attention_backend(wan_video_dit: Any, attention_mode: str, status: Callable[[str], None] | None = None) -> None:
    mode = str(attention_mode or "")

    # GJJ 的默认路径必须是零依赖：不调用 Triton/Sparse Sage/FlashAttention/SageAttention。
    # 旧工作流里保存的 “Sparse Sage 注意力” 也按兼容模式处理，避免触发 triton tcc.exe 编译。
    for attr in (
        "FLASH_ATTN_3_AVAILABLE",
        "FLASH_ATTN_2_AVAILABLE",
        "SAGE_ATTN_AVAILABLE",
        "SPARSE_SAGE_ATTN_AVAILABLE",
    ):
        if hasattr(wan_video_dit, attr):
            setattr(wan_video_dit, attr, False)

    use_block = "块稀疏" in mode
    block_available = bool(getattr(wan_video_dit, "BLOCK_ATTN_AVAILABLE", False))
    wan_video_dit.USE_BLOCK_ATTN = bool(use_block and block_available)
    if use_block and not block_available and status:
        status("块稀疏注意力扩展不可用，已回退到零依赖兼容注意力。")


def init_pipeline(
    *,
    layout: str,
    mode: str,
    device: str,
    dtype: torch.dtype,
    attention_mode: str,
    auto_download: bool,
    status: Callable[[str], None] | None = None,
) -> tuple[Any, FlashVSRModelBundle]:
    runtime = _import_flashvsr_runtime()
    bundle = resolve_model_bundle(layout, mode, auto_download=auto_download)
    _configure_attention_backend(runtime["wan_video_dit"], attention_mode, status=status)

    status and status(f"加载模型：{bundle.name}")
    mm = runtime["ModelManager"](torch_dtype=dtype, device="cpu")
    if mode == "full":
        if not bundle.vae:
            raise RuntimeError("Full 模式需要 Wan2.1 VAE，请补齐 VAE 模型或改用 Tiny 模式。")
        mm.load_models([str(bundle.checkpoint), str(bundle.vae)])
        pipe = runtime["FlashVSRFullPipeline"].from_model_manager(mm, device=device)
        if getattr(pipe, "vae", None) is not None and getattr(pipe.vae, "model", None) is not None:
            pipe.vae.model.encoder = None
            pipe.vae.model.conv1 = None
    else:
        mm.load_models([str(bundle.checkpoint)])
        pipeline_cls = runtime["FlashVSRTinyLongPipeline"] if mode == "tiny-long" else runtime["FlashVSRTinyPipeline"]
        pipe = pipeline_cls.from_model_manager(mm, device=device)
        pipe.TCDecoder = runtime["build_tcdecoder"](
            new_channels=[512, 256, 128, 128],
            device=device,
            dtype=dtype,
            new_latent_channels=16 + 768,
        )
        tc_state = _strip_prefix_state(_load_torch_state(bundle.tcdecoder, device=device), "TCDecoder.")
        pipe.TCDecoder.load_state_dict(tc_state, strict=False)
        pipe.TCDecoder.clean_mem()

    proj_cls = runtime["Causal_LQ4x_Proj"] if bundle.lq_projection == "causal" else runtime["Buffer_LQ4x_Proj"]
    pipe.denoising_model().LQ_proj_in = proj_cls(in_dim=3, out_dim=1536, layer_num=1).to(device, dtype=dtype)
    lq_state = _clean_lq_state(_load_torch_state(bundle.lq, device="cpu"))
    pipe.denoising_model().LQ_proj_in.load_state_dict(lq_state, strict=True)
    pipe.denoising_model().LQ_proj_in.to(device)

    pipe.to(device, dtype=dtype)
    pipe.enable_vram_management(num_persistent_param_in_dit=None)
    context = _load_prompt_tensor(bundle.prompt, device=device)
    pipe.init_cross_kv(context_tensor=context)
    try:
        pipe.load_models_to_device(["dit", "vae"])
    except Exception:
        pipe.load_models_to_device(["dit"])
    try:
        pipe.offload_model()
    except Exception:
        pass
    clean_vram()
    return pipe, bundle


def compute_dims(width: int, height: int, scale: int, align: int = 128) -> tuple[int, int, int, int]:
    scaled_w, scaled_h = width * scale, height * scale
    target_w = math.ceil(scaled_w / align) * align
    target_h = math.ceil(scaled_h / align) * align
    return scaled_w, scaled_h, target_w, target_h


def align_frames(count: int) -> int:
    return 0 if count < 1 else ((count - 1) // 8) * 8 + 1


def _repeat_last_frame(frames: torch.Tensor, repeat_count: int) -> torch.Tensor:
    if repeat_count <= 0:
        return frames
    repeats = [repeat_count] + [1 for _ in range(frames.ndim - 1)]
    return torch.cat([frames, frames[-1:].repeat(*repeats)], dim=0)


def pad_video_sequence(frames: torch.Tensor) -> tuple[torch.Tensor, int]:
    frames = _repeat_last_frame(frames, 2)
    added_frames = 0
    remainder = (frames.shape[0] - 5) % 8
    if remainder != 0:
        added_frames = 8 - remainder
        frames = _repeat_last_frame(frames, added_frames)
    return frames, added_frames


def adjust_frame_count(result: torch.Tensor, expected_frames: int) -> torch.Tensor:
    if result.shape[0] == expected_frames:
        return result
    if result.shape[0] > expected_frames:
        return result[:expected_frames]
    padding = torch.zeros(expected_frames - result.shape[0], *result.shape[1:], dtype=result.dtype)
    if result.shape[0] > 0:
        padding[...] = result[-1]
    return torch.cat((result, padding), dim=0)


def restore_video_sequence(result: torch.Tensor, added_frames: int, expected_frames: int) -> torch.Tensor:
    if added_frames > 0 and result.shape[0] > added_frames:
        result = result[:-added_frames]
    if result.shape[0] > 2:
        result = result[2:]
    return adjust_frame_count(result, expected_frames)


def normalize_input_frames(frames: torch.Tensor) -> torch.Tensor:
    if getattr(frames, "ndim", None) == 3:
        frames = frames.unsqueeze(0)
    if getattr(frames, "ndim", None) != 4:
        raise RuntimeError(f"FlashVSR 需要 IMAGE 批次格式 BHWC，当前形状为 {tuple(getattr(frames, 'shape', ())) }。")
    channels = int(frames.shape[-1])
    if channels == 1:
        frames = frames.repeat(1, 1, 1, 3)
    elif channels > 3:
        frames = frames[..., :3]
    elif channels != 3:
        raise RuntimeError(f"FlashVSR 只支持 1/3/4 通道图像，当前通道数为 {channels}。")
    return frames


def prepare_video(frames: torch.Tensor, device: str, scale: int, dtype: torch.dtype) -> tuple[torch.Tensor, int, int, int, int, int]:
    frame_count, height, width, _channels = frames.shape
    scaled_w, scaled_h, target_w, target_h = compute_dims(width, height, scale)
    aligned_frames = align_frames(frame_count + 4)
    if aligned_frames == 0:
        raise ValueError("FlashVSR 没有收到有效的视频帧。")

    processed = []
    for index in range(aligned_frames):
        if index < 2:
            frame_index = 0
        elif index > frame_count + 1:
            frame_index = frame_count - 1
        else:
            frame_index = index - 2

        frame = frames[frame_index].permute(2, 0, 1).unsqueeze(0)
        upscaled = F.interpolate(frame, size=(scaled_h, scaled_w), mode="bicubic", align_corners=False)
        pad_h, pad_w = target_h - scaled_h, target_w - scaled_w
        if pad_h > 0 or pad_w > 0:
            upscaled = F.pad(upscaled, (0, pad_w, 0, pad_h), mode="replicate")
        processed.append((upscaled.squeeze(0) * 2.0 - 1.0).cpu().to(dtype))

    video = torch.stack(processed, 0).permute(1, 0, 2, 3).unsqueeze(0)
    return video, target_h, target_w, aligned_frames, scaled_h, scaled_w


def video_to_frames(video: torch.Tensor) -> torch.Tensor:
    video = video.squeeze(0)
    return (rearrange(video, "C F H W -> F H W C").float() + 1.0) / 2.0


def calc_tiles(height: int, width: int, size: int, overlap: int) -> list[tuple[int, int, int, int]]:
    tiles = []
    stride = max(1, size - overlap)
    rows = math.ceil((height - overlap) / stride)
    cols = math.ceil((width - overlap) / stride)
    for row in range(rows):
        for col in range(cols):
            y1, x1 = row * stride, col * stride
            y2, x2 = min(y1 + size, height), min(x1 + size, width)
            if y2 - y1 < size:
                y1 = max(0, y2 - size)
            if x2 - x1 < size:
                x1 = max(0, x2 - size)
            tiles.append((x1, y1, x2, y2))
    return tiles


def make_mask(height: int, width: int, overlap: int) -> torch.Tensor:
    overlap = max(1, min(overlap, height // 2, width // 2))
    mask = torch.ones(1, 1, height, width)
    ramp = torch.linspace(0, 1, overlap)
    mask[:, :, :, :overlap] *= ramp.view(1, 1, 1, -1)
    mask[:, :, :, -overlap:] *= ramp.flip(0).view(1, 1, 1, -1)
    mask[:, :, :overlap, :] *= ramp.view(1, 1, -1, 1)
    mask[:, :, -overlap:, :] *= ramp.flip(0).view(1, 1, -1, 1)
    return mask


class GJJProgress:
    def __init__(self, iterable=None, total=None, desc="处理中", status: Callable[[str], None] | None = None):
        self.desc = desc
        self.total = total
        self.status = status
        self.current = 0
        self.pbar = None
        self.iterable = None
        if iterable is not None:
            try:
                self.total = len(iterable)
                self.iterable = iter(iterable)
            except TypeError:
                if self.total is None:
                    raise ValueError("Progress total is required for this iterable.")
                self.iterable = iter(iterable)
        elif total is None:
            raise ValueError("Progress needs iterable or total.")

    def __iter__(self):
        if self.pbar is None:
            self.pbar = comfy.utils.ProgressBar(max(1, int(self.total or 1)))
        return self

    def __next__(self):
        if self.iterable is None:
            raise TypeError("Progress object is not iterable.")
        try:
            value = next(self.iterable)
        except StopIteration:
            raise
        self.update(1)
        return value

    def __enter__(self):
        if self.pbar is None:
            self.pbar = comfy.utils.ProgressBar(max(1, int(self.total or 1)))
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False

    def __len__(self):
        return int(self.total or 0)

    def update(self, step: int = 1) -> None:
        self.current += step
        if self.pbar is not None:
            self.pbar.update(step)
        if self.status and self.total:
            self.status(f"{self.desc}：{min(self.current, self.total)}/{self.total}")


def _progress_factory(status: Callable[[str], None] | None, desc: str):
    return lambda iterable=None, total=None: GJJProgress(iterable=iterable, total=total, desc=desc, status=status)


def _pipe_is_tiny_long(pipe: Any) -> bool:
    return "tiny_long" in pipe.__class__.__name__.lower() or "tinylong" in pipe.__class__.__name__.lower() or "long" in pipe.__class__.__name__.lower()


def _reset_stream_state(pipe: Any) -> None:
    try:
        denoising_model = pipe.denoising_model()
        lq_proj = getattr(denoising_model, "LQ_proj_in", None)
        if lq_proj is not None and hasattr(lq_proj, "clear_cache"):
            lq_proj.clear_cache()
    except Exception:
        pass
    try:
        tcdecoder = getattr(pipe, "TCDecoder", None)
        if tcdecoder is not None and hasattr(tcdecoder, "clean_mem"):
            tcdecoder.clean_mem()
    except Exception:
        pass


def run_full_frame_batch(
    pipe: Any,
    frames: torch.Tensor,
    *,
    scale: int,
    if_buffer: bool,
    sparse_ratio: float,
    kv_ratio: float,
    local_range: int,
    color_fix: bool,
    unload_dit: bool,
    tiled_vae: bool,
    seed: int,
    device: str,
    dtype: torch.dtype,
    force_offload: bool,
    status: Callable[[str], None] | None,
) -> torch.Tensor:
    video, target_h, target_w, frame_count, scaled_h, scaled_w = prepare_video(frames, device, scale, dtype)
    if not _pipe_is_tiny_long(pipe):
        video = video.to(device)

    _reset_stream_state(pipe)
    output = pipe(
        prompt="",
        negative_prompt="",
        cfg_scale=1.0,
        num_inference_steps=1,
        seed=int(seed),
        tiled=bool(tiled_vae),
        progress_bar_cmd=_progress_factory(status, "FlashVSR 推理"),
        LQ_video=video,
        num_frames=frame_count,
        height=target_h,
        width=target_w,
        is_full_block=False,
        if_buffer=bool(if_buffer),
        topk_ratio=float(sparse_ratio) * 768 * 1280 / (target_h * target_w),
        kv_ratio=float(kv_ratio),
        local_range=int(local_range),
        color_fix=bool(color_fix),
        unload_dit=bool(unload_dit),
        force_offload=bool(force_offload),
    )
    _reset_stream_state(pipe)
    result = video_to_frames(output).cpu()[:frames.shape[0], :scaled_h, :scaled_w, :]
    del video, output
    clean_vram()
    return result


def run_tiled_frame_batch(
    pipe: Any,
    frames: torch.Tensor,
    *,
    scale: int,
    tile_size: int,
    tile_overlap: int,
    if_buffer: bool,
    sparse_ratio: float,
    kv_ratio: float,
    local_range: int,
    color_fix: bool,
    unload_dit: bool,
    tiled_vae: bool,
    seed: int,
    device: str,
    dtype: torch.dtype,
    force_offload: bool,
    status: Callable[[str], None] | None,
) -> torch.Tensor:
    count, height, width, channels = frames.shape
    output_h, output_w = height * scale, width * scale
    canvas = torch.zeros((count, output_h, output_w, channels), dtype=torch.float32)
    weights = torch.zeros_like(canvas)
    tiles = calc_tiles(height, width, int(tile_size), int(tile_overlap))

    with GJJProgress(tiles, desc="FlashVSR 切块", status=status) as progress:
        for index, (x1, y1, x2, y2) in enumerate(progress):
            status and status(f"FlashVSR 切块：{index + 1}/{len(tiles)}")
            tile_frames = frames[:, y1:y2, x1:x2, :]
            tile_video, target_h, target_w, tile_frame_count, scaled_h, scaled_w = prepare_video(tile_frames, device, scale, dtype)
            if not _pipe_is_tiny_long(pipe):
                tile_video = tile_video.to(device)

            _reset_stream_state(pipe)
            tile_output = pipe(
                prompt="",
                negative_prompt="",
                cfg_scale=1.0,
                num_inference_steps=1,
                seed=int(seed),
                tiled=bool(tiled_vae),
                LQ_video=tile_video,
                num_frames=tile_frame_count,
                height=target_h,
                width=target_w,
                is_full_block=False,
                if_buffer=bool(if_buffer),
                topk_ratio=float(sparse_ratio) * 768 * 1280 / (target_h * target_w),
                kv_ratio=float(kv_ratio),
                local_range=int(local_range),
                color_fix=bool(color_fix),
                unload_dit=bool(unload_dit),
                force_offload=bool(force_offload),
            )
            _reset_stream_state(pipe)
            tile_result = video_to_frames(tile_output).cpu()[:count, :scaled_h, :scaled_w, :]
            mask = make_mask(tile_result.shape[1], tile_result.shape[2], int(tile_overlap) * int(scale)).permute(0, 2, 3, 1)

            out_y1, out_x1 = y1 * scale, x1 * scale
            out_y2, out_x2 = min(out_y1 + tile_result.shape[1], output_h), min(out_x1 + tile_result.shape[2], output_w)
            apply_h, apply_w = out_y2 - out_y1, out_x2 - out_x1
            canvas[:, out_y1:out_y2, out_x1:out_x2, :] += tile_result[:, :apply_h, :apply_w, :] * mask[:, :apply_h, :apply_w, :]
            weights[:, out_y1:out_y2, out_x1:out_x2, :] += mask[:, :apply_h, :apply_w, :]

            del tile_video, tile_output, tile_result, tile_frames
            if (index + 1) % 4 == 0 or index == len(tiles) - 1:
                clean_vram()

    weights[weights == 0] = 1.0
    return canvas / weights


def upscale_frames(
    frames: torch.Tensor,
    *,
    model_layout: str,
    mode: str,
    scale: int,
    enable_tiling: bool,
    tile_size: int,
    tile_overlap: int,
    sparse_ratio: float,
    kv_ratio: float,
    local_range: int,
    color_fix: bool,
    tiled_vae: bool,
    unload_dit: bool,
    force_offload: bool,
    attention_mode: str,
    device_name: str,
    precision: str,
    seed: int,
    auto_download: bool,
    status: Callable[[str], None] | None = None,
) -> tuple[torch.Tensor, FlashVSRModelBundle, float]:
    if frames is None or getattr(frames, "shape", None) is None or int(frames.shape[0]) <= 0:
        raise RuntimeError("FlashVSR 没有收到有效的视频帧。")
    frames = normalize_input_frames(frames)
    if enable_tiling and int(tile_overlap) >= int(tile_size) / 2:
        raise RuntimeError("切块重叠必须小于切块尺寸的一半。")
    if int(scale) not in (2, 4):
        raise RuntimeError("FlashVSR 只支持 2x 或 4x 放大。")

    started_at = time.perf_counter()
    device = _setup_device(device_name)
    dtype = _dtype_from_name(precision)
    original_count = int(frames.shape[0])
    work_frames = frames.detach().cpu().float().clamp(0.0, 1.0)
    if original_count < 21:
        status and status(f"输入只有 {original_count} 帧，已重复最后一帧补足到 21 帧作为 FlashVSR 上下文。")
        work_frames = _repeat_last_frame(work_frames, 21 - original_count)
    work_frames, added_frames = pad_video_sequence(work_frames)

    pipe = None
    bundle = None
    try:
        status and status("加载 FlashVSR 模型...")
        pipe, bundle = init_pipeline(
            layout=model_layout,
            mode=mode,
            device=device,
            dtype=dtype,
            attention_mode=attention_mode,
            auto_download=auto_download,
            status=status,
        )
        status and status(f"开始超分：{original_count} 帧 / {scale}x / {mode}")
        if_buffer = bundle.lq_projection == "buffer"
        if enable_tiling:
            result = run_tiled_frame_batch(
                pipe,
                work_frames,
                scale=scale,
                tile_size=tile_size,
                tile_overlap=tile_overlap,
                if_buffer=if_buffer,
                sparse_ratio=sparse_ratio,
                kv_ratio=kv_ratio,
                local_range=local_range,
                color_fix=color_fix,
                unload_dit=unload_dit,
                tiled_vae=tiled_vae,
                seed=seed,
                device=device,
                dtype=dtype,
                force_offload=force_offload,
                status=status,
            )
        else:
            result = run_full_frame_batch(
                pipe,
                work_frames,
                scale=scale,
                if_buffer=if_buffer,
                sparse_ratio=sparse_ratio,
                kv_ratio=kv_ratio,
                local_range=local_range,
                color_fix=color_fix,
                unload_dit=unload_dit,
                tiled_vae=tiled_vae,
                seed=seed,
                device=device,
                dtype=dtype,
                force_offload=force_offload,
                status=status,
            )
        result = restore_video_sequence(result, added_frames, original_count).float().clamp(0.0, 1.0).cpu()
        return result, bundle, time.perf_counter() - started_at
    finally:
        try:
            del pipe
        except Exception:
            pass
        clean_vram()
