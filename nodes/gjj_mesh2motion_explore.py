from __future__ import annotations

import json
import mimetypes
import re
import shutil
import tempfile
import traceback
from fractions import Fraction
from pathlib import Path
from typing import Any

import folder_paths
import numpy as np
import torch
from comfy_api.latest import InputImpl, Types
from PIL import Image, ImageOps

from .common_utils.dependency_checker import (
    build_dependency_model_report,
    print_dependency_model_report,
    send_dependency_model_notice,
)


NODE_NAME = "GJJ_Mesh2MotionExplore"
NODE_DISPLAY_NAME = "GJJ · 🦴 Mesh2Motion 骨骼动画"
ROUTE_BASE = "/gjj/mesh2motion"
MESH2MOTION_CAPTURE_STATE: dict[str, dict[str, Any]] = {}
MESH2MOTION_MODEL_DIR_NAME = "mesh2motion"
MESH2MOTION_MIN_FILES = 430
MESH2MOTION_MIN_DIRS = 15
MESH2MOTION_MIN_BYTES = 38_000_000
MESH2MOTION_MODEL_SPEC = {
    "label": "Mesh2Motion 前端资源",
    "subdir": "models",
    "filename": MESH2MOTION_MODEL_DIR_NAME,
    "description": (
        "Mesh2Motion 骨骼动画编辑器完整资源目录。需要放在 models/mesh2motion，"
        f"不少于 {MESH2MOTION_MIN_FILES} 个文件、{MESH2MOTION_MIN_DIRS} 个文件夹、{MESH2MOTION_MIN_BYTES} 字节。"
    ),
}


def _inspect_mesh2motion_dir(path: Path) -> dict[str, Any]:
    info = {
        "path": path,
        "exists": path.exists(),
        "is_dir": path.is_dir(),
        "file_count": 0,
        "dir_count": 0,
        "total_bytes": 0,
    }
    if not info["is_dir"]:
        return info
    try:
        for item in path.rglob("*"):
            try:
                if item.is_file():
                    info["file_count"] += 1
                    info["total_bytes"] += int(item.stat().st_size)
                elif item.is_dir():
                    info["dir_count"] += 1
            except OSError:
                continue
    except Exception:
        pass
    return info


def _mesh2motion_model_report() -> tuple[bool, dict[str, Any], dict[str, Any]]:
    model_dir = Path(folder_paths.models_dir) / MESH2MOTION_MODEL_DIR_NAME
    info = _inspect_mesh2motion_dir(model_dir)
    ok = (
        bool(info["is_dir"])
        and int(info["file_count"]) >= MESH2MOTION_MIN_FILES
        and int(info["dir_count"]) >= MESH2MOTION_MIN_DIRS
        and int(info["total_bytes"]) >= MESH2MOTION_MIN_BYTES
    )
    missing_models = []
    if not ok:
        reason = (
            f"当前状态：目录={'存在' if info['is_dir'] else '不存在'}，"
            f"文件 {info['file_count']}/{MESH2MOTION_MIN_FILES}，"
            f"文件夹 {info['dir_count']}/{MESH2MOTION_MIN_DIRS}，"
            f"大小 {info['total_bytes']}/{MESH2MOTION_MIN_BYTES} 字节。"
        )
        spec = dict(MESH2MOTION_MODEL_SPEC)
        spec["description"] = f"{spec['description']} {reason}"
        missing_models.append(spec)
    report = build_dependency_model_report(
        node_name=NODE_DISPLAY_NAME,
        missing_models=missing_models,
    )
    return ok, info, report


_MODELS_AVAILABLE, _MESH2MOTION_DIR_INFO, _MODEL_REPORT = _mesh2motion_model_report()
_MISSING_MODELS = _MODEL_REPORT.get("missing_models", [])
_DEPENDENCIES_AVAILABLE = True
_MISSING_DEPENDENCIES = []

def _get_mesh2motion_dir() -> Path:
    """获取 Mesh2Motion 资源目录；只使用全局 models/mesh2motion。"""
    global_models_dir = Path(folder_paths.models_dir) / "mesh2motion"
    if not _MODELS_AVAILABLE:
        print_dependency_model_report(_MODEL_REPORT, title="GJJ 节点模型缺失！")
    return global_models_dir

UI_DIR = _get_mesh2motion_dir()
MESH2MOTION_DEFAULTS = {
    "show_skeleton": False,
    "mirror_animations": False,
    "preview_output": False,
    "checker_room": False,
    "width": 1024,
    "height": 1024,
    "fps": 24,
}


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


def _capture_state_key(node_id: Any) -> str | None:
    key = str(node_id or "").strip()
    return key or None


def _set_capture_state(node_id: Any, state: dict[str, Any]) -> dict[str, Any]:
    key = _capture_state_key(node_id)
    if not key:
        return {}
    cleaned: dict[str, Any] = {}
    for name, value in (state or {}).items():
        if value is not None:
            cleaned[str(name)] = value
    MESH2MOTION_CAPTURE_STATE[key] = cleaned
    return cleaned


