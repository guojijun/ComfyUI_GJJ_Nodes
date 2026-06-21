from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F

import comfy.model_management
import comfy.sd
import comfy.utils
import folder_paths
from PIL import Image

from .common_utils.dependency_checker import (
    build_dependency_model_report,
    build_node_help_payload,
    make_missing_model_spec,
    print_dependency_model_report,
    raise_dependency_model_error,
    send_dependency_model_notice,
)
from .common_utils.prompt_translation import (
    COMMON_PROMPT_TRANSLATE_API_PATH,
    TRANSLATION_BUNDLE_FILENAME,
    TRANSLATION_DEPENDENCY_SPECS,
    TRANSLATION_MODEL_DOWNLOAD_URL,
    TRANSLATION_MODEL_SUBDIR,
    build_translation_environment_report,
    register_prompt_translation_api,
    translate_zh_to_en,
)


log = logging.getLogger(__name__)

NODE_NAME = "GJJ_SAM3SCAIL2TrackMaskAIO"
DISPLAY_NAME = "GJJ · 🎯🧩 SAM3跟踪SCAIL2彩色遮罩一体机"
MODEL_KEYWORD = "sam3.1_multiplex"
DEFAULT_CHECKPOINT = "sam3.1_multiplex_fp16.safetensors"
MAX_ROUTES = 2
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"

DEFAULT_PALETTE = [
    (0.0, 0.0, 1.0),
    (1.0, 0.0, 0.0),
    (0.0, 1.0, 0.0),
    (1.0, 0.0, 1.0),
    (0.0, 1.0, 1.0),
    (1.0, 1.0, 0.0),
]


class MultiInput(str):
    def __new__(cls, string: str, allowed_types="*"):
        instance = super().__new__(cls, string)
        instance.allowed_types = allowed_types
        return instance

    @staticmethod
    def _type_set(value):
        if isinstance(value, (list, tuple, set)):
            parts = []
            for item in value:
                parts.extend(str(item).split(","))
        else:
            parts = str(value).split(",")
        return {part.strip() for part in parts if part.strip()}

    def __ne__(self, other):
        if self.allowed_types == "*" or other == "*":
            return False
        allowed = self._type_set(self.allowed_types)
        incoming = self._type_set(other)
        return not (incoming.issubset(allowed) or allowed.issubset(incoming))


MEDIA_INPUT = MultiInput(MEDIA_INPUT_TYPE, ["GJJ_BATCH_IMAGE", "IMAGE", "VIDEO"])


def _mask_title(index: int) -> str:
    if index == 1:
        return "姿态彩色遮罩"
    return "参考图彩色遮罩"


def _checkpoint_list() -> list[str]:
    try:
        return list(folder_paths.get_filename_list("checkpoints") or [])
    except Exception:
        return []


def _pick_default_checkpoint() -> str:
    models = _checkpoint_list()
    for name in models:
        if MODEL_KEYWORD.lower() in str(name).lower():
            return name
    return models[0] if models else DEFAULT_CHECKPOINT


def _missing_model_specs() -> list[dict[str, str]]:
    if any(MODEL_KEYWORD.lower() in str(name).lower() for name in _checkpoint_list()):
        return []
    return [
        make_missing_model_spec(
            label="SAM3.1 Multiplex checkpoint",
            subdir="models/checkpoints",
            filename=DEFAULT_CHECKPOINT,
            description="本节点内部用它加载 MODEL/CLIP，并执行官方 SAM3 视频跟踪。",
        )
    ]


_ENVIRONMENT_REPORT = build_dependency_model_report(
    node_name=DISPLAY_NAME,
    missing_models=_missing_model_specs(),
    description="请把包含 sam3.1_multiplex 字样的 SAM3.1 Multiplex checkpoint 放到 models/checkpoints 或其子目录。",
)
if not _ENVIRONMENT_REPORT.get("available", True):
    print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ SAM3+SCAIL-2 一体机模型缺失！")

_TRANSLATION_ENVIRONMENT_REPORT = build_translation_environment_report(
    node_name=DISPLAY_NAME,
    description=(
        "SAM3 视频跟踪会先把跟踪目标文本翻译为英文，因此需要这些依赖和本地翻译模型包。"
        f"模型包请放到 {TRANSLATION_MODEL_SUBDIR}。"
    ),
)
if not _TRANSLATION_ENVIRONMENT_REPORT.get("available", True):
    print_dependency_model_report(_TRANSLATION_ENVIRONMENT_REPORT, title="GJJ SAM3 视频跟踪翻译环境缺失！")
register_prompt_translation_api((COMMON_PROMPT_TRANSLATE_API_PATH,))


SAM31_MODEL_SPEC = make_missing_model_spec(
    label="SAM3.1 Multiplex checkpoint",
    subdir="models/checkpoints",
    filename=DEFAULT_CHECKPOINT,
    description="3.1 版本官方 Multiplex checkpoint；节点内部用 CheckpointLoaderSimple 加载 MODEL/CLIP。",
)
SAM31_MODEL_TREE = [
    {
        "label": DEFAULT_CHECKPOINT,
        "path": "models/checkpoints",
        "required": True,
        "description": "默认 SAM3.1 Multiplex checkpoint；实际执行时会优先匹配 checkpoints 列表中第一个包含 sam3.1_multiplex 的文件。",
    },
    {
        "label": TRANSLATION_BUNDLE_FILENAME,
        "path": "models/translation",
        "filename": TRANSLATION_BUNDLE_FILENAME,
        "required": True,
        "description": "GJJ 单文件 Opus-MT 中英翻译模型包，跟踪目标文本编码前固定使用。",
    },
]

