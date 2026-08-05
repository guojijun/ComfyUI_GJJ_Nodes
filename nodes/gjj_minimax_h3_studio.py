from __future__ import annotations

import hashlib
import json
import re
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
from .gjj_model_patch_bundle import GJJ_ModelPatchBundle, MISSING_SAGE_HANDLING_MODES, SAGE_ATTENTION_MODES
from .gjj_spectrum_apply_minimax_h3 import GJJ_SpectrumApplyMiniMaxH3


NODE_NAME = "GJJ_MiniMaxH3Studio"
MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO,AUDIO"
UPLOAD_ROUTE = "/gjj/minimax_h3_studio/upload"

DEFAULT_FL_MODEL = "minimax_h3_fl2va_pruned_nvfp4.safetensors"
DEFAULT_REF_MODEL = "minimax_h3_ref2va_pruned_nvfp4.safetensors"
DEFAULT_FL_MODEL_KEYWORD = "minimax_h3_fl2va"
DEFAULT_REF_MODEL_KEYWORD = "minimax_h3_ref2va"
DEFAULT_CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
DEFAULT_VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
DEFAULT_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"
DEFAULT_REASONING_KEYWORD = "qwen3.5-4b"
MAX_AUDIO_DRIVEN_DURATION = 15.0
DEFAULT_REASONING_SYSTEM_PROMPT = (
    "你是 MiniMax H3 官方格式视频提示词改写器。严格保留用户意图、对白原文、歌词和画面文字，"
    "根据当前任务模式输出可直接送入模型的最终英文提示词；对白、歌词和画面文字保留原语言。"
    "不要解释、不要分析过程、不要 Markdown 代码块。"
)


def _official_prompt_rewrite_rules(mode: str, duration: float, picture_count: int) -> str:
    seconds = f"{max(0.0, float(duration)):.2f}"
    shared = (
        "Follow the official MiniMax H3 video prompt rules. Preserve every user-provided dialogue word and punctuation verbatim; "
        "put dialogue only inside <d>[Language] ...</d>. Assign stable speaker IDs (S1), (S2), etc. "
        "For every spoken line, identify the concrete speaker outside <d> and use an explicit physical speech verb such as says, "
        "replies, asks, or exclaims. Unless the user explicitly requests voiceover or off-screen speech, keep that speaker on-screen "
        "with the face and mouth clearly visible during the complete line, and explicitly state that the speaker naturally moves the "
        "lips and jaw in precise synchronization with the spoken words. Immediately after the line, state that the speaker finishes "
        "speaking and closes the mouth. Keep all other visible characters' lips closed while they listen, react, or wait for their turn. "
        "Never turn physical dialogue into narration, internal monologue, soundtrack vocals, or off-screen voiceover merely to simplify "
        "the shot. Give each complete line enough uninterrupted screen time to be spoken at a natural pace; use <cutoff> only when the "
        "user intentionally requests truncated speech. Avoid poses, objects, framing, or camera moves that hide the active speaker's mouth. "
        "Every referenced scene or environment must fill the entire target frame edge-to-edge; never preserve blank margins, white canvas, "
        "letterboxing, reference-board borders, or unused space from a source image. "
        "Treat every repeated occurrence of the same character <Picture N> tag as the same single persistent on-screen individual, "
        "never as a new instance. Keep exactly one instance of each referenced character unless the user explicitly requests duplicates; "
        "never clone, duplicate, mirror, replace, or add a look-alike copy of a referenced character. "
        "Write shot actions in playback order. [Shot 1] has no timestamp; later shots use strictly increasing "
        "[Shot N] At MM:SS.mmm timestamps within the video duration. Express camera motion naturally with motion type, "
        "and add amplitude/speed only when meaningful. Keep visible text verbatim in double quotes. "
        "Do not invent extra dialogue or translate dialogue. Output only the finished prompt, without commentary or Markdown fences."
        " Preserve every supplied <Audio N> tag exactly. Treat each 'Reference voice assignments' entry as an official MiniMax H3 "
        "standalone reference-audio binding: the named character or referenced picture must use that <Audio N> voice identity for all "
        "of its spoken lines. Treat the recording only as a voice-identity/timbre reference: never copy, replay, continue, quote, or "
        "output its spoken content, performance timing, or waveform. Never renumber, remove, swap, or assign that timbre to another speaker."
    )
    if mode == "R2VA":
        return (
            f"Task: full-reference generation, duration {seconds} seconds, {picture_count} reference picture(s). {shared} "
            "Write all structural prose in English and use exactly these six sections in order: subject_definitions:, summary:, "
            "retention_analysis:, detailed_description:, overall_soundscape:, non_diegetic_music:. "
            "In subject_definitions, describe reusable characters, scenes, objects, costumes, or styles directly with their existing "
            "<Picture N> tags. Never create or use <Subject N> aliases. Keep every existing <Picture N> index unchanged. Use "
            "[reference generation] in summary unless another "
            "relationship is explicitly required. Use only valid retention markers: fully_preserved, partially_preserved, "
            "attribute_transfer, weak_reference. In detailed_description, cite <Picture N> directly wherever it appears. "
            "Use 350-500 English words when content complexity warrants it."
        )
    instruction = {
        "I2VA": "The first line must be: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
        "FL2VA": f"The first line must align Picture 1 with 0.00 seconds and Picture 2 with the {seconds}-second mark of the actual final shot, using the official first/last-frame alignment sentence.",
        "L2VA": f"The first line must align <Picture 1> with the {seconds}-second mark of the actual final shot, using the official last-frame alignment sentence.",
        "T2VA": "Do not add any picture-alignment instruction.",
    }.get(mode, "")
    path_rule = {
        "I2VA": "Develop continuously from the first-frame anchor while preserving identity, clothing, objects, composition, and spatial relationships.",
        "FL2VA": "Describe one continuous observable path from the first-frame state to the last-frame state; prefer a single shot unless the user explicitly requests cuts.",
        "L2VA": "Infer a plausible earlier state and describe a continuous convergence toward the referenced final frame.",
        "T2VA": "Construct a complete audiovisual timeline directly from the user's text.",
    }.get(mode, "")
    return (
        f"Task: {mode}, duration {seconds} seconds. {shared} {instruction} {path_rule} "
        "After the optional alignment line and one blank line, output exactly three fields: "
        "integrated_multimodal_description:, overall_soundscape:, non_diegetic_music:. "
        "overall_soundscape must summarize ambience, physical sounds, and non-verbal human sounds without repeating dialogue. "
        "non_diegetic_music describes audience-only music using instrumentation, tempo, rhythm, and dynamics, or N/A when absent."
    )


def _spoken_language(text: str) -> str:
    value = str(text or "")
    if re.search(r"[\u3040-\u30ff]", value):
        return "Japanese"
    if re.search(r"[\uac00-\ud7af]", value):
        return "Korean"
    if re.search(r"[\u3400-\u9fff]", value):
        return "Chinese"
    return "English"


