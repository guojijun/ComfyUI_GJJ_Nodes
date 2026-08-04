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
        "Write shot actions in playback order. [Shot 1] has no timestamp; later shots use strictly increasing "
        "[Shot N] At MM:SS.mmm timestamps within the video duration. Express camera motion naturally with motion type, "
        "and add amplitude/speed only when meaningful. Keep visible text verbatim in double quotes. "
        "Do not invent extra dialogue or translate dialogue. Output only the finished prompt, without commentary or Markdown fences."
    )
    if mode == "R2VA":
        return (
            f"Task: full-reference generation, duration {seconds} seconds, {picture_count} reference picture(s). {shared} "
            "Write all structural prose in English and use exactly these six sections in order: subject_definitions:, summary:, "
            "retention_analysis:, detailed_description:, overall_soundscape:, non_diegetic_music:. "
            "In subject_definitions, define reusable characters, scenes, objects, costumes, or styles as <Subject N> and cite their "
            "source <Picture N>. Keep every existing <Picture N> index unchanged. Use [reference generation] in summary unless another "
            "relationship is explicitly required. Use only valid retention markers: fully_preserved, partially_preserved, "
            "attribute_transfer, weak_reference. In detailed_description, cite <Subject N> naturally where it appears. "
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
        subject_label = f"<Subject {picture_number}>" if mode == "R2VA" else picture_label
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
            r"The scene and environment fully reference <Subject \1> and fill the entire frame edge-to-edge without blank margins, white canvas, letterboxing, or reference-board borders.",
            narrative,
            flags=re.IGNORECASE,
        )
    narrative = re.sub(r"\s+", " ", narrative).strip(" ,，。;")
    if mode == "R2VA":
        narrative = re.sub(r"<Picture\s+(\d+)>", r"<Subject \1>", narrative)
    body_parts = [part for part in (narrative, *dialogue_actions) if part]
    body = " ".join(body_parts) or "The referenced subjects perform the requested actions in a coherent continuous scene."
    timeline = f"[Shot 1] Cinematic, coherent audiovisual continuity for the full {max(0.0, float(duration)):.2f}-second video. {body}"

    if mode == "R2VA":
        referenced_numbers = sorted({int(number) for number in re.findall(r"<Picture\s+(\d+)>", source)})
        if not referenced_numbers:
            referenced_numbers = list(range(1, max(0, int(picture_count)) + 1))
        definitions = " ".join(
            f"<Picture {number}> defines <Subject {number}> as the corresponding reusable visual subject or environment."
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


def _prompt_library_references(prompt: str, marker: str) -> list[str]:
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
    marker_pattern = r"@\s*" if marker == "@" else r"🏕️?\s*"
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


def _replace_library_picture_references(
    prompt: str, references: list[tuple[str, str, int]],
) -> str:
    """把正文中的角色/场景库标记替换为对应的 MiniMax 图片引用。"""
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
    result = re.sub(r"(<Picture \d+>)\s*说\s*[：:]", r"\1：", result)
    if any(kind == "scene" for kind, _name, _index in references):
        result = re.sub(
            r"^\s*(?:<Picture \d+>\s*)+在\s*<Picture \d+>\s*对话\s*[.。]?\s*",
            "",
            result,
        )
    return result


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
        _merge_media(media, _collect_media(kwargs.get("reference_media_3")))
        internal_texts: list[str] = []
        if not any(media.values()):
            internal_media, internal_texts = _load_internal_media(first("internal_media_json", "[]"))
            _merge_media(media, internal_media)
        prompt = "\n\n".join(part for part in [str(first("prompt", "") or "").strip(), *[text.strip() for text in internal_texts]] if part)
        raw_prompt_parts = [part.strip() for part in prompt.split("---") if part.strip()] or [prompt]
        prompt_actors = _prompt_library_references(prompt, "@")
        prompt_scenes = _prompt_library_references(prompt, "🏕️")
        # 提示词中出现某类资料库引用时，以提示词解析结果替换节点内该类选择。
        selected_actors = prompt_actors or _library_selection_names(first("selected_actors_json", "[]"))
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
            "actor": _library_reference_assets("actor", selected_actors, panel_width, panel_height),
        }

        def part_library_assets(kind: str, names: list[str]) -> list[tuple[str, torch.Tensor, str, str]]:
            available = {name.casefold(): (image, name, notes) for image, name, notes in pooled_assets[kind]}
            return [(kind, *available[name.casefold()]) for name in names if name.casefold() in available]

        segmented_library_media: list[tuple[str, dict[str, list[Any]], list[tuple[str, torch.Tensor, str, str]]]] = []
        for raw_part in raw_prompt_parts:
            part_actors = _prompt_library_references(raw_part, "@") if prompt_actors else selected_actors
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
            segment_prompt = _replace_library_picture_references(raw_part, part_references) if part_references else raw_part
            if scene_lines:
                segment_prompt = "\n".join([*scene_lines, segment_prompt]).strip()
            segmented_library_media.append((segment_prompt, {
                "images": part_images + list(external_images),
                "videos": list(media["videos"]), "audios": list(media["audios"]),
            }, part_assets))
        library_assets = list(dict.fromkeys(
            (asset[0], asset[2].casefold()) for _part, _part_media, assets in segmented_library_media for asset in assets
        ))
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
        length = _aligned_frames(duration, fps)
        seed = int(first("seed", 42))
        if bool(first("randomize_seed", True)):
            seed = int(torch.randint(0, 0x7FFFFFFF, (1,)).item())
        prompt_parts = [item[0] for item in segmented_library_media]

        image_count = len(media["images"])
        requested_branch = str(first("image_branch", "参考") or "参考")
        if library_assets:
            image_branch = "参考"
        elif image_count == 1:
            image_branch = requested_branch if requested_branch in {"参考", "首帧", "尾帧"} else "参考"
        elif image_count == 2:
            image_branch = requested_branch if requested_branch in {"参考", "首尾帧"} else "参考"
        elif image_count > 2:
            image_branch = requested_branch if requested_branch in {"参考", "分段首尾帧"} else "参考"
        else:
            image_branch = "参考"

        has_reference_av = bool(media["videos"] or media["audios"])
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
                _official_prompt_rewrite_rules(official_prompt_mode, duration, image_count),
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
                    raw_part, official_prompt_mode, duration, len(segmented_library_media[index][1]["images"]),
                )
                for index, raw_part in enumerate(prompt_parts)
            ]

        jobs: list[tuple[str, dict[str, list[Any]]]] = []
        if library_assets:
            for index, segment_prompt in enumerate(prompt_parts):
                segment_media = segmented_library_media[index][1]
                jobs.append((segment_prompt, {
                    "images": list(segment_media["images"]), "videos": list(segment_media["videos"]), "audios": list(segment_media["audios"]),
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
            print(
                f"\n[GJJ_MiniMaxH3Studio] ===== 最终提示词 {index + 1}/{segment_count} · {mode} =====\n"
                f"{segment_prompt}\n"
                f"[GJJ_MiniMaxH3Studio] ===== 最终提示词结束 =====\n",
                flush=True,
            )
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
        ui.update({"mode": [final_mode], "frame_count": [frame_count], "segment_count": [segment_count], "source_image_count": [image_count], "image_branch": [image_branch], "output_path": [str(output_path or "")], "preview_scope": ["final"], "parsed_actors": selected_actors, "parsed_scenes": selected_scenes})
        # 最终合并文件写出后再次推送完整预览字段，覆盖分段过程中显示的最后一段视频。
        _send_status(unique_id, f"{final_mode} 完成：{frame_count} 帧", 1.0, ui)
        return {"ui": ui, "result": (video,)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MiniMaxH3Studio}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·🧠多模态视频一键生成(MiniMax H3)"}