NODE_DESCRIPTION = (
    "SAM3.1 双路图片/视频跟踪 + SCAIL-2 彩色遮罩一体机。"
    "输入图片或视频帧，节点内部完成 SAM3 跟踪并直接输出遮罩：通道1输出姿态彩色遮罩，通道2输出参考图彩色遮罩。"
)

CHANNEL_SYNTAX_HELP = (
    "【通道语法】\n"
    "普通写法没有通道前缀，会作为通用值应用到全部已连接通道。\n"
    "跟踪目标示例：person；通道1=person;通道2=dog；1:person;2:dog；1,2=person。\n"
    "跟踪目标框里输入中文时，前端会把目标值翻译成英文并回填；后端仍保留兜底翻译。\n"
    "对象编号示例：0,2,3；通道1=0,1;通道2=2；1:0,2;2:3。\n"
    "如果同时写通用值和通道值，例如 person;通道2=dog，则通道2用 dog，其它通道用 person。\n"
    "如果只写了部分通道且没有通用值，未指定通道会跳过跟踪；已连接媒体仍会输出同尺寸背景色遮罩。"
)

OUTPUT_RULES_HELP = (
    "【输出规则】\n"
    "输出1：通道1的 SCAIL-2 姿态彩色遮罩，会应用颜色分配排序和对象编号列表。\n"
    "输出2：通道2的 SCAIL-2 参考图彩色遮罩，会应用颜色分配排序和对象编号列表。\n"
    "通道1遮罩等同旧“姿态彩色遮罩”：替换模式关=黑底，开=白底。\n"
    "通道2遮罩等同旧“参考图彩色遮罩”：替换模式关=白底，开=黑底。\n"
    "已连接媒体但没有目标、没有识别到对象、或对象编号全越界时，会输出对应帧数和尺寸的纯背景遮罩。"
)

SORT_AND_INDEX_HELP = (
    "【对象编号与颜色】\n"
    "节点先按“颜色分配排序”重排对象，再用“对象编号列表”筛选。"
    "默认“从左到右”时，0 表示最左边对象，1 表示第二个；选择“保持原顺序”时，编号才对应 SAM3 原始对象顺序。"
    "颜色按固定色板循环分配：蓝、红、绿、洋红、青、黄。"
)

PREVIEW_HELP = (
    "【预览】\n"
    "每个已连接通道都会保存一个 WebP 预览到 ComfyUI 临时目录。"
    "多帧/多图输入会保存为动态 WebP；通道2也保留完整帧序列，不会截成第一帧。"
)

NOTICE_INTRO = "\n\n".join(
    item
    for item in (
        _ENVIRONMENT_REPORT.get("warning_message"),
        _TRANSLATION_ENVIRONMENT_REPORT.get("warning_message"),
    )
    if item
) or "需要本地 SAM3.1 Multiplex checkpoint 和 Opus-MT 翻译模型包；输入图片/视频帧后按文本目标执行视频跟踪并生成彩色遮罩。"

NOTICE_TEXT = "\n\n".join(
    item
    for item in (
        NOTICE_INTRO,
        CHANNEL_SYNTAX_HELP,
        OUTPUT_RULES_HELP,
        SORT_AND_INDEX_HELP,
        PREVIEW_HELP,
    )
    if item
)

