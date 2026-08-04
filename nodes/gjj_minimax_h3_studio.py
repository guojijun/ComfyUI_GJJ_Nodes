from __future__ import annotations

import hashlib
import json
import time
import uuid
from pathlib import Path
from typing import Any

import folder_paths
import torch
import torch.nn.functional as F
import comfy.samplers

from .gjj_bernini_studio import (
    _basic_sigmas,
    _decode_video_media_frames,
    _ksampler,
    _media_components,
    _node_output_first,
    _video_combine_result,
)
from .gjj_video_combine import GJJ_VideoCombine
from .gjj_video_combine_runtime import DEFAULT_FORMAT, list_supported_formats
from .gjj_video_universal_model_loader import _load_clip, _load_unet_model, _load_vae


NODE_NAME = "GJJ_MiniMaxH3Studio"
MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO,AUDIO"
UPLOAD_ROUTE = "/gjj/minimax_h3_studio/upload"

DEFAULT_FL_MODEL = "minimax_h3_fl2va_pruned_nvfp4_base.safetensors"
DEFAULT_REF_MODEL = "minimax_h3_ref2va_pruned_nvfp4_base.safetensors"
DEFAULT_FL_MODEL_KEYWORD = "minimax_h3_fl2va"
DEFAULT_REF_MODEL_KEYWORD = "minimax_h3_ref2va"
DEFAULT_CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
DEFAULT_VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
DEFAULT_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"
DEFAULT_REASONING_KEYWORD = "qwen3.5-4b"
DEFAULT_REASONING_SYSTEM_PROMPT = (
    "你是 MiniMax H3 视频提示词优化器。结合用户原始提示词与参考图片，补充清晰的主体、动作、镜头运动、"
    "环境、光线和时间连续性描述。只输出可直接用于视频生成的最终提示词，不要解释，不要标题，不要输出思考过程。"
)


def _register_upload_route() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
        server = PromptServer.instance
        if not server or getattr(server, "_gjj_minimax_h3_upload_registered", False):
            return

        async def upload(request):
            reader = await request.multipart()
            destination = Path(folder_paths.get_input_directory()) / "gjj_minimax_h3_studio"
            destination.mkdir(parents=True, exist_ok=True)
            items = []
            while True:
                part = await reader.next()
                if part is None:
                    break
                if not getattr(part, "filename", None):
                    continue
                original = Path(str(part.filename)).name
                suffix = Path(original).suffix.lower()
                filename = f"{uuid.uuid4().hex}_{original}"
                target = destination / filename
                with target.open("wb") as handle:
                    while chunk := await part.read_chunk():
                        handle.write(chunk)
                media_type = "text" if suffix in {".txt", ".md", ".prompt"} else ("image" if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"} else ("audio" if suffix in {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"} else "video"))
                preview_text = target.read_text(encoding="utf-8", errors="replace")[:1200] if media_type == "text" else ""
                items.append({"filename": filename, "subfolder": "gjj_minimax_h3_studio", "type": "input", "media_type": media_type, "original_name": original, "preview_text": preview_text})
            return web.json_response({"ok": True, "items": items})

        server.routes.post(UPLOAD_ROUTE)(upload)
        server._gjj_minimax_h3_upload_registered = True
    except Exception:
        pass


_register_upload_route()


def _choices(kind: str, preferred: str, contains: tuple[str, ...]) -> tuple[list[str], str]:
    try:
        names = sorted(str(x) for x in folder_paths.get_filename_list(kind))
    except Exception:
        names = []
    filtered = [x for x in names if all(part.lower() in x.lower() for part in contains)]
    values = filtered or names or [preferred]
    value = preferred if preferred in values else values[0]
    return values, value


def _unwrap_node_output(value: Any) -> tuple[Any, ...]:
    result = getattr(value, "result", None)
    if result is not None:
        return tuple(result)
    if isinstance(value, tuple):
        return value
    if isinstance(value, list):
        return tuple(value)
    return (value,)


