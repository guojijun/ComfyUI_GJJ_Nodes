from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

# 导入公共依赖检查函数
from .common_utils.dependency_checker import (
    load_dependency_at_runtime,
    get_pip_install_command_text,
)

# 运行时依赖检查（零依赖导入模式，使用 importlib 安全检查）
try:
    importlib.import_module("torch")
    importlib.import_module("numpy")
    _DEPENDENCIES_AVAILABLE = True
    _IMPORT_ERROR = None
except ImportError as exc:
    _DEPENDENCIES_AVAILABLE = False
    _IMPORT_ERROR = str(exc)

# 零依赖导入模式：顶层不导入 torch / ComfyUI / 其它本地运行时模块。
# ComfyUI 扫描节点时只需要 INPUT_TYPES / NODE_CLASS_MAPPINGS，真正执行时再懒加载运行依赖。
GJJ_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE"
DEFAULT_SEGMENT_VIDEO_FORMAT = "video/h264-mp4"
MODE_GENERATED_AUDIO = "generated_audio"
MODE_AUDIO_CONDITIONED = "audio_conditioned"
DEFAULT_NEGATIVE_PROMPT = (
    "titles, subtitles, text, watermark, logo, blurry text, distorted text, overexposed, underexposed, "
    "low contrast, washed out colors, excessive noise, motion blur, camera shake, background clutter, "
    "unnatural skin tones, deformed facial features, extra limbs, disfigured hands, uncanny valley, "
    "mismatched lip sync, off-sync audio, jittery movement, awkward pauses, incorrect timing, AI artifacts"
)


def _runtime_module():
    return importlib.import_module(".gjj_ltx23_multiref_runtime", __package__)


def _send_status(unique_id: Any, text: str, progress: float | None = None) -> None:
    try:
        return _runtime_module()._send_status(unique_id, text, progress)
    except Exception:
        return None


def _run_ltx23_multiref_video(**kwargs):
    return _runtime_module().run_ltx23_multiref_video(**kwargs)


def _torch_module():
    try:
        return importlib.import_module("torch")
    except Exception:
        return None


NODE_NAME = "GJJ_LTX23ImageToVideoMultiRef"
SCENE_PREFIX = "scene_"
DEFAULT_PROMPT = "多张参考图连续过渡，主体动作自然，镜头语言稳定，电影感光影，细节真实。"
DEFAULT_SEGMENT_SECONDS = 5.0
DEFAULT_FPS = 24
DEFAULT_SEED = 483811081311996
DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 720
DEFAULT_FRAME_TRIM_START_VIDEO = 2
DEFAULT_FRAME_TRIM_START_AUDIO = 3
SCENE_BATCH_INPUT_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"
MAX_SCENE_INPUTS = 20
INITIAL_SCENE_INPUTS = 1
DEFAULT_DENOISE_STRENGTH = 1.0
TRANSITION_CURVES = ("前置过渡", "平滑过渡", "线性过渡", "后置过渡")
DEFAULT_TRANSITION_EARLY_TAIL_RATIO = 0.75
DEFAULT_TRANSITION_IMPLICIT_GUIDE_COUNT = 2
DEFAULT_TRANSITION_IMPLICIT_GUIDE_STRENGTH = 0.55
DEFAULT_TRANSITION_EARLY_TAIL_STRENGTH = 0.75
DEFAULT_TRANSITION_FINAL_GUIDE_STRENGTH = 1.0
SEGMENT_SAVE_PRESETS = (
    "video/GJJ_LTX多图分段",
    "video/GJJ_LTX多图分段/{date}",
    "video/GJJ_LTX多图分段/{date}/{time}",
    "video/GJJ_LTX多图分段/{date}/任务{node}",
)

# Clean v40：保持稳定 UI，增强批量容器解析，并继续修正主参数执行尺寸。
# 这样 ComfyUI 会像系统节点一样把可连接小圆点画在字段前面，
# 不再使用 forceInput 顶部独立输入口。高级/折叠参数仍由 DOM + config_json 管理。
MAIN_WIDGET_PARAM_KEYS = (
    "ltx_model_name",
    "positive_prompt",
    "negative_prompt",
    "segment_seconds",
    "width",
    "height",
    "fps",
    "seed",
    "denoise_strength",
)


def _apply_external_param_overrides(config: dict[str, Any], kwargs: dict[str, Any]) -> dict[str, Any]:
    """原生主参数覆盖 config_json。

    Clean v8 中这些参数由 Python 原生 widget 管理：
    - 未连线时使用字段里的值；
    - 连线时 ComfyUI 会用外联输入值覆盖字段值。
    因此后台只需要从 kwargs 取最终值即可。
    """
    if not isinstance(config, dict):
        config = {}
    updated = dict(config)
    for key in MAIN_WIDGET_PARAM_KEYS:
        if key in kwargs and kwargs.get(key) is not None:
            updated[key] = kwargs.get(key)
    return updated


def _segment_video_format_options() -> list[str]:
    # 零依赖导入：INPUT_TYPES 阶段不导入视频合成运行时，避免扫描节点时触发可选依赖。
    return [DEFAULT_SEGMENT_VIDEO_FORMAT]


def _scene_input_spec(index: int):
    resolved_index = int(index)
    input_type = SCENE_BATCH_INPUT_TYPE if resolved_index <= 1 else "IMAGE"
    return (
        input_type,
        {
            "display_name": f"场景{resolved_index}",
            "tooltip": (
                "🖼️ 第一张场景图输入。支持 IMAGE / GJJ_BATCH_IMAGE；批量图会自动展开。2张=首尾帧，3张+=多图分段。留空走文生视频。"
                if resolved_index <= 1
                else "➕ 追加场景参考图。相邻两张图会组成一段首尾帧转场；连上当前最后一张后会自动扩展下一张输入。"
            ),
        },
    )


class FlexibleSceneInputType(dict):
    def __init__(self, data: dict[str, Any] | None = None):
        super().__init__()
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        text = str(key or "")
        if _is_scene_input_name(text):
            index = _extract_scene_index(text)
            return _scene_input_spec(index)
        raise KeyError(key)

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def __contains__(self, key):
        text = str(key or "")
        return key in self.data or _is_scene_input_name(text)



def _is_scene_input_name(name: str) -> bool:
    text = str(name or "").strip()
    if text == "main_image" or text.startswith("guide_image_") or text.startswith("场景") or text.startswith(SCENE_PREFIX):
        return True
    # 兼容旧节点/前端残留口：01、🖼️ 01、image_01、图片 1
    compact = text.replace("🖼️", "").replace("图片", "").replace(" ", "").strip()
    if compact.isdigit():
        return True
    if text.startswith("image_"):
        tail = text[len("image_"):]
        return tail.isdigit()
    return False


def _extract_scene_index(name: str) -> int:
    text = str(name or "")
    if text == "main_image":
        return 1
    if text.startswith("guide_image_"):
        try:
            return max(2, int(text[len("guide_image_") :]) + 1)
        except Exception:
            return 999999
    if text.startswith("场景"):
        try:
            return max(1, int(text[len("场景") :]))
        except Exception:
            return 999999
    if text.startswith("image_"):
        try:
            return max(1, int(text[len("image_") :]))
        except Exception:
            return 999999
    compact = text.replace("🖼️", "").replace("图片", "").replace(" ", "").strip()
    if compact.isdigit():
        try:
            return max(1, int(compact))
        except Exception:
            return 999999
    if not text.startswith(SCENE_PREFIX):
        return 999999
    try:
        return max(1, int(text[len(SCENE_PREFIX) :]))
    except Exception:
        return 999999