SAM31_SCAIL2_HELP = build_node_help_payload(
    description=NODE_DESCRIPTION,
    notice=NOTICE_TEXT,
    dependencies=TRANSLATION_DEPENDENCY_SPECS,
    model_tree=SAM31_MODEL_TREE,
    models=[SAM31_MODEL_SPEC],
    usage=[
        "media_01 是通道1，media_02 是通道2；输入支持 GJJ_BATCH_IMAGE、IMAGE batch 和官方 VIDEO。",
        "跟踪目标没有通道前缀时通用于全部通道；写 通道1=person;通道2=dog 时分别跟踪不同目标；输入中文会在前端翻译成英文回填。",
        "对象编号没有通道前缀时通用于全部通道；写 通道1=0,1;通道2=2 时分别筛选不同对象。",
        "输出只有两个 IMAGE：姿态彩色遮罩、参考图彩色遮罩；SAM3 跟踪数据只在节点内部使用，不再输出。",
        "通道1彩色遮罩按旧“姿态彩色遮罩”规则输出；通道2按旧“参考图彩色遮罩”规则输出。",
        "通道2如果输入是多帧/多图，面板预览会保存完整动态 WebP，不再只取第一帧。",
    ],
    runtime=[
        "CheckpointLoaderSimple 路线加载 SAM3.1 checkpoint，并用 CLIPTextEncode 编码跟踪目标。",
        "前端会优先把中文跟踪目标翻译成英文；后端执行时仍会兜底检查并翻译，避免无前端环境时失败。",
        "每个通道独立执行 SAM3_VideoTrack，未连接媒体的通道不会触发模型跟踪。",
        "颜色分配排序先作用于每个通道，再按对象编号列表过滤对象；默认从左到右时 0 是最左对象。",
        "SAM3_TRACK_DATA 不对外暴露，只作为内部中间数据生成彩色遮罩。",
    ],
    model_download_url=_ENVIRONMENT_REPORT.get("model_download_url", ""),
    copy_text="models/checkpoints/" + DEFAULT_CHECKPOINT,
    copy_label="📋 复制默认模型路径",
    extra={
        "inputs": {
            "跟踪目标": (
                "普通写法例如 person 会应用到全部通道。通道写法可用 "
                "通道1=person; 通道2=dog 或 1:person;2:dog。也支持 1,2=person。没有通道写法时就是通用目标。中文会在前端翻译成英文回填。"
            ),
            "对象编号列表": (
                "普通写法例如 0,2,3 会应用到全部通道。通道写法可用 "
                "通道1=0,1; 通道2=2 或 1:0,1;2:2。编号作用在排序后的对象列表；留空保留全部。"
            ),
            "颜色分配排序": "从左到右、面积从大到小、保持原顺序；先排序，再套用对象编号列表。",
            "替换模式": "开启时通道1白底、通道2黑底；关闭时通道1黑底、通道2白底。",
        },
        "outputs": {
            "姿态彩色遮罩": {
                "type": "IMAGE",
                "description": "通道1遮罩。动画模式黑底，替换模式白底，通常接 GJJ_WanSCAILToVideo 的姿态彩色遮罩。",
            },
            "参考图彩色遮罩": {
                "type": "IMAGE",
                "description": "通道2遮罩。动画模式白底，替换模式黑底；多图/多帧时完整输出并动态 WebP 预览。",
            },
        },
        "features": [
            {
                "name": "🎯 双通道目标语法",
                "description": "跟踪目标支持通用写法和通道写法，同一个节点里可以让两路输入跟踪不同对象；中文目标会在前端翻译成英文。",
            },
            {
                "name": "🧩 双通道对象筛选",
                "description": "对象编号列表同样支持通道写法，可让通道1保留多人，通道2只保留某个参考对象。",
            },
            {
                "name": "🎞️ 通道2动态预览",
                "description": "参考图通道如果输入多图或多帧，会保存完整动态 WebP 预览。",
            },
            {
                "name": "🔌 旧节点能力合并",
                "description": "包含 SAM3.1 加载、文本翻译、视频跟踪、SCAIL-2 彩色遮罩和内部预览；跟踪数据留在内部，不依赖旧节点源文件。",
            },
        ],
        "usage_examples": [
            {
                "title": "单目标通用",
                "description": "跟踪目标填 person，对象编号留空：所有已连接通道都跟踪 person，并保留全部对象。",
            },
            {
                "title": "通道1人物，通道2宠物",
                "description": "跟踪目标填 通道1=person;通道2=dog：通道1输出人物姿态遮罩，通道2输出宠物参考遮罩。",
            },
            {
                "title": "不同通道选不同对象",
                "description": "对象编号填 通道1=0,1;通道2=2：通道1保留排序后的第 0、1 个对象，通道2只保留第 2 个对象。",
            },
            {
                "title": "通用值加局部覆盖",
                "description": "跟踪目标填 person;通道2=face：除通道2跟踪 face 外，其它通道都跟踪 person。",
            },
        ],
        "technical_notes": [
            "对象编号是 0 基编号。",
            "默认从左到右排序时，0 表示最左边对象；保持原顺序时才是 SAM3 原始顺序。",
            "对象编号越界会被忽略；如果没有任何有效编号，该通道遮罩变成纯背景。",
            "后端固定保留 2 路媒体输入和 2 个 IMAGE 输出端口。",
            "前端翻译只处理通道语法右侧的目标值，不会改写 通道1= / 1: 这类前缀。",
        ],
        "troubleshooting": [
            {
                "problem": "通道2预览以前只显示一帧",
                "solution": "这个新节点会对通道2保存完整 WebP 序列；输入有多帧时 frame_count 会大于 1。",
            },
            {
                "problem": "对象编号 0 选到的不是 SAM3 原始第一个对象",
                "solution": "默认会先从左到右排序。需要 SAM3 原始顺序时，把颜色分配排序改成“保持原顺序”。",
            },
            {
                "problem": "某个通道输出纯背景遮罩",
                "solution": "检查该通道是否有媒体、是否有跟踪目标、SAM3 是否识别到对象、对象编号是否越界。",
            },
        ],
        "static_model_tree_only": True,
        "warning_message": _ENVIRONMENT_REPORT.get("warning_message", ""),
        "notice_level": _ENVIRONMENT_REPORT.get("notice_level", "ok"),
        "missing_models": _ENVIRONMENT_REPORT.get("missing_models", []),
        "install_cmd": _ENVIRONMENT_REPORT.get("install_cmd", ""),
        "optional_install_cmd": _ENVIRONMENT_REPORT.get("optional_install_cmd", ""),
        "translation_notice": _TRANSLATION_ENVIRONMENT_REPORT.get("help_message", "")
        if not _TRANSLATION_ENVIRONMENT_REPORT.get("available", True)
        else "",
        "translation_install_cmd": _TRANSLATION_ENVIRONMENT_REPORT.get("install_cmd", ""),
        "translation_copy_text": _TRANSLATION_ENVIRONMENT_REPORT.get("copy_text", ""),
        "translation_model_download_url": _TRANSLATION_ENVIRONMENT_REPORT.get("model_download_url", ""),
        "model_download_url": TRANSLATION_MODEL_DOWNLOAD_URL,
    },
)


