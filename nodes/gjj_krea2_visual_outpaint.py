from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F

import folder_paths

from PIL import Image

from .common_utils import gjjutils_read_temp_pil_image
from .gjj_lazy_image_studio import GJJ_LazyImageStudio


NODE_NAME = "GJJ_Krea2VisualOutpaint"
IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE"


def _files(category: str) -> list[str]:
    try:
        return [str(x) for x in folder_paths.get_filename_list(category)]
    except Exception:
        return []


def _prefer(values: list[str], words: tuple[str, ...], fallback: str = "") -> str:
    for value in values:
        low = value.lower()
        if all(word in low for word in words):
            return value
    return values[0] if values else fallback


def _family_choices(
    values: list[str],
    groups: tuple[tuple[str, ...], ...],
    *,
    fallback_to_all: bool = True,
) -> list[str]:
    matched = []
    for value in values:
        normalized = str(value).lower().replace("-", "").replace("_", "").replace(" ", "")
        if any(all(word.replace("-", "").replace("_", "") in normalized for word in group) for group in groups):
            matched.append(value)
    return matched or (values if fallback_to_all else [""])


def _pil_tensor(image) -> torch.Tensor:
    image = image.convert("RGB")
    data = torch.frombuffer(bytearray(image.tobytes()), dtype=torch.uint8)
    return data.reshape(image.height, image.width, 3).float().div(255).unsqueeze(0)


def _local_images(value: str) -> list[torch.Tensor]:
    raw = str(value or "").strip()
    if not raw:
        return []
    try:
        payload = json.loads(raw)
        refs = payload if isinstance(payload, list) else [payload]
        result = []
        for ref in refs:
            if not isinstance(ref, dict) or not ref.get("filename"):
                continue
            if str(ref.get("type") or "temp") == "input":
                root = Path(folder_paths.get_input_directory()).resolve()
                path = (root / str(ref.get("subfolder") or "") / str(ref["filename"])).resolve()
                if root not in path.parents and path != root:
                    raise RuntimeError("节点内图片路径超出 ComfyUI 输入目录。")
                with Image.open(path) as opened:
                    result.append(_pil_tensor(opened.copy()))
            else:
                result.append(_pil_tensor(gjjutils_read_temp_pil_image(ref)))
        return result
    except Exception as exc:
        raise RuntimeError(f"读取节点内图片失败：{exc}") from exc


def _source_images(value: Any) -> list[torch.Tensor]:
    if isinstance(value, (list, tuple)):
        result = []
        for item in value:
            result.extend(_source_images(item))
        return result
    image = _first_image(value)
    if image is None:
        return []
    value = value.unsqueeze(0) if isinstance(value, torch.Tensor) and value.ndim == 3 else value
    return [value[index:index + 1, ..., :3].detach().float().clamp(0, 1).contiguous() for index in range(int(value.shape[0]))]


def _first_image(value: Any) -> torch.Tensor | None:
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if not isinstance(value, torch.Tensor):
        return None
    if value.ndim == 3:
        value = value.unsqueeze(0)
    if value.ndim != 4 or value.shape[0] < 1:
        return None
    return value[:1, ..., :3].detach().float().clamp(0, 1).contiguous()


