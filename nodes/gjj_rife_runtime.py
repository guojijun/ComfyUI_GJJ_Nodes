from __future__ import annotations

from pathlib import Path
from typing import Callable

import comfy.model_management
import comfy.utils
import folder_paths
import torch


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
HDV3_MODEL_NAMES = {
    "flownet.pkl",
    "rife_v4.26_heavy.safetensors",
}
DEFAULT_CKPT = "rife47.pth"
MODEL_CATEGORY = "rife_models"


def _normalize_text(value: str | None) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _with_pth_extension(value: str | None) -> str:
    text = str(value or "").strip()
    if not text:
        return text
    lowered = text.lower()
    if lowered.endswith((".pkl", ".safetensors")):
        return text
    parts = text.replace("\\", "/").split("/")
    base = parts[-1]
    if "." not in base:
        parts[-1] = f"{base}.pth"
        return "/".join(parts)
    return text


def _candidate_model_dirs() -> list[Path]:
    models_dir = Path(folder_paths.models_dir)
    candidates = [
        models_dir / "frame_interpolatiom",
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


def ensure_rife_model_paths() -> None:
    paths = [str(path) for path in _candidate_model_dirs()]
    extensions = tuple(dict.fromkeys([*folder_paths.supported_pt_extensions, ".pkl"]))
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
    supported_names = {name.lower() for name in CKPT_NAME_VER_DICT} | {name.lower() for name in HDV3_MODEL_NAMES}
    for root in _candidate_model_dirs():
        if not root.exists():
            continue
        for path in sorted(root.rglob("*"), key=lambda item: str(item).lower()):
            if not path.is_file():
                continue
            base = path.name.lower()
            if base not in supported_names:
                continue
            rel = str(path.relative_to(root)).replace("/", "\\")
            if rel not in discovered:
                discovered.append(rel)
    return discovered


def resolve_rife_model_path(preferred: str) -> tuple[str, str, str]:
    ensure_rife_model_paths()
    available = list_rife_models()
    preferred = _with_pth_extension(preferred) or DEFAULT_CKPT
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
        chosen = available[0] if available else DEFAULT_CKPT

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
        roots_text = "\n".join(str(path) for path in _candidate_model_dirs())
        raise RuntimeError(f"未找到 RIFE 模型：{preferred}\n已搜索目录：\n{roots_text}")

    base_name = Path(full_path).name
    if base_name.lower() in {name.lower() for name in HDV3_MODEL_NAMES}:
        return str(full_path), "4.26", "hdv3"
    arch_ver = CKPT_NAME_VER_DICT.get(base_name)
    if not arch_ver:
        raise RuntimeError(f"RIFE 模型不受支持：{base_name}")
    return str(full_path), arch_ver, "ifnet"


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


def load_state_dict_file(model_path: str) -> dict:
    if str(model_path).lower().endswith(".safetensors"):
        try:
            from safetensors.torch import load_file
        except Exception as exc:
            raise RuntimeError("加载 safetensors 模型需要安装 safetensors。") from exc
        state_dict = load_file(model_path, device="cpu")
    else:
        state_dict = torch.load(model_path, map_location="cpu", weights_only=False)
    if isinstance(state_dict, dict) and "state_dict" in state_dict and isinstance(state_dict["state_dict"], dict):
        state_dict = state_dict["state_dict"]
    normalized = {}
    for key, value in state_dict.items():
        name = str(key)
        for prefix in ("module.", "flownet."):
            if name.startswith(prefix):
                name = name[len(prefix) :]
        normalized[name] = value
    return normalized


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


def _calculate_target_positions(source_fps: float, target_fps: float, total_source_frames: int) -> list[tuple[int, int, float]]:
    duration = total_source_frames / source_fps
    total_target_frames = max(1, int(duration * target_fps))
    positions: list[tuple[int, int, float]] = []
    for target_index in range(total_target_frames):
        source_position = (target_index / target_fps) * source_fps
        source_index_0 = min(int(source_position), total_source_frames - 1)
        source_index_1 = min(source_index_0 + 1, total_source_frames - 1)
        factor = 0.0 if source_index_0 == source_index_1 else source_position - source_index_0
        positions.append((source_index_0, source_index_1, factor))
    return positions


@torch.inference_mode()
def interpolate_frames_hdv3(
    frames: torch.Tensor,
    source_fps: float,
    target_fps: float,
    model,
    scale: float,
    batch_size: int,
    use_fp16: bool,
    progress_callback: Callable[[int, int], None] | None = None,
) -> torch.Tensor:
    assert_batch_size(frames, minimum=2)
    source_fps = max(0.001, float(source_fps))
    target_fps = max(0.001, float(target_fps))
    if abs(source_fps - target_fps) < 0.001:
        return frames

    device = get_torch_device()
    batch_size = max(1, int(batch_size))
    scale = max(0.25, float(scale))
    use_half = bool(use_fp16) and device.type == "cuda"
    gpu_dtype = torch.float16 if use_half else torch.float32
    if use_half:
        model.half()
    model.eval().to(device)

    _, _, height, width = frames.shape
    pad_base = max(128, int(128 / scale))
    padded_h = ((height - 1) // pad_base + 1) * pad_base
    padded_w = ((width - 1) // pad_base + 1) * pad_base
    padding = (0, padded_w - width, 0, padded_h - height)
    scale_list = [16 / scale, 8 / scale, 4 / scale, 2 / scale, 1 / scale]

    output_frames: list[torch.Tensor | None] = []
    jobs: list[tuple[int, int, float, int]] = []
    for output_index, (index_0, index_1, factor) in enumerate(
        _calculate_target_positions(source_fps, target_fps, int(frames.shape[0]))
    ):
        if factor == 0.0 or index_0 == index_1:
            output_frames.append(frames[index_0].cpu().to(torch.float32))
        else:
            output_frames.append(None)
            jobs.append((index_0, index_1, factor, output_index))

    for batch_start in range(0, len(jobs), batch_size):
        batch = jobs[batch_start : batch_start + batch_size]
        batch_i0 = torch.empty((len(batch), 3, padded_h, padded_w), dtype=gpu_dtype, device=device)
        batch_i1 = torch.empty((len(batch), 3, padded_h, padded_w), dtype=gpu_dtype, device=device)
        timesteps: list[float] = []
        for index, (index_0, index_1, factor, _) in enumerate(batch):
            batch_i0[index] = torch.nn.functional.pad(frames[index_0 : index_0 + 1].to(device=device, dtype=gpu_dtype), padding)[0]
            batch_i1[index] = torch.nn.functional.pad(frames[index_1 : index_1 + 1].to(device=device, dtype=gpu_dtype), padding)[0]
            timesteps.append(factor)

        for index, (_, _, factor, output_index) in enumerate(batch):
            timestep = torch.tensor(factor, device=device, dtype=gpu_dtype)
            result = model(batch_i0[index : index + 1], batch_i1[index : index + 1], timestep, scale_list)
            output_frames[output_index] = result[0, :, :height, :width].detach().cpu().to(torch.float32)

        if progress_callback is not None:
            progress_callback(min(batch_start + len(batch), len(jobs)), max(1, len(jobs)))
        del batch_i0, batch_i1
        soft_empty_cache()

    return torch.stack([frame for frame in output_frames if frame is not None], dim=0)