def _empty_track_data(images=None) -> dict[str, Any]:
    height = int(images.shape[1]) if isinstance(images, torch.Tensor) and images.ndim >= 3 else 1
    width = int(images.shape[2]) if isinstance(images, torch.Tensor) and images.ndim >= 3 else 1
    frames = int(images.shape[0]) if isinstance(images, torch.Tensor) and images.ndim >= 1 else 0
    return {
        "packed_masks": None,
        "orig_size": (height, width),
        "n_frames": frames,
        "scores": [],
    }


def _extract_images(value: Any) -> torch.Tensor | None:
    if value is None:
        return None
    if isinstance(value, torch.Tensor):
        if value.ndim == 3:
            return value.unsqueeze(0)
        if value.ndim == 4:
            return value
    if isinstance(value, dict):
        for key in ("images", "image", "frames"):
            images = _extract_images(value.get(key))
            if images is not None:
                return images
    if hasattr(value, "get_components"):
        components = value.get_components()
        return _extract_images(getattr(components, "images", None))
    if hasattr(value, "images"):
        return _extract_images(getattr(value, "images"))
    return None


def _extract_text_prompts(conditioning, device, dtype):
    cond_meta = conditioning[0][1]
    multi = cond_meta.get("sam3_multi_cond")
    prompts = []
    if multi is not None:
        for entry in multi:
            emb = entry["cond"].to(device=device, dtype=dtype)
            mask = entry["attention_mask"].to(device) if entry["attention_mask"] is not None else None
            if mask is None:
                mask = torch.ones(emb.shape[0], emb.shape[1], dtype=torch.int64, device=device)
            prompts.append((emb, mask, entry.get("max_detections", 1)))
    else:
        emb = conditioning[0][0].to(device=device, dtype=dtype)
        mask = cond_meta.get("attention_mask")
        if mask is not None:
            mask = mask.to(device)
        else:
            mask = torch.ones(emb.shape[0], emb.shape[1], dtype=torch.int64, device=device)
        prompts.append((emb, mask, 1))
    return prompts


_CHECKPOINT_CACHE: dict[str, Any] = {"key": None, "model": None, "clip": None}


def _raise_sam31_compatibility_error(ckpt_path: str, original_error: Exception):
    message = str(original_error)
    if "Could not detect model type" not in message:
        raise original_error
    raise RuntimeError(
        "SAM3.1 Multiplex 模型已找到，当前 ComfyUI 版本无法识别这种 checkpoint。请升级你的comfyui\n"
        "这个节点使用的是官方 SAM3.1 Multiplex / CheckpointLoaderSimple / CLIPTextEncode / SAM3_VideoTrack 路线，"
        "不能自动替换成 models/sam3 下的 SAM3 模型，因为 sam3 和 sam3.1 是两套不同结构。\n"
        f"模型路径：{ckpt_path}\n"
        "处理方式：请升级到带原生 SAM3.1 支持的 ComfyUI，或在新版 ComfyUI 中使用该节点。"
    ) from original_error


def _load_checkpoint(ckpt_name: str, unique_id=None):
    available = _checkpoint_list()
    if not any(MODEL_KEYWORD.lower() in str(name).lower() for name in available):
        send_dependency_model_notice(_ENVIRONMENT_REPORT, unique_id=unique_id)
        raise_dependency_model_error(
            node_name=DISPLAY_NAME,
            missing_models=_missing_model_specs(),
            description="未在 models/checkpoints 中找到 sam3.1_multiplex。节点不会自动替换成其它 checkpoint。",
            unique_id=unique_id,
            title="GJJ SAM3+SCAIL-2 一体机模型缺失！",
        )
    resolved = ckpt_name if ckpt_name in available else _pick_default_checkpoint()
    ckpt_path = folder_paths.get_full_path_or_raise("checkpoints", resolved)
    cache_key = hashlib.md5(str(ckpt_path).encode("utf-8")).hexdigest()
    if _CHECKPOINT_CACHE["key"] == cache_key and _CHECKPOINT_CACHE["model"] is not None:
        return _CHECKPOINT_CACHE["model"], _CHECKPOINT_CACHE["clip"], resolved
    try:
        model, clip, _vae = comfy.sd.load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )[:3]
    except RuntimeError as exc:
        _raise_sam31_compatibility_error(ckpt_path, exc)
    _CHECKPOINT_CACHE.update({"key": cache_key, "model": model, "clip": clip})
    return model, clip, resolved


def _encode_text(clip, text: str):
    if clip is None:
        raise RuntimeError("checkpoint 中没有可用 CLIP，无法执行文本编码。")
    tokens = clip.tokenize(str(text or "").strip())
    return clip.encode_from_tokens_scheduled(tokens)


def _track_route(images, model, conditioning, detection_threshold, max_objects, detect_interval):
    if images is None:
        return _empty_track_data()
    if not isinstance(images, torch.Tensor) or images.ndim != 4:
        raise RuntimeError("输入必须能解析为 IMAGE batch 或官方 VIDEO 帧序列。")
    if images.shape[0] <= 0:
        return _empty_track_data(images)

    n_frames, height, width, _channels = images.shape
    comfy.model_management.load_model_gpu(model)
    device = comfy.model_management.get_torch_device()
    dtype = model.model.get_dtype()
    sam3_model = model.model.diffusion_model
    frames_in = images[..., :3].movedim(-1, 1)
    pbar = comfy.utils.ProgressBar(n_frames)
    text_prompts = [(emb, mask) for emb, mask, _ in _extract_text_prompts(conditioning, device, dtype)]
    result = sam3_model.forward_video(
        images=frames_in,
        initial_masks=None,
        pbar=pbar,
        text_prompts=text_prompts,
        new_det_thresh=float(detection_threshold),
        max_objects=int(max_objects),
        detect_interval=max(1, int(detect_interval)),
        target_device=device,
        target_dtype=dtype,
    )
    result["orig_size"] = (height, width)
    return result


