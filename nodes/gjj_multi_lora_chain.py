from __future__ import annotations

import json
import logging
import re
import sys
from typing import Any

import comfy.lora
import comfy.lora_convert
import comfy.sd
import comfy.utils
import folder_paths
from aiohttp import web
try:
    from server import PromptServer
except Exception:
    PromptServer = None

from .gjj_model_name_resolver import model_basename, model_stem, pick_available_model_name


LORA_API_PATH = "/gjj/loras"
NODE_NAME = "GJJ_MultiLoraChainLoader"
CONFIG_NODE_NAME = "GJJ_LoraChainConfig"
LOGGER = logging.getLogger(__name__)
STATUS_MARK_RE = re.compile(r"^\s*[✅✔✓❌✖✕×]\s*")
STRENGTH_PREFIX_RE = re.compile(r"^\s*\([-+]?\d+(?:\.\d+)?\)\s*")
LORA_NOT_LOADED_PREFIX = "lora key not loaded: "


def hidden_lora_data_input() -> tuple[str, dict[str, Any]]:
    """Return a hidden STRING input used only for frontend JSON persistence.

    ComfyUI frontends/extensions may check different flags, so keep all common
    hidden markers together here.
    """
    return (
        "STRING",
        {
            "default": "[]",
            "multiline": False,
            "display_name": "LoRA 配置",
            "tooltip": "由前端动态界面自动维护的 LoRA 配置 JSON，一般无需手动编辑。",
            "hidden": True,
            "display": "hidden",
            "forceInput": False,
        },
    )


class _LoraMissingKeyCapture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.missing_keys: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        if message.startswith(LORA_NOT_LOADED_PREFIX):
            self.missing_keys.append(message[len(LORA_NOT_LOADED_PREFIX):])


async def get_gjj_lora_list(request):
    loras = [""] + list(folder_paths.get_filename_list("loras"))
    return web.json_response({"loras": loras})


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.get(LORA_API_PATH)(get_gjj_lora_list)


def parse_lora_data(raw_value: Any) -> list[dict[str, Any]]:
    if raw_value is None:
        return []

    text = str(raw_value).strip()
    if not text:
        return []

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return []

    if not isinstance(parsed, list):
        return []

    items: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        items.append(item)
    return items


def clean_lora_config_name(name: Any) -> str:
    text = str(name or "").strip()
    text = STATUS_MARK_RE.sub("", text)
    text = STRENGTH_PREFIX_RE.sub("", text)
    return text.strip()


