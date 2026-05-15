from __future__ import annotations

import importlib
import json
from typing import Any

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
SCENE_BATCH_INPUT_TYPE = GJJ_BATCH_IMAGE_TYPE
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

# Clean v4：这些主执行参数允许从左侧输入口外联覆盖 DOM 面板/config_json。
# 仍然不把它们做成普通 Python widget，避免再次出现隐藏占位和 widget 顺序污染。
CONNECTABLE_PARAM_INPUTS = {
    "positive_prompt": ("STRING", {"forceInput": True, "display_name": "正向提示词", "tooltip": "可选外联。接入后覆盖面板里的正向提示词。"}),
    "negative_prompt": ("STRING", {"forceInput": True, "display_name": "反向提示词", "tooltip": "可选外联。接入后覆盖面板里的反向提示词。"}),
    "segment_seconds": ("FLOAT", {"forceInput": True, "display_name": "场景间隔（秒）", "tooltip": "可选外联。接入后覆盖面板里的场景间隔。"}),
    "width": ("INT", {"forceInput": True, "display_name": "宽度", "tooltip": "可选外联。接入后覆盖面板里的宽度。"}),
    "height": ("INT", {"forceInput": True, "display_name": "高度", "tooltip": "可选外联。接入后覆盖面板里的高度。"}),
    "fps": ("INT", {"forceInput": True, "display_name": "帧率", "tooltip": "可选外联。接入后覆盖面板里的帧率。"}),
    "seed": ("INT", {"forceInput": True, "display_name": "种子", "tooltip": "可选外联。接入后覆盖面板里的随机种。"}),
    "denoise_strength": ("FLOAT", {"forceInput": True, "display_name": "降噪", "tooltip": "可选外联。接入后覆盖面板里的降噪强度。"}),
}


def _apply_external_param_overrides(config: dict[str, Any], kwargs: dict[str, Any]) -> dict[str, Any]:
    """外联主参数覆盖 config_json。

    只处理真正从输入口传入的值；forceInput 口未连接时一般不会进入 kwargs，
    因而不会污染 DOM 面板默认值。
    """
    if not isinstance(config, dict):
        config = {}
    updated = dict(config)
    for key in CONNECTABLE_PARAM_INPUTS.keys():
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
                "第一张场景图输入。支持单张 IMAGE，也支持自定义批量图片 GJJ_BATCH_IMAGE；接入后会自动展开为图片列表，并显示下一张场景输入。留空时走文生视频。"
                if resolved_index <= 1
                else "追加场景参考图。中间图会作为过渡帧，当前最后一张会作为结束帧；连上当前最后一张后，会自动扩展下一张输入。"
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
        if text == "main_image" or text.startswith("guide_image_") or text.startswith("场景") or text.startswith(SCENE_PREFIX):
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
        return key in self.data or text == "main_image" or text.startswith("guide_image_") or text.startswith("场景") or text.startswith(SCENE_PREFIX)


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
        if not (
            text.startswith(SCENE_PREFIX)
            or text == "main_image"
            or text.startswith("guide_image_")
            or text.startswith("场景")
        ):
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


def _split_scene_batch(value: Any) -> list[Any]:
    """把单图 IMAGE、自定义 GJJ_BATCH_IMAGE、普通列表或 4D Tensor 统一拆成图片列表。"""
    if value is None:
        return []

    # 自定义批量图片常见包装：优先读取明确的图片字段，避免误遍历任意 dict。
    if isinstance(value, dict):
        for key in ("images", "image", "batch_images", "frames", "samples", "items", "data", "batch", "tensor", "value", "values"):
            if key in value:
                return _split_scene_batch(value.get(key))
        # 有些 GJJ 批量容器会把图片列表藏在嵌套字段里；这里做一层保守递归，
        # 只收集能继续拆出 Tensor/图片的字段，避免把整个 dict 当成 1 张图造成“批量双图只识别 1 张”。
        images = []
        for sub_value in value.values():
            if sub_value is value:
                continue
            images.extend(_split_scene_batch(sub_value))
        return images or [value]

    if isinstance(value, (list, tuple)):
        images: list[Any] = []
        for item in value:
            images.extend(_split_scene_batch(item))
        return images

    torch = _torch_module()
    if torch is None or not isinstance(value, torch.Tensor):
        return [value]
    if value.ndim == 3:
        return [value.unsqueeze(0)]
    if value.ndim != 4:
        return [value]
    images: list[Any] = []
    for index in range(int(value.shape[0])):
        images.append(value[index:index + 1].contiguous())
    return images


def _flatten_scene_values(values: list[Any]) -> list[Any]:
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

    target_width = _ceil_to_multiple(target_width, 32, 64)
    target_height = _ceil_to_multiple(target_height, 32, 64)
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
    """把单图/批量拆出的图片在 LTX 节点内部等比例缩放到面板画幅，并把宽高对齐到 32 倍数。"""
    aligned_width = _ceil_to_multiple(width, 32, DEFAULT_WIDTH)
    aligned_height = _ceil_to_multiple(height, 32, DEFAULT_HEIGHT)
    if not scene_images:
        return [], aligned_width, aligned_height
    return [
        _normalize_single_ltx_scene_image(image, aligned_width, aligned_height)
        for image in scene_images
    ], aligned_width, aligned_height


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
    if scene_count == 2:
        return "first_last", "首尾帧", "两张图片，走首尾帧流程：场景1为首帧，场景2为尾帧。"
    return "multi_ref", "多图参考", f"{scene_count} 张图片，走多图参考流程。"


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