def _normalize_track_frame_count(track_data: dict[str, Any], images: torch.Tensor | None) -> dict[str, Any]:
    if not isinstance(track_data, dict) or not isinstance(images, torch.Tensor) or images.ndim < 4:
        return track_data

    expected = max(0, int(images.shape[0]))
    normalized = dict(track_data)
    normalized["orig_size"] = (int(images.shape[1]), int(images.shape[2]))
    normalized["n_frames"] = expected

    packed = normalized.get("packed_masks")
    if not isinstance(packed, torch.Tensor) or packed.ndim <= 0:
        return normalized

    current = int(packed.shape[0])
    if current == expected:
        return normalized
    if current > expected:
        normalized["packed_masks"] = packed[:expected].contiguous()
        return normalized

    pad_shape = (expected - current, *tuple(packed.shape[1:]))
    padding = torch.zeros(pad_shape, device=packed.device, dtype=packed.dtype)
    normalized["packed_masks"] = torch.cat([packed, padding], dim=0).contiguous()
    return normalized


def _unpack_sam3_masks(track_data: dict[str, Any]) -> torch.Tensor | None:
    if not isinstance(track_data, dict):
        raise RuntimeError("SAM3轨迹数据无效：需要连接 SAM3_TRACK_DATA。")
    packed = track_data.get("packed_masks")
    if packed is None or int(getattr(packed, "shape", [0, 0])[1]) == 0:
        return None
    return _unpack_sam3_packed_masks(packed)


def _unpack_sam3_packed_masks(packed: torch.Tensor) -> torch.Tensor:
    try:
        from comfy.ldm.sam3.tracker import unpack_masks
    except Exception:
        bits = torch.tensor([1, 2, 4, 8, 16, 32, 64, 128], dtype=torch.uint8, device=packed.device)
        return (packed.to(torch.uint8).unsqueeze(-1) & bits).bool().view(*packed.shape[:-1], -1)
    return unpack_masks(packed)


def _first_frame_cx_area(masks_bool: torch.Tensor) -> tuple[list[float], list[float]]:
    first = masks_bool[0].float()
    height, width = int(first.shape[-2]), int(first.shape[-1])
    n_pixels = max(1, height * width)
    grid_x = torch.arange(width, device=first.device, dtype=first.dtype).view(1, width)
    area = first.sum(dim=(-1, -2)).clamp_(min=1)
    cx = (first * grid_x).sum(dim=(-1, -2)) / area
    return (cx / max(1, width)).tolist(), (area / n_pixels).tolist()


def _subset_track_data(track_data: dict[str, Any], obj_indices: list[int]) -> dict[str, Any]:
    out = dict(track_data)
    packed = track_data.get("packed_masks")
    if packed is None or not obj_indices:
        out["packed_masks"] = None
        if "scores" in out:
            out["scores"] = []
        return out
    out["packed_masks"] = packed[:, obj_indices].contiguous()
    scores = track_data.get("scores")
    if scores is not None:
        out["scores"] = [scores[i] for i in obj_indices if i < len(scores)]
    return out


def _parse_object_indices(text: str, count: int) -> list[int] | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    indices: list[int] = []
    for item in raw.replace("，", ",").split(","):
        value = item.strip()
        if not value:
            continue
        try:
            index = int(value)
        except ValueError as exc:
            raise RuntimeError(f"对象编号列表包含无效值“{value}”。请使用英文或中文逗号分隔的数字，例如 0,2,3。") from exc
        if 0 <= index < count:
            indices.append(index)
    return indices


def _render_colored_masks(track_data: dict[str, Any], background: str = "黑色") -> torch.Tensor:
    packed = track_data.get("packed_masks")
    try:
        height, width = [int(v) for v in track_data["orig_size"]]
    except Exception as exc:
        raise RuntimeError("SAM3轨迹数据缺少 orig_size，无法渲染彩色遮罩。") from exc

    device = comfy.model_management.intermediate_device()
    dtype = comfy.model_management.intermediate_dtype()
    bg_rgb = (1.0, 1.0, 1.0) if str(background).startswith("白") else (0.0, 0.0, 0.0)
    if packed is None or int(packed.shape[1]) == 0:
        frames = int(track_data.get("n_frames", 1)) if packed is None else int(packed.shape[0])
        out = torch.empty(max(1, frames), height, width, 3, device=device, dtype=dtype)
        out[..., 0], out[..., 1], out[..., 2] = bg_rgb[0], bg_rgb[1], bg_rgb[2]
        return out

    frames, object_count = int(packed.shape[0]), int(packed.shape[1])
    colors = torch.tensor(
        [DEFAULT_PALETTE[i % len(DEFAULT_PALETTE)] for i in range(object_count)],
        device=device,
        dtype=dtype,
    )
    masks_full = _unpack_sam3_packed_masks(packed.to(device)).float()
    mask_h, mask_w = int(masks_full.shape[-2]), int(masks_full.shape[-1])
    masks_full = F.interpolate(
        masks_full.view(frames * object_count, 1, mask_h, mask_w),
        size=(height, width),
        mode="nearest",
    ).view(frames, object_count, height, width) > 0.5
    any_mask = masks_full.any(dim=1)
    obj_idx_map = masks_full.to(torch.uint8).argmax(dim=1)
    color_overlay = colors[obj_idx_map]
    bg_tensor = torch.tensor(bg_rgb, device=device, dtype=color_overlay.dtype).view(1, 1, 1, 3)
    return torch.where(any_mask.unsqueeze(-1), color_overlay, bg_tensor.expand_as(color_overlay))


