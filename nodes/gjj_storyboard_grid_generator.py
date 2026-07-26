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
from .common_utils.temp_files import gjjutils_read_temp_pil_image, gjjutils_write_temp_bytes, gjjutils_write_temp_tensor_images
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
    r"^\s*(?:scene|shot|镜头|分镜)\s*(?:[#:：\-]?\s*[\d一二三四五六七八九十百零〇两]+)?(?:\s*[:：]\s*|\s+)"
    r"(?:(?P<label>.*?)\s*(?:[:：]{1,2}|::)\s*)?(?P<body>.+?)\s*$",
    re.IGNORECASE,
)
SCENE_BRACKET_LINE_RE = re.compile(
    r"^\s*\[\s*(?P<label>[^\[\]\r\n]+?)\s*\]"
    r"\s*(?:[:：\-—]\s*)?(?P<body>.*?)\s*$"
)
CHARACTER_REF_RE = re.compile(r"@([0-9A-Za-z\u4e00-\u9fff._-]+)(?:/([0-9A-Za-z\u4e00-\u9fff._-]+))?")
SCENE_REF_RE = re.compile(
    r"(?:🌏|🌍|🌎)([0-9A-Za-z\u4e00-\u9fff._-]+)(?:[/\\]([0-9A-Za-z\u4e00-\u9fff._-]+))?"
    r"|\[场景[:：]([0-9A-Za-z\u4e00-\u9fff._-]+)(?:[/\\]([0-9A-Za-z\u4e00-\u9fff._-]+))?\]"
)
SCENE_VIEW_REF_RE = re.compile(
    r"\[\s*([^\[\]/:：]+?)\s*[:：]\s*"
    r"(-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*"
    r"(-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*"
    r"(-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*"
    r"(-?(?:\d+(?:\.\d+)?|\.\d+))\s*\]",
    re.IGNORECASE,
)
COSTUME_REF_RE = re.compile(
    r"(?:💼|👗)([0-9A-Za-z\u4e00-\u9fff._-]+)"
    r"|\[服装[:：]([0-9A-Za-z\u4e00-\u9fff._-]+)\]"
    r"|\[道具[:：]([0-9A-Za-z\u4e00-\u9fff._-]+)\]"
    r"|\[prop[:：]([0-9A-Za-z\u4e00-\u9fff._-]+)\]"
    r"|\[产品[:：]([0-9A-Za-z\u4e00-\u9fff._-]+)\]"
    r"|\[product[:：]([0-9A-Za-z\u4e00-\u9fff._-]+)\]"
    r"|\[costume[:：]([0-9A-Za-z\u4e00-\u9fff._-]+)\]",
    re.IGNORECASE,
)
SCENE_BRACKET_REF_RE = re.compile(r"\[([0-9A-Za-z\u4e00-\u9fff._-]+)(?:[/\\]([0-9A-Za-z\u4e00-\u9fff._-]+))?\]")
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
NEXT_SCENE_LORA = "next-scene_lora-v2-3000.safetensors"
FLUX_STORYBOARD_LORA = "f2k_9B_lcs_consist"
NEXT_SCENE_PROMPT_PREFIX = "下一个场景："
STORYBOARD_LORA_NONE = ""


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


def _write_debug_reference_images(unique_id: Any, preview_index: int, refs: dict[str, torch.Tensor]) -> None:
    if not refs:
        return
    try:
        lines: list[str] = []
        for key in sorted(refs):
            value = refs.get(key)
            if not isinstance(value, torch.Tensor):
                continue
            images = gjjutils_write_temp_tensor_images(value.detach().float().clamp(0.0, 1.0).cpu())
            for index, info in enumerate(images, start=1):
                filename = _safe_text(info.get("filename")).strip()
                if filename:
                    try:
                        check = gjjutils_read_temp_pil_image(info)
                        size_text = f"{int(check.width)}x{int(check.height)}"
                    except Exception:
                        size_text = f"{info.get('width', '?')}x{info.get('height', '?')}"
                    lines.append(f"{key}[{index}]={info.get('subfolder', 'GJJ')}/{filename}({size_text})")
        if not lines:
            return
        message = f"分镜 {int(preview_index)} 实际参考入口 temp：{'；'.join(lines)}"
        print(f"[GJJ StoryboardGridGenerator] {message}")
        _send_status(unique_id, message)
    except Exception as exc:
        print(f"[GJJ StoryboardGridGenerator] 写入参考入口调试图失败: {exc}")


def _write_debug_final_prompt(unique_id: Any, preview_index: int, prompt_text: str, negative_prompt: Any) -> None:
    try:
        content = (
            f"GJJ_StoryboardGridGenerator final prompt debug\n"
            f"cell: {int(preview_index)}\n\n"
            f"POSITIVE:\n{_safe_text(prompt_text)}\n\n"
            f"NEGATIVE:\n{_safe_text(negative_prompt)}\n"
        )
        info = gjjutils_write_temp_bytes(content.encode("utf-8"), suffix=".txt")
        filename = _safe_text(info.get("filename")).strip()
        if not filename:
            return
        message = f"分镜 {int(preview_index)} 最终提示词 temp：{info.get('subfolder', 'GJJ')}/{filename}"
        print(f"[GJJ StoryboardGridGenerator] {message}")
        _send_status(unique_id, message)
    except Exception as exc:
        print(f"[GJJ StoryboardGridGenerator] 写入最终提示词调试文件失败: {exc}")


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
        bracket_match = SCENE_BRACKET_LINE_RE.match(line)
        match = bracket_match or SCENE_LINE_RE.match(line)
        if match:
            matched = True
            flush_current()
            body = _safe_text(match.group("body")).strip()
            if bracket_match:
                if body:
                    current.append(body)
            else:
                label = _safe_text(match.group("label")).strip(" 　-—:：")
                current.append(f"{label}，{body}" if label else body)
        elif matched:
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