def _get_capture_state(unique_id: Any) -> dict[str, Any]:
    key = _capture_state_key(unique_id)
    if not key:
        return {}
    state = MESH2MOTION_CAPTURE_STATE.get(key)
    return dict(state) if isinstance(state, dict) else {}


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

    @routes.post(f"{ROUTE_BASE}/capture-state")
    async def save_mesh2motion_capture_state(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}

        node_id = data.get("node_id") or data.get("nodeId") or data.get("node") or data.get("id")
        state = data.get("state") if isinstance(data.get("state"), dict) else None
        if state is None:
            state = {
                key: value
                for key, value in data.items()
                if key not in {"node_id", "nodeId", "node", "id"}
            }

        saved = _set_capture_state(node_id, state)
        if not saved:
            return web.json_response({"ok": False, "error": "缺少 node_id 或状态内容。"}, status=400)
        return web.json_response({"ok": True, "node_id": str(node_id), "keys": list(saved.keys())})

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


def _prop_value(props: dict, key: str, fallback: Any) -> Any:
    value = props.get(key, fallback)
    if value is None:
        return fallback
    return value


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
    container = av.open(str(video_path))
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
        raise RuntimeError(f"视频没有可解码帧：{video_path}")
    return torch.stack(frames)


def _strip_annotated_suffix(value: str) -> str:
    return re.sub(r"\s*\[(?:input|output|temp)\]\s*$", "", value, flags=re.IGNORECASE).strip()


def _existing_file(path: Path) -> Path | None:
    try:
        return path if path.exists() and path.is_file() else None
    except OSError:
        return None