def _is_audio(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get("waveform"), torch.Tensor) and value.get("sample_rate") is not None


def _walk_media(value: Any, out: dict[str, list[Any]], seen: set[int]) -> None:
    if value is None:
        return
    if not isinstance(value, (str, bytes, int, float, bool)):
        marker = id(value)
        if marker in seen:
            return
        seen.add(marker)
    if _is_audio(value):
        out["audios"].append(value)
        return
    if isinstance(value, dict):
        # A VIDEO-like dictionary may carry frames/fps/audio together.
        frames, audio, fps = _media_components(value)
        if frames is not None and (fps is not None or audio is not None):
            out["videos"].append((frames, audio, fps))
            return
        for item in value.values():
            _walk_media(item, out, seen)
        return
    if isinstance(value, (list, tuple, set)):
        for item in value:
            _walk_media(item, out, seen)
        return
    getter = getattr(value, "get_components", None)
    if callable(getter):
        frames, audio, fps = _media_components(value)
        if frames is not None:
            out["videos"].append((frames, audio, fps))
        elif audio is not None:
            out["audios"].append(audio)
        return
    if isinstance(value, torch.Tensor):
        frames, _audio, _fps = _media_components(value)
        if frames is not None:
            for index in range(int(frames.shape[0])):
                out["images"].append(frames[index : index + 1].contiguous())


def _collect_media(value: Any) -> dict[str, list[Any]]:
    result = {"images": [], "videos": [], "audios": []}
    _walk_media(value, result, set())
    return result


def _merge_media(target: dict[str, list[Any]], source: dict[str, list[Any]]) -> None:
    for key in target:
        target[key].extend(source.get(key) or [])


def _load_internal_media(raw: Any) -> tuple[dict[str, list[Any]], list[str]]:
    media = {"images": [], "videos": [], "audios": []}
    texts: list[str] = []
    try:
        items = json.loads(str(raw or "[]"))
    except Exception:
        items = []
    input_root = Path(folder_paths.get_input_directory()).resolve()
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        path = (input_root / str(item.get("subfolder") or "") / Path(str(item.get("filename") or "")).name).resolve()
        if input_root not in path.parents or not path.is_file():
            continue
        media_type = str(item.get("media_type") or "").lower()
        try:
            if media_type == "text":
                texts.append(path.read_text(encoding="utf-8", errors="replace"))
            elif media_type == "image":
                import numpy as np
                from PIL import Image, ImageOps
                image = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
                media["images"].append(torch.from_numpy(np.asarray(image).astype("float32") / 255.0).unsqueeze(0))
            elif media_type == "audio":
                import torchaudio
                waveform, sample_rate = torchaudio.load(str(path))
                media["audios"].append({"waveform": waveform.unsqueeze(0), "sample_rate": int(sample_rate)})
            else:
                frames, fps = _decode_video_media_frames(str(path))
                if frames is not None:
                    media["videos"].append((frames, None, fps))
        except Exception as exc:
            print(f"[GJJ MiniMaxH3Studio] 内部媒体读取失败 {path.name}: {exc}")
    return media, texts


def _aligned_frames(duration: float, fps: float) -> int:
    value = max(5, round(float(duration) * float(fps)))
    while value % 17 != 5:
        value += 1
    return value


def _aligned_dimension(value: float) -> int:
    return max(352, min(1920, round(float(value) / 32) * 32))


def _visual_size(value: Any) -> tuple[int, int] | None:
    if isinstance(value, torch.Tensor) and value.ndim >= 3:
        return int(value.shape[-2]), int(value.shape[-3])
    return None


