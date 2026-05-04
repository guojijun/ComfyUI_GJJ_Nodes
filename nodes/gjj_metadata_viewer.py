from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from PIL import Image


def _read_safetensors_header(path: str) -> dict[str, Any]:
    with open(path, "rb") as file:
        header_size = int.from_bytes(file.read(8), "little", signed=False)
        if header_size <= 0 or header_size > 512 * 1024 * 1024:
            raise ValueError("safetensors 头信息大小异常。")
        header = file.read(header_size)
    return json.loads(header.decode("utf-8"))


def _pretty(value: Any) -> str:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return json.dumps(parsed, ensure_ascii=False, indent=2)
        except Exception:
            return value
    try:
        return json.dumps(value, ensure_ascii=False, indent=2, default=str)
    except Exception:
        return str(value)


class GJJ_ImageMetadataViewer:
    CATEGORY = "GJJ/Info"
    FUNCTION = "read"
    DESCRIPTION = "读取图片文件的基础信息、PNG 文本元数据、ComfyUI 工作流和 EXIF 信息。"
    SEARCH_ALIASES = ["metadata", "exif", "png info", "图片元数据", "工作流查看"]
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("信息文本", "工作流JSON", "节点列表")
    OUTPUT_TOOLTIPS = ("选定信息的文本结果。", "从 PNG 元数据中提取到的 ComfyUI workflow JSON；没有则为空。", "工作流中的节点类型列表；没有则为空。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_path": ("STRING", {"default": "", "display_name": "图片路径", "tooltip": "需要读取元数据的图片完整路径。"}),
                "info_type": (
                    ["摘要", "图片信息", "PNG元数据", "EXIF", "ComfyUI工作流", "ComfyUI节点列表", "A1111参数"],
                    {"default": "摘要", "display_name": "信息类型", "tooltip": "选择要读取的元数据类型。"},
                ),
            }
        }

    def read(self, image_path: str, info_type: str):
        path = os.path.abspath(os.path.expanduser(image_path.strip()))
        if not os.path.isfile(path):
            raise FileNotFoundError(f"未找到图片文件：{path}")
        with Image.open(path) as img:
            info = dict(img.info or {})
            exif = img.getexif()
            basic = {
                "name": Path(path).name,
                "format": img.format,
                "mode": img.mode,
                "size": img.size,
                "dpi": info.get("dpi"),
            }
            exif_dict = {str(k): str(v) for k, v in exif.items()} if exif else {}

        workflow = str(info.get("workflow") or "")
        nodes = ""
        if workflow:
            try:
                data = json.loads(workflow)
                node_types = [str(node.get("type", "")) for node in data.get("nodes", []) if node.get("type")]
                nodes = "\n".join(node_types)
            except Exception:
                nodes = ""

        if info_type == "图片信息":
            selected = basic
        elif info_type == "PNG元数据":
            selected = info
        elif info_type == "EXIF":
            selected = exif_dict
        elif info_type == "ComfyUI工作流":
            selected = workflow
        elif info_type == "ComfyUI节点列表":
            selected = nodes
        elif info_type == "A1111参数":
            selected = info.get("parameters", "")
        else:
            selected = {"图片信息": basic, "PNG元数据键": list(info.keys()), "EXIF数量": len(exif_dict), "包含ComfyUI工作流": bool(workflow)}
        return (_pretty(selected), workflow, nodes)


