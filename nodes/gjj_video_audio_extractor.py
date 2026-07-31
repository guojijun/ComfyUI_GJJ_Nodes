from __future__ import annotations

from typing import Any


NODE_NAME = "GJJ_VideoAudioExtractor"


def _component_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _extract_audio(video: Any) -> tuple[Any, str, bool]:
    if video is None or not hasattr(video, "get_components"):
        raise RuntimeError("请输入有效的 VIDEO 对象。")
    try:
        components = video.get_components()
    except Exception as exc:
        raise RuntimeError(f"读取 VIDEO 组件失败：{exc}") from exc

    audio = _component_value(components, "audio")
    if audio is None:
        return None, "输入 VIDEO 没有可提取的音频轨道，已输出空音频并继续工作流。", False
    return audio, "已从 VIDEO 中提取到音频轨道。", True


class GJJ_VideoAudioExtractor:
    CATEGORY = "GJJ/🎬 视频"
    FUNCTION = "extract_audio"
    DESCRIPTION = "从官方 VIDEO 对象中提取内置音频轨道，输出 AUDIO。"
    SEARCH_ALIASES = ["视频提取音频", "视频转音频", "get video audio", "extract audio", "video audio"]

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("音频",)
    OUTPUT_TOOLTIPS = ("从输入 VIDEO 中提取到的 AUDIO 音频。",)

    GJJ_HELP = {
        "title": "视频提取音频",
        "description": "读取官方 VIDEO 对象里的 audio 组件，并原样输出为 AUDIO。",
        "usage": [
            "把 Load Video、视频合并或其它输出 VIDEO 的节点接到输入口。",
            "如果输入视频没有音轨，节点会在面板提示并输出空音频，不会打断后续工作流。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": (
                    "VIDEO",
                    {
                        "display_name": "视频",
                        "tooltip": "需要提取音频的官方 VIDEO 对象。",
                    },
                ),
            },
        }

    def extract_audio(self, video):
        audio, status, has_audio = _extract_audio(video)
        return {
            "ui": {
                "gjj_video_audio_status": [status],
                "gjj_video_audio_has_audio": [has_audio],
            },
            "result": (audio,),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VideoAudioExtractor}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🔊 视频提取音频"}