def _officialize_prompt_without_reasoning(prompt: str, mode: str, duration: float, picture_count: int) -> str:
    """不加载文本模型时，用确定性规则整理为 MiniMax H3 官方提示词结构。"""
    source = str(prompt or "").strip()
    if not source:
        source = "A coherent cinematic scene develops naturally across the full video."
    official_fields = ("integrated_multimodal_description:", "subject_definitions:", "detailed_description:")
    if any(field in source for field in official_fields):
        return source

    dialogue_pattern = re.compile(
        r"(<Picture\s+(\d+)>)\s*(?:说|说道|问|询问|回答|回复|喊|叫|says?|asks?|replies?)?\s*[：:]\s*"
        r"(.+?)(?=\s*<Picture\s+\d+>\s*(?:(?:说|说道|问|询问|回答|回复|喊|叫|says?|asks?|replies?)\s*)?[：:]|$)",
        flags=re.IGNORECASE | re.DOTALL,
    )
    dialogue_matches = list(dialogue_pattern.finditer(source))
    speaker_ids: dict[str, int] = {}
    dialogue_actions: list[str] = []
    for match in dialogue_matches:
        picture_label = match.group(1)
        picture_number = int(match.group(2))
        spoken_text = match.group(3).strip()
        if not spoken_text:
            continue
        speaker_key = picture_label.casefold()
        if speaker_key not in speaker_ids:
            speaker_ids[speaker_key] = len(speaker_ids) + 1
        speaker_id = speaker_ids[speaker_key]
        subject_label = picture_label
        dialogue_actions.append(
            f"{subject_label} (S{speaker_id}) remains on-screen with the face and mouth clearly visible, turns naturally toward "
            f"the listener, and says while the lips and jaw move in precise synchronization with the spoken words: "
            f"<d>[{_spoken_language(spoken_text)}] {spoken_text}</d> {subject_label} (S{speaker_id}) finishes speaking and closes "
            "the mouth while the other visible characters keep their lips closed and react naturally."
        )

    narrative = dialogue_pattern.sub(" ", source)
    named_dialogue_pattern = re.compile(
        r"([A-Za-z\u3400-\u9fff][A-Za-z0-9_\u3400-\u9fff·]{0,29})\s*"
        r"(?:说|说道|问|询问|回答|回复|喊|叫|says?|asks?|replies?)\s*[：:]\s*"
        r"(.+?)(?=\s*[A-Za-z\u3400-\u9fff][A-Za-z0-9_\u3400-\u9fff·]{0,29}\s*"
        r"(?:说|说道|问|询问|回答|回复|喊|叫|says?|asks?|replies?)\s*[：:]|$)",
        flags=re.IGNORECASE | re.DOTALL,
    )
    for match in named_dialogue_pattern.finditer(narrative):
        speaker_name = match.group(1).strip()
        spoken_text = match.group(2).strip()
        speaker_key = speaker_name.casefold()
        if speaker_key not in speaker_ids:
            speaker_ids[speaker_key] = len(speaker_ids) + 1
        speaker_id = speaker_ids[speaker_key]
        dialogue_actions.append(
            f"{speaker_name} (S{speaker_id}) remains on-screen with the face and mouth clearly visible and says while the lips "
            f"and jaw move in precise synchronization with the spoken words: <d>[{_spoken_language(spoken_text)}] {spoken_text}</d> "
            f"{speaker_name} (S{speaker_id}) finishes speaking and closes the mouth while the other visible characters keep their "
            "lips closed and react naturally."
        )
    narrative = named_dialogue_pattern.sub(" ", narrative)
    if mode == "R2VA":
        narrative = re.sub(
            r"场景\s*[：:]\s*<Picture\s+(\d+)>",
            r"The scene and environment fully reference <Picture \1> and fill the entire frame edge-to-edge without blank margins, white canvas, letterboxing, or reference-board borders.",
            narrative,
            flags=re.IGNORECASE,
        )
    narrative = re.sub(r"\s+", " ", narrative).strip(" ,，。;")
    body_parts = [part for part in (narrative, *dialogue_actions) if part]
    body = " ".join(body_parts) or "The referenced subjects perform the requested actions in a coherent continuous scene."
    timeline = f"[Shot 1] Cinematic, coherent audiovisual continuity for the full {max(0.0, float(duration)):.2f}-second video. {body}"

    if mode == "R2VA":
        referenced_numbers = sorted({int(number) for number in re.findall(r"<Picture\s+(\d+)>", source)})
        if not referenced_numbers:
            referenced_numbers = list(range(1, max(0, int(picture_count)) + 1))
        definitions = " ".join(
            f"<Picture {number}> is the corresponding reusable visual character, scene, object, costume, or style reference."
            for number in referenced_numbers
        ) or "No reusable picture subject is defined."
        retention = " ".join(
            f"<Picture {number}>: fully_preserved - preserve identity, appearance, colors, clothing, objects, and spatial traits."
            for number in referenced_numbers
        ) or "N/A"
        return (
            f"subject_definitions: {definitions}\n\n"
            "summary: [reference generation] Preserve the referenced subjects and realize the user's requested scene, actions, and dialogue.\n\n"
            f"retention_analysis: {retention}\n\n"
            f"detailed_description: {timeline}\n\n"
            "overall_soundscape: Natural room tone, physical movement sounds, clothing movement, breathing, and synchronized non-verbal reactions support the visible action without repeating dialogue.\n\n"
            "non_diegetic_music: N/A"
        )

    seconds = f"{max(0.0, float(duration)):.2f}"
    alignment = {
        "I2VA": "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
        "FL2VA": f"How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the {seconds}-second mark of the target video.",
        "L2VA": f"How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the {seconds}-second mark of the target video.",
    }.get(mode, "")
    core = (
        f"integrated_multimodal_description: {timeline}\n\n"
        "overall_soundscape: Natural ambience, synchronized physical action sounds, breathing, and non-verbal reactions support the visible action without repeating dialogue.\n\n"
        "non_diegetic_music: N/A"
    )
    return f"{alignment}\n\n{core}" if alignment else core


def _apply_prompt_book(
    *,
    prompt: str,
    global_prompt: str,
    negative_prompt: str,
    prompt_replace_find: str,
    prompt_replace_with: str,
) -> str:
    """按替换、全局、负面约束的顺序整理单个分段提示词。"""
    result = str(prompt or "").strip()
    find_text = str(prompt_replace_find or "")
    if find_text:
        result = re.sub(re.escape(find_text), lambda _: str(prompt_replace_with or ""), result, flags=re.IGNORECASE)

    global_text = str(global_prompt or "").strip()
    negative_text = str(negative_prompt or "").strip()
    parts = [part for part in (global_text, result) if part]
    if negative_text:
        parts.append(f"Negative constraints (must not appear): {negative_text}")
    return "\n\n".join(parts)


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