def normalize_lora_chain_data(raw_value: Any) -> str:
    cleaned = []
    for item in parse_lora_data(raw_value):
        try:
            strength = float(item.get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        cleaned.append({
            "enabled": item.get("enabled", True) is not False,
            "name": clean_lora_config_name(item.get("name", "")),
            "strength": strength,
        })
    return json.dumps(cleaned, ensure_ascii=False)


def _basename(name: str) -> str:
    return model_basename(name)


def resolve_lora_name_fuzzy(lora_name: str) -> str:
    requested = str(lora_name or "").strip()
    if not requested:
        return ""

    available = list(folder_paths.get_filename_list("loras"))
    return pick_available_model_name(requested, available, allow_first=False) or model_stem(requested)


def detect_nunchaku_model_kind(model: Any) -> str | None:
    try:
        model_wrapper = model.model.diffusion_model
    except (AttributeError, TypeError):
        return None

    wrapper_name = model_wrapper.__class__.__name__
    if wrapper_name == "ComfyFluxWrapper":
        return "flux"

    inner_model = getattr(model_wrapper, "model", None)
    inner_name = inner_model.__class__.__name__ if inner_model is not None else ""
    if wrapper_name.endswith("NunchakuQwenImageTransformer2DModel"):
        return "qwen_image"
    if inner_name.endswith("NunchakuQwenImageTransformer2DModel"):
        return "qwen_image"

    return None


def nunchaku_load_flux_lora(model: Any, lora_path: str, lora_strength: float):
    from nunchaku.lora.flux import to_diffusers

    model_wrapper = model.model.diffusion_model
    module = sys.modules.get(model_wrapper.__class__.__module__)
    copy_with_ctx = getattr(module, "copy_with_ctx", None)
    if copy_with_ctx is None:
        raise RuntimeError(
            "当前检测到 Nunchaku Flux 模型，但未找到 copy_with_ctx；请升级 ComfyUI-nunchaku。"
        )

    ret_model_wrapper, ret_model = copy_with_ctx(model_wrapper)
    ret_model_wrapper.loras = [*getattr(model_wrapper, "loras", []), (lora_path, lora_strength)]

    sd = to_diffusers(lora_path)
    if "transformer.x_embedder.lora_A.weight" in sd:
        new_in_channels = sd["transformer.x_embedder.lora_A.weight"].shape[1]
        if new_in_channels % 4 != 0:
            raise RuntimeError(f"LoRA 通道数异常，无法应用：{lora_path}")
        new_in_channels //= 4
        old_in_channels = ret_model.model.model_config.unet_config["in_channels"]
        if old_in_channels < new_in_channels:
            ret_model.model.model_config.unet_config["in_channels"] = new_in_channels

    return ret_model


def load_standard_lora_patches(model: Any, clip: Any, lora_state: dict[str, Any]) -> dict[str, Any]:
    key_map: dict[str, Any] = {}
    if model is not None:
        key_map = comfy.lora.model_lora_keys_unet(model.model, key_map)
    if clip is not None:
        key_map = comfy.lora.model_lora_keys_clip(clip.cond_stage_model, key_map)

    converted_lora = comfy.lora_convert.convert_lora(lora_state)
    missing_capture = _LoraMissingKeyCapture()
    root_logger = logging.getLogger()
    root_logger.addHandler(missing_capture)
    try:
        loaded_patches = comfy.lora.load_lora(converted_lora, key_map)
    finally:
        root_logger.removeHandler(missing_capture)

    if missing_capture.missing_keys:
        preview = "\n".join(missing_capture.missing_keys[:12])
        remaining = len(missing_capture.missing_keys) - 12
        suffix = f"\n... 另有 {remaining} 个 key 未加载" if remaining > 0 else ""
        raise RuntimeError(
            "LoRA 存在未加载权重 key，请检查当前底模与 LoRA 是否完全兼容：\n"
            f"{preview}{suffix}"
        )
    return loaded_patches


def apply_standard_lora(model: Any, clip: Any, lora_state: dict[str, Any], strength_model: float, strength_clip: float):
    loaded_patches = load_standard_lora_patches(model, clip, lora_state)
    if not loaded_patches:
        raise RuntimeError("LoRA 未匹配到任何可加载权重，请检查当前底模与 LoRA 是否兼容。")

    if model is not None:
        patched_model = model.clone()
        model_keys = set(patched_model.add_patches(loaded_patches, strength_model))
    else:
        patched_model = None
        model_keys = set()

    if clip is not None:
        patched_clip = clip.clone()
        clip_keys = set(patched_clip.add_patches(loaded_patches, strength_clip))
    else:
        patched_clip = None
        clip_keys = set()

    if not model_keys and not clip_keys:
        raise RuntimeError("LoRA 已读取，但没有任何权重成功应用到模型或 CLIP。")

    return patched_model, patched_clip, len(model_keys), len(clip_keys), len(loaded_patches)


def _notify_lora_applied(callback: Any, **payload: Any) -> None:
    if callback is None:
        return
    try:
        callback(payload)
    except Exception:
        LOGGER.debug("LoRA applied callback failed", exc_info=True)


def apply_lora_chain_config(
    model: Any,
    clip: Any,
    lora_data="[]",
    loaded_lora_cache: tuple[str, Any] | None = None,
    on_lora_applied: Any = None,
    on_lora_failed: Any = None,
):
    current_model = model
    current_clip = clip
    cache_entry = loaded_lora_cache
    nunchaku_model_kind = detect_nunchaku_model_kind(model)

    if nunchaku_model_kind == "flux":
        LOGGER.info("GJJ Multi LoRA: detected Nunchaku Flux model")
    elif nunchaku_model_kind == "qwen_image":
        raise RuntimeError(
            "当前节点暂未内联 Nunchaku Qwen-Image LoRA 逻辑。"
            "如果你正在使用 Qwen-Image Nunchaku 模型，我可以继续把这部分也迁移进 GJJ。"
        )

    for item in parse_lora_data(lora_data):
        enabled = bool(item.get("enabled", True))
        lora_name = clean_lora_config_name(item.get("name", ""))
        if not enabled or not lora_name:
            continue

        try:
            strength = float(item.get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        if abs(strength) < 1e-5:
            continue

        resolved_lora_name = resolve_lora_name_fuzzy(lora_name)
        lora_path = folder_paths.get_full_path("loras", resolved_lora_name)
        if not lora_path:
            raise RuntimeError(f"未找到 LoRA 文件：{lora_name}。已按子目录、文件名和关键词做模糊搜索。")

        try:
            if nunchaku_model_kind == "flux":
                current_model = nunchaku_load_flux_lora(current_model, lora_path, strength)
                LOGGER.info("Applied Flux LoRA '%s' with strength %.3f", resolved_lora_name, strength)
                _notify_lora_applied(
                    on_lora_applied,
                    name=resolved_lora_name,
                    strength=strength,
                    kind="flux",
                    loaded=0,
                    model=0,
                    clip=0,
                )
                continue

            lora = None
            if cache_entry is not None and cache_entry[0] == lora_path:
                lora = cache_entry[1]
            if lora is None:
                lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
                cache_entry = (lora_path, lora)

            current_model, patched_clip, model_patch_count, clip_patch_count, loaded_patch_count = apply_standard_lora(
                current_model,
                current_clip,
                lora,
                strength,
                strength if current_clip is not None else 0.0,
            )
            if patched_clip is not None or current_clip is not None:
                current_clip = patched_clip
            LOGGER.info(
                "Applied standard LoRA '%s' with strength %.3f (loaded=%s, model=%s, clip=%s)",
                resolved_lora_name,
                strength,
                loaded_patch_count,
                model_patch_count,
                clip_patch_count,
            )
            _notify_lora_applied(
                on_lora_applied,
                name=resolved_lora_name,
                strength=strength,
                kind="standard",
                loaded=loaded_patch_count,
                model=model_patch_count,
                clip=clip_patch_count,
            )
        except Exception as exc:
            _notify_lora_applied(
                on_lora_failed,
                name=resolved_lora_name,
                strength=strength,
                error=str(exc),
            )
            raise RuntimeError(f"LoRA 应用失败：{resolved_lora_name}\n{exc}") from exc

    return current_model, current_clip, cache_entry


class GJJ_MultiLoraChain:
    CATEGORY = "GJJ"
    FUNCTION = "apply_loras"
    DESCRIPTION = """GJJ 多 LoRA 串联加载器。

用途：
- 在一个节点内按列表顺序连续加载多组 LoRA。
- 接入 CLIP 时，LoRA 同时作用于 MODEL 与 CLIP；不接 CLIP 时，只作用于 MODEL。
- 前端面板负责选择、启用、强度、搜索、互斥分组；后台只读取隐藏的 LoRA 配置 JSON。

界面说明：
- “未选择”默认为关闭状态，不参与加载。
- 选择任意 LoRA 后，该行会自动启用。
- 改回“未选择”后，该行会自动关闭。
- 强度为模型/CLIP 共用强度；强度为 0 时会跳过该 LoRA。
- 列表末尾会自动保留一个空行，方便继续添加。

互斥规则：
- 在“高级”里编辑互斥预设。
- 推荐格式：👤 人物角色 = 紫灵,ziling,韩立,hanli
- 也兼容：人物角色 = 紫灵,韩立
- 也兼容简写：紫灵,韩立,国风
- 等号左侧可以带 emoji。LoRA 命中该组后，行内会显示对应图标。
- 同一互斥组内只能保留一个已选 LoRA；新选择会自动清空同组其它行。
- 当前行已命中某个互斥组时，下拉框优先只显示该组内 LoRA，避免混入其它组。

预设建议：
- 适合把人物角色、加速蒸馏、视频功能、图像编辑、画风风格、建筑室内、细节增强等做成互斥组。
- 如果外部已有模型体系总开关，可把 qwen / ltx / wan / flux 等体系词加入对应组关键词。

兼容说明：
- 标准 ComfyUI LoRA 会检查未加载 key，避免底模不匹配时静默失败。
- 检测到 Nunchaku Flux 模型时，会走 Nunchaku Flux LoRA 加载逻辑。
"""
    SEARCH_ALIASES = ["multi lora", "lora chain", "lora loader", "LoRA", "串联", "加载器"]
    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("叠加模型输出", "叠加编码输出")
    OUTPUT_TOOLTIPS = (
        "按当前节点中的 LoRA 顺序串联加载后的模型输出。",
        "按当前节点中的 LoRA 顺序串联加载后的 CLIP 输出；未接入 CLIP 时这里返回空值。",
    )

    def __init__(self):
        self.loaded_lora: tuple[str, Any] | None = None

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {
                    "display_name": "模型输入",
                    "tooltip": "接入需要串联加载 LoRA 的基础模型。",
                }),
                "lora_data": hidden_lora_data_input(),
            },
            "optional": {
                "clip": ("CLIP", {
                    "display_name": "CLIP 输入",
                    "tooltip": "可选接入与模型配套的 CLIP 编码器；有输入时 LoRA 会一起作用到这里，没有输入时只做模型串联。",
                }),
            },
        }

    def apply_loras(self, model, lora_data="[]", clip=None):
        current_model, current_clip, self.loaded_lora = apply_lora_chain_config(
            model,
            clip,
            lora_data=lora_data,
            loaded_lora_cache=self.loaded_lora,
        )
        return (current_model, current_clip)


