from __future__ import annotations

import json
import mimetypes
from fractions import Fraction
from pathlib import Path
from typing import Any

import folder_paths
import numpy as np
import torch
from comfy_api.latest import InputImpl, Types
from PIL import Image, ImageOps


NODE_NAME = "GJJ_Mesh2MotionExplore"
ROUTE_BASE = "/gjj/mesh2motion"
UI_DIR = Path(__file__).resolve().parents[1] / "web" / "mesh2motion"


def _register_mime_types() -> None:
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    mimetypes.add_type("model/gltf-binary", ".glb")
    mimetypes.add_type("model/gltf+json", ".gltf")
    mimetypes.add_type("video/webm", ".webm")


def _safe_child(base: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(base.resolve())
        return True
    except Exception:
        return False


def _register_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception as exc:
        print(f"[GJJ Mesh2Motion] 跳过静态路由注册：{exc}")
        return

    server = PromptServer.instance
    if getattr(server, "_gjj_mesh2motion_routes_registered", False):
        return

    _register_mime_types()
    routes = server.routes

    async def serve_index(_request):
        index_path = UI_DIR / "index-comfyui.html"
        if index_path.exists():
            return web.FileResponse(index_path)
        return web.Response(text="GJJ Mesh2Motion UI 文件不存在。", status=404)

    @routes.get(ROUTE_BASE)
    async def serve_mesh2motion_index(request):
        return await serve_index(request)

    @routes.get(f"{ROUTE_BASE}/{{path:.*}}")
    async def serve_mesh2motion_static(request):
        rel_path = request.match_info.get("path", "")
        if not rel_path:
            return await serve_index(request)

        if rel_path in {"retarget", "retarget/"}:
            rel_path = "retarget-comfyui.html"

        file_path = UI_DIR / rel_path
        if not _safe_child(UI_DIR, file_path):
            return web.Response(text="非法路径。", status=403)

        if file_path.is_dir():
            for name in ("index-comfyui.html", "index.html", "retarget-comfyui.html", "retarget.html"):
                index_path = file_path / name
                if index_path.exists():
                    return web.FileResponse(index_path)

        if file_path.exists() and file_path.is_file():
            return web.FileResponse(file_path)

        return web.Response(text="文件不存在。", status=404)

    setattr(server, "_gjj_mesh2motion_routes_registered", True)


def _normalize_size(value: Any, fallback: int, label: str) -> int:
    try:
        number = int(value)
    except Exception:
        number = fallback
    if number < 1 or number > 4096:
        raise ValueError(f"{label} 必须在 1 到 4096 之间。")
    return number


def _blank_image(width: int, height: int) -> torch.Tensor:
    return torch.zeros((1, int(height), int(width), 3), dtype=torch.float32)


def _load_and_resize_image(image_path: str, width: int, height: int) -> torch.Tensor:
    try:
        image = Image.open(image_path)
    except Exception as exc:
        raise RuntimeError(f"读取 Mesh2Motion 截图失败：{image_path}") from exc

    image = ImageOps.exif_transpose(image)
    if image.mode != "RGB":
        image = image.convert("RGB")

    if image.width != width or image.height != height:
        src_ratio = image.width / image.height
        dst_ratio = width / height
        if src_ratio > dst_ratio:
            new_width = int(image.height * dst_ratio)
            left = (image.width - new_width) // 2
            image = image.crop((left, 0, left + new_width, image.height))
        elif src_ratio < dst_ratio:
            new_height = int(image.width / dst_ratio)
            top = (image.height - new_height) // 2
            image = image.crop((0, top, image.width, top + new_height))
        image = image.resize((width, height), Image.LANCZOS)

    image_np = np.array(image).astype(np.float32) / 255.0
    return torch.from_numpy(image_np)[None,]


def _decode_video_to_tensor(video_path: str, width: int, height: int) -> torch.Tensor:
    try:
        import av
    except Exception as exc:
        raise RuntimeError("当前环境缺少 PyAV，无法把 Mesh2Motion 的 WebM 临时文件解码为 VIDEO。") from exc

    frames: list[torch.Tensor] = []
    container = av.open(video_path)
    try:
        for frame in container.decode(video=0):
            rgb = frame.to_ndarray(format="rgb24")
            if rgb.shape[0] != height or rgb.shape[1] != width:
                image = Image.fromarray(rgb).resize((width, height), Image.LANCZOS)
                rgb = np.array(image)
            frames.append(torch.from_numpy(rgb).float() / 255.0)
    finally:
        container.close()

    if not frames:
        return _blank_image(width, height)
    return torch.stack(frames)


def _video_from_frames(frames: torch.Tensor, fps: int):
    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=frames,
            audio=None,
            frame_rate=Fraction(max(1, int(fps))),
        )
    )


