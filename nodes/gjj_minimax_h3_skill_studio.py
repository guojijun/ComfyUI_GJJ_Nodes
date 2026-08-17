from __future__ import annotations

import json
import hashlib
import math
import re
from typing import Any

from .gjj_gemma_text_generate import (
    GJJ_GemmaTextGenerate,
    _coerce_media_for_textgen,
    _is_audio_media,
    _text_encoder_options,
)
from .gjj_minimax_h3_studio import (
    DEFAULT_REASONING_SYSTEM_PROMPT,
    _assemble_fixed_prompt_fields,
    _collect_media,
    _force_dialogue_language,
    _normalize_picture_reference_tags,
    _official_prompt_rewrite_rules,
    _protect_reasoning_dialogue,
    _resize_visual,
    _restore_reasoning_dialogue,
    _sanitize_reasoned_prompt,
)


NODE_NAME = "GJJ_MiniMaxH3SkillStudio"
NODE_DISPLAY_NAME = "GJJ·🎬MiniMax H3 提示词生成器"
DEFAULT_MODEL = "Qwen3.5-4B-Uncensored-FP8_E4M3FN.safetensors"

XB_VISUAL_STYLES = [
    "不指定 / Unspecified", "Cinematic / 电影感", "Live-action / 实拍",
    "Vintage film / 复古胶片", "Black & White / 黑白电影", "Documentary / 纪录片",
    "Minimalist commercial / 极简广告", "Macro photography / 微距摄影", "Aerial drone / 航拍",
    "2D-animated / 二维动画", "3D CG / 三维CG", "Anime / 日系二次元",
    "American Comic / 美式漫画", "Pixar-style 3D / 皮克斯3D", "Stop-motion / 定格动画",
    "Hand-drawn glow / 手绘发光", "Pixel art / 像素艺术", "Cyberpunk / 赛博朋克",
    "Steampunk / 蒸汽朋克", "Glitch art / 故障艺术", "Wool felt / 羊毛毡", "Origami / 折纸",
    "Watercolor / 水彩", "Claymation / 粘土动画", "Ink wash / 水墨", "Oil painting / 油画",
    "Paper collage / 纸艺拼贴", "Paper cutout / 剪纸", "Pencil sketch / 铅笔素描",
    "Ukiyo-e / 浮世绘", "Dunhuang Murals / 敦煌壁画", "Blue-white Porcelain / 青花瓷",
    "Gongbi Painting / 工笔画", "Shadow Puppetry / 皮影戏",
    "Chinese Illustration / 中国风插画", "New Year Painting / 年画",
]
XB_VISUAL_STYLE_HINTS = {
    "Cinematic / 电影感": "cinematic lighting with shallow depth of field, film grain, and professional color grading",
    "Live-action / 实拍": "photorealistic live-action footage with natural lighting and authentic set design",
    "Vintage film / 复古胶片": "vintage film stock with warm color grading, subtle grain, and nostalgic atmosphere",
    "Black & White / 黑白电影": "high-contrast black-and-white cinematography with dramatic shadows",
    "Documentary / 纪录片": "observational documentary style with natural handheld camera work and candid framing",
    "Minimalist commercial / 极简广告": "clean minimalist product cinematography with smooth dolly moves, soft even lighting, and uncluttered compositions",
    "Macro photography / 微距摄影": "extreme close-up macro lens with razor-thin depth of field, revealing fine textures and details",
    "Aerial drone / 航拍": "sweeping aerial drone shots with wide vistas, slow majestic reveals, and expansive landscape views",
    "2D-animated / 二维动画": "traditional 2D hand-drawn animation with expressive line art and fluid character motion",
    "3D CG / 三维CG": "high-quality 3D rendering with realistic materials, global illumination, and smooth animation",
    "Anime / 日系二次元": "Japanese anime cel-shading with vibrant saturated colors, clean linework, and expressive character designs",
    "American Comic / 美式漫画": "American comic book style with bold black ink outlines, halftone dot shading, and dynamic compositions",
    "Pixar-style 3D / 皮克斯3D": "Pixar-quality 3D with smooth curved surfaces, rich vibrant colors, expressive character animation, and polished lighting",
    "Stop-motion / 定格动画": "stop-motion animation with tactile frame-by-frame movement, visible material textures, and charming imperfections",
    "Hand-drawn glow / 手绘发光": "rough hand-drawn animation with glowing neon-colored line art overlaid on dark backgrounds",
    "Pixel art / 像素艺术": "retro pixel art with limited color palette, crisp blocky pixels, and vintage video game aesthetic",
    "Cyberpunk / 赛博朋克": "high-contrast neon lighting, rain-slicked surfaces, holographic displays, and chrome details",
    "Steampunk / 蒸汽朋克": "intricate brass machinery, Victorian steam technology, copper pipes, gears, and sepia tones",
    "Glitch art / 故障艺术": "digital glitch distortion, RGB channel splits, scan lines, data corruption, and VHS noise",
    "Wool felt / 羊毛毡": "soft fuzzy wool fibers, handcrafted warmth, visible textile texture, and tactile forms",
    "Origami / 折纸": "crisp folded-paper geometry, sharp creases, layered paper surfaces, and subtle paper texture",
    "Watercolor / 水彩": "translucent color washes, soft bleeding edges, flowing pigment, and delicate diffusion",
    "Claymation / 粘土动画": "malleable sculpted clay figures, visible fingerprints, tool marks, and stop-motion imperfections",
    "Ink wash / 水墨": "fluid Chinese brushstrokes, ink gradients, restrained color, and poetic negative space",
    "Oil painting / 油画": "visible brushstrokes, impasto texture, rich pigments, and luminous layered glazes",
    "Paper collage / 纸艺拼贴": "layered paper pieces, torn uneven edges, varied fibers, and handcrafted depth",
    "Paper cutout / 剪纸": "intricate cut-paper silhouettes, symmetrical patterns, and bold flat color contrast",
    "Pencil sketch / 铅笔素描": "graphite linework, expressive hatching, smudged shading, and raw hand-drawn energy",
    "Ukiyo-e / 浮世绘": "woodblock-print flat colors, bold outlines, patterned surfaces, and Edo-period composition",
    "Dunhuang Murals / 敦煌壁画": "mineral pigments, weathered fresco texture, flowing forms, ochre and turquoise palette",
    "Blue-white Porcelain / 青花瓷": "cobalt blue hand-painted patterns on white glaze, scrolling vines, and ceramic sheen",
    "Gongbi Painting / 工笔画": "ultra-fine controlled outlines, flat mineral washes, silk texture, and meticulous detail",
    "Shadow Puppetry / 皮影戏": "carved leather silhouettes, warm amber backlight, articulated joints, and theatrical staging",
    "Chinese Illustration / 中国风插画": "elegant flowing lines, ink-inspired forms, poetic composition, and dreamlike color harmony",
    "New Year Painting / 年画": "folk woodblock texture, bold primary colors, auspicious motifs, and festive flat composition",
}
XB_MUSIC_STYLES = [
    "不指定 / Unspecified", "Piano / 钢琴", "Orchestral / 管弦乐", "Acoustic / 原声吉他",
    "Electronic / 电子", "Ambient / 氛围", "Synthwave / 合成器浪潮", "Chiptune / 芯片音乐",
    "Lo-fi / Lo-fi", "Epic / 史诗", "Suspense / 悬疑", "Romantic Strings / 浪漫弦乐",
    "Rock / 摇滚", "Jazz / 爵士", "Hip-Hop / 嘻哈", "Funk / 放克",
    "Acapella Choir / 纯人声合唱", "Minimalist Foley / 极简拟音", "Chinese Folk / 国风民乐",
    "Chinese Opera / 戏曲", "Guqin / 古琴",
]
XB_MUSIC_HINTS = {
    "Piano / 钢琴": "慢至中速独奏钢琴，稀疏细腻音符与自然混响",
    "Orchestral / 管弦乐": "完整管弦配器，弦乐渐强、温暖铜管与木管由轻柔发展至宏大",
    "Acoustic / 原声吉他": "温暖木质共鸣的原声吉他指弹与柔和节奏",
    "Electronic / 电子": "分层合成器、电子节拍与氛围铺底",
    "Ambient / 氛围": "无明显节拍的持续长音、细微纹理与空间氛围",
    "Synthwave / 合成器浪潮": "模拟低音脉冲、复古鼓机、霓虹感铺底与稳定推进节奏",
    "Chiptune / 芯片音乐": "方波旋律、简洁波形与复古八位机节奏",
    "Lo-fi / Lo-fi": "黑胶噪声、柔和和弦、轻鼓循环与舒缓慢拍",
    "Epic / 史诗": "强劲铜管、轰鸣打击乐、高扬合唱与戏剧性强弱起伏",
    "Suspense / 悬疑": "低频持续音、不协和突击、逐步累积的紧张感与骤停留白",
    "Romantic Strings / 浪漫弦乐": "丰润小提琴、柔和大提琴、竖琴滑奏与温柔情绪弧线",
    "Rock / 摇滚": "电吉他 riff、推进鼓组、贝斯律动与高能动态",
    "Jazz / 爵士": "行走贝斯、刷镲鼓、即兴钢琴或萨克斯与烟雾俱乐部氛围",
    "Hip-Hop / 嘻哈": "厚重 808 低音、清脆军鼓、滚动踩镲与律动节拍",
    "Funk / 放克": "弹跳 slap 贝斯、紧凑节奏吉他、铜管断奏与切分律动",
    "Acapella Choir / 纯人声合唱": "无乐器的多层人声和声，营造神圣、空灵或幽邃氛围",
    "Minimalist Foley / 极简拟音": "无旋律配乐，仅保留清晰物理拟音、轻微掠过声与空间静默",
    "Chinese Folk / 国风民乐": "古筝、二胡、竹笛、琵琶与流动五声音阶旋律",
    "Chinese Opera / 戏曲": "锣鼓、梆子、尖锐胡琴与传统戏曲式戏剧化节奏",
    "Guqin / 古琴": "古琴独奏，低沉丝弦拨奏、缓慢冥想速度与细微泛音",
}
XB_CUT_OPTIONS = [
    "不指定 / Unspecified", "不切镜 / Single Shot", "1 次切镜 / 1 Cut", "2 次切镜 / 2 Cuts",
    "3 次切镜 / 3 Cuts", "4 次切镜 / 4 Cuts", "5 次切镜 / 5 Cuts", "6 次切镜 / 6 Cuts",
    "7 次切镜 / 7 Cuts", "8 次切镜 / 8 Cuts", "9 次切镜 / 9 Cuts",
]


class AnyMediaType(str):
    def __ne__(self, _other: object) -> bool:
        return False


MEDIA_TYPE = AnyMediaType("IMAGE,GJJ_BATCH_IMAGE,VIDEO,AUDIO")


def _qwen35_model_options() -> list[str]:
    options = []
    for item in _text_encoder_options():
        normalized = re.sub(r"[^a-z0-9]+", "", str(item).casefold())
        if "qwen3" in normalized:
            options.append(str(item))
    return options or [DEFAULT_MODEL]


def _qwen35_default_missing() -> bool:
    default_key = DEFAULT_MODEL.replace("\\", "/").casefold()
    return not any(str(item).replace("\\", "/").casefold() == default_key for item in _text_encoder_options())

