from __future__ import annotations

import re
import time
from typing import Any

try:
    from server import PromptServer
except Exception:
    PromptServer = None

import comfy.model_management
import comfy.samplers
import comfy.utils
import folder_paths
import torch
from comfy_extras.nodes_audio import vae_decode_audio
from nodes import CheckpointLoaderSimple, ConditioningZeroOut, common_ksampler

try:
    from comfy.text_encoders.yue2 import FRAMES_PER_SECOND
except Exception:
    # 旧内核兼容兜底：YuE2 固定每秒 25 个音乐帧。
    FRAMES_PER_SECOND = 25


NODE_NAME = "GJJ_Yue2MusicGenerator"

# ───────────────────────── 默认值 ─────────────────────────
DEFAULT_CKPT = "yue2_3b_int8_convrot.safetensors"
DEFAULT_AUDIO_ENCODER = "sheetsage2_bf16.safetensors"

DEFAULT_GENERATION_MODE = "text2music"
DEFAULT_STYLE = (
    "Upbeat indie pop with warm female vocals, bright electric guitars, punchy drums, "
    "melodic bass, and subtle synth layers. Catchy and energetic, with an uplifting summer "
    "atmosphere, a memorable chorus, and polished modern production."
)
DEFAULT_LYRICS = (
    "[Verse]\n"
    "Morning light across the window\n"
    "City waking down below\n"
    "I can hear the streets are calling\n"
    "Feels like somewhere we should go\n\n"
    "[Chorus]\n"
    "Run with me into the sunlight\n"
    "Leave the shadows far behind\n"
    "We don't need to know tomorrow\n"
    "Tonight the whole world feels alive\n\n"
    "[Verse]\n"
    "Radio playing through the open door\n"
    "Laughing like we did before\n"
    "Every mile becomes a memory\n"
    "And I just want a little more\n\n"
    "[Chorus]\n"
    "Run with me into the sunlight\n"
    "Leave the shadows far behind\n"
    "We don't need to know tomorrow\n"
    "Tonight the whole world feels alive"
)
DEFAULT_MODE = "full"
DEFAULT_MAX_DURATION = 120.0
DEFAULT_SEED = 0

# 文生曲：ABC 规划阶段参数
DEFAULT_ABC_PLANNING = True
DEFAULT_MAX_ABC_TOKENS = 8192
DEFAULT_ABC_TEMPERATURE = 0.7
DEFAULT_ABC_TOP_P = 0.9
DEFAULT_ABC_TOP_K = 30
DEFAULT_ABC_REPETITION_PENALTY = 1.005
DEFAULT_PENALTY_WINDOW = 100

# 翻唱：SheetSage2 转谱后的音乐生成参数
DEFAULT_TEMPERATURE = 1.0
DEFAULT_TOP_P = 0.95
DEFAULT_TOP_K = 100
DEFAULT_REPETITION_PENALTY = 1.2
DEFAULT_CFG_SCALE = 1.0

# 主采样阶段参数（与官方工作流一致）
DEFAULT_STEPS = 32
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "dpm_2"
DEFAULT_SCHEDULER = "sgm_uniform"
DEFAULT_DENOISE = 1.0

# 模式取值：内部英文值，前端展示中文标签（py 声明 / js 管理）。
GENERATION_MODES = ["text2music", "cover"]
MUSIC_MODES = ["full", "melody"]

GENERATION_MODE_LABELS = {
    "text2music": "🎵 文生曲",
    "cover": "🎤 歌曲翻唱",
}
MODE_LABELS = {
    "full": "full（旋律+和弦）",
    "melody": "melody（仅旋律）",
}

