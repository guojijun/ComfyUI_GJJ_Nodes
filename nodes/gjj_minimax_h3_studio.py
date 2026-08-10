from __future__ import annotations

import hashlib
import json
import re
import time
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
from .gjj_multi_lora_chain import apply_lora_chain_config, parse_lora_data
from .gjj_spectrum_apply_minimax_h3 import GJJ_SpectrumApplyMiniMaxH3
from .common_utils.temp_files import (
    GJJ_TEMP_SUBFOLDER,
    gjjutils_read_temp_bytes,
    gjjutils_read_temp_pil_image,
    gjjutils_temp_path,
    gjjutils_write_temp_bytes,
    gjjutils_write_temp_file,
    gjjutils_write_temp_tensor_images,
)


NODE_NAME = "GJJ_MiniMaxH3Studio"
MAX_REFERENCE_MEDIA_2 = 15
MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO,AUDIO"
UPLOAD_ROUTE = "/gjj/minimax_h3_studio/upload"

DEFAULT_FL_MODEL = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
DEFAULT_REF_MODEL = "minimax_h3_ref2va_pruned_nvfp4.safetensors"
DEFAULT_FL_MODEL_KEYWORD = "minimax_h3_fl2va"
DEFAULT_REF_MODEL_KEYWORD = "minimax_h3_ref2va"
DEFAULT_CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
DEFAULT_VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
DEFAULT_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"
DEFAULT_REASONING_KEYWORD = "qwen3.5-4b"
DEFAULT_ACCEL_LORA_KEYWORD = "minima_h3_turbo"
DEFAULT_ACCEL_STEPS = 4
MAX_AUDIO_DRIVEN_DURATION = 15.0
DIALOGUE_LANGUAGE_TAGS = {
    "中文": "Chinese",
    "英语": "English",
    "阿拉伯语": "Arabic",
    "法语": "French",
    "德语": "German",
    "意大利语": "Italian",
    "日语": "Japanese",
    "韩语": "Korean",
    "葡萄牙语": "Portuguese",
    "俄语": "Russian",
    "西班牙语": "Spanish",
}


def _default_accel_lora_data() -> str:
    terms = [
        item for item in re.split(r"[^a-z0-9\u4e00-\u9fff]+", DEFAULT_ACCEL_LORA_KEYWORD.casefold())
        if item
    ]
    candidates = [
        str(item) for item in folder_paths.get_filename_list("loras")
        if all(term in str(item).casefold() for term in terms)
    ]
    candidates.sort(key=lambda item: ("converted" in item.casefold(), len(item), item.casefold()))
    return json.dumps(
        [{"enabled": True, "name": candidates[0], "strength": 1.0}],
        ensure_ascii=False,
    ) if candidates else "[]"


def _uses_default_accel_lora(raw_value: Any) -> bool:
    terms = [
        item for item in re.split(r"[^a-z0-9\u4e00-\u9fff]+", DEFAULT_ACCEL_LORA_KEYWORD.casefold())
        if item
    ]
    for item in parse_lora_data(raw_value):
        try:
            strength = float(item.get("strength", 1.0) or 0.0)
        except (TypeError, ValueError):
            strength = 1.0
        if (
            bool(item.get("enabled", True))
            and all(term in str(item.get("name", "")).casefold() for term in terms)
            and abs(strength) > 1e-5
        ):
            return True
    return False


DEFAULT_REASONING_SYSTEM_PROMPT = (
    "你是 MiniMax H3 官方格式视频提示词改写器。严格保留用户意图、对白原文、歌词和画面文字，"
    "根据当前任务模式输出可直接送入模型的最终提示词。所有结构字段、说明与画面描述必须使用英文；"
    "仅对白、歌词和画面中真实可见的文字严格保留原语言。"
    "输入中的 __GJJ_DIALOGUE_XXXX__ 是受保护原文占位符，必须原样、完整且仅出现一次，禁止翻译、改写或删除。"
    "不要解释、不要分析过程、不要 Markdown 代码块。"
)


