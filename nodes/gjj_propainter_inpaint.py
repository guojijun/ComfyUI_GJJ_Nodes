from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Any

import folder_paths
import torch
import torch.nn.functional as F
from comfy import model_management
from comfy.utils import ProgressBar

try:
    from .common_utils.dependency_checker import (
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
    )
except ImportError:
    from common_utils.dependency_checker import (
        load_dependency_at_runtime,
        make_missing_model_spec,
        raise_dependency_model_error,
    )


NODE_NAME = "GJJ_ProPainterInpaint"
NODE_DISPLAY_NAME = "GJJ · ProPainter视频修复"
MODEL_CATEGORY = "ProPainter"
MODEL_SUBDIR = "models/ProPainter"
MODEL_DOWNLOAD_URL = "https://github.com/sczhou/ProPainter/releases/tag/v0.1.0"
RAFT_MODEL = "raft-things.pth"
FLOW_MODEL = "recurrent_flow_completion.pth"
INPAINT_MODEL = "ProPainter.pth"
MEDIA_MODEL_TREE = """ComfyUI/
└── models/
    └── ProPainter/
        ├── raft-things.pth
        ├── recurrent_flow_completion.pth
        └── ProPainter.pth
"""


_MODEL_LOCK = Lock()
_MODEL_CACHE: dict[tuple[str, str, str, str, bool], Any] = {}


@dataclass
class _Models:
    raft_model: Any
    flow_model: Any
    inpaint_model: Any


@dataclass
class _ProPainterConfig:
    ref_stride: int
    neighbor_length: int
    subvideo_length: int
    raft_iter: int
    fp16: str
    video_length: int
    device: torch.device
    process_size: tuple[int, int]
    use_half: bool = field(init=False)

    def __post_init__(self) -> None:
        self.use_half = self.fp16 == "enable" and self.device.type != "cpu"


def _ensure_propainter_folder() -> None:
    try:
        folder_paths.add_model_folder_path(
            MODEL_CATEGORY,
            str(Path(folder_paths.models_dir) / MODEL_CATEGORY),
        )
    except Exception:
        pass


def _model_roots() -> list[Path]:
    roots: list[Path] = []
    try:
        _ensure_propainter_folder()
        for value in folder_paths.get_folder_paths(MODEL_CATEGORY) or []:
            roots.append(Path(value))
    except Exception:
        pass

    models_dir = Path(getattr(folder_paths, "models_dir", "") or ".")
    roots.extend(
        [
            models_dir / "ProPainter",
            models_dir / "propainter",
        ]
    )

    result: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        key = str(root.resolve() if root.exists() else root).lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(root)
    return result


def _find_model_file(filename: str) -> Path | None:
    wanted = str(filename).lower()
    for root in _model_roots():
        if not root.exists():
            continue
        exact = root / filename
        if exact.is_file():
            return exact
        for candidate in root.rglob("*"):
            if candidate.is_file() and candidate.name.lower() == wanted:
                return candidate
    return None


def _missing_model_specs(paths: dict[str, Path | None]) -> list[dict[str, str]]:
    labels = {
        RAFT_MODEL: "RAFT光流模型",
        FLOW_MODEL: "循环光流补全模型",
        INPAINT_MODEL: "ProPainter主模型",
    }
    return [
        make_missing_model_spec(
            label=labels.get(filename, filename),
            subdir=MODEL_SUBDIR,
            filename=filename,
            description="节点只查找本地模型，不会自动下载。",
        )
        for filename, path in paths.items()
        if path is None
    ]


