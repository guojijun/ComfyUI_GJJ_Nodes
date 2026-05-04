from __future__ import annotations

from pathlib import Path
from typing import Callable

import comfy.model_management
import comfy.utils
import folder_paths
import torch
from torch.hub import download_url_to_file


CKPT_NAME_VER_DICT: dict[str, str] = {
    "rife40.pth": "4.0",
    "rife41.pth": "4.0",
    "rife42.pth": "4.2",
    "rife43.pth": "4.3",
    "rife44.pth": "4.3",
    "rife45.pth": "4.5",
    "rife46.pth": "4.6",
    "rife47.pth": "4.7",
    "rife48.pth": "4.7",
    "rife49.pth": "4.7",
    "sudo_rife4_269.662_testV1_scale1.pth": "4.0",
}
DEFAULT_CKPT = "rife47.pth"
MODEL_CATEGORY = "rife_models"
BASE_MODEL_DOWNLOAD_URLS = [
    "https://github.com/styler00dollar/VSGAN-tensorrt-docker/releases/download/models/",
    "https://github.com/Fannovel16/ComfyUI-Frame-Interpolation/releases/download/models/",
    "https://github.com/dajes/frame-interpolation-pytorch/releases/download/v1.0.0/",
]


def _normalize_text(value: str | None) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _candidate_model_dirs() -> list[Path]:
    models_dir = Path(folder_paths.models_dir)
    candidates = [
        models_dir / "frame_interpolatiom",
        models_dir / "frame_interpolation",
        models_dir / "rife",
        models_dir / "vfi",
        models_dir / "ckpts",
    ]
    deduped: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path.resolve()) if path.exists() else str(path)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(path)
    return deduped


def _default_download_dir() -> Path:
    return Path(folder_paths.models_dir) / "frame_interpolatiom" / "rife"


def ensure_rife_model_paths() -> None:
    download_dir = _default_download_dir()
    paths = [str(path) for path in [download_dir, *_candidate_model_dirs()]]
    extensions = folder_paths.supported_pt_extensions
    if MODEL_CATEGORY not in folder_paths.folder_names_and_paths:
        folder_paths.folder_names_and_paths[MODEL_CATEGORY] = (paths, extensions)
        return
    current_paths, current_exts = folder_paths.folder_names_and_paths[MODEL_CATEGORY]
    merged_paths: list[str] = []
    for item in list(current_paths) + paths:
        if item not in merged_paths:
            merged_paths.append(item)
    folder_paths.folder_names_and_paths[MODEL_CATEGORY] = (merged_paths, current_exts or extensions)


def list_rife_models() -> list[str]:
    ensure_rife_model_paths()
    discovered: list[str] = []
    try:
        for name in folder_paths.get_filename_list(MODEL_CATEGORY):
            base = str(name).replace("\\", "/").split("/")[-1]
            if base in CKPT_NAME_VER_DICT and name not in discovered:
                discovered.append(name)
    except Exception:
        pass
    for fallback_name in CKPT_NAME_VER_DICT.keys():
        if fallback_name not in discovered:
            discovered.append(fallback_name)
    return discovered


