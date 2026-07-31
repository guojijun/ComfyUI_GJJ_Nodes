from __future__ import annotations

import math
import os
import traceback
from typing import Any

import folder_paths
import torch

NODE_NAME = "GJJ_QwenMultiangleCameraNode"
NODE_DISPLAY_NAME = "📷 多角度相机控制"

INPUT_MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO"

_SCENE_CENTER_Y = 0.5


def _build_camera_info(horizontal_angle: int, vertical_angle: int, zoom: float) -> dict:
    az_rad = math.radians(horizontal_angle)
    el_rad = math.radians(vertical_angle)
    visual_dist = 2.6 - (zoom / 10.0) * 2.0
    cam_x = visual_dist * math.sin(az_rad) * math.cos(el_rad)
    cam_y = _SCENE_CENTER_Y + visual_dist * math.sin(el_rad)
    cam_z = visual_dist * math.cos(az_rad) * math.cos(el_rad)
    return {
        "position": {"x": cam_x, "y": cam_y, "z": cam_z},
        "target": {"x": 0.0, "y": _SCENE_CENTER_Y, "z": 0.0},
        "zoom": 1,
        "cameraType": "perspective",
    }


def _get_node_properties(extra_pnginfo: Any, unique_id: Any) -> dict[str, Any]:
    try:
        workflow = (extra_pnginfo or {}).get("workflow") or {}
        for node in workflow.get("nodes") or []:
            if str(node.get("id")) == str(unique_id):
                return dict(node.get("properties") or {})
    except Exception:
        pass
    return {}


def _horizontal_direction(angle: int) -> str:
    h = angle % 360
    if h < 22.5 or h >= 337.5:
        return "正面视角"
    elif h < 67.5:
        return "右前方视角"
    elif h < 112.5:
        return "右侧视角"
    elif h < 157.5:
        return "右后方视角"
    elif h < 202.5:
        return "背面视角"
    elif h < 247.5:
        return "左后方视角"
    elif h < 292.5:
        return "左侧视角"
    else:
        return "左前方视角"


def _vertical_direction(angle: int) -> str:
    if angle < -15:
        return "仰拍"
    elif angle < 15:
        return "平视"
    elif angle < 45:
        return "高角度"
    else:
        return "俯拍"


def _distance_label(zoom: float) -> str:
    if zoom < 2:
        return "远景"
    elif zoom < 6:
        return "中景"
    else:
        return "特写"


def _horizontal_direction_en(angle: int) -> str:
    h = angle % 360
    if h < 22.5 or h >= 337.5:
        return "front view"
    elif h < 67.5:
        return "front-right quarter view"
    elif h < 112.5:
        return "right side view"
    elif h < 157.5:
        return "back-right quarter view"
    elif h < 202.5:
        return "back view"
    elif h < 247.5:
        return "back-left quarter view"
    elif h < 292.5:
        return "left side view"
    else:
        return "front-left quarter view"


def _vertical_direction_en(angle: int) -> str:
    if angle < -15:
        return "low-angle shot"
    elif angle < 15:
        return "eye-level shot"
    elif angle < 45:
        return "elevated shot"
    else:
        return "high-angle shot"


def _distance_label_en(zoom: float) -> str:
    if zoom < 2:
        return "wide shot"
    elif zoom < 6:
        return "medium shot"
    else:
        return "close-up"