class GJJ_SafetensorsMetadataViewer:
    CATEGORY = "GJJ/Info"
    FUNCTION = "read"
    DESCRIPTION = "直接读取 safetensors 文件头里的 metadata，不加载模型权重，适合查看 LoRA 触发词和训练信息。"
    SEARCH_ALIASES = ["safetensors", "lora info", "metadata", "LoRA信息", "模型元数据"]
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("元数据JSON", "触发词", "旁注文本")
    OUTPUT_TOOLTIPS = ("safetensors __metadata__ 的 JSON 文本。", "从常见字段中提取的触发词；没有则为空。", "同名 txt 文件内容；没有则为空。")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_path": ("STRING", {"default": "", "display_name": "模型路径", "tooltip": "safetensors 模型或 LoRA 文件完整路径。"}),
                "include_tensor_keys": ("BOOLEAN", {"default": False, "display_name": "包含权重键列表", "tooltip": "关闭时只返回 __metadata__；开启会额外列出权重键名，文本会更长。"}),
            }
        }

    def read(self, model_path: str, include_tensor_keys: bool):
        path = os.path.abspath(os.path.expanduser(model_path.strip()))
        if not os.path.isfile(path):
            raise FileNotFoundError(f"未找到模型文件：{path}")
        header = _read_safetensors_header(path)
        metadata = dict(header.get("__metadata__", {}) or {})
        if include_tensor_keys:
            metadata["_tensor_keys"] = [key for key in header.keys() if key != "__metadata__"]

        trigger_fields = ("ss_tag_frequency", "trigger_words", "Trigger_word", "activation text", "activation_text")
        triggers = []
        for field in trigger_fields:
            value = metadata.get(field)
            if not value:
                continue
            if field == "ss_tag_frequency":
                try:
                    freq = json.loads(value)
                    counts: dict[str, int] = {}
                    for bucket in freq.values():
                        if isinstance(bucket, dict):
                            for tag, count in bucket.items():
                                counts[str(tag)] = counts.get(str(tag), 0) + int(count)
                    triggers = [tag for tag, _ in sorted(counts.items(), key=lambda item: item[1], reverse=True)[:50]]
                except Exception:
                    pass
            elif isinstance(value, str):
                triggers.extend([part.strip() for part in value.replace("\n", ",").split(",") if part.strip()])

        note_path = os.path.splitext(path)[0] + ".txt"
        note = ""
        if os.path.isfile(note_path):
            with open(note_path, "r", encoding="utf-8", errors="ignore") as file:
                note = file.read()
        return (_pretty(metadata), ", ".join(dict.fromkeys(triggers)), note)


class GJJ_SafetensorsMetadataWriter:
    CATEGORY = "GJJ/Info"
    FUNCTION = "write"
    DESCRIPTION = "为模型同名写入 txt 旁注和 png 封面；不改写 safetensors 本体，避免破坏模型文件。"
    SEARCH_ALIASES = ["model note", "lora note", "模型备注", "LoRA备注", "封面"]
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("模型路径",)
    OUTPUT_TOOLTIPS = ("原模型路径，便于继续传递。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_path": ("STRING", {"default": "", "display_name": "模型路径", "tooltip": "需要写旁注或封面的模型文件路径。"}),
                "note_text": ("STRING", {"default": "", "multiline": True, "display_name": "旁注文本", "tooltip": "会保存为模型同名 txt 文件。"}),
                "write_note": ("BOOLEAN", {"default": True, "display_name": "写入旁注", "tooltip": "开启后写入或覆盖同名 txt。"}),
            },
            "optional": {
                "cover_image": ("IMAGE", {"display_name": "封面图片", "tooltip": "可选。连接后保存为模型同名 png 封面。"}),
            },
        }

    def write(self, model_path: str, note_text: str, write_note: bool, cover_image=None):
        path = os.path.abspath(os.path.expanduser(model_path.strip()))
        if not os.path.isfile(path):
            raise FileNotFoundError(f"未找到模型文件：{path}")
        stem = os.path.splitext(path)[0]
        if write_note:
            with open(stem + ".txt", "w", encoding="utf-8") as file:
                file.write(str(note_text))
        if cover_image is not None:
            import numpy as np

            image = cover_image[0] if cover_image.ndim == 4 else cover_image
            array = (image.detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            Image.fromarray(array[..., :3]).save(stem + ".png")
        return (path,)


NODE_CLASS_MAPPINGS = {
    "GJJ_ImageMetadataViewer": GJJ_ImageMetadataViewer,
    "GJJ_SafetensorsMetadataViewer": GJJ_SafetensorsMetadataViewer,
    "GJJ_SafetensorsMetadataWriter": GJJ_SafetensorsMetadataWriter,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_ImageMetadataViewer": "GJJ · ℹ️ 图片元数据查看",
    "GJJ_SafetensorsMetadataViewer": "GJJ · 🧾 模型元数据查看",
    "GJJ_SafetensorsMetadataWriter": "GJJ · 📝 模型旁注保存",
}