SKILL_PROFILES = {
    "自动识别": "Choose the best matching profile below from the request and media. State the chosen profile in the package.",
    "H3 官方提示词": (
        "Write a strict MiniMax H3 prompt. Support T2VA, I2VA, FL2VA, L2VA and Ref2VA. Base modes use "
        "integrated_multimodal_description, overall_soundscape, non_diegetic_music. Ref2VA uses subject_definitions, "
        "summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Use English prose; "
        "preserve dialogue, lyrics and visible text verbatim in their original language."
    ),
    "3D 动画短片": (
        "Plan a story-first stylized 3D animated short. Lock appealing warm stylized 3D unless overridden. Include project "
        "brief, story outline, character cards, character-free scene cards, a six-column shot table in this exact order: "
        "shot/duration, continuity handoff, spatial+identity anchors, hook type, per-second shot directives, audio/dialogue. "
        "Every second covers performance, camera, space, audio and handoff. Maximum 15 seconds and 3 important characters "
        "per shot. Include text storyboards, continuity QC, H3 shot prompts, assembly and BGM plan."
    ),
    "品牌宣传短片": (
        "Build a brand truth sheet and provenance manifest from supplied assets; never invent claims or redraw logos, UI, "
        "packaging or mascots. Define audience, platform, duration, aspect and CTA. Use a product-specific story spine, "
        "frame-aware beats, verified proof, motion direction, native-audio strategy, exact shot plan and pre-delivery review. "
        "Default 15 seconds when unspecified and add subtitles only when requested."
    ),
    "双人合作游戏片头": (
        "Create a two-player co-op game menu/opening. Preserve exactly two player identities, player names and game title. "
        "Use a stable approval-frame layout with two character zones, player cards, coordinated palette, menu buttons, icons "
        "and readable typography. Then specify identity locks, UI copy, event timing, menu interaction animation, audio cues "
        "and the final H3 prompt. Do not expand into a playable game or multi-page UI."
    ),
    "手绘实拍融合": (
        "Create one surreal 15-second 16:9 scene blending live action with rough glowing hand-drawn animation. Define physical "
        "contact, continuous morphing, a clear escape route and delayed handheld chase response. Preserve tactile contact and "
        "rough luminous stroke texture. Avoid polished CG, plush appearance, horror jumpscares and unrelated scene cuts."
    ),
    "极简产品广告": (
        "Create a premium minimalist product ad from verified product imagery and requirements. Identify the exact product "
        "variant and selling points, concise English ad copy, clean negative space, premium materials, controlled lighting, "
        "beat-synced typography, product-safe camera motion and storyboard. Never alter product geometry, label, logo, color "
        "or make unsupported claims. End with a restrained product lockup and CTA."
    ),
    "MV 字幕音乐视频": (
        "Design an MV where master audio, lyrics, performance, spatial typography, rhythm and camera are one system. Map every "
        "shot to exact audio time. Visible lyric text must match the performed words exactly and act as a spatial graphic, "
        "not a subtitle bar. For works over 15 seconds use 2-5 second shots and one continuous master audio. Put cuts on "
        "breaths or beat-grid accents; enforce lip, rhythm, grade, motion and typography continuity across stitched shots."
    ),
    "纸拼贴讲解": (
        "Create a tactile halftone paper-collage explainer. Extract meaning and visual metaphors, then provide brief, palette, "
        "storyboard, approved still specifications, stop-motion assembly and H3 prompts. Use 3-6 large separable paper groups, "
        "clear foreground/midground/background depth and paper slide, pop, tap, flatten and friction motion. Default 16:9 and "
        "about 4 seconds per clip. Keep tactile collage SFX; no BGM, voiceover, subtitles, readable UI, watermark or logo unless requested."
    ),
    "纸艺定格科普": (
        "Create a production-ready papercraft stop-motion educational package. State learning goal and visual metaphor, style "
        "DNA, paper characters, character-free layered diorama scenes, 4-7 depth planes, props, preview prompts, image-series "
        "prompts, storyboard, editing rhythm, physical paper transitions, sound design, narration timing, negatives and QC. "
        "Default to a 30-second 16:9 plan when unspecified. Each shot explains one knowledge beat and visibly behaves like "
        "cut card, pop-up-book or miniature paper animation rather than ordinary 2D art or smooth CG."
    ),
}

SKILL_PROMPT_GUIDANCE = {
    "自动识别": "Infer the most suitable visual treatment from the request and apply it inside the official H3 prompt.",
    "H3 官方提示词": "Prioritize exact MiniMax H3 field structure, observable action, temporal continuity, camera behavior and synchronized sound.",
    "3D 动画短片": "Use appealing warm stylized 3D animation, expressive performance, readable silhouettes, tactile materials, coherent staging and fluid story-driven motion.",
    "品牌宣传短片": "Preserve verified product and brand identity, use premium controlled lighting, readable composition, restrained typography and a clear visual CTA without unsupported claims.",
    "双人合作游戏片头": "Preserve exactly two player identities, stable character zones, coordinated game-menu aesthetics, readable UI motion and clear cooperative interaction.",
    "手绘实拍融合": "Blend live action with rough luminous hand-drawn animation through physical contact, continuous morphing, tactile strokes and responsive handheld camera movement.",
    "极简产品广告": "Use premium minimalism, clean negative space, faithful product geometry and labels, controlled material lighting and concise product-safe motion.",
    "MV 字幕音乐视频": "Synchronize performance, spatial lyric typography, rhythm and camera to the audio timeline; visible lyrics must match performed words exactly.",
    "纸拼贴讲解": "Use tactile halftone paper collage, separable depth layers, stop-motion paper movement, clear visual metaphor and physical paper sound effects.",
    "纸艺定格科普": "Use layered papercraft dioramas, readable educational staging, physical paper transitions, stop-motion rhythm and one clear knowledge beat per shot.",
}

DELIVERABLE_RULES = {
    "完整制作包": "Return every production section relevant to the selected profile, plus final H3 prompt, negatives and shot JSON.",
    "仅 H3 最终提示词": "Keep the package concise and prioritize one production-ready final H3 prompt.",
    "仅分镜与运镜": "Prioritize timed shots, spatial anchors, continuity, actions, camera, transitions and audio cues.",
    "仅角色与场景资产": "Prioritize identity-safe character cards, character-free scene cards, props and reusable image prompts.",
    "仅审核与修复": "Audit the supplied plan or prompt, list concrete failures, then provide corrected production-ready output.",
}

H3_MODE_RULES = {
    "自动": "Infer the correct H3 mode from connected media and user intent.",
    "T2VA": "Use the base three-field T2VA structure with no image alignment line.",
    "I2VA": "Use Picture 1 as Shot 1 at 0.00 seconds and develop continuously forward.",
    "FL2VA": "Align Picture 1 to 0.00 seconds and Picture 2 to the exact final second; describe the continuous path.",
    "L2VA": "Align Picture 1 to the exact final second and converge toward it from a plausible earlier state.",
    "Ref2VA": "Use the full six-section reference structure and stable Subject/Picture/Video/Audio labels.",
}

COMMON_SYSTEM_PROMPT = """You are the self-contained GJJ MiniMax H3 final-prompt writer. The rules in this message are embedded from the MiniMax H3 skill suite; never request or read an external skill file and never claim to call a cloud agent.

Preserve user intent and media identity. Do not invent brand facts, dialogue, lyrics, visible copy or reference labels. A reference label may exist only when the corresponding media exists. Every shot must state composition, subject position, environment, observable action process, camera behavior, synchronized sound and continuity. Shot 1 has no timestamp; later shots use [Shot N] At MM:SS.mmm with strictly increasing times within duration. No shot exceeds 15 seconds. Avoid abstract plot summaries and bracket-weight syntax.

Keep official H3 field names, reference labels and timing syntax unchanged. Write all descriptive prose in the user-selected content language. Dialogue, lyrics and visible scene text remain verbatim in their original language. Dialogue uses stable (S1), (S2) IDs and <d>[Language] exact text</d>. overall_soundscape excludes dialogue and music. non_diegetic_music describes instrumentation, tempo, rhythm and dynamics, or N/A.

Concentrate all useful creative and production detail into one executable positive prompt. Treat the selected skill profile only as an internal checklist: never output its project brief, story outline, character cards, scene cards, shot table, storyboard, QC, assembly plan or BGM plan as separate sections. Use at most 8 shots and 1200 English words. The timing must cover the requested duration without gaps or overlaps. Every field and section may appear exactly once. Never repeat a phrase, instruction or list item. Stop immediately after non_diegetic_music.

Return only the final MiniMax H3 positive prompt. Do not return JSON, Markdown fences, analysis, production notes, a negative prompt, a shot list outside the official prompt, alternatives, explanations or prefatory text. Start immediately with the first official H3 field or alignment sentence required by the selected mode."""


def _compact_generation_system(mode: str, content_language: str) -> str:
    """A short contract that small local models follow more reliably than stacked manuals."""
    if mode == "R2VA":
        fields = (
            "subject_definitions:, summary:, retention_analysis:, detailed_description:, "
            "overall_soundscape:, non_diegetic_music:"
        )
        structure = (
            "Start with subject_definitions:. Emit all six fields exactly once in that order. "
            "subject_definitions contains only reusable subject/scene appearance definitions, one reference per line. "
            "summary is one concise sentence. retention_analysis contains one preservation decision per reference. "
            "detailed_description contains only the shot timeline and observable events; it must never repeat or copy "
            "subject_definitions, summary, retention_analysis, or their field names."
        )
    else:
        fields = "integrated_multimodal_description:, overall_soundscape:, non_diegetic_music:"
        structure = (
            "Emit all three official fields exactly once in that order. integrated_multimodal_description contains "
            "only the shot timeline and observable events."
        )
    return f"""You create content for one MiniMax H3 prompt in a single response.
The final formatter will create these official fields: {fields}
{structure}
Return only one valid JSON object with exactly these keys: subject_definitions (array of strings), summary (string), retention_analysis (array of strings), action_segments (array of strings), overall_soundscape (string), non_diegetic_music (string). Do not output Markdown or any text outside JSON. action_segments must contain exactly the requested number of items in order. Each item contains continuous observable action, spatial continuity, environmental response and synchronized physical sound, but no shot scale, camera movement, [Shot N], timestamp or parenthesized time label; the formatter assigns a distinct shot scale and camera move and adds all labels. All content uses {content_language}, except immutable reference labels and original dialogue/text. Reference identity includes exact clothing and accessories: never redesign wardrobe from a role, faction, martial-arts school or action style. Each action segment must advance from the exact ending state of the previous item and complete a visible action change. overall_soundscape and non_diegetic_music contain only 1–3 concise sentences; never continue story action, analysis or associative prose inside them. When the user requests dialogue/voice, embed short natural spoken lines using the official MiniMax H3 tag format <d>[Language]spoken text</d> inside action_segments — for example <d>[中文]你好，很高兴见到你</d>. Each speaking character uses this format. Place dialogue naturally within the action flow, not as a separate section."""


def _extract_json(text: str) -> dict[str, Any] | None:
    source = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", str(text or "").strip(), flags=re.IGNORECASE)
    try:
        value = json.loads(source)
        return value if isinstance(value, dict) else None
    except Exception:
        pass
    start = source.find("{")
    end = source.rfind("}")
    if start >= 0 and end > start:
        try:
            value = json.loads(source[start:end + 1])
            return value if isinstance(value, dict) else None
        except Exception:
            return None
    return None


def _collapse_repeated_items(text: str, limit: int = 0) -> str:
    """Remove exact repeated comma/newline items while preserving first-use order."""
    parts = re.split(r"([,，;；\n]+)", str(text or ""))
    output: list[str] = []
    seen: set[str] = set()
    item_count = 0
    for index in range(0, len(parts), 2):
        item = parts[index].strip()
        if not item:
            continue
        key = re.sub(r"\s+", " ", item).casefold()
        if key in seen:
            continue
        seen.add(key)
        output.append(item)
        item_count += 1
        if limit and item_count >= limit:
            break
    return ", ".join(output)


def _clean_generated_value(value: Any, max_chars: int) -> str:
    source = re.sub(r"^\s*```(?:json|text|markdown)?\s*|\s*```\s*$", "", str(value or "").strip(), flags=re.IGNORECASE)
    source = re.sub(r"(?im)^\s*(?:prompt|result|output)\s*:\s*", "", source).strip()
    if len(source) > max_chars:
        source = source[:max_chars].rsplit("\n", 1)[0].rstrip(" ,，;；")
    return source


