from __future__ import annotations

import math
import re
from typing import Any

import comfy.utils
import torch
from comfy_extras.nodes_custom_sampler import CFGGuider, KSamplerSelect, RandomNoise, SamplerCustomAdvanced
from comfy_extras.nodes_flux import EmptyFlux2LatentImage, Flux2Scheduler
from nodes import VAEDecode, VAEEncode

from .common_utils.flux2_tools import (
    gjjutils_append_reference_latent,
    gjjutils_encode_text,
    gjjutils_zero_out_conditioning,
)
from .common_utils.model_loader import (
    DEFAULT_UNET_DTYPE,
    gjjutils_load_clip_from_names as _load_clip_from_names,
    gjjutils_load_model as _load_model,
    gjjutils_load_vae as _load_vae,
)
from .common_utils.text_tools import gjjutils_normalize_text as _normalize_text
from .common_utils.text_tools import gjjutils_pick_available_name as _pick_available_name
from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .gjj_model_bundle_loader import list_clip_models, list_unet_models, list_vae_models


NODE_NAME = "GJJ_ReferenceGridGenerator"
MEDIA_INPUT_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE,VIDEO"
MIXED_IMAGE_OUTPUT = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"

DEFAULT_UNET = "flux-2-klein-4b-fp8.safetensors"
DEFAULT_CLIP = "qwen_3_8b_fp8mixed.safetensors"
DEFAULT_VAE = "flux2-vae.safetensors"
DEFAULT_PROMPT = """**左上（人物）：**一位肤色温暖的年轻亚裔女性。她深色的头发中分，编成两条长辫子垂在胸前。她身穿橄榄绿短袖T恤、卡其色工装裤、深棕色登山靴，左臂戴着黑色手表。她表情严肃而自然。

**右上（道具 - 背包）：**一个结实耐用的蓝色大型登山背包。背包外部有银色金属框架，多个侧面和顶部口袋，黑色可调节肩带，底部附近有一块棕色皮革方片。

---
**左中（道具 - 手杖）：**一根简单粗壮的天然木制手杖，树皮纹理粗糙，一端略微分叉或结节。

**右中（人物/动物 - 牦牛）：**一头体型庞大、健壮的牦牛，长着蓬松的白色和金色长毛，以及弯曲的灰色犄角。它身披华丽的鞍毯，毯子上饰有精美的蓝、红、黄三色图案，鞍上配有金属马镫。五彩缤纷的流苏垂挂在它的耳朵和胸前。

**左下（场景 - 风景）：**壮丽辽阔的山景。一条泥路蜿蜒穿过绿意盎然的岩石山坡，通往远处巍峨耸立、白雪皑皑的山峰，头顶是湛蓝的天空，点缀着朵朵白云。

**右下（场景 - 建筑）：**一座小巧的传统方形石砌建筑（神社或寺庙）。它有着平坦略微倾斜的屋顶，屋檐下垂着明亮的黄色布幔。窗户饰有亮蓝色边框，木门漆成红色。旁边矗立着一座小小的石塔。"""
DEFAULT_NEGATIVE = "low quality, blurry, text, watermark, logo, cropped, deformed"
LAYOUT_MODES = ("自动", "1列", "2列", "3列", "4列", "5列", "6列", "2x3", "3x2")
GENERATION_MODES = ("自动", "文生图", "图生图", "只拼图")
FIT_MODES = ("智能", "完整留白", "铺满裁切")
UPSCALE_METHODS = ("lanczos", "bicubic", "bilinear", "nearest-exact", "area")
SIZE_ALIGN_MODES = ("LTX/Flux2 64倍数", "LTX 32倍数", "关闭")

_MODEL_CACHE: dict[tuple[str, str, str], tuple[Any, Any, Any]] = {}


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync("gjj_node_progress", {"node": str(unique_id), "text": str(text or "")})
    except Exception:
        pass


def _contains_any(text: str, keywords: tuple[str, ...]) -> bool:
    lowered = str(text or "").lower()
    return any(keyword.lower() in lowered for keyword in keywords)


def _compact_model_text(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(text or "").lower())


def _is_qwen3_8b_clip(name: str) -> bool:
    compact = _compact_model_text(name)
    return "qwen" in compact and "3" in compact and "8b" in compact


def _is_qwen3_4b_clip(name: str) -> bool:
    compact = _compact_model_text(name)
    return "qwen" in compact and "3" in compact and "4b" in compact