def _audio_duration_seconds(value: Any) -> float | None:
    if not _is_audio(value):
        return None
    waveform = value.get("waveform")
    sample_rate = int(value.get("sample_rate") or 0)
    if not isinstance(waveform, torch.Tensor) or waveform.ndim < 1 or sample_rate <= 0:
        return None
    samples = int(waveform.shape[-1])
    return float(samples) / float(sample_rate) if samples > 0 else None


def _release_vram_before_sampling() -> None:
    try:
        from .gjj_gemma_text_generate import _clear_clip_cache
        _clear_clip_cache()
    except Exception:
        pass
    try:
        import comfy.model_management as model_management
        model_management.unload_all_models()
        model_management.soft_empty_cache()
    except Exception:
        pass


def _audio_to_cpu(value: Any) -> Any:
    if not _is_audio(value):
        return value
    return {
        **value,
        "waveform": value["waveform"].detach().to(device="cpu").contiguous(),
    }


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
    # MiniMax H3 的目标生成尺寸必须由画板宽高直接决定；参考图比例只由后续
    # 拉伸/补边/留边/裁剪处理，不能再次改写 latent 的宽高。
    return _aligned_dimension(panel_width), _aligned_dimension(panel_height)


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


def _library_selection_names(raw: Any) -> list[str]:
    try:
        items = json.loads(str(raw or "[]"))
    except Exception:
        items = []
    result: list[str] = []
    for item in items if isinstance(items, list) else []:
        value = item.get("name") if isinstance(item, dict) else item
        name = str(value or "").strip().lstrip("@").removeprefix("🏕️").strip()
        if name and name.casefold() not in {entry.casefold() for entry in result}:
            result.append(name)
    return result