def _compose(sources: list[torch.Tensor], width: int, height: int, state: dict[str, Any]) -> torch.Tensor:
    width = max(64, int(width) // 8 * 8)
    height = max(64, int(height) // 8 * 8)
    if not sources:
        raise RuntimeError("请连接上游图片，或点击 📁 打开图片。")
    canvas = torch.zeros((1, height, width, 3), dtype=sources[0].dtype)
    canvas[..., 2] = 1.0
    items = state.get("images") if isinstance(state.get("images"), list) else []
    for index, source in enumerate(sources):
        source = _first_image(source)
        if source is None:
            continue
        item = items[index] if index < len(items) and isinstance(items[index], dict) else (state if index == 0 else {})
        scale = max(0.01, float(item.get("scale", 1.0) or 1.0))
        sh, sw = int(source.shape[1]), int(source.shape[2])
        nw, nh = max(1, round(sw * scale)), max(1, round(sh * scale))
        resized = F.interpolate(source.movedim(-1, 1), size=(nh, nw), mode="bilinear", align_corners=False).movedim(1, -1)
        x = round(float(item.get("x", (width - nw) / 2)))
        y = round(float(item.get("y", (height - nh) / 2)))
        x0, y0, x1, y1 = max(0, x), max(0, y), min(width, x + nw), min(height, y + nh)
        if x1 > x0 and y1 > y0:
            canvas[:, y0:y1, x0:x1] = resized[:, y0 - y:y1 - y, x0 - x:x1 - x]
    return canvas.contiguous()


class GJJ_Krea2VisualOutpaint:
    CATEGORY = "GJJ/💗 一键生成"
    FUNCTION = "outpaint"
    RETURN_TYPES = (IMAGE_TYPE,)
    RETURN_NAMES = ("图片",)
    OUTPUT_TOOLTIPS = ("扩图完成后的图片；兼容普通图片和 GJJ 批量图片连接。",)
    OUTPUT_NODE = True
    DESCRIPTION = "零外部自定义节点依赖的 Krea2 可视化扩图：节点内移动缩放参考图，以纯蓝区域指示模型补绘范围。"
    GJJ_HELP = {
        "description": DESCRIPTION,
        "notice": "本节点内部完成画布合成、Krea2 模型加载、提示词编码、采样和解码，不依赖其它第三方自定义节点。模型文件需放在 ComfyUI 对应模型目录中。",
        "usage": [
            "点击“打开图片”可一次选择多张图片；连接外部图片后，打开按钮会自动禁用。",
            "点击画布中的图片进行选择；拖动图片可移动，拖动四角控制点可等比例缩放，点击删除按钮可移除当前图片。",
            "点击尺寸按钮设置整体宽度、整体高度或总像素；画布中的纯蓝区域是需要模型补绘的区域。",
            "点击模型按钮选择主模型、文本编码器、VAE 和 LoRA；所有模型均通过公共模型树选择。",
            "点击运行按钮只执行当前节点；生成完成后点击结果按钮切换生成结果与编辑画布。",
        ],
        "model_tree": True,
        "dynamic_model_tree_only": True,
        "model_tree_priority": "dynamic",
    }

    def __init__(self):
        self._studio = GJJ_LazyImageStudio()

    @classmethod
    def INPUT_TYPES(cls):
        all_unets = _files("diffusion_models") or _files("unet") or [""]
        all_clips = _files("text_encoders") or _files("clip") or [""]
        all_vaes = _files("vae") or [""]
        all_loras = _files("loras")
        unets = _family_choices(all_unets, (("krea2",),))
        clips = _family_choices(all_clips, (("qwen3vl", "4b"),), fallback_to_all=False)
        vaes = _family_choices(all_vaes, (("qwenimagevae",), ("qwen", "vae")))
        loras = [""] + _family_choices(all_loras, (("krea2",),))
        schema = {
            "required": {
                "canvas_width": ("INT", {"default": 1600, "min": 64, "max": 8192, "step": 8}),
                "canvas_height": ("INT", {"default": 1200, "min": 64, "max": 8192, "step": 8}),
                "canvas_state": ("STRING", {"default": "{}", "multiline": False}),
                "local_image_data": ("STRING", {"default": "", "multiline": True}),
                "prompt": ("STRING", {"default": "填充蓝色部分，保持和原图一致", "multiline": True}),
                "negative_prompt": ("STRING", {"default": "low quality, worst quality, blurry, artifacts", "multiline": True}),
                "unet_name": (unets, {"default": _prefer(unets, ("krea2",))}),
                "clip_name": (clips, {"default": _prefer(clips, ("qwen3vl",))}),
                "vae_name": (vaes, {"default": _prefer(vaes, ("qwen", "vae"))}),
                "lora_1": (loras, {"default": _prefer(loras[1:], ("realism", "engine"), "")}),
                "lora_1_strength": ("FLOAT", {"default": 0.5, "min": -10.0, "max": 10.0, "step": 0.05}),
                "lora_2": (loras, {"default": _prefer(loras[1:], ("krea", "identity"), "")}),
                "lora_2_strength": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.05}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True}),
                "steps": ("INT", {"default": 8, "min": 1, "max": 1000}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1}),
                "sampler_name": (list(__import__("comfy.samplers", fromlist=["KSampler"]).KSampler.SAMPLERS), {"default": "euler"}),
                "scheduler": (list(__import__("comfy.samplers", fromlist=["KSampler"]).KSampler.SCHEDULERS), {"default": "simple"}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "grow_mask_by": ("INT", {"default": 6, "min": 0, "max": 256}),
                "keep_model_loaded": ("BOOLEAN", {"default": False}),
                "total_pixels_k": ("INT", {"default": 0, "min": 0, "max": 67109, "step": 1, "display_name": "总像素(K)"}),
            },
            "optional": {"image": (IMAGE_TYPE, {"display_name": "图片（可选）", "tooltip": "可选外部图片输入，支持普通图片和 GJJ 批量图片；连接后优先使用外部图片。"})},
            "hidden": {"unique_id": "UNIQUE_ID", "prompt_graph": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }
        chinese_meta = {
            "canvas_width": ("整体宽度", "最终画布的像素宽度，按 8 的倍数处理。"),
            "canvas_height": ("整体高度", "最终画布的像素高度，按 8 的倍数处理。"),
            "canvas_state": ("画布布局", "节点面板自动保存的多图位置、缩放和选择状态。"),
            "local_image_data": ("节点内图片", "通过“打开图片”导入的图片文件信息。"),
            "prompt": ("正向提示词", "指导 Krea2 绘制纯蓝区域的正向提示词。"),
            "negative_prompt": ("反向提示词", "需要避免的画面内容和质量问题。"),
            "unet_name": ("Krea2 主模型", "用于扩图的 Krea2 扩散模型。"),
            "clip_name": ("文本编码器", "仅允许选择与当前 Krea2 主模型匹配的 Qwen3VL 4B 文本编码器。"),
            "vae_name": ("图像 VAE", "与当前 Krea2 主模型匹配的 Qwen Image VAE。"),
            "lora_1": ("LoRA 1", "第一个可选 Krea2 LoRA；不使用时选择空项。"),
            "lora_1_strength": ("LoRA 1 强度", "第一个 LoRA 的应用强度。"),
            "lora_2": ("LoRA 2", "第二个可选 Krea2 LoRA；不使用时选择空项。"),
            "lora_2_strength": ("LoRA 2 强度", "第二个 LoRA 的应用强度。"),
            "seed": ("随机种子", "采样使用的随机种子。"),
            "steps": ("采样步数", "Krea2 扩图的采样步数。"),
            "cfg": ("提示词引导强度", "提示词对生成结果的引导强度。"),
            "sampler_name": ("采样器", "选择采样算法。"),
            "scheduler": ("调度器", "选择采样噪声调度方式。"),
            "denoise": ("降噪强度", "控制模型重绘强度。"),
            "grow_mask_by": ("遮罩扩张", "扩张自动重绘区域的像素数。"),
            "keep_model_loaded": ("保持模型加载", "执行结束后保留模型，便于连续生成。"),
            "total_pixels_k": ("总像素（千像素）", "大于 0 时按当前宽高比计算目标宽高；0 表示直接使用整体宽高。"),
        }
        # 参数只由节点内工具栏和浮动面板编辑；后端也声明隐藏，避免前端扩展
        # 尚未完成挂载时泄露整张原生参数表。
        for name, spec in schema["required"].items():
            if len(spec) >= 2 and isinstance(spec[1], dict):
                label, tooltip = chinese_meta.get(name, (name, ""))
                spec[1]["display_name"] = label
                spec[1]["tooltip"] = tooltip
                spec[1]["hidden"] = True
                spec[1]["display"] = "hidden"
                spec[1]["widget"] = "hidden"
                spec[1]["advanced"] = True
                spec[1]["forceInput"] = False
        return schema

    def outpaint(self, canvas_width, canvas_height, canvas_state, local_image_data, prompt, negative_prompt,
                 unet_name, clip_name, vae_name, lora_1, lora_1_strength, lora_2, lora_2_strength,
                 seed, steps, cfg, sampler_name, scheduler, denoise, grow_mask_by, keep_model_loaded,
                 total_pixels_k,
                 image=None, unique_id=None, prompt_graph=None, extra_pnginfo=None):
        total_pixels_k = max(0, int(total_pixels_k or 0))
        if total_pixels_k > 0:
            ratio = max(1.0 / 8192.0, float(canvas_width) / max(1.0, float(canvas_height)))
            target_pixels = total_pixels_k * 1000.0
            canvas_width = max(64, min(8192, round((target_pixels * ratio) ** 0.5 / 8) * 8))
            canvas_height = max(64, min(8192, round((target_pixels / ratio) ** 0.5 / 8) * 8))
        sources = _source_images(image)
        if not sources:
            sources = _local_images(local_image_data)
        try:
            state = json.loads(str(canvas_state or "{}"))
        except Exception:
            state = {}
        canvas = _compose(sources, canvas_width, canvas_height, state)
        rows = [
            {"enabled": True, "name": name, "strength": float(strength)}
            for name, strength in ((lora_1, lora_1_strength), (lora_2, lora_2_strength)) if str(name or "").strip()
        ]
        call_args = dict(
            prompt=prompt, negative_prompt=negative_prompt, main_image_index=1,
            width=int(canvas_width), height=int(canvas_height), batch_size=1,
            unet_name=unet_name, unet_dtype="default", clip_name1=clip_name, vae_name=vae_name,
            seed=seed, steps=steps, cfg=cfg, sampler_name=sampler_name, scheduler=scheduler,
            denoise=denoise, grow_mask_by=grow_mask_by,
            keep_model_loaded=keep_model_loaded, use_input_image_size=True, image_01=canvas,
            preserve_krea2_dimensions=True,
            unique_id=unique_id, prompt_graph=prompt_graph, extra_pnginfo=extra_pnginfo,
        )
        active_rows = list(rows)
        while True:
            try:
                return self._studio.create_image(
                    **call_args,
                    lora_data=json.dumps(active_rows, ensure_ascii=False),
                )
            except RuntimeError as exc:
                message = str(exc)
                if not active_rows or "LoRA" not in message or "未匹配到任何可加载权重" not in message:
                    raise
                failed_index = next(
                    (index for index, row in enumerate(active_rows) if str(row.get("name") or "") in message),
                    0,
                )
                failed = active_rows.pop(failed_index)
                print(f"[GJJ] Krea2 扩图跳过与当前主模型不兼容的 LoRA：{failed.get('name', '')}")


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Krea2VisualOutpaint}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ.🖼️可视化扩图单节点（Krea2）"}