def _flux2_unet_models() -> list[str]:
    models = list_unet_models() or [DEFAULT_UNET]
    filtered = [
        name
        for name in models
        if _contains_any(name, ("f2k", "flux2", "flux-2", "flux_2", "klein"))
    ]
    return filtered or models


def _flux2_clip_models() -> list[str]:
    models = list_clip_models() or [DEFAULT_CLIP]
    qwen3_8b = [name for name in models if _is_qwen3_8b_clip(name)]
    compatible = [
        name
        for name in models
        if _contains_any(name, ("qwen_3", "qwen3", "flux2", "flux-2")) and not _is_qwen3_4b_clip(name)
    ]
    ordered = [*qwen3_8b, *compatible]
    result: list[str] = []
    seen: set[str] = set()
    for name in ordered:
        if name and name not in seen:
            result.append(name)
            seen.add(name)
    return result or [DEFAULT_CLIP]


def _resolve_f2k_clip_name(requested: str) -> str:
    available = list_clip_models() or [DEFAULT_CLIP]
    qwen3_8b = [name for name in available if _is_qwen3_8b_clip(name)]
    if qwen3_8b:
        return _pick_available_name(DEFAULT_CLIP, qwen3_8b, qwen3_8b[0])
    if _is_qwen3_4b_clip(requested):
        return DEFAULT_CLIP
    return _pick_available_name(DEFAULT_CLIP, available, DEFAULT_CLIP)


def _flux2_vae_models() -> list[str]:
    models = list_vae_models() or [DEFAULT_VAE]
    preferred = [name for name in models if _contains_any(name, ("flux2", "flux-2", "flux_2"))]
    return preferred or models


def _normalize_bhwc_tensor(value: torch.Tensor) -> torch.Tensor:
    tensor = value
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim == 5:
        if int(tensor.shape[-1]) in (1, 3, 4):
            tensor = tensor.reshape(-1, tensor.shape[-3], tensor.shape[-2], tensor.shape[-1])
        elif int(tensor.shape[1]) in (1, 3, 4):
            tensor = tensor.permute(0, 2, 3, 4, 1).reshape(-1, tensor.shape[3], tensor.shape[4], tensor.shape[1])
    if tensor.ndim != 4:
        raise RuntimeError(f"多宫格参考图收到不支持的图片维度：{tuple(tensor.shape)}。")
    if int(tensor.shape[-1]) not in (1, 2, 3, 4) and int(tensor.shape[1]) in (1, 2, 3, 4):
        tensor = tensor.movedim(1, -1)
    channels = int(tensor.shape[-1])
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 2:
        tensor = tensor[..., :1].repeat(1, 1, 1, 3)
    elif channels >= 3:
        tensor = tensor[..., :3]
    else:
        raise RuntimeError(f"多宫格参考图收到不支持的通道数：{channels}。")
    return tensor.detach().float().clamp(0.0, 1.0).contiguous()


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _video_components(value: Any) -> dict[str, Any] | None:
    getter = getattr(value, "get_components", None)
    if not callable(getter):
        return None
    try:
        components = getter()
    except Exception:
        return None
    if isinstance(components, dict):
        return components
    return {"images": _component_value(components, "images"), "frames": _component_value(components, "frames")}


def _collect_media_batches(value: Any, batches: list[torch.Tensor]) -> None:
    if value is None:
        return
    if isinstance(value, torch.Tensor):
        batches.append(_normalize_bhwc_tensor(value))
        return
    components = _video_components(value)
    if components is not None:
        for key in ("images", "frames", "image", "frame"):
            _collect_media_batches(components.get(key), batches)
        return
    if isinstance(value, dict):
        for key in ("images", "image", "frames", "frame", "samples", "batch", "items", "value", "video"):
            if key in value:
                _collect_media_batches(value[key], batches)
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            _collect_media_batches(item, batches)


def _split_media(value: Any) -> list[torch.Tensor]:
    batches: list[torch.Tensor] = []
    _collect_media_batches(value, batches)
    images: list[torch.Tensor] = []
    for batch in batches:
        images.extend(batch[index : index + 1].contiguous() for index in range(int(batch.shape[0])))
    return images


def _first_scalar(value: Any) -> Any:
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    if isinstance(value, (list, tuple)) and value:
        return value[0]
    return value


