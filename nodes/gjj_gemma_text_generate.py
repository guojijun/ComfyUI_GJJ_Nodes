from __future__ import annotations

from typing import Any

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    from .common_utils.dependency_checker import (
        DEFAULT_MODEL_URL,
        build_dependency_model_report,
        build_node_help_payload,
        make_missing_model_spec,
        print_dependency_model_report,
        raise_dependency_model_error,
        send_dependency_model_notice,
    )
except Exception:
    from common_utils.dependency_checker import (
        DEFAULT_MODEL_URL,
        build_dependency_model_report,
        build_node_help_payload,
        make_missing_model_spec,
        print_dependency_model_report,
        raise_dependency_model_error,
        send_dependency_model_notice,
    )


NODE_NAME = "GJJ_GemmaTextGenerate"
NODE_DISPLAY_NAME = "GJJ · 🧠 Gemma文本生成"
NODE_DESCRIPTION = "把官方“加载CLIP + TextGenerate”合并成一个 GJJ 零第三方依赖节点；适合 Ideogram4 / Gemma 文本生成、提示词扩写和多模态文本生成。"
DEFAULT_CLIP_NAME = "gemma_3_12B_it_fp8_e4m3fn.safetensors"
MODEL_DOWNLOAD_URL = DEFAULT_MODEL_URL
MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"

CLIP_TYPES = [
    "ideogram4",
    "stable_diffusion",
    "stable_cascade",
    "sd3",
    "stable_audio",
    "mochi",
    "ltxv",
    "pixart",
    "cosmos",
    "lumina2",
    "wan",
    "hidream",
    "chroma",
    "ace",
    "omnigen2",
    "qwen_image",
    "hunyuan_image",
    "flux2",
    "ovis",
    "longcat_image",
    "cogvideox",
    "lens",
    "pixeldit",
]

GEMMA_TEXT_ENCODER_MODELS = [
    {
        "label": "推荐 Gemma 3 12B FP8 E4M3FN",
        "path": "models/text_encoders/gemma_3_12B_it_fp8_e4m3fn.safetensors",
        "required": True,
        "description": "截图中加载 CLIP 使用的 Ideogram4/Gemma 文本生成模型；推荐作为默认。",
    },
    {
        "label": "兼容 Gemma 3 12B FP8 scaled",
        "path": "models/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors",
        "required": False,
        "description": "兼容变体；本地只有该文件时也可以手动选择。",
    },
    {
        "label": "兼容 Gemma 3 12B 原始精度",
        "path": "models/text_encoders/gemma_3_12B_it.safetensors",
        "required": False,
        "description": "显存占用更高的兼容变体。",
    },
    {
        "label": "兼容 Gemma 3 12B FP4 mixed",
        "path": "models/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors",
        "required": False,
        "description": "低显存兼容变体，质量与速度取决于本地 ComfyUI 支持情况。",
    },
]


def _filename_list(category: str) -> list[str]:
    if folder_paths is None:
        return []
    try:
        return [str(item) for item in (folder_paths.get_filename_list(category) or []) if str(item or "").strip()]
    except Exception:
        return []


def _basename(path: str) -> str:
    return str(path or "").replace("\\", "/").rsplit("/", 1)[-1]


def _text_encoder_options() -> list[str]:
    files = _filename_list("text_encoders")
    if not files:
        return [DEFAULT_CLIP_NAME]
    preferred = [item for item in files if _basename(item) == DEFAULT_CLIP_NAME]
    gemma = [item for item in files if "gemma" in _basename(item).lower()]
    rest = [item for item in files if item not in preferred and item not in gemma]
    return preferred + sorted(gemma, key=lambda item: _basename(item).lower()) + sorted(rest, key=lambda item: item.lower())


def _default_clip_name(options: list[str]) -> str:
    for item in options:
        if _basename(item) == DEFAULT_CLIP_NAME:
            return item
    for item in options:
        if "gemma" in _basename(item).lower():
            return item
    return options[0] if options else DEFAULT_CLIP_NAME