def _fit_mask_frame_count(mask: torch.Tensor, frame_count: int, background: str) -> torch.Tensor:
    if not isinstance(mask, torch.Tensor) or mask.ndim != 4:
        return mask

    expected = max(1, int(frame_count))
    current = int(mask.shape[0])
    if current == expected:
        return mask
    if current > expected:
        return mask[:expected].contiguous()

    bg_value = 1.0 if str(background).startswith("白") else 0.0
    padding = torch.full(
        (expected - current, int(mask.shape[1]), int(mask.shape[2]), int(mask.shape[3])),
        bg_value,
        device=mask.device,
        dtype=mask.dtype,
    )
    return torch.cat([mask, padding], dim=0).contiguous()


def _repair_empty_mask_frames(mask: torch.Tensor, background: str) -> torch.Tensor:
    if not isinstance(mask, torch.Tensor) or mask.ndim != 4 or int(mask.shape[0]) <= 0:
        return mask

    bg_value = 1.0 if str(background).startswith("白") else 0.0
    bg = torch.full((1, 1, 1, 3), bg_value, device=mask.device, dtype=mask.dtype)
    foreground = (mask[..., :3] - bg).abs().amax(dim=(1, 2, 3)) > 0.05
    if bool(foreground.all()):
        return mask

    valid_indices = torch.nonzero(foreground, as_tuple=False).flatten().tolist()
    if not valid_indices:
        return torch.zeros_like(mask)

    repaired = mask.clone()
    for frame_index in range(int(mask.shape[0])):
        if bool(foreground[frame_index]):
            continue
        nearest = min(valid_indices, key=lambda item: abs(int(item) - frame_index))
        repaired[frame_index] = mask[int(nearest)]
    return repaired


def _save_mask_webp_preview(tensor: torch.Tensor, prefix: str, title: str, fps: float = 8.0) -> dict[str, Any] | None:
    if not isinstance(tensor, torch.Tensor) or tensor.numel() == 0:
        return None
    try:
        preview = tensor.detach().cpu().float().clamp(0.0, 1.0).contiguous()
        target_dir = Path(folder_paths.get_temp_directory()) / "GJJ" / "sam3_scail2_track_mask_aio"
        target_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{prefix}_{uuid.uuid4().hex[:12]}.webp"
        filepath = target_dir / filename
        arrays = torch.round(preview[..., :3] * 255.0).to(torch.uint8).numpy()
        pil_frames = [Image.fromarray(array, mode="RGB") for array in arrays]
        pil_frames[0].save(
            filepath,
            format="WEBP",
            save_all=len(pil_frames) > 1,
            append_images=pil_frames[1:],
            duration=max(1, round(1000.0 / max(0.01, float(fps)))),
            loop=0,
            lossless=False,
            quality=90,
            method=4,
        )
        return {
            "filename": filename,
            "subfolder": "GJJ/sam3_scail2_track_mask_aio",
            "type": "temp",
            "format": "image/webp",
            "media_type": "image",
            "title": title,
            "is_sequence": len(pil_frames) > 1,
            "autoplay": len(pil_frames) > 1,
            "loop": len(pil_frames) > 1,
            "frame_rate": float(fps),
            "frame_count": int(preview.shape[0]),
            "width": int(preview.shape[2]),
            "height": int(preview.shape[1]),
        }
    except Exception as exc:
        log.warning("SAM3+SCAIL-2 彩色遮罩预览保存失败：%s", exc)
        return None


def _preview_fps_for_channel(channel_index: int) -> float:
    return 2.0 if int(channel_index) == 2 else 8.0


_CHANNEL_VALUE_PATTERN = re.compile(
    r"^\s*(?:通道|频道|channel|ch|route|路)?\s*\[?\s*"
    r"([0-9]+(?:\s*[,，/|]\s*[0-9]+)*)"
    r"\s*\]?\s*[:：=＝]\s*(.*?)\s*$",
    re.IGNORECASE,
)


def _split_channel_segments(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"[\n;；]+", str(text or "")) if part.strip()]


def _parse_channel_values(text: str, max_routes: int = MAX_ROUTES) -> list[str]:
    raw = str(text or "").strip()
    if not raw:
        return [""] * max_routes

    segments = _split_channel_segments(raw)
    channel_values: dict[int, str] = {}
    common_values: list[str] = []
    found_channel_syntax = False

    for segment in segments:
        match = _CHANNEL_VALUE_PATTERN.match(segment)
        if not match:
            common_values.append(segment)
            continue

        found_channel_syntax = True
        channels_raw, value = match.groups()
        for item in re.split(r"[,，/|]+", channels_raw):
            item = item.strip()
            if not item:
                continue
            index = int(item)
            if 1 <= index <= max_routes:
                channel_values[index] = value.strip()

    if not found_channel_syntax:
        return [raw] * max_routes

    common = "; ".join(common_values).strip()
    values = [common] * max_routes
    for index, value in channel_values.items():
        values[index - 1] = value
    return values