def _prompt_parts(text: str) -> list[dict[str, str]]:
    raw = str(text or "").strip()
    if not raw:
        return []
    chunks = re.split(r"(?:^\s*---+\s*$)|(?:\n\s*\n+)", raw, flags=re.MULTILINE)
    parts: list[dict[str, str]] = []
    for chunk in chunks:
        body = str(chunk or "").strip()
        if not body:
            continue
        caption = f"参考 {len(parts) + 1}"
        match = re.match(r"^\s*(?:\*\*)?([^:\n：*]{1,80})(?:\*\*)?\s*[:：]\s*(.*)$", body, flags=re.DOTALL)
        if match:
            caption = re.sub(r"^[*#\s]+|[*\s]+$", "", match.group(1)).strip() or caption
            body = match.group(2).strip() or body
        body = re.sub(r"\*\*([^*]+)\*\*", r"\1", body).strip()
        if body:
            parts.append({"caption": caption, "prompt": body, "raw": chunk})
    return parts


def _is_white_background_subject(part: dict[str, str]) -> bool:
    text = f"{part.get('caption', '')} {part.get('prompt', '')}"
    if _contains_any(text, ("场景", "风景", "建筑", "环境", "山景", "室内", "室外")):
        return False
    return _contains_any(text, ("人物", "道具", "动物", "角色", "背包", "手杖", "产品", "物品"))


def _needs_role_prop_three_view(part: dict[str, str]) -> bool:
    text = f"{part.get('caption', '')} {part.get('prompt', '')}"
    return _contains_any(text, ("角色", "人物", "主角", "配角", "道具"))


def _has_three_view_keywords(text: str) -> bool:
    lowered = str(text or "").lower()
    return any(keyword in lowered for keyword in ("三视图", "三面图", "正面、侧面、背面", "three-view", "three view", "front view, side view, back view"))


def _compose_generation_prompt(part: dict[str, str], style_prompt: str, add_three_view: bool = False) -> str:
    prompt = str(part.get("prompt", "")).strip()
    prefix = ""
    if _is_white_background_subject(part):
        prefix = "isolated object or character on a clean pure white background, centered composition, "
    if (add_three_view or _needs_role_prop_three_view(part)) and _is_white_background_subject(part) and not _has_three_view_keywords(prompt):
        prompt = f"{prompt}, 生成正面、侧面、背面三视图，白色背景，角色身材比例保持不变"
    suffix = str(style_prompt or "").strip()
    return ", ".join(item for item in (prefix + prompt, suffix) if item)


def _layout_for_count(count: int, total_width: int, total_height: int, layout_mode: str) -> tuple[int, int]:
    count = max(1, int(count))
    text = str(layout_mode or "自动")
    match = re.match(r"^\s*(\d+)\s*[xX×]\s*(\d+)\s*$", text)
    if match:
        cols = max(1, int(match.group(1)))
        rows = max(1, int(match.group(2)))
        return cols, max(rows, int(math.ceil(count / cols)))
    if text.endswith("列") and text[:-1].isdigit():
        cols = max(1, int(text[:-1]))
        return cols, int(math.ceil(count / cols))
    best = (count, 1)
    target = float(max(1, total_width)) / float(max(1, total_height))
    score = float("inf")
    for cols in range(1, count + 1):
        rows = int(math.ceil(count / cols))
        ratio = cols / rows
        current = abs(math.log(max(0.01, ratio / target))) + (cols * rows - count) * 0.08
        if current < score:
            score = current
            best = (cols, rows)
    return best


def _alignment_multiple(size_alignment: str) -> int:
    text = str(size_alignment or "")
    if "关闭" in text:
        return 1
    if "32" in text:
        return 32
    return 64