def _model_spec_for_clip(clip_name: str) -> dict[str, str]:
    filename = _basename(clip_name) or DEFAULT_CLIP_NAME
    # 确保 subdir 使用相对路径格式（不带 models/ 前缀）
    subdir = "text_encoders"
    return make_missing_model_spec(
        label="Gemma / Ideogram4 文本编码器",
        subdir=subdir,
        filename=filename,
        description=f"请把 {filename} 放到 ComfyUI/models/{subdir}/ 后重启或刷新模型列表。",
    )


def _find_text_encoder_path(clip_name: str) -> str | None:
    if folder_paths is None:
        return None
    try:
        return folder_paths.get_full_path("text_encoders", clip_name)
    except Exception:
        return None


def _available_runtime_report() -> dict[str, Any]:
    missing_models = []
    files = _filename_list("text_encoders")
    if not any(_basename(item) == DEFAULT_CLIP_NAME for item in files):
        missing_models.append(_model_spec_for_clip(DEFAULT_CLIP_NAME))
    return build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_dependencies=[],
        missing_models=missing_models,
        description=NODE_DESCRIPTION,
        model_download_url=MODEL_DOWNLOAD_URL,
    )


_ENVIRONMENT_REPORT = _available_runtime_report()
_DEPENDENCIES_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("dependencies_available", True))
_MODELS_AVAILABLE = bool(_ENVIRONMENT_REPORT.get("models_available", True))
_MISSING_DEPENDENCIES = list(_ENVIRONMENT_REPORT.get("missing_dependencies", []) or [])
_MISSING_MODELS = list(_ENVIRONMENT_REPORT.get("missing_models", []) or [])
if not (_DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE):
    print_dependency_model_report(_ENVIRONMENT_REPORT, title="GJJ Gemma 文本生成模型提示")


def _load_merged_clip(clip_name: str, clip_type: str, device: str = "default"):
    try:
        from nodes import CLIPLoader
    except Exception as exc:
        raise RuntimeError(f"无法导入 ComfyUI 官方 CLIPLoader：{exc}") from exc
    return CLIPLoader().load_clip(clip_name, clip_type, device)[0]


def _generate_text(
    clip: Any,
    prompt: str,
    max_length: int,
    sampling_mode: str,
    image: Any = None,
    video: Any = None,
    audio: Any = None,
    thinking: bool = False,
    use_default_template: bool = True,
    temperature: float = 0.7,
    top_k: int = 64,
    top_p: float = 0.95,
    min_p: float = 0.05,
    repetition_penalty: float = 1.05,
    seed: int = 0,
    presence_penalty: float = 0.0,
) -> str:
    tokens = clip.tokenize(
        str(prompt or ""),
        image=image,
        skip_template=not bool(use_default_template),
        min_length=1,
        thinking=bool(thinking),
        video=video,
        audio=audio,
    )
    do_sample = str(sampling_mode or "on") == "on"
    generated_ids = clip.generate(
        tokens,
        do_sample=do_sample,
        max_length=max(1, min(2048, int(max_length or 256))),
        temperature=float(temperature),
        top_k=int(top_k),
        top_p=float(top_p),
        min_p=float(min_p),
        repetition_penalty=float(repetition_penalty),
        presence_penalty=float(presence_penalty),
        seed=int(seed),
    )
    return str(clip.decode(generated_ids) or "")


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _coerce_media_for_textgen(media: Any | None) -> tuple[Any | None, Any | None]:
    if media is None:
        return None, None

    source = media
    is_video = False
    if hasattr(source, "get_components"):
        is_video = True
        try:
            source = source.get_components()
        except Exception as exc:
            raise RuntimeError(f"读取 VIDEO 视频帧失败：{exc}") from exc
        source = _component_value(source, "images")
        if source is None:
            raise RuntimeError("输入 VIDEO 没有解析出可用图片帧。")
    elif hasattr(source, "images"):
        source = getattr(source, "images", None)

    tensor = source
    if isinstance(source, dict):
        tensor = None
        for key in ("images", "frames", "samples"):
            candidate = source.get(key)
            if candidate is not None:
                tensor = candidate
                break
    elif isinstance(source, (list, tuple)) and source:
        try:
            import torch
            if all(isinstance(item, torch.Tensor) for item in source):
                tensor = torch.cat([item if item.ndim == 4 else item.unsqueeze(0) for item in source], dim=0)
        except Exception:
            tensor = source
    else:
        for key in ("images", "frames", "samples"):
            candidate = getattr(source, key, None)
            if candidate is not None:
                tensor = candidate
                break

    if hasattr(tensor, "ndim") and int(getattr(tensor, "ndim")) == 3:
        tensor = tensor.unsqueeze(0)
    if hasattr(tensor, "ndim") and int(getattr(tensor, "ndim")) == 4:
        try:
            if tensor.shape[-1] not in (1, 3, 4) and tensor.shape[1] in (1, 3, 4):
                tensor = tensor.permute(0, 2, 3, 1)
        except Exception:
            pass

    return (None, tensor) if is_video else (tensor, None)