def _ltx_checkpoint_options() -> list[str]:
    """Return diffusion model names containing "ltx" case-insensitively.

    LTX 2.3 主模型是 diffusion_models，不是 checkpoints。
    Kept lazy/defensive so importing this node remains lightweight.
    """
    try:
        import folder_paths  # type: ignore
        names = list(folder_paths.get_filename_list("diffusion_models"))
    except Exception:
        names = []
    filtered = sorted(
        [str(name) for name in names if "ltx" in str(name).lower()],
        key=lambda item: item.lower(),
    )
    return filtered or ["ltx-2.3-22b"]


def _default_ltx_checkpoint() -> str:
    options = _ltx_checkpoint_options()
    preferred_tokens = ("dasiwaltx23", "ltx23", "ltx-2.3", "ltx2.3", "ltx")
    for token in preferred_tokens:
        for name in options:
            if token in str(name).lower().replace("_", "").replace("-", ""):
                return name
    return options[0]


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


async def _gjj_ltx23_models_endpoint(request):
    return _json_response({"models": _ltx_checkpoint_options(), "default": _default_ltx_checkpoint()})


try:
    from server import PromptServer  # type: ignore
    if getattr(PromptServer, "instance", None) is not None:
        PromptServer.instance.routes.get("/gjj/ltx23/models")(_gjj_ltx23_models_endpoint)
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
        "segmented_execution": False,
        "segment_save_preset": SEGMENT_SAVE_PRESETS[0],
        "segment_video_format": DEFAULT_SEGMENT_VIDEO_FORMAT,
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
    return config


class GJJ_LTX23ImageToVideoMultiRef:
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    DESCRIPTION = "LTX-2.3 清爽版图文/音频视频节点：Python 只保留真实输入口，复杂 UI 全部由前端 DOM 面板写入 config_json / node.properties。无输入=T2V；一张图片=I2V；有音频=S2V；音频+图片=数字人；两张图片=首尾帧；多张图片=多图参考。"
    SEARCH_ALIASES = ["ltx 图生视频", "ltx 文生视频", "ltx 图文生视频", "ltx 多图参考", "ltx i2v multiref", "ltx t2v", "图生视频多图参考", "动态场景视频", "ltx 数字人", "talking head"]
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频生成结果",)
    OUTPUT_TOOLTIPS = ("自动识别：无输入=T2V；一张图片=I2V；有音频=S2V；音频+图片=数字人；两张图片=首尾帧；多张图片=多图参考。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            # Clean v3：模型/高级参数继续由 DOM 面板管理；
            # 主执行参数额外提供 forceInput 外联口，连接时覆盖 config_json，不创建普通 Python widget。
            "optional": FlexibleSceneInputType(
                {
                    "input_audio": (
                        "AUDIO",
                        {
                            "display_name": "驱动音频",
                            "tooltip": "可选。接入后自动切换为 S2V/数字人流程。",
                        },
                    ),
                    "lora_chain_config": (
                        "LORA_CHAIN_CONFIG",
                        {
                            "display_name": "LoRA串联配置",
                            "tooltip": "可选。统一接入所有需要的 LoRA 串联配置。",
                        },
                    ),
                    f"{SCENE_PREFIX}01": _scene_input_spec(1),
                    **CONNECTABLE_PARAM_INPUTS,
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
        config_json="{}",
        extra_pnginfo=None,
        unique_id=None,
        **kwargs,
    ):
        config = _resolve_clean_config(config_json=config_json, extra_pnginfo=extra_pnginfo, unique_id=unique_id)
        config = _resolve_clean_config(config_json=_apply_external_param_overrides(config, kwargs), extra_pnginfo=None, unique_id=None)

        legacy_batch_scene_images = _split_scene_batch(kwargs.get("batch_scenes", kwargs.get("scene_batch")))
        scene_items = _collect_scene_items(kwargs)
        socket_scene_values = [value for _, _, value in scene_items]
        socket_scene_images = _flatten_scene_values(socket_scene_values)
        scene_source_summary = _summarize_scene_sources(scene_items, len(legacy_batch_scene_images))
        scene_images, skipped_placeholders = _filter_valid_scene_images(legacy_batch_scene_images + socket_scene_images)
        scene_images, target_width, target_height = _normalize_ltx_scene_images(scene_images, config["width"], config["height"])
        _send_status(unique_id, f"Clean v4 输入统计：{scene_source_summary}；有效场景 {len(scene_images)} 张；目标尺寸 {target_width}x{target_height}")
        input_audio = kwargs.get("input_audio")
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
        transition_options = {
            "enabled": bool(config["transition_enabled"]) and len(scene_images) >= 2,
            "curve": str(config["transition_curve"] or TRANSITION_CURVES[0]),
            "early_tail_ratio": config["transition_early_tail_ratio"],
            "implicit_guide_count": int(config["transition_implicit_guide_count"]),
            "implicit_guide_strength": config["transition_implicit_guide_strength"],
            "early_tail_strength": config["transition_early_tail_strength"],
            "final_guide_strength": config["transition_final_guide_strength"],
        }
        if skipped_placeholders and unique_id:
            _send_status(unique_id, f"提示：已忽略 {skipped_placeholders} 张 64x64 空占位场景图。")
        if unique_id:
            _send_status(
                unique_id,
                f"Clean v3 分支：{route_label}（{route_key}）。来源：{scene_source_summary}；有效场景 {len(scene_images)} 张。{route_tip}",
            )
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
            lora_chain_config=kwargs.get("lora_chain_config", ""),
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
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 LTX图文生视频多图参考器 🧡"}
