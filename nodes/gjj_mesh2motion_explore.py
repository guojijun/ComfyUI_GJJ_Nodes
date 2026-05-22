from __future__ import annotations

import json
import mimetypes
import shutil
import traceback
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

def _get_mesh2motion_dir() -> Path:
    """获取 Mesh2Motion 资源目录，优先使用全局 models 目录"""
    # 首先检查全局 models 目录
    global_models_dir = Path(folder_paths.models_dir) / "mesh2motion"
    if global_models_dir.exists():
        return global_models_dir

    # 其次检查本地 web 目录（向后兼容）
    local_web_dir = Path(__file__).resolve().parents[1] / "web" / "mesh2motion"
    if local_web_dir.exists():
        return local_web_dir

    # 如果都不存在，提示用户下载
    print(f"[GJJ Mesh2Motion] ⚠️  Mesh2Motion 资源未找到！")
    print(f"🌏模型下载：https://github.com/scottpetrovic/mesh2motion-app/releases")
    print(f"请将解压后的 mesh2motion 文件夹放入：{global_models_dir}")

    # 创建空目录以便后续下载
    global_models_dir.mkdir(parents=True, exist_ok=True)
    return global_models_dir

UI_DIR = _get_mesh2motion_dir()


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

    # 存储捕获状态的全局缓存
    _capture_state_cache = {}

    @routes.post(f"{ROUTE_BASE}/capture-state")
    async def handle_capture_state(request):
        """接收前端捕获的截图和视频状态，保存到缓存供 execute 使用"""
        try:
            body = await request.json()
            node_id = body.get("node_id", "")
            state = body.get("state", {})
            _capture_state_cache[node_id] = state
            return web.json_response({"status": "ok", "node_id": node_id})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.get(f"{ROUTE_BASE}/capture-state/{{node_id}}")
    async def get_capture_state(request):
        """获取指定节点的捕获状态"""
        node_id = request.match_info.get("node_id", "")
        state = _capture_state_cache.get(node_id)
        return web.json_response({"state": state or {}})

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