# ───────────────────────── 参数清单（前端据此管理显隐） ─────────────────────────
UI_PARAMETER_ORDER = (
    "generation_mode",
    "style",
    "lyrics",
    "mode",
    "max_duration",
    "seed",
    "ckpt_name",
    "abc_planning",
    "max_abc_tokens",
    "abc_temperature",
    "abc_top_p",
    "abc_top_k",
    "abc_repetition_penalty",
    "penalty_window",
    "audio_encoder_name",
    "temperature",
    "top_p",
    "top_k",
    "repetition_penalty",
    "cfg_scale",
    "steps",
    "cfg",
    "sampler_name",
    "scheduler",
    "denoise",
)

YUe2_MODEL_TREE = [
    {
        "label": "YuE2 主模型 checkpoint",
        "folder": "checkpoints",
        "filename": DEFAULT_CKPT,
        "url": "https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/yue2_3b_int8_convrot.safetensors",
        "description": "YuE2 3B int8 整包 checkpoint，自带 MODEL / CLIP / VAE，文生曲与翻唱共用。",
    },
    {
        "label": "SheetSage2 音频编码器（仅翻唱）",
        "folder": "audio_encoders",
        "filename": DEFAULT_AUDIO_ENCODER,
        "url": "https://huggingface.co/Comfy-Org/YuE2/resolve/main/audio_encoders/sheetsage2_bf16.safetensors",
        "description": "翻唱模式用它把参考歌曲转录成 ABC 旋律；文生曲不需要。",
    },
]
YUe2_MODEL_TREE_TEXT = f"""models/
├─ checkpoints/
│  └─ {DEFAULT_CKPT}  # 文生曲 / 翻唱共用整包
└─ audio_encoders/
   └─ {DEFAULT_AUDIO_ENCODER}  # 仅歌曲翻唱需要"""


# ───────────────────────── 通用工具 ─────────────────────────
def _normalize_text(text: Any) -> str:
    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _safe_filename_list(category: str) -> list[str]:
    try:
        return list(folder_paths.get_filename_list(category))
    except Exception:
        return []


def _list_yue2_checkpoints() -> list[str]:
    models: list[str] = []
    for name in _safe_filename_list("checkpoints"):
        normalized = _normalize_text(name)
        if "yue2" in normalized or "yue" in normalized:
            models.append(str(name))
    return sorted(models, key=lambda item: item.lower()) or [DEFAULT_CKPT]


def _list_sheetsage_encoders() -> list[str]:
    models: list[str] = []
    for name in _safe_filename_list("audio_encoders"):
        normalized = _normalize_text(name)
        if "sheetsage" in normalized:
            models.append(str(name))
    return sorted(models, key=lambda item: item.lower()) or [DEFAULT_AUDIO_ENCODER]


def _send_status(unique_id: Any, text: str) -> None:
    if not unique_id:
        return
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": str(text or "")},
        )
    except Exception:
        pass


def _send_audio_preview(
    unique_id: Any, audio_ui: dict[str, Any], srt_text: str = ""
) -> None:
    if not unique_id or not audio_ui:
        return
    try:
        from server import PromptServer

        payload: dict[str, Any] = {"node": str(unique_id), "audio": audio_ui.get("audio", [])}
        # 随音频预览一起下发歌词 SRT，前端据此渲染随播放高亮的歌词区。
        if srt_text:
            payload["srt_text"] = str(srt_text)
        PromptServer.instance.send_sync("gjj_node_audio", payload)
    except Exception:
        pass


def _save_audio_ui(audio: dict[str, Any], filename_prefix: str) -> dict[str, Any]:
    prefix = str(filename_prefix or "").strip() or "audio/YuE2"
    try:
        from comfy_api.latest import UI

        # 与官方两个工作流一致，默认输出无损 flac。
        return UI.AudioSaveHelper.get_save_audio_ui(
            audio,
            filename_prefix=prefix,
            cls=None,
            format="flac",
        ).as_dict()
    except Exception as exc:
        raise RuntimeError(f"保存 FLAC 失败：{exc}") from exc


