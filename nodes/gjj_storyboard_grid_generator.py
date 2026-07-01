from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any

import comfy.samplers
import folder_paths
import numpy as np
import torch
from PIL import Image

from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .common_utils.model_family import gjjutils_model_family_match_preset as _match_model_family_preset
from .gjj_lazy_image_studio import (
    DEFAULT_CLIP_NAME,
    DEFAULT_UNET_DTYPE,
    DEFAULT_UNET_NAME,
    DEFAULT_VAE_NAME,
    GJJ_LazyImageStudio,
    MAX_MAIN_IMAGE_INDEX,
    UNET_DTYPE_OPTIONS,
    _list_lazy_clip_models,
    _list_lazy_unet_models,
    _preferred_default,
)
from .gjj_model_bundle_loader import list_vae_models
from .gjj_reference_grid_generator import (
    FIT_MODES,
    LAYOUT_MODES,
    SIZE_ALIGN_MODES,
    UPSCALE_METHODS,
    _align_down,
    _alignment_multiple,
    _first_scalar,
    _fit_cell,
)


NODE_NAME = "GJJ_StoryboardGridGenerator"
IMAGE_INPUT_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
MIXED_IMAGE_OUTPUT = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
PREVIEW_SUBFOLDER = "gjj_storyboard_grid_generator"
SCENE_LINE_RE = re.compile(
    r"^\s*(?:scene|shot|镜头|分镜)\s*(?:[#:：\-]?\s*[\d一二三四五六七八九十]+)?(?:\s*[:：]\s*|\s+)"
    r"(?:(?P<label>.*?)\s*(?:[:：]{1,2}|::)\s*)?(?P<body>.+?)\s*$",
    re.IGNORECASE,
)
CHARACTER_REF_RE = re.compile(r"@([0-9A-Za-z\u4e00-\u9fff._-]+)(?:/([0-9A-Za-z\u4e00-\u9fff._-]+))?")
CHARACTER_VIEW_SUFFIX_RE = re.compile(r"^(.+?)([a-gA-G])$")
CHARACTER_SPACED_VIEW_RE = re.compile(r"^[ \t　]+([a-gA-G])(?=$|[\s,，.。;；!！?？]|[\u4e00-\u9fff])")
MULTI_PERSON_KEYWORDS = (
    "两人",
    "二人",
    "俩人",
    "二者",
    "双方",
    "他们",
    "她们",
    "他俩",
    "她俩",
    "两位",
    "二位",
)
SIDE_KEYWORDS = ("侧面", "侧身", "侧脸", "侧视", "左侧", "右侧", "左边", "右边", "profile", "side view", "side")
LEFT_KEYWORDS = ("左侧", "左边", "left")
RIGHT_KEYWORDS = ("右侧", "右边", "right")
BACK_KEYWORDS = ("背面", "背影", "后背", "后视", "背对", "from behind", "back view", "back")
CLOSEUP_KEYWORDS = (
    "特写",
    "近景",
    "半脸",
    "脸部",
    "面部",
    "头像",
    "大头",
    "大头照",
    "头部",
    "close-up",
    "closeup",
    "portrait",
    "headshot",
    "face",
)
HEAD_LABEL_KEYWORDS = ("大头照", "头部", "头像", "脸", "面部", "head", "face")
FRONT_LABEL_KEYWORDS = ("正面", "前面", "全身", "front")
LEFT_LABEL_KEYWORDS = ("左侧", "左", "left")
RIGHT_LABEL_KEYWORDS = ("右侧", "右", "right")
BACK_LABEL_KEYWORDS = ("背面", "后视", "背", "背部", "背影", "后背", "背对", "back")
ANGLE_LABEL_KEYWORDS = ("45", "斜侧", "侧身", "angle")
CELL_BLEED_PROMPT = "按当前宫格画幅构图，画面铺满宫格；主体和关键文字/道具不要贴边，四边保留约5%的安全出血空间。"
GENDER_PREFIX_RE = re.compile(r"^\s*(?:♀️|♂️|♀|♂)\s*")
QWEN_NEXT_SCENE_LORA = "next-scene_lora-v2-3000.safetensors"
QWEN_NEXT_SCENE_PROMPT_PREFIX = "下一个场景："


def _send_status(unique_id: Any, text: str) -> None:
    if unique_id is None or _safe_text(unique_id).strip() == "":
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": _safe_text(text).strip() or "处理中..."},
        )
    except Exception:
        pass


def _send_live_preview(unique_id: Any, image: torch.Tensor, index: int, total: int) -> None:
    if unique_id is None or _safe_text(unique_id).strip() == "" or not isinstance(image, torch.Tensor):
        return
    try:
        preview = _ensure_bhwc_rgb(image)[:1].detach().float().clamp(0.0, 1.0).cpu()[0]
        array = (preview.numpy() * 255.0).round().astype(np.uint8)
        out_dir = os.path.join(folder_paths.get_temp_directory(), PREVIEW_SUBFOLDER)
        os.makedirs(out_dir, exist_ok=True)
        filename = f"storyboard_{uuid.uuid4().hex[:12]}_{int(index):03d}.png"
        Image.fromarray(array, "RGB").save(os.path.join(out_dir, filename), compress_level=4)

        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_storyboard_grid_preview",
            {
                "node": str(unique_id),
                "index": int(index),
                "total": int(total),
                "image": {
                    "filename": filename,
                    "subfolder": PREVIEW_SUBFOLDER,
                    "type": "temp",
                },
            },
        )
    except Exception as exc:
        print(f"[GJJ StoryboardGridGenerator] 发送实时预览失败: {exc}")


def _split_prompt_segments(prompt: Any) -> list[str]:
    text = _safe_text(prompt).strip()
    if not text:
        return []
    scene_segments = _split_scene_line_segments(text)
    if scene_segments:
        return scene_segments
    parts = re.split(r"(?:^\s*---+\s*$)|(?:\n\s*\n+)", text, flags=re.MULTILINE)
    return [part.strip() for part in parts if part.strip()]


def _split_scene_line_segments(text: str) -> list[str]:
    segments: list[str] = []
    current: list[str] = []
    matched = False

    def flush_current() -> None:
        if not current:
            return
        value = "\n".join(item for item in current if item).strip()
        if value:
            segments.append(value)
        current.clear()

    for raw_line in _safe_text(text).splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = SCENE_LINE_RE.match(line)
        if match:
            matched = True
            flush_current()
            label = _safe_text(match.group("label")).strip(" 　-—:：")
            body = _safe_text(match.group("body")).strip()
            current.append(f"{label}，{body}" if label else body)
        elif matched and current:
            current.append(line)

    flush_current()
    return segments if matched else []


def _split_media(value: Any) -> list[torch.Tensor]:
    if value is None:
        return []
    if isinstance(value, torch.Tensor):
        tensor = _ensure_bhwc_rgb(value)
        return [tensor[index : index + 1].contiguous() for index in range(int(tensor.shape[0]))]
    if isinstance(value, dict):
        images: list[torch.Tensor] = []
        for item in value.values():
            images.extend(_split_media(item))
        return images
    if isinstance(value, (list, tuple)):
        images: list[torch.Tensor] = []
        for item in value:
            images.extend(_split_media(item))
        return images
    return []


def _safe_text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, torch.Tensor):
        if value.numel() == 0:
            return default
        if value.numel() == 1:
            try:
                return str(value.detach().cpu().reshape(-1)[0].item())
            except Exception:
                return default
        return default
    return str(value)