def _anchored_offset(space: int, anchor: str, low: str, high: str) -> int:
    if anchor == low:
        return 0
    if anchor == high:
        return max(0, space)
    return max(0, space // 2)


def _resize_visual(value: Any, width: int, height: int, fit_mode: str, anchor: str) -> Any:
    if not isinstance(value, torch.Tensor) or value.ndim not in (3, 4):
        return value
    source = value.unsqueeze(0) if value.ndim == 3 else value
    source_height, source_width = int(source.shape[-3]), int(source.shape[-2])
    if source_width == width and source_height == height:
        return value
    channel_first = source.movedim(-1, 1)
    if fit_mode == "拉伸":
        result = F.interpolate(channel_first, size=(height, width), mode="bicubic", align_corners=False)
    else:
        scale = min(width / source_width, height / source_height)
        if fit_mode == "裁剪":
            scale = max(width / source_width, height / source_height)
        elif fit_mode == "补边":
            scale = min(1.0, scale)
        resized_width = max(1, round(source_width * scale))
        resized_height = max(1, round(source_height * scale))
        resized = F.interpolate(channel_first, size=(resized_height, resized_width), mode="bicubic", align_corners=False)
        if fit_mode == "裁剪":
            x = _anchored_offset(resized_width - width, anchor, "左", "右")
            y = _anchored_offset(resized_height - height, anchor, "上", "下")
            result = resized[:, :, y:y + height, x:x + width]
        else:
            canvas = torch.zeros((resized.shape[0], resized.shape[1], height, width), dtype=resized.dtype, device=resized.device)
            x = _anchored_offset(width - resized_width, anchor, "左", "右")
            y = _anchored_offset(height - resized_height, anchor, "上", "下")
            copy_width, copy_height = min(width, resized_width), min(height, resized_height)
            canvas[:, :, y:y + copy_height, x:x + copy_width] = resized[:, :, :copy_height, :copy_width]
            result = canvas
    restored = result.movedim(1, -1).contiguous()
    return restored[0] if value.ndim == 3 else restored


def _target_dimensions(panel_width: int, panel_height: int, source_size: tuple[int, int] | None, use_source: bool, size_mode: str) -> tuple[int, int]:
    if use_source and source_size:
        return _aligned_dimension(source_size[0]), _aligned_dimension(source_size[1])
    if not source_size or size_mode == "宽高":
        return _aligned_dimension(panel_width), _aligned_dimension(panel_height)
    source_width, source_height = source_size
    ratio = source_width / max(1, source_height)
    if size_mode == "长边":
        edge = max(panel_width, panel_height)
        return (_aligned_dimension(edge), _aligned_dimension(edge / ratio)) if ratio >= 1 else (_aligned_dimension(edge * ratio), _aligned_dimension(edge))
    if size_mode == "像素":
        area = max(1, panel_width * panel_height)
        target_width = (area * ratio) ** 0.5
        return _aligned_dimension(target_width), _aligned_dimension(target_width / ratio)
    scale = min(panel_width / source_width, panel_height / source_height)
    return _aligned_dimension(source_width * scale), _aligned_dimension(source_height * scale)


def _align_media(media: dict[str, list[Any]], width: int, height: int, fit_mode: str, anchor: str) -> None:
    media["images"] = [_resize_visual(item, width, height, fit_mode, anchor) for item in media["images"]]
    media["videos"] = [(_resize_visual(frames, width, height, fit_mode, anchor), audio, fps) for frames, audio, fps in media["videos"]]


def _send_status(unique_id: Any, text: str, progress: float, extra: dict[str, Any] | None = None) -> None:
    if unique_id is None:
        return
    try:
        from server import PromptServer
        payload = {"node": str(unique_id), "text": text, "progress": float(progress)}
        if isinstance(extra, dict):
            payload.update(extra)
        PromptServer.instance.send_sync("gjj_node_progress", payload)
    except Exception:
        pass


def _concat_audio_segments(values: list[Any]) -> Any:
    valid = [value for value in values if isinstance(value, dict) and isinstance(value.get("waveform"), torch.Tensor)]
    if not valid:
        return None
    sample_rate = int(valid[0].get("sample_rate") or 44100)
    matching = [value["waveform"] for value in valid if int(value.get("sample_rate") or sample_rate) == sample_rate]
    return {"waveform": torch.cat(matching, dim=-1).contiguous(), "sample_rate": sample_rate} if matching else None


class GJJ_MiniMaxH3Studio:
    CATEGORY = "GJJ/💗 一键生成"
    FUNCTION = "generate"
    INPUT_IS_LIST = True
    OUTPUT_NODE = True
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("生成视频",)
    DESCRIPTION = "MiniMax H3 单节点工作室：按图片数量显示参考、首帧、尾帧、首尾帧或分段首尾帧分支；多图分段会按相邻图片生成并去重边界首帧。"
    SEARCH_ALIASES = ["MiniMax H3 Studio", "海螺单节点", "T2V I2V Ref2V"]
    GJJ_UI = {"style_reference": "GJJ_BerniniStudio", "model_keyword": "minimax_h3"}
    _MODEL_CACHE: dict[tuple[str, ...], tuple[Any, Any, Any, Any]] = {}

    @classmethod
    def INPUT_TYPES(cls):
        fl_models, fl_default = _choices("diffusion_models", DEFAULT_FL_MODEL, (DEFAULT_FL_MODEL_KEYWORD,))
        ref_models, ref_default = _choices("diffusion_models", DEFAULT_REF_MODEL, (DEFAULT_REF_MODEL_KEYWORD,))
        clips, clip_default = _choices("text_encoders", DEFAULT_CLIP, ("qwen3vl_32b", "minimax_h3"))
        video_vaes, video_vae_default = _choices("vae", DEFAULT_VIDEO_VAE, ("minimax_h3", "video_vae"))
        audio_vaes, audio_vae_default = _choices("vae", DEFAULT_AUDIO_VAE, ("minimax_h3", "audio_vae"))
        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
        output_formats = list_supported_formats()
        try:
            from .gjj_gemma_text_generate import _text_encoder_options
            reasoning_models = [str(item) for item in _text_encoder_options()]
        except Exception:
            reasoning_models = []
        reasoning_models = reasoning_models or [DEFAULT_REASONING_KEYWORD]
        normalized_keyword = DEFAULT_REASONING_KEYWORD.replace("-", "").replace("_", "")
        reasoning_default = next(
            (item for item in reasoning_models if normalized_keyword in item.lower().replace("-", "").replace("_", "")),
            reasoning_models[0],
        )
        if "res_multistep" not in samplers:
            samplers.insert(0, "res_multistep")
        if "simple" not in schedulers:
            schedulers.insert(0, "simple")
        return {
            "required": {},
            "optional": {
                "reference_media": (MEDIA_TYPE, {"display_name": "参考媒体", "tooltip": "递归解包图片、VIDEO、音频、list/tuple/dict。未连接=T2V；单图=I2V；其它=参考生视频。"}),
                "prompt": ("STRING", {"default": "", "multiline": True, "display_name": "正向提示词"}),
                "width": ("INT", {"default": 864, "min": 352, "max": 1920, "step": 32, "display_name": "宽度"}),
                "height": ("INT", {"default": 480, "min": 352, "max": 1920, "step": 32, "display_name": "高度"}),
                "duration": ("FLOAT", {"default": 5.0, "min": 0.2, "max": 60.0, "step": 0.1, "display_name": "时长(秒)"}),
                "frame_rate": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 1.0, "display_name": "帧率"}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 100, "step": 1, "display_name": "步数"}),
                "seed": ("INT", {"default": 42, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "display_name": "种子"}),
                "randomize_seed": ("BOOLEAN", {"default": True, "display_name": "随机种子"}),
                "sampler_name": (samplers, {"default": "res_multistep", "display_name": "采样器"}),
                "scheduler": (schedulers, {"default": "simple", "display_name": "调度器"}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "降噪"}),
                "ref_image_size": (["match", "max"], {"default": "match", "display_name": "参考图尺寸"}),
                "filename_prefix": ("STRING", {"default": "video/MiniMax_H3_Studio", "display_name": "文件名前缀"}),
                "format_name": (output_formats, {"default": DEFAULT_FORMAT, "display_name": "输出格式"}),
                "fl_model": (fl_models, {"default": fl_default, "display_name": "T2V/I2V模型", "gjj_default_model": DEFAULT_FL_MODEL, "gjj_model_folder": "diffusion_models", "gjj_model_icon": "🟣", "gjj_model_keywords": [DEFAULT_FL_MODEL_KEYWORD]}),
                "ref_model": (ref_models, {"default": ref_default, "display_name": "参考模型", "gjj_default_model": DEFAULT_REF_MODEL, "gjj_model_folder": "diffusion_models", "gjj_model_icon": "🟣", "gjj_model_keywords": [DEFAULT_REF_MODEL_KEYWORD]}),
                "clip_name": (clips, {"default": clip_default, "display_name": "Qwen3-VL编码器", "gjj_default_model": DEFAULT_CLIP, "gjj_model_folder": "text_encoders", "gjj_model_icon": "🟡"}),
                "video_vae_name": (video_vaes, {"default": video_vae_default, "display_name": "视频VAE", "gjj_default_model": DEFAULT_VIDEO_VAE, "gjj_model_folder": "vae", "gjj_model_icon": "🔴"}),
                "audio_vae_name": (audio_vaes, {"default": audio_vae_default, "display_name": "音频VAE", "gjj_default_model": DEFAULT_AUDIO_VAE, "gjj_model_folder": "vae", "gjj_model_icon": "🔴"}),
                "keep_model": ("BOOLEAN", {"default": False, "display_name": "保持模型"}),
                "use_source_size": ("BOOLEAN", {"default": True, "display_name": "首图尺寸"}),
                "size_mode": (["宽高", "等比", "长边", "像素"], {"default": "宽高", "display_name": "尺寸模式"}),
                "resize_fit_mode": (["拉伸", "补边", "留边", "裁剪"], {"default": "裁剪", "display_name": "适配方式"}),
                "resize_anchor": (["上", "下", "左", "右", "中"], {"default": "上", "display_name": "保留位置"}),
                "reference_media_2": (MEDIA_TYPE, {"display_name": "参考媒体 2", "tooltip": "第二个递归媒体入口；外部链接优先于📁内部媒体。"}),
                "internal_media_json": ("STRING", {"default": "[]", "display_name": "内部媒体记录"}),
                "image_branch": (["参考", "首帧", "尾帧", "首尾帧", "分段首尾帧"], {"default": "参考", "display_name": "图片分支", "tooltip": "由提示词下方的互斥按钮控制；实际可用选项随输入图片数量变化。"}),
                "reasoning_enabled": ("BOOLEAN", {"default": False, "display_name": "启用推理", "tooltip": "开启后使用 GJJ_GemmaTextGenerate 在生成视频前优化提示词；关闭时不会加载推理模型。"}),
                "reasoning_model": (reasoning_models, {"default": reasoning_default, "display_name": "推理模型", "gjj_default_model": reasoning_default, "gjj_model_folder": "text_encoders", "gjj_model_icon": "🟡", "gjj_model_keywords": [DEFAULT_REASONING_KEYWORD]}),
                "reasoning_system_prompt": ("STRING", {"default": DEFAULT_REASONING_SYSTEM_PROMPT, "multiline": True, "display_name": "推理系统提示词"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "prompt_info": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # ⚠️ 仅使用 **kwargs 按名称读取，禁止使用 *args 按索引位置传参
        # 原因：重启 ComfyUI 后 INPUT_TYPES 中动态列表顺序变化会导致参数索引错位
        randomize_raw = kwargs.get("randomize_seed", True)
        randomize_val = (randomize_raw[0] if isinstance(randomize_raw, list) and randomize_raw else randomize_raw)
        if bool(randomize_val):
            return time.time_ns()
        digest = hashlib.sha256()
        for key in sorted(kwargs):
            digest.update(f"{key}={kwargs[key]}|".encode("utf-8", errors="replace"))
        return digest.hexdigest()

    def _load_models(self, model_name: str, clip_name: str, video_vae_name: str, audio_vae_name: str, keep: bool, unique_id: Any):
        key = (model_name, clip_name, video_vae_name, audio_vae_name)
        if keep and key in self._MODEL_CACHE:
            return self._MODEL_CACHE[key]
        model = _load_unet_model(model_name, "default", unique_id=unique_id)
        clip = _load_clip(clip_name, "minimax_h3", "default")
        video_vae = _load_vae(video_vae_name)
        audio_vae = _load_vae(audio_vae_name)
        value = (model, clip, video_vae, audio_vae)
        if keep:
            self._MODEL_CACHE[key] = value
        return value

    def generate(self, **kwargs):
        def first(name: str, default: Any = None):
            value = kwargs.get(name, default)
            return value[0] if isinstance(value, list) and value else value

        media = _collect_media(kwargs.get("reference_media"))
        _merge_media(media, _collect_media(kwargs.get("reference_media_2")))
        internal_texts: list[str] = []
        if not any(media.values()):
            internal_media, internal_texts = _load_internal_media(first("internal_media_json", "[]"))
            _merge_media(media, internal_media)
        prompt = "\n\n".join(part for part in [str(first("prompt", "") or "").strip(), *[text.strip() for text in internal_texts]] if part)
        panel_width, panel_height = int(first("width", 864)), int(first("height", 480))
        source = media["images"][0] if media["images"] else (media["videos"][0][0] if media["videos"] else None)
        width, height = _target_dimensions(
            panel_width, panel_height, _visual_size(source), bool(first("use_source_size", True)), str(first("size_mode", "宽高")),
        )
        _align_media(media, width, height, str(first("resize_fit_mode", "裁剪")), str(first("resize_anchor", "上")))
        fps = float(first("frame_rate", 24.0))
        length = _aligned_frames(float(first("duration", 5.0)), fps)
        seed = int(first("seed", 42))
        if bool(first("randomize_seed", True)):
            seed = int(torch.randint(0, 0x7FFFFFFF, (1,)).item())
        unique_id = first("unique_id")
        prompt_parts = [part.strip() for part in prompt.split("---") if part.strip()] or [prompt]
        if bool(first("reasoning_enabled", False)):
            from .gjj_gemma_text_generate import GJJ_GemmaTextGenerate

            reasoning_media = torch.cat(media["images"], dim=0) if media["images"] else None
            inferred_parts: list[str] = []
            for infer_index, raw_part in enumerate(prompt_parts):
                _send_status(unique_id, f"推理提示词 {infer_index + 1}/{len(prompt_parts)}...", 0.01)
                generated = GJJ_GemmaTextGenerate().generate(
                    clip_name=str(first("reasoning_model", DEFAULT_REASONING_KEYWORD)),
                    clip_type="stable_diffusion", clip_device="default", prompt=raw_part,
                    max_length=1024, sampling_mode="off", temperature=0.35, top_k=64,
                    top_p=0.95, min_p=0.05, repetition_penalty=1.05, seed=0,
                    presence_penalty="0.0", thinking=False, use_default_template=True,
                    media=reasoning_media, unique_id=unique_id,
                    system_prompt=str(first("reasoning_system_prompt", DEFAULT_REASONING_SYSTEM_PROMPT)),
                    keep_model=bool(first("keep_model", False)), device_preference="GPU优先",
                )
                payload = generated.get("result") if isinstance(generated, dict) else generated
                inferred = str(payload[0] if isinstance(payload, (list, tuple)) and payload else payload or "").strip()
                inferred_parts.append(inferred or raw_part)
            prompt_parts = inferred_parts
        image_count = len(media["images"])
        requested_branch = str(first("image_branch", "参考") or "参考")
        if image_count == 1:
            image_branch = requested_branch if requested_branch in {"参考", "首帧", "尾帧"} else "参考"
        elif image_count == 2:
            image_branch = requested_branch if requested_branch in {"参考", "首尾帧"} else "参考"
        elif image_count > 2:
            image_branch = requested_branch if requested_branch in {"参考", "分段首尾帧"} else "参考"
        else:
            image_branch = "参考"

        jobs: list[tuple[str, dict[str, list[Any]]]] = []
        if image_branch == "分段首尾帧":
            for index in range(image_count - 1):
                jobs.append((prompt_parts[min(index, len(prompt_parts) - 1)], {
                    "images": [media["images"][index], media["images"][index + 1]],
                    "videos": [], "audios": [],
                }))
        else:
            distribute_images = len(prompt_parts) > 1 and image_count == len(prompt_parts) and image_branch != "参考"
            for index, segment_prompt in enumerate(prompt_parts):
                jobs.append((segment_prompt, {
                    "images": [media["images"][index]] if distribute_images else list(media["images"]),
                    "videos": list(media["videos"]), "audios": list(media["audios"]),
                }))
        segment_count = len(jobs)
        filename_prefix = str(first("filename_prefix", "video/MiniMax_H3_Studio"))
        requested_format = str(first("format_name", DEFAULT_FORMAT) or "").strip()
        supported_formats = set(list_supported_formats())
        format_name = requested_format if requested_format in supported_formats else DEFAULT_FORMAT
        runtime_models: dict[str, tuple[Any, Any, Any, Any]] = {}

        def segment_mode(segment: dict[str, list[Any]]) -> str:
            image_count = len(segment["images"])
            has_reference_av = bool(segment["videos"] or segment["audios"])
            if image_branch in {"首尾帧", "分段首尾帧"} and image_count == 2 and not has_reference_av:
                return "首尾帧"
            if image_branch == "参考" and image_count > 0:
                return "R2V"
            if image_branch == "尾帧" and image_count == 1 and not has_reference_av:
                return "尾帧"
            if image_count == 0 and not has_reference_av:
                return "T2V"
            if image_count == 1 and not has_reference_av:
                return "I2V"
            return "R2V"

        def combine_segment(segment_images: torch.Tensor, segment_audio: Any, prefix: str):
            return GJJ_VideoCombine().combine(
                images=segment_images, frame_rate=fps, loop_count=0, filename_prefix=prefix,
                format_name=format_name, pingpong=False, save_output=True, use_source_fps=False,
                delete_tail_frame=False, save_metadata=True, trim_to_audio=False, pix_fmt="auto", crf="-1",
                vae=None, audio=segment_audio, prompt=first("prompt_info"), extra_pnginfo=first("extra_pnginfo"), unique_id=unique_id,
            )

        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ImageToVideo, MiniMaxH3ReferenceToVideo
        from comfy_extras.nodes_custom_sampler import BasicGuider, RandomNoise, SamplerCustomAdvanced
        import nodes
        from comfy_extras.nodes_audio import VAEDecodeAudio
        decoded_segments: list[torch.Tensor] = []
        audio_segments: list[Any] = []
        modes: list[str] = []
        for index, (segment_prompt, current_media) in enumerate(jobs):
            mode = segment_mode(current_media)
            modes.append(mode)
            model_name = str(first("ref_model" if mode == "R2V" else "fl_model", DEFAULT_REF_MODEL if mode == "R2V" else DEFAULT_FL_MODEL))
            _send_status(unique_id, f"队列 {index + 1}/{segment_count} · {mode}：加载模型...", index / segment_count)
            if model_name not in runtime_models:
                runtime_models[model_name] = self._load_models(
                    model_name, str(first("clip_name", DEFAULT_CLIP)), str(first("video_vae_name", DEFAULT_VIDEO_VAE)),
                    str(first("audio_vae_name", DEFAULT_AUDIO_VAE)), bool(first("keep_model", False)), unique_id,
                )
            model, clip, video_vae, audio_vae = runtime_models[model_name]
            if mode == "R2V":
                ref_images = {f"ref_image_{i}": value for i, value in enumerate(current_media["images"][:10])}
                ref_videos = {f"ref_video_{i}": value[0] for i, value in enumerate(current_media["videos"][:4])}
                ref_video_audios = {f"ref_video_audio_{i}": value[1] for i, value in enumerate(current_media["videos"][:4]) if value[1] is not None}
                ref_audios = {f"ref_audio_{i}": value for i, value in enumerate(current_media["audios"][:4])}
                positive, latent = _unwrap_node_output(MiniMaxH3ReferenceToVideo.execute(
                    clip, video_vae, audio_vae, segment_prompt, width, height, length,
                    str(first("ref_image_size", "match")), ref_images, ref_videos, ref_video_audios, ref_audios,
                ))[:2]
            else:
                first_frame = current_media["images"][0] if mode in {"I2V", "首尾帧"} else None
                last_frame = current_media["images"][1] if mode == "首尾帧" else (current_media["images"][0] if mode == "尾帧" else None)
                positive, latent = _unwrap_node_output(MiniMaxH3ImageToVideo.execute(
                    clip, video_vae, segment_prompt, width, height, length, first_frame, last_frame,
                ))[:2]
            guider = _node_output_first(BasicGuider.execute(model, positive))
            noise = _node_output_first(RandomNoise.execute((seed + index) % (1 << 64)))
            sampler = _ksampler(str(first("sampler_name", "res_multistep")))
            sigmas = _basic_sigmas(model, str(first("scheduler", "simple")), int(first("steps", 20)), float(first("denoise", 1.0)))
            _send_status(unique_id, f"队列 {index + 1}/{segment_count} · 正在采样...", (index + 0.2) / segment_count)
            sampled = _unwrap_node_output(SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, latent))[0]
            segment_images = nodes.VAEDecode().decode(video_vae, sampled)[0]
            segment_audio = _unwrap_node_output(VAEDecodeAudio.execute(audio_vae, sampled))[0]
            # 相邻段共享边界图；后续片段移除第 1 帧，避免拼接时重复该边界帧。
            if image_branch == "分段首尾帧" and index > 0 and int(segment_images.shape[0]) > 1:
                segment_images = segment_images[1:].contiguous()
            decoded_segments.append(segment_images)
            audio_segments.append(segment_audio)
            if segment_count > 1:
                segment_combined = combine_segment(segment_images, segment_audio, f"{filename_prefix}_segment_{index + 1:03d}")
                segment_ui = dict(segment_combined.get("ui") or {}) if isinstance(segment_combined, dict) else {}
                segment_ui.update({"segment": index + 1, "segment_count": segment_count})
                _send_status(unique_id, f"第 {index + 1}/{segment_count} 段已完成", (index + 1) / segment_count, segment_ui)

        _send_status(unique_id, "正在合并全部视频段...", 0.98)
        images = torch.cat(decoded_segments, dim=0) if len(decoded_segments) > 1 else decoded_segments[0]
        audio = _concat_audio_segments(audio_segments)
        combined = combine_segment(images, audio, filename_prefix)
        video, output_path, _files = _video_combine_result(combined)
        final_mode = image_branch if image_count else ("队列" if segment_count > 1 else modes[0])
        frame_count = sum(int(item.shape[0]) for item in decoded_segments)
        ui = dict(combined.get("ui") or {}) if isinstance(combined, dict) else {}
        ui.update({"mode": [final_mode], "frame_count": [frame_count], "segment_count": [segment_count], "source_image_count": [image_count], "image_branch": [image_branch], "output_path": [str(output_path or "")], "preview_scope": ["final"]})
        # 最终合并文件写出后再次推送完整预览字段，覆盖分段过程中显示的最后一段视频。
        _send_status(unique_id, f"{final_mode} 完成：{frame_count} 帧", 1.0, ui)
        return {"ui": ui, "result": (video,)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MiniMaxH3Studio}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·🧠多模态视频一键生成(MiniMax H3)"}