def _translate_prompts(prompts: list[str], unique_id=None) -> list[str]:
    cache: dict[str, str] = {}
    translated: list[str] = []
    for prompt in prompts:
        source = str(prompt or "").strip()
        if not source:
            translated.append("")
            continue
        if source not in cache:
            translated_text = translate_zh_to_en(
                source,
                "auto",
                max_length=512,
                batch_size=8,
                unload_after_use=False,
                unique_id=unique_id,
                node_name=DISPLAY_NAME,
                preserve_chinese_quotes=False,
            ).strip()
            cache[source] = translated_text or source
        translated.append(cache[source])
    return translated


def _background_for_channel(index: int, replacement_mode: bool) -> str:
    if index == 2:
        return "黑色" if bool(replacement_mode) else "白色"
    return "白色" if bool(replacement_mode) else "黑色"


def _prepare_track_data(track_data: dict[str, Any], object_indices: str, sort_by: str) -> dict[str, Any]:
    masks_bool = _unpack_sam3_masks(track_data)
    if masks_bool is not None and sort_by != "保持原顺序":
        cx, area = _first_frame_cx_area(masks_bool)
        if sort_by == "从左到右":
            order = sorted(range(len(cx)), key=lambda i: cx[i])
        elif sort_by == "面积从大到小":
            order = sorted(range(len(area)), key=lambda i: -area[i])
        else:
            order = list(range(len(cx)))
        track_data = _subset_track_data(track_data, order)

    packed = track_data.get("packed_masks")
    object_count = int(packed.shape[1]) if packed is not None else 0
    indices = _parse_object_indices(object_indices, object_count)
    if indices is not None:
        track_data = _subset_track_data(track_data, indices)
    return track_data