def _collect_scene_items(kwargs: dict[str, Any]) -> list[tuple[str, int, Any]]:
    """收集所有场景输入，并保留输入口名称用于调试状态栏。"""
    items: list[tuple[int, str, Any]] = []
    for key, value in kwargs.items():
        text = str(key or "")
        if text in ("scene_batch", "batch_scenes"):
            continue
        if value is None:
            continue
        if not _is_scene_input_name(text):
            continue
        items.append((_extract_scene_index(text), text, value))
    items.sort(key=lambda item: item[0])
    return [(name, index, value) for index, name, value in items]


def _collect_scene_images(kwargs: dict[str, Any]) -> list[Any]:
    return [value for _, _, value in _collect_scene_items(kwargs)]


def _count_split_images(value: Any) -> int:
    try:
        return len(_split_scene_batch(value))
    except Exception:
        return 0


def _debug_value_signature(value: Any) -> str:
    try:
        cls = value.__class__.__name__
    except Exception:
        cls = type(value).__name__
    torch = _torch_module()
    if torch is not None and isinstance(value, torch.Tensor):
        try:
            return f"{cls}{tuple(int(v) for v in value.shape)}"
        except Exception:
            return cls
    try:
        shape = getattr(value, "shape", None)
        if shape is not None:
            return f"{cls}{tuple(int(v) for v in shape)}"
    except Exception:
        pass
    try:
        length = len(value)  # type: ignore[arg-type]
        if not isinstance(value, (str, bytes, bytearray)):
            return f"{cls}[len={int(length)}]"
    except Exception:
        pass
    return cls


def _summarize_scene_sources(scene_items: list[tuple[str, int, Any]], legacy_batch_count: int) -> str:
    parts: list[str] = []
    if legacy_batch_count:
        parts.append(f"旧批量口={legacy_batch_count}")
    for name, index, value in scene_items:
        count = _count_split_images(value)
        display = f"场景{index}" if index < 999999 else str(name or "场景")
        parts.append(f"{display}:{count}")
    return "，".join(parts) if parts else "无场景输入"


def _is_empty_loader_placeholder(image: Any) -> bool:
    torch = _torch_module()
    if torch is None or not isinstance(image, torch.Tensor):
        return False
    if image.ndim != 4:
        return False
    if int(image.shape[0]) != 1 or int(image.shape[1]) != 64 or int(image.shape[2]) != 64:
        return False
    try:
        return float(image.detach().abs().amax().item()) <= 1e-7
    except Exception:
        return False


def _unwrap_single_value(value: Any) -> Any:
    """INPUT_IS_LIST=True 后，普通 widget / 单值输入会被 ComfyUI 包一层 list。
    主参数要取第一个值；场景输入不能在这里拍扁，否则会丢掉批量多图。
    """
    if isinstance(value, list) and len(value) == 1:
        return value[0]
    if isinstance(value, tuple) and len(value) == 1:
        return value[0]
    return value


def _unwrap_main_params(params: dict[str, Any]) -> dict[str, Any]:
    return {key: _unwrap_single_value(value) for key, value in params.items()}


def _is_image_tensor_like(value: Any) -> bool:
    torch = _torch_module()
    if torch is None or not isinstance(value, torch.Tensor):
        return False
    try:
        shape = tuple(int(v) for v in value.shape)
    except Exception:
        return False
    return (len(shape) == 4 and shape[-1] in (1, 3, 4)) or (len(shape) == 3 and shape[-1] in (1, 3, 4))


def _normalize_image_tensor_like(value: Any) -> Any:
    torch = _torch_module()
    if torch is not None and isinstance(value, torch.Tensor) and value.ndim == 3:
        return value.unsqueeze(0)
    return value


def _split_image_tensor_like(value: Any) -> list[Any]:
    torch = _torch_module()
    if torch is None or not isinstance(value, torch.Tensor):
        return []
    if value.ndim == 3 and int(value.shape[-1]) in (1, 3, 4):
        return [value.unsqueeze(0).contiguous()]
    if value.ndim == 4 and int(value.shape[-1]) in (1, 3, 4):
        batch = value.contiguous()
        return [batch[index:index + 1].contiguous() for index in range(int(batch.shape[0]))]
    return []


def _iter_scene_container_values(obj: Any) -> list[Any]:
    """借鉴 GJJ 多功能图片缩放：尽可能安全地展开 GJJ_BATCH_IMAGE / 自定义批量容器。"""
    values: list[Any] = []
    torch = _torch_module()
    if obj is None:
        return values
    if isinstance(obj, (str, bytes, bytearray)):
        return values
    if torch is not None and isinstance(obj, torch.Tensor):
        return values

    if isinstance(obj, dict):
        # 优先读取常见批量字段，避免无关键干扰。
        common_names = (
            "images", "image", "imgs", "batch", "batches", "queue", "items",
            "data", "samples", "frames", "outputs", "values", "selected",
            "selected_images", "image_list", "image_queue", "pictures", "pics",
            "图片", "图像", "图片列表", "批量图片", "批量图片队列",
            "result", "results", "output",
        )
        preferred = []
        for name in common_names:
            if name in obj and obj.get(name) is not obj:
                preferred.append(obj.get(name))
        return preferred or list(obj.values())

    if isinstance(obj, (list, tuple, set)):
        return list(obj)

    common_names = (
        "images", "image", "imgs", "batch", "batches", "queue", "items",
        "data", "samples", "frames", "outputs", "values", "selected",
        "selected_images", "image_list", "image_queue", "pictures", "pics",
        "图片", "图像", "图片列表", "批量图片", "批量图片队列",
        "result", "results", "output",
    )
    for name in common_names:
        try:
            if hasattr(obj, name):
                value = getattr(obj, name)
                if value is not None and value is not obj:
                    values.append(value)
        except Exception:
            pass

    try:
        data = vars(obj)
        if isinstance(data, dict):
            values.extend(data.values())
    except Exception:
        pass

    try:
        if hasattr(obj, "_asdict"):
            data = obj._asdict()
            if isinstance(data, dict):
                values.extend(data.values())
    except Exception:
        pass

    try:
        if hasattr(obj, "__iter__"):
            values.extend(list(obj))
    except Exception:
        pass

    return values


def _collect_scene_images_recursive(obj: Any, _seen: set[int] | None = None) -> list[Any]:
    if _seen is None:
        _seen = set()
    images: list[Any] = []
    if obj is None:
        return images

    oid = id(obj)
    if oid in _seen:
        return images
    _seen.add(oid)

    if _is_image_tensor_like(obj):
        images.extend(_split_image_tensor_like(obj))
        return images

    for value in _iter_scene_container_values(obj):
        if value is obj:
            continue
        images.extend(_collect_scene_images_recursive(value, _seen))
    return images


def _split_scene_batch(value: Any) -> list[Any]:
    """把单图 IMAGE、IMAGE batch、GJJ_BATCH_IMAGE、自定义容器统一拆成图片列表。"""
    return _collect_scene_images_recursive(value)


def _flatten_scene_values(values: list[Any]) -> list[Any]:
    # Clean v40：借鉴 GJJ_AnyPreview 的处理方式。
    # 如果输入本身是 IMAGE batch tensor，则先按 batch 维拆图，不要把它当成一个对象。
    images: list[Any] = []
    for value in values:
        images.extend(_split_scene_batch(value))
    return images


def _filter_valid_scene_images(scene_images: list[Any]) -> tuple[list[Any], int]:
    valid: list[Any] = []
    skipped = 0
    for image in scene_images:
        if _is_empty_loader_placeholder(image):
            skipped += 1
            continue
        valid.append(image)
    return valid, skipped