def _official_prompt_rewrite_rules(
    mode: str, duration: float, picture_count: int, dialogue_language: str = "中文",
) -> str:
    seconds = f"{max(0.0, float(duration)):.2f}"
    language_tag = DIALOGUE_LANGUAGE_TAGS.get(str(dialogue_language), "Chinese")
    shared = (
        "最高优先级输出语言规则：全部结构字段、说明、分析、画面、动作、运镜和声音描述必须使用英文；"
        "仅对白、歌词和画面中真实可见的文字保留原语言。保持 <Subject N>/<Picture N>/<Video N>/<Audio N>、"
        f"[Shot N]、(S1)、<d>、<scenetrans>、<cutoff>、[{language_tag}]、模式代码、时间格式及官方保留级别标记。"
        "严格遵循 MiniMax H3 视频提示词规范，逐字保留用户提供的对白与标点。"
        "任何 __GJJ_DIALOGUE_XXXX__ 都是受保护原文占位符，必须原样且仅复制一次，禁止翻译、改写或删除。"
        f"每句对白都放入 <d>[{language_tag}] ...</d>，所有对白无一例外使用 [{language_tag}]。"
        "为说话者分配稳定的 (S1)、(S2) 等编号。每句对白前在标签外明确具体说话者及说话动作。"
        "除非用户明确要求画外音或离屏说话，否则说话者必须全程在画面内，脸部和嘴部清晰可见，"
        "嘴唇与下颌自然运动并与台词精准同步；说完后闭嘴，其他可见角色在倾听或反应时保持闭嘴。"
        "不得为了简化镜头把现场对白改成旁白、内心独白、配乐演唱或画外音。"
        "为完整台词留出自然语速所需的连续时长；仅在用户明确要求截断时使用 <cutoff>。"
        "避免用姿势、物体、构图或运镜遮挡当前说话者的嘴部。"
        "所有参考场景或环境都必须铺满目标画面，不保留白边、白底画布、黑边、参考板边框或无用空间。"
        "同一角色的重复 <Picture N> 始终代表同一个持续存在的人物；除非用户明确要求，不得克隆、复制、镜像、"
        "替换或添加相似副本，每个参考角色只保留一个实例。"
        "按播放顺序写镜头动作；[Shot 1] 不写时间戳，后续镜头用严格递增且不超过视频时长的 "
        "[Shot N] At MM:SS.mmm。运镜用中文自然描述运动类型、幅度与速度。画面文字用英文半角双引号原样保留。"
        "用户已提供对白时不得改写、翻译或擅自追加；用户没有提供对白时，可以根据场景创作简短自然的对白，"
        "但必须按自然语速控制全部对白，使其可在视频总时长内完整说完，不得为了填充时长重复台词。"
        "只输出最终提示词，不要解释、分析过程或 Markdown 代码块。"
        "完整保留所有 <Audio N> 标签。每条 Reference voice assignments 都是官方独立参考音频绑定："
        "指定角色或图片在全部对白中使用对应 <Audio N> 的音色身份。音频仅作为音色、声线参考，"
        "不得复制、重播、续写、引用其原始话语、表演时序或波形；不得重编号、删除、交换或转配给其他说话者。"
    )
    if mode == "R2VA":
        return (
            f"任务：R2VA 完整参考生成，时长 {seconds} 秒，参考图片 {picture_count} 张。{shared} "
            "正文使用英文，并严格按以下顺序使用六个英文固定字段：subject_definitions:, summary:, "
            "retention_analysis:, detailed_description:, overall_soundscape:, non_diegetic_music:. "
            "在 subject_definitions 中直接用已有 <Picture N> 定义可复用人物、场景、物体、服装或风格；"
            "不得创建 <Subject N> 别名，不得改动任何 <Picture N> 编号。summary 默认使用 [reference generation]，"
            "除非任务明确需要其他关系。retention_analysis 只使用 fully_preserved、partially_preserved、"
            "attribute_transfer、weak_reference。detailed_description 在素材实际出现处直接引用 <Picture N>。"
            "retention_analysis 必须依据 subject_definitions 中每个资源的真实类型描述：场景只写布局、建筑、地貌、"
            "光影与空间氛围，人物才写身份、面部、发型与服装，物体写外形、材质与结构；严禁给场景套用人物身份或服装描述。"
            "detailed_description 必须在字段内部按 [Shot 1]、[Shot 2] 顺序写分镜；[Shot 1] 不写时间戳，"
            "后续镜头才写 At MM:SS.mmm。每个镜头明确构图、人物位置、连续动作、运镜和同步声音。"
            "必须让用户要求的核心动作在视频时长内真正发生并完成可见过程，不得只写对峙、准备、即将开始或静态姿势。"
            "内容复杂时写约 700 至 1000 个中文字符，优先保证每个镜头的构图、主体、环境、动作、运镜与声音完整。"
        )
    instruction = {
        "I2VA": "The first line must be: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
        "FL2VA": f"首行使用官方首尾帧对齐句，将 Picture 1 对齐 0.00 秒，并将 Picture 2 对齐实际最终镜头的 {seconds} 秒。",
        "L2VA": f"首行使用官方尾帧对齐句，将 <Picture 1> 对齐实际最终镜头的 {seconds} 秒。",
        "T2VA": "不要添加图片对齐说明。",
    }.get(mode, "")
    path_rule = {
        "I2VA": "从首帧锚点连续发展，并保持身份、服装、物体、构图与空间关系一致。",
        "FL2VA": "描述从首帧状态到尾帧状态的连续可观察路径；除非用户明确要求切镜，否则优先使用单镜头。",
        "L2VA": "推断合理的先前状态，并描述连续收敛到参考尾帧的过程。",
        "T2VA": "直接根据用户文本构建完整视听时间线。",
    }.get(mode, "")
    return (
        f"任务：{mode}，时长 {seconds} 秒。{shared} {instruction} {path_rule} "
        "可选对齐说明之后空一行，并严格输出三个英文固定字段："
        "integrated_multimodal_description:, overall_soundscape:, non_diegetic_music:. "
        "overall_soundscape 用英文概括环境声、物理动作声与非语言人声，不重复对白。"
        "non_diegetic_music 用英文描述仅观众可听见的乐器、速度、节奏和动态；无配乐时写 N/A。"
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


def _force_dialogue_language(prompt: str, dialogue_language: str) -> str:
    """统一所有 H3 <d> 标签的语种，不改动对白正文。"""
    language_tag = DIALOGUE_LANGUAGE_TAGS.get(str(dialogue_language), "Chinese")
    return re.sub(
        r"<d>\s*(?:\[[^\]\r\n]+\]\s*)?",
        f"<d>[{language_tag}] ",
        str(prompt or ""),
        flags=re.IGNORECASE,
    )


def _protect_reasoning_dialogue(prompt: str) -> tuple[str, list[tuple[str, str]]]:
    """推理前隐藏对白原文，防止文本模型翻译中文台词、歌词或画面文字。"""
    protected = str(prompt or "")
    values: list[tuple[str, str]] = []

    def reserve(match: re.Match[str]) -> str:
        marker = f"__GJJ_DIALOGUE_{len(values) + 1:04d}__"
        values.append((marker, match.group(0)))
        return marker

    protected = re.sub(
        r"<d>\s*(?:\[[^\]\r\n]+\]\s*)?.*?</d>",
        reserve,
        protected,
        flags=re.IGNORECASE | re.DOTALL,
    )
    protected = re.sub(r"“[^”\r\n]*[\u3400-\u9fff][^”\r\n]*”", reserve, protected)
    protected = re.sub(r'"[^"\r\n]*[\u3400-\u9fff][^"\r\n]*"', reserve, protected)
    return protected, values


def _restore_reasoning_dialogue(prompt: str, protected_values: list[tuple[str, str]]) -> str:
    """推理后恢复保护内容；正文不变，中文弯引号统一转换为英文半角引号。"""
    restored = str(prompt or "")
    missing: list[str] = []
    for marker, original in protected_values:
        normalized_original = str(original).replace("“", '"').replace("”", '"')
        restored, count = re.subn(
            re.escape(marker),
            lambda _match, text=normalized_original: text,
            restored,
            count=1,
            flags=re.IGNORECASE,
        )
        # 推理模型偶尔会把同一占位符复制到 soundscape 等附加字段。
        # 第一处恢复原文，其余重复占位符必须删除，不能泄漏到最终提示词。
        restored = re.sub(re.escape(marker), "", restored, flags=re.IGNORECASE)
        if count == 0:
            missing.append(normalized_original)
    if missing:
        restored = "\n\n".join(filter(None, (
            restored.strip(),
            "受保护的对白或画面文字（必须逐字保留，禁止翻译）："
            + " ".join(missing),
        )))
    return restored


def _collapse_repeated_prose(text: str) -> tuple[str, int]:
    """Collapse exact punctuation-delimited phrase loops emitted by small text models."""
    parts = re.split(r"([，。；;！？!?\r\n]+)", str(text or ""))
    chunks = ["".join(parts[index:index + 2]) for index in range(0, len(parts), 2)]
    normalized = [re.sub(r"\s+", "", chunk).strip() for chunk in chunks]
    output: list[str] = []
    removed = 0
    index = 0
    while index < len(chunks):
        collapsed = False
        max_width = min(32, (len(chunks) - index) // 3)
        for width in range(1, max_width + 1):
            block = normalized[index:index + width]
            if not any(block) or block != normalized[index + width:index + width * 2]:
                continue
            repeats = 2
            while (
                index + width * (repeats + 1) <= len(chunks)
                and block == normalized[index + width * repeats:index + width * (repeats + 1)]
            ):
                repeats += 1
            if repeats < 3:
                continue
            output.extend(chunks[index:index + width])
            removed += width * (repeats - 1)
            index += width * repeats
            collapsed = True
            break
        if not collapsed:
            output.append(chunks[index])
            index += 1
    return "".join(output), removed


def _sanitize_reasoned_prompt(
    prompt: str, mode: str, duration: float, picture_count: int, dialogue_language: str = "中文",
    source_prompt: str = "", video_count: int = 0, audio_count: int = 0,
) -> str:
    """清除小文本模型的退化输出，并补齐 MiniMax H3 的最小官方结构。"""
    cleaned = str(prompt or "").strip()
    # 小模型在长输出末尾可能陷入 `[d]` 或空对白标签循环；这些不是 H3 合法标签。
    cleaned = re.sub(r"(?im)^[ \t]*(?:\[\s*d\s*\]|<d>\s*</d>)[ \t]*(?:\r?\n|$)", "", cleaned)
    cleaned = re.sub(r"(?i)(?<!<)\[\s*d\s*\]", "", cleaned)
    cleaned = re.sub(r"(?is)<d>\s*(?:\[[^\]\r\n]+\]\s*)?</d>", "", cleaned)
    source_text = str(source_prompt or "")
    source_has_dialogue = bool(
        re.search(r"(?is)<d>.*?</d>", source_text)
        or re.search(r"(?:说|说道|问|询问|回答|回复|喊|叫|台词)\s*[：:]", source_text)
    )
    generated_speech_seconds = 0.0

    def keep_valid_dialogue(match: re.Match[str]) -> str:
        nonlocal generated_speech_seconds
        dialogue = re.sub(r"^\s*\[[^\]\r\n]+\]\s*", "", match.group(1)).strip()
        if not dialogue:
            return ""
        if source_has_dialogue:
            return match.group(0) if dialogue in source_text else ""
        # 没有原台词时允许模型创作；按中文约 4 字/秒、外文约 2.5 词/秒估算完整口播时长。
        han_count = len(re.findall(r"[\u3400-\u9fff]", dialogue))
        latin_words = len(re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)?", dialogue))
        estimated_seconds = max(0.6, han_count / 4.0 + latin_words / 2.5)
        if generated_speech_seconds + estimated_seconds > max(0.0, float(duration)) + 1e-6:
            return ""
        generated_speech_seconds += estimated_seconds
        return match.group(0)

    cleaned = re.sub(
        r"(?is)<d>\s*(.*?)\s*</d>",
        keep_valid_dialogue,
        cleaned,
    )
    # 官方格式中第一镜头没有时间戳；后续镜头才使用 At MM:SS.mmm。
    cleaned = re.sub(
        r"(?i)\[Shot\s+1\]\s+At\s+00:00(?:\.0{1,3})?\s*", "[Shot 1] ", cleaned,
    )
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()

    # Reference labels are an inventory owned by the node, not free text for the
    # reasoning model to extend. Remove every hallucinated out-of-range label.
    reference_limits = {
        "Picture": max(0, int(picture_count)),
        "Video": max(0, int(video_count)),
        "Audio": max(0, int(audio_count)),
    }
    for label, limit in reference_limits.items():
        cleaned = re.sub(
            rf"<{label}\s+(\d+)>",
            lambda match, maximum=limit: match.group(0) if int(match.group(1)) <= maximum else "",
            cleaned,
            flags=re.IGNORECASE,
        )

    # A model that repeats the same multi-clause block three or more times has entered a
    # decoding loop. Falling back to the deterministic formatter is safer than feeding a
    # truncated, duplicated subject definition to the video model.
    cleaned, repeated_chunks = _collapse_repeated_prose(cleaned)
    if repeated_chunks and source_text:
        fallback_source, _ = _collapse_repeated_prose(source_text)
        return _officialize_prompt_without_reasoning(
            fallback_source, mode, duration, picture_count, dialogue_language,
        )

    if not cleaned:
        return _officialize_prompt_without_reasoning(
            "", mode, duration, picture_count, dialogue_language,
        )

    if mode == "R2VA":
        required = (
            "subject_definitions:", "summary:", "retention_analysis:",
            "detailed_description:", "overall_soundscape:", "non_diegetic_music:",
        )
        if all(field in cleaned for field in required):
            # non_diegetic_music 是最后一个字段；其后的资源/对白标签属于模型跑满 token 后的退化续写。
            music_start = cleaned.find("non_diegetic_music:")
            music_value_start = music_start + len("non_diegetic_music:")
            music_value = cleaned[music_value_start:]
            tail = re.search(
                r"(?im)^\s*(?:<Subject\s+\d+>|<Picture\s+\d+>|<Video\s+\d+>|<Audio\s+\d+>|<d>)",
                music_value,
            )
            if tail:
                cleaned = (cleaned[:music_value_start] + music_value[:tail.start()]).strip()

            # `[Shot N]` 若被模型续写到最终音乐字段之后，同样属于错位尾部；最终字段后不得再有分镜。
            music_start = cleaned.find("non_diegetic_music:")
            music_value_start = music_start + len("non_diegetic_music:")
            music_value = cleaned[music_value_start:]
            misplaced_shot = re.search(r"(?im)^\s*\[Shot\s+\d+\]", music_value)
            if misplaced_shot:
                cleaned = (cleaned[:music_value_start] + music_value[:misplaced_shot.start()]).strip()

            # detailed_description 必须自身包含镜头标签，不能只有无结构的剧情概述。
            detailed_start = cleaned.find("detailed_description:")
            sound_start = cleaned.find("overall_soundscape:")
            detailed_value_start = detailed_start + len("detailed_description:")
            detailed_value = cleaned[detailed_value_start:sound_start].strip()
            if not re.search(r"\[Shot\s+1\]", detailed_value, flags=re.IGNORECASE):
                cleaned = (
                    cleaned[:detailed_value_start]
                    + f" [Shot 1] {detailed_value}\n\n"
                    + cleaned[sound_start:]
                )

            retention_start = cleaned.find("retention_analysis:")
            detailed_start = cleaned.find("detailed_description:")
            retention_value = cleaned[retention_start + len("retention_analysis:"):detailed_start].strip()
            picture_numbers = sorted({int(value) for value in re.findall(r"<Picture\s+(\d+)>", cleaned)})
            definitions_start = cleaned.find("subject_definitions:") + len("subject_definitions:")
            summary_start = cleaned.find("summary:")
            definitions_value = cleaned[definitions_start:summary_start]

            def retention_detail(number: int) -> str:
                definition_match = re.search(
                    rf"<Picture\s+{number}>\s*(.*?)(?=<Picture\s+\d+>|$)",
                    definitions_value,
                    flags=re.IGNORECASE | re.DOTALL,
                )
                definition = definition_match.group(1) if definition_match else ""
                if re.search(r"场景|背景|环境|雪山|山谷|桥|宫殿|建筑|森林|竹林|街道|房间|室内|天空|海洋|沙漠", definition):
                    return "完整保留场景布局、建筑与地貌结构、光影、色彩及空间氛围。"
                if re.search(r"风格|画风|美术|摄影|色调|质感", definition):
                    return "完整保留视觉风格、色彩体系、光影方式与画面质感。"
                if re.search(r"物体|物品|道具|武器|车辆|产品|设备|剑|刀|书|杯|珠宝", definition):
                    return "完整保留物体外形、材质、结构、色彩与关键细节。"
                return "完整保留人物身份、面部外观、发型、服装、色彩与核心视觉特征。"

            if picture_numbers and not re.search(r"<Picture\s+\d+>", retention_value):
                replacement = "\n".join(
                    f"<Picture {number}>：fully_preserved - {retention_detail(number)}"
                    for number in picture_numbers
                )
                cleaned = (
                    cleaned[:retention_start]
                    + f"retention_analysis: {replacement}\n\n"
                    + cleaned[detailed_start:]
                )
            elif picture_numbers:
                # 修正旧缓存或小模型把场景/物体误套成“人物身份、服装”的通用保留模板。
                for number in picture_numbers:
                    detail = retention_detail(number)
                    cleaned = re.sub(
                        rf"(?im)^((?:retention_analysis:\s*)?<Picture\s+{number}>\s*[：:]\s*fully_preserved\s*[-—―]\s*)"
                        r"完整保留人物身份[^\r\n]*核心视觉特征。?$",
                        lambda match, value=detail: match.group(1) + value,
                        cleaned,
                    )
            return cleaned.strip()

        if not all(field in cleaned for field in required):
            if any(field in cleaned for field in required):
                positions = sorted(
                    (cleaned.find(field), field) for field in required if field in cleaned
                )
                sections: dict[str, str] = {}
                for position_index, (start, field) in enumerate(positions):
                    value_start = start + len(field)
                    value_end = positions[position_index + 1][0] if position_index + 1 < len(positions) else len(cleaned)
                    sections[field] = cleaned[value_start:value_end].strip()
                picture_numbers = sorted({int(value) for value in re.findall(r"<Picture\s+(\d+)>", cleaned)})
                definitions = " ".join(
                    f"<Picture {number}>：对应的可复用视觉参考。" for number in picture_numbers
                ) or "未定义可复用图片主体。"
                retention = " ".join(
                    f"<Picture {number}>：fully_preserved - 完整保留其定义的核心视觉特征。"
                    for number in picture_numbers
                ) or "N/A"
                defaults = {
                    "subject_definitions:": definitions,
                    "summary:": "[reference generation] 按用户要求生成目标视频并保持参考关系。",
                    "retention_analysis:": retention,
                    "detailed_description:": cleaned,
                    "overall_soundscape:": "自然环境声与动作声随画面同步变化，不重复对白。",
                    "non_diegetic_music:": "N/A",
                }
                return "\n\n".join(
                    f"{field} {sections.get(field) or defaults[field]}" for field in required
                )
            return _officialize_prompt_without_reasoning(
                cleaned, mode, duration, picture_count, dialogue_language,
            )
        return cleaned

    body_field = "integrated_multimodal_description:"
    sound_field = "overall_soundscape:"
    music_field = "non_diegetic_music:"
    if body_field not in cleaned:
        cleaned = f"{body_field} {cleaned}"
    if sound_field not in cleaned:
        cleaned += "\n\noverall_soundscape: 自然环境声与动作声随画面同步变化，不重复对白。"
    if music_field not in cleaned:
        cleaned += "\n\nnon_diegetic_music: N/A"
    return cleaned.strip()


def _assemble_fixed_prompt_fields(prompt: str, structure: str) -> str:
    """Rebuild the selected H3 field envelope after all generated prose is complete."""
    source = str(prompt or "").strip()
    reference_fields = (
        "subject_definitions:", "summary:", "retention_analysis:",
        "detailed_description:", "overall_soundscape:", "non_diegetic_music:",
    )
    base_fields = (
        "integrated_multimodal_description:", "overall_soundscape:", "non_diegetic_music:",
    )
    fields = reference_fields if structure == "参考六字段" else base_fields
    positions = sorted(
        (source.find(field), field) for field in fields if source.find(field) >= 0
    )
    values: dict[str, str] = {}
    for index, (start, field) in enumerate(positions):
        value_start = start + len(field)
        value_end = positions[index + 1][0] if index + 1 < len(positions) else len(source)
        value = source[value_start:value_end].strip()
        # A field name nested inside another field is generated structure leakage.
        value = re.sub(
            r"(?im)^\s*(?:subject_definitions|summary|retention_analysis|detailed_description|"
            r"integrated_multimodal_description|overall_soundscape|non_diegetic_music):\s*",
            "", value,
        ).strip()
        values[field] = value
    defaults = {
        "subject_definitions:": "N/A",
        "summary:": "[reference generation] The target video follows the supplied references and user request.",
        "retention_analysis:": "N/A",
        "detailed_description:": "[Shot 1] The requested scene unfolds continuously across the target video.",
        "integrated_multimodal_description:": "[Shot 1] The requested scene unfolds continuously across the target video.",
        "overall_soundscape:": "N/A",
        "non_diegetic_music:": "N/A",
    }
    alignment = ""
    if structure == "基础三字段":
        first_field = source.find("integrated_multimodal_description:")
        if first_field > 0:
            alignment = source[:first_field].strip()
    separator = "\n" if structure == "参考六字段" else " "
    assembled = "\n\n".join(
        f"{field}{separator}{values.get(field) or defaults[field]}" for field in fields
    )
    return f"{alignment}\n\n{assembled}" if alignment else assembled


def _target_shot_count(shot_plan: str) -> int:
    plan = str(shot_plan or "")
    cut_match = re.search(r"(\d+)\s*(?:次切镜|Cuts?)", plan, flags=re.IGNORECASE)
    return 1 if "Single Shot" in plan or "不切镜" in plan else (int(cut_match.group(1)) + 1 if cut_match else 0)


def _short_shot_description(text: str, max_words: int = 45, max_chars: int = 280) -> str:
    cleaned = re.sub(r"\s+", " ", str(text or "")).strip(" ,")
    cleaned = re.sub(r"(?i)^At\s+\d{2}:\d{2}(?:\.\d{1,3})?\s*,?\s*", "", cleaned)
    words = cleaned.split()
    if len(words) > max_words:
        cleaned = " ".join(words[:max_words]).rstrip(" ,;:")
    if len(cleaned) > max_chars:
        shortened = cleaned[:max_chars].rstrip()
        if " " in shortened:
            shortened = shortened.rsplit(" ", 1)[0]
        cleaned = shortened.rstrip(" ,;:")
    if cleaned and cleaned[-1] not in ".!?。！？>\"'":
        cleaned += "."
    return cleaned


def _compose_generated_shots(body: str, target_shots: int, duration: float) -> str:
    """Apply stable shot numbering/timestamps to the model's short continuous descriptions."""
    matches = list(re.finditer(
        r"(?is)\[Shot\s+(\d+)\]\s*(.*?)(?=\[Shot\s+\d+\]|$)",
        str(body or ""),
    ))
    if not matches:
        return str(body or "").strip()
    descriptions = [_short_shot_description(match.group(2)) for match in matches[:target_shots]]
    descriptions = [description for description in descriptions if description]
    if len(descriptions) != target_shots:
        return str(body or "").strip()
    shots = []
    for index, description in enumerate(descriptions, start=1):
        if index == 1:
            shots.append(f"[Shot 1] {description}")
            continue
        seconds = max(0.001, float(duration) * (index - 1) / target_shots)
        minutes = int(seconds // 60)
        remainder = seconds - minutes * 60
        shots.append(f"[Shot {index}] At {minutes:02d}:{remainder:06.3f}, {description}")
    return " ".join(shots)


def _prompt_option_directive(
    visual_style: str, shot_plan: str, camera_motion: str, music_style: str,
) -> str:
    """Translate UI presets into one compact instruction for the prompt writer."""
    selections = []
    for label, value in (
        ("Visual style", visual_style),
        ("Shot plan", shot_plan),
        ("Camera motion", camera_motion),
        ("Background music", music_style),
    ):
        selected = str(value or "自动 / Auto").strip()
        if selected not in {"自动", "自动 / Auto", "不指定 / Unspecified"}:
            selections.append(f"{label}: {selected}")
    if not selections:
        return ""
    target_shots = _target_shot_count(shot_plan)
    shot_requirement = ""
    if target_shots:
        shot_requirement = (
            f" First derive exactly {target_shots} simple, continuous shot descriptions from the user's prompt, one for "
            f"each shot from [Shot 1] through [Shot {target_shots}]. Each description must be 25 to 45 English words, "
            "contain concrete visible subjects and action, and progress naturally from the previous description. "
            "Place those short descriptions in the integrated/detailed description field; the node will normalize "
            "numbering and timestamps afterward. "
            "Do not use generic phrases such as 'complementary angle', 'same subjects continue', or "
            "'selected visual treatment continue', and do not invent Picture/Video/Audio references."
        )
    return (
        "Mandatory target-video presets selected by the user. Apply them naturally in the appropriate "
        "shot and music fields without repeating this instruction verbatim: " + "; ".join(selections) + "."
        + shot_requirement
    )


def _compact_shot_system_prompt(target_shots: int, duration: float, directive: str) -> str:
    return (
        "You are a compact video shot planner. Use the user's prompt as the source of truth. "
        f"Return only exactly {target_shots} lines, labeled [Shot 1] through [Shot {target_shots}], for a "
        f"continuous {max(0.0, float(duration)):.2f}-second video. Each line must contain 25 to 45 English words "
        "describing concrete visible subjects, setting, and action. Each shot must advance naturally from the previous "
        "shot. Do not output analysis, field names, soundscape, music, timestamps, generic continuity placeholders, "
        "or invented Picture/Video/Audio references. Preserve dialogue verbatim if present. "
        + str(directive or "")
    )


def _apply_prompt_option_selections(
    prompt: str, structure: str, duration: float, visual_style: str,
    shot_plan: str, camera_motion: str, music_style: str, source_prompt: str = "",
) -> str:
    """Deterministically enforce UI selections after generated fields are assembled."""
    result = str(prompt or "")
    body_field = "detailed_description:" if structure == "参考六字段" else "integrated_multimodal_description:"
    body_match = re.search(
        rf"(?s)({re.escape(body_field)}\s*)(.*?)(?=\n\s*overall_soundscape:)", result,
    )
    if body_match:
        body = body_match.group(2).strip()
        style_name = str(visual_style or "").split(" / ", 1)[0].strip()
        style_phrases = {
            "Black & White": "Black-and-white cinematography with strictly monochrome imagery and no visible color.",
            "Cinematic": "Cinematic visual treatment.",
            "Live-action": "Live-action visual treatment.",
            "Vintage film": "Vintage-film visual treatment with period-appropriate grain and contrast.",
            "Documentary": "Documentary-style visual treatment.",
            "3D CG": "3D CG visual treatment.",
            "2D-animated": "2D-animated visual treatment.",
            "Anime": "Anime visual treatment.",
        }
        style_phrase = style_phrases.get(style_name, f"{style_name} visual treatment." if style_name and style_name != "自动" else "")

        motion_name = str(camera_motion or "").split(" / ", 1)[0].strip()
        motion_phrases = {
            "Static Shot": "The camera remains completely static.",
            "Push In": "The camera pushes in at a steady speed.",
            "Pull Out": "The camera pulls out at a steady speed.",
            "Pan Left": "The camera pans left at a steady speed.",
            "Pan Right": "The camera pans right at a steady speed.",
            "Truck Left": "The camera trucks left at a steady speed.",
            "Truck Right": "The camera trucks right at a steady speed.",
            "Tilt Up": "The camera tilts up at a steady speed.",
            "Tilt Down": "The camera tilts down at a steady speed.",
            "Pedestal Up": "The camera rises vertically at a steady speed.",
            "Pedestal Down": "The camera descends vertically at a steady speed.",
            "Arc Shot": "The camera moves in a smooth arc around the main subject.",
            "Tracking Shot": "The camera tracks the main subject at a steady speed.",
            "Zoom In": "The camera zooms in at a steady speed.",
            "Zoom Out": "The camera zooms out at a steady speed.",
            "POV": "The shot uses the main subject's point of view.",
            "Shake Slightly": "The camera has a controlled, slight handheld shake.",
        }
        motion_phrase = motion_phrases.get(motion_name, "")
        if motion_phrase:
            body, count = re.subn(
                r"(?i)\[Shot\s+1\]\s*", f"[Shot 1] {motion_phrase} ", body, count=1,
            )
            if count == 0:
                body = f"[Shot 1] {motion_phrase} {body}"

        target_shots = _target_shot_count(shot_plan)
        if target_shots:
            body = _compose_generated_shots(body, target_shots, duration)
        if style_phrase:
            shot_header = r"(?i)(\[Shot\s+\d+\](?:\s+At\s+\d{2}:\d{2}(?:\.\d{1,3})?\s*,)?\s*)"
            if re.search(shot_header, body):
                body = re.sub(
                    shot_header + rf"(?!{re.escape(style_phrase)})",
                    lambda match: f"{match.group(1)}{style_phrase} ",
                    body,
                )
            else:
                body = f"[Shot 1] {style_phrase} {body}"
        result = result[:body_match.start()] + body_match.group(1) + body + result[body_match.end():]

    music_name = str(music_style or "").split(" / ", 1)[0].strip()
    if music_name and music_name not in {"自动", "Auto"}:
        music_descriptions = {
            "无配乐": "N/A", "Piano": "Sparse piano notes at a moderate tempo with a gentle fade at the end.",
            "Orchestral": "A measured orchestral score with strings and restrained brass, building gradually before fading.",
            "Acoustic": "A steady acoustic-guitar pattern at a moderate tempo with a soft final cadence.",
            "Electronic": "A steady electronic pulse with layered synthesizers and a controlled gradual build.",
            "Ambient": "Sustained ambient synthesizer tones with slow movement and minimal percussion.",
            "Jazz": "A moderate jazz rhythm led by piano, upright bass, and restrained brushed drums.",
            "Chinese Folk": "A measured Chinese folk arrangement using plucked strings and bamboo flute.",
            "Guqin": "Sparse guqin phrases at a slow tempo with long pauses and a gentle decay.",
        }
        music_value = music_descriptions.get(
            music_name, f"A {music_name.lower()} score at a moderate tempo with controlled dynamics and a gradual fade.",
        )
        result = re.sub(
            r"(?s)(non_diegetic_music:\s*).*?$", lambda match: match.group(1) + music_value, result,
        )
    return result.strip()


def _officialize_prompt_without_reasoning(
    prompt: str, mode: str, duration: float, picture_count: int, dialogue_language: str = "中文",
) -> str:
    """不加载文本模型时，用确定性规则整理为 MiniMax H3 官方提示词结构。"""
    source, _ = _collapse_repeated_prose(str(prompt or "").strip())
    if not source:
        source = "一个连贯的电影化场景在完整视频时长内自然展开。"
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
            f"{subject_label} (S{speaker_id}) 始终在画面内，脸部与嘴部清晰可见，自然转向倾听者并开口说话，"
            f"嘴唇和下颌与台词精准同步：<d>[{DIALOGUE_LANGUAGE_TAGS.get(str(dialogue_language), 'Chinese')}] {spoken_text}</d> "
            f"{subject_label} (S{speaker_id}) 说完后闭嘴，其他可见角色保持闭嘴并自然反应。"
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
            f"{speaker_name} (S{speaker_id}) 始终在画面内，脸部与嘴部清晰可见并开口说话，嘴唇和下颌与台词精准同步："
            f"<d>[{DIALOGUE_LANGUAGE_TAGS.get(str(dialogue_language), 'Chinese')}] {spoken_text}</d> "
            f"{speaker_name} (S{speaker_id}) 说完后闭嘴，其他可见角色保持闭嘴并自然反应。"
        )
    narrative = named_dialogue_pattern.sub(" ", narrative)
    if mode == "R2VA":
        narrative = re.sub(
            r"场景\s*[：:]\s*<Picture\s+(\d+)>",
            r"场景与环境完整参考 <Picture \1>，并铺满整个画面，不保留白边、白底画布、黑边或参考板边框。",
            narrative,
            flags=re.IGNORECASE,
        )
    narrative = re.sub(r"\s+", " ", narrative).strip(" ,，。;")
    body_parts = [part for part in (narrative, *dialogue_actions) if part]
    body = " ".join(body_parts) or "参考主体在连贯连续的场景中完成用户要求的动作。"
    timeline = (
        body
        if re.search(r"(?i)\[Shot\s+1\]", body)
        else f"[Shot 1] 电影化呈现，在完整 {max(0.0, float(duration)):.2f} 秒视频内保持视听连续。{body}"
    )

    if mode == "R2VA":
        referenced_numbers = sorted({int(number) for number in re.findall(r"<Picture\s+(\d+)>", source)})
        if not referenced_numbers:
            referenced_numbers = list(range(1, max(0, int(picture_count)) + 1))
        definitions = " ".join(
            f"<Picture {number}>：对应的可复用人物、场景、物体、服装或风格视觉参考。"
            for number in referenced_numbers
        ) or "未定义可复用的图片主体。"
        retention = " ".join(
            f"<Picture {number}>：fully_preserved - 完整保留身份、外观、色彩、服装、物体与空间特征。"
            for number in referenced_numbers
        ) or "N/A"
        return (
            f"subject_definitions: {definitions}\n\n"
            "summary: [reference generation] 保留参考主体，并实现用户要求的场景、动作与对白。\n\n"
            f"retention_analysis: {retention}\n\n"
            f"detailed_description: {timeline}\n\n"
            "overall_soundscape: 自然环境底噪、肢体动作声、衣物摩擦声、呼吸声与同步的非语言反应共同配合画面动作，不重复对白。\n\n"
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
        "overall_soundscape: 自然环境声、同步的物理动作声、呼吸声与非语言反应共同配合画面动作，不重复对白。\n\n"
        "non_diegetic_music: N/A"
    )
    return f"{alignment}\n\n{core}" if alignment else core


def _apply_video_replacement_constraints(prompt: str, picture_count: int) -> str:
    """Keep R2V replacement driven by the current video clip instead of reference-sheet layouts."""
    source = str(prompt or "").strip()
    picture_tags = ", ".join(f"<Picture {index}>" for index in range(1, max(0, int(picture_count)) + 1))
    directive = (
        "VIDEO STRUCTURE AND CHARACTER REPLACEMENT LOCK — mandatory: <Video 1> is the current reference video segment "
        "and is the sole "
        "source of shot composition, visible-person count, spatial arrangement, body poses, motion, timing, camera work, "
        "background, and continuity. Replace only the identities and character appearances of people already visible in "
        f"<Video 1> using the configured references in order ({picture_tags or 'no picture references'}). "
        "A picture reference supplies identity, face, hair, costume, and appearance only. Never reproduce a reference "
        "picture's canvas, white background, contact sheet, turnaround sheet, multi-view layout, duplicated figure, pose, "
        "framing, text, border, or still-image composition. Never replace the video shot with a reference picture. Do not "
        "add a referenced person who is absent from <Video 1>, and do not remove or duplicate a person who is present in "
        "<Video 1>. Preserve the complete temporal structure and moving content of <Video 1> throughout the output."
    )
    source = re.sub(
        r"CAST IDENTITY AND COUNT LOCK — mandatory:.*?"
        r"Do not add extra people unless the visual description explicitly requests them\.",
        directive,
        source,
        count=1,
        flags=re.IGNORECASE | re.DOTALL,
    )
    source = source.replace(
        "fully_preserved - preserve identity, appearance, colors, clothing, objects, and spatial traits.",
        "identity_only - preserve identity, face, hair, clothing, and colors; ignore the picture layout, pose, background, and spatial traits.",
    )
    if "VIDEO STRUCTURE AND CHARACTER REPLACEMENT LOCK" not in source:
        source = "\n\n".join((directive, source))
    return source


def _apply_prompt_replacement(*, prompt: str, prompt_replace_find: str, prompt_replace_with: str) -> str:
    """在官方格式化或推理之前，对原始单个分段执行纯文本替换。"""
    result = str(prompt or "").strip()
    find_text = str(prompt_replace_find or "")
    if find_text:
        result = re.sub(re.escape(find_text), lambda _: str(prompt_replace_with or ""), result, flags=re.IGNORECASE)
    return result


def _apply_prompt_constraints(*, prompt: str, global_prompt: str, negative_prompt: str) -> str:
    """在所有改写完成后附加全局与负面约束，避免被推理或官方格式化覆盖。"""
    result = str(prompt or "").strip()
    global_text = str(global_prompt or "").strip()
    negative_text = str(negative_prompt or "").strip()
    parts = [part for part in (global_text, result) if part]
    if negative_text:
        parts.append(f"负面约束（不得出现）：{negative_text}")
    return "\n\n".join(parts)


def _has_upstream_class(
    prompt_graph: Any,
    unique_id: Any,
    input_names: tuple[str, ...],
    target_class: str,
) -> bool:
    """只沿当前节点指定输入的连线向上追踪，判断媒体是否来自目标节点。"""
    if not isinstance(prompt_graph, dict) or unique_id is None:
        return False

    def graph_node(node_id: Any) -> dict[str, Any]:
        value = prompt_graph.get(str(node_id), prompt_graph.get(node_id))
        return value if isinstance(value, dict) else {}

    current = graph_node(unique_id)
    inputs = current.get("inputs")
    if not isinstance(inputs, dict):
        return False
    pending = [inputs.get(name) for name in input_names]
    visited: set[str] = set()
    while pending:
        link = pending.pop()
        if not isinstance(link, (list, tuple)) or len(link) < 2:
            continue
        upstream_id = link[0]
        key = str(upstream_id)
        if key in visited:
            continue
        visited.add(key)
        upstream = graph_node(upstream_id)
        if str(upstream.get("class_type") or "") == target_class:
            return True
        upstream_inputs = upstream.get("inputs")
        if isinstance(upstream_inputs, dict):
            pending.extend(upstream_inputs.values())
    return False


def _apply_mtv_audio_performance(prompt: str) -> str:
    """让 MTV 分段音频作为演唱驱动，而不是普通音色或环境音参考。"""
    result = str(prompt or "").strip()
    result = re.sub(
        r"(?:嘴巴|嘴唇)\s*(?:自然)?\s*(?:保持)?\s*(?:闭合|闭上)",
        "嘴巴随演唱节奏自然开合",
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"overall_soundscape:\s*.*?(?=\n\s*\n|\Z)",
        "overall_soundscape: Isolated synchronized singing from <Audio 1> only; no instrumental music, score, or unrelated ambience.",
        result,
        flags=re.IGNORECASE | re.DOTALL,
    )
    result = re.sub(
        r"\b(?:mouth|lips)\s+(?:remain(?:s|ed)?|stay(?:s|ed)?|keep(?:s|ing)?)?\s*closed\b",
        "mouth and lips move naturally with the singing",
        result,
        flags=re.IGNORECASE,
    )
    directive = (
        "MTV AUDIO PERFORMANCE MODE — mandatory and overrides conflicting closed-mouth or silent-character instructions: "
        "the primary visible referenced character is the singer. Use the current segment's <Audio 1> as the direct isolated-vocal "
        "performance driver. The singer visibly performs throughout the vocal passage; the mouth, lips, jaw, cheeks, "
        "breathing, head, shoulders, upper body, and hands move naturally with the audio. Match every sung syllable, onset, "
        "sustain, pause, rhythm, and emotional accent with precise continuous lip synchronization. Keep the singer's face and "
        "mouth clearly visible whenever vocals are present. Generate the vocal track only: do not add instrumental accompaniment, "
        "background music, score, or unrelated ambience because the original source music will be merged downstream. "
        "Do not treat <Audio 1> as mere ambience or timbre reference."
    )
    return "\n\n".join(part for part in (directive, result) if part)


def _mtv_audio_should_sing(audio: Any) -> bool:
    """优先使用 MTV 上游标记；兼容旧工作流时再以波形能量判断是否为静音。"""
    if not isinstance(audio, dict):
        return False
    if "gjj_mtv_singing_segment" in audio:
        return bool(audio.get("gjj_mtv_singing_segment"))
    waveform = audio.get("waveform")
    if not isinstance(waveform, torch.Tensor) or not waveform.numel():
        return False
    rms = waveform.detach().float().square().mean().sqrt().item()
    return rms > 10.0 ** (-55.0 / 20.0)


def _apply_mtv_silent_performance(prompt: str) -> str:
    """静音或无歌词分段禁止角色开口，保留环境、镜头与非口部表演。"""
    result = str(prompt or "").strip()
    result = re.sub(
        r"overall_soundscape:\s*.*?(?=\n\s*\n|\Z)",
        "overall_soundscape: Absolute digital silence.",
        result,
        flags=re.IGNORECASE | re.DOTALL,
    )
    directive = (
        "MTV SILENT/NO-LYRICS SEGMENT MODE — mandatory and overrides conflicting singing, speaking, dialogue, or lip-sync "
        "instructions: the current vocal input is silent or this segment has no lyrics. Every visible character remains silent "
        "and does not sing or speak. Keep the mouth and lips naturally closed with no syllable articulation and no lip "
        "synchronization. Characters may breathe, blink, change expression, look around, walk, gesture, or move their bodies "
        "naturally. Preserve the requested environment, action, lighting, emotion, and camera work visually only. The generated "
        "audio channel must be absolute digital silence: no voice, breathing sound, ambience, Foley, sound effects, instrumental "
        "music, background music, or score. The original source music will be merged downstream."
    )
    return "\n\n".join(part for part in (directive, result) if part)


def _retime_official_prompt(prompt: str, duration: float) -> str:
    """把已格式化提示词中的官方时长字段同步为当前音频段的真实长度。"""
    seconds = f"{max(0.0, float(duration)):.3f}"
    result = re.sub(
        r"\bfull\s+\d+(?:\.\d+)?-second\s+video\b",
        f"full {seconds}-second video",
        str(prompt or ""),
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"\bthe\s+\d+(?:\.\d+)?-second\s+mark\b",
        f"the {seconds}-second mark",
        result,
        flags=re.IGNORECASE,
    )
    if "MTV AUDIO PERFORMANCE MODE" in result:
        result = re.sub(
            r"(MTV AUDIO PERFORMANCE MODE\s+—)(?:\s*current segment audio duration:\s*"
            r"\d+(?:\.\d+)?\s*seconds,\s*measured from the input audio;\s*)?",
            rf"\1 current segment audio duration: {seconds} seconds, measured from the input audio; ",
            result,
            count=1,
            flags=re.IGNORECASE,
        )
    elif "MTV SILENT/NO-LYRICS SEGMENT MODE" in result:
        result = re.sub(
            r"(MTV SILENT/NO-LYRICS SEGMENT MODE\s+—)(?:\s*current segment audio duration:\s*"
            r"\d+(?:\.\d+)?\s*seconds,\s*measured from the input audio;\s*)?",
            rf"\1 current segment audio duration: {seconds} seconds, measured from the input audio; ",
            result,
            count=1,
            flags=re.IGNORECASE,
        )
    return result


def _register_upload_route() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
        server = PromptServer.instance
        if not server or getattr(server, "_gjj_minimax_h3_upload_registered", False):
            return

        async def upload(request):
            reader = await request.multipart()
            items = []
            while True:
                part = await reader.next()
                if part is None:
                    break
                if not getattr(part, "filename", None):
                    continue
                original = Path(str(part.filename)).name
                suffix = Path(original).suffix.lower()
                content = bytearray()
                while chunk := await part.read_chunk():
                    content.extend(chunk)
                media_type = "text" if suffix in {".txt", ".md", ".prompt"} else ("image" if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"} else ("audio" if suffix in {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"} else "video"))
                info = gjjutils_write_temp_bytes(bytes(content), suffix=suffix or ".bin")
                preview_text = bytes(content).decode("utf-8", errors="replace")[:1200] if media_type == "text" else ""
                items.append({**info, "media_type": media_type, "original_name": original, "preview_text": preview_text})
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
        is_gjj_temp = str(item.get("type") or "").lower() == "temp" and str(item.get("subfolder") or "").replace("\\", "/").strip("/") == GJJ_TEMP_SUBFOLDER
        path = gjjutils_temp_path(str(item.get("filename") or "")) if is_gjj_temp else (input_root / str(item.get("subfolder") or "") / Path(str(item.get("filename") or "")).name).resolve()
        if (not is_gjj_temp and input_root not in path.parents) or not path.is_file():
            continue
        media_type = str(item.get("media_type") or "").lower()
        try:
            if media_type == "text":
                content = gjjutils_read_temp_bytes(item) if is_gjj_temp else path.read_bytes()
                texts.append(content.decode("utf-8", errors="replace"))
            elif media_type == "image":
                import numpy as np
                from PIL import Image, ImageOps
                image = gjjutils_read_temp_pil_image(item).convert("RGB") if is_gjj_temp else ImageOps.exif_transpose(Image.open(path)).convert("RGB")
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


