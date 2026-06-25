from __future__ import annotations

from typing import Any

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    from .gjj_ollama_common import (
        DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE,
        DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT,
        DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT_TEMPLATES,
        ollama_assistant_output_rule,
        ollama_assistant_system_prompt,
        ollama_assistant_system_prompt_templates,
    )
except Exception:
    from gjj_ollama_common import (
        DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE,
        DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT,
        DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT_TEMPLATES,
        ollama_assistant_output_rule,
        ollama_assistant_system_prompt,
        ollama_assistant_system_prompt_templates,
    )

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
NODE_DISPLAY_NAME = "GJJ · 🧠 图像反推文本生成（Gemma）"
NODE_DESCRIPTION = "把官方“加载CLIP + TextGenerate”合并成一个 GJJ 零第三方依赖节点；适合 Ideogram4 / Gemma 文本生成、提示词扩写和多模态文本生成。"
DEFAULT_CLIP_NAME = "gemma_3_12B_it_fp8_e4m3fn.safetensors"
MODEL_DOWNLOAD_URL = DEFAULT_MODEL_URL


class AnyMediaType(str):
    def __ne__(self, _other: object) -> bool:
        return False


MEDIA_INPUT_TYPE = AnyMediaType("GJJ_BATCH_IMAGE,IMAGE,VIDEO,*")

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


def _merged_generation_prompt(system_prompt: str, user_prompt: str) -> str:
    system_text = str(system_prompt or "").strip()
    user_text = str(user_prompt or "").strip()
    if not system_text:
        return user_text
    if not user_text:
        return system_text
    return f"{system_text}\n\n{user_text}"


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _coerce_tensor_to_images(tensor: Any, source_label: str = "媒体"):
    try:
        import torch
    except Exception as exc:
        raise RuntimeError(f"{source_label}转换图片需要 PyTorch：{exc}") from exc

    if not isinstance(tensor, torch.Tensor):
        raise RuntimeError(f"{source_label}没有解析出可用张量。")

    image = tensor.detach()
    if image.ndim == 0:
        image = image.reshape(1, 1, 1, 1)
    elif image.ndim == 1:
        image = image.reshape(1, 1, int(image.shape[0]), 1)
    elif image.ndim == 2:
        image = image.unsqueeze(0).unsqueeze(-1)
    elif image.ndim == 3:
        if image.shape[-1] in (1, 3, 4):
            image = image.unsqueeze(0)
        elif image.shape[0] in (1, 3, 4):
            image = image.permute(1, 2, 0).unsqueeze(0)
        else:
            image = image.unsqueeze(-1)
    else:
        # VIDEO 和其它高维张量统一压平前置批次/时间维，最终得到 BHWC。
        if image.shape[-1] in (1, 3, 4):
            image = image.reshape(-1, image.shape[-3], image.shape[-2], image.shape[-1])
        elif image.shape[-3] in (1, 3, 4):
            image = image.reshape(-1, image.shape[-3], image.shape[-2], image.shape[-1])
            image = image.permute(0, 2, 3, 1)
        elif image.shape[1] in (1, 3, 4):
            if image.ndim > 4:
                image = image.movedim(1, -3)
            image = image.reshape(-1, image.shape[-3], image.shape[-2], image.shape[-1])
            image = image.permute(0, 2, 3, 1)
        else:
            height = int(image.shape[-2])
            width = int(image.shape[-1])
            image = image.reshape(-1, height, width).unsqueeze(-1)

    image = image.to(dtype=torch.float32)
    image = torch.nan_to_num(image, nan=0.0, posinf=1.0, neginf=0.0)
    if image.shape[-1] == 1:
        image = image.repeat(1, 1, 1, 3)
    elif image.shape[-1] >= 4:
        image = image[..., :3]
    elif image.shape[-1] == 2:
        image = torch.cat([image, image[..., :1]], dim=-1)

    if image.numel():
        minimum = float(image.amin().item())
        maximum = float(image.amax().item())
        if minimum < 0.0 or maximum > 1.0:
            span = maximum - minimum
            image = (image - minimum) / span if span > 1e-8 else torch.zeros_like(image)
    return image.clamp_(0.0, 1.0).contiguous()