class GJJ_LoraChainConfig:
    CATEGORY = "GJJ"
    FUNCTION = "build_config"
    DESCRIPTION = """GJJ LoRA 串联配置节点。

用途：
- 只负责生成 LoRA 串联配置，不直接加载模型。
- 输出 LORA_CHAIN_CONFIG，可连接到支持“多 LoRA 串联配置”的其它 GJJ 节点。
- 适合把 LoRA 选择面板独立出来，在多个一键节点或集成节点之间复用。

界面说明：
- 前端面板用于添加 LoRA、设置启用状态、设置强度、搜索文件名。
- “未选择”默认关闭，不会写入有效加载项。
- 选择 LoRA 后自动启用；改回“未选择”后自动关闭。
- 后台隐藏字段 lora_data 只用于保存 JSON 配置，一般不需要手动编辑。

互斥规则：
- 在“高级”里编辑互斥预设。
- 推荐格式：👤 人物角色 = 紫灵,ziling,韩立,hanli
- 等号左侧可带 emoji；命中后行内显示该图标。
- 同一互斥组只保留一个 LoRA，避免角色、风格、加速、功能类 LoRA 重复叠加。
- 当前行命中互斥组后，下拉框会优先只显示该组内 LoRA，便于快速替换同类 LoRA。
"""
    SEARCH_ALIASES = ["lora config", "串联配置", "lora 串联", "多lora配置"]
    RETURN_TYPES = ("LORA_CHAIN_CONFIG",)
    RETURN_NAMES = ("LoRA串联配置",)
    OUTPUT_TOOLTIPS = ("由前端动态界面维护的 LoRA 串联配置，可直接接到支持该输入的节点。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_data": hidden_lora_data_input(),
            },
        }

    def build_config(self, lora_data="[]"):
        normalized = normalize_lora_chain_data(lora_data)
        return (normalized,)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_MultiLoraChain,
    CONFIG_NODE_NAME: GJJ_LoraChainConfig,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "GJJ · 🧬 多LoRA串联器",
    CONFIG_NODE_NAME: "GJJ · 🧬 额外LoRA串联配置",
}