def _synchronize_comfy_cuda_streams(stage: str) -> None:
    """同步默认流及 ComfyUI 动态权重 cast/offload 流，避免异步错误延迟到节点返回后。"""
    try:
        import comfy.model_management as model_management
        streams = set(getattr(model_management, "STREAM_CAST_BUFFERS", {}))
        streams.update(getattr(model_management, "STREAM_AIMDO_CAST_BUFFERS", {}))
        for stream in streams:
            if stream is not None:
                stream.synchronize()
        model_management.synchronize()
    except Exception as exc:
        if "illegal memory access" not in str(exc).casefold():
            raise
        raise RuntimeError(
            f"MiniMax H3 在{stage}检测到 ComfyUI 动态权重流 CUDA 非法访存。"
            "发生后必须重启 ComfyUI，当前 CUDA 进程不能安全续跑。"
        ) from exc


def _safe_minimax_sage_settings(enabled: bool, mode: str) -> tuple[bool, str]:
    """Blackwell 禁用会触发非法访存的 SageAttention 2 Triton/CUDA 内核。"""
    requested = bool(enabled)
    selected_mode = str(mode or "自动")
    if not requested or not torch.cuda.is_available():
        return requested, selected_mode
    try:
        major, _minor = torch.cuda.get_device_capability()
    except Exception:
        return requested, selected_mode
    if int(major) >= 10 and "sageattn3" not in selected_mode.casefold():
        print(
            "[GJJ_MiniMaxH3Studio] 检测到 Blackwell GPU：已禁用不兼容的 SageAttention 2 "
            f"模式“{selected_mode}”，回退 ComfyUI 原生注意力。需要 Sage 加速时请明确选择 sageattn3。",
            flush=True,
        )
        return False, selected_mode
    return requested, selected_mode