def _coerce_media_for_textgen(media: Any | None):
    if media is None:
        return None

    source = media
    if hasattr(source, "get_components"):
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
        import torch
        if all(isinstance(item, torch.Tensor) for item in source):
            converted = [_coerce_tensor_to_images(item, "媒体列表") for item in source]
            tensor = torch.cat(converted, dim=0)
    else:
        for key in ("images", "frames", "samples"):
            candidate = getattr(source, key, None)
            if candidate is not None:
                tensor = candidate
                break

    return _coerce_tensor_to_images(tensor, "统一媒体输入")


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
            "可选连接统一媒体输入口：IMAGE、GJJ_BATCH_IMAGE、官方 VIDEO 和可识别张量都会统一转换为 RGB 图片批次。",
            "默认类型 ideogram4 对应截图中的加载 CLIP 类型。",
            "采样模式为 off 时会关闭随机采样，仅保留最大长度等基础参数。",
        ],
        runtime=[
            "内部等价于：CLIPLoader.load_clip(...) -> clip.tokenize(...) -> clip.generate(...) -> clip.decode(...)。",
            "VIDEO 会提取全部视频帧并压平为图片批次；灰度、RGBA、通道前置和常见高维张量会自动转换为 BHWC RGB 图片。",
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
        default_system_prompt = ollama_assistant_system_prompt() or DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT
        default_templates = ollama_assistant_system_prompt_templates() or DEFAULT_OLLAMA_ASSISTANT_SYSTEM_PROMPT_TEMPLATES
        default_output_rule = ollama_assistant_output_rule() or DEFAULT_OLLAMA_ASSISTANT_OUTPUT_RULE
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
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "提示词",
                    "tooltip": "发送给文本生成模型的用户指令；前端同时提供内置多行文本框和可外接 STRING 输入口。",
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
                "system_prompt": ("STRING", {
                    "default": default_system_prompt,
                    "multiline": True,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "系统提示词",
                    "tooltip": "由模板按钮快速填入，也可以自定义任务规则；执行时会放在用户提示词之前。",
                }),
                "system_prompt_templates": ("STRING", {
                    "default": default_templates,
                    "multiline": True,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "系统提示词模板",
                    "tooltip": "与 GJJ_OllamaAssistant 共用 presets/gjj_user_settings.json 中的同一套模板。",
                }),
                "system_prompt_output_rule": ("STRING", {
                    "default": default_output_rule,
                    "multiline": True,
                    "display": "hidden",
                    "hidden": True,
                    "display_name": "输出约束",
                    "tooltip": "点击模板按钮时追加到系统提示词正文之后；与 GJJ_OllamaAssistant 共用预设。",
                }),
            },
            "optional": {
                "media": (MEDIA_INPUT_TYPE, {
                    "display_name": "图片/视频",
                    "tooltip": "统一输入口。VIDEO 与其它可识别张量会自动转换、归一化为 BHWC RGB 图片批次后喂给 Gemma。",
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
        system_prompt: str = "",
        system_prompt_templates: str = "",
        system_prompt_output_rule: str = "",
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
            media_image = _coerce_media_for_textgen(media)
            if image is None:
                image = media_image
            elif media_image is not None:
                image = media_image
            if image is None and video is not None:
                image = _coerce_media_for_textgen(video)
            elif image is not None:
                image = _coerce_media_for_textgen(image)
            video = None
            clip = _load_merged_clip(str(clip_name), str(clip_type or "ideogram4"), str(clip_device or "default"))
            text = _generate_text(
                clip,
                _merged_generation_prompt(system_prompt, prompt),
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