def _dedupe_generated_blocks(value: Any) -> str:
    """Remove paragraph loops and truncate repeated sentence cycles from local-model output."""
    source = str(value or "").strip()
    sentence_matches = list(re.finditer(r"(?s)(?:^|\s+)(\S.*?[.!?])(?=\s+|$)", source))
    sentence_keys = [
        re.sub(r"\s+", " ", match.group(1)).strip().casefold()
        for match in sentence_matches
    ]
    cycle_cutoff: int | None = None
    for start in range(len(sentence_keys)):
        remaining = len(sentence_keys) - start
        for period in range(1, min(64, remaining // 3) + 1):
            first_cycle = sentence_keys[start:start + period]
            if (
                first_cycle == sentence_keys[start + period:start + period * 2]
                and first_cycle == sentence_keys[start + period * 2:start + period * 3]
            ):
                cycle_cutoff = sentence_matches[start].start(1)
                break
        if cycle_cutoff is not None:
            break
    if cycle_cutoff is not None:
        source = source[:cycle_cutoff].rstrip()
    blocks = re.split(r"\n\s*\n+", source)
    output: list[str] = []
    seen: set[str] = set()
    for block in blocks:
        cleaned = block.strip()
        if not cleaned:
            continue
        key = re.sub(r"\s+", " ", cleaned).strip().casefold()
        if key in seen:
            continue
        if len(key) < 80 and any(previous.startswith(key) for previous in seen):
            continue
        seen.add(key)
        output.append(cleaned)
    return "\n\n".join(output)


def _media_runtime_signature(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return tuple(sorted((str(key), _media_runtime_signature(item)) for key, item in value.items()))
    if isinstance(value, (list, tuple)):
        return tuple(_media_runtime_signature(item) for item in value)
    shape = tuple(int(item) for item in getattr(value, "shape", ()))
    # PyTorch inference tensors intentionally do not expose a version counter.
    # Accessing ``_version`` on one raises instead of returning a value, so the
    # cache signature must treat it as optional runtime metadata.
    try:
        version = int(getattr(value, "_version", 0))
    except (AttributeError, RuntimeError, TypeError, ValueError):
        version = 0
    return (
        type(value).__name__, id(value), shape, str(getattr(value, "dtype", "")),
        version,
    )


def _first_list_input(value: Any, default: Any = None) -> Any:
    """Unwrap scalar widgets after ComfyUI's INPUT_IS_LIST collection step."""
    while isinstance(value, list):
        if not value:
            return default
        value = value[0]
    return default if value is None else value


def _normalize_list_media(value: Any) -> Any:
    """Keep a media queue intact while removing executor-created empty wrappers."""
    if not isinstance(value, list):
        return value
    cleaned = [item for item in value if item is not None]
    if not cleaned:
        return None
    while len(cleaned) == 1 and isinstance(cleaned[0], list):
        cleaned = [item for item in cleaned[0] if item is not None]
        if not cleaned:
            return None
    return cleaned


def _library_selection_names(value: Any) -> list[str]:
    """Read the frontend's actor/scene JSON while accepting legacy name lists."""
    source = value
    if isinstance(source, str):
        try:
            source = json.loads(source or "[]")
        except (TypeError, ValueError, json.JSONDecodeError):
            source = []
    if not isinstance(source, (list, tuple)):
        return []
    names: list[str] = []
    for item in source:
        if isinstance(item, dict):
            name = item.get("name") or item.get("display_name") or item.get("title") or item.get("id")
        else:
            name = item
        cleaned = re.sub(r"^\s*[♀♂]\ufe0f?\s*", "", str(name or "")).strip().lstrip("@🏕️").strip()
        if cleaned and cleaned not in names:
            names.append(cleaned)
    return names


def _library_selection_records(value: Any) -> list[dict[str, str]]:
    """Preserve library notes so identity and wardrobe locks reach the prompt model."""
    source = value
    if isinstance(source, str):
        try:
            source = json.loads(source or "[]")
        except (TypeError, ValueError, json.JSONDecodeError):
            source = []
    if not isinstance(source, (list, tuple)):
        return []
    records: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in source:
        if isinstance(item, dict):
            raw_name = item.get("name") or item.get("display_name") or item.get("title") or item.get("id")
            notes = str(item.get("notes") or item.get("description") or "").strip()
        else:
            raw_name, notes = item, ""
        name = re.sub(r"^\s*[♀♂]\ufe0f?\s*", "", str(raw_name or "")).strip().lstrip("@🏕️").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        records.append({"name": name, "notes": notes})
    return records


def _request_scene_references(value: Any) -> list[str]:
    """Collect explicit 🏕️ references from the request for deterministic preservation."""
    text = str(value or "")
    names: list[str] = []
    for match in re.finditer(r"🏕️?\s*([^\s，。；：、,.!?;:()（）\[\]{}\"'“”‘’]+)", text):
        name = str(match.group(1) or "").strip().rstrip("/\\")
        if name and name not in names:
            names.append(name)
    return names


def _force_scene_references(prompt: str, names: list[str]) -> str:
    """Hard-inject missing scene references into the first H3 shot description."""
    result = str(prompt or "")
    missing = [
        name for name in dict.fromkeys(str(value or "").strip() for value in names)
        if name and not re.search(rf"🏕️?\s*{re.escape(name)}(?=$|[\s，。；：、,.!?;:()（）/\\\[\]{{}}])", result)
    ]
    if not missing:
        return result
    references = "、".join(f"🏕️{name}" for name in missing)
    shot = re.search(r"(?im)(\[Shot\s+\d+\](?:\s+At\s+[^,，\n]+[,，]?)?\s*)", result)
    if shot:
        return f"{result[:shot.end()]}{references}，{result[shot.end():]}"
    detail = re.search(r"(?im)^(detailed_description|integrated_multimodal_description):\s*", result)
    if detail:
        return f"{result[:detail.end()]}{references}。\n{result[detail.end():]}"
    return f"{result.rstrip()}\n\ndetailed_description:\n{references}。"


def _force_scene_subject_definitions(prompt: str, names: list[str]) -> str:
    """Ensure every selected 🏕️ scene is declared as its own Ref2VA subject."""
    result = str(prompt or "")
    unique_names = list(dict.fromkeys(str(value or "").strip() for value in names if str(value or "").strip()))
    if not unique_names:
        return result
    field = re.search(r"(?im)^subject_definitions:\s*", result)
    if not field:
        return result
    section_end = re.search(r"(?im)^summary:\s*", result[field.end():])
    end = field.end() + section_end.start() if section_end else len(result)
    section = result[field.end():end]
    missing = [
        name for name in unique_names
        if not re.search(
            rf"🏕️\s*{re.escape(name)}(?=$|[\s，。；：、,.!?;:()（）/\\\[\]{{}}])",
            section,
        )
    ]
    if not missing:
        return result
    additions = "\n".join(
        f"🏕️{name}：用户指定的场景引用；完整保留其空间布局、地貌或建筑结构、材质、配色、光线与标志性环境特征。"
        for name in missing
    )
    existing = section.rstrip()
    replacement = ("\n" + existing + ("\n" if existing else "") + additions + "\n\n")
    return result[:field.end()] + replacement + result[end:].lstrip()


def _prepare_reasoning_media(media: Any) -> Any:
    """Pack every image in a GJJ queue into one visual batch for Qwen."""
    if media is None or _is_audio_media(media):
        return media
    collected = _collect_media(media)
    images = list(collected.get("images") or [])[:10]
    if images:
        import torch

        normalized = [_coerce_media_for_textgen(image) for image in images]
        normalized = [image for image in normalized if image is not None]
        if not normalized:
            return None
        target_height = int(normalized[0].shape[-3])
        target_width = int(normalized[0].shape[-2])
        aligned = [
            _resize_visual(image, target_width, target_height, "补边", "中")
            for image in normalized
        ]
        return torch.cat(aligned, dim=0).contiguous()
    videos = list(collected.get("videos") or [])
    if videos:
        first_video = videos[0]
        return first_video[0] if isinstance(first_video, (list, tuple)) and first_video else first_video
    audios = list(collected.get("audios") or [])
    if audios:
        return audios[0]
    return media


def _media_inventory(media: Any, enabled: bool) -> tuple[int, int, int]:
    if not enabled or media is None:
        return 0, 0, 0
    if _is_audio_media(media):
        return 0, 0, 1
    type_name = type(media).__name__.casefold()
    if hasattr(media, "get_components") or "video" in type_name:
        return 0, 1, 0
    if isinstance(media, dict) and any(key in media for key in ("frames", "video")):
        return 0, 1, 0

    def image_count(value: Any) -> int:
        if value is None:
            return 0
        shape = getattr(value, "shape", None)
        if shape is not None:
            return int(shape[0]) if len(shape) >= 4 else 1
        if isinstance(value, (list, tuple)):
            return sum(image_count(item) for item in value)
        if isinstance(value, dict):
            for key in ("images", "image", "samples"):
                if key in value:
                    return image_count(value[key])
        nested = getattr(value, "images", None)
        return image_count(nested) if nested is not None else 0

    direct_count = image_count(media)
    if direct_count:
        return max(0, min(10, direct_count)), 0, 0
    try:
        images = _coerce_media_for_textgen(media)
        count = int(images.shape[0]) if images is not None and hasattr(images, "shape") else 0
        return max(0, min(10, count)), 0, 0
    except Exception:
        return 1, 0, 0


def _official_mode(selected: str, media_present: bool) -> str:
    value = str(selected or "自动")
    if value == "自动":
        return "R2VA" if media_present else "T2VA"
    return "R2VA" if value.casefold() in {"ref2va", "r2va"} else value


def _resolved_content_language(selected: str, request: str) -> tuple[str, str]:
    value = str(selected or "自动")
    if value == "自动":
        source = str(request or "")
        if re.search(r"[\u3040-\u30ff]", source):
            value = "日本語"
        elif re.search(r"[\uac00-\ud7af]", source):
            value = "한국어"
        elif re.search(r"[\u3400-\u9fff]", source):
            value = "中文"
        else:
            value = "English"
    dialogue = {"English": "英语", "日本語": "日语", "한국어": "韩语", "中文": "中文"}.get(value, "中文")
    return value, dialogue


def _localized_official_prompts(
    mode: str, duration: float, picture_count: int, content_language: str, dialogue_language: str,
) -> tuple[str, str]:
    language_name = {
        "中文": "简体中文", "English": "English", "日本語": "日本語", "한국어": "한국어",
    }.get(content_language, "简体中文")
    directive = (
        f"最高优先级语言规则：subject_definitions、summary、retention_analysis、detailed_description、"
        f"integrated_multimodal_description、overall_soundscape、non_diegetic_music 等官方字段名，"
        f"以及 <Picture N>、[Shot N]、时间戳、模式代码和保留级别标记保持规定格式；"
        f"这些字段内部的所有画面、动作、运镜、声音及音乐描述必须使用{language_name}。"
        "对白、歌词和画面中真实可见的文字严格保留其原始语言。"
    )
    base = re.sub(
        r"所有结构字段、说明与画面描述必须使用英文；仅对白、歌词和画面中真实可见的文字严格保留原语言。",
        directive,
        DEFAULT_REASONING_SYSTEM_PROMPT,
        count=1,
    )
    rules = _official_prompt_rewrite_rules(mode, duration, picture_count, dialogue_language)
    rules = re.sub(
        r"最高优先级输出语言规则：全部结构字段、说明、分析、画面、动作、运镜和声音描述必须使用英文；"
        r"仅对白、歌词和画面中真实可见的文字保留原语言。",
        directive,
        rules,
        count=1,
    )
    rules = rules.replace("正文使用英文，并严格", f"字段正文使用{language_name}、固定字段名保持英文，并严格")
    rules = rules.replace("overall_soundscape 用英文概括", f"overall_soundscape 字段内容用{language_name}概括")
    rules = rules.replace("non_diegetic_music 用英文描述", f"non_diegetic_music 字段内容用{language_name}描述")
    rules = rules.replace("运镜用中文自然描述", f"运镜用{language_name}自然描述")
    return base, rules


def _requested_shot_count(request: str, duration: float, cut_selection: str = "") -> int:
    source = str(request or "")
    selected_cuts = str(cut_selection or "")
    if "不切镜" in selected_cuts or "Single Shot" in selected_cuts:
        return 1
    selected_match = re.match(r"\s*(\d+)\s*", selected_cuts)
    if selected_match and "不指定" not in selected_cuts and "Unspecified" not in selected_cuts:
        return max(1, min(10, int(selected_match.group(1)) + 1))
    if re.search(r"一镜到底|单镜头|不切镜|single\s+shot|one[- ]take", source, flags=re.IGNORECASE):
        return 1
    match = re.search(r"(\d+)\s*(?:个|组|段)?\s*(?:镜头|分镜|shots?)", source, flags=re.IGNORECASE)
    if match:
        return max(1, min(10, int(match.group(1))))
    cut_match = re.search(r"(\d+)\s*(?:次切镜|cuts?)", source, flags=re.IGNORECASE)
    if cut_match:
        return max(1, min(10, int(cut_match.group(1)) + 1))
    return max(2, min(6, int(math.ceil(max(1.0, float(duration)) / 4.0))))


def _format_timestamp(seconds: float) -> str:
    safe_seconds = max(0.0, float(seconds))
    minutes = int(safe_seconds // 60.0)
    remainder = safe_seconds - minutes * 60.0
    return f"{minutes:02d}:{remainder:06.3f}"


def _format_beat_seconds(seconds: float) -> str:
    """Format action-beat offsets as compact seconds, e.g. 0, 1.5, 10.25."""
    return f"{max(0.0, float(seconds)):.3f}".rstrip("0").rstrip(".")


def _action_beat_ranges(duration: float, minimum_count: int = 1) -> list[tuple[float, float]]:
    """Split the full timeline into contiguous action descriptions no longer than 1.5s."""
    total = max(0.001, float(duration))
    beat_count = max(1, int(minimum_count), int(math.ceil(total / 1.5)))
    step = total / beat_count
    return [
        (step * index, total if index + 1 == beat_count else step * (index + 1))
        for index in range(beat_count)
    ]


def _shot_cut_times(duration: float, shot_count: int) -> list[float]:
    """Place shot cuts on action-beat boundaries while distributing beats evenly."""
    count = max(1, int(shot_count))
    if count <= 1:
        return []
    beats = _action_beat_ranges(duration)
    beat_count = len(beats)
    if beat_count < count:
        return [max(0.0, float(duration)) * index / count for index in range(1, count)]
    indices: list[int] = []
    previous = 0
    for shot_index in range(1, count):
        remaining_cuts = count - shot_index - 1
        proposed = int(math.floor(beat_count * shot_index / count + 0.5))
        boundary_index = max(previous + 1, min(beat_count - remaining_cuts - 1, proposed))
        indices.append(boundary_index)
        previous = boundary_index
    return [beats[index][0] for index in indices]


def _estimate_dialogue_duration(text: str) -> float:
    """估算一段文本中所有 <d>[语言]对白</d> 台词的朗读时长（秒）。

    估算规则：
    - 中文/日文/韩文：约 4 字/秒
    - 英文：约 2.5 词/秒
    - 每句台词额外加 0.3 秒停顿
    - 无台词返回 0
    """
    if not text:
        return 0.0
    dialogue_pattern = re.compile(r"(?is)<d>\s*(?:\[[^\]\r\n]+\]\s*)?(.*?)\s*</d>")
    matches = dialogue_pattern.findall(text)
    if not matches:
        return 0.0
    total_seconds = 0.0
    for line in matches:
        line = line.strip()
        if not line:
            continue
        # 检测语言：含中日韩字符视为 CJK，否则英文
        cjk_chars = len(re.findall(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", line))
        if cjk_chars > 0:
            # CJK：4 字/秒
            total_seconds += max(0.5, cjk_chars / 4.0)
        else:
            # 英文：2.5 词/秒
            words = len(re.findall(r"\b[\w'-]+\b", line))
            total_seconds += max(0.5, words / 2.5)
        # 每句加 0.3 秒停顿
        total_seconds += 0.3
    return total_seconds


def _weighted_beat_ranges(
    duration: float, segments: list[str], min_beat: float = 1.0,
) -> list[tuple[float, float]]:
    """根据每段台词长度按权重分配时间，台词多的段落分到更多时间，避免台词说不完。

    算法：
    1. 每段的最低需求 = max(台词时长, 1.0秒)
    2. 如果最低需求总和 <= 总时长：先满足最低需求，剩余时间按权重分配
    3. 如果最低需求总和 > 总时长：按台词时长比例分配（台词多的多分）
    """
    total = max(0.001, float(duration))
    count = len(segments)
    if count == 0:
        return [(0.0, total)]

    # 计算每段台词时长和最低需求
    dialogue_times = [_estimate_dialogue_duration(seg) for seg in segments]
    min_requirements = [max(min_beat, dt) for dt in dialogue_times]
    total_min = sum(min_requirements)

    if total_min <= total:
        # 情况1：时间够，先满足最低需求，剩余按权重分配
        surplus = total - total_min
        weights = [dt + 1.0 for dt in dialogue_times]  # 权重 = 台词时长 + 动作时间
        total_weight = sum(weights)
        allocations = []
        for i in range(count):
            base = min_requirements[i]
            extra = surplus * weights[i] / total_weight if total_weight > 0 else 0
            allocations.append(base + extra)
    else:
        # 情况2：时间不够，按台词时长比例分配（台词多的多分）
        allocations = []
        for i in range(count):
            alloc = total * min_requirements[i] / total_min
            allocations.append(alloc)

    # 生成时间区间，处理浮点误差
    ranges: list[tuple[float, float]] = []
    accumulator = 0.0
    for index in range(count):
        start = accumulator
        if index == count - 1:
            end = total
        else:
            end = start + allocations[index]
        ranges.append((start, end))
        accumulator = end
    return ranges


def _weighted_shot_cut_times(
    duration: float, shot_count: int, beat_ranges: list[tuple[float, float]],
) -> list[float]:
    """根据加权后的 beat 边界，按 shot_count 均分 beat 数量来放置切镜点。"""
    count = max(1, int(shot_count))
    if count <= 1:
        return []
    beat_count = len(beat_ranges)
    if beat_count < count:
        return [max(0.0, float(duration)) * index / count for index in range(1, count)]
    indices: list[int] = []
    previous = 0
    for shot_index in range(1, count):
        remaining_cuts = count - shot_index - 1
        proposed = int(math.floor(beat_count * shot_index / count + 0.5))
        boundary_index = max(previous + 1, min(beat_count - remaining_cuts - 1, proposed))
        indices.append(boundary_index)
        previous = boundary_index
    return [beat_ranges[index][0] for index in indices]


def _detail_density_directive(
    request: str, duration: float, picture_count: int, content_language: str, cut_selection: str = "",
) -> tuple[str, int, int]:
    shot_count = _requested_shot_count(request, duration, cut_selection)
    action_beats = _action_beat_ranges(duration, shot_count)
    cut_times = [_format_timestamp(value) for value in _shot_cut_times(duration, shot_count)]
    beat_labels = "、".join(
        f"({_format_beat_seconds(start)}-{_format_beat_seconds(end)}s)"
        for start, end in action_beats
    )
    timeline_rule = (
        "[Shot 1] 不写时间戳。"
        + (
            "后续镜头只能依次使用这些起始时间："
            + "、".join(
                f"[Shot {index + 2}] At {timestamp}"
                for index, timestamp in enumerate(cut_times)
            )
            + "；禁止使用列表以外的时间，禁止超过总时长。"
            if cut_times else
            "这是单镜头，不得添加其他 [Shot N] 或时间戳。"
        )
    )
    if content_language == "English":
        length_rule = (
            f"detailed_description must contain about {35 * len(action_beats)}–"
            f"{50 * len(action_beats)} English words"
        )
        per_shot_rule = "Each action beat must contain 35–50 substantial English words"
    else:
        language_label = {
            "中文": "简体中文", "日本語": "日文", "한국어": "韩文",
        }.get(content_language, "所选语言")
        length_rule = (
            f"detailed_description 必须包含约 {70 * len(action_beats)}–"
            f"{100 * len(action_beats)} 个{language_label}正文字符"
        )
        per_shot_rule = f"每个动作段必须包含约 70–100 个不可互换的{language_label}具体字符"
    picture_rule = (
        f"必须逐一识别并使用 <Picture 1> 到 <Picture {picture_count}>，"
        "每张图对应的主体在 subject_definitions 中单独成行，禁止把多张图合并成一个主体。"
        if picture_count > 0 else
        "没有图片输入时禁止生成任何 <Picture N> 标签。"
    )
    directive = f"""最高优先级内容密度与时间轴规则：
{picture_rule}
这是唯一一次生成机会：必须在本次回答中直接完成全部字段、全部镜头和全部动作段，不得先给摘要、草稿或简版，不得请求后续补充，也不得用"其余类似""持续……"等概括句替代细节。输出前在内部核对数量，但只输出最终成品。
生成恰好 {shot_count} 个镜头。{timeline_rule}
在这些镜头内部再按 1–1.5 秒拆成恰好 {len(action_beats)} 个连续动作段，完整覆盖且不得合并、跳过或重叠：{beat_labels}。
动作段不是新分镜，不增加 [Shot N]；一个分镜允许并应当包含多个连续动作段。每段在所属 [Shot N] 内使用"起始时间–结束时间：具体画面变化"的自然句式，并让前一段的结束状态成为后一段的起始状态。
每个动作段必须以"(起始秒-结束秒s)"开头，例如 (0-1.5s)、(1.5-3s)；禁止把动作段写成 00:00.000–00:01.500。每段只写 1–2 个完整句子并以明确句号结束；中文、日文或韩文单段严禁超过 140 个正文字符，英文单段严禁超过 60 个单词。写完当前动作结果后立刻进入下一时间段。
{length_rule}；{per_shot_rule}，不得提前结束正文。每个镜头都必须同时写清：
1. 景别、构图、前中后景、主体在画面中的左右与纵深位置；
2. 当前可见的参考主体外观、服装材质、发丝或饰物动态以及身份连续性；
3. 动作的起势、运动轨迹、关键接触或姿态变化、表情与肢体反应、重心与朝向变化以及收势结束状态，核心动作必须真正完成；
4. 场景结构、地面与背景、光源方向、明暗变化、空气或粒子以及动作对环境的可见影响；
5. 运镜类型、方向、速度、幅度、焦点或景深变化，以及与上一镜头的连续衔接；
6. 与当前动作逐拍同步的环境声、衣料声、脚步声、碰撞声、呼吸或非语言反应。
所有正文只允许摄像机可见或麦克风可听的内容。禁止人物内心思考、策略制定、价值判断、口号、成语串、同义词堆砌、人生哲理、任务总结、成功宣言或营销文案。禁止只写情绪形容词、对峙、准备动作或剧情概述来代替可观察过程。subject_definitions 需要给出每个参考主体的面部、发型、服装剪裁、材质、配色、饰品与辨识特征；overall_soundscape 要写声音层次、远近和动态变化；non_diegetic_music 要写乐器、速度、节奏及强弱发展。"""
    return directive, shot_count, len(action_beats)


def _detail_fill_skeleton(request: str, duration: float, cut_selection: str = "") -> str:
    """Build the exact timeline shell that the one-pass model must fill, not summarize."""
    shot_count = _requested_shot_count(request, duration, cut_selection)
    beats = _action_beat_ranges(duration, shot_count)
    cut_times = _shot_cut_times(duration, shot_count)
    shot_index = 0
    emitted_shot = -1
    lines: list[str] = []
    for start, end in beats:
        while shot_index < len(cut_times) and start >= cut_times[shot_index] - 0.0005:
            shot_index += 1
        expected_header = "[Shot 1]" if shot_index == 0 else f"[Shot {shot_index + 1}] At {_format_timestamp(cut_times[shot_index - 1])},"
        if emitted_shot != shot_index:
            lines.append(expected_header)
            emitted_shot = shot_index
        lines.append(
            f"({_format_beat_seconds(start)}-{_format_beat_seconds(end)}s) "
            "[填写主体连续动作的起势→轨迹/接触→受力与重心变化→本段明确结果；同时填写构图纵深、"
            "服装发丝动态、环境物理反馈与近中远同步声音；不要填写景别、运镜或时间标签]"
        )
    return "\n".join(lines)


def _trim_runaway_action_text(value: str) -> tuple[str, int]:
    """Trim an abnormally long punctuation-free action clause at a readable boundary."""
    source = str(value or "").strip()
    protected_dialogue: list[tuple[str, str]] = []

    def reserve_dialogue(match: re.Match[str]) -> str:
        marker = f"__GJJ_BEAT_DIALOGUE_{len(protected_dialogue) + 1:04d}__"
        protected_dialogue.append((marker, match.group(0)))
        return marker

    working = re.sub(r"(?is)<d>.*?</d>", reserve_dialogue, source)
    # The outer generation pass may still carry protected user dialogue as a marker.
    # Keep it through runaway-tail trimming and restore it only after final formatting.
    # 兼容模型可能把序号写成 1–4 位数字（如 0001 / 01 / 1），不再限制必须 4 位。
    protected_markers = re.findall(r"__GJJ_DIALOGUE_\d+__", working, flags=re.IGNORECASE)
    compact_length = len(re.sub(r"\s+", "", working))
    if compact_length <= 220:
        return source, 0

    sentence_ends = [
        match.end() for match in re.finditer(r"[。！？.!?；;]", working[:240])
        if match.end() >= 80
    ]
    if sentence_ends:
        cutoff = sentence_ends[-1]
    else:
        clause_ends = [
            match.start() for match in re.finditer(r"[,，]", working[:190])
            if match.start() >= 24
        ]
        cutoff = clause_ends[-1] if clause_ends else min(140, len(working))

    if cutoff >= len(working):
        return source, 0
    trimmed = working[:cutoff].rstrip(" \t\r\n,，;；:：")
    # 匹配任意位数的 BEAT_DIALOGUE 结尾残留，避免严格位数匹配漏删
    trimmed = re.sub(r"__GJJ_BEAT_DIALOGUE_\d+__\s*$", "", trimmed).rstrip()
    trimmed = re.sub(r"__GJJ_DIALOGUE_\d+__\s*$", "", trimmed).rstrip()
    # Dialogue supplied by the user is immutable. If a runaway tail pushed it beyond
    # the cut point, keep it once at the end of the same action beat.
    for marker, _dialogue in protected_dialogue:
        if marker not in trimmed:
            trimmed = f"{trimmed} {marker}".strip()
    for marker, dialogue in protected_dialogue:
        trimmed = trimmed.replace(marker, dialogue)
    for marker in protected_markers:
        if marker not in trimmed:
            trimmed = f"{trimmed} {marker}".strip()
    if trimmed and not re.search(r"(?:[。！？.!?]|</d>)$", trimmed, flags=re.IGNORECASE):
        trimmed += "。"
    removed = max(0, len(source) - len(trimmed))
    return trimmed, removed


def _sanitize_skill_action_beats(prompt: str) -> tuple[str, int]:
    """Remove associative word-chain tails from individual timed action beats."""
    source = str(prompt or "")
    beat_pattern = re.compile(
        r"(?is)((?:\(\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?s\s*\)\s*|"
        r"\d{2}:\d{2}\.\d{3}\s*[–—-]\s*\d{2}:\d{2}\.\d{3}\s*[：:]))"
        r"(.*?)"
        r"(?=(?:\(\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?s\s*\)|"
        r"\d{2}:\d{2}\.\d{3}\s*[–—-]\s*\d{2}:\d{2}\.\d{3}\s*[：:])|"
        r"\[Shot\s+\d+\]|overall_soundscape:|non_diegetic_music:|$)"
    )
    removed_total = 0

    def clean_beat(match: re.Match[str]) -> str:
        nonlocal removed_total
        cleaned, removed = _trim_runaway_action_text(match.group(2))
        removed_total += removed
        return f"{match.group(1)}{cleaned}\n"

    cleaned = beat_pattern.sub(clean_beat, source)
    return cleaned, removed_total


def _normalize_action_beat_time_format(prompt: str) -> str:
    """Convert legacy HH:MM.mmm beat ranges to the requested compact-second form."""
    def replace_range(match: re.Match[str]) -> str:
        start = int(match.group(1)) * 60.0 + float(match.group(2))
        end = int(match.group(3)) * 60.0 + float(match.group(4))
        return f"({_format_beat_seconds(start)}-{_format_beat_seconds(end)}s) "

    return re.sub(
        r"(?<!At\s)(?<!At )\b(\d{2}):(\d{2}\.\d{3})\s*[–—-]\s*"
        r"(\d{2}):(\d{2}\.\d{3})\s*[：:]?\s*",
        replace_range,
        str(prompt or ""),
        flags=re.IGNORECASE,
    )


def _normalize_skill_shot_timeline(prompt: str, duration: float) -> str:
    """Rebuild shot numbering and cut times so every generated timestamp is valid."""
    source = str(prompt or "")
    body_field = (
        "detailed_description:"
        if "detailed_description:" in source
        else "integrated_multimodal_description:"
    )
    start = source.find(body_field)
    if start < 0:
        return source
    body_start = start + len(body_field)
    body_end = source.find("overall_soundscape:", body_start)
    if body_end < 0:
        body_end = len(source)
    body = source[body_start:body_end]
    header_pattern = re.compile(
        r"(?i)\[Shot\s+\d+\](?:\s+At\s+\d{1,4}:\d{2}(?:\.\d{1,3})?\s*[,，]?)?"
    )
    matches = list(header_pattern.finditer(body))
    if not matches:
        return source
    prefix = body[:matches[0].start()].strip()
    descriptions = [
        body[match.end():(matches[index + 1].start() if index + 1 < len(matches) else len(body))].strip()
        for index, match in enumerate(matches)
    ]
    shot_count = len(descriptions)
    cut_times = _shot_cut_times(duration, shot_count)
    rebuilt: list[str] = []
    if prefix:
        rebuilt.append(prefix)
    for index, description in enumerate(descriptions):
        if index == 0:
            header = "[Shot 1]"
        else:
            cut_time = min(
                max(0.0, float(duration)) - 0.001,
                cut_times[index - 1],
            )
            header = f"[Shot {index + 1}] At {_format_timestamp(cut_time)},"
        rebuilt.append(f"{header} {description}".rstrip())
    normalized_body = "\n".join(rebuilt)
    return source[:body_start] + "\n" + normalized_body + "\n\n" + source[body_end:].lstrip()


def _enforce_selected_shot_count(
    prompt: str, duration: float, cut_selection: str, source_request: str,
) -> str:
    """Make XB-style cut selection authoritative even when the local model ignores it."""
    selection = str(cut_selection or "")
    if "不指定" in selection or "Unspecified" in selection or not selection:
        return _normalize_skill_shot_timeline(prompt, duration)
    shot_count = _requested_shot_count(source_request, duration, selection)
    source = str(prompt or "")
    body_field = "detailed_description:" if "detailed_description:" in source else "integrated_multimodal_description:"
    field_start = source.find(body_field)
    if field_start < 0:
        return source
    body_start = field_start + len(body_field)
    body_end = source.find("overall_soundscape:", body_start)
    if body_end < 0:
        body_end = len(source)
    body = source[body_start:body_end].strip()
    body = re.sub(
        r"(?i)\[Shot\s+\d+\](?:\s+At\s+\d{1,4}:\d{2}(?:\.\d{1,3})?\s*[,，]?)?\s*",
        "",
        body,
    ).strip()
    beat_pattern = re.compile(r"(?=\(\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?s\s*\))")
    beat_parts = [part.strip() for part in beat_pattern.split(body) if part.strip()]
    timed_parts = [part for part in beat_parts if re.match(r"^\(\s*\d+(?:\.\d+)?\s*-", part)]
    prefix = " ".join(part for part in beat_parts if part not in timed_parts).strip()
    cut_times = _shot_cut_times(duration, shot_count)
    groups: list[list[str]] = [[] for _ in range(shot_count)]
    for part in timed_parts:
        start_match = re.match(r"^\(\s*(\d+(?:\.\d+)?)\s*-", part)
        start = float(start_match.group(1)) if start_match else 0.0
        index = sum(1 for cut in cut_times if start >= cut - 0.0005)
        groups[min(shot_count - 1, index)].append(part)
    if not timed_parts:
        sentences = [item.strip() for item in re.split(r"(?<=[。！？.!?])\s*", body) if item.strip()]
        for index, sentence in enumerate(sentences):
            groups[min(shot_count - 1, index * shot_count // max(1, len(sentences)))].append(sentence)
    rebuilt: list[str] = []
    for index in range(shot_count):
        header = "[Shot 1]" if index == 0 else f"[Shot {index + 1}] At {_format_timestamp(cut_times[index - 1])},"
        content = " ".join(groups[index]).strip()
        if index == 0 and prefix:
            content = f"{prefix} {content}".strip()
        if not content:
            phase = (
                "建立动作与空间关系。"
                if index == 0 else
                ("切换镜头，采用新的景别或机位，承接上一镜头的结束状态完成动作并收束至最终状态。"
                 if index + 1 == shot_count else
                 "切换镜头，采用新的景别或机位，承接上一镜头的结束状态继续推进动作。")
            )
            content = phase
        rebuilt.append(f"{header} {content}")
    return source[:body_start] + "\n" + "\n".join(rebuilt) + "\n\n" + source[body_end:].lstrip()


def _dedupe_action_timeline_labels(prompt: str) -> str:
    """Keep each parenthesized action interval exactly once in the H3 body."""
    source = str(prompt or "")
    body_field = "detailed_description:" if "detailed_description:" in source else "integrated_multimodal_description:"
    field_start = source.find(body_field)
    if field_start < 0:
        return source
    body_start = field_start + len(body_field)
    body_end = source.find("overall_soundscape:", body_start)
    if body_end < 0:
        body_end = len(source)
    body = source[body_start:body_end]
    seen: set[tuple[str, str]] = set()

    def replace_label(match: re.Match[str]) -> str:
        start = _format_beat_seconds(float(match.group(1)))
        end = _format_beat_seconds(float(match.group(2)))
        key = (start, end)
        if key in seen:
            return ""
        seen.add(key)
        return f"({start}-{end}s)"

    body = re.sub(
        r"\(\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)s\s*\)",
        replace_label,
        body,
        flags=re.IGNORECASE,
    )
    body = re.sub(r"(?m)(\[Shot\s+\d+\][^\n]*?,)\s{2,}", r"\1 ", body)
    body = re.sub(r"[ \t]{2,}", " ", body)
    return source[:body_start] + body + source[body_end:]


def _force_distinct_shot_camera(prompt: str, content_language: str = "中文") -> str:
    """Assign every shot a distinct scale and camera move after labels are finalized."""
    chinese_plans = [
        "大全景建立空间，缓慢前推并保持主体与环境关系清晰",
        "中全景呈现完整肢体动作，横向跟拍主体运动轨迹",
        "中景突出主体动作与环境互动，沿主体外侧小幅弧形环绕",
        "近景捕捉面部与上肢反应，手持式短距离跟随",
        "低机位全身景强化姿态变化，快速轨道推进后减速",
        "高机位广角揭示空间变化，摇臂下降并向场景主体靠近",
        "过肩中景建立人物关系轴线，平稳摇摄跟随动作转移",
        "特写强调接触与细节，微距推近并执行焦点转移",
        "侧面全景展示位移距离，反向移动跟拍保持速度差",
        "超大全景完成空间收束，摇臂升高并缓慢后拉",
    ]
    english_plans = [
        "extreme wide establishing view, slow push-in preserving clear subject-to-environment geography",
        "medium-wide full-body view, lateral tracking along the subject's motion path",
        "medium view of subject action and environmental interaction, a small orbital move around the subject",
        "close view of facial and upper-body reactions, short handheld follow movement",
        "low-angle full-body view, fast dolly-in that decelerates at the action result",
        "high-angle wide view, crane down toward the main scene subject",
        "over-the-shoulder medium view preserving the character axis, smooth pan following the transfer of action",
        "detail close-up of contact and texture, macro push-in with a rack focus",
        "side-on full view showing travel distance, reverse tracking that preserves speed contrast",
        "extreme wide closing view, crane up with a slow pull-back",
    ]
    plans = english_plans if content_language == "English" else chinese_plans
    source = str(prompt or "")
    body_field = "detailed_description:" if "detailed_description:" in source else "integrated_multimodal_description:"
    body_start = source.find(body_field)
    if body_start < 0:
        return source
    body_start += len(body_field)
    body_end = source.find("overall_soundscape:", body_start)
    if body_end < 0:
        body_end = len(source)
    body = source[body_start:body_end]

    def add_plan(match: re.Match[str]) -> str:
        number = max(1, int(match.group(1)))
        plan = plans[(number - 1) % len(plans)]
        label = "Shot design" if content_language == "English" else "镜头设计"
        return f"{match.group(0)} {label}：{plan}。"

    body = re.sub(
        r"(?i)\[Shot\s+(\d+)\](?:\s+At\s+\d{1,4}:\d{2}(?:\.\d{1,3})?\s*[,，]?)?",
        add_plan,
        body,
    )
    return source[:body_start] + body + source[body_end:]


def _force_music_style(prompt: str, music_style: str, content_language: str = "中文") -> str:
    """Write the selected XB background-music preset into the final H3 music field."""
    selection = str(music_style or "")
    if not selection or "不指定" in selection or "Unspecified" in selection:
        return str(prompt or "")
    hint = XB_MUSIC_HINTS.get(selection, "")
    english_name, _, chinese_name = selection.partition(" / ")
    value = (
        f"{english_name}: {hint}; tempo, rhythm and dynamics follow the shot action and resolve clearly at the end."
        if content_language == "English" else
        f"{chinese_name or english_name}（{english_name}）：{hint}。速度、节奏与强弱随镜头动作发展，并在结尾明确收束。"
    )
    source = str(prompt or "")
    match = re.search(r"(?im)^non_diegetic_music:\s*", source)
    if match:
        return source[:match.end()] + "\n" + value
    return source.rstrip() + "\n\nnon_diegetic_music:\n" + value


def _force_visual_style(prompt: str, visual_style: str, content_language: str = "中文") -> str:
    """Declare the selected XB style once as a global rule before the timeline."""
    selection = str(visual_style or "")
    if not selection or "不指定" in selection or "Unspecified" in selection:
        return str(prompt or "")
    source = str(prompt or "")
    hint = XB_VISUAL_STYLE_HINTS.get(selection, "")
    english_name, _, chinese_name = selection.partition(" / ")
    descriptor = (
        f"Overall visual style: {english_name} — {hint}. This single style applies unchanged to the entire video and every shot: keep identical rendering, material response, linework or photographic texture, lighting logic, palette and motion character, while preserving every referenced character's exact identity, clothing and accessories."
        if content_language == "English" else
        f"整体风格：{chinese_name or english_name}（{english_name}）— {hint}。此风格统一作用于整段视频及全部分镜，渲染方式、材质反应、线条或摄影质感、光影逻辑、色彩体系与运动特征始终一致，同时保持参考人物的身份、服装和饰品不变。"
    )
    body_match = re.search(r"(?im)^(?:detailed_description|integrated_multimodal_description):\s*", source)
    if not body_match:
        return source
    body_start = body_match.end()
    body_end = source.find("overall_soundscape:", body_start)
    if body_end < 0:
        body_end = len(source)
    body = source[body_start:body_end].lstrip()
    body = descriptor + "\n" + body
    return source[:body_start] + body + source[body_end:]


def _sanitize_supporting_fields(prompt: str, content_language: str = "中文") -> str:
    """Bound non-visual H3 fields and discard local-model runaway prose."""
    source = str(prompt or "")
    fallback_sound = (
        "Near-field cloth, footsteps, impacts and breathing track the visible action; mid-field vegetation and surface reflections respond to movement; distant wind and environmental ambience remain spatially stable, with dynamics rising at contact and settling at the end."
        if content_language == "English" else
        "近景衣料、脚步、碰撞与呼吸声逐拍对应可见动作；中景植被摩擦和地面反馈随运动变化；远景风声与环境底噪保持稳定空间层次，接触时增强，结尾随动作收束。"
    )

    def sanitize_field(text: str, field: str, next_field: str | None, hard_limit: int, fallback: str) -> str:
        match = re.search(rf"(?im)^{re.escape(field)}\s*", text)
        if not match:
            return text
        end_match = re.search(rf"(?im)^{re.escape(next_field)}\s*", text[match.end():]) if next_field else None
        value_end = match.end() + end_match.start() if end_match else len(text)
        value = text[match.end():value_end].strip()
        compact = re.sub(r"\s+", "", value)
        nested_field = re.search(
            r"(?im)^(?:subject_definitions|summary|retention_analysis|detailed_description|"
            r"integrated_multimodal_description|overall_soundscape|non_diegetic_music):",
            value,
        )
        runaway = len(compact) > hard_limit or nested_field is not None
        if len(compact) > 260 and not re.search(r"[。！？.!?；;]", value):
            runaway = True
        cleaned = fallback if runaway else value
        return text[:match.end()] + "\n" + cleaned + "\n\n" + text[value_end:].lstrip()

    source = sanitize_field(
        source, "overall_soundscape:", "non_diegetic_music:", 600, fallback_sound,
    )
    source = sanitize_field(
        source, "non_diegetic_music:", None, 500, "N/A",
    )
    return source.strip()


def _skill_detail_metrics(prompt: str, content_language: str) -> dict[str, int]:
    """Measure whether the model actually supplied the requested timed detail."""
    body_match = re.search(
        r"(?is)(?:detailed_description|integrated_multimodal_description):\s*(.*?)"
        r"(?=\boverall_soundscape:|$)",
        str(prompt or ""),
    )
    body = body_match.group(1).strip() if body_match else ""
    timed_beats = re.findall(
        r"(?:\(\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?s\s*\)|"
        r"\d{2}:\d{2}\.\d{3}\s*[–—-]\s*\d{2}:\d{2}\.\d{3}\s*[：:])",
        body,
    )
    return {
        "shots": len(re.findall(r"(?i)\[Shot\s+\d+\]", body)),
        "beats": len(timed_beats),
        "characters": len(re.sub(r"\s+", "", body)),
        "words": len(re.findall(r"\b[\w'-]+\b", body)) if content_language == "English" else 0,
    }


def _structured_segment_prompt(
    payload: dict[str, Any], mode: str, duration: float, shot_count: int, beat_count: int,
    source_request: str, user_wants_dialogue: bool = False, dialogue_language: str = "中文",
) -> str | None:
    """Attach all H3 shot/time labels to model-authored continuous action segments."""
    raw_segments = payload.get("action_segments") or payload.get("segments")
    if not isinstance(raw_segments, list):
        return None
    segments: list[str] = []
    _dialogue_in_segments = 0
    for item in raw_segments:
        value = item.get("action") or item.get("text") if isinstance(item, dict) else item
        # 提高单段上限到 1200，避免截断带对白的长段
        cleaned = _clean_generated_value(value, 1200).strip()
        cleaned = re.sub(
            r"(?i)\[Shot\s+\d+\](?:\s+At\s+[^,，\n]+[,，]?)?|"
            r"\(\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?s\s*\)",
            "",
            cleaned,
        ).strip()
        if cleaned:
            if re.search(r"(?is)<d>\s*.*?\s*</d>", cleaned) or re.search(r'"[^"]{2,80}"', cleaned):
                _dialogue_in_segments += 1
            segments.append(cleaned)
    target = max(1, int(beat_count))
    if not segments:
        return None
    # 日志：检查解析后的 segments 是否有对白
    if _dialogue_in_segments == 0:
        print(
            f"[GJJ_MiniMaxH3SkillStudio] ⚠️ action_segments 解析后无对白段落："
            f"共 {len(segments)} 段，含对白 0 段。",
            flush=True,
        )
    else:
        print(
            f"[GJJ_MiniMaxH3SkillStudio] action_segments 解析：共 {len(segments)} 段，"
            f"含对白 {_dialogue_in_segments} 段。",
            flush=True,
        )
    if len(segments) > target:
        groups = [[] for _ in range(target)]
        for index, value in enumerate(segments):
            groups[min(target - 1, index * target // len(segments))].append(value)
        segments = [" ".join(group) for group in groups]
    while len(segments) < target:
        index = len(segments)
        if user_wants_dialogue:
            lang = dialogue_language if dialogue_language else "中文"
            # 仅首个 fallback 段加完整对白，后续段保持通用
            if index == 0:
                dialogue_fallback = f'角色看向对方：<d>[{lang}]我们必须尽快行动。</d>另一角色点头：<d>[{lang}]明白，现在出发。</d>'
                segments.append(
                    f"承接上一动作段的准确结束姿态，完成下一步可见动作、姿态变化和镜头响应，环境与同步声随结果变化。{dialogue_fallback}"
                    if index + 1 < target else
                    f"承接上一动作段的准确结束姿态，完成最终动作并稳定收势，镜头与环境声同步收束。{dialogue_fallback}"
                )
            else:
                segments.append(
                    "承接上一动作段的准确结束姿态，完成下一步可见动作、姿态变化和镜头响应，环境与同步声随结果变化。"
                    if index + 1 < target else
                    "承接上一动作段的准确结束姿态，完成最终动作并稳定收势，镜头与环境声同步收束。"
                )
        else:
            segments.append(
                "承接上一动作段的准确结束姿态，完成下一步可见动作、姿态变化和镜头响应，环境与同步声随结果变化。"
                if index + 1 < target else
                "承接上一动作段的准确结束姿态，完成最终动作并稳定收势，镜头与环境声同步收束。"
            )
    # 按台词权重动态分配时间：台词多的段落分到更多时间，避免台词说不完
    beats = _weighted_beat_ranges(duration, segments)[:target]
    # 有效镜头数 = min(shot_count, beats 数)，避免出现空 Shot
    effective_shot_count = min(shot_count, len(beats))
    # 日志：输出加权后的时间分配，便于调试
    _has_any_dialogue = any(_estimate_dialogue_duration(seg) > 0 for seg in segments)
    if _has_any_dialogue:
        _beat_summary = ", ".join(
            f"({start:.2f}-{end:.2f}s,台词{ _estimate_dialogue_duration(seg):.2f}s)"
            for (start, end), seg in zip(beats, segments)
        )
        print(f"[GJJ_MiniMaxH3SkillStudio] 加权时间分配：{_beat_summary}", flush=True)
    # 把 beats 均分到 effective_shot_count 个镜头，每个镜头含 1 个或多个 beat
    # 第一个 beat 归 Shot 1，后续按 beat 索引均分到各 shot
    beat_count = len(beats)
    if effective_shot_count <= 1:
        shot_of_beat = [0] * beat_count
    else:
        shot_of_beat = []
        for beat_index in range(beat_count):
            # beat_index 属于哪个 shot：按 beat 数均分
            shot_index = min(effective_shot_count - 1, beat_index * effective_shot_count // beat_count)
            shot_of_beat.append(shot_index)
    lines: list[str] = []
    previous_shot = -1
    for index, ((start, end), action) in enumerate(zip(beats, segments)):
        shot_index = shot_of_beat[index]
        if shot_index != previous_shot:
            if shot_index == 0:
                header = "[Shot 1]"
            else:
                # Shot 头部时间戳 = 该 shot 第一个 beat 的 start（加权后的真实时间）
                header = f"[Shot {shot_index + 1}] At {_format_timestamp(start)},"
            lines.append(header)
            previous_shot = shot_index
        transition = "切换镜头，" if shot_index > 0 and lines[-1].startswith("[Shot") else ""
        lines.append(f"({_format_beat_seconds(start)}-{_format_beat_seconds(end)}s) {transition}{action}")
    body = "\n".join(lines)

    def list_text(key: str, fallback: str) -> str:
        value = payload.get(key)
        if isinstance(value, list):
            cleaned = [_clean_generated_value(item, 900) for item in value if str(item or "").strip()]
            return "\n".join(cleaned) or fallback
        return _clean_generated_value(value, 2400) or fallback

    sound = _clean_generated_value(payload.get("overall_soundscape"), 700) or "自然环境声与动作声随画面同步变化，不重复对白。"
    music = _clean_generated_value(payload.get("non_diegetic_music"), 500) or "N/A"
    if mode == "R2VA":
        definitions = list_text("subject_definitions", "N/A")
        summary = _clean_generated_value(payload.get("summary"), 400) or "[reference generation]"
        retention = list_text("retention_analysis", "N/A")
        return (
            f"subject_definitions:\n{definitions}\n\nsummary:\n{summary}\n\n"
            f"retention_analysis:\n{retention}\n\ndetailed_description:\n{body}\n\n"
            f"overall_soundscape:\n{sound}\n\nnon_diegetic_music:\n{music}"
        )
    return (
        f"integrated_multimodal_description:\n{body}\n\n"
        f"overall_soundscape:\n{sound}\n\nnon_diegetic_music:\n{music}"
    )


def _safe_shots(value: Any, duration: float) -> list[dict[str, Any]]:
    source = value if isinstance(value, list) else []
    shots: list[dict[str, Any]] = []
    for index, item in enumerate(source[:8]):
        if not isinstance(item, dict):
            continue
        start = max(0.0, float(item.get("start") or 0.0))
        end = min(float(duration), max(start, float(item.get("end") or duration)))
        shots.append({
            "shot": index + 1, "start": round(start, 3), "end": round(end, 3),
            "visual": _clean_generated_value(item.get("visual"), 800),
            "camera": _clean_generated_value(item.get("camera"), 300),
            "audio": _clean_generated_value(item.get("audio"), 300),
            "handoff": _clean_generated_value(item.get("handoff"), 300),
        })
    if not shots:
        shots = [{"shot": 1, "start": 0.0, "end": round(float(duration), 3), "visual": "The requested action unfolds as one continuous observable process.", "camera": "A stable cinematic shot follows the action.", "audio": "Synchronized environmental and physical action sounds.", "handoff": "The action resolves in the final frame."}]
    return shots


def _build_fixed_h3_prompt(mode: str, duration: float, media_present: bool, package: str, shots: list[dict[str, Any]]) -> str:
    selected_mode = str(mode or "自动")
    if selected_mode == "自动":
        selected_mode = "Ref2VA" if media_present else "T2VA"
    shot_lines = []
    for index, shot in enumerate(shots):
        start_seconds = float(shot["start"])
        minutes = int(start_seconds // 60)
        remainder = start_seconds - minutes * 60
        timestamp = "" if index == 0 else f" At {minutes:02d}:{remainder:06.3f},"
        shot_lines.append(
            f"[Shot {index + 1}]{timestamp} {shot['visual']} {shot['camera']} {shot['audio']} {shot['handoff']}"
        )
    body = " ".join(shot_lines)
    sound = "Environmental ambience and synchronized physical action sounds follow the visible events without repeating dialogue."
    music = "N/A"
    if selected_mode == "Ref2VA":
        definition = "<Picture 1> is the connected visual reference used for subject appearance and scene guidance." if media_present else "N/A"
        retention = "<Picture 1>: fully_preserved - its visible identity and scene traits are retained." if media_present else "N/A"
        return (
            f"subject_definitions:\n{definition}\n\nsummary:\n[reference generation] The target video follows the user request and connected reference.\n\n"
            f"retention_analysis:\n{retention}\n\ndetailed_description:\n{body}\n\noverall_soundscape:\n{sound}\n\nnon_diegetic_music:\n{music}"
        )
    alignment = ""
    seconds = f"{float(duration):.2f}"
    if selected_mode == "I2VA": alignment = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n"
    elif selected_mode == "FL2VA": alignment = f"How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot {len(shots)}) aligns with the {seconds}-second mark of the target video.\n\n"
    elif selected_mode == "L2VA": alignment = f"How the reference pictures align with the target video — <Picture 1> (from [Shot {len(shots)}]) aligns with the {seconds}-second mark of the target video.\n\n"
    return f"{alignment}integrated_multimodal_description: {body}\n\noverall_soundscape: {sound}\n\nnon_diegetic_music: {music}"


def _fallback_sections(text: str, request: str, mode: str, duration: float, media_present: bool) -> tuple[str, str, str, str]:
    shots = _safe_shots([], duration)
    package = (
        "# Production brief\n\n"
        f"- Request: {str(request or '').strip()}\n"
        f"- Duration: {float(duration):.3f} seconds\n"
        f"- H3 mode: {str(mode or '自动')}\n"
        f"- Reference media: {'connected' if media_present else 'none'}\n\n"
        "The creative-model response was incomplete, so unsafe partial content was discarded and a clean fallback prompt was generated."
    )
    h3_prompt = _build_fixed_h3_prompt(mode, duration, media_present, package, shots)
    return package, h3_prompt, "low quality, blurry, malformed anatomy, duplicated subjects, watermark, unreadable text", json.dumps(shots, ensure_ascii=False, indent=2)


class GJJ_MiniMaxH3SkillStudio:
    CATEGORY = "GJJ/💗 一键生成"
    FUNCTION = "compile"
    # GJJ_MultiImageLoader exposes its queue with OUTPUT_IS_LIST=True. Receive
    # that queue once; otherwise ComfyUI maps this node once per picture.
    INPUT_IS_LIST = True
    OUTPUT_NODE = True
    _RESULT_CACHE: dict[str, tuple[str, tuple[str]]] = {}
    DESCRIPTION = "将 MiniMax-H3 官方结构与 8 套风格视频技能集中为一个零依赖节点，只输出一份可直接使用的高质量 H3 正面提示词。"
    SEARCH_ALIASES = ["MiniMax H3 Skills", "H3 全技能", "H3 制作包", "零依赖单节点"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("正面提示词",)

    @classmethod
    def INPUT_TYPES(cls):
        model_options = _qwen35_model_options()
        return {
            "required": {
                "需求": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True}),
                "技能模式": (list(SKILL_PROFILES), {"default": "自动识别", "display": "hidden", "hidden": True}),
                "交付内容": (list(DELIVERABLE_RULES), {"default": "仅 H3 最终提示词", "display": "hidden", "hidden": True}),
                "H3模式": (list(H3_MODE_RULES), {"default": "自动", "display": "hidden", "hidden": True}),
                "时长": ("FLOAT", {"default": 15.0, "min": 5.0, "max": 15.0, "step": 0.5, "display": "hidden", "hidden": True}),
                "画面比例": (["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "跟随参考媒体"], {"default": "16:9", "display": "hidden", "hidden": True}),
                "内容语言": (["自动", "中文", "English", "日本語", "한국어"], {"default": "自动", "display": "hidden", "hidden": True}),
                "启用媒体反推": ("BOOLEAN", {"default": True, "display": "hidden", "hidden": True}),
                "保留模型": ("BOOLEAN", {"default": False, "display": "hidden", "hidden": True}),
                "反推模型": (model_options, {
                    "default": DEFAULT_MODEL,
                    "display": "hidden",
                    "hidden": True,
                    "tooltip": "仅列出已安装的 Qwen 3.5 系列文本编码器。",
                    "gjj_model_label": "反推模型",
                    "gjj_model_folder": "models/text_encoders",
                    "gjj_model_icon": "🧠",
                    "gjj_default_model": DEFAULT_MODEL,
                    "gjj_default_missing": _qwen35_default_missing(),
                }),
                "反推最大Token": ("INT", {"default": 6144, "min": 256, "max": 8192, "step": 128, "display": "hidden", "hidden": True}),
                "反推采样": ("BOOLEAN", {"default": True, "display": "hidden", "hidden": True}),
                "反推温度": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 2.0, "step": 0.05, "display": "hidden", "hidden": True}),
                "反推TopP": ("FLOAT", {"default": 0.95, "min": 0.0, "max": 1.0, "step": 0.01, "display": "hidden", "hidden": True}),
                "反推重复惩罚": ("FLOAT", {"default": 1.20, "min": 0.0, "max": 5.0, "step": 0.05, "display": "hidden", "hidden": True}),
                "角色库选择": ("STRING", {"default": "[]", "display": "hidden", "hidden": True, "tooltip": "由 👤 角色库与 @ 候选自动维护。"}),
                "场景库选择": ("STRING", {"default": "[]", "display": "hidden", "hidden": True, "tooltip": "由 🏕️ 场景库自动维护。"}),
                "视觉风格": (XB_VISUAL_STYLES, {"default": "不指定 / Unspecified", "display": "hidden", "hidden": True}),
                "音乐风格": (XB_MUSIC_STYLES, {"default": "不指定 / Unspecified", "display": "hidden", "hidden": True}),
                "切镜次数": (XB_CUT_OPTIONS, {"default": "不指定 / Unspecified", "display": "hidden", "hidden": True}),
            },
            "optional": {
                "参考媒体": (MEDIA_TYPE, {"tooltip": "可接图片、视频或音频；启用媒体反推时由固定 Qwen3.5 模型理解。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def compile(
        self, 需求: str, 技能模式: str, 交付内容: str, H3模式: str, 时长: float,
        画面比例: str, 内容语言: str, 启用媒体反推: bool, 保留模型: bool, 反推模型: str,
        反推最大Token: int, 反推采样: bool, 反推温度: float, 反推TopP: float, 反推重复惩罚: float,
        角色库选择: str = "[]", 场景库选择: str = "[]",
        视觉风格: str = "不指定 / Unspecified", 音乐风格: str = "不指定 / Unspecified",
        切镜次数: str = "不指定 / Unspecified",
        参考媒体: Any = None, unique_id: Any = None,
    ):
        需求 = str(_first_list_input(需求, "") or "")
        技能模式 = str(_first_list_input(技能模式, "自动识别") or "自动识别")
        交付内容 = str(_first_list_input(交付内容, "仅 H3 最终提示词") or "仅 H3 最终提示词")
        H3模式 = str(_first_list_input(H3模式, "自动") or "自动")
        时长 = max(5.0, min(15.0, float(_first_list_input(时长, 15.0))))
        画面比例 = str(_first_list_input(画面比例, "16:9") or "16:9")
        内容语言 = str(_first_list_input(内容语言, "自动") or "自动")
        启用媒体反推 = bool(_first_list_input(启用媒体反推, True))
        保留模型 = bool(_first_list_input(保留模型, False))
        反推模型 = str(_first_list_input(反推模型, DEFAULT_MODEL) or DEFAULT_MODEL)
        反推最大Token = int(_first_list_input(反推最大Token, 6144))
        反推采样 = bool(_first_list_input(反推采样, True))
        反推温度 = float(_first_list_input(反推温度, 0.35))
        反推TopP = float(_first_list_input(反推TopP, 0.95))
        反推重复惩罚 = float(_first_list_input(反推重复惩罚, 1.20))
        角色库选择 = str(_first_list_input(角色库选择, "[]") or "[]")
        场景库选择 = str(_first_list_input(场景库选择, "[]") or "[]")
        视觉风格 = str(_first_list_input(视觉风格, "不指定 / Unspecified") or "不指定 / Unspecified")
        音乐风格 = str(_first_list_input(音乐风格, "不指定 / Unspecified") or "不指定 / Unspecified")
        切镜次数 = str(_first_list_input(切镜次数, "不指定 / Unspecified") or "不指定 / Unspecified")
        actor_records = _library_selection_records(角色库选择)
        scene_records = _library_selection_records(场景库选择)
        selected_actors = [item["name"] for item in actor_records]
        selected_scenes = [item["name"] for item in scene_records]
        required_scenes = list(dict.fromkeys(selected_scenes + _request_scene_references(需求)))
        参考媒体 = _normalize_list_media(参考媒体)
        unique_id = _first_list_input(unique_id)

        profile = SKILL_PROMPT_GUIDANCE.get(str(技能模式), SKILL_PROMPT_GUIDANCE["自动识别"])
        media_enabled = bool(启用媒体反推) and 参考媒体 is not None
        picture_count, video_count, audio_count = _media_inventory(参考媒体, media_enabled)
        reasoning_media = _prepare_reasoning_media(参考媒体) if media_enabled else None
        if picture_count:
            packed_count = int(reasoning_media.shape[0]) if hasattr(reasoning_media, "shape") else 0
            print(
                f"[GJJ_MiniMaxH3SkillStudio] 多图媒体已整批接收："
                f"识别 {picture_count} 张，送入模型 {packed_count} 张。",
                flush=True,
            )
        official_mode = "R2VA" if required_scenes else _official_mode(H3模式, media_enabled)
        content_language, dialogue_language = _resolved_content_language(内容语言, str(需求 or ""))
        localized_base_prompt, localized_mode_rules = _localized_official_prompts(
            official_mode, float(时长), picture_count, content_language, dialogue_language,
        )
        density_directive, target_shot_count, target_action_beat_count = _detail_density_directive(
            str(需求 or ""), float(时长), picture_count, content_language, 切镜次数,
        )
        detail_skeleton = _detail_fill_skeleton(str(需求 or ""), float(时长), 切镜次数)
        visual_style_hint = XB_VISUAL_STYLE_HINTS.get(视觉风格, "")
        music_hint = XB_MUSIC_HINTS.get(音乐风格, "")
        mode_rule = H3_MODE_RULES.get(str(H3模式), H3_MODE_RULES["自动"])
        media_note = (
            "Connected media is authoritative. Analyze its visible/audible content and reference roles before writing."
            if media_enabled
            else "Do not infer any unseen media content. Work only from the user's text."
        )
        actor_notes = {item["name"]: item["notes"] for item in actor_records}
        scene_notes = {item["name"]: item["notes"] for item in scene_records}
        reference_inventory = "\n".join(
            [
                f"- character: @{name}; immutable library description: {actor_notes.get(name) or 'follow the connected reference image exactly'}"
                for name in selected_actors
            ]
            + [
                f"- scene: 🏕️{name}; immutable library description: {scene_notes.get(name) or 'follow the selected scene reference exactly'}"
                for name in required_scenes
            ]
        ) or "- use only references visible in the connected media"
        protected_request, protected_dialogue = _protect_reasoning_dialogue(str(需求 or ""))
        # 检测用户是否主动要求生成对白/台词（但未提供具体文本）
        raw_request = str(需求 or "")
        user_wants_dialogue = bool(
            re.search(r"(?:带|有|加|要|需|写|做|生成|加入|插入|含|包括).{0,6}(?:台词|对白|对话|说话|讲话|旁白|口播|独白|对谈)", raw_request)
            or re.search(r"(?:台词|对白|对话|说话|讲话|旁白|口播|独白|对谈).{0,6}(?:带|有|加|要|需|写|做|生成|加入|插入|含|包括)", raw_request)
        )
        has_specific_dialogue = bool(protected_dialogue)
        # —— 台词要求：同时放在指令顶部和底部，因为小模型对首尾关注度最高 ——
        dialogue_headline = ""
        dialogue_detail = ""
        if user_wants_dialogue and not has_specific_dialogue:
            dialogue_headline = f"""
★★★ CRITICAL: This video MUST contain spoken dialogue/voice. Every shot group must have at least one character speaking. Use format <d>[{dialogue_language}]spoken text</d> in action_segments. No exceptions. ★★★
"""
            dialogue_detail = f"""
CRITICAL DIALOGUE RULE — READ THIS LAST AND APPLY IT: The user explicitly requested dialogue/voice but provided no exact lines. You MUST invent natural dialogue in {dialogue_language}. Every action_segments item MUST contain at least one line of spoken dialogue using the official H3 format <d>[{dialogue_language}]exact spoken text</d>. Example: <d>[{dialogue_language}]你好，很高兴见到你</d>. Spread dialogue evenly across the video. Every character must speak at least once. If a shot has two characters, have them converse briefly. Dialogue must be natural, short (3-15 words), and integrated into the action flow.
"""
        elif has_specific_dialogue:
            dialogue_headline = ""
            dialogue_detail = """Dialogue placeholder rule: every __GJJ_DIALOGUE_####__ token is immutable user dialogue. Keep it exactly once in the matching spoken-action position inside action_segments; it will be converted to the official <d>[Language] exact dialogue</d> tag after generation. Never translate, paraphrase, move into overall_soundscape, or delete it.
"""
        instruction = f"""{dialogue_headline}
Creative treatment: {技能模式}. {profile}
Apply this treatment only inside the official H3 fields. Do not output a project brief, cards, tables, plans, alternatives or analysis.
H3 mode: {official_mode}. {mode_rule}
Exact target duration: {float(时长):.3f} seconds
Aspect ratio: {画面比例}
Content language: {内容语言}
Visual style selection: {视觉风格}. XB preset detail: {visual_style_hint or 'none'}. This is one global visual style for the entire video. If specified, Shot 1 establishes its material, linework or photographic rendering, lighting, palette and motion character; every later shot must inherit the identical style without transition while reference identity and wardrobe remain unchanged.
Music style selection: {音乐风格}. XB preset detail: {music_hint or 'none'}. If specified, non_diegetic_music must realize this exact selection with concrete instrumentation, tempo, rhythm and dynamic development; it is forbidden to output N/A.
Cut selection: {切镜次数}. This overrides any inferred shot count. Follow the mandatory skeleton exactly; Single Shot means only [Shot 1].
All descriptive prose inside the official fields must use {content_language}.
Media rule: {media_note}
Scene reference rule: every supplied 🏕️ scene reference is a Ref2VA subject. Add each one as a separate line in subject_definitions, describing its spatial layout, terrain or architecture, materials, palette, lighting and distinctive environmental landmarks; then use the same 🏕️ name verbatim in the final detailed_description. Never merge a scene reference into a character definition.
Subject definition rule: every @ character and every 🏕️ scene must occupy its own line in subject_definitions. Character lines must separately cover face, hair, physique, garment cut and layers, materials, palette, accessories and identity marks. Scene lines must separately cover foreground/midground/background layout, terrain or architecture, surface materials, palette, key/fill light, atmosphere and fixed landmarks. Never join two subjects with punctuation on one line.
Wardrobe identity lock: a character's connected reference image and immutable library description are the only sources for clothing, footwear, jewelry, armor and accessories. Story roles, martial-arts schools and combat styles such as 少林派 or 武当派 affect choreography only. They must never add, remove or replace garments or accessories. Do not invent 道袍、护腕、僧袍、门派制服 or themed costume unless that exact item is visibly present in the reference or explicitly requested by the user.

Required reference inventory:
{reference_inventory}

User request:
{protected_request.strip()}
{dialogue_detail}
MANDATORY ACTION PLAN FOR JSON action_segments:
Return exactly {target_action_beat_count} action_segments. Use the following shot/time plan only to understand duration and continuity; do not copy its [Shot] headers, time labels or bracket placeholders into segment text because the formatter adds them. Write one array item for every placeholder in this exact order. Each item must follow the user's requested story tone—only use combat if the user explicitly requested fighting. Every action item must advance from the previous item's exact end state.
{detail_skeleton}"""
        # The exact skeleton is already in the final user instruction. Keeping the
        # system contract compact prevents small local models from echoing manuals
        # or confusing one H3 field with another.
        official_system_prompt = _compact_generation_system(official_mode, content_language)
        cache_slot = str(unique_id or "default")
        cache_payload = (
            official_system_prompt, instruction, str(反推模型 or DEFAULT_MODEL), bool(启用媒体反推), bool(保留模型),
            int(反推最大Token), bool(反推采样), float(反推温度), float(反推TopP), float(反推重复惩罚),
            tuple((item["name"], item["notes"]) for item in actor_records),
            tuple((item["name"], item["notes"]) for item in scene_records),
            视觉风格, 音乐风格, 切镜次数,
            _media_runtime_signature(参考媒体 if bool(启用媒体反推) else None),
            bool(user_wants_dialogue), bool(has_specific_dialogue),
        )
        cache_signature = hashlib.sha256(repr(cache_payload).encode("utf-8")).hexdigest()
        cached = self._RESULT_CACHE.get(cache_slot)
        if cached and cached[0] == cache_signature:
            print("[GJJ_MiniMaxH3SkillStudio] 输入未变化，复用上次提示词结果。", flush=True)
            return {"ui": {"text": [cached[1][0]]}, "result": cached[1]}
        generated = GJJ_GemmaTextGenerate().generate(
            clip_name=str(反推模型 or DEFAULT_MODEL),
            clip_type="stable_diffusion",
            clip_device="default",
            prompt=instruction,
            max_length=int(反推最大Token),
            sampling_mode="on",
            temperature=max(0.05, float(反推温度)),
            top_k=64,
            top_p=float(反推TopP),
            min_p=0.05,
            repetition_penalty=float(反推重复惩罚),
            seed=0,
            presence_penalty="0.0",
            thinking=False,
            use_default_template=True,
            media=reasoning_media,
            unique_id=unique_id,
            system_prompt=official_system_prompt,
            keep_model=bool(保留模型),
            device_preference="GPU优先",
            workflow_values_json=json.dumps({
                "selected_actors": selected_actors,
                "selected_scenes": selected_scenes,
            }, ensure_ascii=False),
            anti_loop=True,
        )
        payload = generated.get("result") if isinstance(generated, dict) else generated
        raw = _dedupe_generated_blocks(
            payload[0] if isinstance(payload, (list, tuple)) and payload else payload or ""
        )
        # 日志：追踪模型原始输出中的对白情况
        _raw_has_d = bool(re.search(r"(?is)<d>\s*.*?\s*</d>", str(raw or "")))
        _raw_has_quote = bool(re.search(r'"[^"]{2,80}"|[\u2018][^\u2019]{2,80}[\u2019]|[\u300c][^\u300d]{2,80}[\u300d]', str(raw or "")))
        _raw_action_mentions_dialogue = bool(re.search(r'(?:dialogue|对白|台词|voice|spoken)', str(raw or ""), re.IGNORECASE))
        print(
            f"[GJJ_MiniMaxH3SkillStudio] 模型原始输出诊断："
            f"长度={len(str(raw or ''))}, "
            f"含<d>标签={_raw_has_d}, 含引号对白={_raw_has_quote}, "
            f"含对白关键词={_raw_action_mentions_dialogue}. "
            f"用户要求台词={user_wants_dialogue}, 用户指定对白={has_specific_dialogue}.",
            flush=True,
        )
        if user_wants_dialogue and not _raw_has_d and not _raw_has_quote:
            print("[GJJ_MiniMaxH3SkillStudio] ⚠️ 警告：模型输出中未检测到任何对白内容，可能需要检查指令或模型。", flush=True)
            # 打印原始输出前 2000 字符供调试
            print(f"[GJJ_MiniMaxH3SkillStudio] 原始输出预览：{str(raw or '')[:2000]}", flush=True)
        parsed = _extract_json(raw)
        structured_prompt = _structured_segment_prompt(
            parsed, official_mode, float(时长), target_shot_count, target_action_beat_count,
            str(需求 or ""), user_wants_dialogue=user_wants_dialogue, dialogue_language=dialogue_language,
        ) if parsed else None
        generated_prompt = _dedupe_generated_blocks(_clean_generated_value(
            structured_prompt or (
                parsed.get("h3_prompt") or parsed.get("positive_prompt") or parsed.get("prompt")
                if parsed else raw
            ),
            16000,
        ))
        generated_prompt, removed_runaway_chars = _sanitize_skill_action_beats(generated_prompt)
        generated_prompt = _normalize_picture_reference_tags(generated_prompt)
        generated_prompt = _sanitize_reasoned_prompt(
            generated_prompt,
            official_mode,
            float(时长),
            picture_count,
            dialogue_language,
            str(需求 or ""),
            video_count,
            audio_count,
        )
        generated_prompt = _normalize_action_beat_time_format(generated_prompt)
        generated_prompt, removed_after_structure = _sanitize_skill_action_beats(generated_prompt)
        removed_runaway_chars += removed_after_structure
        if removed_runaway_chars:
            print(
                f"[GJJ_MiniMaxH3SkillStudio] 检测到动作段无标点联想词链，"
                f"已丢弃异常尾部 {removed_runaway_chars} 个字符。",
                flush=True,
            )
        generated_prompt = _enforce_selected_shot_count(
            generated_prompt, float(时长), 切镜次数, str(需求 or ""),
        )
        generated_prompt = _dedupe_action_timeline_labels(generated_prompt)
        generated_prompt = _force_distinct_shot_camera(generated_prompt, content_language)
        detail_metrics = _skill_detail_metrics(generated_prompt, content_language)
        print(
            f"[GJJ_MiniMaxH3SkillStudio] 正文密度："
            f"镜头 {detail_metrics['shots']}/{target_shot_count}，"
            f"动作段 {detail_metrics['beats']}/{target_action_beat_count}（每段 1–1.5 秒），"
            f"正文字符 {detail_metrics['characters']}。",
            flush=True,
        )
        structure = "参考六字段" if official_mode == "R2VA" else "基础三字段"
        positive_prompt = _assemble_fixed_prompt_fields(generated_prompt, structure)
        positive_prompt = _force_dialogue_language(positive_prompt, dialogue_language)
        positive_prompt = _force_scene_subject_definitions(positive_prompt, required_scenes)
        positive_prompt = _force_scene_references(positive_prompt, required_scenes)
        positive_prompt = _sanitize_supporting_fields(positive_prompt, content_language)
        positive_prompt = _force_visual_style(positive_prompt, 视觉风格, content_language)
        positive_prompt = _force_music_style(positive_prompt, 音乐风格, content_language)
        positive_prompt = _dedupe_generated_blocks(positive_prompt)
        # Restore only after every normalizer has completed, so quoted dialogue is
        # never translated, normalized, truncated or deduplicated as prose.
        positive_prompt = _restore_reasoning_dialogue(positive_prompt, protected_dialogue)
        if not positive_prompt:
            raise RuntimeError("提示词模型没有返回可用的正面提示词，请检查模型或输入内容。")
        result = (positive_prompt,)
        self._RESULT_CACHE[cache_slot] = (cache_signature, result)
        return {"ui": {"text": [positive_prompt]}, "result": result}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_MiniMaxH3SkillStudio}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