def _release_vram_before_sampling() -> None:
    # cudaMallocAsync 下先等推理模型的动态权重流完成，再清缓存和卸载，避免仍在使用的
    # cast buffer 被提前回收，最终延迟到 reset_cast_buffers 才报告非法访存。
    _synchronize_comfy_cuda_streams("卸载提示词推理模型之前")
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
    _synchronize_comfy_cuda_streams("卸载提示词推理模型之后")


def _audio_to_cpu(value: Any) -> Any:
    if not _is_audio(value):
        return value
    return {
        **value,
        "waveform": value["waveform"].detach().to(device="cpu").contiguous(),
    }


def _slice_director_video(
    value: tuple[Any, Any, Any],
    scene: dict[str, Any],
    timeline_fps: float,
) -> tuple[Any, Any, Any]:
    """Cut one reference video/audio tuple to the director scene's inclusive frame range."""
    frames, audio, source_fps = value
    if not isinstance(frames, torch.Tensor) or frames.ndim < 4 or int(frames.shape[0]) < 1:
        return value
    safe_timeline_fps = max(1e-6, float(timeline_fps))
    safe_source_fps = max(1e-6, float(source_fps or timeline_fps))
    start_frame = max(1, int(scene.get("start_frame") or 1))
    end_frame = max(start_frame, int(scene.get("end_frame") or start_frame))
    start_seconds = (start_frame - 1) / safe_timeline_fps
    end_seconds = end_frame / safe_timeline_fps
    frame_count = int(frames.shape[0])
    start_index = max(0, min(frame_count - 1, round(start_seconds * safe_source_fps)))
    end_index = max(start_index + 1, min(frame_count, round(end_seconds * safe_source_fps)))
    sliced_audio = audio
    if _is_audio(audio):
        sample_rate = max(1, int(audio.get("sample_rate") or 44100))
        waveform = audio["waveform"]
        sample_count = int(waveform.shape[-1])
        start_sample = max(0, min(sample_count, round(start_seconds * sample_rate)))
        end_sample = max(start_sample, min(sample_count, round(end_seconds * sample_rate)))
        sliced_audio = {
            **audio,
            "waveform": waveform[..., start_sample:end_sample].contiguous(),
        }
    return frames[start_index:end_index].contiguous(), sliced_audio, source_fps


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
    kind: str,
    names: list[str],
    reference_width: int | None = None,
    reference_height: int | None = None,
    *,
    make_actor_board: bool = True,
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
            temp_info = gjjutils_write_temp_file(path)
            image = gjjutils_read_temp_pil_image(temp_info).convert("RGB")
            if kind == "actor" and make_actor_board:
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
    normalized = re.sub(r"<Subject\s+(\d+)>", r"<Picture \1>", str(prompt or ""), flags=re.IGNORECASE)
    return re.sub(r"@\s*图片\s*(\d+)", lambda match: f"<Picture {int(match.group(1))}>", normalized, flags=re.IGNORECASE)


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