class GJJ_GemmaTextGenerate:
    CATEGORY = "GJJ/LLM"
    FUNCTION = "generate"
    DESCRIPTION = (
        NODE_DESCRIPTION
        if _DEPENDENCIES_AVAILABLE and _MODELS_AVAILABLE
        else _ENVIRONMENT_REPORT.get("warning_message", NODE_DESCRIPTION)
    )
    SEARCH_ALIASES = ["TextGenerate", "Generate Text", "Gemma", "ideogram4", "文本生成", "加载CLIP"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("生成文本",)
    OUTPUT_TOOLTIPS = ("由内部加载的 Gemma/CLIP 文本生成模型生成的文本。",)
    GJJ_HELP = build_node_help_payload(
        description=NODE_DESCRIPTION,
        dependencies=[
            {
                "name": "ComfyUI 官方 CLIPLoader / TextGenerate 运行时",
                "type": "内置运行时",
                "required": True,
                "description": "节点只调用 ComfyUI 自带 CLIP 对象的 tokenize / generate / decode，不依赖其它自定义节点包。",
            }
        ],
        model_tree=GEMMA_TEXT_ENCODER_MODELS,
        models=[_model_spec_for_clip(DEFAULT_CLIP_NAME)],
        usage=[
            "选择 CLIP 名称和类型后，直接填写提示词执行。",
            "可选连接统一媒体输入口：IMAGE / GJJ_BATCH_IMAGE 会作为图像输入；官方 VIDEO 会自动读取视频帧作为 video 输入。",
            "默认类型 ideogram4 对应截图中的加载 CLIP 类型。",
            "采样模式为 off 时会关闭随机采样，仅保留最大长度等基础参数。",
        ],
        runtime=[
            "内部等价于：CLIPLoader.load_clip(...) -> clip.tokenize(...) -> clip.generate(...) -> clip.decode(...)。",
            "统一媒体口兼容 GJJ_BATCH_IMAGE、IMAGE、VIDEO；模型是否支持图像/视频 token 取决于所选 Gemma/CLIP 文件。",
        ],
        model_download_url=MODEL_DOWNLOAD_URL,
        copy_text=MODEL_DOWNLOAD_URL,
        copy_label="🌏 复制模型下载地址",
        notice=_ENVIRONMENT_REPORT.get("warning_message", ""),
    )

    @classmethod
    def INPUT_TYPES(cls):
        clip_options = _text_encoder_options()
        default_clip = _default_clip_name(clip_options)
        return {
            "required": {
                "clip_name": (clip_options, {
                    "default": default_clip,
                    "display_name": "CLIP 名称",
                    "tooltip": "选择 text_encoders 目录下的 Gemma / Ideogram4 文本编码器。默认优先 gemma_3_12B_it_fp8_e4m3fn.safetensors。",
                }),
                "clip_type": (CLIP_TYPES, {
                    "default": "ideogram4",
                    "display_name": "CLIP 类型",
                    "tooltip": "传给官方 CLIPLoader 的类型。截图中的类型为 ideogram4。",
                }),
                "clip_device": (["default", "cpu"], {
                    "default": "default",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "加载设备",
                    "tooltip": "default 使用 ComfyUI 默认设备；cpu 可强制把 CLIP 加载到 CPU。",
                }),
                "prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "dynamicPrompts": True,
                    "forceInput": True,
                    "display_name": "提示词",
                    "tooltip": "发送给文本生成模型的输入提示词。",
                }),
                "max_length": ("INT", {
                    "default": 2048,
                    "min": 1,
                    "max": 2048,
                    "step": 1,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "最大长度",
                    "tooltip": "生成文本的最大 token 长度。",
                }),
                "sampling_mode": (["on", "off"], {
                    "default": "on",
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "采样模式",
                    "tooltip": "on 开启随机采样参数；off 关闭随机采样。",
                }),
                "temperature": ("FLOAT", {
                    "default": 0.7,
                    "min": 0.01,
                    "max": 2.0,
                    "step": 0.000001,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "温度",
                    "tooltip": "采样温度。越高越发散，越低越稳定。",
                }),
                "top_k": ("INT", {
                    "default": 64,
                    "min": 0,
                    "max": 1000,
                    "step": 1,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "Top K",
                    "tooltip": "只从概率最高的 K 个 token 中采样；0 通常表示不限制。",
                }),
                "top_p": ("FLOAT", {
                    "default": 0.95,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "Top P",
                    "tooltip": "核采样阈值。",
                }),
                "min_p": ("FLOAT", {
                    "default": 0.05,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "最小概率",
                    "tooltip": "按最高概率 token 的相对比例过滤低概率候选。",
                }),
                "repetition_penalty": ("FLOAT", {
                    "default": 1.05,
                    "min": 0.0,
                    "max": 5.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "重复惩罚",
                    "tooltip": "抑制重复文本片段。1.0 基本不惩罚。",
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 0xFFFFFFFFFFFFFFFF,
                    "step": 1,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "种子",
                    "tooltip": "随机采样种子。",
                }),
                "presence_penalty": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 5.0,
                    "step": 0.01,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "出现惩罚",
                    "tooltip": "降低已出现内容再次出现的概率。",
                }),
                "thinking": ("BOOLEAN", {
                    "default": False,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "思考模式",
                    "tooltip": "如果模型支持，允许模型以 thinking 模式生成。",
                }),
                "use_default_template": ("BOOLEAN", {
                    "default": True,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "使用默认模板",
                    "tooltip": "使用模型内置系统提示/模板；关闭时跳过默认模板。",
                }),
            },
            "optional": {
                "media": (MEDIA_INPUT_TYPE, {
                    "display_name": "图片/视频",
                    "tooltip": "统一输入口，兼容 GJJ_BATCH_IMAGE、普通 IMAGE/IMAGE batch 和官方 VIDEO；接 VIDEO 时自动读取视频帧。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        clip_name: str,
        clip_type: str,
        clip_device: str,
        prompt: str,
        max_length: int,
        sampling_mode: str,
        temperature: float,
        top_k: int,
        top_p: float,
        min_p: float,
        repetition_penalty: float,
        seed: int,
        presence_penalty: float,
        thinking: bool,
        use_default_template: bool,
        media: Any = None,
        image: Any = None,
        video: Any = None,
        audio: Any = None,
        unique_id: Any = None,
    ):
        if not _find_text_encoder_path(clip_name):
            missing = [_model_spec_for_clip(clip_name)]
            raise_dependency_model_error(
                NODE_DISPLAY_NAME,
                missing_models=missing,
                description=NODE_DESCRIPTION,
                unique_id=unique_id,
                model_download_url=MODEL_DOWNLOAD_URL,
                copy_text=MODEL_DOWNLOAD_URL,
                copy_label="🌏 复制模型下载地址",
            )
        try:
            media_image, media_video = _coerce_media_for_textgen(media)
            if image is None:
                image = media_image
            if video is None:
                video = media_video
            clip = _load_merged_clip(str(clip_name), str(clip_type or "ideogram4"), str(clip_device or "default"))
            text = _generate_text(
                clip,
                prompt,
                max_length,
                sampling_mode,
                image=image,
                video=video,
                audio=audio,
                thinking=thinking,
                use_default_template=use_default_template,
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                min_p=min_p,
                repetition_penalty=repetition_penalty,
                seed=seed,
                presence_penalty=presence_penalty,
            )
            return (text,)
        except Exception as exc:
            report = getattr(exc, "gjj_report", None)
            if report:
                send_dependency_model_notice(report, unique_id=unique_id)
                raise RuntimeError(report.get("warning_message") or "运行环境缺失") from exc
            raise RuntimeError(f"Gemma 文本生成失败：{exc}") from exc


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_GemmaTextGenerate}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
