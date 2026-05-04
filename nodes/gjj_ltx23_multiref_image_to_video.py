from __future__ import annotations

import json
from typing import Any

import torch

from .gjj_batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .gjj_video_combine_runtime import DEFAULT_FORMAT as DEFAULT_SEGMENT_VIDEO_FORMAT, list_supported_formats
from .gjj_ltx23_multiref_runtime import (
    DEFAULT_NEGATIVE_PROMPT,
    MODE_AUDIO_CONDITIONED,
    MODE_GENERATED_AUDIO,
    _send_status,
    run_ltx23_multiref_video,
)


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


def _segment_video_format_options() -> list[str]:
    formats = [item for item in list_supported_formats() if str(item).startswith("video/")]
    if DEFAULT_SEGMENT_VIDEO_FORMAT not in formats:
        formats.insert(0, DEFAULT_SEGMENT_VIDEO_FORMAT)
    return formats or [DEFAULT_SEGMENT_VIDEO_FORMAT]


def _scene_input_spec(index: int):
    return (
        "IMAGE",
        {
            "display_name": f"场景{int(index)}",
            "tooltip": (
                "可选起始场景图。新连接图片时会同步面板宽高；留空时走文生视频；连上当前最后一张场景图后，会自动扩展下一张输入。"
                if int(index) <= 1
                else "场景参考图。中间图会作为过渡帧，当前最后一张会作为结束帧。连上当前最后一张场景图后，会自动扩展下一张输入。"
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


def _collect_scene_images(kwargs: dict[str, Any]) -> list[Any]:
    items: list[tuple[int, Any]] = []
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
        items.append((_extract_scene_index(text), value))
    items.sort(key=lambda item: item[0])
    return [value for _, value in items]


def _is_empty_loader_placeholder(image: Any) -> bool:
    if not isinstance(image, torch.Tensor):
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
    if value is None:
        return []
    if not isinstance(value, torch.Tensor):
        return [value]
    if value.ndim == 3:
        return [value.unsqueeze(0)]
    if value.ndim != 4:
        return [value]
    images: list[Any] = []
    for index in range(int(value.shape[0])):
        images.append(value[index:index + 1].contiguous())
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


class GJJ_LTX23ImageToVideoMultiRef:
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    DESCRIPTION = "LTX-2.3 图文生视频多图参考器：0 图走文生视频，1 图走图生视频，多图可整体参考生成，也可按相邻两图分段执行并逐段保存预览；接入驱动音频后自动切到数字人流程，整段音频会直接决定总帧数，建议先用短音频测试；LoRA 统一通过 LoRA串联配置接入。"
    SEARCH_ALIASES = ["ltx 图生视频", "ltx 文生视频", "ltx 图文生视频", "ltx 多图参考", "ltx i2v multiref", "ltx t2v", "图生视频多图参考", "动态场景视频", "ltx 数字人", "talking head"]
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频生成结果",)
    OUTPUT_TOOLTIPS = ("基于输入图片数量自动切换文生 / 图生 / 多图参考的视频结果。无宽高直连时使用面板显示宽高；接入新图片会同步面板宽高，之后可手动修改；接入音频时保留原音轨，不接音频时输出模型生成音轨。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_PROMPT,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "正向提示词",
                        "tooltip": "支持直接输入普通提示词，也支持接入 JSON 字符串提示词。检测到合法 JSON 时，会优先使用其中的 prompt，并同步读取兼容的 parameters 字段。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_NEGATIVE_PROMPT,
                        "multiline": False,
                        "dynamicPrompts": True,
                        "display_name": "反向提示词",
                        "tooltip": "用于压制字幕、水印、抖动、结构错乱和常见 LTX 伪影。",
                    },
                ),
                "segment_seconds": (
                    "FLOAT",
                    {
                        "default": DEFAULT_SEGMENT_SECONDS,
                        "min": 0.1,
                        "max": 3600.0,
                        "step": 0.1,
                        "display_name": "场景间隔（秒）",
                        "tooltip": "相邻两张场景图之间的默认时长。不接音频时也会决定总时长；0 图或只接 1 张图时，这个值就是整段视频时长。默认 5 秒。",
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
                        "tooltip": "最终视频帧宽度。无外部宽度直连时，当前面板显示值就是运算值；新连接图片会先同步为图片宽度，之后可手动修改。",
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
                        "tooltip": "最终视频帧高度。无外部高度直连时，当前面板显示值就是运算值；新连接图片会先同步为图片高度，之后可手动修改。",
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
                        "tooltip": "工作流原始默认值为 24。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": DEFAULT_SEED,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "display_name": "种子",
                        "tooltip": "第一阶段使用这个种子，第二阶段会自动用 seed + 1。",
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
                        "tooltip": "采样降噪强度。1.00 表示完整采样；降低会从更低噪声段开始，变化更小但可能更弱。会同时作用于第一阶段和第二阶段采样。",
                    },
                ),
                "transition_enabled": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "转场控制",
                        "tooltip": "至少有两张场景图时可启用。开启后会对相邻首尾帧增加提前尾帧和中间隐式 guide，以缓解前慢后快和尾帧突然跳变。",
                    },
                ),
                "transition_curve": (
                    TRANSITION_CURVES,
                    {
                        "default": TRANSITION_CURVES[0],
                        "display_name": "过渡曲线",
                        "tooltip": "控制中间隐式 guide 从首帧混合到尾帧的节奏。前置过渡会更早接近尾帧，后置过渡会更晚接近尾帧。",
                    },
                ),
                "transition_early_tail_ratio": (
                    "FLOAT",
                    {
                        "default": DEFAULT_TRANSITION_EARLY_TAIL_RATIO,
                        "min": 0.10,
                        "max": 0.95,
                        "step": 0.01,
                        "display_name": "尾帧提前注入",
                        "tooltip": "尾帧参考提前注入到片段中的位置比例。0.75 表示在片段 75% 处先注入一次尾帧，再在终点注入尾帧。",
                    },
                ),
                "transition_implicit_guide_count": (
                    "INT",
                    {
                        "default": DEFAULT_TRANSITION_IMPLICIT_GUIDE_COUNT,
                        "min": 0,
                        "max": 4,
                        "step": 1,
                        "display_name": "中间隐式guide",
                        "tooltip": "在首尾帧之间自动生成的混合参考帧数量。数量越多越稳，但也会增加参考约束和计算压力。",
                    },
                ),
                "transition_implicit_guide_strength": (
                    "FLOAT",
                    {
                        "default": DEFAULT_TRANSITION_IMPLICIT_GUIDE_STRENGTH,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "隐式guide强度",
                        "tooltip": "中间隐式 guide 的约束强度。过高会更贴参考但可能降低运动自由度。",
                    },
                ),
                "transition_early_tail_strength": (
                    "FLOAT",
                    {
                        "default": DEFAULT_TRANSITION_EARLY_TAIL_STRENGTH,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "提前尾帧强度",
                        "tooltip": "提前注入尾帧时的约束强度，用于让模型更早感知终点画面。",
                    },
                ),
                "transition_final_guide_strength": (
                    "FLOAT",
                    {
                        "default": DEFAULT_TRANSITION_FINAL_GUIDE_STRENGTH,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "终点guide强度",
                        "tooltip": "片段末尾尾帧 guide 的约束强度。通常保持 1.00。",
                    },
                ),
                "segmented_execution": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "多图分段执行",
                        "tooltip": "开启后，2 张以上场景图会按 场景1→场景2、场景2→场景3 逐段生成；每段保存后立即推送到节点面板预览。接入驱动音频时会自动回到整体执行。",
                    },
                ),
                "segment_save_preset": (
                    SEGMENT_SAVE_PRESETS,
                    {
                        "default": SEGMENT_SAVE_PRESETS[0],
                        "display_name": "分段保存位置预设",
                        "tooltip": "分段视频保存到 ComfyUI output 下的子目录。支持 {date}、{time}、{node} 占位符，并会自动追加段号和场景号。",
                    },
                ),
                "segment_video_format": (
                    _segment_video_format_options(),
                    {
                        "default": DEFAULT_SEGMENT_VIDEO_FORMAT,
                        "display_name": "分段视频格式",
                        "tooltip": "每段预览视频的保存格式；默认使用 H.264 MP4，便于浏览器直接预览。",
                    },
                ),
            },
            "optional": FlexibleSceneInputType(
                {
                    "batch_scenes": (
                        SCENE_BATCH_INPUT_TYPE,
                        {
                            "display_name": "批量场景图",
                            "tooltip": "可直接接入 GJJ · 批量多图片加载预览器 的批量图片队列，节点会按队列顺序作为场景1、场景2继续生成。",
                        },
                    ),
                    "lora_chain_config": (
                        "LORA_CHAIN_CONFIG",
                        {
                            "display_name": "LoRA串联配置",
                            "tooltip": "可选。统一接入所有需要的 LoRA 串联配置；本节点不再提供单独 LoRA 下拉和强度面板。",
                        },
                    ),
                    "input_audio": (
                        "AUDIO",
                        {
                            "display_name": "驱动音频",
                            "tooltip": "可选。接入后自动切换为数字人流程，时长直接由音频决定，并把这段音频作为最终视频音轨；音频越长、面板宽高越大，占用显存越高，建议先用短音频测试。",
                        },
                    ),
                    **{
                        f"{SCENE_PREFIX}{index:02d}": _scene_input_spec(index)
                        for index in range(1, INITIAL_SCENE_INPUTS + 1)
                    },
                }
            ),
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        positive_prompt,
        negative_prompt,
        segment_seconds,
        width,
        height,
        fps,
        seed,
        denoise_strength=DEFAULT_DENOISE_STRENGTH,
        transition_enabled=False,
        transition_curve=TRANSITION_CURVES[0],
        transition_early_tail_ratio=DEFAULT_TRANSITION_EARLY_TAIL_RATIO,
        transition_implicit_guide_count=DEFAULT_TRANSITION_IMPLICIT_GUIDE_COUNT,
        transition_implicit_guide_strength=DEFAULT_TRANSITION_IMPLICIT_GUIDE_STRENGTH,
        transition_early_tail_strength=DEFAULT_TRANSITION_EARLY_TAIL_STRENGTH,
        transition_final_guide_strength=DEFAULT_TRANSITION_FINAL_GUIDE_STRENGTH,
        segmented_execution=False,
        segment_save_preset=SEGMENT_SAVE_PRESETS[0],
        segment_video_format=DEFAULT_SEGMENT_VIDEO_FORMAT,
        unique_id=None,
        **kwargs,
    ):
        batch_scene_images = _split_scene_batch(kwargs.get("batch_scenes", kwargs.get("scene_batch")))
        socket_scene_images = _collect_scene_images(kwargs)
        scene_images, skipped_placeholders = _filter_valid_scene_images(batch_scene_images + socket_scene_images)
        input_audio = kwargs.get("input_audio")
        resolved_payload = _resolve_prompt_payload(
            positive_prompt=positive_prompt,
            negative_prompt=negative_prompt,
            fps=fps,
            segment_seconds=segment_seconds,
            scene_count=len(scene_images),
            has_input_audio=input_audio is not None,
        )
        guide_images, guide_times, duration_seconds = _build_scene_schedule(
            scene_images,
            float(resolved_payload["segment_seconds"]),
            resolved_payload.get("total_duration_override"),
        )
        mode = MODE_AUDIO_CONDITIONED if input_audio is not None else MODE_GENERATED_AUDIO
        frame_trim_start = 0 if scene_images else (DEFAULT_FRAME_TRIM_START_AUDIO if input_audio is not None else DEFAULT_FRAME_TRIM_START_VIDEO)
        transition_options = {
            "enabled": _safe_bool(transition_enabled, False) and len(scene_images) >= 2,
            "curve": str(transition_curve or TRANSITION_CURVES[0]),
            "early_tail_ratio": _safe_float(transition_early_tail_ratio, DEFAULT_TRANSITION_EARLY_TAIL_RATIO, 0.10, 0.95),
            "implicit_guide_count": int(_safe_float(transition_implicit_guide_count, DEFAULT_TRANSITION_IMPLICIT_GUIDE_COUNT, 0, 4)),
            "implicit_guide_strength": _safe_float(transition_implicit_guide_strength, DEFAULT_TRANSITION_IMPLICIT_GUIDE_STRENGTH, 0.0, 1.0),
            "early_tail_strength": _safe_float(transition_early_tail_strength, DEFAULT_TRANSITION_EARLY_TAIL_STRENGTH, 0.0, 1.0),
            "final_guide_strength": _safe_float(transition_final_guide_strength, DEFAULT_TRANSITION_FINAL_GUIDE_STRENGTH, 0.0, 1.0),
        }
        if skipped_placeholders and unique_id:
            _send_status(unique_id, f"提示：已忽略 {skipped_placeholders} 张 64x64 空占位场景图，请优先连接批量场景图或已选图片输出。")
        if unique_id:
            route_tip = "按首帧到尾帧参与 LTX guide" if scene_images else "没有有效场景图，将走文生视频"
            _send_status(
                unique_id,
                f"提示：批量场景图收到 {len(batch_scene_images)} 张，单图场景口收到 {len(socket_scene_images)} 张；有效 {len(scene_images)} 张，{route_tip}。",
            )
            if _safe_bool(transition_enabled, False) and len(scene_images) < 2:
                _send_status(unique_id, "提示：转场控制需要至少两张有效场景图，当前已自动跳过。")
        return run_ltx23_multiref_video(
            mode=mode,
            positive_prompt=resolved_payload["positive_prompt"],
            negative_prompt=resolved_payload["negative_prompt"],
            main_image=scene_images[0] if scene_images else None,
            guide_images=guide_images,
            guide_times=guide_times,
            fps=resolved_payload["fps"],
            output_long_edge=None,
            target_width=width,
            target_height=height,
            seed=seed,
            duration_seconds=duration_seconds,
            input_audio=input_audio,
            lora_chain_config=kwargs.get("lora_chain_config", ""),
            decode_generated_audio=bool(resolved_payload["decode_generated_audio"]),
            frame_trim_start=frame_trim_start,
            segmented_execution=bool(segmented_execution),
            segment_save_preset=segment_save_preset,
            segment_video_format=segment_video_format,
            transition_options=transition_options,
            denoise_strength=_safe_float(denoise_strength, DEFAULT_DENOISE_STRENGTH, 0.0, 1.0),
            unique_id=unique_id,
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTX23ImageToVideoMultiRef}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 LTX图文生视频多图参考器 🧡"}