def _resolve_required_models(unique_id=None) -> dict[str, Path]:
    paths = {
        RAFT_MODEL: _find_model_file(RAFT_MODEL),
        FLOW_MODEL: _find_model_file(FLOW_MODEL),
        INPAINT_MODEL: _find_model_file(INPAINT_MODEL),
    }
    missing = _missing_model_specs(paths)
    if missing:
        raise_dependency_model_error(
            node_name=NODE_DISPLAY_NAME,
            missing_models=missing,
            description=(
                "请把 ProPainter 的三份 .pth 权重放到 ComfyUI/models/ProPainter。"
                "本 GJJ 节点不依赖原 ComfyUI_ProPainter_Nodes 插件，也不会自动联网下载模型。"
            ),
            unique_id=unique_id,
            copy_text=MEDIA_MODEL_TREE,
            copy_label="📋 复制模型放置树",
            model_download_url=MODEL_DOWNLOAD_URL,
        )
    return {name: path for name, path in paths.items() if path is not None}


def _load_models(device: torch.device, use_half: bool, unique_id=None) -> _Models:
    model_paths = _resolve_required_models(unique_id=unique_id)
    cache_key = (
        str(model_paths[RAFT_MODEL]),
        str(model_paths[FLOW_MODEL]),
        str(model_paths[INPAINT_MODEL]),
        str(device),
        bool(use_half),
    )
    cached = _MODEL_CACHE.get(cache_key)
    if cached is not None:
        return cached

    with _MODEL_LOCK:
        cached = _MODEL_CACHE.get(cache_key)
        if cached is not None:
            return cached

        load_dependency_at_runtime(
            "torchvision",
            node_name=NODE_DISPLAY_NAME,
            package_name="torchvision",
            description="ProPainter 的可变形卷积需要 torchvision.ops.deform_conv2d。",
            unique_id=unique_id,
        )

        from .vendor.gjj_propainter.modules.flow_comp_raft import RAFT_bi
        from .vendor.gjj_propainter.propainter import InpaintGenerator
        from .vendor.gjj_propainter.recurrent_flow_completion import RecurrentFlowCompleteNet

        raft_model = RAFT_bi(str(model_paths[RAFT_MODEL]), device)
        flow_model = RecurrentFlowCompleteNet(str(model_paths[FLOW_MODEL]))
        inpaint_model = InpaintGenerator(model_path=str(model_paths[INPAINT_MODEL])).to(device)

        for parameter in flow_model.parameters():
            parameter.requires_grad_(False)
        for parameter in inpaint_model.parameters():
            parameter.requires_grad_(False)

        flow_model = flow_model.to(device).eval()
        inpaint_model = inpaint_model.eval()
        if use_half:
            flow_model = flow_model.half()
            inpaint_model = inpaint_model.half()

        models = _Models(raft_model=raft_model, flow_model=flow_model, inpaint_model=inpaint_model)
        _MODEL_CACHE[cache_key] = models
        return models