def _pil_resize_crop_short_edge(image: Image.Image, target_width: int, target_height: int) -> Image.Image:
    source = image.convert("RGB")
    target_width = max(64, int(target_width))
    target_height = max(64, int(target_height))
    sw, sh = source.size
    if sw <= 0 or sh <= 0:
        return Image.new("RGB", (target_width, target_height), (255, 255, 255))
    scale = max(target_width / sw, target_height / sh)
    resized_w = max(target_width, int(round(sw * scale)))
    resized_h = max(target_height, int(round(sh * scale)))
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    resized = source.resize((resized_w, resized_h), resampling)
    left = max(0, (resized_w - target_width) // 2)
    top = max(0, (resized_h - target_height) // 2)
    return resized.crop((left, top, left + target_width, top + target_height))


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


def _scene_library_root() -> Path:
    models_dir = Path(getattr(folder_paths, "models_dir", "") or "")
    if not str(models_dir):
        models_dir = Path(__file__).resolve().parents[2] / "models"
    return models_dir / "GJJ" / "scene_library"


def _scene_library_roots() -> list[Path]:
    roots = [_scene_library_root(), Path(__file__).resolve().parents[1] / "presets" / "scene_library"]
    seen: set[str] = set()
    result: list[Path] = []
    for root in roots:
        key = str(root.resolve()) if root else ""
        if key and key not in seen:
            seen.add(key)
            result.append(root)
    return result


def _scene_library_items() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for root in _scene_library_roots():
        if not root.is_dir():
            continue
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
            data["type"] = _safe_text(data.get("type") or "360").strip().lower() or "360"
            data["_dir"] = str(entry)
            data["_folder_id"] = entry.name
            assets = data.get("assets") if isinstance(data.get("assets"), list) else []
            annotations = data.get("annotations") if isinstance(data.get("annotations"), list) else []
            data["assets"] = [asset for asset in assets if isinstance(asset, dict)]
            data["annotations"] = [mark for mark in annotations if isinstance(mark, dict)]
            items.append(data)
    return items


def _scene_library_signature() -> str:
    parts: list[str] = []
    try:
        for root in _scene_library_roots():
            if not root.is_dir():
                continue
            for path in root.glob("*/*"):
                if path.is_file() and path.suffix.lower() in {".json", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".hdr", ".exr"}:
                    stat = path.stat()
                    parts.append(f"{root.name}/{path.parent.name}/{path.name}:{int(stat.st_mtime_ns)}:{int(stat.st_size)}")
    except Exception:
        return ""
    return "|".join(sorted(parts))


def _costume_library_root() -> Path:
    models_dir = Path(getattr(folder_paths, "models_dir", "") or "")
    if not str(models_dir):
        models_dir = Path(__file__).resolve().parents[2] / "models"
    return models_dir / "GJJ" / "costume_library"


def _costume_library_items() -> list[dict[str, Any]]:
    root = _costume_library_root()
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
        category = _safe_text(data.get("category") or "clothing").strip().lower() or "clothing"
        data["category"] = category if category in {"clothing", "prop", "product"} else "clothing"
        data["notes"] = _safe_text(data.get("notes") or "").strip()
        tags = data.get("tags") if isinstance(data.get("tags"), list) else []
        assets = data.get("assets") if isinstance(data.get("assets"), list) else []
        data["tags"] = [_safe_text(tag).strip() for tag in tags if _safe_text(tag).strip()]
        data["assets"] = [asset for asset in assets if isinstance(asset, dict)]
        data["_dir"] = str(entry)
        data["_folder_id"] = entry.name
        items.append(data)
    return items


def _costume_library_signature() -> str:
    root = _costume_library_root()
    if not root.is_dir():
        return ""
    parts: list[str] = []
    try:
        for path in root.glob("*/*"):
            if path.is_file() and path.suffix.lower() in {".json", ".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
                stat = path.stat()
                parts.append(f"{path.parent.name}/{path.name}:{int(stat.st_mtime_ns)}:{int(stat.st_size)}")
    except Exception:
        return ""
    return "|".join(sorted(parts))


def _normalize_costume_key(value: Any) -> str:
    return _safe_text(value).strip().lstrip("@").casefold()


def _costume_alias_keys(costume: dict[str, Any]) -> list[tuple[str, str]]:
    aliases: list[tuple[str, str]] = []
    for value in (costume.get("name"), costume.get("id"), costume.get("_folder_id"), *(costume.get("tags") or [])):
        text = _safe_text(value).strip()
        key = _normalize_costume_key(text)
        if text and key:
            aliases.append((text, key))
    return aliases


def _find_costume(name: str, category: str = "clothing") -> dict[str, Any] | None:
    key = _normalize_costume_key(name)
    if not key:
        return None
    wanted = _safe_text(category).strip().lower()
    items = [item for item in _costume_library_items() if not wanted or _safe_text(item.get("category")).lower() == wanted]
    for item in items:
        if any(alias_key == key for _alias, alias_key in _costume_alias_keys(item)):
            return item
    for item in items:
        if any(key in alias_key or alias_key in key for _alias, alias_key in _costume_alias_keys(item)):
            return item
    return None


def _normalize_scene_key(value: Any) -> str:
    return _safe_text(value).strip().lstrip("@").casefold()


def _scene_alias_keys(scene: dict[str, Any]) -> list[tuple[str, str]]:
    aliases: list[tuple[str, str]] = []
    values = [scene.get("name"), scene.get("id"), scene.get("_folder_id")]
    values.extend(scene.get("keywords") if isinstance(scene.get("keywords"), list) else [])
    values.extend(scene.get("tags") if isinstance(scene.get("tags"), list) else [])
    for value in values:
        text = _safe_text(value).strip()
        key = _normalize_scene_key(text)
        if text and key:
            aliases.append((text, key))
    for mark in scene.get("annotations") or []:
        if not isinstance(mark, dict):
            continue
        values = [
            mark.get("keyword"),
            mark.get("label"),
            mark.get("name"),
            mark.get("id"),
        ]
        values.extend(mark.get("tags") if isinstance(mark.get("tags"), list) else [])
        for value in values:
            text = _safe_text(value).strip()
            key = _normalize_scene_key(text)
            if text and key:
                aliases.append((text, key))
    return aliases


def _scene_semantic_aliases(key: str) -> list[str]:
    aliases = [key]
    groups = [
        ("主卧", "卧室", "卧房", "房间", "bedroom", "masterbedroom"),
        ("客厅", "大厅", "起居室", "livingroom", "lounge"),
        ("厨房", "kitchen"),
        ("餐厅", "饭厅", "diningroom"),
        ("浴室", "卫生间", "洗手间", "bathroom"),
        ("阳台", "露台", "balcony", "terrace"),
    ]
    for group in groups:
        normalized = [_normalize_scene_key(item) for item in group]
        if any(item and (item in key or key in item) for item in normalized):
            aliases.extend(item for item in normalized if item)
    seen: set[str] = set()
    return [item for item in aliases if item and not (item in seen or seen.add(item))]


def _find_scene(name: str) -> dict[str, Any] | None:
    key = _normalize_scene_key(name)
    if not key:
        return None
    keys = _scene_semantic_aliases(key)
    items = _scene_library_items()
    for item in items:
        if any(alias_key in keys for _alias, alias_key in _scene_alias_keys(item)):
            return item
    for item in items:
        if any(any(item_key in alias_key or alias_key in item_key for item_key in keys) for _alias, alias_key in _scene_alias_keys(item)):
            return item
    return None


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


def _prompt_without_character_refs(text: str) -> str:
    return CHARACTER_REF_RE.sub("", _safe_text(text))


def _reference_wants_back(prompt_text: str, explicit_label: str = "") -> bool:
    label = _safe_text(explicit_label).casefold()
    if label:
        return any(keyword.casefold() in label for keyword in BACK_KEYWORDS + BACK_LABEL_KEYWORDS)
    return _prompt_wants_back(_prompt_without_character_refs(prompt_text))


def _prompt_wants_side(text: str) -> bool:
    lowered = text.casefold()
    return any(keyword.casefold() in lowered for keyword in SIDE_KEYWORDS)


def _prompt_wants_closeup(text: str) -> bool:
    lowered = text.casefold()
    return any(keyword.casefold() in lowered for keyword in CLOSEUP_KEYWORDS)


def _reference_wants_closeup(prompt_text: str, explicit_label: str = "") -> bool:
    label = _safe_text(explicit_label).casefold()
    if label:
        return any(keyword.casefold() in label for keyword in HEAD_LABEL_KEYWORDS + CLOSEUP_KEYWORDS)
    return _prompt_wants_closeup(_prompt_without_character_refs(prompt_text))


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
    image = _open_character_view_rgba(character, view)
    if image is None:
        return None
    try:
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        background.alpha_composite(image)
        return background.convert("RGB")
    except Exception:
        return None


def _open_character_view_white(character: dict[str, Any], view: dict[str, Any]) -> Image.Image | None:
    path = _view_file(character, view)
    if path is None:
        return None
    try:
        image = Image.open(path).convert("RGBA")
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        background.alpha_composite(image)
        return background.convert("RGB")
    except Exception:
        return None


def _open_character_view_rgba(character: dict[str, Any], view: dict[str, Any], preserve_full_body: bool = False) -> Image.Image | None:
    path = _view_file(character, view)
    if path is None:
        return None
    try:
        image = Image.open(path).convert("RGBA")
        image = _remove_checkerboard_background(image)
        image = _remove_flat_edge_background(image)
        image = _crop_character_reference_alpha(image, preserve_full_body=preserve_full_body)
        return image
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


def _remove_flat_edge_background(image: Image.Image) -> Image.Image:
    if image.mode != "RGBA" or image.width < 16 or image.height < 16:
        return image
    array = np.asarray(image).copy()
    alpha = array[..., 3]
    if int(alpha.min(initial=255)) < 240:
        return image
    rgb = array[..., :3].astype(np.int16)
    height, width = alpha.shape
    border = np.concatenate(
        [
            array[:4, :, :].reshape(-1, 4),
            array[-4:, :, :].reshape(-1, 4),
            array[:, :4, :].reshape(-1, 4),
            array[:, -4:, :].reshape(-1, 4),
        ],
        axis=0,
    )
    border_rgb = border[:, :3].astype(np.int16)
    border_alpha = border[:, 3]
    border_rgb = border_rgb[border_alpha > 240]
    if border_rgb.shape[0] < max(32, int((width + height) * 0.08)):
        return image
    quantized = (border_rgb // 12).astype(np.int16)
    values, counts = np.unique(quantized, axis=0, return_counts=True)
    order = np.argsort(counts)[::-1]
    colors: list[np.ndarray] = []
    for item_index in order[:6]:
        if counts[item_index] < max(12, int(border_rgb.shape[0] * 0.04)):
            continue
        color = (values[item_index].astype(np.int16) * 12 + 6).clip(0, 255)
        if all(np.linalg.norm(color - existing) > 22 for existing in colors):
            colors.append(color)
        if len(colors) >= 3:
            break
    if not colors:
        return image
    distances = [np.abs(rgb - color.reshape(1, 1, 3)).max(axis=2) for color in colors]
    background_candidate = np.minimum.reduce(distances) <= 34
    visited = np.zeros((height, width), dtype=np.bool_)
    remove = np.zeros((height, width), dtype=np.bool_)
    stack: list[tuple[int, int]] = []
    for x in range(width):
        if background_candidate[0, x]:
            stack.append((x, 0))
        if background_candidate[height - 1, x]:
            stack.append((x, height - 1))
    for y in range(height):
        if background_candidate[y, 0]:
            stack.append((0, y))
        if background_candidate[y, width - 1]:
            stack.append((width - 1, y))
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= width or y >= height or visited[y, x] or not background_candidate[y, x]:
            continue
        visited[y, x] = True
        remove[y, x] = True
        stack.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    ratio = float(remove.mean())
    if ratio < 0.03 or ratio > 0.92:
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


def _crop_character_reference_alpha(image: Image.Image, preserve_full_body: bool = False) -> Image.Image:
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
    keep = useful if preserve_full_body else (upper or useful)
    pad_x = max(12, int(round(image.width * 0.025)))
    pad_top = max(20, int(round(image.height * 0.04)))
    pad_bottom = max(16, int(round(image.height * 0.025)))
    left = max(0, min(comp[0] for comp in keep) - pad_x)
    top = max(0, min(comp[1] for comp in keep) - pad_top)
    right = min(image.width, max(comp[2] for comp in keep) + pad_x)
    bottom = min(image.height, max(comp[3] for comp in keep) + pad_bottom)
    if right <= left or bottom <= top:
        return image
    return image.crop((left, top, right, bottom))


def _select_character_view(character: dict[str, Any], prompt_text: str, explicit_label: str = "") -> dict[str, Any] | None:
    selected: dict[str, Any] | None = None
    global_prompt = _prompt_without_character_refs(prompt_text)
    if explicit_label:
        return _find_view(character, (), explicit_label)
    elif _prompt_wants_closeup(global_prompt):
        selected = _find_view(character, HEAD_LABEL_KEYWORDS)
    elif _prompt_wants_back(global_prompt):
        selected = _find_view(character, BACK_LABEL_KEYWORDS)
    elif _prompt_wants_side(global_prompt):
        selected = _find_view(character, _side_view_keywords(global_prompt))
    else:
        selected = _find_view(character, FRONT_LABEL_KEYWORDS)
    if selected is None:
        views = character.get("views") if isinstance(character.get("views"), list) else []
        selected = views[0] if views else None
    return selected


def _same_character_view(left: dict[str, Any] | None, right: dict[str, Any] | None) -> bool:
    if left is None or right is None:
        return False
    left_file = _safe_text(left.get("file")).strip()
    right_file = _safe_text(right.get("file")).strip()
    if left_file and right_file:
        return left_file == right_file
    left_label = _view_label(left).casefold()
    right_label = _view_label(right).casefold()
    return bool(left_label and right_label and left_label == right_label)


def _append_unique_character_view(views: list[dict[str, Any]], view: dict[str, Any] | None, limit: int) -> None:
    if view is None or len(views) >= max(0, int(limit or 0)):
        return
    if any(_same_character_view(item, view) for item in views):
        return
    views.append(view)


def _select_character_face_view(character: dict[str, Any]) -> dict[str, Any] | None:
    selected = _find_view(character, HEAD_LABEL_KEYWORDS)
    if selected is not None:
        return selected
    views = character.get("views") if isinstance(character.get("views"), list) else []
    return views[0] if views else None


def _select_character_pose_view(character: dict[str, Any], prompt_text: str, explicit_label: str = "") -> dict[str, Any] | None:
    if explicit_label:
        return _find_view(character, (), explicit_label)
    global_prompt = _prompt_without_character_refs(prompt_text)
    if _prompt_wants_back(global_prompt):
        selected = _find_view(character, BACK_LABEL_KEYWORDS)
    elif _prompt_wants_side(global_prompt):
        selected = _find_view(character, _side_view_keywords(global_prompt))
    else:
        selected = _find_view(character, FRONT_LABEL_KEYWORDS)
    if selected is None:
        views = character.get("views") if isinstance(character.get("views"), list) else []
        selected = views[0] if views else None
    return selected


def _character_reference_views(
    character: dict[str, Any],
    prompt_text: str,
    explicit_label: str = "",
) -> list[tuple[str, dict[str, Any]]]:
    pose_view = _select_character_pose_view(character, prompt_text, explicit_label)
    if _reference_wants_back(prompt_text, explicit_label):
        return [("pose", pose_view)] if pose_view is not None else []
    if not _reference_wants_closeup(prompt_text, explicit_label):
        face_view = _select_character_face_view(character)
        return [("identity", face_view)] if face_view is not None else ([("pose", pose_view)] if pose_view is not None else [])
    face_view = _select_character_face_view(character)
    result: list[tuple[str, dict[str, Any]]] = []
    if face_view is not None:
        result.append(("face", face_view))
    if pose_view is not None and not _same_character_view(face_view, pose_view):
        result.append(("pose", pose_view))
    return result


def _character_reference_images(character: dict[str, Any], prompt_text: str, explicit_label: str = "") -> list[Image.Image]:
    images: list[Image.Image] = []
    for _role, view in _character_reference_views(character, prompt_text, explicit_label):
        image = _open_character_view(character, view)
        if image is not None:
            images.append(image)
    return images


def _group_character_refs(refs: list[tuple[str, str]]) -> list[tuple[str, list[str]]]:
    grouped: list[tuple[str, list[str]]] = []
    index_by_name: dict[str, int] = {}
    for name, view in refs:
        clean_name = _safe_text(name).strip()
        clean_view = _safe_text(view).strip()
        if not clean_name:
            continue
        key = clean_name.casefold()
        if key not in index_by_name:
            index_by_name[key] = len(grouped)
            grouped.append((clean_name, []))
        views = grouped[index_by_name[key]][1]
        view_key = clean_view.casefold()
        if clean_view and all(item.casefold() != view_key for item in views):
            views.append(clean_view)
    return grouped


def _explicit_character_reference_views(character: dict[str, Any], labels: list[str]) -> list[tuple[str, dict[str, Any]]]:
    result: list[tuple[str, dict[str, Any]]] = []
    seen: set[tuple[str, str]] = set()
    for label in labels:
        view = _find_view(character, (), label)
        if view is None:
            continue
        key = (_safe_text(view.get("id")).casefold(), _safe_text(view.get("file")).casefold())
        if key in seen:
            continue
        seen.add(key)
        result.append(("pose", view))
    return result


def _single_character_reference_view(
    character: dict[str, Any],
    prompt_text: str,
    explicit_labels: list[str] | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    labels = explicit_labels or []
    if labels:
        explicit = _explicit_character_reference_views(character, labels)
        if explicit:
            return [explicit[0]]
    face_view = _select_character_face_view(character)
    if face_view is not None:
        return [("identity", face_view)]
    pose_view = _select_character_pose_view(character, prompt_text, labels[0] if labels else "")
    return [("pose", pose_view)] if pose_view is not None else []


def _character_full_body_reference_view(
    character: dict[str, Any],
    prompt_text: str,
    explicit_labels: list[str] | None = None,
) -> dict[str, Any] | None:
    labels = explicit_labels or []
    for label in labels:
        if _reference_wants_closeup("", label):
            continue
        view = _find_view(character, (), label)
        if view is not None:
            return view
    selected = _select_character_pose_view(character, prompt_text, "")
    if selected is not None:
        return selected
    return _select_character_face_view(character)


def _character_full_body_reference_views(
    character: dict[str, Any],
    prompt_text: str,
    explicit_labels: list[str] | None = None,
    limit: int = 3,
) -> list[dict[str, Any]]:
    labels = explicit_labels or []
    result: list[dict[str, Any]] = []
    for label in labels:
        if _reference_wants_closeup("", label):
            continue
        _append_unique_character_view(result, _find_view(character, (), label), limit)
    for keywords in (
        FRONT_LABEL_KEYWORDS,
        LEFT_LABEL_KEYWORDS + ANGLE_LABEL_KEYWORDS,
        RIGHT_LABEL_KEYWORDS + ANGLE_LABEL_KEYWORDS,
        BACK_LABEL_KEYWORDS,
    ):
        _append_unique_character_view(result, _find_view(character, keywords), limit)
    prompt_view = _select_character_pose_view(character, prompt_text, "")
    _append_unique_character_view(result, prompt_view, limit)
    all_views = character.get("views") if isinstance(character.get("views"), list) else []
    for view in all_views:
        label = _view_label(view)
        if _reference_wants_closeup("", label):
            continue
        _append_unique_character_view(result, view, limit)
    return result


def _select_multi_character_full_body_view(
    character: dict[str, Any],
    explicit_labels: list[str] | str | None = None,
) -> dict[str, Any] | None:
    labels = explicit_labels if isinstance(explicit_labels, list) else ([explicit_labels] if explicit_labels else [])
    for label in labels:
        view = _find_view(character, (), label)
        if view is not None:
            return view
    selected = _find_view(character, ("正面全身", "正面全身照", "front full body", "front_full_body"))
    if selected is not None:
        return selected
    selected = _find_view(character, FRONT_LABEL_KEYWORDS)
    if selected is not None:
        return selected
    views = character.get("views") if isinstance(character.get("views"), list) else []
    for view in views:
        if not _reference_wants_closeup("", _view_label(view)):
            return view
    return _select_character_face_view(character)


def _make_equal_height_reference_strip(
    items: list[tuple[Image.Image, bool]],
    gap: int | None = None,
) -> Image.Image | None:
    if not items:
        return None
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    cropped = [
        _crop_character_reference_alpha(image.convert("RGBA"), preserve_full_body=True) if crop_alpha else image.convert("RGBA")
        for image, crop_alpha in items
    ]
    target_h = max((image.height for image in cropped), default=0)
    if target_h <= 0:
        return None
    spacing = max(12, int(round(target_h * 0.04))) if gap is None else max(0, int(gap))
    normalized: list[Image.Image] = []
    for image in cropped:
        scale = target_h / max(1, image.height)
        target_w = max(1, int(round(image.width * scale)))
        normalized.append(image.resize((target_w, target_h), resampling))
    strip_w = sum(image.width for image in normalized) + spacing * max(0, len(normalized) - 1)
    strip = Image.new("RGBA", (max(1, strip_w), target_h), (0, 0, 0, 0))
    x_cursor = 0
    for image in normalized:
        strip.alpha_composite(image, (x_cursor, 0))
        x_cursor += image.width + spacing
    return strip


def _make_equal_height_character_strip(images: list[Image.Image], gap: int | None = None) -> Image.Image | None:
    return _make_equal_height_reference_strip([(image, True) for image in images], gap=gap)


def _make_qwen_single_character_reference_board(
    face_image: Image.Image | None,
    body_images: list[Image.Image],
    width: int,
    height: int,
) -> Image.Image | None:
    board_w = max(64, int(width or 1024))
    board_h = max(64, int(height or 768))
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    board = Image.new("RGB", (board_w, board_h), (255, 255, 255))
    margin = max(10, int(round(min(board_w, board_h) * 0.018)))
    panel_images = ([face_image] if face_image is not None else []) + body_images[:3]
    strip = _make_equal_height_reference_strip([(image, False) for image in panel_images], gap=max(10, int(round(board_h * 0.018))))
    if strip is None:
        return None
    safe_w = max(1, board_w - margin * 2)
    safe_h = max(1, board_h - margin * 2)
    scale = min(safe_w / max(1, strip.width), safe_h / max(1, strip.height))
    target_w = max(1, int(round(strip.width * scale)))
    target_h = max(1, int(round(strip.height * scale)))
    strip = strip.resize((target_w, target_h), resampling)
    board_rgba = board.convert("RGBA")
    board_rgba.alpha_composite(strip, ((board_w - target_w) // 2, max(0, board_h - margin - target_h)))
    board = board_rgba.convert("RGB")
    return board


def _make_multi_character_full_body_board(
    prompt_text: str,
    grouped_refs: list[tuple[str, list[str]]],
    width: int = 1024,
    height: int = 768,
) -> tuple[Image.Image | None, list[tuple[str, dict[str, Any]]], list[str]]:
    resolved: list[tuple[str, dict[str, Any], Image.Image, list[str]]] = []
    for name, explicit_labels in grouped_refs:
        character = _find_character(name)
        if not character:
            continue
        view = _select_multi_character_full_body_view(character, explicit_labels)
        if view is None:
            continue
        image = _open_character_view_rgba(character, view)
        if image is None:
            continue
        resolved.append((name, character, image, explicit_labels))
    if not resolved:
        return None, [], []

    count = len(resolved)
    board_h = max(640, min(1024, int(height or 768)))
    board_w = max(768, min(2400, max(int(width or 1024), count * 300)))
    board = Image.new("RGBA", (board_w, board_h), (255, 255, 255, 255))
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    strip = _make_equal_height_character_strip([image for _name, _character, image, _labels in resolved])
    if strip is not None:
        safe_w = int(round(board_w * 0.94))
        safe_h = int(round(board_h * 0.86))
        scale = min(safe_w / max(1, strip.width), safe_h / max(1, strip.height))
        target_w = max(1, int(round(strip.width * scale)))
        target_h = max(1, int(round(strip.height * scale)))
        strip = strip.resize((target_w, target_h), resampling)
        x = max(0, min(board_w - target_w, (board_w - target_w) // 2))
        y = max(0, min(board_h - target_h, int(round(board_h * 0.94 - target_h))))
        board.alpha_composite(strip, (x, y))

    resolved_characters = [(name, character) for name, character, _image, _labels in resolved]
    position_lines: list[str] = []
    for index, (name, character, _image, _labels) in enumerate(resolved):
        display_name = _character_display_name(character, name)
        position_lines.append(f"{index + 1}. 从左到右第 {index + 1} 人是“{display_name}”")
    return board.convert("RGB"), resolved_characters, position_lines


def _pil_fit_cell(image: Image.Image, width: int, height: int, contain: bool = False, top_bias: bool = False) -> Image.Image:
    source = image.convert("RGB")
    if contain:
        safe_w = max(1, width - 28)
        safe_h = max(1, height - 40)
        scale = min(safe_w / max(1, source.width), safe_h / max(1, source.height))
    else:
        scale = max(width / max(1, source.width), height / max(1, source.height)) * 1.02
    new_size = (max(1, int(round(source.width * scale))), max(1, int(round(source.height * scale))))
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    resized = source.resize(new_size, resampling)
    canvas = Image.new("RGB", (width, height), (255, 255, 255))
    x = (width - resized.width) // 2
    if contain and top_bias:
        y = min(max(18, int(round(height * 0.055))), max(0, height - resized.height))
    else:
        y = (height - resized.height) // 2
    canvas.paste(resized, (x, y))
    return canvas


def _make_character_reference_tensor(images: list[Image.Image], contain_images: bool = False) -> torch.Tensor | None:
    if not images:
        return None
    cell_w, cell_h = 512, 640
    tensors: list[torch.Tensor] = []
    for image in images:
        cell = _pil_fit_cell(image, cell_w, cell_h, contain=True, top_bias=True)
        array = np.asarray(cell).astype(np.float32) / 255.0
        tensors.append(torch.from_numpy(array).unsqueeze(0))
    return torch.cat(tensors, dim=0).contiguous()


def _extract_scene_refs(text: str) -> list[tuple[str, str]]:
    refs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    source = _safe_text(text)
    for match in SCENE_VIEW_REF_RE.finditer(source):
        name = _safe_text(match.group(1)).strip(" 　.,，;；。!！?？")
        place = f"视窗@{match.group(2)},{match.group(3)},{match.group(4)},{match.group(5)}"
        if not name or not place:
            continue
        key = (name.casefold(), place.casefold())
        if key in seen:
            continue
        seen.add(key)
        refs.append((name, place))
    for match in SCENE_REF_RE.finditer(source):
        name = _safe_text(match.group(1) or match.group(3)).strip(" 　.,，;；。!！?？")
        place = _safe_text(match.group(2) or match.group(4)).strip(" 　.,，;；。!！?？")
        if not name:
            continue
        key = (name.casefold(), place.casefold())
        if key in seen:
            continue
        seen.add(key)
        refs.append((name, place))
    for match in SCENE_BRACKET_REF_RE.finditer(source):
        raw_name = _safe_text(match.group(1)).strip(" 　.,，;；。!！?？")
        place = _safe_text(match.group(2)).strip(" 　.,，;；。!！?？")
        name = raw_name
        if raw_name in {"场景", "scene", "Scene"}:
            continue
        if place.lower().startswith(("视窗@", "view@", "viewport@")):
            continue
        if ":" in raw_name or "：" in raw_name:
            continue
        if not _find_scene(name):
            continue
        key = (name.casefold(), place.casefold())
        if key in seen:
            continue
        seen.add(key)
        refs.append((name, place))
    return refs


def _scene_asset_path(scene: dict[str, Any], asset: dict[str, Any]) -> Path | None:
    file_name = _safe_text(asset.get("file") or asset.get("preview_file")).strip()
    if not file_name:
        return None
    base = Path(_safe_text(scene.get("_dir"))).resolve()
    path = (base / file_name).resolve()
    try:
        if base != path and base not in path.parents:
            return None
    except Exception:
        return None
    return path if path.is_file() else None


def _read_radiance_rgbe(path: Path) -> np.ndarray:
    import io

    with path.open("rb") as handle:
        stream = io.BytesIO(handle.read())
    width = height = 0
    x_sign = "+"
    y_sign = "-"
    while True:
        line = stream.readline()
        if not line:
            break
        text = line.decode("ascii", errors="ignore").strip()
        match = re.match(r"([+-])Y\s+(\d+)\s+([+-])X\s+(\d+)", text)
        if match:
            y_sign, height_text, x_sign, width_text = match.groups()
            height = int(height_text)
            width = int(width_text)
            break
    if width <= 0 or height <= 0:
        raise RuntimeError("HDR 文件缺少 Radiance 分辨率行。")

    data = np.zeros((height, width, 4), dtype=np.uint8)
    for y in range(height):
        header = stream.read(4)
        if len(header) < 4:
            raise RuntimeError("HDR 像素数据不完整。")
        if width < 8 or width > 0x7FFF or header[0] != 2 or header[1] != 2 or ((header[2] << 8) | header[3]) != width:
            rest = stream.read(width * height * 4 - 4)
            raw = header + rest
            if len(raw) < width * height * 4:
                raise RuntimeError("HDR 非 RLE 像素数据不完整。")
            data = np.frombuffer(raw[: width * height * 4], dtype=np.uint8).reshape((height, width, 4)).copy()
            break
        scanline = np.zeros((4, width), dtype=np.uint8)
        for channel in range(4):
            x = 0
            while x < width:
                pair = stream.read(2)
                if len(pair) < 2:
                    raise RuntimeError("HDR RLE 扫描线不完整。")
                count = pair[0]
                value = pair[1]
                if count > 128:
                    run = count - 128
                    scanline[channel, x : x + run] = value
                    x += run
                else:
                    run = count
                    scanline[channel, x] = value
                    if run > 1:
                        values = stream.read(run - 1)
                        if len(values) < run - 1:
                            raise RuntimeError("HDR RLE literal 不完整。")
                        scanline[channel, x + 1 : x + run] = np.frombuffer(values, dtype=np.uint8)
                    x += run
        data[y] = scanline.T

    if y_sign == "+":
        data = data[::-1, :, :]
    if x_sign == "-":
        data = data[:, ::-1, :]

    exponent = data[..., 3].astype(np.int16)
    rgb = np.zeros((height, width, 3), dtype=np.float32)
    mask = exponent > 0
    if np.any(mask):
        scale = np.exp2(exponent[mask].astype(np.float32) - 136.0)
        rgb[mask] = data[..., :3][mask].astype(np.float32) * scale[:, None]
    return rgb


def _read_hdr_scene_array(path: Path):
    errors = []
    if path.suffix.lower() == ".hdr":
        try:
            return _read_radiance_rgbe(path)
        except Exception as exc:
            errors.append(exc)
    try:
        image = Image.open(path)
        array = np.asarray(image)
        if array.size:
            return array
    except Exception as exc:
        errors.append(exc)
    try:
        import imageio.v3 as iio

        array = iio.imread(path)
        if getattr(array, "size", 0):
            return array
    except Exception as exc:
        errors.append(exc)
    try:
        import imageio

        array = imageio.imread(path)
        if getattr(array, "size", 0):
            return array
    except Exception as exc:
        errors.append(exc)
    try:
        os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
        import cv2

        array = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        if array is not None and getattr(array, "size", 0):
            if len(array.shape) == 3 and array.shape[2] >= 3:
                array = cv2.cvtColor(array[:, :, :3], cv2.COLOR_BGR2RGB)
            return array
    except Exception as exc:
        errors.append(exc)
    if errors:
        raise errors[-1]
    raise RuntimeError("无法读取 HDR/EXR 场景。")


def _write_hdr_scene_placeholder(path: Path, target: Path, message: str = "") -> bool:
    try:
        from PIL import ImageDraw, ImageFont

        target.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", (960, 540), (11, 18, 24))
        draw = ImageDraw.Draw(image)
        for y in range(image.height):
            t = y / max(1, image.height - 1)
            draw.line(
                [(0, y), (image.width, y)],
                fill=(int(16 + 26 * t), int(25 + 34 * t), int(34 + 44 * t)),
            )
        try:
            font_big = ImageFont.truetype("arial.ttf", 44)
            font = ImageFont.truetype("arial.ttf", 22)
            font_small = ImageFont.truetype("arial.ttf", 16)
        except Exception:
            font_big = ImageFont.load_default()
            font = ImageFont.load_default()
            font_small = ImageFont.load_default()
        draw.rounded_rectangle((40, 40, image.width - 40, image.height - 40), radius=18, outline=(78, 106, 118), width=2)
        draw.text((72, 78), "HDR / EXR", fill=(234, 245, 247), font=font_big)
        draw.text((72, 150), path.name[:80], fill=(184, 205, 212), font=font)
        draw.text((72, 206), "storyboard preview placeholder", fill=(121, 151, 162), font=font_small)
        if message:
            draw.text((72, 242), str(message).replace("\n", " ")[:150], fill=(121, 151, 162), font=font_small)
        image.save(target, "PNG")
        return True
    except Exception:
        return False


def _tonemap_hdr_scene_preview(path: Path, target: Path) -> Path | None:
    try:
        array = np.asarray(_read_hdr_scene_array(path))
        if array.ndim == 2:
            array = np.stack([array, array, array], axis=-1)
        if array.ndim != 3:
            raise RuntimeError(f"HDR 维度不支持：{tuple(array.shape)}")
        if array.shape[2] > 3:
            array = array[:, :, :3]
        array = array.astype("float32")
        array = np.nan_to_num(array, nan=0.0, posinf=0.0, neginf=0.0)
        array = np.maximum(array, 0.0)
        high = float(np.percentile(array, 99.5)) if array.size else 1.0
        if high <= 0:
            high = float(array.max()) if array.size else 1.0
        if high <= 0:
            high = 1.0
        array = np.clip(array / high, 0.0, 1.0)
        luma = 0.2126 * array[..., 0] + 0.7152 * array[..., 1] + 0.0722 * array[..., 2]
        mid = float(np.percentile(luma, 55)) if luma.size else 0.3
        if mid > 0 and mid < 0.30:
            array = np.clip(array * min(3.2, 0.36 / mid), 0.0, 1.0)
        array = np.power(array, 1.0 / 2.2)
        luma2 = 0.2126 * array[..., 0] + 0.7152 * array[..., 1] + 0.0722 * array[..., 2]
        mean = float(np.mean(luma2)) if luma2.size else 0.45
        if mean < 0.38:
            array = np.clip(array * min(1.8, 0.46 / max(0.01, mean)), 0.0, 1.0)
        out = (array * 255.0 + 0.5).astype("uint8")
        image = Image.fromarray(out, "RGB")
        resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
        image.thumbnail((1600, 900), resampling)
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, "PNG")
        return target if target.is_file() else None
    except Exception as exc:
        print(f"[GJJ StoryboardGridGenerator] HDR 预览生成失败: {path.name}: {exc}")
        return target if _write_hdr_scene_placeholder(path, target, str(exc)) and target.is_file() else None


def _ensure_storyboard_scene_preview(path: Path) -> Path | None:
    if path.suffix.lower() not in {".hdr", ".exr"}:
        return path
    target = path.parent / f"__storyboard_rgbe_preview_{path.stem}.png"
    try:
        if target.is_file() and target.stat().st_size > 0 and target.stat().st_mtime >= path.stat().st_mtime:
            return target
    except Exception:
        pass
    return _tonemap_hdr_scene_preview(path, target)


def _scene_preview_path(scene: dict[str, Any], asset: dict[str, Any]) -> Path | None:
    base = Path(_safe_text(scene.get("_dir"))).resolve()
    candidates = []
    preview_file = _safe_text(asset.get("preview_file")).strip()
    file_name = _safe_text(asset.get("file")).strip()
    if preview_file:
        candidates.append(preview_file)
    if file_name:
        stem = Path(file_name).stem
        candidates.append(f"__preview_{stem}.png")
        candidates.append(file_name)
    for name in candidates:
        path = (base / name).resolve()
        try:
            if (base == path or base in path.parents) and path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
                return path
        except Exception:
            continue
    raw = _scene_asset_path(scene, asset)
    if raw is not None and raw.suffix.lower() in {".hdr", ".exr"}:
        return _ensure_storyboard_scene_preview(raw)
    return None


def _parse_scene_viewport_place(place: str) -> dict[str, Any] | None:
    text = _safe_text(place).strip()
    lowered = text.casefold()
    for prefix in ("视窗@", "view@", "viewport@"):
        if lowered.startswith(prefix):
            payload = text[len(prefix):].strip()
            break
    else:
        return None
    asset_id = ""
    coord_text = payload
    colon = payload.find(":")
    comma = payload.find(",")
    if colon > 0 and (comma < 0 or colon < comma):
        asset_id = payload[:colon].strip()
        coord_text = payload[colon + 1 :].strip()
    numbers = re.findall(r"-?\d+(?:\.\d+)?", coord_text)
    if len(numbers) < 4:
        return None
    x, y, w, h = [float(value) for value in numbers[:4]]
    w = max(0.02, min(1.0, w))
    h = max(0.02, min(1.0, h))
    x = x % 1.0
    y = max(0.0, min(1.0 - h, y))
    return {"asset_id": asset_id, "x": x, "y": y, "w": w, "h": h}


def _select_scene_asset(scene: dict[str, Any], place: str = "") -> dict[str, Any] | None:
    assets = scene.get("assets") if isinstance(scene.get("assets"), list) else []
    viewport = _parse_scene_viewport_place(place)
    mark = None if viewport else (_scene_annotation(scene, place) if place else None)
    mark_asset_id = _safe_text((viewport or {}).get("asset_id") or (mark.get("asset_id") if mark else "")).strip()
    if mark_asset_id:
        for asset in assets:
            if _safe_text(asset.get("id")).strip() == mark_asset_id:
                return asset
    for asset in assets:
        if _scene_preview_path(scene, asset) is not None:
            return asset
    for asset in assets:
        path = _scene_asset_path(scene, asset)
        if path is not None and path.suffix.lower() in {".hdr", ".exr"}:
            return asset
    return assets[0] if assets else None


def _crop_scene_viewport_background(image: Image.Image, width: int, height: int, viewport: dict[str, Any]) -> Image.Image:
    source = image.convert("RGB")
    sw, sh = source.size
    view_w = max(8, min(sw, int(round(float(viewport.get("w") or 1.0) * sw))))
    view_h = max(8, min(sh, int(round(float(viewport.get("h") or 1.0) * sh))))
    view_left = int(round(float(viewport.get("x") or 0.0) * sw)) % max(1, sw)
    view_top = max(0, min(sh - view_h, int(round(float(viewport.get("y") or 0.0) * sh))))
    target_aspect = max(1, int(width)) / max(1, int(height))
    crop_w = view_w
    crop_h = view_h
    if crop_w / max(1, crop_h) < target_aspect:
        crop_w = min(sw, max(crop_w, int(round(crop_h * target_aspect))))
    else:
        crop_h = min(sh, max(crop_h, int(round(crop_w / target_aspect))))
    center_x = (view_left + view_w * 0.5) % max(1, sw)
    center_y = view_top + view_h * 0.5
    left = int(round(center_x - crop_w * 0.5)) % max(1, sw)
    top = max(0, min(sh - crop_h, int(round(center_y - crop_h * 0.5))))
    if left + crop_w <= sw:
        crop = source.crop((left, top, left + crop_w, top + crop_h))
    else:
        doubled = Image.new("RGB", (sw * 2, sh))
        doubled.paste(source, (0, 0))
        doubled.paste(source, (sw, 0))
        crop = doubled.crop((left, top, left + crop_w, top + crop_h))
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    return crop.resize((max(64, int(width)), max(64, int(height))), resampling)


def _scene_annotation(scene: dict[str, Any], place: str, asset_id: str = "") -> dict[str, Any] | None:
    key = _normalize_scene_key(place)
    if not key:
        return None
    fallback: dict[str, Any] | None = None
    for mark in scene.get("annotations") or []:
        if asset_id and _safe_text(mark.get("asset_id")).strip() not in {"", asset_id}:
            continue
        mark_key = _normalize_scene_key(mark.get("keyword"))
        if key == mark_key:
            return mark
        if not fallback and mark_key and (key in mark_key or mark_key in key):
            fallback = mark
    return fallback


def _crop_scene_background(
    image: Image.Image,
    width: int,
    height: int,
    center_x: float = 0.5,
    center_y: float = 0.5,
    is_panorama: bool = False,
    focus_anchor: bool = False,
) -> Image.Image:
    source = image.convert("RGB")
    width = max(64, int(width))
    height = max(64, int(height))
    cx = max(0.0, min(1.0, float(center_x)))
    cy = max(0.0, min(1.0, float(center_y)))
    aspect = width / max(1, height)
    sw, sh = source.size
    if is_panorama and sw >= sh * 1.7:
        cy = max(0.44, min(0.56, 0.5 + (cy - 0.5) * 0.25))
        min_ratio = 0.16 if focus_anchor else 0.22
        max_ratio = 0.30 if focus_anchor else 0.42
        crop_w = max(64, int(round(sw * min_ratio)))
        crop_h = max(64, int(round(crop_w / aspect)))
        if crop_h > sh:
            crop_h = sh
            crop_w = max(64, int(round(crop_h * aspect)))
        if crop_w > int(round(sw * max_ratio)):
            crop_w = max(64, int(round(sw * max_ratio)))
            crop_h = max(64, int(round(crop_w / aspect)))
            if crop_h > sh:
                crop_h = sh
                crop_w = max(64, int(round(crop_h * aspect)))
        center_px = int(round(cx * sw))
        top = max(0, min(sh - crop_h, int(round(cy * sh - crop_h * 0.5))))
        left = center_px - crop_w // 2
        if left < 0 or left + crop_w > sw:
            doubled = Image.new("RGB", (sw * 3, sh))
            doubled.paste(source, (0, 0))
            doubled.paste(source, (sw, 0))
            doubled.paste(source, (sw * 2, 0))
            crop = doubled.crop((left + sw, top, left + sw + crop_w, top + crop_h))
        else:
            crop = source.crop((left, top, left + crop_w, top + crop_h))
    else:
        crop_w = sw
        crop_h = int(round(crop_w / aspect))
        if crop_h > sh:
            crop_h = sh
            crop_w = int(round(crop_h * aspect))
        left = max(0, min(sw - crop_w, int(round(cx * sw - crop_w * 0.5))))
        top = max(0, min(sh - crop_h, int(round(cy * sh - crop_h * 0.5))))
        crop = source.crop((left, top, left + crop_w, top + crop_h))
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    return crop.resize((width, height), resampling)


def _scene_background_image(scene: dict[str, Any], place: str, width: int, height: int) -> tuple[Image.Image | None, str]:
    asset = _select_scene_asset(scene, place)
    if not asset:
        return None, ""
    image_path = _scene_preview_path(scene, asset) or _scene_asset_path(scene, asset)
    if image_path is None:
        return None, ""
    try:
        image = Image.open(image_path).convert("RGB")
    except Exception:
        return None, ""
    viewport = _parse_scene_viewport_place(place)
    if viewport is not None:
        label = _safe_text(scene.get("name") or scene.get("id")).strip()
        return _crop_scene_viewport_background(image, width, height, viewport), label
    mark = _scene_annotation(scene, place, _safe_text(asset.get("id")).strip()) if place else None
    try:
        center_x = float(mark.get("x")) if mark and mark.get("x") is not None else 0.5
        center_y = float(mark.get("y")) if mark and mark.get("y") is not None else 0.5
    except Exception:
        center_x, center_y = 0.5, 0.5
    is_panorama = _safe_text(scene.get("type")).lower() == "360" or image.width >= image.height * 1.7
    label = _safe_text(place or scene.get("name") or scene.get("id")).strip()
    return _crop_scene_background(image, width, height, center_x, center_y, is_panorama, focus_anchor=mark is not None), label


def _paste_character_on_background(background: Image.Image, character_image: Image.Image, slot: str = "center") -> Image.Image:
    bg = background.convert("RGBA")
    char = character_image.convert("RGBA")
    if char.width <= 0 or char.height <= 0:
        return bg.convert("RGB")
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    target_h = int(round(bg.height * 0.82))
    if slot == "center":
        target_h = int(round(bg.height * 0.76))
    scale = target_h / max(1, char.height)
    target_w = int(round(char.width * scale))
    if target_w > bg.width * 0.62:
        scale = (bg.width * 0.62) / max(1, char.width)
        target_w = int(round(char.width * scale))
        target_h = int(round(char.height * scale))
    char = char.resize((max(1, target_w), max(1, target_h)), resampling)
    if slot == "left":
        x = int(round(bg.width * 0.08))
    elif slot == "right":
        x = int(round(bg.width * 0.92 - char.width))
    else:
        x = int(round((bg.width - char.width) * 0.5))
    y = int(round(bg.height * 0.95 - char.height))
    x = max(0, min(bg.width - char.width, x))
    y = max(0, min(bg.height - char.height, y))
    bg.alpha_composite(char, (x, y))
    return bg.convert("RGB")


def _character_slot_label(slot: str, index: int = 0) -> str:
    if slot == "far_left":
        return "画面最左侧"
    if slot == "left":
        return "画面左侧"
    if slot == "left_center":
        return "画面左中位置"
    if slot == "right":
        return "画面右侧"
    if slot == "right_center":
        return "画面右中位置"
    if slot == "far_right":
        return "画面最右侧"
    if slot == "center":
        return "画面中间"
    return ["画面左侧", "画面右侧", "画面中间"][min(max(0, index), 2)]


def _character_default_slots(count: int) -> list[str]:
    if count <= 1:
        return ["center"]
    if count == 2:
        return ["left", "right"]
    if count == 3:
        return ["left", "center", "right"]
    if count == 4:
        return ["far_left", "left_center", "right_center", "far_right"]
    return ["far_left", "left", "center", "right", "far_right"]


def _character_slot_sort_order(slots: list[str]) -> dict[str, int]:
    return {slot: index for index, slot in enumerate(slots)}


def _character_note_for_scene_prompt(character: dict[str, Any], name: str) -> str:
    notes = _safe_text(character.get("notes") or "").strip()
    if notes:
        return notes
    display = _character_display_name(character, name)
    return f"{display}，保持人物五官、发型、服装配色和身份一致"


def _select_scene_character_view(
    character: dict[str, Any],
    prompt_text: str,
    explicit_labels: list[str] | str | None = None,
    prefer_front_full_body: bool = False,
) -> dict[str, Any] | None:
    labels = explicit_labels if isinstance(explicit_labels, list) else ([explicit_labels] if explicit_labels else [])
    if prefer_front_full_body:
        return _select_multi_character_full_body_view(character, labels)
    selected = _character_full_body_reference_view(character, prompt_text, labels)
    if selected is None:
        pose_label = next((label for label in labels if not _reference_wants_closeup("", label)), "")
        selected = _select_character_pose_view(character, prompt_text, pose_label)
    if selected is None:
        selected = _select_character_face_view(character)
    return selected


def _make_scene_character_board(
    prompt_text: str,
    character_refs: list[tuple[str, str]],
    width: int,
    height: int,
    background: Image.Image | None = None,
) -> tuple[Image.Image | None, list[str], list[str]]:
    if not character_refs:
        return None, [], []
    hints = _character_position_hints(prompt_text)
    resolved: list[tuple[str, dict[str, Any], Image.Image, str, str]] = []
    used_slots: set[str] = set()
    scene_refs = _group_character_refs(character_refs)
    default_slots = _character_default_slots(len(scene_refs))
    for index, (char_name, explicit_views) in enumerate(scene_refs):
        character = _find_character(char_name)
        if not character:
            continue
        selected_view = _select_scene_character_view(
            character,
            prompt_text,
            explicit_views,
            prefer_front_full_body=len(scene_refs) > 1,
        )
        if selected_view is None:
            continue
        char_image = _open_character_view_rgba(character, selected_view, preserve_full_body=True)
        if char_image is None:
            continue
        try:
            if int(np.asarray(char_image.getchannel("A")).min(initial=255)) >= 240:
                continue
        except Exception:
            continue
        explicit_view = next((label for label in explicit_views if not _reference_wants_closeup("", label)), explicit_views[0] if explicit_views else "")
        slot = hints.get(char_name.casefold()) or hints.get((char_name + "/" + explicit_view).casefold()) or ""
        if slot not in default_slots or slot in used_slots:
            slot = ""
            for candidate in default_slots:
                if candidate not in used_slots:
                    slot = candidate
                    break
        if not slot:
            slot = default_slots[min(index, len(default_slots) - 1)]
        used_slots.add(slot)
        resolved.append((char_name, character, char_image, slot, explicit_view))
    if not resolved:
        return None, [], []
    if len(scene_refs) > 3 and len(resolved) < len(scene_refs):
        return None, [], []
    if background is not None:
        board = background.convert("RGBA").resize((max(64, int(width)), max(64, int(height))))
    else:
        board = Image.new("RGBA", (max(64, int(width)), max(64, int(height))), (255, 255, 255, 255))
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    prompt_parts: list[str] = []
    binding_lines: list[str] = []
    slot_order = _character_slot_sort_order(default_slots)
    sorted_resolved = sorted(enumerate(resolved), key=lambda item: (slot_order.get(item[1][3], item[0]), item[0]))
    character_layers = [(original_index, item, item[2].convert("RGBA")) for original_index, item in sorted_resolved]
    group = _make_equal_height_character_strip([char for _original_index, _item, char in character_layers])
    if group is not None and group.width > 0 and group.height > 0:
        closeup = _prompt_wants_closeup(prompt_text)
        max_group_w = int(round(board.width * 0.90))
        max_group_h = int(round(board.height * (0.78 if closeup else 0.66)))
        scale = min(max_group_w / max(1, group.width), max_group_h / max(1, group.height))
        scaled_w = max(1, int(round(group.width * scale)))
        scaled_h = max(1, int(round(group.height * scale)))
        group = group.resize((scaled_w, scaled_h), resampling)
        slots = {item[3] for _original_index, item, _char in character_layers}
        if len(character_layers) == 1 and "left" in slots:
            group_x = int(round(board.width * 0.12))
        elif len(character_layers) == 1 and "right" in slots:
            group_x = int(round(board.width * 0.88 - group.width))
        else:
            group_x = int(round((board.width - group.width) * 0.5))
        group_x = max(0, min(board.width - group.width, group_x))
        group_y = max(0, min(board.height - group.height, int(round(board.height * 0.96 - group.height))))
        board.alpha_composite(group, (group_x, group_y))
    for index, (char_name, character, _char_image, slot, _explicit_view) in enumerate(resolved):
        label = _character_slot_label(slot, index)
        display_name = _character_display_name(character, char_name)
        note = _character_note_for_scene_prompt(character, char_name)
        prompt_parts.append(f"{label}({note})的{display_name}")
        binding_lines.append(f"{display_name}=观众视角最终画面的{label}=image1中同一侧的人物")
    return board.convert("RGB"), prompt_parts, binding_lines


def _make_scene_identity_reference_board(
    prompt_text: str,
    character_refs: list[tuple[str, str]],
    width: int,
    height: int,
) -> tuple[Image.Image | None, list[str]]:
    grouped_refs = _group_character_refs(character_refs)
    images: list[tuple[str, dict[str, Any], Image.Image]] = []
    for name, explicit_labels in grouped_refs:
        character = _find_character(name)
        if not character:
            continue
        view = None
        for label in explicit_labels:
            if not _reference_wants_closeup("", label):
                continue
            view = _find_view(character, (), label)
            if view is not None:
                break
        if view is None:
            view = _select_character_face_view(character)
        if view is None:
            view = _character_full_body_reference_view(character, prompt_text, explicit_labels)
        if view is None:
            continue
        image = _open_character_view(character, view)
        if image is None:
            continue
        images.append((name, character, image))
    if not images:
        return None, []
    count = len(images)
    board_w = max(512, min(1536, max(int(width or 1024), count * 360)))
    board_h = max(512, min(1024, int(height or 768)))
    panel_w = board_w / max(1, count)
    board = Image.new("RGB", (board_w, board_h), (255, 255, 255))
    display_names: list[str] = []
    for index, (name, character, image) in enumerate(images):
        cell = _pil_fit_cell(
            image,
            max(1, int(round(panel_w))),
            board_h,
            contain=True,
            top_bias=True,
        )
        x = int(round(index * panel_w))
        board.paste(cell, (x, 0))
        display_names.append(_character_display_name(character, name))
    return board, display_names


def _make_qwen_direct_character_reference_boards(
    prompt_text: str,
    character_refs: list[tuple[str, str]],
    width: int,
    height: int,
    max_boards: int = 3,
    single_view_only: bool = False,
) -> list[tuple[str, Image.Image]]:
    grouped_refs = _group_character_refs(character_refs)
    limit = max(0, int(max_boards or 0))
    if not grouped_refs or limit <= 0 or len(grouped_refs) > limit:
        return []
    boards: list[tuple[str, Image.Image]] = []
    board_w = max(64, int(width or 1024))
    board_h = max(64, int(height or 768))
    for name, explicit_labels in grouped_refs:
        character = _find_character(name)
        if not character:
            return []
        if single_view_only:
            view = _select_multi_character_full_body_view(character, explicit_labels)
            if view is None:
                return []
            image = _open_character_view_white(character, view)
            if image is None:
                return []
            boards.append((
                _character_display_name(character, name),
                _pil_fit_cell(image, board_w, board_h, contain=True, top_bias=True),
            ))
            continue
        face_view = None
        for label in explicit_labels:
            if not _reference_wants_closeup("", label):
                continue
            face_view = _find_view(character, (), label)
            if face_view is not None:
                break
        if face_view is None:
            face_view = _select_character_face_view(character)
        body_views = _character_full_body_reference_views(character, prompt_text, explicit_labels, limit=3)
        if face_view is None and not body_views:
            return []
        face_image = _open_character_view_white(character, face_view) if face_view is not None else None
        body_images = [image for view in body_views if (image := _open_character_view_white(character, view)) is not None]
        if face_image is None and not body_images:
            return []
        board = _make_qwen_single_character_reference_board(face_image, body_images, board_w, board_h)
        if board is None:
            return []
        boards.append((_character_display_name(character, name), board))
    return boards


def _pil_list_to_reference_tensor(images: list[Image.Image]) -> torch.Tensor | None:
    if not images:
        return None
    target_w = max(1, int(images[0].width))
    target_h = max(1, int(images[0].height))
    tensors: list[torch.Tensor] = []
    for image in images:
        source = image.convert("RGB")
        if source.size != (target_w, target_h):
            source = _pil_fit_cell(source, target_w, target_h, contain=True, top_bias=False)
        array = np.asarray(source).astype(np.float32) / 255.0
        tensors.append(torch.from_numpy(array).unsqueeze(0))
    return torch.cat(tensors, dim=0).contiguous()


def _scene_reference_tensor_for_prompt(
    prompt_text: str,
    width: int,
    height: int,
    compose_character_references: bool = False,
    include_identity_reference_board: bool = False,
    use_direct_character_references: bool = False,
) -> tuple[str, torch.Tensor | None, bool]:
    scene_refs = _extract_scene_refs(prompt_text)
    if not scene_refs:
        return prompt_text, None, False
    reference_images: list[Image.Image] = []
    prompt_lines: list[str] = []
    character_refs = _extract_character_refs(prompt_text)
    consumed_characters = False
    for scene_name, place in scene_refs[:1]:
        scene = _find_scene(scene_name)
        if not scene:
            continue
        background, label = _scene_background_image(scene, place, width, height)
        if background is None:
            continue
        grouped_character_refs = _group_character_refs(character_refs)
        direct_character_boards: list[tuple[str, Image.Image]] = []
        direct_character_mode = use_direct_character_references and 0 < len(grouped_character_refs) <= 2
        if direct_character_mode:
            direct_character_boards = _make_qwen_direct_character_reference_boards(
                prompt_text,
                character_refs,
                width,
                height,
                max_boards=2,
            )
        if direct_character_boards:
            reference_images.append(background)
            for _display_name, board in direct_character_boards[:2]:
                reference_images.append(board)
            consumed_characters = True
            display = _safe_text(scene.get("name") or scene.get("id") or scene_name).strip()
            anchor_rule = f"本格指定的场景锚点是“{label}”，最终画面的主要空间和人物互动位置必须围绕“{label}”。" if label else ""
            prompt_lines.append(
                f"参考图使用规则：image1 是场景库“{display}”{('的“' + label + '”位置') if label else ''}干净背景参考，"
                f"必须作为最终背景和空间透视来源。{anchor_rule}"
                "image2 起是逐个角色参考拼图，每张只对应一个角色；角色拼图可以包含大头照和多张等高全身参考。"
                "角色拼图只用于锁定该角色的脸型、五官、发色、头饰、服装配色、体型、正反侧面和身份；"
                "不得复制角色参考拼图的白底、半身裁切、站姿、多视图排版或原背景。"
                "最终动作、坐姿、举杯、背靠、人物左右位置和场景透视必须服从原始文字描述与 image1 背景。"
            )
            for offset, (display_name, _board) in enumerate(direct_character_boards[:2], start=2):
                prompt_lines.append(f"image{offset} 只绑定角色“{display_name}”，不要把 image{offset} 当成另一个场景或构图。")
            continue
        use_separate_references = len(character_refs) <= 2 and (direct_character_mode or not compose_character_references)
        character_board, character_parts, character_bindings = (
            (None, [], [])
            if use_separate_references
            else _make_scene_character_board(prompt_text, character_refs, width, height, background)
        )
        if character_board is not None:
            reference_images.append(character_board)
            consumed_characters = True
        character_board_is_scene_strip = character_board is not None and len(grouped_character_refs) > 1
        if not character_board_is_scene_strip:
            reference_images.append(background)
        identity_names: list[str] = []
        if include_identity_reference_board and character_board is not None and not character_board_is_scene_strip and len(reference_images) < 3:
            identity_board, identity_names = _make_scene_identity_reference_board(prompt_text, character_refs, width, height)
            if identity_board is not None:
                reference_images.append(identity_board)
        display = _safe_text(scene.get("name") or scene.get("id") or scene_name).strip()
        if use_separate_references:
            anchor_rule = f"本格指定的场景锚点是“{label}”，最终画面的主要空间和人物互动位置必须围绕“{label}”，不要漂移到同一场景其它未指定物品旁边。" if label else ""
            prompt_lines.append(
                f"参考图使用规则：image1 是场景库“{display}”{('的“' + label + '”位置') if label else ''}背景参考，"
                f"必须优先作为最终画面的背景使用。{anchor_rule}"
                "Strict binding: image1 is the background/environment only. All characters from later reference images must be placed into image1's environment."
                "后续角色参考图必须作为人物身份、服装、姿态和朝向参考放入 image1 背景中；"
                "不要把角色参考图的原背景当作最终背景，不要把参考图裁切、大头照或多余人物复制进画面。"
            )
        elif character_parts:
            anchor_rule = f"本格指定的场景锚点是“{label}”，最终画面的主要空间和人物互动位置必须围绕“{label}”，不要漂移到同一场景的床、椅子、窗户或其它未指定物品旁边。" if label else ""
            if character_board_is_scene_strip:
                prompt_lines.append(
                    f"参考图使用规则：image1 是场景库“{display}”{('的“' + label + '”位置') if label else ''}背景上叠放等高人物参考的构图板，"
                    f"背景保持为一整张图，没有参与横向拼接。必须以 image1 的背景作为最终画面的背景和空间透视来源。{anchor_rule}"
                    f"人物身份位置绑定：{'；'.join(character_bindings)}。"
                    "image1 中等高排列的人物只用于锁定对应角色的脸型、五官、发色、头饰、服装配色、体型和身份；"
                    "不要复制人物透明边缘、裁切框、卡片边界或人物参考排版。"
                    "image1 是参考资料板，不是最终画面成品；最终画面严禁生成截图式拼贴、多面板、分栏、画中画或人物参考卡。"
                    "每个名字只允许在最终画面中出现一次，不要把同一角色的大头照、正面、背面、侧面或多张参考姿态同时画出来。"
                    "最终画面必须把所有引用人物重新画进第一块背景环境里，人物动作、坐姿、举杯、背靠和互动关系服从原始文字描述。"
                    "这里的左/右一律以观众看最终画面时的屏幕坐标为准，不是角色自身左右，也不是镜像后的左右；严禁左右镜像、严禁交换人物。"
                    "最终构图必须保留背景空间，人物不要遮挡大部分背景；人物必须是自然完整的人体结构。"
                )
            else:
                prompt_lines.append(
                    f"参考图使用规则：image1 是人物与场景的合成构图参考，"
                    f"必须按 image1 中{' 和 '.join(character_parts)}的身份、左右站位、人物比例和背景空间生成。"
                    f"人物身份位置绑定：{'；'.join(character_bindings)}。"
                    f"{anchor_rule}"
                    "这里的左/右一律以观众看最终画面时的屏幕坐标为准，不是角色自身左右，也不是镜像后的左右；"
                    "严禁左右镜像、严禁交换两个人的位置。"
                    "后续所有表情、视线、手部动作和台词都必须按这个姓名绑定执行；"
                    "如果原文写某个名字在笑、看、拿、说话，只允许该名字对应的位置人物执行，禁止把动作转移给另一侧人物。"
                    "image2 是场景库按标注位置裁切的干净背景参考，必须作为最终画面的真实背景和主要空间来源；"
                    "保留 image2 的空间结构、透视、光线、建筑轮廓、地面和主要物件位置。"
                    "人物只能作为前景角色放入 image2，默认使用正面全身比例；除非原提示明确写大头照、头像、特写、近景，否则不要放大成半身或大头。"
                    "如果后续还有单独人物参考图，必须用它们校准人物脸型、胡须、发型、服饰配色和身份特征。"
                    "不要把透明预览底色、裁切边缘或人物参考图背景当作最终背景。"
                    "最终构图必须给背景留出足够可见空间，人物不要铺满画面、不要遮挡大部分背景，人物总占画面高度不超过约 65%。"
                    "人物必须重新绘制成自然完整的人体结构，保持头颈肩、躯干、手臂、手指、腿部比例正常；"
                    "不要把参考板中的人物贴片边缘、透明裁切轮廓、压扁或拉长的身体形状复制到最终画面。"
                )
            if identity_names:
                prompt_lines.append(
                    f"image3 是人物身份参考板，包含 {'、'.join(identity_names)}；"
                    "只用于校准脸型、五官、发色、头饰、服装配色和身份，不用于决定站姿、半身裁切、背景或动作。"
                    "最终动作、坐姿、举杯、人物左右位置和场景透视必须服从 image1 与文字描述。"
                )
        else:
            anchor_rule = f"最终画面的主要空间必须围绕“{label}”这个标注点，不要漂移到同一场景其它未指定物品旁边。" if label else ""
            prompt_lines.append(
                f"参考图使用规则：image1 是场景库“{display}”{('的“' + label + '”位置') if label else ''}背景参考，"
                f"必须优先作为最终画面的背景使用。{anchor_rule}"
            )
    if not reference_images:
        return prompt_text, None, False
    tensor = _pil_list_to_reference_tensor(reference_images)
    if prompt_lines:
        prompt_text = f"{prompt_text}\n\n场景库参考要求：\n" + "\n".join(prompt_lines)
    return prompt_text, tensor, consumed_characters


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


def _resolved_character_refs(
    prompt_text: str,
    storyboard_refs: list[tuple[str, str]],
    allow_storyboard_context: bool = True,
) -> list[tuple[str, str]]:
    refs = _extract_character_refs(prompt_text)
    if allow_storyboard_context and not refs and _prompt_mentions_multi_person(prompt_text) and storyboard_refs:
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
        hint = _position_hint_near_reference(source, match.start(), match.end())
        if not hint:
            continue
        key = name.casefold()
        hints[key] = hint
        if view:
            hints[(name + "/" + view).casefold()] = hint
    return hints


def _position_hint_near_reference(source: str, start: int, end: int) -> str:
    before = _safe_text(source[max(0, start - 32) : start]).casefold()
    after = _safe_text(source[end : min(len(source), end + 32)]).casefold()
    nearby = f"{before} @ {after}"
    markers: list[tuple[int, str]] = []
    for keyword in LEFT_KEYWORDS + LEFT_LABEL_KEYWORDS:
        key = keyword.casefold()
        for text, offset in ((before, 0), (after, len(before) + 3)):
            pos = text.rfind(key)
            if pos >= 0:
                markers.append((offset + pos, "left"))
    for keyword in RIGHT_KEYWORDS + RIGHT_LABEL_KEYWORDS:
        key = keyword.casefold()
        for text, offset in ((before, 0), (after, len(before) + 3)):
            pos = text.rfind(key)
            if pos >= 0:
                markers.append((offset + pos, "right"))
    if not markers:
        return ""
    reference_pos = len(before) + 1
    _distance, hint = min(((abs(pos - reference_pos), hint) for pos, hint in markers), key=lambda item: item[0])
    if re.search(r"(?:左手|右手|左眼|右眼|左脸|右脸|左肩|右肩|左臂|右臂|左腿|右腿)", nearby):
        side_words = re.search(r"(?:画面|镜头|构图|站位|位置|左侧|右侧|左边|右边|left|right)", nearby, flags=re.IGNORECASE)
        if not side_words:
            return ""
    return hint


def _character_layout_lines(characters: list[tuple[str, dict[str, Any]]], position_hints: dict[str, str] | None = None) -> list[str]:
    if len(characters) <= 1:
        return []
    positions = {
        "far_left": ("画面最左侧区域", "右侧人物不得覆盖该角色"),
        "left": ("画面左侧 1/3 区域", "右侧不要挤占该角色位置"),
        "left_center": ("画面左中区域", "左右相邻人物不得覆盖该角色"),
        "right": ("画面右侧 1/3 区域", "左侧不要挤占该角色位置"),
        "right_center": ("画面右中区域", "左右相邻人物不得覆盖该角色"),
        "far_right": ("画面最右侧区域", "左侧人物不得覆盖该角色"),
        "center": ("画面中间 1/3 区域", "左右两侧用场景、道具、光影或背景空间自然填充"),
    }
    default_order = _character_default_slots(len(characters))
    used: set[str] = set()
    assigned: list[str] = []
    hints = position_hints or {}
    for name, _character in characters:
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
    lines.append("以下站位是硬约束，以观众看到的最终画面坐标为准，不是人物自身左右；禁止交换左右位置，禁止因为参考图构图改变站位。")
    for index, (name, character) in enumerate(characters):
        display_name = _character_display_name(character, name)
        position, fill_rule = positions[assigned[index]]
        lines.append(f"{index + 1}. {display_name} 必须固定在{position}；{fill_rule}。")
    if len(characters) > 3:
        lines.append("所有上述角色都是本格明确引用人物，最终画面必须全部出现；不要把第 4 个及之后的人物省略成背景路人。")
    return lines


def _character_prompt_and_reference(
    prompt_text: str,
    storyboard_refs: list[tuple[str, str]] | None = None,
    contain_reference_images: bool = False,
    first_reference_image_index: int = 1,
    include_reference_images: bool = True,
    qwen_reference_binding: bool = False,
    max_reference_images: int | None = None,
    allow_storyboard_context: bool = True,
    reference_width: int = 1024,
    reference_height: int = 768,
) -> tuple[str, torch.Tensor | None]:
    refs = _resolved_character_refs(prompt_text, storyboard_refs or [], allow_storyboard_context=allow_storyboard_context)
    if not refs:
        return prompt_text, None
    prompt_lines: list[str] = []
    images: list[Image.Image] = []
    resolved_characters: list[tuple[str, dict[str, Any]]] = []
    qwen_bindings: list[str] = []
    image_slot = max(1, int(first_reference_image_index or 1))
    remaining_reference_images = None if max_reference_images is None else max(0, int(max_reference_images or 0))
    grouped_refs = _group_character_refs(refs)
    qwen_multi_character = bool(qwen_reference_binding and len(grouped_refs) > 1)
    reference_tensor_override: torch.Tensor | None = None
    qwen_direct_limit = 0 if remaining_reference_images is None else remaining_reference_images
    if (
        include_reference_images
        and qwen_reference_binding
        and 0 < len(grouped_refs) <= max(0, int(qwen_direct_limit or 0))
    ):
        direct_boards = _make_qwen_direct_character_reference_boards(
            prompt_text,
            refs,
            reference_width,
            reference_height,
                max_boards=int(qwen_direct_limit or 0),
        )
        if direct_boards and len(direct_boards) == len(grouped_refs):
            reference_tensor_override = _pil_list_to_reference_tensor([board for _display_name, board in direct_boards])
            for name, _explicit_views in grouped_refs:
                character = _find_character(name)
                if character:
                    resolved_characters.append((name, character))
            for offset, (display_name, _board) in enumerate(direct_boards, start=image_slot):
                prompt_lines.append(
                    f"{display_name}：image{offset} 是“{display_name}”的角色参考拼图，只用于锁定脸型、五官、发色、头饰、服装配色、体型、正反侧面和身份；"
                    "可以包含大头照和多张等高全身参考；不要复制参考拼图白底、半身裁切、站姿、多视图排版或原背景。"
                )
                qwen_bindings.append(
                    f"- image{offset} = character \"{display_name}\" ONLY. Use this single-character reference collage for identity, face, hair, clothing colors, body shape and side/back details; do not use its background, crop, pose or multi-view layout as final composition."
                )
            if remaining_reference_images is not None:
                remaining_reference_images -= len(direct_boards)
            image_slot += len(direct_boards)
            grouped_refs = []
            qwen_multi_character = False
    if (
        include_reference_images
        and qwen_reference_binding
        and len(grouped_refs) > 3
        and (remaining_reference_images is None or remaining_reference_images > 0)
    ):
        board, board_characters, position_lines = _make_multi_character_full_body_board(
            prompt_text,
            grouped_refs,
            reference_width,
            reference_height,
        )
        if board is not None and board_characters:
            reference_tensor_override = _pil_list_to_reference_tensor([board])
            resolved_characters.extend(board_characters)
            image_ref = f"image{image_slot}"
            role_names = "、".join(_character_display_name(character, name) for name, character in board_characters)
            prompt_lines.append(
                f"{image_ref} 是本格所有人物的全身站位参考板，包含 {role_names}。"
                "参考板只用于锁定每个人的身份、服装、体型、正反面和从左到右的位置关系；"
                "不要照搬白底，不要生成参考板边框，不要把人物拆成重复身体。"
            )
            prompt_lines.append(
                "多人物位置硬约束："
                + "；".join(position_lines)
                + "。最终画面必须保持这个从左到右的顺序；左/右以观众看到的最终画面屏幕坐标为准，禁止镜像或交换人物。"
            )
            qwen_bindings.append(
                f"- {image_ref} = multi-character full-body lineup board. Left-to-right order is: "
                + ", ".join(_character_display_name(character, name) for name, character in board_characters)
                + ". Each person in this board is a different named character; preserve every identity and do not swap positions."
            )
            if remaining_reference_images is not None:
                remaining_reference_images -= 1
            image_slot += 1
            grouped_refs = []
    for name, explicit_views in grouped_refs:
        character = _find_character(name)
        if not character:
            continue
        if remaining_reference_images is not None and remaining_reference_images <= 0:
            break
        resolved_characters.append((name, character))
        display_name = _character_display_name(character, name)
        primary_explicit_view = explicit_views[0] if explicit_views else ""
        notes = _safe_text(character.get("notes") or "").strip()
        if notes:
            prompt_lines.append(f"{display_name}：人物特色：{notes}")
        else:
            prompt_lines.append(f"{display_name}：保持该人物的五官、发型、服装配色和身份一致。")
        selected_view = _select_character_view(character, prompt_text, primary_explicit_view)
        character_images: list[Image.Image] = []
        if include_reference_images and qwen_multi_character:
            reference_view_roles = _single_character_reference_view(character, prompt_text, explicit_views)
        elif include_reference_images and explicit_views:
            reference_view_roles = _explicit_character_reference_views(character, explicit_views)
        else:
            reference_view_roles = _character_reference_views(character, prompt_text, primary_explicit_view) if include_reference_images else []
        for role, view in reference_view_roles:
            if remaining_reference_images is not None and remaining_reference_images <= 0:
                break
            image = _open_character_view(character, view)
            if image is None:
                continue
            character_images.append(image)
            if remaining_reference_images is not None:
                remaining_reference_images -= 1
            image_ref = f"image{image_slot}"
            view_label = _view_label(view)
            qwen_bindings.append(
                f"- {image_ref} = character \"{display_name}\" ONLY. Use this image to lock this exact person's identity, gender, age, hair, beard, headwear, clothing identity and facial features. Do not replace {display_name} with another person or a woman."
            )
            if role == "identity":
                prompt_lines.append(
                    f"{display_name}：{image_ref} 是“{display_name}”的身份锁定参考，只用于锁定五官、头部轮廓、发型、胡须、帽子/头盔、年龄感和神态；"
                    "最终画面的身体姿态、远近、左右位置和朝向必须服从本格文字描述，不要照搬这张身份图的头像裁切、背景或构图。"
                )
            elif role == "face":
                prompt_lines.append(
                    f"{display_name}：{image_ref} 是“{display_name}”的脸部特写/头像身份参考，只用于锁定五官、胡须、发型、年龄感和神态。"
                )
            else:
                prompt_lines.append(
                    f"{display_name}：{image_ref} 是“{display_name}”的全身/姿态/朝向参考，必须用于锁定头部轮廓、发型、胡须、帽子/头盔、服装配色、身形、站姿和{view_label or '当前视角'}。"
                )
            image_slot += 1
        if character_images:
            if _reference_wants_back(prompt_text, primary_explicit_view):
                prompt_lines.append(
                    f"{display_name}：本格是背面/背影/背对镜头视角，只参考该角色的背面或全身姿态图；不要把正脸头像、大头照或参考图里的第二个人拼进最终画面。"
                )
            else:
                if _reference_wants_closeup(prompt_text, primary_explicit_view):
                    prompt_lines.append(f"{display_name}：生成时必须同时参考该角色的大头身份图和全身姿态图；脸按大头图，身体和朝向按全身图。")
                else:
                    prompt_lines.append(
                        f"{display_name}：本格不是头像/特写，优先用身份参考图锁定人物身份；动作、站姿、远近、左右位置和朝向按本格文字执行，不要生成额外头像或第二个身体。"
                    )
        if explicit_views:
            labels_text = "、".join(f"“{label}”" for label in explicit_views)
            prompt_lines.append(
                f"{display_name}：本格已指定使用角色库视图 {labels_text} 作为同一人物的多参考图；"
                "这些参考图都属于同一个角色，只用于补充身份、服装、正反面和镜中可见信息，不要生成多个同名人物。"
            )
        if primary_explicit_view and selected_view is not None:
            view_index = _character_view_position(character, selected_view)
            view_label = _view_label(selected_view)
            orientation = _view_orientation_instruction(selected_view)
            if view_index:
                prompt_lines.append(
                    f"{display_name}：本格已通过 @{name}{primary_explicit_view} 指定使用角色库第 {view_index} 张参考图；"
                    f"{orientation}，不要自动改成正面。"
                )
            elif view_label:
                prompt_lines.append(
                    f"{display_name}：本格已通过 @{name}{primary_explicit_view} 指定使用“{view_label}”参考图；"
                    f"{orientation}，不要自动改成正面。"
                )
        images.extend(character_images)
    reference_tensor = (
        reference_tensor_override
        if reference_tensor_override is not None
        else (_make_character_reference_tensor(images, contain_images=contain_reference_images) if include_reference_images else None)
    )
    if prompt_lines:
        detail = "\n".join(prompt_lines)
        role_names = "、".join(_character_display_name(character, name) for name, character in resolved_characters)
        layout_lines = _character_layout_lines(resolved_characters, _character_position_hints(prompt_text))
        layout_text = f"\n多人默认站位：\n{chr(10).join(layout_lines)}" if layout_lines else ""
        qwen_binding_text = ""
        if qwen_reference_binding and qwen_bindings:
            qwen_binding_text = (
                "Qwen strict reference binding table:\n"
                + "\n".join(qwen_bindings)
                + "\nOnly the listed character identities are allowed as main people in the final image. Never swap identities between images. Never invent an extra man or woman. Keep each named character's gender, age, beard, hair, headwear and face from their own bound reference image.\n\n"
            )
        prompt_text = (
            f"{qwen_binding_text}{prompt_text}\n\n"
            f"角色库参考要求：本格涉及角色为 {role_names}。生成画面必须严格保持下列人物特色；如果原文写“两人/二人/双方”，默认指这些角色。不要把参考图的构图、背景或裁切直接照搬；忽略参考图里的透明棋盘格、灰白方格、透明背景预览、文字、标签、水印和说明字样，最终画面禁止出现这些内容。\n"
            f"最终画面只允许本格涉及的这些角色作为主要人物；参考图只用于身份、服装、姿态和朝向，不得把参考图里的头像裁切、第二个身体或多余人物复制进画面。\n"
            f"{detail}{layout_text}"
        )
    return prompt_text, reference_tensor


def _extract_costume_refs(text: str) -> list[tuple[str, str]]:
    refs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    source = _safe_text(text)
    for match in COSTUME_REF_RE.finditer(source):
        groups = match.groups()
        name = next((_safe_text(group).strip(" 　.,，;；。!！?？") for group in groups if group), "")
        if not name:
            continue
        category = "product" if (groups[4] or groups[5]) else ("prop" if (groups[2] or groups[3]) else "clothing")
        key = (category, name.casefold())
        if key in seen:
            continue
        seen.add(key)
        refs.append((name, category))
    for match in CHARACTER_REF_RE.finditer(source):
        name = _safe_text(match.group(1)).strip(" 　.,，;；。!！?？")
        if not name or _find_character(name):
            continue
        costume = _find_costume(name, "clothing") or _find_costume(name, "prop") or _find_costume(name, "product")
        if not costume:
            continue
        category = _safe_text(costume.get("category") or "clothing").strip().lower() or "clothing"
        key = (category, name.casefold())
        if key in seen:
            continue
        seen.add(key)
        refs.append((name, category))
    return refs


def _costume_asset_path(costume: dict[str, Any]) -> Path | None:
    paths = _costume_asset_paths(costume, 1)
    return paths[0] if paths else None


def _costume_asset_paths(costume: dict[str, Any], limit: int = 6) -> list[Path]:
    base = Path(_safe_text(costume.get("_dir"))).resolve()
    assets = costume.get("assets") if isinstance(costume.get("assets"), list) else []
    paths: list[Path] = []
    for asset in assets:
        file_name = _safe_text(asset.get("file") if isinstance(asset, dict) else "").strip()
        if not file_name:
            continue
        path = (base / file_name).resolve()
        try:
            if base not in path.parents or not path.is_file():
                continue
        except Exception:
            continue
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
            paths.append(path)
            if len(paths) >= max(1, int(limit or 1)):
                break
    return paths


def _open_costume_image(costume: dict[str, Any]) -> Image.Image | None:
    path = _costume_asset_path(costume)
    if path is None:
        return None
    try:
        image = Image.open(path).convert("RGBA")
    except Exception:
        return None
    background = Image.new("RGBA", image.size, (255, 255, 255, 255))
    background.alpha_composite(image)
    return background.convert("RGB")


def _open_costume_images(costume: dict[str, Any], limit: int = 6) -> list[Image.Image]:
    images: list[Image.Image] = []
    for path in _costume_asset_paths(costume, limit):
        try:
            image = Image.open(path).convert("RGBA")
        except Exception:
            continue
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        background.alpha_composite(image)
        images.append(background.convert("RGB"))
    return images


def _costume_prompt_and_reference(
    prompt_text: str,
    contain_reference_images: bool = False,
    first_reference_image_index: int = 1,
) -> tuple[str, torch.Tensor | None]:
    refs = _extract_costume_refs(prompt_text)
    if not refs:
        return prompt_text, None
    prompt_lines: list[str] = []
    images: list[Image.Image] = []
    image_slot = max(1, int(first_reference_image_index or 1))
    resolved_names: list[str] = []
    for name, category in refs[:6]:
        costume = _find_costume(name, category)
        if not costume:
            continue
        display = _safe_text(costume.get("name") or costume.get("id") or name).strip()
        item_category = _safe_text(costume.get("category") or category or "clothing").strip().lower() or "clothing"
        if item_category not in {"clothing", "prop", "product"}:
            item_category = "clothing"
        is_prop = item_category == "prop"
        is_product = item_category == "product"
        tags = "、".join(_safe_text(tag).strip() for tag in costume.get("tags") or [] if _safe_text(tag).strip())
        notes = _safe_text(costume.get("notes") or "").strip()
        resolved_names.append(display)
        detail = []
        if tags:
            detail.append(f"标签：{tags}")
        if notes:
            detail.append(f"备注：{notes}")
        item_images = _open_costume_images(costume, 6 if is_product else 1)
        if item_images:
            start_slot = image_slot
            images.extend(item_images)
            if is_product:
                end_slot = image_slot + len(item_images) - 1
                image_ref = f"image{start_slot}" if end_slot == start_slot else f"image{start_slot}-image{end_slot}"
                prompt_lines.append(f"{display}：对应产品多视图参考图为 {image_ref}，生成时必须采用这个产品的外观比例、主色、材质、结构、接口、按钮、包装/品牌感和关键部件；不同视图属于同一个产品，不要生成多个不同产品。")
            elif is_prop:
                prompt_lines.append(f"{display}：对应道具参考图为 image{image_slot}，生成时必须采用这个道具的形状、主色、材质、尺寸感和关键部件；按原文语义作为手持物、摆件或场景物品出现。")
            else:
                prompt_lines.append(f"{display}：对应服装参考图为 image{image_slot}，生成时必须采用这套服装的轮廓、主色、材质和关键部件。")
            image_slot += len(item_images)
        else:
            category_label = "产品" if is_product else ("道具" if is_prop else "服装")
            prompt_lines.append(f"{display}：按{category_label}库文字信息使用这个{category_label}。")
        if detail:
            prompt_lines.append(f"{display}：" + "；".join(detail))
    if not prompt_lines:
        return prompt_text, None
    reference_tensor = _make_character_reference_tensor(images, contain_images=contain_reference_images) if images else None
    role_text = "、".join(resolved_names)
    prompt_text = (
        f"{prompt_text}\n\n"
        f"服化道参考要求：本格调用服装/道具/产品为 {role_text}。服装参考只约束衣物/盔甲/配饰，不改变角色身份、五官和场景；道具参考只约束物品本身，不替换人物或背景；产品参考只约束产品本身的外观、比例、材质、功能部件和品牌感，不替换人物或背景；"
        "不要把参考图里的透明底、白底、裁切边缘、文字或水印画进最终画面。\n"
        + "\n".join(prompt_lines)
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


def _preview_image_directories() -> dict[str, Path]:
    directories: dict[str, Path] = {}
    try:
        directories["temp"] = Path(folder_paths.get_temp_directory()).resolve()
    except Exception:
        pass
    try:
        directories["input"] = Path(folder_paths.get_input_directory()).resolve()
    except Exception:
        pass
    try:
        directories["output"] = Path(folder_paths.get_output_directory()).resolve()
    except Exception:
        pass
    return directories


def _load_storyboard_preview_cells(preview_images: Any, cell_w: int, cell_h: int) -> dict[int, torch.Tensor]:
    text = _safe_text(preview_images).strip()
    if not text:
        return {}
    try:
        items = json.loads(text)
    except Exception:
        return {}
    if not isinstance(items, list):
        return {}
    directories = _preview_image_directories()
    loaded: dict[int, torch.Tensor] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            index = int(item.get("index") or 0)
        except Exception:
            continue
        if index <= 0:
            continue
        filename = _safe_text(item.get("filename")).replace("\\", "/").strip("/")
        subfolder = _safe_text(item.get("subfolder")).replace("\\", "/").strip("/")
        image_type = _safe_text(item.get("type"), "temp").strip().lower() or "temp"
        base = directories.get(image_type)
        if base is None or not filename:
            continue
        path = (base / subfolder / filename).resolve()
        try:
            if base != path and base not in path.parents:
                continue
            if not path.is_file():
                continue
            image = Image.open(path).convert("RGB")
            array = np.asarray(image).astype(np.float32) / 255.0
            tensor = torch.from_numpy(array).unsqueeze(0)
            loaded[index] = _normalize_storyboard_cell(tensor, cell_w, cell_h)
        except Exception:
            continue
    return loaded


def _load_recent_storyboard_preview_cells(cell_w: int, cell_h: int, expected_count: int) -> dict[int, torch.Tensor]:
    try:
        directory = (Path(folder_paths.get_temp_directory()) / PREVIEW_SUBFOLDER).resolve()
    except Exception:
        return {}
    if not directory.is_dir():
        return {}
    pattern = re.compile(r"^storyboard_[0-9a-f]+_(\d{3})\.png$", re.IGNORECASE)
    candidates: dict[int, Path] = {}
    mtimes: dict[int, float] = {}
    try:
        for path in directory.glob("storyboard_*.png"):
            match = pattern.match(path.name)
            if not match:
                continue
            index = int(match.group(1))
            if index <= 0 or index > max(1, int(expected_count or 1)):
                continue
            stat = path.stat()
            if stat.st_mtime >= mtimes.get(index, 0.0):
                candidates[index] = path
                mtimes[index] = stat.st_mtime
    except Exception:
        return {}
    loaded: dict[int, torch.Tensor] = {}
    for index, path in candidates.items():
        try:
            image = Image.open(path).convert("RGB")
            array = np.asarray(image).astype(np.float32) / 255.0
            tensor = torch.from_numpy(array).unsqueeze(0)
            loaded[index] = _normalize_storyboard_cell(tensor, cell_w, cell_h)
        except Exception:
            continue
    return loaded


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
        "scenes": _scene_library_signature(),
        "costumes": _costume_library_signature(),
    }
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _lazy_optional_images(scene: Any, reference: Any, width: int, height: int, fit_reference: bool = False) -> dict[str, torch.Tensor]:
    resize = _resize_fit_reference if fit_reference else _resize_crop_short_edge
    scene_images = [resize(image, width, height) for image in _split_media(scene)]
    reference_images = [resize(image, width, height) for image in _split_media(reference)]
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


def _media_slice(value: Any, limit: int) -> list[torch.Tensor] | None:
    count = max(0, int(limit or 0))
    if count <= 0:
        return None
    items = _split_media(value)[:count]
    return items or None


def _append_scene_reference_prompt(prompt_text: str, scene_count: int) -> str:
    if int(scene_count or 0) <= 0:
        return prompt_text
    scene_ref = "image1" if scene_count == 1 else f"image1-image{int(scene_count)}"
    return (
        f"{prompt_text}\n\n"
        f"场景背景参考要求：{scene_ref} 是本格的背景/环境/地貌/光线参考，必须优先作为最终画面的背景使用。"
        "人物和动作只能发生在这个场景背景中；即使原提示是比武、打斗、对峙、奔跑或交谈，也必须保留这个背景。"
        "不要丢掉背景，不要改成纯色、空白、室内、雪地、庭院、擂台、角色图自带背景或无关环境。"
    )


def _image_ref_range(start_index: int, count: int) -> str:
    start = max(1, int(start_index or 1))
    total = max(0, int(count or 0))
    if total <= 0:
        return ""
    if total == 1:
        return f"image{start}"
    return f"image{start}-image{start + total - 1}"


def _append_plain_reference_prompt(
    prompt_text: str,
    reference_start_index: int,
    reference_count: int,
    has_scene_background: bool,
) -> str:
    ref = _image_ref_range(reference_start_index, reference_count)
    if not ref:
        return prompt_text
    if has_scene_background:
        return (
            f"{prompt_text}\n\n"
            f"补充参考图要求：{ref} 是本格的补充视觉参考，只用于借鉴构图、动作、道具、服饰细节、光影、色调或画面气质；"
            "不得替代已经指定的场景背景，不得把补充参考图的完整背景、无关人物或多余主体复制进最终画面。"
        )
    return (
        f"{prompt_text}\n\n"
        f"补充参考图要求：{ref} 是本格的主要视觉参考，可用于确定构图、环境氛围、动作、道具、服饰细节、光影和色调；"
        "如果提示词另有明确人物或场景要求，以提示词为准，不要复制参考图中的无关人物或多余主体。"
    )


def _normalize_strength(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except Exception:
        return float(fallback)


def _normalize_model_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", _safe_text(value).casefold())


def _is_next_scene_image_edit_unet(unet_name: Any) -> bool:
    text = _normalize_model_text(unet_name)
    return (("qwen" in text or "firered" in text) and "image" in text and "edit" in text)


def _is_flux_storyboard_unet(unet_name: Any) -> bool:
    text = _normalize_model_text(unet_name)
    return "flux" in text or "f2k" in text or "klein" in text


def _prefix_next_scene_prompt(prompt_text: str, unet_name: Any) -> str:
    text = _safe_text(prompt_text).strip()
    if not _is_next_scene_image_edit_unet(unet_name):
        return text
    if text.startswith(NEXT_SCENE_PROMPT_PREFIX):
        return text
    return f"{NEXT_SCENE_PROMPT_PREFIX}\n{text}"


def _resolve_model_by_keywords(models: list[Any], keywords: tuple[str, ...], fallback: Any) -> Any:
    choices = [str(item) for item in (models or []) if str(item or "").strip()]
    if not choices:
        return fallback
    fallback_text = _safe_text(fallback).strip()
    if fallback_text in choices:
        fallback_value = fallback_text
    else:
        fallback_value = choices[0]
    for keyword in keywords:
        wanted = _normalize_model_text(keyword)
        if not wanted:
            continue
        for item in choices:
            if wanted in _normalize_model_text(item):
                return item
    return fallback_value


def _ensure_next_scene_image_edit_clip_vae(unet_name: Any, clip_name1: Any, vae_name: Any) -> tuple[Any, Any]:
    text = _normalize_model_text(unet_name)
    if not ("firered" in text and "image" in text and "edit" in text):
        return clip_name1, vae_name
    clip_name1 = _resolve_model_by_keywords(
        _list_lazy_clip_models(),
        ("qwen_2.5_vl", "qwen25vl", "qwen"),
        clip_name1,
    )
    vae_name = _resolve_model_by_keywords(
        list_vae_models(),
        ("qwen_image_vae", "qwenimagevae", "qwen"),
        vae_name,
    )
    return clip_name1, vae_name


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


def _storyboard_lora_choices(default_unet_name: Any = "") -> tuple[list[str], str]:
    try:
        loras = [str(item) for item in folder_paths.get_filename_list("loras") if str(item or "").strip()]
    except Exception:
        loras = []
    choices = [STORYBOARD_LORA_NONE]
    choices.extend(item for item in loras if not re.search(r"(flux|f2k)", item, re.IGNORECASE))
    default = STORYBOARD_LORA_NONE
    if _is_next_scene_image_edit_unet(default_unet_name):
        default = _resolve_storyboard_lora_name("next-scene")
        if default and default not in choices:
            choices.insert(1, default)
    elif _is_flux_storyboard_unet(default_unet_name):
        default = _resolve_storyboard_lora_name(FLUX_STORYBOARD_LORA)
        if default and default not in choices:
            choices.insert(1, default)
    return choices, default if default in choices else STORYBOARD_LORA_NONE


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
    if _is_next_scene_image_edit_unet(unet_name):
        _append_lora_row(rows, NEXT_SCENE_LORA, 1.0)
    elif _is_flux_storyboard_unet(unet_name):
        _append_lora_row(rows, FLUX_STORYBOARD_LORA, 1.0)
    return json.dumps(rows, ensure_ascii=False) if rows else "[]"


def _ensure_next_scene_lora_data(lora_data: Any, unet_name: Any) -> str:
    text = _safe_text(lora_data).strip()
    try:
        rows = json.loads(text) if text else []
    except Exception:
        rows = []
    if not isinstance(rows, list):
        rows = []
    rows = [row for row in rows if isinstance(row, dict)]
    if _is_next_scene_image_edit_unet(unet_name):
        _append_lora_row(rows, NEXT_SCENE_LORA, 1.0)
    return json.dumps(rows, ensure_ascii=False) if rows else "[]"


class GJJ_StoryboardGridGenerator:
    CATEGORY = "GJJ/Image"
    FUNCTION = "generate"
    DESCRIPTION = "分镜宫格生成器：复用懒人图文集成一键生图流程，正向提示词按场景行首标记、空行或 --- 分段生成，并智能拼接为宫格图。"
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
        "title": "GJJ 分镜宫格生成器",
        "description": DESCRIPTION,
        "model_tree": True,
        "dynamic_model_tree_only": True,
        "notice": (
            "【正向提示词分段方法】\n"
            "每个分段生成一张分镜图片，完成后按“宫格布局”自动拼接。\n\n"
            "1. 推荐格式：每段第一行以非空方括号 [...] 开头。\n"
            "方括号内容不限，例如 [1]、[场景1]、[镜头 2]、[A]、[近景]；"
            "标记后可直接写描述，也可加冒号、短横线或破折号。\n"
            "示例：\n"
            "[场景1] 清晨的车站，女孩站在月台等待\n"
            "[2]：列车驶入车站，风吹动女孩的头发\n"
            "[近景] - 女孩登上列车，回头看向月台\n\n"
            "2. 标记可单独占一行；后续没有新行首方括号的非空行，会自动续接到当前分镜。\n"
            "示例：\n"
            "[第一格]\n"
            "夜晚的城市街道\n"
            "霓虹灯倒映在雨后的路面\n"
            "人物从画面右侧走入\n\n"
            "3. 兼容格式：无方括号时仍支持 Scene 1: 描述、Shot 2: 描述、镜头3：描述、"
            "分镜4 标题 :: 描述。\n\n"
            "4. 无场景行首标记时：可用空行或单独一行 --- 分隔段落。\n\n"
            "【注意】只要一行开头出现非空 [...]，就会被识别为新分镜标记；"
            "方括号之前只能有空白字符。标记之前的文字不会成为分镜，"
            "方括号标记本身只用于分段，不会写入最终生图提示词。\n\n"
            "【断点续生成】生成过程中如被取消或中断，再次执行时会保留已经完成的格子，"
            "自动跳过已有图片并只生成缺失格；提示词或关键生成参数改变后会建立新缓存。\n\n"
            "【参数浮窗】📐 管理尺寸、宫格与缩放参数；🧠 管理主模型、精度、CLIP、VAE 与 LoRA；"
            "⚙️ 管理其余生成参数。浮窗默认紧贴节点下方，拖动标题栏可移动并记住位置；"
            "三个浮窗互斥且不占节点主体空间。右上角“确定”保存修改，“取消”放弃修改，"
            "两者都会关闭当前浮窗。🧠 中“保持模型”开启后会保留模型、CLIP 和 VAE，"
            "加速连续生成但继续占用显存；主面板 🧠 按钮会以紫色底色和亮色边框提示开启状态。\n"
            "切换 UNET 主模型时，CLIP、VAE 与 LoRA 会按模型族关键词筛选候选列表，"
            "并优先选择名称含 int4_convrot 的匹配模型。主模型同时命中 qwen、image、edit、2511 "
            "时，LoRA 会强制选择同时命中 next、scene、lora、v2、3000 的候选项。"
            "🧠 使用与 GJJ_LazyImageStudio 相同的模型目录树，按 models/diffusion_models、"
            "models/text_encoders、models/vae、models/loras 显示所在目录；点击模型行展开顶部带"
            "模糊关键词框的候选列表，多个关键词用空格分隔时需全部命中，📋 可复制模型名称。"
        ),
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
        default_unet_name = _preferred_default(diffusion_models, DEFAULT_UNET_NAME)
        clip_models = _list_lazy_clip_models() or [DEFAULT_CLIP_NAME]
        vae_models = list_vae_models() or [DEFAULT_VAE_NAME]
        lora_models, default_storyboard_lora = _storyboard_lora_choices(default_unet_name)
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "✨ 正向提示词",
                        "tooltip": "行首任意非空 [...] 都会开始一个新分镜；也支持空行、单独一行 --- 或 Scene/镜头格式。每段生成一张分镜图片。",
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
                    {
                        "default": default_unet_name,
                        "display_name": "🟣 UNET 主模型",
                        "hidden": True,
                        "display": "hidden",
                    },
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
                "storyboard_preview_images": (
                    "STRING",
                    {"default": "[]", "multiline": False, "display_name": "分镜预览缓存", "hidden": True, "display": "hidden"},
                ),
                "storyboard_lora_name": (
                    lora_models,
                    {
                        "default": default_storyboard_lora,
                        "display_name": "🟢 LoRA",
                        "tooltip": "可选单行 LoRA。主模型为 qwen-image-edit / firered-image-edit 时默认选择名称匹配 next-scene 的 LoRA；flux/f2k/klein 时默认选择名称匹配 f2k_9B_lcs_consist 的 LoRA。",
                    },
                ),
                "keep_model_loaded": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "🧠 保持模型",
                        "tooltip": "开启后执行结束不主动释放当前模型、CLIP 和 VAE，加速连续生成；会继续占用相应显存。",
                    },
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
            + "|scenes="
            + _scene_library_signature()
            + "|costumes="
            + _costume_library_signature()
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
        storyboard_preview_images="[]",
        storyboard_lora_name="",
        keep_model_loaded=False,
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
        storyboard_preview_images = _first_scalar(storyboard_preview_images)
        storyboard_lora_name = _first_scalar(storyboard_lora_name)
        keep_model_loaded = _parse_bool(_first_scalar(keep_model_loaded), False)
        unique_id = _first_scalar(unique_id)
        clip_name1, vae_name = _ensure_next_scene_image_edit_clip_vae(unet_name, clip_name1, vae_name)
        if not _has_configured_lora_data(lora_data):
            lora_data = _preset_lora_data(unet_name)
        else:
            lora_data = _ensure_next_scene_lora_data(lora_data, unet_name)
        if _safe_text(storyboard_lora_name).strip():
            try:
                rows = json.loads(_safe_text(lora_data).strip() or "[]")
            except Exception:
                rows = []
            if not isinstance(rows, list):
                rows = []
            rows = [row for row in rows if isinstance(row, dict)]
            _append_lora_row(rows, storyboard_lora_name, 1.0)
            lora_data = json.dumps(rows, ensure_ascii=False) if rows else "[]"

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
        resume_missing_indices: set[int] = set()
        if not force_generate_all and not single_cell_mode and not selected_cell_mode:
            cached_count_before_preview = sum(1 for item in stitched_cells if isinstance(item, torch.Tensor))
            preview_cells = _load_storyboard_preview_cells(storyboard_preview_images, cell_w, cell_h)
            recent_preview_cells = _load_recent_storyboard_preview_cells(cell_w, cell_h, geometry_count)
            if preview_cells or cached_count_before_preview > 0 or len(recent_preview_cells) >= geometry_count:
                for preview_index, preview_cell in recent_preview_cells.items():
                    preview_cells.setdefault(preview_index, preview_cell)
            if preview_cells:
                for preview_index, preview_cell in preview_cells.items():
                    if 1 <= preview_index <= geometry_count and not isinstance(cached_cells.get(preview_index), torch.Tensor):
                        cache["cells"][int(preview_index)] = preview_cell.detach().contiguous()
                cached_cells = cache.get("cells", {}) if isinstance(cache.get("cells"), dict) else {}
                stitched_cells = [cached_cells.get(index) for index in range(1, geometry_count + 1)]
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
                resume_missing_indices = {
                    index for index, item in enumerate(stitched_cells, start=1) if not isinstance(item, torch.Tensor)
                }
                missing_text = "、".join(str(index) for index in sorted(resume_missing_indices))
                _send_status(
                    unique_id,
                    f"检测到断点缓存 {cached_count}/{geometry_count}，继续生成第 {missing_text} 格。",
                )
            else:
                _send_status(unique_id, "缓存为空，下游首次请求自动生成完整分镜。")
        storyboard_character_refs = _storyboard_character_context(prompts)
        is_next_scene_image_edit = _is_next_scene_image_edit_unet(unet_name)
        is_flux_storyboard = _is_flux_storyboard_unet(unet_name)
        generated: list[torch.Tensor] = []
        generated_positions: list[int] = []
        if selected_cell_mode:
            _send_status(unique_id, f"准备生成选中分镜 {len(prompts)} 张 / 共 {preview_total} 格...")
        elif single_cell_mode:
            _send_status(unique_id, f"准备生成单格分镜 {single_cell_index}/{preview_total}...")
        elif resume_missing_indices:
            _send_status(unique_id, f"断点续生成 {len(resume_missing_indices)} 张 / 共 {preview_total} 格...")
        else:
            _send_status(unique_id, f"准备生成 {len(prompts)} 张分镜图片...")

        for index, line in enumerate(prompts, start=1):
            if selected_cell_mode:
                preview_index = selected_indices[index - 1]
            else:
                preview_index = seed_offset + index if single_cell_mode else index
            if resume_missing_indices and preview_index not in resume_missing_indices:
                continue
            line, library_scene_reference, scene_consumed_characters = _scene_reference_tensor_for_prompt(
                line,
                cell_w,
                cell_h,
                compose_character_references=is_next_scene_image_edit or is_flux_storyboard,
                include_identity_reference_board=is_next_scene_image_edit,
                use_direct_character_references=is_next_scene_image_edit,
            )
            scene_source = None if library_scene_reference is not None else scene
            if is_next_scene_image_edit and library_scene_reference is None:
                scene_source = _media_slice(scene_source, 1)
            library_scene_reference_count = _media_count(library_scene_reference)
            scene_reference_count = _media_count(scene_source)
            character_refs_for_limits = _resolved_character_refs(
                line,
                storyboard_character_refs,
                allow_storyboard_context=not is_next_scene_image_edit,
            )
            image_edit_reference_slots = 3 - scene_reference_count - library_scene_reference_count - len(character_refs_for_limits)
            effective_reference = reference
            if is_next_scene_image_edit:
                effective_reference = _media_slice(reference, max(0, image_edit_reference_slots))
            reference_count = _media_count(effective_reference)
            plain_reference_count = reference_count + library_scene_reference_count
            reference_start = scene_reference_count + library_scene_reference_count + 1
            character_reference_start = scene_reference_count + plain_reference_count + 1
            character_reference_limit = None
            if is_next_scene_image_edit:
                character_reference_limit = max(0, 3 - scene_reference_count - library_scene_reference_count - reference_count)
            if library_scene_reference is None:
                line = _append_scene_reference_prompt(line, scene_reference_count)
            if reference_count:
                line = _append_plain_reference_prompt(
                    line,
                    reference_start,
                    reference_count,
                    scene_reference_count > 0 or library_scene_reference_count > 0,
                )
            line, character_reference = _character_prompt_and_reference(
                line,
                storyboard_character_refs,
                contain_reference_images=is_next_scene_image_edit,
                first_reference_image_index=character_reference_start,
                include_reference_images=not scene_consumed_characters,
                qwen_reference_binding=is_next_scene_image_edit,
                max_reference_images=character_reference_limit,
                allow_storyboard_context=not is_next_scene_image_edit,
                reference_width=cell_w,
                reference_height=cell_h,
            )
            character_reference_count = _media_count(character_reference)
            costume_reference_start = character_reference_start + character_reference_count
            remaining_image_edit_slots = 3 - scene_reference_count - library_scene_reference_count - reference_count - character_reference_count
            include_costume_reference = not is_next_scene_image_edit or remaining_image_edit_slots > 0
            if include_costume_reference:
                line, costume_reference = _costume_prompt_and_reference(
                    line,
                    contain_reference_images=is_next_scene_image_edit,
                    first_reference_image_index=costume_reference_start,
                )
                if is_next_scene_image_edit:
                    costume_reference = _media_slice(costume_reference, remaining_image_edit_slots)
            else:
                costume_reference = None
            line = _prefix_next_scene_prompt(line, unet_name)
            line = f"{line}\n\n{CELL_BLEED_PROMPT}"
            combined_reference_parts = []
            if library_scene_reference is not None:
                combined_reference_parts.append(library_scene_reference)
            if effective_reference is not None:
                combined_reference_parts.append(effective_reference)
            if character_reference is not None:
                combined_reference_parts.append(character_reference)
            if costume_reference is not None:
                combined_reference_parts.append(costume_reference)
            combined_reference = combined_reference_parts if combined_reference_parts else None
            refs = _lazy_optional_images(scene_source, combined_reference, cell_w, cell_h, fit_reference=is_next_scene_image_edit)
            if is_next_scene_image_edit:
                _write_debug_reference_images(unique_id, preview_index, refs)
            storyboard_main_image_index = 1 if refs.get("image_01") is not None else main_image_index
            if is_next_scene_image_edit:
                image_edit_total_refs = scene_reference_count + library_scene_reference_count + reference_count + character_reference_count + _media_count(costume_reference)
                image_edit_parts = []
                if scene_reference_count:
                    image_edit_parts.append(f"外部场景×{scene_reference_count}")
                if library_scene_reference_count:
                    image_edit_parts.append(f"场景库×{library_scene_reference_count}")
                if reference_count:
                    image_edit_parts.append(f"外部参考×{reference_count}")
                if character_reference_count:
                    image_edit_parts.append(f"角色库×{character_reference_count}")
                if costume_reference is not None:
                    costume_count = _media_count(costume_reference)
                    if costume_count:
                        image_edit_parts.append(f"服装道具×{costume_count}")
                _send_status(unique_id, f"ImageEdit 实际参考图 {image_edit_total_refs}/3：{'，'.join(image_edit_parts) if image_edit_parts else '无'}")
                _write_debug_final_prompt(unique_id, preview_index, line, negative_prompt)
            _send_status(unique_id, f"按懒人一键生图流程生成分镜 {preview_index}/{preview_total}")
            result = self._lazy.create_image(
                prompt=line,
                negative_prompt=negative_prompt,
                main_image_index=storyboard_main_image_index,
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
                force_empty_latent_reference=is_next_scene_image_edit,
                keep_model_loaded=keep_model_loaded,
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