def _reasoning_visual_signature(images: list[Any]) -> str:
    """Build a lightweight, stable signature without copying full reference tensors."""
    digest = hashlib.sha256()
    for image in images:
        if not isinstance(image, torch.Tensor):
            digest.update(f"{type(image).__module__}.{type(image).__qualname__}".encode("utf-8"))
            continue
        tensor = image.detach()
        digest.update(f"{tuple(tensor.shape)}|{tensor.dtype}|".encode("utf-8"))
        flat = tensor.reshape(-1)
        if not flat.numel():
            continue
        sample_count = min(1024, flat.numel())
        if sample_count == 1:
            indices = torch.zeros((1,), device=flat.device, dtype=torch.int64)
        else:
            # 禁止使用浮点 linspace：超大视频张量的末端位置会因 float32
            # 精度舍入成 numel，进而导致 index_select 越界。
            indices = (
                torch.arange(sample_count, device=flat.device, dtype=torch.int64)
                * (flat.numel() - 1)
                // (sample_count - 1)
            )
        sample = flat.index_select(0, indices).to(device="cpu", dtype=torch.float32).contiguous()
        digest.update(sample.numpy().tobytes())
    return digest.hexdigest()


def _reference_resource_batch(images: list[Any]) -> list[torch.Tensor]:
    """Return each actually used picture as an independent one-frame reference resource."""
    import numpy as np

    unique_images: list[torch.Tensor] = []
    seen: set[str] = set()
    for image in images:
        signature = _reasoning_visual_signature([image])
        if signature in seen:
            continue
        seen.add(signature)
        infos = gjjutils_write_temp_tensor_images(image, format="PNG", suffix=".png", media_type="image")
        for info in infos:
            pil_image = gjjutils_read_temp_pil_image(info).convert("RGB")
            tensor = torch.from_numpy(np.asarray(pil_image).astype("float32") / 255.0).unsqueeze(0)
            unique_images.append(tensor)
    return [image.contiguous().cpu() for image in unique_images]