class GJJ_Mesh2MotionExplore:
    CATEGORY = "GJJ/3D"
    FUNCTION = "execute"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "GJJ 本地零依赖 Mesh2Motion 单节点：内嵌 3D 骨骼动画编辑器，"
        "执行时输出当前截图和相机预设录制的视频。"
    )
    SEARCH_ALIASES = [
        "Mesh2Motion",
        "mesh motion",
        "3d animation",
        "3D骨骼",
        "骨骼动画",
        "动作预览",
        "角色动画",
    ]
    RETURN_TYPES = ("IMAGE", "VIDEO")
    RETURN_NAMES = ("截图图像", "动画视频")
    OUTPUT_TOOLTIPS = (
        "执行时从 Mesh2Motion 面板捕获的当前画面。",
        "选择相机预设后录制出的动画视频；未选择预设时返回一帧黑色视频。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "show_skeleton": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "显示骨骼",
                        "tooltip": "开启后在 3D 面板中显示角色骨骼辅助线。",
                    },
                ),
                "mirror_animations": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "镜像动画",
                        "tooltip": "开启后把当前动画左右镜像显示和输出。",
                    },
                ),
                "preview_output": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "显示输出取景框",
                        "tooltip": "在 3D 面板中显示最终输出比例的取景提示。",
                    },
                ),
                "checker_room": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "棋盘房间",
                        "tooltip": "开启后用棋盘房间替代默认地面参考，便于观察运动和空间。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 1,
                        "max": 4096,
                        "step": 1,
                        "display_name": "输出宽度",
                        "tooltip": "截图和视频帧的输出宽度。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 1,
                        "max": 4096,
                        "step": 1,
                        "display_name": "输出高度",
                        "tooltip": "截图和视频帧的输出高度。",
                    },
                ),
                "fps": (
                    "INT",
                    {
                        "default": 24,
                        "min": 1,
                        "max": 120,
                        "step": 1,
                        "display_name": "视频帧率",
                        "tooltip": "动画视频输出的帧率。",
                    },
                ),
                "image": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "socketless": True,
                        "advanced": True,
                        "display_name": "截图缓存",
                        "tooltip": "前端内部使用的截图缓存，不需要手动填写。",
                    },
                ),
                "video_frames": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "socketless": True,
                        "advanced": True,
                        "display_name": "视频缓存",
                        "tooltip": "前端内部使用的视频缓存，不需要手动填写。",
                    },
                ),
            }
        }

    def execute(
        self,
        show_skeleton=False,
        mirror_animations=False,
        preview_output=False,
        checker_room=False,
        width=1024,
        height=1024,
        fps=24,
        image="",
        video_frames="",
    ):
        width = _normalize_size(width, 1024, "输出宽度")
        height = _normalize_size(height, 1024, "输出高度")
        fps = max(1, min(120, int(fps)))

        if image:
            image_path = folder_paths.get_annotated_filepath(image)
            screenshot = _load_and_resize_image(image_path, width, height)
        else:
            screenshot = _blank_image(width, height)

        video_tensor = None
        if video_frames:
            try:
                payload = json.loads(str(video_frames))
                video_name = payload.get("video") if isinstance(payload, dict) else None
                if video_name:
                    video_path = folder_paths.get_annotated_filepath(video_name)
                    video_tensor = _decode_video_to_tensor(video_path, width, height)
            except Exception as exc:
                print(f"[GJJ Mesh2Motion] 视频读取失败，改用黑色视频占位：{exc}")

        if video_tensor is None:
            video_tensor = _blank_image(width, height)

        return (screenshot, _video_from_frames(video_tensor, fps))


_register_routes()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Mesh2MotionExplore}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🦴 Mesh2Motion 骨骼动画"}
