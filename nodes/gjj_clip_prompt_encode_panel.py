from __future__ import annotations

import gc
from typing import Any, Optional

import torch
from aiohttp import web

try:
    import comfy.model_management
except Exception:
    comfy = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None

NODE_NAME = "GJJ_CLIPPromptEncodePanel"
TRANSLATE_API_PATH = "/gjj/clip_prompt_translate"


def _get_translation_module():
    try:
        from . import gjj_opus_mt_zh_en_translation as trans
        return trans
    except Exception:
        try:
            import gjj_opus_mt_zh_en_translation as trans
            return trans
        except Exception as exc:
            raise RuntimeError(
                "无法导入 GJJ_OpusMTZhEnTranslation 接口，请确认 "
                "gjj_opus_mt_zh_en_translation.py 与当前节点在同一插件目录。"
            ) from exc


def _pick_translation_device(device: str = "auto") -> torch.device:
    device = str(device or "auto").lower()
    if device == "cpu":
        return torch.device("cpu")
    if device == "gpu":
        if not torch.cuda.is_available():
            raise RuntimeError("GPU 不可用，请选择 CPU 或 auto")
        return torch.device("cuda")
    try:
        import comfy.model_management
        return comfy.model_management.get_torch_device()
    except Exception:
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def translate_zh_to_en(
    text: str,
    device: str = "auto",
    max_length: int = 512,
    batch_size: int = 8,
    unload_after_use: bool = False,
) -> str:
    if not str(text or "").strip():
        return ""
    trans = _get_translation_module()
    torch_device = _pick_translation_device(device)
    result = trans.translate_text(
        str(text or ""),
        torch_device,
        max_length=max_length,
        batch_size=batch_size,
    )
    if unload_after_use:
        trans.unload_model()
    return result


async def gjj_clip_prompt_translate_api(request):
    try:
        data = await request.json()
        positive = str(data.get("positive", "") or "")
        negative = str(data.get("negative", "") or "")
        device = str(data.get("device", "auto") or "auto")
        max_length = int(data.get("max_length", 512) or 512)
        batch_size = int(data.get("batch_size", 8) or 8)
        unload_after_use = bool(data.get("unload_after_use", False))

        result = {
            "positive": translate_zh_to_en(positive, device, max_length, batch_size, False),
            "negative": translate_zh_to_en(negative, device, max_length, batch_size, unload_after_use),
        }
        return web.json_response({"ok": True, **result})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.post(TRANSLATE_API_PATH)(gjj_clip_prompt_translate_api)


def _encode_clip(clip: Any, text: str):
    try:
        from nodes import CLIPTextEncode
        return CLIPTextEncode().encode(clip, str(text or ""))[0]
    except Exception as exc:
        raise RuntimeError(f"CLIP 编码失败：{exc}") from exc


def _zero_conditioning(conditioning: Any):
    try:
        from nodes import ConditioningZeroOut
        return ConditioningZeroOut().zero_out(conditioning)[0]
    except Exception:
        # 兼容兜底：CONDITIONING 通常是 [[tensor, metadata], ...]
        try:
            zeroed = []
            for item in conditioning:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    cond = item[0]
                    meta = item[1].copy() if isinstance(item[1], dict) else item[1]
                    if hasattr(cond, "clone"):
                        cond = cond.clone()
                    if hasattr(cond, "zero_"):
                        cond.zero_()
                    zeroed.append([cond, meta])
                else:
                    zeroed.append(item)
            return zeroed
        except Exception as exc:
            raise RuntimeError(f"条件零化失败：{exc}") from exc


class GJJ_CLIPPromptEncodePanel:
    CATEGORY = "GJJ/条件编码"
    FUNCTION = "encode"
    DESCRIPTION = (
        "CLIP 编码统一面板：CLIP 输入，正面/负面提示词在一个面板里编辑；"
        "内置条件零化与 Opus-MT 中英翻译按钮，输出正负 CONDITIONING。"
    )
    SEARCH_ALIASES = [
        "clip encode",
        "clip text encode",
        "prompt encode",
        "正负提示词",
        "条件零化",
        "翻译",
        "中英翻译",
    ]

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("正面条件", "负面条件")
    OUTPUT_TOOLTIPS = ("正面提示词编码后的 CONDITIONING。", "负面提示词编码后的 CONDITIONING。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": (
                    "CLIP",
                    {
                        "display_name": "CLIP",
                        "tooltip": "接入 CLIP / 文本编码器。",
                    },
                ),
                "positive_text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "正面提示词",
                        "tooltip": "由前端统一面板维护的正面提示词。",
                    },
                ),
                "negative_text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "负面提示词",
                        "tooltip": "由前端统一面板维护的负面提示词。",
                    },
                ),
                "zero_conditioning": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "条件零化",
                        "tooltip": "开启后输出零化后的正负条件。",
                    },
                ),
                "translation_device": (
                    ["auto", "cpu", "gpu"],
                    {
                        "default": "auto",
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "翻译设备",
                        "tooltip": "翻译按钮使用的设备。auto 会自动选择 GPU 或 CPU。",
                    },
                ),
                "translation_unload_after_use": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display": "hidden",
                        "hidden": True,
                        "display_name": "翻译后卸载",
                        "tooltip": "翻译完成后是否卸载 Opus-MT 模型。",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        keys = [
            "positive_text",
            "negative_text",
            "zero_conditioning",
            "translation_device",
            "translation_unload_after_use",
        ]
        return "|".join(str(kwargs.get(key, "")) for key in keys)

    def encode(self, *args, **kwargs):
        clip = kwargs.get("clip", None)
        if clip is None:
            raise RuntimeError("请连接 CLIP 输入。")

        positive_text = str(kwargs.get("positive_text", "") or "")
        negative_text = str(kwargs.get("negative_text", "") or "")
        zero_conditioning = bool(kwargs.get("zero_conditioning", False))

        # 正向始终按正面提示词正常编码。
        positive = _encode_clip(clip, positive_text)

        if zero_conditioning:
            # 条件零化的正确逻辑：
            # 用“正向提示词编码结果”的结构生成一个全零负向条件。
            # 这样正向条件保持正常，负向条件维度/结构与当前 CLIP 输出完全对齐。
            # 不能把正向也 zero_out，否则正向条件会被清空，生成结果会完全不对。
            negative = _zero_conditioning(positive)
        else:
            negative = _encode_clip(clip, negative_text)

        return (positive, negative)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_CLIPPromptEncodePanel}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧾 CLIP正负提示词编码"}