def _to_bhwc_image_tensor(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise RuntimeError("image 输入必须是 ComfyUI IMAGE 张量。")
    tensor = image.detach().float()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise RuntimeError(f"image 维度无效，当前形状为 {tuple(tensor.shape)}。")
    if tensor.shape[-1] not in (1, 3, 4) and tensor.shape[1] in (1, 3, 4):
        tensor = tensor.permute(0, 2, 3, 1).contiguous()
    if tensor.shape[-1] == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif tensor.shape[-1] == 4:
        tensor = tensor[..., :3]
    if tensor.shape[-1] != 3:
        raise RuntimeError(f"image 通道数无效，当前形状为 {tuple(tensor.shape)}。")
    if tensor.numel() > 0 and tensor.max().item() > 1.5:
        tensor = tensor / 255.0
    return tensor.clamp(0.0, 1.0).contiguous()


def _to_bhw_mask_tensor(mask: torch.Tensor) -> torch.Tensor:
    if not isinstance(mask, torch.Tensor):
        raise RuntimeError("mask 输入必须是 ComfyUI MASK 张量。")
    tensor = mask.detach().float()
    if tensor.ndim == 2:
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim == 4:
        if tensor.shape[-1] in (1, 3, 4):
            tensor = tensor.mean(dim=-1)
        elif tensor.shape[1] in (1, 3, 4):
            tensor = tensor.mean(dim=1)
        else:
            raise RuntimeError(f"mask 维度无效，当前形状为 {tuple(tensor.shape)}。")
    if tensor.ndim != 3:
        raise RuntimeError(f"mask 维度无效，当前形状为 {tuple(tensor.shape)}。")
    if tensor.numel() > 0 and tensor.max().item() > 1.5:
        tensor = tensor / 255.0
    return tensor.clamp(0.0, 1.0).contiguous()


def _process_size(width: int, height: int, input_width: int, input_height: int) -> tuple[int, int]:
    width = int(width or input_width)
    height = int(height or input_height)
    width = max(8, width - width % 8)
    height = max(8, height - height % 8)
    return width, height


def _dilate_mask(mask_bchw: torch.Tensor, iterations: int) -> torch.Tensor:
    mask_bchw = (mask_bchw > 0.1).float()
    iterations = max(0, int(iterations))
    if iterations <= 0:
        return mask_bchw
    kernel = iterations * 2 + 1
    return F.max_pool2d(mask_bchw, kernel_size=kernel, stride=1, padding=iterations).clamp(0.0, 1.0)


def _prepare_frames_and_masks(
    image: torch.Tensor,
    mask: torch.Tensor,
    width: int,
    height: int,
    mask_dilates: int,
    flow_mask_dilates: int,
    device: torch.device,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, tuple[int, int]]:
    images = _to_bhwc_image_tensor(image)
    masks = _to_bhw_mask_tensor(mask)
    frame_count, input_height, input_width, _ = images.shape
    if frame_count <= 1:
        raise RuntimeError(f"ProPainter 视频修复至少需要 2 帧，当前 image 只有 {frame_count} 帧。")
    if masks.shape[0] not in (1, frame_count):
        raise RuntimeError(f"image 与 mask 帧数不匹配：image={frame_count}, mask={masks.shape[0]}。")
    if tuple(masks.shape[-2:]) != (input_height, input_width):
        raise RuntimeError(
            f"image 与 mask 尺寸不一致：image=({input_width}, {input_height}), "
            f"mask=({masks.shape[-1]}, {masks.shape[-2]})。"
        )
    if masks.shape[0] == 1:
        masks = masks.repeat(frame_count, 1, 1)

    process_width, process_height = _process_size(width, height, input_width, input_height)
    images_nchw = images.permute(0, 3, 1, 2).contiguous()
    masks_bchw = masks.unsqueeze(1).contiguous()
    if (process_height, process_width) != (input_height, input_width):
        images_nchw = F.interpolate(images_nchw, size=(process_height, process_width), mode="bilinear", align_corners=False)
        masks_bchw = F.interpolate(masks_bchw, size=(process_height, process_width), mode="nearest")

    flow_masks = _dilate_mask(masks_bchw, flow_mask_dilates)
    masks_dilated = _dilate_mask(masks_bchw, mask_dilates)
    original_frames = images_nchw.permute(0, 2, 3, 1).cpu().float().contiguous()

    frames_tensor = images_nchw.unsqueeze(0).to(device, non_blocking=True) * 2.0 - 1.0
    flow_masks_tensor = flow_masks.unsqueeze(0).to(device, non_blocking=True)
    masks_dilated_tensor = masks_dilated.unsqueeze(0).to(device, non_blocking=True)
    return (
        frames_tensor,
        flow_masks_tensor,
        masks_dilated_tensor,
        original_frames,
        (process_width, process_height),
    )


def _empty_cache() -> None:
    try:
        model_management.soft_empty_cache()
    except Exception:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def _get_ref_index(mid_neighbor_id: int, neighbor_ids: list[int], config: _ProPainterConfig, ref_num: int = -1) -> list[int]:
    ref_index: list[int] = []
    if ref_num == -1:
        for index in range(0, config.video_length, config.ref_stride):
            if index not in neighbor_ids:
                ref_index.append(index)
    else:
        start_idx = max(0, mid_neighbor_id - config.ref_stride * (ref_num // 2))
        end_idx = min(config.video_length, mid_neighbor_id + config.ref_stride * (ref_num // 2))
        for index in range(start_idx, end_idx, config.ref_stride):
            if index not in neighbor_ids:
                if len(ref_index) > ref_num:
                    break
                ref_index.append(index)
    return ref_index


def _compute_flow(raft_model: Any, frames: torch.Tensor, config: _ProPainterConfig) -> tuple[torch.Tensor, torch.Tensor]:
    if frames.size(dim=-1) <= 640:
        short_clip_len = 12
    elif frames.size(dim=-1) <= 720:
        short_clip_len = 8
    elif frames.size(dim=-1) <= 1280:
        short_clip_len = 4
    else:
        short_clip_len = 2

    if frames.size(dim=1) > short_clip_len:
        flows_f_list, flows_b_list = [], []
        for chunk in range(0, config.video_length, short_clip_len):
            end_f = min(config.video_length, chunk + short_clip_len)
            if chunk == 0:
                flows_f, flows_b = raft_model(frames[:, chunk:end_f], iters=config.raft_iter)
            else:
                flows_f, flows_b = raft_model(frames[:, chunk - 1 : end_f], iters=config.raft_iter)
            flows_f_list.append(flows_f)
            flows_b_list.append(flows_b)
            _empty_cache()
        return torch.cat(flows_f_list, dim=1), torch.cat(flows_b_list, dim=1)

    flows = raft_model(frames, iters=config.raft_iter)
    _empty_cache()
    return flows


def _complete_flow(
    recurrent_flow_model: Any,
    flows_tuple: tuple[torch.Tensor, torch.Tensor],
    flow_masks: torch.Tensor,
    subvideo_length: int,
) -> tuple[torch.Tensor, torch.Tensor]:
    flow_length = flows_tuple[0].size(dim=1)
    if flow_length > subvideo_length:
        pred_flows_f_list, pred_flows_b_list = [], []
        pad_len = 5
        for start in range(0, flow_length, subvideo_length):
            s_f = max(0, start - pad_len)
            e_f = min(flow_length, start + subvideo_length + pad_len)
            pad_len_s = max(0, start) - s_f
            pad_len_e = e_f - min(flow_length, start + subvideo_length)
            pred_flows_bi_sub, _ = recurrent_flow_model.forward_bidirect_flow(
                (flows_tuple[0][:, s_f:e_f], flows_tuple[1][:, s_f:e_f]),
                flow_masks[:, s_f : e_f + 1],
            )
            pred_flows_bi_sub = recurrent_flow_model.combine_flow(
                (flows_tuple[0][:, s_f:e_f], flows_tuple[1][:, s_f:e_f]),
                pred_flows_bi_sub,
                flow_masks[:, s_f : e_f + 1],
            )
            pred_flows_f_list.append(pred_flows_bi_sub[0][:, pad_len_s : e_f - s_f - pad_len_e])
            pred_flows_b_list.append(pred_flows_bi_sub[1][:, pad_len_s : e_f - s_f - pad_len_e])
            _empty_cache()
        return torch.cat(pred_flows_f_list, dim=1), torch.cat(pred_flows_b_list, dim=1)

    pred_flows_bi, _ = recurrent_flow_model.forward_bidirect_flow(flows_tuple, flow_masks)
    pred_flows_bi = recurrent_flow_model.combine_flow(flows_tuple, pred_flows_bi, flow_masks)
    _empty_cache()
    return pred_flows_bi


def _image_propagation(
    inpaint_model: Any,
    frames: torch.Tensor,
    masks_dilated: torch.Tensor,
    prediction_flows: tuple[torch.Tensor, torch.Tensor],
    config: _ProPainterConfig,
) -> tuple[torch.Tensor, torch.Tensor]:
    process_width, process_height = config.process_size
    masked_frames = frames * (1 - masks_dilated)
    subvideo_length_img_prop = min(100, config.subvideo_length)
    if config.video_length > subvideo_length_img_prop:
        updated_frames_list, updated_masks_list = [], []
        pad_len = 10
        for start in range(0, config.video_length, subvideo_length_img_prop):
            s_f = max(0, start - pad_len)
            e_f = min(config.video_length, start + subvideo_length_img_prop + pad_len)
            pad_len_s = max(0, start) - s_f
            pad_len_e = e_f - min(config.video_length, start + subvideo_length_img_prop)
            b, t, _, _, _ = masks_dilated[:, s_f:e_f].size()
            pred_flows_bi_sub = (
                prediction_flows[0][:, s_f : e_f - 1],
                prediction_flows[1][:, s_f : e_f - 1],
            )
            prop_imgs_sub, updated_local_masks_sub = inpaint_model.img_propagation(
                masked_frames[:, s_f:e_f],
                pred_flows_bi_sub,
                masks_dilated[:, s_f:e_f],
                "nearest",
            )
            updated_frames_sub = (
                frames[:, s_f:e_f] * (1 - masks_dilated[:, s_f:e_f])
                + prop_imgs_sub.view(b, t, 3, process_height, process_width) * masks_dilated[:, s_f:e_f]
            )
            updated_masks_sub = updated_local_masks_sub.view(b, t, 1, process_height, process_width)
            updated_frames_list.append(updated_frames_sub[:, pad_len_s : e_f - s_f - pad_len_e])
            updated_masks_list.append(updated_masks_sub[:, pad_len_s : e_f - s_f - pad_len_e])
            _empty_cache()
        return torch.cat(updated_frames_list, dim=1), torch.cat(updated_masks_list, dim=1)

    b, t, _, _, _ = masks_dilated.size()
    prop_imgs, updated_local_masks = inpaint_model.img_propagation(
        masked_frames,
        prediction_flows,
        masks_dilated,
        "nearest",
    )
    updated_frames = frames * (1 - masks_dilated) + prop_imgs.view(b, t, 3, process_height, process_width) * masks_dilated
    updated_masks = updated_local_masks.view(b, t, 1, process_height, process_width)
    _empty_cache()
    return updated_frames, updated_masks


def _feature_propagation(
    inpaint_model: Any,
    updated_frames: torch.Tensor,
    updated_masks: torch.Tensor,
    masks_dilated: torch.Tensor,
    prediction_flows: tuple[torch.Tensor, torch.Tensor],
    original_frames: torch.Tensor,
    config: _ProPainterConfig,
    pbar: ProgressBar | None = None,
) -> torch.Tensor:
    process_width, process_height = config.process_size
    composed_frames: list[torch.Tensor | None] = [None] * config.video_length
    neighbor_stride = max(1, config.neighbor_length // 2)
    ref_num = config.subvideo_length // config.ref_stride if config.video_length > config.subvideo_length else -1

    for start in range(0, config.video_length, neighbor_stride):
        neighbor_ids = list(range(max(0, start - neighbor_stride), min(config.video_length, start + neighbor_stride + 1)))
        ref_ids = _get_ref_index(start, neighbor_ids, config, ref_num)
        selected_imgs = updated_frames[:, neighbor_ids + ref_ids, :, :, :]
        selected_masks = masks_dilated[:, neighbor_ids + ref_ids, :, :, :]
        if config.use_half:
            selected_masks = selected_masks.half()
        selected_update_masks = updated_masks[:, neighbor_ids + ref_ids, :, :, :]
        selected_pred_flows_bi = (
            prediction_flows[0][:, neighbor_ids[:-1], :, :, :],
            prediction_flows[1][:, neighbor_ids[:-1], :, :, :],
        )

        local_length = len(neighbor_ids)
        pred_img = inpaint_model(
            selected_imgs,
            selected_pred_flows_bi,
            selected_masks,
            selected_update_masks,
            local_length,
        )
        pred_img = pred_img.view(-1, 3, process_height, process_width)
        pred_img = ((pred_img + 1.0) / 2.0).detach().float().cpu().clamp(0.0, 1.0)
        binary_masks = masks_dilated[0, neighbor_ids, :, :, :].detach().float().cpu().clamp(0.0, 1.0)

        for offset, frame_index in enumerate(neighbor_ids):
            mask = binary_masks[offset].permute(1, 2, 0)
            image = pred_img[offset].permute(1, 2, 0) * mask + original_frames[frame_index] * (1.0 - mask)
            if composed_frames[frame_index] is None:
                composed_frames[frame_index] = image
            else:
                composed_frames[frame_index] = composed_frames[frame_index] * 0.5 + image * 0.5
            composed_frames[frame_index] = composed_frames[frame_index].clamp(0.0, 1.0)

        _empty_cache()
        if pbar is not None:
            pbar.update(1)

    fallback = original_frames
    result = [frame if frame is not None else fallback[index] for index, frame in enumerate(composed_frames)]
    return torch.stack(result, dim=0).float().clamp(0.0, 1.0)


def _process_inpainting(
    models: _Models,
    frames: torch.Tensor,
    flow_masks: torch.Tensor,
    masks_dilated: torch.Tensor,
    original_frames: torch.Tensor,
    config: _ProPainterConfig,
) -> torch.Tensor:
    neighbor_stride = max(1, config.neighbor_length // 2)
    feature_steps = len(range(0, config.video_length, neighbor_stride))
    pbar = ProgressBar(max(1, feature_steps + 3))

    gt_flows_bi = _compute_flow(models.raft_model, frames, config)
    pbar.update(1)

    if config.use_half:
        frames = frames.half()
        flow_masks = flow_masks.half()
        masks_dilated = masks_dilated.half()
        gt_flows_bi = (gt_flows_bi[0].half(), gt_flows_bi[1].half())

    pred_flows_bi = _complete_flow(models.flow_model, gt_flows_bi, flow_masks, config.subvideo_length)
    pbar.update(1)

    updated_frames, updated_masks = _image_propagation(models.inpaint_model, frames, masks_dilated, pred_flows_bi, config)
    pbar.update(1)

    return _feature_propagation(
        models.inpaint_model,
        updated_frames,
        updated_masks,
        masks_dilated,
        pred_flows_bi,
        original_frames,
        config,
        pbar=pbar,
    )


class GJJ_ProPainterInpaint:
    CATEGORY = "GJJ/🎬 视频/工具"
    FUNCTION = "propainter_inpainting"
    DESCRIPTION = "GJJ 零原插件依赖的 ProPainter 视频遮罩修复单节点；输入 IMAGE 帧序列与 MASK，输出修复帧、光流遮罩和膨胀遮罩。"
    RETURN_TYPES = ("IMAGE", "MASK", "MASK")
    RETURN_NAMES = ("IMAGE", "FLOW_MASK", "MASK_DILATE")
    OUTPUT_TOOLTIPS = (
        "ProPainter 修复完成后的 IMAGE 帧序列。",
        "用于光流补全的膨胀遮罩。",
        "用于最终图像修复的膨胀遮罩。",
    )
    SEARCH_ALIASES = ["ProPainter", "video inpaint", "视频修复", "去水印", "去物", "遮罩修复"]
    GJJ_HELP = {
        "description": DESCRIPTION,
        "模型放置树": MEDIA_MODEL_TREE,
        "models": [
            f"{MODEL_SUBDIR}/{RAFT_MODEL}",
            f"{MODEL_SUBDIR}/{FLOW_MODEL}",
            f"{MODEL_SUBDIR}/{INPAINT_MODEL}",
        ],
        "notice": "节点不会自动下载模型；请把 ProPainter 官方三份 .pth 权重放到 models/ProPainter。",
        "dependencies": ["torchvision（ComfyUI/PyTorch 常规环境通常自带）"],
        "model_download_url": MODEL_DOWNLOAD_URL,
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "图像帧", "tooltip": "需要修复的视频帧序列，至少 2 帧。"}),
                "mask": ("MASK", {"display_name": "修复遮罩", "tooltip": "白色区域表示需要修复；可输入 1 张遮罩复用到所有帧，或与帧数一致的遮罩序列。"}),
                "width": ("INT", {"default": 640, "min": 0, "max": 2560, "step": 8, "display_name": "处理宽度", "tooltip": "模型内部处理宽度；0 表示使用输入宽度。最终会自动对齐到 8 的倍数。"}),
                "height": ("INT", {"default": 360, "min": 0, "max": 2560, "step": 8, "display_name": "处理高度", "tooltip": "模型内部处理高度；0 表示使用输入高度。最终会自动对齐到 8 的倍数。"}),
                "mask_dilates": ("INT", {"default": 5, "min": 0, "max": 100, "display_name": "修复遮罩膨胀", "tooltip": "最终图像修复遮罩的膨胀半径。"}),
                "flow_mask_dilates": ("INT", {"default": 8, "min": 0, "max": 100, "display_name": "光流遮罩膨胀", "tooltip": "光流补全遮罩的膨胀半径。"}),
                "ref_stride": ("INT", {"default": 10, "min": 1, "max": 100, "display_name": "参考帧步长", "tooltip": "每隔多少帧选取一次全局参考帧。"}),
                "neighbor_length": ("INT", {"default": 10, "min": 2, "max": 300, "display_name": "邻域长度", "tooltip": "局部时序窗口长度，越大越吃显存。"}),
                "subvideo_length": ("INT", {"default": 80, "min": 1, "max": 300, "display_name": "分段长度", "tooltip": "长视频分段推理长度，降低显存压力。"}),
                "raft_iter": ("INT", {"default": 20, "min": 1, "max": 100, "display_name": "RAFT迭代", "tooltip": "RAFT 光流迭代次数，越高越慢。"}),
                "fp16": (["enable", "disable"], {"default": "enable", "display_name": "半精度", "tooltip": "CUDA 下启用 fp16 可节省显存；CPU 会自动使用 fp32。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @torch.inference_mode()
    def propainter_inpainting(
        self,
        image: torch.Tensor,
        mask: torch.Tensor,
        width: int,
        height: int,
        mask_dilates: int,
        flow_mask_dilates: int,
        ref_stride: int,
        neighbor_length: int,
        subvideo_length: int,
        raft_iter: int,
        fp16: str,
        unique_id=None,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        device = model_management.get_torch_device()
        (
            frames_tensor,
            flow_masks_tensor,
            masks_dilated_tensor,
            original_frames,
            process_size,
        ) = _prepare_frames_and_masks(
            image,
            mask,
            width,
            height,
            mask_dilates,
            flow_mask_dilates,
            device,
        )

        config = _ProPainterConfig(
            ref_stride=max(1, int(ref_stride)),
            neighbor_length=max(2, int(neighbor_length)),
            subvideo_length=max(1, int(subvideo_length)),
            raft_iter=max(1, int(raft_iter)),
            fp16=str(fp16 or "enable"),
            video_length=int(frames_tensor.shape[1]),
            device=device,
            process_size=process_size,
        )
        models = _load_models(device, config.use_half, unique_id=unique_id)
        output_images = _process_inpainting(
            models,
            frames_tensor,
            flow_masks_tensor,
            masks_dilated_tensor,
            original_frames,
            config,
        )
        output_flow_masks = flow_masks_tensor.squeeze(0).squeeze(1).detach().cpu().float().clamp(0.0, 1.0)
        output_masks_dilated = masks_dilated_tensor.squeeze(0).squeeze(1).detach().cpu().float().clamp(0.0, 1.0)
        return output_images.cpu(), output_flow_masks, output_masks_dilated


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ProPainterInpaint}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "ProPainter视频修复"}