def _prompt_library_references(prompt: str, marker: str, *, require_marker: bool = True) -> list[str]:
    root_name = "character_library" if marker == "@" else "scene_library"
    root = Path(str(getattr(folder_paths, "models_dir", "") or "")) / "GJJ" / root_name
    if not root.is_dir():
        return []
    candidates: list[tuple[str, str]] = []
    for path in root.glob("*/manifest.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        canonical = re.sub(r"^\s*(?:♀️|♂️|♀|♂)\s*", "", str(data.get("name") or data.get("id") or path.parent.name)).strip()
        for alias in {canonical, str(data.get("id") or "").strip(), path.parent.name}:
            if alias:
                candidates.append((alias, canonical))
    marker_pattern = (r"@\s*" if marker == "@" else r"🏕️?\s*") if require_marker else ""
    matches: list[tuple[int, int, str]] = []
    text = str(prompt or "")
    for alias, canonical in candidates:
        for found in re.finditer(marker_pattern + re.escape(alias), text, flags=re.IGNORECASE):
            matches.append((found.start(), len(alias), canonical))
    # 同一位置优先采用最长的真实库名称；不同位置按提示词出现顺序排列。
    best_by_position: dict[int, tuple[int, str]] = {}
    for position, length, canonical in matches:
        current = best_by_position.get(position)
        if current is None or length > current[0]:
            best_by_position[position] = (length, canonical)
    result: list[str] = []
    seen: set[str] = set()
    for position in sorted(best_by_position):
        canonical = best_by_position[position][1]
        key = canonical.casefold()
        if key not in seen:
            seen.add(key)
            result.append(canonical)
    return result


def _library_reference_assets(
    kind: str, names: list[str], reference_width: int | None = None, reference_height: int | None = None,
) -> list[tuple[torch.Tensor, str, str]]:
    root_name = "character_library" if kind == "actor" else "scene_library"
    root = Path(str(getattr(folder_paths, "models_dir", "") or "")) / "GJJ" / root_name
    if not root.is_dir() or not names:
        return []
    manifests: dict[str, tuple[Path, dict[str, Any]]] = {}
    for path in root.glob("*/manifest.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        display_name = re.sub(r"^\s*(?:♀️|♂️|♀|♂)\s*", "", str(data.get("name") or data.get("id") or path.parent.name)).strip()
        for alias in {display_name, str(data.get("id") or "").strip(), path.parent.name}:
            if alias:
                manifests[alias.casefold()] = (path.parent, data)
    result: list[tuple[torch.Tensor, str, str]] = []
    for requested in names:
        entry = manifests.get(str(requested).casefold())
        if not entry:
            continue
        directory, data = entry
        assets = data.get("views") if kind == "actor" else data.get("assets")
        assets = assets if isinstance(assets, list) else []
        asset = next((item for item in assets if isinstance(item, dict) and str(item.get("file") or "").strip()), None)
        if not asset:
            continue
        path = directory / Path(str(asset.get("file"))).name
        if not path.is_file():
            continue
        try:
            import numpy as np
            from PIL import Image, ImageOps
            image = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
            if kind == "actor":
                try:
                    from .gjj_storyboard_grid_generator import _make_qwen_direct_character_reference_boards

                    board_width = max(64, int(reference_width or image.width))
                    board_height = max(64, int(reference_height or image.height))
                    boards = _make_qwen_direct_character_reference_boards(
                        str(requested), [(str(requested), "")], board_width, board_height, max_boards=1, single_view_only=False,
                    )
                    if boards:
                        image = boards[0][1].convert("RGB")
                except Exception as collage_error:
                    print(f"[GJJ MiniMaxH3Studio] 生成角色拼图失败，回退单图 {requested}: {collage_error}")
            tensor = torch.from_numpy(np.asarray(image).astype("float32") / 255.0).unsqueeze(0)
        except Exception as exc:
            print(f"[GJJ MiniMaxH3Studio] 读取{root_name}引用图失败 {requested}: {exc}")
            continue
        name = re.sub(r"^\s*(?:♀️|♂️|♀|♂)\s*", "", str(data.get("name") or data.get("id") or requested)).strip()
        notes = re.sub(r"\s+", " ", str(data.get("notes") or "")).strip()
        result.append((tensor, name, notes))
    return result


def _library_reference_voices(names: list[str]) -> list[tuple[Any, str]]:
    """读取角色库绑定音色；返回顺序与角色引用顺序一致的 MiniMax 参考音频。"""
    character_root = Path(str(getattr(folder_paths, "models_dir", "") or "")) / "GJJ" / "character_library"
    voice_root = (Path(str(getattr(folder_paths, "models_dir", "") or "")) / "GJJ" / "wav").resolve()
    if not character_root.is_dir() or not voice_root.is_dir() or not names:
        return []
    manifests: dict[str, tuple[Path, dict[str, Any]]] = {}
    for manifest_path in character_root.glob("*/manifest.json"):
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        display_name = re.sub(
            r"^\s*(?:♀️|♂️|♀|♂)\s*", "",
            str(data.get("name") or data.get("id") or manifest_path.parent.name),
        ).strip()
        for alias in {display_name, str(data.get("id") or "").strip(), manifest_path.parent.name}:
            if alias:
                manifests[alias.casefold()] = (manifest_path.parent, data)

    result: list[tuple[Any, str]] = []
    for requested in names:
        entry = manifests.get(str(requested).casefold())
        if not entry:
            continue
        _directory, data = entry
        canonical = re.sub(
            r"^\s*(?:♀️|♂️|♀|♂)\s*", "",
            str(data.get("name") or data.get("id") or requested),
        ).strip()
        relative = str(data.get("voice_path") or data.get("voice") or "").strip().replace("\\", "/").lstrip("/")
        candidates = [relative] if relative else []
        if not candidates:
            for stem in (canonical, str(data.get("id") or "").strip(), entry[0].name):
                clean_stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).strip("._- ")
                if clean_stem:
                    candidates.extend((f"{clean_stem}.wav", f"{clean_stem}.mp3"))
        voice_path = None
        for candidate in candidates:
            if Path(candidate).suffix.lower() not in {".wav", ".mp3"}:
                continue
            resolved = (voice_root / candidate).resolve()
            if (resolved == voice_root or voice_root in resolved.parents) and resolved.is_file():
                voice_path = resolved
                break
        if voice_path is None:
            continue
        try:
            from comfy_extras.nodes_audio import load as load_comfy_audio
            waveform, sample_rate = load_comfy_audio(str(voice_path))
            result.append(({"waveform": waveform.unsqueeze(0), "sample_rate": int(sample_rate)}, canonical))
        except Exception as exc:
            print(f"[GJJ MiniMaxH3Studio] 读取角色音色失败 {canonical}: {exc}")
    return result


def _attach_official_voice_references(prompt: str, media: dict[str, list[Any]]) -> str:
    """用 ComfyUI MiniMax H3 官方 <Audio N> 标签声明角色与参考音色关系。"""
    voices = list(media.get("voice_audios") or [])
    if not voices:
        return str(prompt or "")
    video_audio_count = sum(1 for value in media.get("videos", []) if len(value) > 1 and value[1] is not None)
    standalone_count = len(media.get("audios", []))
    available = max(0, 4 - standalone_count)
    lines: list[str] = []
    for offset, item in enumerate(voices[:available], start=1):
        audio_number = video_audio_count + standalone_count + offset
        character_name = str(item.get("name") or "").strip()
        picture_number = int(item.get("picture_index") or 0)
        subject = f"<Picture {picture_number}>" if picture_number > 0 else character_name
        lines.append(
            f"<Audio {audio_number}> is the official reference voice/timbre for {subject}"
            f" ({character_name}). Whenever this character speaks, preserve the voice identity from "
            f"<Audio {audio_number}> and keep the assigned speaker ID consistent. Use it only as a timbre reference; "
            "never copy, replay, continue, quote, or output the reference recording's words, performance, timing, or waveform."
        )
    if not lines:
        return str(prompt or "")
    return "\n".join(("Reference voice assignments:", *lines, str(prompt or "").strip())).strip()


def _replace_library_picture_references(
    prompt: str, references: list[tuple[str, str, int]],
) -> str:
    """把正文中的资料库标记及已引用角色裸名替换为 MiniMax 图片引用。"""
    result = str(prompt or "")
    # 名称按长度降序处理，避免短名称是长名称前缀时提前截断。
    for kind, name, picture_index in sorted(references, key=lambda item: len(item[1]), reverse=True):
        marker = r"@\s*" if kind == "actor" else r"🏕️?\s*"
        result = re.sub(
            marker + re.escape(str(name)),
            f"<Picture {picture_index}>",
            result,
            flags=re.IGNORECASE,
        )
    actor_references = [item for item in references if item[0] == "actor" and str(item[1]).strip()]
    if actor_references:
        picture_by_name = {str(name).casefold(): picture_index for _kind, name, picture_index in actor_references}
        names_pattern = "|".join(re.escape(str(name)) for _kind, name, _index in sorted(actor_references, key=lambda item: len(item[1]), reverse=True))
        protected = re.compile(r"(<d>.*?</d>|“[^”]*”|\"[^\"]*\")", flags=re.IGNORECASE | re.DOTALL)
        chunks = protected.split(result)
        for index in range(0, len(chunks), 2):
            chunks[index] = re.sub(
                names_pattern,
                lambda match: f"<Picture {picture_by_name[match.group(0).casefold()]}>",
                chunks[index],
                flags=re.IGNORECASE,
            )
        result = "".join(chunks)
        unique_actor_pictures = list(dict.fromkeys(
            int(picture_index)
            for _kind, _name, picture_index in sorted(actor_references, key=lambda item: item[2])
        ))
        actor_tags = ", ".join(f"<Picture {picture_index}>" for picture_index in unique_actor_pictures)
        result = "\n".join((
            "CAST IDENTITY AND COUNT LOCK — mandatory: "
            f"The scene contains exactly {len(unique_actor_pictures)} referenced cast individual(s): {actor_tags}. "
            "Each tag represents exactly one persistent physical person throughout the complete shot. Every repeated "
            "mention of the same tag refers to that same person already present in the frame. Never create a second "
            "instance, clone, twin, duplicate, mirrored copy, stand-in, background copy, or look-alike of any referenced "
            "person. Do not add extra people unless the visual description explicitly requests them.",
            result,
        ))
    result = re.sub(r"(<Picture \d+>)\s*说\s*[：:]", r"\1：", result)
    if any(kind == "scene" for kind, _name, _index in references):
        result = re.sub(
            r"^\s*(?:<Picture \d+>\s*)+在\s*<Picture \d+>\s*对话\s*[.。]?\s*",
            "",
            result,
        )
    return result


def _mentioned_library_names(text: str, names: list[str]) -> list[str]:
    """按候选角色顺序返回当前分段正文实际提到的资料库名称。"""
    source = str(text or "")
    return [name for name in names if name and re.search(re.escape(str(name)), source, flags=re.IGNORECASE)]


def _speaking_library_names(text: str, names: list[str]) -> list[str]:
    """只识别明确位于对白冒号前的角色；普通画面提及不加载其参考音色。"""
    source = str(text or "")
    result: list[str] = []
    for name in names:
        pattern = rf"@\s*{re.escape(str(name))}\s*(?:(?:说|说道|问|询问|回答|回复|喊|叫|says?|asks?|replies?)\s*)?[：:]"
        if re.search(pattern, source, flags=re.IGNORECASE):
            result.append(name)
    return result


def _normalize_storyboard_segment(prompt: str) -> str:
    """把“序号||场景||动作||台词”转换成不会混淆画面与对白的明确结构。"""
    text = str(prompt or "").strip()
    if "||" not in text:
        return text

    fields = [field.strip() for field in text.split("||", 3)]
    if len(fields) != 4:
        return text

    segment_number, scene_description, action_description, dialogue = fields
    if not re.fullmatch(r"\d+", segment_number):
        return text

    parts = [
        (
            "VISUAL SCENE DESCRIPTION ONLY — never speak, narrate, quote, lip-sync, or turn any words "
            f"from this field into audio: {scene_description}"
        ),
        (
            "VISUAL ACTION AND CAMERA DIRECTION ONLY — never speak, narrate, quote, lip-sync, or turn any "
            f"words from this field into audio: {action_description}"
        ),
    ]
    if dialogue:
        parts.append(f"THE ONLY SPOKEN DIALOGUE IN THIS SEGMENT: {dialogue}")
    else:
        parts.append("THIS SEGMENT HAS NO SPOKEN DIALOGUE.")
    return "\n".join(parts)


def _strip_library_manifest_payloads(prompt: str) -> str:
    """移除误混入正文的角色/场景库 JSON；这些内部元数据绝不能发送给模型。"""
    text = str(prompt or "")
    decoder = json.JSONDecoder()
    cursor = 0
    cleaned: list[str] = []
    while cursor < len(text):
        start = min((pos for pos in (text.find("[{", cursor), text.find("{", cursor)) if pos >= 0), default=-1)
        if start < 0:
            cleaned.append(text[cursor:])
            break
        cleaned.append(text[cursor:start])
        try:
            payload, consumed = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            cleaned.append(text[start])
            cursor = start + 1
            continue
        entries = payload if isinstance(payload, list) else [payload]
        is_library_payload = bool(entries) and all(
            isinstance(item, dict)
            and bool({"id", "name"} & set(item))
            and bool({"notes", "keywords", "thumbnail_url", "voice", "views", "assets"} & set(item))
            for item in entries
        )
        if is_library_payload:
            cursor = start + consumed
            continue
        cleaned.append(text[start:start + consumed])
        cursor = start + consumed
    result = re.sub(r"[ \t]+\n", "\n", "".join(cleaned))
    # 上游分镜节点的栏目名只用于界面排版，不属于画面、对白或旁白内容。
    result = re.sub(r"(?im)(?<![\w])(?:视频提示词|镜头提示词|画面提示词)\s*[：:]\s*", "", result)
    return result.strip()


def _normalize_picture_reference_tags(prompt: str) -> str:
    """MiniMax H3 直接使用 Picture 引用；拒绝推理模型额外创造 Subject 别名。"""
    return re.sub(r"<Subject\s+(\d+)>", r"<Picture \1>", str(prompt or ""), flags=re.IGNORECASE)


def _save_library_reference_debug_images(
    images: list[torch.Tensor],
    assets: list[tuple[str, torch.Tensor, str, str]],
    unique_id: Any,
) -> list[Path]:
    if not images or not assets:
        return []
    try:
        from .common_utils.temp_files import gjjutils_temp_path, gjjutils_write_temp_tensor_images

        saved: list[Path] = []
        for index, ((kind, _original, name, _notes), tensor) in enumerate(zip(assets, images), start=1):
            infos = gjjutils_write_temp_tensor_images(tensor, format="PNG", suffix=".png", media_type="image")
            if not infos:
                continue
            path = gjjutils_temp_path(str(infos[0]["filename"]))
            saved.append(path)
            print(f"[GJJ_MiniMaxH3Studio] 参考图 <Picture {index}> · {kind} · {name} · 节点 {unique_id}: {path}", flush=True)
        return saved
    except Exception as exc:
        print(f"[GJJ_MiniMaxH3Studio] 保存角色/场景参考图到 temp 失败: {exc}", flush=True)
        return []


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
                "reference_media_3": (MEDIA_TYPE, {"display_name": "参考媒体 3", "tooltip": "第三个同级递归媒体入口；所有入口依次递归解包后按图片、视频、音频分类，并保持输入顺序。"}),
                "selected_actors_json": ("STRING", {"default": "[]", "display_name": "已选角色"}),
                "selected_scenes_json": ("STRING", {"default": "[]", "display_name": "已选场景"}),
                "global_prompt": ("STRING", {"default": "", "multiline": True, "display_name": "全局提示词"}),
                "negative_prompt": ("STRING", {"default": "", "multiline": True, "display_name": "负面提示词"}),
                "prompt_replace_find": ("STRING", {"default": "", "multiline": True, "display_name": "查找提示词"}),
                "prompt_replace_with": ("STRING", {"default": "", "multiline": True, "display_name": "替换为"}),
                "patch_enable_sage_attention": ("BOOLEAN", {"default": False, "display_name": "启用SageAttention"}),
                "patch_sage_attention_mode": (SAGE_ATTENTION_MODES, {"default": "自动", "display_name": "SageAttention模式"}),
                "patch_allow_sage_compile": ("BOOLEAN", {"default": False, "display_name": "允许Sage编译"}),
                "patch_enable_fp16_accumulation": ("BOOLEAN", {"default": False, "display_name": "启用FP16累积设置"}),
                "patch_fp16_accumulation": ("BOOLEAN", {"default": True, "display_name": "FP16累积"}),
                "patch_enable_ltxv_feedforward_chunk": ("BOOLEAN", {"default": False, "display_name": "启用LTXV前馈分块"}),
                "patch_feedforward_chunks": ("INT", {"default": 4, "min": 1, "max": 100, "step": 1, "display_name": "分块数量"}),
                "patch_feedforward_threshold": ("INT", {"default": 4096, "min": 0, "max": 16384, "step": 256, "display_name": "分块阈值"}),
                "patch_missing_sage_handling": (MISSING_SAGE_HANDLING_MODES, {"default": "自动跳过SageAttention继续运行", "display_name": "缺SageAttention处理"}),
                "spectrum_enabled": ("BOOLEAN", {"default": False, "display_name": "启用 Spectrum", "tooltip": "启用后在采样前应用 GJJ_SpectrumApplyMiniMaxH3 频谱预测加速。"}),
                "spectrum_blend_weight": ("FLOAT", {"default": 0.50, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "频谱混合权重", "tooltip": "0 为纯线性外推，1 为纯频谱预测。"}),
                "spectrum_degree": ("INT", {"default": 4, "min": 1, "max": 16, "step": 1, "display_name": "多项式阶数"}),
                "spectrum_ridge_lambda": ("FLOAT", {"default": 0.10, "min": 0.0, "max": 10.0, "step": 0.01, "display_name": "岭回归强度"}),
                "spectrum_window_size": ("FLOAT", {"default": 2.0, "min": 1.0, "max": 16.0, "step": 0.05, "display_name": "预测窗口"}),
                "spectrum_flex_window": ("FLOAT", {"default": 0.75, "min": 0.0, "max": 8.0, "step": 0.05, "display_name": "自适应窗口增量"}),
                "spectrum_warmup_steps": ("INT", {"default": 5, "min": 0, "max": 64, "step": 1, "display_name": "预热实算步数"}),
                "spectrum_tail_actual_steps": ("INT", {"default": 1, "min": 0, "max": 64, "step": 1, "display_name": "末尾实算步数"}),
                "spectrum_max_history": ("INT", {"default": 8, "min": 2, "max": 64, "step": 1, "display_name": "最大历史数量", "tooltip": "必须不少于多项式阶数加一。"}),
                "spectrum_debug": ("BOOLEAN", {"default": False, "display_name": "调试日志"}),
                "spectrum_history_storage": (["系统内存（RAM）", "显存（VRAM）"], {"default": "系统内存（RAM）", "display_name": "历史存储位置"}),
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

    def _load_models(self, *, model_name: str, clip_name: str, video_vae_name: str, audio_vae_name: str, keep: bool, unique_id: Any):
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
        _merge_media(media, _collect_media(kwargs.get("reference_media_3")))
        internal_texts: list[str] = []
        if not any(media.values()):
            internal_media, internal_texts = _load_internal_media(first("internal_media_json", "[]"))
            _merge_media(media, internal_media)
        prompt = _strip_library_manifest_payloads("\n\n".join(
            part for part in [str(first("prompt", "") or "").strip(), *[text.strip() for text in internal_texts]] if part
        ))
        raw_prompt_parts = [part.strip() for part in prompt.split("---") if part.strip()] or [prompt]
        prompt_actors = _prompt_library_references(prompt, "@")
        bare_prompt_actors = _prompt_library_references(prompt, "@", require_marker=False)
        prompt_scenes = _prompt_library_references(prompt, "🏕️")
        configured_actors = _library_selection_names(first("selected_actors_json", "[]"))
        actor_candidates = list(dict.fromkeys([*prompt_actors, *bare_prompt_actors, *configured_actors]))
        # 提示词中出现某类资料库引用时，以提示词解析结果替换节点内该类选择。
        selected_actors = list(dict.fromkeys([*prompt_actors, *bare_prompt_actors])) or configured_actors
        selected_scenes = prompt_scenes or _library_selection_names(first("selected_scenes_json", "[]"))
        unique_id = first("unique_id")
        _send_status(unique_id, "已解析上游角色与场景引用", 0.0, {
            "parsed_actors": selected_actors,
            "parsed_scenes": selected_scenes,
        })
        external_images = list(media["images"])
        external_image_count = len(external_images)
        panel_width, panel_height = int(first("width", 864)), int(first("height", 480))
        pooled_assets = {
            "scene": _library_reference_assets("scene", selected_scenes, panel_width, panel_height),
            "actor": _library_reference_assets("actor", actor_candidates, panel_width, panel_height),
        }

        def part_library_assets(kind: str, names: list[str]) -> list[tuple[str, torch.Tensor, str, str]]:
            available = {name.casefold(): (image, name, notes) for image, name, notes in pooled_assets[kind]}
            return [(kind, *available[name.casefold()]) for name in names if name.casefold() in available]

        segmented_library_media: list[tuple[str, dict[str, list[Any]], list[tuple[str, torch.Tensor, str, str]]]] = []
        for raw_part in raw_prompt_parts:
            speaking_actors = _speaking_library_names(raw_part, actor_candidates)
            if prompt_actors or bare_prompt_actors:
                explicit_actors = _prompt_library_references(raw_part, "@")
                mentioned_actors = _mentioned_library_names(raw_part, actor_candidates)
                part_actors = list(dict.fromkeys([*explicit_actors, *mentioned_actors]))
            else:
                part_actors = selected_actors
            part_scenes = _prompt_library_references(raw_part, "🏕️") if prompt_scenes else selected_scenes
            part_assets = (
                part_library_assets("scene", part_scenes)
                + part_library_assets("actor", part_actors)
            )[:max(0, 10 - external_image_count)]
            part_images: list[torch.Tensor] = []
            part_references: list[tuple[str, str, int]] = []
            scene_lines: list[str] = []
            for picture_number, (kind, image, name, _notes) in enumerate(part_assets, start=1):
                part_images.append(image)
                part_references.append((kind, name, picture_number))
                if kind == "scene":
                    scene_lines.append(f"场景：<Picture {picture_number}>")
            actor_picture_numbers = {
                name.casefold(): picture_number
                for kind, name, picture_number in part_references
                if kind == "actor"
            }
            voice_audios = [
                {
                    "audio": audio,
                    "name": name,
                    "picture_index": actor_picture_numbers.get(name.casefold(), 0),
                }
                for audio, name in _library_reference_voices(speaking_actors)
            ]
            structured_part = _normalize_storyboard_segment(raw_part)
            segment_prompt = _replace_library_picture_references(structured_part, part_references) if part_references else structured_part
            if scene_lines:
                segment_prompt = "\n".join([*scene_lines, segment_prompt]).strip()
            segmented_library_media.append((segment_prompt, {
                "images": part_images + list(external_images),
                "videos": list(media["videos"]), "audios": list(media["audios"]),
                "voice_audios": voice_audios,
            }, part_assets))
        library_assets = list(dict.fromkeys(
            (asset[0], asset[2].casefold()) for _part, _part_media, assets in segmented_library_media for asset in assets
        ))
        has_library_voices = any(segment_media.get("voice_audios") for _part, segment_media, _assets in segmented_library_media)
        media["images"] = list(segmented_library_media[0][1]["images"]) if segmented_library_media else external_images
        source = media["images"][0] if media["images"] else (media["videos"][0][0] if media["videos"] else None)
        width, height = _target_dimensions(
            panel_width, panel_height, _visual_size(source), bool(first("use_source_size", True)), str(first("size_mode", "宽高")),
        )
        fit_mode = str(first("resize_fit_mode", "裁剪"))
        resize_anchor = str(first("resize_anchor", "上"))
        for _segment_prompt, segment_media, assets in segmented_library_media:
            segment_media["images"] = [
                _resize_visual(
                    image,
                    width,
                    height,
                    ("裁剪" if assets[index][0] == "scene" else "适应") if index < len(assets) else fit_mode,
                    resize_anchor,
                )
                for index, image in enumerate(segment_media["images"])
            ]
            segment_media["videos"] = [
                (_resize_visual(frames, width, height, fit_mode, resize_anchor), audio, source_fps)
                for frames, audio, source_fps in segment_media["videos"]
            ]
        if not segmented_library_media:
            _align_media(media, width, height, fit_mode, resize_anchor)
        debug_assets = [
            (kind, image, name, notes)
            for kind in ("scene", "actor") for image, name, notes in pooled_assets[kind]
        ]
        _save_library_reference_debug_images(
            [asset[1] for asset in debug_assets], debug_assets, unique_id,
        )
        fps = float(first("frame_rate", 24.0))
        duration = float(first("duration", 5.0))
        seed = int(first("seed", 42))
        if bool(first("randomize_seed", True)):
            seed = int(torch.randint(0, 0x7FFFFFFF, (1,)).item())
        prompt_parts = [item[0] for item in segmented_library_media]
        prompt_parts = [
            _attach_official_voice_references(
                _strip_library_manifest_payloads(_apply_prompt_book(
                        prompt=raw_part,
                        global_prompt=str(first("global_prompt", "") or ""),
                        negative_prompt=str(first("negative_prompt", "") or ""),
                        prompt_replace_find=str(first("prompt_replace_find", "") or ""),
                        prompt_replace_with=str(first("prompt_replace_with", "") or ""),
                    )),
                segmented_library_media[index][1],
            )
            for index, raw_part in enumerate(prompt_parts)
        ]

        image_count = len(media["images"])
        requested_branch = str(first("image_branch", "参考") or "参考")
        if library_assets or has_library_voices:
            image_branch = "参考"
        elif image_count == 1:
            image_branch = requested_branch if requested_branch in {"参考", "首帧", "尾帧"} else "参考"
        elif image_count == 2:
            image_branch = requested_branch if requested_branch in {"参考", "首尾帧"} else "参考"
        elif image_count > 2:
            image_branch = requested_branch if requested_branch in {"参考", "分段首尾帧"} else "参考"
        else:
            image_branch = "参考"

        has_reference_av = bool(media["videos"] or media["audios"] or has_library_voices)
        if image_branch == "参考" and (image_count or has_reference_av):
            official_prompt_mode = "R2VA"
        elif image_branch in {"首尾帧", "分段首尾帧"}:
            official_prompt_mode = "FL2VA"
        elif image_branch == "尾帧":
            official_prompt_mode = "L2VA"
        elif image_count == 1:
            official_prompt_mode = "I2VA"
        elif not has_reference_av:
            official_prompt_mode = "T2VA"
        else:
            official_prompt_mode = "R2VA"

        if bool(first("reasoning_enabled", False)):
            from .gjj_gemma_text_generate import GJJ_GemmaTextGenerate

            configured_system_prompt = str(first("reasoning_system_prompt", DEFAULT_REASONING_SYSTEM_PROMPT) or "").strip()
            reasoning_system_prompt = "\n\n".join(filter(None, (
                configured_system_prompt or DEFAULT_REASONING_SYSTEM_PROMPT,
                _official_prompt_rewrite_rules(mode=official_prompt_mode, duration=duration, picture_count=image_count),
            )))
            inferred_parts: list[str] = []
            for infer_index, raw_part in enumerate(prompt_parts):
                reasoning_images = segmented_library_media[infer_index][1]["images"]
                reasoning_media = torch.cat(reasoning_images, dim=0) if reasoning_images else None
                _send_status(unique_id, f"推理提示词 {infer_index + 1}/{len(prompt_parts)}...", 0.01)
                generated = GJJ_GemmaTextGenerate().generate(
                    clip_name=str(first("reasoning_model", DEFAULT_REASONING_KEYWORD)),
                    clip_type="stable_diffusion", clip_device="default", prompt=raw_part,
                    max_length=2048, sampling_mode="off", temperature=0.35, top_k=64,
                    top_p=0.95, min_p=0.05, repetition_penalty=1.05, seed=0,
                    presence_penalty="0.0", thinking=False, use_default_template=True,
                    media=reasoning_media, unique_id=unique_id,
                    system_prompt=reasoning_system_prompt,
                    keep_model=bool(first("keep_model", False)), device_preference="GPU优先",
                )
                payload = generated.get("result") if isinstance(generated, dict) else generated
                inferred = str(payload[0] if isinstance(payload, (list, tuple)) and payload else payload or "").strip()
                inferred_parts.append(inferred or raw_part)
            prompt_parts = inferred_parts
        else:
            prompt_parts = [
                _officialize_prompt_without_reasoning(
                    prompt=raw_part,
                    mode=official_prompt_mode,
                    duration=duration,
                    picture_count=len(segmented_library_media[index][1]["images"]),
                )
                for index, raw_part in enumerate(prompt_parts)
            ]
        prompt_parts = [_normalize_picture_reference_tags(item) for item in prompt_parts]

        jobs: list[tuple[str, dict[str, list[Any]]]] = []
        if library_assets or has_library_voices:
            for index, segment_prompt in enumerate(prompt_parts):
                segment_media = segmented_library_media[index][1]
                jobs.append((segment_prompt, {
                    "images": list(segment_media["images"]), "videos": list(segment_media["videos"]), "audios": list(segment_media["audios"]),
                    "voice_audios": list(segment_media.get("voice_audios") or []),
                }))
        elif image_branch == "分段首尾帧":
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
        queued_audios = list(media["audios"])
        if len(queued_audios) > 1 and jobs:
            source_jobs = list(jobs)
            jobs = [
                (
                    source_jobs[min(index, len(source_jobs) - 1)][0],
                    {**source_jobs[min(index, len(source_jobs) - 1)][1], "audios": [audio]},
                )
                for index, audio in enumerate(queued_audios)
            ]
        segment_count = len(jobs)
        filename_prefix = str(first("filename_prefix", "video/MiniMax_H3_Studio"))
        requested_format = str(first("format_name", DEFAULT_FORMAT) or "").strip()
        supported_formats = set(list_supported_formats())
        format_name = requested_format if requested_format in supported_formats else DEFAULT_FORMAT
        runtime_models: dict[str, tuple[Any, Any, Any, Any]] = {}

        def segment_mode(segment: dict[str, list[Any]]) -> str:
            image_count = len(segment["images"])
            has_reference_av = bool(segment["videos"] or segment["audios"] or segment.get("voice_audios"))
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
        _release_vram_before_sampling()
        decoded_segments: list[torch.Tensor] = []
        audio_segments: list[Any] = []
        modes: list[str] = []
        for index, (segment_prompt, current_media) in enumerate(jobs):
            segment_duration = duration
            if current_media["audios"]:
                measured_duration = _audio_duration_seconds(current_media["audios"][0])
                if measured_duration is not None:
                    segment_duration = measured_duration
            if segment_duration > MAX_AUDIO_DRIVEN_DURATION + 1e-6:
                raise RuntimeError(
                    f"队列第 {index + 1} 段音频长 {segment_duration:.3f} 秒，超过 MiniMax H3 安全上限 "
                    f"{MAX_AUDIO_DRIVEN_DURATION:.1f} 秒。请在上游按不超过该时长重新分段；"
                    "禁止直接生成超长 latent，否则注意力遮罩会导致显存爆炸。"
                )
            segment_length = _aligned_frames(duration=segment_duration, fps=fps)
            mode = segment_mode(current_media)
            modes.append(mode)
            print(
                f"\n[GJJ_MiniMaxH3Studio] ===== 最终提示词 {index + 1}/{segment_count} · {mode} =====\n"
                f"{segment_prompt}\n"
                f"[GJJ_MiniMaxH3Studio] ===== 最终提示词结束 =====\n",
                flush=True,
            )
            model_name = str(first("ref_model" if mode == "R2V" else "fl_model", DEFAULT_REF_MODEL if mode == "R2V" else DEFAULT_FL_MODEL))
            _send_status(unique_id, f"队列 {index + 1}/{segment_count} · {mode} · {segment_duration:.3f}秒：加载模型...", index / segment_count)
            if model_name not in runtime_models:
                loaded_model, loaded_clip, loaded_video_vae, loaded_audio_vae = self._load_models(
                    model_name=model_name,
                    clip_name=str(first("clip_name", DEFAULT_CLIP)),
                    video_vae_name=str(first("video_vae_name", DEFAULT_VIDEO_VAE)),
                    audio_vae_name=str(first("audio_vae_name", DEFAULT_AUDIO_VAE)),
                    keep=bool(first("keep_model", False)),
                    unique_id=unique_id,
                )
                patched_model, _ = GJJ_ModelPatchBundle().patch(
                    MODEL=loaded_model,
                    启用SageAttention=bool(first("patch_enable_sage_attention", False)),
                    SageAttention模式=str(first("patch_sage_attention_mode", "自动")),
                    允许Sage编译=bool(first("patch_allow_sage_compile", False)),
                    启用FP16累积设置=bool(first("patch_enable_fp16_accumulation", False)),
                    FP16累积=bool(first("patch_fp16_accumulation", True)),
                    # MiniMax H3 不具备 LTXV 的 transformer_blocks.*.ff.net 结构；
                    # 保留旧输入槽位仅用于工作流兼容，执行时永远不应用该专用补丁。
                    启用LTXV前馈分块=False,
                    分块数量=int(first("patch_feedforward_chunks", 4)),
                    分块阈值=int(first("patch_feedforward_threshold", 4096)),
                    缺SageAttention处理=str(first("patch_missing_sage_handling", "自动跳过SageAttention继续运行")),
                    unique_id=unique_id,
                )
                patched_model = GJJ_SpectrumApplyMiniMaxH3().apply(
                    model=patched_model,
                    enabled=bool(first("spectrum_enabled", False)),
                    blend_weight=float(first("spectrum_blend_weight", 0.50)),
                    degree=int(first("spectrum_degree", 4)),
                    ridge_lambda=float(first("spectrum_ridge_lambda", 0.10)),
                    window_size=float(first("spectrum_window_size", 2.0)),
                    flex_window=float(first("spectrum_flex_window", 0.75)),
                    warmup_steps=int(first("spectrum_warmup_steps", 5)),
                    tail_actual_steps=int(first("spectrum_tail_actual_steps", 1)),
                    max_history=int(first("spectrum_max_history", 8)),
                    debug=bool(first("spectrum_debug", False)),
                    history_storage=str(first("spectrum_history_storage", "系统内存（RAM）")),
                )[0]
                runtime_models[model_name] = (patched_model, loaded_clip, loaded_video_vae, loaded_audio_vae)
            model, clip, video_vae, audio_vae = runtime_models[model_name]
            if mode == "R2V":
                ref_images = {f"ref_image_{i}": value for i, value in enumerate(current_media["images"][:10])}
                ref_videos = {f"ref_video_{i}": value[0] for i, value in enumerate(current_media["videos"][:4])}
                ref_video_audios = {f"ref_video_audio_{i}": value[1] for i, value in enumerate(current_media["videos"][:4]) if value[1] is not None}
                # 两类音频都只进入 H3 的参考条件；最终视频音轨始终来自 sampled latent 的 VAEDecodeAudio。
                conditioning_audios = list(current_media["audios"])
                conditioning_audios.extend(
                    item["audio"] for item in current_media.get("voice_audios", [])
                    if isinstance(item, dict) and item.get("audio") is not None
                )
                ref_audios = {f"ref_audio_{i}": value for i, value in enumerate(conditioning_audios[:4])}
                positive, latent = _unwrap_node_output(MiniMaxH3ReferenceToVideo.execute(
                    clip=clip,
                    vae=video_vae,
                    audio_vae=audio_vae,
                    prompt=segment_prompt,
                    width=width,
                    height=height,
                    length=segment_length,
                    ref_image_size=str(first("ref_image_size", "match")),
                    ref_images=ref_images,
                    ref_videos=ref_videos,
                    ref_video_audios=ref_video_audios,
                    ref_audios=ref_audios,
                ))[:2]
            else:
                first_frame = current_media["images"][0] if mode in {"I2V", "首尾帧"} else None
                last_frame = current_media["images"][1] if mode == "首尾帧" else (current_media["images"][0] if mode == "尾帧" else None)
                positive, latent = _unwrap_node_output(MiniMaxH3ImageToVideo.execute(
                    clip=clip,
                    vae=video_vae,
                    prompt=segment_prompt,
                    width=width,
                    height=height,
                    length=segment_length,
                    first_frame=first_frame,
                    last_frame=last_frame,
                ))[:2]
            guider = _node_output_first(BasicGuider.execute(model=model, conditioning=positive))
            noise = _node_output_first(RandomNoise.execute(noise_seed=(seed + index) % (1 << 64)))
            sampler = _ksampler(str(first("sampler_name", "res_multistep")))
            sigmas = _basic_sigmas(model, str(first("scheduler", "simple")), int(first("steps", 20)), float(first("denoise", 1.0)))
            _send_status(unique_id, f"队列 {index + 1}/{segment_count} · 正在采样...", (index + 0.2) / segment_count)
            sampled = _unwrap_node_output(SamplerCustomAdvanced.execute(
                noise=noise, guider=guider, sampler=sampler, sigmas=sigmas, latent_image=latent,
            ))[0]
            segment_images = nodes.VAEDecode().decode(vae=video_vae, samples=sampled)[0]
            segment_audio = _unwrap_node_output(VAEDecodeAudio.execute(vae=audio_vae, samples=sampled))[0]
            # 相邻段共享边界图；后续片段移除第 1 帧，避免拼接时重复该边界帧。
            if image_branch == "分段首尾帧" and index > 0 and int(segment_images.shape[0]) > 1:
                segment_images = segment_images[1:].contiguous()
            segment_images = segment_images.detach().to(device="cpu").contiguous()
            segment_audio = _audio_to_cpu(segment_audio)
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
        ui.update({"mode": [final_mode], "frame_count": [frame_count], "segment_count": [segment_count], "source_image_count": [image_count], "image_branch": [image_branch], "output_path": [str(output_path or "")], "preview_scope": ["final"], "parsed_actors": selected_actors, "parsed_scenes": selected_scenes})
        # 最终合并文件写出后再次推送完整预览字段，覆盖分段过程中显示的最后一段视频。
        _send_status(unique_id, f"{final_mode} 完成：{frame_count} 帧", 1.0, ui)
        return {"ui": ui, "result": (video,)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MiniMaxH3Studio}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·🧠多模态视频一键生成(MiniMax H3)"}