def _scene_tensor_signature(image: Any) -> Any:
    """用于去掉同一张图被“批量队列 + 单图口”重复接入后的重复场景。

    保存/重开动态口后，批量队列有时会同时保留 场景1=batch 和 场景2/3=单图。
    这样 2 张图会被误判成 4 张并进入分段执行。
    这里仅去掉内容完全相同/高度相似的 tensor，不影响真正不同的多图参考。
    """
    try:
        import torch
        import torch.nn.functional as F
    except Exception:
        return ("obj", id(image))

    if not isinstance(image, torch.Tensor):
        return ("obj", id(image))
    t = image.detach().float().cpu()
    if t.ndim == 3:
        t = t.unsqueeze(0)
    if t.ndim != 4:
        return ("tensor", tuple(t.shape), float(t.mean().item()) if t.numel() else 0.0)

    # 统一到 16x16 做内容指纹，足够识别重复连接的同一张图。
    sample = t[:1].permute(0, 3, 1, 2).contiguous()
    try:
        sample = F.interpolate(sample, size=(16, 16), mode="bilinear", align_corners=False)
    except Exception:
        pass
    sample = (sample.clamp(0, 1) * 255.0).round().to(torch.uint8).numpy().tobytes()
    return ("tensor_image", tuple(int(x) for x in t.shape[-3:]), sample)


def _dedupe_scene_images(scene_images: list[Any]) -> tuple[list[Any], int]:
    seen: set[Any] = set()
    out: list[Any] = []
    removed = 0
    for image in scene_images:
        sig = _scene_tensor_signature(image)
        if sig in seen:
            removed += 1
            continue
        seen.add(sig)
        out.append(image)
    return out, removed