def _resolve_video_path(video_name: Any) -> Path | None:
    if not video_name:
        return None

    if isinstance(video_name, dict):
        name = str(video_name.get("name") or video_name.get("video") or video_name.get("path") or video_name.get("file") or "").strip()
        subfolder = str(video_name.get("subfolder") or "").strip().strip("/\\")
        file_type = str(video_name.get("type") or "temp").strip() or "temp"
        raw_name = f"{subfolder}/{name} [{file_type}]" if name and subfolder else (f"{name} [{file_type}]" if name else "")
    else:
        raw_name = str(video_name).strip()

    if not raw_name:
        return None

    cleaned_name = _strip_annotated_suffix(raw_name)
    candidates: list[Path] = []

    def add(path_like: Any) -> None:
        try:
            path = Path(str(path_like).strip())
        except Exception:
            return
        if path not in candidates:
            candidates.append(path)

    for annotated in (raw_name, cleaned_name):
        if annotated:
            try:
                add(folder_paths.get_annotated_filepath(annotated))
            except Exception:
                pass

    raw_path = Path(cleaned_name)
    if raw_path.is_absolute():
        add(raw_path)
    else:
        for getter_name in ("get_temp_directory", "get_input_directory", "get_output_directory"):
            getter = getattr(folder_paths, getter_name, None)
            if callable(getter):
                try:
                    root = Path(getter())
                    add(root / raw_path)
                    add(root / "mesh2motion" / raw_path.name)
                except Exception:
                    pass
        add(Path(tempfile.gettempdir()) / raw_path)
        add(Path(tempfile.gettempdir()) / "mesh2motion" / raw_path.name)

    for candidate in candidates:
        existing = _existing_file(candidate)
        if existing:
            return existing

    print("[GJJ Mesh2Motion] 视频文件解析失败，已检查候选路径：")
    for candidate in candidates:
        print(f"[GJJ Mesh2Motion]   - {candidate}")
    return None


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
    DESCRIPTION_INTRO = (
        "GJJ 本地零依赖 Mesh2Motion 单节点：内嵌 3D 骨骼动画编辑器，"
        "执行时输出当前截图和相机预设录制的视频。"
    )
    DESCRIPTION = (
        DESCRIPTION_INTRO
        if _MODELS_AVAILABLE
        else f"{_MODEL_REPORT['warning_message']}\n\n{DESCRIPTION_INTRO}"
    )
    REQUIRED_MODELS = [MESH2MOTION_MODEL_SPEC]
    GJJ_HELP = {
        "description": DESCRIPTION,
        "notice": _MODEL_REPORT["help_message"] if not _MODEL_REPORT["available"] else "",
        "install_cmd": _MODEL_REPORT["install_cmd"] if not _MODEL_REPORT["available"] else "",
        "copy_text": _MODEL_REPORT["copy_text"] if not _MODEL_REPORT["available"] else "",
        "copy_label": _MODEL_REPORT["copy_label"] if not _MODEL_REPORT["available"] else "",
        "warning_message": _MODEL_REPORT["warning_message"] if not _MODEL_REPORT["available"] else "",
        "models": REQUIRED_MODELS,
        "dependencies": [
            "Mesh2Motion 前端资源目录：models/mesh2motion",
        ],
        "tips": [
            f"完整资源不少于 {MESH2MOTION_MIN_FILES} 个文件、{MESH2MOTION_MIN_DIRS} 个文件夹、{MESH2MOTION_MIN_BYTES} 字节。",
            "资源缺失或不完整时，节点面板会显示模型下载提示和复制下载网址按钮。",
        ],
    }
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
            },
            "hidden": {
                "image": "IMAGE",
                "video_frames": "STRING",
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # 面板状态存放在 workflow properties 字典里；旧工作流残留输入不应触发 ComfyUI 通用 min/max 校验。
        return True

    def execute(
        self,
        image="",
        video_frames="",
        unique_id=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        if not _MODELS_AVAILABLE:
            print_dependency_model_report(_MODEL_REPORT, title="GJJ 节点模型缺失！")
            send_dependency_model_notice(_MODEL_REPORT, unique_id=unique_id)
            raise RuntimeError(_MODEL_REPORT.get("warning_message") or "Mesh2Motion 模型资源缺失。")

        print(f"[GJJ Mesh2Motion] ========== 开始执行 ==========")
        print(f"[GJJ Mesh2Motion] unique_id: {unique_id}")
        print(f"[GJJ Mesh2Motion] image 参数长度: {len(str(image)) if image else 0}")
        print(f"[GJJ Mesh2Motion] video_frames 参数长度: {len(str(video_frames)) if video_frames else 0}")
        
        # 优先从 properties 读取数据（新方案）
        props = _get_node_properties(extra_pnginfo, unique_id)
        print(f"[GJJ Mesh2Motion] 节点 properties: {list(props.keys())}")
        cached_state = _get_capture_state(unique_id)
        print(f"[GJJ Mesh2Motion] 后端缓存状态: {list(cached_state.keys())}")

        defaults = MESH2MOTION_DEFAULTS
        show_skeleton = bool(_prop_value(props, "mesh2motion_show_skeleton", kwargs.get("show_skeleton", defaults["show_skeleton"])))
        mirror_animations = bool(_prop_value(props, "mesh2motion_mirror_animations", kwargs.get("mirror_animations", defaults["mirror_animations"])))
        preview_output = bool(_prop_value(props, "mesh2motion_preview_output", kwargs.get("preview_output", defaults["preview_output"])))
        checker_room = bool(_prop_value(props, "mesh2motion_checker_room", kwargs.get("checker_room", defaults["checker_room"])))
        width = _normalize_size(_prop_value(props, "mesh2motion_width", kwargs.get("width", defaults["width"])), defaults["width"], "输出宽度")
        height = _normalize_size(_prop_value(props, "mesh2motion_height", kwargs.get("height", defaults["height"])), defaults["height"], "输出高度")
        fps = max(1, min(120, int(_prop_value(props, "mesh2motion_fps", kwargs.get("fps", defaults["fps"])))))
        
        if cached_state:
            image_data = cached_state.get("image")
            video_data = cached_state.get("video")
        else:
            image_data = props.get("mesh2motion_image", "")
            video_data = props.get("mesh2motion_video", "")

        print(f"[GJJ Mesh2Motion] image_data 类型: {type(image_data).__name__ if image_data is not None else 'None'}")
        print(f"[GJJ Mesh2Motion] video_data 类型: {type(video_data).__name__ if video_data is not None else 'None'}")

        # 如果 properties 有数据，优先使用
        if image_data:
            print(f"[GJJ Mesh2Motion] 使用缓存/属性中的截图数据")
            image = image_data
        if video_data:
            print(f"[GJJ Mesh2Motion] 使用缓存/属性中的视频数据")
            video_frames = video_data

        if image:
            try:
                print(f"[GJJ Mesh2Motion] 开始解析截图数据...")
                payload = image if isinstance(image, dict) else json.loads(str(image))
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
        output_fps = fps
        if video_frames:
            try:
                print(f"[GJJ Mesh2Motion] 开始解析视频数据...")
                payload = video_frames if isinstance(video_frames, dict) else json.loads(str(video_frames))
                video_name = None
                if isinstance(payload, dict):
                    video_name = payload.get("video") or payload.get("path") or payload.get("file")
                    try:
                        output_fps = max(1, min(120, int(payload.get("fps", output_fps))))
                    except Exception:
                        output_fps = fps
                if video_name:
                    video_path = _resolve_video_path(video_name)
                    print(f"[GJJ Mesh2Motion] 尝试加载视频：{video_path}")
                    if not video_path or not Path(video_path).exists():
                        raise RuntimeError(f"视频文件不存在：{video_path}")
                    video_tensor = _decode_video_to_tensor(video_path, width, height)
                    print(f"[GJJ Mesh2Motion] 视频加载成功，共 {video_tensor.shape[0]} 帧")
            except Exception as exc:
                print(f"[GJJ Mesh2Motion] 视频读取失败，改用黑色视频占位：{exc}")
                traceback.print_exc()

        if video_tensor is None:
            print(f"[GJJ Mesh2Motion] 没有可用视频数据，使用当前截图作为单帧视频占位")
            video_tensor = screenshot.clone()

        print(f"[GJJ Mesh2Motion] ========== 执行完成 ==========")
        return (screenshot, _video_from_frames(video_tensor, output_fps))


_register_routes()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_Mesh2MotionExplore}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}