def resolve_rife_model_path(preferred: str) -> tuple[str, str]:
    ensure_rife_model_paths()
    available = list_rife_models()
    preferred = str(preferred or "").strip() or DEFAULT_CKPT
    chosen = ""

    if preferred in available:
        chosen = preferred
    else:
        preferred_base = preferred.replace("\\", "/").split("/")[-1]
        for name in available:
            base = name.replace("\\", "/").split("/")[-1]
            if base.lower() == preferred_base.lower():
                chosen = name
                break
        if not chosen:
            norm = _normalize_text(preferred)
            for name in available:
                if norm and norm in _normalize_text(name):
                    chosen = name
                    break

    if not chosen:
        chosen = DEFAULT_CKPT

    full_path = None
    try:
        full_path = folder_paths.get_full_path(MODEL_CATEGORY, chosen)
    except Exception:
        full_path = None

    if not full_path:
        chosen_base = chosen.replace("\\", "/").split("/")[-1]
        for root in _candidate_model_dirs():
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if path.is_file() and path.name.lower() == chosen_base.lower():
                    full_path = str(path.resolve())
                    chosen = str(path.relative_to(root)).replace("/", "\\")
                    break
            if full_path:
                break

    if not full_path:
        download_target = _default_download_dir()
        download_target.mkdir(parents=True, exist_ok=True)
        chosen_base = chosen.replace("\\", "/").split("/")[-1]
        download_errors: list[str] = []
        for base_url in BASE_MODEL_DOWNLOAD_URLS:
            try:
                target_path = download_target / chosen_base
                download_url_to_file(base_url + chosen_base, str(target_path), hash_prefix=None, progress=True)
                if target_path.exists():
                    full_path = str(target_path.resolve())
                    break
            except Exception as exc:
                download_errors.append(f"{base_url + chosen_base} -> {exc}")

    if not full_path:
        roots_text = "\n".join(str(path) for path in _candidate_model_dirs())
        extra = ""
        if "download_errors" in locals() and download_errors:
            extra = "\n下载尝试失败：\n" + "\n".join(download_errors)
        raise RuntimeError(f"未找到 RIFE 模型：{preferred}\n已搜索目录：\n{roots_text}{extra}")

    base_name = Path(full_path).name
    arch_ver = CKPT_NAME_VER_DICT.get(base_name)
    if not arch_ver:
        raise RuntimeError(f"RIFE 模型不受支持：{base_name}")
    return str(full_path), arch_ver


def preprocess_frames(frames: torch.Tensor) -> torch.Tensor:
    return frames[..., :3].permute(0, 3, 1, 2).contiguous()


def postprocess_frames(frames: torch.Tensor) -> torch.Tensor:
    return frames.permute(0, 2, 3, 1).contiguous().cpu()[..., :3]


def assert_batch_size(frames: torch.Tensor, minimum: int = 2) -> None:
    if int(frames.shape[0]) < minimum:
        raise RuntimeError(f"RIFE 视频插帧至少需要 {minimum} 帧，当前只有 {int(frames.shape[0])} 帧。")


def soft_empty_cache() -> None:
    try:
        comfy.model_management.soft_empty_cache()
    except Exception:
        pass


def get_torch_device() -> torch.device:
    return comfy.model_management.get_torch_device()


@torch.inference_mode()
def interpolate_frames(
    frames: torch.Tensor,
    multiplier: int,
    clear_cache_after_n_frames: int,
    model,
    scale_list: list[float],
    fast_mode: bool,
    ensemble: bool,
    progress_callback: Callable[[int, int], None] | None = None,
) -> torch.Tensor:
    assert_batch_size(frames, minimum=2)
    multiplier = max(1, int(multiplier))
    clear_cache_after_n_frames = max(1, int(clear_cache_after_n_frames))
    device = get_torch_device()

    if multiplier == 1:
        return frames

    total_pairs = max(1, len(frames) - 1)
    max_output = multiplier * len(frames)
    output_frames = torch.zeros(max_output, *frames.shape[1:], dtype=torch.float32, device="cpu")
    out_len = 0
    processed_since_clear = 0

    def return_middle_frame(frame_0, frame_1, timestep):
        return model(frame_0, frame_1, timestep, scale_list, False, fast_mode, ensemble)

    for index in range(len(frames) - 1):
        frame_0 = frames[index : index + 1]
        frame_1 = frames[index + 1 : index + 2]
        output_frames[out_len] = frame_0
        out_len += 1

        frame_0 = frame_0.to(device=device, dtype=torch.float32)
        frame_1 = frame_1.to(device=device, dtype=torch.float32)
        for middle_i in range(1, multiplier):
            timestep = middle_i / multiplier
            middle = return_middle_frame(frame_0, frame_1, timestep).detach().cpu().to(dtype=torch.float32)
            output_frames[out_len] = middle
            out_len += 1

        processed_since_clear += 1
        if progress_callback is not None:
            progress_callback(index + 1, total_pairs)

        if processed_since_clear >= clear_cache_after_n_frames:
            soft_empty_cache()
            processed_since_clear = 0

    output_frames[out_len] = frames[-1:]
    out_len += 1
    soft_empty_cache()
    return output_frames[:out_len]