def _ceil_to_multiple(value: Any, multiple: int = 32, minimum: int = 64) -> int:
    try:
        numeric = int(round(float(value)))
    except Exception:
        numeric = int(minimum)
    numeric = max(int(minimum), numeric)
    m = max(1, int(multiple))
    return int(((numeric + m - 1) // m) * m)


def _normalize_single_ltx_scene_image(image: Any, target_width: int, target_height: int) -> Any:
    """执行期内部对齐：不修改 GJJ_MultiImageLoader，只在 LTX 节点内把参考图转成 LTX 友好的 IMAGE。

    重要：这里不能直接拉伸到面板宽高，否则人物/物体会变形。
    现在采用等比例 contain 缩放，再居中补边到目标画幅，保证最终视频尺寸等于面板宽高，同时保持原图比例。
    """
    try:
        import torch
        import torch.nn.functional as F
    except Exception:
        return image

    if not isinstance(image, torch.Tensor):
        return image
    tensor = image
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        return image
    tensor = tensor[:1].contiguous().to(dtype=torch.float32)
    channels = int(tensor.shape[-1])
    if channels <= 0:
        return image
    if channels == 1:
        tensor = tensor.repeat(1, 1, 1, 3)
    elif channels == 2:
        tensor = tensor[:, :, :, :1].repeat(1, 1, 1, 3)
    elif channels > 3:
        # LTX guide/vae 只吃 RGB，Alpha 在这里丢弃，避免后续通道不一致。
        tensor = tensor[:, :, :, :3]

    target_width = _ceil_to_multiple(target_width, 8, 64)
    target_height = _ceil_to_multiple(target_height, 8, 64)
    current_height = int(tensor.shape[1])
    current_width = int(tensor.shape[2])
    if current_width <= 0 or current_height <= 0:
        return image

    if current_width == target_width and current_height == target_height:
        return tensor.clamp(0.0, 1.0).contiguous()

    # 等比例缩放到目标画幅内，避免直接拉伸变形。
    scale = min(float(target_width) / float(current_width), float(target_height) / float(current_height))
    resized_width = max(1, int(round(float(current_width) * scale)))
    resized_height = max(1, int(round(float(current_height) * scale)))

    samples = tensor.movedim(-1, 1)
    resized = F.interpolate(samples, size=(resized_height, resized_width), mode="bilinear", align_corners=False)

    # 居中补边到面板宽高。用 replicate 比黑边更不容易影响 LTX guide 边缘。
    pad_left = max(0, (target_width - resized_width) // 2)
    pad_right = max(0, target_width - resized_width - pad_left)
    pad_top = max(0, (target_height - resized_height) // 2)
    pad_bottom = max(0, target_height - resized_height - pad_top)
    if pad_left or pad_right or pad_top or pad_bottom:
        resized = F.pad(resized, (pad_left, pad_right, pad_top, pad_bottom), mode="replicate")

    tensor = resized.movedim(1, -1)
    return tensor[:, :target_height, :target_width, :].clamp(0.0, 1.0).contiguous()


def _normalize_ltx_scene_images(scene_images: list[Any], width: Any, height: Any) -> tuple[list[Any], int, int]:
    """Clean v40：流外只做 8 倍数对齐。
    重要修复：minimum 必须是 64，不能用 DEFAULT_WIDTH/DEFAULT_HEIGHT。
    否则面板 512x512 会被 _ceil_to_multiple 最小值强制抬回 1280x720。
    """
    aligned_width = _ceil_to_multiple(width, 8, 64)
    aligned_height = _ceil_to_multiple(height, 8, 64)
    if not scene_images:
        return [], aligned_width, aligned_height
    return [
        _normalize_single_ltx_scene_image(image, aligned_width, aligned_height)
        for image in scene_images
    ], aligned_width, aligned_height


def _scene_image_size(value: Any) -> tuple[int, int] | None:
    torch = _torch_module()
    if torch is None or not isinstance(value, torch.Tensor):
        return None
    tensor = value
    if tensor.ndim == 3:
        h, w = int(tensor.shape[0]), int(tensor.shape[1])
        return (w, h) if w > 0 and h > 0 else None
    if tensor.ndim == 4:
        h, w = int(tensor.shape[1]), int(tensor.shape[2])
        return (w, h) if w > 0 and h > 0 else None
    return None


def _resolve_target_size_from_config_and_scenes(config: dict[str, Any], raw_scene_images: list[Any]) -> tuple[int, int, str]:
    """Clean v40：INPUT_IS_LIST 会让旧节点/新节点的宽高字段有时回到默认 1280x720。
    如果当前宽高仍是默认值，而输入图已经是明确尺寸，则自动用输入图尺寸作为目标。
    用户手动设置了非默认宽高时仍以面板为准。
    """
    cfg_w = _ceil_to_multiple(config.get("width"), 8, 64)
    cfg_h = _ceil_to_multiple(config.get("height"), 8, 64)
    if raw_scene_images and int(cfg_w) == int(DEFAULT_WIDTH) and int(cfg_h) == int(DEFAULT_HEIGHT):
        for image in raw_scene_images:
            size = _scene_image_size(image)
            if size:
                w, h = size
                return _ceil_to_multiple(w, 8, 64), _ceil_to_multiple(h, 8, 64), f"输入图自动尺寸 {w}x{h}"
    return cfg_w, cfg_h, "面板宽高"


def _looks_like_scene_payload(value: Any) -> bool:
    try:
        return len(_split_scene_batch(value)) > 0
    except Exception:
        return False


def _normalize_lora_text_for_transition(value: Any) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _lora_chain_has_transition_lora(value: Any) -> bool:
    """轻量检测 LoRA 串联配置里是否包含 LTX 转场 LoRA。"""
    if value is None:
        return False
    try:
        value = _unwrap_single_value(value)
    except Exception:
        pass
    candidates: list[Any] = [value]
    try:
        if isinstance(value, str):
            parsed = json.loads(value)
            candidates.append(parsed)
    except Exception:
        pass

    def walk(obj: Any) -> bool:
        if obj is None:
            return False
        if isinstance(obj, dict):
            name_text = " ".join(str(obj.get(k, "")) for k in ("name", "lora_name", "path", "filename", "file", "model"))
            normalized = _normalize_lora_text_for_transition(name_text)
            if "ltx23transition" in normalized or ("ltx23" in normalized and "transition" in normalized) or ("ltx" in normalized and "zhuanchang" in normalized) or "转场" in name_text:
                return obj.get("enabled", True) is not False
            return any(walk(v) for v in obj.values())
        if isinstance(obj, (list, tuple, set)):
            return any(walk(v) for v in obj)
        text = str(obj or "")
        normalized = _normalize_lora_text_for_transition(text)
        return "ltx23transition" in normalized or ("ltx23" in normalized and "transition" in normalized) or ("ltx" in normalized and "zhuanchang" in normalized) or "转场" in text

    return any(walk(item) for item in candidates)


def _pop_miswired_scene_payloads(kwargs: dict[str, Any]) -> list[Any]:
    """兼容旧节点/错位连线：图片线误连到 LoRA 或音频口时，转移到场景输入。
    这样能避开 lora_chain_config received_type(GJJ_BATCH_IMAGE,IMAGE) 的校验/执行错位。
    """
    moved: list[Any] = []
    for key in ("lora_chain_config", "input_audio"):
        value = kwargs.get(key)
        if value is None:
            continue
        if _looks_like_scene_payload(value):
            moved.append(value)
            kwargs[key] = None
    return moved


def _build_scene_schedule(
    scene_images: list[Any],
    segment_seconds: float,
    total_duration_override: float | None = None,
) -> tuple[list[Any], list[float], float]:
    duration = float(segment_seconds)
    if duration <= 0:
        raise RuntimeError("每段时长必须大于 0 秒。")

    guide_images = list(scene_images[1:])
    if total_duration_override is not None and float(total_duration_override) > 0:
        total_duration = float(total_duration_override)
        if len(scene_images) > 1:
            denominator = float(max(1, len(scene_images) - 1))
            guide_times = [total_duration * float(index) / denominator for index in range(1, len(scene_images))]
        else:
            guide_times = []
    else:
        guide_times = [duration * float(index) for index in range(1, len(scene_images))]
        total_duration = duration * float(max(1, len(scene_images) - 1))
    return guide_images, guide_times, total_duration


def _safe_bool(value: Any, default: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in ("true", "1", "yes", "y", "on"):
        return True
    if text in ("false", "0", "no", "n", "off"):
        return False
    if value in (0, 1):
        return bool(value)
    return bool(default)


def _safe_float(value: Any, default: float, minimum: float, maximum: float) -> float:
    try:
        numeric = float(value)
    except Exception:
        numeric = float(default)
    return max(float(minimum), min(float(maximum), numeric))


def _try_parse_prompt_json(value: Any) -> dict[str, Any] | None:
    text = str(value or "").strip()
    if not text or text[:1] not in ("{", "["):
        return None
    try:
        parsed = json.loads(text)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _build_prompt_from_scene_list(scene_list: Any) -> str:
    if not isinstance(scene_list, list):
        return ""

    lines: list[str] = []
    for scene in scene_list:
        if not isinstance(scene, dict):
            continue
        for key in ("scene_name", "scene_type", "time_period", "env_attr", "space_attr", "light_attr", "sound_attr", "ambient_sound"):
            value = str(scene.get(key, "") or "").strip()
            if value:
                lines.append(value)
        for shot in scene.get("shot_list", []) if isinstance(scene.get("shot_list"), list) else []:
            if not isinstance(shot, dict):
                continue
            for key in ("character", "character_costume", "action_type", "emotion", "shot_scale", "camera_angle", "shot_move", "shot_pace", "content", "dialogue", "sound_effect", "foley_sound"):
                value = str(shot.get(key, "") or "").strip()
                if value and value != "无":
                    lines.append(value)
    return "，".join(lines).strip()


def _resolve_auto_route(scene_count: int, has_input_audio: bool) -> tuple[str, str, str]:
    scene_count = max(0, int(scene_count or 0))
    if has_input_audio and scene_count <= 0:
        return "s2v", "音频生视频", "有音频、无图片，走 S2V / 音频驱动视频流程。"
    if has_input_audio and scene_count >= 1:
        return "digital_human", "数字人", "音频 + 图片，走数字人 / 口型驱动流程。"
    if scene_count <= 0:
        return "t2v", "文生视频", "无图片、无音频，走 T2V 文生视频流程。"
    if scene_count == 1:
        return "i2v", "图生视频", "一张图片，走 I2V 图生视频流程。"
    return "multi_frame", "多帧参考", f"{scene_count} 张图片，统一走多帧参考流程；双图是多帧参考的特例。"


def _resolve_prompt_payload(
    positive_prompt: Any,
    negative_prompt: Any,
    fps: int,
    segment_seconds: float,
    scene_count: int,
    has_input_audio: bool,
):
    payload = _try_parse_prompt_json(positive_prompt)
    if not payload:
        return {
            "positive_prompt": str(positive_prompt or "").strip(),
            "negative_prompt": str(negative_prompt or "").strip(),
            "fps": int(fps),
            "segment_seconds": float(segment_seconds),
            "total_duration_override": None,
            "decode_generated_audio": True,
            "used_json": False,
        }

    parameters = payload.get("parameters") if isinstance(payload.get("parameters"), dict) else {}
    prompt_text = str(payload.get("prompt", "") or "").strip() or _build_prompt_from_scene_list(payload.get("scene_list"))
    resolved_negative = str(
        payload.get("negative_prompt")
        or payload.get("negative")
        or payload.get("negativePrompt")
        or negative_prompt
        or ""
    ).strip()
    resolved_fps = int(fps)
    resolved_segment_seconds = float(segment_seconds)
    audio_generation = _safe_bool(parameters.get("audio_generation", True), True)
    decode_generated_audio = audio_generation if not has_input_audio else True
    return {
        "positive_prompt": prompt_text,
        "negative_prompt": resolved_negative,
        "fps": max(1, int(resolved_fps)),
        "segment_seconds": max(0.1, float(resolved_segment_seconds)),
        "total_duration_override": None,
        "decode_generated_audio": decode_generated_audio,
        "used_json": True,
    }


def _normalize_model_match_text(value: Any) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _ltx_model_priority(name: Any) -> tuple[int, str]:
    """主模型排序优先级。

    用户要求：
    1. 优先匹配 ltx-2.3-22b
    2. 再匹配普通 ltx

    注意：这里做无符号归一化，所以 ltx-2.3-22b / ltx_2_3_22b / LTX23 这类都能稳定命中。
    """
    text = str(name or "")
    norm = _normalize_model_match_text(text)

    if "ltx2322b" in norm:
        return (0, text.lower())
    if "ltx23" in norm:
        return (1, text.lower())
    if "ltx" in norm:
        return (2, text.lower())
    return (9, text.lower())


def _ltx_checkpoint_options() -> list[str]:
    """Return diffusion model names containing "ltx" case-insensitively.

    LTX 2.3 主模型是 diffusion_models，不是 checkpoints。
    列表排序：ltx-2.3-22b 优先，然后其它 ltx23，最后普通 ltx。
    """
    try:
        import folder_paths  # type: ignore
        names = list(folder_paths.get_filename_list("diffusion_models"))
    except Exception:
        names = []
    filtered = [str(name) for name in names if "ltx" in str(name).lower()]
    filtered = sorted(filtered, key=_ltx_model_priority)
    return filtered or ["ltx-2.3-22b"]


def _default_ltx_checkpoint() -> str:
    options = _ltx_checkpoint_options()
    return options[0] if options else "ltx-2.3-22b"


SECTION_PROPERTY_NAMES = (
    "transition_enabled",
    "transition_curve",
    "transition_early_tail_ratio",
    "transition_implicit_guide_count",
    "transition_implicit_guide_strength",
    "transition_early_tail_strength",
    "transition_final_guide_strength",
    "segmented_execution",
    "segment_save_preset",
    "segment_video_format",
    "transition_lora_switches",
)


def _find_node_properties_from_workflow(extra_pnginfo: Any = None, unique_id: Any = None) -> dict[str, Any]:
    """读取前端 DOM 面板写入 node.properties 的高级参数。"""
    if not isinstance(extra_pnginfo, dict) or unique_id is None:
        return {}
    workflow = extra_pnginfo.get("workflow")
    if not isinstance(workflow, dict):
        return {}
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return {}
    uid = str(unique_id)
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if str(node.get("id")) != uid:
            continue
        props = node.get("properties")
        return dict(props) if isinstance(props, dict) else {}
    return {}


def _prop_value(props: dict[str, Any], name: str, fallback: Any) -> Any:
    if name not in props:
        return fallback
    value = props.get(name)
    if value is None:
        return fallback
    return value




CONFIG_PROPERTY_NAME = "gjj_ltx23_config"


def _json_response(payload: dict[str, Any]):
    try:
        from aiohttp import web  # type: ignore
        return web.json_response(payload)
    except Exception:
        return payload



def _resolve_segment_output_dir(preset: Any = None, unique_id: Any = None) -> str:
    """解析分段视频保存目录。这里只打开目录，不打开具体段文件。"""
    try:
        import folder_paths  # type: ignore
        output_root = Path(folder_paths.get_output_directory())
    except Exception:
        output_root = Path.cwd() / "output"

    base = str(preset or "").strip() or "video/GJJ_LTX多图分段"
    # 与 runtime 的 _format_segment_save_prefix 保持同类占位替换，但目录只取 preset 本身。
    try:
        import datetime
        now = datetime.datetime.now()
        replacements = {
            "{date}": now.strftime("%Y%m%d"),
            "{time}": now.strftime("%H%M%S"),
            "{node}": str(unique_id or "node"),
            "{segment}": "01",
            "{start}": "01",
            "{end}": "02",
        }
        for key, value in replacements.items():
            base = base.replace(key, value)
    except Exception:
        pass

    base = base.replace("\\", "/").strip().strip("/")
    # 只允许相对 output 目录；避免误传绝对路径造成打开异常。
    if not base:
        base = "video/GJJ_LTX多图分段"
    base_path = Path(base)
    if base_path.is_absolute():
        target = base_path
    else:
        target = output_root / base_path
    target.mkdir(parents=True, exist_ok=True)
    return str(target)


def _open_directory(path: str) -> None:
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


async def _gjj_ltx23_open_video_dir_endpoint(request):
    try:
        data = {}
        try:
            data = await request.json()
        except Exception:
            data = {}
        preset = data.get("preset") if isinstance(data, dict) else None
        unique_id = data.get("node") if isinstance(data, dict) else None
        target = _resolve_segment_output_dir(preset, unique_id)
        _open_directory(target)
        return _json_response({"ok": True, "path": target})
    except Exception as exc:
        return _json_response({"ok": False, "error": str(exc)})


async def _gjj_ltx23_models_endpoint(request):
    return _json_response({"models": _ltx_checkpoint_options(), "default": _default_ltx_checkpoint()})


try:
    from server import PromptServer  # type: ignore
    if getattr(PromptServer, "instance", None) is not None:
        PromptServer.instance.routes.get("/gjj/ltx23/models")(_gjj_ltx23_models_endpoint)
        PromptServer.instance.routes.post("/gjj/ltx23/open_video_dir")(_gjj_ltx23_open_video_dir_endpoint)
except Exception:
    pass


def _clean_config_defaults() -> dict[str, Any]:
    return {
        "ltx_model_name": _default_ltx_checkpoint(),
        "positive_prompt": DEFAULT_PROMPT,
        "negative_prompt": DEFAULT_NEGATIVE_PROMPT,
        "segment_seconds": DEFAULT_SEGMENT_SECONDS,
        "width": DEFAULT_WIDTH,
        "height": DEFAULT_HEIGHT,
        "fps": DEFAULT_FPS,
        "seed": DEFAULT_SEED,
        "denoise_strength": DEFAULT_DENOISE_STRENGTH,
        "transition_enabled": False,
        "transition_curve": TRANSITION_CURVES[0],
        "transition_early_tail_ratio": DEFAULT_TRANSITION_EARLY_TAIL_RATIO,
        "transition_implicit_guide_count": DEFAULT_TRANSITION_IMPLICIT_GUIDE_COUNT,
        "transition_implicit_guide_strength": DEFAULT_TRANSITION_IMPLICIT_GUIDE_STRENGTH,
        "transition_early_tail_strength": DEFAULT_TRANSITION_EARLY_TAIL_STRENGTH,
        "transition_final_guide_strength": DEFAULT_TRANSITION_FINAL_GUIDE_STRENGTH,
        "segmented_execution": True,
        "segment_save_preset": SEGMENT_SAVE_PRESETS[0],
        "segment_video_format": DEFAULT_SEGMENT_VIDEO_FORMAT,
        "transition_lora_switches": "",
    }


def _parse_json_config(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    text = str(value or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except Exception:
        return {}
    return dict(parsed) if isinstance(parsed, dict) else {}


def _config_from_workflow(extra_pnginfo: Any = None, unique_id: Any = None) -> dict[str, Any]:
    props = _find_node_properties_from_workflow(extra_pnginfo, unique_id)
    config = props.get(CONFIG_PROPERTY_NAME)
    if isinstance(config, dict):
        return dict(config)
    if isinstance(config, str):
        return _parse_json_config(config)
    # 兼容早期直接写 properties 的版本
    fallback: dict[str, Any] = {}
    for key in _clean_config_defaults().keys():
        if key in props:
            fallback[key] = props.get(key)
    return fallback


def _workflow_node_by_id(extra_pnginfo: Any = None, unique_id: Any = None) -> dict[str, Any]:
    if unique_id is None or not isinstance(extra_pnginfo, dict):
        return {}
    workflow = extra_pnginfo.get("workflow")
    if not isinstance(workflow, dict):
        return {}
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return {}
    for node in nodes:
        if isinstance(node, dict) and str(node.get("id")) == str(unique_id):
            return node
    return {}


def _looks_number(value: Any) -> bool:
    try:
        float(value)
        return True
    except Exception:
        return False


def _main_widget_values_from_workflow(extra_pnginfo: Any = None, unique_id: Any = None) -> dict[str, Any]:
    """读取当前工作流保存的原生 widget 值，避免旧 config_json 覆盖面板显示值。

    部分 ComfyUI/前端版本会在 widgets_values 前面插入 DOM/隐藏值，导致固定下标错位。
    这里会扫描一段类似：模型名、正向、反向、场景秒数、宽、高、fps、seed、denoise 的连续结构。
    """
    node = _workflow_node_by_id(extra_pnginfo, unique_id)
    values = node.get("widgets_values") if isinstance(node, dict) else None
    if not isinstance(values, list):
        return {}

    def build_from_offset(offset: int) -> dict[str, Any]:
        return {key: values[offset + index] for index, key in enumerate(MAIN_WIDGET_PARAM_KEYS) if offset + index < len(values)}

    # 优先匹配完整主参数结构。
    for offset in range(0, max(1, len(values) - len(MAIN_WIDGET_PARAM_KEYS) + 1)):
        chunk = values[offset: offset + len(MAIN_WIDGET_PARAM_KEYS)]
        if len(chunk) < len(MAIN_WIDGET_PARAM_KEYS):
            continue
        model_text = str(chunk[0] or "").lower()
        if ("ltx" in model_text or model_text.endswith(".safetensors")) and _looks_number(chunk[3]) and _looks_number(chunk[4]) and _looks_number(chunk[5]) and _looks_number(chunk[6]) and _looks_number(chunk[7]) and _looks_number(chunk[8]):
            return build_from_offset(offset)

    # 兜底：旧版 v5 顺序。
    mapped: dict[str, Any] = {}
    for index, key in enumerate(MAIN_WIDGET_PARAM_KEYS):
        if index < len(values):
            mapped[key] = values[index]
    return mapped


def _resolve_clean_config(config_json: Any = None, extra_pnginfo: Any = None, unique_id: Any = None) -> dict[str, Any]:
    config = _clean_config_defaults()
    config.update(_config_from_workflow(extra_pnginfo, unique_id))
    config.update(_parse_json_config(config_json))
    # 数值安全化
    config["ltx_model_name"] = str(config.get("ltx_model_name") or _default_ltx_checkpoint())
    config["positive_prompt"] = str(config.get("positive_prompt") or DEFAULT_PROMPT)
    config["negative_prompt"] = str(config.get("negative_prompt") or DEFAULT_NEGATIVE_PROMPT)
    config["segment_seconds"] = _safe_float(config.get("segment_seconds"), DEFAULT_SEGMENT_SECONDS, 0.1, 3600.0)
    config["width"] = int(_safe_float(config.get("width"), DEFAULT_WIDTH, 64, 8192))
    config["height"] = int(_safe_float(config.get("height"), DEFAULT_HEIGHT, 64, 8192))
    config["fps"] = int(_safe_float(config.get("fps"), DEFAULT_FPS, 1, 120))
    config["seed"] = int(_safe_float(config.get("seed"), DEFAULT_SEED, 0, 0xFFFFFFFFFFFFFFFF))
    config["denoise_strength"] = _safe_float(config.get("denoise_strength"), DEFAULT_DENOISE_STRENGTH, 0.0, 1.0)
    config["transition_enabled"] = _safe_bool(config.get("transition_enabled"), False)
    config["transition_curve"] = str(config.get("transition_curve") or TRANSITION_CURVES[0])
    config["transition_early_tail_ratio"] = _safe_float(config.get("transition_early_tail_ratio"), DEFAULT_TRANSITION_EARLY_TAIL_RATIO, 0.10, 0.95)
    config["transition_implicit_guide_count"] = int(_safe_float(config.get("transition_implicit_guide_count"), DEFAULT_TRANSITION_IMPLICIT_GUIDE_COUNT, 0, 4))
    config["transition_implicit_guide_strength"] = _safe_float(config.get("transition_implicit_guide_strength"), DEFAULT_TRANSITION_IMPLICIT_GUIDE_STRENGTH, 0.0, 1.0)
    config["transition_early_tail_strength"] = _safe_float(config.get("transition_early_tail_strength"), DEFAULT_TRANSITION_EARLY_TAIL_STRENGTH, 0.0, 1.0)
    config["transition_final_guide_strength"] = _safe_float(config.get("transition_final_guide_strength"), DEFAULT_TRANSITION_FINAL_GUIDE_STRENGTH, 0.0, 1.0)
    config["segmented_execution"] = _safe_bool(config.get("segmented_execution"), False)
    config["segment_save_preset"] = str(config.get("segment_save_preset") or SEGMENT_SAVE_PRESETS[0])
    config["segment_video_format"] = str(config.get("segment_video_format") or DEFAULT_SEGMENT_VIDEO_FORMAT)
    config["transition_lora_switches"] = str(config.get("transition_lora_switches") or "").strip()
    return config


class GJJ_LTX23ImageToVideoMultiRef:
    DESCRIPTION = """
🎬 GJJ · LTX 2.3 多图参考 / 首尾帧 / 多图分段视频节点

✨ 功能详情：
- 🖼️ 支持单图 IMAGE、批量图 GJJ_BATCH_IMAGE、多场景输入。
- 🎞️ 2 张图自动走"首尾帧"源工作流复刻。
- 🧩 3 张及以上自动按相邻两图分段，每段走首尾帧源工作流。
- 🔁 支持转场 LoRA 自动搜索与触发词 zhuanchang 自动添加。
- 🎚️ 支持"转场LoRA序列"：1=启用，0=关闭，例如 1,0,1。
- 📁 支持分段保存，并可打开视频输出目录。

📦 用到的模型目录与文件：
- 🧠 主模型：models/diffusion_models/
  · 优先匹配：ltx-2.3-22b
  · 其次匹配：ltx23 / ltx
- 🎥 视频 VAE：models/vae/
  · 推荐：LTX23_video_vae_bf16.safetensors
  · 自动关键词：video_vae
- 🔊 音频 VAE：models/vae/
  · 推荐：LTX23_audio_vae_bf16.safetensors
  · 自动关键词：audio_vae
- 📝 文本编码器：models/text_encoders/
  · 推荐：gemma_3_12B_it_fp8_e4m3fn.safetensors
  · 兼容：gemma_3_12B_it.safetensors / gemma-3-12b-it...
- 🔍 Latent 放大模型：models/latent_upscale_models/
  · 推荐：ltx-2.3-spatial-upscaler-x2-1.0.safetensors
  · 自动关键词：ltx-2.3-spatial-upscaler
- 🧬 转场 LoRA：models/loras/
  · 自动搜索关键词：ltx2.3-transition
  · 触发词：zhuanchang
  · 示例：LTX/ltx2.3-transition-转场-强度1-触发词-zhuanchang.safetensors

💡 使用建议：
- 双图首尾帧：批量图片队列 → 场景1。
- 多图转场：多张图批量输入 → 场景1，或依次接入场景口。
- 不想某段使用转场 LoRA：在"转场LoRA序列"里填 0。

📦 运行时依赖：
  • torch (深度学习框架)
  • numpy (数值计算)
""" if _DEPENDENCIES_AVAILABLE else f"""
❌ 节点 GJJ · 🎬 LTX图文生视频多图参考器 缺少必需的 Python 依赖

📦 必需依赖（请安装）：
  • torch（深度学习框架）
  • numpy（数值计算）

🔧 PowerShell 中执行安装命令（自动适配您的环境，使用清华镜像）：
{get_pip_install_command_text("torch numpy")}

💡 提示：安装后请重启 ComfyUI 服务器。

原始错误：{_IMPORT_ERROR}
"""
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    DESCRIPTION = "LTX-2.3 清爽版图文/音频视频节点：Python 只保留真实输入口，复杂 UI 全部由前端 DOM 面板写入 config_json / node.properties。无输入=T2V；一张图片=I2V；有音频=S2V；音频+图片=数字人；两张图片=首尾帧；多张图片=多图参考。"
    SEARCH_ALIASES = ["ltx 图生视频", "ltx 文生视频", "ltx 图文生视频", "ltx 多图参考", "ltx i2v multiref", "ltx t2v", "图生视频多图参考", "动态场景视频", "ltx 数字人", "talking head"]
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频生成结果",)
    OUTPUT_TOOLTIPS = ("自动识别：无输入=T2V；一张图片=I2V；有音频=S2V；音频+图片=数字人；两张图片=首尾帧（严格复刻最新工作流）；多张图片=多图参考。",)
    INPUT_IS_LIST = True

    GJJ_HELP = {
        "models": [
            {
                "label": "🧠 LTX 2.3 主模型",
                "value": "📁models/diffusion_models/ltx-2.3-22b.safetensors",
                "tooltip": "📘LTX 2.3 主扩散模型；优先匹配 ltx-2.3-22b，其次匹配 ltx23 / ltx。",
            },
            {
                "label": "🎥 LTX 视频 VAE",
                "value": "📁models/vae/LTX23_video_vae_bf16.safetensors",
                "tooltip": "📘LTX 视频 VAE 模型；自动搜索包含 video_vae 的 safetensors 文件。",
            },
            {
                "label": "🔊 LTX 音频 VAE",
                "value": "📁models/vae/LTX23_audio_vae_bf16.safetensors",
                "tooltip": "📘LTX 音频 VAE 模型；自动搜索包含 audio_vae 的 safetensors 文件。",
            },
            {
                "label": "📝 Gemma 3 12B 文本编码器",
                "value": "📁models/text_encoders/gemma_3_12B_it_fp8_e4m3fn.safetensors",
                "tooltip": "📘Gemma 3 12B 文本编码器；推荐 fp8 量化版本。",
            },
            {
                "label": "🔍 Latent 放大模型",
                "value": "📁models/latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.0.safetensors",
                "tooltip": "📘Latent 空间放大模型；自动搜索包含 ltx-2.3-spatial-upscaler 的文件。",
            },
            {
                "label": "🧬 LTX 2.3 转场 LoRA",
                "value": "📁models/loras/ltx2.3-transition-转场-强度1-触发词-zhuanchang.safetensors",
                "tooltip": "📘转场 LoRA 模型；自动搜索包含 ltx2.3-transition 的 lora 文件，触发词为 zhuanchang。",
            },
        ],
        "dependencies": [
            "torch（深度学习框架）",
            "numpy（数值计算）",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            # Clean v8：主执行参数使用 Python 原生 widget，
            # 小圆点会出现在字段前面；连接时自动覆盖字段值。
            "required": {
                "ltx_model_name": (
                    _ltx_checkpoint_options(),
                    {
                        "default": _default_ltx_checkpoint(),
                        "display_name": "LTX主模型",
                        "tooltip": "🧠 主模型目录：models/diffusion_models。优先匹配 ltx-2.3-22b，其次匹配 ltx23 / ltx。",
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_PROMPT,
                        "multiline": True,
                        "display_name": "正向提示词",
                        "tooltip": "📝 正向提示词。启用转场 LoRA 的段会自动在前面补 zhuanchang；也可从字段前接入 STRING 覆盖。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE_PROMPT,
                        "multiline": True,
                        "display_name": "反向提示词",
                        "tooltip": "🚫 反向提示词。用于避免水印、文字、画面抖动、畸形等问题；可从字段前接入 STRING 覆盖。",
                    },
                ),
                "segment_seconds": (
                    "FLOAT",
                    {
                        "default": DEFAULT_SEGMENT_SECONDS,
                        "min": 0.1,
                        "max": 600.0,
                        "step": 0.1,
                        "display_name": "场景间隔（秒）",
                        "tooltip": "每段/场景间隔秒数。可在字段前接入 FLOAT 覆盖。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": DEFAULT_WIDTH,
                        "min": 64,
                        "max": 8192,
                        "step": 32,
                        "display_name": "宽度",
                        "tooltip": "目标宽度。LTX 内部会按画幅等比例适配场景图。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": DEFAULT_HEIGHT,
                        "min": 64,
                        "max": 8192,
                        "step": 32,
                        "display_name": "高度",
                        "tooltip": "目标高度。LTX 内部会按画幅等比例适配场景图。",
                    },
                ),
                "fps": (
                    "INT",
                    {
                        "default": DEFAULT_FPS,
                        "min": 1,
                        "max": 120,
                        "step": 1,
                        "display_name": "帧率",
                        "tooltip": "输出帧率。可在字段前接入 INT 覆盖。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": DEFAULT_SEED,
                        "min": 0,
                        "max": 0xffffffffffffffff,
                        "step": 1,
                        "display_name": "种子",
                        "tooltip": "随机种。可在字段前接入 INT 覆盖。",
                    },
                ),
                "denoise_strength": (
                    "FLOAT",
                    {
                        "default": DEFAULT_DENOISE_STRENGTH,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪",
                        "tooltip": "降噪强度。可在字段前接入 FLOAT 覆盖。",
                    },
                ),
            },
            "optional": FlexibleSceneInputType(
                {
                    "input_audio": (
                        "AUDIO",
                        {
                            "display_name": "驱动音频",
                            "tooltip": "🔊 可选驱动音频。接入 AUDIO 后自动切换为 S2V / 数字人流程；音频 VAE 位于 models/vae。",
                        },
                    ),
                    "lora_chain_config": (
                        "LORA_CHAIN_CONFIG",
                        {
                            "display_name": "LoRA串联配置",
                            "tooltip": "🧬 可选 LoRA 串联配置。转场 LoRA 默认会在 models/loras 中按 ltx2.3-transition 自动搜索并按段启用。",
                        },
                    ),
                    f"{SCENE_PREFIX}01": _scene_input_spec(1),
                }
            ),
            "hidden": {
                "config_json": ("STRING", {"default": "{}"}),
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def generate(
        self,
        ltx_model_name=None,
        positive_prompt=None,
        negative_prompt=None,
        segment_seconds=None,
        width=None,
        height=None,
        fps=None,
        seed=None,
        denoise_strength=None,
        config_json="{}",
        extra_pnginfo=None,
        unique_id=None,
        **kwargs,
    ):
        # ⬅ 使用公共函数加载核心运行时依赖
        load_dependency_at_runtime("torch", "GJJ · 🎬 LTX图文生视频多图参考器")
        load_dependency_at_runtime("numpy", "GJJ · 🎬 LTX图文生视频多图参考器")

        config_json = _unwrap_single_value(config_json)
        extra_pnginfo = _unwrap_single_value(extra_pnginfo)
        unique_id = _unwrap_single_value(unique_id)
        config = _resolve_clean_config(config_json=config_json, extra_pnginfo=extra_pnginfo, unique_id=unique_id)

        # Clean v40：参数优先级：
        # 1) 当前原生字段/外联输入（ComfyUI 会作为函数参数传入）
        # 2) 工作流 widget_values 兜底
        # 3) config_json 里的高级参数/旧值
        widget_values = _main_widget_values_from_workflow(extra_pnginfo, unique_id)
        if widget_values:
            config = _resolve_clean_config(config_json=_apply_external_param_overrides(config, widget_values), extra_pnginfo=None, unique_id=None)
        explicit_values = _unwrap_main_params({
            "ltx_model_name": ltx_model_name,
            "positive_prompt": positive_prompt,
            "negative_prompt": negative_prompt,
            "segment_seconds": segment_seconds,
            "width": width,
            "height": height,
            "fps": fps,
            "seed": seed,
            "denoise_strength": denoise_strength,
        })
        config = _resolve_clean_config(config_json=_apply_external_param_overrides(config, explicit_values), extra_pnginfo=None, unique_id=None)
        # INPUT_IS_LIST=True 后，kwargs 中可能包含列表。主参数需要解包；场景输入保留列表用于多图合并。
        config = _resolve_clean_config(config_json=_apply_external_param_overrides(config, _unwrap_main_params(kwargs)), extra_pnginfo=None, unique_id=None)

        moved_scene_payloads = _pop_miswired_scene_payloads(kwargs)
        legacy_batch_scene_images = _split_scene_batch(kwargs.get("batch_scenes", kwargs.get("scene_batch")))
        if moved_scene_payloads:
            legacy_batch_scene_images.extend(_flatten_scene_values(moved_scene_payloads))
        scene_items = _collect_scene_items(kwargs)
        socket_scene_values = [value for _, _, value in scene_items]
        socket_scene_images = _flatten_scene_values(socket_scene_values)
        scene_source_summary = _summarize_scene_sources(scene_items, len(legacy_batch_scene_images))
        if moved_scene_payloads:
            scene_source_summary = (scene_source_summary + "，" if scene_source_summary else "") + f"错位口转场景={len(_flatten_scene_values(moved_scene_payloads))}"
        scene_images, skipped_placeholders = _filter_valid_scene_images(legacy_batch_scene_images + socket_scene_images)
        scene_images, duplicate_removed = _dedupe_scene_images(scene_images)
        if duplicate_removed:
            _send_status(unique_id, f"Clean v40 场景去重：移除 {duplicate_removed} 个重复图片连接，避免批量口+单图口重复导致误入分段执行。")
            print(f"[GJJ LTX2.3 Clean v40] scene dedupe removed={duplicate_removed}", flush=True)
        target_width, target_height, target_source = _resolve_target_size_from_config_and_scenes(config, scene_images)
        scene_images, target_width, target_height = _normalize_ltx_scene_images(scene_images, target_width, target_height)
        _send_status(unique_id, f"Clean v40 输入统计：{scene_source_summary}；有效场景 {len(scene_images)} 张；重复移除 {duplicate_removed}；目标尺寸 {target_width}x{target_height}（{target_source} / 8倍数对齐 / INPUT_IS_LIST）")
        debug_parts = [f"{name}={_debug_value_signature(value)}→{_count_split_images(value)}" for name, _, value in scene_items]
        _send_status(unique_id, f"Clean v40 调试：scene_items={len(scene_items)}；socket拆分={len(socket_scene_images)}；legacy拆分={len(legacy_batch_scene_images)}；" + ("；".join(debug_parts) if debug_parts else "无"))
        print("[GJJ LTX2.3 Clean v40] scene debug:", " | ".join(debug_parts) if debug_parts else "no scene", flush=True)
        if len(scene_items) == 1 and len(socket_scene_images) == 1:
            _send_status(unique_id, "Clean v40 提示：当前 LTX 只收到 1 张图；Clean v40 已在 LTX 内部直接解包 GJJ_BATCH_IMAGE / 自定义批量容器。若仍只有 1 张，说明上游传来的确实就是单张 IMAGE，而不是批量容器；可临时把 图片1/图片2 分别接入 场景1/场景2。")
        _send_status(
            unique_id,
            f"Clean v40 执行参数：model={config['ltx_model_name']}；width={config['width']}；height={config['height']}；fps={config['fps']}；seed={config['seed']}；denoise={config['denoise_strength']:.2f}；segment={config['segment_seconds']}",
        )
        try:
            print(
                f"[GJJ LTX2.3 Clean v40] generate: "
                f"explicit(width={width}, height={height}, fps={fps}) | "
                f"config(width={config['width']}, height={config['height']}, fps={config['fps']}) | "
                f"target={target_width}x{target_height} | "
                f"scene_items={len(scene_items)} socket拆分={len(socket_scene_images)} legacy拆分={len(legacy_batch_scene_images)} total={len(scene_images)} | "
                f"sources={scene_source_summary}",
                flush=True,
            )
        except Exception:
            pass
        input_audio = _unwrap_single_value(kwargs.get("input_audio"))
        has_input_audio = input_audio is not None

        route_key, route_label, route_tip = _resolve_auto_route(len(scene_images), has_input_audio)
        resolved_payload = _resolve_prompt_payload(
            positive_prompt=config["positive_prompt"],
            negative_prompt=config["negative_prompt"],
            fps=config["fps"],
            segment_seconds=config["segment_seconds"],
            scene_count=len(scene_images),
            has_input_audio=has_input_audio,
        )
        guide_images, guide_times, duration_seconds = _build_scene_schedule(
            scene_images,
            float(resolved_payload["segment_seconds"]),
            resolved_payload.get("total_duration_override"),
        )
        mode = MODE_AUDIO_CONDITIONED if has_input_audio else MODE_GENERATED_AUDIO
        frame_trim_start = 0 if scene_images else (DEFAULT_FRAME_TRIM_START_AUDIO if has_input_audio else DEFAULT_FRAME_TRIM_START_VIDEO)
        lora_value_for_transition = _unwrap_single_value(kwargs.get("lora_chain_config", ""))
        transition_lora_detected = _lora_chain_has_transition_lora(lora_value_for_transition)
        transition_enabled_effective = (bool(config["transition_enabled"]) or transition_lora_detected) and len(scene_images) >= 2
        transition_options = {
            "enabled": transition_enabled_effective,
            "curve": str(config["transition_curve"] or TRANSITION_CURVES[0]),
            "early_tail_ratio": config["transition_early_tail_ratio"],
            "implicit_guide_count": int(config["transition_implicit_guide_count"]),
            "implicit_guide_strength": config["transition_implicit_guide_strength"],
            "early_tail_strength": config["transition_early_tail_strength"],
            "final_guide_strength": config["transition_final_guide_strength"],
            "lora_switches": config["transition_lora_switches"],
        }
        if skipped_placeholders and unique_id:
            _send_status(unique_id, f"提示：已忽略 {skipped_placeholders} 张 64x64 空占位场景图。")
        if unique_id:
            _send_status(
                unique_id,
                f"Clean v40 分支：{route_label}（{route_key}）。来源：{scene_source_summary}；有效场景 {len(scene_images)} 张。{route_tip}",
            )
            if len(scene_images) == 2:
                _send_status(unique_id, "Clean v40 首尾帧链路提示：检测到 2 张有效场景，将按首帧+尾帧分支处理。")
            if transition_enabled_effective:
                _send_status(unique_id, f"Clean v40 转场控制：已启用；来源={'转场LoRA自动启用' if transition_lora_detected and not bool(config['transition_enabled']) else '面板开关'}；隐式guide={int(config['transition_implicit_guide_count'])}；曲线={config['transition_curve']}")
            if str(config.get("transition_lora_switches") or "").strip():
                _send_status(unique_id, f"Clean v40 转场LoRA序列：{config['transition_lora_switches']}")
            if bool(config["transition_enabled"]) and len(scene_images) < 2:
                _send_status(unique_id, "提示：转场控制需要至少两张有效场景图，当前已自动跳过。")

        return _run_ltx23_multiref_video(
            mode=mode,
            checkpoint_name=config["ltx_model_name"],
            positive_prompt=resolved_payload["positive_prompt"],
            negative_prompt=resolved_payload["negative_prompt"],
            main_image=scene_images[0] if scene_images else None,
            guide_images=guide_images,
            guide_times=guide_times,
            fps=resolved_payload["fps"],
            output_long_edge=None,
            target_width=target_width,
            target_height=target_height,
            seed=config["seed"],
            duration_seconds=duration_seconds,
            input_audio=input_audio,
            lora_chain_config=_unwrap_single_value(kwargs.get("lora_chain_config", "")),
            decode_generated_audio=bool(resolved_payload["decode_generated_audio"]),
            frame_trim_start=frame_trim_start,
            segmented_execution=bool(config["segmented_execution"]),
            segment_save_preset=config["segment_save_preset"],
            segment_video_format=config["segment_video_format"],
            transition_options=transition_options,
            denoise_strength=config["denoise_strength"],
            branch_debug={
                "route_key": route_key,
                "route_label": route_label,
                "scene_count": len(scene_images),
                "source_summary": f"{scene_source_summary}；目标{target_width}x{target_height}",
                "has_audio": has_input_audio,
            },
            unique_id=unique_id,
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTX23ImageToVideoMultiRef}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·🎬多功能LTX视频生成器 🧡"}