# ─────────────── 歌词 SRT：复用 AudioAce 的强制对齐管线 ───────────────
def _detect_lyrics_language(lyrics: Any, style: Any) -> str:
    """按歌词/风格文本粗略判定语言，供 Qwen3-ForcedAligner 选择对齐语种。

    YuE2 没有独立语言参数：日文必带假名、韩文必带谚文，需先于中文汉字判定；
    其余按中文汉字与拉丁字母数量比较，全拉丁文本视为英语。
    """
    text = f"{lyrics or ''}\n{style or ''}"
    has_kana = bool(re.search(r"[\u3040-\u30ff]", text))
    has_hangul = bool(re.search(r"[\uac00-\ud7af]", text))
    cjk_count = len(re.findall(r"[\u4e00-\u9fff]", text))
    latin_count = len(re.findall(r"[A-Za-z]", text))
    if has_kana:
        return "ja"
    if has_hangul:
        return "ko"
    if cjk_count and cjk_count >= latin_count:
        return "zh"
    return "en"


def _build_lyrics_srt(
    audio: dict[str, Any], lyrics: Any, style: Any, unique_id: Any
) -> str:
    """把原始歌词强制对齐到生成音频，返回标准 SRT 文本。

    对齐逻辑直接复用 GJJ_AudioAceMusicGenerator 中已验证的实现
    （Qwen3-ForcedAligner，可选 Qwen3-ASR 辅助定位首个人声），
    懒加载导入：缺模型/依赖时只影响 SRT，不影响已生成的歌曲音频。
    """
    try:
        from .gjj_audio_ace_music_generator import _align_lyrics_to_srt
    except Exception:
        from gjj_audio_ace_music_generator import _align_lyrics_to_srt

    language = _detect_lyrics_language(lyrics, style)
    return _align_lyrics_to_srt(audio, str(lyrics or ""), language, unique_id)