def _ensure_bhwc_rgb(image: torch.Tensor) -> torch.Tensor:
    tensor = image.detach().float().clamp(0.0, 1.0)
    if tensor.ndim == 3:
        if int(tensor.shape[-1]) in (1, 3, 4):
            tensor = tensor.unsqueeze(0)
        elif int(tensor.shape[0]) in (1, 3, 4):
            tensor = tensor.movedim(0, -1).unsqueeze(0)
        else:
            raise RuntimeError(f"场景图维度不支持：{tuple(tensor.shape)}")
    if tensor.ndim != 4:
        raise RuntimeError(f"场景图维度不支持：{tuple(tensor.shape)}")
    if int(tensor.shape[-1]) not in (1, 3, 4) and int(tensor.shape[1]) in (1, 3, 4):
        tensor = tensor.movedim(1, -1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 4:
        rgb = tensor[..., :3]
        alpha = tensor[..., 3:4].clamp(0.0, 1.0)
        tensor = rgb * alpha + (1.0 - alpha)
    elif channels > 4:
        tensor = tensor[..., :3]
    elif channels != 3:
        raise RuntimeError(f"场景图通道数不支持：{channels}")
    return tensor.contiguous()


def _resize_crop_short_edge(image: torch.Tensor, target_width: int, target_height: int) -> torch.Tensor:
    target_width = _align_down(target_width, 32, 64)
    target_height = _align_down(target_height, 32, 64)
    tensor = _ensure_bhwc_rgb(image)
    source_height = int(tensor.shape[1])
    source_width = int(tensor.shape[2])
    if source_width <= 0 or source_height <= 0:
        raise RuntimeError("场景图尺寸无效，无法短边缩放裁剪。")

    scale = max(target_width / source_width, target_height / source_height)
    resized_width = max(target_width, int(round(source_width * scale)))
    resized_height = max(target_height, int(round(source_height * scale)))
    nchw = tensor.movedim(-1, 1)
    resized = torch.nn.functional.interpolate(
        nchw,
        size=(resized_height, resized_width),
        mode="bilinear",
        align_corners=False,
        antialias=True,
    ).movedim(1, -1)

    top = max(0, (resized_height - target_height) // 2)
    left = max(0, (resized_width - target_width) // 2)
    return resized[:, top : top + target_height, left : left + target_width, :].clamp(0.0, 1.0).contiguous()


def _resize_fit_reference(image: torch.Tensor, target_width: int, target_height: int) -> torch.Tensor:
    target_width = _align_down(target_width, 32, 64)
    target_height = _align_down(target_height, 32, 64)
    tensor = _ensure_bhwc_rgb(image)
    source_height = int(tensor.shape[1])
    source_width = int(tensor.shape[2])
    if source_width <= 0 or source_height <= 0:
        raise RuntimeError("参考图尺寸无效，无法缩放到目标尺寸。")

    scale = min(target_width / source_width, target_height / source_height)
    resized_width = max(1, min(target_width, int(round(source_width * scale))))
    resized_height = max(1, min(target_height, int(round(source_height * scale))))
    resized = torch.nn.functional.interpolate(
        tensor.movedim(-1, 1),
        size=(resized_height, resized_width),
        mode="bilinear",
        align_corners=False,
        antialias=True,
    ).movedim(1, -1)
    canvas = torch.ones((int(tensor.shape[0]), target_height, target_width, 3), dtype=resized.dtype, device=resized.device)
    top = max(0, (target_height - resized_height) // 2)
    left = max(0, (target_width - resized_width) // 2)
    canvas[:, top : top + resized_height, left : left + resized_width, :] = resized
    return canvas.clamp(0.0, 1.0).contiguous()


def _character_library_root() -> Path:
    models_dir = Path(getattr(folder_paths, "models_dir", "") or "")
    if not str(models_dir):
        models_dir = Path(__file__).resolve().parents[2] / "models"
    return models_dir / "GJJ" / "character_library"


def _character_library_items() -> list[dict[str, Any]]:
    root = _character_library_root()
    if not root.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        path = entry / "manifest.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}
        data["id"] = _safe_text(data.get("id") or entry.name).strip()
        data["name"] = _safe_text(data.get("name") or data["id"]).strip()
        data["notes"] = _safe_text(data.get("notes") or "").strip()
        data["_dir"] = str(entry)
        data["_folder_id"] = entry.name
        views = data.get("views") if isinstance(data.get("views"), list) else []
        data["views"] = [view for view in views if isinstance(view, dict)]
        items.append(data)
    return items


def _character_library_signature() -> str:
    root = _character_library_root()
    if not root.is_dir():
        return ""
    parts: list[str] = []
    try:
        for path in root.glob("*/*"):
            if path.is_file() and path.suffix.lower() in {".json", ".png"}:
                stat = path.stat()
                parts.append(f"{path.parent.name}/{path.name}:{int(stat.st_mtime_ns)}:{int(stat.st_size)}")
    except Exception:
        return ""
    return "|".join(sorted(parts))


def _normalize_character_key(value: Any) -> str:
    return GENDER_PREFIX_RE.sub("", _safe_text(value).strip().lstrip("@")).strip().casefold()


def _find_character(name: str) -> dict[str, Any] | None:
    key = _normalize_character_key(name)
    if not key:
        return None
    items = _character_library_items()
    for item in items:
        if (
            _normalize_character_key(item.get("id")) == key
            or _normalize_character_key(item.get("_folder_id")) == key
            or _normalize_character_key(item.get("name")) == key
        ):
            return item
    for item in items:
        if (
            key in _normalize_character_key(item.get("name"))
            or key in _normalize_character_key(item.get("id"))
            or key in _normalize_character_key(item.get("_folder_id"))
        ):
                return item
    return None


def _character_alias_keys(character: dict[str, Any]) -> list[tuple[str, str]]:
    aliases: list[tuple[str, str]] = []
    for value in (character.get("name"), character.get("id"), character.get("_folder_id")):
        text = _safe_text(value).strip()
        key = _normalize_character_key(text)
        if text and key:
            aliases.append((text, key))
    return aliases


def _find_exact_character(name: str) -> dict[str, Any] | None:
    key = _normalize_character_key(name)
    if not key:
        return None
    for item in _character_library_items():
        if any(alias_key == key for _alias, alias_key in _character_alias_keys(item)):
            return item
    return None


def _split_character_view_suffix(value: str) -> tuple[str, str] | None:
    key = _normalize_character_key(value)
    if not key:
        return None
    candidates: list[tuple[int, str, str]] = []
    for item in _character_library_items():
        for alias, alias_key in _character_alias_keys(item):
            if not alias_key or not key.startswith(alias_key):
                continue
            rest = key[len(alias_key) :]
            if not rest or rest[0] not in "abcdefg":
                continue
            candidates.append((len(alias_key), alias, rest[0]))
    if not candidates:
        return None
    _length, alias, suffix = max(candidates, key=lambda item: item[0])
    return alias, suffix


def _character_display_name(character: dict[str, Any], fallback: str = "") -> str:
    value = _safe_text(character.get("name") or character.get("id") or fallback).strip()
    return GENDER_PREFIX_RE.sub("", value).strip() or _safe_text(fallback).strip()


def _view_label(view: dict[str, Any]) -> str:
    return _safe_text(view.get("label") or view.get("id") or view.get("file")).strip()


def _view_texts(view: dict[str, Any]) -> list[str]:
    file_name = _safe_text(view.get("file")).strip()
    values = [
        _safe_text(view.get("id")).strip(),
        _safe_text(view.get("label")).strip(),
        file_name,
        Path(file_name).stem if file_name else "",
    ]
    return [value for value in values if value]


def _view_file(character: dict[str, Any], view: dict[str, Any]) -> Path | None:
    file_name = _safe_text(view.get("file")).strip()
    if not file_name:
        return None
    path = (Path(_safe_text(character.get("_dir"))) / file_name).resolve()
    try:
        if Path(_safe_text(character.get("_dir"))).resolve() not in path.parents:
            return None
    except Exception:
        return None
    return path if path.is_file() else None


def _find_view(character: dict[str, Any], keywords: tuple[str, ...], explicit_label: str = "") -> dict[str, Any] | None:
    views = character.get("views") if isinstance(character.get("views"), list) else []
    if explicit_label:
        wanted = explicit_label.casefold()
        for view in views:
            if any(label.casefold() == wanted for label in _view_texts(view)):
                return view
        if len(wanted) == 1 and "a" <= wanted <= "g":
            index = ord(wanted) - ord("a")
            if 0 <= index < len(views):
                return views[index]
        for view in views:
            if any(wanted in label.casefold() for label in _view_texts(view)):
                return view
        semantic_keywords = _explicit_view_keywords(explicit_label)
        if semantic_keywords:
            semantic = _find_view(character, semantic_keywords)
            if semantic is not None:
                return semantic
    for keyword in keywords:
        needle = keyword.casefold()
        for view in views:
            if needle and any(needle in label.casefold() for label in _view_texts(view)):
                return view
    return None


def _explicit_view_keywords(value: str) -> tuple[str, ...]:
    text = _safe_text(value).strip().casefold()
    if not text:
        return ()
    if any(keyword.casefold() in text for keyword in BACK_LABEL_KEYWORDS):
        return BACK_LABEL_KEYWORDS
    if any(keyword.casefold() in text for keyword in HEAD_LABEL_KEYWORDS + CLOSEUP_KEYWORDS):
        return HEAD_LABEL_KEYWORDS
    if any(keyword.casefold() in text for keyword in LEFT_LABEL_KEYWORDS):
        return LEFT_LABEL_KEYWORDS + ANGLE_LABEL_KEYWORDS
    if any(keyword.casefold() in text for keyword in RIGHT_LABEL_KEYWORDS):
        return RIGHT_LABEL_KEYWORDS + ANGLE_LABEL_KEYWORDS
    if any(keyword.casefold() in text for keyword in SIDE_KEYWORDS + ANGLE_LABEL_KEYWORDS):
        return LEFT_LABEL_KEYWORDS + RIGHT_LABEL_KEYWORDS + ANGLE_LABEL_KEYWORDS
    if any(keyword.casefold() in text for keyword in FRONT_LABEL_KEYWORDS):
        return FRONT_LABEL_KEYWORDS
    return ()


def _character_view_position(character: dict[str, Any], view: dict[str, Any] | None) -> int:
    views = character.get("views") if isinstance(character.get("views"), list) else []
    if view is None:
        return 0
    for index, item in enumerate(views, start=1):
        if item is view:
            return index
        if (
            _safe_text(item.get("id")) == _safe_text(view.get("id"))
            and _safe_text(item.get("file")) == _safe_text(view.get("file"))
        ):
            return index
    return 0


def _prompt_wants_back(text: str) -> bool:
    lowered = text.casefold()
    return any(keyword.casefold() in lowered for keyword in BACK_KEYWORDS)


def _prompt_wants_side(text: str) -> bool:
    lowered = text.casefold()
    return any(keyword.casefold() in lowered for keyword in SIDE_KEYWORDS)


def _prompt_wants_closeup(text: str) -> bool:
    lowered = text.casefold()
    return any(keyword.casefold() in lowered for keyword in CLOSEUP_KEYWORDS)


def _side_view_keywords(text: str) -> tuple[str, ...]:
    lowered = text.casefold()
    if any(keyword.casefold() in lowered for keyword in LEFT_KEYWORDS):
        return LEFT_LABEL_KEYWORDS + ANGLE_LABEL_KEYWORDS
    if any(keyword.casefold() in lowered for keyword in RIGHT_KEYWORDS):
        return RIGHT_LABEL_KEYWORDS + ANGLE_LABEL_KEYWORDS
    return LEFT_LABEL_KEYWORDS + RIGHT_LABEL_KEYWORDS + ANGLE_LABEL_KEYWORDS


def _view_orientation_instruction(view: dict[str, Any]) -> str:
    label = _view_label(view).casefold()
    if any(keyword.casefold() in label for keyword in BACK_LABEL_KEYWORDS):
        return "必须呈现背面/背对镜头"
    if any(keyword.casefold() in label for keyword in LEFT_LABEL_KEYWORDS + RIGHT_LABEL_KEYWORDS):
        return "必须呈现侧面/侧身角度"
    if any(keyword.casefold() in label for keyword in HEAD_LABEL_KEYWORDS):
        return "必须呈现大头照/特写构图"
    if any(keyword.casefold() in label for keyword in FRONT_LABEL_KEYWORDS):
        return "必须呈现正面全身"
    return "必须保持该参考图的朝向、姿态和镜头角度"


def _open_character_view(character: dict[str, Any], view: dict[str, Any]) -> Image.Image | None:
    path = _view_file(character, view)
    if path is None:
        return None
    try:
        image = Image.open(path).convert("RGBA")
        image = _remove_checkerboard_background(image)
        image = _crop_character_reference_alpha(image)
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        background.alpha_composite(image)
        return background.convert("RGB")
    except Exception:
        return None


def _remove_checkerboard_background(image: Image.Image) -> Image.Image:
    if image.mode != "RGBA" or image.width < 16 or image.height < 16:
        return image
    array = np.asarray(image).copy()
    rgb = array[..., :3].astype(np.int16)
    alpha = array[..., 3]
    height, width = alpha.shape
    border = np.concatenate(
        [
            array[:3, :, :].reshape(-1, 4),
            array[-3:, :, :].reshape(-1, 4),
            array[:, :3, :].reshape(-1, 4),
            array[:, -3:, :].reshape(-1, 4),
        ],
        axis=0,
    )
    border_rgb = border[:, :3].astype(np.int16)
    border_alpha = border[:, 3]
    border_chroma = border_rgb.max(axis=1) - border_rgb.min(axis=1)
    border_bright = border_rgb.mean(axis=1)
    border_candidates = border[(border_alpha > 16) & (border_chroma <= 18) & (border_bright >= 120)]
    if border_candidates.shape[0] < max(16, int((width + height) * 0.04)):
        return image
    quantized = (border_candidates[:, :3] // 16).astype(np.int16)
    values, counts = np.unique(quantized, axis=0, return_counts=True)
    order = np.argsort(counts)[::-1]
    colors: list[np.ndarray] = []
    for item_index in order[:4]:
        color = (values[item_index].astype(np.int16) * 16 + 8).clip(0, 255)
        if all(np.linalg.norm(color - existing) > 18 for existing in colors):
            colors.append(color)
        if len(colors) >= 2:
            break
    if not colors:
        return image
    distances = [np.abs(rgb - color.reshape(1, 1, 3)).max(axis=2) for color in colors]
    checker_candidate = (alpha > 16) & (np.minimum.reduce(distances) <= 28)
    visited = np.zeros((height, width), dtype=np.bool_)
    remove = np.zeros((height, width), dtype=np.bool_)
    stack: list[tuple[int, int]] = []
    for x in range(width):
        if checker_candidate[0, x]:
            stack.append((x, 0))
        if checker_candidate[height - 1, x]:
            stack.append((x, height - 1))
    for y in range(height):
        if checker_candidate[y, 0]:
            stack.append((0, y))
        if checker_candidate[y, width - 1]:
            stack.append((width - 1, y))
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= width or y >= height or visited[y, x] or not checker_candidate[y, x]:
            continue
        visited[y, x] = True
        remove[y, x] = True
        stack.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    if remove.mean() < 0.01:
        return image
    array[..., 3] = np.where(remove, 0, alpha).astype(np.uint8)
    return Image.fromarray(array, "RGBA")


def _alpha_components(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    height, width = mask.shape
    visited = np.zeros((height, width), dtype=np.bool_)
    components: list[tuple[int, int, int, int, int]] = []
    for start_y, start_x in zip(*np.nonzero(mask & ~visited)):
        if visited[start_y, start_x]:
            continue
        stack = [(int(start_x), int(start_y))]
        visited[start_y, start_x] = True
        min_x = max_x = int(start_x)
        min_y = max_y = int(start_y)
        area = 0
        while stack:
            x, y = stack.pop()
            area += 1
            min_x = min(min_x, x)
            max_x = max(max_x, x)
            min_y = min(min_y, y)
            max_y = max(max_y, y)
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if nx < 0 or ny < 0 or nx >= width or ny >= height:
                    continue
                if visited[ny, nx] or not mask[ny, nx]:
                    continue
                visited[ny, nx] = True
                stack.append((nx, ny))
        components.append((min_x, min_y, max_x + 1, max_y + 1, area))
    return components


def _crop_character_reference_alpha(image: Image.Image) -> Image.Image:
    if image.mode != "RGBA" or image.width < 8 or image.height < 8:
        return image
    alpha = np.asarray(image.getchannel("A"))
    if int(alpha.max(initial=0)) <= 16 or int(alpha.min(initial=255)) >= 240:
        return image
    mask = alpha > 16
    components = _alpha_components(mask)
    if not components:
        return image
    image_area = max(1, image.width * image.height)
    useful = [comp for comp in components if comp[4] >= max(16, int(image_area * 0.0004))]
    if not useful:
        useful = components
    upper = [
        comp
        for comp in useful
        if comp[1] < image.height * 0.72
        and ((comp[1] + comp[3]) * 0.5) < image.height * 0.78
        and ((comp[3] - comp[1]) > image.height * 0.08 or comp[4] > image_area * 0.01)
    ]
    keep = upper or useful
    left = max(0, min(comp[0] for comp in keep) - 8)
    top = max(0, min(comp[1] for comp in keep) - 8)
    right = min(image.width, max(comp[2] for comp in keep) + 8)
    bottom = min(image.height, max(comp[3] for comp in keep) + 8)
    if right <= left or bottom <= top:
        return image
    return image.crop((left, top, right, bottom))


def _select_character_view(character: dict[str, Any], prompt_text: str, explicit_label: str = "") -> dict[str, Any] | None:
    selected: dict[str, Any] | None = None
    if explicit_label:
        return _find_view(character, (), explicit_label)
    elif _prompt_wants_closeup(prompt_text):
        selected = _find_view(character, HEAD_LABEL_KEYWORDS)
    elif _prompt_wants_back(prompt_text):
        selected = _find_view(character, BACK_LABEL_KEYWORDS)
    elif _prompt_wants_side(prompt_text):
        selected = _find_view(character, _side_view_keywords(prompt_text))
    else:
        selected = _find_view(character, FRONT_LABEL_KEYWORDS)
    if selected is None:
        views = character.get("views") if isinstance(character.get("views"), list) else []
        selected = views[0] if views else None
    return selected


def _character_reference_images(character: dict[str, Any], prompt_text: str, explicit_label: str = "") -> list[Image.Image]:
    selected = _select_character_view(character, prompt_text, explicit_label)
    image = _open_character_view(character, selected) if selected is not None else None
    return [image] if image is not None else []


def _pil_fit_cell(image: Image.Image, width: int, height: int, contain: bool = False) -> Image.Image:
    source = image.convert("RGB")
    if contain:
        scale = min(width / max(1, source.width), height / max(1, source.height))
    else:
        scale = max(width / max(1, source.width), height / max(1, source.height)) * 1.02
    new_size = (max(1, int(round(source.width * scale))), max(1, int(round(source.height * scale))))
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    resized = source.resize(new_size, resampling)
    canvas = Image.new("RGB", (width, height), (255, 255, 255))
    canvas.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
    return canvas


def _make_character_reference_tensor(images: list[Image.Image], contain_images: bool = False) -> torch.Tensor | None:
    if not images:
        return None
    cell_w, cell_h = 512, 640
    tensors: list[torch.Tensor] = []
    for image in images:
        cell = _pil_fit_cell(image, cell_w, cell_h, contain=contain_images)
        array = np.asarray(cell).astype(np.float32) / 255.0
        tensors.append(torch.from_numpy(array).unsqueeze(0))
    return torch.cat(tensors, dim=0).contiguous()


def _extract_character_refs(text: str) -> list[tuple[str, str]]:
    refs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    source = _safe_text(text)
    for match in CHARACTER_REF_RE.finditer(source):
        name = _safe_text(match.group(1)).strip(" 　.,，;；。!！?？")
        view = _safe_text(match.group(2)).strip(" 　.,，;；。!！?？")
        if not view:
            spaced_view = CHARACTER_SPACED_VIEW_RE.match(source[match.end() :])
            if spaced_view and _find_exact_character(name):
                view = spaced_view.group(1).lower()
        name, view = _resolve_character_ref_name_view(name, view)
        if not name:
            continue
        key = (name.casefold(), view.casefold())
        if key in seen:
            continue
        seen.add(key)
        refs.append((name, view))
    return refs


def _resolve_character_ref_name_view(name: str, view: str = "") -> tuple[str, str]:
    clean_name = _safe_text(name).strip()
    clean_view = _safe_text(view).strip()
    if not clean_name or clean_view:
        return clean_name, clean_view
    if _find_exact_character(clean_name):
        return clean_name, clean_view
    prefix_match = _split_character_view_suffix(clean_name)
    if prefix_match:
        return prefix_match
    match = CHARACTER_VIEW_SUFFIX_RE.match(clean_name)
    if not match:
        return clean_name, clean_view
    base_name = match.group(1).strip()
    suffix = match.group(2).lower()
    if base_name and _find_exact_character(base_name):
        return base_name, suffix
    return clean_name, clean_view


def _prompt_mentions_multi_person(text: str) -> bool:
    lowered = _safe_text(text).casefold()
    return any(keyword.casefold() in lowered for keyword in MULTI_PERSON_KEYWORDS)


def _merge_character_refs(base: list[tuple[str, str]], extra: list[tuple[str, str]], limit: int = 2) -> list[tuple[str, str]]:
    refs = list(base)
    seen = {name.casefold() for name, _view in refs}
    for name, view in extra:
        if len(refs) >= limit:
            break
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        refs.append((name, view))
    return refs


def _storyboard_character_context(prompts: list[str]) -> list[tuple[str, str]]:
    refs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for line in prompts:
        for name, _view in _extract_character_refs(line):
            key = name.casefold()
            if key in seen:
                continue
            if _find_character(name):
                seen.add(key)
                refs.append((name, ""))
    return refs


def _resolved_character_refs(prompt_text: str, storyboard_refs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    refs = _extract_character_refs(prompt_text)
    if _prompt_mentions_multi_person(prompt_text) and storyboard_refs:
        refs = _merge_character_refs(refs, storyboard_refs, 2)
    if not refs:
        return []
    return refs


def _character_position_hints(text: str) -> dict[str, str]:
    hints: dict[str, str] = {}
    source = _safe_text(text)
    for match in CHARACTER_REF_RE.finditer(source):
        raw_name = _safe_text(match.group(1)).strip(" 　.,，;；。!！?？")
        raw_view = _safe_text(match.group(2)).strip(" 　.,，;；。!！?？")
        name, view = _resolve_character_ref_name_view(raw_name, raw_view)
        if not name:
            continue
        prefix = source[max(0, match.start() - 12) : match.start()].casefold()
        left_at = max((prefix.rfind(keyword.casefold()) for keyword in LEFT_KEYWORDS), default=-1)
        right_at = max((prefix.rfind(keyword.casefold()) for keyword in RIGHT_KEYWORDS), default=-1)
        if left_at < 0 and right_at < 0:
            continue
        key = name.casefold()
        hint = "right" if right_at > left_at else "left"
        hints[key] = hint
        if view:
            hints[(name + "/" + view).casefold()] = hint
    return hints


def _character_layout_lines(characters: list[tuple[str, dict[str, Any]]], position_hints: dict[str, str] | None = None) -> list[str]:
    if len(characters) <= 1:
        return []
    positions = {
        "left": ("画面左侧", "右侧用场景、道具、光影或背景空间自然填充，不要复制或挤入其他人物"),
        "right": ("画面右侧", "左侧用场景、道具、光影或背景空间自然填充，不要复制或挤入其他人物"),
        "center": ("画面中间", "左右两侧用场景、道具、光影或背景空间自然填充，保持主体居中清晰"),
    }
    default_order = ("left", "right", "center")
    used: set[str] = set()
    assigned: list[str] = []
    hints = position_hints or {}
    for name, _character in characters[:3]:
        hint = hints.get(name.casefold())
        if hint in positions and hint not in used:
            assigned.append(hint)
            used.add(hint)
            continue
        assigned.append("")
    for index, value in enumerate(assigned):
        if value:
            continue
        for candidate in default_order:
            if candidate not in used:
                assigned[index] = candidate
                used.add(candidate)
                break
        if not assigned[index]:
            assigned[index] = default_order[min(index, len(default_order) - 1)]
    lines: list[str] = []
    for index, (name, character) in enumerate(characters[:3]):
        display_name = _character_display_name(character, name)
        position, fill_rule = positions[assigned[index]]
        lines.append(f"{index + 1}. {display_name} 默认位于{position}；{fill_rule}。")
    if len(characters) > 3:
        extra_names = "、".join(_character_display_name(character, name) for name, character in characters[3:])
        if extra_names:
            lines.append(f"其余角色 {extra_names} 作为背景或次要人物，避免抢占前三个主角色位置。")
    return lines


def _character_prompt_and_reference(
    prompt_text: str,
    storyboard_refs: list[tuple[str, str]] | None = None,
    contain_reference_images: bool = False,
    first_reference_image_index: int = 1,
) -> tuple[str, torch.Tensor | None]:
    refs = _resolved_character_refs(prompt_text, storyboard_refs or [])
    if not refs:
        return prompt_text, None
    prompt_lines: list[str] = []
    images: list[Image.Image] = []
    resolved_characters: list[tuple[str, dict[str, Any]]] = []
    image_slot = max(1, int(first_reference_image_index or 1))
    for name, explicit_view in refs:
        character = _find_character(name)
        if not character:
            continue
        resolved_characters.append((name, character))
        display_name = _character_display_name(character, name)
        notes = _safe_text(character.get("notes") or "").strip()
        if notes:
            prompt_lines.append(f"{display_name}：人物特色：{notes}")
        else:
            prompt_lines.append(f"{display_name}：保持该人物的五官、发型、服装配色和身份一致。")
        selected_view = _select_character_view(character, prompt_text, explicit_view)
        character_images = _character_reference_images(character, prompt_text, explicit_view)
        if character_images:
            image_ref = f"image{image_slot}"
            prompt_lines.append(f"{display_name}：对应参考图为 {image_ref}，生成时必须使用这张图作为该角色参考。")
            image_slot += len(character_images)
        if explicit_view and selected_view is not None:
            view_index = _character_view_position(character, selected_view)
            view_label = _view_label(selected_view)
            orientation = _view_orientation_instruction(selected_view)
            if view_index:
                prompt_lines.append(
                    f"{display_name}：本格已通过 @{name}{explicit_view} 指定使用角色库第 {view_index} 张参考图；"
                    f"{orientation}，不要自动改成正面。"
                )
            elif view_label:
                prompt_lines.append(
                    f"{display_name}：本格已通过 @{name}{explicit_view} 指定使用“{view_label}”参考图；"
                    f"{orientation}，不要自动改成正面。"
                )
        images.extend(character_images)
    reference_tensor = _make_character_reference_tensor(images, contain_images=contain_reference_images)
    if prompt_lines:
        detail = "\n".join(prompt_lines)
        role_names = "、".join(_character_display_name(character, name) for name, character in resolved_characters)
        layout_lines = _character_layout_lines(resolved_characters, _character_position_hints(prompt_text))
        layout_text = f"\n多人默认站位：\n{chr(10).join(layout_lines)}" if layout_lines else ""
        prompt_text = (
            f"{prompt_text}\n\n"
            f"角色库参考要求：本格涉及角色为 {role_names}。生成画面必须严格保持下列人物特色；如果原文写“两人/二人/双方”，默认指这些角色。不要把参考图的构图、背景或裁切直接照搬；忽略参考图里的透明棋盘格、灰白方格、透明背景预览、文字、标签、水印和说明字样，最终画面禁止出现这些内容。\n"
            f"{detail}{layout_text}"
        )
    return prompt_text, reference_tensor


def _reference_signature(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, torch.Tensor):
        return [str(tuple(value.shape))]
    if isinstance(value, dict):
        result: list[str] = []
        for key in sorted(value, key=str):
            result.extend(_reference_signature(value[key]))
        return result
    if isinstance(value, (list, tuple)):
        result: list[str] = []
        for item in value:
            result.extend(_reference_signature(item))
        return result
    return [str(type(value).__name__)]


def _grid_geometry(
    count: int,
    width: int,
    height: int,
    layout_mode: str,
    gap: int,
    size_alignment: str,
) -> tuple[int, int, int, int, int, int]:
    width = max(64, int(width))
    height = max(64, int(height))
    gap = max(0, int(gap))
    count = max(1, int(count))
    storyboard_layouts = {
        1: (1, 1),
        2: (2, 1),
        3: (3, 1),
        4: (2, 2),
        5: (3, 2),
        6: (3, 2),
        7: (4, 2),
        8: (4, 2),
        9: (3, 3),
        10: (5, 2),
        11: (4, 3),
        12: (4, 3),
    }
    if count in storyboard_layouts:
        cols, rows = storyboard_layouts[count]
    else:
        cols = max(1, int(round(count ** 0.5)))
        while cols * cols < count:
            cols += 1
        rows = int((count + cols - 1) // cols)
        if rows > 1 and (cols - 1) * rows >= count:
            cols -= 1
        rows = int((count + cols - 1) // cols)
    multiple = _alignment_multiple(size_alignment)
    cell_w = _align_down(width, multiple, 64)
    cell_h = _align_down(height, multiple, 64)
    canvas_w = cell_w * cols + gap * (cols + 1)
    canvas_h = cell_h * rows + gap * (rows + 1)
    return cols, rows, cell_w, cell_h, canvas_w, canvas_h


def _make_grid(
    images: list[torch.Tensor],
    width: int,
    height: int,
    layout_mode: str,
    gap: int,
    fit_mode: str,
    resize_method: str,
    size_alignment: str,
) -> torch.Tensor:
    if not images:
        raise RuntimeError("没有生成到分镜图片，无法拼接智能宫格图。")
    cols, _rows, cell_w, cell_h, canvas_w, canvas_h = _grid_geometry(
        len(images), width, height, layout_mode, gap, size_alignment
    )
    first = images[0]
    canvas = torch.zeros((1, canvas_h, canvas_w, 3), dtype=first.dtype, device=first.device)
    gap = max(0, int(gap))
    for index, image in enumerate(images):
        source = _trim_generated_black_borders(
            image[:1].to(device=first.device, dtype=first.dtype).clamp(0.0, 1.0)
        )
        cell = _fit_cell(
            source,
            cell_w,
            cell_h,
            _safe_text(fit_mode, "铺满裁切") or "铺满裁切",
            0.0,
            resize_method,
        )
        row = index // cols
        col = index % cols
        top = gap + row * (cell_h + gap)
        left = gap + col * (cell_w + gap)
        canvas[:, top : top + cell_h, left : left + cell_w, :] = cell
    return canvas.clamp(0.0, 1.0).contiguous()


def _normalize_storyboard_cell(image: torch.Tensor, cell_w: int, cell_h: int) -> torch.Tensor:
    source = _trim_generated_black_borders(image[:1])
    return _resize_crop_short_edge(source, cell_w, cell_h)


def _dark_border_limit(values: torch.Tensor, max_scan: int) -> int:
    limit = 0
    for index in range(max(0, int(max_scan))):
        row = values[index]
        dark_ratio = (row < 0.06).float().mean().item()
        mean = row.mean().item()
        std = row.std(unbiased=False).item()
        if dark_ratio >= 0.92 and mean <= 0.035 and std <= 0.035:
            limit = index + 1
        else:
            break
    return limit


def _trim_generated_black_borders(image: torch.Tensor) -> torch.Tensor:
    tensor = _ensure_bhwc_rgb(image)[:1].detach().float().clamp(0.0, 1.0).contiguous()
    height = int(tensor.shape[1])
    width = int(tensor.shape[2])
    if height < 32 or width < 32:
        return tensor
    gray = tensor[0].mean(dim=-1)
    max_y = max(1, int(height * 0.22))
    max_x = max(1, int(width * 0.22))
    top = _dark_border_limit(gray, max_y)
    bottom = _dark_border_limit(torch.flip(gray, dims=[0]), max_y)
    left = _dark_border_limit(gray.t(), max_x)
    right = _dark_border_limit(torch.flip(gray.t(), dims=[0]), max_x)
    if top + bottom >= height * 0.45 or left + right >= width * 0.45:
        return tensor
    if top == 0 and bottom == 0 and left == 0 and right == 0:
        return tensor
    cropped = tensor[:, top : height - bottom if bottom else height, left : width - right if right else width, :]
    if int(cropped.shape[1]) < 16 or int(cropped.shape[2]) < 16:
        return tensor
    return cropped.contiguous()


def _storyboard_cache_signature(
    full_prompt: Any,
    negative_prompt: Any,
    width: int,
    height: int,
    unet_name: Any,
    unet_dtype: Any,
    clip_name1: Any,
    vae_name: Any,
    steps: int,
    cfg: float,
    sampler_name: Any,
    scheduler: Any,
    denoise: float,
    grow_mask_by: int,
    layout_mode: Any,
    gap: int,
    cell_fit: Any,
    resize_method: Any,
    size_alignment: Any,
    scene: Any,
    reference: Any,
    lora_chain_config: Any,
    lora_data: Any,
) -> str:
    payload = {
        "cell_normalize_version": "cover_crop_v2",
        "prompt": _safe_text(full_prompt),
        "negative_prompt": _safe_text(negative_prompt),
        "width": int(width),
        "height": int(height),
        "unet_name": _safe_text(unet_name),
        "unet_dtype": _safe_text(unet_dtype),
        "clip_name1": _safe_text(clip_name1),
        "vae_name": _safe_text(vae_name),
        "steps": int(steps),
        "cfg": float(cfg),
        "sampler_name": _safe_text(sampler_name),
        "scheduler": _safe_text(scheduler),
        "denoise": float(denoise),
        "grow_mask_by": int(grow_mask_by),
        "layout_mode": _safe_text(layout_mode),
        "gap": int(gap),
        "cell_fit": _safe_text(cell_fit),
        "resize_method": _safe_text(resize_method),
        "size_alignment": _safe_text(size_alignment),
        "scene": _reference_signature(scene),
        "reference": _reference_signature(reference),
        "lora_chain_config": _safe_text(lora_chain_config),
        "lora_data": _safe_text(lora_data),
        "characters": _character_library_signature(),
    }
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _lazy_optional_images(scene: Any, reference: Any, width: int, height: int) -> dict[str, torch.Tensor]:
    scene_images = [_resize_crop_short_edge(image, width, height) for image in _split_media(scene)]
    reference_images = [_resize_fit_reference(image, width, height) for image in _split_media(reference)]
    images = [*scene_images, *reference_images]
    if not images:
        return {}
    base = _ensure_bhwc_rgb(images[0])[:1].detach().float().clamp(0.0, 1.0).contiguous()
    one_each = [base]
    for image in images[1:]:
        one_each.append(
            _ensure_bhwc_rgb(image)[:1]
            .detach()
            .to(device=base.device, dtype=base.dtype)
            .clamp(0.0, 1.0)
            .contiguous()
        )
    return {"image_01": torch.cat(one_each, dim=0)}


def _media_count(value: Any) -> int:
    return len(_split_media(value))


def _append_scene_reference_prompt(prompt_text: str, scene_count: int) -> str:
    if int(scene_count or 0) <= 0:
        return prompt_text
    scene_ref = "image1" if scene_count == 1 else f"image1-image{int(scene_count)}"
    return (
        f"{prompt_text}\n\n"
        f"场景背景参考要求：{scene_ref} 是本格的背景/环境/地貌/光线参考，必须优先作为最终画面的背景使用。"
        "人物只能放入这个场景背景中；不要丢掉背景，不要改成纯色、空白、室内、雪地、角色图自带背景或无关环境。"
    )


def _normalize_strength(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except Exception:
        return float(fallback)


def _normalize_model_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", _safe_text(value).casefold())


def _is_qwen_image_edit_unet(unet_name: Any) -> bool:
    text = _normalize_model_text(unet_name)
    return "qwen" in text and "image" in text and "edit" in text


def _prefix_qwen_next_scene_prompt(prompt_text: str, unet_name: Any) -> str:
    text = _safe_text(prompt_text).strip()
    if not _is_qwen_image_edit_unet(unet_name):
        return text
    if text.startswith(QWEN_NEXT_SCENE_PROMPT_PREFIX):
        return text
    return f"{QWEN_NEXT_SCENE_PROMPT_PREFIX}\n{text}"


def _resolve_storyboard_lora_name(preferred: str) -> str:
    wanted = _safe_text(preferred).strip()
    if not wanted:
        return ""
    try:
        loras = [str(item) for item in folder_paths.get_filename_list("loras") if str(item or "").strip()]
    except Exception:
        loras = []
    wanted_key = wanted.replace("\\", "/").casefold()
    wanted_base = wanted_key.rsplit("/", 1)[-1]
    for item in loras:
        key = item.replace("\\", "/").casefold()
        if key == wanted_key or key.rsplit("/", 1)[-1] == wanted_base:
            return item
    for item in loras:
        key = item.replace("\\", "/").casefold()
        if wanted_base in key:
            return item
    return wanted


def _append_lora_row(rows: list[dict[str, Any]], name: str, strength: float = 1.0) -> None:
    resolved = _resolve_storyboard_lora_name(name)
    if not resolved:
        return
    target_base = resolved.replace("\\", "/").casefold().rsplit("/", 1)[-1]
    for row in rows:
        current = _safe_text(row.get("name") if isinstance(row, dict) else "").replace("\\", "/").casefold()
        if current and (current == resolved.replace("\\", "/").casefold() or current.rsplit("/", 1)[-1] == target_base):
            row["enabled"] = True
            if abs(_normalize_strength(row.get("strength"), 0.0)) <= 1e-6:
                row["strength"] = strength
            return
    rows.append({"enabled": True, "name": resolved, "strength": float(strength)})


def _parse_enabled(value: Any, fallback: bool = True) -> bool:
    text = str(value if value is not None else "").strip().lower()
    if not text:
        return bool(fallback)
    if text in {"1", "true", "yes", "on", "enable", "enabled", "启用", "开"}:
        return True
    if text in {"0", "false", "no", "off", "disable", "disabled", "关闭", "关"}:
        return False
    return bool(fallback)


def _parse_bool(value: Any, fallback: bool = False) -> bool:
    return _parse_enabled(value, fallback)


def _has_configured_lora_data(value: Any) -> bool:
    text = _safe_text(value).strip()
    if not text or text == "[]":
        return False
    try:
        rows = json.loads(text)
    except Exception:
        return True
    if not isinstance(rows, list):
        return False
    return any(str(row.get("name", "")).strip() for row in rows if isinstance(row, dict))


def _preset_lora_data(unet_name: Any) -> str:
    preset = _match_model_family_preset(_safe_text(unet_name))
    rows: list[dict[str, Any]] = []
    if preset and _safe_text(preset.get("id", "generic")) != "generic":
        lora1 = _safe_text(preset.get("lora_1_name", "")).strip()
        if lora1:
            rows.append(
                {
                    "enabled": _parse_enabled(preset.get("lora_1_auto_enabled"), True),
                    "name": lora1,
                    "strength": _normalize_strength(preset.get("lora_1_strength"), 1.0),
                }
            )
        lora2 = _safe_text(preset.get("lora_2_name", "")).strip()
        if lora2:
            rows.append(
                {
                    "enabled": True,
                    "name": lora2,
                    "strength": _normalize_strength(preset.get("lora_2_strength"), 0.7),
                }
            )
    if _is_qwen_image_edit_unet(unet_name):
        _append_lora_row(rows, QWEN_NEXT_SCENE_LORA, 1.0)
    return json.dumps(rows, ensure_ascii=False) if rows else "[]"


def _ensure_qwen_next_scene_lora_data(lora_data: Any, unet_name: Any) -> str:
    text = _safe_text(lora_data).strip()
    try:
        rows = json.loads(text) if text else []
    except Exception:
        rows = []
    if not isinstance(rows, list):
        rows = []
    rows = [row for row in rows if isinstance(row, dict)]
    if _is_qwen_image_edit_unet(unet_name):
        _append_lora_row(rows, QWEN_NEXT_SCENE_LORA, 1.0)
    return json.dumps(rows, ensure_ascii=False) if rows else "[]"


class GJJ_StoryboardGridGenerator:
    CATEGORY = "GJJ/Image"
    FUNCTION = "generate"
    DESCRIPTION = "分镜宫格生成器：复用懒人图文集成一键生图流程，正向提示词按空行、--- 或 Scene：镜头 :: 描述 分段生成，并智能拼接为宫格图。"
    SEARCH_ALIASES = ["分镜生成器", "智能宫格", "storyboard grid", "storyboard generator"]
    RETURN_TYPES = ("IMAGE", MIXED_IMAGE_OUTPUT)
    RETURN_NAMES = ("智能宫格图", "分镜图片")
    OUTPUT_TOOLTIPS = (
        "按生成图片数量自动排列并拼接后的宫格图。",
        "每个提示词分段生成的一张分镜图片批次。",
    )
    INPUT_IS_LIST = True
    OUTPUT_NODE = True
    GJJ_HELP = {
        "description": DESCRIPTION,
        "model_tree": True,
        "dynamic_model_tree_only": True,
        "notice": "正向提示词按空行、单独一行 --- 或 Scene：镜头 :: 描述 分段；每段会调用一次懒人图文集成一键生图流程。",
    }
    _shared_storyboard_cell_cache: dict[str, dict[str, Any]] = {}

    def __init__(self):
        self._lazy = GJJ_LazyImageStudio()
        self._storyboard_cell_cache = self.__class__._shared_storyboard_cell_cache

    @classmethod
    def INPUT_TYPES(cls):
        raw_unet_models = _list_lazy_unet_models() or [DEFAULT_UNET_NAME]
        diffusion_keywords = ["flux", "f2k", "zimage", "z_image", "z-image", "zit", "qwen", "firered", "boogu", "gguf"]
        filtered = [m for m in raw_unet_models if any(k in str(m).lower() for k in diffusion_keywords)]
        diffusion_models = filtered if filtered else raw_unet_models
        clip_models = _list_lazy_clip_models() or [DEFAULT_CLIP_NAME]
        vae_models = list_vae_models() or [DEFAULT_VAE_NAME]
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "✨ 正向提示词",
                        "tooltip": "按空行、单独一行 --- 或 Scene：镜头 :: 描述 分段；每段生成一张分镜图片。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "🚫 反向提示词",
                    },
                ),
                "main_image_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": MAX_MAIN_IMAGE_INDEX,
                        "display_name": "🎯 主图序号",
                    },
                ),
                "width": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8, "display_name": "📐 宽度"}),
                "height": ("INT", {"default": 768, "min": 64, "max": 8192, "step": 8, "display_name": "📏 高度"}),
                "batch_size": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 1,
                        "display_name": "🔢 批次数",
                        "tooltip": "分镜宫格固定为每个提示词分段生成一张图片。",
                    },
                ),
                "unet_name": (
                    diffusion_models,
                    {"default": _preferred_default(diffusion_models, DEFAULT_UNET_NAME), "display_name": "🟣 UNET 主模型"},
                ),
                "unet_dtype": (
                    UNET_DTYPE_OPTIONS,
                    {"default": DEFAULT_UNET_DTYPE, "display_name": "⚙️ UNET 精度"},
                ),
                "clip_name1": (
                    clip_models,
                    {"default": _preferred_default(clip_models, DEFAULT_CLIP_NAME), "display_name": "🟡 CLIP 编码器"},
                ),
                "vae_name": (
                    vae_models,
                    {"default": _preferred_default(vae_models, DEFAULT_VAE_NAME), "display_name": "🔴 VAE 解码器"},
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "🎲 种子",
                    },
                ),
                "steps": ("INT", {"default": 4, "min": 1, "max": 10000, "display_name": "👣 步数"}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01, "display_name": "⚖️ CFG 引导强度"}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler", "display_name": "🌀 采样器"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple", "display_name": "📊 调度器"}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "🔧 降噪"}),
                "grow_mask_by": ("INT", {"default": 6, "min": 0, "max": 64, "display_name": "🎭 遮罩扩张"}),
                "layout_mode": (LAYOUT_MODES, {"default": "自动", "display_name": "🔲 宫格布局"}),
                "gap": ("INT", {"default": 8, "min": 0, "max": 128, "step": 1, "display_name": "➗ 黑色间隔"}),
                "cell_fit": (FIT_MODES, {"default": "铺满裁切", "display_name": "🖼️ 单元适配"}),
                "resize_method": (UPSCALE_METHODS, {"default": "lanczos", "display_name": "🔍 缩放算法"}),
                "size_alignment": (SIZE_ALIGN_MODES, {"default": "LTX 32倍数", "display_name": "📐 尺寸对齐"}),
            },
            "optional": {
                "scene": (IMAGE_INPUT_TYPE, {"display_name": "🏞️ 场景", "tooltip": "接收上游素材/背景作为参考图参与生成；不会启用自动局部蒙版。"}),
                "reference": (IMAGE_INPUT_TYPE, {"display_name": "🖼️ 参考图", "tooltip": "接收上游素材/背景作为参考图参与生成；不会启用自动局部蒙版。"}),
                "lora_chain_config": ("LORA_CHAIN_CONFIG", {"display_name": "🔗 LoRA串联配置"}),
                "lora_data": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": False,
                        "display_name": "LoRA 配置",
                        "hidden": True,
                        "display": "hidden",
                    },
                ),
                "single_cell_index": (
                    "INT",
                    {"default": 0, "min": 0, "max": 255, "display_name": "单格生成序号", "hidden": True, "display": "hidden"},
                ),
                "single_cell_total": (
                    "INT",
                    {"default": 0, "min": 0, "max": 255, "display_name": "单格总数", "hidden": True, "display": "hidden"},
                ),
                "selected_cell_indices": (
                    "STRING",
                    {"default": "[]", "multiline": False, "display_name": "选中宫格序号", "hidden": True, "display": "hidden"},
                ),
                "storyboard_full_prompt": (
                    "STRING",
                    {"default": "", "multiline": False, "display_name": "完整分镜提示词", "hidden": True, "display": "hidden"},
                ),
                "force_generate_all": (
                    "STRING",
                    {"default": "false", "multiline": False, "display_name": "强制全部生成", "hidden": True, "display": "hidden"},
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "prompt_graph": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @classmethod
    def IS_CHANGED(cls, scene=None, reference=None, **kwargs):
        shapes = [*_reference_signature(scene), *_reference_signature(reference)]
        return (
            "|".join(str(kwargs.get(key, "")) for key in sorted(kwargs))
            + "|"
            + "|".join(shapes)
            + "|characters="
            + _character_library_signature()
        )

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def generate(
        self,
        prompt,
        negative_prompt,
        main_image_index,
        width,
        height,
        batch_size,
        unet_name,
        unet_dtype,
        clip_name1,
        vae_name,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        grow_mask_by,
        layout_mode,
        gap,
        cell_fit,
        resize_method,
        size_alignment,
        scene=None,
        reference=None,
        lora_chain_config="",
        lora_data="[]",
        single_cell_index=0,
        single_cell_total=0,
        selected_cell_indices="[]",
        storyboard_full_prompt="",
        force_generate_all="false",
        unique_id=None,
        prompt_graph=None,
        extra_pnginfo=None,
    ):
        prompt = _first_scalar(prompt)
        negative_prompt = _first_scalar(negative_prompt)
        main_image_index = _first_scalar(main_image_index)
        width = int(_first_scalar(width))
        height = int(_first_scalar(height))
        batch_size = int(_first_scalar(batch_size))
        unet_name = _first_scalar(unet_name)
        unet_dtype = _first_scalar(unet_dtype)
        clip_name1 = _first_scalar(clip_name1)
        vae_name = _first_scalar(vae_name)
        seed = int(_first_scalar(seed))
        steps = int(_first_scalar(steps))
        cfg = float(_first_scalar(cfg))
        sampler_name = _first_scalar(sampler_name)
        scheduler = _first_scalar(scheduler)
        denoise = float(_first_scalar(denoise))
        grow_mask_by = int(_first_scalar(grow_mask_by))
        layout_mode = _first_scalar(layout_mode)
        gap = int(_first_scalar(gap))
        cell_fit = _first_scalar(cell_fit)
        resize_method = _first_scalar(resize_method)
        size_alignment = _first_scalar(size_alignment)
        lora_chain_config = _first_scalar(lora_chain_config)
        lora_data = _first_scalar(lora_data)
        single_cell_index = int(_first_scalar(single_cell_index) or 0)
        single_cell_total = int(_first_scalar(single_cell_total) or 0)
        selected_cell_indices = _first_scalar(selected_cell_indices)
        storyboard_full_prompt = _first_scalar(storyboard_full_prompt)
        force_generate_all = _parse_bool(_first_scalar(force_generate_all), False)
        unique_id = _first_scalar(unique_id)
        if not _has_configured_lora_data(lora_data):
            lora_data = _preset_lora_data(unet_name)
        else:
            lora_data = _ensure_qwen_next_scene_lora_data(lora_data, unet_name)

        prompts = _split_prompt_segments(prompt)
        if not prompts:
            raise RuntimeError("正向提示词为空。请填写分镜提示词；用空行、单独一行 --- 或 Scene：镜头 :: 描述 分段。")
        full_prompt_for_cache = _safe_text(storyboard_full_prompt).strip() or prompt
        full_prompts_for_cache = _split_prompt_segments(full_prompt_for_cache)
        selected_indices: list[int] = []
        if single_cell_total > 0:
            try:
                parsed_indices = json.loads(_safe_text(selected_cell_indices) or "[]")
            except Exception:
                parsed_indices = []
            if isinstance(parsed_indices, list):
                seen_indices: set[int] = set()
                for value in parsed_indices:
                    try:
                        index_value = int(value)
                    except Exception:
                        continue
                    if 1 <= index_value <= single_cell_total and index_value not in seen_indices:
                        seen_indices.add(index_value)
                        selected_indices.append(index_value)
        single_cell_mode = single_cell_index > 0 and single_cell_total > 0 and len(prompts) == 1
        selected_cell_mode = bool(selected_indices) and single_cell_total > 0 and len(prompts) == len(selected_indices)
        preview_total = max(1, single_cell_total) if (single_cell_mode or selected_cell_mode) else len(prompts)
        if (single_cell_mode or selected_cell_mode) and full_prompts_for_cache:
            preview_total = max(preview_total, len(full_prompts_for_cache))
        seed_offset = max(0, min(single_cell_index - 1, preview_total - 1)) if single_cell_mode else 0
        geometry_count = preview_total if (single_cell_mode or selected_cell_mode) else len(prompts)
        cache_signature = _storyboard_cache_signature(
            full_prompt_for_cache,
            negative_prompt,
            width,
            height,
            unet_name,
            unet_dtype,
            clip_name1,
            vae_name,
            steps,
            cfg,
            sampler_name,
            scheduler,
            denoise,
            grow_mask_by,
            layout_mode,
            gap,
            cell_fit,
            resize_method,
            size_alignment,
            scene,
            reference,
            lora_chain_config,
            lora_data,
        )
        cache_key = _safe_text(unique_id).strip() or cache_signature
        cache = self._storyboard_cell_cache.get(cache_key)
        if not cache or cache.get("signature") != cache_signature or int(cache.get("total", 0) or 0) != geometry_count:
            cache = {"signature": cache_signature, "total": geometry_count, "cells": {}}
            self._storyboard_cell_cache[cache_key] = cache

        _cols, _rows, cell_w, cell_h, _canvas_w, _canvas_h = _grid_geometry(
            geometry_count, width, height, layout_mode, gap, size_alignment
        )
        cached_cells = cache.get("cells", {}) if isinstance(cache.get("cells"), dict) else {}
        stitched_cells = [cached_cells.get(index) for index in range(1, geometry_count + 1)]
        if not force_generate_all and not single_cell_mode and not selected_cell_mode:
            if all(isinstance(item, torch.Tensor) for item in stitched_cells):
                output_images = [
                    _normalize_storyboard_cell(item, cell_w, cell_h) for item in stitched_cells if isinstance(item, torch.Tensor)
                ]
                grid = _make_grid(output_images, width, height, layout_mode, gap, cell_fit, resize_method, size_alignment)
                cells = torch.cat(output_images, dim=0).contiguous()
                _send_status(unique_id, f"下游直接获取缓存分镜：{len(output_images)}/{geometry_count}")
                return (grid, cells)
            cached_count = sum(1 for item in stitched_cells if isinstance(item, torch.Tensor))
            if cached_count > 0:
                _send_status(unique_id, f"当前缓存只有 {cached_count}/{geometry_count} 格，下游请求自动补齐完整分镜。")
            else:
                _send_status(unique_id, "缓存为空，下游首次请求自动生成完整分镜。")
        storyboard_character_refs = _storyboard_character_context(prompts)
        is_qwen_image_edit = _is_qwen_image_edit_unet(unet_name)
        generated: list[torch.Tensor] = []
        generated_positions: list[int] = []
        if selected_cell_mode:
            _send_status(unique_id, f"准备生成选中分镜 {len(prompts)} 张 / 共 {preview_total} 格...")
        elif single_cell_mode:
            _send_status(unique_id, f"准备生成单格分镜 {single_cell_index}/{preview_total}...")
        else:
            _send_status(unique_id, f"准备生成 {len(prompts)} 张分镜图片...")

        scene_reference_count = _media_count(scene)
        plain_reference_count = _media_count(reference)
        character_reference_start = scene_reference_count + plain_reference_count + 1
        for index, line in enumerate(prompts, start=1):
            if selected_cell_mode:
                preview_index = selected_indices[index - 1]
            else:
                preview_index = seed_offset + index if single_cell_mode else index
            line = _append_scene_reference_prompt(line, scene_reference_count)
            line, character_reference = _character_prompt_and_reference(
                line,
                storyboard_character_refs,
                contain_reference_images=is_qwen_image_edit,
                first_reference_image_index=character_reference_start,
            )
            line = _prefix_qwen_next_scene_prompt(line, unet_name)
            line = f"{line}\n\n{CELL_BLEED_PROMPT}"
            combined_reference = [reference, character_reference] if character_reference is not None else reference
            refs = _lazy_optional_images(scene, combined_reference, cell_w, cell_h)
            _send_status(unique_id, f"按懒人一键生图流程生成分镜 {preview_index}/{preview_total}")
            result = self._lazy.create_image(
                prompt=line,
                negative_prompt=negative_prompt,
                main_image_index=main_image_index,
                width=cell_w,
                height=cell_h,
                batch_size=1,
                unet_name=unet_name,
                unet_dtype=unet_dtype,
                clip_name1=clip_name1,
                vae_name=vae_name,
                seed=seed + preview_index - 1 if (single_cell_mode or selected_cell_mode) else seed + index - 1,
                steps=steps,
                cfg=cfg,
                sampler_name=sampler_name,
                scheduler=scheduler,
                denoise=denoise,
                grow_mask_by=grow_mask_by,
                lora_chain_config=lora_chain_config,
                lora_data=lora_data,
                batch_source_images="[]",
                disable_reference_auto_mask=True,
                force_empty_latent_reference=is_qwen_image_edit,
                prompt_graph=prompt_graph,
                unique_id=unique_id,
                extra_pnginfo=extra_pnginfo,
                **refs,
            )
            image = result.get("result", (None,))[0] if isinstance(result, dict) else None
            if not isinstance(image, torch.Tensor):
                raise RuntimeError(f"分镜 {index} 没有返回有效图片。")
            current = _normalize_storyboard_cell(image, cell_w, cell_h).detach().float().clamp(0.0, 1.0).contiguous()
            generated.append(current)
            generated_positions.append(preview_index)
            cache["cells"][int(preview_index)] = current.detach().contiguous()
            _send_live_preview(unique_id, current, preview_index, preview_total)

        cached_cells = cache.get("cells", {}) if isinstance(cache.get("cells"), dict) else {}
        stitched_cells = [cached_cells.get(index) for index in range(1, geometry_count + 1)]
        if all(isinstance(item, torch.Tensor) for item in stitched_cells):
            output_images = [
                _normalize_storyboard_cell(item, cell_w, cell_h) for item in stitched_cells if isinstance(item, torch.Tensor)
            ]
            _send_status(unique_id, f"直接拼接缓存分镜：{len(output_images)}/{geometry_count}")
        else:
            output_images = [_normalize_storyboard_cell(item, cell_w, cell_h) for item in generated]
        cells = torch.cat(output_images, dim=0).contiguous()
        grid = _make_grid(output_images, width, height, layout_mode, gap, cell_fit, resize_method, size_alignment)
        _send_status(unique_id, f"完成：生成 {len(generated)} 张，输出拼接 {len(output_images)} 张，智能宫格 {grid.shape[2]} x {grid.shape[1]}")
        return (grid, cells)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_StoryboardGridGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 分镜宫格生成器"}