class GJJ_MiniMaxH3Studio:
    CATEGORY = "GJJ/💗 一键生成"
    FUNCTION = "generate"
    INPUT_IS_LIST = True
    OUTPUT_NODE = True
    RETURN_TYPES = ("VIDEO", "GJJ_BATCH_IMAGE,IMAGE")
    RETURN_NAMES = ("生成视频", "引用资源")
    OUTPUT_IS_LIST = (False, True)
    OUTPUT_TOOLTIPS = (
        "最终生成并保存的视频。",
        "本次实际使用的外部输入、角色库、场景库及导演台原图；保持原始分辨率，按首次使用顺序去重并以独立单帧资源传给下游。",
    )
    DESCRIPTION = "MiniMax H3 单节点工作室：按图片数量显示参考、首帧、尾帧、首尾帧或分段首尾帧分支；多图分段会按相邻图片生成并去重边界首帧。"
    SEARCH_ALIASES = ["MiniMax H3 Studio", "海螺单节点", "T2V I2V Ref2V"]
    GJJ_UI = {"style_reference": "GJJ_BerniniStudio", "model_keyword": "minimax_h3"}
    _MODEL_CACHE: dict[tuple[str, ...], tuple[Any, Any, Any, Any]] = {}
    _REASONING_CACHE: dict[str, tuple[str, tuple[str, ...]]] = {}
    _CLIP_CONDITIONING_CACHE: dict[str, tuple[str, Any, Any]] = {}

    @classmethod
    def INPUT_TYPES(cls):
        fl_models, fl_default = _choices("diffusion_models", DEFAULT_FL_MODEL, (DEFAULT_FL_MODEL_KEYWORD,))
        ref_models, ref_default = _choices("diffusion_models", DEFAULT_REF_MODEL, (DEFAULT_REF_MODEL_KEYWORD,))
        clips, clip_default = _choices("text_encoders", DEFAULT_CLIP, ("qwen3vl", "32b"))
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
        default_lora_data = _default_accel_lora_data()
        if "euler" not in samplers:
            samplers.insert(0, "euler")
        if "beta" not in schedulers:
            schedulers.insert(0, "beta")
        return {
            "required": {},
            "optional": {
                "reference_media": (MEDIA_TYPE, {"display_name": "参考媒体", "tooltip": "递归解包图片、VIDEO、音频、list/tuple/dict。未连接=T2V；单图=I2V；其它=参考生视频。"}),
                "prompt": ("STRING", {"default": "", "multiline": True, "display_name": "正向提示词"}),
                "width": ("INT", {"default": 864, "min": 352, "max": 1920, "step": 32, "display_name": "宽度"}),
                "height": ("INT", {"default": 480, "min": 352, "max": 1920, "step": 32, "display_name": "高度"}),
                "duration": ("FLOAT", {"default": 5.0, "min": 0.2, "max": 60.0, "step": 0.1, "display_name": "时长(秒)"}),
                "frame_rate": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 1.0, "display_name": "帧率"}),
                "steps": ("INT", {"default": DEFAULT_ACCEL_STEPS, "min": 1, "max": 100, "step": 1, "display_name": "步数"}),
                "seed": ("INT", {"default": 42, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "display_name": "种子"}),
                "randomize_seed": ("BOOLEAN", {"default": True, "display_name": "随机种子"}),
                "sampler_name": (samplers, {"default": "euler", "display_name": "采样器"}),
                "scheduler": (schedulers, {"default": "beta", "display_name": "调度器"}),
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
                "size_mode": (["宽高", "等比", "长边", "像素", "百万像素"], {"default": "宽高", "display_name": "尺寸模式"}),
                "resize_fit_mode": (["拉伸", "补边", "留边", "裁剪"], {"default": "裁剪", "display_name": "适配方式"}),
                "resize_anchor": (["上", "下", "左", "右", "中"], {"default": "上", "display_name": "保留位置"}),
                "reference_media_2": (MEDIA_TYPE, {"display_name": "参考媒体 2", "tooltip": "第二个递归媒体入口；外部链接优先于📁内部媒体。"}),
                "internal_media_json": ("STRING", {"default": "[]", "display_name": "内部媒体记录"}),
                "image_branch": (["参考", "首帧", "尾帧", "首尾帧", "分段首尾帧"], {"default": "参考", "display_name": "图片分支", "tooltip": "由提示词下方的互斥按钮控制；实际可用选项随输入图片数量变化。"}),
                "reasoning_enabled": ("BOOLEAN", {"default": False, "display_name": "启用推理", "tooltip": "开启后使用 GJJ_GemmaTextGenerate 在生成视频前优化提示词；关闭时不会加载推理模型。"}),
                "reasoning_model": (reasoning_models, {"default": reasoning_default, "display_name": "推理模型", "gjj_default_model": reasoning_default, "gjj_model_folder": "text_encoders", "gjj_model_icon": "🟡", "gjj_model_keywords": [DEFAULT_REASONING_KEYWORD]}),
                "reasoning_system_prompt": ("STRING", {"default": DEFAULT_REASONING_SYSTEM_PROMPT, "multiline": True, "display_name": "推理系统提示词"}),
                "reference_media_3": (MEDIA_TYPE, {"display_name": "参考媒体 3", "tooltip": "旧工作流兼容入口；新界面不再显示。"}),
                "selected_actors_json": ("STRING", {"default": "[]", "display_name": "已选角色"}),
                "selected_scenes_json": ("STRING", {"default": "[]", "display_name": "已选场景"}),
                "global_prompt": ("STRING", {"default": "", "multiline": True, "display_name": "全局提示词"}),
                "negative_prompt": ("STRING", {"default": "", "multiline": True, "display_name": "负面提示词"}),
                "prompt_replace_find": ("STRING", {"default": "", "multiline": True, "display_name": "查找提示词"}),
                "prompt_replace_with": ("STRING", {"default": "", "multiline": True, "display_name": "替换为"}),
                "patch_enable_sage_attention": ("BOOLEAN", {"default": True, "display_name": "启用SageAttention", "tooltip": "Blackwell 显卡会自动禁用不兼容的 SageAttention 2 自动/int8/fp8 模式；明确选择 sageattn3 时才启用。"}),
                "patch_sage_attention_mode": (SAGE_ATTENTION_MODES, {"default": "自动", "display_name": "SageAttention模式"}),
                "patch_allow_sage_compile": ("BOOLEAN", {"default": False, "display_name": "允许Sage编译", "tooltip": "MiniMax H3 固定使用稳定的非编译 Sage 调用边界；保留此项仅兼容旧工作流。"}),
                "patch_enable_fp16_accumulation": ("BOOLEAN", {"default": True, "display_name": "启用FP16累积设置"}),
                "patch_fp16_accumulation": ("BOOLEAN", {"default": True, "display_name": "FP16累积"}),
                "patch_enable_ltxv_feedforward_chunk": ("BOOLEAN", {"default": False, "display_name": "启用LTXV前馈分块"}),
                "patch_feedforward_chunks": ("INT", {"default": 4, "min": 1, "max": 100, "step": 1, "display_name": "分块数量"}),
                "patch_feedforward_threshold": ("INT", {"default": 4096, "min": 0, "max": 16384, "step": 256, "display_name": "分块阈值"}),
                "patch_missing_sage_handling": (MISSING_SAGE_HANDLING_MODES, {"default": "自动跳过SageAttention继续运行", "display_name": "缺SageAttention处理"}),
                "spectrum_enabled": ("BOOLEAN", {"default": True, "display_name": "启用 Spectrum", "tooltip": "启用后在采样前应用 GJJ_SpectrumApplyMiniMaxH3 频谱预测加速。"}),
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
                "dialogue_language": (list(DIALOGUE_LANGUAGE_TAGS), {"default": "中文", "display_name": "对白语言", "tooltip": "强制每一句对白使用所选 H3 语种标签，例如 <d>[Chinese] ...</d>。"}),
                "megapixel_aspect": (["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"], {"default": "16:9", "display_name": "百万像素比例"}),
                "megapixels": ("FLOAT", {"default": 0.4, "min": 0.2, "max": 2.0, "step": 0.1, "display_name": "百万像素"}),
                "lora_data": ("STRING", {"default": default_lora_data, "display_name": "LoRA 配置", "tooltip": "🧠 模型面板中的 LoRA 区自动维护；默认启用 MiniMax H3 Turbo 4-step LoRA，并按界面顺序串联应用。"}),
                "cache_clip": ("BOOLEAN", {"default": False, "display_name": "缓存CLIP", "tooltip": "最终提示词及参考条件未变化时复用上次 CLIP conditioning，跳过重复编码。"}),
                "director_storyboard_json": ("STRING", {"default": "{}", "display_name": "导演分镜", "tooltip": "🎞️导演台保存的逐段帧范围和提示词。"}),
                "use_video_size": ("BOOLEAN", {"default": False, "display_name": "视频尺寸", "tooltip": "使用递归解码后第一个视频的尺寸；没有视频时回退到画板尺寸。"}),
                **{
                    f"reference_media_2_{index}": (
                        MEDIA_TYPE,
                        {"default": None, "display_name": f"参考媒体 2 · {index}"},
                    )
                    for index in range(1, MAX_REFERENCE_MEDIA_2 + 1)
                },
                "external_prompt": ("STRING", {"forceInput": True, "display_name": "外部提示词", "tooltip": "连接后覆盖面板文本框内容，并在富文本框中实时预览。"}),
                "prompt_structure": (["自动", "基础三字段", "参考六字段"], {"default": "自动", "display_name": "提示词结构", "tooltip": "最终由节点固定拼接官方字段；自动按媒体分支选择，或强制使用基础三字段/参考六字段。"}),
                "visual_style": (["自动 / Auto", "Cinematic / 电影感", "Live-action / 实拍", "Vintage film / 复古胶片", "Black & White / 黑白电影", "Documentary / 纪录片", "Minimalist commercial / 极简广告", "Macro photography / 微距摄影", "Aerial drone / 航拍", "2D-animated / 二维动画", "3D CG / 三维CG", "Anime / 日系二次元", "American Comic / 美式漫画", "Pixar-style 3D / 皮克斯3D", "Stop-motion / 定格动画", "Cyberpunk / 赛博朋克", "Watercolor / 水彩", "Claymation / 粘土动画", "Ink wash / 水墨", "Oil painting / 油画", "Paper cutout / 剪纸", "Pencil sketch / 铅笔素描"], {"default": "自动 / Auto", "display_name": "整个视频"}),
                "shot_plan": (["自动 / Auto", "不切镜 / Single Shot", "1 次切镜 / 1 Cut", "2 次切镜 / 2 Cuts", "3 次切镜 / 3 Cuts", "4 次切镜 / 4 Cuts", "5 次切镜 / 5 Cuts", "6 次切镜 / 6 Cuts", "7 次切镜 / 7 Cuts", "8 次切镜 / 8 Cuts", "9 次切镜 / 9 Cuts"], {"default": "自动 / Auto", "display_name": "分镜"}),
                "camera_motion": (["自动 / Auto", "Static Shot / 静止镜头", "Push In / 前推", "Pull Out / 后拉", "Pan Left / 向左摇摄", "Pan Right / 向右摇摄", "Truck Left / 向左横移", "Truck Right / 向右横移", "Tilt Up / 上摇", "Tilt Down / 下摇", "Pedestal Up / 上升", "Pedestal Down / 下降", "Arc Shot / 环绕", "Tracking Shot / 跟拍", "Zoom In / 变焦推近", "Zoom Out / 变焦拉远", "POV / 主观视角", "Shake Slightly / 轻微手持晃动"], {"default": "自动 / Auto", "display_name": "运镜"}),
                "music_style": (["自动 / Auto", "无配乐 / N/A", "Piano / 钢琴", "Orchestral / 管弦乐", "Acoustic / 原声吉他", "Electronic / 电子", "Ambient / 氛围", "Synthwave / 合成器浪潮", "Chiptune / 芯片音乐", "Lo-fi / Lo-fi", "Epic / 史诗", "Suspense / 悬疑", "Romantic Strings / 浪漫弦乐", "Rock / 摇滚", "Jazz / 爵士", "Hip-Hop / 嘻哈", "Funk / 放克", "Acapella Choir / 纯人声合唱", "Minimalist Foley / 极简拟音", "Chinese Folk / 国风民乐", "Chinese Opera / 戏曲", "Guqin / 古琴"], {"default": "自动 / Auto", "display_name": "音乐"}),
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

        ref_image_size = str(first("ref_image_size", "match") or "match")
        if ref_image_size not in {"match", "max"}:
            ref_image_size = "match"

        director_scenes: list[dict[str, Any]] = []
        try:
            director_plan = json.loads(str(first("director_storyboard_json", "{}") or "{}"))
            if isinstance(director_plan, dict) and director_plan.get("configured") and director_plan.get("enabled") and isinstance(director_plan.get("scenes"), list):
                director_scenes = [scene for scene in director_plan["scenes"] if isinstance(scene, dict)]
        except (TypeError, ValueError, json.JSONDecodeError):
            director_scenes = []
        director_scene_media: list[tuple[dict[str, list[Any]], list[str]]] = [
            _load_internal_media(json.dumps(scene.get("media") or [], ensure_ascii=False))
            for scene in director_scenes
        ]
        has_director_media = any(any(scene_media.values()) or scene_texts for scene_media, scene_texts in director_scene_media)

        media = _collect_media(kwargs.get("reference_media"))
        _merge_media(media, _collect_media(kwargs.get("reference_media_2")))
        _merge_media(media, _collect_media(kwargs.get("reference_media_3")))
        for ref_index in range(1, MAX_REFERENCE_MEDIA_2 + 1):
            _merge_media(media, _collect_media(kwargs.get(f"reference_media_2_{ref_index}")))
        internal_texts: list[str] = []
        if not any(media.values()):
            internal_media, internal_texts = _load_internal_media(first("internal_media_json", "[]"))
            _merge_media(media, internal_media)
            if has_director_media:
                media["images"] = []
                internal_texts = []
        external_prompt = first("external_prompt", "") if "external_prompt" in kwargs else ""
        prompt_source = external_prompt if str(external_prompt or "").strip() else first("prompt", "")
        prompt = _normalize_picture_reference_tags(_strip_library_manifest_payloads("\n\n".join(
            part for part in [str(prompt_source or "").strip(), *[text.strip() for text in internal_texts]] if part
        )))
        panel_prompt_is_segmented = "---" in prompt
        panel_prompt_parts = [part.strip() for part in prompt.split("---") if part.strip()] or [prompt]
        raw_prompt_parts = list(panel_prompt_parts)
        if director_scenes:
            raw_prompt_parts = []
            for scene_index, scene in enumerate(director_scenes):
                panel_fallback = (
                    panel_prompt_parts[min(scene_index, len(panel_prompt_parts) - 1)]
                    if panel_prompt_is_segmented
                    else prompt
                )
                actor_markers = [
                    f"@{str(item.get('name') or item.get('id') or '').strip()}"
                    for item in (scene.get("actors") or [])
                    if isinstance(item, dict) and str(item.get("name") or item.get("id") or "").strip()
                ]
                scene_markers = [
                    f"🏕️{str(item.get('name') or item.get('id') or '').strip()}"
                    for item in (scene.get("scenes") or [])
                    if isinstance(item, dict) and str(item.get("name") or item.get("id") or "").strip()
                ]
                scene_texts = director_scene_media[scene_index][1] if scene_index < len(director_scene_media) else []
                raw_prompt_parts.append("\n".join([
                    *actor_markers,
                    *scene_markers,
                    str(scene.get("prompt") or "").strip() or panel_fallback,
                    *[text.strip() for text in scene_texts if text.strip()],
                ]).strip())
            prompt = "\n---\n".join(raw_prompt_parts)
        prompt_actors = _prompt_library_references(prompt, "@")
        bare_prompt_actors = _prompt_library_references(prompt, "@", require_marker=False)
        prompt_scenes = _prompt_library_references(prompt, "🏕️")
        configured_actors = _library_selection_names(first("selected_actors_json", "[]"))
        actor_candidates = list(dict.fromkeys([*prompt_actors, *bare_prompt_actors, *configured_actors]))
        # 提示词中出现某类资料库引用时，以提示词解析结果替换节点内该类选择。
        selected_actors = list(dict.fromkeys([*prompt_actors, *bare_prompt_actors])) or configured_actors
        selected_scenes = prompt_scenes or _library_selection_names(first("selected_scenes_json", "[]"))
        unique_id = first("unique_id")
        mtv_audio_queue = _has_upstream_class(
            first("prompt_info"),
            unique_id,
            (
                "reference_media",
                "reference_media_2",
                "reference_media_3",
                *(f"reference_media_2_{index}" for index in range(1, MAX_REFERENCE_MEDIA_2 + 1)),
            ),
            "GJJ_MTVAudioToPrompt",
        )
        _send_status(unique_id, "已解析上游角色与场景引用", 0.0, {
            "parsed_actors": selected_actors,
            "parsed_scenes": selected_scenes,
        })
        external_images = list(media["images"])
        external_image_count = len(external_images)
        panel_width, panel_height = int(first("width", 864)), int(first("height", 480))
        if str(first("size_mode", "宽高")) == "百万像素":
            aspect_text = str(first("megapixel_aspect", "16:9"))
            try:
                aspect_width, aspect_height = (max(1.0, float(part)) for part in aspect_text.split(":", 1))
            except (TypeError, ValueError):
                aspect_width, aspect_height = 16.0, 9.0
            total_pixels = max(0.2, min(2.0, float(first("megapixels", 0.4)))) * 1024.0 * 1024.0
            panel_width = max(32, round((total_pixels * aspect_width / aspect_height) ** 0.5 / 32.0) * 32)
            panel_height = max(32, round((total_pixels * aspect_height / aspect_width) ** 0.5 / 32.0) * 32)
        actor_reference_width, actor_reference_height = panel_width, panel_height
        if ref_image_size == "max":
            scale = 2048.0 / max(1, panel_width, panel_height)
            actor_reference_width = max(64, round(panel_width * scale / 32.0) * 32)
            actor_reference_height = max(64, round(panel_height * scale / 32.0) * 32)
        pooled_assets = {
            "scene": _library_reference_assets("scene", selected_scenes, panel_width, panel_height),
            "actor": _library_reference_assets(
                "actor", actor_candidates, actor_reference_width, actor_reference_height,
            ),
        }
        original_pooled_assets = {
            "scene": _library_reference_assets("scene", selected_scenes, make_actor_board=False),
            "actor": _library_reference_assets("actor", actor_candidates, make_actor_board=False),
        }
        original_asset_by_key = {
            kind: {name.casefold(): image for image, name, _notes in assets}
            for kind, assets in original_pooled_assets.items()
        }

        def part_library_assets(kind: str, names: list[str]) -> list[tuple[str, torch.Tensor, str, str]]:
            available = {name.casefold(): (image, name, notes) for image, name, notes in pooled_assets[kind]}
            return [(kind, *available[name.casefold()]) for name in names if name.casefold() in available]

        segmented_library_media: list[tuple[str, dict[str, list[Any]], list[tuple[str, torch.Tensor, str, str]]]] = []
        for segment_index, raw_part in enumerate(raw_prompt_parts):
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
            # 富文本框中的 @图片N 始终先按外部连接图片编号；资料库图片从其后继续编号，
            # 避免 @图片1 与 @角色名同时出现时都错误指向资料库角色图。
            for picture_number, (kind, image, name, _notes) in enumerate(part_assets, start=external_image_count + 1):
                part_images.append(image)
                part_references.append((kind, name, picture_number))
                if kind == "scene":
                    scene_lines.append(f"场景：<Picture {picture_number}>")
            director_images = (
                list(director_scene_media[min(segment_index, len(director_scene_media) - 1)][0]["images"])
                if director_scene_media else []
            )
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
                "images": list(external_images) + part_images + director_images,
                "videos": list(media["videos"]), "audios": list(media["audios"]),
                "voice_audios": voice_audios,
            }, part_assets))
        library_assets = list(dict.fromkeys(
            (asset[0], asset[2].casefold()) for _part, _part_media, assets in segmented_library_media for asset in assets
        ))
        reference_source_images = list(external_images)
        for segment_index, (_part, _part_media, assets) in enumerate(segmented_library_media):
            for kind, _prepared_image, name, _notes in assets:
                original_image = original_asset_by_key.get(kind, {}).get(name.casefold())
                if original_image is not None:
                    reference_source_images.append(original_image)
            if director_scene_media:
                reference_source_images.extend(
                    director_scene_media[min(segment_index, len(director_scene_media) - 1)][0]["images"]
                )
        has_library_voices = any(segment_media.get("voice_audios") for _part, segment_media, _assets in segmented_library_media)
        media["images"] = list(segmented_library_media[0][1]["images"]) if segmented_library_media else external_images
        use_video_size = bool(first("use_video_size", False))
        use_source_size = bool(first("use_source_size", True)) and not use_video_size
        source = (
            media["videos"][0][0]
            if use_video_size and media["videos"]
            else (media["images"][0] if use_source_size and media["images"] else None)
        )
        width, height = _target_dimensions(
            panel_width, panel_height, _visual_size(source), use_video_size or use_source_size, str(first("size_mode", "宽高")),
        )
        fit_mode = str(first("resize_fit_mode", "裁剪"))
        resize_anchor = str(first("resize_anchor", "上"))
        preserve_reference_resolution = ref_image_size == "max" and (
            bool(library_assets) or str(first("image_branch", "参考") or "参考") == "参考"
        )
        for segment_index, (_segment_prompt, segment_media, assets) in enumerate(segmented_library_media):
            segment_media["images"] = [
                image if preserve_reference_resolution else
                _resize_visual(
                    image, width, height,
                    ("裁剪" if assets[index - external_image_count][0] == "scene" else "适应")
                    if external_image_count <= index < external_image_count + len(assets) else fit_mode,
                    resize_anchor,
                )
                for index, image in enumerate(segment_media["images"])
            ]
            prepared_videos: list[tuple[Any, Any, Any]] = []
            for video in segment_media["videos"]:
                if director_scenes:
                    scene = director_scenes[min(segment_index, len(director_scenes) - 1)]
                    video = _slice_director_video(video, scene, float(first("frame_rate", 24.0)))
                frames, audio, source_fps = video
                prepared_videos.append((
                    _resize_visual(frames, width, height, fit_mode, resize_anchor),
                    audio,
                    source_fps,
                ))
            segment_media["videos"] = prepared_videos
        if not segmented_library_media:
            _align_media(media, width, height, fit_mode, resize_anchor)
        reference_resources = _reference_resource_batch(reference_source_images)
        debug_assets = [
            (kind, image, name, notes)
            for kind in ("scene", "actor") for image, name, notes in pooled_assets[kind]
        ]
        _save_library_reference_debug_images(
            [asset[1] for asset in debug_assets], debug_assets, unique_id,
        )
        fps = float(first("frame_rate", 24.0))
        duration = float(first("duration", 5.0))
        director_segment_durations = [
            max(1, int(scene.get("end_frame") or 1) - int(scene.get("start_frame") or 1) + 1) / max(1e-6, fps)
            for scene in director_scenes
        ]
        configured_seed = int(first("seed", 42))
        randomize_seed = bool(first("randomize_seed", True))
        seed = configured_seed
        if randomize_seed:
            seed = int(torch.randint(0, 0x7FFFFFFF, (1,)).item())
        prompt_parts = [item[0] for item in segmented_library_media]
        prompt_parts = [
            _attach_official_voice_references(
                _strip_library_manifest_payloads(_apply_prompt_replacement(
                        prompt=raw_part,
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

        requested_prompt_structure = str(first("prompt_structure", "自动") or "自动")
        if requested_prompt_structure == "参考六字段":
            official_prompt_mode = "R2VA"
        elif requested_prompt_structure == "基础三字段" and official_prompt_mode == "R2VA":
            official_prompt_mode = "T2VA"
        final_prompt_structure = (
            requested_prompt_structure
            if requested_prompt_structure in {"基础三字段", "参考六字段"}
            else ("参考六字段" if official_prompt_mode == "R2VA" else "基础三字段")
        )
        prompt_option_directive = _prompt_option_directive(
            str(first("visual_style", "自动 / Auto")),
            str(first("shot_plan", "自动 / Auto")),
            str(first("camera_motion", "自动 / Auto")),
            str(first("music_style", "自动 / Auto")),
        )

        if bool(first("reasoning_enabled", False)):
            from .gjj_gemma_text_generate import GJJ_GemmaTextGenerate

            reasoning_model_name = str(first("reasoning_model", DEFAULT_REASONING_KEYWORD))
            configured_system_prompt = str(first("reasoning_system_prompt", DEFAULT_REASONING_SYSTEM_PROMPT) or "").strip()
            requested_shots = _target_shot_count(str(first("shot_plan", "自动 / Auto")))
            reasoning_system_prompt = (
                _compact_shot_system_prompt(requested_shots, duration, prompt_option_directive)
                if requested_shots
                else "\n\n".join(filter(None, (
                    configured_system_prompt or DEFAULT_REASONING_SYSTEM_PROMPT,
                    _official_prompt_rewrite_rules(
                        mode=official_prompt_mode,
                        duration=duration,
                        picture_count=image_count,
                        dialogue_language=str(first("dialogue_language", "中文")),
                    ),
                    prompt_option_directive,
                )))
            )
            reasoning_cache_payload = {
                "prompt_parts": prompt_parts,
                "configured_seed": configured_seed,
                "randomize_seed": randomize_seed,
                "reasoning_model": reasoning_model_name,
                "reasoning_system_prompt": reasoning_system_prompt,
                "official_prompt_mode": official_prompt_mode,
                "duration": duration,
                "dialogue_language": str(first("dialogue_language", "中文")),
                "reference_images": [
                    _reasoning_visual_signature(segment_media["images"])
                    for _part, segment_media, _assets in segmented_library_media
                ],
            }
            reasoning_signature = hashlib.sha256(json.dumps(
                reasoning_cache_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            ).encode("utf-8")).hexdigest()
            reasoning_cache_slot = str(unique_id) if unique_id is not None else ""
            cached_reasoning = self._REASONING_CACHE.get(reasoning_cache_slot) if reasoning_cache_slot else None
            if cached_reasoning and cached_reasoning[0] == reasoning_signature:
                prompt_parts = list(cached_reasoning[1])
                _send_status(unique_id, "提示词与🎲未变化，已复用上次推理结果", 0.01)
                print("[GJJ_MiniMaxH3Studio] 提示词与🎲未变化，复用上次🧠推理结果。", flush=True)
            else:
                inferred_parts: list[str] = []
                for infer_index, raw_part in enumerate(prompt_parts):
                    protected_part, protected_dialogue = _protect_reasoning_dialogue(raw_part)
                    reasoning_images = [
                        _resize_visual(image, width, height, "适应", "中")
                        for image in segmented_library_media[infer_index][1]["images"]
                    ]
                    reasoning_media = torch.cat(reasoning_images, dim=0) if reasoning_images else None
                    target_shots = _target_shot_count(str(first("shot_plan", "自动 / Auto")))
                    reasoning_max_length = min(1280, max(896, 512 + max(1, target_shots) * 112))
                    _send_status(unique_id, f"推理提示词 {infer_index + 1}/{len(prompt_parts)}...", 0.01)
                    try:
                        generated = GJJ_GemmaTextGenerate().generate(
                            clip_name=reasoning_model_name,
                            clip_type="stable_diffusion", clip_device="default", prompt=protected_part,
                            max_length=reasoning_max_length, sampling_mode="off", temperature=0.35, top_k=64,
                            top_p=0.95, min_p=0.05, repetition_penalty=1.05, seed=0,
                            presence_penalty="0.0", thinking=False, use_default_template=True,
                            media=reasoning_media, unique_id=unique_id,
                            system_prompt=reasoning_system_prompt,
                            keep_model=bool(first("keep_model", False)), device_preference="GPU优先",
                        )
                        payload = generated.get("result") if isinstance(generated, dict) else generated
                        inferred = str(payload[0] if isinstance(payload, (list, tuple)) and payload else payload or "").strip()
                    except Exception as exc:
                        print(
                            "[GJJ_MiniMaxH3Studio] 推理正文不可用，改用用户原始提示词继续生成："
                            f"{exc}",
                            flush=True,
                        )
                        inferred = _officialize_prompt_without_reasoning(
                            prompt="\n\n".join(filter(None, (protected_part, prompt_option_directive))),
                            mode=official_prompt_mode,
                            duration=duration,
                            picture_count=len(segmented_library_media[infer_index][1]["images"]),
                            dialogue_language=str(first("dialogue_language", "中文")),
                        )
                    inferred_parts.append(_restore_reasoning_dialogue(inferred or protected_part, protected_dialogue))
                prompt_parts = inferred_parts
                if reasoning_cache_slot:
                    self._REASONING_CACHE[reasoning_cache_slot] = (reasoning_signature, tuple(prompt_parts))
        else:
            prompt_parts = [
                _officialize_prompt_without_reasoning(
                    prompt="\n\n".join(filter(None, (raw_part, prompt_option_directive))),
                    mode=official_prompt_mode,
                    duration=duration,
                    picture_count=len(segmented_library_media[index][1]["images"]),
                    dialogue_language=str(first("dialogue_language", "中文")),
                )
                for index, raw_part in enumerate(prompt_parts)
            ]
        prompt_parts = [
            _sanitize_reasoned_prompt(
                item,
                official_prompt_mode,
                duration,
                len(segmented_library_media[index][1]["images"]),
                str(first("dialogue_language", "中文")),
                segmented_library_media[index][0],
                len(segmented_library_media[index][1]["videos"]),
                len(segmented_library_media[index][1]["audios"]),
            )
            for index, item in enumerate(prompt_parts)
        ]
        prompt_parts = [
            _apply_prompt_option_selections(
                _assemble_fixed_prompt_fields(item, final_prompt_structure),
                final_prompt_structure,
                duration,
                str(first("visual_style", "自动 / Auto")),
                str(first("shot_plan", "自动 / Auto")),
                str(first("camera_motion", "自动 / Auto")),
                str(first("music_style", "自动 / Auto")),
                raw_prompt_parts[min(index, len(raw_prompt_parts) - 1)] if raw_prompt_parts else "",
            )
            for index, item in enumerate(prompt_parts)
        ]
        constrained_prompt_parts: list[str] = []
        for index, item in enumerate(prompt_parts):
            normalized_prompt = _force_dialogue_language(
                _normalize_picture_reference_tags(item),
                str(first("dialogue_language", "中文")),
            )
            segment_media = segmented_library_media[index][1]
            if not segment_media["images"]:
                normalized_prompt = re.sub(r"(?i)<Picture\s+\d+>", "", normalized_prompt)
            if segment_media["videos"] and segment_media["images"]:
                normalized_prompt = _apply_video_replacement_constraints(
                    normalized_prompt,
                    len(segment_media["images"]),
                )
            constrained_prompt_parts.append(_apply_prompt_constraints(
                prompt=normalized_prompt,
                global_prompt=str(first("global_prompt", "") or ""),
                negative_prompt=str(first("negative_prompt", "") or ""),
            ))
        prompt_parts = constrained_prompt_parts

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
            segment_duration = director_segment_durations[min(index, len(director_segment_durations) - 1)] if director_segment_durations else duration
            mtv_singing_segment = False
            if current_media["audios"]:
                measured_duration = _audio_duration_seconds(current_media["audios"][0])
                if measured_duration is not None:
                    segment_duration = measured_duration
            if mtv_audio_queue and current_media["audios"]:
                mtv_singing_segment = _mtv_audio_should_sing(current_media["audios"][0])
                segment_prompt = (
                    _apply_mtv_audio_performance(segment_prompt)
                    if mtv_singing_segment
                    else _apply_mtv_silent_performance(segment_prompt)
                )
                segment_prompt = _retime_official_prompt(segment_prompt, segment_duration)
            if segment_duration > MAX_AUDIO_DRIVEN_DURATION + 1e-6:
                raise RuntimeError(
                    f"队列第 {index + 1} 段音频长 {segment_duration:.3f} 秒，超过 MiniMax H3 安全上限 "
                    f"{MAX_AUDIO_DRIVEN_DURATION:.1f} 秒。请在上游按不超过该时长重新分段；"
                    "禁止直接生成超长 latent，否则注意力遮罩会导致显存爆炸。"
                )
            segment_length = _aligned_frames(duration=segment_duration, fps=fps)
            mode = segment_mode(current_media)
            modes.append(mode)
            display_mode = (
                f"MTV·{'演唱' if mtv_singing_segment else '静音'}"
                if mtv_audio_queue and current_media["audios"] else mode
            )
            if display_mode.startswith("MTV"):
                print(
                    f"[GJJ_MiniMaxH3Studio] MTV 队列 {index + 1}/{segment_count}："
                    f"{'有歌词人声，角色演唱' if mtv_singing_segment else '静音或无歌词，角色闭口'}；"
                    f"输入音频实测 {segment_duration:.3f} 秒，生成 {segment_length} 帧 @ {fps:g} FPS",
                    flush=True,
                )
            print(
                f"\n[GJJ_MiniMaxH3Studio] ===== 最终提示词 {index + 1}/{segment_count} · {display_mode} =====\n"
                f"{segment_prompt}\n"
                f"[GJJ_MiniMaxH3Studio] ===== 最终提示词结束 =====\n",
                flush=True,
            )
            default_lora_data = _default_accel_lora_data()
            configured_lora_data = str(first("lora_data", default_lora_data) or default_lora_data)
            if configured_lora_data.strip() == "[]":
                configured_lora_data = default_lora_data
            turbo_lora_enabled = _uses_default_accel_lora(configured_lora_data)
            # 模型分支是严格白名单：只有文生、首帧、尾帧、首尾帧使用 FL2VA；
            # 参考图片/视频/音频、MTV 等其余模式一律使用 REF2VA。
            fl2va_modes = {"T2V", "I2V", "尾帧", "首尾帧"}
            model_field = "fl_model" if mode in fl2va_modes else "ref_model"
            model_default = DEFAULT_FL_MODEL if model_field == "fl_model" else DEFAULT_REF_MODEL
            model_name = str(first(model_field, model_default))
            _send_status(unique_id, f"队列 {index + 1}/{segment_count} · {display_mode} · {segment_duration:.3f}秒：加载模型...", index / segment_count)
            if model_name not in runtime_models:
                loaded_model, loaded_clip, loaded_video_vae, loaded_audio_vae = self._load_models(
                    model_name=model_name,
                    clip_name=str(first("clip_name", DEFAULT_CLIP)),
                    video_vae_name=str(first("video_vae_name", DEFAULT_VIDEO_VAE)),
                    audio_vae_name=str(first("audio_vae_name", DEFAULT_AUDIO_VAE)),
                    keep=bool(first("keep_model", False)),
                    unique_id=unique_id,
                )
                lora_events: list[dict[str, Any]] = []
                loaded_model, _unused_lora_clip, _lora_cache = apply_lora_chain_config(
                    loaded_model,
                    None,
                    configured_lora_data,
                    on_lora_applied=lambda payload: lora_events.append(dict(payload)),
                )
                for event in lora_events:
                    print(
                        "[GJJ_MiniMaxH3Studio] LoRA 已应用："
                        f"{event.get('name')} · 强度 {float(event.get('strength', 1.0)):g} · "
                        f"模型权重 {int(event.get('model', 0))} · CLIP 权重 {int(event.get('clip', 0))}",
                        flush=True,
                    )
                sage_enabled, sage_mode = _safe_minimax_sage_settings(
                    bool(first("patch_enable_sage_attention", True)),
                    str(first("patch_sage_attention_mode", "自动")),
                )
                patched_model, _ = GJJ_ModelPatchBundle().patch(
                    MODEL=loaded_model,
                    启用SageAttention=sage_enabled,
                    SageAttention模式=sage_mode,
                    # MiniMax H3 ConvRot + cudaMallocAsync 下编译第三方 Sage kernel 可能产生
                    # 异步非法访存；该模型固定使用 compiler-disable 的稳定调用边界。
                    允许Sage编译=False,
                    启用FP16累积设置=bool(first("patch_enable_fp16_accumulation", True)),
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
                    enabled=bool(first("spectrum_enabled", True)),
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
            cache_clip = bool(first("cache_clip", False))
            clip_cache_slot = f"{unique_id}:{index}" if unique_id is not None else ""
            clip_cache_audios = [
                *current_media["audios"],
                *(video[1] for video in current_media["videos"] if isinstance(video, (list, tuple)) and len(video) > 1),
                *(item.get("audio") for item in current_media.get("voice_audios", []) if isinstance(item, dict)),
            ]
            clip_cache_payload = {
                "prompt": segment_prompt,
                "mode": mode,
                "model": model_name,
                "clip": str(first("clip_name", DEFAULT_CLIP)),
                "lora": configured_lora_data,
                "width": width,
                "height": height,
                "length": segment_length,
                "ref_image_size": ref_image_size,
                "images": _reasoning_visual_signature(list(current_media["images"])),
                "videos": _reasoning_visual_signature([
                    video[0] for video in current_media["videos"] if isinstance(video, (list, tuple)) and video
                ]),
                "audio": [
                    {
                        "sample_rate": audio.get("sample_rate"),
                        "waveform": _reasoning_visual_signature([audio["waveform"]]),
                    }
                    for audio in clip_cache_audios
                    if isinstance(audio, dict) and isinstance(audio.get("waveform"), torch.Tensor)
                ],
            }
            clip_signature = hashlib.sha256(json.dumps(
                clip_cache_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            ).encode("utf-8")).hexdigest()
            cached_clip = self._CLIP_CONDITIONING_CACHE.get(clip_cache_slot) if cache_clip and clip_cache_slot else None
            if cached_clip and cached_clip[0] == clip_signature:
                positive, latent = cached_clip[1], cached_clip[2]
                _send_status(unique_id, f"队列 {index + 1}/{segment_count} · 复用缓存CLIP", index / segment_count)
                print(f"[GJJ_MiniMaxH3Studio] 队列 {index + 1}/{segment_count}：提示词未变，复用缓存 CLIP conditioning。", flush=True)
            else:
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
                        ref_image_size=ref_image_size,
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
                if cache_clip and clip_cache_slot:
                    self._CLIP_CONDITIONING_CACHE[clip_cache_slot] = (clip_signature, positive, latent)
            if not cache_clip and clip_cache_slot:
                self._CLIP_CONDITIONING_CACHE.pop(clip_cache_slot, None)
            guider = _node_output_first(BasicGuider.execute(model=model, conditioning=positive))
            noise = _node_output_first(RandomNoise.execute(noise_seed=(seed + index) % (1 << 64)))
            sampler_name = str(first("sampler_name", "res_multistep"))
            scheduler_name = str(first("scheduler", "simple"))
            sampling_denoise = float(first("denoise", 1.0))
            sampler = _ksampler(sampler_name)
            sampling_steps = int(first("steps", DEFAULT_ACCEL_STEPS))
            sigmas = _basic_sigmas(model, scheduler_name, sampling_steps, sampling_denoise)
            _send_status(unique_id, f"队列 {index + 1}/{segment_count} · 正在采样...", (index + 0.2) / segment_count)
            sampled = _unwrap_node_output(SamplerCustomAdvanced.execute(
                noise=noise, guider=guider, sampler=sampler, sigmas=sigmas, latent_image=latent,
            ))[0]
            _synchronize_comfy_cuda_streams("H3 采样结束后")
            segment_images = nodes.VAEDecode().decode(vae=video_vae, samples=sampled)[0]
            segment_audio = _unwrap_node_output(VAEDecodeAudio.execute(vae=audio_vae, samples=sampled))[0]
            _synchronize_comfy_cuda_streams("视频与音频 VAE 解码结束后")
            if mtv_audio_queue and current_media["audios"] and not mtv_singing_segment:
                # MTV 空镜只生成画面；后续会合并整段源音乐，因此这里必须输出数字静音，
                # 不能保留 H3 自行生成的环境声、配乐或残余人声。
                if isinstance(segment_audio, dict) and isinstance(segment_audio.get("waveform"), torch.Tensor):
                    segment_audio = {
                        **segment_audio,
                        "waveform": torch.zeros_like(segment_audio["waveform"]),
                    }
            # 分段首尾帧与导演台都共享边界帧；后续片段移除第 1 帧及其对应音频，
            # 使上一段尾帧与下一段首帧只在最终拼接结果中保留一次。
            shared_boundary = index > 0 and (image_branch == "分段首尾帧" or bool(director_scenes))
            if shared_boundary and int(segment_images.shape[0]) > 1:
                segment_images = segment_images[1:].contiguous()
                if isinstance(segment_audio, dict) and isinstance(segment_audio.get("waveform"), torch.Tensor):
                    sample_rate = max(1, int(segment_audio.get("sample_rate") or 44100))
                    trim_samples = max(1, round(sample_rate / max(1e-6, fps)))
                    segment_audio = {
                        **segment_audio,
                        "waveform": segment_audio["waveform"][..., trim_samples:].contiguous(),
                    }
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
        final_mode = "MTV" if mtv_audio_queue and queued_audios else (
            image_branch if image_count else ("队列" if segment_count > 1 else modes[0])
        )
        frame_count = sum(int(item.shape[0]) for item in decoded_segments)
        ui = dict(combined.get("ui") or {}) if isinstance(combined, dict) else {}
        ui.update({"mode": [final_mode], "frame_count": [frame_count], "segment_count": [segment_count], "source_image_count": [image_count], "image_branch": [image_branch], "output_path": [str(output_path or "")], "preview_scope": ["final"], "parsed_actors": selected_actors, "parsed_scenes": selected_scenes})
        # 最终合并文件写出后再次推送完整预览字段，覆盖分段过程中显示的最后一段视频。
        _send_status(unique_id, f"{final_mode} 完成：{frame_count} 帧", 1.0, ui)
        _synchronize_comfy_cuda_streams("节点返回之前")
        return {"ui": ui, "result": (video, reference_resources)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MiniMaxH3Studio}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·🧠多模态视频一键生成(MiniMax H3)"}