class GJJ_SAM3SCAIL2TrackMaskAIO:
    DESCRIPTION = (
        NODE_DESCRIPTION
        if _ENVIRONMENT_REPORT.get("available", True)
        else f"{NODE_DESCRIPTION}\n\n{_ENVIRONMENT_REPORT.get('warning_message', '⚠️缺失模型，点击❓按钮了解详情。')}"
    )
    GJJ_HELP = {
        **SAM31_SCAIL2_HELP,
    }
    CATEGORY = "GJJ/视频生成/SCAIL"
    FUNCTION = "track_and_build"
    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("姿态彩色遮罩", "参考图彩色遮罩")
    OUTPUT_NODE = True
    OUTPUT_TOOLTIPS = (
        "通道1的 SCAIL-2 姿态彩色遮罩。替换模式关闭时为黑底，开启时为白底。",
        "通道2的 SCAIL-2 参考图彩色遮罩。替换模式开启时为黑底，关闭时为白底；多帧会以 2fps 动态 WebP 预览，避免少量参考图快速闪烁。",
    )
    SEARCH_ALIASES = [
        "GJJ_SAM3VideoTrackAIO",
        "GJJ_SCAIL2ColoredMask",
        "SAM3跟踪",
        "SCAIL2ColoredMask",
        "SCAIL-2彩色遮罩",
        "彩色身份遮罩一体机",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        available = _checkpoint_list()
        default_model = _pick_default_checkpoint()
        return {
            "required": {
                "media_01": (
                    MEDIA_INPUT,
                    {
                        "display_name": "图片/视频 1",
                        "tooltip": "第一路输入，支持 GJJ_BATCH_IMAGE、普通 IMAGE batch 和官方 VIDEO。通道1通常作为姿态/驱动视频。",
                    },
                ),
                "media_02": (
                    MEDIA_INPUT,
                    {
                        "display_name": "图片/视频 2",
                        "tooltip": "第二路输入，通常作为参考图/参考帧；多图或多帧时参考图彩色遮罩会动态 WebP 预览。",
                    },
                ),
                "text_prompt": (
                    "STRING",
                    {
                        "default": "person",
                        "multiline": False,
                        "display_name": "跟踪目标",
                        "tooltip": "可直接写 person 通用于全部通道；也可写 通道1=person;通道2=dog 或 1,2=person;3=car 分别指定。未指定通道会使用通用目标，没有通用目标则跳过该通道跟踪。",
                    },
                ),
                "object_indices": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "对象编号列表",
                        "tooltip": "可直接写 0,2,3 通用于全部通道；也可写 通道1=0,1;通道2=2 分别指定。先按颜色分配排序重排对象，再按 0 基编号筛选；留空保留全部。",
                    },
                ),
                "checkpoint": (
                    available or [DEFAULT_CHECKPOINT],
                    {
                        "default": default_model,
                        "display_name": "SAM3.1模型",
                        "tooltip": "自动搜索 models/checkpoints 下第一个包含 sam3.1_multiplex 的模型作为默认值。",
                    },
                ),
                "detection_threshold": (
                    "FLOAT",
                    {
                        "default": 0.5,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "检测阈值",
                        "tooltip": "文本检测的新目标阈值，越高越保守。",
                    },
                ),
                "max_objects": (
                    "INT",
                    {
                        "default": 4,
                        "min": 0,
                        "max": 64,
                        "step": 1,
                        "display_name": "最大对象数",
                        "tooltip": "最多跟踪的对象数量；0 表示使用官方内部上限。",
                    },
                ),
                "detect_interval": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 999,
                        "step": 1,
                        "display_name": "检测间隔",
                        "tooltip": "每隔多少帧重新执行一次文本检测，1 表示每帧检测。",
                    },
                ),
                "sort_by": (
                    ["从左到右", "面积从大到小", "保持原顺序"],
                    {
                        "default": "从左到右",
                        "display_name": "颜色分配排序",
                        "tooltip": "决定对象按什么顺序分配蓝、红、绿、洋红、青、黄等固定色板颜色；排序后再按对象编号过滤。",
                    },
                ),
                "replacement_mode": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "替换模式",
                        "tooltip": "开启时通道1/3-8白底、通道2黑底；关闭时通道1/3-8黑底、通道2白底。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        media_01,
        media_02,
        text_prompt,
        object_indices,
        checkpoint,
        detection_threshold,
        max_objects,
        detect_interval,
        sort_by,
        replacement_mode,
        **kwargs,
    ):
        route_shapes = []
        for media in (media_01, media_02):
            images = _extract_images(media)
            route_shapes.append(tuple(images.shape) if isinstance(images, torch.Tensor) else None)
        return json.dumps(
            [
                text_prompt,
                object_indices,
                checkpoint,
                detection_threshold,
                max_objects,
                detect_interval,
                sort_by,
                bool(replacement_mode),
                route_shapes,
            ],
            ensure_ascii=False,
        )

    def track_and_build(
        self,
        media_01,
        media_02,
        text_prompt,
        object_indices,
        checkpoint,
        detection_threshold=0.5,
        max_objects=4,
        detect_interval=1,
        sort_by="从左到右",
        replacement_mode=False,
        unique_id=None,
        **kwargs,
    ):
        prompt_by_channel = _parse_channel_values(text_prompt, MAX_ROUTES)
        object_indices_by_channel = _parse_channel_values(object_indices, MAX_ROUTES)
        route_images = [
            _extract_images(media_01 if index == 1 else media_02)
            for index in range(1, MAX_ROUTES + 1)
        ]

        active_indices = [
            index
            for index, images in enumerate(route_images, start=1)
            if images is not None and str(prompt_by_channel[index - 1] or "").strip()
        ]

        model = clip = resolved = None
        conditioning_by_prompt: dict[str, Any] = {}
        translated_by_channel = [""] * MAX_ROUTES
        if active_indices:
            model, clip, resolved = _load_checkpoint(checkpoint, unique_id=unique_id)
            translated_by_channel = _translate_prompts(prompt_by_channel, unique_id=unique_id)
            for index in active_indices:
                translated_prompt = translated_by_channel[index - 1]
                if translated_prompt and translated_prompt not in conditioning_by_prompt:
                    conditioning_by_prompt[translated_prompt] = _encode_text(clip, translated_prompt)

        mask_results: list[torch.Tensor] = []
        preview_images: list[dict[str, Any]] = []

        for index, images in enumerate(route_images, start=1):
            source_prompt = str(prompt_by_channel[index - 1] or "").strip()
            translated_prompt = translated_by_channel[index - 1] if active_indices else ""
            expected_frame_count = 1

            if images is None:
                fallback_images = (
                    route_images[0][:1]
                    if index == 2
                    and isinstance(route_images[0], torch.Tensor)
                    and route_images[0].ndim == 4
                    and int(route_images[0].shape[0]) > 0
                    else None
                )
                track_data = _empty_track_data(fallback_images)
                if isinstance(fallback_images, torch.Tensor):
                    expected_frame_count = int(fallback_images.shape[0])
            elif not source_prompt:
                track_data = _empty_track_data(images)
                expected_frame_count = int(images.shape[0])
            else:
                try:
                    expected_frame_count = int(images.shape[0])
                    conditioning = conditioning_by_prompt[translated_prompt]
                    track_data = _track_route(
                        images,
                        model,
                        conditioning,
                        detection_threshold,
                        max_objects,
                        detect_interval,
                    )
                    track_data = _normalize_track_frame_count(track_data, images)
                except Exception as exc:
                    raise RuntimeError(
                        f"SAM3+SCAIL-2 第 {index} 通道执行失败。\n"
                        f"模型：{resolved}\n"
                        f"原始目标：{source_prompt}\n"
                        f"翻译目标：{translated_prompt}\n"
                        f"详细错误：{exc}"
                    ) from exc

            prepared = _prepare_track_data(track_data, object_indices_by_channel[index - 1], sort_by)
            background = _background_for_channel(index, bool(replacement_mode))
            mask = _render_colored_masks(prepared, background)
            if index == 2:
                mask = _repair_empty_mask_frames(mask, background)
            mask = _fit_mask_frame_count(mask, expected_frame_count, background)
            mask_results.append(mask)

            if images is not None:
                preview = _save_mask_webp_preview(
                    mask,
                    f"GJJ_SAM3SCAIL2MaskCh{index:02d}",
                    _mask_title(index),
                    fps=_preview_fps_for_channel(index),
                )
                if preview is not None:
                    preview_images.append(preview)

        return {
            "ui": {
                "images": preview_images,
            },
            "result": tuple(mask_results),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_SAM3SCAIL2TrackMaskAIO}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: DISPLAY_NAME}