def _get_node_properties(extra_pnginfo: dict | None, unique_id: str | None) -> dict:
    """从 workflow 中读取节点 properties"""
    try:
        if not unique_id or not extra_pnginfo:
            return {}
        workflow = extra_pnginfo.get("workflow") or {}
        for node in workflow.get("nodes") or []:
            if str(node.get("id")) == str(unique_id):
                return node.get("properties") or {}
    except Exception:
        pass
    return {}


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
            "required": {},
            "optional": {
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
                        "display_name": "棋盘格背景",
                        "tooltip": "开启后在 3D 面板中显示棋盘格背景，便于观察透明区域。",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 128,
                        "max": 4096,
                        "step": 64,
                        "display_name": "输出宽度",
                        "tooltip": "最终截图和视频的宽度（像素）。",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 128,
                        "max": 4096,
                        "step": 64,
                        "display_name": "输出高度",
                        "tooltip": "最终截图和视频的高度（像素）。",
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
                        "tooltip": "录制视频时的帧率（FPS）。",
                    },
                ),
            },
            "hidden": {
                "image": "IMAGE",
                "video_frames": "STRING",
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
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
        unique_id=None,
        extra_pnginfo=None,
    ):
        print(f"[GJJ Mesh2Motion] ========== 开始执行 ==========")
        print(f"[GJJ Mesh2Motion] unique_id: {unique_id}")
        
        # 优先从 properties 读取参数（前端自定义 UI 的值）
        props = _get_node_properties(extra_pnginfo, unique_id)
        print(f"[GJJ Mesh2Motion] 节点 properties: {list(props.keys())}")
        
        # 如果 properties 有值，优先使用 properties 的参数
        if "mesh2motion_show_skeleton" in props:
            show_skeleton = bool(props["mesh2motion_show_skeleton"])
        if "mesh2motion_mirror_animations" in props:
            mirror_animations = bool(props["mesh2motion_mirror_animations"])
        if "mesh2motion_preview_output" in props:
            preview_output = bool(props["mesh2motion_preview_output"])
        if "mesh2motion_checker_room" in props:
            checker_room = bool(props["mesh2motion_checker_room"])
        if "mesh2motion_width" in props:
            width = int(props["mesh2motion_width"])
        if "mesh2motion_height" in props:
            height = int(props["mesh2motion_height"])
        if "mesh2motion_fps" in props:
            fps = int(props["mesh2motion_fps"])
        
        print(f"[GJJ Mesh2Motion] 最终参数: show_skeleton={show_skeleton}, mirror_animations={mirror_animations}, preview_output={preview_output}, checker_room={checker_room}")
        print(f"[GJJ Mesh2Motion] 最终参数: width={width}, height={height}, fps={fps}")
        
        width = _normalize_size(width, 1024, "输出宽度")
        height = _normalize_size(height, 1024, "输出高度")
        fps = max(1, min(120, int(fps)))

        # 读取图片和视频数据（优先 properties，其次缓存）
        image_data = props.get("mesh2motion_image", "")
        video_data = props.get("mesh2motion_video", "")
        
        # 如果 properties 没有数据，尝试从缓存读取
        if not image_data or not video_data:
            try:
                cached_state = _capture_state_cache.get(str(unique_id), {})
                if cached_state:
                    if not image_data and cached_state.get("image"):
                        image_data = json.dumps(cached_state["image"])
                        print(f"[GJJ Mesh2Motion] 从缓存读取截图数据")
                    if not video_data and cached_state.get("video"):
                        video_data = json.dumps(cached_state["video"])
                        print(f"[GJJ Mesh2Motion] 从缓存读取视频数据")
            except Exception as e:
                print(f"[GJJ Mesh2Motion] 读取缓存失败：{e}")

        print(f"[GJJ Mesh2Motion] properties 中的 image_data 长度: {len(image_data) if image_data else 0}")
        print(f"[GJJ Mesh2Motion] properties 中的 video_data 长度: {len(video_data) if video_data else 0}")

        # 如果 properties 有数据，优先使用
        if image_data:
            print(f"[GJJ Mesh2Motion] 使用 properties 中的截图数据")
            image = image_data
        if video_data:
            print(f"[GJJ Mesh2Motion] 使用 properties 中的视频数据")
            video_frames = video_data

        if image:
            try:
                print(f"[GJJ Mesh2Motion] 开始解析截图数据...")
                payload = json.loads(str(image))
                name = payload.get("name", "")
                subfolder = payload.get("subfolder", "")
                file_type = payload.get("type", "temp")
                annotated = f"{name} [{file_type}]"
                if subfolder:
                    annotated = f"{subfolder}/{name} [{file_type}]"
                print(f"[GJJ Mesh2Motion] 截图 annotated 路径: {annotated}")
                image_path = folder_paths.get_annotated_filepath(annotated)
                print(f"[GJJ Mesh2Motion] 截图解析路径: {image_path}")
                if not image_path or not Path(image_path).exists():
                    raise RuntimeError(f"截图文件不存在：{image_path} (annotated: {annotated})")
                print(f"[GJJ Mesh2Motion] 截图文件存在，大小: {Path(image_path).stat().st_size} bytes")
                screenshot = _load_and_resize_image(image_path, width, height)
                print(f"[GJJ Mesh2Motion] 截图加载成功，shape: {screenshot.shape}")
            except Exception as exc:
                print(f"[GJJ Mesh2Motion] 截图加载失败，使用黑色图像占位：{exc}")
                traceback.print_exc()
                screenshot = _blank_image(width, height)
        else:
            print(f"[GJJ Mesh2Motion] 没有截图数据，使用黑色图像占位")
            screenshot = _blank_image(width, height)

        video_tensor = None
        if video_frames:
            try:
                print(f"[GJJ Mesh2Motion] 开始解析视频数据...")
                payload = json.loads(str(video_frames))
                video_info = payload.get("video") if isinstance(payload, dict) else None
                
                if video_info:
                    # 优先使用 raw 字段（完整 annotated 路径）
                    if isinstance(video_info, dict) and video_info.get("raw"):
                        video_annotated = video_info["raw"]
                    elif isinstance(video_info, str):
                        video_annotated = video_info
                    else:
                        # 手动构建 annotated 路径
                        name = video_info.get("name", "")
                        subfolder = video_info.get("subfolder", "")
                        file_type = video_info.get("type", "temp")
                        video_annotated = f"{subfolder}/{name} [{file_type}]" if subfolder else f"{name} [{file_type}]"
                    
                    print(f"[GJJ Mesh2Motion] 视频 annotated 路径: {video_annotated}")
                    video_path = folder_paths.get_annotated_filepath(video_annotated)
                    print(f"[GJJ Mesh2Motion] 视频解析路径: {video_path}")
                    
                    if not video_path or not Path(video_path).exists():
                        raise RuntimeError(f"视频文件不存在：{video_path} (annotated: {video_annotated})")
                    
                    print(f"[GJJ Mesh2Motion] 视频文件存在，大小: {Path(video_path).stat().st_size} bytes")
                    video_tensor = _decode_video_to_tensor(video_path, width, height)
                    print(f"[GJJ Mesh2Motion] 视频加载成功，共 {video_tensor.shape[0]} 帧")
            except Exception as exc:
                print(f"[GJJ Mesh2Motion] 视频读取失败，改用黑色视频占位：{exc}")
                traceback.print_exc()

        if video_tensor is None:
            print(f"[GJJ Mesh2Motion] 没有视频数据，使用黑色视频占位")
            video_tensor = _blank_image(width, height)

        print(f"[GJJ Mesh2Motion] ========== 执行完成 ==========")
        return (screenshot, _video_from_frames(video_tensor, fps))


_register_routes()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Mesh2MotionExplore}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🦴 Mesh2Motion 骨骼动画"}