def _align_down(value: int, multiple: int, minimum: int = 64) -> int:
    value = max(1, int(value))
    multiple = max(1, int(multiple))
    minimum = max(1, int(minimum))
    if multiple <= 1:
        return value
    aligned = (value // multiple) * multiple
    if aligned >= minimum:
        return aligned
    return max(minimum, int(math.ceil(value / multiple) * multiple))


def _grid_geometry(
    count: int,
    total_width: int,
    total_height: int,
    layout_mode: str,
    gap: int,
    size_alignment: str,
) -> tuple[int, int, int, int, int, int]:
    cols, rows = _layout_for_count(count, total_width, total_height, layout_mode)
    gap = max(0, int(gap))
    total_width = max(64, int(total_width))
    total_height = max(64, int(total_height))
    raw_cell_w = max(8, (total_width - gap * (cols + 1)) // cols)
    raw_cell_h = max(8, (total_height - gap * (rows + 1)) // rows)
    multiple = _alignment_multiple(size_alignment)
    cell_w = _align_down(raw_cell_w, multiple, 64)
    cell_h = _align_down(raw_cell_h, multiple, 64)
    canvas_w = cell_w * cols + gap * (cols + 1)
    canvas_h = cell_h * rows + gap * (rows + 1)
    return cols, rows, cell_w, cell_h, canvas_w, canvas_h


def _resize_exact(image: torch.Tensor, width: int, height: int, method: str) -> torch.Tensor:
    samples = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(samples, int(width), int(height), str(method or "lanczos"), "disabled")
    return resized.movedim(1, -1).clamp(0.0, 1.0).contiguous()


def _fit_cell(image: torch.Tensor, cell_w: int, cell_h: int, fit_mode: str, bg: float, method: str) -> torch.Tensor:
    source = _normalize_bhwc_tensor(image)[:1]
    src_h = max(1, int(source.shape[1]))
    src_w = max(1, int(source.shape[2]))
    cover = str(fit_mode or "智能") == "铺满裁切"
    scale = (max(cell_w / src_w, cell_h / src_h) if cover else min(cell_w / src_w, cell_h / src_h))
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    resized = _resize_exact(source, new_w, new_h, method)
    if cover:
        left = max(0, (new_w - cell_w) // 2)
        top = max(0, (new_h - cell_h) // 2)
        return resized[:, top : top + cell_h, left : left + cell_w, :].contiguous()
    canvas = torch.full((1, cell_h, cell_w, 3), float(bg), dtype=resized.dtype, device=resized.device)
    left = max(0, (cell_w - new_w) // 2)
    top = max(0, (cell_h - new_h) // 2)
    canvas[:, top : top + new_h, left : left + new_w, :] = resized[:, :cell_h, :cell_w, :]
    return canvas.clamp(0.0, 1.0).contiguous()


def _make_grid(
    images: list[torch.Tensor],
    parts: list[dict[str, str]],
    total_width: int,
    total_height: int,
    layout_mode: str,
    gap: int,
    fit_mode: str,
    resize_method: str,
    size_alignment: str,
) -> tuple[torch.Tensor, torch.Tensor]:
    if not images:
        raise RuntimeError("没有可拼接的图片。请连接图片，或填写正向提示词。")
    cols, rows, cell_w, cell_h, canvas_w, canvas_h = _grid_geometry(
        len(images), total_width, total_height, layout_mode, gap, size_alignment
    )
    gap = max(0, int(gap))
    canvas = torch.zeros((1, canvas_h, canvas_w, 3), dtype=torch.float32)
    cells: list[torch.Tensor] = []
    for index, image in enumerate(images):
        part = parts[index] if index < len(parts) else {}
        bg = 1.0 if _is_white_background_subject(part) else 0.0
        mode = "完整留白" if str(fit_mode or "智能") == "智能" and bg >= 1.0 else fit_mode
        if str(mode) == "智能":
            mode = "铺满裁切"
        cell = _fit_cell(image, cell_w, cell_h, mode, bg, resize_method)
        row = index // cols
        col = index % cols
        top = gap + row * (cell_h + gap)
        left = gap + col * (cell_w + gap)
        canvas[:, top : top + cell_h, left : left + cell_w, :] = cell
        cells.append(cell)
    return canvas.clamp(0.0, 1.0).contiguous(), torch.cat(cells, dim=0).contiguous()


def _load_pipeline(unet_name: str, clip_name: str, vae_name: str, keep_loaded: bool):
    key = (str(unet_name), str(clip_name), str(vae_name))
    if keep_loaded and key in _MODEL_CACHE:
        return _MODEL_CACHE[key]
    if not keep_loaded:
        _MODEL_CACHE.clear()
    model = _load_model(unet_name, DEFAULT_UNET_DTYPE)
    clip = _load_clip_from_names([clip_name], "flux2")
    vae = _load_vae(vae_name)
    if keep_loaded:
        _MODEL_CACHE.clear()
        _MODEL_CACHE[key] = (model, clip, vae)
    return model, clip, vae


def _generate_flux2_image(
    model: Any,
    clip: Any,
    vae: Any,
    prompt: str,
    negative_prompt: str,
    reference_image: torch.Tensor | None,
    width: int,
    height: int,
    steps: int,
    cfg: float,
    seed: int,
) -> torch.Tensor:
    positive = gjjutils_encode_text(clip, prompt)
    negative = gjjutils_encode_text(clip, negative_prompt) if str(negative_prompt or "").strip() else gjjutils_zero_out_conditioning(gjjutils_encode_text(clip, prompt))
    if reference_image is not None:
        ref = _resize_exact(_normalize_bhwc_tensor(reference_image)[:1], width, height, "lanczos")
        reference_latent = VAEEncode().encode(vae, ref)[0]["samples"]
        positive = gjjutils_append_reference_latent(positive, reference_latent)
        negative = gjjutils_append_reference_latent(negative, reference_latent)

    latent = EmptyFlux2LatentImage.execute(int(width), int(height), 1)[0]
    sigmas = Flux2Scheduler.execute(int(steps), int(width), int(height))[0]
    sampler = KSamplerSelect.execute("euler")[0]
    noise = RandomNoise.execute(int(seed))[0]
    guider = CFGGuider.execute(model, positive, negative, float(cfg))[0]
    sampled = SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, latent)[0]
    return VAEDecode().decode(vae, sampled)[0].clamp(0.0, 1.0).contiguous()


class GJJ_ReferenceGridGenerator:
    DESCRIPTION = "多宫格参考图生成器。支持正向提示词按空行或 --- 分割，多图/视频输入智能拼图，Flux2/f2k 文生图与图生图生成，并输出黑色边框间隔宫格。"
    SEARCH_ALIASES = ["多宫格参考图", "参考图生成器", "宫格拼图", "flux2 reference grid", "f2k grid"]
    RETURN_TYPES = ("IMAGE", MIXED_IMAGE_OUTPUT, "STRING")
    RETURN_NAMES = ("多宫格参考图", "单元图片", "任务摘要")
    OUTPUT_TOOLTIPS = (
        "按总尺寸拼合后的黑色间隔多宫格参考图。",
        "每个单元格统一尺寸后的图片批次。",
        "执行模式、任务数和尺寸摘要。",
    )
    FUNCTION = "generate"
    CATEGORY = "GJJ/🖼️ 图像/生成"
    INPUT_IS_LIST = True
    GJJ_HELP = {
        "title": "GJJ · 多宫格参考图生成器",
        "description": DESCRIPTION,
        "models": [
            {"label": "UNET 主模型", "filename": DEFAULT_UNET, "folder": "models/diffusion_models", "input": "unet_name", "type": "UNET", "kind": "Flux2 / f2k"},
            {"label": "CLIP 文本编码器", "filename": DEFAULT_CLIP, "folder": "models/text_encoders", "input": "clip_name", "type": "CLIP", "kind": "Flux2"},
            {"label": "VAE", "filename": DEFAULT_VAE, "folder": "models/vae", "input": "vae_name", "type": "VAE", "kind": "Flux2"},
        ],
        "usage": [
            "正向提示词支持多行文本；空行或单独一行 --- 会切分为多个任务。",
            "只接图片且正向提示词为空时不会加载模型，只执行智能宫格拼图。",
            "只填提示词时执行文生图；图片和提示词同时存在时可自动进入图生图。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        unet_models = _flux2_unet_models()
        clip_models = _flux2_clip_models()
        vae_models = _flux2_vae_models()
        return {
            "required": {
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_PROMPT,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词 / 任务列表",
                        "tooltip": "按空行或单独一行 --- 分割任务；每个任务生成/拼接一张单元图。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "display_name": "反向提示词",
                    },
                ),
                "unet_name": (
                    unet_models,
                    {
                        "default": unet_models[0],
                        "display_name": "🟣 UNET 主模型",
                        "tooltip": "优先显示 f2k / flux2 / Klein 关键词模型，默认选择列表第一项。",
                    },
                ),
                "clip_name": (
                    clip_models,
                    {
                        "default": _pick_available_name(DEFAULT_CLIP, clip_models, clip_models[0]),
                        "display_name": "🔤 CLIP",
                        "tooltip": "按 Flux2 默认模型族筛选文本编码器列表。",
                    },
                ),
                "vae_name": (
                    vae_models,
                    {
                        "default": _pick_available_name(DEFAULT_VAE, vae_models, vae_models[0]),
                        "display_name": "🧩 VAE",
                        "tooltip": "按 Flux2 默认模型族筛选 VAE 列表。",
                    },
                ),
                "generation_mode": (
                    GENERATION_MODES,
                    {
                        "default": "自动",
                        "display_name": "生成模式",
                        "tooltip": "自动：无提示词只拼图；有提示词默认文生图；需要参考图重绘时手动选择图生图。",
                    },
                ),
                "keep_models_loaded": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "模型常驻",
                        "label_on": "常驻",
                        "label_off": "释放",
                        "tooltip": "开启后本节点会缓存当前 UNET/CLIP/VAE，重复执行更快但占用显存/内存。",
                    },
                ),
                "total_width": (
                    "INT",
                    {"default": 1536, "min": 128, "max": 8192, "step": 8, "display_name": "总宽度"},
                ),
                "total_height": (
                    "INT",
                    {"default": 1024, "min": 128, "max": 8192, "step": 8, "display_name": "总高度"},
                ),
                "layout_mode": (
                    LAYOUT_MODES,
                    {"default": "自动", "display_name": "列数"},
                ),
                "gap": (
                    "INT",
                    {"default": 8, "min": 0, "max": 128, "step": 1, "display_name": "黑色间隔"},
                ),
                "cell_fit": (
                    FIT_MODES,
                    {"default": "智能", "display_name": "单元适配"},
                ),
                "steps": (
                    "INT",
                    {"default": 4, "min": 1, "max": 100, "step": 1, "display_name": "采样步数"},
                ),
                "cfg": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "display_name": "CFG"},
                ),
                "seed": (
                    "INT",
                    {"default": 352628917855609, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True, "display_name": "种子"},
                ),
                "style_prompt": (
                    "STRING",
                    {
                        "default": "high quality, clean reference sheet, sharp details",
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "统一风格补充",
                    },
                ),
                "resize_method": (
                    UPSCALE_METHODS,
                    {"default": "lanczos", "display_name": "缩放算法"},
                ),
                "size_alignment": (
                    SIZE_ALIGN_MODES,
                    {
                        "default": "LTX/Flux2 64倍数",
                        "display_name": "尺寸对齐",
                        "tooltip": "用于接 LTX / Flux2 时避免非网格尺寸导致形状错误。会先对齐单元格尺寸，再反算最终拼版尺寸。",
                    },
                ),
            },
            "optional": {
                "images": (
                    MEDIA_INPUT_TYPE,
                    {
                        "display_name": "批量图片 / 视频",
                        "tooltip": "可选。支持 GJJ_BATCH_IMAGE、IMAGE、VIDEO；只接图片且正向为空时不调用模型，直接智能拼图。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, images=None, **kwargs):
        image_sig = ""
        if hasattr(images, "shape"):
            image_sig = str(tuple(images.shape))
        return "|".join(str(kwargs.get(key, "")) for key in sorted(kwargs)) + "|" + image_sig

    def generate(
        self,
        positive_prompt,
        negative_prompt,
        unet_name,
        clip_name,
        vae_name,
        generation_mode,
        keep_models_loaded,
        total_width,
        total_height,
        layout_mode,
        gap,
        cell_fit,
        steps,
        cfg,
        seed,
        style_prompt,
        resize_method,
        size_alignment="LTX/Flux2 64倍数",
        images=None,
        unique_id=None,
    ):
        positive_prompt = _first_scalar(positive_prompt)
        negative_prompt = _first_scalar(negative_prompt)
        unet_name = _first_scalar(unet_name)
        clip_name = _first_scalar(clip_name)
        vae_name = _first_scalar(vae_name)
        generation_mode = _first_scalar(generation_mode)
        keep_models_loaded = _first_scalar(keep_models_loaded)
        total_width = _first_scalar(total_width)
        total_height = _first_scalar(total_height)
        layout_mode = _first_scalar(layout_mode)
        gap = _first_scalar(gap)
        cell_fit = _first_scalar(cell_fit)
        steps = _first_scalar(steps)
        cfg = _first_scalar(cfg)
        seed = _first_scalar(seed)
        style_prompt = _first_scalar(style_prompt)
        resize_method = _first_scalar(resize_method)
        size_alignment = _first_scalar(size_alignment)
        unique_id = _first_scalar(unique_id)

        parts = _prompt_parts(positive_prompt)
        input_images = _split_media(images)
        has_prompts = bool(parts)
        has_images = bool(input_images)
        mode = str(generation_mode or "自动")
        if mode == "自动":
            if has_prompts and has_images:
                mode = "图生图"
            elif has_prompts:
                mode = "文生图"
            else:
                mode = "只拼图"

        if mode == "只拼图" or (has_images and not has_prompts):
            _send_status(unique_id, f"智能拼图：{len(input_images)} 张输入图片，不加载模型。")
            collage, cells = _make_grid(input_images, parts, total_width, total_height, layout_mode, gap, cell_fit, resize_method, size_alignment)
            summary = f"只拼图：{len(input_images)} 张，输出 {int(collage.shape[2])} x {int(collage.shape[1])}"
            _send_status(unique_id, summary)
            return (collage, collage, summary)

        if not has_prompts:
            raise RuntimeError("多宫格参考图需要正向提示词，或至少连接一组图片。")

        jobs: list[tuple[dict[str, str], torch.Tensor | None]] = []
        if mode == "图生图" and input_images:
            if len(parts) == 1:
                jobs = [(parts[0], image) for image in input_images]
            elif len(parts) == len(input_images):
                jobs = [(parts[index], image) for index, image in enumerate(input_images)]
            else:
                raise RuntimeError(
                    f"图生图任务数量不匹配：收到 {len(input_images)} 张输入图片，但正向提示词分成 {len(parts)} 段。"
                    "请只写 1 段提示词套用全部图片，或让提示词段数与图片数量一致。"
                )
        else:
            jobs = [(part, None) for part in parts]

        cols, rows, cell_w, cell_h, aligned_width, aligned_height = _grid_geometry(
            len(jobs), int(total_width), int(total_height), layout_mode, int(gap), size_alignment
        )
        if int(aligned_width) != int(total_width) or int(aligned_height) != int(total_height):
            _send_status(
                unique_id,
                f"尺寸已按 {size_alignment} 对齐：单元 {cell_w} x {cell_h}，拼版 {aligned_width} x {aligned_height}",
            )

        _send_status(unique_id, f"1/3 加载 Flux2 模型链：{unet_name}")
        resolved_clip_name = _resolve_f2k_clip_name(clip_name)
        if str(resolved_clip_name) != str(clip_name):
            _send_status(unique_id, f"f2k / Flux2 Klein 固定使用 Qwen3 8B CLIP：{resolved_clip_name}")
        model, clip, vae = _load_pipeline(
            _pick_available_name(unet_name, list_unet_models() or [unet_name], unet_name),
            resolved_clip_name,
            _pick_available_name(vae_name, list_vae_models() or [vae_name], vae_name),
            bool(keep_models_loaded),
        )

        generated: list[torch.Tensor] = []
        total = len(jobs)
        output_parts: list[dict[str, str]] = []
        for index, (part, reference) in enumerate(jobs, start=1):
            output_parts.append(part)
            add_three_view = len(jobs) == 1 and max(cell_w / max(1, cell_h), cell_h / max(1, cell_w)) >= 1.6
            prompt = _compose_generation_prompt(part, style_prompt, add_three_view=add_three_view)
            _send_status(unique_id, f"2/3 {mode}：生成第 {index}/{total} 张单元图...")
            generated.append(
                _generate_flux2_image(
                    model=model,
                    clip=clip,
                    vae=vae,
                    prompt=prompt,
                    negative_prompt=negative_prompt,
                    reference_image=reference,
                    width=cell_w,
                    height=cell_h,
                    steps=int(steps),
                    cfg=float(cfg),
                    seed=int(seed) + index - 1,
                )
            )

        _send_status(unique_id, "3/3 拼合黑色边框多宫格...")
        collage, cells = _make_grid(generated, output_parts, total_width, total_height, layout_mode, gap, cell_fit, resize_method, size_alignment)
        summary = f"{mode}：{len(generated)} 张，单元 {cell_w} x {cell_h}，输出 {int(collage.shape[2])} x {int(collage.shape[1])}"
        _send_status(unique_id, summary)
        return (collage, cells, summary)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ReferenceGridGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧩 多宫格参考图生成器"}