def _has_singable_lyrics(lyrics: Any) -> bool:
    """歌词去掉段落标签（[Verse] 等）后是否仍有需要演唱的内容。"""
    for raw_line in str(lyrics or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        text = raw_line.strip()
        if not text:
            continue
        if re.fullmatch(r"(?:\[[^\]]+\]|\([^()]+\)|（[^（）]+）)", text):
            continue
        return True
    return False


# ───────────────────────── 各阶段内联实现（与官方节点等价） ─────────────────────────
def _generate_abc_plan(
    clip,
    style: str,
    lyrics: str,
    seed: int,
    mode: str,
    max_abc_tokens: int,
    temperature: float,
    top_p: float,
    top_k: int,
    repetition_penalty: float,
    penalty_window: int,
) -> str:
    """等价于官方 YuE2GenerateABC：先规划符号化 ABC 乐谱。"""
    tokens = clip.tokenize(
        str(style or ""),
        lyrics=str(lyrics or ""),
        cot=str(mode or DEFAULT_MODE),
        seed=int(seed),
        max_tokens=int(max_abc_tokens),
        penalty_window=int(penalty_window),
    )
    ids = clip.generate(
        tokens,
        max_length=int(max_abc_tokens),
        temperature=float(temperature),
        top_p=float(top_p),
        top_k=int(top_k),
        repetition_penalty=float(repetition_penalty),
        seed=int(seed),
    )
    return str(clip.decode(ids))


def _load_audio_encoder(audio_encoder_name: str):
    """等价于官方 AudioEncoderLoader。"""
    try:
        path = folder_paths.get_full_path_or_raise("audio_encoders", audio_encoder_name)
    except Exception:
        path = folder_paths.get_full_path("audio_encoders", audio_encoder_name)
    if not path:
        raise RuntimeError(f"未找到 SheetSage2 音频编码器：{audio_encoder_name}")
    sd = comfy.utils.load_torch_file(path, safe_load=True)
    import comfy.audio_encoders.audio_encoders as audio_encoders_module

    audio_encoder = audio_encoders_module.load_audio_encoder_from_sd(sd)
    if audio_encoder is None:
        raise RuntimeError("音频编码器文件无效，无法加载 SheetSage2。")
    return audio_encoder


def _transcribe_reference_abc(
    audio_encoder_name: str,
    reference_audio: dict[str, Any],
    mode: str,
) -> str:
    """等价于官方 SheetSage2AudioToABC：把参考歌曲转录成 ABC 旋律。"""
    audio_encoder = _load_audio_encoder(audio_encoder_name)
    abc_list = audio_encoder.generate_abc(
        reference_audio["waveform"],
        reference_audio["sample_rate"],
        melody_only=str(mode) != "full",
    )
    if not abc_list:
        raise RuntimeError("SheetSage2 没有从参考歌曲中转录出旋律，请更换参考音频。")
    # 官方输出为字符串列表；翻唱只取第一段乐谱。
    return str(abc_list[0] or "")


def _generate_music(
    clip,
    style: str,
    lyrics: str,
    abc: str,
    seed: int,
    mode: str,
    max_duration: float,
    temperature: float,
    top_p: float,
    top_k: int,
    repetition_penalty: float,
    cfg_scale: float,
) -> tuple[Any, float]:
    """等价于官方 YuE2GenerateMusic：生成声学条件与实际秒数。"""
    abc_text = str(abc or "")
    effective_mode = str(mode or DEFAULT_MODE) if abc_text.strip() else "off"
    tokens = clip.tokenize(
        str(style or ""),
        lyrics=str(lyrics or ""),
        cot=effective_mode,
        seed=int(seed),
        abc=abc_text,
        max_tokens=max(1, round(float(max_duration) * FRAMES_PER_SECOND)),
        temperature=float(temperature),
        top_p=float(top_p),
        top_k=int(top_k),
        repetition_penalty=float(repetition_penalty),
        cfg_scale=float(cfg_scale),
    )
    conditioning = clip.encode_from_tokens_scheduled(tokens)
    seconds = float(conditioning[0][1]["yue2_frames"]) / float(FRAMES_PER_SECOND)
    return conditioning, seconds


def _empty_latent(seconds: float) -> dict[str, Any]:
    """等价于官方 EmptyYuE2LatentAudio。"""
    length = max(1, round(float(seconds) * FRAMES_PER_SECOND))
    device = comfy.model_management.intermediate_device()
    dtype = (
        comfy.model_management.intermediate_dtype()
        if hasattr(comfy.model_management, "intermediate_dtype")
        else torch.float32
    )
    latent = torch.zeros((1, 64, length), device=device, dtype=dtype)
    return {"samples": latent, "type": "audio", "downscale_ratio_temporal": 1920}


# ───────────────────────── 节点定义 ─────────────────────────
class GJJ_Yue2MusicGenerator:
    CATEGORY = "GJJ/🎵 音频"
    FUNCTION = "generate"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "将 YuE2 的文生曲与歌曲翻唱两套工作流合并成单节点："
        "文生曲可先做 ABC 规划再生成；翻唱用 SheetSage2 从参考歌曲转录旋律后重新演绎。"
    )
    SEARCH_ALIASES = ["yue2", "yue", "音乐", "歌曲", "作曲", "翻唱", "cover", "文生曲", "music"]
    RETURN_TYPES = ("AUDIO", "STRING")
    RETURN_NAMES = ("音乐音频输出", "原歌词SRT")
    OUTPUT_TOOLTIPS = (
        "生成的歌曲音频（默认无损 flac）。",
        "使用 Qwen3-ForcedAligner 将原歌词对齐到生成歌曲得到的 SRT 字幕；无歌词或缺少对齐模型时为空。",
    )

    GJJ_HELP = {
        "title": "GJJ · 🎵 YuE2音乐生成器",
        "description": DESCRIPTION,
        "notice": (
            "文生曲：只需要 checkpoints 下的 YuE2 整包，可开关 ABC 规划；"
            "歌曲翻唱：额外需要 audio_encoders 下的 SheetSage2，并在【参考歌曲】接入参考音频，"
            "模式建议用 melody（仅旋律）。"
        ),
        "model_tree": YUe2_MODEL_TREE,
        "model_tree_text": YUe2_MODEL_TREE_TEXT,
        "static_model_tree_only": True,
        "model_tree_priority": "static",
        "models": [
            {
                "label": item["label"],
                "subdir": f"models/{item['folder']}",
                "filename": item["filename"],
                "description": item["description"],
            }
            for item in YUe2_MODEL_TREE
        ],
    }
    GJJ_UI = {
        "toolbar": ["🔄", "🎲", "📒", "🌐", "📝", "🎤", "🧠", "🎛️", "▶️"],
        "parameter_order": list(UI_PARAMETER_ORDER),
        "hidden_parameters": list(UI_PARAMETER_ORDER),
        # 参考歌曲为输入插槽而非 widget。
        "input_sockets": ["reference_audio"],
    }

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = _list_yue2_checkpoints()
        audio_encoders = _list_sheetsage_encoders()
        return {
            "required": {
                "generation_mode": (
                    GENERATION_MODES,
                    {
                        "default": DEFAULT_GENERATION_MODE,
                        "display_name": "生成模式（自动）",
                        "tooltip": "自动判定，无需手动选择：接入参考歌曲即按歌曲翻唱执行，未接入则按文生曲执行。",
                    },
                ),
                "style": (
                    "STRING",
                    {
                        "default": DEFAULT_STYLE,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "forceInput": False,
                        "display_name": "音乐风格",
                        "tooltip": "描述曲风、人声、语言、速度、乐器与音质；音乐指令写在这里而不是歌词里。",
                    },
                ),
                "lyrics": (
                    "STRING",
                    {
                        "default": DEFAULT_LYRICS,
                        "multiline": True,
                        "dynamicPrompts": True,
                        "forceInput": False,
                        "display_name": "歌词",
                        "tooltip": "用 [Verse]/[Chorus] 等段落标签；只放需要演唱的内容；纯音乐可留空。",
                    },
                ),
                "mode": (
                    MUSIC_MODES,
                    {
                        "default": DEFAULT_MODE,
                        "display_name": "规划模式",
                        "tooltip": "full：旋律加和弦；melody：仅旋律，翻唱推荐使用。",
                    },
                ),
                "max_duration": (
                    "FLOAT",
                    {
                        "default": DEFAULT_MAX_DURATION,
                        "min": 0.04,
                        "max": 900.0,
                        "step": 0.04,
                        "display_name": "最大时长（秒）",
                        "tooltip": "歌曲最大时长；可能因音乐结构和歌词提前结束。",
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
                        "tooltip": "随机种子。",
                    },
                ),
                "ckpt_name": (
                    checkpoints,
                    {
                        "default": checkpoints[0],
                        "display_name": "YuE2 主模型",
                        "tooltip": "checkpoints 下的 YuE2 整包，文生曲与翻唱共用。",
                    },
                ),
            },
            "optional": {
                "reference_audio": (
                    "AUDIO",
                    {
                        "display_name": "参考歌曲",
                        "tooltip": "歌曲翻唱必填：接入 LoadAudio 等节点输出的参考歌曲，用于转录旋律。",
                    },
                ),
                "abc_planning": (
                    "BOOLEAN",
                    {
                        "default": DEFAULT_ABC_PLANNING,
                        "display_name": "ABC 规划",
                        "tooltip": "仅文生曲生效：开启后先做符号化 ABC 规划再生成，关闭则直接生成（off 模式）。",
                    },
                ),
                "max_abc_tokens": (
                    "INT",
                    {
                        "default": DEFAULT_MAX_ABC_TOKENS,
                        "min": 1,
                        "max": 20000,
                        "display_name": "ABC 最大令牌",
                        "tooltip": "ABC 规划阶段允许生成的最大令牌数。",
                    },
                ),
                "abc_temperature": (
                    "FLOAT",
                    {
                        "default": DEFAULT_ABC_TEMPERATURE,
                        "min": 0.0,
                        "max": 5.0,
                        "step": 0.05,
                        "display_name": "ABC 温度",
                        "tooltip": "ABC 规划采样温度。",
                    },
                ),
                "abc_top_p": (
                    "FLOAT",
                    {
                        "default": DEFAULT_ABC_TOP_P,
                        "min": 0.01,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "ABC Top P",
                        "tooltip": "ABC 规划累计概率范围。",
                    },
                ),
                "abc_top_k": (
                    "INT",
                    {
                        "default": DEFAULT_ABC_TOP_K,
                        "min": 1,
                        "max": 32768,
                        "display_name": "ABC Top K",
                        "tooltip": "ABC 规划候选数量。",
                    },
                ),
                "abc_repetition_penalty": (
                    "FLOAT",
                    {
                        "default": DEFAULT_ABC_REPETITION_PENALTY,
                        "min": 0.01,
                        "max": 10.0,
                        "step": 0.005,
                        "display_name": "ABC 重复惩罚",
                        "tooltip": "ABC 规划重复惩罚系数。",
                    },
                ),
                "penalty_window": (
                    "INT",
                    {
                        "default": DEFAULT_PENALTY_WINDOW,
                        "min": 1,
                        "max": 20000,
                        "display_name": "惩罚窗口",
                        "tooltip": "参与重复惩罚的近期 ABC 令牌数量。",
                    },
                ),
                "audio_encoder_name": (
                    audio_encoders,
                    {
                        "default": audio_encoders[0],
                        "display_name": "SheetSage2 编码器",
                        "tooltip": "仅歌曲翻唱需要：audio_encoders 下的 SheetSage2 模型。",
                    },
                ),
                "temperature": (
                    "FLOAT",
                    {
                        "default": DEFAULT_TEMPERATURE,
                        "min": 0.0,
                        "max": 5.0,
                        "step": 0.05,
                        "display_name": "温度",
                        "tooltip": "音乐自回归生成温度。",
                    },
                ),
                "top_p": (
                    "FLOAT",
                    {
                        "default": DEFAULT_TOP_P,
                        "min": 0.01,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "Top P",
                        "tooltip": "音乐生成累计概率范围。",
                    },
                ),
                "top_k": (
                    "INT",
                    {
                        "default": DEFAULT_TOP_K,
                        "min": 1,
                        "max": 32768,
                        "display_name": "Top K",
                        "tooltip": "音乐生成候选数量。",
                    },
                ),
                "repetition_penalty": (
                    "FLOAT",
                    {
                        "default": DEFAULT_REPETITION_PENALTY,
                        "min": 0.01,
                        "max": 10.0,
                        "step": 0.01,
                        "display_name": "重复惩罚",
                        "tooltip": "音乐生成重复惩罚系数。",
                    },
                ),
                "cfg_scale": (
                    "FLOAT",
                    {
                        "default": DEFAULT_CFG_SCALE,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.01,
                        "display_name": "自回归引导",
                        "tooltip": "风格与歌词的自回归引导强度；1.0 表示关闭引导。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": DEFAULT_STEPS,
                        "min": 1,
                        "max": 200,
                        "display_name": "采样步数",
                        "tooltip": "主扩散采样步数，官方工作流为 32。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": DEFAULT_CFG,
                        "min": 0.0,
                        "max": 20.0,
                        "step": 0.1,
                        "display_name": "采样 CFG",
                        "tooltip": "主采样阶段提示词引导强度，官方工作流为 1.0。",
                    },
                ),
                "sampler_name": (
                    comfy.samplers.KSampler.SAMPLERS,
                    {
                        "default": DEFAULT_SAMPLER,
                        "display_name": "采样器",
                        "tooltip": "主采样算法，官方工作流为 dpm_2。",
                    },
                ),
                "scheduler": (
                    comfy.samplers.KSampler.SCHEDULERS,
                    {
                        "default": DEFAULT_SCHEDULER,
                        "display_name": "调度器",
                        "tooltip": "噪声调度器，官方工作流为 sgm_uniform。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": DEFAULT_DENOISE,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪",
                        "tooltip": "主采样降噪强度，完整生成用 1.0。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def generate(
        self,
        generation_mode=DEFAULT_GENERATION_MODE,
        style=DEFAULT_STYLE,
        lyrics=DEFAULT_LYRICS,
        mode=DEFAULT_MODE,
        max_duration=DEFAULT_MAX_DURATION,
        seed=DEFAULT_SEED,
        ckpt_name=DEFAULT_CKPT,
        reference_audio=None,
        abc_planning=DEFAULT_ABC_PLANNING,
        max_abc_tokens=DEFAULT_MAX_ABC_TOKENS,
        abc_temperature=DEFAULT_ABC_TEMPERATURE,
        abc_top_p=DEFAULT_ABC_TOP_P,
        abc_top_k=DEFAULT_ABC_TOP_K,
        abc_repetition_penalty=DEFAULT_ABC_REPETITION_PENALTY,
        penalty_window=DEFAULT_PENALTY_WINDOW,
        audio_encoder_name=DEFAULT_AUDIO_ENCODER,
        temperature=DEFAULT_TEMPERATURE,
        top_p=DEFAULT_TOP_P,
        top_k=DEFAULT_TOP_K,
        repetition_penalty=DEFAULT_REPETITION_PENALTY,
        cfg_scale=DEFAULT_CFG_SCALE,
        steps=DEFAULT_STEPS,
        cfg=DEFAULT_CFG,
        sampler_name=DEFAULT_SAMPLER,
        scheduler=DEFAULT_SCHEDULER,
        denoise=DEFAULT_DENOISE,
        unique_id=None,
    ):
        started_at = time.perf_counter()
        # 模式智能选择：两个官方工作流的唯一本质区别就是有无参考音频。
        # 接入有效参考歌曲 → 按翻唱工作流（转录旋律后重新演绎）；未接入 → 文生曲。
        # generation_mode 仅作为兼容旧工作流的入参保留，前端不再提供手动选择入口，
        # 因此这里以参考音频为唯一判定依据，避免残留值导致误判。
        has_reference = (
            isinstance(reference_audio, dict)
            and reference_audio.get("waveform") is not None
        )
        cover_mode = has_reference

        _send_status(unique_id, "1/6 加载 YuE2 主模型...")
        try:
            model, clip, vae = CheckpointLoaderSimple().load_checkpoint(str(ckpt_name))[:3]
        except Exception as exc:
            raise RuntimeError(
                "YuE2 加载 checkpoint 失败。\n"
                f"主模型：{ckpt_name}\n详细错误：{exc}"
            ) from exc

        # ABC 乐谱来源：翻唱→SheetSage2 转谱；文生曲→可选的 ABC 规划；关闭则留空（off）。
        # 翻唱对齐官方 audio_yue2_music_cover 工作流：SheetSage2 与 YuE2 一律用 melody
        # （只取旋律），不能沿用文生曲残留的 mode="full"，否则会连同和弦一起转录而非翻唱。
        music_mode = "melody" if cover_mode else str(mode or DEFAULT_MODE)
        abc_text = ""
        if cover_mode:
            if not isinstance(reference_audio, dict) or reference_audio.get("waveform") is None:
                raise RuntimeError(
                    "歌曲翻唱模式需要在【参考歌曲】接入参考音频（例如 LoadAudio 节点的输出）。"
                )
            _send_status(unique_id, "2/6 SheetSage2 正在转录参考歌曲旋律...")
            try:
                abc_text = _transcribe_reference_abc(
                    str(audio_encoder_name), reference_audio, music_mode
                )
            except Exception as exc:
                raise RuntimeError(f"参考歌曲转谱失败。\n详细错误：{exc}") from exc
        elif bool(abc_planning):
            _send_status(unique_id, "2/6 正在进行 ABC 规划...")
            try:
                abc_text = _generate_abc_plan(
                    clip,
                    style,
                    lyrics,
                    int(seed),
                    str(mode),
                    int(max_abc_tokens),
                    float(abc_temperature),
                    float(abc_top_p),
                    int(abc_top_k),
                    float(abc_repetition_penalty),
                    int(penalty_window),
                )
            except Exception as exc:
                raise RuntimeError(f"ABC 规划失败。\n详细错误：{exc}") from exc
        else:
            _send_status(unique_id, "2/6 已关闭 ABC 规划，直接生成...")

        _send_status(unique_id, "3/6 生成音乐条件...")
        try:
            positive, seconds = _generate_music(
                clip,
                style,
                lyrics,
                abc_text,
                int(seed),
                music_mode,
                float(max_duration),
                float(temperature),
                float(top_p),
                int(top_k),
                float(repetition_penalty),
                float(cfg_scale),
            )
            negative = ConditioningZeroOut().zero_out(positive)[0]
        except Exception as exc:
            raise RuntimeError(f"生成音乐条件失败。\n详细错误：{exc}") from exc

        _send_status(unique_id, "4/6 构建空音频 latent 并采样...")
        try:
            latent = _empty_latent(seconds)
            samples = common_ksampler(
                model,
                int(seed),
                int(steps),
                float(cfg),
                str(sampler_name),
                str(scheduler),
                positive,
                negative,
                latent,
                denoise=float(denoise),
            )[0]
        except Exception as exc:
            raise RuntimeError(f"主采样失败。\n详细错误：{exc}") from exc

        _send_status(unique_id, "5/6 VAE 解码音频...")
        try:
            audio = vae_decode_audio(vae, samples)
        except Exception as exc:
            raise RuntimeError(f"VAE 解码音频失败。\n详细错误：{exc}") from exc

        elapsed_seconds = max(0.0, time.perf_counter() - started_at)
        mode_cn = "歌曲翻唱" if cover_mode else "文生曲"
        prefix = "audio/YuE2_cover" if cover_mode else "audio/YuE2"
        audio_ui = _save_audio_ui(audio, prefix)

        # 歌词 SRT（对齐失败不阻断：音乐已生成，SRT 留空并在状态栏说明）。
        srt_text = ""
        if _has_singable_lyrics(lyrics):
            _send_status(unique_id, "6/6 对齐原歌词 SRT 时间轴...")
            try:
                srt_text = _build_lyrics_srt(audio, lyrics, style, unique_id)
            except Exception as exc:
                srt_text = ""
                print(f"[GJJ] YuE2 歌词 SRT 对齐失败（不影响音乐输出）：{exc}")

        # UI 字典与音频预览都携带 SRT；前端歌词区随播放进度高亮。
        if srt_text:
            audio_ui["srt_text"] = [srt_text]
        _send_audio_preview(unique_id, audio_ui, srt_text)

        actual_duration = float(audio["waveform"].shape[-1]) / float(audio["sample_rate"])
        srt_suffix = " / 已输出歌词 SRT" if srt_text else ""
        _send_status(
            unique_id,
            f"完成：{mode_cn} / 输出 {actual_duration:.1f}s / 耗时 {elapsed_seconds:.1f}s{srt_suffix}",
        )
        return {"ui": audio_ui, "result": (audio, srt_text)}


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Yue2MusicGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🎵 YuE2音乐生成器"}