class GJJ_QwenMultiangleCameraNode:
    CATEGORY = "GJJ/🧊 三维工具"
    FUNCTION = "generate"
    OUTPUT_NODE = True

    DESCRIPTION = (
        "交互式3D相机角度控制节点，通过3D场景调整相机角度，输出多角度提示词和相机信息。"
        "支持图片输入在3D场景中预览。"
    )

    SEARCH_ALIASES = [
        "GJJ QwenMultiangleCameraNode",
        "GJJ Qwen Multiangle Camera",
        "GJJ multiangle camera",
        "GJJ 多角度相机",
        "GJJ 相机角度",
        "GJJ camera angle",
    ]

    RETURN_TYPES = ("STRING", "LOAD_3D_CAMERA")
    RETURN_NAMES = ("提示词", "相机信息")
    OUTPUT_TOOLTIPS = (
        "多角度提示词字符串，格式如：<sks> 正面视角 平视 中景",
        "3D相机位置信息，可用于支持 LOAD_3D_CAMERA 的下游节点。",
    )

    GJJ_HELP = {
        "title": "📷 多角度相机控制",
        "description": (
            "交互式3D相机角度控制节点。通过3D场景直观调整相机水平角、垂直角和距离，"
            "自动生成多角度提示词和相机位置信息。"
        ),
        "notice": "本节点为零依赖复刻版，不依赖 comfy-api 或 ComfyUI-QwenMultiangle 插件。",
        "usage": [
            "拖拽3D场景中的控制手柄调整相机角度：粉色=水平角，青色=垂直角，黄色=距离。",
            "也可以通过下方下拉菜单快速选择预设角度。",
            "🔍 全屏预览3D场景。",
            "📁 打开本地图片文件，在相机视角中预览。",
            "🔄 刷新上游图片到相机视角预览（需连接上游图片输入）。",
            "↺ 重置为默认角度。",
            "开启「相机视角」后可从相机位置观察场景，鼠标拖拽旋转、滚轮缩放。",
            "输出的提示词可直接用于多角度图像生成模型。",
            "可选连接图片输入，在3D场景中预览参考图。",
        ],
        "parameters": [
            "水平角度：相机绕Y轴的方位角（0-360°），0°=正面。",
            "垂直角度：相机俯仰角（-30°到60°），0°=平视。",
            "距离：相机到目标的距离（0=远，10=近）。",
            "中文提示词：输出中文角度描述，如「正面视角 平视 中景」。",
            "相机视角：切换到相机第一人称视角预览。",
        ],
        "notes": [
            "面板显示中文描述，输出始终使用原版英文提示词格式，兼容原版 QwenMultiangleCameraNode。",
            "相机信息输出为 LOAD_3D_CAMERA 类型，可连接到支持该类型的下游节点。",
        ],
        "dependencies": ["无外部自定义节点依赖，无新增 Python 依赖。"],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "horizontal_angle": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 360,
                        "step": 1,
                        "display_name": "水平角度",
                        "tooltip": "相机水平方位角（0-360°），0°=正面，90°=右侧，180°=背面，270°=左侧。",
                    },
                ),
                "vertical_angle": (
                    "INT",
                    {
                        "default": 0,
                        "min": -30,
                        "max": 60,
                        "step": 1,
                        "display_name": "垂直角度",
                        "tooltip": "相机俯仰角（-30°到60°），负值=仰拍，0°=平视，正值=俯拍。",
                    },
                ),
                "zoom": (
                    "FLOAT",
                    {
                        "default": 5.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.1,
                        "display_name": "距离",
                        "tooltip": "相机到目标的距离（0=远景，10=特写）。",
                    },
                ),
            },
            "optional": {
                "image": (INPUT_MEDIA_TYPE, {
                    "display_name": "图片",
                    "tooltip": "可选输入图片，在3D场景中预览显示。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def generate(
        self,
        horizontal_angle,
        vertical_angle,
        zoom,
        image=None,
        unique_id=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        horizontal_angle = max(0, min(360, int(horizontal_angle)))
        vertical_angle = max(-30, min(60, int(vertical_angle)))
        zoom = max(0.0, min(10.0, float(zoom)))

        props = _get_node_properties(extra_pnginfo, unique_id)
        camera_view = bool(props.get("camera_view", False))

        h_dir = _horizontal_direction_en(horizontal_angle)
        v_dir = _vertical_direction_en(vertical_angle)
        d_label = _distance_label_en(zoom)

        prompt = f"<sks> {h_dir} {v_dir} {d_label}"

        camera_info = _build_camera_info(horizontal_angle, vertical_angle, zoom)

        ui_data = {}
        if image is not None:
            try:
                import numpy as np
                from PIL import Image as PILImage
                import io as _io

                img_tensor = image
                if isinstance(img_tensor, torch.Tensor):
                    if img_tensor.ndim == 4:
                        img_np = img_tensor[0].cpu().numpy()
                    elif img_tensor.ndim == 3:
                        img_np = img_tensor.cpu().numpy()
                    else:
                        img_np = img_tensor.cpu().numpy()
                    if img_np.shape[-1] == 1:
                        img_np = img_np.squeeze(-1)
                    if img_np.shape[-1] == 4:
                        img_np = img_np[..., :3]
                    if img_np.max() <= 1.0:
                        img_np = (img_np * 255).clip(0, 255).astype(np.uint8)
                    else:
                        img_np = img_np.clip(0, 255).astype(np.uint8)
                    pil_img = PILImage.fromarray(img_np)
                    buf = _io.BytesIO()
                    pil_img.save(buf, format="PNG", compress_level=1)
                    img_bytes = buf.getvalue()

                output_dir = folder_paths.get_temp_directory()
                os.makedirs(output_dir, exist_ok=True)
                filename = f"gjj_multiangle_{unique_id or 'preview'}.png"
                filepath = os.path.join(output_dir, filename)
                with open(filepath, "wb") as f:
                    f.write(img_bytes)

                ui_data["preview_images"] = [
                    {
                        "filename": filename,
                        "subfolder": "",
                        "type": "temp",
                    }
                ]
            except Exception as e:
                print(f"[GJJ][多角度相机] 保存预览图片失败: {e}")
                traceback.print_exc()

        return {"ui": ui_data, "result": (prompt, camera_info)}


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_QwenMultiangleCameraNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
